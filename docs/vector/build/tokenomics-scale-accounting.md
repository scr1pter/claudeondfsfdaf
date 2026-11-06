# Accounting at logical token scale

This work checks accounting components and bounded local orchestration, with reproductions starting from source base `a35c03d`. Combined integration used the working tree based on `6680f76`, including the notification patch and additional coverage awaiting review. All provider responses are local fixtures. These checks do not establish inference quality, live cache economics, or cost savings.

## Reproduced behavior and fixes

Review admitted unaffordable finalizers because its reservation retained a model's base price after crossing an exact context tier. The corrected fixture reports exactly the predicted input context, using small request bodies. At 272,000 input tokens the base-rate control fits. At 272,001 and 300,000, the old implementation admitted finalizers whose known fixture totals exceeded their caps. Reservations now select tier rates from the actual invocation model for each predicted request. Reservations remain estimates: an admitted response can still exceed its estimate.

V2 ignored valid OpenRouter charges, including explicit zero, and used catalog estimates instead. The native compatible protocol already preserved the wire charge as `providerMetadata.openai.cost`; legacy adapters use `openrouter.usage.cost`. The accounting reader now accepts finite nonnegative charges from either shape only on recognized OpenRouter routes. Local HTTP tests exercise the real compatible protocol and production normalization/pricing boundary. Unrelated providers and lookalike destinations retain catalog pricing. No parser or generated schema change is required.

A real legacy background workflow also reproduced an unwanted restart. An old launch-stopped child's notification arrived after a new user run finished and started a fifth model request. Its recorded charges and durable launch receipts were correct. Delivery now reads those persisted scopes: a stop in the launching run, shared batch, or ancestor scope prevents a stopped-only notification batch from restarting work. A task's own child-only ceiling leaves a healthy parent free to respond. Healthy mixed batches retain their response behavior, and every retained note remains visible for the user's next turn.

## Before and after

The product failures below were observed after correcting fixture setup and assertions.

| Check                                | Before                                                                                 | After                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Review exact-tier admission controls | 272K control passed; 272001 and 300K controls admitted one unaffordable finalizer each | All three pass                                                      |
| V2 billed-metadata matrix            | Six valid-charge cases failed; six missing/invalid controls passed                     | Included in 33 passing billing/model tests                          |
| Native compatible HTTP charge        | Both zero and positive charges were retained by the parser but ignored by pricing      | Both pass, with unrelated-provider controls                         |
| Late stopped-launch notification     | Five requests without another user prompt                                              | Four requests; a fifth occurs only after explicit user continuation |
| Automatic judge repair               | Coverage previously checked launches and verdicts without nonzero conservation         | Six priced attempts conserve root $0.036 + judges $0.027 = $0.063   |
| Logical scale                        | New accounting workload; no inference comparison                                       | One billion logical input tokens pass 10,042 assertions             |

The late-background fixture preserves the old launch receipt of $2.10121, including its child's $0.00101. The newer user run retains its separate $0.00301 receipt. Replay does not inflate charges. Its subsequent explicit user continuation incurs only that continuation's fixture charge.

## Validation

Combined integration on `6680f76` includes the distinction between absent terminal usage and explicitly reported zero, alongside the billing and context-tier fixes and pending notification change. Every selected check passed:

| Combined suite                                         | Result                     |
| ------------------------------------------------------ | -------------------------- |
| Core runner, model, projector, guard, and billed costs | 211 passed, 809 assertions |
| Engine processor, including uncertain usage settlement | 36 passed, 195 assertions  |
| Real legacy orchestration                              | 3 passed, 46 assertions    |
| Four notification scope controls                       | 4 passed, 16 assertions    |
| Core package typecheck                                 | Passed                     |
| Engine package typecheck                               | Passed                     |

Earlier focused and scale results remain recorded separately:

| Suite                                                               | Result                                                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| V2 billing/native wire and runner-model regression                  | 33 passed, 117 assertions                                                                       |
| Review run/model regression                                         | 48 passed, 255 assertions                                                                       |
| Real legacy orchestration and existing background-stop control      | 3 passed, 46 assertions                                                                         |
| TaskTool regression, including four new notification scope controls | 109 passed, 6 readiness failures, 494 assertions; all four new controls passed                  |
| Six existing readiness cases, controlled comparison                 | Baseline and patched: 1 passed, 5 failed each; later clean patched run: 6 passed, 26 assertions |
| Core package typecheck                                              | Passed                                                                                          |
| Engine package typecheck after notification changes                 | Passed                                                                                          |

Commands run from `packages/core`:

```sh
bun test test/session-accounting-scale.test.ts --timeout 120000
bun test test/session-runner-billed-cost.test.ts test/session-runner-model.test.ts --timeout 30000
bun test test/session-runner.test.ts test/session-runner-model.test.ts test/session-projector.test.ts test/spend-guard.test.ts test/session-runner-billed-cost.test.ts --timeout 30000
bun run typecheck
```

Commands run from `packages/engine`:

```sh
bun test test/review/run.test.ts test/review/model.test.ts --timeout 30000
bun test test/session/processor-effect.test.ts --timeout 30000
bun test test/session/prompt.test.ts test/session/task-size.test.ts --test-name-pattern 'legacy accounting|run guard stops a background subagent' --timeout 120000
bun test test/tool/task.test.ts --test-name-pattern 'notification preserves .* launch scope ownership after a later parent run' --timeout 30000
bun test test/tool/task.test.ts --timeout 30000
bun test test/tool/task.test.ts --test-name-pattern "a follow-up to a running foreground task is told to wait, not that it will be notified|Stop halts the parent before its subagent finishes unwinding, so the parent takes no further step|task calls in one message run at the same time|preflights all permissions before starting siblings and preserves indexed metadata|parent abort cancels every running batch child and releases ownership|rejected one-item foreground resume does not settle another call's child" --timeout 30000
bun run typecheck
```

The scale workload uses 10,000 small normalized usage records, exactly one billion logical input tokens, two fixture models, per-request context tiers, cache reads/writes, output/reasoning separation, duplicate receipts, replay, and late helper settlement. It exercises production V2 pricing, event projection, ancestor rollups, and run/batch/child ledgers against an independent integer money oracle. It passed before the billing-metadata changes; its metadata-free, complete-usage catalog arithmetic is unchanged by the billing and uncertain-settlement changes, so it was not repeated. Covered request objects retain identical model, effort, prompt, and tool configuration bytes.

The four notification policy controls use actual TaskTool lifecycle records and SpendGuard scopes for child-only, shared-batch, ancestor-run, and mixed healthy delivery. Existing tests cover healthy completion, cancelled-only batches, and ordinary errors. The real legacy workflow uses actual SessionPrompt, TaskTool, and local HTTP provider responses rather than a stubbed prompt loop.

The full TaskTool run retained six failures at existing child-start readiness deadlines: foreground follow-up, parent Stop while a child unwinds, simultaneous calls, batch preflight, batch abort, and foreground resume. A partial isolated rerun passed the simultaneous-call case and repeated four readiness failures before it was interrupted; the final case did not complete.

A controlled comparison then replaced only the TaskTool production file with the source-base version, kept the same final tests and configuration, and ran exactly those six cases. Both the baseline and notification-patched runs finished normally with one pass and the same five readiness failures, two assertions each, in 33.71 and 33.55 seconds. The simultaneous-call case passed both. Each process had a 360-second outer deadline; neither reached it. The patched source was restored byte for byte and hash-verified in a finalizer.

Subsequent temporary diagnostics reached normal configuration, agent, permission, model, and job startup, with all six cases passing. After removing every diagnostic and restoring both original files byte for byte, a clean run also passed all six cases with 26 assertions in 12.40 seconds. This establishes that the five failures reproduce without the notification patch and that unchanged fixtures can pass; it does not identify the exact cause of the startup variance. No permanent fixture change, deadline relaxation, or assertion weakening was made. The original broad TaskTool result remains recorded and was not repeated as a fully green suite.

Early fixture failures involved missing Auth/ModelCatalog services, a matcher expecting a hit wrapper rather than a request body, an incorrect assumption that zero catalog rates imply an explicit free route, and reading a completed child's released in-memory binding instead of its durable scope receipt. Those failures are not counted as product defects. The corrected late-background regression preserved its original five-versus-four request failure before the notification fix.

## Limits

Logical usage counts test accounting magnitude; they do not represent billion-token prompts or actual billion-token inference. The component scale test is V2 coverage, while the judge and background cases exercise the legacy runtime. These results do not establish full-workflow quality parity, provider invoice reconciliation, real cache TTL/hit rates, latency, or multiagent economic superiority. Broader V2 compaction-guard and default-budget parity remain outside these changes.
