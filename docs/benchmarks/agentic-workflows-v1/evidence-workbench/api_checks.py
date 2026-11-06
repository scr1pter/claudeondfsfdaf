"""Black-box acceptance groups. No imports from the candidate application."""
import json
from http.client import HTTPException
import sqlite3
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from corpus import byte_slice, ndjson, unicode_body, upsert


class ProductFailure(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ProductFailure(message)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


class Client:
    def __init__(self, origin):
        parsed = urlsplit(origin)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port:
            raise ValueError("Acceptance HTTP client requires an exact loopback origin.")
        self.origin = origin
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, method, path, body=None, content_type="application/json", status=200, code=None):
        require(path.startswith("/api/") and not path.startswith("//"), "Invalid local API path.")
        data = body.encode("utf-8") if isinstance(body, str) else body
        request = Request(self.origin + path, data=data, method=method,
                          headers={"Content-Type": content_type})
        try:
            try:
                response = self.opener.open(request, timeout=8)
            except HTTPError as error:
                response = error
            with response:
                actual_status = response.code
                raw = response.read(8_000_001)
        except (URLError, OSError, TimeoutError, HTTPException) as error:
            raise ProductFailure("Application request was unavailable: " + type(error).__name__) from error
        require(len(raw) <= 8_000_000, "API response exceeded the acceptance limit.")
        try:
            value = json.loads(raw)
        except (json.JSONDecodeError, UnicodeError) as error:
            raise ProductFailure("API response was not UTF-8 JSON.") from error
        require(isinstance(value, dict), "API response must be an object.")
        require(actual_status == status, f"Expected HTTP {status}; received {actual_status}.")
        if code is not None:
            require(isinstance(value.get("error"), dict), "Expected an error object.")
            require(value["error"].get("code") == code, "Incorrect public error code.")
            require(isinstance(value["error"].get("message"), str) and value["error"]["message"],
                    "Expected a useful error message.")
        return value

    def get(self, path, **kwargs):
        return self.request("GET", path, **kwargs)

    def batch(self, batch_id, operations, **kwargs):
        return self.request("POST", "/api/batches", ndjson(batch_id, operations),
                            "application/x-ndjson", status=kwargs.pop("status", 201), **kwargs)

    def legacy(self, source, title, body):
        value = self.request("POST", "/api/import", json.dumps({"source": source, "title": title, "body": body}), status=201)
        require(isinstance(value.get("documents"), list) and len(value["documents"]) == 1,
                "Legacy import must return one document.")
        row = value["documents"][0]
        require(isinstance(row, dict) and type(row.get("id")) is int, "Imported document has no integer ID.")
        return row

    def revision(self):
        value = self.get("/api/health")
        require(value.get("ok") is True and value.get("schemaVersion") == 2,
                "Health must expose schema version 2.")
        require(type(value.get("revision")) is int and value["revision"] >= 0,
                "Health must expose a nonnegative integer revision.")
        return value["revision"]

    def search(self, query, limit=10, cursor=None, **kwargs):
        params = {"q": query, "limit": limit}
        if cursor is not None:
            params["cursor"] = cursor
        value = self.get("/api/search?" + urlencode(params), **kwargs)
        if kwargs.get("status", 200) == 200:
            require(value.get("query") == query, "Search must preserve the input query.")
            require(isinstance(value.get("results"), list), "Search results must be a list.")
            require(type(value.get("revision")) is int, "Search must expose its collection revision.")
            require("nextCursor" in value and (value["nextCursor"] is None or isinstance(value["nextCursor"], str)),
                    "Search must expose an opaque next cursor or null.")
        return value


def operation(receipt, index=0):
    require(isinstance(receipt.get("operations"), list) and len(receipt["operations"]) > index,
            "Batch receipt is missing an operation.")
    row = receipt["operations"][index]
    require(isinstance(row, dict), "Batch receipt operation must be an object.")
    return row


def document(client, identifier, version=None, status=200):
    suffix = f"/versions/{version}" if version is not None else ""
    value = client.get(f"/api/documents/{identifier}{suffix}", status=status,
                       **({"code": "not_found"} if status == 404 else {}))
    if status == 200:
        require(isinstance(value.get("document"), dict), "Expected a document object.")
        return value["document"]
    return value


def check_citation(result, body, query_term=None):
    require(isinstance(result, dict) and isinstance(result.get("citation"), dict), "Search hit has no citation.")
    citation = result["citation"]
    require(citation.get("documentId") == result.get("id") and citation.get("version") == result.get("version"),
            "Citation identity must match its search result.")
    start, end = citation.get("startByte"), citation.get("endByte")
    require(type(start) is int and type(end) is int and 0 <= start <= end <= len(body.encode("utf-8")),
            "Citation offsets must be ordered UTF-8 byte offsets.")
    try:
        encoded = body.encode("utf-8")
        encoded[:start].decode("utf-8", errors="strict")
        encoded[:end].decode("utf-8", errors="strict")
        quote = byte_slice(body, start, end)
    except UnicodeError as error:
        raise ProductFailure("Citation splits a UTF-8 scalar.") from error
    require(citation.get("quote") == quote and result.get("snippet") == quote,
            "Citation quote and snippet must equal the original byte slice.")
    require(end - start <= 512, "Citation excerpt exceeds 512 UTF-8 bytes.")
    if query_term:
        import re
        whole_matches = [match for match in re.finditer(r"[A-Za-z0-9]+", body)
                         if match.group().lower() == query_term]
        require(any(start <= len(body[:match.start()].encode("utf-8"))
                    and len(body[:match.end()].encode("utf-8")) <= end for match in whole_matches),
                "Citation omits a whole matching original-body token.")
    return citation


class Acceptance:
    def __init__(self, client, run, restart, start_secondary, out):
        self.client = client
        self.run = run
        self.restart = restart
        self.start_secondary = start_secondary
        self.out = Path(out)

    def execute(self):
        for name, test in [
            ("api.legacy_import", self.legacy_import), ("api.batch_create", self.batch_create),
            ("api.atomic_validation", self.atomic_validation), ("api.batch_replay", self.batch_replay),
            ("api.batch_conflict", self.batch_conflict), ("api.replacement", self.replacement),
            ("api.deletion", self.deletion), ("api.history", self.history), ("api.revival", self.revival),
            ("api.lexical_order", self.lexical_order), ("api.unicode_citations", self.unicode_citations),
            ("api.citation_validation", self.citation_validation), ("api.pagination", self.pagination),
            ("api.cursor_binding", self.cursor_binding), ("api.stale_cursor", self.stale_cursor),
            ("api.restart_persistence", self.restart_persistence), ("api.legacy_migration", self.legacy_migration),
        ]:
            self.run(name, test)

    def legacy_import(self):
        client = self.client
        body = "# Local note\nFern naïve 🧭 東京\nlegacytoken"
        first = client.legacy("legacy/fern.md", "Fern record", body)
        require(first.get("body") == body and first.get("version") == 1, "Legacy import lost original text or version.")
        second = client.legacy("legacy/fern.md", "Fern revised", "legacynewtoken")
        require(second.get("id") == first["id"] and second.get("version") == 2, "Legacy replacement must preserve ID and add a version.")
        payload = "\n".join(json.dumps({"source": f"legacy/line-{n}", "title": f"Line {n}", "body": "legacyline"}) for n in range(2))
        value = client.request("POST", "/api/import", payload, "application/x-ndjson", status=201)
        require(len(value.get("documents", [])) == 2, "Legacy NDJSON importer must remain available.")
        revision = client.revision()
        invalid = json.dumps({"source": "legacy/rollback", "title": "Valid", "body": "rollbacklegacy"}) + '\n{"source":"invalid"}'
        client.request("POST", "/api/import", invalid, "application/x-ndjson", status=400)
        require(client.revision() == revision, "Legacy NDJSON must validate before writing.")
        require(not client.search("rollbacklegacy")["results"], "Rejected legacy NDJSON left a partial document.")

    def batch_create(self):
        client = self.client
        before = client.revision()
        rows = [upsert("batch/one", "One", "batchcreatetoken"), upsert("batch/two", "Two", "batchcreatetoken"), {"type": "delete", "source": "batch/absent"}]
        value = client.batch("create-01", rows)
        require(value.get("batchId") == "create-01" and value.get("replayed") is False and value.get("revision") == before + 1,
                "First batch receipt or revision is incorrect.")
        require(len(value.get("operations", [])) == 3, "Batch must return each operation in request order.")
        for index in range(2):
            row = operation(value, index)
            require(row.get("source") == rows[index]["source"] and row.get("type") == "upsert" and row.get("changed") is True and row.get("version") == 1 and type(row.get("documentId")) is int,
                    "Upsert receipt has incorrect identity or change metadata.")
        require(operation(value, 2) == {"type": "delete", "source": "batch/absent", "documentId": None, "version": None, "changed": False},
                "Unknown deletion must be a no-op.")
        no_op = client.batch("create-noop", rows[:1])
        require(no_op.get("revision") == before + 1 and operation(no_op).get("changed") is False and operation(no_op).get("version") == 1,
                "Exact current upsert must not create a revision or version.")

    def atomic_validation(self):
        client = self.client
        before = client.revision()
        good = upsert("validation/never-committed", "Valid", "atomicrollbacktoken")
        invalid = [
            ndjson("validation-0", []), '{}\n' + json.dumps(good),
            ndjson("bad id", [good]), ndjson("validation-1", [good, {"type": "unknown", "source": "bad"}]),
            ndjson("validation-2", [good, {"type": "upsert", "source": "bad", "title": "Bad", "body": None}]),
            ndjson("validation-3", [good, good]),
            ndjson("validation-4", [good, {"type": "batch", "batchId": "nested"}]),
            ndjson("validation-5", [upsert("bad\nsource", "Bad", "body")]),
            ndjson("validation-6", [upsert("validation/null", "Bad", "a\0b")]),
            ndjson("validation-7", [upsert("validation/title", " ", "body")]),
            ndjson("validation-8", [upsert("x" * 201, "Bad", "body")]),
            ndjson("validation-9", [upsert("validation/large", "Bad", "x" * 1_048_577)]),
            ndjson("validation-10", [upsert(f"validation/many-{n}", "Many", "body") for n in range(129)]),
            '{"type":"batch","batchId":"validation-11"}\n' + json.dumps(good) + '\n{bad json',
            '{"type":"batch","batchId":"validation-12"}\n{"type":"upsert","source":"validation/surrogate","title":"Bad","body":"\\ud800"}\n',
        ]
        for payload in invalid:
            client.request("POST", "/api/batches", payload, "application/x-ndjson", status=400, code="invalid_batch")
        require(client.revision() == before, "Rejected batches changed the revision.")
        require(not client.search("atomicrollbacktoken")["results"], "Invalid batch partially committed a document.")
        result = client.batch("validation-1", [good])
        require(result.get("replayed") is False, "Rejected batch must not reserve its ID.")

    def batch_replay(self):
        client = self.client
        row = upsert("replay/doc", "Replay", "replayoriginal")
        first = client.batch("replay-01", [row])
        client.batch("replay-other", [upsert("replay/other", "Other", "replayothertoken")])
        revision = client.revision()
        payload = '\r\n  { "batchId" : "replay-01", "type":"batch", "ignored":true }\r\n\r\n' + json.dumps({"body": row["body"], "source": row["source"], "type": "upsert", "title": row["title"], "unused": 7}) + '\r\n'
        replay = client.request("POST", "/api/batches", payload, "application/x-ndjson", status=200)
        require(replay == {**first, "replayed": True}, "Semantic retry must return the original receipt.")
        require(client.revision() == revision, "Replay changed collection revision.")
        no_op = client.batch("replay-empty-delete", [{"type": "delete", "source": "replay/missing"}])
        repeated = client.batch("replay-empty-delete", [{"type": "delete", "source": "replay/missing"}], status=200)
        require(no_op.get("revision") == revision and repeated == {**no_op, "replayed": True}, "No-op batches need durable replay receipts.")

    def batch_conflict(self):
        client = self.client
        original = client.batch("conflict-01", [upsert("conflict/doc", "Original", "conflictoriginal")])
        identifier = operation(original).get("documentId")
        before = client.revision()
        client.batch("conflict-01", [upsert("conflict/doc", "Changed", "conflictchanged")], status=409, code="batch_conflict")
        require(client.revision() == before and document(client, identifier).get("title") == "Original", "Conflicting retry modified current state.")
        require(not client.search("conflictchanged")["results"], "Conflicting retry polluted search.")

    def replacement(self):
        client = self.client
        first = client.batch("replace-01", [upsert("replace/doc", "Before", "replaceoldtoken")])
        identifier = operation(first).get("documentId")
        require(len(client.search("replaceoldtoken")["results"]) == 1, "Initial version not searchable.")
        second = client.batch("replace-02", [upsert("replace/doc", "After", "replacenewtoken")])
        require(operation(second).get("documentId") == identifier and operation(second).get("version") == 2, "Replacement changed identity or failed to increment version.")
        require(not client.search("replaceoldtoken")["results"], "Replacement left stale current search hits.")
        hits = client.search("replacenewtoken")["results"]
        require(len(hits) == 1 and hits[0].get("id") == identifier and hits[0].get("version") == 2, "Current index did not follow replacement.")
        require(document(client, identifier, 1).get("body") == "replaceoldtoken", "Replacement altered immutable original text.")

    def deletion(self):
        client = self.client
        first = client.batch("delete-01", [upsert("delete/doc", "Delete me", "deletetoken")])
        identifier = operation(first).get("documentId")
        before = client.revision()
        receipt = client.batch("delete-02", [{"type": "delete", "source": "delete/doc"}])
        require(receipt.get("revision") == before + 1 and operation(receipt).get("changed") is True and operation(receipt).get("version") is None,
                "Deletion receipt or revision is incorrect.")
        document(client, identifier, status=404)
        require(not client.search("deletetoken")["results"], "Deleted document still appears in current search.")
        current = client.get("/api/documents")
        require(all(row.get("id") != identifier for row in current.get("documents", [])), "Deleted document still appears in current listing.")
        require(document(client, identifier, 1).get("body") == "deletetoken", "Deletion removed historical evidence.")
        no_op = client.batch("delete-03", [{"type": "delete", "source": "delete/doc"}])
        require(no_op.get("revision") == before + 1 and operation(no_op).get("changed") is False, "Repeated deletion should be a no-op.")

    def history(self):
        client = self.client
        identifiers = []
        for version in range(1, 4):
            receipt = client.batch(f"history-{version}", [upsert("history/doc", f"History {version}", f"historytoken version {version} 🧭")])
            identifiers.append(operation(receipt).get("documentId"))
        require(len(set(identifiers)) == 1, "Document versions must share a stable ID.")
        versions = client.get(f"/api/documents/{identifiers[0]}/versions").get("versions")
        require(isinstance(versions, list) and [row.get("version") for row in versions] == [1, 2, 3], "History must contain each immutable version in order.")
        for version in range(1, 4):
            row = document(client, identifiers[0], version)
            require(row.get("body") == f"historytoken version {version} 🧭" and row.get("title") == f"History {version}" and row.get("version") == version,
                    "Historical document content or identity changed.")
        document(client, identifiers[0], 99, status=404)

    def revival(self):
        client = self.client
        first = client.batch("revive-01", [upsert("revive/doc", "First", "reviveoriginal")])
        identifier = operation(first).get("documentId")
        client.batch("revive-02", [{"type": "delete", "source": "revive/doc"}])
        revived = client.batch("revive-03", [upsert("revive/doc", "Revived", "revivecurrent")])
        require(operation(revived).get("documentId") == identifier and operation(revived).get("version") == 2, "Revival must preserve ID and advance the immutable version sequence.")
        require(document(client, identifier).get("body") == "revivecurrent" and document(client, identifier, 1).get("body") == "reviveoriginal", "Revival corrupted current or historical text.")

    def lexical_order(self):
        client = self.client
        rows = [upsert(f"lexical/{n}", "Lexical-title fox" if n % 2 else "Lexical-title", f"lexicaltoken {'FERN' if n % 2 else 'fox fern'} superfern") for n in [4, 1, 7, 2, 5, 3, 6]]
        receipt = client.batch("lexical-01", rows)
        expected = sorted(row["documentId"] for row in receipt.get("operations", []))
        hits = client.search("LEXICALTOKEN fox fern", limit=50)["results"]
        require([row.get("id") for row in hits] == expected, "Lexical AND matching, case handling, title/body combination, or ID order is incorrect.")
        require(not client.search("lexicaltoken fer")["results"], "Lexical lookup must not match a token prefix.")
        require(not client.search("lexicaltoken missingword")["results"], "All query terms must match.")
        client.search("!!!", status=400, code="invalid_query")
        client.search("one two three four five six seven eight nine", status=400, code="invalid_query")
        repeated = client.search("lexicaltoken lexicaltoken", limit=50)
        require([row.get("id") for row in repeated["results"]] == expected, "Repeated terms must not require repeated occurrences.")

    def unicode_citations(self):
        client = self.client
        body = unicode_body()
        receipt = client.batch("unicode-01", [upsert("unicode/doc", "Unicode", body), upsert("unicode/title-only", "titletoken", "🧭 Café beginning"), upsert("unicode/empty", "emptybodytoken", "")])
        identifier = operation(receipt).get("documentId")
        hits = client.search("needle")["results"]
        row = next((row for row in hits if row.get("id") == identifier), None)
        require(row is not None, "Unicode document missing from search.")
        citation = check_citation(row, body, "needle")
        direct = client.get("/api/citations?" + urlencode({key: citation[key] for key in ["documentId", "version", "startByte", "endByte"]}))
        require(direct == citation, "Citation resolver does not return the version-bound exact quote.")
        title_hit = client.search("titletoken")["results"]
        require(len(title_hit) == 1, "Title-only match missing.")
        title_citation = check_citation(title_hit[0], "🧭 Café beginning")
        require(title_citation.get("startByte") == 0 and title_citation.get("quote"), "Title-only citation must start at the first body text.")
        empty = client.search("emptybodytoken")["results"]
        require(len(empty) == 1 and check_citation(empty[0], "").get("quote") == "", "Empty-body citation must be the valid empty byte slice.")
        client.batch("unicode-02", [upsert("unicode/doc", "Replaced", "no former body")])
        client.batch("unicode-03", [{"type": "delete", "source": "unicode/doc"}])
        require(client.get("/api/citations?" + urlencode({key: citation[key] for key in ["documentId", "version", "startByte", "endByte"]})) == citation,
                "Citation changed after replacement and deletion.")

    def citation_validation(self):
        client = self.client
        body = "a🧭é e\u0301z"
        receipt = client.batch("range-01", [upsert("range/doc", "Ranges", body)])
        identifier = operation(receipt).get("documentId")
        base = {"documentId": identifier, "version": 1, "startByte": 1, "endByte": 5}
        quote = client.get("/api/citations?" + urlencode(base))
        require(quote.get("quote") == "🧭", "Valid multibyte scalar range was not preserved.")
        for update in [{"startByte": 2}, {"endByte": 4}, {"startByte": 2, "endByte": 2}, {"startByte": -1}, {"endByte": 999}, {"startByte": 5, "endByte": 1}, {"version": 0}, {"documentId": "1.5"}, {"startByte": "1e0"}, {"endByte": ""}]:
            client.get("/api/citations?" + urlencode({**base, **update}), status=400, code="invalid_range")
        client.get("/api/citations?documentId=1", status=400, code="invalid_range")
        client.get("/api/citations?" + urlencode({**base, "version": 999}), status=404, code="not_found")
        client.get("/api/citations?" + urlencode({**base, "documentId": 999999}), status=404, code="not_found")
        empty = client.get("/api/citations?" + urlencode({**base, "startByte": 5, "endByte": 5}))
        require(empty.get("quote") == "", "Boundary-aligned empty ranges must be valid.")

    def pagination(self):
        client = self.client
        receipt = client.batch("pages-01", [upsert(f"pages/{n}", f"Page {n}", "paginationtoken") for n in range(7)])
        expected = sorted(row["documentId"] for row in receipt.get("operations", []))
        seen, cursor, revision = [], None, None
        for page_index in range(5):
            page = client.search("paginationtoken", 2, cursor)
            require(0 < len(page["results"]) <= 2, "Page size must honor the requested limit.")
            require(page["revision"] == (revision if revision is not None else page["revision"]), "Pages crossed collection revisions.")
            revision = page["revision"]
            seen.extend(row.get("id") for row in page["results"])
            cursor = page["nextCursor"]
            if cursor is None:
                break
        require(seen == expected and cursor is None, "Pagination has duplicates, gaps, ordering errors, or a nonterminal final cursor.")
        no_hit = client.search("paginationtoken absentword", 2)
        require(no_hit["results"] == [] and no_hit["nextCursor"] is None, "Empty search must terminate pagination.")

    def cursor_binding(self):
        client = self.client
        client.batch("binding-01", [upsert(f"binding/{n}", "Binding", "cursorbindingtoken") for n in range(4)])
        first = client.search("cursorbindingtoken", 2)
        cursor = first["nextCursor"]
        require(isinstance(cursor, str) and cursor, "Expected a continuation cursor.")
        client.search("CURSORBINDINGTOKEN", 2, cursor, status=400, code="invalid_cursor")
        client.search("cursorbindingtoken", 3, cursor, status=400, code="invalid_cursor")
        for invalid in ["not-a-cursor", "e30=", "null", "%%%"]:
            client.search("cursorbindingtoken", 2, invalid, status=400, code="invalid_cursor")
        for limit in [0, -1, 51, "2.5", "abc", "2e0", ""]:
            client.search("cursorbindingtoken", limit, status=400, code="invalid_limit")

    def stale_cursor(self):
        client = self.client
        rows = [upsert(f"stale/{n}", "Stable", "stalecursortoken") for n in range(3)]
        client.batch("stale-01", rows)
        first = client.search("stalecursortoken", 2)
        cursor = first["nextCursor"]
        require(isinstance(cursor, str) and cursor, "Expected a continuation cursor.")
        client.batch("stale-noop", rows[:1])
        require(len(client.search("stalecursortoken", 2, cursor)["results"]) == 1, "No-op write incorrectly invalidated cursor.")
        client.batch("stale-01", rows, status=200)
        require(len(client.search("stalecursortoken", 2, cursor)["results"]) == 1, "Replay incorrectly invalidated cursor.")
        client.batch("stale-change", [upsert("stale/unrelated", "Unrelated", "unrelatedtoken")])
        client.search("stalecursortoken", 2, cursor, status=409, code="stale_cursor")

    def restart_persistence(self):
        client = self.client
        rows = [upsert(f"restart/{n}", f"Restart {n}", "restarttoken 🧭") for n in range(3)]
        first = client.batch("restart-01", rows)
        identifier = operation(first).get("documentId")
        client.batch("restart-02", [upsert("restart/0", "Revised", "restarttoken changed")])
        page = client.search("restarttoken", 2)
        before = client.revision()
        self.restart()
        require(client.revision() == before, "Restart changed the durable revision.")
        require(document(client, identifier, 1).get("body") == "restarttoken 🧭" and document(client, identifier).get("version") == 2,
                "Restart lost current or immutable version state.")
        require(len(client.search("restarttoken", 2, page["nextCursor"])["results"]) == 1, "Restart lost a revision-bound cursor's meaning.")
        replay = client.batch("restart-01", rows, status=200)
        require(replay == {**first, "replayed": True} and client.revision() == before, "Restart lost durable batch receipts.")

    def legacy_migration(self):
        import re
        directory = self.out / "legacy-data"
        directory.mkdir()
        with sqlite3.connect(directory / "workbench.sqlite") as db:
            db.executescript((Path(__file__).parent / "seed/schema/legacy.sql").read_text(encoding="utf-8"))
            rows = [
                (5, "migrated/five", "Legacy five", "migrationtoken Café 🧭", "2024-01-02T03:04:05.000Z"),
                (41, "migrated/forty-one", "Legacy forty-one", "migrationtoken 東京", "2024-02-03T04:05:06.000Z"),
            ]
            db.executemany("INSERT INTO documents VALUES (?,?,?,?,?)", rows)
            db.executemany("INSERT INTO document_tokens VALUES (?,?)", [
                (row[0], token) for row in rows for token in sorted(set(re.findall(r"[a-z0-9]+", (row[2] + " " + row[3]).lower())))
            ])
        with self.start_secondary(directory) as migrated:
            require(migrated.revision() == 1, "Nonempty legacy migration must produce revision 1 exactly once.")
            for identifier, body, timestamp in [(5, "migrationtoken Café 🧭", "2024-01-02T03:04:05.000Z"), (41, "migrationtoken 東京", "2024-02-03T04:05:06.000Z")]:
                row = document(migrated, identifier, 1)
                require(row.get("id") == identifier and row.get("version") == 1 and row.get("body") == body and row.get("created_at") == timestamp,
                        "Legacy migration changed a stable ID, original text, timestamp, or initial version.")
            require([row.get("id") for row in migrated.search("migrationtoken")["results"]] == [5, 41], "Legacy migration failed to index existing documents.")
            value = migrated.batch("migration-new", [upsert("migrated/new", "New", "migrationnewtoken")])
            require(operation(value).get("documentId", 0) > 41 and value.get("revision") == 2, "Migrated ID sequence or revision is incorrect.")
        with self.start_secondary(directory) as migrated:
            require(migrated.revision() == 2 and document(migrated, 5, 1).get("body") == "migrationtoken Café 🧭", "Restart repeated or corrupted the migration.")
