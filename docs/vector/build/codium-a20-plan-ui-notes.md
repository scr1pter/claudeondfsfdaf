# A20 app and desktop plan UI: implementation record

This work builds on `2722736d` (A19) in `codium-next`. It covers spec §5 A20, the listing and `vector models` line moved
from A19 (coordinator decision, 30 Oct; "Moved to A20" in [codium-a19-clients-notes.md](codium-a19-clients-notes.md)),
and that record's "Obligations for A20 and later". It is **not** a completeness claim: the change is committed as one commit
and pushed to `codium-next` and `codium` (see "Final gate"), no GitHub CI run of it has been seen, and the items under
"Remaining" are open.
No provider request, Stripe, OpenRouter or GitHub call, account setting, deployment or release-catalog change was
made. Every service in the tests is an in-process fake or a loopback fake. No `api/` file changed, so no
`api/_lib/model-plan-*.ts` edit is listed. No public Protocol, HttpApi or schema file changed, so no generator ran
(A19 already generated `ModelCodium`, `UserMessage.selected` and `Session.Error.Codium.code`). Scratch and XDG roots
lived under `/tmp/vector-codium-A20/`.

## What changed

| File                                                                                                                                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/model-plan-status.ts`                                                                                                   | Browser-safe helpers shared by the app, TUI, desktop and CLI: `Listing` (the structural `Model.Codium`), `isAuto`, `isLocked`, `automatic` (never Auto, locked or manual-only), `listingBadge` ("Codium · Pro" / "Preview · Ultra" / "Preview"), `sessionModel` (`selected ?? model`, no variant with `selected`), `failureCode` (engine `metadata.code` or V2 `code`) and `failureParts`, the inverse of the engine's message suffix, read from one `SUFFIXES` table that `suffix()` now uses too (plus the legacy " Buy credits at" ending of stored turns). `Offers` loses `topups` and `formatPurchased` is removed (no screen shows top-ups or purchased credits). |
| `packages/app/src/utils/task-intelligence.ts`                                                                                              | `RoutableModel.codium`. Complex-task routing never moves a prompt onto Codium Auto, a locked or a manual-only entry, and leaves a current Auto alone; image routing applies the same filter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/desktop/src/main/swarm-plan.ts`, `preload/types.ts`; `packages/app/src/pages/layout-new.tsx`, `app.tsx`                          | `SwarmModelCandidate.codium {locked, manualOnly, auto}` from the app's model list. `swarmModelPool` never adds Auto (flag or id), locked or manual-only entries by itself; the person's own unlocked primary stays (Auto or manual-only), a locked primary is refused ("Change your Codium plan to use …, or choose another model for the swarm."). The parallel default never restores a recent locked model. The layout re-reads providers on `codiumChanged()`.                                                                                                                                                                                                      |
| `packages/app/src/utils/provider-brand.ts`, `components/dialog-select-model.tsx`, `vector-premium.css`                                     | Access label "Codium", title "Included in your Vector Codium plan" (no credits; "credits" no longer a search word). `codiumBadge` on the row (`data-slot="model-row-badge"`), in the tooltip and the spoken label. Codium Auto pinned first in Vector Codium. `pickModel`: choosing a locked Codium entry opens the plans (`useCodiumPurchase`) instead of `model.set`, in the main picker and every `ModelSelectorModelState` host.                                                                                                                                                                                                                                    |
| `packages/tui/src/component/dialog-model.tsx`, `context/local.tsx`, `component/prompt/index.tsx`                                           | Badge as the row description, Auto pinned first, `confirmCodiumChoice` (a locked entry asks "Change plan?" and opens the account page, never sets the model). Restore, recents cycling and `set` skip locked entries; a session restores `ModelPlanStatus.sessionModel(msg)`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/app/src/context/local.tsx`                                                                                                       | `session.restore` uses `sessionModel` (Auto again, not the model it picked); `validModel` and the recent list leave locked Codium entries out of restore, defaults and cycling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/engine/src/session/prompt.ts`                                                                                                    | A user message that kept Auto (a shell command when Auto could not pick) is resolved once in the run loop before `getModel`, stored with `selected` = Auto, so every step stays on one model; when Auto still cannot pick, the turn fails with Auto's notice and nothing is sent.                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/engine/src/provider/provider.ts`, `packages/core/src/plugin/provider/vector-plan.ts`                                             | Every decoded entry is listed with its `codium` metadata: Auto, locked and manual-only included.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/engine/src/cli/cmd/models.ts`                                                                                                    | `codiumLines`: "Vector Codium: N model(s) included in your plan …", "Codium Auto picks a model for each message (vector-plan/vector/codium-auto)", "Locked: <name> (<plan>), …. Change plan to use them: <account>". Never a price or credits; stdout still lists every selector.                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/app/src/components/codium-error.tsx`, `context/notification.tsx`                                                                 | `codiumErrorText` strips every engine suffix (`failureParts`) where the desktop bills. `codiumFix`: code (toast) → suffix (card) → stored action; the card reads the account's plan for a bare credit answer. Buttons: See plans, Change plan, Manage plan (the plans dialog), Update card (portal `payment_method_update`), Confirm payment (portal home), Sign in to Vector; daily, run, Brain and unavailable answers get none.                                                                                                                                                                                                                                      |
| `packages/app/src/vector-account.ts`                                                                                                       | `VectorBillingRequest` = checkout, change, keep, portal (`cancel`, `payment_method_update`); results add `scheduled {plan, at}` and `kept`. `refreshAfterPurchase` re-announces `codiumChanged()` at 5, 20 and 60 s at module level, a newer purchase restarting it.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/desktop/src/main/vector-account.ts`                                                                                              | Billing validates those shapes only (no top-up, no portal change); `change` POSTs `/change` (an upgrade's checkout opens in the billing window, a downgrade returns `scheduled`), `keep` DELETEs `/change` as JSON, 404/405 from an older site opens the account page, a refusal (409 `MODEL_PLAN_CHANGE_UNAVAILABLE`) is said in the app. The sign-in exchange keeps only a `vct_` grant whose claims say `client: "desktop"`.                                                                                                                                                                                                                                         |
| `packages/desktop/src/main/billing-navigation.ts`                                                                                          | `model_topup` dropped; `model_plan=success&change=upgrade` and `model_plan=updated` (card update) are completed returns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/app/src/components/codium-billing.ts`, `codium-purchase.tsx`, `codium-purchase.css`                                              | Plan picker: Subscribe (checkout) without a plan; Upgrade ("Upgrade to Max: $100 today, then monthly from today. Keeps what's left of this month.") and Switch at renewal through `/change`; "Starts <date>" for a scheduled target and no other change while one is scheduled; none for an ending, paused, renewing or frozen plan. No top-up group, no portal Change plan. The dialog is "Vector Codium plans". `createCodiumBilling()` announces `codiumChanged()`; every page showing the plan subscribes. Without the desktop bridge a checkout opens /codium and everything else /account; `useCodiumPurchase` opens /account there.                              |
| `packages/app/src/components/settings-v2/account-model.ts`, `account.tsx`, `settings-account.css`, `components/settings-vector-codium.tsx` | No credits, purchased or top-up row or wording: "This month" with "64% of this month's usage left" (meter "Share of this month's usage left"), Renews/Ends, the scheduled line "Switches to Plus on <date>." with Keep my plan, a paused plan's Update card or Confirm payment, "Change plan" / "See plans", and deletion copy in usage terms.                                                                                                                                                                                                                                                                                                                          |
| `packages/app/e2e/fixtures/account-settings.jsx`, `e2e/regression/account-settings.spec.ts`                                                | The fixture models A20's flow (checkout, change with upgrade and scheduled answers and the real 409 while a change is scheduled, keep, portal home/cancel/card; top-up throws, a legacy portal change gets the real 409), new `paused-card`, `paused-confirm` and `scheduled` accounts, and a card worded by the real `gatewayFailure`. The spec covers the plan picker, Switch at renewal, Keep my plan, Update card and Confirm payment, the card's buttons by kind, no credits text, and the 5/20/60 s reads under `page.clock`; the low-usage notice expectation follows A19's copy (the failure of run 41138356775).                                               |

### Second step: forced models reads and Auto on direct paths

The continuation closed the two code items the first step left open (plan step 11 a/b and Auto on direct-model
paths) and extended the image-routing spec.

| File                                                                                                                                           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/model-plans.ts`                                                                                                             | `createClient`: a `force` read always starts a new request (never joins one already under way, which may carry the models from before a purchase) and stops the kept catalog counting as fresh, so a plain read meanwhile joins it. Each account entry counts its reads; an answer from a read a newer one overtook is never kept and settles with the newer read. `credentialWritten(token)`: a forced read that waits at most `CREDENTIAL_READ` (2 s); a slower answer still lands, since the read is the client's. `disabled` (Vector Local, StartupHold, `VECTOR_DISABLE_MODELS_FETCH`) still answers OFF with no request. |
| `packages/engine/src/server/routes/instance/httpapi/handlers/control.ts`, `server.ts`                                                          | `ControlHttpApi.authSet` for `vector` runs `credentialWritten` with the effective credential (`FreeModels.CredentialsService`, so `VECTOR_CLI_TOKEN` still wins). Both services are bound when the handler layer is built, like every root handler's, so the app graph lists `FreeModels.credentialsNode` and `ModelPlans.node`. A `vector` credential write (sign-in and account switch included) now answers once that read lands or after 2 s, whichever is first. No HttpApi schema change.                                                                                                                                |
| `packages/desktop/src/main/vector-account.ts`, `vector-account-runtime.ts`, `ipc.ts`, `preload/index.ts`; `packages/app/src/vector-account.ts` | `refreshModels()`: runs in the account `queue`, reads the stored token when it runs (nothing when signed out or expired) and writes that token to the app's own sidecar again (`refreshVectorModels`: `PUT /auth/vector` only, no `/global/dispose`, under the same local-only check as `syncVectorAccount`, which now shares `writeCredential`). IPC `vector-account-refresh-models`; `VectorAccountPlatform.refreshModels?`. A WSL server is not written: it gets the account when it starts, and its kept list lapses within a minute.                                                                                      |
| `packages/app/src/vector-account.ts`, `components/codium-purchase.tsx`                                                                         | `refreshAfterPurchase({ models, wait })`: at 5, 20 and 60 s it first awaits `models` (the desktop's `refreshModels`), then announces `codiumChanged()`; a failed read still announces, and a schedule a newer purchase overtook while its read ran announces nothing.                                                                                                                                                                                                                                                                                                                                                          |
| `packages/engine/src/provider/provider.ts`                                                                                                     | `getSmallModel`: a `small_model` of `vector-plan/vector/codium-auto` gives the model a Codium conversation's helpers get (`CodiumAuto.helper`: floor, then default), or none (the helper is skipped); never the Auto entry.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/engine/src/agent/agent.ts`                                                                                                           | `Agent.generate`: Codium Auto (named or the default) runs on the model `codiumAuto` picks for standard work, and fails with Auto's notice before anything is sent when the plan offers none. A Codium model is read through `streamObject`, as a ChatGPT sign-in already was: the Codium transport always streams, so `generateObject` would have sent a request, spending usage, whose answer could not be parsed.                                                                                                                                                                                                            |
| `packages/core/test/fixture/codium-gateway.ts`                                                                                                 | An `object` mode streaming a JSON answer (`objectStream`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/app/e2e/fixtures/account-settings.jsx`, `e2e/regression/account-settings.spec.ts`                                                    | The fixture's `refreshModels` counts reads while signed in; the spec expects exactly one models read before each of the 5, 20 and 60 s plan reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/app/e2e/regression/codium-image-routing.spec.ts`                                                                                     | Image-capable Codium Auto, locked and manual-only entries with their listing metadata beside the plain one; an image still never moves the prompt onto any of them. Prettier also reflowed the file's existing long lines.                                                                                                                                                                                                                                                                                                                                                                                                     |

`SessionDistill` needed no change: it runs its one request through `SessionPrompt.prompt`, whose `createUserMessage`
resolves Auto for the message before anything is sent, so Auto never reaches its transport. Its estimate names Codium
Auto and checks the window Auto's listing gives.

### Third step: helper agents configured on Codium Auto

The continuation closed the one code gap the second step found: a helper agent whose own `model` is
`vector-plan/vector/codium-auto` went straight to `getModel`, which hands back the listing entry, and the Codium
transport then refused it locally (`CODIUM_AUTO`; nothing sent or charged, but no title or summary either).

| File                                               | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/engine/src/provider/provider.ts`         | `getSmallModel(planID)` and a `small_model` naming Auto share one layer-local reader (`codiumHelper`: `refreshCodium({ wait: true })`, then `CodiumAuto.helper`), so the Codium branch reads the listing itself, as `getModel` does, and answers for a caller that has no Codium conversation. The `fromModelPlans` doc comment now says every entry is listed with its `codium` metadata (it still described A19's interim listing).                                                                             |
| `packages/engine/src/session/prompt.ts`            | Title helper: an agent `model` of Codium Auto is not the title's own model; the title asks `getSmallModel` for Codium (Auto's floor, then default), whichever provider the conversation is on, and makes no title request when there is none. A free conversation still titles on its free model, and any other agent model still wins.                                                                                                                                                                           |
| `packages/engine/src/session/compaction.ts`        | `autoSummary(sessionID, visible)`: the model `codiumAuto` picks for standard work over the visible history, publishing Auto's notice on the session and stopping when Auto cannot pick. `process` uses it when the compaction agent's `model` is Auto (a free primary still wins); `create` (a session on Auto) now uses the same reader instead of its own copy.                                                                                                                                                 |
| `packages/engine/test/session/codium-auto.test.ts` | Three cases on a conversation on a provider of the user's own (`lmstudio`, trusted workspace, loopback URL never reached): the title agent on Auto titles on Auto's floor, and on no model when the plan has no Auto; the compaction agent on Auto summarises on Auto's standard pick, never on Auto; and with no Auto it stops with Auto's notice and nothing is requested. The free stack's in-process `LLM.stream` now calls `answering` at its first event, as the real one does, since a title waits for it. |

### Fourth step: review findings on the uncommitted change

A review of the uncommitted tree raised nine findings; each was checked against the code and all nine held up, so all
are fixed below. The two on a failed turn's billing buttons (no later reads, a failure shown nowhere) share one fix, as
do the two on its plan read (suspending the page, one read per card). The test-coverage one is fixed by a handler-level
test and a narrower test name. None was rejected or deferred.

| File                                                                                                  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/app/src/components/codium-error.tsx`, `packages/app/src/vector-account.ts`                  | The card's plan read was a `createResource` read under `<Show>`, so while it was pending it suspended the route's `<Suspense>` (layout-new.tsx, no fallback) and blanked the whole session page, on every remount of a virtualized row (Solid 1.9.10 `read()` increments the Suspense counter for a non-user listener). It is now a signal filled in `onMount` and on `onCodiumChange`, from `codiumSubscribed(account)`: one read shared by every card, kept for `SUBSCRIBED_FOR_MS` (60 s) and dropped by `codiumChanged()`. |
| `packages/app/src/vector-account.ts`, `components/codium-purchase.tsx`, `components/codium-error.tsx` | `runBilling(account, request, { paying, wait })`: the one way a billing request runs, from Settings, the plans dialog, a failed turn's card and a toast. A thrown or missing `billing` reads as failed; `completed` starts `refreshAfterPurchase`, and so does `closed` when `paying` (the portal home opened to confirm a payment). The card's and toast's Update card and Confirm payment now use it and say how it ended in a toast (`billingNotice`), so a failed request is no longer silent.                             |
| `packages/app/src/components/settings-v2/account.tsx`                                                 | Confirm payment runs `{ kind: "portal" }` with `paying`, so closing the portal after a 3-D Secure confirmation reads the plan and models again at 5, 20 and 60 s. `CodiumBillingStatus` gets the plan id.                                                                                                                                                                                                                                                                                                                      |
| `packages/app/src/components/codium-billing.ts`, `codium-purchase.tsx`                                | `billingProgress(request, plan)`: a change to a higher-ranked plan (an upgrade, paid in Stripe's checkout window) says "Finish in the Stripe window…"; a smaller plan and Keep my plan say "Saving your plan change…". With the plan unknown, a change is taken for an upgrade. `CodiumBillingStatus` takes `plan`.                                                                                                                                                                                                            |
| `packages/tui/src/component/dialog-model.tsx`                                                         | `modelDescription(providerID, codium, fallback)`: a locked or preview Codium entry shows its badge in Favorites and Recent (instead of the provider's name) and over "(Favorite)" in its provider section, so a model the plan no longer includes never looks included.                                                                                                                                                                                                                                                        |
| `packages/engine/src/provider/provider.ts`                                                            | `defaultModel`: a recent Codium entry the listing marks `locked` is skipped, so `vector run` without `--model`, `vector agent create`, review, distill and ACP defaults fall through to the next recent choice or the person's own provider, as the app and the TUI already do. An explicit `cfg.model` is left as configured. Manual-only entries the person chose stay theirs.                                                                                                                                               |
| `packages/engine/test/server/httpapi-auth-codium.test.ts` (new), `auth-create.test.ts`                | The handler-level test the credential refresh lacked: `PUT /auth/vector` forces `ModelPlans.Service.catalog(effective, { force: true })` with the credential `FreeModels.CredentialsService` answers (not the request body), another provider's write reads nothing, and a hanging catalog read still answers after `CREDENTIAL_READ`. The `auth-create` case is renamed to what it checks (the real route graph answers at once with model reads disabled).                                                                   |
| `packages/app/e2e/fixtures/account-settings.jsx`, `e2e/regression/account-settings.spec.ts`           | The codium-error view renders inside a `<Suspense>` with a visible fallback, as the app's route does; `?status=pending` holds Codium status reads until `accountFixture.answer()`. New cases: the card stays up (See plans, then Change plan) while the read is held, with one read; a card's Update card and Settings' Confirm payment (closed) start the 5/20/60 s reads; an upgrade's progress line is the Stripe window's.                                                                                                 |

### Fifth step: second review of the uncommitted change

A second review raised six findings; each was checked against the code and all six held up, so all are fixed below.
Three were reproduced by a test that failed before its fix (the automatic compaction, the `small_model` and the review
catalog cases); the other three by reading the code paths named in the finding. None was rejected or deferred.

| File                                                                                                                                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/features/pull-requests/ai-review.ts`, `packages/app/src/pages/home.tsx`                                                           | Now that locked entries are listed, two app paths could pick one by themselves from the raw recents. `reviewCatalog` leaves out an entry the listing marks `locked`, so a Vectorscope review in the app (agent recents, or a review model in review.json) and the model GitHub Actions reviews are set up with (`workflowModel`) move on to the next candidate; a new automation takes the first recent that is listed and not locked.                                                               |
| `packages/tui/src/context/local.tsx`                                                                                                                | `toggledFavorites(model, favorites, valid)`: removing a favorite never asks whether it is valid, so a favorite that became locked after a downgrade (still under Favorites with its badge) can be removed; only adding one is checked.                                                                                                                                                                                                                                                               |
| `packages/engine/src/acp/config-option.ts`                                                                                                          | ACP model options name a locked or preview Codium entry's badge (`listingBadge`: "Vector Codium/Claude Opus 5.5 (Codium · Ultra)") with its explanation as the option's description, variants included. The directory's own `modelOptions` only feed the default, which already skips Codium.                                                                                                                                                                                                        |
| `packages/engine/src/session/compaction.ts`, `packages/engine/src/session/prompt.ts`                                                                | `SessionCompaction.create` takes an optional `selected`, and both automatic compaction calls in the run loop pass the message's. A session on Codium Auto that compacts by itself keeps Auto: the marker and the continue message carry `selected`, so the app and TUI restore, the engine's last-model fallback and the next message without a model pick with Auto again, while the summary and the continuation stay on the model Auto picked for the request. `/compact` with Auto is unchanged. |
| `packages/app/src/vector-account.ts`, `components/settings-v2/account.tsx`, `settings-vector-codium.tsx`, `codium-purchase.tsx`, `codium-error.tsx` | `newestRead()`: each screen showing the plan applies only its newest status read's answer, so a read started before Stripe's notification that answers after a later one no longer shows the plan from before the purchase. Settings → Usage no longer drops an announcement while a read is in flight (Refresh stays disabled meanwhile); a failed turn's card ignores a shared read that a newer one overtook.                                                                                     |
| `packages/engine/src/provider/provider.ts`                                                                                                          | `getSmallModel`: a `small_model` naming a Codium entry the listing marks `locked` gives no helper model, as before such entries were listed, so the title falls back to the conversation's own model and Brain and Explore helpers are skipped instead of refused.                                                                                                                                                                                                                                   |

### Sixth step: third review of the uncommitted change

A third review raised five findings; two of them (the shared plan read keyed by the bridge object, and that read keeping
a failure) are one defect, so four fixes follow, with their browser cases. All held up against the code; none was rejected or deferred. The
shared read was reproduced by two new vector-account cases that fail on the bridge-keyed read; the plans dialog cases
and the image-routing gap were read from the code paths the findings name and are covered by new browser cases (CI
only).

| File                                                                                                                     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/vector-account.ts`, `components/codium-error.tsx`                                                      | `codiumSubscribed` keyed its one shared read by the desktop bridge, which is one object for the app's whole life, so for up to a minute after signing out and in as someone else a card could name the last account's fix; it also kept a failed read as "no plan" for that minute. The read now belongs to the email `status()` names (none while signed out), and a read that throws or answers with `error` answers no plan for the cards already waiting on it and is dropped, so the next card asks again. A mounted card also reads again on the bridge's `onChange`. |
| `packages/app/src/components/codium-billing.ts`, `codium-purchase.tsx`, `codium-purchase.css`, `settings-v2/account.tsx` | `CodiumPurchase` takes the account's whole `status` instead of its plan, and `planUnknown(status)` holds every offer's button back until a signed-in read has answered without an error: before, a subscriber whose read was pending or failed was offered Subscribe on every plan (which vectordev.ai refuses) from the dialog a failed turn's Change plan or a locked pick opens. The list says "Reading your plan…", the read's error, or "Sign in to Vector to choose a plan." instead. The dialog maps a read that throws to such an error, so it never reads forever. |
| `packages/app/src/components/codium-purchase.tsx`                                                                        | While a smaller plan is scheduled, `DialogCodiumPurchase` shows "Switches to Plus on <date>." with Keep my plan above the plans, as Settings > Account does, so the list's "Keep your plan first" line has its button wherever the plans open.                                                                                                                                                                                                                                                                                                                              |
| `packages/app/e2e/regression/codium-image-routing.spec.ts`                                                               | The spec's only case had a non-Codium model chosen, so the older provider filter dropped every Codium entry before the Auto, locked and manual-only guard ran, and the case passed without the guard. Two cases now choose a text-only Codium model (through the config's `model`): with one plain Codium image model beside image-capable Auto, locked and manual-only entries that reason (so they outrank it), the prompt goes only to the plain one; without it, nothing is sent. The first case stays as it was.                                                       |
| `packages/app/e2e/fixtures/account-settings.jsx`, `e2e/regression/account-settings.spec.ts`                              | `?status=failed` makes every status read throw. Two cases: the dialog with the read held shows the plans with no button and "Reading your plan…", then Current plan and Upgrade once it answers, never Subscribe; with the read failing it shows the error and no button. With a smaller plan scheduled, the dialog opened from a failed turn shows the switch and Keep my plan, which sends `{ kind: "keep" }`.                                                                                                                                                            |

## Tests

Every file below ran on its own from its package, through `/home/user/.tools/vector-serial`, `--timeout 30000`
(`--isolate` in `packages/app`, `--no-env-file` in `packages/desktop`), with XDG and `VECTOR_TEST_HOME` roots under
`/tmp/vector-codium-A20/`. None starts a nested Bun process; the engine session test runs `echo` through `/bin/sh`.

| File                                                              | First step                    | Second step (final tree)      |
| ----------------------------------------------------------------- | ----------------------------- | ----------------------------- |
| `packages/core/test/model-plans.test.ts`                          | 34 pass, 0 fail (344 expects) | 36 pass, 0 fail (360 expects) |
| `packages/core/test/model-plan-catalog.test.ts`                   | 5 pass, 0 fail (21 expects)   | 5 pass, 0 fail (21 expects)   |
| `packages/app/src/utils/task-intelligence.test.ts`                | 16 pass, 0 fail (116 expects) | not changed                   |
| `packages/app/src/components/dialog-select-model.test.ts`         | 51 pass, 0 fail (277 expects) | not changed                   |
| `packages/app/src/components/codium-error.test.ts`                | 8 pass, 0 fail (60 expects)   | not changed                   |
| `packages/app/src/components/codium-billing.test.ts`              | 11 pass, 0 fail (45 expects)  | not changed                   |
| `packages/app/src/components/settings-v2/account-model.test.ts`   | 19 pass, 0 fail (45 expects)  | not changed                   |
| `packages/app/src/vector-account.test.ts`                         | 7 pass, 0 fail (27 expects)   | 8 pass, 0 fail (30 expects)   |
| `packages/desktop/src/main/swarm-plan.test.ts`                    | 21 pass, 0 fail (61 expects)  | not changed                   |
| `packages/desktop/src/main/billing-navigation.test.ts`            | 6 pass, 0 fail (47 expects)   | not changed                   |
| `packages/desktop/src/main/vector-account.test.ts`                | 26 pass, 0 fail (282 expects) | 29 pass, 0 fail (298 expects) |
| `packages/tui/test/component/dialog-model.test.ts`                | 6 pass, 0 fail (19 expects)   | not changed                   |
| `packages/engine/test/provider/model-plans.test.ts`               | 12 pass, 0 fail (58 expects)  | 13 pass, 0 fail (63 expects)  |
| `packages/engine/test/session/codium-auto.test.ts`                | 15 pass, 0 fail (53 expects)  | not changed                   |
| `packages/engine/test/cli/models-codium.test.ts` (new)            | 1 pass, 0 fail (3 expects)    | not changed                   |
| `packages/engine/test/agent/codium-generate.test.ts` (new)        |                               | 2 pass, 0 fail (5 expects)    |
| `packages/engine/test/server/auth-create.test.ts`                 |                               | 2 pass, 0 fail (9 expects)    |
| `packages/engine/test/server/httpapi-global.test.ts`              |                               | 3 pass, 0 fail (6 expects)    |
| `packages/engine/test/server/httpapi-control-plane.test.ts`       |                               | 1 pass, 0 fail (2 expects)    |
| `packages/engine/test/server/httpapi-teams-authorization.test.ts` |                               | 2 pass, 0 fail (7 expects)    |

Third step (final tree), each on its own as above:

| File                                                   | Result                        |
| ------------------------------------------------------ | ----------------------------- |
| `packages/engine/test/session/codium-auto.test.ts`     | 18 pass, 0 fail (63 expects)  |
| `packages/engine/test/session/compaction.test.ts`      | 67 pass, 0 fail (173 expects) |
| `packages/engine/test/provider/model-plans.test.ts`    | 13 pass, 0 fail (63 expects)  |
| `packages/engine/test/agent/codium-generate.test.ts`   | 2 pass, 0 fail (5 expects)    |
| `packages/engine/test/server/free-model-guest.test.ts` | 15 pass, 0 fail (121 expects) |

`free-model-guest` covers a title agent with a model of its own (a free one), the branch the title change reworked.

Fourth step (final tree), each on its own as above:

| File                                                      | Result                       |
| --------------------------------------------------------- | ---------------------------- |
| `packages/app/src/components/codium-error.test.ts`        | 11 pass, 0 fail (74 expects) |
| `packages/app/src/components/codium-billing.test.ts`      | 12 pass, 0 fail (49 expects) |
| `packages/app/src/vector-account.test.ts`                 | 10 pass, 0 fail (52 expects) |
| `packages/engine/test/server/httpapi-auth-codium.test.ts` | 2 pass, 0 fail (10 expects)  |
| `packages/engine/test/server/auth-create.test.ts`         | 2 pass, 0 fail (9 expects)   |
| `packages/engine/test/provider/model-plans.test.ts`       | 14 pass, 0 fail (67 expects) |
| `packages/tui/test/component/dialog-model.test.ts`        | 7 pass, 0 fail (27 expects)  |

The new `model-plans` case ("a recent Codium model the plan no longer includes is never the default …") failed on the
tree before the `defaultModel` fix (it got `vendor/locked`) and passes after it. `dialog-select-model.test.ts` (it
imports the changed plans dialog) ran again: 51 pass, 0 fail (277 expects). `provider.test.ts` (the general
`defaultModel` cases) ran again: 120 pass, 1 fail, the same "configured model whose provider this version no longer
offers" case described above, on the configured-model fallback the recent-entry change does not reach.

`packages/engine/test/provider/provider.test.ts` (the general `getSmallModel` cases) ran too: 120 pass, 1 fail. The
failure, "defaultModel skips a configured model whose provider this version no longer offers" (expects `anthropic`,
gets `amazon-bedrock`), fails the same way with `provider.ts` put back to `HEAD` for the run, so it does not come from
this change; which ambient setting in this sandbox lists Amazon Bedrock was not looked into (that would mean reading
the environment). It is left for CI to confirm.

"Not changed": neither the file nor the code it covers changed in the second step, so it was not run again. The
engine server files run the real route graph (`auth-create`) or the root routes with mocked services (the other three,
which now also mock `FreeModels.CredentialsService` and `ModelPlans.Service`); none starts a nested process.

Mutation checks (each reverted from a backup outside the worktree, and the file's suite rerun green):

- Routing filter (`codiumTarget` returning true): both new task-intelligence cases fail.
- Swarm filter (`automaticCodium` always true): both new swarm cases fail; dropping the locked-primary refusal fails
  the second.
- Desktop client check (`tokenClient(...) === "never"`): the new desktop-only grant case fails.
- Picker guard (`pickModel` never calling `plans`): the dialog-select-model locked-choice case fails.
- Run-loop Auto resolution (the block disabled): the new codium-auto case "the turn after a shell message that kept
  Auto picks once …" fails (14 pass, 1 fail).
- Second step, forced read: joining the read under way (`pending ??=`), keeping an overtaken read's answer, and not
  resetting `expires` each fail the core "a forced read starts after what changed the plan" case.
- Second step, desktop: `refreshModels` outside the queue fails both race cases; reading the token when asked rather
  than when run fails the sign-out case and the account-switch case.
- Second step, app: dropping the generation check after the models read fails "one a newer purchase overtook
  announces nothing".
- Second step, engine: no Auto resolution in `Agent.generate` fails both codium-generate cases; `generateObject` for
  Codium fails the first; no `small_model` Auto branch fails the new provider case.
- Third step: treating the title agent's Auto as its own model (`own = ag.model`) fails the title case; keeping the old
  skip test (`!ag.model`, `input.providerID`) fails it too, since the title then goes to the conversation's own model
  when the plan has no Auto; dropping the compaction agent's Auto branch fails both compaction cases.
- Fourth step: `runBilling` re-reading only on `completed` fails the codium-error confirm-payment case and the
  vector-account runBilling case; no shared plan read (`codiumSubscribed` always reading) fails the vector-account
  shared-read case; the card's portal buttons back on the old direct `billing(...).then(codiumChanged)` fail the three
  new codium-error cases; `authSet` checking the wrong provider ID fails both httpapi-auth-codium cases.

The files Prettier reformatted after their first pass were run again and passed with the counts above.

Typechecks, each through `vector-serial`, all exit 0 on the final tree of each step (run again after the second):
`packages/core` `bun typecheck`; `packages/app` `bun typecheck` and `bun typecheck:e2e`; `packages/desktop`,
`packages/tui` and `packages/engine` `bun typecheck`. The third step changed only engine files and reran
`packages/engine` `bun typecheck` (exit 0). The fourth step reran `packages/app` `bun typecheck` and
`bun typecheck:e2e`, `packages/tui` and `packages/engine` `bun typecheck` (all exit 0; core and desktop did not change).
Prettier `--check` passes on every changed file.

Fifth step (final tree), each on its own as above (the app files without `--isolate` except `dialog-select-model`):

| File                                                                    | Result                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/app/src/features/pull-requests/ai-review.test.ts`             | 97 pass, 0 fail (366 expects)                                         |
| `packages/app/src/vector-account.test.ts`                               | 11 pass, 0 fail (54 expects)                                          |
| `packages/app/src/components/codium-error.test.ts`                      | 11 pass, 0 fail (74 expects)                                          |
| `packages/app/src/components/codium-billing.test.ts`                    | 12 pass, 0 fail (49 expects)                                          |
| `packages/app/src/components/dialog-select-model.test.ts` (`--isolate`) | 51 pass, 0 fail (277 expects)                                         |
| `packages/tui/test/context/local.test.ts`                               | 5 pass, 0 fail (11 expects)                                           |
| `packages/tui/test/component/dialog-model.test.ts`                      | 7 pass, 0 fail (27 expects)                                           |
| `packages/engine/test/acp/config-option.test.ts`                        | 17 pass, 0 fail (22 expects)                                          |
| `packages/engine/test/session/codium-auto.test.ts`                      | 19 pass, 0 fail                                                       |
| `packages/engine/test/provider/model-plans.test.ts`                     | 15 pass, 0 fail                                                       |
| `packages/engine/test/session/compaction.test.ts`                       | 67 pass, 1 skip (the file's own `it.live.skip`), 0 fail (173 expects) |

Fifth-step mutation checks, each reverted from a backup outside the worktree: without the run loop passing
`selected`, the new codium-auto case "a session on Auto that compacts by itself stays on Auto" fails (the marker has no
`selected`); returning the locked `small_model` fails the new model-plans case (it gets `vector-plan/vendor/locked`);
without the `reviewCatalog` filter the new ai-review case fails; a `newestRead` that always answers newest fails the new
vector-account case; checking validity before removal fails the new TUI favorites case. The ACP case asserts option
names only the badge change produces. Typechecks, through `vector-serial`, exit 0: `packages/app` `bun typecheck` and
`bun typecheck:e2e`, `packages/tui` and `packages/engine` `bun typecheck` (core and desktop did not change). Prettier
also reflowed unrelated lines of `home.tsx` and `ai-review.test.ts`, which were already unformatted at `HEAD`; those
hunks were put back so the diff holds only this step's lines, so `prettier --check` still flags those two files for
the lines this step did not write. Every other file this step changed passes `--check`.

Sixth step (final tree), each on its own as above, without `--isolate` except `dialog-select-model`:

| File                                                                    | Result                        |
| ----------------------------------------------------------------------- | ----------------------------- |
| `packages/app/src/vector-account.test.ts`                               | 13 pass, 0 fail (63 expects)  |
| `packages/app/src/components/codium-billing.test.ts`                    | 13 pass, 0 fail (54 expects)  |
| `packages/app/src/components/codium-error.test.ts`                      | 11 pass, 0 fail (74 expects)  |
| `packages/app/src/utils/task-intelligence.test.ts`                      | 16 pass, 0 fail (116 expects) |
| `packages/app/src/components/dialog-select-model.test.ts` (`--isolate`) | 51 pass, 0 fail (277 expects) |

Sixth-step mutation check, reverted from a backup outside the worktree: the shared read keyed by nothing but its age
(as the bridge-keyed read behaves, since the bridge never changes) fails both new vector-account cases, "the shared
answer belongs to the account signed in" and "a failed read answers no plan … and the next card asks again".
Typechecks, through `vector-serial`, exit 0: `packages/app` `bun typecheck` and `bun typecheck:e2e` (no other package
changed in this step). Prettier `--write` left every file this step touched formatted.

## Benchmark (packages/app/AGENTS.md)

No session or timeline file changed (`pages/session/*` is untouched; the restore of `selected` lives in
`context/local.tsx`), but the earlier "not applicable" understated it: `CodiumError` renders in every timeline error row
of a Codium failure, and the first version of its plan read suspended the session page (fourth step). That read is now
a signal from one shared, minute-long read (`codiumSubscribed`), so a card mount neither suspends nor starts a request
of its own; since the sixth step it also asks the desktop's in-memory `status()` (an IPC call, no network) for whose
account the shared read is. No production benchmark was recorded: it needs the app and server running, which this lane's rules forbid
here. Timeline rendering with Codium error rows therefore still wants the packages/app benchmark (baseline against
`2722736d`) in CI or by the owner before release; it is listed under "Remaining".

## Not provider acceptance

`ROUTE_ACCEPTANCES` stays empty, so production `/models` lists no model and every listing, badge and picker behaviour
here is verified against fixtures only. Sol stays staged. Nothing here is acceptance of Stripe's upgrade checkout,
portal card update or 3-D Secure confirmation in the billing window (A60, the protected test-mode lane).

## CI only

- `packages/app/e2e/regression/account-settings.spec.ts` (Playwright), including the `page.clock` 5/20/60 s reads with
  one models read before each, and the card buttons; the fourth step's cases (the card inside `<Suspense>` while its
  plan read is held, the card's Update card and Settings' Confirm payment reads, an upgrade's progress line);
  `codium-image-routing.spec.ts` with the new entry kinds (the guard itself is exercised only by the two cases with a
  Codium text model chosen; the first case shows the older filter), and the sixth step's plans dialog cases (held and
  failed status reads, Keep my plan); locally only `bun typecheck:e2e`.
- `packages/engine/test/session/prompt.test.ts` and `packages/engine/test/cli/vector-account-usage.test.ts` (nested
  Bun processes), the HttpApi exerciser, `check:generated` and the typecheck matrix in `vector-codium.yml`.
- Electron behaviour of the billing window and IPC, `vector-account-refresh-models` included, and
  `packages/desktop/src/main/vector-account.integration.test.ts` (it spawns Bun).
- A forced read against the real `/models`: no test or step here calls vectordev.ai (engine tests set
  `VECTOR_DISABLE_MODELS_FETCH`; the client tests use in-process fakes).

## Review items not taken, and why

- A forced Codium catalog read on a credential write, a desktop `refreshModels` and its race tests (plan step 11 a/b,
  critique items 1 and 2): left open by the first step, built in the second (above). The schedule
  (`refreshAfterPurchase`) stays module-level, so it survives the dialog closing, and `createCodiumBilling` still adds
  no `useServerSync`, so the P2 fixture (Platform and Dialog providers only) still mounts; providers are re-read by the
  app layout's `onCodiumChange` subscription. Critique item 10 (Auto on direct-model paths) is built too.
- The swarm reading follows the review: an unlocked primary the person chose stays (Auto or manual-only); only a
  locked primary is refused.

## Final gate

- **Tree.** `git status` before the commit showed only the A20 source, test, fixture and doc files listed in the
  tables above (67 changed, 4 new: this record and the three new engine tests `agent/codium-generate.test.ts`,
  `cli/models-codium.test.ts` and `server/httpapi-auth-codium.test.ts`). It also showed 24 untracked Bun transpiler
  cache files under `packages/app/bun/@t@/` (`*.pile`, written by a sixth-step test run); they were deleted, not
  committed, and the reruns below did not recreate them. Backups, logs and XDG roots stay outside the worktree
  (`/tmp/vector-codium-A20/`). No `api/` file, no cloud-agent file and no generated file changed.
- **Last edit re-checked.** The last source edits were the sixth step's app files (`vector-account.ts` and its test,
  the plans dialog and billing files, the two browser specs and their fixture). Rerun after them, through
  `vector-serial`, `--timeout 30000`, with fresh XDG and `VECTOR_TEST_HOME` roots under `/tmp/vector-codium-A20/gate/`:
  `src/vector-account.test.ts` 13 pass, 0 fail (63 expects); `src/components/codium-billing.test.ts` 13 pass, 0 fail
  (54 expects); `src/components/codium-error.test.ts` 11 pass, 0 fail (74 expects);
  `src/components/dialog-select-model.test.ts` (`--isolate`) 51 pass, 0 fail (277 expects); `packages/app`
  `bun typecheck:e2e` exit 0. Every other file's last pass is recorded in the sections above and none of them changed
  after it. Only this record and the A19 record's status line changed after these reruns.
- **Push.** The A20 commit (`b151dded`) went through `vector-serial` to `codium-next` (a fast-forward from
  `2722736d`); its pre-push hook passed, but with `packages/web` replayed from Turbo's cache. The push of the same
  commit to `codium` ran `packages/web` `astro check` afresh and failed it: `packages/web/test/desktop-account.test.ts`
  imports the desktop's `createVectorAccount` by relative path (outside Turbo's inputs for web, hence the stale hit),
  and its two fixtures lacked the new required `models` dependency (ts2345). A follow-up commit adds
  `models: async () => undefined` to both (neither test refreshes models). After it, through `vector-serial` with the
  gate's XDG roots: `packages/web` `test/desktop-account.test.ts` 12 pass, 0 fail (132 expects; it also runs the
  sign-in exchange through the desktop's new `client: "desktop"` check); `test/model-plans.test.ts` 21 pass, 0 fail
  (163 expects) and `test/model-plan-status-api.test.ts` 20 pass, 0 fail (130 expects), the web files that import the
  changed `@vectordevai/core/model-plan-status`; `packages/web` `bun typecheck` exit 0 (195 files, 0 errors).
  `test/model-plans-api.test.ts` also imports it but spawns Bun, so it is left to CI. Both commits are then pushed to
  `codium-next` and `codium`, the hook typechecking every package one at a time. The push to `codium` starts the
  scoped `vector-codium.yml` workflow on its own; no workflow is dispatched by hand, and its result is not recorded
  here.

## Remaining (open)

1. **CI.** Nothing here has run in GitHub CI: the account-settings and image-routing browser specs (including the
   5/20/60 s `page.clock` reads and the step 0 low-usage expectation that failed run 41138356775), `prompt.test.ts`,
   `vector-account-usage.test.ts`, the desktop integration test, the HttpApi exerciser, `check:generated` and the
   typecheck matrix. The push to `codium` starts the scoped `vector-codium.yml` workflow on its own (see "Final
   gate"); its result is not recorded here.
2. **A16 server hardening.** A purpose-stripped code minted and consumed as a desktop grant stays valid until it
   expires; checking the expected purpose before consuming the code (`api/account/cli-exchange.ts`,
   `api/_lib/desktop-account.ts`) is A16's, and A20 touches neither file. The desktop refuses to keep a grant that is
   not `client: "desktop"`.
3. **WSL servers keep their list for up to a minute** (accepted limit, not a code gap). `refreshModels` writes only
   the app's own sidecar; a WSL engine holds the account only in its environment (`VECTOR_CLI_TOKEN`), so its 5 and
   20 s reads after a purchase may still show the kept list. A write would restart it (`replaceAccount`) or store the
   token on the WSL disk, and a refresh-only route would be a new public HttpApi route; its kept list lapses by the 60
   s read.
4. **Not checkable here:** Stripe's upgrade checkout return, the portal's card update return and a 3-D Secure
   confirmation from the portal home in the billing window (A60).
5. **App benchmark.** packages/app/AGENTS.md asks for a production benchmark around session and timeline changes. No
   `pages/session/*` file changed, but `CodiumError` renders in Codium error rows, so a timeline benchmark with such
   rows (baseline `2722736d`) should run in CI or with the owner; this sandbox may not start the app or server.
