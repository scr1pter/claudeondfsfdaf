# Brain Vault on Vector

Brain Vault backs a person's Brain up end to end encrypted. Its core and `vector vault` are Codium build WP A43, the
Vault API is A44 (this page), and the desktop's nightly backup with Settings → Memory → Backup is A45. How it works is
in [MODEL-PLANS.md](../MODEL-PLANS.md#brain-vault). Nothing on this page has been created, applied or tried against
Supabase, Cloudflare or Resend yet.

Vault is listed (`vault` in `CODIUM_LISTED_PERKS`) only after the legal read and the privacy update (contract §1.2,
owner step 15): it is the first user data Vector stores, even though Vector cannot read it.

## What Vector stores

- **In Supabase** (`sql/brain-vault.sql`): for each vault, the vault key wrapped under the person's recovery code
  (useless without the code), the vault's random id, its version ids with their sizes and times, the ids of the
  encrypted objects each version names (keyed HMACs, never a plain hash of the content), and the objects' sizes.
  Accounts are named only by an HMAC of the account id under `VECTOR_VAULT_ACCOUNT_SALT`; no email or account id is
  stored.
- **In R2** (bucket `vector-vault`): the encrypted objects and manifests, at
  `<live|test>/<account HMAC>/<vault id>/objects/<id>` and `.../versions/<version id>`.
- **Nothing in plain text.** The vault key never leaves the person's computer except wrapped under the recovery code.
  A lost recovery code means a lost backup; Vector cannot open it.

## One-time setup (owner steps 11 to 13)

Never put a key in this repository, a chat or a ticket.

1. **The tables.** Review `docs/vector/owner-actions/sql/brain-vault.sql`, then run it once in the Supabase SQL editor
   of the project that holds Vector's accounts. It creates four tables with row-level security and no access for
   `anon` or `authenticated`, and one function, `vector_brain_vault`, that only `service_role` may call (security
   invoker). Running it again is safe.
2. **The bucket.** In Cloudflare R2, create `vector-vault` (or set `VECTOR_R2_VAULT_BUCKET`) and an API token scoped to
   that bucket alone with Object Read & Write. Give it **no lifecycle rule**: the API deletes what it no longer needs,
   and a rule would delete live backups. Set `VECTOR_R2_ACCOUNT_ID`, `VECTOR_R2_VAULT_ACCESS_KEY_ID` and
   `VECTOR_R2_VAULT_SECRET_ACCESS_KEY` in Vercel (Production; a separate token and bucket for Preview if you test
   there).
3. **The account salt.** Make one and set `VECTOR_VAULT_ACCOUNT_SALT` in Vercel:

   ```sh
   node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
   ```

   Set it once and never change it. A new value turns every vault into a new, empty one, and the old vaults can no
   longer be found, restored or deleted by account. Keep a copy where you keep the other production secrets.
4. **The service role and the email.** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already set for accounts.
   `RESEND_API_KEY` and `VECTOR_PURCHASE_EMAIL_FROM` send the read-only notice; without them Vault cannot be listed,
   because a vault is never deleted without that notice.
5. **Turn it on.** Set `VECTOR_VAULT_ENABLED=true` and redeploy. Vault is now ready to list, and the daily cleanup runs
   (`/api/vault/cleanup`, 03:40 UTC, in `vercel.json`). After the legal read, add `vault` to `CODIUM_LISTED_PERKS` and
   redeploy.

## Running it

- **The `vault` switch** (owner page) stops new backups within 30 seconds without a redeploy. Restores, forgetting a
  version and deleting a vault keep working, so nobody loses access to their data.
- **Quotas** are the plan's `vault.gb` in decimal gigabytes (Pro 10, Max 25, Ultra 50), checked before any upload is
  signed. A vault also holds at most 60 versions and 2 million objects, and four backups may run at once.
- **When a plan ends**, the vault turns read-only and the person gets one email naming the day it will be deleted, 30
  days later. A new plan before then keeps it. During a payment dispute or a fraud warning nothing is deleted, not even
  versions past their 30 days. Account deletion erases the vault at once (A57 wires the full deletion; the `vault`
  provisioner already erases it when an account closes).
- **The cleanup** answers counts only. A run that cannot finish in its minute leaves the rest for the next day. It
  cleans the server's own Stripe mode only: Vercel runs crons on Production, so a Preview's test vaults are cleaned
  only when you call it there yourself (`curl -H "Authorization: Bearer $CRON_SECRET" <preview>/api/vault/cleanup`).
- **Costs** are in the contract (§1.4, "R2 and recordings"); deletes are free.

## Not done here

- The desktop's backup and Settings → Memory → Backup (A45).
- Account deletion's full erase marker and retries (A57).
- The legal read, the privacy page's `#vault` paragraph, and listing `vault` (A60).
