# LedgerDesk v1

A working local usage-billing service supplied as the starting point of a
maintenance task. It already supports accounts, usage records, monthly quotes,
workspace isolation, basic roles, a command line and a typed JavaScript client.
It has no external dependencies.

Set `PORT` and `DATA_DIR`, then run `node app.mjs` (or the supplied equivalent
runtime). The service listens on `127.0.0.1`. A new data directory starts an empty
v1 JSON store. Existing v1 account and usage arrays are loaded from `ledger.json`.

Use the synthetic fixture keys `owner-acme`, `billing-acme`, `reader-acme` or
`owner-beta` as Bearer credentials. They demonstrate workspace and role behavior;
they are not a production authentication system.

Set `LEDGER_URL` to the service address and `LEDGER_KEY` to a synthetic key, then:

```text
node cli.mjs accounts list
node cli.mjs quote <accountId> 2026-01
node cli.mjs usage add <accountId> example-event 120 2026-01-10T00:00:00.000Z
```

Import `createClient` or `ApiError` from `./sdk.mjs`. The neighboring declaration
file describes the existing account, usage and quote methods.

This legacy version deliberately does **not** implement the task's v2 migration,
checksummed transactional storage, server ownership lock, usage deduplication,
issued invoices, credits, dynamic scoped keys or revocation. Those are the
maintenance upgrade. Do not represent this seed as a completed implementation
or as an empty scaffold; qualification must record its actual passing checks.
