# Vector v2 finish plan

Checked on 2026-11-13 (US time; about 02:30 UTC on 11-14). Reviewed and re-fetched at 02:37 UTC on 11-14 (see "Review notes" at the end). `origin/main` is `0dcbb8e2d`, the PR #20 merge.

**Owner's answers of 2026-11-13** (owner memory note `vector-v2-direction.md`; they postdate the surveys):
- Ownership: the owner put this session in charge of every in-flight area except Hands (Hands stayed with Codex; this session only reported on it).
- Merges: the owner gave a standing yes to merge finished, reviewed, CI-green branches in the planned order, telling the owner after each. It does not cover releases, publishing, branch deletion, public claims or purchases.
- Push main only from `~/.cache/vector-main`, never with `--force` or `--no-verify`.

How this was made:
- Read-only. I ran `git fetch`, `log`, `show`, `diff`, `merge-base`, and `merge-tree --write-tree` / `commit-tree`, which write objects only. I also ran read-only `gh` queries.
- No refs, worktrees or files in the repo were changed.
- The facts come from the seven surveys plus my own checks. Each fact gives its source. "Not checked" means I did not check it.
- Plan, Artifacts, iOS Simulator and On-call belong to the redesign. They are out of scope here.
- Tokenomics and benchmark work was not touched. There are 10 remote branches whose names match `tokenomics|benchmark`. I also left alone a group of 2026-11-04 branches (`cost-profiler`, `compaction-accounting`, `harbor-*`, `funding-*` and others). They are 0 commits ahead of main (`git rev-list --left-right --count`, e.g. `cost-profiler` 264/0, `tokenomics-complete` 267/0), so they hold no unmerged work for this plan. Keep them anyway. `benchmark-before` `3abfbd1c3` (1 commit ahead, 11-10) is benchmark-named: leave it alone.
- Tokenomics files that in-flight branches do edit (review finding): `codium` and `build-integrate` change `packages/web/src/pages/docs/tokenomics.astro` (+5/−2, Codium-label copy; `f254efc5a`, merge `eed4bc45a`). `hands` adds 22 files under `docs/benchmarks/vector-hands-1.99.112/`. Whether the tokenomics agent claims either: not checked. See decision A17.

Scripts and outputs are in the scratchpad: `mt.sh` (pairwise merge check) and `seq.sh` (merge-order simulation).

---

## 0. What changed since the surveys

1. **Hands moved.** `hands` went from `6d23cdb58` to `84b9b5cb2` (2026-11-14 02:25 UTC). That is one commit touching 50 files: "calibrate Windows input and repair native compatibility".
   - It builds **W9**. The hands docs record the owner's approval on 11 November:
     - `hands-deviations.md` diff: "Owner approved on 11 November 2026".
     - `docs/vector/build/evidence/hands-windows-validation-2026-11-13.json`: `"ownerApprovedW9": true`.
   - Running W9 on real Windows hardware is still pending, per that same JSON (`"pending"`).
   - The hands survey's "W9 awaiting decision" is therefore out of date.
   - CI at `84b9b5cb2`, final state: test 43546191575 (dispatch) **failed** one Windows unit fixture (`user-input.nonready-desktop-no-health-or-mutation`, a timing assertion; staged Stop not run). test 43546193426 and Verify 43546193346 were **cancelled**. typecheck 43546193310 passed. Source: `gh run view`, and the `native84Observation` block of the evidence JSON at `6f53a6ec9`.
   - **Hands moved again during the review:** `16e4aead7` (02:32 UTC) and `6f53a6ec9` (02:35:56 UTC, "synchronize detector startup fixtures and collect failures") fix that fixture. `hands` is now 275 ahead of main, 0 behind. CI at `6f53a6ec9` when checked: typecheck 43547212513 passed; test 43547212497 queued; Verify 43547212424 and installers 43547212422 in progress.
   - Three "Vector desktop release" `workflow_dispatch` runs were started on hands heads (43546220810 and 43546899748 cancelled, 43547354444 queued). Publishing needs the `production-release` environment, which requires reviewer scr1pter (`gh api …/environments/production-release`). Whether these runs are dry runs: not checked.
2. **Five branches that no survey covered:**
   - **`build-integrate` `50b4f82c2`** is a combined Codium + @vector candidate (189 ahead of main, 0 behind).
     - It contains the `vector-at-mention` tip and `build-codium`.
     - Merge commit `d8516df3d` reconciles the two Brain transport copies. It also registers the repository handler in Codium's signed webhook router (A47).
     - It adds V24 desktop controls (`e34523980`) and the V25 App UI (`3b2476494`, `packages/app/src/features/github-agents/*`). The @vector survey said neither exists. They exist here, but not on `vector-at-mention`.
     - `merge-tree` against the codium tip shows 0 conflicts. Codium's only later commit, `1ce8f5f30`, has the equivalent `8d5e79a7e` here (`git cherry`).
     - CI:
       - Passed: typecheck 43217014393, GitHub desktop browser validation 43216635830, and Verify 43202774680 (at `ae5e3e61a`).
       - Failed: the "Vector at-mention" lane 43216635783. All 7 sandbox jobs fail at "Prepare the agent sandbox".
       - The `test` workflow has never run on this branch.
     - Its own merge message says it "is not main and does not satisfy A59's actual-main prerequisite".
   - **`build-github-ui` `017f7144b`** is fully inside `build-integrate`.
   - **`build-isolation` `cf34ffe29` and `build-native-shell` `8b2cbc76f`** carry the @vector native isolation of tool processes (V16 native). `build-native-shell` contains `build-isolation` plus 9 commits.
     - They are based on `build-github-ui` `017f7144b` (= `vector-at-mention` `059156a7e` + 7 commits), which is inside `build-integrate`. They are 20 commits behind the `vector-at-mention` tip. After `build-integrate` merges, `build-native-shell` adds 42 commits of its own (115 − 73), none touching `api/` or `packages/web/src/` (`git diff --name-only 017f7144b origin/build-native-shell`).
     - At `93387de55`, test 43320552566 and typecheck 43320558105 passed. At the head, the "Genuine native Shell seam" job 43357191295 failed.
     - `native-isolation-status.md` says: "No production activation is authorized by this document."
     - These branches touch the shared command spawner (`packages/core/src/cross-spawn-spawner.ts`).
   - **`build-process` `a193d18d9`** is inside `process-finish`.
   - **`hands-diagnostics` `ead163391`** is 447 commits behind main. 10 of its 15 commits have no equivalent patch on `hands` (`git cherry`). Whether they were superseded some other way: not checked. `hands-ui-check` is inside `hands`.
   - **`owner-setup` `6f4a7c5bb`** (11-02, 1 commit ahead of main) adds only `docs/vector/owner-actions/codex-setup-prompt.md` (398 lines): an owner prompt for the GitHub App, Slack and OpenRouter setup. No survey covered it.
2b. **New since the plan was drafted: `build-scope-joined` `993c5e15b`** (pushed 02:33:39 UTC on 11-14, author "Vector Build Agent"). 149 ahead of main, 0 behind.
   - It is the VectorScope sibling fold, in progress. It contains `build-scope`, `build-scope-owner` and `build-scope-wire`. It does not yet contain `build-scope-checks` (4 patches missing), `build-scope-ui` (14 missing) or `build-scope-witness` (1 missing) (`git cherry`).
   - Its head commit adds durable review-memory history and guarded transport (18 files, +2,370), including a new core migration `20261113015459_review-memory-fence.ts` and workflow `review-memory-fence.yml`.
   - CI at the head when checked: "Review memory history primitives" 43546996651 passed. "VectorScope repository identity" 43546996592 and "VectorScope local review validation" 43546996604 were in progress. Full `test` has not run on it.
   - **So the VectorScope lane is live**, about 8 minutes after the owner's "take everything" answer was recorded (memory note modified 02:25 UTC). Who runs it: not checked.
3. **Local-only branches** (commits not on any remote, `git rev-list --not --remotes`):
   - `codium-legal` `94a5004ed` (A30 legal drafts).
   - `agent-environment` `0806bafd7`, `r2-downloads` `2f0962576` (marked "parked"), and `ci-tmp-90acb30c`.
     - `agent-environment` is a real feature, not a scratch branch: "give the agent full control of its own terminals and browser", 92 files, +8,720/−988. It is 466 commits behind main and its patch is not on main (`git cherry` "+"). It is in no survey and no merge step. See decision A18.
     - `r2-downloads` (move downloads to Cloudflare R2) was parked by the owner (memory note `vector-release-setup.md`). Its patch is not on main.
     - `ci-tmp-90acb30c` is a temporary CI merge branch from 10-26.
   - `build-everywhere`, named in the everywhere handoff note, is neither on origin nor a local branch in this checkout. Other machines: not checked.
4. **Every push to main deploys production** (review finding; no survey said this).
   - Vercel created Production deployment 7640746112 for `0dcbb8e2d` two minutes after the PR #20 merge. Every earlier main head has one too (`gh api …/deployments?environment=Production`).
   - So each merge publishes its website copy, `api/` functions, redirects and crons to vectordev.ai. Per branch, against main:
     - `codium`: 153 `api/` + `packages/web/src/` files. `build-integrate`: 161 `api/` files and 24 web source files, plus `vercel.json` changes (new `remote.vectordev.ai` and `hosted-run.vectordev.ai` host rules, a build command that also builds the phone app, new crons).
     - `vector-everywhere`: 77 `api/` files (gated by `VECTOR_EVERYWHERE_ENABLED`, `api/_lib/everywhere/config.ts:14`).
     - `hands`: 1 `api/` and 8 web files, including a new public `docs/vector-hands.astro`.
     - `cloud-workspaces`: 3 `api/` and 6 web files, including `pages/workspaces.astro`.
     - `process-finish`, `release-coordination`, `build-scope-joined`, `build-connect` and `build-native-shell`'s own commits: none.
   - The owner's standing merge yes excludes publishing and public claims. See decision A0.
   - Vercel preview is green at every branch head checked (commit status "Vercel"). No preview exists for the combined tree after several merges.
5. **The live website already promises 1.99.113.**
   - `packages/web/src/data/vector-releases.ts:78-90` on main says learned skills, workflow insights and the prompt guard are "Coming in desktop 1.99.113". At least 10 docs pages use `release113` (`git grep release113 origin/main`).
   - "1.99.113" or "199113" appears in 44 files on main and in 45–58 files on each feature branch (`git grep -l`, excluding `docs/benchmarks`). That includes engine, TUI and app messages such as "This server's engine predates 1.99.113" (`packages/engine/src/cli/cmd/tasks.ts:388`).
   - Those version checks compare semver, so any v2 version ≥ 1.99.113 keeps them working (`release113Copy`, `vector-releases.ts:83-87`). The copy still has to change.
6. **Brain migration prefixes collide** (review finding).
   - `codium` adds `20261213000000_codium_brain` and `20261214000000_codium_workflow`. `build-scope-joined` adds `20261213000000_review_memory`, `20261214000000_review_memory_scope` and `20261215000000_review_memory_source` (all under `packages/core/src/brain/migration/`).
   - Ids are the full names, so the `migration` table's primary key does not clash (`packages/core/src/database/migration.ts:30`). The run order comes from the import list in `brain/database.ts`, which both branches edit; it is one of the scope step's conflicts.
   - Whether any user ever ran a build that applied one branch's migrations: not checked.
7. **Every open PR (#21–#28) is a draft** (`gh pr list`). Each must be marked ready before it merges.

---

## 1. Where things stand

Owner column: as reassigned by the owner on 11-13 (see the top). "Orch" is the orchestrator. "Last commit" is the branch's latest committer date in UTC, as of the 02:37 UTC 11-14 fetch.

| Area | Branch / PR | State | CI at head | Remaining | Owner (last commit) | Blocked by |
|---|---|---|---|---|---|---|
| Multi-agent and self-evolving | main `0dcbb8e2d` (PR #20) | Merged on 11-08. Website live (Vercel 7640746112). | Main `test` 42515544563 **red**: 3 cases (isolated checkout terminals on Linux shard 1/4; Vector Local provider identity and background-subagent relay on Windows shard 1/12). typecheck and Verify passed. | Land the fixture fix. Lock follow-ups. RC-01–12. Default-behavior boxes. | Owner (decisions); Orch (code) | #26 merging |
| Main CI fix | `finish-checks`, PR #23 `00b50f72b` | Tests only. Same patch as #26 (`d2156cb2d`, `git cherry` "−"). | Green (42739073332) | Close as superseded | Owner (11-10) | none |
| Background process ownership | `process-finish`, PR #26 `4059f6a70` | Done. Draft, CLEAN. | Green: test 43151685886, Verify 43151685821, typecheck 43151685946, installers 43151686001, Windows containment 43151685952 | Two docs out of date. Decide whether it is in v2. Mark ready. | Orch (11-12 03:55) | v2 scope (A2) |
| Release coordination | `release-coordination`, PR #27 `0c4a0dbd4` | Tooling done. Everything named 1.99.113. | test 43090398876 passed. Verify 43090398965 failed at artifact upload ("Failed to CreateArtifact", a GitHub service error) and was not re-run. | Re-run Verify. Fix 2 website Windows portability failures (PR #27 body). Rename to v2. | Orch (11-11 19:46) | v2 version (A1) |
| Codium | `codium`, PR #24 `1ce8f5f30` | A00–A58 and B01–B11 source done. A59 code exists. A60 not started. | All green: 60 passed, 7 skipped (43190646575, 43190658466, 43190658673, 43190658451, Verify 43190658544) | B08–B11 acceptance. A59 joint check. A60 owner gates. Legal drafts unpushed. | Orch (11-12 09:13, "Vector Build Agent") | Production deploy (A0). Owner gates (Stripe and others). |
| Codium Track B copy | `codium-track`, PR #28 `c262f74b3` | Superseded. Nothing unique. | Red, DIRTY | Close | Owner (11-10) | none |
| Codium + @vector combined | `build-integrate` `50b4f82c2` (no PR) | Integration candidate with V24 and V25 source | Sandbox lane 43216635783 red (7 sandbox jobs fail at "Prepare the agent sandbox"). `test` never run. | Full `test`. Fix the sandbox lane. Open a PR. | Orch (11-12 12:03, "Vector Build Agent") | Codium merging first. Lane stop confirmed (A3). |
| @vector | `vector-at-mention`, PR #25 `c0d10fb85` | V00–V19 done. V20–V23, V26, V28, V29 are source checkpoints. V27 and V30 partial. V31 deferred. V24 and V25 only on `build-integrate`. | `test` 43178097560 **red** in 5 groups. Lane, Verify and typecheck passed. | Fix the 5 groups. V27 runtime. V30. Native isolation. | Orch (11-12 07:46, "Vector Build Agent"; Codex released per the owner) | Codium on main (A47, A49, A59). App registration. |
| @vector native isolation | `build-isolation` (11-12 23:57), `build-native-shell` | In progress, unqualified | Seam job 43357191295 red (also red at the 3 heads before it) | Qualification matrix (`native-isolation-status.md`) | Orch (11-13 03:10, "Vector Build Agent") | Lane stop confirmed (A3) |
| Hands | `hands`, PR #22 `6f53a6ec9` | 73/73 WPs. W9 built (11-13). Native validation open. | Running at `6f53a6ec9`. At `84b9b5cb2`, test 43546191575 failed one Windows unit fixture (fixed at `6f53a6ec9`). At `6d23cdb58`, `computer-helper / windows-build` failed (43167728467). | Windows Stop, Authenticode, ARM64, packaging, device checks, signing | Codex. **Orch read-only.** (11-14 02:35, active) | Owner's signing accounts and device checks |
| VectorScope | `build-scope-joined` `993c5e15b` (fold in progress) ⊃ `build-scope` `0dcd814e6`, `-owner`, `-wire`. Not yet folded: `-checks`, `-ui`, `-witness`. `vectorscope` `bee92d8e9` is stale. | VS-01–12 partly built. VS-12 executor, 14, 15, 18, 19 and 26 missing (`vectorscope-remaining.md`, unchanged at the joined head). | Joined head: lane checks running (§0 item 2b). Last full test 43179368976 (at `8152d3f51`) failed 7 tests. | Finish the fold. Missing modules. Wiring. A PR. | **Live lane** ("Vector Build Agent", 11-14 02:33). Orch only after A3. | Codium and @vector merges. `vectorscope-eval` environment. |
| Cloud workspaces | `cloud-workspaces`, PR #21 `ad81939c7` | Code done, off by default. No activity since 11-08. | `test` 42523459297 red: user-agent compliance failure ("request construction uses Vector identities"), plus a Bun segfault on Linux shard 4/4 | User-agent fix. Merge with Codium's account deletion. Hosting. | Orch (11-08 21:05) | Owner's hosting setup |
| Connected workspace | `build-connect` `168a63037` (no PR). `connected-workspace` `9d77e1942` is inside it, 39 commits behind. | CW-01–09, C1, and C2 with capabilities held back | test 43294716509 and typecheck 43294722508 passed at `6070835df` (head adds only 2 docs files). Verify 43283916158 passed at `00cf720fa`. | Final review. Merge back. CW-08 gaps. CW-20–25. | Orch (11-12 21:03, "Vector Build Agent") | Q1 (A2). A3. Hands, Codium, @vector, scope and cloud-workspaces merges. |
| Vector everywhere | `vector-everywhere` `890bb072b` (no PR) | Phases 1–2 built | Lane 43255025098 passed at head. test 43229955763 passed at `15e92e6ac` (head adds 1 docs commit). Verify never run. | Final review. Runner tests. Verify. Phases 3, 4 and S. | Orch (11-12 16:05, "Vector Build Agent") | A3. Codium and @vector merges. Production deploy of 77 `api/` files (A0). |

Activity (corrected): in the 24 hours before the 02:37 UTC fetch, six branches moved, not one: `hands` (02:35), `build-scope-joined` (02:33, new), `build-scope-owner` (11-13 03:24), `build-scope-wire` (03:19), `build-native-shell` (03:10) and `build-scope` (03:07) (`git for-each-ref --sort=-committerdate`). Five of them are "Vector Build Agent" lanes. That identity also authored the heads of `codium`, `build-integrate`, `vector-at-mention`, `build-connect` and `vector-everywhere`. So the agent behind it is still running, and any of those lanes may resume. Git alone cannot tell which agent or machine is behind it.

---

## 2. What "finished" means before the redesign starts

v2 ships together with the redesign, so there are two levels:
- **Code-finished.** Required before the redesign starts.
- **Ship-ready.** Required before v2 ships. Owner-gated work (keys, legal, signing, live runs) may finish during the redesign.

**Every area is code-finished when all of these hold:**
1. It is on main through a reviewed, non-draft PR (merge commit), merged under the owner's standing yes, with the owner told afterwards. Where the merge changes the public site or `api/`, decision A0 also applies.
2. Full `test`, `typecheck` and `Verify`, plus the area's own lane, are green at the exact merged head. The Vercel preview of that head is green too, because main deploys production.
3. It is off by default unless the owner decided otherwise, and its flag is documented.
4. The progress doc and PR body match the head.
5. No "1.99.113" is left in its user-facing copy, release docs or version pins. Main itself has 44 such files today (§0 item 5).
6. Every remaining owner step is written in `docs/vector/owner-actions/`.

| Area | Code-finished (before the redesign) | Ship-ready (before v2 ships) |
|---|---|---|
| Main / multi-agent | #26 merged. `test.yml` green on main. Branch protection with required checks. The live "Coming in desktop 1.99.113" copy retargeted (`vector-releases.ts:78-90`), with the owner's yes since it is public. | Lock follow-ups decided. Default-behavior boxes accepted (`release-199113.md:240-267` on the `release-coordination` branch; main's copy has only 146 lines). RC-01–12 run on Mac and Windows (`:283-295`, same file). |
| Release coordination | #27 merged with Verify green, and its docs and policy renamed for v2 | Protected publish workflow approved. Privacy wording approved (`:312-330`). |
| Codium | #24 merged. B09, B10 and B11 acceptance recorded with run ids. A59 joint check passing on main. Legal drafts pushed. | A60 owner gates (spec §8.2 steps 2–18). Each perk listed only after its gate. |
| @vector | One branch (`build-integrate`, or #25 redone) merged with full `test` green. V24, V25 and V27 runtime built. V30 journey green in CI. | App registered. Secrets set. Live OIDC and acceptance on a private repo. Native isolation qualified. V31 after A49. Perks listed. |
| Hands | #22 merged with full CI green, including `windows-build`. W9 checked natively. | Signing (Apple Developer ID, Azure Trusted Signing). Device checklists. Reset on macOS 14, 15, 26 and 27. Legal, name and icon. ARM64 packages verified. |
| VectorScope | Siblings folded into one branch (`build-scope-joined` is the live attempt). Missing modules built. Wiring done with defaults unchanged. Brain migration order settled against Codium's (§0 item 6). Full CI green. PR merged. | `vectorscope-eval` key and pilot (D5, D7). The D8, D9, D11 and D12 decisions. |
| Cloud workspaces | User-agent fixed. Merged with Codium's staged deletion. CI green. Merged. | Hosting list in `cloud-workspaces.md:192-199`. Billing decision. |
| Connected workspace | Final review done. One branch merged behind `VECTOR_EXPERIMENTAL_CONNECT` (if Q1 is yes). CW-08 gaps closed. CW-20–25 built after their dependencies. | Decision on the held-back capabilities |
| Vector everywhere | Final review done. Runner tests added. Verify green. Stage A merged. Phases 3, 4 and S built after their dependencies. | VE-50 go-live: platform apps, keys, legal |

---

## 3. Merge order into main

Merges use the owner's standing yes of 11-13: the orchestrator merges a finished, reviewed, CI-green, non-draft PR in this order and tells the owner after each one. Each row says when it is **ready to merge**. Two limits apply:
- Every main push deploys production (§0 item 4). Steps 3, 4, 5, 6 and 9 change the public site or `api/`, so they also wait on decision A0.
- Steps 1, 2, 7, 8 and 10 change no `api/` or `packages/web/src/` file.

Rule for every step: merge current main into the branch first, resolve the conflicts there, and get green CI and a green Vercel preview. Only then does the PR merge cleanly. Never resolve conflicts on main. Push main only from `~/.cache/vector-main`.

Simulated with `seq.sh` (merge-tree plus commit-tree, objects only) from `origin/main`. Re-run at 02:37 UTC 11-14 with `hands` at `6f53a6ec9`: still **68 conflicted files** with `build-scope`, and **69** with `build-scope-joined` in its place (scope step 24).

| Step | Branch / PR | Conflicts | Files and kind | Who resolves | Ready to merge when |
|---|---|---|---|---|---|
| 1 | `process-finish` #26 (then close #23) | 0 | none | none | The two docs are fixed, the PR is marked ready, and #26 is in v2 (A2). CI is already green. |
| 2 | `release-coordination` #27 | 0 | none | Orch | Verify is re-run green. Rename to v2 now, or as an agreed follow-up. |
| 3 | `codium` #24 (then close #28) | 0 | none | Orch (after A3) | A0 is answered. The owner accepts B09–B11 running after merge. Codium stays behind `MODEL_PLANS_ENABLED` (spec §8.2 step 17). The `tokenomics.astro` edit is cleared (A17). |
| 4 | `build-integrate` (as the @vector PR, replacing #25) | 1 | `core/src/cross-spawn-spawner.ts` (against #26). **Semantic**: the process-spawn path. | Orch (after A3) | Full `test` green and the sandbox lane fixed. A0. |
| 5 | `cloud-workspaces` #21 | 3 | `api/account/delete.ts` **semantic**: `closeCloudWorkspaces` has to move into Codium A57's staged `finishAccountDeletion` (`087018aba`). `astro.config.mjs` is mechanical. `AccountPage.tsx` is a copy merge: "credits" against the percentages-only direction. | Orch | User-agent fixed and `test` green. A0 (adds the public `/workspaces` page). |
| 6 | `hands` #22 | 15 | 7 mechanical settings and desktop files (dialog-settings-v2, settings-registry.test, platform.tsx, desktop index.ts, tray.ts, vector-account-runtime.ts, export.ts). `pages/layout.tsx` **semantic**: Codium's Remote `sendPhoneAlert` has to move into Hands' `layout/ask-notifications.ts`. `task/shells.ts` and its test are **semantic and security-relevant**: Hands' `beforeSpawn` recheck must run before #26's owned spawn. `pty.ts`, `ipc.ts`, `ipc-security.test.ts`, `mcp/index.ts` and `tool/shell.ts` are **semantic**: they meet build-integrate's tool-process isolation. | **Codex** (the orchestrator is read-only on `hands`) | Windows Stop and Authenticode fixed and full CI green at head. Or the owner allows merging with Windows packaging gated (A6). Who presses merge: A19. |
| 7 | `build-scope-joined` (or whatever branch the live VectorScope fold ends on) | 24 | 18 against build-integrate and 5 against hands at `build-scope`. The joined head adds `agent/agent.ts`, `cli/cmd/review.ts`, `session/session.ts` and `pull-requests.tsx`. **Semantic**: the review engine (`review/run.ts`, `ai-review.ts`, `review/model.ts`, `review/types.ts`, `review.render.ts`), `brain/database.ts` and its migration tests (migration-prefix collision, §0 item 6), `session/prompt.ts`, `session/llm/request.ts`, `tool/glob.ts` and `tool/grep.ts`. Mechanical: `.prettierignore`, `model-plans.test.ts`, `select-v2.tsx`. | The live VectorScope lane, or Orch after A3 | Fold finished (`-checks`, `-ui` and `-witness` still missing), full `test` green, PR open |
| 8 | `build-connect` | 20 | Regenerate the two SDK `types.gen.ts` files and `openapi.json`. Semantic against scope: `read-only-git.ts`, the experimental httpapi routes, `server.ts`, `engine-capabilities.ts`. Against hands: `permission/index.ts`, `tool/registry.ts`, `subagent-config.test.ts`. | Orch (after A3) | Q1 is yes, final review done, fresh `test`/`typecheck`/`Verify` |
| 9 | `vector-everywhere` | 1 | `local-run.test.ts`: one comment hunk. Both sides carry the same fixture fix. Mechanical. | Orch (after A3) | Final review and Verify done. Owner's yes to the Stage A PR (A2). A0 (77 `api/` files reach production, gated by `VECTOR_EVERYWHERE_ENABLED`). |
| 10 | `build-native-shell` (@vector native isolation) | 5 | `cross-spawn-spawner.ts`, `directory-identity.ts` (against scope), `vector-at-mention.yml`, `github-agents.test.ts`, `github.agent-phase.test.ts` | Orch (after A3) | Qualification passes (`native-isolation-status.md:25`, "No production activation is authorized") |

Dependencies checked: cloud-workspaces after codium (A57 deletion); hands after codium (`layout.tsx`) and after build-integrate (tool isolation); scope after build-integrate (VS-05/13) and hands; connect after scope (VS-08/10) and hands (CW-21); everywhere Phases 3–4 after codium and @vector; native-shell after build-integrate (it is based on `017f7144b`, inside build-integrate). No order violation found. One sequencing gap was missing: **`agent-environment` (§0 item 3) has no step.** It is 466 behind main, and `merge-tree` against current main already shows 19 conflicted files. It shares 22 changed files with `hands`, 10 with `build-integrate` and 7 with `build-connect` (`git diff --name-only` intersections). If A18 keeps it, it needs its own step and a fresh conflict check.

Notes on the counts:
- Conflicted steps were committed with their markers left in, so the counts are upper bounds. They roughly match the pairwise sums:
  - build-scope × build-integrate: 18
  - build-scope × hands: 5
  - build-connect × build-integrate: 3, × hands: 9, × build-scope: 12
- Alternative orders, totals (at the original heads, not re-run):
  - Connect before scope: 71.
  - Hands third: 72. Codium then takes 8 and build-integrate 7.
  - Native-shell right after build-integrate: 71.
  - Scope before hands: 68, a tie. Hands first is still preferred because CW-21 depends on hands. The reason "Codex is active now" also argues the other way: the scope lane is the one active right now. Re-run when both are done.
- **Why `build-integrate` instead of #25.** It already settles the 6 Brain add/add conflicts that the codium × vector-at-mention merge would raise. Against codium it has 0 conflicts. The owner must still review `d8516df3d`, which decides "which Brain copy wins".
- **The VectorScope sibling fold, sequential from main:** checks 0, ui 1, owner 13, wire 1, witness 2. The live lane has already folded `owner` and `wire` into `build-scope-joined`.

---

## 4. Remaining build work

Under the owner's 11-13 answer, the orchestrator owns every item except Hands. The tags now say whether it can start without colliding with a live agent. Dates are each branch's last commit (UTC) at the 02:37 UTC 11-14 fetch.
- **[ORCH: free]**: no other agent has committed there recently. Start on a new branch cut from the head and open a PR into it, or push to the branch after re-fetching.
- **[ORCH: after A3]**: the branch's head is a "Vector Build Agent" commit, and that agent was still pushing at 02:33 UTC 11-14. Start only after the owner confirms that agent is stopped (A3), and re-check the branch's last commit right before pushing.
- **[ORCH: LIVE]**: an agent committed there in the last hour. Do not take it.
- **[CODEX: Hands]**: Codex's work. The orchestrator reports it to the owner as a todo and changes nothing.
- **[OWNER]**: needs the owner, a test machine or an outside party.

**Main and finishers**
1. Bring #26's `process-ownership-followup.md` (line 69, "pending") and the `multiagent-parity-deviations.md` heading (line 2354, "native Windows acceptance pending") in line with run 43151685952. Mark #26 ready. [ORCH: free. `process-finish` 11-12 03:55.]
2. After #26 merges, run `test.yml` on main and confirm it is green. [ORCH: free. Dispatch only.]
3. Lock follow-ups: `forceRemove` ignores delete errors, the twin `flock.ts` mkdir handling, and `LockCompromisedError` without a message (`multiagent-parity-deviations.md:2345-2349`). [OWNER decides, then ORCH: free.]
4. #27: re-run Verify, fix the 2 website Windows portability failures (PR #27 body, last paragraph), and rename `release-199113.md`, `policy-199113.json` and related docs for v2. [ORCH: free. `release-coordination` 11-11 19:46. The owner released Codex from it.]
5. RC-01 to RC-12 on Mac and Windows, on the final v2 candidate, with a disposable profile and an exclusive window (`release-199113.md:283-295` on `release-coordination`). [OWNER: needs a test machine and an operator.]
6. The free full-timeline benchmark (`release-199113.md`, "Preparation"). [OWNER. Benchmark work belongs to the tokenomics agent; leave it alone.]
6b. Retarget the live site's "Coming in desktop 1.99.113" copy (`packages/web/src/data/vector-releases.ts:78-90` and the ≥10 docs pages that use `release113`) to v2. It is public copy, so it needs the owner's yes (A0). [ORCH: free, on a new branch.]

**Codium** (`codium` 11-12 09:13, "Vector Build Agent")
7. B09: desktop and phone paired in a browser, plus the combined Remote authorization regression. [ORCH: after A3]
8. B10: native and browser acceptance for Vault skills and insights. [ORCH: after A3]
9. B11: the performance measurement, with a run id. The PR #24 body cites a receipt without an id. [ORCH: after A3]
10. B08: dispatch UI, live-run reader, Redis/Lua upload hardening and Brain-history crypto. [ORCH: after A3. Was Codex's GitHub lane.] Whether `build-integrate` already covers part of it: not checked.
11. A59: the joint check on main after step 4 of §3, then the live @vector runs before listing. [ORCH: after A3, then OWNER for live runs.]
12. Gateway: accept images on Hands turns (`docs/vector/owner-actions/hands-release.md:51` on `hands`). [ORCH: after A3] Whether it is already built: not checked.
13. Push `codium-legal` `94a5004ed`. It exists only locally, in `~/.cache/vector-codium-legal`, because the pre-push typecheck blocked it (`codium-a30-legal-notes.md`). [ORCH: free. Push to a new branch from a machine where the hook passes; never `--no-verify`.]

**@vector** (`vector-at-mention` 11-12 07:46; `build-integrate` 11-12 12:03; both "Vector Build Agent")
14. Fix the 5 red `test` groups at `c0d10fb85`:
    - The plan-name check (`codium-plan-names.test.ts:93` against `vector-at-mention-progress.md:1042`).
    - The help snapshot (`help-snapshots.test.ts:144`).
    - Registering the 6 address-writing files in the connection inventory.
    - Windows `writeBundle` at 384 vs 438 bytes (`github.bundle.test.ts:578`).
    - `core.hooksPath` (`github.agent-fixture.ts:76`).

    Re-checked failing names in 43178097560: connection inventory, "old numbered name" plan check, agent-phase "no reaction, comment, push or network git call", help-text snapshots, and 5 `writeBundle` cases. Whether `build-integrate` still has them: not checked (`test` never ran there). [ORCH: after A3. Work on a new branch off `build-integrate`.]
15. Fix the `build-integrate` sandbox lane (43216635783: all 7 sandbox jobs fail at "Prepare the agent sandbox"; engine and core, hosted API and desktop bundle pass), run the full `test`, and open the PR. [ORCH: after A3]
16. V27 runtime: save/restore, runner attestation, desktop Brain transport, preview/import. The transport is shared with B08. [ORCH: after A3. Was Codex.]
17. Native isolation qualification: installed-runtime observer, immutable installer, baseline matrix, Engine-death cells (`native-isolation-status.md`). [ORCH: after A3. `build-native-shell` 11-13 03:10, about 23.5 h before the fetch.]
18. V30 full acceptance after V24, V25 and V27. V31 after A49 is on main. Update the progress doc and the PR body. [ORCH: after A3. Was Codex.]

**Hands** (`hands` 11-14 02:35, active). Read-only for the orchestrator: these go to the owner as a todo for Codex.
19. Windows staged native Stop: `guardian-observe-reply-negative-low32-tag-candidate`, failing in run 43167728467 (job 131020775740). At `84b9b5cb2`, staged Stop did not run because a unit fixture failed first (43546191575). [CODEX: Hands]
20. The Windows Authenticode observer (43167720423) and Windows installer packaging (43154306544). [CODEX: Hands]
21. Show that isolated capture is stable across repeated runs. Run W9 natively on Windows (evidence JSON: `"nativeExecution": "pending"`). [CODEX: Hands]
22. ARM64: isolated scenarios, the packaged self-test, and final x64/ARM64 package verification. [CODEX: Hands]
23. Full regression, Hands UI and benchmark at the final head. Update the PR #22 body. [CODEX: Hands]
24. Confirm the 10 unique `hands-diagnostics` patches are superseded. Deleting the branch afterwards needs the owner's yes. [CODEX: Hands, then OWNER]
24b. Merge current main (after steps 1–5) into `hands` and resolve its 15 conflicts there (§3 step 6). [CODEX: Hands. The orchestrator must not do this, because it would change `hands`.]

**VectorScope** (`build-scope-joined` 11-14 02:33, live)
25. Finish the fold: `build-scope-checks` (4 patches), `-ui` (14) and `-witness` (1) are not yet in `build-scope-joined`. Then run full `test`/`typecheck` and fix the 7 failures from 43179368976. [ORCH: LIVE. The lane is doing this now.]
26. VS-10 app adapter and its acceptance. `vectorscope-remaining.md:18-19` assigns it to the Codium agent. [ORCH: after A3]
27. The VS-09 ninth browser case. VS-11 namespace and controls, coordinating dismissal writes with connect (`remaining.md:46`). [ORCH: LIVE for the VectorScope half; after A3 for the connect half]
28. Build VS-12 executor, VS-14, VS-15, VS-18, VS-19 and VS-26 (`remaining.md:47-55,66`). Wire VS-23/24/25/27/28/34/42/43/44 with defaults unchanged (`:101-104`). [ORCH: LIVE]
28b. Settle the Brain migration order against Codium: both add `20261213000000_*` and `20261214000000_*` (§0 item 6). Pick one order in `brain/database.ts` and renumber the later branch's migrations before any build ships them. Add a test that the import list is in strictly increasing prefix order. [Whoever resolves step 7]
29. After the merges: VS-05, VS-13 and the GitHub halves of VS-16/20/32/47 (after @vector); VS-29b and the Codium route for VS-23/33 (after codium). [ORCH: after A3, or the live lane]
30. VS-38 benchmark runs (`remaining.md:83`). [OWNER. It touches benchmark work, so leave it until the owner says otherwise.]

**Cloud workspaces** (`cloud-workspaces` 11-08 21:05)
31. Change the user-agent `"Vector-Cloud-Workspaces"` at `packages/cloud-workspaces/src/github.ts:57` so it passes the compliance test "request construction uses Vector identities and no borrowed app registrations" (`packages/engine/test/compliance/upstream-free.test.ts:92-106`). The rule at `:102` accepts only "Vector" alone or followed by `/` or whitespace, so the hyphen fails; for example, `Vector/cloud-workspaces` passes. Then re-run `test`. [ORCH: free]
32. After codium merges: merge main in, move `closeCloudWorkspaces` into `finishAccountDeletion`, and align the AccountPage copy with percentages. [ORCH: free, after step 3 of §3]

**Connected workspace** (`build-connect` 11-12 21:03, "Vector Build Agent")
33. Review Phase C2 as a whole, run the final whole-branch review, then fresh `test`, `typecheck` and `Verify`. Merge `build-connect` back, or choose the PR branch. [ORCH: after A3]
34. CW-08 gaps: `vector run` does not wait for a background review, reverting does not cancel the review, and `connect_fix` is listed even with the flag off. [ORCH: after A3]
35. CW-20 to CW-25 after their dependencies: VS-08 and VS-10, hands, @vector, codium, cloud-workspaces, and Q1. [ORCH: after A3]

**Vector everywhere** (`vector-everywhere` 11-12 16:05, "Vector Build Agent")
36. Final review of `a6db1513d..HEAD`. Runner test cases for stop, lost, 404 and 409, heartbeat failure and question rejection. A `Verify` run (never run on this branch). [ORCH: after A3]
37. Phase 3 (VE-20–22) after codium and R-C1–C4, C6, C11. Phase 4 (VE-30–33) after @vector, A59, R-A1–A9 and Q13. Phase S (VE-40–44) after the next large merge. [ORCH: after A3]
38. Prerequisites from main's owners: R-M2 (shell sandbox), R-M3 (outward audience) and Codium's deletion adapter. [ORCH: free once Codium is on main]

**Cross-cutting**
39. Retarget the version for v2 in one coordinated change after the merges. The surveys listed only these:
    - `packages/desktop/package.json` is 1.99.112 on every branch checked (re-checked on 10 branches).
    - `MODEL_PLANS_MIN_CLIENT=` is empty (`.env.example:90`).
    - `packages/web/test/model-plan-caller.test.ts:45` pins 1.99.113.
    - `MIN_AGENTS_CLI = "1.99.113"` (`packages/core/src/github-agents.ts:12` on `build-integrate`).
    - VectorScope's D14.

    The real scope is larger: 44 files on main and up to 58 on a branch mention 1.99.113 (§0 item 5), including CLI, TUI and app messages and the live website copy. [Waits on A1. ORCH: free, on a new branch after the last merge.]
40. One design review of the process-spawn hot spot before steps 4, 6 and 10 of §3. Four lanes touch it: #26's owned process, Hands' `beforeSpawn`, @vector's tool isolation and the native lifecycle owner (`cross-spawn-spawner.ts`, `task/shells.ts`, `pty.ts`, `tool/shell.ts`, `mcp/index.ts`). [ORCH: free. Read-only review; write the findings for the resolvers, Codex included.]
41. Regenerate the SDK types, `openapi.json` and the help snapshot once after the hands and connect merges. [Whoever merges]
42. Before steps 3–6 and 9: check a Vercel preview of the branch with current main merged in. Main deploys production directly, and the combined tree has never had a preview. [ORCH: free]

---

## 5. Owner decisions and actions

### A. Decisions (with the recommended answer where a spec gives one)

Renumbered in review: A0, A3, A17–A19 and A21 are new; the old 3–16 moved. The **first three to answer are A0, A3 and A1** (see Review notes).

| # | Decision | Recommended answer (source) |
|---|---|---|
| A0 | **Merges deploy production.** Every main push deploys vectordev.ai (Vercel 7640746112 for `0dcbb8e2d`). Steps 3–6 and 9 of §3 publish new site copy, `api/` functions, host rules and crons (§0 item 4). Your standing yes covers merges but excludes publishing and public claims. Choose one: (a) merges may deploy, with every new feature flagged off and new public pages reviewed by you first; (b) pause Vercel production deploys from main until v2 ships (a Vercel setting only you can change); (c) integrate on a separate `v2` branch and merge to main once, at v2. | No spec answer. Until it is answered, only steps 1, 2, 7, 8 and 10 can merge, since they change no `api/` or web source. |
| A1 | The v2 version string, the minimum client, and `MIN_AGENTS_CLI` (it must name a published CLI) | No spec answer. Branches cannot retarget until it is chosen. Any semver ≥ 1.99.113 keeps the existing version checks working (`vector-releases.ts:83-87`). The live site says "Coming in desktop 1.99.113" today (§0 item 5). |
| A2 | Scope of v2: is #26 in? (`release-integration-2026-11-09.md` says "unknown") Is VectorScope user-facing? (replaces D14, `plan.md:34`) Connected workspace Q1: may it land behind `VECTOR_EXPERIMENTAL_CONNECT`? Yes to the PRs for everywhere Stage A and for connect? | No spec answer for #26 or D14. Everywhere Q1 says Stage A may land "after review" (handoff rules). |
| A3 | **Stop or keep the "Vector Build Agent".** It pushed `build-scope-joined` at 02:33 UTC 11-14, after your "take everything except hands" answer. It also authored the heads of `codium`, `build-integrate`, `vector-at-mention`, `build-native-shell`, `build-connect` and `vector-everywhere`. If it keeps running while the orchestrator takes those areas, two agents will commit to the same branches. Choose: stop it everywhere now, or let it finish VectorScope's fold (§4 item 25) and stop the rest. | No spec answer. Until it is answered, the orchestrator takes only the [ORCH: free] items in §4. |
| A4 | Use `build-integrate` as the @vector integration branch, which accepts its Brain reconciliation (`d8516df3d`)? | No spec answer. It avoids redoing 6 semantic conflicts (§3). |
| A5 | V25 App UI: keep the version built in the current UI on `build-integrate`, or fold it into the Signature redesign? The same question applies to Hands settings, VectorScope VS-09/20 and everywhere Phase S. | No spec answer |
| A6 | Hands: may it merge to main while the Windows package stays gated, so the redesign can start? | No spec answer. Offered as an option. |
| A7 | Hands O1–O5 (`hands-build-spec.md:945-949`) | O1: macOS Hands on dev and beta only, labeled Preview, until Developer ID ships. O2: "Vector Hands" (backup: Deskhand), with a trademark search first. O3: "Alongside me", with "Ask me first" for the pointer. O4: 30 minutes, with a company maximum. O5: as listed (off until onboarding, keep-awake on, screenshots kept 7 days, …). W9 is already approved (11-11, `hands-deviations.md:1262`). |
| A8 | @vector O1–O15 (`vector-at-mention-spec.md:467-485`) | The spec says build with the defaults. For example: O1 accepts only `@<slug>`. O5: anyone with write access spends the binder's plan, within caps. O8 timeouts are 135, 60, 15, 5, 3 and 20 minutes. O12: artifacts kept 7 days, bundles 1 day. O14: `GITHUB_TOKEN` by default. O15: Codium refuses self-hosted runners. |
| A9 | Codium §8.3 "Still open" (`codium-build-spec.md:1073-1083`) | Renewal grace 120 minutes. Partial refunds: "no change to access". Upstash plan: no default. Bound-repo spenders: anyone with write access. Velocity binding future pricing: no default. Stripe Tax: decide with an accountant. Cloud computer brand name: no default. Sol `azure`-only: Sol stays staged until decided. |
| A10 | Default-behavior boxes (`release-199113.md:240-265` on `release-coordination`): skill learning at Review first; workflow defaults at Apply; helper limits 8/32/$25 (guests 4/8/$5); no auto-resume; workflow ceilings; prompt-guard acknowledgement; settings-save behavior | Accept the recorded defaults (the packet lists them as current behavior) |
| A11 | Two PR #20 owner questions, both "kept safe for now" (owner memory note `multiagent-parity-build.md`): (1) helper terminal access; (2) whether settings import works in shared non-git folders. The surveys listed only (1). | For (1): PR #20 says "safe default", while `release-199113.md:254` says "Current behavior is retained". The two must agree; pick one. For (2): no spec answer found. |
| A12 | VectorScope: does the 11-11 authorization cover Q15, Q18 and Q45? Also Q1–Q17, including D15 (ZDR default), D16 and Q13 (wiring). | Not given in the docs I read |
| A13 | Connected workspace: the three held-back capabilities need changes to protected budget and prompt files | No spec answer. Overlap with tokenomics: not checked. The connect handoff says "no protected budget implementation changed" (`connected-workspace-handoff.md`, 11-12 update). |
| A14 | Cloud workspaces: owner (now the orchestrator), billing separate from Codium, and the "credits" wording | The owner's Codium direction is percentages only, with no tokens or price |
| A15 | Close PR #23 and PR #28 as superseded | Close both (nothing unique: `git cherry`, patch-ids). Closing is reversible; deleting the branches is a separate yes. |
| A16 | Lock follow-ups (`multiagent-parity-deviations.md:2345-2349`) | No spec answer |
| A17 | Codium edits a tokenomics file: `packages/web/src/pages/docs/tokenomics.astro` (+5/−2, explaining that Codium steps show the label "Codium" instead of tokens or price). Your rule is never to touch tokenomics files. Allow it in the Codium merge, or ask the tokenomics agent to take that copy? | No spec answer |
| A18 | Unmerged work outside every survey: `agent-environment` (agent controls its own terminals and browser; 92 files, local only, 466 behind main, 19 conflicts with main), `r2-downloads` (parked by you), `owner-setup` (owner setup prompt, on origin). In v2 or dropped? | No spec answer. If kept, `agent-environment` needs its own merge step. |
| A19 | Who presses merge on Hands (#22)? The orchestrator is read-only on Hands, but merging changes only main. | No spec answer. Suggest: Codex resolves the conflicts on `hands`; the orchestrator merges under the standing yes once Codex says it is done. |
| A20 | PR #20 leftovers: check the live site (preview step); the production app benchmark | No spec answer |
| A21 | Vector Labs on the pricing page. On 10-27 you asked for it to be listed as coming (memory notes `codium-and-hands-build.md`, `codium-tier-direction.md`). The current tests forbid it: `CodiumPricing.test.ts:142,224` and `ModelPlans.test.ts:158` expect no "Vector Labs", on main and on `build-integrate`. | Open since 11-02 |

### B. Registrations, keys and accounts

- **GitHub**
  - Create the `codium-test`, `hosted-production` and `vectorscope-eval` environments. Only Preview, Production and production-release exist today (`gh api …/environments`).
  - Add branch protection with required checks on main (`gh api …/branches/main/protection` returns 404).
  - Register the GitHub App, not named "vector". Save the webhook only after the A47 router is deployed. `owner-setup` `6f4a7c5bb` (`docs/vector/owner-actions/codex-setup-prompt.md`) has an older setup prompt for this.
  - Stop the "Vector Build Agent" lanes, or say which may continue (A3). Only you can see where that agent runs.
- **Vercel**
  - Production auto-deploy from main: keep, pause or redirect, per A0.
- **Codium** (`codium-build-spec.md` §8.2):
  - Stripe (steps 5–7).
  - OpenRouter account, top-up and resale terms (step 8).
  - Cloudflare (step 11).
  - Signing and HMAC keys, VAPID, vault salt, R2, and `remote.vectordev.ai` (step 12).
  - Supabase SQL (step 13).
  - Vercel spend webhook and the written Sandbox OK (step 14).
  - Go-live switches (step 17).
- **@vector:** `VECTOR_RUN_TOKEN_SECRET` and `VECTOR_RUN_ARTIFACT_SECRET`. Keep `VECTOR_GITHUB_BRAIN_ENABLED` off.
- **Hands:** an Apple Developer ID and Azure Trusted Signing (`docs/vector/owner-actions/hands-release.md:47` on `hands`). Approve any `production-release` deployment the hands lane requests; it requires your review.
- **VectorScope:** a key with a $50 limit (D7) and the pilot (D5). Publish the CLI to npm with @vector (D9).
- **Everywhere:** Slack, Linear and Jira apps, the data key and the offer signing keys (VE-50).
- **Cloud workspaces:** the hosting list in `cloud-workspaces.md:192-199`.

### C. Legal and outside reviews

- Codium legal read (step 15), including `codium-privacy-proposed.patch`.
- The Hands legal draft, final copy, helper name and icon.
- The @vector `#codium-github` text and stored-data list.
- The everywhere privacy text.
- Outside security reviews of Remote, the hosted computer and the revert-PR path (step 16).
- A trademark search for "Vector Hands".

### D. Manual checks

- Hands checklists on a clean Mac and on Windows 11. Reset on macOS 14, 15, 26 and 27 (`hands-release.md:22-45`).
- RC-01 to RC-12.
- @vector: decode one live OIDC token per event, and run acceptance on a private test repo.

---

## 6. Risks and how to reduce them

| Risk | Facts | How to reduce it |
|---|---|---|
| Stale and duplicate branches | `vectorscope` is 165 behind main. `hands-diagnostics` is 447 behind. `cloud-workspaces` had no owner from 11-08 until the owner's 11-13 answer. Areas with two or more branches: vector-at-mention / build-github-ui / build-integrate / build-isolation / build-native-shell, connected-workspace / build-connect, vectorscope / build-scope + 5 siblings + build-scope-joined. | Name one integration branch per area (step 1 of §7). Close the superseded PRs (#23, #28). Retiring `codium-track`, `finish-checks`, `vectorscope` and `hands-diagnostics` (after item 24) is branch deletion, which needs the owner's yes. |
| Very large diffs | `build-integrate`: 931 files, +170,003. Codium: 727 files, +123,367. Hands: 275 commits (at `6f53a6ec9`). | Review per area. Focus human review on the semantic files listed in §3. Let CI cover the rest. |
| Semantic conflicts | Process spawn (4 lanes, security-relevant). Account deletion (A57). `layout.tsx` notifications. The review engine. `brain/database.ts` and its migrations: Codium and VectorScope reuse the prefixes `20261213000000` and `20261214000000` (§0 item 6). | Resolve inside the branch with tests: one asserting the `beforeSpawn` recheck runs before the owned spawn, and one checking migration order (item 28b). Do the design review (item 40) first. |
| Flaky CI | Bun segfault (42523459297), Chocolatey 504 (43229955763, first attempt), ripgrep 504 (42465100323), GitHub artifact upload error (43090398965), Windows 60 s timeouts (42515544563) | Re-run once and record that it was a re-run. Keep a list of known flakes. Never count a red job as green. |
| Main is red and unprotected | Main's only `test` run failed (42515544563), and main has no protection | Land #26 first. Then add required checks. |
| Version drift | 1.99.112 and 1.99.113 strings across branches: 44 files on main, up to 58 on a branch. The live site promises "desktop 1.99.113". | Retarget the live copy early (item 6b, with A0). Do one code retarget after the merges (item 39). |
| Collision with the redesign | Hands settings and layout, V25 App UI, everywhere Phase S and VectorScope UI touch files the redesign will likely rework. That is an inference from the conflict lists, not checked. | Merge those areas before the redesign starts, or decide (A5) to fold their UI into it |
| Agent collisions | Six branches moved in the 24 hours before 02:37 UTC 11-14, five of them "Vector Build Agent" lanes. `build-scope-joined` was pushed at 02:33, after the owner's answer, and `hands` at 02:35. | Get A3 answered before taking any "Vector Build Agent" branch. Re-fetch and compare the branch's last commit right before every push. Never push to `hands`. |
| Production publishing | Every main merge deploys vectordev.ai (§0 item 4). The standing merge yes excludes publishing. | A0 first. Check a combined Vercel preview before each publishing merge (item 42). |
| Owner's machine | Local test suites crashed the owner's Vector app before (owner memory note) | Run heavy suites in CI only |
| Unpushed work | `codium-legal` exists only locally (`~/.cache/vector-codium-legal`). So do `agent-environment`, `r2-downloads` and `ci-tmp-90acb30c`. | Push `codium-legal` (item 13). Decide the others (A18). |
| Tokenomics | Protected budget files may overlap connect's held-back capabilities (not checked). Codium edits `docs/tokenomics.astro` (A17). | Don't touch them. Ask the owner. |

---

## 7. Suggested sequence for the next few days

**Day 1**
- Owner, in this order:
  - A0 (merges deploy production), A3 (stop or keep the "Vector Build Agent"), then A1 (the v2 version).
  - Close #23 and #28 (A15).
  - Answer A2 (#26 in v2, Q1 for connect, Stage A for everywhere), A4 (`build-integrate` as the @vector branch), A5 (the V25/UI question) and A18 (`agent-environment`).
  - Create the three GitHub environments.
- Orchestrator, [ORCH: free] items only: the #26 docs and ready flag (item 1), the cloud-workspaces user-agent (item 31), #27's Verify re-run and portability fixes (item 4), pushing `codium-legal` (item 13), and the read-only spawn design review (item 40).
- Codex: continue the Hands Windows fixes. CI at `6f53a6ec9` is running. The orchestrator only reads it and reports.
- **Merge #26** under the standing yes, once it is ready and A2 says it is in v2. Then run `test.yml` on main. Add branch protection once it is green (an owner setting).

**Day 2**
- **Merge #27** (Verify re-run, renamed, or with an agreed rename follow-up). It changes no web or `api/` file.
- **Merge #24 (Codium)** once A0 and A17 are answered and A3 lets the orchestrator take it.
- Orchestrator, after A3: merge main into `build-integrate` on a new branch, fix the sandbox lane and the 5 test groups, run the full `test`, and open the PR.
- VectorScope: the live lane, or the orchestrator if A3 stops it, finishes the fold and runs full CI.
- Orchestrator, after A3: final reviews and Verify for connect and everywhere.

**Day 3**
- **Merge `build-integrate` (@vector)** (A0, A4). Then run the A59 joint check on main.
- Orchestrator: cloud-workspaces main merge, `delete.ts` and copy fixes, then **merge #21** (A0).
- Owner: start the registrations in §5 B (GitHub App, Stripe test mode, Cloudflare).

**Days 4–5**
- **Merge Hands** once Codex has merged main into `hands`, the Windows gates pass (or A6 allows a gated merge), and A19 says who merges.
- **Merge the VectorScope branch, then `build-connect`, then `vector-everywhere`** (A0 for everywhere). Regenerate the SDK files once.
- Then the dependent work: CW-20–25, VE Phases 3, 4 and S, VS-05/13/29b, V27/V30/V31, and native isolation (step 10 of §3).

**The redesign starts when** every area meets §2 "code-finished", main is green at the final merge, and the v2 version is set. The "ship-ready" gates are carried into the redesign as a tracked list. The redesign itself also waits on the owner's verdict on the concept boards and their open decisions (owner memory note `vector-signature-design.md`); that is outside this plan.

---

## Review notes

The review ran read-only on 2026-11-14 at about 02:37 UTC: `git fetch origin --prune`, `log`, `show`, `diff`, `cherry`, `merge-base`, `merge-tree --write-tree` / `commit-tree` (objects only), and read-only `gh`. No refs, worktrees or repo files were changed. Tokenomics and benchmark branches were only counted, never touched.

**Re-checked and confirmed:**
- The main `test` failure and its 3 cases (42515544563).
- #23's patch is inside #26 (`d2156cb2d`).
- #27's Verify failure was the artifact-upload service error (`Failed to CreateArtifact`).
- The `build-integrate` facts: 189/0; `d8516df3d` merges `9d0e29b24` and `c0d10fb85` and contains the quoted A59 sentence; V24 `e34523980` and V25 `3b2476494` are on it and not on `vector-at-mention`; all 7 sandbox jobs fail at "Prepare the agent sandbox".
- The @vector red groups (43178097560).
- The cloud-workspaces user-agent (`github.ts:57`).
- `desktop/package.json` 1.99.112 on 10 branches; `MIN_AGENTS_CLI`, `MODEL_PLANS_MIN_CLIENT`, and the `model-plan-caller.test.ts:45` pin.
- The W9 approval quote (`hands-deviations.md:1262`).
- No branch protection on main; only Preview, Production and production-release environments exist.
- The local-only branches.
- `connected-workspace` ⊂ `build-connect`.
- The spec line citations sampled: `hands-build-spec.md:945-949`, `codium-build-spec.md:1073`, `release-199113.md:240-330`.
- The merge simulation: 68 files at the new hands head.

**What changed:**
1. **Ownership and merge authority.** Added the owner's 11-13 answers (memory note `vector-v2-direction.md`): the orchestrator takes everything except Hands; Hands is read-only; there is a standing merge yes that excludes publishing. All owner columns and tags in §1, §3 and §4 were reassigned. "NOBODY", "Codium agent", "@vector lane", "Connect agent" and "Everywhere agent" became the orchestrator. Codex keeps only Hands. Merge rows now read "ready to merge", not "ready to ask".
2. **Agent activity was wrong.** "Only `hands` moved in the last 24 hours" was false. Six branches moved, and five are "Vector Build Agent" lanes. A new branch, `build-scope-joined` `993c5e15b`, appeared at 02:33 UTC, after the owner's answer. Added §0 item 2b, a corrected activity line, collision tags ([ORCH: free] / [ORCH: after A3] / [ORCH: LIVE] / [CODEX: Hands]) on every §4 item, and decision A3.
3. **Hands moved twice more.** It went `84b9b5cb2` → `16e4aead7` → `6f53a6ec9`. Test 43546191575 at `84b9b5cb2` failed (one Windows unit fixture). It had been reported "in progress". Runs 43546193426 and 43546193346 were cancelled, not "queued" or "in progress". New CI ids were added. Three `Vector desktop release` dispatches on hands were noted; whether they were dry runs was not checked. Added item 24b: Codex must merge main into `hands` itself.
4. **Missing area: main deploys production** (§0 item 4, decision A0, item 42, a risk row, a §2 criterion). Every main push creates a Vercel Production deployment. Codium/build-integrate (161 `api/` files, `vercel.json` host rules and crons), cloud-workspaces, hands and everywhere (77 `api/` files) would publish on merge. The standing yes excludes publishing.
5. **Missing area: the live site promises 1.99.113** (§0 item 5, item 6b, A1). The source is `vector-releases.ts:78-90`. The version retarget (item 39) was understated: 44 files on main mention 1.99.113, not 5 spots.
6. **Missing area: Brain migration prefix collision** between Codium and VectorScope (`20261213000000`, `20261214000000`). Added §0 item 6, item 28b and the risk row.
7. **Missing areas: unmerged work outside the surveys.** `agent-environment` is a real 8,720-line feature with 19 conflicts against main, overlapping hands (22 files), build-integrate (10) and connect (7). `owner-setup` is a docs-only owner prompt. Added A18 and a note in §3 that `agent-environment` has no merge step.
8. **Missing owner decisions:** A11(2), settings import in shared non-git folders (PR #20 leftover); A17, Codium's edit of the tokenomics file `docs/tokenomics.astro`; A19, who merges Hands; A21, Vector Labs listing versus the tests that forbid it.
9. **Tokenomics facts.** The 11-04 tokenomics/benchmark branches are 0 commits ahead of main, so they hold no unmerged work; they were "not checked" before. `hands` adds 22 files under `docs/benchmarks/vector-hands-1.99.112/`.
10. **Merge order.** Re-simulated at current heads: 68 with `build-scope`, 69 with `build-scope-joined` (scope step 24 files). Step 7 now names the joined branch and its extra files. Dependencies were re-verified and no order violation was found. The "hands before scope because Codex is active" reason was qualified, since the scope lane is the active one now. Steps 1, 2, 7, 8 and 10 can merge before A0, because they change no `api/` or web source.
11. **Native isolation base corrected.** `build-isolation` and `build-native-shell` are based on `build-github-ui` `017f7144b` (inside `build-integrate`), not only on `vector-at-mention` `059156a7e`. After `build-integrate`, they add 42 commits and no web or `api/` files.
12. **Small corrections:**
    - Every open PR is a draft.
    - The `release-199113.md` line citations are on `release-coordination`; main's copy has 146 lines.
    - The compliance rule is at `upstream-free.test.ts:102`, not `:106`.
    - Everywhere's `test` pass and connect's `test` pass are one docs-only commit behind their heads.
    - The Hands commit count is now 275.
    - Branch deletions (`codium-track`, `vectorscope`, `hands-diagnostics` and others) are flagged as needing the owner's yes.
    - The §6 and §7 decision references were renumbered (old 1–16 → A1, A2, A4–A16, A20).
13. **Not checked:**
    - Who runs the "Vector Build Agent", and whether it will stop.
    - Whether the hands release dispatches were dry runs.
    - Whether the Codium gateway already accepts Hands images.
    - Whether `build-integrate` still has the 5 @vector test failures.
    - Vercel function or cron limits for the combined tree.
    - Whether anyone ran a build that applied either branch's Brain migrations.

**The three things the owner must decide first:**
1. **A0: merges deploy production.** Every main merge publishes vectordev.ai (Vercel 7640746112 for `0dcbb8e2d`). Codium, @vector, cloud workspaces, Hands and everywhere would push new pages, 160+ `api/` files, host rules and crons live. The standing merge yes excludes publishing. Choose: (a) merges may deploy with features flagged off and new public pages reviewed, (b) pause production deploys from main until v2, or (c) integrate on a `v2` branch.
2. **A3: stop or keep the "Vector Build Agent".** It pushed `build-scope-joined` at 02:33 UTC 11-14, after the "take everything" answer, and authored the heads of Codium, @vector, native isolation, connect and everywhere. Until it is stopped, or limited to VectorScope, the orchestrator can safely take only #26, #27, cloud workspaces, `codium-legal` and the read-only spawn review.
3. **A1 with A2: the v2 version string and scope.** The live site promises "desktop 1.99.113"; 44 files on main pin it; `MIN_AGENTS_CLI` must name a published CLI. Scope covers whether #26, user-facing VectorScope (D14), connect behind its flag (Q1), everywhere Stage A, and `agent-environment` (A18) are in v2.
