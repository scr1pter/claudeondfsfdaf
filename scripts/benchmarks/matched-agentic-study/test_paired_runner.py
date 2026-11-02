"""Pure Python controls: no HTTP server, native CLI, browser or funded port."""
import copy
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from native_team_policy import MODEL, PolicyError
from owned_team_witness import FUNDING_PHASE, OwnedSupervisor, digest
import paired_runner as runner


class Meter:
    def __init__(self):
        self.calls, self.receipts, self.controls = 0, [], []
        self.spent = {"foundry-vector": 10.0, "foundry-codex": 8.0}
        self.token, self.actor, self.label, self.remaining = None, None, None, 0
        self.fail_disarm = False

    def __call__(self, route, body=None):
        self.controls.append((route, copy.deepcopy(body)))
        if route == "/control":
            self.actor, self.remaining = body["actor"], body["calls"]
            self.label = body["label"]
            self.token = "synthetic-in-memory-token-" + str(len(self.controls))
            return {"requestToken": self.token}
        if route == "/disarm":
            if self.fail_disarm:
                raise OSError("synthetic unknown closure")
            assert body == {"requestToken": self.token}
            self.remaining = 0
        return {"limitUsd": 48, "phaseID": FUNDING_PHASE, "halted": None,
                "measuredUsd": runner.HISTORICAL_USD + sum(row["measuredUsd"] for row in self.receipts),
                "reservedUsd": 0, "active": 0, "attempts": runner.HISTORICAL_REQUESTS + self.calls,
                "batchCallsRemaining": self.remaining,
                "actors": {name: {"limitUsd": 20, "measuredUsd": amount, "reservedUsd": 0} for name, amount in self.spent.items()}}

    def forward(self, wire):
        self.calls += 1
        self.remaining -= 1
        self.spent[self.actor] += 0.01
        self.receipts.append({"actor": self.actor, "seq": runner.HISTORICAL_REQUESTS + self.calls,
                              "label": self.label,
                              "batchSha256": digest(self.token), "requestSha256": hashlib.sha256(wire).hexdigest(),
                              "measuredUsd": 0.01})


class Registry:
    def __init__(self, runtime):
        self.runtime, self.root_id, self.helper_producers = runtime, "synthetic-lead", {}

    def resolve(self, headers):
        identity = headers["identity"]
        root = identity == self.root_id
        return {"id": identity, "root": self.root_id, "role": "lead" if root else identity,
                "parent": None if root else self.root_id, "depth": 0 if root else 1,
                "identityKind": "autonomous", "helper": False, "purpose": "turn"}

    def collect(self, directory):
        directory.mkdir(parents=True, exist_ok=False)
        return {"complete": True, "sessionCount": 4, "manifestSha256": "synthetic-transcripts"}


def evaluation(verdict):
    return {"report": {"verdict": verdict, "sourceUnchanged": True,
                       "checks": [{"name": "synthetic_fixture_only", "status": "passed" if verdict == "passed" else "failed",
                                   "expected": "fixture repaired", "actual": "synthetic negative"}]}}


class Adapter:
    def __init__(self, runtime, meter, *, verdicts=("passed",), quality_review=False, fatal=False, audit_failure=False, length_incomplete=False):
        self.runtime, self.meter = runtime, meter
        self.registry = Registry(runtime)
        self.verdicts, self.quality_review = list(verdicts), quality_review
        self.fatal, self.audit_failure = fatal, audit_failure
        self.length_incomplete = length_incomplete
        self.prepared, self.quiesced, self.invocations, self.arm = False, False, [], None

    def prepare(self):
        self.prepared = True

    def bind(self, arm):
        self.arm = arm

    def run(self, prompt, session, timeout, index):
        self.invocations.append({"prompt": prompt, "session": session, "index": index})
        if self.audit_failure:
            self.arm.audit.append = lambda row: (_ for _ in ()).throw(OSError("synthetic full disk"))
        for identity in (self.registry.root_id, *runner.ROLES):
            payload = {"model": MODEL, "reasoning": {"effort": "high", "summary": "auto"},
                       "text": {"verbosity": "low"}, "input": []}
            wire, entry = self.arm.enter(payload, {"identity": identity}, lambda: False)
            self.meter.forward(wire)
            terminal = {"object": "response", "status": "failed" if self.fatal else "completed"}
            if self.length_incomplete and identity == self.registry.root_id:
                terminal.update(status="incomplete", incomplete_details={"reason": "max_output_tokens"},
                    usage={"input_tokens": 5, "output_tokens": 32000,
                           "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0}})
            self.arm.finish(entry, terminal, False, False)
            if self.arm.failure:
                break
        self.quiesced = True
        return {"exitCode": 0, "timedOut": False, "ownedTreeQuiesced": True}

    def preserve(self, index):
        return {"syntheticFixtureOnly": True, "protectedViolations": []}

    def evaluate(self, index):
        return evaluation(self.verdicts[min(index - 1, len(self.verdicts) - 1)])

    def stop(self):
        self.quiesced = True

    def audit(self, closure):
        return {"requiresManualReview": self.quality_review, "syntheticFixtureOnly": True}


class PairedRunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.common = runner.common_helpers(Path(__file__).resolve().parent.parent / "agentic-study")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.meter = Meter()
        self.holder = {}
        self.supervisor = OwnedSupervisor(self.meter, lambda: self.meter.receipts, self.directory / "private-output",
            quiesced=lambda: self.holder.get("adapter") is not None and self.holder["adapter"].quiesced)
        self.saved = []

    def tearDown(self):
        self.temp.cleanup()

    def coordinate(self, adapter, **kwargs):
        self.holder["adapter"] = adapter
        return runner.coordinate_team_arm(supervisor=self.supervisor, runtime=adapter.runtime,
            label="synthetic-free-fixture", adapter=adapter, task={}, common=self.common, check_frozen=lambda: None,
            persist=lambda row: self.saved.append(copy.deepcopy(row)), **kwargs)

    def plan(self, index=1):
        return {"label": "synthetic-free-fixture", "taskIndex": index, "sourceRevision": "synthetic-source",
                "studyFreezeSha256": "synthetic-study-freeze",
                "profileSha256": digest(runner.PROFILE), "classification": "development fixture",
                "fixedTasks": [{"name": name, "order": order, "contract": {}, "taskSha256": name} for name, order in runner.TASKS],
                "maxCalls": 300, "maxSeconds": 7200, "softUsd": 3}

    def test_full_team_cost_and_same_lead_repair_are_retained(self):
        adapter = Adapter("vector", self.meter, verdicts=("product_failure", "passed"))
        result = self.coordinate(adapter)
        self.assertEqual(result["stopReason"], "passed")
        self.assertEqual(result["providerRequests"], 8)
        self.assertAlmostEqual(result["measuredUsd"], .08)
        self.assertEqual(result["autonomousActorsAdmitted"], 4)
        self.assertEqual(set(result["receiptUsageByNativeRole"]), {"lead", *runner.ROLES})
        self.assertTrue(all(row["reconciledReceipts"] == 2 for row in result["receiptUsageByNativeRole"].values()))
        self.assertEqual(adapter.arm.repairs, 1)
        self.assertEqual(adapter.invocations[1]["session"], "synthetic-lead")
        self.assertIn("SAME three child identities", adapter.invocations[1]["prompt"])
        self.assertNotIn("using one agent", adapter.invocations[1]["prompt"])
        self.assertEqual(sum(route == "/control" for route, _ in self.meter.controls), 1)

    def test_repair_stops_after_exactly_one_and_keeps_product_failure(self):
        result = self.coordinate(Adapter("codex", self.meter, verdicts=("product_failure",)))
        self.assertEqual(result["stopReason"], "product_failure_after_one_same_session_repair")
        self.assertEqual(len(result["attempts"]), 2)
        self.assertEqual(result["functionalVerdict"], "product_failure")
        self.assertFalse(result["reviewRequired"])
        self.assertEqual(result["providerRequests"], 8)

    def test_functional_pass_cannot_clear_quality_review_or_start_second_arm(self):
        created = []
        def factory(runtime):
            created.append(runtime)
            adapter = Adapter(runtime, self.meter, quality_review=True)
            self.holder["adapter"] = adapter
            return adapter
        result = runner.run_pair(self.plan(), supervisor=self.supervisor, adapter_factory=factory,
            common=self.common, check_frozen=lambda: None, persist=lambda row: None)
        self.assertEqual(created, ["vector"])
        self.assertEqual(result["arms"]["vector"]["functionalVerdict"], "passed")
        self.assertEqual(result["arms"]["vector"]["stopReason"], "quality_review_required")
        self.assertFalse(result["pairCompleted"])
        self.assertFalse(result["efficiencyClaimMet"])

    def test_unknown_closure_retains_charges_and_blocks_second_arm(self):
        self.meter.fail_disarm = True
        adapter = Adapter("vector", self.meter)
        result = self.coordinate(adapter)
        self.assertTrue(result["reviewRequired"])
        self.assertFalse(result["settlementComplete"])
        self.assertEqual(self.meter.calls, 4)
        self.assertEqual(len(self.meter.receipts), 4)
        self.assertEqual(sum(route == "/disarm" for route, _ in self.meter.controls), 1)
        with self.assertRaises(PolicyError):
            self.supervisor.begin("codex", "synthetic-no-auto-arm", Registry("codex"), runner.ROLES)

    def test_audit_failure_forwards_zero_and_requires_review(self):
        result = self.coordinate(Adapter("vector", self.meter, audit_failure=True))
        self.assertEqual(self.meter.calls, 0)
        self.assertEqual(result["autonomousActorsAdmitted"], 0)
        self.assertTrue(result["reviewRequired"])
        self.assertNotEqual(result["stopReason"], "passed")
        self.assertEqual(result["closure"]["controllerUsageThroughClosure"]["providerRequests"], 0)

    def test_failed_terminal_stops_despite_zero_cli_exit_and_preserves_one_charge(self):
        result = self.coordinate(Adapter("codex", self.meter, fatal=True))
        self.assertTrue(result["reviewRequired"])
        self.assertEqual(result["providerRequests"], 1)
        self.assertEqual(result["stopReason"], "upstream_response_failed")
        self.assertEqual(result["functionalVerdict"], "not_run")

    def test_known_length_incomplete_allows_current_team_then_blocks_next_arm(self):
        adapter = Adapter("vector", self.meter, length_incomplete=True)
        result = self.coordinate(adapter)
        self.assertIsNone(adapter.arm.failure)
        self.assertEqual(self.meter.calls, 4)
        self.assertEqual(result["functionalVerdict"], "passed")
        self.assertTrue(result["reviewRequired"])
        self.assertEqual(result["closure"]["nonfatalReviewObservationCount"], 1)
        self.assertEqual(result["stopReason"], "closure_review_required")
        with self.assertRaises(PolicyError):
            self.supervisor.begin("codex", "synthetic-no-auto-arm", Registry("codex"), runner.ROLES)

    def test_unaffordable_arm_never_prepares_or_arms(self):
        self.meter.spent["foundry-vector"] = 15
        adapter = Adapter("vector", self.meter)
        result = self.coordinate(adapter)
        self.assertFalse(adapter.prepared)
        self.assertEqual(result["stopReason"], "unaffordable_arm_not_run")
        self.assertFalse(any(route == "/control" for route, _ in self.meter.controls))
        self.assertEqual(result["preflight"]["requiredFullQualityReservationUsd"], 5.73)

    def test_history_cannot_reset_or_be_reclassified(self):
        state = self.meter("/status")
        for field, value in (("attempts", 888), ("measuredUsd", 20.30), ("limitUsd", 49)):
            with self.subTest(field=field):
                changed = {**state, field: value}
                with self.assertRaises(PolicyError):
                    runner.preserved_history(changed)
        state["actors"]["foundry-vector"]["limitUsd"] = 21
        with self.assertRaises(PolicyError):
            runner.preserved_history(state)

    def test_exactly_one_pair_no_next_task_dispatch_and_fixed_reverse_orders(self):
        created = []
        def factory(runtime):
            created.append(runtime)
            adapter = Adapter(runtime, self.meter)
            self.holder["adapter"] = adapter
            return adapter
        result = runner.run_pair(self.plan(), supervisor=self.supervisor, adapter_factory=factory,
            common=self.common, check_frozen=lambda: None, persist=lambda row: None)
        self.assertEqual(created, ["vector", "codex"])
        self.assertTrue(result["pairCompleted"])
        self.assertFalse(result["fixedSetComplete"])
        self.assertFalse(result["automaticNextPair"])
        self.assertEqual([order for _, order in runner.TASKS], [("vector", "codex"), ("codex", "vector"), ("codex", "vector")])

    def test_review_freeze_requires_exact_clean_source_and_all_hashes(self):
        path = self.directory / "reviewed.json"
        plan = {"sourceRevision": "synthetic-commit", "sourceDirty": False, "binarySha256": {"bun": "synthetic"}}
        path.write_text(json.dumps(plan), encoding="utf-8")
        options = SimpleNamespace(reviewed_plan=path, expected_plan_sha=digest(plan), expected_source="synthetic-commit")
        runner.reviewed(plan, options)
        for changed in ({**plan, "sourceDirty": True}, {**plan, "binarySha256": {"bun": "changed"}}):
            with self.assertRaises(PolicyError):
                runner.reviewed(changed, options)

    def test_role_instruction_semantics_are_shared_and_not_single_agent(self):
        self.assertEqual(runner.PROFILE["instructions"], runner.INSTRUCTIONS)
        self.assertEqual(set(runner.PROFILE["childLifetimeSlots"]), set(runner.ROLES))
        for prose in runner.INSTRUCTIONS.values():
            self.assertIn("preserve every requirement", prose)
            self.assertIn("BROWSER_DRIVER_CLIENT", prose)
        self.assertIn("Both workers must finish", runner.INSTRUCTIONS["lead"])
        self.assertIn("personally verify the final UI", runner.INSTRUCTIONS["lead"])

    def test_native_renderers_share_exact_role_prose_and_alias_only(self):
        home = self.directory / "home"
        home.mkdir()
        binding = {"providerBase": "http://127.0.0.1:43210", "requestToken": "synthetic-alias"}
        env = runner.team_environment(self.common, "vector", {}, home, binding)
        config = json.loads(env["VECTOR_CONFIG_CONTENT"])
        self.assertEqual(config["agent"]["build"]["prompt"], runner.INSTRUCTIONS["lead"])
        for role in runner.ROLES:
            self.assertEqual(config["agent"][role]["prompt"], runner.INSTRUCTIONS[role])
            self.assertEqual(config["agent"][role]["variant"], "high")
        self.assertEqual(config["provider"]["openai"]["options"]["apiKey"], "synthetic-alias")
        self.assertEqual(runner.team_environment(self.common, "codex", {}, home, binding), {"BENCH_API_KEY": "synthetic-alias"})
        self.assertNotIn("synthetic-in-memory-token", json.dumps(config))

    def test_default_plan_never_reads_supplied_missing_private_files(self):
        roots = {name: self.directory / name for name in (
            "vector-root", "common-runner-root", "task-root", "browser-driver-root", "playwright-module")}
        for path in roots.values():
            path.mkdir()
        (roots["common-runner-root"] / "runner.py").write_text("# synthetic public fixture", encoding="utf-8")
        (roots["browser-driver-root"] / "client.cjs").write_text("// synthetic public fixture", encoding="utf-8")
        (roots["playwright-module"] / "package.json").write_text('{"version":"synthetic"}', encoding="utf-8")
        for name, _ in runner.TASKS:
            task = roots["task-root"] / name
            (task / "seed").mkdir(parents=True)
            (task / "TASK.md").write_text("Synthetic fixture only.", encoding="utf-8")
            (task / "task.json").write_text(json.dumps({"promptFile": "TASK.md", "seedDirectory": "seed",
                "evaluatorCommand": ["{python}", "synthetic-evaluator.py"]}), encoding="utf-8")
        argv = ["--label", "synthetic-plan", "--out", str(self.directory / "new-private-output")]
        for name, path in roots.items():
            argv.extend(["--" + name, str(path)])
        for name in ("bun", "node", "codex-bin", "chrome"):
            path = self.directory / (name + ".synthetic")
            path.write_bytes(b"synthetic non-executable fixture")
            argv.extend(["--" + name, str(path)])
        argv.extend(["--controller-config", str(self.directory / "missing-private-config"),
                     "--receipt-jsonl", str(self.directory / "missing-private-receipts")])
        output = io.StringIO()
        with patch.object(runner, "common_helpers", return_value=self.common), patch.object(self.common, "source_revision", return_value=("synthetic-source", False)), patch("sys.stdout", output):
            self.assertEqual(runner.main(argv), 0)
        printed = json.loads(output.getvalue())
        self.assertFalse(printed["paidExecutionRequested"])
        self.assertFalse(printed["plan"]["controllerOrCredentialFilesReadByPlan"])
        self.assertEqual(len(printed["plan"]["fixedTasks"]), 3)
        self.assertFalse((self.directory / "new-private-output").exists())

    def test_fresh_native_root_binds_once_from_owned_sqlite_before_inference(self):
        home = self.directory / "owned-native"
        path = home / "data/vector/vector.db"
        path.parent.mkdir(parents=True)
        with sqlite3.connect(path) as database:
            database.execute("CREATE TABLE session(id TEXT,parent_id TEXT,internal TEXT,agent TEXT,model TEXT,metadata TEXT)")
            database.execute("INSERT INTO session VALUES(?,?,?,?,?,?)", ("synthetic-root", None, None, "build",
                json.dumps({"id": MODEL, "providerID": "openai", "variant": "high"}), None))
        database.close()
        registry = runner.FreshOwnedRegistry("vector", home)
        rows = []
        registry.on_bind = rows.append
        native = registry.resolve({"x-session-id": "synthetic-root"})
        self.assertEqual(native["role"], "lead")
        self.assertEqual(len(rows), 1)
        registry.resolve({"x-session-id": "synthetic-root"})
        self.assertEqual(len(rows), 1)
        with self.assertRaises(PolicyError):
            registry.resolve({"x-session-id": "another-root"})

    def test_native_rollout_descendant_commands_not_root_footer(self):
        path = self.directory / "synthetic-rollout.jsonl"
        path.write_text("\n".join(json.dumps(row) for row in [
            {"type": "session_meta", "timestamp": "2026-11-01T00:00:00Z", "payload": {}},
            {"type": "response_item", "payload": {"type": "function_call", "name": "functions.exec_command",
                "call_id": "synthetic-call", "arguments": json.dumps({"cmd": "node synthetic.js"})}},
            {"type": "response_item", "payload": {"type": "function_call_output", "call_id": "synthetic-call", "output": "done"}},
            {"type": "event_msg", "timestamp": "2026-11-01T00:01:00Z", "payload": {"type": "task_complete"}},
        ]), encoding="utf-8")
        normalized = runner.normalize_transcript(path, "codex")
        self.assertEqual([row["type"] for row in normalized["events"]], ["item.started", "item.completed"])
        self.assertLess(normalized["started"], normalized["completed"])
        self.assertEqual(normalized["unknownInteractiveInputs"], 0)

    def test_descendant_quality_checks_order_root_verification_and_owned_support_ambiguity(self):
        directory, app, support = self.directory / "transcripts", self.directory / "app", self.directory / "support-data"
        for path in (directory, app, support):
            path.mkdir()
        client = self.directory / "common-browser-client.cjs"
        client.write_text("// synthetic trusted fixture", encoding="utf-8")
        script = support / "check.cjs"
        script.write_text("// synthetic owned support script", encoding="utf-8")
        slots = {role: role for role in runner.ROLES}
        def fixture(support_script=False):
            files = []
            for identity in ("synthetic-root", *runner.ROLES):
                judge = identity == "team_judge"
                rows = [{"table": "session", "row": {"time_created": 1700000003000 if judge else 1700000000000}},
                        {"table": "message", "row": {"data": json.dumps({"role": "assistant", "finish": "stop",
                            "time": {"completed": 1700000004000 if judge else 1700000010000 if identity == "synthetic-root" else 1700000002000}})}}]
                commands = [("echo synthetic-fixture", 1700000001000)]
                if identity == "synthetic-root":
                    commands = [("node $env:BROWSER_DRIVER_CLIENT --action observe", 1700000005000),
                                ("curl http://127.0.0.1:4123/api/synthetic", 1700000006000)]
                    if support_script:
                        commands.append(('node "' + str(script) + '"', 1700000007000))
                for index, (command, at) in enumerate(commands):
                    rows.append({"table": "part", "row": {"time_created": at, "data": json.dumps({"id": str(index),
                        "type": "tool", "tool": "bash", "state": {"status": "completed", "input": {"command": command},
                        "time": {"start": at, "end": at + 1}}})}})
                name = hashlib.sha256(identity.encode()).hexdigest() + ".jsonl"
                path = directory / name
                path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
                files.append({"file": name, "identitySha256": name[:-6], "sha256": self.common.file_hash(path)})
            (directory / "manifest.json").write_text(json.dumps({"complete": True, "runtime": "vector", "files": files}), encoding="utf-8")
        fixture()
        quality = runner.audit_descendants(self.common, "vector", directory, app, support, client, slots, "synthetic-root")
        self.assertTrue(quality["judgeStartedAfterBothWorkersCompleted"])
        self.assertTrue(quality["rootPostJudgeCommonBrowserCommandObserved"])
        self.assertTrue(quality["rootPostJudgeApiVerificationCommandObserved"])
        self.assertFalse(quality["requiresManualReview"])
        fixture(support_script=True)
        quality = runner.audit_descendants(self.common, "vector", directory, app, support, client, slots, "synthetic-root")
        self.assertTrue(quality["requiresManualReview"])
        self.assertEqual(quality["ownedSupportDataFiles"], 1)

    def test_prearm_prepare_failure_is_persisted_without_control_or_model_call(self):
        adapter = Adapter("vector", self.meter)
        adapter.prepare = lambda: (_ for _ in ()).throw(OSError("synthetic setup failure"))
        result = self.coordinate(adapter)
        self.assertTrue(result["reviewRequired"])
        self.assertEqual(result["stopReason"], "runner_or_native_protocol_failure")
        self.assertFalse(any(route == "/control" for route, _ in self.meter.controls))
        self.assertEqual(self.saved[-1]["failureType"], "OSError")


if __name__ == "__main__":
    unittest.main()
