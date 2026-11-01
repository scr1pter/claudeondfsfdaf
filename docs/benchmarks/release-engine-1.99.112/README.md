# Published release engine study

This study prepares two pieces of evidence using the published Linux x64 desktop
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
workspace. The final workflow result and report belong here after execution;
preparing the driver is not baseline evidence.

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
same wire refusal. All 19 focused Node tests pass after this correction; an
artifact rerun is still required.
