# Foundry

A local business operations prototype connecting customers, inventory, orders, invoices, project delivery and a shared team workspace. All business records come from the local API and SQLite database. There are no external services or remote assets.

## Run

Use the supplied pinned dependencies and Bun runtime. Set `DATA_DIR` to a directory outside the authored source tree and set `PORT` if desired (default `3000`).

```powershell
$env:DATA_DIR = 'C:\local-data\foundry'
$env:PORT = '3000'
bun run typecheck
bun run build
bun run start
```

Open `http://127.0.0.1:3000/signup`. Create an account using a synthetic `example.invalid` email address and a password of at least 12 characters. An empty owner workspace is created automatically. Use Team to generate local invitation tokens; a signed-in user with the invited email can accept one at `/join`. No email is sent.

The Bun server serves the built frontend and `/api` from the same local origin. Direct application routes are supported. The application stores `foundry.sqlite` and its owned attachment files under `DATA_DIR`; keep this directory to retain accounts, sessions, workspaces and records across restarts. Stop the server with Ctrl+C.

## Verification

With the local server running, the authored integration suite creates only synthetic local records:

```powershell
bun scripts/verify-api.ts
```

Restart the server with the same `DATA_DIR`, then check durable sessions, attachments, business totals and idempotency:

```powershell
bun scripts/verify-api.ts --restart
```

Test state and any verification artifacts belong under `DATA_DIR`. Browser checks use only the supplied `NODE_EXE` / `BROWSER_DRIVER_CLIENT` with `--endpoint BROWSER_DRIVER_ENDPOINT` and action JSON. The client reads its authentication token from the environment. No browser library or browser profile is loaded by this application.

The prototype records invoice payment status locally; it does not process payments. Uploaded files remain local. CSV import supports the specified customer schema, and exports protect spreadsheet formula prefixes without changing stored records.
