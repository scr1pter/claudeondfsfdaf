# cx-reclaim-dead-bindings: reclaim open directory-review bindings whose job lease is provably dead (#163)

Branch `reclaim-dead-bindings` (PR #163). Codex opened it as a draft and left it idle for more than a day, so this v2 run took it over on 2026-11-26 to finish it before the Saturday deadline. The work branch is `cx-reclaim-dead-bindings`. Directory reviews run only behind `VECTOR_EXPERIMENTAL_CONNECT`, which stays off. No flags change and nothing is claimed publicly.

## 2026-11-26, open directory-review bindings were never pruned

**Bug.** The connected-workspace deviations log names the known limit "Open bindings are never pruned". If a directory review is still running when the app quits or the engine restarts, its request binding keeps an open receipt, and no retention rule removes it. Each one counts against its folder's 4,096-key cap and the global ledger cap for good. A folder that gathers enough of them refuses every new review permanently.

**Fix (Codex's commits `079b847e`, `c07cdd04`, `7f7f249f`).**
- `ConnectDirectory.settled` (engine `connect/directory.ts`) now returns the receipt's scope fields for an open run. It does this only when the run is a background VectorScope review that the user requested in this folder. Any other open receipt reads as `unknown`.
- `ConnectDirectoryRequest.prune` (engine `connect/directory-request.ts`) takes an optional `InspectOpen` callback. It asks about an open binding only when the binding's reservation is past the existing age floor and its receipt matches the binding's scope digest. All inspections in one sweep share a single `INSPECT_MS` window. A timeout or error counts as "keep". Replays never prune, as before.
- `ConnectOwner` (engine `connect/owner.ts`) supplies `inspectOpen`. It loads the exact durable job with the new `BackgroundJobStore.forJob(id, parentSessionID)`. The binding is reclaimed only when all of these match: job type, background, no attempt, directory, run ID, member, action, request key, scope digest and input digest. The status must be `running` or `interrupted`, and `BackgroundJobStore.deadModernLease(owner)` must be true.
- `deadModernLease` (core `background-job-store.ts`) is positive proof of death. For a lease from this process, the lease must be closed. For any other process, the machine ID file must exist and match without being created or replaced, the boot must match, and a fresh `kill(pid, 0)` must report the process gone. The fresh probe means a recycled PID cannot inherit a cached death result. A stale heartbeat, a foreign machine, a legacy runtime or a missing machine file proves nothing.
- A pruned binding keeps its receipt, job row and anchor session for diagnosis. The journal removes only the request ledger's records.

**Lead ruling.** The deviations log's follow-up also suggested treating a binding as settled when its job row is already settled. This branch keeps the narrower rule: only a provably dead lease on a `running` or `interrupted` row, with every digest matching, frees the key. A missing job, an uncertain or live lease, or a `cancelled`/`completed` row with an open receipt keeps the binding. Pruning a key wrongly would let a replay of the same request key start a second review, and keeping a binding only costs one key of capacity. So this is the safest option that closes the limit for the interrupted-run case the log describes.

**Tests.**
- engine `test/connect/directory.test.ts`, "retention prunes only old open directory bindings with the exact dead job lease". A real owner `directoryReview` admission drives the sweep, and no model starts. It prunes the old running and interrupted bindings whose lease is closed. It keeps these: a foreign lease with a stale heartbeat, live leases (running and cancelled), a foreign machine, a legacy runtime, a mismatched input digest, a completed row, a young binding, and a binding with no job. The pruned reviews' receipts, jobs and anchor sessions are still readable.
- engine `test/connect/directory-request.test.ts`, "an open binding is inspected only after the existing age floor and never by a replay". This also covers legacy index entries that have no age hint.
- core `test/background-job-store.test.ts`, "modern lease death can read an existing machine identity without creating a missing one" and "a fresh modern lease never inherits a cached death from a recycled pid".

**Red before the fix.** Revert `background-job-store.ts`, `directory-request.ts` and `directory.ts` to `origin/main`, and `owner.ts` to `ee19d0d1` (the #162 base without these commits). The engine retention case then fails at the pruned-binding assertion: the binding file still exists (expected `true`, received `false`). With the sources restored, it passes.

**Mutation check.** Replace `BackgroundJobStore.deadModernLease(row.owner)` in `owner.ts` with `true`. The retention case fails, because live-lease bindings are pruned too. Restored, it passes.

**Takeover integration.**
- `origin/main` merged cleanly. `origin/polish-connected-reviews` (the #162 head `f897d970`) also merged cleanly. It carries the clean-Git native owner smoke fixture that the `desktop engine bundle (node)` job needs. That job had failed on this PR's previous head because the old fixture expected a consent prompt from a non-Git folder.
- Every other job in the PR's previous CI run was cancelled, not failed.
- This PR stacks on #128 (through `8d81da3b`) and #162. It merges after both: then merge `origin/main` again, and the remaining diff is the eight reclaim files plus this note.

**Local verification (one file at a time).**
- core `background-job-store.test.ts`: 19 pass.
- engine `connect/directory-request.test.ts`: 27 pass.
- engine `connect/directory.test.ts`: 25 pass.
- engine `connect/owner.test.ts`: 8 pass.
- engine `connect/background.test.ts`: 12 pass, 4 skipped. The skipped cases are Linux only and run in the `engine (linux)` CI shards.
- engine `connect/node-smoke-fixture.test.ts`: 3 pass.
- Core and Engine typechecks pass.
