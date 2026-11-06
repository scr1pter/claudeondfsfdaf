# Postlaunch keyboard correction, revision 2

The original mobile check pressed Tab once from whatever control the preceding
Events check had focused. On Chrome, tabbing from the final page control can move
focus into browser chrome: `document.activeElement` is then `body`. The next Tab
returns to the first native field. That ordinary transition was incorrectly
reported as "No keyboard-focusable dashboard control".

This correction was made after the first paid pair and Vector repair had
settled. The original task digest was
`722a00ba024522e2e88aee585f778dad206b115a30a8d1caded38681cf7cd761` at Git
`44f93362a683d39198ead037beb639abc828fb63`. Original charged results, repair
results, candidate sources, and spending remain historical records. This is an
explicit instrument revision, not a silent replacement or a product repair.

`original/` preserves the original checker, controls, Python controls,
prelaunch validation, and root freeze manifest byte-for-byte. `provenance.json`
records their SHA-256 hashes and byte lengths. The archived manifest is named
`original-manifest.json` so the reviewed v2 freeze includes it. The original root
manifest was verified against that archive before replacement. The current root
manifest records the reviewed v2 instrument and the complete revision history.

## Revised check

Only the mobile keyboard contract changes. The horizontal-overflow check, the
other seven browser contracts, and all sixteen API assertions are unchanged.

1. Use an ordinary pointer click on the visible Workflow Runner heading.
2. Count actual visible native focus candidates, then allow that count plus two
   Tab presses, capped at 200. Body/browser-chrome transitions are allowed.
3. Use native Tab presses and read-only focus observations to verify that all
   four required controls are reachable: Workflow name, Concurrency, Workflow
   definition, and Create workflow. Their relative DOM order is unrestricted.

The check never calls DOM `focus()`, modifies tabindex, or accepts an unrelated
focusable button as proof that the form is keyboard accessible.

## Free controls

`browser-control-results.json` records three 8/8 positive browser controls:
ordinary UI, delayed form mounting, and the real wrap layout with the final
Events button initially focused. A form whose four controls are all excluded
from native Tab order passes the other seven checks and fails the keyboard
check. The missing-label negative also remains rejected.

`focus-proof.cjs` reproduces the original assumption with a real native form in
a fresh owned Chrome profile. Its published `focus-proof.json` shows the first
Tab landing on body, the next Tab reaching Workflow name, the corrected helper
reaching all four controls, and the inaccessible-form negative remaining
unreachable. It uses the same exact-origin forwarding proxy and contains no
private workstation paths or credentials.

Run from this revision directory, supplying local tool paths as arguments:

```text
node focus-proof.cjs --playwright <playwright-module> --chrome <chrome-executable> --proxy-module <reviewed-proxy-module>
```

From the task root, run the pure controls with
`python -m unittest test_controls.py`, and run the complete synthetic browser
controls with `node browser-controls.cjs --out <scratch-output> --playwright
<playwright-module> --chrome <chrome-executable>`.

No model calls, Bun runs, provider calls, application changes, or complete
candidate reevaluations were performed by this revision author. The study owner
subsequently reevaluated Codex's first submission, Vector's first submission,
and Vector's repair using the same corrected instrument. All three passed
16/16 API groups and 8/8 browser groups with exit code 0 and authored source
unchanged. See [the sanitized reevaluation record](unchanged-candidate-reevaluations.json).

The original Vector repair charge remains in the measured episode. Corrected
functional acceptance does not establish the preregistered aggregate cost and
blinded quality objective; the study's paid-results report remains separate.
After review, the study owner authorized the v2 root freeze and publication.
