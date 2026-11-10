# Foundry

A local business-operations prototype connecting customers, inventory, orders,
invoices and project delivery. All records start empty. Create an account at
`/signup`; invitations are local tokens, not email.

## Run

Dependencies are pinned in the supplied lockfile. With Bun installed:

```sh
bun run typecheck
bun run build
bun run start
```

The server binds only to `127.0.0.1`, using `PORT` (default `3000`). Set `DATA_DIR`
to an absolute directory to place `foundry.sqlite` and owned attachments outside
the source tree. The default is `.foundry-data`. The built interface and API
share one origin; direct frontend routes work.

## Implementation

- React 19, TypeScript and Vite; system fonts, CSS and inline SVG only.
- Bun HTTP, SQLite WAL, immediate transactions for all workspace API requests.
- Argon2id passwords, durable server-side sessions and membership checks.
- Workspace-scoped stock, cents-exact snapshots, atomic fulfillment and durable
  idempotency results.
- Role-enforced collaboration, comments, owned local files, safe CSV, persisted
  activity and one-second revision polling.
- Native dialogs, native selects, keyboard focus return, responsive navigation
  and contained table/board scrolling.

## Verification

Run the application server with a dedicated, disposable `DATA_DIR` and `PORT`.
The tests create synthetic accounts and business data, and deliberately exercise
invalid requests. They must not run against a workspace you want to keep clean.

```sh
bun test tests/store.test.ts
bun test tests/api.test.ts
```

After the API suite, run `tests/browser.mjs` with the supplied `NODE_EXE`.
It requires `PLAYWRIGHT_MODULE` and `CHROME_PATH`; it launches isolated headless
contexts and closes them in `finally`. Screenshots and verification state are
written under the verification `DATA_DIR`, never application source.

Restart the server with the same `DATA_DIR`, then:

```sh
bun test tests/restart.test.ts
```

The API suite covers atomic rollback, concurrent fulfillment, scoped reads and
writes, role changes, CSV, files, snapshots and password storage. The restart
suite verifies durable sessions, workspace selection, domain data, file bytes,
analytics, revision and idempotent replays.

## Scope

This is a functional local prototype, not a production-readiness claim. No email,
payment processing, external services, deployment or telemetry are present.
Invoice payment is an explicit local status decision. Live updates use polling;
prototype lists are bounded at 5,000 records. Business records use a typed API
over workspace-scoped SQLite JSON records; users, memberships, sessions,
invitations, activity and idempotency results have separate durable tables.
