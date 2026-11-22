# workspace-clone-depth: CW-24

Branch `workspace-clone-depth`, cut from origin/main `0daede235`. It covers one Vector v2 leftover P0 item, CW-24-clone-depth. The cloud-workspaces pilot stays off: `VECTOR_WORKSPACES_ENABLED` is unchanged, and nothing here creates a workspace on its own.

Files: `packages/cloud-workspaces/src/docker.ts` (only the INITIALIZE Python program) and `packages/cloud-workspaces/test/docker.test.ts`.

**Fold-back.** The plan sent this entry to its own file because `cloud-workspaces.md` and `connected-workspace-release.md` were in v2-closeout-ci and engine-core-fixes. Both have merged since, and no open PR touches `cloud-workspaces.md`, `connected-workspace-deviations.md` or `connected-workspace-release.md` (checked 2026-11-21). Once this branch merges, fold the entry into `cloud-workspaces.md`. In CN-19's Known limit (deviations, "Branch reviews have almost nothing to review in a workspace") and the release doc's "Branch reviews in a workspace" bullet, close only the clone-depth part: the depth-1 clone of one ref and the missing origin/HEAD. Do not close either line as a whole. What remains is an engine-image gap ("Not closed by this branch", below): in today's workspace image no connect review can open its Git view at all. So CN-19's "only uncommitted and staged reviews are meaningful there" is not right either, and both lines should be reworded to name the image gap.

## 2026-11-21, CW-24 workspace clone depth

**The gap.** INITIALIZE fetched one ref at depth 1 and checked out `FETCH_HEAD` detached (`docker.ts`, the `fetch --depth=1` and `checkout --detach` lines). So `refs/remotes/origin/HEAD` never existed, and HEAD had no parent. A branch review with no base reads only origin/HEAD (engine `connect/git.ts`, `defaultBranch`, through ReadOnlyGit's `default-branch` read, which wants a loose `ref: refs/remotes/origin/<name>`). So in a workspace it refused. With an explicit base it found no merge base. Deviations CN-19 records this as a Known limit, which says only uncommitted and staged reviews are meaningful there. That part is not right either: see "Not closed by this branch".

**The fix.** After the unchanged fetch and checkout, INITIALIZE calls `default_history(target)` inside `try/except Exception`:

- (a) `git ls-remote --symref origin HEAD`. There must be exactly one `ref: refs/heads/<name>\tHEAD` line. The name must pass `valid_branch`, a Python copy of the supervisor's `validBranch` (`protocol.ts`), and then `git check-ref-format --branch`. Otherwise the step returns and the clone stays as it was.
- (b) `fetch --no-tags --depth=64 origin +refs/heads/<name>:refs/remotes/origin/<name> <HEAD's commit id>`.
- (c) `git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/<name>`, which writes the loose file. This runs only after (b) has created `refs/remotes/origin/<name>`, so origin/HEAD never names a missing ref.
- (d) Up to four rounds. Each round stops if `merge-base HEAD origin/<name>` answers or the repository is no longer shallow, and otherwise runs `fetch --no-tags --deepen=256 origin <default tip id> <HEAD id>`. The deepest result is 64 + 4 × 256 = 1088 commits behind each tip.
- Every git call shares one budget: 60 s from the step's start, and never later than 150 s from the program's start. Each call's `subprocess.run` timeout is what is left. The init's own 180 s Docker timeout (`create`, `timeoutMs: 180_000`) is unchanged, so a slow first fetch shrinks this step's budget instead of risking the whole init.
- On any exception the step's work stops. The step deletes `.git/shallow.lock` and any `*.lock` under `.git/refs/remotes/origin`, which a fetch killed by its timeout leaves behind and which would block the agent's own `git fetch`. The deletion is itself wrapped, so it cannot fail the init.
- `baseCommit` is still `rev-parse --verify HEAD` after the step. EXPORT is untouched. The credential is still removed in `finally`, and it serves the new fetches through the same `GIT_ASKPASS`. No blob filter, because EXPORT sets `GIT_NO_LAZY_FETCH=1`. Fetches pass `-c protocol.version=2`, which git falls back from if a server lacks it.

**Departures from the plan, for the reviewer.**

1. *HEAD goes by its commit id, not by ref name.* The plan says "both refs into `refs/remotes/origin/*`". The workspace ref can be a 40-hex commit or a short name that git resolves to a tag, so there is no safe tracking name for it. When it is a branch, the first fetch already updated `refs/remotes/origin/<branch>` to HEAD through the remote's default fetch refspec. Fetching the id also means that if the branch moves on GitHub during init, the moved tip is not what gets deepened. The deepen rounds pin both sides by id for the same reason. The existing init already fetches a 40-hex ref by id, so GitHub serving a commit by id is not a new dependency.
2. *A ceiling of 150 s from the program's start.* This is a cap on top of the plan's 60 s budget. Without it, a first fetch that took 130 s would leave the step only 50 s before Docker's 180 s kill, and a clone that works today would fail. Nothing gets longer.
3. *An early stop when the repository is no longer shallow.* If the whole history is already local and still has no merge base (unrelated histories), more deepening cannot help.
4. *Lock cleanup on failure* (above). The plan's "A failure leaves today's clone" otherwise breaks on the timeout path.
5. *Five test substitutions, not three.* Besides the temp root, the file URL and dropping `protocol.file.allow=never`, the test also moves `HOME` and the credential path into the temp root, so the program never reads or unlinks a host path. Each still has to match exactly once.
6. *A third case* for the name rule (below), with its own mutation.
7. *Red came locally.* The cases need only `python3`, plus `git` on INITIALIZE's own PATH (`/usr/local/bin:/usr/bin:/bin`), not Linux tools. So they run on macOS and Linux (skipped on Windows or where either is missing), and no test-only CI commit was needed. `vector-workspaces.yml` already runs `bun test test` in `packages/cloud-workspaces` on ubuntu-24.04.

**Tests** (`test/docker.test.ts`). Each case captures INITIALIZE from the fake Docker runner's init command, as the existing isolation test does. It makes the substitutions and runs the program with `python3 -c`, passing the same stdin shape `create()` sends. The remote is a local bare `vector/example.git` built with `git fast-import` and served over a `file://` URL.

- "the workspace clone records the default branch with enough history for a branch review". main has 80 commits, and feature forks at main~40 and adds 100. The program exits 0 with empty stderr. `baseCommit` is feature's tip. `.git/refs/remotes/origin/HEAD` is exactly `ref: refs/remotes/origin/main\n`. `merge-base HEAD origin/main` exits 0 with main~40. Depth 64 alone stops 37 commits short of the fork, so one deepen round is needed.
- "a branch forked beyond the deepening cap still initializes, bounded-shallow, with the default branch recorded". feature adds 1200 commits. The init succeeds and origin/HEAD is set. `merge-base` exits 1. `rev-list --count HEAD` is 1088, which pins four rounds and no more. The repository is still shallow.
- "a default branch name outside the supervisor's branch rule leaves today's depth-1 clone". The remote's HEAD names `odd+name`, which git accepts and `validBranch` refuses. The init succeeds. There is no origin/HEAD and no `refs/remotes/origin/odd+name`, and HEAD's history is 1 commit.

**Evidence** (macOS, Apple Git 2.39.5 at `/usr/bin/git`, Python 3.9.6; the engine image has Debian bookworm's git 2.39 and Python 3.11). `bun test test/docker.test.ts --timeout 30000` from `packages/cloud-workspaces`, the file alone:

- Red-before. Main's `docker.ts` was put back in the working tree: the fix diff saved, `git checkout --` the file, then `git apply` to restore. The tests were unchanged. Result: 19 pass, 1 skip, 2 fail. The first two cases failed on the origin/HEAD assertion (received `undefined`). The third case passes on both, because it guards the name rule. The restored file's sha256 matched the fixed file's.
- Green: 21 pass, 1 skip. The skip is the existing Linux-only "actual captured initialization and snapshot Python programs parse" case, skipped on main too. CI runs it against the longer program, which the three new cases already execute here. `bun typecheck` passed in `packages/cloud-workspaces`, and prettier reports both files clean.
- Mutations. Each one was applied to a copy of the fixed file and the test file was run alone. Afterwards the fixed file was copied back and its sha256 compared equal.
  - M1, the plan's first: the `symbolic-ref` step deleted. Cases 1 and 2 went red on the origin/HEAD assertion.
  - M2, the plan's second: the deepen loop deleted. Case 1 went red on `merge-base` (status 1 and empty, where status 0 and main~40 were expected). Case 2 went red on the count (64, where 1088 was expected).
  - M3: the `valid_branch` check bypassed. Case 3 went red (origin/HEAD read `ref: refs/remotes/origin/odd+name`).
  - M4: five rounds instead of four. Case 2 went red on the count.

**Not run.** The budget's timeout path and the lock cleanup are read from code, not run. The real container (runsc, the engine image) and GitHub were not used. Fakes only: the remote is a local bare repository. `script/runtime-smoke.ts` creates its workspace without a repository, so CI's runtime smoke does not reach this step either.

**Not closed by this branch: the workspace image cannot run connect's Git view** (read from code, not run). connect's `defaultBranch` and `mergeBase` go through ReadOnlyGit (engine `connect/git.ts:339-352`, which calls `ReadOnlyGit.open`). Opening it needs two things the workspace image lacks:

- Ubuntu 24.04's stock `/usr/bin/python3.12`. ReadOnlyGit's verifier takes its runtime from `DirectoryIdentityReader.pythonImage` (core `read-only-git.ts:515`, `directory-identity.ts:687`). That proof requires `/usr/bin/python3` to resolve to `/usr/bin/python3.12`, and `/etc/os-release` to be Ubuntu 24.04 noble with noble's python3.12 packages installed (`packageProfile`, `directory-identity.ts:319-331`).
- Git 2.43 to 2.56 (`fsckProfile`, `read-only-git.ts:109-118`, called at :1531).

`packages/cloud-workspaces/container/engine.Dockerfile` builds on `node:24-bookworm-slim`, with Debian bookworm's git 2.39 and Python 3.11. So every connect review in a workspace, uncommitted and staged ones included, still refuses there, with or without this branch. This branch makes the clone ready for branch reviews. The image, or ReadOnlyGit's runtime proof, has to change before any connect review works in a workspace. That is for the lead and the cloud-workspaces owner, beside the release doc's §1.2 items for before the pilot turns on. The pilot flag is off, so nothing reaches a customer meanwhile.

**What could go wrong.**

- Connect reviews in a workspace keep refusing in today's image, branch reviews and uncommitted ones alike, because the image cannot run ReadOnlyGit's Git view ("Not closed by this branch", above). This branch alone does not make branch reviews work there.
- Once the image can run that Git view, the deeper history counts against ReadOnlyGit's caps on every open. The object manifest allows 50,000 objects, 1 GiB expanded and 64 MiB for any one object (`INTEGRITY.objects`, `INTEGRITY.totalBytes` and `INTEGRITY.objectBytes` in `objectManifest`, applied to `cat-file --batch-all-objects` at core `read-only-git.ts:1572-1584`). The object store copy allows 50,000 files and 1 GiB (`LIMIT.files` and `LIMIT.objects` in `objects()`, :870-910). A repository that fit at depth 1 can pass those after depth 64 on two lines plus up to 4 × 256 deepen rounds with full blobs. Then every connect review in that workspace refuses, uncommitted ones included, not only branch reviews. Whoever changes the image should weigh the depth and round counts here against those caps (read from code, not run).

- Workspace creation does more network and disk work: two lines of history at depth 64 with full blobs, and up to four deepen rounds, all inside the 10 GiB volume quota and the budget above.
- Very large repositories, or branches more than 1088 commits from their fork, end bounded-shallow. Their branch reviews still report no merge base, as the second case pins. A repository whose first fetch takes past 150 s gets no step at all.
- A killed fetch can leave orphaned child processes (index-pack, the HTTPS helper) for a moment. Nothing writes the repository afterwards until `create()` removes the init container, and the lock cleanup runs before the program exits.
- A default branch whose name is valid in git but outside `validBranch` (for example one with `+` or `@`) gets no origin/HEAD. Its branch reviews keep today's behaviour.
- The pilot flag stays off, so none of this reaches a customer until the owner turns cloud workspaces on.

## 2026-11-21, review round: what CW-24 does not close

An independent review traced connect's path past the clone and found that ReadOnlyGit cannot open in the bookworm workspace image. That gap was there before this branch and is outside CW-24, but the Fold-back paragraph told the lead to close CN-19's Known limit and the release doc's bullet on merge, which would have left an inaccurate close-out. Docs-only changes, made from code reading and not run: the Fold-back now closes only the clone-depth part of both lines, "The gap" no longer repeats CN-19's "only uncommitted and staged reviews" as fact, a "Not closed by this branch" paragraph names the image gap, and "What could go wrong" gains the image-gap bullet and the ReadOnlyGit cap bullet. No code or test changed, so the red, green and mutation evidence above still stands.
