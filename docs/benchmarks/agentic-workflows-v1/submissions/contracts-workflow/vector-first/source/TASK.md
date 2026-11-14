# Upgrade Workflow Runner without losing existing jobs

You own a small local job dashboard. Its existing v1 implementation is a working serial queue. Upgrade it into a durable workflow runner with real subprocess execution, dependency graphs, bounded concurrency, automatic retries, cancellation and a live browser interface. Preserve its existing completed jobs and legacy HTTP API. This is a maintenance task, not a blank-slate replacement.

Use the supplied pinned dependencies, Bun, SQLite and local browser tooling. No hosted APIs, cloud deployment, external services or extra autonomous agents. You may restructure application code and add tests, but do not change `sql/v1.sql`, `server/worker.ts`, `tests/smoke.test.ts`, the dependency versions, or the lockfile. These are public compatibility/worker fixtures. Do not change evaluator files outside the application. Keep `bun run typecheck`, `bun run build`, `bun test tests`, and `bun run start` working.

## Runtime and migration

- Keep `server/index.ts` as the startup entrypoint, invoked as `bun server/index.ts` (and by `bun run start`). The app starts with `PORT` and `DATA_DIR`; listen on `127.0.0.1`. Its SQLite file is `DATA_DIR/workflow.sqlite`. Tests use a disposable directory, never a real product database.
- `GET /api/health` returns `{ok:true,schemaVersion:2}` after a durable startup migration. Persist `meta['schema_version']='2'` only when migration succeeds.
- Existing v1 `jobs` rows retain their `id`, `name`, `kind`, `status`, `attempt`, `result`, `error`, `created_at`, and `updated_at`. Completed legacy work must never be re-executed during migration/restart.
- Preserve `GET /api/jobs` → `{jobs:[...]}`, `GET /api/jobs/:id` → `{job}`, and `POST /api/jobs {name,kind}` →201 `{job}`. Legacy kinds are `succeed`, `fail`, `fail_once`, `block`. A new legacy single job must still run normally. It may internally become a one-node workflow, but its old response fields remain.
- The global number of live child workers may not exceed `WORKFLOW_CONCURRENCY` (an integer1..3; default2). Each workflow's requested concurrency is an additional bound.
- Production start must serve the browser app. Builds may write only the generated app-root `dist` directory; do not place authored source there. Runtime data stays under configured `DATA_DIR`/`WORKFLOW_MARKER_DIR` outside the authored app.

## Create and inspect workflows

`POST /api/workflows`, with an `Idempotency-Key` header, accepts:

```json
{
  "name": "Publish checks",
  "concurrency": 2,
  "jobs": [
    {
      "key": "lint",
      "name": "Lint",
      "kind": "succeed",
      "dependsOn": [],
      "maxAttempts": 1
    },
    {
      "key": "test",
      "name": "Tests",
      "kind": "fail_once",
      "dependsOn": ["lint"],
      "maxAttempts": 2
    }
  ]
}
```

Names are nonempty trimmed strings of at most120characters. Workflow concurrency1..3; 1..40jobs; job keys match `[A-Za-z][A-Za-z0-9_-]{0,31}` and are unique. Kinds are the four legacy kinds. `maxAttempts` is1..3, default1. `dependsOn` is an array of unique existing keys, defaultempty. Reject cycles, self-dependencies, duplicate keys/dependencies, missing predecessors, malformed JSON and invalid field types with400, without partially creating rows/events. An absent/empty/over128character idempotency key is400.

Return201 `{workflow}` on creation. Repeating the same key and equivalent JSON object contents returns200 `{workflow,replayed:true}` with the same identity, no extra execution/events and no mutation. Object property order does not change request identity; array order remains significant. Reusing a key with different content returns409. Failed validation does not consume a key. Keys/results persist across restart.

`GET /api/workflows` returns `{workflows:[...]}`. `GET /api/workflows/:id` returns `{workflow}`. Unknown IDs return404. A workflow has:

- `id,name,concurrency,status,createdAt,updatedAt,jobs`.
- Status: `queued`, `running`, `succeeded`, `failed`, `cancelled`.
- Each job: `id,key,name,kind,dependsOn,maxAttempts,status,attempts,result,error`.
- Job status: `queued`, `running`, `succeeded`, `failed`, `blocked`, `cancelled`.
- Each attempt: `{number,status,pid,startedAt,finishedAt}`. Attempts start at1 and remain in history. Status is `running`, `succeeded`, `failed`, `interrupted`, or `cancelled`. Running attempts have a real PID and null `finishedAt`; terminal attempts have a timestamp. A completed job's `result` is the worker's trimmed stdout string; failures retain a useful bounded error string. The worker fixture emits JSON on success.

## Actual execution, retries and cancellation

Use actual child processes, not timers that pretend work completed. Spawn the supplied worker with:

```text
<Bun executable> <worker path> --job-id <persisted job.id> --attempt <attempt number> --kind <kind>
```

The worker path is `WORKFLOW_WORKER_PATH`, default `server/worker.ts`. Generated job IDs must match `[A-Za-z0-9_-]{1,100}` so they can be passed to the fixture. Pass `WORKFLOW_MARKER_DIR` (default `DATA_DIR/markers`) and `WORKFLOW_PARENT_PID` equal to the server PID. The independent evaluator supplies its own identical protected worker. The fixture writes actual start/finish evidence and waits on explicit release files for `block`; never create or forge these marker files in application code. The evaluator controls releases. `fail_once` exits5 on attempt1, then succeeds; `fail` always exits5. A blocked fixture exits when its parent disappears.

- Only run a node after every predecessor succeeded. Failed/cancelled/blocked predecessors make downstream nodes `blocked`; independent work may finish.
- Retry a failed attempt while its total attempts are below `maxAttempts`. Keep every failed attempt. After exhaustion the node is failed. No tight infinite retry loops.
- A workflow succeeds only when every node succeeds; it fails after all possible work settles if any node failed/blocked. Dispatch eligible work within3seconds when capacity exists.
- `POST /api/workflows/:id/cancel` →200 `{workflow}`. Terminate/reap its running children; cancel its queued jobs; preserve previously completed results; settle the workflow as cancelled. After the response, no new job from that workflow may start. Repeated cancel of a cancelled workflow returns200 with no new events. Cancel of a succeeded/failed workflow returns409 unchanged. Unknown404. Other workflows remain unaffected.
- On restart, unfinished persisted attempts become `interrupted` with finished timestamps, and eligible interrupted work is retried with a new attempt number. An interrupted attempt does not consume a failure retry allowance: even `maxAttempts:1` can be recovered after a crash. Old attempts stay in history. Execution across a crash is **at least once**, not exactly-once external side effects. Completed work is never rerun. The fixture itself exits when its parent disappears; do not kill unrelated PIDs during recovery.

## Durable events

`GET /api/workflows/:id/events?after=0` returns `{events:[...]}`. Each event has `{seq,type,createdAt}` and may have `jobKey,attempt`. Sequence numbers are strictly increasing within that workflow, persist across restart, and filter strictly greater than `after`. Invalid/noninteger/negative `after` is400; a future cursor returns an empty array. Unknown workflow404.

Required event types are `workflow.created`, `job.started`, `job.succeeded`, `job.failed`, `job.retrying`, `job.interrupted`, `job.cancelled`, `job.blocked`, and terminal `workflow.succeeded`, `workflow.failed`, `workflow.cancelled` when those transitions occur. Never append events for failed validation or idempotent replays. No invented successful transitions. Cross-workflow event history remains isolated.

## Browser contract

Keep a usable responsive dashboard headed **Workflow Runner** and preserve the accessible region **Legacy jobs**, with articles named `Legacy job <name>` showing old and new legacy jobs.

Add a workflow form with labelled **Workflow name**, native **Concurrency** select (values1,2,3), and **Workflow definition** textarea accepting the JSON job array. Its **Create workflow** button submits once and generates a fresh idempotency key. Show invalid-input errors with `role="alert"`.

The accessible region **Workflow list** contains articles named `Workflow <name>` with `data-workflow-id` equal to the real workflow ID. Inside each article, `[data-testid="workflow-status"]` displays the actual status; job names/statuses and attempt history are readable. A failed job has a visible `role="alert"` with its error. Pending/running workflows offer **Cancel workflow <name>**. The button **View events <name>** reveals a region named **Events for <name>** listing actual event types in order. Use inline regions, not nested modal dialogs.

An open page reflects changes made by another client within3seconds, using polling or SSE with real backend data. Do not show a fake live badge. At390px wide the page must not scroll horizontally; contained code/history panels may scroll. Labelled inputs, buttons and selects must be keyboard-operable. Render names/errors as text, never executable HTML. No CDN resources or outside network requests.

## Verify and deliver

Run the preserved smoke test plus tests you add. Exercise real process ordering, concurrency, retry exhaustion, cancellation, restart, migration and idempotency. Use the available local browser tooling to inspect desktop/mobile and actual create/status/cancel/event flows. Preserve failures honestly. Finish with what changed, the exact checks run, and limitations. Independent evaluation includes16API/process groups and8browser groups; quality review is separate. Do not edit tests or fake worker evidence to satisfy the gate.
