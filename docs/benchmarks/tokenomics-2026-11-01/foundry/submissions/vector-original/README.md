# Foundry

A local-first business-operations prototype connecting customers, inventory, orders, invoices and project delivery. React + TypeScript + Vite, served with its Bun API on one origin. No external assets or services.

## Run

```powershell
bun run typecheck
bun test server
bun run build
$env:PORT = '3000'
$env:DATA_DIR = 'C:\absolute\path\to\foundry-data'
bun run start
```

Open `http://127.0.0.1:3000/signup`. Accounts start with an empty workspace. Use synthetic `example.invalid` addresses. The default data directory is `.foundry-data`; the database is `foundry.sqlite`, and attachments use opaque file names in `attachments/`.

## Included

- Durable Argon2id accounts and server-side cookie sessions; multiple workspaces; email-bound, expiring local invitations; owner/manager/member/read-only enforcement.
- Customer search, editing, transactional CSV import and formula-safe CSV exports.
- Inventory catalog, immutable stock ledger and atomic multi-product order fulfillment with persisted idempotency.
- Cents-exact invoices with immutable customer/item snapshots and local sent/paid/void transitions.
- Projects, filtered kanban tasks, assignees, due dates, safe comments and owned file attachments.
- Persisted audit activity, tenant-scoped summary analytics and one-second revision polling. Open pages reflect access changes too.
- Responsive navigation, native labelled selects, keyboard-operable modal dialogs and visible validation errors.

## Verification

Use a separate, absolute `DATA_DIR` for tests, never application source. Start the built application on the supplied `PORT` first. These tests create synthetic accounts and records.

```powershell
bun run verify:api
& "$env:NODE_EXE" tests/browser.mjs
```

The browser script requires `PLAYWRIGHT_MODULE` and `CHROME_PATH`. It runs a new headless browser and isolated contexts. Screenshots, a browser report and test session fixtures are written under `DATA_DIR/verification`, not source. Fixtures contain local verification sessions; treat them as private and remove them when no longer needed.

Stop and start the server with the same `DATA_DIR`, then run:

```powershell
bun run verify:restart
& "$env:NODE_EXE" tests/browser-restart.mjs
```

The API test covers validation, rollback, concurrent stock competition, concurrent idempotent fulfillment, invoice snapshots, tenant isolation, roles, CSV, files, activity, revision and actual password storage. The browser test exercises the connected UI workflows, live cross-client changes, role changes, keyboard dialogs, exports, attachments and mobile overflow. Restart tests check existing sessions, workspace selection, business data, files and idempotency.

## Boundaries

This is a local functional prototype, not production hardening. Invitations do not send email, invoice payment is only a local status record, and there is no payment provider, SMTP, telemetry or deployment. SQLite is designed here for one local Bun server. Files are extension-allowlisted and download-only, not antivirus-scanned. Polling replaces a push transport. No production backup, account recovery or abuse protection is claimed.
