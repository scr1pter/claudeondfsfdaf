"""Closed funding profiles; selecting the heavy study cannot widen old policy."""
from dataclasses import dataclass

from native_team_policy import require

BASELINE_PHASE = "foundry-large-single-agent-high-v1"
HEAVY_PHASE = "heavy-matched-teams-high-v1"
HEAVY_PLAN_SHA256 = "5f75ba025ae3d4f3cde51b4d85586df63fee00e76fdcc300dc1ecd530a0e4c6e"


@dataclass(frozen=True)
class FundingProfile:
    phase: str
    actor_caps: tuple
    minimum_requests: int
    minimum_usd: float
    plan_sha256: str | None = None
    repair_threshold_usd: float = 3

    def actor_cap(self, actor):
        return dict(self.actor_caps)[actor]


def funding_policy(name=None):
    if name is None or name == BASELINE_PHASE:
        return FundingProfile(BASELINE_PHASE, (("foundry-vector", 20), ("foundry-codex", 20)), 449, 11.2319408)
    require(name == HEAVY_PHASE, "unapproved funding profile")
    return FundingProfile(HEAVY_PHASE, (("foundry-vector", 24.73654725), ("foundry-codex", 20.31968465)), 889, 20.3038291, HEAVY_PLAN_SHA256, 13.84808545)
