# Connected workspace: handoff (2026-11-11)

This build moves to a new agent. Start here, then read the contract (`connected-workspace-spec.md`) and the deviations log (`connected-workspace-deviations.md`) in this folder. The deviations log records every reading the build made where the contract was silent; it wins over the contract where they differ.

## Connect-finish checkpoint, 2026-11-14

This section supersedes the head statements below. They are `6070835df` in the 2026-11-12 updates, and `a8234d9ac`, the `build-connect` head that the v2 reviews read but this file never recorded. Nothing below is deleted. The older sections remain the record of what ran at their own sources, and the owner rules at the end of this file still apply.

- **Source.** Work continues on `connect-finish`, cut from `origin/release-finish` at `0ee486e3` (`0ee486e3412c29512022d369325a3747b567d090`), which was PR #33's head when this lane started. PR #33 joins every v2 feature and merges into `main`. As [v2-integration.md](./v2-integration.md) records, v2 is the next release and its version becomes 2.0.0; there is no separate 1.99.113 release. At the time of writing, PR #33's head is `cf2373c4` (`cf2373c46dd90211c44e34165ad8d23a841d922b`); its commits since `0ee486e3` change none of these three documents and none of the source cited here. The newest, `cf2373c4` itself, is docs only and records a Connect read-deny alias gap to integration-runtime-boundaries.md; this branch gets that row only with the next merge of `release-finish`, and it is listed under Remaining work below. Later PR #33 commits reach this branch only through a merge. Until that merge, a local Linux run of `test/connect/vectorscope.test.ts` here fails "the same review from the CLI and from connect > reviews the same fixture with the same fake model and options to the same outcome, apart from session ids". The case came in `093c4a2d`. Its CLI call runs a `vectorscope`-identity review outside `ReviewGit.within`, so `cli/cmd/review.ts:213` refuses it and the CLI returns exit code 2. `release-finish` fixed the test in `2d022b84`. CI passes the case there: test.yml run 43656696007 at `cf2373c4`, engine (linux, shard 4/4), job 132636762529. This lane does not fix it again; it arrives with the lead's merge. This lane's work reaches `main` through its own PR. Where older sections speak of Stage A landing on `main` or name the 1.99.113 release, read the release as v2, shipped as 2.0.0 through PR #33; the owner questions below say what that does and does not decide.
- **Shipping state.** When PR #33 merges, Connect ships dormant in 2.0.0 behind `VECTOR_EXPERIMENTAL_CONNECT` (engine `effect/runtime-flags.ts:46`, core `flag/flag.ts:63`), which is off unless set. Today, while that key is unset, the umbrella `VECTOR_EXPERIMENTAL` also turns Connect on. Giving Connect its own opt-in is the review-fixes lane's PUB-7, and this lane does not change how the flag is read.
- **CW-08's gaps from review connect:fit #10 are closed in source, with tests.** Those three gaps are `vector run` waiting, revert cancelling the review, and `connect_fix` existing only with the flag on. `vector run` waits for a background review through `cli/cmd/run/background-wait.ts` (`test/cli/run/background-wait.test.ts`, three review cases). Reverting the message that started a review cancels its `connect` job in `session/revert.ts:191` (`test/session/revert-compact.test.ts`, "cleanup stops a background connect review"). `connect_fix` is registered only with the flag on: `agent/agent.ts:274` reads the flag, `:598` registers the agent, and `:900` drops a config agent of that name (`test/agent/agent.test.ts:542`). CW-08 "Left open" (3) in the deviations log is still open: the tool part's title stays "VectorScope review: in the background" after the run ends (`tool/connect.ts:112`; the hub patches only the part's metadata, `connect/hub.ts:1556`). It is cosmetic, and no package schedules it.
- **Fixed in the deviations entry "2026-11-14 — v2 integration safety and visibility repairs":** C1, F4/C2 (only the platform part: reviews are unavailable off Linux), F8, F9 (`ConnectPolicy.REPAIR_AVAILABLE` is false), C10, C9 and C7. [main-integration-2026-11-14.md](./main-integration-2026-11-14.md), "Repairs made while joining the work", names no finding ids. By this lane's reading it covers C4 (a failed exclusive cleanup quarantines its directory without keeping a dead owner: `project/instance-store.ts:395-403` marks it unconfirmed, drops the owner and settles `released`, and `disposeAllOnce` catches each owner's failure at :325), F5 and C11's config part (scope canonicalization runs only with the flag on and is now `Effect.tryPromise` with a logged fallback at `config/config.ts:1912-1922`), the stat-refresh part of C5 ("Kept review leases valid across harmless Git stat-cache refreshes"; `read-only-git.ts:1597` since CN-04, :1593 at CN-03 and :1497 before it) and F7 ("Removed temporary compatibility/diagnostic workflows"; `connect-guest-diagnostics.yml` and engine `test/diagnostics` are gone). v2-complete-plan §4.1 still shows C4, F5/C11, C5 and F7 as "Remains"; this reading supersedes those rows except the rest of C5, and the CN-01 deviations entry records it. F2, F3 and F6 were fixed in `build-complete` (v2-complete-plan §4.1). The every-user instance-store paths (C11's instance-store part, FIT-2) belong to the review-fixes lane.
- **CW-20 status.** Connect reviews run through `ReviewService.execute` (`connect/adapters/vectorscope.ts` ~566). It wraps VectorScope's collector in `ReviewGit.within` (`review/service.ts:121`). The collector reads Git through `ReviewGit.client`, which prefers that view (`review/git.ts:45`), and a `vectorscope`-identity review refuses without it (`cli/cmd/review.ts:213`). So the collector's Git reads go through VectorScope's ReviewGit, not ConnectGit. ConnectGit (`connect/git.ts`) is entered only at `adapters/vectorscope.ts:396` (`use`) and `connect/hub.ts:1360` (`withTask`), and its job is connect's own checks: the settings check, the model plan, the change scope, the branch base and fix. Since CN-02 (deviations entry "2026-11-15 — CW-20 close-out: ReviewGit collector path pinned, ConnectGit narrowed (CN-02)"), its `query()` translator accepts only the reads connect's own checks emit, and `test/connect/vectorscope.test.ts` pins that the collector's reads are answered by ReviewGit, never by ConnectGit. Consolidating connect's start routes and file ledger onto VectorScope's (Q6) is still open. The VS-32 verdict is wired (`adapters/vectorscope.ts:885`). `connect/review-prompt.ts` is gone. The real CW-20 file list is in spec §6.
- **Every member is on this base.** Hands (`engine/src/computer/availability.ts`), @vector (`core/src/github-agents.ts`), Codium Remote and Playbooks (`desktop/src/main/remote-routes.ts`, `core/src/playbooks/check.ts`) and cloud workspaces (`cloud-workspaces/src/protocol.ts`) are all in `release-finish`. CW-21 to CW-24 therefore no longer wait for a merge, which supersedes "What to build next" item 5. None of those files has a connect hunk yet.
- **Remaining work.** The package ids come from the deviations entry "connect-finish lane plan and docs baseline (CN-01)". Each package marks its line done with its commit.
  - C2 remainder: a project opened through a symlinked path is refused by the realpath equality check in `use()` (`connect/git.ts:277-278` since CN-02: `realpath(directory)` compared with `path.resolve(directory)`). The `active()` task-root check on the next line (:279) is a separate fence and is not part of it. CN-06.
  - C3: a branch review needs a commit id as its base (`connect/git.ts:240` since CN-02, `selected()`'s `defaultBranch: fail`; core `read-only-git.ts:1637` since CN-04, `revision()`, :1633 at CN-03). The base is resolved only inside the qualified ReadOnlyGit view, never through ordinary Git. CN-03 to CN-05. CN-03 is done (deviations entry "C3a: named refs and origin/HEAD inside ReadOnlyGit (CN-03)"): the private view's `reference` and `default-branch` reads (`read-only-git.ts:1904` and `:1958` since CN-04, :1833 and :1924 at CN-03), with no caller yet. CN-04 is done (deviations entry "C3b: short commit ids and loose annotated tags through the private object store (CN-04)"): since CN-04, `resolve` (`read-only-git.ts:1711`) answers an abbreviated or uppercase commit id only through one commit in the private snapshot, and refuses a short id that any ref spells, so an abbreviated or uppercase `baseCommit` resolves through connect's `commitOf` read. Annotated tags under `refs/tags/`, loose or packed, peel through the private object store. Named and default bases still refuse until CN-05. CN-05 remains.
  - The rest of C5: a pinned `git status` survival test, and a sweep of stale `vector-readonly-git-*` snapshots (`read-only-git.ts:1402` since CN-04, :1398 at CN-03 and :1302 before it). CN-07.
  - C6: a directory-review key can stay `pending` (`connect/owner.ts:393-448`), and the file ledger has fixed caps and no pruning (`connect/directory-request.ts:16-17`). CN-08 to CN-10.
  - CW-21 Hands (CN-11, CN-12); CW-22 GitHub agent, list-only (CN-13); CW-23 cloud effect, Playbooks and Remote (CN-14, CN-16 to CN-18); CW-24 cloud workspaces (CN-15, CN-19). The Codium and cloud-workspaces parts are additive hunks only.
  - CW-25 prep only (CN-20): the readiness checklist, a draft docs page kept in docs/vector/build, and owner actions. The default switch is excluded.
  - Unscheduled: the read-deny alias gap that `cf2373c4` records in integration-runtime-boundaries.md (PR #33; not on this branch until the next merge of `release-finish`). An absolute read deny written with another spelling of the repository (a symlink or junction, a Windows 8.3 short name, `/var` -> `/private/var`) is never applied, because `connect/hub.ts` builds `readOrigins` from realpath spellings (:1011) and the rules match lexically. The gap predates `release-finish`. No CN package schedules it, and CN-06's symlinked-path check does not close it.
- **Owner questions.** Q1 is open. As first asked (see "Owner decisions" below), it was whether Stage A may land on `main` behind the flag. The owner's v2 handoff now frames it as turning Connect on by default ([v2-handoff.md](./v2-handoff.md):114, "Turning it on by default is the owner's Q1", and :147). Connect reaching `main` dormant comes from PR #33's merge, which the lead carries out under v2-integration.md; it is not a decision of this lane, and this checkpoint records no Q1 answer. Which release shows the Connected tools view is part of the same question. Q6 is open again, because VectorScope now has its own owner-only start route (`POST /experimental/session/:sessionID/review`) and request ledger (`ReviewRequestTable`, through core `review/request-store.ts`). Moving connect's start routes and file ledger onto them, or deleting connect's, changes the public API and waits for the owner (v2-complete-plan §8 decision 6; review connect:fit #1). Until then, connect's routes and ledger stay. Q2, Q3 and Q4 stay answered. Never ask the MCP snapshot or TUI consent questions again. The held capabilities and every owner gate are listed in that deviations entry.

## Hosted qualification update, 2026-11-12

This update supersedes the earlier pending-CI statements for the source heads
listed here. The current CWI source is
`6070835df17486741745cc809d217e672391e5ff` on `build-connect`. The phase and owner
holds below remain in force; green CI does not activate the held capabilities.

| Receipt | Exact source | Result |
| --- | --- | --- |
| [Full test 43294716509](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43294716509) | `6070835df17486741745cc809d217e672391e5ff` | All 21 ordinary jobs succeeded, including Linux and Windows engine/unit/E2E jobs and the desktop Node engine bundle; three manual jobs were skipped |
| [Typecheck 43294722508](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43294722508) | `6070835df17486741745cc809d217e672391e5ff` | All four jobs succeeded: cloud, App, desktop and engine |
| [Mounted App 43294254210](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43294254210) | `6070835df17486741745cc809d217e672391e5ff` | Hosted App job succeeded; all 21 connected-workspace browser cases passed |
| [Verify 43283916158](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43283916158) | `00cf720fa4307bb2049418faa82ac02d484b9b5e` | All three jobs succeeded: air gap, the 30-minute Vector Local desktop packet capture, and website build |

The three skipped `test` jobs are the manual production App benchmark,
published-release engine evidence and offline request-footprint lanes. They are
not recorded as executed checks. `Verify` is evidence at the prior
production-equivalent source above, not a fresh run at `6070835df`. This update
records workflow/job conclusions and Root's reported browser/diagnostic totals;
downloadable artifact contents were not inspected for this update.

The dedicated Windows diagnostic at `6070835df` passed **730 cases, with one
skip and zero failures**. The earlier guest-budget-`undefined` symptom did not
reproduce. Its cause remains unproven: the diagnostic is not a budget fix, and
no protected budget implementation changed. Keep the symptom and its evidence
distinct from the separately held original-budget continuation capability.

The C2 source and mounted surfaces now have the hosted receipts above. Whole
C2 acceptance still requires its phase review and resolution or explicit
acceptance of the documented capability holds. Automatic repair remains quiet
without original-budget continuation; workflow execution still refuses without
its private helper-scope capability; automatic swarm review remains unavailable
without shared-budget authority. Passing Windows refusal cases does not enable
unsupported private-Git functionality. Q1/main landing, CW-20 through CW-25's
actual branch/interface merge prerequisites, release/default-on activation and
remaining owner actions are unchanged. Hands and cloud-workspace development
remain outside this continuation.

## Continuation checkpoint, 2026-11-12

This section supersedes the historical starting status below. Work continues on `build-connect`; root owns ordinary pushes and CI. Do not assume that every current edit is committed or pushed. The original owner rules below still apply.

- **CW-13:** report-mode after-run reviews are source-qualified (`eea441ec4`). Automatic repair remains quiet because its safe original-budget continuation capability is unavailable; no protected budget exception has been granted.
- **CW-14:** the verified Task-root capability is now source-qualified on Linux in `a4c4f86ce`, with actual saved-task/provider coverage in `e20a8184a`. Root batch123 passed the four focused admission cases and the full 12-case Task lifecycle file; batch124 passed the saved-provider case again and final Engine types. This supersedes the batch118 failure. Task-review fixes must resume/settle the owned task and re-review; they must not silently edit the launching checkout.
- **CW-16:** read-only workflow stage schema/plan/held execution checkpoints are `aed826382`, `df225c944` and `055b117fa`. They describe and validate connected stages, but execution refuses before model work while the private workflow helper-scope capability is unavailable. These commits do not qualify workflow execution or repair.
- **CW-17:** repository user dismissal context is committed separately in Core (`9f2411d26`) and Engine (`543a32a3f`). It updates original finding statuses in place, preserves provenance/cost/verdict, and keeps review context separate from learned facts. The cross-branch VectorScope consumer remains gated.
- **CW-18:** genuine sessionless jobs, private owner consent and sealed receipts now have the later stable request-key ledger and private-Git callback repairs. See the exact source/CI checkpoint below; earlier 15-domain/6-provider/8-HTTP receipts are retained as history, separate from the later qualified Task path.
- **Already authorized:** the owner approved nonstarting MCP status snapshots and keeping the additive TUI consent patch. Do not ask those questions again.
- **Still held:** whole C2 acceptance, unsupported-platform qualification and fresh whole-branch CI remain open. Optional automatic swarm review stays unavailable without shared-budget authority; automatic repair still lacks original-budget continuation, and workflow execution lacks its qualified helper-scope port. Protected budget/prompt changes, Q1/main landing, default-on activation and CW-20 to CW-25 integration retain their actual owner/merge gates. Hands and cloud-workspace development remain outside this continuation's scope.

### Latest committed source and qualified checks

| Checkpoint | Commit | Evidence and limits |
| --- | --- | --- |
| Private-Git callback | `8e22f756d` | Reviewer callbacks stay within the qualified read-only Git service |
| Exact directory admission ledger | `c197dd9ea` | Stable UUID plus exact body, durable lost-response recovery, private job/index binding |
| Generated contract | `526164271` | Root regenerated the keyed directory-review SDK/OpenAPI contract; no hand edits |
| Bootstrap isolation | `8f87e92d9` | Directory overlays cannot mutate global configuration |
| App privacy and retry | `1a7d43733` | Authority/disposal retirement, exact persisted retry identity, guarded settings confirmation and canonical cost display |
| Dedicated mounted App CI | `06fe604e4` | Normal push to `build-connect`; exact-head hosted result below |
| Verified Task-root capability | `a4c4f86ce` | Private, callback-scoped authority minted inside the verified task lock; no serialized root authority |
| Actual saved-task/provider coverage | `e20a8184a` | Full 12-case Linux lifecycle file passed; saved-provider case and Engine types passed again after final fixture typing |

Root batch112 passed Engine types, the API coverage exerciser (**343 passed,
zero failed/skipped/missing/extra**), authorization and effect-boundary checks
(16 each), and the production Node build/transport smoke. The genuine SDK/HTTP
file passed **9 cases / 103 assertions**, including an actual lost response and
recovery using the same request key. Those are source-scoped backend receipts.

Root batch117 passed the three App pure files (controller 13 cases,
reservation 4, owner client 5), App types and E2E source types. Dedicated
[App CI 43260314713](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43260314713)
then passed on exact source `06fe604e4349850a3bc5280c6f894d5c6b4dffe7`:
job `131329488493`, **21 mounted Chromium cases, one worker, zero retries**
(2.4 minutes). This covers both connected-tools and directory-review specs,
including the nine new disposal/confirmation/retry negative cases. It closes
their earlier browser-CI pending item. That exact App result predates the two
Task commits above; it does not qualify their backend changes or the full C2
phase.

The Task repair keeps the hub as the production capability issuer, inside
`TaskIsolation.review`'s verified callback and existing mutex. A private WeakMap
binds the frozen handle to the task's directory, Git directory, common directory
and saved tip. Private `HandoffContext.reviewGit` carries it to the adapter;
acquisition requires the exact task directory and current matching Git identity.
Read operations check that the handle remains live, and callback completion,
failure or cancellation revokes it. Caller JSON cannot supply this authority;
the ordinary instance root, read permissions, budget and consent paths stay in
place.

Root batch123 passed the four focused admission cases and all **12 Task
lifecycle/provider cases** (29.43 seconds). After the final fixture typing,
batch124 passed the actual saved-task provider case again (6.76 seconds) and
Engine types (84.35 seconds). The six private-Git capability cases also passed,
including refusal of copied handles, another directory and use after the locked
callback. Independent source review accepted the boundary. Disposable providers
were used; these are Linux source checks, not unsupported-platform acceptance.

Fresh whole-branch `test`, `typecheck` and `Verify` remain owed on the next pushed
docs head. Root must finish phase review and those checks before claiming C2
acceptance. No release, main merge, default activation, real owner-machine
operation or paid inference is implied by these receipts.

## Where it stands

- **Historical starting branch:** `connected-workspace`, cut from `main` at `0dcbb8e2` (PR #20, the self-evolving merge). The clean/pushed status here described the original handoff only; use the continuation checkpoint above for current work.
- **Built, reviewed and repaired:** phases A1 to A3, which cover CW-01 to CW-08. After each phase, three reviews ran (does it work for real, security and fail-closed, fits the code base), followed by one repair commit.

| WP | What | Commit |
|---|---|---|
| CW-01 | Schema contracts | `ed7b05f99` |
| CW-02 | Pure policy | `5239f061f` |
| CW-03 | Engine hub | `8ff7bee55` |
| A1 review repairs | | `fe3c8bdb6` |
| CW-04 | VectorScope adapter | `3978b55c1` |
| CW-05 | The connect tool | `9e058ad58` |
| CW-06 | `/vectorscope` command | `c6fcde4b6` |
| A2 review repairs | | `0729667c3` |
| CW-07 | Fix and re-review | `f73afec6e` |
| CW-08 | Background runs | `40f99ae1b` |
| A3 review repairs | | `33c8cf309` |
| A3 CI fixes | | `07868188e`, `dbdb19738`, `232efe37c` |

- **CI at handoff:** on `232efe37c`, typecheck passed. `test` (run 43140948951) and `Verify` (run 43140954865) were still running. Check them first, and fix real failures before new work. Only this handoff note and the spec's status line came after that commit.

## What to build next, in order

1. **Phase B, CW-09: public surface** (routes and the generated client). Dispatch CI after it.
2. **Phase C1:** CW-10, CW-11, CW-12, CW-15 and CW-19 (surfaces).
3. **Phase C2:** CW-13, CW-14, CW-16, CW-17 and CW-18 (loops). Dispatch CI after it.
4. **Final review** of the whole branch (`ef73007d3..HEAD`), then repair.
5. **CW-20 to CW-25 wait**, as the contract says, for the other branches to merge: VectorScope, Hands (`hands`), Codium (`codium`), cloud workspaces (`cloud-workspaces`), and @vector (`vector-at-mention`). CW-25 (turn the flag on by default) also needs the owner's yes on Q1.

Each phase was built one WP at a time: build it, run its own test files, typecheck, commit. Then three reviews ran across the phase, one repair commit followed, then a push and CI. That pattern caught real bugs in every phase, so it's worth keeping.

## Owner decisions

- **Confirmed by the owner on 2026-11-09** (they said "Keep them" to the recommended answers):
  - Q2: keep the generic `/review` and add `/vectorscope`.
  - Q3: build `repair`, off by default.
  - Q4: `before_commit` defaults to `offer`.
  - Q6: connect keeps its own start route until VectorScope's VS-10 decides.
- **Still open:** Q1, whether Stage A may land on `main` behind `VECTOR_EXPERIMENTAL_CONNECT`. Nothing goes to `main` without the owner's yes.

## Historical repair notes (current checkpoint supersedes their status)

These are the original A1–A3 observations, not a fresh permission request or a
current backlog. Later checkpoints/deviations supersede them. In particular the
MCP and TUI questions below were approved and completed; never ask them again.
Other historical observations require current-source verification before being
treated as unfinished work.

- **Resolved MCP status read (A1, finding 11):** the owner-approved additive `MCP.snapshot()` is committed in `5f26e3f78`. It reads only existing completed status and does not start servers or read credentials; the old `MCP.status()` observation is superseded.
- **Resolved TUI consent text (A2):** the approved additive connected-tools/consent surface is committed in `04d6468da`. The historical request to keep it open is superseded. The experimental default still remains off for the independent phase/owner gates above.
- **Background runs (CW-08):**
  - `vector run` does not wait for a background connect review. Its tracker lives in `cli/cmd/run.ts` and `run/background-wait.ts`, outside connect's files.
  - Reverting the message that started a review does not stop the review: `session/revert.ts` cancels only task and shell jobs.
  - The tool part's title is stale.
- **A3 leftovers:**
  - With the flag off, `vector agent list` still prints `connect_fix`. Registering it only when the flag is on needs `RuntimeFlags.node` in `agent.ts`'s deps line.
  - Ask rules on the requester's session still don't reach subagents, because `deriveSubagentSessionPermission` in `tool/task.ts` passes only denies.
- **Design change made in A3:** fix children now run no shell at all. This replaces the contract's "ask per command".

## How CI runs on this branch

`test.yml`, `typecheck.yml` and `verify.yml` run only on `main`, on pull requests, or when dispatched by hand:

```bash
gh workflow run test.yml -R scr1pter/claudeondfsfdaf --ref build-connect
gh workflow run typecheck.yml -R scr1pter/claudeondfsfdaf --ref build-connect
gh workflow run verify.yml -R scr1pter/claudeondfsfdaf --ref build-connect
```

Read failures with `gh run view <id> -R scr1pter/claudeondfsfdaf --log-failed`. Re-run once with `--failed` only when the failure is a known flake and nothing else failed in that job. Known flakes:
- a Bun segfault on a Linux shard;
- Windows: `local-fit.test.ts`, `prompt.test.ts` (3 s), `task-size.test.ts` (30 s), effect-flock contention, `local.test.ts` probe 400, engine `test/tool/task-manage-abort.test.ts` (2 s wait);
- packet capture DNS, or the 55-minute packet-capture setup timeout.

## Rules (from the owner; all still binding)

- **Never:**
  - push to or merge into `main`;
  - open or merge a pull request, cut a release, or delete a branch without asking the owner first;
  - force-push, use `--no-verify`, or use `git stash`.
- **Installs, tests and typecheck:**
  - Install with `bun install --ignore-scripts`.
  - Run tests one file at a time from the package directory (`bun test --timeout 30000 <file>`), and `bun typecheck` from package directories.
  - Full suites run in GitHub CI only. Heavy local suites have crashed the owner's Vector app.
- **Things to leave alone:**
  - Never read credential files.
  - Never put the owner's email address in the repository.
  - Never name the open-source project this code was forked from, anywhere.
  - Never touch tokenomics or benchmark files or branches. Another agent owns them, and they matter a lot.
- **Other agents' branches:** don't edit `hands`, `vector-at-mention` (Codex), `vectorscope`, `codium`, `codium-track` or `cloud-workspaces`. Connect to their tools through adapter contracts on this branch, and keep edits to shared files additive, at the contract's anchors.
- **The owner's machine:**
  - Never start or restart the Vector app.
  - Never operate the owner's real computer in tests.
- **Copy:** make no public or comparative claims in docs or copy without the owner's yes.
