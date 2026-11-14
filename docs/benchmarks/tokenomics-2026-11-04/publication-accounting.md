# Legacy terminal-publication guard accounting

The `publication-accounting` candidate starts from `94c27c67185bbce343e0fa0eac4ec60bb801e343`. It addresses the publication-defect spend-guard limitation documented by that earlier candidate. Frozen paid-study source, generated applications, evaluators, and results remain unchanged. No paid-study savings are attributed to this correction.

A terminal step can report its bill before a durable part, message, or pending reasoning update defects. The existing processor clears its started-attempt marker before those publications. An actual failing durable projector reproduces a missing guard charge even though the assistant's recorded subtotal and overall usage retain the known bill. Ordinary live durable-event listeners isolate non-interruption failures, so these fixtures exercise the real transaction/projector failure boundary instead.

The correction adds a local flag before entering the existing guard-recording path. If settlement fails before that entry, a single financial-only fallback uses the same cost, billed/unknown classification, token counters, session ownership, and cost-kind calculation. It adds no loop evidence, claims no file progress, and does not replace the original turn failure with a budget-stop error. A secondary fallback notification failure cannot replace the original publication cause or interruption.

Once recording has been entered it is never retried: the guard updates its ledger before publishing live spend notifications, so a notification defect can follow a successful charge. A linked child still charges its original launching run when the parent starts another run. The fallback adds no model request, retry loop, executor, registry, settings change, cap waiver, or counter reset.

The guarantee is limited to failures before guard-recording entry. It does not promise recovery when guard implementation or storage itself fails. A rolled-back terminal-part transaction remains absent: its SessionInfo part-derived subtotal can remain zero while the assistant/global subtotal and the guard retain the bill. The correction does not retry durable writes or pretend they succeeded. Later cleanup and persistence remain subject to their existing behavior.

## Validation

All checks use actual processor/guard services with deterministic local LLM fixtures, real durable projectors and live notification listeners. No external provider inference, browser, paid benchmark execution, or benchmark application repair was used.

The suites below overlap; their counts are not additive.

- Initial negative control against unchanged `94c27c6`: **12 fail, 4 pass** across 16 fixtures. The 12 failures cover part, message and reasoning publication defects with priced/unknown usage in root/linked sessions. The four passing post-record notification controls establish the no-double-charge boundary.
- Expanded corrected controls: **24 pass, 0 fail**, with **252 assertions**. Additional cases cover a primary publication defect followed by a secondary spend-notification defect, and publication self-interruption. Fixtures assert original causes, unknown usage, exactly one charged step, retained old-run ownership, and the honest absence of a rolled-back terminal part.
- Processor, overall usage, and ancillary usage regression suite: **109 pass, 0 fail**, with **704 assertions** across three files.
- Existing prompt cancellation, run guards, budgets, unknown usage, task-manage abort, and background cancellation checks: **37 pass, 8 existing skips, 0 fail**, with **160 assertions** across three files. The skips are the existing Windows exclusions and explicitly skipped fixtures.
- Final restored-source control set: **32 pass, 0 fail**, with **324 assertions**, combining all 24 new controls and the eight existing `94c27c6` cancellation, cap, ownership, and loop-confirmation controls.
- `bun typecheck` passed in `packages/engine`. Targeted Prettier and `git diff --check` passed. Targeted Oxlint found zero errors and seven pre-existing warnings, with no new warnings.
- Independent source review found no blocking regression. The review explicitly checked original-cause precedence, the entry flag, unchanged classification, preserved loop history, and the durable-write limitation.

Dependencies were installed in the new isolated worktree using the frozen lockfile with installation scripts disabled, followed by the existing local preparation scripts. No dependency manifest, lockfile, vendor file, frozen candidate, or shared installation is changed by this commit.

Run the new controls from `packages/engine`:

```sh
bun test test/session/processor-effect.test.ts --test-name-pattern 'publication defect retains terminal accounting' --timeout 30000
```
