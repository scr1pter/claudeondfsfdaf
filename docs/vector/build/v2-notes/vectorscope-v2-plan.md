# VectorScope into v2: plan for branch `v2-scope`

Checked 2026-11-14 06:18–06:35 UTC. This was a planning pass. I pushed nothing, committed nothing and changed no remote ref. The only local changes were these:
- I created the worktree `<worktree>` (branch `v2-scope` at `origin/build-scope-joined` `3bb2b2ba2`).
- I ran `bun install --ignore-scripts` there.
- I ran 5 single test files and the core typecheck, listed in §2.

The other checks were `git cherry`, `merge-tree --write-tree` and `commit-tree` (these write objects only), plus read-only `gh`. The simulation script is `scratchpad/vs2/seqv2.sh`, and its output is in `scratchpad/vs2/`.

Sources: `docs/vector/build/vectorscope-remaining.md` (120 lines, identical on joined, checks, witness and wire; `build-scope-ui` predates it), `vectorscope-plan.md`, `vectorscope-upgrade.md`, `vectorscope-upgrade-addendum-a.md`, `vectorscope-continuation.md` and `vectorscope-deviations.md` at `3bb2b2ba2`. Finish plan: §0 item 6, §1, §3 step 7, §4 items 25–30 and §5 A2/A12.

## 0. State at 06:35 UTC

| Branch | Head | Last commit (UTC) | Relation to `build-scope-joined` `3bb2b2ba2` |
|---|---|---|---|
| `build-scope-joined` | `3bb2b2ba2` "fix(scope): enforce durable history at model boundaries" | 11-14 03:13 | It moved after the finish plan was written (that plan saw `993c5e15b`). `3bb2b2ba2` merges `build-scope-wire` `82cbb103e` (`79470a9c7` and `82cbb103e`, both 02:58). It is 152 ahead of main and 0 behind, and 152 ahead of `v2` and 1 behind. |
| `build-scope` | `0dcd814e6` | 11-13 03:07 | Ancestor (folded) |
| `build-scope-owner` | `892202d4a` | 11-13 03:24 | Ancestor (folded) |
| `build-scope-wire` | `82cbb103e` | 11-14 02:58 | Ancestor (folded) |
| `build-scope-checks` | `7bbf4d88b` | 11-12 21:01 | Not folded. `git cherry`: 4 "+" (`46e0b7160`, `b6ed51fa5`, `f2a085299`, `7bbf4d88b`), 2 "−". Their **content is already in joined**: see step F3. |
| `build-scope-ui` | `e00d579b3` | 11-12 18:27 | Not folded. 14 "+", 2 "−". Every source file is byte-identical in joined (squashed as `8b2a3a747`). Only the workflow `scope-ui-validation.yml` and one `tsconfig.json` line differ. |
| `build-scope-witness` | `5d672a228` | 11-13 00:18 | Not folded. 1 "+". The merge tree equals joined's tree (`b527c505f`), so the patch is already in (`3cb37c7f1`). |
| `vectorscope` | `bee92d8e9` | 11-08 | Stale (ancestor of joined) |
| `v2` | `8fecdf108` | 11-14 06:15 (PST 22:15) | main plus one CI commit (`test.yml`, `typecheck.yml`, `verify.yml` now also run for `v2`) |

The fold agent ("Vector Build Agent") had not pushed for 3 hours 20 minutes when I re-fetched. Re-fetch before every push anyway.

CI on joined's head:
- At `3bb2b2ba2`, "VectorScope local review validation" (`scope-app-validation.yml`) 43550504222 passed, and "Review memory history primitives" 43550504211 passed.
- At `993c5e15b`, "VectorScope repository identity" 43546996592 passed. Local review validation 43546996604 **failed** there (one Playwright timeout); `3bb2b2ba2` fixed it.
- **`test`, `typecheck` and `Verify` have never run on `build-scope-joined`**: `test.yml` runs on `pull_request`, and `typecheck` only on PRs into main or v2. The last full `test` on any scope branch is still 43179368976.
- The core typecheck passes locally at `3bb2b2ba2` (3.7 s).

Correction to the task brief and finish plan §0 item 6: `20261113015459_review-memory-fence` is **not** a Brain migration. It is in `packages/core/src/database/migration/` (the session database), registered at `packages/core/src/database/migration.gen.ts:58`. Only the three `review_memory*` files are in `packages/core/src/brain/migration/`. See §3.

## 1. Fold steps and expected conflicts

All steps run in `<worktree>`, with `export PATH=$HOME/.bun/bin:$HOME/.local/node/bin:$HOME/.local/bin:$PATH`. Never stash.

**F0. Upstream safety.** `v2-scope` was created tracking `origin/build-scope-joined`.
- Make the first push `git push -u origin v2-scope` (a fast-forward of a new branch), so the upstream becomes `origin/v2-scope`.
- Never run a bare `git push` before that.
- The pre-push hook (`.husky/pre-push`) runs `bun typecheck` (turbo) and checks Bun 1.3.14 (installed 1.3.14). Never use `--no-verify`.

**F1. `git merge origin/build-scope-witness`.** Clean, and the resulting tree equals `3bb2b2ba2^{tree}` (`b527c505f`). This only records the ancestry. The witness patch `5d672a228` (`local-run.test.ts` readiness waits) is identical to joined's file. Joined's `directory-identity.test.ts` has 348 more lines than witness's copy.

**F2. `git merge origin/build-scope-ui`.**
- 1 conflict, `packages/app/tsconfig.json`. Take joined's side (`git checkout --ours`). Joined's `include` already lists `test-browser/model-picker-state.test.ts` and adds `test-browser/vectorscope-local.test.ts`, so it is a superset.
- The merge adds `.github/workflows/scope-ui-validation.yml` (83 lines, "VectorScope settings validation"). Keep it: it is the only lane that runs `test-browser/model-picker-state.test.ts` (3 Solid cases) and the 9 `e2e/regression/vectorscope-settings.spec.ts` cases. Joined's `scope-app-validation.yml` runs neither.
- The other 8 ui files (`dialog-select-model.tsx`, `model-picker-state.ts`, `settings-v2/vectorscope*.ts(x)`, `select-v2.tsx`, the spec, the test) are byte-identical to joined.

**F3. `git merge origin/build-scope-checks`.**
- 6 add/add conflicts: `.github/workflows/scope-app-validation.yml`, `packages/app/e2e/regression/vectorscope-memory.spec.ts`, `packages/app/src/features/vectorscope/review-memory{.ts,-panel.tsx,.test.ts}` and `packages/schema/src/review-memory.ts`.
- 2 bad auto-merges: `packages/schema/src/index.ts` (it would export `./schema` twice) and `packages/app/e2e/tsconfig.json` (it would list `vectorscope-memory.spec.ts` twice).
- Resolve all 8 to joined's version (`git checkout HEAD -- <8 paths>`).
- Why that is safe: joined's copies evolved from checks'. Owner commits `82894e3b9` (controls), `df5ba6506` (Reopen command, which adds `Reopen` to the `Command` union) and `3af2416c0` (connected panel) rewrote them. `git diff origin/build-scope-checks HEAD` on those files shows only joined additions, refined copy and the `Reopen` arm.
- The other checks files (fixtures `vectorscope-memory.{html,jsx}`, `vectorscope-local.spec.ts`, `global-sync/bootstrap{,.test}.ts`, `test-browser/vectorscope-local.test.ts`) are already identical.
- Check: `git diff 3bb2b2ba2 HEAD --stat` after F1–F3 must list only `scope-ui-validation.yml`. `git cherry HEAD origin/build-scope-{checks,ui,witness}` must print nothing.

**F4. Lanes for `v2-scope`.** The VectorScope lanes trigger only on `build-scope*` pushes:
- `review-memory-fence.yml:4`, `scope-app-validation.yml:3-6`, `scope-directory-identity.yml:4` and `scope-ui-validation.yml:3-5`.
- Add `v2-scope` to each `push.branches`.
- Add `workflow_dispatch:` to `scope-app-validation.yml` and `scope-ui-validation.yml`. The other two already have it.
- Do not change `vectorscope-eval.yml`: it is manual and dry-run unless the owner approves a paid run (D5/D7).

**F5. `git merge origin/v2`** (`8fecdf108`, CI triggers only). 0 conflicts.

**F6. Fixes from §2 and the renumbering in §3.** Then push, and open the draft PR once: `gh pr create -R scr1pter/claudeondfsfdaf --base v2 --head v2-scope --draft`. That triggers `test` and `Verify` (pull_request) and `typecheck` (PR into v2). Dispatch the four lanes with `gh workflow run <file> -R scr1pter/claudeondfsfdaf --ref v2-scope`.

**F7. Re-merge v2 after the earlier steps land.** Order: process-finish, release-coordination, codium, @vector, cloud-workspaces, hands.
- Simulated from `origin/v2` with `seqv2.sh`: process-finish `3ec7fb14b` 0, release-coordination `4df0956d9` 0, codium `1ce8f5f30` 0, build-integrate `e88012584` 1, cloud-workspaces `360d63ba7` 3, hands `4ab67ee99` 15.
- Then joined `3bb2b2ba2` gives **25 conflicted files** (`scratchpad/vs2/scope-step-files.txt`).
- Pairwise against joined: codium 13; build-integrate 18 (a superset of codium's 13); hands 7; process-finish, release-coordination and cloud-workspaces 0.
- `build-integrate` (`29603fc90` at 06:28) and `hands` (`0b05de08c`) moved during this check. Re-run `seqv2.sh` right before F7.

| File | From | Kind | Resolution |
|---|---|---|---|
| `core/src/brain/database.ts` | codium | Semantic (migration order) | Imports and the `applyOnly` list: Codium's `20261213000000_codium_brain` and `20261214000000_codium_workflow`, then scope's renumbered three (§3) |
| `core/test/brain/database.test.ts`, `core/test/brain/migration-learned.test.ts` | codium | Tests | Combined id lists (§3). Also `migration-knowledge.test.ts`, which does not conflict but needs the union: Codium's ids plus scope's 3 ids and 4 tables. |
| `core/src/review/types.ts`, `engine/src/review/run.ts`, `engine/src/review/model.ts`, `engine/test/review/model.test.ts`, `engine/src/cli/cmd/review.ts`, `engine/src/cli/cmd/review.render.ts` | codium (A35 second-opinion/second-lab reviews `298cc87fb`, Codium label/footer `e4a2a4b5a`) | **Semantic**: the review engine | Keep Codium's model routing, second-lab path and label copy inside scope's runner (admission per attempt `run.ts:427`, history fence, durable requests). Add a test that a Codium-routed review still goes through scope's admission and fence. |
| `app/src/features/pull-requests/ai-review.ts`, `ai-review.test.ts` | codium | Semantic | Codium's desktop changes (+94/−13) on top of scope's VS-10 consolidation (+189/−30). The renderer must keep importing no engine code. |
| `app/src/features/pull-requests/pull-requests.tsx` | build-integrate (V25 App UI) | Semantic and UI | Keep V25's "Set up @vector" card and scope's `factoryLocal`/`localReview` gate (`pull-requests.tsx:706,863,1010-1015`). VS-20's GitHub half later joins that card and never adds a second one (`vectorscope-plan.md:378`). |
| `engine/src/session/prompt.ts` | codium | Semantic | Codium step accounting plus scope's StructuredOutput and fence changes |
| `engine/src/session/llm/request.ts`, `engine/src/tool/glob.ts`, `engine/src/tool/grep.ts`, `engine/test/review/run.test.ts` | build-integrate (tool isolation) | **Semantic and security**: tool processes | Keep @vector's isolated tool spawn and scope's single-threaded private grep under resource limits (`7cc8cac56`). Requester read denials must survive both (`run.test.ts:2166-2244`). |
| `engine/src/server/routes/instance/httpapi/server.ts` | codium | Mechanical | Union of route registrations (Codium's plus scope's experimental review-memory group) |
| `engine/src/agent/agent.ts`, `engine/src/session/llm.ts`, `engine/src/session/session.ts` | hands | Semantic | Hands' agent and session changes plus scope's hidden VectorScope agent (VS-09) and `llm.ts` memory-fence denial (`79470a9c7`) |
| `engine/test/server/httpapi-experimental.test.ts` | hands | Test | Union of capability expectations (`vectorscopeReviewMemoryControls` plus hands' keys) |
| `ui/src/v2/components/select-v2.tsx` | hands | Semantic UI | Hands +4/−1 and scope +12/−2 (popups stay inside the modal owner). Keep both. The 9 settings cases and `model-picker.spec.ts` must pass. |
| `core/test/model-plans.test.ts` | hands | Test | Take v2's (hands') version. With the §2 fix, v2-scope equals main here, so this conflict disappears. |
| `.prettierignore` | hands | Mechanical | Union |

After F7, regenerate the SDK and `openapi.json` only if `bun run` generation reports drift. Then re-run the full `test`, `Verify`, `typecheck` and the four lanes.

## 2. Failures in 43179368976 and their fixes

Run 43179368976: `test`, `workflow_dispatch` on `build-scope` at `8152d3f51`, 11-12 07:59 UTC. `8152d3f51` is an ancestor of joined (81 commits behind it).
- The "7 failed" is Playwright's count in `e2e (linux)` (job 131051334512).
- The same run also failed 2 more distinct tests in other jobs. I list them too, because the PR's `test` run will fail on them otherwise.
- I also found 4 more failures introduced on joined after that run.

| # | Test | Job | Cause | Status at `3bb2b2ba2` | Fix |
|---|---|---|---|---|---|
| 1–5 | `vectorscope-settings.spec.ts` "VectorScope settings stay hidden for" default-off, old-engine, guest, owner-check-error and owner-check-malformed (now `:52-53`) | e2e linux 131051334512; e2e windows 131051334792 (its log shows the 5 hidden cases, then is cut off) | The poll for workflow `/saved` owner probes (`spec:61` at `8152d3f51`) never saw a probe within 10 s | Fixed in source. `19953ba2a` counts owner probes in a `workflow` hook and exercises visible controls. The ui lane run 43280003239 at `e00d579b3` passed "9 passed" in Chromium on Linux. | No code expected. Prove it in the PR's full `test` (Linux and Windows e2e) and in `scope-ui-validation.yml` on v2-scope. |
| 6 | "the owner saves a separate model, variant and disable setting only after confirming running work" (now `:92`) | e2e linux and windows | `menuitemradio /Maker Text/` never appeared (`spec:84` at `8152d3f51`): the picker popup rendered outside or under the settings modal | Fixed in source: `98503a9b5`, `65cd0f697`, `8b2a3a747` (picker and modal popup ownership, memoized picker selection) | As above |
| 7 | "failed saves retain the draft and retry without showing an unsaved choice as committed" (now `:139`) | e2e linux and windows | The Kobalte `switch-control` intercepted pointer clicks on the switch input (`spec:105` at `8152d3f51`) | Fixed in source: the spec's `disableReviews` uses focus and Space (`spec:13-22`) | As above |
| 8 | core `model-plans.test.ts:138` "a fresh engine lists the account's last catalog while vectordev.ai is slow, and only for that account" | unit linux 131051335038; unit windows 131051334953 | Two fixes conflict. Scope's `12950f7c6` (11-07) made `slow` never answer (`:146-147`). Main's later fix, brought in by `eadfe3056`, added forced reads (`:152-153`) that wait for that never-answering request, so the test hangs for 30 s. | **Still red.** Reproduced locally at `3bb2b2ba2`: 35 pass, 1 fail, timed out at 30001 ms. | Restore main's test body exactly (`git checkout origin/main -- packages/core/test/model-plans.test.ts`; main and codium are identical here), so the scope diff on this file is empty. Hands later replaces it with controlled pending requests (`4ab67ee99`), and a v2 merge then takes that version cleanly. No product change. |
| 9 | engine `review/run.test.ts:2166-2167` "a resolver-time symlink retarget cannot release the admitted canonical read denial" (assertion now `:2234`, then `:1909`) | engine (windows, shard 2/12) 131051335349 | Windows only (the link is a junction). The second read, through the link retargeted after admission, **completed** instead of being denied. Statuses were `[error, completed, completed]` against the expected `[error, error, completed]`. The test came from `57de684b3`, and nothing since has touched this path for Windows. Denials are resolved once at admission (`engine/src/review/read-authority.ts:61-66`) and checked through `resources(absolute(file, true))` (`:71-74`), using `path.resolve` plus `FSUtil.realpath` and `FSUtil.windowsPath` (`core/src/fs-util.ts:239-253,338-345`). Most likely the literal spelling of the denied path and the read tool's spelling differ on Windows (drive-letter case, 8.3 short names such as `RUNNER~1`, or the read tool canonicalizing junctions before the check), and `Wildcard.match` compares them case-sensitively. | Unknown: no Windows engine shard has run since. This is a **security property** (a requester's read denial). | (a) Add a pure `read-authority` unit test: deny `link\sensitive.txt` through a junction, retarget it, then call `denied` with both spellings, on Windows CI. (b) Fix the spelling normalization in `read-authority.ts` and the read tool's permission resource on win32: compare case-insensitively, expand short names through `realpath`, and keep the admitted literal and canonical names. (c) Never weaken the test. Check it on the PR's Windows engine shards. |
| 10 | core `test/brain/database.test.ts:78` "a file is private to the user, set up for two processes, and migrated once" | (new on joined) | The expected id list stops at `20261214000000_review_memory_scope` (`:93-94`), but `brain/database.ts:73` also applies `review_memory_source` | **Red locally** | §3 (new id list) |
| 11 | core `test/brain/migration-learned.test.ts` "a brain.db an earlier build left at the facets migration…" (`:134-142`) | (new) | `slice(-7)` no longer matches once `review_memory_source` exists | Red locally | §3 |
| 12–13 | core `test/brain/migration-knowledge.test.ts`: "a brain from the first migration upgrades in place" (`:158-172`) and "every brain table is as its declaration says" (`:214`) | (new) | The id list stops at `research_claims`. `TABLES` (`:47-80`) lacks `BrainReviewMemoryTable`, `BrainReviewMemorySourceTable`, `BrainReviewMemoryStateTable` and `BrainReviewMemoryScopeStateTable` (`core/src/brain/sql.ts:135,169,191,198`). | Red locally | §3. Add the 4 tables to `TABLES` and fix any declaration/storage shape mismatch the test then reports. |

The same run also had 1 flaky test (`cloud-home-only.spec.ts:10`, passed on retry); it is unrelated.

The other local checks at `3bb2b2ba2` passed: `test/brain/review-memory-scope.test.ts` and the core typecheck. I ran nothing else, so other red tests may exist. The PR's full `test` is the first full run on this tree.

## 3. Migration renumbering

**How Brain migrations run.**
- `packages/core/src/brain/database.ts:14-29` imports them, and `:57-74` passes them in array order to `DatabaseMigration.applyOnly`.
- `applyOnly` (`packages/core/src/database/migration.ts:43-80`) skips any id already in brain.db's `migration` table (`:69-70`) and runs the rest in array order.
- Ids are the full names, so Codium's and VectorScope's ids never collide as keys. The shared prefixes only make the order ambiguous and break the convention.
- The two sets touch disjoint tables:
  - Codium runs `ALTER TABLE brain_state ADD codium_helpers/knowledge_distill` and `ALTER TABLE brain_workflow_run ADD codium_units`.
  - VectorScope creates `brain_review_memory`, `brain_review_memory_state` and `brain_review_memory_scope_state`, adds `brain_review_memory.scope_id`, and creates `brain_review_memory_source`.
  - So either order works. I chose Codium first, because Codium merges first.

**Renames** (VectorScope only; Codium's two keep their names):

| Now | New | File |
|---|---|---|
| `20261213000000_review_memory` | `20261216000000_review_memory` | `packages/core/src/brain/migration/`, `id:` at line 6 |
| `20261214000000_review_memory_scope` | `20261217000000_review_memory_scope` | same, line 6 |
| `20261215000000_review_memory_source` | `20261218000000_review_memory_source` | same, line 6 |
| `20261113015459_review-memory-fence` | **unchanged** | `packages/core/src/database/migration/`, session DB |

**The fence migration.**
- It lives in the session database. That database has its own `migration` table and a generated, timestamp-ordered registry (`migration.gen.ts`, made by `packages/core/script/migration.ts`). So it has no order relative to the Brain migrations.
- In its own registry it already runs after the other three VectorScope session migrations: `20261112110316_review_request`, `20261112120658_review_deletion_fence`, `20261112181354_review_source_binding`, then `20261113015459_review-memory-fence` (`migration.gen.ts:55-58`).
- No branch merging into v2 adds a session-DB or Brain migration, except Codium's two Brain ones (also inside `build-integrate`). I checked `git diff --diff-filter=A main...<branch>` on process-finish, release-coordination, codium, build-integrate, vector-at-mention, cloud-workspaces, hands, build-connect, vector-everywhere and build-native-shell.
- So the fence keeps its name and position. Its table (`review_memory_fence`) is created before any session history uses it, and nothing in brain.db depends on it.

**Already-applied old ids.**
- No release shipped these migrations: VectorScope was never on main. But any machine that ran a `build-scope*` build has brain.db rows for the old ids.
- With only a rename, opening such a brain.db would re-run `CREATE TABLE brain_review_memory` and fail, which leaves the Brain unusable.
- Add an optional `replaces?: readonly string[]` to `DatabaseMigration.Migration` (`migration.ts:13-16`). In `applyOnly`, when any replaced id is completed, record the new id in the same transaction without running `up`.
- Each renamed file names its old id.

**Code changes:**
1. `git mv` the three files, and change their `id`s and the imports at `brain/database.ts:27-29`.
2. Export the ordered list as `export const migrations = [...]` from `brain/database.ts` and pass it to `applyOnly`, so tests can read it.
3. Add `replaces` to `migration.ts` (type and `applyOnly`).

**Tests that change** (all core, run one at a time from `packages/core`):
- `test/brain/database.test.ts:79-95`: the full ordered list now ends `…research_claims, review_memory (2026121600…), review_memory_scope (…17…), review_memory_source (…18…)`. This also fixes failure #10.
- `test/brain/migration-learned.test.ts:134-142`: replace `slice(-7)` with the explicit tail from `20261202000000_facets` onward (facets, revocation, learned_skills, workflow, research_claims, the three renamed ids), so a later migration does not silently shift it.
- `test/brain/migration-knowledge.test.ts:158-172`: add the three renamed ids. Also `TABLES :47-80`: add the four review-memory tables.
- `test/brain/review-memory-scope.test.ts:12-13`: the import paths.
- New, in `test/brain/database.test.ts`: "Brain migrations run in strictly increasing id order with unique 14-digit prefixes". It asserts over `BrainDatabase.migrations`, and fails if two migrations share a prefix or the list is out of order.
- New, in `test/database-migration.test.ts`: the same assertion over the session registry `migrations` (`migration.gen.ts`).
- New, in `test/database-migration.test.ts`: "a migration that replaces an applied id records itself without running". Also an end-to-end case in `test/brain/migration-learned.test.ts`: a brain.db that recorded `20261213000000_review_memory` and `20261214000000_review_memory_scope` (real tables) opens. It records the new ids, runs only `20261218000000_review_memory_source`, and keeps its rows.

**After F7 on v2 (with Codium):**
- Brain order: `…20261212000000_research_claims, 20261213000000_codium_brain, 20261214000000_codium_workflow, 20261216000000_review_memory, 20261217000000_review_memory_scope, 20261218000000_review_memory_source`.
- The three test files take that combined list. `migration-knowledge.test.ts` (Codium's version lists `:172-173`) gains scope's 3 ids and 4 tables.
- `20261215000000` stays unused.

## 4. What remains to build

The source inventory, `vectorscope-remaining.md`, is dated 12 November at checkpoint `7ccd83673` (`:3`), so parts of it are stale:
- **VS-09 ninth browser case** (`remaining.md:20-21,44`): closed in source. Picker repair `8b2a3a747` and acceptance `e00d579b3` passed 9 browser and 3 Solid cases (`continuation.md:22-25`; `deviations.md:15993`). What remains is CI proof on v2-scope (`scope-ui-validation.yml`, plus the full `test` Linux and Windows e2e) and updating `remaining.md:20-21`.
- **VS-12** (`remaining.md:47` says "No fix proposal/executor module"): the pure consent contract now exists. `packages/core/src/review/fix-proposal.ts` (529 lines, `312e471ab`) has `FIX_LIMITS`, `FixProposal`, `FixOperation`, `FixRefusal` and `createFixConsentPolicy` (`:127`). The executor is still missing.
- **VS-11** (`remaining.md:46`) now has:
  - the namespace: Brain tables plus physical scope `70cbb8aa2` and source binding `018108007`;
  - an owner-only engine API, registered as experimental routes (`17f0d4aa1`);
  - App controls mounted behind `experimental.vectorscope === true` and the capability (`app/src/pages/layout-new.tsx:6928-6953`; `3af2416c0`);
  - a durable history fence (`993c5e15b`, `3bb2b2ba2`).

  `deviations.md:16000` ("routes and controls remain unregistered/unmounted") predates `17f0d4aa1` and must be updated.

Every package below stays off by default and sends nothing to a hosted model unless configured. Tests use fakes only: no real model, network or paid call.

**Build (local software, no external input needed):**

| Package | Spec | What to build | Default | Tests (meaningful, not shape-only) |
|---|---|---|---|---|
| VS-12 executor | `plan.md:322`, `remaining.md:47`, `upgrade.md:320` (VS-30 reuses the consent), `addendum-a.md:1077` (CLI consented apply on `StrictResult`) | Engine `review/fix.ts`. A separate isolated worktree through `task/isolation.ts` (`plan.md:405`) and file locks (`plan.md:404`). Exact head, patch digest and preimage checks. States: proposal, preview, apply, checks, commit, push. Cancel and cleanup. A CLI `review.ts` apply step. A desktop PR action and diff preview. Consent through `createFixConsentPolicy` (`fix-proposal.ts:127`). | Off. No push without separate push consent. | Dirty checkout, path traversal and symlinks, head movement, changed digest, revoked or expired consent, failed check, cancellation. The base branch and unrelated work stay intact. |
| VS-11 remainder | `plan.md:321`, `remaining.md:46`, `addendum-a.md:1076` (VS-35 amends it) | The review-context consumer: approved repository entries go to the prompt as data. Accepted policy is kept separate from pending feedback, and one dismissal is never a rule. Review-deletion and erase integration. Older-binary session-only forget compatibility (`deviations.md:16001-16003`). | Consumer off. Controls stay behind `experimental.vectorscope`. | No personal memory in shared reviews. Forged dismissals and learning refused. Cross-repository isolation. Migration and erase. Inspect, delete and disable. |
| VS-14 MCP broker | `plan.md:324`, `remaining.md:49` | Engine `review/mcp.ts`: a default-deny consent broker on the existing MCP lifecycle. Per-server grants, schema and endpoint capability hashes, execution-time enforcement. `core/review/permission.ts:101-103` keeps `read mcp:*` denied. | Deny, with no approved server (D11: no live local calls in the first release) | Missing grant, unknown write tool, fake annotations, changed schema or endpoint, redirects, token leakage, alternate `read mcp:*` paths. A fake MCP server only. |
| VS-15 snapshots | `plan.md:325`, `remaining.md:50` | Fixed, owner-selected, pre-exposure bounded snapshots. Strip live MCP from untrusted sessions. Zero PR- or model-driven calls after exposure. | Off. Real resources wait for owner-named servers. | Injection through query, URI, cursor and comments. Nested tools, retries, reconnects. Broker instrumentation shows zero post-exposure calls. Unsupported servers fail closed. |
| VS-18 diagnostics | `plan.md:328`, `remaining.md:53`, `upgrade.md:313` (the code-running half moves to VS-30), `addendum-a.md:1079` | Engine `review/checks.ts`: pinned offline secret and dependency scanning and pinned linters, as evidence lanes the model filters. Shares VS-34's scanner (`core/review/holdback.ts:88`, `brain/scan.ts`). Redacted output. Unsupported platforms refuse. | Off | Malicious configs and scripts, secret redaction (never print a found secret), no scanner network or telemetry, deduplication against model findings, cancellation |
| VS-19 large PRs | `plan.md:329`, `remaining.md:54`, `upgrade.md:314`, `addendum-a.md:1080` | A durable exactly-once batch plan and cursor in core `skip.ts`/`plan.ts`/`state.ts` and the engine runner (partial coverage at `run.ts:973`). Head invalidation. Cross-batch context. Ordered by VS-39 density (`risk.ts`). | Off. Existing size skips stay. | Exactly-once batches, head change, a cross-file defect, cap exhaustion, partial coverage. Never label an incomplete review clean. |
| VS-26 Brain cards | `upgrade.md:534-561`, `addendum-a.md:1027-1032`, `remaining.md:66` | An engine `review/context.ts` `cards` gatherer next to `requirements` (`:224`), using read-only `BrainKnowledge.links` and `search`. At most 3 cards, each at most 160 characters, 200 tokens in total. Rules for personal items under ZDR and shared reviews. Core `prompt.ts` `<untrusted_context_cards>`. A local-only eval with base-seeded Brain fixtures. The `dispatch.ts:70-74` shrink lever. | Key off (enabling it needs a funded ablation, Q9) | `knowledge.test.ts`, `prompt.test.ts`, a posting-guard test with a quoted card, 0 personal items in shared reviews |

**Wire into the shared runner, with defaults unchanged.** The approach comes from `remaining.md:107-110`. Today these keys are parsed but not applied:
- the keys `trivial`, `maxInputTokens`, `impact`, `guardrail`, `scopeGate`, `verifyEvidence`, `depth`, `lenses` and `runtime` (`core/src/review/types.ts:555-569`);
- with defaults at `types.ts:541-551`;
- and "not applied yet" warnings at `core/src/review/config.ts:235-279`.

Wiring a key means: apply it in `engine/src/review/run.ts`, remove it from `UNAPPLIED_REVIEW_KEYS` and drop its warning, keep the default value, and prove request parity with the key unset (I-1: payload and permission rules byte-identical) using a fake provider wire test. The desktop path goes through the consolidated service, or states its difference explicitly.

| Package | Key and default | Pure piece (exists) | Runner hook |
|---|---|---|---|
| VS-23 b/c/d | `privacy: standard \| zdr`, raise-only (`config.ts:151`) | `core/review/privacy.ts` | Admission on every attempt (`run.ts:427`). Transport backstops. Hidden owner-global engine policy and generated schemas. The Codium route waits for codium (below). |
| VS-24 | `trivial: review`, `maxInputTokens: 0` | `trivial.ts`, `dispatch.ts` (today used only in `engine/review/eval.ts`) | Before the prompts (`run.ts:771-784`). Staged shrink, coverage, zero-attempt budget outcome. |
| VS-25 | `impact: grep` | `core/review/impact.ts`, `engine/review/impact.ts`, `parse.ts` | Prompt context (`run.ts:771-784`) through the private Git object port |
| VS-27 c | `guardrail: off` | `guardrail.ts:372` `strictSelect` | After verify, at select (`run.ts:939-951`). Strict outcome and JSON format. |
| VS-28 | `depth: fixed`, `lenses: off` | `plan.ts:126` `planDepth`, `risk.ts` | Pass planning. Bounded parallel lens sessions. |
| VS-34 | `holdback: off \| secrets`, not parsed yet (`addendum-a.md:215-235`) | `holdback.ts:88` `holdbackFiles` | Before the payload (`run.ts:771-784`) and in the read-tool rules under the key only |
| VS-42 | `scopeGate: off` (only under strict) | `guardrail.ts:169` `preExistingSuspect` | At select |
| VS-43 | `ruleCheck: off \| strict`, not parsed yet (`addendum-a.md:650,677`) | `citation.ts:137` `ruleCited` | At select. Exact sent rule sources. |
| VS-44 | `verifyEvidence: off` (only under strict) | `guardrail.ts` certificate checker | The verify pass (`run.ts:843-930`) |

**Waits for @vector on v2.** These come after `build-integrate` or #25 merges, and use its interfaces only (no second publisher or route):
- VS-05 compatible CLI (`plan.md:375`, `remaining.md:40`; `MIN_AGENTS_CLI` must name a published CLI, finish plan A1).
- VS-13 GitHub fixes and replies (`plan.md:323,376`, `remaining.md:48`).
- The GitHub halves of VS-16 (`plan.md:377`, `remaining.md:51`), VS-20 (`plan.md:378`, `remaining.md:55`; joins V25's card), VS-32 (`remaining.md:77`) and VS-47 (`remaining.md:92`).
- Also VS-26's nightly CI card artifact and VS-35's markers (`addendum-a.md:1031,1098`).

**Waits for codium on v2:**
- VS-29b: trusted local provenance plus the existing Codium lab API (`remaining.md:69`; Codium A35 `298cc87fb`).
- The Codium route for VS-23 c/d and VS-33: all-route wire audit and native/Codium route proof (`remaining.md:63,78`).
- The VS-10 App adapter, which `remaining.md:17-19` gives to the Codium agent (finish plan §4 item 26). That agent's lane is now this session's.

**Waits for connect:** coordinating VS-11's dismissal writes (`remaining.md:46`). Connect merges after scope.

**Waits for the owner:**
- D5, the pilot: $50 total and $0.75 per case, development split (`plan.md:25`).
- D7, the protected `vectorscope-eval` environment with a new spend-limited key (`plan.md:27`). The environment does not exist yet.
- D9, publishing the CLI with @vector's release (`plan.md:29`).
- VS-38 benchmark runs (`remaining.md:83`): out of scope; benchmark work is not touched.
- D14/A2: whether VectorScope is user-facing in v2 (`plan.md:34`). Until then everything stays behind `experimental.vectorscope`.
- A12: the formal approvals Q13/Q15/Q18/Q45 (`upgrade.md:883-885`, `addendum-a.md:1109`, `addendum-b.md:344`) and D15/D16. `remaining.md:4-6` already authorizes building reversible software.
- Funded ablations and held-out quality before any default change (`remaining.md:116-120`).

## 5. Order of work and CI

1. F0–F5 (fold, lanes, merge v2). Then the §2 fixes #8, #10–13 together with the §3 renumbering, in one commit or a few.
   - Local checks, one at a time from `packages/core`: `bun test --timeout 30000` on `test/model-plans.test.ts`, `test/brain/database.test.ts`, `test/brain/migration-learned.test.ts`, `test/brain/migration-knowledge.test.ts`, `test/brain/review-memory-scope.test.ts` and `test/database-migration.test.ts`. Then `bun typecheck` in core.
2. Re-fetch, and merge any new `build-scope*` commits. Push with `git push -u origin v2-scope`. Open the draft PR (F6).
   - Watch `test`, `Verify`, `typecheck` and the 4 lanes with `gh run watch <id> -R scr1pter/claudeondfsfdaf --exit-status`.
   - Expect failure #9 on the Windows engine shard until it is fixed.
3. Fix #9 (Windows read denial). Then fix any other red the first full run shows. Re-run a known flake only once, and only when it is the only failure.
4. Build in this order: VS-11 remainder, then the VS-12 executor, then VS-19, VS-14/15, VS-18 and VS-26. The wiring runs alongside, one key per commit with its parity test.
5. Update `vectorscope-remaining.md`, `-continuation.md` and `-deviations.md` to match the head. Keep the PR body current.
6. F7 once v2 has codium, @vector, cloud-workspaces and hands. Then do the waiting halves.

Do not touch: tokenomics or benchmark files, `engine/test/review.test.ts` (its `:1050` flake), other branches, `vectorscope-eval` paid runs, and any default change.
