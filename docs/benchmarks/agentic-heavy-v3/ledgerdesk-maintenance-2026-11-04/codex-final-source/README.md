# LedgerDesk

LedgerDesk is a local usage-billing operations service with accounts, usage,
monthly quotes, issued invoices, credits and scoped access keys. It has no runtime
dependencies and uses only synthetic fixture authentication. No payments, email
or external services are involved.

Run with a current Node.js runtime (Node 22 or later). Set `DATA_DIR` to a private
directory **outside this source tree**, and `PORT` to an available loopback port.
The supplied environment already provides `NODE_EXE`, `DATA_DIR` and `PORT`.

```powershell
& $env:NODE_EXE app.mjs
```

On other systems use `node app.mjs` with the same environment variables. The
server binds only `127.0.0.1`. `GET /health` returns `{ok:true,version:2}`.
Stop with Ctrl+C or terminate the server process. It does not start descendants.
Only one process may own a data directory; another instance fails startup.

The fixture keys are `owner-acme`, `billing-acme`, `reader-acme`, and `owner-beta`.
Their workspace and role follow their labels. Send
`Authorization: Bearer owner-acme`, for example. These public synthetic keys are
development fixtures, not production authentication or a payment system.
Owners create accounts and keys. Billing and owner keys record usage and issue
invoices and credits. Readers read only. Scoped dynamic keys can see only their
listed accounts. Keys and resources in other workspaces are hidden.

Set `LEDGER_URL` (for example `http://127.0.0.1:4125`) and `LEDGER_KEY` for the CLI.
The legacy commands remain available alongside invoice and credit commands:

```text
node cli.mjs --help
node cli.mjs accounts list
node cli.mjs usage add <accountId> synthetic-event 120 2026-01-10T00:00:00Z
node cli.mjs quote <accountId> 2026-01
node cli.mjs invoice issue <accountId> 2026-01 synthetic-issue-request
node cli.mjs invoice show <invoiceId>
node cli.mjs credit add <invoiceId> synthetic-credit-request 50 "Synthetic adjustment"
```

Successful commands print one JSON value and exit 0. Failures print a JSON error
to stderr with a nonzero exit; stdout remains empty. Help exits 0. Commands use
the live HTTP API and never open storage files.

The typed SDK is exported by `sdk.mjs`, with declarations in `sdk.d.mts`:

```js
import { createClient, ApiError } from './sdk.mjs'
const client = createClient({
  baseUrl: process.env.LEDGER_URL,
  apiKey: process.env.LEDGER_KEY,
})
const account = await client.createAccount({
  name: 'Synthetic example',
  plan: { baseCents: 1000, includedUnits: 100, unitCents: 2 },
})
await client.recordUsage(account.id, {
  eventId: 'example-1', units: 125, occurredAt: '2026-01-10T00:00:00Z',
})
const invoice = await client.issueInvoice(account.id, {
  period: '2026-01', requestId: 'issue-1',
})
await client.creditInvoice(invoice.id, {
  requestId: 'credit-1', amountCents: 50, reason: 'Synthetic adjustment',
})
console.log(await client.getInvoice(invoice.id))
```

The SDK also provides `listAccounts`, `listUsage(accountId, period?)`, `quote`,
`listCredits`, `createKey({role,accountIds?})` and `revokeKey(keyId)`. Dynamic key
creation returns its raw `apiKey` once; storage retains only a hash. Retain that
value privately if needed, then revoke it with an owner key. A revoked key cannot
read, mutate or obtain an idempotent replay. API errors become `ApiError` with
numeric `status` and string `code`.

The HTTP workflows are:

| Method | Route | Purpose |
| --- | --- | --- |
| GET / POST | `/api/accounts` | List / create accounts |
| GET | `/api/accounts/:id` | Read an account |
| GET / POST | `/api/accounts/:id/usage` | List / record usage |
| GET | `/api/accounts/:id/quote?period=YYYY-MM` | Current monthly quote |
| POST | `/api/accounts/:id/invoices` | Issue with `{period,requestId}` |
| GET | `/api/invoices/:id` | Read an issued invoice and current balance |
| GET / POST | `/api/invoices/:id/credits` | List / add credits |
| POST | `/api/access-keys` | Create reader or billing key |
| POST | `/api/access-keys/:id/revoke` | Revoke with `{}` |

Usage `eventId` is unique per account. Exact retries return the original event;
changed units or timestamp conflict. Invoices snapshot UTC calendar-month usage
and plan amounts. Late usage changes the current quote while preserving issued
invoice amounts and lines. Credits reduce the balance and cannot exceed the
invoice total. Invoice and credit request IDs are isolated by actor, operation,
account and workspace. Exact retries return the original response; changed
payloads conflict. Business mutations and idempotency records commit together.
Amounts and units are safe integers; overflow, malformed dates and invalid
objects are rejected without partial writes.

`DATA_DIR/ledger.json` is the only authoritative data file. A fresh directory
starts at v2. Existing v1 data is fully validated before migration. Valid data
retains all identifiers and values, and the exact original bytes are saved once
as `ledger.v1.backup.json`. Later startups never replace that backup. V2 stores a
payload and a SHA256 checksum over recursively sorted object keys, ordinary
Unicode, no whitespace and stored array order. Startup verifies the checksum
and record relationships. Writes serialize, fsync a temporary file and atomically
replace the ledger before acknowledging success. A process ownership lock
prevents concurrent servers and recovers after its previous process exits.

For recovery, stop every server using that directory and copy the data directory
before making changes. Preserve malformed ledgers, checksum failures and unknown
versions for diagnosis; startup deliberately refuses them rather than repairing
or overwriting evidence. Do not delete a live process's lock. To restore a
known-good backup, work in a separate private data directory while retaining the
original ledger and immutable migration backup. A v1 backup may be migrated
again in that separate directory. Restoring v1 discards later v2 operations, so
prefer a verified v2 backup when one exists. Never edit the ledger while a server
owns it.

Run behavioral verification with the server stopped and `PORT` available:

```powershell
& $env:NODE_EXE verify.mjs
& $env:NODE_EXE verify-types.mjs
```

The first command launches and stops its own local servers on `PORT`. It creates
only synthetic fixtures in unique `DATA_DIR/verification-*` directories and
writes a `report.json` there. It checks API, CLI and SDK workflows; migration and
corruption refusal; concurrency; process locking; forced restart; scope and
revocation during a streaming body. It leaves those files as evidence. The type
check uses a provided `TYPESCRIPT_COMPILER` path to `tsc.js`, or a local `tsc` on
PATH, and tests both valid and deliberately invalid strict TypeScript consumers.
Neither command downloads dependencies. `npm test` and `npm run typecheck`
provide equivalent entry points. Browser inspection is optional for this service;
the required interfaces are HTTP, CLI and the typed SDK.
