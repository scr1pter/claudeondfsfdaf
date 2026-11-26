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

**Restart follow-up, 24 November.** The engine now records a sticky hold before a V1 review prompt and when it creates a held review pass. Stale session update events preserve that bit. V2 checks the stored hold and existing V1 user review scope before it admits prompts, free-model resumes or compaction. V1 commands on a newly marked review also require a live ZDR policy. The HTTP regression cases use a fake provider and verify no input is queued or sent under global standard after the live policy is gone. Older engine sessions that never stored either privacy marker remain unclassified.

## 2026-11-23, holdback "secrets" sent instruction files and review rules unredacted

**Bug.** Under the hidden `review.holdback: "secrets"`, the diff and every untrusted block were redacted, but the trusted blocks were not:

- core `safeRulePrompt` (`review/holdback.ts`) returned its input untouched unless `ruleCheck` was "strict", so `<review_rules>` (from `.vector/review.md` and review.json `paths`) and `<repository_instructions>` reached the prompt raw.
- engine `Review.run` (`review/run.ts`) spreads `input.context` into the prompt input, which carries the raw `instructions`, and replaced them only under strict.
- engine `session/prompt.ts` adds AGENTS.md and the rest (`instruction.system()`) and the Brain digest to every non-pinned `vectorscope.*` session's system prompt, with no holdback check. The read tool already redacts loaded instructions under holdback (`tool/read.ts`).
- The desktop (`ai-review.ts`) calls `safeRulePrompt` too, so it had the same gap.

So a token in AGENTS.md or `.vector/review.md` went to the provider in plain text, while the outcome said values were redacted. That breaks VS-34's "Done when": no secret-shaped string in any recorded wire body. The setting is hidden and off by default, so main's default behaviour was not affected.

**Fix.** With `ruleCheck` not strict, `safeRulePrompt` redacts the instructions, the rules and each rule part in place with `holdbackText`. No citation offsets refer to them then. Under strict, the whole-block omission stays. `Review.run` sets `instructions` from that result after the context spread whenever holdback is "secrets". In `session/prompt.ts`, a review session whose stored rules are holdback's (`holdsBack`, read as `session/tools.ts` reads them) gets its snapshot instructions mapped through `holdbackText`. The first-request estimate (`reviewFirstRequest`) does the same to its instructions, digest and recall, so the estimate matches what is sent. The desktop gets the fix through `safeRulePrompt`.

**Tests.**

- engine `test/review/run.test.ts`, "secrets redacts the instruction files, repository instructions and review rules in every request". It puts a token in AGENTS.md, one in the context's instructions and one in the rules. Unset, each token reaches a request body; under "secrets", none does and "[redacted]" stands in their place.
- core `test/review/rule-check.test.ts`, the holdback case. It used to assert that the rules pass through raw with ruleCheck off; it now asserts in-place redaction, and no change when holdback is off.
- app `src/features/pull-requests/ai-review.test.ts`, "with ruleCheck off, holdback redacts the instruction and rule blocks in place".

**Mutation checks.** Each part was reverted alone and the engine case failed every time: the `session/prompt.ts` mapping (the AGENTS.md token reached a body), the `run.ts` override (the instructions token reached a body) and the `safeRulePrompt` change (both tokens reached a body). With the `safeRulePrompt` change reverted, the desktop case also failed (0 pass, 1 fail).

**Owner recall follow-up.** The outward screen checks note text. The rendered recall also includes scope paths, which can contain a credential-shaped value. Under `holdback: "secrets"`, `withheldRecall` now applies `holdbackText` to the complete rendered block on each provider request, matching the first-request estimate. The transcript continues to store recall IDs. The fake-provider regression in `test/session/memory-every-agent.test.ts` failed on an unredacted scope path and passes with the fix. It checks the first request and a tool continuation under unset, explicit off, and secrets. The source digest advances to `79973b2a9a131847` at revision 5 under the same opt-in holdback rule below.

## 2026-11-23, --apply built fixes from the redacted outcome under offline diagnostics

**Bug.** Under `review.diagnostics: "offline"`, engine `cli/cmd/review.ts` passes `redactDiagnosticData(completed)` to the `--apply` step. That function runs `holdbackText` on every string, suggestions and patches included, so a verified suggestion holding a token-shaped literal became a patch that writes `[redacted]` into the source, which the commit step then offered to commit.

**Lead ruling.** The safest option the review offered: refuse `--apply` before anything is reviewed while diagnostics are offline (the alternative was dropping such candidates afterwards).

**Fix.** Right after the settings are merged, and before any model is resolved, `--apply` with offline diagnostics stops with `APPLY_DIAGNOSTICS_REFUSAL`: "--apply is not available while review diagnostics are offline. Nothing was reviewed."

**Test.** engine `test/cli/review-privacy.test.ts`, "--apply is refused before any review while the user config's review diagnostics are offline": exit 2 with that error, no model resolved, no review run, no fix step. The same review without `--apply` runs.

**Mutation check.** With the refusal disabled, the case fails (10 pass, 1 fail); restored, 11 pass.

## 2026-11-23, a fix could write the [redacted] placeholder over the real value

**Bug.** Under holdback "secrets" the model sees a secret-shaped value as `[redacted]`. A verified suggestion on that line that keeps the placeholder stayed a fix candidate, and nothing checked for it. Core `planEdits` (`review/fix-plan.ts`), which the CLI's `--apply` and the desktop's local fix share, would then build a patch replacing the real value with the literal placeholder (shown in the preview before consent, but a broken offered fix).

**Fix.** `planEdits` leaves out a file's fixes when the postimage holds more `[redacted]` placeholders than the head does. The reason given is "its fix writes the [redacted] placeholder into the file". A placeholder the file already holds may stay.

**Test.** core `test/review/fix-plan.test.ts`, "a fix that writes the [redacted] placeholder into a file is left out; one the file already holds may stay".

**Mutation check.** Without the check, the case fails (4 pass, 1 fail); restored, 5 pass.

**Apply follow-up, 24 November.** The CLI planner checks introduced patch lines and position-aware line replacements when the effective policy is `holdback: "secrets"`. An unchanged literal can stay, and the ordinary planner still accepts an intentional literal. The desktop removes unsafe edits from fresh and retained held findings before sharing them with Apply or GitHub. The finding and any other safe suggestions stay visible. The explicit CLI PR-posting path also drops unsafe committable suggestions under holdback or offline diagnostics while retaining the finding. Tests exercise count-equal placeholder replacement, retained findings, held posting, and unchanged default behavior.

## 2026-11-23, review pipeline pin and lane documents

**Pin.** `local-result.ts`, `holdback.ts`, `run.ts`, `session/prompt.ts` and `cli/cmd/review.ts` are pinned review pipeline sources, so core `test/review/model-evidence.test.ts` failed (36 pass, 1 fail) and printed the new digest. `REVIEW_PIPELINE_SOURCES` moved from `9f5a18170b7da7c8` to `ebb0553631c36d34`; the case then passed (37 pass). **Lead ruling:** `REVIEW_PIPELINE_REVISION` stays 5. What a default review finds or posts is unchanged: the prompt changes apply only under the hidden, off-by-default holdback "secrets", the `--apply` refusal only under the hidden offline diagnostics, and the rest is decoding and admission. The existing case "D3: unset and off send what they did" still holds byte-identical requests for unset and off. The pin is recomputed after the final main merge.

**Stale pins in the docs.** `vectorscope-continuation.md` named `102ac0ede06d9bac` and `vectorscope-remaining.md` named `31a9837d871ec207` as current; both now point at the current pin. The remaining-work note also said the V2 session path was open; it now names the refusal above.

**Absolute local paths.** The lane plan, the lane handoff, the deviations log and addendum B named the earlier container's paths (`/home/user/wt/sf/...`, `/home/user/.tools/vector-serial`, `/tmp/vector-v2/...`). They passed `test/no-personal-paths.test.ts`, since `user` is a generic name, but broke the lane rule against absolute local paths in docs. They are now repo-relative paths, `~/.tools/vector-serial`, `<worktree>` and `<scratch>`. The lane plan's and handoff's recipe for serving a dependency tarball through a local `python3 -m http.server` with `GITHUB_API_URL` pointed at it is removed; the plain `bun install` line stays.

The combined 24 November candidate pins the same 108 pipeline sources at `ec98770af384bbb8`, revision 5. Tests preserve default request bytes. The privacy and edit changes apply to recorded ZDR, opt-in holdback and offline diagnostics.
