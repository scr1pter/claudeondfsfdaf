# Production checks: the ops Worker

On Call and Release Guard (Max and Ultra) run their checks on a Worker Vector runs on Cloudflare, `vector-ops`. This page covers that Worker (Codium build WP A46). The GitHub webhook router, domain verification and monitors (A47), Release Guard's revert PRs and the incidents route the Worker reports to (A48), Ship Desk (A49), and the ops screens and crons (A50) add their own sections when they are built. How the Worker works is in [MODEL-PLANS.md](../MODEL-PLANS.md#phone-alerts-and-shared-service-plumbing). Nothing on this page has been created, deployed or tried against Cloudflare yet.

`on-call` and `release-guard` are listed (`CODIUM_LISTED_PERKS`) only once the GitHub App is registered with Deployments: read and its webhook, this Worker is deployed, and, for On Call, phone alerts are listed (contract §1.2). Since A47 the API sends the Worker each account's verified domains and On Call URLs, production releases to watch and the `ops` switch; the plan itself (`plan`) and the reports' intake come with A48 and A50, so nothing is checked before then.

## What the Worker holds

Each account has its own Durable Object, named by an HMAC of the account id under `ACCOUNT_KEY`. It holds:

- **What the plan allows**, as the API pushed it: how many URLs and domains, how often to check, how many releases a day and how long to watch, and until when (`validUntil`, the end of the paid period plus a day). After that time it checks nothing until the API pushes a newer plan, so a lost update stops checks by itself.
- **The verified domains and the On Call URLs.** Only those domains are ever checked, matched exactly.
- **State changes and hourly totals:** when each URL went up or down and why, and per hour how many checks passed, failed or said nothing. Not every check. Kept 30 days.
- **Release watches:** each production release's repository id, environment, commit, deployment id and outcome (kept 30 days), and the paths that passed on the last good release.
- **Reports not yet delivered** to the API, for at most a day.
- **The account id**, only to name the account in its reports.

Account deletion calls `erase`, which deletes everything that account's object holds (A57 wires this in).

## One-time setup (owner steps 11 and 12)

Run these from `packages/ops-worker`, signed in with `wrangler login` to the Cloudflare account that runs the Workers. Never put a key in this repository, a chat or a ticket.

1. **Workers Paid** with a Budget Alert and billable-usage notifications (the same account as the relay, contract §6.1).
2. **The kill-flag namespace:**

   ```sh
   bunx wrangler kv namespace create OPS_FLAGS
   ```

   Put the id it prints in `wrangler.jsonc` in place of the zeros, and commit that change. The id is not a secret.

3. **The shared secret.** The Worker checks the API's calls, and signs its reports to the API, with the same value as Vercel's `VECTOR_OPS_SHARED_SECRET` (at least 32 characters; make one with `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'` and set it in Vercel, Production only, if it is not set yet):

   ```sh
   bunx wrangler secret put INTERNAL_SECRET
   ```

4. **The account key,** a new random value made the same way. Keep it for good: changing it starts every account's checks over with nothing configured.

   ```sh
   bunx wrangler secret put ACCOUNT_KEY
   ```

5. **Where it reports.** `API_ORIGIN` in `wrangler.jsonc` is `https://vectordev.ai`; the Worker sends its reports to `/api/ops/worker` there. Change it only for a staging copy.
6. **Deploy** with the hosted deploy workflow (WP A58, `target=ops`), from protected main, once it exists. The Codium CI lane already runs `wrangler deploy --dry-run` and a smoke test of that bundle on Cloudflare's local runtime on every push.
7. **Tell the API where it is:** set `VECTOR_OPS_WORKER_URL` in Vercel to the Worker's https origin (`https://vector-ops.<your-subdomain>.workers.dev`, or a custom domain), and `VECTOR_OPS_ENABLED=true`. Without both (and `VECTOR_OPS_SHARED_SECRET`), adding domains, monitors and repositories answers 503 and nothing is sent to the Worker.

Without its two secrets the Worker answers the API's calls with 503 and checks nothing.

## Turning it off

- **Normally:** the `ops` switch on `/owner/codium`. It stops new settings and release watches in the API and copies itself to the Worker's kill flag (`flags`). If the answer says `worker: "failed"`, apply the switch again or set the flag directly as below.
- **Directly:**

  ```sh
  bunx wrangler kv key put --binding OPS_FLAGS --remote kill 1
  ```

  Every account reads the flag at each wake (at least every few minutes while it has work), stops checking, watching and reporting, and then reads it again every 10 minutes. If the flag cannot be read, the Worker acts as if it were set. To turn it back on, delete the key; checks resume within about 10 minutes:

  ```sh
  bunx wrangler kv key delete --binding OPS_FLAGS --remote kill
  ```

## The GitHub webhook and verified domains (A47)

The GitHub App's webhook feeds Release Guard and Ship Desk, and the App's removals clear their settings. One route takes every delivery, for Codium and for Vector's GitHub agent alike: `https://vectordev.ai/api/github/webhook`.

1. **The webhook secret.** Make a random value of at least 32 characters (`node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`) and set it both as the App's webhook secret and as `VECTOR_GITHUB_APP_WEBHOOK_SECRET` in Vercel (Production). Without it every delivery answers 503.
2. **The App's events.** Subscribe the App to `installation`, `installation_repositories`, `repository`, `pull_request` and `deployment_status`, with Deployments: read. Save the webhook only after this route is deployed. GitHub never resends a failed delivery by itself; a failed one can be redelivered from the App's Advanced settings, and a delivery already handled answers `duplicate` instead of running twice.
3. **The bot's name.** `VECTOR_GITHUB_APP_SLUG` must be the App's slug: Ship Desk only takes pull requests the App's own bot (`<slug>[bot]`) opened from a branch of the same repository.

What the API keeps per account (`ops:settings:<account>` in the store, under the Codium prefix): its domains with their verification tokens and times, its On Call URLs, and its Release Guard and Ship Desk repositories (environment, production URL, paths, the App installation). Account deletion erases them (A57 wires this in). A repository can be set up only while it is bound to the account through Vector's GitHub agent; until that integration ships (A59), none can.

Domains are verified by the account, not by the owner: a TXT record `_vector-verify.<domain>` with the value `vector-verify=<token>`, or that line in `https://<domain>/.well-known/vector-verify.txt` (no redirects). The API reads the TXT record through Cloudflare's DNS-over-HTTPS resolver. The daily job at 04:10 UTC (`/api/ops/domains`, `CRON_SECRET`) checks each verified domain again a week after its last success; a record that is gone ends the verification, and a check that cannot be read is retried daily for up to 14 days after the last success. The same job resends the Worker any change it missed.

## What it costs

Each account wakes only when a check or a watch round is due: at most every minute on Ultra and every 5 minutes on Max, plus every 30 s while a release is being watched, with checks and watch rounds that fall within 25 s of each other sharing one wake, and at most 125 wakes an hour. Each wake reads the kill flag once, writes one row of running state, looks hosts up at most every 5 minutes, and runs at most 6 checks at a time. These are the "ops checks" line in the contract's cost estimate (§1.4); the guard cron (A50) watches the bill against it.
