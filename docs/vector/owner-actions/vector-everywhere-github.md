# Vector everywhere on GitHub: going live

Written on 2026-11-20 (EV-24) from the build contract (docs/vector/build/vector-everywhere-spec.md), its deviations log and the integrations READMEs. Nothing here is a secret: you make every key yourself and put it only in Vercel. The texts you provide are listed under Texts you provide, never drafted here.

## Where things stand

@vector's own GitHub launch needs nothing from Vector everywhere: mentions keep running in the repository's own Actions (spec §4.1). What Vector everywhere would add, laptop-first for the binder's own mentions, waits for @vector and for you (Q13). Until then production `/api/everywhere/github/handoff` answers 501 `HANDOFF_UNAVAILABLE` (`api/_lib/everywhere/github/adapter.ts`), and the route job carries on in Actions. Laptop jobs from Slack, Linear and Jira open their draft pull requests with each person's own GitHub sign-in in the desktop app, which needs no step from you.

## Before you start

These gates are in the code or with the lead, not yours. Check that each one is closed before you go live.

- `LAPTOP_ROUTE_WIRED` is `false` (`api/_lib/everywhere/config.ts`): no paying customer's job runs until a reviewed package sets it.
- `OFFER_KEYS` is empty (`packages/desktop/src/main/everywhere-offer.ts`): every computer refuses every offer until your public key is pinned and a desktop release ships it (Keys, step 2).
- The Actions fallback is off: R-A4 and R-C8 are not built, and `RESERVED` in `packages/schema/src/codium-run-trigger.ts` keeps Slack, Linear and Jira out of Actions until you say yes. A job whose computer is away waits or expires.
- macOS and Windows have no shell for jobs: jobs there edit files and run no commands (spec §7, Stage B note of 2026-11-16).
- The desktop page cannot turn jobs on or allow a folder yet: Settings → Vector everywhere is read-only until the write path is built (vector-everywhere-deviations.md, "2026-11-20, EV-21", "Ruling on (a)").
- The decisions are the ones you confirmed on 2026-11-11 (spec §10): Q5 (Slack reads a mention's thread once), Q13 (GitHub laptop-first only if @vector agrees) and Q14 (a platform goes live when its own steps are met).
- The platform facts here were last read on 2026-11-12 (VE-11 to VE-13); re-read the current platform pages when you register.
- Laptop-first waits for @vector's R-A5 (the OIDC handoff) and R-A6 (the route job's `id-token: write` and the `laptopFirst` option), and for your Q13 decision. Until then the handoff answers `HANDOFF_UNAVAILABLE`.
- The GitHub `help` line in `renderHelp` (`packages/schema/src/everywhere-policy.ts`) says the binder's mentions can run on their computer. That wording changes before anyone sees it, unless laptop-first ships first.

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

GitHub has no setting of its own here. @vector's settings are in [github-app.md](github-app.md), "Production configuration".

## Go-live steps

Spec §4.1, owner registration steps 1 to 3:

1. Follow @vector's own steps in [github-app.md](github-app.md) and [vector-mention.md](vector-mention.md).
2. Make the keys above (Keys), which laptop jobs from every platform need.
3. No GitHub review is needed for a public App; the verified-publisher badge is optional (spec §4.1 step 3).

## Turning it on

Nothing to turn on for GitHub yet. Do not add `github` to `VECTOR_EVERYWHERE_PLATFORMS`: `readConfig` in `api/_lib/everywhere/config.ts` counts GitHub as always configured, so listing it opens the platform, while the handoff still answers 501 `HANDOFF_UNAVAILABLE` before it checks anything. When @vector's laptop-first exists and you have decided Q13, this section gains its own order.

## Live acceptance

Nothing to accept for Vector everywhere on GitHub until laptop-first exists. @vector's own acceptance is in [vector-mention.md](vector-mention.md).

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

None beyond @vector's own texts ([github-app.md](github-app.md), [vector-mention.md](vector-mention.md)).

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

No listing is needed: a public GitHub App needs no GitHub review (spec §4.1 step 3).
