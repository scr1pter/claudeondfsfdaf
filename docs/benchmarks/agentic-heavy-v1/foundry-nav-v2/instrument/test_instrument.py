"""Free instrument controls; no Bun, app process or model/provider calls."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
def module(name):
    spec = importlib.util.spec_from_file_location("foundry_" + name, ROOT / (name + ".py"))
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result
evaluate, prepare = module("evaluate"), module("prepare")


class InstrumentTests(unittest.TestCase):
    def test_all_32_declared_api_groups_have_real_check_bodies(self):
        tree = ast.parse((ROOT / "evaluate.py").read_text(encoding="utf-8"))
        api = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "api_evaluate")
        functions = {node.name: node for node in api.body if isinstance(node, ast.FunctionDef)}
        self.assertEqual(len(evaluate.API_GROUPS), 32)
        self.assertEqual(len(set(evaluate.API_GROUPS)), 32)
        for name in evaluate.API_GROUPS:
            self.assertIn(name, functions)
            self.assertGreater(len(functions[name].body), 2)

    def test_nonfunctional_backend_never_gets_a_pass_or_loses_group_accounting(self):
        class RefusingClient:
            def __init__(self, _base):
                pass
            def call(self, *_args, **_kwargs):
                return evaluate.Response(503, {"error": {"code": "fixture", "message": "Not implemented"}}, {}, b"")
        with patch.object(evaluate, "Client", RefusingClient):
            checks = evaluate.api_evaluate(SimpleNamespace(base="http://127.0.0.1:1"), [])
        self.assertEqual([row["name"] for row in checks], evaluate.API_GROUPS)
        self.assertEqual(sum(row["status"] == "passed" for row in checks), 0)
        self.assertEqual(checks[0]["status"], "failed")
        self.assertTrue(any(row["status"] == "not_run" for row in checks))

    def test_multipart_is_binary_exact_and_scoped_to_form_fields(self):
        payload = b"binary\x00tail\r\nquoted,\"value\""
        raw, headers = evaluate.multipart("evidence.txt", payload, "customer", "cust-synthetic")
        self.assertIn(payload, raw)
        self.assertIn(b'name="entityType"\r\n\r\ncustomer\r\n', raw)
        self.assertIn(b'name="entityId"\r\n\r\ncust-synthetic\r\n', raw)
        self.assertIn(b'filename="evidence.txt"', raw)
        boundary = headers["Content-Type"].split("boundary=", 1)[1]
        self.assertTrue(raw.endswith(("--" + boundary + "--\r\n").encode()))

    def test_sanitized_windows_env_has_owned_appdata_without_provider_secrets(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"OPENAI_API_KEY": "must-not-inherit", "ANTHROPIC_API_KEY": "must-not-inherit"}):
            home = Path(directory) / "isolated"
            env = evaluate.sanitized_env(home, Path(directory) / "bun.exe", Path(directory) / "node.exe")
            self.assertNotIn("OPENAI_API_KEY", env); self.assertNotIn("ANTHROPIC_API_KEY", env)
            self.assertTrue(Path(env["LOCALAPPDATA"]).is_relative_to(home)); self.assertTrue(Path(env["APPDATA"]).is_dir())

    def test_seed_is_only_public_empty_scaffold_and_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); target = root / "app"; manifest = root / "seed.json"
            result = prepare.prepare(target, manifest)
            self.assertEqual(result["fileCount"], 5)
            self.assertEqual({path.name for path in target.iterdir()}, {"BUILD_SPEC.md", "package.json", "tsconfig.json", "bun.lock", ".gitignore"})
            self.assertFalse((target / "src").exists()); self.assertFalse((target / "server").exists())
            self.assertEqual(hashlib.sha256((target / "BUILD_SPEC.md").read_bytes()).hexdigest(), json.loads(manifest.read_text())["files"]["BUILD_SPEC.md"])
            with self.assertRaises(ValueError):
                prepare.prepare(target, root / "another.json")

    def test_error_checks_require_status_and_structured_nonempty_error(self):
        for response in (evaluate.Response(200, {"error": {"code": "x", "message": "x"}}, {}, b""), evaluate.Response(400, {"error": "text only"}, {}, b"")):
            with self.assertRaises(AssertionError):
                evaluate.error(response, 400)
        evaluate.error(evaluate.Response(400, {"error": {"code": "invalid", "message": "Synthetic invalid input"}}, {}, b""), 400)

    def test_owner_invite_accepts_only_documented_rejection_statuses(self):
        envelope = {"error": {"code": "invalid-role", "message": "Owner cannot be invited"}}
        for status in (400, 409):
            evaluate.error(evaluate.Response(status, envelope, {}, b""), (400, 409))
        for status in (200, 201, 403, 500):
            with self.assertRaises(AssertionError):
                evaluate.error(evaluate.Response(status, envelope, {}, b""), (400, 409))
        with self.assertRaises(AssertionError):
            evaluate.error(evaluate.Response(409, {"error": "not structured"}, {}, b""), (400, 409))

    def test_generated_output_and_incremental_state_do_not_hide_authored_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"; app.mkdir()
            for name, content in {"src/main.ts": "export const original = true", "server/index.ts": "export {}", "public/logo.svg": "<svg/>", "build/index.html": "old output", "tsconfig.tsbuildinfo": "old incremental state"}.items():
                target = app / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_text(content)
            output = evaluate.validate_build_output(app, {"root": str(app), "outDir": str(app / "build"), "publicDir": str(app / "public")})
            raw_before = evaluate.manifest(app, raw=True)
            before = evaluate.source_manifest(app, raw_before, [output])
            (app / "build/index.html").write_text("new generated output")
            (app / "build/new.js").write_text("generated bundle")
            (app / "tsconfig.tsbuildinfo").write_text("new incremental state")
            (app / "nested.tsbuildinfo").write_text("new incremental state")
            self.assertEqual(before, evaluate.manifest(app, [output]))
            self.assertNotEqual(raw_before, evaluate.manifest(app, raw=True))
            for name in ("src/main.ts", "public/logo.svg", "server/index.ts"):
                target = app / name; original = target.read_text(); target.write_text("authored edit")
                self.assertNotEqual(before, evaluate.manifest(app, [output]), name)
                target.write_text(original)
            extra = app / "build-not-output/foo.ts"; extra.parent.mkdir(); extra.write_text("authored addition")
            self.assertNotEqual(before, evaluate.manifest(app, [output]))

    def test_output_resolution_guards_containment_and_authored_public_source(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"; app.mkdir()
            base = {"root": str(app), "publicDir": str(app / "public")}
            for output in (app, app.parent / "app-sibling", app / "public", app / "public/build", app / "src", app / "server"):
                with self.assertRaises(AssertionError, msg=str(output)):
                    evaluate.validate_build_output(app, {**base, "outDir": str(output)})
            authored = app / "custom-output/main.ts"; authored.parent.mkdir(); authored.write_text("not generated")
            with self.assertRaises(AssertionError):
                evaluate.validate_build_output(app, {**base, "outDir": str(authored.parent)})
            with self.assertRaises(AssertionError):
                evaluate.validate_build_output(app, {**base, "outDir": str(app / "build"), "inputPaths": [str(app / "build/template.html")]})

    def test_baseline_before_config_resolution_catches_probe_side_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory); source = app / "vite.config.ts"; source.write_text("original config")
            raw_before = evaluate.manifest(app, raw=True)
            source.write_text("config resolution mutated authored source")
            before = evaluate.source_manifest(app, raw_before, [app / "build"])
            self.assertNotEqual(before, evaluate.manifest(app, [app / "build"]))
            with patch.object(Path, "resolve", side_effect=AssertionError("Re-resolving a post-probe symlink could hide authored input")):
                self.assertIn("vite.config.ts", evaluate.source_manifest(app, raw_before, [app / "build"]))

    def test_unknown_build_output_is_not_assessed_rather_than_source_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"; out = Path(directory) / "out"; app.mkdir(); out.mkdir()
            with patch.object(evaluate, "command", return_value={"exitCode": 1, "timedOut": False}):
                info = evaluate.discover_build_output(app, Path("node.exe"), {}, out)
            self.assertEqual(info["status"], "not_assessed")
            self.assertEqual(info["excludedOutputDirectories"], [])


if __name__ == "__main__":
    unittest.main()
