# The cloud computer

A computer Vector hosts for Max and Ultra subscribers (working name; the product name follows the computer-use brand).
Its core, the ledger that holds and charges its time in the subscriber's Codium pool, is Codium build WP A51, and
the provider adapter that starts and stops the computers is WP A52. Sessions and crons (A53), the image (A54) and Done
by Morning (A55) have their sections below; the desktop and phone (A56) add theirs. How it works is in
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
   API runs. `vercel.json` sends every path on that host except the computers' own routes (the session heartbeat,
   chat, `/models`, estimate) to the website (WP A53).
4. **The snapshot.** Run the image workflow (WP A54/A58) and set `VECTOR_HOSTED_BASE_SNAPSHOT` to the snapshot id it
   prints. The sandbox the bake runs in must not carry the `vector-mode` tag, or the reconciler would treat it as a
   computer.
5. **Switch it on.** Set `VECTOR_HOSTED_PROVIDER=vercel` in Production and redeploy. Computers still start only for
   `VECTOR_HOSTED_ALLOW_ACCOUNTS` until `computer` is listed.
6. **Previews.** A preview testing in Stripe test mode should use its own Vercel project (or its own salt), and may set
   `VECTOR_HOSTED_RUN_HOST` to the preview's own API host. Production ignores that setting. Computers are tagged with
   the mode, and a server never touches the other mode's computers.

## Sessions, the reaper and the nightly job (WP A53)

A session is one job on one computer. It starts from the desktop, the CLI or the phone (`POST /api/hosted/sessions`),
holds its first 15-minute block of time, starts the computer with a run token that lives about one block, and runs the
boot step on it: `/opt/vector/boot.sh --run-host hosted-run.vectordev.ai --session <id>`, with no credential. The
computer's daemon then reports every 30 seconds through the run-API host, and its first answer carries the job.

**What runs on its own** (all with `CRON_SECRET`, already in `vercel.json`):
- `/api/hosted/reaper`, every minute: settles the ledger's queue, holds each running session's next block 3 minutes
  before the current one ends (or wraps the session up within 5 minutes when it cannot), stops sessions that are idle
  for 10 minutes, whose computer stopped reporting for 3 minutes, whose job's deadline passed, whose plan no longer
  allows them, or that passed a fair-use limit (§4.2), gives control back after a 30-minute take-over, runs the orphan
  reconciler and the pool's unapplied debits.
- `/api/hosted/drift`, every 10 minutes: emails you when an account's sessions ran longer this period than the ledger
  charged (accounts and minutes only). Nothing is changed automatically; check the settle queue and the reaper's runs.
- `/api/hosted/nightly`, 02:30 UTC: deletes disks whose retention ran out, charges each computer's day of storage (at
  the worst-case disk size, 16 GB, while the plan is live) and its egress, lowers the block charges of ended sessions
  towards the provider's actual cost plus 10% (never below it), and caches the figures the budget answer reads.

**Fair use.** A session that passes 600 page loads an hour, 5 GB (Max) or 15 GB (Ultra) of egress a day, or 30 minutes
above 80% of the processor with no model request is stopped, the account's cloud computer is put on hold and you get an
email. Release it from the owner's hosted flags once you have looked.

### One-time setup

Never put a key in this repository, a chat or a ticket. Set these in Production (and, with their own values, in the
Preview environment that tests in Stripe test mode):

1. **Run-token key.** `VECTOR_HOSTED_RUN_SIGNING_KEY`, at least 32 random characters:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. It signs each session's run token
   and the 24-hour download links. Changing it ends every running session's model access at its next request.
2. **Viewer key.** `VECTOR_HOSTED_VIEWER_SIGNING_KEY`, an Ed25519 private key as base64url PKCS#8 DER:
   `node -e "const {generateKeyPairSync}=require('crypto');console.log(generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'}).toString('base64url'))"`.
   The computers get its public half from each heartbeat answer, so nothing is baked into the image.
3. **Budget read secret.** `VECTOR_HOSTED_BUDGET_READ_SECRET`, at least 32 random characters, also stored in the
   `hosted-production` GitHub environment for the budget workflow (WP A56). It reads only
   `GET /api/hosted/admin/budget?cycleEnd=<ms>`, the hosted team's worst case for the rest of the billing cycle.
4. **Files for download.** Session downloads use the `vector-media` bucket (`VECTOR_R2_MEDIA_*`). Add a lifecycle rule
   that deletes objects under `hosted/` after 2 days (the links last 24 hours), and keep it away from `playbooks/`.
5. **Listing.** `computer` is ready to list once the provider, the ledger and both keys are set. List it only after the
   computer-use build, the brand name and the outside security review of isolation and the viewer (contract §1.2),
   starting with `VECTOR_HOSTED_ALLOW_ACCOUNTS` set to your own account.

### The owner's hosted flags

`/api/hosted/admin/flags` (your Google session; changes need a sign-in under 10 minutes old): `GET` shows the `hosted`
switch and the accounts on hold; `POST {action}` with `drain` (no new sessions), `stop` (every session stops within a
minute), `resume`, `suspend {account, reason?}` or `release {account}`. The same switch is on the owner page, and the
hosted team's spend webhook moves it to `no-new` at 75% and `stop` at 100% by itself.

## The image (WP A54)

The computer's software lives in `packages/hosted-computer`. Nothing here has been built, pushed or baked yet.

**What it is.** An Alpine image pinned by digest (`image/Dockerfile`, the same base as the Vector CLI container) with
Chromium, a virtual display, a VNC server, ffmpeg, xdotool, git, nftables, Node and the Vector CLI. Each session Vector
runs `/opt/vector/boot.sh` as root. It reinstalls the computer's own programs from an archive whose digest the image
build stamped into it, loads the firewall (out: port 443, DNS to the resolver, loopback; in: the viewer port), mounts the
agent's 10 GB disk, and starts the display, the viewer proxy and hostd. If any of that fails it stops, the computer never
reports, and Vector stops it within minutes. The agent runs as its own user with no sudo; the browser runs as another
with its own sandbox on, its profile wiped after every job; only the viewer proxy listens on the network, and it needs a
single-use viewer token for that session.

**Building and baking (owner step 14, after Vercel's written OK).** The image workflow,
`.github/workflows/vector-hosted-image.yml` (WP A58), does this. Before the first run, in the `hosted-production`
environment (the one with you as required reviewer), set the secret `VECTOR_HOSTED_VERCEL_TOKEN` (a token for the hosted
team, never the main team's) and the variables `VECTOR_HOSTED_VERCEL_TEAM_ID`, `VECTOR_HOSTED_VERCEL_PROJECT_ID` and
`VECTOR_HOSTED_IMAGE_REPOSITORY` (the image's name in the hosted team's container registry, in the form
`vcr.vercel.com/<team>/<project>/<name>`). Set the environment's deployment branches to protected branches only, and
protect `main`. Then run it from Actions on `main` with:

- `generation`: a whole number, higher than every earlier run's. A generation already in the registry is refused, so a
  run that failed after its push needs the next number.
- `min_disk_generation` (default 1): the oldest disk generation this image accepts. Raise it only when a change makes
  older disks unsafe, because computers with older disks then stop booting.
- `cli_version`: an exact Vector CLI release already published (for example `1.99.120`). Its Linux musl x86-64 build is
  taken from Vector's download store (the `VECTOR_CLI_BLOB_ORIGIN` variable the CLI release uses), checked against the
  release's manifest, and its source must be on `main`.

What it does: a preflight job with no secret checks the environment's reviewer and branch rule, `main`'s protection,
that the commit is on `main`, and the inputs. The image job waits for your approval, then:

1. `bun run build` in `packages/hosted-computer` (hostd and the viewer proxy, for Node), and the CLI at
   `packages/hosted-computer/bin/vector`.
2. `docker build --platform linux/amd64 --file image/Dockerfile` with both generations, then boots the image in Docker
   and runs `test/image.test.ts` inside it, the same checks CI runs. Nothing is pushed if one fails.
3. Signs Docker in to the registry with the Vercel CLI (`vercel vcr login docker`, the version the budget workflow
   pins), pushes the image as `<repository>:g<generation>` and reads back its digest. The sign-in is deleted when the
   step ends.
4. `bun script/bake-snapshot.ts --image <repository>@sha256:<digest> --generation <n>`: one sandbox with no network,
   the image checked there (at most 6 GB, no setuid file, no sudo), stopped, and `VECTOR_HOSTED_BASE_SNAPSHOT=<id>`
   printed in the log and the run's summary.

Then set `VECTOR_HOSTED_BASE_SNAPSHOT` in Vercel. New computers start from it. Computers that already have a disk keep
their own programs until their disk is made again (after its retention lapses, or when you delete it).

Not yet tried anywhere: the Vercel CLI's `vcr login docker` at that version and the registry's answers. If the sign-in
step fails, the pinned version may predate the command: raise `VERCEL_CLI_VERSION` in
`packages/cloud/src/hosted-budget.ts`, which both workflows use.

**The real-microVM check.** Before listing `computer`, run `vector-codium-e2e.yml` with `hosted: true`. It boots a
throwaway computer from the snapshot on the hosted test team and checks the firewall, the agent's egress, the disk and
Chromium's sandbox from inside, then stops it. It needs `CODIUM_E2E_HOSTED_VERCEL_TOKEN`,
`CODIUM_E2E_HOSTED_VERCEL_TEAM_ID`, `CODIUM_E2E_HOSTED_VERCEL_PROJECT_ID` and `CODIUM_E2E_HOSTED_SNAPSHOT` in the
`codium-test` environment. Three things only this check can show: that the provider's kernel loads the firewall and the
loop-mounted disk, that the provider still controls the computer after the firewall is up, and that Chromium's sandbox
starts. If any fails, the image needs a change before anyone can use a cloud computer.

**What it still needs from later packages.** The agent's side: Vector's CLI sending Codium requests through the run-API
host and driving the computer through hostd's socket (the computer-use build). GitHub tokens for git: hostd asks
`/api/hosted/sessions/<id>/git-token`, which no package has built yet, so git steps fail until it exists. Uploading
recordings is Done by Morning's (A55, below). Showing the hand-over reason and the live view (A56).

## Done by Morning (WP A55)

Jobs queued before bed with success criteria, each run as one session on the subscriber's cloud computer, ending with a
report that a model from another lab checked against each criterion. How it works is in
[MODEL-PLANS.md](../MODEL-PLANS.md#the-cloud-computers-ledger). Nothing here has been tried against a real computer,
bucket or phone yet.

### One-time setup

1. **Recordings.** A job's screen recording (its last ten one-minute segments) goes to the `vector-media` bucket under
   `recordings/<live|test>/…`. Add a lifecycle rule that deletes objects under `recordings/` after 31 days. Vector stops
   giving links to them after 30 days by itself; the rule is what deletes them. Keep the rule away from `playbooks/`, and
   keep the 2-day `hosted/` rule away from `recordings/`.
2. **Listing.** `overnight` is ready to list once everything `computer` needs is set and the media bucket is configured.
   It is listed only together with `computer` (it requires it), so list both after the same checks (contract §1.2).
   Before that, `VECTOR_HOSTED_ALLOW_ACCOUNTS` lets your own account queue jobs.
3. **Phone alerts.** Done by Morning sends a title-only alert (tag `overnight`) when a job is ready, did not finish or
   could not start in time, while phone alerts are configured and the plan allows them. Nothing to set beyond the alerts'
   own setup.

### What it needs from later work

- **Judges.** A report is checked by one of the plan's Second opinion judges from a lab the job's own requests did not
  use. Until A60 accepts the judges' routes no judge is served, so reports stand unjudged and say so.
- **Pull requests.** The computer cannot push yet: hostd's `/api/hosted/sessions/<id>/git-token` is still not built, so a
  job that changes a repository cannot leave a pull request. Approve works for any pull request a report names.
- **The agent's side.** Vector's CLI on the computer must send the report itself (the job's prompt says how). That is the
  computer-use build's.

## The clients and the budget workflow (WP A56)

The desktop's composer has "Run on my cloud computer", with the most the job can use of the month shown first (a band,
never an amount). While a session runs, a purple-edged bar above the composer says "Vector is using its cloud
computer" and offers Watch, Take over, Give back, Files and Stop; the live view opens in its own sandboxed window that
loads nothing but the computer's own viewer page. The phone's Cloud computer page shows the same, plus Done by
Morning's jobs and reports. When the computer's credential guard hands the computer to the subscriber, the session list
says so and their phone gets one title-only alert ("Vector needs you on its cloud computer", tag `computer`). None of
this shows until `computer` is listed (or for `VECTOR_HOSTED_ALLOW_ACCOUNTS`), and Vector Local blocks it.

### The budget workflow

`.github/workflows/vector-hosted-budget.yml` keeps the `vector-hosted` team's Spend Management budget above what its
subscribers could spend: once a day (06:17 UTC) and whenever you dispatch it, it sets
max(current budget, spend this cycle + 1.3 × Vector's worst case for the rest of the cycle). The worst case is
`GET /api/hosted/admin/budget?cycleEnd=<ms>`: every Max and Ultra account's cloud computer hours left, the full hours of
every period that starts before the cycle ends, and every computer's disk, at the provider's worst-case rates. It never
lowers the budget (lower it yourself if you want to), never sets more than your ceiling, never turns on pausing and never
changes the spend webhook. Its log says only raised, unchanged, capped or failed, because this repository's Actions logs
are public. A capped or failed run fails, so you see it; a failure changes nothing.

Setup (only after the hosted team, its budget and its spend webhook exist, step 1 of "The provider"):

1. **The environment.** The `hosted-production` GitHub environment, with you as required reviewer (contract §6.1). The
   workflow refuses to run without a required reviewer, so each daily run waits for your approval in GitHub: that click
   is when you look before the budget goes up.
2. **The token.** In the hosted team, a member with the Billing role (or you as Owner) creates an access token scoped to
   the `vector-hosted` team only. Store it as the environment secret `VECTOR_HOSTED_BUDGET_VERCEL_TOKEN`. Never use a
   main-team token.
3. **The read secret.** Store the same value as Vercel's `VECTOR_HOSTED_BUDGET_READ_SECRET` (step 3 of "Sessions, the
   reaper and the nightly job") as the environment secret of that name.
4. **The variables.** Environment (or repository) variables: `VECTOR_HOSTED_VERCEL_TEAM_ID` (the hosted team's
   `team_…` id), `VECTOR_HOSTED_BILLING_DAY` (the day of the month the hosted team's billing cycle starts, 1 to 28; see
   the team's billing page) and `VECTOR_HOSTED_BUDGET_MAX_USD` (the most this workflow may ever set, in whole dollars).
5. **Try it.** Dispatch the workflow once from the default branch with `VECTOR_HOSTED_BUDGET_AUTOMATION` unset: it is
   skipped. Then set the repository variable `VECTOR_HOSTED_BUDGET_AUTOMATION=true`, dispatch it again, approve the run
   and check the team's budget page. The workflow runs the Vercel CLI `vercel@65.3.1` (`VERCEL_CLI_VERSION` in
   `packages/cloud/src/hosted-budget.ts`) and reads `vercel billing budgets inspect --json` (or the older
   `vercel budgets` form). The JSON field names are read leniently because Vercel documents only the table's columns; if
   the first run says the answer could not be read, nothing changed: tell Claude what fields the CLI printed (not their
   values) and the reader is adjusted.

Turning it off: unset `VECTOR_HOSTED_BUDGET_AUTOMATION`. The spend webhook still drains new sessions at 75% and stops
them at 100%, whatever the budget is.
