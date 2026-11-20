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
| F5, an engine test imports desktop | Accepted; deviation entry. *2026-11-17 (EV-18): the import surface grew with `everywhereSettings`, imported from desktop everywhere-settings.ts (core and schema only), so the engine compiles three desktop files; still open. 2026-11-20 (EV-19): packages/web test/everywhere-journey-laptop.test.ts also imports eight desktop files (the runner, offer, ledger, engine, git, settings, scan and github-api, no electron); deviations EV-19 (a). 2026-11-20 (EV-20): those imports moved into packages/web/test/lib/everywhere-journey.ts, which the Slack and the Linear and Jira journeys share (both journey files still import `unattendedRules` from everywhere-engine); the compiled desktop set is the same eight files* | packages/engine/test/everywhere/unattended-session.test.ts:9, :13 | done in EV-01; a later move of the pure settings and rules functions, or the client, into core/everywhere |
| F6, a second keep-awake owner | Closed by EV-18 (2026-11-17; CI pending) | At `dcb93939`: everywhere-awake.ts:2-13 called `start`/`stop` itself. Now everywhere-awake.ts holds keep-awake.ts `holdDesktopWork()` (:471), the same `desktopWork` set as `whileDesktopWorks` (:455) under the one blocker index.ts:640-651 sets (`setDesktopWorkBlocker`, :396); it takes no blocker id, and holds only while the link can deliver offers. "One owner" means keep-awake.ts: engine-session keep-awake (`startKeepAwake`, which also keeps an unattended job's own session awake) keeps its own `powerSaveBlocker` id through the same `blocker` object, unchanged, so while a job runs two ids can be held, each released by its own holder. Tests: everywhere-awake.test.ts A1 to A5 (:58, :95, :108, :136, :151), everywhere-wiring.test.ts W28 (:1725) and W29 (:1794); deviations log, "2026-11-17, EV-18", (k) | the package commit's SHA and its CI run ids (the next receipt; a commit cannot name itself) |
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

## EV-10: user config key `everywhere` (VE-40) (2026-11-15)

Base: HEAD `735d592b` (EV-09), equal to `origin/everywhere-finish`. `git fetch origin release-finish main everywhere-finish review-fixes` found:

- release-finish at `cf2373c4`, already merged here;
- main `58f85edc`, not merged (PR #33 is not in);
- review-fixes `1433d105`.

**Precondition not met on 2026-11-15** (met on 2026-11-16; see "EV-10, 2026-11-16" below). `git merge-base --is-ancestor ce91a261 HEAD` fails, and so does the same check against origin/release-finish: PUB-2 is only on review-fixes. The package was built anyway, at the user's request to finish quickly (deviations, EV-10 (k)), and is not committed. The commit waits for ce91a261 on release-finish, or for the lead's OK given the probe below.

**Merge probe.** A `git merge-tree` of the working tree, lane documents included (as a scratch commit from a temporary index; no ref moved and the real index untouched), was run against:

- clean: review-fixes `1433d105`, connect-finish `539ec394`, hands-finish `bca15854`, brain-transport `a89fe7a0`, scope-finish `14a4b60f`, workspaces-finish `7ecd64a1` and native-qualify `73651efe`;
- codium-finish `4bd146e7`: conflicts only in vector-codium.yml, packages/cloud/src/codium-ci-tests.ts and workflow-compliance.test.ts, exactly as HEAD already does.

The tree merged with review-fixes has the three "Not available in Vector 1.99.112 or earlier" descriptions (computer, connect, everywhere) in both core config.ts and config.json, and `$defs.EverywhereConfig`.

**Baselines before any edit.** packages/engine/script/schema.ts with fresh XDG roots (/tmp/vector-v2/everywhere-finish/ev10-xdg) wrote config.json and tui.json identical to packages/web/public (`cmp`).

Files (line numbers after EV-10):

- packages/core/src/v1/config/everywhere.ts (new, 76 lines): self-export (:1); `SEGMENT` and `DIRECTORY` (:14-19); `Project` `{directory, repository}`, strict (:23-30); `upTo` (:32); `Info`, strict (:34-62); `Defaults` (:66-76).
- packages/core/src/v1/config/config.ts: the import (:25); `everywhere:` after `watcher:` (:131-134).
- packages/engine/src/config/config.ts: `delete next.everywhere` with its comment (:96-98); `userSources` (:2125); the `dropped` entry (:2143-2145).
- packages/engine/src/server/routes/instance/httpapi/handlers/global.ts:129-132: the guest omit.
- packages/engine/src/server/routes/instance/httpapi/handlers/config.ts: imports (:8-10); the guest omit on GET (:36-41); the 400 on PATCH (:44-46).
- packages/engine/test/config/subagent-config.test.ts:280-289 (version skew).
- New packages/core/test/everywhere/config.test.ts and packages/engine/test/everywhere/config.test.ts.
- Regenerated:
  - packages/web/public/config.json, +117 lines, none removed;
  - packages/sdk/openapi.json (+73), packages/sdk/js/src/gen/types.gen.ts (+26) and packages/sdk/js/src/v2/gen/types.gen.ts (+26), additions only, the same after a second run, with no untracked output left;
  - unchanged: tui.json, workflow.json (packages/core/script/workflow-schema.ts) and packages/client (`bun run check:generated` exit 0).

**Tests.** Each file was run alone through /home/user/.tools/vector-serial with `--timeout 30000` and TMPDIR=/tmp/vector-v2/everywhere-finish/ev10-tmp.

- core:
  - test/everywhere/config.test.ts: 8 pass, 105 expects (re-run after prettier: see below).
  - test/config/computer.test.ts: 6 pass, 43 expects.
  - test/orchestration/schema-file.test.ts: 1 pass, 1 expect.
- engine:
  - test/everywhere/config.test.ts: 15 pass, 63 expects.
  - test/config/subagent-config.test.ts: 16 pass, 56 expects.
  - test/connect/config.test.ts: 3 pass, 7 expects.
  - test/compliance/generated-artifacts.test.ts: 2 pass, 9 expects (config.json and tui.json match the generator).
  - test/config/company-lock.test.ts: 11 pass, 61 expects.
  - test/server/auth-guest.test.ts: 28 pass, 271 expects.
  - test/server/httpapi-config-secrets.test.ts: 15 pass, 299 expects.
  - test/config/config.test.ts: 175 pass, 415 expects.
- web:
  - test/deployed-schemas.test.ts: 2 pass, 4 expects.
  - test/everywhere-lane.test.ts: 13 pass, 150 expects.
  - test/docs-config-reference.test.ts: 4 pass, 1 fail, 37 expects. The failure is pre-existing and independent of EV-10: "company computer policy samples decode and state their minimum engine version" expects "1.99.112" in the computer description (:46), which only review-fixes adds (deviations, EV-10 (l)).
- desktop: `bun --no-env-file test` src/main/config-skew.test.ts: 2 pass, 38 expects (unchanged).
- sdk/js: test/v1-schema.test.ts 1 pass, 2 expects; test/wire-compat.test.ts 10 pass, 24 expects.

**Mutations**, each restored from a copy afterwards:

- M1: the merge() drop line removed. Engine test: 4 fail (managed, VECTOR_CONFIG_CONTENT, custom directory, organization).
- M2: the guest omit on GET /global/config removed. 1 fail (the route case).
- M3: the PATCH /config refusal removed. 1 fail (the route case: expected 400, received 200).
- M4: the strict `parseOptions` removed from `Info`. Core test: 2 fail (unknown keys; the core loader case).

Formatting: `bun prettier --check` over the eight changed .ts files flagged the two new test files only. They were rewritten with `prettier --write`, and the re-run below is on the formatted files.

**After formatting:**

- Re-run: core test/everywhere/config.test.ts 8 pass, 105 expects; engine test/everywhere/config.test.ts 15 pass, 63 expects.
- Typechecks, one at a time: core (`tsgo --noEmit`) exit 0, engine exit 0, web (`astro check`) 0 errors and 0 warnings, sdk/js exit 0.
- `prettier --check` over the eight .ts files is clean.
- A second probe, taken after the lane documents were written, gives the same merge results as above.
- A re-fetch at the end found release-finish `cf2373c4`, review-fixes `1433d105` and everywhere-finish `735d592b` unchanged.

### EV-10, 2026-11-16: merge of release-finish and the finish

Lead ruling (2026-11-16): ce91a261 (PUB-2) is on origin/release-finish, whose head is `0f034957`. `git fetch origin release-finish main everywhere-finish` found release-finish `0f034957`, everywhere-finish `735d592b` (equal to HEAD) and main `58f85edc`, not merged. `git merge-base --is-ancestor ce91a261 origin/release-finish` succeeds.

1. **Saved first.** `git diff HEAD --binary` went to /tmp/vector-v2/everywhere/ev10-before-merge.patch (42,685 bytes). The three untracked files were copied, with their paths, into /tmp/vector-v2/everywhere/ev10-untracked/. No stash and no reset.
2. **Overlap.** Of the working tree's 16 changed or new files, three are also changed between the merge base `cf2373c4` and `0f034957`: docs/vector/build/vector-everywhere-spec.md (FIT-5), packages/core/src/v1/config/config.ts (PUB-2) and packages/web/public/config.json (PUB-2). Their hunks were saved again on their own (ev10-overlap.patch). `git merge-tree --write-tree HEAD origin/release-finish` was clean, and no untracked file exists on the incoming side.
3. **Merge.** Only those three files were restored to HEAD with `git checkout --`. Then `git merge --no-ff origin/release-finish`, as Vector with the rules' trailers: `5d8c5c8c` "chore(everywhere): merge PR #33 head 0f034957", with no conflicts (83 files from release-finish). Not pushed: the commit step pushes. No package.json or bun.lock changed, so no install was needed.
4. **Re-apply.** `git apply --3way` of ev10-overlap.patch applied cleanly to all three files. They were then unstaged with `git restore --staged`, so every EV-10 change stays in the working tree only. `git merge-base --is-ancestor ce91a261 HEAD` now succeeds.
5. **docs-config-reference.test.ts** (review-fixes' rewritten version): `everywhere` joins the loop at :51 (deviations, EV-10 (l)).

**Generators on the merged tree** (fresh XDG roots in /tmp/vector-v2/everywhere-finish/ev10m-xdg, output to /tmp/vector-v2/everywhere/ev10m/gen first):

- packages/engine/script/schema.ts: config.json is byte-identical to the working tree's (`cmp`). It has three "Not available in Vector 1.99.112 or earlier" descriptions (computer, connect, everywhere), and `$defs.EverywhereConfig` has ten properties and `additionalProperties: false`. tui.json is identical to HEAD's. config.json is still +117 lines against HEAD, with none removed.
- packages/core/script/workflow-schema.ts: workflow.json identical to HEAD's.
- ./packages/sdk/js/script/build.ts (from the repo root): packages/sdk/openapi.json and both types.gen.ts are byte-identical to the files generated before the merge, because the SDK does not embed top-level config descriptions. `git status --porcelain --untracked-files=all packages/sdk` shows only those three files. dist is ignored, and the build leaves no packages/sdk/js/openapi*.json.
- packages/client `bun run check:generated`: exit 0.

**Tests on the merged tree.** Each file was run alone through /home/user/.tools/vector-serial with `--timeout 30000` and TMPDIR=/tmp/vector-v2/everywhere-finish/ev10m-tmp.

- The package's own files:
  - core test/everywhere/config.test.ts: 8 pass, 105 expects.
  - engine test/everywhere/config.test.ts: 15 pass, 63 expects.
  - web test/docs-config-reference.test.ts: 6 pass, 0 fail, 42 expects. That is review-fixes' version plus the `everywhere` case; before the merge, the old file failed independently of EV-10.
- engine:
  - test/config/subagent-config.test.ts: 16 pass, 56 expects.
  - test/compliance/generated-artifacts.test.ts: 2 pass, 9 expects.
  - test/connect/config.test.ts: 3 pass, 7 expects.
  - test/config/company-lock.test.ts: 11 pass, 61 expects.
  - test/server/auth-guest.test.ts: 28 pass, 271 expects.
  - test/server/httpapi-config-secrets.test.ts: 15 pass, 299 expects.
  - test/config/config.test.ts: 175 pass, 415 expects.
- core:
  - test/config/computer.test.ts: 6 pass, 43 expects.
  - test/orchestration/schema-file.test.ts: 1 pass, 1 expect.
  - test/connect/flag.test.ts (new from the merge): 2 pass, 7 expects.
- web:
  - test/deployed-schemas.test.ts: 2 pass, 4 expects.
  - test/everywhere-lane.test.ts: 13 pass, 148 expects. That is 2 fewer than before the merge, because FIT-4 (review-fixes) removed the dead push triggers this test used to check. It is not EV-10's change.
- desktop: `bun --no-env-file test` src/main/config-skew.test.ts: 2 pass, 38 expects.
- sdk/js: test/v1-schema.test.ts 1 pass, 2 expects; test/wire-compat.test.ts 10 pass, 24 expects.

**Typechecks**, one at a time on the merged tree:

- core (`tsgo --noEmit`): exit 0.
- engine: exit 0.
- web (`astro check`): 292 files, 0 errors, 0 warnings.
- sdk/js (`tsgo --noEmit` and the test project): exit 0.

**Other checks:**

- `bun prettier --check` over the nine changed .ts files (the eight above plus docs-config-reference.test.ts) is clean.
- The lane-document additions name no home folder except the generic `/home/user/` that test/no-personal-paths.test.ts (new from the merge) allows.

**Cross-lane probe, re-run.** A scratch commit of the working tree on `5d8c5c8c`, built from a temporary index (no ref moved, real index untouched), was probed with `git merge-tree --write-tree` against each lane's tip:

- clean: review-fixes `1433d105`, connect-finish `3f866f30`, hands-finish `289af6bb`, scope-finish `bf25e8c5`, brain-transport `09a6387a`, workspaces-finish `098b5a1c` and native-qualify `9b0623ae`;
- codium-finish `bd3cc7ad`: conflicts in .env.example, .github/workflows/vector-codium.yml, packages/cloud/src/codium-ci-tests.ts and packages/cloud/src/workflow-compliance.test.ts. HEAD alone gives exactly the same four, so none of them is EV-10's.

**Not done here** (the brief for this step says not to commit):

- the full `bun turbo typecheck` (run before the push);
- the EV-10 commit, the push of `5d8c5c8c` plus that commit, and the CI dispatches (vector-everywhere.yml and typecheck.yml on everywhere-finish).

Planned commit title: `feat(core): add the everywhere user config key`. The body names the regenerated files and their generators: config.json from packages/engine/script/schema.ts, and the SDK's openapi.json and both types.gen.ts from ./packages/sdk/js/script/build.ts. It also names the unchanged generated files (tui.json, workflow.json and packages/client/src/generated*) and notes that the SDK files will need the one regeneration v2-complete-plan §2 reserves after all lanes merge.

### EV-10, 2026-11-16: review fixes (round one)

Ten findings, one blocking; all taken (deviations, EV-10 (o)). Still uncommitted, on HEAD `5d8c5c8c`. `git fetch` found release-finish `0f034957` and everywhere-finish `735d592b`, both unchanged, so no merge was needed.

**Code** (line numbers after this round):

- Blocking, the company policy loop: packages/engine/src/config/config.ts now omits `["local", ...userOnly]` (:2377), where it omitted only `local`. `userOnly = ["everywhere"] as const` (:2128) sits beside `userSources` (:2125). merge() takes its drop from the same list (:2146).
- packages/core/src/config/managed.ts: the test-only `useTestPolicies` (:151-157), used by read() (:189) while a test directory is set.
- packages/core/src/v1/config/everywhere.ts: a drive-letter path keeps one separator throughout (DIRECTORY, :20-22). The comment (:16-19) now says that case and links are not normalized. 79 lines.
- handlers/config.ts:44-48: a comment on why the PATCH /config 400 has no body.

**Tests:**

- packages/engine/test/everywhere/config.test.ts:
  - the policy loop, without and beside a user block, through `ConfigManaged.useTestPolicies` (one MDM and one policy-key entry);
  - a company lock on `everywhere`: Config.get() has no block, getGlobal() returns the user's, and Config.lockedKeys() lists it. Vector Local is restored afterwards, as company-lock.test.ts does;
  - the desktop's own folder as a user source (VECTOR_CLIENT=desktop, VECTOR_AGENT_CONFIG_DIR outside the repository);
  - `C:\a/b` refused by the engine's parser;
  - the parser case uses `expect(...).toThrow(expect.objectContaining(...))` in place of a try/catch. Environment variables are restored through `setEnv` (an early return, no `else`).
- packages/core/test/everywhere/config.test.ts: `C:\a/b` and `D:/a\b` refused, and the duplicate case's comment reworded.

**Generators:**

- packages/engine/script/schema.ts, with fresh XDG roots in /tmp/vector-v2/everywhere-finish/ev10r-xdg (to /tmp/vector-v2/everywhere/ev10r/gen first, then in place, byte-identical): config.json changes only in `$defs.EverywhereProject.properties.directory`'s pattern. It is still +117 lines against HEAD, none removed. tui.json is unchanged.
- ./packages/sdk/js/script/build.ts: packages/sdk/openapi.json changes only in the same pattern line (+73 against HEAD). Both types.gen.ts are identical to the pre-merge run's (their diffs hash the same as ev10-before-merge.patch's). No untracked output is left.
- packages/client `bun run check:generated`: exit 0.

**Tests run**, each file alone through /home/user/.tools/vector-serial with `--timeout 30000`:

- The package's own files:
  - core test/everywhere/config.test.ts: 8 pass, 107 expects;
  - engine test/everywhere/config.test.ts: 19 pass, 68 expects.
- engine:
  - test/compliance/generated-artifacts.test.ts: 2 pass, 9 expects;
  - test/config/subagent-config.test.ts: 16 pass, 56 expects;
  - test/config/company-lock.test.ts: 11 pass, 61 expects;
  - test/config/local-policy.test.ts: 68 pass, 393 expects;
  - test/config/company-certificates.test.ts: 1 pass, 4 expects;
  - test/server/auth-guest.test.ts: 28 pass, 271 expects;
  - test/server/httpapi-config-secrets.test.ts: 15 pass, 299 expects;
  - test/config/config.test.ts: 175 pass, 415 expects;
  - test/connect/config.test.ts: 3 pass, 7 expects.
- core: test/config/managed.test.ts 3 pass, 19 expects; test/config/computer.test.ts 6 pass, 43 expects.
- web: test/docs-config-reference.test.ts 6 pass, 42 expects; test/deployed-schemas.test.ts 2 pass, 4 expects; test/everywhere-lane.test.ts 13 pass, 148 expects.
- sdk/js: test/v1-schema.test.ts 1 pass, 2 expects; test/wire-compat.test.ts 10 pass, 24 expects.
- desktop: `bun --no-env-file test` src/main/config-skew.test.ts: 2 pass, 38 expects.
- Root-only failures, not EV-10's: engine test/config/managed-trust.test.ts (25 pass, 1 fail: "POSIX ownership > checks the real file and every folder above it") and core test/local-mode/startup.test.ts (15 pass, 3 fail: the three "a standard user could have written" cases). This container runs as uid 0, so a file the test writes is root's and counts as trusted. With HEAD's managed.ts put back (then restored, `cmp` checked), the same four fail.

**Mutations**, each restored from a copy afterwards (`cmp` checked):

- M5: the policy loop back to `omit(next, ["local"])`. Engine test: 2 fail (both policy cases).
- M1, re-run: the merge() drop entry removed. 5 fail (managed file, the lock case, VECTOR_CONFIG_CONTENT, custom directory, organization).
- M6: `userSources` without `localConfig.user`. 1 fail (the desktop folder case).
- M7: the drive-letter branch back to `[\\/]`. Core test: 1 fail (the projects case, on `C:\a/b`).

**Typechecks**, one at a time: core exit 0; engine exit 0; web (`astro check`) 0 errors, 0 warnings; sdk/js exit 0. `bun prettier --check` over the ten changed .ts files is clean.

**Cross-lane probe** (a scratch commit of the working tree on `5d8c5c8c` from a temporary index; no ref moved, real index untouched), with `git merge-tree --write-tree` against each tip:

- clean: review-fixes `1433d105`, connect-finish `3f866f30`, hands-finish `289af6bb`, scope-finish `f11f8b35`, brain-transport `09a6387a`, workspaces-finish `098b5a1c` and native-qualify `9b0623ae`;
- codium-finish `bd3cc7ad`: the same four conflicts that HEAD alone has (.env.example, vector-codium.yml, codium-ci-tests.ts, workflow-compliance.test.ts).
- No other lane's tip changes engine config.ts, core config/managed.ts, the two handlers, core v1 config.ts or config.json against origin/release-finish. connect-finish changes packages/sdk/openapi.json, which is resolved by regenerating.

**For the commit and push** (not done here):

- The commit body also names the four shared files outside the §6.5 anchors and the reason (deviations, EV-10 (n)): engine config.ts merge() and the policy loop, handlers/config.ts, handlers/global.ts and core config/managed.ts.
- Before the push, the lead confirms the §6.5 exception.
- The regenerated files stay as listed above: config.json, openapi.json and both types.gen.ts.

### EV-10, 2026-11-16: commit gate

`git fetch origin release-finish main everywhere-finish` found release-finish `0f034957` (in HEAD), everywhere-finish `735d592b` (an ancestor of HEAD) and main `58f85edc` (not merged, as the lane rules say). `git merge-base --is-ancestor ce91a261 HEAD` succeeds. The working tree held only EV-10's 18 files.

Re-run, each file alone through /home/user/.tools/vector-serial with `--timeout 30000` and TMPDIR=/tmp/vector-v2/everywhere/ev10-gate-tmp:

- core: test/everywhere/config.test.ts 8 pass, 107 expects; test/config/managed.test.ts 3 pass, 19 expects.
- engine: test/everywhere/config.test.ts 19 pass, 68 expects; test/config/subagent-config.test.ts 16 pass, 56 expects; test/compliance/generated-artifacts.test.ts 2 pass, 9 expects; test/server/auth-guest.test.ts 28 pass, 271 expects; test/server/httpapi-config-secrets.test.ts 15 pass, 299 expects; test/config/company-lock.test.ts 11 pass, 61 expects.
- web: test/docs-config-reference.test.ts 6 pass, 42 expects.

Generators: ./packages/sdk/js/script/build.ts, re-run with fresh XDG roots in /tmp/vector-v2/everywhere-finish/ev10-gate-xdg, left openapi.json and both types.gen.ts byte-identical (sha256 checked) and no untracked output. packages/client `bun run check:generated`: exit 0.

Typechecks: core, engine, web (`astro check`, 0 errors, 0 warnings) and sdk/js, each exit 0. The full `bun turbo typecheck --concurrency=2`: 27 of 27 tasks successful.

The push and the CI run ids go in the next lane docs commit.

## EV-11: Remote link carries job offers (2026-11-16)

Package EV-11 (R-C2, link side): the Remote link connects for a jobs subscriber and hands it `0x02` job offer frames. Decisions and deviations: vector-everywhere-deviations.md, "2026-11-16, EV-11". Built in the working tree and committed at the commit gate below.

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `7146a98f` equals origin/everywhere-finish; origin/release-finish `0f034957` and origin/main `58f85edc` are both ancestors of HEAD (main through release-finish), so nothing was merged. `git merge-base --is-ancestor 411317d8 HEAD` (EV-06's frame) succeeds. No review-fixes or brain-transport precondition. Against the merge base with origin/release-finish, origin/codium-finish `bd3cc7ad` changes only remote-link.test.ts among the touched files (B09, one test inside "paired phones", +35); origin/review-fixes `1433d105` changes none of them. At the end of the package origin/release-finish had moved to `b0752dda` (nine commits after `0f034957`: engine and core test fixes, a web test and one api fix). None touches a file this package changes, and `git merge-tree` of the probe commit below with `b0752dda` is clean. It was not merged here, because merging makes a commit; the lane rule (merge release-finish when it moved) applies at the commit step, before the push.

**Files** (line numbers after the change):

- packages/desktop/src/main/remote-link.ts (954 lines, +84/-14): header (:38-43); `JOBS_REFRESH_MS`, `OFFER_BYTES`, `OFFER_PREFIX` (:57-61); `jobs?` (:141-148); `timing.jobsRefreshMs` (:160, default :167-174); `jobsRefresher` state (:188); control() (:539-542); syncRefresher (:547-569); `phonesWanted`, `jobsWanted`, `jobsOnly`, `wanted` (:627-640); onData's offer branch (:725); `offered()` (:730-744); teardown (:751, :755); evaluate's `syncRefresher()` (:827-828); `jobsChanged` (:851-852).
- packages/desktop/src/main/remote-relay.fixture.ts (+11/-2): `DEVICE_BYTES` import, header line, `offer(text)`.
- packages/desktop/src/main/remote-link.test.ts (+392/-5): imports; `setup()` options `jobs`, `log`, `timing` (:110-165); `describe("jobs (R-C2)")` (:326-699) with nine tests:
  - J1 "an offer frame reaches the subscriber unchanged on a computer connected only for jobs" (memory relay);
  - J2 "want() with no phone opens a computer connection and keeps it" (memory relay);
  - J3 "want() turning false closes the connection, and turning true opens it again" (memory relay);
  - J4 "over a simulated day, a job-only computer sends only heartbeats and refreshes at most twice" (memory relay, production timing, Bun fake timers stepped hourly);
  - J5 "a phone paired later restores the phone's cadence, and the jobs cadence returns without it" (FakeSocket and fakePhone; covers the takeover refresh, the no-double refresh, evaluate()'s cadence change on startPairing and on unpair, and want(false) with a paired phone);
  - J6 "a malformed offer frame is dropped, and so is any offer with no subscriber; neither throws" (16 malformed frames, the longest valid offer, and a link with no subscriber);
  - J7 "a subscriber that throws or rejects is contained, and the log line holds no offer";
  - J8 "jobs alone never turn Remote on or make an identity";
  - J9 "want() decides only the connection: an offer on a phone's connection reaches the subscriber".
- Lane docs: this entry; vector-everywhere-deviations.md (the EV-11 entry); vector-everywhere-spec.md (five dated notes: §2 after EV-09's, E9, §6.3's Codium Remote row, VE-21, R-C2); vector-everywhere-handoff.md (annotations on the EV-06 and EV-09 bullets, an EV-11 bullet, two "Left open" items).
- No generated file, workflow, dependency, lockfile, env var or route changed.

**Checks**, each through /home/user/.tools/vector-serial, one file at a time from packages/desktop with `bun --no-env-file test --timeout 30000`:

| Check | Before | After |
| --- | --- | --- |
| src/main/remote-link.test.ts | 19 pass, 0 fail, 94 expects | 28 pass, 0 fail, 167 expects (nine new tests) |
| src/main/remote-phone-app.test.ts (the fixture's other user) | 15 pass, 79 expects (planning baseline) | 15 pass, 0 fail, 79 expects |
| src/main/remote-crypto.test.ts | | 15 pass, 0 fail, 58 expects |
| src/main/remote-notify.test.ts | | 6 pass, 0 fail, 32 expects |
| src/main/remote-routes.test.ts | | 15 pass, 0 fail, 116 expects |
| remote-link.test.ts, five runs in a row after the change | | 28 pass, 0 fail, 167 expects each time |
| `cd packages/desktop && bun typecheck` (`tsgo -b`; it excludes `src/**/*.test.ts`, covers the fixture) | | exit 0 |
| The test file itself: `tsgo --noEmit -p` a scratch tsconfig in /tmp/vector-v2/everywhere/ev11/tc extending desktop's, `types: ["bun"]`, app's `@/*` path | | exit 0 |
| `bun prettier --check` on the three code files | | clean |
| No line over 120 columns in the three code files | | none |
| `git diff` of remote-link.test.ts | | removes only the three import lines, `setup()`'s signature line and its `timing` line it replaces; no line inside an existing test |
| No personal path or email in the diff | | none (`git diff \| grep` for /home/, /root/, @ addresses other than the bot's: none) |

**Cross-lane probe.** A scratch commit `f19ba6ee` of the working tree on HEAD, built from a copy of the index (no ref moved, the real index untouched), then `git merge-tree --write-tree` against each tip: clean with review-fixes `1433d105`, connect-finish `6cff8020`, hands-finish `272ccb6d`, brain-transport `1d36447e`, scope-finish `f11f8b35`, workspaces-finish `098b5a1c` and native-qualify `9b0623ae`. codium-finish `bd3cc7ad`: remote-link.test.ts auto-merges with B09; the only conflicts are the four HEAD alone already has (.env.example, vector-codium.yml, codium-ci-tests.ts, workflow-compliance.test.ts).

**Mutations** (/tmp/vector-v2/everywhere/ev11-mut/: mutations.py, run.py, results.txt). Each was applied to remote-link.ts alone, remote-link.test.ts was run alone, and the file was restored from remote-link.post.ts with its sha256 checked against post.sha after every run:

| Mutation | Result | Red tests |
| --- | --- | --- |
| M1 `wanted()` ignores jobs | 8 fail | J1-J8 (J9 connects for a pairing and stays green) |
| M2 no zero-device check | 1 fail | J6 |
| M3a no `vef1.` prefix check | 1 fail | J6 |
| M3b no visible-ASCII check | 1 fail | J6 |
| M4 no length bound | 1 fail | J6 |
| M5 the phone cadence ignores `jobsOnly()` | 2 fail | J4, J5 |
| M6 `peers.refresh` refreshes a job-only link | 2 fail | J4, J5 |
| M7 no jobs refresher | 2 fail | J4, J5 (no jobs timer, so no takeover refresh either) |
| M8 `evaluate()` does not call `syncRefresher()` | 1 fail | J5 (startPairing and unpair change the cadence with no server message) |
| M9 `offer()` called inline, no hand-off | 1 fail | J7 |
| M9b hand-off without the catch | 1 fail | J7 |
| M10 offers only while `want()` | 1 fail | J9 |
| M11 `jobsChanged()` makes an identity | 1 fail | J8 |
| M12 no takeover refresh | 1 fail | J5 |
| M13 the takeover refresh ignores control()'s | 1 fail | J5 (two refreshes for one `peers.refresh`) |
| M14 teardown keeps the jobs refresher | survives (28 pass) | none: recorded, not hidden. After a close the old timer keeps calling `refresh()`, which returns without a socket, and on reconnect it is reused instead of restarted, so the cadence counts from the first connection. No test observes it |
| M15 the jobs cadence ignores `online` | survives (28 pass) | none: recorded. The timer would start while the socket is still opening; `refresh()` refuses a socket that is not open, and teardown clears it |

**Not done here (the task said not to commit):** the commit (`feat(desktop): carry job offers on the Remote link for a jobs subscriber`, staging the three code files and the four lane docs by path, the body naming them and saying no generated file changed), the full `bun turbo typecheck --concurrency=2`, the push, and the workflow_dispatch runs of vector-hosted-ci.yml (only while no vector-codium run is in progress) and typecheck.yml on everywhere-finish. Their run ids go in the next entry. Never vector-codium.yml before PR #33 is on main.

### EV-11, 2026-11-16: review fixes (round one)

Seven findings, none blocking. All taken; the one on offers while `want()` is false is kept as built and recorded (deviations, EV-11 (b), (d2), (h), (j), (l)). Still uncommitted, on HEAD `7146a98f`. `git fetch origin release-finish main everywhere-finish` found everywhere-finish `7146a98f` (HEAD), main `58f85edc` (an ancestor) and release-finish `b0752dda`, nine commits past the `0f034957` in HEAD and touching no file of this package, as the package receipt above says. It is merged at the commit step, not here.

**Code** (line numbers after this round; remote-link.ts is 972 lines):

- packages/desktop/src/main/remote-link.ts:
  - `OFFERS_IN_FLIGHT = 8` (:62-63) and the state's `offering` count (:202, :216). `offered()` (:742-762) drops a well-formed frame while eight offers are unsettled, counts the offer before handing it on, and releases it in a `finally` after the existing `catch`.
  - `jobsWanted()` (:636-644) answers false when the subscriber's `want()` throws.
  - The `jobs` JSDoc (:143-149) says both.
- packages/desktop/src/main/remote-link.test.ts (1,189 lines; the jobs block is :326-867):
  - J4, the simulated day, stops the link in its `finally`, before `jest.useRealTimers()`.
  - Four new tests:
    - J10 "the jobs cadence counts from each connection, and a close, want(false) or stop() ends it" (memory relay, production timing, fake timers stepped hourly; after J4). The relay closes the connection `TICKET_EXPIRED` at 11 h and the link reconnects after its 2-s backoff. The next refresh comes 12 h after the new mint, with none at the first connection's 12 h. `want(false)` closes, six hours pass with no mint, and `want(true)` reopens, with the first refresh again 12 h after its own mint. After `stop()`, `jest.getTimerCount()` is 0, and over a further day nothing is minted or sent.
    - J11 "the jobs cadence starts only once the relay's hello arrives" (FakeSocket, `jobsRefreshMs` 40). With the socket unopened for 150 ms, one ticket was minted (the connect), and the status is `connecting`. Once it opens, the jobs refresh follows.
    - J12 "a want() that throws counts as not wanted, and the phone's path keeps working" (before J9). Turning Remote on with a throwing `want()` and no phone opens nothing and reads `ready`; a pairing connects; a phone's `peers.refresh` is answered; a dropped connection is retried.
    - J13 "at most eight offers wait on the subscriber at once; more are dropped until one settles" (before J9). Of twelve well-formed offers, the first eight reach the subscriber. One rejection (logged with the fixed line) and one resolution free two places: of three more offers, two reach it.
- Lane docs: the deviations entry's line numbers, (b), (d2), (h), (j), (l) and its mutation table; the handoff's EV-11 bullet and two "Left open" items; this receipt.

**Checks**, each through /home/user/.tools/vector-serial, one file at a time from packages/desktop with `bun --no-env-file test --timeout 30000`:

| Check | Before this round | After |
| --- | --- | --- |
| src/main/remote-link.test.ts | 28 pass, 0 fail, 167 expects | 32 pass, 0 fail, 196 expects (four new tests), and the same in each of three more runs in a row |
| src/main/remote-phone-app.test.ts (the fixture's other user; the fixture is unchanged this round) | 15 pass, 79 expects | 15 pass, 0 fail, 79 expects |
| src/main/remote-crypto.test.ts, remote-notify.test.ts, remote-routes.test.ts | 15/58, 6/32, 15/116 | 15 pass 58 expects, 6 pass 32 expects, 15 pass 116 expects; 0 fail each |
| `cd packages/desktop && bun typecheck` (`tsgo -b`) | exit 0 | exit 0 |
| The test file itself: `bun x tsgo --noEmit -p /tmp/vector-v2/everywhere/ev11/tc/tsconfig.json` (as in the package receipt) | exit 0 | exit 0 (`jest.getTimerCount` is typed in bun-types) |
| `bun prettier --check` on remote-link.ts, remote-link.test.ts and remote-relay.fixture.ts | clean | clean (prettier wrapped two `until(...)` lines of the new tests) |
| No added line over 120 columns in the three code files | none | none |

**Mutations** (/tmp/vector-v2/everywhere/ev11-fix/mut/: mutations.py, run.py, results.txt). All twenty-two (the first run's seventeen, M9 and M9b re-anchored on the new chain, plus M14b and M16-M19) were applied to remote-link.ts one at a time with remote-link.test.ts run alone; the file was restored from remote-link.post.ts after each run, and its sha256 matched post.sha (`03b3e364…`) at the end. None survives:

- M1 11 fail (J1-J8, J10, J11, J13); M2, M3a, M3b, M4 1 fail each (J6); M5 and M6 2 fail each (J4, J5); M7 4 fail (J4, J5, J10, J11); M8 1 fail (J5); M9 and M9b 2 fail each (J7, J13); M10 1 fail (J9); M11 1 fail (J8); M12 and M13 1 fail each (J5).
- M14 (teardown keeps the timer running) and M14b (keeps it and its handle): 1 fail each, J10. Both survived before.
- M15 (the jobs cadence ignores `online`): 1 fail, J11. Survived before.
- M16 (a throwing `want()` not caught): 1 fail, J12.
- M17 (no cap), M18 (no `finally`, so a settled offer keeps its place) and M19 (`>` for `>=`): 1 fail each, J13.

**Cross-lane check.** The other lanes' tips are the package receipt's (codium-finish `bd3cc7ad`, review-fixes `1433d105`, connect-finish `6cff8020`, hands-finish `272ccb6d`, brain-transport `1d36447e`, scope-finish `f11f8b35`, workspaces-finish `098b5a1c`, native-qualify `9b0623ae`). This round adds nothing to remote-link.test.ts outside the jobs block, so B09's test inside "paired phones" (now after :1069) still merges as the probe showed. origin/release-finish `b0752dda` touches no file under packages/desktop or the lane documents since the merge base.

**Not done here (the task said not to commit):** as in the package receipt above. The commit stages the same seven paths. Its body adds that review round one capped offers in flight at eight and made a throwing `want()` count as false, and that no generated file changed.

### EV-11, 2026-11-16: commit gate

Committed as `feat(desktop): let the Remote link carry job offers for a jobs subscriber`, on HEAD `7146a98f` (origin/everywhere-finish), staging the seven paths named above by path: remote-link.ts, remote-link.test.ts, remote-relay.fixture.ts and the four lane documents. No generated file, workflow, dependency, lockfile, env var or route changed.

Re-run at the gate, each through /home/user/.tools/vector-serial, one file at a time from packages/desktop with `bun --no-env-file test --timeout 30000`:

| Check | Result |
| --- | --- |
| src/main/remote-link.test.ts | 32 pass, 0 fail, 196 expects |
| src/main/remote-phone-app.test.ts (the fixture's other user) | 15 pass, 0 fail, 79 expects |
| `cd packages/desktop && bun typecheck` (`tsgo -b`) | exit 0 |
| The test file itself: `bun x tsgo --noEmit -p /tmp/vector-v2/everywhere/ev11/tc/tsconfig.json` | exit 0 |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | 27 of 27 tasks successful, exit 0 |

origin/release-finish had moved to `67ec3a60` (fourteen commits past the `0f034957` in HEAD: engine, core, api, web and root test fixes, a desktop packet-capture script, vector-at-mention.yml and docs/vector/local-packet-capture.md). None touches a file this package changes. It is merged after this commit with a merge commit, before the push, as the lane rule says; the merge, the push and the CI run ids go in the next lane docs commit. vector-codium.yml is still not dispatched before PR #33 is on main.

## EV-12: safe unattended worktree service (2026-11-16)

Package EV-12 (vector-everywhere-main-requests.md, "Safe unattended worktree creation"; E5, E7): the engine's `Worktree.createUnattended`, with no route. Decisions and deviations: vector-everywhere-deviations.md, "2026-11-16, EV-12". Built in the working tree, then committed at the lane's commit gate ("Commit gate" below).

**Base.** `git fetch origin release-finish main everywhere-finish scope-finish`: HEAD `d31d418f` equals origin/everywhere-finish and already holds origin/release-finish `67ec3a60` (merge `e846cef3`), so nothing was merged. main was not merged (the lane rule: the lead merges main once PR #33 is on it). No review-fixes or brain-transport precondition applies. origin/scope-finish `1f5d62ad` and the other lanes' tips (review-fixes `1433d105`, codium-finish `c8696605`, connect-finish `34cf53cd`, hands-finish `ef9f809d`, brain-transport `569d1643`, workspaces-finish `e37ec1b5`, native-qualify `47db73cd`) change none of this package's files since their merge bases.

**Files:**

- packages/core/src/everywhere/git.ts (new, 89 lines): `EverywhereGit`; `safeRepositoryConfig`, `GIT_HARDENING`, `runnerGitEnvironment` moved from desktop; new `fetchRef(jid)`.
- packages/desktop/src/main/everywhere-git.ts (+4/-39): imports and re-exports the moved names; `fetch()` uses `fetchRef`.
- packages/engine/src/worktree/index.ts (+195/-1, 953 lines): imports (:22-25), `UnattendedInput`/`Unattended` (:55-69), `UNATTENDED_FLAGS`/`UNATTENDED_TIMEOUT`/`UNATTENDED_OUTPUT_BYTES` (:123-142), `Interface.createUnattended` (:171-178), the implementation (:431-565), `Service.of` (:933-943, wrapped by prettier).
- packages/engine/test/everywhere/worktree.test.ts (new, 537 lines), eight tests:
  - U1 "creates the job's branch at the exact base and registers its sandbox, running no hook, start script or other program" (:179): a positive control first (plain `git branch` in the repository fires the committed `.husky/reference-transaction` hook); then the result equals `{realpath(<data>/everywhere-worktree/<project>/<jid>), branch, base}`, `a.txt` is the base's, HEAD is the base on the job's branch, no hook or start-script marker, `.git/config`'s sha256 unchanged, the sandbox registered, no instance loaded, no Ready or Failed event; every command marked as createUnattended's is git with the hardening prefix, `protocol.allow=never` and all six `protocol.<name>.allow=never` pins, `extendEnv: false` and exactly the runner's environment keys plus `GIT_NO_LAZY_FETCH`, the marked set includes `worktree add` and `reset`, and no other command ran in the new folder; a Jira-shaped branch (`vector/ve-ABC-12-<8>`) is accepted.
  - U2 "refuses an existing branch, folder or link, and a folder reserved after the check, before creating anything" (:252): the project's job folder a link out of the data folder (nothing written to the target); an existing branch (no folder made); an empty folder (no branch made); a link at the job's path (its target untouched); a folder made by "another process" between the absence check and the exclusive mkdir (the recorder makes it when createUnattended's `show-ref` runs: refused, the folder stays empty, no `worktree` command ran); a second jid with the same last twelve characters after the first job's create (refused, no folder).
  - U3 "refuses a base that is unknown, moved, not a commit or not this job's fetched commit" (:331): no fetch ref; the fetch ref at another commit; a base this repository lacks; a fetch ref (a loose ref file) naming a commit it lacks; an annotated tag as base and fetch ref; then a 12-hex abbreviation, uppercase hex, `HEAD`, `--orphan`, a trailing newline and an empty base. Each leaves no branch and no folder.
  - U4 "refuses malformed ids, branches that are not the job's, and a directory other than the loaded checkout" (:375): `vector/subagent/x`, another job's `vector/ve-<12>`, `main`, `vector/ve-../x`, `vej_short`, a relative path, a subfolder, another repository, a `core.worktree` redirect, and an unattended worktree loaded as its own project folder seeding another.
  - U5 "refuses executable repository configuration in either scope before creating anything" (:415): a local `filter.mark.smudge` with `*.txt filter=mark` committed (positive control: plain `git cat-file --filters` runs it; createUnattended refuses and the filter never runs), a local `include.path`, and `url.<x>.insteadOf` in config.worktree with `extensions.worktreeConfig`.
  - U6 "two concurrent creates of one reservation give exactly one success" (:459): one success, one CreateFailedError whose message is the reservation refusal (so the loser never reached `worktree add`), `.git/worktrees` holding only the jid's entry, the folder listed once by `git worktree list`, the branch once.
  - U7 "refuses a project that is not Git" (:489).
  - U8 "keeps the reservation when git fails after it, so the job id is never reused" (:500; review round one): the recorder writes the job's branch as a loose ref when createUnattended's `worktree add` starts, so that command fails after the mkdir; the message is the "reservation is kept" one, the folder stays empty and is not a sandbox; with the branch deleted again, a second create with the same input is refused as reserved, runs no `worktree` command, and leaves no branch.
- Lane docs: vector-everywhere-deviations.md (the EV-12 entry), this receipt, vector-everywhere-main-requests.md (status line), vector-everywhere-handoff.md (an annotation on the "Current gates" safe-worktree bullet, an EV-12 bullet, a "Left open" item), vector-everywhere-spec.md (dated notes on §3.5 step 4 and §6.4).
- No generated file, route, workflow, flag, env var, dependency or lockfile changed.

**Checks**, each through the lane's `vector-serial` lock, one file at a time from the owning package, engine tests with `TMPDIR=/tmp/vector-v2/everywhere-finish/ev12/tmp` (so the preload's XDG roots, the fixture repositories and the markers live there):

| Check | Before | After |
| --- | --- | --- |
| packages/engine test/everywhere/worktree.test.ts | (new) | 7 pass, 0 fail, 218 expects; then three runs in a row after the mutations, the same each time (8.9 s, 9.0 s, 9.9 s), and once more after the last comment-only edits |
| packages/engine test/worktree/create-for-task.test.ts | | 5 pass, 0 fail, 38 expects |
| packages/engine test/project/worktree.test.ts | | 14 pass, 0 fail, 34 expects |
| packages/engine test/project/worktree-remove.test.ts | | 2 pass, 2 skip (Windows-only cases), 0 fail, 9 expects |
| packages/engine test/compliance/egress-inventory.test.ts (reads worktree/index.ts; no lane workflow runs it) | | 5 pass, 0 fail, 12 expects |
| packages/desktop src/main/everywhere-git.test.ts, `--no-env-file` | 8 pass, 0 fail, 88 expects (HEAD's everywhere-git.ts swapped in, then the change restored and its sha256 checked) | 8 pass, 0 fail, 88 expects |
| packages/desktop src/main/everywhere-runner.test.ts, `--no-env-file` | 49 pass, 355 expects (EV-03's receipt) | 49 pass, 0 fail, 355 expects |
| `bun typecheck` in packages/core, packages/engine (includes the test file) and packages/desktop (`tsgo -b`) | | exit 0 each |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | | 27 of 27 tasks successful, exit 0 |
| `bun prettier --check` on core everywhere/git.ts, engine worktree/index.ts and the test file | index.ts conforming at HEAD | all three conforming |
| desktop everywhere-git.ts and prettier | non-conforming at HEAD (hand-packed lines) | still non-conforming, not reformatted; prettier's output of HEAD's file and of the changed file differ by exactly the four added lines, so the hunk adds no violation |
| Lines over 120 columns added | | none in code except the two allowlist regex strings moved verbatim from desktop (core git.ts :24, :31) and one test name (:180) |
| `git diff` scan for personal paths and email addresses | | none |

**Mutations** (/tmp/vector-v2/everywhere/ev12-mut/: mutations.py, run.py, results.txt, one log per mutation). Each was applied to packages/engine/src/worktree/index.ts alone, test/everywhere/worktree.test.ts was run alone, and the file was restored from index.post.ts with its sha256 checked against post.sha after every run. The table is in the deviations entry. A first run against an earlier build (absence check after `show-ref`) found M5 surviving (first-run/); the order was fixed and every mutation was re-run against the final file.

**Review round one (2026-11-16; ten non-blocking findings, none blocking).** Code: `UNATTENDED_FLAGS` also pins `protocol.{git,http,https,ssh}.allow=never` (index.ts :123-138); the interface comment says the caller must not load an instance for a folder outside the allowlist (:176); core everywhere/git.ts's header says Node-only instead of "pure and runtime-neutral" (:11-12). Tests: U1 asserts all six per-protocol pins; U6 asserts the loser's message is the reservation refusal and that `.git/worktrees` holds one entry; new U8 (fail closed after the reservation). Docs: deviations (b), (e), (f), (h), (m), "Left open", "Coordination" and the mutations paragraph and table; the handoff's EV-12 bullet and "Left open" item (now joined to the list, with the instance-resolution sentence); main-requests.md's status line. Not changed in code: the move to core (b) waits for the lead; trust and the allowlist stay EV-13's, with a request to the lead to add them to EV-13's scope ((h) says why a trust predicate was not added).

| Check (after the review fixes) | Result |
| --- | --- |
| packages/engine test/everywhere/worktree.test.ts | 8 pass, 0 fail, 295 expects (10.7 s before the mutation run, 8.2 s after it) |
| packages/engine test/worktree/create-for-task.test.ts | 5 pass, 0 fail, 38 expects |
| packages/engine test/project/worktree.test.ts | 14 pass, 0 fail, 34 expects |
| packages/engine test/project/worktree-remove.test.ts | 2 pass, 2 skip (Windows-only), 0 fail, 9 expects |
| packages/engine test/compliance/egress-inventory.test.ts | 5 pass, 0 fail, 12 expects |
| packages/desktop src/main/everywhere-git.test.ts, `--no-env-file` | 8 pass, 0 fail, 88 expects |
| `bun typecheck` in packages/core, packages/engine and packages/desktop | exit 0 each |
| `bun prettier --check` on core everywhere/git.ts, engine worktree/index.ts and the test file | all three conforming |
| Lines over 120 columns added | none beyond those listed above (index.ts :212, 121 columns, is HEAD's own line) |
| Mutations, third run (/tmp/vector-v2/everywhere/ev12-mut/round3/, 24 mutations against the final index.ts and test file, restore hash checked after each) | 17 red, 7 survive (M11, M12, M16-M19 and M21, as before, each by design or argued); M22 and M23 are new and red; table in the deviations entry. A round2/ run stopped at M18 for a comment rewrap agrees on M1-M17 except M11b's U6 case, which depends on the interleaving under that mutation |

The full turbo typecheck was not re-run for these fixes (it runs before the push).

**Not done here (the task said not to commit):** the lead's yes to deviation (b) (the move to core everywhere/git.ts) or the recorded fallback; the commit (`feat(engine): create unattended worktrees from an exact base with git hardened`, staging the four code files and the five lane documents by path, the body naming all four code files (packages/core/src/everywhere/git.ts, packages/desktop/src/main/everywhere-git.ts, packages/engine/src/worktree/index.ts, packages/engine/test/everywhere/worktree.test.ts) and the lane documents and saying no generated file, route, flag or dependency changed), the full typecheck before the push, the push, and the workflow_dispatch runs of vector-everywhere.yml and typecheck.yml on everywhere-finish. Their run ids go in the next lane-docs commit. Never vector-codium.yml before PR #33 is on main and merged here.

**Commit gate (2026-11-16).** `git fetch origin release-finish main everywhere-finish scope-finish`: HEAD was still `d31d418f` = origin/everywhere-finish, holding origin/release-finish `67ec3a60`; origin/scope-finish `1f5d62ad` still changes none of this package's files since its merge base. origin/main is now `b362fdf6` (PR #33's merge); it is not merged here (the lead merges main into this branch). Its merge base with HEAD is now `67ec3a60`, so vector-codium.yml's changed-since-main picker selects 28 test files, not hundreds. The working tree held only this package's nine paths. Re-run at the gate, each through `vector-serial`, one file at a time from the owning package (engine with `TMPDIR=/tmp/vector-v2/everywhere-finish/ev12/tmp`):

| Check | Result |
| --- | --- |
| packages/engine test/everywhere/worktree.test.ts | 8 pass, 0 fail, 295 expects (9.7 s) |
| packages/engine test/worktree/create-for-task.test.ts | 5 pass, 0 fail, 38 expects |
| packages/engine test/compliance/egress-inventory.test.ts | 5 pass, 0 fail, 12 expects |
| packages/desktop src/main/everywhere-git.test.ts, `--no-env-file` | 8 pass, 0 fail, 88 expects |
| packages/desktop src/main/everywhere-runner.test.ts, `--no-env-file` | 49 pass, 0 fail, 355 expects |
| `bun typecheck` in packages/core, packages/engine and packages/desktop | exit 0 each |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | 27 of 27 tasks successful, exit 0 |

Committed as `feat(engine): add a safe unattended worktree creator` (the four code files and the five lane documents, staged by path), with deviation (b)'s move to core as built. After the push, vector-everywhere.yml, vector-hosted-ci.yml, vector-at-mention.yml, vector-codium.yml and typecheck.yml are dispatched on everywhere-finish; their run ids go in the next lane-docs commit.

## EV-13: owner-only unattended worktree route (2026-11-16)

Package EV-13 (vector-everywhere-main-requests.md, "Safe unattended worktree creation": capability advertisement, no fallback; VE-07's SafeWorktree port): `POST /experimental/worktree/unattended` and the `unattended-v1` probe. Decisions and deviations: vector-everywhere-deviations.md, "2026-11-16, EV-13". Built in the working tree, then committed at the lane's commit gate ("EV-13, 2026-11-16: commit gate" below).

**Base.** `git fetch origin release-finish main everywhere-finish scope-finish connect-finish`: HEAD `46471914` (EV-12) equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged. origin/main is `b362fdf6` (PR #33's merge); `git diff 67ec3a60 origin/main` is empty, and main is not merged here (the lead merges it). Precondition EV-12 (`46471914`) is HEAD itself; no review-fixes or brain-transport commit is needed. Cross-lane check against each tip's merge base: only origin/connect-finish `a320bdbe` touches this package's files (packages/sdk/openapi.json and both types.gen.ts, regenerated files; resolve only by regenerating). review-fixes `1433d105`, hands-finish `d9d5afaf`, brain-transport `34a9d93a`, codium-finish `b2537951`, workspaces-finish `e37ec1b5`, native-qualify `47db73cd` and scope-finish `1f5d62ad` touch none.

**Files:**

- packages/engine/src/server/routes/instance/httpapi/groups/experimental.ts (+50): `worktreeUnattended` path (:208), `UnattendedWorktreePolicy` (:230-232), `UnattendedWorktreeApi` (:666-706).
- packages/engine/src/server/routes/instance/httpapi/api.ts (+2/-1): import (:15), `.addHttpApi(UnattendedWorktreeApi)` (:73).
- packages/engine/src/server/routes/instance/httpapi/server.ts (+2/-1): import (:120), `unattendedWorktreeHandlers` (:203).
- packages/engine/src/server/routes/instance/httpapi/handlers/experimental.ts (+87/-1 after review round one): imports (:25-30), messages (:585-590), `unattendedWorktreeHandlers` (:592-658: `policy` :599, `create` :607, `owner` :629, `allowed` :637, `loaded` :649), `refused` (:660-662).
- packages/engine/src/worktree/index.ts (+22/-8, review round one): `normalize` import (:26), the service's `canonical` built on `canonicalPath` (:420-424), the exported `canonicalPath` (:942-954) and `folded` (:956-959).
- packages/engine/src/config/config.ts (+16, review round one, additive): `readGlobal` in `Interface` (:556-560), its implementation (:1829-1837) and in `Service.of` (:2779).
- packages/engine/test/fixture/config.ts (+1, review round one): the fake's `readGlobal`.
- packages/engine/test/server/httpapi-exercise/index.ts (+32): two imports (:22-23) and three scenarios (:1420-1449).
- packages/engine/test/everywhere/worktree.test.ts (+411/-4 after review round one, the import block included): the describe "POST /experimental/worktree/unattended (EV-13)" (:553-944), ten tests:
  - H1 "the probe answers unattended-v1 to the owner only": owner 200 `{policy: "unattended-v1"}`; guest 403; owner with `x-vector-guest-request: 1` 403; no credentials 401.
  - H2 "the owner's create makes the job's worktree, runs no hook or start script, and answers only directory, branch and base": allowed through PATCH /global/config (awaiting `global.disposed`), every instance disposed and the repository's absent from `loaded()`; then opened through GET /project/current, which shows up in `loaded()` (the observation's positive control); plain `git branch` fires the committed hook (positive control); the POST with an extra `task` marker answers 200 with exactly `[base, branch, directory]`, the directory `realpath(<data>/everywhere-worktree/<project id>/<jid>)`, HEAD the base on the job's branch, `a.txt` the base's, no hook or start-script marker, no task marker in the response, no `worktree.ready` or `worktree.failed` event, `loaded()` unchanged by the request, and GET /experimental/worktree listing the new folder.
  - H3 "a guest or a guest-marked request is refused before anything exists": allowed, trusted and open; 403 for each, no branch and no folder.
  - H4 "a folder the user's own config does not allow is refused and never gets an instance": no block; `enabled: false` listing the folder; another folder listed; an invalid block (`pushh: true`), whose 403 body carries neither the config folder nor the repository path, as written or JSON-escaped. Each is the fixed 403, with `loaded()` lacking the repository before and after and no branch or folder. GET /global/config answers 200 before the cases and still 200 after the invalid file (the route's read leaves the engine's copy alone).
  - H5 "turning it off by hand applies to the next request, with the project open and trusted": a request while allowed reaches `createUnattended` (its base refusal), then `enabled: false` written by hand gives the fixed 403.
  - H6 "a company lock on everywhere is off, with the project open and trusted": the managed `{local: {lock: true, locked_keys: ["everywhere"]}}` (EV-10's sequence and cleanup) gives the fixed 403.
  - H7 "an allowed, trusted project the owner has not opened is refused and gets no instance": 403 "not open", `loaded()` lacking it before and after.
  - H8 "a listed link to the folder admits the folder": the list holds a link (a junction on Windows) and the payload the real path: 200.
  - H9 "an allowed project that is open but not trusted is refused, with or without settings of its own": 403 for both.
  - H10 "malformed or foreign input answers 400 and creates nothing": branch `main`, base `HEAD`, jid `vej_short` and `directory: 1` (schema 400s); a schema 400 whose body carried a `task` marker does not echo it; another job's `vector/ve-<12>` ("Invalid unattended worktree request."); a valid base with no fetch ref ("The base is not this job's fetched commit."); a relative path naming the open listed folder and one naming a listed folder that is not open (both "Invalid unattended worktree request."; across drives, where `path.relative` answers an absolute path, `../<folder name>` instead); a listed folder that does not exist ("The allowed folder is not available.", never loaded, never created).
- Regenerated with ./packages/sdk/js/script/build.ts (two runs, the second changing nothing): packages/sdk/openapi.json (+161), packages/sdk/js/src/gen/sdk.gen.ts (+46), packages/sdk/js/src/gen/types.gen.ts (+77), packages/sdk/js/src/v2/gen/sdk.gen.ts (+53), packages/sdk/js/src/v2/gen/types.gen.ts (+77). Additions only. packages/client: `bun run generate` and `bun run check:generated` exit 0 with no diff.
- Lane docs: vector-everywhere-deviations.md (the EV-13 entry), this receipt, vector-everywhere-main-requests.md (an annotation on EV-12's status line and the "delivered" paragraph), vector-everywhere-handoff.md (annotations on the "Current gates" safe-worktree bullet, the EV-12 bullet and the EV-12 "Left open" item; a new EV-13 bullet), vector-everywhere-spec.md (dated notes on §3.5 step 4, §6.4 and §6.5's generated row).
- No flag, env var, dependency, lockfile, workflow, config.json, workflow.json or help snapshot changed.

**Checks**, each through `vector-serial`, one file at a time from the owning package, engine tests with `TMPDIR=/tmp/vector-v2/everywhere-finish/ev13/tmp`:

| Check | Result |
| --- | --- |
| packages/engine test/everywhere/worktree.test.ts | 18 pass (EV-12's 8 and EV-13's 10), 0 fail, 428 expects (16.6 s); run again after the mutation runs and the regeneration: 18 pass, 0 fail, 428 expects (15.3 s) |
| packages/engine test/server/httpapi-experimental.test.ts (the existing worktree routes) | 9 pass, 0 fail, 42 expects |
| packages/engine test/server/auth-guest.test.ts (the owner gate list) | 28 pass, 0 fail, 271 expects |
| packages/engine test/server/session-stop.test.ts and test/server/task-batch-promotion.test.ts (`ExperimentalApi` alone) | 4 pass, 20 expects; 5 pass, 29 expects; 0 fail each |
| packages/engine test/server/httpapi-public-openapi.test.ts | 20 pass, 0 fail, 215 expects |
| packages/engine test/server/httpapi-query-schema-drift.test.ts | 12 pass, 0 fail, 51 expects |
| packages/engine test/compliance/egress-inventory.test.ts (no lane workflow runs it) | 5 pass, 0 fail, 12 expects |
| packages/engine test/compliance/generated-artifacts.test.ts | 2 pass, 0 fail, 9 expects |
| packages/engine test/server/worktree-endpoint-repro.test.ts (imports `ExperimentalPaths`) | 6 pass, 0 fail, 13 expects |
| packages/engine test/server/server-package-auth.test.ts (the isOwnerOnlyRoute table) | 5 pass, 0 fail, 15 expects |
| packages/sdk/js test/v1-schema.test.ts and test/wire-compat.test.ts | 1 pass, 2 expects; 10 pass, 24 expects; 0 fail each |
| `bun run test:httpapi` in packages/engine (coverage, auth, effect; `--fail-on-missing --fail-on-skip`) | pass=366 fail=0 skip=0 missing=0 extra=0 in each mode, the three new scenarios among them; exit 0 |
| ./packages/sdk/js/script/build.ts, twice | exit 0; the five files above; the second run changed nothing (same diff hash) |
| `bun run generate`, then `bun run check:generated` in packages/client | exit 0 each, no change under src/generated or src/generated-effect |
| `bun typecheck` in packages/engine (includes the tests) | exit 0 |
| `bun typecheck` in packages/sdk/js (the regenerated files) | exit 0 (`tsgo --noEmit` and the test project) |
| `bun prettier --check` | worktree.test.ts, api.ts and server.ts conform. groups/experimental.ts, handlers/experimental.ts and httpapi-exercise/index.ts did not conform at HEAD (108, 129 and 126 lines of prettier diff, all in other packages' hand-packed lines) and are not reformatted; with this package their prettier diff is the same 108, 129 and 126 lines, so the added hunks conform |
| Lines over 120 columns added | two string literals only: the create endpoint's OpenAPI description and H2's test name |
| `git diff` scan for personal paths and email addresses | none |

**Mutations**: thirteen, on handlers/experimental.ts alone (/tmp/vector-v2/everywhere/ev13-mut/). round1/ (13): 12 red, M9 survived; the malformed-input test then gained a relative path naming a listed folder that is not open, and M9 went red (round2-m9/); round3/ (all 13 against the final handler and test file): 13 red, each restore's sha256 checked. The table is in the deviations entry.

**Found while testing:** the global loader's settings import (`ConfigMigration.run`) copies the seeded config.json into vector.jsonc on a load where the global folder has no Vector file with settings, so a later hand edit of config.json is shadowed. The first H5 build edited config.json and failed for that reason, not because of the route; the tests now write vector.json (deviations (b)).

**Not done here (the task said not to commit):** the commit (`feat(engine): add the owner-only unattended worktree route`, staging by path the six engine source files (the four route files, plus worktree/index.ts and config/config.ts from review round one), the three test files (test/fixture/config.ts from review round one), the five regenerated SDK files and the five lane documents; the body names the regenerated files, says packages/client is unchanged because the client compiles only the protocol API, and that no flag, env var, dependency or workflow changed), the full `bun turbo typecheck` before the push, the push, and the workflow_dispatch runs of vector-everywhere.yml and typecheck.yml on everywhere-finish, whose run ids go in the next lane-docs commit. The lead's ruling on deviation (c) (only an instance already loaded in this engine) is asked for; the looser option is recorded there.

### EV-13, 2026-11-16: review fixes (round one)

One blocking and nine non-blocking findings, all taken; the deviations entry's "Review round one" says what changed for each and why. Code: the relative-path case's cross-drive fallback and the JSON-escaped leak assertions (test/everywhere/worktree.test.ts), the allowlist test's two GET /global/config checks, one exported `Worktree.canonicalPath` (packages/engine/src/worktree/index.ts) used by the service and the route, the folder canonicalized once in `create`, the FSUtil service's `isDir` in place of `isDirectory`, `opened` renamed `loaded` with the "already loaded in this engine (by any authenticated request)" wording, comments without lane package ids, and `Config.readGlobal` (packages/engine/src/config/config.ts, additive; the fake in test/fixture/config.ts) in place of `config.invalidate()` plus `getGlobal()`. Docs: deviations (b), (c), (i), "What changed", "The sequence", "Not changed", "Coordination", the mutations paragraph and table, "Review round one" and "Deferred verification"; this receipt's "Files" list; main-requests.md's annotation and status ("delivered, CI pending"); the handoff's EV-12 annotation and EV-13 bullet; spec §3.5 step 4's and §6.4's EV-13 notes. Not committed, as the task said.

Checks, each through `vector-serial`, one file at a time from the owning package, engine tests with `TMPDIR=/tmp/vector-v2/everywhere-finish/ev13/tmp` (logs in /tmp/vector-v2/everywhere/ev13-rr1/):

| Check | Result |
| --- | --- |
| packages/engine test/everywhere/worktree.test.ts | 18 pass, 0 fail, 438 expects (12.9 s); again after the mutation run: 18 pass, 0 fail, 438 expects (15.0 s) |
| packages/engine test/server/httpapi-experimental.test.ts | 9 pass, 0 fail, 42 expects |
| packages/engine test/project/worktree.test.ts (the service's `canonical` now built on `canonicalPath`) | 14 pass, 0 fail, 34 expects |
| packages/engine test/project/worktree-remove.test.ts | 2 pass, 2 skip (their platform guards), 0 fail, 9 expects |
| packages/engine test/server/worktree-endpoint-repro.test.ts | 6 pass, 0 fail, 13 expects |
| packages/engine test/everywhere/config.test.ts | 19 pass, 0 fail, 68 expects |
| packages/engine test/config/config.test.ts (Config gains `readGlobal`) | 175 pass, 0 fail, 415 expects |
| packages/engine test/server/auth-guest.test.ts | 28 pass, 0 fail, 271 expects |
| packages/engine test/server/httpapi-public-openapi.test.ts | 20 pass, 0 fail, 215 expects |
| `bun run test:httpapi` in packages/engine | pass=366 fail=0 skip=0 missing=0 extra=0 in each of the three modes; exit 0 |
| ./packages/sdk/js/script/build.ts | exit 0; the SDK diff is unchanged (same hash before and after), so no generated file changes with this round |
| `bun run generate`, then `bun run check:generated` in packages/client | exit 0 each, packages/client unchanged |
| `bun typecheck` in packages/engine (includes the tests) | exit 0 |
| prettier, by file | worktree/index.ts, config/config.ts, worktree.test.ts and test/fixture/config.ts conform (0 lines of prettier diff, as at HEAD); handlers/experimental.ts has the same 133 lines of prettier diff as at HEAD, none in the EV-13 block |
| Lines over 120 columns added | the same two string literals as before |
| `git diff` scan for personal paths and email addresses | none |

**Mutations, round4/** (/tmp/vector-v2/everywhere/ev13-mut/: mutations_r4.py, run_r4.py, round4.out, one log per mutation): fourteen on the fixed handler, each applied alone with the test file run alone, the handler restored and its sha256 checked after every run: 14 red. M11 is now "read the cached `getGlobal()`" (red on the hand edit), M12 "let a `readGlobal` failure propagate" (red on `pushh`) and the new M14 "the first build's invalidate, then `getGlobal()`" (red on the allowlist test's last GET /global/config, 400 instead of 200). The table is in the deviations entry.

Still to do by the lead: the commit (with the staging list in "Not done here" above), the full `bun turbo typecheck` before the push, the push, and the workflow_dispatch runs of vector-everywhere.yml and typecheck.yml on everywhere-finish; then the "left uncommitted" and "Not committed" sentences in this receipt and the deviations entry become the commit and the run ids. *Done at the commit gate below, apart from the run ids.*

### EV-13, 2026-11-16: commit gate

`git fetch origin release-finish main everywhere-finish`: HEAD `46471914` (EV-12) still equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged. origin/main has moved to `33fc9fbc` (PR #34's cloud workspaces and PR #37's CI budget after PR #33's `b362fdf6`); none of its commits since the merge base `67ec3a60` touches a file of this package, and main is not merged here (the lead merges main into this branch). The working tree held only this package's nineteen paths. Re-run at the gate, each through `vector-serial`, from the owning package, engine with `TMPDIR=/tmp/vector-v2/everywhere-finish/ev13/tmp` (logs in /tmp/vector-v2/everywhere/ev13-gate/):

| Check | Result |
| --- | --- |
| packages/engine test/everywhere/worktree.test.ts | 18 pass, 0 fail, 438 expects (18.5 s) |
| `bun run test:httpapi` in packages/engine | pass=366 fail=0 skip=0 missing=0 extra=0 in each of coverage, auth and effect; exit 0 |
| `bun run check:generated` in packages/client | exit 0, no change under src/generated or src/generated-effect |
| ./packages/sdk/js/script/build.ts | exit 0; the SDK diff's hash is the same before and after, so the five regenerated files are current |
| `bun typecheck` in packages/engine and packages/sdk/js | exit 0 each |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | 27 of 27 tasks successful, exit 0 |

Committed as `feat(engine): expose the unattended worktree capability to the owner` (the commit gate's title, in place of the planned `feat(engine): add the owner-only unattended worktree route`), staging by path the six engine source files, the three engine test files, the five regenerated SDK files and the five lane documents. After the push, vector-everywhere.yml, vector-hosted-ci.yml, vector-at-mention.yml, vector-codium.yml and typecheck.yml are dispatched on everywhere-finish; their run ids go in the next lane-docs commit, and the handoff's EV-13 bullet and main-requests.md keep "CI pending" until then. The lead's ruling on deviation (c) (only an instance already loaded in this engine) is still asked for.

## EV-14: unattended sessions hear the outward audience (2026-11-16)

Package EV-14 (spec §11 R-M3; §3.11 "Laptop runs need no snapshot"; §5 E6): `audienceOf` returns `outward` for a session marked `vector.unattended`, with two stricter-only gates for outward roles beyond the brief (Tier 1 recall, and memory attached to a file a read brings). Decisions and deviations: vector-everywhere-deviations.md, "2026-11-16, EV-14". Built in the working tree and not committed, as the task said.

**Base.** `git fetch origin release-finish main everywhere-finish` (and every lane tip below): HEAD `0d9f852c` (EV-13) equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged. PR #33 has merged into main: origin/release-finish is an ancestor of origin/main `33fc9fbc`, 16 commits and 19 files past the merge base `67ec3a60`. The package left main unmerged (no commit allowed here; the lead owns that merge, deviations entry's opening paragraph); none of main's 19 files is among the nine files below. Cross-lane check, `git diff --stat $(git merge-base HEAD origin/<lane>) origin/<lane>` over packages/engine/src/session/{prompt,instruction,memory}.ts, packages/engine/src/tool/read.ts, packages/engine/test/everywhere/unattended-session.test.ts, packages/core/src/everywhere/frame.ts and packages/core/src/brain/{brain,private,knowledge}.ts: empty for main `33fc9fbc`, scope-finish `a6fd38d3`, review-fixes `1433d105`, brain-transport `aa925ff8`, hands-finish `d9d5afaf`, connect-finish `a320bdbe`, codium-finish `b2537951`, workspaces-finish `e37ec1b5`, native-qualify `2677c32c` and native-finish `f141ef16`. origin/codium-track `c262f74b` touches prompt.ts and brain.ts since its old merge base `eed4bc45`, with hunks already in HEAD and away from this package's. No review-fixes or brain-transport precondition. docs/vector/build/v2-spawn-review.md read; no spawn site.

**Files** (line numbers after the change):

- packages/engine/src/session/prompt.ts (+21/-7): the `UNATTENDED_KEY` import (:96); `audienceOf` with `metadata` in its Pick and the mark check, docblock included (:160-180); `const audience` moved above the recall gate (:2851-2853) and the gate `audience === "owner"` with its comment (:2858-2871 after review round one, which adds one comment line; +22/-7 then). The callers at the fork (`inherit.audience`), the main loop and `briefFor` are unchanged.
- packages/engine/src/session/instruction.ts (+15/-10): `Asking.outward` (:65-66); `resolve` skips `brain.attach` for it (:414-433).
- packages/engine/src/tool/read.ts (+5/-1): passes `outward: ctx.extra?.outward === true` with `SessionMemory.linking(ctx)` (:342-349).
- packages/engine/test/everywhere/unattended-session.test.ts (+139/-3; 3 tests to 5):
  - imports (`mkdir`, `BrainPrivate`, `frameTask`, `UNATTENDED_KEY`, `SessionMemory`); helpers `plain` (:109-119), `system` (:121-126), fixture constants (:128-135), `memories` (:137-169), `heard` (:171-180);
  - T1 (:182): its owner control is `plain(h, "Owner control")` (:193), with no `vector.unattended`; its assertions are unchanged;
  - T4 (:265-293) "a session without the unattended mark still hears the owner's particular entries and recall, guest-marked or not": the owner's own session prompted with `frameTask(job)` gets `<vector_memory>`, SCREENED, PARTICULAR and the personal fact in its system text, a recall part holding RECALLED, and a read of src/billing/retry.ts whose output holds "Vector's memory for src/billing/retry.ts" and ATTACHED; a guest-marked plain session prompted by the real desktop client gets no personal fact, but SCREENED and PARTICULAR in its system text and a recall part holding RECALLED;
  - T5 (:295-323) "an unattended session hears only the screened digest, with no recall and no memory beside a file it reads": a session from the real client's `create` (so marked) and `prompt` has no recall part, its read output holds the file's text and no memory line, its system text holds `<vector_memory>` and SCREENED, and no request body holds PARTICULAR, RECALLED, ATTACHED or the personal fact; GET /session/:id shows the mark; the owner's later prompt without the guest header still sends SCREENED and none of the four, and the history still has no recall part.
  - Fixtures: each text is checked against the real `BrainPrivate.screened` first (SCREENED passes; PARTICULAR, RECALLED and ATTACHED fail), and each entry is read back with GET /memory/:id as `active` with its kind, scope, text and pin. ATTACHED is imported as Markdown with a `paths:` bullet and approved, because POST /memory takes no paths.
- Lane docs: vector-everywhere-deviations.md (the EV-14 entry), this receipt, vector-everywhere-spec.md (dated EV-14 notes on §2's guest-mark bullet, §3.11, §5 E6, §6.4 and §11 R-M3), vector-everywhere-handoff.md (an annotation on the "Component tests" gate's R-M3 sentence, a new "Current gates" bullet and a "Left open" item). v2-finish-plan.md and v2-complete-plan.md are not lane documents and are not edited.
- No generated file, flag, env var, dependency, lockfile, workflow, route or config changed.

**Checks**, each through `vector-serial`, one file at a time from the owning package, engine tests with `TMPDIR=/tmp/vector-v2/everywhere-finish/ev14/tmp` (logs in /tmp/vector-v2/everywhere/ev14/):

| Check | Result |
| --- | --- |
| packages/engine test/everywhere/unattended-session.test.ts at HEAD, before any change | 3 pass, 0 fail, 73 expects (15.6 s) |
| the same file with the change | 5 pass, 0 fail (24.4 s); after T5's reorder 5 pass (23.3 s); in the regression run 5 pass, 200 expects (24.2 s); after the final formatting change to prompt.ts 5 pass, 0 fail, 190 expects (18.9 s). The expect count varies with how often `finished` and `spend` poll; T4 and T5 take about 3 to 5 s each, under the file's 30-s timeout |
| packages/engine test/session/memory-every-agent.test.ts (outward digest, `habitsOf` roles, root researcher, research lead, brief) | 14 pass, 0 fail, 110 expects (33.7 s) |
| packages/engine test/session/fork.test.ts (`inherit.audience`) | 15 pass, 0 fail, 130 expects (6.8 s) |
| packages/engine test/session/knowledge-recall.test.ts (Tier 1 recall for owner sessions) | 4 pass, 0 fail, 36 expects (13.5 s) |
| packages/engine test/session/research-judge.test.ts | 8 pass, 0 fail, 53 expects (32.8 s) |
| packages/engine test/session/instruction.test.ts (`resolve`, memory with a file) | 17 pass, 0 fail, 51 expects (3.8 s) |
| packages/engine test/tool/read.test.ts | 45 pass, 0 fail, 106 expects (22.3 s) |
| packages/engine test/server/session-metadata.test.ts | 3 pass, 0 fail, 52 expects (3.3 s) |
| packages/engine test/server/startup-imports.test.ts (the frame.ts import on the server graph) | 1 pass, 0 fail, 3 expects (5.2 s) |
| packages/engine test/session/prompt.test.ts (the main loop) | 157 pass, 1 skip (its existing `noLLMServer.instance.skip`), 0 fail, 710 expects (208.1 s) |
| packages/core test/everywhere/frame.test.ts (pins `UNATTENDED_KEY`) | 18 pass, 0 fail, 465 expects |
| `bun typecheck` in packages/engine (includes the tests) | exit 0, before and after the final formatting change |
| prettier, by file (`semi: false`, `printWidth: 120`, the root package.json's settings) | prompt.ts, instruction.ts and read.ts conform, as at HEAD; the recall condition is on one line, as prettier wants (exactly 120 columns). unattended-session.test.ts did not conform at HEAD (428 lines of prettier diff in its hand-packed lines) and is not reformatted; its added hunks keep that style (619 lines of prettier diff now) |
| Lines over 120 columns added | none in source; 10 in the test file, in its existing hand-packed style (longest 203, the same as HEAD's longest) |
| `git diff` scan for personal paths and email addresses | none |

`grep audienceOf packages/engine/test` finds nothing, so the regression set above stands in for it. The regression files ran before the last change to prompt.ts, which only puts the recall condition on one line (no behaviour change); unattended-session.test.ts, the engine typecheck and all six mutations ran again after it.

**Mutations:** six, one source file at a time, the test file run alone, each restore's sha256 checked (/tmp/vector-v2/everywhere/ev14-mut/): all six red on their predicted assertion in round1/ (M1 again against the final test file in round2-m1/), and all six again against the final sources in round3/ (M3 and M4 anchored on the one-line recall condition). The table is in the deviations entry.

**Review round one (2026-11-16).** Eight non-blocking findings; each response is in the deviations entry's "Review round one". Still in the working tree, not committed.

- Files: packages/engine/test/session/instruction.test.ts (+44; 17 tests to 18), the case "an outward role's read brings the nearby instructions and no memory about the file" (:471-513), which seeds a path-anchored repository lesson with `brain.propose` and calls `Instruction.resolve` directly with `outward: true` (only the nearby src/billing/AGENTS.md comes back) and, in another message, without it (AGENTS.md and the `memory:` item holding "Vector's memory for src/billing/retry.ts"); packages/engine/src/session/prompt.ts (+1 line of comment on the recall gate, which now spans :2851-2871: it covers every outward role and points to deviations (b)); the four lane documents (deviations (a) reworded, Left open, Mutations, Coordination with the notices to scope-finish and brain-transport, Deferred verification and the new "Review round one"; spec §2's EV-14 note reworded, §5 E6 and §11 R-M3 notes extended; handoff EV-14 bullet and Left open item).
- Base: HEAD still `0d9f852c`, equal to origin/everywhere-finish. origin/main is now `2034e1da`, 32 commits and 38 files past the merge base `67ec3a60`, none of them this package's files; still unmerged here (the lead's merge). Lane tips re-checked over this package's files plus instruction.test.ts and the four lane documents: empty for every lane (deviations entry, Coordination).

| Check (each through `vector-serial`, one file at a time from packages/engine, `TMPDIR=/tmp/vector-v2/everywhere-finish/ev14/tmp`; logs in /tmp/vector-v2/everywhere/ev14/) | Result |
| --- | --- |
| test/session/instruction.test.ts with the new case (r2-instruction.log); no lane workflow picks this file | 18 pass, 0 fail, 56 expects (4.0 s) |
| test/everywhere/unattended-session.test.ts after the prompt.ts comment (r2-unattended.log) | 5 pass, 0 fail, 214 expects (25.4 s) |
| `bun typecheck` in packages/engine (r2-typecheck.log) | exit 0 |
| prettier `--check` on prompt.ts, instruction.ts and read.ts | all conform |
| prettier on instruction.test.ts, compared with the same at HEAD | the same 90 lines of prettier diff as at HEAD, all in the file's existing lines; the new case conforms and adds no line over 120 columns |
| M7 and M8 on instruction.ts against the new case (ev14-mut/round4/, sha256 restore checked after each) | both red at instruction.test.ts :502 (M7: a `memory:` item beside AGENTS.md; M8: AGENTS.md missing); 17 pass, 1 fail each |
| `git diff` scan for personal paths and email addresses | none |

The other regression files in the table above were not re-run: this round changes no source line that runs (one comment in prompt.ts) and adds one test case.

**Not done here (the task said not to commit):** the commit (`feat(engine): give unattended sessions the outward memory audience`, staging by path packages/engine/src/session/prompt.ts, packages/engine/src/session/instruction.ts, packages/engine/src/tool/read.ts, packages/engine/test/everywhere/unattended-session.test.ts, packages/engine/test/session/instruction.test.ts and docs/vector/build/vector-everywhere-{deviations,progress,spec,handoff}.md; the body says no generated file, flag, env var, dependency or workflow changed), the full `bun turbo typecheck` before the push, the push, and the workflow_dispatch runs of vector-everywhere.yml and typecheck.yml on everywhere-finish, whose run ids go in the next lane-docs commit; the handoff's EV-14 bullet keeps "CI pending" until then. The lead also owns merging origin/main (PR #33's merge and, now, the 32 commits after it) into this branch, adding the EV-21 precondition (deviations entry, Left open) to EV-21's brief, and forwarding the (h) notice to scope-finish and brain-transport.

**Commit gate (2026-11-16).** `git fetch origin everywhere-finish release-finish main`: HEAD was still `0d9f852c` = origin/everywhere-finish, holding origin/release-finish `67ec3a60`. origin/main is `2034e1da`, 32 commits and 38 files past the merge base `67ec3a60`, none of them this package's files; it is not merged here (the lead merges main into this branch). The working tree held only this package's nine paths. Re-run at the gate, each through `vector-serial`, one file at a time from packages/engine with `TMPDIR=/tmp/vector-v2/everywhere-finish/ev14/tmp` (logs in /tmp/vector-v2/everywhere/ev14/gate/):

| Check | Result |
| --- | --- |
| test/everywhere/unattended-session.test.ts | 5 pass, 0 fail, 200 expects (22.6 s) |
| test/session/instruction.test.ts | 18 pass, 0 fail, 56 expects (4.2 s) |
| `bun typecheck` in packages/engine | exit 0 |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | 27 of 27 tasks successful, exit 0 |

Committed as `feat(engine): give unattended sessions the outward memory audience`, staging by path the three engine source files, the two engine test files and the four lane documents. After the push, vector-everywhere.yml, vector-hosted-ci.yml, vector-at-mention.yml, vector-codium.yml and typecheck.yml are dispatched on everywhere-finish; their run ids go in the next lane-docs commit, and the handoff's EV-14 bullet keeps "CI pending" until then.

### EV-14, 2026-11-16: CI follow-up

EV-14's dispatched runs at `cb2a73ba`: vector-everywhere 43910516659, vector-hosted-ci 43910521930, vector-codium 43910537013 and typecheck 43910543984 passed. vector-at-mention 43910529519 failed one job, "engine and core" (133450900610), step "Run core GitHub tests": packages/core/test/review/model-evidence.test.ts "scope > the pipeline's sources are pinned next to REVIEW_PIPELINE_REVISION" (1354 pass, 1 fail), because prompt.ts and read.ts are pinned review pipeline files. main's newest completed at-mention run, 43896073324 at `2034e1da`, passed. Fixed in packages/core/src/review/model-evidence.ts: `REVIEW_PIPELINE_REVISION` 4 to 5 and `REVIEW_PIPELINE_SOURCES` to 58a3650e0bb3f9e2 (why: deviations entry, "CI follow-up (2026-11-16)"). Each through `vector-serial`, one file at a time (logs in /tmp/vector-v2/everywhere/ci-ev16/):

| Check | Result |
| --- | --- |
| packages/core test/review/model-evidence.test.ts at HEAD `bc254e85`, before the fix | 29 pass, 1 fail (the pin, printing 58a3650e0bb3f9e2), 392 expects |
| the same file with the fix | 30 pass, 0 fail, 393 expects |
| packages/engine test/review/model.test.ts (reads the model evidence) | 21 pass, 0 fail, 90 expects |
| `bun typecheck` in packages/core | exit 0 |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | 27 of 27 tasks successful, exit 0 |

## EV-15: Vector Local `everywhere` source and the runner's E15 decision (2026-11-16)

Package EV-15 (spec §11 R-M1; §5 E15; §3.5 step 2): core local-mode/sources.ts declares the `everywhere` source and lists desktop everywhere-git.ts under `git-remote`; the desktop runner replaces its three blanket `settings.localMode` checks with the registry's decision (`localAllows`: `everywhere`, `git-remote` and `github` all allowed), its jobs client sends through `Egress.fetch("everywhere", …)`, and everywhere-git.ts decides each fetch and push as `git-remote` before git starts. Decisions and deviations: vector-everywhere-deviations.md, "2026-11-16, EV-15". Built in the working tree and not committed, as the task said.

**Base.** `git fetch origin release-finish main everywhere-finish` and every lane tip: HEAD `cb2a73ba` (EV-14) equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged. origin/main is `2034e1da`, not merged here (the lead's merge); none of its files is one of this package's. Cross-lane check over this package's files: empty for every lane but codium-finish `0b9f8337` (sources.ts brain-vault text and one sources.test.ts case; `git merge-file` merges both files cleanly) and scope-finish `1b6df982` (egress-inventory.test.ts :157, not edited here). No review-fixes or brain-transport precondition; no spawn site changes.

**Files** (line numbers after the change):

- packages/core/src/local-mode/sources.ts (+13): the `everywhere` source after `remote` (:397-408); `packages/desktop/src/main/everywhere-git.ts` in `git-remote`'s call sites (:660).
- packages/desktop/src/main/everywhere-runner.ts (+41/-6): imports (:9-12); `RunnerSettings.localMode` removed; the jobs client through `Egress.fetch("everywhere", …, input.fetcher)` with its comment (:38-45); `RunnerDeps.localPolicy` (:93-94); `LOCAL_NEEDS` (:112-119) and exported `localAllows` (:121-134); `localAllowed` (:149); the timer (:243), the push gate (:319) and the offer with its comment (:378-380).
- packages/desktop/src/main/everywhere-git.ts (+15/-1): the `Egress` import (:7); `localBlocks` (:37-46); the fetch refusal (:142) and the push refusal with its comment (:171-172).
- packages/app/src/features/local/local-model.ts (+1): `everywhere: "Jobs for this computer"` (:110).
- packages/desktop/src/main/everywhere-runner.test.ts (+127/-10; 49 tests to 52): helpers (:16-21), fixture `localPolicy` and `f.local` (:74, :87, :91), `afterEach` (:99), R1 (:225-234), R2 (:236-264), R4 (:266-280), R5 (:282-331), the abort loop with `local` (:603-621).
- packages/desktop/src/main/everywhere-git.test.ts (+27; 8 tests to 9): imports (:7-8) and the Vector Local case (:120-143).
- packages/core/test/local-mode/sources.test.ts (+21; 15 tests to 16): `blocked("everywhere")` (:104) and the new case (:257-275).
- Lane docs: vector-everywhere-deviations.md (the EV-15 entry), this receipt, vector-everywhere-spec.md (dated EV-15 notes under §3.5 step 2, §5 E15, §6.4 and §11 R-M1), vector-everywhere-handoff.md (a "Current gates" bullet and a "Left open" item).
- engine test/compliance/egress-inventory.test.ts and app src/components/settings-v2/local-model.test.ts are run, not edited. No generated file, flag, env var, dependency, lockfile, workflow, route or config changed.

**Checks**, each through `vector-serial`, one file at a time from the owning package with `--timeout 30000` (desktop with `--no-env-file`, app with `--isolate`); logs in /tmp/vector-v2/everywhere/ev15/:

| Check | At HEAD, before any change | With the change |
| --- | --- | --- |
| desktop src/main/everywhere-runner.test.ts (vector-everywhere.yml) | 49 pass, 0 fail, 355 expects | 52 pass, 0 fail, 412 expects |
| desktop src/main/everywhere-git.test.ts (vector-everywhere.yml) | 8 pass, 0 fail, 88 expects | 9 pass, 0 fail, 96 expects |
| core test/local-mode/sources.test.ts (no lane workflow) | 15 pass, 0 fail, 49 expects | 16 pass, 0 fail, 55 expects |
| engine test/compliance/egress-inventory.test.ts (no lane workflow; unchanged, scans no desktop code) | 5 pass, 0 fail, 12 expects | 5 pass, 0 fail, 12 expects |
| app src/features/local/local-model.test.ts (no lane workflow; "every source has a name of its own", the Off in Vector Local list, the copy words) | 39 pass, 0 fail, 1014 expects | 39 pass, 0 fail, 1025 expects |
| app src/components/settings-v2/local-model.test.ts (no lane workflow) | 15 pass, 0 fail, 36 expects | 15 pass, 0 fail, 36 expects |
| root test/hosted-clients.test.ts (reads sources.ts between `cloud-computer` and `phone-alerts`; run from test/) | not run | 8 pass, 0 fail, 50 expects |
| `bun typecheck` in packages/core, engine, desktop and app | | exit 0 each |
| prettier (`semi: false`, `printWidth: 120`) | | sources.ts, sources.test.ts and local-model.ts conform. The four desktop files do not conform at HEAD (hand-packed); their prettier diff grows from 316/391/166/197 lines to 332/454/167/253 (runner, runner test, git, git test), all in this package's hunks in the files' own style, with `localAllows` reflowed to prettier's form |
| `git diff` scan for personal paths and email addresses | | none (the git test's `fixture@example.invalid` is the file's existing fixture identity) |

**Mutations:** thirteen, one source file at a time, the named test file run alone, each restore's sha256 checked (/tmp/vector-v2/everywhere/ev15-mut/: mutations.py, round1/ and round2/ with one log per run). Every mutation is red; the table and the case each one turned red are in the deviations entry. Round one was stopped by the 30-minute background limit while M11 ran on sources.ts (each run waited about three minutes for the shared Bun lock); the file was restored by hand to the same sha256 and M11 to M13 ran again in round two.

**Final-state run (2026-11-16, after the mutations, with every restore checked).** The runner's `localAllows` was reflowed to prettier's form and sources.test.ts formatted after the first runs, so each file and typecheck ran again on the final sources, through `vector-serial`, one at a time (logs in /tmp/vector-v2/everywhere/ev15/gate/):

| Check | Result |
| --- | --- |
| desktop src/main/everywhere-runner.test.ts | 52 pass, 0 fail, 412 expects |
| desktop src/main/everywhere-git.test.ts | 9 pass, 0 fail, 96 expects |
| core test/local-mode/sources.test.ts | 16 pass, 0 fail, 55 expects |
| engine test/compliance/egress-inventory.test.ts | 5 pass, 0 fail, 12 expects |
| app src/features/local/local-model.test.ts | 39 pass, 0 fail, 1025 expects |
| app src/components/settings-v2/local-model.test.ts | 15 pass, 0 fail, 36 expects |
| `bun typecheck` in packages/desktop, core, engine and app | exit 0 each |

The full `bun turbo typecheck --concurrency=2` is the pre-push gate and was not run here (no commit or push in this task).

**Not done here (the task said not to commit):** the commit (`feat(everywhere): decide laptop jobs by Vector Local's everywhere source`, staging by path the seven code and test files above, app src/features/local/local-model.test.ts (review round one) and the four lane documents; the body says no generated file, flag, env var, dependency or workflow changed), the full `bun turbo typecheck --concurrency=2` before the push, the push, and the workflow_dispatch runs of vector-everywhere.yml and typecheck.yml on everywhere-finish, whose run ids go in the next lane-docs commit; the handoff's EV-15 bullet keeps "CI pending" until then.

### EV-15 review round one (2026-11-16)

Eight non-blocking findings; each is taken or recorded (deviations log, "2026-11-16, EV-15", "Review round one"). Left in the working tree, not committed. HEAD is still `cb2a73ba`; nothing was fetched or merged for this round.

**Files** (line numbers after the change):

- packages/desktop/src/main/everywhere-runner.ts (+4): the `github` need refuses whenever Vector Local is on, with a dated comment naming EV-21 (:128-131).
- packages/desktop/src/main/everywhere-git.ts: `localBlocks(remote, method)` forwards the method to `Egress.decide` (:37-47); `fetch` passes `GET` (:143) and `push` `POST` (:173).
- packages/app/src/features/local/local-model.ts (+5): `everywhere` in `KEPT_OFF` with a fixed reason (:148-149) and a comment (:145-146).
- packages/desktop/src/main/everywhere-runner.test.ts: R2 retitled, two more refusing policies (all three allowed by the user and by the company, :248-251), and its success case now runs with Vector Local off (:261-266).
- packages/desktop/src/main/everywhere-git.test.ts: the Vector Local case (:120-190) has a named `answer` with one early return per git call, asserts `GET` for the fetch's log line and `POST` for the push's, and is in prettier's form.
- packages/app/src/features/local/local-model.test.ts (+9): `everywhere` in the never-offers list (:238) and its row checked (:292-300).
- Lane documents: the deviations entry ((a), (c), (h), (i), (j), Safe by default, Left open, round-three mutations, Review round one), this receipt, the spec's four EV-15 notes and the handoff's EV-15 bullet and Left open item.

**Checks**, each through `vector-serial`, one file at a time from the owning package with `--timeout 30000` (desktop with `--no-env-file`, app with `--isolate`), on the final sources:

| Check | Result |
| --- | --- |
| desktop src/main/everywhere-runner.test.ts (vector-everywhere.yml) | 52 pass, 0 fail, 420 expects |
| desktop src/main/everywhere-git.test.ts (vector-everywhere.yml) | 9 pass, 0 fail, 96 expects |
| core test/local-mode/sources.test.ts (no lane workflow; unchanged this round) | 16 pass, 0 fail, 55 expects |
| engine test/compliance/egress-inventory.test.ts (no lane workflow; unchanged this round) | 5 pass, 0 fail, 12 expects |
| app src/features/local/local-model.test.ts (no lane workflow) | 39 pass, 0 fail, 1030 expects |
| app src/components/settings-v2/local-model.test.ts (no lane workflow) | 15 pass, 0 fail, 36 expects |
| `bun typecheck` in packages/desktop and app | exit 0 each |
| `bun typecheck` in packages/core and engine | not re-run: this round changes no core or engine file; the earlier exit 0 stands |
| prettier (`semi: false`, `printWidth: 120`) | app local-model.ts and local-model.test.ts conform; `localAllows` and the git case are in prettier's form; R2's two pre-existing long `expect` lines keep the file's hand-packed style |

**Mutations, round three:** nine, run with round3.py (/tmp/vector-v2/everywhere/ev15-mut/round3/; the four git mutations again after the git case's reflow). M14 (the guard removed), M2, M3, M12, M13, M15 and M16 are red; M1 and M4 are green, as predicted: with the guard they change no outcome, and both turn red again once EV-21 removes it. Table in the deviations entry. Both source files matched round3/before.sha after every run.

**Commit gate (2026-11-16).** `git fetch origin release-finish main everywhere-finish`: HEAD was still `cb2a73ba` = origin/everywhere-finish, holding origin/release-finish `67ec3a60`. origin/main is `3ab7858e`, 35 commits and 45 files past the merge base `67ec3a60`, none of them this package's files; it is not merged here (the lead merges main into this branch). The working tree held only this package's twelve paths (the eight code and test files and the four lane documents). Re-run at the gate, each through `vector-serial`, one file at a time from the owning package with `--timeout 30000` (desktop with `--no-env-file`, app with `--isolate`; logs in /tmp/vector-v2/everywhere/ev15/commit-gate/):

| Check | Result |
| --- | --- |
| desktop src/main/everywhere-runner.test.ts | 52 pass, 0 fail, 420 expects |
| desktop src/main/everywhere-git.test.ts | 9 pass, 0 fail, 96 expects |
| core test/local-mode/sources.test.ts (no lane workflow) | 16 pass, 0 fail, 55 expects |
| engine test/compliance/egress-inventory.test.ts (no lane workflow) | 5 pass, 0 fail, 12 expects |
| app src/features/local/local-model.test.ts (no lane workflow) | 39 pass, 0 fail, 1030 expects |
| app src/components/settings-v2/local-model.test.ts (no lane workflow) | 15 pass, 0 fail, 36 expects |
| root test/hosted-clients.test.ts (run from test/) | 8 pass, 0 fail, 50 expects |
| `bun typecheck` in packages/core, desktop, app and engine | exit 0 each |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | 27 of 27 tasks successful, exit 0 |

Committed as `feat(core): register the everywhere egress source for Vector Local` (the lead's title, in place of the one proposed above), staging by path the eight code and test files and the four lane documents. After the push, vector-everywhere.yml, vector-hosted-ci.yml, vector-at-mention.yml, vector-codium.yml and typecheck.yml are dispatched on everywhere-finish; their run ids go in the next lane-docs commit, and the handoff's EV-15 bullet keeps "CI pending" until then.

## EV-16: session-scoped offline shell for unattended sessions (2026-11-16)

Package EV-16 (spec §11 R-M2; vector-everywhere-main-requests.md "R-M2"; §5 E7): a session the owner creates with `vector.unattended` and `vector.unattended.shell: "offline"` runs every command of its own and of the sessions below it only in the engine's offline sandbox (Linux with bubblewrap), and none where that cannot be applied; the marks never change after creation; the owner-only probe `GET /experimental/shell/unattended` reports `offline-v1` or `none`. Decisions and deviations: vector-everywhere-deviations.md, "2026-11-16, EV-16". Built in the working tree and not committed, as the task said.

**Base.** `git fetch origin release-finish main everywhere-finish` and every lane tip: HEAD `12b3ad09` equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged. origin/main is `3ab7858e`; PR #33 has merged, and of the lane notes' two rules on merging main this package follows the one EV-14 and EV-15 followed (the lead merges main into this branch), because it was asked to leave its work uncommitted and so cannot make a merge commit; `git diff --stat 67ec3a60 origin/main` over this package's files is empty (main changes test.yml and other files, none of these). No review-fixes or brain-transport precondition. docs/vector/build/v2-spawn-review.md was read before shell.ts was touched: no new spawn site in the shell or terminal tools; one fixed system helper (the bubblewrap self-test) through the spawner, which owns and signals it.

**Files** (line numbers after the change):

- packages/core/src/everywhere/frame.ts (+4): `UNATTENDED_SHELL_KEY` and `UNATTENDED_SHELL_OFFLINE` (:32-35).
- packages/core/test/everywhere/frame.test.ts (+4): imports and two pins in "metadata and title".
- packages/engine/src/session/unattended-shell.ts (new, 212 lines): `MARKS`, the five messages, `admission` (:62), `changes` (:75), `differs` (:83), `marked` (:96) with `find`, `lineage` and `above`, `policy` (:142) and `refusal` (:163) with the self-test, `replayRefusal` (:175).
- packages/engine/src/tool/shell/sandbox.ts (+169/-9): scope-finish `a6fd38d3`'s workspace mode, byte for byte (`writes` :387-395, :447-467, :480-482, :500-541, helpers :600-634; not its `reason` field); new `UNATTENDED_NOTICE`, `UNATTENDED_REFUSAL`, the environment allowlist and caches, `unattendedBinary` (:328), `unattended` (:341), `unattendedEnvironment` (:354) and `rootOnly` (:367); two imports.
- packages/engine/src/tool/shell.ts (+17/-5): import (:42), `sessions` (:1905), `unattended` in `run`'s and `background`'s inputs (:1930, :2161) and their plans (:1976, :2168), the marked-session refusal in `execute` (:2235-2244), both input literals; one comment sentence in `cmd()` (:1225).
- packages/engine/src/tool/terminal.ts (+6): import (:20), `sessions` (:261), the refusal at the top of `run` (:679-682).
- packages/engine/src/tool/subagent-lifecycle.ts (+9/-5): import (:26) and `setPublicMetadata` (:391-408).
- packages/engine/src/server/routes/instance/httpapi/handlers/session.ts (+12): import (:23), `create` (:227-231), `update` (:301-303), `shell` (:531-533).
- packages/engine/src/server/routes/instance/httpapi/handlers/sync.ts (+5): import (:5), the replay check (:57-61).
- packages/engine/src/server/routes/instance/httpapi/groups/experimental.ts (+40): `shellUnattended` (:209), `UnattendedShellPolicy` (:235-239), `UnattendedShellApi` (:715-746).
- packages/engine/src/server/routes/instance/httpapi/handlers/experimental.ts (+26/-7): two imports, `UNATTENDED_SHELL_OWNER` and the module-level `requireOwner(message)` (:593-598, EV-13's closure moved out), the two EV-13 calls, `unattendedShellHandlers` (:667-680).
- packages/engine/src/server/routes/instance/httpapi/api.ts (+2/-1) and server.ts (+2/-1): the import and the registration.
- packages/engine/test/server/httpapi-exercise/index.ts (+17): `shell.unattended.policy` and `session.create.unattended-shell.invalid` (:1450-1466).
- .github/workflows/vector-everywhere.yml (+15): the "Install bubblewrap" step and `VECTOR_TEST_REQUIRE_BWRAP: "1"`.
- packages/engine/test/everywhere/offline-shell.test.ts (new, 834 lines, fourteen tests; sixteen after review round one, below):
  - "only the owner creates an offline-only session, and only with the one accepted value": owner 200 with both marks; guest-marked 403 `OWNER_ONLY` and the session list unchanged; guest credentials 403; `"online"` and the shell key alone 400 `INVALID`; `vector.unattended` alone from a guest-marked request still 200;
  - "no update changes the marks: PATCH keeps them, refuses a change, and a fork copies them": for the owner and a guest-marked request, adding either mark (with a title) to a plain session is 403 `FIXED` and changes nothing; metadata without the marks keeps them; a changed or `null` mark 403; an equal write 200; the fork carries both;
  - "a sync replay cannot change the marks or set them without the owner": a replayed update without the marks or with a changed one 403 `FIXED` and the marks stay; the same update with the marks as they are 200 (control); a replayed creation with `"online"` 403 `INVALID`; a guest-marked replay 403; no session made;
  - "the owner can ask whether this engine keeps an unattended session's commands offline": owner 200 with the expected answer; guest-marked and guest 403 with the fixed text; no credentials 401; with no bubblewrap on PATH, and with a bubblewrap that exits 1, `none`;
  - (Linux, bubblewrap) "reach no server on this computer, no host socket and no secret variable, and write only in the checkout": one probe script through the real prompt route in a marked session, a session below it and a plain session in the same engine: marked and child give `tcp=7`, `unix=7` (a `Bun.serve` Unix socket under /tmp/vector-v2/everywhere/ev16-*), the /run entry absent, no `*_TOKEN` and no `*_PAT` value, a cache write under $XDG_CACHE_HOME, the write in the checkout, the notice first and in metadata; the plain session reaches both servers, sees /run and both values, and has no sandbox;
  - (Linux, bubblewrap) "a background command runs in the offline sandbox too": `exit=7` from the background job's loopback request;
  - "terminals and the session's own shell route never run anything for it": terminal `open` and `list` fail with `TERMINAL` for the marked session and its child, no marker; POST /session/:id/shell 403 `USER_SHELL` for both, no marker; the plain session's 200 and its marker (control);
  - (where `offline-v1` does not hold: test.yml's Linux shards without bubblewrap, Windows, macOS) "where the offline sandbox is missing, a command is refused and never run";
  - tool level: "is refused before anything is asked, and nothing runs, on any platform without the sandbox" (no bubblewrap on PATH where it exists; a stored marked session and an unstored one whose context parent is marked; nothing asked, no marker; the plain session runs);
  - `Sandbox.unattended`: refused for win32, darwin, freebsd and Linux without bubblewrap; a bubblewrap anyone may write is refused; (Linux) the bubblewrap arguments and the exact environment; (Linux) "a command it wraps cannot read the home folder's secrets, which a command outside it can" (runs the wrapped bubblewrap); "bubblewrap works on this runner" (only with `VECTOR_TEST_REQUIRE_BWRAP=1`).
- Regenerated with ./packages/sdk/js/script/build.ts (two runs, the second byte-identical by sha256): packages/sdk/openapi.json (+62), packages/sdk/js/src/gen/sdk.gen.ts (+30), packages/sdk/js/src/gen/types.gen.ts (+33), packages/sdk/js/src/v2/gen/sdk.gen.ts (+29), packages/sdk/js/src/v2/gen/types.gen.ts (+33); additions only, no untracked output. packages/client: `bun run generate` and `bun run check:generated` exit 0, no change.
- Lane documents: vector-everywhere-deviations.md (the EV-16 entry), this receipt, vector-everywhere-main-requests.md (R-M2 status), vector-everywhere-spec.md (dated EV-16 notes on the `Sandbox.offline` bullet, §3.5 step 5's bash bullet, E7, §6.4, §7 Stage B and §11 R-M2), vector-everywhere-handoff.md (an annotation on the "Component tests" gate, a "Current gates" bullet, an annotation on EV-14's Left open item and a new Left open item).
- No flag, runtime environment variable, config key, dependency, lockfile, config.json, workflow.json or help snapshot changed. One test-only variable, VECTOR_TEST_REQUIRE_BWRAP, is set only in vector-everywhere.yml.

**Checks**, each through `vector-serial`, one file at a time from the owning package with `--timeout 30000`, engine and core with `TMPDIR=/tmp/vector-v2/everywhere-finish/ev16/tmp` (logs: /tmp/vector-v2/everywhere/ev16/before/, after/, final/ and runs/):

| Check | Before (HEAD `12b3ad09`) | After |
| --- | --- | --- |
| engine test/everywhere/offline-shell.test.ts (new) | n/a | 12 pass, 2 skip (the "sandbox missing" case and the CI guard), 0 fail, 176 expects; with `VECTOR_TEST_REQUIRE_BWRAP=1` 13 pass, 1 skip, 177 expects; final-state run 12 pass, 2 skip, 176 expects |
| engine test/tool/shell-sandbox-local.test.ts (the brief's regression file) | 9 pass, 2 skip, 30 expects | 9 pass, 2 skip, 30 expects (twice) |
| engine src/tool/shell/sandbox.test.ts | 12 pass, 12 skip, 126 expects | 12 pass, 12 skip, 126 expects |
| engine test/tool/shell.test.ts | 63 pass, 475 expects | 63 pass, 475 expects |
| engine test/tool/terminal.test.ts | 55 pass, 290 expects | 53 pass, 2 fail in the first build ((g)); after the fix 55 pass, 290 expects (twice) |
| engine test/tool/subagent-lifecycle.test.ts | 18 pass, 80 expects | 18 pass, 80 expects |
| engine test/server/session-metadata.test.ts | 3 pass, 52 expects | 3 pass, 52 expects |
| engine test/server/session-audience.test.ts (sync replay) | 12 pass, 115 expects | 12 pass, 115 expects |
| engine test/server/httpapi-session.test.ts | not run | 26 pass, 142 expects |
| engine test/control-plane/workspace.test.ts (warp replays) | not run | 39 pass, 156 expects |
| engine test/server/auth-guest.test.ts | 28 pass, 271 expects | 28 pass, 271 expects |
| engine test/server/httpapi-experimental.test.ts | 9 pass, 42 expects | 9 pass, 42 expects |
| engine test/server/httpapi-public-openapi.test.ts | 20 pass, 215 expects | 20 pass, 215 expects |
| engine test/everywhere/unattended-session.test.ts | 5 pass, 187 expects | 5 pass, 193 and 209 expects (its polling loops vary the count) |
| engine test/everywhere/worktree.test.ts | 18 pass, 438 expects | 18 pass, 438 expects |
| core test/everywhere/frame.test.ts | 18 pass, 465 expects | 18 pass, 467 expects (the two new pins) |
| web test/everywhere-lane.test.ts | 13 pass, 151 expects | 13 pass, 151 expects |
| cloud src/workflow-compliance.test.ts | 53 pass, 967 expects | 53 pass, 967 expects |
| sdk/js test/v1-schema.test.ts and test/wire-compat.test.ts | 1 pass, 2 expects; 10 pass, 24 expects | the same, after the regeneration |
| `bun run test:httpapi` in packages/engine (coverage, auth, effect; `--fail-on-missing --fail-on-skip`) | pass=366 (EV-13's receipt) | pass=368 fail=0 skip=0 missing=0 extra=0 in each mode, the two new scenarios among them |
| ./packages/sdk/js/script/build.ts, twice (fresh XDG roots in /tmp/vector-v2/everywhere-finish/ev16-xdg) | | exit 0; the five files above; the second run byte-identical (sha256, runs/sdk1.sha = runs/sdk2.sha) |
| `bun run generate`, then `bun run check:generated` in packages/client | | exit 0 each, packages/client unchanged |
| `bun typecheck` in packages/core, packages/engine (includes the tests) and packages/sdk/js | | exit 0 each |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | | 27 of 27 tasks successful, exit 0 |
| prettier | | unattended-shell.ts, offline-shell.test.ts and sandbox.ts conform; shell.ts, subagent-lifecycle.ts, session.ts, sync.ts, api.ts and server.ts conform as at HEAD; frame.ts, frame.test.ts, terminal.ts, groups/handlers experimental.ts and the exerciser keep exactly HEAD's prettier diff (3, 22, 28, 108, 129, 126 lines), so the added hunks conform |
| Lines over 120 columns added | | string literals and template strings only (messages, the OpenAPI description, two curl lines in the test) |
| `git diff` scan for personal paths and email addresses | | none |

**Mutations:** nineteen, on the source files alone, each with the new test file run alone (/tmp/vector-v2/everywhere/ev16-mut/): nineteen red, every file's sha256 checked after each restore. Table in the deviations entry.

**Found while testing:**
- terminal.test.ts's subagent cases pass an unstored `parentID`, and the first build refused them ("The conversation ancestry of this command could not be verified.", two failures): `marked` now judges an unstored session by its context parent only when that parent is stored (deviations (g)); 55 of 55 pass again.
- Bun reads `os.homedir()` once at start, so the plan's in-process fake HOME could not move the profile's protected home; the home-secret case now runs the wrapped bubblewrap directly, and `unattended` sets the command's HOME to the protected home (deviations (b), (l)).
- Real guest credentials scoped to no workspace are refused before the create check ("Guest credential is not scoped to this workspace or session"), and POST /sync/replay is owner-only at the middleware; the tests assert the guest-marked path for the messages and plain 403s for those.

**Coordination:** `git merge-tree --write-tree` of a temporary commit of the working tree against every lane tip: clean for main, codium-finish, hands-finish, native-qualify, brain-transport, review-fixes and workspaces-finish; scope-finish and connect-finish conflict only in packages/core/src/review/model-evidence.ts, as HEAD alone already does. Details in the deviations entry.

**Not done here (the task said not to commit):** the commit (`feat(engine): run an unattended session's shell only in a no-network sandbox`, the lead's title, staging by path exactly the 26 paths listed under "Commit paths" in "EV-16 review round one" below; the body names the regenerated files and their generator, says packages/client is unchanged, names the workflow step and the test-only VECTOR_TEST_REQUIRE_BWRAP, and says no flag, runtime variable, config key, dependency or lockfile changed), the full `bun turbo typecheck` before the push, the push, and the workflow_dispatch runs of vector-everywhere.yml and typecheck.yml on everywhere-finish, whose run ids go in the next lane-docs commit.

### EV-16 review round one (2026-11-16)

Eighteen non-blocking findings (several repeat one another); each is taken or recorded (deviations log, "2026-11-16, EV-16", "Review round one"). Left in the working tree, not committed. HEAD is still `12b3ad09` (= origin/everywhere-finish, holding origin/release-finish `67ec3a60`); `git fetch` showed scope-finish at `4ca3ce5f` and main at `2f64aca2`, nothing was merged, and `git diff --stat 67ec3a60 origin/main` over this package's files is still empty.

**Files** (line numbers after the change):

- packages/engine/src/session/unattended-shell.ts (now 250 lines): `KEPT` (:26); `SELF_TEST` exported and ending `/bin/sh -c :` (:40-60); `admission` refuses a null `vector.unattended` (:69-75); `marked` and `lineage` (:102-148): a missing ancestor ends the lineage, a loop or more than 64 levels still dies; `policy(spawner, platform?)` (:155), the uncached `selfTest(spawner, binary)` (:167) and `refusal(spawner, platform?)` (:185); `decodeReplayed` (`Schema.decodeUnknownOption`, :196) in place of `metadataOf` and both casts; `replayRefusal` (:216) also refuses a replayed deletion or move of a session of a marked lineage.
- packages/engine/src/tool/shell/sandbox.ts (now +221/-9 against HEAD): `UNATTENDED_NOTICE` narrowed (:289); `UNATTENDED_SECRETS` (:325); `unattended` (:358) binds the checkout's `.git` read-only and hides the stores, inserted before `--remount-ro` or `--chdir`, and refuses a `.git` link; `gitMetadata` (:392) and `hiddenStores` (:399); a one-line NOTE above `wrapCommand` (:428). The ported scope-finish hunks are unchanged.
- packages/engine/test/everywhere/offline-shell.test.ts (now 947 lines, sixteen tests): the creation case adds the null `vector.unattended` 400; the replay case is now "a sync replay cannot change the marks, set them without the owner, or cut a session off from them" (deleting the marked session, deleting then re-creating it, deleting the child, moving the child: 403 `KEPT`; deleting the plain session: 200 and 404 after; an orphan replayed with a missing parent runs its POST /session/:id/shell); the end-to-end probe writes `.git/hooks/post-checkout` (refused in the marked session and its child, written in the plain one); the argument case checks the ~/.docker tmpfs, the ~/.git-credentials bind, the `.git` bind after the checkout's own bind, and a `.git` link's refusal; the home-secrets case reads ~/.git-credentials; new "the capability an engine reports" describe: `policy` and `refusal` for win32 and darwin (`none`, `UNATTENDED_REFUSAL`), and `selfTest` on a fake bubblewrap (records exactly `SELF_TEST`; exit 1 false, exit 0 true; skipped on Windows only).
- Lane documents: the deviations entry ("What changed", "The sequence", (a), (d), (g), (h), new (n)-(q), Safe by default, Left open, round-two mutations, Coordination with the land order, Review round one), this receipt, main-requests.md's R-M2 status and residuals, the handoff's EV-16 gate bullet and Left open item (three runner preconditions and a merge note), and the spec's EV-16 notes (§5 E7's wording, §6.4's numstat now +17/-5, §11 R-M2's wording).
- Not changed this round: shell.ts (+17/-5), terminal.ts, subagent-lifecycle.ts, the route handlers, the probe's API, core frame.ts and its test, the workflow, the exerciser, and every generated file (no public HttpApi changed, so no regeneration).

**Checks**, each through `vector-serial`, one file at a time from packages/engine with `--timeout 30000` and `TMPDIR=/tmp/vector-v2/everywhere-finish/ev16/tmp`, on the final sources (logs: /tmp/vector-v2/everywhere/ev16/fix/):

| Check | Result |
| --- | --- |
| test/everywhere/offline-shell.test.ts | 14 pass, 2 skip (the "sandbox missing" case and the CI guard), 0 fail, 210 expects; with `VECTOR_TEST_REQUIRE_BWRAP=1` 15 pass, 1 skip, 211 expects |
| test/tool/shell-sandbox-local.test.ts (the brief's regression file) | 9 pass, 2 skip, 30 expects |
| src/tool/shell/sandbox.test.ts | 12 pass, 12 skip, 126 expects |
| test/tool/shell.test.ts | 63 pass, 475 expects |
| test/tool/terminal.test.ts | 55 pass, 290 expects |
| test/tool/subagent-lifecycle.test.ts | 18 pass, 80 expects |
| test/server/session-metadata.test.ts | 3 pass, 52 expects |
| test/server/session-audience.test.ts (sync replay) | 12 pass, 115 expects |
| test/server/httpapi-session.test.ts | 26 pass, 142 expects |
| test/server/auth-guest.test.ts | 28 pass, 271 expects |
| test/server/httpapi-experimental.test.ts | 9 pass, 42 expects |
| test/control-plane/workspace.test.ts (warp replays through /sync/replay) | 39 pass, 157 expects (156 before; its polling varies the count) |
| test/everywhere/unattended-session.test.ts | 5 pass, 193 expects |
| `bun run test:httpapi` (coverage, auth, effect; `--fail-on-missing --fail-on-skip`) | pass=368 fail=0 skip=0 missing=0 extra=0 in each mode |
| `bun typecheck` in packages/engine (includes the tests) | exit 0 |
| prettier | unattended-shell.ts, offline-shell.test.ts and sandbox.ts conform |
| mutations N1-N9 (/tmp/vector-v2/everywhere/ev16-mut2/, one test-file run each, sha256 restored) | nine red; table in the deviations entry |
| `git merge-tree --write-tree` of a temporary commit of the working tree | scope-finish `4ca3ce5f` and connect-finish `19c48b89`: only the pre-existing model-evidence.ts conflict (sandbox.ts auto-merges with scope-finish); main `2f64aca2`, codium-finish `c703cdf9`, hands-finish `8139e5fc`, native-qualify `2677c32c`, brain-transport `a5280117`, review-fixes `1433d105` and workspaces-finish `e37ec1b5`: clean |

The full `bun turbo typecheck --concurrency=2` is the pre-push gate and was not re-run here (no commit or push in this task); core is unchanged this round.

**Commit paths** (26, stage exactly these):

- source (11 modified and the new module): packages/core/src/everywhere/frame.ts, packages/engine/src/session/unattended-shell.ts (new), packages/engine/src/tool/shell.ts, packages/engine/src/tool/shell/sandbox.ts, packages/engine/src/tool/terminal.ts, packages/engine/src/tool/subagent-lifecycle.ts, packages/engine/src/server/routes/instance/httpapi/api.ts, packages/engine/src/server/routes/instance/httpapi/server.ts, packages/engine/src/server/routes/instance/httpapi/groups/experimental.ts, packages/engine/src/server/routes/instance/httpapi/handlers/experimental.ts, packages/engine/src/server/routes/instance/httpapi/handlers/session.ts, packages/engine/src/server/routes/instance/httpapi/handlers/sync.ts;
- tests (3): packages/engine/test/everywhere/offline-shell.test.ts (new), packages/engine/test/server/httpapi-exercise/index.ts, packages/core/test/everywhere/frame.test.ts;
- workflow (1): .github/workflows/vector-everywhere.yml;
- regenerated with ./packages/sdk/js/script/build.ts (5): packages/sdk/openapi.json, packages/sdk/js/src/gen/sdk.gen.ts, packages/sdk/js/src/gen/types.gen.ts, packages/sdk/js/src/v2/gen/sdk.gen.ts, packages/sdk/js/src/v2/gen/types.gen.ts;
- lane documents (5): docs/vector/build/vector-everywhere-deviations.md, docs/vector/build/vector-everywhere-handoff.md, docs/vector/build/vector-everywhere-main-requests.md, docs/vector/build/vector-everywhere-progress.md, docs/vector/build/vector-everywhere-spec.md.

### EV-16 commit gate (2026-11-16)

Before the commit, on the final sources (HEAD `12b3ad09` = origin/everywhere-finish, holding origin/release-finish `67ec3a60`; origin/main `2f64aca2` is not merged here, as the lane notes leave that to the lead), each through `vector-serial`, one file at a time from the owning package with `--timeout 30000` and `TMPDIR=/tmp/vector-v2/everywhere-finish/ev16/tmp` (logs: /tmp/vector-v2/everywhere/ev16/gate/):

| Check | Result |
| --- | --- |
| engine test/everywhere/offline-shell.test.ts | 14 pass, 2 skip, 0 fail, 210 expects; with `VECTOR_TEST_REQUIRE_BWRAP=1` 15 pass, 1 skip, 211 expects |
| engine test/tool/shell-sandbox-local.test.ts | 9 pass, 2 skip, 30 expects |
| engine src/tool/shell/sandbox.test.ts | 12 pass, 12 skip, 126 expects |
| engine test/tool/shell.test.ts, terminal.test.ts, subagent-lifecycle.test.ts | 63 pass (475 expects), 55 pass (290), 18 pass (80) |
| engine test/server/session-metadata.test.ts, httpapi-session.test.ts, session-audience.test.ts, httpapi-experimental.test.ts | 3 pass (52), 26 pass (142), 12 pass (115), 9 pass (42) |
| core test/everywhere/frame.test.ts | 18 pass, 467 expects |
| `bun run test:httpapi` in packages/engine | pass=368 fail=0 skip=0 missing=0 extra=0 in coverage, auth and effect modes |
| ./packages/sdk/js/script/build.ts (fresh XDG roots in /tmp/vector-v2/everywhere-finish/ev16-gate-xdg) | exit 0; the five regenerated files byte-identical to the working tree (sha256) |
| `bun run check:generated` in packages/client | exit 0, unchanged |
| `bun typecheck` in packages/core, packages/engine and packages/sdk/js | exit 0 each |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | 27 of 27 tasks successful, exit 0 |

The commit title is the lead's (`feat(engine): run an unattended session's shell only in a no-network sandbox`); it stages exactly the 26 paths above. The workflow_dispatch run ids of vector-everywhere.yml, vector-hosted-ci.yml, vector-at-mention.yml, vector-codium.yml and typecheck.yml on everywhere-finish go in the next lane-docs commit; the handoff's EV-16 bullet keeps "CI pending" until then.

### EV-16, 2026-11-17: CI follow-up

EV-16's dispatched runs at `b0240ba2`: vector-everywhere 43968505228, vector-codium 43968523282 and typecheck 43968528893 passed; vector-hosted-ci 43968511507 was cancelled by the nested call's concurrency group (ci-triage, EV-14 check). vector-at-mention 43968518358 failed two jobs. "desktop engine bundle (node)" (133654195771), step "Build the desktop engine bundle": build-node.ts's Node guard found `Bun.deepEquals` twice in src/session/unattended-shell.ts. "engine and core" (133654195515), step "Run core GitHub tests": packages/core/test/review/model-evidence.test.ts "scope > the pipeline's sources are pinned next to REVIEW_PIPELINE_REVISION" (1354 pass, 1 fail), because handlers/session.ts is a pinned review pipeline file. main's newest completed at-mention run, 43974310184 at `dabc4821`, passed. Fixed in packages/engine/src/session/unattended-shell.ts (`isDeepStrictEqual` from node:util in `changes` and `differs`) and packages/core/src/review/model-evidence.ts (`REVIEW_PIPELINE_SOURCES` to adbd991bd9da14e1, `REVIEW_PIPELINE_REVISION` stays 5); why: deviations entry, EV-16 "CI follow-up (2026-11-17)". Each through `vector-serial`, one file at a time, at HEAD `c9275df0` (logs in /tmp/vector-v2/everywhere/ci-ev18/):

| Check | Result |
| --- | --- |
| packages/core test/review/model-evidence.test.ts, before the fix | 29 pass, 1 fail (the pin, printing adbd991bd9da14e1), 392 expects |
| the same file with the fix | 30 pass, 0 fail, 393 expects |
| build-node.ts's `Bun.build` and `unguardedBunReferences` on a scratch copy of the build (same options; without `prepareGitLab`, whose in-place rewrite would reach a hardlinked dependency file; output under the scratch folder), before the fix | 2 unguarded references, both `Bun.deepEquals` in src/session/unattended-shell.ts |
| the same with the fix | 0 unguarded references |
| `node script/smoke-node-bundle.ts` on that bundle (Node v22.23.4, TMPDIR under /tmp/vector-v2/everywhere-finish/) | passed (Read tool, brain eval worker, search model wasm, computer bridge) |
| packages/engine test/everywhere/offline-shell.test.ts (fresh XDG roots; PATCH and sync replay cases use `changes` and `differs`) | 14 pass, 2 skip (the bubblewrap-gated cases), 0 fail, 210 expects |
| `Bun.deepEquals(a, b, true)` against `isDeepStrictEqual(a, b)` on 14 JSON-shaped pairs (strings, null and undefined, nested objects and arrays, key order, `{a: undefined}` and `{}`, `1` and `"1"`) | all agree |
| `bun typecheck` in packages/engine and packages/core | exit 0, exit 0 |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | 27 of 27 tasks successful, exit 0 |

## EV-17: the desktop wiring: jobs module, `pending` client and Remote registration (2026-11-16)

VE-21, R-C2, R-C3. Deviations log: "2026-11-16, EV-17".

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `b0240ba2` equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged. EV-10 `7146a98f`, EV-11 `901d9e4b` and EV-15 `bc254e85` are ancestors. origin/main moved from `7e440a27` to `dabc4821` during the package and holds PR #33. It touches none of this package's files and is not merged here: that is the lead's merge, as EV-15's commit gate recorded.

**Files** (line numbers after the change):

Updated for review round one (2026-11-17); its receipt is at the end of this section.

- packages/desktop/src/main/everywhere-wiring.ts (new, 530 lines):
  - `jobsForLink` :96, `createEverywhereJobs` :109 (`fetchSettings` :153, `read` :183, the runner's `settings` gate :224, the verifier :230, `current` :256, `evaluate` :262, `room` :287, `askOnce` :298, `requestPending` :330, `listen` :346, `syncEvents` :369, `offer` :388, `changed` :397, `refresh` :407, `start` :412, `stop` :419);
  - `everywhereSettings` :440, `projectFolder` :468, `resolveProjects` :489, `serviceAllowed` :524.
- packages/desktop/src/main/everywhere-wiring.test.ts (new, 1231 lines, 24 cases).
- packages/desktop/src/main/everywhere-runner.ts: `JobsClient.pending` :37, `PENDING_OFFERS`/`PENDING_BYTES` :41-43, `PendingAnswer` :46, `pending()` :89, `RunnerDeps.jobs` :129. `LOCAL_NEEDS` is unchanged.
- packages/desktop/src/main/everywhere-runner.test.ts: C1 :356, C2 :399.
- packages/desktop/src/main/vector-account.ts: `tokenClaims` :655 (was the private `tokenClient`), read at :578.
- packages/desktop/src/main/everywhere-engine.ts: `responseText` exported (:39).
- packages/desktop/src/main/remote-link.ts: `device()` (:875).
- packages/desktop/src/main/remote-runtime.ts: :1-2, :6, :25, :42-49, :87, :91, :103, :109-110.
- packages/schema/src/everywhere.ts: `Readiness`, `READINESS_FIELDS`, `READINESS_QUERY` (:404-444).
- api/_lib/everywhere/jobs.ts: the import (:19, :40) and the re-export (:1482-1484).
- api/_lib/everywhere/jobs-api.ts: the import (:3) and the re-export (:69-70).
- api/_lib/everywhere/config.ts: the `LAPTOP_ROUTE_WIRED` comment (:239-247).
- packages/core/src/local-mode/sources.ts: the `everywhere` source's `sends` and `note` (:401-407).
- Lane documents: this receipt, the deviations entry, dated notes in the spec, and handoff annotations.

**The new cases.** everywhere-wiring.test.ts:

| Case | Line | What it pins |
| --- | --- | --- |
| W1 | :441 | an offer frame reaches the runner; one claim with the identity's device and the sign-in; one `held` settle with the fixed text; no decline, report, fetch, commit, push or session; one more ask after the job |
| W2 | :478 | want() true keeps a connection for jobs alone: one socket, one mint, only pings, nothing binary |
| W3 | :502 | asks on the first connect, on a reconnect and after a job, each a GET with no body, the device, the sign-in and `jobs=1&remote=1&local=0&sandbox=0&wait=1&room=1&projects=1`; after "Disconnect all" the ask names the new device |
| W4 | :529 | fake clock, the app's own link timing: asks at connect, 5 and 10 minutes; off by `global.disposed` closes the link and sends nothing for 10 minutes; no timer left while off, nor after stop |
| W17 | :565 | fake clock: the relay closes `REMOTE_PAUSED`; jobs stay `on`, the five-minute ask sends nothing while the link is `paused`, and once the link is online again an ask says `remote=1` |
| W18 | :595 | fake clock, Vector Local allowing `everywhere` but not `remote`: the link reads `local-off` with no ticket minted, and eleven minutes pass with no request |
| W19 | :614 | the ticket held so the link stays `connecting` after a drop: a job that ends asks with `remote=0`; once online the next ask is `READY` |
| W5 | :639 | toggle off during a running job (test-seam worktree and a holding engine): the runner's tick aborts it, settle `cancelled`, the engine aborted, no commit or push, the jobs connection closed, `ready`, `off`, no ask after |
| W6g | :668 | guard, meant to go red at the owner's key handoff: `OFFER_KEYS` is empty and is the module's default; the ask says `jobs=0` and an offer is refused with no ledger write |
| W6 | :688 | with `keys: {}`, a relay offer, a `pending` offer and a direct offer are all refused; only the ask is sent, with `jobs=0`; no ledger write |
| W7 | :711 | absent, off, locked, no lock list, an unknown key and a 500: no socket, mint, request, ledger read or write, or git; then on, a stored lease is settled `interrupted` first and the ask follows |
| W7b | :773 | an offer that arrives while recovery's settle is held waits for it and is claimed, not declined `busy` |
| W8 | :812 | setting off: a verified offer on a pairing's connection is declined `off` (EV-11 (b)) and nothing is claimed |
| W9 | :839 | jobs on with Remote off is `needs-remote`, creates no identity, socket, request, ledger use or event stream; the listed folder is resolved by git's mapping check and one `symbolic-ref` only, and again at a second `refresh()`; `refresh()` reads a change; Remote on then connects and asks once |
| W10 | :882 | the same offer twice at once: one verification (`useOnce` attempt), one claim |
| W16 | :900 | Vector Local allowing `remote` only: the link is online, no ask, no `everywhere` Egress event; allowing `everywhere` and `remote`, the ask says `local=1`. Only this case's own network-log events are read |
| W12 | :931 | a sign-in that cannot be read: no request, offers refused, no error logged |
| W13/W14 | :954 | room for two: both offers of one answer claimed while the first job still runs; room for one: one claim and no decline |
| W20 | :995 | a reconnect while the first offer's verification is held: the ask says `room=0`, nothing more is verified, and after the release one claim and no decline |
| W21 | :1029 | `at_once` 2, two jobs that end together: the asks after them hand on at most two held offers, and after the release every one is claimed with no decline |
| W15 | :1059 | a settings change that lands while a read is held open is read again (two GETs), and jobs go off |
| W22 | :1089 | origin/HEAD moves and `global.disposed` lands while a branch read is held: the folder is read again, and a job claimed afterwards fetches the new base |
| W11a | :1123 | defaults; every non-default field mapped; the model split; off, locked, no lock list, an unknown key, 70 folders and no answer are off with no folder resolved |
| W11b | :1188 | a folder and a link to it are one folder; a missing folder is dropped before git; an unmapped folder is dropped with no branch read; origin/HEAD's base rule |

everywhere-runner.test.ts:

| Case | Line | What it pins |
| --- | --- | --- |
| C1 | :356 | for each `READINESS_FIELDS` key only its own name is `1`; the request; offers filtered and capped at 32; `action: "stop"`, a 404 `EVERYWHERE_OFF` and an HTML 404 are no jobs; 503 and 401 reject; malformed, non-JSON and over-128-KiB bodies are invalid |
| C2 | :399 | under Vector Local `pending` rejects `EgressBlocked` with nothing sent, logged as `everywhere` GET |

**Checks** (first pass; review round one's re-runs are in its receipt below), each through `vector-serial`, one file at a time from the owning package with `--timeout 30000`:

- Desktop runs used `--no-env-file`, app runs `--isolate`, and `TMPDIR=/tmp/vector-v2/everywhere/ev17-tmp`.
- Engine runs used fresh XDG roots under /tmp/vector-v2/everywhere-finish/ev17-xdg-<file>/.
- Logs are in /tmp/vector-v2/everywhere/ev17/.
- "Before" is HEAD, run here for the three changed or near files and taken from EV-15 and EV-16's receipts for the unchanged test files.

| Check | Before | After |
| --- | --- | --- |
| desktop everywhere-wiring.test.ts (new; vector-everywhere.yml) | none | 17 pass, 0 fail, 137 expects (three more runs: 17 pass each) |
| desktop everywhere-runner.test.ts (vector-everywhere.yml) | 52 pass | 55 pass, 0 fail, 456 expects |
| desktop everywhere-offer, -ledger, -git, -engine, -github, -pr, -scan, -awake | offer 2 pass | 2, 7, 9, 7, 6, 1, 4, 1 pass, 0 fail |
| desktop remote-link.test.ts (vector-hosted-ci.yml) | 32 pass | 32 pass, 0 fail, 196 expects |
| desktop remote-phone-app, remote-routes, remote-crypto, remote-notify (vector-hosted-ci.yml) | | 15, 15, 15, 6 pass, 0 fail |
| desktop config-skew.test.ts, cloud-naming.test.ts (scan desktop sources) | | 2 pass (38 expects), 1 pass |
| core test/local-mode/sources.test.ts (no lane workflow) | 16 pass, 55 expects | 16 pass, 0 fail, 55 expects |
| engine test/compliance/egress-inventory.test.ts (no lane workflow) | 5 pass, 12 expects | 5 pass, 0 fail, 12 expects |
| engine test/everywhere/config.test.ts (boots the engine) | | 19 pass, 0 fail, 68 expects |
| app src/features/local/local-model.test.ts (no lane workflow) | 39 pass, 1030 expects | 39 pass, 0 fail, 1030 expects |
| app src/components/settings-v2/local-model.test.ts (no lane workflow) | 15 pass, 36 expects | 15 pass, 0 fail, 36 expects |
| root test/hosted-clients.test.ts (run from test/) | 8 pass, 50 expects | 8 pass, 0 fail, 50 expects |
| web test/everywhere-lane.test.ts | 13 pass | 13 pass, 0 fail, 152 expects (the new test file is found by the lane's globs) |
| web test/everywhere-jobs-api.test.ts, everywhere-jobs.test.ts (the moved names) | | 22 pass; 43 pass and 9 skip (real-Redis cases, which run in the Valkey job) |
| web test/everywhere-remote-adapter.test.ts, everywhere-config.test.ts | | 20 pass, 24 pass |
| `bun typecheck` in packages/schema, core, desktop, app, web and engine (every package that imports schema everywhere.ts) | | exit 0 each |
| hosted API: `bun typecheck --project ../../tsconfig.json` from packages/engine | | exit 0 |
| the two desktop test files, `bun x tsgo --noEmit -p /tmp/vector-v2/everywhere/ev17/tc/tsconfig.json` (EV-11's pattern; desktop's tsconfig excludes tests) | | exit 0 |
| main-process bundle proxy: `bun build src/main/remote-runtime.ts --target=node --external electron` (nothing launched) | | exit 0, 389 modules, 2.0 MB; everywhere-wiring.ts alone 1.18 MB |

**Formatting and hygiene.**

- prettier conforms for everywhere-wiring.ts, everywhere-wiring.test.ts, remote-runtime.ts, remote-link.ts, sources.ts and jobs-api.ts.
- schema everywhere.ts, api jobs.ts, api config.ts and everywhere-engine.ts are hand-packed at HEAD. Their prettier drift is unchanged: 44, 520, 20 and 188 lines before and after.
- The runner and its test keep their hand-packed style in this package's hunks, as EV-15 recorded: drift 407 → 449 and 540 → 612 lines.
- The only added code line over 120 columns in a non-test file is the runner's modified import (already 240 columns at HEAD).
- A diff scan found no personal path or email.

**Mutations** (first pass; review round one's re-run is in its receipt below): 28, one source file at a time, the named test file run alone, each restore's sha256 checked (/tmp/vector-v2/everywhere/ev17-mut/: mutate.py, a log per mutation, final-run.txt). All 28 are red on the final sources. In the first round M5b survived: the interval kept running while off but sent nothing. W4 now checks that no timer is left while off, and M5b is red.

| Mutation | File | Red |
| --- | --- | --- |
| M1 want() ignores the setting | wiring | W4, W5, W7, W8 and two more |
| M2 want() ignores Remote and the identity | wiring | W9 |
| M3 no ask on connect | wiring | 11 cases, W1 and W3 among them |
| M4 no ask after a job | wiring | W1, W3, W13/W14 |
| M5 no five-minute interval | wiring | W4 |
| M5b the interval not cleared when off | wiring | W4 |
| M6 toggle off does not tell the link | wiring | W4, W5, W15 |
| M7 `takesJobs` ignores whether a key is pinned | wiring | W6 |
| M7b verify skips the signature check | wiring | W6, W10 |
| M8 the company lock ignored | wiring | W7, W11a |
| M11 the `local` flag not inverted | wiring | W3, W6, W16 |
| M12 no in-flight dedupe | wiring | W10 |
| M13 recovery at start | wiring | W7, W9 |
| M14 the ask awaits each offer in turn | wiring | W13/W14 |
| M15 the wiring turns Remote on itself | wiring | W9 |
| M16 the dedupe not canonical | wiring | W11b |
| M18 a read joins the one in flight, no rerun | wiring | W15 |
| M19 folders resolved while off | wiring | W7, W11a |
| M20 every offer of an answer handed on | wiring | W13/W14 |
| M21 reservations not held back for recovery | wiring | W7b |
| M24 no quiet skip while Vector Local blocks the service | wiring | W16 |
| M25 the event stream kept open with Remote off | wiring | W9 |
| M26 the branch read before git maps the folder | wiring | W11b |
| M9 a pending 404 throws | runner | C1 |
| M10 `action: "stop"` ignored | runner | C1 |
| M17 `remote` dropped from the needs | runner | R6 |
| M22 the pending body read unbounded | runner | C1 |
| M23 pending not labelled `everywhere` | runner | C2 |

**Cross-lane probe** over this package's files:

- codium-finish `a078c20b` touches core local-mode/sources.ts. `git merge-file` of the working tree's file with codium-finish's over the merge base `67ec3a60` exits 0 (clean).
- review-fixes `1433d105`, connect-finish `19c48b89`, hands-finish `8139e5fc`, brain-transport `27913ae3`, scope-finish `43e21b48`, workspaces-finish `e37ec1b5`, native-qualify `2677c32c` and main `dabc4821` touch none of them.

**Not done here (the task said not to commit).**

- The commit `feat(desktop): wire Vector everywhere jobs to the Remote link`. It stages by path the thirteen code and test files above (vector-account.ts among them) and the four lane documents (deviations, progress, spec, handoff).
- Its body says that no generated file, flag, env var, dependency, lockfile, workflow, route or config key changed.
- Then the push gate: `git fetch origin everywhere-finish`, the full turbo typecheck and a fast-forward push.
- Then workflow_dispatch runs of vector-everywhere.yml, vector-hosted-ci.yml and typecheck.yml on everywhere-finish. Their run ids go in a follow-up lane-docs commit.
- Not vector-codium.yml: main is not merged into this branch.

### EV-17 review round one (2026-11-17)

Twelve findings, all non-blocking. How each was taken is in the deviations log, "2026-11-16, EV-17", "Review round one". Nothing is committed (the task said so).

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `b0240ba2` still equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`. origin/main is still `dabc4821`. Nothing was merged.

**Code changed in the round:**

- everywhere-wiring.ts:
  - `room` (:287) subtracts the offers handed on and not yet reserved, and `askOnce` counts it again after the answer;
  - `askOnce` asks only while the link is `online` or `connecting`, and sends `remote` as `enabled && online`;
  - the folder cache lives in `state.folders`, replaced rather than cleared, and each read keeps the cache that was current when its answer came in;
  - the verifier reads the account with vector-account.ts `tokenClaims`, and `accountOf` and its schema are gone.
- everywhere-runner.ts: `LOCAL_NEEDS` is back to HEAD (three needs, not exported).
- everywhere-runner.test.ts: R6 (the `remote` pin), R2's extra policy and the `LocalSources` and `LOCAL_NEEDS` imports are removed.
- everywhere-wiring.test.ts:
  - new cases W6g, W17 to W22, and W9's git assertion;
  - W6 now uses `keys: {}`;
  - W16 is restructured: `remote` allowed only, then both, and it reads only the network-log events it caused;
  - fixture changes: the link's ticket request goes through `Egress.fetch("remote", …)`, git takes `base`/`hold` read at each call and records fetch's base, the ledger can hold `useOnce`, the ticket request can be held, and shared `minutes()` and `allowing()` helpers.
- Lane docs: the deviations entry ((f), (h), (j), (s), (z), Safe by default, Left open, Owner action, Mutations, the review round), the spec's EV-17 notes on §3.5 and the VE-21 row, and the handoff's EV-17 bullet and EV-15 item annotation.

**Checks**, each through `vector-serial`, one file at a time from packages/desktop with `--no-env-file --timeout 30000` and `TMPDIR=/tmp/vector-v2/everywhere/ev17-tmp`. Logs are in /tmp/vector-v2/everywhere/ev17-fix/.

| Check | Result |
| --- | --- |
| desktop everywhere-wiring.test.ts (vector-everywhere.yml) | 24 pass, 0 fail, 169 expects; four final runs, 24 pass each |
| desktop everywhere-runner.test.ts (vector-everywhere.yml) | 54 pass, 0 fail, 447 expects (HEAD's 52 plus C1 and C2) |
| desktop remote-link.test.ts (vector-hosted-ci.yml) | 32 pass, 0 fail, 196 expects |
| desktop vector-account.test.ts, vector-account-lifecycle.test.ts (`tokenClaims`; no lane workflow) | 30 pass (318 expects), 1 pass (3 expects) |
| desktop `bun typecheck` | exit 0 |
| the two desktop test files, `bun x tsgo --noEmit -p /tmp/vector-v2/everywhere/ev17/tc/tsconfig.json` | exit 0 |
| prettier `--check` on everywhere-wiring.ts and everywhere-wiring.test.ts | conforms |
| `git diff --check` over docs/ and packages/desktop/ | clean (one trailing-space line from the first pass, in (r), removed) |

The first pass's other checks (schema, core, app, web, engine and root files, the hosted-API typecheck and the bundle proxy) cover files this round did not touch, and are not re-run.

**Mutations.** 35, one source file at a time, the named test file run alone, each restore's sha256 checked (/tmp/vector-v2/everywhere/ev17-fix/mut/: mutate.py, one log per mutation, run.txt, results.json rebuilt from the logs). They are the first pass's 27 (M17 went with the `remote` need, and M10's anchor follows the schema decode) and eight new ones. All 35 are red on the final sources. N7 survived the first run, because no case refreshed twice. W9 now calls `refresh()` a second time and expects the folder resolved again, and N7 is red. Under N3, W16 also failed, but only through W18's mutated asks, which reached the process's shared network log. W16 now reads only the events it caused, and M24 and N3 were re-run afterwards: M24 is red on W16, and N3 on W17 and W18.

| Mutation | File | Red |
| --- | --- | --- |
| M1 want() ignores the setting | wiring | W4, W5, W7, W8 and 2 more |
| M2 want() ignores Remote and the identity | wiring | W9 |
| M3 no ask on connect | wiring | W1, W3, W4, W17 and 13 more |
| M4 no ask after a job | wiring | W1, W3, W19, W13/W14 and 2 more |
| M5 no five-minute interval | wiring | W4 |
| M5b the interval not cleared when off | wiring | W4 |
| M6 toggle off does not tell the link | wiring | W4, W5, W15 |
| M7 `takesJobs` ignores whether a key is pinned | wiring | W6g, W6 |
| M7b verify skips the signature check | wiring | W6g, W6, W10, W20, W21 |
| M8 the company lock ignored | wiring | W7, W11a |
| M11 the `local` flag not inverted | wiring | W3, W19, W6g, W6 and 2 more |
| M12 no in-flight dedupe | wiring | W10 |
| M13 recover at start, not at the first on | wiring | W7, W9 |
| M14 the ask awaits each offer in turn | wiring | W13/W14, W20, W21 |
| M15 the wiring turns Remote on itself | wiring | W9 |
| M16 the dedupe is not canonical | wiring | W11b |
| M18 a read joins the one in flight without a rerun | wiring | W15, W22 |
| M19 folders resolved while off | wiring | W7, W9, W11a |
| M20 every offer of an answer handed on | wiring | W13/W14, W20, W21 |
| M21 reservations not held back for recovery | wiring | W7b |
| M24 no quiet skip while Vector Local blocks the service | wiring | W16 |
| M25 the event stream kept open with Remote off | wiring | W9 |
| M26 the folder's branch read before git maps it | wiring | W9, W22, W11b |
| M9 a pending 404 throws | runner | C1 |
| M10 the off answer `action: stop` ignored | runner | C1 |
| M22 the pending body read unbounded | runner | C1 |
| M23 pending not labelled everywhere | runner | C2 |
| N1 in-flight offers not counted in the room | wiring | W20, W21 |
| N2 the answer sliced to one offer, whatever the room | wiring | W13/W14, W20, W21 |
| N3 the ask ignores the link's refused states | wiring | W17, W18 |
| N4 the ask only while online | wiring | W19 |
| N5 `remote` sent from enabled alone | wiring | W19 |
| N6 the folder cache kept across `global.disposed` | wiring | W22 |
| N7 the folder cache kept by refresh() | wiring | W9 |
| N8 the verifier ignores the sign-in's account | wiring | W1, W3, W19, W5 and 7 more |

**Not done here (the task said not to commit).** The commit plan above stands: thirteen code and test files and the four lane documents, staged by path. The push gate and the workflow_dispatch runs follow it.

## EV-18: the desktop adapters: safe worktree, offline shell and shared keep-awake (2026-11-17)

VE-21, F6. Deviations log: "2026-11-17, EV-18".

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `dcb93939` equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged. EV-13 `46471914` and `0d9f852c`, EV-16 `b0240ba2` and `dcb93939`, and EV-17 `c9275df0` are ancestors (`git merge-base --is-ancestor`). origin/main `dabc4821` holds PR #33 and touches none of this package's files; it is not merged here (the lead's). No review-fixes or brain-transport precondition applies.

**Files** (line numbers after the change):

- packages/desktop/src/main/keep-awake.ts: the desktop-work comment :388-389 and `holdDesktopWork` :471 (additive).
- packages/desktop/src/main/everywhere-awake.ts (rewritten, 36 lines): `createEverywhereAwake({onBattery, changed})`.
- packages/desktop/src/main/everywhere-engine.ts: `UnattendedShellPolicy` :12, `unattendedRules` :31 (`own` :32-39), `UnattendedCapabilities` :49, `SHELL_PROBE_MS` :54, `unattendedCapabilities` :64 (the size-only definite no :77), `localEngineOrigin` :88, `ResponseTooLarge` :111, the shell mark in `create()` :163.
- packages/desktop/src/main/everywhere-settings.ts (new, 176 lines, review round one): `RunnerSettings` :13 (moved from the runner, with `shell` :23), `EverywhereSettings` :28, `ProjectFolder` :35, `everywhereSettings` :50, `unlocked` :77, `userRules` :90, `agentPermission` :111, `decodePermission` :117, `permissionRules` :126, `expand` :135, `resolveProjects` :144, `offSettings` :161.
- packages/desktop/src/main/everywhere-runner.ts: `RunnerSettings` imported from everywhere-settings.ts :7, the `SafeWorktree` comment :105-109, `WorktreeUnavailable` :116, `UNAVAILABLE_HERE` :122, the single read :248, the typed hold :303-311, the ruleset :316.
- packages/desktop/src/main/everywhere-wiring.ts (620 lines):
  - `PROBE_RETRY_MS` :109, `RULE_KEYS` :116, `DELIVERING` :118, `Probes` :121;
  - in `createEverywhereJobs`: `worktree` :193, `awake` :194, `keepAwake` :197-201, `capabilities` :207, the probe read and the lock check in `fetchSettings` :251-254, the `safeWorktree` getter :327, `keepAwake()` in `evaluate` :345, `sandbox` :400, the probe resets :437 and :494, `awake?.dispose()` :512;
  - `unattendedWorktree` :535.
- packages/desktop/src/main/remote-runtime.ts: :2 and :49-63 (`power`).
- Tests: packages/desktop/src/main/everywhere-awake.test.ts (rewritten), everywhere-engine.test.ts, everywhere-wiring.test.ts, everywhere-runner.test.ts; packages/engine/test/everywhere/worktree.test.ts and unattended-session.test.ts (which imports `everywhereSettings` from everywhere-settings.ts, :13).
- Lane documents: this receipt and the F6 row above, the deviations entry, dated notes in the spec (§3.5 steps 4, 5 and 10; §5 E7; §8 VE-21), handoff annotations and a status bullet, and main-requests.md annotations.

**The new cases.**

| Case | Where | What it pins |
| --- | --- | --- |
| A1 | everywhere-awake.test.ts:58 | the shared blocker (a fake set with `setDesktopWorkBlocker`) is held only with jobs and the option on and AC power; power is not watched until both are on; unplugging releases at the power event; jobs off and the option off release and unsubscribe; dispose releases |
| A2 | :95 | on battery, or with the option off, nothing is ever held |
| A3 | :108 | jobs plus a `whileDesktopWorks` run share one blocker, released only once both are idle, in either order |
| A4 | :136 | a release works once and never releases another holder's hold |
| A5 | :151 | a hold taken before index.ts sets the blocker is honoured when it is set |
| E0 | everywhere-engine.test.ts:43 | the real loopback client sends both marks, `vector.unattended` and `vector.unattended.shell: "offline"`, and nothing else in `metadata` |
| E1 | :127 | `bash` is denied without `offline-v1` (default and `none`) and allowed with it; `unsandboxed_shell`, terminals, browser, task, skill, web, external_directory, private_network, computer, vector_cloud, question, MCP, connect, network_command and unknown tools are denied either way; the only added rule is `bash` after every deny; the user's own `bash` deny and ask follow it |
| E2 | :150 | the user's block as written and as the engine re-encodes it (`*` moved last) gives the same decisions: edit denied, `git status` allowed under an exact `bash` key, other commands denied, a wildcard allow never copied; a wildcard deny outranks an exact allow in any order |
| E2b | :179 | (review round one) `{"*": "ask"}` asks on every editing id, and on `bash` with `offline-v1` (denied without); `{"*": "ask", "edit": "allow"}` asks for edit and bash in both orders; a wildcard deny beside a wildcard ask denies in both orders, and an exact deny under the wildcard ask is asked |
| E3 | :208 | the probes: exact answers only; any other 200, an extra key, a non-JSON or oversized body, 404, 401 and 403 are definite noes; 503, a refused connection, a timeout, a redirect and a body that errors after its first chunk (review round one) give no answer; no query, no guest or directory header, `redirect: "error"`, the owner's authorization; a non-loopback address rejects |
| E4 | :267 | the probes against a real loopback server carry no query; `localEngineOrigin` refuses https, a remote host, credentials, a query and a fragment |
| R1 | everywhere-runner.test.ts:460 | a `WorktreeUnavailable` settles `held` with the fixed text and no session, prompt, commit or push; any other worktree error is `failed` |
| R2 | :474 | the session's ruleset is `unattendedRules(rules, shell)` for an absent, `none` and `offline-v1` shell |
| W23 | everywhere-wiring.test.ts:1314 | an engine whose probe answers 404: `pending` still says `jobs=1&sandbox=0`, a claimed job is held with the existing text, and only the two probes are sent; with `unattended-v1`: POST /experimental/worktree/unattended `{directory, base, branch, jid}` with no query, then GET /config/trust `?directory=<checkout>`, both as the owner without a guest header; the session is made in the returned checkout with bash denied; never POST /experimental/worktree |
| W24 | :1397 | a 403 is held with the fixed text; a trusted checkout, an unreadable trust answer, an extra key, a relative folder and a 500 fail the job; no session in any |
| W25 | :1502 | `offline-v1`: `pending` says `sandbox=1` and bash is allowed, also with unrelated locks only; with a company lock on `permission`, `agent`, `mode`, `tools` or `default_agent` (review round one: all but `permission`), or `none`: `sandbox=0` and bash denied; the user's bash deny holds and the unsandboxed shell, terminals, MCP and connect stay denied in all three |
| W26 | :1567 | off: no probe; on: both probes once; a timed-out shell probe is not asked again within the minute; a minute later it is, its answer is used (`sandbox=1`), and the kept 404 still holds a job; with both answered nothing more is asked; `server.connected` asks afresh; off again asks nothing |
| W27 | :1642 | `rules`: the legacy `tools` map's switched-off tools first (`write` as `edit`; a switched-on one adds nothing), the top-level block in order, `~/`, `~`, `$HOME/` and a bare `$HOME` prefix expanded as the engine does, a bare action as `*`, then the default agent's asks and denies, from `agent` and then `mode` (`build`, or `default_agent`); an undecodable top-level block, `tools` map, agent or mode block is off with no folder resolved (review round one: the tools map, `mode` and the asks) |
| W28 | :1725 | the stay-awake option through the wiring: nothing held or watched with Remote off; held when jobs go on; released by the option going off with no state change; unplug and plug; Remote off releases; the jobs module's `stop()` alone releases and unsubscribes |
| W29 | :1794 | (review round one) held while the link is online; a paused link releases it and stops watching power, with jobs still on; Remote off and on holds again; a reconnect in `connecting` keeps it; a revoked link releases it |
| G1 | engine test/everywhere/worktree.test.ts:950 | through the real route: the trusted source's committed vector.json loads (`formatter: false`), the job's checkout is `trusted: false, ignored: true, settings: true`, keeps the user's formatter setting, and lists no formatter or language server; after a formatter, a language server and a .vector folder are written over it and the instance reloads, the same holds and the marker command never ran |
| G2 | engine test/everywhere/unattended-session.test.ts:331 | through the real PATCH and GET /global/config: the answer puts `*` after `edit`; `everywhereSettings` plus `unattendedRules(…, "offline-v1")` on a real session (Permission.evaluate) deny edit, allow `git status`, deny other commands, deny the agent's `*.secret` read and allow other reads; the session carries the shell mark |
| G3 | :374 | under bubblewrap (runs where `VECTOR_TEST_REQUIRE_BWRAP=1`): a session the desktop client creates with `offline-v1` runs `true` in the offline sandbox (the notice, the output); `curl` to a server on this computer exits 7 and reaches nothing; `cat /etc/hostname` is refused; no `permission.asked` at all |

**Checks**, each through `vector-serial`, one file at a time from the owning package with `--timeout 30000`:

- Desktop runs used `--no-env-file` and `TMPDIR=/tmp/vector-v2/everywhere/ev18-tmp`.
- Engine runs used fresh XDG roots under /tmp/vector-v2/everywhere-finish/ev18-xdg-final-<file>/, with `VECTOR_TEST_REQUIRE_BWRAP=1`. This machine's bubblewrap is root-owned and starts, so G3 and offline-shell.test.ts's sandbox cases ran.
- Logs are in /tmp/vector-v2/everywhere/ev18-logs/ (the final runs in final/).
- "Before" is HEAD's test file (run here against the changed sources before the new cases were added, or the count at HEAD).

| Check | Before | After |
| --- | --- | --- |
| desktop everywhere-awake.test.ts (vector-everywhere.yml) | 1 pass | 5 pass, 0 fail, 31 expects |
| desktop everywhere-engine.test.ts (vector-everywhere.yml) | 7 pass, 529 expects | 11 pass, 0 fail, 642 expects |
| desktop everywhere-wiring.test.ts (vector-everywhere.yml) | 24 pass, 169 expects | 30 pass, 0 fail, 266 expects |
| desktop everywhere-runner.test.ts (vector-everywhere.yml) | 54 pass, 447 expects | 56 pass, 0 fail, 457 expects |
| desktop keep-awake.test.ts, computer-keep-awake.test.ts, parallel-workspaces.follow-up.test.ts (test.yml, not a lane workflow; all import keep-awake.ts) | | 34, 4, 45 pass, 0 fail |
| desktop everywhere-offer, -ledger, -git, -github, -pr, -scan | | 2, 7, 9, 6, 1, 4 pass, 0 fail |
| desktop remote-link.test.ts (vector-hosted-ci.yml), config-skew.test.ts, cloud-naming.test.ts | | 32, 2, 1 pass, 0 fail |
| engine test/everywhere/worktree.test.ts (vector-everywhere.yml) | 18 pass | 19 pass, 0 fail, 456 expects |
| engine test/everywhere/unattended-session.test.ts (vector-everywhere.yml) | 5 pass | 7 pass, 0 fail, 246 expects |
| engine test/everywhere/offline-shell.test.ts (vector-everywhere.yml; unchanged) | 15 pass, 1 skip | 15 pass, 1 skip (`liveIf(!offline)`), 0 fail, 211 expects |
| `bun typecheck` in packages/desktop and packages/engine (the engine compiles the desktop modules its tests import) | | exit 0 each |
| hosted API: `bun typecheck --project ../../tsconfig.json` from packages/engine | | exit 0 |
| the four desktop test files, `bun x tsgo --noEmit -p /tmp/vector-v2/everywhere/ev18/tc/tsconfig.json` (EV-11's pattern; desktop's tsconfig excludes tests) | | exit 0 |
| main-process bundle proxy: `bun build src/main/remote-runtime.ts --target=node --external electron` (nothing launched) | | exit 0, 2.0 MB |

**Formatting.** prettier conforms for everywhere-wiring.ts, everywhere-wiring.test.ts, everywhere-awake.ts, everywhere-awake.test.ts, keep-awake.ts, remote-runtime.ts and engine worktree.test.ts, all formatted at HEAD. everywhere-engine.ts, everywhere-runner.ts, their tests and unattended-session.test.ts are hand-packed at HEAD and keep that style in this package's hunks. A diff scan found no personal path or email.

**Mutations.** Thirty-nine, one source file at a time, the named test file run alone, each restore's sha256 checked (/tmp/vector-v2/everywhere/ev18-mut/: mutate.py, one log per mutation, run.txt). All 39 are red on the final sources. In the first pass three survived (M18b, M20's first form, M23); the fixes are in the deviations entry, "Mutations".

| Mutation | File | Red |
| --- | --- | --- |
| M1 bash allowed without `offline-v1` | engine | E1 |
| M2 the re-allow also opens `unsandboxed_shell` | engine | E1 |
| M3 the user's bash rules dropped after the allow | engine | E1, E2 |
| M4 / M4e the user's rules copied in the answer's key order (the old rule) | engine | E1, E2 / G2 |
| M5 `create()` without the shell mark | engine | E0 |
| M6 any 200 counts as the worktree answer | engine | E3 |
| M7 the probe sends `directory` | engine | E3, E4 |
| M8 a 5xx counts as a definite no | engine | E3 |
| M16 a failed connection counts as a definite no | engine | W26 |
| M9 the getter always gives the adapter | wiring | W1, W7b, W23 |
| M10 a 403 is not WorktreeUnavailable | wiring | W24 |
| M11 no trust check | wiring | W24 |
| M11b a relative folder accepted | wiring | W24 |
| M11c extra keys accepted | wiring | W24 |
| M12 `sandbox` always 0 | wiring | W25, W26 |
| M13 the company lock on `permission` ignored | wiring | W25 |
| M14 the probes run while the block is off | wiring | W26 |
| M15 a missing answer is never asked again | wiring | W26 |
| M17 no one-minute limit on asking again | wiring | W26 |
| M18 `server.connected` keeps the cache | wiring | W26 |
| M18b a later answer replaces a kept one | wiring | W26 |
| M19 / M19w the battery ignored | awake / wiring | A1, A2, A3 / W28 |
| M20 a release clears every hold | keep-awake | A3, A4 |
| M21 power watched while not armed | awake | A1 |
| M22 the stay-awake hook only on a state change | wiring | W28 |
| M23 `stop()` keeps the hold | wiring | W28 |
| M24 an undecodable permission block stays on | wiring | W27 |
| M25 `~/` not expanded | wiring | W27 |
| M26 / M26e the agent's denies dropped | wiring | W27 / G2 |
| M27 the agent's allows copied too | wiring | W27 |
| M28 / M28w WorktreeUnavailable not held | runner | R1 / W24 |
| M29 / M29w the runner ignores `settings.shell` | runner | R2 / W25 |
| M30 formatters run in an untrusted folder (engine format/index.ts) | engine source | G1 |
| M31 an untrusted folder's config kept (engine config.ts) | engine source | G1 |

**Cross-lane probe.** At the time of writing, no lane tip touches any of this package's files since its merge base: hands-finish `8139e5fc`, codium-finish `732229c3`, connect-finish `19c48b89`, scope-finish `fb441eae`, brain-transport `0d18f750`, review-fixes `1433d105`, workspaces-finish `e37ec1b5`, native-qualify `2677c32c` and main `dabc4821`.

**Review round one (2026-11-17).** Eleven findings, one blocking, all taken; the deviations entry's "Review round one" lists each. In short: the shell needs every key that can carry permission rules unlocked (`RULE_KEYS`); the default agent's asks, its `mode` block and the legacy top-level `tools` map's switched-off tools are copied; wildcard asks are copied after the exact keys and before the wildcard denies; stay awake holds only while the link can deliver offers; only an over-long probe body is a definite no (`ResponseTooLarge`); the settings and rules functions moved to the new everywhere-settings.ts, so the engine's program compiles exactly three desktop files (`tsgo --listFiles` in packages/engine: everywhere-engine.ts, everywhere-scan.ts, everywhere-settings.ts). The case table above is updated (E2b and W29 are new; E3, W25 and W27 grew).

| Check (round one, final sources; logs in /tmp/vector-v2/everywhere/ev18-logs/round1-final/) | Result |
| --- | --- |
| desktop everywhere-awake.test.ts | 5 pass, 0 fail, 31 expects (unchanged) |
| desktop everywhere-engine.test.ts | 12 pass, 0 fail, 702 expects |
| desktop everywhere-wiring.test.ts | 31 pass, 0 fail, 324 expects (also twice more before the docs, same counts) |
| desktop everywhere-runner.test.ts | 56 pass, 0 fail, 457 expects |
| engine test/everywhere/unattended-session.test.ts (fresh XDG roots and TMPDIR under /tmp/vector-v2/everywhere-finish/ev18-xdg-round1-final-unattended/, `VECTOR_TEST_REQUIRE_BWRAP=1`) | 7 pass, 0 fail, 245 expects. The count varies between runs (237, 240 and 245 here, 246 in the first pass) because `finished()` and `spend()` poll with an `expect` inside |
| `bun typecheck` in packages/desktop and packages/engine | exit 0 each |
| the four desktop test files, `bun x tsgo --noEmit -p /tmp/vector-v2/everywhere/ev18/tc/tsconfig.json` | exit 0 |
| main-process bundle proxy (`bun build src/main/remote-runtime.ts --target=node --external electron`) | exit 0, 2.0 MB |
| prettier `--check`: everywhere-settings.ts, everywhere-wiring.ts, everywhere-wiring.test.ts, everywhere-awake.ts, everywhere-awake.test.ts, keep-awake.ts, remote-runtime.ts | conforms |

Not re-run in this round, as their sources and tests did not change: engine worktree.test.ts and offline-shell.test.ts, keep-awake.test.ts, computer-keep-awake.test.ts, parallel-workspaces.follow-up.test.ts, remote-link.test.ts and the hosted API typecheck.

Mutations for this round (/tmp/vector-v2/everywhere/ev18-mut/round1/), each red on the final sources:

| Mutation | File | Red |
| --- | --- | --- |
| N1 only `permission` checked for a lock | wiring | W25 |
| N1b `tools` and `mode` left out of `RULE_KEYS` | wiring | W25 |
| N2 only the default agent's denies | settings | W27 |
| N3 the `mode` block ignored | settings | W27 |
| N4 the `tools` map ignored | settings | W27 |
| N4b `write` not read as `edit` | settings | W27 |
| N4c an undecodable `tools` map kept on | settings | W27 |
| N5 wildcard asks dropped | engine | E2b |
| N5b wildcard asks after the wildcard denies | engine | E2b |
| N5c wildcard allows copied as well | engine | E2 |
| N6 a body that breaks off is a definite no | engine | E3 |
| N6b an over-long body is no answer | engine | E3 |
| N7 the link state ignored by stay awake | wiring | W29 |
| N7b `connecting` left out of `DELIVERING` (survived until W29 got its `connecting` step) | wiring | W29 |

**Not done here (the task said not to commit).**

- The commit `feat(desktop): wire the safe worktree, the offline shell and the shared keep-awake for Vector everywhere jobs`. It stages by path the thirteen code and test files above (everywhere-settings.ts is new) and the six lane documents (deviations, progress, spec, handoff, main-requests and v2-notes/v2-complete-plan.md, whose F5 and F6 rows are annotated). Its body says that no generated file, flag, env var, dependency, lockfile, workflow, route or config key changed.
- Then the push gate: `git fetch origin everywhere-finish`, the full turbo typecheck and a fast-forward push.
- Then workflow_dispatch runs of vector-everywhere.yml, typecheck.yml and vector-hosted-ci.yml (remote-runtime.ts changed) on everywhere-finish, with their run ids recorded here and on the F6 row. test.yml (desktop) covers keep-awake.ts at the lane end.

### EV-17 and EV-18, 2026-11-17: CI follow-up

The runs dispatched for `dcb93939` (the EV-16 CI fix, on top of EV-17): vector-everywhere 43992189171, vector-at-mention 43992199429 and typecheck 43992209804 passed; vector-hosted-ci 43992194193 was cancelled by the nested call's concurrency group (ci-triage, EV-14 check). vector-codium 43992205101 failed one job, "Codium tests (shard 1/4)" (133735383740), step "Run the Codium test files" (36 of 37 files passed): root test/no-project-wording.test.ts "no user-facing English text calls Vector's own concept a project" found two everywhere-wiring.ts log lines from EV-17. At `cf9195d0` (EV-18) the same test also finds three EV-18 strings. All five are reworded in packages/desktop/src/main/everywhere-wiring.ts and everywhere-runner.ts, and the two test literals that pin the held summary follow it (why: deviations log, EV-18 "CI follow-up (2026-11-17)"). Each through `vector-serial`, one file at a time (logs in /tmp/vector-v2/everywhere/ci-ev19/):

| Check | Result |
| --- | --- |
| root test/no-project-wording.test.ts (from test/), at `cf9195d0` before the fix | 1 pass, 1 fail: five strings (everywhere-wiring.ts three, everywhere-runner.ts two) |
| the same file with the fix | 2 pass, 0 fail, 16 expects |
| packages/desktop src/main/everywhere-runner.test.ts (--no-env-file) | 56 pass, 0 fail, 457 expects |
| packages/desktop src/main/everywhere-wiring.test.ts (--no-env-file) | 31 pass, 0 fail, 324 expects |
| `bun typecheck` in packages/desktop | exit 0 |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | 27 of 27 tasks successful, exit 0 |

## EV-19: the laptop journey harness and the Slack journey (VE-22a) (2026-11-20)

VE-22 (Slack half), §9; E4, E8, E12, E17. Deviations log: "2026-11-20, EV-19".

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `503bab3b` equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged. EV-09 `735d592b`, EV-17 `c9275df0` and EV-18 `cf9195d0` are ancestors (`git merge-base --is-ancestor`). origin/main `7c7508d2` holds PR #33 and is 144 commits ahead; merging it stays the lead's (EV-14's receipt: "The lead also owns merging origin/main"). Among the journey's 148 compiled repository files, main changed only packages/core/src/github-agents.ts. No review-fixes or brain-transport precondition applies.

**Files** (line numbers after the change and after review round one):

- packages/web/test/everywhere-journey-laptop.test.ts (new, 894 lines): `STORE_LATENCY_MS` :63, `CASE_MS` :76, the relay Worker on 127.0.0.1 :88, `bounded` :143, `gate` :150, `codiumFetcher` :164, `seedPlan` :176, `world` :207 (the slow store :235-246, the ports :248-262, the routing sleep :265-270, the jobs routes and the sweep :281-310, the native call log :313-322, the desktop :324-470, `turn` :477, the teardown :508), `onlyJob` :548, `admit` :563 (the E12 bound :573), `laptopJourney` :582 (routing :585, started :614, editing :637, pushing :653, settle :668, E8 :689), `offlineJourney` :708, `expectSharedResult` :750; the cases :781 to :883.
- api/_lib/everywhere/slack/adapter.ts: `SlackDeps.sleep?` :26 (additive).
- api/_lib/everywhere/slack/routes.ts: `sleep: deps.sleep` in the intake's options :18.
- packages/web/test/lib/everywhere-router.ts: `routerFixture(options)` :17 (its comment :13-16), `env` :20 and in the return :71.
- packages/web/test/lib/everywhere-slack.ts: the `Store` type import :5, `slackFixture(options)` :44-45.
- Lane documents: this receipt and the F5 row annotation above, the deviations entry, a dated note under the spec's §8 Phase 3 rows, a handoff status bullet, a "Current gates" bullet and two "Left open" items, and the F5 row of v2-notes/v2-complete-plan.md.

**The cases.**

| Case | Line | What it pins |
| --- | --- | --- |
| J1 | :781 | the Slack journey in a shared channel, steps 1 to 9 (deviations entry, "The journey"), the job record `shared`: 200 before any store command; the first signal within 2,500 ms with 19 slow store commands before it; one presence and one offer; one claim inside the window; `started`, `editing` and `pushing` each with its own setStatus and plan update; push only after the `pushing` acknowledgement; settle `changes` with the PR in the job's repository; body and summary erased; only the outcome and link in the thread, the summary and checks line in the ephemeral; no device id in any Slack call; nothing in plaintext in the store's command log; late claims 409 `JOB_TAKEN` |
| J2 | :798 | the same journey from a direct message: private place, the summary in the reply, the repository and task in the title, no ephemeral |
| J3 | :818 | no computer online: waits until `receivedAt + queueMs` (before the body expires), a sweep 1 ms before ends nothing, the sweep at the limit expires it with Slack's own text |
| J4 | :826 | an offer the pinned key does not verify: no claim, no decline, no jti consumed, ten polls, then the job waits |
| J5 | :849 | the fetch guard is the fetch in place and stops a probe to a reserved `.invalid` name, the file's only non-loopback request |
| R1 | :869 | J1 on a real Redis (VECTOR_TEST_REDIS_URL), the job settled and `shared` there and the FakeStore untouched |
| R2 | :883 | J3 on a real Redis, the job expired there and the FakeStore untouched |

**Checks** (each through /home/user/.tools/vector-serial, one file at a time from the package, `--timeout 30000`; logs in /tmp/vector-v2/everywhere/ev19/).

| Check | Before (HEAD) | After |
| --- | --- | --- |
| web test/everywhere-journey-laptop.test.ts (vector-everywhere.yml), three runs | (new) | 5 pass, 2 skip, 0 fail, 208 expects, each run (211 after review round one, below) |
| the same file with a disposable loopback redis-server 7.0.15 (informational; CI's Valkey job is the receipt) | (new) | 7 pass, 0 fail, 324 expects; the database empty afterwards (329 after review round one) |
| web everywhere-slack-events / -slack-render / -slack-oauth | 12 / 10 / 4 pass, 94 / 51 / 26 expects | identical |
| web everywhere-intake / -router / -remote-adapter | 8 / 9 / 20 pass, 68 / 37 / 185 expects | identical |
| web everywhere-authority / -control / -github / -sweep | 20 pass 7 skip / 13 / 17 / 11 pass; 225 / 123 / 137 / 99 expects | identical |
| web everywhere-linear-oauth / -linear-render / -linear-webhook | 15 / 11 / 15 pass (4 skip); 112 / 74 / 146 expects | identical |
| web everywhere-jira-a2a / -jira-fit / -jira-render | 20 pass 3 skip / 4 / 6; 251 / 26 / 48 expects | identical |
| web everywhere-jobs-api / -lane | 22 / 13 pass; 226 / 153 expects | identical |
| desktop src/main/everywhere-offer.test.ts and everywhere-runner.test.ts (--no-env-file; unchanged) | | 2 pass 11 expects; 56 pass 457 expects |
| `bun typecheck` in packages/web (astro check) | | 0 errors, 0 warnings, 415 hints (the new file adds 3 `await expect(...).rejects` hints, ts(80007), the pattern other web tests have; 412 before). After review round one: 414 (the new file adds 2) |
| hosted API: `bun typecheck --project ../../tsconfig.json` from packages/engine | | exit 0 |
| `bun typecheck` in packages/desktop | | exit 0 |
| `bun x tsgo --noEmit --listFiles -p /tmp/vector-v2/everywhere/ev19/tc/tsconfig.json` (extends packages/web's) | | exit 0; eight desktop files (everywhere-runner, -engine, -scan, -git, -ledger, -settings, -offer, github-api), no electron file, every core (25) and schema (17) file under `src/` |
| prettier --check on the new file | | clean |
| prettier drift, HEAD → after (hand-packed files keep their style) | router 140, slack 76, slack/adapter 339, slack/routes 60 lines | 141, 76, 339, 61 |
| `git diff --check`; personal paths or emails in the changed files | | clean; none |

**Mutations.** Fourteen, M1 to M14, each red; the table with the failing lines is in the deviations entry. M12 (the router fixture ignoring `options.store`) is red only with a Redis: locally against the loopback redis-server, in CI in the Valkey job.

**E12 measurement.** 19 store commands before the first `setStatus` at HEAD (1,900 ms at 100 ms each); 50 with the acknowledgement moved after `routeFacts` (5,000 ms).

**Cross-lane probe.** review-fixes `1433d105` and connect-finish `19c48b89` touch none of this package's paths; codium-finish `58663f5b`, brain-transport `0d18f750` and main `7c7508d2` change v2-notes/v2-complete-plan.md at :219-221 only, away from the F5 row this package annotates (:197).

### EV-19 review round one (2026-11-20)

Eight findings, none blocking. How each was taken is in the deviations log, "2026-11-20, EV-19", "Review round one". **Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `503bab3b` still equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged. origin/main moved from `7c7508d2` to `b5cbad1c` (185 commits ahead of HEAD); merging it stays the lead's. Of the 148 repository files the journey compiles, main's new commits change three: api/_lib/codium-pool.ts, packages/core/src/local-mode/sources.ts and packages/web/test/fixture/codium-spend-emulation.ts. The journey is to be run again once the lead has merged main.

**Changed in the round:**

- packages/web/test/everywhere-journey-laptop.test.ts (899 to 894 lines): J1 asserts the record is `shared` (:786) and R1 the same on Valkey (:877); the routing step asserts a `chat.update` before reading the last (:609-611) and the editing step that `limits.maxUsd` is a number (:644); J5 drops the jobs client's request to its default origin and keeps the `.invalid` probe (:849-856); `createJobId` is no longer imported.
- Lane documents: the deviations entry (opening paragraph, the case table, (b), (e), (n), Safe by default, Left open, the mutation lines, the review round), this receipt (the case table, the line numbers, the check annotations, this round, the commit section), the handoff's EV-19 bullet and the spec's EV-19 note (the Codium fakes, deviation (d)).

**Checks**, each through /home/user/.tools/vector-serial, one file at a time from packages/web with `--timeout 30000`; logs in /tmp/vector-v2/everywhere/ev19-fix/.

| Check | Result |
| --- | --- |
| web test/everywhere-journey-laptop.test.ts (vector-everywhere.yml), three runs | 5 pass, 2 skip, 0 fail, 211 expects, each run |
| the same file with a disposable loopback redis-server 7.0.15 (informational; CI's Valkey job is the receipt) | 7 pass, 0 fail, 329 expects; the database empty afterwards |
| mutations M1 to M14 again (ev19-fix/mutate.py; M12 against the loopback redis-server) | each red in the same cases as before, first at the same assertion (lines in the deviations entry) |
| `bun typecheck` in packages/web (astro check) | 0 errors, 0 warnings, 414 hints (the new file's 2 `rejects` hints) |
| prettier --check on the new file | clean |

No production file changed in the round, so the hosted API and desktop typechecks above stand.

### EV-19 commit, push and CI

One package commit, `test(everywhere): add the mocked laptop journey for Slack` (the commit gate's title, in place of the planned `test(everywhere): add the laptop journey harness and the Slack journey`), staging by path the five code and test files above and the five lane documents (deviations, progress, spec, handoff and v2-notes/v2-complete-plan.md). Its body names the `SlackDeps.sleep` change and says that no generated file was regenerated and no flag, env var, route, config key, dependency or workflow changed. The commit SHA, the push and the CI run ids go in the next receipt (a commit cannot name itself):

- the push gate: `git fetch origin everywhere-finish`, the full turbo typecheck and a fast-forward push;
- workflow_dispatch runs of vector-everywhere.yml (R1 and R2 run in its Valkey job), vector-hosted-ci.yml, vector-at-mention.yml, vector-codium.yml and typecheck.yml on everywhere-finish, as for EV-12 to EV-18, their run ids also on the handoff's EV-19 bullet. origin/main holds PR #33 and its merge base with HEAD is origin/release-finish `67ec3a60` (EV-12's commit gate), so vector-codium.yml's changed-since-main picker selects the lane's files, not the 570 the brief warns about; it also runs root test/no-project-wording.test.ts, which caught EV-17's and EV-18's wording.

**Commit gate (2026-11-20).** `git fetch origin release-finish main everywhere-finish`: HEAD `503bab3b` still equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`; origin/main is `b5cbad1c` (185 ahead, not merged here). The working tree held only this package's ten paths. Re-run at the gate, each through `vector-serial`, one file at a time from packages/web with `--timeout 30000` (logs in /tmp/vector-v2/everywhere/ev19-gate/):

| Check | Result |
| --- | --- |
| web test/everywhere-journey-laptop.test.ts | 5 pass, 2 skip, 0 fail, 211 expects |
| web test/everywhere-router.test.ts / -slack-events / -intake (the changed fixtures' callers) | 9 / 12 / 8 pass, 0 fail; 37 / 94 / 68 expects |
| `bun typecheck` in packages/web (astro check) | 0 errors, 0 warnings, 414 hints |
| hosted API: `bun typecheck --project ../../tsconfig.json` from packages/engine | exit 0 |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | 27 of 27 tasks successful, exit 0 |

For the lead: the missing production `repository` port (deviations EV-19 (i); handoff "Current gates") as its own package, and the lane path-filter gap (EV-19 (l)) for review-fixes' FIT-4.

*2026-11-20 (EV-20):* committed as `6d5c1afc` and pushed; its CI (vector-everywhere 44669485106, vector-at-mention 44669493183, typecheck 44669501093 and vector-codium 44669497210 green; vector-hosted-ci 44669489303 cancelled by vector-codium's nested call) is in EV-20's receipt below, with the note on the vector-codium dispatch. EV-20 moved the harness into packages/web/test/lib/everywhere-journey.ts, so the line numbers in this receipt are from before that move; the current ones are in EV-20's receipt.

## EV-20: the Linear and Jira laptop journeys (VE-22b) (2026-11-20)

VE-22 (Linear and Jira half), §9; E1, E4, E5, E8, E12, E17. Deviations log: "2026-11-20, EV-20".

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `6d5c1afc` (EV-19) equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged (the brief's `0ee486e3` is older; `67ec3a60` is the checked base). origin/main is `56b2862b`: it holds PR #33 and is 188 commits ahead. The brief's two merge rules conflict ("once PR #33 is merged, merge origin/main" and "the lead merges main into this branch"); the second is followed, as in the EV-14 and EV-19 receipts. Main's commits after `b5cbad1c` change only engine installation files (standalone.ts, windows-remove.ts, verify-windows-installer.ts, ownership.test.ts and ci-harness-repairs.md), none of the journeys' 152 compiled repository files. No review-fixes or brain-transport precondition applies.

**EV-19's commit, push and CI.** EV-19 landed as `6d5c1afc` (`test(everywhere): add the mocked laptop journey for Slack`), pushed to everywhere-finish. Its runs on that SHA:

| Workflow | Run | Result |
| --- | --- | --- |
| vector-everywhere | 44669485106 | success, 9 of 9 jobs; test job 136067687198: "Vector everywhere: 62/62 test files passed" on Valkey 7.2.14 (R1 and R2 included); the seven typecheck jobs, queued for runners, finished 04:13-04:29 |
| vector-at-mention | 44669493183 | success |
| typecheck | 44669501093 | success |
| vector-codium | 44669497210 | success, 21 jobs, including its nested call of vector-hosted-ci.yml. It was dispatched against the letter of the lane rule: "until PR #33 is on main and merged into this branch", and main has not been merged here. EV-19's receipt argued that the changed-since-main picker selects only the lane's files because main holds release-finish. Recorded as a breach of the rule's letter (critique), and its nested job is not cited as the hosted receipt. EV-20 dispatches no vector-codium run. |
| vector-hosted-ci | 44669489303 | cancelled at 03:42:11, 5 s after it started, all 12 jobs. vector-hosted-ci.yml:45-47 groups runs by `vector-hosted-ci-${event}-${ref}` with `cancel-in-progress`, and vector-codium.yml:192 calls the same workflow on the same ref, so the nested call cancelled the standalone dispatch. A standalone hosted receipt for EV-19 is still owed if the lead wants one: dispatch vector-hosted-ci.yml alone, after any vector-codium run on the ref has concluded. |

vector-everywhere.yml groups manual runs by ref with `cancel-in-progress` (:63-67), so an EV-20 dispatch would have cancelled 44669485106 while it was queued. That run and typecheck 44669501093 have now concluded, so EV-20's dispatches can no longer cancel them; and EV-20 rewrites EV-19's file, so EV-20's runs are not EV-19's receipt (critique).

**Files** (line numbers after review round one, below):

- packages/web/test/lib/everywhere-journey.ts (new, 556 lines): the constants :47-56, `installJourney` :64 (`relay()` :81, the relay Worker :90, the Codium fetcher :101, `seedPlan` :111, the hooks :140-170), `bounded` :178, `gate` :185, `slowStore` :202, `journeyPorts` :218, `mountJourney` :240, `journeyComputer` :289 (`turn` :455, `close` :476), `onlyJob` :494, `expectSettled` :508, `expectNoReclaim` :538.
- packages/web/test/everywhere-journey-laptop.test.ts (EV-19's, 894 to 495 lines): `installJourney([native])` :45, the FakeSlack resets :48, `world` :70, `admit` :192 (the E12 bound :202), `laptopJourney` :211 (settle :300, E8 :304), `offlineJourney` :310, `expectSharedResult` :352; the cases :383 to :484.
- packages/web/test/everywhere-journey-laptop-tracker.test.ts (new, 1,022 lines): `LINEAR_FIRST_ACTIVITY_MS` :67, `linearWorld` :80, `jiraWorld` :186 (the A2A answer clock :232, the held `myself` :249), `linearAdmit` :331, `expectLinearShared` :355, `expectLinearActivities` :369, `expectLinearKept` :390, `linearJourney` :410, `linearOfflineJourney` :596, `taskOf` :650, `expectJiraShared` :659, `expectJiraKept` :673, `jiraAdmit` :694, `jiraJourney` :713, `jiraOfflineJourney` :851; the cases :896 to :1011.
- packages/web/test/lib/everywhere-linear.ts: the `Store` type import :7, `linearFixture(native, options)` :108-111.
- packages/web/test/lib/everywhere-jira.ts: the `Store` type import :6, `jiraFixture(native, {…, store?})` :89-92.
- Lane documents: this receipt and the F5 row and EV-19 receipt annotations; the deviations entry and its EV-19 annotations; a spec note on the VE-22 row; the handoff's EV-20 status bullet, its EV-19 bullet's CI and three "Left open" changes; and the F5 row of v2-notes/v2-complete-plan.md.

**The cases.** L1 :896, L2 :912, A1 :922, A2 :932, G1 :940, and against a real Redis R1 :962, R2 :982, R3 :999, R4 :1011 (what each pins: the deviations entry's table).

**Checks** (each through /home/user/.tools/vector-serial, one file at a time from packages/web, `--timeout 30000`; logs in /tmp/vector-v2/everywhere/ev20/).

| Check | Before (HEAD) | After |
| --- | --- | --- |
| web test/everywhere-journey-laptop-tracker.test.ts (vector-everywhere.yml), three runs | (new) | 5 pass, 4 skip, 0 fail, 321 expects, each run |
| the same file with a disposable loopback redis-server 7.0.15 (informational; CI's Valkey job is the receipt) | (new) | 9 pass, 0 fail, 627 expects; the database empty afterwards |
| web test/everywhere-journey-laptop.test.ts, three runs | 5 pass, 2 skip, 211 expects | 5 pass, 2 skip, 211 expects, each run |
| the same with the loopback redis-server | 7 pass, 329 expects (EV-19) | 7 pass, 329 expects |
| web everywhere-linear-webhook / -linear-render / -linear-oauth | 15 pass 4 skip / 11 / 15; 146 / 74 / 112 expects (EV-19) | identical |
| web everywhere-jira-a2a / -jira-render / -jira-fit | 20 pass 3 skip / 6 / 4; 251 / 48 / 26 expects (EV-19) | identical |
| web everywhere-control / -router / -slack-events / -intake | 13 / 9 / 12 / 8 pass; 123 / 37 / 94 / 68 expects (EV-19) | identical |
| web everywhere-lane (the lane's shape; the lane documents changed) | 13 pass, 153 expects (EV-19) | 13 pass, 0 fail, 154 expects |
| `bun typecheck` in packages/web (astro check) | 0 errors, 414 hints (EV-19) | 0 errors, 0 warnings, 415 hints: the `await expect(...).rejects` hint (ts80007) is now once in each of the three files (J5, G1 and `expectNoReclaim`), where EV-19's file had two |
| hosted API: `bun typecheck --project ../../tsconfig.json` from packages/engine | | exit 0 |
| `bun typecheck` in packages/desktop (unchanged) | | exit 0 |
| `bun x tsgo --noEmit --listFiles -p /tmp/vector-v2/everywhere/ev20/tc/tsconfig.json` (extends packages/web's; both journey files) | | exit 0; 152 repository files; the same eight desktop files as EV-19 (everywhere-runner, -engine, -scan, -git, -ledger, -settings, -offer, github-api), no electron file, every core (25) and schema (17) file under `src/` |
| prettier --check on the two new files and EV-19's file | | clean |
| prettier drift of the hand-packed fixtures, HEAD → after | linear 349, jira 284 lines | 349, 289 |
| `git diff --check`; trailing whitespace in the new files; personal paths or emails in the changed files | | clean; none; none |

**E12 measurement** (100 ms per store command, as EV-19). Linear `created`: 44 commands before the first thought (4,400 ms). That is past the adapter's `ackMs` 4,000 and inside the 10 s first-activity budget the test asserts (deviation (e)); the command list is in ev20/e12-linear-commands.log. Linear `prompted` (probe, not a test): 198 commands before the `finding` thought (19.8 s). Jira: the answer after 10 commands (1,000 ms), inside 55 s.

**The `laptop` race probes** (scratch, not committed; deviation (p)). In the journey the two Jira `laptop` persists overlap: both read the SUBMITTED record before either wrote, and both are written because the records are identical (ev20/probe.log). Forced interleaving: ev20/race-probe.test.ts holds the two `laptop` task writes until `started`'s has landed. Both `laptop` writes then return `changed`, and the task ends FAILED "The request could not be verified or completed. Send your task again." while the job is `running` (ev20/probe-race-forced.log).

**Mutations.** Twenty (T1 to T20), each red, plus EV-19's M2, M7 and M14 against its file on the lib, each red in the same cases and at the same assertions as before. The table with the failing lines is in the deviations entry. T16 is red only with a Redis.

During the second batch the shared volume filled: its ext4 reservation leaves about 39 GB usable, and the lanes together had used it. T16 to T20, M2, M7 and M14 then reported nothing and were run again. Before that, this lane's own engine XDG roots from EV-10 to EV-18 under /tmp/vector-v2/everywhere-finish/ (356 MB, scratch, no receipts there) were removed. Every mutated source was then checked restored: by sha256 in the script, `git status` and `git diff --stat` on api/, packages/schema and packages/desktop (empty).

**Cross-lane probe.** review-fixes `1433d105`, connect-finish `19c48b89`, scope-finish `8c36d06b` and workspaces-finish `e37ec1b5` touch none of this package's paths. codium-finish `58663f5b`, brain-transport `0d18f750` and main `56b2862b` change v2-notes/v2-complete-plan.md at :219-221 only, away from the F5 row this package annotates (:197).

### EV-20 review round one (2026-11-20)

Eight findings, none blocking. Seven are taken; the eighth (Linear's `ackMs` against the measured first thought) stays with the lead. How each was taken is in the deviations log, "2026-11-20, EV-20", "Review round one". **Base.** HEAD is still `6d5c1afc`, and the round works on the same uncommitted tree; nothing was fetched or merged in the round.

**Changed in the round:**

- packages/web/test/everywhere-journey-laptop-tracker.test.ts (949 to 1,022 lines):
  - `linearAdmit` bounds the wait for the first thought and asserts it was posted (:341-342);
  - `expectLinearActivities` (:369) runs at the end of L1 (:588) and L2 (:639);
  - `expectLinearKept` covers the refresh token (:390) and `expectJiraKept` the system token, also in the stored task record (:673);
  - the milestone, result and ending texts are literals, and `linearThought`, `renderMilestone` and `renderEnd` are no longer imported;
  - L2 and A2 end with the E8 claims for the expired job (:642, :889);
  - A1's title names the FIT replay (:923).
- packages/web/test/lib/everywhere-journey.ts: `expectNoReclaim`'s doc line only (:537); no line moved.
- Lane documents:
  - the deviations entry: the opening paragraph, What changed, the journeys, the case table (A1's row quotes the title), (e), (p), Left open, the mutation lines and the review round;
  - this receipt: the file lines, the cases and this round;
  - the spec's EV-20 note (VE-22b built, CI pending);
  - the handoff's EV-20 bullet (the E8 claim after expiry, the review round).

**Checks**, each through /home/user/.tools/vector-serial, one file at a time from packages/web with `--timeout 30000`; logs in /tmp/vector-v2/everywhere/ev20-fix/.

| Check | Result |
| --- | --- |
| web test/everywhere-journey-laptop-tracker.test.ts (vector-everywhere.yml), three runs | 5 pass, 4 skip, 0 fail, 345 expects, each run (321 before the round) |
| the same file with a disposable loopback redis-server 7.0.15 (informational; CI's Valkey job is the receipt) | 9 pass, 0 fail, 666 expects (627 before); the database empty afterwards |
| web test/everywhere-journey-laptop.test.ts (EV-19's, on the lib) | 5 pass, 2 skip, 0 fail, 211 expects |
| mutations N1 to N8 (ev20-fix/mutate.py), on the file now and with `BEFORE=1` on the file before the round | each red now (lines in the deviations entry's round); before, N1 hung the run until `timeout` stopped it at 240 s and N2 to N8 each passed 5 of 5 |
| mutations T3 to T20 again (ev20-fix/tmutate.py; T16 against the loopback redis-server) | each red in the same cases as before, first at the same assertion (new lines in the deviations entry's mutation table); T1 and T2 (red by timeout) not re-run |
| `bun typecheck` in packages/web (astro check) | 0 errors, 0 warnings, 415 hints |
| hosted API: `bun typecheck --project ../../tsconfig.json` from packages/engine | exit 0 |
| `bun x tsgo --noEmit -p /tmp/vector-v2/everywhere/ev20/tc/tsconfig.json` (both journey files, extending packages/web's config) | exit 0 |
| prettier --check on the tracker file, the lib and EV-19's file | clean |
| web test/everywhere-lane.test.ts (the lane documents changed) | 13 pass, 0 fail, 154 expects |
| `git diff --check`; personal paths or emails in the changed files | clean; none |

The first T3 re-run waited on another lane's Bun lock past its `timeout 240`, because the timeout also covered the wait for the lock. It was stopped, and the script's `finally` restored intake.ts (`git diff` on api/, packages/schema and packages/desktop is empty). The re-run script now starts the timeout only once the lock is held. Every mutated source and the tracker file were checked restored by sha256.

No production file changed in the round.

### EV-20 commit, push and CI

This package's build step leaves the changes uncommitted. The commit, `test(everywhere): add the mocked laptop journeys for Linear and Jira`, stages by path:

- the two new files and EV-19's test file;
- the two lib fixtures;
- the five lane documents: deviations, progress, spec, handoff and v2-notes/v2-complete-plan.md.

Its body says that no production file changed, that no generated file was regenerated, and that no flag, env var, route, config key, dependency, lockfile or workflow changed; `LAPTOP_ROUTE_WIRED` stays false.

Push gate: `git fetch origin everywhere-finish`, merge anything new, the full turbo typecheck, then a fast-forward push.

CI: workflow_dispatch runs of vector-everywhere.yml (R1 to R4 in its Valkey job) and typecheck.yml on everywhere-finish. EV-19's runs of both have concluded, so a dispatch cancels nothing of EV-19's. Not vector-codium.yml. vector-hosted-ci.yml only alone, if wanted. A commit cannot name itself, so its SHA and the run ids go in the next receipt and on the handoff's EV-20 bullet.

For the lead:

- Linear's 44-command acknowledgement (deviation (e)).
- Whether Linear's 10 s applies to `prompted` (e).
- The Jira `laptop` compare-and-set race, before Jira's laptop route goes live (p).
- The Linear re-prompt loop without a production repository port (l, under EV-19 (i)'s gate).

## EV-21: the desktop settings page (VE-41) (2026-11-20)

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `6a74ac3b` equals origin/everywhere-finish; origin/release-finish `67ec3a60` is an ancestor, so nothing was merged; origin/main `6a771354` (PR #33) is not merged here (the lead's). Preconditions, each `git merge-base --is-ancestor <sha> HEAD`: EV-08 `3443cfa3`, EV-10 `7146a98f`, EV-17 `c9275df0`, EV-18 `cf9195d0`.

**Open precondition for the commit:** the lead's ruling on the config-skew exception (deviations, "2026-11-20, EV-21", (a)). No lead session was reachable during the build; the changes stay uncommitted until it is given. *Settled 2026-11-20: No (see "EV-21 ruling on (a)" below).*

**EV-20's push receipts** (commit `6a74ac3b`, read with the GitHub tools): vector-everywhere [44684273933](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44684273933) success; typecheck [44684286488](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44684286488) success; vector-hosted-ci [44684277983](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44684277983) success; vector-at-mention [44684282421](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44684282421) success.

**Files** (line numbers after the package):

- new packages/app/src/components/settings-v2/everywhere-model.ts (363 lines): `EverywhereView` :20, `everywhereOffered` :161, `everywhereTab` :169, `everywhereView` :179, `writeBlock` :209, `editable` :220, `turnOn` :225, `turnOff` :234, `capChange` :241, `addProject` :253, `removeProject` :272, `modelChoices` :282, `modelChange` :299, `jobsLine` :304, `checksLine` :326, `everywhereJobs` :335, `jobsPage` :361; fixed texts :126-155.
- new packages/app/src/components/settings-v2/everywhere.tsx (491 lines): `useEverywhereTab` :70, `SettingsEverywhereV2` :83, the one write `save` :136 (guard :139, `updateConfig({ everywhere: change })` :144), `acceptConsent` :161.
- new packages/app/src/components/settings-v2/everywhere-model.test.ts (492 lines, 35 cases).
- packages/app/src/components/settings-v2/settings-registry.ts: :22 and the entry :173-193.
- packages/app/src/components/settings-v2/settings-registry.test.ts: :7 (`21`) and :16.
- packages/app/src/components/settings-v2/dialog-settings-v2.tsx: :30-31, :74-76, :85, :93, :95, :99, :167.
- packages/desktop/src/main/config-skew.test.ts: :12-15, :171-178 and the new case :181-215.
- Lane documents: this receipt, the deviations entry, the spec's §3.12, §6.5 and §8 notes, the handoff's status bullet, four dated annotations (the job-only link, the offer hand-off, unattended worktrees, Vector Local after EV-15) and one Left open item, and main-requests.md's settings-page annotation.

**Checks**, each through /home/user/.tools/vector-serial, one file at a time with `--timeout 30000`; the app files with `--isolate`, the desktop file with `--no-env-file`.

| Check | Result |
| --- | --- |
| app src/components/settings-v2/everywhere-model.test.ts (vector-everywhere.yml) | 35 pass, 0 fail, 201 expects |
| app src/components/settings-v2/settings-registry.test.ts (no lane workflow; test.yml) | 21 pass, 0 fail, 141 expects |
| app src/components/settings-v2/remote-model.test.ts | 6 pass, 0 fail, 55 expects |
| app src/components/settings-v2/memory-backup-model.test.ts | 6 pass, 0 fail, 47 expects |
| app src/features/onboarding/spotlight-steps.test.ts | 2 pass, 0 fail, 48 expects |
| desktop src/main/config-skew.test.ts (test.yml's desktop job) | 3 pass, 0 fail, 44 expects |
| root test/no-project-wording.test.ts (from test/) | 2 pass, 0 fail, 16 expects |
| `bun typecheck` in packages/app and packages/desktop | exit 0, both |
| web test/everywhere-lane.test.ts (the lane documents changed) | 13 pass, 0 fail, 155 expects |
| root test/no-personal-paths.test.ts (from test/) | 1 pass, 0 fail, 2 expects |
| prettier --check on the seven changed code and test files | clean (the three new files after `--write`) |
| mutations M1 to M21 (23 runs, ev21-mut/mutate.py) | all red; table in the deviations entry; every restore matched before.sha256 |
| `git diff --check` | clean |

**Cross-lane probe** (2026-11-20): `git diff HEAD...origin/<lane>` over the seven code and test files is empty for main, connect-finish, hands-finish, codium-finish, scope-finish, workspaces-finish, review-fixes, brain-transport and native-qualify (SHAs in the deviations entry). The merged tree's registry total is 21.

**Commit, push and CI (after the ruling).** One commit staging the paths above, plus packages/ui/src/context/helper.tsx and packages/app/src/context/server-sdk.tsx and server-sync.tsx from review round one: `feat(app): add the Vector everywhere settings page behind its perk`. Its body says: no IPC, preload or platform change; no generated file; the config-skew exception and its reason; the tab stays hidden; `LAPTOP_ROUTE_WIRED` is still false. *Review round two:* the body also names packages/desktop/src/main/config-skew.test.ts and quotes the lead's ruling with its date, and it names packages/ui/src/context/helper.tsx, packages/app/src/context/server-sdk.tsx and server-sync.tsx as shared-surface changes; the PR description repeats the last three. If the ruling is no, the read-only fallback in the deviations entry's Commit hold is applied first, and the body says so. *Ruling on (a), 2026-11-20: No. The fallback is applied; the commit plan is in "EV-21 ruling on (a)" below.* Push gate: `git fetch origin everywhere-finish`, merge anything new, the full turbo typecheck, a fast-forward push. CI: workflow_dispatch of vector-everywhere.yml and typecheck.yml on everywhere-finish (not vector-codium.yml); the run ids go in the next receipt.

### EV-21 review round one (2026-11-20)

Eleven findings from two reviewers: five blocking, two of them the same.

**The config-skew hold.** Two blocking findings: the config-skew hunk reads as a loosened test, and no ruling is recorded. Nothing is committed; the step forbids it anyway. The deviations entry now carries a "Commit hold" with both answers spelled out and "Ruling on (a): none yet". No lead was reachable: ListAgents listed only the main session and this agent. The hunk stays uncommitted for the ruling. The guard case in it is stricter (F12, F12b).

**Fixed:**
- the server hooks at the top of SettingsWorkspace, which broke e2e/fixtures/account-settings.jsx (v), now read optional contexts (l2);
- trust for listed folders that are open in Vector, with the existing approval (y);
- Remote's loading state (z);
- the limit inputs (aa);
- the instruction files in the Continue note, and (o) corrected;
- the description copy (ab);
- Remote staying on after the consent (b3);
- `save` checks `writeRefusal` itself (n);
- the config-skew guard walks the `||` chain.

**Files** (round one): everywhere-model.ts (455 lines), everywhere.tsx (595), everywhere-model.test.ts (611, 41 cases), config-skew.test.ts (:181-225), packages/ui/src/context/helper.tsx (+4), packages/app/src/context/server-sdk.tsx and server-sync.tsx (export lines), and the lane documents: the deviations entry, this receipt, the handoff's status and Left open bullets, and the spec's §3.12 and §8 notes.

**Checks**, each through /home/user/.tools/vector-serial, one file at a time with `--timeout 30000` (app files with `--isolate`, the desktop file with `--no-env-file`):

| Check | Result |
| --- | --- |
| app src/components/settings-v2/everywhere-model.test.ts | 41 pass, 0 fail, 248 expects |
| app src/components/settings-v2/settings-registry.test.ts | 21 pass, 0 fail, 141 expects |
| desktop src/main/config-skew.test.ts | 3 pass, 0 fail, 44 expects |
| app src/context/server-sync.test.ts (its export changed) | 8 pass, 0 fail, 14 expects |
| app remote-model.test.ts, memory-backup-model.test.ts, onboarding spotlight-steps.test.ts | 6/0/55, 6/0/47, 2/0/48 |
| root test/no-project-wording.test.ts and no-personal-paths.test.ts (from test/) | 2/0/16 and 1/0/2 |
| `bun typecheck` in packages/app, packages/ui and packages/desktop | exit 0, each |
| web test/everywhere-lane.test.ts, after this receipt | 13 pass, 0 fail, 155 expects |
| root test/no-project-wording.test.ts and no-personal-paths.test.ts (from test/) | 2/0/16 and 1/0/2 |
| prettier --check on the eight changed code and test files | clean (the model test after `--write`, line wrapping only) |
| mutations F1 to F13 (ev21-fix/mutate.py) | F1-F12 and F13 red, F12b survives as intended; restores matched |
| round-one mutations M2 to M21 re-run (ev21-fix/mutate-again.py) | all red; restores matched; M1's anchor replaced by F13 |
| `git diff HEAD...origin/<lane>` over the touched files | none of this package's files changed elsewhere (deviations, Coordination) |

Not run: e2e/regression/account-settings.spec.ts (Playwright; test.yml runs it), the page under Electron.

### EV-21 review round two (2026-11-20)

Ten findings from two reviewers: two blocking, both the config-skew hold; eight non-blocking, all taken.

**The config-skew hold.** It stands. ListAgents found no reachable agent, the step forbids committing, and "Ruling on (a)" still reads "none yet". The deviations entry now has a round-two hold paragraph. It spells out both answers again, with the fallback's line numbers (`save` :203-225, `apply` :227, `acceptConsent` :236), and says that the commit body names config-skew.test.ts and the ruling. config-skew.test.ts is unchanged this round.

**Fixed:**
- (ac) `acceptConsent` checks `writeRefusal(view, offered, {enabled: true})` before it turns Remote on, and the consent panel shows only while that holds.
- (ad) "Continue in a new session on this branch" is disabled, with `JOB_RUNNING`, while ServerSync's session store says the job's session is working, and `CONTINUE_NOTE` says Continue is for a finished job.
- (ae) `RULE_KEYS`, the 64-folder cap and the limits' minimums are tied to their sources by model tests.
- (q) The checks line reads the engine's unattended shell probe (GET /experimental/shell/unattended, no instance routing), so Linux without a bubblewrap that starts says jobs run no commands.
- (y) Listed folders match open projects through `pathKey`, and the trust read uses the open project's spelling.
- (af) `capValue`'s types, and the plain-copy loop now covers every fixed text, `PAGE_DESCRIPTION` (moved into the model) included.
- (l2) The three shared context files are kept as built. The commit body and the PR description call them out, and the cross-lane check runs again just before the push.
- The spec's "Codium listing" owner action has a note of 2026-11-20 naming the four preconditions for listing the perk, and the handoff's "Owner decisions" has the same line. The VE-41 row note points there.

**Files** (round two): everywhere-model.ts (488 lines), everywhere.tsx (628), everywhere-model.test.ts (696, 47 cases), and the lane documents: the deviations entry, this receipt, the spec's §8 VE-41 note and §10 "Codium listing" note, and the handoff's "Owner decisions" and Left open bullets. No other code file changed this round.

**Checks**, each through /home/user/.tools/vector-serial, one file at a time with `--timeout 30000` (app files with `--isolate`, the desktop file with `--no-env-file`):

| Check | Result |
| --- | --- |
| app src/components/settings-v2/everywhere-model.test.ts | 47 pass, 0 fail, 298 expects |
| app src/components/settings-v2/settings-registry.test.ts | 21 pass, 0 fail, 141 expects |
| desktop src/main/config-skew.test.ts (it parses everywhere.tsx) | 3 pass, 0 fail, 44 expects |
| root test/no-project-wording.test.ts and no-personal-paths.test.ts (from test/) | 2/0/16 and 1/0/2 |
| web test/everywhere-lane.test.ts (the lane documents changed) | 13 pass, 0 fail, 155 expects |
| `bun typecheck` in packages/app | exit 0 |
| `git diff --check` | clean |
| prettier on the three changed app files | everywhere.tsx and the model test reformatted by `--write`, the model unchanged; `--check` clean |
| mutations G1 to G10 (ev21-fix2/mutate.py) | all red; restores matched before.sha256 |
| `git diff HEAD...origin/<lane>` over the touched and shared files | no lane tip moved since round one; only main's and codium-finish's memory-backup files differ (deviations, Coordination) |

Not run: the page under Electron, e2e/regression/account-settings.spec.ts (Playwright; test.yml runs it), and any renderer test of the page's round-two changes (none exists; typecheck only).

### EV-21 review round three (2026-11-20)

Five findings from two reviewers. Two are blocking, and both are the config-skew hold. The three non-blocking findings are all taken.

**The config-skew hold.** It stands. ListAgents answered "No reachable agents", the step forbids committing, and "Ruling on (a)" still reads "none yet". config-skew.test.ts and `save` are unchanged. To make the No answer one step, it is now a checked patch: /tmp/vector-v2/everywhere/ev21-fix3/read-only.patch (sha256 `085f89421c95…`, built by make-readonly.py there). It makes the page read-only and puts config-skew.test.ts back at HEAD. With the patch applied, the app typecheck exits 0, the unchanged config-skew.test.ts passes 2/0/38, and prettier is clean. Both files were then restored, and every hash in yes.sha256 matched. On this round's tree, `git apply --check` passes. The deviations entry's round-three hold lists what the patch removes and what No costs.

**Fixed:**
- (ag) The trust resource follows a `folders` memo (everywhere.tsx :173), equal while the listed directories are unchanged, so a save that leaves the folders alone reads no trust again.
- (ah) `everywhereTab`'s input field, `useEverywhereTab`'s parameter and `jobsPage`'s parameter are `offered`. The tests' literals and three case titles follow.
- The deviations entry's "Safe by default" bullet now says that, while the plan offers the perk, the tab shows on any desktop server, but reads and writes only the built-in engine.

**Files** (round three): everywhere.tsx (632 lines), everywhere-model.ts (489), everywhere-model.test.ts (698, 47 cases); the lane documents: the deviations entry (hold, What changed line numbers, (y), (ag), (ah), Safe by default, Left open, Mutations, Coordination), this receipt and the handoff's EV-21 Left open bullet. No other code file changed.

**Checks**, each through /home/user/.tools/vector-serial, one file at a time with `--timeout 30000` (app files with `--isolate`, the desktop file with `--no-env-file`):

| Check | Result |
| --- | --- |
| app src/components/settings-v2/everywhere-model.test.ts | 47 pass, 0 fail, 298 expects |
| app src/components/settings-v2/settings-registry.test.ts | 21 pass, 0 fail, 141 expects |
| desktop src/main/config-skew.test.ts (it parses everywhere.tsx) | 3 pass, 0 fail, 44 expects |
| the same file at HEAD, with read-only.patch applied | 2 pass, 0 fail, 38 expects |
| `bun typecheck` in packages/app, final tree and with the patch applied | exit 0, both |
| web test/everywhere-lane.test.ts (the lane documents changed) | 13 pass, 0 fail, 155 expects |
| root test/no-project-wording.test.ts and no-personal-paths.test.ts (from test/) | 2/0/16 and 1/0/2 |
| prettier --check on the three changed app files and the patched page | clean (the model test after `--write`, one wrapped line) |
| mutation H1, the tab ignores `offered` (ev21-fix3/H1.log) | red, 46 pass, 1 fail; restore matched before.sha256 |
| `git diff --check` | clean |
| `git diff HEAD...origin/<lane>` over the touched and shared files | no lane tip moved since round two (deviations, Coordination) |

Not run: the page under Electron, e2e/regression/account-settings.spec.ts (Playwright; test.yml runs it), and a renderer test of the trust memo (none exists; typecheck only).

### EV-21 commit gate (2026-11-20)

**Stopped at the config-skew hold.** "Ruling on (a)" still reads "none yet" (deviations, "2026-11-20, EV-21"), and ListAgents answered "No reachable agents", so nothing was staged, committed, pushed or dispatched. `git fetch origin release-finish main everywhere-finish`: HEAD `6a74ac3b` equals origin/everywhere-finish, and origin/release-finish `67ec3a60` is an ancestor. The tree matches round three's yes.sha256; read-only.patch (`085f8942…`) still passes `git apply --check`.

**Checks**, each through /home/user/.tools/vector-serial, one file at a time with `--timeout 30000` (app files with `--isolate`, the desktop file with `--no-env-file`):

| Check | Result |
| --- | --- |
| app src/components/settings-v2/everywhere-model.test.ts | 47 pass, 0 fail, 298 expects |
| app src/components/settings-v2/settings-registry.test.ts | 21 pass, 0 fail, 141 expects |
| desktop src/main/config-skew.test.ts | 3 pass, 0 fail, 44 expects |
| `bun typecheck` in packages/app, packages/ui and packages/desktop | exit 0, each |
| web test/everywhere-lane.test.ts, after this receipt | 13 pass, 0 fail, 155 expects |
| root test/no-project-wording.test.ts and no-personal-paths.test.ts (from test/) | 2/0/16 and 1/0/2 |

Not run, because nothing is committed: the full turbo typecheck and the lane's CI dispatches. Both run at the gate that follows the ruling.

### EV-21 ruling on (a): the read-only page (2026-11-20)

**The ruling.** The lead, 2026-11-20: **No.** The config-skew test stays exactly as at HEAD. Engines before this release reject unknown top-level keys (hands-build-spec.md, the "Config skew" row; hands-deviations.md item 5). The built-in engine still writes the shared user/global config file that an older Vector on the same computer reads, so the built-in-engine guard does not make the write safe.
- Recorded in the deviations entry, under "Ruling on (a)".
- Deferred item: the write path needs skew-safe storage outside user/global config (the desktop store, as Hands keeps its per-user state). Everywhere stays off by default meanwhile.

**Base.** `git fetch origin release-finish main everywhere-finish` and the eight other lanes: no tip moved since round three. HEAD `6a74ac3b` equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged.

**Applied.**
- /tmp/vector-v2/everywhere/ev21-fix3/read-only.patch (`085f89421c95…`) applied cleanly.
- config-skew.test.ts is byte-identical to HEAD (`c1ac9af0…`), so it is no longer a changed file.
- everywhere.tsx matched the patch's prepared copy (`623a49af…`). The Yes copies of both files are at /tmp/vector-v2/everywhere/ev21-no/.

Then, so that a page which writes nothing says nothing false:
- `PAGE_DESCRIPTION` and `REPOSITORY_RULE` no longer point at a switch or an Add button.
- The comments that said the page writes, or that the tab shows "so it can always be turned off", now say it reads: in the model, the page, dialog-settings-v2.tsx :74-75 and settings-registry.ts :174-175.
- Two case titles follow, and the plain-copy case gains three assertions.
- Four search keywords for removed controls are dropped from the registry entry.

**Files** (final; sha256 in /tmp/vector-v2/everywhere/ev21-no/final.sha256):
- new packages/app/src/components/settings-v2/everywhere.tsx (347 lines, read-only, with no `updateConfig` call), everywhere-model.ts (494) and everywhere-model.test.ts (701, 47 cases);
- packages/app/src/components/settings-v2/settings-registry.ts (:22, the entry :174-190) and settings-registry.test.ts (:7, :16);
- packages/app/src/components/settings-v2/dialog-settings-v2.tsx (:30-31, :74-76, :85, :93, :95, :99, :167);
- packages/ui/src/context/helper.tsx, packages/app/src/context/server-sdk.tsx and server-sync.tsx: the `useOptional` export (deviations (l2));
- the lane documents:
  - the deviations entry: Ruling on (a), What changed, (a), (l), (x), Not changed, Safe by default, Left open, Mutations, Coordination and Deferred verification;
  - this receipt;
  - the spec's §3.12, §6.5, §8 and §10 notes;
  - the handoff's EV-21 status and loose-ends bullets;
  - main-requests.md's annotation.

Not changed: packages/desktop/src/main/config-skew.test.ts.

**Checks**, each through /home/user/.tools/vector-serial, one file at a time with `--timeout 30000` (app files with `--isolate`, the desktop file with `--no-env-file`; logs in /tmp/vector-v2/everywhere/ev21-no/logs/):

| Check | Result |
| --- | --- |
| app src/components/settings-v2/everywhere-model.test.ts | 47 pass, 0 fail, 300 expects |
| app src/components/settings-v2/settings-registry.test.ts | 21 pass, 0 fail, 141 expects |
| desktop src/main/config-skew.test.ts, unchanged from HEAD | 2 pass, 0 fail, 38 expects |
| `bun typecheck` in packages/app, packages/ui and packages/desktop | exit 0, each |
| root test/no-project-wording.test.ts and no-personal-paths.test.ts (from test/) | 2/0/16 and 1/0/2 |
| web test/everywhere-lane.test.ts, after this receipt | 13 pass, 0 fail, 155 expects |
| prettier --check on the nine changed code and test files | clean |
| mutations N1 and N2 (ev21-no/mutate.py) | red, 46 pass and 1 fail each; restores matched by sha256 |
| `git diff --check` | clean |
| `git diff HEAD...origin/<lane>` over the touched and shared files | no lane tip moved; only main's and codium-finish's memory-backup files differ |

Not run:
- the full turbo typecheck and the CI dispatches, because this step does not commit;
- e2e/regression/account-settings.spec.ts (Playwright; test.yml runs it);
- the page under Electron.

**Commit, push and CI** (for the commit gate):
- **The commit:** one commit with explicit paths. It stages:
  - the three new app files;
  - settings-registry.ts and its test;
  - dialog-settings-v2.tsx;
  - packages/ui/src/context/helper.tsx, packages/app/src/context/server-sdk.tsx and server-sync.tsx;
  - the five lane documents.

  It does not stage config-skew.test.ts.
- **The title:** `feat(app): add a read-only Vector everywhere settings page behind its perk`.
- **The body** says:
  - the page is read-only;
  - the lead's ruling on (a), quoted with its date 2026-11-20;
  - config-skew.test.ts is unchanged;
  - the write is deferred to skew-safe storage;
  - the three shared-surface files;
  - no IPC, preload or platform change, and no generated file;
  - the tab stays hidden, and `LAPTOP_ROUTE_WIRED` is still false.
- **The push gate:** `git fetch origin everywhere-finish`, merge anything new, the full turbo typecheck, then a fast-forward push.
- **CI:** workflow_dispatch of vector-everywhere.yml and typecheck.yml on everywhere-finish. test.yml runs config-skew.test.ts and settings-registry.test.ts at the lane end.

### EV-21 review round four (2026-11-20)

Eleven findings from two reviewers, after the ruling on (a). One is blocking, and two other reviewer findings repeat it; three more were given twice. Nothing is committed: the step forbids it. Each finding and what was done is in the deviations entry, "Review round four", with the items (ai), (aj) and (ak).

**Base.** `git fetch origin`: no lane tip moved since the ruling. HEAD `6a74ac3b` equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged. Before the edits, the tree matched the ruling's final.sha256.

**Fixed:**
- *Blocking:* the page said it shows the settings and showed two of them. It now has a read-only "How jobs run" card, from the model's new `howJobsRun` with the limits, the model, Wait for my computer, push with `PUSH_RULE`, and stay awake with `CLOSED_LID`. `PAGE_DESCRIPTION` is unchanged and now true, and it is pinned whole (deviations (ai)).
- The unused write helpers and their copy are removed: 19 cases went, and four "how jobs run" cases are new. A reference patch is at /tmp/vector-v2/everywhere/ev21-fix4/write-helpers.patch (sha256 `1abc0f78…`); `git apply --check` passes on this tree (deviations (aj)).
- An older Remote status answer no longer overwrites a newer change event (deviations (ak)).
- The own-session doc comment sits above `OWN_SESSION_LIMITS` again.

**Recorded, no code:**
- The three shared context files, kept as built. They are listed in the commit body and the PR description; the cross-lane diff was re-run this round and is re-run at the push gate ((l2)).
- Continue and job-written instruction files (E1): kept as an owner or lead gate before listing the perk. The recommended engine-side hold is in the spec's §10 note ((o)).
- The jobs link: the hard precondition is kept, and the optional constant is not taken ((h)).

**Files** (pre-round copies and hashes in /tmp/vector-v2/everywhere/ev21-fix4/before/ and before.sha256):
- packages/app/src/components/settings-v2/everywhere-model.ts (318 lines, sha256 `14bca6bf…`), everywhere.tsx (374, `d4b44416…`) and everywhere-model.test.ts (519 lines, 32 cases, `9872706b…`);
- the lane documents: the deviations entry (Review round four; What changed; annotations on (h), (o), (r), (s), (z), (ae), (af) and (l2); the new (ai), (aj) and (ak); Safe by default, Left open, Mutations and Coordination), the spec's §3.12, §8 and §10 notes, the handoff's EV-21 bullets and this receipt.

The other files of the package are byte-identical to the ruling's final.sha256: settings-registry.ts and its test, dialog-settings-v2.tsx, and the three shared context files.

**Checks**, each through /home/user/.tools/vector-serial, one file at a time with `--timeout 30000`, app files with `--isolate` (logs in /tmp/vector-v2/everywhere/ev21-fix4/logs/):

| Check | Result |
| --- | --- |
| app src/components/settings-v2/everywhere-model.test.ts | 32 pass, 0 fail, 183 expects |
| app src/components/settings-v2/settings-registry.test.ts | 21 pass, 0 fail, 141 expects |
| `bun typecheck` in packages/app | exit 0 |
| root test/no-project-wording.test.ts and no-personal-paths.test.ts (from test/) | 2/0/16 and 1/0/2 |
| web test/everywhere-lane.test.ts, after this receipt | 13 pass, 0 fail, 155 expects |
| prettier --check on the nine changed code and test files | clean |
| mutations K1 to K7 (ev21-fix4/mutate.py) | all red; table in the deviations entry; every restore matched by sha256 |
| `git diff --check` | clean |
| `git diff HEAD...origin/<lane>` over the touched and shared files | no lane tip moved; only main's and codium-finish's memory-backup files differ |

Not run: the full turbo typecheck and the CI dispatches (no commit in this step), e2e/regression/account-settings.spec.ts (Playwright) and the page under Electron.

**For the commit gate**, on top of "EV-21 ruling on (a)" above:
- The staged paths do not change.
- The body also says that How jobs run shows the settings read-only. It says the write helpers were removed and that the write path is rebuilt against its new storage. It names the reference patch.
- The body and the PR description list packages/ui/src/context/helper.tsx, packages/app/src/context/server-sdk.tsx and server-sync.tsx under "Shared-surface changes". The push gate re-runs `git diff HEAD...origin/<lane>` over them.

### EV-21 commit gate, second run (2026-11-20)

After the ruling on (a) and review round four. The title is the brief's, `feat(app): add the Vector everywhere settings page`, not the one proposed under "EV-21 ruling on (a)"; the body says the page is read-only.

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `6a74ac3b` equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged (main is not merged here; the lead does that).

**Staged** (explicit paths): the three new app files; settings-registry.ts and its test; dialog-settings-v2.tsx; packages/ui/src/context/helper.tsx, packages/app/src/context/server-sdk.tsx and server-sync.tsx (shared-surface changes, (l2)); the five lane documents. Not staged or changed: packages/desktop/src/main/config-skew.test.ts. Nothing else was in the tree.

**Checks**, each through /home/user/.tools/vector-serial, one file at a time with `--timeout 30000` (app files with `--isolate`, the desktop file with `--no-env-file`; logs in /tmp/vector-v2/everywhere/ev21-gate/logs/):

| Check | Result |
| --- | --- |
| app src/components/settings-v2/everywhere-model.test.ts | 32 pass, 0 fail, 183 expects |
| app src/components/settings-v2/settings-registry.test.ts | 21 pass, 0 fail, 141 expects |
| desktop src/main/config-skew.test.ts, unchanged from HEAD | 2 pass, 0 fail, 38 expects |
| `bun typecheck` in packages/app and packages/ui | exit 0, each |
| full `bun turbo typecheck --concurrency=2` | 27/27 tasks successful |
| root test/no-project-wording.test.ts and no-personal-paths.test.ts (from test/) | 2/0/16 and 1/0/2 |
| web test/everywhere-lane.test.ts, after this receipt | 13 pass, 0 fail, 155 expects |
| prettier --check on the nine changed code and test files | clean |
| `git diff --check` | clean |
| `git diff HEAD...origin/<lane>` over the six shared app and ui files (brain-transport, codium-finish, connect-finish, hands-finish, native-qualify, review-fixes, scope-finish, workspaces-finish, main) | empty for every lane |

The commit sha, the push and the CI run ids are recorded in the next package's receipt (a commit cannot name its own sha).

## EV-22: vectordev.ai account components (VE-42a) (2026-11-20)

**Base.** `git fetch origin release-finish main everywhere-finish` and the eight other lanes: HEAD `8aff3462` equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged. origin/main `481973c9` holds PR #33 and is 257 commits ahead; it is the lead's to merge (deviations, "2026-11-20, EV-22", header). Precondition `d7e4aa54` (PUB-4) is an ancestor; the account routes api/everywhere/{installs,links,link,repos,oauth-finish}.ts are on HEAD. Built uncommitted; committed at the commit gate below.

**EV-21's receipts** (commit `8aff3462`, read with the GitHub tools on 2026-11-20):

| Workflow | Run | Result |
| --- | --- | --- |
| vector-everywhere | [44704099831](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44704099831) | success |
| vector-at-mention | [44704105101](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44704105101) | success |
| typecheck, attempt 1 | [44704110697](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44704110697) | failure: only `typecheck (engine)`, job 136179305187, in Setup Bun: "bun install v1.3.14 … panic: Segmentation fault at address 0x0 … Illegal instruction (core dumped)", exit code 132, the known Linux Bun segfault class (RULES-v2 flakes); every other job passed |
| typecheck, attempt 2 (failed jobs re-run once) | 44704110697 | success: `typecheck (engine)` job 136190304910 passed |
| vector-hosted-ci | [44704123491](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44704123491) | still queued when read |
| vector-codium | [44704095050](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44704095050) | queued; dispatched against the lane rule (not by this package), recorded only; never dispatched for EV-22 |

**Files** (new; line numbers in the deviations entry, "What changed"):

- packages/web/src/components/marketing/everywhere/everywhere-model.ts (751 lines after review round one; 716 before)
- packages/web/src/components/marketing/everywhere/EverywhereView.tsx (418 lines; 407 before)
- packages/web/src/components/marketing/everywhere/EverywhereAccount.tsx (39 lines)
- packages/web/src/components/marketing/everywhere/everywhere.css (112 lines)
- packages/web/test/everywhere-pages.test.ts (1,355 lines, 36 cases; 1,154 lines and 29 cases before)
- lane documents: the deviations entry, this receipt, the spec's §3.12, §6.5 (prune row) and §8 (VE-42 row) notes, and the handoff's status bullet, "Current gates" item (Linear teams and Jira keys cannot be mapped) and Left open item.

sha256 of the five code and test files: /tmp/vector-v2/everywhere/ev22/final.sha256 (before review round one) and /tmp/vector-v2/everywhere/ev22-fix/final.sha256 (after).

**Checks**, each through /home/user/.tools/vector-serial, one file at a time with `--timeout 30000`:

| Check | Result |
| --- | --- |
| web test/everywhere-pages.test.ts (vector-everywhere.yml), before review round one | 29 pass, 0 fail, 1,237 expects |
| web test/everywhere-link-api.test.ts | 13 pass, 0 fail, 85 expects |
| web test/everywhere-install-api.test.ts | 17 pass, 0 fail, 139 expects |
| web test/account-github-agents.test.ts | 8 pass, 0 fail, 71 expects |
| web test/account-page.test.ts (its email scan covers src/components) | 3 pass, 0 fail, 15 expects |
| web test/everywhere-lane.test.ts, after the lane documents | 13 pass, 0 fail, 156 expects |
| root test/no-project-wording.test.ts and no-personal-paths.test.ts (from test/) | 2/0/16 and 1/0/2 |
| `bun typecheck` in packages/web (astro check, 299 files) | exit 0: 0 errors, 0 warnings, 421 hints (log: /tmp/vector-v2/everywhere/ev22/typecheck.log) |
| prettier on the five new files | `--write`, then `--check` clean |
| mutations M1 to M23 with M6a/b and M12b (25 runs, ev22-mut/mutate.py) | all red on their named cases; every restore matched before.sha256.json; script/prune-vector-site.mjs unchanged after M14 (`git diff --quiet`) |
| `git diff --check` | clean |
| `git diff HEAD...origin/<lane>` over the new and anchor paths | empty for main and the eight lanes (deviations, Coordination) |

Not run here: the full turbo typecheck (the push gate; only packages/web changed, and its typecheck passes), and the CI dispatches, which follow the commit.

**Review round one** (2026-11-20; deviations, "2026-11-20, EV-22", "Review round one"). Eight findings, one blocking; all fixed or answered, nothing committed. Each through /home/user/.tools/vector-serial, one file at a time with `--timeout 30000`:

| Check | Result |
| --- | --- |
| web test/everywhere-pages.test.ts | 36 pass, 0 fail, 1,323 expects |
| the reviewer's scratch reproduction (/tmp/vector-v2/everywhere/ev22-review/retry.test.ts) | 2 pass, 0 fail; the retry ends `{loaded: true}` with no problem, and the held old-token 401 leaves the state `ready` (log: /tmp/vector-v2/everywhere/ev22-fix/reviewer-scratch.log) |
| each fix undone in turn (ev22-fix/revert/revert.py: R1, R2, R3, R4a, R4b, R7a, R7b, R7c) | every one red on its new case (R3 also on the readMappings decoder case), 34-35 pass; every restore matched by sha256 |
| the 25 earlier mutations re-run on the fixed files (ev22-fix/mut/mutate.py, a copy writing to ev22-fix/mut/) | all red on their named cases; restores matched; `git diff --quiet script/prune-vector-site.mjs` after M14 |
| web test/account-page.test.ts | 3 pass, 0 fail, 15 expects |
| web test/everywhere-lane.test.ts, after the lane documents | 13 pass, 0 fail, 156 expects |
| root test/no-project-wording.test.ts and no-personal-paths.test.ts (from test/) | 2/0/16 and 1/0/2 |
| `bun typecheck` in packages/web (astro check, 299 files) | exit 0: 0 errors, 0 warnings, 421 hints, unchanged (log: /tmp/vector-v2/everywhere/ev22-fix/typecheck.log) |
| prettier `--check` on the five files; `git diff --check` | clean |

While writing the refused-token case, a POST with a body refused by the account check left the file's afterAll hook timing out at 30 s (`RouteHarness.stop()` waits on that connection); the case answers its writes' 401 in its request wrapper instead, and the shared fake is left for the lead (deviations, Left open).

**Commit, push and CI** (for the commit gate):
- One commit staging the five new files and the four lane documents (deviations, progress, spec, handoff) by explicit path: `feat(web): add unreleased Vector everywhere account components`. The body says what landed, that nothing is routed, that no route, api, env, flag, dependency, workflow or generated file changed, and the deferred items: the Linear and Jira mapping gate, the private mark's wiring rule, EV-23's pages.
- Push gate: `git fetch origin everywhere-finish`, merge anything new, the full turbo typecheck, `git diff --quiet script/prune-vector-site.mjs`, a fast-forward push.
- CI: workflow_dispatch of vector-everywhere.yml and typecheck.yml on everywhere-finish (not vector-codium.yml); the run ids go in the next receipt. Done when the file passes alone (it does), the web typecheck passes (it does), and vector-everywhere.yml is green.

**Commit gate** (2026-11-20). `git fetch origin release-finish main everywhere-finish`: HEAD `8aff3462` still equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`; origin/main `481973c9` is 257 ahead and stays the lead's to merge. `git status` showed only this package's paths (the five new files and the four lane documents); nothing else was present. Each through /home/user/.tools/vector-serial (logs in /tmp/vector-v2/everywhere/ev22-commit/):

| Check | Result |
| --- | --- |
| web test/everywhere-pages.test.ts | 36 pass, 0 fail, 1,323 expects |
| web test/everywhere-lane.test.ts, after these lane-document edits | 13 pass, 0 fail, 156 expects |
| `bun typecheck` in packages/web (astro check, 299 files) | exit 0: 0 errors, 0 warnings, 421 hints |
| `TURBO_CACHE_DIR=… bun turbo typecheck --concurrency=2` (the push gate) | exit 0: 27 successful, 27 total (20 cached) |
| `git diff --quiet script/prune-vector-site.mjs`; `git diff --check` | clean |

Committed by explicit path as `feat(web): add unreleased Vector everywhere account components`. CI dispatched on everywhere-finish after the push: vector-everywhere.yml, vector-hosted-ci.yml, vector-at-mention.yml and typecheck.yml. vector-codium.yml is not dispatched: main is not merged into this branch yet (lane rule), and its nested call of vector-hosted-ci.yml on the same ref cancels the standalone run (EV-20's receipt). The sha and run ids go in the next receipt (a commit cannot name its own sha).

## EV-23: vectordev.ai draft pages, OAuth landing, jobs and audit log (VE-42b) (2026-11-20)

**Base.** `git fetch origin release-finish main everywhere-finish` and the eight other lanes: HEAD `f11330ef` equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged. origin/main moved from `481973c9` to `14cb9720` during the package and is 261 commits ahead; it is the lead's to merge (deviations, "2026-11-20, EV-23", header), and it changes none of this package's code paths. Precondition `d7e4aa54` (PUB-4) is an ancestor. Built uncommitted: this step leaves every change in the working tree for the lane's commit gate.

**EV-22's receipts** (commit `f11330ef`, pushed to everywhere-finish; read with the GitHub tools on 2026-11-20):

| Workflow | Run | Result |
| --- | --- | --- |
| vector-everywhere | [44714090336](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44714090336) | success |
| vector-hosted-ci | [44714096221](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44714096221) | success |
| vector-at-mention | [44714102624](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44714102624) | success |
| typecheck | [44714108728](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44714108728) | success |

EV-21's two runs left open in EV-22's receipt (commit `8aff3462`): vector-hosted-ci [44704123491](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44704123491) completed with success; vector-codium 44704095050 (dispatched against the lane rule, not by EV-22) ended cancelled.

**Files** (line numbers in the deviations entry, "What changed"):

- api/_lib/everywhere/jobs.ts (+38, -6 after review round one: `readJobHistory` and the shared `parseRecord`) and api/_lib/everywhere/account-api.ts (+154, -5 after review round one: the two routes and their helpers; not reformatted, as at HEAD)
- api/everywhere/history.ts and api/everywhere/audit.ts (new, 5 lines each)
- packages/web/src/components/marketing/everywhere/everywhere-model.ts (1,358 lines; 751 before), EverywhereView.tsx (684; 418 before), EverywhereAccount.tsx (52; 39 before), EverywhereLink.tsx (new, 39), everywhere.css (134; 112 before)
- packages/web/src/drafts/everywhere.astro and packages/web/src/drafts/everywhere/link.astro (new, 16 lines each)
- packages/web/test/everywhere-pages.test.ts (2,808 lines and 66 cases after review round one; 2,757 and 65 before it; 1,355 lines and 36 cases at EV-22)
- lane documents: the deviations entry, this receipt, the spec's §3.12, §3.7, §6.5 (prune row), §8 (VE-42 row) and §10 (Legal and pages) notes, the handoff's three status and gate bullets, two annotations and its EV-23 Left open block, and a PUB-8 note after v2-notes/v2-complete-plan.md §4.5's table

**Checks**, each through /home/user/.tools/vector-serial, one file at a time with `--timeout 30000`, from the owning package (logs in /tmp/vector-v2/everywhere/ev23/):

| Check | Result |
| --- | --- |
| web test/everywhere-pages.test.ts (vector-everywhere.yml), after the last edit | 64 pass, 1 skip (the real-Redis case), 0 fail, 1,913 expects |
| web test/everywhere-link-api.test.ts | 13 pass, 0 fail, 85 expects |
| web test/everywhere-install-api.test.ts | 17 pass, 0 fail, 139 expects |
| web test/everywhere-audit.test.ts | 11 pass, 3 skip (Redis), 0 fail, 127 expects |
| web test/everywhere-jobs.test.ts (jobs.ts changed) | 43 pass, 9 skip (Redis), 0 fail, 329 expects |
| web test/everywhere-jobs-api.test.ts | 22 pass, 0 fail, 226 expects |
| web test/everywhere-erase.test.ts | 11 pass, 0 fail, 152 expects |
| web test/everywhere-slack-oauth.test.ts | 4 pass, 0 fail, 26 expects |
| web test/everywhere-linear-oauth.test.ts | 15 pass, 0 fail, 112 expects |
| web test/everywhere-lane.test.ts, after the lane documents | 13 pass, 0 fail, 157 expects |
| web test/account-page.test.ts (its email scan covers src/components) | 3 pass, 0 fail, 15 expects |
| web test/docs-hands.test.ts (reads src/drafts) | 6 pass, 0 fail, 55 expects |
| web test/vector-mention-copy.test.ts (reads src/drafts; a web test, not a root one) | 5 pass, 0 fail, 103 expects |
| root test/no-project-wording.test.ts, no-personal-paths.test.ts, api-module-loading.test.ts (from test/) | 2/0/16, 1/0/2 and 2/0/16 |
| `bun typecheck` in packages/web (astro check) | exit 0: 302 files (299 at EV-22, plus the two drafts and EverywhereLink.tsx), 0 errors, 0 warnings, 423 hints (checks/web-typecheck-2.log). The first run after the new cases found three type errors in the test file (a table's problem column, two `toEqual` arguments); fixed, the file re-run green |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| prettier `--check` on everywhere-model.ts, EverywhereView.tsx, EverywhereAccount.tsx, EverywhereLink.tsx, everywhere.css, the pages test and the two route files | clean after `--write` of the four that EV-22 kept formatted; jobs.ts and account-api.ts are not prettier-formatted at HEAD and were left as they were; the .astro files have no plugin |
| `git diff --check`; `git diff --quiet script/prune-vector-site.mjs` | clean; unchanged |
| `git diff HEAD...origin/<lane>` over the touched paths | see the deviations entry, Coordination |

**Drafts and astro check.** astro check covers src/drafts: /tmp/vector-v2/everywhere/ev23/drafts-proof.py put `const broken: number = "not a number"` after `export const prerender = true` in drafts/everywhere.astro, ran `bun typecheck` in packages/web through vector-serial and restored the file in `finally`: exit 1, "src/drafts/everywhere.astro:10:7 - error ts(2322): Type 'string' is not assignable to type 'number'." (Result: 302 files, 1 error; drafts-proof.log), and the restored file's sha256 matched (`b8d2af0d…b10cb`). The two drafts and EverywhereLink.tsx are the three files astro check gained.

**Mutations** (/tmp/vector-v2/everywhere/ev23-mut/mutate.py; results.json beside it): 35 mutations (the plan's M1 to M24 and eleven from the critique), each red on its named case, every restore matched by sha256, src/pages/everywhere.astro removed after M22, and script/prune-vector-site.mjs unchanged after M20 (`git diff --quiet`). After prettier re-indented one anchor, M19 was re-run alone and is red. Table in the deviations entry.

**Not run here:** the CI dispatches and the push gate's full turbo typecheck, which belong to the commit gate; the real-Redis case (it skips locally without VECTOR_TEST_REDIS_URL and runs in vector-everywhere.yml's Valkey job).

**For the commit gate:** one commit staging these paths explicitly, as `feat(web): add the unreleased Vector everywhere pages, OAuth landing, jobs and audit log`; the body names the two new read routes (off by default), that nothing is routed, that no generated file, env, flag, dependency or workflow changed, and the deferred items (the summary rule for the lead, the ended-summary erase, cancelled and directory OAuth returns, the drafts' path filter, the 2.0.0 move). Then `git fetch origin everywhere-finish`, the full turbo typecheck, a fast-forward push, and workflow_dispatch of vector-everywhere.yml (Done-when: green), typecheck.yml and vector-at-mention.yml; not vector-codium.yml.

**Review round one (2026-11-20).** Ten findings, one blocking (deviations, "2026-11-20, EV-23", "Review round one"). `privateSummary` now passes the summary through `sanitizeReply` before GET history answers it, the route reads each installation once, and `readJob` shares `parseRecord`. The off case also pins POST and DELETE (405, nothing read), and one case was added (66). Checks, each through vector-serial, one file at a time with `--timeout 30000` (logs in /tmp/vector-v2/everywhere/ev23-fix/checks/):

| Check | Result |
| --- | --- |
| web test/everywhere-pages.test.ts | 65 pass, 1 skip (the real-Redis case), 0 fail, 1,943 expects |
| web test/everywhere-jobs.test.ts (`readJob` changed) | 43 pass, 9 skip (Redis), 0 fail, 329 expects |
| web test/everywhere-jobs-api.test.ts | 22 pass, 0 fail, 226 expects |
| web test/everywhere-erase.test.ts | 11 pass, 0 fail, 152 expects |
| web test/everywhere-lane.test.ts, after the lane documents | 13 pass, 0 fail, 157 expects |
| root test/no-project-wording.test.ts, no-personal-paths.test.ts, api-module-loading.test.ts (from test/) | 2/0/16, 1/0/2 and 2/0/16 |
| `bun typecheck` in packages/web (astro check) | exit 0: 302 files, 0 errors, 0 warnings, 423 hints |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| prettier `--check` on the pages test and the two route files | clean |
| `git diff --check`; `git diff --quiet script/prune-vector-site.mjs` | clean; unchanged |
| mutations (/tmp/vector-v2/everywhere/ev23-fix/mutate.py; M1, M5, M6, M6b and M7 re-anchored, M35 and M36 new) | all 37 red on their named cases; every restore matched by sha256 (ev23-fix/mut/results.json) |

/tmp/vector-v2/everywhere/ev23-fix/probe.ts checked first that the four new summaries pass the settle decoder's code check and what `sanitizeReply` makes of each. Nothing was committed in this round.

**Commit gate (2026-11-20).** `git fetch origin release-finish main everywhere-finish`: HEAD `f11330ef` still equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`; `d7e4aa54` is an ancestor. `git status` held only this package's paths. Committed by explicit path as `feat(web): add unreleased Vector everywhere draft pages` (the commit gate's title, in place of the one proposed above). Checks, each through vector-serial, one file at a time with `--timeout 30000` (logs in /tmp/vector-v2/everywhere/ev23-gate/):

| Check | Result |
| --- | --- |
| web test/everywhere-pages.test.ts | 65 pass, 1 skip (the real-Redis case), 0 fail, 1,943 expects |
| web test/everywhere-jobs.test.ts | 43 pass, 9 skip (Redis), 0 fail, 329 expects |
| web test/everywhere-jobs-api.test.ts | 22 pass, 0 fail, 226 expects |
| web test/everywhere-erase.test.ts | 11 pass, 0 fail, 152 expects |
| web test/everywhere-audit.test.ts | 11 pass, 3 skip (Redis), 0 fail, 127 expects |
| web test/everywhere-link-api.test.ts | 13 pass, 0 fail, 85 expects |
| web test/everywhere-lane.test.ts, after this receipt | 13 pass, 0 fail, 157 expects |
| root test/api-module-loading.test.ts, no-project-wording.test.ts, no-personal-paths.test.ts (from test/) | 2/0/16, 2/0/16 and 1/0/2 |
| `bun typecheck` in packages/web (astro check) | exit 0: 302 files, 0 errors |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | exit 0: 27 of 27 tasks |
| prettier `--check` on the four components, everywhere.css, the pages test and the two route files | clean |
| `git diff --check`; `git diff --quiet script/prune-vector-site.mjs packages/web/astro.config.mjs`; no src/pages/everywhere* | clean; unchanged; none |

CI is dispatched on everywhere-finish after the push: vector-everywhere.yml, vector-hosted-ci.yml, vector-at-mention.yml and typecheck.yml. vector-codium.yml is not: main is not merged into this branch yet (lane rule), and its nested call of vector-hosted-ci.yml on the same ref cancels the standalone run (EV-20's receipt). The sha and run ids go in the next receipt.

## EV-24: docs draft and owner go-live guides (VE-44) (2026-11-20)

**Base.** `git fetch origin release-finish main everywhere-finish` and the eight other lanes: HEAD `f3abbd6c` equals origin/everywhere-finish and holds origin/release-finish `67ec3a60`, so nothing was merged. origin/main `14cb9720` is ahead and is the lead's to merge (deviations, "2026-11-20, EV-24", header); over this package's paths it changes nothing. Precondition `d7e4aa54` (PUB-4) is an ancestor. Built uncommitted: every change is in the working tree for the lane's commit gate.

**EV-23's receipts** (commit `f3abbd6c`, pushed to everywhere-finish; read with the GitHub tools on 2026-11-20):

| Workflow | Run | Result |
| --- | --- | --- |
| vector-everywhere | [44733232539](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44733232539) | success |
| vector-hosted-ci | [44733238300](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44733238300) | success |
| vector-at-mention | [44733243215](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44733243215) | success |
| typecheck | [44733248337](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44733248337) | success |

**Files:**

- packages/web/src/drafts/docs/everywhere.astro (new, 155 lines)
- docs/vector/owner-actions/vector-everywhere-github.md (new, 122 lines), vector-everywhere-slack.md (new, 172), vector-everywhere-linear.md (new, 167), vector-everywhere-jira.md (new, 170); prettier-formatted
- packages/web/test/everywhere-docs.test.ts (new, 612 lines, 17 cases)
- lane documents: the deviations entry and a dated note under EV-04's "The safe turn-off and turn-on orders", this receipt, the spec's §3.12 Docs, §6.5 docs-nav row, §8 VE-44 row and §10 "Keys and env" and "Legal and pages" notes, and the handoff's status bullet, its annotation under "Owner actions still to come" and its EV-24 Left open block
- not written: docs/vector/owner-actions/vector-everywhere-legal-drafts.md (the lead's amendment)

**Checks**, each through /home/user/.tools/vector-serial, one file at a time with `--timeout 30000`, from the owning package (logs in /tmp/vector-v2/everywhere/ev24/):

| Check | Result |
| --- | --- |
| web test/everywhere-docs.test.ts (vector-everywhere.yml), alone, after the last edit | 17 pass, 0 fail, 213 expects, exit 0 |
| web test/everywhere-pages.test.ts (its link and routing scans see the new draft) | 65 pass, 1 skip (the real-Redis case), 0 fail, 1,943 expects, exit 0 |
| web test/everywhere-lane.test.ts, after the lane documents | 13 pass, 0 fail, 157 expects, exit 0 |
| web test/docs-hands.test.ts and test/vector-mention-copy.test.ts (both read src/drafts) | 6/0/55 and 5/0/103, exit 0 |
| web test/everywhere-jira-manifest.test.ts and test/everywhere-slack-manifest.test.ts (the guides cite both) | 1/0/16 and 1/0/10, exit 0 |
| root test/no-project-wording.test.ts (scans the draft), no-personal-paths.test.ts (scans docs/**/*.md), no-topups.test.ts (from test/) | 2/0/16, 1/0/2 and 4/0/107, exit 0; no-project-wording and no-personal-paths re-run after the lane documents, same counts |
| no-topups and engine compliance/upstream-free read tracked files only | the new files are untracked until the commit gate stages them; /tmp/vector-v2/everywhere/ev24/scan.ts applied both searches (upstream-free's derived holder, `topups?\|top-ups?\|purchased`) to the six new files and the three edited lane documents: no hits. Both tests are for the commit gate after staging |
| `bun typecheck` in packages/web (astro check covers src/drafts and test/) | exit 0: 304 files (302 at EV-23, plus the draft and the test), 0 errors (web-typecheck.log) |
| the key commands under node 22.23.4, in a scratch folder under /tmp/vector-v2/everywhere/ev24/ (removed after) | 44-character data key; 43-character public key; offer-signing.pem at mode 600 beginning with the PKCS#8 header |
| prettier `--check` on the test and the four guides | clean |
| `git diff --check`; `git diff --quiet` on docs-nav.ts, script/prune-vector-site.mjs, astro.config.mjs, everywhere-pages.test.ts and DocsPage.astro | clean; unchanged |
| `git diff HEAD...origin/<lane>` over the touched paths | empty for every lane; see the deviations entry, Coordination |

**Mutations** (/tmp/vector-v2/everywhere/ev24-mut/mutate.py; results.json and run.log beside it): 32 mutations (the plan's M1 to M19, M14 changed to "the draft links /everywhere", and M20 to M32 from the critique), each red on its named case; every touched file restored from a byte snapshot and matching its sha256 (before.sha256 checked with `sha256sum -c` after the run), src/pages/docs/everywhere.astro absent, and `git status --porcelain` equal to its state before the run. Table in the deviations entry.

**Not run here:** the CI dispatches and the push gate's full turbo typecheck, which belong to the commit gate. No hosted API file changed, so its typecheck was not re-run.

**For the commit gate:** one commit staging these paths explicitly (and, after review round one, api/_lib/everywhere/jobs.ts), as `docs(everywhere): add the unreleased docs draft and owner go-live guides`. The body states that no generated file, env var, flag, switch, workflow, dependency or lockfile changed and nothing is routed; that everywhere-pages.test.ts is unchanged (the plan's exemption was not built; the draft links no /everywhere); the lead's amendment (no legal, privacy, terms or consent text; the guides list it); and the Left open items (the help and manifest wording, the per-platform stop, the set-up steps waiting for the write path, the path filter, Linear's uninstall, the partial account list). Before it: re-run no-topups.test.ts and engine compliance/upstream-free.test.ts after staging. Then `git fetch origin everywhere-finish`, the full turbo typecheck, a fast-forward push, and workflow_dispatch of vector-everywhere.yml (Done-when: green) and typecheck.yml, and optionally vector-hosted-ci.yml for the root scans; not vector-codium.yml.

**Review round one (2026-11-20).** Ten findings, none blocking, all taken (deviations, "2026-11-20, EV-24", "Review round one"). The page's stop sentence now says a push already started finishes and its draft pull request can still open; the intro points to the Codium exception and the Codium sentence names OpenRouter and the provider; the first push bullet no longer promises a push; the Vector Local sentence says every job is declined, tied to the runner's `github` guard; the frontmatter gains the step-3 and Vector Local rewrite notes. The test reads the page and counts a moved page's path at either address (so the 2.0.0 move turns only "is unrouted" red), pins the turn-off guide's 30 seconds and 200 jobs to `SWITCH_CACHE_MS` and the new `SWEEP_LIMIT` export in api/_lib/everywhere/jobs.ts (still 200), checks the prune keep set, widens the machine-path pattern with caught and allowed sentences, and ties the two new frontmatter notes. Step 4 of At 2.0.0 is reworded in all four guides; Left open and the handoff route the path filter to review-fixes and name the untested abort matrix after `pushing`. The draft is 165 lines and the test 675 lines, still 17 cases. Checks, each through vector-serial, one file at a time with `--timeout 30000` (logs in /tmp/vector-v2/everywhere/ev24-r1/):

| Check | Result |
| --- | --- |
| web test/everywhere-docs.test.ts (vector-everywhere.yml), alone, after the last edit | 17 pass, 0 fail, 215 expects, exit 0 |
| web test/everywhere-pages.test.ts | 65 pass, 1 skip (the real-Redis case), 0 fail, 1,943 expects |
| web test/everywhere-sweep.test.ts and test/everywhere-jobs.test.ts (`SWEEP_LIMIT`) | 11/0/99; 43 pass, 9 skip (Redis), 0 fail, 329 expects |
| web test/docs-hands.test.ts and test/vector-mention-copy.test.ts (both read src/drafts) | 6/0/55 and 5/0/103 |
| web test/everywhere-lane.test.ts, after the lane documents | 13 pass, 0 fail, 157 expects |
| root test/no-personal-paths.test.ts, no-project-wording.test.ts, no-topups.test.ts, api-module-loading.test.ts (from test/) | 1/0/2, 2/0/16, 4/0/107 and 2/0/16 |
| `bun typecheck` in packages/web (astro check) | exit 0: 304 files, 0 errors, 0 warnings, 423 hints |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| prettier `--check` on the test and the four guides | clean (jobs.ts is not prettier-formatted in the repository and was left in its own style) |
| `git diff --check`; `git diff --quiet` on docs-nav.ts, script/prune-vector-site.mjs, astro.config.mjs, everywhere-pages.test.ts, DocsPage.astro and packages/desktop | clean; unchanged |
| mutations R1 to R13 (/tmp/vector-v2/everywhere/ev24-r1/mutate.py) | each red on its named case, 16 pass and 1 fail; R12 (the three drafts moved to src/pages) turns only "is unrouted" red; every restore matched by sha256, `git status --porcelain` unchanged (results.json) |
| the 32 earlier mutations, re-run (ev24-r1/earlier-mutate.py) | all 32 red on their named cases; every restore matched by sha256 (earlier-results.json); `git status --porcelain` equal to status-before.txt |

Nothing was committed in this round.

## EV-25: @vector run hooks (R-A1, R-A2, R-A3) (2026-11-20)

Spec §11 R-A1 to R-A3; §3.6 "Correlation". Deviations log: "2026-11-20, EV-25" (it records the lead's four rulings).

**Base and the wait.** `git fetch origin release-finish main everywhere-finish`: HEAD `3c3ddf29` (EV-24) equalled origin/everywhere-finish and held origin/release-finish `67ec3a60`. origin/main `8e34d05e` (264 commits ahead) holds PR #33. review-fixes `e417c44d` is an ancestor. Brain-transport's cloud-agents edits were ancestors of origin/main only, so the package first waited, nothing was built, and the lead was asked:

| Commit | What it changes in EV-25's files |
| --- | --- |
| `7c7508d2` (#43) | cloud-agents-api.ts +7 (artifactKey), cloud-agents-runs.ts, new cloud-agents-run-registration.ts |
| `b4bb9b5c` (BT01) | the brain_upload dispatch input; github-app.test.ts and the fixture |
| `c4ec2c83` (BT03) | cloud-agents-api.ts, cloud-agents-start.test.ts (+386), the cloud-agents-desktop and -brain tests |
| `aa925ff8` (BT09) | cloud-agents-runs.ts (ownerCloudRun and RECORD), cloud-agents-runs.test.ts, cloud-agents-journey.test.ts |

**The merge** (the lead's ruling 1): `1035f87c` `chore(everywhere): merge main after #43`, authored Vector, with parents `3c3ddf29` and `8e34d05e`. It is committed and not pushed: the commit gate pushes it with EV-25. Logs are in /tmp/vector-v2/everywhere/ev25/merge/.

| Check on the merged tree | Result |
| --- | --- |
| `git merge-tree --write-tree --name-only HEAD origin/main` (before) | one conflict, packages/core/src/review/model-evidence.ts; ten files auto-merged |
| model-evidence.ts | REVIEW_PIPELINE_REVISION 5 kept; REVIEW_PIPELINE_SOURCES `01bf6f0a09add29b` as printed; core test/review/model-evidence.test.ts 30 pass, 0 fail, 393 expects |
| `bun install --ignore-scripts --frozen-lockfile` (47311 answered 200) | exit 0 |
| ./packages/sdk/js/script/build.ts (fresh XDG roots) | exit 0; the three auto-merged generated files reproduced byte for byte (no worktree difference) |
| `bun run check:generated` in packages/client | exit 0, no difference |
| `bun turbo typecheck --concurrency=2` (TURBO_CACHE_DIR in the worktree) | 27 of 27 tasks, exit 0 |
| hosted API typecheck | exit 0 |
| core test/local-mode/sources.test.ts | 17 pass, 0 fail, 59 expects |
| desktop src/main/remote-link.test.ts (`--no-env-file`) | 33 pass, 0 fail, 198 expects |
| test/codium-pool.test.ts (from test/; the first run from the repository root hit the root guard and ran nothing) | 29 pass, 0 fail, 496 expects |
| engine test/tool/subagent-lifecycle.test.ts | 18 pass, 0 fail, 80 expects |
| engine test/review/model.test.ts | 21 pass, 0 fail, 90 expects |

**Files** (line numbers in the deviations entry, "What changed"):

- api/_lib/cloud-agents-start.ts, api/_lib/cloud-agents-ledger.ts, api/_lib/cloud-agents-runs.ts, api/_lib/cloud-agents-api.ts;
- packages/engine/src/cli/cmd/github.cloud.ts;
- packages/web/test/cloud-agents-start.test.ts (11 cases, four helpers), packages/web/test/cloud-agents-runs.test.ts (2 cases), packages/engine/test/cli/github.cloud.test.ts (1 case);
- the lane documents: the deviations entry, this receipt, spec notes (§3.6 Correlation, §6.1 CloudEvents, §6.4, §8 VE-30, §11 R-A1 to R-A3) and the handoff's status bullet and EV-25 Left open block.

No generated file, flag, env var, switch, workflow, dependency or lockfile changes in the package itself, and no listener is registered.

**Checks** (each through vector-serial, one file at a time with `--timeout 30000`, against a disposable loopback Redis 7.0.15 on port 6395, `--save '' --appendonly no`, under /tmp/vector-v2/everywhere/ev25/redis; logs in /tmp/vector-v2/everywhere/ev25/checks/):

| Check | Result |
| --- | --- |
| web cloud-agents-start.test.ts, before the new cases (the edited sources only) | 27 pass, 0 fail |
| web cloud-agents-runs.test.ts, before the new cases | 22 pass, 0 fail |
| web cloud-agents-start.test.ts | 38 pass, 0 fail, 12,988 expects (27 existing cases, unchanged, and 11 new); about 20 s, 5 of them S8's bound |
| web cloud-agents-runs.test.ts | 24 pass, 0 fail, 2,436 expects; without VECTOR_TEST_REDIS_URL: 1 pass, 1 skip, 0 fail |
| engine test/cli/github.cloud.test.ts | 75 pass, 1 skip, 0 fail, 897 expects |
| engine test/cli/github.agent-codium.test.ts (it settles) | 45 pass, 0 fail, 1,451 expects |
| every other file vector-at-mention.yml's api step names, each alone | github-oidc 41/0, github-app 73/0, github-app-api 12/0, cloud-agents-artifact-key 3/0, -bind-api 16/0, -binding 42/0, -brain-api 3/0, -brain 11/0, -desktop 6/0, -entitlement-contract 6/0, -journey 4/0, -ledger 38/0, -mint-api 21/0, -owner-artifact 6/0, -readiness 8/0, -run-token 22/0, -service-off 4/0, -status 1/0, -unbind 3/0, -webhook 4/0, account-github-agents 8/0 |
| root test/api-module-loading.test.ts, cli-token.test.ts, no-personal-paths.test.ts, no-project-wording.test.ts (from test/) | 3/0, 9/0, 1/0, 2/0 |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| `bun typecheck` in packages/engine | exit 0 |
| `bun typecheck` in packages/web (astro check) | exit 0: 304 files, 0 errors, 0 warnings, 449 hints (448 on the merge; one is new in the tests). The first run had one error in the new S1 (the expected ticket's `source` and `purpose` widened to string), which was fixed with literal types before the runs above |
| web test/everywhere-lane.test.ts and root test/no-personal-paths.test.ts, after the lane documents | 13 pass, 0 fail, 158 expects; 1 pass, 0 fail, 2 expects |
| `git diff --check` | clean |
| `git diff HEAD...origin/<lane>` over the touched files, for review-fixes, scope-finish, codium-, connect-, hands- and workspaces-finish, native-qualify and brain-transport | empty for every lane |

The one combined process with every cloud-agents file in it, where a leaked listener would show, is vector-at-mention.yml's api step; each file was run alone here.

**Mutations** (/tmp/vector-v2/everywhere/ev25-mut/mutate.py; run.log, results.json and one log per run beside it): 28 mutations of the five source files, one at a time, each with its named test file run alone. All 28 turned their named case red, and every file was restored from its saved bytes and matched its sha256 (the digests are in results.json). Afterwards prettier rewrapped one line of cloud-agents-runs.ts, and the two web files, their no-Redis run and both typechecks were re-run on the final files (checks/final.txt): start 38/0/12,988, runs 24/0/2,436, runs without Redis 1 pass and 1 skip, web 0 errors, hosted API exit 0. Prettier `--check` is clean on the five source files, the engine test and the start test. cloud-agents-runs.test.ts was already not prettier-clean at HEAD (its line 491), so only this package's two hunks were formatted and the old line was left as it was. The table is in the deviations entry.

**Re-verification after the lead's ruling 5** (same day; nothing in the source or tests changed; logs in /tmp/vector-v2/everywhere/ev25/verify/). The uncommitted tree was checked against the lead's description: merge `1035f87c` on parents `3c3ddf29` and `8e34d05e`; the four precondition commits and `e417c44d` are ancestors; origin/main has not moved. `SETTLE_RECORDED` has one caller, `settleRecordedRun`, which reads both the `['committed', outcome]` commit reply and the plain-outcome retry reply. That function has one caller, the settle route. No test fakes the script's reply. The deviations entry now records ruling 5 and drops its "for the lead to confirm" point, and the handoff bullet follows it.

| Check (each alone through vector-serial, `--timeout 30000`, the disposable Redis on 6395) | Result |
| --- | --- |
| web cloud-agents-start.test.ts | 38 pass, 0 fail, 12,988 expects |
| web cloud-agents-runs.test.ts (Redis; without it) | 24 pass, 0 fail, 2,437 expects; 1 pass, 1 skip, 0 fail |
| engine test/cli/github.cloud.test.ts | 75 pass, 1 skip, 0 fail, 897 expects |
| web cloud-agents-mint-api, -ledger, -journey, -service-off, -run-token, -desktop, -bind-api, -unbind | 21/0, 38/0, 4/0, 4/0, 22/0, 6/0, 16/0, 3/0 |
| hosted API typecheck; `bun typecheck` in packages/engine; `bun typecheck` in packages/web | exit 0; exit 0; 0 errors, 0 warnings, 449 hints |
| after these document edits: web test/everywhere-lane.test.ts; root test/no-personal-paths.test.ts (from test/); `git diff --check` | 13 pass, 0 fail, 158 expects; 1 pass, 0 fail, 2 expects; clean |

The runs file's expect count is one more than the earlier 2,436, with the same pass and fail counts and no source or test change in between. The cause was not traced.

**Not run here:** the commit, the push gate's full turbo typecheck and the CI dispatches, all of which belong to the commit gate.

**For the commit gate:**
- One package commit after the merge commit, staging explicit paths: `feat(api): add the @vector run ticket job id and run start and settle listeners`. The body names the ledger edits (RESERVE's optional field and SETTLE_RECORDED's committed reply), the engine settle's optional `prUrl`, that no listener is registered and nothing is enabled, and that no generated file, flag or dependency changed.
- Then `git fetch origin everywhere-finish`, the full turbo typecheck, and `git push origin HEAD:everywhere-finish`, which pushes the merge too.
- Dispatch on everywhere-finish: vector-at-mention.yml (Done-when: green) and typecheck.yml. Because of the main merge, also vector-everywhere.yml and vector-hosted-ci.yml, and never vector-codium.yml while a standalone vector-hosted-ci.yml run is in progress on the ref.
- Record the run ids here and in the handoff.

### EV-25 review round one (2026-11-20)

Seven findings, none blocking; all taken (deviations log, "2026-11-20, EV-25", "Review round one"). Nothing was fetched, merged or committed in the round; HEAD is still the merge `1035f87c`. Logs in /tmp/vector-v2/everywhere/ev25-r1/ (a fresh disposable loopback Redis on port 6395, `--save '' --appendonly no`).

**Files changed this round:** api/_lib/cloud-agents-runs.ts (one budget per notify started before the settle's record read, the budget's AbortSignal passed to each listener, the schema's `PR_URL_PATTERN` in place of the local copy); packages/web/test/cloud-agents-runs.test.ts (R1 checks each listener's signal; new R3); the lane documents: this receipt, the deviations entry ((d), (f), (g), the case table, Left open, What changed, the round's section), the spec (§3.6 note, §6.1 note, §8 VE-30 note, §11 header note, R-A2 note) and the handoff (status bullet, EV-25 Left open block).

| Check (each alone through vector-serial, `--timeout 30000`) | Result |
| --- | --- |
| web cloud-agents-runs.test.ts (Redis) | 25 pass, 0 fail, 2,444 expects (2,443 on the first run; the count varies by one as before) |
| web cloud-agents-runs.test.ts (no VECTOR_TEST_REDIS_URL) | 2 pass, 1 skip, 0 fail, 22 expects |
| web cloud-agents-start.test.ts | 38 pass, 0 fail, 12,988 expects |
| web cloud-agents-mint-api, -ledger, -journey, -service-off | 21/0, 38/0, 4/0, 4/0 |
| root test/api-module-loading.test.ts, no-personal-paths.test.ts (from test/) | 3/0, 1/0 |
| hosted API typecheck; `bun typecheck` in packages/web | exit 0; 0 errors, 0 warnings, 449 hints |
| prettier `--check` on the four api sources and the start test; the runs test | clean; only its old line (now :551) differs, as before |
| after the document edits: web test/everywhere-lane.test.ts; root no-personal-paths and no-project-wording (from test/); `git diff --check` | 13 pass, 0 fail, 158 expects; 1/0; 2/0; clean |
| mutations Ma, Mb, Mc (runs) and Md2, Me (start) | all red on their named cases; every restore matched by sha256 (results.json, results2.json) |

The engine was not changed in this round, so its typecheck and github.cloud.test.ts were not re-run.

## EV-26: @vector bindings record the workflow mode (R-A9) (2026-11-20)

Spec §11 R-A9; §3.6 "Mode is @vector's record". Deviations log: "2026-11-20, EV-26".

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `7a806f91` (EV-25) equals origin/everywhere-finish; origin/main `8e34d05e` and origin/release-finish `67ec3a60` are ancestors, so nothing was merged. Preconditions: review-fixes `e417c44d`, origin/review-fixes `1433d105` and origin/brain-transport `0d18f750` are ancestors. Built uncommitted. **The lead approved the api/_lib/github-app.ts hunk on 2026-11-20**, in its best-effort form, with the fixture and test edits beside it and the bind route's spread; the hunk is outside the brief's file list (deviations log, EV-26, "Commit precondition" and (b); the ruling is quoted under "EV-26 lead ruling and verification" below).

**Files** (line numbers in the deviations entry, "What changed"):

- api/_lib/cloud-agents-binding.ts, api/_lib/cloud-agents-api.ts, api/_lib/github-app.ts;
- packages/web/test/github-app-fixture.ts (additive state and contents route);
- packages/web/test/cloud-agents-binding.test.ts (4 new cases, 3 new rows in one case, the shape test), packages/web/test/cloud-agents-bind-api.test.ts (3 new cases), packages/web/test/github-app.test.ts (2 new cases);
- the lane documents: the deviations entry (and a dated annotation on EV-25's Left open), this receipt, spec notes (§3.4 step 6, §3.6, §6.1 `binding`, §6.4, §8 VE-30, §11 header and R-A9) and the handoff's status bullet and EV-26 loose ends block.

No generated file, flag, env var, switch, workflow, dependency or lockfile changes. The everywhere side is unchanged.

**Checks** (each through vector-serial, one file at a time with `--timeout 30000`, from packages/web unless named, against a disposable loopback Redis 7.0.15 on port 6396 (free: `ss` is not installed here, so the plan's `ss -ltn` check printed nothing; redis-server bound the port, which it refuses when the port is taken, and it was shut down with `redis-cli -p 6396 shutdown nosave` afterwards and its folder removed), `--save '' --appendonly no`, under /tmp/vector-v2/everywhere/ev26/redis; logs in /tmp/vector-v2/everywhere/ev26/checks/):

| Check | Result |
| --- | --- |
| baselines at HEAD, before any edit: cloud-agents-binding, -bind-api, github-app | 42/0, 16/0, 73/0 (EV-25's figures) |
| web cloud-agents-binding.test.ts | 46 pass, 0 fail, 683 expects (42 existing cases, one with three new rows, and 4 new) |
| web cloud-agents-bind-api.test.ts | 19 pass, 0 fail, 5,683 expects; without VECTOR_TEST_REDIS_URL: 0 pass, 1 skip, 0 fail |
| web github-app.test.ts | 75 pass, 0 fail, 6,347 expects |
| every other file vector-at-mention.yml's api step names, each alone | github-oidc 41/0, github-app-api 12/0, account-github-agents 8/0, cloud-agents-artifact-key 3/0, -brain-api 3/0, -brain 11/0, -desktop 6/0, -entitlement-contract 6/0, -journey 4/0, -ledger 38/0, -mint-api 21/0, -owner-artifact 6/0, -readiness 8/0, -run-token 22/0, -runs 25/0, -service-off 4/0, -start 38/0, -status 1/0, -unbind 3/0, -webhook 4/0 |
| root test/api-module-loading.test.ts, cli-token.test.ts, no-personal-paths.test.ts, no-project-wording.test.ts (from test/) | 3/0, 9/0, 1/0, 2/0 |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| `bun typecheck` in packages/web (astro check) | exit 0: 304 files, 0 errors, 0 warnings, 452 hints (449 before; the three new ones are the `await expect(...).rejects` pattern the file already uses, in B4 and G1). The first runs had four type errors in the new tests (a `mode` typed `string`, and an optional binding put in an array), fixed before the runs above |
| prettier `--check` (through vector-serial) on the three api sources and the four test files | clean |
| after the lane document edits: web test/everywhere-lane.test.ts; root no-personal-paths and no-project-wording (from test/); `git diff --check` | 13 pass, 0 fail, 158 expects; 1/0; 2/0; clean |
| `git diff HEAD...origin/<lane>` over the seven touched source and test files, for review-fixes, scope-finish, codium-finish, connect-finish, hands-finish, workspaces-finish, native-qualify, process-finish and brain-transport | empty for every lane |

**Mutations** (/tmp/vector-v2/everywhere/ev26/mut/: run.py, log.txt, log-m18b.txt): 19 mutations of the three api sources, one at a time, each with its named test files run alone. All 19 turned their named cases red (M18 after the non-base64 case was strengthened; it first survived), and every file was restored from its saved bytes and matched its sha256. The table is in the deviations entry.

**Not run here:** the commit, the push gate's full turbo typecheck and the CI dispatches, which belong to the commit gate.

**For the commit gate:**
- The lead's approval of the github-app.ts hunk (and the fixture and test edits beside it): given on 2026-11-20 (below).
- One package commit, staging explicit paths: `feat(cloud-agents): record the workflow mode on repository bindings`. The body names the files, the App's best-effort contents read at the bind token's verified SHA (a failed read records no mode and never fails the bind), that a client's mode is "refused (400)" and never exposed (it says "refused (400)", never "ignored", so reviewers check it against deviation (d)), that no generated file, flag, env, workflow or dependency changed, and the deferrals (the live mode read in EV-30, the port mapping and its tests in EV-29/EV-31).
- Then `git fetch origin everywhere-finish`, the full turbo typecheck, and `git push origin HEAD:everywhere-finish`.
- Dispatch on everywhere-finish: vector-at-mention.yml (Done-when: green) and typecheck.yml. Record the run ids here and in the handoff.

### EV-26 review round one (2026-11-20)

Nine findings, none blocking (deviations log, "2026-11-20, EV-26", "Review round one"). Code: the bind's contents read in api/_lib/github-app.ts is best effort (a failed, missing or over-cap read records no mode and the bind goes ahead); comments in github-app.ts (why the App does not call `readWorkflowOptions`) and cloud-agents-api.ts (the version gate covers own-key too); github-app.test.ts G1 pins the App's reader to core's `readWorkflowOptions` wherever the App names a mode and pins the best-effort read (404, 403, 503, over cap), and G2 is renamed; cloud-agents-bind-api.test.ts A3 is rewritten for the best-effort read; one comment rewrapped in cloud-agents-binding.test.ts. Still uncommitted; the commit precondition is unchanged.

Checks (each through vector-serial, one file at a time with `--timeout 30000`, from packages/web unless named, against a fresh disposable loopback Redis 7.0.15 on port 6396 under /tmp/vector-v2/everywhere/ev26/redis2, shut down and removed afterwards; logs in /tmp/vector-v2/everywhere/ev26/review1/):

| Check | Result |
| --- | --- |
| web github-app.test.ts | 75 pass, 0 fail, 6,416 expects |
| web cloud-agents-bind-api.test.ts | 19 pass, 0 fail, 5,793 expects |
| web cloud-agents-binding.test.ts | 46 pass, 0 fail, 683 expects |
| the other files that drive a bind, each alone: account-github-agents, cloud-agents-desktop, -journey, -runs, -service-off, github-oidc, github-app-api | 8/0, 6/0, 4/0, 25/0, 4/0, 41/0, 12/0 |
| mutations R1 (catch removed), R2 (read at the default branch), R3 (catch answers `{ type: "file" }`) | R1 red on G1 and A3; R2 red on G1 and A1; R3 survives, equivalent (the reader names no mode for a body without base64 content); every restore matched by sha256 (review1/mut/log.txt) |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| `bun typecheck` in packages/web (astro check) | exit 0: 304 files, 0 errors, 0 warnings, 450 hints (452 in the first round; G1 no longer uses the `rejects` pattern) |
| prettier `--check` on the three api sources and the four test files | clean |
| after the lane document edits: web test/everywhere-lane.test.ts; root no-personal-paths and no-project-wording (from test/); `git diff --check` | 13 pass, 0 fail, 158 expects; 1/0; 2/0; clean |

### EV-26 commit gate (2026-11-20): held, not committed

The commit gate ran and stopped before staging anything. The package's commit precondition (the lead's explicit approval of the api/_lib/github-app.ts hunk and the fixture and test edits beside it; deviations log, EV-26, "Commit precondition") has no recorded ruling: no lead ruling or resume note for EV-26 exists, and the commit gate's brief does not name github-app.ts. So nothing was committed, pushed or dispatched. HEAD is still `7a806f91`, equal to origin/everywhere-finish; origin/main `8e34d05e` is an ancestor. `git status` shows only this package's eleven files (three api sources, four web test files, four lane documents), nothing unrelated.

Check at the gate (github-app.ts was last edited after review round one's run of its test): web github-app.test.ts, alone through vector-serial with `--timeout 30000`, 75 pass, 0 fail, 6,416 expects (/tmp/vector-v2/everywhere/ev26/commit-gate/github-app.log); `git diff --check` clean. Once the lead approves, the commit gate re-runs from step 2 as written; if the lead refuses, the github-app.ts hunk, its fixture and test edits and the bind route's spread are dropped together and the package waits.

*Annotation (2026-11-20):* the lead has since approved (next section), so this hold is lifted.

### EV-26 lead ruling and verification (2026-11-20)

The lead's ruling, recorded verbatim in the deviations log (EV-26, "Commit precondition"):

> LEAD RULING 2026-11-20: APPROVED: the out-of-brief edit to api/_lib/github-app.ts (the bind branch's BEST-EFFORT contents read of GithubAgents.WORKFLOW_FILE at identity.workflowSha with the validation token inside the existing try/finally, verifyBind's optional workflowMode return, and the workflowModeOf reader), plus the edits beside it in packages/web/test/github-app-fixture.ts and packages/web/test/github-app.test.ts, and the bind route's spread in api/_lib/cloud-agents-api.ts. The best-effort form chosen in review round one is the approved form: any failed or over-cap read records no mode and the @vector bind still succeeds; the strict 503 form is NOT wanted. A client-supplied mode stays refused with 400, and the commit body must say 'refused (400)', never 'ignored'.

The ruling asked for a verification pass, not a rebuild. Base: `git fetch origin release-finish main everywhere-finish` moved nothing; HEAD `7a806f91` equals origin/everywhere-finish, and origin/main `8e34d05e`, origin/release-finish `67ec3a60` and `e417c44d` are ancestors. `git status` shows only this package's eleven files.

What was verified, by reading the diff:
- **The tree matches the ruling.** The bind branch reads `${root}/contents/${GithubAgents.WORKFLOW_FILE}?ref=<identity.workflowSha>` with `validation.token`, best effort (`.catch(() => undefined)`, no `missing` option); `verifyBind` adds `workflowMode` only when there is one; `workflowModeOf` is the one reader; the bind route passes the mode only when the App verified the bind, read one, and the body's workflowVersion is at least 3; the body key check still refuses `workflowMode` with 400.
- **The validation token is revoked on every path.** The read is inside the existing `try`, whose `finally` runs `revoke(validation.token)`. The read cannot throw past it, because the catch turns every failure into no mode, and every earlier throw in the `try` still reaches the `finally`. G1 checks `tokens.size === 0` after every case, and that every minted token has a `revoke:` event.
- **Nothing of the file is logged or stored beyond the mode literal.** `workflowModeOf` returns only `"codium"`, `"own-key"` or undefined. Neither it nor `api()`, `githubResponseBytes` or `githubUnavailable` (github-http.ts) logs. The decoded text and the header are locals. REDEEM stores only ARGV[16], which `recordRepoBinding` has checked against the two literals. The bind response and the listing do not carry the field (A1).

Checks (each through vector-serial, one file at a time with `--timeout 30000`, from packages/web unless named, against a fresh disposable loopback Redis 7.0.15 on port 6396, free before start: a `/dev/tcp` probe was refused. It ran with `--save '' --appendonly no` under /tmp/vector-v2/everywhere/ev26/verify/redis, and was shut down with `redis-cli -p 6396 shutdown nosave` and its folder removed afterwards. Logs are in /tmp/vector-v2/everywhere/ev26/verify/logs/):

| Check | Result |
| --- | --- |
| web github-app.test.ts | 75 pass, 0 fail, 6,416 expects |
| web cloud-agents-binding.test.ts | 46 pass, 0 fail, 683 expects |
| web cloud-agents-bind-api.test.ts | 19 pass, 0 fail, 5,793 expects |
| the other files that drive a bind or mint, each alone: account-github-agents, cloud-agents-desktop, -journey, -runs, -service-off, -start, -mint-api, github-oidc, github-app-api | 8/0, 6/0, 4/0, 25/0, 4/0, 38/0, 21/0, 41/0, 12/0 |
| root test/api-module-loading.test.ts and cli-token.test.ts (from test/; github-app.ts now imports effect at run time) | 3/0, 9/0 |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| `bun typecheck` in packages/web (astro check) | exit 0: 304 files, 0 errors, 0 warnings, 450 hints (as in review round one) |
| prettier `--check` (through vector-serial) on the three api sources and the four test files; `git diff --check` | clean; clean |
| `git diff HEAD...origin/<lane>` over the seven touched source and test files, after fetching review-fixes `1433d105`, scope-finish `e6d34fed`, codium-finish `58663f5b`, connect-finish `19c48b89`, hands-finish `8139e5fc`, workspaces-finish `e37ec1b5`, native-qualify `2677c32c`, process-finish `3ec7fb14` and brain-transport `0d18f750` | empty for every lane |
| after these lane document edits: web test/everywhere-lane.test.ts; root no-personal-paths and no-project-wording (from test/) | 13 pass, 0 fail, 158 expects; 1/0; 2/0 |

Nothing was broken, so no source or test changed in this pass; only the four lane documents record the ruling. Still uncommitted: the commit (`feat(cloud-agents): record the workflow mode on repository bindings`, whose body says a client's mode is "refused (400)", never "ignored"), the push gate's full turbo typecheck, the push and the vector-at-mention.yml and typecheck.yml dispatches belong to the commit gate. VECTOR_EVERYWHERE_ENABLED stays off.

### EV-26 review round two (2026-11-20)

Four findings, none blocking (deviations log, "2026-11-20, EV-26", "Review round two"). Code: api/_lib/github-app.ts's mode literal is `["codium", "own-key"] as const satisfies readonly WorkflowMode[]` (:816), with one comment line naming the binding's `Mode` as the source of truth (the reader is now :806-834). Documents: deviation (b) and the items for the lead to forward to @vector say the bind's read can add up to 10 s when GitHub stalls (`api()`'s shared timeout; a shorter per-call timeout is not built, since it needs the lead's approval in @vector's file); the spec's §3.4 step 6 note lists the missing, unreadable, over-cap and disagreeing cases; EV-30's tests and VE-50's GitHub acceptance check that a known codium binding has `workflowMode: "codium"` stored (spec §8 VE-30 note, deviations Left open, handoff), in place of a failure counter, since api/_lib has no metrics facility. Still uncommitted; the commit gate is unchanged.

Checks (each through vector-serial, one file at a time with `--timeout 30000`, from packages/web unless named, against a fresh disposable loopback Redis 7.0.15 on port 6396, free before start (a `/dev/tcp` probe was refused), with `--save '' --appendonly no` under /tmp/vector-v2/everywhere/ev26/review2/redis, shut down with `redis-cli -p 6396 shutdown nosave` and its folder removed afterwards; logs in /tmp/vector-v2/everywhere/ev26/review2/):

| Check | Result |
| --- | --- |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| compile-time mutation: `"byok"` added to the literal | the same typecheck exit 2, errors at github-app.ts:816 (the `satisfies`) and :415 (the `verified` assignment); restored from its saved copy, sha256 matched |
| web github-app.test.ts | 75 pass, 0 fail, 6,416 expects |
| web cloud-agents-bind-api.test.ts | 19 pass, 0 fail, 5,793 expects |
| web cloud-agents-binding.test.ts | 46 pass, 0 fail, 683 expects |
| `bun typecheck` in packages/web (astro check) | exit 0: 304 files, 0 errors, 0 warnings, 450 hints (as before) |
| prettier `--check` (through vector-serial) on the three api sources and the four test files; `git diff --check` | clean; clean |
| after the lane document edits: web test/everywhere-lane.test.ts; root no-personal-paths and no-project-wording (from test/) | 13 pass, 0 fail, 158 expects; 1/0; 2/0 |

### EV-26 commit gate (2026-11-20, second run): committed

The lead's ruling lifted the hold above. `git fetch origin release-finish main everywhere-finish` moved nothing: HEAD `7a806f91` equals origin/everywhere-finish, and origin/main `8e34d05e` and origin/release-finish `67ec3a60` are ancestors. `git status` showed only this package's eleven files, all staged by explicit path.

Checks (each through vector-serial, one file at a time with `--timeout 30000`, from packages/web unless named, against a fresh disposable loopback Redis 7.0.15 on port 6396, free before start (a `/dev/tcp` probe was refused), with `--save '' --appendonly no` under /tmp/vector-v2/everywhere/ev26/gate/redis, shut down with `redis-cli -p 6396 shutdown nosave` and its folder removed afterwards; logs in /tmp/vector-v2/everywhere/ev26/gate/logs/):

| Check | Result |
| --- | --- |
| web cloud-agents-binding.test.ts | 46 pass, 0 fail, 683 expects |
| web cloud-agents-bind-api.test.ts | 19 pass, 0 fail, 5,793 expects |
| web github-app.test.ts | 75 pass, 0 fail, 6,416 expects |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| `bun typecheck` in packages/web (astro check) | exit 0: 304 files, 0 errors, 0 warnings, 450 hints |
| push gate: `bun turbo typecheck --concurrency=2` with TURBO_CACHE_DIR in the worktree | exit 0, 27 of 27 tasks |
| `git diff --check` | clean |

The commit is `feat(cloud-agents): record the workflow mode on repository bindings`; its body says a client's mode is "refused (400)", never "ignored". The gate then pushes it to everywhere-finish and dispatches vector-at-mention.yml, typecheck.yml, vector-everywhere.yml, vector-hosted-ci.yml and vector-codium.yml on that ref; their run ids and results go in the next receipt.

## EV-27: the job body route (R-A4, server half) (2026-11-20)

Spec §11 R-A4; §3.6; §8 VE-30; §5 E4, E11. Deviations log: "2026-11-20, EV-27".

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `5b040d39` (EV-26) equals origin/everywhere-finish; origin/release-finish `67ec3a60` and origin/main `8e34d05e` are ancestors, so nothing was merged (re-checked after the build: nothing had moved). Preconditions: EV-25 `7a806f91`, review-fixes `53e98294`, `268bc877`, `e417c44d`, `d7e4aa54`, `ce91a261` and FIT-4 `f251ac2c` are ancestors. Built uncommitted.

**Files** (line numbers in the deviations entry, "What changed"):

- new api/everywhere/jobs/[jid]/body.ts;
- api/_lib/everywhere/jobs.ts, api/_lib/everywhere/keys.ts;
- outside the brief's list: packages/web/test/lib/everywhere-store.ts (the script's twin), .github/workflows/vector-everywhere.yml (one path), packages/web/test/everywhere-lane.test.ts (one helper line);
- new packages/web/test/everywhere-body-api.test.ts (25 cases: 22 local, 3 real-Redis);
- the lane documents: the deviations entry and a dated annotation on EV-25's Left open; this receipt; spec notes (§3.6 Correlation, §3.13, E4, E11, §8 VE-30, §11 R-A1 and R-A4); the handoff's status bullet, an annotation in the EV-25 block and an EV-27 loose-ends block.

api/_lib/cloud-agents-run-token.ts is imported, not edited. No generated file, flag, env var, switch, dependency or lockfile changes; nothing is regenerated (the route is the hosted API, not the engine's HttpApi).

**Checks** (each through vector-serial, one file at a time with `--timeout 30000`, from packages/web unless named; "Redis" is a disposable loopback Redis 7.0.15 on port 6397, free before start (a `/dev/tcp` probe was refused), run with `--save '' --appendonly no` under /tmp/vector-v2/everywhere/ev27/redis, `dbsize` 0 after every run, shut down with `redis-cli -p 6397 shutdown nosave` and its folder removed afterwards; logs in /tmp/vector-v2/everywhere/ev27/runs/):

| Check | Result |
| --- | --- |
| baselines at HEAD, before any edit (pass/fail, expects): everywhere-jobs, -jobs-api, -keys, -erase, -sweep, -lane, -authority, -docs | 43/0 (9 skip, 329), 22/0 (226), 15/0 (126), 11/0 (152), 11/0 (99), 13/0 (158), 20/0 (7 skip, 225), 17/0 (215) |
| web everywhere-body-api.test.ts | 22 pass, 5 skip (R1 to R3 and two hooks), 0 fail, 312 expects; Redis: 25 pass, 0 fail, 338 expects |
| the neighbours, each alone, no Redis: everywhere-jobs, -jobs-api, -keys, -erase, -sweep, -router, -journey-laptop, -journey-laptop-tracker, -pages, -github, -slack-events, -linear-webhook, -jira-a2a, -intake, -audit, -lane, -account-adapter, -docs, -authority | 43/0 (9 skip, 329), 22/0 (226), 15/0 (126), 11/0 (152), 11/0 (99), 9/0 (37), 5/0 (2 skip, 211), 5/0 (4 skip, 345), 65/0 (1 skip, 1,943), 17/0 (137), 12/0 (94), 15/0 (4 skip, 146), 20/0 (3 skip, 251), 8/0 (68), 11/0 (3 skip, 127), 13/0 (158), 4/0 (24), 17/0 (215), 20/0 (7 skip, 225): every count equals its baseline |
| the same files with Redis | 50/0 (393), 22/0 (226), 15/0 (126), 11/0 (152), 11/0 (99), 9/0 (37), 7/0 (329), 9/0 (666), 66/0 (1,953), 17/0 (137), 12/0 (94), 17/0 (163), 21/0 (310), 8/0 (68), 12/0 (131), 13/0 (158), 4/0 (24), 17/0 (215), 25/0 (331) |
| after the last edits (prettier's wrap, R3): body-api, jobs, keys, erase, lane, each alone, no Redis | 22/0 (5 skip, 312), 43/0 (9 skip, 329), 15/0 (126), 11/0 (152), 13/0 (158) |
| packages/cloud src/workflow-compliance.test.ts | 58 pass, 0 fail, 1,104 expects |
| root test/api-module-loading.test.ts, no-personal-paths.test.ts, no-project-wording.test.ts (from test/) | 3/0 (22), 1/0, 2/0. The first test's relative-import scan covers the new route; its second test does not list it (for the lead), so: |
| fresh Node ESM import probe (/tmp/vector-v2/everywhere/ev27/node-probe/: probe.ts, result.txt) | 109 modules compiled one file each; the route imported first, after cloud-agents-run-token.ts, after model-plan-caller.ts, after both, and before both: all five exit 0 with empty stderr, the handler answers 404 `EVERYWHERE_OFF` with no I/O and the caller still refuses a forged `vrt_` token. A copy expecting 200 fails all five |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| `bun typecheck` in packages/web (astro check) | exit 0: 305 files, 0 errors, 0 warnings, 450 hints (EV-26: 304 files, 450 hints; the new file adds none) |
| prettier `--check` on the route, the new test, the lane test and the workflow | clean. jobs.ts, keys.ts and everywhere-store.ts were not prettier-clean at HEAD (479, 27 and 183 differing lines); a script over `git diff -U0` and prettier's output shows that none of prettier's changes falls on a line this package changed |
| `git diff HEAD...origin/<lane>` over the touched files for review-fixes, scope-finish, codium-finish, connect-finish, hands-finish, workspaces-finish, native-qualify, brain-transport and process-finish | empty for every lane |
| after the lane document edits: web everywhere-lane.test.ts, everywhere-docs.test.ts; root no-personal-paths and no-project-wording (from test/); `git diff --check` and a trailing-space search of the two new files | 13/0 (158), 17/0 (215), 1/0, 2/0; clean; none |

**Mutations** (/tmp/vector-v2/everywhere/ev27/mut/: mutate.py, run.log, before.sha256, one junit file and log per mutation): 33 mutations, one at a time, each with everywhere-body-api.test.ts run alone; the three Lua ones (M1L, M2L, M18L) against the Redis. All 33 turned their named cases red, and `sha256sum -c` matched every restored file. The table is in the deviations entry.

**Not run here:** the commit, the push gate's full turbo typecheck, and the vector-everywhere.yml and typecheck.yml dispatches, which belong to the commit gate. packages/web/test/everywhere-cloud-adapter.test.ts and everywhere-journey-actions.test.ts (spec §8 VE-30, VE-33) do not exist yet.

**For the commit gate:**
- One package commit, staging explicit paths: `feat(everywhere): serve an Actions run its job body once by run token`. The body names the three files outside the brief's list (the FakeStore twin, the workflow path, the lane test's helper) and says that nothing was regenerated. Vector identity and the trailers.
- Then `git fetch origin everywhere-finish`, the full `TURBO_CACHE_DIR=/home/user/wt/ev/.turbo/cache bun turbo typecheck --concurrency=2`, and `git push origin HEAD:everywhere-finish`.
- Dispatch vector-everywhere.yml (Done-when: green, with R1 to R3 in its Valkey job) and typecheck.yml on everywhere-finish. Record the run ids here and in the handoff.
- For the lead: add `api/everywhere/jobs/[jid]/body.ts` to test/api-module-loading.test.ts's second test.

### Review round one (2026-11-20)

Ten findings, none blocking; the dispositions are in the deviations entry, "Review round one". Built uncommitted.

**Files:** api/everywhere/jobs/[jid]/body.ts (the local `everywhere`; `platformOn` passed to `readRunBody`); api/_lib/everywhere/jobs.ts (`Decision.before` and its write in `change()`; `startDispatched` links in its step; `Moved`'s `body-gone` and `dispatchJob`'s use of it; `RunBodyRequest` and the platform check in `linkedRun`); api/_lib/everywhere/keys.ts (the comment on `everywhereKeys.run`); packages/web/test/everywhere-body-api.test.ts (`AnswerBody` in place of `any`; K1b's exact answer; new K3 and B15; R1 and R3 pass `platformOn`; now 27 cases: 24 local, 3 real-Redis); the lane documents (the deviations entry's edits, its review section and an annotation on EV-25's listener contract; this receipt and the "three" above; the handoff; the spec's VE-30 and E11 notes).

**Checks** (each through vector-serial, one file at a time with `--timeout 30000`, from packages/web unless named; "Redis" is a disposable loopback Redis on port 6397, free before start, run with `--save '' --appendonly no` under /tmp/vector-v2/everywhere/ev27/review1/redis, `dbsize` 0 after every run, shut down with `redis-cli -p 6397 shutdown nosave` and its folder removed; logs in /tmp/vector-v2/everywhere/ev27/review1/):

| Check | Result |
| --- | --- |
| web everywhere-body-api.test.ts | 24 pass, 5 skip, 0 fail, 327 expects; Redis: 27 pass, 0 fail, 353 expects |
| the neighbours, each alone, no Redis: everywhere-jobs, -jobs-api, -keys, -erase, -sweep, -router, -lane, -docs, -authority, -journey-laptop, -pages | 43/0 (9 skip, 329), 22/0 (226), 15/0 (126), 11/0 (152), 11/0 (99), 9/0 (37), 13/0 (158), 17/0 (215), 20/0 (7 skip, 225), 5/0 (2 skip, 211), 65/0 (1 skip, 1,943): every count equals its baseline |
| with Redis: everywhere-body-api, -jobs, -jobs-api, -erase, -sweep, -router, -authority | 27/0 (353), 50/0 (393), 22/0 (226), 11/0 (152), 11/0 (99), 9/0 (37), 25/0 (331) |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| `bun typecheck` in packages/web (astro check) | exit 0: 305 files, 0 errors, 0 warnings, 451 hints. The one new hint is K3's `await expect(...).rejects` (ts 80007), which other everywhere tests' `rejects` lines also give |
| root test/api-module-loading.test.ts (from test/) | 3/0 (22) |
| the scratch fresh Node ESM import probe, re-run with TMPDIR under /tmp/vector-v2/everywhere/ev27/review1/node-tmp (node-probe.txt) | 109 modules; all five orders exit 0 |
| prettier `--check` on the route and the test | clean, after prettier's one wrap in B15. For jobs.ts and keys.ts, none of prettier's changes falls on a line this package changed |
| mutations (/tmp/vector-v2/everywhere/ev27/review1/mut/) | 11, one at a time, test file alone without Redis: all red; `sha256sum -c` matched jobs.ts and body.ts |

**Not run here:** the commit, the push gate's full turbo typecheck, and the vector-everywhere.yml and typecheck.yml dispatches, which still belong to the commit gate.

## EV-28: the agent phase reads a job's request by reference (R-A4, runner half) (2026-11-20)

Spec §11 R-A4; §3.5.1; §3.6; §5 E1, E4, E11, E13; §8 VE-30. Deviations log: "2026-11-20, EV-28".

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `c1112608` (EV-27) equals origin/everywhere-finish; origin/release-finish `67ec3a60` and origin/main `8e34d05e` are ancestors, so nothing was merged. Precondition: origin/brain-transport `0d18f750` is an ancestor (BT02 and BT05 to BT07b included). Built uncommitted.

**Files** (line numbers in the deviations entry, "What changed"):

- packages/schema/src/everywhere.ts (`ACTIONS_JOB_PROMPT`, `jobOfActionsPrompt`, `ActionsJobBody`, `decodeActionsJobBody`);
- packages/core/src/everywhere/frame.ts (types only: `FrameRepository`);
- @vector's files, additively: packages/engine/src/cli/cmd/github.agent.ts, github.cloud.ts (`send`, `everywhereJobBody`), github.run-helpers.ts (`ChatContext.outside`, `taskPart`'s parameter);
- new packages/engine/test/everywhere/github-agent-body.test.ts (13 cases);
- outside the brief's list: packages/schema/test/everywhere.test.ts (4 cases), packages/web/test/everywhere-body-api.test.ts (B1's cross-check), .github/workflows/vector-everywhere.yml (five paths), packages/web/test/everywhere-lane.test.ts (the same five in `helpers`);
- the lane documents: the deviations entry and dated annotations on EV-27's three EV-28 Left open items; this receipt; spec notes (§3.5.1, §3.6, E1, E11, §6.4, §8 VE-30, §11 R-A1 and R-A4); the handoff's status bullet, an annotation in the EV-27 block and an EV-28 loose-ends block.

github.policy.ts and test/cli/github.agent-fixture.ts are not edited. No generated file, flag, env var, switch, dependency or lockfile changes; nothing is regenerated (no HttpApi route, no config schema, no SDK).

**Checks** (each through vector-serial, one file at a time with `--timeout 30000`, from the owning package; engine files with `TMPDIR=/tmp/vector-v2/everywhere-finish/ev28/tmp`, so every engine boot gets fresh XDG roots; desktop with `--no-env-file`; logs and summaries in /tmp/vector-v2/everywhere/ev28/{base,after,rerun,docs,runs}/). "pass/fail (expects)":

| Check | Result |
| --- | --- |
| baselines at HEAD, before any source edit: the 38 engine test/cli/github*.test.ts files, engine everywhere/unattended-session and compliance/egress-inventory, core everywhere/frame, schema everywhere, desktop everywhere-engine, web everywhere-body-api and everywhere-lane, packages/cloud workflow-compliance | all exit 0 (/tmp/vector-v2/everywhere/ev28/base/summary.txt) |
| the same 46 files after the change | every pass, fail and skip count equals its baseline except schema everywhere.test.ts, 54/0 (412) → 58/0 (460), the four new cases. Expect totals equal the baseline for 42 of them; web body-api is 327 → 329 (B1's cross-check), and two untouched files vary from run to run (next row) |
| the 38 test/cli/github*.test.ts files, after | github-action 17/0 (22); github-remote 16/0 (28); github.agent-channel 2/0 (6); github.agent-cli 2/0 (15); github.agent-codium 45/0 (1,485); github.agent-phase 18/0 (221); github.agents-journey 8/0 (378); github.app 3/0 (19); github.auth 33/0 (209); github.brain 6/0 (54); github.bundle 24/0 (2 skip, 825); github.cloud-lifecycle 2/0 (9); github.cloud 75/0 (1 skip, 897); github.codium-cli 2/0 (10); github.codium-status 1/0 (1); github.evidence 24/0 (112); github.git 1/0 (12); github.install 8/0 (42); github.isolation 36/0 (4,174); github.lifecycle 8/0 (22); github.mcp-framing 2/0 (8); github.output 1/0 (2); github.policy 10/0 (82); github.provider-credentials 4/0 (12); github.publish 26/0 (176); github.review-api 3/0 (17); github.review-codium 4/0 (20); github.review-gateway 3/0 (23); github.review 46/0 (280); github.route-script 17/0 (529); github.route 11/0 (69); github.run-routing 17/0 (71); github.sandbox-build 4/0 (20); github.sandbox 23/0 (2 skip, 157); github.schedule 2/0 (11); github.secrets-stdin 4/0 (8); github.session 13/0 (71); github.workflow 42/0 (873). github.review.test.ts passed and would have been treated as a real failure; the known flake is test/cli/review.test.ts:1050, which is outside this glob and was not run or edited |
| expect totals that vary with timing | github.agent-codium.test.ts: 1,456 (HEAD), 1,485 and 1,452 (two runs after), each 45/0: its lifecycle cases assert every heartbeat of a 20 ms real-time beat. unattended-session.test.ts: 276 (HEAD), 296 and 279, each 7/0 |
| after the last code change (readRequest's two redundant stop checks removed): engine github-agent-body, github.agent-codium, -agent-phase, -agents-journey, -run-routing, -agent-channel, -agent-cli, everywhere/unattended-session | 13/0 (228); 45/0 (1,452); 18/0 (221); 8/0 (378); 17/0 (71); 2/0 (6); 2/0 (15); 7/0 (279) |
| engine test/everywhere/github-agent-body.test.ts | 13 pass, 0 fail, 228 expects (six client cases, seven agent-phase cases; about 25 s) |
| core frame.test.ts; desktop everywhere-engine.test.ts; engine egress-inventory.test.ts; packages/cloud workflow-compliance.test.ts | 18/0 (467); 12/0 (702); 5/0 (12); 58/0 (1,104): equal to the baseline |
| web everywhere-body-api.test.ts | 24 pass, 5 skip (R1 to R3 and two hooks need Redis), 0 fail, 329 expects |
| after the lane document edits: web everywhere-lane.test.ts, everywhere-docs.test.ts; root test/no-personal-paths.test.ts and no-project-wording.test.ts (from test/) | 13/0 (159); 17/0 (215); 1/0 (2); 2/0 (16) |
| `bun typecheck`: packages/schema, core, engine (twice, the second after the last edit), desktop | exit 0 |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| `bun typecheck` in packages/web (astro check) | exit 0: 305 files, 0 errors, 0 warnings, 451 hints (as after EV-27) |
| prettier `--check` | clean for the new test, github.agent.ts, github.cloud.ts, github.run-helpers.ts, the web tests and the workflow. frame.ts, schema everywhere.ts and its test were not prettier-clean at HEAD (3, 36 and 16 differing lines); none of prettier's changes falls on a line this package changed |
| `git diff --check` | clean |
| `git diff HEAD...origin/<lane>` over every touched file for review-fixes, scope-finish, codium-finish, connect-finish, hands-finish, workspaces-finish, native-qualify, brain-transport and process-finish | empty for every lane |

**Mutations** (/tmp/vector-v2/everywhere/ev28/mut/: mutate.py, run.log, before.sha256, before2.sha256, one log per mutation): 25 mutations, one at a time, each with github-agent-body.test.ts run alone. 22 turned their named cases red. M18 and M22 survived, because the run's stop joined to the read's signal already covers both explicit stop checks, which were then removed; M25 (the frame's catch) survives by design, because nothing can reach it. M10, M14, M20 and M25 were re-run after that change. `sha256sum -c` matched all five source files after both rounds. The table is in the deviations entry.

**Not run here:** the commit, the push gate's full turbo typecheck, and the vector-at-mention.yml, vector-everywhere.yml and typecheck.yml dispatches, which belong to the commit gate. Nothing was dispatched: vector-codium.yml is not dispatched before PR #33's merge into this branch (lane rule).

**For the commit gate:**
- One package commit, staging explicit paths: `feat(everywhere): read an Actions job's request by reference in the agent phase`. The body names @vector's three files (github.agent.ts, github.cloud.ts, github.run-helpers.ts), the files outside the brief's list (the schema test, the web body-api and lane tests, the workflow paths), and says that nothing was regenerated. It also says that the vector-everywhere.yml `paths:` hunk sits beside review-fixes' FIT-4 rewrite of the same block, so the merge with review-fixes keeps these five entries (review round one, finding 8). Vector identity and the trailers.
- origin/main moved after the build, from `8e34d05e` to `c776fb60` (#52: three desktop Windows-helper commits). None of them touches a file this package changed (`git diff --name-only 8e34d05e c776fb60`). PR #33 is merged, so the commit gate merges origin/main (merge, never rebase) after the package commit and before the push.
- Then `git fetch origin everywhere-finish`, the full `TURBO_CACHE_DIR=/home/user/wt/ev/.turbo/cache bun turbo typecheck --concurrency=2`, and `git push origin HEAD:everywhere-finish`.
- Dispatch vector-at-mention.yml (the 38 github*.test.ts files), vector-everywhere.yml (the new engine file, the schema and web files) and typecheck.yml on everywhere-finish. Record the run ids here and in the handoff.

### EV-28 review round one (2026-11-20)

Eight findings, none blocking; the dispositions are in the deviations entry, "2026-11-20, EV-28", "Review round one". Built uncommitted.

**Files:** packages/engine/src/cli/cmd/github.agent.ts (everywhereRequest answers `"cancelled"` when the run's signal ended the read, begin returns `{cancelled: true}`, runTask returns `CANCELLED`, `Start` excludes it, and the doc comments say so); github.run-helpers.ts (`ChatContext.outside` and `taskPart`'s `outside` typed `PlatformId`, a type import); packages/core/src/everywhere/frame.ts (header comment only); packages/engine/test/everywhere/github-agent-body.test.ts (`Answer` gets the RequestInit; B4's first stop sub-case relabelled, its new wait sub-case, its title; new B8, last in the file, so B1 to B7 keep their names); the lane documents (the deviations entry, dated EV-28 notes under spec §5 E6 and E7, the handoff's status bullet and loose ends, this receipt).

**Checks** (each through vector-serial, one file at a time with `--timeout 30000`, from the owning package; engine files with `TMPDIR=/tmp/vector-v2/everywhere-finish/ev28/review1/tmp`; logs in /tmp/vector-v2/everywhere/ev28/review1/logs/):

| Check | Result |
| --- | --- |
| engine test/everywhere/github-agent-body.test.ts | 14 pass, 0 fail, 251 expects (six client cases, eight agent-phase cases; about 25 s) |
| engine test/cli/github.agent-phase.test.ts; github.agent-codium.test.ts; github.run-routing.test.ts | 18/0 (221); 45/0 (1,460); 17/0 (71): pass and fail counts equal the baseline; agent-codium's expect total varies with timing (1,452 to 1,485 before) |
| engine test/tool/memory.test.ts (reads `taskPart`'s metadata); test/everywhere/unattended-session.test.ts | 18/0 (110); 7/0 (267; its total varies with timing, 267 to 296 seen) |
| core test/everywhere/frame.test.ts | 18/0 (467), equal to the baseline |
| web everywhere-lane.test.ts, everywhere-docs.test.ts; root test/no-personal-paths.test.ts and no-project-wording.test.ts | 13/0 (159); 17/0 (215); 1/0 (2); 2/0 (16) |
| `bun typecheck`: packages/engine, packages/core | exit 0 |
| prettier `--check`: github.agent.ts, github.run-helpers.ts, github-agent-body.test.ts | clean. frame.ts's one prettier difference (:109) is HEAD's, not on the edited lines |
| `git diff --check` | clean |
| mutations (/tmp/vector-v2/everywhere/ev28/review1/mut/), one at a time, the test file alone | R-M20 (the stop not joined to the read's signal) 12/2, B4 and B5 red; in a scratch run with B4's first two sub-cases removed, the new wait sub-case alone is red. R-M26 (no `cancelled` answer for a signal) 13/1, B8 red. A scratch run of B8 against the unfixed code, expecting the line, passed with a `cancelled` settle (R-M26-settle.log): the settle was already right, the line and runTask's result were not. `sha256sum -c` matched all four touched files after each |

**Not run here:** the commit, the push gate's full turbo typecheck, and the vector-at-mention.yml, vector-everywhere.yml and typecheck.yml dispatches, which belong to the commit gate.

### EV-28 commit gate (2026-11-20)

**Base.** `git fetch origin everywhere-finish main release-finish`: HEAD `c1112608` equals origin/everywhere-finish; origin/release-finish `67ec3a60` is an ancestor. origin/main is now `15f3ba77` (#51 and #52 since the lane's last main merge, touching none of this package's files); the gate's brief merges only origin/everywhere-finish, so main is left for the lead's next main merge. `git status` showed only this package's fourteen files, nothing unrelated.

**Checks** (each through vector-serial, one file at a time with `--timeout 30000`, from the owning package; engine files with `TMPDIR=/tmp/vector-v2/everywhere-finish/ev28/gate/tmp`; logs in /tmp/vector-v2/everywhere/ev28/gate/logs/):

| Check | Result |
| --- | --- |
| engine test/everywhere/github-agent-body.test.ts | 14/0 (251) |
| the 38 engine test/cli/github*.test.ts files | every pass, fail and skip count equals the EV-28 receipt above; expect totals equal too (github.agent-codium 1,452, within its timing range) |
| engine test/tool/memory.test.ts; test/everywhere/unattended-session.test.ts | 18/0 (110); 7/0 (280, within its timing range) |
| schema test/everywhere.test.ts; core test/everywhere/frame.test.ts | 58/0 (460); 18/0 (467) |
| web everywhere-body-api.test.ts; everywhere-lane.test.ts; everywhere-docs.test.ts | 24/0, 5 skip (329); 13/0 (159); 17/0 (215) |
| after this receipt and the handoff edits: web everywhere-lane.test.ts, everywhere-docs.test.ts; root test/no-personal-paths.test.ts and no-project-wording.test.ts (from test/) | 13/0 (159); 17/0 (215); 1/0 (2); 2/0 (16) |
| `bun typecheck`: packages/schema, core, engine, web; the hosted API (`--project ../../tsconfig.json`) | exit 0 (web: 0 errors, 0 warnings, 451 hints) |
| full `TURBO_CACHE_DIR=/home/user/wt/ev/.turbo/cache bun turbo typecheck --concurrency=2` | 27 of 27 tasks successful |

**Commit.** One package commit, `feat(engine): frame an everywhere job body in the GitHub agent phase` (the gate brief's title, in place of the planned `feat(everywhere): …`), Vector identity and the trailers; its body says the vector-everywhere.yml paths hunk sits beside review-fixes' FIT-4, so the merge with review-fixes keeps these five entries. Then the push to everywhere-finish and the dispatches of vector-everywhere.yml, vector-hosted-ci.yml, vector-at-mention.yml, vector-codium.yml and typecheck.yml on that ref. Their run ids and results go in the next receipt.

### EV-28 CI (recorded by EV-29, 2026-11-20)

Dispatched on everywhere-finish at `d605eaed` after the EV-28 commit gate's push:

| Workflow | Run | Result |
| --- | --- | --- |
| Vector everywhere | [44804077346](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44804077346) | success, 9/9 jobs (tests job `136523499386`, with the workflow rules check; typecheck api, app, core, desktop, engine, schema, web) |
| Vector at-mention | [44804086740](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44804086740) | success |
| Vector Codium | [44804092896](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44804092896) | success |
| typecheck | [44804101094](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44804101094) | success |
| Vector hosted CI | [44804082280](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44804082280) | cancelled: all 12 jobs stopped in checkout 4 to 6 s after starting, so it gives no result (the run for `c1112608`, 44782551146, ended the same way). It needs a re-dispatch if EV-28 is to have a hosted-CI receipt |

## EV-29: the Actions fallback adapter: route gating and dispatch (VE-30a) (2026-11-20)

Spec §8 VE-30; §3.4 step 6; §3.6; §5 E8, E11; §6.1. Deviations log: "2026-11-20, EV-29".

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `d605eaed` (EV-28) equals origin/everywhere-finish; origin/release-finish `67ec3a60` is an ancestor. Preconditions, all ancestors: EV-25 `7a806f91`, EV-26 `5b040d39`, EV-27 `c1112608`, EV-28 `d605eaed`, FIT-4 `f251ac2c`, `e417c44d`. origin/main `15f3ba77` (#51, #52) is not an ancestor; the build may not commit, so the convention's main merge is left to the commit step (`git merge-tree --write-tree HEAD origin/main` clean; none of main's 11 changed files is touched here). Built uncommitted.

**Files** (line numbers in the deviations entry, "What changed"):

- new api/_lib/everywhere/adapters/cloud-agents.ts (`createCloudPorts`, `createHandoffBinding`);
- api/_lib/everywhere/runtime.ts (`productionPorts`);
- new packages/web/test/everywhere-cloud-adapter.test.ts (65 cases);
- outside the brief's list: api/_lib/everywhere/ports.ts (`Ports.cloudSource`, two comments), api/_lib/everywhere/router.ts (`routeFacts`' source gate), packages/web/test/everywhere-router.test.ts (three `cloudSource` lines), .github/workflows/vector-everywhere.yml (four paths), packages/web/test/everywhere-lane.test.ts (one `helpers` entry), docs/vector/owner-actions/vector-everywhere-{github,slack,linear,jira}.md (one line each, byte-identical);
- the lane documents: the deviations entry and dated annotations on EV-26's, EV-27's and EV-28's Left open items; this receipt (with EV-28's CI above); spec notes (§3.4 step 6, §3.6, §5 E11, §6.1, §8 VE-30); the handoff's status bullet, annotations on EV-26's, EV-27's and EV-28's loose ends and an EV-29 loose-ends block.

No generated file, flag, env var, switch, dependency or lockfile changes; nothing is regenerated.

**Checks** (each through vector-serial, one file at a time with `--timeout 30000`, from packages/web unless named; logs in /tmp/vector-v2/everywhere/ev29/{base,base-redis,after,after-redis,logs,probe,mut}/; the Redis runs used a disposable loopback redis-server on port 6398 with `--save '' --appendonly no`). "pass/fail (expects)":

| Check | Result |
| --- | --- |
| baselines at HEAD, before any edit: everywhere-router, -remote-adapter, -body-api, -github, -lane, -docs, -jobs, -jobs-api, -intake, -journey-laptop, -journey-laptop-tracker, -sweep, -keys, github-app, cloud-agents-desktop | 9/0 (37); 20/0 (185); 24/0, 5 skip (329); 17/0 (137); 13/0 (160); 17/0 (215); 43/0, 9 skip (329); 22/0 (226); 8/0 (68); 5/0, 2 skip (211); 5/0, 4 skip (345); 11/0 (99); 15/0 (126); 75/0 (6,416); 6/0 (249) |
| baselines at HEAD with Redis: cloud-agents-start, everywhere-router, -jobs, -body-api | 38/0 (12,988); 9/0 (37); 50/0 (393); 27/0 (355) |
| the new everywhere-cloud-adapter.test.ts, without Redis | 64 pass, 3 skip (R6 and its two hooks), 0 fail, 971 expects |
| the same, with Redis | 65/0 (993) |
| the 15 neighbours again, after | every pass, fail, skip and expect count equals its baseline (everywhere-lane 13/0 (160) after its paths and `helpers` edit; everywhere-docs 17/0 (215) after the guides' line) |
| the four Redis neighbours again, after | equal to their baselines |
| root test/api-module-loading.test.ts (its scan includes dynamic imports), no-personal-paths.test.ts, no-project-wording.test.ts (from test/) | 3/0 (22); 1/0 (2); 2/0 (16) |
| packages/cloud src/workflow-compliance.test.ts | 58/0 (1,104) |
| Node ESM probe (/tmp/vector-v2/everywhere/ev29/probe/build.ts and probe.log): runtime.ts's import tree compiled module by module (145 modules, 5 dynamic imports, the three lazy targets among them), run under Node 22 with a loopback KV inside the Node process, the App's env unset and a fetch guard that refuses any host but 127.0.0.1 | exit 0: `productionPorts` with the flag on has no prepareCloud, maps the binding, and answers visibility none (github-app.js loaded, the App off); `createCloudPorts` with a stub App and `liveMode` reaches the default prepare, which loads cloud-agents-start.js and refuses the Slack job (source-unavailable). The KV saw three binding READs and nothing else |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| `bun typecheck` in packages/web (astro check) | exit 0: 306 files, 0 errors, 0 warnings, 452 hints (451 before; the new one is the test's `await expect(...).rejects`, the pattern github-app.test.ts uses) |
| prettier `--check` | clean for the two new files (written with prettier) and runtime.ts. ports.ts, router.ts and everywhere-router.test.ts were not prettier-clean at HEAD; the edits keep their style |
| `git diff --check` | clean |
| `git diff HEAD...origin/<lane>` over every touched file for review-fixes, scope-finish, codium-finish, connect-finish, hands-finish, workspaces-finish, native-qualify, process-finish and brain-transport | empty for every lane |
| after the lane document edits: web everywhere-lane.test.ts, everywhere-docs.test.ts; root test/no-personal-paths.test.ts and no-project-wording.test.ts (from test/) | 13/0 (160); 17/0 (215); 1/0 (2); 2/0 (16) |

**Mutations** (/tmp/vector-v2/everywhere/ev29/mut/: mutate.py, run.log, before.sha256, one log per mutation): 27 mutations, one at a time, the new test file alone without Redis. All 27 turned their named cases red; `sha256sum -c` matched cloud-agents.ts, router.ts and runtime.ts afterwards. The table is in the deviations entry.

**Not run here:** the main merge, the commit, the push gate's full turbo typecheck, and the dispatches, which belong to the commit step.

**For the commit step:**
- First `chore(everywhere): merge main after #52`, a merge commit of origin/main (`15f3ba77` or later), unless a lead ruling for EV-29 says otherwise.
- Then one package commit, staging explicit paths: `feat(everywhere): add the Actions fallback adapter's route gating and dispatch`. The body names the files outside the brief (ports.ts and router.ts for the source gate, the router test's three lines, the workflow paths, the lane test, the four guides), says nothing was regenerated and no flag, env, switch, dependency or lockfile changed, and says production has no prepareCloud until R-C8/R-A8 and EV-30. Vector identity and the trailers.
- Then `git fetch origin everywhere-finish`, the full `TURBO_CACHE_DIR=/home/user/wt/ev/.turbo/cache bun turbo typecheck --concurrency=2`, and `git push origin HEAD:everywhere-finish`.
- Dispatch vector-everywhere.yml (the new file; R6 runs in its Valkey job), vector-at-mention.yml and typecheck.yml on everywhere-finish. Not vector-codium.yml unless the lead asks. Record the run ids in the next receipt and on the handoff.

### EV-29 review round one (2026-11-20)

Ten findings, none blocking; the dispositions are in the deviations entry, "2026-11-20, EV-29", "Review round one". Built uncommitted.

**Files:** api/_lib/everywhere/adapters/cloud-agents.ts (the module comment on the ticket link; `cloudSource` narrows inline, `actionsSource` and `ActionsSource` removed; `currentBinding` catches the lazy import and `bindingFor` together through `readBinding`); api/_lib/everywhere/router.ts (`actions()` checks `cloudSource` itself; both binding reads catch a rejection as none); packages/web/test/everywhere-cloud-adapter.test.ts (`withLoopbackKv` replaces the describe-wide env hooks; P5, P6 and B3 assert the fetch guard; new R7, R8, R9); .github/workflows/vector-everywhere.yml and packages/web/test/everywhere-lane.test.ts (packages/web/test/github-app-fixture.ts in the paths and `helpers`); the lane documents (the deviations entry, the handoff's status bullet, this receipt).

**Checks** (each through vector-serial, one file at a time with `--timeout 30000`, from the owning package; the Redis run used a disposable loopback redis-server on port 6398 with `--save '' --appendonly no`, shut down after; mutation logs in /tmp/vector-v2/everywhere/ev29/fix1/mut/):

| Check | Result |
| --- | --- |
| web everywhere-cloud-adapter.test.ts, without Redis | 67 pass, 3 skip (R6 and its two hooks), 0 fail, 1,040 expects |
| the same, with Redis | 68/0 (1,062) |
| web everywhere-router, -authority, -github, -intake, -remote-adapter, -sweep | 9/0 (37); 20/0, 7 skip (225); 17/0 (137); 8/0 (68); 20/0 (185); 11/0 (99) |
| web everywhere-lane.test.ts, everywhere-docs.test.ts (after the document edits) | 13/0 (160); 17/0 (215) |
| root test/api-module-loading.test.ts, no-personal-paths.test.ts, no-project-wording.test.ts (from test/) | 3/0 (22); 1/0 (2); 2/0 (16) |
| packages/cloud src/workflow-compliance.test.ts | 58/0 (1,104) |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| `bun typecheck` in packages/web (astro check) | exit 0: 306 files, 0 errors, 0 warnings, 452 hints (unchanged) |
| prettier `--check`: cloud-agents.ts, runtime.ts, the new test, the lane test, the workflow | clean. router.ts was not prettier-clean at HEAD; the edits keep its style |
| `git diff --check` | clean |
| mutations M28 to M31, one at a time, the test file alone without Redis | M28 66/1 (R9); M29 66/1 (R8); M30 66/1 (R8); M31 62/5 (B1, H2, P4 three); `sha256sum -c` matched router.ts and cloud-agents.ts afterwards |

**Not run here:** the main merge, the commit, the push gate's full turbo typecheck, and the vector-everywhere.yml, vector-at-mention.yml and typecheck.yml dispatches, which belong to the commit step. The lead's rulings on internal visibility ((c)) and on `no-place` versus `public-repository` ((e)) are still to be recorded under the deviations entry before the commit.

### EV-29 commit gate (2026-11-20)

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `d605eaed` equals origin/everywhere-finish; origin/release-finish `67ec3a60` is an ancestor. origin/main is `15f3ba77` (#51 and #52, touching none of this package's files) and is not an ancestor. The gate's brief merges only origin/everywhere-finish, so, as at EV-28's gate, main is left for the lead's next main merge, and the "First `chore(everywhere): merge main after #52`" step above was not taken. `git status` showed only this package's sixteen files, nothing unrelated. The lead's rulings on (c) and (e) are still open and recorded as open.

**Checks** (each through vector-serial, one file at a time with `--timeout 30000`, from the owning package, without Redis; the turbo log is /tmp/vector-v2/everywhere/ev29-gate-turbo.log):

| Check | Result |
| --- | --- |
| web everywhere-cloud-adapter.test.ts | 67 pass, 3 skip (R6 and its two hooks), 0 fail, 1,040 expects (equal to review round one) |
| web everywhere-router.test.ts; everywhere-lane.test.ts; everywhere-remote-adapter.test.ts | 9/0 (37); 13/0 (160); 20/0 (185) |
| web everywhere-intake, -sweep, -github, -authority, -slack-events, -linear-webhook, -jira-a2a | 8/0 (68); 11/0 (99); 17/0 (137); 20/0, 7 skip (225); 12/0 (94); 15/0, 4 skip (146); 20/0, 3 skip (251): each equals its earlier receipt |
| packages/cloud src/workflow-compliance.test.ts | 58/0 (1,104) |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`); `bun typecheck` in packages/web | exit 0; exit 0 (306 files, 0 errors, 0 warnings, 452 hints) |
| full `TURBO_CACHE_DIR=/home/user/wt/ev/.turbo/cache bun turbo typecheck --concurrency=2` | 27 of 27 tasks successful |
| after this receipt and the handoff and deviations edits: web everywhere-lane.test.ts, everywhere-docs.test.ts; root test/no-personal-paths.test.ts and no-project-wording.test.ts (from test/) | 13/0 (161: its document scan reads one more matching line); 17/0 (215); 1/0 (2); 2/0 (16) |
| prettier `--check` | the two new files and runtime.ts clean; ports.ts, router.ts and everywhere-router.test.ts were not prettier-clean at HEAD either (checked from `git show HEAD:<file>`), and the edits keep their style |

**Commit.** One package commit, `feat(everywhere): add the dormant GitHub Actions fallback adapter` (the gate brief's title, in place of the planned `feat(everywhere): add the Actions fallback adapter's route gating and dispatch`), Vector identity and the trailers. Then the push to everywhere-finish and the dispatches of vector-everywhere.yml, vector-hosted-ci.yml, vector-at-mention.yml, vector-codium.yml and typecheck.yml on that ref (the gate's brief names all five; vector-codium.yml is allowed because PR #33 is on main and merged into this branch). Their run ids and results go in the next receipt.

### EV-29 CI (recorded by EV-30, 2026-11-20)

Dispatched by EV-29's commit gate on everywhere-finish at `3200acc2`: vector-everywhere 44814830700 success; vector-at-mention 44814838340 success; vector-codium 44814843100 success; typecheck 44814850547 success; vector-hosted-ci 44814834365 cancelled after 15 s (20:49:38 to 20:49:53), beside the vector-codium run that calls the same reusable workflow. The vector-everywhere, vector-at-mention and vector-hosted-ci runs were read back here with the GitHub tools (head `3200acc2`, workflow_dispatch); the vector-codium and typecheck conclusions are as EV-30's brief reports them. The hosted-ci cancellation's cause is inferred (a shared concurrency group), not confirmed from its log.

## EV-30: the Actions listeners and the Actions settle transition (VE-30b) (2026-11-20)

Spec §8 VE-30; §3.4; §3.6 "Correlation"; §3.13; §5 E8; §6.1; §6.4. Deviations log: "2026-11-20, EV-30".

**Base.** `git fetch origin release-finish main everywhere-finish`: HEAD `3200acc2` (EV-29) equals origin/everywhere-finish; origin/release-finish `67ec3a60` is an ancestor; EV-25 to EV-29 are ancestors. origin/main (`15f3ba77` at the start, `3670461a` at the end, #53) is not an ancestor and is the lead's to merge (the EV-14 precedent); `git merge-tree --write-tree HEAD origin/main` is clean and none of main's changed files is touched. Built uncommitted.

**Files** (line numbers in the deviations entry, "What changed"):

- api/_lib/everywhere/jobs.ts (`ACTIONS_CRON_GRACE_MS`, `ACTIONS_OUTCOMES`, `ActionsRunEnd`, `startDispatched`'s `jobId` and settle index, `settleDispatched`, `runLinks`, the overdue rule in `timeout`, the cron's read in `sweepOne`, lazy account sweeps);
- api/_lib/everywhere/adapters/cloud-agents.ts (`ACTIONS_OUTCOME`, `createRunHooks`, `createActionsRunEnd`, Jira refused by `cloudSource`);
- new api/_lib/everywhere/run-hooks.ts and run-hooks-registration.ts;
- api/_lib/everywhere/sweep.ts (the cron's reader);
- outside the brief's list: api/_lib/everywhere/keys.ts (`KEEP_MS.runSettle`, `everywhereKeys.runSettle`); @vector's api/cloud-agents/mint.ts and settle.ts (one import line each); .github/workflows/vector-everywhere.yml (four paths); packages/web/test/everywhere-lane.test.ts (three `helpers` entries); docs/vector/owner-actions/vector-everywhere-{github,slack,linear,jira}.md (one line each, byte-identical);
- tests: packages/web/test/everywhere-jobs.test.ts (A1 to A9, one Redis case, the overdue case tightened) and packages/web/test/everywhere-cloud-adapter.test.ts (P13, L1 to L10, C1 to C6);
- the lane documents: the deviations entry and dated annotations on VE-05 "Edges" and on EV-25's, EV-27's and EV-29's Left open items; this receipt (with EV-29's CI above); spec notes (§3.4, §3.6, §3.13, §5 E8, §6.1, §6.4, §8 VE-30); the handoff's status bullet, annotations on EV-25's, EV-27's and EV-29's loose ends, and an EV-30 loose-ends block.

No generated file, flag, env var, switch, dependency or lockfile changes; nothing is regenerated.

**Checks** (each through vector-serial, one file at a time with `--timeout 30000`, from packages/web unless named; logs in /tmp/vector-v2/everywhere/ev30/{base,base-redis,after,after-redis,probe,mut}/; the Redis runs used a disposable loopback redis-server on port 6398 with `--save '' --appendonly no`, shut down after). "pass/fail (expects)":

| Check | Result |
| --- | --- |
| baselines at HEAD, before any edit: everywhere-jobs, -cloud-adapter, -body-api, -sweep, -router, -jobs-api, -erase, -keys, -authority, -intake, -jira-a2a, -journey-laptop, -journey-laptop-tracker, -lane, -docs, cloud-agents-runs, cloud-agents-service-off, cloud-agents-start | 43/0, 9 skip (329); 67/0, 3 skip (1,040); 24/0, 5 skip (329); 11/0 (99); 9/0 (37); 22/0 (226); 11/0 (152); 15/0 (126); 20/0, 7 skip (225); 8/0 (68); 20/0, 3 skip (251); 5/0, 2 skip (211); 5/0, 4 skip (345); 13/0 (161); 17/0 (215); 2/0, 1 skip (22); 4/0 (104); 0/0, 1 skip |
| baselines at HEAD with Redis: everywhere-jobs, -cloud-adapter, -body-api, -authority, -jira-a2a, -journey-laptop, -journey-laptop-tracker, cloud-agents-runs, cloud-agents-start | 50/0 (393); 68/0 (1,062); 27/0 (355); 25/0 (331); 21/0 (310); 7/0 (329); 9/0 (666); 25/0 (2,444); 38/0 (12,988) |
| everywhere-jobs.test.ts after (the final tree), without and with Redis | 52/0, 10 skip (439); 60/0 (515): +9 cases, +1 Redis case |
| everywhere-cloud-adapter.test.ts after (the final tree), without and with Redis | 84/0, 3 skip (1,167); 85/0 (1,189): +17 cases |
| the 16 other neighbours after, without Redis (run twice: after the first build and on the final tree) | every pass, fail, skip and expect count equals its baseline both times (everywhere-lane 13/0 (161) after its `helpers` edit; everywhere-docs 17/0 (215) after the guides' line) |
| the 7 other Redis neighbours after (both times) | every count equals its baseline, except cloud-agents-runs' expect count, which varies on its own: 25/0 with 2,445 expects on the final tree, then 2,444 and 2,443 in two more runs on a flushed Redis; that file and cloud-agents-runs.ts are untouched |
| root test/api-module-loading.test.ts, no-personal-paths.test.ts, no-project-wording.test.ts (from test/) | 3/0 (22); 1/0 (2); 2/0 (16), as at HEAD |
| packages/cloud src/workflow-compliance.test.ts | 58/0 (1,104), as at HEAD |
| Node ESM probe (/tmp/vector-v2/everywhere/ev30/probe/build.ts, probe.log): mint.ts's and settle.ts's import trees compiled module by module, run under Node 22.23 in two fresh processes with a loopback KV inside the process and a fetch guard refusing every host but 127.0.0.1 | exit 0 both. **Flag off:** both routes load (391 ms) and their default handlers are functions; a start notify with a job id and two settle notifies, one with a settle index in the KV, make no KV request and no @vector record read (no listener is registered). **Flag on:** a start notify with a job id imports runtime.js lazily and reads the Codium switch and the ticket (76 ms, cold); a settle notify with no index reads @vector's record once and the index once (6 ms); with an index, the index and the job record (7 ms; the record is absent, so nothing moves) |
| the functions' bundle (the probe's graph count) | mint.ts and settle.ts: static graph 101 → 110 files (1,763,362 → 1,809,613 bytes of source); with lazy imports 101 → 155 files (2,277,266 bytes); 54 files and 513,906 bytes added, almost all runtime.js's graph |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`), on the final tree | exit 0 |
| `bun typecheck` in packages/web (astro check), on the final tree | exit 0: 306 files, 0 errors, 0 warnings, 454 hints (452 at EV-29's gate; the two new ones are C1's `await expect(...).rejects`, the existing pattern) |
| prettier `--check` | clean for the two new files, cloud-agents.ts, the two route files, everywhere-cloud-adapter.test.ts, the lane test and the workflow. jobs.ts, keys.ts, sweep.ts and everywhere-jobs.test.ts were not prettier-clean at HEAD; prettier's difference count is unchanged for jobs.ts (475), keys.ts (27) and everywhere-jobs.test.ts (130), and sweep.ts's grows by two lines only inside `createSweep`'s signature, whose HEAD style the new dep line keeps |
| `git diff --check` | clean |
| `git diff HEAD...origin/<lane>` over every touched file for review-fixes, scope-finish, codium-finish, connect-finish, hands-finish, workspaces-finish, native-qualify, process-finish, brain-transport and main `3670461a` | empty for every lane |
| after every lane document edit: web everywhere-lane.test.ts, everywhere-docs.test.ts; root test/no-personal-paths.test.ts and no-project-wording.test.ts (from test/) | 13/0 (161); 17/0 (215); 1/0 (2); 2/0 (16) |

**Mutations** (/tmp/vector-v2/everywhere/ev30/mut/: mutate.py, run-m1-m5.log, stdout-m6-m30.txt, stdout-rerun.txt, table.md, before.sha256, one log per mutation and file; M31 and M32 from review round one below): 30 mutations, one at a time, the named test files alone without Redis. The first run left two survivors (M14, the cron's due check, which was equivalent and was removed; M20, a repeated settle posting, which needed a case where the settle index outlives the job's end); A9 and L10 were added and M13, M14 (retargeted at the authority gate) and M20 run again on the final tree. All 30 end red; `sha256sum -c` matched jobs.ts, cloud-agents.ts, run-hooks.ts and sweep.ts after every run. The table is in the deviations entry.

**Review round one (2026-11-20; deviations entry, "Review round one").** Eight findings, none blocking. Code: jobs.ts moves `type Sweep` beside `type Overdue` (:1595), makes a job whose authority ended never lazy (:1687), and audits a sweep's end as `outcome ?? state` (:1712); cloud-agents.ts's `createRunHooks` uses `satisfies` (:208) instead of a return annotation; everywhere-jobs.test.ts adds A3's audit assertion and A9's account sweep; everywhere-cloud-adapter.test.ts adds a comment to C2's `finally`. Recorded with no code change: the waiting runs at the head of `jobs:due` (Left open). Checks (logs in /tmp/vector-v2/everywhere/ev30/fix/), each through vector-serial, one file at a time with `--timeout 30000`, from packages/web:

| Check | Result |
| --- | --- |
| everywhere-jobs.test.ts, without and with Redis (disposable loopback redis-server on port 6398, `--save '' --appendonly no`, flushed before each file, shut down after) | 52/0, 10 skip (444); 60/0 (520): +5 expects, no new case |
| everywhere-cloud-adapter.test.ts, without and with Redis | 84/0, 3 skip (1,167); 85/0 (1,189), unchanged |
| everywhere-sweep, -body-api, -authority, -jobs-api, -erase, -journey-laptop, -journey-laptop-tracker, -intake, -jira-a2a, -router, -lane, without Redis | 11/0 (99); 24/0, 5 skip (329); 20/0, 7 skip (225); 22/0 (226); 11/0 (152); 5/0, 2 skip (211); 5/0, 4 skip (345); 8/0 (68); 20/0, 3 skip (251); 9/0 (37); 13/0 (161): each equals its baseline |
| M31 (an account sweep stays lazy for an ended authority), M32 (the cron's settle audited with the state) | each red in exactly its case: jobs 51/1, A9; jobs 51/1, A3; `sha256sum -c` matched jobs.ts after each |
| hosted API typecheck; `bun typecheck` in packages/web | exit 0; exit 0, 306 files, 0 errors, 0 warnings, 454 hints |
| prettier | cloud-agents.ts and everywhere-cloud-adapter.test.ts `--check` clean; the difference count is unchanged for jobs.ts (475) and everywhere-jobs.test.ts (130) |
| after the lane document edits: web everywhere-lane.test.ts, everywhere-docs.test.ts; root test/no-personal-paths.test.ts and no-project-wording.test.ts (from test/); `git diff --check` | 13/0 (161); 17/0 (215); 1/0 (2); 2/0 (16); clean |

**Not run here:** the commit, the push gate's full turbo typecheck, and the dispatches, which belong to the commit step.

**For the commit step:**
- No main merge (deviations entry, "origin/main"); the lead owns it.
- One package commit, staging explicit paths: `feat(everywhere): settle Actions jobs from run start and settle hooks`. The body names what is outside the brief: the files (keys.ts, the two new modules, @vector's mint.ts and settle.ts, the workflow paths, the lane test, the four guides) and the behaviour change to EV-29's adapter (`cloudSource` refuses Jira, deviation (j), with the four guides' line that says so); it says nothing was regenerated and no flag, env, switch, dependency or lockfile changed, and says production still has no Actions route. Vector identity and the trailers.
- Then `git fetch origin everywhere-finish`, the full `TURBO_CACHE_DIR=/home/user/wt/ev/.turbo/cache bun turbo typecheck --concurrency=2`, and `git push origin HEAD:everywhere-finish`.
- Dispatch vector-everywhere.yml (the Redis cases in its Valkey job), vector-at-mention.yml (cloud-agents-start, -runs and -service-off import the route files) and typecheck.yml on everywhere-finish. Record the run ids in the next receipt and on the handoff.

### EV-30 commit gate (2026-11-20)

`git fetch origin everywhere-finish release-finish main`: origin/everywhere-finish is `3200acc2`, HEAD's parent, so nothing was merged; origin/main `3670461a` is left for the lead (the deviations entry, "origin/main"). `git status` held only this package's files. Checks on the final tree, each through vector-serial, one file at a time with `--timeout 30000`, from packages/web unless named; the Redis runs used a disposable loopback redis-server on port 46391 with `--save '' --appendonly no`, shut down after. "pass/fail (expects)":

| Check | Result |
| --- | --- |
| everywhere-jobs.test.ts, without and with Redis | 52/0, 10 skip (444); 60/0 (520) |
| everywhere-cloud-adapter.test.ts, without and with Redis | 84/0, 3 skip (1,167); 85/0 (1,189) |
| everywhere-body-api.test.ts, without and with Redis | 24/0, 5 skip (329); 27/0 (355) |
| everywhere-lane.test.ts; everywhere-sweep.test.ts | 13/0 (161); 11/0 (99) |
| cloud-agents-runs.test.ts and cloud-agents-mint-api.test.ts (the mint route's import), with Redis | 25/0 (2,444); 21/0 (6,398) |
| root test/api-module-loading.test.ts (from test/) | 3/0 (22) |
| hosted API typecheck (`cd packages/engine && bun typecheck --project ../../tsconfig.json`) | exit 0 |
| full `TURBO_CACHE_DIR=/home/user/wt/ev/.turbo/cache bun turbo typecheck --concurrency=2` | exit 0, 27/27 tasks; packages/web 306 files, 0 errors, 0 warnings, 454 hints |
| prettier | as in the receipt above: the difference count is unchanged for jobs.ts (475), keys.ts (27) and everywhere-jobs.test.ts (130); sweep.ts's 16 → 18 only inside `createSweep`'s signature |

**Commit.** One package commit, `feat(everywhere): settle Actions jobs from run start and settle hooks`, Vector identity and the trailers; then the push to everywhere-finish and the dispatches of vector-everywhere.yml, vector-hosted-ci.yml, vector-at-mention.yml, vector-codium.yml and typecheck.yml on that ref (the gate's brief names all five). Their run ids and results go in the next receipt.
