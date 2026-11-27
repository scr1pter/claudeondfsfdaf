# Vector everywhere on Linear: going live

Written on 2026-11-20 (EV-24) from the build contract (docs/vector/build/vector-everywhere-spec.md), its deviations log and the integrations READMEs. Nothing here is a secret: you make every key yourself and put it only in Vercel. The texts you provide are listed under Texts you provide, never drafted here.

## Where things stand

The Linear app is built and off. Nothing is registered, and every Linear route answers 404 until you turn Vector everywhere on for Linear. People delegate an issue to Vector or mention it; the job runs on their own computer and comes back as a draft pull request (spec §4.3).

## Before you start

These gates are in the code or with the lead, not yours. Check that each one is closed before you go live.

- `LAPTOP_ROUTE_WIRED` is `false` (`api/_lib/everywhere/config.ts`): no paying customer's job runs until a reviewed package sets it.
- `OFFER_KEYS` is empty (`packages/desktop/src/main/everywhere-offer.ts`): every computer refuses every offer until your public key is pinned and a desktop release ships it (Keys, step 2).
- The Actions fallback is off: its adapter and its run hooks are built (EV-29, EV-30), but it has no route until the live workflow read is built (no work package yet) and R-C8 is answered, and `RESERVED` in `packages/schema/src/codium-run-trigger.ts` keeps Slack, Linear and Jira out of Actions until you say yes. Jira stays out of Actions even then, until a run limit ends a Jira job before 50 minutes. A job whose computer is away waits or expires.
- macOS and Windows have no shell for jobs: jobs there edit files and run no commands (spec §7, Stage B note of 2026-11-16).
- The desktop page cannot turn jobs on or allow a folder yet: Settings → Vector everywhere is read-only until the write path is built (vector-everywhere-deviations.md, "2026-11-20, EV-21", "Ruling on (a)").
- The decisions are the ones you confirmed on 2026-11-11 (spec §10): Q5 (Slack reads a mention's thread once), Q13 (GitHub laptop-first only if @vector agrees) and Q14 (a platform goes live when its own steps are met).
- The platform facts here were last read on 2026-11-12 (VE-11 to VE-13); re-read the current platform pages when you register.
- Repository lookup requires the requester's verified GitHub binding.
- /everywhere is still a draft (PUB-8): installs, links, connect codes and mapping all happen on that page, so go-live waits for the 2.0.0 move (At 2.0.0).
- Listing Codium's `everywhere` perk needs EV-21's four preconditions first (spec §10, "Codium listing", note of 2026-11-20).
- The `help` text promises a route that is not built: `renderHelp` in `packages/schema/src/everywhere-policy.ts` says "(or in GitHub Actions)" for Slack and Linear. That wording changes before go-live (R-A4, R-C8).
- Once /everywhere is published, the connector can enter a Linear team ID and the GitHub repository's `owner/name`, then choose **Add repository**. Adding a repository requires the connector's verified GitHub binding.
- Summaries are held: Linear and Jira post only the outcome and the pull request link, and the private result surface (`privateResult`) is not built, so a summary reaches no one. The lead rules on EV-23 (c) before Linear or Jira goes live.

## Keys (once, for every platform)

Make both keys once, on your own computer, for every platform together. If another platform is already live, they exist already: never make new ones.

1. **The data key.** In a terminal, run:

   ```sh
   node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
   ```

   It prints 44 characters: that is `VECTOR_EVERYWHERE_DATA_KEY`, 32 random bytes as base64. `parseDataKey` in `api/_lib/everywhere/config.ts` refuses anything else, and the whole feature then stays off. Set it in Vercel's Production environment only, never Preview, and never put it in a commit, a log or a chat.

   Generate it once and never rotate it. `api/_lib/everywhere/config.ts` keeps one data key and no key ring. Every installation's platform token is sealed under it, so a new key disconnects every Slack, Linear and Jira installation (each must be connected again), and it makes live job records and queued replies unreadable.

2. **The offer key pair.** A computer takes a job offer only when this key signed it. Make the pair in a new, empty folder outside any checkout, so the private key can never be committed by accident:

   ```sh
   cd "$(mktemp -d)"
   node -e 'const c=require("crypto");const k=c.generateKeyPairSync("ed25519");require("fs").writeFileSync("offer-signing.pem",k.privateKey.export({type:"pkcs8",format:"pem"}),{mode:0o600});console.log(k.publicKey.export({format:"der",type:"spki"}).subarray(12).toString("base64url"))'
   ```

   - offer-signing.pem in that folder holds the private key. Its whole contents, header and footer lines included, are `VECTOR_EVERYWHERE_OFFER_SIGNING_KEY` (Vercel keeps the line breaks; `\n` escapes also work). Production only.
   - Choose `VECTOR_EVERYWHERE_OFFER_KEY_ID`: 1 to 64 letters, digits, `_` or `-` (`OFFER_KEY_ID_PATTERN` in `packages/schema/src/everywhere.ts`), for example the month you made the pair.
   - The command printed the public key, 43 characters. Give the key id and the public key to the lead: a reviewed change pins them in `OFFER_KEYS` in `packages/desktop/src/main/everywhere-offer.ts`, and a desktop release ships them. Until then every computer refuses every offer.
   - Keep the private key where you keep production secrets, then delete offer-signing.pem and its folder. A lost private key means a new pair, a new pinned key and a new desktop release.

## Settings

Set every value in Vercel's Production environment only.

| Setting                               | Value                                                                                                                                                                                   | While unset or unusable                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VECTOR_EVERYWHERE_ENABLED`           | Exactly `true`, set only at a go-live (Turning it on).                                                                                                                                  | Off: every intake and account route answers 404, claim answers 409, every other jobs route tells the computer to stop, and the sweep answers `{enabled: false}`. |
| `VECTOR_EVERYWHERE_PLATFORMS`         | Comma-separated: the platforms that are live. Never `github` until laptop-first exists (the GitHub guide).                                                                              | A platform that is not listed answers 404.                                                                                                                       |
| `VECTOR_EVERYWHERE_ALLOW_ACCOUNTS`    | Vector account ids (UUIDs), comma-separated, at first only your own: the Account ID column on /owner/codium shows it, the id `VECTOR_HOSTED_ALLOW_ACCOUNTS` takes.                      | Empty admits nobody.                                                                                                                                             |
| `VECTOR_EVERYWHERE_DATA_KEY`          | From Keys, step 1.                                                                                                                                                                      | The whole feature stays off, even with the flag.                                                                                                                 |
| `VECTOR_EVERYWHERE_OFFER_SIGNING_KEY` | From Keys, step 2.                                                                                                                                                                      | No job is offered to a computer.                                                                                                                                 |
| `VECTOR_EVERYWHERE_OFFER_KEY_ID`      | From Keys, step 2.                                                                                                                                                                      | No job is offered to a computer.                                                                                                                                 |
| `CRON_SECRET`                         | Already set for Codium's crons: do not change or regenerate it here, because every other cron uses it too. The sweep needs at least 16 characters with no spaces or control characters. | Unset, or shorter than 16 characters: the sweep answers 401 and ends nothing.                                                                                    |
| `VECTOR_LINEAR_CLIENT_ID`             | The OAuth app's client id.                                                                                                                                                              | Linear stays off, even when listed.                                                                                                                              |
| `VECTOR_LINEAR_CLIENT_SECRET`         | The OAuth app's client secret: at least 16 characters, no spaces.                                                                                                                       | Linear stays off, even when listed.                                                                                                                              |
| `VECTOR_LINEAR_WEBHOOK_SECRET`        | The app's webhook signing secret: at least 16 characters, no spaces.                                                                                                                    | Linear stays off, even when listed.                                                                                                                              |

Linear stays off while any of its three settings is missing or unusable, even when `VECTOR_EVERYWHERE_PLATFORMS` lists it.

## Go-live steps

Spec §4.3, owner registration steps 1 and 2, with the VE-12 corrections (vector-everywhere-deviations.md, "VE-12 current Linear contract"; `integrations/linear/README.md`):

1. In a dedicated Vector workspace, create the OAuth app with a short unique name and an icon. Never put "Linear" in the name. It installs with `actor=app`, which needs a workspace admin, and the scopes `read`, `write`, `app:assignable` and `app:mentionable`.
2. Set the callback to https://vectordev.ai/api/linear/oauth and the webhook to https://vectordev.ai/api/linear/webhook, with Agent session events and the permission-change and app-revocation events (`integrations/linear/README.md`). Then set the three Linear settings (Settings).
3. **Distribution gate.** The current Linear agent documentation requires an integration-directory submission before other workspaces can install an agent (VE-12). The spec's unlisted go-live through the authorize link is therefore unqualified: check the current rule before you invite any workspace but your own.

## Turning it on

1. **Deploy first.** All of these must be in production before the flag:
   - A production deployment from main that holds the everywhere routes, the per-minute `/api/everywhere/sweep` cron in `vercel.json` and Codium's `everywhere` switch (EV-07). Never set the flag on a deployment without the cron.
   - Vector Remote live, as [remote.md](remote.md) describes through step 8: the relay Worker deployed from main with the presence fix and job-offer forwarding (EV-05, EV-06), `VECTOR_REMOTE_RELAY_URL` set, `VECTOR_REMOTE_ENABLED` set to `true` and Codium's `remote` switch `on`. Your own plan must include Remote, or your computer reads as offline.
   - A desktop release that pins your offer public key in `OFFER_KEYS` (Keys, step 2).
2. On /owner/codium, set the `everywhere` switch to `stop`.
3. In Vercel's Production environment, set:
   - the data key and the offer key pair from Keys, unless another platform is already live;
   - this platform's settings (Settings);
   - `VECTOR_EVERYWHERE_ALLOW_ACCOUNTS` to your own account id only;
   - `VECTOR_EVERYWHERE_PLATFORMS` to the platform this guide is for, plus any platform already live (never `github` until laptop-first exists, as the GitHub guide says);
   - `VECTOR_EVERYWHERE_ENABLED` to `true`.

   Check that `CRON_SECRET` is set and usable (Settings), and leave it as it is. Then redeploy: Vercel applies environment changes only to new deployments.

4. In Vercel's cron log, check that `/api/everywhere/sweep` answers 200 every minute. A 401 means `CRON_SECRET` is unusable; a 503 means the store could not answer. Do not call the route yourself with the secret.
5. On /owner/codium, set the `everywhere` switch back to `on`.
6. Run the live acceptance below before anyone else is allowed. `VECTOR_EVERYWHERE_ALLOW_ACCOUNTS` stays at your own id until then.

For a later platform, follow steps 2 to 6 again: in step 3, add it to `VECTOR_EVERYWHERE_PLATFORMS` and set its own settings. Never generate new keys.

## Live acceptance

Spec §8 VE-50, on a private test repository and your own workspace, with only your id allowed:

- a delegation or a mention runs on your computer and ends with a draft pull request;
- with your computer off, the job waits and expires with the right reply;
- a stranger's delegation makes no job;
- a link attempt from another Linear identity fails;
- the `stop` signal, and the `stop` switch, both end a running job;
- disconnecting on the Vector everywhere page erases the workspace's links, mappings and live job text;
- uninstalling the app from the workspace: record what it erases. Linear's revocation events hold the work without erasing until a reconnect (`integrations/linear/README.md`).

Also qualify what the code could not (`integrations/linear/README.md`): the agent session payload's author fields, the first thought within 10 seconds, stop handling, whole-plan replacement, a lost activity create, a refreshed or lost token refresh, and token revocation. Record the results in docs/vector/build/vector-everywhere-progress.md.

## Turning it off

This is the safe order (vector-everywhere-deviations.md, "2026-11-15, EV-04", "The safe turn-off and turn-on orders"):

1. On /owner/codium, set the `everywhere` switch to `stop`.
2. Let one sweep run under `stop`: wait at least 2 minutes (each server keeps the switch for 30 seconds and the sweep runs each minute), plus one more minute for every further 200 live jobs. Under `stop` the sweep ends every live job and posts its reply.
3. Unset `VECTOR_EVERYWHERE_ENABLED` and redeploy.

- **Gently.** Set the switch to `no-new` until the live jobs have ended, then to `stop`, then unset the flag.
- **Flag first.** Unsetting the flag first also stops every job, but their replies wait until Vector everywhere is on again and then say the computer stopped answering, or never post once 30 days have passed.
- **There is no stop for one platform.** Taking a platform out of `VECTOR_EVERYWHERE_PLATFORMS` closes its intake (404), but its live jobs' replies cannot post while it is unlisted. Use the full order above.
- **Turning back on.** Keep the same data key, set `VECTOR_EVERYWHERE_ENABLED` to `true` again and redeploy, then set the switch back to `on`. After the safe order the switch is still `stop`, so the flag alone starts no work.

## Texts you provide

These are yours to write; this guide drafts none of them. Each is listed with where it appears and the facts it must match.

| Text                                                                                                 | Where it appears                                                                                                                                                                                                                                                                             | Facts it must match                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy policy section for Linear data: what is stored, for how long, how to erase it, and a contact | https://vectordev.ai/legal/privacy (`packages/web/src/pages/legal/privacy.astro`). codium-track also edits that page, so merge after its change lands (spec §6.4). It changes only in a release commit that moves the page's effective date and its pin in `test/codium-legal.test.ts` (H8). | Spec §3.2 "What the server stores" and §3.13; `KEEP_MS` in `api/_lib/everywhere/keys.ts`; E13 (a disconnect and account deletion erase).                                                                                                                                         |
| The legal read of that section, and whether the Terms need a clause                                  | https://vectordev.ai/legal/terms (`packages/web/src/pages/legal/terms.astro`), with the same H8 rule.                                                                                                                                                                                        | The docs draft (`packages/web/src/drafts/docs/everywhere.astro`), the account page copy (`EVERYWHERE_COPY` in `packages/web/src/components/marketing/everywhere/everywhere-model.ts`) and Codium's stored-data list (`docs/vector/owner-actions/codium-privacy-proposed.patch`). |
| Consent text for "This computer takes jobs"                                                          | Not built: it will appear in Settings → Vector everywhere (`packages/app/src/components/settings-v2/everywhere.tsx`) once the write path exists (EV-21).                                                                                                                                     | Spec §3.5 step 10 (keeping the app resident with your consent) and §3.12.                                                                                                                                                                                                        |
| The `everywhere` perk's label and text, and any plan copy (Q11)                                      | https://vectordev.ai/codium, from `PERK_COPY.everywhere` in `packages/schema/src/codium-copy.ts`.                                                                                                                                                                                            | Spec §10, "Codium listing" (EV-08, and EV-21's four preconditions).                                                                                                                                                                                                              |
| App name, icon and description                                                                       | The OAuth app's settings in Linear.                                                                                                                                                                                                                                                          | Spec §4.3 step 1: "Vector", never "Linear", in the name.                                                                                                                                                                                                                         |
| The L3 directory text, privacy URL and support contact                                               | Linear's integration directory form.                                                                                                                                                                                                                                                         | Spec §4.3 step 3.                                                                                                                                                                                                                                                                |

## At 2.0.0

Every new page stays unreachable until 2.0.0 ships. In one change at 2.0.0:

1. Move the three drafts to the same paths under packages/web/src/pages: `packages/web/src/drafts/everywhere.astro` to `packages/web/src/pages/everywhere.astro`, `packages/web/src/drafts/everywhere/link.astro` to `packages/web/src/pages/everywhere/link.astro`, and `packages/web/src/drafts/docs/everywhere.astro` to `packages/web/src/pages/docs/everywhere.astro`.
2. Add `"everywhere",` after `"login",` in the `keep` set of `script/prune-vector-site.mjs`.
3. Add this entry to `packages/web/src/data/docs-nav.ts`, after the `automations` entry in the Agents group:

   ```ts
         {
           id: "everywhere",
           title: "Vector everywhere",
           blurb: "Ask Vector for a coding task from Slack, Linear or Jira; the job runs on your computer.",
         },
   ```

4. Update the unreleased-state cases in the same change: "nothing is routed" in `packages/web/test/everywhere-pages.test.ts`, and "is unrouted" in `packages/web/test/everywhere-docs.test.ts`. That is the one case of the docs test the move turns red: the docs test reads the page at either address and counts each of the three pages these guides name as present at either address. If the change also links the Vector everywhere page from the docs page, update that test's "links only pages that exist" too.

Every Slack, Linear and Jira go-live waits for this move, because installs, links, connect codes and repository mapping all happen on the Vector everywhere page. Moving that page earlier is your decision, and it is a site release.

## Listing (after use, separate from go-live)

L3, Linear's integration directory (spec §4.3 step 3; VE-12 makes the submission a distribution gate, under Go-live steps):

1. Submit through Linear's directory form: a 320×320 colour icon and a white icon, 1 to 3 showcase images at 1600×1000, with the assets sent by email to Linear's integrations address.
2. Linear lists formal companies, not hobby apps, and states no timeline.
