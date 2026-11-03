"""Pure heavy-runner controls: no HTTP, native runtimes, browser or funded state."""
import copy
from datetime import datetime, timezone
import hashlib
import json
import sqlite3
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from funding_profiles import HEAVY_PHASE
from native_team_policy import MODEL, PolicyError
from owned_team_witness import OwnedSupervisor, digest
from test_heavy_funding_profile import state as funding_state
from test_paired_runner import Adapter, Meter
import heavy_runner as heavy
import heavy_adapter_smoke as smoke
import paired_runner as runner


class HeavyMeter(Meter):
    def __init__(self):
        super().__init__()
        self.spent = {"foundry-vector": 10.8884618, "foundry-codex": 6.4715992}

    def __call__(self, route, body=None):
        original = super().__call__(route, body)
        if route == "/control":
            return original
        result = funding_state()
        result.update(attempts=889 + self.calls, measuredUsd=20.3038291 + sum(row["measuredUsd"] for row in self.receipts),
                      batchCallsRemaining=self.remaining)
        for actor, spent in self.spent.items():
            result["actors"][actor]["measuredUsd"] = spent
        return result


class Registry:
    def __init__(self, runtime):
        self.runtime, self.root_id, self.max_depth = runtime, "synthetic-lead", 2

    def resolve(self, headers):
        identity = headers["identity"]
        role = "lead" if identity == self.root_id else identity
        parent_role = heavy.HEAVY_ROLE_PARENTS.get(role)
        return {"id": identity, "root": self.root_id, "role": role,
                "parent": self.root_id if parent_role == "lead" else parent_role,
                "parentRole": parent_role, "depth": 0 if role == "lead" else 2 if parent_role == "backend_coordinator" else 1,
                "identityKind": "autonomous", "helper": False, "purpose": "turn"}

    def collect(self, destination):
        destination.mkdir(parents=True)
        return {"complete": True, "sessionCount": 7, "manifestSha256": "synthetic"}


class HeavyAdapter(Adapter):
    def __init__(self, runtime, meter, **options):
        super().__init__(runtime, meter, **options)
        self.registry = Registry(runtime)

    def run(self, prompt, session, timeout, index):
        self.invocations.append({"prompt": prompt, "session": session, "index": index})
        for identity in (self.registry.root_id, *heavy.HEAVY_ROLES):
            wire, entry = self.arm.enter({"model": MODEL, "reasoning": {"effort": "high"}, "input": []},
                                         {"identity": identity}, lambda: False)
            self.meter.forward(wire)
            self.arm.finish(entry, {"object": "response", "status": "completed"}, False, False)
        self.quiesced = True
        return {"exitCode": 0, "timedOut": False, "ownedTreeQuiesced": True}


class HeavyRunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.common = runner.common_helpers(Path(__file__).resolve().parent.parent / "agentic-study")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.meter = HeavyMeter()
        self.holder = {}
        self.supervisor = OwnedSupervisor(self.meter, lambda: self.meter.receipts, self.directory / "output",
            funding_profile=HEAVY_PHASE, quiesced=lambda: self.holder["adapter"].quiesced)

    def tearDown(self):
        self.temp.cleanup()

    def fake_script(self, runtime, round_index=1):
        meter = smoke.FakeMeter.__new__(smoke.FakeMeter)
        meter.child_stages = {}
        meter.role_row = lambda adapter, role: {"id": "synthetic-" + role, "agent_path": "/root/" + role}
        meter.completions = lambda adapter, role: round_index
        adapter = SimpleNamespace(runtime=runtime, smoke_invocation=round_index, options=SimpleNamespace(app_port=4123))
        tools = [{"type": "function", "name": name} for name in ("task", "task_manage", "bash", "read", "spawn_agent", "wait_agent", "followup_task")]
        tools.append({"type": "namespace", "name": "functions", "tools": [{"type": "custom", "name": "exec"}]})
        return meter, adapter, tools

    def test_background_evidence_recognizes_attributed_owned_notification_tag(self):
        path = self.directory / "synthetic-vector.db"
        connection = sqlite3.connect(path)
        connection.execute("CREATE TABLE part(session_id TEXT,data TEXT)")
        rows = [{"type": "tool", "tool": "task", "state": {"input": {"background": True}}},
                {"type": "text", "text": '<task-notification task_id="synthetic">fixture</task-notification>'},
                {"type": "text", "text": '<\\task-notification task_id="untrusted">escaped</task-notification>'}]
        connection.executemany("INSERT INTO part VALUES(?,?)", [("synthetic-root", json.dumps(row)) for row in rows])
        connection.commit(); connection.close()
        adapter = SimpleNamespace(runtime="vector", registry=SimpleNamespace(root_id="synthetic-root", connect=lambda: sqlite3.connect(path)))
        evidence = smoke.vector_background_evidence(adapter)
        self.assertEqual(evidence["backgroundTaskLaunches"], 1)
        self.assertEqual(evidence["ownedCompletionNotifications"], 1)

    def test_actual_vector_fake_script_exercises_background_and_same_child_repair(self):
        meter, adapter, tools = self.fake_script("vector")
        lead = {"role": "lead", "id": "synthetic-lead"}
        first = json.loads(meter.next_calls(adapter, lead, tools)[0]["arguments"])
        self.assertEqual(first["tasks"][0]["subagent_type"], "backend_coordinator")
        self.assertFalse(first["background"])
        background = json.loads(meter.next_calls(adapter, lead, tools)[0]["arguments"])
        self.assertEqual(background["tasks"][0]["subagent_type"], "frontend_worker")
        self.assertTrue(background["background"])
        waiting = json.loads(meter.next_calls(adapter, lead, tools)[0]["arguments"])
        self.assertEqual(waiting["action"], "wait")
        self.assertEqual(waiting["mode"], "all")
        adapter.smoke_invocation = 2
        continuation = json.loads(meter.next_calls(adapter, lead, tools)[0]["arguments"])
        self.assertEqual(continuation["tasks"][0]["task_id"], "synthetic-qa_specialist")
        self.assertEqual(continuation["tasks"][0]["subagent_type"], "qa_specialist")

    def test_actual_nested_fake_script_gives_leaves_to_coordinator_only(self):
        for runtime in ("vector", "codex"):
            meter, adapter, tools = self.fake_script(runtime)
            calls = meter.next_calls(adapter, {"role": "backend_coordinator", "id": "synthetic-coordinator"}, tools)
            if runtime == "vector":
                roles = [row["subagent_type"] for row in json.loads(calls[0]["arguments"])["tasks"]]
            else:
                roles = [json.loads(call["arguments"])["agent_type"] for call in calls]
            self.assertEqual(roles, ["backend_api", "backend_data"])

    def test_native_codex_fake_script_waits_for_both_nested_completions(self):
        meter, adapter, tools = self.fake_script("codex")
        coordinator = {"role": "backend_coordinator", "id": "synthetic-coordinator"}
        meter.next_calls(adapter, coordinator, tools)
        meter.completions = lambda adapter, role: 0
        self.assertEqual(meter.next_calls(adapter, coordinator, tools)[0]["name"], "wait_agent")
        meter.completions = lambda adapter, role: 1
        self.assertEqual(meter.next_calls(adapter, coordinator, tools)[0]["type"], "custom_tool_call")

    def test_full_seven_role_same_lead_repair_retains_all_costs_and_external_quality_review(self):
        adapter = HeavyAdapter("vector", self.meter, verdicts=("product_failure", "passed"))
        self.holder["adapter"] = adapter
        result = runner.coordinate_team_arm(supervisor=self.supervisor, runtime="vector", label="synthetic-heavy",
            adapter=adapter, task={}, common=self.common, check_frozen=lambda: None, persist=lambda value: None,
            profile=heavy.PROFILE, soft_usd=heavy.FUNDING.repair_threshold_usd)
        self.assertEqual(result["providerRequests"], 14)
        self.assertAlmostEqual(result["measuredUsd"], .14)
        self.assertEqual(result["autonomousActorsAdmitted"], 7)
        self.assertEqual(result["stopReason"], "passed")
        self.assertIn("SAME six child identities", adapter.invocations[1]["prompt"])
        self.assertEqual(adapter.invocations[1]["session"], "synthetic-lead")
        self.assertFalse(result["qualityComparisonMet"])
        self.assertEqual(result["blindedCodeReviewVerdict"], "pending_external_review")

    def test_heavy_preflight_requires_exact_new_finance_profile(self):
        state = self.meter("/status")
        self.assertTrue(runner.affordability(state, "vector", funding_profile=HEAVY_PHASE)["affordable"])
        with self.assertRaises(PolicyError):
            runner.affordability(state, "vector")
        changed = copy.deepcopy(state)
        changed["actors"]["foundry-vector"]["limitUsd"] += .01
        with self.assertRaises(PolicyError):
            runner.affordability(changed, "vector", funding_profile=HEAVY_PHASE)

    def test_heavy_commands_keep_capabilities_and_pin_all_six_children(self):
        options = SimpleNamespace(bun=self.directory / "bun", codex_bin=self.directory / "codex", vector_root=self.directory)
        binding = {"providerBase": "http://127.0.0.1:43210", "requestToken": "synthetic-alias"}
        home = self.directory / "home"
        screenshots = home.parent / "browser-driver/screenshots"
        env = runner.team_environment(self.common, "vector", {}, home, binding, profile=heavy.PROFILE, screenshot_directory=screenshots)
        config = json.loads(env["VECTOR_CONFIG_CONTENT"])
        self.assertNotIn("budget", config)
        self.assertEqual(config["permission"]["external_directory"], {"*": "deny", str(screenshots.resolve() / "*"): "allow"})
        with self.assertRaises(PolicyError):
            runner.team_environment(self.common, "vector", {}, home, binding, profile=heavy.PROFILE, screenshot_directory=home.parent)
        coordinator = config["agent"]["backend_coordinator"]["permission"]["task"]
        self.assertEqual(coordinator, {"*": "deny", "backend_api": "allow", "backend_data": "allow"})
        self.assertEqual(config["agent"]["backend_api"]["permission"]["task"], "deny")
        for role in heavy.HEAVY_ROLES:
            self.assertEqual(config["agent"][role]["prompt"], heavy.INSTRUCTIONS[role])
            self.assertEqual(config["agent"][role]["variant"], "high")
        command = runner.native_command(self.common, "codex", options, self.directory / "app", home, binding,
                                        "Synthetic fixture only", None, 300, profile=heavy.PROFILE)
        self.assertIn("agents.max_threads=6", command)
        self.assertFalse(any("code_mode" in arg for arg in command))
        self.assertNotIn("--max-cost", command)
        self.assertEqual(sum(arg.startswith("agents.") and ".config_file=" in arg for arg in command), 6)

    def test_heavy_gate_preserves_all_76_checks_and_workspace_prompt(self):
        report = {"verdict": "product_failure", "sourceUnchanged": True,
                  "checks": [{"name": "synthetic-" + str(index), "status": "failed", "actual": "fixture"} for index in range(76)]}
        task = {"expectedApiGroups": 32, "expectedBrowserChecks": 40, "expectedPrerequisiteChecks": 4,
                "workspacePromptFile": "BUILD_SPEC.md"}
        verdict, feedback = runner.gate_report(self.common, {"report": report}, task, profile=heavy.PROFILE)
        self.assertEqual(verdict, "product_failure")
        self.assertIn("BUILD_SPEC.md", feedback)
        self.assertIn("SAME six child identities", feedback)
        report["checks"].pop()
        self.assertEqual(runner.gate_report(self.common, {"report": report}, task, profile=heavy.PROFILE)[0], "instrument_failure")

    def test_single_heavy_pair_counts_both_arms_without_claiming_semantic_quality(self):
        plan = {"classification": "synthetic", "sourceRevision": "synthetic", "label": "synthetic-heavy",
                "order": ["vector", "codex"], "task": {}, "maxCalls": 300, "maxSeconds": 7200,
                "softUsd": heavy.FUNDING.repair_threshold_usd}
        def factory(runtime):
            adapter = HeavyAdapter(runtime, self.meter)
            self.holder["adapter"] = adapter
            return adapter
        result = heavy.run_pair(plan, supervisor=self.supervisor, adapter_factory=factory, common=self.common,
                                check_frozen=lambda: None, persist=lambda value: None)
        self.assertTrue(result["pairCompleted"])
        self.assertTrue(result["productGateMet"])
        self.assertFalse(result["qualityComparisonMet"])
        self.assertFalse(result["efficiencyClaimMet"])
        self.assertFalse(result["automaticNextPair"])

    def native_fixture(self, *, coordinator_end=8, qa_start=10, judge_start=13, repair=False, recheck=True, formal_repair=True):
        """Observed native Codex record schemas with labelled synthetic timestamps."""
        directory = self.directory / "transcripts"
        directory.mkdir()
        base = 1793577600
        def stamp(seconds):
            return datetime.fromtimestamp(base + seconds, tz=timezone.utc).isoformat()
        phases = {"lead": [(0, 20)], "backend_coordinator": [(1, coordinator_end)], "backend_api": [(2, 5)],
                  "backend_data": [(2, 5)], "frontend_worker": [(1, 7)], "qa_specialist": [(qa_start, 12)],
                  "team_judge": [(judge_start, 15)]}
        if repair:
            phases["lead"].append((30, 50))
            if recheck:
                phases["qa_specialist"].append((33, 35))
                phases["team_judge"].append((36, 38))
        files = []
        for role, turns in phases.items():
            rows = [{"timestamp": stamp(turns[0][0]), "type": "session_meta", "payload": {}}]
            for index, (start, end) in enumerate(turns):
                rows.append({"timestamp": stamp(start), "type": "event_msg", "payload": {"type": "task_started"}})
                command_time = (39 if repair and index == 1 else 16) if role == "lead" else start + .1
                command = ("Invoke-RestMethod http://127.0.0.1:4123/api/health; & $env:NODE_EXE $env:BROWSER_DRIVER_CLIENT --endpoint $env:BROWSER_DRIVER_ENDPOINT '{\"action\":\"observe\"}'"
                           if role == "lead" else "Write-Output synthetic-fixture")
                rows.append({"timestamp": stamp(command_time + .1), "type": "event_msg", "payload": {"type": "item_completed",
                    "started_at_ms": (base + command_time) * 1000, "completed_at_ms": (base + command_time + .1) * 1000,
                    "item": {"type": "CommandExecution", "id": role + str(index), "command": ["pwsh.exe", "-Command", command],
                             "status": "completed", "exit_code": 0}}})
                rows.append({"timestamp": stamp(end), "type": "event_msg", "payload": {"type": "task_complete"}})
            content = "".join(json.dumps(row) + "\n" for row in rows).encode()
            identity = "synthetic-root" if role == "lead" else role
            key = hashlib.sha256(identity.encode()).hexdigest()
            name = key + ".jsonl"
            (directory / name).write_bytes(content)
            files.append({"file": name, "identitySha256": key, "sha256": hashlib.sha256(content).hexdigest()})
        (directory / "manifest.json").write_text(json.dumps({"runtime": "codex", "complete": True, "files": files}))
        return runner.audit_descendants(self.common, "codex", directory, self.directory / "app", self.directory / "support",
            self.directory / "client.cjs", {role: role for role in heavy.HEAVY_ROLES}, "synthetic-root", profile=heavy.PROFILE,
            formal_repair_started=base + 30 if repair and formal_repair else None)

    def test_native_heavy_ordering_covers_nested_leaves_specialist_and_judge(self):
        audit = self.native_fixture()
        self.assertFalse(audit["requiresManualReview"])
        self.assertEqual(audit["observedNativeSessions"], 7)
        self.assertTrue(audit["roleCreationDependenciesSatisfied"])
        self.assertTrue(audit["roleCompletionDependenciesSatisfied"])
        self.assertTrue(audit["specialistCoversLatestWorkerPhasesAndRepair"])

    def test_coordinator_cannot_complete_before_nested_leaves(self):
        self.assertTrue(self.native_fixture(coordinator_end=4)["requiresManualReview"])

    def test_qa_cannot_start_before_implementation_roles_finish(self):
        self.assertTrue(self.native_fixture(qa_start=6)["requiresManualReview"])

    def test_judge_cannot_start_before_qa_and_nested_workers_finish(self):
        self.assertTrue(self.native_fixture(judge_start=9)["requiresManualReview"])

    def test_background_notification_turn_does_not_imply_a_formal_repair(self):
        self.assertFalse(self.native_fixture(repair=True, recheck=False, formal_repair=False)["requiresManualReview"])

    def test_formal_repair_requires_same_qa_and_judge_followups(self):
        self.assertTrue(self.native_fixture(repair=True, recheck=False)["requiresManualReview"])

    def test_same_qa_and_judge_followups_can_cover_formal_repair(self):
        self.assertFalse(self.native_fixture(repair=True, recheck=True)["requiresManualReview"])


if __name__ == "__main__":
    unittest.main()
