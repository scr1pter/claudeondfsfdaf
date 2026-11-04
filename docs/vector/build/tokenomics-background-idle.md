# Background idle candidate

Prepared November 2, 2026 (Pacific), from product revision
`479303cf229badc0fa2c770f27d7d845dfa4fa68`. This separate candidate passed the
controlled regressions and typecheck recorded below; cost savings remain
unproven. The heavy benchmark's product, instrument and app files were not edited.
No real provider call or paid retest has run for this candidate.

## Trace observation and limits

A bounded implementation-phase sample from the first heavy Vector run contained
four standalone `task_manage wait` turns that each reached the requested 60,000ms
timeout. Observed durations were 60,051 / 60,035 / 60,041 / 60,028ms. Their native
self-cost reports sum to **$0.0298516**. A fifth wait returned normally after
5,859ms and reported $0.0146164; that completed wait is not a timeout or waste.

These values are not independently meter-reconciled and are not demonstrated
recoverable savings. They represent model turns that generated wait calls, not a
charge for elapsed waiting time. Useful integration, type checking and coordination
occurred between waits. Removing every such turn would be an unjustified quality
cut. No Codex outcome or overall delivery-cost comparison is inferred from this
early sample.

A later live cut contained 15 standalone wait messages: 12 completed timeouts,
two genuine early completions (5,859 / 7,791ms), and one still running. Native
self-cost was $0.1433291 for the 12 timeout-producing turns and $0.1699783 for
all 14 completed waits. The same unreconciled-upper-bound caveat applies. This
is still a partial run, not a final wait inventory or a net saving. The observed
lead also sent nine standalone coordination messages, wrote seven patches and
performed substantial read, shell, terminal and verification work.

The public and runtime TaskManage schemas and `TaskManager.wait` cap waits at
60,000ms. That encourages periodic inference when a worker takes several minutes,
but an existing alternative already avoids idle inference: the headless CLI stays
subscribed while background work is running or its completion note is unanswered,
and TaskTool starts a follow-up on completion. Ordinary user input arriving while
the parent is idle can start a run immediately. During a busy wait, however, legacy
prompt admission joins the current runner; TaskManager.wait has no pending-user
input wake. Merely lengthening its timeout could therefore reduce responsiveness.
This candidate retains the existing timeout limit and delivery semantics.

## Changes prepared

1. CLI activity now resolves ownership through the same ancestry check already
   used for descendant output and permissions. Previously an unknown grandchild
   joined the activity tree only after a JSON-mode completed step, a research
   progress event or a permission request. An active first step, or ordinary plain
   output with automatic permissions, could remain undiscovered. The shared check
   recognizes the first nested event, caches immutable parent links with a bounded
   negative cache, retains the existing traversal bound and ignores unrelated
   sessions. SDK lookups have a finite five-second abort deadline. Output rendering
   and permission decisions continue using the same ownership scope.
2. TaskManage's wait branch explicitly observes the supplied AbortSignal through
   the existing core `waitForAbort` helper, including an already-aborted precheck.
   The promise bridge otherwise starts an independent Effect runtime, while this
   tool did not inspect its context signal. Cancellation ends the wait subscriber;
   it must not stop a handed-off child or launch any model. The controlled
   before/after cancellation tests below reproduce the missing signal handling;
   this was not diagnosed from source inspection alone.
3. Background TaskTool result wording clarifies that ending the current response
   can pause inference while the engine remains running and completion later
   resumes the parent unless stopped. It keeps independent work, verification and
   user-requested status/correction available. It promises no recovery after a
   crash and does not change the notification, stop or permission mechanisms.

The nested-activity risk was not observed as a live benchmark failure: that run
used JSON mode, had already completed several leaf steps and kept the lead busy.
The new subprocess controls reproduce the defect independently in both output
formats before the fix and preserve completion after it.

## Cache and quality gate

Legacy pruning runs at the start of a non-resume drain, but already skips warm
cache history until `ProviderTransform.cacheLifetime(model)` expires. A short
idle/resume does not automatically prune the prefix. A sufficiently long pause
can still expire cache that repeated calls would keep warm. A future comparison
must retain cache-write, cache-read, ordinary-input and output costs, all task
results and all failed attempts. Fewer calls alone do not prove a lower bill.
No pruning, model, effort, image, verification or spend-cap setting changes here.

Prepared controls cover first-step nested activity in plain and JSON subprocess
output without permission prompts; unrelated/missing/cyclic/deep ancestry and
bounded caching; actual promise-bridge pre-abort, mid-wait abort and normal
completion; and continued child work after cancelling only its wait. They use a
local scripted provider and synthetic jobs, not paid inference.

## Local validation, 2026-11-02

Runtime source under test was `36f7851`, based on frozen baseline
`479303cf229badc0fa2c770f27d7d845dfa4fa68`. Validation used Windows and Bun 1.3.14
after the paid workload released its exclusive Bun slot. Only local scripted
provider responses and synthetic jobs were used; there were no paid API calls.

The first executions exposed test setup errors: the CLI fixture is an object
whose subprocess entry point is `cliIt.concurrent`, and directly initializing a
tool requires its real Session/Agent/Truncate services to be exported by the test
layer. These test-only wiring errors were corrected without changing runtime
source. They are not counted as product regressions or successful checks.

For the before control, only the candidate worktree's `run.ts` and
`task-manage.ts` were temporarily replaced with baseline contents. A `finally`
block restored the original bytes, and both SHA-256 hashes were checked after
restoration. The frozen baseline, canonical worktree, benchmark application and
benchmark instrumentation were never modified.

| Check | Before | After |
| --- | --- | --- |
| First nested long tool step, plain output, automatic permissions | Exit 1: one-second background inactivity deadline despite leaf progress | Exit 0, verified completion, exactly seven scripted requests |
| Same nested step, JSON output | Same inactivity shutdown | Exit 0, verified completion, exactly seven scripted requests |
| Already-aborted wait through actual EffectBridge promise | Did not settle within the two-second guard | Settles with abort cause before task selection |
| Abort after real TaskManager wait admission | Did not settle within the two-second guard | Settles with abort cause; child remains running and subsequently completes |
| Normal job completion through same bridge | Passed | Passed |

Baseline behavioral probe: **1 pass, 4 fail**, exit 1. Candidate consolidated
suite: **30 pass, 0 fail, 374 assertions**, exit 0, 20.52 seconds. This includes all
11 new tests and existing TaskManage, schema and background-wait controls.
Commands run from `packages/engine`:

```sh
bun test test/cli/run/ancestry.test.ts test/cli/run/background-activity.test.ts test/cli/run/background-wait.test.ts test/tool/task-manage-abort.test.ts test/tool/task-manage.test.ts test/tool/task-manage-schema.test.ts --timeout 30000
bun test test/cli/run/run-process.test.ts --test-name-pattern 'waits for a background subagent|waits for the turn that answers a report|stops waiting on a background subagent|SIGINT interrupts|counts a default background subagent|reports a foreground subagent' --timeout 30000
bun run typecheck
```

The six selected real CLI subprocess controls also passed: **6 pass, 0 fail,
18 assertions**, exit 0, 37.92 seconds. They retain foreground/background JSON
spend inclusion, idle completion auto-resume, unread completion reports, genuine
inactivity shutdown, and SIGINT cleanup. The background-wait suite covers ended
streams with unfinished parent/child work being classified as disconnects rather
than successful completion. Engine `bun run typecheck` passed with exit 0.

The source was restored before every after check. There are **36 passing tests
and 392 assertions** in the final selected checks. A separately frozen paid pair,
unchanged full functional checks and blinded per-task quality review are still
required before any cost-saving claim or default rollout. These local results
prove lifecycle/cancellation regressions and preserved controls, not savings or
superior generated-code quality.
