# Master prompt: finish Vector v2

You are taking over a large, half-finished engineering effort from another agent who ran out of usage. Read this whole prompt before doing anything. It explains the product, the owner, the rules, the exact state of every piece of work, what is left, in what order to do it, and how to report. Where it says "see file X", the file is in the repository and has more detail. Everything you need is either here or in the repository on GitHub. Nothing lives only on someone's laptop.

---

## 1. The product and the repository

**Vector** (vectordev.ai) is a local-first AI coding agent: a desktop app, a CLI/TUI and a website, built by one owner with the help of AI agents.

- **Local-first** means the agent runs on the user's own computer, and code stays there unless the user chooses a cloud feature.
- **The repository** is `scr1pter/claudeondfsfdaf` on GitHub. It is public, so everything you push is public. The git remote may still show the old name, `scr1pter/bjikdoy`; GitHub redirects it, and `gh -R scr1pter/claudeondfsfdaf` works.
- **Monorepo layout.** It is a Bun 1.3.14 monorepo using Effect, with turbo for tasks.

| Path | What it is |
|---|---|
| `packages/engine` | The agent engine: sessions, tools, CLI commands, HTTP API |
| `packages/core` | Shared core: process spawning, Brain (local memory database and migrations), stores, locks |
| `packages/app` | The SolidJS app UI. The desktop app renders it, and there is also a phone build |
| `packages/desktop` | The Electron desktop shell, currently 1.99.112 |
| `packages/ui`, `packages/session-ui` | UI kit and session views |
| `packages/sdk` | Generated client SDK. Regenerate it, never hand-edit it |
| `packages/web` | The Astro website and docs on vectordev.ai |
| `api/` | Vercel serverless functions behind vectordev.ai |
| Others | `packages/schema`, `packages/cloud`, `packages/hosted-computer` (Codium's cloud computer image), `packages/relay` (Remote relay worker), `packages/cloud-workspaces` |
| Design and build docs | `docs/vector/build/` and `docs/vector/design/` |

- **Deployment.** Every push to `main` makes Vercel deploy vectordev.ai to production: the site, the `api/` functions, redirects and crons. Commits whose message contains `[skip ci]` do not deploy.
  - Production is still on the 8 November version (commit `0dcbb8e2d`), because the newer `main` commits are docs-only and carry `[skip ci]`.
  - The first code merge you make will deploy everything now on `main`, including Codium. All new features are behind flags and switched off.
- **CI** (GitHub Actions):
  - `test.yml`: about 24 jobs, unit and integration tests across Linux and Windows. Runs on every pull request.
  - `typecheck.yml`: runs on pull requests into `main`.
  - `verify.yml`: runs on every pull request; includes a 30-minute packet-capture job.
  - Area lanes: `vector-codium.yml`, `vector-at-mention.yml`, `vector-everywhere.yml`, the VectorScope lanes, the cloud-workspaces lane, Windows containment, installers, and others.
  - On branches without a PR, dispatch a workflow with `gh workflow run <file> -R scr1pter/claudeondfsfdaf --ref <branch>`.
  - Watch a run with `gh run watch <id> --exit-status`. Read failures with `gh run view <id> --log-failed`.
- **Known CI flakes.** Re-run once with `gh run rerun <id> --failed`, and only when the failed job matches one of these exactly and nothing else failed:
  - a Bun segfault ("panic: Segmentation fault") on a Linux engine shard;
  - Windows: `local-fit.test.ts`, `prompt.test.ts` (3 s timeout), `task-size.test.ts` (30 s), effect-flock contention, `local.test.ts` probe 400, `task-manage-abort.test.ts` (2 s);
  - packet capture seeing UDP DNS packets to 198.18.0.53:53, or its 55-minute setup timeout;
  - GitHub "Failed to CreateArtifact";
  - Chocolatey or ripgrep download 504s;
  - Vite "Outdated Optimize Dep" 504 at browser test startup;
  - `packages/engine/test/cli/review.test.ts:1050`, which fails whenever a randomly generated commit SHA contains "987". This is a known test bug in a file owned by the tokenomics work: never edit it, just re-run.
- **GitHub limits.** Free runners queue when many jobs run at once, so a full test round can take 60–90 minutes. The API rate limit is shared, so poll gently and cancel your own superseded runs.

---

## 2. The owner, and how to work with them

- **One owner** makes the product decisions. They use several computers, so everything must be pushed to GitHub, and any handoff must work from a fresh `git clone`.
- **Reports.** Plain, short English: what is now true, what changed, what is next, and what (if anything) you need from them. Lead with the answer. No jargon, no long logs. Never claim something works unless you checked it. Say plainly what is not done or not verified.
- **Questions.** Ask only real decisions, one at a time, with your recommendation. Everything else, decide yourself.
- **Product direction to respect:**
  - Codium shows usage as **percentages only**, never tokens or prices.
  - There are **no team features** yet.
  - The UI should have **fewer controls**. The owner said of crowded designs: "this is too much".
- **Authority they have given:**
  - You own every in-flight area, including Hands (computer use), which the owner says is done.
  - You may **merge finished, reviewed, CI-green branches into `main`** in the order below without asking each time. Tell the owner after each merge.
  - The owner wants **every branch deleted except `main`**, each one only after its work is fully in `main`.
  - **Still ask first for:** cutting or publishing a release; public or comparative claims (on the site, in docs or in marketing copy); purchases; registering platform apps (GitHub App, Slack, Linear, Jira); and deleting anything not yet fully in `main`.

---

## 3. The goal, in order

1. **Finish every in-flight feature and merge all of it straight into `main`.** There is no integration branch. A temporary `v2` branch existed, was fast-forwarded into `main`, and was deleted.
2. **Delete every branch except `main`.** Delete each one only after verifying its work is in `main`, and record its last commit (see section 9).
3. **Then build the desktop redesign**, Vector Signature (section 11).
4. **Then build the new features the redesign shows:** On-call, Plan and Artifacts, plus the iOS Simulator pane, computer use as commands, and the walkthrough (section 12).
5. **Ship as Vector v2, version 2.0.0.** There is no 1.99.113 release; 113 was folded into v2. Shipping also needs the owner-only items in section 13.

Rough time:
- **The redesign can start** after about a week of the work below.
- **Finishing everything,** including VectorScope's remaining modules, is 2–3 weeks.
- **The redesign itself** is about 1–2 weeks, then the new features.

---

## 4. Binding rules

Follow these exactly. Each has a reason.

1. **Never force-push, never use `--no-verify`, never use `git stash`.**
   - Never rebase or rewrite anything that exists on origin; use merge commits.
   - The pre-push hook (`.husky/pre-push`) runs `bun typecheck`, which is turbo across all 26 packages. If it fails, fix the cause.
   - Before any turbo command or push, set `TURBO_CACHE_DIR` to a folder inside your own checkout, so you never write into someone else's cache. Never commit that folder.
2. **Install with `bun install --ignore-scripts`**, and run it again after big merges.
3. **Local tests: one file at a time** from the package directory (`bun test --timeout 30000 <file>`). Typecheck per package, or with `bun turbo typecheck --concurrency=2`.
   - Never run whole test suites, dev servers, Playwright, the desktop app or browser lanes locally. Heavy local runs crashed the owner's Vector app before.
   - Full suites, browser lanes and native lanes run only in GitHub CI.
4. **Never read credential files, keys or tokens.**
   - Never put the owner's email address in the repository. Commit as `Vector <bot@vectordev.ai>` if no identity is set.
   - Never name the open-source project this code was forked from, anywhere: code, comments, docs, commit messages.
5. **Never edit tokenomics or benchmark files.** Another agent owns them, and it matters a lot to the owner.
   - This covers anything named tokenomics, benchmark, dataset or protected budget, plus `docs/benchmarks/`.
   - The merged tokenomics branches were already deleted with the owner's yes.
   - One exception is pending the owner's word: Codium added two sentences to `packages/web/src/pages/docs/tokenomics.astro` explaining the "Codium" label. Leave them.
6. **The owner's machine:**
   - Never start or restart the owner's Vector app.
   - Never let Hands, browser automation or any test drive the owner's real screen, keyboard, mouse or browser. Tests use fakes, temp directories and CI runners.
   - No test may call real external hosts: GitHub, Slack, Linear, Atlassian, Stripe, model providers or the relay. Use the local fakes and fetch guards that already exist.
7. **New features stay switched off by default** behind their flags:
   - `MODEL_PLANS_ENABLED` (Codium);
   - `VECTOR_EXPERIMENTAL_CONNECT` (connected workspace);
   - `VECTOR_EVERYWHERE_ENABLED` (Vector everywhere);
   - `VECTOR_GITHUB_BRAIN_ENABLED` (@vector Brain transport);
   - native isolation (off until qualified);
   - Hands (off until onboarding);
   - cloud workspaces (off).
8. **Pushing `main`.**
   - On the owner's Mac, push `main` only from the worktree `~/.cache/vector-main`, with `git push origin main-wt:main`.
   - Anywhere else, merge through GitHub PRs (`gh pr merge <n> --merge`) or fast-forward pushes only.
   - Never touch the owner's main checkout in their session folder.
9. **Before every push, re-fetch.** If someone else's commits appeared on the branch, merge them in; never overwrite them.
   - Other agents worked on these branches: Codex built Hands, and an agent committing as "Vector Build Agent" built several combined branches. Both are believed stopped, but check the latest commit times before taking a branch.
10. **Before each merge into `main`:**
    - the full CI must be green at the exact head;
    - the Vercel preview of that head must be green;
    - the PR must be marked ready (not draft).

    Main deploys production, so also look at what new public pages or `api/` functions the merge publishes, and keep anything not ready behind its flag.

---

## 5. What is in `main` now

`main` is at `b1673ac7c` or later. It contains:

- **Multi-agent and self-evolving** (PR #20, merged 8 November): Claude-level helpers and subagents, background agents, steering, worktrees, workflows, learned skills, workflow insights, a prompt guard. The live site still promises "Coming in desktop 1.99.113" for some of these; that copy moves to 2.0.0 later.
- **Process ownership** (#26, from `process-finish`): background commands are owned and cleaned up, including Windows Job Objects (`packages/core/src/owned-process.ts`, `background-job*.ts`, `engine/task/shells.ts`). It also fixed `main`'s three red tests. #23 was closed as a duplicate.
- **Release coordination tooling** (#27): a release observer and policy under `scripts/release-readiness/`, plus `docs/vector/owner-actions/release-199113.md`. Its names still say 1.99.113.
- **Codium** (#24): the paid tiers, the hosted cloud computer, Remote (phone app at remote.vectordev.ai, relay worker), vault backup, playbooks, Race lanes, GitHub connections, account deletion in stages, founders page, docs. It is off behind `MODEL_PLANS_ENABLED`. Track A A00–A58 and Track B B01–B11 source are done. #28 was closed as a duplicate.
- **Docs:**
  - `docs/vector/build/v2-handoff.md`: the short handoff. This prompt is the long one.
  - `v2-integration.md`: the merge log, and the list of deleted branches with their SHAs.
  - `v2-spawn-review.md`: important, see section 7.
  - `v2-finish-plan.md`: the full assessment, conflict lists and merge simulation.
  - `v2-notes/`: the combined-branch plan and the lane notes.
  - `docs/vector/design/signature/`: the redesign.

CI was dispatched on `main`'s head: test 43620659749, typecheck 43620662183, verify 43620664452. **Check these first.** If anything is red for a real reason, fix it before merging anything else.

---

## 6. The open branches, and what to do with each

There are about 36 branches besides `main`. Verify the list yourself (`git ls-remote --heads origin`).

### Lanes in progress, with PRs into `main`. Continue from these heads.

| Branch | PR | Head | State | Next |
|---|---|---|---|---|
| `v2-hands` | #30 | `3d5a45a09` | Hands integration, started from `hands`. Merging `main` in was in progress. Full CI not confirmed | Finish resolving the 10 conflicts (section 8.1). Review, CI, merge. Then close #22 (`hands`) |
| `cloud-workspaces` | #21 | `d0300404e` | Persistent cloud coding sessions, off by default. User-agent fixed. Verify and typecheck green | Confirm workspace cleanup runs inside Codium's staged `finishAccountDeletion`, and that the copy says percentages, not "credits". Full test, review, merge |
| `agent-environment` | #32 | `fa938a090` | The agent fully controls its own terminals and browser (section 8.6). Verify and typecheck green | Finish the review and repair passes, full test, merge |
| `v2-locks` | #31 | `06814f1df` | Three lock fixes, done and documented | Full test, a quick review, merge |

### Not started

- **`v2-complete`, the most important remaining piece.** One combined branch for @vector, VectorScope, connected workspace and Vector everywhere. Follow `docs/vector/build/v2-notes/v2-complete-plan.md` exactly; section 8.2 explains it.
- **`v2-codium-acceptance`.** Codium Track B acceptance runs B09, B10 and B11 (section 8.4). Start it from `main`.

### Sources that fold into `v2-complete`

Delete each only after `v2-complete` is merged and `git cherry` shows nothing unique left:

`build-complete`, `build-candidate`, `build-integrate`, `build-github-ui`, `vector-at-mention` (PR #25), `build-scope`, `build-scope-joined`, `build-scope-owner`, `build-scope-wire`, `build-scope-checks`, `build-scope-ui`, `build-scope-witness`, `v2-scope` (draft PR #29, superseded by `v2-complete`), the stale `vectorscope`, `build-connect`, `connected-workspace`, `vector-everywhere`, `build-everywhere`, and the stopped lanes `v2-vector`, `v2-connect` and `v2-everywhere`. Check that `build-everywhere`'s extra runner tests (25 cases) end up included.

### Other branches

- **`build-isolation`, `build-native-shell`** (@vector native isolation):
  - Merge after `v2-complete`, switched off.
  - Its qualification on real machines failed and is unfinished ("No production activation is authorized"). Treat qualification as a shipping gate, not a merge gate.
- **`hands`** (PR #22) and **`hands-ui-check`**: covered by `v2-hands`.
- **`hands-diagnostics`**: 10 commits not on `hands`. Check whether they are superseded, then merge what is still useful, or drop it.
- **`owner-setup`, `build-coordination`:** docs-only, merge them.
- **`codium-legal`:** Codium's legal drafts for the owner's legal read. Merge as docs; never change the live legal pages without the owner.
- **`finish-checks`, `codium-track`:** everything in them is already merged. Delete them.
- **`benchmark-before`:** one benchmark commit that conflicts in `test.yml`. It is the benchmark agent's: ask the owner whether to merge or drop it.
- **Only on the owner's Mac:** `r2-downloads` (parked by the owner; ask) and `ci-tmp-90acb30c` (temporary; ignore).

---

## 7. The process-spawn hot spot

Read `docs/vector/build/v2-spawn-review.md` before touching these files. Four pieces of work all change how Vector starts and stops processes: `packages/core/src/cross-spawn-spawner.ts`, `engine/task/shells.ts`, `core/pty.ts`, `engine/tool/shell.ts`, `engine/mcp/index.ts`, and the Windows holder. The four are:

- #26's owned processes;
- Hands' `beforeSpawn` safety recheck;
- @vector's tool-process isolation;
- native isolation's lifecycle owner.

Rules from the review:

1. **Hands' recheck runs before anything lasting happens.** It must run before `background.start` writes a job row. A refusal leaves no job row and returns the original error.
2. **Exactly one component signals or kills each process.** Under native isolation, the native owner signals and `OwnedProcess` delegates to it.
3. **The owner is always the outermost layer**, with the isolation wrapper inside it.
4. **#26's Windows background path calls `WindowsProcess.start` directly.** It must not bypass Hands' policy or the isolation floor.
5. **Add tests for each:** recheck order, refusal leaves no row, one signaler, an isolated process is still owned and killed on cancel on Windows and POSIX.

---

## 8. Each area in detail

### 8.1 Hands: computer use

- **What it is:**
  - The desktop agent can operate the user's computer: a purple edge glow, a top banner "Vector is using your computer" with Take over, Resume and Stop, a ghost cursor labelled "Vector", and per-app permission asks.
  - There are native helpers for macOS and Windows, a pinned Hands card in Tasks, and a Watch dialog.
  - It is off until onboarding.
- **State.** Codex built it. The last code commit, `a0e5ce8e8`, passed test, typecheck, Verify, installers and the desktop release workflow, and `4eb9f52fd` records the unsigned package handoff. The owner says it is done.
- **Merging `main` into it conflicts in 10 files:**
  - `engine/task/shells.ts` and `test/task/shells.test.ts`: resolve per section 7, rule 1.
  - `app/src/pages/layout.tsx`: Codium's Remote `sendPhoneAlert` moves into Hands' `layout/ask-notifications.ts`, so alerts fire once from one place.
  - Mechanical, keep both sides: `settings-v2/dialog-settings-v2.tsx`, `settings-registry.test.ts`, `context/platform.tsx`, desktop `main/index.ts`, `tray.ts`, `vector-account-runtime.ts`, and engine `cli/cmd/export.ts`.
- **After `v2-complete`** also lands, Hands meets @vector's tool isolation in `pty.ts`, `ipc.ts`, `mcp/index.ts` and `tool/shell.ts`. Whichever branch merges second resolves those.
- **Docs:** on the `hands` branch, the `hands-*` docs and `docs/vector/owner-actions/hands-release.md`.
- **Hands adds files under `docs/benchmarks/vector-hands-1.99.112/`.** Leave them untouched.

### 8.2 `v2-complete`: @vector, VectorScope, connected workspace, Vector everywhere

The stopped "Vector Build Agent" already combined these four into `build-complete` (`00b87034f`), with combined CI evidence in `build-coordination:docs/vector/build/build-night-2026-11-14.md`. Build `v2-complete` from it, following `docs/vector/build/v2-notes/v2-complete-plan.md`. In short:

1. **Create the branch** from `origin/build-complete`.
2. **Merge `main`.** The only textual conflict is the import line in `cross-spawn-spawner.ts`. Resolve it per section 7.
3. **Merge or cherry-pick the stopped lanes,** in this order:
   1. `v2-vector`: clean. It has the sandbox floor fix `202b18947`, `709f81127` and `676674c17`, plus the spawn seams.
   2. `v2-everywhere`: clean.
   3. `v2-scope`: 13 conflicts.
      - Take `v2-scope`'s Brain files whole.
      - Take `main`'s `model-plans.test.ts`.
      - In `review/run.ts`, take ours except the verify hunk, where `overTokenStop` goes first.
   4. `v2-connect`: cherry-pick only `0c58e7f69` with `-x`; do not merge it.
4. **Brain migrations:**
   - Codium uses prefixes `20261213…` and `20261214…`.
   - VectorScope's migrations are renumbered to `20261216`–`20261218` (`c8e3ca185`, with `replaces`), and there is a test that the import list in `brain/database.ts` is in strictly increasing order.
   - Do not leave duplicate prefixes.
5. **Regenerate once** after all merges: the SDK, openapi, config.json, workflow.json and the help snapshot.
6. **Fix Tier A before merging:**
   - **Connected workspace:**
     - A secret diff still reaches the model (`policy.ts:690`, `hub.ts:1012`).
     - VectorScope shows "ready" on non-Linux hosts, where private review is Linux-only (`vectorscope.ts:368-380`).
     - Connect features are visible with the flag off (`index.ts:195`, `guide.txt:11`, `config.json:1142`).
     - "repair" can run through `tightenLease` (`notify.ts:879`).
     - Changes at `instance-store.ts:381` and `config.ts:1909` reach every user; they must be flag-gated.
     - The `connect_write` approval shows no diff.
     - The fix child gets no ask rules.
   - **Everywhere:**
     - The erase registration is missing.
     - The everywhere and codium lanes need `main` triggers.
   - **Spawn:**
     - Add spawn tests S4-3 and S4-5.
     - Fix the unisolated Python spawns at `directory-identity.ts:745` and `read-only-git.ts:565`.
   - **Scope:** add a test that Codium-routed reviews still pass VectorScope's admission.
   - **Cleanup:** delete the temporary candidate and compat workflows the build agent added.
7. **Tier B** in the same branch if time allows:
   - connect C3, C5, C6 and C9;
   - everywhere C3–C6;
   - the V24 version flip and the `brain_upload` workflow input;
   - docs.
8. **Tier C** later, with deviation entries: the V27 runtime, the Q6 connect consolidation, VectorScope VS-11 and up, everywhere C7, C8, F5 and F6, native isolation.
9. **Note:** `build-complete` hid one real failure by making `run.test.ts:2252` Linux-only. Commit `b48a7ac4f` (Windows read denial) is the real fix. Use it.
10. **CI lanes for the PR:**
    - test, verify, typecheck;
    - `vector-at-mention.yml` and `vector-everywhere.yml`;
    - GitHub desktop validation, Windows containment, the four VectorScope lanes, connect app validation (add a dispatch trigger if it has none) and `vector-codium.yml`;
    - the Vercel preview.
11. **Review from three angles** (process spawn and security; data paths; fit and completeness), repair, then merge. Close #25 and #29.

What each area is:

- **@vector.** Mention Vector on GitHub (`/vector` in an issue or PR) and it opens a pull request. It runs in the repository's own GitHub Actions, bound to the user's Codium plan, with run tokens, a sandboxed runner and a Brain transport. The spec is `vector-at-mention-spec.md`.
  - V00–V19 are done.
  - V20–V23, V26, V28 and V29 are source checkpoints.
  - V24 (desktop controls) and V25 (App UI) are built.
  - Remaining: V27 runtime (save and restore, runner attestation, desktop Brain transport, preview and import), V30 acceptance, and V31 after Codium's A49.
- **VectorScope.** Vector's local AI code review: pull-request list, review runs, findings with evidence, review memory. Remaining work is in `vectorscope-remaining.md`:
  - the VS-12 executor, VS-14, 15, 18, 19 and 26;
  - wiring VS-23/24/25/27/28/34/42/43/44 with defaults unchanged;
  - VS-05 and VS-13, plus the GitHub halves, after @vector;
  - VS-29b, the Codium route.

  VS-38 benchmark runs are the benchmark agent's; leave them.
- **Connected workspace.** The Vector agent connected to VectorScope, Hands, the cloud computer and research, so they hand work to each other. It is behind `VECTOR_EXPERIMENTAL_CONNECT`. Docs: `connected-workspace-spec.md`, `-deviations.md`, `-handoff.md`.
  - CW-01 to CW-09 and C1/C2 are built.
  - CW-20 to CW-25 come after Hands, Codium, @vector, VectorScope and cloud workspaces are in.
  - Turning it on by default (CW-25) is the owner's Q1.
- **Vector everywhere.** An @Vector bot on GitHub, Slack, Linear and Jira, local-first: jobs run on the user's computer through the Remote relay, or in their own GitHub Actions; Vector's servers never hold code. Docs: `vector-everywhere-spec.md`, `-handoff.md`.
  - Phases 1 and 2 are built.
  - Phase 3 (laptop route) comes after Codium; Phase 4 (Actions fallback) after @vector; Phase S (settings, site pages, docs) after that.
  - The owner confirmed the recommended answers to its 14 questions.

### 8.3 Cloud workspaces

Persistent cloud coding sessions, off by default; `packages/cloud-workspaces`. See the table in section 6. Hosting and billing are owner decisions.

### 8.4 Codium follow-ups

On `main`, behind `MODEL_PLANS_ENABLED`. The spec is `docs/vector/build/codium-build-spec.md`; Track B status is `codium-track-b-checkpoint.md`.

- **B09:** desktop and phone paired in a browser, plus the combined Remote authorization regression.
- **B10:** native and browser acceptance for Vault skills and insights.
- **B11:** a performance measurement, recorded with a run id.
- **B08**, after @vector is in, because it shares the Brain transport with V27: the job dispatch screen, the live run reader, Redis/Lua upload hardening, Brain-history encryption.
- **A59:** the joint check with @vector on `main`.
- **A60:** go-live. This is all owner work (section 13).

### 8.5 Version 2.0.0

After the merges, make one change:

- desktop and CLI versions (`packages/desktop/package.json` is 1.99.112);
- `MIN_AGENTS_CLI` in `packages/core/src/github-agents.ts` (it must name a published CLI);
- `MODEL_PLANS_MIN_CLIENT` in `.env.example`;
- `packages/web/test/model-plan-caller.test.ts:45`;
- every user-facing "1.99.113" string: 44+ files, including engine, TUI and app messages, and `release113` copy in docs;
- the live site's "Coming in desktop 1.99.113" in `packages/web/src/data/vector-releases.ts:78-90`;
- the release docs and policy names from #27.

Version checks compare semver, so 2.0.0 keeps them working.

### 8.6 agent-environment

- **The owner's words:** "a main one … you have to give the agent full control of its own terminals and browsers".
- **What it covers:** the agent can create, run, read, send input to, resize and close its own terminals (several at once, in the background), and open, navigate, read, click, type in, screenshot and inspect its own browser tabs.
- **How it must behave:**
  - Safe, visible to the user (indicator and stop) and permissioned.
  - Separate from the user's own terminals and browser profile.
  - Built on `main`'s newer pieces (owned processes, isolated checkout terminals, the built-in browser panel) rather than duplicating them.
- **State:** PR #32 is finishing. Its map of intent versus `main` was in a scratch file that was not saved, so re-derive it from the PR diff and the original commit `0806bafd7` if needed.

---

## 9. Merge order and branch deletion

**Order:**
1. Confirm `main` CI is green.
2. `v2-locks`.
3. `cloud-workspaces`.
4. `v2-hands`.
5. `agent-environment`.
6. `v2-complete` (merge `main` in again after Hands, and resolve).
7. `v2-codium-acceptance`.
8. Native isolation, switched off.
9. Docs branches: `owner-setup`, `build-coordination`, `codium-legal`.
10. Leftovers: `hands-diagnostics`.

Then the follow-ups: B08 and A59, V27/V30, VectorScope modules, CW-20–25, everywhere phases 3/4/S, a single regeneration of SDK, openapi and snapshots, the 2.0.0 change, and a final full CI plus a check of the live site.

**For each merge:**
1. Merge `main` into the branch.
2. Resolve conflicts there, never on `main`.
3. Get full CI and the Vercel preview green.
4. Mark the PR ready.
5. Run `gh pr merge <n> --merge`.
6. Tell the owner one line: what merged and what it changes.

**Deleting branches:** only when `git rev-list --count origin/main..origin/<b>` is 0, or `git cherry origin/main origin/<b>` shows no `+`.
1. Append `| \`<b>\` | \`<sha>\` |` to the "Deleted branches" table in `docs/vector/build/v2-integration.md`.
2. Delete with `gh api -X DELETE repos/scr1pter/claudeondfsfdaf/git/refs/heads/<b>`.
3. Show the owner the final list before the last batch.
4. On the owner's Mac, also remove local branches and the many worktrees under `~/.cache/vector-*` once their work is on GitHub.

---

## 10. How to work efficiently

- **Run one lane per area** on its own branch, in parallel only where the files don't overlap.
- **For each lane:** build, then review from two or three independent angles (correctness and security, data, fit and completeness), repair, CI, merge.
- **Reviews find real bugs.** In every phase so far they did. Don't skip them.
- **Too many lanes at once** clog GitHub's runner queue and the API limit. Three or four at a time is about right.
- **Write findings and plans into `docs/vector/build/`** and push them, so the next person can continue.
- **zsh pitfalls:** write `${SHA}` with braces, and use arrays, not unquoted word lists. Git "gc.log" or "unreachable loose objects" warnings are noise.

---

## 11. The redesign: Vector Signature

- **Live canvas** (claude.ai, private to the owner's account): https://claude.ai/artifact/H5htgm9tPE9WnxNoKMDwAG
- **Source:** `docs/vector/design/signature/`. It has 22 interactive boards in 8 rows: `canvas/*.dc.html` plus `canvas.json`, in the Design canvas format (an `<x-dc>` template and a `class Component extends DCLogic` script).
- **Specs:**
  - `specs/1-concept.md`: the sidebar, `--vxs-*` tokens, native vibrancy (macOS) or Mica (Windows), the Live strip.
  - `specs/2-blend.md`: the blend with today's app. Section 4.4 is the one-row chips; section 6.G is the browser reference; section 10 is the open decisions.
  - `specs/3-screens.md`: Vectorscope, Settings, Tasks, Search, Connected tools, Automations.
  - `specs/4-places.md`: where future features live. Section 7 is the open decisions.
- **What the owner approved and asked for:**
  - **Sidebar and look:**
    - One calm graphite sidebar (#201F24) over an opaque stage (#161519).
    - Five verbs: New session, Search, Automations, Vectorscope, More; On-call is proposed as a sixth.
    - A Live strip for running work, pinned items, host groups, and a composer-centred empty state instead of today's home page.
    - No project logo tiles.
    - The feel of polished desktop coding apps, not Apple's "liquid glass".
  - **Keep from today's app, smaller:**
    - the top buttons: branch, Ready, Tasks, Changes, Terminal, usage pill, context ring, more;
    - the account row: avatar, "You · Codium Max", Help, Settings;
    - the Changes screen, unchanged.
  - **Composer:**
    - The chatbar follows the Signature design.
    - The chips under it are **one row, never two**: the host is an icon with a "This Mac" tooltip, then the project, model, mode, effort, speed and usage ring.
    - On narrow screens it compacts in this order: drop "64%", truncate the model name, hide chevrons, then speed shows its dot only.
  - **Browser** (from the owner's reference):
    - A page tab strip with "+", and dev servers, more, pop-out, expand and close on the right.
    - One slim row: back, forward, reload, a rounded URL field with an accent focus ring, and a pick-element button.
    - The empty state is a centred dev-server card ("vector-web :4321 ▶") that starts the server.
    - Concept A (docked beside the chat) is recommended as the default, with B (full stage) behind Expand and C (device preview with console) behind an Inspect switch.
- **How to build it:**
  - Put it behind a `shell.signature` flag, with tokens in the `--vxs-*` namespace.
  - Start after the merges, because it touches the layout, composer and settings files that every area changed.
  - The owner still has about 30 open decisions across the specs (pickers inside or below, Settings layout, the purple or neutral active state, and so on). Ask them as you reach each one, with your recommendation.

---

## 12. New features after the redesign

All of these are designed on canvas rows 7 and 8; see `specs/4-places.md`.

- **Plan pane** (side panel): the plan Vector writes in Plan mode, as a checklist with step status, sub-steps and files.
  - "Approve and run", "Keep planning" and Edit. They answer the existing plan_exit question.
  - Step comments become chat context.
- **Artifacts pane:** pages, docs, diagrams, reports and screenshots a session made. List grouped by session, a preview, Open, Copy link (share links exist) and Download.
- **iOS Simulator pane:**
  - A live device frame with a device picker, Build and run, rotate, home, screenshot to chat and a logs drawer.
  - A "Vector is tapping" state and a first-time permission ask.
  - The sample app is the Vector phone app.
- **One Panels button** after Terminal opens these panes, also from ⌘K. Tasks, Changes and Terminal stay as they are.
- **On-call** (a sixth sidebar item):
  - An inbox of @vector requests from GitHub, Slack, Linear and Jira, showing who asked, what, Vector's status (working, needs you, PR opened, done, declined) and the result.
  - Rules and on-call hours; Vector never merges or deploys.
  - Teammates' requests are declined at launch.
  - It ties to @vector and Vector everywhere.
- **Computer use as commands, not buttons:** `/computer`, `/cloud`, `/browser`, `/simulator`, `/plan`, `/vectorscope`, also in ⌘K. The composer's cloud button goes away.
- **Walkthrough:** a welcome card plus four short stops (chatbar, sidebar, top buttons, Search). Titles are at most 4 words and sentences at most 16. It shows once and replays from Help › Take the tour.

---

## 13. Owner-only items

These block shipping, not merging. Keep this list current and remind the owner.

- **Hands:**
  - Apple Developer ID and Azure Trusted Signing.
  - Device checks on a clean Mac and Windows 11, and reset on macOS 14, 15, 26 and 27.
  - Legal, name and icon.
  - Decisions O1–O5. Recommended: Preview on dev and beta only until signing; "Vector Hands", after a trademark search; "Alongside me" with "Ask me first"; 30-minute sessions.
- **Codium A60:**
  - The legal read (drafts on `codium-legal`).
  - Stripe; an OpenRouter account and terms; Cloudflare.
  - Signing and HMAC keys, VAPID, vault salt, R2, `remote.vectordev.ai`, Supabase SQL, the Vercel spend webhook.
  - The go-live switches, and the open questions in spec section 8.3.
- **@vector:**
  - Register the GitHub App (not named "vector").
  - Set `VECTOR_RUN_TOKEN_SECRET` and `VECTOR_RUN_ARTIFACT_SECRET`.
  - A live OIDC check and acceptance on a private repository.
- **Vector everywhere:** Slack, Linear and Jira apps; the data key and the offer signing keys; privacy text.
- **VectorScope:** an evaluation key with a $50 limit, a pilot, and publishing the CLI to npm.
- **Cloud workspaces:** the hosting list and the billing decision.
- **Connected workspace:** Q1, and the held-back capabilities that need protected budget files.
- **GitHub:** the `codium-test`, `hosted-production` and `vectorscope-eval` environments, plus branch protection on `main`.
- **Release:**
  - Release-candidate checks RC-01 to RC-12 on Mac and Windows.
  - The default-behavior sign-offs and privacy wording (in #27's release doc).
  - Whether helpers get terminal access, and whether settings import works in non-git folders.
  - Vector Labs on the pricing page, which the current tests forbid.
  - The two Codium sentences on the tokenomics page.
  - Whether to merge `benchmark-before` and `r2-downloads`.
- **Outside:** security reviews of Remote, the hosted computer and the revert-PR path, and a trademark search for "Vector Hands".

---

## 14. Your first hour

1. Clone the repository, and read `docs/vector/build/v2-handoff.md` and this prompt's sections 6 to 9.
2. Check the three CI runs on `main`'s head.
3. For each open PR (#21, #30, #31, #32), check the latest commits, CI and Vercel preview, and continue the one closest to done (`v2-locks`).
4. Start `v2-complete` from `v2-notes/v2-complete-plan.md`. It is the biggest piece and has the most CI rounds.
5. Send the owner a short status: what you found, what you are doing first, and anything you need from them.
