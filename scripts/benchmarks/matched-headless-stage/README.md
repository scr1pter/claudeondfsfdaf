# Free native team protocol probe

This instrument has no upstream implementation, funding configuration, real API
credential, or application task. It only runs the exact hash-pinned Codex CLI
against an owned Python loopback fake Responses endpoint. Fresh runtime homes
and empty workspaces live under a new private output directory outside this repo.
The dummy credential is intentionally public and grants nothing elsewhere.

The fake response script can emit only a fixed harmless spawn/wait sequence or
final text. No shell, file, browser, app, or external-service action is emitted.
CLI environments are allowlisted; user credentials, accounts, configuration,
profiles and ordinary PATH entries are not inherited. Unrelated runtime features
are disabled, including apps, plugins, discovery, browser access and shell tools.
This is a provisioning and protocol test, not an operating-system network sandbox.

Run the free controls in this directory:

```sh
python -m unittest discover -p "test_*.py" -v
```

Each native probe requires the reviewed `0.166.0-alpha.5.1` executable and a new
private `--out` directory. The executable SHA256 must be
`3097c909fb6d5cd63510d44aceb1d42df9f6e85722a3e447e477def1ecf60e16`.

```sh
python codex_free_probe.py --codex-bin <reviewed-cli> --out <new-private-directory> --mode capture
python codex_free_probe.py --codex-bin <reviewed-cli> --out <another-private-directory> --mode spawn --max-threads 1
python codex_free_probe.py --codex-bin <reviewed-cli> --out <another-private-directory> --mode thread-cap --max-threads 2
python codex_free_probe.py --codex-bin <reviewed-cli> --out <another-private-directory> --mode nested --max-threads 3 --enforce-policy
python codex_alias_probe.py --codex-bin <reviewed-cli> --out <another-private-directory>
```

`capture` returns one final completion. `spawn` creates one harmless native child
and waits. `thread-cap` holds children while the root attempts a second spawn,
then releases and waits. `nested` attempts a grandchild only when the child's
actual offered tool schema permits it. `--enforce-policy` applies the pure native
registry gate to the fake requests and removes child worker definitions. Its
single free-probe worker slot is deliberately smaller than the future three-role
profile; synthetic controls exercise the full lead/two-worker/judge slot bound.

Captures contain private native IDs and raw runtime request instructions. Keep
all output private. Public reports must use counts, field names and identity
relationships; never publish runtime IDs or copied Codex system prompts. The
schema projection removes prose while preserving actual parameter names/types;
the complete unmodified body is retained only under private `private-raw`.

## Observed free evidence

The pinned binary's feature name is `multi_agent`. Custom role configuration
files must resolve to existing paths; this probe uses an absolute owned path.
The fixed role explicitly selects the same custom provider, Sol model and High
effort. Native root and child requests demonstrated those settings.

Actual tools are namespaces inside `input` entries of type `additional_tools`;
top-level `tools` is absent. The root namespaces observed were `functions`,
`clock` and `collaboration`. The latter exposes six collaboration functions.
The unchanged meter's pure request preparation accepted the actual root and
child envelopes offline and supplied its existing 32,000 output ceiling. These
captures require no namespace adapter and no live meter change.

Wire `thread-id` equals native `threads.id` and the turn metadata `thread_id`.
For a child, `session-id` and `prompt_cache_key` still identify the root. The
child's first request already had a persisted `state_5.sqlite` row containing
role, provider, model, effort and a `source.subagent.thread_spawn` ancestry record,
plus a `thread_spawn_edges` parent-child row. Thus a pre-inference native join
is feasible for these observed requests. Root CLI events and its usage summary
alone omitted child inference usage and are insufficient for total accounting.

With one native thread slot, one worker plus the primary succeeded and a second
simultaneous worker was rejected. With two slots, two workers plus the primary
succeeded. This verifies the tested `agents.max_threads` behavior for this
binary; it does not prove a lifetime limit on distinct sessions.

A child role's `features.multi_agent=false` did not remove collaboration tools
or prevent a scripted grandchild, both with explicit root `--enable multi_agent`
and with the binary's default feature state. It cannot be used as a nesting
fence. The pure gate removed the six child collaboration declarations while
preserving retained custom grammar and untrusted message text. A duplicate fixed
slot's first inference was rejected even when the native thread cap permitted
the extra local session creation. That attempted native session stays recorded.

## Remaining work before any funded profile

The first free spike is not a paid runner. The Phase 2 components below add the
owned alias, audit and settlement controls plus a harmless native Vector proof.
Funding still needs the reviewed paired-runner integration, broader helper
coverage, descendants' browser audits, and a frozen development task/profile.
The registry gate controls inference; it does not prevent every attempted local
session creation. A policy rejection must stop and retain the whole arm even if
the native CLI subsequently exits zero. Nothing here changes existing funding,
the live single-agent witness, historical outputs, or frozen product code.

## Phase 2 owned witness and supervisor components

`owned_team_witness.py` adds importable components with **no command-line entry
point, automatic startup, credential loading, or default funded connection**.
All HTTP controls executed so far use temporary Python loopback fake meters.
No service has been started on a funded port, and no funded profile is enabled.

`OwnedSupervisor` accepts an explicitly supplied existing meter client and
read-only receipt reader. Its preflight preserves the existing funding phase,
$48 cumulative study cap, both $20 cumulative actor caps, historical floors,
and the current authoritative balance. It requests one owned scoped batch and
keeps that returned batch token in supervisor/witness memory. `cli_binding()`
exports a separate random local alias. An alias cannot authenticate directly to
the meter. A third distinct local owner capability permits status or stopping
the arm; HTTP callers cannot arm batches, reset counters, or expand caps.

The fixed profile allows one lead and exactly three named lifetime child slots:
two workers and a judge. A slot can resume the same native identity. Replacing
its identity, adding a role, nesting a child, crossing arm ancestry, changing
model/effort/provider, or failing a native join stops the arm before forwarding.
Every body requires Sol/High, including helpers and configuration updates. Child
and helper worker definitions are removed in the explicit tool containers;
retained custom grammar and message content stay unchanged. These controls use
the trusted owned runtime and host profile, not an operating-system sandbox or
a claim of protection against every malicious local program.
Missing reasoning summaries and text verbosity normalize to `auto` and `low`;
explicit different values are refused for every role and helper. The transform
preserves `text.format`, tool grammar and message content. Request fingerprints
are computed after this normalization and match the unchanged meter's wire
encoding. Output remains the common 32,000 ceiling: absent values use 32,000,
larger values clamp as the meter does, and an explicitly smaller helper quota
remains smaller. All 64 retained native requests observed `auto`/`low` and absent
or 32,000 output values. The 1,050,000 context pin belongs to frozen runtime
configuration/catalog and the meter's usage/reservation limits; it is not a
fabricated API request field.
Native identity kind is independent of request purpose. Every distinct Codex
thread must satisfy its lead/role/depth/lifetime slot rules even when the request
is a summary or compaction. A validated autonomous root/child may register its
identity on its first summary-purpose call, then reuse that same slot normally;
purpose alone never bypasses its admission rules or changes its role's tools.
Every call remains fully billed. Distinct Vector helpers
require an explicit native producer-to-generation-agent mapping, a previously
admitted parent, one lifetime identity per producer, and no offered tools.
Tool-using review/judge/specialist agents cannot escape the three child slots
by declaring themselves helpers. Unobserved producers remain unavailable.

All forwarded requests, including retries, helpers and judges, share one
300-request limit, a two-hour admission deadline, and at most one formal
same-lead-session repair. The $3 threshold is checked only when admitting that
repair after the attempt and all owned HTTP handlers have settled. It never
cuts off the current attempt mid-work; the unchanged $48 global and cumulative
$20 actor caps plus per-request reservation still apply. Forwarding uses a finite FIFO with
one request in flight. Before each forward it checks current settled funding
and the unchanged meter's conservative reservation formula. Insufficient
headroom stops for review; context/output limits and quality gates are not
reduced. The owning runner must still enforce the runtime execution deadline
and stop its owned processes; settlement draining can finish afterward.

Audit rows are appended and fsynced before forwarding, with a separate witness
sequence and hash chain. Audit failure and policy failure latch for the arm.
Existing or partial audit files cannot be reused to reconstruct a funded run.
Requests are never retried by the witness. A cancelled queued request is not
forwarded, while a cancellation after forwarding drains the existing upstream
request and retains its receipt. A missing terminal or uncertain transport
requires review even when later ledger charges are known.
Only a completed raw response, or one matching SSE completed/done event and
completed response status, clears the terminal gate. Failed responses,
event/status contradictions, malformed or repeated terminals, unknown usage and
upstream error events require fatal review. An incomplete response with explicit
`max_output_tokens` reason and valid known usage is a nonfatal review observation:
the current arm may continue under all existing limits, so the witness does not
block a necessary native length continuation. The initial shared policy keeps
mandatory manual review at closure even if a later turn completes; it blocks
the next arm until owner review. It does not automatically resolve an unknown
root/helper purpose. Other incomplete responses remain fatal. Valid usage and
reconciled charges do not establish task completion. A later completed event or
turn cannot clear a failed terminal; the stream is drained and all charges retained.
Malformed JSON on a terminal/error-labelled SSE frame is fatal even after a
valid completed frame; it cannot be silently ignored. Malformed nonterminal
heartbeat data remains informational. Billing certainty for completed responses
is delegated to the unchanged meter's usage validation and authoritative receipt
join; a terminal status alone does not establish known cost.
An `event: error` frame is also fatal when its data is valid JSON with no `type`
field, whether it appears before or after a completed frame.

Scoped closure disarms only the captured owned token. An uncertain disarm is
not automatically repeated. Unknown closure keeps the token in memory and
blocks the next arm. Authoritative receipts join by the actual shared batch
hash, immutable owned label, actor, meter sequence and request fingerprint, including repeated identical
requests as separate receipts. Known controller totals remain available under
`controllerUsageThroughClosure` when receipt joining is incomplete; this is a
cumulative observation and must not be added to the reconciled total again.
Audit/telemetry problems cannot turn into product passes. The supervisor also
requires a positive owned-runtime-and-descendants quiescence callback before
collecting private native transcripts; its default callback is false.
Closure also drains accepted HTTP handlers and queued waiters. It rechecks the
latched failure under the same condition lock that retires the alias and updates
the supervisor's final disposition. A failure during transcript collection
therefore requires review and blocks the next arm. Once retired, a late owner
stop is rejected rather than mutating an already-final result.

`native_registry.py` reads only an explicitly configured database inside the
owned runtime home. The Codex backend joined all 47 retained actual requests
against their native SQLite state in offline replay. The Vector backend uses
the public source schema (`core/session/sql.ts`, TaskTool's `metadata.subagent`,
and the session identity headers). The separately authorized native Vector proof
used the frozen `a35c03d` source and exact Bun/Node binaries in fresh owned homes.
The lead, two distinct fixed workers and judge produced six fake requests, all
Sol/High, with every native session/model/parent join available before inference.
The same team through the actual alias witness reconciled all six fake receipts
and collected four private session transcripts. A duplicate-slot native control
forwarded only four requests, refused the replacement child's first inference,
retained its attempted native session, and ended with CLI exit 1 and mandatory
review. This proves that harmless path, not the six broader startup-readiness
tests on a separate branch or real task quality. Unobserved helper kinds and
their ancestry still need coverage before a funded profile. An
ambiguous root/helper purpose stays `root_or_helper`; its calls and dollars
remain counted, and the report exposes the unresolved purpose count. Request
counts never establish autonomous-agent counts.

Run all component controls, including the independent unchanged-handler check,
only with an explicitly reviewed meter **source directory**:

```sh
VECTOR_BENCH_METER_SOURCE=<reviewed-source-directory> python -m unittest discover -p "test_*.py" -v
```

On PowerShell set `$env:VECTOR_BENCH_METER_SOURCE` before invoking Python.
The optional control imports `budget_gateway_v2.py` and its source dependency,
creates a new temporary synthetic ledger, and supplies a literal dummy provider
key plus an owned loopback provider stub. It reads no live controller config or
key, and contacts no funded port. The actual unchanged handler's receipt
fingerprint, shared batch hash, sequence and reservation matched the component,
including UTF-8 content. Offline replay also matched the actual meter wire bytes
and reservation for all 47 retained native request bodies. This independently
checks encoding/key-order/normalization semantics rather than relying only on
the fake meter in the component tests.

`vector_free_probe.py --mode team --owned-witness` is the owned native Vector
mechanics control. It accepts only the frozen source revision and a clean tree,
requires explicit Bun/Node paths, and emits only fixed harmless TaskTool calls
and text completions. `--mode duplicate --owned-witness` is its negative lifetime
slot control. It has no real provider upstream; its controller and receipts are
synthetic. The CLI receives an alias, while the fake scoped token remains in
supervisor/witness/fake-meter memory. Its free-only bootstrap binds the first
wire identity only when the newly created owned database contains exactly one
native root. A second root is refused. Paid root registration remains subject
to the separately reviewed runner/profile design. Running this script requires
an exclusive Bun lease; ordinary Python controls do not start Bun.

The remaining paid-runner integration must bind a supervisor-verified root
before admitting its first request, confirm process quiescence, freeze both
runtime profiles and helper coverage, apply descendant browser audits, and
include the separately reviewed runtime accounting fixes. These components do
not authorize or start a paid pair.

## Final fixed-team Codex alias proof

`codex_alias_probe.py` uses the same pinned native Codex executable and the
actual owned supervisor, native registry and alias HTTP witness. Its only
upstream is a temporary synthetic loopback ledger. It emits a finite script:
create the two fixed workers, wait, create the fixed judge, wait, finish. Worker
and judge responses are harmless text. Shell, browser and application tools
remain disabled in this protocol proof; the separately reviewed paid adapters
need their own capability-preserving free smoke. The fresh root bootstrap is
explicitly free-only and requires exactly one persisted root in its owned home.

The final observed run exited zero with eight fake requests and four native
inference identities. All eight used Sol/High, auto summary, low verbosity and
the common 32,000 output ceiling. The root retained collaboration definitions;
the three children offered none. All eight receipts and four native transcripts
reconciled with clean scoped closure. It made zero provider/funded-meter calls
and started no Bun process. This establishes native protocol/accounting
mechanics, not task quality, coding performance or dollar savings.

Final source controls include the unchanged meter handler with a literal dummy
key and loopback provider. Both missing usage and invalid usage on otherwise
completed responses halt that real handler and require uncertain closure;
neither a completed status nor missing receipts become a free or passing run.
The final complete source-control invocation passed 90 tests with the explicit
reviewed meter-source option enabled. An earlier run had one Windows socket
abort in the fake probe's denied-request control: its handler replied before
consuming the tiny request body. Bounded draining of denied fake requests fixed
that transport race; the same complete control set then passed. No paid/runtime
result, assertion, admission rule or test deadline was relaxed.
