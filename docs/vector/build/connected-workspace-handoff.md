# Connected workspace: handoff (2026-11-11)

This build moves to a new agent. Start here, then read the contract (`connected-workspace-spec.md`) and the deviations log (`connected-workspace-deviations.md`) in this folder. The deviations log records every reading the build made where the contract was silent; it wins over the contract where they differ.

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
