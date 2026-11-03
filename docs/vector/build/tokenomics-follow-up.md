# Tokenomics follow-up

Checked on 2026-10-28 against `main` at `b3669a6b`, using the remaining-work list in `self-evolving:docs/vector/build/tokenomics-audit.md`. This record distinguishes an instruction fix from work that still needs evidence. It makes no speed, cost, or cache-hit claim.

## Implemented

Standard task-size guidance no longer asks for a to-do list merely because work has multiple steps. It now reserves tracking for substantial milestones or a user-requested plan. This agrees with the existing `todowrite` policy, which says that routine investigation, editing, verification, or multiple files alone do not justify tracking.

Files: `packages/core/src/task-size.ts` and the existing regression coverage in `packages/core/test/task-size.test.ts`. Light still skips tracking; Thorough still plans with the to-do list. Task classification and available tools are unchanged.

Validation: the focused task-size file passes all 19 tests (452 assertions), run from `packages/core` with `bun test --timeout 30000 test/task-size.test.ts`. This checks instruction and classification behavior, not model token savings.

New desktop work sessions now receive a useful title at creation from the first
typed line, normalized and limited to 50 Unicode code points. File/agent mentions
do not displace the request; an attachment-only request can use a file basename
or a user-authored comment. File contents, previews, absolute attachment paths,
and hidden task instructions are not title sources. Social messages retain the
engine's existing title policy, including retitling when the first work follows
a greeting. Existing sessions and other session-creation flows are unchanged.

The existing untitled-session fake-provider case recorded one main request plus
one title request before the change. A new client-named-session regression
records one main request, no separate title request, and no ancillary title-usage
row. This proves the request-count behavior for that path; it is not a measured
live cost reduction. Helper tests (3 tests, 7 assertions), composer submission
tests (59 tests, 219 assertions), and the engine regression (1 test, 4 assertions)
pass. App and engine typechecks pass. The required production navigation baseline
and the subsequent comparison are recorded in
[`docs/benchmarks/vector-title-2026-10`](../../benchmarks/vector-title-2026-10/README.md).

When an explicitly configured SSE inactivity deadline fires, rejection of the
stream's cleanup cancellation is now observed without replacing the primary
`ProviderResponseStreamError`. The existing wrapper moved to
`packages/engine/src/provider/response-stall.ts`; `ProviderError` re-exports the
same error class. Existing durations, timeout defaults, and retry policy remain
unchanged. A direct native Node 24.19 regression failed on the old cancellation
line with the rejected cleanup error and passed after the catch. The actual
Provider/SDK configured-cloud case passes (one test, nine assertions), including
one request and error identity; the existing local/cloud deadline case passes
(one test, 13 assertions). Engine typecheck passes. General CI now runs the native
Node regression before its existing bundle build and fake-provider smoke; no
heavy bundle build was run locally.

## Remaining evidence and decisions

| Audit recommendation | Current state and next gate |
| --- | --- |
| First-request cache reuse | The API-key path already puts stable prompt parts first in one system block (`packages/engine/src/session/llm/request.ts`). The [two-session release check proposal](../owner-actions/first-request-cache-check.md) defines API-key HTTP, exact artifact/model/effort, and a hard spending prerequisite before any paid run. Its driver/gate is not yet implemented or approved for live execution. Offline estimates cannot establish real cache hits. |
| Paid cache warm-up and 24-hour retention | Neither is enabled by this follow-up. Warm-up adds a model request; retention depends on provider/model support and changes the caching policy. Define supported models and the intended opt-in/configuration behavior before implementation. Do not silently add spend. |
| Shorter task descriptions and reduced narration | The audit requires a live behavior check before further prompt trimming. Preserve the current delegation and completion rules until that check has a result. |
| API-key WebSocket rollout and incremental tool definitions | Production remains on its existing transport default. Validate provider compatibility, reconnection, complete tool availability, and release-path behavior before changing it. Upload-byte savings alone do not establish model-cost savings. |
| Desktop session titles | The primary composer supplies the first useful line for new work sessions; the offline engine regression confirms no separate title request for that path. Both production navigation jobs passed all nine results with zero blank/unknown samples; raw records and their limited comparison are preserved in the linked evidence. Greeting-first work may still use the existing model-generated title. |
| Node startup preconnection and stream stalls | Cleanup rejection after an explicit SSE deadline is handled and tested. Cloud HTTP already accepts configured header/chunk timeouts, and OpenAI headers default to 10 seconds; a default cloud chunk deadline remains a policy/design task. Native Node fetch has no preconnect hook: a reusable dispatcher/connector must share the SDK's real pool and preserve proxy and Vector Local policy. Opening an unrelated raw socket would not warm that pool. Do not add a speculative HTTP request or retry partially completed work. |
| Memory | Profile the current desktop/release build. Old offline measurements are not a baseline for this build. |
| Default effort, cheaper subagent models, reasoning retention | Keep existing behavior pending matched quality/cost measurements and the separate multi-agent work. The audit does not establish that lower effort is cheaper. |
| Published CLI | Publishing remains an owner action; a source change cannot update the installed CLI. |

The scoped offline request-footprint run is now recorded below. Owner-budgeted live cache and behavior checks still require their separate evidence. Preserve the API, release channel, task size, model, and effort in each report. Do not present an offline replay as a live quality or performance result.

The optional `offline_footprint` input on the `test` workflow prepares that scoped
capture: Vector on Messages and Responses, Standard and Thorough, two sessions
of the fixed `solo-fix` script, with the judge explicitly off. It defaults off.
This job runs the source CLI, not a packaged desktop or published CLI release.
The new harness `--task-size` and `--judge` controls are optional; omitted values
keep the existing CLI defaults and appear as null overrides in the report.
The focused controls file passes three tests (19 assertions), covering omitted,
supported, invalid, missing, and duplicate values without starting the harness.
Each fixture retains its isolated home, clean child environment, synthetic key,
and local fake-provider URL. Reports and raw payloads are CI artifacts, and each
report is also written to job logs for durable evidence capture.

All four jobs passed on `09cf9fa0`: all eight sessions completed the fixed script
and passed fixture verification, with five parent requests per session. The
[complete reports and request-control evidence](../../benchmarks/vector-footprint-2026-10/README.md)
preserve API, source revision, size, model, and observed effort. Standard and
Thorough retain their existing different reasoning settings; no effort default
changed. The report compares request bytes and offline token estimates within
each API. Cache and dollar fields remain synthetic estimates, not measured live
cache hits, model quality, or token-cost savings. Live cache/behavior checks and
release memory profiling remain separate work.
