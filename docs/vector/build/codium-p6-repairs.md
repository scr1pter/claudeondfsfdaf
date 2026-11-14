# P6 phase review repairs (A37 to A43)

These repairs answer the P6 phase review ("services and remote") on `codium-wt`. Each finding was checked against the
code first, and all four were confirmed. Each repair has a regression test that fails against the previous source. The
owner's pending decisions are unchanged: Vector Labs on the pricing page, the Oct 30 model lineup and the investors
page claims. No service, account, deployment or provider was called, nothing was pushed, and no cloud-agent file was
touched. Contract readings are in `codium-deviations.md` ("P6 review decisions").

## A38/A41 phone alerts

**Settings promised alerts never show code or prompts.** Confirmed. `alertTitle("Finished", session.title)`,
`alertTitle("Needs you", sessionTitle)` and the Run Guard alert all carry the session's name. A new session's name is
the first line of its first message (cut to 50 characters, `provisionalOf` in the engine's `session/prompt.ts`) until
the model's title replaces it, and for a greeting or a failed title request it stays. The alert is still sealed end to
end (P7), but the promise was false. **Repair:** `PHONE_ALERT_CONTENT` in `settings-v2/notifications-model.ts` says
"Alerts show a short title, such as the session's name, sealed so only your paired phones can read it.", and
Settings → Notifications uses it. The phone's Alerts page said "never your code" in two states and now says the title
is such as the session's name. Regression (`packages/app/src/context/phone-alerts.test.ts`): an alert title carries
what was typed, the shared wording names the session's name, and neither page's source promises that code or prompts
stay out.

## A39 relay

**Erase wiped the revocation time and the used ticket ids.** Confirmed. `erase()` ran `deleteAll()` and the schema
again, so a ticket issued in the five minutes before the erasure passed `standing()` afterwards, even one already used.
It wrote `meta.account` (before the standing check), the plan and its device row, and started meters again. A computer
admitted that way could stay up to a day. **Repair:** `erase()` keeps the unexpired `seen` rows (random ids) and writes
`revoked_before` = the erasure time plus the 60 s ticket skew, so a ticket from an issuer whose clock runs a little ahead
is also refused. `connect()` writes the account handle only once a ticket passes the standing check. Regression
(`packages/relay/test/relay.test.ts`): after an erase the object holds only `revoked_before` and the used ids, and the
closes that arrive later add nothing. A used ticket gets 401, while an unused ticket and one issued 30 s ahead are
closed `REMOTE_REVOKED`. No device row, account handle or meter comes back. A ticket issued after the skew connects as
any first device does. The CI smoke (`e2e/relay-smoke.ts`) now also opens a ticket minted before the erase and expects
`REMOTE_REVOKED`.

## A39/A40 tickets

**Tickets carried a server-only limit.** Confirmed. `ticketClaims` put `REMOTE_LIMITS.viewerHours[plan]` into the
claims, and any client can decode a ticket's middle segment. §4.2 keeps viewer-hours on the server, and they are not in
ENTITLEMENTS. **Repair:** the claim is now `rank` (ENTITLEMENTS rank, 1 to 4, public). The relay reads the hours from
`VIEWER_HOURS` (by rank) in `packages/relay/src/limits.ts`. Clients import only `protocol.ts`, which imports nothing.
`decodeClaims` accepts ranks 1 to 4 only. `AccountRelay` stores the rank in its plan and compares it when a newer
ticket arrives. Regressions: `test/remote-ticket-api.test.ts` checks that each plan's ticket carries its computers and
rank and exactly the expected claim names, with no `viewerHours`. `test/remote-relay-contract.test.ts` keeps
`VIEWER_HOURS[rank]` equal to `REMOTE_LIMITS.viewerHours[plan]` for every plan. `packages/relay/test/source.test.ts`
checks that `protocol.ts` imports nothing. The fair-use cases give rank 1 a one-hour table through the harness, as they
gave `viewerHours: 1` before, and an upgrade moves to rank 3.

## A38 phone sign-in

**The signed-out page showed any `error_description` from the address.** Confirmed. `boot()` showed up to 200
characters of it whether or not this phone had started a sign-in, so anyone could put their own text inside Vector's
phone app with a link. **Repair:** `googleSignInFailed(storage)` in `phone/auth.ts` answers the fixed
`GOOGLE_SIGN_IN_FAILED` ("Google sign-in did not finish. Try again.") only while this phone's PKCE verifier is pending,
and forgets the verifier. The address's text is never read (`error` or `error_description` only marks a failure).
Regression (`packages/app/src/phone/auth.test.ts`): without a pending verifier nothing is said, and with one the fixed
words are said once. `app.tsx` reads neither parameter's value.

## Tests run here (one file at a time)

| Package | File | Result |
| --- | --- | --- |
| relay | `test/relay.test.ts` | 14 pass |
| relay | `test/fair-use.test.ts` | 8 pass |
| relay | `test/ticket.test.ts` | 9 pass |
| relay | `test/routing.test.ts` | 9 pass |
| relay | `test/source.test.ts` | 7 pass |
| relay | `test/internal.test.ts` | 11 pass |
| relay | `test/idle.test.ts` | 12 pass |
| relay | `test/limits.test.ts` | 13 pass |
| root | `test/remote-relay-contract.test.ts` | 7 pass |
| root | `test/remote-ticket-api.test.ts` | 29 pass |
| root | `test/remote-phone-api.test.ts` | 8 pass |
| app | `src/context/phone-alerts.test.ts` | 6 pass |
| app | `src/phone/auth.test.ts` | 10 pass |
| app | `src/components/settings-v2/notifications-model.test.ts` | 4 pass |
| app | `src/phone/phone.test.ts`, copy and CSP cases only (`-t`), not the bundle walk that starts a second process | 2 pass |

Typecheck: `packages/relay` `tsgo --noEmit` clean (src, test, e2e); root `tsconfig.json` (api) clean; `packages/app`
`tsgo -b` clean.

**CI only:** `packages/relay/e2e/relay-smoke.ts` under `wrangler dev --local` (its erase check is extended here), and
the phone bundle walk in `phone.test.ts` and `browser-bundle.test.ts`.

Edits to `api/_lib/model-plan-*.ts`: none.
