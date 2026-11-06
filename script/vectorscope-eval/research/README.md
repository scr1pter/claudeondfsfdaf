# VectorScope round-two research scripts

The scripts behind the "our measurements" numbers of VectorScope research round
two (`docs/vector/build/vectorscope-research/round-two/REPORT.md` and its lane
notes), copied here from the session scratchpad by VS-21d (addendum A §3,
VS-21 "Reproducibility"). Only scripts whose inputs are D8-clean today are
here. The rest stay uncommitted and are listed under "Gated" below, with the
rows of committed timing scripts that were measured on gated repositories.

- **Internal diagnostics only (D12).** The numbers support design decisions,
  not public claims. This README names finding IDs (for example [G1-10] or
  [RP3]) instead of restating results; it quotes a count only where that is
  needed to say which script covers which figure. The results stay in the
  report and the notes.
- **Status.** Addendum A is a proposal pending owner question Q18, and VS-21
  is pending Q15. Committing these scripts decides neither, and no runner,
  package, test or workflow reads this folder.

## Rules

- **Outputs and clones go under `/tmp/vector-vectorscope/research/`**, never
  inside the repository. The scripts that write files refuse a path inside
  this checkout (`--out`, `OUT_DIR`, `SCRATCH_DIR`), as `ci.ts` refuses
  `EVAL_OUT_DIR` there, and `.gitignore` here stops a stray result from being
  staged.
- **Never commit results or inputs** (CSV, TSV, JSON, logs, numstats; I-13).
- **Never run a script on Linux, Grafana, Sentry, Discourse, Martian's goldens
  or ReviewBench corpus repositories** until Q10, Q26 and VS-22's
  per-repository licence check allow it. The timing scripts accept any
  repository path; that restriction is a rule, not a check.
- **No script calls a model or a paid API.** The only network use is the
  `git` fetches, the two `raw.githubusercontent.com` downloads and the npm
  install named under "Inputs".
- **Not part of the eval tooling.** No TypeScript lives here. The eval
  tsconfig's `include` (`*.ts`) does not recurse, `test.yml` runs only
  `script/vectorscope-eval/*.test.ts`, `vectorscope-eval.yml` runs only
  `ci.ts` and `dataset.ts`, and prettier and oxlint skip this folder
  (`.prettierignore`, `.oxlintrc.json`).
- **Copies stay close to the session originals**, so each number traces to
  the code that printed it. Each file's header names its origin and lists its
  changes. Changes are limited to I/O (explicit arguments in place of
  scratchpad, working-directory and `/tmp` paths), usage guards, pinned
  commits and the fixes listed per script. The code is not restyled.

## Runtime used in round two

- `python3 -I` (CPython 3.13.18) with numpy 2.5.3 from the system
  site-packages. `-I` keeps the working directory and the script's folder off
  `sys.path`, so shared helpers load by path with `runpy.run_path`.
- Node 22.23.4 for the `.mjs` files, git 2.43.0, and bash with GNU coreutils
  (`realpath -m`, `date +%s%N`).
- 4 vCPU Intel Xeon at 2.10 GHz, 15 GB RAM, Linux 6.18, warm page cache. The
  timings depend on this machine; compare like with like.

## Inputs

Each input is named by URL and pinned commit. `W=/tmp/vector-vectorscope/research`
in the commands below.

| Input | URL and pin | Licence | Shape and fetch | Used by |
|---|---|---|---|---|
| ApacheJIT | https://github.com/hosseinkshvrz/apachejit at `ddfd547ff8e3d3725f6a1fd0f177c0ebe085a4b5` | **No LICENSE file at that commit** (open item, see the VS-21d deviations entry) | One file, `dataset/apachejit_total.csv` (git blob `3e53da7be875ef6f06982bbc458a7a2257f20368`, sha256 `5097cbbbab8c4611a709b3cf95ac5c9fe5f62e619bab081911a2a247ddbed4e0`), from `https://raw.githubusercontent.com/hosseinkshvrz/apachejit/ddfd547ff8e3d3725f6a1fd0f177c0ebe085a4b5/dataset/apachejit_total.csv` | `jit*.py`, `pts.py`, `pp.py`, `hist*.py`, `selffix.py`, `sens.py` |
| apache/kafka, apache/groovy, apache/zookeeper, apache/zeppelin | https://github.com/apache/kafka (and so on) at the `APACHE_REVS` in `jitlib.py`: kafka `11e9247aca883c49f1b225000c1148a188c98269`, groovy `826394513c2ba1723248a04aca337ccf426cca25`, zookeeper `87e85f28e72384c9e5a1cf089b6e21b2533970c7`, zeppelin `0acbdf9630276d66cbcf1dae97cd50cef9b70646` | Apache-2.0 | Bare `--filter=blob:none` clones named `kafka.git` and so on in one folder. Never `--filter=tree:0` for these: `git log --name-only` would then fetch trees one at a time. The scripts walk the pinned commit, so a newer clone works and a clone without it fails | `hist.py`, `hist2.py`, `hist_rev.py`, `selffix.py`, `sens.py` |
| kubernetes/kubernetes | https://github.com/kubernetes/kubernetes at `671745e4ffcf3ee0110f6446ef3b5f032db2c51c` | Apache-2.0 | (a) a depth-1 checkout at that commit, for grep and parse; (b) a full, unfiltered bare clone (about 1.3 GiB) with `HEAD` pinned to it, for the slice runs, the gate and the full-history grep row | `grepbench.sh`, `parsebench.mjs`, `slicebench.mjs`, `slicebench_gate.mjs` |
| microsoft/vscode | https://github.com/microsoft/vscode at `50bea175f4aa226ab18f45b2837a9112fd2861c8` | MIT | A depth-1 checkout. The slice scripts take its `.git` as `GIT_DIR`; the working-tree variant greps the checkout itself | `grepbench.sh`, `parsebench.mjs`, `slicebench.mjs`, `slicebench_wt.mjs` |
| keycloak/keycloak | https://github.com/keycloak/keycloak at `30cf683465a1ddf7151462d7f480d6d17f986844` | Apache-2.0 | A depth-1 checkout | `grepbench.sh`, `parsebench.mjs`, `slicebench.mjs` |
| AACR-Bench | https://github.com/alibaba/aacr-bench at `ee9d7fef70ef31acea2ff7ae316ce0a9575fe4df` | Apache-2.0 (the dataset repository) | One file, `dataset/positive_samples.json` (git blob `053adcb264857b13e62d62d5d223341cbb09ec97`, sha256 `02c8561f1c3994a26f427d479b2a3f6e6c8e6858161fbc903b45248fa2cb2097`), from `https://raw.githubusercontent.com/alibaba/aacr-bench/ee9d7fef70ef31acea2ff7ae316ce0a9575fe4df/dataset/positive_samples.json` | `aacr_jobs.py`, `aacr.py` |
| The AACR permissive PRs | Each PR's repository URL, base and head SHAs are one row of `aacr_jobs.py`'s output, derived from the pinned `positive_samples.json` | Per repository, by VOI13's check at HEAD and at each repository's first dataset PR commit (lvgl at HEAD only). The per-PR check is pending in VS-22, and Q31 is open | A temporary `--filter=tree:0 --shallow-since` fetch of the two SHAs per PR (removed after `git diff --numstat`); no checkout, no code kept | `aacr2.sh` |
| npm grammars | `web-tree-sitter@0.25.10`, `tree-sitter-go@0.25.0`, `tree-sitter-java@0.23.5`, `@vscode/tree-sitter-wasm@0.3.1` | MIT | Installed into `$W/ts` with `--ignore-scripts` (table below) | `deepnest.mjs`, `parsebench.mjs`, `slicebench*.mjs` |

- The AACR repositories are named only through the pinned dataset and
  `aacr_jobs.py`'s output. Some of the 40 permissive repositories are
  open-source coding-agent CLIs, which the research rule refers to generically
  until Q34 is answered. `aacr_jobs.NONPERM` lists the 10 repositories VOI13
  classified as not permissive. VOI13's licence fetch is not committed (see
  "Gated"), so that list is its outcome and cannot be re-derived from this
  folder until VS-22's per-PR check.
- The npm lock of the session (sha512 integrity, npm `package-lock.json`):

  | Package | Version | Integrity | Needed for |
  |---|---|---|---|
  | web-tree-sitter | 0.25.10 | `sha512-Y09sF44/13XvgVKgO2cNDw5rGk6s26MgoZPXLESvMXeefBf7i6/73eFurre0IsTW6E14Y0ArIzhUMmjoc7xyzA==` | every `.mjs` |
  | @vscode/tree-sitter-wasm | 0.3.1 | `sha512-RJFoomET6FajjG511fmQxeBQfU6M24a0aFZPqpid+ttIxanWf1VGytBG0UmsGjt07qmIPJS8U31D+aecuCucsQ==` | TypeScript (vscode), the second Go row, `deepnest.mjs` |
  | tree-sitter-go | 0.25.0 | `sha512-APBc/Dq3xz/e35Xpkhb1blu5UgW+2E3RyGWawZSCNcbGwa7jhSQPS8KsUupuzBla8PCo8+lz9W/JDJjmfRa2tw==` | Go (Kubernetes) |
  | tree-sitter-java | 0.23.5 | `sha512-Yju7oQ0Xx7GcUT01mUglPP+bYfvqjNCGdxqigTnew9nLGoII42PNVP3bHrYeMxswiCRM0yubWmN5qk+zsg0zMA==` | Java (Keycloak) |
  | node-addon-api | 8.9.2 | `sha512-VijLXbi3UACN69I0JVXJsX4tjACjNoQDgv2gTF6sx2wWEi8tkSg2eX8p5gSIFi8z2+DL3oHmY6OyKce38SDolg==` | transitive (native grammar bindings, unused with `--ignore-scripts`) |
  | node-gyp-build | 4.8.4 | `sha512-LA4ZjwlnUblHVgq0oBF3Jl/6h/Nvs5fzBLwdEF4nuxnFdsfajde4WfxtJr3CaiH+F6ewcIB/q4jQ4UzPyid+CQ==` | transitive, as above |
  | tree-sitter-python | 0.25.0 | `sha512-eCmJx6zQa35GxaCtQD+wXHOhYqBxEL+bp71W/s3fcDMu06MrtzkVXR437dRrCrbrDbyLuUDJpAgycs7ncngLXw==` | only the `py` slice language, used in round two on Sentry (gated); not needed for the D8-clean rows |
  | tree-sitter-c | 0.24.1 | `sha512-lkYwWN3SRecpvaeqmFKkuPNR3ZbtnvHU+4XAEEkJdrp3JfSp2pBrhXOtvfsENUneye76g889Y0ddF2DM0gEDpA==` | only the `c` slice language, used in round two on Linux (gated); not needed |
  | tree-sitter-typescript, tree-sitter-javascript | 0.23.2, 0.23.1 | in the session lock, unused by these scripts | not needed |

  The run block below checks, right after `npm install`, that the
  `integrity` fields of `$W/ts/package-lock.json` match this table for the
  four packages the scripts load. The transitive `node-addon-api` and
  `node-gyp-build` are not checked: their ranges may resolve to newer
  versions, and nothing loads them under `--ignore-scripts`. Whether the npm
  tarballs ship the `.wasm` files with `--ignore-scripts` was not re-checked
  in VS-21d.

## Scripts

Finding IDs refer to REPORT.md; "risk note" is `notes/risk-prediction.md`,
"gap-1" and "gap-2" are `notes/gap-1.md` and `notes/gap-2.md`. Origins are
folders of the round-two session scratchpad. Every Python file runs with
`python3 -I`, and every runnable one (all but the four helpers) has `--help`;
every `.mjs` runs with `node` and every `.sh` with `bash`, each with
`--help`. A missing or malformed argument exits 2.

| Script | Origin | Backs | Inputs | Changes from the session copy |
|---|---|---|---|---|
| `jitlib.py` | `scripts/` (`rpverify/` copy identical) | helper: `auc` (rank AUC, ties averaged) and `APACHE_REVS` | none | `APACHE_REVS` added |
| `jit.py` | `scripts/` | RP3 (13 Kamei-style features, lines added alone), RP6 (per-project positive rates), RP13 (leave-one-project-out against within-project, and the project that collapsed), RP14 (density against raw ordering at 20% of changed lines); risk note §6-7 | ApacheJIT | argparse |
| `jit2.py` | `scripts/` | RP6 (commits that add no lines), RP12 (the lift tables, risk note §8), the fixed points' per-project AUC (risk note §6), the diff-only points AUC | ApacheJIT | argparse; `runpy` for `jitlib.py` |
| `jit3.py` | `scripts/` | risk note §1 item 2 (the increment of each history and experience feature over diff-only), RP5 (the high band's share of changed lines), the repository-relative 50/90 cutpoints (risk note §8, RP13) | ApacheJIT | argparse; `runpy` |
| `pts.py` | `scripts/` | RP12 (points 0-7: shares, rates, AUC), RP4 (diff-only and diff-plus-churn bands agree; never differ by more than one), RP5 and risk note §8 (diff-plus-churn points; the high band's share of changed lines) | ApacheJIT | argparse; `runpy` |
| `pp.py` | `rpverify/` | RP12 (band rates in the earlier, training years); the verification pass's per-project AUC of the fixed points; gap-2 §1.1 cites it for the points definition | ApacheJIT | argparse; `runpy` |
| `hist.py` | `scripts/` | RP4 and RP10, through `hist_eval.py` | ApacheJIT, the four Apache clones | argparse; `--out` in place of `./hist_features.csv`; walks `APACHE_REVS[name]` (was `HEAD`) with `check=True`, so a clone without the pinned commit fails instead of matching 0 commits; git's stderr is no longer captured; `jitlib.py` loaded for `APACHE_REVS` only (the session's exec of it was unused) |
| `hist2.py` | `scripts/` | RP7, through `hist_eval2.py` | as `hist.py` | as `hist.py` (was `./hist_features2.csv`) |
| `hist_rev.py` | `scripts/` | RP19, through `hist_eval.py` | as `hist.py` | as `hist.py` (was `./hist_revert.csv`) |
| `hist_eval.py` | `scripts/` | on `hist.py`'s CSV: RP4 (each feature added to diff-only) and RP10 (the decay score); on `hist_rev.py`'s CSV: RP19. There the `fix*` columns hold revert counts, and RP19's AUC is the `fixlast5` row (the `fixd90` row differs in the third decimal) | a features CSV | argparse (the CSV was the fixed `./hist_features.csv`); `runpy` |
| `hist_eval2.py` | `scripts/` | RP7 (source and tests within size buckets; the substring sensitive flag) | `hist2.py`'s CSV | argparse (was `./hist_features2.csv`); `runpy` |
| `selffix.py` | `rpverify/` | RP15, the refutation (ApacheJIT's `fix` column against a fix regex on commit subjects) | ApacheJIT, the four Apache clones | argparse; `runpy`; pinned revs with `check=True` |
| `sens.py` | `rpverify/` | RP7 (the word-level sensitive-path flag) | as `selffix.py` | as `selffix.py` |
| `deepnest.mjs` | `g1/scripts/` | G1-15 | the npm grammars only (synthetic input) | argument guard before any `require`; `NODE_MODULES` resolved to an absolute path (`createRequire` refuses a relative one) |
| `grepbench.sh` | `g1/scripts/` | G1-7: the Kubernetes shallow and full-history rows, vscode and Keycloak (its other rows are gated, see "Gated") | a checkout or bare clone | `SCRATCH_DIR` argument; its temporary file is `mktemp`'d there before the `cd` and removed on exit (was the loose `/tmp/gb.out`); usage guard; `-e` before each name in the per-name loop, as the combined row already had, so a name starting with `-` is not read as an option |
| `parsebench.mjs` | `g1/scripts/` | G1-8: the Go (both grammars), TypeScript and Java rows, and the whole-repository parse estimates for Kubernetes and vscode (its other rows are gated) | a checkout, the npm grammars | argument guard (`MAX_FILES` a positive integer); `NODE_MODULES` resolved |
| `slicebench.mjs` | `g1/scripts/` | G1-9: the Kubernetes, vscode and Keycloak rows (its other rows are gated) | a git directory, the npm grammars | argument guard: the language table moved above `createRequire`, `LANG` checked with `Object.hasOwn`, `MODE` `commits` or `synthetic` (anything else used to mean synthetic), `CASES` and `FILES_PER_CASE` positive integers; `NODE_MODULES` resolved |
| `slicebench_wt.mjs` | `g1/scripts/` | G1-9: the vscode working-tree row (the Linux one is gated) | the `.git` of a checkout | as `slicebench.mjs`; the usage line names this file |
| `slicebench_gate.mjs` | `g1/scripts/` | G1-10 | the full Kubernetes clone | as `slicebench.mjs`, and `LANG` must be `go` (the gate builds `k8s.io` import paths); the usage line names this file |
| `stats.py` | `g2/bin/` | helper: `rank` and `spearmanr` (permutation p-value, fixed seed) | none | header only |
| `feat.py` | `g2/bin/` | helper: `feats`, the diff-only points and band from a numstat (gap-2 §1.1) | none | only `feats` and its regexes kept; the main block, which read the gated job list, is gated (below) |
| `aacr_jobs.py` | new | the AACR job list: one row per permissive positive sample (key `aacr_` plus 10 hex of md5 of the PR URL; repository URL; base `source_commit`; head `target_commit`; `--shallow-since` 120 days before `created_at`) | `positive_samples.json` | new: rebuilt from the session's `jobs.py` AACR rows and its ad hoc job list (`g2/aacr2s.tsv`), which it reproduces row for row for the 140 permissive samples in 40 repositories; holds `NONPERM` (moved from `aacr.py`); exits 1 naming the sample when a `githubPrUrl` is not exactly `https://github.com/OWNER/REPO/pull/N` (letters, digits, `_`, `.` and `-` in the names) or a permissive sample's `source_commit` or `target_commit` is not a 40-hex SHA, so no field can shift a TSV column or reach `aacr2.sh` as an option |
| `aacr2.sh` | `g2/bin/` | the AACR numstats behind G2-1, G2-2 and gap-2 §2.1-2.2 | one job row | `OUT_DIR` argument (was a scratchpad path), made absolute before any `cd`, refused inside the repository; `numstat/` and `git/` created; `cd "$G"` quoted; `KEY` must be `aacr_` and 10 hex digits, the only form `aacr_jobs.py` writes (it names a folder that is removed); `URL` must be `https://github.com/OWNER/REPO`, `BASE` and `HEAD` 40-hex SHAs and `SINCE` a `YYYY-MM-DD` date, each exiting 2 otherwise; `--end-of-options` before the repository and revisions of `git fetch`, `git merge-base` and `git diff`; usage guard. It never checks out the fetched code |
| `aacr.py` | `g2/bin/` | G2-1 (the AACR band shares of PRs), G2-2 (AACR Spearman, overall and within size terciles), gap-2 §2.2's AACR table (golden comments per PR and per kLOC; `--defect` gives the bracketed Code Defect figures), and the validation line against `change_line_count` for the permissive PRs | `positive_samples.json`, the job list, `OUT_DIR/numstat` | argparse; `runpy` for `stats.py` and `feat.py` (was an exec with string surgery on `feat.py`); reads only the PRs in the job list; the unused per-PR licence-text parse (`aacr_lic_at_pr.txt`) and the "all" section are removed, so it never reads a non-permissive numstat. Its validation and comment-key lines now cover the permissive PRs (131 in round two) instead of all fetched positives, and its permissive section prints as before |
| `outguard.py` | new | helper: `outside_repo`, the repository check for `--out` | none | new |

## How to run

Save the block below as a file outside the repository, fill in `NAME...` and
`CASES`, and run it with `bash FILE` from the repository root. To run one
section alone, keep the block's first two lines with it. `set -euo pipefail`
stops the run at the first failure, so nothing runs on a download whose
checksum or npm integrity check failed. Pasted into an interactive shell,
`set -e` would close the shell instead. These fetch public data; none of it
is run in CI.

```
set -euo pipefail
R=script/vectorscope-eval/research W=/tmp/vector-vectorscope/research
mkdir -p "$W"
# ApacheJIT models (RP3-RP14)
curl -sSfL -o "$W/apachejit_total.csv" https://raw.githubusercontent.com/hosseinkshvrz/apachejit/ddfd547ff8e3d3725f6a1fd0f177c0ebe085a4b5/dataset/apachejit_total.csv
echo "5097cbbbab8c4611a709b3cf95ac5c9fe5f62e619bab081911a2a247ddbed4e0  $W/apachejit_total.csv" | sha256sum -c
for s in jit jit2 jit3 pts pp; do python3 -I "$R/$s.py" "$W/apachejit_total.csv"; done

# History features on the four Apache repositories (RP4, RP7, RP10, RP15, RP19)
for r in kafka groovy zookeeper zeppelin; do git clone -q --bare --filter=blob:none "https://github.com/apache/$r.git" "$W/repos/$r.git"; done
python3 -I "$R/hist.py" "$W/apachejit_total.csv" "$W/repos" --out "$W/hist_features.csv"
python3 -I "$R/hist_eval.py" "$W/hist_features.csv"
python3 -I "$R/hist2.py" "$W/apachejit_total.csv" "$W/repos" --out "$W/hist_features2.csv"
python3 -I "$R/hist_eval2.py" "$W/hist_features2.csv"
python3 -I "$R/hist_rev.py" "$W/apachejit_total.csv" "$W/repos" --out "$W/hist_revert.csv"
python3 -I "$R/hist_eval.py" "$W/hist_revert.csv"
python3 -I "$R/selffix.py" "$W/apachejit_total.csv" "$W/repos"
python3 -I "$R/sens.py" "$W/apachejit_total.csv" "$W/repos"

# Tier 1 timings (G1-7 to G1-10, G1-15)
npm install --prefix "$W/ts" --ignore-scripts --save-exact web-tree-sitter@0.25.10 tree-sitter-go@0.25.0 tree-sitter-java@0.23.5 @vscode/tree-sitter-wasm@0.3.1
# the integrity of the four packages the scripts load, against the session lock (table above); exits 1 naming any mismatch
python3 -I -c 'import json, sys; got = json.load(open(sys.argv[1]))["packages"]; bad = [n for n, i in (a.split("=", 1) for a in sys.argv[2:]) if got.get("node_modules/" + n, {}).get("integrity") != i]; sys.exit("integrity mismatch: " + " ".join(bad) if bad else None)' "$W/ts/package-lock.json" \
  web-tree-sitter=sha512-Y09sF44/13XvgVKgO2cNDw5rGk6s26MgoZPXLESvMXeefBf7i6/73eFurre0IsTW6E14Y0ArIzhUMmjoc7xyzA== \
  tree-sitter-go=sha512-APBc/Dq3xz/e35Xpkhb1blu5UgW+2E3RyGWawZSCNcbGwa7jhSQPS8KsUupuzBla8PCo8+lz9W/JDJjmfRa2tw== \
  tree-sitter-java=sha512-Yju7oQ0Xx7GcUT01mUglPP+bYfvqjNCGdxqigTnew9nLGoII42PNVP3bHrYeMxswiCRM0yubWmN5qk+zsg0zMA== \
  @vscode/tree-sitter-wasm=sha512-RJFoomET6FajjG511fmQxeBQfU6M24a0aFZPqpid+ttIxanWf1VGytBG0UmsGjt07qmIPJS8U31D+aecuCucsQ==
for x in kubernetes/kubernetes:671745e4ffcf3ee0110f6446ef3b5f032db2c51c microsoft/vscode:50bea175f4aa226ab18f45b2837a9112fd2861c8 keycloak/keycloak:30cf683465a1ddf7151462d7f480d6d17f986844; do
  d="$W/$(basename "${x%%:*}")"; git init -q "$d"
  git -C "$d" fetch -q --depth 1 "https://github.com/${x%%:*}" "${x##*:}"
  git -C "$d" checkout -q --detach FETCH_HEAD
done
git clone -q --bare https://github.com/kubernetes/kubernetes "$W/k8s-full.git"
git -C "$W/k8s-full.git" update-ref --no-deref HEAD 671745e4ffcf3ee0110f6446ef3b5f032db2c51c
NM="$W/ts/node_modules"
node "$R/deepnest.mjs" "$NM"
bash "$R/grepbench.sh" "$W" "$W/kubernetes" NAME...        # also "$W/vscode" and "$W/keycloak"
bash "$R/grepbench.sh" "$W" "$W/k8s-full.git" NAME...      # bare clone: only treeish_ms is meaningful; ignore worktree_ms
node "$R/parsebench.mjs" "$NM" "$W/kubernetes" .go tree-sitter-go/tree-sitter-go.wasm 4000
node "$R/parsebench.mjs" "$NM" "$W/kubernetes" .go @vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm 4000
node "$R/parsebench.mjs" "$NM" "$W/vscode" .ts @vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm 4000
node "$R/parsebench.mjs" "$NM" "$W/keycloak" .java tree-sitter-java/tree-sitter-java.wasm 4000
node "$R/slicebench.mjs" "$NM" "$W/k8s-full.git" go commits 40
node "$R/slicebench.mjs" "$NM" "$W/vscode/.git" ts synthetic 30 6
node "$R/slicebench.mjs" "$NM" "$W/keycloak/.git" java synthetic CASES
node "$R/slicebench_wt.mjs" "$NM" "$W/vscode/.git" ts synthetic 30 6
node "$R/slicebench_gate.mjs" "$NM" "$W/k8s-full.git" go commits 40

# AACR-Bench permissive subset (G2-1, G2-2, gap-2 §2.1-2.2)
mkdir -p "$W/aacr"
curl -sSfL -o "$W/aacr/positive_samples.json" https://raw.githubusercontent.com/alibaba/aacr-bench/ee9d7fef70ef31acea2ff7ae316ce0a9575fe4df/dataset/positive_samples.json
echo "02c8561f1c3994a26f427d479b2a3f6e6c8e6858161fbc903b45248fa2cb2097  $W/aacr/positive_samples.json" | sha256sum -c
python3 -I "$R/aacr_jobs.py" "$W/aacr/positive_samples.json" --out "$W/aacr/jobs.tsv"
# exit 1 is a PR that could not be fetched or diffed (in round two, SHAs GitHub no longer serves; see numstat/KEY.numstat.err) and is skipped; exit 2, a malformed row, stops the run
while IFS=$'\t' read -r key url base head since; do
  bash "$R/aacr2.sh" "$W/aacr" "$key" "$url" "$base" "$head" "$since" < /dev/null || [ $? -eq 1 ]
done < "$W/aacr/jobs.tsv"
python3 -I "$R/aacr.py" "$W/aacr/positive_samples.json" "$W/aacr/jobs.tsv" "$W/aacr/numstat"
python3 -I "$R/aacr.py" "$W/aacr/positive_samples.json" "$W/aacr/jobs.tsv" "$W/aacr/numstat" --defect
```

What round two did not record, so a rerun cannot match it exactly:

- **grepbench's names.** gap-1 says "one name" per row and "4 names" for the
  combined Linux row, but not which names. Pick exported identifiers of the
  repository and report them.
- **Keycloak's slice parameters.** The mode is inferred: the session's
  Keycloak clone was depth-1, so `commits` could produce at most one case,
  which leaves `synthetic`. The case count was not recorded.
- **The working-tree vscode row's parameters** were not recorded either. The
  tree-ish row's `ts synthetic 30 6` is the likely choice (the cases depend
  only on the tree and the fixed seed).
- **The vscode parse row's extension list** is inferred from the table's "TS"
  label as `.ts`.
- The known parameters: 4,000 sampled files per language, 40 Kubernetes
  commits since 2025-11-01 on the full clone, and 30 synthetic 6-file vscode
  cases (gap-1 §3.3-3.4).
- AACR fetches depend on GitHub still serving each SHA. In round two 9 of the
  140 permissive samples were "not our ref", leaving 131 (REPORT §5.2 note).

## Gated

The first row's scripts are committed here, but their round-two rows on the
repositories it names are gated: do not run the scripts on those
repositories, or reuse those rows, until the gate opens. Every other row stays
in the session scratchpad only. If the scratchpad is lost before a row's gate
opens, the numbers it produced are permanently not reproducible and must be
labelled that way wherever they are used (REPORT, "How to read this").
Addendum A §3 (VS-21, "Reproducibility") gates every script whose inputs
include Linux, Grafana, Sentry, Discourse or Martian's goldens on both Q10 and
Q26, so those rows name both.

| Script (session origin) | What it computes | Findings | Gated on |
|---|---|---|---|
| the gated rows of `grepbench.sh`, `parsebench.mjs`, `slicebench.mjs` and `slicebench_wt.mjs` (committed here) | the round-two timings on Linux, Grafana, Sentry and Discourse (pins in gap-1 §3): G1-7's Linux (one name, and the 4-name combined row), Grafana and Sentry grep rows; G1-8's Sentry TSX and Python, Discourse Ruby and Linux `.c` and `.h` parse rows, with the Linux whole-repository estimate and error-tree share; G1-9's Sentry Python and Linux C slice rows, the Linux working-tree row included. The scripts are committed, but must not be run on those repositories | G1-7, G1-8, G1-9 (those rows) | Q10 and Q26 |
| `fc.sh` (`g1/scripts/`) | file count of each ReviewBench corpus repository at a PR head (depth-1 blobless fetch, `ls-tree`) | G1-3, G1-4 | VS-22's per-repository licence check |
| `rb_fc.py` (`g1/scripts/`) | ReviewBench file-count distribution, size-to-file-count correlation, findings by file-count band | G1-3, G1-4 | VS-22 |
| `sizes.py` (`g1/scripts/`) | ReviewBench repository-size buckets and the context labels of true findings per bucket | G1-1, G1-3 | VS-22 |
| `rb_strat.py` (`g1/scripts/`) | ReviewBench large-against-small strata with a repository-cluster bootstrap (context, difficulty, severity, producer and scope shares) | G1-4, GU7 | VS-22 |
| `producers.py` (`g1/scripts/`) | ReviewBench golden producers and their true and false positives | G1-1, GU7 | VS-22 |
| `grep_presence.py` (`g1/scripts/`) | other review bots' text in ReviewBench PR bodies; PR sizes by repository-size bucket | GU7 | VS-22 |
| `martian_repo.py` (`g1/scripts/`) | per-repository recall and precision of each tool against the field mean on Martian's goldens | G1-6 | Q10 and Q26 |
| `mart.py` (`g2/bin/`) | the band against Martian's goldens: band shares, goldens per PR and per kLOC, Spearman, recall and true positives per kLOC by band with a PR-cluster bootstrap, the LLM risk label against the band | G2-1, G2-2, G2-3, G2-4 (Martian rows) | Q10 and Q26 |
| `depth.py` (`g2/bin/`) | deeper against shallower variants of one product by band, on Martian | G2-6 | Q10 and Q26 |
| `gold.py` (`g2/bin/`) | the band against ReviewBench's introduced-by-PR true findings | G2-1, G2-2, G2-3 (ReviewBench rows) | VS-22; Q27 for cutpoint seeding |
| `numstat.sh` (`g2/bin/`) | the first numstat pass: Martian merge refs, the ReviewBench mirrors and all 196 AACR pairs (with base and head swapped and no merge base). `aacr2.sh` superseded it for AACR | G2-1 inputs | Q10 and Q26, VS-22 (mixed job list) |
| `jobs.py` (`g2/bin/`) | that mixed job list (Martian, ReviewBench and AACR) | G2-1 inputs | Q10 and Q26, VS-22 |
| `feat.py`'s main block (`g2/bin/`) | `features.json` over the mixed job list | G2-1 to G2-4 inputs | Q10 and Q26, VS-22 |
| the AACR "all positives" rows (`g2/bin/aacr.py`'s "all" section and validation lines) | over all fetched positives, non-permissive repositories included: gap-2 §1.2's all-positives validation counts (fetched positives, agreement with `change_line_count`, SHAs "not our ref"), the all-positives band section, and gap-2 §2.1's all-positives median PR size (no script prints that one) | gap-2 §1.2, §2.1 | the per-PR licence check (VS-22) and Q31 |
| `agg.py`, `ana.py`, `boot.py`, `break.py`, `ctx.py`, `chk_gu4.py`, `chk_gu4b.py` (scratchpad root) | Martian re-analyses: per-tool precision, recall and F before and after a scoring change; recall by PR label (context, size, difficulty); paired bootstrap on cross-file PRs and its re-checks; recall by golden category and repository | GU3, GU4, GU5 | Q10 and Q26 |
| `lic.py`, `lic_fetch.sh` (scratchpad root) | VOI13's licence fetch: each AACR repository's licence file at its first dataset PR commit, or at branch heads | VOI13 | belongs with VS-22's per-PR licence check; not copied |

Not copied, backing no finding: `h2t.py` (`scripts/`), an HTML-to-text
helper.

## Findings with no surviving script

These were ad hoc commands or arithmetic, so there is nothing to copy:

- G1-11 (partial clones and sparse checkouts) and G1-12 (one
  `git cat-file --batch` against separate `git show` calls).
- G1-7's Linux `--threads` and pathspec rows, and its "old commit" figure
  (`grepbench.sh` greps `HEAD` only). The Linux rows are gated anyway.
- G2-1's changed-line shares per band: no script prints them.
- G2-5, G2-7 and G2-13's recall comparison. Their inputs are gated anyway.
- G3-1 and G3-2 (the AACR token arithmetic) and gap-3 §1.2's
  `change_line_count` distribution: arithmetic on the vendor table.
- RP6's hadoop count: `jit.py` and `jit2.py` drop apache/hadoop before
  printing.

## Checks

How VS-21d checked the copies, to repeat after a change. Run them from a
folder outside the repository, such as `/tmp/vector-vectorscope/vs21d`, with
`R` set to this folder's absolute path; that also shows that no script
depends on the working directory.

- **Parse:** `python3 -I -X pycache_prefix=/tmp/vector-vectorscope/pycache -m py_compile "$R"/*.py`,
  `node --check` on each `.mjs` and `bash -n` on each `.sh`.
- **Arguments:** each runnable script with `--help` exits 0, and without
  arguments (or with a bad `LANG`, `MODE`, count, or `aacr2.sh` `KEY`, `URL`,
  `BASE`, `HEAD` or `SINCE`) exits 2. Paths inside the repository are refused
  with exit 2. `aacr_jobs.py` on a sample whose URL or commit is malformed
  exits 1 naming it.
- **Helpers:** `runpy.run_path` of `jitlib.py`, `stats.py`, `feat.py`,
  `outguard.py` and `aacr_jobs.py` exposes their names without running a main
  block.
- **Equivalence**, while the session scratchpad exists: stdout of each
  ApacheJIT script against the session original run in its own folder;
  `cmp` of the three history CSVs against the session's; `aacr_jobs.py`
  against the session job list; and `aacr.py` against the original run on a
  temporary scratchpad whose numstat folder holds only the permissive
  numstats (so the original reads no gated input).
- **End to end, offline:** `aacr2.sh` against a two-commit local repository
  with a relative `OUT_DIR`, reached through git's `url.<file URL>.insteadOf`
  set to a `https://github.com/OWNER/REPO` URL (given in `GIT_CONFIG_COUNT`,
  `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0`), since the script accepts only
  GitHub URLs; `grepbench.sh` with one name and a relative `SCRATCH_DIR`; `parsebench.mjs` and the three slice scripts (`go`,
  one case) on a few `.go` files. None of these is a benchmark.
