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

This is a first free spike. It is not a funded witness or paid runner. Funding
still needs independently bound owned arm capabilities, durable audit failure
handling, complete helper classification/accounting, descendants' tool/browser
telemetry, interruption/settlement controls, and the analogous Vector proof.
The registry gate controls inference; it does not prevent every attempted local
session creation. A policy rejection must stop and retain the whole arm even if
the native CLI subsequently exits zero. Nothing here changes existing funding,
the live single-agent witness, historical outputs, or frozen product code.
