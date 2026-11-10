"""Synthetic native SQLite and in-memory funding controls; no runtime/services."""
import copy
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest

import codex_resume
import qualify_resume

TEAM = Path(__file__).resolve().parents[1] / "matched-agentic-study"
sys.path.insert(0, str(TEAM))
import heavy_runner
from native_registry import NativeRegistry
from native_team_policy import PolicyError
from owned_team_witness import healthy, OwnedSupervisor
import paired_runner
from test_heavy_runner import HeavyAdapter, HeavyMeter
from test_heavy_funding_profile import state as funding_state


def baseline():
    value = funding_state()
    value.update(attempts=1198, measuredUsd=27.2338604, batchCallsRemaining=0)
    value["actors"]["foundry-vector"]["measuredUsd"] = 17.6761006
    value["actors"]["foundry-codex"]["measuredUsd"] = 6.6139917
    return value


def native_fixture(root):
    codex = root / "codex"
    codex.mkdir(parents=True)
    ids = {role: "labelled-synthetic-" + role for role in ("lead", "backend_coordinator", "frontend_worker")}
    with closing(sqlite3.connect(codex / "state_5.sqlite")) as connection, connection:
        connection.executescript("CREATE TABLE threads(id TEXT,source TEXT,thread_source TEXT,agent_role TEXT,agent_path TEXT,model TEXT,reasoning_effort TEXT,model_provider TEXT,rollout_path TEXT,archived INTEGER); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT)")
        for role, identity in ids.items():
            path = codex / (role + ".jsonl")
            path.write_text("labelled synthetic retained bytes\n")
            source = "exec" if role == "lead" else json.dumps({"subagent": {"thread_spawn": {
                "parent_thread_id": ids["lead"], "depth": 1, "agent_role": role, "agent_path": "/root/" + role}}})
            connection.execute("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)", (identity, source,
                "user" if role == "lead" else "subagent", None if role == "lead" else role,
                None if role == "lead" else "/root/" + role, "gpt-6.1-sol", "high", "benchmark", str(path), 0))
            if role != "lead":
                connection.execute("INSERT INTO thread_spawn_edges VALUES(?,?,?)", (ids["lead"], identity, "open"))
    with closing(sqlite3.connect(codex / "thread_history_1.sqlite")) as connection, connection:
        connection.executescript("CREATE TABLE thread_turns(thread_id TEXT,status TEXT); CREATE TABLE thread_history_projection_state(thread_id TEXT,next_rollout_byte_offset INTEGER)")
        for role, identity in ids.items():
            connection.execute("INSERT INTO thread_turns VALUES(?,?)", (identity, "failed"))
            connection.execute("INSERT INTO thread_history_projection_state VALUES(?,?)", (identity, (codex / (role + ".jsonl")).stat().st_size))
    for name, table in (("queue_1.sqlite", "queued_items"), ("goals_1.sqlite", "thread_goals"), ("memories_1.sqlite", "jobs")):
        with closing(sqlite3.connect(codex / name)) as connection, connection:
            connection.execute("CREATE TABLE " + table + "(id TEXT)")
    registry = NativeRegistry("codex", root, codex / "state_5.sqlite", None, "benchmark", max_depth=2)
    return registry, ids


class ResumeMeter(HeavyMeter):
    def __init__(self):
        super().__init__()
        self.spent = {"foundry-vector": 17.6761006, "foundry-codex": 6.6139917}

    def __call__(self, route, body=None):
        value = super().__call__(route, body)
        if route != "/control":
            value.update(attempts=1198 + self.calls,
                         measuredUsd=27.2338604 + sum(row["measuredUsd"] for row in self.receipts))
        return value

    def forward(self, wire):
        super().forward(wire)
        self.receipts[-1]["seq"] = 1198 + self.calls


class ResumeTests(unittest.TestCase):
    def test_exact_baseline_accepts_roundoff_and_rejects_any_new_usage(self):
        value = baseline()
        value["measuredUsd"] -= 1e-14
        self.assertIs(codex_resume.validate_baseline(value, healthy, heavy_runner.FUNDING.phase), value)
        for field in ("attempts", "measuredUsd", "foundry-vector", "foundry-codex", "active", "batchCallsRemaining"):
            value = baseline()
            if field in ("foundry-vector", "foundry-codex"):
                value["actors"][field]["measuredUsd"] += .000001
                value["measuredUsd"] += .000001
            else:
                value[field] += 1 if field != "measuredUsd" else .000001
            with self.subTest(field=field), self.assertRaises((ValueError, PolicyError)):
                codex_resume.validate_baseline(value, healthy, heavy_runner.FUNDING.phase)

    def test_one_291_call_mutation_and_ambiguous_response_never_retried(self):
        calls = []
        def controller(route, body=None):
            calls.append((route, body))
            if route == "/status":
                return baseline()
            raise OSError("labelled synthetic ambiguous admission")
        guarded = codex_resume.ResumeController(controller, healthy, heavy_runner.FUNDING.phase, "synthetic-resume")
        for actor, count in (("foundry-vector", 291), ("foundry-codex", 300), ("foundry-codex", 292)):
            with self.assertRaises(ValueError):
                guarded("/control", {"actor": actor, "calls": count, "label": guarded.label})
        body = {"actor": "foundry-codex", "calls": 291, "label": guarded.label}
        with self.assertRaises(OSError):
            guarded("/control", body)
        with self.assertRaises(ValueError):
            guarded("/control", body)
        self.assertEqual(sum(route == "/control" for route, _ in calls), 1)

    def test_native_metadata_restores_exact_root_and_two_lifetime_slots(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            registry, ids = native_fixture(root)
            expected = {role: codex_resume.digest_id(identity) for role, identity in ids.items()}
            identities, slots = codex_resume.native_state(root, registry, expected)
            self.assertEqual(identities, ids)
            self.assertEqual(set(slots), {"backend_coordinator", "frontend_worker"})
            self.assertEqual(registry.root_id, ids["lead"])

    def test_changed_provider_depth_role_edge_archival_or_extra_identity_fails_closed(self):
        mutations = ["UPDATE threads SET model_provider='other' WHERE agent_role IS NOT NULL",
            "UPDATE threads SET agent_role='backend_api' WHERE agent_role='frontend_worker'",
            "UPDATE threads SET archived=1 WHERE agent_role='frontend_worker'",
            "UPDATE threads SET source=replace(source, '\"depth\": 1', '\"depth\": 2') WHERE agent_role='frontend_worker'",
            "DELETE FROM thread_spawn_edges WHERE child_thread_id LIKE '%frontend_worker'",
            "UPDATE thread_spawn_edges SET status='closed'", "INSERT INTO threads SELECT * FROM threads LIMIT 1"]
        for mutation in mutations:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                registry, ids = native_fixture(root)
                with closing(sqlite3.connect(registry.database)) as connection, connection:
                    connection.execute(mutation)
                with self.assertRaises((ValueError, PolicyError)):
                    codex_resume.native_state(root, registry, {role: codex_resume.digest_id(identity) for role, identity in ids.items()})

    def test_unknown_native_work_projection_or_failed_phase_is_refused(self):
        for database, mutation in (("queue_1.sqlite", "INSERT INTO queued_items VALUES('synthetic')"),
                ("thread_history_1.sqlite", "UPDATE thread_turns SET status='running'"),
                ("thread_history_1.sqlite", "UPDATE thread_history_projection_state SET next_rollout_byte_offset=0")):
            with self.subTest(database=database), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                registry, ids = native_fixture(root)
                with closing(sqlite3.connect(root / "codex" / database)) as connection, connection:
                    connection.execute(mutation)
                with self.assertRaises(ValueError):
                    codex_resume.native_state(root, registry, {role: codex_resume.digest_id(identity) for role, identity in ids.items()})

    def test_exact_stopped_fixture_map_is_explicit_and_never_relaxes_real_guard(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            registry, ids = native_fixture(root)
            expected = {role: codex_resume.digest_id(identity) for role, identity in ids.items()}
            with closing(sqlite3.connect(root / "codex/thread_history_1.sqlite")) as connection, connection:
                connection.execute("ALTER TABLE thread_turns ADD COLUMN rollout_ordinal INTEGER DEFAULT 0")
                connection.execute("UPDATE thread_turns SET status='completed' WHERE thread_id!=?", (ids["lead"],))
                connection.execute("INSERT INTO thread_turns VALUES(?,?,?)", (ids["backend_coordinator"], "interrupted", 1))
                connection.execute("INSERT INTO thread_turns VALUES(?,?,?)", (ids["frontend_worker"], "failed", 1))
            with self.assertRaisesRegex(ValueError, "retained failed phase"):
                codex_resume.native_state(root, registry, expected)
            self.assertEqual(codex_resume.native_state(root, registry, expected,
                fixture_latest_outcomes=codex_resume.FIXTURE_OUTCOMES)[0], ids)
            changed = {**codex_resume.FIXTURE_OUTCOMES, "frontend_worker": "interrupted"}
            with self.assertRaises(ValueError):
                codex_resume.native_state(root, registry, expected, fixture_latest_outcomes=changed)

    def test_archive_includes_dependencies_and_sidecars_and_detects_source_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old, out = root / "old", root / "new"
            for name in ("runtime-home", "app", "support-data"):
                (old / name / "node_modules").mkdir(parents=True)
                (old / name / "node_modules/native.sqlite-wal").write_bytes(b"labelled synthetic sidecar")
            expected = {name: codex_resume.exact_tree(old / name) for name in ("runtime-home", "app", "support-data")}
            record = codex_resume.archive_state(old, out, expected)
            self.assertTrue(record["archiveBeforeAdoptionVerified"])
            self.assertTrue((out / "pre-adoption-archive/app/node_modules/native.sqlite-wal").is_file())
            verified = codex_resume.validate_archive(out / "pre-adoption-archive/manifest.json", old, expected)
            self.assertTrue(verified["archiveBeforeAdoptionVerified"])
            (old / "app/node_modules/native.sqlite-wal").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "source changed"):
                codex_resume.validate_archive(out / "pre-adoption-archive/manifest.json", old, expected)
            self.assertEqual(codex_resume.validate_archive(out / "pre-adoption-archive/manifest.json", old, expected, check_source=False), verified)
            (out / "pre-adoption-archive/app/node_modules/native.sqlite-wal").write_bytes(b"changed archive")
            with self.assertRaisesRegex(ValueError, "archive bytes changed"):
                codex_resume.validate_archive(out / "pre-adoption-archive/manifest.json", old, expected, check_source=False)
            with self.assertRaisesRegex(ValueError, "changed before archive"):
                codex_resume.archive_state(old, root / "another", expected)

    @unittest.skipUnless(sys.platform == "win32", "Windows Bun cache uses directory junctions")
    def test_owned_cache_junction_metadata_is_archived_without_live_links(self):
        import _winapi
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = root / "old"
            home = old / "runtime-home"
            target = home / "cache/.bun/install/cache/labelled-fixture@1"
            target.mkdir(parents=True)
            (target / "index.js").write_text("labelled synthetic package")
            link = target.parent / "labelled-fixture" / "1"
            link.parent.mkdir()
            _winapi.CreateJunction(str(target), str(link))
            files = codex_resume.exact_tree(home)
            self.assertEqual(files[link.relative_to(home).as_posix()], {
                "kind": "owned_bun_cache_junction", "targetRelative": target.relative_to(home).as_posix()})
            codex_resume.archive_state(old, root / "out", {"runtime-home": files})
            archived = root / "out/pre-adoption-archive/runtime-home"
            self.assertFalse((archived / link.relative_to(home)).exists())
            self.assertTrue((archived / target.relative_to(home) / "index.js").is_file())
            escaped = home / "cache/.bun/install/cache/escaped"
            _winapi.CreateJunction(str(root), str(escaped))
            with self.assertRaisesRegex(ValueError, "escaped"):
                codex_resume.exact_tree(home)

    def test_real_admission_policy_preserves_old_slots_and_rejects_replacements(self):
        with tempfile.TemporaryDirectory() as temporary:
            meter = ResumeMeter()
            adapter = HeavyAdapter("codex", meter)
            supervisor = OwnedSupervisor(meter, lambda: meter.receipts, Path(temporary), funding_profile=heavy_runner.FUNDING.phase)
            arm = supervisor.begin("codex", "synthetic-adoption", adapter.registry, codex_resume.ROLES,
                role_parents=heavy_runner.HEAVY_ROLE_PARENTS, max_calls=291, seconds=7162.344, soft_usd=13.84808545-.1423925)
            ids = {"lead": adapter.registry.root_id, "backend_coordinator": "backend_coordinator", "frontend_worker": "frontend_worker"}
            slots = {role: ids[role] for role in ("backend_coordinator", "frontend_worker")}
            codex_resume.seed_lifetime_slots(arm, ids, slots)
            native = adapter.registry.resolve({"identity": "frontend_worker"})
            arm.profile.admit(native, arm.registry.root_id, arm.slots)
            native["id"] = "labelled-synthetic-replacement"
            with self.assertRaises(PolicyError):
                arm.profile.admit(native, arm.registry.root_id, arm.slots)
            self.assertEqual(arm.slots, slots)
            self.assertEqual(len(arm.admitted_ids), 3)

    def test_real_supervisor_resume_keeps_initial_failure_and_all_charges(self):
        common = paired_runner.common_helpers(TEAM.parent / "agentic-study")
        with tempfile.TemporaryDirectory() as temporary:
            meter = ResumeMeter()
            adapter = HeavyAdapter("codex", meter, verdicts=("product_failure", "passed"))
            adapter.task = {}
            supervisor = OwnedSupervisor(meter, lambda: meter.receipts, Path(temporary),
                quiesced=lambda: adapter.quiesced, funding_profile=heavy_runner.FUNDING.phase)
            ids = {"lead": adapter.registry.root_id, "backend_coordinator": "backend_coordinator", "frontend_worker": "frontend_worker"}
            old = {"reviewRequired": True, "providerRequests": 9, "measuredUsd": .1423925, "stopReason": "forwarded_client_cancelled"}
            saved = []
            result = codex_resume.run_adopted({"newLabel": "synthetic-adoption", "deadlineChoice": "synthetic-explicit-choice"},
                {"arms": {"vector": {"reviewRequired": True}}}, old, supervisor=supervisor, adapter=adapter, common=common,
                team=paired_runner, profile=heavy_runner.PROFILE, identities=ids,
                slots={role: ids[role] for role in ("backend_coordinator", "frontend_worker")}, check_frozen=lambda: None,
                persist=lambda value: saved.append(copy.deepcopy(value)))
            self.assertEqual(result["originalCodexAttempt"], old)
            self.assertEqual(result["newProviderRequests"], 14)
            self.assertEqual(result["providerRequests"], 23)
            self.assertAlmostEqual(result["measuredUsd"], .2823925)
            self.assertEqual(result["formalRepairCount"], 1)
            self.assertTrue(result["reviewRequired"])
            self.assertTrue(result["historicalReviewRequired"])
            self.assertFalse(result["efficiencyClaimMet"])
            self.assertFalse(adapter.prepared)
            self.assertEqual([row["session"] for row in adapter.invocations], [ids["lead"], ids["lead"]])
            self.assertEqual(adapter.arm.max_calls, 291)
            self.assertAlmostEqual(adapter.arm.soft_usd, 13.84808545-.1423925)
            self.assertTrue(result["settlementComplete"])
            self.assertTrue(saved)

    def qualification_fixture(self, root):
        evidence = root / "sanitized-evidence.json"
        evidence.write_text('{"labelledSyntheticFixture":true}\n')
        flags = ("qualificationPassed", "oldWitnessClosed", "newWitnessEndpoint", "newAliasObserved", "rootIdentityPreserved",
            "existingChildIdentitiesPreserved", "noReplacementChildren", "codeModePreserved", "allSolHighAutoLow",
            "aliasOnly", "receiptJoinComplete", "archiveBeforeAdoptionVerified", "initialFailureRetainedSeparately", "historicalReviewRequired")
        value = {"kind": "heavy-codex-partial-resume-qualification-v1", **{key: True for key in flags},
            "binarySha256": "synthetic-binary", "witnessInstrumentSha256": "synthetic-instrument",
            "witnessCodeRevision": codex_resume.WITNESS_CODE_REVISION,
            "realProviderCalls": 0, "fundedMeterCalls": 0, "BunRuns": 0, "ChromeRuns": 0,
            "beforeRoles": ["lead", "backend_coordinator", "frontend_worker"],
            "beforeLatestOutcomes": copy.deepcopy(codex_resume.FIXTURE_OUTCOMES),
            "afterRoles": ["lead", *codex_resume.ROLES], "maximumNativeDepth": 2,
            "phases": [{"phase": "initial_failed_fixture", "forwardedCalls": 5, "knownReceiptCount": 5,
                        "measuredUsd": .05, "latestOutcome": "failed", "reviewRequired": True},
                       {"phase": "new_binding_resume", "forwardedCalls": 12, "knownReceiptCount": 12,
                        "measuredUsd": .12, "latestOutcome": "completed", "reviewRequired": False}],
            "cumulativeCalls": 17, "formalRepairCount": 0,
            "evidenceFiles": {evidence.name: codex_resume.file_hash(evidence)}}
        path = root / "qualification.json"
        path.write_text(json.dumps(value))
        return path, value

    def test_qualification_requires_failed_phase_new_binding_and_known_receipts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path, value = self.qualification_fixture(root)
            result = codex_resume.qualification(path, "synthetic-binary", "synthetic-instrument")
            self.assertEqual(result["sha256"], codex_resume.file_hash(path))
            for field in ("archiveBeforeAdoptionVerified", "initialFailureRetainedSeparately", "newAliasObserved", "codeModePreserved"):
                changed = copy.deepcopy(value)
                changed[field] = False
                path.write_text(json.dumps(changed))
                with self.subTest(field=field), self.assertRaises(ValueError):
                    codex_resume.qualification(path, "synthetic-binary", "synthetic-instrument")
            for mutation in (lambda d: d["phases"][0].update(latestOutcome="completed"),
                    lambda d: d["phases"][1].update(knownReceiptCount=11),
                    lambda d: d.update(formalRepairCount=2), lambda d: d.update(formalRepairCount=True),
                    lambda d: d["beforeLatestOutcomes"].update(backend_coordinator="failed"),
                    lambda d: d.update(cumulativeCalls=301), lambda d: d.update(unreviewedExtra=True)):
                changed = copy.deepcopy(value)
                mutation(changed)
                path.write_text(json.dumps(changed))
                with self.assertRaises(ValueError):
                    codex_resume.qualification(path, "synthetic-binary", "synthetic-instrument")

    def test_qualification_tampered_evidence_and_wrong_binary_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path, value = self.qualification_fixture(root)
            with self.assertRaises(ValueError):
                codex_resume.qualification(path, "changed-binary", "synthetic-instrument")
            (root / "sanitized-evidence.json").write_text("changed")
            with self.assertRaises(ValueError):
                codex_resume.qualification(path, "synthetic-binary", "synthetic-instrument")

    def test_free_script_follows_existing_children_and_only_coordinator_creates_leaves(self):
        from codex_free_probe import named_tool
        meter = qualify_resume.FreeMeter.__new__(qualify_resume.FreeMeter)
        meter.stages = {}
        meter.tools = SimpleNamespace(named_tool=named_tool)
        meter.complete = lambda roles: True
        tools = [{"type": "namespace", "name": "collaboration", "tools": [
            {"type": "function", "name": name} for name in ("spawn_agent", "followup_task", "wait_agent")]}]
        meter.phase = 1
        first = meter.script({"role": "lead"}, tools)
        self.assertEqual([json.loads(call["arguments"])["agent_type"] for call in first], ["backend_coordinator", "frontend_worker"])
        self.assertEqual(meter.script({"role": "frontend_worker"}, tools), [])
        self.assertIsNone(meter.script({"role": "frontend_worker"}, tools))
        followup = meter.script({"role": "lead"}, tools)
        self.assertTrue(all(call["name"] == "followup_task" for call in followup))
        meter.phase = 2
        followup = meter.script({"role": "lead"}, tools)
        self.assertEqual([json.loads(call["arguments"])["target"] for call in followup], ["/root/backend_coordinator", "/root/frontend_worker"])
        nested = meter.script({"role": "backend_coordinator"}, tools)
        self.assertEqual([json.loads(call["arguments"])["agent_type"] for call in nested], ["backend_api", "backend_data"])
        self.assertEqual(meter.script({"role": "backend_api"}, tools), [])
        self.assertEqual(meter.script({"role": "backend_data"}, tools), [])


if __name__ == "__main__":
    unittest.main()
