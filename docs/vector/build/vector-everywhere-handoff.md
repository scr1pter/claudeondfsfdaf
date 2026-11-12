# Vector everywhere: handoff (2026-11-11)

This build moves to a new agent. Start here, then read the contract (`vector-everywhere-spec.md`) and the deviations log (`vector-everywhere-deviations.md`) in this folder. The deviations log records every reading the build made where the contract was silent or wrong about the code; it wins over the contract where they differ.

## Current continuation status (2026-11-12)

This section supersedes the original handoff status below. The continuation is in isolated worktree `/workspace/vector-build-everywhere`, branch `build-everywhere`, based on `vector-everywhere` at `f9b19a041`. **Reviewed P1c revision `8a6d7b4ef` has been pushed normally to `vector-everywhere`; all nine dedicated jobs, including actual Redis races, passed. General CI found two real failures now repaired locally in `565c03ea8`; fresh hosted confirmation remains owed.** Exact-head runs: [Vector everywhere 43159108255](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43159108255), [test 43159143957](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43159143957), and [typecheck 43159147822](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43159147822). The coordinating agent verified test job `130987536311` and its decoded log: healthy pinned Valkey 7.2.14, actual EVAL races, and passing delivery-admission/claim/slot/lease cases. No main push, PR or platform registration is authorized by this checkpoint.

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
| VE-13 | Native Jira FIT/A2A, user-token context proof, input drafts and indexed erasure, source-only Forge manifest | This package revision; five native files, seven common regressions and API/web types passed; final A2A follow-up19/245 and web types pass; new hosted Lua remains unqualified |

Independent review and re-review closed the five reported P1c findings; the optional-worktree-config compatibility correction was also reviewed without a new blocker. Final local repair receipts: dedupe 8 passed / 36 assertions; jobs 43 / 334; intake 6 / 29; sweep 6 / 34; git 7 / 73; scan 4 / 24; runner 12 / 59. API and desktop typechecks pass. Dedupe skips two real-Redis cases and two setup/teardown hooks locally; jobs skips five real-Redis cases and two hooks. Exact scope and earlier receipts are in `vector-everywhere-progress.md`.

**Current gates and remaining coverage:**

- **Whole-P2 authority repairs are required before push.** Independent review confirms installation deletion must begin with an exact authorized active-to-closing transition; all job/link/map/task/index/account writers must honor closing and current proofs. A late old erase or replayed native control must not target a newer grant. Generic intake must fence the exact person link and account tombstone, and name-only Linear selection must not authorize repository-name reuse. Account audit, OAuth/link-code and readiness metadata also need closing protection. No local Codium tombstone integration exists on this branch; do not infer one. These findings remain source work despite passing component checks.

- All nine dedicated jobs at `8a6d7b4ef` passed. General CI then found the new desktop user-facing “project remote” wording and a Localmode background-process fixture deadlock. The coordinating agent repaired only that wording and the fake concurrency setup in `565c03ea8`; its targeted local checks passed. Fresh general hosted confirmation remains owed. These older-head receipts do not qualify new P2 sources.
- P1c's full dedicated lane qualified. VE-10 GitHub and VE-11 Slack are committed after scoped checks; VE-12 Linear now passes all four focused files, five common regressions and API/web types. It includes current native OAuth refresh pairs, immutable activity/selection proof, atomic native session admission and authorization-bound delivery. VE-13 Jira now passes its scoped local checks; whole-P2 independent review and complete authority repairs precede the coordinator's fresh dedicated/general CI push. New installation/quota, native-resource create/replacement and cooldown races require actual Redis in that fresh lane; the old P1c receipt cannot qualify them. VE-10 persists status ids in sealed job replies but registers no real App port. Linear's public documentation now requires directory submission for outside-workspace distribution; plain delegation human-origin and the private result surface remain explicit gates.
- Component tests do not qualify a real laptop, relay, platform app or Actions workflow. The explicit safe-worktree capability, its physical placement, signing-key handoff and R-M2 offline shell remain unwired/unproven here. R-M3's screened outward Brain audience remains a separate prerequisite; VE-08 proves personal-fact exclusion, not that entire audience contract.
- Dedicated runner cases for every server `stop`/`lost`/404/409 variant, five minutes of failed heartbeat acknowledgements and question rejection are still missing. Existing cases cover user Stop, toggle-off, deadline, interruption recovery and permission rejection. Complete that matrix with the later integration/journey qualification before activating the laptop route.
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
2. **Phase P2, the platform intakes:** VE-10 GitHub, VE-11 Slack, VE-12 Linear, VE-13 Jira (VE-13 starts by re-reading the Atlassian pages). The real OAuth exchanges for Slack and Linear plug into `createAccountApi({exchanges})`. Until they exist, `oauth-finish` answers 501 for those platforms.
3. **Final review** of the whole branch (`a6db1513d..HEAD`), then repair.
4. **Later phases wait,** as the contract says:
   - Phase 3 (VE-20 to VE-22, laptop route): after `codium` merges.
   - Phase 4 (VE-30 to VE-33, Actions fallback and GitHub laptop-first): after `vector-at-mention` merges, plus Codium's A59. VE-30 also adds the Actions settle transition.
   - Phase S (VE-40 to VE-44, surfaces): lands as one piece after the next large merge.
   - VE-50 (go-live): runs with the owner after each platform is registered.

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
- **Unknown fields.** `decodeJobRecord` keeps unknown fields so a write-back doesn't drop them.
- **Secret scan.** `decodeSettle` has no secret scan, because the server sanitizes again in `renderResult`.
- **Codium's ErasePart shape.** The contract's guess was wrong; it is `{id, configured(), requires?, erase(account, context)}`, and `EVERYWHERE_ERASE_PART` follows it. Codium registers it in its own file (R-C9).
- **Native disconnect revocation:** the production Slack factory now opens and revokes only its own sealed bot token before erasure. Custom injected exchange transports own their revocation port; Linear now seals rotating credential pairs and revokes its own refresh grant; Jira remains in its later package scope.

## How CI runs on this branch

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
