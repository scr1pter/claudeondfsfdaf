# erase-gap-fixes: EV-23 and OPS-WORKER-ERASE-GAP

Branch `erase-gap-fixes`, cut from origin/main `b87cc462f`. It covers two Vector v2 leftover P0 privacy items (P5, E13): data that outlived an erase. Both features stay dormant: `VECTOR_EVERYWHERE_ENABLED` stays off, and the ops Worker is not deployed.

The lane deviations and spec files are in the open v2-closeout-ci PR, so the dated entries live here. Fold them back once that PR merges: the spec §3.13 row for `endedjobs`, the EV-23 pointer in `vector-everywhere-deviations.md`, the "Review note (21 Nov 2026)" in `codium-deviations.md` and the deletion paragraph in `owner-actions/hosted-ops.md`. The `MODEL-PLANS.md:141` list of ops records goes in after branch `hosted-download-billing` merges.

Files: `api/_lib/everywhere/{keys,jobs,erase}.ts`, `packages/web/test/lib/everywhere-store.ts`, `packages/web/test/everywhere-jobs.test.ts`, `api/_lib/ops-{accounts,worker,cleanup}.ts`, `test/account-delete.test.ts`, `test/on-call.test.ts`, `docs/vector/build/codium-a46-ops-worker-notes.md` and this file.

## 2026-11-21, EV-23 sealed summaries on installation erase

**The gap.** `eraseInstallationJobs` walked only `livejobs:<installation>`. A terminal transition removes the job from that set, so a settled job's sealed summary (`summaryEnc`) stayed in its record for the record's 30 days after the installation was erased.

**New key.** `everywhereKeys.installationEnded(installation)` is `vector:everywhere:endedjobs:<installation>`. It is a sorted set of jid to end time, holds jids only, and is kept `KEEP_MS.job` (30 days) from the newest end.

**The fix.**

- `TRANSITION_SCRIPT` takes an optional 7th key, the ended set (`zset` in `luaKeyTypes`), and a 10th argument, `KEEP_MS.job`. When a job enters a terminal state (ARGV[9] is not empty), the script ZADDs it at that time, ZREMRANGEBYSCOREs the entries that ended more than ARGV[10] before it, and PEXPIREs the set by ARGV[10]. The step is guarded by `KEYS[7] and`, so a five-key call (the stale-version test) still runs. The docblock now names keys 6 and 7 and arguments 9 and 10.
- `change()` passes the 7th key and the 10th argument in both the `authorizedScript` and the `runScript` branch.
- `eraseInstallationJobs`, after the live loop, ZRANGEs the ended set and reads each job. It deletes a record it cannot decode (and its `jobs:due` entry), as the live loop does. For each of the installation's jobs that still has `summaryEnc`, it calls `clearSummary`. Then it deletes both the live set and the ended set. The record itself stays for the sponsor's job list.
- `clearSummary` on an ended job sends an empty ARGV[9], so it neither records the job again nor extends the set.
- The FakeStore's `transition` mirrors the script step for step, with the 7th key optional, so v2-closeout-ci's tests on the same FakeStore keep passing after its rebase.
- Header comments: `jobs.ts` (the indexes paragraph and `eraseInstallationJobs`), and `erase.ts` (the module header and `JobEraser`).
- Unchanged: B7e (`everywhere-body-api.test.ts:882`). The links of an ended job are still left to account erase and to their TTL, so the ended-set loop clears summaries only.

**Tests** (`packages/web/test/everywhere-jobs.test.ts`, with the helper `settledWith` at :137, which runs offer, claim, report and settle):

- :1398, "erasing an installation clears the sealed summary of its ended jobs; another installation's stays". It settles a SLACK and a SLACK_OTHER job with summaries and erases SLACK. The SLACK record is still `settled` but has no `summaryEnc`, and `openSummary` is undefined. The ended-set key is gone. SLACK_OTHER's summary still opens, and its ended set holds only its jid.
- :1419, "an installation's ended jobs are recorded once, for 30 days from their end". It checks the score is the end time, the TTL is `KEEP_MS.job`, `clearSummary` adds nothing and does not extend the TTL, and a job that ends 31 days after the first drops it.
- :1694, the same erase assertions in the real-Redis block, together with the ended set's TTL on Redis. It runs in `vector-everywhere.yml` against Valkey and skips locally.

**Evidence** (each file run alone with `--timeout 30000`):

- Red-before, at the test-first commit and again with only `jobs.ts` and `erase.ts` reverted in the working tree: 52 pass, 11 skip, 2 fail. At :1410 `summaryEnc` was still a sealed `ves1.…` string after the erase. At :1424 the ended-set score was `null`. The restored files' sha256 matched.
- Green: 54 pass, 11 skip, 0 fail.
- Mutation M1 removed the ZADD into KEYS[7] from both the script and the FakeStore: :1398 and :1419 went red. Mutation M2 dropped the `clearSummary` call: :1398 went red. Each file was restored and its sha256 compared equal.
- Regressions, green: `everywhere-erase.test.ts` (read-only, 11/11), `everywhere-body-api` 24 pass and 5 skip, `everywhere-github` 17, `everywhere-cloud-adapter` 84 pass and 3 skip, `everywhere-jobs-api` 22, the three `everywhere-journey-*` files, `everywhere-account-adapter`, `everywhere-jira-render`, `everywhere-jira-a2a` and `everywhere-keys`.
- Typecheck: `bun typecheck --project ../../tsconfig.json` from packages/engine (the api) and `bun typecheck` in packages/web each reported 0 errors.
- **Not run here.** The real-Redis case needs Valkey. The test-first commit ("test(everywhere): EV-23 …") comes before the fix, so pushing it first shows that case red in `vector-everywhere.yml`. Only CI's real-Redis case catches a change to the Lua alone.

## 2026-11-21, OPS Worker erase owed after the cleanup drop

**The gap.** `ops:accounts` is the cleanup's work list. `cleanAccount` drops an account from it when nothing is left to expire and no plan gives the Worker work, while the Worker may still hold the account's config, releases and baselines. With `VECTOR_OPS_WORKER_URL` unset, `usedOps` read only that list, so the account's deletion finished with 200 and no Worker erase.

**The fix** (option 1 of the lead call: a separate record, so the cleanup's walk and `ops-payment-pipeline.test.ts:307` and :321 are unchanged):

- `ops-accounts.ts` adds `opsWorkerAccountsKey(mode?)`, which is `ops:worker`, a sorted set of account to first call. `forgetOpsAccount` also ZREMs it in both Stripe modes. The header now says `ops:accounts` is not a record of every account that used ops, and describes `ops:worker`.
- `opsCall` (`ops-worker.ts`) runs `ZADD ops:worker NX <now> <account>` before the signed fetch, for `plan`, `config`, `release` and `suspend` only. A store failure throws `OPS_UNAVAILABLE` and the Worker is not called (fail closed).
- `ops-cleanup.ts` renames `usedOps` to `owesWorkerErase`. It checks `ops:accounts` and `ops:worker` in both modes. The "not covered" sentence is gone, and the module header says the Worker's record stays after the cleanup's drop. The cleanup never touches `ops:worker`.
- Cost: each of those Worker calls makes one more store write, and a store failure now refuses the call. Accounts dropped before this change have no record. None exist, because the Worker is not deployed.

**Tests.**

- `test/account-delete.test.ts` :1564, "without the Worker's address, an account the daily cleanup dropped from the ops list still waits for the Worker's erase". A real `opsCall("plan", …)` goes through the fake Worker, and `cleanupOps` then answers `dropped: 1`. With `VECTOR_OPS_WORKER_URL` unset, `deleteRoute` answers 503 `ACCOUNT_ERASE_PENDING` at stage `erase`, with failed `["ops", "codium", "keys"]`, no `/erase` call and no identity deleted. With the address back, the cron's retry makes one `/erase` call, deletes the identity, and leaves both `ops:worker` sets empty.
- `test/account-delete.test.ts` :1600, "a Worker call whose record the store cannot take is refused before it reaches the Worker". With the store down, `opsCall("plan")` rejects with 503 `OPS_UNAVAILABLE` and the Worker hears nothing. Once the store is up the call goes through, and NX keeps the first call's time.
- `test/on-call.test.ts` :835. This file is outside the plan's list, and no open PR touches it. Its case "account deletion erases the settings and their index entries in both modes (P5)" called only `eraseAccountOpsSettings`, then required that no `:ops:` key be left. The config calls now write `ops:worker`, which by design outlives the settings until `forgetOpsAccount`. The case now asserts exactly `[ops:worker]` holding only that account, then runs `forgetOpsAccount` and keeps the original assertion that no `:ops:` key is left. No assertion was loosened.

**Evidence** (each file run alone with `--timeout 30000`):

- Red-before, at the test-first commit: :1564 answered 200 where 503 was expected (44 pass, 1 skip, 1 fail). With only `ops-worker.ts`, `ops-cleanup.ts` and `ops-accounts.ts` reverted in the working tree: :1564 and :1600 failed, and so did on-call :835. The restored files' sha256 matched.
- Green: account-delete 46 pass and 1 skip, on-call 30 pass and 1 skip.
- Mutation M3 removed the ZADD in `opsCall`: :1564 answered 200 and went red. M4 had `owesWorkerErase` read only `ops:accounts`: 200, red. M5 had `forgetOpsAccount` keep `ops:worker`: the final empty-set check went red. M6 swallowed the store failure: :1600 went red. Each file was restored and its sha256 compared equal.
- The plan's fixture-risk files passed with no fixture change: `account-delete-api` 8, `ops-payment-pipeline` 10, `ops-worker-contract` 9, `release-guard` 36 pass and 1 skip, and `packages/web` `desktop-account` 12.
- Also green: `ops-guard`, `ops-screens`, `ops-domain-health`, `codium-outbox`, `github-webhook`, `api-module-loading`, `ship-desk`, `codium-founding`, `hosted-lifecycle`, `hosted-jobs`, `hosted-internal`, `web-push`, `brain-vault-api` and `remote-ticket-api`; in packages/web, `codium-configuration`, `codium-public` and `cloud-agents-entitlement-contract`.
- Typecheck: the api reported 0 errors.
