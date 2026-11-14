# A57: Account deletion

A57 makes account deletion erase every Codium and hosted record (invariant P5): tombstone first, then billing, then the
erase, with the cleanup cron retrying anything that fails, and the identity deleted only after the erase marker. It
wires in the erase functions earlier packages left for it: A31 (founding), A33 (reports), A34 (ballots and
nominations), A37 (push), A39/A40 (the relay's `erase`), A44 (the vault), A46-A50 (ops and the ops Worker), A51-A55
(the cloud computer, its ledger state, Done by Morning). No Stripe, OpenRouter, Cloudflare, Vercel, GitHub or Supabase
API was called, nothing was deployed or pushed. Readings of the contract are in `codium-deviations.md` under "A57
Account deletion (9 Nov 2026)".

An earlier attempt (6 November) left this work uncommitted in the tree; A56 kept it aside. It was read through, kept,
corrected and finished here.

## What changed

| Area | Files |
|---|---|
| Route | `api/account/delete.ts`: confirm the email, check identities can be deleted, set the tombstone, run the deletion with a 20 s erase budget, answer what happened or that deletion has started and will finish |
| Tombstone | `api/_lib/codium-tombstone.ts` (new): `tombstone:<account>`, `tombstones:due`, the per-account deletion lease, decode (times, count, stage, part ids only; anything else under the key fails closed) |
| Erase | `api/_lib/codium-erase.ts` (new): `finishAccountDeletion`, `checkAccountDeletion` (the follow-up pass), `drainAccountDeletions` (the cron), `ERASE_PARTS`, `eraseAccountKeys` (the last sweep), `registerErasePart` (for A59), the owner alert |
| Cron | `api/account/deletions.ts` (new, `GET`, `CRON_SECRET`), `vercel.json` (every 10 minutes) |
| Plan cache | `api/_lib/model-plan-account.ts`: reconcile reads the tombstone (marks the record closing, writes the closing snapshot, writes nothing once the record is erased); `readEntitlement` answers closing for an erased account; checkout and plan change refuse with 409 `MODEL_PLAN_ACCOUNT_CLOSING` |
| Outbox | `api/_lib/codium-provision.ts`: `forgetAccountOutbox` (waiting items, dead letters and applied versions naming the account) |
| Keys | `api/_lib/codium-keys.ts`: `codiumKeyRoot()`, so the sweep's SCAN covers both modes without spelling a key |
| Ops | `api/_lib/ops-worker.ts` (`opsErasable`: the Worker's `erase` works with `VECTOR_OPS_ENABLED` off), `api/_lib/ops-cleanup.ts` |
| Docs | `docs/vector/MODEL-PLANS.md` ("Account deletion"), `docs/vector/owner-actions/brain-vault.md`, `codium-deviations.md` |
| Tests | `test/account-delete.test.ts` (extended), `test/account-delete-api.test.ts` (fake answers SCAN/ZSCAN), `packages/web/test/codium-configuration.test.ts` (the cron), `packages/web/test/fixture/codium-fakes.ts` (SCAN glob) |

Edits to `api/_lib/model-plan-*.ts`: `model-plan-account.ts` only (listed above and in the commit body).

## How it works

`POST /api/account/delete` (unchanged entry: website session or the desktop's ten-minute deletion grant, the typed
email, 5 an hour) first checks the confirmation and the Supabase admin settings, so a wrong email or an unconfigured
deployment changes nothing. Then, with a store configured, it sets the tombstone (`SET NX`; a retry keeps the first
time) and files the deletion as due 5 minutes later, so the cron picks it up if this request never finishes.

`finishAccountDeletion` takes the account's deletion lease (one run at a time: the request, a retry, or the cron) and
runs, skipping what an earlier pass finished:

1. **Revoke** the CLI and desktop tokens (`revokeAccountTokens`). Without a revocation store it reports that tokens
   expire within 90 days, as before.
2. **Close**: reconcile under the tombstone marks the billing record closing and writes the `ended`/`closing` snapshot
   with no Stripe call; the key is disabled. Every service that reads the snapshot now refuses new work, and its
   provisioners get their `closing` transition.
3. **Billing**: `cancelModelPlanAccount` expires open checkouts, cancels subscriptions and disables the key.
4. **Erase**, part by part (`eraseParts()`), each idempotent: `reports`, `roadmap`, `founding`, `push`, `remote` (the
   relay's `erase`, while its address and secret are set), `vault` (wrapped key first; objects as far as 5 s allows, the
   rest by the vault cleanup), `overnight` (jobs, recurring jobs, recordings), `computer` (sessions ended, computers and
   saved disks deleted at the provider, the ledger's store state; needs `overnight`), `ops` (the Worker's data, settings,
   incidents, Release Guard records, cards and images, health, the crons' rosters), then any registered part, then
   `codium` (the account's own records and outbox items; needs every part above) and `keys` (every other key naming the
   account; needs `codium`). A part not configured on this deployment is skipped (it can hold nothing). A failed part
   stops only the parts that need it. Parts not started within the request's 20 s are left for the cron.
5. The **erase marker** (`erasedAt` in the tombstone), then the usage counts, then the **identity**.

Anything that fails records the stage and the failed part ids in the tombstone, files the deletion as due again (10
minutes, doubling to 6 hours) and answers an error that says deletion has started and Vector keeps trying. After six
failed passes the owner gets one email (deduped for 6 hours) with the account id and the part names, never an email
address or an error message. Once the identity is gone, the cron's follow-up pass 15 minutes later runs every erase part
again and finishes the deletion: off the due list, the tombstone kept 180 days.

What stays, on purpose: the hosted ledger's lines (an HMAC of the account), the pool debits and the spend counters keyed
by the pool's hash (all expire with their period), the run-token revocation mark (35 days), the billing lease while a
reconcile holds it, the disabled OpenRouter keys, Stripe's records, and the tombstone.

## Tests

Run here, one file at a time:

- `test/account-delete.test.ts`: 27 pass, 1 skipped (the real-Valkey case). Covers the tombstone (set once, fail
  closed, no email in it), checkout refused before any Stripe call, plan change and every perk refused, reconcile closing
  without Stripe and never writing back, the step order, a failed part keeping the identity while other parts still run,
  each earlier step failing and a retry finishing, the lease, the deadline, the backoff and the owner email, the sweep
  (erases meters, estimates, the no-run counter and the status cache; keeps the tombstone, both leases, debits, the
  revocation mark, another account whose id starts with this one, keys outside the prefix, pool counters and, on a test
  server, live records; stops at its deadline), a registered part, and P5 end to end: every service seeded, deleted
  through the route, nothing left but the kept keys, each of which expires, and a late Stripe notification writing
  nothing back; the Worker-outage retry (pending answer, tombstone kept, identity kept, cron retries until the Worker is
  back); the follow-up pass erasing a record written after the erase; the outbox left with no item for the account.
- `test/account-delete-api.test.ts`: 8 pass (unchanged expectations).
- `packages/web/test/account-delete-body.test.ts`: 3 pass. `packages/web/test/codium-configuration.test.ts`: 11 pass.
- Because shared code changed: `test/ops-payment-pipeline.test.ts` 10 pass, `test/codium-billing.test.ts` 52 pass
  (2 skipped, Valkey), `test/codium-mode.test.ts -t "spelled out"` 1 pass, `test/api-module-loading.test.ts` 1 pass.

Typecheck: root `tsconfig.json` (api) with `tsgo --noEmit`, clean; `packages/web` `astro check`, 206 files, 0 errors.
No generator input changed, so no generator ran.

CI only: the real-Valkey case at the end of `test/account-delete.test.ts` (the sweep's SCAN MATCH glob, its escaping
and the whole-word filter on a real store), and every other test file whose code paths A57 touched (the billing,
plan-change, hosted and ops suites). Never exercised anywhere: real Supabase identity deletion, the relay's and the ops
Worker's `erase` on Cloudflare, the vault on a real Supabase and R2, a provider deleting real computers, and a SCAN over
a production-sized store.

## For later packages

- **A59:** register Codex's repository bindings and run records with `registerErasePart({id: "cloud-agents", configured,
  erase})` (in `api/_lib/codium-erase.ts`), so deletion waits for them and retries them. `cloudAgentAllowance` should
  answer `closing` for a closing snapshot and for an erased account: `readEntitlement` returns the closing snapshot in
  both cases, and `requireAccountOpen` in `codium-tombstone.ts` reads the tombstone directly.
- **A60 / the legal read:** the privacy draft's `#codium-deletion` matches what is erased and kept. Two details for it:
  counters keyed by the account id are now erased at deletion, sooner than the draft's "until 40 days after the billing
  period ends" (still true as an upper bound); and the tombstone (times, a pass count and part names, keyed by the
  account id) is kept 180 days after a deletion, which the draft does not mention. The owner's stuck-deletion email
  names the account id.
- **Owner:** nothing to set. The cron uses `CRON_SECRET`; Vercel runs crons on Production only, so a Preview's stuck
  deletions finish only when the route is called there.

## Not done

- Codex's records (bindings, run records) are not erased until A59 registers its part.
- No screen change: the website and the desktop already show the server's message, which now says deletion has started
  when a step is pending.
- `bun.lock` was not touched. Nothing was pushed or deployed.

**Status, 9 Nov 2026 (P8 review).** The sections above describe their own day. P8's review (`codium-p8-repairs.md`)
found that the `computer` part left the sessions' packed files (`hosted/<mode>/<hash>/<session>/files.tar.gz`) to the
bucket's 2-day rule. `eraseAccountHosted` now deletes them first (`eraseSessionArchives`) and a bucket refusal keeps the
deletion pending; `test/account-delete.test.ts` covers it.
