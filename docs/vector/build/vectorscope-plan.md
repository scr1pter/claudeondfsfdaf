# VectorScope implementation plan

Status: approved build plan, not an implementation or a claim of measured quality.
Baseline: `main` at `78526052` (desktop 1.99.112 published), merged into
`vectorscope` on 2026-11-02; the code evidence below was first inspected at
`b3669a6b` and nothing it cites changed in between. Branch overlaps were
re-checked the same day against `origin/vector-at-mention` at `0b68e8f6` and
`origin/self-evolving` at `7c26a834`. `main` at `1aec0b0e` was merged on
2026-11-03, and VS-01–04, VS-06 and VS-07 start on `vectorscope` that day.
VS-05 waits for the `vector-at-mention` merge, as D1 says.

## Owner decisions

On 2026-11-03 the owner approved all fourteen decisions as recommended, so the
answers below are now the decisions. Anything paid, published or user-facing
still needs the steps those answers name, such as the D7 environment and key,
which are owner setup.

| # | Decision | Approved answer |
| --- | --- | --- |
| D1 | Approve this plan, including the @vector sequencing in "Branch overlaps". | Approve. VS-05 and VS-13 land after `vector-at-mention` merges; VS-16 and VS-20 build their local halves now and their GitHub halves after that merge. Nothing edits @vector's files before then. |
| D2 | First release gate ("Budget, privacy and release gate"). | Adopt the proposed gate as written: no trust/consent regressions, no unaccounted paid attempts, at least 95% completed coverage, at least 80% actionable precision, at most 0.2 false alarms per clean PR, recall no more than five points below the frozen pipeline on paired cases. |
| D3 | Do the gates block release, or does the work ship first behind an opt-in? | Ship changed reviewer behaviour first behind an off-by-default opt-in. Passing the D2 gate is required before it becomes the default; today's reviewer stays the default until then. |
| D4 | Product-plan gating for VectorScope. | None in this build. Access stays as it is today; any Codium plan gate is decided later in the Codium workstream, not chosen by engineering here. |
| D5 | Eval budget and scope. | Dry runs only until the D7 key exists. Then one pilot capped at $50 total and $0.75 per case, one repetition, development split only. The held-out run gets its own budget after the owner reads the pilot report. |
| D6 | Candidate models. | The current default review model plus one cheaper model already in the catalog. No model that may train on prompts. |
| D7 | Eval CI protection and key. | A protected `vectorscope-eval` environment whose only reviewer is the owner, using a new provider key whose provider-side spend limit equals the D5 budget, not the existing `OPENROUTER_API_KEY`. |
| D8 | Datasets and annotation. | Public repositories under permissive licences (MIT, Apache-2.0, BSD), stored as manifests and immutable SHAs rather than copied code. Two independent model-assisted annotation passes; the owner adjudicates only their disagreements. |
| D9 | CLI publication and GitHub App scopes. | No separate VectorScope CLI release. VectorScope uses the release that publishes @vector's v3 commands (`MIN_AGENTS_CLI`, provisionally 1.99.113) and raises `vectorRequiredCliVersion` with it. VectorScope requests no new GitHub App permissions. |
| D10 | Fix consent. | Keep the default: a concrete per-operation approval, separate for apply, repository checks and push, with no standing preauthorization in the first release. GitHub fixes publish only through @vector's publish phase (a `vector/…` branch or a draft PR, never the base branch). |
| D11 | MCP for reviews. | Ship the broker default-deny with no approved servers. No live MCP calls for trusted local reviews in the first release; snapshots start only after the owner names a server and its resources. |
| D12 | Eval publication and product claims. | Keep results internal until a held-out run passes D2 and the owner reviews the aggregate. No comparative or accuracy claim. |
| D13 | Base for the standalone agent. | Start VS-01–07 on `main` now. Start VS-08–12 only after `self-evolving` merges to `main`, reusing the multi-agent modules listed under "Branch overlaps" instead of building parallel ones. |
| D14 | Release target. | Nothing user-facing from this plan in 1.99.113, which already carries @vector and the multi-agent work. Phase 0 tooling may merge earlier because it is manual and CI-only. |

## Summary

Make VectorScope a distinct coding agent across the desktop, CLI and GitHub,
with an explicit review mode and a separately authorized fix mode. Establish
how well the existing product works before choosing improvements. Run the
production pipeline on real changes, preserve its trust and spending boundaries,
then consolidate the two runners and improve measured weaknesses in that order.

This plan does not implement a hosted development environment, Vector Labs,
team features or organization configuration. It does not take over the Hands or
`@vector` cloud-agent workstreams. GitHub Actions remains an existing execution
surface; this work does not create or purchase a new compute service.

## What the code does today

| Evidence | Present behavior and consequence |
| --- | --- |
| `script/vectorscope-eval/run.ts`, its README, `packages/core/src/review/eval.ts` | Ten synthetic fixtures, eight planted defects and two clean refactors. One prompt without tools, security/verify passes or production selection. Matching uses paths and nearby lines, not whether the finding identifies the defect. It is a prompt smoke test, not a product benchmark. |
| `.github/workflows/vectorscope-eval.yml` | Manual OpenRouter runs with model/repeat inputs and retained artifacts, but no total-dollar input or admission ledger. Do not dispatch it to measure the new plan without the budget work. |
| `packages/engine/src/review/run.ts`, `packages/app/src/features/pull-requests/ai-review.ts` | Separate execution loops share pure core functions but own session creation, cancellation, verification and cost handling. Both need to be measured; shared imports do not establish parity. |
| `packages/core/src/review/types.ts`, engine runner, desktop `ai-review.ts` | Default `verify` is `blocking`; desktop checks findings above nit unless explicitly off. Triage forces confirmation. Untrusted suggestions receive additional checks. Preserve these safeguards during consolidation and measure the cost of verifying all findings. |
| `packages/core/src/review/workflow.ts`, `packages/desktop/package.json` | `cliVersionSpec` pins an exact supplied version, falling back to `vectorRequiredCliVersion` for development versions. The manifest still requires `1.99.99`; a new desktop version is not proof that its CLI exists on npm. Fix publication/compatibility as one workflow, not by blindly substituting the desktop version. @vector's unmerged v3 builder adds `MIN_AGENTS_CLI` and canonical-semver pins (see "Branch overlaps"). |
| `packages/engine/src/review/model.ts` | Model choice is configurable; an unattended run can fall back to an available free model which may not train on prompts. No benchmark-backed model certification exists. Keep the existing privacy restriction. |
| `packages/engine/src/cli/cmd/github.review.ts`, `github.review-api.ts`, core `prompt.ts` | GitHub passes PR title, body and author to the runner, plus gathered history/context and human comments. It does not pass a complete PR commit list or bounded linked-issue context. |
| `packages/core/src/review/symbols.ts`, engine `context.ts`, generated workflow | Call sites are gathered from regex-extracted changed symbols, with fixed limits; generated CI disables LSP, formatter and project config. Enabling an untrusted repository's tools is not a safe shortcut to deeper context. |
| `packages/core/src/review/permission.ts` | Review sessions deny all capabilities then allow a small read set; MCP resource reads under `read` with `mcp:*` are denied explicitly. No review MCP support should ship by removing that deny alone. |
| `packages/engine/src/agent/agent.ts`, `agent/prompt/review.txt`, desktop `runVerify` | Internal `vectorscope.*` sessions run with generic `review`/`security` specialist identities and helper lookup, not a separately configurable VectorScope identity. |
| Engine `session/prompt.ts`, `session/system.ts`, `session/tools.ts`, `session/posting.ts` | Outward memory audience depends on `vectorscope.*` session metadata, MCP instructions can enter through a zero-tool server, and resources have a separate read path. Posting checks traverse bounded child-session lineage. Changing only the agent name or tool list misses these boundaries. |
| `packages/core/src/review/skip.ts`, `types.ts` | Automatic reviews skip forks, and skip over 300 files or 5,000 changed lines after ignores. A permitted command can review a fork with untrusted handling. Large changes need bounded coverage, not an unlimited-size default. |
| Core `command.ts`, `state.ts`, CLI `github.review.ts` | Review commands, dismissal feedback, incremental state and verified-fix thread handling exist. They are foundations for conversation, not a general thread-answering agent. |

Existing protections are requirements: configuration from a trusted base for
remote PRs; no checkout or execution of fork code in a privileged review job;
redaction and posting checks; anchored suggestions; bounded attempts including
retries/finalizers; honest partial coverage; and exact head checks before writes.
Spending reservations are estimates and reported usage can exceed them. Neither
the product nor the eval may describe those estimates as guaranteed billing caps.

## Phase 0: measure the product first

### Dataset and ground truth

Build a versioned manifest of approximately 100 real, independently confirmed
bug-fix cases, plus at least 25 clean or behavior-preserving control changes.
Do not treat the corrective diff itself as the bug being reviewed. For each case,
identify the buggy candidate change and its prior base, then retain the later fix
as hidden ground truth. Cases without a defensible candidate/base pair are
excluded with a recorded reason, rather than manufacturing an easy reverse diff.

Record repository URL, license/redistribution permission, immutable base/head
and fix SHAs, language, defect family/severity, expected causal explanation,
locations with acceptable alternative evidence, regression-test evidence and
selection provenance. Public, licensed material only; no customer repositories,
personal email, credentials or private support threads in committed fixtures.
Prefer manifests and fetched immutable objects over redistributing whole repos.
Review archived content for secrets before committing excerpts.

Cover correctness, auth/security, asynchronous/concurrent code, persistence,
error paths and resource handling across several languages and repository sizes.
Use a reproducible sampling rule and record exclusions, so difficult or
oversized changes cannot disappear after results are seen. Include rename,
cross-file, incremental, fork and prompt-injection cases. Injection controls
are separate adversarial tests, not extra easy defects added to improve recall.

Split the bug cases roughly 60/20/20 for development, calibration and held-out
evaluation, grouping related repositories/fix families and respecting chronology
to limit leakage. Split controls separately. Freeze held-out labels before prompt
tuning; keep labels/fixes unavailable to model tools, retrieval and MCP snapshots.
Public model training contamination cannot be ruled out; record dates and this
limit. Do not advertise general real-world recall from 100 sampled cases alone.

### Runner and baselines

Add an eval adapter around the real engine `Review.run` pipeline with actual
read tools, context collection, security/verify passes, selection, anchoring,
finalization, spending and timeout behavior. Exercise the desktop adapter on
the same cases until consolidation proves equivalence. Mock only external
posting; retain the formatted payload the product would send. Use no live
GitHub write, repository install hook, project plugin or untrusted executable.

Baseline variants are: the frozen current engine pipeline; current desktop
pipeline; existing single-prompt harness; and an empty-finding control that
exposes precision denominator behavior. Compare verification/triage/context
variants one change at a time. External competitors are optional only if their
terms, access and owner-set budget permit a comparable replay; their absence
does not block measurement, and no comparative claim follows from proxies.

Record source SHA, fixture manifest hash, prompts/config hashes, exact model
identifier and provider/routing metadata where available, pricing snapshot,
randomization/repetitions, attempt history and tool traces. Record the runtime
and adapter. Hosted aliases can change underneath an ID; certification expires
when the relevant model, prompt, policy or pipeline changes.

### Metrics and judging

Report both proposed findings and findings that survive verification/selection
and would actually be posted. Measure defect recall, actionable-finding
precision, F1, duplicate comments, false alarms per clean PR, comments per PR,
severity agreement, location/anchor validity, suggestion validity, coverage,
timeouts/errors, wall time and total dollars/tokens including retries and judge
calls. Separate security categories, languages, trust modes and size buckets.
Report macro and micro aggregates, sample sizes and uncertainty intervals.

Match the causal defect, not merely line proximity. Two independent annotation
passes establish expected defects and adjudicate ambiguous results; a human
resolves disagreement. A separate model may assist with blinded matching but
cannot be the sole authority or score its own generated findings. Randomize
model identities in judge inputs. Review unexpected findings against the actual
code: a real additional defect is not automatically a false positive because it
was absent from the fix label. Freeze rubric revisions and re-score saved
outputs without repeating provider calls when possible.

Invalid/failed/partial reviews remain visible in the denominator and coverage
report. Present both conditional recall on completed reviews and end-to-end
recall where a failure cannot count as success. Never interpret missing usage
as zero spend or a skipped file as reviewed. Controls with zero findings have
undefined empirical precision on their own; show counts instead of presenting
the legacy scorer's convention of precision 1 as quality evidence.

### Budget, privacy and release gate

The paid eval is manual CI only. Require an owner-set finite positive total USD
budget, per-case limit, model list, fixture selection and repetition count.
Default to a no-network dry run that validates manifests and estimates cost.
Validate inputs without shell interpolation. One coordinator reserves remaining
budget before each provider/judge attempt, including retry and finalizer work;
settle reported usage, retain uncertain charges and stop new work when pricing
or usage cannot be bounded. Apply output/context/time limits and a conservative
reserve. An isolated provider key with a provider-side spend limit is the
stronger monetary boundary; it remains owner setup. Report overshoot honestly.

Use a protected eval environment whose reviewer is the owner. The repository's
existing `OPENROUTER_API_KEY` name is not permission to run it. Untrusted dataset
code never receives the key or network tools. Redact outputs, bound artifact
retention/access, keep raw reports outside the repository and publish only an
owner-reviewed aggregate. An eval failure cannot trigger a paid automatic retry.

Gate rules are to be ratified before collecting the held-out result. Proposed
first gate: no trust/consent regressions; no unaccounted paid attempts; at least
95% completed case coverage within the approved budget; at least 80% actionable
precision; at most 0.2 false alarms per clean PR; and no recall regression above
five percentage points against the frozen current pipeline on paired cases.
Report confidence intervals and require human review when they cannot resolve
the decision; the point thresholds are proposals, not current achievements.
Prioritize measured recall gains subject to precision, noise and spend limits.
Small held-out samples may require more data, not weaker thresholds. The owner
chooses whether these gates block release or first ship behind an opt-in.

## Architecture: one VectorScope agent, one runner

### Identity, modes, model and sessions

Introduce a dedicated `vectorscope` agent definition and prompt. Its settings
are independent of the generic `review` subagent, with an explicit review model
and optional triage model. Existing internal-session visibility and cancellation
continue to work when generic Subagents are disabled. Keep `review`, `security`
and `verify` as identifiable passes under VectorScope, with their permissions
intersected with the mode and trust policy; a specialist cannot broaden it.

Represent the invocation with validated mode, base/head, target repository,
source/trust, model/config snapshot, permission policy, memory namespace and
spend ledger. The trusted adapter sets these fields. PR text, MCP responses and
model output cannot choose them. Keep durable session admission and the
process-local runner coordinator separate as described in root `AGENTS.md`.

The engine owns orchestration. Core holds pure contracts, prompts, parsing,
selection and formatting. The desktop becomes an adapter for source capture,
progress, cancellation and presenting proposals; it must not import engine
runtime into the renderer. Expose typed protocol/server operations and regenerate
the client when that boundary changes. The CLI and GitHub call the same engine
entry point. Keep Node-compatible engine code, no Bun runtime dependencies.

Review mode can inspect permitted source and return findings/suggestions. It
cannot edit, run project code, push, merge, invoke arbitrary shell or write MCP.
Existing opt-in local `--checks` requires separately confirmed trusted-code
execution; a command-name allowlist does not make repository scripts safe.
Neither review mode nor a reviewer prompt may silently switch into fix mode.

### Fix proposals and consent

Fix mode creates a bounded patch proposal against an exact base/head. Applying
locally, running repository checks and pushing are separate capabilities. Show
the concrete diff, paths, destination branch/repository and requested commands
before granting each new capability. A trusted preauthorization may cover an
explicit bounded operation; vague PR text and other people's replies never do.
Store consent with actor, scope, source/head SHA, patch digest and expiry.

Use a separate worktree for a fix. Re-check head and user worktree state before
apply/commit/push and compare-and-write files atomically against the approved
preimage; a moved head or changed patch invalidates consent. Commit and push
are separate permissions, and existing no-push fix prompts stay effective. Never
overwrite dirty user changes. Keep writes behind a trusted executor, not free
shell access for the model. GitHub verifies the requester's current write access
on the target and uses a separate short-lived write credential only after
approval. No fix job executes fork code with privileged tokens. If safe isolated
checks are unavailable, report checks not run. No automatic merge or permission
to push to the base branch; creating a fix branch/PR also needs scoped consent.

Posting a suggestion is not consent to apply it. Test failures or an additional
model pass cannot authorize new changes. Preserve audit records and cancellation
without persisting tokens or leaking private review context into commits/PRs.

### Memory and feedback

Give VectorScope its own repository-scoped namespace for accepted review
preferences, adjudicated finding outcomes and approved recurring checks.
Separate owner-authored policy from observed PR data and proposed learning.
Do not automatically import general chat/personal memory into shared reviews.
Retain the existing posting guard for any recalled content that could leave the
machine. PR/MCP content cannot install instructions or create durable accepted
memories; proposed learning requires the user's approval. Separate local/private
memory from repository-shareable policy, with inspect/delete/disable controls.
Deleting a review or clearing memory must cover this namespace and raw context.

Do not record a dismissed finding as a universally false rule. Capture reason,
scope and supporting evidence; contradictory evidence can reopen a proposal.
Review quality improvements must be measured before enabling automatic learning.

Today `session/prompt.ts` chooses the outward audience from `vectorscope.*`
internal-session metadata, not the agent name. Preserve that metadata or replace
it with an equivalent server-bound policy for review, fix and all child passes;
missing scope stays untrusted. Every external write must retain the posting
guard and complete contributing session lineage. Existing traversal is bounded
(depth three, 200 sessions); new fan-out must either stay within a proven bound
or fail closed when the guard cannot inspect every contributor.

### MCP support without PR-driven egress

Reuse Vector's MCP connection, authentication and lifecycle infrastructure,
supporting existing server transports through a review-specific broker. Servers
and tools are disabled for VectorScope until the owner consents per server and
repository/context. Grant only selected read capabilities; server-provided
`readOnlyHint` or tool names are not sufficient authority. Unknown or potentially
writing tools stay denied. Schema/endpoint/capability changes invalidate consent.
MCP write access is not part of this plan; fix mode does not inherit it.
Consent also filters server instructions, prompts and resource listings before
they reach the agent. In particular a server with zero tools must not bypass
consent through the current system-prompt instructions path.

Read calls are outbound data too: search arguments, resource URIs, pagination
cursors and errors can carry code or secrets. Therefore untrusted PR reviews
receive **no live model-controlled MCP calls**, even to approved read servers.
Before exposing PR text, a trusted broker may take an explicitly authorized,
bounded snapshot from owner-selected resources with fixed arguments originating
from trusted configuration. PR titles, bodies, diffs, comments, model-generated
queries and derived identifiers must never influence those requests. Run no
MCP calls after PR exposure for an untrusted invocation. Disable dynamic tool
discovery/resource expansion that would send its contents outward. If a server
cannot supply such a snapshot safely, it remains unavailable for that review.

Trusted local reviews may request live read calls after server consent, with
tool and argument allowlists, directory/resource scopes, bounded results and
confirmation before sending sensitive code. A locally checked-out PR is not
automatically trusted; author identity, provenance and requested operation
matter, and same-repository contributions can still contain hostile text.
External/untrusted inputs downgrade subsequent egress capability until a new
trusted invocation is created. Responses remain untrusted data, cannot request
more permissions, and cannot be learned or posted without the normal checks.

Keep MCP credentials within the connector, remove model-facing general network
tools, and deny alternate resource-read routes such as `read mcp:*`, nested
subagents and plugin-exposed tools. Enforce policy at execution as well as tool
listing. Audit consent/server/tool identifiers and hashes rather than raw query
data. Test attempts to encode source in URIs, search, error handling and retries;
resource redirects, server reconnects and cancellation must obey the same policy.

## Phased work packages

Paths marked new are proposed files. Test paths are to extend where present or
create when absent. Run test files individually from their package directory;
typecheck affected packages individually. CI owns full suites; no paid eval is
an implicit validation step.

| Phase / package | Files and implementation scope | Verification and done criteria |
| --- | --- | --- |
| 0 / VS-01 Dataset contract | New `script/vectorscope-eval/dataset.ts`, manifest/schema and annotation guide; existing `fixture.ts`. Define immutable candidate/base/fix records, licensing, provenance and grouped splits. | Extend `script/vectorscope-eval/fixtures.test.ts` with missing objects, wrong ancestry, post-fix leakage and duplicate-family split cases. Dry-run validates the frozen manifest and reports exclusions; labels never enter a prompt/tool view. |
| 0 / VS-02 Production replay | New `packages/engine/src/review/eval.ts`; engine `run.ts`, `source.ts`, `context.ts`; eval driver. Run the actual pipeline with recording posting adapter; replay desktop through its injected client. | New engine `test/review/eval.test.ts` covers security/verify/finalize, partial/error/timeout and an untrusted case; compare final placed findings/payloads, not just raw JSON. Baseline artifacts identify source/config/model and every attempted call. |
| 0 / VS-03 Budgeted manual CI | Eval driver and `.github/workflows/vectorscope-eval.yml`; new `script/vectorscope-eval/budget.ts`. Add total budget, per-case bound, dry-run, protected environment and ledger. | New budget tests exercise parallel reservations, retries, unknown cost, cancellation and overshoot accounting without real API calls. Dispatch has no paid default or PR trigger; every paid provider/judge attempt needs admission. |
| 0 / VS-04 Causal judging and gate | Core `review/eval.ts`, new eval judge/report modules, annotation rubric and gate config. | Extend core `test/review/eval.test.ts` for same-line wrong defect, extra true defect, duplicates, zero denominators and missing runs. Blinded human-adjudicated report includes confidence intervals/coverage/spend; owner chooses thresholds before held-out run. |
| 1 / VS-05 Compatible CLI setup (lands after @vector merges) | Before the merge: only the owner's CLI publication (D9); no edits to core `review/workflow.ts` or desktop `src/main/github-pr.ts`, which @vector owns. After the merge: re-check the review job's pin against @vector's `cliVersionSpec`, `GithubAgents.MIN_AGENTS_CLI`, `readWorkflowOptions` header and V24's `cli-too-old` status. Make any remaining change to those files with the @vector owner; raise the desktop manifest pin in the release step @vector's contract names. | Core `test/review/workflow.test.ts`, desktop `github-pr.test.ts` and `scripts/build-identity.test.ts` cover release/dev/missing-publication paths, extended only with the @vector owner. Do not point workflows at an unpublished version or a moving `latest`. Owner publishes npm; plan work never does. |
| 1 / VS-06 Verification parity | Core `types.ts`, `config.ts`, `plan.ts`; engine `run.ts`; desktop `ai-review.ts`. Use one documented verify policy, proposed default `all`, preserving stricter triage/untrusted-suggestion rules and explicit override semantics. | Core config/plan tests plus engine `test/review/run.test.ts` and desktop `ai-review.test.ts` cover all/blocking/off, denied attempts and incomplete verify. Evaluate precision, recall and added spend before changing defaults. |
| 1 / VS-07 Model evidence | Engine `model.ts`; core new `review/model-evidence.ts`; desktop model selection and workflow setup. Associate certification with eval artifacts/config and expiry. | Engine `test/review/model.test.ts`, core new evidence tests and desktop review tests cover unvetted/retired/rerouted models, explicit choice and private-code policy. Warn accurately without silently switching model or treating free/privacy-safe as quality-certified. |
| 2 / VS-08 Shared invocation contract | Core new `review/invocation.ts`, schema/protocol review contracts as needed; engine new `review/service.ts`; existing CLI/adapters. Validate mode, target, trust, consent, snapshots and budgets centrally. | New core contract and engine service tests reject PR-controlled policy, incompatible modes and stale heads. Follow Schema→Core/Protocol→Server dependencies; regenerate client for public API changes. |
| 2 / VS-09 Standalone agent | Engine `agent/agent.ts`, new `agent/prompt/vectorscope.txt`, review model resolution, settings agent selection and internal-session metadata. | Engine `test/agent/agent.test.ts`, `test/review/structured-output-review.test.ts`, review model tests and app settings tests prove independent prompt/model, hidden pass identity, cancellation, and operation when generic review Subagents are disabled. No new permission inherited from generic build mode. |
| 2 / VS-10 Consolidate desktop runner | Engine review service, protocol/server/client boundary and app `ai-review.ts`, `pull-requests.tsx`. Move execution/limits into engine; keep renderer presentation and transport adapter. | Run the frozen shared replay against CLI/GitHub/desktop; extend app `ai-review.test.ts` and engine review tests for disconnect/reconnect/cancel/finalizer/usage. Payload/selection parity or documented intentional differences; no engine imports in renderer. |
| 2 / VS-11 Isolated review memory | Engine new `review/memory.ts`, `session/memory.ts`, `session/posting.ts`; core review state and existing persistence/migration facilities. Add scoped preferences and approval-backed feedback. | New review memory tests and existing knowledge/posting tests cover no personal-memory recall into public reviews, forged dismissal/learning, cross-repo isolation, migration and erase. Namespace inspect/delete/disable works; no global rule learned from one dismissal. |
| 3 / VS-12 Consented local fixes | Engine new `review/fix.ts` and consent contract; CLI `review.ts`; app PR actions/diff preview. Separate proposal, apply, checks and push states. | New engine fix tests and app action tests cover dirty checkout, path traversal/symlinks, head movement, changed digest, revoked/expired consent, failed check and cancellation. Approved patch applies only in its own worktree; unrelated work and base branch remain intact. |
| 3 / VS-13 GitHub fixes and thread replies (lands after @vector merges, through its interfaces) | New core `review/fix-proposal.ts`: the pure proposal, consent and patch-digest contract shared with VS-12. GitHub execution is @vector's: the agent phase's run bundle (V18), the publish phase (V21) for apply, commit and push, and V27 session artifacts for follow-ups. No edits to `github.review*.ts`, `command.ts`, `workflow.ts` or routing in state; a new verb or reply route is a request to the @vector owner. Reply only to an authorized addressed thread and bind fixes to its exact head. | Core contract tests plus tests against @vector's route and publish fixtures after the merge cover revoked collaborator rights, fork requests, bot loops, duplicate delivery, quoted commands, force-push, permission separation and stale findings. No push without scoped consent, and only under V21's branch rules; reply posting goes through current redaction/posting guards. |
| 3 / VS-14 MCP broker and consent | Engine new `review/mcp.ts`, existing `mcp/index.ts`/lifecycle/auth; core `review/permission.ts`; protocol/settings UI for per-server grants. | New engine `test/review/mcp.test.ts`, core permission tests and MCP lifecycle tests cover missing grants, unknown write tools, fake annotations, changed schema/endpoints, symlinks/resource redirects, token leakage and alternate `read mcp:*` paths. Default remains deny, credentials stay out of model tools. |
| 3 / VS-15 Untrusted MCP snapshots | Broker, invocation contract, source/context packers and desktop/GitHub adapters. Acquire fixed owner-selected snapshots before PR exposure; strip live MCP from untrusted sessions. | Adversarial tests inject code into query/URI/cursors/comments and request nested tools/retries/reconnects. Instrument the broker: zero outbound calls influenced by PR or model text, no post-exposure network calls. Unsupported servers fail closed with an explicit unavailable-context note. |
| 4 / VS-16 PR and issue context (split: local half now, GitHub half after @vector merges) | Now: new core `review/thread-context.ts` (typed commit and linked-issue input carrying permission/provenance labels), core `prompt.ts`, engine `context.ts` and the desktop PR data contract. After the merge: the GitHub adapter fills that input with bounded commit messages and explicitly linked same-repository issues, reusing the commit query in `fetchPR` (`github.run-helpers.ts`) and `untrustedJson` (`github.policy.ts`) rather than a second sanitizer; the `github.review-api.ts` change is made with the @vector owner. | Adapter/context/prompt tests cover pagination caps, deleted/cross-repo/private issues, untrusted URLs, API rate limits and injection. No arbitrary URL fetch; no extra account scopes by default; all new text remains data. Measure cross-file recall improvement. |
| 4 / VS-17 Semantic context | Core `symbols.ts`, engine `context.ts`, existing language-service adapter behind trusted execution policy. Begin with deterministic syntax/call-graph context from pinned trusted parsers. | Context/source tests cover renamed/overloaded symbols, unsupported syntax, dependency limits, generated files and timeouts. No project install or untrusted LSP launch in privileged CI. Ship deeper context only with measured gains and bounded latency/spend. |
| 4 / VS-18 Deterministic diagnostics | New engine `review/checks.ts`, isolated diagnostic adapters and core finding provenance/deduplication. Opt-in trusted linters and offline secret scanning with pinned tools/rules. | New check tests cover malicious configs/scripts, secret redaction, no scanner network/telemetry, duplicate model findings and cancellation. Never print the discovered secret. Treat runner isolation as a prerequisite for executing project code; unsupported CI reports unavailable diagnostics. |
| 5 / VS-19 Bounded large PR coverage | Core `skip.ts`, `plan.ts`, state/types; engine runner; desktop estimates/progress. Add explicit resumable batches and cross-batch context rather than deleting size limits. | Core skip/plan/state tests and engine replay cover exactly-once batches, head changes, cross-file defects, cap exhaustion and partial coverage. Never label an incomplete review clean; measure size-bucket precision/recall/spend before automatic enablement. |
| 5 / VS-20 Feedback, setup and rollout (split: local half now, GitHub setup after @vector merges) | Now: review state and memory feedback, local desktop review status (verified/unverified model, consent, MCP grants), opt-in rollout and rollback flags, the non-GitHub sections of the vectorscope docs page and owner-actions. Feedback uses the existing command kinds. After the merge: GitHub setup and stale-workflow state come from V24's status IPC and V25's "Set up @vector" card, which replaces the auto-review setup in `pull-requests.tsx`; VectorScope's status joins that card through props agreed with the @vector owner, not a second card. The GitHub docs sections belong to V29. | Existing desktop/app tests cover interrupted setup and clear unavailable states; stale-workflow detection is tested where V24 owns it. Final frozen eval, security review and per-surface smoke fixtures pass; owner approves release/public language. No team/org features or new commercial gate chosen by engineering. |

Order: VS-01–04 before quality promises; VS-05–07 for immediate correctness and
consistency; VS-08–11 before adding capabilities; VS-12–15 for consent and MCP;
then VS-16–20 ordered by measured impact. Two merges gate that order: VS-05,
VS-13 and the GitHub halves of VS-16 and VS-20 wait for `vector-at-mention`,
and VS-08–12 wait for `self-evolving` (D13). MCP snapshot design and fix consent
must be reviewed before implementation, not bolted onto permissive tools later.
At each phase review from two angles: contract/tests and trust/cost/portability.
Record deviations and evidence, commit review fixes and push the phase branch.

## Branch overlaps and sequencing

Checked on 2026-11-02 with `git show` and `git diff 78526052 <branch>`. Both
branches below were cut from the `main` commit this branch now merges
(`78526052`), so each difference shown is that branch's own work.

### @vector (`vector-at-mention`, owned by another agent)

`origin/vector-at-mention` at `0b68e8f6` has built V00–V17 of
`docs/vector/build/vector-at-mention-spec.md`; V18–V31 remain. Its contract
(section 0.2) owns `packages/core/src/review/workflow.ts`,
`packages/core/src/review/command.ts`, `packages/engine/src/cli/cmd/github.*`
(including `github.review.ts` and `github.review-api.ts`),
`packages/desktop/src/main/github-*.ts`, the GitHub sections of
`packages/web/src/pages/docs/vectorscope.astro`, and the reserved
`api/cloud-agents/*`, `api/_lib/cloud-agents-*.ts` and `api/_lib/github-oidc.ts`.
VectorScope edits none of them. Changes confirmed so far in files this plan
touches:

| File | Confirmed change on `vector-at-mention` |
| --- | --- |
| core `review/workflow.ts` (+527 lines) | A v3 builder beside the unchanged v2 one: `AgentsWorkflowOptions`, `buildAgentsWorkflow`, `buildAgentsRouteScript` and `readWorkflowOptions`, which parses the `# vector-workflow:` header line. `WORKFLOW_FILE` moves to `github-agents.ts`. A v3 file pins canonical semver at or above `GithubAgents.MIN_AGENTS_CLI` (provisionally `1.99.113`). `cliVersionSpec` and the v2 review job stay as they are until V23 and V24 move callers to v3. |
| core `review/command.ts` (+191) | `parseReviewCommand` rewritten: a mention must be a whole word, the App handle `@<slug>` counts, and HTML comments, quotes, fences and inline code never trigger it. `DEFAULT_MENTIONS` now lists `/vector` first. The verbs are unchanged: `review`, `review-full`, `pause`, `resume`, `dismiss`, `task`. The function stays self-contained because the route script embeds its source. |
| core `review/state.ts` (+14) | `ClassifyContext.mentions`, so the review job counts a `@<slug> dismiss` reply as a dismissal, as the route job does. |
| engine `cli/cmd/github.review.ts` (+2) | Passes the workflow's mentions into `classifyPrior`. V20 (not built) adds the Codium review path here: run token, `checks` forced off, heartbeat and settle. |
| engine `cli/cmd/github.review-api.ts` | Unchanged. |
| other engine `cli/cmd/github.*` | `github.handler.ts` split into `github.run-helpers.ts` (V17, explicit contexts), `github.sandbox.ts`, `github.secrets.ts` and `github.cloud.ts`. New `github.policy.ts` holds `githubSystemInstructions` and `untrustedJson`, which writes thread text into a prompt as data. |
| new core `github-agents.ts` | Shared `GithubAgents` constants: mentions, workflow version 3, `MIN_AGENTS_CLI`, job names, `THREAD_PATTERN`, `BRANCH_PREFIX`, run bundle files, `PATCH_LIMITS`, `TIMEOUT_MIN.review` and the Actions withheld-tool rule. |
| engine `session/system.ts`, `session/tools.ts`, `tool/registry.ts` | On GitHub Actions, computer-use MCP servers are withheld whole, with their tools, resources and instructions (`ToolRegistry.actionsWithheldServers`). |

Route for the work packages that planned to edit @vector's files:

| Package | Route | Change to the package |
| --- | --- | --- |
| VS-05 Compatible CLI setup | Lands after @vector merges | V14 already reserves `MIN_AGENTS_CLI`, and V23/V24 move the CLI and desktop to v3, flip `GITHUB_WORKFLOW_VERSION` and add a `cli-too-old` status. Editing `cliVersionSpec` or `github-pr.ts` now would collide with that. Until the merge VS-05 is only the owner's npm publication (D9). After it, rebase, re-check which gap remains for the review job, and make any fix in those files with the @vector owner. |
| VS-13 GitHub fixes and thread replies | Lands after @vector merges, through its interfaces | A GitHub fix becomes an @vector task: the agent phase writes the run bundle (`patch.diff`, `summary.json`, V18) and the publish phase (V21) validates, applies and pushes it under its branch rules (a `vector/…` branch or a draft PR into the PR head, never the base branch). VectorScope supplies a pure fix-proposal and consent contract in its own core file. It adds no second push path, no command verb and no edit to `github.review*.ts`, `command.ts` or `workflow.ts`; a new verb is a request to the @vector owner. Follow-ups may reuse V27's encrypted session artifacts. V18, V21 and V27 are not built, so this waits. |
| VS-16 PR and issue context | Split: interfaces now, GitHub fetch after the merge | Now: a typed, provenance-labelled context input in a new VectorScope core file, the `prompt.ts` sections, engine `context.ts` packing and the desktop PR data contract. After the merge: the GitHub adapter fills that input, reusing the commit query in `fetchPR` (`github.run-helpers.ts`), `untrustedJson` (`github.policy.ts`) and V18's writer/untrusted labels instead of a second sanitizer. The `github.review-api.ts` change is made with the @vector owner. |
| VS-20 Feedback, setup and rollout | Split: local parts now, GitHub setup after the merge through V24, V25 and V29 | Now: review memory and feedback controls, local model and consent status, rollout flags, and docs outside the GitHub sections. After the merge: GitHub setup state comes from V24's status IPC (missing, old, current, `cli-too-old`) and V25's "Set up @vector" card, which replaces the auto-review setup in `pull-requests.tsx` and keeps automatic reviews as a toggle inside it. VectorScope's status joins that card through props agreed with the @vector owner. Feedback uses the existing command kinds. V29 owns the GitHub docs sections. |

Other packages touch the same area less directly and follow the same rule.
VS-08 points `github.review.ts` at the engine review service only after the
merge and with the @vector owner. VS-10 coordinates `pull-requests.tsx` with
V25. VS-14 and VS-15 add to @vector's Actions withholding rather than replace
it, and keep V20's planned read-only Codium reviewer (`checks` off). VS-19
keeps `ClassifyContext.mentions`. Review and fix identities stay separate from
generic `task` mentions.

### Multi-agent work on `self-evolving`: reuse, do not rebuild

`origin/self-evolving` at `7c26a834` (target 1.99.113, not yet on `main`)
carries the multi-agent parity build
(`docs/vector/build/multiagent-parity-spec.md`) and owner workflows.
VectorScope's separate agent reuses these modules after that branch merges
(D13). It does not copy them, add a second coordinator, lock or ledger, or
bypass read-before-write.

| Capability | Files on `self-evolving` | VectorScope use and limits |
| --- | --- | --- |
| Checked structured output | `packages/core/src/json-schema-check.ts` (`accept`, `validate`, `extract`); StructuredOutput validation and `retryCount` in engine `session/prompt.ts`; thinking-safe `toolChoice` in `provider/transform.ts` | VS-09: findings JSON goes through the same bounded checker. Review keeps `retryCount: 0`, which the build left unchanged; enabling retries for `vectorscope.*` passes is a measured VS-06/VS-09 variant, not a default change. |
| Per-call model and effort | `packages/engine/src/agent/subagent-model.ts` (`choose`, `allowed`), `packages/engine/src/config/agent.ts` | VS-07/VS-09: resolve the review and triage models with these rules, which already refuse a model that may train on prompts; no second privacy rule. |
| Schema-checked subagent output | `packages/engine/src/tool/task-structured.ts`, `task/manager.ts`, `task/notify.ts` | VS-04 judge helpers and any delegated pass that returns findings. |
| Forks | `packages/engine/src/session/fork.ts` | VS-06/VS-09: a verify pass may fork the review session to share its prompt cache. A fork keeps its parent's model and whole history, so it must keep `vectorscope.*` scope and untrusted labelling. Measure before use. |
| Audience and lineage | `packages/core/src/session/audience.ts`, `audience.sql.ts` (owner-only and guest-input rows, lineage with fork edges); `audienceOf` in engine `session/prompt.ts` | VS-11: this is the server-bound policy the memory section asks for. Use it for review scope and for the posting guard's contributor lineage instead of widening the depth-3 traversal. |
| File locks and read-before-write | `packages/engine/src/tool/file-lock.ts`, `tool/file-state.ts`, `task/claims.ts`, `tool/owned-path.ts`, `tool/shell/git-mutation.ts` | VS-12: applying an approved patch goes through `FileLock`, `FileState` stamps (the compare-and-write preimage) and owned paths, never a separate writer. |
| Isolated worktrees | `packages/engine/src/task/isolation.ts`, `task/isolation-base.ts`, `packages/core/src/isolation/copy.ts` | VS-12: the fix worktree uses this registry and its Review, Merge and Discard surfaces. Isolation is refused for read-only agents, matching a read-only review mode. |
| Limits and delegated spend | `packages/engine/src/task/limits.ts` (`TaskLimits`, `EXEMPT`), `packages/core/src/spend-guard.ts` (delegated ledger) | VS-06/VS-19: review pass fan-out stays within these slots and ledgers; decide explicitly whether `vectorscope.*` passes are exempt as the judge is. VS-03's eval budget stays a separate script ledger. |
| Workflows | `packages/core/src/orchestration/spec.ts`, `plan.ts`; `packages/schema/src/workflow.ts`; engine `orchestration/runner.ts`, `state.ts`, `ledger.ts`, `runs.ts`, `owner.ts`; `cli/cmd/workflow.ts` | VS-19: resumable large-PR batches may reuse workflow run state and `WorkflowLedger` scoping under a fixed, trusted spec. PR text never shapes a workflow, and untrusted reviews do not run as user workflows. |

### Other workstreams

| Workstream | Coordination boundary |
| --- | --- |
| `codium` | Consumption percentages, model entitlement, gateway privacy and cloud-agent allowance are owned there. Use existing billing/model abstractions; do not expose tokens/prices in a Codium product UI or invent top-ups. Eval dollars are operator diagnostics. Product plan gating is D4. |
| `hands` | Computer-use tools are unrelated to review and remain denied. No takeover of that branch or its work packages. |
| Release 1.99.112 | Published; `main` at `78526052` is its merged state and this branch's base. This plan changes no version or catalog. |
| Release 1.99.113 | Targeted by @vector and the multi-agent build. This plan adds nothing user-facing to it (D14). |
| Owner npm/catalog work | CLI publication is shared with @vector (D9); use a verified published version only. Model evidence identifies exact evaluated models, not an unsupported catalog claim. |

## External prerequisites

The decisions themselves are D1–D14 at the top. These steps only the owner can
take:

1. Create the protected eval environment and the isolated provider key
   (D5–D7). No live paid eval runs before both exist.
2. Publish the CLI on npm with the release that carries @vector's v3 commands
   and approve workflow migrations (D9). GitHub App permissions are registered
   only through @vector's owner setup; VectorScope asks for no new scopes.
3. Merge `vector-at-mention` and `self-evolving` to `main` when their own
   acceptance passes. VS-05, VS-13, the GitHub halves of VS-16 and VS-20, and
   VS-08–12 wait for those merges.
4. Name MCP servers and resources before any snapshot work is enabled (D11).
   No untrusted live-call exception is proposed.
5. Review eval aggregates and any public wording before publication (D12). The
   plan and fixtures do not establish parity with another reviewer.

These owner actions do not block deterministic contract/tests, dry-run tooling
or plan review. Keep a short status record of implemented packages, measured
results, unavailable prerequisites and the next exact action; do not mark a
phase complete because a design document exists.

## Deferred work and public claims

Deferred: organization/team policy, seats, non-GitHub review hosts, broad MCP
writes, automatic merging, hosted development workspaces, laptop/Slack/Linear/
Jira bots, Vector Labs, and arbitrary untrusted-code execution. Also defer
autonomous durable learning until measurement supports it. Existing GitHub
Enterprise support must keep working; it is not a new provider expansion.

Allowed before measurement: factual descriptions of implemented surfaces and
their tested behavior, qualified by current limitations. After an approved eval,
describe only the exact pipeline/model/dataset/version and observed metrics with
sample size, uncertainty, coverage and spend. No claim of competitor parity,
superiority, certified accuracy, guaranteed spend cap or universally safe MCP
follows from this plan. Public wording requires the owner's approval.
