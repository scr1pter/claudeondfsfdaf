# A50: Ops UI and ops crons

A50 gives the production checks their screens and their crons. It builds on A46 (the ops Worker and its `state` and
`suspend` actions), A47 (domains, monitors, the daily domain job), A48 (incidents, releases, Undo, "Fix it", the `ops`
provisioner), A49 (Ship Desk's cards and images) and A38 (the phone app). No GitHub, Cloudflare, Stripe, Supabase or
registry API was called: the tests run the routes over the Codium fakes, A46's own Worker code in memory, a fake GitHub,
a fake `vector-media` bucket and stubbed analytics, TLS, RDAP and DNS answers. Readings of the contract are in
`codium-deviations.md` under "A50 Ops UI and ops crons (5 Nov 2026)". Nothing was pushed or deployed.

An earlier A50 attempt stopped before committing (a usage limit). Its uncommitted work was read through, kept, finished
and corrected here; everything in this commit is A50's.

## What changed

| Area | Files |
|---|---|
| Guard | `api/_lib/ops-guard.ts`, `api/ops/guard.ts` (new; `/api/ops/guard`, every 10 minutes). Budget = (Max × cap cost + Ultra × cap cost) × 2 + $5 from the roster's counts; the month's spend from Cloudflare's GraphQL Analytics API (Worker requests, Durable Object requests and active time, priced at the published Workers Paid rates); one owner email a month at 75%; at 100% the Worker's `suspend {reason: "guard"}` for accounts whose probes over the last 25 hours exceed what their plan and monitors explain (×1.25 + 12 probes, release watches allowed); every hold released below 100%, and holds from an earlier month released even while the analytics cannot be read |
| Cleanup | `api/_lib/ops-cleanup.ts`, `api/ops/cleanup.ts` (new; `/api/ops/cleanup`, daily 04:40 UTC). Cards past their keep days deleted with their images (images first; a failed delete keeps the card for the next run); index entries whose incident or card expired pruned; frozen accounts left alone; every ops record erased 30 days after a lost dispute; accounts with nothing left dropped from the list. `eraseAccountOps(account)` is the one erase for A57 |
| Domain health | `api/_lib/ops-health.ts` (new), run by `api/ops/domains.ts`'s daily job after A47's re-verification (20 s of its 45 s budget for re-verification, the rest for health). Certificate expiry, trust and name over `node:tls` to an S8-checked public address; registration expiry over RDAP (IANA's bootstrap, no redirect, the shortest registered name); DNS drift (zone name servers and the domain's CNAME) over DNS-over-HTTPS. Title-only phone alerts (tag `on-call`, also while paused) at 14 and 3 days for a certificate, 30 and 7 for a registration, once per broken certificate and once per DNS change. `GET /api/ops/domains` shows each verified domain's health |
| Roster | `api/_lib/ops-accounts.ts` (new): `ops:roster:<plan>`, `ops:accounts`, `ops:erase:due`, kept by the `ops` provisioner (`codium-provisioners.ts`) on every transition; `closing` now calls `eraseAccountOps` |
| Listing | `api/_lib/codium-perks.ts`: readiness checks for `on-call` (the Worker), `release-guard` (+ the App's own tokens) and `ship-desk` (+ the App's own tokens and `vector-media`) |
| Ship Desk | `api/_lib/ship-desk.ts`: a card's record outlives its expiry by 3 days (`retainMs`), hidden from every reader, so the cleanup can find its images; `deleteCardObjects` for the cleanup |
| Other API | `api/_lib/ops-api.ts` (domain `health` in the list), `api/_lib/safe-fetch.ts` (`systemResolve` exported), `vercel.json` (the two crons; the phone origin's `img-src` adds `https://*.r2.cloudflarestorage.com` for Ship Desk's signed image links), `.env.example` (the guard's settings) |
| Shared screen code | `packages/app/src/features/cloud/ops/` (new): `ops-requests.ts` (the only requests the screens may make, checked by shape; exported as `@vectordevai/app/ops`), `ops-model.ts` (lenient decoders and copy), `before-after.tsx` (the comparison slider, no style attribute), `ops-settings.tsx` and `ops.css` (Settings → Production) |
| Desktop | `packages/desktop/src/main/ops.ts` (new): requests with the account token held in main (Vector Local source `production-checks`), screenshots fetched from the signed R2 link (R2 host only, no redirect, at most 5 MB, PNG or WebP by signature) and handed over as data URLs, merges with the person's own GitHub sign-in at the card's commit. `ipc.ts`, `preload/index.ts`, `preload/types.ts`, `renderer/index.tsx` |
| App | `context/platform.tsx` (`OpsPlatform`), `settings-v2/settings-registry.ts` (the `production` tab after Remote), `dialog-settings-v2.tsx` (shown when the desktop has `platform.ops` and the status lists an ops part with ops entitlements), `features/local/local-model.ts` (the source's name) |
| Phone | `phone/routes/ops.tsx` (A38's shell filled: incidents, releases, cards with the slider, domains and URLs, the alerts offer), `phone.css`, `routes/notifications.tsx` (`browserPush` exported) |
| Core | `local-mode/sources.ts`: `production-checks` (account purpose, blocked under Vector Local, desktop call site `packages/desktop/src/main/ops.ts`) |
| Docs | `docs/vector/MODEL-PLANS.md` (the A50 bullet, settings, crons), `owner-actions/hosted-ops.md` ("Screens, guard, cleanup and domain health (A50)") |
| Tests | `test/ops-guard.test.ts`, `test/ops-payment-pipeline.test.ts` (the contract's two), `test/ops-domain-health.test.ts`, `test/ops-screens.test.ts`, `packages/app/src/features/cloud/ops/ops-model.test.ts`, `ops-requests.test.ts`, `packages/desktop/src/main/ops.test.ts`; expectation changes in `settings-registry.test.ts` (18 pages) and `packages/web/test/codium-configuration.test.ts` (the two crons) |

No `api/_lib/model-plan-*.ts` file was edited. No generator input changed (no engine route, SDK input or config
schema), so no generator was run. `packages/desktop/src/main/ops.ts` imports `resolveGithubAccess` and
`putPullRequestMerge` from `github-access.ts` and `github-pr.ts` without editing them.

## How it works

- **Who shows what.** Each part (On Call, Release Guard, Ship Desk) shows only when the status lists it and the plan's
  public entitlements carry `ops` (H1). Sections follow the parts: incidents with On Call or Release Guard, releases
  with Release Guard, cards with Ship Desk, domains with either check, URLs with On Call. The server decides every
  action from the snapshot (S1); the screens never gate anything that matters.
- **Undo and Approve.** A revert pull request opens in GitHub, or on the desktop merges with the person's own GitHub
  sign-in after a second click ("Merge with my GitHub sign-in"). Approve sends the card's head sha, so GitHub refuses a
  merge of a commit nobody looked at. With no revert pull request, the card says why and offers "Open in GitHub" and
  "Roll back in Vercel" (or the host's own page). The phone opens GitHub only; it has no GitHub sign-in.
- **Screenshots.** The phone shows the 60-second signed R2 link straight in an `<img>` (hence the `img-src` entry); the
  desktop fetches it in main and hands the renderer a checked data URL (its CSP shows `data:` images only).
- **The guard's own expected usage** of an account: each of its monitors once per plan interval over the window (the
  fastest plan's interval if it joined or changed plan within the window), one extra round, and every release watched
  in the window at the plan's watch length and paths. Probes come from the Worker's `state` hourly totals, so the guard
  reads ids and counts, never URLs. Accounts checked within the hour are not read again while the budget stays used.
- **The roster** counts Max and Ultra accounts that are active, renewing or paused (paused accounts keep On Call's
  checks, §4.4), so they are budgeted, checked by the domain job and readable by the guard.

## Interfaces for later packages

- **A57:** call `eraseAccountOps(account)` (`api/_lib/ops-cleanup.ts`). It erases the Worker's data (while the Worker
  can be called), settings, incidents, Release Guard records, cards and images, domain health, and the guard's and
  cleanup's records, in both Stripe modes, and throws when a part cannot be reached so the caller retries. The `ops`
  provisioner already calls it on `closing`.
- **A59:** nothing new. "Fix it" still needs `registerOpsRunStarter`, and repositories still need
  `registerRepoBindingReader`; the screens show the server's `OPS_FIX_UNAVAILABLE` until then.
- **A60 / the owner:** list `on-call`, `release-guard` and `ship-desk` only after the App is registered and the outside
  review of the revert path (§8.2 step 16); set the guard's analytics settings first.

## Tests run here (one file at a time)

| Directory | File | Result |
|---|---|---|
| `test/` | `ops-guard.test.ts` (budget and overrides; the roster per state; one signed GraphQL request priced without included amounts; unreadable answers; expected usage per plan and after a plan change; cron secret, ops off, switch off; 75% once a month; 100% holds only the account above its usage, rechecks, release in a new month; a held account that left the roster; the Worker down; no analytics; a hold never outliving its month; the real GraphQL path) | 13 pass |
| `test/` | `ops-payment-pipeline.test.ts` (§4.4 for active, renewing, paused, ended, frozen, lost dispute, account deletion through the provisioner, the Worker, the roster and the routes; image deletes that fail; index pruning; listing with the App, alerts, the switch and each service) | 10 pass |
| `test/` | `ops-domain-health.test.ts` (certificate judgement; S8 before connecting; RDAP bootstrap, shortest name, no redirect, daily reuse; DoH NS and CNAME; drift rules; alert steps; the daily job, paused, ended and Pro, failures; nothing without ops) | 9 pass |
| `test/` | `ops-screens.test.ts` (the routes' real answers through the screens' decoders: incidents with a revert pull request and a manual undo, releases, cards, a card, an image link the desktop accepts, domains with health, URLs; every action the screens send accepted by its route; the image rewrite and the phone's `img-src`) | 6 pass |
| `test/` | `ship-desk.test.ts`, `release-guard.test.ts`, `on-call.test.ts`, `codium-outbox.test.ts` | 23+1 skip, 34+1 skip, 29+1 skip, 18+2 skip |
| `test/` | `phone-app.test.ts`, `remote-phone-api.test.ts`, `api-module-loading.test.ts`, `no-topups.test.ts`, `codium-mode.test.ts` | 11, 8, 1, 4, 18 pass |
| `packages/web` | `test/codium-configuration.test.ts`, `test/codium-public.test.ts` | 11, 13 pass |
| `packages/app` | `src/features/cloud/ops/ops-model.test.ts`, `ops-requests.test.ts` (new) | 14, 5 pass |
| `packages/app` | `src/components/settings-v2/settings-registry.test.ts`, `src/features/local/local-model.test.ts`, `src/features/onboarding/spotlight-steps.test.ts` | 15, 39, 2 pass |
| `packages/app` | `src/phone/phone.test.ts` without its bundle walk (CSP, copy rules, origin) | 6 pass, 1 filtered |
| `packages/desktop` | `src/main/ops.test.ts` (new: only the screens' requests, token, no redirect; signed out; refusals; Vector Local blocks; screenshots from R2 only, PNG/WebP only; merges at the card's commit, method fallback, refusals, no sign-in) | 8 pass |
| `packages/core` | `test/local-mode/sources.test.ts` | 15 pass |

Also run here: `bun script/browser-imports.ts src/phone/entry.tsx src/phone/sw.ts` from `packages/app` (the phone
test's bundle walk, run alone as one process): no Node or Bun module, and the ops modules are in the phone bundle.

Typecheck: the root `tsconfig.json` (api), `packages/app`, `packages/desktop` and `packages/core` with `tsgo --noEmit`,
all clean. Root tests sit outside every typecheck config; the desktop config leaves out its tests.

**CI only:** the Codium lane picks every test file the branch adds, so all seven new files run there; none has run in
CI yet. The phone test's bundle walk spawns a second process and was run here by hand instead. Settings → Production
and the phone's Production page have not been looked at in a browser or the running app (no dev server on this Mac);
their models are unit-tested and the components typecheck.

**Never exercised anywhere:** Cloudflare's real GraphQL Analytics API (the dataset and field names follow Cloudflare's
documentation and have not been queried), a real TLS handshake, IANA's bootstrap file and a registry's RDAP server, a
real DNS-over-HTTPS answer for NS and CNAME, a real merge through GitHub with a person's sign-in, an image from a real
R2 bucket, and the crons on Vercel.

## Owner steps

In `owner-actions/hosted-ops.md`: an Account Analytics read-only token (`VECTOR_OPS_CF_ANALYTICS_TOKEN`) and the
`OpsAccount` namespace id (`VECTOR_OPS_CF_NAMESPACE_ID`) in Vercel, optional cap-cost overrides; listing the three ops
perks only after the App and the outside review of the revert path.

## Not done

- Account deletion's wiring (A57) and the Codex hand-offs (A59) are their own packages.
- The phone adds no domains or URLs (it checks a pending domain); adding and removing are on the desktop.
- Nothing was pushed or deployed. `bun.lock` was not touched.
