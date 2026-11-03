# Proposed two-session first-request cache check

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
