# A44: Vault API

A44 builds Brain Vault's server: the Vault API that A43's client (`packages/core/src/vault/remote.ts`) calls, its
Supabase tables, the `vault` provisioner, the daily cleanup and the status meter. It builds on A43 (the formats in
`@vectordevai/schema/vault`) and A37 (`r2-presign.ts`). No engine route, config schema or SDK input changed, so no
generator ran. No service was called: Supabase, R2, Resend and the store are fakes in the tests. Nothing was applied,
deployed or pushed.

## What changed

| Area | Files |
|---|---|
| Store | `api/_lib/vault-store.ts` (new): the Supabase RPC client, R2 links, reserve, commit with HEADs, list, read, forget, destroy, purge, cleanup, the provisioner's hold / release / lapse / erase, the read-only notice email |
| Rules | `api/_lib/vault-api.ts` (new): who may read and write (§4.4), request decoding |
| Routes | `api/vault/setup.ts`, `uploads.ts`, `commit.ts`, `snapshots.ts`, `snapshots/[id].ts`, `index.ts` (DELETE), `cleanup.ts` (new) |
| SQL | `docs/vector/owner-actions/sql/brain-vault.sql` (new): four tables with RLS, one invoker function, grants to `service_role` only |
| Meter | `api/_lib/vault-meter.ts` (new), imported by `api/model-plans/status.ts`: `meters.vault {usedBytes, quotaBytes}` |
| Provisioner | `api/_lib/codium-provisioners.ts`: `vault` replaces its stub |
| Listing | `api/_lib/codium-perks.ts`: `vault` readiness (`vaultConfigured()`) |
| Settings | `vercel.json` (cron `/api/vault/cleanup`, `40 3 * * *`), `.env.example` (`VECTOR_VAULT_ENABLED`, `VECTOR_VAULT_ACCOUNT_SALT`) |
| Schema | `packages/schema/src/vault.ts`: `VAULT_REQUEST_INVALID` and `VAULT_UNAVAILABLE` documented and listed |
| Docs | `docs/vector/owner-actions/brain-vault.md` (new), `docs/vector/MODEL-PLANS.md`, `codium-deviations.md` ("A44 Vault API") |
| Tests | `test/brain-vault-api.test.ts`, `test/brain-vault-fixture.ts` (new); one expectation in `packages/web/test/codium-configuration.test.ts` |

## Edits to `api/_lib/model-plan-*.ts`

None.

## How it works

- **Records** are in Supabase behind `public.vector_brain_vault(jsonb)` (security invoker, `service_role` only). A vault
  row holds the wrapped key, the vault id, the plan's version days, the hold flag and the notice dates. Versions, the
  objects each version names, and blobs (objects and manifests, each `pending`, `stored`, `trash` or `claimed`) are
  their own tables. Accounts are `HMAC-SHA-256(VECTOR_VAULT_ACCOUNT_SALT, "vector-vault-account-v1:" + id)`; rows carry
  the Stripe mode. Times come from the server in each request.
- **Bytes** are in R2 `vector-vault` at `<mode>/<account>/<vault>/objects/<id>` and `.../versions/<version>`. The server
  signs links (900 seconds) and HEADs and DELETEs objects; it never reads one.
- **Reserve** (`POST /api/vault/uploads`): one transaction that locks the vault's row checks the version (not committed,
  at most 4 in progress, at most 60 committed), refuses if any object is mid-deletion (503) or pending with another size
  (409), then reserves every new object (and the manifest) against the quota, the 2 million object cap and the 1 million
  per version cap, all or nothing (402 `VAULT_QUOTA`). Only then are PUTs signed, each carrying its exact size and
  `application/octet-stream`.
- **Commit** (`POST /api/vault/commit`): HEADs the version's pending objects and its manifest, 32 at a time, up to 2000
  per round, within 40 seconds. Whole ones become stored at once. A missing or resized one is queued and deleted, and
  the answer is 409 `VAULT_SIZE_MISMATCH`. When nothing is pending, the version commits with its bytes and count. A
  replayed commit answers the same snapshot.
- **Deletion** never deletes from R2 inside a transaction. Forget, destroy, the cleanup and account deletion move blobs
  to `trash` (no longer counted against the quota). `purgeVaults` claims a batch, DELETEs them from R2 and removes the
  rows it deleted. A claim older than 10 minutes is claimed again. A blob being deleted cannot be reserved again until
  its row is gone. Destroy removes the wrapped key in the same statement that marks the vault deleting.
- **Provisioner** (`vault`, configured while the store is): frozen → held; active, renewing and paused → released;
  ended or none → one emailed notice, then `notice_at` and `delete_at = notice + 30 days`; closing → erased at once.
- **Cleanup** (`GET /api/vault/cleanup`, `CRON_SECRET`), 50 vaults per call, each locked while cleaned: a lapsed vault
  (notice recorded, date passed, not held) is destroyed. Versions and uploads that never committed are swept an hour
  after their last request. Unless held, versions older than the version days are pruned (newest kept) and objects no
  version names are collected. Then queued blobs are purged within the 50-second budget. It answers counts only.

## Plan rules (§4.4's Brain Vault row)

| | create, reserve, commit | read, download | forget, delete vault |
|---|---|---|---|
| not listed (`CODIUM_LISTED_PERKS`, switch, `VECTOR_VAULT_ENABLED`, store, email) | 503 `VAULT_UNAVAILABLE`, before the sign-in | yes | yes |
| active, renewing within grace (Pro, Max, Ultra) | yes, up to the quota | yes | yes |
| Plus | 403 `CODIUM_PERK_REQUIRED {perk: "vault", plan: "vector-50"}` | yes | yes |
| paused, ended, frozen | 409 `VAULT_READ_ONLY {state}` | yes | yes |
| renewing past grace | 503 `MODEL_PLAN_RENEWING` | yes | yes |
| no plan | 402 `MODEL_PLAN_REQUIRED` | yes (404 without a vault) | yes |
| account closing | 409 `MODEL_PLAN_ACCOUNT_CLOSING` | 409 | 409 |
| run token, no token, revoked | 401 | 401 | 401 |

## Tests run here (one file at a time)

| Package | File | Result |
|---|---|---|
| root | `test/brain-vault-api.test.ts` (new; the contract's file) | 20 pass |
| root | `test/codium-outbox.test.ts` (unchanged; provisioner list, `vault` unconfigured without the store) | 18 pass, 2 skip (Valkey, CI) |
| root | `test/api-module-loading.test.ts`, `test/codium-mode.test.ts`, `test/no-topups.test.ts`, `test/no-project-wording.test.ts`, `test/codium-replay.test.ts` (unchanged) | 1, 18, 4, 2, 27 (+2 skip) pass |
| web | `test/codium-configuration.test.ts` (the cron expectation) | 11 pass |
| web | `test/model-plan-status-api.test.ts`, `test/codium-public.test.ts` (unchanged) | 22, 13 pass |
| core | `test/vault/remote.test.ts` (unchanged) | 2 pass |

`test/brain-vault-api.test.ts` covers:
- **The store:** the SQL's grants (invoker, empty search path, RLS on all four tables, only `service_role`); sizes
  equal the vault format's; no account id in the RPCs or R2 keys; a live server never reads a test vault; readiness.
- **Who may write:** every reason Vault is not listed answers 503 to writes before any sign-in, while reads still work;
  S3 at all nine route and method pairs (no token, `vrt_`, `vht_`, malformed, revoked); Plus, no plan, renewing within
  and past the grace, closing; paused, ended and frozen read-only with restore and downloads still served.
- **Quota is a server gate:** a request that does not fit is refused whole (no reservation, no version, no link, no
  storage request); the link signs the exact size and expires; invalid bodies; **20 parallel reservations** over a vault
  10 objects short of its quota grant exactly 10, and the same objects declared 20 times at once are reserved once;
  only missing objects are signed; the commit HEADs only what was not confirmed; the 4-backup cap.
- **Commit:** a resized object and a missing one are deleted and refused, a count mismatch is refused, the rerun
  commits, a replay answers the same snapshot, and storage being down deletes nothing.
- **The A43 client end to end** (`VaultBackup` + `VaultRemote.store` against these routes and the fake R2): create,
  two backups with dedupe, restore on "another computer" with the recovery code, forget, destroy, with the wrapped key
  gone before any object is deleted.
- **Deletion and cleanup:** forgetting frees quota at once and deletes only unshared objects; deleting the vault while
  storage is down hides it at once and the cleanup deletes the objects later; pruning past 30 days with the newest kept;
  uncommitted uploads swept after an hour; a held vault keeps everything; the ended-plan notice (email failure leaves no
  notice, one email, no amount, a new plan clears it, deletion only after the date); account deletion erases first.
- **Status meter:** `meters.vault` bytes against the quota (Max 25 GB), registered by the status route.

Typecheck: root `tsconfig.json` (api) clean; `packages/schema` clean; `packages/web` (`astro check`) 0 errors. The two
new test files are outside every typecheck config; they were also checked once with a scratch config (node and Bun
types) and are clean.

## CI only

- **The real SQL.** With `VECTOR_TEST_POSTGRES_URL` set (the Codium lane sets it), `test/brain-vault-api.test.ts` runs
  every case against `brain-vault.sql` on the disposable Postgres, as `service_role`, instead of the in-memory
  emulation. That is the only check of the SQL itself and of the 20 parallel reservations under real row locks. This Mac
  has no Postgres, so it has not run anywhere yet.
- **Never exercised anywhere:** a real R2 bucket accepting the signed PUT, HEAD and DELETE (the signer is checked against
  AWS's published example in A37's `test/r2-presign.test.ts`, and the fake bucket checks each signature), a real
  Supabase project, and a real Resend send.

## For later packages

- **A45:** the desktop uses `VaultRemote.store` against these routes as the CLI does. Settings can read
  `meters.vault` from status, or `usage` from `GET /api/vault/snapshots`.
- **A57:** call `eraseAccountVault(account)` (api/_lib/vault-store.ts) from account deletion, or rely on the `vault`
  provisioner, which erases on `closing`. The cleanup finishes any objects a request could not delete.
- **A60 / legal read:** the privacy draft's `#vault` should match what is stored: the account named by a keyed hash,
  the wrapped key, version and object ids, sizes and times, the read-only notice by email, deletion 30 days after it,
  and that a dispute holds the vault.
- **Owner:** apply `brain-vault.sql`, create the bucket with no lifecycle rule, set the salt once
  (`docs/vector/owner-actions/brain-vault.md`), then list `vault` after the legal read.

## Not done

- The desktop backup and Settings → Memory → Backup (A45); account deletion's erase marker (A57); listing (A60).
- An active account that downgrades to Plus keeps its stored vault with no deletion date; recorded as an open point in
  the deviations.
- bun.lock was not touched. Nothing was pushed or deployed.
