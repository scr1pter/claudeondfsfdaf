# A42 Remote phone UI and Settings → Remote: implementation record

A42 builds on A41 (the desktop's Remote link, pairing, routes and passkey checks), A40 (tickets, devices, revoke,
kill), A39 (the relay and its wire protocol) and A38 (the phone app shell, its alert-key store and the phone origin's
headers). No relay, account service, push service, Cloudflare or Vercel was called, and nothing was deployed. Readings
of the contract are in `codium-deviations.md` under "A42 Remote phone UI and Settings → Remote (4 Nov 2026)".

## What changed

| Area | Change |
| --- | --- |
| Shared crypto | `packages/core/src/remote/crypto.ts`: A41's `remote-crypto.ts`, moved so the phone runs the same file (the desktop's old path re-exports it). Static private keys may now be non-extractable X25519 `CryptoKey`s (`PrivateKeyInput`); `generateDeviceIdentity()` makes one; `x25519Supported()` tells an old browser apart. Checked once under Node 24.22 after bundling. |
| Desktop | `remote-host.ts` (new) holds the origin, relay name and computer name helpers moved unchanged out of `remote-pairing.ts`, so pairing, link and routes import nothing from Node and run in a browser. `remote-relay.fixture.ts` (new): an in-memory relay that both halves connect to, as `packages/relay` behaves on the wire. |
| Phone client | `packages/app/src/phone/remote/client.ts` (new): tickets from `POST /api/remote/ticket` (role phone, its own device id, a plain name, no key), the relay opened only at the host the CSP names, a ping every 25 s, the ticket refreshed in-band a minute before expiry, one channel per online paired computer (INIT/ACCEPT, the hello handshake with A38's `negotiate`), requests with answers in parts reassembled, watch and unwatch, events to listeners. Pairing: the QR's link (fragment only), the transcript and passkey challenge prepared first, the passkey made from the person's tap, the sealed request, the computer's proof checked, the six digits shown, the computer kept on `pair-done` with its alert key stored through A38's `saveAlertKey`. Allowing once: the computer's challenge, the passkey's assertion, `reply: "once"`; when the browser wants a fresh tap, the challenge is kept for it. Deny is `reply: "reject"`. Close codes: one retry after `REMOTE_REVOKED` (1.5 s later), then "removed"; paused, relay off, device limit, fair use, replaced and idle each say why and do not reconnect by themselves. Forget (this phone only, its alert key too), reset (revokes the old device id, new keys) and sign-out (forgets everything). |
| Phone store | `phone/remote/store.ts` (new): the identity (device id, a non-extractable private key, the public key) and paired computers (device, static key from the QR, name, passkey id, alert key id) in the `vector-phone-remote` IndexedDB database, read leniently. |
| Passkeys | `phone/remote/passkey.ts` (new): WebAuthn through `navigator.credentials`, ES256/EdDSA/RS256, user verification required, `attestation: "none"`, `residentKey: "discouraged"`, a random user handle; `rp.id` is the phone origin's host. |
| Scanner | `phone/remote/scanner.ts` (new): the back camera in a `<video>`, frames read every 200 ms, the browser's BarcodeDetector where it has one, else Vector's decoder. Frames stay on the phone. |
| QR | `packages/app/src/utils/qr/` (new): an encoder (byte mode, versions 1 to 25, level M then L, mask chosen by penalty, an SVG path) and a decoder (format and version bits with error tolerance, Reed-Solomon correction, byte, numeric and alphanumeric segments; from images: local-threshold binarizing, finder patterns from 1:1:3:1:1 runs checked across, down and diagonally, module size along each side, the alignment pattern searched up to 16 modules out, a perspective transform). |
| Phone pages | `routes/pair.tsx` (new): scan or paste, wait for the computer, "Make a passkey and pair", the six digits; in an iOS Safari tab, how to finish in the installed app and a button that copies the link. `routes/sessions.tsx`: each computer's sessions, live; one session's messages (text and tool lines), a text turn, Stop, New session. `routes/approvals.tsx`: pending permissions with Allow once and Deny, questions with their options; "allow it once or deny it", never always. `routes/devices.tsx`: the paired count, the computers paired with this phone (Forget), every device on the account (Remove), Disconnect all. `routes/remote-parts.tsx` (new): the connection notice, a confirm-twice button, rows. `phone/remote/model.ts` (new): what the pages show, as pure functions. `status.ts`: a `pair` page beside the home routes. `app.tsx`: one client per sign-in shared by every page, reconnecting when the person comes back to a Remote page; routes mount through `Dynamic` so a status read again does not remount the open page. `phone.css`: the pages' styles. |
| Settings → Remote | `settings-v2/remote.tsx` (new): Remote on or off, the connection's state, "N of limit computers paired", Pair a phone (the QR code, its time left, the steps), the six digits with "They match" and "They don't match", the paired phones with Remove, Disconnect all phones (asked twice), Start over after a revocation. `remote-model.ts` (new), `settings-remote.css` (new). `settings-registry.ts` (the tab), `dialog-settings-v2.tsx` (shown when the status lists Remote for a plan with paired computers, or when this computer has Remote on or a phone paired). |
| API | `api/_lib/codium-perks.ts`: `remote` is ready once tickets can be minted and `VECTOR_PHONE_APP_ORIGIN` is set. `api/_lib/remote-config.ts` (new): the configuration checks moved out of `remote-ticket.ts` (re-exported). `api/_lib/remote-meter.ts` (new) and `api/model-plans/status.ts`: the `remote` status meter, `{computers, limit}` from the relay's devices against the plan's count. |
| Hosting | `vercel.json`: the phone origin's `connect-src` gains `wss://relay.vectordev.ai`. |
| Package | `packages/app/package.json` gains `@vectordevai/relay` (workspace) for the wire protocol; `bun.lock` gains that one line. |
| Docs | `docs/vector/MODEL-PLANS.md` (a Remote phone bullet, the CSP line), `docs/vector/owner-actions/remote.md` (step 7's relay address, the phone and Settings section). |

Edits to `api/_lib/model-plan-*.ts`: none.

## Ready for the outside security review

What a reviewer should read, in order: `packages/core/src/remote/crypto.ts` (pairing and channel cryptography, shared by
both halves), `packages/desktop/src/main/remote-pairing.ts`, `remote-passkey.ts`, `remote-routes.ts` and `remote-link.ts`
(the computer decides everything: the allowlist, passkey checks with the origin exactly the phone app's, once-only
approvals, phone turns never auto-approved), `packages/app/src/phone/remote/client.ts` and `passkey.ts` (the phone),
`packages/relay/src/*` (sees only public keys and ciphertext), `api/_lib/remote-ticket.ts` (who may connect, from the
snapshot), and the phone origin's headers in `vercel.json`. Points worth their attention:

- The relay's peer list is never trusted for keys: the computer's static key comes only from the QR, the phone's only
  inside the sealed pairing request. The phone also refuses to open a channel to a computer whose listed key differs.
- The phone's static key cannot be exported (a non-extractable `CryptoKey`), but any script running on the phone
  origin could use it while the page is open; the CSP allows scripts from the origin only, no inline script or style,
  no `eval`, and the bundle has no `new Function`.
- A pairing QR photographed by someone else: the six digits on both screens differ unless both saw the same keys and
  passkey, and a second phone answering the same QR stops the pairing.
- Data the phone keeps: its keys, the computers' public keys and names, passkey ids and alert keys, in its own origin's
  IndexedDB. Sign-out deletes all of it.

## Tests run here (one file at a time)

| Package | File | Result |
| --- | --- | --- |
| desktop | `src/main/remote-phone-app.test.ts` (new; the phone's real client and the desktop's real link through the in-memory relay: pairing with matching codes and the alert key, the relay seeing only ciphertext, a mismatched code, a second phone, another origin's passkey, refused links, the allowlist and a 90 KB answer in parts, a phone's turn marked, allow once with the passkey, deny, always and a bare once refused, a passkey that needs a fresh tap, events only while watching, forgetting a computer, an unpairing computer, Disconnect all, revocation twice, the close codes) | 15 pass |
| desktop | `src/main/remote-crypto.test.ts`, `remote-link.test.ts`, `remote-routes.test.ts`, `remote-notify.test.ts` (unchanged but for the link test's import line) | 15, 19, 14, 6 pass |
| desktop | `src/main/vault-secrets.sign-ins.test.ts`, `external-agent-guards.test.ts`, `keep-awake.test.ts` (unchanged; read the edited runtime) | 4, 6, 30 pass |
| core | `test/remote/crypto.test.ts` (new; a non-extractable phone key with a PKCS#8 desktop key, `pair-done` for the paired phone only, wrong key types refused) | 3 pass |
| app | `src/utils/qr/qr.test.ts` (new; ISO block table, the standard's Reed-Solomon example, format and version bits, alignment positions, error correction, round trips of every size and mask, damage, the SVG path, synthetic camera frames turned, tilted, blurred and noisy) | 15 pass |
| app | `src/phone/remote/client.test.ts` (new; ticket body, refresh, refusals, relay address checks, the stored key, reset and sign-out, pairing links) | 7 pass |
| app | `src/phone/remote/model.test.ts` (new) | 18 pass |
| app | `src/components/settings-v2/remote-model.test.ts` (new; the tab's gate, the count, every state's words, search) | 6 pass |
| app | `src/components/settings-v2/settings-registry.test.ts` (the page count is now 17) | 14 pass |
| app | `src/phone/phone.test.ts` (unchanged; CSP-safe sources, copy rules on the new pages, no Node or Bun module in the phone bundle), `status.test.ts`, `alerts.test.ts` (unchanged) | 7, 11, 6 pass |
| root | `test/remote-phone-api.test.ts` (new; readiness, listing and the switch, the meter's counts and failures, registration by the status route, P1, the CSP's one socket host against the phone's) | 8 pass |
| root | `test/phone-app.test.ts` (the CSP expectation now includes the relay), `remote-ticket-api.test.ts`, `api-module-loading.test.ts`, `remote-relay-contract.test.ts`, `no-topups.test.ts`, `no-project-wording.test.ts` (unchanged) | 11, 29, 1, 6, 4, 2 pass |
| web | `test/codium-public.test.ts` (unchanged; listing) | 13 pass |

Two mutations were tried: the phone replying `always` instead of `once` failed two cases of
`remote-phone-app.test.ts`; the tilted-image case of `qr.test.ts` failed until the alignment search tried every nearby
pattern.

Also run here: one `bun run build:phone` (35 modules, 124 KB of script, no `eval` or `new Function`, no inline style),
and the built phone app looked at in the Browser pane at phone size behind the phone CSP with a fake API and a fake
relay that answers `hello`: Devices (the count, the account's devices, Disconnect all), Pair (a pasted link connects and
waits for the computer), Sessions and Approvals (pair first), the home list, with no CSP error. The pane refused to
register the service worker ("unknown error when fetching the script") although the script and its
`Service-Worker-Allowed` header were served; the worker is unchanged since A38, which saw it register.

Typecheck: `packages/app` `tsgo -b` and `tsgo -p e2e/tsconfig.json`, `packages/desktop` `tsgo -b`, `packages/core`
`tsgo --noEmit`, root `tsconfig.json` (api): all clean. No schema, SDK or engine source changed, so no generator ran.

**CI only:** `packages/app/e2e/regression/remote-phone.spec.ts` with `e2e/fixtures/remote-phone.*` (Playwright is not
run on this Mac): Settings → Remote and the phone's Pair and Approvals pages in one page on `localhost`, Chromium's
virtual WebAuthn authenticator making the passkey and signing the approval, the desktop's verifier checking both;
pairing with matching digits, allow once (the authenticator's counter goes up), deny, and a link for another origin
refused. The Codium lane picks every test file this branch added; none has run in CI yet.

**Never exercised anywhere:** a real phone (the camera scanner, an iPhone Home Screen install, a platform passkey), the
real relay on Cloudflare at `relay.vectordev.ai`, and Settings → Remote in the running desktop app (it has typecheck,
model tests and the CI browser spec).

## Owner steps

- Step 7 of `owner-actions/remote.md`: the Worker's custom domain `relay.vectordev.ai` and
  `VECTOR_REMOTE_RELAY_URL=wss://relay.vectordev.ai`, or a different host changed in `RELAY_HOST` and the CSP together.
- The outside security review (contract §8.2 step 16), then `remote` in `CODIUM_LISTED_PERKS`.

## Not done

- The phone cannot choose a model or an agent for its turn, and the engine's V2 runner routes stay unexposed: A41's
  allowlist was not widened.
- The phone's GitHub runs page (`cloud-runs`) still shows A38's shell; its reader is registered in A59.
- The privacy page's `#remote` paragraph is A60's legal read; account deletion's relay erase stays with A57 (the
  provisioner already erases on closing).
- `pushsubscriptionchange` is still not handled (A38's note).
- Nothing was pushed or deployed.
