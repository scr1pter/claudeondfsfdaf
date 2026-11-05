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
3. **The bot's name.** `VECTOR_GITHUB_APP_SLUG` must be the App's slug: Ship Desk only takes pull requests the App's own bot (`<slug>[bot]`) opened from a branch of the same repository, or that `github-actions[bot]` opened with the run marker of Vector's GitHub agent and a run record of the same account and repository (A49). Without the slug, Ship Desk takes nothing.

What the API keeps per account (`ops:settings:<account>` in the store, under the Codium prefix): its domains with their verification tokens and times, its On Call URLs, and its Release Guard and Ship Desk repositories (environment, production URL, paths, the App installation). Account deletion erases them (A57 wires this in). A repository can be set up only while it is bound to the account through Vector's GitHub agent; until that integration ships (A59), none can.

Domains are verified by the account, not by the owner: a TXT record `_vector-verify.<domain>` with the value `vector-verify=<token>`, or that line in `https://<domain>/.well-known/vector-verify.txt` (no redirects). The API reads the TXT record through Cloudflare's DNS-over-HTTPS resolver. The daily job at 04:10 UTC (`/api/ops/domains`, `CRON_SECRET`) checks each verified domain again a week after its last success; a record that is gone ends the verification, and a check that cannot be read is retried daily for up to 14 days after the last success. The same job resends the Worker any change it missed.

## Release Guard's revert pull requests (A48)

Release Guard writes to a repository only through the GitHub App, only to open one revert pull request, and never merges. The App needs no permission beyond the ones it already has: Contents: write, Pull requests: write, Metadata: read (plus Deployments: read for the webhook). It must not have Workflows permission: a release whose range touches `.github/workflows/` is never written to.

- **When it watches.** A production deployment that succeeded is watched only when the repository's `.vector/ops.json` at the deployed commit names the account's `opsId`, has `releaseGuard: true` and the same environment. The API reads it with a read-only token for that one repository (Contents and Metadata: read), revoked as soon as it is read. The plan's releases a day are counted after the dedupe, so GitHub's second success status or a redelivery never counts.
- **When it writes.** On a regression the Worker reports, the API mints a token for that one repository (Contents and Pull requests: write, Metadata: read), reads the range from the last good release, and reads `.vector/ops.json` again on the branch the pull request targets before each write. It opens GitHub's own revert (GraphQL `revertPullRequest`) when the range is exactly one merged pull request; otherwise a restore commit (the last good release's files) on a branch `vector/revert-<sha>` with a pull request, only while that branch's head is still the deployed commit. With a workflow file in the range, a moved branch, no opt-in, or the App not installed, nothing is written: the card offers "open in GitHub" and the host's rollback link instead. One pull request per repository, environment and commit, ever: a report sent again finds the one already opened.
- **The audit.** Every token is recorded before it is minted and again once revoked, under `ops:audit:<account>` in the store (90 days, 200 entries): purpose, repository, installation, what it wrote, whether the revoke worked. No token value is kept. `readGithubAudit(account)` in `api/_lib/github-app-server.ts` reads it for incident response. To stop all App writes at once, set `VECTOR_GITHUB_APP_ENABLED` to anything but `true` and redeploy, or suspend the App on GitHub.
- **The App runs only on production.** The App's settings are read only where `VERCEL_ENV` is `production` (as for the Actions exchange, [github-app.md](github-app.md)). A preview never watches or writes.
- **Incidents.** The Worker's reports reach `POST /api/ops/worker` (signed with `VECTOR_OPS_SHARED_SECRET`). On Call's failures and Release Guard's regressions become incidents (kept 90 days) and phone alerts with a title only. "Fix it" on an incident starts a run of Vector's GitHub agent in the person's own repository; it works once the integration commit (A59) registers the run starter, and never starts by itself.
- **The plan at the Worker.** The `ops` provisioner pushes each Max and Ultra account's plan to the Worker on every plan change (checks and watches while active, checks only while a payment is retried, nothing once ended or frozen) and erases the Worker's data, the ops settings and every ops record when the account is deleted. It is configured whenever the Worker can be called; an account that subscribed before that is caught up by the daily sweep.

## Ship Desk (A49)

Ship Desk makes a private card of each pull request a Codium run of Vector's GitHub agent opens: the head commit's check runs, the run's verdict (from the run record, never the pull request's text) and before/after screenshots, with Approve opening the pull request in GitHub. Vector's server never merges.

- **When a card is made.** The webhook's `pull_request` event, for a repository bound to the account with Ship Desk on in its settings, from the App's bot, or from `github-actions[bot]` carrying `<!-- vector:rid <run id> -->` (how Vector's GitHub agent publishes by default) when the run's record says it is that account's run in that repository. The plan must allow it now (Max or Ultra, active or renewing), the `ops` switch must be on and the App set up, and the repository's `.vector/ops.json` on the pull request's base branch must name the account's `opsId` with `shipDesk: true`. The API reads that file and the check runs with a token for that one repository with Checks, Contents and Metadata: read, revoked as soon as it is read and audited under `ops:audit:<account>` like Release Guard's. The App already has Checks: read ([github-app.md](github-app.md)); nothing new is needed. Run records come from Vector's GitHub agent once the integration commit (A59) registers its reader; until then only the App's own pull requests can make cards.
- **Counting.** One card per pull request and one per run, then the plan's cards a month (100 on Max, 400 on Ultra), counted in one step after both checks, so a pull request's later events never count again. A card is kept for the plan's keep days (30 or 90) and then expires by itself. A paused or ended plan keeps reading its cards; a frozen one sees none, and nothing is deleted.
- **Screenshots.** The workflow's capture job (Vector's GitHub agent adds it behind the repository variable `VECTOR_SHIP_DESK=1`, after the run publishes) runs `vector ship capture --pr <n>`. It holds no `id-token` and no run token, because it runs the repository's own code: only a capture ticket, which `vector ship ticket` asks for with the run's own token in the job that minted it, before any checkout, and hands over as that job's `capture` output. A ticket adds screenshots to its own run's card only, at most 8 files, inside 15 minutes from its first upload. What runs is `.vector/ship.json` on the base commit (`{install?, build?, start, port, routes[]}`, at most 4 routes), shot with the Chrome already on GitHub's runners. Uploads go straight to `vector-media` through signed links; each file is then read back (its size and first bytes) and kept only when its signature says PNG or WebP of the declared type. Anything else, SVG included, is deleted.
- **Storage.** Screenshots live in `vector-media` under `ship-desk/<live|test>/k30/…` and `ship-desk/<live|test>/k90/…`, by the plan's keep days. Add lifecycle rules on the bucket that delete `ship-desk/live/k30/` and `ship-desk/test/k30/` after 31 days, and `ship-desk/live/k90/` and `ship-desk/test/k90/` after 91 days. They must not cover `playbooks/`. The card's account reads an image through a signed link that lives 60 seconds and pins the image type, `no-store` and an attachment disposition; R2's own address cannot add `nosniff` or a CSP header, so those are on Vector's image route, and the signature check and the pinned type are what keep a file from rendering as anything but an image.
- **What the store keeps** (Codium prefix): `ops:card:<account>:<card>` (repository, number, title, link, head and base commits, check names and states, the verdict, image sizes and storage keys), `ops:cards:<account>`, `ops:card:<account>:run:<run id>`, `ops:card:<account>:<card>:refresh` (a minute's lock), `ops:card:ticket:<sha-256 of the ticket>` with `ops:card:<account>:tickets`, and the month's count under `meter:<account>:<period>:ship-desk-cards`. Account deletion erases them and the images (the `ops` provisioner on `closing`; A57 wires the rest of deletion).
- **Listing.** `ship-desk` is listed only through `CODIUM_LISTED_PERKS` and its gates (the App, `alerts` listed). Its readiness check and the screens come with A50; do not list it before then.

## What it costs

Each account wakes only when a check or a watch round is due: at most every minute on Ultra and every 5 minutes on Max, plus every 30 s while a release is being watched, with checks and watch rounds that fall within 25 s of each other sharing one wake, and at most 125 wakes an hour. Each wake reads the kill flag once, writes one row of running state, looks hosts up at most every 5 minutes, and runs at most 6 checks at a time. These are the "ops checks" line in the contract's cost estimate (§1.4); the guard cron (A50) watches the bill against it.
