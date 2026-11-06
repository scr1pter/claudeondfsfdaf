# The cloud computer

A computer Vector hosts for Max and Ultra subscribers (working name; the product name follows the computer-use brand).
Its core, the ledger that holds and charges its time in the subscriber's Codium pool, is Codium build WP A51, and
the provider adapter that starts and stops the computers is WP A52 (this page so far). Sessions and crons (A53), the
image (A54), Done by Morning (A55) and the desktop and phone (A56) add their own sections. How it works is in
[MODEL-PLANS.md](../MODEL-PLANS.md#the-cloud-computers-ledger). Nothing on this page has been created, applied or tried
against Supabase or Vercel yet.

The cloud computer is listed (`computer` in `CODIUM_LISTED_PERKS`) only after Vercel's written OK, the computer-use
build, the brand name and the security review of its isolation and viewer (contract §1.2). It never runs on GitHub
Actions.

## What the ledger stores

- **In Supabase** (`sql/hosted.sql`): one line per charge: a block of computer time (minutes, rounded up), minutes
  run past a block's hold, a day of snapshot storage or egress, or an ended plan's disk retention, with what it was
  charged, the provider's worst-case cost of the same units, a true-up if one lowered it, the period it was charged
  to and when it happened. Accounts are named only by an HMAC of the account id under `VECTOR_HOSTED_ACCOUNT_SALT`;
  no email or account id is stored.
- **Lines are kept.** They are the financial record of what each pool paid for, so account deletion does not delete
  them (contract P5). Once an account is deleted nothing links its HMAC back to a person.
- **In the Codium store** (Valkey), under the mode's prefix: each running block, blocks waiting to be settled, and the
  period's hours. They expire on their own and are erased with the account.

## One-time setup (owner steps 12 and 13)

Never put a key in this repository, a chat or a ticket.

1. **The table.** Review `docs/vector/owner-actions/sql/hosted.sql`, then run it once in the Supabase SQL editor of the
   project that holds Vector's accounts. It creates one table with row-level security and no access for `anon` or
   `authenticated`, and one function, `vector_hosted`, that only `service_role` may call (security invoker). The
   service role may insert and lower lines, never delete them. Running it again is safe, and is how later copies of
   the file (sessions, jobs) are applied.
2. **The account salt.** Make one and set `VECTOR_HOSTED_ACCOUNT_SALT` in Vercel (Production; another for Preview if
   you test there):

   ```sh
   node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
   ```

   Set it once and never change it: a new value starts every account's ledger afresh and names their computers
   differently. Without it, or without `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, no block of computer time opens.
3. **Egress, once Vercel answers** (owner step 14 asks what egress from a sandbox costs). Until then egress is charged
   at the highest data transfer rate Vercel publishes for iad1, plus 10%. When Vercel confirms its price, set
   `VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB` to that cost in whole micro-dollars per GB (0.15 USD is `150000`); the
   charge stays that cost plus 10%. An invalid value stops new cloud computer work until it is fixed.
4. **Trying it before listing.** Put your own account id in `VECTOR_HOSTED_ALLOW_ACCOUNTS` (comma separated). Those
   accounts may start a cloud computer before `computer` is listed; they still need a Max or Ultra plan and the
   `hosted` switch on.

## When Vercel changes its prices

`api/_lib/hosted-rates.ts` pins Vercel Sandbox's iad1 prices (Active CPU per vCPU-hour, memory per GB-hour, snapshot
storage per GB-month) with the date they were read. Every minute is charged at the worst case (all vCPUs busy) plus at
least 10%, so a lower price only widens the margin, which the nightly true-up hands back toward the actual cost. A
higher price must be changed in that file, and deployed, before it takes effect at Vercel.

## The provider (WP A52)

The computers run on Vercel Sandbox, in a Vercel team of their own, and only once Vercel says in writing that
subscribers may operate computers there (owner step 14). Until you set `VECTOR_HOSTED_PROVIDER`, no code can start,
list or stop one.

**What each computer is.** One persistent sandbox per computer, named `vh-<16 hex digits>-<n>` (an HMAC of the account
under `VECTOR_HOSTED_ACCOUNT_SALT`, never the account id) and tagged with the server's Stripe mode and its size. It
starts from your base snapshot the first time and from its own saved disk after that. Each session gets 2 vCPUs
(standard) or 4 (large), a timeout of the job's deadline plus 5 minutes, region iad1 with no failover (the rates are
iad1's), and one exposed port, the viewer's (6080). Its saved disk is kept for the plan's disk days (7 on Max, 30 on
Ultra), one copy only.

**What it can reach.** The public internet only. Vercel's proxy refuses every private, loopback, link-local, metadata,
multicast and reserved block (`HOSTED_DENIED_SUBNETS` in `api/_lib/hosted-provider.ts`), whatever name resolves to it.
The one credential is the session's `vht_` run token, which Vercel's proxy adds to requests for
`hosted-run.vectordev.ai` and nowhere else: it never exists inside the computer, and the computer's browser is barred
from that host.

**What stops a computer nobody pays for.** A computer starts only for a session whose 15-minute block of time is held.
Every few minutes the reconciler lists the running computers and stops each one whose session holds no block any more,
or all of them while the `hosted` switch is at `stop`, and emails you (at most every 6 hours) which ones it stopped.
Vercel's own timeout stops anything else at the job's deadline plus 5 minutes.

### One-time setup (owner steps 14 and 18)

Never put a token in this repository, a chat or a ticket. Do these only after Vercel's written OK.

1. **The team.** Create the Vercel team `vector-hosted` with one empty Vercel project, its Spend Management budget and
   the notify-only webhook to `/api/owner/spend-vercel` (set `VERCEL_HOSTED_TEAM_ID` and
   `VERCEL_SPEND_WEBHOOK_SECRET_HOSTED`, as the contract's §2 says). The provider refuses to run without that guard, and
   refuses the main team.
2. **The token.** Create an access token scoped to the `vector-hosted` team only and set `VECTOR_HOSTED_VERCEL_TOKEN`.
   Set `VECTOR_HOSTED_VERCEL_TEAM_ID` (the same id as `VERCEL_HOSTED_TEAM_ID`) and `VECTOR_HOSTED_VERCEL_PROJECT_ID`
   (the empty project). The server always passes these to Vercel itself; it never uses the main deployment's own
   credentials for a computer.
3. **The run-API host.** Add `hosted-run.vectordev.ai` as a domain of the main vectordev.ai Vercel project, where the
   API runs. WP A53 makes that host answer only the computers' own routes.
4. **The snapshot.** Run the image workflow (WP A54/A58) and set `VECTOR_HOSTED_BASE_SNAPSHOT` to the snapshot id it
   prints. The sandbox the bake runs in must not carry the `vector-mode` tag, or the reconciler would treat it as a
   computer.
5. **Switch it on.** Set `VECTOR_HOSTED_PROVIDER=vercel` in Production and redeploy. Computers still start only for
   `VECTOR_HOSTED_ALLOW_ACCOUNTS` until `computer` is listed.
6. **Previews.** A preview testing in Stripe test mode should use its own Vercel project (or its own salt), and may set
   `VECTOR_HOSTED_RUN_HOST` to the preview's own API host. Production ignores that setting. Computers are tagged with
   the mode, and a server never touches the other mode's computers.
