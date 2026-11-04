# A39 Remote relay Worker: implementation record

A39 builds on A37 (the internal HMAC). It adds `packages/relay`, a Cloudflare Worker with one Durable Object per account. No Cloudflare account, API or deployment was touched. The tests drive the Worker and the object with an in-memory runtime whose SQL runs on a real SQLite engine. The CI lane runs the same code on Cloudflare's local runtime. Readings of the contract are in `codium-deviations.md` under "A39 Remote relay Worker (3 Nov 2026)".

## What changed

| Area          | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker        | `src/index.ts`. `GET /v1/connect` takes the ticket from `Sec-WebSocket-Protocol` next to `vector.v1` and answers with `vector.v1` alone. It then checks the ticket, reads the kill flag and forwards a fresh request (the upgrade and the ticket only) to the account's object, `idFromName(HMAC(ACCOUNT_KEY, account))`. `POST /internal/v1/<action>` checks A37's signature and forwards the body and nonce to the account's object, or to a `control` object for `flags`. `GET /health`. Anything else is 404.                                                                                                                        |
| Tickets       | `src/ticket.ts`: `vt1.<payload>.<signature>`, Ed25519 over `vector-relay-ticket-v1.` plus the payload. Claims: `aud: "vector-relay"`, account, role, device id (16 random bytes), optional name and public key, the plan's `computers` and `viewerHours`, a hashed meter `epoch`, `periodEnd`, `iat`/`exp` (at most 300 s apart, `iat` at most 60 s ahead), `jti` (used once). `TICKET_PUBLIC_KEYS` holds up to four raw public keys, for rotation. `signTicket` is exported for the API (A40).                                                                                                                                          |
| Internal API  | `src/internal.ts` is A37's canonical string and derived key on WebCrypto. Actions: `kill {account, before?}` (revokes connections and tickets issued before it), `suspend {account, suspended, reason, at}` (ordered by `at`), `presence {account}` (`isComputerOnline`), `devices {account}`, `revoke-device {account, device}`, `erase {account}` (P5) and `flags {kill}`. `job-offer` answers 501 after the signature check. Nonces are kept 600 s by the object that handles the call.                                                                                                                                               |
| Object        | `src/account-relay.ts`, with hibernating WebSockets tagged by role and device. Heartbeats go through `setWebSocketAutoResponse("ping","pong")`. SQLite tables: `meta`, `devices`, `meters` (per epoch, kept until 40 days past `periodEnd`) and `seen` (ticket ids and nonces). Binary frames carry `[kind][16-byte device][ciphertext]`. The relay swaps the target id for the sender's and passes the ciphertext on byte for byte. A frame goes only from a phone to a computer, or from a computer to a phone. Text frames are control messages: `refresh`, `presence`, and from the relay `hello`, `peers`, `refreshed` and `error`. |
| Caps          | The ticket's computer count and §4.2's five phones, counted in pairing order. A newer ticket with fewer computers closes the computers paired last. One connection per device (a newer one replaces it). Frames of at most 64 KiB, 1009 above that. 20 frames a second with a burst of 40; more than 100 refusals in 10 s close the connection. Control text up to 8 KiB.                                                                                                                                                                                                                                                                |
| Sleep         | The alarm exists exactly while a phone is attached (every 60 s). It checks the kill flag, silent sockets (no heartbeat for 75 s), viewer tickets (closed 60 s after expiry unless refreshed in-band), idle viewers (no data frame for 30 minutes) and fair use. With no phone attached, a computer's data frames are dropped, and 20 within 60 s close it.                                                                                                                                                                                                                                                                               |
| Fair use      | Viewer time runs while at least one phone is attached. Its start is stored, so it survives hibernation. It is written at most once a minute while phones stay, and once when the last one leaves. Awake time estimates billed time: each event adds the gap since the last one, up to the 10 s idle tail. Viewer-hours used up closes and refuses phones for the rest of the epoch. Awake time over 1.5 times the viewer-hours closes and refuses everyone.                                                                                                                                                                              |
| Plan          | The caps and epoch come from the newest ticket by `iat`. An older ticket presented late never undoes them. A new epoch writes the old one's time first and starts the meters over.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Kill flag     | KV `REMOTE_FLAGS`, key `kill`, value `1`. It is read on every connection, every refresh and every alarm. A flag that cannot be read counts as set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Protocol      | `src/protocol.ts` is pure, so A41 and A42 can import `@vectordevai/relay/protocol`. It holds the subprotocol, frame layout, `encodeFrame` and `decodeFrame`, close codes 4000 to 4011 (named reasons) and the message types.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Runtime types | `src/runtime.ts` declares only the Workers APIs the relay uses, so the package needs no global runtime types. Here it was checked once against `@cloudflare/workers-types` 4.20251008.0 (`latest` and `2023-07-01`) in a scratch config, with no errors.                                                                                                                                                                                                                                                                                                                                                                                 |
| Config        | `wrangler.jsonc`: `vector-remote-relay`, `AccountRelay` with a `new_sqlite_classes` migration, KV `REMOTE_FLAGS` (placeholder id), `workers_dev`, compatibility date 2025-04-01, no vars and no secrets. `package.json` pins `wrangler` 4.50.0, the version already in `bun.lock`.                                                                                                                                                                                                                                                                                                                                                       |
| CI            | `.github/workflows/vector-codium.yml` adds a `relay` typecheck and a `relay` job: `bun run dry-run` (`wrangler deploy --dry-run`), then `bun run smoke` (`e2e/relay-smoke.ts` under `wrangler dev --local` with throwaway keys). The test picker already runs `packages/relay/test/*.test.ts` and the new root test.                                                                                                                                                                                                                                                                                                                     |
| Docs          | `docs/vector/MODEL-PLANS.md` (relay bullet, Worker settings). `docs/vector/owner-actions/remote.md` (new: KV, keys, secrets, deploy, kill flag, rotation, fair use).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Edits to `api/_lib/model-plan-*.ts`: none.

## Interfaces for later packages

- **A40 (Remote API)** mints tickets exactly as `ticket.ts` describes:
  - Sign with `VECTOR_REMOTE_TICKET_SIGNING_KEY` (base64url PKCS#8). `test/remote-relay-contract.test.ts` shows the node:crypto way.
  - `computers` comes from the snapshot's `caps.remote.computers` and `viewerHours` from `REMOTE_LIMITS.viewerHours[plan]`.
  - `epoch` is a base64url hash of `meterEpoch` (16 to 64 characters, so no Stripe id reaches the relay). `periodEnd` comes from the snapshot.
  - A fresh `jti` for every ticket.
  - It calls the internal actions through `internalFetch("relay", …)`: `kill` with the snapshot's `revokedBefore` on revocation, `suspend` on paused and frozen (with `at` = the snapshot version's time), `flags` when the `remote` switch changes, and `devices` and `revoke-device` for `/api/remote/devices`.
  - It builds `isComputerOnline(account)` on `presence`.
- **A41 and A42** use `protocol.ts`. The rules they must follow:
  - Heartbeat `ping` every 25 s.
  - Refresh a phone's ticket in-band before it expires.
  - A computer refreshes when `peers` says `refresh: true`.
  - Send data frames only while a viewer is attached; a phone sends data only on user action, because idle is measured on data.
  - The relay's `wss:` host goes into the phone origin's `connect-src` (A42).
- **A57** calls `erase` for P5.
- **A58** deploys `packages/relay` with `target=relay` and runs the same dry run.

## Tests run here (one file at a time)

| Package | File                                                                                                                                      | Result  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| relay   | `test/ticket.test.ts`                                                                                                                     | 9 pass  |
| relay   | `test/internal.test.ts` (HMAC, internal routes, nonce replay, job-offer 501, the kill flag)                                               | 11 pass |
| relay   | `test/routing.test.ts` (subprotocol, HMAC naming, no client headers forwarded, kill flag, single-use tickets)                             | 9 pass  |
| relay   | `test/limits.test.ts` (computer and phone caps, downgrade, stale tickets, revoke, frame size and rate, replacement)                       | 13 pass |
| relay   | `test/idle.test.ts` (alarm only with a viewer, kill flag on alarm, idle 30 min, heartbeat, in-band refresh, no-viewer close)              | 12 pass |
| relay   | `test/fair-use.test.ts` (viewer time, once-a-minute writes, hibernation, viewer-hours and awake caps, epochs)                             | 8 pass  |
| relay   | `test/relay.test.ts` (ciphertext byte for byte, nothing stored, job.offer reserved, presence, devices, kill, suspend, erase, hibernation) | 13 pass |
| relay   | `test/source.test.ts` (no Bun or Node module in `src/`, no logging, handlers exported, wrangler config holds no secret)                   | 6 pass  |
| root    | `test/remote-relay-contract.test.ts` (A37 HMAC byte for byte both ways, a node:crypto ticket, limits equal to `REMOTE_LIMITS`)            | 6 pass  |
| root    | `test/no-topups.test.ts` (unchanged; the new docs)                                                                                        | 4 pass  |
| cloud   | `src/workflow-compliance.test.ts` (unchanged; the edited lane)                                                                            | 22 pass |

Also run here:

- `wrangler deploy --dry-run` once, with metrics off and no Cloudflare account. It produced a 46.37 KiB bundle with the `AccountRelay` and `REMOTE_FLAGS` bindings and no Bun or Node import. Wrangler checked npm for a newer version of itself ("update available") and uploaded nothing.
- `bun install --ignore-scripts`, once, to link the workspace. No new package versions came in.

Typecheck: `packages/relay` `tsgo --noEmit` is clean. No other package's source changed, and the root tests sit outside every typecheck config.

**CI only:** `e2e/relay-smoke.ts` under `wrangler dev --local`. It checks the handshake answers `vector.v1`, the runtime answers `ping`, ciphertext of 4 KiB and 64 KiB passes byte for byte, revoke and kill close sockets and refuse tickets issued before them, the kill flag turns the relay off and on, erase leaves no device, and `job-offer` answers 501. The rules forbid `wrangler dev` on this Mac. It also covers what the fakes cannot: workerd's hibernation, its `getWebSocketAutoResponseTimestamp`, SQLite after `deleteAll`, and plain-class Durable Objects.

## Owner steps this needs

These are in `owner-actions/remote.md`:

- Workers Paid and budget alerts.
- Create the `REMOTE_FLAGS` namespace and put its id in `wrangler.jsonc`.
- Generate the ticket key pair. The private half goes to Vercel and the public half to `TICKET_PUBLIC_KEYS`.
- Set `INTERNAL_SECRET` (the value of `VECTOR_HOSTED_INTERNAL_SECRET`) and a permanent `ACCOUNT_KEY`.
- Deploy through A58's workflow.
- Set `VECTOR_REMOTE_RELAY_URL` (A40).

## Not done

- The API side: `api/_lib/remote-ticket.ts`, the routes, the `remote` provisioner and `isComputerOnline(account)` belong to A40. Nothing calls the relay yet.
- `.env.example` gets `VECTOR_REMOTE_TICKET_SIGNING_KEY` and `VECTOR_REMOTE_RELAY_URL` with A40, which reads them.
- Pairing (QR, transcript HMAC, keys), approvals and passkeys are end to end between the phone and the desktop (A41 and A42). The relay only counts pairings and passes ciphertext.
- The phone CSP's relay host is added in A42.
- The deploy workflow is A58.
- No custom domain is configured, and the relay's host name is the owner's choice.
- `bun.lock` gains the `packages/relay` workspace and bun's re-hoisting of `@sindresorhus/is`, with no new versions. It also now carries the desktop's `1.99.112` version line, which had been pending in the worktree since before A29: frozen installs need the lock to match the committed manifests. Nothing was pushed.
