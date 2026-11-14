# LedgerDesk v2

A dependency-free, synthetic local usage-billing service. The v1 account, usage,
quote, CLI and client interfaces remain available. V2 adds validated migration,
checksummed transactional storage, immutable issued invoices, credits, scoped
access keys and durable idempotency. No payments, email or external services.

## Run locally

Use the supplied Node runtime (Node 24 recommended). Set `DATA_DIR` to a private
directory **outside this source tree**, and `PORT` to the selected local port:

```powershell
$env:DATA_DIR = 'C:\local-synthetic-ledger-data'
$env:PORT = '4125'
node app.mjs
```

In this environment use `& $env:NODE_EXE app.mjs`. The service binds only
`127.0.0.1`. `GET /health` returns `{ "ok": true, "version": 2 }`. Stop using
Ctrl+C or SIGTERM. A second live server cannot own the same data directory.
The service does not launch child processes. Keep data on a local filesystem
with atomic rename support; this is not a distributed database.

## Synthetic authentication and isolation

Send `Authorization: Bearer <key>`. The labelled fixtures are `owner-acme`,
`billing-acme`, `reader-acme` and `owner-beta`. These are deliberately public
development fixtures, **not production credentials or authentication**. Use only
synthetic local records. Do not expose this service publicly.

Owners manage accounts and access keys. Billing can record usage, issue invoices
and apply credits. Readers can read. Owner-created keys may be `billing` or
`reader`, optionally scoped to a nonempty unique list of workspace account IDs.
Only the generated key hash is persisted; the raw key is returned once. Keep it
private. Revocation is permanent and checked again at mutation commit, including
idempotent replay. Missing/unknown/revoked credentials receive 401; disallowed
writes receive 403; resources outside the workspace or account scope receive 404.

## HTTP workflows

All business failures are JSON `{error:{code,message}}`. JSON bodies must be
objects; amounts/units use safe integer arithmetic. Timestamps require valid
RFC3339 dates with timezone; periods are `YYYY-MM` UTC calendar months.

| Method | Path | Input / result |
| --- | --- | --- |
| GET | `/api/accounts` | Authorized account array |
| POST | `/api/accounts` | `{name,plan:{baseCents,includedUnits,unitCents}}` → account |
| GET | `/api/accounts/:id` | Account |
| POST | `/api/accounts/:id/usage` | `{eventId,units,occurredAt}` → event |
| GET | `/api/accounts/:id/usage?period=YYYY-MM` | Events; period optional |
| GET | `/api/accounts/:id/quote?period=YYYY-MM` | Quote |
| POST | `/api/accounts/:id/invoices` | `{period,requestId}` → issued invoice |
| GET | `/api/invoices/:id` | Invoice with current credited/balance amounts |
| POST | `/api/invoices/:id/credits` | `{requestId,amountCents,reason}` → credit |
| GET | `/api/invoices/:id/credits` | Credit array |
| POST | `/api/access-keys` | `{role,accountIds?}` → `{id,apiKey,role,accountIds?}` |
| POST | `/api/access-keys/:id/revoke` | `{}` → `{revoked:true}` |

Usage event IDs are unique per account: exact duplicate fields return the
original event (200), changed fields conflict (409), new events return 201.
Invoices are unique per account/month and snapshot the quote, including base
and overage lines even when zero. Later usage changes quotes, not issued amounts.
Credits cannot exceed the original total; invoice balance subtracts committed
credits. Request IDs for invoice/credit operations are scoped by actor, workspace,
operation and resource: exact replay is 200, changed business input is 409, first
commit is 201. Failed operations do not reserve a successful request ID.
Mutations are serialized and persisted atomically with idempotency state before
success is acknowledged.

## CLI

Set `LEDGER_URL=http://127.0.0.1:4125` and `LEDGER_KEY` to a synthetic key.

```text
node cli.mjs --help
node cli.mjs accounts list
node cli.mjs quote <accountId> 2026-01
node cli.mjs usage add <accountId> example-event 120 2026-01-10T00:00:00.000Z
node cli.mjs invoice issue <accountId> 2026-01 issue-001
node cli.mjs invoice show <invoiceId>
node cli.mjs credit add <invoiceId> credit-001 100 "Synthetic adjustment"
```

Help exits zero. Successful commands print exactly one JSON value to stdout.
Failures print JSON errors only to stderr and exit nonzero. All commands use the
real HTTP service; no CLI command directly modifies the ledger file. Run help for
the complete list of connected workflows.

## Typed SDK

```javascript
import { createClient, ApiError } from './sdk.mjs'
const ledger = createClient({
  baseUrl: process.env.LEDGER_URL,
  apiKey: process.env.LEDGER_KEY,
})
const account = await ledger.createAccount({
  name: 'Synthetic account',
  plan: { baseCents: 1000, includedUnits: 100, unitCents: 2 },
})
await ledger.recordUsage(account.id, {
  eventId: 'sample-001', units: 150, occurredAt: '2026-01-10T00:00:00Z',
})
const invoice = await ledger.issueInvoice(account.id, {
  period: '2026-01', requestId: 'issue-001',
})
await ledger.creditInvoice(invoice.id, {
  requestId: 'credit-001', amountCents: 100, reason: 'Synthetic adjustment',
})
```

`sdk.d.mts` publishes exact typed options, inputs, client and public result types.
Other methods are `listAccounts`, `listUsage`, `quote`, `getInvoice`, `listCredits`,
`createKey` and `revokeKey`. API failures reject with `ApiError` carrying numeric
`status` and string `code`. Strict consumers should use NodeNext module resolution.

## Migration, storage and recovery

The sole authoritative file is `DATA_DIR/ledger.json`. Fresh directories start at
v2. Existing v1 `{version:1,accounts:[...],usage:[...]}` files are fully validated
before any original bytes change. Migration retains every identifier and value,
and writes the **exact original bytes** to `ledger.v1.backup.json` before atomic
replacement. That backup is never overwritten on later starts.

V2 is `{version:2,payload,checksum}`. Its checksum is lowercase SHA256 over UTF8
canonical JSON: object keys recursively lexicographically sorted, no whitespace,
arrays kept in stored order and ordinary Unicode. Startup verifies the checksum
and relationships before serving. Writes use a synchronized temporary file and
atomic replacement. Ownership locks prevent concurrent server processes, and a
lock from an exited process is recoverable on the next start.

For a rejected/corrupt ledger, stop the instance you own and preserve the ledger,
backup and diagnostic evidence. **Do not remove a live process's lock, hand-edit
checksums, discard records, or overwrite the immutable v1 backup.** Diagnose using
a copy under your private data directory. Restore a known-good complete ledger
only while no service owns the directory; retaining the damaged original is an
operator responsibility. The v1 backup reflects migration time only; restoring
it will lose post-migration operations, so prefer a recent complete v2 backup.
Do not serve the data directory over HTTP or place raw API keys in backups/logs.

## Verification

```text
node --test backend/*.test.mjs client-tests/*.test.mjs
node tests/verify-final.mjs
# Restart the same verification instance, then:
node tests/verify-restart.mjs
```

The live verifier requires a separately running synthetic instance selected by
`LEDGER_URL`/`PORT`. Set `DATA_DIR` to that instance's actual private directory to
also independently verify its checksum and absence of raw generated keys. It
exercises the actual API, CLI and imported SDK, errors, roles, scope, revocation,
concurrency, snapshots and credits. It intentionally creates synthetic records.
Backend tests separately cover migration, corruption, locks and restart behavior.
The live verifier writes only synthetic verification metadata (no API keys) to
`DATA_DIR/lead-verification.json`; the restart verifier consumes that metadata.
All test runtime files must stay under `DATA_DIR`; authored tests stay in source.
No browser interface, external service, deployment or production integrations
are required for this API/CLI/SDK product.
