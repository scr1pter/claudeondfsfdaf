# job-instruction-hold: EV-21

Branch `job-instruction-hold`, cut from origin/main `b87cc462f`. It covers one Vector v2 leftover P0 item, EV-21-instruction-file-hold. The feature stays dormant: the everywhere tab, and with it Continue, is hidden for everyone, `OFFER_KEYS` is empty and `VECTOR_EVERYWHERE_ENABLED` stays off.

The lane's deviations, handoff and spec files are in the open v2-closeout-ci PR, so the dated entry lives here. Fold it back into `vector-everywhere-deviations.md` (EV-21 (o), review round four) and the handoff's "Instruction files in a continued session" bullet once that PR merges.

Files: `packages/engine/src/session/instruction.ts`, the new `packages/engine/test/everywhere/instruction-hold.test.ts` and `packages/engine/test/session/instruction.test.ts`.

## 2026-11-21, EV-21 instruction-file hold

**The gap.** Continue in the everywhere settings opens an ordinary owner session in the job's checkout, `<data>/everywhere-worktree/<project id>/<jid>`, with network and the owner's permissions. `Instruction.systemPaths` added the checkout's AGENTS.md (or CLAUDE.md) whether or not the folder is trusted, because `PromptTrust.allowed` only decides on files outside the workspace. So an AGENTS.md the job wrote from platform text, or a new nested `pkg/AGENTS.md`, reached the owner's session: in its system prompt on the first message, and beside a file it read. Deviations EV-21 (o), review round four, and handoff :288 ("Nothing in code enforces the gate today") record it as a precondition for listing the perk.

**The reading taken: content against the job's base.** While the owner has not trusted the job's checkout, an instruction file inside it reaches a prompt only when its bytes are the job's base's blob at the same path. The repository's own words still go. The job's never do. This departs from review round four's preferred session-based hold (a session in a folder whose root session carries `vector.unattended` gets no in-workspace instruction files). That hold needs `packages/engine/src/session/prompt.ts` and `packages/engine/src/tool/read.ts`, which scope-finish holds. The lead accepted this call (plan section 3, rulings file "Section 3 defaulted calls").

**The fix** (engine only, all in `instruction.ts`; the review round below changes how `jobBase()` finds the folder and checks git, and adds `place()`):

- `jobBase()` answers whether this instance is such a checkout. Its canonical worktree must be exactly `<canonical Global.Path.data>/everywhere-worktree/<ctx.project.id>/<jid>`, where `Worktree.createUnattended` puts one. Both sides are real paths, so macOS's `/var` and `/private/var` agree, and the case is folded on Windows, as Worktree compares folders. The jid must match the schema's `JOB_ID_PATTERN`, and `cfg.trust()` must report the folder untrusted. The base is `git rev-parse --verify --quiet --end-of-options refs/vector-everywhere/<jid>^{commit}` (`fetchRef`), the ref the runner fetched the job's base into, which createUnattended checked against the base it checked out.
- `held(job, file)` is true for an instruction file inside the checkout unless `git rev-parse <base>:<relative path>` equals `git hash-object --no-filters -- <file>`. The relative path is where the file really lands, so a link inside the checkout is compared through, as it is read through. A missing ref, a missing blob, a file outside the base and any git error each count as held. A file outside the checkout is the user's own, which PromptTrust decides on, so it is never held here.
- `system()` and `contents()` read `admitted()`, which is `systemPaths()` without held files. `resolve` passes over a held nested file and keeps walking upward.
- `systemPaths()` itself is unchanged, because `computer/protection.ts:79` and `tool/computer.ts:665` use it to protect those files. A held root AGENTS.md keeps its place in it, so CLAUDE.md does not stand in for it.
- `Git.node` joins `Instruction.node.deps`. LayerNode composition carries it to every consumer, so no other file changes. Both git calls go through `Git.Service`, so there is **no new spawn site** (`test/spawn-inventory.test.ts` passes unchanged). `GIT_NO_LAZY_FETCH=1` keeps a partial clone from fetching a missing object for these lookups. `--no-filters` runs no filter driver or line-ending conversion.

**Verified, not changed: `cfg.trust()` ignores the untrusted checkout's own `vector.json`.** `Config.trust` (`config.ts` :2584) asks `WorkspaceTrust.status`, which is true only when the trust store under `Global.Path.state` holds this folder's path with this snapshot's fingerprint. A file the job writes into the checkout cannot add that entry, and changing a trust input changes the fingerprint. EV-18's "the job's checkout is never trusted" case in `worktree.test.ts` pins it. The owner's own Trust action is the only way in, and then the hold lifts, by design.

**Tests.**

- New `test/everywhere/instruction-hold.test.ts`. It copies the HTTP setup of `worktree.test.ts`'s "the job's checkout is never trusted" case instead of sharing it, because that file is in three open PRs. The repository's base has AGENTS.md (BASE RULES), CLAUDE.md and `lib/AGENTS.md`. The checkout is made through `POST /experimental/worktree/unattended` with the base in `refs/vector-everywhere/<jid>`, and the test checks that `/config/trust` reports it untrusted. The job then commits AGENTS.md (JOB RULES) and a new `pkg/AGENTS.md` on its branch. An owner session is created in the checkout through `POST /session` (no `vector.unattended` mark), and the same engine's Instruction service is read there: `system()` is what that session's system prompt carries (`SessionPrompt.sessionInstructions`), `resolve()` is what the read tool attaches, and `contents()` is what research carries.
  - Case 1: no JOB RULES, no `pkg/AGENTS.md` text, and no CLAUDE.md text or path, in any of the three. The held AGENTS.md stays in `systemPaths()`. The control: the unchanged `lib/AGENTS.md` still comes with a read of `lib/y.ts`.
  - Case 2 (pins EV-14 (g)): with nothing changed, the system text has BASE RULES, `contents().work` has it, and `lib/AGENTS.md` comes with a read.
  - Case 3: with the job's ref deleted, the changed AGENTS.md stays held, and so does every unchanged instruction file in the checkout (fails closed).
- `test/session/instruction.test.ts` has a new unit case, "holds it only in an untrusted checkout at `<data>/everywhere-worktree/<project id>/<jid>`". Two linked worktrees of one repository each rewrite AGENTS.md on the job's branch. The one at the exact place is held while untrusted and loads once trusted. The one with a job's name in a folder elsewhere loads.

**Evidence** (macOS, each file run alone from `packages/engine` with `bun test --timeout 30000`):

- Red-before. With main's `instruction.ts` put back in the working tree (`git diff HEAD` saved, `git checkout --` the file, then `git apply` to restore) and the tests unchanged:
  - `instruction-hold.test.ts` gave 1 pass and 2 fail. Cases 1 and 3 failed with JOB RULES in the system text. Case 2 passes on both, because it guards EV-14 (g).
  - `instruction.test.ts` gave 18 pass and 1 fail, the new unit case.
  - The restored file's sha256 matched the fixed file's.
- Green: `instruction-hold.test.ts` 3 of 3, `instruction.test.ts` 19 of 19, regression `unattended-session.test.ts` 6 pass and 1 skip (the bubblewrap-only case, skipped on main too), `test/tool/read.test.ts` 45 of 45 and `test/spawn-inventory.test.ts` 14 of 14. `bun typecheck` passed in packages/engine.
- Mutations, each restored afterwards with the sha256 compared equal:
  - M1, the plan's first: the base read from `HEAD^{commit}` instead of the job's ref. Cases 1 and 3 of `instruction-hold.test.ts` went red, because the job's own commit is HEAD.
  - M2, the plan's second: `held` returns false when the ref is missing. Case 3 went red alone.
  - M3: the `cfg.trust()` check removed. The `instruction.test.ts` unit case went red (the trusted checkout was held).
  - M4: the exact-place check removed. The unit case went red (the job-named folder elsewhere was held).

**What could go wrong.**

- Each instruction file costs two git calls, plus one for the ref per `system()`, `contents()` or `resolve()`, but only in a job's untrusted checkout. Everywhere else the check is two real-path lookups and a pattern test.
- A job that edits its own AGENTS.md loses that edit if its session's instruction snapshot is rebuilt cold. That stays inside the same trust domain.
- A future sweep that deletes the ref holds every instruction file in the checkout. That fails closed.
- A file whose working copy differs from its blob only by checkout conversion (a `.gitattributes` `eol=crlf` or a filter) is held, because `--no-filters` compares raw bytes. The runner's checkout uses no system or global git config, so Git for Windows' `core.autocrlf=true` does not apply there. This also fails closed.
- `held` is decided on the file as git hashes it, and the read follows. A writer that swaps the file between the two could slip text past. The job's sandboxed commands have ended by the time Continue is offered, so nothing should still be writing. A stricter version would hash the bytes it read through `--stdin`.
- scope-finish edits `config.ts` and `prompt.ts`. On rebase, recheck that the `cfg.trust()` shape and the `Instruction.system()` and `resolve` signatures still match.

**Follow-ups.**

- After v2-closeout-ci merges (it holds `packages/app/src/components/settings-v2/everywhere-model.ts` and the lane's spec): narrow `CONTINUE_NOTE`, which still says the new session reads the checkout's AGENTS.md and other instruction files from its first message. Then mark the spec's §10 "Codium listing" precondition for instruction files as met.
- **Found while building:** repository rules and memory files were not held. Built in the review round below.

## 2026-11-21, EV-21 review round: the hold no longer trusts the checkout's own git, and covers rules and memory files

An independent review of the build above found three ways past the hold. Each has a new case in `test/everywhere/instruction-hold.test.ts` that failed on the build above and passes now. All changes are in `instruction.ts`.

**1. Repository rules and memory files reached the owner's prompt.** `Instruction.place()` handed the brain the checkout's `.vector/RULES.md`, `.vector/BRAIN.md` and root `BRAIN.md` with no hold. `Brain.digest` puts every rules source into the system prompt whole, under "Repository rules" and "Rules bind unless the user says otherwise now". `place.held` covers only `brain`-type files, and only when the folder has settings of its own. So a job's `.vector/RULES.md` reached a continued owner session through the digest instead of `system()`. Plan section 1.2 named only `system()`, `contents()` and `resolve`, but the code itself says a repository's rules "load as its instructions do", so this is the same EV-21 gap. **Fix:** `place()` passes its sources through the same `held()` filter. The `held()` call there is quiet, because every brain call runs `place()`. Outside a job's checkout, or with no rules or memory file, no git runs. A dropped source is not mirrored and its entries are not visible to that place (`Brain.visible` filters by the place's sources). Nothing is deleted, because the brain prunes a mirror only when its file is gone.
- Case "repository rules the job wrote stay out of the owner's digest, and the base's still go": the base has `.vector/RULES.md`. With nothing changed, `place().sources` lists it and `brain.digest(place)` has its text (the control). After the job rewrites it, the digest has neither text, and the source is gone. Red on the build above: the digest read `Repository rules (.vector/RULES.md): - JOB REPOSITORY RULES ...`.

**2. A `.git` marker the job overwrote turned the hold off.** The job's file tools may write anything in its folder (`unattendedRules` allows `edit` on `*`, and no file tool refuses `.git`). The build found the checkout through git: the instance's worktree and project id. If the job writes anything that is not a gitdir line into `.git`, the next engine start resolves the folder as no git project at all (worktree `/`, project `global`). `jobBase()` then answered "not a job's checkout" and nothing was held. **Fix:** `jobBase()` finds the folder by where the instance is (its worktree or its directory) under `<canonical data>/everywhere-worktree/<segment>/<jid>`, never through git. If the folder is not exactly this project's checkout of this job, with the instance's worktree at its root, there is no base, so every instruction file in it is held. `held()` now judges "inside" against the job's folder, not the instance, so a session opened in a subfolder or with a non-git worktree still holds the files above it in the job's folder.
- Case "a .git marker the job overwrote does not lift the hold": after the job's commit, `.git` is overwritten and the engine's instances are disposed (a later start). The job's AGENTS.md is still found (it is in `systemPaths()`) and held. Red on the build above: JOB RULES in the system text.

**3. A repository the job made in its folder stood in for the base.** On Linux, the job's offline shell can run git inside its folder. Its commands cannot rewrite `.git`, which is bound read-only, but its file tools can. A job could make a repository inside its folder with a `refs/vector-everywhere/<jid>` naming its own commit and the project's cached id (the id is in the folder's own path), and then point `.git` at it. The base was then the job's own commit, so its AGENTS.md matched. **Fix:** `jobBase()` also asks git for `--absolute-git-dir` and `--git-common-dir`. Unless both are outside the job's folder, there is no base. The job cannot write outside its folder, so a git directory and a common directory outside it are the repository's own, and so are the job's ref and the objects there.
- Case "a repository the job made in its folder does not stand in for the job's base": a bare clone inside the checkout, with `core.bare false`, no remote, the project's id and the ref at the job's commit, and `.git` pointing at it. The test checks that git in the checkout now resolves the ref to the job's commit, then disposes instances. Red on the build above: JOB RULES in the system text.

**Evidence** (macOS, each file run alone from `packages/engine` with `bun test --timeout 30000`):

- Red-before, the three new cases against the build above (its `instruction.ts` in the working tree, the tests new): 3 pass, 3 fail, with each failure as described above. The builder's own red was repeated independently with main's `instruction.ts` restored: `instruction-hold.test.ts` 1 pass and 2 fail (cases 1 and 3, JOB RULES in the system text); `instruction.test.ts` 18 pass and 1 fail (the unit case). The sha256 matched after each restore.
- Green: `instruction-hold.test.ts` 6 of 6; `instruction.test.ts` 19 of 19; `unattended-session.test.ts` 6 pass and 1 skip (bubblewrap-only, skipped on main too); `worktree.test.ts` 20 of 20; `spawn-inventory.test.ts` 14 of 14; `tool/read.test.ts` 45 of 45; `tool/memory.test.ts` 18 of 18; `session/memory-sources.test.ts` 10 of 10; `session/memory-tokens.test.ts` 3 of 3; `session/instruction-project-disabled.test.ts` 2 of 2. `bun typecheck` passes in packages/engine.
- Mutations, each restored afterwards with the sha256 compared equal:
  - MR1: a folder that is not exactly the job's checkout gives no job (`return undefined`) instead of a job with no base. Only the overwritten-marker case went red.
  - MR2: the git-directory check dropped (`own` ignored). Only the forged-repository case went red.
  - MR3: `place()` filters with no job. Only the rules case went red.
  - The plan's M1 repeated on the reviewed code (the base read from `HEAD^{commit}`): case 1, case 3 and the rules case went red.

**What could go wrong (added).**

- In a job's untrusted checkout whose repository has `.vector/RULES.md` or a `BRAIN.md`, every `place()` call now runs two git calls for the base plus two per such file. `place()` runs on most brain calls, a dozen or more times in a turn, for the job's own session as well as a continued one. That is tens of short git runs per turn, in job checkouts only. If it shows, memoise the decision per file by size, mtime and base.
- A job that edits its own `.vector/RULES.md` no longer sees the edit in its own session's digest. That stays inside the same trust domain, as with AGENTS.md.
- With a broken or redirected `.git`, every instruction, rules and memory file in the job's folder is held, including the repository's own. That fails closed. The owner can still trust the folder.
- The forged-repository check reads git's answer, then makes the lookups as separate git runs. A writer that swaps `.git` between them could still get through. Nothing of the job's should be running by the time Continue is offered (continuing a running job is EV-21 (ad)). Passing the checked git directory to each later call would close even that.
- Repository documents (README, `docs/**`) in the checkout still reach the brain's knowledge scan, as documents and not as instructions. That is outside EV-21.
- The wider problem stays open: a continued owner session runs git, formatters and the rest in a folder whose `.git` the job could have redirected. It is recorded under EV-12 and EV-18 (Left open) as a precondition for listing the perk.
