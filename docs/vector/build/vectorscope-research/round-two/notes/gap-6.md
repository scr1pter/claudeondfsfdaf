# G6: Greptile primary sources and third-party runs of current Greptile (round two)

Compiled 2026-11-06. Scope: the gap list GP7, GP8, GP10, GP16, GP18, GP19, GP20 and VOI17 (design facts that rest only on search extracts), plus GU1, GU6 and GU15 (no independent run of shipped v5 or its tiers).

## 0. Access log (read first)

What failed, so the next round does not repeat it:

- **`www.greptile.com` is outside this session's network allowlist.** WebFetch returned `ENOTFOUND` and curl got a CONNECT 403 from the egress proxy. That covers `/docs/...`, `/docs/llms-full.txt`, `/docs/llms.txt`, `/blog/...`, `/changelog` and `/knowledge-base`.
- **`web.archive.org` was refused** ("Claude Code is unable to fetch from web.archive.org", and a proxy 403 for curl). No Wayback snapshot of any Greptile page could be read, so I quote no page with a snapshot date.
- **`codereview.withmartian.com` is outside the allowlist** (WebFetch `ENOTFOUND`, proxy `connect_rejected`), so the online board's `/api/leaderboard` and `/api/daily-metrics` could not be queried.
- **The WebSearch budget for this turn was already used up** by other agents (200 calls shared). I could not search for 2026 bake-offs on dev.to, aicodereviews.io or The New Stack, or for the "ReviewBench June 2026 Greptile run". I did not route around the limit.
- **The GitHub REST API is bound to this session's configured repositories** (`gh api` returned 403 for `greptileai/*`). So I could not open GitHub release pages, including the `greptileai/cli` release-notes page 3.

What worked instead: anonymous `git clone` over the session's git proxy, `raw.githubusercontent.com`, and the npm registry. That turned out to be a better source than the web pages. **Greptile ships its CLI to npm as one readable JavaScript bundle, together with its README, `settings-schema.json` and a full `CHANGELOG.md`.** Its self-host repo and its agent-skills repo are public. Most findings below are therefore **code** (read in shipped source) or **vendor** text shipped inside Greptile's own repos, not search extracts.

Sources read (all accessed 2026-11-06):

- npm `greptile`:
  - metadata: https://registry.npmjs.org/greptile (52 versions, first 1.0.0 on 2024-02-23, latest 3.8.0 on 2026-10-26);
  - tarballs 3.8.0, 3.5.3, 3.1.0, 3.0.0 and 2.4.0 from https://registry.npmjs.org/greptile/-/greptile-<v>.tgz.
- https://github.com/greptileai/cli at HEAD `7ecf571` (2026-05-21). It holds only `install.sh` and a README; its tags run v3.1.1 to v3.8.0 and all point at the same commit.
- https://github.com/greptileai/skills at HEAD `59e79ec` (2026-11-03).
- https://github.com/greptileai/akupara at HEAD `09b7db2` (2026-11-04), the same HEAD as round one. This round adds files round one did not cite: `RELEASE_NOTES_202610.5.md`, `CHANGELOG.md`, `docs/reference/architecture.md`, `docs/operations/scaling.md`, and commits `91705a2`, `cff67df` and `e1eba41`.
- https://github.com/withmartian/code-review-benchmark at HEAD `e616e84` (2026-08-30, unchanged since round one), plus all branches and all `refs/pull/*/head`.
- https://github.com/review-bench/ReviewBench at HEAD `f223ce3` (2026-11-05), with full commit history (128 commits since 2026-09-04).
- No public Greptile docs or changelog repo exists under the obvious names. `greptileai/docs`, `greptile-docs`, `mintlify-docs`, `documentation`, `changelog`, `greptile-mcp` and `trex` all ask for credentials, which means they are private or do not exist. `greptileai/examples`, `greptile-vscode` and `homebrew-tap` are public but irrelevant.

## 1. GP7 "settings are read from base": confirmed for auto-approval, not for review config

**Vendor text in a code repo.** Greptile's self-host release 202610.5 (2026-10-12) says, both in `RELEASE_NOTES_202610.5.md` ("Important fixes") and in `CHANGELOG.md`:

> "Respect automatic-approval settings configured on the base branch and safely withhold approval when those settings cannot be loaded."

This is the first primary text found for GP7, and it narrows it:

- **Scope is auto-approval settings.** It does not say that all review settings come from base.
- **It is listed as a fix.** Before 202610.5, self-host apparently did *not* reliably use base-branch auto-approval settings.
- **It fails closed.** When the settings cannot be loaded, approval is withheld rather than granted on defaults.

**For review config in general, the shipped CLI points the other way, at least for headless (CLI) reviews (code).** In `greptile@3.8.0` `dist/greptile.js`:

- The review preflight collects every changed config file whose path matches the Greptile config names. It sends each one's content *at HEAD* as `prefetchedConfigs`:
  - code: `e.run(["show", \`${n}:${i.path}\`])` with `n` = the head SHA;
  - a deleted config is sent as an empty string;
  - more than 50 changed config files fail with `too-many-configs`.
- `greptile config [PATH]` has this help text: "Reads every local .greptile file, including uncommitted edits, and asks Greptile to merge them with dashboard configuration and organization rules."

So, in CLI mode, the server at least receives the change's own head version of edited config files. Whether it applies them, or prefers base for PR reviews, is decided server-side and not visible. **Inference:** for PR reviews of *policy-bearing* settings (auto-approval), Greptile reads base and fails closed. For ordinary review config, the evidence is open and the CLI path uses head or working-copy content.

**Implication for VectorScope.** Any setting that gates trust, such as approve, skip or depth, should be read from the base commit, and the review should refuse when it cannot be read (this matches I-4's fail-closed direction). A PR that edits `.vector` review policy must not lower its own gate. Plain style and instruction config may follow head for local runs, but the posted review should record which commit the policy came from.

## 2. GP8 review-tier precedence: what the client code shows

The exact docs wording on precedence (`/docs/code-review/review-tiers`) stayed unreachable. The shipped code adds these facts.

**CLI 3.6.0, published 2026-09-25 08:47 UTC, the day tiers launched (code and vendor changelog):**

- "`greptile review --plus` and `greptile review --apex` run a review at plus or apex effort." The two flags are mutually exclusive and cannot be combined with `--resume`. Output and JSON include `effort`.
- The API run schema is `effort: enum ["base","plus","apex"]`, nullable. **There is no `auto` value on the client side.** Auto is not something the CLI can request; it exists only in PR or dashboard routing.

**The README for 3.6.2 or later (vendor) adds:**

> "They require the organization's effort feature and an effort-specific routing rule. If either is unavailable, the review fails without running a fallback. Results include the effective effort. Saved settings do not change effort."

- So an explicit tier request fails closed: there is no silent downgrade to Base.
- Exit code 6 (`feature_gated`) prints a `notice:` line.

**Self-host (code, akupara `docs/configuration/review-variants.md`, as in round one):** `FEATURE_FLAGS_JSON='{"effort-levels":true}'` turns tiers on for the whole instance. With `false`, "Every review then runs at Base". The 202610.5 notes add that only the OpenAI policies `greptile-v5.3@6` and `v5.2-tiers@2` support Base, Plus and Apex.

**The rule language is visible in code (new).** The CLI bundles the server's condition schema (used for TREX flow triggers in 3.8.0 and later):

- **12 fields:** `repository`, `targetBranch`, `sourceBranch`, `author`, `label`, `keyword`, `title`, `path`, `draft`, `filesChanged`, `linesChanged`, `reviewRun`.
- **6 operators:** `is`, `is_not`, `contains`, `not_contains`, `at_most`, `more_than`.
- **Constraints:**
  - per-field operator whitelists;
  - `filesChanged` and `linesChanged` take one non-negative integer;
  - `reviewRun` is `initial` or `subsequent`;
  - `draft` takes no values.
- **Trigger shape:** `{mode:"always"}` or `{mode:"rules", rules:[{conditions:[…]}]}` with 1 to 20 rules. **Inference:** OR across rules, AND within one rule's conditions.
- `"trigger": null` means "use Auto".
- TREX flows accept only a subset of the fields (`path`, `label`, `targetBranch`, `sourceBranch`, `author`, `title`, `keyword`, `draft`). The full set, including `filesChanged`, `linesChanged` and `reviewRun`, therefore exists for other server-side rule consumers. **Inference:** effort, trigger and auto-approve rules; the vendor's "Rules can force Plus or Apex for large PRs" fits `filesChanged more_than N`.

**There is no risk or complexity field in the rule language.** Greptile splits routing into two parts:

- deterministic customer rules over PR metadata;
- a model-judged "Auto".

The precedence between the two (rule beats Auto, presumably) is still extract-only.

**Implication for VS-28.** This matches VS-28's design:

- `riskOf` uses deterministic, documented features;
- a fixed `depth` behaves like an explicit tier;
- `auto` is the judged mode.

Two concrete lessons:

1. An explicitly requested depth that cannot run should fail loudly rather than downgrade, and the output should carry the *effective* depth.
2. If VectorScope adds path or label rules, a small condition language like the one above, with typed operators per field and a cap on rule count, is a proven shape. VectorScope's rules should include a `reviewRun: initial|subsequent` distinction, because reviews of PR updates are off by default at Greptile (§7).

## 3. GP18 size and latency guidance: code-confirmed limits and timings

**Sizes (code, CLI bundles):**

- **CLI 3.5.3** (2026-09-18) refused reviews touching more than 500 files: `if(W.length>500)return Ao("too-many-files",…)`.
- **CLI 3.5.4** (2026-09-21) changelog: "`greptile review` no longer refuses reviews that touch more than 500 files; the remaining preflight limits (50 `.greptile` config files, payload size) are unchanged."
  - This is four days before the tiers launched. It corroborates round one's extract that "previously saved review and auto-approval file limits no longer apply" (config reference). The large-PR answer moved from a cap to tiers.
- **Preflight limits that remain in 3.8.0:**
  - payload at most 3,000,000 bytes (paths, patches, config contents, commit messages and instructions together);
  - at most 50 changed config files;
  - only committed, non-binary changes are sent;
  - commit messages: all if there are at most 50, otherwise only the first and last; subjects are truncated to 1,024 characters;
  - diff context 3 lines by default (clamped 0 to 100);
  - `--instructions` 1 to 2,000 characters.

**Latency (code, vendor-authored agent instructions in `greptileai/skills`):**

- The plugin's `review` skill: "Give the Bash call a **600000 ms timeout**. A review commonly runs longer than the two-minute default."
- `greploop` polls the Greptile check run 60 times at 10-second intervals ("Timed out … after approximately 10 minutes") and caps the loop at 5 iterations.

This is consistent with v5's vendor median of 2:25, and it shows Greptile itself plans for a tail of up to about 10 minutes.

**Self-host capacity (code, akupara `docs/operations/scaling.md`):** "Each worker pod handles up to **two concurrent reviews** by default"; worker replicas = concurrent PR reviews / 2. The LiteLLM proxy has `timeout: 120` and `stream_timeout: 600`.

**Implication.** VectorScope's CI and CLI budgets should allow a 10-minute tail even if the median is about 2 minutes. A plain file cap is the pattern Greptile dropped. Depth or batching by size (VS-19 and VS-28) is the pattern it moved to.

## 4. GP19 Security Agent: no distinct agent visible in the client

The CLI's review result schema (code, 3.8.0) carries security in two places:

- a per-comment `securityIssue: boolean` (default false);
- a review-level `securitySummary: string|null`.

Since 3.5.4, terminal output "omit[s] the separate security-summary section; JSON output retains `securitySummary`". The MCP analytics tool `list_analytics_findings` reports "severity and security totals and trends" (`greptileai/skills` plugin README).

Nothing in the client, the skills or akupara names a separate security agent, route or model alias. The akupara LiteLLM aliases have no security entry (`review`, `review-deep`, `review-light`, `refiner`, `post-review-gate`, judges and so on, already covered by round one). The "Security Agent" item therefore stays extract-only.

**Inference:** if it exists, it is a server-side pass whose output is folded into `securitySummary` and `securityIssue`.

**Implication for VectorScope.** Keeping security as a flag plus a review-level summary on top of one finding list (rather than a separate result type) is the shape Greptile exposes. VectorScope's existing `security` pass can keep emitting into the shared finding list with a class tag.

## 5. The category and severity taxonomy Greptile actually emits (input to VS-28)

From the CLI's zod schema for review comments (code, 3.8.0):

- **`type`:** `info`, `syntax`, `logic`, `style`, `advice`, `checks`, `summary`, `notes`, plus the side markers `old`/`new`.
- **`severity`:** `P0`, `P1`, `P2`. The default is `P2` when absent.
- **`commentCategory`:** `REVIEW` or `TREX`. TREX comments on the same path, side and lines are merged into the review comment as `verifiedEvidence`, shown as "TREX verified".
- **Other per-comment fields:** `linkedRule`, `clarificationQuestion` and `skills`. `skills` is rendered as "via skill: …"; the body may carry "Rule Used / File Used / Context Used" footers.

**Review-level fields:**

- `confidence` (0 to 5) and `confidenceReasoning`;
- `structuredConfidenceReasoning.safetyAssessment`;
- `proofOfWork.cleared_risks[] {name, description}`, rendered as "What we checked" (since 3.5.4, "up to seven 'What we checked' items" on reviews with no findings);
- `fileAnalyses[]`;
- `diagram` (Mermaid).

**What this means.** Greptile's public category axis is coarse and mostly about kind (logic, syntax, style). Security is an orthogonal flag, and severity is a 3-level P-scale. The "risk areas" and "auto-approve risk categories" of GP10 and GP20 are not part of the emitted schema.

For comparison, two independent or semi-independent benchmark taxonomies:

- **Martian** golden labels (code, `offline/results/benchmark_data.json` at e616e84, 173 labels): bug 94, concurrency 14, api 13, security 11, style 10, doc_defect 9, data 7, perf 6, speculative 5, test_gap 4. Severity: Critical 12, High 54, Medium 61, Low 46.
- **ReviewBench** golden findings (code, 4,632 findings over 219 PRs):
  - categories: correctness 1,685, maintainability 731, reliability 691, documentation 518, testing 373, security 308, api-architecture 127, performance 123, accessibility 64, other 12;
  - severity: high, medium or low;
  - a `scope` axis: introduced-by-pr 4,014, pre-existing 557, exacerbated-by-pr 59, unrelated 2.

**Implication for VS-28.** Do not model VS-28's classes on a Greptile risk taxonomy read from an extract; Greptile's emitted taxonomy is not risk-based. A defensible design is:

1. VectorScope's five blocking classes, plus the four lenses (concurrency, resource, access, data-integrity).
2. A documented mapping onto both benchmark taxonomies, so that results are comparable:
   - concurrency maps to Martian `concurrency` and ReviewBench `reliability`;
   - access maps to `security`;
   - data-integrity maps to Martian `data` and ReviewBench `correctness`;
   - resource maps to `perf`/`reliability`.
3. A "what we checked" list (cleared risks) on clean or complete results. This fits VS-27's "No verified production-breaking issues" wording and makes an empty result auditable.

## 6. GP10 knowledge base and VS-26's card source

The KB page (`greptile.com/knowledge-base`) and its "risk areas" wording stayed unreachable. New primary facts:

**Shape (vendor tool descriptions in `greptileai/skills` plugin README, 2026-10/11):**

- `list_knowledge_bases`: "Repositories your organization has knowledge base data for".
- `list_knowledge_base_documents`: "Document paths in a repository's published knowledge base".
- `get_knowledge_base_document`: "Markdown body of a single knowledge base document".
- `search_knowledge_base`: "Substring search across one repository's knowledge base".

So the KB is a per-repository set of markdown documents with paths, searched by substring (not exposed as embeddings). Separately, "custom context" holds coding patterns and rules, with "linked comment references".

**Generation and refresh (code, akupara 202610.5, commits `cff67df` 2026-10-07 and `e1eba41` 2026-10-12):**

- Generation and routing:
  - `KNOWLEDGE_BASE_SYNTHESIS_ENABLED`;
  - `DEFAULT_KNOWLEDGE_BASE_ROUTING_POLICY='kb-gen-roll@5'`;
  - generation "requires access to `gpt-5.6-terra`".
- Refresh: "Refresh Knowledge Base documentation every day at 00:17 UTC" (`KNOWLEDGE_BASE_DOCS_CRON_EXPRESSION='17 0 * * *'`).
- Storage: a 100Gi ReadWriteMany artifact volume at `/var/lib/greptile/artifacts`.
- Review-history gate: `KNOWLEDGE_BASE_MIN_REVIEW_COUNT='0'` on self-host. **Inference:** hosted Greptile may gate KB synthesis on a minimum number of past reviews, which fits the vendor claim that the KB records "bugs that have been introduced in the past".
- `FILE_CHANGE_ACTIVITY_ENABLED` and `FILE_CHANGE_ACTIVITY_BUCKET` on the jobs service only. **Inference:** a file-change activity, or churn, artifact computed by a recurring job. This is the nearest code-level trace of "risk areas" and "predict future bugs".

**Partial answer to round one's §7 question (summarizer).** The current self-host architecture doc (`docs/reference/architecture.md` at 09b7db2) lists `chunker` ("fetches repositories, chunks and embeds code, and stores indexes and metadata") and no summarizer. KB synthesis is a separate job-driven, daily, model-specific pipeline. **Inference:** the old per-repo summaries were replaced by KB synthesis rather than kept inside indexing.

**Implication for VS-26 (cards).** Greptile's equivalent of VS-26's cards comes from a regenerated, human-readable, per-repo markdown corpus refreshed daily, plus a rules and patterns store. It is not built per PR. That supports VS-26's choice to draw cards from the existing Brain corpus seeded from the base commit, with a size cap. A daily refresh cadence and the separate "file change activity" job also suggest VectorScope's churn and fix-density features (VS-28) belong in a cached, base-commit artifact rather than being recomputed in CI with `fetch-depth: 1`.

## 7. GP20 auto-approve risk taxonomy: the shipped mechanism is instructions plus path filters

**Vendor text and code in akupara:**

- Release 202609.10: "Add configurable pull-request auto-approval, including path-based filters and approval-risk instructions"; "Enable pull-request auto-approval and approval-risk instructions by default in on-prem deployments".
- Commit `91705a2` (2026-09-22) adds `AUTO_APPROVE_ENABLED='true'` and `APPROVAL_RISK_ENABLED='true'`.
- 202610.5 (2026-10-12) then makes approval respect base-branch settings and withhold when settings cannot be loaded (§1).

So the shipped risk control is **customer-written approval-risk instructions plus path filters**, gated by feature flags. The fixed list round one quoted from the changelog extract ("auth, secrets, billing, migrations, infra, CI and public APIs are never auto-approved") was not found in any readable artifact. It may be a default instruction text or marketing copy. The conflict round one noted (changelog says "never"; docs say a Low ceiling can pass) cannot be settled from code.

**Implication.** `riskOf` should not be described as "reusing Greptile's auto-approve taxonomy". At most, Greptile is evidence that path filters plus explicit risk instructions are the control surface, and that they must come from base and fail closed. VectorScope does not auto-approve; the relevant lesson is only for `isSensitivePath` and the risk-band reasons.

## 8. GP16 and VOI17 Model Inversion: the signals are in the payload, the method is not

The blog (`/blog/model-inversion`) stayed unreachable, so the study's method (per-model counts, normalisation, judge, CIs, whether "~10%" is relative) is still unverified.

New, from code: the CLI review payload includes `headRef` (the branch name) and `commitMessages[] {sha, subject, body}` from `git log --format=%H%x1f%s%x1f%b` over base..head. The body carries trailers such as `Co-authored-by:`. These are exactly the signals round one's extract says Model Inversion uses (commit trails, branch prefixes, PR titles). That corroborates that the detection is *feasible* from the data Greptile receives, including for headless reviews. It says nothing about the uplift.

The skills repo commits themselves carry `Co-authored-by: Cursor <cursoragent@cursor.com>` trailers in akupara commit `91705a2`. That shows such trailers are common in vendor repos, and they are a cheap authorship signal.

**Implication for VS-29b.** Authorship detection from trailers and branch prefixes is cheap and needs no new data. The quality claim still needs VectorScope's own A/B under D12.

## 9. GU1, GU6 and GU15: no third-party run of shipped v5 or of any tier exists in any open dataset reachable

**Martian, offline (code).** HEAD is still `e616e84` (2026-08-30).

- Branches and open PRs up to 2026-11-03 add no Greptile run:
  - PR #71 (2026-11-03) adds Tenki;
  - PR #70 (2026-10-26) adds `mergejudge[bot]` to the online list;
  - PR #66 (2026-10-06, unmerged) adds 29 golden issues to the Cal.com PRs, which would change every tool's recall if merged.
- The last Greptile offline run is `greptile-v5`. Its repos are named `…__20260626`, but its comments are timestamped 2026-06-28T23:12Z to 2026-06-29, so it was run about five weeks before the public v5 launch (~2026-08-05).
- The bot's comments contain no version or tier marker. The summary has "Greptile Summary", "Confidence Score: n/5", `<!-- greptile_other_comments_section -->` and the "Reviews (1): Last reviewed commit … | Re-trigger Greptile" footer. Only the badge asset cache-buster changes: `p1.svg?v=7` in the April v4.1 run, `?v=9` in June v5.

**Martian, online (code).**

- The ETL tracks bots by GitHub username (`DEFAULT_CHATBOT_USERNAMES` includes `greptile-apps[bot]`). The leaderboard SQL has no version or tier column.
- A version filter exists only for Qodo, on the unmerged branch `online-overtime-analysis` (2026-04-27): it excludes Qodo PRs without the "Code Review by Qodo" marker, with the comment "so the leaderboard reflects only the current product".
- PRs over 50 commits or 2,000 changed lines are skipped (`MAX_PR_COMMITS`, `MAX_PR_CHANGED_LINES`).

So any October online figure for Greptile (GU6: #3 at F1 63.2, or 61.9/79.0) is a mixture of:

- whatever product versions ran in the date window;
- Base, Plus, Apex and Auto reviews;
- per-team tuned configurations.

Greptile comments carry no marker that would let Martian separate them. The board could not be queried this round, so the October numbers remain unverified (secondary only).

**ReviewBench (code).** The public repo `review-bench/ReviewBench` says it is "developed by GitHub", so it is **vendor-affiliated** (GitHub ships Copilot code review, a competitor).

- It starts on 2026-09-04.
- In 128 commits up to 2026-11-05, 28 agent manifests were onboarded or removed. **None is Greptile.** The first commercial one was "Copilot · Code Review" on 2026-09-21; most others are small or independent reviewers.
- Onboarding is vendor self-service (a container image plus model API URL, default 1,800 s per PR, maximum 3,600 s). The leaderboard shows "configurations: an agent plus its configuration labels" (for example `model`, `effort`), each scored by its newest final run (commit #109, 2026-11-04).
- A Greptile row would therefore need Greptile to submit or someone to wrap its API, and the repo shows neither.
- **There is no "June 2026 Greptile run" on ReviewBench.** The benchmark's public history begins in September. The June run in the gap list is almost certainly Martian's `greptile-v5` of 2026-06-26, mislabelled. The leaderboard site (review-bench.ai) was not reachable, so a privately submitted row cannot be fully excluded.

**Bake-offs.** These were not searchable this round (WebSearch budget exhausted). Round one's secondary items are unchanged and still unverified: aicodereviews.io, Cubic's October snapshot, Entelligence on Cal.com and the MorphLLM pages. Each should be labelled vendor-affiliated where the author sells a competing reviewer (Cubic, Entelligence, Kai).

**Conclusion for D12.** No primary Greptile docs page was opened, and no third-party run of shipped v5, Plus, Apex or Auto exists in any open dataset this session could reach. An "as good as or better than Greptile" claim cannot be supported today. The cheapest route to one, still subject to D8 and D12, is:

1. Run VectorScope through Martian's offline harness and compare against the published `greptile-v5` (pre-release) and `greptile-v4-1` artifacts, with run dates stated.
2. Or run ReviewBench's public 219-PR Harbor set for VectorScope. There is no Greptile row to compare against there.

## 10. ReviewBench data: how much "large-codebase" context the true findings need

From ReviewBench's golden findings (code, 2,623 TP findings; labels produced by an LLM classifier, Claude Sonnet 4.6, with reported 79.7% exact category agreement against humans, from `docs/METHODOLOGY.md`):

| Context needed (all TPs) | Share |
|---|---|
| Diff plus related files | 58.3% (1,529) |
| Diff only | 35.8% (940) |
| Broader project context | 5.9% (154) |

| Severity of TP | Count | Diff plus related files | Broader project context | Diff only |
|---|---|---|---|---|
| High | 181 | 78.5% | 7.7% | 13.8% |
| Medium | 891 | 68.4% | 6.6% | 25.0% |
| Low | 1,551 | 50.2% | 5.2% | 44.6% |

**Inference:** for the "like Greptile, good for large codebases" goal, most of the value is near-neighbour context (callers, callees, related files), not whole-repo knowledge. That favours VS-25's impact and neighbour retrieval as the first investment. KB or card context (VS-26) targets the 6–8% tail. The labels come from a vendor-affiliated benchmark's LLM classifier, so treat these as directional.

## 11. Other new, smaller facts

- **Config resolution model (code, CLI 3.8.0 `greptile config`):**
  - Sources are typed `file`, `org_enforced` ("from org rule (enforced)"), `org_default` ("from org rule") and `integration` ("from dashboard").
  - Rules carry `enforced`, `enabled`, `severity` and `scope[]`.
  - Config files are `.greptile/{config.json, rules.md, files.json}`, plus the legacy `greptile.json` and `.greptile.json` at the repo root. The scan skips `node_modules`, `.git`, `dist`, `build`, `.next`, `out` and `coverage`, and ignores symlinks.
  - Printed notes: "Filters apply repo-wide; the review does not cascade filters into subdirectories"; "a multi-file PR aggregates settings across the changed files"; "Unset settings fall back to Greptile defaults at review time."
  - The ordering between enforced org rules, files and org defaults is not printed. **Inference:** enforced beats file beats default.
- **Defaults (code, CLI settings schema):**
  - `strictness` is 1 to 3 with default `2` ("how aggressively Greptile posts review comments");
  - `triggerOnUpdates` defaults to false (3.4.2: "shows pull request update reviews as disabled when the setting is absent, matching Greptile's default");
  - `shouldUpdateDescription` and `fixWithAI` default to false.
  - So **reviews on PR updates are off by default**, which is a cost lever.
- **Pre-send secret holdback (code, CLI 3.1.0 and later).** This matters for ZDR and I-4. Before upload, the CLI holds back:
  - dotenv files (except `.example`, `.sample`, `.template`, `.dist` and `.defaults`);
  - key and credential files (`pem`, `key`, `p12`, `pfx`, `keystore`, `jks`, `ppk`, plus `.npmrc`, `.netrc`, `.pypirc`, `.pgpass`, `.htpasswd`, `credentials` and `id_*`);
  - diffs matching regexes for private keys and for AWS, GitHub, Slack, Google, Stripe, Anthropic and OpenAI keys;
  - files that are gitignored but committed.
  - Deletions of secrets and renames away from sensitive names are also held back. `--include` overrides it.
- **TREX environment controls (code, CLI 3.7.0 and later).** `network-policy` takes the scope `build` or `review` and the mode `full`, `trusted`, `custom` (with `--domain` entries) or `none`. Environment variables are "secret by default and secrets reach only the setup script". These are relevant to VS-30's repro sandbox design.
- **Goodhart risk in Greptile's own loop (code, vendor-authored `greploop` skill v1.3).** "If informational or a false positive, note it but still resolve the thread". The loop stops at "5/5 AND zero unresolved comments". Thread resolution and 5/5 confidence are thus signals Greptile's own agent loop drives directly. VectorScope's addressed-rate metric should count code changes linked to findings, not resolved threads.
- **CLI release history (code, npm metadata):**
  - 1.x from 2024-02-23 (early CLI);
  - 2.x until 2026-02-24 (the "Greptile Fix" macOS bridge package);
  - 3.0.0 on 2026-05-22 (the review CLI);
  - 3.6.0 on 2026-09-25 (tiers);
  - 3.8.0 on 2026-10-26 (TREX flows; "(beta)" label removed).
  - The release-notes "page 3" asked about corresponds to the 2.x and 1.x line. That line has no review-tier content; the 3.x changelog in the tarball is complete from 3.1.0.

## 12. What stays unverified (record for round three)

1. Exact wording of `/docs/code-review/review-tiers` (Auto's inputs, and precedence of rule vs Auto vs label), `/auto-approve-prs`, `/greptile-config-reference`, `/troubleshooting/common-issues`, `/knowledge-base`, `/blog/model-inversion` and `/blog/automating-code-validation`. All are blocked. To read them, allow `www.greptile.com` (and `web.archive.org`) in the session's network settings.
2. Whether hosted PR reviews read ordinary `.greptile` config from base or head.
3. A Greptile Security Agent as a distinct component.
4. October Martian online figures, and any post-August Greptile reviews. To check them, allow `codereview.withmartian.com`.
5. Whether review-bench.ai shows any privately submitted Greptile row.
6. Any 2026 bake-off with stated run dates. This needs WebSearch budget in a fresh turn.
