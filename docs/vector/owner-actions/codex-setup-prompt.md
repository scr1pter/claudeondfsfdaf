# Owner setup template — review before use

Preserved from `owner-setup` at `6f4a7c5bb` as a proposed owner workflow. Its original version references and service
assumptions are historical; this integration does not authorize registrations, credentials, purchases or activation.
Reconcile it with the current disabled feature flags and the v2 owner gates before running any setup step.

# Codex browser setup prompt: GitHub App, Slack and OpenRouter

Prepared on 2 November 2026 against `main` at `78526052`, `codium` at `d13d91e3`, `vector-at-mention` at `0b68e8f6` and `self-evolving` at `7c26a834`. It replaces the 28 October version on `vector-takeover`; section 1 is still the GitHub App baseline that the @vector contract's section 4 step 3 points to. This is a prompt for a setup session that the owner supervises. It records no registration, installation, account change or live check as done.

How to use it: copy everything under **Prompt** into the Codex session that can use your browser. The **Owner-only steps** after the prompt are yours. Codex must not do them, and the prompt tells it so. Before using the prompt, recheck the sources in the last table if those branches have moved.

## Prompt

Help me prepare Vector's service accounts. Vector's public homepage is `https://vectordev.ai`. Do only these three jobs:

1. Register Vector's GitHub App and store its identity, plus the two @vector run secrets, in Vercel.
2. Create the Slack app registration for the future Vector bot. The bot is not built yet.
3. Set the privacy settings on Codium's OpenRouter account that Vector's published terms and privacy policy rely on.

Keep a running checklist of what is done, blocked and not attempted. Do not change code, deploy or redeploy, start or rerun a workflow, switch a service on, buy anything, set up payments or send a message.

### How we work

1. **I do the sensitive steps.** Signing in, passwords, passkeys, two-factor codes, CAPTCHAs, identity checks, payments and accepting new terms are mine. When a page asks for one of these, stop, tell me what it wants, and wait. Do not type into sign-in or verification fields.
2. **Ask before every change.** Before **every** Create, Save, Update, Install, Authorize, Generate, Delete or other action that changes an outside service, show me three things: the exact non-secret change, the account, organization, workspace or project it applies to, and the access it grants. Then wait for my explicit yes to that one action. A yes covers that action only, not the next one. Reading settings and filling in non-secret draft fields need no yes.
3. **Never handle a secret's value.** Never print, read out, summarize, screenshot, zoom into, copy or paste a secret, and never ask me for one in chat. Do not use a terminal to read credential files or environment variables. If a page shows a secret, or has a Show or Reveal control next to one, do not use that control and keep that part of the page out of any capture. I deal with it.
4. **Secrets go straight to the place that reads them.** Each secret goes directly into the Vercel environment variable or GitHub secret that Vector's code (or the contract named here) reads. Show me the destination's **name and scope**, never its value. Do not invent a destination. Do not create a `.env` file, and do not park a secret in a document, note, file, chat or the repository, even for a moment. Leave existing secrets as they are: do not read, replace or delete them.
5. **Private keys stay unopened.** A GitHub private key downloads to `~/Downloads`. Never open, preview, read, upload or attach it. I paste its contents into its Vercel variable myself while you wait. If that cannot happen without you reading the file, stop at that step. Never generate a second key to get around this rule. Once I confirm the key is stored, remind me to delete the downloaded file. I delete it myself.
6. **Change only what is listed.** If a page, label, option, account or owner differs from what this prompt describes, or if it is unclear who owns something or which code will use a value, stop that step. Record it as blocked and move on to steps that do not depend on it. Never weaken a privacy or security setting, or widen access, to make something work.
7. **Out of bounds, even if I ask.** You must not:
   - create the `codium-test` GitHub environment or its secrets;
   - do anything in Stripe;
   - do any Apple Developer ID, signing or notarization work;
   - publish anything to npm;
   - save the GitHub App webhook or its secret;
   - set `VECTOR_GITHUB_APP_ENABLED` or `VECTOR_CLOUD_AGENTS_ENABLED` to on;
   - run, write or decode any workflow or OIDC token;
   - create OpenRouter keys, buy credits or change OpenRouter billing.

   If I ask for one of these, remind me it is an owner-only step and do not go to that page.

8. **The final checklist names secrets, never their values.**

### 1. GitHub App: one shared identity for Vector's GitHub work

What the code and the owner's decisions already settle:

- The server reads **one** App identity: `VECTOR_GITHUB_APP_ID`, `VECTOR_GITHUB_APP_CLIENT_ID`, `VECTOR_GITHUB_APP_SLUG` and `VECTOR_GITHUB_APP_PRIVATE_KEY`. It uses them only when `VECTOR_GITHUB_APP_ENABLED` is exactly `true` and the deployment is Production (`api/_lib/github-app.ts`). That one identity serves task and review jobs today, and later @vector and Codium. The owner has decided on one shared App, not separate Apps for VectorScope, @vector or Codium.
- **The App's name and slug must not be `vector`.** An unrelated GitHub organization already uses that name. @vector responds only to `@<slug>`, `/vector` and `/vs`, so a slug of `vector` would notify someone else's account. The slug comes from `VECTOR_GITHUB_APP_SLUG`. The code accepts only 2 to 100 characters of lowercase letters, digits and hyphens, not starting or ending with a hyphen.

**1.1 Owner and reuse.** First, identify with me the Vector-owned GitHub organization that should own the App. The repository owner's personal account does not settle this on its own. Check whether a suitable App already exists. Reusing one needs my approval after you compare its current settings with the table below.

**1.2 Name.** Ask me for the display name. You may suggest names whose slug would not be `vector`, and you may check that a name is available. After creation, record the slug GitHub actually assigned. Do not promise anyone the handle `@vector`.

**1.3 Registration.** Show me this registration for approval and wait before Create:

| Field                                                  | Setting                                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                                                  | The organization I identify                                                                                                                                                                       |
| GitHub App name                                        | The name I approve; never `vector`                                                                                                                                                                |
| Homepage URL                                           | `https://vectordev.ai`                                                                                                                                                                            |
| Callback URL                                           | None                                                                                                                                                                                              |
| Request user authorization (OAuth) during installation | Off                                                                                                                                                                                               |
| Enable Device Flow                                     | Off. Desktop sign-in uses a separate OAuth App; see 1.9                                                                                                                                           |
| Setup URL                                              | Blank, with redirect on update off. The code never treats an `installation_id` from a redirect as proof of anything                                                                               |
| Webhook                                                | **Active unchecked**, no URL, no secret (see 1.8)                                                                                                                                                 |
| Repository permissions                                 | Contents: read and write. Pull requests: read and write. Issues: read and write. Actions: read and write. Checks: read-only. **Deployments: read-only.** Metadata: read-only (GitHub requires it) |
| Every other repository permission                      | No access. In particular, never grant Administration, Secrets, Workflows or Environments                                                                                                          |
| Organization permissions                               | None, Members included                                                                                                                                                                            |
| Account permissions                                    | None                                                                                                                                                                                              |
| Subscribe to events                                    | None (the webhook is inactive)                                                                                                                                                                    |
| Where can this GitHub App be installed?                | **Any account**: customers install it on their own repositories, through `vector github install` and the desktop's setup. Confirm this with me before saving                                      |

Why these permissions:

- Actions write lets Vector dispatch workflows and verify runs. It does not let anyone edit workflow files; that would need Workflows, which is never granted.
- Deployments read is there from day one because the @vector contract and Codium's ops features need it. Adding a permission later would make every installation approve the change. Today's server never asks for it: it requests each installation token with a fixed per-job set (task, publish or review) and checks the result exactly.
- Do not add permissions to get past an error.

**1.4 Identifiers.** After the registration is approved and created, record these public identifiers:

- the App ID;
- the client ID;
- the slug;
- the settings URL;
- the public install URL `https://github.com/apps/<slug>/installations/new`, from which the code derives the bot handle.

Do not generate a client secret. Nothing uses one.

**1.5 Private key.** Propose generating **one** private key and wait for my yes. It downloads to `~/Downloads`. Handle it under rule 5. The code accepts a PKCS#1 or PKCS#8 RSA PEM of up to 16,384 characters, with real or escaped newlines.

**1.6 Vercel.** Identify with me the existing Vercel project that serves `vectordev.ai` (the release docs call it `vectordev-ai`). Propose each variable below, scoped to **Production only**: never Preview or Development, and never with a public or client-build prefix. If Vercel offers to mark a value Sensitive, propose that for every secret. Wait for my yes before each save. Saving does not change the running site until the next deployment, and you do not redeploy.

| Variable                           | Value and handling                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VECTOR_GITHUB_APP_ID`             | The decimal App ID                                                                                                                                                                                                                                                                                                                      |
| `VECTOR_GITHUB_APP_CLIENT_ID`      | The public client ID, used as the issuer of the App's signed token                                                                                                                                                                                                                                                                      |
| `VECTOR_GITHUB_APP_SLUG`           | The lowercase slug, without `[bot]`                                                                                                                                                                                                                                                                                                     |
| `VECTOR_GITHUB_APP_PRIVATE_KEY`    | I paste the PEM. You never see it                                                                                                                                                                                                                                                                                                       |
| `VECTOR_RUN_TOKEN_SECRET`          | At least 32 random characters. I generate it outside this session and paste it. It signs @vector's run tokens (`api/_lib/cloud-agents-run-token.ts` on `vector-at-mention`, not yet on `main`). Without it, a key derived from `VECTOR_LICENSE_SECRET` is used. Changing it later ends every live run token, so it is set once and kept |
| `VECTOR_RUN_ARTIFACT_SECRET`       | At least 32 random characters, handled the same way. The @vector contract (section 4 step 4, package V27) names it as the key for encrypted session artifacts. No code reads it yet                                                                                                                                                     |
| `VECTOR_GITHUB_APP_ENABLED`        | Do not create it or set it to `true`. If it exists, report only that it exists and its scope. Switching it on is my later acceptance step                                                                                                                                                                                               |
| `VECTOR_CLOUD_AGENTS_ENABLED`      | Do not create it. The contract leaves it unset                                                                                                                                                                                                                                                                                          |
| `VECTOR_GITHUB_APP_WEBHOOK_SECRET` | Do not create it. Blocked; see 1.8                                                                                                                                                                                                                                                                                                      |

Check only whether these existing entries are present, and their scope: `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `VECTOR_ABUSE_SECRET` (the App exchange needs a stable value of at least 32 characters) and `VECTOR_LICENSE_SECRET` (the run-token fallback). Never reveal, edit or replace them. If one is missing, record it for me to provision. Do not generate a value for it.

**1.7 Test installation.** Propose installing the App on **one private test repository that I choose**, using "Only select repositories". Show the repository's full name and the access requested, and wait for my yes before Install. Do not install it on all repositories or on any other account. Do not switch the service on, open a pull request, comment or run anything. Registering and installing the App does not prove that production works.

**1.8 Webhook: blocked.** None of the three branches, `main`, `codium` or `vector-at-mention`, has an `/api/github/webhook` route at these commits. The webhook is saved only after Codium's shared webhook router (package A47) is reviewed and deployed. At that point I will:

- set `https://vectordev.ai/api/github/webhook` as the webhook URL;
- add `VECTOR_GITHUB_APP_WEBHOOK_SECRET`;
- subscribe to `installation`, `installation_repositories`, `repository`, `pull_request` and `deployment_status`.

Codium's own owner step lists only three of those events; the @vector contract adds `installation_repositories` and `repository`. Record the webhook as blocked future setup. Do not save any part of it now.

**1.9 Leave these alone:**

- **Desktop GitHub sign-in.** `packages/desktop/src/main/github-auth.ts` uses a separate GitHub **OAuth App** with Device Flow. Its public client ID comes from `VECTOR_GITHUB_CLIENT_ID` or a compiled-in default, and it asks for `repo`, or `repo workflow` only when someone sets up automatic reviews. Do not swap in the App's client ID, create another OAuth App, change scopes or add a redirect URI.
- **Vector's endpoints.** `GET`/`POST https://vectordev.ai/api/github/installation`, `POST https://vectordev.ai/api/github/token` and the coming `/api/cloud-agents/*` routes accept only GitHub Actions OIDC proofs with exact audiences. They are not OAuth callbacks or webhook URLs. Never test them with a personal token or an `installation_id` parameter.

**1.10 Owner steps after this session.** You do none of these; list them as remaining:

- decode one live OIDC token per event on a private test repository, printing claim names only (contract section 4 step 5);
- confirm the sandbox's runner assumptions (step 6);
- merge `vector-at-mention` and publish an npm CLI at or above its minimum (step 7);
- run the acceptance on a private test repository after Codium's integration (step 8);
- list the GitHub perks in `CODIUM_LISTED_PERKS` (step 9);
- complete the acceptance list in `docs/vector/owner-actions/github-app.md`, switching `VECTOR_GITHUB_APP_ENABLED` on only for that controlled check.

### 2. Slack: register the app for the future laptop-first bot

**What exists.** Nothing that reads Slack is built yet:

- The queued design is a bot you mention in Slack. It runs on the user's laptop through Vector's relay when the laptop is online, and otherwise in the user's own GitHub Actions. It still needs mapping between Slack users and Vector accounts, rules for who may spend, defence against prompt injection in message text, and the relay (`docs/vector/build/vector-everywhere-queued.md` on `self-evolving`).
- The @vector contract leaves Slack out.
- Codium's run-trigger schema reserves `slack` as a source and refuses it with `source-unavailable` (`packages/schema/src/codium-run-trigger.ts` on `codium`).

This session prepares a registration only. Never say that a Slack bot works.

**2.1 Workspace and reuse.** Identify with me the Slack workspace I control. Check for an existing Vector app and show me its current state before proposing anything.

**2.2 Create.** For a new registration, propose creating it from scratch, named `Vector`, in the workspace I approve. Wait for my yes before Create. Then record:

- the App ID;
- the workspace;
- the settings URL.

The Basic Information page lists credentials: client secret, signing secret and verification token. Do not reveal, copy or record them.

**2.3 Socket Mode.** Propose turning on Socket Mode, with no Events API request URL and no OAuth redirect URL, and wait for my yes. If Slack needs an app-level token (`xapp-…`, scope `connections:write`) generated to turn Socket Mode on, **stop before generating it**: no code would read it and it has no reviewed destination. Record Socket Mode as pending. Do not put the token in a Vercel variable, a GitHub secret or a guessed `SLACK_APP_TOKEN`.

**2.4 Nothing else yet.** Do not add any of these:

- bot or user scopes;
- event subscriptions;
- slash commands;
- interactivity;
- incoming webhooks;
- distribution settings;
- installation to the workspace.

Mention handling, scopes and the local credential store all need the bot first. Do not send any Slack message.

**2.5 Not the same thing.** The Slack entry in `packages/app/src/components/plugins/catalog.tsx` is a separate MCP connector, marked "Soon" and unavailable. Its `SLACK_BOT_TOKEN` and `SLACK_TEAM_ID` fields are not this bot and are not a destination for any token from this app.

### 3. OpenRouter: Codium's privacy settings, on Codium's account only

**3.1 Which account.** Use **Codium's own OpenRouter account**, never the account behind `OPENROUTER_FREE_API_KEY`. Ask me to identify it without showing any key, and confirm the account before changing anything.

On this account, do not:

- create an account;
- buy credits;
- turn on or change automatic top-ups;
- add a payment method;
- create a management key or an API key.

Do not rename, disable or delete any existing key either. Codium's funding check counts keys named `Vector <account id> …` and `Codium <account id> …`, and the privacy policy describes that naming. Credits, top-ups and the management key are mine (`docs/vector/owner-actions/codium-payments.md` section 2, steps 2 to 6).

**3.2 Settings.** Open Settings → Observability and [Settings → Privacy](https://openrouter.ai/settings/privacy). Match the page's real labels to the intended settings below. Show each proposed change and wait for my yes before each Save:

| Setting                                                               | Required state                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Private Input & Output Logging (Observability)                        | **OFF**                                                                                                 |
| OpenRouter Use of Inputs/Outputs, including the 1% discount           | **OFF**                                                                                                 |
| Paid models: allow providers that may train                           | **OFF**                                                                                                 |
| Providers that may publish prompts                                    | **OFF**                                                                                                 |
| ZDR (zero data retention) for every model group                       | **ON** for Anthropic, OpenAI, Google, SpaceXAI and every other group the page shows                     |
| BYOK provider keys                                                    | None. If any exist, stop for my decision. Do not delete them                                            |
| Default or enforced plugins, server-side tools                        | None. Show any existing configuration before proposing to remove it                                     |
| Free-model training, provider allow and ignore lists, everything else | Not specified for this account. Leave as found and record what you saw, especially any ignored provider |

If the page has one global ZDR control instead of one per group, explain what it covers, and use it only with my yes. If a required control is missing or its meaning is unclear, record it as blocked. Never relax a restriction to make a model work.

**3.3 Why it matters.** The published text on `main` relies on these settings:

- **Logging off.** The privacy policy (`packages/web/src/pages/legal/privacy.astro#codium-retention`) says OpenRouter keeps no prompts or responses from zero-data-retention requests unless the account holder turns storage on. Logging OFF keeps that true.
- **Routing restriction.** The terms (`terms.astro#codium-data`) and the privacy policy (`#codium`) describe a routing restriction: each request asks for endpoints OpenRouter records as zero data retention that do not collect data.
- **Plugins off.** The privacy policy also says Codium turns OpenRouter's plugins and server-side tools off.

The Codium gateway already enforces this on every request (`api/_lib/model-plan-chat.ts` on `codium`):

- it sends `provider.zdr: true`, `provider.data_collection: "deny"` and `require_parameters: true`;
- it switches off OpenRouter's web, file-parser, response-healing, context-compression, auto-router and pareto-router plugins;
- it refuses client-supplied plugins, presets, modalities and model lists.

The dashboard settings are a second guard, not a substitute. Do not send a model request to test them.

**3.4 What not to claim.** The policy's limits stay true after this setup. When you report, keep all of them:

- OpenRouter screens every request for child sexual abuse material (from 27 October 2026). Flagged content may be kept for human review and reported, and reported material is kept for one year.
- Prompt caches: 5 minutes on Claude Haiku 5.5 and Gemini 4 Argon, up to 30 minutes on GPT-6 Luna, plus providers' own short-lived in-memory caches.
- Providers' automated safety checks.
- Request metadata, linked to the Vector account through the key's name.

Do not claim the setup turns these off, deletes past content or verifies providers. Do not edit legal text.

**3.5 The free-model account stays as it is.** Never apply Codium's ZDR setting to the account behind `OPENROUTER_FREE_API_KEY`. Its owner steps (`docs/vector/owner-actions/openrouter.md`, "Free models of 17 October 2026") deliberately set it differently:

- free-model training ON, behind Vector's consent flow;
- paid-model training OFF;
- prompt publication OFF;
- "ZDR endpoints only" OFF;
- logging and OpenRouter's own use of inputs OFF;
- no automatic top-up, BYOK keys, default plugins or allowed-providers list.

If I sign in to it and ask, you may compare it with those steps read-only and report differences. Change nothing there. If Codium and the free models seem to share one account, stop: splitting them is my job.

### Finish with this checklist

Give me a compact checklist marking each item **done**, **blocked**, **not attempted** or **owner-only**. Leave out every secret value. You may include public App IDs, slugs, settings URLs and the chosen test repository if I approve. Never include anyone's personal email, a key's file path that identifies a person, or a secret.

- GitHub App: owner organization, name and slug (not `vector`) confirmed; permissions checked against 1.3, including Deployments: read; registration result.
- `VECTOR_GITHUB_APP_ID`, `VECTOR_GITHUB_APP_CLIENT_ID`, `VECTOR_GITHUB_APP_SLUG`, `VECTOR_GITHUB_APP_PRIVATE_KEY`: each set or pending, Production only.
- `VECTOR_RUN_TOKEN_SECRET`, `VECTOR_RUN_ARTIFACT_SECRET`: each set by me or pending, Production only, values unseen.
- `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `VECTOR_ABUSE_SECRET`, `VECTOR_LICENSE_SECRET`: presence and scope checked, or blocked; values unseen.
- `VECTOR_GITHUB_APP_ENABLED` not switched on; `VECTOR_CLOUD_AGENTS_ENABLED` not created; production acceptance not attempted.
- Test installation on one private repository: result. Wider installation: not attempted.
- Webhook, `VECTOR_GITHUB_APP_WEBHOOK_SECRET` and its five events: blocked until the router is deployed.
- Desktop Device Flow OAuth App: unchanged.
- Slack app: registration and Socket Mode result. Tokens, scopes, events and installation pending the bot. No messages sent.
- Codium OpenRouter account confirmed separate. Logging OFF, own use OFF, paid training OFF, publication OFF, ZDR ON for all groups, no BYOK keys or default plugins, or the exact blocked settings named. No keys, credits or billing changed.
- Free-model OpenRouter account unchanged.
- Owner-only, not attempted by Codex: the `codium-test` environment and its secrets; Stripe; Apple Developer ID and signing secrets; npm CLI publishing at 1.99.113 or later.
- What remains for me, without secrets: the steps in 1.10, any missing entries, and any controls that were unavailable.

## Owner-only steps (Codex must not do these)

**Codex: everything below is for the owner. Do not open these pages, fill in these fields or generate these values, even if asked. Report each one as "owner-only, not attempted".** Every value below goes straight from its source into the named GitHub secret or Vercel variable, never into chat, a file or the repository.

### A. The `codium-test` GitHub environment and its secrets

`.github/workflows/vector-codium-e2e.yml` (on `codium`) runs Codium's Stripe test-mode checks against a preview deployment. It works like this:

- It starts only by manual dispatch, and GitHub can dispatch it only once the file is on the default branch.
- Its guard job refuses to run unless the repository has an environment called `codium-test` with at least one required reviewer.
- It refuses any target that is not an https preview origin, and always refuses `vectordev.ai`.

To set it up:

1. In the Vector repository, open Settings → Environments → New environment and create `codium-test`. Add yourself as a required reviewer. Codium's build contract (section 8.2 step 2) also asks for a `hosted-production` environment. No workflow on these branches uses it yet.
2. Add these environment secrets:

| Secret                         | Value                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `CODIUM_E2E_STRIPE_SECRET_KEY` | A Stripe **test-mode** key, `sk_test_…` or `rk_test_…`. The workflow refuses anything else        |
| `CODIUM_E2E_KV_REST_API_URL`   | The https REST URL of the separate test store: the Preview-only Upstash store, never Production's |
| `CODIUM_E2E_KV_REST_API_TOKEN` | That test store's token                                                                           |
| `CODIUM_E2E_VERCEL_BYPASS`     | Optional: the preview's Protection Bypass for Automation secret                                   |

### B. Stripe (Codium payments)

Sources:

- `docs/vector/owner-actions/codium-payments.md` (on `codium`);
- `docs/vector/build/codium-build-spec.md` sections 2, 4.16 and 8.2 steps 5 to 7 and 17;
- the code on `codium` at `d13d91e3`.

Steps:

1. **Account.** Finish business details, identity verification and the payout bank account.
2. **Keys.** You need two:
   - a **setup key**, used only on your own machine by `bun scripts/setup-model-plans.ts --apply` from `packages/web`;
   - a **runtime restricted key**, `rk_live_…`, with the permissions listed in section 8.2 step 5, for Vercel.

   Never deploy the setup key, and never use the runtime key for setup.

3. **Test mode first.** Run the script with a test-mode setup key against the preview address. It creates:
   - four monthly products: Plus $10, Pro $50, Max $100 and Ultra $200, with lookup keys `vector-models-{10,50,100,200}-monthly-v1`, `tax_behavior=exclusive` and statement descriptor `VECTORDEV CODIUM`;
   - one portal configuration with no plan changes;
   - the webhook at `<origin>/api/model-plans/webhook`, on API version `2025-02-24.acacia`, subscribed to exactly the 20 events in `MODEL_PLAN_WEBHOOK_EVENTS` (`api/_lib/model-plan-stripe.ts`).

   It prints the price and portal IDs and the webhook signing secret. Copy the secret straight into Vercel.

   Then set up the preview test. It needs a Preview-only Upstash store, Deployment Protection on previews, `CODIUM_STRIPE_MODE=test`, and `MODEL_PLANS_ENABLED=true` on that preview branch only (test checkout is open only to `VECTOR_ADMIN_EMAILS`). Run the test in codium-payments.md section 4 and the workflow in A.

4. **Dashboard.** Turn on:
   - Smart Retries, with cancel after the last retry;
   - customer emails for failed payments and 3-D Secure;
   - the Terms of Service URL;
   - Radar defaults (an optional block list goes in `CODIUM_RADAR_BLOCKLIST_ID`).

   Decide Stripe Tax with an accountant (`CODIUM_STRIPE_AUTOMATIC_TAX`, default `false`). Keep cards as the only payment method, with no trials or coupons.

5. **Production variables** (names only):
   - **Switch and Stripe:**
     - `MODEL_PLANS_ENABLED`, which stays `false` until go-live;
     - `CODIUM_STRIPE_MODE=live`;
     - `STRIPE_SECRET_KEY`, the `rk_live_…` runtime key; a live key is refused unless `VERCEL_ENV=production`;
     - `STRIPE_MODEL_PLAN_WEBHOOK_SECRET`, `STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID` and `STRIPE_MODEL_PLAN_{10,50,100,200}_PRICE_ID`.
   - **Credits and keys:**
     - `MODEL_PLAN_{10,50,100,200}_CREDITS_USD` or `MODEL_CREDIT_MARKUP_PERCENT`;
     - `OPENROUTER_MANAGEMENT_KEY`;
     - `MODEL_PLAN_KEY_ENCRYPTION_SECRET`, which must never change once set;
     - `KV_REST_API_URL`, `KV_REST_API_TOKEN` and `CRON_SECRET`.
   - **Email and owner access:** `RESEND_API_KEY`, `VECTOR_PURCHASE_EMAIL_FROM`, `CODIUM_OWNER_EMAIL` and `CODIUM_OWNER_SECRET`.
   - **Client gates:** `MODEL_PLANS_MIN_CLIENT` (default `1.99.113`), `MODEL_PLAN_GLOBAL_INFLIGHT` and `MODEL_PLAN_PRIORITY_RESERVE=0.2`.
   - The optional `CODIUM_*` tuning values in `.env.example`.
6. **Doc and code disagree.** codium-payments.md sections 1 and 3 still name top-up prices (`STRIPE_MODEL_TOPUP_*`) and a plan-change portal (`STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID`). Neither should be set:
   - top-ups were removed on 27 October (`codium-tiers-v3-changes.md` section 3);
   - the build contract's section 4.16 lists both as removed;
   - the code on `codium` reads neither, and the setup script prints neither.

   Follow the code.

7. **Go-live** (section 8.2 step 17), in this order:
   - run the live setup;
   - put the Production values in;
   - publish the desktop and npm CLI (D);
   - set the client gates;
   - merge the legal release commit and send the notice of material change;
   - set `MODEL_PLANS_ENABLED=true` and redeploy.

   Never set it back to `false` while anyone is subscribed. Use the `sales` and `codium` runtime switches instead.

### C. Apple Developer ID (signed and notarized macOS builds)

`.github/workflows/vector-desktop-release.yml` reads five **repository** Actions secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Production macOS builds must be signed and notarized with hardened runtime: `packages/desktop/electron-builder.config.ts` refuses otherwise. The workflow then checks the app with `codesign`, `spctl` and `stapler`.

1. Enroll in the Apple Developer Program as the account holder. Payment and identity checks are yours.
2. Create a **Developer ID Application** certificate, then export it with its private key as a `.p12` protected by a strong password.
3. Set the secrets:

| Secret                        | Value                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `CSC_LINK`                    | The `.p12`, base64-encoded                                                    |
| `CSC_KEY_PASSWORD`            | The `.p12` password                                                           |
| `APPLE_ID`                    | The Apple Account used for notarization. Secret only, never in the repository |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from that Apple Account                              |
| `APPLE_TEAM_ID`               | The 10-character Team ID                                                      |

4. A **signed** release also needs Windows signing. The credentials preflight stops a signed release if any of these is missing: `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET` and `VECTOR_WINDOWS_PUBLISHER_NAME`. Every release, signed or not, also needs `BLOB_READ_WRITE_TOKEN`.

   Until the full set exists, a release ships unsigned only if both of these hold:
   - its version is in `packages/desktop/release-policy.json` `unsignedVersions` (the last entry is `1.99.112`);
   - it is dispatched with `allow_unsigned=true`.

   Publishing runs in the `production-release` environment, which has required reviewers.

### D. npm CLI publishing at 1.99.113 or later

**Why 1.99.113.**

- Codium's gateway serves no desktop or CLI older than `MODEL_PLANS_MIN_CLIENT_DEFAULT = "1.99.113"` (`api/_lib/model-plan-config.ts` on `codium`), unless `MODEL_PLANS_MIN_CLIENT` says otherwise.
- @vector needs a CLI at or above `GithubAgents.MIN_AGENTS_CLI = "1.99.113"` (`packages/core/src/github-agents.ts` on `vector-at-mention`). The lane's deviations call that version provisional.
- Today npm and `vectorRequiredCliVersion` are at `1.99.99`. Desktop 1.99.112 shipped with no npm publication.

**Steps** (`docs/vector/RELEASE-WORKFLOW.md` and `packages/engine/script/publish-vector.ts`):

1. **Before you publish:**
   - merge `vector-at-mention` to `main` after its V30 acceptance package, and merge the Codium client work;
   - choose a version of at least 1.99.113;
   - if that version differs from `MIN_AGENTS_CLI`, record it there first.
2. **Publish to npm.** Confirm control of the `@vectordevai` npm scope with two-factor authentication on. Then, from an interactive terminal on a clean checkout of the reviewed `main` commit, in `packages/engine`:
   - run `VECTOR_CLI_VERSION=<version> bun run script/publish-vector.ts --dry-run`, with the reviewed catalog artifact in `VECTOR_RELEASE_CATALOG_PATH` and `VECTOR_RELEASE_CATALOG_SHA256`;
   - then run it again with `--publish`. It publishes `@vectordevai/plugin`, then every CLI platform package, then the `@vectordevai/cli` umbrella. npm asks for your two-factor code. A retry keeps the same version.

   Never paste an npm token into chat, a task, a file or a command line.

3. **Standalone CLI.** Publish the standalone archives with `.github/workflows/vector-cli-release.yml`, in the order catalog, prepare, stage, commit, in the `production-release` environment.
4. **Desktop.** Raise `vectorRequiredCliVersion` in `packages/desktop/package.json` to that version before any desktop release offers @vector setup. The desktop release checks that the plugin and every CLI package exist at that version.

## Sources to recheck

| Source                                                                                                                                                                             | What it establishes                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/vector/build/vector-at-mention-spec.md` on `vector-at-mention`, sections 1.1, 1.3 A, 1.6, 1.7 (O1, O10), 2.1, 2.11.6, 2.14 and 4                                             | Name and slug not `vector`; one shared identity; the final permission set with Deployments: read; webhook events and timing; run secrets; owner steps |
| `api/_lib/github-app.ts`, `api/github/installation.ts`, `api/github/token.ts`; `docs/vector/owner-actions/github-app.md` (on `main`)                                               | The App variables, the Production-only switch, slug and key formats, per-job token permissions, endpoint contracts and the owner acceptance           |
| `api/_lib/cloud-agents-run-token.ts`, `packages/core/src/github-agents.ts`, `docs/vector/build/vector-at-mention-deviations.md` (on `vector-at-mention`)                           | `VECTOR_RUN_TOKEN_SECRET` and its fallback; `MIN_AGENTS_CLI` and why it is provisional                                                                |
| `packages/desktop/src/main/github-auth.ts` (on `main`)                                                                                                                             | The separate Device Flow OAuth App and its scopes                                                                                                     |
| `docs/vector/build/codium-build-spec.md` on `codium`, sections 2, 4.16, 4.17, 6 and 8.2                                                                                            | Codium's switches, variable names, the `codium-test` environment, Stripe and App owner steps                                                          |
| `api/_lib/model-plan-chat.ts`, `model-plan-stripe.ts`, `model-plan-config.ts`, `packages/web/scripts/setup-model-plans.ts`, `.env.example` (on `codium`)                           | Gateway privacy guards, the 20 Stripe events and API version, price and credit variables, the 1.99.113 client minimum                                 |
| `docs/vector/owner-actions/codium-payments.md` (on `codium`), section 2 step 7 and sections 1, 3 and 4                                                                             | Codium's separate OpenRouter account and privacy settings; Stripe and the test run (with the top-up mismatch in B.6)                                  |
| `docs/vector/owner-actions/openrouter.md` (on `main`), "Free models of 17 October 2026"                                                                                            | The free-model account's different settings                                                                                                           |
| `packages/web/src/pages/legal/terms.astro#codium-data`; `privacy.astro#codium` and `#codium-retention` (on `main`, unchanged on `codium` and `vector-at-mention`)                  | The published routing promise and its exceptions                                                                                                      |
| `.github/workflows/vector-codium-e2e.yml` (on `codium`)                                                                                                                            | `codium-test` guard and secret names                                                                                                                  |
| `.github/workflows/vector-desktop-release.yml`, `packages/desktop/electron-builder.config.ts`, `packages/desktop/release-policy.json` (on `main`)                                  | Apple and Windows signing secrets, notarization requirement, the unsigned allowlist                                                                   |
| `docs/vector/RELEASE-WORKFLOW.md`, `packages/engine/script/publish-vector.ts`, `docs/vector/owner-actions/standalone-cli-release.md` (on `main`)                                   | npm and standalone CLI publication order                                                                                                              |
| `docs/vector/build/vector-everywhere-queued.md` (on `self-evolving`); `packages/schema/src/codium-run-trigger.ts` (on `codium`); `packages/app/src/components/plugins/catalog.tsx` | The Slack bot is queued and unbuilt; `slack` is a refused source; the Slack MCP connector is separate                                                 |

Using this prompt needs no tests and changes no code. Each setup session must still read the services' current labels and get the confirmations the prompt requires.
