# A24: production benchmark gate

A23 is implemented at `7a7c664d`. Before changing app session or timeline source for A24, this preparation ports the reviewed production benchmark job from `approved-fixes` (PR #19), including its step-scoped trace directory. It also ports the existing child-navigation fixture correction: the task now renders as a phase chip, and modifier-click opens its session.

The manual `test.yml` input `production_benchmark=true` builds the production app and runs the existing three first-navigation scenarios three times each with one Chromium worker. Its engine and provider responses are local browser fixtures. The job preserves the source SHA, run identity, metrics and raw traces. Ordinary browser discovery still excludes the performance directory; this does not restart the parked parity benchmark branch.

Preparation validation: the workflow parses and its production benchmark job exactly matches the reviewed job; formatting and diff whitespace checks pass; the existing first-navigation metrics unit file passes both cases. App types are included in the mandatory pre-push hook. No A24 production source has been changed. The actual baseline must succeed and be recorded here before those edits begin; the same benchmark must run after A24 for comparison, without machine-specific timing thresholds.

## Recorded baseline

The production benchmark job **passed all nine runs** on source `ad1878309645adb5409e02bab678b145b73b7d3b`, before any A24 app edits. [Workflow 41256445800](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/41256445800), job `124700512313`, artifact `13063443541`. The artifact's `source.json` confirms Node 24.15.0, `mockStressTimeline`, and no provider requests. All runs reported zero blank and unknown samples.

The complete metrics, including every sample, are preserved in `evidence/codium-a24-baseline-ad187830.json`. The original 15,665,835-byte ZIP is saved at `/workspace/attachments/edc5e895-65fc-4b73-9966-cb2811ffa03f/codium-a24-baseline-ad187830.zip`. ZIP SHA-256: `678ecd94ae9477cfe75d32ce7d822a5e2ae8d3e98488094a718735d5fabfed27`, matching GitHub's artifact digest. The GitHub artifact expires on November 15; the local ZIP preserves its raw traces beyond that date. The redundant 234 MB extracted cache was removed after evidence preservation because the shared workspace was almost full.

| Scenario                                                  | First destination, median ms | Stable destination, median ms |
| --------------------------------------------------------- | ---------------------------: | ----------------------------: |
| opens an unvisited task without a blank frame             |                        169.6 |                         188.4 |
| opens the new session page before its lazy module is used |                        198.7 |                         340.8 |
| opens a child session without a blank frame               |                        136.0 |                         230.4 |

These observations are a baseline, not machine-independent thresholds. A24 must run and compare the same production scenarios after its source changes. The A23/preparation push passed the mandatory 23-package typecheck hook; scoped CI is still completing its HTTP exerciser/generated-client steps. The unrelated native billing-fixture timeout was fixed separately in `67e3161e` without changing production source.

## A24 comparison

The production benchmark **passed all nine runs** on A24 source `b4c05481fcd493e602b49d4b07f78688f2d4650f`: [workflow 41259171922](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/41259171922), job `124708671285`, artifact `13065165140` (`production-app-benchmark-b4c05481fcd493e602b49d4b07f78688f2d4650f-1`). The same three scenarios ran three times under Node 24.15.0 with the same fixture and no provider calls. Every run again reported zero blank and unknown samples. No retry was needed.

All raw metric samples were recovered losslessly from the job's `BENCHMARK` JSON lines and committed as `evidence/codium-a24-after-b4c05481.json`. The 15,465,495-byte artifact also holds the raw traces. GitHub reports archive SHA-256 `1fded575ad69158c3ebbd7754d531afef252c39a0631601ac41d9c707257a99c`; this archive was not downloaded locally due to disk pressure, so this digest is remote metadata rather than a local verification. The remote artifact expires November 15, 2026; the committed metrics remain available afterwards.

| Scenario         | First destination median, before → after ms | Stable destination median, before → after ms |
| ---------------- | ------------------------------------------: | -------------------------------------------: |
| unvisited task   |                               169.6 → 153.4 |                                188.4 → 167.7 |
| new session page |                               198.7 → 178.9 |                                340.8 → 276.2 |
| child session    |                               136.0 → 122.7 |                                230.4 → 206.6 |

The comparison shows no observed regression: first destination medians are 9.6–10.0% lower, and stable destination medians are 10.3–19.0% lower. These are three-sample hosted-run observations, not a performance improvement claim or a new timing threshold. The zero blank/unknown-frame invariant holds in both runs.

The subsequent `44c35f1c530d76558c93f308576d342a5629d9ec` correction changes exactly `packages/app/e2e/regression/codium-usage-labels.spec.ts` and `docs/vector/build/codium-a24-app-usage-notes.md`. Its diff from the measured source contains no production app, performance harness, shared benchmark fixture, build configuration or lockfile changes. The corrected mixed-usage browser fixture is not a benchmark input. Therefore the production comparison applies unchanged; the mixed-session browser regression must separately pass on the corrected head.

That mixed-session browser regression passed in job `124710252023` at `44c35f1c`. The next repair, `9c5bc861`, changes only `packages/app/src/features/agents/host-locally-model.test.ts` and `packages/engine/test/server/httpapi-session.test.ts`; these native assertions are also outside production and benchmark inputs. The complete `b4c05481..9c5bc861` diff is exactly those four files. This evidence-only follow-up adds the raw after metrics and notes; it changes no executable input to the measured app or benchmark.
