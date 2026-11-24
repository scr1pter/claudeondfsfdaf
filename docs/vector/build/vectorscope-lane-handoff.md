# VectorScope lane handoff (scope-finish), 2026-11-21

You are taking over the VectorScope finish lane. The lead session keeps everything else: the Everywhere lane and its merge, the final docs PR, the branch-cleanup record, and the release steps. This file explains what is happening, how the work is done, what else is running, the overall vision, and how to finish. The exact package briefs, invariants, owner gates and lead rulings are in `vectorscope-lane-plan.md` next to this file. Read both before you touch code.

## 1. Where things stand (2026-11-21 ~01:30 UTC)

- **Goal: "finish Vector v2."** Every lane is finished, merged into `main` through GitHub PRs with merge commits (never a direct push to `main`), and then every branch except `main` is deleted, with its last SHA recorded. The release ships as 2.0.0 (there is no 1.99.113). A redesign comes later; do not touch design.
- **main** is `f3d7ac74`. 21 PRs have merged this cycle: #33 #34 #37 #35 #39 #40 #38 #41 #44 #42 #43 #36 #47 #46 #48 #49 #50 #52 #51 #53 #54. #45 was closed. Main's push CI was fully green on `3670461a` (#53); `f3d7ac74` (#54, test-only) was still running at handoff.
- **Lanes merged:** release-finish, workspaces, native isolation, Hands, Connect, Brain transport, Codium, plus a series of CI repairs (#47-#54).
- **Everywhere lane** (branch `everywhere-finish`, run by the lead): 32 of 33 packages committed, EV-33 in progress, then its phase review and a PR to `main`. It is expected to merge **before** VectorScope.
- **VectorScope lane** (branch `scope-finish`, yours): 19 of 47 packages done (SF-01 to SF-15, including sub-ids), pushed, head `e6d34fed`. The lane was **paused at the SF-15/SF-16 boundary** on 20 Nov 12:53 UTC to save the owner's usage. Nothing is half-built: the worktree was clean and equal to origin. SF-16 is next.

## 2. The vision

Vector is a coding agent: an engine with a CLI and TUI, a desktop app, a hosted API and website, and integrations (GitHub, Slack, Linear, Jira). v2 finishes the in-flight features so the product is complete and stable before the redesign. VectorScope is Vector's code reviewer: local `vector review`, the GitHub `@vector review` job and the desktop's pull-request review. The VectorScope upgrade adds opt-in quality and safety mechanisms: an impact slice, strict guardrails, rule citations, verification certificates, depth and lenses, privacy (zero data retention) and secret holdback, consented fixes, an MCP broker, diagnostics, large-PR batching, and the GitHub halves. All of it is reversible software behind keys that stay **off by default**. Activation, model approval and paid evaluation are owner decisions, not yours.

Owner direction that applies everywhere:

- New features stay off by default. The flags `MODEL_PLANS_ENABLED`, `VECTOR_EXPERIMENTAL_CONNECT`, `VECTOR_EVERYWHERE_ENABLED`, `VECTOR_GITHUB_BRAIN_ENABLED`, native isolation, Hands and cloud workspaces stay off; the VectorScope UI stays behind `experimental.vectorscope`; `review.privacy` and `review.holdback` ship hidden.
- Codium shows usage as percentages only, never tokens or prices. No team features. Fewer UI controls, not more.
- Reports to the owner are plain, short English; lead with the answer; never claim what you did not check. Ask only real decisions, one at a time, with a recommendation.

## 3. Binding rules

These come from the owner and override defaults. Breaking one is never acceptable, even to get CI green.

**Never**

- Force-push, `--no-verify`, `git stash`, `git reset --hard`, rebase, or rewrite anything on origin. Use merge commits.
- Read credential files, keys or tokens, or dump environment variables.
- Put the owner's personal email anywhere (source, docs, logs, commits). Commit as `Vector <bot@vectordev.ai>` with `git -c user.name=Vector -c user.email=bot@vectordev.ai commit ...`, and end every commit message with two trailer lines for your own session: a `Co-Authored-By:` line naming your model and a `Claude-Session:` line with your session URL.
- Name the open-source project Vector was originally forked from, anywhere.
- Edit tokenomics, benchmark, dataset or protected-budget files, or anything under `docs/benchmarks/`. Leave the two Codium sentences in `packages/web/src/pages/docs/tokenomics.astro`. Never edit `packages/engine/test/cli/review.test.ts` (put new CLI tests in new files).
- Push to `main`. `main` changes only through a PR merge with a merge commit.
- Change the live Terms, Privacy or consent text; publish a release; make public or comparative claims; register platform apps; buy anything. Ask the owner first for any of these.
- Turn on any feature flag or review key by default. Call real external hosts in tests (GitHub, Slack, Linear, Atlassian, Stripe, model providers, the relay); use the local fakes and fetch guards.
- Start the owner's Vector app, a dev server, Playwright, the desktop app or a browser lane locally, or let any test drive a real screen, keyboard, mouse or browser. Never operate the owner's computer in automated tests.
- Skip, disable, quarantine or loosen a test, or lengthen a test deadline, to get green. "Flake" is not a root cause.

**Local work**

- One Bun workload at a time across all agents in a container: run every `bun` command through a flock wrapper. The lead used `~/.tools/vector-serial`, which is two lines: `#!/bin/sh` and `exec flock --close ~/.cache/vector-bun-workload.lock "$@"`. Create the same in your container.
- Tests: one file at a time from its package directory: `vector-serial bun test --timeout 30000 <file>`. Never whole suites.
- Typecheck per package (`bun typecheck` in `packages/<p>`) and, before every push, the whole tree: `TURBO_CACHE_DIR=<worktree>/.turbo/cache vector-serial bun turbo typecheck --concurrency=2` (use `--concurrency=2`; higher concurrency can fail for memory).
- Install: `vector-serial bun install --ignore-scripts --frozen-lockfile`. It fetches the dependency `scr1pter/vector-ghostty-web` at commit `513463a6f1190253057e8a3f0dac8f6ee8393553` as a GitHub tarball.
- Generated files (SDK, openapi.json, config.json, workflow.json, the help snapshot) are regenerated with the repo's generators (`bun run generate` in `packages/client`, `./packages/sdk/js/script/build.ts`, the engine schema script, the snapshot test's update mode), never hand-edited.
- Scratch under `<scratch>/<task>/`, with fresh XDG roots for anything that boots the engine. Keep disk above 3 GB free.

**Git and CI**

- Stage explicit paths. Conventional titles (`feat|fix|docs|chore|refactor|test(scope): summary`). Before each push: fetch the branch, merge anything new, run the full typecheck, push fast-forward only.
- GitHub through the GitHub MCP tools (owner `scr1pter`, repo `vectordev.ai`, which redirects to `scr1pter/claudeondfsfdaf`). Read job logs with `get_job_logs` (`return_content: true`, `tail_lines`); large results land in a file you slice with Python. In the lead's session the `gh` CLI could not read runs or logs (numeric repository paths are refused), and **deleting branches was refused (HTTP 403)**.

## 4. How a package gets done

Each package in `vectorscope-lane-plan.md` has a brief with the files, tests and "done when". The lead ran each one through this loop, and you should keep the same quality bar:

1. **CI check** of the previous push: read the lane workflows' results on `scope-finish`. Fix anything this branch caused before you start the next package.
2. **Plan** at HEAD: re-locate every file and line the brief cites; list files, signatures, tests, the deviation entry and the pin change.
3. **Adversarial critique** of the plan against the docs, the invariants (I-1 to I-14) and the rules. The critique wins where it is right.
4. **Implement**, with tests that would fail on the old code, then run each new or changed test file alone through the lock, typecheck every touched package and the eval tsconfig, and run a few one-line **mutations** that turn the new tests red (restore and check the sha256 afterwards).
5. **Two-lens review** of the uncommitted diff (safety/invariants and correctness/scope), fix round, repeat up to three times until no blocking findings.
6. **Commit gate**: one focused commit (or a few), the **deviation entry** appended to `docs/vector/build/vectorscope-deviations.md` (`## 2026-11-DD · VS-xx <title>`: scope, default/parity proof, pin old -> new, replay variant change, desktop half or the documented difference, tests run with counts, and what is NOT claimed), push, and **dispatch** the workflows the brief's lane rules name (typecheck.yml always; test.yml for runtime changes; scope-directory-identity.yml, review-memory-fence.yml, review-http-regression.yml (scope local), scope-app-validation.yml and vector-at-mention.yml as their triggers in the plan say). The scope-\* push triggers do not list `scope-finish`, so dispatch explicitly.
7. **Stop for a ruling** whenever a package needs something outside its brief (an out-of-brief file, an owner gate, a protocol change, a key enabled). Record the ruling in the deviation entry. Rulings the lead already gave (Option A additive `fix.json` record for SF-07..SF-10b, SF-40, SF-41; SF-06 part 1 dropped) are in the plan file.

The model-evidence pin matters in almost every package: `REVIEW_PIPELINE_SOURCES` in `packages/core/src/review/model-evidence.ts` must be recomputed whenever a pinned file changes (the pinned list is in `model-evidence.test.ts`). `REVIEW_PIPELINE_REVISION` stays as it is unless a default review's findings change, and none should.

## 5. Start here: what to do first

1. **Clone and check out `scope-finish`** (`e6d34fed`). Install, and confirm `git status` is clean.
2. **Merge `origin/main` into `scope-finish` first** (merge commit, Vector identity, trailers). The branch is 343 commits behind `main` (merge base `0ee486e3`). `git merge-tree` predicts conflicts in:
   - `packages/core/src/review/model-evidence.ts` (the pipeline pin: `main` has `REVIEW_PIPELINE_REVISION` and `REVIEW_PIPELINE_SOURCES` values set by other lanes; keep `main`'s revision, keep this lane's pinned-file changes, then **recompute** the sources digest with the repo's pin test rather than picking either side's value),
   - `packages/core/src/read-only-git.ts` (resolve by keeping both sides' behaviour and running `packages/core/test/read-only-git.test.ts`).
     The SDK generated files and `openapi.json` auto-merge; regenerate them with the generators after the merge and commit only if the output differs. Run the full typecheck and the review test files you touched before pushing the merge. If `everywhere-finish` has merged by then, it moves the pin again; recompute once more.
     Merging `main` early brings in today's Windows CI fixes (#51-#54), which removes several flakes your CI would otherwise hit.
3. **Continue at SF-16** and work down the remaining list in order. SF-41 starts only after the brain-transport lane's changes to `github.bundle.ts` and `github.publish.ts` are in (they are: brain-transport merged), but it still needs the @vector owner's co-sign for edits to @vector-owned files (I-9). SF-42 refreshes the inventory, continuation and final pin.
4. After SF-42: a **phase review** of the whole lane diff (two lenses), fixes, then take the lane to `main` (section 7).

## 6. What else is running (do not touch)

- **Everywhere lane** (lead): branch `everywhere-finish`, last package EV-33 then a PR to `main`. Never edit that branch. Its `packages/engine/test/everywhere/unattended-session.test.ts` has a slow-Windows-runner issue the Everywhere lane fixes in its own merge.
- **Final docs PR** (lead, after Everywhere merges): docs sweep plus the "Deleted branches" table in `docs/vector/build/v2-integration.md`.
- **Branch cleanup** (lead + owner): the session's git proxy refuses branch deletion, so the owner will delete branches on GitHub at the end from the lead's list. Do not delete branches; do not push to branches other than `scope-finish`.
- **Release steps** (lead, after VectorScope merges): the single regeneration (SDK, openapi, config.json, workflow.json, help snapshot), the 2.0.0 version change, the final CI and the production-check live run, then the owner's release approval. None of these are yours; SF-36 explicitly changes no version.

## 7. Taking the lane to main

1. Merge the latest `origin/main` into `scope-finish` again (merge commit), recompute the pin, regenerate generated files with the generators, full typecheck, push.
2. Open a PR `scope-finish` -> `main` with a conventional title. The body lists what landed (VS ids), what stays off and why, the owner gates left open, the pin and revision, the tests and CI evidence, and what is NOT claimed. End the body with:
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)` and your session URL on the next line. GitHub comments you post end with a `---` rule and `_Generated by [Claude Code](https://claude.ai/code)_`.
3. **Merge gate**: every check on the exact head SHA finished green (success/skipped), the Vercel preview status is success, the PR is mergeable. Merge with `merge_method: "merge"`, `expectedHeadSha` = the head, title `<PR title> (#N)`, message = exactly the two trailer lines. Do not delete the branch. The owner pre-authorized merging finished, reviewed, CI-green branches into `main`; tell the owner one line per merge.

## 8. CI: what fails and what to do

Hosted Windows runners are the main source of red today. About 1 in 7 Windows VMs is slow on first touch of files and programs (the setup-node "Environment details" group takes 17-35 s instead of 3.5-5.4 s), which makes tests that start many processes 2-4x slower. Defender is already off on these images, so Defender exclusions do nothing.

Re-run a failed job **at most once per run, at run_attempt 1**, and only when every failure is in one of these classes; otherwise find the root cause:

- (a) Windows overlay Stop failure (HF-7): `computer-helper / windows-build`, step "Run actual isolated medium-token Windows overlay Stop", stop `native_failure` with `core_failure:no_ui_tree` at stage `uia-root-element`, `uia-runtime-id` or `stop-root-retired` (lookup first, call root, actor retired), or `cleanup_failed` at any stage. It recurs about 1 in 7 Windows runs and is a known open issue (HF-7 option (b)).
- (b) ripgrep install 5xx or timeout.
- (c) Runner loss, checkout or install death, or a native build step time-out.
- (d) `oh no: Bun has crashed` (a Bun 1.3.14 panic or segfault) with no failing test.
  A Windows timing failure in a file your diff does not touch gets one confirm re-run; if it repeats, it is real.

VectorScope-owned tests already known to sit close to their budgets on Windows (fix them inside this lane, without longer deadlines, because `scope-finish` rewrites these files):

- `packages/engine/test/review/impact.test.ts` "ReviewImpact.build > the time box stops at any step and keeps the stages consistent": timed out at 30 s on job 136513156019 (it commits 300 files and builds five times), while neighbours ran normally.
- `packages/engine/test/review/impact.test.ts` "partial clones > a blobless clone with nothing checked out ...": 114.7 s of its 120 s budget on job 136436433728, a normal VM.
- `packages/engine/test/tool/task.test.ts` "an isolated child stacks only changed isolated dependencies ...": 26.7-41.4 s of 60 s (not a lane file, but watch it).
  Also known and not yours: the Windows helper native build (`computer-helper / windows-build` step 9) runs 450-580 s for two architectures under a 300 s per-command cap, close to the limit even after #52.

The repo records every CI repair in `docs/vector/build/ci-harness-repairs.md`; read the 2026-11-20 entries before you chase a Windows failure.

## 9. Budget

At handoff the owner had about 50% of the weekly usage left, resetting on 26 Nov 17:00 UTC. If you run on the same account, that usage is shared with the lead's work. The previous pace (about 1.6% an hour) would use it up long before the reset. Work package by package, avoid speculative investigations, and if the usage status becomes stricter than "allowed" (for example "allowed_warning"), stop at the next package boundary and tell the owner before continuing.

## 10. Documents in this repository

- `docs/vector/build/vectorscope-lane-plan.md`: the lane definition (remaining briefs, invariants, lane rules, owner gates, rulings, the runner script).
- `docs/vector/build/vectorscope-upgrade.md` and `-addendum-a.md`, `-addendum-b.md`: the specs the packages implement.
- `docs/vector/build/vectorscope-deviations.md`: append-only package entries; read the SF-01..SF-15 entries to see the expected depth.
- `docs/vector/build/vectorscope-remaining.md`, `vectorscope-continuation.md`: the inventory and checkpoints SF-42 refreshes.
- `docs/vector/build/v2-spawn-review.md`: mandatory before touching process-spawning code (SF-08, SF-30a/b, SF-33).
- `docs/vector/build/v2-handoff.md`, `v2-integration.md`: the owner's v2 list and the integration record.
- `script/vectorscope-eval/README.md`: eval-script conventions and the replay VARIANTS registry.
- `AGENTS.md`: the repo style guide (dependency direction, Effect conventions, no `else`, no aliased or star imports, Bun APIs, tests run from package directories).
