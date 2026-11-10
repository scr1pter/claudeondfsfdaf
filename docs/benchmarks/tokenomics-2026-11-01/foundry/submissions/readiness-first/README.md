# Foundry

A local-first business operations prototype built with React, TypeScript, Vite, Bun HTTP and SQLite. All resources are served from one origin. No external services, fonts, telemetry or payments.

## Run

```powershell
bun run typecheck
bun run test
bun run build
$env:PORT = '3000'
$env:DATA_DIR = 'C:\absolute\path\to\foundry-data'
bun run start
```

Open `http://127.0.0.1:3000/signup`. Create an account using a synthetic `example.invalid` email and a password of at least 12 characters. An owner workspace is created automatically. Start with Customers and Inventory, receive stock, then create an order. Fulfill it to enable invoicing.

`PORT` defaults to `3000`; `DATA_DIR` defaults to `.foundry-data`. Back up the entire data directory, including owned attachment files. The database is `foundry.sqlite`; SQLite WAL is enabled. Do not delete live database sidecar files.

## Included

- Auth, durable sessions, workspaces, email-bound local invitations and four enforced roles.
- Customers, atomic quoted-CSV import and formula-safe exports.
- Products, immutable stock history and transactional, idempotent order fulfillment.
- Immutable cents-exact invoice snapshots and explicit local billing status transitions.
- Projects, filterable kanban tasks, assignees, due dates and safe comments.
- Owned local attachments, downloads, deletion and entity cascade cleanup.
- Durable audit activity, tenant revisions, one-second live polling and real analytics.
- Responsive navigation, native accessible selects, keyboard dialogs and visible errors.

## Verification

`bun run test` runs isolated Bun tests under a unique directory inside `DATA_DIR` (or the OS temporary directory if unset). It does not start a listening server.

The verification scripts require a running Foundry server on the supplied `PORT`, an absolute `DATA_DIR`, and local `NODE_EXE`, `PLAYWRIGHT_MODULE`, `CHROME_PATH` environment variables. They create only synthetic records in that verification data directory. Use a dedicated data directory, not valuable application data.

```powershell
& $env:NODE_EXE scripts/browser-check.mjs
bun scripts/api-check.ts before
# Stop and restart the verification server with the same DATA_DIR and PORT.
bun scripts/api-check.ts after
& $env:NODE_EXE scripts/visual-check.mjs
```

The browser scripts launch isolated headless Chrome contexts. Screenshots and verification-only state live under `DATA_DIR/browser-verification`. The state files contain local session and invite tokens; do not publish them. `visual-check.mjs` verifies persistence and signs out that browser session, so run it last. The API `after` stage accepts its one-use persisted invitation and is intended for one execution per `before` stage.

## Scope

This is a functional local prototype, not production-hardened software. Invoice payment is a local recorded decision. Invitations are copied tokens, not email. There is no payment gateway, SMTP, malware scanning, password recovery, production rate limiting, or deployment configuration. Lists are capped at 10,000 rows and activity defaults to the newest 50 events. Live updates poll every second rather than using push notifications. Large-scale load testing and a full assistive-technology audit are outside the verification performed here.
