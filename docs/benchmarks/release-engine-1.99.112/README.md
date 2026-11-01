# Published release engine study

This study records two pieces of evidence using the published Linux x64 desktop
1.99.112 artifact: sampled memory of its engine process tree, and an offline
rehearsal of the two-session first-request cache instrumentation. The model server
is a loopback fake. Its token counts are scripted, including the second request's
cached-input count. They do not measure provider cache reuse, quality, cost or
model speed.

## Artifact and runtime

The pinned identity lives in
[`release-evidence-identity.json`](../../../script/agent-eval/release-evidence-identity.json).
It identifies the successful production release run `40781089625`, attempt 1,
source `dfc98974329f17c6814a923ac12ebe38b6673f38`, and the immutable Linux and
catalog artifact IDs, archive sizes and SHA-256 digests. GitHub metadata confirmed
on 1 November 2026 that those artifacts remain available; the Linux archive
expires on 11 November. Expiry fails the study instead of silently substituting
a rebuilt or older binary.

Before extraction, the verifier checks the successful workflow, repository,
source, attempt, artifact identity and actual downloaded bytes. It then checks
the packaged production-channel/version/source marker and application manifest,
and the exact release catalog. The study records the installer, ASAR, sidecar,
catalog, instrumentation and fixture hashes.

The extracted `out/main/sidecar.js` runs unchanged under Node with a small adapter
for its parent-port start/stop messages. This is a **Node-hosted packaged sidecar**,
not the full Electron application. The script neither patches its bundle nor
changes Electron fuses. Main/renderer memory, Electron runtime differences and
native desktop behavior require their own profile. The driver/fake provider are
outside the sampled engine tree. The IPC adapter and response-capture buffers
remain instrumentation overhead inside that tree and are disclosed in the report.

The CI study runs as its normal runner user in a private Linux network namespace
with loopback enabled. Workers inherit that network boundary. A separate clean
synthetic profile, socket guard, tool veto and per-session request grants prevent
use of a real account or model route. No owner profile or credentials are copied.

## Rehearsal and report

One engine process serves two named sessions in one unchanged disposable Git
fixture. Both use the same Standard/medium request, normal execution mode, judge
off, one-step limit, output ceiling of 512, and HTTP instrumentation. No cache
warmup or retention experiment is added. The serialized request is checked;
missing output bounds, a wrong model/session/endpoint, retries and extra sends
fail rather than being silently accepted. A send consumes its durable grant
before forwarding, including failures and cancellation. Tools remain visible in
the request while a plugin veto prevents execution. That plugin also applies the
study's explicit 512-token cap through `chat.params`, after the release's built-in
OpenAI hook clears the environment-derived cap. The actual wire value is checked
independently; neither the packaged bundle nor catalog is patched.

Reports retain request, system/tool and response hashes, observed request
controls, first-request provider and projected usage, engine events, errors,
process identities and 100 ms RSS samples across startup, idle, both sessions and
the settled tail. Missing required usage or memory samples and truncated provider
responses remain failed/unknown. Truncated diagnostic engine logs are marked
separately; they do not invalidate otherwise complete measurements. RSS is
sampled resident memory, not a precise peak or private-memory measurement; shared
pages can be counted more than once in the tree total.

The optional `release_evidence` input of the existing `test` workflow runs only
this study. It defaults off; normal push, PR and default-dispatch coverage is
unchanged. Large release archives and extraction run in CI, not on the local
workspace. The completed run and raw report are recorded below; preparing the
driver alone was not baseline evidence.

## Remaining live check

The original tokenomics audit's minimal live question is whether the second
session's first provider response reports cached input under release API-key
HTTP behavior. Its later proposal added packaged-sidecar-only execution and a
provider-enforced $0.25 account ceiling as planning assumptions. They do not block
this offline preparation. Any live follow-up still needs an approved credential
route and explicit spending authorization, a reviewed live adapter, and an honest
bound on what the chosen route can enforce. A software threshold cannot be
presented as a guaranteed dollar cap. This driver exposes no live mode.

The two-session rehearsal can verify instrumentation. Only real provider usage
can answer the cache question, and one pair cannot establish a general hit rate
or a cost/speed advantage. No live calls, account changes or purchases are part
of this study.

## Preparation validation

Before the first artifact run, all 18 driver/capture/sampling Node tests, three
artifact-provenance Node tests and 22 existing workflow compliance tests pass.
Independent review verified the pinned GitHub metadata and closed a missing-phase
sampling defect: explicit samples now bracket every required phase, async samples
retain the invocation phase, and missing phases produce null peaks plus failure.
The aborted event observer is awaited before the final report is written. The
review found no remaining dispatch blocker. None of those local checks executes
the release artifact or establishes its memory baseline.

## First artifact attempt

Run [41259921640](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/41259921640)
on `d12a33c9bbbf639306875ddcb825d94e4eb38a2b` passed provenance, extraction and
component checks. The engine started successfully as version 1.99.112. Its first
request was blocked before forwarding with `REQUEST_OUTPUT_LIMIT_MISSING`:
the built-in OpenAI hook cleared the requested output cap. Later memory phases
were correctly recorded as missing, and the study failed. Its partial memory
samples are not a completed baseline.

The preserved artifact is `13064721537`, 57,952 bytes, SHA-256
`24bb117e8d26713945a3c567710fcbe91cc25b16e97ba7c618f99cfdc9c094c9`.
The correction uses the supported plugin hook described above and retains the
same wire refusal. All 19 focused Node tests pass after this correction.

## Completed artifact study

Run [41260729498](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/41260729498),
job `124713274950`, passed on instrumentation commit
`c7335646bed8b3ca6c95998e1f430a3d96222c78`. The artifact is `13065630149`,
100,530 bytes, SHA-256
`bb84312cc8bca10c52e25b9430b6f2c2cc673ea0241a6657fd19af452d513a44`.
Its downloaded bytes were independently checked before extraction.

Both sessions completed in the same engine process, with exactly two forwarded
HTTP requests, no tool execution, no study errors and no missing memory phases.
The fixture stayed unchanged and the engine exited with code 0. Optional startup
attempts to reach the npm registry and GitHub were blocked by the offline guard.
The process tree was sampled 47 times. These are the sampled RSS peaks in this
one run on a four-vCPU Linux runner with Node 24.15.0:

| Phase | Samples | Process-tree RSS peak (MiB) |
| --- | ---: | ---: |
| Startup | 14 | 464.23 |
| Idle before requests | 8 | 466.80 |
| First session | 13 | 586.15 |
| Second session | 5 | 632.57 |
| Settled tail | 7 | 627.73 |

The highest sample was 647,752 KiB (632.57 MiB). This supplies a baseline for
this instrumented Node-hosted release engine, not a full desktop figure or a
memory improvement against earlier studies. Node heap/external/ArrayBuffer
samples and every process-tree sample remain in [report.json](records/report.json).

The wire carried the expected model, medium effort, 512-token output cap and
14 tools. Request sizes were 39,339 and 39,832 bytes. Tool hashes matched;
system hashes differed because the second session included an advisory memory
note created after the first. The system strings shared their first 9,958 UTF-8
bytes, then diverged. The normal per-session cache keys also differed. These
observations describe request construction, not cache reuse. The scripted
provider counts of 0 then 1,024 cached input tokens reached the corresponding
assistant steps; actual provider cost remains null.

[manifest.json](manifest.json) pins the bytes and SHA-256 of 24 unchanged raw
records: provenance and run metadata, requests/responses, grants, provider
receipts, events/messages, logs and the report. Synthetic profile databases and
Git snapshot internals remain only in the original artifact. Neither the old
failed attempt nor this fake-provider run establishes live cache, speed, cost or
quality results.
