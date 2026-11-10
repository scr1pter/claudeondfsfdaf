"""Report-translation controls; no runtime, credential or provider access."""
import copy
import unittest

import gate_bridge


def report(passed=True):
    rows = [{"name": "synthetic-" + str(index), "scope": "business" if index < 50 else "prerequisite",
             "passed": passed if index < 50 else True} for index in range(54)]
    return {"kind": "relay-headless-gate-v1", "mode": "bun-qualification", "checks": rows,
            "checksTotal": 54, "checksPassed": 54 if passed else 4, "businessTotal": 50,
            "businessPassed": 50 if passed else 0, "prerequisitesTotal": 4, "prerequisitesPassed": 4,
            "passed": passed}


class BridgeControls(unittest.TestCase):
    def test_complete_positive_and_negative_retain_every_independent_row(self):
        for passed in (True, False):
            original = report(passed)
            before = copy.deepcopy(original)
            result = gate_bridge.normalize(original, 0 if passed else 2, True)
            self.assertEqual(original, before)
            self.assertEqual(len(result["checks"]), 54)
            self.assertEqual([row["name"] for row in result["checks"]], [row["name"] for row in original["checks"]])
            self.assertEqual(result["verdict"], "passed" if passed else "product_failure")
            self.assertEqual(result["summary"]["api"]["passed"], 50 if passed else 0)

    def test_malformed_contradictory_or_changed_source_cannot_become_product_pass(self):
        changes = [lambda r: r.update(mode="node-prequalification"), lambda r: r.update(passed=False),
                   lambda r: r.update(checksPassed=53), lambda r: r.update(businessPassed=49),
                   lambda r: r.update(prerequisitesPassed=3), lambda r: r.update(checksTotal=53),
                   lambda r: r["checks"].pop(), lambda r: r["checks"].__setitem__(0, r["checks"][1]),
                   lambda r: r["checks"][0].update(passed="true"), lambda r: r["checks"][0].update(scope="skipped")]
        for mutate in changes:
            original = report()
            mutate(original)
            with self.subTest(original=original), self.assertRaises(ValueError):
                gate_bridge.normalize(original, 0, True)
        for exit_code, unchanged in ((2, True), (0, False), (1, True), (-1, True)):
            with self.subTest(exit_code=exit_code, unchanged=unchanged), self.assertRaises(ValueError):
                gate_bridge.normalize(report(), exit_code, unchanged)


if __name__ == "__main__":
    unittest.main()
