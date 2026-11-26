# cx-github-error-label: own-key "Agent error: [object Object]" line (#98)

Branch `cx-github-error-label`, the continuation of Codex's draft PR #98 (branch `github-error-label`). This v2 run took the draft over on 2026-11-25 because it had been idle for more than a day before the Saturday 2026-11-28 deadline. No feature flag changes, no public claims.

## 2026-11-25, an own-key run printed "Agent error: [object Object]"

**Bug.** When a task or summary turn ends with an assistant error, `GithubRunHelpers.chat` (engine `cli/cmd/github.run-helpers.ts`) hands the stored error to `reportError` with the label "Agent error:" or "Summary agent error:". That error is a `{ name, data }` object, not an `Error`. On own key, `work` in engine `cli/cmd/github.agent.ts` printed it with `messageOf`, which falls back to `String(...)`, so the Actions log read `Agent error: [object Object]`. The next line (`errorLine`) already carried the real message, for example `APIError: MODEL_PLAN_RUN_LIMIT`. Codium runs were not affected: their `reportError` prints nothing, because the gateway's own words must stay out of public logs (P6).

**Fix (Codex's commit `8881cfbe`, kept as is).** On own key, when the reported value is an object that is not an `Error` and its default rendering is `[object Object]`, only the label is printed. An `Error` or a plain string still prints `label message`, as before. The Codium path is unchanged.

**Ruling.** The line stays the bare label. It does not print `name: data.message` from the object, because the following `errorLine` already prints exactly that, so it would only repeat it. This is the smallest change that removes the opaque text.

**Test.** engine `test/cli/github.agent-phase.test.ts`, "an own-key session error takes the default row": for both the failed outcome (no write) and the draft outcome (a write, then the error), the run's lines contain `error: Agent error:` exactly, do not contain `error: Agent error: [object Object]`, and still contain `error: APIError: MODEL_PLAN_RUN_LIMIT`. The provider is the test's fake LLM server; nothing reaches an external host.

**Red before.** With `cli/cmd/github.agent.ts` put back to main, the case fails: the lines hold `error: Agent error: [object Object]`. Restored, all 18 cases in the file pass.

**Mutation check.** With the comparison flipped (`message !== "[object Object]"`), the case fails (0 pass, 1 fail); restored, it passes.

**Other checks.** Engine typecheck passes. main was merged into the branch with no conflicts. The only failing check on the draft's last CI run was `computer-helper / mac-build`, cancelled after about three hours with no runner assigned (it never started); it does not build or test this file.

**Follow-up for the owner.** Open PR #106 (`publish-check-evidence`) lists this bug as a known cosmetic issue in `docs/vector/build/vector-at-mention-deviations.md`. That file belongs to #106, so this branch leaves it alone. Once #98 merges, that note should say the bug is fixed.
