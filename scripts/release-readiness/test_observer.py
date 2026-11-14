import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import observer


HEAD = "a" * 40
OTHER = "b" * 40


def check(identifier=1, status="completed", conclusion="success", sha=HEAD, app=10, name="tests"):
    return {"id": identifier, "name": name, "app": {"id": app}, "head_sha": sha, "status": status, "conclusion": conclusion, "html_url": "https://github.com/example/project/actions/runs/1"}


class FixtureApi:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def get(self, path):
        self.calls.append(path)
        answer = self.responses(path)
        if isinstance(answer, Exception):
            raise answer
        return answer


class EvidenceTests(unittest.TestCase):
    def test_git_subprocess_cannot_use_inherited_askpass_or_lazy_fetch(self):
        result = subprocess.CompletedProcess([], 0, stdout=b"fixture\n", stderr=b"")
        with patch.dict(os.environ, {"GIT_ASKPASS": "must-not-run", "SSH_ASKPASS": "must-not-run", "GIT_TERMINAL_PROMPT": "1", "READINESS_TEST_MARKER": "kept"}):
            with patch.object(observer.subprocess, "run", return_value=result) as called:
                self.assertEqual(observer.git("fixture-repo", "rev-parse", "HEAD"), "fixture\n")
        arguments, options = called.call_args
        self.assertIn("--no-lazy-fetch", arguments[0])
        self.assertEqual(options["env"]["GIT_TERMINAL_PROMPT"], "0")
        self.assertEqual(options["env"]["GIT_ASKPASS"], "")
        self.assertEqual(options["env"]["SSH_ASKPASS"], "")
        self.assertEqual(options["env"]["GIT_NO_LAZY_FETCH"], "1")
        self.assertEqual(options["env"]["READINESS_TEST_MARKER"], "kept")
        self.assertEqual(options["stdin"], subprocess.DEVNULL)

    def test_remote_heads_reject_bad_or_duplicate_rows(self):
        value = HEAD + "\trefs/heads/main\n" + OTHER + "\trefs/heads/feature\n"
        self.assertEqual(observer.parse_remote_heads(value), {"main": HEAD, "feature": OTHER})
        self.assertEqual(observer.parse_remote_heads(""), {})
        for bad in ["not-a-sha refs/heads/main", HEAD + " refs/tags/main", value + HEAD + " refs/heads/main"]:
            with self.subTest(bad=bad), self.assertRaises(observer.ObservationError):
                observer.parse_remote_heads(bad)

    def test_identity_has_no_credential_or_ssh_path(self):
        self.assertEqual(observer.remote_identity("https://github.com/example/project.git"), {"kind": "github_https", "name": "example/project"})
        self.assertEqual(observer.remote_identity(r"C:\work\remote.git")["kind"], "local")
        for url in ["https://secret@github.com/example/project", "git@github.com:example/project.git", "ssh://github.com/example/project", r"\\server\share\remote.git"]:
            with self.subTest(url=url), self.assertRaises(observer.ObservationError):
                observer.remote_identity(url)

    def test_later_attempt_wins_over_old_success(self):
        latest = observer.latest_checks([check(1), check(2, "in_progress", None)], [], HEAD)
        self.assertEqual(len(latest), 1)
        self.assertEqual(observer.required_check_state(latest, ["tests"], True)["state"], "pending")
        cancelled = observer.latest_checks([check(1), check(2, conclusion="cancelled")], [], HEAD)
        self.assertEqual(observer.required_check_state(cancelled, ["tests"], True)["state"], "not_run")

    def test_latest_is_per_app_and_same_named_failure_cannot_be_hidden(self):
        records = observer.latest_checks([check(1, app=10), check(2, app=20, conclusion="failure")], [], HEAD)
        self.assertEqual(len(records), 2)
        self.assertEqual(observer.required_check_state(records, ["tests"], True)["state"], "failed")

    def test_old_head_is_never_current_evidence(self):
        with self.assertRaises(observer.ObservationError):
            observer.latest_checks([check(sha=OTHER)], [], HEAD)
        with self.assertRaises(observer.ObservationError):
            observer.latest_checks([], [{"id": 1, "context": "tests", "state": "success", "sha": OTHER}], HEAD)

    def test_skips_neutral_missing_and_unknown_are_distinct_from_pass(self):
        for conclusion in ["skipped", "neutral", "cancelled", "stale"]:
            records = observer.latest_checks([check(conclusion=conclusion)], [], HEAD)
            self.assertEqual(observer.required_check_state(records, ["tests"], True)["state"], "not_run")
        records = observer.latest_checks([check()], [], HEAD)
        self.assertEqual(observer.required_check_state(records, None, True)["state"], "unknown")
        self.assertEqual(observer.required_check_state(records, ["tests"], False)["state"], "unknown")
        self.assertEqual(observer.required_check_state(records, ["missing"], True)["state"], "not_run")
        self.assertEqual(observer.required_check_state(records, [], True)["state"], "not_applicable")
        self.assertEqual(observer.required_check_state(records, ["tests"], True)["state"], "passed")

    def test_malformed_check_states_are_unknown_without_hash_errors(self):
        for value in [{}, [], None, True, 1]:
            for kind in ("check", "status"):
                with self.subTest(value=value, kind=kind):
                    self.assertEqual(observer.check_state({"kind": kind, "status": value, "conclusion": "success"}), "unknown")
            with self.subTest(conclusion=value):
                self.assertEqual(observer.check_state({"kind": "check", "status": "completed", "conclusion": value}), "unknown")
        self.assertEqual(observer.check_state(None), "unknown")
        self.assertEqual(observer.check_state([]), "unknown")
        records = observer.latest_checks([], [{"id": 1, "context": "tests", "state": {}}], HEAD)
        self.assertEqual(observer.required_check_state(records, ["tests"], True)["state"], "unknown")

    def test_commit_status_latest_pending_does_not_reuse_old_success(self):
        records = observer.latest_checks([], [{"id": 1, "context": "deploy", "state": "success"}, {"id": 2, "context": "deploy", "state": "pending"}], HEAD)
        self.assertEqual(observer.required_check_state(records, ["deploy"], True)["state"], "pending")

    def test_pagination_reads_all_pages_and_does_not_return_partial_on_failure(self):
        def answer(path):
            page = parse_qs(urlsplit(path).query)["page"]
            return list(range(100)) if page == ["1"] else [100]

        client = FixtureApi(answer)
        self.assertEqual(len(observer.pages(client, "/items?state=open")), 101)
        self.assertEqual(len(client.calls), 2)
        broken = FixtureApi(lambda path: list(range(100)) if "page=1" in path else observer.ObservationError("rate limited"))
        with self.assertRaises(observer.ObservationError):
            observer.pages(broken, "/items")
        truncated = FixtureApi(lambda path: {"total_count": 3, "check_runs": [check()]})
        with self.assertRaises(observer.ObservationError):
            observer.pages(truncated, "/checks", "check_runs")

    def test_wrong_repository_identity_stops_metadata_association(self):
        client = FixtureApi(lambda path: {"id": 2, "full_name": "other/project"})
        data = observer.github_metadata(client, "example/project", {"main": HEAD}, {"main"})
        self.assertEqual(data["state"], "unknown")
        self.assertEqual(data["heads"], {})
        self.assertEqual(client.calls, ["/repos/example/project"])

    def test_metadata_retains_multiple_prs_draft_flags_and_fork_identity(self):
        def answer(path):
            if path == "/repos/example/project":
                return {"id": 1, "full_name": "example/project"}
            if "/pulls?" in path:
                return [
                    {"number": 1, "draft": True, "state": "open", "head": {"ref": "feature", "sha": HEAD, "repo": {"full_name": "example/project"}}, "base": {"ref": "main", "sha": OTHER}},
                    {"number": 2, "draft": False, "state": "open", "head": {"ref": "feature", "sha": HEAD, "repo": {"full_name": "someone/fork"}}, "base": {"ref": "main", "sha": OTHER}},
                ]
            if "/branches?" in path:
                return [{"name": "feature", "commit": {"sha": HEAD}}]
            if "/check-runs?" in path:
                return {"total_count": 1, "check_runs": [check()]}
            if "/statuses?" in path:
                return []
            raise AssertionError(path)

        data = observer.github_metadata(FixtureApi(answer), "example/project", {"feature": HEAD}, {"feature"})
        self.assertTrue(data["pullRequestsComplete"])
        self.assertEqual([item["draft"] for item in data["pullRequests"]], [True, False])
        self.assertEqual([item["sameRepository"] for item in data["pullRequests"]], [True, False])
        self.assertEqual([item["matchesPinnedHead"] for item in data["pullRequests"]], [True, None])
        self.assertTrue(data["heads"]["feature"]["complete"])

    def test_api_branch_head_race_leaves_checks_incomplete(self):
        def answer(path):
            if path == "/repos/example/project":
                return {"id": 1, "full_name": "example/project"}
            if "/pulls?" in path:
                return []
            if "/branches?" in path:
                return [{"name": "main", "commit": {"sha": OTHER}}]
            raise AssertionError("checks must not be requested for the wrong branch head")

        data = observer.github_metadata(FixtureApi(answer), "example/project", {"main": HEAD}, {"main"})
        self.assertFalse(data["heads"]["main"]["complete"])
        self.assertEqual(data["state"], "unknown")
        self.assertTrue(data["heads"]["main"]["errors"])

    def test_malformed_payloads_are_unknown_instead_of_empty_or_crashes(self):
        for value in [None, [], {"check_runs": None}, {"check_runs": "bad"}]:
            with self.subTest(value=value), self.assertRaises(observer.ObservationError):
                observer.pages(FixtureApi(lambda path: value), "/checks", "check_runs")
        client = FixtureApi(lambda path: {"id": 1, "full_name": "example/project"} if path == "/repos/example/project" else [{"name": "main", "commit": None}])
        data = observer.github_metadata(client, "example/project", {"main": HEAD}, {"main"})
        self.assertEqual(data["state"], "unknown")
        self.assertFalse(data["branchesComplete"])
        self.assertFalse(data["pullRequestsComplete"])

    def test_rate_limit_stops_optional_requests_and_preserves_unknown(self):
        def answer(path):
            if path == "/repos/example/project":
                return {"id": 1, "full_name": "example/project"}
            if "/branches?" in path:
                return [{"name": "main", "commit": {"sha": HEAD}}]
            return observer.ObservationError("GitHub API HTTP 403")

        client = FixtureApi(answer)
        data = observer.github_metadata(client, "example/project", {"main": HEAD}, {"main"})
        self.assertEqual(data["state"], "unknown")
        self.assertEqual(len(client.calls), 3)
        self.assertEqual(data["heads"], {})

    def test_remote_changes_include_additions_deletions_and_force_pushes(self):
        changed = observer.compare_heads({"main": HEAD, "deleted": HEAD}, {"main": OTHER, "new": HEAD})
        self.assertTrue(changed["superseded"])
        self.assertFalse(changed["remoteHeadsUnchanged"])
        self.assertEqual(changed["changedRefs"], ["deleted", "main", "new"])
        self.assertFalse(observer.compare_heads({"main": HEAD}, {"main": HEAD})["superseded"])

    def test_unknown_history_completeness_cannot_produce_known_counts(self):
        for answer in ["true\n", "unknown\n", observer.ObservationError("unavailable")]:
            def commands(repo, *args):
                self.assertEqual(args, ("rev-parse", "--is-shallow-repository"))
                if isinstance(answer, Exception):
                    raise answer
                return answer

            with self.subTest(answer=str(answer)), patch.object(observer, "git", side_effect=commands):
                self.assertEqual(observer.ancestry(".", HEAD, OTHER), {"state": "unknown", "ahead": None, "behind": None})
                self.assertEqual(observer.ancestry(".", HEAD, HEAD), {"state": "known", "ahead": 0, "behind": 0})

    def test_missing_git_inventory_with_available_api_is_incomplete_not_a_false_race(self):
        # Inject only the remote-command boundary: real network failure is not needed to prove the collector rule.
        def commands(repo, *args, **kwargs):
            if args[0] == "config":
                return "https://github.com/example/project.git\n"
            raise observer.ObservationError("transport unavailable")

        def answer(path):
            if path == "/repos/example/project":
                return {"id": 1, "full_name": "example/project"}
            if "/branches?" in path:
                return [{"name": "main", "commit": {"sha": HEAD}}]
            if "/pulls?" in path:
                return []
            raise AssertionError(path)

        with patch.object(observer, "git", side_effect=commands):
            snapshot = observer.collect(".", github=True, client=FixtureApi(answer))
        self.assertIsNone(snapshot["consistency"]["apiHeadsMatch"])
        self.assertIsNone(snapshot["consistency"]["superseded"])
        self.assertEqual(observer.summary(snapshot)["snapshotState"], "incomplete")

    def test_collector_batches_api_heads_and_marks_an_end_of_collection_race(self):
        def commands(repo, *args, **kwargs):
            if args[0] == "config":
                return "https://github.com/example/project.git\n"
            if args[0] == "ls-remote":
                return HEAD + "\trefs/heads/main\n"
            if args[0] == "rev-list":
                return "0\t0\n"
            raise AssertionError(args)

        batches = []

        def answer(path):
            if path == "/repos/example/project":
                return {"id": 1, "full_name": "example/project"}
            if "/branches?" in path:
                batches.append(path)
                return [{"name": "main", "commit": {"sha": HEAD if len(batches) == 1 else OTHER}}]
            if "/pulls?" in path or "/statuses?" in path:
                return []
            if "/check-runs?" in path:
                return {"total_count": 1, "check_runs": [check()]}
            raise AssertionError(path)

        with patch.object(observer, "git", side_effect=commands):
            snapshot = observer.collect(".", github=True, client=FixtureApi(answer), policy={"lanes": [{"id": "main", "branches": ["main"]}], "requiredChecks": {"main": ["tests"]}})
        self.assertEqual(len(batches), 2)
        self.assertEqual(snapshot["lanes"][0]["ciState"], "passed")  # Historical pinned-head evidence is retained.
        self.assertFalse(snapshot["consistency"]["apiHeadsUnchanged"])
        self.assertTrue(snapshot["consistency"]["superseded"])
        self.assertEqual(observer.summary(snapshot)["snapshotState"], "superseded")


class RealGitTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="vector-readiness-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.assertTrue(self.root.is_relative_to(Path(tempfile.gettempdir()).resolve()))
        self.remote = self.root / "remote.git"
        self.repo = self.root / "checkout"
        self.repo.mkdir()
        self.run_git(self.root, "init", "--bare", "--initial-branch=main", str(self.remote))
        self.run_git(self.repo, "init", "--initial-branch=main")
        self.run_git(self.repo, "config", "user.name", "Readiness Fixture")
        self.run_git(self.repo, "config", "user.email", "fixture@example.invalid")
        (self.repo / "note.txt").write_text("main\n", encoding="utf-8")
        self.run_git(self.repo, "add", "note.txt")
        self.run_git(self.repo, "commit", "-m", "fixture main")
        self.run_git(self.repo, "remote", "add", "origin", str(self.remote))
        self.run_git(self.repo, "push", "origin", "main")
        self.run_git(self.repo, "switch", "-c", "feature")
        (self.repo / "note.txt").write_text("feature\n", encoding="utf-8")
        self.run_git(self.repo, "commit", "-am", "fixture feature")
        self.run_git(self.repo, "push", "origin", "feature")
        self.feature = self.run_git(self.repo, "rev-parse", "HEAD").strip()
        self.run_git(self.repo, "switch", "main")

    @staticmethod
    def run_git(repo, *args):
        result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, timeout=15)
        if result.returncode:
            raise AssertionError(result.stderr.decode("utf-8", errors="replace"))
        return result.stdout.decode("utf-8")

    def test_default_offline_is_unchanged_local_snapshot_and_no_approval(self):
        refs = self.run_git(self.repo, "show-ref")
        policy = {"version": "1.99.113", "lanes": [{"id": "main", "branches": ["main"], "scope113": "included"}, {"id": "hands", "branches": ["feature"], "scope113": "separate"}], "requiredChecks": {"main": None}, "externalGates": [{"id": "owner", "lane": "main", "kind": "owner", "description": "Release acceptance", "approved": True}]}
        snapshot = observer.collect(self.repo, policy=policy)
        self.assertEqual(self.run_git(self.repo, "show-ref"), refs)
        self.assertEqual(self.run_git(self.repo, "status", "--porcelain"), "")
        self.assertFalse(snapshot["collection"]["inventoryComplete"])
        self.assertEqual(snapshot["collection"]["mode"], "offline")
        self.assertEqual(snapshot["github"]["state"], "not_collected")
        self.assertEqual(snapshot["releaseApproval"], "not_assessed")
        self.assertIsNone(snapshot["activeAgentCount"])
        self.assertEqual(snapshot["externalGates"][0]["state"], "unknown")
        self.assertNotIn("approved", snapshot["externalGates"][0])
        self.assertEqual(snapshot["lanes"][1]["scope113"], "separate")
        self.assertEqual(snapshot["lanes"][0]["ciState"], "unknown")
        rows = {item["ref"]: item for item in snapshot["branches"]}
        self.assertEqual(rows["feature"]["ancestry"], {"state": "known", "ahead": 1, "behind": 0})
        self.assertEqual(observer.markdown(snapshot), observer.markdown(json.loads(json.dumps(snapshot))))
        snapshot["github"]["state"] = "unknown"
        snapshot["github"]["errors"] = ["GitHub API HTTP 403"]
        self.assertEqual(observer.summary(snapshot)["snapshotState"], "incomplete")
        self.assertIn("Collection issue", observer.markdown(snapshot))

    def test_fetch_is_explicit_and_includes_heads_hidden_by_configured_refspec(self):
        self.run_git(self.repo, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main")
        self.run_git(self.remote, "update-ref", "refs/heads/hidden", self.feature)
        offline = observer.collect(self.repo)
        self.assertNotIn("hidden", [item["ref"] for item in offline["branches"]])
        online = observer.collect(self.repo, fetch=True)
        self.assertIn("hidden", [item["ref"] for item in online["branches"]])
        self.assertTrue(online["collection"]["inventoryComplete"])
        self.assertEqual(online["collection"]["inventorySource"], "ls-remote")
        self.assertTrue(online["consistency"]["remoteHeadsUnchanged"])
        self.assertEqual(self.run_git(self.repo, "config", "--get", "remote.origin.fetch").strip(), "+refs/heads/main:refs/remotes/origin/main")

    def test_unavailable_object_has_unknown_ancestry_not_zero(self):
        known = self.run_git(self.repo, "rev-parse", "HEAD").strip()
        self.assertEqual(observer.ancestry(self.repo, known, "f" * 40), {"state": "unknown", "ahead": None, "behind": None})

    def test_depth_one_file_clone_keeps_distinct_head_ancestry_unknown_after_fetch(self):
        shallow = self.root / "shallow-checkout"
        self.run_git(self.root, "clone", "--depth", "1", "--no-single-branch", self.remote.as_uri(), str(shallow))
        self.assertEqual(self.run_git(shallow, "rev-parse", "--is-shallow-repository").strip(), "true")
        for snapshot in [observer.collect(shallow), observer.collect(shallow, fetch=True)]:
            rows = {item["ref"]: item for item in snapshot["branches"]}
            self.assertEqual(rows["main"]["ancestry"], {"state": "known", "ahead": 0, "behind": 0})
            self.assertEqual(rows["feature"]["ancestry"], {"state": "unknown", "ahead": None, "behind": None})
            self.assertEqual(observer.summary(snapshot)["snapshotState"], "incomplete")
        self.assertEqual(self.run_git(shallow, "rev-parse", "--is-shallow-repository").strip(), "true")

    def test_unavailable_inventory_is_not_reported_as_zero_branches(self):
        renamed = self.root / "remote-unavailable.git"
        self.assertTrue(renamed.resolve().is_relative_to(self.root))
        self.remote.rename(renamed)
        snapshot = observer.collect(self.repo, fetch=True)
        self.assertFalse(snapshot["collection"]["inventoryAvailable"])
        self.assertFalse(snapshot["collection"]["inventoryComplete"])
        numbers = observer.summary(snapshot)
        self.assertIsNone(numbers["branchesObserved"])
        self.assertIsNone(numbers["unmerged"])
        self.assertIsNone(numbers["includedInMain"])
        self.assertEqual(numbers["snapshotState"], "incomplete")
        self.assertIn("unknown branches observed", observer.markdown(snapshot))

    def test_missing_policy_branch_and_missing_evidence_remain_unknown(self):
        snapshot = observer.collect(self.repo, policy={"evidence": {"ref": "main", "path": "missing.md"}, "lanes": [{"id": "missing", "branches": ["not-present"], "scope113": "included"}], "requiredChecks": {"missing": ["tests"]}})
        self.assertEqual(snapshot["releasePolicy"]["evidence"]["state"], "unknown")
        self.assertIsNone(snapshot["lanes"][0]["branches"][0]["sha"])
        self.assertEqual(snapshot["lanes"][0]["ciState"], "unknown")

    def test_cli_stdout_and_explicit_output_are_equivalent_views(self):
        output = self.root / "evidence.json"
        self.assertEqual(observer.main(["--repo", str(self.repo), "--output", str(output)]), 0)
        snapshot = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(snapshot["summary"], observer.summary(snapshot))
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            self.assertEqual(observer.main(["--repo", str(self.repo), "--format", "markdown"]), 0)
        self.assertIn("Release approval is not assessed", captured.getvalue())
        self.assertNotIn("100%", captured.getvalue())

    def test_policy_validation_and_untrusted_names_are_not_shell_code(self):
        policy = self.root / "policy.json"
        policy.write_text(json.dumps({"lanes": [{"id": "x", "branches": ["$(not-a-command)"], "scope113": "separate"}], "requiredChecks": {"x": None}}), encoding="utf-8")
        loaded = observer.load_policy(policy)
        snapshot = observer.collect(self.repo, policy=loaded)
        self.assertEqual(snapshot["lanes"][0]["branches"][0]["ref"], "$(not-a-command)")
        self.assertEqual(snapshot["lanes"][0]["ciState"], "unknown")
        with self.assertRaises(ValueError):
            observer.collect(self.repo, remote="--upload-pack=not-a-command")
        policy.write_text('{"requiredChecks":{"main":"success"}}', encoding="utf-8")
        with self.assertRaises(ValueError):
            observer.load_policy(policy)


if __name__ == "__main__":
    unittest.main()
