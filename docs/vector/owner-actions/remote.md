# Vector Remote: the relay

Vector Remote connects a phone to the Vector desktop app through a relay Vector runs on Cloudflare. This page covers the relay Worker (Codium build WP A39), the API that mints its tickets (A40), the desktop side (A41) and the phone screens with Settings → Remote (A42). How it works is in [MODEL-PLANS.md](../MODEL-PLANS.md#phone-alerts-and-shared-service-plumbing). Nothing on this page has been created, deployed or tried against Cloudflare yet.

Remote is listed (`remote` in `CODIUM_LISTED_PERKS`) only after the outside security review (contract §1.2), and only once A40 to A42 have shipped.

## What the relay holds

- **The paired devices** of each account: a random device id, computer or phone, the name shown in Settings, the device's public key, and when it paired and was last seen. A revoked device keeps only its id, so it cannot come back under that id.
- **Time meters** per billing period: how long a phone was watching, and how long the relay was awake. They apply the fair-use caps. They are kept 40 days past the period's end.
- **Nothing a phone and a computer say to each other.** That is encrypted end to end; the relay passes it on and keeps none of it.

Each account has its own Durable Object, named by an HMAC of the account id, so the relay never stores the account id itself. Account deletion calls `erase`, which deletes everything that account's object holds (A57 wires this in).

## One-time setup (owner steps 11 and 12)

Run these from `packages/relay`, signed in with `wrangler login` to the Cloudflare account that will run the Workers. Never put a key in this repository, a chat or a ticket.

1. **Workers Paid** on that account, with a Budget Alert and billable-usage notifications (contract §6.1).
2. **The kill-flag namespace:**

   ```sh
   bunx wrangler kv namespace create REMOTE_FLAGS
   ```

   Put the id it prints in `wrangler.jsonc` in place of the zeros, and commit that change. The id is not a secret.

3. **The ticket key pair.** The API signs tickets with the private half and the relay checks them with the public half:

   ```sh
   node -e 'const k=require("node:crypto").generateKeyPairSync("ed25519");console.log("VECTOR_REMOTE_TICKET_SIGNING_KEY="+k.privateKey.export({format:"der",type:"pkcs8"}).toString("base64url"));console.log("TICKET_PUBLIC_KEYS="+k.publicKey.export({format:"jwk"}).x)'
   ```

   Set `VECTOR_REMOTE_TICKET_SIGNING_KEY` in Vercel, Production only (A40 reads it). Give the relay the public half:

   ```sh
   bunx wrangler secret put TICKET_PUBLIC_KEYS
   ```

4. **The internal secret.** The relay checks the API's calls with the same value as Vercel's `VECTOR_HOSTED_INTERNAL_SECRET` (at least 32 characters; make one with `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'` if it is not set yet):

   ```sh
   bunx wrangler secret put INTERNAL_SECRET
   ```

5. **The account key,** a new random value made the same way. Keep it for good: changing it starts every account's relay over, with no paired devices.

   ```sh
   bunx wrangler secret put ACCOUNT_KEY
   ```

6. **Deploy** with the hosted deploy workflow (WP A58, `target=relay`), from protected main, once it exists. The Codium CI lane already runs `wrangler deploy --dry-run` and a smoke test under `wrangler dev --local` on every push.
7. **Give the relay its address and tell the API:** the phone app connects only to `wss://relay.vectordev.ai` (A42: the phone origin's content security policy in `vercel.json` and `RELAY_HOST` in `packages/app/src/phone/remote/model.ts` both name it). Add `relay.vectordev.ai` to the Worker as a Workers custom domain (Workers → `vector-remote-relay` → Settings → Domains & Routes), which needs the `vectordev.ai` zone on this Cloudflare account. Then set `VECTOR_REMOTE_RELAY_URL=wss://relay.vectordev.ai` in Vercel, with no path. The API calls the relay's internal actions on the same host over https. If the zone is not on Cloudflare, use the Worker's own `wss://vector-remote-relay.<your-subdomain>.workers.dev` instead and change `RELAY_HOST` and the CSP's `connect-src` together in one commit; `test/remote-phone-api.test.ts` fails when they disagree. A phone app whose CSP does not name the relay's host cannot connect at all, and it says the relay is not one it may reach.
8. **Turn the API on:** set `VECTOR_REMOTE_ENABLED=true` in Vercel, Production only, and redeploy. Until then no ticket is minted, whatever the switch says. The `remote` switch on `/owner/codium` then turns Remote off and on without a redeploy.

Without its three secrets the relay answers 503 and admits no one; with a malformed `TICKET_PUBLIC_KEYS` it admits no one either.

## Turning it off

- **Normally:** the `remote` switch on `/owner/codium`. The API then stops minting tickets and sets the relay's kill flag. The answer says `relay: "updated"`; `relay: "failed"` means the relay could not be reached: apply the switch again, or set the flag directly as below.
- **Directly, if the API cannot reach it:**

  ```sh
  bunx wrangler kv key put --binding REMOTE_FLAGS --remote kill 1
  ```

  The relay reads the flag on every new connection, every ticket refresh and every minute while a phone is attached, so phones are closed within about two minutes (the flag can take up to a minute to reach every Cloudflare location). If the flag cannot be read, the relay acts as if it were set. To turn the relay back on, delete the key:

  ```sh
  bunx wrangler kv key delete --binding REMOTE_FLAGS --remote kill
  ```

## Rotating the ticket key

1. Make a new pair as in step 3.
2. Set `TICKET_PUBLIC_KEYS` to the old and new public keys, comma-separated, and wait for the deploy.
3. Change `VECTOR_REMOTE_TICKET_SIGNING_KEY` in Vercel to the new private key and redeploy.
4. Ten minutes later, set `TICKET_PUBLIC_KEYS` to the new key alone. Tickets live at most five minutes.

## Fair use

Each account gets the plan's paired computers (1, 3, 5, 5) and up to five phones, counted in the order they paired; viewer time each period up to the plan's viewer-hours (60, 100, 200, 200); and relay awake time up to one and a half times that. When the viewer-hours are used up, phones are closed and refused until the next period while computers stay connected; when the awake time is used up, everything is. A phone that sends no data for 30 minutes is closed, and the app reconnects when its user comes back.

## What the API does (A40)

- **Tickets.** `POST /api/remote/ticket` signs a five-minute ticket for one connection. A computer needs the desktop app's own sign-in, a phone a website session from the phone app's origin (`VECTOR_PHONE_APP_ORIGIN`). The plan must be active or renewing within grace; the paired-computer count and viewer-hours come from the plan, never from the device.
- **Plan changes.** The `remote` provisioner follows the plan cache through the outbox: a paused or frozen plan suspends the account at the relay (every connection closes and new ones are refused), a recovered plan lifts it, an ended plan closes connections from earlier tickets, and account deletion erases what the relay holds for the account. A call the relay does not answer is retried by the outbox, then dead-lettered with an owner alert.
- **Revocation.** Revoking an account's tokens (account deletion does) also closes its relay connections. If the relay cannot be reached then, the account still cannot mint a ticket, and a phone is closed within a minute of its ticket's expiry.
- **Devices.** `GET /api/remote/devices`, `POST /api/remote/devices/:id/revoke` and `POST /api/remote/kill` ("Disconnect all") work whatever the plan, so devices can always be removed.
- **GitHub runs.** `GET /api/remote/cloud-runs` lists the account's runs of Vector's GitHub agent from the run records Codex's GitHub work keeps. It lists nothing until the integration commit (A59) registers that reader.

## The desktop's side (A41)

Nothing to configure. Remote is off on each computer until its owner pairs a phone (Settings → Remote, A42) or turns it on. The desktop asks `POST /api/remote/ticket` for a computer ticket with its own sign-in, connects to the `url` the answer names, and sends the relay only public keys and sealed bytes. The relay lists a computer as "Mac", "Windows PC" or "Linux computer"; the computer's own name travels only end-to-end encrypted, or in the QR code on its screen. A packaged desktop always uses `https://remote.vectordev.ai` as the phone app's origin for passkeys and pairing links; a development build may name another with `VECTOR_PHONE_APP_ORIGIN` in its environment.

"Disconnect all phones" on a computer calls `POST /api/remote/kill` (every connection of the account closes, other computers reconnect by themselves) and revokes that computer's old device id, so its place under the plan's computer count is freed.

## The phone and Settings → Remote (A42)

Nothing to configure beyond step 7's relay address and the phone app's own steps (`remote.vectordev.ai` on Vercel, `VECTOR_PHONE_APP_ORIGIN`, the account service's redirect URL; see A38's notes). What people do:

- **On the computer:** Settings → Remote turns Remote on, shows "N of limit computers paired" from the account's status (`meters.remote`), and pairs a phone: a QR code of the pairing link, good for five minutes, then the six digits the phone shows, which the person confirms with "They match". It lists the paired phones (Remove unpairs one from this computer) and has "Disconnect all phones". The tab shows when the plan includes Remote while it is listed, or when this computer already has Remote on or a phone paired, so Remote can always be turned off.
- **On the phone (installed app on iPhone and iPad):** Devices → Pair a computer scans the QR code with the camera inside the app (or takes the link pasted), makes a passkey for that computer, and shows the six digits. Sessions lists each paired computer's sessions and opens one to read it live, send a text turn or stop it. Approvals lists what agents ask: Allow once (the phone's passkey, checked by the computer) or Deny; never "always". Devices lists every device on the account from the relay, removes one for good, and has "Disconnect all".
- **Removing devices:** removing a computer or phone on the phone's Devices page revokes its relay id for good; it pairs again under a new id. Removing this phone starts it over with new keys. "Disconnect all" closes every connection on the account; paired devices reconnect the next time they are used.

**Before listing `remote`** (`CODIUM_LISTED_PERKS`): the outside security review (contract §1.2 and §8.2 step 16). Remote becomes listable once step 7 and step 8 are done and `VECTOR_PHONE_APP_ORIGIN` is set; listing it is a separate, deliberate step.
