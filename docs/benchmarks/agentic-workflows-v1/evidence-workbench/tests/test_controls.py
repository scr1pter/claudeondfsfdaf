"""Free positive/negative controls for the instrument, never a candidate gold fix."""
import copy
from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from api_checks import Acceptance, Client, ProductFailure, check_citation
from corpus import byte_slice, corpus, ndjson, unicode_body, upsert
from evaluate import clean_environment, main, verdict
from integrity import digest, manifest
from inventory import API_CHECKS, BROWSER_CHECKS, CHECKS, blank_checks


def citation_hit(body, token="needle"):
    start = len(body[:body.index(token)].encode("utf-8"))
    end = start + len(token.encode("utf-8"))
    return {"id": 7, "version": 2, "snippet": token,
            "citation": {"documentId": 7, "version": 2, "startByte": start, "endByte": end, "quote": token}}


class CitationControls(unittest.TestCase):
    def test_positive_exact_utf8_slice(self):
        body = unicode_body()
        hit = citation_hit(body)
        self.assertEqual(check_citation(hit, body, "needle")["quote"], "needle")
        self.assertGreater(hit["citation"]["startByte"], body.index("needle"))

    def test_negative_utf16_offsets(self):
        body = unicode_body()
        hit = citation_hit(body)
        hit["citation"]["startByte"] = len(body[:body.index("needle")].encode("utf-16-le")) // 2
        hit["citation"]["endByte"] = hit["citation"]["startByte"] + 6
        with self.assertRaises(ProductFailure):
            check_citation(hit, body, "needle")

    def test_negative_mutated_quote(self):
        body = unicode_body()
        for field, value in [("quote", "NEEDLE"), ("documentId", 8), ("version", 3), ("startByte", -1), ("endByte", 99999), ("startByte", True)]:
            with self.subTest(field=field):
                hit = citation_hit(body)
                hit["citation"][field] = value
                with self.assertRaises(ProductFailure):
                    check_citation(hit, body, "needle")

    def test_negative_mid_scalar_and_wrong_snippet(self):
        hit = {"id": 7, "version": 2, "snippet": "🧭", "citation": {"documentId": 7, "version": 2, "startByte": 1, "endByte": 4, "quote": "🧭"}}
        with self.assertRaises(ProductFailure):
            check_citation(hit, "🧭needle", "needle")
        body = unicode_body()
        hit = citation_hit(body)
        hit["snippet"] = "different"
        with self.assertRaises(ProductFailure):
            check_citation(hit, body, "needle")

    def test_positive_empty_body(self):
        hit = {"id": 1, "version": 1, "snippet": "", "citation": {"documentId": 1, "version": 1, "startByte": 0, "endByte": 0, "quote": ""}}
        self.assertEqual(check_citation(hit, "")["quote"], "")

    def test_negative_missing_whole_matching_token(self):
        body = "superneedle needle"
        hit = {"id": 1, "version": 1, "snippet": "superneedle", "citation": {"documentId": 1, "version": 1, "startByte": 0, "endByte": 11, "quote": "superneedle"}}
        with self.assertRaises(ProductFailure):
            check_citation(hit, body, "needle")

    def test_negative_empty_range_inside_multibyte_scalar(self):
        hit = {"id": 1, "version": 1, "snippet": "", "citation": {"documentId": 1, "version": 1, "startByte": 2, "endByte": 2, "quote": ""}}
        with self.assertRaises(ProductFailure):
            check_citation(hit, "a🧭z")

    def test_negative_excerpt_cutting_into_original_token(self):
        hit = {"id": 1, "version": 1, "snippet": "needle", "citation": {"documentId": 1, "version": 1, "startByte": 5, "endByte": 11, "quote": "needle"}}
        with self.assertRaises(ProductFailure):
            check_citation(hit, "superneedle needle", "needle")


class BodyReadControls(unittest.TestCase):
    def test_body_timeout_and_reset_are_product_failures(self):
        from http.client import IncompleteRead
        for failure in [TimeoutError("slow body"), ConnectionResetError("reset"), IncompleteRead(b"partial")]:
            class Body:
                code = 200

                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    pass

                def read(self, limit):
                    raise failure

            class Opener:
                def open(self, request, timeout):
                    return Body()

            client = Client("http://127.0.0.1:4123")
            client.opener = Opener()
            with self.subTest(failure=type(failure).__name__), self.assertRaises(ProductFailure):
                client.get("/api/health")


class BatchCreateScript:
    """A bounded scripted HTTP transcript, not document storage or a reference app."""
    def __init__(self, mutation=None):
        self.mutation = mutation
        self.calls = 0

    def revision(self):
        return 12

    def batch(self, batch_id, rows):
        self.calls += 1
        if self.calls == 1:
            receipt = {"batchId": batch_id, "revision": 13, "replayed": False, "operations": [
                {"type": "upsert", "source": "batch/one", "documentId": 10, "version": 1, "changed": True},
                {"type": "upsert", "source": "batch/two", "documentId": 11, "version": 1, "changed": True},
                {"type": "delete", "source": "batch/absent", "documentId": None, "version": None, "changed": False},
            ]}
            if self.mutation == "revision_per_operation":
                receipt["revision"] = 15
            if self.mutation == "reordered_receipt":
                receipt["operations"].reverse()
            if self.mutation == "unknown_delete_changed":
                receipt["operations"][2]["changed"] = True
            return receipt
        return {"batchId": batch_id, "revision": 14 if self.mutation == "noop_revision" else 13,
                "replayed": False, "operations": [{"type": "upsert", "source": "batch/one", "documentId": 10,
                    "version": 2 if self.mutation == "noop_version" else 1, "changed": False}]}


class BatchControls(unittest.TestCase):
    def test_positive_batch_contract_transcript(self):
        Acceptance(BatchCreateScript(), None, None, None, ROOT).batch_create()

    def test_negative_plausible_batch_defects(self):
        for mutation in ["revision_per_operation", "reordered_receipt", "unknown_delete_changed", "noop_revision", "noop_version"]:
            with self.subTest(mutation=mutation):
                with self.assertRaises(ProductFailure):
                    Acceptance(BatchCreateScript(mutation), None, None, None, ROOT).batch_create()


class ReportControls(unittest.TestCase):
    def test_inventory_matches_descriptor_and_is_unique(self):
        descriptor = json.loads((ROOT / "task.json").read_text())
        self.assertEqual((len(API_CHECKS), len(BROWSER_CHECKS)), (descriptor["expectedApiGroups"], descriptor["expectedBrowserChecks"]))
        self.assertEqual(len(set(CHECKS)), len(CHECKS))
        self.assertEqual([row["name"] for row in blank_checks()], CHECKS)
        self.assertEqual(descriptor["generatedDirectories"], ["dist"])

    def test_portable_protected_files_are_seed_relative(self):
        descriptor = json.loads((ROOT / "task.json").read_text())
        self.assertTrue((ROOT / descriptor["promptFile"]).is_file())
        self.assertNotIn("TASK.md", descriptor["protectedFiles"])
        for name in descriptor["protectedFiles"]:
            self.assertTrue((ROOT / descriptor["seedDirectory"] / name).is_file())

    def test_positive_all_pass_is_zero(self):
        checks = [{"name": name, "status": "passed"} for name in CHECKS]
        self.assertEqual(verdict(checks), ("passed", 0))

    def test_product_failures_are_one_even_with_blocked_dependents(self):
        checks = blank_checks()
        checks[0]["status"] = "failed"
        self.assertEqual(verdict(checks), ("product_failure", 1))

    def test_no_failed_checks_cannot_justify_product_failure(self):
        self.assertEqual(verdict(blank_checks()), ("instrument_failure", 2))

    def test_instrument_and_mutation_override_product_failure(self):
        checks = blank_checks()
        checks[0]["status"] = "failed"
        self.assertEqual(verdict(checks, instrument_errors=["Chrome launch failed"]), ("instrument_failure", 2))
        self.assertEqual(verdict(checks, unchanged=False), ("instrument_failure", 2))

    def fixture(self, directory):
        app = Path(directory) / "app"
        app.mkdir()
        shutil.copytree(ROOT / "seed", app, dirs_exist_ok=True, ignore=shutil.ignore_patterns("node_modules", "dist", "__pycache__"))
        shutil.copyfile(ROOT / "TASK.md", app / "TASK.md")
        return app, Path(directory) / "out"

    def test_build_failure_report_is_honest_product_failure(self):
        with tempfile.TemporaryDirectory(prefix="ew-control-") as directory:
            app, out = self.fixture(directory)
            with patch("evaluate.executable", return_value=sys.executable), patch("evaluate.Evaluator.startup", side_effect=ProductFailure("synthetic compile error")), redirect_stdout(io.StringIO()):
                result = main(["--app", str(app), "--out", str(out), "--task", str(ROOT), "--bun", sys.executable, "--node", sys.executable])
            report = json.loads((out / "evaluation.json").read_text())
            self.assertEqual(result, 1)
            self.assertEqual(report["verdict"], "product_failure")
            self.assertTrue(report["sourceUnchanged"])
            self.assertEqual(report["checks"][0]["status"], "failed")
            self.assertEqual([row["name"] for row in report["checks"]], CHECKS)

    def test_missing_tool_report_is_instrument_failure(self):
        with tempfile.TemporaryDirectory(prefix="ew-control-") as directory:
            app, out = self.fixture(directory)
            with patch("evaluate.executable", side_effect=RuntimeError("synthetic unavailable tool")), redirect_stdout(io.StringIO()):
                result = main(["--app", str(app), "--out", str(out), "--task", str(ROOT), "--bun", "missing", "--node", "missing"])
            report = json.loads((out / "evaluation.json").read_text())
            self.assertEqual((result, report["verdict"]), (2, "instrument_failure"))
            self.assertTrue(report["sourceUnchanged"])
            self.assertTrue((out / "instrument-errors.ndjson").is_file())

    def test_protected_change_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory(prefix="ew-control-") as directory:
            app, out = self.fixture(directory)
            (app / "bun.lock").write_text("changed")
            with patch("evaluate.Evaluator.startup") as startup, redirect_stdout(io.StringIO()):
                result = main(["--app", str(app), "--out", str(out), "--task", str(ROOT), "--bun", "unused", "--node", "unused"])
            self.assertEqual(result, 2)
            startup.assert_not_called()
            self.assertFalse(json.loads((out / "evaluation.json").read_text())["sourceUnchanged"])

    def test_public_prompt_is_protected_independently_of_seed_list(self):
        with tempfile.TemporaryDirectory(prefix="ew-control-") as directory:
            app, out = self.fixture(directory)
            (app / "TASK.md").write_text("changed public prompt")
            with patch("evaluate.Evaluator.startup") as startup, redirect_stdout(io.StringIO()):
                result = main(["--app", str(app), "--out", str(out), "--task", str(ROOT), "--bun", "unused", "--node", "unused"])
            self.assertEqual(result, 2)
            startup.assert_not_called()
            self.assertFalse(json.loads((out / "evaluation.json").read_text())["sourceUnchanged"])


class ManifestAndCorpusControls(unittest.TestCase):
    def test_freeze_cli_writes_lf_and_verifies_its_snapshot(self):
        import subprocess
        with tempfile.TemporaryDirectory(prefix="ew-freeze-") as directory:
            root = Path(directory)
            for name in ["freeze_manifest.py", "integrity.py"]:
                shutil.copyfile(ROOT / name, root / name)
            subprocess.run([sys.executable, str(root / "freeze_manifest.py")], check=True, capture_output=True)
            self.assertNotIn(b"\r\n", (root / "SOURCE_MANIFEST.json").read_bytes())
            subprocess.run([sys.executable, str(root / "freeze_manifest.py"), "--check"], check=True, capture_output=True)

    def test_exact_root_generated_exclusion_only(self):
        with tempfile.TemporaryDirectory(prefix="ew-manifest-") as directory:
            root = Path(directory)
            for name in ["dist/output.js", "src/dist/authored.ts", "src/build/authored.ts", "src/app.ts", "node_modules/local/package.json"]:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(name)
            rows = manifest(root)
            self.assertEqual(set(rows), {"src/dist/authored.ts", "src/build/authored.ts", "src/app.ts"})
            before = digest(rows)
            (root / "src/dist/authored.ts").write_text("changed")
            self.assertNotEqual(before, digest(manifest(root)))

    def test_manifest_detects_added_and_deleted_authored_files(self):
        with tempfile.TemporaryDirectory(prefix="ew-manifest-") as directory:
            root = Path(directory)
            before = manifest(root)
            (root / "extra.ts").write_text("extra")
            self.assertNotEqual(before, manifest(root))
            (root / "extra.ts").unlink()
            self.assertEqual(before, manifest(root))

    def test_corpus_reproducibility_and_seed_variation(self):
        self.assertEqual(ndjson("fixed", corpus()), ndjson("fixed", corpus()))
        self.assertNotEqual(corpus(17041), corpus(17042))
        self.assertEqual(len(corpus()), 12)
        self.assertTrue(all("🧭" in row["body"] and "e\u0301" in row["body"] for row in corpus()))

    def test_byte_slice_is_strict(self):
        self.assertEqual(byte_slice("a🧭é", 1, 5), "🧭")
        with self.assertRaises(UnicodeDecodeError):
            byte_slice("a🧭é", 2, 5)

    def test_native_path_environment_has_no_provider_or_capability(self):
        with patch.dict("os.environ", {"USERPROFILE": "native-profile", "LOCALAPPDATA": "native-appdata", "VECTOR_BENCH_BROWSER_PROXY": "not-forwarded", "OPENAI_API_KEY": "not-forwarded", "BENCH_BROWSER_TOKEN": "not-forwarded"}, clear=True):
            environment = clean_environment()
        self.assertEqual(environment["USERPROFILE"], "native-profile")
        self.assertEqual(environment["LOCALAPPDATA"], "native-appdata")
        self.assertNotIn("OPENAI_API_KEY", environment)
        self.assertNotIn("BENCH_BROWSER_TOKEN", environment)
        self.assertNotIn("VECTOR_BENCH_BROWSER_PROXY", environment)


if __name__ == "__main__":
    unittest.main()
