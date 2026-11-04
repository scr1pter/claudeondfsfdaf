"""Reject report claims that omit quality evidence or incomplete spending."""
import json
from pathlib import Path
import unittest

import build_brief


class ClaimValidation(unittest.TestCase):
    def setUp(self):
        self.data = json.loads(Path(__file__).with_name("report-data.json").read_text(encoding="utf-8"))

    def extra(self):
        self.data["additional_complete_study"] = {
            "status": "complete", "settlement_complete": True, "all_charges_retained": True,
            "quality_gate_met": True, "team_size_each": 7, "matched_native_audit_passed": True,
            "vector": {"cost_usd": "1.00", "requests": 80, "checks_passed": 54,
                       "checks_total": 54, "native_roles_observed": 7},
            "codex": {"cost_usd": "1.10", "requests": 70, "checks_passed": 54,
                      "checks_total": 54, "native_roles_observed": 7},
            "blinded_review": {"same_rubric_and_reviewer_pool": True,
                "source_and_required_artifacts_reviewed": True,
                "categories": [{"name": "code", "vector_score": 45, "codex_score": 45, "maximum": 48}]},
        }
        return self.data["additional_complete_study"]

    def test_current_primary_arithmetic(self):
        build_brief.validate(self.data)

    def test_complete_matched_quality_evidence(self):
        self.extra()
        build_brief.validate(self.data)

    def test_incomplete_cost_rejected(self):
        extra = self.extra()
        extra["settlement_complete"] = False
        with self.assertRaises(AssertionError):
            build_brief.validate(self.data)

    def test_functional_pass_alone_does_not_establish_quality(self):
        extra = self.extra()
        del extra["blinded_review"]
        with self.assertRaises(KeyError):
            build_brief.validate(self.data)

    def test_lower_code_or_visual_review_rejected(self):
        extra = self.extra()
        categories = extra["blinded_review"]["categories"]
        categories.append({"name": "visual", "vector_score": 24, "codex_score": 25, "maximum": 40})
        with self.assertRaises(AssertionError):
            build_brief.validate(self.data)

    def test_missing_native_role_rejected(self):
        extra = self.extra()
        extra["vector"]["native_roles_observed"] = 6
        with self.assertRaises(AssertionError):
            build_brief.validate(self.data)

    def test_different_gate_count_rejected(self):
        extra = self.extra()
        extra["vector"].update(checks_passed=53, checks_total=53)
        with self.assertRaises(AssertionError):
            build_brief.validate(self.data)

    def test_neutral_complete_result_can_fail_quality(self):
        extra = self.extra()
        extra["quality_gate_met"] = False
        extra["vector"].update(checks_passed=50)
        del extra["blinded_review"]
        build_brief.validate(self.data)


if __name__ == "__main__":
    unittest.main()
