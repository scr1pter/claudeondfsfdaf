# phone-alert-status takeover: the phone checks the signed-in account's push registration

Branch `cx-phone-alert-status`, cut from `phone-alert-status` (draft PR #143) and merged with origin/main `b57b8d53`. This v2 run took the draft over to finish and merge it before the Saturday 2026-11-28 deadline, because it had been idle for more than a day. No flag changes, no public claims, no production configuration.

## 2026-11-25, the phone said alerts were on for an account that had none

**Bug.** On main, `alertsState` (app `src/phone/push.ts`) answered "on" whenever notification permission was granted and the browser held any push subscription. It never asked the server. So the Alerts, Computer and Production routes said this phone gets alerts, and hid the offer to turn them on, in these cases:

- another account signed in on the same phone;
- the server refused the registration (no plan that allows alerts, push switched off), but the browser subscription stayed;
- the browser rotated the subscription's endpoint or keys (`pushsubscriptionchange`), or the subscription expired;
- the stored registration was removed on the server.

**Fix (from the draft, kept as written).**

- Server. `POST /api/notify/subscribe {check: {id, fingerprint}}` (`api/notify/subscribe.ts`) answers `{subscribed}` for the signed-in account. `hasPushSubscription` (`api/_lib/web-push.ts`) reads only the record with that lookup ID, refuses an expired record (also one that expires during the read), and compares a SHA-256 of the stored endpoint and keys with `timingSafeEqual`. `parsePushSubscriptionCheck` takes exactly a 22-character base64url ID and a 64-character lowercase hex digest, so a passive check never carries the raw subscription. Checks have their own rate-limit counter (`notify-subscribe-check`, 30 an hour), so they never use the registration budget.
- Shared. `packages/schema/src/push-subscription.ts` holds the ID length and the ordered fingerprint input, so the phone and the server hash the same thing.
- Phone. `alertsState(deps, session)` sends the check for the current subscription, then reads the subscription and permission again: a reply for a subscription that changed during the request reads as off. A failed check is "unknown", never "on", and changes nothing. `turnOnAlerts` replaces an expired subscription. `useAlertsState` rechecks when the controlling worker signals a change, when a new worker takes control, and when the page comes back into view.
- Worker. `sw.ts` handles `pushsubscriptionchange` by posting only an invalidation to the phone pages it controls. It has no session, so it does not re-register; turning alerts back on stays a tap in Alerts.
- Routes. Alerts shows "Checking…", and "could not check" with Try again; "Turn off" is offered when on or unknown. Computer and Production offer alerts only once the check answers "off".

**Tests.**

- app `src/phone/push.test.ts`, "checking alert status" (7 cases) and "a refusal to register a subscription already present in the browser leaves this account off".
- app `src/phone/alerts.test.ts`, "a browser subscription change sends only an invalidation to controlled phone pages".
- app `test-browser/phone-alert-state.test.ts`, "the foreground checks the current account on worker invalidation and on return".
- web `test/phone-notify-status.test.ts` (3 cases), run on pull requests by `vector-free-models.yml` ("Check phone alert registration status"). Root `test/web-push.test.ts` still passes (26).
- The app cases run in `test.yml`'s unit jobs (`bun turbo test`, the app's `test:unit` and `test:browser`).

**Red before.** With the fix's source files (`push.ts`, `sw.ts`, `config.ts`, the three routes, `web-push.ts`, `subscribe.ts`) put back to origin/main: `push.test.ts` 7 fail, 7 pass (the main-branch "on" for an unregistered account); `phone-notify-status.test.ts` 3 fail; `phone-alert-state.test.ts` and `alerts.test.ts` fail to load. With only `sw.ts` put back, the worker case fails (6 pass, 1 fail). Restored, all pass.

**Mutation checks.**

- `hasPushSubscription` answering true without comparing the fingerprint: the web "only the same account and exact current endpoint and keys" case fails (2 pass, 1 fail).
- Checks counted under the registration scope again: the same case fails.
- In `useAlertsState`: dropping the controlling-worker source check, the visible-only check, the `controllerchange` listener, or the message listener's cleanup each fails the browser case.

## 2026-11-25, takeover changes: the browser test could not see a stray worker message

**What was wrong.** In the draft's browser test, the message from a non-controlling source was dispatched in the same tick as the controller's. Solid's `createResource` ignores a second `refetch` in the same tick, so the test passed even with the source check removed. The visibility, `controllerchange` and cleanup paths were not checked either.

**Change.** Tests only. The browser case now waits after the stray message and asserts no check started; it checks that going into the background starts no check, that a new controlling worker rechecks, and that after the route is disposed no message, worker change or return starts a check. The web case asserts that passive checks use their own rate-limit counter. The app's `tsconfig.json` now lists the browser test, so `typecheck (app)` covers it. Each mutation above was run against these tests.

## Left for the owner and follow-ups

- Real push delivery on iPhone and Android stays a device qualification; nothing here sends a real push.
- The routes' new states are not rendered in a component test; the logic they show lives in `alertsState` and `useAlertsState`, which are tested.
- Passive checks share one 30-an-hour limit per account across route opens and returns. A heavy user can reach it, and the Alerts page then says it could not check (Try again, Turn off). Raise the limit or cache the answer briefly if that shows up.
- The PR's `test` workflow run was cancelled before any job got a runner; it needs a fresh run on the pushed head.
