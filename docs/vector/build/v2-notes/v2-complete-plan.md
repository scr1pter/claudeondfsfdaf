# `v2-complete` integration plan (@vector, VectorScope, connected workspace, Vector everywhere)

Read-only planning pass, 2026-11-14 17:00 UTC. I used only `git -C ~/.cache/vector-review-main fetch/log/show/diff/cherry/merge-tree`. No worktree was created, nothing was committed or pushed, and no `gh` call was made. The merge simulations are `git merge-tree --write-tree` (objects only). Their raw output is in `scratchpad/v2c/mt-*.txt`.

## 0. Heads at 17:00 UTC (re-fetch before acting)

| Ref | Head | Note |
|---|---|---|
| `origin/v2` | `54fa0f8c7` | main `0dcbb8e2d` + `8fecdf108` (CI on v2) + #26 `8f2da56c9` (PF `3ec7fb14b`) + #27 `320b74cdf` (RC `4df0956d9`) + #24 `88d006c5b` (codium `1ce8f5f30`) + docs `54fa0f8c7` |
| `origin/build-complete` | `00b87034f` (06:45 UTC) | first parent is the `build-integrate` line. It merges `build-candidate` `7a0de3003`/`dfc26ee93` (joined scope `3bb2b2ba2` + connect `a8234d9ac`), `build-everywhere` `5053d4907` (`vector-everywhere` `890bb072b` + 1 test commit) and `build-integrate` `29603fc90`/`ceed2426a`. Its own commits are `31c4eb724`, `cd89435f2`, `c291eb969`, `5724d45be`, `75532fc36`, `65b97c98a`, `10051211b` and `00b87034f`. |
| `v2-vector` (local) | `5dbdcfb46` | `build-integrate` `ceed2426a` + `origin/v2` `54fa0f8c7` + 5 own commits |
| `origin/v2-scope` | `76b5619f1` | joined + `build-scope-witness`/`-ui`/`-checks` + `origin/v2` + 4 own commits |
| `v2-connect` (local) | `0c58e7f69` | `build-connect` `a8234d9ac` + `origin/v2` + 1 own commit |
| `v2-everywhere` (local) | `40e708614` | `build-everywhere` `5053d4907` + `origin/v2` + 2 own commits |

Merge base of `origin/v2` and `build-complete`: `9d0e29b24` (codium, one commit before its tip).

Out of scope, and confirmed absent: `hands` (0 of its 292 commits are in build-complete or in any lane), `build-native-shell` and `build-isolation` (0 commits).

---

## 1. What each side has that the other lacks

### 1.1 In build-complete, not in v2 (353 non-merge commits; 952 files, +270k/−12k)

- **@vector** (`build-integrate`, 106 commits): V1–V25, desktop main V24 `e34523980`, App UI V25 `3b2476494`, the V16 bubblewrap floor, Codium×GitHub authority (`d8516df3d`), Brain bundle and proposal staging (`a80513a1c`, `85eb2abed`, `0808ccb6d`), and test repairs `e88012584` and `ceed2426a`.
- **VectorScope** (joined `3bb2b2ba2`, 145 commits), plus the candidate fixture repairs `9c57ad47c`…`dfc26ee93` (Linux-only private-review gating, mock-engine browser fixtures, Brain inventory test repairs `237c72fdc`).
- **Connected workspace** (`a8234d9ac`, 59 commits).
- **Vector everywhere** (`890bb072b` + `5053d4907`, 25 commits).
- **build-complete's own work:**
  - `31c4eb724`: the BI×candidate merge. It resolved 20 files (remerge-diff): `run.ts`, `prompt.ts`, `notify.ts`, `pull-requests.tsx`, `ai-review.ts`, `glob.ts`, `grep.ts`, `request.ts`, the Brain files and others.
  - `cd89435f2`: the everywhere merge.
  - `75532fc36`: everywhere account admission is bound to deletion authority.
  - `10051211b`: connect reviews run through the qualified ReviewService (`connect/review-service.ts`).
  - `00b87034f`: connected stages survive role resolution (`orchestration/runs.ts`).
- **CI evidence.** No CI receipt exists for `00b87034f` itself. The build-night doc covers `build-candidate` at `95be592d8`/`85b21cb4b`/`b0c9f4bb5` and everywhere at `5053d4907` (43556164842, green). Its "General regressions" run 43553379862 was still running when the doc was written.
- **New workflows only on build-complete:** `vector-at-mention.yml`, `github-desktop-validation.yml`, `vector-everywhere.yml`, `scope-app-validation.yml`, `scope-directory-identity.yml`, `review-memory-fence.yml` and `connect-app-validation.yml`. The temporary ones are `github-compat.yml`, `candidate-compat.yml`, `review-host-compat.yml`, `app-attribution.yml`, `connect-guest-diagnostics.yml` and `review-http-regression.yml`.

### 1.2 In v2, not in build-complete (30 commits; `git cherry` marks 28 "+")

- **#26 process ownership:**
  - `11111071f` (`OwnedProcess`, ShellJobs ordering, the Windows holder and Job Object).
  - `d2156cb2d`, which already has an equivalent in build-complete ("−").
  - The Windows containment series `71b22a807`…`4059f6a70`, docs `2a489ab00` and `3ec7fb14b`, and `windows-containment.yml`.
- **#27 release coordination:** `02098b2b6`, `1df6150a4`, `82a7d26ce`, `4cf195e93`, `9aece4c4b`, `f9773571e` and `0c4a0dbd4`, plus `57d615df9`, `220c50662` and `4df0956d9` (`scripts/release-readiness/**` and the `docs/vector/build/evidence/**` evidence files).
- **Codium tip:** `1ce8f5f30`. build-complete has the same patch as `8d5e79a7e`, so nothing from Codium is missing.
- **CI triggers:** `8fecdf108` (`test`, `typecheck` and `verify` run on v2).
- **Docs:** `54fa0f8c7`, which adds `v2-integration.md` and `v2-spawn-review.md`.

---

## 2. Merging `origin/v2` into build-complete

`git merge-tree --write-tree origin/build-complete origin/v2` gives tree `2bd086320`, exit 1, and **1 conflict**.

| File | Conflict | Resolution |
|---|---|---|
| `packages/core/src/cross-spawn-spawner.ts` | Import line only (merged tree `:27-31`): `ProcessIsolation` (BI) against `OwnedProcess` (#26). The spawn body auto-merges into the shape the spawn review flags: `ProcessIsolation.launch` runs bare inside `Effect.callback` (`:303`), and the pre-spawn canceller sends SIGTERM to the direct child only (`:336-339`). | **Keep both imports and apply spawn-review §4.1.** C4: compute the plan in `Effect.try`, so a refusal is `PlatformError("spawn")`. C10: the canceller calls `owned.stop` when `owned` is set. The ownership key stays the caller's command object. Release, `kill` and `bind` stay as in PF. **v2-vector already holds exactly this:** merge `6ceeddda8` plus `6d4af65b8` (`v2-vector:cross-spawn-spawner.ts:27-28,295-306,347`). |
| `packages/engine/src/task/shells.ts` (no textual conflict) | C2: #26's Windows background path calls `WindowsProcess.start` (`:594`, its own spawn), so it never reaches `ProcessIsolation.launch`. | Refuse with the other refusals at the top of `ShellJobs.start`, before the lease, slot or row. This is in `6d4af65b8`: `isolationRefusal` at `v2-vector:shells.ts:96`, used at `:462`. |
| Auto-merged; check them | `test.yml` (+`v2` push), `typecheck.yml` (+`v2` push and PR), `verify.yml`, `local-run.test.ts` (build-complete's `snapshot` stub at `:804`; the `:1353` comment ends up byte-identical to v2's) | None needed. |

**How to execute.** Merge `v2-vector` first. It contains `origin/v2` at `54fa0f8c7` with the resolution above, and `merge-tree origin/build-complete v2-vector` is **clean** (tree `2d83f72dd`). Its spawner, `shells.ts` and `process-isolation.ts` equal v2-vector's, and the tree differs from build-complete in 79 files. Then run `git merge origin/v2`. It is a no-op unless v2 has moved. Do not hand-resolve v2 first and then merge v2-vector: the virtual merge base would re-conflict the spawner.

**Spawn-review rules, as they apply here** (Hands is not in this branch):
1. Hands' recheck before `background.start`. It does not apply now. When Codex merges `hands` into v2, the recheck goes right after the log opens and before `const metadata` (`shells.ts` ~`:540`), as §4.2 describes. Record that in the PR body.
2. One signaler per spawn. Holds: the owned group (POSIX), the holder's Job Object (Windows) or main's group kill. There is no native owner in this branch.
3. The owner is outermost. Holds: `OwnedProcess.track` wraps the process from `launch`. With `FLOOR=false` (`202b18947`) there is no bwrap wrapper at all.
4. The Windows background path is refused when `required()`. Holds via `6d4af65b8`. `ProcessIsolation.decide` also refuses every hosted launch off Linux, whether or not the floor is on (`v2-vector:process-isolation.ts:98`).
5. New gap found in this pass: two VectorScope spawn sites never consult the floor:
   - `core/src/directory-identity.ts:745`
   - `core/src/read-only-git.ts:565`

   Both spawn a fixed Python with `-I -S`. Either refuse them when `ProcessIsolation.required()`, or list them with the fixed system helpers in the spawn review's BI note. Tier A, small.
6. Tests the spawn review asks for (§5, step 4):
   - S4-1: existing tests.
   - S4-4: present in `6d4af65b8` (`core/test/effect/cross-spawn-spawner.test.ts`, "hosted isolation").
   - S4-3 is only a pure unit (`shells.test.ts`). Add the child-fixture Windows case: REFUSAL, no holder, no row, slot released.
   - S4-5 (C10 interrupt kills the group) is missing. Add it.
   - S4-2 (owned under bwrap) is moot while `FLOOR=false`. It moves to the native-isolation gate.

**Brain migrations.** The v2 merge on its own causes no Brain conflict. But build-complete orders `codium_brain 20261213`, `review_memory 20261213`, `codium_workflow 20261214`, `review_memory_scope 20261214`, `review_memory_source 20261215` (`brain/database.ts:27-31,73-77`), which shares prefixes. The renumbering arrives with `v2-scope` (§3.2):
- `20261216`/`17`/`18`, each with `replaces: [old id]`;
- `migration.ts` support for `replaces`;
- `export const migrations`;
- ordering tests in `database.test.ts` and `database-migration.test.ts`.

**Generated files.** After all merges, regenerate once and never edit by hand:
- `bun script/generate.ts` from the root: SDK `gen/types.gen.ts`, `v2/gen/types.gen.ts`, `sdk.gen.ts` and `openapi.json`;
- `packages/engine/script/schema.ts`: `packages/web/public/config.json` and `workflow.json`;
- the CLI help snapshot: `bun test --timeout 30000 test/cli/help/help-snapshots.test.ts --update-snapshots` from `packages/engine`;
- `packages/core` `bun run migration` only if `migration.gen.ts` drifts.

Commit only real drift.

---

## 3. The stopped lanes

### 3.1 `v2-vector` → **merge** (clean; do it first)

| Commit | What | In build-complete? |
|---|---|---|
| `709f81127` | cherry of `3d7283bda`: retired numbered plan label (red group 1) | No. build-complete still has the retired label at `vector-at-mention-progress.md:1042`. |
| `676674c17` | agent-phase test uses `process.getBuiltinModule` (red group 5) | No. build-complete still has `require(...)` at `github.agent-phase.test.ts:442-443`. |
| `202b18947` | **Fix A**: `ProcessIsolation.FLOOR=false` (`process-isolation.ts:13`), `decide()`, bounded `namespaceProbeFailure` (`github.sandbox.ts:537`), the probe floor fields, and the deviation "V16 bubblewrap floor held" | No. build-complete has no `FLOOR`, so all 7 sandbox jobs stay red (C1 AppArmor userns, C2 nested bwrap under an empty `/proc`). |
| `6d4af65b8` | Spawn review §4.1: C4, C10 and C2, plus tests | No |
| `02b6dda0c` | progress doc | No |
| merges `6ceeddda8`, `131ddd546` and `5dbdcfb46` | v2 and `build-integrate` `ceed2426a` | `ceed2426a` is already in build-complete. |

Judge's call on Fix A: **accept.**
- Hosted activation stays off (`VECTOR_CLOUD_AGENTS_ENABLED` unset), and native isolation is the ship gate.
- The kernel path guard, the loader refusal, the off-Linux refusal, the separate UID, the FD3 proof and UID-wide cleanup are all kept.
- Fix B (an AppArmor profile) needs a security review. Not in this branch.

### 3.2 `origin/v2-scope` → **merge** (after v2-vector; 13 conflicts)

Own commits not in build-complete:
- `d1e9b6283`: lanes on `v2-scope`.
- `c8e3ca185`: Brain renumbering with `replaces` and ordering tests.
- `aa90a172e`: main's `model-plans.test.ts`.
- `b48a7ac4f`: Read and Grep keep a denied link name refused after Windows resolves it, plus `read-authority.test.ts` (all OSes).

The folded scope branches:
- `build-scope-checks`, `-ui` and `-witness`: 22 commits show "+" in `git cherry`, but their source is already in joined (squashed).
- The only new file is `.github/workflows/scope-ui-validation.yml`.
- The merge records that ancestry, so `git cherry v2-complete origin/build-scope-{checks,ui,witness}` comes out empty.

`merge-tree origin/build-complete origin/v2-scope` gives 14 conflicts. The spawner one disappears once v2-vector is in. Resolutions:

| File (hunks) | Resolution |
|---|---|
| `.github/workflows/review-memory-fence.yml`, `scope-app-validation.yml`, `scope-directory-identity.yml` (1 each) | Replace `build-candidate`/`v2-scope` with `v2` in `push.branches`. Keep `workflow_dispatch` (v2-scope adds it to scope-app). Do the same in `scope-ui-validation.yml`. Do not add `v2-complete` to push: dispatch instead, to save runs. |
| `core/src/brain/database.ts` (2), `core/test/brain/database.test.ts` (1), `migration-learned.test.ts` (2), `migration-knowledge.test.ts` (1) | **Take v2-scope's files whole:** `git checkout origin/v2-scope -- <4 paths>`. Reason: `migration-knowledge.test.ts` **auto-merges badly**. It imports the 4 `BrainReviewMemory*` tables twice (merged `:29-37`), lists them twice in `TABLES` (`:81-91`), and leaves the old `20261213000000_review_memory` id outside the hunk (`:189`). After the checkout, check that `git grep -nE '2026121[345]0{6}_review_memory'` outside the `replaces:` lines prints nothing. The renamed files `20261216/17/18*.ts` come in through rename detection. |
| `core/test/model-plans.test.ts` (1) | Take v2-scope's, which is main's test unchanged. That empties the scope diff and lets hands' later version merge cleanly. build-complete's controlled-pending rewrite also passes, but it would conflict with hands. |
| `engine/src/review/run.ts` (5) | Imports and the `checkedLabs` block: take **ours** (build-complete). Pure placement. The verify-budget hunk (`~:947`): take **v2-scope's order**, `overTokenStop` first. Otherwise `lift()` calls `input.projection.overCap` (`run.ts:373-380`) for a pass the token stop then skips, against the comment "The Codium token stop … no projection lifts it". |
| `engine/src/server/routes/instance/httpapi/server.ts`, `session/prompt.ts`, `app/.../ai-review.ts` (3), `engine/test/review/model.test.ts` (2) | Ours. Same lines in another order, and build-complete's import list also has `ConnectOwner`. |

Not conflicted but must survive:
- `grep.ts`/`read.ts`/`external-directory.ts` from `b48a7ac4f` merge cleanly.
- Keep build-complete's Linux-only gate on the review-runner retarget case (`run.test.ts:204,2252`), because the runner needs the Linux pinned-directory adapter.
- The new all-OS `read-authority.test.ts` case covers Windows.

### 3.3 `v2-connect` → **cherry-pick `0c58e7f69`** (`git cherry-pick -x`), do not merge

- It is the only commit not in build-complete. It registers `connect_fix` only while `VECTOR_EXPERIMENTAL_CONNECT` is on; build-complete still registers it unconditionally (`agent/agent.ts:563-569`, `:862`). It touches `agent.ts` and `agent.test.ts`, and `merge-tree` reports no conflict there.
- The lane's merge `b6e147ec9` is a second resolution of connect×codium, which build-complete already did (`31c4eb724` and `00b87034f`). Merging the branch would give 4 conflicts, all resolved to ours with no content gain:
  - `app/e2e/tsconfig.json`: ours is a superset (`github-agents.spec.ts`, `directory-review.spec.ts`);
  - `orchestration/runs.ts`: ours is `00b87034f`;
  - `httpapi/server.ts`;
  - `task/notify.ts`: the union order of the kinds.
- If the cherry-pick conflicts anyway, merge the branch instead and take ours on those 4 files.

### 3.4 `v2-everywhere` → **merge** (clean after v2-vector; its only conflict against build-complete is the spawner import)

| Commit | Fix | In build-complete? |
|---|---|---|
| `bc6ed6cfd` | Allows inert git config keys (`core.symlinks`, `remote.*.gh-resolved`, VS Code keys, partial clone), keeps refusing the dangerous ones, logs the decline reason, adds tests | No. `everywhere-git.ts` there is identical to `890bb072b`. |
| `40e708614` | Numeric `ZSCORE` for Linear and Jira cooldowns (`linear/cooldown.ts`, `store.ts` `storeInteger`), plus `everywhere-cooldown.test.ts` | No. build-complete still requires a digit string: `linear/adapter.ts:88`, `jira/client.ts:18`. |

---

## 4. Findings: fixed in build-complete, fixed by a lane, or remaining

Tiers: **A** = must land before the PR is ready (security or privacy, off-by-default compliance, changes that reach every user, CI hygiene). **B** = fix in this branch (flagged features that do not work). **C** = defer with a deviation entry or a follow-up PR.

### 4.1 Connect (`review:connect:fit` F#, `review:connect:correctness-security` C#)

| Finding | Status | Evidence / action |
|---|---|---|
| F1 HIGH: two review start paths | **Partly fixed** by `10051211b`: execution goes through ReviewService (`connect/review-service.ts`, `hub.ts:1000-1018`) | Still there: `ConnectGit.query` translator (`connect/git.ts:38,234`), connect owner routes (`groups/connect.ts:22,44`), file ledger (`directory-request.ts`). **C**, waits on the Q6 owner decision; record it in the deviations doc. |
| F2 MED: typecheck breaks | **Fixed** | `runs.ts` by `00b87034f`. MCP `snapshot` is optional (`mcp/index.ts:255`). |
| F3 MED: old read-only-git copy | **Fixed** | `git diff build-scope-joined build-complete -- core/src/read-only-git.ts core/test/read-only-git.test.ts` is empty. |
| F4 / C2 HIGH: macOS/Windows refuse, but members show "ready" | **Remains** | `adapters/vectorscope.ts:368-380` never checks the platform. `read-only-git.ts:998,1211` require Linux. **A**: `describe()` returns `unavailable` with a plain reason off Linux. Docs: "Linux only until private-Git adapters". |
| F5 / C11 MED: `canonicalScope` in `Effect.promise`; InstanceStore rewrite | **Remains** | `config/config.ts:1909,1977`. **A**: `Effect.tryPromise` with a typed error that falls back to the old behaviour. Record both general changes in the deviations doc. |
| F6 MED: conflicts and generated files | **Fixed in build-complete** (regenerated); the hands part is n/a | Regenerate once more after §3 (§2). |
| F7 LOW: connect lanes are branch-bound; diagnostics scaffolding | **Remains** | `connect-app-validation.yml:2-5` (push `build-connect`/`build-candidate`, no dispatch); `connect-guest-diagnostics.yml` and `engine/test/diagnostics/auth-guest-preload.ts`. **A**: add `workflow_dispatch` and `v2` to the app lane. Delete the diagnostics workflow and the preload. |
| F8 / C8 LOW: visible with the flag off | `connect_fix`: **fixed by `0c58e7f69`**. The rest **remains**. | `index.ts:195` always registers `ConnectedCommand`. `orchestration/guide.txt:11-13` describes connected stages to every model. `web/public/config.json:1142,1155` advertises `repair` and `max_rounds`. **A** (off-by-default rule): hide the command, append the guide paragraph only with the flag on, mark `repair` not available. |
| F9 LOW: repair held only by `tightenLease` duck-typing | **Remains** | `task/notify.ts:329,879,906`. **A**: an explicit `REPAIR_AVAILABLE = false` gate plus a deviation entry. |
| F10 LOW: docs | **Remains** | Handoff checkpoint `a8234d9ac`; CW-08 is 2/3 closed; replace the `main`/1.99.113 wording with v2/2.0.0. **B** (docs commit). |
| C1 HIGH: secret files reach the review model | **Remains** | `policy.ts:670-694` still drops review-denied patterns (`:690`). `hub.ts:1012` feeds `readPatterns(rules)` into the qualified service, and `cli/cmd/review.ts:284,381` filters the diff only by those denies. So an untracked `.env` or `*.key` still lands in the prompt. **A**: build the diff denies from the requester's rules **without** the review-deny exemption (every changed, untracked and old path through `evaluate("read", …)`), and refuse or drop them before `working`. Add a test with an untracked `.env` and a modified `.env.development`. |
| C3 MED-HIGH: `target: branch` needs a 40-hex base | **Remains** | `connect/git.ts:281` (`defaultBranch: fail`). **B**: resolve the named ref to a SHA before `ConnectGit.use`, and implement `defaultBranch`. |
| C4 MED: failed fresh-instance cleanup poisons the directory and `disposeAll` | **Remains** | `project/instance-store.ts:381-389` is unchanged from `a8234d9ac`. **A** (reaches every user): mark the directory unconfirmed, drop it from `fresh`, settle `released`, and catch per owner in `disposeAllOnce`. |
| C5 MED: plain `git status` cancels a background review; costly checks | **Remains** | `read-only-git.ts:1469,1685,1696` (`unchanged`). **B**: compare HEAD plus the index tree OID and persist the private index. **C** for startup temp cleanup. |
| C6 MED: directory-review key stuck `pending`; ledger never pruned | **Remains** | `connect/owner.ts:393-448`. **B**: bind or release in `onExit`, reconcile orphans, prune. |
| C7 LOW-MED: `connect_write` approval shows no diff | **Remains** | `tui/.../permission.tsx:460`; `session-permission-dock.tsx:81`. **A**: show `metadata.diff`. |
| C9 LOW: `run --attach` leaves reviews running | **Remains** | `cli/cmd/run.ts:1095`. **B**: `client.connect.cancel` per `cr_` id when not in-process. |
| C10 LOW: session ask rules never reach the fix child | **Remains** (documented A3) | **A**: pass the requester's ask rules into `fixAgentRules`, or run `checkReads` on the child's worktree. |

### 4.2 Everywhere (`review:everywhere:fit` F#, `review:everywhere:correctness-security` C#)

| Finding | Status | Evidence / action |
|---|---|---|
| F1 MED: lane does not know v2 | **Remains** | `vector-everywhere.yml:15-16,60,103`, `everywhere-lane.test.ts:152-155,324-358`. **A**: add `v2` to push, the scope-job path filter and the per-run concurrency group. Add `api/_lib/codium-keys.ts` and `integrations/linear/**` to the paths, and update the lane test. Do the same in `vector-codium.yml`. |
| F2 LOW: `local-run.test.ts:1353` comment | **Fixed by the merge** | The merged tree equals v2's file apart from build-complete's `snapshot` stub. |
| F3 LOW: docs | **Remains** | `handoff.md:7,77,100,107,130-131`, `spec.md:3,686,803`, and the local path at `spec.md:879` (replace it with `origin/connected-workspace:docs/vector/build/connected-workspace-spec.md`). **B**. |
| F4 LOW: erase registration and sweep cron | **Remains** | No `everywhere` in `api/_lib/codium-erase.ts` or `vercel.json`. **A**: Codium and everywhere now share this branch, so register `EVERYWHERE_ERASE_PART` via `registerErasePart`. **C** (owner activation note): add the `* * * * *` cron before any deployment with the flag on. |
| F5 LOW: engine test imports desktop | **Remains** | `engine/test/everywhere/unattended-session.test.ts:9`. **C**: deviation entry, or move the client into `core/everywhere`. |
| F6 LOW: second keep-awake owner | **Remains** (not wired) | **C** (VE-21). |
| C1 MED: valid repos declined as not mapped | **Fixed by `bc6ed6cfd`** | |
| C2 MED: numeric cooldown scores | **Fixed by `40e708614`** | |
| C3 MED: failed settle after push reported as nothing published | **Remains** | `everywhere-runner.ts:262-276,134,186` are identical to `890bb072b`. **B**: retry the `changes` settle after a push, never send another outcome, and keep the deadline signal away from push. Add tests. |
| C4 MED: Linear refresh can break the install | **Remains** | `linear/credentials.ts:71-88`. **B**: save the rotated pair before `viewer`. |
| C5 LOW: ledger release in `finally` | **Remains** | `everywhere-runner.ts:281-282`. **B**. |
| C6 LOW: 1 MB cap on the whole buffer | **Remains** | `everywhere-engine.ts:89-90`. **B**. |
| C7, C8 LOW: GitHub status lock and `bodySha256` (not wired, Phase 4) | **Remains** | **C**. |
| `75532fc36` (not a finding) | New in build-complete: admission bound to deletion authority | Keep. |

### 4.3 @vector plan note (`at-vector-v2-plan.md`)

| Item | Status |
|---|---|
| Sandbox lane C1/C2 | **Fixed by `202b18947`** (Fix A) from v2-vector. |
| Red group 1 (`codium-plan-names.test.ts:93`) | **Remains in build-complete → fixed by `709f81127`.** |
| Red group 2 (help snapshot) | `run --phase` fixed in build-complete (`ceed2426a`, `65b97c98a`; snapshot `:890`). Whether `github review --help` differs is unknown. Regenerate once (§2) and let CI decide. |
| Red group 3 (egress inventory) | **Fixed** (`e88012584`). |
| Red group 4 (Windows `writeBundle`) | Rewritten in `e88012584`. **Windows is unproven**; the first `test.yml` Windows shard is the proof. |
| Red group 5 (agent-phase `require`) | **Remains in build-complete → fixed by `676674c17`.** |
| Bounded probe diagnostics | **Fixed by `202b18947`** (`namespaceProbeFailure`). |
| V24 version flip (`core/src/review/workflow.ts:18` is still `"2"`) | **Remains.** **B**, together with the `brain_upload` input below. Golden updates are listed in plan §3 V24. |
| V24/V25 progress entries; V25 copy outside `i18n/en.ts` | Remains. **B**: docs or a deviation. |
| V27 runtime: engine save and restore, `attestSessionArtifact` has no caller (`github.session-proof.ts:35`), no `brain_upload` workflow input (dispatch at `api/_lib/github-app.ts:725`; inputs at `workflow.ts:768-773`) | **Remains.** Behind `VECTOR_GITHUB_BRAIN_ENABLED` (off). Declare the `brain_upload` input (**B**, small). Save, restore and attestation are **C**: a follow-up PR into v2 with a deviation entry. |
| `github-compat.yml` is temporary | Remains. **A**: delete it before the PR is ready. |
| A1 `vectorRequiredCliVersion` `1.99.99` (`desktop/package.json:6`) | Owner (needs a published CLI). |

### 4.4 VectorScope plan note (`vectorscope-v2-plan.md`)

| Item | Status |
|---|---|
| #1–7 e2e settings (Playwright) | Source fixed in joined (`19953ba2a`, `8b2a3a747`, …). **Unproven in CI.** `scope-ui-validation.yml` arrives only with the v2-scope merge. |
| #8 `model-plans.test.ts:138` | Fixed in build-complete (controlled pending, `237c72fdc`). Replaced by `aa90a172e` (main's version) during the merge (§3.2). |
| #9 Windows read-denial retarget (security) | build-complete only **hid** it: `run.test.ts:2252` is `linuxInstance`. **The real fix is `b48a7ac4f`** (Read, Grep and listings under both spellings, with an all-OS test). |
| #10–13 Brain tests | build-complete added the inventory but kept the shared prefixes. **Superseded by `c8e3ca185`** (renumbering plus ordering tests). |
| F4 lanes | **`d1e9b6283`**, retargeted to `v2` and dispatch (§3.2). |
| F7 semantic resolutions (review engine × Codium) | Resolved in build-complete `31c4eb724`, but **no test** shows that a Codium-routed review still passes scope's admission and history fence (no `codium` case in `engine/test/review/{run,service,local-admission}.test.ts`). **A**: add one test. |
| VS-11 remainder, VS-12 executor, VS-14/15/18/19/26, key wiring VS-23…44 | Not built. **C**: each one off by default; separate PRs into v2. |

---

## 5. Order of work (write steps)

All commands run in `<worktree>`.

```sh
export PATH=$HOME/.bun/bin:$HOME/.local/node/bin:$HOME/.local/bin:$PATH
export TURBO_CACHE_DIR=<worktree>/.turbo-cache
```

1. Create the worktree: `git -C <worktree> fetch origin && git -C <worktree> worktree add -b v2-complete <worktree> origin/build-complete`.
   - Then `git branch --unset-upstream`, so a bare push cannot hit `build-complete`.
   - Set the identity if none exists: "Vector <bot@vectordev.ai>".
   - Check that `.turbo-cache` is ignored.
2. `git merge v2-vector`: clean. Then `git merge origin/v2`: no-op, or the newer v2.
3. `git merge v2-everywhere`: clean.
4. `git merge origin/v2-scope`, resolving as in §3.2. Run the grep check for old ids.
5. `git cherry-pick -x 0c58e7f69`.
6. `bun install --ignore-scripts`.
7. Local single files, one at a time.
   - From `packages/core`: `test/brain/database.test.ts`, `test/brain/migration-learned.test.ts`, `test/brain/migration-knowledge.test.ts`, `test/brain/review-memory-scope.test.ts`, `test/database-migration.test.ts`, `test/model-plans.test.ts`, `test/process-isolation.test.ts`, `test/effect/cross-spawn-spawner.test.ts`, `test/process/owned-process.test.ts`.
   - From `packages/engine`: `test/task/shells.test.ts`, `test/agent/agent.test.ts`, `test/cli/github.sandbox.test.ts`, `test/cli/github.agent-phase.test.ts`, `test/review/read-authority.test.ts`, `test/connect/vectorscope.test.ts`.
   - From the repository root: `test/codium-plan-names.test.ts`.
   - From `packages/web`: `test/everywhere-cooldown.test.ts`.
   - `packages/desktop/src/main/everywhere-git.test.ts`, with the package's runner.
   - Then `bun turbo typecheck --concurrency=2`.
8. Regenerate (§2). Commit only drift.
9. Tier A fixes, one commit each, with tests. This list is §4's Tier A items in order:
   1. Connect C1 secret diff.
   2. Connect F4/C2 platform `unavailable`.
   3. Connect F8 flag-off visibility, and F9 `REPAIR_AVAILABLE`.
   4. Connect C4 instance-store and F5 `canonicalScope`.
   5. Connect C7 diff in the `connect_write` ask.
   6. Connect C10 fix-child ask rules.
   7. Everywhere erase registration.
   8. Spawn-review tests S4-3 (child fixture) and S4-5.
   9. The VectorScope Python helpers against `ProcessIsolation.required()`.
   10. A Codium×scope admission test.
   11. The `run.ts` verify-order test.
   12. CI hygiene:
       - delete `github-compat.yml`, `candidate-compat.yml`, `review-host-compat.yml`, `app-attribution.yml`, `connect-guest-diagnostics.yml` and `auth-guest-preload.ts`;
       - keep `review-http-regression.yml` (dispatch only) until `httpapi-review.test.ts` is green, then delete it;
       - add `v2` and dispatch to everywhere, codium, connect-app and the scope lanes.
10. Re-fetch, then `git push -u origin v2-complete`. The pre-push typecheck runs; never use `--no-verify`. Open the draft once: `gh pr create -R scr1pter/claudeondfsfdaf --base v2 --head v2-complete --draft`.
    - The PR body lists the decisions: Fix A, the cherry-pick, the renumbering with `replaces`, the Q6 deferral, the Tier C list, and the Hands recheck note.
11. Run CI (§6). Fix reds, re-running known flakes only as the rules allow.
12. Tier B fixes and docs: connect C3, C5, C6, C9 and F10; everywhere C3–C6 and F3; V24 flip with `brain_upload`; progress and deviations docs. Push and run CI again.
13. Final: every lane green at one head. Then hand off to the orchestrator, which marks the PR ready and merges.

---

## 6. Expected CI lanes on the draft PR (`v2-complete` → `v2`)

| Lane | Trigger on v2-complete | Expected / watch for |
|---|---|---|
| `test.yml` (unit, engine 12 shards, e2e; Linux, Windows, macOS) | `pull_request` | **The first full run on this tree.** Watch for: Windows `writeBundle` (red group 4); the help snapshot; `httpapi-review.test.ts` bounded HTTP waits (the candidate was still diagnosing them, `a7fcfbd0e`/`7345f6a31`/`dfc26ee93`); Windows `read-authority` (`b48a7ac4f`); the scope e2e settings cases. Known flakes: Bun segfault, the Windows timing tests, `review.test.ts:1050` (never edit). |
| `verify.yml` | `pull_request` | Has never run on build-complete. |
| `typecheck.yml` | PR into v2 | Should pass. The pre-push hook runs the same typecheck. |
| `vector-at-mention.yml` (api, packages, node-bundle, 7 sandbox jobs) | `pull_request` paths (the spawner and `process-isolation.ts` are touched) | With Fix A, all 7 sandbox jobs green, as at `c0d10fb85` (43178097816). The hosted API job uses the real Valkey service. |
| GitHub desktop browser validation (`github-desktop-validation.yml`) | dispatch | Green before (43216635830, 43565027734). |
| Windows containment (`windows-containment.yml`, from v2) | dispatch (`shells.ts` changed; its paths cover only `windows-*.ts`) | #26 Windows Job Object receipts, plus the C2 refusal. |
| VectorScope: `review-memory-fence.yml`, `scope-directory-identity.yml`, `scope-app-validation.yml`, `scope-ui-validation.yml` | dispatch | Candidate receipts: 50-case scope harness 43557854520, 194 fence cases 43553374916. `scope-ui-validation` (9 settings cases) has not run since `e00d579b3`. **Never** dispatch `vectorscope-eval.yml`. |
| Connected workspace browser checks (`connect-app-validation.yml`) | dispatch (after adding it) | 21 Chromium cases (43557854580). |
| `vector-everywhere.yml` | `pull_request` paths | 53 files, the runner's 25 cases, Valkey (43556164842), plus the new cooldown and git-config tests. |
| `vector-codium.yml` | dispatch | Last receipt was on codium. Its Stripe test-mode `vector-codium-e2e.yml` needs a preview origin: leave it to the owner. |
| Vercel preview status | automatic on the PR | Codium's phone build (`4d544e0c4`). |

Re-fetch before every push. Cancel this branch's own superseded runs, and poll `gh run watch` gently.

---

## 7. Effort and timeline (estimate)

These are estimates for one agent working one item at a time, with CI as the long pole. A full `test.yml` matrix plus the lanes is assumed to take about 60–90 minutes per round.

| Phase | Agent work | CI rounds | Wall clock |
|---|---|---|---|
| Steps 1–8: merges, resolutions, install, single-file checks, regeneration | 2–3 h | 0 | 2–3 h |
| Step 9, Tier A (about 12 items, each with tests) | 6–8 h | — | — |
| Steps 10–11: first full CI on this tree, then fixes (2–4 rounds expected) | 2–4 h | 2–4 | 4–8 h |
| Step 12, Tier B (about 12 items plus docs) | 6–10 h | 1–2 | — |
| **Green, reviewed draft, Tier A only, Tier B deferred and documented** | | | **about 1–1.5 days** |
| **Green, reviewed draft with Tier A and Tier B** | | | **about 2–3 days** |

Not included; these are separate tracks:
- **Tier C build work:**
  - V27 runtime: about 1–2 days.
  - VectorScope VS-11/12/14/15/18/19/26 plus key wiring: about 1–2 weeks.
  - Connect Q6 consolidation and CW-20–25.
  - Everywhere later phases.
- **Native isolation qualification:** open-ended, in its own lane.
- **Hands:** Codex.
- **Owner-only actions:** App registration, secrets, published CLI (A1), D5/D7 eval funding, the Q6/A5/A13/D14 decisions, legal.
- **The Vector Signature desktop-shell redesign** (A5 asks for the V25 UI to be folded into it). It is not part of this branch.

## 8. Decisions this plan makes as judge

1. Fix A for the @vector floor (FLOOR=false). Activation stays off, and native isolation is the ship gate.
2. Merge order: v2-vector, then v2, then v2-everywhere, then v2-scope, then cherry-pick `0c58e7f69`.
3. Brain: v2-scope's renumbering to `20261216`–`18` with `replaces`, plus ordering tests. Codium's two ids keep their names.
4. `model-plans.test.ts` takes main's body. `run.ts` checks the token stop first.
5. build-candidate's temporary CI lanes are deleted. The area lanes run on `v2` push plus dispatch.
6. Connect Q6 consolidation is deferred with a deviation entry. Connect C1 and the flag-off visibility items block readiness.
