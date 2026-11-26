# everywhere-publication-ack: proof of publication settlement (PR #118)

Branch `everywhere-publication-ack` (PR #118), opened by Codex on 2026-11-24 and taken over by this v2 run on 2026-11-26 after it sat idle for more than a day. It closes the "Finding left open (server and runner, not built): a publication result after a stop or cancel" in `vector-everywhere-deviations.md` (EV-03). The feature stays dormant: `OFFER_KEYS` is empty and `VECTOR_EVERYWHERE_ENABLED` stays off.

Files: `packages/desktop/src/main/everywhere-runner.ts`, `everywhere-ledger.ts`, `everywhere-wiring.ts` and the runner and ledger tests; `packages/schema/src/everywhere.ts` and `packages/schema/test/everywhere.test.ts`; `api/_lib/everywhere/keys.ts` (the same 30-day value, now from the shared constant).

## 2026-11-26, publication receipts survive unproven settles, and retire only on proof or after a warned bound

**The gap.** The desktop jobs client counted any 2xx settle answer as delivered. Under the stop switch the jobs API answers a settle 200 `{action: "stop"}` without recording it, so the runner cleared the journaled publication receipt of a branch it had already pushed, and the result was lost. In the other direction, a settle refused 409 `JOB_ENDED` or 404 kept its receipt forever: every start re-sent it three times, and 32 such receipts stopped the computer taking any job.

**The fix.**

- The client's `settle` now counts only a 200 whose body is exactly `{settled: true}` as delivered. Any other status or body throws "Everywhere result was not acknowledged". A 409 whose body is `{error: {code: "JOB_ENDED"}}` throws a private `SettlementEnded`. The settle route emits that code only after it has proved the sponsor, the device and the exact lease.
- `deliver` stops retrying on `SettlementEnded`. For a journaled publication receipt it clears the receipt only when the fixed local warning "could not report a publication because the job had ended" was actually written. With no log sink, or a sink that throws, the receipt stays. A 404, any other 409 and transport failures keep the receipt and the three bounded attempts as before.
- The ledger's `acknowledge` is now `clearReceipt`. It also writes nothing when no receipt matches. The ledger records `publicationObservedAt`, the first local time it saw each receipt. A legacy receipt with no saved time gets the time of its first read. A receipt retires after `JOB_RECORD_RETENTION_MS` (30 days, the server's own job-record retention), counted from the later of that time and the creation time encoded in its job id. It retires only while no reservation for the same job is active, and only when `onPublicationExpired` (the wiring's fixed log line) succeeds.
- The schema adds `jobIdTime(jid)` and `JOB_RECORD_RETENTION_MS`. `api/_lib/everywhere/keys.ts` reads `KEEP_MS.job` from the constant (unchanged value).

**Lead rulings (this run).**

- *Which follow-up option.* The finding offered two options. Option one is server-side: settleJob accepts a late publication from the lease holder of a stopped or cancelled job, and the platform reply shows the branch. Option two is runner-side: keep the receipt until it is proven settled, and retire a receipt the server refuses permanently with a fixed local log line, never replacing it with "nothing published". Ruling: option two, as built. It changes no server state machine and no public copy. It closes both halves of the finding: a 200 stop no longer clears a receipt, and refused receipts can no longer fill the 32-receipt cap for good. Option one widens the settle contract for ended jobs, so it is left for the lead and the owner. Known consequence: after a platform or user cancel, the platform notice can still omit a branch whose push had already finished. Only the computer's log says so.
- *Bound for receipts the server never answers.* The 30-day bound uses the server's job-record retention. After 30 days the server holds no record that could accept the result. Retirement needs the local warning, so a computer without a log sink keeps the receipts and stops taking jobs at 32. This fails closed instead of losing results silently.
- *"No settle after 404/409" (EV-03 options (a) to (c)).* Only an authenticated `JOB_ENDED` now stops the replay: one settle, for journaled and plain results alike. A 404 and the other 409 codes keep three attempts, because they do not prove what happened to the job. The rest of (b) and (c) stays open for the lead.

**Takeover work (2026-11-26).** Merged origin/main (no conflicts: main had not touched the PR's files). Added the schema round-trip case for `jobIdTime`. Reran CI-relevant files locally. On the PR's last CI run, the red checks were `engine (windows, shard 15/18)` and two cancelled `computer-helper` jobs. The engine failure was a Windows containment-helper startup timeout in an engine task test. The `computer-helper` jobs were a checkout cancelled after 7 s and a 6-hour overlay timeout. None of them touches these files.

**Tests.**

- `everywhere-runner.test.ts`:
  - "a switch stop during an admitted confirmed/ambiguous push keeps the publication receipt until it is acknowledged": three identical settles answered 200 `{action: "stop"}`, the receipt kept, and one settle on recovery that clears it.
  - "an authenticated JOB_ENDED retires a publication only when it can be reported" (visible, missing and failed log): one settle, retired only when the warning was written.
  - "the jobs client refuses an unconfirmed success response": 202, an extra key, and a string `"true"`.
  - The 404/409 heartbeat cases now answer `NOT_FOUND` and `LEASE_MISMATCH` and keep the receipt.
- `everywhere-ledger.test.ts`:
  - "legacy receipts keep a durable recovery window and expire only after a local warning".
  - "advancing a publication receipt preserves its first observation and an active slot protects it".
- `packages/schema/test/everywhere.test.ts`: "job ids give back the creation time they encode, which bounds local publication recovery".

**Evidence** (each file run alone with `--timeout 30000`, after the main merge):

- Green:
  - desktop runner 68/68, ledger 9/9, wiring 31/31;
  - schema `everywhere.test.ts` 59/59;
  - web `everywhere-keys` 15/15, `everywhere-jobs` 55 pass with 11 skipped;
  - journeys: laptop 5 pass with 2 skipped, laptop-tracker 5 pass with 4 skipped, actions 11 pass with 2 skipped.
  - The skipped cases need `VECTOR_TEST_REDIS_URL` and run in CI's "Vector everywhere tests" job (Valkey service).
  - `bun typecheck` passed in desktop and schema, and for the hosted API (`--project ../../tsconfig.json`).
- Red-before:
  - The five source files reverted to origin/main: the runner file gave 60 pass and 8 fail, the new cases above. The ledger file did not load, because `JOB_RECORD_RETENTION_MS` was missing.
  - With only the schema restored, the ledger file gave 6 pass and 3 fail: the two new cases and the renamed `clearReceipt` case.
  - All sources were restored and their sha256 compared equal.
- Mutations (each restored, sha256 equal):
  - M1, the client accepting any 200 settle: runner 4 fail (both switch-stop cases and the two 200 bodies).
  - M2, dropping the active-slot guard on expiry: ledger 1 fail (the active-slot case).
  - M3, `jobIdTime` ignoring the digit values: schema 1 fail (the round trip) and ledger 1 fail (the legacy window).

**Left open.** The server-side option above, which would show a pushed branch in the platform notice after a cancel. The remaining EV-03 options (b) and (c), for the lead.
