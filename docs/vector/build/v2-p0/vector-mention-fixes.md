# vector-mention-fixes: A59-INV-P1 ship commands and B08 thread binding

Branch `vector-mention-fixes`, cut from origin/main `6601d963d`. It covers two Vector v2 leftover P0 items for @vector. Both stay dormant: Ship Desk's capture job runs only with the repository variable `VECTOR_SHIP_DESK`, which stays unset, and every `api/cloud-agents` route answers its fixed 503 while `MODEL_PLANS_ENABLED` or `VECTOR_GITHUB_BRAIN_ENABLED` is off.

Fold these entries into the lane docs (`vector-at-mention-deviations.md`, `codium-track-b-checkpoint.md`) when the lane is next edited.

## 2026-11-21, A59-INV-P1: `vector ship` prints server refusal text in public Actions logs

**The gap.** INV-P1 (spec :370 at `6601d963d`) says the CLI never prints a server error body in Actions. `vector ship ticket` printed `result.reason`, which is the server's `error.message`, and `vector ship capture` printed `ShipError` messages built from the server's body. vectordev.ai's Ship Desk refusals include "Your Vector Codium plan does not include Ship Desk." and "Ship Desk is on hold for this account while its payment is reviewed.", so a capture job's log could show the account's plan or payment state.

**The fix** (`packages/engine/src/cli/cmd/ship.ts` only; return shapes unchanged; `packages/core/src/review/workflow.ts` untouched):

- A pure, exported `refusalLine(fixed, detail, env)`. It returns `fixed` when `env.GITHUB_ACTIONS === "true"` or the detail is empty or blank, and `fixed + " " + detail` otherwise.
- The ticket path prints `refusalLine("Ship Desk: no capture ticket.", result.reason, process.env)`.
- The capture's catch uses `refusalLine("Ship Desk: vectordev.ai refused this capture.", error.message, process.env)` only for a `ShipError` with a `status`, which only `captureApi` sets from vectordev.ai's answer. The capture's own refusals (Windows, no Chrome, a held environment, a storage upload) keep their text.

**What changes for the person.** In Actions, a local ticket reason such as "No run token." is no longer printed; the generated workflow already discards that output. Outside Actions, a server refusal of the capture gains the fixed prefix.

**Tests** (`packages/engine/test/cli/ship.test.ts`, new describe "INV-P1: refusals in GitHub Actions", 3 tests; 14 in the file). A loopback `Bun.serve` on 127.0.0.1:0 plays vectordev.ai: it refuses the ticket with the plan text and the capture's card with the payment-hold text. Both commands run through yargs in this process with `process.stderr.write` spied (UI prints to stderr). Each case sets or deletes `GITHUB_ACTIONS` (CI runners set it), deletes the job variables the capture refuses (`ACTIONS_ID_TOKEN_REQUEST_*`, `VECTOR_CLI_TOKEN`, `RUNNER_TEMP`), and restores the environment and `process.exitCode` in `finally`.

- In Actions: the ticket prints `Ship Desk: no capture ticket.`, the capture prints `Error: Ship Desk: vectordev.ai refused this capture.`, the server was asked for `ticket` then `card`, and neither output matches `/plan|payment|Codium/i`. The capture's fixed-line and request assertions are guarded off win32, where the capture refuses on this computer first; the no-leak assertion runs everywhere.
- Outside Actions: both outputs carry the server's sentence after the fixed line.
- Pure `refusalLine` rows: `GITHUB_ACTIONS` `true`, unset and `false`; an empty, blank and undefined detail.

**Runs** (`cd packages/engine && bun test --timeout 30000 test/cli/ship.test.ts`):

- Red (only `ship.ts` reverted from a saved diff): 11 pass, 3 fail. In Actions the ticket printed `Ship Desk: no capture ticket. Your Vector Codium plan does not include Ship Desk.`; outside Actions the capture printed the bare server sentence; `refusalLine` did not exist.
- Green (the diff re-applied, sha256 matched): 14 pass, 0 fail.
- Mutation 1, `refusalLine` ignores `env`: 2 fail (the Actions case on the plan text, and the pure row). Restored, sha256 matched.
- Mutation 2, the capture's catch prints every message raw: 2 fail (the payment-hold text in both cases). Restored, sha256 matched.
- `cd packages/engine && bun typecheck`: clean.

## 2026-11-21, B08-thread-binding (owner ruling R1, option A)

**The gap.** Deviations BT03 item 6, BT05 item 14, BT06 item 20 and "2026-11-16 brain-transport lane (phase-review findings)" item 2. Mint checked the body's `thread` only against `GithubAgents.THREAD_PATTERN`, and the App's `verifyThread` returns before any thread check for `workflow_dispatch` and `schedule`. The ordinary conversation key (`cloudRunArtifactKey`) is derived from the token's `sub`, `repo`, `gen` and `thr` alone. So a writer who edits the default-branch workflow could mint, from a dispatch or a schedule, a run token for another conversation (issue thread 5, another run's `dispatch-<id>`, a `schedule-<hex>`), ask artifact-key for that thread's key, and read or replace its saved `vector-session-<thread>` artifacts. It stayed harmless while the cloud-agents switches are off, and it was listed as an activation blocker in `docs/vector/owner-actions/vector-mention.md`.

**The ruling.** The owner chose option A on 2026-11-21: keep `schedule-<8 hex of sha256(cron)>` and accept only a well-formed schedule thread from a schedule event. The identity token carries no cron string, so mint cannot recompute the hash, and a writer can already add the same cron line, so a schedule's conversation is shared by whoever controls that cron line. Server only: the route script (`packages/core/src/review/workflow.ts`, VectorScope's directory), `WORKFLOW_VERSION` and `THREAD_PATTERN` are unchanged.

**The fix** (`api/_lib/cloud-agents-api.ts` only):

- A pure, exported `runThreadAllowed(identity, body)`, mirroring the threads the route script gives each event:
  - `schedule`: `/^schedule-[0-9a-f]{8}$/`.
  - `workflow_dispatch`: `dispatch-<identity.runId>`, or, only for a person (not Vector's App bot) dispatching a review, `String(body.pullRequest)`. The App's `verifyRun` already checks that a named pull request is this repository's own.
  - `issue_comment` and `issues`: a number (`/^[1-9]\d{0,9}$/`). With the App, `verifyThread` checks which number.
  - `pull_request_review_comment`: `String(identity.pullRequest)`, the number in the signed `refs/pull/<n>/merge` ref.
  - Any other event: never (mint already refuses them earlier).
- Mint calls it right after the trigger is resolved and refuses with 403 `EVENT_NOT_ALLOWED` ("The conversation does not match this run."). That is before the App's `verifyRun`, the allowance, the rate limits that follow it, the OIDC replay mark and the reservation. It sits after the bot and ticket checks, so a bot without a valid ticket still answers `ACTOR_NOT_ALLOWED`, as the existing cases pin.
- artifact-key refuses a token whose `pur` is `review` with 403 `ARTIFACT_KEY_NOT_ALLOWED`, right after the thread check and before its run limit and live-run read. Review runs never save or restore a conversation, and a person's dispatched review names its pull request's thread, so a review token never needs that conversation's key.

**What changes, and residuals for the lead.**

- No existing route-script thread is refused: dispatch tasks and every App-bot ticket run stay on `dispatch-<run id>`, issue and pull request threads stay the number, dispatched reviews keep the pull request number, and schedules keep their hash. Every existing Valkey case mints its own event's thread (`dispatch-1000` with run id 1000, `17` from a comment, `schedule-0a1b2c3d` from a schedule).
- A ticket run whose trigger purpose is `review` holds a review token on its dispatch thread, so it no longer gets the ordinary key and does not save a conversation. The engine maps the refusal to `not-allowed` and logs that it could not save the conversation for follow-ups; the run itself is unaffected.
- Without the App, an issue or comment run's thread is only checked to be a number, because the comment cannot be read without the App. This is unchanged from before and out of the ruling's scope.
- A schedule's conversation is shared by whoever controls its cron line (the ruling).

**Tests.**

- `packages/web/test/cloud-agents-thread.test.ts` (new, Redis-free, 7 tests; CI runs it in `vector-at-mention.yml` through the `test/cloud-agents-*.test.ts` glob):
  - Pure `runThreadAllowed` rows for every event: a schedule's malformed threads (upper-case hex, 7 and 9 digits); a dispatch asking for issue 5, `dispatch-999`, `dispatch-10000` or a schedule thread; a review dispatch with a matching, a different or no pull request; Vector's App bot with a review-shaped body; issue and comment events asking for dispatch or schedule threads; a review comment asking for another pull request than its signed ref; and `push`, `pull_request`, `pull_request_target` and `workflow_run`.
  - Mint over HTTP through `createCloudAgentsApi`, with a loopback rate-limit store, a binding store answering one binding, and recording fakes for the identity check, the App and the allowance. Ten refused cases answer 403 `EVENT_NOT_ALLOWED` with no App call, no allowance call and no store command after the binding read (so no OIDC mark and no reservation). Six allowed cases, one per event shape, reach the App and the allowance, which answers service-off (503 `MODEL_PLANS_DISABLED`).
  - artifact-key over HTTP: a review token answers 403 `ARTIFACT_KEY_NOT_ALLOWED` after only the IP limit and the token's run check; a task token passes on to its run limit and its live-run read (401 here, since the fixture stores no run).
- `packages/web/test/cloud-agents-mint-api.test.ts`, new case "B08: a run names only its own event's thread, refused before the App and OIDC; a review token gets no conversation key". It needs Valkey, so it runs only in `vector-at-mention.yml`; locally it registers its usual single skip. With the App installed, four dispatch refusals that share one identity token, a schedule asking for `17` and a comment asking for `schedule-0a1b2c3d` all answer `EVENT_NOT_ALLOWED`, make no GitHub request besides the JWKS read, and reserve nothing. The same identity token then mints for `dispatch-1000`, which shows that no refusal consumed its OIDC proof, and that token gets its key. A person's review dispatch for pull request 17 mints a review token, which artifact-key refuses. **Not run locally (no Redis on this computer); its red and green need the CI lane.**

**Runs** (`cd packages/web && bun test --timeout 30000 test/cloud-agents-thread.test.ts`):

- Red (only `cloud-agents-api.ts` reverted from a saved diff): 1 pass, 6 fail. The pure rows found no `runThreadAllowed`. Over HTTP, a dispatch asking for thread 5 reached the App and the allowance (503 `MODEL_PLANS_DISABLED` with `app: 1, entitlement: 1`, where 403 with neither was expected), and a review token passed artifact-key's gate to the live-run read (401 `MODEL_PLAN_RUN_EXPIRED`).
- Green (the diff re-applied, sha256 matched): 7 pass, 0 fail.
- Mutation 1, a dispatch accepts any thread: 2 fail. Mutation 2, artifact-key's review gate removed: 1 fail. Mutation 3, a schedule accepts any thread: 2 fail. Each restored, sha256 matched.
- `cd packages/engine && bun typecheck --project ../../tsconfig.json` (the hosted API): clean. `cd packages/web && bun typecheck`: 0 errors, 0 warnings.
