"""Read-only native registries for one explicitly owned runtime home.

Codex fields were exercised in the free native probe. Vector fields follow
core/session/sql.ts and TaskTool metadata, exercised on frozen a35c03d for the
lead/two-worker/judge path. Unobserved helper ancestry still needs proof.
No discovery of user homes, credentials, model servers or running apps occurs.
"""
import hashlib
import json
from contextlib import closing
from pathlib import Path
import shutil
import sqlite3

from native_team_policy import MODEL, PolicyError, require


def parsed(value):
    return json.loads(value) if isinstance(value, str) else value


class NativeRegistry:
    def __init__(self, runtime, home, database, root_id, provider, helper_names=()):
        require(runtime in ("codex", "vector"), "unknown registry runtime")
        self.runtime, self.home = runtime, Path(home).resolve()
        self.database, self.root_id, self.provider = Path(database).resolve(), root_id, provider
        self.helper_names = frozenset(helper_names)
        require(self.database.is_relative_to(self.home), "registry database outside owned home")

    def connect(self):
        require(self.database.is_file(), "native registry not persisted")
        connection = sqlite3.connect(self.database.as_uri() + "?mode=ro", uri=True, timeout=1)
        connection.row_factory = sqlite3.Row
        return connection

    def resolve(self, headers):
        names = [key.lower() for key in headers]
        require(len(names) == len(set(names)), "duplicate request headers")
        headers = {key.lower(): value for key, value in headers.items()}
        try:
            with closing(self.connect()) as connection:
                return self.codex(connection, headers) if self.runtime == "codex" else self.vector(connection, headers)
        except (sqlite3.Error, ValueError, TypeError, KeyError) as error:
            if isinstance(error, PolicyError):
                raise
            raise PolicyError("native registry identity unavailable") from None

    def codex(self, connection, headers):
        identity = headers.get("thread-id")
        metadata = parsed(headers.get("x-codex-turn-metadata", "null"))
        require(isinstance(metadata, dict) and identity and metadata.get("thread_id") == identity, "wire thread identity mismatch")
        require(headers.get("session-id") == self.root_id and metadata.get("session_id") == self.root_id, "wire arm mismatch")
        row = connection.execute("SELECT id,source,thread_source,agent_role,agent_path,model,reasoning_effort,model_provider FROM threads WHERE id=?", (identity,)).fetchone()
        require(row is not None, "native identity not persisted")
        require(row["model"] == metadata.get("model") == MODEL and row["reasoning_effort"] == metadata.get("reasoning_effort") == "high" and row["model_provider"] == self.provider, "native model/provider mismatch")
        if identity == self.root_id:
            require(row["source"] == "exec" and row["thread_source"] == "user" and row["agent_role"] is None and metadata.get("parent_thread_id") is None and metadata.get("agent_name") == "/root", "native root mismatch")
            role, parent, depth = "lead", None, 0
        else:
            ancestry = parsed(row["source"])["subagent"]["thread_spawn"]
            parent, depth, role = ancestry["parent_thread_id"], ancestry["depth"], row["agent_role"]
            require(metadata.get("parent_thread_id") == parent and ancestry.get("agent_role") == role and ancestry.get("agent_path") == row["agent_path"] == metadata.get("agent_name"), "native child ancestry mismatch")
            edge = connection.execute("SELECT COUNT(*) FROM thread_spawn_edges WHERE parent_thread_id=? AND child_thread_id=?", (parent, identity)).fetchone()[0]
            require(edge == 1 and row["thread_source"] == "subagent", "native child edge missing")
        purpose = metadata.get("request_kind")
        require(purpose in ("turn", *self.helper_names), "unknown native request purpose")
        return {"id": identity, "root": self.root_id, "parent": parent, "depth": depth, "role": role, "helper": purpose != "turn", "purpose": purpose}

    def vector(self, connection, headers):
        identity = headers.get("x-session-id")
        require(identity and headers.get("x-session-affinity", identity) == identity, "wire session identity mismatch")
        row = connection.execute("SELECT id,parent_id,internal,agent,model,metadata FROM session WHERE id=?", (identity,)).fetchone()
        require(row is not None, "native identity not persisted")
        model, metadata = parsed(row["model"]) or {}, parsed(row["metadata"]) or {}
        helper = row["internal"] is not None
        if identity == self.root_id:
            require(row["parent_id"] is None and not helper, "native root mismatch")
            role, parent, depth = "lead", None, 0
        elif helper:
            require(row["internal"] in self.helper_names, "unknown native helper")
            role, parent, depth = "helper", row["parent_id"], 1
        else:
            record = metadata.get("subagent", {})
            parent, role, depth = row["parent_id"], row["agent"], 1
            require(record.get("parentSessionID") == parent and record.get("agent") == role, "native child ancestry mismatch")
            selected = record.get("model", {})
            require(selected.get("providerID") == self.provider and selected.get("modelID") == MODEL and selected.get("variant") == "high", "native child model mismatch")
            model = {"id": selected["modelID"], "providerID": selected["providerID"], "variant": selected["variant"]}
        require(parent in (None, self.root_id) and (not headers.get("x-parent-session-id") or headers["x-parent-session-id"] == parent), "nested or cross-arm session")
        require(model.get("id") == MODEL and model.get("providerID") == self.provider and model.get("variant") == "high", "native model/provider mismatch")
        return {"id": identity, "root": self.root_id, "parent": parent, "depth": depth, "role": role, "helper": helper, "purpose": row["internal"] if helper else "root_or_helper" if role == "lead" else "turn"}

    def collect(self, destination):
        """Retain raw descendant transcripts privately, including refused children."""
        destination = Path(destination).resolve()
        destination.mkdir(parents=True, exist_ok=False)
        with closing(self.connect()) as connection:
            if self.runtime == "codex":
                rows = [dict(row) for row in connection.execute("WITH RECURSIVE owned(id) AS (SELECT ? UNION SELECT child_thread_id FROM thread_spawn_edges JOIN owned ON parent_thread_id=owned.id) SELECT threads.id,threads.rollout_path FROM threads JOIN owned ON threads.id=owned.id LIMIT 1001", (self.root_id,))]
            else:
                rows = [dict(row) for row in connection.execute("WITH RECURSIVE owned(id) AS (SELECT ? UNION SELECT session.id FROM session JOIN owned ON session.parent_id=owned.id) SELECT session.id FROM session JOIN owned ON session.id=owned.id LIMIT 1001", (self.root_id,))]
            require(0 < len(rows) <= 1000, "native descendant coverage unavailable")
            result = []
            for row in rows:
                name = hashlib.sha256(row["id"].encode()).hexdigest()
                target = destination / (name + ".jsonl")
                if self.runtime == "codex":
                    source = Path(row["rollout_path"]).resolve()
                    require(source.is_relative_to(self.home) and source.is_file(), "native transcript outside owned home")
                    shutil.copyfile(source, target)
                else:
                    with target.open("w", encoding="utf-8") as stream:
                        for table in ("session", "message", "part"):
                            column = "id" if table == "session" else "session_id"
                            for item in connection.execute("SELECT * FROM " + table + " WHERE " + column + "=?", (row["id"],)):
                                stream.write(json.dumps({"table": table, "row": dict(item)}, ensure_ascii=False) + "\n")
                with target.open("rb") as stream:
                    checksum = hashlib.file_digest(stream, "sha256").hexdigest()
                result.append({"identitySha256": name, "file": target.name, "bytes": target.stat().st_size, "sha256": checksum})
        (destination / "manifest.json").write_text(json.dumps({"privateTranscripts": True, "runtime": self.runtime, "complete": True, "files": result}, indent=2) + "\n", encoding="utf-8")
        return {"complete": True, "sessionCount": len(result), "manifestSha256": hashlib.sha256((destination / "manifest.json").read_bytes()).hexdigest()}
