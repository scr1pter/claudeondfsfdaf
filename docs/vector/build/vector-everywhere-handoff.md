# Vector everywhere: handoff (2026-11-11)

This build moves to a new agent. Start here, then read the contract (`vector-everywhere-spec.md`) and the deviations log (`vector-everywhere-deviations.md`) in this folder. The deviations log records every reading the build made where the contract was silent or wrong about the code; it wins over the contract where they differ.

## Current continuation status (2026-11-12)

This section supersedes the original handoff status below. The 2026-11-12 continuation ran on branch `build-everywhere`, based on `vector-everywhere` at `f9b19a041`. **Reviewed P1c/P2 software at `15e92e6ac9d75885f53e1edc3ff2712ad5eb9c85` was pushed normally to `vector-everywhere` and passed dedicated and general CI.** No main push, PR or platform registration is authorized by this checkpoint. *2026-11-15:* `build-everywhere`, `vector-everywhere` and `v2-everywhere` are now merged history inside PR #33 (head branch `release-finish`), and the isolated worktree this paragraph used to name is gone. The current vehicle is PR #33, then this lane's branch `everywhere-finish`, which was cut from `release-finish` at `0ee486e3` (see "Tier B status at 0ee486e3" in vector-everywhere-progress.md).

**Latest P2 checkpoint:** VE-10 through VE-13 and the whole-phase authority repairs passed the affected local checks and two read-only production reviews. The first phase CI exposed a real cooldown response-contract defect: native Redis `ZSCORE` may return a number. Commit `15e92e6ac` repaired that parser and added numeric/string/malformed response cases; root batch084 passed the focused tests and API types. Exact-source hosted results are now:

| Check | Run | Result |
| --- | --- | --- |
| Vector everywhere | [43228105045](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43228105045) | Success, 9/9 jobs; test job `131217999679` reports 53/53 files |
| General typecheck | [43229968596](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43229968596) | Success |
| General test | [43229955763](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43229955763) | Attempt 2 success; 21 successful jobs, 3 intentional manual-only skips |

All three runs identify the exact `15e92e6ac9d75885f53e1edc3ff2712ad5eb9c85` source. The general test's first attempt had only two Windows setup failures: shards 3/12 and 7/12 received Chocolatey community-feed HTTP 504 while fetching ripgrep 15.2.0, before build/tests. The other Windows shards installed that same package and passed. Root retried only those two failed jobs once; no source or workflow change was made for the retry. These results qualify the software checks, not production platform/runner integration or launch readiness.

| Package | Current implementation | Commit/evidence |
| --- | --- | --- |
| VE-06 | Router, intake, production jobs event hooks, terminal-post outbox and sweep; integrations default off | `252ce0e3f` |
| Baseline CI repair | Canonical display-link formatter moved to import-free shared schema; unchanged compliance test passes locally | `bb37de676` |
| VE-07 | Unwired runner and desktop boundaries; absent safe-worktree capability holds work, shell remains denied | `d27b7aaf7` |
| VE-08 | Actual authenticated loopback engine behaviour, test only | `88276591c`; 3 passed / 58 assertions, engine types pass |
| P1c identity repair | Actual project remote and strict PR URL validation | `79e1f0353`; focused tests and desktop types pass |
| P1c independent-review repairs | Fair post retries, atomic delivery admission, active worktree config and canonical git identity, hunk-aware secret/privacy scanning | `8a6d7b4ef`; local checks, re-review and all nine dedicated jobs pass |
| VE-10 | Injected GitHub handoff/status adapter and desktop reference verification | `ffd6ced0b`; five focused files and API/schema/desktop types pass; default production handoff remains 501 |
| VE-11 | Signed native Slack adapter, OAuth/manifest, deterministic runtime factories, atomic installation/quota admission and authorization-bound replies | `c9d125e0dac3796d141cbfb3742ab459696ecacd`; final focused checks and API types pass |
| VE-12 | Signed native Linear adapter, rotating native OAuth pairs, immutable prompt/selection proof, scoped session admission and recovery | `cd4fcab18694a21abef50f5909db0a8a80df6723`; four focused files, five shared regressions and API/web types pass (batch052) |
| VE-13 | Native Jira FIT/A2A, user-token context proof, input drafts and indexed erasure, source-only Forge manifest | `2317c5edd`; local checks and final `15e92e6ac` dedicated/general CI pass |
| P2 independent-review repairs | Exact account/link/map/install authority, durable closing/epochs, all-key Lua preflight, native semantic receipts, revocation serialization and owner recovery | `4915bc64a`; final local checks, two production reviews and actual hosted Redis cases pass at `15e92e6ac` |
| Native cooldown repair | Accept native numeric scores while refusing malformed/negative responses | `15e92e6ac`; batch084 focused checks and all exact-source CI above pass |

Independent review and re-review closed the five reported P1c findings; the optional-worktree-config compatibility correction was also reviewed without a new blocker. Final local repair receipts: dedupe 8 passed / 36 assertions; jobs 43 / 334; intake 6 / 29; sweep 6 / 34; git 7 / 73; scan 4 / 24; runner 12 / 59. API and desktop typechecks pass. Dedupe skips two real-Redis cases and two setup/teardown hooks locally; jobs skips five real-Redis cases and two hooks. Exact scope and earlier receipts are in `vector-everywhere-progress.md`.

**Current gates and remaining coverage:**

- **Whole-P2 software checks are qualified locally and in CI.** Exact authorized active-to-closing CAS, private installation epochs, record/index writes, exact link/mapping admission, canonical counter/type preflight, actor404 privacy and native generation receipts are implemented and reviewed. Native revocation has pending/confirmed/uncertain phases: another eraser cannot permit reconnect while an old operation may be in flight. Uncertain outcomes erase local content and credentials while retaining minimal closing metadata; owner GET/202 exposes `review-native-revocation`, and retries cannot assert native confirmation. Confirmed cleanup interruptions remain visible with `retry-disconnect`. There is no automatic process-death/native reconciliation in this phase.
- **The actual Codium deletion adapter remains a prerequisite gate.** The trusted port must provide the correct mode-separated read-only tombstone key; missing authority fails closed, including audit writes to unverified accounts. Local erasure does not require that active-account adapter. This branch does not import Codium's tombstone implementation and does not claim that integration is qualified. Permanent minimal account/epoch markers prevent delayed write resurrection. *2026-11-15:* the port is now wired. `productionPorts` returns `codiumAccountAuthority` (api/_lib/everywhere/runtime.ts:16-18), which takes Codium's `tombstoneKey` (api/_lib/everywhere/adapters/account.ts:2, :7-13; commit `75532fc36`). The integration is still unqualified against a live deletion.

- Earlier general-CI wording and Localmode fixture failures were repaired in `565c03ea8` and are covered by the successful final-source general run above; older-head receipts are retained as history.
- Dedicated run `43228105045` exercised the new fences on healthy digest-pinned Valkey 7.2.14: erased-link/deleting-account admission before quota/index writes, readiness bounds and erasure, wrong-type unchanged poststate, in-flight native-revocation cleanup, `00`/`01` counter refusal, native-resource reservations, Jira drafts, delivery/claim/slot races and cooldown maximum ordering. The locally skipped Redis cases therefore have actual hosted proof at the final source. VE-10 remains an injected port with no real App registration. Linear directory distribution, native payload/permission qualification and the private result surface remain explicit gates.
- Component tests do not qualify a real laptop, relay, platform app or Actions workflow. The explicit safe-worktree capability, its physical placement, signing-key handoff and R-M2 offline shell remain unwired/unproven here. R-M3's screened outward Brain audience remains a separate prerequisite; VE-08 proves personal-fact exclusion, not that entire audience contract.
- **Runner abort matrix (2026-11-15; complete at component level by EV-03; CI green: vector-everywhere 43675734861, typecheck 43675742876).** packages/desktop/src/main/everywhere-runner.test.ts, line numbers after EV-03:
  - every approval rejected (:297), and an engine question rejected (:306);
  - a server `stop` and `lost` answered to `started` and `heartbeat` (:325-359);
  - the actual jobs client's HTTP 404 and 409 on `started` and `heartbeat` (:361-417);
  - five minutes without a heartbeat acknowledgement (:420), and an acknowledgement keeping a live job past the first lease boundary (:462);
  - toggle-off, Stop and the deadline (:489), and recovery (:506);
  - EV-03: a lost acknowledgement of a `held` result replays it exactly, with its branch (:538); `stop` and `lost` answered to `pushing` (:566); the actual client's 404 and 409 on `pushing` (:611); a `stop` heard on a heartbeat after `pushing`, before the push is admitted (:654); a switch `stop` during an admitted confirmed or ambiguous push (:690); a `stop`, `lost`, 404 or 409 heartbeat during an admitted push whose publication settle is refused (:747).

  EV-03 fixed one runner defect (the `held`/`no-changes` settle now replays its exact result, everywhere-runner.ts:320). This is component-level evidence only: no real laptop, relay or jobs server. Two points wait for the lead (deviations log, EV-03): the brief's "no settle after 404/409" against the runner's bounded settle, and whether a stop heard during the push should suppress the draft PR.
- **Sweep cron (2026-11-15, EV-04; CI green: vector-everywhere 43678721793, vector-hosted-ci 43678724007, typecheck 43678728633).** vercel.json runs `/api/everywhere/sweep` every minute (R-C11), but only once the owner deploys a commit that contains it; until then the lazy sweeps of spec 3.4 are the only sweeps. While VECTOR_EVERYWHERE_ENABLED is off the sweep answers 200 `{enabled: false}` after the method and CRON_SECRET checks and before any switch read or store call (api/_lib/everywhere/sweep.ts:29); without CRON_SECRET in production every call answers 401. The safe turn-off order (Codium's `everywhere` switch to `stop`, one sweep, then the flag) needs EV-07's switch; until then unsetting the flag is the only way to turn off, and the replies of live jobs then wait for the next enabled sweep. Turn-off and turn-on orders: vector-everywhere-deviations.md, "2026-11-15, EV-04".
- **Relay presence (2026-11-15, EV-05; CI green: vector-hosted-ci 43680776690, vector-everywhere 43680774247, typecheck 43680782059).** The relay's presence answer (behind `isComputerOnline` and `relayPresence`) now says offline, with an optional `reason` (`killed` or `suspended`), while the kill flag is set or cannot be read, or the account is suspended (R-C4; packages/relay/src/account-relay.ts presence()). It takes effect only after the owner deploys the relay Worker. The router still checks `readSwitch("remote")` itself (E10), and VE-20 must use presence only: the relay `devices` list and the phone's peers list still follow open sockets while the flag is set. The check is in the Durable Object only, not also in the Worker (deviations log, "2026-11-15, EV-05").
- **Relay job offers (2026-11-15, EV-06; CI pending).** The relay forwards the API's signed `POST /internal/v1/job-offer` `{account, offer}` (R-C1) as one binary frame to every live computer of the account, never to a phone: byte 0 `0x02`, sixteen zero device bytes, then the offer string unchanged (packages/relay/src/account-relay.ts `jobOffer()`; the layout in protocol.ts). It checks only the offer's form; the desktop verifies the signature (E9). It sends nothing while the kill flag is set or unreadable, or the account is suspended, and accepts at most 30 offers an hour per account (429 `RELAY_OFFER_LIMIT`). A client-sent `0x02` still gets a `reserved` notice. Nothing calls it yet: `RelayAction` gains `job-offer` in EV-09, the desktop decodes offers from EV-11, `OFFER_KEYS` is empty, and the owner deploys the Worker. Offers are delivered even to an account over its awake-hours (deviations log, "2026-11-15, EV-06").
- P3, P4, Surfaces and go-live retain their specified merge and owner gates. No registration, credentials/settings change, paid inference, PR, release or main merge occurred in this continuation.

**What Vector everywhere is:** an @Vector bot on GitHub, Slack, Linear and Jira that is local-first.
- When the owner's computer is online, jobs run there through the Vector Remote relay.
- Otherwise they run in the owner's own GitHub Actions (that route comes after @vector merges), or they wait.
- Vector's servers relay messages and never hold code.

## Original handoff state (2026-11-11, historical)

- **Branch** `vector-everywhere`, cut from `main` at `0dcbb8e2` (PR #20). The branch is pushed and clean. Everything is on GitHub.
- **Built, reviewed and repaired:** phases P1a and P1b, which cover VE-00 to VE-05. After each phase, three reviews ran (works for real, security and fail-closed, fits the code base), followed by one repair commit.

| WP | What | Commit |
|---|---|---|
| VE-00 | CI lane (`.github/workflows/vector-everywhere.yml`) | `44e50686a` |
| VE-01 | Shared types and limits | `f608e7628` |
| VE-02 | Pure policy and framing | `1e4a1180a` |
| P1a review repairs | | `87501d140` |
| VE-03 | Server foundation | `5f8c1d837` |
| VE-04 | Identity, links, installs and mappings | `948ccf156` |
| VE-05 | Jobs, offers and leases | `73c52bd8a` |
| P1b review repairs | | `12f1793fe` |

- **CI at handoff:** on `12f1793fe`, typecheck passed. The `Vector everywhere` lane (run 43141557877) and `test` (run 43141563331) were still queued.
  - Check them first.
  - The lane has not yet been confirmed green on GitHub; every WP so far lists that as its open item.
  - The real-Redis cases run only in the lane, which has Redis. Redis must not run on the owner's Mac.
- Only this handoff note and the spec's status line came after `12f1793fe`.

## Build order

1. **Phase P1c:** VE-06, VE-07 and VE-08 are implemented with local scoped validation and reviewed repairs. Finish the exact-head hosted qualification described above before the next package build. The production jobs API now has all five event hooks; no platform or relay adapter is activated.
2. **Phase P2, the platform intakes:** VE-10 GitHub, VE-11 Slack, VE-12 Linear, VE-13 Jira (VE-13 starts by re-reading the Atlassian pages). Built. The real OAuth exchanges exist (corrected 2026-11-15). `platformExchanges` (api/_lib/everywhere/oauth-exchanges.ts:7) builds Slack's install exchange and Linear's install and sign-in-link exchanges for each platform in `config.platforms`, that is listed in VECTOR_EVERYWHERE_PLATFORMS with complete settings while the feature is on (config.ts:159-163). `createAccountApi` uses it unless a test injects `exchanges` (api/_lib/everywhere/account-api.ts:333). `oauth-finish` answers 404 for a platform that is not on (`platformOn`, config.ts:222; identity.ts:1455), and 501 `EVERYWHERE_UNAVAILABLE` for a platform that is on but has no exchange for that purpose: Slack has no sign-in-link exchange, and GitHub and Jira have none (identity.ts:1456-1458).
3. **Final review** of the whole branch (`a6db1513d..HEAD`), then repair.
4. **Later phases wait,** as the contract says:
   - Phase 3 (VE-20 to VE-22, laptop route): after `codium` merges.
   - Phase 4 (VE-30 to VE-33, Actions fallback and GitHub laptop-first): after `vector-at-mention` merges, plus Codium's A59. VE-30 also adds the Actions settle transition.
   - Phase S (VE-40 to VE-44, surfaces): lands as one piece after the next large merge.
   - VE-50 (go-live): runs with the owner after each platform is registered.
   - *2026-11-15:* `codium` (`1ce8f5f3`) and `vector-at-mention` (`c0d10fb8`) are in this lane's base (`release-finish`, PR #33). Their merge into `main` waits for PR #33, which needs the owner's yes. The lane builds Phases 3, 4 and S on that base behind the flag; the go-live gates in spec §7, Codium's A59, R-A6/Q13 and the owner actions are unchanged.

Each phase was built one WP at a time: build it, run its own test files, typecheck, commit. Then three reviews ran across the phase, one repair commit followed, then a push and CI. Keep that pattern; it found real issues in both phases.

## Owner decisions

- **Confirmed by the owner on 2026-11-11** ("Keep them"): the recommended answer to every question in section 10 (Q1 to Q14). Notably:
  - no teammate allowlist at launch (Q2);
  - refuse approvals during unattended runs (Q7);
  - push and open draft PRs on private repositories (Q8);
  - no "Run on Vector's computer" at launch (Q9);
  - every paid plan gets the `everywhere` perk, with no CLI at launch (Q11).
- **Owner actions still to come** (section 10):
  - register each platform app (GitHub through @vector's steps, then Slack, Linear and Jira);
  - generate the data key and the offer signing key pair;
  - the privacy and legal read;
  - forward the section 11 requests to the Codium, @vector, Hands and `main` owners.
- **No platform app is registered, and nothing lands on `main`, without the owner's yes.**

## Left open by the repairs

Each item below is also in the deviations log.

- **Records that don't decode.** A job record that doesn't decode keeps its index place and is skipped and logged. It is not removed, because it may be a newer deployment's live job after a rollback.
- **Unknown fields (corrected 2026-11-15).** `decodeJobRecord` refuses a stored record that has any field it does not know (api/_lib/everywhere/jobs.ts:286-289), because this code writes back the record it decoded and would otherwise drop a newer deployment's fields. Such a record is one that does not decode (item above): `readJob` throws for it (:391-392) and routes answer 503, and the sweep skips and logs it in its index place, as the deviations log's VE-03 to VE-05 review-fixes entry says.
- **Secret scan.** `decodeSettle` has no secret scan, because the server sanitizes again in `renderResult`.
- **Codium's ErasePart shape.** The contract's guess was wrong; it is `{id, configured(), requires?, erase(account, context)}`, and `EVERYWHERE_ERASE_PART` follows it. Codium registers it in its own file (R-C9).
- **Native disconnect revocation:** the production Slack factory now opens and revokes only its own sealed bot token before erasure. Custom injected exchange transports own their revocation port; Linear now seals rotating credential pairs and revokes its own refresh grant; Jira remains in its later package scope.
- **Publication under a stop or cancel (EV-03, open).** Under the stop switch the jobs API answers a publication settle 200 `stop` without recording it; the desktop counts that as delivered and clears its receipt, and the platform reply says the run was cancelled, with no branch or PR. After a platform or user cancel, a lost job or a sponsor 404 during the push, the server refuses the publication settle, so the receipt stays pending, recovery re-sends it on every start, and 32 such receipts would stop the computer taking jobs. A stop heard during the push still opens the draft PR (pinned; open question). The follow-up is named in the deviations log's EV-03 entry.
- **Single settles outside the push boundary (EV-03, open).** The no-safe-worktree and needs-approval settles are still sent once; a lost acknowledgement there is replaced by a `failed` result. The follow-up routes both through `deliver`.

## How CI runs on this branch

- *2026-11-15:* on `everywhere-finish`, none of the workflows the lane uses (vector-everywhere.yml, typecheck.yml, test.yml, vector-hosted-ci.yml, vector-at-mention.yml) has a push trigger for the branch, so every run is a `workflow_dispatch` on `everywhere-finish` until a pull request from `everywhere-finish` is open; then each workflow's `pull_request` trigger also runs (test.yml always, typecheck.yml for a pull request into `main`, the lane workflows by their paths). The rest of this section describes the retired `vector-everywhere` branch.
- The `Vector everywhere` lane runs on every push to this branch, with Redis, and covers every `everywhere` test file plus the typechecks.
- Also dispatch the general checks:

```bash
gh workflow run test.yml -R scr1pter/claudeondfsfdaf --ref vector-everywhere
gh workflow run typecheck.yml -R scr1pter/claudeondfsfdaf --ref vector-everywhere
```

Read failures with `gh run view <id> -R scr1pter/claudeondfsfdaf --log-failed`. Re-run once with `--failed` only when the failure is a known flake and nothing else failed in that job. Known flakes:
- a Bun segfault on a Linux shard;
- Windows: `local-fit.test.ts`, `prompt.test.ts` (3 s), `task-size.test.ts` (30 s), effect-flock contention, `local.test.ts` probe 400, engine `test/tool/task-manage-abort.test.ts` (2 s wait);
- packet capture DNS, or the 55-minute packet-capture setup timeout.

## Rules (from the owner; all still binding)

- **Never:**
  - push to or merge into `main`;
  - open or merge a pull request, register an app, cut a release, or delete a branch without asking the owner first;
  - force-push, use `--no-verify`, or use `git stash`.
- **Installs, tests and typecheck:**
  - Install with `bun install --ignore-scripts`.
  - Run tests one file at a time from the package directory (`bun test --timeout 30000 <file>`), and `bun typecheck` from package directories.
  - Full suites run in GitHub CI only. Heavy local suites have crashed the owner's Vector app.
- **Platforms:** no test ever calls a real Slack, Linear, Atlassian, GitHub or relay host. Use the local fakes and the fetch guard (contract section 9).
- **Things to leave alone:**
  - Never read credential files.
  - Never put the owner's email address in the repository.
  - Never name the open-source project this code was forked from, anywhere.
  - Never touch tokenomics or benchmark files or branches. Another agent owns them, and they matter a lot.
- **Other agents' branches:** don't edit `hands`, `vector-at-mention` (Codex), `vectorscope`, `codium`, `codium-track`, `connected-workspace` or `cloud-workspaces`. Never edit a file on the contract's "Do not touch" list (6.4), and keep edits to shared files (6.5) additive, at their anchors.
- **The owner's machine:**
  - Never start or restart the Vector app.
  - Never operate the owner's real computer in tests.
- **Copy:** make no public or comparative claims, and no claim of parity with any other product, without the owner's yes.

*Annotation (2026-11-15, by the everywhere-finish lane; the owner's rules above and the "Owner decisions" line "nothing lands on `main` without the owner's yes" are unchanged):* `main` changes only through the lead's merge of a reviewed PR, with the owner's yes (PR #33 from `release-finish` first, then one from `everywhere-finish`). Lanes push only to their own branch (this lane: `everywhere-finish`, fast-forward only) and never open or merge PRs.
