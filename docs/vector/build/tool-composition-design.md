# Bounded tool composition: design checkpoint

Status: **proposal, not implemented or enabled**. This branch starts from
`479303cf229badc0fa2c770f27d7d845dfa4fa68`. The frozen product and paid baseline
remain unchanged. No dependency was installed, no Bun test was run, and no model
or network call was made for this investigation.

## Measured reason to investigate

The completed three-task single-agent stage used candidate `a35c03d`, not this
later accounting candidate. Vector made 127 provider requests versus Codex's 88,
while costing 5.0122% less overall. Vector was more expensive on two tasks.

| Task | Vector provider requests | Direct Vector tool calls | Codex provider requests | Codex composition calls | Codex command executions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Workflow Runner | 47 | 60 | 30 | 29 | 74 |
| Evidence Workbench | 44 | 61 | 35 | 34 | 39 |
| Delivery Outbox | 36 | 57 | 23 | 22 | 27 |

The Codex records use its native `exec` composition capability. Programmatic
calls and loops can perform several dependent operations within one inference.
Vector already batches independent reads, but its observed primitive calls
usually return to the model between dependent browser operations. This is a
runtime capability difference, not proof that every additional Vector call was
wasted or that composition will save 20% at equal quality.

Nine standalone Vector todo updates cost $0.113275. Combining bookkeeping with
independent productive calls is worth observing, but the tool already encourages
that behavior; removing the complete cost is only an upper-bound counterfactual.
Checks after edits and failed-test investigations must remain.

## Existing implementation and dependency check

The frozen source, local main `42346154` and available origin/main `78526052`
contain no shipped Rune or general tool-composition implementation in Core or
Engine. These are inspected local refs, not a fresh remote fetch.

`packages/core/src/tool/builtins.ts` explicitly lists Rune/code mode as an
unported leaf. The other code-mode reference in `integration.ts` concerns an
OAuth authorization code. Existing task batches launch model workers; they are
not a replacement for dependent local tool execution.

No QuickJS, isolated-vm, or comparable general JavaScript interpreter is present
in the inspected manifests or lockfile. Existing WASM dependencies serve images,
hashing and parsing. Their presence does not provide a supported isolation layer.
The transitive development worker runtime is not an audited application-hosted
composition sandbox. Node `vm`, `Function`, `eval`, or an ordinary worker must
not be represented as a security boundary.

## Why a wrapper around the registry is insufficient

Core's `ToolRegistry.Materialization.settle` already preserves captured tool
identity, input/output schemas, leaf-owned permissions and managed output bounds.
It deliberately does not own execution authorization or durable Session history.
The Core tool AGENTS file prohibits adding another executable representation or
a registry-owned executor/authorization callback.

The Session runner currently publishes each tool call before invoking settlement
(`packages/core/src/session/runner/llm.ts`, around lines 327-365). Its publisher
owns tool lifecycle state and durable results. `SpendGuard` receives the actual
per-step tool signatures through this path. Calling `settle` recursively from a
new tool would bypass those Session responsibilities unless they are deliberately
shared first.

Legacy execution adds further obligations in `packages/engine/src/session/tools.ts`:
the current agent/session permission merge, live owned paths, plugin before/after
hooks, memory-source taint, attachments, cancellation, and tool-part metadata.
`SessionProcessor` also gates edits behind snapshots and tracks tool signatures
for loop detection. Calling leaf executors directly is not equivalent.

There is no existing nested-call protocol in `SessionMessage.AssistantTool` or
`SessionEvent.Tool`. Publishing fabricated child calls as ordinary model calls
would put calls the provider never made into the next provider history.
`to-llm-message.ts` currently lowers every ordinary local tool part into a model
tool call/result pair. A child-operation record therefore needs an explicit
distinction from a provider-issued call.

Browser data creates another constraint: the legacy browser exposes fenced page
text and controls for provenance/security reasons. A composition engine must not
silently expose an unbounded, unfenced BrowserReport or bypass outbound checks to
make parsing easier.

## Smallest credible implementation sequence

1. **Share Session-owned invocation, without changing tool representation.**
   Extract the existing persist-before-side-effect, captured-materialization
   settlement, interruption/failure publication and result retention sequence
   into one Session-scoped invocation capability. Normal provider tools continue
   through that same path. Keep registration and leaf authorization unchanged.
   Implement the corresponding legacy adapter using its existing context,
   plugin, snapshot and processor behavior; do not call primitive executors
   through an alternate registry shortcut.

2. **Represent child operations explicitly.**
   Give every operation a unique child identifier and parent provider call ID.
   Persist admission before dispatch and terminal outcome afterward. Project
   these records into audit/UI history while lowering only the outer provider
   call and its bounded result into model history. On interruption or restart,
   mark unfinished operations uncertain; do not automatically repeat a mutation.
   Preserve output-retention references and cancellation/provenance metadata.
   This requires an intentional schema/projector/history design, not a metadata
   array that can disappear when the outer call fails.

3. **Start with a finite declarative flow, default off.**
   An experimental setting exposes one tool only when explicitly enabled. Its
   input is a versioned JSON flow: sequential calls, bindings to bounded results,
   field lookup, bounded array find/map, simple comparisons and conditional
   branches. No arbitrary JavaScript, imports, properties such as `__proto__`,
   callbacks, filesystem/network primitives, ambient globals or recursion.
   Validate the complete flow before side effects. Suggested initial limits are
   32 dispatched calls, 256 interpreter operations, depth eight, arrays of at
   most 32 elements, 64 KiB input, 1 MiB working data and one in-flight operation.
   Limits are proposed engineering defaults, not measured optimal values.

4. **Keep the current authority and budget.**
   The operation namespace is the captured, advertised, permitted materialization
   for the current agent. The flow cannot re-enable a withheld tool, become a
   different agent, create a child Session or call the composition tool again.
   Every operation retains its leaf permission check, ownership, memory and
   network policy. Check the current run's stopped state before each dispatch;
   use the existing abort scope while it runs. No hidden inference, cheaper-model
   routing or additional worker is introduced. Model usage remains charged once
   per provider turn; nested operation signatures still feed the existing loop
   and error detectors rather than incrementing fake inference steps.

5. **Bound results without weakening verification.**
   Existing leaves and registry keep their current bounds and managed retention.
   The flow also needs an aggregate bound so 32 individually valid results cannot
   become an oversized final response. Return explicit completed/failed/skipped/
   uncertain operations, retained output references, and selected bounded data.
   Browser pages remain untrusted. A flow cannot interpret page text as its own
   program, dynamically choose tools from that text, suppress a failed required
   check, or claim that executing a command establishes its success.

This declarative first version is deliberately narrower than general code mode.
It should not be sold as a replacement until a real task can express a useful
dependent workflow without brittle parsing. If it cannot, add a separately
reviewed WASM JavaScript runtime with memory/CPU/job limits and an asynchronous
host bridge after the shared invocation protocol exists. Isolation cannot
replace leaf permissions, durable records or cancellation.

## Required tests before a candidate freeze

- Feature absent by default; existing tool definitions and default prompt hashes
  unchanged. Explicit enablement exposes only the captured allowed namespace.
- Real leaf permission denial still blocks the side effect; exact child call ID
  appears in the approval source. Session/agent permissions, live owned paths,
  memory taint and plugin hooks match a direct call.
- Call admission is durable before an actual filesystem side effect. A failure
  to journal prevents dispatch. Interruption drains or records every accepted
  operation, cancels queued operations, and never silently retries mutations.
- Replay/UI exposes every child result, but provider lowering emits only the
  actual outer call/result. Unknown and stale tool registrations remain refused.
- The existing run budget stop and loop/error signatures apply during a flow;
  no child Session, inference step, hidden helper or duplicated charge appears.
- Schema/resource limits reject malformed/deep/oversized flows before side
  effects. Bounded loops exhaust deterministically. Invalid property paths and
  prototype names cannot access host objects. Cancellation interrupts a pending
  permission request and an in-flight real leaf.
- Per-result and aggregate truncation preserve managed references; attachments
  and image evidence survive. Browser provenance/outbound/sensitive-action
  controls remain intact. Failed checks are returned truthfully.
- A fake-provider native CLI trial demonstrates one dependent flow, actual
  nested durable records and unchanged default behavior. Then run a separately
  preregistered paid task with the same model/effort and full quality gates;
  retain implementation overhead, errors and every prior charge.

## Decision checkpoint

This is a meaningful cross-cutting feature, not a safe leaf-only patch. The
blocking work is the shared Session invocation and child-history protocol,
plus legacy parity and a supported isolation choice for arbitrary JavaScript.
Do not rush a recursive registry wrapper into a paid candidate or change the
current frozen baseline. The source analysis supports this direction; savings
and equal quality remain unproven.
