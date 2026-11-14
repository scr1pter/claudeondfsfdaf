# P5 phase review repairs (A29 to A35)

These repairs answer the P5 phase review ("site and perks") of `f254efc5..298cc87f` on `codium-wt`. Each finding was
checked against the code first. Thirteen were confirmed and repaired with a regression test that fails against the
previous source. Two findings described the same defect (the founding provisioner) and share one repair. One finding,
the unpushed `codium-legal` branch, cannot be repaired from this Mac and is left to the orchestrator. The owner's
pending decisions are unchanged: Vector Labs on the pricing page, the Oct 30 model lineup, the investors page claims
and the 550B Velocity wording. No service, account, deployment or provider was called, nothing was pushed, and no
cloud-agent file was touched. Contract readings are in `codium-deviations.md` ("P5 review decisions").

## A31 founding members

**An invalid founding setting turned Codium off.** Confirmed. `codiumBillingConfigProblems()` included
`foundingConfigProblems()`, so a `CODIUM_FOUNDING_LIMIT` above 100000, a fractional `CODIUM_FOUNDING_DAYS` or an
unreadable `MODEL_PLANS_SALES_OPENED_AT` made `requireModelPlans()` throw `MODEL_PLANS_CONFIGURATION` for every
subscriber. **Repair:** the founding settings are no longer config problems. `foundingWindow()` already closed the
window on them, and `reserveFoundingSlot()` now answers false instead of throwing. The owner page names them in a new
checklist row, "Founding window settings" (`codium-owner-dashboard.ts`, env names only). Regression
(`test/codium-founding.test.ts`): each of the three bad values leaves `codiumBillingConfigProblems()` empty and
`requireModelPlans()` working, closes the window, refuses a slot, keeps a paying founder active with the number and the
boost, and appears on the owner page without its value. The earlier window case now checks `foundingConfigProblems()`.

**The founding boost made a correctly configured plan look oversold.** Confirmed. `paidModelPlan()` and the ledger's
`subscriptionSale()` compared the boosted credits with the price. With Plus credits above about 9.09, a founding Plus
subscription stopped counting as paid and its sale left the ledger. **Repair:** `subscriptionSoldCredits()` (new, in
`model-plan-config.ts`) gives the credits sold before the boost. Both checks compare that figure with the price, and the
boost still comes on top. Regression: 9.50 sold on the $10 plan is active with a 10.45 key and a ledger line granting
10.45; 10.50 sold is still refused.

**Checkout replaced its open session on every click.** Confirmed. Founding was offered from the global listing, so a
former founder or a lost slot race never matched the reuse test. **Repair:** founding is offered only to an account
with no founding record (`readFoundingMember`). A checkout whose slot request was refused records
`checkout.foundingRefused` and is reused while it stays open. Regression: two clicks after a refused slot, and two
clicks by a former founder, each open one session, expire none and ask for no slot.

**A frozen founder stayed on the founders page once `founding` was unlisted** (two findings). Confirmed. The
provisioner is configured only while `founding` is in `CODIUM_LISTED_PERKS`. **Repair:** `settleFounding` (reconcile)
now converges a listed founder's entry with the plan state on every pass: hidden while frozen, shown again after. The
provisioner stays as the quicker path, and account deletion already erases the record itself. `.env.example`,
`MODEL-PLANS.md` and `codium-payments.md` no longer ask the owner to keep `founding` listed. Regression: with the
provisioner unconfigured, a dispute hides the founder from `/api/founders` and a won dispute shows them again.

## A33 report tracker

**Report storage followed the Stripe mode.** Confirmed. Production writes under `vector:codium:test:` until a live key
is set, so once `CODIUM_STRIPE_MODE=live`, earlier reports would lose their status and survive account deletion.
**Repair (option a):** on a live server `readReportViews` reads both prefixes in one `MGET` and `eraseAccountReports`
erases both indexes and record sets (`reportModes()`). A test server still never reads the live prefix, and the owner
script already looks in both. Regression (`test/support-reports-api.test.ts`): a record written in test mode is read,
with its status, by the live server and the route, and is erased with its account under both prefixes.

**The disclosure did not say a report is linked to the account.** Confirmed. `support-report` now says it sends "the
report you write, the logs you attach and, when you are signed in, your Vector sign-in so your plan's tag applies". The
bug dialog says the same before sending. The token is still sent while the person is signed in;
the disclosure and the dialog now say so.

**Free accounts raised an address's limit.** Confirmed. **Repair:** a signed-in caller without an active plan also
counts against the 5-an-hour `bug-report-ip` count that reports without a sign-in use. The 60-an-hour signed-in ceiling
is still checked before the token (so made-up tokens are counted), and paid plans keep their per-account limits.
Regression (`test/bug-report-api.test.ts`): six free accounts on one address send five reports, a signed-out report
from it is refused, and a paid account on it still sends.

**A personal address was the report inbox fallback.** Confirmed. The literal is gone. Without `VECTOR_BUG_REPORT_TO`
the route answers 503 `EMAIL_NOT_CONFIGURED` and stores nothing, and `reportEmailConfigured()` (the read-first
readiness check) needs it too. `.env.example` sets a placeholder. Regression: the email goes to the configured address,
and without it the route answers 503.

## A29 no-top-ups guard

Confirmed. `modelTopupPurchasable()` and the `topup` redirect action are deleted with their test cases. The whole-file
allowances for `packages/web/src/lib/model-plans.ts` and `api/_lib/model-plan-status.ts` are gone. The website decoder
renames its legacy helpers so that seven listed lines remain (`LINES`). Status sends the legacy field through one
constant, `{ purchased: { bought: false } }`, which the existing phrase allows.

## A35 Second opinion and second-lab reviews

**No review token stop.** Confirmed. **Repair:** the per-review stop is built in `packages/engine/src/review/run.ts`
(`CODIUM_REVIEW_TOKEN_STOP`, 400K). When any pass runs on Vector Codium, the check and the panel's judge start only
while the passes' tokens so far plus the next prompt stay under it. Otherwise they are skipped as `budget`, like the
dollar cap. The count stays inside the runner and no note names it. The 2M-per-PR daily stop needs the pull request's
state in Codex's workflow and is still unowned. Regression (`packages/engine/test/review/panel.test.ts`): past the stop
neither pass reaches the model and nothing unchecked is reported; under it all three run; own-key reviews are not held
to it.

**A GitHub section of `vectorscope.astro` was edited.** Confirmed. The "Your rules" row of `#pull-requests` is back as it
was. `panel` and `judgeModel` stay documented in `#second-lab`. The row change is listed for Codex at A59 in
`codium-deviations.md`.

**"Credits" copy.** Confirmed. Vectorscope now says Codium "uses your Codium month", the `plans-catalog` source "Lists
Vector Codium plans and your plan's status", and onboarding shows "how much of this month is left". A new case in
`test/no-topups.test.ts` rejects "credits" in prose strings in `packages/app/src` and `packages/core/src`, except the
free-model phrase "no payment or credits needed" and the legacy server suffix the core still recognises.

## A30 legal drafts: not repaired here

Confirmed: `codium-legal` (`94a5004e`) exists only locally (`git ls-remote` finds no remote branch). This step may not
push, and the pre-push hook runs turbo, which this Mac must not run. The orchestrator should push it with
`git push origin codium-legal` from a machine where the hook can run, then confirm the Vector Codium lane passes on it.

## Tests and typechecks

Run one at a time with `--timeout 30000`:

| File                                                               | Result                            |
| ------------------------------------------------------------------ | --------------------------------- |
| `test/codium-founding.test.ts` (4 new cases)                       | 24 pass, 1 skip (Valkey, CI only) |
| `test/support-reports-api.test.ts` (1 new case)                    | 18 pass, 1 skip (Valkey, CI only) |
| `test/bug-report-api.test.ts` (2 new cases)                        | 18 pass                           |
| `test/no-topups.test.ts` (1 new case)                              | 4 pass                            |
| `test/codium-billing.test.ts`                                      | 52 pass, 2 skip                   |
| `test/codium-mode.test.ts`                                         | 18 pass                           |
| `test/codium-plan-change.test.ts`                                  | 29 pass                           |
| `test/codium-renewal.test.ts`                                      | 32 pass                           |
| `test/codium-risk.test.ts`                                         | 23 pass, 1 skip                   |
| `test/codium-owner.test.ts`                                        | 34 pass, 1 skip                   |
| `test/codium-topups-removed.test.ts`                               | 10 pass                           |
| `test/codium-outbox.test.ts`                                       | 18 pass, 2 skip                   |
| `test/codium-replay.test.ts`                                       | 27 pass, 2 skip                   |
| `test/abuse-api.test.ts`                                           | 8 pass                            |
| `test/api-module-loading.test.ts`                                  | 1 pass                            |
| `packages/engine/test/review/panel.test.ts` (2 new cases)          | 7 pass                            |
| `packages/engine/test/review/run.test.ts`                          | 33 pass                           |
| `packages/core/test/local-mode/sources.test.ts`                    | 15 pass                           |
| `packages/app/src/features/pull-requests/ai-review.test.ts`        | 110 pass                          |
| `packages/app/src/features/local/local-model.test.ts`              | 39 pass                           |
| `packages/app/src/components/settings-v2/local-model.test.ts`      | 15 pass                           |
| `packages/web/src/lib/model-plans.test.ts`                         | 15 pass                           |
| `packages/web/test/codium-configuration.test.ts`                   | 11 pass                           |
| `packages/web/test/model-plan-status-api.test.ts`                  | 22 pass                           |
| `packages/web/test/codium-public.test.ts`                          | 13 pass                           |
| `packages/web/src/components/marketing/account/ModelPlans.test.ts` | 19 pass                           |

Typecheck: root `tsconfig.json` (api) clean; `packages/core` and `packages/engine` `tsgo --noEmit` clean;
`packages/app` `tsgo -b` clean; `packages/web` `astro check` 0 errors, 0 warnings.

No schema, protocol or generated client changed, so no generator ran.
