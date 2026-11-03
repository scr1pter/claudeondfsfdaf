"""Fake-only actual seven-identity adapter qualification; no real credentials.

Runs the reviewed heavy adapter commands against an owned ephemeral fake meter.
The heavy app scaffold stays unchanged and its real 76-check evaluator remains
negative. A labelled fixture page/API tests capabilities, not app correctness.
"""
from contextlib import closing
import json
from pathlib import Path
import threading

from codex_free_probe import named_tool
from funding_profiles import HEAVY_PHASE
from native_registry import owned_transcript_path
from native_team_policy import MODEL, require
from owned_team_witness import ACTORS, OwnedSupervisor
import heavy_runner as heavy
import native_pair_smoke as smoke
import paired_runner as runner


class FakeMeter(smoke.FakeMeter):
    def controller(self, route, value=None):
        result = super().controller(route, value)
        if route == "/control":
            return result
        result.update(phaseID=HEAVY_PHASE, phasePlanSha256=heavy.FUNDING.plan_sha256)
        for actor, limit in heavy.FUNDING.actor_caps:
            result["actors"][actor]["limitUsd"] = limit
        result["actors"]["synthetic-sealed-history"] = {"limitUsd": 2.9437681, "measuredUsd": 2.9437681, "reservedUsd": 0}
        return result

    def role_row(self, adapter, role):
        with closing(adapter.registry.connect()) as connection:
            if adapter.runtime == "codex":
                rows = connection.execute("SELECT id,agent_path,rollout_path FROM threads WHERE agent_role=?", (role,)).fetchall()
            else:
                rows = connection.execute("SELECT id FROM session WHERE agent=? AND internal IS NULL", (role,)).fetchall()
        require(len(rows) <= 1, "fake script saw a replacement role")
        return dict(rows[0]) if rows else None

    def completions(self, adapter, role):
        row = self.role_row(adapter, role)
        if row is None:
            return 0
        path = owned_transcript_path(row["rollout_path"], adapter.home)
        count = 0
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            count += int(item.get("type") == "event_msg" and item.get("payload", {}).get("type") in ("task_complete", "turn_complete"))
        return count

    def next_calls(self, adapter, native, tools):
        role, round_index = native["role"], adapter.smoke_invocation
        key = (native["id"], round_index)
        stage = self.child_stages.get(key, 0)
        def call(name, args):
            found = named_tool(tools, name)
            require(found is not None, "required heavy native tool absent: " + name)
            result = {"name": found[0]["name"], "arguments": json.dumps(args)}
            if found[1]:
                result["namespace"] = found[1]
            return result
        message = "Fake-only deterministic capability qualification. Leave the application scaffold unchanged; do not access external services or delegate except the exact fixed coordinator leaves."
        def tasks(roles, *, background=False, resume=False):
            if adapter.runtime == "vector":
                selected = []
                for selected_role in roles:
                    task = {"description": "Fixed smoke " + selected_role, "prompt": message, "subagent_type": selected_role}
                    if resume:
                        existing = self.role_row(adapter, selected_role)
                        require(existing is not None, "fake continuation role absent")
                        task["task_id"] = existing["id"]
                    selected.append(task)
                return [call("task", {"tasks": selected, "background": background})]
            if resume:
                return [call("followup_task", {"target": self.role_row(adapter, selected_role)["agent_path"], "message": message})
                        for selected_role in roles]
            return [call("spawn_agent", {"task_name": selected_role, "agent_type": selected_role,
                "fork_turns": "none", "message": message}) for selected_role in roles]
        def wait(roles, wanted=1):
            if adapter.runtime == "vector":
                selected = [self.role_row(adapter, selected_role) for selected_role in roles]
                require(all(selected), "fake wait role absent")
                return [call("task_manage", {"action": "wait", "task_ids": [row["id"] for row in selected], "mode": "all", "timeout": 60000})]
            if all(self.completions(adapter, selected_role) >= wanted for selected_role in roles):
                return None
            return [call("wait_agent", {"timeout_ms": 10000})]
        if role == "backend_coordinator" and round_index == 1:
            if stage == 0:
                self.child_stages[key] = 1
                return tasks(("backend_api", "backend_data"))
            if adapter.runtime == "codex" and stage == 1:
                waiting = wait(("backend_api", "backend_data"))
                if waiting is not None:
                    return waiting
                stage = 2
            if stage in (1, 2):
                self.child_stages[key] = 3
                return [smoke.execution_call(adapter.runtime, tools, "Write-Output 'smoke-coordinator-integrated'")]
            return []
        if role != "lead":
            self.child_stages[key] = stage + 1
            return [smoke.execution_call(adapter.runtime, tools, "Write-Output 'smoke-specialist-complete'")] if stage == 0 else []
        if adapter.runtime == "vector":
            self.child_stages[key] = stage + 1
            if round_index == 1:
                if stage == 0: return tasks(("backend_coordinator",))
                if stage == 1: return tasks(("frontend_worker",), background=True)
                if stage == 2: return wait(("frontend_worker",))
                if stage == 3: return tasks(("qa_specialist",))
                if stage == 4: return tasks(("team_judge",))
                if stage == 5: return [smoke.execution_call("vector", tools, smoke.shell_command(adapter.options.app_port))]
                return []
            if stage == 0: return tasks(("qa_specialist",), resume=True)
            if stage == 1: return tasks(("team_judge",), resume=True)
            if stage == 2: return [smoke.execution_call("vector", tools, smoke.shell_command(adapter.options.app_port))]
            return []
        if round_index == 1:
            if stage in (1, 3, 5):
                dependencies = ("backend_coordinator", "frontend_worker") if stage == 1 else ("qa_specialist",) if stage == 3 else ("team_judge",)
                waiting = wait(dependencies)
                if waiting is not None:
                    return waiting
                stage += 1
            self.child_stages[key] = stage + 1
            if stage == 0: return tasks(("backend_coordinator", "frontend_worker"))
            if stage == 2: return tasks(("qa_specialist",))
            if stage == 4: return tasks(("team_judge",))
            if stage == 6: return [smoke.execution_call("codex", tools, smoke.shell_command(adapter.options.app_port))]
            return []
        if stage in (1, 3):
            waiting = wait(("qa_specialist",) if stage == 1 else ("team_judge",), wanted=2)
            if waiting is not None:
                return waiting
            stage += 1
        self.child_stages[key] = stage + 1
        if stage == 0: return tasks(("qa_specialist",), resume=True)
        if stage == 2: return tasks(("team_judge",), resume=True)
        if stage == 4: return [smoke.execution_call("codex", tools, smoke.shell_command(adapter.options.app_port))]
        return []


class Adapter(smoke.SmokeAdapter):
    def run(self, prompt, session, timeout, index):
        self.smoke_invocation = index
        return super().run(prompt, session, timeout, index)


def vector_background_evidence(adapter):
    launches, notifications = 0, 0
    if adapter.runtime != "vector":
        return {"applicable": False}
    # Read only the already owned registry; no inference or wake is requested.
    with closing(adapter.registry.connect()) as connection:
        for row in connection.execute("SELECT data FROM part WHERE session_id=?", (adapter.registry.root_id,)):
            data = json.loads(row[0])
            if data.get("type") == "tool" and data.get("tool") == "task" and data.get("state", {}).get("input", {}).get("background") is True:
                launches += 1
            if data.get("type") == "text" and "<task-notification>" in data.get("text", ""):
                notifications += 1
    return {"applicable": True, "backgroundTaskLaunches": launches, "ownedCompletionNotifications": notifications}


def main(argv=None):
    parser = heavy.parser()
    parser.description = __doc__
    parser.add_argument("--runtime", choices=("vector", "codex"), required=True)
    options = heavy.prepare_options(parser.parse_args(argv))
    require(not options.run and options.controller_config is None and options.receipt_jsonl is None,
            "fake heavy qualification cannot accept funded inputs")
    runner.checked_path(options.out, [options.vector_root, options.task_dir, options.common_runner_root,
        options.browser_driver_root, Path(__file__).resolve().parents[3]])
    common = runner.common_helpers(options.common_runner_root)
    options.out.mkdir(parents=True)
    meter = FakeMeter(options.out)
    options.provider_base = "http://127.0.0.1:" + str(meter.server_port)
    plan = heavy.build_plan(options, common)
    require(not plan["sourceDirty"] and options.expected_source == plan["sourceRevision"], "explicit clean heavy product revision required")
    common.save(options.out / "smoke-plan.json", plan)
    holder = {"fakeMeter": meter}
    supervisor = OwnedSupervisor(meter.controller, lambda: list(meter.receipts), options.out, funding_profile=HEAVY_PHASE,
        quiesced=lambda: holder.get("adapter") is not None and holder["adapter"].quiesced is True)
    adapter = Adapter(options.runtime, options, common, plan["task"], holder)
    holder["adapter"] = adapter
    thread = threading.Thread(target=meter.serve_forever, daemon=True)
    thread.start()
    try:
        result = runner.coordinate_team_arm(supervisor=supervisor, runtime=options.runtime,
            label="synthetic-heavy-adapter-" + options.runtime, adapter=adapter, task=plan["task"], common=common,
            max_calls=300, seconds=7200, soft_usd=heavy.FUNDING.repair_threshold_usd, profile=heavy.PROFILE,
            check_frozen=lambda: require(heavy.build_plan(options, common) == plan, "heavy smoke freeze changed"),
            persist=lambda value: common.save(options.out / "private-result.json", value))
        capabilities = smoke.capabilities(adapter)
        background = vector_background_evidence(adapter)
        summary = {"kind": "fake-actual-heavy-adapter-qualification-v1", "runtime": options.runtime,
            "realProviderCalls": 0, "fundedMeterCalls": 0, "sourceRevision": plan["sourceRevision"],
            "profileSha256": plan["profileSha256"], "instrumentFiles": plan["teamInstrumentFiles"],
            "binarySha256": plan["binarySha256"], "fakeRequests": len(meter.receipts),
            "unchangedRealSeed": bool(result["attempts"]) and all(attempt["artifact"].get("unchangedSmokeSeed") is True for attempt in result["attempts"]),
            "expectedProductGate": "unchanged Foundry scaffold must remain negative under all 76 original checks",
            "allSolHighAutoLow": all(row["model"] == MODEL and row["reasoning"].get("effort") == "high"
                and row["reasoning"].get("summary") == "auto" and row["verbosity"] == "low" and row["outputCeiling"] == 32000 for row in meter.rows),
            "capabilityEvidence": capabilities, "backgroundEvidence": background,
            **{key: result.get(key) for key in ("functionalVerdict", "nativeAuditVerdict", "stopReason", "reviewRequired",
                "settlementComplete", "providerRequests", "autonomousActorsAdmitted", "nativeAudit")}}
        summary["qualificationPassed"] = (summary["allSolHighAutoLow"] and summary["unchangedRealSeed"]
            and result.get("functionalVerdict") == "product_failure" and result.get("stopReason") == "product_failure_after_one_same_session_repair"
            and result.get("settlementComplete") is True and result.get("reviewRequired") is False
            and result.get("nativeAuditVerdict") == "passed" and result.get("autonomousActorsAdmitted") == 7
            and result.get("providerRequests") == len(meter.receipts) and capabilities["successfulActualShellApiAndCommonBrowser"]
            and capabilities["fixtureApiRequests"] > 0 and capabilities["fixtureBrowserPageRequests"] > 0
            and (options.runtime != "vector" or background["backgroundTaskLaunches"] > 0 and background["ownedCompletionNotifications"] > 0))
        common.save(options.out / "smoke-summary.json", summary)
        print(json.dumps({key: value for key, value in summary.items() if key not in ("instrumentFiles", "binarySha256", "nativeAudit")}, indent=2))
        return 0 if summary["qualificationPassed"] else 2
    finally:
        meter.shutdown()
        meter.server_close()
        thread.join(timeout=10)


if __name__ == "__main__":
    raise SystemExit(main())
