# Offline release-engine evidence

This driver measures an instrumented release engine under Node and rehearses two
first requests against a loopback fake OpenAI Responses provider. It supports no
live mode, provider URL override, source fallback, credential import, warmup, or
cache-retention experiment. It does not establish actual cache reuse, model
quality, speed, provider cost, or full Electron desktop memory use.

## Exact invocation

After the CI provenance verifier has admitted and extracted the pinned installer:

```sh
node packages/engine/script/release-evidence.mjs \
  --bundle "$EVIDENCE_ROOT/app/out/main/sidecar.js" \
  --entry-kind packaged-sidecar \
  --identity "$EVIDENCE_ROOT/provenance.json" \
  --out "$EVIDENCE_ROOT/study" \
  --dependency-package "$EVIDENCE_ROOT/app/package.json"
```

`study` must not already exist. Failed attempts remain intact; use a new output
directory after a declared correction. The optional `--offline` flag only states
the default. Every other execution mode, URL option, or source launcher is
rejected. Node 24, Git and Linux `ps` are required. CI enters a fresh Linux network
namespace with only loopback enabled, then drops back to the runner UID before
starting the driver. The driver refuses a host exposing any non-loopback network
address or no enabled IPv4 loopback. Dependencies come from the
verified extracted package; the driver installs nothing.

The identity file requires schemaVersion 1, full sourceSha, version, `prod`
channel, platform, entrySha256, catalogSha256, and artifact runId, artifactId,
archiveSha256 and asarSha256. The driver checks the entry bytes, runtime platform
and `/global/health` version. The separate CI verifier owns the archive, catalog,
ASAR and packaged build-identity checks; copying a claimed digest into this file
is not independent verification. Those identities and any extra provenance
fields are retained in the report. The `server` entry kind can run an explicit
`dist/node/node.js` exporting `Server`; it still requires production provenance.

The packaged-sidecar bootstrap supplies the real sidecar's parentPort start/stop
protocol using a Node IPC channel. It imports the exact verified entry without
editing it. This is **Node-hosted packaged sidecar evidence**, not execution inside
Electron. No Electron fuse, inspector setting, or existing application is changed.

## What runs

One fresh engine process opens a fixed, committed README/notes fixture. It creates
two explicitly titled sessions in that same repository. Both use the identical
cache-check prompt, `openai/gpt-6.1-sol`, Standard size, medium variant, normal
execution, judge off, and a one-step budget. Session two starts after session one
settles. The release catalog supplies model metadata and its variant; a missing
model fails rather than substituting another model. The provider endpoint and key
are synthetic, formatter/LSP services are off, and a local plugin vetoes every
tool execution while retaining the normal tool definitions. These settings are
recorded, not represented as the user's default profile.

The release's built-in OpenAI `chat.params` hook clears the environment-derived
output limit. The evidence plugin runs afterward and applies the study's explicit
512-token cap through that supported hook, after checking the exact provider and
model. Capture independently requires the same value in the serialized request.
The packaged bundle and catalog remain unchanged.

The actual `prompt_async`, event, health and message APIs are exercised. Global
capture is installed before importing the release bundle; normal runtime provider
and auth adapters still construct requests. Every inference send must have one
of exactly two session grants, the expected endpoint/model/medium effort, a
serialized `max_output_tokens: 512`, streaming and Standard tool definitions.
Requests carrying continuation, retention, reasoning-context or fast-tier
experiments are refused. A session grant is created exclusively and fsynced before
forwarding, and is never refunded after a failure, abort, invalid request or
process restart. The provider independently refuses a third or duplicate send.

No real environment credentials, proxy variables, HOME or Vector profile enter
the engine. Socket guards reject non-loopback destinations in the bootstrap;
the fresh network namespace is the boundary for workers and subprocesses too.
An attempted Node `--import` Worker preload did not guard eval Workers on the
validation host; it was removed and is not claimed as protection. Model tool
execution is vetoed, project configuration is disabled, and the fixture contains
no external commands. Real
provider calls are unsupported even if an API key exists in the caller's shell.

The fake provider emits scripted cache counts of 0 then 1,024. The driver verifies
that the second terminal usage reaches the corresponding assistant step. These
numbers test capture/projection only. They are **not measured cache hits**. The
existing cache-key policy remains in place; keys and system/tool hashes are
recorded without treating equal bytes as proof of provider caching. HTTP is
forced for this offline instrumentation; loopback wire observations and available
runtime transport diagnostics are retained separately.

## Evidence and limits

`report.json` contains source/artifact/catalog/runtime/harness identities, fixture
hashes, controls, both session IDs, request ordinal and hashes, terminal synthetic
usage, projected step usage, and raw memory samples. The directory also retains
request JSON, response SSE, durable grant records, events, messages, runtime logs,
fake-provider receipts and any blocked-send/tool records. It stores no real key
or authorization headers. Actual provider cost remains null, including failures;
engine-projected dollars from scripted token counts are not bills.

RSS sampling runs every 100 ms over the engine process and its descendants,
tracking start identities to avoid recycled PIDs. Startup, idle, each session and
settled phases have separate sampled peaks. Node heap/external/ArrayBuffer/RSS
samples supplement the process-tree series. The driver/fake server are outside
that tree. Shared resident pages may be counted more than once, short peaks may
be missed, and capture buffers responses before replay. Missing sampling is a
failure, not a zero-memory measurement. A full app memory profile still needs an
isolated Electron main/renderer/utility-process run; these numbers must not be
compared directly with old source-Bun or unrelated Codex measurements.

Run the light offline component tests directly (the host's Node runner wrapper
can hide named tests when invoked with `--test`):

```sh
/workspace/.tools/vector-serial node --test-timeout=30000 packages/engine/script/smoke-release-evidence.mjs
```

The tests cover durable/racing/restarted grants, endpoint/model/effort/output
refusals, cancelled and oversized responses, missing usage, tool veto, local-only
network guards and rejection of non-isolated hosts, PID reuse, and the packaged-sidecar IPC seam.
They do not substitute for the exact release-artifact rehearsal in CI. Review
that report and every failure before proposing a separate authorized live check.
The historical $0.25/account-hard-cap and packaged-Electron-only requirements were
proposal assumptions, not blockers for this free preparation. No paid call or
new spending guarantee is authorized by this document.
