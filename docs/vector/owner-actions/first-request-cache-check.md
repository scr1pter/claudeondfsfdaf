# Proposed two-session first-request cache check

> Update, 1 November 2026: the [offline release-engine study](release-engine-evidence.md)
> now supplies a reviewed driver, durable request-grant checks and report format.
> Exact-artifact execution passed in [run 41260729498](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/41260729498).
> The [raw evidence](../../benchmarks/release-engine-1.99.112/README.md) records two completed sessions,
> two forwarded requests and all five memory phases. It has no live mode. The
> packaged-sidecar-only and provider-enforced $0.25 conditions below were planning
> assumptions; the original audit does not require them for offline preparation.
> A live adapter, credential route and explicit spending authorization remain
> separate prerequisites. The older statements below that no driver exists refer to
> the proposed live driver, not this completed offline rehearsal. The older
> packaged-Electron-only and provider-account-hard-cap requirements below are
> superseded by the current preparation boundary that follows.

## Current preparation boundary

The completed rehearsal used the exact published 1.99.112 sidecar bytes under
Node, with the release catalog verified independently. It did not run inside
Electron. A live check may use that same explicitly described runtime boundary;
running inside the full desktop is needed only for a claim about the full
desktop runtime. Neither execution mode establishes provider caching by itself.

The release's built-in OpenAI hook clears the environment-derived output limit.
The reviewed evidence plugin therefore sets 512 through the supported
`chat.params` hook after the built-ins. The wire capture independently requires
that value. A future live adapter must disclose that intervention and verify
the selected endpoint's output/reasoning semantics; setting the environment
variable alone is insufficient.

The rehearsal also found that the second request contains an advisory memory
note after the shared first 9,958 UTF-8 bytes of the system prefix. Tool
definitions match, while the normal per-session cache keys differ. Keep those
observations in a live report rather than claiming that the entire requests are
identical. The scripted 0/1,024 cached-token values only verify usage projection.

Remaining implementation is a separately reviewed live transport and credential
adapter. The offline driver's loopback-only network namespace and synthetic
credentials must remain its default. Before any budget request, prepare an
explicit live invocation, preserve the durable two-send limit and tool veto,
test its unknown-outcome behavior against a fake endpoint, and establish the
credential's intended destination without reading or copying stored secrets.

The earlier $0.25 figure is a proposed budget, not an owner-approved amount or a
measured charge. A provider-account hard cap is one possible control, not a
requirement imposed by the original audit. A conservative request-cost bound
may instead be reviewable if current route-specific prices, a trustworthy input
bound and an enforced output/reasoning bound are all available. Record which
limits are enforced, which figures are estimates, and any remaining exposure;
never describe a soft software threshold as a hard dollar cap. If a reliable
bound cannot be established, prepare the uncertainty for the owner's decision
instead of manufacturing an account-setting prerequisite.

No ready live adapter or authorized model credential is present. Spending and
the concrete credential route still need the owner's approval after preparation.
No account setting, provider call or budget approval follows from this document.

## Original proposal (29 October; historical assumptions noted above)


Planning only, prepared on 29 October 2026. No live request, account setting,
credential setup, or paid workflow was performed. The offline footprint reports
do not establish real cache reuse. This proposal addresses the smallest live
check in the tokenomics audit, not a quality or speed comparison.

Use one verified production-channel desktop engine artifact for the approved
1.99.112 candidate, after its release artifacts and catalog digest are available.
Record source SHA, artifact hash, version, channel, platform, runtime, and catalog
hash before any live work. If that artifact is unavailable, keep this check
pending; do not fall back to a source launcher or an older installed CLI.
The live process must be that packaged app's actual engine sidecar on an
owner-controlled machine. A standalone Node launch of its bundle is useful
preflight evidence, not proof of execution inside the packaged desktop runtime.
Do not restart an existing user app or server to perform this check.

| Boundary | Existing tooling and proposed use |
| --- | --- |
| Source CLI | `script/agent-eval/footprint.ts` is a fake-provider replay. Its new reports describe source execution under Bun. Use it only for offline instrumentation checks. |
| General live evaluator | `script/agent-eval/run.ts` may choose `VECTOR_EVAL_ENGINE`, an installed CLI, or a Bun source fallback. Its Vector arguments do not impose a spend or step cap. Do not use it unchanged for this two-request check. |
| Existing live guide | `script/agent-eval/live-efficiency.md` describes broader matched studies, and its original setup assumes ChatGPT sign-in. That sign-in is currently disabled; this proposal uses an API key. |
| Desktop engine boundary | `packages/engine/script/build-node.ts` produces the Node bundle. `smoke-node-bundle.ts` shows isolated sidecar launch, explicit session creation, `prompt_async`, event capture, and message retrieval, but is hardwired to fake providers. Reuse its pattern in a separately reviewed driver; do not turn the existing smoke test into a live job. |

The proposed minimum is two new sessions, one provider invocation each, in one
unchanged disposable repository and the same engine process. Run session two
immediately after session one's terminal usage is recorded. Use the same API-key
project, model `openai/gpt-6.1-sol`, Standard size, explicit medium variant, normal
execution mode, tool definitions, settings, and prompt in both sessions. Preserve
the release's existing cache-key policy; distinct session IDs remain distinct
cache keys. Set neither cache retention nor a cache warmup. Do not enable
WebSocket or reasoning-context experiments.

Prepare a small fixed Git fixture with only a README and a notes file, and no
project configuration, custom agent rules, MCP servers, or brain documents. Use
a separate app-data profile with only the capture instrumentation and the
owner-connected API key. Verify that profile isolation is supported and effective
in the offline release preflight; do not copy a real profile or its credentials.
Keep the fixture path and bytes unchanged between the two sessions.

The release API-key path normally uses HTTP; verify `openai transport` diagnostics
actually select HTTP. A development/source build may select WebSocket by default
(`packages/engine/src/plugin/index.ts`), so source results cannot substitute for
this release check. An isolated process may explicitly disable WebSocket for the
instrumentation preflight; the live report must record that setting and the
observed transport. Do not infer transport from a flag alone.

Create both sessions with the same explicit useful title to suppress title
generation. Submit this identical first prompt through the app's normal
`prompt_async` path: “This is a request-cache instrumentation check. Reply only
with CACHE_CHECK_DONE. Do not call tools, edit files, delegate, or research.”
Explicitly select Standard so its stable work instructions and tool definitions
are present; a bare greeting's short prompt would test a different path. Pass
`judge: off` and a run budget of one step plus a $0.05 software threshold per
session. The selected model/variant and normal execution mode must be checked
against each captured outgoing body. No model substitution is allowed.

Proposed owner ceiling: **$0.25 total actual API spend for the complete pair**,
with at most **two forwarded provider invocations total and one per session**.
The dollar ceiling is a requirement to verify before authorization, not a claim
that the current CLI enforces it. `--max-cost` explicitly permits one step of
overshoot per active agent; a step cap, timeout, monthly budget alert, delayed
credit balance, or a request-count gate alone is not a hard dollar cap.

Before any live run, prepare and review a Node-compatible capture/admission gate
around the runtime's normal API-key fetch path. It must leave payloads and normal
authentication unchanged, reserve the one-use session grant durably before
forwarding, and block all other session/model/endpoint requests, retries, helper
requests, or additional sends. Every attempted send, including a transport
failure, consumes its grant. Refuse bodies without an explicit provider-enforced
`max_output_tokens` ceiling of 512, including reasoning tokens; prove this body
limit offline first. The existing process-scoped
`VECTOR_EXPERIMENTAL_OUTPUT_TOKEN_MAX=512` is the proposed limit input; verify
the actual serialized body rather than relying on the flag. A tool hook must
prevent tools from executing if the model
ignores the prompt. This driver/gate does not exist yet; the existing behavior
adapter's durable request-grant pattern and bounded response capture are useful
references, but its historical source bindings and sign-in transport are not a
ready API-key release driver.

The owner must provide an authorized dedicated API key through Vector's normal
connection flow or an approved runtime secret binding, with a verifiably enforced
$0.25 provider/gateway spend ceiling for this run. Confirm model access and the
current applicable prices without a paid probe. Do not inspect or copy credential
files, print keys/headers, substitute a subscription account, buy credits, or
enable automatic replenishment. If the available account only provides soft
alerts, a hard spending mechanism remains missing: stop here rather than call
the software threshold a guarantee or silently raise the budget. No ready model
credential binding was established in this workspace.

Rehearse the exact driver, release artifact, request gate, output ceiling, tool
veto, cancellation, unknown-usage handling, and two-grant exhaustion against a
loopback fake provider before requesting the owner's budget/setup choice.
Preserve that reviewable offline evidence and the proposed exact invocation.
Then owner approval of the concrete model/key route and verified $0.25 ceiling
is the final prerequisite to any paid call. No paid CI job is proposed.

For each session retain its ID, first invocation ordinal, UTC timestamps, exact
request-body hash, selected model/effort, system/tool prefix hashes, cache-key
policy, transport diagnostics, terminal provider usage, and the projected
assistant step usage. Record input, cached input, output/reasoning tokens, and
known actual/provider-reported cost separately.
If the provider supplies only token usage, dollar totals remain catalog estimates
until billing evidence corroborates them; API-equivalent cost is not an invoice.
Compare the second session's first `tokens.cache.read` with the provider's
`usage.input_tokens_details.cached_tokens`; aggregate within-session cache share
is not the measurement. Preserve failures, truncated output, missing usage, and
unknown spend; do not rerun or replace an attempt automatically.

One pair can show that the second first request did or did not report cached
tokens on that attempt. The first request may already be warm; do not label it
cold by assumption. A nonzero second count supports reuse in that pair, while
zero or unavailable usage does not prove that every API-key session is cold.
Do not require the old offline prediction of 7,936 cached tokens: current prompt
and tool sizes differ. This check does not establish routing reliability, the
benefit of removing cache keys, 24-hour retention, model quality, or a live
cost/speed advantage. Those require separate authorized protocols.
