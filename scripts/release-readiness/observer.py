"""Read-only release evidence observer. Network and ref updates are explicit opt-ins."""

import argparse
from datetime import datetime, timezone
import html
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


SHA = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
MAX_PAGES = 20
MAX_BODY = 8 * 1024 * 1024


class ObservationError(Exception):
    pass


def git(repo, *args, timeout=30):
    # Neither git credential helpers nor an interactive prompt may obtain credentials.
    command = [
        "git", "--no-lazy-fetch", "-c", "credential.helper=", "-c", "credential.interactive=never",
        "-c", "core.askPass=", "-C", str(repo), *args,
    ]
    environment = os.environ.copy()
    environment.update({"GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "", "SSH_ASKPASS": "", "GIT_NO_LAZY_FETCH": "1"})
    try:
        result = subprocess.run(command, capture_output=True, timeout=timeout, env=environment, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ObservationError("git unavailable or timed out") from error
    if result.returncode:
        # Git stderr can contain local paths or configured remote details. Do not publish it.
        raise ObservationError("git command failed (exit %s)" % result.returncode)
    return result.stdout.decode("utf-8")


def remote_identity(url):
    if re.match(r"^[A-Za-z]:[\\/]", url):
        return {"kind": "local", "name": None}
    if url.startswith(("\\\\", "//")):
        raise ObservationError("network file remotes are unsupported")
    parsed = urlsplit(url)
    if parsed.username or parsed.password:
        raise ObservationError("credential-bearing or SSH remotes are unsupported")
    if parsed.scheme == "https" and parsed.hostname == "github.com":
        path = parsed.path.strip("/")
        if path.endswith(".git"):
            path = path[:-4]
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", path) or parsed.query or parsed.fragment:
            raise ObservationError("unsupported GitHub remote shape")
        return {"kind": "github_https", "name": path}
    if parsed.scheme in ("", "file") and not url.startswith("git@") and parsed.netloc in ("", "localhost"):
        return {"kind": "local", "name": None}
    raise ObservationError("only public GitHub HTTPS or local file remotes are supported")


def parse_remote_heads(text):
    heads = {}
    for line in text.splitlines():
        fields = line.split()
        if len(fields) != 2 or not SHA.fullmatch(fields[0]) or not fields[1].startswith("refs/heads/"):
            raise ObservationError("invalid remote-head inventory")
        name = fields[1][len("refs/heads/"):]
        if not name or name in heads:
            raise ObservationError("duplicate or empty remote head")
        heads[name] = fields[0]
    return heads


def local_heads(repo, remote):
    text = git(repo, "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)", "refs/remotes/" + remote + "/")
    heads = {}
    prefix = "refs/remotes/" + remote + "/"
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or not SHA.fullmatch(parts[1]):
            raise ObservationError("invalid tracking-ref inventory")
        if parts[2]:
            continue
        heads[parts[0][len(prefix):]] = parts[1]
    return heads


def ancestry(repo, main_sha, branch_sha):
    unknown = {"state": "unknown", "ahead": None, "behind": None}
    if not isinstance(main_sha, str) or not isinstance(branch_sha, str) or not SHA.fullmatch(main_sha) or not SHA.fullmatch(branch_sha):
        return unknown
    if main_sha == branch_sha:
        return {"state": "known", "ahead": 0, "behind": 0}
    try:
        # Truncated history can produce plausible but incomplete ahead/behind counts.
        # Fetching refs does not make a shallow clone complete; never deepen implicitly.
        if git(repo, "rev-parse", "--is-shallow-repository").strip() != "false":
            return unknown
    except ObservationError:
        return unknown
    try:
        counts = git(repo, "rev-list", "--left-right", "--count", main_sha + "..." + branch_sha).split()
        if len(counts) != 2:
            raise ObservationError("invalid ancestry result")
        behind, ahead = map(int, counts)
        return {"state": "known", "ahead": ahead, "behind": behind}
    except (ObservationError, ValueError):
        return unknown


class ApiRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        if target.scheme != "https" or target.hostname != "api.github.com":
            raise ObservationError("GitHub API redirected outside its fixed origin")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class PublicGithub:
    def __init__(self):
        self.opener = build_opener(ApiRedirects())

    def get(self, path):
        request = Request(
            "https://api.github.com" + path,
            headers={"Accept": "application/vnd.github+json", "User-Agent": "Vector-release-evidence-observer"},
        )
        try:
            with self.opener.open(request, timeout=15) as response:
                body = response.read(MAX_BODY + 1)
            if len(body) > MAX_BODY:
                raise ObservationError("GitHub API response exceeded the metadata limit")
            return json.loads(body)
        except HTTPError as error:
            raise ObservationError("GitHub API HTTP %s" % error.code) from error
        except (URLError, TimeoutError, OSError, ValueError) as error:
            raise ObservationError("GitHub API unavailable or invalid JSON") from error


def pages(client, path, key=None):
    result = []
    for page in range(1, MAX_PAGES + 1):
        separator = "&" if "?" in path else "?"
        value = client.get(path + separator + urlencode({"per_page": 100, "page": page}))
        if key and not isinstance(value, dict):
            raise ObservationError("GitHub metadata page has an unexpected shape")
        batch = value.get(key) if key else value
        if not isinstance(batch, list):
            raise ObservationError("GitHub metadata page has an unexpected shape")
        result.extend(batch)
        if len(batch) < 100:
            if key and isinstance(value.get("total_count"), int) and len(result) < value["total_count"]:
                raise ObservationError("GitHub metadata pagination is incomplete")
            return result
    raise ObservationError("GitHub metadata pagination limit reached; count is incomplete")


def latest_checks(check_runs, statuses, sha):
    latest = {}
    for item in check_runs:
        if not isinstance(item, dict) or item.get("head_sha") != sha:
            raise ObservationError("check run does not match the pinned head")
        app = item.get("app") or {}
        if not isinstance(item.get("name"), str) or not isinstance(app, dict) or not isinstance(app.get("id"), int) or not isinstance(item.get("id"), int):
            raise ObservationError("invalid check-run metadata")
        key = ("check", item["name"], app.get("id"))
        record = {
            "kind": "check", "name": item["name"], "appId": app.get("id"), "id": item["id"],
            "headSha": sha, "status": item.get("status"), "conclusion": item.get("conclusion"),
            "url": item.get("html_url"),
        }
        if key not in latest or record["id"] > latest[key]["id"]:
            latest[key] = record
    for item in statuses:
        if not isinstance(item, dict) or not isinstance(item.get("context"), str) or not isinstance(item.get("id"), int):
            raise ObservationError("invalid commit-status metadata")
        if item.get("sha", sha) != sha:
            raise ObservationError("commit status does not match the pinned head")
        key = ("status", item["context"], None)
        record = {
            "kind": "status", "name": item["context"], "appId": None, "id": item["id"],
            "headSha": sha, "status": item.get("state"), "conclusion": item.get("state"),
            "url": item.get("target_url"),
        }
        if key not in latest or record["id"] > latest[key]["id"]:
            latest[key] = record
    return sorted(latest.values(), key=lambda item: (item["kind"], item["name"], str(item["appId"])))


def check_state(record):
    if not isinstance(record, dict) or not isinstance(record.get("status"), str):
        return "unknown"
    if record.get("kind") == "status":
        return {"success": "passed", "failure": "failed", "error": "failed", "pending": "pending"}.get(record["status"], "unknown")
    if record.get("kind") != "check" or (record.get("conclusion") is not None and not isinstance(record["conclusion"], str)):
        return "unknown"
    if record["status"] in ("queued", "in_progress", "requested", "waiting", "pending"):
        return "pending"
    if record["status"] != "completed" or not isinstance(record.get("conclusion"), str):
        return "unknown"
    return {
        "success": "passed", "failure": "failed", "timed_out": "failed", "action_required": "failed",
        "skipped": "not_run", "neutral": "not_run", "cancelled": "not_run", "stale": "not_run",
    }.get(record["conclusion"], "unknown")


def combine_states(states):
    for state in ("failed", "unknown", "pending", "not_run"):
        if state in states:
            return state
    return "passed" if states else "not_applicable"


def required_check_state(records, names, complete):
    if names is None:
        return {"state": "unknown", "checks": [], "reason": "required-check policy not supplied"}
    if not complete:
        return {"state": "unknown", "checks": [], "reason": "check metadata incomplete or inconsistent"}
    checks = []
    for name in names:
        matching = [check_state(item) for item in records if item["name"] == name]
        checks.append({"name": name, "state": combine_states(matching) if matching else "not_run"})
    return {"state": combine_states([item["state"] for item in checks]), "checks": checks}


def load_policy(path):
    policy = json.loads(Path(path).read_text(encoding="utf-8")) if path else {}
    if not isinstance(policy, dict):
        raise ValueError("policy must be an object")
    lanes = policy.get("lanes", [])
    required = policy.get("requiredChecks", {})
    gates = policy.get("externalGates", [])
    if not isinstance(lanes, list) or not isinstance(required, dict) or not isinstance(gates, list):
        raise ValueError("policy lanes, requiredChecks or externalGates have invalid shapes")
    ids = set()
    for lane in lanes:
        if not isinstance(lane, dict) or not isinstance(lane.get("id"), str) or lane["id"] in ids:
            raise ValueError("policy lane ids must be unique strings")
        ids.add(lane["id"])
        if lane.get("scope113", "unknown") not in ("included", "separate", "unknown"):
            raise ValueError("invalid scope113 policy")
        if not isinstance(lane.get("branches", []), list) or not all(isinstance(x, str) for x in lane.get("branches", [])):
            raise ValueError("lane branches must be names")
    for names in required.values():
        if names is not None and (not isinstance(names, list) or not all(isinstance(x, str) for x in names)):
            raise ValueError("requiredChecks values must be exact names or null")
    for gate in gates:
        if not isinstance(gate, dict) or not all(isinstance(gate.get(x), str) for x in ("id", "lane", "kind", "description")):
            raise ValueError("external gates need id, lane, kind and description")
    return policy


def api_branch_heads(client, repository):
    heads = {}
    for item in pages(client, "/repos/" + repository + "/branches"):
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("commit"), dict):
            raise ObservationError("invalid GitHub branch inventory")
        name, sha = item["name"], item["commit"].get("sha")
        if not name or name in heads or not isinstance(sha, str) or not SHA.fullmatch(sha):
            raise ObservationError("invalid or duplicate GitHub branch head")
        heads[name] = sha
    return heads


def api_refused(error):
    return str(error) in ("GitHub API HTTP 403", "GitHub API HTTP 429")


def github_metadata(client, repository, heads, targets):
    prefix = "/repos/" + repository
    data = {"state": "known", "repositoryId": None, "pullRequests": [], "pullRequestsComplete": False, "branchHeads": {}, "branchesComplete": False, "heads": {}, "errors": []}
    try:
        identity = client.get(prefix)
        if not isinstance(identity, dict) or not isinstance(identity.get("id"), int) or str(identity.get("full_name", "")).lower() != repository.lower():
            raise ObservationError("GitHub repository identity mismatch")
        data["repositoryId"] = identity.get("id")
        data["branchHeads"] = api_branch_heads(client, repository)
        data["branchesComplete"] = True
    except ObservationError as error:
        data["state"] = "unknown"
        data["errors"].append(str(error))
        return data
    try:
        pulls = pages(client, prefix + "/pulls?state=open")
        for item in pulls:
            if not isinstance(item, dict):
                raise ObservationError("invalid pull-request metadata")
            head, base = item.get("head", {}), item.get("base", {})
            if not isinstance(head, dict) or not isinstance(base, dict) or not isinstance(item.get("number"), int) or not isinstance(item.get("draft"), bool):
                raise ObservationError("invalid pull-request metadata")
            if not all(isinstance(value.get("ref"), str) and isinstance(value.get("sha"), str) and SHA.fullmatch(value["sha"]) for value in (head, base)):
                raise ObservationError("pull-request refs or head identities are missing")
            source = head.get("repo") or {}
            if not isinstance(source, dict):
                raise ObservationError("invalid pull-request source")
            same_repository = str(source.get("full_name", "")).lower() == repository.lower()
            matches = head.get("sha") == heads[head["ref"]] if same_repository and head.get("ref") in heads else None
            data["pullRequests"].append({
                "number": item["number"], "url": item.get("html_url"), "state": item.get("state"),
                "draft": item["draft"], "headRef": head.get("ref"), "headSha": head.get("sha"),
                "baseRef": base.get("ref"), "baseSha": base.get("sha"),
                "sameRepository": same_repository, "matchesPinnedHead": matches,
            })
            if matches is False:
                data["state"] = "unknown"
                data["errors"].append("pull-request head differs from pinned branch: " + head["ref"])
        data["pullRequestsComplete"] = True
    except ObservationError as error:
        data["state"] = "unknown"
        data["errors"].append(str(error))
        if api_refused(error):
            return data
    for branch in sorted(targets):
        sha = heads.get(branch)
        result = {"headSha": sha, "apiHeadSha": None, "checks": [], "complete": False, "errors": []}
        data["heads"][branch] = result
        if not sha:
            result["errors"].append("branch missing from pinned inventory")
            data["state"] = "unknown"
            continue
        try:
            result["apiHeadSha"] = data["branchHeads"].get(branch)
            if result["apiHeadSha"] != sha:
                raise ObservationError("GitHub branch head differs from pinned Git head")
            checks = pages(client, prefix + "/commits/" + sha + "/check-runs?filter=all", "check_runs")
            statuses = pages(client, prefix + "/commits/" + sha + "/statuses")
            result["checks"] = latest_checks(checks, statuses, sha)
            result["complete"] = True
        except (ObservationError, KeyError, TypeError) as error:
            result["errors"].append(str(error) if isinstance(error, ObservationError) else "invalid GitHub branch metadata")
            data["state"] = "unknown"
            if api_refused(error):
                data["errors"].append(str(error))
                break
    return data


def compare_heads(pinned, final):
    changed = sorted(name for name in set(pinned) | set(final) if pinned.get(name) != final.get(name))
    return {"remoteHeadsUnchanged": not changed, "superseded": bool(changed), "changedRefs": changed}


def collect(repo, remote="origin", policy=None, fetch=False, github=False, client=None):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", remote):
        raise ValueError("invalid remote name")
    repo = Path(repo).resolve()
    policy = policy or {}
    started = datetime.now(timezone.utc).isoformat()
    identity = remote_identity(git(repo, "config", "--get", "remote." + remote + ".url").strip())
    online = fetch or github
    errors = []
    if fetch:
        try:
            git(repo, "fetch", "--no-tags", "--prune", remote, "+refs/heads/*:refs/remotes/" + remote + "/*", timeout=45)
        except ObservationError as error:
            errors.append("explicit ref refresh failed: " + str(error))
    inventory_available = True
    try:
        heads = parse_remote_heads(git(repo, "ls-remote", "--heads", remote)) if online else local_heads(repo, remote)
    except ObservationError as error:
        heads = {}
        inventory_available = False
        errors.append("branch inventory unavailable: " + str(error))
    main_sha = heads.get("main")
    if not main_sha:
        errors.append("main missing from pinned inventory")
    branches = [{"ref": name, "sha": sha, "ancestry": ancestry(repo, main_sha, sha)} for name, sha in sorted(heads.items())]
    lanes = policy.get("lanes", [])
    targets = {item["ref"] for item in branches if item["ancestry"]["state"] != "known" or item["ancestry"]["ahead"] > 0} | {"main"}
    for lane in lanes:
        if policy.get("requiredChecks", {}).get(lane["id"]) is not None:
            targets.update(lane.get("branches", []))
    metadata = {"state": "not_collected", "pullRequests": [], "pullRequestsComplete": False, "heads": {}, "errors": []}
    if github:
        if identity["kind"] != "github_https":
            errors.append("GitHub metadata requires a public GitHub HTTPS remote")
        else:
            client = client or PublicGithub()
            metadata = github_metadata(client, identity["name"], heads, targets)
    lane_results = []
    for lane in lanes:
        observed = []
        for branch in lane.get("branches", []):
            records = metadata["heads"].get(branch, {})
            gate = required_check_state(records.get("checks", []), policy.get("requiredChecks", {}).get(lane["id"]), records.get("complete", False))
            observed.append({"ref": branch, "sha": heads.get(branch), "ci": gate})
        lane_results.append({
            "id": lane["id"], "scope113": lane.get("scope113", "unknown"), "owner": lane.get("owner"),
            "notes": lane.get("notes", []), "branches": observed,
            "ciState": combine_states([item["ci"]["state"] for item in observed]) if observed else "unknown",
        })
    consistency = {"remoteHeadsUnchanged": None, "superseded": None, "changedRefs": [], "apiHeadsMatch": None, "apiHeadsUnchanged": None, "errors": []}
    try:
        final = parse_remote_heads(git(repo, "ls-remote", "--heads", remote)) if online else local_heads(repo, remote)
        if inventory_available:
            consistency.update(compare_heads(heads, final))
    except ObservationError as error:
        consistency["errors"].append(str(error))
    if github and identity["kind"] == "github_https":
        consistency["apiHeadsMatch"] = metadata["branchHeads"] == heads if inventory_available and metadata.get("branchesComplete") else None
        if consistency["apiHeadsMatch"] is False or any(item.get("matchesPinnedHead") is False for item in metadata["pullRequests"]):
            consistency["superseded"] = True
        if metadata.get("branchesComplete") and not any(api_refused(error) for error in metadata["errors"]):
            try:
                final_api_heads = api_branch_heads(client, identity["name"])
                consistency["apiHeadsUnchanged"] = final_api_heads == metadata["branchHeads"]
                if not consistency["apiHeadsUnchanged"]:
                    consistency["superseded"] = True
                    changes = compare_heads(metadata["branchHeads"], final_api_heads)["changedRefs"]
                    consistency["changedRefs"] = sorted(set(consistency["changedRefs"]) | set(changes))
            except ObservationError as error:
                consistency["errors"].append("final API inventory unavailable: " + str(error))
    evidence = dict(policy.get("evidence") or {})
    if evidence:
        evidence["commitSha"] = heads.get(evidence.get("ref", "main"))
        try:
            if not evidence["commitSha"] or not isinstance(evidence.get("path"), str):
                raise ObservationError("policy evidence cannot be resolved")
            evidence["objectSha"] = git(repo, "rev-parse", "--verify", evidence["commitSha"] + ":" + evidence["path"]).strip()
            evidence["state"] = "known"
        except ObservationError:
            evidence["state"] = "unknown"
    return {
        "schemaVersion": 1, "observedAt": started, "completedAt": datetime.now(timezone.utc).isoformat(),
        "repository": identity, "remote": remote,
        "collection": {"mode": "remote" if online else "offline", "inventorySource": "ls-remote" if online else "local_tracking_refs", "inventoryAvailable": inventory_available, "inventoryComplete": online and inventory_available, "errors": errors},
        "main": {"ref": "main", "sha": main_sha}, "branches": branches,
        "releasePolicy": {"version": policy.get("version"), "evidence": evidence}, "lanes": lane_results,
        "github": metadata,
        "externalGates": [{"id": item["id"], "lane": item["lane"], "kind": item["kind"], "description": item["description"], "state": "unknown", "authority": "external"} for item in policy.get("externalGates", [])],
        "consistency": consistency, "releaseApproval": "not_assessed", "activeAgentCount": None,
    }


def summary(snapshot):
    branches = snapshot["branches"]
    known = [item for item in branches if item["ancestry"]["state"] == "known"]
    incomplete = bool(snapshot["collection"]["errors"] or snapshot["github"].get("errors") or snapshot["consistency"]["errors"] or snapshot["github"]["state"] == "unknown" or len(known) != len(branches) or not snapshot["collection"]["inventoryAvailable"])
    state = "incomplete" if incomplete else ("observed" if snapshot["collection"]["mode"] == "remote" else "locally_observed")
    if snapshot["consistency"]["superseded"]:
        state = "superseded"
    return {
        "branchesObserved": len(branches) if snapshot["collection"]["inventoryAvailable"] else None,
        "includedInMain": sum(item["ref"] != "main" and item["ancestry"]["ahead"] == 0 for item in known) if snapshot["collection"]["inventoryAvailable"] else None,
        "unmerged": sum(item["ancestry"]["ahead"] > 0 for item in known) if snapshot["collection"]["inventoryAvailable"] else None,
        "unknownAncestry": len(branches) - len(known) if snapshot["collection"]["inventoryAvailable"] else None,
        "snapshotState": state,
        "approval": "not_assessed",
    }


def markdown(snapshot):
    def cell(value):
        if value is None:
            return "unknown"
        return html.escape(str(value)).replace("|", "\\|").replace("\n", " ").replace("`", "\\`")

    numbers = summary(snapshot)
    lines = [
        "# Release evidence snapshot", "", "Observed: " + cell(snapshot["observedAt"]),
        "Main: `" + cell(snapshot["main"]["sha"]) + "`", "",
        "%s branches observed (including main); %s other branches included in main; %s unmerged; %s ancestry unknown." % tuple(cell(numbers[name]) for name in ("branchesObserved", "includedInMain", "unmerged", "unknownAncestry")),
        "Inventory: " + cell(snapshot["collection"]["inventorySource"]) + "; completeness: " + ("remote inventory observed" if snapshot["collection"]["inventoryComplete"] else "locally known refs only"),
        "Snapshot: " + numbers["snapshotState"] + ". Release approval is not assessed; active-agent count is unknown.",
        "", "| Lane | .113 scope | Branches | Required-check evidence |", "| --- | --- | --- | --- |",
    ]
    for lane in snapshot["lanes"]:
        lines.append("| %s | %s | %s | %s |" % (cell(lane["id"]), cell(lane["scope113"]), cell(", ".join(item["ref"] for item in lane["branches"])), cell(lane["ciState"])))
    lines += ["", "| Branch | Pinned SHA | Ahead | Behind |", "| --- | --- | ---: | ---: |"]
    for item in snapshot["branches"]:
        relation = item["ancestry"]
        lines.append("| %s | %s | %s | %s |" % (cell(item["ref"]), cell(item["sha"]), cell(relation["ahead"]), cell(relation["behind"])))
    lines += ["", "PR metadata: " + cell(snapshot["github"]["state"]) + "; complete: " + str(snapshot["github"]["pullRequestsComplete"]) + ".", "", "| Open PR | Draft | Head | Base |", "| --- | --- | --- | --- |"]
    for item in snapshot["github"]["pullRequests"]:
        lines.append("| %s | %s | %s | %s |" % (item["number"], item["draft"], cell(item["headSha"]), cell(item["baseSha"])))
    for gate in snapshot["externalGates"]:
        lines.append("\nExternal gate %s (%s): unknown - %s" % (cell(gate["id"]), cell(gate["lane"]), cell(gate["description"])))
    problems = list(snapshot["collection"]["errors"]) + snapshot["github"].get("errors", []) + snapshot["consistency"]["errors"]
    for branch, item in snapshot["github"].get("heads", {}).items():
        problems.extend(branch + ": " + error for error in item["errors"])
    lines += ["\nCollection issue: " + cell(error) for error in problems]
    return "\n".join(lines) + "\n"


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--remote", default="origin")
    parser.add_argument("--policy")
    parser.add_argument("--fetch", action="store_true", help="explicitly refresh all remote branch refs")
    parser.add_argument("--github", action="store_true", help="read public GitHub PR/check metadata without credentials")
    parser.add_argument("--format", choices=("json", "markdown"), default="json")
    parser.add_argument("--output", help="write the snapshot to this explicit destination instead of stdout")
    options = parser.parse_args(argv)
    try:
        snapshot = collect(options.repo, options.remote, load_policy(options.policy), options.fetch, options.github)
        snapshot["summary"] = summary(snapshot)
        output = json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n" if options.format == "json" else markdown(snapshot)
        if options.output:
            Path(options.output).write_text(output, encoding="utf-8")
        else:
            print(output, end="")
        return 0
    except (ObservationError, ValueError, OSError) as error:
        print("Observation unavailable: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
