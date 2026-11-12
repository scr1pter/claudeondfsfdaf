# Vector everywhere build progress

The handoff, detailed contract and accepted decisions remain in
`vector-everywhere-handoff.md`, `vector-everywhere-spec.md` and
`vector-everywhere-deviations.md`. This continuation uses isolated branch
`build-everywhere`; nothing is merged to main or registered with a platform.

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
