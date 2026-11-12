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
