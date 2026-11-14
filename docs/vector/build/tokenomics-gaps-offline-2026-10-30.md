# Tokenomics gaps — 30 October 2026

Status: investigation complete at the pinned revisions below. Three previously
authorized fixes are committed locally and unreleased. No live provider calls
have been authorized or run. New audit-derived fix packages await owner review.

## Scope and task ledger

The owner asked to continue the isolated efficiency fixes and add the supplied
handoff to the investigation. Product fixes are in the separate local
`tokenomics-efficiency` branch. This `tokenomics-gaps` branch contains reports
only. Neither branch changes the other active product workstreams.

Baseline: `origin/main` at `78526052c0d576adec2904dc221fb67fdde573b0`,
desktop 1.99.112. The source CLI and the published CLI must not be confused.

| Task | Status | Evidence or next action |
| --- | --- | --- |
| Read live archive and previous audits | Completed | Historical live evidence and later scripted measurements inspected; stale API caching claims identified. |
| A. Provider pricing, missing usage, guard correctness | Completed | Five positive controls and two intentionally red production-boundary contracts; uncertainty is separate from savings. |
| B. Hidden model-call inventory | Completed | Thirteen call categories traced; plain-code operations excluded. |
| C. Cache stability and recalled-memory hypothesis | Completed | Mutable personal recall reproduced through production Brain dependencies; private engine fill traced, not provider-wire measured. |
| D. Other branch footprint risks | Completed | Four pinned refs inspected; no source changes to those trees. |
| E. Fresh offline footprints | Completed | 40 valid cells / 200 local scripted requests; Windows adapter and failed attempts documented. |
| F. Minimal live proof plan | Completed, not executed | Separate cache-smoke and matched-round plans; current pricing and explicit authorization still required. |
| Existing fix: task-tracking contradiction | Committed locally | Existing 19 sizing tests pass; actual behavior and savings remain unmeasured. |
| Existing fix: automatic-title output allowance | Committed locally | 24 tests pass, including SDK wire; four regressions fail against old source. |
| Existing fix: date-window ancillary usage | Committed locally | Eight tests pass; five fail against old source with corrected fixtures. Includes import deduplication and unknown-charge warnings. |
| Final review and docs-only publication | Report reviewed | Publication is tracked by the remote branch history. No new pull request, merge, deployment or release. |

## Evidence rules

- **Live** means recorded calls to a real model in the historical archive.
- **Offline** means local scripted execution, request capture, unit/integration
  tests, or cost simulation. It does not establish model behavior or real cache
  hits.
- **Code** means a source-level finding that has not yet been reproduced.
- Unknown usage, price, coverage and platform measurements stay unknown.
- Run one Bun workload at a time. Run tests individually from their package.
- Do not read credential files, dump environment variables, or include private
  transcripts, request headers or personal contact details in this report.

## Answer

Most mechanical fixes from the October study exist. Current emitted prefixes
permit reuse under the simulated cache. This does not establish whether the
released provider path gets real cache hits; that still needs live proof.
Independent probes reproduced two accounting defects: missing usage can
look like measured zero, and title spending does not reach the active Run Guard.
Personal-memory edits can also change historical prompt text. Editor completion
cancellation is a material code-level waste risk outside the old CLI benchmark.
Three earlier-authorized fixes are locally committed and tested below. Neither
this offline work nor the old archive establishes a current general cost or
quality advantage over competing agents.

## Why fewer tokens can cost more

A token is not a uniform unit of money. Uncached input, cached input, cache
writes, visible output and reasoning have different rates. Extra helper and
child requests also count. A smaller prompt can cost more if its first request
is cold or its model generates more expensive output.

The historical patched comparison used 32.7% fewer total tokens but cost 25.6%
more at the archive's frozen rates. The original nine-run cohorts cost
$0.4487 versus $0.2685; a later 18-run comparison narrowed the difference to
$0.6126 versus $0.5261. These are historical API-equivalent estimates, not
invoices or current prices. Later experiments varied and did not establish a
general advantage. Do not add repeated projections of the same trials.

Sources: `docs/benchmarks/vector-codex-2026-10/README.md`, `summary.json`,
`data/patched-vs-codex.metrics.json`, `data/next-efficiency.metrics.json`, and
`docs/vector/handoff-2026-10/eff-diagnosis.json`. The archive was exported on
October 10; retained live results span October 7–10 UTC. The later October
11–16 integration evidence is scripted replay, not a new live result.

## What is already implemented

- Stable instructions precede session-specific context; tool names are sorted.
  Compatible providers receive cache breakpoints. API-key requests can still
  reuse a stable prefix even though their system text remains one block.
  `engine/src/session/llm/request.ts:65–78,217`.
- The session snapshots instructions and its brain digest. A warm session can
  retain its larger tool cohort after a smaller follow-up, avoiding needless
  prefix changes. `engine/src/session/prompt.ts:281–299,2493–2513`.
- Task sizing is plain code. Main withholds delegation on ordinary Standard
  work unless a subagent was named; a greeting uses a small lane. No router
  model is needed. `core/src/task-size.ts:96–104,126–166`.
- Edits and their shell checks may share a response. The check waits until the
  edits finish. This enables fewer turns without skipping verification.
  `engine/src/session/llm/tool-order.ts:7–12,52–104`.
- Headless sessions use a local title. Desktop sets a provisional title and
  waits for the first answer before generating a model title.
  `engine/src/cli/cmd/run.ts:646–654`; `session/prompt.ts:438–517`.
- Long tool output is bounded. Compaction/pruning are cache-aware, and context
  is reduced before long-context price jumps. Repeated unchanged results or
  identical errors can pause a run. `engine/src/session/overflow.ts:65–85`;
  `session/compaction.ts:261–310,350–366`; `core/src/spend-guard.ts:27–31,267–331`.
- Root, child and batch ledgers exist. Reverting history does not erase spend.
  Helpers have ancillary events and descendant usage is projected into totals.
  Accounting gaps below remain despite those mechanisms.

Paths in this report omit the leading `packages/` unless stated otherwise.
Line references describe baseline main, not the locally modified fix branch.

## Ranked savings opportunities

Dollar rankings are conditional, not invented measurements. Cache behavior
and editor activity can change their order. Fix accounting before judging any
claimed saving. The objective is cost per correctly completed, independently
verified task, including failed attempts.

| Rank | Gap and evidence | Likely economic effect | Proposed fix, size and risk | Shared-file owners |
| --- | --- | --- | --- | --- |
| 1 | Real first-request cache reuse remains unmeasured. Historical first turns were cold in 20/27 runs; current API layout is stable-first. **Historical live + current code; fresh offline results below.** `engine/src/session/llm/request.ts:65–78`; `provider/transform.ts:1173–1180`. | Historically the largest cause. Historically the largest modeled opportunity; current dollar effect unknown. | First measure released API-key cold/warm sessions. Only then compare session/cohort cache routing or supported retention options. Small experiment; medium policy change; risk of routing/cache regressions. Do not silently change the cache key or add billed warm-ups. | Provider/request paths overlap self-evolving, Codium and GitHub-agent work. |
| 2 | Editor autocomplete can discard a result without canceling its dispatched request. Default on, selected chat model, 400 ms debounce. **Code.** `app/src/context/settings.tsx:217`; `components/monaco-code-editor.tsx:293–312`; `pages/session/session-side-panel.tsx:2483–2523`. | Up to roughly 16K input characters per dispatch before formatting; frequent canceled requests on a premium model can dominate small title savings. No dollar measurement yet. | Propagate cancellation to the specific completion run, coalesce stale requests, settle billed partial usage; offer an explicit completion-model policy. Medium; avoid aborting the main conversation or suppressing paid receipts. | App/editor and request lifecycle; coordinate with active app branches. |
| 3 | Personal/mixed memory is re-rendered into earlier history from live active rows. A same-ID edit can change old prompt bytes. **Offline: production Brain dependency probe plus code-traced engine call site; no provider-cache measurement.** `engine/src/session/prompt.ts:3173–3176,3236–3237,3265–3275`; `core/src/brain/brain.ts:925–933`. | May turn otherwise cached suffixes into uncached input or force a full continuation. Quantity unknown. | Authorized revision snapshots plus explicit correction appendices. Medium/large. Forgetting, access revocation and privacy changes must still remove old data immediately. | Brain/session files overlap self-evolving and research. |
| 4 | Large tool cohorts and new delegation policies can erase earlier prompt savings. Main keeps task tools off Standard; self-evolving offers them again. Installed MCP/plugin tools are not removed just by task size. **Code + offline footprint.** `core/src/task-size.ts:93–104`. | Cost depends on cache warmth and actual child launches. Static description trims do not establish net savings. | Measure real configured tool cohorts and cost per successful delegated task; use bounded/discoverable tools where justified by evidence. Medium/large; hiding needed tools can add turns or reduce quality. | Multi-agent/self-evolving, MCP, Hands, Codium. |
| 5 | Automatic title inherits a task-sized output allowance and can retry twice. **Code + local cap regression.** `engine/src/session/llm/request.ts:158–165`; `session/prompt.ts:499–507`. | Healthy short titles may cost unchanged. Bounds a high-cost reasoning/repetition outlier. Historical title estimate was about $0.0014/run on one old model cohort. | Local fix caps automatic title at 512 tokens, preserving lower caps and provisional fallback. Small. Retry/model-title policy remains a separate choice. | Request prep and session prompt overlap several branches. |
| 6 | Standard's tracking sentence conflicts with the to-do tool's instruction to skip routine investigation. **Code; current behavior saving unmeasured.** `core/src/task-size.ts:117`; `engine/src/tool/todowrite.txt:1–3`. | Historical removal of excess tracking saved turns; the present sentence's effect is not measured. | Local fix reconciles requested/substantial milestone tracking with direct routine work. Small. Live behavior gate still required before a release claim. | Task sizing overlaps self-evolving. |
| 7 | Production API-key transport stays HTTP by default; continuation still sends schemas and changes to tools/reasoning force full sends. **Code + older offline transport study.** `engine/src/plugin/index.ts:64–74`; `plugin/openai/continuation.ts:20–28,96–104`. | Primarily upload/latency savings, not necessarily token-cost savings. Old 53% byte reduction produced only about 6.3% modeled cost reduction. | Validate release-equivalent transport and error/fallback behavior before changing defaults; consider schema reuse only with supported protocol semantics. Medium. | Provider/transport, Codium, self-evolving. |

### Seconds and memory, after dollars

The speculative connection optimization requires `fetch.preconnect`, so it does
not help the Electron Node sidecar; Windows Bun's implementation is also
POSIX-limited. `engine/src/provider/provider.ts:404–410` and
`test/provider/preconnect.test.ts:29`. The old claim that OAuth warms the wrong
host is stale: `plugin/openai/codex.ts:554–556` now supplies the correct origin.
Optimize this only after profiling the actual released runtime. It is a latency
opportunity, not an established token saving.

The best older memory study was a pre-merge offline branch measurement around
517–528 MiB. No fresh process-memory number should be inferred from it. Windows
RSS is unavailable in this investigation's adapted footprint runs.

## Accounting and Run Guard correctness

These issues change the truth of cost reports or enforcement. They must not be
advertised as cheaper inference.

| Issue | Failing scenario and present evidence | Required correction/test |
| --- | --- | --- |
| Missing usage can look like a measured zero | On a priced model, `Session.getUsage` with absent counters returns zero cost and `unpriced: false`; the main processor can persist it without an uncertainty flag. `engine/src/session/session.ts:451–514`; `processor.ts:654–689,801–831`. **Offline: production normalizer contract reproduced; no full processor stream replay.** | Mark missing/partial usage independently of whether a catalog price exists. Test complete, absent, partial, aborted, retried and metadata-only usage without inventing token counts. |
| Ancillary title/memory cost bypasses the active guard | A primary run at $0.09 under a $0.10 cap plus a $0.03 title can persist $0.12 while the guard stays $0.09. `engine/src/session/title-usage.ts:17–38` publishes events but does not record guard spend. **Offline: production TitleUsage and actual guard boundary reproduced with isolated event persistence; no live inference.** | Bind each helper receipt to its immutable launching run, settle once, preserve incomplete attempts, and prevent a late receipt charging a newer run. |
| Explicit gateway zero can count as unpriced | Explicit OpenRouter cost zero is known in normalization; processor promotes unknown pricing only when cost is greater than zero. Forty known-zero calls can trip the unpriced-step guard. `engine/src/session/processor.ts:382`. **Code.** | Distinguish missing price from measured zero; test both and retain true unknown-step protection. |
| Date-window CLI stats omit ancillary events | A title or memory charge inside `--days` is absent from transcript-only window totals even though all-time projected counters include it. `engine/src/cli/cmd/stats.ts:200–221`. **Offline: five failures on old stats; eight passing tests on local fix.** | Local patch reads dated ancillary events, includes them once, and keeps helper calls out of chat counts. Test window/lifetime/fork/helper attribution and token categories. |
| Numeric totals can conceal unknown charges | Baseline CLI stats displays numeric cost without an unknown/incomplete warning. **Code + local regression.** | The local patch carries recorded uncertainty and labels a known subtotal plus unknown requests. It cannot recover uncertainty that the main processor failed to record. |
| V2 tokenomics parity is incomplete | The runner's checklist says compaction is not charged to its cap, config `budget.run` is not applied, and retry/repeated-call bounds remain pending. `core/src/session/runner/llm.ts:65–67`. **Code; separate execution path.** | Complete and test parity before extending current Run Guard claims to that runner. Do not imply all desktop sessions use it. |

Standard OpenAI/Anthropic normalized arithmetic looked sound: cache is
subtracted from inclusive input once; reasoning is separated from inclusive
output and priced once. A flat cache-write rate cannot describe mixed 5-minute
and 1-hour writes, but current default breakpoints use 5-minute writes. This is
an unsupported pricing mode, not a proven default double-counting bug.

Provider-reported OpenRouter charges override the catalog only for unpriced
models. Catalog estimates for other models intentionally may differ from actual
bills, discounts and plan charges. A soft cap can overshoot while in-flight
agents finish. Ordinary sessions do not use per-invocation reservation admission
(`engine/src/session/admission.ts:32–35`); the review planner's next-step estimate assumes 600 output
tokens and 3,000 context slack (`core/src/review/plan.ts:13,27,110–120`).

## Synthetic accounting probes

Five controls passed: inclusive OpenAI cache/reasoning, inclusive Anthropic
normalization, explicit gateway zero, truly unknown pricing, and the title
helper's conservative missing-usage flag. Two intentionally red contracts
reproduced defects: missing paid usage returned `unpriced: false` and cost zero;
a $0.03 title receipt left the actual guard at $0.09 instead of $0.12, with no
cap stop. Expected exit was one. Event persistence alone was replaced with an
isolated local broker. No complete processor replay or real bill was tested.

## Hidden model-call inventory

| Call | Trigger/default/frequency | Model and bounded context | Accounting and risk |
| --- | --- | --- | --- |
| Title | First real root chat; desktop normally once, up to two retries; headless skips | Title override, else permitted small model, else primary; user text at most 1,500 characters; no tools | Ancillary ledger; active-guard gap above. Local patch bounds output at 512. |
| Model memory learner | Optional corrections not handled by deterministic extraction; default local-only; latest correction per completed run, one retry | Small/primary; typed text at most 4K characters plus 600-character prior reply | Ancillary receipt preserves incomplete usage; active-guard gap. Next user request cancels learner. |
| Coding judge | Off by default; explicit request/settings can enable; bounded verdict/repair rounds | Judge override or parent; task session can read and make multiple turns | Ordinary child accounting. Thorough alone does not mean a default judge bill. |
| Research citation judge | Default unset checks Deep and Focused with at least eight notes; at most 30 notes per judge, two concurrent, one lead repair | Parent/research-judge model, claim/quote/context | Research child accounting; coverage/quality still need evaluation. |
| Compaction | Threshold, overflow or explicit request | Override/primary; selected history and previous summary; no tools; medium effort ceiling where supported | Normal processor receipt; summarization input can be large; V2 cap gap is separate. |
| Document distillation | Explicit request plus `VECTOR_KNOWLEDGE_DISTILL=1`; off by default | Chosen/default model; at most 30K section tokens plus overhead, 4K output | Hidden helper retains spend-only receipt after source-bearing helper deletion. |
| Task subagents | Model invokes task; main ordinary Standard withholds new delegation unless named | Explore may choose a known cheaper small model; general usually inherits primary | Descendant and batch accounting. Additional prompts/reading can outweigh savings. |
| VectorScope | PR/local/desktop/manual trigger | Review plus optional security, verification and finalization | Several helper sessions, not one small inference. |
| Editor autocomplete | On by default; 400 ms debounce, 40-entry suggestion cache; helper recycled after six calls | Selected chat model; up to 12K prefix + 4K suffix characters; quick lane, effort off, newest request only, no tools | Hidden child receipt; UI cancellation does not currently cancel dispatched work. |
| Inline editor AI | Explicit edit/review/architect command | Selected model/variant and file/request; no tools | Hidden child accounting. |
| Project-copy name | Nonempty context sent to name-generation endpoint | Small/default, 1K context characters, two retries | `handlers/project-copy.ts:25–64` discards usage; no persisted session/ancillary receipt observed. |
| Agent configuration generation | Explicit agent creation/generation | Requested/default model; description and known agent names | `engine/src/agent/agent.ts:907–980` uses direct object generation; no session ledger observed. |
| Help assistant | Explicit product-help question | Separate company-funded server model; bounded docs/history/output | Operating cost outside the user's BYOK ledger; report separately. |

Sources: `engine/src/session/prompt.ts:438–517,878+,1036–1045,2882+`;
`session/compaction.ts`; `session/distill.ts:180–279`;
`app/src/context/settings.tsx:217`; `pages/session/session-side-panel.tsx:2450–2523`.

Despite their names, ordinary `SessionSummary.summarize`, request sizing,
escalation bookkeeping, typed preference extraction, consolidation, credit
updates and indexing are plain code, not extra model calls.

## Prompt-cache stability

A production Brain probe reproduced this dependency: one recalled personal ID
remained the same after an edit, but its rendered recall changed from comparison
tables to brief bullets; archive removed it. Both byte-stability checks were
false. The private engine fill function was traced in code, not executed on a
provider wire. This establishes mutable historical text, not its paid cost.


The memory lead affects recalls containing personal IDs or document cards, not
every repository-only recall. `recallFor` persists IDs; `withheldRecall` rebuilds
their lines before provider sends. Editing an active same-ID personal entry can
therefore change an earlier user-message attachment. Document cards have a
64-session in-memory snapshot LRU; personal lines do not. Restart or eviction
can also lose document snapshots.

Required privacy invalidations are correct: forgetting, revocation, lost access
or a forbidden audience must remove earlier material. A proposed cache fix must
not keep revoked text. Credit decay alone does not change rendered text.

Other deliberate/conditional changes include model switches, changed MCP or
skill listings, role/task-size tool cohorts and document-aware memory tool
descriptions. MCP names are sorted; no random-order defect was found. The date
is fixed to the session; the old midnight problem is addressed. A full WebSocket
resend is not by itself proof of extra billed tokens.

## Other branches, inspected without editing

Pinned refs: self-evolving `57f6656`, Codium `2722736`, GitHub agent `19cb3d5`,
Hands `f902502`. Hands advanced during the audit to `dcbe0fb` (D10 overlay
pages/layout); its engine tool/request files were unchanged in that delta and
its latest progress still says native controller/helpers are pending. The matrix
remains pinned to `f902502`, not a claim of measuring the moving head.
Their differences from main contain unrelated divergence;
missing files in an older tree are not counted as savings.

| Branch | Changes that affect economics | Measurement limits |
| --- | --- | --- |
| self-evolving | Task description shrinks 844 characters (about 211 char/4 tokens), but Standard regains delegation and task-management schema expands. At most eight learned-skill descriptions can add roughly 534 estimated tokens before wrappers. Learned workflow routing is plain code; optional skill wording is local-only by default. Fork cache-root keys and parent-boundary hints are added. | Full procedures load on demand. Model routing requires recorded outcomes. Neither static trims nor learned routing establish a net live saving. |
| Codium | Auto is plain tier/context selection once per user message, not another LLM router call. It keeps that model through the message's steps; a later message can change models. Helper floor/default/skip policy and 60-second catalog deduplication exist. | A model switch can lose cache reuse. Plain OpenAI/Anthropic footprint runs do not exercise paid Codium gateway traffic. No live gateway calls run here. |
| GitHub agent | Pins about 539 characters (135 estimated tokens) of repository/untrusted-input policy for GitHub requests, children and follow-ups. Withholds unavailable browser/computer/cloud capabilities. | Safety policy must not be removed for a small token saving. Generic CLI footprints do not trigger its GitHub-only policy. No customer GitHub calls. |
| Hands | Conditional computer description about 716.5 estimated tokens plus about 342.25 system-policy tokens, excluding schema/images. Screenshots are downsized; large-model retention can reach 27 screenshot-bearing parts before batch pruning. | Vision costs need actual image/cache usage measurement. Native controller/helpers remain unimplemented in this checkpoint. CLI without the bridge does not offer these tools. |

Sources on those refs: `core/src/codium-auto.ts:13–48`;
`engine/src/session/workflow.ts:23–27,119–143`;
`core/src/brain/skill.ts:37–50`; `engine/src/skill/learned.ts:21–25,122–133`;
`cli/cmd/github.policy.ts:5–19`; `computer/scale.ts:12–32` and `screens.ts:31–34`.

## Fresh offline measurements

Completed: 40 validated cells and 200 local scripted requests across five pinned
trees. Every cell exited zero, consumed every script step, preserved protected
tests and passed its independent fixture check. Each cell made five requests;
no model-selected delegation, title or warm-up calls were needed.

The native harness's first Windows attempt failed: it expects
POSIX `ps`, and its clean environment omits `PATHEXT`, so PowerShell cannot
resolve native test executables correctly. No invalid attempt is a passing run.

A private derived harness keeps the original scripted operations and strict
verification. It adds only minimal Windows bootstrap variables, makes process
RSS explicitly unavailable instead of zero, and selects Standard/Thorough with
the coding judge explicitly off (its existing default). Stable temp paths must
be preserved between sessions: using a different TEMP per session artificially
changes shell tool definitions and produces a cold-prefix artifact.

The matrix has one two-session repetition per tree/size on one solo-fix fixture,
not repeated live performance trials. It runs serially: one Bun workload, both request formats, two
fresh sessions, each size, each pinned tree. Tokens are characters/4 and prices
are the archive's frozen rates. No cache routing, provider retention, true
tokenizer counts, model choices or reasoning quality are measured. Timing/RSS
must not be compared with the old Mac runs as a speed/memory claim.

### Fresh footprint table

The table reports tool definitions, not a uniform definition of system prefix:
Responses represents leading developer context differently from Messages. The
two formats use different frozen model rates, so this is not a price contest
between them. Cold/warm refer only to the simulated cache.

| Tree / size | Format | Tool tokens | First input | Second-session first cache read | Cold / warm modeled USD |
| --- | --- | ---: | ---: | ---: | ---: |
| main / standard | Messages | 6,915 | 10,137 | 9,693 | $0.055658 / $0.022217 |
| main / standard | Responses | 6,237 | 9,108 | 8,704 | $0.028291 / $0.011753 |
| main / thorough | Messages | 9,626 | 13,286 | 12,866 | $0.071246 / $0.026858 |
| main / thorough | Responses | 8,790 | 12,100 | 11,648 | $0.035350 / $0.013219 |
| self / standard | Messages | 7,912 | 11,446 | 11,015 | $0.062138 / $0.024136 |
| self / standard | Responses | 7,200 | 10,485 | 9,984 | $0.031604 / $0.012634 |
| self / thorough | Messages | 7,912 | 11,444 | 11,015 | $0.062127 / $0.024125 |
| self / thorough | Responses | 7,200 | 10,483 | 9,984 | $0.031584 / $0.012614 |
| codium / standard | Messages | 6,915 | 10,137 | 9,693 | $0.055658 / $0.022217 |
| codium / standard | Responses | 6,237 | 9,108 | 8,704 | $0.028291 / $0.011753 |
| codium / thorough | Messages | 9,626 | 13,286 | 12,866 | $0.071246 / $0.026858 |
| codium / thorough | Responses | 8,790 | 12,100 | 11,648 | $0.035350 / $0.013219 |
| hands / standard | Messages | 5,193 | 8,163 | 7,719 | $0.045887 / $0.019257 |
| hands / standard | Responses | 4,641 | 7,260 | 6,784 | $0.023674 / $0.010784 |
| hands / thorough | Messages | 7,904 | 11,313 | 10,893 | $0.061480 / $0.023899 |
| hands / thorough | Responses | 7,194 | 10,252 | 9,856 | $0.030976 / $0.012250 |
| mention / standard | Messages | 6,915 | 10,137 | 9,693 | $0.055658 / $0.022217 |
| mention / standard | Responses | 6,237 | 9,108 | 8,704 | $0.028291 / $0.011753 |
| mention / thorough | Messages | 9,626 | 13,286 | 12,866 | $0.071246 / $0.026858 |
| mention / thorough | Responses | 8,790 | 12,100 | 11,648 | $0.035350 / $0.013219 |

Every run used the same two-session solo-fix script, default coding judge off,
HTTP, frozen prices and the same derived harness. The branch rows measure whole
trees, not one isolated feature. They do not exercise desktop autocomplete,
Codium Auto, GitHub-only policy, paid gateways or a Hands bridge. Hands' older
tree lacks the newer terminal tool; a smaller prefix is not proof of equivalent
capabilities or a recommended optimization.

### Earlier reference, not a matched A/B

| Reference | Messages tool tokens | Responses tool tokens | Warm solo modeled cost |
| --- | ---: | ---: | --- |
| Oct 15/16 final description follow-up | 5,443 | 4,921 | Messages $0.019745; Responses $0.011034 in that fixed replay |
| Current main, Standard | 6,915 | 6,237 | Messages $0.022217; Responses $0.011753 |
| Current main, Thorough | 9,626 | 8,790 | Messages $0.026858; Responses $0.013219 |

Current Standard offers about 27-28% more estimated tool-definition tokens than
the older reference. Platform-specific shell instructions, added capabilities,
changed cohorts and fixture output all matter. This is not a causal price A/B.
The older study ran on macOS and this one on Windows. The cold/warm result shows
only the simulated cache's ability to reuse the emitted prefix.

The source/adapter hashes, numerical categories, fixture status, frozen rates
and raw-report hashes are in
[footprints.json](../../benchmarks/tokenomics-2026-10-30/footprints.json).
No headers, credentials, full request bodies or real transcripts are exported.
[Portable offline tooling and commands](../../benchmarks/tokenomics-2026-10-30/README.md)
include source text for the adapter and both synthetic probes.
Failed native/adaptation attempts remain in private local logs. A sensitivity
control with a different TEMP for each home produced zero second-session
first-request reuse; restoring a stable runtime TEMP restored reuse. That is a
harness artifact, not evidence that normal product chats change TEMP or that a
real provider lost cache.

## Live proof plan — not executed

### Smallest useful cache test

Use the released desktop engine with an owner-connected API key and HTTP,
normal approval controls, one synthetic repository, and the same model,
instructions, tools and effort. Use two fresh chats back to back. Ask each to
read the same short synthetic source and state its timeout constant; no edits,
web, delegation or integrations. A greeting would exercise the cheap lane and
would not test the normal coding prefix. Retain every attempt, including errors.

Record the actual first provider turn separately from follow-up turns and title
helpers: uncached input, cache read/write, visible output, reasoning, route/model,
latency and unknown usage. A supported step diagnostic must show actual provider
cache reads; a byte-identical request or `previous_response_id` is not proof.
Measure an API-key release, not a source build that silently enables WebSocket.
A positive two-chat result proves reuse can occur; a negative smoke result is
inconclusive because provider routing can vary. Repetition or a cache-key A/B
requires a separately approved study, not selectively rerun successes.

Illustrative cost at the archive's frozen $2/input, $0.10/cache-read and
$10/output per million: four 10K-input turns and 400 generated tokens would be
about $0.084 if all input is cold, less when cached. This is not a current quote.
Propose a separate $0.25 authorization ceiling with conservative turn/output
bounds, after verifying the chosen model's current rates. No authorization is
assumed, and a local soft cap is not a guaranteed billing ceiling.

### Matched task round

Adapt `script/agent-eval/live-efficiency.md` to the current released API-key HTTP
path; its old ChatGPT sign-in setup is stale. Run the three archived coding tasks
three times per runtime, alternating order, same model and medium effort, same
protected tests and comparable settings. Include failed work and all helpers,
children, retries and incomplete usage. Report quality first, then cost per
verified success and latency distributions. Subscription API-equivalent costs
must remain distinct from invoices and negotiated charges.

Historical expectation is roughly $1 for a matched round at its frozen rates;
budget a separately approved ceiling (for example $2) after current pricing and
runtime availability are checked. It is a separate authorization from the
two-chat smoke test. Cache-key A/B, reasoning-context A/B and the historical
behavior gate are additional studies, not hidden reruns inside either budget.

## Local fixes and validation

These commits exist only on local `tokenomics-efficiency`; they have not been
pushed, merged or released. The report branch contains docs/evidence only.

| Commit | Change | Evidence |
| --- | --- | --- |
| `5ad724223a05da9472bcf5173f63f444626be34c` | Bound built-in automatic-title output to 512; Fast cannot inflate it; preserve other helpers and normal task allowances | Old source: 20 pass / 4 fail. Fixed source: 24 pass, including actual SDK loopback wire. |
| `87e9ee07091c3a4db85858d5ba4a676b6f8a38c1` | Include dated title/memory receipts in stats, deduplicate imported attempts, mark conflicting/unknown amounts, retain helper/model attribution and clearer token labels | Old source with final fixtures: 3 pass / 5 fail. Fixed source: 8 pass, 53 assertions. |
| `63a6525880fed62181902f26d82daa73e9b4c292` | Reconcile Standard tracking guidance with routine direct work | 19 existing sizing tests pass. No string-matching test is presented as model-behavior proof. |

Core and engine package typechecks exited zero. Initial stats fixtures had an
invalid Effect timestamp API and did not expose the real event service; these
were corrected before the final red/green runs. Earlier failed logs were kept.
All tests ran one file at a time, and no Bun workloads overlapped. Formatting
and Git whitespace checks passed. The external accounting contracts intentionally
remain red because their newly found product defects are not in the three local
patches. The memory probe exits zero and records changed recall bytes. Final
probes run without the initial Bun tsconfig-override warning. The published
portable preparer was also executed: its extra five-request footprint case
passed the fixture and reproduced the recorded Standard prefix; its accounting
probe again produced five controls and two expected red contracts, and its
memory probe completed. Those extra smoke checks are not additional independent
performance trials in the 40-cell matrix.

[Probe facts](../../benchmarks/tokenomics-2026-10-30/probes.json) and the
[validation manifest](../../benchmarks/tokenomics-2026-10-30/validation.json)
retain numerical results and log hashes without publishing private logs.

Stats changes visibility, not provider charges. The title cap bounds a bad
optional generation; it does not establish an average price reduction. The
tracking sentence is slightly longer than the old sentence; its intended gain
is avoiding unnecessary turns, not pretending the static prefix became smaller.
The historical model-behavior gate remains 15/18 and has no new live result.
No primary effort, task model, safety policy, verification or cache-routing
setting was reduced to manufacture savings.

## Fix packages and required checks

1. **Bound optional title generation.** Local patch only. Test 512 cap, Fast
   mode, lower/model caps and actual SDK wire output; preserve normal task and
   other helper budgets. This bounds outliers, not a measured average saving.
2. **Repair windowed stats.** Local patch only. Test ancillary timestamps,
   model/helper attribution, no lifetime double count, no extra conversation
   counts, and visible output versus reasoning labels.
3. **Reconcile tracking guidance.** Local patch only. Keep requested tracking,
   substantial milestones, tool availability, effort and verification. The
   live behavior gate remains outstanding; do not ship a quality/savings claim
   based on a string regression or fake model.
4. **Make uncertainty and guard ownership correct.** Preserve unknown usage,
   explicit zero charges, immutable launching-run ownership and single
   settlement. Test aborted/retried helpers and a new parent run before late
   helper completion. Apply the same guarantees to V2 before claiming parity.
5. **Cancel stale editor completions.** Abort only obsolete completion work,
   coalesce requests, retain partial paid receipts. Test delayed providers,
   resumed typing, out-of-order answers and concurrent main-chat activity.
6. **Stabilize authorized memory revisions.** Test a same-ID edit, a newer
   correction, archive/forget, access revocation, audience change, restart and
   LRU eviction. Required privacy invalidations always win over cache reuse.
7. **Measure cache policy and current tool cohorts.** Begin with offline wire
   assertions and release-equivalent telemetry. Run paid variants only after
   explicit approval. Do not reduce effort, verification or safety policy merely
   to produce a cheaper number.

Product fixes remain isolated from the docs-only report branch. There is no
new pull request, merge, release, paid benchmark or deployment in this work.
