# Connected workspace: handoff (2026-11-11)

This build moves to a new agent. Start here, then read the contract (`connected-workspace-spec.md`) and the deviations log (`connected-workspace-deviations.md`) in this folder. The deviations log records every reading the build made where the contract was silent; it wins over the contract where they differ.

## connect-finish result, 2026-11-16

The connect-finish lane has built every package up to the owner's gates (CN-01 to CN-20). Connect still ships dormant behind `VECTOR_EXPERIMENTAL_CONNECT`, and nothing in the lane turns it on. What remains is the owner's (Q1, Q6, CW-22's `task`, the docs page, the hosted-computer hand-off, Remote's outside review), the held capabilities, and the lead's PR items below. The readiness checklist is [connected-workspace-release.md](./connected-workspace-release.md) and the owner's steps are [../owner-actions/connected-tools.md](../owner-actions/connected-tools.md).

| Package | Commit | Title | Closes |
| --- | --- | --- | --- |
| CN-01 | `0a06668b` | docs(connect): refresh connected workspace checkpoint for v2 | F10; the docs parts of F1 and F7 |
| CN-02 | `690a7d58` | refactor(connect): narrow ConnectGit to connect's own Git reads | CW-20 close-out; F1's Git half |
| merge | `5c81f9f1` | chore(connect): merge release-finish into connect-finish | brings `release-finish` at `cf2373c4` (with `2d022b84`) |
| CN-03 | `c6875c40` | feat(core): resolve named refs inside the private Git view | C3 (part a) |
| CN-04 | `4ea10a92` | feat(core): resolve short commit ids inside the private Git view | C3 (part b) |
| CI repair | `8e547175` | fix(core): keep read-only Git fixtures valid on newer Git and repin review sources | CN-04's CI |
| CN-05 | `fc0ec0c3` | fix(connect): review branches against named and default bases | C3 (part c) |
| CN-06 | `539ec394` | fix(connect): report symlinked project paths honestly | C2 remainder |
| CN-07 | `7ce17182` | fix(connect): sweep stale private Git snapshots and pin git status survival | C5 remainder |
| CN-08 | `409f8de3`, pin `be1eef43` | fix(connect): reconcile orphaned directory review request keys | C6 (part a) |
| CN-09 | `6f3a78ad` | fix(connect): prune settled directory review request records | C6 (part b) |
| CN-10 | `bf7fb313` | fix(app): let a consumed directory review start be started again | C6 (part c) |
| CN-11 | `a350a80c` | feat(connect): list Vector Hands through its availability | CW-21a |
| CN-12 | `21d35b87` | feat(app): show connected review runs in the Tasks pane | CW-21b |
| CN-13 | `e4978408` | feat(connect): describe @vector on GitHub through its own adapter | CW-22, list-only |
| CN-14 | `4bdedc40` | feat(connect): add the connect_cloud consent for cloud hand-offs | CW-23a |
| CN-15 | `ba01e517` | feat(connect): report the cloud workspace place for connected tools | CW-24a |
| CN-16 | `ac8be435` | feat(playbooks): accept read-only connected review stages | CW-23d |
| CN-17 | `8387f746` | feat(desktop): allow connected review routes over Remote with a passkey | CW-23b |
| merge | `3f866f30` | chore(connect-finish): merge PR #33 head 0f034957 (round-1 CI fixes and review fixes) | brings PUB-7 and the other review fixes |
| CN-18 | `6cff8020` | feat(phone): show connected reviews and start one from Remote | CW-23c |
| CN-19 | `34cf53cd` | feat(workspaces): allow connected tools routes through the supervisor | CW-24b |
| CN-20 | `c60aa2d3` | docs(connect): prepare the connected tools release checklist | CW-25 prep only: release checklist, draft page text and owner actions, with Connect pinned off |
| merge | `d359924b` | chore(connect): merge main after PR #33 | clean merge of `main` at `b362fdf6`; brings `9be63d68` and `39865a55` (deviations, "merged main after #33") |

Hosted CI at `34cf53cd`: typecheck.yml 43829042870 passed; connect-app-validation.yml 43829038152 passed, 25 of 25, including CN-12's two Tasks pane cases and CN-10's consumed-key case; vector-workspaces.yml 43829053018 passed; vector-codium.yml 43829047861 failed in three `packages/web/test` files that also fail on `release-finish` at `0f034957` and that `release-finish` fixed in `9be63d68` and `39865a55`, which reach this branch only through the lead's next merge (release checklist, B6). test.yml and verify.yml have never run on this branch; both can be dispatched, and the lane PR runs them.

21 Nov 2026 (v2-closeout-ci): test.yml and verify.yml did run on the lane PR. At PR #38's head `19c48b89` test.yml 43940516400 passed on attempt 2 (attempt 1: a Chocolatey 503 in unit (windows) and the Hands overlay Stop job), verify.yml 43940515963 and typecheck.yml 43940516191 passed, and vector-codium.yml 44848274957 is green on main; B6 is closed in connected-workspace-release.md.

PR finishing fixes, 2026-11-16 (deviations, "connect-finish lane: PR finishing fixes"): Remote's cancel route now requires `sessionID`, and the node-bundle smoke gives its child a private temporary folder. The lead's rulings for this PR are recorded there: Q1 stays owner-gated with Connect off, CN-02's ConnectGit narrowing is accepted, and Q6 stays open. The PR into `main` from `connect-finish` runs test.yml, typecheck.yml, verify.yml and the lane workflows on its head.

For the lead at PR review: D34 gains a run's cancel (or protocol.ts drops it), and the raw-versus-normalized engine path note goes to the cloud-workspaces owner (both CN-19; the path note is closed 21 Nov 2026 (branch `engine-core-fixes`): `validateEngineCommand` refuses any engine path whose raw form differs from `url.pathname`, at the top, for every route (deviations "2026-11-21 — CW-24: the supervisor refuses engine paths with dot segments")); the run read's optional `sessionID` on the supervisor (CN-19); the owners' and the lead's acknowledgements in the release checklist §1.5, which since the phase-review fixes also name CN-18's phone refactor, CN-14's two Hands anchors and the two changes that work with Connect off; and v2-complete-plan §4.1's rows for C2, C3, C5, C6 and F10, which the CN packages above supersede.

21 Nov 2026 (v2-closeout-ci): PR #38 merged as `7e440a27` on 16 Nov, and the inherited vector-codium failures were fixed in `9be63d68` and `39865a55`, both on main. State of the lead items above: v2-complete-plan §4.1's rows are refreshed (C2, C3, C5, C6 and F10 among them, citing the CN commits). D34 and the supervisor's optional `sessionID` are still open: cloud-workspaces.md has a 21 Nov D34 note proposing the CN-19 cancel decision for the lead to confirm. The §1.5 acknowledgements are still pending: PR #38 has no reviews and no comments other than bots (read through GitHub MCP), so none was recorded there.

## Connect-finish checkpoint, 2026-11-14

This section supersedes the head statements below. They are `6070835df` in the 2026-11-12 updates, and `a8234d9ac`, the `build-connect` head that the v2 reviews read but this file never recorded. Nothing below is deleted. The older sections remain the record of what ran at their own sources, and the owner rules at the end of this file still apply.

- **Source.** Work continues on `connect-finish`, cut from `origin/release-finish` at `0ee486e3` (`0ee486e3412c29512022d369325a3747b567d090`), which was PR #33's head when this lane started. PR #33 joins every v2 feature and merges into `main`. As [v2-integration.md](./v2-integration.md) records, v2 is the next release and its version becomes 2.0.0; there is no separate 1.99.113 release. At the time of writing, PR #33's head is `cf2373c4` (`cf2373c46dd90211c44e34165ad8d23a841d922b`); its commits since `0ee486e3` change none of these three documents and none of the source cited here. The newest, `cf2373c4` itself, is docs only and records a Connect read-deny alias gap to integration-runtime-boundaries.md; this branch gets that row only with the next merge of `release-finish`, and it is listed under Remaining work below. Later PR #33 commits reach this branch only through a merge. Until that merge, a local Linux run of `test/connect/vectorscope.test.ts` here fails "the same review from the CLI and from connect > reviews the same fixture with the same fake model and options to the same outcome, apart from session ids". The case came in `093c4a2d`. Its CLI call runs a `vectorscope`-identity review outside `ReviewGit.within`, so `cli/cmd/review.ts:213` refuses it and the CLI returns exit code 2. `release-finish` fixed the test in `2d022b84`. CI passes the case there: test.yml run 43656696007 at `cf2373c4`, engine (linux, shard 4/4), job 132636762529. This lane does not fix it again; it arrives with the lead's merge. This lane's work reaches `main` through its own PR. Where older sections speak of Stage A landing on `main` or name the 1.99.113 release, read the release as v2, shipped as 2.0.0 through PR #33; the owner questions below say what that does and does not decide. Since `5c81f9f1`, the lane's merge of `release-finish` at `cf2373c4`, this branch has `2d022b84`'s fix of the CLI case above and `cf2373c4`'s integration-runtime-boundaries.md row; since `3f866f30` it has PR #33's `0f034957`.
- **Shipping state.** When PR #33 merges, Connect ships dormant in 2.0.0 behind `VECTOR_EXPERIMENTAL_CONNECT` (engine `effect/runtime-flags.ts:46-47`, core `flag/flag.ts:63-66`), which is off unless set. Since the review-fixes lane's PUB-7 (`0aa77586`, on this branch since `3f866f30` merged PR #33's `0f034957`), only that key turns Connect on; the umbrella `VECTOR_EXPERIMENTAL` no longer does. This lane does not change how the flag is read.
- **CW-08's gaps from review connect:fit #10 are closed in source, with tests.** Those three gaps are `vector run` waiting, revert cancelling the review, and `connect_fix` existing only with the flag on. `vector run` waits for a background review through `cli/cmd/run/background-wait.ts` (`test/cli/run/background-wait.test.ts`, three review cases). Reverting the message that started a review cancels its `connect` job in `session/revert.ts:191` (`test/session/revert-compact.test.ts`, "cleanup stops a background connect review"). `connect_fix` is registered only with the flag on: `agent/agent.ts:274` reads the flag, `:598` registers the agent, and `:900` drops a config agent of that name (`test/agent/agent.test.ts:542`). CW-08 "Left open" (3) in the deviations log is still open: the tool part's title stays "VectorScope review: in the background" after the run ends (`tool/connect.ts:112`; the hub patches only the part's metadata, `connect/hub.ts:1556`). It is cosmetic, and no package schedules it.
- **Fixed in the deviations entry "2026-11-14 — v2 integration safety and visibility repairs":** C1, F4/C2 (only the platform part: reviews are unavailable off Linux; the symlinked-path part is CN-06), F8, F9 (`ConnectPolicy.REPAIR_AVAILABLE` is false), C10, C9 and C7. [main-integration-2026-11-14.md](./main-integration-2026-11-14.md), "Repairs made while joining the work", names no finding ids. By this lane's reading it covers C4 (a failed exclusive cleanup quarantines its directory without keeping a dead owner: `project/instance-store.ts:395-403` marks it unconfirmed, drops the owner and settles `released`, and `disposeAllOnce` catches each owner's failure at :325), F5 and C11's config part (scope canonicalization runs only with the flag on and is now `Effect.tryPromise` with a logged fallback at `config/config.ts:1912-1922`), the stat-refresh part of C5 ("Kept review leases valid across harmless Git stat-cache refreshes"; `read-only-git.ts:1612` since CN-07, :1597 from CN-04 to CN-06, :1593 at CN-03 and :1497 before it) and F7 ("Removed temporary compatibility/diagnostic workflows"; `connect-guest-diagnostics.yml` and engine `test/diagnostics` are gone). v2-complete-plan §4.1 still shows C4, F5/C11, C5 and F7 as "Remains"; this reading supersedes those rows except the rest of C5, and the CN-01 deviations entry records it. CN-07 closes the rest of C5 (below). F2, F3 and F6 were fixed in `build-complete` (v2-complete-plan §4.1). The every-user instance-store paths (C11's instance-store part, FIT-2) belong to the review-fixes lane.
- **CW-20 status.** Connect reviews run through `ReviewService.execute` (`connect/adapters/vectorscope.ts` ~570 since CN-06, ~566 before). It wraps VectorScope's collector in `ReviewGit.within` (`review/service.ts:121`). The collector reads Git through `ReviewGit.client`, which prefers that view (`review/git.ts:45`), and a `vectorscope`-identity review refuses without it (`cli/cmd/review.ts:213`). So the collector's Git reads go through VectorScope's ReviewGit, not ConnectGit. ConnectGit (`connect/git.ts`) is entered only at `adapters/vectorscope.ts:400` (`use`; :396 before CN-06) and `connect/hub.ts:1360` (`withTask`), and its job is connect's own checks: the settings check, the model plan, the change scope, the branch base and fix. Since CN-02 (deviations entry "2026-11-15 — CW-20 close-out: ReviewGit collector path pinned, ConnectGit narrowed (CN-02)"), its `query()` translator accepts only the reads connect's own checks emit, and `test/connect/vectorscope.test.ts` pins that the collector's reads are answered by ReviewGit, never by ConnectGit. Consolidating connect's start routes and file ledger onto VectorScope's (Q6) is still open. The VS-32 verdict is wired (`adapters/vectorscope.ts:889`; :885 before CN-06). `connect/review-prompt.ts` is gone. The real CW-20 file list is in spec §6.
- **Every member is on this base.** Hands (`engine/src/computer/availability.ts`), @vector (`core/src/github-agents.ts`), Codium Remote and Playbooks (`desktop/src/main/remote-routes.ts`, `core/src/playbooks/check.ts`) and cloud workspaces (`cloud-workspaces/src/protocol.ts`) are all in `release-finish`. CW-21 to CW-24 therefore no longer wait for a merge, which supersedes "What to build next" item 5. Three of these files have a connect hunk: `core/src/playbooks/check.ts` since CN-16 (committed in `ac8be435`), `desktop/src/main/remote-routes.ts` since CN-17 (committed in `8387f746`) and `cloud-workspaces/src/protocol.ts` since CN-19 (committed in `34cf53cd`). Codium's phone pages (`app/src/phone/remote/model.ts` and `client.ts`, `routes/sessions.tsx`, `session-tasks.tsx`, `remote-parts.tsx` and `approvals.tsx`, and `phone.css`) gain CN-18 hunks (committed in `6cff8020`).
- **Remaining work.** The package ids come from the deviations entry "connect-finish lane plan and docs baseline (CN-01)". Each package marks its line done with its commit.
  - C2 is closed on Linux for instance reviews since CN-06 (deviations entry "C2 remainder: projects opened through a link (CN-06)"); a `task`-target review under a linked data folder is still refused generically (unscheduled). The instance store opens a project reached through a link at its real folder, so such a project lists VectorScope ready and its review runs. The one instance whose path stays as written is a worktree kept lexically, as `TaskIsolation.loadWork` loads a task worktree under a linked data folder. For it, VectorScope's `describe()` now lists itself unavailable with "Open this project through its real folder path to use connected reviews." (`adapters/vectorscope.ts:380-381`), and the hub refuses its review with the same words before any model is checked. `ConnectGit.use` gives that refusal for an instance worktree that is not its own real path (`connect/git.ts:337`, with `LINKED` and `canonical` at :305 and :311). A `directory` that is not its own real path, or a hub-verified task root, keeps the generic refusal (`connect/git.ts:333`). Nothing resolves a link and admits it. Also unscheduled: the task-worktree reason cannot be acted on by reopening the project, and a non-Git instance lists VectorScope by its model state while `use()` refuses it (read from code, not run). That entry has the details.
  - C3 is closed on Linux since CN-05 (deviations entry "C3c: connect branch reviews accept named and default bases (CN-05)"). A branch review's base resolves only inside the qualified ReadOnlyGit view, never through ordinary Git. CN-03 (deviations entry "C3a: named refs and origin/HEAD inside ReadOnlyGit (CN-03)") added the private view's `reference` and `default-branch` reads (`read-only-git.ts:1919` and `:1973` since CN-07, :1904 and :1958 from CN-04 to CN-06, :1833 and :1924 at CN-03). CN-04 (deviations entry "C3b: short commit ids and loose annotated tags through the private object store (CN-04)") made `resolve` (`read-only-git.ts:1726` since CN-07, :1711 before) answer an abbreviated or uppercase commit id only through one commit in the private snapshot. CN-05 wires them into connect: `query()` (`connect/git.ts:82-91`) sends a quiet verify of HEAD or 7 to 40 hex digits to `resolve` and any other spelling to `reference`; `defaultBranch` (`connect/git.ts:273`, `defaultBranch: fail` at :240 before) reads only origin/HEAD through `default-branch`, with no fallback; and one view pins each name's and the default branch's first answer (`connect/git.ts:166-186`). The app sends a 7-to-40-digit `baseCommit` in lowercase (`app/src/features/agents/agent-dashboard-model.ts:63-65`). Off Linux, ReadOnlyGit still refuses and the review stays unavailable.
  - C5 is closed on Linux since CN-07 (deviations entry "C5 remainder: git status survival pinned, stale private-Git snapshots swept (CN-07)"; committed in `7ce17182`). Stat-cache rewrites of the checkout's index (`git status`, and `git add` of a file whose content did not change) no longer stop a review. `test/connect/background.test.ts`, "a background review and the checkout's index" (:1105), pins both between helper prompts. Staging a real content change still stops a review with the plain "cannot be inspected safely" refusal, also when the file itself is then put back, which is accepted fail-closed behaviour. `open()` writes an `owner` marker (pid and process start) into its private folder, best-effort (`read-only-git.ts:1417-1426`, just after the mkdtemp at :1407). `ReadOnlyGit.sweepStale` (`read-only-git.ts:2070`) removes only matching, dead, private snapshot folders of this user older than 24 hours, never following links. `ConnectOwner` runs it once, forked, on `os.tmpdir()` whenever `RuntimeFlags.experimentalConnect` is on (`packages/engine/src/connect/owner.ts`: `Sweep` at :70, the fork at :712-726). The private index is still never persisted (`read-only-git.ts:2003-2005`). The per-check worktree re-hash cost stays Tier C and unscheduled.
  - C6: part 1 is done in CN-08 (deviations entry "C6a: directory-review keys reconcile to bound or consumed (CN-08)"; committed in `409f8de3`, with the pin follow-up `be1eef43`). An owner retry now settles a key that no live claim can hold. If the anchor's job was released, the key binds to it. If not, a terminal `refused/` tombstone keeps it `consumed`, and `bind` refuses that tombstone. Evidence it cannot trust leaves the key `unavailable`. Known failures before the binding gate tombstone the key at once, and an interruption only drops the token. The public API gains the `pending` and `consumed` codes, with the SDK regenerated. Part 2 is done in CN-09 (deviations entry "C6b: directory-request ledger retention and pruning (CN-09)"; committed in `6f3a78ad`). A new admission prunes settled keys: a tombstone or a done run's binding after 30 days, or after 24 hours when its directory or the whole ledger is full, oldest first. A scan cursor keeps keys that can never be pruned from starving the rest. Nothing pending, prepared, live or younger than those windows is ever pruned, and neither is a key bound to a run whose receipt says it is still running or cannot be read (a receipt that `ConnectDirectory.prune` already removed counts as done). A prune or an admission interrupted by a crash finishes or rolls back on the next start, from a journal and an intent in the global index, and never by sweeping files no index names. The caps and windows are layer options with the old defaults. Still open: a binding whose run was still going when the app quit or the engine restarted is never pruned, and neither is a pending key nobody retries. Each counts against its directory's 4,096 for good, and the owner-evidence follow-up is in that entry, unscheduled. Part 3 is done in CN-10 (deviations entry "C6c: the app recovers from a consumed directory review key (CN-10)"). On `consumed`, the app clears that exact saved key, shows the engine's message and offers "Start a new review", which mints a new key only when clicked. On `pending`, it keeps the key and the same "Retry review start", and a `bound` replay confirms as before. Every other failure keeps the key held. C6 is not fully closed in the app. CN-09 asked that a key older than the replay window be treated as possibly new, and CN-10 does not build that: a retried key the engine has already pruned can start a second, possibly billed, review, and a saved `connect_model` approval can skip the ask (follow-up, unscheduled). The bound-but-unreplayable `invalid` answer also still holds its key for good. 21 Nov 2026 (branch `engine-core-fixes`): that answer is now `consumed`, and a bound key's member-gate refusal answers its refused run as its replay does (deviations "2026-11-21 — C6: …" parts 1 and 2). That entry lists the other held items, and its new e2e case (`directory-review.spec.ts:317`) passed in connect-app-validation.yml run 43829038152 at `34cf53cd`.
  - CW-21 Hands: CN-11 is done (deviations entry "CW-21a: Hands list-only adapter (CN-11)"; committed in `a350a80c`). Hands is listed by `connect/adapters/hands.ts` with `ComputerAvailability`'s real reason, and nothing reaches it through connect. CN-12 is done (deviations entry "CW-21b: connect runs as rows in the desktop Tasks pane (CN-12)"; committed in `21d35b87`): the Background tasks pane lists the conversation's own connected runs (member, action, status, verdict, destination, spend) with Cancel while one is going, only for the engine's owner and only with `connections`. Its two e2e cases in `connected-tools.spec.ts` (:549 and :666) passed in connect-app-validation.yml run 43829038152 at `34cf53cd` (job 133169618494). CW-22 GitHub agent: CN-13 is done (deviations entry "CW-22: GitHub agent list-only adapter (CN-13)"; committed in `e4978408`). The member's state and pin come from the workflow file, it has no actions, and the `task` action and the Actions withholding wait for their owners. CW-23a cloud effect: CN-14 is done (deviations entry "CW-23a: the cloud effect and connect_cloud always-ask (CN-14)"; committed in `4bdedc40`). The hub accepts `cloud` only for an action an adapter declared when the hub was built, and asks `connect_cloud`, naming the destination, on every hand-off; no member declares one, and the hosted-computer adapter stays Codium's and the owner's. CW-24a engine place and Vector Local gating: CN-15 is done (deviations entry "CW-24a: the engine reports a cloud-workspace place from the runtime marker (CN-15)"; committed in `ba01e517`). With the supervisor's `VECTOR_CLOUD_WORKSPACE_WORKER=1`, read once into `RuntimeFlags.cloudWorkspace`, the hub lists every member in this engine at place `vector-cloud` and admits hand-offs at that place, and Hands' summary names the workspace; without it nothing changes. The "this computer" and "local" wording of a result, a consent and a permission inside a container is held, as a precondition before the owner turns the pilot on. CW-23d Playbooks: CN-16 is done (deviations entry "CW-23d: Playbooks accept read-only connect stages only (CN-16)"; committed in `ac8be435`). The publish check, which install.ts also runs, accepts a connect stage only as exactly `to: "vectorscope"`, `action: "review"`, and refuses any other at `/stages/<i>/connect`; agent fix stages after the review are unaffected, and running a connect stage stays held. When codium-finish merges, check.ts has one known one-line conflict (that entry, Merge prediction). CW-23b Remote allowlist: CN-17 is done (deviations entry "CW-23b: Remote lets a paired phone list, cancel and start connect reviews (CN-17)"; committed in `8387f746`). While the engine reports `connections`, read for each request, a paired phone may list the members, list and read a conversation's runs, cancel a run, and start one VectorScope review of uncommitted, staged or branch changes after a passkey check bound to that conversation, folder and target; the desktop sends `{to: "vectorscope", target, background: true}` and holds the conversation for a person, as a phone's turn. Fixes, dismissals, registered findings and the sessionless directory review stay unreachable. When codium-finish merges, remote-routes.ts and both test files merge without a textual conflict, and the merged tests pass unchanged (that entry, Merge prediction). CW-23c phone pages: CN-18 is done (deviations entry "CW-23c: the phone shows connect cards and runs, and starts a review with a passkey (CN-18)"; committed in `6cff8020`). With connected tools on, an agent's `connect` call in the phone's conversation is a card read from the engine's own run (status, verdict, where the code went, open findings by severity, up to five finding titles as plain text); the conversation's runs are listed with Cancel; its connected-tools questions show with Allow once and Deny, a fix's question with its change as text; and a VectorScope review of uncommitted, staged or branch changes starts after a passkey tap. Nothing on the phone offers a fix, a dismissal or a worktree. Held there: Q1 and Q6, Remote's outside security review and `VECTOR_REMOTE_ENABLED`, any real phone, relay or desktop run, `connect_cloud`'s presentation, and the hold for a detached run's later questions (that entry, Held). The browser spec is done (2026-11-27, deviations entry "CW-23c: the browser spec covers the phone's connect card, a fix's question and connect off"): PR #105 covers the branch review start and cancel, and branch `phone-connect-e2e` adds the card, the `connect_write` question allowed once with a passkey, and connect off with `REMOTE_CONNECT_OFF`, and adds the spec to connect-app-validation.yml; run locally in Chromium, CI run id still to record. CW-24b workspace proxy routes: CN-19 is done (deviations entry "CW-24b: the workspace supervisor allows connect's reads, cancel and a background review start (CN-19)"; committed in `34cf53cd`; vector-workspaces.yml run 43829053018 passed). `validateEngineCommand` in cloud-workspaces' protocol.ts now passes exactly five shapes: the member and run lists with exactly one `sessionID`, one run's read and cancel by its `cr_` id with no query (cancel with no body or `{}`), and `POST /experimental/session/:sessionID/connect` with exactly `{to: "vectorscope", target, background: true}` for an uncommitted, staged or branch target with an optional checked base. Fixes, findings, dismissals, the sessionless directory review, every other `/experimental` route, extra fields or queries and dot-segment spellings stay refused. The supervisor sends only `content-type` and `x-vector-directory`, and its Docker runtime replaces the authorization with the workspace's own credential, so the engine sees its owner and its owner-only and forwarded-request rules hold. Held there: the "publish screen shows the last verdict" web page, pilot activation and any real host or container, the container wording that CN-15 holds, Q1 and Q6. Open for the lead: whether the run read and cancel should also take an optional single `sessionID`, as CN-17's do, so that a finished conversation run stays readable after a workspace pause and start (that entry, Known limits). The Codium and cloud-workspaces parts are additive hunks only.
  - At the workspaces-finish merge: `docs/vector/build/cloud-workspaces.md` belongs to the cloud-workspaces lane, which rewrites it on `workspaces-finish`, so this lane does not edit it. Its D34 invariant ("the three GETs and the session review start") must gain a run's cancel. This lane reads the CN-19 brief as the explicit decision D34 asks for, but that is not a recorded sign-off on D34, so the PR description asks the lead or the cloud-workspaces owner to confirm it at PR review before merge; if cancel is dropped instead, protocol.ts loses its 4-line cancel branch and its cases. Its line 33 ("a finite session, message, status, model and approval API") must name the connect routes. The cloud-workspaces owner or the lead adds both sentences when that branch meets this one (deviations, CN-19). The same PR description raises, for the cloud-workspaces owner, the older raw-versus-normalized engine path gap (`/session/ses_A/../ses_B/prompt_async` is checked against `ses_A` but forwarded to `ses_B`), with the fix: refuse any engine path whose raw form differs from `url.pathname` at the top of `validateEngineCommand`. Closed 21 Nov 2026 (branch `engine-core-fixes`): `validateEngineCommand` refuses any engine path whose raw form differs from `url.pathname`, at the top, for every route (deviations "2026-11-21 — CW-24: the supervisor refuses engine paths with dot segments").
  - CW-25 prep (CN-20) is done (deviations entry "CW-25 prep: release readiness, a draft docs page and owner actions, with Connect pinned off (CN-20)"; committed in `c60aa2d3`): the readiness checklist, the draft docs page text, the docs-nav line and the two flag lines in [connected-workspace-release.md](./connected-workspace-release.md), none applied, and the owner's steps in [../owner-actions/connected-tools.md](../owner-actions/connected-tools.md). The default switch is excluded. From CN-15, the checklist (§1.2) carries one decision for the owner to make before the cloud-workspaces pilot turns on. With the marker set and Vector Local on, the list reads members "off" that connect never stops (the primary agent, subagents, skills, workflows, the browser, `tool:*`, Hands and the desktop features), because only hub admission enforces Vector Local. So either `located` is restricted to the members connect itself admits (`reach: "connect"`), or Vector Local is made to enforce inside containers. The checklist also carries CN-15's held wording (deviations, CN-15, Held).
  - Unscheduled: the read-deny alias gap that `cf2373c4` records in integration-runtime-boundaries.md (on this branch since `5c81f9f1`). An absolute read deny written with another spelling of the repository (a symlink or junction, a Windows 8.3 short name, `/var` -> `/private/var`) is never applied, because `connect/hub.ts` builds `readOrigins` from realpath spellings (:1110 at `34cf53cd`, :1011 before) and the rules match lexically. The gap predates `release-finish`. No CN package schedules it, and CN-06's symlinked-path check does not close it.
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
- Windows: `local-fit.test.ts`, `prompt.test.ts` (3 s), `task-size.test.ts` (30 s), effect-flock contention, engine `test/tool/task-manage-abort.test.ts` (2 s wait) (`local.test.ts` probe 400 was dropped on 21 Nov 2026: `e817fe51`, merged with PR #40, gives one-address identity reads the full identify budget, and later Windows shards holding `local.test.ts` are green);
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
