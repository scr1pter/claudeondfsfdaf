"""Pure positive/negative controls for the independent workflow instrument."""
import ast
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import evaluate

ROOT = Path(__file__).resolve().parent


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/ok":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        elif self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:9/must-not-follow")
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"missing"}}')

    def log_message(self, *_):
        pass


class InventoryFixture:
    """Pure protocol stand-in: exercises graph-validation checks without a server."""

    def __init__(self, legacy_workflows=False, invalid_mutation=None):
        self.client = self
        self.workflows = [{"id": "legacy-workflow"}] if legacy_workflows else []
        self.history = {"legacy-workflow": [{"seq": 1, "type": "workflow.succeeded"}]}
        self.invalid_mutation = invalid_mutation
        self.invalid_requests = 0
        self.valid_retries = []

    def expect(self, method, route, status=200, value=None, key=None):
        if method == "GET" and route == "/api/workflows":
            return {"workflows": json.loads(json.dumps(self.workflows))}
        if method == "GET" and route.endswith("/events?after=0"):
            identity = route.split("/")[3]
            return {"events": json.loads(json.dumps(self.history.get(identity, [])))}
        if method == "POST" and route == "/api/workflows":
            if status != 400:
                raise AssertionError("Validation fixture only accepts invalid POST assertions")
            self.invalid_requests += 1
            if self.invalid_requests == 1:
                if self.invalid_mutation == "inventory":
                    # Same count as baseline; identity comparison must still reject it.
                    self.workflows = [{"id": "partial-invalid-workflow"}]
                elif self.invalid_mutation == "events":
                    self.history["legacy-workflow"].append({"seq": 2, "type": "job.created"})
            return {"error": {"message": "Invalid graph"}}
        raise AssertionError("Unexpected fixture request: " + method + " " + route)

    def create(self, name, key=None):
        self.valid_retries.append({"name": name, "key": key})
        return {"id": "valid-workflow"}


class Controls(unittest.TestCase):
    def test_inventory_has_exact_unique_contract(self):
        self.assertEqual(len(evaluate.API_NAMES), 16)
        self.assertEqual(len(evaluate.BROWSER_NAMES), 8)
        self.assertEqual(len(set(evaluate.API_NAMES + evaluate.BROWSER_NAMES)), 24)
        task = json.loads((ROOT / "task.json").read_text())
        self.assertEqual(task["expectedApiGroups"], len(evaluate.API_NAMES))
        self.assertEqual(task["expectedBrowserChecks"], len(evaluate.BROWSER_NAMES))

    def test_worker_is_same_protected_fixture(self):
        self.assertEqual((ROOT / "worker.ts").read_bytes(), (ROOT / "seed/server/worker.ts").read_bytes())
        self.assertIn("server/worker.ts", json.loads((ROOT / "task.json").read_text())["protectedFiles"])

    def test_python_sources_parse(self):
        for file in ROOT.glob("*.py"):
            ast.parse(file.read_text(encoding="utf-8"), filename=file.name)

    def test_source_inventory_ignores_only_generated_or_dependency_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "server").mkdir()
            (root / "server/main.ts").write_text("first")
            (root / "server/dist").mkdir()
            (root / "server/dist/authored.ts").write_text("nested dist is authored")
            (root / "dist").mkdir()
            (root / "dist/output.js").write_text("generated")
            (root / "node_modules").mkdir()
            (root / "node_modules/dependency.js").write_text("dependency")
            original = evaluate.inventory(root)
            self.assertEqual(set(original), {"server/main.ts", "server/dist/authored.ts"})
            (root / "dist/output.js").write_text("different generated output")
            self.assertEqual(evaluate.inventory(root), original)
            (root / "server/main.ts").write_text("authored modification")
            self.assertNotEqual(evaluate.inventory(root), original)

    def test_wait_observes_real_predicate_and_times_out_negative(self):
        attempts = []
        self.assertEqual(evaluate.wait_for(lambda: attempts.append(1) or ("ready" if len(attempts) == 3 else None), "positive", timeout=1), "ready")
        with self.assertRaises(evaluate.ProductFailure):
            evaluate.wait_for(lambda: None, "negative", timeout=0.01)

    def test_partial_marker_json_is_an_observation_retry(self):
        calls = []
        def read():
            calls.append(1)
            return json.loads("{" if len(calls) == 1 else '{"ready":true}')
        self.assertEqual(evaluate.wait_for(read, "partial marker", timeout=1), {"ready": True})

    def test_process_probe_is_non_destructive(self):
        self.assertTrue(evaluate.process_alive(os.getpid()))
        self.assertFalse(evaluate.process_alive(-1))
        self.assertFalse(evaluate.process_alive(None))

    def test_client_positive_error_and_redirect_controls(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = evaluate.Client("http://127.0.0.1:" + str(server.server_port))
            self.assertEqual(client.expect("GET", "/ok"), {"ok": True})
            with self.assertRaises(evaluate.ProductFailure):
                client.expect("GET", "/missing")
            self.assertEqual(client.call("GET", "/redirect")[0], 302)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_requirement_negative_control(self):
        evaluate.require(True, "accepted")
        with self.assertRaisesRegex(evaluate.ProductFailure, "rejected"):
            evaluate.require(False, "rejected")

    def test_browser_environment_never_copies_provider_credentials(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "synthetic-never-copy", "ANTHROPIC_API_KEY": "synthetic-never-copy"}):
            env = evaluate.browser_environment(Path("bun"), Path("node"))
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertNotIn("ANTHROPIC_API_KEY", env)

    def test_validation_accepts_empty_workflow_baseline(self):
        fixture = InventoryFixture()
        evaluate.validation(fixture)
        self.assertEqual(fixture.invalid_requests, 6)
        self.assertEqual(fixture.valid_retries, [{"name": "Valid retry", "key": "invalid-0"}])

    def test_validation_accepts_preserved_legacy_workflow_baseline(self):
        fixture = InventoryFixture(legacy_workflows=True)
        evaluate.validation(fixture)
        self.assertEqual(fixture.workflows, [{"id": "legacy-workflow"}])
        self.assertEqual(fixture.history["legacy-workflow"], [{"seq": 1, "type": "workflow.succeeded"}])
        self.assertEqual(len(fixture.valid_retries), 1)

    def test_validation_rejects_partial_invalid_workflow_identity_change(self):
        fixture = InventoryFixture(legacy_workflows=True, invalid_mutation="inventory")
        with self.assertRaisesRegex(evaluate.ProductFailure, "workflow inventory"):
            evaluate.validation(fixture)
        self.assertEqual(fixture.valid_retries, [])

    def test_validation_rejects_partial_invalid_events_with_unchanged_inventory(self):
        fixture = InventoryFixture(legacy_workflows=True, invalid_mutation="events")
        with self.assertRaisesRegex(evaluate.ProductFailure, "workflow events"):
            evaluate.validation(fixture)
        self.assertEqual(fixture.workflows, [{"id": "legacy-workflow"}])
        self.assertEqual(fixture.valid_retries, [])

    def test_postlaunch_original_snapshots_are_verbatim(self):
        archive = ROOT / "instrument-revisions/postlaunch-keyboard-v2"
        provenance = json.loads((archive / "provenance.json").read_text())
        self.assertEqual(provenance["originalTaskDigest"], "722a00ba024522e2e88aee585f778dad206b115a30a8d1caded38681cf7cd761")
        for snapshot in provenance["snapshots"].values():
            content = (archive / snapshot["path"]).read_bytes()
            self.assertEqual(hashlib.sha256(content).hexdigest(), snapshot["sha256"])
            self.assertEqual(len(content), snapshot["bytes"])

    def test_postlaunch_api_instrument_is_unchanged(self):
        archive = ROOT / "instrument-revisions/postlaunch-keyboard-v2/original"
        original_manifest = json.loads((archive / "original-manifest.json").read_text())
        self.assertEqual(hashlib.sha256((ROOT / "evaluate.py").read_bytes()).hexdigest(), original_manifest["files"]["evaluate.py"])

    def test_postlaunch_other_seven_browser_contracts_are_unchanged(self):
        archive = ROOT / "instrument-revisions/postlaunch-keyboard-v2/original"
        original = (archive / "browser-check.cjs").read_text()
        current = (ROOT / "browser-check.cjs").read_text()
        def contract(source, name):
            start = source.index('await check("' + name + '"')
            end = source.find('await check("', start + 1)
            return source[start:end]
        for name in evaluate.BROWSER_NAMES[:-1]:
            self.assertEqual(contract(current, name), contract(original, name), name)

    def test_postlaunch_keyboard_observes_without_forcing_dom_focus(self):
        source = (ROOT / "browser-check.cjs").read_text()
        helper = source[source.index("async function keyboardFormReachability"):source.index("function node(")]
        self.assertIn('page.keyboard.press("Tab")', helper)
        self.assertIn('name: "Workflow Runner"', helper)
        self.assertIn("visibleCandidates + 2", helper)
        self.assertIn("Math.min(200", helper)
        self.assertNotIn(".focus(", helper)
        self.assertNotIn("setAttribute(", helper)
        self.assertNotIn("tabIndex =", helper)


if __name__ == "__main__":
    unittest.main()
