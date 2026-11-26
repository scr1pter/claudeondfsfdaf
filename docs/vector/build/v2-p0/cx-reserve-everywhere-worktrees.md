# reserve-everywhere-worktrees: durable job reservations for unattended worktrees (#153)

Branch `reserve-everywhere-worktrees` (PR #153), finished locally on `cx-reserve-everywhere-worktrees`. Codex opened the draft on 2026-11-24 and left it idle, so this v2 run took it over on 2026-11-26 to finish it so it lands in main before the redesign starts (the owner's deadline for v2 is 2027-01-01). Vector Everywhere stays dormant: `VECTOR_EVERYWHERE_ENABLED` stays off and no flag changes. Files: `packages/engine/src/worktree/index.ts` and `packages/engine/test/everywhere/worktree.test.ts`.

## 2026-11-26, a job id could be reused after a restart or a lost folder

**Bug.** On main, `Worktree.createUnattended` reserves a job only through its folder (`everywhere-worktree/<project>/<jid>` in the data folder, made with an exclusive mkdir) and its branch (git's ref lock). When a `worktree add` or `reset` failed, the folder and branch were the only record that the job id had been used. Once they were gone (the folder removed and the worktree pruned, or both lost in a crash), the same job id, even with a different base, created a new worktree after a restart. The config and checkout checks also ran only once, before any wait, so a late change to `.git/config` (a smudge filter, or a `core.worktree` that points at another folder) was not seen before git wrote anything.

**Fix** (Codex's two commits, kept as written):

- Before the folder is made, `reserveUnattended` writes a private receipt `<jid>.json` (`{ version: 1, jid, project, branch, base }`) in `everywhere-worktree-reservations` under the state folder, outside the checkout and the data folder. It is opened with `wx` and mode 0600, so any entry already there, including an interrupted write, refuses the job as reserved. The file and, on POSIX, the folder and its parent are synced before git runs. On POSIX the state folder must belong to this user and not be writable by group or others, and the receipt folder must be 0700. Otherwise the job is refused.
- The receipt folder is protected like the unattended root: the ordinary `remove` and `reset` refuse it, a parent of it (the state folder), and any alias of it.
- After both reservations, and before the first command that changes git, the repository's common dir, its effective config and its toplevel are checked again. A refusal at this point keeps both reservations.

**Tests.** engine `test/everywhere/worktree.test.ts`:

- "creates the job's branch at the exact base ..." also checks the receipt's content and its private modes.
- "rechecks config and checkout identity after reservation and stops before mutating Git": a late smudge filter refuses as unsafe, a late `core.worktree` refuses as not the project's own checkout, no `worktree add` or `reset` runs, and the receipt stays.
- "keeps a reservation after git fails, even when the folder and branch are lost and the service restarts": after the folder is removed and the worktree pruned, a fresh service layer still refuses the job as reserved and changes nothing.
- "a partial receipt blocks the same job with a new base and leaves that receipt untouched".
- "refuses to remove a job checkout through an alias or its unregistered parent" now also covers an alias of the receipt folder and the state folder. A nearby ordinary worktree is still removed.
- The early refusals (branch already there, folder already there, unsafe config) leave no receipt.

**Red before the fix.** With `packages/engine/src/worktree/index.ts` put back to origin/main (and the tests kept), 5 of 24 fail: the four receipt cases above and the alias/parent removal case. With the fix, 24 of 24 pass.

**Mutation check.** With the second `checkCheckout()` (the one after the reservation) removed, "rechecks config and checkout identity after reservation ..." fails (23 pass, 1 fail). Restored, 24 pass.

**Other runs.** `test/project/worktree-remove.test.ts`: 2 pass, 2 skipped because they only run on Windows. The "engine (windows)" CI shards cover them. `test/project/worktree.test.ts`: 14 pass. `bun typecheck` in `packages/engine` passes. The earlier CI run on this PR did not test anything: every job was cancelled after four hours of waiting for a runner, without running a step.

**Lead rulings.**

- The state folder check stays. A group-writable state folder would let another account swap the receipt folder and make a job id usable again, so refusing is the safe choice. Known limit for the owner: on Linux distributions that give each user a private group and umask 002, the state folder is created group-writable (0775). There, unattended worktrees are refused until the folder is `chmod g-w`. This does not matter while `VECTOR_EVERYWHERE_ENABLED` is off. Decide before Everywhere is turned on for Linux.
- Every reservation failure, including an unsafe state folder, gives the existing "This job's branch or folder is already reserved." message. Nothing is created in that case. A clearer message for the unsafe-folder case is a follow-up.
- Automatic cleanup and the seven-day retirement are out of scope. #156 builds on this branch for session binding.
