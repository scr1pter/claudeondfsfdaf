# A38 Phone app shell: implementation record

A38 builds on A37 (push, `VECTOR_PHONE_APP_ORIGIN`, the subscribe route). No provider, Stripe, Supabase, Vercel,
Cloudflare or push-service call was made, and nothing was deployed. The tests use in-process fakes of the account
service, the browser's push manager and the store. Readings of the contract are in `codium-deviations.md` under
"A38 phone app shell (3 Nov 2026)".

## What changed

| Area | Change |
| --- | --- |
| Phone app | `packages/app/src/phone/` (new). `entry.tsx` registers the one service worker (`/phone/sw.js`, scope `/`) and mounts `app.tsx`: sign-in, the version handshake, a home list and seven routes (`routes/sessions`, `approvals`, `devices`, `cloud-runs`, `computer`, `ops`, `notifications`). `index.html`, `phone.webmanifest` (`id` and `start_url` `/phone/`, `scope` `/`) and `phone.css` (plain CSS, no inline styles). |
| What shows | `status.ts` reads the account status leniently and shows a route only when its perk is listed and the plan's public entitlements include it: Remote's three routes need `remote` and paired computers in the plan; GitHub runs also need `github-agents`; the cloud computer needs `computer` and `hosted`; production needs a listed ops part and `ops`; alerts need `alerts` and a plan. A paused, frozen or ended plan keeps its routes and says why. The server enforces every service from its own snapshot (S1). |
| iOS | `environment.ts`: an iOS browser tab cannot pair or take alerts; those routes show how to add Vector to the Home Screen instead, and sign-in says to install first, because the installed app keeps its own storage apart from Safari's. |
| Sign-in | `auth.ts`: the phone signs in to the Vector account on its own origin, with the account service the site names at `/api/auth/config`: Google through the PKCE code flow (S256) or email and password, refresh a minute before expiry, sign out. The session stays in the phone origin's localStorage. |
| API | `api.ts`: same-origin calls only (`/api/...` on the phone origin), bearer session, no cookies, no redirects. |
| Alerts | `push.ts`: turn on (permission from a tap, the server's VAPID key, `pushManager.subscribe`, `POST /api/notify/subscribe`; a subscription made for an older key is replaced; a server refusal undoes the new subscription) and off (unsubscribe first, then `DELETE`). `routes/notifications.tsx` shows each state in plain words. |
| Worker | `sw.ts` (built as one classic script): `push` shows the alert, `notificationclick` opens the route inside the app, a new worker takes over at once. No fetch handler: nothing an account sees is cached. `alerts.ts` decodes A37's two payloads: a server alert's title (and its tag's route), or a desktop alert opened with the alert key it names (`alert-keys.ts`, IndexedDB, non-extractable decrypt-only keys). An alert that cannot be read still shows a notification without content. |
| Handshake | `version.ts`: each build writes `/phone/version.json` (`{build, protocol, minDesktop}`); the open app reads it with no cache at start and when it comes back to the front, and reloads once onto a newer build. `negotiate()` and `phoneHello()` give Remote's desktop hello (A41/A42) a protocol both speak, or the side that must update. |
| Build | `packages/app/vite.config.ts`: `vite build --mode phone` (`bun run build:phone`) builds `src/phone` into `dist-phone` with base `/phone/`, no source maps, no module-preload polyfill. `src/phone/build.ts` (Node, build time only) writes the manifest, four icons, `version.json` and `sw.js`, and fails the build if the page holds an inline script, style or handler. `.gitignore` ignores `dist-phone`. |
| Website | `packages/web/scripts/phone-app.mjs` + an Astro `astro:build:done` hook copy `packages/app/dist-phone` to `dist/phone`; a missing build fails a Vercel build and warns locally. `script/prune-vector-site.mjs` keeps `phone`. `vercel.json` builds the phone app first. |
| Hosting | `vercel.json`, phone origin only: every path except `/phone/…` and `/api/…` redirects to `/phone/`; unknown `/phone/…` paths answer with the app's page (rewrites run after real files); CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://*.supabase.co; manifest-src 'self'; worker-src 'self'; media-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests`; `Permissions-Policy: camera=(self), …` after the site-wide `camera=()`; `Referrer-Policy: no-referrer`; `Cross-Origin-Opener-Policy: same-origin`; `X-Robots-Tag: noindex`; `Service-Worker-Allowed: /` on `/phone/sw.js`; `no-cache` on `/phone/…` and a year, immutable, on `/phone/assets/…`. `vectordev.ai/phone` and `www.vectordev.ai/phone` redirect to the phone origin. |
| Settings | `settings-v2/notifications.tsx` (new) replaces the Notifications page that lived in `general.tsx`: desktop notifications and sounds as before, plus a Phone alerts card when the status lists `alerts` and the plan includes them (`notifications-model.ts`). The card says how to set up the phone; the event switches (`finished`, `needsYou`, `runGuard`, `usage`) and quiet hours show only where the desktop can send alerts (`platform.phoneAlerts`, A41's bridge). `context/settings.tsx` gains `notifications.events` (usage off by default) and `notifications.quietHours` (null), with `validQuietHours`. `phoneAlertAllowed()` is what A41's sender applies. The shared page, card and row pieces moved unchanged from `general.tsx` to `settings-v2/parts/page.tsx`. |
| Listing | `api/_lib/codium-perks.ts`: `alerts` is ready once A37's VAPID keys and `VECTOR_PHONE_APP_ORIGIN` are set ("alerts can be listed once A37 and this ship"). Its `push` switch already gated it. |
| Guards | `packages/app/script/browser-imports.ts` walks the phone page too. `.github/workflows/vector-codium.yml` builds the phone app before the Codium tests, so the real-build case of `test/phone-app.test.ts` runs in CI. |
| Docs | `docs/vector/MODEL-PLANS.md` (listing readiness, the phone app), `.env.example` (`VECTOR_PHONE_APP_ORIGIN`). |

Edits to `api/_lib/model-plan-*.ts`: none.

## Tests run here (one file at a time)

| Package | File | Result |
| --- | --- | --- |
| root | `test/phone-app.test.ts` (new; prune, headers, origin, listing) | 11 pass (the real-build case ran after one local `build:phone`) |
| app | `src/phone/status.test.ts` (new) | 11 pass |
| app | `src/phone/version.test.ts` (new) | 7 pass |
| app | `src/phone/environment.test.ts` (new) | 5 pass |
| app | `src/phone/alerts.test.ts` (new) | 6 pass |
| app | `src/phone/auth.test.ts` (new; RFC 7636 appendix B) | 8 pass |
| app | `src/phone/push.test.ts` (new) | 6 pass |
| app | `src/phone/phone.test.ts` (new; CSP-safe sources, manifest, copy rules, no Node or Bun module) | 7 pass |
| app | `src/components/settings-v2/notifications-model.test.ts` (new) | 4 pass |
| app | `src/components/settings-v2/settings-registry.test.ts` (unchanged) | 14 pass |
| app | `src/context/settings.test.ts` (unchanged) | 3 pass |
| root | `test/site-publication.test.ts` (unchanged; the prune) | 3 pass |
| root | `test/web-push.test.ts` (unchanged) | 26 pass |
| root | `test/no-topups.test.ts` (unchanged) | 4 pass |
| root | `test/api-module-loading.test.ts` (unchanged) | 1 pass |
| web | `test/codium-public.test.ts` (unchanged; listing) | 13 pass |

Also run here: one `bun run build:phone` (23 modules, 38 KB of script, a 6.5 KB classic `sw.js`, no `eval`, no
inline styles), the browser-import walk over every page with the phone page added (3,072 modules, no Node or Bun
import), and the api entries loaded in nine different orders to check that `codium-perks.ts` importing `web-push.ts`
leaves no import-order problem. The built app was looked at in a local browser at phone size behind the phone CSP,
with a fake API: sign-in, the home list from a fixture status, Devices, Production, Alerts and sign-out rendered with
no CSP error, and the worker registered with scope `/` once `Service-Worker-Allowed: /` was sent (without it the
browser refuses, as expected).

Typecheck: `packages/app` `tsgo -b` clean; root `tsconfig.json` (api) clean; `packages/web` `astro check` 0 errors,
0 warnings.

**CI only:** `packages/app/src/browser-bundle.test.ts` (its walk now includes the phone page; the same walk ran here
by hand). **Never exercised anywhere:** a real push reaching a phone, Google sign-in against the real account service
on `remote.vectordev.ai`, an iPhone Home Screen install, and Vercel applying these `has`-host rules (the test reads
`vercel.json`; it cannot run Vercel's router).

## Owner steps this needs

- Add `remote.vectordev.ai` to the main Vercel project (contract §6.1) and set `VECTOR_PHONE_APP_ORIGIN=https://remote.vectordev.ai`.
- Add `https://remote.vectordev.ai/phone/` to the account service's allowed redirect URLs, or Google sign-in on the phone is refused (email and password still work).
- If the account service ever moves to a custom domain, change `connect-src` in `vercel.json`.
- List `alerts` (`CODIUM_LISTED_PERKS`) only once something sends alerts: the desktop's sender is A41, the server's senders are On Call and Ship Desk (A50) and the cloud computer (A56). The readiness check cannot know that.

## Not done

- Remote's pairing, sessions, approvals and devices (A42), the cloud computer's phone view (A56) and the production cards (A50) fill their routes; here they are shells with honest empty states.
- The desktop half of encrypted alerts (A41's `remote-notify.ts` and `platform.phoneAlerts`) must seal alerts as `alerts.ts` describes; pairing (A42) stores each computer's alert key with `saveAlertKey`.
- `pushsubscriptionchange` is not handled: the worker has no session to re-register with. Opening Alerts again re-registers.
- The relay's `wss:` host is not in `connect-src` yet; A42 adds it with the relay URL.
- bun.lock was already modified in the worktree before this work and is not mine; it is left out of the commit. Nothing was pushed.
