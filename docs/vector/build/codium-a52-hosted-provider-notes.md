# A52: Provider adapter and reconciler

A52 builds the code that starts, stops and lists cloud computers at the provider, and the reconciler that stops any
computer nobody's session pays for (M9). It builds on A51 (the ledger's running blocks and `hostedAccount`). Vercel
Sandbox is the provider, behind `VECTOR_HOSTED_PROVIDER`; Cloudflare is an interface stub. No provider, store, Stripe,
OpenRouter or other service was called: the SDK and the store are fakes in the tests. Nothing was deployed or pushed.

## What changed

| Area | Files |
|---|---|
| Interface and reconciler | `api/_lib/hosted-provider.ts` (new): the `HostedProvider` interface, provider selection, computer names, the deny list, `computerConfig`, `startHostedComputer`, `setHostedRunToken`, `stopHostedComputer`, `eraseAccountComputers`, `reconcileHostedComputers`, `hostedProviderProblems` / `hostedProviderConfigured`, `hostedRunHost` |
| Vercel | `api/_lib/hosted-provider-vercel.ts` (new): the adapter over `@vercel/sandbox`, its settings check, the network policy, create and update parameters, the SDK's error codes |
| Cloudflare | `api/_lib/hosted-provider-cloudflare.ts` (new): a stub that is never configured and refuses every call |
| Dependency | root `package.json`: `@vercel/sandbox` 3.8.0 (published 2026-10-13); `bun.lock` |
| Schema | `packages/schema/src/hosted.ts`: `Hosted.VIEWER_PORT` (6080) and `Hosted.RUN_API_HOST` (`hosted-run.vectordev.ai`) |
| Settings | `.env.example`: `VECTOR_HOSTED_PROVIDER`, `VECTOR_HOSTED_VERCEL_TOKEN`, `VECTOR_HOSTED_VERCEL_TEAM_ID`, `VECTOR_HOSTED_VERCEL_PROJECT_ID`, `VECTOR_HOSTED_BASE_SNAPSHOT`, `VECTOR_HOSTED_RUN_HOST` |
| Docs | `docs/vector/owner-actions/hosted-computer.md` ("The provider"), `docs/vector/MODEL-PLANS.md`, `codium-deviations.md` ("A52 Provider adapter and reconciler") |
| Tests | `test/hosted-provider.test.ts` (new) |

No edits to `api/_lib/model-plan-*.ts`. No generator inputs changed (no config schema, server route or SDK input).

## How it works

- **A computer** is one persistent Vercel sandbox, named `vh-<hostedAccount(account)[0:16]>-<n>` with n from 1 to 3
  (the most any plan runs), and tagged `vector-mode` (the server's Stripe mode) and `vector-size`. The first start
  creates it from `VECTOR_HOSTED_BASE_SNAPSHOT`; every later start stops it if it is running (its disk is saved),
  applies the session's settings and resumes it from its own disk. A disk past its retention is deleted with its
  sandbox and made again from the base snapshot.
- **Each session's settings** (`computerConfig`, translated by `vercelSessionSettings`): 2 vCPUs (standard) or 4
  (large), with the memory the rates price; timeout = the job's deadline + 5 minutes, at most 24 hours; region iad1 and
  no failover; `ports: [6080]` only; `snapshotExpiration` and `keepLastSnapshots {count: 1, deleteEvicted: true}` = the
  plan's disk days; no environment variables at all.
- **Egress** (`vercelNetworkPolicy`): `allow` is `{"hosted-run.vectordev.ai": [one transform setting authorization:
  Bearer <vht_>], "*": []}` and `subnets.deny` is `HOSTED_DENIED_SUBNETS`, which Vercel applies before any domain rule.
  The run token is therefore the one credential, added by Vercel's proxy and never present in the VM. A54's Chromium
  policy bars the browser from that host and A53's routes refuse browser-shaped requests there (S7).
- **Credentials** always go to the SDK explicitly (token, team, Vercel project), so it cannot fall back to the main
  deployment's OIDC token. The provider counts as configured only with all four settings, on the team the spend guard
  watches (`VERCEL_HOSTED_TEAM_ID`, `VERCEL_SPEND_WEBHOOK_SECRET_HOSTED`) and not the main team.
- **Starting** (`startHostedComputer(account, {computer, session, size, deadline, runToken, diskDays})`): refuses
  without a configured provider (503 `HOSTED_UNAVAILABLE`) or without a block of time held for the session right now
  (409 `HOSTED_SESSION_MOVED`); records `hosted:computer:<name>` = `{account, computer, session}` before asking the
  provider; answers `{name, created, viewerUrl, expiresAt, runHost}`.
- **Reconciler** (`reconcileHostedComputers`): at most every 3 minutes (a `SET NX` throttle), lists this mode's
  computers, and for each running or starting one checks the session record and the session's running block (held, and
  no more than 2 minutes past its stopBy). Anything else is stopped; with the `hosted` switch at `stop`, everything is.
  A store failure stops nothing and is counted as unknown; a provider it cannot list is reported. The owner gets one
  email per 6 hours when it stopped, or failed to stop, a computer, naming computers only.
- **Erasing** (`eraseAccountComputers`): deletes every computer of the account and its disks at the provider, then the
  session records.

## Tests run here (one file at a time)

| Package | File | Result |
|---|---|---|
| root | `test/hosted-provider.test.ts` (new) | 39 pass, 1 todo (the Cloudflare full suite) |
| root | `test/hosted-ledger.test.ts`, `test/api-module-loading.test.ts`, `test/codium-mode.test.ts`, `test/no-topups.test.ts`, `test/no-project-wording.test.ts` (unchanged) | 28 pass 1 skip (Valkey), 1, 18, 4, 2 pass |
| web | `test/codium-configuration.test.ts` (unchanged; reads `.env.example`) | 11 pass |

`test/hosted-provider.test.ts` covers:
- **Names:** the format, the HMAC prefix, numbering 1 to 3, no account id, the salt required.
- **Configuration:** the deny list holds every contract block plus private, loopback, link-local and metadata, in every
  form that reaches them (mapped, NAT64, 6to4), leaves the public internet reachable, and each block is a valid network
  that S8's `blockedAddress` also refuses; 2/4 vCPUs at 2048 MB each, as the rates price; timeout = deadline + 5 min,
  capped at 24 h; one port; iad1; refusals of past deadlines, non-`vht_` tokens and bad retention; the run-API host
  fixed in production and never one of Vector's own sites.
- **Create receives the deny list and the single injection:** the exact network policy, the hosted team's credentials,
  the base snapshot, persistence and retention, and the token appearing exactly once in everything sent, with no
  environment, image or failover.
- **Resume:** settings applied before resuming, a running computer stopped first, an expired disk made again (both ways
  the SDK reports it), a computer still saving its disk resumed within 4 tries, a computer of the other mode or untagged
  never touched.
- **Stop, destroy, run token, list:** idempotent answers, disks deleted with the computer, the run token replaced with
  the deny list kept, listing only this mode's computers across pages with their usage.
- **Settings:** each missing or wrong setting (including the spend guard's team and the main team) leaves the provider
  unconfigured, and an unconfigured adapter refuses every call before reaching the SDK; the real SDK is loaded only by
  a dynamic import and pinned to an exact version in `package.json` and `bun.lock`.
- **M8:** no start without a held block (none, past its stopBy, lapsed, another session's); the session record is
  written before the provider is asked; a store failure starts nothing; unset or unknown `VECTOR_HOSTED_PROVIDER`
  starts nothing.
- **Orphan stopped (M9):** no record, a record without a block, a lapsed block, a block past stopBy, a record naming
  another computer, and a corrupt record each get stopped; a live one keeps running; stopped computers are ignored; the
  `stop` switch stops all; store failures stop nothing; the throttle; an unlistable provider and a failed stop
  reported; one owner email without an account id; nothing asked while no provider is configured.
- **Provider contract**, run per provider: Vercel gets the full suite (exact configuration handed over, resume and
  idempotent stop, another mode refused); the Cloudflare stub is never configured and refuses everything without a
  request, and its full suite is a `todo`.

Typecheck: the root `tsconfig.json` (api) and `packages/schema` (`tsgo --noEmit`) are clean. The new test file is
outside every typecheck config; it was checked once with a scratch config (Bun and node types) and is clean.

## CI only

- Nothing in A52 needs a service: the store commands are plain `SET`/`GET`/`DEL`/`HGETALL`, so no Valkey case was
  added. The Codium lane picks up `test/hosted-provider.test.ts`; it has not run in CI yet.
- **Never exercised anywhere:** the real `@vercel/sandbox` against Vercel (creating, resuming, stopping and listing
  sandboxes; the network policy's header transform and subnet denies actually applied; `snapshot_not_found` and the
  stopping errors as Vercel sends them; how long a stop takes to save the disk). The adapter is typed against the
  SDK's own declarations and its error reading is tested with the SDK's real `APIError`, but no call reached Vercel.
  That needs Vercel's written OK, the hosted team and the image (owner step 14, A54/A58).

## For later packages

- **A53:** call `startHostedComputer` after `requireHostedStart` and the session's first `openBlock` (it refuses
  without a held block), pass `runHost` from its answer to the boot step, and `stopHostedComputer` when the session ends
  or `stopBy` passes, before `closeBlock`. Call `reconcileHostedComputers()` from the reaper every minute (it acts every
  3 minutes). Add `computer`'s readiness check in `perkServices` with `hostedProviderConfigured()`, a snapshot and
  `hostedLedgerConfigured()`. The run-API host's routes must refuse `Origin`, `Sec-Fetch-*` and cookies (S7). The
  nightly job can read cumulative usage from the provider's listing (`activeCpuMs`, `durationMs`, `egressBytes`). The
  hosted provisioner keeps ended and frozen disks (14 days, dispute) and deletes at `until` with
  `eraseAccountComputers`. If A53 keeps its own session rows, tighten `sessionLive` with them.
- **A54:** the viewer proxy listens on `Hosted.VIEWER_PORT`; Chromium's URL policy blocks `Hosted.RUN_API_HOST` (and the
  run host A53 passes to boot, for previews); hostd calls that host without any credential of its own (the proxy adds
  it). The bake sandbox must not carry the `vector-mode` tag.
- **A57:** call `eraseAccountComputers(account)` after the sessions are closed, then `eraseAccountHostedLedger`.
- **Owner:** the provider section of `owner-actions/hosted-computer.md` (team, token, run-API domain, snapshot, then
  `VECTOR_HOSTED_PROVIDER=vercel` only after Vercel's written OK).

## Not done

- No route or cron: the reconciler runs from A53's reaper. No sessions, screens or image: A53 to A56.
- Cloudflare is a stub; building it needs Cloudflare's written OK and rates of its own in `hosted-rates.ts`.
- Nothing was pushed or deployed.
