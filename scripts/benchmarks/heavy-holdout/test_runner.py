"""Free controls for closed task admission and independently stepped arms."""
import copy
import json
from pathlib import Path
import tempfile
import shutil
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
import threading
import unittest

import runner


class AdmissionControls(unittest.TestCase):
    def test_two_contenders_claim_once_before_controller_or_summary_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "vector-result.json"
            barrier = threading.Barrier(2)
            controller_opens = []
            def contender(identity):
                barrier.wait(timeout=5)
                try:
                    runner.claim_result(path, {"labelledSyntheticWinner": identity})
                except FileExistsError:
                    return "rejected"
                controller_opens.append(identity)
                return "claimed"
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(contender, (1, 2)))
            self.assertEqual(sorted(results), ["claimed", "rejected"])
            self.assertEqual(len(controller_opens), 1)
            saved = path.read_bytes()
            self.assertEqual(json.loads(saved)["labelledSyntheticWinner"], controller_opens[0])
            with self.assertRaises(FileExistsError):
                runner.claim_result(path, {"overwrite": True})
            self.assertEqual(path.read_bytes(), saved)

    def prior(self, plan):
        return {"kind": "harbor-native-team-arm-result-v1", "runtime": "codex", "planSha256": runner.digest(plan),
                "allChargesRetained": True, "historicalAmountsReset": False,
                "arm": {"runtime": "codex", "allChargesRetained": True, "historicalAmountsReset": False, "providerRequests": 7, "measuredUsd": .1,
                        "controllerUsageThroughClosure": {"providerRequests": 7, "measuredUsd": .1},
                        "attempts": [{"index": 1, "process": {"ownedTreeQuiesced": True}}], "settlementComplete": True,
                        "reviewRequired": True, "functionalVerdict": "product_failure",
                        "closure": {"runtime": "codex", "providerRequests": 7, "measuredUsd": .1, "settlementComplete": True,
                                    "allChargesRetained": True, "runtimeQuiesced": True,
                                    "controllerUsageThroughClosure": {"providerRequests": 7, "measuredUsd": .1},
                                    "usageAccountingStatus": "settled_and_receipts_reconciled",
                                    "transcripts": {"complete": True}}}}

    def test_explicit_review_keeps_failed_prior_flags(self):
        plan = {"label": "labelled synthetic control"}
        prior = self.prior(plan)
        before = copy.deepcopy(prior)
        review = runner.validate_predecessor(prior, plan, runner.digest(prior))
        self.assertEqual(prior, before)
        self.assertTrue(review["priorReviewRequired"])
        self.assertTrue(review["priorReviewFlagsRetained"])

    def test_missing_review_or_different_plan_is_rejected(self):
        plan = {"label": "labelled synthetic control"}
        prior = self.prior(plan)
        for expected, other in ((None, plan), ("0" * 64, plan), (runner.digest(prior), {"changed": True})):
            with self.subTest(expected=expected, plan=other), self.assertRaises(ValueError):
                runner.validate_predecessor(prior, other, expected)

    def test_unknown_closure_wrong_actor_or_unattempted_prior_is_rejected(self):
        plan = {"label": "labelled synthetic control"}
        mutations = [lambda p: p.update(runtime="vector"), lambda p: p.update(allChargesRetained=False),
                     lambda p: p.update(historicalAmountsReset=True),
                     lambda p: p["arm"].update(settlementComplete=False),
                     lambda p: p["arm"]["closure"].update(runtimeQuiesced=False),
                     lambda p: p["arm"]["closure"].update(usageAccountingStatus="unknown"),
                     lambda p: p["arm"]["closure"]["transcripts"].update(complete=False),
                     lambda p: p["arm"].update(runtime="vector"),
                     lambda p: p["arm"].update(attempts=[]), lambda p: p["arm"].update(attempts="unproven"),
                     lambda p: p["arm"].update(attempts=[{"index": 1}]),
                     lambda p: p["arm"]["closure"].update(settlementComplete=False),
                     lambda p: p["arm"]["closure"].update(allChargesRetained=False),
                     lambda p: p["arm"]["closure"].update(providerRequests=8),
                     lambda p: p["arm"]["closure"].update(measuredUsd=None),
                     lambda p: p["arm"]["closure"]["controllerUsageThroughClosure"].update(measuredUsd=.2),
                     lambda p: p["arm"]["controllerUsageThroughClosure"].update(providerRequests=6)]
        mutations += [lambda p, count=count: p["arm"].update(providerRequests=count) for count in (0, -1, True, 301, 1.5, None)]
        mutations += [lambda p, cost=cost: p["arm"].update(measuredUsd=cost) for cost in (-1, True, None, float("nan"), float("inf"))]
        for mutation in mutations:
            prior = self.prior(plan)
            mutation(prior)
            with self.subTest(prior=prior), self.assertRaises(ValueError):
                runner.validate_predecessor(prior, plan, runner.digest(prior))


class TaskControls(unittest.TestCase):
    def fixture(self, root):
        source = Path(__file__).resolve().parents[3] / "docs/benchmarks/agentic-heavy-v1/harbor"
        shutil.copytree(source, root, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__"))
        return json.loads((root / "task.json").read_text(encoding="utf-8"))

    def test_closed_metadata_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task = self.fixture(root)
            self.assertEqual(runner.load_task(root), task)

    def test_unqualified_changed_inventory_or_execution_contract_is_rejected(self):
        mutations = [lambda t: t.update(name="other"), lambda t: t.update(expectedApiGroups=27),
                     lambda t: t.update(expectedBrowserChecks=31), lambda t: t.update(expectedTotalChecks=63),
                     lambda t: t.update(promptFile="answer.py"), lambda t: t.update(seedDirectory="gold"),
                     lambda t: t.update(evaluatorCommand=["{python}", "-c", "unbound"]),
                     lambda t: t.update(evaluatorTimeoutSeconds=1201), lambda t: t.update(protectedFiles=[]),
                     lambda t: t.update(generatedDirectories=["src"]), lambda t: t.update(setupCommand=["{bun}", "run", "unbound"])]
        for mutation in mutations:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                task = self.fixture(root)
                mutation(task)
                (root / "task.json").write_text(json.dumps(task), encoding="utf-8")
                with self.subTest(task=task), self.assertRaises(ValueError):
                    runner.load_task(root)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            (root / "qualification.json").write_text('{"runtimeQualified": false}', encoding="utf-8")
            with self.assertRaises(ValueError):
                runner.load_task(root)

    def test_seeded_implementation_or_contract_drift_is_rejected(self):
        for name, content in (("server.ts", "participant must implement this"), ("UI_CONTRACT.md", "changed")):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.fixture(root)
                (root / "seed" / name).write_text(content, encoding="utf-8")
                with self.assertRaises(ValueError):
                    runner.load_task(root)

    def test_real_qualification_evidence_mutations_are_rejected(self):
        source = Path(__file__).resolve().parents[3] / "docs/benchmarks/agentic-heavy-v1/harbor/qualification.json"
        qualified = json.loads(source.read_text(encoding="utf-8"))
        runner.validate_qualification(qualified)
        mutations = [lambda q: q.update(modelCalls=1), lambda q: q.update(modelCalls=False),
                     lambda q: q.update(status="pending"), lambda q: q.update(expectedChecks={}),
                     lambda q: q["positiveReference"].update(sourceIntegrityStatus="modified"),
                     lambda q: q["positiveReference"]["checks"].pop(),
                     lambda q: q["positiveReference"]["checks"].__setitem__(0, q["positiveReference"]["checks"][1]),
                     lambda q: q["positiveReference"]["checks"][0].update(status="failed"),
                     lambda q: q["emptySeed"]["checks"][4].update(status="passed"),
                     lambda q: q["damagedReferenceControls"].pop(),
                     lambda q: q["damagedReferenceControls"][0].update(instrumentErrors=1),
                     lambda q: q["damagedReferenceControls"][0].update(observedFailures=[]),
                     lambda q: q["damagedReferenceControls"][1].update(deniedOriginRequests=1)]
        for mutation in mutations:
            value = copy.deepcopy(qualified)
            mutation(value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                runner.validate_qualification(value)

    def test_qualification_blob_or_source_hash_drift_is_rejected(self):
        for name in ("qualification.json", "runtime-freeze.json", "evaluate.py"):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.fixture(root)
                if name == "runtime-freeze.json":
                    value = json.loads((root / name).read_text(encoding="utf-8"))
                    value["aggregateSha256"] = "0" * 64
                    (root / name).write_text(json.dumps(value), encoding="utf-8")
                else:
                    with (root / name).open("a", encoding="utf-8") as stream:
                        stream.write("\n ")
                with self.subTest(name=name), self.assertRaises(ValueError):
                    runner.load_task(root)


class BootstrapControls(unittest.TestCase):
    def test_each_code_root_is_checked_before_importing_sentinel_code(self):
        for changed in ("team", "common", "browser"):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                marker = root / "executed"
                roots = {name: root / name for name in ("team", "common", "browser")}
                for path in roots.values():
                    path.mkdir()
                (roots["team"] / "heavy_runner.py").write_text(
                    "from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('unsafe import')\n", encoding="utf-8")
                (roots["common"] / "runner.py").write_text("# frozen sentinel\n", encoding="utf-8")
                (roots["browser"] / "server.cjs").write_text("// frozen sentinel\n", encoding="utf-8")
                checksums = {name: runner.digest(runner.manifest(path)) for name, path in roots.items()}
                with (roots[changed] / "tampered.py").open("w", encoding="utf-8") as stream:
                    stream.write("# changed dependency\n")
                options = SimpleNamespace(team_runner_root=roots["team"], common_runner_root=roots["common"],
                    browser_driver_root=roots["browser"], expected_team_sha=checksums["team"],
                    expected_common_sha=checksums["common"], expected_browser_sha=checksums["browser"])
                with self.subTest(changed=changed), self.assertRaises(ValueError):
                    runner.bootstrap(options)
                self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
