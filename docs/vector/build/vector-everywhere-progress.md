# Vector everywhere build progress

The handoff, detailed contract and accepted decisions remain in
`vector-everywhere-handoff.md`, `vector-everywhere-spec.md` and
`vector-everywhere-deviations.md`. The 2026-11-12 continuation used branch
`build-everywhere`. The lane now works on `everywhere-finish`, cut from
`release-finish` (PR #33) at `0ee486e3`. Nothing reaches main except through
the lead's PR merges, and nothing is registered with a platform.

## Tier B status at 0ee486e3 (2026-11-15)

Each row was re-read in the code at `0ee486e3`, and line numbers are at that
commit. It was re-checked after merging `release-finish` `cf2373c4` into
`everywhere-finish` (merge `5733ceea`): no cited file changed. F =
review:everywhere:fit, C = review:everywhere:correctness-security
(v2-notes/connect-everywhere-review-findings.md). EV-xx names this lane's
packages. This table supersedes v2-notes/v2-complete-plan.md §4.2, which still
lists C3 to C6 as remaining; that plan is the lead's record and is not edited
here.

| Finding | Status | Evidence (file:line) | Next |
| --- | --- | --- | --- |
| C1, valid repositories declined as not mapped | Fixed, `bc6ed6cfd` | packages/desktop/src/main/everywhere-git.ts:17 (`core.symlinks`), :18 (`extensions.partialclone`), :23 (`remote.*.gh-resolved`, `promisor`, `partialclonefilter`); the decline reasons are `MAPPING_LOG` at everywhere-runner.ts:91-95, logged at :160; test everywhere-git.test.ts:23 | none |
| C2, numeric cooldown scores | Fixed, `40e708614` | api/_lib/everywhere/store.ts:250-255 (`storeScore`); linear/cooldown.ts:12; jira/client.ts:18; test packages/web/test/everywhere-cooldown.test.ts:36 | none |
| C3, a failed settle after a push reported as nothing published | Delivered (everywhere-runner-delivery.md) | packages/desktop/src/main/everywhere-runner.ts:288-292 (the uncertainty receipt is persisted before the push); :300 (the push takes an independent signal); :306-313 (a confirmed `changes` result is remembered and delivered); :327 (the catch path re-delivers the publication) | none |
| C4, a Linear refresh can break the install | Delivered | api/_lib/everywhere/linear/credentials.ts:95-97 (the rotated pair is saved as `verification: "pending"` before `viewer`) | none |
| C5, ledger release in `finally` | Delivered (everywhere-runner-delivery.md) | everywhere-runner.ts:334-336 (release in try/catch, `active.delete` in `finally`); recovery releases in `finally` at :360-362 (`recover()` at :354) | none |
| C6, a 1 MB cap on the whole stream buffer | Delivered (everywhere-runner-delivery.md) | packages/desktop/src/main/everywhere-engine.ts:75 (2-MiB response cap), :111 (8-MiB per-event cap), :121 (pending-buffer bound) | none |
| C7, the GitHub status lock is never released | Delivered by EV-02 (CI pending) | At 0ee486e3: api/_lib/everywhere/github/status.ts:23 (`"1"`, `onlyNew`, 30 s, never released); the pattern to copy is slack/adapter.ts:88-97 (a token plus `swapValue`). Lines at EV-02's change: status.ts:20-26 (a `randomUUID` token, 120 s), :31 (the job is read under the lock), :36-37 (the `jobStatusEdited` throttle, progress only), :50 (set after the platform write, before the reference write), :53 (`swapValue` release in `finally`); keys.ts:168 (`jobStatusEdited`); tests packages/web/test/everywhere-github.test.ts:186-441 (the gate and fixture helpers at :186-227, then nine cases from :229, the token case at :282) | EV-02's dispatches (vector-everywhere.yml, vector-hosted-ci.yml, typecheck.yml) after the push |
| C8, `bodySha256` is optional | Delivered by EV-02 (CI pending) | At 0ee486e3: packages/schema/src/everywhere.ts:674-675 (optional), :679 (`decodeGithubReference`); api/_lib/everywhere/github/adapter.ts:79-80 (passed through); packages/desktop/src/main/everywhere-github.ts:39-41 (an unedited `updated_at` is accepted instead of the hash). Lines at EV-02's change: everywhere.ts:680 (required for `issues`), the JSDoc at :420-423; adapter.ts unchanged (:82 answers 400 before any write); everywhere-github.ts:39-43 (issues by the hash alone); tests packages/schema/test/everywhere.test.ts:568, packages/desktop/src/main/everywhere-github.test.ts:103 (issues by the hash) and :82 (spec 4.1's comment rule pinned) | EV-02's dispatches (vector-everywhere.yml, vector-hosted-ci.yml, typecheck.yml) after the push |
| C test gap, the runner abort matrix | Covered by EV-03 (CI pending) | Existing cases, one line lower after EV-03's import: packages/desktop/src/main/everywhere-runner.test.ts:297, :306, :325-359, :361-417, :420, :462, :489, :506. EV-03's cases: :538 (a lost acknowledgement of a `held` result, the regression for the fix at everywhere-runner.ts:320), :566 (`stop`/`lost` on `pushing`), :611 (actual HTTP 404/409 on `pushing`), :654 (a heartbeat `stop` before push admission), :690 (a switch `stop` during an admitted push), :747 (`stop`/`lost`/404/409 heartbeats during an admitted push, publication settle refused). Two points wait for the lead (deviations log, EV-03) | EV-03's dispatches (vector-everywhere.yml, typecheck.yml) after the push |
| F1, the lane does not know v2 | Partly fixed | paths added at .github/workflows/vector-everywhere.yml:53 (`codium-keys.ts`) and :55 (`integrations/linear/**`); the push trigger still names `vector-everywhere` (:15), and packages/web/test/everywhere-lane.test.ts:156 pins it | review-fixes FIT-4 (not yet on `release-finish`) |
| F2, the local-run.test.ts comment | Fixed by the merge | packages/engine/test/local-mode/local-run.test.ts:1358-1359 carry process-finish `d2156cb2d`'s two-line comment | none |
| F3, docs do not match the code | Corrected by EV-01 | Corrected: handoff :7, :39, :44, :77, :107; spec :3, :16; api/_lib/everywhere/account-api.ts:51 (now the comment at :51-57). Annotated, the owner's text kept: handoff :100 and :130-131 (a dated note at the end of "Rules"), spec :686. Left: spec :803 (Q1, owner-confirmed) | spec :879 is review-fixes FIT-5 (not yet on `release-finish`) |
| F4, erase registration and the sweep cron | Registration done; cron open | api/_lib/codium-erase.ts:21 (import), :278 (in `ERASE_PARTS`, :244), :294 (`codium` requires `"everywhere"`); the vercel.json `crons` (:526) have no `/api/everywhere/sweep` | EV-04 (R-C11) |
| F5, an engine test imports desktop | Accepted; deviation entry | packages/engine/test/everywhere/unattended-session.test.ts:9 | done in EV-01 |
| F6, a second keep-awake owner | Open (unwired) | packages/desktop/src/main/everywhere-awake.ts:2-13 calls `start`/`stop` itself; the shared blocker is keep-awake.ts:394 (`setDesktopWorkBlocker`) and :453 (`whileDesktopWorks`), set at index.ts:640-651 | EV-18 |
| `75532fc36` (not a finding) | Account authority wired | api/_lib/everywhere/runtime.ts:16-18 (`productionPorts` returns `codiumAccountAuthority`); adapters/account.ts:2 (`tombstoneKey`), :7-13 | none |

## Current software CI checkpoint (2026-11-12)

This checkpoint supersedes earlier chronological entries that still owed hosted
qualification. The reviewed P1c/P2 source is
`15e92e6ac9d75885f53e1edc3ff2712ad5eb9c85`, pushed normally to
`vector-everywhere` by the coordinating agent.

| Check at that exact source | Run | Result |
| --- | --- | --- |
| Dedicated Vector everywhere | [43228105045](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43228105045) | Success, 9/9 jobs; 53/53 test files |
| General typecheck | [43229968596](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43229968596) | Success |
| General test | [43229955763](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43229955763) | Attempt 2 success; 21 successful jobs, 3 manual-only skips |

The phase commit `4915bc64a` first exposed a real native response-contract
failure: Redis `ZSCORE` returned a number that the cooldown parser refused.
Commit `15e92e6ac` accepts valid native numeric/string scores and retains
malformed/negative refusal; batch084 passed its focused tests and API types.
The successful dedicated run then exercised actual Redis on healthy,
digest-pinned Valkey 7.2.14. Test job `131217999679` reports all 53 files passing,
including the new account/link admission, readiness/erasure, wrong-type
poststate, in-flight revocation and canonical `00`/`01` counter cases. Native
resource, Jira draft, delivery/claim/quota and cooldown maximum-ordering races
also passed. No local Redis proof is substituted for that hosted log.

The general test's first attempt had exactly two setup failures: Windows engine
shards 3/12 (`131222518054`) and 7/12 (`131222518086`) received a Chocolatey
community-feed HTTP 504 while fetching ripgrep 15.2.0. Build/tests were skipped
in those jobs. Other Windows shards installed the same version and passed;
Windows E2E and all other enabled jobs passed. Root reran only the two failed
jobs once, producing attempt 2 success without a source/workflow change.

These are software qualification receipts. P3, P4, Surfaces and go-live still
wait for the specified actual branch merges, trusted production ports and owner
actions. No live app registration, native grant, production deployment,
owner-computer proof, paid inference, PR or main merge is implied.

## P1c: VE-06 router, intake and result delivery

Implemented on the working tree based on `f9b19a041`:

- Default-off integration ports and a shared platform adapter contract.
- Verified, bounded-body intake. HTTP acknowledgement does not wait for Redis or
  routing ports. Duplicate delivery creates neither another job nor another
  first signal. Identity, repository mappings and caps precede job admission.
- Laptop-first offers with a twenty-second window, separate busy and lasting
  declines, and reconciliation after an uncertain relay response. Queues remain
  bounded by the existing body lifetime; a claim never falls back to Actions.
- An injected prepared Actions seam: reserve the job before the external
  dispatch. No Actions adapter is registered; its later-phase gates remain.
- Production jobs API hooks for claim, progress, decline, settle and timeout.
  Platform adapters arrive in P2; relay wiring remains deferred to P3.
- An authenticated sweep and an atomic terminal-result posting index, preventing
  process death after the transition from stranding a result. Failed posts
  retry; adapters must update their own job-marked result idempotently.

Root ran files separately from `packages/web`, using Bun 1.3.14, local fakes and
the fetch guard. These are scoped working-tree results, not hosted Redis or
platform acceptance:

| File | Passed | Skipped | Assertions |
| --- | ---: | ---: | ---: |
| everywhere-router.test.ts | 9 | 0 | 37 |
| everywhere-intake.test.ts | 5 | 0 | 21 |
| everywhere-sweep.test.ts | 5 | 0 | 21 |
| everywhere-jobs.test.ts | 42 | 6 | 324 |
| everywhere-jobs-api.test.ts | 21 | 0 | 166 |
| everywhere-keys.test.ts | 14 | 0 | 121 |
| everywhere-lane.test.ts | 13 | 0 | 114 |

The first intake/sweep run exposed fixture mistakes (harness method and mapping
codec). They were corrected using the actual harness and `setMapping`, retaining
the assertions. Final runs pass. The API typecheck passes with the lane's
`bun typecheck --project ../../tsconfig.json` command from `packages/engine`.
Website typecheck passes: zero errors, zero warnings and 207 hints. The real-Redis group remains for CI (four test cases and two skipped setup/teardown hooks locally).

At this checkpoint dedicated handoff-head run `43143498748` had passed scope and
the API/desktop/app/schema typechecks; other jobs were queued. No all-green
hosted result is inferred. P1c still needs VE-07, VE-08 and its real-world,
security and code-fit reviews and repairs before a push.

P2 builds the dormant platform intakes. P3, P4, Surfaces and go-live wait for the
handoff's specified merges and owner actions. No app registration, production
deployment, paid inference, pull request or release occurred at this checkpoint.


## Handoff-head hosted result and address-inventory repair

The dedicated run [43143498748](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43143498748) at `f9b19a041` passed all nine jobs. Its jobs suite passed 46 cases / 349 assertions, including the four real Redis cases: claim-versus-dispatch, twelve concurrent claims, the three-live-job cap, and lease timeout/body erasure. This qualifies the handed-off source, not VE-06's changed Lua.

General run `43141563331` at `12f1793fe` exposed the same deterministic failure on Linux engine shard 1/4 (job `130929521373`) and Windows engine shard 5/12 (`130929521532`): the address inventory did not list the pure GitHub display-link formatter in core/frame.ts. This was not classified as a flake.

The canonical display-link helper now lives beside the existing import-free shared-schema URL validation; core framing delegates to it. No network operation, source registration or compliance assertion was weakened. Valid issue/PR links retain their exact output; malformed repository/reference inputs are refused. Root's focused results: schema 53 passed / 394 assertions, core frame 18 / 465, unchanged egress inventory 5 / 12, and schema/core typechecks pass. Fresh general hosted confirmation remains for the phase push.


## P1c: VE-07 unwired laptop runner

Built the runner, real loopback engine client, signed-offer verifier, git/PR boundaries, local secret/privacy checks, AC-only awake controller and private atomic ledger storage. The runner uses the lower local/server cap, guest/outside/system prompt controls, deny-only unattended permissions, rejected approval requests, lease/deadline/toggle cancellation and interrupted-run recovery. Publishing is a runner operation through a fixed template, never a model tool. Private visibility is read again before pushing; secrets, changed git metadata and unapproved work remain local.

Actual disposable-repository tests demonstrate hook suppression, held-back workflow/hook edits and metadata-tamper refusal. Network git uses a canonical explicit URL and per-job fetched ref, disables executable/global/system configuration, and passes authentication only to that git child. The ledger's exclusive mode-0600 temporary file is synced and atomically renamed; a fresh instance recovers its job, and corruption refuses new work. No owner computer or owner data was used.

Root ran the eight files separately, with the fetch guard: offer 2/11, ledger 4/18, awake 1/5, git 3/26, engine 2/15, scan 2/11, PR 1/7, runner 11/56 (passed cases/assertions). All 26 cases pass; desktop typecheck passes after the actual file adapter. An earlier 25-case pass covered the injected ledger before its file adapter was added.

**An actual prerequisite is missing:** main's ordinary worktree endpoint runs project startup scripts and has no safe unattended mode. The runner therefore requires the explicit `unattended-v1` capability and has no fallback to that endpoint. The precise main-service request is `vector-everywhere-main-requests.md`. Until R-M2 exists, shell execution is always denied. Offer verification has no production key until the owner's key handoff. VE-07 is unwired: this checkpoint does not prove a real laptop job or platform integration. VE-08 and the three P1c reviews remain.

## P1c: VE-08 actual engine behaviour

The new engine test uses the actual authenticated loopback listener and the exact desktop client, with generated credentials, a trusted disposable repository and the existing local fake provider. A personal-memory owner control proves recall is working; the guest-header job and a later headerless continuation of that marked session exclude the same personal fact. The actual provider input carries the fixed unattended system text and outside marker, persisted history has web taint, and the stored rules deny shell, terminals, MCP, connect and questions even with raw user config `permission: "allow"`.

A real provider read-tool call asks for approval, and the desktop client rejects it through the owner's route without a guest header. Another priced provider response exceeds a newly tightened lower budget: the actual session becomes idle, its authenticated spend snapshot records `stopped` with reason `cap`, and the provider receives exactly one non-title request. No continuation is hidden by observing the first completed assistant message alone.

Root ran the single file `test/everywhere/unattended-session.test.ts` from the engine package: **3 passed, 58 assertions, 9.35 seconds** including process startup; engine typecheck passes. The first two runs exposed fixture observation mistakes, not production-policy failures: AppRuntime had a different service graph from the real listener, and instance `/event` filters out core spend events without an instance location. The final fixture reads the existing authenticated `/api/session/:id/spend` route, which snapshots the listener's guard. No engine source changed.

This proves the scoped HTTP behaviour with a local fake provider. It does not qualify the missing safe-worktree capability, offline shell, a real laptop, platform credentials, relay, or Actions integration. P1c still requires the three review passes, repairs, and fresh hosted CI for its changed Lua/outbox.

## P1c self-review: repository and PR identity

The runner now checks the allowed folder's actual GitHub remote through hardened local-config reads and the existing remote parser before creating any worktree or session. A stale project declaration, another repository, a lookalike host or executable config receives the exact-lease `not-mapped` decline. Snapshot creation rechecks the remote; pushes still use the recorded canonical HTTPS URL and explicit branch refspec. Both existing job-marked PRs and newly created PRs must return the exact repository's HTTPS GitHub pull-request URL, with a positive numeric id and no credentials, query or fragment.

Root's focused results after these repairs: git **4 passed / 33 assertions**, runner **12 / 59**, PR **1 / 14**; desktop typecheck passes. The independent P1c review is still pending. A further canonical working-directory proof will be validated separately before that review.

## P1c independent-review repairs (local validation passed; hosted CI pending)

The independent review identified five additional gaps. The following repairs now pass their scoped local checks, and independent re-review closed the findings:

- Pending posts whose records cannot decode or whose platform adapter is absent keep their records and rotate one minute into the future with `ZADD XX`. A full 200-row retained page no longer blocks the next deliverable reply, and rotation cannot recreate an erased member.
- Intake reserves an exact `pending:<jid>` delivery fence. The job-creation Lua must own that fence and writes the durable `job:<jid>` reference with seven-day retention in the same atomic operation. A lost create response cannot create another job after sixty seconds, and an expired worker cannot create or finish over its retry's newer fence. The fake follows the Lua; an additional concurrency case is reserved for hosted Redis.
- Hardened git validates both common-local and active worktree config. Executable includes, filters and URL rewrites in `config.worktree` are refused before network or writes; conflicting remote URLs cannot authorize a stale declaration.
- Snapshots record canonical working, git and common directories as well as metadata hashes. Before network or writes, current authority and both config scopes are checked again. Actual disposable git regressions cover `core.worktree` redirection and a changed `.git` pointer whose old metadata files remain unchanged.
- Added-line scanning parses unified hunk counts. A source addition beginning with `++` remains content even though its diff line starts `+++`; binary, incomplete or malformed patches remain local. Regressions check both secret rejection and actual privacy-check input.

The first git run passed five cases but failed the two linked-worktree cases before their first assertions: an enabled worktree can legitimately have no optional `config.worktree`, and Git's `--worktree --list` fails for that absent file. The corrected boundary validates common config first, resolves the optional path through hardened Git, treats only confirmed absence as empty, and parses every existing bounded file explicitly without includes. Unreadable, malformed, oversized and disallowed config still refuses. All original security assertions remain, with a positive fresh-linked-worktree mapping control. The final git file passes all seven cases; the compatibility delta also passed independent review.

Root's final scoped receipts (Bun 1.3.14, files run separately, local fakes/fetch guard and generated disposable repositories):

| File | Passed | Skipped locally | Assertions |
| --- | ---: | ---: | ---: |
| web/everywhere-dedupe.test.ts | 8 | 4 | 36 |
| web/everywhere-jobs.test.ts | 43 | 7 | 334 |
| web/everywhere-intake.test.ts | 6 | 0 | 29 |
| web/everywhere-sweep.test.ts | 6 | 0 | 34 |
| desktop/everywhere-git.test.ts | 7 | 0 | 73 |
| desktop/everywhere-scan.test.ts | 4 | 0 | 24 |
| desktop/everywhere-runner.test.ts | 12 | 0 | 59 |

API typecheck passes with the existing engine-directory `bun typecheck --project ../../tsconfig.json` command. Desktop typecheck passes after the final compatibility correction. The final git process took 0.69 seconds; these receipts prove no owner-computer operation. Dedupe's four local skips comprise two Redis cases and two setup/teardown hooks; jobs' seven skips comprise five Redis cases and two hooks. The new delivery-admission concurrency case has not run on actual Redis here.

No platform, relay, shell or safe-worktree integration was activated. P1c is ready for the coordinating agent's normal branch push and exact-head hosted lane plus general checks; that hosted qualification is still owed. P2 package builds remain paused until the dedicated lane qualifies. Later activation still needs the safe worktree, R-M2/R-M3, real relay/platform integration, signing keys and owner registration. Dedicated runner tests for all server stop/lost/404/409 responses, five minutes without successful heartbeat acknowledgement and question rejection remain coverage gaps; the existing user Stop/toggle/deadline/recovery/permission cases do not stand in for them.

## P1c push and P2 continuation checkpoint

The coordinating agent normally fast-forwarded `vector-everywhere` to `8a6d7b4ef` and reported exact-head CI queued: dedicated `43159108255`, general test `43159143957`, typecheck `43159147822`. No new hosted success or Redis qualification is inferred here. The coordinator then authorized local P2 source work while those runs proceed, with no P2 push before the P1c Redis lane qualifies. This supersedes the earlier local-build pause; it does not relax registration, integration, PR or main gates.

## P2: VE-10 GitHub (scoped local validation passed)

Built against injected, currently absent production verifier/current-binding/App ports. The deployed handoff answers 501 without those verification prerequisites. Its bounded body accepts references only, refuses non-binders/reruns/dispatch/schedule, dedupes run ids, and offers only to the verified binder. A claim is provisional for GitHub: the desktop verifies the actual trigger before its first `started` report, and the offer timeout atomically refuses only work that has not started. A started report that wins that race remains handled; a timed-out or changed trigger cannot later admit a model run through that lease.

The desktop reads repository/thread/trigger objects through the existing owner-authenticated GitHub API helper, checks immutable author id and unedited timestamps or exact body digest, and labels bounded comments by actual collaborator grants. Review comments use their distinct API. GitHub text and tokens stay on the computer. Optional status delivery stores comment ids in sealed job replies, recovers a lost reference via the App's own marker, limits updates to thirty seconds, and prevents stale progress from overwriting a terminal result. No real App adapter is registered.

New local fixtures cover reference metadata, binder/attempt/event/replay checks, provisional-claim timeout, acceptance races, no GitHub text admission, status persistence/retry/throttling, actual loopback desktop API reads, changed triggers, context bounds and runner ordering. Root's batch 025 ran five files separately with the fetch guard:

| File | Passed | Skipped locally | Assertions |
| --- | ---: | ---: | ---: |
| schema/everywhere.test.ts | 53 | 0 | 401 |
| web/everywhere-github.test.ts | 8 | 0 | 74 |
| web/everywhere-jobs.test.ts | 43 | 7 | 334 |
| desktop/everywhere-github.test.ts | 4 | 0 | 55 |
| desktop/everywhere-runner.test.ts | 14 | 0 | 65 |

API, schema and desktop typechecks pass. The jobs skips are five Redis cases and two setup/teardown hooks. These local results do not qualify live OIDC, App permissions, physical laptop placement, workflow generation or the uncertain-response activation gate. The feature agent ran no Bun or platform operation; VE-10 has not been pushed. Whole-P2 independent review follows VE-13.

## P1c hosted Redis receipt (exact head `8a6d7b4ef`)

The coordinating agent verified [dedicated run 43159108255](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43159108255), test job `130987536311`, as successful and read its official decoded log. It shows healthy pinned Valkey 7.2.14 and passing actual EVAL concurrency cases: atomic delivery-to-jid admission, claim versus dispatch, twelve claimants/one winner, sponsor slots, lease/body erasure and requester slots. This closes the previously missing P1c Redis proof at that exact source. The coordinator subsequently confirmed all nine dedicated jobs successful at `8a6d7b4ef`. General CI reported two real failures, repaired locally in `565c03ea8`: the desktop user-facing workspace wording and the Localmode fake child-stream concurrency setup. Its targeted local checks pass; fresh general hosted confirmation remains owed. None of these older-head receipts qualifies VE-10 or newer P2 sources.


## VE-11 first validation freeze (2026-11-12)

VE-10 was committed as `ffd6ced0b115f347baf3ad6fe76f9109ed09f25f` after batch025 passed all five focused files and API/schema/desktop types. The coordinating agent committed the narrowly scoped general-CI repair as `565c03ea8`; this package does not duplicate it.

The unvalidated Slack candidate adds the signed raw-body HTTP events/interactivity boundaries, deterministic shared runtime adapter factory, native bot OAuth exchange and safe callback, exact-scope manifest, verified requester membership/Enterprise Grid handling, private link/help/status/repository controls, scoped stop, erasure, bounded GET thread reads, native processing/plan/result/feedback messages and persistent message references. Native first-post uncertainty is held with a durable attempt receipt; it is not reported as delivered or blindly reposted. Retry-After survives separate invocations. All channels use shared-place rendering because the minimum scopes cannot prove channel privacy.

Root has the freeze queue: five separate `everywhere-slack-{verify,events,oauth,render,manifest}.test.ts` files, intake/install-API/sweep/keys regressions, API typecheck through the documented engine package command, and web types if needed. The child has run no Bun, test, typecheck, app, external platform call, registration or deployment. No result is claimed before receipts. Native/live acceptance and uncertain-post reconciliation remain explicit release gates.


### VE-11 initial checks and review delta

Root batch028 passed the five separate native Slack files: verify 1 case / 13 assertions, events 9 / 62, OAuth 4 / 26, render 5 / 27 and manifest 1 / 10. The intake/install-API/sweep/keys regressions and API/web typechecks also passed. These receipts describe the initial candidate only.

A self-review then found and repaired gaps before commit: Connect must use signed installation-home context and authorization rather than the event's foreign workspace; absent membership flags must not imply a human member; processing and terminal status must share a fence; shared session titles must not expose a private repository name. The updated fixtures cover an owner request and external actor in Connect, mismatched bot authorization, explicit org-wide installation, real route-to-job/offer, separate report-factory instances and a terminal/status race. Retry-After now takes an atomic maximum with Redis ZADD GT so concurrent shorter responses cannot reopen early; the new focused cooldown file includes a CI-only real Redis race. No existing Lua changed. This second candidate is frozen pending root checks; the first receipt does not qualify these changes.

A further integration concern is explicitly open: a slow native prepare can outlive installation erase and its late pass. The existing create script does not fence the installation record when admitting a job. An exact installation-admission fence and regression are requested from the coordinator before native activation. Default-off configuration and unbound prerequisite runner/dispatch ports remain gates; no production readiness is claimed.


### VE-11 second checks and installation-admission transaction

Root batch029 passed the updated render and cooldown files, common jobs/sweep/intake regressions and API types. Events passed eleven cases and failed its new positive offer test: the native fixture omitted its generated signing key, so the real offer primitive correctly queued the job. The fixture now supplies that generated key; its real claim assertion was retained. This repair is pending validation.

The coordinator authorized the concrete installation race repair. Identity now exposes the decoded installation and exact server-read serialized value together. Generic intake retains that snapshot before native preparation. Its optional create-job path compares the current installation inside the atomic script before any writes; the same transaction checks/increments the existing quota keys and creates the job/indexes. The previous separate generic counter charge is removed. A missing or changed installation returns a private internal verdict, without admitting a job, reserving quota or making a native post. Legacy direct/GitHub callers keep their existing path.

New deterministic intake cases cover real erase, reconnect and credential replacement during a stalled prepare, plus exactly one quota charge on success. Two hosted-only Redis cases cover erase/replacement immediately before EVAL and concurrent verified native admissions yielding exactly three live jobs and three quota charges. The updated fake mirrors the script. These sources are frozen for root's third focused check; new Lua qualification still requires fresh P2 hosted CI. No old-head Redis receipt is counted as coverage for this change.


### VE-11 admission checks passed; queued-reply authority freeze

Root batch030 passed all six focused files (Slack events, intake, jobs, identity, install-API and erase) and API types. This includes deterministic slow preparation across erase, reconnect, credential replacement and same-millisecond tokenless reinstall, plus no quota increment on refusal. A fresh random installation revision prevents equal serialized records after a tokenless reconnect; older records remain readable. The hosted-only create/cooldown races still require fresh P2 CI.

The coordinator then authorized the corresponding queued-reply boundary. Generic intake seals its server-derived authorization revision in reply metadata, overwriting any parsed value; older installations use a fingerprint of the server snapshot. Slack checks current authority before each admitted-job native effect, under its existing status lock, and opens the current token for each call. Reconnect holds old replies; a credential refresh preserving the authorization revision remains eligible. Legacy jobs without proof hold for reconciliation. The latest render/intake/events files and API types are frozen for root checks; no validation is claimed for this final delta yet.


## VE-11 package qualification and commit boundary (2026-11-12)

The final authority delta passed root batch031: Slack render **10 cases / 51 assertions**, intake **8 / 68**, Slack events **12 / 94**, and API types. Root batch030 had already passed identity **39 / 243**, install-API **15 / 116**, erase **10 / 129**, jobs **43 / 334**, intake/events and API types. Earlier unchanged focused files passed: OAuth **4 / 26**, signature **1 / 13**, manifest **1 / 10**; cooldown **1 / 4** after its atomic-maximum repair. The initial web package typecheck passed; fresh whole-P2 package types remain part of hosted qualification. All native HTTP fixtures used generated credentials and loopback fakes under the fetch guard. No real app, workspace, owner computer or model was exercised.

Local skips are intentional and scoped: jobs skips seven real-Redis cases plus two hooks; identity skips two real-Redis cases plus two hooks; cooldown skips its real-Redis race plus two hooks. In particular, the new native-installation/quota create path and concurrent cooldown maximum have **not** been proved against actual Redis locally. Fresh exact-P2-head hosted qualification must run them. The previously green P1c run at `8a6d7b4ef` remains evidence for that older source only.

The package now includes exact raw installation admission before quotas/job/index writes; a fresh opaque revision for every authoritative install/connect, including tokenless same-clock reinstall; server-owned sealed reply authority; and current-authority checks before each native effect, using a refreshed token only when its authorization revision is preserved. It holds ambiguous first Slack posts and legacy unproved/changed-authority replies instead of inventing delivery or replay guarantees.

Software gates still open: first-post reconciliation/live acceptance, current prerequisite laptop/cloud bridge ports and owner surfaces, real Slack/Grid/Connect qualification, owner app registration and privacy/listing review. No PR, push, release, main merge, credential/settings change or paid inference is part of this commit. VE-12 and VE-13 follow as separate packages; whole-P2 independent review precedes the branch push and fresh CI.


## VE-12 first full validation freeze (2026-11-12)

VE-11 is committed as `c9d125e0dac3796d141cbfb3742ab459696ecacd`. The Linear package now has signed raw-body routes, native OAuth and refresh-pair handling, explicit human membership proof, immutable prompt/selection authority, exact activity recovery, whole-plan updates, scoped session admission, stop/reconnect fencing and conservative revocation erasure. Shared private summaries use an injected private account/job surface; missing delivery keeps the terminal outbox.

The source and four separately runnable `everywhere-linear-{verify,webhook,oauth,render}.test.ts` files are frozen. Root owns their runtime checks, API/web package types and shared intake/jobs/identity/install/Slack regressions. No test result is claimed yet. The earlier API preflight reported one UUID nonce inference error, repaired before this freeze; fresh API types are owed. The native-resource create fence includes a hosted-only real Redis regression, intentionally skipped locally. Current docs drift and owner/native/live gates are recorded in deviations. No P2 push or deployment has occurred.


### VE-12 first checks and second freeze

Root batch050 passed signature (1 case / 16 assertions), webhook (13 / 130, with one real-Redis case and two hooks skipped locally), and API types. OAuth passed five cases and failed its reconnect/erase refresh race; render passed eight and failed two cases before native delivery because a display-only URL constant lacked an HTTPS scheme. Web types found three fixture typing errors. These are real failures under repair, not waived checks.

The second candidate fixes absolute native job/auth URLs, rechecks the exact installation after a delayed refresh before any viewer request, and types the generated fake credentials. Self-review additionally found two concrete races: the permanent identity CAS helper removes expiry, so a crash between native-owner replacement and its separate TTL write could strand a session forever; and concurrent same-authorization credential rotation could send an obsolete token or erase its fresh replacement on 401. The coordinator authorized precise repairs. A new native reservation CAS sets its thirty-second expiry in the same transaction, leaving the permanent identity helper unchanged. The native client holds if its opened credential pair differs from the latest authorized pair; a 401 cannot erase a later record. Deterministic lost-response/expiry, twelve-owner reservation races, before-request rotation and during-401 replacement cases retain positive retries. The new reservation script also has a CI-only actual Redis case. All four Linear files, common regressions and API/web types are frozen for root checks again; no second-candidate pass or real Redis proof is claimed yet.


## VE-12 scoped local qualification (2026-11-12)

Root batch052 passed every requested file separately using generated credentials and actual loopback HTTP under the fetch guard:

| File | Passed | Skipped locally | Assertions |
| --- | ---: | ---: | ---: |
| everywhere-linear-verify.test.ts | 1 | 0 | 16 |
| everywhere-linear-webhook.test.ts | 15 | 4 | 144 |
| everywhere-linear-oauth.test.ts | 6 | 0 | 40 |
| everywhere-linear-render.test.ts | 11 | 0 | 74 |
| everywhere-intake.test.ts | 8 | 0 | 68 |
| everywhere-jobs.test.ts | 43 | 9 | 334 |
| everywhere-slack-render.test.ts | 10 | 0 | 51 |
| everywhere-identity.test.ts | 39 | 4 | 243 |
| everywhere-install-api.test.ts | 15 | 0 | 116 |

API types passed in 1.29 seconds through the documented engine-package command. Web `bun typecheck` passed in 29 seconds: 240 files, zero errors and zero warnings. The final four native files took 0.04, 0.32, 0.13 and 0.42 seconds. These results close the earlier URL, refresh-race and fixture typing failures at this source; no assertion was removed to pass them. The source includes atomic terminal-owner replacement with its expiry, lost-response expiry recovery, and both credential rotation/401 negative cases with a successful current-token retry.

Webhook's four local skips are two actual Redis cases and two hooks. Jobs skips seven Redis cases and two hooks; identity skips two Redis cases and two hooks. New installation/quota, native-resource create, reservation-replacement and cooldown scripts/races still require actual Redis on fresh exact-P2-head hosted CI. No local Redis, model, real platform, owner computer, registration or deployment was exercised. The package is ready for its scoped software commit, followed by VE-13 Jira and whole-P2 independent review/repair. Current native and owner surface/distribution/prerequisite ports remain explicitly gated.


## VE-13 first full validation freeze (2026-11-12)

VE-12 is committed as `cd4fcab18694a21abef50f5909db0a8a80df6723` using an ordinary commit with no hook override. Jira sources now include pinned native FIT/JWKS verification, explicit requester/user-token proof, bounded ADF reads, source-only Forge manifest/icon, A2A task admission/poll/cancel/input controls, scoped account/site linking, hard-expiring encrypted drafts, indexed static cleanup and shared/private delivery separation. Current official-doc differences and owner gates are in deviations and `integrations/jira-forge/README.md`.

Root batch054 passed the first production API type preflight in 1.26 seconds. The candidate then received its planned semantic corrections: the fifty-minute text classifies persisted state before sweep, unknown business states retain a stable erase envelope, unconnected terminal controls are persisted, and a concurrent duplicate native message recovers the single admitted task. These changes and all five separately runnable `everywhere-jira-{fit,a2a,adf,render,manifest}.test.ts` files are frozen for the first full runtime check. The actual loopback fixture uses generated native RS256 keys and credentials under the fetch guard. No Jira runtime, fresh candidate typecheck or real Redis pass is claimed yet.

The new task/draft installation/revision/link fence has deterministic negative/positive fixtures and a hosted-only Redis case. Root must run all five files separately plus API/web types and shared erase/identity/install/intake/jobs/Linear/Slack regressions. After scoped qualification, VE-13 needs its package commit, whole-P2 independent review and repairs, normal branch push and fresh hosted Lua/general checks. The approved shared installation-record deletion CAS repair is still owed; no main/PR/platform registration or deployment is part of this candidate.


### VE-13 first full receipts and final Lua coverage follow-up

The first full candidate passed every requested file separately under root's serialized runner:

| File | Passed | Skipped locally | Assertions |
| --- | ---: | ---: | ---: |
| everywhere-jira-fit.test.ts | 4 | 0 | 26 |
| everywhere-jira-a2a.test.ts | 19 | 3 | 216 |
| everywhere-jira-adf.test.ts | 2 | 0 | 9 |
| everywhere-jira-render.test.ts | 6 | 0 | 48 |
| everywhere-jira-manifest.test.ts | 1 | 0 | 16 |
| everywhere-erase.test.ts | 10 | 0 | 129 |
| everywhere-identity.test.ts | 39 | 4 | 243 |
| everywhere-install-api.test.ts | 15 | 0 | 116 |
| everywhere-intake.test.ts | 8 | 0 | 68 |
| everywhere-jobs.test.ts | 43 | 9 | 334 |
| everywhere-linear-webhook.test.ts | 15 | 4 | 144 |
| everywhere-slack-events.test.ts | 12 | 0 | 94 |

API typecheck passed in 1.37 seconds. Web types passed in 26.87 seconds: 246 files, zero errors and zero warnings. These receipts qualify the unchanged production candidate's local software behavior, including the native fifty-minute, membership, one-context, stop, origin, opaque selection, replay, account-erasure and future-state cleanup cases. They do not qualify a platform or owner computer.

A test-only coverage follow-up then extended the existing deterministic and hosted-only draft-fence fixture so it actually executes both new Lua scripts. It now checks stale-revision cleanup refusal, exact task-CAS refusal after a concurrent authorized update, and final current cleanup of task/draft/context plus both indexes. Production did not change. Root's Jira A2A and web-type rerun is pending for that last test delta before the package commit. The three A2A local skips are one actual Redis case and two hooks; no actual Redis proof has run locally. Jobs skips seven Redis cases plus two hooks, identity two plus two hooks, and Linear webhook two plus two hooks.


## VE-13 final local checkpoint and whole-P2 review boundary

Root batch056 passed the final test-only Jira A2A follow-up: **19 cases / 245 assertions**, with one Redis case and two hooks intentionally skipped locally, in 0.77 seconds. Web types passed again in 24.58 seconds: 246 files, zero errors and zero warnings. Production was unchanged from the first full candidate, whose other four native files, seven shared regressions and API types had passed. The new fixture now reaches both write and erase scripts; its actual Redis execution is still owed in hosted CI. The local result must not be described as real Redis proof.

This qualifies the scoped Jira package for an ordinary commit, not a phase push or activation. An independent whole-P2 review is now reading the frozen source. It has confirmed additional cross-package authority gaps requiring a coherent repair before any P2 push: exact authorized installation snapshots must reach erasure; an active-to-closing CAS must precede cleanup and block every late admission; record/index writes must be atomic and preserve a newer grant; generic job admission must fence the exact person link and account closing state; destructive native control events need replay/generation protection; and name-only Linear mapping/selection cannot authorize a reused repository name. Durable account metadata writers, including audit, link-code/OAuth state and readiness, must respect account deletion. This branch does not contain the Codium tombstone implementation, so no existing global closing integration is claimed.

Known findings remain open even though the local component checks passed. The coordinating agent explicitly holds the P2 push until complete authority-race closure and new exact-head hosted Lua/general checks. Owner app registration, actual grants, native payload/identity proof, private surfaces, runner prerequisites, deployment and release gates remain unchanged. No main push, PR, paid inference, production operation or owner-computer action occurred.


## P2 whole-phase authority repair: final local qualification

The final repair supersedes the earlier unqualified candidates. An installation closes atomically before cleanup, with a permanent opaque epoch preventing absence ABA. Record/index writes and all fixed Lua mutations preflight their Redis key types; counters require canonical unsigned integer encoding, including rejecting `00` and `01` before any quota increment. Intake resolves and admits from one exact mapping snapshot and one exact person link. Account closure/tombstones are checked in the same mutation transaction. Native legacy jobs missing sealed authority hold; due-only terminal cleanup can retire them without requeue, body recreation or native effects. Foreign actor requests return the same 404 as missing jobs before target-account authority is read.

Native replies recheck the captured token, account, link, installation and task after cooldown/refresh waits immediately before transport. Slack and Linear controls use durable signed semantic receipts pinned to a generation. Slack current-token proof preserves a valid reconnect; ambiguous controls hold without deletion. Linear renewable authentication failures and un-attributable permission controls never imply revocation. Positive immutable repository IDs are required for native choices.

Native disconnect revocation records pending/confirmed/uncertain closing phases. Only the initial closer invokes the captured transport. Concurrent local cleanup can purge credentials/content but cannot reopen that generation. A confirmed response can complete only the same closing nonce/authority/connector; stale proof cannot affect a replacement. Unknown outcomes keep a token-free barrier and owner HTTP202/GET `review-native-revocation`; retries neither reissue blindly nor trust a caller's `nativeConfirmed`. After confirmed transport, interrupted cleanup is visible through owner GET and retries without a second revoke. Default installation cleanup always cancels every indexed live job, including foreign-sponsored bodies, through the exact closing facade even when no jobs port or active-account adapter is supplied.

Root ran each affected file separately under Bun 1.3.14, with generated data, loopback fakes and the fetch guard. Final source checks passed API types in batch078 and web types in batch079 (249 files, zero errors, zero warnings). The table records final affected-file receipts. Earlier common/native checks passed batch075; later source changes were covered by the targeted078/079 checks. Those earlier receipts do not represent an all-files rerun of the final head.

| File | Root batch | Passed | Skipped | Assertions |
| --- | --- | ---: | ---: | ---: |
| everywhere-authority.test.ts | 078 | 20 | 7 | 225 |
| everywhere-control.test.ts | 078 | 13 | 0 | 123 |
| everywhere-jobs.test.ts | 078 | 43 | 9 | 329 |
| everywhere-jobs-api.test.ts | 078 | 22 | 0 | 226 |
| everywhere-limits.test.ts | 078 | 11 | 3 | 77 |
| everywhere-erase.test.ts | 079 | 10 | 0 | 146 |
| everywhere-install-api.test.ts | 078 | 17 | 0 | 139 |
| everywhere-slack-render.test.ts | 079 | 10 | 0 | 51 |
| everywhere-linear-webhook.test.ts | 078 | 15 | 4 | 146 |
| everywhere-linear-render.test.ts | 078 | 11 | 0 | 74 |
| everywhere-jira-render.test.ts | 078 | 6 | 0 | 48 |

Earlier candidates exposed actual source/type/fixture issues, all repaired before the final receipts. In particular the erase tests now assert exactly the retained epoch/account marker keys, values and permanent TTL semantics. The default erase-part test proves a real foreign-sponsored cancellation uses the deletion clock while an unverified teammate's audit remains unchanged. Native tests assert the earlier shared authority error and preserve zero-later-effect/full-replacement checks. The final two fixture corrections passed batch079 (erase10/146, Slack render10/51) without a production change.

The final production boundary received two read-only reviews. The storage/deletion reviewer closed mapping snapshots, all-key/canonical-counter preflight, newest-code consumption, default foreign-sponsored erasure and per-loop actor ownership; prior test-helper/core-fixture authorship was disclosed. The separate native reviewer closed captured-token preflight, pending revocation serialization, exact same-generation confirmation, uncertain owner recovery and local account erasure without active authority. Neither reviewer ran tests or contacted a platform.

Those were scoped local receipts. Their outstanding hosted requirement is now closed by the exact-source CI checkpoint at the top of this journal, including actual Redis execution of the locally skipped admission/link/tombstone, readiness, wrong-type/canonical-counter and revocation-concurrency cases. No local Redis was started. No paid inference, real native workspace, owner computer, registration, deployment, PR or main change was used.

P3, P4, Surfaces and go-live remain held for their specified merges and owner actions. The real mode-separated Codium tombstone port is missing here and fails closed; tests inject it explicitly. Native uncertainty/process-death reconciliation is not automatic. Minimal closing/account/epoch security metadata may remain after private data is purged; external provider work already delivered and out-of-band reinstalls cannot be canceled by a final preflight. Those native acceptance/retention/reconciliation questions remain actual live gates, not passing software evidence.

## EV-01: docs refresh (2026-11-15)

Docs plus one JSDoc comment; no runtime, flag, route, page, generated file or
dependency change, so no test was added.

Before the edits, `release-finish` had moved from `0ee486e3` to `cf2373c4`.
It was merged into `everywhere-finish` as `5733ceea` (no conflicts; no lane
file, cited file, package.json or bun.lock among the incoming changes). The
API typecheck passed after the merge (exit 0).

Files changed:

- api/_lib/everywhere/account-api.ts: the `AccountApiDeps.exchanges` JSDoc
  (:51, now :51-57) names `platformExchanges` and says when oauth-finish
  answers 404 (a platform that is not on) and 501 (a platform that is on with
  no exchange for the purpose). Only comment lines changed.
- vector-everywhere-handoff.md: the 2026-11-12 status paragraph now names the
  merged branches and the current vehicle (PR #33, then `everywhere-finish`);
  the Codium deletion-port bullet notes `75532fc36`; the runner bullet lists
  the abort cases that exist and the ones EV-03 adds; Build order item 2 says
  the Slack and Linear exchanges exist, with the 404 and 501 answers; a dated
  "Later phases" note; the unknown-fields item says `decodeJobRecord` refuses
  them; a dated CI note (every run on `everywhere-finish` is a
  workflow_dispatch until a pull request from it is open); a dated annotation
  after the owner's rules.
- vector-everywhere-spec.md: the status line (:3), the push instruction (:16)
  and a dated note after Stage A (:686). :803 (Q1) and :879 (review-fixes
  FIT-5) are untouched.
- vector-everywhere-progress.md: the opening paragraph, the "Tier B status at
  0ee486e3" table above, and this entry.
- vector-everywhere-deviations.md: the F5 entry and the EV-01 decisions.

Checks (each through the lane's `vector-serial` lock, one at a time):

| Check | Result |
| --- | --- |
| API typecheck, `bun typecheck --project ../../tsconfig.json` in packages/engine, after the merge | exit 0 |
| The same, after the edits | exit 0, 22 s |
| The same, after the review fixes (the JSDoc's 404/501 wording) | exit 0, 17 s |
| packages/engine test/compliance/upstream-free.test.ts, with a clean inherited environment (`env -i`, fresh HOME under /tmp/vector-v2/everywhere/) | 12 pass, 0 fail, 53 assertions |
| The same file with this session's own environment | 11 pass, 1 fail, 53 assertions: "a GitHub token does not take the default model from an OpenAI key" resolved `amazon-bedrock` instead of `openai`, which this shell's inherited environment selects; the name scans all pass, and the clean run above passes |
| Prettier on account-api.ts | the file already differed from prettier at HEAD (46 diff lines); the same 46 after the edit, none in the new comment |
| Diff guards | 5 files; no added personal path, email address or new code line over 120 columns |

EV-01 is merge commit `5733ceea` plus one docs commit. The full turbo
typecheck and the CI dispatches run with the push, and their run ids go in the
next progress entry (EV-02's). typecheck.yml (the brief's CI) does not run the
API typecheck: its matrix is app, cloud, desktop and engine `bun typecheck`
plus the vectorscope-eval job. vector-everywhere.yml's `api` typecheck entry
(:130-132) is the hosted proof of the API typecheck and of the F5 mitigation,
so the first push of `everywhere-finish` should dispatch both workflows on
that ref.

Other facts checked: `build-everywhere` is still on origin (`5053d490`) and is
merged into this branch, as are `vector-everywhere` (`890bb072`) and
`v2-everywhere` (`40e70861`). review-fixes' FIT-5 commit had not landed (not
an ancestor of HEAD, and review-fixes is not on origin), so spec :879 was left
alone.

## EV-02: C7 status lock and C8 issue body hash (2026-11-15)

Base: HEAD `b82acf57` (EV-01, pushed). `git fetch origin release-finish main
everywhere-finish` found `release-finish` still at `cf2373c4`, already merged
(`5733ceea`), and `everywhere-finish` equal to HEAD, so no merge was needed.
EV-02 depends on no review-fixes commit and no brain-transport work. The
changes were written and checked in the working tree first, as this
package's brief asked; the commit gate at the end of this entry re-ran the
checks and committed them in one commit.

Files changed:

- api/_lib/everywhere/github/status.ts (C7): the lock is a `randomUUID`
  token, 120 s, `onlyNew`, released with `swapValue` in `finally` (:20-26,
  :53); the job is read under the lock (:31); progress returns while
  `jobStatusEdited` exists (:36-37), and sets it for 30 s after the platform
  write and before the reference write (:50). `GithubStatusPort` and the
  `githubStatus` signature are unchanged.
- api/_lib/everywhere/keys.ts: `jobStatusEdited(jid)`
  (`vector:everywhere:job:<jid>:status:edited`, :168) and a JSDoc on
  `jobStatusLock` (:165).
- packages/schema/src/everywhere.ts (C8): `githubReference()` refuses an
  `issues` reference without `bodySha256` (:680); the `bodySha256` JSDoc
  (:420-423). One helper, so `decodeGithubReference`, `decodeInboundTrigger`,
  `decodeJob` and the server's `decodeJobRecord` all refuse it.
- packages/desktop/src/main/everywhere-github.ts (C8): an `issues` trigger is
  decided by the body hash alone (:39-43); comment triggers are unchanged.
- api/_lib/everywhere/github/adapter.ts: unchanged; :79-82 already refuse a
  reference that fails to decode with 400 `HANDOFF_INVALID` before any write.
- Tests: packages/web/test/everywhere-github.test.ts (9 new cases, :186-441,
  the new block prettier-formatted; the ninth, at :282, pins the token in the
  lock release and was added after review), packages/web/test/everywhere-keys.test.ts
  (1 new case and 1 refusal), packages/schema/test/everywhere.test.ts (1 new
  case, :568), packages/desktop/src/main/everywhere-github.test.ts (2 new
  cases: :103, issues by the hash alone; :82, added after review, pins spec
  §4.1's comment rule, equal timestamps with a mismatched hash accepted).
- Docs: vector-everywhere-deviations.md (the EV-02 entry),
  vector-everywhere-spec.md (three dated notes: after §4.1 item 1, after the
  Phase 2 table for the VE-10 row, after R-A6; the owner's text is kept, and
  every later spec line moves down by up to four, so review-fixes' FIT-5 line
  is now found by its text), this file (the C7 and C8 rows of the Tier B
  table, and this entry).

No route, page, flag, generated file, dependency or install. The feature stays
dormant: the handoff still answers 501 without an injected verifier and
binding, and no production `GithubStatusPort` exists.

Checks (each through the lane's `vector-serial` lock, one file per run, from
the package directory; real-Redis cases skip without `VECTOR_TEST_REDIS_URL`):

| Check | Result |
| --- | --- |
| packages/web test/everywhere-github.test.ts (changed) | 16 pass, 0 fail, 131 assertions, 0.30 s; again after formatting the new block: 16 pass, 0 fail, 131 assertions, 0.35 s; after review, with the token case: 17 pass, 0 fail, 137 assertions, 0.33 s |
| packages/web test/everywhere-keys.test.ts (changed) | 15 pass, 0 fail, 126 assertions, 0.07 s |
| packages/schema test/everywhere.test.ts (changed) | 54 pass, 0 fail, 412 assertions, 0.03 s |
| packages/desktop src/main/everywhere-github.test.ts, `--no-env-file` (changed) | 5 pass, 0 fail, 71 assertions, 0.21 s; after review, with the comment-rule case: 6 pass, 0 fail, 83 assertions, 0.22 s |
| packages/web test/everywhere-jobs.test.ts (regression: `decodeJobRecord`) | 43 pass, 9 skip (real Redis), 0 fail, 329 assertions, 0.24 s |
| packages/web test/everywhere-jobs-api.test.ts (regression) | 22 pass, 0 fail, 226 assertions, 0.53 s |
| packages/web test/everywhere-sweep.test.ts (regression: the outbox) | 6 pass, 0 fail, 34 assertions, 0.30 s |
| packages/web test/everywhere-slack-events.test.ts (regression: the shared lock key) | 12 pass, 0 fail, 94 assertions, 0.33 s |
| packages/desktop src/main/everywhere-runner.test.ts, `--no-env-file` (regression: decline `trigger-changed`) | 33 pass, 0 fail, 212 assertions, 0.09 s |
| API typecheck, `bun typecheck --project ../../tsconfig.json` in packages/engine | exit 0 |
| packages/schema `bun typecheck` (covers test/) | exit 0 |
| packages/desktop `bun typecheck` | exit 0; it excludes `src/**/*.test.ts`, and the test imports `bun:test`, which desktop's `types` do not include, so the desktop test is checked only by running it |
| packages/web `bun typecheck` (astro check, covers test/) | 0 errors, 0 warnings (288 files); again after formatting: 0 errors, 0 warnings; after review (the token case and its `setValue` import): 0 errors, 0 warnings (288 files) |
| Prettier drift (lines prettier would change), HEAD then now | status.ts 30 then 28; keys.ts 27 then 27; schema everywhere.ts 36 then 36; desktop everywhere-github.ts 110 then 110; web everywhere-github.test.ts 170 then 170; everywhere-keys.test.ts 0 then 0; schema everywhere.test.ts 16 then 16; desktop everywhere-github.test.ts 99 then 99; after review, web everywhere-github.test.ts 170 and desktop everywhere-github.test.ts 99, so the two added cases add none |
| Diff guards | no added personal path or email address; no new code line over 120 columns except the two status.ts lines that only gained two spaces of indent (`existing` at :41, the invalid-reference throw at :43) |

Mutations (each a patch under /tmp/vector-v2/everywhere/ev02-mut/, applied,
run, and reverted with `git apply -R`; the three source files' SHA-256 sums
matched their pre-mutation values afterwards). Every mutation turned its case
red:

| Mutation | Red cases |
| --- | --- |
| No lock release | 9 of 16 in everywhere-github.test.ts, including the four new lock cases (the two gated ones time out at 30 s, as the lock is never free) and the existing :137 and :164 cases |
| Job read before the lock | "progress that waited for the lock never overwrites a terminal status" only |
| No throttle | "progress within 30 s of the last edit is dropped", "a post whose reference write failed still spaces the next progress edit", and the existing :137 case |
| Terminal posts honour the throttle | "a terminal post that met the lock succeeds on retry" only |
| Throttle set before the platform write | "a failed progress edit releases the lock and sets no edit throttle" only |
| Throttle set after the reference write (the plan's original order) | "a post whose reference write failed still spaces the next progress edit by 30 s" only |
| Schema rule removed | the schema case, and "an issues handoff without bodySha256 gets 400" |
| Desktop keeps the timestamp proof for issues | "an issue trigger is proved by its body hash alone" only |
| After review: an unconditional `DEL` of the lock in place of `swapValue` | "a post whose lock expired releases only its own token" only (1 of 17) |
| After review: a present hash decides a comment trigger on its own | "a comment trigger with unedited timestamps is accepted even with a mismatched hash" only (1 of 6) |

The two after-review mutations were applied by copying the file aside,
editing it, running the one file and copying it back; the SHA-256 of status.ts
and of desktop everywhere-github.ts matched their pre-mutation values
afterwards. The rows above them were run before the token case existed, at 16
cases; line numbers in them are the current ones.

EV-01's push receipts, at `b82acf57` (all workflow_dispatch on
`everywhere-finish`, re-read with the GitHub tools for this entry):

- vector-everywhere 43659585176: success.
- vector-hosted-ci 43659588075: success.
- typecheck 43659593581: success.
- vector-at-mention 43659590964: failure in job 132645692417, "sandbox
  (codium, success, bun)". The Bun probe throws "The tool process probe
  attempted external network access" (Bun v1.3.14) and the next step finds no
  vector-out/summary.json. It is inherited from the base: the same job fails
  with the same two log lines on `release-finish` at `cf2373c4` (run
  43656695886, job 132636679771), and at `0ee486e3` the same job failed at
  the same step (run 43636452570, job 132574203362). It is @vector's sandbox
  probe, not a lane file; it is recorded for the lead and was not re-run.

Commit gate (2026-11-15): `git fetch origin release-finish main
everywhere-finish` again found nothing new (`release-finish` `cf2373c4`,
already merged; `everywhere-finish` equal to HEAD `b82acf57`), and the working
tree held only this package's eleven files. Re-run, one file at a time through
`vector-serial`:

| Check | Result |
| --- | --- |
| packages/web test/everywhere-github.test.ts | 17 pass, 0 fail, 137 assertions, 0.32 s |
| packages/web test/everywhere-keys.test.ts | 15 pass, 0 fail, 126 assertions, 0.06 s |
| packages/schema test/everywhere.test.ts | 54 pass, 0 fail, 412 assertions, 0.03 s |
| packages/desktop src/main/everywhere-github.test.ts, `--no-env-file` | 6 pass, 0 fail, 83 assertions, 0.21 s |
| API, schema and desktop `bun typecheck` | exit 0 each |
| packages/web `bun typecheck` | 0 errors, 0 warnings (288 files) |
| Full `bun turbo typecheck --concurrency=2` | exit 0, 27 of 27 tasks (22 cached) |

Deferred:

- EV-02's own CI (vector-everywhere.yml, vector-hosted-ci.yml for the schema
  tests, typecheck.yml, plus vector-at-mention.yml and vector-codium.yml as
  the commit gate dispatches them) runs after the commit and push; its run ids
  go in the next entry (EV-03's), as EV-01's went here. vector-everywhere.yml
  green is this package's last "done when" item.
- VE-50 live acceptance: on a private test repository, check that the REST
  issue body is byte-equal to the `issues` event payload's body.
- R-A6 (owner-gated, Q13): the route job must send the issue body hash for
  `issues` events.

## EV-02 push receipts (recorded 2026-11-15)

At `c46a6598`, all workflow_dispatch on `everywhere-finish`, re-read with the
GitHub tools on 2026-11-15 (during EV-03). They complete EV-02's "Deferred"
item; EV-02's deviations entry says their run ids go in the next progress entry.

- vector-everywhere 43668358969: success.
- typecheck 43668370110: success.
- vector-at-mention 43668364250: failure, 1 of 10 jobs: 132672693929,
  "sandbox (codium, success, bun)", at "Run the unprivileged probe". That is
  the job and step EV-01 recorded (job 132645692417), inherited from the base;
  it is @vector's sandbox probe, not a lane file, and was not re-run.
- vector-hosted-ci 43668361214: cancelled after 14 s (02:33:39 to 02:33:53).
  vector-codium 43668367381 started at 02:33:43 and calls
  vector-hosted-ci.yml as a reusable workflow (its run lists that file at
  `c46a6598`), and both share the group
  `vector-hosted-ci-workflow_dispatch-refs/heads/everywhere-finish` with
  `cancel-in-progress: true` (vector-hosted-ci.yml:45-47), so the later
  call cancelled the standalone run. Inside vector-codium the "Hosted
  services / Hosted tests" and "Hosted services / typecheck" jobs were
  skipped, so EV-02's schema tests still have no hosted run.
- vector-codium 43668367381: failure, 2 of 21 jobs. Shard 3/4 (job
  132672703195) lists the failed files packages/web/test/cloud-agents-ledger.test.ts
  and packages/web/test/model-plan-gateway-hooks.test.ts, neither a lane file
  nor one EV-02 changed. Shard 1/4 (job 132672703266) also failed at "Run the
  Codium test files"; its failed files were not read here. EV-03 did not
  diagnose either. **Lane-rule deviation:** the run was a workflow_dispatch
  from the same account, within the same nine seconds as the other four EV-02
  runs (02:33:37 to 02:33:46), so it was EV-02's own commit-gate dispatch (EV-02's "Deferred" names it). The lane
  notes say not to dispatch vector-codium.yml before PR #33 is on main and
  merged into this branch (about 570 changed files until then); it is
  recorded for the lead and EV-03 dispatches none.

Still open for EV-02:

- EV-02's hosted run (vector-hosted-ci.yml, for packages/schema
  test/everywhere.test.ts), dispatched only once no vector-codium run is in
  progress on the branch, since they share a concurrency group.

## EV-03: runner abort matrix at the push boundary (2026-11-15)

Base: HEAD `c46a6598` (EV-02, pushed), equal to `origin/everywhere-finish`.
`git fetch origin release-finish main everywhere-finish` found
`release-finish` still at `cf2373c4`, already merged (`5733ceea`), so no merge
was needed. EV-03 depends on no review-fixes commit and no brain-transport
work. The changes were checked in the working tree first, then committed as
one package commit; its SHA and the dispatch run ids go in the next entry,
after the push.

Files changed:

- packages/desktop/src/main/everywhere-runner.ts: one fix. The `held` and
  `no-changes` settle goes through `deliver` with the same payload (:319
  comment, :320), so a lost acknowledgement replays that exact result
  instead of a substituted one without the branch (deviations log, EV-03).
  No other line moved.
- packages/desktop/src/main/everywhere-runner.test.ts: one import (`branchFor`
  from `@vectordevai/core/everywhere/publish`, :3, so every existing case is
  one line lower) and an appended block (:515-817): the `jobsServer` helper
  (:516) and 16 cases: :538 (the regression for the fix), :566 (`stop`,
  `lost` on `pushing`, 2), :611 (actual HTTP 404, 409 on `pushing`, 2), :654
  (a heartbeat `stop` after `pushing`, before push admission), :690 (a switch
  `stop` during an admitted confirmed or ambiguous push, 2), :747 (a `stop`,
  `lost`, 404 or 409 heartbeat during an admitted confirmed or ambiguous push,
  with the publication settle refused, 8).
- Docs: vector-everywhere-deviations.md (the EV-03 entry),
  vector-everywhere-handoff.md (the runner abort matrix gate, and two items
  under "Left open by the repairs"; the owner's rules unchanged), this file
  (the "C test gap" row and this entry). The spec is not edited (E8 already
  names "everywhere-runner.test.ts (each abort case)"), nor
  v2-notes/v2-complete-plan.md or everywhere-runner-delivery.md.

No route, page, flag, generated file, dependency or install. The feature stays
dormant: VECTOR_EVERYWHERE_ENABLED is off, the desktop's OFFER_KEYS is empty,
and with no safe worktree every production job settles `held` before any
engine work. No test calls a real host: loopback fetchers and the fetch guard
only.

Checks (each through `vector-serial`, one file per run, from packages/desktop):

| Check | Result |
| --- | --- |
| src/main/everywhere-runner.test.ts, `--no-env-file`, at HEAD before any change | 33 pass, 0 fail, 212 assertions, 0.09 s |
| the same file with EV-03's changes | 49 pass, 0 fail, 355 assertions, 0.13 s; again after the `satisfies Settle` edit below: 49 pass, 0 fail, 355 assertions, 0.12 s |
| packages/desktop `bun typecheck` (`tsgo -b`) | exit 0; desktop's tsconfig excludes `src/**/*.test.ts`, so it checks the runner, not the test |
| The test file alone, with a scratch tsconfig (/tmp/vector-v2/everywhere/ev03/tsconfig.now.json: extends desktop's, `types` node and bun, includes only this file), desktop's `tsgo -p` | HEAD's test file: exit 0, no errors. EV-03's file first gave two TS2769 errors at the regression case (its expected `held` literal widened `outcome` to `string`); with `satisfies Settle`: exit 0, no errors |
| Prettier drift (lines prettier 3.6.2, `semi: false`, `printWidth: 120`, would change), HEAD then now | everywhere-runner.ts 316 then 316; everywhere-runner.test.ts 391 then 391. The new block was already prettier-clean; its only lines over 120 columns are five test titles in template literals |
| Diff guards | no personal path or email address; everywhere-runner.ts changes two lines |
| Full `bun turbo typecheck --concurrency=2` | not run: EV-03 does not commit or push in this step; it runs at the commit gate |

Mutations, run only in a scratch harness: /tmp/vector-v2/everywhere/ev03/
holds copies of the runner and its four imports under mut/, and mut.test.ts
is the worktree test file with its imports pointed there. run-muts.sh copies
the fixed runner, HEAD's runner (M0) or a mutated copy (mutate.py) into mut/,
runs the one file, and restores the fixed copy. The worktree runner and test
were never edited for a mutation; their SHA-256 sums matched before and after
both passes. Both passes gave the same red sets:

| Mutation | Result | Red cases |
| --- | --- | --- |
| none (the fixed runner in the harness) | 49 pass, 0 fail | none |
| M0: HEAD's runner, the old single settle at :319-320 | 46 pass, 3 fail | :538 (the regression), the two :611 cases (their settles differ) |
| M1: :195 ignores a non-continue answer to `pushing` | 45 pass, 4 fail | the two :566 cases, the two :611 cases |
| M2: :293 without `controller.signal.aborted \|\|` | 48 pass, 1 fail | :654 only |
| M3: throw when aborted straight after a confirmed push | 43 pass, 6 fail | the existing deadline-during-push case (:129), the confirmed :690 case, the four confirmed :747 cases |
| M4: the catch (:327) skips the publication when the outcome is `cancelled` | 44 pass, 5 fail | the ambiguous :690 case, the four ambiguous :747 cases |
| M5: `deliver` tries 5 times instead of 3 | 38 pass, 11 fail | the existing durable-delivery case (:108), the two :611 cases, all eight :747 cases |

Review round one (deviations log, EV-03, "Review round one"). The test file
only changed: in the cases at :690 and :747 the fake `push` now records
`abortedDuringPush`, asserted after `offer()` resolves, in place of an
`expect` inside the fake (+3 lines per case, so the :744 case moved to :747
and the block now ends at :817). The runner is unchanged (SHA-256
`563d1c5c…77c5e` before and after).

| Check | Result |
| --- | --- |
| src/main/everywhere-runner.test.ts, `--no-env-file` | 49 pass, 0 fail, 355 assertions, 0.13 s |
| packages/desktop `bun typecheck` (`tsgo -b`) | exit 0 |
| The test file alone, scratch tsconfig.now.json, `tsgo -p` | exit 0, no errors |
| Prettier drift, before then after the round | 80 then 80 lines; no change inside the new block (:515 onward) |
| Mutations, third pass (run-muts2.sh, mut.test.ts rebuilt from this file, the pre-review copy kept as mut.v1.test.ts) | FIXED and M0-M5 give the same counts and red sets as the table above |
| M6: :195 does not abort on a non-continue `heartbeat` answer | pre-review cases: 39 pass, 10 fail (the four existing heartbeat cases at :325-417 time out; :654; the five confirmed :690/:747 variants); round-one cases: 34 pass, 15 fail, the same ten plus the five ambiguous :690/:747 variants, which only the recorded flag turns red |

Deferred:

- EV-03's commit, the full turbo typecheck and the push, then its dispatches
  (vector-everywhere.yml and typecheck.yml on `everywhere-finish`); their run
  ids go in the next entry. vector-everywhere.yml green is this package's
  last "done when" item.
- For the lead (deviations log, EV-03): the brief's "no settle after
  404/409" against the runner's bounded settle; whether a stop heard during
  an admitted push should suppress the draft PR; the publication result
  after a stop, cancel, lost job or sponsor 404 (server reply, permanent
  pending receipts, the 32-receipt starvation); the no-safe-worktree and
  needs-approval single settles.
