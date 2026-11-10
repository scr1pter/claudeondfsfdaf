# Foundry

A local business-operations workspace built with React, TypeScript, Vite, Bun and SQLite. Customers, immutable inventory movements, transactional orders, invoice snapshots, project boards, comments, owned attachments, CSV, team roles, activity and analytics share one durable workspace model.

## Run

The supplied dependencies are already installed.

```powershell
bun run typecheck
bun test server/validation.test.ts
bun run build
$env:PORT = '3000'
$env:DATA_DIR = 'C:\absolute\path\to\foundry-data'
bun run start
```

Open `http://127.0.0.1:3000/signup`. Create an account with a synthetic `example.invalid` email and a password of at least 12 characters. No seed accounts or sample records are inserted automatically. The default data location is `.foundry-data`; set an absolute `DATA_DIR` to keep data elsewhere. The database is `foundry.sqlite`, with owned attachment bytes in `attachments/`.

## Product behavior

- Workspace membership is checked on every API request. Owners manage local invitations and roles; managers operate inventory, orders and invoices; members collaborate on customers and delivery; read-only members can read and export.
- SQLite immediate transactions serialize business mutations. Fulfillment checks every line before writing, records immutable movements, and persists the fulfillment result under a workspace-scoped idempotency key. Failed attempts do not consume that key.
- Money is stored as integer cents. Order lines and invoice bill-to/items are snapshots. Invoice payment is a local status decision.
- Passwords use salted Argon2id. Sessions use random, server-revocable HttpOnly cookies. All assets load from the local application origin.
- Open pages poll actual workspace revisions every second. Membership and role changes also refresh without a manual reload.
- CSV imports validate all rows before committing. Exports neutralize spreadsheet formulas. Attachments use opaque storage filenames and authenticated downloads.

## Verification

With a server running on the configured `PORT` and a separate verification `DATA_DIR`:

```powershell
bun verification/api.ts
& $env:NODE_EXE verification/browser.cjs
```

The browser script uses the supplied `PLAYWRIGHT_MODULE` and `CHROME_PATH`, isolated headless contexts and synthetic data. It writes representative screenshots to `verification/artifacts/`. It never opens an existing browser profile. API and browser scripts save their restart fixtures under `DATA_DIR`, separate from source.

After stopping and restarting the application with the same `DATA_DIR`, run:

```powershell
bun verification/restart.ts
& $env:NODE_EXE verification/restart-browser.cjs
```

`api.ts` covers authentication, roles, tenant isolation, validation, transactional rollback, competing and same-key fulfillment, snapshots, CSV, files and persisted audit data. The browser script covers actual user interactions, keyboard focus/Escape, responsive layouts, imports/downloads, live data and live roles. Restart scripts check durable sessions, selection, records, idempotency and file bytes.

## Prototype boundaries

Runs on local HTTP at `127.0.0.1`. There is no SMTP, payment integration, deployment, telemetry, external API, password recovery or production operations layer. Invitations are copied locally. Business lists are capped at 1,000 matching rows and intended for small prototype workspaces; there is no pagination or virtual scrolling. CSV exports and analytics use all records. Browser verification targets the installed Chromium, not a full cross-browser/device matrix.
