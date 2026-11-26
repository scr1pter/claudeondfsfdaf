# cx-document-sandbox-writes: takeover of PR #161 (unattended host HOME and sandbox comments)

PR #161 (branch `document-sandbox-writes`) was a Codex draft, idle since 2026-11-24 13:13 UTC, with every hosted job cancelled before it started. This run took it over on 2026-11-26 to finish it. No flag changes, no public claims. `VECTOR_EVERYWHERE_ENABLED` stays off, so unattended sessions stay dormant.

Files of the PR's own commits: `packages/engine/src/tool/shell/sandbox.ts` and `packages/engine/test/everywhere/offline-shell.test.ts`.

## 2026-11-26 (UTC), takeover: what the PR carries and the merge order

**What the PR carries.** The title says comments only, but the branch is three layers:

1. Six commits from Codex's open draft #128 (`234ced66a` to `8d81da3b6`: Connect approvals, screened Brain notes, unattended socket filtering, the VectorScope pin). Open PRs #162, #163, #167 and #170 carry the same six commits.
2. `ef83e961d` "fix(everywhere): isolate unattended host home", the whole of PR #149. Codex closed #149 unmerged on 2026-11-25 00:22 UTC, with no comment, and no other branch carries the change. #161 is now the only vehicle for it.
3. `9a93d725a`, the comment-only commit #161 was opened for. It rewrites the `writes: "workspace"` docblock and the bwrap process-group comment so they describe layer 2: a fresh HOME under private /tmp for unattended commands, and both detached callers.

**What layer 2 changes.** Before it, an unattended Linux command ran with the host home folder readable, with only a fixed list of credential stores hidden, and with `HOME` and `PATH` taken from the engine. Now `Sandbox.unattended`:

- resolves the real home, checkout and working folder (`unattendedHome`, `absoluteDirectory`) and refuses a checkout that covers the home folder, a home that overlaps `/tmp/vector-unattended-home`, a working folder outside the checkout, and a bootstrap shell inside the home folder;
- mounts a tmpfs over the canonical home before binding the checkout back writable, then remounts the home read-only, so sibling projects and every other file in the home folder are gone, even through a symlinked alias;
- skips the data-folder, secret and Git read-only mounts for paths the home mask already hides, never binds an ancestor of the home folder back, and masks a credential store's symlink target when it lands outside the home folder or inside the checkout;
- sets `HOME=/tmp/vector-unattended-home` and builds `PATH` from the caller's folders that are outside the home folder or inside the checkout, falling back to `/usr/bin:/bin`.

The plain `Sandbox.offline` (Web access None) and the shell tool's own sandbox are unchanged. The "Web access None's own sandbox is unchanged" assertion in the bubblewrap case pins that.

**Lead rulings.**

- Keep #149's fix in #161 rather than reopening #149 or dropping the fix. The new comment describes the fix, so the two must land together. Reopening a closed Codex PR would also step on Codex's branch.
- Merge order: #161 must merge after #128, or after any PR that lands those six commits (#162, #163, #167, #170). Merging #161 first would land part of Codex's #128 through this PR. A trial `git merge-tree` of this branch against the current heads of #128, #162, #163, #167 and #170 is clean.
- `offline-shell.test.ts` is shared with five open PRs, so the committed tests are unchanged. The macOS proof below unskips the home-plan case in the working tree only, and that edit is not committed.

**Merge with main.** `origin/main` at `b57b8d53a` merged in cleanly. Main has not changed `sandbox.ts` or `offline-shell.test.ts` since the branch point (`f8451dc0b`).

**Evidence** (macOS, each file run alone from `packages/engine` with `bun test <file> --timeout 30000`):

- Green: `test/everywhere/offline-shell.test.ts` 13 pass, 6 skip. The skipped cases need Linux: bubblewrap, or the Linux-only home-plan case. `test/everywhere/unattended-session.test.ts` 6 pass, 1 skip. `test/tool/shell-sandbox-local.test.ts` 8 pass, 3 skip. `test/everywhere/unattended-seccomp.test.ts` 3 pass, 2 skip.
- Red-before: the home-plan case ("the home plan rejects broader checkout grants and excludes inherited aliases into the host home") was unskipped on macOS in the working tree. It passed with the fix. With `sandbox.ts` set back to the exact parent `8d81da3b6`, and then to `origin/main`, it failed both times (`Sandbox.unattendedHome is not a function`). The restored file's sha256 matched the fixed file's.
- Mutations, each restored afterwards with the sha256 compared equal:
  - M1: dropped the refusal of a checkout that covers the home folder. The case went red.
  - M2: dropped the tool-folder filter, so PATH kept folders inside the home folder and its aliases. The case went red.
- `bun typecheck` passed in engine, core, schema, app, desktop, web, tui, server and cloud-workspaces.

**Covered in CI only.** The bubblewrap cases in `offline-shell.test.ts` need Linux with bubblewrap and unprivileged user namespaces: masking the home folder before the checkout bind, the private home hiding a sibling project through an alias, and the checkout and system tools still working. The "Vector everywhere tests" job in `.github/workflows/vector-everywhere.yml` (ubuntu-24.04, installs bubblewrap and fails rather than skips when it is broken) runs them. That job was cancelled before it started for both `ef83e961d` and `9a93d725a`, so hosted Linux has never run this code. It must pass before merge.

**What could go wrong.**

- A toolchain installed under the home folder (`~/.cargo/bin`, `~/.bun/bin`, a version manager's shims) is now left out of an unattended command's PATH, and its files are hidden, so a check that needs it fails instead of running. This is the intended trade: the home folder holds the owner's other projects and credentials.
- A `*_HOME` or `*_ROOT` variable that points into the home folder is still passed through, but the folder it names is masked.
- Codex's container saw two sandbox cases fail on the exact #128 parent, because it denies the bubblewrap UID map and restricts writes under `/var/tmp`. The hosted runner has neither restriction.
- Git breaks inside every unattended job: the job's linked checkout keeps its gitdir and shared Git metadata inside the masked home folder, so `git status` fails with "not a git repository". Not fixed yet; see the review follow-up below for the fix, the test it needs and the lead ruling that keeps #161 a draft until then.

## 2026-11-26 (UTC), review follow-up: linked-worktree Git regression, commit hygiene, PR text

**Regression found in review (not fixed yet).** Every real unattended job runs in a linked checkout that `Worktree.createUnattended` makes with `git worktree add` under the data folder (`<data>/everywhere-worktree/<project>/<jid>`; the data folder defaults to `~/.local/share/...` on Linux). The checkout's `.git` is a file pointing at `<project>/.git/worktrees/<jid>`, and that gitdir and the shared objects, refs and config usually sit inside the home folder. Before `ef83e961d` they stayed readable through `--ro-bind / /`. Now the home tmpfs hides them, and `mayBind` also drops the `linkedWorktreeMetadata` read-only binds (objects, refs, logs/refs) because they are inside the masked home. The result: every Git command inside an unattended sandbox fails with "not a git repository", although an owner's unattended rules can allow `bash git status` (the ruleset `test/everywhere/unattended-session.test.ts` configures does). The committed tests only use a plain `.git` folder under `/tmp`, so CI cannot catch it. Confirmed by reading the code (`sandbox.ts` `wrap()` and `linkedWorktreeMetadata`, `worktree/index.ts` `createUnattended`, `core/src/global.ts`); it needs Linux bubblewrap to reproduce, which this Mac does not have.

**The fix, once the files are free.** After the home mask, bind read-only the job checkout's own per-worktree gitdir and only the shared metadata Git needs to read (`objects`, `refs`, `packed-refs`, `logs/refs`, and the shared `config` and `HEAD`), and nothing else from the home folder. Add a Linux bubblewrap case that runs `git status` (or `git log -1`) in a linked worktree whose shared Git folder sits inside the masked home. It must fail before the fix and pass after it, with one mutation (drop the gitdir bind) going red.

**Lead rulings.**

- `sandbox.ts` and `offline-shell.test.ts` are touched by open PRs #128, #162, #163, #167 and #170 (checked live on 2026-11-26 04:10 UTC), and this run's rules forbid editing a file another open PR touches. So the fix is not made in this push; it is recorded here instead.
- #161 stays a draft. It is not marked ready until the linked-worktree fix lands in it (after #128 and the PRs carrying its commits merge and free the two files) or the owner accepts the regression. While `VECTOR_EVERYWHERE_ENABLED` is off no user can hit it, but landing the home mask without the fix would break Git for every unattended job the day the flag turns on.

**Commit hygiene.** The earlier local merge of `origin/main` used Git's default message without the required `Co-Authored-By` trailer. It was never pushed. Without amending, rebasing or resetting, the branch was rebuilt from the pushed head `9a93d725a`: `origin/main` was merged again with `--no-commit` and committed under the Vector identity with the trailer, and the docs commit was cherry-picked under the same identity. The pushed history only gains commits on top of `9a93d725a`.

**Deadline wording.** The takeover entry above and the PR body no longer name a Saturday deadline. The owner set 2027-01-01 as the deadline for the redesign and for the other open work.

**PR text.** The PR title and body now say what the branch carries: the #149 home-isolation fix plus the comments that describe it, not "limited to comments". The body states that #161 depends on #128 (or any PR landing `234ced66a` to `8d81da3b6`) and must not merge before it.

**Merge gates (unchanged, for whoever merges).**

- The "Vector everywhere tests" job (`.github/workflows/vector-everywhere.yml`, ubuntu-24.04 with bubblewrap) must run and pass on the pushed head. No hosted Linux run has yet exercised the home mask, the sibling-hiding case or the session tests with the filtered PATH.
- Merge only after #128, or after a PR that lands its six commits. `8d81da3b6` is an ancestor of #128's head, and a trial `git merge-tree` against it is clean.
- The linked-worktree fix above, or the owner's acceptance of the regression.
