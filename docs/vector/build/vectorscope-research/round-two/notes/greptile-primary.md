# Round two, Greptile primary sources: deep notes for VectorScope

Compiled 2026-11-06. Angle: everything Greptile itself has published or shipped, with emphasis on what round one could not open. Labels: **code** (read in source or shipped artefacts), **vendor** (Greptile's own claim, mostly through search-engine extracts of greptile.com), **community** (user repositories and reports), **independent** (a third party measured it), **mixed**. "Inference" marks my own reasoning.

## 0. Access and method

- greptile.com, docs.greptile.com, web.archive.org, r.jina.ai and wavect.io all failed to resolve or were refused by the egress proxy. So docs, blog and changelog text is still known only through **search-engine extracts**, as in round one. I stopped trying new third-party hosts after the refusals.
- **The big change from round one: github.com worked**, both through `git clone` and through WebFetch of github.com pages. The GitHub REST API was session-bound, so the org could not be listed. I found repositories by probing names. Public repos under `greptileai`: `akupara`, `skills`, `cli`, `greptile-vscode`, `examples`. Everything else I probed (docs, mcp, sdk, action, bridge and others) is private or absent.
- **New primary artefact: the shipped Greptile CLI.** `greptileai/skills` @`59e79ec` (2026-11-03) vendors `plugins/greptile/scripts/greptile.mjs`. Its README says this is byte-identical to npm `greptile` v3.8.0, which was published 2026-10-26 (https://registry.npmjs.org/greptile). It is a 10.7 MB bundled JavaScript file. I read its API client, payload builder, output schemas and settings schemas directly. This is **code** evidence of the wire protocol and the review output format.
- **akupara, re-read in depth**, @`09b7db2` (2026-11-04): the release notes for 202610.5, the CHANGELOG, `docs/configuration/review-variants.md`, `docs/operations/scaling.md`, `values.yaml`, `.env.example`, and the full git history of the environment variables (274 commits). Round one read the current files. I mined the history, which shows *when* things changed.
- **Real configuration files** from public repos, read via git: NVIDIA/Megatron-LM `greptile.json` (@f1b38a8, 2026-11-05), debpalash/VoiceStudio `greptile.json` (@c88bf70, 2026-11-06), hiloopai/piloop `.greptile/` (@71e1747, 2026-11-05), jdvivar/tanstack-router-scoped-trees `.greptile/` (@94d98db, 2026-10-28), guilhermegor/blueprintx `.greptile/` (@ccb71a1, 2026-11-05).
- **GitHub release notes** for `greptileai/cli` (https://github.com/greptileai/cli/releases, pages 1–3, fetched 2026-11-06).

---

## 1. The headless review protocol, read from the CLI (code)

Source: `greptile.mjs` v3.8.0 (https://github.com/greptileai/skills/blob/59e79ec/plugins/greptile/scripts/greptile.mjs).

### 1.1 What a local review sends

`greptile review` does the following:
1. Resolves the current branch, its remote and the base. Without `--branch` it tries the remote HEAD, then `main`, then `master`.
2. Computes `git merge-base base HEAD`.
3. Runs `git diff --no-ext-diff --no-textconv --no-color -U<n> merge-base...HEAD`. The default context is 3 lines, clamped to 0–100.
4. Splits the diff into per-file records.

The POST to `/v1/headless-review` carries:
- `remoteUrl`, with credentials stripped (v3.4.1);
- `headRef`, `baseRef`, `headSha`, `baseSha`;
- `files[]`, each with `{path, oldPath, status (added|deleted|renamed|modified), additions, deletions, patch}`;
- `totalPatchBytes`;
- `commitMessages[]`, each with `{sha, subject, body}`. Over 50 commits, only the first and last are sent. Subjects are truncated to 1,024 characters;
- `prefetchedConfigs[]`: changed Greptile config files read at HEAD, at most 50;
- optional `instructions`, 1–2,000 characters (CLI help text);
- optional `effort` (`plus` | `apex`);
- a `correlationId`.

The CLI enforces several hard limits before sending:
- The whole payload is capped at **3,000,000 bytes**. Over the cap, the CLI tells the user to split the commits.
- Uncommitted files are excluded, and the CLI warns how many there were.
- Binary files are excluded, also with a warning.
- An empty diff is an error.
- More than 50 changed config files is an error.

Inference: the server has the patches plus `baseSha` and `remoteUrl`, so it must get unchanged context from its own clone or index of the remote. Head commits that were never pushed exist on the server only as patches.

### 1.2 Client-side privacy holdback (code; CLI v3.1.0 release note 2026-06-11: "Sensitive files … are excluded from review payloads instead of being uploaded")

Before upload, the CLI holds back four kinds of file:
- Files matching `.gitignore` (checked with `git check-ignore --no-index`).
- Sensitive filenames: `.env`, `.envrc`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.htpasswd`, `credentials`, and `id_rsa`, `id_dsa`, `id_ecdsa` and `id_ed25519`.
- `.env.*` files, except those ending `example`, `sample`, `template`, `dist` or `defaults`.
- Key and credential extensions (`pem`, `key`, `p12`, `pfx`, `keystore`, `jks`, `ppk`), plus any patch whose content matches a regex for:
  - private-key headers;
  - AWS `AKIA`/`ASIA` keys;
  - GitHub `gh[pousr]_` tokens;
  - Slack `xox*` tokens;
  - Google `AIza` keys;
  - Stripe `sk_`/`rk_` keys;
  - `sk-ant-` keys;
  - OpenAI `sk-proj`/`sk-svcacct`/`sk-admin`/`sk-…` keys.

The rules for held-back files:
- A held-back file is named in a warning and can be sent only through an explicit `--include <paths>`.
- If every file is held back, the review refuses with "nothing was sent to Greptile".
- `.greptile` config gathering skips symlinks and these directories: `node_modules`, `.git`, `dist`, `build`, `.next`, `out`, `coverage`.

### 1.3 Run lifecycle (code)

- Statuses: `QUEUED`, `RUNNING`, `REVIEWING_FILES`, `GENERATING_SUMMARY`, then the terminal states `COMPLETED`, `FAILED` and `CANCELLED`.
- Polling runs every 2 s for the first 30 s, then every 5 s. A `503 hatchet_slow` is retried. The client gives up after **30 minutes**.
- Runs are saved locally in `~/.greptile/reviews.json`, so `--resume` and `review show` work.
- `greptile review status` exit codes: 0 completed, 1 none or error, 2 invalid input, 3 in progress, 4 failed, 5 cancelled.
- Headless reviews are stored on the account with `source: "headless"`, and the MCP tools read them back alongside PR reviews (plugin README).

### 1.4 The review output schema (code)

The response is validated with zod schemas in the bundle.

Each comment carries:
- `path`, `line`, `startLine`, `endLine` and `side` (old or new);
- `type`, one of `info | syntax | logic | style | advice | checks | summary | notes` (plus `old`/`new`);
- `severity`, one of `P0 | P1 | P2`. **When the field is missing it defaults to `P2`**;
- `securityIssue` (boolean, default false);
- `linkedRule`;
- `clarificationQuestion`;
- `commentCategory`, `REVIEW` or `TREX`;
- `beforeSnippet` and `afterSnippet`;
- `skills[]`, rendered as "via skill: …".

The CLI also post-processes comments:
- It removes "Fix in …" badges, the "Prompt To Fix With AI" details block and the "Rule/File/Context Used:" footers from the body.
- It extracts ```` ```suggestion ```` blocks.
- **TREX "verified" comments are merged into the review comment at the same path, side and line range.** They are attached as `verifiedEvidence` and `verifiedFromIds`. A TREX comment with no matching review comment stays as its own comment.

Each review carries:
- `summary` and `overallComment`;
- `confidence` (0–5);
- `confidenceReasoning`;
- `structuredConfidenceReasoning.safetyAssessment`;
- **`proofOfWork.cleared_risks[{name, description}]`**;
- `securitySummary`;
- `fileAnalyses[{path, summary}]`;
- `diagram{type, code}`, a Mermaid diagram.

The renderer (`m_`) shows "Confidence: N/5" and the safety assessment first. **Only when there are zero comments** does it then show a "What we checked" list of up to 7 cleared risks, followed by the summary and the user's instructions. This matches the CLI v3.5.4 release note (2026-09-21): summaries "lead with confidence and a safety assessment" and "reviews with no findings can show up to seven 'What we checked' items". The same release note says the CLI **removed the 500-file review limit**. The website changelog of 2026-09-16 records a matching summary redesign (vendor, via search):
- a confidence score with a short verdict at the top;
- out-of-diff issues moved into their own comment;
- removal of the Important Files Changed table, the T-Rex Logs section, the review footer and the Comments Outside Diff section;
- a single Fix All button.

### 1.5 Resolved configuration and org settings (code)

`POST /v1/config` returns the merged configuration Greptile will apply to a path:
- `settings` and `filters`;
- `rules[{id, rule, severity, enforced, enabled, scope[], source}]`;
- `rulesMarkdown[{content, source.path}]`;
- `instructions[{content, sourcePath}]`;
- `files[{path, description}]`;
- `sources`;
- `warnings`.

It is printed as "local .greptile files merged with dashboard settings and organization rules". Local config collection caps at 50 files and 3,000,000 bytes.

The schema defaults for org review settings are:
- `strictness` "2";
- **`triggerOnUpdates` false**, so new commits do not trigger a re-review;
- `shouldUpdateDescription` false;
- `fixWithAI` false;
- summary sections `summarySection`, `sequenceDiagramSection`, `issuesTableSection` and `confidenceScoreSection`, each with `included`, `collapsible` and `defaultOpen`;
- `commentsOutsideDiffSection`;
- per-agent fix buttons for Cursor, Claude Code, Codex and Conductor.

CLI v3.4.2 (2026-08-26) "shows pull request update reviews as disabled when the setting is absent, matching Greptile's default".

---

## 2. Configuration and scopes (code from real files + vendor extracts)

**Keys seen in real `greptile.json` files** (Megatron-LM, VoiceStudio):
- `instructions` and `comment`;
- `commentTypes`, a subset of logic, syntax and style;
- `strictness` 1–3;
- `ignorePatterns`, a newline-separated gitignore syntax;
- `ignoreKeywords`, `labels` and `disabledLabels`;
- `includeAuthors`, `excludeAuthors` and `includeBranches`;
- `patternRepositories`;
- `statusCheck` and `statusCommentsEnabled`;
- `skipReview: "AUTOMATIC"`;
- `customContext.files[]` and `customContext.rules[]`;
- `triggerOnUpdates` and `triggerOnDrafts`;
- `fixWithAI` and `shouldUpdateDescription`;
- the four summary-section objects.

Both repos use `strictness: 3` with "only comment if … critical" instructions, which is consistent with the docs: 1 is the most verbose and 3 the strictest. The CLI's wording ("how aggressively Greptile posts … 3 high") is ambiguous about this.

**`.greptile/` folder** (piloop, tanstack-router-scoped-trees, blueprintx; vendor docs via search, https://www.greptile.com/docs/code-review/greptile-config and `…/greptile-config-reference`):
- **`config.json`** holds settings plus structured rules: `{id, rule, scope: [globs relative to the .greptile dir], severity: low|medium|high}`. It also takes `autoReview: ["open","push","rebase"]`, where the default is `["open"]` and `[]` means never; `statusCheck`; and `disabledRules` (by id) to switch off an inherited rule.
- **`rules.md`** is free-form markdown that applies to the whole subtree.
- **`files.json`** is `{files: [{path, description, scope?}]}`. Files without a scope are read on every review in that subtree. Scoped files are read only when the reviewed file matches one of the globs.
- **Cascade:** for each reviewed file, Greptile walks from the repository root down to that file's directory and merges every `.greptile/` folder it finds. Child settings override parent settings, while rules and context are unioned. If both `.greptile/` and `greptile.json` exist, `.greptile/` wins.
- Community pitfall: one PR found that all three files listed in `files.json` were missing at head, so Greptile could not read them (search extract).

**Which branch the config comes from.**
- Greptile's troubleshooting docs say it "reads greptile.json from the source branch of the PR, so a config added in a PR only applies to that PR" (vendor, search extract). Community PRs say the same. The CLI likewise sends changed config files *from HEAD* (`prefetchedConfigs`).
- The exception is auto-approval. akupara 202610.5 (2026-10-12) fixed it to "respect automatic-approval settings configured on the base branch and safely withhold approval when those settings cannot be loaded" (code: release notes).
- So round one's line "config is read from the base branch, so a PR cannot loosen it for itself" holds **only for auto-approval**. **Review config such as ignorePatterns or instructions appears to be controlled by the PR head.**
- VectorScope already takes settings from the base, and requires `VECTOR_PURE` / `VECTOR_DISABLE_PROJECT_CONFIG` in CI. On this point it is stricter than Greptile, and should stay that way.

**Review tiers: precedence** (vendor, https://www.greptile.com/docs/code-review/review-tiers, search extract):
- Greptile uses the **highest** of five sources: the dashboard setting, the repo config, any directory config the PR touches, a matching tier rule, and a request in the trigger comment.
- Auto counts as no tier, so any explicit tier beats it. The one exception is a matching tier rule set to Auto, which lets Greptile choose for that PR.
- TREX "is not compatible with Plus, Apex, or Auto at this time".

The CLI bundle's shared rule grammar (code) has:
- fields `repository`, `targetBranch`, `sourceBranch`, `author`, `label`, `keyword`, `title`, `path`, `draft`, `filesChanged`, `linesChanged` and `reviewRun` (`initial` | `subsequent`);
- operators `is`, `is_not`, `contains`, `not_contains`, `at_most` and `more_than`.

Inference: this is the grammar behind tier and trigger rules.

The precedence has one consequence worth noting: anyone who can comment on a PR can raise its tier, and so its cost. VectorScope's I-2 forbids exactly this.

---

## 3. Indexing, summaries and embeddings: what the history shows (code)

Source: akupara git history, @`09b7db2`.

- **The summarizer is gone.**
  - `662b412` (2026-06-29): "Scale summarizer replicas to zero … kept for future compatibility since it's still referenced".
  - `8574fa3` (2026-07-26): the summarizer service and image were removed.
  - Earlier self-host configs, removed in `a40dc71` on 2026-06-22, named the 2025 model roles: `AGENT_MODEL` and `CHAT_MODEL` (Sonnet 4), `REFINER_MODEL` (Claude 3.7 Sonnet), `SUMMARIZER_MODEL` (Claude 3.5 Sonnet) and `EMBEDDINGS_MODEL` (`text-embedding-ada-002`).
  - This partly answers round one's open question: since mid-2026 self-host runs no separate per-node summarization stage.
  - Inference: the 2026 knowledge base (module-level synthesized docs) took over the "natural-language layer", and per-node docstrings were dropped.
- **Embeddings remain.**
  - The `chunker` "fetches repositories, chunks and embeds code, and stores indexes" (architecture.md), in pgvector database `vector`, table `embeddings`.
  - LiteLLM alias `memory-embeddings` → `text-embedding-3-small` embeds team memory.
  - Sizing: the chunker is 1 CPU / 2 GiB, while each **worker** (2 CPU / 4 GiB) handles "up to **two concurrent reviews**", "clones repositories, runs the review sandbox, posts comments" (scaling.md, architecture.md).
  - Inference: the review is agentic reading of a fresh clone, with the index as an aid, not a precomputed graph-heavy pipeline.
- **No published size limits** (vendor via search):
  - no repo-size or file-count cap is documented; a co-founder said in ~2024 on HN that paid plans have no repo-size restriction;
  - first indexing "can take a couple of hours" (developer-essentials);
  - reviews take ~1–2 min (small), ~3 min (medium) and 3–5 min (large) (developer-essentials);
  - for large PRs the tips page recommends scoping the request ("review only the API changes"), and the prompt guide says "@greptileai check for memory leaks gets better results than just @greptileai review".
- **Multi-repo** (vendor via search):
  - Repo Clusters hold up to 20 GB, with up to 7 related repos read per review (read-only, same SCM host and credentials).
  - **Greptile suggests clusters from repositories the same people committed to over the last 90 days.**
  - `patternRepositories` names repos whose patterns count as house style.
- **Incremental re-indexing** remains undocumented. MCP `get_merge_request` exposes `hasNewCommitsSinceReview` and `reviewAnalysis.reviewCompleteness` ("2/5 Greptile comments addressed") (vendor via search).

---

## 4. Knowledge base: the closest thing to "predicting future bugs"

**Self-host code.** akupara 202610.5, released 2026-10-12 (https://github.com/greptileai/akupara/blob/09b7db2/RELEASE_NOTES_202610.5.md), with commits `cff67df` (2026-10-07) and `e1eba41` (2026-10-12). The KB needs:
- a shared persistent artifact store (`/var/lib/greptile/artifacts`, a 100 GiB ReadWriteMany PVC);
- `KNOWLEDGE_BASE_SYNTHESIS_ENABLED` and `KNOWLEDGE_BASE_SYNTHESIS_DEFAULT_ENABLED` (on for every repo);
- `KNOWLEDGE_BASE_MIN_REVIEW_COUNT='0'`;
- `DEFAULT_KNOWLEDGE_BASE_ROUTING_POLICY='kb-gen-roll@5'`;
- model access to `gpt-5.6-terra`;
- **`KNOWLEDGE_BASE_DOCS_CRON_EXPRESSION='17 0 * * *'`**, a daily refresh at 00:17 UTC that is configurable;
- on the jobs service only, **`FILE_CHANGE_ACTIVITY_ENABLED='true'`**, writing to the same artifact store.

Interpretation:
- Vendor pages say the KB updates "in real time as the codebase changes" (https://www.greptile.com/knowledge-base, search extract). The shipped self-host default refreshes the documentation **once a day, as a batch job**.
- That the jobs service tracks file-change activity is **code**. Using that activity as a churn signal for risk areas is **inference**: nothing public describes it.

**Structure** (vendor, changelog via search):
- an index with an architecture overview, a glossary and a file map;
- a per-area doc for each significant module or end-to-end flow, covering its purpose, connections, **risk areas** and key files;
- a section on **past revert, rollback and incident PRs**.

Further vendor statements:
- When a new PR appears to fix a previously merged bug, that location becomes a risk area that later PRs are checked against (blog "Automating Code Validation", 2026-06/07).
- The KB is read on every review and can be edited.
- Coding agents read it over MCP through `list_knowledge_bases`, `list_knowledge_base_documents`, `get_knowledge_base_document` and `search_knowledge_base`. Search is substring matching (plugin README, code).
- Greptile frames validation as three questions: does the change break the user contract, **does it make future violations more likely**, and does it match the author's intent (vendor, search extract).

**What "future bug prediction" means at Greptile, as far as public evidence goes:**
1. incident and revert history mapped to areas;
2. "risk areas" recorded when a fix lands;
3. preventative security (round one);
4. probably file-change activity (inference).

There is still **no per-file forecast or score** published. This confirms round one's conclusion, and adds the concrete inputs Greptile uses.

---

## 5. Review pipeline evolution from akupara's history (code)

- **Experiment variants, then a router keyed on review number.**
  - Before 2026-06-29, `DEFAULT_EXPERIMENT_VARIANT='opus-v8'`.
  - `052ea78` (2026-06-29) changed it to `'rsv11-stndrd4'`, with **`DEFAULT_DYNAMIC_ROUTER='router:reviewNumber:rsv11-stndrd4:rsv16-stndrd4-regated'`**. The first review of a PR uses one variant; later reviews use a separate "regated" variant.
  - When the dynamic router was replaced by `REVIEW_WORKFLOW_ROUTING_ENABLED` / `DEFAULT_NATIVE_ROUTING_POLICY` (`f593b73`, 2026-09-28), the upgrade notes warned that without the new settings "the quality of subsequent reviews might degrade".
- **The post-review gate fails open.** `post-review-gate` (`gpt-5.4-nano`) runs "only on a later review that already has Greptile comments … a missing route fails open and the review still posts" (review-variants.md). Round one noted the gate but not its fail-open semantics.
- **Default model vendor switched to OpenAI.**
  - Self-host default policy: `native-rsv11-stndrd4-expansion@3` (Anthropic, Sonnet 4.6) on 2026-09-28; then `v5.2-tiers@2` on 2026-10-02; then **`greptile-v5.3@6`** on 2026-10-07, shipped in 202610.5.
  - The release notes say the new policies are "a stronger collection of review variants based on the latest OpenAI GPT models, superseding the Anthropic-based review variants".
  - `greptile-v5.3@6` needs `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna` and an alias **`dsv4-flash-leased-nothink`**, which self-host maps to `gpt-5.6-luna` at low reasoning. Inference: the alias name suggests a leased DeepSeek-V4-Flash-class open model in the cloud product, consistent with Together AI's statement that v5 mixes open and frontier models.
  - Policies are versioned `name@version`, seeded by a database migration and chosen with an internal eval system. A namespace `routing.review` binding overrides the fleet default.
- **Pre-v5 traces.** `SWARM_URL` existed in 2025 self-host configs and was removed 2026-06-22, which suggests a swarm service existed well before the v5 launch (inference, weak). `NEW_WORKER_LOAD` was dropped 2026-07-09.
- **Feature flags** (2026-06-29 to 2026-07-09):
  - TREX settings off on self-host;
  - repo clusters on;
  - headless review on;
  - auto-approve and approval-risk on (`91705a2`, 2026-09-22);
  - `effort-levels` turns on Plus and Apex; turning it off "limits inference cost" (round one).
- **Procedural memory knobs** (`8688cd1`, 2025-08-28): `LEARN_PROCEDURAL_MEMORY`, `USE_PROCEDURAL_MEMORY`, **`MEMORY_EVIDENCE_THRESHOLD=1`** and **`MEMORY_LEARNING_CONFIDENCE_THRESHOLD=0.15`**. They were later folded into defaults. Current aliases add `memory-clustering` (Sonnet 4.6) and `rule-optimization` (nano).
  - Vendor, via search: suggested rules appear after about 10 PRs; approving them is limited to admins; rules can be "generated and refined with AI" (changelog, Nov 2025); custom-context entries can be created INACTIVE and are either an instruction or a pattern (MCP submission test cases, code).
  - Inference: one piece of evidence is enough to learn a memory, which is more permissive than VectorScope's rule of at least two dismissed patterns.

---

## 6. Metrics Greptile uses, and a definitional trap

- **Two different "addressed" signals.**
  - MCP docs: Greptile "automatically marks comments as addressed when the file is modified": a later commit that touches the comment's file counts (https://www.greptile.com/docs/mcp-v2/auto-fix, vendor via search). That is a **file-level heuristic**: an unrelated edit to the same file marks the comment addressed.
  - Headline version metrics (v4: 30%→43%; v5: 52%→66%) are "judged by an LLM". akupara routes `addressed-judge` (`gpt-5.6-luna`) and `acknowledged-judge` (`gpt-6-luna`) (code).
  - Neither definition is comparable to VectorScope's causal matching with human settlement. The file-touch flag in particular would inflate any "addressed" rate.
- **Revert rate.** OpenAI's customer story (https://openai.com/index/greptile-code-review-codex-astra/, ~2026, vendor partner) says Greptile measures impact by "tracking how often AI-generated code gets reverted". It also says GPT-6 Astra's computer use drives TREX's UI testing.
- **Replaying incidents.** A write-up of the 2026 "How to build an AI code review agent" talk says Greptile's method replays historical incident-linked PRs before changing prompts, targets recurring bug classes, and suppresses low-value comments (https://www.ai-redteam.com/insights/how-to-build-an-ai-code-review-agent-daksh-gupta-greptile/, secondary summary of a vendor talk).
- **Model Inversion method** (vendor, https://www.greptile.com/blog/model-inversion, ~2026-07-22, search extract):
  - two sets of 500 PRs, one authored by Anthropic's coding agent and one by OpenAI's;
  - authorship inferred from commit trailers, PR-title prefixes and branch prefixes;
  - **each tool run 3 times per PR**;
  - recall scored by an LLM judge against ground truth, **on high-severity bugs only**;
  - Claude-authored PRs have a higher share of "wrong data or missing behavior" bugs.

  This is more method than round one had. There is still no per-model table and no confidence interval.
- **Founder talk statistics** (vendor via a secondary summary, AI Engineer World's Fair 2026; https://finance.biggo.com/news/e0c502d3f5b75332): about a quarter of reviewed PRs are largely AI-generated, and almost one fifth are merged with no human review.

---

## 7. TREX environments, simulations and flows (code + vendor)

Sources: the CLI bundle; CLI v3.7.0 (2026-10-17) and v3.8.0 (2026-10-26) release notes; docs `trex/environments` and `trex/custom-flows` via search.

- **Environment, per repository.** It has:
  - a setup script;
  - review instructions of up to 32,000 characters (raised from 8,000 in v3.5.3);
  - variables, which are **secret by default, cannot be read back, and are available only to the setup script, not during TREX tests**;
  - builds, with logs and an invalidate action.

  Changes need repository-admin access.
- **Network policies.** There are two internet-access policies, one for build and one for review. An **unset policy defaults to full access**, and "custom always allows registry.npmjs.org". Build-policy changes apply at the next build; review-policy changes apply at the next TREX run.
- **Blockers.** TREX lists environment blockers it hit while testing PRs, such as missing dependencies, services, configuration or fixtures. Each blocker records `remediationAttempted` and `remediationStatus` (SUCCEEDED | FAILED | UNVERIFIED), `freshness` (current | outdated), `instanceCount` and linked PRs. A blocker is resolved or skipped with a written reason. The dashboard also offers "Repair with agent".
- **Simulations.** TREX can be run against **up to 5 existing PRs on an isolated copy of the active build, without posting to them**. Each environment configuration allows 5 simulations, and changing the build resets the count. The results report `flowsTested`, `bugsFound`, `blockedFlows`, `noTestableFlowsReason`, and each flow's outcome (pass | failed | blocked) with an evidence URL.
- **Custom flows.** A flow has a `title`, `description`, `goal`, `setup`, and `steps[{action, checks[{invariant}]}]`. Its trigger is `always`, or up to 20 rules over path, label, branches, author, title, keyword and draft. TREX "runs as written". A flow it cannot start shows up under incomplete custom flows. Each flow keeps its latest recording plus up to 50 earlier runs.
- **Infrastructure** (vendor via search, "Building TREX", 2026-06-17): reusable base images and per-repository snapshots; the reviewer orchestrates; sub-agents share its context.
- TREX costs 3 credits (docs). It is disabled on self-host.

---

## 8. Security and auto-approve: additions to round one

- **Security Agent**, changelog 2026-07-28 (vendor via search). It pairs "static scanning with an AI security agent", combining deterministic rules, dependency checks and context-aware AI review. It is **enabled for all users**.
- **Auto-approve** (vendor; round one covered the risk cap). Additions:
  - it requires the Confidence Score section to be on and reads the 5/5 score from it;
  - drafts, closed PRs and PRs merged before the review finishes are always blocked;
  - the risk taxonomy is:
    - Low: docs, tests, styling, small changes;
    - Medium: ordinary logic;
    - High: dependencies, build and runtime config, core shared modules;
    - Critical: auth, secrets, billing, migrations, infra and CI, public APIs;
  - path-based filters and "approval-risk instructions" (akupara 202609.10, code);
  - base-branch settings, with approval withheld when those settings cannot be loaded (code, 202610.5).

---

## 9. What VectorScope can take from this

1. **Make an empty review honest and informative (VS-27, I-7).** Add a `checked[]` list (at most 7 items) to StrictResult that is shown *only when there are no findings*, plus a one-line safety assessment ahead of the summary. Greptile's `proofOfWork.cleared_risks` is exactly this. Keep VectorScope's stronger rule: show it only when the review is `complete`. An unfinished review must still read "Not reviewed".
2. **Copy the output fields that cost nothing:** `linkedRule`, `clarificationQuestion`, `securityIssue`, before and after snippets, and per-file one-line analyses. Greptile defaults a missing severity to the lowest level (P2). VectorScope's guardrail should go further and **drop** a finding with unparseable severity under `precise`.
3. **Hold back secrets before dispatch, not only before posting (VS-23, I-4).** Greptile's client-side holdback (sensitive names, `.env.*`, key extensions, secret-pattern regexes, gitignored files, `--include` to override) is a cheap pre-dispatch filter for the model payload. Under ZDR it is defence in depth. Held-back files must be listed as not reviewed.
4. **Payload hygiene for tokenomics (VS-24).**
   - a hard payload cap, measured in bytes, before dispatch;
   - when there are many commits, send only the first and last messages;
   - truncate commit subjects;
   - explicit warnings for excluded uncommitted and binary files;
   - context lines defaulting to 3.

   All of these are deterministic and cost zero tokens.
5. **Re-reviews are a different job (VectorScope `incremental` defaults to true).** Greptile keeps re-review on push off by default. When re-review is on, it routes later reviews to a separate "regated" variant with a nano-class gate against re-posting. VectorScope should:
   - give incremental reviews their own prompt variant and evidence-scope entry (I-12);
   - consider a cheap duplicate gate for later reviews;
   - choose the gate's failure mode deliberately: Greptile fails open (posts anyway).
6. **Keep base-only config (I-2).** Greptile lets the PR head control `greptile.json` (ignore patterns, instructions), and anyone who can comment can raise the tier. VectorScope should not copy either. Do copy the *structure* of `.greptile/files.json`: context files with a description and a path-glob scope, read only when a changed file matches. This is the natural trusted source for **VS-26 Brain cards**, from base config, with at most three cards.
7. **Directory-scoped depth as a deterministic input to VS-28.** "The highest tier of any directory config the PR touches" is an explainable, cheap risk feature. Greptile's auto-approve taxonomy (High: dependencies, build/runtime config, core shared modules; Critical: auth, secrets, billing, migrations, infra/CI, public APIs) is a ready-made list of risk categories for `riskOf`, alongside `isSensitivePath`.
8. **Bug "prediction" by history, not forecast (VS-28, VS-26).** Greptile's inputs are past reverts, rollbacks and incidents mapped to areas, plus "a fix landed here" risk notes, plus (probably) file-change activity. VectorScope's fix-density feature (`fix|bug|revert|hotfix` over 90 days) is the same idea. Add **revert-linked paths** explicitly, and record when history was unavailable in CI. Never post a forecast.
9. **Refresh the knowledge layer on a schedule, not per PR.** Greptile's self-host KB refreshes daily by cron. A base-branch Brain or card artifact, rebuilt nightly or on base pushes and keyed by base SHA, matches what Greptile actually ships. It also avoids per-PR synthesis cost.
10. **Metrics (VS-21, VS-22).**
    - Never adopt "addressed = a later commit touched the file".
    - Add a post-merge **revert-within-N-days** outcome metric.
    - Build part of the defect set from revert- and incident-linked PRs, subject to the D8 licence rule.
    - Run each case **multiple times**, as Greptile ran 3 per PR, and report **high-severity recall** separately. This is the metric the Model Inversion claim rests on, and VS-29 should measure the same thing.
11. **Before enabling runtime evidence (VS-30), run it on past PRs.** Greptile's "simulate on up to 5 past PRs, post nothing" pattern, and its blocker taxonomy (missing deps, services, config, fixtures; remediation status), map onto VectorScope's "checks did not run, with a reason" (I-6). Greptile's network default is *full access* and its secrets reach the build. VectorScope's network-off, no-secrets rule is stricter and should stay.
12. **Version routing policies (I-12).** Greptile names policies `name@version`, seeds them by migration, chooses them by eval, and lets a namespace override them. VectorScope's evidence digests should carry a similar policy ID per variant: for example first review, incremental review and verifier. Greptile also switched its default vendor within a month, so no family should be hard-coded.

## 10. Still unverified after round two

- The full text of docs, blog and changelog pages (search extracts only).
- How v5 generates and deduplicates hypotheses.
- Exactly how Auto picks a tier.
- Whether Greptile's knowledge base uses file-change activity as a risk signal.
- What `dsv4-flash-leased-nothink` maps to in the cloud.
- The Model Inversion table.
- Whether a push re-review analyses only new commits.
- Whether the headless review's context comes from an index of the default branch.
- The re-index trigger and how fast the code index catches up with a push. Only the knowledge base has a published schedule (daily cron).
