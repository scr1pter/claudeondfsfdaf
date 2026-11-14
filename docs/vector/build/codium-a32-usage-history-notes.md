# A32: Usage forecast and history

A32 follows A31 (`32263f8b`) and implements the contract's WP A32 on top of A17 (admission and settlement into the
`day:` buckets) and A18 (status, `forecastDate`'s period-average fallback). No schema, protocol or generated client
changed, so no generator ran. No service, account, deployment or provider was called.

## What changed

- **`api/_lib/codium-usage-history.ts` (new).**
  - `HISTORY` (one read-only EVAL): the pool's `day:<pool>:<date>` buckets for every UTC date from the period's first
    through today (`total`, as SETTLE writes it, so desktop, CLI and run-token requests all count, including @vector
    runs while the desktop is closed), plus the pool's debits by the UTC date they were recorded. Answers -1 when a
    bucket or debit is not what its writer leaves.
  - `historyDays`, `readUsageHistory` (undefined on a failed or malformed read: history is display only), and
    `usageHistory` (each date as a share of the month rounded to a whole percent).
  - `forecastDate`: the straight line over the last 7 UTC dates (never before the period started) when that window has
    at least 3 dates of settled use, otherwise the period average (A18's formula, kept exact so a month that lasts to
    its end stays hidden). Hidden in the first 3 days, under 5% used, once used up and when the month lasts to its end.
- **`api/_lib/model-plan-status.ts`.** Status reads the history once the period's pool has figures and its key is the
  snapshot's, sends `history` (every date of the period so far, from its first), and computes `plan.forecastDate` from
  it. `forecastDate` is re-exported from here as before. One more store call per uncached status read (30 s cache).
- **`packages/core/src/model-plan-status.ts`.** `forecastText(date, locale)` ("At this pace, this month's usage may run
  out around Nov 22.", the date read as UTC) and `formatDayShare` ("<1%" for a share that rounds to 0). `describe()`
  prints the forecast line after the Today line, so `vector codium` shows it (done criterion).
- **Settings → Usage** (`settings-vector-codium.tsx`, `codium-usage-model.ts`, `settings-account.css`, `usage.tsx`).
  - The 31-day strip: one bar per UTC date ending on the newest date status sent, height relative to the busiest day,
    dates before the period marked, each labelled "Oct 3: 4% of this month" or "Oct 3: <1% of this month".
  - The forecast line uses `forecastText`.
  - The renewal card ("Before your plan renews", or "ends"): counts only, from this computer's local usage summary
    since the period's first date: Codium responses and days with Codium work. No tokens, dollars or shares. It is not
    shown for an older server whose summary cannot attribute Codium work to days.
- **Test fixture.** `codium-spend-emulation.ts` emulates `HISTORY` for both in-memory stores.

## Edits to `api/_lib/model-plan-*.ts`

`model-plan-status.ts` only (history read, `history` field, forecast inputs, `forecastDate` moved and re-exported).

## Tests

Run one file at a time with `--timeout 30000`, root tests from `test/`, package tests from their package:

| File                                                                                 | Result              |
| ------------------------------------------------------------------------------------ | ------------------- |
| `test/codium-usage-history.test.ts` (new)                                            | 11 pass (in memory) |
| `packages/web/test/model-plan-status-api.test.ts` (one case added, one updated)      | 22 pass             |
| `packages/core/test/model-plan-forecast.test.ts` (new)                               | 4 pass              |
| `packages/app/src/components/settings-v2/codium-usage-model.test.ts` (5 cases added) | 10 pass             |
| `packages/core/test/model-plan-status-compat.test.ts` (unchanged, H7)                | 4 pass              |
| `test/codium-pool.test.ts` (unchanged, shares the emulation)                         | 27 pass             |

Mutation checks (each reverted): turning the 7-day line off fails 3 root cases and the status case; starting the
window 6 dates back regardless of the period start fails the window case.

**CI only:**

- `test/codium-usage-history.test.ts` runs every case on real Valkey when `VECTOR_TEST_REDIS_URL` is set, which is the
  check that `HISTORY`'s Lua and its TypeScript emulation agree. Locally only the emulation ran (no Valkey on this Mac).
- `packages/web/test/model-plans-api.test.ts` needs `valkey-server`: the new case sends a real `vrt_` run-token request
  through the gateway, waits for SETTLE and checks that the run's charge is in today's history and in status (history
  includes run-token spend); the strict status body case now expects `history`. Not run here.
- The strip and the renewal card have not been looked at in a browser (no dev server on this Mac); their models are
  unit-tested and the component typechecks.

Typecheck: root `tsconfig.json` (api) clean; `packages/core` `tsgo --noEmit` clean; `packages/app` `tsgo -b` clean;
`packages/web` `astro check` 0 errors, 0 warnings (no new hints in the touched lines).

## Contract readings

Recorded in `codium-deviations.md` under "A32 usage forecast and history (2 Nov 2026)".

## Not done

- The website account page keeps its forecast line and shows no strip: A32's file list does not include it.
- A57 owns deleting the `day:` buckets with the account; they also expire 40 days after their period.
