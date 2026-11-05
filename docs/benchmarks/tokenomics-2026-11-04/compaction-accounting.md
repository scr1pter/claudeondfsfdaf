# V2 compaction spend accounting

The `compaction-accounting` candidate fixes an omitted charge in the V2 session runner. Its source base is `587be6478aff24e2cdf98192269bc2bd3ca755bd`. The commit containing this report is the candidate freeze; no headless holdout task, gold implementation, or evaluation details were inspected while developing it.

The existing summary call already published its cost in durable compaction events and session totals. It now records that same call once in the existing process-global spend guard, using `SessionRunnerModel.spendStep` for priced, unknown, incomplete, and guaranteed-free classification. A linked session charges its launching root. The helper consumes one run step without resetting spend, step counters, or the agent's ordinary turn allowance.

The runner checks a stopped guard at recursive turn entry and after a failed or blank automatic summary. Compaction also checks the root immediately before invoking the model. A summary that reaches a spend, step, or unpriced limit cannot launch an ordinary continuation, including the overflow-recovery path.

Cancellation and defects settle the durable terminal event and guard accounting before propagating the original cause. Complete usage received before a later failure retains its known cost. An invoked call without usage remains incomplete, with zero stored cost and an unpriced marker. A call canceled before model invocation consumes neither a guard step nor a durable usage charge. Durable publication precedes the live spend notification; a failing listener cannot remove the terminal usage record or replace an original stream interruption. Event replay rebuilds session totals without charging the guard again.

Summary prompts, model selection, context limits, retention, reasoning settings, and provider-call count are unchanged. This is a V2 accounting correction. The separate paid R1 CLI experiment uses the legacy runner; none of its costs or savings are attributed to this candidate.

## Offline validation

Validated on Windows with Bun 1.3.14. Dependencies were installed in the isolated worktree with the frozen lockfile. The initial install encountered the unrelated `tree-sitter-powershell` native build's missing Visual Studio toolchain; `bun install --frozen-lockfile --ignore-scripts` completed. No lockfile or dependency source changes are included.

- Negative control: the updated tests with both production files restored to the source base produced **0 pass, 8 fail**. The failures cover the missing $0.21 guard charge, successful and blank summaries reaching dollar or step limits, overflow continuation, and cancellation settlement.
- Positive control: the same eight tests against the fix produced **8 pass, 0 fail**.
- Final regression suite: **281 pass, 0 fail**, with **1,042 assertions** across 11 files. This includes 17 new runner cases and the strengthened existing $0.21/replay fixture.
- `bun typecheck` passed in both `packages/core` and `packages/engine`.
- Targeted Prettier checks and `git diff --check` passed. Targeted Oxlint reported zero errors; its 35 warnings are in pre-existing code.
- Independent source review and a final root review found no remaining issues. No provider call, API credential, browser, deployment, or paid benchmark was used for this validation.

Run the negative/positive comparison's selected fixtures from `packages/core`:

```sh
bun test test/session-runner.test.ts --test-name-pattern 'compaction summary once|ordinary continuation after|recursive overflow continuation|compaction usage and failure' --timeout 30000
```

Run the full validated suite from `packages/core`:

```sh
bun test test/session-runner.test.ts test/session-compaction.test.ts test/spend-guard.test.ts test/session-runner-billed-cost.test.ts test/session-run-coordinator.test.ts test/session-execution-local.test.ts test/session-runner-tool-registry.test.ts test/session-runner-tool-events.test.ts test/session-runner-recorded.test.ts test/session-runner-model.test.ts test/session-runner-message.test.ts --timeout 30000
bun typecheck
```

Run the integrated check from `packages/engine`:

```sh
bun typecheck
```

These fixtures exercise the actual runner and guard with deterministic local LLM streams. They establish accounting and control-flow behavior, not measured efficiency or quality improvements on a paid task.
