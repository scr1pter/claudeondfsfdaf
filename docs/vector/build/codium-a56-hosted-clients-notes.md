# A56: Hosted clients and budget workflow

A56 gives the cloud computer its screens and the hosted team its budget workflow. It builds on A53 (the sessions
routes, viewer tokens, files, `GET /api/hosted/admin/budget`), A54 (the computer's viewer page and its hand-over
reason), A55 (Done by Morning's routes) and A38 (the phone app and its alerts). No provider, Vercel, GitHub, Stripe or
other service was called, nothing was deployed or pushed, and the workflow was not run. Readings of the contract are in
`codium-deviations.md` under "A56 Hosted clients and budget workflow (9 Nov 2026)".

An earlier A56 attempt stopped before committing (a request timeout, then the weekly usage limit). Its hosted-client
work (5 and 6 November) was read through, kept, finished and tested here. The same tree also held account-deletion work
from 6 November (A57's file list); it was left uncommitted for A57, listed in the deviations entry.

## What changed

| Area | Files |
|---|---|
| Shared screen code | `packages/app/src/features/cloud/hosted/hosted-requests.ts` (the only requests the screens may send and the only links they may open; `@vectordevai/app/hosted`), `hosted-model.ts` (lenient decoders and copy), `hosted-composer.tsx` and `hosted.css` (the composer's button, the bar, the start dialog and Done by Morning's jobs dialog) |
| Composer | `packages/app/src/components/prompt-input.tsx`: `useHostedComputer()`, `<HostedBar>` above the composer, `<HostedRunButton>` beside attach in both layouts |
| Desktop | `packages/desktop/src/main/hosted-client.ts` (requests with the account token held in main; the live view, files and links; the window's options and request rule), `hosted-window.ts` (Electron's half: the live view window), `ipc.ts`, `preload/index.ts`, `preload/types.ts`, `renderer/index.tsx`, `egress-filter.ts` (a `cloud-computer` session kind) |
| App and core | `context/platform.tsx` (`HostedPlatform`), `features/local/local-model.ts` and core `local-mode/sources.ts` (the `cloud-computer` source: account purpose, blocked under Vector Local), `packages/app/package.json` (the `./hosted` export) |
| Phone | `phone/routes/computer.tsx` (A38's shell filled), `phone/phone.css` |
| Server | `api/_lib/hosted-handoff.ts` (new: one title-only alert per new hand-over), `api/_lib/hosted-jobs-runtime.ts` (registers it on the heartbeat's route), `api/_lib/hosted-sessions.ts` (`listHostedSessions` adds `handoff`), `packages/schema/src/hosted.ts` (`SessionView.handoff`) |
| Budget workflow | `.github/workflows/vector-hosted-budget.yml` (new), `packages/cloud/src/hosted-budget.ts` (new) |
| Docs | `docs/vector/MODEL-PLANS.md` (the A56 bullet), `docs/vector/owner-actions/hosted-computer.md` ("The clients and the budget workflow"), `codium-deviations.md` |
| Tests | `test/hosted-clients.test.ts`, `packages/app/src/features/cloud/hosted/hosted-model.test.ts`, `hosted-requests.test.ts`, `packages/desktop/src/main/hosted-client.test.ts`, `packages/cloud/src/hosted-budget.test.ts` (all new) |

No `api/_lib/model-plan-*.ts` file was edited. No generator input changed (no engine route, SDK input or config schema),
so no generator was run.

## How it works

- **Run on my cloud computer.** A button beside attach (only while `computer` is listed and the plan's public
  entitlements carry `hosted`, H1) opens a dialog with the composer's text, the plan's sizes and job lengths (15 minutes
  to the plan's longest job), and the pre-start ceiling: the estimate's hosted form for that size and length, shown as a
  band of the month ("at most 2–5% of your month … Its Codium requests count too"), never an amount (P1, P2). Start is
  off while the plan's state does not allow a start, while the ceiling is "more than your month", or before the status
  is read. While `overnight` is listed, a Done by Morning tab queues the job with success criteria and an "aims to
  deliver by" time.
- **The bar.** While a session runs, a purple-edged bar above the composer says "Vector is using its cloud computer"
  ("You have control of the cloud computer" during a take-over, dashed), the session's title and state, why the computer
  needs the person (a password or one-time-code field, a card field, a CAPTCHA) and how long a take-over has left. Watch
  opens the live view; Take over asks the server and then opens a control link; Give back; Files asks for the session's
  files and opens the 24-hour link in the browser once they are packed; Stop takes a second click.
- **The live view window.** No preload, sandboxed, context isolation, no webview tag, an in-memory partition per
  session that is cleared when it closes, Vector's title kept, and only the computer's viewer origin reachable (its
  page over https, its socket over wss). New windows, downloads and every permission are refused. Its requests are
  Vector Local's `cloud-computer` source.
- **The main process** holds the account token and sends only `hosted-requests.ts`'s shapes to vectordev.ai with no
  redirects, through Vector Local's `cloud-computer` source (blocked under Vector Local, and the screen says so). It
  opens only links it checked: the computer's viewer page with a `vvt1` token in its fragment, vectordev.ai's download
  route for one session, a github.com pull request or compare page, an R2 signed link.
- **Polling.** One reader per window for every composer: every 15 seconds while a session is live, 60 otherwise, not
  while the window is hidden.
- **Phone.** The Cloud computer page shows the plan's state, the same bar with Watch, Take over, Open control, Give
  back, Files and Stop, and Done by Morning's jobs with their reports, the verdict per criterion, Approve and Cancel.
  Links the server gives (the live view, files, a pull request) appear as links the person taps, with no referrer. A
  phone without alerts is offered them. Starting a job stays on the desktop.
- **Hand-overs.** A running session's view carries `handoff {reason, since}` from the daemon's last report (not during
  a take-over; unknown reasons never pass). The heartbeat's route sends one alert per new hand-over, "Vector needs you on
  its cloud computer" with tag `computer`, which opens the phone's Cloud computer page (P7: a title and a tag only).
- **Budget workflow.** Daily at 06:17 UTC and on dispatch, only when `VECTOR_HOSTED_BUDGET_AUTOMATION` is true and only
  from the default branch. A guard job (no secrets) checks that `hosted-production` has a required reviewer; the budget
  job runs in `hosted-production` with the Billing-role token and the read secret, reads Vector's worst case for the
  cycle, reads the team's budget and spend with `vercel billing budgets inspect --json`, and sets
  max(current, ceil(spend + 1.3 × worst case)) with `--amount` only, never above `VECTOR_HOSTED_BUDGET_MAX_USD`, then
  reads it back. Its log names no amount.

## Tests run here (one file at a time)

| Directory | File | Result |
|---|---|---|
| `test/` | `hosted-clients.test.ts` (new: every request the screens send accepted by its route and every answer read by the screens' decoders, through start, status, sessions, watch, take over, control, give back, files and stop; the phone's website session; Done by Morning's queue and list; the hand-over on the list and its alert once per hand-over, none during a take-over; the hook's registration; no client imports the API's hosted modules; the `cloud-computer` source) | 8 pass |
| `test/` | `hosted-sessions-api.test.ts`, `hosted-jobs.test.ts` (the runtime now also registers the hand-over hook), `hosted-copy.test.ts`, `phone-app.test.ts`, `api-module-loading.test.ts`, `no-topups.test.ts`, `no-project-wording.test.ts` | 25+1 skip, 29+1 skip, 5, 11, 1, 4, 2 pass |
| `packages/app` | `src/features/cloud/hosted/hosted-requests.test.ts` (new), `hosted-model.test.ts` (new; includes a copy guard over the hosted screens and the phone route) | 6, 14 pass |
| `packages/app` | `src/phone/phone.test.ts` without its bundle walk, `src/features/local/local-model.test.ts`, `src/security-policy.test.ts` | 6 (1 filtered), 39, 1 pass |
| `packages/desktop` | `src/main/hosted-client.test.ts` (new: only the screens' requests, token, no redirect; refusals; signed out; Vector Local; the live view link and window; files; links) | 10 pass |
| `packages/desktop` | `src/main/egress-filter.test.ts` | 63 pass, 1 fail, not A56's: "keeps billing's routing" expects `cancelled` for `?model_topup=cancelled` and gets `closed` since A20 (b151dded7) changed `billing-navigation.ts`; A56 only added a session kind |
| `packages/core` | `test/local-mode/sources.test.ts` | 15 pass |
| `packages/cloud` | `src/hosted-budget.test.ts` (new: the calculation, never lower, the ceiling, the cycle end, the CLI's and Vector's answers, a run against a fake CLI and fake Vector, only `--amount` and the read flags, no amount in any outcome, the workflow's triggers, gates, environment, secrets, pins and its environment check run in bash), `src/workflow-compliance.test.ts` | 21, 23 pass |

**M9's hosted cases (A56's done criterion):** the spend webhook escalates only (`test/codium-vercel-spend.test.ts`,
52 pass, 4 Valkey cases skipped here and run in CI), the budget is never lowered and never above the ceiling
(`packages/cloud/src/hosted-budget.test.ts`, 21 pass), and computers without a live session are stopped
(`test/hosted-reaper.test.ts`, 21 pass). The committed API tree was also typechecked alone, without A57's uncommitted
work (root `tsconfig.json` over a `git archive` of HEAD): clean.

Also run here: `bun script/browser-imports.ts` from `packages/app` (the bundle walk the CI tests run, as one process):
3,098 modules, no Node or Bun import; the three hosted screen modules are in it.

Typecheck: the root `tsconfig.json` (api), `packages/app` (`tsgo -b`), `packages/desktop` (`tsgo -b`), `packages/core`,
`packages/schema` and `packages/cloud` (`tsgo --noEmit`), all clean. They ran with A57's uncommitted work in the tree;
no A56 file imports any of it.

## CI only

- The Codium lane picks every file the branch adds, so the five new test files run there; none has run in CI yet.
- `packages/app/src/browser-bundle.test.ts` and the phone test's bundle walk spawn a second Bun process; the same walk
  ran here by hand.
- Nobody has looked at the composer's button and dialog, the bar, the jobs dialog, the live view window or the phone's
  Cloud computer page in a browser or the running app (no dev server on this Mac). Their models are unit-tested and the
  components typecheck.
- **Never exercised anywhere:** the workflow on GitHub (the environment check, the approval, `npx vercel@65.3.1`, the
  real `vercel billing budgets` output and whether 65.3.1 has `inspect --json`), the real Vercel budget, a real
  computer's viewer page in the window, a real hand-over alert reaching a phone.

## For later packages and the owner

- **A57:** the account-deletion work in the tree is A57's (see the deviations entry). Nothing in A56 needs erasing: the
  clients store nothing, and the hand-over is part of the beat A53 already erases.
- **The computer-use build (Codex):** the agent's side of a hand-over (hostd reports it; the agent waits) and the git
  token route are still not built (A54, A55).
- **Owner:** the budget workflow's setup is in `owner-actions/hosted-computer.md`. On the first dispatch, if it says the
  CLI's answer could not be read, nothing changed; the field names (not values) it printed are what the reader needs.
  `alerts` now has a server sender in the cloud computer too (A38's listing note).
- **Track B (B11):** a finished hosted job could come back into the desktop conversation as one note; today the jobs
  dialog and the phone show reports.

## Not done

- The phone does not start or queue jobs (the ceiling needs an account token).
- No Settings page for the cloud computer: the composer, the bar and the dialogs are its desktop surfaces.
- bun.lock was not touched. Nothing was pushed, deployed or run against a real service.
