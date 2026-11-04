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
existing runner. SpendGuard thresholds and reset rules are unchanged.

A guarded run currently spans a drain. A steer or queued prompt promoted during
that drain resets the agent's provider-turn allowance but does not clear its
loop history. The later-prompt control below covers a fresh drain; it does not
assert a loop reset when input is promoted inside an active drain.

## Offline verification

Run from `packages/core` with Bun 1.3.14:

```text
bun test --timeout 30000 test/session-runner.test.ts test/session-runner-tool-events.test.ts test/session-runner-model.test.ts test/session-runner-billed-cost.test.ts test/spend-guard.test.ts
213 pass, 0 fail, 802 assertions, 5 files

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

As a deliberate negative control, only the forwarding line was temporarily
restored to `tools: []`. Both stop regressions failed: each observed five provider
requests where three were required (0 pass, 2 fail, exit 1). Restoring the fixed
bytes made both pass again (2 pass, 0 fail). The temporary mutation was reverted.

These are local scripted tests. The billed-cost suite uses a loopback HTTP
fixture. No paid API, external model, cloud application, or live benchmark was
used. This evidence establishes the V2 guard boundary behavior; it makes no
measured claim about provider savings or task quality and does not reinterpret
historical legacy CLI results.
