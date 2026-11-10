"""Closed funding profiles; selecting the heavy study cannot widen old policy."""
from dataclasses import dataclass

from native_team_policy import require

BASELINE_PHASE = "foundry-large-single-agent-high-v1"
HEAVY_PHASE = "heavy-matched-teams-high-v1"
ADDITIONAL_PHASE = "heavy-additional-20-v1"
ADDITIONAL_PLAN_SHA256 = "b91f3cfdd0738299f44ffa23e9a8850ca5751665a521859cf5c1fc2507ee0d5d"
ADDITIONAL_ACTOR_BASELINES = {"diagnostics": 0.3693985, "foundry-codex": 8.9592263, "foundry-vector": 17.6761006, "saas-codex": 1.0112827, "saas-vector": 1.5630869}
ADDITIONAL_ACTOR_CAPS = {**ADDITIONAL_ACTOR_BASELINES, "foundry-vector": 37.6761006, "foundry-codex": 34.6892263}
ADDITIONAL_LIABILITIES = {"foundry-vector": 0.0, "foundry-codex": 5.73}
ADDITIONAL_HISTORY_HASHES = {"admissions-v2.jsonl": "8c5e564e270e2f42da67fc3a3266a75b797df946e6b2e82448650564db8e6605", "receipts.jsonl": "5b23b213590b9bf6d256f8146e57b71c8a1c06e6992e997f85bc886e5495d9b0", "status.json": "350794f9d170818a854fd850776e9b6391c5c2b150d7deb90dde087d7946f069", "phase-allocation-v5.json": "8b3bdc5436b37df44e9fa582d2782d61fa85ca548c992d208d43f130b76eda5c"}
ADDITIONAL_REQUEST_SHA256 = "bf9701d300414db23526c714e969a8a85537bf60a4231b4268413bb1c3517679"
HEAVY_PLAN_SHA256 = "5f75ba025ae3d4f3cde51b4d85586df63fee00e76fdcc300dc1ecd530a0e4c6e"


@dataclass(frozen=True)
class FundingProfile:
    phase: str
    actor_caps: tuple
    minimum_requests: int
    minimum_usd: float
    plan_sha256: str | None = None
    repair_threshold_usd: float = 3
    study_cap_usd: float = 48
    new_round_usd: float | None = None
    historical_liability_usd: float = 0

    def actor_cap(self, actor):
        return dict(self.actor_caps)[actor]


def funding_policy(name=None):
    if name == ADDITIONAL_PHASE:
        return FundingProfile(ADDITIONAL_PHASE, (("foundry-vector", 37.6761006), ("foundry-codex", 34.6892263)),
                              1340, 29.579095, ADDITIONAL_PLAN_SHA256, 13.84808545, 55.309095, 20, 5.73)
    if name is None or name == BASELINE_PHASE:
        return FundingProfile(BASELINE_PHASE, (("foundry-vector", 20), ("foundry-codex", 20)), 449, 11.2319408)
    require(name == HEAVY_PHASE, "unapproved funding profile")
    return FundingProfile(HEAVY_PHASE, (("foundry-vector", 24.73654725), ("foundry-codex", 20.31968465)), 889, 20.3038291, HEAVY_PLAN_SHA256, 13.84808545)
