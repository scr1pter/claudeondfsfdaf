# V2 loop signature forwarding — 4 November 2026

Base: `5a20e7faf764db2d6b4969a4fd028d091b986a90`.
Branch: `v2-loop-signatures`.

The ordinary V2 runner settled tools durably but passed `tools: []` to the
existing SpendGuard. Its repeated-result and repeated-error rules consequently
had no V2 tool outcomes to inspect. This change forwards settled tool signatures
through the existing provider-step settlement.

The publisher records parsed input from the durable `Tool.Called` event and records
each signature after its durable success or failure event. Calls retain their
call-event order even when streamed input starts and eager settlements have
different orders. Successful output is a SHA-256 digest of the result history
sends back to the model: normalized output for local tools, retained provider
result for hosted tools. Failures use their durable error message.

The runner still awaits local tools and captures file changes before counting
the step. Existing terminal hosted failures now settle before that accounting
boundary too. Session ownership, tool validation, permissions, context selection,
and the single explicit `llm.stream(request)` per provider turn remain in the
existing runner. SpendGuard thresholds are unchanged.

A separate followup intentionally clears only this Session's loop and error
history after explicit steer or queued input is durably promoted at a safe turn
boundary. This lets a user ask for a recheck inside the same drain. The new
`SpendGuard.resetLoops` operation preserves spend, step counts, armed budgets,
existing stops, linked accounting scopes, and other Sessions' history. It uses
the Session's launch-run binding, so a late child cannot reset a newer root run.

## Offline verification

Run from `packages/core` with Bun 1.3.14:

```text
bun test --timeout 30000 test/session-runner.test.ts test/session-runner-tool-events.test.ts test/session-runner-model.test.ts test/session-runner-billed-cost.test.ts test/spend-guard.test.ts
220 pass, 0 fail, 845 assertions, 5 files

bun typecheck
exit 0

git diff --check
exit 0
```

Eight added real-runner fixture controls cover:

- Identical schema-invalid calls stop after three requests, before request four.
- Identical successful calls with unchanged results stop after three requests.
- Repeated calls that observe changing results continue to their final answer.
- A successful call breaks an otherwise identical error streak.
- Successful writes with changed snapshot trees clear repeated-result memory.
- A later user prompt begins fresh run memory.
- Input-start order and eager completion order do not replace call-event order.
- A missing hosted result at EOF reaches the guard alongside settled local calls.

The snapshot control uses a deterministic Snapshot service fixture; it verifies
runner propagation of detected changes, without claiming a new filesystem test.
Two added publisher controls verify that local display-only structured changes
do not masquerade as progress, while retained hosted result changes remain
observable.

The forwarding commit first passed 213 tests with 802 assertions. The promotion
followup adds four runner controls (steer/queue crossed with success/error) and
three guard-service controls. After two identical calls, promoted input permits
two explicit rechecks; all five or six provider turns, including the queued
idle boundary, still count toward the original step cap and priced spend. The
guard controls verify unchanged accounting scopes and other Session history,
preserved stopped state, and late-child launch-run isolation.

As a deliberate negative control, only the forwarding line was temporarily
restored to `tools: []`. Both stop regressions failed: each observed five provider
requests where three were required (0 pass, 2 fail, exit 1). Restoring the fixed
bytes made both pass again (2 pass, 0 fail). The temporary mutation was reverted.

A second negative control temporarily omitted only the promotion-time reset.
All four promotion regressions failed: the prior loop memory allowed three tool
executions where four were required (0 pass, 4 fail, exit 1). Restoring the reset
produced the 220 passing tests reported above. No temporary mutation remains.

These are local scripted tests. The billed-cost suite uses a loopback HTTP
fixture. No paid API, external model, cloud application, or live benchmark was
used. This evidence establishes the V2 guard boundary behavior; it makes no
measured claim about provider savings or task quality and does not reinterpret
historical legacy CLI results.

## Integrated branch check

On November 4, 2026, both commits were merged into `tokenomics-complete` at
`b9bc0cbb942bd844bb6dac12b7a26380f3978eb4`, after preserving the original paid
instrument bytes and confirming the historical runtime was absent. All package
and common-driver Git contents match the tested `dae4861` branch exactly.
The normal `bun run typecheck` from `packages/engine` passes with exit 0 on
that integrated tree. Core's 220 tests and typecheck are the above branch
validation, not an invented second execution. No paid run or release followed.
