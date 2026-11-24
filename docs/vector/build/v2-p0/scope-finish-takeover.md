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

## 2026-11-23, the fix panel retired itself when any folder's instance was disposed

**Bug.** `LocalFixPanel` (app `features/vectorscope/local-fix-panel.tsx`) retired its controller on every `server.instance.disposed` event without looking at the event's folder. The engine sends that event for every instance it disposes: an isolated task's worktree retiring (`task/isolation.ts`), a worktree removed or reset, another project's reload. Retiring calls the controller's `dispose`, which aborts a running approved step (apply, checks, commit or push, with an unknown result) and cancels the prepared fix checkout. The panel's own copy promises this only for a reconnect or a settings change.

**Fix.** `localFixRetires` keeps `server.connected` and `global.disposed` unconditional and takes `server.instance.disposed` only when the event names the conversation's own folder (compared with `pathKey`), as the connect panels already do.

**Test.** app `src/features/vectorscope/local-fix-panel.test.tsx`, "another folder's instance disposal keeps the prepared fix; this folder's retires it and cancels the fix". It renders the real `LocalFixPanel` against a fake server SDK: its event emitter is driven by the test and its generated client answers from the recording fake engine the view tests use. A disposal named `/other` or `/repo/worktrees/task` sends nothing and keeps the preview. A disposal named `/repo` cancels `fix_0123abcd`, clears the preview and lists again. A reconnect named `global` retires it too.

**Mutation check.** With the folder comparison dropped (any `server.instance.disposed` retires), the case fails (8 pass, 1 fail); restored, 9 pass.

Left as a follow-up: `LocalReviewPanel` (`local-review-panel.tsx`, also on main) has the same unscoped listener. There it only clears and lists the review results again, with nothing to abort or cancel.

## 2026-11-23, the V2 session API sent a review session's prompt unheld under zdr

**Bug.** Only the engine's V1 routes hold a `vectorscope.*` session to its review's privacy (`holdReview`, then `ReviewRoutes.hold` and `turn`). The V2 routes in the server package (`packages/server/src/handlers/session.ts`) admitted a prompt of such a session and ran it through `@vectordevai/llm`, which nothing holds. With the user config's `review.privacy: "zdr"`, a client driving a review session over `POST /api/session/:id/prompt` could send the reviewed code to a route that keeps data. The lane had pinned this as a known limit (`vectorscope-deviations.md`, Decision 12) and left it to the lead.

**Lead ruling.** The deviations log's own plan, which is the safest option that closes it: refuse V2 admission of a `vectorscope.*` session while its review policy is "zdr". The policy is `ReviewRoutes.zdr(sessionID)` or the server policy from the user config (`ReviewRoutes.serverPolicy`), as V1's `holdReview` reads it. The engine gives it to the server package through a new core port, `ReviewSessionAdmission` (core `review/session-admission.ts`; engine `review/session-admission.ts`, registered in the engine's server layer). A host without the port treats the session as "zdr" (fail closed). The refusal covers the three V2 routes that make model calls for a session: prompt, free-model resume and compaction. It is a 403 sent before anything is stored or sent. Sessions that are not review sessions, and review sessions under "standard", are admitted as before.

**Test.** engine `test/server/httpapi-review-privacy.test.ts`. The old pin is replaced by "under zdr the V2 session API refuses a review session's prompt and compaction before anything is sent": both answer 403, the session is idle, nothing is registered, the fake model server got 0 calls, and an ordinary session is still admitted. The new case "under standard the V2 session API admits a review session's prompt as before" keeps the standard path open (and fails if the port is missing).

**Mutation check.** With the prompt route's refusal removed, the zdr case fails (expected 403, received 200; 6 pass, 1 fail); restored, 7 pass.
