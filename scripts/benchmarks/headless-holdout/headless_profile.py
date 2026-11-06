"""Instruction-only variant of the frozen R1 seven-role native profile.

The frontend_worker identifier remains a fixed native identity. The browser
tool and its safety policy remain available for optional use. This task asks
for CLI/SDK/API workflows, so verification targets those requested interfaces.
This module imports no adapter, credentials, runtime or provider.
"""
import copy
import hashlib
import json
import os
from pathlib import Path

BASE_PROFILE = json.loads((Path(__file__).parent / "r1-profile.json").read_text(encoding="utf-8"))
PROFILE = copy.deepcopy(BASE_PROFILE)
COMMON = os.path.commonprefix(list(BASE_PROFILE["instructions"].values()))
CHANGED_ROLES = ("lead", "frontend_worker", "qa_specialist", "team_judge")


def replace(role, before, after):
    assert before in PROFILE["instructions"][role], "frozen instruction anchor changed"
    PROFILE["instructions"][role] = PROFILE["instructions"][role].replace(before, after)


replace("lead", "Agree API/data/UI boundaries", "Agree API/data/CLI/SDK boundaries")
replace("lead", "personally verify the final API and UI using the common browser client",
        "personally verify the final API, CLI and typed SDK using local commands and the client module")
PROFILE["instructions"]["frontend_worker"] = COMMON + (
    "You are the fixed CLI/SDK/API client worker; your native identity remains frontend_worker. "
    "Own only CLI/client/type declaration files assigned by the lead. Agree the complete API contract before edits. "
    "Build every connected command and typed client workflow with usable output, errors and complete states. "
    "Verify the CLI and SDK against the running API, and report evidence and material gaps. "
    "Do not delegate or edit backend/shared files."
)
replace("qa_specialist", "connected API and browser workflows", "connected API, CLI and typed SDK workflows")
replace("team_judge", "security, accessibility and", "security, CLI usability, SDK type accuracy and")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


BASE_PROFILE_SHA256 = digest(BASE_PROFILE)
PROFILE_SHA256 = digest(PROFILE)
assert {key: value for key, value in BASE_PROFILE.items() if key != "instructions"} == {
    key: value for key, value in PROFILE.items() if key != "instructions"}
assert [role for role in BASE_PROFILE["instructions"] if BASE_PROFILE["instructions"][role] != PROFILE["instructions"][role]] == list(CHANGED_ROLES)
assert PROFILE["nativeAutonomousIdentities"] == 7 and PROFILE["maxDepth"] == 2
assert PROFILE["contextLimit"] == 1050000 and PROFILE["outputCeiling"] == 32000
assert PROFILE["reasoning"] == "high"

if __name__ == "__main__":
    print(json.dumps({"kind": "headless-instruction-profile-v1", "sourceProfileSha256": BASE_PROFILE_SHA256,
        "profileSha256": PROFILE_SHA256, "instructionRolesChanged": list(CHANGED_ROLES),
        "allNonInstructionFieldsIdentical": True, "browserAvailabilityUnchanged": True,
        "runtimeQualified": False}, indent=2))
