# VectorScope research, round two

Files: this report is `docs/vector/build/vectorscope-research/round-two/REPORT.md`. Its lane notes are in `round-two/notes/`, and its addendum is `docs/vector/build/vectorscope-upgrade-addendum-a.md`.

Prepared 2026-11-06, revised the same day after review. This round extends round one (`docs/vector/build/vectorscope-research/REPORT.md` and its eight notes) and does not repeat it. Its companion is "VectorScope upgrade contract, addendum A (round two)", which turns these results into packages VS-32 to VS-49.

## How to read this

- **What this is.** A synthesis of nine round-two research lanes and six gap lanes, for the owner and engineers. Bracketed IDs such as [GP1] name the underlying finding:
  - GP: Greptile primary sources (shipped CLI, self-host repository, real configs);
  - GU: Greptile users and independent data;
  - LCI: large-codebase context in industry;
  - RR: repository retrieval research;
  - RP: risk prediction;
  - FL: feedback learning;
  - VOI: round one's open items;
  - CF: competitor features;
  - G1 to G6: six gap lanes (repository size, PR-level risk, tokenomics, ZDR terms, Greptile data handling, Greptile primary sources and third-party runs);
  - VT: VectorScope today, read in this repository during revision (worktree 0f772e6e), with HEAD at 7cadfcb8 ("feat(review): VS-22a upgrade dataset labels"). Between 765ef4ec and 7cadfcb8, no file cited for VT1 to VT3 changed. In that range only the eval files changed under `packages/core/src/review` (`eval.ts`, `eval-judge.ts`, `eval-report.ts`). Of the cited files, only `packages/core/src/review/eval.ts` and `script/vectorscope-eval/judging-rubric.md` differ (line 39 of the rubric is unchanged), and `RUBRIC_VERSION` is still 1 at `eval.ts:138`. Line numbers below are at 7cadfcb8.
- **Summary tags.** Each summary item says whether it is **new**, **extends**, **corrects** or **confirms** round one.
- **Verification.** Findings from the nine main lanes went through a second verification pass. Where it changed a claim, this report uses the corrected form. Items the verifier could not check are marked "unverifiable". **Findings from the gap lanes (G1 to G6) ran in a single pass with no separate verification, and are marked (single-pass).** A later review spot-checked a sample of claims against source. What it changed is listed in §9 and §10. A final check on 2026-11-06 re-read the code and the lane data. It corrected the grep permission claim, how `rulesForPaths` merges rules, the VT1 exit paths, Greptile's cross-file figures and the AACR licence method, added missing Q10, Q26 and single-pass labels, and in the addendum moved the runner-touching parts of VS-35, VS-42, VS-43 and VS-48 to later windows.
- **Refuted.** One finding was refuted in verification: RP15, which claimed that "this change is itself a bug fix" was the strongest non-size risk predictor. Re-testing showed it to be an artefact of how ApacheJIT's labels are built (§5.1). It is not used anywhere below, and the owner question built on it (risk notes QR1) is withdrawn.
- **Access limits.**
  - www.greptile.com and docs.greptile.com did not resolve. web.archive.org was refused. arxiv.org and its mirrors, cursor.com, github.blog, openrouter.ai, developers.openai.com, docs.cloud.google.com, learn.microsoft.com, docs.github.com, news.ycombinator.com, together.ai and many other hosts were blocked.
  - The shared WebSearch budget ran out early in the turn, so most lanes ran no searches at all, and the review pass ran none.
  - What worked: `git clone` and `raw.githubusercontent.com` for public GitHub repositories, the npm and PyPI registries, Google's API discovery documents, platform.claude.com and code.claude.com.
  - As a result, **Greptile prose (docs, blog, changelog) is still known only from search extracts.** But this round read far more Greptile *code* than round one: the shipped CLI bundle (npm `greptile` 3.8.0, 2026-10-26), four earlier CLI builds, the `greptileai/skills` repository, the full git history of `greptileai/akupara`, and real customer `greptile.json` and `.greptile/` files.
- **Labels.** Every claim carries one:
  - *vendor*: a company about itself, including its docs, SDK type text and shipped README;
  - *independent*: a third party measured it, or we measured it from third-party data;
  - *academic*: a paper or preprint;
  - *code*: read in source, config or data;
  - *community*: user reports;
  - *mixed*: more than one of the above;
  - *inference*: our own reasoning, always flagged.
- **Our own measurements.** These are the ApacheJIT risk models, the PR-level band analysis, the grep and tree-sitter timings, the Martian and ReviewBench re-analyses and the AACR token arithmetic. They are internal diagnostics only. Under D12 they support design decisions, not public claims.
  - **Gathered before Q10 and Q26 were answered.** Several used inputs that are not D8-clean: Linux (GPL), Grafana (AGPL), Sentry (FSL), Discourse (GPL-2.0) and Martian's goldens. Q10 (the D8 licence question) is still open, and Q26 (latency timing on non-permissive repositories) was asked only after these runs. Do not reuse these numbers, or rerun their scripts on those inputs, until the owner answers both. The numbers from D8-clean inputs (ApacheJIT and the Apache repositories, Keycloak, Kubernetes, vscode, the AACR permissive subset) carry no such restriction. ReviewBench re-analyses use MIT-licensed labels plus diff statistics of corpus repositories whose licences are unchecked. Commit those scripts only after the VS-22 per-repository licence check.
  - **Not reproducible from the repository today.** The scripts live only in this session's scratchpad (`scripts/`, `g1/scripts/`, `g2/bin/` and `rpverify/` under the session's `/tmp` scratchpad), which does not persist. Until they are committed, treat every number labelled "our measurements", "in-house simulation" or "independent re-analysis" as not reproducible. I-13 keeps the results themselves uncommitted. The addendum (VS-21) says which scripts may be committed: those whose inputs are D8-clean now, the rest only once Q10 and Q26 allow. **If the scratchpad is lost before then, these numbers are permanently not reproducible, and must be labelled that way wherever they are used.**
- **Naming.** Open-source coding-agent CLIs and harnesses, IDE coding assistants included, are referred to generically, in prose and in source citations. Where a URL, path or run name would name one, this report cites the repository owner and commit and withholds the identifying path. The full links are in the round-two lane notes. Addendum Q34 asks the owner whether full URLs may be restored for traceability. Review agents (OCR, PR-Agent, Kodus), review services and code-search engines (Zoekt) are named: they are review or search products, not coding-agent CLIs or harnesses. "OCR" is Alibaba's open-source review agent.

---

## 1. Summary

1. **No third party has run shipped Greptile v5 or its tiers on any open dataset.** *(confirms GU1; corrects GU7's premise)*
   - Martian's public repository holds no Greptile run newer than its hidden `greptile-v5` pre-release, with reviews dated 2026-06-26 (code, partly single-pass) [GU1, G6-10].
   - The public dashboard labels the v4.1 run as "Greptile v4" (code) [GU1].
   - GitHub's ReviewBench starts on 2026-09-04 and has never onboarded Greptile, so a "June 2026 Greptile run" on ReviewBench cannot exist. That date is Martian's pre-release run (code, single-pass) [G1-2, G6-11].
   - Online figures cannot be tied to any Greptile version or tier, because its comments carry no version marker (code, single-pass) [G6-10].
   - Consequence: an "as good as Greptile" claim cannot be supported today (D12).
2. **Open data show no large-codebase or cross-file advantage for Greptile.** *(new; extends round one's pooled cross-file gap)*
   - On Martian's 34 cross-file PRs, Greptile v4.1's recall is 0.48 to 0.51 across three judges. Augment reaches 0.58 to 0.63, Qodo extended-v2 0.54 to 0.62 and Copilot-v2 0.60 to 0.66. A generic agent (Claude Code) is level with Greptile within the intervals (independent re-analysis; Martian's goldens are not D8-clean, so this re-analysis is gated on Q10) [GU4].
   - Across Martian's five large repositories (7.7k to 27.9k files), v4.1 is mid-pack on four. File count shows no consistent relation to its advantage (code, single-pass; Martian's goldens are not D8-clean, so this re-analysis is gated on Q10) [G1-6].
   - Martian's online board records no repository size, so its online figures say nothing about large codebases (code, single-pass) [G1-5].
3. **What Greptile actually ships for large codebases is time, fresh clones and parallel agents, not a precomputed graph.** *(new; partly answers round one §7)*
   - Self-host removed its separate summarizer: it was scaled to zero on 2026-06-29 and removed on 2026-07-26. Review workers clone the repository afresh, and the chunker still embeds code into pgvector (code) [GP11].
   - A nightly job synthesises the knowledge base from the base branch. It is not built per PR (code; self-host only; partly single-pass) [GP9, G6-7].
   - The CLI caps the local-review payload at 3,000,000 bytes. It removed its 500-file cap on 2026-09-21, four days before depth tiers launched (code, partly single-pass) [GP1, G6-5, G1-13].
4. **VS-25 as written lost about half the true dependents on 40 Kubernetes commits, and its latency gate fails at Linux scale.** *(new, single-pass)*
   - Capping `git grep` output at 200 files *before* the import gate lost import-gated dependents in 65% of 40 real Kubernetes commits (median 16 of 20 lost). Gating first cut the median candidate count from 1,430 to 20 (code, in-house simulation) [G1-10].
   - Tree-ish grep is about 2 to 4 times slower than working-tree grep (about 2.4 times on Kubernetes, about 4 times on Linux). Simulated Tier 1 p95 was 4.4 s on Kubernetes, but 5.9 s on Linux, a GPL input whose timings are gated on Q10 and Q26 [G1-7, G1-9].
   - In blobless or sparse clones, working-tree grep silently returns nothing [G1-11].
5. **"Predicting future bugs" reduces, at PR level, to a size-and-spread score. Only VectorScope's own merge outcomes can test anything more.** *(corrects VS-28's calibration; extends round one §3.3)*
   - VS-28's commit-calibrated cutpoints put 56% of PRs, and 86 to 96% of changed lines, in the high band on Martian and ReviewBench (independent, single-pass; the Martian figures are gated on Q10) [G2-1].
   - At PR level, the points score flags PRs with a severe bug no better than raw size: AUC 0.60 against 0.70 on ReviewBench (independent, single-pass) [G2-7].
   - History features add almost nothing at commit level (independent) [RP3, RP4].
   - Greptile's version of bug prediction maps revert and incident history to "risk areas". No measured effect is published (vendor, extract-only) [GP10, G2-12].
   - No public PR-level dataset has post-merge defect labels (code, single-pass) [G2-10].
6. **The ZDR route has more leaks than round one recorded.** *(corrects and extends round one §4.1)*
   - OpenRouter's published prose says Safety Retention may cover any request, flagged or not, and that self-serve accounts allow it unless changed (vendor) [G4-1].
   - OpenRouter server tools (`openrouter:*`) and Files are outside ZDR enforcement [G4-4].
   - Fusion's inner generations do not inherit request-level `provider` settings, `zdr: true` included. Account-level and guardrail ZDR do apply to them, because "inner generations run under your API key" (vendor; `server-tools.mdx`) [G4-4].
   - OpenRouter response caching can keep full responses for 1 to 86,400 seconds, up to 24 hours [G4-7]. It is off unless `X-OpenRouter-Cache: true` or a preset enables it. It is unavailable when account-level ZDR is enforced, but a per-request `zdr: true` does not block it (vendor; `response-caching.mdx`).
   - OpenRouter's ZDR route for a Claude model runs on Bedrock or Vertex, under the cloud provider's terms [G4-3].
   - OpenAI gpt-5.5 and later support only 24-hour cache retention [G3-8, G4-11].
   - An untouched Vertex project reports durable-storage implicit caching [G4-13].
   - Vector's own helper requests on Azure and Bedrock Mantle omit `store: false` (code) [G4-19].
   - All of the above are vendor or code, single-pass.
7. **Greptile's own systems retain customer-derived content by design.** *(new; corrects round one's self-host telemetry line)*
   - Greptile's hosted MCP manifest says reviews "persist results". It says comments from local CLI reviews, knowledge-base documents and "persistent" rules and patterns are stored server-side (code) [G5-1].
   - Self-host is gaining a daily usage export to usage.greptile.com, on by default when a licence is set (code) [G5-4].
   - **Not shown to retain, and kept apart from the above:** the self-host LLM proxy config declares batch-eligible model patterns (`claude-*`, `gpt-4o*`, `gpt-5*`, `chatgpt-*`; since 3904840, 2026-05-08). Whether any review or background job (for example KB generation or analytics) actually uses a batch API is not shown (code). If one does, Anthropic's Message Batches are not ZDR-eligible (29-day retention, platform.claude.com feature-eligibility table, accessed 2026-11-06). The same config sets `stream_timeout: 600` "for streaming responses" and aliases `review` to claude-sonnet-4-6. Both point to synchronous streaming for reviews (code) [G5-6].
   - VectorScope should therefore compare on structure (no vendor-side store on BYOK), not on provider-side ZDR. Greptile's provider-side ZDR remains unverified [G5-11].
   - All single-pass.
8. **Teams gate merges on Greptile's 5/5, and the gates fail open. VectorScope's own job also exits 0 on most unfinished paths.** *(new)*
   - synnax, gptme and code-graph-rag gate merges on 5/5 (code) [GU10].
   - Greptile's check succeeds at any score, and the score lives in text the author can edit (code) [GU10].
   - gptme treats "no review in 90 minutes" as 5/5 (code) [GU11].
   - Greptile's own `greploop` skill tells agents to resolve false-positive threads anyway and loop until 5/5 (code) [GU12, FL9].
   - VectorScope's GitHub job exits 0 on skips, on partial outcomes, on model or tool failures caught after the review starts, and on other failures before the review starts (GitHub reads other than 401, 403 and 404, or git). Exit 1 is limited to configuration errors (a model that cannot start, GitHub 401, 403 or 404, a checkout that does not match the expected head, and command-level setup failures) and to failOn "blocking" with open blocking findings. The job writes no machine-readable verdict (code) [VT1].
9. **VectorScope's existing team-dismissed loop is a poisoning path, and the field has moved away from reaction-based suppression.** *(new; corrects round one's "table stakes")*
   - A single dismissed pattern makes the trusted prompt suppress similar findings, in the security pass too, and nothing is logged (code) [FL2].
   - PR-author dismissals become repository-wide memory (code) [FL1].
   - Kodus built a Greptile-style embedding-and-reaction filter. Its docs described the filter as inactive by 2026-09-15 (7d8cd3d1a). The code was removed on 2026-10-23 (a5bac4029), when its stage ran in no pipeline (code) [FL3, CF17].
10. **The first external per-PR token table for agentic reviewers exists. It suggests the step cap is a major token lever (inference: the cap is confounded with the tool's design).** *(new; resolves RR4)*
    - On AACR-Bench, a tool-capped reviewer (OCR) processes 334K to 743K gross tokens per PR. Claude Code processes 2.06M to 5.66M (vendor, open harness; single-pass) [G3-1].
    - With the same model, the ratio is 5.4 to 14.7 times, mean 9.6 times (vendor data, our arithmetic; single-pass) [G3-2].
    - VectorScope's estimator has the right shape but is miscalibrated in three places (code, single-pass) [G3-15].
    - Cache hit rate in an agent loop is mechanical and can be computed before dispatch (inference, single-pass) [G3-6].
11. **A D8-clean external dataset exists at about ten times the size of Martian's clean subset.** *(answers round one §7)*
    - AACR-Bench's permissive subset is 144 PRs, 140 positive samples and 970 golden comments, with licences checked per repository, at HEAD and at the commit of each repository's first dataset PR. lvgl's licence was not confirmed at its PR commit, and a per-PR check is still to do (addendum VS-22) (code) [VOI13].
    - At most 13 of Martian's 50 PRs (40 of 173 goldens) satisfy D8 today: 10 Keycloak PRs, plus 3 Sentry PRs under the FSL reading in addendum Q31 (code) [VOI12].
    - About 74% of AACR's goldens are model-written, so cross-family comparisons on it are confounded (code) [VOI15].
12. **Greptile holds back secrets before upload. VectorScope sends raw diffs to the model.** *(new)*
    - Greptile's CLI withholds sensitive files and credential-matching patches before upload (code, partly single-pass) [GP2, G6-15].
    - VectorScope's redaction covers only posted text (`redact.ts:1-2`). `Review.run` builds every specialist prompt from the packed raw diff and head files with no redaction step (`run.ts:661-685`). The other untrusted prompt blocks (related `git grep` hits, history, human comments, PR text) are not redacted either. The read tool is denied `SECRET_FILES` and `*.env`/`*.env.*` (`permission.ts:11-22,67-72`), but that list misses `.envrc`, `.netrc`, `.pypirc`, `.pgpass`, `.htpasswd`, `credentials`, a root `id_rsa`, `*.pfx`, `*.jks` and `*.keystore`. grep has no path rule of its own, but it checks read permission for each file it searches (`grep.ts:94-109`), so it inherits the same deny list and the same gaps. Together these are a gap against I-4 (code) [VT2].

---

## 2. Greptile in more depth

### 2.1 Large codebases: what the code shows

- **The local (headless) review protocol** (code, CLI 3.8.0) [GP1, G6-5]:
  - It sends only committed, non-binary changes, as per-file patches against the merge base (3 context lines by default, 0 to 100 allowed).
  - It also sends refs and SHAs, the remote URL with credentials stripped, commit messages, changed Greptile config files read at HEAD (at most 50), up to 2,000 characters of instructions and the effort tier.
  - When there are more than 50 commit messages, only the first and last are kept. Subjects are cut to 1,024 characters.
  - The client refuses payloads over 3,000,000 bytes. It polls for up to 30 minutes through QUEUED, RUNNING, REVIEWING_FILES and GENERATING_SUMMARY.
  - Inference: the server builds unchanged context from its own clone of the remote.
- **The 500-file cap was removed on 2026-09-21** (CLI 3.5.4), four days before tiers launched (code, single-pass) [G6-5, G1-13]. Greptile replaced its large-PR cap with depth tiers.
- **Self-host architecture** (code, akupara history) [GP11, G1-14]:
  - The summarizer was scaled to zero on 2026-06-29 and removed on 2026-07-26.
  - 2025 configs had separate agent, chat, refiner (Claude 3.7 Sonnet), summarizer (Claude 3.5 Sonnet) and embedding (ada-002) roles.
  - Each review worker (2 CPU, 4 GiB) clones the repository, runs the sandbox and handles two reviews at once. The chunker (1 CPU, 2 GiB) still chunks and embeds code into pgvector.
  - No repository-size or file-count ceiling is published anywhere.
- **Knowledge base** (code, self-host only) [GP9, G6-7]:
  - It shipped in akupara 202610.5 (2026-10-12). It is a per-repository set of markdown documents, refreshed by a daily cron at 00:17 UTC (`17 0 * * *`). It is generated through routing policy `kb-gen-roll@5`, which needs `gpt-5.6-terra`.
  - It is stored on a 100 GiB shared volume and gated by `KNOWLEDGE_BASE_MIN_REVIEW_COUNT` (0 on self-host).
  - A jobs-only `FILE_CHANGE_ACTIVITY` task writes to the same path. Using it as a churn or risk signal is inference.
  - Coding agents read the KB over MCP with substring search (vendor plugin README).
  - The vendor's "in real time" wording is unverified. Only the docs refresh is shown to be a daily cron.
- **Vendor guidance, search extracts** [GP18]:
  - first indexing "can take a couple of hours";
  - reviews take about 1 to 2 minutes for small PRs, about 3 for medium and 3 to 5 for large;
  - for large PRs, scope the request;
  - Repo Clusters hold up to 20 GB and read up to 7 related repositories per review. Clusters are suggested from repositories the same people committed to in the last 90 days.
  - Greptile's own agent skills plan for a tail of about 10 minutes: a 600,000 ms Bash timeout, and 60 polls at 10 s (code, single-pass) [G6-6].
- **Pipeline evolution behind named variants** (code) [GP12, GP13, GP22]:
  - From 2026-06-29 to 2026-09-28, the self-host default used a router keyed on review number that sent later reviews to a separate "regated" variant. That reading is inferred from the router string.
  - A cheap post-review gate (gpt-5.4-nano) runs only on later reviews that already have comments, and it fails open. Current docs scope it to the Anthropic policy. The OpenAI policies that became default on 2026-10-12 do not call it.
  - On 2026-10-12 (16609f0, released in 202610.5 by 5b92f02), the self-host default moved from the Anthropic policy `rsv11` to the OpenAI policy `greptile-v5.3@6`. `rsv11` (`native-rsv11-stndrd4-expansion@3`) had been the default since f593b73 (2026-09-28). `v5.2-tiers@2` was added in the same commit as a fallback for deployments without `gpt-6.1-sol`. The docs say "`greptile-v5.3@6` is considered better" (code). The commit's title ("Default on-prem reviews to the v5.2 tiered policy") does not match its diff, which sets `greptile-v5.3@6`.
  - The OpenAI routing needs an alias `dsv4-flash-leased-nothink`. Reading that as a leased open model in Greptile's cloud is inference.
  - Policies are versioned `name@version` and chosen with an internal eval.
  - A `SWARM_URL` setting existed in 2025 configs. Inference (weak): the swarm predates the public v5 launch of 2026-08-05.

### 2.2 Noise: output schema, defaults and what users report

- **Output schema** (code, CLI 3.8.0 zod schemas) [GP3, G6-4]:
  - Per comment: path, line range, side; `type` (info, syntax, logic, style, advice, checks, summary, notes); severity P0, P1 or P2, **defaulting to P2 when missing**; `securityIssue`; `linkedRule`; `clarificationQuestion`; before and after snippets; `skills`; category REVIEW or TREX.
  - TREX "verified" comments are merged into the review comment at the same location as `verifiedEvidence`.
  - Per review: confidence 0 to 5, a safety assessment, `proofOfWork.cleared_risks`, `securitySummary`, per-file analyses and a Mermaid diagram.
  - Greptile's emitted taxonomy is coarse and sorts comments by kind. It contains no risk taxonomy.
- **"What we checked"** (code, renderer; vendor release notes 3.5.4) [GP4]:
  - When a review has zero comments, the CLI shows up to 7 cleared risks after "Confidence: N/5" and the safety assessment.
  - The claimed 2026-09-16 summary redesign (several sections removed, one Fix All button) is **unverified**. The 3.8.0 CLI still renders "Comments Outside Diff" in one layout.
- **Defaults** (code) [GP5, G6-14]:
  - re-review on push is off (`triggerOnUpdates` false; docs: `autoReview: ["open"]`);
  - strictness is 2 of 3;
  - description updates and fix-with-AI are off.
  - Config sources are typed: file, org enforced, org default, dashboard. Filters apply across the repository; settings, rules and instructions cascade per file.
- **Community reports.**
  - In the January 2026 Hacker News thread on Greptile's own essay, a user calls it "pure noise" after 3 PRs. Users say a 4/5 on every PR misled reviewers, and that it overwrote descriptions and "argued with itself". One team switched to Claude [GU13]. These quotes come from the lane's reading and could not be re-checked (news.ycombinator.com unreachable during spot-checks).
  - Praise is also anecdotal: "less noise" (X, 2026-11-02); "best code review agent" (X, 2026-03-06) [GU13].
  - Reliability complaints: re-triggers showing "completed" with no comment; no review object on re-review; raw Mermaid in the Checks panel; requests missed until re-posted. Greptile's own troubleshooting docs list Pending statuses that never update [GU17].

### 2.3 Learning

- **Self-host procedural memory** (code, 2025-08-28) [GP14, FL11]:
  - `MEMORY_EVIDENCE_THRESHOLD=1` and a confidence threshold of 0.15, so Greptile learns from a single piece of evidence.
  - Current routing names memory embeddings (text-embedding-3-small), clustering and learning (Sonnet 4.6), rule optimization and a comment classifier (nano), and separate `addressed-judge` and `acknowledged-judge` aliases.
  - Vendor docs (extract): rules are suggested after about 10 PRs and need admin approval. Custom-context entries can be created inactive.
  - Config does not show whether nearest-neighbour downvote blocking still runs. Round one's 19% to 55% addressed-rate figure stays vendor-only.
- **"Addressed"** (vendor plus code; partly unverifiable) [GP15]:
  - In the hosted MCP app manifest (greptileai/skills at 59e79ec, the Greptile plugin's ChatGPT app submission manifest), `list_merge_request_comments` "Retrieves saved comments and their addressed flags without posting or resolving comments". `get_merge_request` "Retrieves saved pull request details, review results, comments, and citations without updating them". `search_greptile_comments` covers "pull request and CLI reviews" (code, re-checked during revision).
  - The claim that the stored flag is set when a later commit merely touches the file could not be verified; the docs pages were unreachable.
  - Either way, Greptile's addressed percentages cannot be compared with VectorScope's causal matching with human settlement.

### 2.4 Depth, tiers, inversion and TREX

- **Tier precedence** (vendor, extract only) [GP8]: the effective tier is the highest of the dashboard setting, the repository config, any touched directory's config, a matching tier rule and a request in the trigger comment. Anyone who can comment can raise a PR's tier and cost. I-2 forbids that in VectorScope.
- **Client side** (code, single-pass) [G6-2, G6-3]:
  - `effort` is `base | plus | apex` only. Auto is a server-side mode.
  - An explicit tier that cannot run fails without fallback, and results carry the effective effort.
  - The bundled rule grammar has 12 deterministic PR-metadata fields (including `filesChanged`, `linesChanged` and `reviewRun: initial | subsequent`) and 6 typed operators, with at most 20 rules. It has **no risk or complexity field**. Risk is left to Auto, which the model judges.
- **Model Inversion** (vendor, extract only; method still unverified) [GP16, VOI17, G6-9]:
  - Reported method: 2×500 PRs; authorship inferred from trailers, title prefixes and branch prefixes; 3 runs per tool; recall judged by an LLM on high-severity bugs only.
  - The CLI payload already contains branch names and full commit bodies with trailers. So Greptile could detect authorship from data it already receives (code, single-pass).
  - No CLI setting controls model, family or inversion (code).
- **TREX** (code plus vendor) [GP17, G5-9]:
  - Per-repository environments: a setup script, instructions up to 32,000 characters, and variables that are secret by default and reach only the setup script.
  - Build and review have separate internet policies. An unset policy means **full access**.
  - Blockers carry a remediation status, and they can be resolved, skipped or repaired by an agent.
  - Simulations on up to 5 past PRs post nothing. Custom flows have invariant checks.
  - TREX is disabled on self-host. It runs on Greptile infrastructure with customer secrets.
- **Security Agent** (vendor, extract) [GP19]: turned on for all users 2026-07-28. It pairs static scanning, rules and dependency checks with an AI agent. No distinct agent, route or alias appears in the client, the skills or the self-host config. Security is a per-comment flag plus a summary (code, single-pass) [G6-4].
- **Auto-approve** (mixed) [GP20, G6-8]:
  - It reads the 5/5 from the summary and always blocks drafts.
  - The fixed category list (auth, secrets, billing, migrations, infra, CI, public APIs) is **extract-only**. The shipped mechanism is path filters plus approval-risk instructions written by the customer (code, akupara 202609.10).
  - The fix in release 202610.5 reads auto-approval settings from the base branch and withholds approval when they cannot be loaded (vendor release note in code) [GP7, G6-1].

### 2.5 Configuration and trust

- **Real configuration files** show the full surface (code) [GP6]:
  - `greptile.json`: instructions, comment types, strictness, ignore patterns and keywords, label, author and branch filters, status check, custom context, trigger flags.
  - `.greptile/`: structured rules with id, glob scope and severity; `rules.md`; `files.json`, a list of context files, each with a description and an optional glob scope, read only when a changed file matches.
  - Folder configs cascade from the root down.
- **Head versus base** (mixed; partly unverifiable) [GP7, G6-1]:
  - Only auto-approval settings are shown to come from the base branch.
  - The CLI sends changed config files from HEAD, and `greptile config` reads uncommitted local files (code).
  - The claim that the hosted bot reads all config from the PR's source branch rests on a docs extract that could not be opened.
  - In one community case, the dashboard setting overrode the repository file [GP7].
  - VectorScope's base-only settings are stricter and should stay.

### 2.6 Cost and billing

- **Billing mechanics in the CLI** (code, single-pass) [G3-9]:
  - CLI 3.7.0 (2026-10-17) added `credits_exhausted` ("insufficient credits **for this review**"), `billing_restricted`, `migration_required` and `subscription_unpaid`.
  - A monthly flex-limit check is predictive ("would exceed"), and a 429 enforces a daily review count per organisation.
  - No balance or estimate is ever shown. Plus and Apex fail closed.
  - Credit rollover and expiry remain unknown.
- **Self-host** (code, single-pass) [G3-10]: the only spend control is forcing Base. The LiteLLM config has no budget or spend settings.
- **Community** [GU16]: a Trustpilot review dated 2026-10-10 reports a $700 charge where about $90 was expected. The overage came from uncapped "flex usage", which is on by default. Other users report open-source repositories triggering paid billing, and say the $1-per-review overage penalises stacked small PRs.

### 2.7 Privacy and data handling

- **Hosted storage** (code; Greptile's own MCP app manifest, 2026-10-22) [G5-1]: saved review bodies and citations; comments with addressed flags, including those from local CLI reviews; knowledge-base documents; persistent rules and patterns; findings analytics. No retention period or region is stated.
- **CLI holdback** (code, single-pass) [GP2, G5-2, G6-15]. Since 3.1.0 (2026-06-11), the CLI withholds:
  - gitignored-but-committed paths, silently;
  - sensitive basenames: `.env`, `.envrc`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.htpasswd`, `credentials`, `id_*`;
  - `.env.*`, except example, sample, template, dist and defaults;
  - the extensions pem, key, p12, pfx, keystore, jks and ppk. There is no `.crt` or `.cer` rule;
  - patches matching regexes for PEM private keys and for AWS, GitHub, Slack, Google, Stripe, Anthropic and OpenAI keys.
  - `--include` overrides the holdback. A review whose files are all held back exits with `all-files-held-back`. When `--include` and that refusal shipped is not established; both are present in the 3.8.0 bundle (spot-checked).
- **Telemetry** (vendor) [G5-3]: client telemetry is anonymous and opt-out, and off in CI. Greptile states that it separately records service-side usage that the CLI cannot disable.
- **Self-host phone-home** (code, single-pass) [G5-4]: a daily usage export to `usage.greptile.com/usage-reports`. It is keyed by the licence JWT and a persistent instance UUID that survives a Helm uninstall. Only an explicitly empty `USAGE_EXPORT_URL` disables it. The report contents are in private code.
- **Self-host stores** (code, single-pass) [G5-5]: the deployment repository has no retention, TTL or purge setting for the KB, embeddings, memory or review state.
- **Provider routes** (single-pass):
  - The self-host LLM proxy config (`deploy/docker-compose/llmproxy-config.yaml` at 09b7db2) declares batch-eligible model patterns (`claude-*`, `gpt-4o*`, `gpt-5*`, `chatgpt-*`; since 3904840, 2026-05-08, "Update LLM proxy config for version v0.3.133"). Whether any review or background job (for example KB generation or analytics) actually uses a batch API is not shown (code). No akupara doc mentions batch. The same config sets `stream_timeout: 600` "for streaming responses" and aliases `review` to claude-sonnet-4-6, which points to synchronous streaming for reviews. If any job does use a batch API, Anthropic's Message Batches are not ZDR-eligible (29-day retention, platform.claude.com feature-eligibility table, accessed 2026-11-06) [G5-6]. The behaviour of LiteLLM or Greptile-proxy `batch_settings` beyond the config file is unverified (§10).
  - Self-host has no Together AI route. The hosted path probably adds Together for the "leased" alias (inference) [G5-10, GU20].
  - OpenAI's Greptile case study (2026-10-26) adds GPT-6 Astra for browser testing, Daybreak for security, and OpenAI's coding agent reading the KB over MCP (vendor, extract) [GU20].
  - Anthropic's Greptile case study contains no data-handling statement at all (vendor) [G5-8].
  - **Greptile's named subprocessors and its ZDR coverage per route are still unverified** [G5-11].

### 2.8 How Greptile is used: the merge-gate ecosystem

- **Gates** (code plus community) [GU10, GU11]:
  - synnax requires 5/5, and on 2026-10-09 made Greptile its sole review gate.
  - gptme gates Dependabot automerge on 5/5. It treats no Greptile review within 90 minutes of the PR opening as 5/5 (PR #4322, merged 2026-10-14).
  - code-graph-rag passes with a warning when Greptile is absent or out of credits (PR #3558, merged 2026-11-02).
  - Yen added a gate and dropped it within 34 minutes, because Greptile did not respond reliably.
  - mylesnet fixed a gate that went green on a 4/5 review.
  - Greptile's check succeeds at any score. The score lives in description text the author can edit, or in an edited comment. Gate scripts defend against author edits and quoted markers, but no actual spoofing incident was found, so the score is "spoofable", not shown to have been spoofed.
- **Agent loops** (code) [GU12, FL9, G6-16]: Greptile's `greploop` skill (v1.3) loops a coding agent up to 5 times until "5/5 confidence, zero unresolved comments". It tells the agent to resolve false-positive threads anyway. Greptile is becoming the oracle that agents optimise against (inference: a Goodhart setup).
- **Dependency bumps** (code) [GU22]: gptme's workflow cites Greptile flagging that tailwind-merge 3 targets Tailwind 4. This is evidence for owner question Q11 on keeping dependency bumps out of a trivial skip. The owner decides.

---

## 3. What independent evidence says now

### 3.1 Martian Code Review Bench (our re-analyses of Martian's goldens are subject to Q10; see "How to read this")

- **Default view** (code; corrects round one's framing) [GU2]:
  - The offline dashboard defaults to the Core profile with **F2**, which weights recall more heavily than precision (β = 2; β² = 4 in the formula, which Martian's code comment calls "recall weighted 4x more"; `benchmark_dashboard.py` at e616e84). The online ETL defaults `F_BETA` to 1.0. So online figures are F1 and offline default figures are F2, and the two must not be mixed (code, spot-checked).
  - Under Opus, Greptile v4.1 scores F2 51.2 (P 50.9, R 51.3), 9th of 21, level with CodeRabbit at 51.1.
  - Tools that favour precision fall: Devin from 51.6 F1 to 44.8 F2, and Graphite to 9.3.
  - A precision-first VectorScope will rank low on that view by design.
- **Scoring choices move ranks more than products do** (independent re-analysis) [GU3]. The 2026-03-19 change to summary-plus-inline dedup moved cubic-v2 from 12th to 1st and codeant from 4th to 31st, while Greptile stayed between 13th and 16th.
- **Cross-file PRs (n = 34; labels assigned by an LLM)** (independent re-analysis with paired bootstrap) [GU4]. Martian is not a neutral party: it benchmarks its own hidden `mra-*` reviewers.

  | Tool | Recall, cross-file (three judges) |
  |---|---|
  | Copilot-v2 | 0.60 to 0.66 |
  | Augment | 0.58 to 0.63 |
  | Qodo extended-v2 | 0.54 to 0.62 |
  | **Greptile v4.1** | **0.48 to 0.51** |
  | Greptile v5 (June pre-release) | 0.43 to 0.47 |

  - v4.1 minus Augment is −0.12 [−0.21, −0.02] under Opus, and about −0.10 under the other two judges, with CIs reaching 0.
  - Against Claude Code the gap is +0.01 to +0.08: Greptile is ahead on the point estimate under all three judges, but no bootstrap interval excludes 0 (Opus +0.02 [−0.09, +0.12]; GPT-5.2 +0.08 [−0.01, +0.16]).
  - On the 8 large PRs, v4.1 recall is 0.40 to 0.42 against 0.60 to 0.69 for the leaders. n = 8 is too small to conclude anything.
- **Small-n weak spots** (independent, weak) [GU5]:
  - Python/Sentry: v4.1 recall 0.39 to 0.42. The v5 build reaches 0.28 to 0.31 recall with 0.26 to 0.30 precision. Cubic reaches 0.69 recall.
  - Security: recall 0.27 to 0.36 (n = 11), against 0.64 for Copilot-v2.
  - Test gaps: 0 of 4.
- **Per-repository** (code, single-pass) [G1-6]: v4.1 clearly beats the field mean only on Grafana (+0.14). The v5 pre-release is −0.10 on Sentry.
- **Online board.**
  - The October figures (Greptile 2nd at F1 about 62, P about 80%, R about 50.5%; Cubic 1st at F1 about 65) are **unverifiable**. They come only from vendor and competitor snapshots [GU6]. They are F1 figures under the online default, not the offline F2 view above.
  - The methodology changed in August 2026. Discovery moved from GH Archive to the GitHub Search API (commit fbcff89, authored 2026-08-07; PR #54 merged 2026-08-26), and an optional solo-bot filter was added. The July and October snapshots are therefore not like-for-like (code) [GU6].
  - The board has no repository-size field and no public per-PR rows, and it skips PRs over 2,000 changed lines (`MAX_PR_CHANGED_LINES`) (code, single-pass) [G1-5].
- **Graphite's January run** (code; corrects round one) [VOI16]:
  - 13 inline comments on 50 PRs, 40 PRs silent, one run, never re-run.
  - Martian hides LinearB and Bito, whose runs show a similar silence pattern, under a blanket comment, but does not hide Graphite. Its download step swallows `gh` errors.
  - So Graphite's 0.07 recall is just as consistent with an incomplete run. It is no longer evidence for the five-class filter.

### 3.2 GitHub's ReviewBench (vendor-affiliated)

- **Composition** (code) [GU7, G1-1]:
  - 219 PRs from 187 repositories in 19 languages, MIT licensed. Copilot leads at 40.1 grounded F1 (vendor press).
  - Golden true positives come 45.2% from an unnamed `ccr` LLM review system, 53.0% from LLM review agents, 1.5% from human comments and 0.3% (8 true positives) from deterministic tools (`tool`) (README table at f223ce3). METHODOLOGY.md confirms that `ccr` is unnamed ("Section 4.2 does not yet name this system"). Its producer IDs name the models it ran with, for example `ccr:gpt-5.5[ReasoningEffort=medium]` (36.5% of true positives), so per-producer stratification (addendum §3, VS-21) can use them.
  - 18 PR bodies already contain other bots' review text (Greptile's in 2).
  - The repository commits no per-tool predictions, and per-repository licences are absent from the manifest.
- **"Large" slice** (code, single-pass) [G1-3, G1-4]:
  - The ">100 MB" slice is 36 PRs from only 21 repositories, 10 of them from one repository.
  - By file count the median repository has 265 files, and none reaches 20,000.
  - Findings in larger repositories are not robustly more context-dependent: the broader-context share is 10.7% against 5.2%, CI −0.5 to +10.2.
- **Context needs** (code, single-pass; labels from an LLM classifier) [G6-12]:
  - 58.3% of true findings need the diff plus related files, 35.8% the diff only, and 5.9% broader project context.
  - For high-severity findings the shares are 78.5%, 13.8% and 7.7%.
- **Scope of true findings** (code; recounted during revision from `golden/*.json` at f223ce3; labels LLM-assisted) [G6-13]:
  - Each golden finding carries a `scope`: `introduced-by-pr`, `exacerbated-by-pr`, `pre-existing` or `unrelated`. The methodology calls scope "informational: a finding can be a TP even if pre-existing" (`docs/METHODOLOGY.md:241-246`).
  - Of 2,623 golden true positives, 2,391 (91.2%) are introduced by the PR, 173 (6.6%) are pre-existing and 59 (2.2%) are exacerbated. Across all 4,632 labelled findings, 557 are pre-existing.
  - The gap lane's figure of "about 12% of strong reviewers' real findings not introduced by the PR" (single-pass) could not be reproduced from the goldens and is not used. The recount above replaces it.

### 3.3 Other runs and studies

- **Fletcher** (vendor/self-reported, public code and data) [GU9]:
  - A single-prompt, one-call reviewer on Martian's 50 PRs (2026-10-17, Gemini 3.8 Flash judge).
  - Core F1 50.6 at about $0.085 per PR (Flash); F1 51.3 and F2 57.2 at about $0.19 per PR (Gemini 4 Argon).
  - All-category F1 under the same judge: Fletcher 50.6 to 52.0, CodeRabbit 42.7, Greptile v5 39.3 (46 of 50 PRs, June run). The author estimates that the scores could differ by ±5 points under Martian's judges.
  - The Haiku-versus-Sonnet result attributed to arXiv 2606.15689 is unverified.
- **Archer** (academic, arXiv 2607.01808, Jul 2026; search extract) [GU8]: Greptile, CodeRabbit, Copilot and an OpenAI coding agent, on Pro tiers with defaults, "perform poorly" on bisected LLVM regressions. Archer pairs domain knowledge with compiler validators and reports only findings with a proof of concept. It found 18 of 47.
- **CodeRabbit corpus** (academic, arXiv 2607.03316) [GU18]: 56.3% of 31,073 comments were rejected. Lightweight models predict rejection at up to 76% F1.
- **ai-review-churn** (code) [GU19]:
  - It covers CodeRabbit, Copilot and Gemini, **not Greptile**.
  - On 90.4% of AI-reviewed PRs, no human leaves an inline review.
  - Bot threads resolve 42.9% of the time when the bot is alone, against 74.4% when a human is present.
- **Traced negative numbers** (vendor, competitor) [GU14]:
  - "Greptile 11 false positives vs CodeRabbit 2" traces to Panto's blog, with no method shown.
  - "About 60% nitpicks or false positives" traces to Surmado, which cites unnamed analysis.
  - Neither may be cited.
- **The dev.to four-tool bake-off** is by a Sentry employee, and Sentry's Seer was one of the tools. So it is vendor-affiliated, not independent (community) [GU15]. Its useful result: 93.4% of 617 flagged locations were flagged by exactly one tool. Reviewers barely overlap, so one tool's silence never means the code is clean.
- **AACR-Bench and OCR** (vendor/self-evaluation; Alibaba built both) [RR4, G3-1, G3-2]:
  - OCR's best SEM-F1 is 25.10% (Claude Opus 4.6), against Claude Code's best of 14.13% and 8.36% for OpenAI's open-source coding-agent CLI on GPT-5.5.
  - AACR's own evaluator now marks per-comment SEM-F1 as deprecated.
  - The harness caps OCR at 30 tool calls while Claude Code has no turn cap, so part of the token gap is the cap.
- **CRBugBench** (academic, arXiv 2610.13668; extract) [RR16, G3-14]:
  - Review agents fail mainly on bugs that need non-local reasoning.
  - Prompts that nudge exploration gain up to 5.8% at 10% more cost.
  - Its fix-track diffs are about 3 times the size of AACR's at the median (p50 280 changed lines, p90 1,894) (code, single-pass).

### 3.4 What this adds up to

- Greptile's measured strength is **precision**: about 80% online, if the snapshots hold [GU6]. Users praise it for that [GU13].
- Nothing measured supports a recall, cross-file or large-codebase advantage [GU4, G1-6].
- On the only open cross-vendor set, a well-prompted single pass reaches mid-pack at 10 to 20 cents per PR [GU9].
- For VectorScope:
  - D2's 0.80 precision floor is parity, not an edge;
  - the opening is class-scoped recall at that precision, plus cost, privacy and honest output;
  - every VS stage must beat the `single-prompt` baseline at equal cost;
  - any external comparison must name the metric, β, the judge, the dedup rule and the Greptile run date.

---

## 4. Large-codebase context: what works

### 4.1 Measured costs on large repositories (single-pass, our measurements on 4 vCPU, git 2.43, warm cache; Linux, Sentry, Grafana and Discourse timings are subject to Q10 and Q26, see "How to read this")

- **git grep** [G1-7]:
  - Tree-ish grep: Linux (97k files) 2.9 to 3.2 s; Kubernetes (32k) 0.69 to 0.80 s; vscode (21k) 0.61 to 0.76 s.
  - Working-tree grep is about 2 to 4 times faster (about 2.4 times on Kubernetes, about 4 times on Linux).
  - Grepping for several names in one call costs about the same as one. Scoping the pathspec to two directories cut Linux to 0.10 s.
- **tree-sitter (web-tree-sitter 0.25.10)** [G1-8]:
  - It parses at 4 to 10 MB/s single-threaded across Go, TS, TSX, Python, Java, Ruby and C, with p99 of 7 to 29 ms per file and RSS under 170 MB.
  - Parsing a whole repository would take about 30 s (Kubernetes), about 38 s (vscode) and about 145 s (Linux .c), so a repo map cannot fit in 5 s.
  - Kernel-style C produces error trees in 69% of .c files.
  - No grammar bump is needed for speed.
- **Simulated VS-25 Tier 1 slice, p95 per case** [G1-9]:

  | Repository | p95 |
  |---|---|
  | Keycloak | 1.0 s |
  | Sentry | 1.3 s |
  | vscode | 3.8 s |
  | Kubernetes | 4.4 s |
  | Linux (C) | **5.9 s** (3.9 s with working-tree grep) |

- **Order of cap and gate** [G1-10]: capping before the import gate lost 54% of true dependents on average. Gating first left only 7% of cases above 200 files (p95 4.9 s).
- **Partial clones** [G1-11]: in blobless or sparse clones, working-tree grep outside the cone returns nothing, and tree-ish grep fetches blobs one at a time (21 files in 9.3 s). git 2.49 added `git backfill`, and git 2.55 fetches blobs in bulk for grep.
- **Reading blobs** [G1-12]: one `git cat-file --batch` read 200 blobs in 22 ms, against 452 ms for separate `git show` calls.
- **Deep nesting** [G1-15]: tree-sitter PR #6038 (merged 2026-10-20) bounds recursion; 0.25.10 predates it. A 200,000-deep array parsed without crashing but silently dropped one capture.

### 4.2 Retrieval: what the 2023 to 2026 evidence supports

- **Rank under a small budget; lexical candidate generation is weakest** (academic plus code) [RR2]. On Agent Retrieval Bench (427 samples, 25 repositories), a PageRank repo map and an 8B embedder tie at an 8k packing budget (0.379 against 0.373), and BM25 scores 0.205. No family wins every workflow, and the orderings flip between budgets.
- **False call sites are common** (academic, preliminary) [RR3, LCI4]:
  - A language server gave precision 1.00 on reference lookups, against 0.76 for grep, but cost capable models 12 to 19% more tokens.
  - Agents rarely choose semantic tools. Language-server retrieval did not raise the recall ceiling.
  - Vendor claims of 5 to 34 times token savings are uncontrolled.
  - Conclusion: confirm references deterministically before the model sees them. Do not hand the model a tool and expect savings.
- **Production rankers** (code) [LCI6, LCI7]:
  - Zoekt's opt-in BM25 (gated by `opts.UseBM25Scoring`) boosts filename and symbol matches 5 times (`importantTermBoost = 5`). It divides the term frequency of low-priority files by 5 (`lowPriorityFilePenalty = 5`; `index/score.go` at a5a933b). Low priority means tests, vendored, generated and binary files by index category (`FileCategory.lowPriority`, `index/file_category.go:89-90`). On older indexes without categories, it means only tests and vendored files by enry path check (`score.go:416-424`). The integer division zeroes small counts.
  - Sourcegraph's code assistant (public snapshot, 8e20ac6) fuses retrievers with reciprocal rank fusion at k = 60.
  - An open-source IDE coding assistant retrieves twice the final count, then reranks.
  - Sourcegraph's RecSys'24 paper advises evaluating retrieval, ranking and the LLM separately.
- **Context levels** (academic) [LCI2, RR5]:
  - About 50% of AACR-Bench's comments are diff-level, 34% file-level and 15 to 16% repo-level (repository chart checked; paper counts unverified).
  - Without agents, recall decays as the required context grows. Agents raise repo-level recall but lose diff-level issues ("tunnel vision").
  - Effects vary by model, language and paradigm, so one model's ablation sets no default for another.
- **Forward context matters too** (code and academic):
  - The same code assistant's tsc retriever adds depth-1 signatures of referenced symbols, and warns that deeper recursion "quickly goes out of hand" [LCI8].
  - Hierarchical Context Pruning found that only level-1 dependencies help, and that pruning dependency bodies costs little, at about 8k tokens (AAAI 2025) [RR7].
  - Kuaishou's flow-based slices beat diff-only and parent-function context, though that table is unverified [RR6].
  - VS-25 packs only reverse dependents.
- **Models infer impact poorly** (academic) [RR9]. GPT-5 scored F1 0.22 on change-impact sets. CodePlan's deterministic impact analysis passed 5 of 7 multi-file edits, against 0 of 7. Impact must be computed, not asked for.
- **More context can hurt** (academic):
  - LongCodeBench pads gold files with BM25-retrieved or random files, and Claude 3.5 Sonnet fell from 29% to 3% (abstract figure; context range and the Qwen figure unverified) [LCI19, RR1].
  - Chroma's Context Rot found that one semantically similar distractor lowered accuracy in all 18 models [RR8].
  - Repoformer found many retrieved contexts unhelpful or harmful [RR8].
  - Similar-code retrieval degraded generation by up to 15% [RR8].
  - An empty slice is a valid outcome.
- **Agents over-retrieve and under-use** (academic) [RR11, LCI10, RR17]:
  - ContextBench: block-level context F1 is below 0.45. Agents explore the right code without using it.
  - On SWE-QA, 41.8% of agentic failures happened silently at the hand-off between planner and sub-agent.
  - Gold context lifts GPT-4o by 27.4% on SWE-bench, and the best retriever stays about 9 points below gold, so the retriever is the bottleneck.
  - Iterative retrieval argues for keeping read tools.
- **Intent text may beat code context** (academic) [RR12]: ContextCRBench found that the linked issue plus the PR description gave larger gains than code context alone. This is worth a VS-21 ablation, with PR text kept as untrusted data.
- **Live evidence for model-driven retrieval in review is negative** (academic, weak) [RR13]. In the Mozilla and Ubisoft field study, the variant that let the model retrieve code had lower acceptance (5.3%) than the variant that retrieved similar past comments (8.9%).
- **Context files** (academic; corrects round one's "no study measures their lift") [RR14]:
  - Gloaguen et al. report no success gain, with a cost increase of more than 20% (not read in full; wording unverified, arxiv.org unreachable).
  - Khatri (291 runs) shows equivalence within 10 to 15 points and a mixed effect on efficiency.
  - The prior that VS-26 Brain cards raise recall is now about null.
- **Graph-guided localization** (academic) [LCI20, RR15]: graphs beat lexical retrieval on issue-to-location tasks. What transfers is the machinery (def, ref, import and invoke edges), not the accuracies.

### 4.3 Indexes and industry practice

- **Embeddings** (vendor) [LCI9]: Cursor reports +12.5% on its internal benchmark but only +0.3% code retention online (+2.6% in repositories of 1,000 files or more). An embedding API would send code to another provider, against ZDR routing. Keep embeddings out.
- **Incremental fact stores** (code):
  - An open-source IDE coding assistant keys facts on content hash per (directory, branch, artifact), with a global cache across branches [LCI12].
  - Glean stacks a new DB on the base, hides changed units' facts, and adds about 7% for ownership [LCI13].
  - Cursor's simhash index reuse and proof of possession are vendor claims, unverified [LCI11].
- **Trigram index** (vendor) [LCI14]: Cursor's Instant Grep cut a monorepo regex search from 16.8 s to 13 ms. It is only worth building if p95 fails.
- **Industrial reviewers** (vendor and academic) [LCI16, LCI17, LCI18]:
  - CodeRabbit builds a graph per review and lists the repositories it considered.
  - Qodo packs method chunks with their class definition and imports.
  - Uber adds nearby functions, class definitions and imports.
  - Atlassian's RovoDev names unknown context as a cause of bad comments.
- **Symbol navigation** (vendor) [LCI3]: Copilot's agentic review gathers context on Actions runners, with MCP, skills and Memory. Sourcegraph exposes go-to-definition and find-references over MCP.
- **Vendor savings claims** (vendor) [LCI5]: Bito claims precomputed context cuts tool calls by 50% and cost by 44%. This has not been measured independently.

### 4.4 What this means for VectorScope

1. **Fix VS-25b's order:** run the import gate before the 200-file cap, then rank, then cap [G1-10].
2. Rank gated candidates by graph rank fused with a lexical score. Where history exists, add co-change, ranked below static edges [RR2, LCI6, LCI7]. Placing co-change below static edges is inference (the retrieval lane's RR10 is not restated in this report).
3. Record slice recall at each stage (candidates, gated, confirmed, packed), and record what the gate dropped [LCI7].
4. Pack the enclosing definition, then depth-1 outbound signatures, then inbound call sites, inside the existing cap. Label VS-22 cases hunk, file or repo, and sweep the budget per model [LCI2, LCI8, RR7, RR5, RR2].
5. Report Tier 1 p95 by file-count band, with a permissively licensed case of 50k files or more. Use working-tree grep only for a clean, checked-out head. Detect partial clones. Time-box the slice and mark it "impact incomplete" when the time box fires [G1-7, G1-9, G1-11].
6. Do not add embeddings, a symbol tool or a trigram index now [LCI9, RR3, LCI4, LCI14].
7. Instrument whether findings use the slice, and test one exploration-nudge sentence [RR11, RR16].
8. Expect a null result from Brain cards, and pre-register a cost criterion [RR14].

---

## 5. Predicting bugs: what works and how to act on it

### 5.1 Commit level (independent, our measurements on ApacheJIT; SZZ-derived labels)

- **Diff features carry nearly all the ranking power** [RP3, RP12]:
  - A diff-only logistic model reaches AUC 0.809, all 13 Kamei-style features 0.862, and lines added alone 0.805.
  - Fixed diff-only points (0 to 7) reach a pooled AUC of 0.785. The low, medium and high bands cover 57, 22 and 20% of commits, at bug rates of 10.1, 27.9 and 56.6%.
  - Band bug rates are not stable over time (18.5, 44.7 and 67.6% in earlier years), so the bands rank commits but are not probabilities.
- **History adds almost nothing** [RP4]. On four Apache repositories with full history:
  - diff-only 0.799; plus 90-day fix density 0.798; fix in the last 5 commits 0.801; 90-day churn 0.803; Google-style decay 0.796.
  - VS-28's literal regex is an unanchored substring match (it matches "prefix" and "debug").
  - Diff-only and diff-plus-churn bands agreed on 86% of commits and never differed by more than one band.
- **SZZ biases** [RP6]: commits that add no lines are never labelled buggy; hadoop has 0 positives in 11,964 commits; per-project positive rates span 13.6 to 76.4%. This argues for raise-only floors on deletion-heavy changes.
- **Sensitive paths and tests** [RP7]:
  - A word-level sensitive-path flag shows lift only for medium and large changes, and the evidence is thin.
  - Within each size bucket, changes touching both source and tests were labelled buggy *more* often.
  - Keep sensitivity as an impact escalation, and never let a test delta lower risk.
- **Transfer and drift** [RP13]: ranking transfers across similar projects (0.819 against 0.829), but calibration does not; one project collapsed to 0.562. Use repository-relative percentiles.
- **Ordering inside a PR** [RP14]: ranking by raw risk caught only 17% of buggy commits within 20% of changed lines, while ranking by density caught 58%. Use raw risk to rank PRs and density to order files inside a PR.
- **Reverts and hotspots** [RP19, RP10]: revert history gave no signal in four Apache repositories (AUC 0.513), and the Google decay score slightly lowered AUC. Keep both as explanation text.
- **Refuted [RP15].** Fix commits were labelled buggy 64% of the time, against 19% for other commits, and the feature appeared to add +0.05 AUC. But ApacheJIT's construction sets `fix` only for issue-linked commits and sets it False for every clean commit (code). On the four repositories, matching a fix regex on commit subjects gave P(buggy | fix) 0.236 against 0.302, AUC 0.477. The "self-fix" signal is a labelling artefact and is not used.

### 5.2 PR level (independent, single-pass; golden labels are review-found issues, not future defects; Martian inputs are subject to Q10)

- **Commit cutpoints do not transfer to PRs** [G2-1]:

  | Dataset | High band, share of PRs | High band, share of changed lines |
  |---|---|---|
  | Martian (48 PRs)¹ | 56% | 86% |
  | ReviewBench (219) | 56% | 96% |
  | AACR permissive (131)¹ | 21% | 49% |

  ¹ These populations are smaller than the dataset counts in §1 and §8, because numstat could not be computed for every PR (checked against the band-analysis scripts and fetch logs during revision). **Martian:** 2 of 50 PRs (`sentry-greptile` #1 and #3) failed to fetch, leaving 48. **AACR:** the band analysis used the permissive subset's 140 positive samples (the samples that carry goldens; VOI13's subset is 144 PRs). It classified licences by a per-repository list, which gave the same count of 140. For 9 of the 140, GitHub no longer serves a needed commit ("upload-pack: not our ref"), leaving 131. VS-39's cutpoint seeding (addendum Q27) inherits these exclusions.

- **The band ranks PRs by golden count, but mostly as a proxy for size** [G2-2]. Spearman ρ is 0.47 to 0.57. On ReviewBench raw size does better (0.61), and within size terciles the points add almost nothing.
- **Golden findings per kLOC fall steeply with band** [G2-3]: Martian 46.6 to 6.0, ReviewBench 57.7 to 2.6. Findings are densest in small PRs, so keep their full review.
- **Severe bugs** [G2-7]: for "at least one high-severity bug", the points score reaches AUC 0.60 against 0.70 for raw size on ReviewBench, and 0.71 against 0.70 on Martian. Do not cite the commit-level 0.785 for PR routing.
- **Default-depth recall by band** [G2-4]: across 49 tools on Martian, recall is not higher on the high band (high minus low −0.11, CI excludes 0). True positives per kLOC fall from 23.7 to 2.2. High-band PRs leave the most bugs unfound in absolute terms but are the least efficient per token.
- **High-severity recall** [G2-5]: it rises slightly with band (0.547, 0.579 and 0.610 under Opus; the low band has 5 PRs). Report it by band.
- **Deeper variants** [G2-6]: deeper variants of one product gain more recall on the high band (qodo to qodo-extended +0.24 to +0.28). Finding caps confound this comparison, so a lens ablation needs an equal-token control arm.
- **An LLM risk label does not route better** [G2-13]: Martian's own LLM-assigned risk level separates recall no better (0.40 against 0.43).

### 5.3 Production systems and tools (code unless marked)

- **Mozilla bugbug** [RP1, G2-8, G2-9]:
  - An XGBoost model with isotonic calibration.
  - Positive labels come from Bugzilla "Regressed by" links, not from SZZ. Backed-out commits are dropped from training and evaluation. The last three months are kept out of training and used for evaluation, grouped per bug with the maximum probability.
  - Bands are relative to the base rate (about 7, 15 and 35% around a 13% average, with a minimum of 200 samples), and the cutpoints are a deployment secret.
  - A hook scores Phabricator diffs, and a daily landings report predicts regressions per team.
  - The README says risk "could be used to make riskier patches undergo more scrutiny", but **no outcome test is published**.
- **Mozilla test selection** [RP2]: Mozilla spends risk on tests. It adds a test config only when the risk-weighted gain per unit cost exceeds 0.00015, with deterministic overrides (modified tests are forced to risk 1.0).
- **PR-Agent** [RP8]: model `risk_level`, the merge recommendation and failure modes stay opt-in. It adds a deterministic structural-reach band over dependent projects: narrow ≤ 3, moderate ≤ 25, wide above. Module and file counts are not banded: "Reach bands are defined for projects only, so a module or file count is shown without one" (`pr_agent/algo/structural_reach.py` at 6de02f5). A sensitive domain is at least High, sensitive plus wide is Critical, and a cross-domain change is at least Moderate (code).
- **gitStream** [RP9]: repository rules require a second approval on large src/ changes that are slow to review.
- **CodeScene** (vendor) [RP11]: claims Red code has 15 times more defects, from a correlational study the vendor wrote. Its own agent skill ranks the change set first and treats hotspots as background.
- **Kodus** (vendor) [CF18]: keeps per-file fix history, refreshed every 2 hours from PR labels and titles. It uses that history only to gate auto-approve, and treats a file with no history as not safe.
- **Meta** (academic, search extract) [LCI21, G2-11]: RADAR routes *low*-risk diffs away from humans, the mirror image of VS-28. Selection confounds its revert and incident ratios. The DRS paper stays unread [RP20].
- **Research** (academic, recalled) [RP16, RP17]: industry uses risk to drive testing and scrutiny (Facebook PTS, Microsoft CRANE, Ubisoft CLEVER). Less intense review correlates with more post-release defects (McIntosh, Thongtanunam, Kononenko).
- **No tool** has independent evidence that it predicts future bugs beyond findings in the current diff (mixed) [RP18].
- **Greptile** (vendor, extract-only) [GP10, G2-12, G6-7]: its form is a KB with an index, per-area docs listing risk areas, and a section of past revert, rollback and incident PRs. A fixed bug's location becomes a risk area that later PRs are checked against. No measured effect is published.

### 5.4 How to act on it

- **Use risk only to choose depth, never as a posted forecast** (confirms round one; consistent with every production system read).
- **Make `riskOf` honest:**
  - likelihood is mainly log(added + deleted), with directories and entropy as tie-breakers;
  - reach comes from VS-25 dependents. PR-Agent's thresholds are defined for dependent projects only, so using them for counts of dependent files is inference: they are starting points to fit in Phase A, not a transferred result;
  - sensitive paths and deletion-heavy changes are raise-only floors;
  - history is explanation text only;
  - reverts are a separate feature [G2-2, RP8, RP6, RP4, G2-9].
- **Calibrate cutpoints on PRs**, so that the high band holds at most about 20% of PRs. Move to repository-relative percentiles after 200 or more PRs [G2-1, RP13, G2-8].
- **Price lenses by the high band's share of changed lines, not its share of PRs** [RP5]. Kodus's heavy mode (nine lenses) used 1.3 to 2.1 times the tokens of a normal review on its 2026-11-02 eval runs (`evals/heavy-recall/README.md` at 2ee5d32). Its docs report about 2.5 times the model cost and up to 2 times the latency over 30 PRs (`docs/en/how_to_use/code_review/review_directive.mdx` at 5fe263734). That works out to about 3 to 17% per lens (vendor) [G3-11]. Heavy mode was removed on 2026-10-23 (a5bac4029) and reintroduced on 2026-11-04 (merge 5e886f252).
- **Validate prediction only on VectorScope's own merge outcomes**: reverts and follow-up fixes within 30 or 90 days, with lag windows in the style of bugbug. Benchmarks can validate routing, not prediction [G2-10].
- **Do not market "predicts future bugs"** (D12) [RP18]. The honest form is "deeper review where change size, reach and sensitivity are higher, with reasons".

---

## 6. Learning from feedback safely

- **VectorScope's existing loop** (code, worktree 765ef4ec; unchanged at 7cadfcb8):
  - `classifyPrior` accepts an author's dismissal (a resolve, a thumbs-down, a "not an issue" or "won't fix" reply, or `/vector dismiss`) for any finding except blocking security [FL1].
  - The marker stores no actor, role, reason or directory.
  - `teamPatterns` reads up to 3 pages of Vector comments across the repository and keeps up to 30 patterns, with no trust, fork, author or age filter.
  - On the fork path, a writer has to trigger two reviews. The common path is writer-authors dismissing their own findings, which then shapes everyone's reviews.
- **The strongest suppression is the prompt** (code) [FL2]:
  - The trusted "Do not report" list includes "anything that matches `<team_dismissed>` unless it is clearly more serious". One pattern is enough, the security pass gets the same instruction, and nothing is logged as dropped.
  - The `select.ts` penalty needs two patterns, ignores the stored directory, and applies to security findings too.
- **"Fixed" can rest on the model's own judgement** (code) [FL18].
- **The field** (code and vendor):
  - Kodus built a k-means reaction filter. It used cosine similarity 0.6 for clustering and for positive and negative matches, and needed at least 50 embedded suggestions per repository, with an organisation-wide fallback at the same minimum (`libs/kodyFineTuning/infrastructure/adapters/services/kodyFineTuning.service.ts:45-47, 563, 576` at 0a0435900, 2026-06-24; code, checked during revision). It had no severity exemption (spot-checked). Kodus's docs described the filter as inactive by 2026-09-15 (7d8cd3d1a, "clarify inactive reaction-based fine-tuning"). The code was removed on 2026-10-23 (a5bac4029), when its stage ran in no pipeline (code) [FL3, CF17].
  - Kodus now applies feedback to named rules with health states: "low data" under 5 triggers; "noisy" at 3 or more thumbs-down that outnumber thumbs-up and reach 10% of triggers; "ignored" when 20% or fewer are implemented. An opt-in auto-pause notifies admins [FL4].
  - Kodus generates rules from human comments, excludes its own comments (avoiding a self-feedback loop) and supports a reviewer denylist, but makes rules active by default [FL5].
  - Kodus counts reactions from any account [FL6].
  - GitHub uses thumbs only as an aggregate signal and accepts repeated comments (vendor) [FL7].
  - Copilot Memory creates memories only for users with write access. It re-checks their citations, and screens secrets and control tokens. Memories expire after 90 days by default (owners can set 7 to 180 days), and the expiry resets when Copilot itself upvotes them. The cloud agent and code review store memories without asking; the Copilot app and CLI interactive sessions can ask for approval. Memory can learn from unmerged PRs (vendor; github/docs at 17d6ee5, `content/copilot/concepts/prompting-and-context/copilot-memory.md`) [FL8].
  - Kodus's verifier treats an unknown status as pending. It never drops a finding because of infrastructure trouble, and never drops security, data-loss or crash findings (code) [FL12].
- **Agent loops contaminate signals** (code) [FL9, G6-16]: Greptile's skill resolves false-positive threads by instruction, so resolution measures agent compliance.
- **Measurement method** (independent methodology, partly unimplemented) [FL10]: Martian's checklist covers effort proportionality, a flat action rate across severity, fix durability, self-only engagement and pairing with cycle time. Its "matching" judge counts partial overlap.
- **Research** (academic, recalled):
  - "addressed" originates in Bosu et al. (MSR 2015), designed before agent compliance existed [FL14];
  - Google retired or tuned whole best practices from feedback, rather than single findings [FL15];
  - preference feedback can be poisoned, and it rewards agreeableness [FL16].
- **VectorScope already has the approval machinery** (code) [FL13]: Brain's pending "review" entries, its separate handling of instruction-like text, and the rule that "outside content cannot vouch for memory".
- **What follows.** The safe loop is a design synthesis, not a verified fact [FL17]:
  - count only dismissals by writers other than the author;
  - never suppress security, blocking, data-loss or crash findings;
  - demote rather than silence, and log every suppression;
  - let untrusted signals only exclude data;
  - send durable learning to Brain as pending proposals the owner approves;
  - measure on replay with adversarial cases before anything automatic.
  - Expect the memory to shrink a lot, because same-repository authors are usually writers.

---

## 7. Feature gaps against the field

| Feature | Field | VectorScope today | Gap and evidence |
|---|---|---|---|
| Fix path | "Fix with Copilot"; Kodus `--fix`; Greptile `greploop` | **Exists on GitHub** via `/vector fix` through the @vector agent, which pushes to the PR branch; fork PRs refused under App auth (code) [CF1] | Missing: consent (VS-12/13) and a local apply step. Autofix itself exists. Validate fixes by re-checking [CF12]. Loop on verified findings, never on a score [CF13] |
| Re-review | Copilot: opt-in, and it repeats dismissed comments [CF2]; PR-Agent: opt-in, skips merge and bot commits [CF3]; Greptile: off by default [GP5] | On by default; dismissed findings stay dropped; rebases carried; base-merge hunks excluded (code) | Ahead on quality, behind on cost: re-reviews run at full depth |
| Summary and walkthrough | CodeRabbit defaults to a summary, walkthrough, diagrams, linked issues, labels, suggested reviewers, and `poem: true` [CF4] | 2 to 3 sentences plus a file table | Table stakes but user-facing (D14). The only evidence is an observational study (FSE 2024, recalled) [CF5] |
| Ticket compliance | PR-Agent: Fully, Partially or Not Compliant, with a host-only allowlist [CF6]. Kodus: MET, PARTIAL, MISSING, CHECK MANUALLY, NOT IN TASK, with path:line and exact-id resolution [CF7] | CLI Brain requirements only; VS-16 planned | Adopt per-requirement rows and PR-Agent's guards in VS-16 |
| Scoped instructions | Copilot: path-scoped `*.instructions.md`, AGENTS.md, skills [CF8]. Kodus: six families, nearest-first, 8 files, 64 KB, read from the target branch [CF9] | Root AGENTS.md/CLAUDE.md, `.vector/RULES.md`, plus glob-scoped `.vector/review.md` sections and `review.json` `paths`, merged into one rules block for the whole change by `rulesForPaths`, which includes a section when any changed file matches it (`config.ts:270-281`; code) [VT3] | Narrow gap: the trusted rule path does not read nested AGENTS.md/CLAUDE.md or `.github/instructions/*.instructions.md`. Copilot excludes `requirements.txt`; VectorScope should keep reviewing it |
| Rule-cited findings | OpenAI's open-source coding-agent CLI review rubric: cite the smallest supporting rule range, never invent a finding because a rule file exists, no pre-existing bugs [CF10] | `rule` field rendered but never checked | Close it (addendum VS-42, VS-43) |
| Per-rule checks | CodeRabbit: pass, fail or inconclusive, warning-first [CF11] | A single `failOn: blocking` | Warning-first rollout fits I-7's honest "inconclusive" |
| Security scanners | CodeRabbit: gitleaks, semgrep, checkov and 22 more [CF20]; Greptile Security Agent [GP19] | Model specialist only; VS-18 planned | Pull VS-18's offline scanning forward. Memory features elsewhere need retention, which conflicts with ZDR [CF20] |
| Security reviewer on untrusted PRs | Anthropic's security-review Action warns that it is not hardened against prompt injection [CF21] | Fork-safe reads, base settings, wrapped text | A differentiator |
| Test generation | Qodo Cover unmaintained since 2025-06-15 [CF22] | None | Not where review value is; keep VS-30 reproducers as evidence |
| Auto-approve | Copilot approvals count toward required reviews; Kodus holds on risk [CF23] | Out of scope (§9) | Keep out |
| Latency | Copilot: "usually less than 30 seconds"; PR-Agent describe: about 30 s (vendor) [CF24] | 12-minute timeout, unmeasured | Report p50 and p90 |
| Pricing | Kodus: $10 per developer plus BYOK, unlimited reviews [CF25] | BYOK in own CI, no markup | Compete on quality and privacy, not price |
| Severity calibration report | Kodus expects implementation rates to fall as severity falls [CF15] | State exists, never aggregated | Zero-token report (addendum VS-45, VS-46) |
| Outcome mining | Martian's online method matches suggestions to later fixes [CF16] | None | Internal only, on owner repositories (I-13) |
| Focus directive | Kodus `@kody review focus on …`, a priority, not a filter [CF19] | None | Only as wrapped prompt data, never choosing depth (I-2) |
| Reaction learning | Kodus retired it (inactive by 2026-09-15, removed 2026-10-23) [CF17] | One-pattern prompt suppression | Weakens round one's B− ranking |
| Merge-gate verdict | Greptile: score in editable text; gates fail open [GU10, GU11] | Exit 0 on unfinished reviews except configuration errors; no machine-readable output [VT1] | A head-bound, fail-closed verdict (addendum VS-32) |
| Pre-upload secret holdback | Greptile CLI [GP2] | Redaction of posted text only [VT2] | Addendum VS-34 |
| Local review | Greptile CLI, Kodus CLI, Copilot in the IDE, `greptile review --json` [GU12, CF13] | `vector review`, `--json`, desktop panel | At parity; Greptile now competes here |

**VectorScope code findings read during revision** (code; worktree 0f772e6e; the cited files are identical at 765ef4ec and at HEAD 7cadfcb8, line numbers at 7cadfcb8):
- **[VT1] Exit paths of the GitHub job** (`packages/engine/src/cli/cmd/github.review.ts`).
  - **Exit 0:**
    - every skip (`finish(0)` at lines 256, 260, 387, 416, 430, 515, 559);
    - every specialist failed without throwing (701-716);
    - every completed run, partial ones included, unless `failOn` is `"blocking"` and blocking findings are open (959-961);
    - model or tool failures caught inside `reviewJob` (962-978);
    - any other failure before the review starts, GitHub (other than 401, 403 and 404) or git, unless a model that cannot start was already recorded (`executeReviewJob`, 200-221).
  - **Exit 1:**
    - a model or triage model that cannot start (`seen.cannotStart`, 206-208; `cannotStart` → `configError`, 391-402);
    - GitHub 401, 403 or 404 before the review starts (210-212);
    - the working-tree and head mismatch checks (`configError`, defined at 244 and returned at 269 and 273, in 268-276). These fire when a trusted review's checked-out tree is not the expected head, and when a fork review's checked-out tree is the fork's head;
    - `failOn: "blocking"` with open blocking findings (959-960);
    - command-level failures before the job starts (missing repository, `VECTOR_PURE` or `VECTOR_DISABLE_PROJECT_CONFIG` unset in Actions, no PR, App auth: 1108-1121, 1220-1229).
  - No `$GITHUB_OUTPUT` write exists.
- **[VT2] Redaction scope.**
  - `packages/core/src/review/redact.ts:1-2` scopes redaction to "everything Vector posts".
  - `packages/engine/src/review/run.ts:661-685` builds `PromptInput` from `packed.diff` and `packed.headFiles` and passes it to `buildReviewPrompt` and `buildSecurityPrompt` with no redaction. `PromptInput` also carries `context.related` (`git grep` hits), history, human comments and PR text, none of which pass redaction (review finding, code).
  - The read tool's deny list is `SECRET_FILES` plus `*.env`/`*.env.*` in `packages/core/src/review/permission.ts:11-22`, applied at 67-72. Its patterns use the `Wildcard` matcher, in which `*` crosses `/` (`permission.ts:9-10`).
  - grep's permission pattern is the search regex (`packages/engine/src/tool/grep.ts:41-47`). Before searching, it filters candidates through the read rules and asks read for the rest (`grep.ts:94-109`, `packages/engine/src/session/tools.ts:123-133`), so grep inherits the read deny list exactly, gaps included (code).
  - The security prompt tells the model only to write `[redacted]` in its own output (`prompt.ts:125`). It does not say that inputs may already be redacted.
- **[VT3] Path-scoped trusted rules already exist.**
  - `rulesForPaths` (`packages/core/src/review/config.ts:270-281`) merges the global section, every `.vector/review.md` section whose globs match a changed file, and the matching `review.json` `paths` entries. The CLI calls it (`packages/engine/src/cli/cmd/review.ts:434-438`), and so does the CI job.
  - Locally, `ReviewContext.gather` is called without `instructions` (`review.ts:377-384`), because "locally the engine loads the user's instructions as usual" (`packages/engine/src/review/context.ts:247-248`). The engine's session loader (`packages/engine/src/session/instruction.ts`) finds the project AGENTS.md or CLAUDE.md upward from the working directory, and attaches nested instruction files when a tool reads a file beneath them.
  - In CI, the base-commit instruction gatherer runs through a contents-API reader (`github.review.ts:563-570`). Root rules and settings are read at `pull.base.sha` (`github.review.ts:279-284`). `RunInput.base` is the merge-base (`run.ts:98`).

---

## 8. Round one's open items, answered

| Round-one open item (§7) | Status now | Findings |
|---|---|---|
| Greptile's docs and the Model Inversion method | **Still unverified.** greptile.com and archive snapshots were unreachable. New: the detection signals (branch names, commit trailers) are in the CLI payload, and no inversion setting or code exists in the client or self-host | GP16, VOI17, G6-9 |
| Which providers and models Greptile's ZDR covers | **Still unverified.** New: hosted storage is durable by design. The self-host proxy config declares batch-eligible model patterns, but whether any job uses a batch API is not shown. A Together leg is likely, and the hosted path uses three or more providers | G5-1, G5-6, G5-10, G5-11, GU20 |
| Whether self-host still generates per-node summaries | **Answered.** The summarizer was scaled to zero on 2026-06-29 and removed on 2026-07-26. KB synthesis by a separate nightly job took over the natural-language layer (that link is inference) | GP11, GP9, G6-7 |
| OpenRouter ZDR prose and the 404 body | **Prose read** via the public docs mirror: Safety Retention, per-model-group routing, server tools (Fusion inner generations inherit account-level but not request-level ZDR), response caching (off by default; unavailable under account-level ZDR), BYOK declarations, CSAM screening. **The exact `zdr: true` failure body is still undocumented**; the docs point to a 404 or a 503 | G4-1 to G4-9, VOI2 |
| OpenAI and Google ZDR terms; extended caching | **Partly answered.** OpenAI: gpt-5.5 and later support only 24 h retention; ZDR organisations default to in_memory on older models; extended caching keeps KV tensors on GPU-local storage for up to 24 hours; there is a project-level data retention API; safety alerts run on ZDR traffic. **Whether extended caching is ZDR-eligible is not stated.** Google: Service Terms read (no storage beyond need; grounding exceptions); the Vertex cache config defaults to DURABLE; Gemini API terms unread | VOI8, VOI9, G3-8, G4-10, G4-11, G4-12, VOI10, G4-13 to G4-16 |
| Recalled papers and arXiv 2607.21997 | **Still unread** (arXiv blocked). A sibling note's figures for 2607.21997 are secondary and internally inconsistent | VOI18 |
| D8 licences of Martian and AACR | **Answered.** Martian snapshots: Keycloak Apache-2.0; Cal.com AGPL plus commercial at the snapshot (MIT upstream now); Grafana AGPL; Discourse GPL-2.0; Sentry FSL (three PRs are now Apache-2.0 under the FSL's future licence). At most 13 of 50 PRs are D8-clean. AACR: the repository is Apache-2.0; 40 of 50 projects are permissive at each repository's first dataset PR commit (lvgl checked at HEAD only); 144 PRs are clean | VOI11, VOI12, VOI13, VOI14, G3-3 |
| `zdr` type in `@openrouter/ai-sdk-provider` 2.9.0 | **Yes**, typed since 1.5.0. A later `provider` object replaces it by shallow merge, so enforcement belongs on the final body | VOI1 |
| tree-sitter timings on 0.25.10 and other languages | **Answered.** 4 to 10 MB/s across seven languages; all tested grammars load; parsing a whole repository is far over budget; C error trees are common | G1-8, G1-15 |
| How Graphite's January Martian run was configured | **Answered as far as the data allow.** Graphite Agent, one run, 13 comments, 40 silent PRs, no config files in the forks; consistent with an incomplete run | VOI16 |

---

## 9. Corrections to round one

| Round one said | Correction | Finding, kind |
|---|---|---|
| Martian's Core F1 is the board's view | The offline default view is Core **F2**, where Greptile v4.1 scores 51.2, 9th of 21. The online ETL defaults to F1 | GU2, code |
| Greptile reached #1 online, then fell to #3 | October online figures are unverifiable, and not like-for-like with July, because discovery changed in August | GU6, mixed (unverifiable) |
| "Config is read from the base branch" | Shown only for auto-approval settings. The CLI sends head configs, and the hosted review's config source is unverified | GP7, G6-1, mixed |
| Greptile's auto-approve risk categories (auth, secrets, billing…) | Extract-only. The shipped mechanism is path filters plus approval-risk instructions; do not present it as Greptile's taxonomy | G6-8, G6-4, code (single-pass) |
| Self-host telemetry is off unless OTLP is set | OTLP is off by default, but a daily usage export to usage.greptile.com is being wired in | G5-4, code (single-pass) |
| OpenRouter Safety Retention covers flagged prompts | It may cover any request, and self-serve accounts allow it by default | G4-1, vendor (single-pass) |
| Vertex: in-memory caching up to 24 h | An untouched project reports DURABLE implicit caching | G4-13, vendor (single-pass) |
| OpenAI under ZDR is in_memory only | True only for models before gpt-5.5; gpt-5.5 and later support only 24 h | G3-8, G4-11, vendor (single-pass) |
| Reaction and embedding suppression is table stakes (B−) | Kodus built and retired it; GitHub uses no per-repository suppression | FL3, CF17, FL7, code and vendor |
| VectorScope's analogue is a 0.15 penalty after two patterns | The stronger suppression is a one-pattern prompt rule, also in the security pass, and unlogged; author dismissals become repository memory | FL1, FL2, code |
| VectorScope has no fix or chat path on GitHub | `/vector fix` and `/vector <question>` already route to the @vector agent; what is missing is consent and a local apply step | CF1, code |
| No study measures context-file lift | Two 2026 studies: no reliable success gain, with a cost increase in one and a mixed efficiency effect in the other | RR14, academic |
| AACR-Bench is "built around repository context" | Its result is that context level and retrieval method help or hurt depending on model, language and paradigm | RR5, academic |
| Cal.com is AGPL | AGPL plus commercial at the benchmark snapshot; MIT upstream now | VOI11, code |
| Graphite's 0.07 recall is consistent with acceptance-only tuning | It is just as consistent with an incomplete run; do not cite it for the five-class filter | VOI16, code |
| The four-tool dev.to bake-off is independent | It was written by a Sentry employee, so it is vendor-affiliated | GU15, community |
| ai-review-churn is a Greptile-related study | It covers CodeRabbit, Copilot and Gemini only | GU19, code |
| "11 FP vs 2" is untraceable | It traces to Panto, a competitor, with no method shown, so it is still unusable. "60% nitpicks" traces to Surmado | GU14, vendor |
| OCR uses 9× or 15× fewer tokens | 5.4 to 14.7× by model, mean 9.6×; only 1.24× against OpenAI's open-source coding-agent CLI; the tool cap is a major lever (inference: confounded with the tool's design) | G3-2, vendor data, our arithmetic (single-pass) |
| History is often missing in CI, a problem for VS-28 | Mostly moot: history adds about +0.00 AUC, so use it as explanation only | RP4, independent |
| VS-28's commit-level points are a basis for routing | At PR level they put 56% of PRs in the high band and do no better than size | G2-1, G2-7, independent (single-pass) |
| ReviewBench has a June 2026 Greptile run | ReviewBench starts 2026-09-04 and has no Greptile agent; the June run is Martian's pre-release | G1-2, G6-11, code (single-pass) |

**Corrections to this round.**
- RP15 ("this change is a fix" is the strongest non-size predictor), round two's own refuted finding, is withdrawn (§5.1). Round one did not rely on it. The owner question QR1 in the round-two risk note, which was built on it, is dropped.
- Round two's VOI2 recommendation said to classify any 404 on a ZDR request as a refusal. Corrected: do not make 404 text a privacy control. Identical retries cannot leak, and model switches are refused in admission. Match 404 or 503 only to choose the note wording (G4-8, vendor, single-pass).
- An earlier review corrected: the akupara default-policy history (§2.1); the Kodus heavy-mode cost range and history (§5.4); the Kodus reaction-filter dates and thresholds (§6); PR-Agent's reach scope (§5.3); Copilot Memory expiry and approval (§6); the gptme fallback claim, dropped for lack of a cited source (§2.8); VectorScope's scoped-instruction row (§7); and the exit-0 claim, now limited to non-configuration failures (§1 item 8, VT1).
- The second review corrected:
  - **Batch routing:** the claim that Greptile's self-host "routes Claude and GPT models to provider batch APIs" is replaced by what the config shows: declared batch-eligible patterns, with use not shown. It is no longer listed as data retained by design (§1 item 7, §2.7, §8, §10).
  - **OpenRouter caching and Fusion:** the response-caching defaults, and the Fusion ZDR qualifier, are added (§1 item 6, §8).
  - **Exit paths:** the checkout-mismatch `configError` exits are added to VT1, with line numbers at HEAD 7cadfcb8.
  - **ReviewBench:** the 0.3% deterministic-tool share is added, along with the `ccr` producer IDs (§3.2).
  - **Martian's β note** (§3.1).
  - **GP15:** the manifest tool that exposes addressed flags is now `list_merge_request_comments` (§2.3).
  - **Zoekt:** the low-priority classes are now cited to the code, `generated` included (§4.2).
  - **VT2:** the untrusted prompt blocks and grep are added.
  - **Naming:** the rule is now applied to citations as well as prose (Naming).
  - **Our measurements:** gathered before Q10 and Q26 (How to read this).

---

## 10. What still could not be verified

- **Greptile prose:**
  - the exact wording of `/docs/code-review/review-tiers` (Auto's inputs and precedence), `/auto-approve-prs`, the config reference, troubleshooting, `/knowledge-base`, `/blog/model-inversion` and `/blog/automating-code-validation`;
  - whether hosted PR reviews read ordinary `.greptile` config from base or head;
  - the 2026-09-16 summary redesign;
  - the knowledge base's "real time" claim, and whether file-change activity feeds risk areas;
  - what `dsv4-flash-leased-nothink` maps to in the cloud;
  - how v5 generates and deduplicates hypotheses;
  - credit rollover and expiry rules;
  - whether "addressed" is a file-touch heuristic or judged by an LLM, in each metric.
- **Greptile data handling:**
  - named subprocessors;
  - retention periods and regions for reviews, KB documents, memory, embeddings and TREX logs;
  - ZDR coverage of the Together, GPT-6 Astra and Daybreak routes;
  - whether the de-identified training licence covers derived artifacts;
  - **whether any self-host or hosted job routes requests to a provider batch API.** The config declares batch-eligible patterns (`claude-*`, `gpt-4o*`, `gpt-5*`, `chatgpt-*`). The semantics of LiteLLM or Greptile-proxy `batch_settings` beyond the config file, and any job that uses them, are unverified.
- **Independent numbers:**
  - any score of shipped Greptile v5, or of Plus, Apex or Auto;
  - Greptile's ReviewBench row, if privately submitted;
  - Martian's live October numbers;
  - any independent latency measurement (Martian's speed-analysis output is not committed);
  - Kai's "September" date.
- **ZDR terms:**
  - OpenRouter's exact `zdr: true` failure body;
  - whether OpenAI extended caching is inside ZDR;
  - Google's Vertex ZDR prerequisites and the Gemini API logging period;
  - what OpenAI's `enhanced_*` retention types add;
  - Azure OpenAI and Together AI retention terms;
  - whether Bedrock's ZDR mode covers cache points.
- **Papers** (arXiv blocked; search extracts or recalled): AACR-Bench per-level tables, Kuaishou ICML 2025 slices, LongCodeBench context ranges, CodeFuse-CR-Bench Table 7, ContextBench per-agent F1, CRBugBench catch rates, Meta DRS and RADAR in full, arXiv 2607.21997, the Haiku-versus-Sonnet result (2606.15689), the exact wording of Gloaguen et al., and every item marked "recalled".
- **Community:** the Hacker News quotes behind GU13 (news.ycombinator.com unreachable). Also the title and date of gptme PR #4325, which may describe a fallback to gptme's own bot (the GitHub API was not enabled for that repository in this session).
- **Sources not searched**, because the WebSearch budget ran out in both the research and review passes: community security or procurement write-ups on Greptile; podcasts and talk transcripts by Greptile staff; Augment's review-agent internals; Graphite Agent's context gathering; Google's 2025 to 2026 Critique work.
- **ReviewBench per-repository licences** (absent from its manifest), and lvgl's licence at its PR commit.
- **Reproducibility:** every "our measurements" number, until the scripts are committed, and the numbers from non-D8 inputs until Q10 and Q26 are answered (see "How to read this").

**Spot-checked and confirmed during review** (no change needed):
- **Greptile:**
  - greploop SKILL.md v1.3: 5 iterations, "5/5 AND zero unresolved", "still resolve the thread".
  - npm `greptile` publish dates: 3.1.0 2026-06-11; 3.5.3 2026-09-18; 3.5.4 2026-09-22T01:36Z; 3.6.0 2026-09-25; 3.7.0 2026-10-18T00:02Z; 3.8.0 2026-10-26.
  - The 3.8.0 bundle's 3,000,000-byte cap, `--include` and `all-files-held-back`.
  - The MCP manifest text on persisted results, KB documents and persistent rules.
  - akupara: 16609f0 (2026-10-12; the title says v5.2, but the diff sets `greptile-v5.3@6`); f593b73 (2026-09-28); 8574fa3 (2026-07-26); 052ea78 (2026-06-29); the KB cron `17 0 * * *`; `KNOWLEDGE_BASE_MIN_REVIEW_COUNT=0`; "`greptile-v5.3@6` is considered better".
  - The merge gates: synnax PR #3208 merged 2026-10-09 (sole gate, 5/5); gptme PR #4322 merged 2026-10-14 (90 minutes counts as 5/5); code-graph-rag PR #3558 merged 2026-11-02.
- **Providers:**
  - @openrouter/ai-sdk-provider 2.9.0, published 2026-04-28.
  - Anthropic's feature-eligibility table: Batch "No", with 29-day retention. Agent Skills, the MCP connector, MCP tunnels, programmatic tool calling, code execution, the Files API, Managed Agents and message threads are all "No". Dynamic filtering for web fetch and web search is not ZDR-eligible.
  - OpenRouter `zdr.mdx`: Safety Retention covers any request and is allowed by default for self-serve accounts.
- **Benchmarks:**
  - ReviewBench at f223ce3: 219 PRs, 187 repositories, MIT, initial commit 2026-09-04. The scope recount and the context shares (58.3 / 35.8 / 5.9; high severity 78.5 / 13.8 / 7.7). METHODOLOGY "Scope is informational".
  - Martian: fbcff89 authored 2026-08-07; PR #54 merged 2026-08-26. The offline default F2, the online `F_BETA` 1.0 and `MAX_PR_CHANGED_LINES` 2000. Greptile v4.1 Opus F2 51.2 (P 50.9, R 51.3), 9th of 21.
  - Fletcher's figures.
- **Field tools:**
  - PR-Agent `structural_reach.py` at 6de02f5: the thresholds, the "projects only" comment and the band composition.
  - Kodus: `kodyFineTuning.service.ts` at 0a0435900 (0.6 thresholds, minimum 50, organisation-wide fallback, no severity exemption); a5bac4029; the heavy-recall README and `review_directive.mdx` figures.
  - github/docs `copilot-memory.md` at 17d6ee5.
  - tree-sitter PR #6038, merged 2026-10-20.
  - Qodo Cover unmaintained since 2025-06-15.
  - The bugbug README "more scrutiny" line.
  - The Zoekt boost and penalty of 5, with integer division.
- **VectorScope code** at 765ef4ec, unchanged at 7cadfcb8: the VT citations, `run.ts:222` (`VERIFY_STEPS = 10`), and the `transform.ts` `smallOptions` `store: false` branch, which covers the openai provider and the `@ai-sdk/openai` and `@ai-sdk/github-copilot` packages, not `@ai-sdk/azure` or Bedrock Mantle.

docs.github.com was checked through the github/docs clone instead.

---

## Sources

All accessed 2026-11-06 unless another date is given. Dates in parentheses are commit, publication or release dates. Under the naming rule, links whose URL or path names an open-source coding-agent CLI, harness or IDE coding assistant are cited by repository owner and commit, with the path withheld; the full links are in the round-two lane notes (addendum Q34).

**Greptile primary (code and vendor)**
- npm `greptile` 3.8.0 (2026-10-26), 3.7.0 (2026-10-17/18), 3.6.0 (2026-09-25), 3.5.4 (2026-09-21/22), 3.5.3 (2026-09-18), 3.1.0 (2026-06-11): https://registry.npmjs.org/greptile, https://registry.npmjs.org/greptile/-/greptile-3.8.0.tgz
- Bundled CLI: https://github.com/greptileai/skills/blob/59e79ec/plugins/greptile/scripts/greptile.mjs (2026-11-03)
- Skills: https://github.com/greptileai/skills/blob/59e79ec/skills/greploop/SKILL.md (v1.3, 2026-11-03); https://github.com/greptileai/skills/blob/59e79ec/skills/cli-review/SKILL.md; https://github.com/greptileai/skills/blob/main/plugins/greptile/README.md (2026-11-03). The plugin's ChatGPT app submission manifest (2026-10-22; `list_merge_request_comments`, `get_merge_request` and `search_greptile_comments` entries) and plugin manifest (2026-11-03) are cited as greptileai/skills at 59e79ec, under `plugins/greptile/`, with the subdirectory name withheld.
- CLI repository and releases: https://github.com/greptileai/cli (7ecf571, 2026-05-21); https://github.com/greptileai/cli/releases/tag/v3.5.4 (2026-09-21); …/v3.7.0 (2026-10-17); …/v3.8.0 (2026-10-26)
- Self-host: https://github.com/greptileai/akupara (09b7db2, 2026-11-04); RELEASE_NOTES_202610.5.md (2026-10-12); CHANGELOG.md (202609.10, 202610.5); docs/configuration/review-variants.md; docs/operations/scaling.md; docs/reference/architecture.md; deploy/docker-compose/llmproxy-config.yaml (`batch_settings.providers`, `stream_timeout`, `review` alias, at 09b7db2); deploy/docker-compose/.env.example
- akupara commits: 052ea78 (2026-06-29); f593b73 (2026-09-28, "Default reviews to the rsv11 native routing policy", #104); 662b412 (2026-06-29); 8574fa3 (2026-07-26); a40dc71 (2026-06-22); 16609f0 (2026-10-12, #106; sets `DEFAULT_NATIVE_ROUTING_POLICY=greptile-v5.3@6` and adds `v5.2-tiers@2` as a fallback); 5b92f02 (2026-10-12, "Release 202610.5", #112); de29212 (2026-09-28); 8688cd1 (2025-08-28); cff67df (2026-10-07/08); e1eba41 (2026-10-12); 91705a2 (2026-09-22); 496988f (2026-06-29); 1c2f43c (2026-10-22); 67a3c8c (2026-10-25); 3904840 (2026-05-08, "Update LLM proxy config for version v0.3.133"); 5199053 (2026-09-08); 9e29472 (2026-09-30)
- Greptile web pages, search extracts only (2026): https://www.greptile.com/docs/code-review/review-tiers; …/greptile-config; …/greptile-config-reference; …/auto-approve-prs; …/developer-essentials; …/tips-recipes; …/cross-repo-context; https://www.greptile.com/docs/troubleshooting/common-issues; https://www.greptile.com/docs/mcp-v2/auto-fix; https://www.greptile.com/docs/trex/environments; https://www.greptile.com/changelog; https://www.greptile.com/knowledge-base; https://www.greptile.com/blog/model-inversion (~2026-07-22); https://www.greptile.com/blog/automating-code-validation (~2026-06/07); https://www.greptile.com/content-library/greptile-martian-code-review-benchmark (2026-07-30)
- Real configurations: https://github.com/NVIDIA/Megatron-LM/blob/main/greptile.json (f1b38a8, 2026-11-05); https://github.com/debpalash/VoiceStudio/blob/main/greptile.json (c88bf70, 2026-11-06); https://github.com/hiloopai/piloop/tree/main/.greptile (71e1747, 2026-11-05); https://github.com/jdvivar/tanstack-router-scoped-trees/tree/main/.greptile (94d98db, 2026-10-28)
- Partner pages: https://claude.com/customers/greptile (undated, ~2026-01); OpenAI's Greptile case study on openai.com/index/ (2026-10-26, extract; the URL slug names OpenAI's coding agent, so it is withheld); https://www.together.ai/customers/greptile (~2026-08-31, extract)

**Independent benchmarks and data**
- Martian: https://github.com/withmartian/code-review-benchmark (e616e84, 2026-08-30; commits 4d32aaf 2026-08-05, 7740ae7 2026-03-17, 30e9f38 2026-03-18, 720e1d3 2026-03-19, fbcff89 2026-08-07, 2971440 2026-08-19, 58edbbe 2026-04-03; PR #54 merged 2026-08-26; branch f6f7aeb 2026-09-15). The offline default β and its "4x" comment are in `benchmark_dashboard.py`; the online ETL defaults `F_BETA` to 1.0.
- ReviewBench: https://github.com/review-bench/ReviewBench (f223ce3, 2026-11-05; initial commit 2276146, 2026-09-04); README producer table; `golden/*.json` `findings[].scope`; `docs/METHODOLOGY.md:241-246` and its section 4.2 note, at f223ce3 (recounted during revision)
- Fletcher: https://github.com/shahparshva72/fletcher-code-review-benchmark (bc9116b, 2026-10-17)
- AACR-Bench: https://github.com/alibaba/aacr-bench (ee9d7fe, 2026-10-15; `dataset/positive_samples.json`, 196 samples); OCR: https://github.com/alibaba/open-code-review (891df1b, 2026-11-05)
- CRBugBench: https://github.com/malusamayo/CRBugBench (e8e585e, 2026-10-07)
- SWE-bench runs: https://github.com/swe-bench/experiments (40f164d, 2026-09-03), the 2026-02-17 run of an open-source minimal agent harness with Claude 4.6 Opus under `evaluation/verified/` (directory name withheld)
- ApacheJIT: https://github.com/hosseinkshvrz/apachejit (ddfd547, 2022-01-28); Apache repositories: kafka 11e9247 (2026-11-05), groovy 8263945 (2026-11-06), zookeeper 87e85f2 (2026-11-04), zeppelin 0acbdf9 (2026-11-04)
- Measured repositories: torvalds/linux f66469d99; kubernetes/kubernetes 671745e4; microsoft/vscode 50bea175; getsentry/sentry 1de6398b; grafana/grafana 68df7b60; keycloak/keycloak 30cf6834; discourse/discourse c5652bb2 (all 2026-11-06; Linux, Sentry, Grafana and Discourse are subject to Q10 and Q26)
- ai-review-churn: https://github.com/abhaymettu/ai-review-churn (66ae483, 2026-11-01)
- Benchmark repository licences: https://raw.githubusercontent.com/ai-code-review-evaluation/cal.com-greptile/main/LICENSE; https://raw.githubusercontent.com/calcom/cal.com/master/LICENSE; https://raw.githubusercontent.com/getsentry/sentry/master/LICENSE.md
- Kai: https://kaicontext.com/benchmarks/code-review/ (2026, extract); Cubic: https://www.cubic.dev/blog/coderabbit-vs-greptile (2026-09-08, extract), https://www.cubic.dev/blog/greptile-alternatives (~2026-10-04, extract); https://www.aicodereviews.io/blog/martians-code-review-bench-the-1-claim-rots-in-months/ (~2026-10, extract); https://thenewstack.io/github-reviewbench-code-review/ (~2026-10); https://github.blog/ai-and-ml/github-copilot/reviewbench-an-open-benchmark-for-ai-code-review/ (~2026-10-05, extract)

**Community**
- https://github.com/synnaxlabs/synnax/pull/3131 (2026-10-02), …/pull/3208 (2026-10-09); https://github.com/gptme/gptme/pull/4322 (merged 2026-10-14); https://github.com/mylescorp/mylesnet-dashboard/pull/104 (2026); https://github.com/aetosdios27/Yen/pull/42 (2026); https://github.com/vitali87/code-graph-rag/pull/3558 (merged 2026-11-02); https://github.com/guilhermegor/dotfiles-linux-dev/issues/832 (2026); https://github.com/vfarcic/dot-agent-deck/issues/366 (2026); https://github.com/stablyai/orca/issues/38185 (2026); https://github.com/cloving-ai/cloving-ai/issues/239 (2026); https://github.com/Anthonyiwnl/tsek/pull/132 (2026-11-05)
- https://news.ycombinator.com/item?id=46766961 (~2026-01-26; unreachable during spot-checks); https://x.com/pkp_io/status/2117358762210349470 (2026-11-02); https://x.com/mg/status/2029751037716836478 (2026-03-06); https://x.com/imprakharshukla/status/2037127157340922031 (2026-03-26); https://x.com/addyosmani/status/2066595308629594363 (2026-06-15); https://dk.trustpilot.com/review/greptile.com (2026-10-10); https://dev.to/_vjk/best-ai-code-reviewer-in-2026-we-ran-4-in-parallel-for-3-weeks-146-prs-679-findings-1c0f (~2026-05); https://www.getpanto.ai/blog/coderabbit-vs-greptile-ai-code-review-tools-compared (2025); https://www.surmado.com/blog/best-greptile-alternatives-2026 (2026); https://finance.biggo.com/news/e0c502d3f5b75332 (2026); https://www.ai-redteam.com/insights/how-to-build-an-ai-code-review-agent-daksh-gupta-greptile/ (~2026-10)

**Industry code and docs**
- Zoekt: https://github.com/sourcegraph/zoekt/blob/a5a933b/index/score.go (2026-11-03; lines 265-266 and 416-424) and https://github.com/sourcegraph/zoekt/blob/a5a933b/index/file_category.go (lines 89-90)
- Sourcegraph's code-assistant public snapshot: sourcegraph, commit 8e20ac6 (2025-08-01; repository name withheld)
- Glean: https://github.com/facebookincubator/Glean/blob/main/glean/website/blog/2022-12-01-incremental.md (ce5a6ef, 2026-11-05)
- An open-source IDE coding assistant: continuedev, commit 5522c6f (2026-07-20; repository name withheld)
- Mozilla bugbug: https://github.com/mozilla/bugbug (7e8a342, 2026-11-05); PR-Agent: https://github.com/qodo-ai/pr-agent (6de02f5, 2026-11-05; `pr_agent/algo/structural_reach.py`); gitStream: https://github.com/linear-b/gitstream (5cd1030, 2026-08-30); CodeScene: https://github.com/codescene-oss/codescene-mcp-server (319762b, 2026-11-05); bugspots: https://github.com/igrigorik/bugspots (cf57488, 2018-08-23); PySZZ v2: https://github.com/grosa1/pyszz_v2 (6797158, 2023-08-25)
- Kodus: https://github.com/kodustech/kodus-ai (2ee5d32, 2026-11-05); commits a5bac4029 (2026-10-23, "remove fine-tuning and heavy mode"), 7d8cd3d1a (2026-09-15, "docs(learning): clarify inactive reaction-based fine-tuning"), 0a0435900 (2026-06-24), 8171bbb49 (2026-10-20), 5fe263734 (2026-11-03), merge 5e886f252 (2026-11-04, feat/heavy-mode-m3); files `libs/kodyFineTuning/infrastructure/adapters/services/kodyFineTuning.service.ts` at 0a0435900 (lines 45-47, 563, 576), `docs/en/how_to_use/code_review/review_directive.mdx` at 5fe263734, `evals/heavy-recall/README.md` at 2ee5d32
- GitHub docs: https://github.com/github/docs (17d6ee5, 2026-11-05; `content/copilot/concepts/prompting-and-context/copilot-memory.md`)
- CodeRabbit config library: https://github.com/coderabbitai/awesome-coderabbit (60b891c, 2026-09-29)
- The review rubric of OpenAI's open-source coding-agent CLI: OpenAI's open-source CLI repository, commit 5589742 (2026-11-06), review rubric template (path withheld)
- Anthropic security-review Action: https://github.com/anthropics/claude-code-security-review (0c6a49f, 2026-02-11); Qodo Cover: https://github.com/qodo-ai/qodo-cover (adcf55b, 2025-06-23)
- Vendor blogs, search extracts: https://cursor.com/blog/semsearch (2025-11); https://cursor.com/blog/secure-codebase-indexing (2026-01-27); https://cursor.com/blog/fast-regex-search (2026-03-23); https://www.augmentcode.com/blog/how-we-built-high-quality-ai-code-review-agent (2026-03); https://www.augmentcode.com/blog/context-engine-mcp-now-live (2026-02-06); https://www.augmentcode.com/blog/repo-scale-100M-line-codebase-quantized-vector-search (2025-06-11); https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews (2025-07); https://www.qodo.ai/blog/introducing-qodo-2-0/ (2026-02-05); https://www.uber.com/blog/ureview/ (2025-08); https://bito.ai/blog/swe-bench-pro-evaluation/ (2026); Sourcegraph's code-assistant FAQ on sourcegraph.com/docs (2026; path withheld)

**Provider terms (vendor)**
- Anthropic: https://platform.claude.com/docs/en/manage-claude/api-and-data-retention (feature-eligibility table, accessed 2026-11-06); https://platform.claude.com/docs/en/build-with-claude/prompt-caching; https://code.claude.com/docs/en/costs; https://code.claude.com/docs/en/prompt-caching
- OpenRouter docs mirror: https://github.com/OpenRouterTeam/docs (source-commit 3b6eafa; `response-caching.mdx` and `server-tools.mdx` also re-read on main during review): guides/features/zdr.mdx, guardrails.mdx, server-tools.mdx, response-caching.mdx, input-output-logging.mdx, guides/privacy/data-collection.mdx, guides/overview/auth/byok.mdx, api_reference/errors-and-debugging.mdx, openapi/openapi.yaml, changelog.mdx
- OpenRouter SDKs: @openrouter/sdk 1.5.60 (2026-11-06); @openrouter/ai-sdk-provider 2.9.0 (2026-04-28), https://registry.npmjs.org/@openrouter/ai-sdk-provider/-/ai-sdk-provider-2.9.0.tgz
- OpenAI: npm `openai` 7.52.0 (2026-11-05); https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml (spec 2.3.0; `prompt_cache_retention`, deprecated, and `prompt_cache_options.ttl`); https://github.com/openai/openai-cookbook/blob/main/examples/Prompt_Caching_201.ipynb (2026-02-18, archived)
- Google: https://cloud.google.com/terms/service-terms (last modified 2026-10-30); https://aiplatform.googleapis.com/$discovery/rest?version=v1 and v1beta1 (revision 20261027); https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta (revision 20261105); @google/genai 3.0.0; https://pypi.org/project/google-cloud-aiplatform/2.7.0/ (2026-10-28)
- AWS: https://pypi.org/project/botocore/1.43.125/ (2026-11-05); https://github.com/boto/botocore/blob/develop/CHANGELOG.rst (1.43.26, 2026-06-09; 1.43.89, 2026-09-04)
- Microsoft Foundry spec: https://github.com/Azure/azure-rest-api-specs/blob/main/specification/ai-foundry/data-plane/Foundry/openapi3/v1/microsoft-foundry-openapi3.yaml; together-ai npm 1.0.0

**Academic** (search extracts unless noted)
- arXiv 2607.01808 (Archer, 2026-07) with https://github.com/cuhk-s3/Archer (05b2fcf, 2026-10-02); 2607.03316 (2026-07-03); 2606.15689 (2026-06); 2607.24882 (Agent Retrieval Bench, README read) with https://github.com/eyuansu62/agent-retrieval-bench; 2608.13568 (2026-08); 2608.09290 (2026-08); 2601.19494 (AACR-Bench, 2026-01); 2505.07897 (LongCodeBench, 2025-05); 2403.10059 (Repoformer); 2503.20589 (2025-03); 2406.18294 (HCP, AAAI 2025); 2512.19481 (2025-12); 2602.05892 (ContextBench, 2026-02); 2406.04464 (2024-06); 2511.07017 (ContextCRBench, 2025-11); 2411.07091 (2024-11); 2602.11988 (2026); 2607.27250 (2026-07) with https://github.com/codeprakhar25/context-files-coding-agents; 2610.13668 (2026-10); 2603.23448 (2026-03); 2505.17928 (ICML 2025); 2509.14856 (2025-09); 2608.01507 (2026-08); 2609.00006 (2026); 2606.11864 (2026-06); 2605.30208 (RADAR, 2026-05); 2410.06351 (DRS, unreachable); 2408.05344 (Sourcegraph's code assistant, RecSys'24); 2411.10129 (2024-11); 2310.06770 (SWE-bench, 2023-10)
- https://trychroma.com/research/context-rot (2025-07-14); https://engineering.fb.com/2025/08/06/developer-tools/diff-risk-score-drs-ai-risk-aware-software-development-meta/ (2025-08-06)
- Recalled, not opened: Bosu, Greiler, Bird, MSR 2015; McIntosh et al., EMSE 2016; Lewis et al., ICSE 2013; Zimmermann et al., FSE 2009; Kamei et al., EMSE 2016; McIntosh and Kamei, TSE 2018; Rando and Tramèr, ICLR 2024; Sharma et al., 2023; Xiao et al., FSE 2024; Sun et al., arXiv 2508.18771

**This repository** (read-only)
- VectorScope worktrees at 765ef4ec, 13b9db02, 0f772e6e and HEAD 7cadfcb8 (2026-11-06): `packages/core/src/review/state.ts`, `prompt.ts`, `select.ts`, `plan.ts`, `redact.ts`, `types.ts`, `format.ts`, `config.ts`, `permission.ts`, `skip.ts`, `diff.ts`, `workflow.ts`, `eval.ts`; `packages/core/src/brain/brain.ts`, `scan.ts`, `code.ts`; `packages/engine/src/cli/cmd/github.review.ts`, `review.ts`, `github.handler.ts`; `packages/engine/src/provider/transform.ts`; `packages/engine/src/review/run.ts`, `context.ts`; `packages/engine/src/session/instruction.ts`, `session/tools.ts`; `packages/engine/src/tool/grep.ts`; `packages/app/src/features/pull-requests/ai-review.ts`; `script/vectorscope-eval/judging-rubric.md`; `docs/vector/build/vectorscope-plan.md` and `vectorscope-upgrade.md` on `origin/vectorscope`
