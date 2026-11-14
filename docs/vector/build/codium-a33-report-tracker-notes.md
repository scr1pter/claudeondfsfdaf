# A33: Report tracker

A33 follows A32 (`2278d0c8`) and implements the contract's WP A33 on top of A05 (the entitlement snapshot). No schema,
protocol or generated client changed, so no generator ran. No service, account, deployment or provider was called.

## What changed

- **`api/_lib/support-reports.ts` (new).** The tracker's store and rules.
  - Ids: `r_` and 26 letters of lower-case base32 (`a-z2-7`), 130 random bits from `node:crypto`.
  - Record `reports:<id>` (Codium prefix, §4.6), kept 180 days: `{v, status, createdAt, updatedAt, tag?, readFirst?,
fixedIn?, commit?}`. Nothing else is written, and the decoder refuses a record with any other field, so a message
    or reply address can never be stored or read back (P4). This matches the A30 privacy draft (`#report-tracking`).
  - Index `reports:acct:<sha256>`: the ids an account sent while signed in, kept as long as the reports, only so
    deletion can erase them. The key holds a hash, never the account id. `eraseAccountReports(account)` is ready for
    A57.
  - Statuses: `received`, `read`, `fixing`, `fixed` (needs the release, and may carry the commit), `closed`.
    `setReportStatus` keeps the record's expiry (`SET … XX KEEPTTL`) and never re-creates a report that is gone.
  - `reportHash(id)` = the first 16 hex digits of `sha256(id)`, what the changelog lists.
  - Subject tags: `[Plus]`, `[Pro]`, `[Max · read first]`, `[Ultra · read first]`.
- **`api/support/bug-report.ts`.** Without an `Authorization` header, nothing changes: 5 an hour per address. With one,
  it must be a valid, unrevoked `vct_` account token (desktop, CLI or unmarked), else 401; run tokens are refused
  (S3). A signed-in report gets the plan's tag and hourly limit (free 5, Plus and Pro 15, Max and Ultra 30, per account)
  while the stored snapshot is active or renewing (§4.4). The snapshot is read with `readSnapshot` alone, so a report
  never calls Stripe. Signed-in requests also count against a ceiling of 60 an hour per address. The record is written
  before the email, so every id in an email can have its status set; when the store cannot be written the report goes
  out without an id, and a failed email drops the record. The id goes in the email (`Report: r_…`, plus `Plan:` with
  the tag). The answer keeps `id` (the email's) and adds `report: {id, status: "received"}`.
- **`api/support/reports.ts` (new).** `POST /api/support/reports {ids}`: up to 100 ids in the body, no sign-in (the
  id is the credential, and the tracker is free for everyone), 60 an hour per address. It answers
  `{reports: [{id, status, updatedAt, fixedIn?, commit?}]}` and leaves out ids without a record.
- **`api/_lib/codium-perks.ts`.** `reports-first` gets a readiness check (the report email is configured), so it can be
  listed. Before, it had no service check and could never be listed. The tag itself comes from the snapshot's caps,
  as the module's rule says (listing is display only).
- **`script/report-status.ts` (new, owner).** `bun script/report-status.ts <id> <status> [--fixed-in <version>]
[--commit <sha>] [--mode live|test]`. It sets the status in the store and, for `fixed`, records the report's hash under
  that release in `packages/web/src/data/fixed-reports.json` (under one release only, sorted). Any other status takes
  the hash out again. It uses `KV_REST_API_URL`/`KV_REST_API_TOKEN` and never prints them. Without `--mode` it looks in
  both prefixes, because production writes under `test` until a live Stripe key is configured.
- **`packages/web/src/data/fixed-reports.json` (new, `{}`) and `packages/web/scripts/build-changelog.ts`.** Each
  release with fixed reports lists `fixedReports: [hash…]`. A malformed file fails the build. The writer now runs only
  as a script (`import.meta.main`), so `changelogReleases()` can be tested. With the empty list,
  `public/changelog.json` is byte-for-byte unchanged (regenerated and checked).
- **Desktop.**
  - `packages/desktop/src/main/bug-report.ts`: sends the signed-in account token from the main process. On a 401 it
    sends the report again without the token, so an expired or revoked token never costs a report. It keeps
    `{id, title, sentAt}` in userData `reports.json` (title = first line, at most 60 characters; at most 100 reports;
    180 days; mode 0600; written atomically).
  - `listReports()` gives the renderer `{hash, title, sentAt}`, never the id.
  - `reportStatuses()` asks `/api/support/reports` through `Egress.fetch("report-status")`. It answers
    `local-off` when Vector Local blocks the check, `unavailable` on failure, and sends nothing when there are no
    reports. The send itself keeps its existing, unlabelled main-process fetch.
  - IPC `reports-list` and `reports-status`, preload `window.api.reports`, platform `reports`.
- **Vector Local.** A new source, `report-status` (purpose `support`, blocked under Vector Local and allowable), in
  `packages/core/src/local-mode/sources.ts`, labelled "Report status" in the app.
- **App.**
  - `context/highlights-model.ts` (new) takes the changelog parsing out of `highlights.tsx` unchanged, so it can be
    tested, and adds `fixedReports`/`fixedReportHighlight`.
  - What's New opens with "A problem you reported is fixed in this version" when a release between the last version
    seen and this one lists the hash of a report this computer sent. The dialog lists up to 3 report titles.
  - Settings → Account → "Your reports" lists each report: its title, when it was sent, and its status. Unknown or
    missing statuses read "Received", and a fixed report shows "Fixed in vX" and the short commit. A note explains a
    Vector Local block or a failed check. The section shows signed in or out, whenever this computer has reports.
  - The bug dialog's "sent" view adds "Settings > Account shows what becomes of it." when the report was tracked.

## Edits to `api/_lib/model-plan-*.ts`

None.

## Tests

Run one file at a time with `--timeout 30000`, root tests from `test/`, package tests from their package:

| File                                                                                                        | Result                       |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `test/bug-report-api.test.ts` (new; P4, tags, limits, S3, store and email failures)                         | 16 pass                      |
| `test/support-reports-api.test.ts` (new; status route, script, fixed list, changelog, erase)                | 17 pass, 1 skip (Valkey, CI) |
| `packages/app/src/context/highlights-fixed-report.test.ts` (new)                                            | 7 pass                       |
| `packages/desktop/src/main/bug-report.test.ts` (new)                                                        | 5 pass                       |
| `test/abuse-api.test.ts` (unchanged, existing bug-report checks)                                            | 8 pass                       |
| `packages/core/test/local-mode/sources.test.ts` (unchanged, new source)                                     | 15 pass                      |
| `packages/app/src/features/local/local-model.test.ts` (unchanged)                                           | 39 pass                      |
| `packages/app/src/components/settings-v2/local-model.test.ts` (unchanged)                                   | 15 pass                      |
| `packages/web/test/codium-public.test.ts` (unchanged, perk readiness)                                       | 11 pass                      |
| `test/codium-mode.test.ts`, `api-module-loading.test.ts`, `no-topups.test.ts`, `no-project-wording.test.ts` | pass                         |

**CI only:** the last case of `test/support-reports-api.test.ts` sends the tracker's store commands to a real Valkey
when `VECTOR_TEST_REDIS_URL` is set (`SET … PX … NX`, `SET … XX KEEPTTL`, `SADD`/`PEXPIRE`, `MGET`, erase). It is
skipped here because this Mac has no Valkey. "Your reports", the dialog's fixed list and the bug dialog line have not
been looked at in a browser (no dev server on this Mac). Their logic is unit-tested and the components typecheck.

Typecheck: root `tsconfig.json` (api) clean; `packages/core` `tsgo --noEmit` clean; `packages/app` `tsgo -b` clean;
`packages/desktop` `tsgo -b` clean; `packages/web` `astro check` 0 errors, 0 warnings (no hints in the touched files).
`script/` and root tests are outside every typecheck config, as before.

## Contract readings

Recorded in `codium-deviations.md` under "A33 report tracker (2 Nov 2026)".

## Not done

- A57 wires `eraseAccountReports` into account deletion (P5); the records also expire after 180 days.
- The website's support form sends reports anonymously and does not show the id (no local store there).
- The "Labs" marker on reports (v3 item W) is not built, because Vector Labs is never built.
- For A60's legal read: the A30 privacy draft describes bug-report counters keyed by network address and email. A
  signed-in report adds a one-hour counter keyed by a keyed hash of the account id (`bug-report-account`), and one
  keyed by address (`bug-report-ip-signed`). The draft's record description matches what is stored.
