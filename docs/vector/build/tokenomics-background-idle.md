# Background idle candidate

Prepared November 2, 2026 (Pacific), from product revision
`479303cf229badc0fa2c770f27d7d845dfa4fa68`. This is a separate, unverified
candidate. The running heavy benchmark's product, instrument and app files were
not edited. No Bun test, provider call or paid retest has run for this candidate.

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
   it must not stop a handed-off child or launch any model. Actual before/after
   cancellation tests remain required; the missing source check alone does not
   establish an observed user-facing failure.
3. Background TaskTool result wording clarifies that ending the current response
   can pause inference while the engine remains running and completion later
   resumes the parent unless stopped. It keeps independent work, verification and
   user-requested status/correction available. It promises no recovery after a
   crash and does not change the notification, stop or permission mechanisms.

The nested-activity risk was not observed as a live benchmark failure: that run
used JSON mode, had already completed several leaf steps and kept the lead busy.
The new subprocess controls are intended to establish the actual regression
before this candidate is accepted.

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

After the live run releases the sole Bun workload slot, validate from
`packages/engine`:

```sh
bun test test/cli/run/ancestry.test.ts test/cli/run/background-activity.test.ts test/cli/run/background-wait.test.ts test/tool/task-manage-abort.test.ts test/tool/task-manage.test.ts test/tool/task-manage-schema.test.ts
bun run typecheck
```

Existing background completion, disconnection, inactivity and stop subprocess
controls should also run. No test is marked passed here. A separately frozen
paid pair, unchanged full functional checks and blinded per-task quality review
are required before any cost-saving claim or default rollout.
