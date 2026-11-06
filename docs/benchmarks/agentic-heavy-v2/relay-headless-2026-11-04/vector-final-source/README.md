# Relay Directory

A loopback-only durable roster-import API, JSON CLI, and typed JavaScript SDK.
There is intentionally **no graphical interface**. No installation, downloaded
packages, external services, or deployment are needed. Use current Node or Bun.

## Run

Supply a nonempty bootstrap capability through `RELAY_BOOTSTRAP_TOKEN`, an
absolute directory **outside this source tree**, and a port:

```text
node app.mjs --data ABSOLUTE_DATA_DIRECTORY --port 4125
bun app.mjs --data ABSOLUTE_DATA_DIRECTORY --port 0
```

Port `0` selects an available port. The first stdout line is
`{"ready":true,"port":ACTUAL_PORT}` only after strict journal recovery and
exclusive data-directory ownership. The listener binds only `127.0.0.1`.
`GET /health` is public; business routes require bearer capabilities.
Write `shutdown` plus a newline to the server's stdin to drain accepted writes,
close the listener, release ownership, and exit zero. Do not share a data
directory between running service processes. See [STORAGE.md](STORAGE.md).

## Workflow

1. Use the bootstrap capability to `POST /v1/workspaces` with `{id,name}`.
2. Retain the returned owner capability; issue independent editor, approver,
   worker, and viewer capabilities using `POST /v1/workspaces/:id/tokens`.
3. Stage CSV against the current directory version as an editor.
4. Approve as a different subject with approver authority.
5. Claim as a worker, then commit using that same capability and its lease token.
6. Read members and paginated audit events. Revocation takes effect immediately.

All data should be synthetic and local. Protect capability and lease responses;
they are secrets. Never put them in source control or routine logs. Secrets are
not included in persisted transactions, audit events, or error bodies.

## CLI

Set `RELAY_URL` to the running loopback URL and `RELAY_TOKEN` to a capability.
Use `node cli.mjs --help` (or `bun cli.mjs --help`) for the full command syntax.
Examples below use placeholders, not real credentials:

```text
node cli.mjs status WORKSPACE
node cli.mjs members WORKSPACE
node cli.mjs stage WORKSPACE --file ABSOLUTE_CSV_PATH --base-version 0 --key unique-stage
node cli.mjs approve WORKSPACE IMPORT
node cli.mjs claim WORKSPACE IMPORT --lease-ms 5000
node cli.mjs commit WORKSPACE IMPORT --lease-token LEASE_TOKEN --key unique-commit
node cli.mjs cancel WORKSPACE IMPORT
node cli.mjs events WORKSPACE --after 0 --limit 50
```

Each command calls the live service. Success is one JSON value on stdout;
failure is one JSON error on stderr with a nonzero exit code. CSV files should
also live under the external data directory when exercising this project.

## SDK

```js
import { createClient, RelayError } from './sdk.mjs';
const client = createClient({
  baseUrl: process.env.RELAY_URL,
  token: process.env.RELAY_TOKEN,
});
try {
  const { version, members } = await client.members('synthetic-workspace');
} catch (error) {
  if (error instanceof RelayError) {
    // error.status is numeric; error.code and error.message are strings.
  }
}
```

`sdk.d.mts` declares exact role/state unions and all request/response shapes.
See BUILD_SPEC.md for the complete endpoint, authorization, CSV, idempotency,
lease fencing, and durability contract.

## Local verification

Set `DATA_DIR` to an existing writable absolute directory outside authored
source. Tests create isolated synthetic subdirectories there; they never use
an evaluator or reference implementation.

```text
node scripts/check.mjs
node --test tests/*.test.mjs
bun scripts/check.mjs
node scripts/verify-owned.mjs
bun scripts/verify-owned.mjs
```

The tests start their own local services and stop them afterward. Test data is
retained under `DATA_DIR` for inspection. No browser verification is applicable
because this application has no GUI.

For Bun service/CLI integration coverage, run the **Node test harness** with
`RELAY_TEST_RUNTIME` set to the Bun executable path:
`node --test tests/integration.test.mjs`. This runs all nested subtests rather
than relying on Bun's currently incomplete `node:test` nested-test support.

`verify-owned.mjs` additionally requires `PORT`, launches an owned service there,
runs every CLI command and the typed SDK consumer against the same live data,
checks restart durability, and shuts down both owned service instances. It
generates its synthetic bootstrap capability in memory without printing it.
The `.mts` consumer can run using Node's type stripping or Bun. These executions
and syntax checks do **not** substitute for a TypeScript semantic typecheck;
that requires a separately available `tsc` (no packages are downloaded here).
