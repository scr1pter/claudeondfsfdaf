# Desktop initial-title evidence

The baseline was recorded before changing desktop session creation, on source
`e8bd513e1e37fe458b6187f82f4df8af4cdd781b`. The manual production benchmark is
[run 40783424228, job 123150544735](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40783424228/job/123150544735).
The job built the production app and ran the existing navigation fixture on
Chromium/Linux, one worker, with three repeats. It used mocked engine/provider
responses and no model keys or paid inference. No browser benchmark ran locally.

`before.json` preserves every emitted BENCHMARK record, including all samples,
repeat indexes, and failures: nine initial results and six retries. Six initial
results contain metrics. All three unvisited-task and all three new-session-page
runs passed, with no blank or unknown samples. First destination observations
were 151.4/156.4/158.5 ms and 157.4/136.7/161.2 ms respectively.

The job failed because the child-session scenario could not find its task-card
link before the existing 60-second deadline. That happened before the title
implementation in every repeat and both retries. Those nine records contain
`metrics: null`; they are failures, not zero-duration or successful measurements.
No timeout, assertion, scenario, or fixture has been relaxed. Repeat this same
workload after the change and retain the same distinction in the comparison.

This navigation benchmark does not measure title-generation cost or prove a
performance advantage. The separate existing offline engine case, `title
generation sends only what the user typed`, passed before the change (one test,
ten assertions). It records two provider requests: one main response and one
title request, with one ancillary-usage row. A client-named-session regression
will check the corresponding path after the change. These are request counts
against a fake provider, not measured live dollars or provider caching.

The failed child selector targeted an obsolete task-card anchor. Current timeline
code renders task parts as `SubagentTaskChip` buttons; Control/Meta-click opens a
single agent's child session. The existing
`e2e/regression/subagent-child-navigation.spec.ts` uses that gesture. The
benchmark-only repair adopts it while preserving the measured navigation,
destination title, blank/unknown assertions, and existing deadlines. The original
failed records remain intact. Record a fresh baseline with this repaired fixture
before applying any desktop-title change, then reuse that fixture for comparison.

The first repaired-fixture run,
[40786746210, job 123161740611](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40786746210/job/123161740611),
was cancelled after a second instrumentation problem was identified. Its child
navigation and destination-title check completed, but the probe still listened
only for anchor clicks, so it never started on the chip button. The failure moved
to the probe's sample wait. `before-chip-cancelled.json` preserves all 12 emitted
records: six measured successes, six child failures, and no emitted child result
for the third repeat. Cancellation and missing results are explicit.

The probe repair adds an optional explicit click selector for that child chip.
Its capture-phase listener starts on the actual button click, preserving click
latency. Other callers retain the matching-anchor behavior. There is no route
fallback, changed deadline, or relaxed navigation/blank assertion. A fresh run
with the repaired instrumentation is required before the desktop-title change.

The fresh baseline at source `05ff5903d02c38564f10130ed20671fa32c2e906`,
[run 40790468497, job 123174150755](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40790468497/job/123174150755),
passed all nine initial results without retries. `before-valid.json` preserves
every raw BENCHMARK record and sample. All three repeats of all three scenarios
had zero blank or unknown samples. First destination observations, in repeat
order, were:

| Scenario | Repeat 1 (ms) | Repeat 2 (ms) | Repeat 3 (ms) |
| --- | ---: | ---: | ---: |
| Unvisited task | 115.7 | 123.8 | 124.9 |
| New session page | 151.0 | 136.4 | 135.3 |
| Child session | 80.2 | 84.3 | 78.9 |

This is the complete production navigation baseline for the initial-title
change. The earlier failed and cancelled runs remain preserved above. The app's
session-creation code was unchanged through this baseline. These fixture timings
are navigation observations on one CI runner, not title-cost or speed savings.

After recording and committing that valid baseline, the desktop composer was
changed to send a first-line title when creating a new work session. It uses
only text parts, with user comments or attachment basenames as fallbacks, and
leaves social-message titles to the engine. This preserves the engine's existing
greeting-first retitling policy. No engine title-generation behavior changed.

The new offline engine case, `a client-named session answers without a separate
title request`, passed (one test, four assertions). It confirms the supplied
title stays, exactly one main-provider request is sent, no title request is
sent, and no ancillary title-usage row exists. The earlier untitled baseline
sent one main request and one title request. Both cases use a fake provider,
not live inference or measured costs. Composer tests also passed (59 tests,
219 assertions), including mention-first input, attachment-only labels, and an
emoji greeting; title-helper tests passed (three tests, seven assertions).
App and engine typechecks passed; the required pre-push check also passed all
23 packages.

The after-change production benchmark at source
`5fd08374f72731e93a4bafbbf249738ff0a5a653`,
[run 40792332930, job 123180412102](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40792332930/job/123180412102),
passed all nine initial results without retries. `after.json` preserves every raw
record and sample. The benchmark workflow, production configuration, fixture,
probe, command, worker count, and three-repeat inputs were unchanged from the
valid before run. Neither run used live providers or a local browser benchmark.

| Scenario | First destination median, before / after (ms) | Stable destination median, before / after (ms) | Blank / unknown samples, before and after |
| --- | ---: | ---: | ---: |
| Unvisited task | 123.8 / 118.1 | 140.3 / 148.7 | 0 / 0 |
| New session page | 136.4 / 158.3 | 230.3 / 234.0 | 0 / 0 |
| Child session | 80.2 / 88.8 | 141.6 / 143.5 | 0 / 0 |

Navigation assertions passed on both revisions. These are three repeats from
one CI job per revision, with mixed timing differences; they do not establish a
latency improvement or a statistically bounded performance change. The fixture
navigates to seeded sessions and the new-session page; it does not submit a
first work prompt. The separate fake-provider regression establishes the title
request-count behavior. Neither measurement proves live token, cost, quality,
or cache-hit savings. These conclusions concern the completed benchmark jobs,
not the status of every other job in their general CI runs. Earlier failed and
cancelled measurement attempts are retained as instrumentation history, not
current product failures.
