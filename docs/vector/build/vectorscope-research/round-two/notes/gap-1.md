# G1: Review quality and Tier 1 cost by repository size (round two)

Prepared 2026-11-06. This round extends REPORT.md §7 and the gaps labelled GU4, GU7, GU21 and LCI14. Evidence labels: **code** (read in source or data, or measured by us), **vendor**, **independent**, **academic**, **community**. "Measured" always means our own run in this session's scratchpad, described below so it can be repeated.

## 0. What could and could not be done

- **Reached:** github.com (git clones and HTML pages), the npm registry, and git's own source on GitHub.
- **Not reached:**
  - review-bench.ai (DNS refused by the session network policy);
  - github.blog (refused);
  - web.archive.org (the fetch tool cannot use it).
- After those failures I stopped trying new hosts, as the network policy says. So codereview.withmartian.com, lore.kernel.org, git-scm.com, ast-grep's site, YouTube and podcast hosts were not tried.
- **The shared web-search budget was used up before my first search.** No WebSearch call ran in this lane. All sources were reached by direct URL or by git clone.
- The GitHub REST API refuses repositories that are not attached to this session. Repository metadata came from git itself and from GitHub HTML pages.
- **Measurement machine:**
  - 4 vCPU Intel Xeon at 2.10 GHz, 15 GB RAM, Linux 6.18;
  - git 2.43.0, Node 22.23.4, web-tree-sitter **0.25.10** (the pinned version);
  - warm page cache (each repository had just been cloned), single-threaded parsing.
- Scripts are in `<session scratchpad>/g1/scripts/`:
  - `rb_strat.py` and `rb_fc.py` (ReviewBench strata);
  - `martian_repo.py` (Martian per-repo);
  - `grepbench.sh`, `parsebench.mjs` and `slicebench*.mjs` (VS-25 cost);
  - `deepnest.mjs`.

## 1. ReviewBench: what the repository holds, and why it cannot answer GU7 yet

Source: https://github.com/review-bench/ReviewBench, cloned at `f223ce3` (2026-11-05). Initial commit 2026-09-04. **code**

1. **There are no per-tool predictions or scores in the repository.** The folders are `corpus/`, `golden/`, `agents/`, `docs/`, `scripts/`, `schema/`, `tests/` and `examples/`. There is no `results/` or `runs/` folder, and no per-tool candidate files anywhere in the 128-commit history.
   - `golden/` holds 219 files with 4,632 labelled findings: 2,623 TP and 2,009 FP.
   - Every golden finding records a `producer`. The producers are LLM reviewers and a code-review system:
     - `llm_review:claude-sonnet-4.6` (1,206 TP);
     - `ccr:gpt-5.5[ReasoningEffort=medium]` (957 TP);
     - `ccr:claude-opus-4.7[ReasoningEffort=medium]` (228 TP);
     - gemini-2.5-pro and gpt-4o;
     - semgrep;
     - `human_review` (39 TP).
   - METHODOLOGY §5.5 says the `ccr` system "is not yet named". ReviewBench is built by GitHub, so it is plausibly GitHub's own reviewer (inference). No commercial review bot's output is part of the golden set.
2. **Greptile is not an onboarded agent.** `agents/` lists 27 manifests (self-service vendors and examples), and none is Greptile. A June 2026 Greptile run cannot be in this public repository, because the repository starts on 2026-09-04.
   - This **corrects the premise of GU7.** "Greptile's June 2026 run" most likely refers to Martian's pre-release v5 run of 2026-06-26, not to ReviewBench (inference).
   - Whether Greptile appears on the review-bench.ai leaderboard stayed unverified: the host is unreachable.
3. **The leaderboard cannot slice by repository size.** METHODOLOGY §7.4 lists three interactive filters: severity, category and review preference (β). §7.3 adds severity and category strata, and "scope, difficulty, context required … on demand". Repository size is not a documented axis (code, docs).
   - So even with access to the site, a per-size Greptile score would have to be recomputed from persisted findings. ReviewBench does not publish those.
   - The issue tracker (11 issues, fetched 2026-11-06) has nothing on repository size, slices or Greptile.
4. **Review duration is reported** as `review_ms` per PR, averaged per round (§7.5). It excludes "repository preparation". Any vendor's index-building time is therefore invisible in ReviewBench latency (code, docs).

### 1.1 How "large" ReviewBench's large slice is (code, our analysis)

- `corpus/manifest.json` records `repo_size_kb`, GitHub's repository size, which includes history. 36 of the 219 PRs come from repositories of 100 MB or more, which confirms round one's count. But:
  - **The 36 PRs come from only 21 repositories, and 10 of them from one** (konturio/disaster-ninja-fe, 613 MB, about 1,248 files at the PR head).
  - I fetched each repository's tree at a PR head (187 repositories, blobless, depth 1). By **file count**, ReviewBench repositories are small:
    - median 265 files, p75 856, p90 2,433, maximum 12,326;
    - only 6 PRs (4 repositories) have 10,000 files or more;
    - **none reaches 20,000.**
  - log(size) and log(files) correlate at 0.72. Some ">100 MB" repositories hold 19 to 451 files (large binaries or long history).
  - **PRs in the >100 MB slice are much smaller**: a median of 189 changed lines against about 800 elsewhere. Any comparison between slices mixes repository size with PR size.
- **Do large repositories need more context?** We compared golden TP labels between slices, with a bootstrap over repositories as clusters.
  - Share of TPs labelled `broader-project-context`: 10.7% in >100 MB repositories against 5.2% elsewhere. Difference +5.5 points, 95% CI −0.5 to +10.2. Without konturio, 8.7%.
  - `hard` difficulty: 15.0% against 8.3% (CI −0.5 to +12.9).
  - By file count (≥1,000 files against the rest), broader context is 7.3% against 5.5% (CI −2.2 to +6.1). Any non-diff-only context is 65.6% against 63.8%.
  - So **there is no robust evidence in ReviewBench's own labels that findings in larger repositories need more cross-file context.** There is a weak hint that a small extra share needs whole-project context.
- **Bottom line:** ReviewBench cannot test the owner's "large codebase" claim. Its "large" slice is mostly mid-size codebases dominated by one repository, and it has no 20k+-file repository at all.

## 2. Martian Code Review Bench: per-repository view (code, our analysis)

Source: https://github.com/withmartian/code-review-benchmark at `e616e84` (2026-08-30). This is still HEAD on 2026-11-06; the newer PRs #55–#71 are open and unmerged.

### 2.1 The online data cannot be stratified from public artifacts

- `online/` holds only the ETL and dashboard code. No per-PR rows are committed (code).
- PR #54, merged 2026-08-26 (https://github.com/withmartian/code-review-benchmark/pull/54), moved discovery from GH Archive to the GitHub Search API. Its description says the Archive source "was missing a large share of GitHub App review events". It adds no repository metadata and no data dump.
- The dashboard filters are language, domain, PR type, severity, **diff size**, engagement and sample controls (`online/README.md`). There is **no repository-size filter**, and the ETL records no repository size. It has only a `--min-stars` discovery option, and it skips PRs with more than 50 commits or 2,000 changed lines.
- So **task step 2 (Greptile's online precision and recall by repository size) is impossible from public data.** It would need Martian's database or a re-run of their ETL with a GitHub token and LLM budget, which is outside this lane's rules. **The online figures quoted in round one are not evidence about large codebases** (inference).

### 2.2 The offline set: five large repositories, ten PRs each

- The offline set is five repositories, all large. File counts at today's default-branch HEAD, from a depth-1 clone (an approximation of the size at PR time):

  | Repository | Files |
  |---|---|
  | cal.com | 7,710 |
  | Keycloak | 13,569 |
  | Sentry | 22,503 |
  | Grafana | 24,683 |
  | Discourse | 27,856 |

- Each tool reviewed **full-history mirror repositories**: the Keycloak mirror for one PR has 27,469 commits (https://github.com/code-review-benchmark/keycloak__keycloak__greptile-v4__PR37429__20260306, fetched 2026-11-06). Indexing tools such as Greptile therefore had to index a whole large repository for each run.
- Per-repository recall against the field mean (tools scored on all 173 goldens over 50 PRs: 21–25 per judge). Bootstrap over the ten PRs. Columns are Opus / Sonnet / GPT-5.2 judges:

  | Repository (files) | Greptile v4.1 R − field | v4.1 rank | v5 pre-release R − field |
  |---|---|---|---|
  | cal.com (7.7k) | +0.00 / +0.04 / +0.03 | 11/21, 8/25, 10/24 | +0.08 / +0.04 / +0.08 |
  | Keycloak (13.6k) | +0.04 / +0.07 / +0.04 | 7/21, 7/25, 7/24 | +0.01 / +0.04 / +0.04 |
  | Sentry (22.5k) | +0.01 / +0.02 / +0.01 | 12/21, 13/25, 12/24 | −0.10 / −0.07 / −0.10 |
  | Grafana (24.7k) | **+0.14 / +0.15 / +0.14**; CI excludes 0 for Sonnet and GPT-5.2 | 4/21, 5/25, 6/24 | −0.02 / +0.03 / +0.06 |
  | Discourse (27.9k) | +0.07 / +0.06 / +0.11 | 9/21, 11/25, 5/24 | −0.05 / −0.01 / +0.01 |

- Under Opus, Spearman ρ between file count and Greptile's advantage is +0.8 for v4.1 and −0.7 for the v5 pre-release. With n = 5 repositories, neither is meaningful, and the two versions point in opposite directions.
- Grafana is the only repository where v4.1 is clearly above the field. Martian's set grew out of Greptile's own 2025 benchmark, so familiarity cannot be ruled out (inference).
- The best tool on each repository is not Greptile: cubic-v2 on Grafana (R 0.88–0.96) and Sentry, and CodeRabbit or Copilot-v2 on cal.com, Keycloak and Discourse.
- **Conclusion:** among the five repositories, Martian's offline data give **no evidence that Greptile's advantage grows with repository size**. All five are large, so the set cannot compare large with small. This *confirms* GU21 (no independent per-size measure exists) and *extends* it: the one open dataset of large repositories shows Greptile mid-pack on four of five, and the v5 pre-release no better.

## 3. VS-25 cost on large repositories (code, measured)

The VS-25 contract asks for Tier 1 at p95 ≤ 5 s per case, using `git grep -l -w -F` on the *head tree-ish*, a cap of 200 files, import gating, and pinned web-tree-sitter 0.25.10 grammars. Round one measured only TypeScript on this repository (2,735 files in about 4.8 s on 0.27.1). I measured eight public repositories cloned on 2026-11-06:

| Repository | Commit | Files |
|---|---|---|
| torvalds/linux | f66469d99 | 97,360 |
| kubernetes/kubernetes | 671745e4 | 31,733 |
| discourse/discourse | c5652bb2 | 27,856 |
| grafana/grafana | 68df7b60 | 24,683 |
| getsentry/sentry | 1de6398b | 22,503 |
| microsoft/vscode | 50bea175 | 20,917 |
| keycloak/keycloak | 30cf6834 | 13,569 |
| calcom/cal.com | 2eb48ec | 7,710 |

### 3.1 git grep (median of three runs, warm cache, `-l -w -F` with one name)

| Repository (files) | Tree-ish `HEAD` | Working tree |
|---|---|---|
| linux (97k) | 2.9–3.2 s | 0.70–0.82 s |
| kubernetes (32k), shallow | 0.69–0.80 s | 0.30–0.33 s |
| kubernetes, full history (1.31 GiB pack, 1.84 M objects) | 0.89–0.97 s | — |
| vscode (21k) | 0.61–0.76 s | 0.24 s |
| grafana (25k) | 0.50–0.53 s | 0.18–0.20 s |
| sentry (22k) | 0.38–0.54 s | 0.13–0.20 s |
| keycloak (14k) | 0.23–0.24 s | 0.09–0.12 s |

- Grepping a tree-ish is **2.5–4× slower** than grepping the working tree, because each blob is inflated from the pack.
- Full history adds about 30% on Kubernetes (0.95 s against 0.75 s), and an old commit costs the same (0.91 s).
- Several names in one call cost about the same as one: Linux with 4 names took 3.3 s.
- On Linux:
  - `--threads=1` took 5.0 s and `--threads=4` 1.9 s; threaded object-store grep exists since git 2.26 (RelNotes 2.26.0).
  - Limiting the pathspec to `*.c *.h` gives 1.65 s; limiting it to two directories gives 0.10 s.

### 3.2 Partial clones and sparse checkouts are a trap

- In a blobless, sparse, depth-1 clone of Keycloak (git 2.43):
  - grepping the working tree for a directory outside the sparse cone **silently returned 0 files**, because the files were absent;
  - grepping the tree-ish for the same directory (21 files) took **9.3 s**, fetching blobs one at a time (about 440 ms per blob).
- git's own release notes describe both sides:
  - 2.49 added `git backfill` because lazy fetching "tends to be one-blob-at-a-time";
  - 2.55 notes that `git grep` in a lazy clone now fetches missing blobs in bulk (`Documentation/RelNotes/2.49.0.adoc`, `2.55.0.adoc`, git/git at `0ffa3e3`, 2026-11-04).
- So on older git, VS-25 in a partial clone either silently misses dependents (working tree) or blows its time budget (tree-ish).

### 3.3 tree-sitter 0.25.10 parse throughput (single-threaded; 4,000 sampled files per language; 1 MB input cap; trees deleted after each parse)

| Language, repository, grammar | Files/s | MB/s | p95 / p99 / max per file | Files with parse errors | RSS |
|---|---|---|---|---|---|
| Go, kubernetes, tree-sitter-go 0.25.0 | 606 | 5.8 | 5.3 / 18 / 210 ms | 1.1% | 155 MB |
| Go, same, @vscode/tree-sitter-wasm 0.3.1 | 583 | 5.6 | 5.9 / 19 / 181 ms | 1.1% | 154 MB |
| TS, vscode, @vscode | 408 | 5.4 | 7.2 / 21 / 264 ms | 0.1% | 163 MB |
| TSX, sentry, @vscode | 1,007 | 5.5 | 3.1 / 7.6 / 52 ms | 4.0% | 125 MB |
| Python, sentry, tree-sitter-python 0.25.0 | 661 | 5.5 | 5.1 / 12 / 290 ms | 0.03% | 153 MB |
| Java, keycloak, tree-sitter-java 0.23.5 | 1,263 | 7.4 | 2.8 / 7.1 / 19 ms | 0% | 109 MB |
| Ruby, discourse, @vscode | 1,213 | 4.2 | 2.6 / 7.1 / 36 ms | 0.03% | 107 MB |
| C (.c), linux, tree-sitter-c 0.24.1 | 260 | 4.9 | 13 / 29 / 94 ms | **69%** | 157 MB |
| C (.h), linux, same | 1,016 | 9.8 | 2.9 / 12 / 101 ms | 26% | 113 MB |

- All the per-language grammars in the table, and every @vscode grammar tried, loaded under 0.25.10. This confirms round one's advice to avoid `tree-sitter-wasms`.
- Throughput is a steady **4–10 MB/s**. That is consistent with round one's TypeScript figure (about 570 files/s), so 0.25.10 is not slower than 0.27.1 in any way that matters.
- **Parsing a whole large repository is out of budget:** about 30 s for Kubernetes's Go, about 38 s for vscode's TypeScript, and about 145 s for Linux's `.c` files (extrapolated). An approach that parses the whole repository, like an open-source coding-agent CLI's "repo map", cannot meet 5 s on such repositories. A targeted slice is required.
- **Kernel-style macro-heavy C** gives error trees in 69% of `.c` files. Definitions extracted from them need a lower confidence, or the regex fallback.
- A 200,000-deep nested TypeScript array parsed in 389 ms without crashing the parser. One identifier capture went missing at that depth (a silent miss, weak evidence).
- tree-sitter PR #6038 (merged 2026-10-20, https://github.com/tree-sitter/tree-sitter/pull/6038) bounds recursion on untrusted trees and queries. It notes that Wasm builds overflow sooner because of their small stack. 0.25.10 predates it.

### 3.4 End-to-end Tier 1 slice simulation

Per case:
1. parse the changed files;
2. extract definition names (exported names only, for Go and Python);
3. run one combined `git grep -l -w -F` on the tree-ish, limited to the language;
4. cap at 200 files;
5. read the candidates with one `git cat-file --batch`;
6. parse them;
7. collect the reference sites.

Up to 40 names per case.

| Case set | p50 | p95 | Max | Median candidates | Cases over the 200 cap |
|---|---|---|---|---|---|
| kubernetes, 40 real commits since 2025-11-01 (full history) | 2.5 s | 4.4 s | 5.2 s | 1,430 | 75% |
| vscode TS, 30 synthetic 6-file cases | 1.35 s | 3.8 s | 4.0 s | 105 | 33% |
| sentry Python | 0.49 s | 1.27 s | 1.32 s | 227 | 50% |
| keycloak Java | 0.64 s | 0.97 s | 1.0 s | 3,547 | 97% |
| **linux C** | **4.1 s** | **5.9 s** | **7.1 s** | 18 | 7% |
| linux C, working-tree grep | 2.0 s | 3.9 s | 4.5 s | — | — |
| vscode TS, working-tree grep | — | 3.3 s | — | — | — |

- Grep dominates on Linux (median 3.8 s). Parsing the candidates dominates on vscode at p95 (2.4 s).
- **The order of the cap and the import gate matters.** On the 40 Kubernetes commits I added the import gate: importers of the changed package's import path, plus files in the same package.
  - Gating cut the median candidate count from **1,430 to 20**; only 7% of cases still exceed 200.
  - If the 200 cap is applied to `git grep`'s output (which is in path order) *before* gating, as VS-25b step 2 currently reads, then:
    - **65% of cases lose import-gated dependents**;
    - the median loss is 16 of 20;
    - on average, 54% of the true dependents are lost.
  - Time with gating: p50 2.0 s, p95 4.9 s, maximum 5.6 s. The two greps dominate.
- **Reading blobs:** 200 separate `git show` calls cost 452 ms on Kubernetes, against 22 ms for one `git cat-file --batch`.

### 3.5 What this means for the VS-25 contract (inference from the measurements)

1. **p95 ≤ 5 s holds for repositories of 14k–32k files** (Kubernetes, vscode, Sentry, Keycloak) on 4 vCPU, but **not at Linux scale (97k files) with tree-ish grep**. Kubernetes with the import gate sits right at the line (p95 4.9 s).
   - Make the gate size-aware: report p95 by file-count band, and add a ≥50k-file case.
   - Or make grep adaptive: use the working tree when the head is checked out (local CLI and same-repo CI), limit the pathspec by language and package root, run grep in parallel with parsing the changed files, and stop at a time box. When the box is hit, say "impact incomplete" in the artifact, never fail silently.
2. **Rewrite VS-25b steps 2–3 so that the import gate (or a cheap import-path grep) runs before the 200-file cap**, then rank, then cap. Otherwise, on large repositories, the cap keeps alphabetically first files and drops about half of the true dependents. That would hurt exactly the "large codebase" recall the owner cares about.
3. **Read candidate blobs with one `git cat-file --batch` per case**, not one `git show` per file. This still honours I-8 (fork content read from the tree-ish, never checked out).
4. **Detect partial clones** (`extensions.partialClone` or `remote.*.promisor`) and sparse checkouts.
   - In those, prefetch in bulk (`git backfill` on git ≥ 2.49) or fall back to an explicit "impact incomplete" marker.
   - Never trust a working-tree grep there.
   - Record the git version in the artifact.
5. The per-file parse timeout can be generous: the measured maximum is about 300 ms. A 1 s timeout would never have fired in about 30,000 parses, and RSS stays under 170 MB with trees discarded.
6. For C (and probably C++ with macros), treat tree-sitter definitions as low-confidence and keep `changedSymbols` plus grep as a co-equal path.

## 4. Greptile's own stated limits for large repositories (vendor and code)

- **Greptile CLI** (npm `greptile@3.8.0`, published 2026-10-26; tarball read, not run):
  - a hard-coded payload cap of 3,000,000 bytes (`SO=3000000`) and a limit of 50 `.greptile` config files (`DO=50`); the error text says "this review is too large to send";
  - the CHANGELOG for 3.5.4 (2026-09-21) says `greptile review` "no longer refuses reviews that touch more than 500 files". So until September 2026 the CLI refused local reviews over 500 files (code plus vendor changelog);
  - the README says the "source will be opened later in beta" (https://github.com/greptileai/cli, `7ecf571`, 2026-05-21).
  - 3.7.0 (2026-10-17) added a "TREX" environment: a setup script, a network policy, a build, and "blockers TREX reported while testing pull requests". This is a new Greptile direction toward running PRs, relevant to VS-30 (vendor, code).
- **Self-host** (akupara `09b7db2`, 2026-11-04; unchanged since round one):
  - `docs/operations/scaling.md` lists `worker` at 2 CPU / 4 GiB and handling "up to two concurrent reviews", and `chunker` at 1 CPU / 2 GiB;
  - there is still no stated ceiling on repository size or file count (code).
- **Greptile org repositories** (https://github.com/orgs/greptileai/repositories, fetched 2026-11-06): many "demo copy of … for Greptile evaluation" mirrors of large projects (cline, celestia-core, onyx, ITK, NVIDIA Fuser), plus react, n8n and supabase mirrors updated in October–November 2026. These suggest Greptile evaluates on large public repositories internally. No results are published (inference).
- **Talks and podcasts by Greptile staff on monorepo indexing** (an AI Engineer 2026 talk, Latent Space, Software Engineering Daily) **could not be searched**: no search budget, and podcast hosts were not tried. Round one's "over an hour" to index big repositories (Hatchet case study, vendor) is still the only stated indexing-time figure.

## 5. Where this leaves the owner's "good for large codebases" claim

- **Quality.** No public dataset compares any reviewer, Greptile included, across repository sizes.
  - ReviewBench tops out at 12k files and publishes no per-tool outputs.
  - Martian online has no repository-size field and no public rows.
  - Martian offline is five large repositories with ten PRs each, where Greptile v4.1 is mid-pack on four.
  - So **the "no index needed" claim for VS-25 can be neither supported nor refuted from public data.** VectorScope needs its own large-repository slice, with cases from repositories of 20k+ files such as Kubernetes or vscode. Licences from memory, to verify for D8: Apache-2.0 and MIT. Linux is GPL-2.0, so internal diagnostics only.
  - Report recall by file-count band, with the cross-file label taken from the golden comment (AACR-Bench's context levels, or ReviewBench's `context_required`).
- **Cost.** The 5 s Tier 1 budget is realistic up to about 30k files with the fixes in §3.5. It is not realistic at Linux scale without working-tree grep, scoping, or an "incomplete" signal.
  - By contrast, Greptile's architecture front-loads a whole-repository index (chunk and embed): hours on big repositories (vendor) and fresh per mirror in Martian's offline runs.
  - VS-25's advantage is zero setup and per-PR cost that grows with the number of dependents, not with repository size. That is a latency and operations argument, not a demonstrated quality one.

## 6. Unreachable or not done

- review-bench.ai leaderboard: Greptile's presence and any per-slice table.
- GitHub blog post of about 2026-10-05.
- Martian online per-PR data. The repository has none, and codereview.withmartian.com was not tried.
- git mailing-list threads on grep performance, Scalar figures on git-scm.com, ast-grep benchmark pages, and GitHub's stack-graphs and code-navigation posts on github.blog.
- Talks and podcasts by Greptile staff.
- No WebSearch was available in this lane.
- The VectorScope pipeline itself was not run: the worktree is read-only for this lane. Every VS-25 figure here comes from a stand-alone simulation, not the real `review/impact.ts`.
