# A24: production benchmark gate

A23 is implemented at `7a7c664d`. Before changing app session or timeline source for A24, this preparation ports the reviewed production benchmark job from `approved-fixes` (PR #19), including its step-scoped trace directory. It also ports the existing child-navigation fixture correction: the task now renders as a phase chip, and modifier-click opens its session.

The manual `test.yml` input `production_benchmark=true` builds the production app and runs the existing three first-navigation scenarios three times each with one Chromium worker. Its engine and provider responses are local browser fixtures. The job preserves the source SHA, run identity, metrics and raw traces. Ordinary browser discovery still excludes the performance directory; this does not restart the parked parity benchmark branch.

Preparation validation: the workflow parses and its production benchmark job exactly matches the reviewed job; formatting and diff whitespace checks pass; the existing first-navigation metrics unit file passes both cases. App types are included in the mandatory pre-push hook. No A24 production source has been changed. The actual baseline must succeed and be recorded here before those edits begin; the same benchmark must run after A24 for comparison, without machine-specific timing thresholds.

## Recorded baseline

The production benchmark job **passed all nine runs** on source `ad1878309645adb5409e02bab678b145b73b7d3b`, before any A24 app edits. [Workflow 41256445800](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/41256445800), job `124700512313`, artifact `13063443541`. The artifact's `source.json` confirms Node 24.15.0, `mockStressTimeline`, and no provider requests. All runs reported zero blank and unknown samples.

The complete metrics, including every sample, are preserved in `evidence/codium-a24-baseline-ad187830.json`. The original 15,665,835-byte ZIP is saved at `/workspace/attachments/edc5e895-65fc-4b73-9966-cb2811ffa03f/codium-a24-baseline-ad187830.zip`; extracted logs and raw Chrome traces are at `/workspace/.cache/codium-a24-baseline-ad187830`. ZIP SHA-256: `678ecd94ae9477cfe75d32ce7d822a5e2ae8d3e98488094a718735d5fabfed27`, matching GitHub's artifact digest. The GitHub artifact expires on November 15; the local copy preserves it beyond that date.

| Scenario | First destination, median ms | Stable destination, median ms |
| --- | ---: | ---: |
| opens an unvisited task without a blank frame | 169.6 | 188.4 |
| opens the new session page before its lazy module is used | 198.7 | 340.8 |
| opens a child session without a blank frame | 136.0 | 230.4 |

These observations are a baseline, not machine-independent thresholds. A24 must run and compare the same production scenarios after its source changes. The A23/preparation push passed the mandatory 23-package typecheck hook; scoped CI is still completing its HTTP exerciser/generated-client steps. The unrelated native billing-fixture timeout was fixed separately in `67e3161e` without changing production source.
