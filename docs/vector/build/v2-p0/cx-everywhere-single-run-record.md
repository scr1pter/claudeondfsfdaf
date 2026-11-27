# everywhere-single-run-record takeover: the cron reads one exact run record (#114)

Branch `everywhere-single-run-record` (PR #114), finished from the local branch `cx-everywhere-single-run-record`. The draft had been idle for more than a day, so this v2 run took it over to land in main before the v2 redesign starts. No feature flag changes: the cron's run read still does nothing while the cloud-agents service is off (C2, C5), and Vector everywhere stays behind `VECTOR_EVERYWHERE_ENABLED`. No public claims.

## 2026-11-26, overdue Actions runs settled from the sponsor's newest 200 runs

**Bug.** The sweep's reader of how an overdue Actions run ended (`createActionsRunEnd`, api `_lib/everywhere/adapters/cloud-agents.ts`) called `listCloudRuns(account, { limit: 200 })` and searched the result for the job's run. That had two faults, both recorded as Left open in the EV-30 entry of `docs/vector/build/vector-everywhere-deviations.md` ("(i) The overdue rule", rows C1 and C6):

- A settled run that the sponsor's history index no longer lists (older than the newest 200, or dropped from the index) answered "unknown", so the cron failed a job whose run had in fact finished.
- `listCloudRuns` refuses the whole page when any one of the 200 records is damaged, so one bad neighbouring record made every overdue job of that sponsor wait out the grace period and then fail.

**Fix.** Codex's commit `f54a205d` (kept as is): a new `readCloudRunOutcome(account, rid, store)` in api `_lib/cloud-agents-runs.ts` reads only the protected run record of that one run (the same `RECORD` script `ownerCloudRun` uses). It answers the decoded outcome when the record belongs to the sponsor, undefined for an open, missing or other account's run, and for a run id Cloud Agents could not have issued (no read at all). A record that does not decode, or one whose `rid` is not the key's, rejects with 503, so the cron's existing grace still applies (C7). It never reads the history index, the actor key or a body. `createActionsRunEnd` uses it in place of `listCloudRuns`. This supersedes the deviations entry's statement that the cron reads the newest 200 runs, and closes its damaged-neighbour Left open item.

**Takeover additions.** Merged origin/main (no conflicts). Added to C1 the case the PR body claims but no test pinned: a settled run whose history index lists nothing still answers its outcome, with only the one `EVAL` read. Updated the VE-30b test header, which still named `listCloudRuns`.

**Tests.** web `test/everywhere-cloud-adapter.test.ts`, describe "the cron's run read (VE-30b)": C1 (outcomes, the other-account and unknown cases, a down store, a damaged record, a hash under the wrong key, the unlisted run, and exactly one record read per query), C2 and C3 (the reads the default gate and the cron make), C4 (open and missing runs fail at the deadline), C6 (the cron settles the exact run despite a damaged neighbour), C7 (a damaged or unavailable exact record gets the full grace). The file passes: 88 pass, 3 skip. The skips are the real Redis and Valkey cases, which run in CI ("Hosted tests" and "Vector everywhere tests"). `test/everywhere-sweep.test.ts` (11 pass), `test/cloud-agents-runs.test.ts` (2 pass, 1 Redis skip) and `test/everywhere-journey-actions.test.ts` (11 pass, 2 Redis skips) also pass. The api typecheck (root tsconfig) and web `bun typecheck` pass.

**Red before.** With `api/_lib/cloud-agents-runs.ts` and `api/_lib/everywhere/adapters/cloud-agents.ts` restored to origin/main, the file fails C1, C2, C3 and C6 (84 pass, 4 fail); restored to the fix, 88 pass.

**Mutation check.** With `readCloudRunOutcome` returning the outcome of any account's record (the `record.account === account` check dropped), C1 fails (87 pass, 1 fail); restored, it passes.

**CI note.** The draft's only failing checks were two Windows engine shards (2/18: a 60 s timeout in "task isolation saves"; 5/18: "a key bound before the member gate refused keeps the refused run"). Both are engine tests this PR does not touch (it changes only api and web files); CI reruns them on the branch with main merged.
