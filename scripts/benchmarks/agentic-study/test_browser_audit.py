"""Synthetic browser-observation controls; never launch a browser or provider."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import browser_audit


def command_event(command, runtime="codex"):
    if runtime == "vector":
        return {"type": "tool_use", "sessionID": "synthetic-private-id", "part": {"tool": "terminal", "state": {"status": "completed", "input": {"command": command}}}}
    return {"type": "item.completed", "item": {"id": "synthetic-private-id", "type": "command_execution", "command": command}}


def terminal_event(action, **values):
    return {"type": "tool_use", "part": {"id": "synthetic-terminal-call", "tool": "terminal",
            "state": {"status": "completed", "input": {"action": action, **values}}}}


class BrowserAuditTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.app = self.root / "app"
        self.app.mkdir()
        self.log = self.root / "agent.jsonl"

    def audit(self, commands=(), runtime="codex", mode="shared-client", rows=None, trusted_client=None):
        values = rows if rows is not None else [command_event(command, runtime) for command in commands]
        self.log.write_text("\n".join(json.dumps(value) for value in values) + "\n", encoding="utf-8")
        return browser_audit.audit_tool_events(self.log, runtime, self.app, mode, trusted_client=trusted_client)

    def test_common_client_environment_invocation_is_not_a_bypass(self):
        result = self.audit(['& $env:NODE_EXE $env:BROWSER_DRIVER_CLIENT --endpoint $env:BROWSER_DRIVER_ENDPOINT \'{"action":"observe"}\''])
        self.assertFalse(result["requiresManualReview"])
        self.assertEqual(result["counts"]["commonClientInvocations"], 1)
        self.assertEqual(result["counts"]["scriptsInspected"], 0)

    def test_literal_frozen_common_client_is_recognized_without_reading_external_code(self):
        client = self.root / "client.cjs"
        client.write_text("require('playwright').chromium.launch()")
        result = self.audit(['node "' + str(client) + '" --endpoint http://127.0.0.1:1'], trusted_client=client)
        self.assertFalse(result["requiresManualReview"])
        self.assertEqual(result["counts"]["commonClientInvocations"], 1)
        self.assertEqual(result["counts"]["scriptsInspected"], 0)

    def test_direct_inline_browser_library_reference_requires_review_for_both_logs(self):
        command = 'node -e "const { chromium } = require(\'playwright\'); chromium.launch()"'
        for runtime in ("vector", "codex"):
            with self.subTest(runtime=runtime):
                result = self.audit([command], runtime)
                self.assertTrue(result["requiresManualReview"])
                self.assertIn("executed_browser_library_reference", result["observations"])

    def test_environment_module_variable_and_dynamic_import_are_execution_references(self):
        commands = ['node -e "const p = process.env.PLAYWRIGHT_MODULE; const b = require(p); b.chromium.launch()"',
                    'node -e "const b = await import(process.env.VECTOR_BENCH_PLAYWRIGHT_MODULE); b.chromium.launch()"']
        result = self.audit(commands)
        self.assertEqual(result["counts"]["directBrowserReferences"], 2)
        self.assertTrue(result["requiresManualReview"])

    def test_actual_script_invocation_is_inspected_but_unexecuted_script_is_not(self):
        (self.app / "check.mjs").write_text("import {chromium} from 'playwright'; await chromium.launch();")
        read = self.audit(["Get-Content check.mjs"])
        self.assertFalse(read["requiresManualReview"])
        self.assertEqual(read["counts"]["scriptsInspected"], 0)
        executed = self.audit(["node check.mjs"])
        self.assertTrue(executed["requiresManualReview"])
        self.assertEqual(executed["counts"]["scriptsInspected"], 1)

    def test_write_tool_source_and_quoted_shell_source_are_not_launches(self):
        rows = [{"type": "tool_use", "part": {"tool": "write", "input": {"content": "require('playwright').chromium.launch()"}}},
                command_event('Write-Output "require(\'playwright\'); chromium.launch()"', "vector"),
                command_event('Get-Content "source mentioning playwright and CHROME_PATH"', "vector"),
                command_event('Set-Content check.mjs "require(\'playwright\').chromium.launch()"', "vector")]
        result = self.audit(runtime="vector", rows=rows)
        self.assertFalse(result["requiresManualReview"])
        self.assertEqual(result["counts"]["directBrowserReferences"], 0)

    def test_string_examples_inside_executed_javascript_are_not_library_loads(self):
        (self.app / "example.js").write_text('console.log("require(\'playwright\').chromium.launch()")')
        result = self.audit(["node example.js"])
        self.assertFalse(result["requiresManualReview"])

    def test_python_browser_import_is_observed_and_ordinary_python_is_not_unknown(self):
        ordinary = self.audit(['python -c "import json; print(json.dumps({}))"', 'node -e "console.log(1)"', "bun run typecheck"])
        self.assertFalse(ordinary["requiresManualReview"])
        self.assertEqual(ordinary["counts"]["unknownObservations"], 0)
        imported = self.audit(['python -c "from playwright.sync_api import sync_playwright"'])
        self.assertTrue(imported["requiresManualReview"])

    def test_own_chrome_process_and_node_spawn_references_require_review(self):
        result = self.audit(['& $env:CHROME_PATH --headless --no-first-run',
                             'node -e "require(\'node:child_process\').spawn(process.env.CHROME_PATH, [])"'])
        self.assertTrue(result["requiresManualReview"])
        self.assertEqual(result["counts"]["directBrowserReferences"], 2)
        self.assertIn("executed_browser_process_reference", result["observations"])

    def test_legacy_mode_records_direct_access_without_rejecting_its_offered_capability(self):
        result = self.audit(['node -e "require(\'playwright\')"'], mode="legacy-library-env")
        self.assertFalse(result["requiresManualReview"])
        self.assertEqual(result["status"], "legacy_observation_only")
        self.assertEqual(result["counts"]["directBrowserReferences"], 1)

    def test_ambiguous_browser_execution_is_unknown_and_requests_manual_review(self):
        result = self.audit(['node -', 'bun run browser-check', 'node -e "eval(\'playwright\')"'])
        self.assertTrue(result["requiresManualReview"])
        self.assertGreater(result["counts"]["unknownObservations"], 0)
        self.assertEqual(result["counts"]["directBrowserReferences"], 0)

    def test_malformed_or_incomplete_tool_records_are_not_clean_evidence(self):
        result = self.audit(rows=[{"type": "item.completed", "item": {"type": "command_execution"}}])
        self.assertTrue(result["requiresManualReview"])
        self.log.write_text("{", encoding="utf-8")
        result = browser_audit.audit_tool_events(self.log, "codex", self.app, "shared-client")
        self.assertTrue(result["requiresManualReview"])

    def test_public_projection_never_contains_commands_paths_ids_or_tokens(self):
        command = 'node -e "require(\'playwright\'); const token=\'synthetic-secret-token\'"'
        result = self.audit([command])
        projection = json.dumps(result)
        for value in (command, str(self.root), "synthetic-private-id", "synthetic-secret-token"):
            self.assertNotIn(value, projection)
        self.assertFalse(result["rawExecutionDetailsPublished"])
        self.assertFalse(result["hardFenceOrSandboxClaim"])

    def test_outside_script_is_not_read_and_remains_unknown(self):
        outside = self.root / "outside.js"
        outside.write_text("require('playwright').chromium.launch()")
        result = self.audit(['node "' + str(outside) + '"'])
        self.assertTrue(result["requiresManualReview"])
        self.assertEqual(result["counts"]["scriptsInspected"], 0)
        self.assertEqual(result["counts"]["directBrowserReferences"], 0)

    def test_limits_are_explicit_and_exhaustion_is_unknown(self):
        (self.app / "one.js").write_text("console.log(1)")
        (self.app / "two.js").write_text("console.log(2)")
        with patch.object(browser_audit, "MAX_SCRIPTS", 1):
            result = self.audit(["node one.js", "node two.js"])
        self.assertTrue(result["requiresManualReview"])
        self.assertEqual(result["counts"]["scriptsInspected"], 1)
        self.assertIn("audit_limit_reached", result["observations"])

    def test_duplicate_execution_updates_are_bounded_without_exporting_ids(self):
        event = command_event('node -e "require(\'playwright\')"', "vector")
        result = self.audit(rows=[event, event], runtime="vector")
        self.assertEqual(result["counts"]["commandsInspected"], 1)
        self.assertEqual(result["counts"]["directBrowserReferences"], 1)

    def test_client_variable_substring_does_not_whitelist_an_authored_script(self):
        (self.app / "fake-BROWSER_DRIVER_CLIENT.js").write_text("require('playwright').chromium.launch()")
        result = self.audit(["node fake-BROWSER_DRIVER_CLIENT.js"])
        self.assertTrue(result["requiresManualReview"])
        self.assertEqual(result["counts"]["commonClientInvocations"], 0)
        self.assertEqual(result["counts"]["scriptsInspected"], 1)

    def test_no_completed_commands_and_unfinished_execution_are_unknown(self):
        for rows in ([], [{"type": "thread.started", "thread_id": "synthetic-private-id"}],
                     [command_event('node -e "console.log(1)"'), {"type": "item.started", "item": {"id": "unfinished-private-id", "type": "command_execution", "command": "node unknown.js"}}]):
            with self.subTest(rows=len(rows)):
                result = self.audit(rows=rows)
                self.assertTrue(result["requiresManualReview"])
                self.assertGreater(result["counts"]["unknownObservations"], 0)

    def test_inline_javascript_writing_browser_source_is_not_execution(self):
        (self.app / "write-source.js").write_text('require("node:fs").writeFileSync("later.js", "require(\'playwright\').chromium.launch()")')
        result = self.audit(["node write-source.js"])
        self.assertFalse(result["requiresManualReview"])

    def test_unrecognized_mode_is_not_reflected_or_clean(self):
        result = self.audit(['node -e "console.log(1)"'], mode="synthetic-secret-mode")
        self.assertTrue(result["requiresManualReview"])
        self.assertEqual(result["mode"], "unknown")
        self.assertNotIn("synthetic-secret-mode", json.dumps(result))

    def test_realistic_vector_server_lifecycle_does_not_misclassify_reads_and_interrupts(self):
        (self.app / "server").mkdir()
        (self.app / "server/index.ts").write_text("Bun.serve({port:8088,fetch:()=>new Response('synthetic')})")
        rows = [terminal_event("open", command="bun --no-env-file server/index.ts", cwd="synthetic-app", pattern="ready", timeout=1000),
                terminal_event("read", id="synthetic-private-terminal", cursor=1),
                terminal_event("wait", id="synthetic-private-terminal", quiet=10),
                terminal_event("resize", id="synthetic-private-terminal", cols=80, rows=24),
                terminal_event("reveal", id="synthetic-private-terminal"),
                terminal_event("keys", id="synthetic-private-terminal", keys=["ctrl-c"]),
                terminal_event("close", id="synthetic-private-terminal"), terminal_event("list")]
        result = self.audit(runtime="vector", rows=rows)
        self.assertFalse(result["requiresManualReview"])
        self.assertEqual(result["counts"]["toolExecutions"], 1)
        self.assertEqual(result["counts"]["terminalObservationActions"], 6)
        self.assertEqual(result["counts"]["terminalControlActions"], 1)
        self.assertNotIn("tool_execution_command_unavailable", result["observations"])

    def test_observation_only_terminal_actions_and_control_keys_are_not_shell_commands(self):
        result = self.audit(runtime="vector", rows=[terminal_event("read", cursor=1), terminal_event("close"),
                            terminal_event("keys", keys=["ctrl-c", "ctrl-l", "ctrl-g", "ctrl-z"])])
        self.assertFalse(result["requiresManualReview"])
        self.assertEqual(result["counts"]["toolExecutions"], 0)

    def test_interactive_browser_text_is_not_silently_treated_as_read_only(self):
        result = self.audit(runtime="vector", rows=[terminal_event("type", text="node -e \"require('@playwright/test')\"", enter=True)])
        self.assertTrue(result["requiresManualReview"])
        self.assertIn("terminal_interactive_input_unknown", result["observations"])
        self.assertEqual(result["counts"]["directBrowserReferences"], 1)

    def test_non_control_interactive_keys_and_even_benign_typed_fragments_remain_unknown(self):
        for row in (terminal_event("keys", keys=["up", "enter"]), terminal_event("keys", keys=["ctrl-d"]),
                    terminal_event("type", text="echo partial", enter=False)):
            with self.subTest(action=row["part"]["state"]["input"]["action"]):
                result = self.audit(runtime="vector", rows=[row])
                self.assertTrue(result["requiresManualReview"])
                self.assertEqual(result["counts"]["terminalInteractiveInputs"], 1)

    def test_missing_open_command_remains_unknown_including_an_argument_array(self):
        for row in (terminal_event("open"), terminal_event("open", args=["-e", "console.log(1)"])):
            result = self.audit(runtime="vector", rows=[row])
            self.assertTrue(result["requiresManualReview"])
            self.assertIn("tool_execution_command_unavailable", result["observations"])

    def test_open_program_argument_array_is_inspected_as_actual_arguments(self):
        result = self.audit(runtime="vector", rows=[terminal_event("open", command="node", args=["-e", "require('@playwright/test')"])])
        self.assertTrue(result["requiresManualReview"])
        self.assertEqual(result["counts"]["directBrowserReferences"], 1)

    def test_known_scoped_browser_libraries_are_recognized_without_substring_false_positives(self):
        for library in ("@playwright/test", "@playwright/experimental-ct-react", "@puppeteer/browsers", "@wdio/globals"):
            with self.subTest(library=library):
                result = self.audit(['node -e "require(\'' + library + '\')"'])
                self.assertTrue(result["requiresManualReview"])
        for library in ("foo-playwright-string", "@example/foo-playwright-string", "./foo-playwright-string"):
            with self.subTest(library=library):
                result = self.audit(['node -e "require(\'' + library + '\')"'])
                self.assertFalse(result["requiresManualReview"])

    def test_invoked_script_using_the_real_create_require_loader_form_is_observed(self):
        (self.app / "browser-check.mjs").write_text('import {createRequire} from "node:module"; const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE); await chromium.launch();')
        result = self.audit(["node browser-check.mjs"])
        self.assertEqual(result["counts"]["directBrowserReferences"], 1)
        self.assertTrue(result["requiresManualReview"])

    def test_malformed_ordinary_powershell_quoting_retains_informational_unknown_without_blocking(self):
        result = self.audit(['powershell.exe -Command "Get-Content \'ordinary unclosed'])
        self.assertEqual(result["status"], "no_clear_bypass_observed")
        self.assertFalse(result["requiresManualReview"])
        self.assertEqual(result["counts"]["unknownObservations"], 1)
        self.assertEqual(result["counts"]["informationalUnknownObservations"], 1)
        self.assertEqual(result["counts"]["reviewRequiredUnknownObservations"], 0)
        self.assertIn("shell_execution_unparseable", result["observations"])
        self.assertFalse(result["coverage"]["adherenceProven"])

    def test_unparseable_obfuscated_browser_marker_requires_review_without_claiming_direct_execution(self):
        result = self.audit(['powershell.exe -Command "node -e eval($env:PLAYWRIGHT_MODULE)'])
        self.assertTrue(result["requiresManualReview"])
        self.assertEqual(result["counts"]["directBrowserReferences"], 0)
        self.assertEqual(result["counts"]["unknownObservations"], 1)
        self.assertEqual(result["counts"]["reviewRequiredUnknownObservations"], 1)
        self.assertIn("browser_related_shell_ambiguity", result["observations"])

    def test_unparseable_common_client_wrapper_is_retained_for_review_instead_of_whitelisted(self):
        result = self.audit(['powershell.exe -Command "& $env:NODE_EXE $env:BROWSER_DRIVER_CLIENT'])
        self.assertTrue(result["requiresManualReview"])
        self.assertEqual(result["counts"]["unknownObservations"], 1)
        self.assertIn("browser_related_shell_ambiguity", result["observations"])


if __name__ == "__main__":
    unittest.main()
