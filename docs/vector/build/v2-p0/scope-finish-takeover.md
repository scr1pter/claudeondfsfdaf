# scope-finish takeover: review fixes for the VectorScope lane (#73)

Branch `scope-finish` (PR #73). By the owner's decision this v2 run took #73 over: it fixes what the round-1 review of the lane confirmed, then brings the PR to ready. No feature flag changes, no public claims. Each entry names the bug, the test that fails without the fix, and the mutation check.

## 2026-11-23, saved local reviews with offline-diagnostic findings read back as corrupt

**Bug.** This PR adds `Finding.diagnostics` (core `review/types.ts`): `withDiagnosticEvidence` (core `review/diagnostic.ts`) records which offline rule a model finding cites at its own anchor. Under the hidden global `review.diagnostics: "offline"` on Linux, `Review.run` applies it to every normalized finding, and the field rides through selection into the inline, nits, outside-diff, elsewhere and overflow rows, and into `report.findings` when lenses are on. `redactDiagnosticData` rewrites strings only, so the key is saved. The retained-result decoder (core `review/local-result.ts`) had no `diagnostics` field and decodes with `onExcessProperty: "error"`, so `ReviewLocalRun.load` answered "The saved local review outcome is invalid." for every get, stop and retry, and the desktop, memory-outcome and memory-authority dropped the paid result. The strict guardrail is not affected: `postableStrict` rebuilds its findings without the field.

**Fix.** `diagnostics` is an optional list of `{ source: "offline-v1", rule }` on both the selection rows and the report's findings, with the rule limited to the keys of `OFFLINE_DIAGNOSTIC_RULES`. An unknown rule, another source or an extra key still refuses the whole result.

**Test.** core `test/review/local-result.test.ts`, "findings that carry offline-diagnostic provenance round-trip in every selection list and the report": it builds the findings with the real `withDiagnosticEvidence` and `selectFindings`, saves the result as JSON and decodes it through `decodeLocalResult` and `decodeLocalRun` (completed and failed). It also checks the three rule literals and the refusals above.

**Mutation check.** With `diagnostics` removed from the decoder again, the case fails (26 pass, 2 fail with the next entry's mutation); restored, 28 pass.

## 2026-11-23, a failed run re-derived a retained stop's verdict with an invented model error

**Bug.** The engine marks a local run failed whenever its result has an error (`local-run.ts`). `decodeLocalRun` then threw away the retained verdict of any non-completed run and rebuilt it from the outcome with `partial ?? "model-error"`. A held-back-only stop and an empty-reviewer stop leave `partial` unset, because no model ran, so the panel showed a `model-error` cause that never happened.

**Fix.** For a failed run whose result is a retained service stop (exit 2 with its error, and a verdict `decodeLocalResult` already checked as canonical and not clean), `decodeLocalRun` shows that verdict. Running, cancelled and other lifecycle states keep the lifecycle's own cause.

**Test.** core `test/review/local-result.test.ts`, "a failed run shows a retained stop's own verdict, never an invented model error": the held-back and empty-reviewer stops decode as failed runs with the stored verdict and no `model-error` cause; a running run still shows `timeout`.

**Mutation check.** Without the retained-stop branch the case fails; with it, it passes.

## The known exit-2 bug (engine saves error with outcome, core refused it)

On main, engine `cli/cmd/review.ts` returns `{ exitCode: 2, error, target, outcome }` when every reviewer fails, and core `local-result.ts` refused any result that carries an error together with an outcome, so a retained "could not finish" local run could never be read back. On this branch, commits `fe969458` and `d70cb4b0` (2026-11-22) already accept the retained privacy, held-back, batch, failed-reviewer and empty-reviewer stops, with their tests in core `test/review/local-result.test.ts` ("retained local review result decoding"). This run keeps them intact and adds the verdict fix above. Ruling: the fix lands with #73; nothing on main is changed separately.
