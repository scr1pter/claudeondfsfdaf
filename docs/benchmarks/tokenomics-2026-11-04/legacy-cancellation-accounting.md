# Legacy completed-step cancellation accounting

The `legacy-step-accounting` candidate starts from `1a3d07c4a947674c3db68f6bbc7690a8c0288587`. It corrects one confirmed Legacy spend-guard omission. The frozen R2 source and paid results are unchanged; no R3 task requirements, evaluation details, or gold implementation were inspected while developing this change.

Legacy already persisted a completed provider step's bill in its message, session total, and overall usage. Cancellation during that publication could arrive before `SessionProcessor.recordStep`, after `ctx.started` had been cleared. Cleanup then had no started attempt to settle, leaving the spend guard at zero dollars and zero steps despite a durable $0.315 bill. The deterministic baseline fixture reproduces exactly that mismatch.

The existing mandatory settlement region now includes guard recording. The optional snapshot confirmation stays interruptible: its exit is captured, the real bill and step are recorded once, and the original confirmation interruption propagates before a budget-stop turn error is assigned. A restored checkpoint also delivers cancellation already pending after accounting when a cap verdict bypasses snapshot confirmation. This does not promise precedence over cancellation arriving later than that checkpoint.

A linked child's completed step continues to charge its launching run if its parent starts another run. Priced and unknown usage keep their existing classification. Normal confirmed file changes still clear loop history, and unchanged results still trigger the existing loop decision. Spend, step counts, caps, model calls, prompt/context contents, quality tools, reasoning settings, and thresholds are not reset or relaxed.

This correction is limited to cancellation and snapshot confirmation. A non-interruption defect in message, part, or reasoning publication can still exit before guard recording; that pre-existing publication-defect limitation is not claimed fixed here. The closed R2 Vector receipts contain no disconnected provider requests, and no R2 savings are attributed to this candidate.

## Validation

All validation uses local deterministic LLM fixtures and temporary workspaces. No provider call, credential, browser, funded task, or benchmark application edit is involved.

- Negative controls against the unchanged source base: **2 pass, 6 fail**, across eight new cases. The six failures cover priced/unknown root and linked-child publication cancellation, plus cancellation while a loop candidate's snapshot is pending. The two passing controls establish unchanged normal file-change and loop behavior.
- The loop fixtures establish history through three actual processor/provider steps. They do not prepopulate an invented guard ledger. Cancellation must return without releasing the blocked snapshot; a renewed parent run remains uncharged while the old launch ledger retains all three bills. A separate pending-cap variant verifies the latest cap and the cancellation turn error.
- Processor, overall usage, and ancillary title usage regression suite: **85 pass, 0 fail**, with **452 assertions** across three files.
- Prompt cancellation, run guards, budgets, unknown usage, and task-manage abort checks: **35 pass, 8 existing skips, 0 fail**, with **154 assertions** across two files. The skips are the existing Windows exclusions and explicitly skipped fixtures.
- Final source verification after lint cleanup: **15 pass, 0 fail**, with **110 assertions**, covering all eight new controls plus existing processor/background cancellation tests.
- `bun typecheck` passed in `packages/engine` on the final source. Targeted formatting and `git diff --check` passed. Targeted Oxlint found no errors or newly introduced warnings.
- Independent source review found no blocking regression. Review explicitly includes interruptible confirmation, pending cancellation at the checkpoint, linked ownership, and the publication-defect scope limitation.

The isolated dependency install uses the frozen lockfile. The Windows native `tree-sitter-powershell` rebuild requires an unavailable Visual Studio toolchain. An incomplete local install also omitted dependency package files; the SDK extraction was refreshed, and 18 missing regular keymap files were restored from the successful isolated base install after verifying identical lockfiles, package manifests, and every existing file. No dependency manifest, lockfile, vendor file, or shared installation is included in the change.

Run the selected negative/positive controls from `packages/engine`:

```sh
bun test test/session/processor-effect.test.ts --test-name-pattern 'cancelled during publication|billed loop candidate' --timeout 30000
```
