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
| C7, the GitHub status lock is never released | Delivered by EV-02 (`c46a6598`); CI green: vector-everywhere 43668358969, typecheck 43668370110, vector-hosted-ci 43675737368 (at `9426c945`, which contains EV-02) | At 0ee486e3: api/_lib/everywhere/github/status.ts:23 (`"1"`, `onlyNew`, 30 s, never released); the pattern to copy is slack/adapter.ts:88-97 (a token plus `swapValue`). Lines at EV-02's change: status.ts:20-26 (a `randomUUID` token, 120 s), :31 (the job is read under the lock), :36-37 (the `jobStatusEdited` throttle, progress only), :50 (set after the platform write, before the reference write), :53 (`swapValue` release in `finally`); keys.ts:168 (`jobStatusEdited`); tests packages/web/test/everywhere-github.test.ts:186-441 (the gate and fixture helpers at :186-227, then nine cases from :229, the token case at :282) | none |
| C8, `bodySha256` is optional | Delivered by EV-02 (`c46a6598`); CI green: vector-everywhere 43668358969, typecheck 43668370110, vector-hosted-ci 43675737368 (at `9426c945`; it runs packages/schema test/everywhere.test.ts) | At 0ee486e3: packages/schema/src/everywhere.ts:674-675 (optional), :679 (`decodeGithubReference`); api/_lib/everywhere/github/adapter.ts:79-80 (passed through); packages/desktop/src/main/everywhere-github.ts:39-41 (an unedited `updated_at` is accepted instead of the hash). Lines at EV-02's change: everywhere.ts:680 (required for `issues`), the JSDoc at :420-423; adapter.ts unchanged (:82 answers 400 before any write); everywhere-github.ts:39-43 (issues by the hash alone); tests packages/schema/test/everywhere.test.ts:568, packages/desktop/src/main/everywhere-github.test.ts:103 (issues by the hash) and :82 (spec 4.1's comment rule pinned) | none |
| C test gap, the runner abort matrix | Covered by EV-03 (`9426c945`); CI green: vector-everywhere 43675734861, typecheck 43675742876 | Existing cases, one line lower after EV-03's import: packages/desktop/src/main/everywhere-runner.test.ts:297, :306, :325-359, :361-417, :420, :462, :489, :506. EV-03's cases: :538 (a lost acknowledgement of a `held` result, the regression for the fix at everywhere-runner.ts:320), :566 (`stop`/`lost` on `pushing`), :611 (actual HTTP 404/409 on `pushing`), :654 (a heartbeat `stop` before push admission), :690 (a switch `stop` during an admitted push), :747 (`stop`/`lost`/404/409 heartbeats during an admitted push, publication settle refused). Two points wait for the lead (deviations log, EV-03) | the two lead points only |
| F1, the lane does not know v2 | Partly fixed | paths added at .github/workflows/vector-everywhere.yml:53 (`codium-keys.ts`) and :55 (`integrations/linear/**`); the push trigger still names `vector-everywhere` (:15), and packages/web/test/everywhere-lane.test.ts:156 pins it | review-fixes FIT-4 (not yet on `release-finish`) |
| F2, the local-run.test.ts comment | Fixed by the merge | packages/engine/test/local-mode/local-run.test.ts:1358-1359 carry process-finish `d2156cb2d`'s two-line comment | none |
| F3, docs do not match the code | Corrected by EV-01 | Corrected: handoff :7, :39, :44, :77, :107; spec :3, :16; api/_lib/everywhere/account-api.ts:51 (now the comment at :51-57). Annotated, the owner's text kept: handoff :100 and :130-131 (a dated note at the end of "Rules"), spec :686. Left: spec :803 (Q1, owner-confirmed) | spec :879 is review-fixes FIT-5 (not yet on `release-finish`) |
| F4, erase registration and the sweep cron | Done: registration, and the cron by EV-04 (`dbf9bca1`); CI green: vector-everywhere 43678721793, vector-hosted-ci 43678724007, typecheck 43678728633. The cron runs after the owner's deploy | api/_lib/codium-erase.ts:21 (import), :278 (in `ERASE_PARTS`, :244), :294 (`codium` requires `"everywhere"`). EV-04: vercel.json:559-562 (`/api/everywhere/sweep`, `* * * * *`); api/_lib/everywhere/sweep.ts:29 (200 `{enabled: false}` after the 405 and 401 checks, before any switch, store or platform call); tests packages/web/test/everywhere-sweep.test.ts (the `counting` helper at :101, five cases at :125, :176, :204, :231, :251) | Request to review-fixes (FIT-4): add `vercel.json` to vector-everywhere.yml's `pull_request` paths (deviations log, EV-04, known gap) |
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

## EV-03 push receipts (recorded 2026-11-15)

At `9426c945` (EV-03, pushed), all workflow_dispatch on `everywhere-finish`,
read with the GitHub tools on 2026-11-15 (during EV-04). Observed conclusions
only; nothing was re-run.

- vector-everywhere 43675734861: success. This was EV-03's last "done when"
  item.
- typecheck 43675742876: success.
- vector-hosted-ci 43675737368: success. No vector-codium run was dispatched
  at `9426c945`, so it was not cancelled. `9426c945` contains EV-02, so this
  run also closes EV-02's open hosted item (packages/schema
  test/everywhere.test.ts).
- vector-at-mention 43675740147: failure, 1 of 10 jobs: 132695367914,
  "sandbox (codium, success, bun)", at "Run the unprivileged probe" (then
  "Observe the synthetic probe report" and "Assert isolation, crash protection
  and cleanup"). The same job and step as EV-01's 132645692417 and EV-02's
  132672693929, inherited from the base; @vector's sandbox probe, not a lane
  file. The other nine jobs succeeded.

## EV-04: sweep cron, store-free while off (2026-11-15)

Base: HEAD `9426c945` (EV-03, pushed), equal to `origin/everywhere-finish`.
`git fetch origin release-finish main everywhere-finish` found
`release-finish` still at `cf2373c4`, already merged (`5733ceea`), so no merge
was needed. EV-04 depends on no review-fixes commit and no brain-transport
work. `git diff --stat origin/release-finish...origin/review-fixes` and
`...origin/codium-finish`, each limited to the three EV-04 files, were empty.
The commit gate (2026-11-15) committed these changes as one commit; the
push and the dispatches follow (Deferred).

Files changed:

- vercel.json: one added object at :559-562, `/api/everywhere/sweep` every
  minute, right after `/api/hosted/reaper`. `git diff -U0 vercel.json` is four
  added lines and no removals; crons go from 15 to 16.
- api/_lib/everywhere/sweep.ts: a JSDoc on `createSweep` naming the order
  (:10-13), and the off answer (:27-29): 200 `{enabled: false}` after the 405
  and 401 checks, before any switch read, store construction or platform.
  No export, type, import, env var or route changed.
- packages/web/test/everywhere-sweep.test.ts: three imports (`SWITCH_NAMES`
  from codium-switches; `ENV_NAMES`, `readConfig` and the `EverywhereConfig`
  type from config; `everywhereEnv`), the `counting` helper (:101) and five
  cases: :125 (off: four real off
  readings with throwing deps, then the real FakeStore and adapter with the
  production switch reader, then every production default, then the next
  enabled sweep ends the job `lost` and posts), :176 (wrong, missing or
  non-Bearer authorization and POST, on and off, and CRON_SECRET unset),
  :204 (on: the switch read once; `stop` cancels a claimed job that is not
  due and posts its reply), :231 (on, the production switch reader reads `on`
  with no I/O until R-C6; its first assertion, :233, is that Codium's
  SWITCH_NAMES lacks `everywhere`), :251 (vercel.json has exactly one sweep
  cron, every minute, matched by pathname). The six existing cases are
  unchanged.
- api/_lib/everywhere/switch.ts: one comment clause in the header (:13-14,
  review round one): while the flag is off the sweep answers
  `{enabled: false}` before reading the switch. Comment only; outside the
  brief's file list (deviations log, EV-04, Decisions).
- Docs: vector-everywhere-deviations.md (the EV-04 entry, with the turn-off
  and turn-on orders), vector-everywhere-spec.md (dated notes at 3.4 and
  R-C11), vector-everywhere-handoff.md (a "Current gates" bullet; the owner's
  rules unchanged), this file (the F4 row, the EV-03 receipts and this entry).
  v2-notes/v2-complete-plan.md is not edited.

No page, route, flag, generated file, dependency or install. The cron runs
only once the owner deploys a commit that contains it; while
VECTOR_EVERYWHERE_ENABLED is off (the default) it makes no store, switch,
platform or network call and still requires the exact CRON_SECRET bearer.
No test calls a real host: the fetch guard and loopback harness only.

Checks (each through `vector-serial`, one file per run):

| Check | Result |
| --- | --- |
| packages/web test/everywhere-sweep.test.ts at HEAD, before any change | 6 pass, 0 fail, 34 assertions (the plan's baseline) |
| packages/web test/everywhere-sweep.test.ts with EV-04 | 11 pass, 0 fail, 96 assertions, 0.33 s; the same after the prettier pass on the new block. After review round one (the SWITCH_NAMES precondition): 11 pass, 0 fail, 97 assertions, 0.33 s |
| packages/web test/codium-configuration.test.ts (not edited) | 11 pass, 0 fail, 59 assertions (58 at HEAD; its :85-88 loop checks one more cron file, api/everywhere/sweep.ts); the same after review round one |
| API typecheck (packages/engine, `bun typecheck --project ../../tsconfig.json`) | exit 0; again exit 0 after review round one |
| packages/web `bun typecheck` (astro check, includes test/) | 0 errors, 0 warnings, 410 hints, 288 files; the same after review round one |
| Prettier drift (lines prettier 3.6.2 would change), HEAD then now | sweep.ts 16 then 16; everywhere-sweep.test.ts 42 then 42 (the new block is prettier-clean); after review round one the same, and switch.ts 0 then 0 |
| Diff guards | no personal path or email address; no new line over 120 columns |
| Root tests reading vercel.json (codium-outbox :745, codium-replay :896-898, hosted-jobs :1042, hosted-copy :199, legacy-desktop-access :71, ops-screens :401) | not run locally: each uses `toContainEqual`, a filter or `redirects`/`rewrites`, so one added cron cannot change them; vector-hosted-ci.yml runs them |
| Full `bun turbo typecheck --concurrency=2` (commit gate) | exit 0, 27 of 27 tasks (25 cached); at the gate everywhere-sweep.test.ts again 11 pass, 0 fail, 97 assertions, codium-configuration.test.ts 11 pass, 0 fail, 59 assertions, the API and packages/web typechecks exit 0 |

Mutations: each is a patch under /tmp/vector-v2/everywhere/ev04-mut/
(make.py builds them), applied with `git apply`, the one test file run, then
`git apply -R`; the three files' SHA-256 sums matched post.sha after every
run. Both passes (before and after the prettier pass) gave the same red sets.
Review round one re-ran the same patches plus M9 against the updated test
file (/tmp/vector-v2/everywhere/ev04-mut-r1/run.sh), with four files' sums
(also codium-switches.ts) matching pre.sha after every run; the red sets
were the same. Line numbers below are the current ones:

| Mutation | Result | Red cases |
| --- | --- | --- |
| M1: no early return | 10 pass, 1 fail | :125. With only production defaults the off call answers 503 `PERSISTENT_STORE_UNAVAILABLE` (scratch defaults.test.ts; 200 `{enabled: false}` without M1) |
| M2: early return before the bearer check | 10 pass, 1 fail | :176 (the off config and CRON_SECRET-unset off cases answer 200) |
| M3: early return after the switch read | 10 pass, 1 fail | :125 ("switch" recorded) |
| M4: off body `{ended: 0, posted: 0}` | 10 pass, 1 fail | :125 |
| M5: `const stop = false` (switch ignored) | 10 pass, 1 fail | :204 (the `stop` variant) |
| M6: schedule `*/5 * * * *` | 10 pass, 1 fail | :251 |
| M8: the cron entry removed | 10 pass, 1 fail; codium-configuration.test.ts 11 pass, 0 fail | :251; codium-configuration does not pin this cron (deviations log, EV-04, known gap) |
| M9 (review round one): Codium's SWITCH_NAMES gains `everywhere` (codium-switches.ts:7, scratch only) | 10 pass, 1 fail | :231, at its precondition (:233, "Expected: false, Received: true"), not at the job state |

M7 (a second entry with a query string) was dropped as the critique
suggested: :251 filters by pathname, so it catches that by construction.

Plan critique, points taken (moved here from the deviations log in review
round one, since they are bookkeeping, not decisions): the real-store off
variant (:125 mounts `context: f.context` with the FakeStore and the
production switch reader, so the unchanged `FakeStore.commands` count and
job record are evidence, not only the throwing stubs); an enabled mount with
the production switch reader (:231); the four activation points (late or
missing `lost` replies, the turn-on order, the data key, G1 before EV-07);
the Codium-area note and the repeated diff checks; the workflow-paths gap;
CRON_SECRET in the deferred note; the dated spec notes at 3.4 (:273) and
R-C11 (:850); the EV-03 run ids under their own heading, observed
conclusions only.

Review round one (non-blocking findings, all taken): the critique and
commit-step bookkeeping moved out of the deviations entry (here and under
Deferred); the SWITCH_NAMES precondition at :233 (M9); the spec citations
re-found by their text (§6.4's Codium row is :650 and the G2 Slack row :703,
after EV-04's note at :273), and switch.ts:58 is now :59 after the header
clause; that header clause; the EV-03 receipts named for the commit body and
the commit-step receipts listed under Deferred.

Deferred:

- EV-04's commit: one commit, explicit paths, the trailers as two lines of
  one `-m` (RULES-v2's form, checked with `git log -1 --format=%B | tail
  -3`). Its body says that it also records EV-03's dispatched run
  conclusions (the "EV-03 push receipts" section above), and that the cron
  runs only once the owner deploys.
- Right before the commit, re-find the spec citations by their text (:273,
  :650, :703, :850). Right before the push, repeat the codium-finish and
  review-fixes diff checks for vercel.json, then the full turbo typecheck
  and the push.
- Then the dispatches on `everywhere-finish`: vector-everywhere.yml and
  typecheck.yml; vector-hosted-ci.yml too (it runs the root vercel.json
  tests), only while no vector-codium run is in progress, since they share a
  concurrency group (vector-hosted-ci.yml:45-47). Never vector-codium.yml.
  EV-04 is done only once vector-everywhere.yml is green. Then record the
  commit SHA, the turbo typecheck result and the vector-everywhere.yml and
  typecheck.yml run ids in the F4 row and the next entry, and mark the F4
  row done.
- Request to review-fixes (FIT-4): `vercel.json` in vector-everywhere.yml's
  `pull_request` paths.
- Owner: CRON_SECRET in production, and the deploy that starts the cron.

## EV-04 push receipts (recorded 2026-11-15)

At `dbf9bca1` (EV-04, pushed), all workflow_dispatch on `everywhere-finish`,
read with the GitHub tools on 2026-11-15 (during EV-05). Observed conclusions
only; nothing was re-run.

- vector-everywhere 43678721793: success. This was EV-04's last "done when"
  item.
- vector-hosted-ci 43678724007: success (it runs the root vercel.json tests).
- typecheck 43678728633: success.
- vector-at-mention 43678726338: failure, 1 of 10 jobs: 132704485451,
  "sandbox (codium, success, bun)", at "Run the unprivileged probe" (then
  "Observe the synthetic probe report" and "Assert isolation, crash
  protection and cleanup"). The same inherited @vector probe step as EV-01,
  EV-02 and EV-03; not a lane file, and not re-run. The other nine jobs
  succeeded.

With these, the Tier B table above marks F4 done and drops "CI pending" from
the C7, C8 and C test gap rows (C7 and C8 by vector-everywhere 43668358969 and
vector-hosted-ci 43675737368; the C test gap by vector-everywhere
43675734861).

## EV-05: relay presence honours the kill flag and suspension (2026-11-15)

Base: HEAD `dbf9bca1` (EV-04, pushed), equal to `origin/everywhere-finish`.
`git fetch origin release-finish main everywhere-finish` found
`release-finish` still at `cf2373c4`, already merged (`5733ceea`), so no merge
was needed. `git diff --stat origin/release-finish...origin/codium-finish`
(`2924d94b`), `...origin/review-fixes` (`1433d105`) and `...origin/main`, each
limited to packages/relay and api/_lib/remote-relay.ts, were empty: no other
lane touches the relay. EV-05 depends on no review-fixes commit and no
brain-transport work. The changes are in the working tree, not committed.

Files changed:

- packages/relay/src/account-relay.ts: the internal `presence` case awaits
  (:668-669); presence() is a private async method with its JSDoc
  (:729-746) that answers offline with `reason: "killed"` while the kill flag
  is set or unreadable and `reason: "suspended"` while the account is
  suspended. No export, type, constant, route or other method changed.
- packages/relay/test/internal.test.ts: `CLOSE` (:6) and `Harness` (:16)
  imported as values; one describe, "presence honours the kill flag and the
  suspension (R-C4)" (:245), with a `presence(h)` helper (:247) that sends the
  API's signed call through the real Worker (`handleRequest`) to the
  object, used by all four cases, each on a fresh `Harness`:
  - :262 the kill flag: offline with `reason: "killed"` while an idle
    computer's socket is still open and no alarm is armed; online again once
    the flag is deleted;
  - :283 an unreadable flag (`FakeKV.failing`) counts as set, with the live
    phone counted in `viewers`, exactly one KV read for the whole call, and
    the computer's socket not closed;
  - :298 a suspension: the suspend call closes the computer with
    `REMOTE_PAUSED`, presence answers offline with `reason: "suspended"`,
    an unreadable flag on top of the suspension is offline too (which
    `reason` wins is not pinned), and after lifting it and reconnecting the
    same device presence is online;
  - :325 no flag and no suspension: the exact earlier shape with no `reason`
    key and one KV read, then offline with no `reason` after the computer
    disconnects.
- Docs: vector-everywhere-deviations.md (the EV-05 entry),
  vector-everywhere-spec.md (dated notes at §2 :100, E10 :565 and R-C4 :845),
  vector-everywhere-handoff.md (a "Current gates" bullet; the abort-matrix
  and sweep-cron bullets marked CI green with their run ids; the owner's
  rules unchanged), this file (the Tier B rows, the EV-04 receipts and this
  entry). v2-notes/v2-complete-plan.md and Codium's relay notes are not
  edited.

No new env var, flag, route, dependency, generated file, install or API
shape. Nothing becomes reachable on vectordev.ai. No test calls a real host:
only packages/relay/test/fakes.ts and the in-memory Worker.

Checks (each through `vector-serial`, one file per run):

| Check | Result |
| --- | --- |
| packages/relay test/internal.test.ts at HEAD (planning baseline) | 11 pass, 0 fail, 47 assertions |
| packages/relay test/internal.test.ts with EV-05 | 15 pass, 0 fail, 64 assertions (65 after review round one) |
| packages/relay test/relay.test.ts (its exact presence `toEqual` and the hibernation case) | 14 pass, 0 fail, 73 assertions (the same as the baseline) |
| packages/relay test/idle.test.ts | 12 pass, 0 fail, 50 assertions |
| packages/relay test/routing.test.ts | 9 pass, 0 fail, 51 assertions |
| packages/relay test/limits.test.ts | 13 pass, 0 fail, 43 assertions |
| packages/relay test/fair-use.test.ts | 8 pass, 0 fail, 36 assertions |
| packages/relay test/ticket.test.ts | 9 pass, 0 fail, 63 assertions |
| packages/relay test/source.test.ts (no Bun or Node module and no logging in src/) | 7 pass, 0 fail, 87 assertions |
| root test/remote-ticket-api.test.ts (the real relay in memory; its isComputerOnline case) | 29 pass, 0 fail, 261 assertions (the same as the baseline) |
| root test/remote-relay-contract.test.ts | 7 pass, 0 fail, 20 assertions |
| packages/relay `bun typecheck` (tsgo; src, test and e2e) | exit 0 |
| prettier --check on account-relay.ts and internal.test.ts | clean |
| Diff guards | no personal path or email address; no added line over 120 columns; only the six files above changed |
| wrangler dry run and `bun run smoke` | not run locally (the smoke starts `wrangler dev --local`, a dev-server class of process); vector-hosted-ci.yml's relay job runs both |

Mutations: each is a patch under /tmp/vector-v2/everywhere/ev05-mut/, applied
with `git apply`, internal.test.ts run alone, then `git apply -R`; the SHA-256
of account-relay.ts matched pre.sha after every run.

| Mutation | Result | Red cases |
| --- | --- | --- |
| M1: no kill-flag line | 12 pass, 3 fail | :262, :283, and :325 (no KV read: "Expected: 1, Received: 0") |
| M2: no suspension line | 14 pass, 1 fail | :298 (`reason` missing) |
| M3: `killed()`'s catch returns false | 14 pass, 1 fail | :283 |
| M4: presence closes live sockets with `RELAY_OFF` when killed | 13 pass, 2 fail | :262 (readyState), :283 (closed). Pins current behaviour, not a contract (deviations log, EV-05) |
| M5: the normal answer gains `reason: "online"` | 12 pass, 3 fail | :262, :298, :325 |
| M6: `viewers: 0` in the offline answers | 14 pass, 1 fail | :283 |

The check order (flag before suspension) is deliberately not pinned.

Review round one (2026-11-15, six non-blocking findings, all taken; the
deviations log's EV-05 "Decisions" lists them):

- account-relay.ts:738-739: presence() computes one `reason` (the flag read
  first and on every call, then the suspension) and has a single offline
  return. Same answers, same line count, so the line numbers above stand.
- internal.test.ts: the suspension case (:298) gains an unreadable flag on
  top of the stored suspension, asserted offline without pinning `reason`;
  the last case moves from :321 to :325.
- Deviations log: the standing() citation (:230); the EV-06 delivery check
  under "Not changed"; the await note and the single `reason` under
  "Decisions".
- Re-run after the fixes, each through `vector-serial`, one file per run:
  packages/relay test/internal.test.ts 15 pass, 0 fail, 65 assertions;
  test/relay.test.ts 14 pass, 0 fail, 73 assertions; root
  test/remote-ticket-api.test.ts 29 pass, 0 fail, 261 assertions;
  packages/relay `bun typecheck` exit 0; prettier --check on both files
  clean.
- Mutations rebuilt against the new presence() under
  /tmp/vector-v2/everywhere/ev05-mut-r1/ (M1 drops the `killed()` term, M2
  the suspension term, M4 drops sockets when `reason` is `killed`, M6
  answers `viewers: 0`; M3 and M5 as before), the same apply, run, revert
  and SHA-256 check: results identical to the table above (M1 12/3, M2 14/1,
  M3 14/1, M4 13/2, M5 12/3, M6 14/1, the same red cases).

Deferred:

- EV-05's commit (one commit, the six explicit paths, the trailers checked
  with `git log -1 --format=%B | tail -3`); its body says that it also
  records EV-04's receipts and closes the F4, C7, C8 and C test gap rows, so
  a reviewer sees why docs outside the relay change. Right before the push,
  repeat the codium-finish and review-fixes diff checks for packages/relay,
  then the full turbo typecheck and the push.
- Then the dispatches on `everywhere-finish`: vector-hosted-ci.yml (only
  while no vector-codium run is in progress; they share a concurrency group)
  and typecheck.yml. Never vector-codium.yml. EV-05 is done once
  vector-hosted-ci is green (relay tests, relay typecheck, wrangler dry run
  and local smoke); record the run ids in the next entry.
- Owner: deploy the relay Worker. VE-50: confirm presence answers offline
  while the `remote` switch is off.
- VE-20 must use `presence` only: the relay `devices` list
  (`devices[].online`) and the phone's peers list still follow open sockets
  while the flag is set.
- EV-06: the job-offer path (the Worker or the object) must call `killed()`
  and check the `suspended` meta before it delivers an offer, and must not
  rely on presence alone. Presence closes nothing, so an idle computer that
  connected before the kill still has an open socket, and the Worker's
  internal() route never reads the kill flag (only connect() does,
  index.ts:61).
- Request to Codium (or the lead): annotate
  docs/vector/build/codium-a39-remote-relay-notes.md:11 and §4.17's presence
  entry point with R-C4's behaviour and the optional `reason`.

## EV-05 push receipts (recorded 2026-11-15)

At `8caf62cb` (EV-05, pushed), all workflow_dispatch on `everywhere-finish`,
read with the GitHub tools on 2026-11-15 (during EV-06). Observed conclusions
only; nothing was re-run.

- vector-everywhere 43680774247: success.
- vector-hosted-ci 43680776690: success. This was EV-05's last "done when"
  item (relay tests, relay typecheck, wrangler dry run and local smoke).
- typecheck 43680782059: success.
- vector-at-mention 43680779587: failure, 1 of 10 jobs: 132710709977,
  "sandbox (codium, success, bun)", at "Run the unprivileged probe" (then
  "Observe the synthetic probe report" and "Assert isolation, crash
  protection and cleanup"). The same inherited @vector probe step as EV-01 to
  EV-04; not a lane file, and not re-run. The other nine jobs succeeded.

With these, the handoff's "Relay presence" gate is marked CI green.

## EV-06: relay forwards signed job offers (2026-11-15)

Base: HEAD `8caf62cb` (EV-05, pushed), equal to `origin/everywhere-finish`.
`git fetch origin release-finish main everywhere-finish` found
`release-finish` still at `cf2373c4`, already merged, so no merge was needed;
`main` is `58f85edc` and is not merged (PR #33 is not in). `git diff --stat
origin/release-finish...origin/<b>` limited to packages/relay,
api/_lib/remote-relay.ts, docs/vector/MODEL-PLANS.md and
codium-a39-remote-relay-notes.md was empty for codium-finish `2924d94b`,
review-fixes `1433d105` and main: no other lane touches the relay. EV-06
depends on no review-fixes commit and no brain-transport work. The changes are
in the working tree, not committed.

Files changed (line numbers after EV-06):

- packages/relay/src/index.ts: header (:5-6, :9-10); :78 checks
  `INTERNAL_ACTIONS` only; the 501 `RELAY_JOB_OFFER_RESERVED` branch removed.
- packages/relay/src/account-relay.ts: imports `utf8` (:9), `DEVICE_BYTES`
  and `encodeFrame` (:15, :20); `INTERNAL_ACTIONS` gains `"job-offer"`
  (:47-56); `OFFER` (:85); the comment at :376 reworded (behaviour at :377 and
  :411 unchanged); `case "job-offer"` (:689-690); `jobOffer()` with its JSDoc
  (:763-791), including the no-account guard (:779-780, review round one).
- packages/relay/src/limits.ts:60-62: `offersPerHour: 30`,
  `offerWindowMs: 60 * 60_000`.
- packages/relay/src/protocol.ts: the kind line (:13) and the "Job offers
  (R-C1)" paragraph (:21-33); comments only, still no import.
- packages/relay/e2e/relay-smoke.ts (CI only): header (:1-6); `offerText`
  (:44-47); "a signed job offer reaches the computer, never the phone" (:231);
  "the kill flag stops presence and offers while an idle computer stays
  connected" (:267); the 501 check removed. Not in the brief's list; see the
  deviations log.
- packages/relay/test/internal.test.ts: imports (:5-26); the header (:28-31);
  the `OFFER` fixture (:36); the file-level `viaWorker(h, action, body)`
  helper (:39), which R-C4's `presence(h)` (:343) now wraps; `worker()` gains
  `computer(sub)` (:199, review round one), a computer connected through the
  Worker's `/v1/connect` so that account's object knows its account. In
  "internal routes" the 501 case is replaced by two:
  - :271 unsigned and forged offers answer 401 and reach no object; a signed
    one answers 200 `{delivered: 0}`; its replay answers 401
    `INTERNAL_SIGNATURE_INVALID`;
  - :298 with one computer per account, thirty offers to one account answer
    200 `{delivered: 1}`, the 31st 429 `RELAY_OFFER_LIMIT`, another account's
    200 `{delivered: 1}`; the computers hold 30 and 1 frames; two distinct
    handles.

  A new describe, "job offers reach the account's computers (R-C1)" (:424),
  each case on a fresh `Harness`:
  - :428 two computers and a phone: `{delivered: 2}`; each computer gets one
    frame of 17 + offer bytes with kind `0x02`, sixteen zero device bytes
    and the offer text; the phone gets none; meta `offers` holds only the
    time; no table row and no attachment holds the payload, the signature or
    the account;
  - :456 no phone: twenty offers (`noViewerFrames`) each `{delivered: 1}`;
    the computer stays open; no alarm, no viewer meter, no `viewing_since`;
    a data frame then gets the first `no-viewer` notice and closes nothing;
    after six minutes (the ticket has lapsed) an offer is still delivered and
    books one `idleTailMs` of awake time (fetch's existing `touch`);
  - :483 the kill flag set, then unreadable: `{delivered: 0, reason:
    "killed"}`, no frame, the computer not closed; cleared: `{delivered: 1}`;
  - :501 suspended: the suspend call closes the computer, the offer answers
    `{delivered: 0, reason: "suspended"}`; lifted and reconnected:
    `{delivered: 1}`;
  - :515 three killed and two malformed offers take no place; thirty are
    accepted; after `h.wake()` the 31st is 429; still 429 one millisecond
    before the hour; after another `h.wake()` and that millisecond, accepted;
  - :540 ten malformed values (missing, a number, an array, empty, `vef2.`,
    `vef1.` alone, a space, a non-ASCII character, a newline, a leading space)
    and an offer longer than `internalBodyBytes` (straight to the object)
    answer 400; a body with no account answers 400 at the Worker; no frame,
    no place;
  - :566 (review round one) an object that knows no account: an offer before
    any computer connected answers `{delivered: 0}` and leaves no `offers`
    row; after a computer connects, one is delivered and one time is kept;
    after `erase` (the computer closed `REMOTE_REVOKED`) an offer answers
    `{delivered: 0}`, sends nothing, and meta holds only `revoked_before`,
    meters nothing;
  - :582 a computer's own `0x02` frame, aimed at another computer, at the
    phone, or with sixteen zero device bytes, reaches nobody; three
    `reserved` notices; the sender stays open.
- packages/relay/test/relay.test.ts: the header comment (:7-8) only. The
  client-sent `0x02` case (:73) is unchanged.
- Docs: vector-everywhere-deviations.md (the EV-06 entry),
  vector-everywhere-spec.md (dated notes under §2's "Nothing can send a job"
  :102, E9 :565 and R-C1 :844), vector-everywhere-handoff.md (the EV-05 bullet
  marked CI green; a "Relay job offers" bullet; the owner's rules unchanged),
  this file (the EV-05 receipts and this entry). v2-notes/v2-complete-plan.md
  and Codium's documents are not edited.

No new env var, flag, route path, dependency, install or generated file.
Nothing becomes reachable on vectordev.ai. No test calls a real host: only
packages/relay/test/fakes.ts and the in-memory Worker.

Checks (each through `vector-serial`, one file per run):

| Check | Result |
| --- | --- |
| packages/relay test/internal.test.ts at HEAD (baseline) | 15 pass, 0 fail, 65 assertions |
| packages/relay test/relay.test.ts at HEAD (baseline) | 14 pass, 0 fail, 73 assertions |
| packages/relay test/internal.test.ts with EV-06 | 23 pass, 0 fail, 233 assertions; after review round one 24 pass, 0 fail, 245 assertions |
| packages/relay test/relay.test.ts (the client-sent `0x02` case) | 14 pass, 0 fail, 73 assertions |
| packages/relay test/idle.test.ts | 12 pass, 0 fail, 50 assertions |
| packages/relay test/routing.test.ts | 9 pass, 0 fail, 51 assertions |
| packages/relay test/limits.test.ts | 13 pass, 0 fail, 43 assertions |
| packages/relay test/fair-use.test.ts | 8 pass, 0 fail, 36 assertions |
| packages/relay test/ticket.test.ts | 9 pass, 0 fail, 63 assertions |
| packages/relay test/source.test.ts (no Bun or Node module, no logging, protocol.ts imports nothing) | 7 pass, 0 fail, 87 assertions |
| root test/remote-relay-contract.test.ts | 7 pass, 0 fail, 20 assertions |
| root test/remote-ticket-api.test.ts | 29 pass, 0 fail, 261 assertions |
| packages/relay `bun typecheck` (tsgo; src, test and e2e) | exit 0 |
| prettier --check on the seven code and test files | clean |
| Diff guards | no personal path or email address; no added line over 120 columns; no trailing whitespace; only the eleven files above changed |
| wrangler dry run and `bun run smoke` | not run locally (the smoke starts `wrangler dev --local`); vector-hosted-ci.yml's relay job runs both |

Mutations: each is a patch under /tmp/vector-v2/everywhere/ev06-mut/, applied
with `git apply`, internal.test.ts run alone (and relay.test.ts for M12 and
M14), then `git apply -R`; the SHA-256 of account-relay.ts and index.ts
matched pre.sha after every run. After review round one all seventeen were
re-run from /tmp/vector-v2/everywhere/ev06-mut-r1/ (M1, M2, M8 and M13
regenerated against the guarded `jobOffer()`, M16 new); the table shows those
results, with the new line numbers, and every run ended `ALL-REVERTED` with
pre.sha matched.

| Mutation | internal.test.ts | Red cases |
| --- | --- | --- |
| M1: no kill-flag line | 22 pass, 2 fail | :483, :515 |
| M2: no suspension line | 23 pass, 1 fail | :501 |
| M3: send to `this.live()`, phones too | 22 pass, 2 fail | :428, :483 |
| M4: `>` for `>=` in the cap | 22 pass, 2 fail | :298, :515 |
| M5: the form check without the `vef1.` prefix | 23 pass, 1 fail | :540 |
| M6a: frame kind `FRAME.DATA` | 23 pass, 1 fail | :428 |
| M6b: device bytes all 1 | 23 pass, 1 fail | :428 |
| M7: `orphan()` per delivered socket | 21 pass, 3 fail | :298, :456, :515 |
| M8: the place taken before the kill and suspension checks | 23 pass, 1 fail | :515 |
| M9: the Worker's 501 branch restored | 16 pass, 8 fail | :271 (after its 401 assertions), :298, :428, :456, :483, :501, :540, :566; :515 and :582 go straight to the object and stay green |
| M10: `killed()`'s catch returns false | 22 pass, 2 fail | :366 (EV-05's unreadable flag), :483 |
| M11: the offer text also stored in meta | 23 pass, 1 fail | :428 |
| M12: data() passes a client `0x02` on like data | 23 pass, 1 fail; relay.test.ts 13 pass, 1 fail | :582; relay.test.ts:73 |
| M13: the offer times in a private field, not meta | 21 pass, 3 fail | :428 (no meta row), :515 (the cap lost at `h.wake()`), :566 (no time kept) |
| M14: data() forwards a computer's `0x02` to the other computers | 23 pass, 1 fail; relay.test.ts 13 pass, 1 fail | :582; relay.test.ts:73 |
| M15: no length bound | 23 pass, 1 fail | :540 |
| M16 (review round one): no no-account guard | 23 pass, 1 fail | :566 |

The awake-time assertion in :456 pins fetch's existing `touch` for internal
calls (R-C1's "offers count toward awake time"); no mutation of `jobOffer()`
targets it.

Review round one (six findings, none blocking; working tree, not committed):

- Findings 1 and 3 (an offer to an object that knows no account wrote meta
  `offers`), taken: `jobOffer()` answers `{delivered: 0}` before the cap when
  meta `account` is unset, and writes nothing (account-relay.ts:779-780). New
  case :566; the per-account cap case :298 now connects a computer per account
  through the Worker. Mutation M16 red.
- Findings 2 and 4 (no fair-use check), kept and recorded in the deviations
  log's "No fair-use check" bullet; no change for EV-06.
- Finding 5 (Codium's documents still say 501), kept as the recorded request;
  the deviations log's Coordination bullet now names the annotation form.
- Finding 6 (done-when not met): unchanged. The commit, the full turbo
  typecheck, the push and the green vector-hosted-ci.yml and typecheck.yml
  runs are still outstanding, and the handoff bullet stays "CI pending" until
  they pass.
- Re-run after the fix, one file at a time: internal.test.ts 24 pass, 0 fail,
  245 assertions; relay.test.ts 14/0/73; routing.test.ts 9/0/51;
  limits.test.ts 13/0/43; source.test.ts 7/0/87; fair-use.test.ts 8/0/36;
  idle.test.ts 12/0/50; ticket.test.ts 9/0/63; packages/relay `bun typecheck`
  exit 0; prettier --check on account-relay.ts and internal.test.ts clean;
  the seventeen mutations as in the table above.

Commit gate (2026-11-15): `git fetch` found release-finish `cf2373c4`
(already merged), main `58f85edc` (PR #33 not on it) and everywhere-finish
equal to HEAD `8caf62cb`; the packages/relay, remote-relay.ts,
MODEL-PLANS.md and relay-notes diff against release-finish was again empty
for codium-finish `2924d94b`, review-fixes `1433d105` and main. Only the
eleven EV-06 paths were in the working tree. Re-run through `vector-serial`,
one file at a time: internal.test.ts 24 pass, 0 fail, 245 assertions;
relay.test.ts 14/0/73; packages/relay `bun typecheck` exit 0; prettier
--check on the seven code, test and smoke files clean; the full
`bun turbo typecheck --concurrency=2` 27 of 27 tasks successful. Committed
as `feat(relay): deliver signed job offers to online computers`; the push
and run ids are recorded in the next entry.

Deferred:

- Then the dispatches on `everywhere-finish`: vector-hosted-ci.yml (only
  while no vector-codium run is in progress; they share a concurrency group)
  and typecheck.yml. Never vector-codium.yml. EV-06 is done once
  vector-hosted-ci is green (relay tests, relay typecheck, wrangler dry run
  and the smoke's two new checks on workerd); record the run ids in the next
  entry.
- EV-09: `RelayAction` gains `job-offer`; a root contract test that
  `signOffer`'s output passes the relay's form check. EV-11: the desktop
  decodes the frame exactly as the deviations log's "The offer frame" says.
- Owner: deploy the relay Worker. VE-50: an offer reaches the owner's
  computer only, and nothing while the `remote` switch is off.
- Request to Codium (or the lead): annotate MODEL-PLANS.md:127,
  codium-a39-remote-relay-notes.md :11, :49, :54, :67, codium-deviations.md
  :882-883 and codium-build-spec.md :539, :801, which still say job-offer is
  reserved or answers 501. Optional: refuse offers once awake-hours are used
  up.

## EV-07: Codium `everywhere` runtime switch (2026-11-15)

Base: HEAD `411317d8` (EV-06, pushed), equal to `origin/everywhere-finish`.
`git fetch origin release-finish main everywhere-finish codium-finish
review-fixes` found `release-finish` still at `cf2373c4`, already merged
(`git merge-base --is-ancestor` true), so no merge was needed; `main` is
`58f85edc` and is not merged (PR #33 is not in). `git diff --stat
origin/release-finish...origin/<b>` over the EV-07 paths (the five code
files, the five test files, api/_lib/codium-owner-dashboard.ts and
api/_lib/everywhere/switch.ts) was empty for codium-finish `2924d94b`,
review-fixes `1433d105` and main. A second fetch at the end of the package
found codium-finish at `265f4ea7` (the others unchanged), and the diff was
still empty. EV-07 depends on no review-fixes commit and no brain-transport
work. The changes are in the working tree, not committed.

Files changed (line numbers after EV-07):

- api/_lib/codium-switches.ts: `SWITCH_NAMES` gains `"everywhere"` last
  (:7-17, wrapped by prettier); the `SwitchValue` comment (:19);
  `VALUES.everywhere = ["on", "no-new", "stop"]` with a comment (:30-31);
  `export const SWITCH_VALUES` (:33-34), a read-only alias of the private
  `VALUES`, whose uses in writeSwitch and decode are unchanged.
- packages/schema/src/codium-owner.ts:41: `RuntimeSwitch.name` gains
  `"everywhere"`.
- api/_lib/codium-owner-api.ts: imports `SWITCH_VALUES` (:8-15); `prepare()`
  checks `SWITCH_VALUES[name]` (:102) in place of the hosted-only ternary.
- packages/web/src/components/marketing/owner/CodiumOwner.tsx:
  `SWITCHES.everywhere` (:37-40); On, No new and Stop for `hosted` and
  `everywhere` (:895-898), under a comment (:894) that points at
  SWITCH_VALUES (review round one).
- api/_lib/everywhere/switch.ts, comments only: the header (:11-14), :22,
  :54, and readRemoteSwitch's comment corrected (:63-66).
- packages/web/test/everywhere-switch.test.ts: imports `SWITCH_NAMES` and
  `SWITCH_VALUES` (:3); :46 retitled "with the env on and no Codium value it
  is on"; the old "a switch Codium does not have yet" case is replaced by:
  - :113 SWITCH_NAMES contains `everywhere`; `SWITCH_VALUES.everywhere` is
    `["on", "no-new", "stop"]`;
  - :118 an absent record reads `on`, from exactly one
    `["GET", "vector:codium:test:switch:everywhere"]`;
  - :125 `on`, `no-new` and `stop`, each stored as a JSON record and as the
    legacy bare string, reach readEverywhereSwitch;
  - :134 `off` (bare and as a JSON record with `offSince`), `maybe` and
    `{broken` make the seam reject `CODIUM_SWITCH_UNAVAILABLE`, and
    readEverywhereSwitch reads `stop`;
  - :150 with the env off (no settings; the flag without a data key) it
    reads `stop` whatever Codium holds (absent, on, no-new, stop), with no
    store command;
  - :171 (extended) a store outage also reads `stop` for `everywhere`.
- packages/web/test/everywhere-sweep.test.ts:231: EV-04's tripwire replaced
  by "with the feature on the production reader reads Codium's switch;
  unreadable, it ends live work". It deletes the four KV variables and
  restores them in `finally`, checks they are unset, then mounts createSweep
  without `stopped`: 200 `{ended: 1, posted: 1}`, the job `cancelled`, one
  `finish` call.
- test/codium-switches.test.ts: imports `SWITCH_NAMES` and `SWITCH_VALUES`;
  in "A11 audited runtime switches", :166 "R-C6: everywhere takes on, no-new
  and stop, refuses off, and no other switch changes" (SWITCH_NAMES contains
  `everywhere`; SWITCH_VALUES has a key per name; `everywhere` and `hosted`
  are `["on", "no-new", "stop"]`; every other name is `["on", "off"]`,
  computed over SWITCH_NAMES; a fresh seed reads `{value: "on", generation:
  "default"}`; writes of no-new, stop and on each change and read back; `off`
  is refused `CODIUM_SWITCH_INVALID`; the audit holds on>no-new, no-new>stop,
  stop>on; a stored `off` reads `CODIUM_SWITCH_UNAVAILABLE`); in the Valkey
  describe, :416 twenty parallel `stop` writes give one generation, one
  change and ZCARD 1, a fresh read is `stop`, and `off` is refused with ZCARD
  still 1.
- test/codium-owner.test.ts: imports `readSwitch`, `SWITCH_NAMES`,
  `switchAuditKey` and `switchKey`; :181 the owner sets `everywhere` to
  no-new and then stop (each 200 `{accepted: true}` with no relay or worker
  key, read back fresh), `off` answers 400 `CODIUM_OWNER_REQUEST` and the
  value stays `stop`, `hosted` off and `remote` no-new still answer 400, the
  switch audit holds 2, and the owner audit holds 4 rows both before and
  after the three refused calls (review round one); :251 the dashboard
  decodes with
  `CodiumOwner.Dashboard`, lists exactly SWITCH_NAMES, and shows the stored
  `everywhere` `stop` with its `changedAt`.
- packages/web/src/components/marketing/owner/CodiumOwner.test.ts: imports
  `SWITCH_NAMES` and `SWITCH_VALUES` (:8); a module-level `switchOptions`
  reader (:116); :246 the `everywhere` select offers on, no-new (selected)
  and stop; `remote` offers on and off; the "Everywhere" label and the
  "Applies only while the Everywhere flag is set." detail are rendered;
  :264 (review round one) every name in SWITCH_NAMES offers exactly
  `SWITCH_VALUES[name]`, in order.
- Docs: vector-everywhere-deviations.md (the EV-07 entry; dated notes under
  :69, EV-04's "Until EV-07 lands" and its tripwire decision),
  vector-everywhere-spec.md (dated notes under §3.2 step 3, the ports sketch
  after :606's code block, Stage B and R-C6), vector-everywhere-handoff.md (a
  dated clause on the sweep-cron bullet; a "Codium `everywhere` switch"
  bullet, CI pending; the owner's rules unchanged), this file.
  v2-notes/v2-complete-plan.md and Codium's documents are not edited.

No new env var, flag, route, dependency, install or generated file (the
codium-owner schema has no importer in packages/engine, client, sdk, core,
app or desktop). Nothing new becomes reachable on vectordev.ai: the one new
dashboard row is behind the owner's Google sign-in on the noindex owner page.
No test calls a real host: only FakeStore, the Codium fakes and the fetch
guard.

Checks (each through `vector-serial`, one file per run):

| Check | Result |
| --- | --- |
| packages/web test/everywhere-switch.test.ts at HEAD (baseline) | 12 pass, 0 fail, 52 assertions |
| packages/web test/everywhere-sweep.test.ts at HEAD | 11 pass, 0 fail, 97 assertions |
| packages/web src/components/marketing/owner/CodiumOwner.test.ts at HEAD | 20 pass, 0 fail, 105 assertions |
| root test/codium-switches.test.ts at HEAD (run from test/) | 17 pass, 2 skip (Valkey), 0 fail, 68 assertions |
| root test/codium-owner.test.ts at HEAD | 34 pass, 1 skip, 0 fail, 137 assertions |
| everywhere-switch.test.ts with EV-07 | 16 pass, 0 fail, 89 assertions |
| everywhere-sweep.test.ts with EV-07 | 11 pass, 0 fail, 99 assertions |
| CodiumOwner.test.ts with EV-07 | 21 pass, 0 fail, 109 assertions |
| test/codium-switches.test.ts with EV-07 | 18 pass, 3 skip (Valkey), 0 fail, 83 assertions |
| test/codium-switches.test.ts against a disposable loopback redis-server 7.0.15 (`VECTOR_TEST_REDIS_URL`), informational only: not the Valkey receipt, which is vector-hosted-ci's (Deferred) | 21 pass, 0 fail, 94 assertions |
| test/codium-owner.test.ts with EV-07 | 36 pass, 1 skip, 0 fail, 149 assertions |
| Regressions, root: remote-ticket-api, on-call, codium-founding, codium-vercel-spend | 29/0/261; 30 pass 1 skip/0/299; 24 pass 1 skip/0/215; 52 pass 4 skip/0/238 |
| Regressions, packages/web: all 41 test/everywhere-*.test.ts files, one per run | every file 0 fail (jobs-api 22/0/226, router 9/0/37, intake 8/0/68, github 17/0/137, jobs 43 pass 9 skip/0/329; the rest in /tmp/vector-v2/everywhere/ev07/web-everywhere-rest.txt) |
| packages/schema `bun typecheck` | exit 0 |
| API: packages/engine `bun typecheck --project ../../tsconfig.json` | exit 0 |
| packages/web `bun typecheck` (astro check, includes test/ and src/) | 0 errors, 0 warnings, 411 hints (none on an EV-07 line) |
| Root test/ files | not typechecked by any lane check (the root tsconfig includes only api/**). A one-off tsgo run with a scratch tsconfig over the two root test files found one EV-07 error (`string` for `SwitchValue` at codium-owner.test.ts:183), fixed with `as const`; the one remaining error is HEAD's codium-owner.test.ts:522 (now :560), not EV-07's |
| Prettier drift (lines prettier would change), HEAD and after | codium-switches.ts, codium-owner.ts, codium-owner-api.ts, CodiumOwner.tsx, switch.ts, test/codium-switches.test.ts, test/codium-owner.test.ts 0 and 0; CodiumOwner.test.ts 5 and 5; everywhere-switch.test.ts 6 and 6; everywhere-sweep.test.ts 42 and 42 (none added) |
| Diff guards | no personal path or email address; no added line over 120 columns; only the ten code and test files and the four lane documents changed |

Line numbers in this entry are after the review round-one fixes; the counts
in the two tables are from the first run, before them (see "EV-07 review
fixes, round one" below).

Mutations: each a patch under /tmp/vector-v2/everywhere/ev07-mut/, applied
with `git apply`, the affected files run alone, then `git apply -R`; the
SHA-256 of the five code files matched pre.sha after every mutation, and the
run ended `ALL-REVERTED` (results.txt).

| Mutation | Result | Red cases |
| --- | --- | --- |
| M1: `everywhere: ["on", "off"]` | everywhere-switch 13/3; codium-switches 17/1; codium-owner 34/2 | :113, :125, :134; :166; :181, :251 |
| M2: `everywhere` removed from SWITCH_NAMES | everywhere-switch 11/5; sweep 10/1; codium-switches 17/1; codium-owner 34/2 | :113, :118, :125, :134, :171; sweep :231; :166; :181, :251 |
| M3: readEverywhereSwitch ignores Codium | everywhere-switch 10/6; sweep 10/1 | :50, :58, :118, :125, :134, :171; sweep :231 |
| M4: no env check | everywhere-switch 13/3; sweep 11/0 | :35, :50, :150; the sweep answers off before any switch read, so it stays green, as expected |
| M5: the hosted-only owner API ternary restored | codium-owner 35/1 | :181 |
| M6: hosted-only options in the TSX | CodiumOwner.test.ts 20/1 | :246 |
| M7: `RuntimeSwitch.name` without `everywhere` | codium-owner 34/2; CodiumOwner.test.ts 21/0 | :251 and the existing wire-shape case :236; the page test renders without decoding, so it stays green, as expected |

Commit gate: not run in this step. The changes stay in the working tree for
the lead's commit (`feat(codium): add the everywhere runtime switch with
no-new and stop`, staging the fourteen paths explicitly; the body says no
generated file was regenerated because nothing in packages/engine or
packages/client imports the codium-owner schema). Before the push: repeat the
cross-lane diff, `git fetch origin everywhere-finish`, the full
`bun turbo typecheck --concurrency=2`.

Deferred:

- After the push, dispatch on `everywhere-finish`: vector-everywhere.yml
  (everywhere-switch and everywhere-sweep), vector-hosted-ci.yml (the root
  test/ suite with Valkey, schema) and typecheck.yml. Never vector-codium.yml.
  vector-hosted-ci.yml and vector-codium.yml do not share a concurrency group
  (vector-hosted-ci.yml:46, vector-codium.yml:22), but a second
  vector-hosted-ci dispatch on the same ref cancels the first, so record its
  run id before any re-dispatch. Then, in one docs commit, add "## EV-07 push
  receipts" here and mark the handoff bullet "CI green" with the run ids.
- CodiumOwner.test.ts runs in no lane workflow until vector-codium.yml is used
  after PR #33; its receipt is the local run above.
- Owner: deploy, then set the production `everywhere` switch. VE-50: `stop`
  reaches a running laptop within about 2 minutes.
- Request to Codium (or the lead): annotate MODEL-PLANS.md:244,
  codium-build-spec.md:138 and :526, and owner-actions/codium-owner-guards.md:36
  with `everywhere` (`on`, `no-new`, `stop`).
- EV-08: do not map the `everywhere` perk to the `everywhere` switch, or
  decide on purpose that `no-new` hides it (deviations log, EV-07).

### EV-07 review fixes, round one (2026-11-15)

Nine non-blocking findings. Taken: the owner-audit pin, the sweep test's
`else`, the informational mark on the local redis row, the dashboard
request to Codium, and a page pin plus comment in place of a shared value
map. Rejected, with reasons in the deviations log ("2026-11-15, EV-07",
"Review findings (round one)"): the shared schema map, freezing
SWITCH_VALUES. The handoff's "CI pending" stays until the push receipts.

Files changed in this round:

- test/codium-owner.test.ts:181: after the two accepted calls the owner
  audit (`ownerAuditKey()`) holds 4 rows, and still 4 after the three
  refused calls.
- packages/web/test/everywhere-sweep.test.ts:231: the `finally` restore uses
  an early `continue`, with no `else`.
- packages/web/src/components/marketing/owner/CodiumOwner.test.ts: the
  option reader moves to module scope as `switchOptions` (:116), used by
  :246 and the new :264, which renders every name in SWITCH_NAMES and
  expects each select to offer exactly `SWITCH_VALUES[name]`.
- packages/web/src/components/marketing/owner/CodiumOwner.tsx:894: a JSX
  comment pointing at SWITCH_VALUES and the pinning test.
- Docs: the deviations entry (the dashboard request, the round-one
  decisions, the informational redis run, corrected line numbers), this
  entry. No code file outside these two test files and the TSX comment
  changed; api/_lib/codium-switches.ts and codium-owner-api.ts are as before
  this round (their SHA-256 matched after each mutation).

Checks (each through `vector-serial`, one file per run):

| Check | Result |
| --- | --- |
| packages/web CodiumOwner.test.ts | 22 pass, 0 fail, 110 assertions |
| root test/codium-owner.test.ts (run from test/) | 36 pass, 1 skip, 0 fail, 151 assertions |
| packages/web test/everywhere-sweep.test.ts | 11 pass, 0 fail, 99 assertions |
| packages/web `bun typecheck` (astro check) | 0 errors, 0 warnings, 411 hints (unchanged) |
| Prettier drift, HEAD and after (lines prettier would change) | CodiumOwner.test.ts 2 and 2; everywhere-sweep.test.ts 8 and 8; CodiumOwner.tsx and test/codium-owner.test.ts 0 and 0 (none added) |
| Diff guards | no added code line over 120 columns |

Mutations (scratch copy under /tmp/vector-v2/everywhere/ev07-fix/, restored
and SHA-256 checked after each):

| Mutation | Result | Red case |
| --- | --- | --- |
| M8: `push: ["on", "no-new", "stop"]` in codium-switches.ts, page unchanged | CodiumOwner.test.ts 21/1 | :264 |
| M9: codium-owner-api.ts audits "requested" before `prepare()` | codium-owner 35/1 | :181 |

## EV-08: Codium `everywhere` perk for every paid plan, unlisted (2026-11-15)

Base: HEAD `bd34820c` (EV-07, pushed), equal to `origin/everywhere-finish`.
`git fetch origin release-finish main everywhere-finish codium-finish
review-fixes` found `release-finish` still at `cf2373c4`, already merged
(`git merge-base --is-ancestor` true), so no merge was needed; `main` is
`58f85edc` and is not merged (PR #33 is not in). `git diff --stat
origin/release-finish...origin/<b>` over the twelve EV-08 paths (five code
files, seven test files) was empty for codium-finish `ab784e44`,
review-fixes `1433d105` and main. EV-08 depends on EV-07 (the `everywhere`
switch, in HEAD) and on no review-fixes or brain-transport work. The changes
are in the working tree, not committed.

Files changed (line numbers after EV-08):

- packages/schema/src/codium-entitlements.ts:39: `"everywhere"` appended to
  `PERK_IDS`.
- packages/schema/src/codium-copy.ts: `requires.everywhere = ["remote"]`
  (:15); `PERK_COPY.everywhere` (:142-149), `applies: every`, label "Vector
  everywhere", the text for the owner to approve.
- api/_lib/everywhere/config.ts: `LAPTOP_ROUTE_WIRED: boolean = false` (:244)
  and `everywhereReady(config?, wired)` (:253-263); comments on
  `allowAccounts` (:48-51) and `sponsorListed` (:229-232).
- api/_lib/everywhere/ports.ts:55-58: comment only.
- api/_lib/codium-perks.ts: the import (:18), `perkServices.everywhere`
  with its WP comment (:88-93), `switches.everywhere` (:110).
- packages/schema/test/codium-entitlements.test.ts: `["everywhere", []]` in
  "a perk's numbers show only while it is listed" (:262); :312 `everywhere`
  is in PERK_IDS once and adds no public field on any plan.
- packages/schema/test/codium-copy.test.ts: describe "the everywhere perk"
  (:122): :125 every paid plan includes it with Remote, no headline, the same
  tagline and caps as Remote alone, and ENTITLEMENTS' keys are the four paid
  plans (structural); :143 `requires.everywhere` is `["remote"]` and alone
  it shows on no plan; :149 the copy rules.
- packages/web/test/everywhere-config.test.ts: describe "the Codium perk's
  readiness (EV-08)" (:277): :291 false today even fully configured, with
  the default `wired`; :297 once wired, true with Slack, Linear, Jira or GitHub plus
  Slack, false with nothing set and with each of seven variables removed;
  :316 GitHub alone, GitHub with Slack incomplete, "TRUE" and a short cron
  secret are false. Secrets generated in the test; fetch guard installed.
- packages/web/test/codium-public.test.ts: the ten variables saved and
  restored by beforeEach (:15-27); :132 "EV-08: everywhere lists only when
  ready, with Remote listed and the everywhere switch on" (the owner's list
  first; the real readiness false with every variable set; Remote required
  and its switch; `no-new` and `stop` hide it; `off` and garbage list
  nothing; perks-off; publicCodiumTiers' caps gain no field;
  MODEL_PLANS_ENABLED=false).
- packages/web/test/codium-docs.test.ts:162: a feature of all four plans
  with Remote, none without it, never a hosted perk.
- packages/web/src/components/marketing/codium/CodiumPricing.test.ts:238:
  the comparison row once, its text four times on the page and on no card;
  absent with Remote unlisted and with the empty listing.
- packages/web/test/model-plan-status-api.test.ts: imports `ENTITLEMENTS`
  and `PERK_COPY`; describe "the everywhere perk (EV-08)" (:611): a no-plan
  account sees it listed with no plan or entitlements; a paid plan's
  entitlements equal `publicEntitlements(plan, {remote})` and the perk
  applies to its caps.
- Docs: vector-everywhere-deviations.md (the EV-08 entry; a dated line under
  EV-07's "A note for EV-08"), vector-everywhere-spec.md (dated notes after
  the §3.4 table, after §6.1's code block, under §10 "Codium listing" and
  under R-C7), vector-everywhere-handoff.md (a "Codium `everywhere` perk"
  status bullet, CI pending; a "Left open by the repairs" item for the
  runtime check; the owner's rules and decisions unchanged), this file.
  v2-notes/v2-complete-plan.md and Codium's documents are not edited.

No new env var, flag, route, dependency, install or generated file (no perk
id appears in packages/client, packages/sdk, engine src or config.json).
Nothing new becomes reachable on vectordev.ai. No test calls a real host.

Checks (each through `vector-serial`, one file per run, `--timeout 30000`):

| Check | Result |
| --- | --- |
| packages/schema test/codium-entitlements.test.ts at HEAD (baseline) | 14 pass, 0 fail, 531 assertions |
| packages/schema test/codium-copy.test.ts at HEAD | 8 pass, 0 fail, 494 assertions |
| packages/web test/codium-public.test.ts at HEAD | 13 pass, 0 fail, 82 assertions |
| packages/web test/codium-docs.test.ts at HEAD | 12 pass, 0 fail, 9744 assertions |
| packages/web src/components/marketing/codium/CodiumPricing.test.ts at HEAD | 15 pass, 0 fail, 206 assertions |
| packages/web test/everywhere-config.test.ts at HEAD | 21 pass, 0 fail, 196 assertions |
| packages/web test/model-plan-status-api.test.ts at HEAD | 22 pass, 0 fail, 222 assertions |
| codium-entitlements.test.ts with EV-08 | 15 pass, 0 fail, 544 assertions |
| codium-copy.test.ts with EV-08 | 11 pass, 0 fail, 574 assertions |
| codium-public.test.ts with EV-08 | 14 pass, 0 fail, 102 assertions |
| codium-docs.test.ts with EV-08 | 13 pass, 0 fail, 9772 assertions |
| CodiumPricing.test.ts with EV-08 | 16 pass, 0 fail, 216 assertions |
| everywhere-config.test.ts with EV-08 | 24 pass, 0 fail, 220 assertions |
| model-plan-status-api.test.ts with EV-08 | 24 pass, 0 fail, 227 assertions |
| Regressions, root (run from test/), HEAD and after, identical | api-module-loading 2/0/10 (the import graph changed); phone-app 10 pass 1 skip/0/95; remote-phone-api 8/0/37; codium-founding 24 pass 1 skip/0/215; ops-payment-pipeline 10/0/78; brain-vault-api 23/0/710; playbooks-api 15/0/177 |
| Regressions, packages, HEAD and after, identical | web test/model-plans.test.ts 21/0/166; app src/phone/status.test.ts (`--isolate`) 11/0/57; core test/model-plan-status-compat.test.ts 4/0/73 |
| packages/schema `bun typecheck` | exit 0 |
| API: packages/engine `bun typecheck --project ../../tsconfig.json` | exit 0 |
| packages/web `bun typecheck` (astro check, includes test/ and src/) | 0 errors, 0 warnings, 411 hints (unchanged from EV-07) |
| packages/app, packages/core, packages/desktop `bun typecheck` | exit 0 each |
| Prettier drift (lines prettier would change), HEAD and after | codium-copy.ts, codium-entitlements.ts, codium-perks.ts, both schema tests, CodiumPricing.test.ts, model-plan-status-api.test.ts, codium-docs.test.ts 0 and 0; config.ts 14 and 14; ports.ts 15 and 15; codium-public.test.ts 4 and 4; everywhere-config.test.ts 42 and 42 (none added; codium-docs.test.ts was 4 after the first draft, fixed and re-run) |
| Diff guards | no personal path or email address; one added code line over 120 columns, the PERK_COPY text (a string literal prettier leaves whole, like the other texts in that object); only the twelve code and test paths and the four lane documents changed |
| Cross-lane overlap | `git diff --stat origin/release-finish...origin/<b>` over the twelve paths empty for codium-finish `ab784e44`, review-fixes `1433d105`, main `58f85edc` |

After the mutation runs, two test titles were shortened (codium-copy.test.ts:125, codium-docs.test.ts:162), the codium-docs `expect` was split into two lines and a comment in codium-public.test.ts:168 was rewrapped; each of those three files was re-run alone with the same counts as above, and the schema (exit 0) and web (0 errors, 0 warnings, 411 hints) typechecks were re-run after them. A second fetch at the end found every branch at the same SHA, and the cross-lane diff over the twelve paths was still empty.

Mutations: /tmp/vector-v2/everywhere/ev08-mut/run.sh edits one code file in place, runs the affected files one at a time through the lock, then restores all five code files from saved copies. `restored-ok` (SHA-256 against pre.sha) after every mutation, and a final `sha256sum -c` passed for all five (results.txt).

| Mutation | Result | Red cases |
| --- | --- | --- |
| M1: `requires.everywhere` dropped | codium-copy 10/1; codium-public 13/1; codium-docs 12/1; CodiumPricing 15/1 | codium-copy :143; codium-public :132; codium-docs :162; CodiumPricing :238 |
| M2: the `everywhere` switch mapping dropped | codium-public 13/1 | :132 |
| M3: the perkServices entry dropped | codium-public 13/1 | :132 (`perkServices.everywhere?.(fetch)` is undefined, not false) |
| M4a: everywhereReady ignores the offer key | everywhere-config 23/1 | :299 |
| M4b: everywhereReady ignores CRON_SECRET | everywhere-config 22/2 | :299, :318 |
| M5: `applies` false for vector-10 (`c.rank > 1`) | codium-copy 10/1; codium-docs 12/1; CodiumPricing 15/1 | :125; :162; :238 |
| M6: `everywhere` in HEADLINE_ORDER for vector-10 | codium-copy 10/1; CodiumPricing 15/1 | :125; :238 (its text then appears on the Plus card) |
| M7: `LAPTOP_ROUTE_WIRED = true` | everywhere-config 23/1; codium-public 13/1 | :292; :132 |
| M8: GitHub counts as an open platform | everywhere-config 23/1 | :318 |
| M9: `remote`'s field shown when only `everywhere` is listed | codium-entitlements 13/2 | :245 (the `["everywhere", []]` row), :312 |

Commit gate: not run in this step. The changes stay in the working tree for
the lead's commit (`feat(codium): add the everywhere perk for every paid
plan, unlisted`, staging the twelve code and test paths and the four lane
documents explicitly; the body says no generated file was regenerated
because no perk id appears in packages/client, packages/sdk, engine src or
config.json). Before the push: repeat the cross-lane diff, `git fetch origin
everywhere-finish`, the full `bun turbo typecheck --concurrency=2`.

Deferred:

- After the push, dispatch on `everywhere-finish`: vector-hosted-ci.yml (the
  schema tests and the root suite, including api-module-loading; record its
  run id before any re-dispatch), typecheck.yml and vector-everywhere.yml
  (everywhere-config.test.ts and the api, schema, web and app typechecks).
  Never vector-codium.yml before PR #33 is merged here. Then, in one docs
  commit, add "## EV-08 push receipts" here and mark the handoff bullet "CI
  green" with the run ids.
- codium-public, codium-docs, CodiumPricing and model-plan-status-api run in
  no lane workflow until vector-codium.yml is used after PR #33; their
  receipts are the local runs above.
- The runtime plan check (R-C7's runtime half) and the laptop route (VE-20,
  VE-21), which set `LAPTOP_ROUTE_WIRED` true and update the cases that pin
  readiness false with the default `wired` (everywhere-config.test.ts:291,
  codium-public.test.ts:132). Handoff, "Left
  open by the repairs".
- Owner: approve the copy; list the perk only after the plan check lands.
  VE-50: the live listing.
- Request to Codium: annotate codium-build-spec.md:507 with `everywhere`;
  settle switches separately in listedPerks as well as on the dashboard.

### EV-08 review fixes (round one, 2026-11-15)

Not committed; the changes stay in the working tree with the rest of EV-08.

- api/_lib/everywhere/config.ts:253-263: `everywhereReady(config?, wired)`
  returns false on `!wired` before `config ?? readConfig()`, so a listing
  read parses no environment or offer key while the route is unwired.
- packages/web/test/everywhere-config.test.ts: the
  `expect(LAPTOP_ROUTE_WIRED).toBe(false)` line and its import dropped; the
  behavioural cases at :291 stay.
- packages/web/test/codium-public.test.ts:156: the service check gets
  `codiumFakes().fetcher`, not the global `fetch`.
- packages/web/test/model-plan-status-api.test.ts:70: the top-level
  beforeEach resets `current.fetcher = fetch`.
- Docs: the deviations entry's "Review findings (round one)" and owner
  action 1 (E2 and narrower phrasings); two handoff "Left open by the
  repairs" items (listedPerks per-switch settling, the copy's limits).

| Check | Result |
| --- | --- |
| packages/web test/everywhere-config.test.ts | 24 pass, 0 fail, 219 assertions (one assertion fewer) |
| packages/web test/codium-public.test.ts | 14 pass, 0 fail, 102 assertions |
| packages/web test/model-plan-status-api.test.ts | 24 pass, 0 fail, 227 assertions |
| packages/web test/codium-docs.test.ts | 13 pass, 0 fail, 9772 assertions |
| packages/web src/components/marketing/codium/CodiumPricing.test.ts | 16 pass, 0 fail, 216 assertions |
| root test/api-module-loading.test.ts (from test/) | 2 pass, 0 fail, 10 assertions |
| M7 re-run (`LAPTOP_ROUTE_WIRED = true`; config.ts restored, `sha256sum -c` OK) | everywhere-config 23/1 (:291); codium-public 13/1 (:132) |
| API: packages/engine `bun typecheck --project ../../tsconfig.json` | exit 0 |
| packages/web `bun typecheck` | 0 errors, 0 warnings, 411 hints |
| Prettier drift, the four edited files | config.ts 14, everywhere-config.test.ts 42, codium-public.test.ts 4, model-plan-status-api.test.ts 0 (unchanged) |

### EV-08 commit gate (2026-11-15)

`git fetch origin release-finish main everywhere-finish codium-finish
review-fixes` found release-finish `cf2373c4` (already merged), main
`58f85edc` (PR #33 not on it) and everywhere-finish equal to HEAD
`bd34820c`. The cross-lane diff over the twelve code and test paths was
again empty for codium-finish `ab784e44`, review-fixes `1433d105` and main.
Only the twelve EV-08 paths and the four lane documents were in the working
tree, with nothing untracked. Re-run through `vector-serial`, one file at a
time, `--timeout 30000`:

| Check | Result |
| --- | --- |
| packages/schema test/codium-entitlements.test.ts | 15 pass, 0 fail, 544 assertions |
| packages/schema test/codium-copy.test.ts | 11 pass, 0 fail, 574 assertions |
| packages/web test/codium-public.test.ts | 14 pass, 0 fail, 102 assertions |
| packages/web test/codium-docs.test.ts | 13 pass, 0 fail, 9772 assertions |
| packages/web src/components/marketing/codium/CodiumPricing.test.ts | 16 pass, 0 fail, 216 assertions |
| packages/web test/everywhere-config.test.ts | 24 pass, 0 fail, 219 assertions |
| packages/web test/model-plan-status-api.test.ts | 24 pass, 0 fail, 227 assertions |
| root test/api-module-loading.test.ts (from test/) | 2 pass, 0 fail, 10 assertions |
| packages/schema `bun typecheck` | exit 0 |
| API: packages/engine `bun typecheck --project ../../tsconfig.json` | exit 0 |
| packages/web `bun typecheck` | 0 errors, 0 warnings, 411 hints |
| packages/app `bun typecheck` | exit 0 |
| Full `bun turbo typecheck --concurrency=2` | exit 0, 27 of 27 tasks (0 cached) |

Committed as `feat(codium): add the unlisted everywhere perk to every paid
plan`; the push and the run ids are recorded in "EV-08 push receipts" in the
follow-up docs commit.

## EV-09: relay adapter, presence, offers and the plan check (2026-11-15)

Base: HEAD `3443cfa3` (EV-08), equal to `origin/everywhere-finish`. `git
fetch origin release-finish main everywhere-finish codium-finish
review-fixes brain-transport` found release-finish still at `cf2373c4`
(already merged; no merge needed), main `58f85edc` (not merged; PR #33 is
not in), codium-finish `420e729f`, review-fixes `1433d105` and
brain-transport `8f742520`. Preconditions: EV-05 `8caf62cb`, EV-06
`411317d8`, EV-07 `bd34820c` and EV-08 `3443cfa3` are all ancestors of
HEAD (`git merge-base --is-ancestor`). The cross-lane diff over the EV-09
paths and the modules the adapter and its tests import (listed in the
deviations entry) was empty for codium-finish, main and brain-transport;
review-fixes touches only vector-everywhere.yml and everywhere-lane.test.ts
in hunks separate from EV-09's, and a `git merge-tree` of the working tree
(as a scratch commit, no ref moved) with review-fixes and with
brain-transport is clean. With codium-finish it conflicts in three files
EV-09 does not touch, exactly as HEAD already does. The changes are in the
working tree, not committed. A second fetch at the end found brain-transport
at `a89fe7a0` (every other tip unchanged); its diff over the same paths is
still empty, and the merge probe was repeated with the four lane documents
included: clean with review-fixes (which also edits
api/_lib/everywhere/erase.ts for DP-1 and spec.md:879 for FIT-5, neither
touched by EV-09) and with brain-transport `a89fe7a0`.

Files changed (line numbers after EV-09):

- api/_lib/remote-relay.ts: `job-offer {account, offer}` in the header list
  (:16); `RelayAction` gains `"job-offer"` (:31-39, prettier's one member
  per line).
- api/_lib/everywhere/adapters/remote.ts (new, 100 lines):
  `createRemotePorts` (:27-80) with `remoteCaps` (:36-50), `presence`
  (:53-62), `offer` (:63-69) and `perk` (:70-78); `planListsEverywhere`
  (:90-100).
- api/_lib/everywhere/runtime.ts: the import (:3); `productionPorts(config,
  fetcher?)` (:16-25) adds the adapter only with `config.enabled` and
  `config.offer`.
- api/_lib/everywhere/ports.ts:55-60 and api/_lib/everywhere/config.ts
  (:48-52, :230-234, :239-246): comments only; `LAPTOP_ROUTE_WIRED` stays
  `false`.
- .github/workflows/vector-everywhere.yml:55-59 and
  packages/web/test/everywhere-lane.test.ts:300-304: api/_lib/codium-limits.ts,
  codium-snapshot.ts, remote-config.ts, remote-relay.ts and
  packages/schema/src/codium-copy.ts in the paths and the `helpers` list.
- packages/web/test/everywhere-remote-adapter.test.ts (new): the relay
  Worker (`handleRequest` over packages/relay/test/fakes.ts) served by
  `Bun.serve` on 127.0.0.1, the Codium fakes' store, the fetch guard, a new
  fetcher per adapter (Codium's 30-s switch cache is per fetcher). Cases:
  presence (VE-20) :187 online only with Remote on, configured and in the
  plan, counting computers; :200 the `remote` switch off (and corrupt, and
  unreadable) is offline while relayPresence says online (E10); :222 each
  of four Remote settings removed is `not-configured` and the offer is
  `unavailable`, with no relay call; :243 twelve not-in-plan cases (no
  snapshot, `none`, paused, frozen, ended, renewing past its grace, active
  past period end plus grace, another account's, the other Stripe mode, no
  `remote` caps, 0 computers, an unreadable snapshot) with no relay call and
  no Remote perk, and a non-UUID account with no store read; :329 renewing
  and active inside the grace are in the plan; :342 parity with Codium's
  `includes` on every plan; :354 unreachable on 502, a non-JSON 200, a
  refused connection, a TimeoutError and a wrong internal secret (401);
  :383 the relay's kill flag; :395 a suspension through the API's own
  `relaySuspend`; :410 a stored suspension a live computer still meets. Offers (R-C1): :429 one call, both computers get one
  `0x02` frame with sixteen zero device bytes and the offer's text, the
  phone none; :444 delivered 0 is `unavailable`; :454 a 429 (seeded
  `offers` meta), a 400 and a refused connection each after exactly one
  call. The
  everywhere perk: :475 the allowlist with no store read and nothing else
  while the gate is closed (not wired; wired but unlisted; listed with model
  plans off); :497 wired and listed, a paid plan joins, frozen, none and
  unknown do not; :516 `perks-off` with `everywhere`, the `codium` switch
  `off` and either read failing take it away again, without touching the
  allowlist or `perk("remote")`; :551 the Slack `repo` word's `maySponsor` follows the same
  rule. productionPorts: :590 flag off, flag without the offer key, and the
  offer key without the flag are safePorts with `codiumAccountAuthority`,
  with no relay call and no store command; :628 with both it uses the
  adapter. Routing: :648 an online computer gets the offer, verifies it
  against the pinned key, claims it after the first 2-s poll, and
  `routeJob` answers `laptop` well inside `TIMING.offerWindowMs`, with
  progress `finding` then `laptop` and exactly one `presence` and one
  `job-offer` call.
- test/remote-relay-contract.test.ts: describe "job offers between the API
  and the relay (R-C1, EV-09)" (:121): :147 `relayCall("job-offer")` with a
  `signOffer` offer reaches the account's computer through the Worker byte
  for byte; :162 the longest offer `OFFER_PATTERN` allows is accepted
  (`{delivered: 1}`). Cast-free (no listed typecheck covers root test/; a
  scratch `tsgo` run over the file reported only the pre-existing error at
  :111).
- Docs: vector-everywhere-deviations.md (the EV-09 entry),
  vector-everywhere-spec.md (dated notes after the EV-06 note in §2, after
  the §3.4 table, after §6.1's EV-08 note, below the phase-3 table for
  VE-20, under R-C1 and under R-C7), vector-everywhere-handoff.md (a "Relay
  adapter" status bullet, CI pending; dated notes on the EV-06 bullet and on
  the "everywhere perk's runtime check" item; a new "Left open" item for
  the relay-outage refusal), this file.

No env var, flag, route, dependency, install or generated file. Nothing
becomes reachable on vectordev.ai. No test calls a real host.

Checks (each through `vector-serial`, one file per run, `--timeout 30000`;
packages/web from its directory, root files from test/):

| Check | Result |
| --- | --- |
| packages/web test/everywhere-remote-adapter.test.ts (new) | 17 pass, 0 fail, 162 assertions |
| test/remote-relay-contract.test.ts, HEAD and after | 7/0/20 and 9/0/28 |
| packages/web test/everywhere-lane.test.ts, HEAD and after | 13/0/149 and 13/0/149 |
| Regressions, packages/web, HEAD and after, identical | everywhere-router 9/0/37; everywhere-config 24/0/219; everywhere-intake 8/0/68; everywhere-slack-events 12/0/94; everywhere-github 17/0/137; everywhere-slack-render 10/0/51; everywhere-linear-render 11/0/74; everywhere-jira-render 6/0/48; everywhere-identity 39 pass 4 skip/0/243; everywhere-authority 20 pass 7 skip/0/225; everywhere-switch 16/0/89; everywhere-offer 16/0/60; codium-public 14/0/102 (local receipt only) |
| Regressions, root (from test/), HEAD and after, identical | remote-ticket-api 29/0/261; api-module-loading 2/0/10 (the new import graph) |
| packages/relay test/internal.test.ts, HEAD and after | 24/0/245 |
| API: packages/engine `bun typecheck --project ../../tsconfig.json` | exit 0 |
| packages/web `bun typecheck` (astro check; now also checks the relay sources and fakes the new test imports) | 0 errors, 0 warnings, 411 hints (unchanged) |
| packages/schema and packages/relay `bun typecheck` | exit 0 each |
| Full `bun turbo typecheck --concurrency=2` | exit 0, 27 of 27 tasks (22 cached) |
| Prettier drift (lines prettier would change), HEAD and after | remote-relay.ts 0 and 0; runtime.ts 0 and 0; everywhere-lane.test.ts 0 and 0; remote-relay-contract.test.ts 0 and 0; ports.ts 15 and 15; config.ts 14 and 14; the two new files 0 |

Mutations: /tmp/vector-v2/everywhere/ev09-mut/run.sh applies one textual
change, runs the named file through the lock, then restores adapters/remote.ts,
runtime.ts and vector-everywhere.yml from saved copies; `restored-ok`
(`sha256sum -c` against pre.sha) after every mutation and at the end
(results.txt). Every mutation turned at least one case red:

| Mutation | Result (adapter test unless named) | Red cases |
| --- | --- | --- |
| M1: no switch check | 16/1 | :185 |
| M2: no `remoteConfigured` in presence | 16/1 | :207 |
| M3: no plan check in presence | 16/1 | :228 |
| M4: presence rethrows relay errors | 16/1 | :339 |
| M5: `delivered >= 0` | 15/2 | :373, :402 |
| M6a: the offer retried once on failure | 16/1 | :412 |
| M6b: the offer sent twice | 11/6 | :373, :387, :402, :412, :555, :575 |
| M7: the allowlist ignored | 13/4 | :437, :478, :555, :575 |
| M8: the plan ignored for `everywhere` | 15/2 | :459, :478 |
| M9: `requireUsableSnapshot` skipped | 15/2 | :228, :459 |
| M10: `>= 0` computers in the plan read | 16/1 | :228 |
| M11: productionPorts always uses the adapter | 16/1 | :517 |
| M12: productionPorts ignores `config.offer` | 16/1 | :517 |
| M13: codium-snapshot.ts dropped from the workflow paths | everywhere-lane 12/1 | "the paths cover every everywhere zone and the main helpers that code imports" |
| M14: the plan gate ignores `wired` | 14/3 | :437, :478, :555 |
| M15: the plan gate ignores the owner's listing | 16/1 | :437 |
| M16: the offer skips `remoteConfigured` | 16/1 | :207 |
| M17: the active-past-grace rule dropped | 16/1 | :228 |

Commit gate: not run in this step. The changes stay in the working tree for
the lead's commit (`feat(everywhere): offer jobs to online computers through
the relay adapter`, staging api/_lib/remote-relay.ts,
api/_lib/everywhere/adapters/remote.ts, api/_lib/everywhere/runtime.ts,
api/_lib/everywhere/ports.ts, api/_lib/everywhere/config.ts,
.github/workflows/vector-everywhere.yml,
packages/web/test/everywhere-remote-adapter.test.ts,
packages/web/test/everywhere-lane.test.ts, test/remote-relay-contract.test.ts
and the four lane documents explicitly; the body says no generated file was
regenerated). Before the push: repeat the cross-lane diff, `git fetch origin
everywhere-finish`, the full `bun turbo typecheck --concurrency=2`.

Deferred:

- After the push, dispatch on `everywhere-finish`: vector-everywhere.yml
  (the new adapter test, everywhere-lane and the typechecks),
  vector-hosted-ci.yml (root test/, including remote-relay-contract,
  remote-ticket-api and api-module-loading, and the relay's tests) and
  typecheck.yml. Never vector-codium.yml before PR #33 is merged here. Then,
  in one docs commit, add "## EV-09 push receipts" here and mark the handoff
  bullet "CI green" with the run ids. The EV-08 push receipts are also still
  missing here; the lead may fold them into the same docs commit.
- codium-public.test.ts runs in no lane workflow until vector-codium.yml is
  used after PR #33; its receipt is the local run above.
- Follow-ups recorded in the handoff's "Left open by the repairs": the
  relay-outage refusal (`unreachable` counts as not configured); listing
  `everywhere` still waits for `LAPTOP_ROUTE_WIRED` (VE-21, EV-11).
- Request to Codium: annotate codium-a39-remote-relay-notes.md and
  codium-a40-remote-api-notes.md with `job-offer`.
- Owner: set the offer signing key only after the Worker deploy and a
  desktop release with EV-11. VE-50: real Worker presence and offers.

### EV-09 review fixes (2026-11-15)

Seven non-blocking findings; dispositions in the deviations entry ("Review
findings"). Not committed: the changes stay in the working tree with the
rest of EV-09.

- api/_lib/everywhere/adapters/remote.ts: `perk` returns false for a
  non-UUID account before any read (:71-72); `planListsEverywhere(wired,
  fetcher)` (:90-100) also reads Codium's `codium` switch and `perks-off`
  (codium-switches.ts `readSwitch` and `readDisabledSet`), only once the
  wiring and the environment listing hold, and a failed read is false.
- packages/web/test/everywhere-remote-adapter.test.ts: `refusing()`
  replaces both stopped-server ports; new cases :395, :410 and :516 (above);
  :497's non-UUID check uses new ports, so the early return, not Codium's
  cache, is what keeps the store untouched.
- test/remote-relay-contract.test.ts:131-137: the environment restore uses
  `continue`, not `else`.
- Lane documents: the EV-09 deviations entry ((c), (j), (k), (l), the
  owner notes and "Review findings"), the handoff's relay adapter bullet,
  the spec's §3.4 EV-09 note, this file.

Checks (each through `vector-serial`, one file per run, `--timeout 30000`):

| Check | Result |
| --- | --- |
| packages/web test/everywhere-remote-adapter.test.ts | 20 pass, 0 fail, 185 assertions |
| test/remote-relay-contract.test.ts (from test/) | 9/0/28 |
| test/api-module-loading.test.ts (from test/) | 2/0/10 |
| packages/web everywhere-lane | 13/0/149 |
| Regressions, packages/web | everywhere-router 9/0/37; everywhere-intake 8/0/68; everywhere-slack-events 12/0/94; everywhere-identity 39 pass 4 skip/0/243; everywhere-config 24/0/219 |
| API: packages/engine `bun typecheck --project ../../tsconfig.json` | exit 0 |
| packages/web `bun typecheck` | 0 errors, 0 warnings, 411 hints (unchanged) |
| Prettier `--check` on the three changed code files | clean (the adapter test after `--write`) |

Mutations (each applied by hand to adapters/remote.ts, the adapter test
run, then the saved copy restored and compared with `cmp`):

| Mutation | Result | Red case |
| --- | --- | --- |
| M18: `perks-off` ignored | 19/1 | :516 |
| M19: a failed listing read reads true | 19/1 | :516 |
| M20: the `codium` switch ignored | 19/1 | :516 |
| M21: no early return for a non-UUID account | 19/1 | :497 |

Merge probe, repeated (review finding on vector-everywhere.yml): after
`git fetch origin release-finish main everywhere-finish review-fixes
brain-transport codium-finish` the tips were release-finish `cf2373c4`,
main `58f85edc`, everywhere-finish `3443cfa3` (= HEAD), review-fixes
`1433d105`, brain-transport `a89fe7a0` and codium-finish `420e729f`. A
scratch commit of the whole working tree (a temporary index under
/tmp/vector-v2/everywhere/, `commit-tree`, no ref moved), lane documents
included, merges cleanly (`git merge-tree --write-tree`, exit 0) with
review-fixes `1433d105` and brain-transport `a89fe7a0`; with codium-finish
it conflicts only in vector-codium.yml, packages/cloud/src/codium-ci-tests.ts
and workflow-compliance.test.ts, as HEAD already does. The commit step
repeats the probe against whatever review-fixes tip is current then and
records its SHA here.

### EV-09 commit gate (2026-11-15)

`git fetch origin release-finish main everywhere-finish review-fixes
brain-transport codium-finish` found release-finish `cf2373c4` (already
merged), main `58f85edc` (PR #33 not on it) and everywhere-finish equal to
HEAD `3443cfa3`. Only the EV-09 paths named above and the four lane
documents were in the working tree, with the two new files the only
untracked ones. The merge probe was repeated (a scratch commit of the
working tree from a temporary index under /tmp/vector-v2/everywhere/, no
ref moved): `git merge-tree --write-tree` exits 0 with review-fixes
`1433d105` and brain-transport `a89fe7a0`. Re-run through `vector-serial`,
one file at a time, `--timeout 30000`:

| Check | Result |
| --- | --- |
| packages/web test/everywhere-remote-adapter.test.ts | 20 pass, 0 fail, 185 assertions |
| packages/web test/everywhere-lane.test.ts | 13 pass, 0 fail, 149 assertions |
| packages/web test/everywhere-router.test.ts | 9 pass, 0 fail, 37 assertions |
| root test/remote-relay-contract.test.ts (from test/) | 9 pass, 0 fail, 28 assertions |
| root test/api-module-loading.test.ts (from test/) | 2 pass, 0 fail, 10 assertions |
| API: packages/engine `bun typecheck --project ../../tsconfig.json` | exit 0 |
| packages/web `bun typecheck` | 0 errors, 0 warnings, 411 hints |
| Full `bun turbo typecheck --concurrency=2` | exit 0, 27 of 27 tasks (25 cached) |

Committed as `feat(everywhere): add the Remote relay adapter for presence
and offers` (the brief's title, in place of the working title above); the
push and the run ids are recorded in "EV-09 push receipts" in the follow-up
docs commit.
