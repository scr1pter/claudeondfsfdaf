# LedgerDesk: upgrade a running usage-billing operations service

This is maintenance work on an existing synthetic product, not a replacement
CRUD scaffold. Preserve its working accounts, usage ingestion, quotations,
workspace isolation, command line and typed client while adding an auditable
v2 storage migration and issued-invoice/credit operations. No real payments,
email, cloud services, external APIs or new dependencies are needed.

Use the provided runtime and local tools. Run `app.mjs` as the server, `cli.mjs`
as the command line, and export the client from `sdk.mjs` with declarations in
`sdk.d.mts`. `PORT` selects loopback HTTP port and `DATA_DIR` selects a private
data directory. Do not inspect, modify or read the independent evaluator or
private reference. Tests and documentation you add must test actual behavior.

## Existing product and compatibility

The server accepts `Authorization: Bearer <key>`. The labelled synthetic
bootstrap keys are `owner-acme`, `billing-acme`, `reader-acme` and `owner-beta`.
Their workspaces are `acme` and `beta`; the first component is the role. Keys
are development fixtures, not a production authentication design. A reader can
read authorized resources, billing can also record usage and issue invoices and
credits, and only an owner may create accounts or manage access keys. Resource
lookups outside a key's workspace or account scope return 404. Missing, unknown
and revoked keys return 401; an authenticated but disallowed write returns 403.
Neither responses nor error text may disclose an unrelated workspace or key.

Preserve these routes:

| Method and route | Contract |
| --- | --- |
| GET /health | 200 `{ok:true, version:<storage schema number>}` |
| GET /api/accounts | 200 account array, only authorized workspace/scope |
| POST /api/accounts | owner; `{name,plan:{baseCents,includedUnits,unitCents}}`; 201 account |
| GET /api/accounts/:id | 200 account, otherwise 404 |
| POST /api/accounts/:id/usage | `{eventId,units,occurredAt}`; 201 new event |
| GET /api/accounts/:id/usage?period=YYYY-MM | 200 event array, optional UTC calendar-month filter |
| GET /api/accounts/:id/quote?period=YYYY-MM | 200 quotation described below |

Accounts contain `id`, `workspaceId`, `name` and the plan. Usage events contain
`id`, `workspaceId`, `accountId`, `eventId`, integer `units` and `occurredAt`.
Names and event identifiers must be nonempty strings of at most 200 characters;
units must be a positive safe integer. All plan values must be nonnegative safe
integers, with `includedUnits` allowed to be zero. Dates must be valid RFC3339
timestamps with a timezone; do not silently normalize impossible dates. Periods
must be valid `YYYY-MM`. JSON bodies must be objects. Unknown routes return404.
Business failures are JSON `{error:{code,message}}`, with a nonempty stable code
and message. Do not turn malformed inputs into internal errors or partial writes.

Quote fields are `accountId`, `period`, `totalUnits`, `baseCents`, `includedUnits`,
`unitCents`, `overageUnits`, and `totalCents`:
`overageUnits=max(0,totalUnits-includedUnits)` and
`totalCents=baseCents+overageUnits*unitCents`. Calendar months are UTC half-open
intervals. Reject unsafe arithmetic rather than round currency or units.

Existing CLI commands are `accounts list`, `quote <accountId> <period>`, and
`usage add <accountId> <eventId> <units> <occurredAt>`. Preserve their meanings.
`LEDGER_URL` and `LEDGER_KEY` provide URL and authentication. Help exits0.

## Durable v1-to-v2 migration

The only authoritative data file is `DATA_DIR/ledger.json`. A legacy file is
`{version:1, accounts:[...], usage:[...]}` with exactly the public shapes above.
On startup, validate the complete legacy data before changing any bytes. Migrate
it once, retaining account/event identifiers and all values. Before replacement,
create `ledger.v1.backup.json` containing the exact original bytes; never replace
or alter that backup on later starts. A malformed legacy record, duplicate ID,
invalid relationship, unknown schema version, or malformed JSON fails startup
without replacing the original. Fresh directories start directly with v2.

V2 storage is `{version:2,payload:<object>,checksum:<64 lowercase hex>}`. The
payload may use suitable collections/indexes but must durably represent all
accounts, usage, invoices, credits, dynamic keys and idempotency records. The
checksum is SHA256 over UTF8 JSON of payload with object keys recursively sorted
lexicographically, no whitespace, arrays in stored order and ordinary unescaped
Unicode. Verify it before trusting or serving existing data; reject corruption
and unknown versions without repairing or discarding evidence.

Commit each successful business operation and its idempotency record atomically.
Use an fsynced temporary file and atomic replacement, or an equally strong local
transaction mechanism, so a response never acknowledges an incomplete durable
operation. Serialize racing mutations or use equivalent transactional protection.
No unbounded polling loops or in-memory-only durability. A process crash followed
by restart must retain committed operations and idempotency behavior.

Only one server process may own a data directory. A second live instance must
fail rather than share an in-memory store and lose updates. A process ownership
lock must recover after its former process has exited. Do not delete another
live process's lock. Bind HTTP only on loopback. Graceful and forced process
termination must not leave descendants running.

## Usage and invoice semantics

Usage `eventId` is unique per account. An exact duplicate of its business fields
returns200 with the original event; changed units or timestamp return409 with
no write. Concurrent identical submissions create exactly one event. This
deduplication must survive restart and remain inside authorization boundaries.

Add `POST /api/accounts/:id/invoices` with `{period,requestId}`. Billing/owner
keys can issue one invoice for an account and period. Return201 on first commit.
An exact replay of the same actor, account, operation and request ID returns200
with the original result; a changed business payload with that request ID
returns409. Distinct request IDs for an already-issued account/period return409.
Concurrent submissions must not issue duplicate invoices. Request IDs are
nonempty strings up to 200 characters. They must not cross actors, operations,
accounts or workspaces. Authorization always precedes any cached result.

An invoice contains `id`, `workspaceId`, `accountId`, `period`, `status:'issued'`,
`totalUnits`, `baseCents`, `includedUnits`, `unitCents`, `overageUnits`,
`totalCents`, `creditedCents`, `balanceCents`, and `lines`. It snapshots the quote
at issue. Lines have `kind` (`base` or `overage`), `quantity`, `unitCents` and
`amountCents`; their sum equals `totalCents`. The base line has quantity1 and the
base amount. The overage line has the overage quantity and unit rate, even when
zero. Later usage can change a current quote but cannot change the invoice's
units, original amounts or lines. `creditedCents` and `balanceCents` reflect
committed credits; `balanceCents=totalCents-creditedCents`. Invoices survive
restart. Add `GET /api/invoices/:id` for an authorized reader or writer.

## Credits, keys and revocation

Add `POST /api/invoices/:id/credits` with
`{requestId,amountCents,reason}` for billing/owner. Return201 for a new credit,
200 for its exact replay, 409 for conflicting reuse or a total credit exceeding
the invoice's original `totalCents`, and 400 for invalid input. `amountCents`
must be a positive safe integer and `reason` a trimmed nonempty string up to
200 characters. The result contains `id`, `workspaceId`, `invoiceId`,
`amountCents` and `reason`. `GET /api/invoices/:id/credits` returns its authorized
credit array. Concurrent credit attempts cannot over-credit. A failed attempt
creates neither a credit nor a successful idempotency entry.

Add owner-only `POST /api/access-keys` with `{role,accountIds?}`. Roles are
`billing` and `reader`; a supplied nonempty account ID array must contain unique
existing accounts in the owner's workspace. An omitted scope covers the
workspace. Return201 `{id,apiKey,role,accountIds?}` with a newly generated
unguessable key. Persist only its hash, role, workspace and scope, not the raw
key. Add owner-only `POST /api/access-keys/:id/revoke` with an empty object,
returning200 `{revoked:true}` for an existing key in that workspace. Revocation
is idempotent. Keys outside the owner's workspace return404. Dynamic keys and
revocations survive restart. A key cannot create other keys or expand its scope.

Reauthorize at the commit boundary. If an authorized key begins a mutation but
is revoked while its JSON body is still being sent, it must return401 and must
not commit. Revoked keys must not receive successful idempotent replays.

## Command line and typed client

Add CLI commands `invoice issue <accountId> <period> <requestId>`,
`invoice show <invoiceId>`, and
`credit add <invoiceId> <requestId> <amountCents> <reason>`.
Success prints exactly one JSON value to stdout and exits0. API or validation
failure prints JSON `{error:{code,message}}` to stderr, leaves stdout empty,
and exits nonzero. Unknown/incomplete commands fail. Do not expose the API key
in diagnostics. Commands must exercise the real HTTP service, not local state.

`sdk.mjs` exports `createClient({baseUrl,apiKey})` and `ApiError` (an Error
subclass with numeric `status` and string `code`). Its async methods return
public API objects directly, propagate API failures as `ApiError`, and include:

```text
listAccounts()
createAccount({name,plan})
recordUsage(accountId,{eventId,units,occurredAt})
listUsage(accountId,period?)
quote(accountId,period)
issueInvoice(accountId,{period,requestId})
getInvoice(invoiceId)
creditInvoice(invoiceId,{requestId,amountCents,reason})
listCredits(invoiceId)
createKey({role,accountIds?})
revokeKey(keyId)
```

Publish accurate `sdk.d.mts` declarations exporting the client options, client,
account/plan, usage, quote, invoice/line, credit and key types. No `any`, blanket
index signatures, or untyped Promise return values. Strict TypeScript consumers
must accept correct uses and reject wrong role, parameter and result types.
Keep the SDK and CLI connected to every requested workflow and document running,
migrating, verifying, recovering and the synthetic authentication limitations.

## Definition of done

Preserve existing behavior and complete migration, transactions, concurrency,
authorization, revocation, immutable invoice snapshots, credits, the CLI and the
typed SDK. Independently verify the completed product and report material gaps.
All local work stays in the assigned app directory. Use the provided seven-role
team; keep backend data/API, client, QA and final judge responsibilities distinct.
The lead must personally verify API, CLI and SDK after the final judge review.
