# Code review after each task — 21 November 2026

Branch `review-every-change`, based on `main` at `f3d7ac74`. Engine and desktop app only; the website diagram is a
separate change.

## What

A new desktop setting, **Code review after each task** (Settings > General > Verified completion, off by default). With
it on, each task sent from the desktop or web composer that changes files goes to VectorScope, Vector's code review
agent, once Vector is done. The order is fixed:

1. Vector does the task.
2. LLM-as-a-judge checks it, when the judge is on and judges this work. On a FAIL Vector repairs and the judge looks
   again, up to three rounds, exactly as before.
3. VectorScope reviews all uncommitted changes in the repository, as a background local review with its own hidden
   child session. It reports and changes no files.

With the judge off, step 2 does not happen and the review follows the task directly. The review's findings reach Vector
as one quiet note (no turn starts) and stay listed under Pull requests, Local reviews.

## Why

The owner asked for every code change Vector makes to go to the code review agent when a setting is on, and for the
pipeline to run task, then judge, then review when LLM-as-a-judge is also on. Connect's after-run review already does
something similar, but it sits behind `VECTOR_EXPERIMENTAL_CONNECT`, which stays off, and it skips work whose last
judge verdict was FAIL. This feature uses only VectorScope's existing local-review owner.

## Design

- **Per-request field, client setting.** `settings.general.codeReview` is client-local (persisted with `settings.v3`,
  like `llmJudge` and `secondOpinion`), never engine config, because saving engine config disposes instances. The
  composer sends `codeReview: true` on `prompt_async` and `command` only while the setting is on and offered. The engine
  stores it on the durable user message (`SessionV1.User.codeReview`). Without the field nothing changes; older engines
  ignore it.
- **Offered only where it can work.** The row and the field both require the new engine capability
  `codeReviewAfterTask`, global `experimental.vectorscope === true` and `agent.vectorscope.disable !== true`, the same
  condition the Local reviews panel uses. `codeReviewAfterTask` is in the app's `FLAGS`, or `parseCapabilities` would
  drop it.
- **Ordering by construction.** `SessionCodeReview` (`packages/engine/src/session/code-review.ts`) listens on
  `EventV2Bridge` for the current directory. A session becomes a candidate when a user `MessageUpdated` carries
  `codeReview: true` (property reads only). Admission runs only on a root session's busy-to-idle transition seen in this
  process. V1 publishes that idle only after `runSteps` returned, and `judgeGate`, with every repair round, runs inside
  `runSteps` before its break. `eligible` also refuses while the latest judge part after the fence is pending, running
  or was stopped by the user. The listener records `idleAt` and forks admission into the instance scope, so neither the
  idle event nor the prompt's answer waits for it.
- **Pure admission (`SessionCodeReview.eligible`).** Over the history created up to `idleAt`: a root, non-internal,
  unreverted session with no guest input that the spend guard did not stop; the newest real user message carries
  `codeReview: true`; the newest request is not waiting on the user and its last assistant completed without error; the
  fence is the later of the first message of the trailing `codeReview` streak and the newest automatic run's
  `reviewedThrough`; no automatic run is still running; and the build or quick agent changed at least one file after the
  fence. The retry key is `after_<last assistant id>`. This counts every request after the fence (steers during the
  final step, answers to a question, wake turns, plan-approved builds) and never the work before the setting was on.
- **Effectful checks, in order.** Connect's own after-run review off (else Connect reviews it); at least $0.10 of the
  run budget left ($0.50 assumed without one); `ReviewOwner.target` succeeds; the repository's `.vector/review.json` at
  `HEAD` neither turns on the panel nor names a `model`, `triageModel` or `judgeModel` other than the owner's
  `agent.vectorscope.model` (as Connect's model consent); the VectorScope model has a readable price. Then
  `ReviewOwner.start` with `maxCost = min($2, remaining)`, which stays VectorScope's own gate. Every refusal is logged
  and skipped.
- **Result.** A fiber in the instance scope waits for the background job, verifies the run with `decodeLocalRun`, and
  enqueues one TaskNotify note of the new kind `review` (`wake: false`, quiet, metadata `reviewNotification`). The text is
  a `<vector_review_notification>` block with the verdict, the judge's last verdict, the counts and up to 10 findings,
  each tag-neutralized and cut to 300 characters (about 4 KB in all), with guidance to tell the user and change nothing
  unless asked. If the conversation is idle afterwards, admission runs once more to pick up work finished during the
  review.
- **Bounds.** At most one admission per idle, one automatic review running per conversation, one review per finished
  run (the fence), no extra build-model calls, and the judge still at most three rounds.
- **Deviations from the written spec, both behaviour-neutral.** Admission evaluates `eligible` once without the fence
  before paging `ReviewOwner.list`, since the fence can only narrow the result; greetings and plain questions never read
  the review list. The note is written with the conversation's own agent (`session.agent`, falling back to the newest
  user message's), so a plan-approved build's note does not switch the conversation back to Plan.

Not built: automatic fixing of findings (report only; Connect's repair is not available either), V2 sessions, the phone,
`vector run`, the budget-stop continuation and parallel workspaces (they do not send the field).

## Files

- Engine: `session/code-review.ts` (new), `session/prompt.ts` (7 lines beside the `secondOpinion` lines: the two schema
  fields and the two stamps), `task/notify.ts` (note kind `review`), `server/routes/instance/httpapi/server.ts` (node),
  `handlers/experimental.ts` and `groups/experimental.ts` (capability).
- Schema: `packages/schema/src/v1/session.ts` (`User.codeReview`).
- Core: `packages/core/src/review/model-evidence.ts`, `REVIEW_PIPELINE_SOURCES` re-pinned to `baaee94d7de256b2` because
  `prompt.ts` is pinned (no revision bump: what a review finds or posts is unchanged).
- Generated with the repository's generators: `packages/sdk/openapi.json`, `packages/sdk/js/src/gen/types.gen.ts`,
  `packages/sdk/js/src/v2/gen/{sdk,types}.gen.ts` (`packages/client` regenerated with no change).
- App: `context/settings.tsx`, `components/settings-v2/code-review-model.ts` (new), `settings-v2/general.tsx`,
  `settings-v2/settings-registry.ts`, `features/background-tasks/engine-capabilities.ts`, `components/prompt-input.tsx`,
  `components/prompt-input/submit.ts`.

## Tests

Each file ran alone from its package directory through the shared lock, `bun test --timeout 30000 <file>`, with fake
model servers only.

| File | Result |
| --- | --- |
| engine `test/session/code-review.test.ts` (new: admission table, `wants`, prompt and command stamping) | 14 pass |
| engine `test/session/code-review-flow.test.ts` (new: real prompt loop, judge and idle on TestLLMServer) | 7 pass, 1 skip |
| core `test/review/model-evidence.test.ts` (pin) | 30 pass |
| app `src/components/prompt-input/submit.test.ts` (new cases) | 109 pass |
| app `src/components/settings-v2/code-review-model.test.ts` (new) | 3 pass |
| app `src/components/settings-v2/settings-registry.test.ts` (new case) | 22 pass |
| app `src/features/background-tasks/engine-capabilities.test.ts` (new case) | 13 pass |

`bun typecheck` passed in engine, app, core, schema and sdk/js.

The flow file's ordering cases provide `ReviewOwner.Service` through a recording layer (the only stand-in): FAIL then
PASS judge rounds, then idle, then exactly one start keyed `after_<last assistant id>`, and six model requests with none
after the idle; judge off; setting off (no list or start at all); duplicate idle; a follow-up with new edits; work
finished during a running review (reviewed after it ends); `review.json` picking another model or the panel; a run
budget with $0.05 left; Connect's after-run on. Two cases use the real `ReviewOwner.node`:

- "with VectorScope local reviews off ..." (Linux): no child session and no note, the conversation carries on; after
  the owner turns local reviews on, the next task gets one VectorScope run and one quiet note, and no turn starts.
- "VectorScope reviews the changes ..." needs VectorScope's private Git verifier (Linux, a non-root user and the
  distribution's Python 3.12). This host runs tests as root, so it is skipped here and runs on the CI Linux runners;
  run as an unprivileged user here, the verifier reported "the fixed Git verifier runtime is unavailable".

## Mutations

Each key line was reverted or altered, the named test file ran alone, and the file was restored.

| # | Mutation | Test that failed |
| --- | --- | --- |
| E1 | `eligible` ignores `codeReview` on the newest real user message | code-review: off by default |
| E2 | the pending, running or user-stopped judge refusal removed | code-review: waits for the judge's last round |
| E3 | edits counted from the last request only | code-review: a steer typed during the final step |
| E4 | the waiting-on-a-question refusal removed | code-review: a task that ends by offering more |
| E5 | the durable fence (`previous.reviewedThrough`) ignored | code-review: each review covers only what changed |
| E6 | the `time.created <= idleAt` filter removed | code-review: a prompt stored after the idle |
| E7 | the running-review refusal removed | code-review: never reviews the same finished work twice |
| E8 | the build/quick agent filter removed | code-review: plan mode is reviewed only once approved and built |
| E10 | the streak floor replaced by the first user message | code-review: refuses everything else |
| E11 | `wants` ignores `codeReview` | code-review: `wants` watches only a stamped user message |
| E12a | the `createUserMessage` stamp in prompt.ts removed | code-review: stored on the durable user message |
| E12b | the command-path stamp in prompt.ts removed | code-review: stored by the command path |
| E13 | the retry key taken from `ledgerRequestID` | code-review: an upgraded chat request is keyed on its own last message |
| E14 | the guest refusal removed | code-review: refuses everything else |
| F1 | admission at the first finished assistant instead of the idle | flow: the review starts only after the judge's last round |
| F2 | the note sent with `wake: true` | flow: the review starts only after the judge's last round (a seventh model request) |
| F3 | every prompt stamped | flow: with the setting off nothing happens |
| F3b | no prompt stamped | flow: with the judge off, the review follows the task |
| F4 | the durable fence ignored | flow: a finished run is reviewed once (duplicate idle) |
| F5 | no recheck when a review ends | flow: work done during a review waits for it |
| F6 | the repository model and panel rule removed | flow: review.json picking another model or the panel |
| F7 | the $0.10 budget floor removed | flow: less than $0.10 left starts nothing |
| F8 | the Connect after-run check removed | flow: Connect's after-run review covers the run |
| F9 | no admission on idle (real `ReviewOwner.node`) | flow: turning local reviews on reviews the next task |
| F10 | the cost cap ignores the run budget | flow: budget case (`maxCost` 1 expected) |
| A1 | the composer ignores the accessor | submit: the composer sends it only while it is on |
| A2 | `sendFollowupDraft` drops the draft's choice | submit: sends code review only while it is on |
| A3 | the draft does not store it | submit: the composer sends it only while it is on |
| A4 | the composer's custom command drops it | submit: custom command only while it is on |
| A5 | the queued command path drops it | submit: a queued draft keeps the choice |
| A6 | `codeReviewAfterTask` missing from `FLAGS` | engine-capabilities: reads it as on only for true |
| A7 | offered without the engine capability | code-review-model: offered only with the capability |
| A8 | on by default | code-review-model: off by default |
| A9 | the General keywords removed | settings-registry: finds it under General |

All 34 failed as expected and every file was restored afterwards. One redundancy found: removing the `last.error`
refusal alone is not caught, because `SessionTaskSize.waiting` already refuses a request whose last assistant has an
error; the user-stop row of the refusal table covers the combined behaviour.

`test/server/httpapi-experimental.test.ts` also asserts `codeReviewAfterTask: true` on the capabilities route (9 pass).

## How to turn it on

1. Turn on VectorScope local reviews (global config `experimental.vectorscope: true`) and set a VectorScope model
   (`agent.vectorscope.model`), or a global default model.
2. In the desktop app, Settings > General > Verified completion, turn on **Code review after each task**. Turn on
   LLM-as-a-judge as well to have the judge check first.
3. Send a task that changes files. When Vector (and the judge) are done, the review appears under Pull requests, Local
   reviews, and Vector reads its findings with your next message.
