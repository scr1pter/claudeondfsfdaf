# Foundry

A local business-operations prototype built with React, TypeScript, Vite, Bun and SQLite. No external services or assets are required.

## Run

```powershell
bun run typecheck
bun run build
$env:DATA_DIR = "C:\path\outside-source\foundry-data"
$env:PORT = "3000"
bun run start
```

Open `http://127.0.0.1:3000/signup` and create a synthetic account (use an `example.invalid` email and a password with at least 12 characters). The single Bun server serves both the built frontend and API. All durable database and attachment data lives under `DATA_DIR`; configure it outside the source directory. The database is `foundry.sqlite`.

Accounts begin with an empty workspace. Invite tokens are shown locally; no email is sent. Invoice payment is a local status decision, not a payment integration.

## Verification

With the local server running, `bun tests/integration.ts` exercises the public API using isolated synthetic accounts and records. Browser verification must use the supplied common browser client and endpoint; no separate browser tooling is used.

See `VERIFICATION.md` for the checks actually run and any limitations.
