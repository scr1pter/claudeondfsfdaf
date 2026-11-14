# A37: Shared service plumbing and push

A37 follows the P5 review (`0cef8b91`) and implements the contract's WP A37 on top of A05 (the entitlement snapshot).
No schema, protocol or generated client changed, so no generator ran. No service, account, deployment or provider was
called; the push services, the store and Supabase are fakes in the tests.

## What changed

- **`api/_lib/safe-fetch.ts` (new, S8).** `safeFetch(url, init, options)` for every fetch the server makes on someone's
  behalf (push endpoints now; domain verification in A47 later).
  - `https:` only, port 443 unless the caller widens it, no credentials in the URL.
  - Host names refused before any lookup: `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.arpa`, `*.home`,
    `*.lan`, `*.intranet`, `*.localdomain`, the metadata names, and any single label.
  - The host is resolved and refused when any of its addresses is not public. That covers private, loopback,
    link-local, carrier-grade NAT, documentation, benchmarking, multicast and reserved IPv4 ranges, plus Azure's
    168.63.129.16. IPv6 is allowed only in 2000::/3, minus 2001::/23, 2001:db8::/32, 2002::/16 and 3fff::/20. An
    IPv4-mapped address is judged by its IPv4 part. URL forms like `2130706433` or `0x7f.0.0.1` are normalised by the
    URL parser first.
  - The connection goes to the address that was checked (`node:https` with the IP as host, the name as TLS server name
    and Host header), so DNS rebinding cannot change the target.
  - A 3xx answer (except 304) is an error, never followed. Defaults are 10 s and a 64 KiB answer cap.
  - The resolver and the connection can be replaced (tests).
- **`api/_lib/web-push.ts` (new).**
  - VAPID: settings `VECTOR_VAPID_PUBLIC_KEY` (65-byte point), `VECTOR_VAPID_PRIVATE_KEY` (32-byte scalar,
    zero-padded if a tool dropped leading zeros) and `VECTOR_VAPID_SUBJECT` (`mailto:` or `https:`). The keys must
    match. `vapidAuthorization` signs an ES256 JWT through `jose`: audience is the endpoint's origin, 12-hour life,
    header `vapid t=…, k=…`.
  - RFC 8291 encryption with `node:crypto`: a new P-256 key pair and salt per message, one 4096-byte aes128gcm
    record, at most 3,993 bytes of plaintext.
  - Subscriptions are stored in `notify:subs:<account>` under the Codium prefix (§4.6). It is a hash: the field is
    the first 22 characters of base64url(sha256(endpoint)), the value is `{id, endpoint, p256dh, auth, createdAt,
expiresAt?}`. At most ten per account; an eleventh replaces the oldest, and the same browser registering again
    replaces itself. The hash expires 400 days after the last registration or successful delivery.
  - Only endpoints of the browsers' own push services are taken: Google (`fcm.googleapis.com`,
    `android.googleapis.com`), Mozilla (`*.push.services.mozilla.com`), Apple (`web.push.apple.com`,
    `*.push.apple.com`) and Microsoft (`*.notify.windows.com`), https on 443. Keys must be a point on P-256 and a
    16-byte secret.
  - Payloads (what the phone app's service worker decodes): `{v:1, kind:"e2e", c, k?}` for a desktop alert (`c` is
    the desktop's ciphertext, `k` which phone key opens it) and `{v:1, kind:"title", title, tag?}` for a server
    alert. A title is at most 120 characters on one line; a tag is a lower-case word.
  - `deliverPush` sends to up to ten phones in parallel through `safeFetch` (TTL 12 h, `urgency`). A 404 or 410
    deletes that subscription; other failures keep it.
  - `requirePushPlan`: active, or renewing within grace (§4.4 Phone alerts row, through `requireUsableSnapshot`).
    `allowPaused` is for On Call, which §4.4 keeps alerting through Stripe's retry window.
  - `requirePushService` gives 503 `PUSH_UNAVAILABLE` without VAPID keys or while the `push` switch is off.
  - `sendServerAlert(account, {title, tag?})` sends titles only (P7). It answers `{skipped}` instead of throwing when
    push or the plan does not allow it, so a service's own work never stops over an alert.
  - `eraseAccountPushSubscriptions` deletes under both the live and the test prefix, ready for A57.
  - `pushConfigured()` and `phoneAppOrigin()` are exported for A38 and A40.
- **`api/notify/subscribe.ts` (new).**
  - `GET` answers `{publicKey}`, or 503 until push is configured.
  - `POST {subscription}` needs a website session (Supabase bearer), sent from the site or from
    `VECTOR_PHONE_APP_ORIGIN`. It also needs push configured and on, and an active or renewing plan from the snapshot
    (S1). 30 an hour per account.
  - `DELETE {endpoint}` works whatever the plan, so alerts can always be turned off.
- **`api/notify/send.ts` (new).** `POST {ciphertext, key?, urgency?}`.
  - Only the desktop app's own sign-in: a `vct_` token marked `desktop`. CLI-marked and unmarked tokens get 403
    `DESKTOP_SIGN_IN_REQUIRED`; run tokens, sessions and missing tokens get 401 (S3).
  - 60 an hour per account.
  - Only ciphertext: base64url of at most 3,072 characters that decodes to at least 29 bytes. Any other field (a
    title, a body, a message) gives 400 `PUSH_CIPHERTEXT_REQUIRED`; an over-long one gives 413
    `PUSH_CIPHERTEXT_TOO_LARGE`.
  - Plan and service as for subscribing. The answer is `{sent, failed, removed}`.
- **`api/_lib/hosted-internal.ts` (new).** The signed-call scheme between this server and the relay, ops and hosted
  services, in both directions.
  - Headers: `x-vector-internal-timestamp` (seconds), `-nonce` (22 to 64 base64url characters) and `-signature`
    (base64url HMAC-SHA256).
  - The canonical string is `vector-internal-v1`, the service, the METHOD, the path with its query, the timestamp, the
    nonce and the hex SHA-256 of the body, one per line. The module comment gives it exactly, for the Workers'
    `internal.ts`.
  - The key is HMAC(secret, `vector-internal-v1/<service>`). `relay` and `hosted` share `VECTOR_HOSTED_INTERNAL_SECRET`
    under different derived keys; `ops` uses `VECTOR_OPS_SHARED_SECRET`. Each secret is at least 32 characters.
  - The receiver allows 300 s of skew. It checks the nonce last, so a forged request cannot use one up, and remembers
    each nonce for 600 s (`internal:nonce:<service>:<nonce>`, SET NX PX). It fails closed when the store is down.
  - `internalFetch` sends `redirect: "error"` with a 10 s timeout, to https only (plain http only to localhost
    outside production).
  - `requireInternalRequest` reads and checks a route's raw body. Such a route must export
    `config = { api: { bodyParser: false } }`.
- **`api/_lib/r2-presign.ts` (new).**
  - `presignR2(bucket, {method, key, expiresIn ≤ 900, contentLength, contentType?})` gives a path-style
    `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>` URL, region `auto`, `UNSIGNED-PAYLOAD`.
  - A PUT must sign its `content-length` (0 to 5 GiB) and may sign `content-type`. GET, HEAD and DELETE sign only the
    host.
  - Keys are letters, digits, `.`, `_`, `-` and `/` between non-empty segments, never `.` or `..`, up to 1,024
    characters.
  - Settings: `VECTOR_R2_ACCOUNT_ID` and `VECTOR_R2_{VAULT,MEDIA}_{ACCESS_KEY_ID,SECRET_ACCESS_KEY,BUCKET}`. Buckets
    default to `vector-vault` and `vector-media`. 503 `R2_UNAVAILABLE` until configured.
  - `presignSigV4` is the generic signer underneath.
- **`api/_lib/codium-provisioners.ts`.** The `push` stub is replaced. The provisioner is configured while the VAPID
  keys are, and erases the subscriptions when the account closes (P5). Sends read the snapshot themselves, so no other
  state needs converging. With no VAPID keys in a test it stays unconfigured, so the outbox expectations do not change.
- **`api/_lib/abuse.ts`.** `requireTrustedJsonRequest` takes an optional list of extra origins, for the phone app's
  origin on the subscribe route. Existing callers are unchanged.
- **`.env.example`** lists the new settings, blank, with a one-line command to make a VAPID key pair.
  **`docs/vector/MODEL-PLANS.md`** gains a short section and a configuration line.

## Edits to `api/_lib/model-plan-*.ts`

None.

## Tests

Run one file at a time with `--timeout 30000` from `test/` (the configuration test from `packages/web`):

| File                                                            | Result                       |
| --------------------------------------------------------------- | ---------------------------- |
| `test/web-push.test.ts` (new; RFC 8291 test vector, P7, routes) | 26 pass                      |
| `test/safe-fetch.test.ts` (new; S8 SSRF list)                   | 62 pass                      |
| `test/hosted-internal.test.ts` (new)                            | 12 pass                      |
| `test/r2-presign.test.ts` (new; AWS SigV4 example)              | 7 pass                       |
| `test/codium-outbox.test.ts` (unchanged; provisioner list)      | 18 pass, 2 skip (Valkey, CI) |
| `test/abuse-api.test.ts` (unchanged)                            | 8 pass                       |
| `test/api-module-loading.test.ts` (unchanged)                   | 1 pass                       |
| `test/codium-mode.test.ts` (unchanged; key-prefix grep)         | 18 pass                      |
| `packages/web/test/codium-configuration.test.ts` (unchanged)    | 11 pass                      |

- `web-push.test.ts` reproduces RFC 8291 Appendix A byte for byte. It decrypts every delivered message with its own
  RFC 8291 code, checked against every intermediate value of the appendix, so it sees exactly what a phone receives.
  P7: a desktop alert reaches the phone as `{v, kind:"e2e", c, k}` with the ciphertext untouched, and the push
  service never sees it in the clear. A server alert is `{v, kind:"title", title, tag}` whatever else the caller
  passes. Plaintext fields are refused.
- `r2-presign.test.ts` reproduces AWS's published presigned-GET example signature (`aeeed9bb…`).
- `safe-fetch.test.ts` opens one local TCP socket. It shows the default connection goes to the checked address and
  not to a fresh lookup, and that it times out.

**Not exercised anywhere:** a real push service (Google, Mozilla, Apple, Microsoft) accepting the VAPID token and the
aes128gcm body, and `safeFetch`'s TLS path against a real host. The RFC vectors cover the encryption. A real delivery
needs the phone app (A38) and VAPID keys in a test environment.

Typecheck: root `tsconfig.json` (api) clean with `tsgo --noEmit`. Root tests and `script/` are outside every
typecheck config, as before.

## Contract readings

Recorded in `codium-deviations.md` under "A37 shared service plumbing and push (3 Nov 2026)".

## Not done

- `alerts` gets no readiness check here. §1.2 lists phone alerts once the phone app (A38) ships; A38 adds the check,
  probably `pushConfigured()`.
- The desktop half of "desktop alerts are end-to-end encrypted" (the encryption to the phone's key and the call to
  `/api/notify/send`) is A41's `remote-notify.ts`. The phone's service worker that decodes both payloads is A38.
- No route uses `hosted-internal`, `r2-presign` or `safe-fetch` for its own service yet. Relay, ops, hosted, Vault
  and Playbooks (A36, A39, A44, A46 to A48) build on them.
- A57 should call `eraseAccountPushSubscriptions(account)` from account deletion. The provisioner already erases on
  `closing` while push is configured.
- bun.lock was already modified in the worktree before this work and is not mine; it is left out of the commit.
  Nothing was pushed.
