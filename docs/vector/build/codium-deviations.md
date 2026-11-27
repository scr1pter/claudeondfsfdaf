# Codium implementation notes

Updated November 8, 2026. These notes describe the committed build on `codium`; they do not replace the contract or the owner's tier decisions.

## Recovered state

The handoff's newer Mac-only deviation file and A09 partial patch were unavailable in this workspace. A09 was reconstructed from the committed build contract at `591cd1f0`, especially §4.4, §7.2 and invariant M6. No claim is made that the Mac-only notes were recovered.

## A09 decisions

- Checkout records the terms version actually published on `origin/main`: October 28, 2026 (`4e7ce1ef`). The older legal pages on the Codium branch remain unchanged. A60 still must merge the reviewed legal release, update both effective dates and this checkout version together, and complete the legal review before sales open.
- A separate `purchase-confirmation` outbox action extends the §4.8 action list. Email delivery cannot prevent a paid entitlement from being provisioned. An unavailable email configuration never marks a receipt sent; it retries through the outbox and can become a dead letter for the owner. Receipt contents state the monthly price, immediate start, withdrawal and account cancellation.
- Carry keeps payment provenance through repeated upgrades. A reversal of an earlier source charge removes its remaining carried portion even after another upgrade. The 12-minute true-up subtracts hosted debits applied after the source key was replaced; a retired provider key's limit alone cannot establish its remaining allowance.
- The test-mode key cap applies to the sum of new credits and carry. The live carry formula is unchanged.
- Downgrade creation persists a retry token before creating a schedule. Releasing that schedule through `/change` or the portal's cancellation flow clears the token, so a later attempt creates a fresh schedule rather than reusing a released one.

## Still gated

A09 does not complete A10–A60 or authorize Codium sales. Risk handling, setup, the new account UI, legal release, payment-provider test-mode end-to-end checks and launch gates remain in their contract order. Existing subscriptions stay manageable through the no-change portal; older plan-change requests receive the account-page link.

## A09 validation

Focused A09 coverage: 21 passing tests, including chained upgrades, source reversals, hosted settlement after replacement, retry consistency, concurrent admission, downgrade interruption and consent. Existing billing, outbox, pool, renewal, replay and mode files pass individually. The HTTP billing integration file passes 42 tests against a real local Valkey, including desktop/web authentication and the ten-per-hour plan-change limit. Total: 230 passing tests. The six initially skipped Valkey-only cases in billing, outbox and replay subsequently passed against an ephemeral local Valkey server; each file ran alone and the server was stopped afterward. API typecheck passes from `packages/engine` using `bun typecheck --project ../../tsconfig.json`.

A safety review checked money, privacy and retry behavior separately from the implementation. Sales, deployments, Stripe, OpenRouter and customer repositories were not changed; all service boundaries in the tests are local fakes.

## Next phase order and external gates

Continue one work package per tested commit; do not open sales after P2 alone.

1. **A10 risk:** add the first-high-value 3-D Secure decision to both checkout paths, actionable early-fraud refunds, dispute collection pause/unpause/cancel, and the trust/pool-ramp outbox action. The current code records risk and disables access; it does not yet perform all those Stripe writes. Exercise the matrix and older-charge cases against fakes. The acceptance check that Stripe subscription-mode Checkout accepts the chosen 3DS field remains a protected test-mode end-to-end job.
2. **A11 switches and funding:** extend the existing switch reader and owner sender with the 30-second cache/audit, collection pause/resume, funding history/runway, low-water/watchdog/spike alerts. Sales-off must not stop renewals or already-paid upgrades. Test every refusal and time boundary locally with fakes.
3. **A12 owner controls:** add the private owner page and endpoints. Require the existing Google-owner identity and fresh OAuth `amr` for mutations; a refreshed token's `iat` cannot satisfy that rule. Show account IDs rather than email addresses and test both authorization and mutation audit.
4. **A13 spend webhook:** verify the raw-body HMAC, email only for the main team, escalate hosted flags at 75%/100%, and atomically refuse de-escalation from a late event. Never invoke a provider pause/deployment API.
5. **A14 setup:** revise dry-run/setup scripts, environment examples and crons together. Remove the obsolete change portal, ensure exactly the reviewed webhook event list, reject runtime restricted keys for setup, and add the explicit `CODIUM_STRIPE_AUTOMATIC_TAX` switch. Only fake `--apply` tests run during implementation; the owner runs the actual setup.

The ordinary Codium CI lane already ran before this work, so further branch pushes do not require asking again for a previously granted CI policy. Its external protected end-to-end job still needs the owner's `codium-test` environment, test secrets and approval. Before sales, owner tasks also include Stripe verification/products/runtime permissions/dashboard settings and tax choice, the separate preview store and deployment protection, funding/auto-top-up, OpenRouter privacy and resale checks, and the reviewed legal release. Hardware, new hosted services, account settings, purchases and deployment are not prerequisites for implementing these five packages with local fakes.

As A10 registers the remaining real outbox handlers, update unit tests that currently use `pool-ramp`/`pause-collection` as synthetic handlers; preserve production's refusal to register duplicate handlers.

## A17 decisions (admission and chat)

Intent-preserving corrections to the contract text, recorded with the A17 source. Details and validation are in [codium-a17-admission-notes.md](codium-a17-admission-notes.md); the reservation derivation is in [codium-a17-context-decision.md](codium-a17-context-decision.md).

- **Larger fixed reservations (owner decision).** Each attempt reserves the captured native window plus the configured maximum reply at the highest captured rates, rounded up to integer micro-dollars; Max and Ultra reserve two attempts. This replaces the §4.12 / A15 hold table. Context windows are unchanged.
- **Fail-closed routes.** `ROUTE_ACCEPTANCES` is empty, so every real route answers 503 `MODEL_PLAN_MODEL_UNAVAILABLE` before the snapshot, credential, hold or fetch. No environment flag qualifies a route; tests inject qualification and integer reservations explicitly.
- **Durable spend ledger.** New store keys beyond §4.6: `model-spend:<pool>`, `model-reservations:<pool>` and `run-pool:<run>`. A pool's ledger starts only from a genesis whose nonce belongs to one freshly created, never exposed key (`Account.keyCreation`, `key.spendGenesis`). A pool without a trusted genesis fails closed, including pre-A17 keys used as an upgrade source; sales never opened and preview stores are flushed. A57 owns erasing these keys (or relying on their bounded TTLs) at account deletion.
- **M3 restated.** Available is `credits + carry − applied debits − max(usage, committed) − live holds − abandoned reservations`, the same figure in HOLD, ADMIT, status and `modelPlanCredential`'s read-only check. The committed floor never lowers the provider key's limit (M1) or the provider liability funding reports. Abandoned reservations (open past their deadline, outcome unknown) count until the period's ledger expires.
- **M6 restated.** Carry is `max(0, visible limit − max(usage, committed) − live holds − abandoned)`. The 12-minute true-up waits only for live holds and pending debits, treats abandoned reservations as consumed, and uses `max(final usage, committed + abandoned)`. Carry still only rises; a source that finally spent more than it held at the upgrade is charged to the successor pool as a `carry-shortfall` debit instead, so nothing is granted twice. A later true-up that supports more (the full limit after the pool ramp) raises the carry over the shortfall already charged, so an overspend is never charged twice either.
- **Repeated upgrades settle the previous carry.** A carry's full potential (`fullMicro`) is an upper bound until its own true-up marks it `trued` (a new optional field on the stored carry), and that true-up never runs once its key is replaced. An upgrade from a key whose carry is not yet trued settles it first from its source's current standing, counting that source's live holds as spent. Within the 12-minute delay a second upgrade therefore never grants held spend twice; allowance such a hold later leaves unspent is not returned.
- **Key replacement barrier.** `Account.transition` is saved before any source balance is read and cleared with the published key; HOLD and ADMIT refuse any record observed before it. A replacement whose target stops superseding the source before its key is published is abandoned and the current key serves again (M11, M12).
- **Abandoned key creations.** New optional `Account.abandonedCreations`: a replacement abandoned before its key was published (or a creation for another period that a new one replaces) keeps its `keyCreation` there until that key would expire, and the same period's next creation reuses the nonce, so OpenRouter's idempotent create answers a key that was made with its answer lost instead of a second funded one. The fence and the credential do not read it.
- **Fence answers.** A fence race (newer record, snapshot, period or intent) is 503 `MODEL_PLAN_RENEWING` with retry-after 1; an untrusted ledger or pool is 503 `MODEL_PLAN_POOL_UNAVAILABLE`, final. A run bound to another pool is 401 `MODEL_PLAN_RUN_EXPIRED`, final: an old signed run must start again after an upgrade or renewal. Other new codes: `MODEL_PLAN_ADDONS` (400), `MODEL_PLANS_CONFIGURATION` (503), internal `MODEL_PLAN_CANCELLED` (499). A19 must add these to the §4.10 client mapping.
- **M4 on chat and holds.** The admission credential and `holdPool` come from the entitlement snapshot and one OpenRouter key read, never Stripe. `holdPool` reads a stored snapshot by `readEntitlement`'s rules, as chat does: a missing or stale one is reconciled on demand, so a paying account is never refused a final 402 merely because its snapshot is not written yet (while another request is still writing an account's first snapshot, `readEntitlement` itself answers 503 `MODEL_PLAN_RENEWING` for an account with a Codium record; see "P3 review decisions"). Provisioning happens in reconcile; a key that is not ready gets one on-demand reconcile (at most one a minute), else `RENEWING`. The first request after payment is served once reconcile has provisioned the key. Any snapshot a request reconciles on demand (chat's recent-checkout refresh for a locked model, its credential retry, `holdPool`) gets `requireEntitlement`'s final answers for its plan state (402/403/409), never a retryable 503.
- **One run-id grammar.** A16's verifier accepted run ids with `:` and up to 256 characters, which the §4.6 held member and `run:<id>` cannot carry, so ADMIT refused such a run on every chat. The verifier now applies the admission grammar (`[A-Za-z0-9_.-]{1,128}`, not `-`). Run ids must also be globally unique: `run:<id>` and `run-pool:<id>` are keyed by the id alone, so a shared id would make two accounts share a ceiling and refuse each other (never grant extra allowance). Verifiers (A37, A51, A59) own that uniqueness.
- **Run guards by signed service and purpose.** §4.8 names the purpose (`cloud-agents`, `hosted`). A16 binds each run token's service to its prefix (`vrt_` cloud-agents, `vht_` hosted) and lets the verifier sign another purpose such as review, so a purpose-only rule could be evaded. The computer-use and live-session guards therefore apply when either the signed service or the signed purpose names them. Verifiers (A19, A37 and later) must return the service of their prefix; desktop and CLI callers cannot claim either purpose.
- **The stream is bounded by the request's deadline.** The gateway's own request bound (600 seconds after admission, or the run's deadline if sooner) also aborts the wait for a slow client to drain the stream, so a client that stops reading cannot hold the function until the platform kills it with nothing settled; the gateway's `finally` settles it as `broken`, as for a client abort.
- **Durable model settlement.** New outbox action `model-settle` beyond §4.8's list: a settlement whose answer is lost twice is retried by the outbox with the same known outcome (ids-only log). The reservation keeps counting at its full amount until then.
- **Lost admission answer.** When the store may have run ADMIT but its answer was lost, the gateway dispatched nothing for that ticket, so the outcome is known. `admitModelPlan` cancels that exact ticket at once, which frees its slot and reservation when the EVAL already ran; when that cancel answers `missing` (the EVAL has not run yet) or is lost too, it queues `model-settle` `{kind: "cancel"}` for the ticket at its deadline plus 60 seconds (the store call gives up after 3 s, so a delayed EVAL cannot land behind it). A late EVAL counts in full until that cancellation lands. Two cases are left as an abandoned reservation that counts in full until the period's ledger expires (customer-conservative, never free money): an EVAL delayed past that margin, and one whose cancel and queue writes both fail as well (logged with ids only), as a settlement whose answer and queue are both lost is left counting in full.
- **`afterSettle` after a recorded or queued settlement.** §4.8/A17's "finally release, settle, `afterSettle`" is kept for every admitted request: the hooks run once after the settlement landed, was queued for the outbox, or (both failing) left the reservation counting in full, with the outcome the gateway knows. They are not called from the outbox, which has no caller; a hook must not treat the call as proof the ledger already holds the charge. A request refused before admission reaches no `afterSettle`.
- **ADMIT purges before checking.** As §4.7 says, ADMIT purges expired members of the concurrency sets it reads before any check (also on refusals) and counts live members with `ZCOUNT`.
- **A03 model hold retired.** `modelPlanCredential` holds nothing; model requests are held only by ADMIT/SETTLE against the committed floor. The model settle script and its 30-second bridge outside the floor are removed. M2's "model requests and pool charges share one held set" is tested in both directions: on real Lua (ADMIT, SETTLE and `placeHold`), and through `holdPool` in memory and on Valkey against a reservation recorded as ADMIT records it. ADMIT and SETTLE are not emulated in memory.
- **Unknown outcomes are charged.** A completed answer that reports no cost commits its one-attempt reservation; a provider refusal (any non-OK answer) or transport failure after dispatch settles as `broken`, which commits every dispatched attempt at its full fixed reservation to the period's committed spend floor; the uncertain first attempt of a Max/Ultra retry is committed beside the second's charge. A commitment is permanent consumption for the period, not a hold: spend is `max(usage, committed)`, so it is never released when provider usage later shows less, and it counts against the day, Brain and run budgets too. Before A17 the gateway released such a hold immediately. This applies handoff 8.6 ("unknown post-dispatch outcomes retain worst-case allowance"; a 429/503 is not proof of no charge): a non-OK answer carries no cost report, so a definite refusal cannot be told from a billed one. Each such refusal costs one attempt's reservation (2.179072 USD of allowance for Kimi or Argon on Pro; two attempts on a failed Max/Ultra retry), which the owner should review with the reservation table before sales (A60). Clients do not multiply it: an answer given after dispatch is marked and final (see "P3 review decisions"), so each refused request the person or an agent sends commits at most one reservation. Before that repair the engine resent such answers up to ten times in 15 minutes (plus the AI SDK's and the V2 executor's own retries), each a fresh admission and a fresh commitment.
- **Nonmodel holds count today.** A live nonmodel hold has no admission day, so ADMIT counts it against today's daily share (conservative).
- **A51 obligation.** The common HOLD enforces only the month and the run's pool binding. Every nonmodel producer must enforce the shared day, Brain and run caps atomically, hold its worst case and never settle above it (a second upgrade inside the true-up delay counts a live hold as spent at its held amount), keep its run binding for its lifetime, settle before its hold lapses, keep holds within the carry true-up's retry window, and retry only `MODEL_PLAN_RENEWING` (plan-state refusals from `holdPool` are final). `holdPool` has no fixed `now` option: its deadline, PEXPIREAT and the fence's period check use the clock read after its credential waits, and a producer never passes a timestamp taken before them. A tripwire test fails when production code calls `holdPool`, `placeHold` or the HOLD script anywhere but `holdPool` itself.
- **A minimal A18 pull.** Status uses the nominal estimate for unqualified models and the reservation for qualified ones in `empty`, and shows the committed floor; Stripe-free status and `/models` projection remain A18's.
- `.env.example` is unchanged: `MODEL_PLAN_GLOBAL_INFLIGHT` and `MODEL_PLAN_PRIORITY_RESERVE` (default 0.2) are optional runtime limits validated at the enabled gate; A14's configuration check owns the example file.

## C-SOL decisions (Sol in; Terra and Astra out)

Intent-preserving corrections for the owner's decision of 30 Oct (`codium-tiers-v3-changes.md` §8). Details and validation are in [codium-csol-models-notes.md](codium-csol-models-notes.md).

- **Contract text superseded and edited in place.** `codium-build-spec.md` now points to §8 in the precedence line; §1.1 (Models, longest-context and requests-at-once rows, plus a "Not offered" line); §1.2 (the Astra row becomes a Sol evidence row); §4.1 `groups`; §4.6 `inflight:<id>:astra`; §4.7 the model-group check; §4.12 `inFlightGroup`, the Terra, Astra and Astra Long entries, "Terra → Argon" and "never Astra" (now "never a `manualOnly` model", the rule the judges test already enforces); the A15, A17 and A19 test and change lines; the A60 load check; B03; §8.1 risk 8; and §8.3 (decisions, open item 8 resolved, new open item 9 on Sol's `azure` tag). The older tier documents, the label plan and the A15/A17 notes keep their text with a one-line pointer.
- **The per-model-group in-flight cap is retired with Astra, its only group.** `Entitlements.groups`, `ModelPlanModel.inFlightGroup`, the admission `group` input, the `inflight:<id>:astra` key and the Lua group branch are gone. ADMIT and SETTLE take 12 keys: account, ent, held, debits, ledger, reservations, account in-flight, global in-flight, day, purpose, run, run-pool. The refusal order is account, global, month, day, period Brain, run.
- **A stored reservation that names a group fails closed.** The ledger's record grammar (`MODEL_SPEND_LUA` and its emulation) refuses any record carrying `group`, so a pool holding one reads as `MODEL_PLAN_POOL_UNAVAILABLE` for its period, as a pre-A17 key does. Only a preview or test store could hold such a record: sales never opened and Astra was never qualified.
- **Contract date and audit target.** `CODIUM_CATALOG_UPDATED` moves from `2026-10-27` to `2026-10-30`, and the offline audit's default target is a new `codium-endpoints-2026-10-30.json` manifest that pins the unchanged 23 Oct bytes and digest. The `2026-10-27` manifest stays as A15's historical target, because the A15 notes link to it. This departs from A15's literal date and fixture name.
- **A17 test list.** The HTTP case "fifth Astra on Max refused" and the real-Lua group-cap assertions are removed. In their place are a staged-Sol 503 case and a removed-model 400 case on the production catalog, a real-Lua case in which another account's live request fills the global set, and the fail-closed group-record case on real Lua and in the emulation. The A17 notes keep their counts as A17 evidence.
- **Sol stays staged.** Its `providerOnly: ["azure"]`, the request options it inherits from Luna and its `promptTokenLimit` are the 27 Oct hypothesis. It has no captured reservation and `ROUTE_ACCEPTANCES` stays empty, so every Sol id answers 503 `MODEL_PLAN_MODEL_UNAVAILABLE` before any snapshot, credential, hold or fetch. There is no environment bypass and no fabricated acceptance.

## A18 decisions (`/models`, status and estimate)

Intent-preserving corrections to the contract text, recorded with the A18 source. Details and validation are in [codium-a18-models-status-notes.md](codium-a18-models-status-notes.md).

- **Served models only.** `/models`, status's `empty` and estimate count only models the gateway serves: the catalog with its Pro floors, minus `models-off` (by id or upstream), minus routes without accepted evidence, and a plan's variant only when that variant is qualified too. With `ROUTE_ACCEPTANCES` empty, production lists no model and `empty` trips only when nothing is left, exactly as chat answers 503. This replaces A17's minimal pull (a nominal estimate for unqualified models in `empty`); `nominalModelPlanRequestCredits` remains a test and planning helper only.
- **`listed` is empty until A27.** Status and config send `listed: []`; A18 does not create `codium-perks.ts`. No perk service is configured today, so `listedPerks()` would list nothing either. Config's `publicCodiumTiers()` body and `s-maxage` header stay with A27 (§4.14).
- **`/models` reads the snapshot raw.** It uses `readSnapshot` (one KV GET), never `readEntitlement`, so a missing or stale snapshot never triggers a Stripe reconcile from the polled catalog; a plan shows while the snapshot is active, renewing, paused or frozen. The `codium` runtime switch off answers `{enabled: false, models: []}`.
- **Status follows the `codium` switch.** Status's `enabled` is `MODEL_PLANS_ENABLED` and the `codium` runtime switch on (its 30-second cache), as chat, estimate and `/models` decide; with either off, `enabled` and `access` are both false (no request can start), and the plan, its shares and its notices still show. Both are read beside the cached body, never kept in it.
- **`/models` fields not fixed by §4.12.** The singular `role` takes `default` over `floor` over `ceiling` when one id holds two roles; consumers resolve Auto from the entry's `auto: {floor, default, ceiling}` map. Auto's roles resolve only to served, unlocked, not manual-only models (a missing floor or ceiling falls back to the default, a missing default to the floor; without either, no Auto), its window is the smallest of its roles' and it follows its default model, whose `lab` and `weight` it carries (§4.12 lists `lab` for every entry). `limits: {inFlight}` is always sent: the snapshot's cap with a plan, Plus's public cap without one, as the locks are then Plus's. `judges` keeps pairs whose worker is usable and whose judge is usable and not manual-only, and is left out when empty. `review` is always sent but may lack members that are not served (`{}` at worst); without a plan it is Plus's. A locked model is described at its lock plan (Ultra during a preview). `weight` is rounded to 0.01.
- **Old clients get no manual-only models.** Without `X-Vector-Catalog: 2` they cannot keep manual-only variants out of helpers and routing, so the four-field list leaves them out along with locked models and Auto.
- **Status reads the snapshot.** `modelPlanStatus` takes the plan, period, state, caps and ramp from the snapshot by `readEntitlement`'s rules (M4) instead of listing Stripe subscriptions, and reads the pool only for the snapshot's own period key. An account with no Codium record gets the no-plan body with no snapshot read or reconcile. A missing snapshot that another request is still reconciling answers 503 `MODEL_PLAN_RENEWING` (retry-after 1), never a guessed body.
- **Status semantics not fixed by §4.11.** Frozen uses the paused shape (`active: true, access: false, plan.state: "frozen"`, its reason, no action); `action` uses `requireUsableSnapshot`'s map (`pausedPayment`), and no state emits `change-plan` yet; `today.used` is the share of today's limit, and `today` shows only while the plan has access; `plan.ramp.until` is the pool ramp (`ramp.poolUntil`); `forecastDate` is A32's period-average fallback with the §4.11 hiding rules (also hidden once the month is used up), and `history` is A32's.
- **`empty` is ADMIT's month figure without running requests.** `empty` trips below the cheapest served reservation of what is available as M3 counts it (credits + carry − applied debits − max(usage, committed) − live nonmodel holds − abandoned reservations), so an abandoned reservation or a long hold that leaves no room shows as empty, as ADMIT then refuses `MODEL_PLAN_EXHAUSTED`. Live model reservations are left out: they settle within their 11-minute deadline, ADMIT's refusal then says to wait for running requests, and the month would otherwise flicker to empty while a request runs. This narrows A17's "the same figure in HOLD, ADMIT, status" for this one flag; `left` and `low` stay shares of what is left of the month (`remaining`).
- **One daily figure, without running requests.** New read-only script `MODEL_SPEND_SCRIPTS.DAY` counts today's spend as ADMIT does (settled day bucket, live nonmodel holds, debits recorded today, open reservations admitted today) except that an open model reservation counts only once past its deadline (abandoned), as `empty` leaves live ones out. `today.used` and `today.reached` both use it. A live reservation is a whole fixed reservation (the model's captured window, one or two attempts) that settles within minutes, usually for far less; counted, it would move the meter by that much while the request runs and, through the 30-second cache, after it settles, and the jump would tell the subscriber a known amount as a share of the daily limit (P1). So `today.reached` agrees with ADMIT's `MODEL_PLAN_DAILY_LIMIT` whenever no model request is running (H5); while one runs, ADMIT may refuse a further request that status does not yet show as over the limit. It is display only.
- **The cache is version-checked.** `status:<id>` (§4.6) stores `{version, body}` for at most 30 s (less when a period end, grace end, UTC midnight or ramp end comes sooner) and is answered only while the snapshot's version matches, so an answer computed before a reconcile and stored after its clearing is never served for the new snapshot. `enabled` is added outside the cache.
- **Meters keep their declared fields.** The registry validates each §4.11 meter field as a share (0..1, rounded to 0.01), a whole count or a flag (`cloudAgents.exhausted`); a malformed or failing reader drops that meter only, including one that throws before returning its promise or has not answered within 1.5 s (`METER_TIMEOUT_MS`; the reader gets an `AbortSignal` for its own requests). A18 registers none, and none shows until perks are listed.
- **Estimate callers.** Account tokens, marked or not (S2 lets an unmarked token read status, which reveals more than a band), and run tokens through the run-verifier registry (§4.13 "account or run token"; S3's never-list does not name estimate). Browser sessions are not estimate callers. Estimate uses chat's gate (`requireModelPlanCaller` with `unmarked`), so a missing, malformed, oversized, expired, invalid or revoked account token answers 401 `CODIUM_SIGN_IN_REQUIRED` as at chat and `/models` (§4.10).
- **Estimate pool answers.** Until the snapshot's own period key is the account's (not made yet, revoked, or another period's), estimate answers 503 `MODEL_PLAN_RENEWING` with retry-after 1. That key without trusted credits (from before the A17 ledger) answers 503 `MODEL_PLAN_POOL_UNAVAILABLE`, final, as chat does.
- **Estimate model form only.** `{kind: "hosted" | "race" | "playbook"}` answers 400 `CODIUM_ESTIMATE_KIND` until A51, B06 and Track B add their rates. Unknown, staged or unserved and locked models answer chat's codes (400, 503, 403 with plan and plan name) with no amounts.
- **P2 rounds the pool too.** Rounding the units and the cost to steps 1.5× apart (§4.13) is not enough: the band edges fall at different fractions of a step, so asking at every step would narrow the pool to about 1.2%. The pool is also rounded down to the grid, so an answer depends only on the difference of the two steps and reveals the pool to one 1.5× step, no finer. Every rounding errs the same way, so an answer never understates a share. It can overstate one by up to 1.5× for each of the request count, the tokens, the cost step and the pool step: about 1.5⁴ ≈ 5× together. That is typically no band or one band, and at most three. For example, one full-window DeepSeek request on Plus is 9.8% of today's limit and is answered "10–20%".
- **New store key.** `estimate:<account>:<meterEpoch>:<phase>:<dailyShare>:<step>` (beyond §4.6) keeps each step's answer, as `{answer, poolStep}` with the pool's grid step it was worked out on, until a day after the period ends. `<phase>` is `ramp` while the period key's credits are still the pool ramp's share (`creditsMicro < fullCreditsMicro`, A10) and `full` after that. A kept answer is served only while the pool's current step is at or above its `poolStep`, so a carry that rises in the same phase tells a repeated question nothing (the kept answer only overstates). Carry can also fall in the same phase: a refunded, disputed or otherwise unavailable source charge drops its origin (`refreshCarry`, M6) on the next same-period reconcile or carry true-up. A kept answer from a higher pool step would then understate, so it is worked out again on the smaller pool and replaces the kept one; that reveals only the new pool step, as any fresh answer does. The ramp's end raises the pool about 3.3× and starts fresh answers, so answers from the ramp are not served for the rest of the month. The phase is read from the same key record as the total, so an answer computed with a ramped total is never stored under `full`. A57 erases the key or relies on its TTL.

## A19 decisions (core and engine clients, part 1)

Intent-preserving corrections to the contract text, recorded with the first part of the A19 source. Details, tests and
the remaining A19 work are in [codium-a19-clients-notes.md](codium-a19-clients-notes.md).

- **The code table is browser-safe.** §4.10 names `packages/core/src/model-plans.ts` as the client mapping. That module
  needs Node (file cache, crypto, the egress layer) and imports the status module, which the app bundles for the
  browser. The table (`gatewayFailure`, `failureKind`), `clientHeaders`, `AUTO_ID` and the purposes live in
  `model-plan-status.ts`; `model-plans.ts` re-exports them. `codium-auto.ts` imports `model-plans.ts` for types only.
- **Only listed codes are final.** "New error codes must be final" covers the §4.10 codes and the A17/A18 additions
  (`MODEL_PLAN_POOL_UNAVAILABLE`, `MODEL_PLAN_RUN_EXPIRED`, `MODEL_PLAN_ADDONS`, `MODEL_PLANS_CONFIGURATION`,
  `CODIUM_ESTIMATE_KIND`), not every `MODEL_PLAN_*` or `CODIUM_*` name: the gateway's transient chat failures
  (`MODEL_PLAN_UPSTREAM`, `MODEL_PLAN_STREAM`, `MODEL_PLAN_UNAVAILABLE`, `MODEL_PLAN_KEY_INVALID`,
  `MODEL_PLAN_RISK_UNAVAILABLE`) stay ordinary provider errors and keep the 5xx retry. Retried: `RATE_LIMITED`,
  `MODEL_PLAN_BUSY`, `MODEL_PLAN_RENEWING`, `MODEL_PLAN_CONCURRENCY`, `MODEL_PLAN_CAPACITY`. `MODEL_TOPUP_EXHAUSTED`
  and the internal `MODEL_PLAN_CANCELLED` are not classified. A local `CODIUM_AUTO` refuses a request for Auto itself.
  Superseded in part by "P3 review decisions": any answer the gateway marks `dispatched: true` is final, whatever its
  code.
- **The stored action stays three-valued.** §4.10's kinds are finer than the `credits | sign-in | unavailable` action
  stored on failed turns and read by released apps. The kind is stored beside it (`metadata.kind`, V2
  `providerMetadata.codium.kind`) and from the code (`failureKind`); the action is credits for credits, upgrade and plan
  answers, sign-in for sign-in, unavailable for run, daily, contact, wait, update and unavailable. A daily, run or Brain
  limit therefore never offers a purchase. The credit suffix is " See plans at <url>", or " Update your card at <url>" /
  " Confirm your payment at <url>" by the answer's `action`; upgrade answers end " Change plan at <url>".
- **Final codes are stopped below both retry loops; `packages/llm/src/route/executor.ts` is unchanged.** The AI SDK
  retries 408, 409, 429 and 5xx answers itself on calls with `maxRetries` (titles, model learning, fast turns), and the
  V2 executor retries 429 and 5xx. Both Codium transports (`ModelPlans.createFetch`, the V2 route's fetch) pass a final
  answer on as a 400 (`ModelPlans.finalAnswer`), and it is still classified by its code, so the shared executor needs no
  Codium codes. `createFetch`'s own refusals before a request (signed out, Codium switched off, a retired model) pass
  the same boundary, so its local 503 `CODIUM_UNAVAILABLE` also arrives as a 400. The V2 test shows one request for each final code and three (the executor's retries) for a temporary one.
- **Waiting for the account's other requests.** In V1, `MODEL_PLAN_CONCURRENCY` is retried after its retry-after
  without counting toward the attempt bound, within the 15-minute bound. Nor does it lengthen a later failure's
  backoff: that backs off from the counted failures only, so a transient gateway answer after the waits (which carries
  no retry-after) is retried after 2 s, not after minutes. V2 retries are the executor's (two retries), so a busy V2
  Codium turn can fail sooner.
- **Purpose header plumbing.** `X-Vector-Purpose` is added by the engine request preparation
  (`packages/engine/src/session/llm.ts`, `llm/request.ts`, beyond A19's list), last, for `vector-plan` models only,
  so a plugin or model header cannot set it and no other provider sees it: `title`, `brain` (model learning), `judge`
  (the judge agent), else `chat`; `createFetch` passes only a known purpose. Core V2 sends `chat`.
- **Helpers without a helper model are skipped.** Codium helper calls use Auto's floor, then its default; with neither
  usable, or a catalog without Auto (an older gateway), titles, model learning and the project copy's generated name
  (`packages/engine/src/server/routes/instance/httpapi/handlers/project-copy.ts`, beyond A19's list; it falls back to
  its random name) are skipped instead of running on the conversation's own model. The copy's name is sent as purpose
  `title`.
- **Interim listing.** Until the pickers, routing and swarms can tell entries apart (A20), the engine and Core V2 list
  only usable models (not Auto, not locked, not manual-only), the same set older clients get. Sessions already resolve
  Auto per message (part 2 below), so the listing waits only on A20. The decoded catalog keeps every entry for those
  consumers, and the listed entries carry their `codium` metadata.
- **`vector login` is a loopback PKCE flow with an Approve step.** The CLI listens on `http://127.0.0.1:<port>/callback`
  (port 0, or `--port` for SSH forwarding) using the shared hardened listener extracted from
  `packages/core/src/oauth/loopback.ts` (beyond A19's list); `/auth/cli` takes `purpose=cli` with that `port`, mints
  nothing until Approve, sends the code only to that loopback, and Cancel returns `error=access_denied` so the CLI stops
  waiting. The CLI stores only a grant whose claims are `client: "cli"` with a `jti`; the server is unchanged. Whether a
  token is marked is read from its claims, not from a stored flag. `vector login` over a copied token's sign-in goes to
  the browser; if another account approves there, the copied token's sign-in is signed out (its team choice and checked
  tokens with it) before the new grant is stored. The page asks again on a retry unless the person chose Approve.
  `vector login` over a marked grant asks vectordev.ai (`/api/account/cli-verify`) whether it still stands before saying
  "Already signed in": one revoked or expired since the day's check is signed out and the browser sign-in starts, so
  Codium's `CODIUM_SIGN_IN_REQUIRED` answer ("run vector login") never ends there; an unreachable site keeps it.
- **Copy.** Status notices say "Vector Codium is not available right now." (Codium switched off can come with a plan),
  and the CLI's plan lines show "N% left this month" and "Today: N% of today's limit used" with "See plans" or "Change
  plan" links, never credits or top-ups. Notice kinds are unchanged.
- **H7 fixtures.** The 1.99.111 and 1.99.112 decoders are kept as two verbatim copies of the released
  `model-plan-status.ts` (`5f1d785f`, `ab5fa8ce`; they differ only in a comment) under `packages/core/test/fixture/`, and
  run over hand-built §4.11 answers and over the real status and config handlers' answers (config with sales open and
  closed).

## A19 decisions (part 2: Codium Auto per message, schema, generators)

- **Where Auto is resolved in the engine.** `createUserMessage` resolves Auto once, after the parts are resolved and
  before the `chat.message` hook, through a new `Provider.codiumAuto({tier, contextTokens})` (engine
  `provider/provider.ts`, beyond A19's list only by the method). The message stores the concrete `model` and
  `selected` = Auto; `setAgentModel` keeps the session on Auto, and `currentModel` prefers a message's `selected` in
  its fallback, so the next message picks again. The tier is the size of the request the message opens or joins
  (`SessionTaskSize.size` over the history plus the new message, as the run will size it), so a message that joins a
  running request never steps down within it; a session that is not sized (a subagent, a helper, a custom agent) uses
  the sender's explicit size, else `standard`.
- **The context Auto guards.** "Context from the history sent after the last compaction boundary" is read as: the
  newest finished request after the boundary as the provider measured it (input, cache read and write, output) plus an
  estimate of what came after it (its own tool results and later messages), never a summary's measured size (its input
  was the replaced history), with an estimate of the whole visible history as a floor for a provider that reports no
  usage; plus the new message's parts. The estimate is the shared 4-characters-per-token one.
- **Other places a user message gets a model** (beyond A19's list: `session/compaction.ts`, `tool/plan.ts`). `/compact`
  (`SessionCompaction.create`, which the summarize handler calls), a shell command and a subtask part on Auto resolve
  with the `standard` tier (a subtask's subagent starts its own history, so its context is empty); a command on Auto
  skips the early model check, since its message or subtask resolves it. A subtask part in a free conversation stays on
  the free model and never resolves Auto. A shell command is local: when Auto cannot pick a model, the command still
  runs and its message keeps Auto (no `selected`), for the next model turn to resolve or refuse with the notice below.
  Follow-up messages inside a request (a judge
  or research repair, a subtask command's summary, a compaction replay or continue, plan approval) keep the concrete
  model, so a request stays on one model and its cache, and copy `selected`.
- **When Auto cannot run.** Signed out, Codium off or Vector Local on give the notice a chosen Codium model gives. A
  catalog without a usable Auto (an older gateway, or a plan whose Auto roles are not all usable) fails the message with
  a Codium `unavailable` notice ("Codium Auto is not available on your plan right now. Choose a Vector Codium model to
  continue."); nothing is saved for the message, nothing is sent, and the session stays on Auto. Vector never falls back
  to a model the person did not choose.
- **Core V2.** `resolveRoute` takes `auto: "default"`; the V2 route passes it, so a V2 turn on Auto goes to Auto's
  default model at prepare. Without it (the engine's transport) Auto is still refused locally (`CODIUM_AUTO`).
- **Schema.** `Model.Codium` (`packages/schema/src/model.ts`) carries `lab` (a string, so a lab added later does not
  fail old decoders), `role`, `manualOnly`, `locked`, `preview` and `auto`; never `weight`, which stays hidden
  metadata in the client's catalog. It is optional on `ModelV2.Info` and on the engine's `Provider.Model`
  (`ModelPlans.listing`). V1 `UserMessage.selected` is `{providerID, modelID}`; `Session.Error.Codium` gains an
  optional `code`, filled from the route's metadata. The legacy SDK (`packages/sdk/js`) and `packages/client` were
  regenerated; nothing generated was edited by hand.
- **Codium's default model** (`Provider.defaultModelIDs`) is the entry with role `default`, else the first usable entry,
  never Auto, a locked or a manual-only one.
- **The `review` purpose** is sent for a session whose `internal` starts with `vectorscope.` (a Vectorscope review, its
  verify pass and the other review helpers), set in the run loop beside `title`, `brain` and `judge`.
- **Not done in A19, with the listing (A20).** Listing Auto, locked and manual-only entries in the engine provider and
  the V2 catalog, and the `vector models` line naming Codium Auto and locked models, wait for A20's routing and swarm
  guards. The CLI command cannot read the catalog service from its runtime, so the line will come from the listing.

## A20 decisions (app and desktop plan UI)

Intent-preserving corrections to the contract text, recorded with the A20 source. Details, tests and the open items
are in [codium-a20-plan-ui-notes.md](codium-a20-plan-ui-notes.md).

- **Files beyond A20's list**, each needed for a listed change (second step: `packages/core/src/model-plans.ts`, the
  engine control handler and route graph, `packages/engine/src/agent/agent.ts`, the desktop runtime, IPC and preload,
  and three root-route test layers that mock the two services the control handler now binds; third step:
  `packages/engine/src/session/compaction.ts`): `packages/core/src/model-plan-status.ts` (the shared,
  browser-safe `Listing`, `isAuto`, `isLocked`, `automatic`, `listingBadge`, `sessionModel`, `failureCode` and
  `failureParts`, the last read from the same table as the engine's suffix); `packages/engine/src/provider/provider.ts`,
  `packages/core/src/plugin/provider/vector-plan.ts` and `packages/engine/src/cli/cmd/models.ts` (the listing and the
  `vector models` line moved from A19); `packages/engine/src/session/prompt.ts` (the run-loop Auto resolution);
  `packages/app/src/context/local.tsx`, `packages/tui/src/context/local.tsx` and
  `packages/tui/src/component/prompt/index.tsx` (where a session's model is restored and cycled);
  `packages/app/src/pages/layout-new.tsx`, `packages/app/src/app.tsx` and `packages/desktop/src/preload/types.ts`
  (swarm flags, and providers re-read on `codiumChanged()`); `packages/app/src/context/notification.tsx` (the toast's
  code); `packages/app/src/vector-premium.css`, `codium-purchase.css`, `settings-account.css` (badge, detail and
  scheduled line); `packages/app/src/components/settings-vector-codium.tsx` (below); and, after the A20 commit,
  `packages/web/test/desktop-account.test.ts` (its two desktop account fixtures take the new `models` dependency).
- **Interim listing resolved.** The A19 "Interim listing" entry no longer applies: the engine provider and the Core V2
  catalog list every entry with its `codium` metadata, now that routing, swarms, pickers, restore and cycling tell them
  apart. `vector models` names Codium Auto and the locked models from that listing.
- **Swarms read "never a swarm target" as never added automatically.** A swarm never adds Codium Auto, a locked or a
  manual-only entry to its pool. The primary the person chose stays when it is unlocked, Auto included (the engine
  picks a model for each task's message) and manual-only included (they named it); a locked primary is refused, since
  every request to it would be.
- **Locked models are never restored, cycled to or picked by themselves.** Beyond the picker guard, the app's and the
  TUI's restore, default and recent cycling treat a locked Codium entry as unavailable, so a model that was recent
  before a downgrade is not selected silently. So do the engine's `Provider.defaultModel` (the CLI, agents, review and
  ACP defaults; an explicit `cfg.model` stays as configured) and its `getSmallModel` for a `small_model` naming one (no
  helper model, so a title runs on the conversation's own model, as before such entries were listed); the app's
  Vectorscope review catalog (`reviewCatalog`: a review never runs on one, whether it comes from the agent's recents or
  a review model in review.json, and neither does the model GitHub Actions reviews are set up with); and the model a
  new automation takes from the recents (Home). The TUI still lists such a recent or favorite entry, with its badge;
  choosing it asks to change plan, and a favorite stays removable. ACP clients list it too, named with the same badge
  ("… (Codium · Ultra)", "… (Preview · Ultra)") and its explanation as the option's description, since an ACP client
  has no Change plan of its own; choosing one there is the person's choice, and the gateway's answer names the step.
- **Restoring `selected` lives in the restore paths, not in `pages/session`.** The app restores in
  `context/local.tsx` (`session.restore`) and the TUI in `component/prompt/index.tsx`, both through
  `ModelPlanStatus.sessionModel`; no `pages/session` file changed. Automatic compaction keeps the choice those paths
  read: the run loop hands `SessionCompaction.create` the message's `selected` beside the model Auto picked for it, so
  the compaction marker and the continue message after it keep Codium Auto as the choice while the summary and the
  continuation run on that pick. `CodiumError` does render in Codium error rows, so
  the packages/app benchmark is still owed (it needs the app running, which this lane may not do here); it is open in
  the A20 notes.
- **The error card's finer answer comes from the stored message.** The timeline files are unchanged: `CodiumError`
  reads the engine's own suffix (`failureParts`) and, for a bare credit answer, whether the account has a plan (See
  plans without one, Change plan with one); the toast uses the gateway code (`failureCode`, `failureKind`): REQUIRED is
  See plans, EXHAUSTED and UPGRADE_REQUIRED Change plan, EXISTS Manage plan, a payment answer Update card or Confirm
  payment. Daily, run and Brain limits, contact, wait, update and unavailable answers offer no button. The card's plan
  read is one shared read a minute (`codiumSubscribed`) held in a signal, never a resource, so it cannot suspend the
  session page around it.
- **Confirm payment opens the portal home.** §4.4 names the invoice's `hosted_invoice_url`, which no endpoint returns
  yet; the portal home lists that invoice. A28/A60 may add the direct link. The portal home ends as closed, so closing
  it after Confirm payment starts the 5, 20 and 60 s reads too (`runBilling` with `paying`).
- **No change while a smaller plan is scheduled.** vectordev.ai refuses every `/change` but the scheduled one while a
  downgrade is scheduled, so the picker shows "Starts <date>" for that plan, no button for the others, and a line to
  keep the plan first.
- **Plan reads after a purchase are announced, not pulled.** `createCodiumBilling()` takes no refresh: it announces
  `codiumChanged()`, and each page showing the plan (Settings Account, Settings Usage, the plans dialog) and the app
  layout (providers) subscribes. After a finished purchase or card update `refreshAfterPurchase` announces again at 5,
  20 and 60 s at module level, so closing the dialog does not stop it and a second purchase restarts it instead of
  doubling it. Every billing request runs through `runBilling`, so a failed turn's card and toast get the same reads as
  Settings, and say in a toast how the request ended. These reads overlap (each may take up to 10 s), so every screen
  shows only its newest read's answer (`newestRead`): one started before Stripe's notification that answers last never
  puts the plan from before the purchase back.
- **The 5, 20 and 60 s model reads ride a credential write.** "Refreshes `/models`" needs the engine to read
  vectordev.ai rather than serve the catalog it keeps for 60 s. Before each announcement the app asks the desktop's
  `refreshModels`, which, in the account queue and with the token stored when it runs, writes that token to the app's
  sidecar again (`PUT /auth/vector`, no reload); `ControlHttpApi.authSet` for `vector` then forces a catalog read
  (`ModelPlans.credentialWritten`, waiting at most 2 s). A forced read never joins one already under way and plain
  reads wait on it. No HttpApi route or schema changed, so nothing was generated; sign-in and account switches get the
  same immediate read. A WSL server is not written: it holds the account only in its environment, so a write would
  either restart it (`replaceAccount`) or store the token on the WSL disk, and a read-only refresh route would be a new
  public HttpApi route. Its kept list (60 s) has lapsed by the 60 s read, which asks vectordev.ai again and, like
  every provider listing, waits up to 1.5 s for the answer before showing the kept one.
- **Codium Auto on direct-model paths.** `Agent.generate` resolves Auto with `codiumAuto` for standard work (Auto's
  notice when the plan offers none), and a `small_model` naming Auto gives Auto's helper choice (floor, then default,
  else no helper). `SessionDistill` already resolves Auto through `SessionPrompt.prompt`. `Agent.generate` also reads a
  Codium model through `streamObject`: the Codium transport always streams, so the whole-answer call would have sent a
  request, spending usage, that could not be parsed. A title agent whose own `model` is Codium Auto titles on that
  same helper choice whichever provider the conversation is on, and makes no title request when there is none (never
  one on the conversation's own model, since the person chose Codium for it). A compaction agent whose own `model` is
  Auto summarises on the model `codiumAuto` picks for standard work over the history it summarises, as `/compact` on a
  session on Auto does; when Auto cannot pick, the session gets Auto's notice and nothing is sent. The Codium branch of
  `getSmallModel` now reads the listing itself (`refreshCodium`, as `getModel` does), so a helper agent on Auto beside a
  conversation on another provider sees the current plan.
- **Copy pulled from A24.** The picker access label "Codium credits" becomes "Codium" ("Included in your Vector Codium
  plan"), and Settings → Usage (`settings-vector-codium.tsx`) loses its Purchased credits row and credits wording, so
  that A20's done criterion holds; the rest of that page stays A24's. The core `Offers` type drops `topups` and
  `formatPurchased` is removed; `Status.purchased` stays decoded for H7.
- **The desktop keeps only a desktop grant.** The sign-in exchange reads the `vct_` claims unverified (only
  vectordev.ai verifies) and stores nothing unless `client` is `"desktop"`. The A16 server hardening (checking the
  expected purpose before consuming a code) is not done here: `api/account/cli-exchange.ts` and
  `api/_lib/desktop-account.ts` are A16's and A20 does not otherwise touch them.
- **Keep my plan is `DELETE /change` sent as JSON** (`content-type: application/json`, body `{}`), as
  `requireTrustedJsonRequest` requires in production.

## P3 review decisions (A17 to A20)

Intent-preserving corrections from the P3 phase review. Details and validation are in
[codium-p3-repairs.md](codium-p3-repairs.md).

- **Answers after dispatch are marked and final.** Every error answer the gateway gives after it sent a request to the
  provider (the provider's 402, 429 or other refusal, a transport failure, the Max/Ultra retry's deadline; also the
  error frame of a stream that breaks off) carries `error.dispatched: true` beside its code, because the gateway
  commits every dispatched attempt at its full reservation (A17, "Unknown outcomes are charged"). Clients treat a
  marked HTTP answer as final whatever its code: kind `unavailable`, action `unavailable`, never resent by the
  engine's retry loop, the AI SDK or the V2 executor (both transports pass it on as a client error), and the turn says
  it counts toward the month's usage. This
  narrows §4.10 and A19 for `MODEL_PLAN_BUSY` and `MODEL_PLAN_CAPACITY` after dispatch: ADMIT's `MODEL_PLAN_BUSY` (a
  full global set) and the other refusals before dispatch (`RATE_LIMITED`, `MODEL_PLAN_RENEWING`,
  `MODEL_PLAN_CONCURRENCY`) are unmarked, cost nothing, and keep their retry. The provider's context refusal stays
  unmarked `MODEL_PLAN_CONTEXT`, so the client compacts the conversation instead of resending it as it was. The fixed
  reserve, the unknown-outcome charge and the gateway's own single Max/Ultra retry are unchanged.
- **A first snapshot still being written is RENEWING for an account with a record.** When `readEntitlement` finds no
  snapshot, cannot take the minute's reconcile and none appears within its 2-second wait, it answers 503
  `MODEL_PLAN_RENEWING` (retry-after 1) for an account with a Codium record (every checkout makes one), so chat,
  estimate, `holdPool` and every `requireEntitlement` caller answer as status already did, never a final 402
  `MODEL_PLAN_REQUIRED` moments after a purchase. Only an account without a record still gets undefined and the 402.
  `requireUsableSnapshot` keeps its final answers for snapshots that exist.
- **A lost admission answer is cancelled at once as well.** See the corrected A17 "Lost admission answer" entry: the
  immediate cancel frees the account's in-flight slot and the reservation without waiting 11 minutes, and the deferred
  cancel past the deadline remains for an EVAL still on its way.

## CFIX decisions (test clocks)

No contract text changes. Details and validation are in [codium-cfix-clock-notes.md](codium-cfix-clock-notes.md).

- **Fixture scenarios run on their fixtures' clocks.** The Stripe fixtures stay fixed epochs, each with its own
  `now`. They are neither moved nor rebased. Every step of a scenario that seeds one passes `fixture.now` or the
  shared `FakeClock` to the function's `now`. Where the code under test reads the wall clock itself (the webhook
  route and its signature check, `cancelModelPlanAccount`'s closing snapshot), the test pins bun:test's
  `setSystemTime` to the fixture's moment. No exported signature changes. A pin is used only where no lease is
  contended, because a frozen clock never reaches a lease or drain deadline. The M5 describe pins a wall clock past
  every fixture's period as a guard. This follows M11's test-clock intent, and every assertion is unchanged.
- **Reconcile's `now` reaches its purchase confirmation.** `reconcileModelPlanAccount` already passed its `now` to
  every other step and every other item it queues. It now also passes it, through the private
  `recordCheckoutConsent`, to `enqueueAction`'s existing `now` for `purchase-confirmation`, which before used
  `Date.now()`. Production callers pass a real time taken at the start of their run, so the confirmation is still due
  at once. Only its due time and `createdAt` can be earlier, by at most that caller's run so far.
- **A real-Valkey fixture scenario keeps Valkey's clock.** `codium-replay`'s Valkey case reaches GENESIS, whose
  ledger expiry follows the fixture's period (2026-12-10), not any caller's time. Nothing in that case reads the
  ledger, so its result does not depend on the date. It is left as it is, with a comment in the test.

## A21 decisions (label plan C1 contract)

Intent-preserving corrections to label plan §7 C1, recorded with the A21 source. Details and validation are in
[codium-a21-contract-notes.md](codium-a21-contract-notes.md).

- **Built on `codium`, not self-evolving.** Label plan §7 says to build C1 on the self-evolving branch; the build spec
  (higher precedence) puts A21 on `codium` and follows it with owner step 9, the merge into self-evolving. A21 follows
  the build spec and leaves that merge to the owner.
- **No code change in `combineCostKinds`.** C1.2 asks for "a codium case" in `packages/core/src/review/plan.ts`. Its
  existing rule already gives `"codium"` for Codium passes alone or beside free ones, so A21 pins exactly that with
  tests and adds no code. Codium mixed with a priced or plan pass still gives `"unknown"`, which `costWording` renders
  as "cost unknown … (tokens)"; label plan §2 and §3.4 forbid that for Codium work ("$0.40 + Codium"). A21 leaves the
  mixed result unasserted, and A26 (C11, owner of `review/format.ts`) must define the combined kind and its wording.
  Nothing produces `"codium"` before A23, so no review reads differently today.
- **`BudgetStopError` has two copies.** The contract names only the runtime `NamedError` in
  `packages/core/src/v1/session.ts:77-84`. The wire schema in `packages/schema/src/v1/session.ts:76`, which the assistant
  error union decodes, is the second copy; `codiumSteps` is added to both, or decoding a stored stop would drop it.
- **`knowledge.ts` takes the shared type.** `DistillRun.costKind` (`packages/core/src/brain/knowledge.ts`) uses
  `CostKind` from `review/types` instead of a hand-extended literal union, so the two cannot drift apart again. The
  intent, letting the distill result carry `"codium"`, is unchanged.
- **Only the remaining literals are replaced.** A20 already moved `provider-brand.ts`'s later Codium checks (the
  contract's `:367`, now `:272`, `:281`, `:387-391`) and other app code to `ModelPlanStatus.PROVIDER_ID`, which is now
  `Billing.CODIUM_PROVIDER_ID`; they stay as they are. The research `vector-plan:` answer prefix, the typed
  `vector-plan/<model>` hints and the frozen H7 fixtures are not provider-id checks and also stay.
- **Field styles follow their neighbours.** New counts are `Schema.Finite` where the struct's other counts are
  (`Session.Info`, `Task.Usage`, `Task.BudgetScope`) and `NonNegativeInt` elsewhere. New V1 part and message fields use
  the package `optional()` helper (schema/AGENTS.md) rather than the raw `Schema.optional` those structs use elsewhere;
  `BudgetStopError` keeps `Schema.optional` like its other fields.
- **`Billing` module shape.** `billing.ts` uses the `.js` self-export of `codium-plan.ts`, so `api/` can import it in
  C12, and is exported from the root barrel as the contract asks; consumers import the direct entrypoint
  `@vectordevai/schema/billing`, as they do `provider-policy` and `codium-plan`. `Billing.Kind` carries the stable
  identifier `Billing.Kind` (generated as `BillingKind`).
- **Engine-owned fields are tested by type and generation.** The engine `Info` counts and the usage summary fields
  cannot be decoded from `packages/schema` tests (dependency direction); they are covered by the engine typecheck and the
  generated SDK diff, and their values by A23's `usage.test.ts`.
- **Accounting reads the stored flag, never `Billing.of`.** Label plan §4.1 and §4.2 route the projector by the flag
  of the record it counts (`usage()` and `messageUsage()` read it), while the display surfaces use `Billing.of`, which
  falls back to the provider id. With no backfill (§4.2), that fallback must stay out of accounting: a Codium step
  recorded before A22 was added as an ordinary step, and reading it as Codium on revert or removal would leave
  `codium_steps` at −1, the step's tokens in the totals, and the session failing its `NonNegativeInt` encoding. A
  record without the flag counts as ordinary on both sides. The provider-id check the contract asks for on
  AncillaryUsage stays, since nothing subtracts ancillary usage. One gap in C2 and C3 is added to A22: fork
  (`packages/engine/src/session/session.ts:919-970`) clears a copied step's cost, tokens and `unpriced`, and must
  clear its `billing` too, or each copied Codium step counts as a Codium step of the fork. Details are in the A21
  record's A22 obligation.

## A22 decisions (label plan C2 and C3, stamping and accounting)

Intent-preserving corrections to label plan §7 C2 and C3, recorded with the A22 source. Details and validation are in
[codium-a22-accounting-notes.md](codium-a22-accounting-notes.md).

- **The `costKindOf({ codium })` callers move to A23.** C2 lists `packages/engine/src/session/processor.ts:195-211` and
  the V2 cost kind in `runner/model.ts` `spendStep`, but `costKindOf` takes `codium` only in C4 (A23). Passing it
  earlier would either not typecheck or pull C4's guard behaviour forward (D-3: no dollar cap and no 40-step stop for
  Codium) without A23's spend-guard tests. A22 stamps and accounts only; A23 changes `costKindOf` and both callers
  together, so the guard behaviour for Codium does not change in A22.
- **A Codium record's contribution is fixed.** The projector counts any record carrying the flag as cost 0, one
  unpriced step, one Codium step and no tokens, whatever its stored cost, tokens and `unpriced` say (§4.2). The stamps
  write cost 0 and `unpriced: true` even for a zero-token step (§4.1, "cost 0, unpriced true"), unlike the "a step that
  used no tokens owes nothing" rule for other models, so `codium_steps ≤ unpriced_steps` holds and
  `unpricedSteps − codiumSteps` never goes negative.
- **Records are routed by their own stored flag on both sides.** As the A21 decision says, `Billing.of` stays out of
  accounting: the delta is `sign·contribution(new) − contribution(previous)`, each read from its own record, so a
  replaced, reverted, removed or moved step takes back exactly what it added, and a flagless record (written before
  A22) counts as ordinary on both sides. Only ancillary usage also routes on its model's provider id, as §4.2 asks;
  nothing subtracts it.
- **A second V1 writer is stamped.** Besides the contract's `processor.ts:668-686`, the processor's `settleStarted`
  step-finish (a step stopped or failed mid-stream) also carries the flag, or an aborted Codium step would count as an
  ordinary unpriced step with tokens. The V1 message flag is set only at the `Session.updateMessage` choke point (§4.1),
  on the published copy, not again in the processor.
- **V2 defensive pricing.** The runner's Step.Ended and the V2 compaction events force cost 0 and `unpriced` for
  Codium, matching V1 `getUsage`, because V2 `calculateCost` prices any model from Copilot `totalNanoAiu` metadata; a
  metadata-priced path can then never leak a dollar figure. The guard's `spendStep` stays untouched until A23.
- **Fork clears copied `billing`** (from the A21 record). Copied step-finish parts clear `billing` with cost, tokens and
  `unpriced`; the cloned message keeps its flag for display.
- **The task notification's "Codium-only" rule.** §3.3 leaves it open. A child counts as Codium-only when
  `codiumSteps > 0` and its own token total is 0; a child with Codium steps and own tokens is mixed. The "Pricing is
  unknown" sentence counts only own unpriced steps (`unpricedSteps − codiumSteps`) and appears only when that is above 0.
- **V1 projector cases live in the engine's `session.test.ts`.** The moved part, `PartRemoved`, `MessageRemoved`,
  flagless-removal, stale-update and fork cases run through the engine `Session` service, which publishes the V1
  events the core projector applies; `session-projector.test.ts` holds the V2 cases, including the flagless V2
  revert.
- **The migration's existing-database check is CI evidence.** Fresh databases are built from `schema.gen.ts` and only
  record migration ids, so no local projector or core test runs the new `ALTER TABLE` file. Its test in
  `database-migration.test.ts` runs in CI (the file starts a nested Bun process); locally, the generator's `--check`
  and a single-process scratch script under `/tmp/vector-codium-A22/` (recorded in the notes) are the only evidence.
- **The public-share regression (label plan §8) is folded into A22**, because A22 changes `archive.ts`'s info
  mapping: `public-session-share.test.ts` asserts that no `billing`, `codiumSteps`, `subagentCodiumSteps`, `unpriced`,
  `cost` or `tokens` key reaches the public archive.
- **Anchor drift since the label plan** (lines after this change): engine `session.ts` `updateMessage` `:864-872`
  (contract `:843-847`), `getUsage` from `:468` with the Codium return at `:513`, `fork` from `:932`; `processor.ts`
  step-finish case `:653`, its writers `:672-682` and `:824-834`; `projector.ts` strip list `:348-370`, Step.Ended
  `:532`, ancillary `:562`, compaction `:597` and `:615`; `message-updater.ts` `:213` and `:392`; `llm.ts` Step.Ended
  `:412`; `compaction.ts` `spent` `:248`.

## A23: guard and usage decisions

- Codium guard counts are separate from unknown steps; local dollar caps ignore Codium while step/loop limits continue. Desktop known-Codium admission returns no dollar budget and places no reservation. `usd: 0` would violate the existing strictly-positive budget schema and trigger preflight headroom refusals, so it is not sent.
- Recurring automation exemptions use the current existing session's model, with unavailable identity falling back to ordinary dollar checks. A fresh parallel session uses its pinned provider. Concurrent owner model changes between the desktop read and engine admission remain the existing mutable-session limitation.
- The integration into self-evolving must preserve Codium counts in its additional delegated-scope decoder and task-limit restart seed; see `codium-a23-guard-usage-notes.md`. Current Codium lacks these newer paths.
- A23 leaves the model route acceptance registry empty and all live provider and release gates in place. Its implementation and final validation are recorded in `codium-a23-guard-usage-notes.md`.

## A24: app display decisions

- Older summary payloads do not identify the most-used Codium model; show generic `Vector Codium` rather than guess. Known legacy session/child totals hide inseparable tokens and keep own dollars. Day/helper attribution is not invented, and no backfill or eager discovery of private children is added.
- The opt-in 80% alert observes successful reads while Usage is open; account/plan/renewal dedupe lasts for the app lifetime. The specified page-open refresh lifecycle and no-closed-page-polling rule remain intact.
- A small C5 follow-up corrects average own tokens per chat to divide by chats with own tokens, excluding Codium-only chats from that denominator.
- Optional per-pass `ReviewPass.costKind` is populated from actual catalog identity so mixed Codium/own review passes preserve own prices without inventing subscription charges. A26 must preserve the field in durable review state where passes are stored.
- See [A24 notes](codium-a24-app-usage-notes.md) for reviewed leak fixes, tests, interrupted-check disclosure and remaining benchmark/CI gates.

## A25: output boundaries and historical aggregate provenance

- Desktop mixed runs need independent `billing: codium` and own `costKind`; optional `Task.Info.billing` carries that distinction without fabricating `Task.Usage`. Known positive own guard subtotals survive unknown work and missing/reverted session totals.
- Distill estimate/result numeric fields become optional in the public contracts so Codium omits them. Legacy History is projected safely on read as well as new writes; stored receipts are unchanged.
- CLI task JSON is included in C10 because the package's no-printed-Codium-token acceptance applies to legacy task results even though the file list only names its human formatter.
- Automated completion notes and run JSON task/batch metadata also carry usage outside the primary readers. Notes require freshly observed row proof; editable lifecycle metadata never authorizes printed aggregate tokens, even when it serializes a true proof bit. Nested task metadata loses only its inseparable token figures and proof, retaining dollar subtotals and unrelated data. The shared WP31 `TaskNotify.render` must receive the same guard at integration.
- A25 adds default-unknown own/delegated token provenance because modern counters cannot certify historical totals. Only trusted empty native creation can promote it; unproven contributions, forks/imports/replay invalidate it and ancestor delegated proof. Aggregate output requires true proof even with no surviving Codium identity. Raw-message output requires canonical positive own identity; editable lifecycle metadata cannot grant proof. Raw accounting/history and financial admission stay unchanged. Canonical UI event snapshots are separate from replay-exact sync payloads. Existing own-only histories may show unavailable aggregate tokens rather than infer purity from missing history. Exact-head CI and the final production benchmark remain package closure gates; [A25 notes](codium-a25-output-notes.md) record the contract, tests and WP28/WP31 merge obligations.

## A26: review accounting and cached output

- Codium activity is independent of a mixed review's own cost kind; compact state key `k` counts those reviews while `c` continues to store dollars. Pure Codium never adds its internal figures to review state.
- Fresh reducers honor explicit Codium step parts before parent-message provider identity. Positive own receipts without token counters retain their charges and mark token usage unavailable. Optional per-pass `usageMissing` preserves that distinction through CLI/App/JSON output without changing public Protocol or Server schemas.
- Serialized review caches cannot grant fresh token attribution. Cached outcomes with any Codium evidence clear both aggregate and per-pass token availability, including old own-looking passes classified by their latest model. Own dollar subtotals remain; original stored cache bytes are unchanged by read projection. Pure pass-only legacy evidence remains Codium rather than becoming an unknown dollar subtotal.
- The required App guard permits the documented duration after a separate footer separator; it rejects numeric usage attached to Codium and a zero dollar price beside it. [A26 notes](codium-a26-review-notes.md) record reviewed cases and validation.

## A27 public presentation

The public config now advertises only accepted gateway models and qualified effective tier variants. It carries explicit per-plan membership/context windows so a minimum-tier label cannot imply an unaccepted larger context. `ROUTE_ACCEPTANCES` remains empty. Taglines and model copy use a safe fallback when the specified planned models or perks are unavailable.

Service readiness is separate from `CODIUM_LISTED_PERKS`: future service WPs must register real configured checks after their gates, while the current production readiness table permits only implemented priority. The status cache also matches the current listing before serving cached caps/meters. Prerenders contain no runtime perk or founder availability; the island reads the current public config and removes stale claims on failure.

The owner's approved planned 550B+ Velocity wording is the narrow override to H2's parameter-count ban. It stays Coming, without a date or inclusion in today's purchase. The explicit no-Labs scope takes precedence over the older plan's Labs Coming row. Existing schema compatibility fields remain; no new Labs UI or service is added. Review panels stay free functionality with model-tier access, including Plus and Pro when the Codium panel is listed; only Max and Ultra show the trust-ramp note.

## A28 account billing presentation

Paused payment recovery retains A20's distinction: payment failures use the payment-method update portal flow, while action-required invoices use the ordinary portal for confirmation. This refines A28's generic “Update payment method” wording so changing a card is not presented as invoice confirmation. No new billing operation is introduced.

The shared browser action module validates explicit request/response shapes and the pricing island reads signed-in status after mounting to show paused recovery without another purchase button. Unknown or explicitly disabled status does not permit checkout. Legacy optional status fields remain readable, while malformed future financial controls block plan changes. See [A28 notes](codium-a28-account-notes.md) for the state, display and verification boundaries.

## A29 docs and the no-top-ups guard (2 Nov 2026)

- **The done grep has a wider allowlist than the contract's four kinds.** `git grep -i 'topup\|top-up\|purchased'` cannot find only OpenRouter's auto top-up, `free-model-choice.ts`, release notes and "no top-ups" phrases while other invariants stand: H7 requires `purchased: {bought: false}` in status and the frozen 1.99.111/1.99.112 decoders, A04 keeps the 410 route `/api/model-plans/topup` and the lenient decoding of old records and ledger lines, §2 has setup archive the legacy top-up prices, §4.1 keeps the deprecated empty `TOPUPS` until its last reader goes, H8 keeps the legal pages unchanged until A60 (A30 drafts them on `codium-legal`), and tests assert the removal. `test/no-topups.test.ts` runs the exact search and holds each match to a named reason: whole files (each must still match, so the list cannot go stale), phrases stripped before the line is re-checked, and five exact lines. The search also matches `desktopUpdater` and `desktop-update`, which it skips. The 1.99.108 release notes keep their shipped words, including the copy `docs-content.ts` repeats in its changelog.
- **Files outside A29's list.** `vercel.json` gains the `/docs/plans` and `/docs/pricing` redirects §7.3 asks for (not permanent, since they are aliases). `docs/first-launch.astro` and the account page's deletion warning (`AccountPage.tsx`, with its test) still spoke of credits from a plan or a top-up and of purchased credits, which the done grep covers. Two docs tests (`docs-settings.test.ts`, `external-agents-rules.test.ts`) pinned the removed credits wording; their expectations now pin the new wording and also refuse credits.
- **`/docs/codium` is prerendered, so its listing is read at runtime.** The prerender lists no perk, as A27's /codium does; a page script reads `/api/model-plans/config` and fills the plan features, the computed taglines and `#hosted`, and an unreadable or malformed answer lists nothing. `#hosted` covers the five services that run on computers Vector hosts (cloud computer, Done by Morning, On Call, Release Guard, Ship Desk); Remote, Vault and alerts appear under their plans. `#coming` renders `CodiumCopy.COMING`, today Velocity only, so it follows the open owner decision on a Labs row without an edit here. `#models` lists no model: no route is accepted and the Oct 30 lineup is an open owner decision, so it links to /codium, which renders the served catalog.
- **Not written here.** §7.3's owner docs `remote.md`, `brain-vault.md`, `hosted-computer.md`, `hosted-ops.md` and the `github-app.md` Deployments section document services whose work packages have not run; A29's file list does not include them. `vectorscope.astro`'s GitHub sections and `owner-actions/vector-mention.md` are Codex's and unchanged. `packages/web/src/lib/model-plans.ts` still exports `modelTopupPurchasable`, used only by its own test; it is allowlisted with the file's legacy decoders and left for a later cleanup.

## A30 legal drafts (2 Nov 2026)

- **Branch `codium-legal`, not `codium/legal`.** Git cannot hold `codium/legal` beside `codium`. The Codium CI lane listed only `codium/**`, so `.github/workflows/vector-codium.yml` also triggers on `codium-legal`; the compliance test checks the list with `arrayContaining` and still passes. The branch starts from A30's guard commit on `codium` (`986a8096`) and A30's notes come in a second commit on `codium`, so A60's merge of `codium-legal` adds only the drafts.
- **H8 is a hash per effective date, plus two date rules.** `test/codium-legal.test.ts` pins each page's sha256 by its `updated` date, requires `CODIUM_TERMS_DATE` to equal the terms page's date (the billing record names the terms a subscriber accepted) and both pages to share one date ("bumps both dates"). On `codium-legal` the drafts carry a placeholder date, November 2, 2026, and `CODIUM_TERMS_DATE` is `2026-11-02`, so H8 holds there; A60 moves both to the release date and re-pins.
- **"Where available" blocks are marked in the markup.** Contract §7.2 publishes each such paragraph when its service first lists, but a prerendered legal page cannot follow the runtime listing without changing legal text outside a release commit. The drafts carry every block, each marked `data-where-available="<perk ids>"` and opening with "(where available)", and A60 keeps only those whose perks are listed at launch. The report-tracking and roadmap-vote paragraphs are not marked, because §1.2 lists reports and votes when sales open; A60 drops them if A33 or A34 has not shipped.
- **Wording the contract fixes differently.** The Coming clause covers "every item tagged Coming" without naming Vector Labs, whose pricing row is a pending owner decision. The `@vector` handle is not used; the drafts say "Vector's GitHub agent", since the handle follows the GitHub App slug (§4.18 amendment 4). Session artifacts are described as Actions artifacts that people with access to the repository's Actions can download, not as "private Actions artifacts", which is not true of a public repository. Runs can be started by write, maintain or admin access (Codex amendment 8), not "write access" alone.
- **`codium-legal` is not pushed.** The pre-push hook runs `bun turbo typecheck`; this run may neither run turbo on the owner's Mac nor skip the hook. The push is left for the orchestrator or the owner (`git push origin codium-legal` from `~/.cache/vector-codium-legal`).

## A31 founding members (2 Nov 2026)

- **A slot is keyed by a founding token, not the Stripe session id.** The subscription must carry the mark from the moment Checkout creates it, so the token goes into `subscription_data[metadata]` before the session exists; it is derived from the checkout's idempotency key, so a retried request reuses it. Slots live in one sorted set, `founding:reserved`, scored by expiry, instead of one `founding:reserved:<session>` key each, so one script can count live slots atomically. The token goes on the checkout only after its slot is held, so every paid token can get a number and assignment never re-checks the window. `checkout.session.expired` reads the session again and releases its token; a replaced checkout releases its own before the next is held; a slot also lapses two days after its checkout closed.
- **More store keys than §4.6 names.** `founding:member:<account>` is a hash (number, token, subscription, at, listed, ended). The founders page adds `founding:listed`, `founding:names` and `founding:slug`.
- **Legacy prices are keyed by the plan's price** (`STRIPE_MODEL_PLAN_LEGACY_PRICES_10`, `_50`, `_100`, `_200`), like every other Stripe setting, and are accepted for any subscription already on them, at exactly their amount. A malformed list turns Codium off, as other invalid settings do.
- **Founding is offered only while `founding` is listed** (`CODIUM_LISTED_PERKS`, its switch and its window), so nobody buys a perk the page did not show. The `founding` provisioner is configured while the owner lists it; keep it listed after the window closes, since the window's runtime check already takes it off every page. Invalid founding settings close the window and appear in the config problems.
- **"Ends on `customer.subscription.deleted`" is read from Stripe's state:** reconcile ends a membership when the subscription carrying it is cancelled and no other live subscription carries its token (an open upgrade still does). An ended record is kept, so an account that leaves and comes back during the window gets no second number.
- **The founders page** is `/founders`, with the random slug in the address's fragment (made in the store at first use, sent as a header). "Public after 30 opt-ins" counts founders currently listed. The badge is an SVG from `GET /api/founders?badge=<n>`, behind the same slug while private. The opt-in lives on the website account page; Settings shows the number and the lock and points there.
- **Status sends `founding: {number}` in every shown plan state**, frozen included; §4.4 hides frozen founders from the founders page only. The boost is never sent.
- **Files outside A31's list:** `codium-snapshot.ts` (the founding fact), `model-plan-status.ts`, `codium-perks.ts` (readiness), `webhook.ts` (slot release), `codium-ledger.ts` (legacy price), two new routes, the website account block, decoder and `/founders` page, the prune keep list, `.env.example`, docs, the store fake's script copies, and `packages/web/test/codium-public.test.ts`, whose "only priority is ready" case now closes the founding window first, because A31 gives founding a real readiness check (and the case asserts founding is listed while open). Account deletion erases founding records now, in `cancelModelPlanAccount`; A57 owns the rest of P5.

## A32 usage forecast and history (2 Nov 2026)

- **History lists every date of the period so far, from its first, including dates with nothing spent.** §4.11's
  `history: {day, used}[]` with whole-percent fractions cannot tell "nothing" from "a little" on one date, and the strip
  needs to know where the period starts. So status sends each UTC date from the period's first through today
  (`used: 0` included), and the strip and CLI read any share that rounds to 0 as "<1%", which is true either way. The
  first entry is the period's first date, which the strip uses to mark earlier dates and the renewal card to count from;
  no new status field was added.
- **History also counts pool debits**, by the UTC date each was recorded (hosted blocks and other non-model charges),
  because the month's share already includes them. Model spend comes from the `day:` buckets as the contract says.
- **A history that cannot be read is left out, not an error.** Status still answers, and the forecast then uses the
  period average.
- **"Straight-line forecast over the last 7 days"** is read as the pace of a straight line from the window's start to
  now, where the window is the last 7 UTC dates including today and never starts before the period. "Fewer than 3
  points" counts dates in that window with settled spend. The share left comes from the month's figure, as before.
- **The renewal card** covers the period the coming renewal closes ("Before your plan renews", or "ends"): this
  computer's Codium responses and days with Codium work since the period's first date, from the local usage summary.
  The app does not know the previous period's start, so it does not recap the last one. Local dates are compared with
  the period's first UTC date, so the first day can be off by the hours between UTC and local time.

## A33 report tracker (2 Nov 2026)

- **What a record holds.** The contract says "metadata only". A record holds when the report arrived, its status (and,
  for a fix, the release and commit) and the plan tag. The app version and channel are left out so the record matches
  the A30 privacy draft (`#report-tracking`). The account link is not in the record: it is a set,
  `reports:acct:<sha256 of the account id>`, kept as long as the reports and used only for deletion.
- **Ids** are `r_` and 26 letters of lower-case RFC 4648 base32 (`a-z2-7`).
- **The optional account token.** With an `Authorization` header, it must be a valid, unrevoked `vct_` account token,
  else 401, as other account routes answer run tokens (S3). The desktop sends the report again without the token after
  a 401, so a report is never lost to an expired token. The tag and limit come from the stored snapshot alone (no
  on-demand reconcile, so no Stripe call), and only while it is active or renewing (§4.4's "Report tag" row).
- **Limits.** Without a sign-in: 5 an hour per address, unchanged. Signed in: per account, 5 without an active plan,
  else the plan's `reports.perHour`. Signed-in requests also count against 60 an hour per address, above every plan's
  limit, so many free accounts behind one address cannot flood the inbox. The reply-address limit (3 a day) still
  applies to everyone.
- **Read first** is the subject tag from the snapshot's caps, not gated by the perk listing (listing is display only,
  as `codium-perks.ts` says). `reports-first` had no readiness check, so it could never be listed. It now has one: the
  report email is configured. This is an edit to `api/_lib/codium-perks.ts`, outside A33's file list.
- **Statuses and the status route.** The statuses are `received`, `read`, `fixing`, `fixed` and `closed`; `fixed` needs
  the release. The route is `POST /api/support/reports {ids}`: ids go in the body, never the address. It needs no
  sign-in, because the id is the credential and the tracker is free. It takes at most 100 ids, 60 requests an hour per
  address, and leaves out ids without a record.
- **Mode prefix.** Records use `codiumKey()` (§4.6). Production without a live Stripe key runs in test mode, so reports
  sent before the owner configures the live key sit under the `test` prefix, and a live server no longer reads them.
  The server stays strict. The owner's script looks in both prefixes unless `--mode` is given.
- **A new Vector Local source.** Reading statuses is a new automatic connection, so it is registered first, as the
  registry requires: `report-status` (purpose `support`, blocked under Vector Local and allowable). It is added to
  `packages/core/src/local-mode/sources.ts` and the app's label list. The send itself keeps its existing main-process
  fetch.
- **Files outside A33's list:**
  - API: `api/_lib/support-reports.ts` (new).
  - Shared: `codium-perks.ts`, the Vector Local source and its label.
  - App: `context/highlights-model.ts` (the changelog parsing moved out of `highlights.tsx`, unchanged, so it can be
    tested), `support-reports.ts` (types and words), `context/platform.tsx`, `dialog-report-bug.tsx` (one line pointing
    to Settings when tracked), `settings-account.css`.
  - Desktop: `renderer/index.tsx`, preload types.
  - Tests: the root test fixture and a desktop test.

## A34 roadmap vote (2 Nov 2026)

- **A fourth key.** §4.6 names `roadmap:<yyyy-qn>:{ballot,ballots,nominations}`. Ballots and nominations are kept until
  the account is deleted (the A30 privacy draft, `#roadmap-votes`), so no expiry bounds which quarters hold an
  account's data. `roadmap:quarters` (a set) lists every quarter that holds any, so deletion can find them all. A
  nomination adds its quarter too, because Ultra can nominate in a quarter without a ballot.
- **Voters are hashed.** The `ballots` and `nominations` hashes are keyed by a SHA-256 of the account id under a fixed
  label, never by the id itself. Each value keeps the plan the account had when it voted or nominated, as the privacy
  draft says. The draft's "with your account identifier" is true of a derived identifier; the legal read may want the
  wording to say so.
- **"SET NX per quarter"** is HSETNX on the quarter's `nominations` hash, one field per account. It gives the same atomic
  one-per-quarter guarantee and keeps §4.6's key names.
- **Counting.** Results are counted when read, with HVALS on the closed quarter's hash, so the fields (voters) never
  leave the store. A ballot counts when it was cast before the close, for a candidate on the ballot, with a plan whose
  `ENTITLEMENTS[plan].vote` is true (the plan kept with it). That plan is the one it was cast with, so a later downgrade
  does not drop it. A deleted account's ballot drops out of a closed vote's totals too. A quarter with many thousands of
  ballots would make each view read them all. If that becomes slow, cache the totals once the vote closes.
- **Ties.** The contract does not say how ties are broken. A tie shows the totals and no winner until the owner records
  one of the tied candidates with `script/roadmap-ballot.ts decide`, which works only after the close and with at least
  20 ballots counted.
- **Quarters and nominations.** A ballot belongs to one UTC calendar quarter and must open and close inside it, so at
  most one ballot is ever open. Nominations made in a quarter are for the next ballot. The owner reads them with the
  script and decides which go on it; none is added on its own. Settings says a nomination "goes to the team for the next
  ballot".
- **Undated copy is enforced.** `openBallot` refuses candidate copy that names a year, a month, a quarter, "soon" or
  "next/this … release/month", so no ballot can show a date for a feature.
- **Callers.** The route takes only a Vector account token (`vct_`, from the desktop or the CLI), because the vote lives
  in the desktop's Settings. It takes no website session and no run token (S3). GET answers any signed-in account,
  because results are only totals and the account's own choice. POST votes and nominates only from the snapshot (S1):
  402/403/503 as `requireEntitlement` answers. Like A33's report tag, voting is not gated on the perk listing, which
  `codium-perks.ts` keeps for display. The owner controls voting by publishing and closing ballots. The tab itself shows
  only when the status's `entitlements.vote` is set, so only when `vote` is listed (H1).
- **Listing.** `vote` had no readiness check, so it could never be listed. It now has one: the store is configured, its
  only service. `packages/web/test/codium-public.test.ts` now expects `vote` among the listed perks when every perk is
  listed with default services. The rest of that case leaves `vote` out of the list, so it still measures priority's
  readiness alone.
- **The tab.** It is "Roadmap vote" in the Personal group, right after Account. It is not v3's "Settings → Labs", because
  Labs is never built and its pricing row is a pending owner decision. Settings reads the Codium status when it opens
  while signed in, and again after a sign-in change or `codiumChanged()`, to decide whether to show the tab. That is one
  more status read per Settings opening on the desktop. The free-workspace sentence on the results ("If the winning
  feature adds to the free workspace, that part ships free for everyone.") comes from v3 item X.
- **No new Vector Local source.** The desktop reads and sends the roadmap from `main/vector-account.ts` with the
  account's sign-in, the same file and connection as the Codium status read (the registered `vector-account` source).
  It runs only when the person opens the tab or acts in it.
- **Files outside A34's list:**
  - API: `api/_lib/roadmap.ts` (new), and `api/_lib/codium-perks.ts` (readiness).
  - Desktop: `main/vector-account.ts`, `main/ipc.ts` and the preload, because the account token stays in the main
    process.
  - App: `vector-account.ts` (types), `roadmap-model.ts` and its test, and `settings-roadmap.css`.
  - Tests: `settings-registry.test.ts` (16 pages, roadmap after account), the desktop `vector-account.test.ts`,
    `test/roadmap-fixture.ts` and the `codium-public` expectation above.
  - Docs: `docs/vector/MODEL-PLANS.md`.
- **Deletion is wired in A57.** `eraseAccountBallots(account)` is ready and tested. A57's erase step calls it, as it does
  A33's `eraseAccountReports`.

## A35 Second opinion and second-lab reviews (2 Nov 2026)

- **How the setting reaches the judge.** `general.secondOpinion` is an app setting, but the judge runs in the engine. Each
  prompt (and command) carries `secondOpinion: true` while LLM-as-a-judge and the setting are on, stored on the user
  message (`UserMessage.secondOpinion`, `PromptInput`, `CommandInput`; SDK and client regenerated). The judge gate reads
  the newest message the person wrote in the judged work, so turning it off takes effect with the next message. The
  gate hands the judge's model to the task tool as `ctx.extra.judgeModel` (the name B05 moves later); the task tool takes
  it only for the gate's own judge launch (`invokedAgents` holds `judge`), never for a judge a model launches, and runs
  it at the catalog entry's own effort rather than the worker's variant.
- **Where the judges and pairs come from.** The catalog's `judges` and `review` were decoded by A19 but not exposed to
  the engine's model list or the app. `ModelV2.Codium` gains `judge` (the entry's Second opinion judge) and `review`
  (its parts in the plan's review pair), filled by `ModelPlans.listing(model, catalog)` and only naming listed
  entries. Two existing expectations that pin the exact listing (`packages/engine/test/provider/model-plans.test.ts`,
  `packages/core/test/model-plan-catalog.test.ts`) now include `review: ["triage"]`, which the shared catalog fixture
  carries. The core plugin test helper (`packages/core/test/plugin/host.ts`) copies the new list like its other lists.
- **Labs.** "Lab from the model's vendor" is `packages/core/src/model-lab.ts`: the Codium catalog's stated `lab` wins,
  then a vendor path segment ("openrouter/anthropic/…"), then the model family in the name ("claude", "gpt", "gemini",
  …), then a first-party provider id. Routers, clouds and local servers name no lab by themselves. Unknown means no
  second-lab claim: Second opinion does not switch the judge, and the footer has no line.
- **Review pairs.** Read as: on Codium without a `triageModel`, the first pass runs on the pair's triage model and the
  check on the review model, which is the pair's confirm model when the settings named Codium Auto or the triage model
  itself, and the named model otherwise. "Same-lab pair warns and runs a single pass" applies to the pair Vector picks
  (for example DeepSeek Long checked against DeepSeek); a `triageModel` the user set keeps its documented behaviour
  (a cheaper first pass double-checked on the review model), and only loses the second-lab line when both models share a
  lab. A pair the catalog cannot complete (Pro before Sol is accepted) runs one pass without a note.
- **The panel.** `panel` and `judgeModel` in review.json. The judge runs only after the check finished, sees each
  candidate with the check's verdict inside the untrusted tag (`buildJudgePrompt`), answers in the verify schema, and
  its verdict stands where it gave one; the check's stands for the rest and for earlier fixed claims. A panel the
  models cannot form (no first pass, a judge from a lab already on it, or an unnamed lab) runs without the judge and
  says why. The runner resolves `judgeModel` itself when the caller passes none, so GitHub reviews get the panel
  without a change to Codex's `github.review.ts`.
- **Footer data path.** `ReviewCost` gains `labs?: 2 | 3`, set by the runners (engine and desktop). The summary footer,
  the CLI footer and the desktop footer read it. It travels in `cost` because that is the field Codex's
  `github.review.ts` already passes to `buildSummaryBody`, so the GitHub summary shows the line with no edit to Codex's
  files. Codium JSON output still reduces `cost` to its kind and model.
- **Token stops.** The contract's "within the review token stops" names stops no code has: the per-review and per-PR
  token stops of v2 item B were never built, and no work package owns them. The panel and the check add no budget: the
  judge has the check's 10-step cap, is skipped with under 2 minutes left or past the dollar cap for priced models, and
  every Codium request still passes the gateway's pool, daily limit and caps. Building the token stop is left to whoever
  builds Codium GitHub reviews.
- **Listing.** "Second opinion listable" needed a readiness check: `second-opinion` is ready once every plan that
  includes it can reach at least one judge among the served models; `review-panel` gets one too (every plan's triage,
  confirm and panel judge served, from three labs). Both read the served catalog through two new exported functions in
  `api/_lib/model-plan-models.ts`. With no route accepted today, neither is ready until A60.
- **Settings.** The toggle sits under LLM-as-a-judge and shows only when the status's `entitlements.secondOpinion` is
  set (listed, H1). A setting turned on earlier stays on if the perk is later unlisted, and keeps working while the
  server still serves the plan's judges; the gateway still decides each judge request from the plan (S1).
- **Files outside A35's list:** `packages/core/src/model-lab.ts`, `review/second-lab.ts`, `review/prompt.ts` (judge
  prompt), `review/types.ts`, `model-plans.ts`, `model-plan-status.ts`, `plugin/provider/vector-plan.ts`;
  `packages/schema/src/model.ts`, `v1/session.ts`; `packages/engine/src/provider/provider.ts`, `cli/cmd/review.ts`,
  `cli/cmd/review.render.ts`; `packages/app/src/components/prompt-input.tsx`, `settings-v2/second-opinion-model.ts`;
  `api/_lib/codium-perks.ts`, `api/_lib/model-plan-models.ts`; the regenerated SDK and client; docs
  (`docs/vectorscope.astro`, `docs/vector/MODEL-PLANS.md`); and the test edits above plus
  `packages/web/test/codium-public.test.ts` and `packages/app/src/components/prompt-input/submit.test.ts` (new cases).

## P5 review decisions (3 Nov 2026)

- **Founding settings are not Codium configuration problems.** A31 had joined `foundingConfigProblems()` to
  `codiumBillingConfigProblems()`, which §2 forbids in effect: one bad founding value stopped the service for every
  subscriber. An invalid founding setting now closes only the founding window and is named on the owner page
  ("Founding window settings" in the checklist), never among the problems that turn Codium off.
- **Credits sold, not boosted credits, are checked against the price.** `paidModelPlan()` and the ledger compare the
  credits a subscription was sold (`subscriptionSoldCredits`) with the price; the founding +10% may take the key past
  the price, as the boost intends.
- **The founders page follows the plan state in reconcile.** §4.4's "hidden from the founders page" while frozen holds
  whether or not `founding` is still in `CODIUM_LISTED_PERKS`: `settleFounding` converges a listed founder's entry on
  every reconcile, and the provisioner stays as the quicker path.
- **Report records stay keyed under the Codium prefix (§4.6),** and a live server reads and erases under both the live
  and the test prefix, because production writes under `test` until a live key is configured.
- **The per-review token stop is built; the per-PR stop is not.** `CODIUM_REVIEW_TOKEN_STOP` (400K) in
  `packages/engine/src/review/run.ts` applies when any pass runs on Vector Codium, before the check and the panel's
  judge, and counts new input, output, reasoning and cache writes (not cache reads). The 2M-per-PR daily stop needs the
  pull request's state, which Codex's GitHub workflow keeps. It still has no owner: the owner should assign it before
  A60.
- **For Codex at A59:** A35 added `panel` and `judgeModel` to the "Your rules" row of `/docs/vectorscope#pull-requests`.
  §7.3 gives that section to Codex, so the row change was taken back. Codex may apply it with the GitHub review work;
  the options stay documented in `#second-lab`.
- **`codium-legal` is not on GitHub.** A30's drafts (`94a5004e`) were never pushed, because this Mac must not run the
  pre-push hook (turbo). The orchestrator pushes it.

## A37 shared service plumbing and push (3 Nov 2026)

- **"Ciphertext ≤3 KB" is the base64url text, at most 3,072 characters.** 3 KB of raw bytes is 4,096 characters of
  base64url. Inside the JSON payload that does not fit one 4,096-byte push record, which holds at most 3,993 bytes of
  plaintext. So the limit applies to the text as sent, about 2.25 KB of ciphertext bytes. The decoded ciphertext must
  be at least 29 bytes (a 12-byte nonce and a 16-byte tag around one byte). The body may carry only `ciphertext`, an
  optional `key` (which phone key opens it) and `urgency`. A title, message or any other field is refused, which is
  how the route "accepts only end-to-end ciphertext".
- **Who subscribes.** The contract names no credential for `/api/notify/subscribe`. A40 says phones sign in with a
  website session on the phone origin, so subscribing takes a Supabase bearer session, sent from the site or from
  `VECTOR_PHONE_APP_ORIGIN`. To let that origin through, `requireTrustedJsonRequest` gained an optional list of extra
  origins. `GET` answers the VAPID public key, which a browser needs to subscribe. `DELETE {endpoint}` works whatever
  the plan. Subscribing is limited to 30 an hour per account.
- **Push endpoints are allow-listed** to the browsers' own push services (Google, Mozilla, Apple, Microsoft), on top
  of `safeFetch`'s S8 checks. Otherwise the server would POST to any host a user names. The A30 privacy draft already
  says alerts go "through the push service of your browser's maker".
- **"≤10" replaces the oldest instead of refusing**, so a reinstalled phone app is never locked out. Eviction is HSET,
  then HGETALL and HDEL (no script), and a send reads at most the ten newest. Parallel subscriptions can briefly leave
  eleven, never more than ten reached. The hash expires 400 days after the last registration or successful delivery.
- **"An active paid plan" is active or renewing within grace,** per §4.4's Phone alerts row, through
  `requireUsableSnapshot`. Both routes also need the VAPID keys and the `push` switch on (503 `PUSH_UNAVAILABLE`).
  `sendServerAlert` takes `allowPaused` for On Call, whose §4.4 row keeps alerts going while paused. It answers
  `{skipped}` instead of throwing.
- **Payload shapes** the phone app decodes: `{v:1, kind:"e2e", c, k?}` and `{v:1, kind:"title", title, tag?}`. A
  title is at most 120 characters on one line; a tag is a lower-case category word, not content. The push TTL is
  12 h, and the VAPID token lives 12 h (RFC 8292 allows 24).
- **The `push` provisioner replaces its stub** (`codium-provisioners.ts`, outside A37's file list, as the stub's own
  comment asks). It is configured while the VAPID keys are, and erases the subscriptions on `closing` (P5).
  `eraseAccountPushSubscriptions` deletes under both prefixes, like A33's records. Subscriptions are written under the
  current mode's prefix.
- **Internal HMAC.** §4.16 names no relay secret, so `relay` shares `VECTOR_HOSTED_INTERNAL_SECRET` with `hosted`.
  Each service signs under its own derived key, HMAC(secret, `vector-internal-v1/<service>`), so a request for one
  never passes at another. `ops` uses `VECTOR_OPS_SHARED_SECRET`. Nonces are remembered for 600 s under
  `internal:nonce:<service>:<nonce>` (Codium prefix), a store key §4.6 does not list. The timestamp is in seconds.
  Plain http is allowed only to localhost outside production, for local Worker runs.
- **R2 settings** are `VECTOR_R2_{VAULT,MEDIA}_{ACCESS_KEY_ID,SECRET_ACCESS_KEY,BUCKET}` (§4.16 writes
  `VECTOR_R2_VAULT_*`). Buckets default to `vector-vault` and `vector-media`. Presigning also supports HEAD and DELETE
  (A44's commit HEADs and deletes objects). Keys are limited to plain path characters. The default life is the 900 s
  ceiling.
- **`safeFetch` defaults:** https only, port 443, 10 s, 64 KiB answers. Any 3xx except 304 is an error.
- **Files outside A37's list:** `api/_lib/abuse.ts`, `api/_lib/codium-provisioners.ts`, `.env.example`,
  `docs/vector/MODEL-PLANS.md`.

## A38 phone app shell (3 Nov 2026)

- **The phone app lives at `/phone/` on the phone origin, not at its root.** The contract asks for "a host rewrite for
  remote.vectordev.ai". Vercel applies `vercel.json` rewrites only after real files, and the website's `/index.html`
  exists in the same deployment, so no rewrite can put the phone page at `https://remote.vectordev.ai/`. Instead the
  website build copies the phone build to `/phone`, the phone origin redirects every other path to `/phone/` except
  `/api/` (the app calls the API on its own origin, so the CSP names no Vector API host), unknown `/phone/…` paths are
  rewritten to the app's page, and `vectordev.ai/phone` redirects to the phone origin so the app never runs on a
  second origin. The worker at `/phone/sw.js` takes the whole origin as its scope through `Service-Worker-Allowed: /`,
  which is the header the contract lists. Manifest: `id` and `start_url` `/phone/`, `scope` `/`.
- **`connect-src 'self' https://*.supabase.co`.** The account service's address is a deployment setting
  (`SUPABASE_URL`), not in the repository, and a static header cannot read it. A custom domain for it would need the
  header changed. The relay's `wss:` host is added by A42 with the relay URL.
- **Sign-in on the phone uses a small fetch client of the account service** (Google through PKCE S256, email and
  password, refresh, sign out) instead of the website's library: `packages/app` does not depend on it, and adding it
  would change `bun.lock`. Google sign-in on the phone needs `https://remote.vectordev.ai/phone/` in the account
  service's redirect allow-list (owner step).
- **"Features shown by listed and entitlements"** reads: Remote's sessions, approvals and devices need `remote` listed
  and `entitlements.remote.computers > 0`; GitHub runs (the contract's "cloud runs", which §1.1 lists under Remote)
  also need `github-agents` and `entitlements.cloudAgents`, and are labelled "GitHub runs" with the H4 wording; the
  cloud computer needs `computer` and `entitlements.hosted`; production needs any listed ops part and
  `entitlements.ops`, and names only the listed parts; alerts need `alerts` and a plan (`entitlements.rank`). A
  paused, frozen or ended plan keeps its routes with a notice.
- **"Pairing must happen inside the installed Home Screen app on iOS"** is applied to pairing, sessions, approvals and
  alerts: an iOS browser tab (including an iPad that reports itself as a Mac) shows how to install instead. Sign-in is
  allowed in a tab but says to install first, since the installed app keeps separate storage.
- **"Version handshake"** reads as two halves: with the server, each build writes `/phone/version.json` and an open app
  reloads once onto a newer build (never twice for the same build); with the desktop, `negotiate()` picks the
  protocol both speak from each side's `{protocol, minPeer}` hello or names the side that must update. A41/A42 send
  and answer the hello.
- **The desktop alert envelope is defined here**, as the phone's decoder: `c` = base64url(12-byte nonce ‖ AES-256-GCM
  ciphertext and tag), additional data `vector-alert-v1`, a 32-byte key named by `k` (`default` when absent),
  plaintext `{v:1, title, route?}` with A37's title rules. A41 must seal alerts this way. Keys live in IndexedDB as
  non-extractable decrypt-only keys, and signing out forgets them. An alert the phone cannot open still shows a
  notification without content, because iOS and Chrome revoke push for a page that shows nothing.
- **The worker has no fetch handler**, so nothing an account sees is cached on the phone and every deploy reaches the
  next load. It is built separately as one classic script, since module service workers are not on every phone the
  app supports.
- **Settings → Notifications.** `notifications.events` defaults to finished, needs-you and Run Guard on and usage off
  (like `codium.alert80`); `notifications.quietHours` is `{start, end}` in local "HH:MM", or null. The Phone alerts
  card shows when the status lists `alerts` and the plan includes them; the event switches and quiet hours show only
  where the desktop can send alerts (`platform.phoneAlerts`, A41's bridge, typed here), so no switch is shown that does
  nothing. The shared page pieces moved from `general.tsx` to `settings-v2/parts/page.tsx` unchanged.
- **`alerts` readiness** is `pushConfigured() && phoneAppOrigin() !== undefined`, per "alerts can be listed once A37 and
  this ship". Nothing sends alerts until A41 (desktop) or A50/A56 (server); the notes ask the owner to list `alerts`
  only then.
- **The Vercel build builds the phone app first** (`bun --cwd packages/app run build:phone && …`), and the website copy
  fails a Vercel build when the phone build is missing, so the phone origin is never published without its app. The
  Codium CI lane builds it before the tests.
- **Files outside A38's list:** `api/_lib/codium-perks.ts`, `settings-v2/parts/page.tsx`, `general.tsx`,
  `dialog-settings-v2.tsx`, `settings-registry.ts` (search words), `context/settings.tsx`, `context/platform.tsx`,
  `packages/app/package.json`, `packages/app/script/browser-imports.ts`, `packages/web/scripts/phone-app.mjs`,
  `packages/web/astro.config.mjs`, `.gitignore`, `.github/workflows/vector-codium.yml`, `.env.example`,
  `docs/vector/MODEL-PLANS.md`.

## A39 Remote relay Worker (3 Nov 2026)

- **The ticket format is defined here,** since A40 (which mints tickets) is not built. A ticket is
  `vt1.<base64url JSON>.<base64url Ed25519 signature>`, signed over `vector-relay-ticket-v1.` plus the payload. Every
  character is a subprotocol token character.
  - "Device and fair-use caps from the ticket": the claims carry the plan's `computers` (ENTITLEMENTS `remote.computers`)
    and `viewerHours` (`REMOTE_LIMITS`). The relay keeps §4.2's fixed values itself (five phones, 1.5×, 30 minutes,
    64 KiB, 20 a second); `test/remote-relay-contract.test.ts` keeps them equal to the API's.
  - The meter `epoch` is a base64url hash of `meterEpoch`, so no Stripe subscription id reaches the relay.
  - Each ticket opens one connection or one refresh (`jti` recorded until expiry).
  - "aud" is `vector-relay`. "exp ≤5 min" is read as `exp − iat ≤ 300 s`, with `iat` at most 60 s ahead of the relay's
    clock.
  - The API's key is base64url PKCS#8 (`VECTOR_REMOTE_TICKET_SIGNING_KEY`, §4.16). The Worker holds raw public keys.
- **Worker secrets the contract does not name:** `TICKET_PUBLIC_KEYS`, `INTERNAL_SECRET` (the value of
  `VECTOR_HOSTED_INTERNAL_SECRET`, as A37 decided for `relay`) and `ACCOUNT_KEY`. `ACCOUNT_KEY` is the HMAC key behind
  `idFromName(HMAC(account))`. It is a dedicated key because rotating the internal secret must not reset every
  account's devices. The Worker computes the HMAC, so the object never stores the account id; the API sends the plain id
  in tickets and internal calls.
- **Devices are registered on first connection.** The relay counts pairings and refuses one over the cap. Pairing
  itself (QR, keys, passkeys) is end to end in A41/A42.
  - Caps count devices in pairing order, so after a downgrade the earliest devices keep their places, and the rest are
    closed and refused until the user revokes one.
  - A revoked device keeps only its id (name and key cleared) and that id is refused for good; a device pairs again
    under a new id.
  - The privacy draft (#remote) lists the same device fields.
  - One connection per device: a newer one replaces the older.
- **Refusals after a valid ticket are accept-then-close** with a 4000-4011 code named after §4.10's service codes
  (`REMOTE_PAUSED`, `REMOTE_REVOKED`, `REMOTE_DEVICE_LIMIT`, `REMOTE_FAIR_USE`, …), because a browser cannot read the
  HTTP status of a failed handshake. A missing or bad ticket gets HTTP 401 with no socket.
- **Viewer time** runs while at least one phone is attached, not per phone.
  - "Counted in memory and persisted at most once a minute": the running total is computed in memory from a stored start
    (written when the first phone attaches, so it survives hibernation).
  - The meter is written by the once-a-minute alarm, and once more when the last phone leaves, which is a state change.
- **Awake-hours** (§4.2, "at most 1.5× viewer-hours") are read as the relay object's billed awake time, which is what the
  cap protects.
  - The estimate: each event adds the gap since the previous one, up to the runtime's 10 s idle tail. It is flushed on
    the same schedule, so an object evicted before a flush loses at most that minute.
  - It is checked by the alarm and from messages at most every 10 s, because a computer can keep the object awake with no
    alarm running.
  - Viewer-hours used up closes and refuses phones for the epoch (computers stay, so presence keeps working); awake time
    used up closes and refuses everyone.
- **Idle means no data frame for 30 minutes.** Heartbeats, ticket refreshes and presence queries are not activity: a phone
  app refreshes on its own, and counting refreshes would mean an open phone never idles.
- **"Tickets refreshed in-band"** works differently for each role:
  - A phone must refresh before `exp + 60 s` or is closed by the alarm.
  - An idle computer keeps its hibernated socket after its ticket lapses, but its frames are refused until it refreshes.
    `peers` carries `refresh: true` when a phone arrives, and a computer more than 24 h past expiry is closed when the
    object next wakes.
  - Forcing idle computers to refresh every few minutes would wake each object hundreds of times a day, which is the
    awake time §4.2 caps.
  - Revocation does not wait on expiry: `kill` and `suspend` close sockets at once.
- **The plan comes from the newest ticket by `iat`.** It is stored with that ticket's `iat`, written only when the plan
  changes, so a ticket from before an upgrade or downgrade, presented late, never undoes it.
- **"≤20 frames a second"** is a 20-a-second average with a burst of 40 (a computer batching four messages a second to
  five phones sends 20). More than 100 refusals in 10 s close the connection.
- **"Kill and suspend pushed through the internal API":**
  - `kill {account, before?}` sets `revokedBefore` (never in the future) and closes older connections.
  - `suspend {account, suspended, reason, at}` covers paused, frozen and owner holds, and ignores an update older than the
    last applied `at`.
  - Also added: `presence` (the relay half of `isComputerOnline`, §4.17), `devices`, `revoke-device`, `erase` (P5, for
    A57) and `flags` (the Worker's kill flag, written through a `control` object so its nonce is recorded once).
  - Nonces are recorded in the object that handles the call; KV is eventually consistent and cannot dedupe.
- **The kill flag** is KV `REMOTE_FLAGS` key `kill` = `1`.
  - It is read on every connection, every alarm and every in-band refresh; a flag that cannot be read counts as set.
  - Phones close at their next alarm. A computer with no phone attached is not woken, but nothing can reach it while it
    is off.
- **"Reserved job.offer"**: frame kind `0x02` and control `{t:"job.offer"}` from a client get a `reserved` notice and are
  never passed on; `POST /internal/v1/job-offer` answers 501 after the signature check.
- **No `@cloudflare/workers-types` dependency.** `src/runtime.ts` declares the subset used and lets the tests inject a
  runtime. It was checked here against workers-types 4.20251008.0 in a scratch config (not committed).
- **"CI smoke under wrangler dev --local"** is `packages/relay/e2e/relay-smoke.ts`, run by a new `relay` job in
  `vector-codium.yml` after `wrangler deploy --dry-run` ("deploy dry run green"). Running `wrangler dev` on the owner's
  Mac is forbidden; the dry run itself was run here once.
- **`wrangler.jsonc`** uses a zero KV id (the owner replaces it; a deploy carrying it fails rather than writing
  elsewhere), `workers_dev` with no custom domain (the relay host is the owner's choice), and compatibility date
  2025-04-01.
- **`bun.lock` is committed this time.** The new workspace needs its entry for frozen installs, and bun re-hoisted
  `@sindresorhus/is` (no new versions). The lock also picks up the desktop `1.99.112` version line, which was pending in
  the worktree since before A29: the committed manifests say 1.99.112, so a frozen install needs it too.
- **Files outside A39's list:**
  - Relay package: `packages/relay/src/{protocol,limits,runtime,bytes}.ts`, `packages/relay/e2e/relay-smoke.ts`,
    `packages/relay/tsconfig.json`, `packages/relay/.gitignore`.
  - Root test: `test/remote-relay-contract.test.ts`.
  - `.github/workflows/vector-codium.yml`, `bun.lock`.
  - Docs: `docs/vector/MODEL-PLANS.md`, `docs/vector/owner-actions/remote.md` (new).

## A40 Remote API (4 Nov 2026)

- **"Refused when not active"** is read as §4.4's Remote relay row: a ticket is minted while the plan is active, or
  renewing within grace (`requireEntitlement(account, "remote")`). Paused, ended, frozen and no plan get the plan's own
  refusal (402 `MODEL_PLAN_PAYMENT_REQUIRED`, 402 `MODEL_PLAN_REQUIRED`, 403 `MODEL_PLAN_BLOCKED`), which the clients
  already map to "Update card", "See plans" and "contact"; `REMOTE_PAUSED` stays the relay's close code. Zero paired
  computers is 403 `CODIUM_PERK_REQUIRED`. The switch off or Remote not configured is 503 `REMOTE_UNAVAILABLE`.
- **"Phones need a Supabase session on the phone origin"**: a website session whose request `Origin` is exactly
  `VECTOR_PHONE_APP_ORIGIN` (the phone app calls its API on its own origin, so the browser sets it). Without it, 403
  `REMOTE_PHONE_APP_REQUIRED`; without the setting, 503. A desktop token cannot mint a phone ticket and a session
  cannot mint a computer ticket. Both roles also need `requireUnrevokedAccount`.
- **New codes** besides §4.10's: `REMOTE_UNAVAILABLE` (503), `REMOTE_PHONE_APP_REQUIRED` (403), `REMOTE_TICKET_INVALID`
  and `REMOTE_DEVICE_INVALID` (400), `REMOTE_RUNS_LIMIT` (400), `REMOTE_RUNS_UNAVAILABLE` (503); and A37's
  `DESKTOP_SIGN_IN_REQUIRED` (403) for a pasted CLI token.
- **The API does not count devices before signing.** The relay enforces the paired-computer and phone caps on every
  connection from the ticket's count, which comes from the snapshot (S1 on the server). Asking the relay at each mint
  would double the relay calls of every refresh. `GET /api/remote/devices` marks the devices past the plan's limit.
- **`kill` is "Disconnect all"**: every connection closes and tickets issued before now are refused; devices stay
  paired. It accepts the desktop sign-in or a website session. So do `devices` and `devices/:id/revoke`, which work
  whatever the plan (like A37's push `DELETE`) and are not stopped by the `remote` switch; an account that never had a
  plan is answered without asking the relay.
- **Ticket times.** `iat` is the current whole second and `exp` 300 s later (the relay's maximum). The relay compares
  whole-second `iat` with a millisecond kill time, so a ticket minted in the same second as a kill is refused too; the
  client asks again. The API no longer clamps a kill time to its own clock (the relay clamps to its own).
- **"revokeAccountTokens also kills relay sockets"**: after the revocation mark is written, the relay's `kill` is
  called for the account, best effort (the answer is unchanged). If the relay cannot be reached, the mark still stops
  new tickets and a phone is closed within a minute of its ticket's expiry.
- **The `remote` switch reaches the Worker.** Writing it on `/owner/codium` also calls the relay's `flags`, and the
  answer carries `relay: "updated" | "failed" | "not-configured"`. Edit in `api/_lib/codium-owner-api.ts` (outside
  A40's list); a failure never undoes the switch.
- **Provisioner readings** (§4.4's row): paused suspends; frozen kills at `revokedBefore` and suspends (`owner` for an
  owner hold); active and renewing lift; ended (and a plan gone back to none) kills at the snapshot's `updatedAt` and
  lifts any suspension, since the relay's suspension reasons are paused, frozen and owner only and no ticket can be
  minted while ended; `closing` erases (P5). Calls are made only when the change needs one, or always without a
  previous snapshot. It is configured while the relay can be called, not only while `VECTOR_REMOTE_ENABLED` is true,
  so suspensions and erasure keep working after Remote is turned off.
- **"Cloud runs from Codex's records"**: Codex's `listCloudRuns` lives on `vector-at-mention`, which this build may not
  import. The route reads a registered reader (`registerCloudRunReader`) that A59 wires to it, and answers
  `{runs: [], available: false}` until then. Only `id, repository, url, event, source, purpose, startedAt, endedAt,
outcome, verdict, actor.login` pass. Every paid plan includes it while the plan allows Remote, and it needs Remote
  on.
- **Not built here:** `remote`'s readiness check in `perkServices` (Remote is unusable before A41 and A42, so A42 adds
  it) and the `remote` status meter, which would form an import cycle if registered beside the provisioner
  (`model-plan-status.ts` imports `codium-provisioners.ts` through `model-plan-account.ts`).
- **Files outside A40's list:** `api/_lib/remote-relay.ts` (new; the relay client, kept apart so `revocation.ts` can
  import it without a cycle), `api/_lib/revocation.ts`, `api/_lib/codium-owner-api.ts`, `.env.example`,
  `docs/vector/MODEL-PLANS.md`, `docs/vector/owner-actions/remote.md`, and the test file `test/remote-ticket-api.test.ts`
  (the contract's `remote-ticket-api.test.ts`), which imports the relay package's test fakes.

## A41 desktop Remote (4 Nov 2026)

- **"Keys in `safeStorage`"**: the identity (device id, static X25519 key, alert key) and the paired phones are sealed
  in-process with `vault-secrets.ts`, whose key the OS credential store holds through Electron's `safeStorage` and opens
  once a launch. That is how the app already keeps every sign-in; calling `safeStorage` per secret would ask the
  Keychain again after each update on unsigned builds. Stored in the `vector-remote` store.
- **Pairing design** (the contract names only "QR pairing with transcript HMAC and a 6-digit check code"): the QR is
  `https://remote.vectordev.ai/phone/pair#<offer>`, the offer only in the fragment; the phone's request is sealed under
  a key from the QR's secret and carries an HMAC of the transcript; the computer answers with its own HMAC; the code is
  HKDF of the secret over the transcript and the passkey registration, so both screens match only when both saw the
  same keys and passkey; the alert key comes back under a static-static Diffie-Hellman key. An offer lasts five
  minutes; a second phone answering the same QR stops the pairing; three bad requests end it; a computer keeps at most
  five phones (§4.2's five per account, which the relay enforces).
- **The passkey is registered while pairing** and checked on the desktop only: user verification required at
  registration and at each approval; the attestation statement is not checked (Vector asks for `none`; trust comes
  from the transcript the challenge is bound to); a counter must go up unless both are 0. An approval challenge is
  random, bound in the desktop's own table to the phone, the request, its session and its directory, used once, and
  good for two minutes.
- **"Per-connection X25519 + HKDF + AES-256-GCM with sequence numbers"**: an INIT/ACCEPT handshake over ephemeral and
  static keys (all four Diffie-Hellman results), one key per direction, and a sequence number that must go up. Gaps are
  allowed, because the relay drops frames over its rate limit. Module comment of `remote-crypto.ts`.
- **"The route allowlist"**: the routes in `REMOTE_ROUTES`. Stricter than needed in two places, left for A42 to widen
  deliberately: a phone's turn carries only text (no model, agent, tools, system prompt, files or permission rules),
  and a session it creates only a title. Every request names a directory that must be one of the engine's projects
  (a worktree or a sandbox, never the global `/`). The V2 runner's routes are not exposed. Questions are answered
  without a passkey; they are not permissions.
- **"Turns started from the phone never auto-approved"**: the phone's prompt marks its session before the engine starts
  the turn, until the engine reports the session idle (the link reads the engine's events while any mark stands). The
  app's auto-accept (the only one in the desktop; `vector run --auto` is another process) asks the desktop over IPC
  before each answer, for the request's session and every session above it, and holds the request for a person when a
  phone started it or the check fails. The computer's own permission rules still apply to a phone's turn: configured
  allow rules and "always" answers given on the desktop are the computer's rules, which Remote does not widen.
  Edits outside A41's list: `packages/app/src/context/permission-auto-respond.ts`, `permission.tsx`, `pages/layout.tsx`.
- **"Origin checked as exactly `VECTOR_PHONE_APP_ORIGIN`"**: that is a server setting. The desktop compares with the
  constant `https://remote.vectordev.ai` (A38's `PHONE_APP_ADDRESS`); a development build may name another origin with
  `VECTOR_PHONE_APP_ORIGIN` in its environment, a packaged build never.
- **"Stream only while viewers > 0, batched to 4 messages a second"**: the engine's events are read only while the relay
  reports a phone attached and a phone asked to watch (and while a phone's turn runs, only to see it end). Each watching
  phone gets one batch per 250 ms, or 500 ms once more than three watch, so five phones stay inside the relay's 20
  frames a second per connection; a frame budget of 16 a second, burst 32, covers answers too. An event over 16 KB
  goes as its ids with `truncated`; an answer over 40 KB goes in parts; one over 4 MB is refused.
- **"Keep awake while a phone watches a busy session"**: keep-awake's `watching` input. While a phone watches, every busy
  session holds the blocker, one waiting on a prompt included (the phone can answer it), and the stall rule is off. The
  relay's 30-minute idle close ends the watch.
- **"Disconnect all phones rotates identity"**: a new device id, static key and alert key, then `POST /api/remote/kill`
  and `POST /api/remote/devices/<old id>/revoke`, which frees the old device's place (on Plus the one computer slot,
  which the new id needs). The kill closes the account's other computers' connections too; they reconnect by
  themselves. Unpairing one phone is local to this computer, because the same phone may be paired with others.
- **"Encrypted alerts"**: the app decides which go (each event's switch, quiet hours, and only while the status lists
  `alerts` for the plan, read at most every five minutes, H1); the main process seals and sends them, only while a phone
  is paired, once per minute for the same alert across windows, at most 50 an hour. Triggers are new app code outside
  A41's list: finished (`context/notification.tsx`, not while that session is on screen), needs you
  (`pages/layout.tsx`), Run Guard (the first `session.spend` warning in a session) and usage
  (`components/settings-vector-codium.tsx`, the card's existing 80% check, which runs while the card is shown).
- **Names**: the ticket names the computer as "Mac", "Windows PC" or "Linux computer", because the relay stores and
  lists device names; the computer's own name goes only to its phones, end-to-end encrypted or in the QR.
- **`remote.enabled`** (§4.15) is kept in the main process's store, which decides whether to connect, not in the app's
  settings; A42's Settings reads and sets it through `platform.remote`.
- **Files outside A41's list:** `packages/desktop/src/main/remote-runtime.ts` (new; the Electron wiring, kept apart so
  the other modules test without Electron), `remote-phone.fixture.ts` (new; a simulated phone for the tests),
  `ipc.ts`, `index.ts`, `vector-account-runtime.ts` (sign-in listeners), `preload/index.ts`, `preload/types.ts`,
  `renderer/index.tsx`, `packages/desktop/package.json` (`@vectordevai/relay` as a workspace dev dependency, so the
  desktop imports the relay's protocol as A39 intended) and its one `bun.lock` line, `packages/core/src/local-mode/sources.ts`
  (Vector Local sources `remote` and `phone-alerts`), `packages/app/src/context/platform.tsx` (`RemotePlatform`),
  `packages/app/src/context/phone-alerts.ts` (new), `app/src/features/local/local-model.ts` (labels),
  `docs/vector/MODEL-PLANS.md`, `docs/vector/owner-actions/remote.md`. Test files: `packages/core/test/webauthn/verify.test.ts`
  (the contract's `webauthn/verify.test.ts`), `remote-link.test.ts`, `remote-notify.test.ts`, `phone-alerts.test.ts`,
  and new cases in `keep-awake.test.ts` and `permission-auto-respond.test.ts` (the auto-approve suppression test).

## A42 Remote phone UI and Settings → Remote (4 Nov 2026)

- **Files outside A42's list** ("`packages/app/src/phone/` remote routes, `settings-v2/remote.tsx`"), each the smallest
  change the package needed:
  - `packages/core/src/remote/crypto.ts`: A41's `packages/desktop/src/main/remote-crypto.ts`, moved (git rename) so the
    phone runs the same file; the desktop's old name re-exports it, so A41's modules and tests are unchanged. It also
    takes a non-extractable X25519 `CryptoKey` wherever it took PKCS#8 bytes (`PrivateKeyInput`), and adds
    `generateDeviceIdentity()` and `x25519Supported()`.
  - `packages/desktop/src/main/remote-host.ts`: `PHONE_APP_ORIGIN`, `phoneAppOrigin`, `relayName` and `computerName`
    moved out of `remote-pairing.ts` unchanged, so pairing, link and route modules import nothing from Node and run in a
    browser (the CI browser spec drives the real desktop link). `remote-runtime.ts` and `remote-link.test.ts` import
    them from the new module; no test expectation changed.
  - `packages/app/src/utils/qr/` (new): a QR encoder for Settings and a decoder for the phone's scanner. No QR package
    exists in the repository and adding one would add a dependency; ISO/IEC 18004 byte mode, versions 1 to 25, tested
    against the standard's published Reed-Solomon example, format and version bits and block table.
  - `api/_lib/remote-config.ts` (new): `remoteEnabled`, `ticketSigningKey` and `remoteConfigured` moved out of
    `remote-ticket.ts` (which re-exports them) so `codium-perks.ts` can ask whether Remote is configured without
    importing the ticket code and its plan reads. `api/_lib/remote-meter.ts` (new) and one import in
    `api/model-plans/status.ts` register the `remote` status meter; `codium-perks.ts` gains `remote`'s readiness check.
  - `vercel.json` (the relay host in `connect-src`), `test/phone-app.test.ts` (that CSP expectation), `packages/app/
    package.json` and its one `bun.lock` line (`@vectordevai/relay`, for the wire protocol, as the desktop has it),
    `settings-registry.ts` and its test (the new tab; the test pinned 16 pages, now 17 with Remote), `dialog-settings-v2.tsx`
    (the tab's gate), `phone/status.ts` (a `pair` page), `phone/app.tsx`, `phone/routes/parts.tsx`, `phone/phone.css`,
    the e2e fixture and spec, docs.
- **The relay's host is fixed at `relay.vectordev.ai`.** A38 left "the relay's wss host" in the phone CSP to A42, and
  A39 chose no custom domain. A static `vercel.json` header cannot read `VECTOR_REMOTE_RELAY_URL`, and a wildcard such
  as `wss://*.workers.dev` would let a page script reach any Worker. The CSP and the phone app (`RELAY_HOST` in
  `phone/remote/model.ts`) name one host, and the phone refuses a ticket naming another, with a clear message. The
  owner adds that custom domain to the Worker (owner-actions/remote.md step 7, which needs the `vectordev.ai` zone on
  Cloudflare) or changes both names together; `test/remote-phone-api.test.ts` fails when the CSP and the app disagree.
- **Pairing inside the installed app needs an in-app scanner.** On iPhone, the system camera opens the QR's link in
  Safari, whose storage is not the Home Screen app's (A38's rule). The Pair page scans with the camera (A38 allowed
  `camera=(self)` on the phone origin for this), using the browser's BarcodeDetector where it exists and Vector's
  decoder elsewhere (Safari), and also takes the link pasted. A Safari tab opened from the link offers to copy it for
  the installed app.
- **Passkeys need a tap in Safari,** so the phone prepares everything first (relay connection, transcript, challenge)
  and makes the passkey from the "Make a passkey and pair" tap. Allowing once fetches the computer's challenge, then
  asks for the passkey; when the browser refuses that outside a tap, the button turns into "Confirm with your passkey"
  and the next tap uses the same challenge while it is valid. One passkey per computer, `residentKey: discouraged`,
  `attestation: none`, user verification required, a random user handle that names no account or person.
- **The phone's own keys.** Its static X25519 private key is a non-extractable `CryptoKey` in its own IndexedDB
  database (`vector-phone-remote`, apart from A38's `vector-phone` so A38's alert-key store keeps its version), with the
  paired computers' public keys and passkey ids. Signing out forgets all of it, as A38 forgets alert keys; pairing again
  after sign-out is the cost. "Set up this phone again" (after the relay refused it twice) revokes the old device id
  first, so it stops counting toward the account's five phones, then makes new keys.
- **Data only on the person's actions** (A39's idle rule). Opening a Remote page connects and opens a channel per
  online paired computer; lists are read once when a page opens and on Refresh; live changes (sessions, messages,
  permission and question requests) arrive as watched events and are applied without asking the computer again. A
  truncated event asks the person to load again instead. A phone closed after 30 idle minutes says so and reconnects
  when the person comes back to a Remote page or taps "Connect again"; it never reconnects in a loop. The one automatic
  reconnect is the single retry after `REMOTE_REVOKED`, 1.5 s later so it lands past the second a kill was made in.
- **Close codes the phone acts on:** revoked (one retry, then "removed" with "Set up this phone again"), ticket expired
  and stale (one retry), paused, relay off, device limit, fair use, replaced and idle (each says why; no retry). A
  pairing that had sent its request fails if the connection drops, because the computer's answer would be lost; one
  still waiting for the computer or the tap waits again after reconnecting.
- **The allowlist is not widened.** The phone sends text turns and titles only, as A41 allows; it picks no model or
  agent. New sessions from the phone are titled "From my phone".
- **"The paired count 'N of limit' from status"**: `meters.remote {computers, limit}` (§4.11), the relay's computer
  devices against `caps.remote.computers`, read from the relay's `devices` action within the registry's 1.5 s. It is
  registered by the status route's own import, not beside the provisioner (A40's import-cycle note), so only that route
  shows it; every reader of the status (desktop and phone) uses that route. A relay that does not answer leaves the
  meter out, and both pages fall back to the plan's limit.
- **Settings → Remote shows** when the status lists `remote` for a plan with paired computers (H1), or when this
  computer already has Remote on or a phone paired, so it can always be turned off and its phones removed after a plan
  or listing change. It sits in the Personal group beside Account and Roadmap vote.
- **Devices on the phone**: the account's devices from `GET /api/remote/devices` with Remove (revoke for good) and
  Disconnect all (`POST /api/remote/kill`), plus the computers paired with this phone, with Forget (this phone only).
  Removing a computer from the phone also forgets it here; removing this phone starts it over.
- **Tests**: the contract's "e2e in CI with a virtual WebAuthn authenticator" is `packages/app/e2e/regression/
  remote-phone.spec.ts` (CI only: Playwright is not run on this Mac). Locally, `packages/desktop/src/main/
  remote-phone-app.test.ts` runs the phone's real client against the desktop's real link through an in-memory relay
  with a software passkey the desktop's verifier checks.

## A43 Vault core and CLI (4 Nov 2026)

- **New files outside A43's list.** `packages/core/src/vault/vault.ts` (backup, read, forget, create and unlock over
  any store), `store.ts` (the store interface and a memory store), `github.ts` (the free GitHub backend over git),
  `remote.ts` (the client of A44's Vault API) and `error.ts`. The contract names crypto, format, recovery and chunker
  only; backup and restore need a home, and the CLI needs both backends. `packages/core/src/local-mode/sources.ts`
  gains the `brain-vault` source, and `packages/engine/src/index.ts` registers `vector vault`.
- **The Vault API's shapes are defined here**, in `packages/schema/src/vault.ts`, because the CLI's Vector backend
  needs them before A44 exists: `GET|POST /api/vault/setup`, `POST /api/vault/uploads` (declares up to 1000 of a
  version's objects with their stored sizes, present or not, so the server knows what each version references and
  reserves quota before it signs; the manifest's size in the last request), `POST /api/vault/commit {version,
  objects}`, `GET /api/vault/snapshots`, `GET|POST|DELETE /api/vault/snapshots/:id` and `DELETE /api/vault`. Commit
  carries a count, not the object list, so a large vault does not make one large request. A44 implements these, or
  changes both sides together.
- **Test location.** P3's test is `packages/core/test/vault/vault.test.ts`, not `packages/core/src/vault/vault.test.ts`:
  core's tests live under `test/`, as A41's `webauthn/verify.test.ts` did.
- **Object ids** are HMAC-SHA-256 under a key derived from the vault key, as the contract says, and the chunker's gear
  table comes from the vault key too, so chunk sizes tell the store nothing common to every vault. Each object starts
  with a 12-byte header (`VVLT`, format, kind, `minReader`, compression) that is part of the associated data with the
  vault id and the object's id ("AAD vaultId ‖ chunkId" plus the header), so `minReader` is refused before anything
  is opened and cannot be lowered without failing the tag. Brotli, and a chunk is stored raw when brotli does not make
  it smaller.
- **Recovery code**: 26 Crockford base32 symbols (130 random bits) and 2 checksum symbols from SHA-256, shown as seven
  groups of four; O, I and L read as 0, 1 and 1. scrypt N=2^17, r=8, p=1 by default; a reader accepts N from 2^14 to
  2^20, so a store cannot make it allocate more, and the tests use 2^14 except one that runs 2^17.
- **"Restore through a vault-trusted versioned import"** is `BrainExport.restore({trust: "vault"})` with
  `decodeBackup`, which reads only `vector-memory` JSON of a version in `RESTORE_VERSIONS` (1). Each entry goes
  through `brain.propose` as an import and, when the backup had it in use, `brain.update` approves it (and pins it)
  at once, so what was in use never fills the 500-entry import queue. Batches of 500 entries or 2 MB of JSON replace
  the import's cut-off. The brain's own refusals still apply (forgotten here, secrets, its 300-entry active cap per
  scope), an entry already in memory is left as this computer has it, restored entries carry origin `import` and
  evidence `user`, and documents are not restored (their records need the files).
- **What a backup holds (main-built).** One `memory` file per scope: the person's own memory and each repository's
  that has learned entries, the repositories coming from the engine's project list. Sessions are not in it: neither
  A43's text nor A45's names them, and B10 adds skills and insights.
- **The GitHub backend** keeps 7 versions on the person's computer, as A45 says for the desktop, and each push is a
  single commit with no parent, sent with `--force-with-lease` on the commit it replaces, so a forgotten version leaves
  the branch and two computers cannot overwrite each other. The privacy check is an unauthenticated read of GitHub's
  API: 404 lets the push go, an answer that says private lets it go, anything else (public, a rate limit, an outage, a
  redirect, Vector Local) refuses it. The repository must hold only the vault (a README alone is accepted). Commits
  skip signing and the person's hooks.
- **The CLI's vault key** lives in `<data>/vault/vault.json` (0600), sealed with `VECTOR_CREDENTIAL_KEY` when the
  desktop started the engine, as `auth.json` is; A45's desktop keeps its own in `safeStorage`. The file also holds the
  wrapped key, so switching backend needs no code.
- **Vector's backend takes a backup only while the status lists `vault`** and the plan's `vault.gb` is above 0 (H1);
  status, versions, restore and forget need only the sign-in, so a paused or ended plan can still restore during its
  read-only days (§4.4). The API enforces the quota and states (S1). Until A44 ships and the owner lists `vault`,
  `vector vault backup` works only with `--github`.

## A36 Playbooks server (4 Nov 2026)

- **New files outside A36's list.** `api/_lib/playbooks.ts` (the library in the store, its records, readiness and
  the signed links), `packages/schema/src/playbooks.ts` (names, versions, limits and the listing's decoder, shared
  with B07's client), `packages/core/src/playbooks/commands.ts` (the skill command allowlist) and `check.ts` (the
  publish check), `packages/core/test/playbooks/commands.test.ts`, and a readiness check for `playbooks` in
  `api/_lib/codium-perks.ts`. `docs/vector/MODEL-PLANS.md` gains a section.
- **The skill command allowlist is not on this branch.** It is the learned skills' `simple`, `helper` and `check`
  in self-evolving's `packages/core/src/brain/skill.ts` (Track B). `commands.ts` copies the three functions and their
  lists unchanged (only the secrets-file regex is imported directly from `brain/document/sniff.ts`), and its test runs
  BrainSkill's own command cases unchanged against the copy. When B01 merges this branch into Track B, `commands.ts`
  should become a re-export of BrainSkill's functions so there is one list.
- **"Every command in a playbook".** A playbook is a saved workflow, whose stages are prompts, so the commands it
  names are its code spans and the lines of its fenced blocks, in any string (object keys too). Each must pass the
  allowlist (a read-only helper or one check). A code span that is one relative path, not a secrets file and not a
  script to run (`.sh`, `.ps1`, `./x`…) counts as a repository file instead. A fenced block marked json, yaml, text,
  diff or markdown is data and is not read as commands; any other block (unmarked, a shell, a programming language)
  holds only allowed commands. Also refused anywhere: a template value (`{{…}}`) inside a command, `!` followed by a
  backtick, a backtick that does not open and close a span on one line, a fence left open, hidden characters, and a
  secret (by shape, name or wording, or a value of the publisher's own secret settings). Nesting is capped at 32.
  The workflow schema check is Track B's, once that schema is on this branch; it should also allow models only as
  Codium roles and nested stages only naming `vector-*` playbooks.
- **Store and bucket keys §4.6 does not list.** The library is one hash, `playbooks`, under the Codium prefix (field =
  name, value = the record). Files are at `playbooks/<name>/<version>.json` in `vector-media`, and at
  `playbooks/test/<name>/<version>.json` for the test store, so a test publish can never replace a live file. A record
  whose key is not exactly that path for its name, version and the server's mode is never listed or signed.
- **"Dark until Track B lists it"** is a 404 `NOT_FOUND` to every request (any method, with or without a sign-in)
  until `listedPerks()` has `playbooks`, checked before any sign-in, snapshot or rate counter is read. Listing it needs,
  besides `CODIUM_LISTED_PERKS`, `CODIUM_TRACK_B_LIVE=true` and the perk switch, a readiness check: the media bucket
  configured, the store configured and at least two playbooks published (`Playbooks.MINIMUM`). §1.2's "two proven"
  stays the owner's call; the check only keeps the perk from listing a smaller library.
- **The answer is the bare array** `[{name, version, sha256, url}]` the contract gives, with no other field; links
  live `Playbooks.LINK_SECONDS` (600). At most 50 playbooks (`Playbooks.MAX_LISTED`), sorted by name.
- **Who.** Any valid, unrevoked `vct_` account token (desktop, CLI or one pasted from `/auth/cli`), as A33 and A34
  take: S2 is about spending Codium, and a download spends none. Run tokens and website sessions get 401 (S3). The plan
  is `requireEntitlement(account, "playbooks")`, so §4.4's row holds: active and renewing download; paused, ended and
  frozen do not. 60 requests an hour per account; the contract names no limit.
- **Versions never change.** `publish` takes only a version above the published one, or the same version with the
  same file (a no-op). Before uploading it asks the bucket for the key (HEAD): the same file (R2's single-upload ETag is
  the file's MD5) is not uploaded again, and another file is refused, so even a withdrawn version cannot come back with
  other content. Two publishes of one playbook at the same moment are not guarded against; only the owner publishes.
- **Owner step:** `vector-media`'s lifecycle rules (§6.1, 30 and 90 days) must not cover `playbooks/`.
- **A36's dependency on A43** is not used: nothing here needs the Vault core. It builds on A37's `r2-presign.ts`.
- **Not built here:** the estimate API's `{kind: "playbook", id}` band (model-plan-estimate.ts already leaves
  playbooks to Track B) and every client piece (B07).

## P6 review decisions (4 Nov 2026)

- **A39/A40: tickets carry the plan's rank, not its viewer-hours.** §4.2 lists Remote's viewer-hours as a server-only
  limit ("not shipped to clients"), but A39 put `viewerHours` in the ticket's claims, and a ticket is plain base64url
  JSON that `POST /api/remote/ticket` hands to the desktop and the phone. A39's "device and fair-use caps from the
  ticket" now reads as: the ticket carries the public caps (`computers`, and `rank` from ENTITLEMENTS, which every
  status answer already shows), and the relay holds the viewer-hours itself, by rank (`VIEWER_HOURS` in
  `packages/relay/src/limits.ts`, Plus 1 to Ultra 4). `test/remote-relay-contract.test.ts` keeps that table equal to
  `REMOTE_LIMITS.viewerHours` plan by plan, and the API still refuses a plan with no viewer-hours entry. The relay's
  `RELAY_LIMITS.maxViewerHours` is gone with the claim. `AccountRelay` takes an optional fourth constructor argument,
  a viewer-hours table, which only the tests pass (the runtime calls it with `ctx` and `env`), so the fair-use cases
  can still use up a one-hour allowance.
- **A39: erase keeps two things that hold nothing about the account.** P5 asks that everything the relay object
  stored be deleted, but deleting the used ticket ids and the revocation time let a ticket from before the erasure
  register its device again. After `deleteAll()` the object keeps the unexpired `seen` ids (random ticket jti and
  internal nonces, gone when they expire) and `revoked_before` = the erasure time plus the 60 s ticket skew. The
  account handle is now written only once a ticket passes the standing check, so a refused ticket stores none.
- **A38/A41: alert copy.** The Settings and phone copy no longer say alerts never hold code or prompts: an alert's title
  carries the session's name, which starts as the first line of what was typed. The wording is in
  `PHONE_ALERT_CONTENT`, and a test ties it to `alertTitle`.

## A44 Vault API (4 Nov 2026)

- **Where the records live.** §4.6 lists no Vault keys and §6.1 names `brain-vault.sql`, so every Vault record is in
  Supabase, behind one invoker function (`public.vector_brain_vault(jsonb)`, `service_role` only, RLS on and no grants
  to `anon` or `authenticated`). Nothing is kept in Valkey except the rate counters. Accounts are an HMAC of the account
  id under `VECTOR_VAULT_ACCOUNT_SALT` (§4.16), in the rows and in the R2 keys
  (`<mode>/<account>/<vault>/{objects,versions}/<id>`); every row also carries the Stripe mode, so a test server never
  reads or deletes a live vault. The salt must never change.
- **Files outside A44's list:** `api/_lib/vault-api.ts` (the routes' plan rules; kept out of `vault-store.ts` because the
  `vault` provisioner imports the store, and an entitlement import there closes a cycle through model-plan-account.ts),
  `api/_lib/vault-meter.ts` (`meters.vault`, imported by `api/model-plans/status.ts` like A42's Remote meter),
  `api/_lib/codium-provisioners.ts` (the `vault` provisioner replaces its stub), `api/_lib/codium-perks.ts` (readiness),
  `vercel.json` (the 03:40 cron), `.env.example`, `packages/schema/src/vault.ts` (two error codes documented),
  `docs/vector/owner-actions/brain-vault.md`, `docs/vector/MODEL-PLANS.md`, `test/brain-vault-fixture.ts`, and one
  expectation in `packages/web/test/codium-configuration.test.ts`, which pinned "no vault cron yet"; it now pins the
  contract's `/api/vault/cleanup` at `40 3 * * *` and still no hosted or ops cron.
- **Atomic reservation.** One uploads request is one transaction that locks the vault's row, so parallel reservations
  queue. It is all or nothing: if the new bytes (or the vault's 2 million objects, or a version's 1 million) do not fit,
  402 `VAULT_QUOTA` and nothing is reserved, recorded or signed. The quota counts pending and stored blobs; blobs queued
  for deletion do not count, so forgetting a version frees its space at once. Re-declaring an object: stored is
  `present`; pending is signed again with no new reservation (a different size is 409 `VAULT_SIZE_MISMATCH`); queued for
  deletion is reserved again like a new object; a deletion in flight answers 503 `VAULT_UNAVAILABLE` (retry), so a
  delete can never remove a fresh upload of the same object.
- **Commit.** It HEADs every object of the version still pending (a superset of "what was signed for it", since a
  concurrent backup may have signed it) and the manifest, 32 at a time. Each object that arrives whole is stored at once,
  so a version too big to check within 40 seconds answers 503 and a rerun of the backup finds those objects present. A
  missing or resized object, and a declared count that differs from what the version names, answer 409
  `VAULT_SIZE_MISMATCH`; the bad objects are queued and deleted from R2 in the same request.
- **Read-only states (§4.4).** Paused, ended and frozen answer 409 `VAULT_READ_ONLY` (with `state`) to creating a vault,
  reserving and committing. Frozen gets the same code (§4.4 says "uploads frozen"); the A43 client's message names only
  paused and ended. An account being deleted gets 409 `MODEL_PLAN_ACCOUNT_CLOSING` for reads too. Renewing past the grace
  is 503 `MODEL_PLAN_RENEWING`, no plan 402, and a plan without Vault (Plus) 403 `CODIUM_PERK_REQUIRED {perk: "vault",
  plan: "vector-50"}`. Reads (the wrapped key, versions, signed downloads) and deletes (a version, the vault) need only
  the sign-in, whatever the plan, the listing and the `vault` switch, so data stored while Vault was listed can always be
  restored or deleted. Writes need `vault` listed and answer 503 `VAULT_UNAVAILABLE` before reading any sign-in
  otherwise. The `vault` switch therefore stops new backups only.
- **"Read-only 30 days with a notice, then deleted".** The 30 days count from the notice, not from the end of the plan,
  so a notice the outbox had to retry never shortens them. The `vault` provisioner emails it once (Resend, to the
  identity's email from Supabase's admin API, idempotency key per snapshot version) and only then records it; the cleanup
  deletes a vault only once a notice is recorded and its date has passed. An identity that is already gone gets no email
  and the notice is recorded. Without Resend the provisioner fails and the outbox retries, and `vault` cannot be listed:
  its readiness check requires the notice email. A plan that starts again before the date clears it; `none` after
  `ended` keeps the clock.
- **Frozen holds the vault.** The provisioner marks it held: the cleanup prunes nothing, collects nothing and never
  deletes it while held. Uploads that never committed are still swept, because they were never a backup.
- **Cleanup.** "Prunes versions over 30 days" uses the plan's `vault.versionDays` (30 on every plan), stored on the vault
  at each upload because the cleanup has no account ids; the newest committed version is always kept. "Sweeps
  uncommitted objects after 1 hour" counts from the version's last uploads request, and an object is swept only once no
  remaining version names it. It works a batch of 50 vaults at a time, each locked while it is cleaned (a busy one
  waits for the next day), within 50 seconds, and cleans its own Stripe mode only: Vercel runs crons on Production, so
  test vaults on a Preview are cleaned only by calling the route there.
- **Server-only limits** (not in ENTITLEMENTS): 60 committed versions per vault (402 `VAULT_QUOTA`), four backups in
  progress (429 `RATE_LIMITED`), 2 million objects per vault, 1 million per version, an object between 40 bytes and one
  raw chunk plus 40, a manifest up to 16 MiB plus 40, a version id within 24 hours behind and 1 hour ahead of the
  server's clock, links of 900 seconds. Rates per account and hour: 1200 reads, 1200 writes, 60 deletes. The quota is
  the plan's `vault.gb` in decimal gigabytes, as the CLI shows sizes.
- **Codes.** Besides §4.10's, `VAULT_UNAVAILABLE` 503 and `VAULT_REQUEST_INVALID` 400, now listed in
  `Vault.ERROR_CODES`. An upload to a committed version is 409 `VAULT_EXISTS`. `GET /api/vault/snapshots` without a
  vault is 404 `VAULT_NOT_FOUND`, which the A43 client reads as "holds nothing yet".
- **Not decided here:** an account that downgrades to Plus keeps its stored vault (read-only by 403, no deletion date),
  because §4.4 deletes only after a plan ends. The owner may want a lapse for that case too. (Decided in "P7 review
  decisions" below: it is a lapse.)

## A45 Desktop vault and Settings → Memory → Backup (4 Nov 2026)

- **Restore is in the desktop too, through two new engine routes.** A45's list names only the backup, but v3's item AC
  (which §0's precedence reads where the contract is silent) puts restore and "a list of versions, and delete" in
  Settings → Memory → Backup, and the desktop's brain is not the CLI's on macOS (the desktop's engine keeps its data in
  `<userData>/xdg-data`), so `vector vault restore` from a terminal cannot reach it. The desktop's main process cannot
  open brain.db (the engine is another process, on Windows possibly in WSL), so the engine gained two owner-only memory
  routes: `GET /memory/backup` (the backup's memory files, the person's own and each repository's, as export JSON) and
  `POST /memory/restore` (one memory file, at most 2 MB, put back through `BrainExport.restore` with `trust: "vault"`).
  Like every `/memory` route, a guest gets 403 (`isOwnerOnlyRoute`), and Remote's phone allowlist does not include
  them. The owner can already approve and pin entries through the memory API, so the restore route grants nothing new;
  the vault's own guarantee (only a backup opened with the vault key is restored) holds in the desktop, which decrypts.
  The CLI's memory collection and restore loop moved unchanged into `packages/engine/src/brain/vault-memory.ts`, which
  both use. The SDK was regenerated (additive: `memory.backup`, `memory.restore`); the client generator changed nothing.
- **Backup reads go through one route, not the export route per repository.** Reading each repository through
  `GET /memory/export?directory=<worktree>` would boot an engine instance per repository every night. The new route
  builds each repository's place from the project list as the CLI does.
- **Restore requests are cut on the desktop.** A memory file can pass the engine's 2 MB request limit, so the desktop
  sends each one without evidence and documents (a restore reads neither) in parts of at most 500 entries and about
  1.5 MB, each a valid export file. A part the engine cannot read (400) counts the file as needing a newer Vector.
- **"Vault key in safeStorage".** As A41 did for Remote's keys: the key record is sealed in-process with
  `vault-secrets.ts`, whose key the OS credential store holds through safeStorage and opens once per launch, and kept in
  the `vector-vault` store. Without a secure credential store (`vaultSecrets.available()` false) the desktop makes no
  vault and says why.
- **§4.15's `vault.enabled`, `vault.backend`, `vault.githubRepo` live in the main process's `vector-vault` store,** not
  the app settings, because the main process runs the nightly backup before any window opens (A41 did the same for
  `remote.enabled`). They are read and changed through `platform.vault`.
- **The desktop's vault is its own.** A43 left open whether the desktop and the CLI share one key. The CLI's file is in
  its own data folder, and the desktop's terminal does not pass `VECTOR_CREDENTIAL_KEY` to its children, so neither can
  open the other's sealed key. They stay separate; a store holding the other's vault refuses a backup ("holds another
  vault"), and restoring that vault with its recovery code makes it the one that computer or CLI backs up to.
- **"Nightly while the app is open".** Checked every 15 minutes (first 3 minutes after launch): due from 02:00 to before
  06:00 local time when the last backup is 20 hours old and the last attempt an hour old, or at any hour once the last
  backup is 36 hours old and the last attempt 6 hours old (a computer asleep at night). The nightly run never creates a
  vault, because the recovery code must be shown to the person; Back up now does, and answers the code once, even if the
  backup itself then fails, so a vault never exists without its code having been shown.
- **"Warns on total repo size above 1 GB".** The size is the vault's blobs in the branch's tree (`list().storedBytes`)
  after each backup, compared with 1,000,000,000 bytes; history GitHub keeps after a forced push is not counted.
- **git in the desktop.** The store is core's (A43). The desktop runs `git` from PATH with the person's own credentials
  (`GIT_TERMINAL_PROMPT=0`, Vector's own secrets left out by `untrustedChildEnvironment`), a 10-minute limit per command,
  and decides `ls-remote`, `fetch` and `push` as `git-remote` on the remote's host before git starts; with Web access
  None it sets `GIT_ALLOW_PROTOCOL=file`. The desktop's GitHub sign-in is not used for these pushes. `git-remote` and
  `brain-vault` now list the desktop as a call site; `brain-vault` lost its `planned` entries.
- **Vector's backend.** Offered in Settings only while the account's status lists `vault` with `vault.gb` above 0 (H1),
  or while it is already the chosen backend so the person can move off it. A backup to it reads the status first and
  refuses without it; the Vault API decides anyway (S1). Its numbers on the page (GB, days of versions) come from the
  status's entitlements; the GitHub copy takes "7" from `Vault.LIMIT.githubVersions`.
- **Files outside A45's list:** `packages/desktop/src/main/vault-runtime.ts` (Electron wiring, like A41's
  remote-runtime.ts), the IPC handlers, preload and renderer wiring, `packages/desktop/src/main/index.ts`, the app's
  `platform.tsx`, `memory-backup-model.ts`, `memory-backup.tsx`, the Memory page's tab list (`memory.tsx`,
  `memory-model.ts`'s `MemoryTab` type; `MEMORY_TABS` itself is unchanged and the tab is added only where
  `platform.vault` exists), `settings-memory.css`, the Memory item's search keywords, `packages/core/src/local-mode/sources.ts`,
  the engine routes and their exerciser entries, `packages/engine/src/brain/vault-memory.ts`, the CLI refactor, the
  regenerated SDK, `docs/vector/MODEL-PLANS.md` and `owner-actions/brain-vault.md`.
- **A test expectation outside A45:** `packages/app/src/features/local/local-model.test.ts` already failed before this
  work ("every source in the registry has a name of its own" did not hold for A43's `brain-vault`). The source now has
  its name, "Brain Vault", in `local-model.ts`; no expectation changed.

## A46 Ops Worker (4 Nov 2026)

- **The Worker's interface is defined here,** because A47 and A48, which call it, are not built. `packages/ops-worker/src/protocol.ts`
  (no imports, so the API can import its types) holds it. The API calls `POST /internal/v1/<action>` with A37's HMAC
  under the `ops` key: `plan`, `config`, `release`, `state`, `suspend`, `erase`, `flags`. The Worker reports to
  `POST <API_ORIGIN>/api/ops/worker`, signed the same way, with `{v:1, account, events}`; the events are `monitor.down`,
  `monitor.up`, `release.regressed` and `release.passed`. A48 builds that route with `requireInternalRequest("ops", …)`
  and must dedupe by event id, because a report is sent again with the same ids until it gets a 2xx.
- **"Pushed snapshot with validUntil = periodEnd + 24 h"** is the `plan` action. It carries only the snapshot's version, the
  plan's private ops caps (domains, `onCall {urls, intervalSec}`, `releaseGuard {perDay, watchMin, paths}`) and
  `validUntil`, never the snapshot itself. The API maps §4.4: `onCall: null` stops checks (frozen, ended), `releaseGuard:
  null` stops new watches (paused), and a `validUntil` at or before now stops everything at once. A plan with a lower
  version than the stored one is ignored. Plans outside any real plan's bounds are refused, and so is a `validUntil` more
  than 40 days ahead. `test/ops-worker-contract.test.ts` checks that every ENTITLEMENTS plan passes as it is.
- **Worker settings the contract does not name:** the secrets `INTERNAL_SECRET` (the value of `VECTOR_OPS_SHARED_SECRET`)
  and `ACCOUNT_KEY` (the HMAC key behind `idFromName`, kept separate so rotating the shared secret never resets
  accounts), and the plain variable `API_ORIGIN` (`https://vectordev.ai` in `wrangler.jsonc`). Unlike the relay, the
  object keeps the account id, because its reports must name the account; the object's name is still the HMAC.
- **"Verified hostnames only"** is read as an exact match, with no subdomain and no parent, against the domains the
  account verified (A47 sends them in `config`). The plan's domain cap takes the first `domains` in verification order,
  and its URL cap takes the first `onCall.urls` monitors (in the order added) whose host is one of those domains. A
  monitor past either cap is kept but not checked, so a downgrade keeps the earliest.
- **S8 on a Worker.** A Worker cannot connect to an address it chose, so the Worker cannot pin the address it checked.
  - Host names are checked as safe-fetch.ts does: no IP literal in any spelling, no private names, plus `.invalid`,
    `.test` and `.example`.
  - Every address is looked up over DNS-over-HTTPS (`cloudflare-dns.com`, A and AAAA) before the probe; one non-public
    address refuses the host.
  - Answers are reused for their TTL, 60 s to 5 minutes. A refused host is inconclusive (`address`): never probed and
    never reported down. A name with no address is a failure (`dns`). A lookup that failed is inconclusive (`resolver`).
  - Cloudflare's own fetch also refuses prohibited addresses; the lookup makes the rule explicit.
  - The address rules match safe-fetch.ts; the root contract test compares the two.
- **"No redirects (a cross-domain redirect fails)":** a redirect is never followed. A 3xx whose Location resolves to the
  probed URL's own origin counts as up. A 3xx to another host, scheme or port, or with no usable Location, is a failure.
- **"Challenge pages"** are recognised by `cf-mitigated: challenge`, `x-vercel-mitigated: challenge` or
  `x-amzn-waf-action: challenge|captcha` on any status, or by challenge markers in the first 8 KiB of a 5xx HTML page.
  Other bodies are cancelled unread.
- **Up and down.** Two failures in a row make a URL down. Inconclusive answers neither count nor break a run of failures.
  One conclusive success makes a down URL up again, because the contract names no rule for recovery. A report goes out
  only on going down and on coming back up. Probes send `cache-control: no-cache` and no `cache` fetch option, which
  needs a compatibility flag: a wrong guess there would make every probe throw and report a false outage.
- **Release watch readings.**
  - The comparison is with the stored results of the last good release (the paths that passed when its watch ended),
    not a live probe of the old deployment, whose own URL is not a verified host.
  - A regression is a path that passed on the last good release and now fails twice in a row. The first release watched
    has no baseline and cannot regress; it becomes the baseline.
  - A watch that saw no conclusive answer ends `stopped` with no verdict and leaves the baseline alone. A passing watch
    keeps the earlier passes for paths it could not check.
  - "Waits 60 s after success" counts from the deployment's reported time. A late report starts at once; a time ahead of
    the clock starts at most 60 s from now. The first round is never pulled early into another wake.
  - Any newer deployment of the same repository and environment ends the running watch (`superseded`), even one that is
    not watched itself (a repeated sha or the daily cap). An older deployment reported late is not watched, and a report
    more than a day old is `stale`.
  - The Worker also enforces the plan's releases a day (A48 checks it first), after the dedupe. A release refused for the
    cap or for having no verified URL is recorded as `skipped`, so a repeat of it is a duplicate.
- **"Alarms at the next due time, always at least 25 s ahead, capped wakes per hour".** One alarm per account. Work due
  within 25 s of a wake is done in that wake, so checks and watch rounds share wakes. Wakes are capped at 125 per clock
  hour: an Ultra account with checks every minute and a watch every 30 s needs 120. Past the cap the next alarm waits for
  the next hour. While the kill flag is set, an account with work re-reads it every 10 minutes and does nothing else.
- **"Stores state changes and hourly totals only".** Each wake writes one row of running state: streaks, due times, the
  hour's counters and DNS answers, as JSON in `meta`. Besides that, storage holds a row per state change, a row per
  monitor-hour, release records, the last good release per repository and environment, undelivered reports (at most 200,
  for at most a day) and seen nonces. Changes, totals and finished releases are deleted after 30 days. `state` answers
  monitor ids, never URLs.
- **Reports** go out in batches of at most 20 events. A failed delivery is retried after 30 s, doubling to an hour, and
  dropped after a day. A redirect from the API is not a delivery. Without `API_ORIGIN`, reports wait, and no alarm is
  set just for them.
- **Delete** is the `erase` action, for A57, named as in the relay. Everything goes except the nonces already used and the
  erasure time. A write signed at or before the erasure gets 409 `OPS_ERASED`, so a delayed call cannot fill the object
  again. A later account with the same id starts clean.
- **`suspend {account, suspended, reason: "guard" | "owner", at}`** is added for A50's guard ("pause only accounts above
  their own expected usage"). It is ordered by `at` and kept apart from `plan`, so a plan push from the snapshot cannot
  undo a guard hold.
- **"Miniflare in CI"** is done in two parts.
  - Here: unit tests drive the Worker and the object on an in-memory runtime whose SQL runs on a real SQLite engine.
    They cover intervals per plan, the in-flight cap, the two-failure rule, validUntil, the kill flag and delete.
  - In CI: `e2e/ops-smoke.mjs` runs the deploy dry run's own bundle under miniflare, loaded from beside wrangler, so
    there is no new dependency. Every outbound request (sites, DNS-over-HTTPS, the API) is answered locally, and alarms
    run in real time (about three minutes).
  - It runs in a new `ops-worker` job of `vector-codium.yml` after `wrangler deploy --dry-run`. Running miniflare on
    the owner's Mac is forbidden; the dry run itself was run here once.
- **No `@cloudflare/workers-types`:** `src/runtime.ts` declares the subset used, as in the relay.
- **`wrangler.jsonc`:** `vector-ops`, `OpsAccount` with a `new_sqlite_classes` migration, a zero KV id for `OPS_FLAGS`
  (the owner replaces it; a deploy carrying it fails), `workers_dev`, compatibility date 2025-04-01, and `API_ORIGIN`.
- **`bun.lock`** gains the `packages/ops-worker` workspace entry only; no package version changed.
- **Files outside A46's list:**
  - Ops Worker package: `src/{runtime,bytes,limits,protocol}.ts`, `e2e/ops-smoke.mjs`, `package.json`, `tsconfig.json`,
    `.gitignore`.
  - Root test: `test/ops-worker-contract.test.ts`.
  - `.github/workflows/vector-codium.yml`, `bun.lock`.
  - Docs: `docs/vector/MODEL-PLANS.md` and `docs/vector/owner-actions/hosted-ops.md` (new; only the Worker's section, since
    A47 to A50 add theirs).

## A47 GitHub webhook router and ops settings (4 Nov 2026)

- **The handler shape is Codex's** (vector-at-mention spec 2.14): `{id, events, handle({name, action?, deliveryId,
  payload})}`, defined in `api/_lib/github-webhook.ts`. The route keeps a static list (`GITHUB_WEBHOOK_HANDLERS` in
  `api/github/webhook.ts`) with Codium's `ops` handler. A47 landed first, so the integration commit (A59) adds Codex's
  `cloudAgentsWebhookHandler` (one import and one entry), as 2.14's second-lander rule says. A handler naming an event
  the App does not subscribe to (`installation`, `installation_repositories`, `repository`, `pull_request`,
  `deployment_status`) is refused when the route loads.
- **Order.** The contract lists "verify signature, dedupe by `x-github-delivery`, filter event types before any store
  read". The dedupe is a store write, so the filter runs before it: signature, then filter (a `ping`, or an event no
  handler named, answers 200 with nothing parsed or stored), then dedupe, then the handlers.
- **Dedupe.** A delivery is marked pending (SET NX, 60 s) and done (7 days) once every handler finished. A copy that
  arrives while one runs gets 409 `GITHUB_DELIVERY_IN_PROGRESS` (retry-after 60); a finished one answers
  `{ok:true, duplicate:true}`. When a handler fails, the mark is deleted and the answer is 500, so a redelivery runs every
  handler again; GitHub never redelivers by itself. Each handler gets its own parse of the payload and 8 s.
- **A repository's owner is its binding.** "Production environment per repo config" names no source for who owns a
  repository. The ops handler and `/api/ops/repos` use Codex's binding (`bindingFor`, one account per repository id,
  §4.18), through `registerRepoBindingReader` in `api/_lib/ops-settings.ts`, which A59 wires to `bindingFor`. This build
  never imports Codex's files. Until A59 no repository is bound, so none can be set up and no deployment or pull request
  is acted on. A suspended binding (transferred, deleted, binder left) counts as unbound.
- **Repository settings live on the server** (`/api/ops/repos`): the deployment environment Release Guard watches, the
  production URL, up to 5 paths (and the plan's path count), and the Release Guard and Ship Desk switches. The answer
  includes the `.vector/ops.json` to commit, with the account's `opsId` (random, `ops_` + 22 base64url characters, made
  with the account's first settings). The server does not read `.vector/ops.json` here: that needs App credentials, which
  are A48's (`github-app-server.ts`), and S9 has A48 re-read the file before every write.
- **`deployment_status` → Release Guard** calls the ops Worker's `release` directly: action `created` (or none), state
  `success`, not a transient environment, the environment equal to the settings' without case, Release Guard on, a usable
  snapshot with `caps.ops.releaseGuard` (active or renewing within grace; read from the snapshot alone, no reconcile on
  this path), the ops services configured and the `ops` switch on. The URLs are the production URL joined with each path,
  on domains verified now, at most the plan's paths; none verified starts nothing. `at` is the status's `created_at`. The
  Worker dedupes by (repository, environment, sha) and counts the plan's releases a day; A48 adds the `.vector/ops.json`
  check and the API-side daily cap ("dedupe before increment"). Ignored deliveries are never errors; the store or the
  Worker being unreachable fails the delivery.
- **`pull_request` → Ship Desk** applies the contract's filter: the author is the App's bot (`<VECTOR_GITHUB_APP_SLUG>[bot]`,
  type Bot) and both head and base are the repository itself. Actions passed on: opened, reopened, synchronize,
  ready_for_review, closed. It goes to an intake A49 registers (`registerShipDeskIntake`), which checks the plan and counts
  cards; until then it is ignored. Codex's spec says Vector's pull requests are authored by `github-actions[bot]` by
  default (only App publishing gives the App bot). A49 must decide whether to widen the filter (Codex suggests the
  `<!-- vector:rid … -->` marker plus a matching run record); A47 keeps the contract's App-bot rule.
- **Removals.** `installation.deleted`, `installation_repositories.removed`, and also `repository.deleted` and
  `repository.transferred`, drop those repositories' settings from every account that has them (a previous binder's
  settings included). Two index sets make that complete: `ops:repo:<repositoryId>` and
  `ops:installation:<installationId>` (for an uninstall whose payload lists no repositories). The installation comes from
  the binding when it has one, or from the first delivery that names it. Domains and monitors stay: they are the
  account's, not the repository's.
- **Domain verification.** The TXT record is `_vector-verify.<domain>` with the value `vector-verify=<token>` (a split
  record is joined); the file is `https://<domain>/.well-known/vector-verify.txt` with that line. The TXT record is read
  over Cloudflare's DNS-over-HTTPS (the Worker's resolver); the file through safeFetch (S8). Either verifies. Both
  answering without the token is "failed"; a redirect, an oversized file or a private address counts as an answer
  without it. A timeout, a resolver failure, 401, 403, 429 or 5xx is "inconclusive" and changes nothing. Domain names
  follow the Worker's own rules (`validHostname`); the root test compares them.
- **"Re-verified weekly"** is a check 7 days after the last success. An inconclusive re-check is retried daily, and
  verification lapses 14 days after the last success whatever the re-checks said. A failed re-check ends it at once (the
  domain shows `lost` and can be checked again on request). It runs in the daily `/api/ops/domains` job (contract §4.19,
  04:10 UTC), which A47 adds to `vercel.json`; A50 adds its certificate, expiry and DNS drift checks to the same job. The
  job reads a sorted set, `ops:domains:due`, so it touches only accounts with something due. The configuration test's
  "no ops crons yet" expectation now expects this one.
- **Counts.** Domains (pending or verified) count against `caps.ops.onCall.domains`, the only domain count in
  ENTITLEMENTS; Release Guard uses the same verified domains. Monitors count against `caps.ops.onCall.urls` and must be on
  a domain verified now. After a downgrade nothing is deleted: answers mark what is past the plan's counts, and the Worker
  checks the earliest (A46). Removing a domain removes the monitors on it. At most 20 repositories per account
  (server-only).
- **Routes.** Any unrevoked `vct_` account token or a website session; run tokens get 401 (S3). Writes accept the site,
  the phone app's origin and no origin. Adding needs the ops services (`VECTOR_OPS_ENABLED=true`, `VECTOR_OPS_WORKER_URL`,
  `VECTOR_OPS_SHARED_SECRET`; else 503 `OPS_UNAVAILABLE`), the `ops` switch (503 `OPS_PAUSED`) and
  `requireEntitlement(account, "ops")`; reading and removing work whatever the plan. Limits per account an hour: 240 reads,
  60 writes, 20 checks. New codes: `OPS_UNAVAILABLE`, `OPS_INVALID`, `OPS_NOT_FOUND`, `OPS_REPO_NOT_BOUND`, `OPS_BUSY`,
  `OPS_SETTINGS_UNREADABLE`, `GITHUB_WEBHOOK_UNAVAILABLE`, `GITHUB_WEBHOOK_SIGNATURE_INVALID`, `GITHUB_WEBHOOK_INVALID`,
  `GITHUB_WEBHOOK_FAILED`, `GITHUB_DELIVERY_IN_PROGRESS`. `OPS_LIMIT` carries `{limit, max}`, `OPS_DOMAIN_UNVERIFIED`
  `{domain}`.
- **Store keys not in §4.6,** all under the Codium prefix: `ops:settings:<account>` (one JSON document, changed only by a
  compare-and-set script that also keeps the index sets and the due set), `ops:repo:<repositoryId>`,
  `ops:installation:<installationId>`, `ops:domains:due` and `github:delivery:<deliveryId>`.
- **The Worker's copy.** After every change the verified domains (in verification order) and every monitor go to the
  Worker's `config` when its hash differs from the last copy the Worker took. A change it missed is sent by the next
  write or by the daily job (the account is due 15 minutes later). An account that never sent anything and has only
  repositories sends nothing.
- **The owner's `ops` switch** also sets the Worker's kill flag (A46 left this to A47 or A50), as the `remote` switch does
  for the relay: `{worker: "updated" | "failed" | "not-configured"}`.
- **Not built here:** the ops provisioner (`plan` pushes from the snapshot) and the `on-call` and `release-guard`
  readiness checks in `perkServices`, since On Call and Release Guard do nothing useful before A48's report intake,
  incidents and revert PRs; A48 or A50 adds them. Until a plan is pushed, the Worker answers `release` with
  `not-in-plan` and checks nothing. A57 must call `eraseAccountOpsSettings(account)` (both Stripe modes).
- **Files outside A47's list:** `api/_lib/ops-worker.ts` (the Worker client), `ops-settings.ts` (the store, bindings and
  sync), `ops-domains.ts` (verification), `ops-api.ts` (what the routes do), `codium-owner-api.ts` (the switch),
  `vercel.json` (the cron), `.env.example`, `docs/vector/MODEL-PLANS.md`, `docs/vector/owner-actions/hosted-ops.md`, the
  test fixture `test/ops-fixture.ts` and the expectation in `packages/web/test/codium-configuration.test.ts`.

## A48 Release Guard and incidents (4 Nov 2026)

- **Files outside A48's list:** `api/_lib/ops-incidents.ts` (incidents, the Worker's reports, snooze, Fix it, erasure),
  `api/_lib/ops-records.ts` (the four store scripts), `api/_lib/codium-provisioners.ts` (the `ops` provisioner),
  `api/_lib/ops-worker.ts` (`opsPlanFor`), `api/_lib/github-webhook-handlers/ops.ts` (the deployment path now calls the
  intake), the test fixture `test/ops-fixture.ts` (a fake GitHub API, the App's settings with a key made in memory per run,
  the scripts as TypeScript, a Worker clock driver), one setup line in `test/github-webhook.test.ts` (`ready()` commits
  the repository's `.vector/ops.json`; no expectation changed), `docs/vector/MODEL-PLANS.md` and
  `docs/vector/owner-actions/hosted-ops.md`.
- **"One-repo installation tokens for revert only".** The contract also asks the intake to check `.vector/ops.json`,
  which needs a token. `github-app-server.ts` therefore mints two kinds, both for exactly one repository id: `check`
  (Contents and Metadata: read; the intake's opt-in read) and `revert` (Contents and Pull requests: write, Metadata: read;
  the only token that can write, minted only by the revert path). Each token's granted permissions must equal what was
  asked and it must see only that repository (as `github-app.ts` checks for the Actions exchange); it never leaves the
  module; it is revoked in `finally`. "Audited": an entry is written to `ops:audit:<account>` before the mint (a store that
  cannot be reached means no token) and completed after the revoke with what it wrote and whether the revoke worked; no
  token value is stored. The App is read through `githubAppConfiguration`, so it works only where `VERCEL_ENV` is
  `production` or unset, as the existing exchange does.
- **Intake order.** A47's checks first (binding, settings, Release Guard on, environment, ops service and switch, a usable
  snapshot with `caps.ops.releaseGuard`, URLs on verified domains), then: a release already recorded is a duplicate (no
  token, no count); the opt-in at the deployed commit (`opsId`, `releaseGuard: true`, the same environment without case);
  then one script claims the release and counts it against the plan's releases a day (dedupe before increment); then the
  Worker. The Worker unreachable gives the claim and the count back (the delivery fails and can be redelivered); a Worker
  refusal (its own duplicate, `not-in-plan`, a stale report…) is not counted and is recorded skipped. A claim not yet
  answered is held 10 minutes, so a function cut off mid-way does not make the release a duplicate for weeks. GitHub
  unreachable at the intake fails the delivery with 503 `GITHUB_UNAVAILABLE`; GitHub does not redeliver on its own (the
  owner or the account can redeliver from the App's settings). The API answers its own duplicates and daily cap in the
  Worker's `ReleaseAnswer` shape, so A47's test expectations stand.
- **The revert runs inside the Worker's report.** The Worker resends a report until it gets a 2xx with the same event ids
  (A46), so it is the retry engine: GitHub unreachable during a revert answers 503 and the resend tries again. One claim per
  repository, environment and sha (`ops:rg:<account>:revert:…`, 35 days) holds the outcome; a try holds it for 2 minutes
  (another try meanwhile gets 503 `OPS_REVERT_IN_PROGRESS`), and after 8 tries against an unavailable GitHub the revert is
  left to the person (`github-unavailable`) and the report is taken. The Worker gives up on a callback after 10 s; a slower
  revert is finished by the first try and the resend then finds it.
- **"Exactly one merged pull request".** The deployed sha is the `merge_commit_sha` of a merged pull request into the same
  repository (from GitHub's commit-to-pulls API), and the range from the last good release is only that pull request: one
  commit (squash), as many commits as the pull request had (rebase), or a merge commit whose first parent is the last good
  release. Then GraphQL `revertPullRequest`. Otherwise a restore commit (the good release's tree, parent the deployed sha) on
  `vector/revert-<sha12>` with a pull request, targeting the deployment's branch when its `ref` names one, else the default
  branch, only while that branch's head is the deployed sha (`head-moved` otherwise). A range that is not "ahead" of the good
  release is never written (`range`).
- **Workflow files.** Any file in the range whose name or old name starts with `.github/workflows/` stops every write. The
  compare API lists at most 300 files; a range that reaches 300 counts as possibly holding one.
- **"Re-read before every write"** is read literally: `.vector/ops.json` on the target branch is read again before each
  mutating call (the restore commit, its branch, the pull request, the GraphQL revert). Gone at any of them, nothing more
  is written (`opt-in`).
- **One pull request, ever.** Before opening, an open pull request from an earlier try is looked for and reused: GitHub's
  `revert-<number>-<head branch>` for the GraphQL path, `vector/revert-<sha12>` for a restore. A `vector/revert-…` branch
  that holds anything but the same restore is never touched (`branch-exists`).
- **The card.** The commits the revert undoes (newest first, 50 at most, first line of each message), the total, and
  migration paths: names under `migrations/`, `migration/`, `migrate/`, `alembic/`, `flyway/`, `liquibase/`, `drizzle/`,
  `schema.prisma` and `*.sql`. The pull request body names the failing paths (no host), the commits, the migration warning
  and that Vector never merges; no plan, usage or Codium wording (P6). Undo is the pull request (merged in GitHub, or in the
  desktop with the person's own sign-in, A50), or "open in GitHub" (the merged pull request, or the comparison) and the
  host's rollback link: the deployment status's `log_url`, else `target_url`, https only, from the last good release's
  record, named `vercel`, `netlify` or `host`.
- **Snooze** covers the incident's subject: one monitor, or one repository and environment. 1 to 24 whole hours. While it
  runs, new incidents for it are recorded with no alert and, for Release Guard, no automatic revert (Undo shows
  `snoozed` with the manual links). `{action: "unsnooze"}` ends it early.
- **Fix it.** `registerOpsRunStarter` takes Codex's `startCloudRun` at A59 (`(trigger) => {id, url?}`); until then 503
  `OPS_FIX_UNAVAILABLE`. The trigger is `{source: "ops", account, target: {kind: "github-run", repositoryId}, prompt,
  criteria, purpose: "incident"}`. It needs the ops service and switch and `requireEntitlement(account, "ops")` (paused is
  refused: "fix runs off"), counts against `caps.ops.onCall.fixRunsPerDay` per UTC day for every incident (Release Guard's
  too: the contract names no other fix-run count), one per incident (dedupe before increment), in a repository in the
  account's ops settings and still bound to it. A monitor's incident uses the repository whose production URL is on the
  failing host when exactly one is (else 400 `OPS_FIX_REPOSITORY`). A start that fails gives its claim and count back.
- **Alerts.** One per incident, titles only, at most 120 characters (a plain title replaces one that would be longer),
  tags `on-call` and `release-guard` (the phone's tags are lower case). On Call sends while a payment is retried
  (`allowPaused`); Release Guard does not. A recovery is announced only when the failure was. When GitHub cannot be
  reached during a revert, the alert goes out first with a neutral title and is not repeated. `handleOpsReport` takes an
  alert sender (default `sendServerAlert`) so the tests can see each one.
- **The `ops` provisioner is built here** (A46 and A47 left it to A48 or A50, and without it the Worker never holds a plan):
  active and renewing push the plan's On Call and Release Guard caps until `periodEnd + 24 h`; paused keeps On Call
  (`releaseGuard: null`) until the push plus 35 days (the Worker refuses more than 40 days ahead; ended or recovered
  snapshots replace it sooner); ended, frozen, no plan or a plan without ops push nothing from now. Unlike A46's note, the
  caps are not cut to the listed perks: the listing can change with a redeploy while no snapshot changes, and the Worker
  checks only what the account set up, which the screens show only when listed (H1). An account that never had ops caps is
  not called. Account deletion (`closing`) erases the Worker's data, the ops settings and every ops record.
- **Not added: the `on-call` and `release-guard` readiness checks.** Nobody can set either up before A50's screens, and a
  listing must not promise that. Recommended for A50: `opsConfigured()` for both, and `githubServerConfigured()` for
  Release Guard (the App gate is already in `listedPerks`).
- **Store keys not in §4.6** (Codium prefix): `ops:rg:<account>:<repositoryId>:<environment hash>:<sha>` (release
  records), `ops:rg:<account>:index`, `ops:rg:<account>:day:<date>`, `ops:rg:<account>:revert:<repositoryId>:<environment
  hash>:<sha>`, `ops:incident:<account>:<id>`, `ops:incident:<account>:index`, `ops:incident:<account>:snooze:<hash>`,
  `ops:incident:<account>:<id>:fix`, `ops:incident:<account>:fixes:<date>`, `ops:event:<account>` (event ids taken, one
  sorted set per account so they are erased with it) and `ops:audit:<account>`. Environments are hashed in keys because
  GitHub names them freely.
- **New error codes:** `GITHUB_UNAVAILABLE` 503, `OPS_REVERT_IN_PROGRESS` 503, `OPS_REPORT_INVALID` 400,
  `OPS_REPORT_UNFINISHED` 503, `OPS_RECORDS_UNAVAILABLE` 503, `OPS_FIX_UNAVAILABLE` 503, `OPS_FIX_STARTED` 409,
  `OPS_FIX_REPOSITORY` 400. Reused: `OPS_LIMIT {limit: "fix-runs", max}`, `OPS_NOT_FOUND`, `OPS_INVALID`,
  `OPS_REPO_NOT_BOUND`, `OPS_BUSY`, `CODIUM_PERK_REQUIRED`.
- **Routes.** `/api/ops/incidents` (GET; POST snooze, unsnooze, fix) and `GET /api/ops/releases` take an unrevoked `vct_`
  token or a website session (run tokens 401), 240 reads and 60 writes an hour per account. The releases list carries no
  URLs, only how many paths were watched; a watch past its end with no verdict shows `ended`. `POST /api/ops/worker` takes
  only the Worker's signed reports (`bodyParser: false`); a malformed or unknown event is skipped rather than blocking the
  rest of the report forever.

## A49 Ship Desk and capture (4 Nov 2026)

- **`github-actions[bot]` pull requests are taken too, with the run's record.** The contract says "cards from
  App-bot-authored same-repo PRs". Vector's GitHub agent publishes with `GITHUB_TOKEN` by default (vector-at-mention
  spec O14 and its note to A49), so its pull requests are `github-actions[bot]`'s and the App-bot filter alone would
  cover only repositories that opted in to App publishing. A47 left the filter to A49. The webhook handler now also
  passes a same-repository pull request by `github-actions[bot]` that carries the run marker `<!-- vector:rid <rid> -->`;
  the intake makes a card of it only when Codex's run record (the reader A59 registers, now in
  `api/_lib/cloud-run-reader.ts`) lists that run for the same account with the same repository id. Anyone with write
  access can act as `github-actions[bot]`, so a marker alone is never enough; the App's bot cannot be acted as, so its
  pull requests need the marker of a run in that repository but not the record. Each run makes at most one card, which
  also bounds how many cards a forged marker could use. Release Guard's revert pull requests (App bot, no marker) make
  no card. Before A59 only App-bot pull requests can make cards.
- **Where the capture ticket comes from.** The contract names the ticket (one pull request, at most 8 files, 15 minutes)
  but not who issues it. The capture job holds no `id-token` and no run token, so the run's own token asks for it:
  `POST /api/ops/uploads {action: "ticket"}` with `Bearer vrt_…`, verified by the registered run verifier
  (`requireModelPlanCaller`, so the account's revocation is checked). This is the only ops request a run token is
  accepted for, and it can only ask for a ticket (S3: a run token reaches its own service's endpoints). The run id
  (`gh-<repositoryId>-…`, vector-at-mention spec 2.x) names the repository, which must be bound to the account with Ship
  Desk on, under a plan with Ship Desk now. A new subcommand, `vector ship ticket`, does this from the run token's file
  (`$RUNNER_TEMP/vector-secrets/run-token`) and writes `capture=<ticket>` to `$GITHUB_OUTPUT`; Codex's V31 adds it to the
  agent job right after the mint, before any checkout, and passes `needs.agent.outputs.capture` to the capture job. The
  output is not masked (GitHub drops a masked output); the ticket's power is the point: the capture job's own code can
  read it anyway.
- **"15 min" is the capture window, from the ticket's first upload.** A ticket is asked for at the start of the run, which
  may last two hours before the pull request exists. So a ticket must be first used before the run's deadline plus an
  hour (at most 4 hours after it was issued), and its uploads then start and finish within 15 minutes of that first use.
  `{action: "card"}` (what to capture) starts nothing. A start again before finishing replaces the pending capture; a
  finished ticket takes no more.
- **"One PR" is the run's pull request.** A ticket names a run, and a card holds one run (the newest one checked: a later
  run on the same pull request, the agent pushing to its own branch, moves the card to it once no other card holds that
  run). A ticket uploads only to the card whose run is its own, of an open pull request.
- **"Served nosniff, sandbox CSP, no-store, owner-only signed GETs from R2".** R2's S3 address can sign the response's
  type, cache control and disposition, but cannot send `X-Content-Type-Options` or a CSP. The image route
  (`GET /api/ops/image/<card>/<n>`, the card's own account only) answers JSON with a 60-second signed link that pins the
  stored image type, `no-store, private` and `attachment`, and carries `nosniff`, `default-src 'none'; sandbox` and
  `no-store` itself. The bytes were checked to be PNG or WebP by signature before the card showed them, and an image
  never reaches a browser under any other type. Proxying the bytes through a Function would add both headers, but
  Appendix A item 6 moved images to R2 precisely so that reads do not pass through a Function. `presignR2` gained
  `response` overrides for GETs.
- **The file signature check runs after the upload.** Uploads go straight to R2 through links that sign the exact size
  and the declared type, so the server never sees the bytes on the way in. `finish` reads each object back with HEAD (the
  size) and a ranged GET of its first 64 bytes (PNG's signature and IHDR, or WebP's RIFF/WEBP and VP8/VP8L/VP8X header,
  with sane dimensions, and the type that was declared). Anything else is deleted and never shown.
- **Checks and verdict refresh when a card is opened.** The App is not subscribed to check events (A47's five events), so
  the card reads the head's check runs at creation and again when the card is opened (`GET /api/ops/cards?id=`) while
  the pull request is open and some are still running or none were found, at most once a minute and only while the
  plan allows Ship Desk now. The verdict is read from the run record until the run ended. A list read asks GitHub
  nothing.
- **A read-only `ship` App token.** `GITHUB_SERVER_PERMISSIONS.ship` is Checks, Contents and Metadata: read, minted for one
  repository, revoked after use and audited (A48's `withRepositoryToken`). The App's baseline already has Checks: read.
- **The opt-in is checked for Ship Desk too.** §4.15 lists `shipDesk` in `.vector/ops.json`. A card needs the file on the
  pull request's base branch to name the account's `opsId` with `shipDesk: true`, as Release Guard's intake does for its
  own flag, although Ship Desk writes nothing to the repository.
- **Phone alert on a new card.** One title-only alert per card ("<repository> #<n> is ready on Ship Desk", tag
  `ship-desk`), not while paused (no new cards then). The contract's §1.2 ties Ship Desk to phone alerts being listed;
  A38's note expected server alerts from Ship Desk.
- **Keys not in §4.6** (Codium prefix, all under the listed `ops:card:*` and `ops:cards:*`): `ops:card:<account>:<card>`,
  `ops:cards:<account>`, `ops:card:<account>:run:<rid>`, `ops:card:<account>:<card>:refresh`,
  `ops:card:<account>:tickets` and `ops:card:ticket:<sha-256>`. Card ids are a hash of (repository id, number). Images
  are in `vector-media` under `ship-desk/<mode>/k<keepDays>/<account hash>/<card>/<capture>/<n>.<png|webp>`, so the
  bucket's lifecycle rules follow the plan's keep days.
- **The month's count is a meter** (`meter:<account>:<meterEpoch>:ship-desk-cards`, the §4.3 key, written by the CARD
  script with `INCR` and `PEXPIREAT periodEnd + 40 days`). `meters.shipDesk {used}` is registered from
  `api/_lib/ship-desk-meter.ts`, imported by the status route only (A42's reason: registering beside the provisioner
  would form an import cycle).
- **The run-record reader moved** from `remote-ticket.ts` to `api/_lib/cloud-run-reader.ts`, unchanged and re-exported, so
  Ship Desk reads A59's one registration without importing Remote.
- **`vector ship` is hidden from `vector --help`** (Ship Desk shows only once listed, H1) and is an open command: the
  capture job has no Vector account. `vector ship capture` refuses to run when the job can mint OIDC tokens, holds a run
  token or holds `VECTOR_CLI_TOKEN`, and strips Vector's tickets, tokens and secrets from the repository's commands.
  `.vector/ship.json` is read from the base commit, so the pull request itself cannot change what runs; the head's
  own code still runs to be shot, which is why the job holds nothing worth taking. A new Vector Local source,
  `ship-desk`, labels its requests (blocked under Vector Local, except the app on this computer).
- **Not built here:** the `ship-desk` readiness check in `perkServices` (A50 builds the screens; nothing should list it
  before them), the desktop merge (A50's `packages/desktop/src/main/ops.ts`), the workflow job (Codex's V31) and a
  local try-out mode for `.vector/ship.json`.
- **Files outside A49's list:** `packages/schema/src/ship-desk.ts`, `api/_lib/ship-desk-meter.ts`,
  `api/_lib/cloud-run-reader.ts`, `api/_lib/remote-ticket.ts` (re-export), `api/_lib/github-webhook-handlers/ops.ts`,
  `api/github/webhook.ts`, `api/_lib/github-app-server.ts`, `api/_lib/r2-presign.ts`, `api/_lib/codium-provisioners.ts`,
  `api/model-plans/status.ts`, `vercel.json` (the image route's rewrite), `packages/engine/src/index.ts`,
  `packages/core/src/local-mode/sources.ts`, `packages/app/src/features/local/local-model.ts`, `test/ops-fixture.ts`
  (check runs), the A47 test's expectation (the intake's new fields), `docs/vector/MODEL-PLANS.md` and
  `docs/vector/owner-actions/hosted-ops.md`.

## A50 Ops UI and ops crons (5 Nov 2026)

- **Settings → Production is a new settings tab** (`production`, after Remote in the Personal group), not a page under
  `features/cloud`'s cloud console. It shows on the desktop only (`platform.ops`), when the status lists an ops part and
  the plan's public entitlements carry `ops`. The component lives in `packages/app/src/features/cloud/ops/` as the
  contract's file list says; `settings-registry.test.ts` now counts 18 pages.
- **One request list for both surfaces.** `ops-requests.ts` names every request the screens may make, checked by shape,
  and is exported as `@vectordevai/app/ops` so the desktop's main process can check what the renderer asks before it
  sends the account token. The token and the GitHub sign-in never reach the renderer. A new Vector Local source,
  `production-checks` (account purpose, blocked under Vector Local), labels these requests; merges stay on `github`.
- **Screenshots.** The phone shows the signed R2 link in an `<img>`, so the phone origin's CSP gains
  `img-src https://*.r2.cloudflarestorage.com`. A static header cannot read `VECTOR_R2_ACCOUNT_ID`, so the wildcard
  covers every R2 account; it applies to images only, and scripts, styles and connections keep their own lists. The
  desktop instead fetches the link in main (R2 host only, no redirect, at most 5 MB) and hands the renderer a data URL
  only when the bytes are PNG or WebP by signature.
- **Merges on the desktop** use the person's own GitHub sign-in through `github-pr.ts`'s `putPullRequestMerge`, at the
  card's head sha for Approve. The repository's allowed merge method is found by trying squash, merge, rebase in that
  order (GitHub answers 405 for a method it does not allow). Each merge needs a second click. The phone opens GitHub.
- **The roster.** The guard and the cleanup must not scan every account's snapshot, so the `ops` provisioner keeps three
  sorted sets of account ids and times under the Codium prefix, keys §4.6 does not list: `ops:roster:<plan>` (Max or
  Ultra, active, renewing or paused), `ops:accounts` (every account that had ops caps) and `ops:erase:due`. The guard
  adds `ops:guard:held` and `ops:guard:checked`; domain health adds `ops:health:<account>` and `ops:health:checked`;
  the cleanup adds `ops:cleanup:cursor`. All are erased with the account.
- **"From active counts"** counts the roster: paused accounts are included, because §4.4 keeps On Call's checks running
  while a payment is retried, so they cost the Worker the same.
- **The guard's spend.** "Cloudflare's analytics API" is read as the GraphQL Analytics API for the Worker script
  (`workersInvocationsAdaptive`) and the `OpsAccount` namespace (`durableObjectsInvocationsAdaptiveGroups`,
  `durableObjectsPeriodicGroups`), priced at the published Workers Paid rates without the included amounts or the base
  fee, so it errs high. It needs a new read-only token and the namespace id (`VECTOR_OPS_CF_*`, not in §4.16). The cap
  costs default to §1.4's $0.11 and $0.90 and can be overridden (`VECTOR_OPS_GUARD_CAP_COST_{100,200}_USD`). The $5 is
  read as a fixed monthly allowance.
- **"Pause only accounts above their own expected usage"** compares an account's probes over the last 25 hours (the
  Worker's hourly totals, read through `state`) with its monitors at its plan's interval plus its release watches, with
  a 1.25× margin and 12 probes of slack. A held account is suspended at the Worker with reason `guard`; nothing else
  changes. Holds are released once the spend is under the budget, and a hold never outlives the month it was made in,
  even while the analytics cannot be read. Without analytics the guard holds no one and emails the owner (once a day
  when unreadable, once a month when unset).
- **The 75% and 100% emails** go once a month each through `notifyOwner`, with the dollar figures in the email only;
  the cron's answer carries counts and a share.
- **Cards and their images.** To delete a card's images when it expires, the card's record now outlives its
  `expiresAt` by 3 days (`SHIP_DESK_LIMITS.retainMs`), hidden from every reader (A49's reads already check
  `expiresAt`). The cleanup deletes images first and keeps the card when any delete fails. The bucket's lifecycle rules
  stay as the backstop. One side effect: a pull request event in the 3 days after its card expired finds the hidden
  record and makes no new card (the intake answers `exists`); after the cleanup it would make a new card, as before.
- **Frozen accounts.** The cleanup deletes none of a frozen account's cards (§4.4: hidden, not deleted). Their records
  and images still lapse by their own lifetimes, as every card's do; nothing extends them while frozen.
- **"Erases after a lost dispute plus 30 days"** applies to every ops record (Worker data, settings, incidents, Release
  Guard records, cards and images, domain health), as §4.4's cloud-computer row says for disks. A loss reversed (a won
  appeal, the owner clearing the block, a new plan) before the 30 days removes the date.
- **Incidents** already expire after 90 days (A48); "cleanup expires … incidents" prunes their list entries.
- **Domain health** runs in the existing daily `/api/ops/domains` job, after A47's re-verification, for roster accounts'
  verified domains within the plan's domain count. RDAP finds the registry from IANA's bootstrap file and asks for the
  shortest name it knows (`example.com`, then `example.co.uk`, then one more label). DNS drift compares the zone's name
  servers and the domain's CNAME, never address records (CDNs rotate them); an empty or failed answer is not drift.
  Alerts are title-only (P7), tag `on-call`, also while paused, at 14 and 3 days before a certificate ends, 30 and 7
  before a registration ends, once for a broken certificate and once per DNS change. The record keeps dates, name
  servers and the CNAME target for 40 days.
- **Readiness checks.** `on-call`: the ops Worker is configured. `release-guard`: also the App's own tokens
  (`githubServerConfigured`). `ship-desk`: also the media bucket. The App, phone alerts and the `ops` switch are checked
  as before. Listing stays the owner's call after the outside review of the revert path.
- **Files outside A50's list:** `api/_lib/ops-guard.ts`, `ops-cleanup.ts`, `ops-health.ts`, `ops-accounts.ts`,
  `codium-perks.ts`, `codium-provisioners.ts`, `ops-api.ts`, `safe-fetch.ts` (export only), `ship-desk.ts`,
  `vercel.json`, `.env.example`, `packages/app/package.json`, `context/platform.tsx`, `settings-registry.ts` and its
  test, `dialog-settings-v2.tsx`, `features/local/local-model.ts`, `phone/phone.css`, `phone/routes/notifications.tsx`,
  `packages/core/src/local-mode/sources.ts`, the desktop's `ipc.ts`, `preload/index.ts`, `preload/types.ts` and
  `renderer/index.tsx`, `packages/web/test/codium-configuration.test.ts`, `docs/vector/MODEL-PLANS.md` and
  `docs/vector/owner-actions/hosted-ops.md`.

## P7 review decisions (5 Nov 2026)

- **A44: deletion waits for the upload links.** A blob queued for deletion (a commit's discard, a forget, a vault
  deletion, account deletion, the cleanup) is deleted from R2 only once every PUT link signed for it has stopped
  working: `vector_brain_vault_blobs.signed_until`, set by `reserve` on every row it signs (the manifest included) to
  the link's 900 seconds plus a 5-minute grace (`VAULT_LIMITS.linkGraceMs`, clock skew and an upload still sending),
  and checked by `claim`. Before this a PUT through a live link after the delete recreated the object with no row
  behind it, uncounted and never found again (the bucket has no lifecycle rule). So the immediate purges in commit,
  forget, destroy and account deletion now delete only what is past its links; the rest goes with the next daily
  cleanup. The wrapped key still goes at once. `brain-vault.sql` adds the column with `add column if not exists`.
- **A44: the version cap makes room instead of refusing.** At 60 committed versions a new backup drops the oldest
  committed version (never the newest), the way forgetting it would, inside the reservation's locked transaction and
  only once every other check passed (a refused request drops nothing). Objects the new backup declares are kept. A
  held vault (frozen) refuses with 402 `VAULT_QUOTA` instead, since it loses nothing it committed. Before this an
  account that averaged more than two backups a day (computers sharing a vault) was refused as "full".
- **A44: dead backups stop counting.** The four-backups-at-once limit counts only uncommitted versions with a request
  within the last hour (`reserveMs`), the same hour after which the cleanup sweeps them; a backup that failed after its
  first request no longer blocks the account until 03:40.
- **A44: a plan without Vault is a lapse.** The open point above is decided: `vaultPolicy` answers `lapse` for an
  active, renewing or paused plan whose `vault.gb` is 0 (Plus), so a move down from Pro, Max or Ultra gets the notice
  and the 30 read-only days, then deletion; a plan with Vault before then releases it. The notice now says the plan "no
  longer includes Brain Vault on Vector" (it was "has ended"), which reads right for both.
- **A47–A50: the ops perks are gated by their listing on the server.** §4.14 makes listing a display matter, but
  `VECTOR_OPS_ENABLED=true` and the App's registration come before listing and before §8.2 step 16's outside review of
  the revert path, so every ops path that starts new work now needs its perk in `listedPerks()` (503 `OPS_UNAVAILABLE`
  for the routes; the webhook ignores with `not-listed`; a revert is `manual` with the new reason `off`), as Vault's
  writes already did. Domains need On Call or Release Guard (verified domains serve both), monitors On Call, a
  repository each of Release Guard and Ship Desk it turns on (either one when neither is on), the deployment intake and
  every revert Release Guard, a new Ship Desk card and a capture ticket Ship Desk, a fix run the incident's perk.
  Reading, removing and updating what already exists never check it. New env `VECTOR_OPS_ALLOW_ACCOUNTS` (not in
  §4.17's list) lets the owner try the perks with named accounts before listing, as `VECTOR_HOSTED_ALLOW_ACCOUNTS` does
  for the cloud computer; those accounts still need the plan, the services and the switch. The ops tests' fixture sets
  it for its accounts; the gate's own cases delete it.
- **A48: a revert needs the service on.** `decideRevert` also checks `requireOpsService` (the `ops` switch and the
  Worker's settings) before minting a revert token, so a regression the Worker still reports while its kill flag
  spreads, or after a flag sync failed, writes nothing (§2, §4.16).
- **A48/A50: Undo merges at the revert's head.** `RevertOutcome` keeps `headSha` (GraphQL `headRefOid`, a reused pull
  request's `head.sha`, or the restore commit) and the incident's Undo passes it to the desktop's merge, so a commit
  pushed to the revert branch after Vector opened it is never merged unseen; GitHub's 409 is shown as "new commits
  landed". Outcomes recorded before this have no `headSha` and merge as before.
- **A48: fix runs take only callers that may spend Codium.** `requireOpsCaller` returns the token's `client` marker,
  and `POST /api/ops/incidents {action: "fix"}` refuses an unmarked `vct_` token (one copied from /auth/cli) with 401
  `CODIUM_SIGN_IN_REQUIRED` unless `MODEL_PLAN_REQUIRE_MARKED_TOKENS=false`, as `model-plan-caller.ts` does. Snooze and
  the reads still take it.
- **A49: capture tickets.** GitHub prints a step's environment in its log, so the unmasked `capture` output is
  readable by anyone who reads the repository's logs. A ticket is now minted for a private repository only, read with
  a read-only `ship` App token at `{action: "ticket"}` (403 `SHIP_DESK_PUBLIC_REPOSITORY` otherwise; GitHub unreachable
  is 503 `GITHUB_UNAVAILABLE`, which `vector ship ticket` reports as no ticket). And the capture job's first request (of
  any action) binds the ticket to a random proof `vector ship capture` makes and sends as `proof` with every request;
  only its SHA-256 is stored, and another proof gets 403 `SHIP_DESK_TICKET_BOUND`. The review suggested opening the
  15-minute window at that first use too; it still opens at the first `start`, because the capture installs and builds
  the repository twice (up to 15 minutes each) between `card` and `start`, and the binding alone already shuts out a
  copy read during that time. One cost: re-running only the capture job (a new proof) is refused; re-running the
  workflow mints a new ticket. Codex's V31 wiring is unchanged (the proof never leaves the capture job).

## A51 Hosted core (5 Nov 2026)

- **Files outside A51's list.** `api/_lib/codium-pool.ts` (the true-up's `LOWER` script and `lowerDebit`),
  `api/_lib/model-plan-account.ts` (`PoolHold` gains `pool`, so a block's hold can be settled or released from another
  invocation with `recordDebit`/`releaseHold`, exactly as its own `settle`/`release` would), `api/_lib/hosted-meter.ts`
  and its import in `api/model-plans/status.ts` (`meters.hosted`), `api/_lib/model-plan-estimate.ts` (the hosted form),
  `test/hosted-fixture.ts`, `HGETALL` in the Codium fake store, the reviewed list of `test/codium-pool.test.ts`'s
  tripwire (adding `hosted-ledger.ts: holdPool(` is that producer's review), one expectation and a new case in
  `packages/web/test/model-plan-estimate-api.test.ts`, `.env.example`, `docs/vector/MODEL-PLANS.md` and
  `docs/vector/owner-actions/hosted-computer.md` (new, with only the ledger's section).
- **"15-minute blocks held 20 minutes ahead"** is read as: before a block starts it holds 20 minutes at the charged
  rate (the block's 15 and the 5 a paused or refused session may still run to wrap up, §4.4), and the hold lapses 30
  minutes after it is placed. Renewing a block holds the next one first; the two holds overlap for the wrap-up minutes.
- **"Attributed to the period active at settle."** When a renewal or an upgrade replaced the hold's key before the block
  settled, the account's current key takes the charge as a debit of its own and the old hold is given back; otherwise
  the hold becomes the debit on its own key. `holdPool`'s own `settle` keeps old-pool identity (A09/A17). For an upgrade
  the two come to the same (the carry true-up waits for the live hold, then returns it in the carry); after a renewal the
  replaced key spends nothing more, so only the current period can pay. A queued block records where its charge went
  before anything else (`MARK`), so a retried settle never charges twice, even across a second renewal.
- **Nothing a computer ran goes uncharged.** Minutes past a block's hold (a reaper that ran late) are an overrun: a
  separate debit on the current key and an `overrun` line. A block nothing closed is charged its whole hold once the hold
  lapses (`LAPSE`, run by `drainHostedSettles`, the reaper's ledger pass for A53).
- **Storage, egress and retention have no hold placed ahead.** They accrue before anything could hold them, so each is
  a debit with its own held member until applied (as the carry true-up's shortfall debits are). On a pool already
  spent, the key's limit floors at zero and the remainder is Vector's: cents a day.
- **Rates.** Snapshot storage is $0.08 per GB-month (Vercel Sandbox, read 2026-09-10 in `cloud-envs-plan.md`), charged
  per GB-day over a 28-day month, plus 10%. `VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB` is read as what a GB costs Vector
  (whole micro-dollars), charged plus 10%; unset it is $0.15 per GB, Vercel's highest published iad1 transfer rate,
  until Vercel answers owner step 14. An invalid value stops new cloud computer work.
- **True-up.** "Only lowers, never below cost" is built as `trueUpCharge`: the trued charge is min(current, actual
  cost plus 10%, rounded up), so it never rises and never goes below the actual cost. The pool's debit is lowered in
  place (`LOWER` also renames the debit's own held member while it is unapplied, so the ledger's READ still finds it at
  its amount) and convergence raises the key's limit (M1). Only a charge on the current period's key is lowered: a
  replaced key spends nothing more. The actual cost comes from the provider's usage (`computeCostMicro`: busy vCPU time
  plus memory over the time the computer ran), which A53's nightly job supplies.
- **The shared caps (A17's obligation).** The daily share is checked before each hold from today's spend as status
  counts it, not in the same step as the hold: the common HOLD enforces the month only, and changing it was out of
  scope. A model request admitted in between can pass the share by at most one block per hold in flight (Max runs one
  computer; Ultra has no daily share unless its pool ramp sets one); ADMIT counts every live hold today, so model requests
  never pass the share because of a block. Blocks carry no run id: compute belongs to a session, not to a run, so the
  run ceiling and the run's pool binding stay about model requests (a session's model requests carry their run through
  ADMIT), and a session spanning a renewal is not refused its next block. Purpose `hosted` never counts toward the Brain
  share.
- **Hours.** `hosted:minutes:<id>:<meterEpoch>` (§4.6) is a hash: `used` (settled weighted minutes, the large size
  counting two), `r:<ref>` (a running block's reservation and when it lapses) and `d:<ref>` (counted once). A block
  reserves its minutes when it opens, in the same step as its computer, so parallel sessions never pass the hours; its
  settled minutes count in the period active at settle. When the hours run out mid-block, the session may still run to
  the end of its hold to wrap up; those minutes are charged and counted, so a period's hours can be passed by at most
  the wrap-up.
- **Computers at once** are counted in `OPEN` (§WP A53 says "by lease"): a session's first block needs fewer running
  blocks than the plan's computers. A53 can rely on it.
- **Store keys not in §4.6,** under the Codium prefix: `hosted:settle:<id>` (ended blocks to settle), `hosted:settle-due`
  and `hosted:lapse` (indexes for the reaper).
- **New env `VECTOR_HOSTED_ACCOUNT_SALT`** (not in §4.16): ledger lines name the account by an HMAC under it, as Vault's
  rows do, and A52 can name sandboxes from the same value. No block opens without it and Supabase.
- **Codes not in §4.10:** 400 `HOSTED_REQUEST`, 409 `HOSTED_SESSION_RUNNING` and 409 `HOSTED_SESSION_MOVED`. A start
  while the plan renews is 503 `MODEL_PLAN_RENEWING` (retry after 30 s); paused, frozen and not-included plans get
  `HOSTED_PAUSED`, `HOSTED_FROZEN` and `HOSTED_NOT_INCLUDED {perk: "computer", plan}`.
- **Disks after a plan ends.** An ended plan's 14 days are paid once from the final period, out of what it can still
  cover (credits and carry less its model spend, debits and live holds, read from the final key's provider usage), and
  shortened to whole days when it cannot. After a lost dispute the 30 days are Vector's cost, since that payment was
  reversed; a frozen account's disks are kept and not charged. The trust ramp is recomputed at each read from the plan,
  so a ramp that ended after the snapshot was written no longer applies.
- **The estimate's hosted form** (A18 left it for A51): `{kind: "hosted", minutes, size}`, answered only while the
  cloud computer can be started for the account (listed, or `VECTOR_HOSTED_ALLOW_ACCOUNTS`) and its plan includes the
  size, minutes clamped to the plan's longest job now (the ramp applied), priced at the charged per-minute rate on the
  same 1.5x grid and per-step cache as the model form.

## A52 Provider adapter and reconciler (5 Nov 2026)

- **The run token is injected by the provider's egress proxy, not into the computer.** The contract's "only injected
  credential" is the `vht_` token, added by Vercel's network policy (a `transform` rule) to requests for the run-API
  host only. It is never in the sandbox's environment (none is set), files or disk, and Vercel redacts it when a policy
  is read back. `setHostedRunToken` replaces it in place.
- **Two shared constants in `packages/schema/src/hosted.ts`** (A51's file): `Hosted.RUN_API_HOST =
  "hosted-run.vectordev.ai"` and `Hosted.VIEWER_PORT = 6080`, so A53's routes, A54's image (its Chromium URL policy and
  viewer proxy) and this adapter name the same host and port. The host is fixed because the image's browser policy is
  static (as A42 fixed the relay host). New env `VECTOR_HOSTED_RUN_HOST` (not in §4.16) may move it outside production
  only, for a preview in Stripe test mode; Vector's own sites are refused. The run host is handed to A53's boot step in
  `startHostedComputer`'s answer instead of an environment variable, since a persistent sandbox's environment cannot be
  changed after creation.
- **Deny list.** `HOSTED_DENIED_SUBNETS` holds every block the contract names, private (RFC 1918), loopback, link-local
  (with 169.254.169.254) and 0.0.0.0/8, 192.0.0.0/24, `::/128`, `ff00::/8`, `64:ff9b:1::/48` and `2002::/16`. AWS's IPv6
  metadata address is inside `fc00::/7`. Shared address space (100.64.0.0/10) and benchmarking networks (198.18.0.0/15)
  are left out: the contract does not name them and a provider may use them for its own plumbing, which could not be
  tried here. Every block's first address is also refused by `safe-fetch.ts` (S8).
- **Modes.** The name keeps the contract's format, `vh-<HMAC(account)[0:16]>-<n>` (from A51's `hostedAccount`,
  numbered 1 to 3), so it carries no mode. Every computer is tagged `vector-mode: live|test` (and `vector-size`); the
  adapter lists only its mode's computers and never resumes, changes, stops or deletes one of another mode or an untagged
  one (`start` refuses it, `stop` and `destroy` answer `missing`). The owner should still give Preview its own Vercel
  project or salt.
- **Store keys not in §4.6,** under the Codium prefix: `hosted:computer:<name>` (`{v, account, computer, session,
  startedAt}`, written before the provider is asked and kept past the session's timeout plus an hour) and
  `hosted:reconcile` (the reconciler's throttle). Plain commands only, so no Valkey case was added.
- **"A live session row"** is read as: the computer's session record names this computer, and that session's running
  block (A51's `hosted:running:<account>`) still holds its time, before the hold lapses and no later than two minutes
  past its stopBy. A53 has no session rows yet; it can tighten `sessionLive` with its own rows.
- **The reconciler is a function, not a route.** A52's file list has no route and §4.19 no reconcile cron, so
  `reconcileHostedComputers` throttles itself to every 3 minutes and A53's reaper (every minute) calls it. With the
  `hosted` switch at `stop` it stops every running computer. A store failure stops nothing (the provider's own timeout
  still ends the session); a stop or a failed stop emails the owner once in 6 hours, naming computers only.
- **Beyond the contract, on money:** `startHostedComputer` starts a computer only for a session whose block is held now
  (M8, 409 `HOSTED_SESSION_MOVED` otherwise). The Vercel provider is configured only on the team the spend guard watches
  (`VERCEL_HOSTED_TEAM_ID` equal to `VECTOR_HOSTED_VERCEL_TEAM_ID`, with `VERCEL_SPEND_WEBHOOK_SECRET_HOSTED`) and never
  on `VERCEL_MAIN_TEAM_ID` (M9). Credentials always go to the SDK explicitly, so it cannot fall back to the deployment's
  own OIDC token.
- **Every session boots clean.** A running computer is stopped (its disk saved) before the session's settings are
  applied and it is resumed, so A54's boot step runs on every session. Resuming one still saving its disk is tried up to
  4 times, 2 s apart.
- **Retention.** `snapshotExpiration` and `keepLastSnapshots {count: 1, deleteEvicted: true}` are the plan's
  `diskDays`, set at creation and on every start; the SDK cannot change an existing snapshot's expiry, so a change of
  plan applies from the next stop. A disk past its retention (`snapshot_not_found`) is deleted with its sandbox and
  made again from the base snapshot; `destroy` counts such a computer as deleted, since no data of the subscriber's is
  left at Vercel. Disks after a plan ends (14 days, dispute holds) stay A53's provisioner's job.
- **Region iad1 with no failover** (`failoverRegions: []` on resume), because the rates are iad1's.
- **`@vercel/sandbox` 3.8.0** (published 2026-10-13), not 3.9.0 (2026-10-22, only just two weeks old). `bun.lock` gains
  it and its dependencies, and bun re-hoisted `lru-cache` (root 10.4.3, the 11.5.1 users nested) and `tar-stream` (root
  3.1.7, `archiver` keeps 3.2.0); no project code imports either. The SDK is loaded only by a dynamic import on the first
  provider call, and the adapter's calls are typed against the SDK's own declarations.
- **Cloudflare** is an interface stub that is never configured and refuses every call; the provider contract suite in
  `test/hosted-provider.test.ts` runs in full against Vercel (with a fake SDK) and is a `todo` for Cloudflare.
- **Files outside A52's list:** `packages/schema/src/hosted.ts` (two constants), `.env.example`, `docs/vector/MODEL-PLANS.md`,
  `docs/vector/owner-actions/hosted-computer.md`, `bun.lock`.

## A53 Sessions API, reaper and nightly (5 Nov 2026)

- **The boot step is part of the provider interface.** A52's `HostedProvider` gains `boot(name, {runHost, session})`.
  Vercel runs `Hosted.BOOT_COMMAND` (`/opt/vector/boot.sh`) as root, detached, with exactly `--run-host <host>
  --session <id>` and no environment (`bootArguments` refuses anything else); the Cloudflare stub refuses it. A54's
  boot.sh takes these two arguments. The job is pulled, not pushed: the computer's daemon calls
  `POST https://<run host>/api/hosted/sessions/<id>/heartbeat` with no credential of its own (the provider's proxy adds
  the run token), and the answers carry the job (until the daemon says it booted), the state, who has control, the
  deadline, whether the browser may be used, the viewer tokens' public key and, when asked, an upload link.
- **Run tokens** are `vht_<payload>.<HMAC-SHA-256>` under `VECTOR_HOSTED_RUN_SIGNING_KEY` with the domain
  `vector-hosted-v1`, bound to one account and session, and live until 10 minutes after the block they were minted with
  may run to (`stopBy`), at most an hour and never past the deadline plus 5 minutes. The reaper mints the next one with
  each block (`setHostedRunToken`) and again when one has under 8 minutes left. Every acceptance also needs the session
  not stopping or ended and the account's run tokens not revoked (`runTokensRevokedBefore`, A06).
- **S7 on the API side:** a request carrying a run token is refused with 403 `HOSTED_RUN_REFUSED` when it carries
  `Origin`, any `Sec-Fetch-*` header or a cookie, at the heartbeat and in the gateway's caller gate
  (`api/_lib/model-plan-caller.ts`, one line). `vercel.json` sends every path on `hosted-run.vectordev.ai` except
  `/api/hosted/sessions/*`, chat, `/models` and estimate to the website.
- **Computers at once, by lease:** `hosted:lease:<account>` (HASH computer → `<sid>:<until>`, the CLAIM and LEASE
  scripts) picks the computer number, held until 2 minutes past the block's stopBy and renewed with each block; A51's
  OPEN still counts running blocks against the plan's computers.
- **Store keys not in §4.6** (under the Codium prefix): `hosted:session:<sid>` (record, compare-and-set with SAVE, kept
  35 days after it ends), `hosted:sessions:<account>`, `hosted:live`, `hosted:lease:<account>`, `hosted:job:<sid>`,
  `hosted:beat:<sid>`, `hosted:model:<sid>`, `hosted:viewer:<jti>`, `hosted:computers:<account>`, `hosted:names`,
  `hosted:suspend:<account>`, `hosted:suspended`, `hosted:egress:<account>:<day>`, `hosted:pages:<account>:<hour>`,
  `hosted:recent`, `hosted:trueup:<account>`, `hosted:disk-due`, `hosted:roster`, `hosted:budget`, `hosted:usage`.
- **Error codes not in §4.10:** 404 `HOSTED_SESSION_NOT_FOUND`, 409 `HOSTED_SESSION_ENDED {state}`, 409
  `HOSTED_TAKEOVER_REQUIRED`, 403 `HOSTED_RUN_REFUSED`, 409 `HOSTED_DOWNLOAD_UNAVAILABLE` (410 once the files are gone),
  added to `Hosted.ERROR_CODES` with A51's `HOSTED_REQUEST`, `HOSTED_SESSION_RUNNING`, `HOSTED_SESSION_MOVED`. A held
  account (fair use or the owner) gets the existing 403 `HOSTED_FROZEN` with `reason: "fair-use" | "owner"`.
- **Viewer tokens:** `vvt1.<payload>.<Ed25519 signature over "vector-viewer-token-v1." + payload>`, claims `{aud:
  "vector-viewer", sid, computer, mode, jti, iat, exp}` (5 minutes), in the URL fragment `#vt=`. "Single use" is
  enforced where the token is spent, by the computer's viewer proxy (A54) keeping the jtis it accepted; the server
  records each jti it issues (`SET NX`, 5 minutes). `checkViewerToken` in hosted-tokens.ts is the reference check.
  Control links only during a take-over.
- **Download "link 24 h":** A37's presign cap is 15 minutes, so the 24-hour link is an API URL carrying an HMAC token
  (`vhd1.`, the session id and expiry only, no account id) that redirects to a fresh 15-minute signed R2 GET each time.
  The files are packed by the computer when the person asks (heartbeat `archiveBytes` → a signed PUT for exactly that
  size, at most 5 GiB, under `hosted/<mode>/<HMAC>/<sid>/files.tar.gz` in `vector-media`) and checked with a HEAD after
  `uploaded`. Only a running session can pack its files.
- **Fair use (§4.2):** page loads are counted per UTC hour (not a rolling hour) and egress per UTC day, both per
  account and from the daemon's own counters (the provider's figures are what is charged); "busy" is a heartbeat CPU
  of 80% or more. Passing one stops the session, holds the account's cloud computer (`hosted:suspend`) and emails the
  owner; the owner releases it with `/api/hosted/admin/flags`.
- **Reaper order and reasons:** a session told to wrap up ends for its wrap reason once `wrapBy` passes, before the
  heartbeat and idle checks. The next block is held from 3 minutes before the current one ends; a refusal wraps the
  session up within min(5 minutes, its stopBy) with reason `hours`, `usage`, `plan`, `frozen` or `lapsed`, and a store
  or provider failure is retried each minute until 5 minutes before stopBy. A first heartbeat is due within 5 minutes of
  the start, later ones within 3. The reaper reads the snapshot from the store only (M4).
- **Stops:** the block is closed at the moment the provider confirmed the stop, so exactly what ran is charged. A stop
  the provider cannot make leaves the session `stopping` and is retried every minute; 30 minutes past its stopBy the
  session ends anyway, its block having lapsed and been charged in full. A provider start that fails charges nothing
  (the block is closed at its own start); a computer that started but could not boot is stopped and charged.
- **admin/flags** also drains, stops and resumes (the `hosted` switch, through `writeSwitch` and its audit) besides
  holding single accounts. `requireRecentGoogleSignIn` is now exported from `codium-owner-api.ts` for it.
- **Budget:** `GET /api/hosted/admin/budget?cycleEnd=<ms>` (the workflow knows Vercel's cycle) answers, for the roster's
  accounts, the hours left this period (cached nightly) plus the full hours of every period that starts before the
  cycle ends, at the worst-case cost of a weighted minute, plus each included computer's disk at the worst-case size
  until the cycle ends, as `worstCaseUsd`. It is owner-side only (the workflow's secret).
- **Storage** is charged nightly at `HOSTED_DISK_GB_MAX` (16 GB) per computer per day while the plan is live, because
  the provider's listing does not say how large a saved disk is; A54's bake must keep the base image at 6 GB or less.
  Storage is never trued up. A frozen account's storage is not charged.
- **True-up** runs per computer, only on a night when no session runs on it, for the sessions that ended on it since
  the last reading: each block line's actual cost is its memory for its billed minutes plus its share (billed minutes
  times vCPUs) of all CPU time the provider reports since the last reading (the computer's whole life when there is no
  reading). That can only overstate a line's cost, so a charge never falls below it. A computer whose cumulative figure
  went down (made again) is left at its charges.
- **Drift** compares minutes: each session's lifecycle this period (first block to the confirmed stop, rounded up)
  against the ledger's block and overrun minutes plus running and queued blocks, with a tolerance of one minute per
  block plus one. Only charges falling behind are emailed (accounts and minutes).
- **The provisioner** is configured while the provider or the ledger is. Its stops and wrap-ups are best effort (the
  reaper finishes them from the same snapshot), so the outbox does not dead-letter on a provider outage; account
  deletion is not best effort. A move to a plan without a cloud computer is treated as an end for the disks (14 days,
  charged to the current key). The first deletion date set stands (`ZADD NX`); a returning plan clears it.
- **Done by Morning hook:** `registerHostedJobsRunner` lets A55 run `hosted:jobs:due` from the reaper.
- **Website sessions** start sessions with source `phone` when the request's Origin is the phone app's, else `desktop`.
- **Session ids** are `hs_` plus 26 base32 letters. `Hosted.SESSION_ID` is an object with `test`, because A51's test
  keeps `$` out of the schema's code.
- **Not built:** `/api/hosted/spend` from §4.19's list (the hosted team's spend webhook is A13's
  `/api/owner/spend-vercel`), downloading the disk of a session that is not running (an ended plan's 14 days for
  download need a download-only start, for A56 or later), and Done by Morning itself (A55).
- **Test expectations changed:** `packages/web/test/codium-configuration.test.ts` now lists the three hosted crons;
  `test/hosted-ledger.test.ts`'s key scan leaves out the outbox's item for the now-configured `hosted` provisioner.
- **Files outside A53's list:** `api/_lib/hosted-tokens.ts`, `hosted-crons.ts`, `hosted-api.ts`, `hosted-run.ts`,
  `hosted-provider.ts`, `hosted-provider-vercel.ts`, `hosted-provider-cloudflare.ts`, `hosted-rates.ts`,
  `codium-perks.ts`, `codium-owner-api.ts`, `model-plan-caller.ts`, the chat, `/models` and estimate routes (one import
  each), `packages/schema/src/hosted.ts`, `vercel.json`, `.env.example`, `docs/vector/MODEL-PLANS.md`,
  `docs/vector/owner-actions/hosted-computer.md`, `packages/web/test/fixture/codium-fakes.ts` (`HDEL`, `INCRBY`,
  `PEXPIRE`), `test/hosted-sessions-fixture.ts`.

## A54 Image and hostd (5 Nov 2026)

- **Where the image comes from.** `image/Dockerfile` builds on the Alpine base the Vector CLI container already pins
  by digest. The image workflow (A58) pushes it to the hosted team's container registry and `script/bake-snapshot.ts`
  starts one sandbox from it (by digest, no network, tagged `vector-bake`, never `vector-mode`), checks it there and
  stops it, so the provider saves the base snapshot. The Vector CLI binary for Linux (musl) goes in at `bin/vector`;
  CI's image job uses a stand-in.
- **"Reinstalls verified system components from the base snapshot".** A resumed Vercel computer restores its whole
  saved disk, so the base snapshot is not there to copy from. boot.sh reinstalls `/opt/vector` and the browser policy
  on every boot from a root-only archive in the image, whose SHA-256 the image build stamps into boot.sh, and replaces
  both folders whole, so anything added or changed there is gone. A newer base snapshot reaches computers that already
  have a disk only when their disk is made again.
- **"Refuses a disk below the minimum image generation".** A disk records the image generation it was made with on its
  first boot (`/var/lib/vector/disk-generation`); boot.sh refuses one older than `VECTOR_MIN_DISK_GENERATION`, stamped
  at build (default 1). hostd also reports the generation in every heartbeat (`Hosted.Heartbeat.generation`, kept in
  the session's beat) so the server can enforce a floor later; no package enforces one there yet.
- **10 GB quota.** The agent's disk is a sparse file of exactly 10,000,000,000 bytes with its own ext4, loop-mounted at
  `/data` (nosuid, nodev, discard), so the kernel enforces the quota. Decimal, so the 6 GB image cap plus the data fit
  A53's 16 GB storage charge. boot.sh fails closed if it cannot mount it. Scratch space (`/tmp`, `/var/tmp`, `/dev/shm`),
  the browser's profile and home, the recorder's segments and hostd's state are memory disks, so nothing else the agent
  or the browser writes reaches the saved disk.
- **More users than the contract names.** Besides the agent (10001): viewer 10002 (the viewer proxy), git 10003
  (token-carrying git steps), browser 10004 (Chromium), display 10005 (Xvfb, x11vnc, the recorder); groups share 10010
  (downloads) and x 10011 (the display cookie). The agent has no access to the display, so it cannot type into the
  browser except through hostd, where the credential guard sits.
- **No sudo binary at all,** no setuid or setgid file (stripped at build and at every boot), and every service started
  with no new privileges and no capabilities. A53's Vercel `boot` step runs with `sudo: true`; the image's default user
  is root. If the provider needs a `sudo` binary for that flag, the real-microVM check shows it and A53's boot call
  changes, not the image.
- **Firewall beyond egress.** Input is dropped too, except the viewer port and replies; the agent and the browser may not
  reach the viewer port even on loopback; QUIC is off (no udp/443, and the browser policy turns QUIC off); bytes the
  agent, git and browser users send are counted (`counter egress`) for the fair-use meter. Whether the provider's own
  control of the computer survives the input drop is one of the real-microVM check's items.
- **hostd's action API** is HTTP on a Unix socket only the agent's user can open (`/run/vector/hostd/actions.sock`):
  `POST /v1/computer {v: 1, input, format?}`, `POST /v1/tool {phase, id, pgid?}`, `POST /v1/git {op, repository,
  directory, branch?}`, `GET /v1/status`. The computer-use format is not on this branch, so `src/actions.ts` repeats its
  action names, fields, limits, error codes, hand-over reasons and batch text without importing them. `list_apps`,
  `open_app`, `focus_window`, `read_ui` and `ui_N` references answer `unsupported_action` (one display, no app list or
  accessibility tree). A frame's `hash` identifies the image's content (SHA-256), not a perceptual hash. A batch runs its
  `actions`, then the top-level action last.
- **Credential guard.** `image/credential-guard.js` is injected over the browser's debugging pipe (only hostd holds it;
  there is no debugging port) into an isolated world of every frame. hostd asks it before typing (text, and any key
  combination other than navigation keys) and before pressing; it refuses typing into password, one-time-code and card
  fields (`secure_field`) and pressing inside CAPTCHAs (`blocked`), and fails closed when a frame does not answer. The
  hand-over reason goes to the server as `Hosted.Heartbeat.handoff` (credential, payment_details, captcha, other); the
  agent's own words never do.
- **DevTools.** The browser policy bars DevTools windows by blocking their pages (`devtools://*`, and
  `chrome://inspect`), not with `DeveloperToolsAvailability: 2`: that policy also refuses debugging-protocol sessions to
  pages, even over `--remote-debugging-pipe`, so the credential guard could not attach.
- **Git.** "While the agent's process group is stopped" is done for every process of the agent's user. Token steps run
  as the git user in bare mirrors only hostd configures, with hooks, helpers, proxies and URL rewrites switched off on
  the command line; the token is an HTTP header in git's environment, scoped to https://github.com/. No git process of
  the git user reads the agent's repository: a push goes through a bundle the agent's git writes (opened without
  following links before it is shared). Pushes are to `vector/…` branches only, never forced. Tokens come from
  `POST /api/hosted/sessions/<id>/git-token`, which no package has built (sessions name no repository yet), so git steps
  fail until a later package adds it.
- **"Processes not spawned by the current tool call are killed when it ends"** is read as: when a tool call ends, hostd
  kills the call's process group and any agent process started during the call that is no longer under the agent's main
  process (a daemon, a double fork). The agent and what it keeps under it stay. The agent marks a call's bounds on
  `/v1/tool`; the agent-side hook belongs to the computer-use build.
- **"Viewer proxy on localhost VNC"** is stricter: the VNC server listens on a Unix socket only (`-unixsock`, with
  `-rfbport 0 -rfbportv6 0` closing both TCP ports; never TCP, not even loopback), in a folder only the viewer user can
  enter, so no other process on the computer can reach it.
- **Viewer proxy.** Checks the token's session, not the computer's name, which the computer does not know (a session
  runs on one computer). It speaks HTTP itself over `node:net`, so the same code runs on Node and under the tests. Only
  RFB 3.8 with no VNC password; the shared flag is forced on; a view token's keyboard, pointer and clipboard messages are
  dropped at the proxy; a control token's connection is closed when control goes back to the agent. Close codes 4000 (no
  token), 4001 (control ended), 4002 (session ended), 4003 (token refused). The page (`viewer.html`, `viewer.js`) is a
  small VNC client (Raw, CopyRect, DesktopSize) and may be framed only by vectordev.ai and remote.vectordev.ai.
- **Recorder.** H.264 in 1-minute MPEG-TS segments on a memory disk, capped at 720 segments or 192 MB. Uploading them is
  Done by Morning's (A55).
- **Schema and A53 server changes.** `Hosted.Heartbeat` gains `generation` and `handoff`; `Hosted.HeartbeatAnswer` gains
  `pack`. A53 answered the upload link only once the computer had reported the packed size, but never told the computer
  that the person had asked for the files: `pack: true` is that signal. `api/_lib/hosted-sessions.ts` parses and keeps
  the two report fields in the session's beat and sends `pack`; `test/hosted-sessions-api.test.ts` covers both.
- **The agent's launch** is `vector run --format json [--title …] -- <prompt>` as the agent, umask 022, with no secret
  in its environment (`VECTOR_HOSTED_SESSION`, `VECTOR_HOSTED_RUN_HOST`, `VECTOR_COMPUTER_SOCKET`). Routing its Codium
  requests through the run-API host, and driving the computer through hostd's socket, belong to the computer-use build.
  The run-API host refuses `Sec-Fetch-*`; Node's fetch adds `sec-fetch-mode: cors` by itself (checked here), which is
  why hostd uses `node:https`, and the agent's Codium client must not send it either.
- **The files a person downloads** are the agent's work folder (`/data/work`), not its home.
- **Tests.** The Docker job runs in `vector-codium.yml` (`hosted-image`); A58 may move it into `vector-hosted-ci.yml`.
  Inside that container only, Chromium runs with `--no-sandbox`, because containers lack the user namespaces its sandbox
  needs; production and the real-microVM check keep it on. The real-microVM check is `script/microvm-check.ts`, run by
  `vector-codium-e2e.yml` with `hosted: true` and four new `codium-test` secrets (`CODIUM_E2E_HOSTED_*`).
- **Files outside A54's list:** `src/{actions,computer,daemon,guard,limits,procs,rfb,run,run-api,websocket}.ts`,
  `image/{boot-lib.sh,viewer.html,viewer.js}`, `script/microvm-check.ts`, `test/docker/in-image.mjs`, the other test
  files, the package's manifest and configuration, `bun.lock` (the workspace entry only), `vector-codium.yml`,
  `vector-codium-e2e.yml`, `packages/schema/src/hosted.ts`, `api/_lib/hosted-sessions.ts`,
  `test/hosted-sessions-api.test.ts`, `docs/vector/MODEL-PLANS.md`, `docs/vector/owner-actions/hosted-computer.md`.

## A55 Done by Morning (5 Nov 2026)

- **Files outside A55's list.** `api/_lib/hosted-jobs-api.ts` (the route handlers, as A53 keeps its in `hosted-api.ts`)
  and `api/_lib/hosted-jobs-runtime.ts` (registers the queue's runner and the heartbeat hook, imported only by
  `api/hosted/reaper.ts` and `api/hosted/sessions/[id]/heartbeat.ts`, so the tests that register their own runner never
  load it); `packages/schema/src/hosted.ts` (job vocabulary, `DELIVER_LABEL`, the heartbeat's `segments` and
  `uploadedSegments`, the answer's `recording`, five error codes); `api/_lib/hosted-sessions.ts`
  (`registerHostedHeartbeatHook`, called at the end of a live session's heartbeat; a hook that fails is skipped);
  `api/_lib/hosted-run.ts` (the gateway hook also logs each hosted request's model and lab);
  `api/_lib/codium-provisioners.ts` (the `hosted` provisioner runs Done by Morning's part first, both parts always run,
  the first failure is rethrown); `api/_lib/codium-perks.ts` (`overnight`'s readiness); `api/_lib/model-plan-models.ts`
  (`servedJudges`, an export of the plan's served judges and labs); `vercel.json` (the run-API host also passes
  `/api/hosted/jobs/jb_…`); `packages/hosted-computer/src/{daemon,hostd,recorder}.ts` and a new test (recording
  uploads); docs.
- **"perNight at enqueue".** A night is the UTC calendar date of the job's deliver-by time; nothing server-side knows the
  person's time zone. A recurring job's run counts against `recurringPerDay` on the UTC date of the run, never against
  `perNight`. Both counters are checked and raised in one script with queueing the job. A queued job the person cancels
  gives its count back. Gaming the date boundary costs the subscriber's own pool, since every minute is charged as any
  session's (M8).
- **"atOnce and hours at start".** Jobs at once is a running set per account (SLOT), taken before the session starts and
  freed when the job ends; A53's start then checks the plan's computers by lease and its hours. A job is marked running
  before its computer starts, so overlapping passes never start it twice. Refusals: hours used or the month used up
  miss the job at once; a busy computer, a renewal, a payment pause, the daily limit or a service outage leave it
  queued.
- **"Aims to deliver by".** A job is queued 30 minutes to a day ahead, with 15 minutes up to the plan's longest job (the
  trust ramp applied) that must fit between its start and its time; the default is the longest that fits. A job still
  queued at its time is `missed`, never started late. Every surface uses `Hosted.DELIVER_LABEL`.
- **"Judge from another lab".** The report has two steps. With the work (`{summary, links?, pullRequest?}`) the server
  picks the judge: one of the plan's Second opinion judges (§4.12, as the gateway serves them now) whose lab none of the
  session's own model requests used, the judge of its most used model first. The verdict (`{judge, results}`, one pass
  or fail per criterion) is accepted only for that model and only once the gateway logged a request of the session to it
  after the work arrived. When no such judge is served the report stands unjudged and says so (`judged: false`). No route
  is accepted today (A60), so every report is unjudged until then. The gateway's log is a new store key,
  `hosted:jobs:models:<session>` (two days).
- **"Report accepted only with that job's token".** The job's session's own `vht_` run token, with no browser headers
  (S7), on `POST /api/hosted/jobs/<id>/report` through the run-API host, while the session runs. Another session's token
  gets 403 `HOSTED_RUN_REFUSED`; account tokens 401.
- **"Recordings 30 days, owner only".** hostd uploads a job's last ten one-minute segments as they finish, into ten
  rotating slots (`recordings/<mode>/<HMAC(account)[0:32]>/<job>/slot-<n mod 10>.ts` in `vector-media`), so a session that
  ends abruptly still has them; at the end of a job it waits for the recorder to close its last segment and flushes the
  rest (at most 60 seconds) before reporting `done`. The server signs one PUT per reported segment in the heartbeat
  answer's new `recording` field (only for a session that runs a job), counts a segment only after a HEAD shows its exact
  size, and gives only the job's owner 15-minute GET links, for 30 days after the job ended. A lifecycle rule on
  `recordings/` deletes them after 31 days (owner step). Interactive sessions upload nothing.
- **"Approve opens the PR (no server merge)".** Approve records when and answers the pull request's address (a
  `github.com` pull request or compare page, checked when the report names it) for the person's own client to open. The
  server writes nothing to any repository. A job cannot push yet: hostd's `/api/hosted/sessions/<id>/git-token` (A54's
  ask) is not built here, because a server-issued write token for a subscriber's repository needs the repository binding
  (A59) and a decision under S9, which allows server writes only where `.vector/ops.json` opts in.
- **"Recurring jobs on public pages only".** A recurring job names one to five https pages that pass S8's name and
  address rules, and no repository (no job carries one: the trigger's hosted-job target has none). Its prompt says to
  work only from those pages and never sign in; the browser profile is wiped after every job and the credential guard
  hands every sign-in to a person, so an unattended run cannot sign in. Times are UTC (minutes after midnight and
  weekdays); a run more than two hours late is skipped. An account keeps at most `recurringPerDay` recurring jobs.
- **§4.4.** Renewing: nothing new starts. Paused: the queue waits; a job still queued at its time is missed (reason
  `paused`). Frozen: queued jobs are cancelled; recurring jobs are kept but do not run while frozen, so a won dispute
  brings them back. Ended, no plan, or a plan without Done by Morning: queued jobs are cancelled and recurring jobs
  removed. Closing: everything is erased, recordings first. The runner also cancels a queued job whose plan stopped
  before any transition reached it.
- **Queueing** needs `overnight` listed or the account on `VECTOR_HOSTED_ALLOW_ACCOUNTS`, the `hosted` switch at `on`,
  no hold on the account's cloud computer and a plan with Done by Morning; a paused plan gets 402 `HOSTED_PAUSED`, a
  renewing one may queue.
- **New error codes** (§4.10 names none for jobs): `HOSTED_JOB_NOT_FOUND` 404, `HOSTED_JOB_LIMIT` 429 `{limit:
  "per-night" | "recurring-per-day" | "recurring", cap}`, `HOSTED_JOB_STATE` 409, `HOSTED_JOB_REFUSED` 403 `{reason:
  "source-unavailable"}`, `HOSTED_JOB_JUDGE` 409.
- **Store keys not in §4.6** (all under the Codium prefix): `hosted:jobs:item:<job>`, `hosted:jobs:account:<account>`,
  `hosted:jobs:live`, `hosted:jobs:running:<account>`, `hosted:jobs:session:<session>`, `hosted:jobs:claim:<job>`,
  `hosted:jobs:night:<account>:<date>`, `hosted:jobs:rday:<account>:<date>`, `hosted:jobs:recurring:<account>`,
  `hosted:jobs:recurring-due`, `hosted:jobs:rec:<job>`, `hosted:jobs:models:<session>`. §4.6's `hosted:jobs:due` holds
  queued jobs by their start.
- **Phone alerts.** A title-only alert, tag `overnight` (the phone app already routes it to the computer page), when a
  job is ready, did not finish or could not start in time; never the job's own words (P7).
- **Routes.** `/api/hosted/jobs/:id` serves jobs (`jb_…`) and recurring jobs (`jr_…`); cancelling is
  `POST {action: "cancel"}` for both.

## Lane status (8 Nov 2026)

From read-only GitHub queries (cited by run and job id only) and local git reads on 8 Nov 2026. This is package D1's
record: it changes docs only (no code, test or workflow) and has no notes file of its own. Earlier sections are
unchanged.

- **Latest green run.** Vector Codium run 42138157347 (push, head `5a079cbd`) passed all 14 jobs; its Codium tests job
  127631456285 finished at 2026-11-06T00:45:50Z.
  - Typecheck jobs: api 127631456479, schema 127631456592, core 127631456275, engine 127631456220, app 127631456492,
    desktop 127631456686, web 127631456454, cloud 127631456623, relay 127631456255, ops-worker 127631456407.
  - Codium tests 127631456285: the picker's 248 of 248 files passed on the step that sets `VECTOR_TEST_REDIS_URL` and
    `VECTOR_TEST_POSTGRES_URL`, then the HttpApi exerciser gates and `check:generated` passed.
  - Codium browser specs 127631456384; Remote relay dry run and local smoke 127631456398; Ops Worker dry run and
    miniflare smoke 127631455750.
  - Before this record was committed, the remote's `codium` was `5a079cbd` and its only `codium*` branch, and no later
    Vector Codium run existed.
- **The P7 failures it closed.** Run 42134490728 (head `d5975d28`, the P7 review): Codium tests job 127619053399 passed
  246 of 248 files, failing the Valkey cases of `test/on-call.test.ts` and `test/ship-desk.test.ts`; Ops Worker job
  127619054092 failed its miniflare smoke because the Workers runtime refused the string export `KILL_KEY` of
  `packages/ops-worker/src/index.ts` ("Incorrect type for map entry 'KILL_KEY'") and did not start. `025d75da` removed
  that export and fixed both Valkey tests. Its run 42136600777 passed the Ops Worker job (127626223269, the first
  passing miniflare smoke), but Codium tests job 127626223012 passed 247 of 248, failing
  `packages/core/test/vault/vault.test.ts`. `5a079cbd` changed only that test, so its prune count no longer depends on
  the vault's random chunking key, and its run is the green one above.
- **P6 and P5.** P6 run 41942473092 (head `aa35701e`) failed only in Remote relay job 126966440346, at its
  `wrangler dev --local` smoke step; its other 11 jobs passed, Codium tests job 126966439936 with 223 of 223 files.
  `31820732` kept the relay entry's `CONTROL_OBJECT` string module-private, and its run 41958430737 was green. P5 run
  41759865557 (head `0cef8b91`) was green.
- **Batched pushes.** A29–A35 (`f254efc5` to `298cc87f`) went up with the P5 head `0cef8b91`, A36–A43 (`12481086` to
  `fbc8ef1f`, A36 last) with the P6 head `aa35701e`, and A44–A50 (`305e45c9` to `01781909`) with the P7 head `d5975d28`.
  No Vector Codium run has one of those package commits as its head: after run 41272142017 on `d13d91e3`, the runs are
  on `0cef8b91`, `aa35701e`, `31820732`, `d5975d28`, `025d75da` and `5a079cbd`. Earlier records that say "Nothing was
  pushed" or "has not run in CI" describe their own day; the runs above are the first that include those packages.
- **test.yml and typecheck.yml.** Both run only on pushes to main, pull requests (typecheck.yml: to main) and
  workflow_dispatch. test.yml's latest run on codium is 41268039624 (workflow_dispatch, head `295ab95e`, 1 Nov,
  success), so no A29–A50 commit has run in test.yml. Its unit jobs run `bun turbo test` without the engine (the engine
  has its own shards), and `turbo.json` at `295ab95e` defines test tasks only for engine, core, app, ui and session-ui;
  unit (windows) job 124734865943 shows only the ui, core, app and session-ui test tasks. So
  `packages/client/test/import-boundaries.test.ts` and `packages/sdk/js/test/server-startup.test.ts` did not run there,
  and the "Not run anywhere" bullet of `codium-a21-contract-notes.md` still holds; it is left unchanged, although its
  last clause leaves out workflow_dispatch. typecheck.yml has never run on codium (no run listed for the branch).
- **vector-codium-e2e.yml has never run.** The file is on codium only (not on main) and is dispatch only. GitHub has no
  workflow registered under that file name (get_workflow answers 404) and no run of it. Running it needs the owner's
  `codium-test` environment (§8.2 steps 2 and 6).
- **The A30 drafts.** They exist only on the owner's Mac: branch `codium-legal` at `94a5004e`, unpushed
  (`codium-a30-legal-notes.md`, "Where the work is"). This clone has no such object and the remote no such branch. The
  lane does not recreate them.
- **Owner step 9 stopped after A28.** The last merge of codium into self-evolving is `d4402136` ("Merge codium A26-A28
  into self-evolving", parents `c3f7bed3` and `d13d91e3`), and `git merge-base origin/self-evolving origin/codium` is
  `d13d91e3`. The 29 commits after it, `f254efc5` (A29) to `5a079cbd`, are not in self-evolving (`git cherry` marks all
  29 `+`). Nothing was merged; the merge stays the owner's step (§8.2 step 9). A read-only
  `git merge-tree --write-tree --name-only` of self-evolving `f062bcce` and codium `5a079cbd` (the remote heads on 8
  Nov), with a throwaway object directory so no ref moved and no object entered the shared store, reports content
  conflicts in 7 files:
  - `packages/app/src/components/settings-v2/general.tsx`
  - `packages/app/src/components/settings-v2/memory-model.ts`
  - `packages/app/src/components/settings-v2/settings-memory.css`
  - `packages/app/src/components/settings-v2/settings-registry.ts`
  - `packages/app/src/context/settings.tsx`
  - `packages/engine/src/server/routes/instance/httpapi/handlers/memory.ts`
  - `packages/engine/src/tool/task.ts`
- **Phase reviews still to run.** P3 covered A17–A20 (`14bc7d42..a5cad27a`, `codium-p3-repairs.md`), P5 A29–A35, P6
  A37–A43 and P7 A44 and A47–A50 ("P7 review decisions" above). No phase review covers A21–A28 (P4;
  `codium-p4-repairs.md` does not exist yet), A36, A45 or A46; the next packages close them. A15 (`73cd78a4`) and A16
  (`071dfe37`) lie between P2's `d04a2808` and P3's range, so no recorded phase-review range includes them; each record
  names its own independent review (line 3 of `codium-a15-catalog-notes.md` and `codium-a16-callers-notes.md`). The
  order under "Next phase order and external gates" (A10–A14) is the order of its own day.
  - Status on 15 Nov 2026 (Codium finish R46b): A36 is covered by "P6 review addendum (15 Nov 2026)" (R36), and A45
    and A46 by "P7 review addendum (15 Nov 2026)" (R45a, R45b, R46a and R46b; `codium-p7-repairs.md`). P7 now covers
    A44–A50.
- **Records refreshed on 8 Nov 2026.** Eight records got one dated status line each: `codium-a17-admission-notes.md`,
  `codium-a17-context-decision.md`, `codium-a18-models-status-notes.md`, `codium-a36-playbooks-server-notes.md`,
  `codium-a40-remote-api-notes.md`, `codium-a44-vault-api-notes.md`, `codium-a45-desktop-vault-notes.md` and
  `codium-a48-release-guard-notes.md`. `codium-a46-ops-worker-notes.md` got a dated status sub-list under "Not done",
  and `codium-a21-contract-notes.md` was checked and left unchanged (above). A job log read through the lane's GitHub
  tools holds at most its last ~5,000 lines, so the files the picker runs before the middle of `packages/engine`
  (`packages/app`, `packages/core` and `packages/desktop` among them) are not visible in the P6 and P7 Codium tests
  logs; the A36 and A45 lines say so and leave the file-level result unconfirmed.
- **D1 readings.** The brief's A46 item named run 42138157347 for the passing miniflare smoke; it first passed one run
  earlier, in 42136600777 (job 127626223269), and the A46 status names both. The A44 line's Postgres path is an
  inference from the step's environment and `test/brain-vault-fixture.ts` (`vaultBackend` picks `PostgresVaultBackend`
  when `VECTOR_TEST_POSTGRES_URL` is set), since the job log names no Postgres marker for that file, and the line says
  so. Deferred: the other stale lines of earlier records, review coverage for A15 and A16, `MODEL-PLANS.md`, and A51
  onward. This record's own push and its Vector Codium run are recorded by the next package.
- **8 Nov 2026 (P4a).** Run 42439456526 (push, head `dc64a6a5`, D1's commit of this record) completed with success,
  all 14 jobs green. Its Codium tests job 128605353887 shows 248 of 248 picker files passing, the HttpApi exerciser at
  `pass=309 fail=0` and `check:generated` passing; the job ids are in `codium-p4-repairs.md` ("CI before this review").
- **8 Nov 2026 (P4b).** Run 42442788455 (push, head `46236dce`, P4a's commit) and run 42444316138 (push, head
  `3082bb2c`, another session's commit) both completed with success, 14 of 14 jobs each; each Codium tests log shows 248
  of 248 picker files passing, the HttpApi exerciser at `pass=309 fail=0` and "Check generated client" passing.
  typecheck.yml run 42444321838 and test.yml run 42444319661, both dispatched on `3082bb2c`, completed with success. Job
  ids are in `codium-p4-repairs.md` ("CI before P4b"). P4b repaired the research report's Spend line (F16) and hands on
  two findings it did not repair: F18 (the engine review model is never `costKind "codium"`, so the P5 review token stop
  can miss a Codium review) to P4d, and F28 (A41's phone usage alert can repeat while the desktop notification keeps
  failing) to the P6 addendum, the package that appends the A36 review to `codium-p6-repairs.md`, since A41 is in P6's
  range; both are under "P4 review decisions" below and stay open here until those packages record them. P4c adds a
  dated line here with the Vector Codium run id and conclusion for P4b's own commit, once that run has completed.
  15 Nov 2026 (Codium finish F28): F28 is closed; see `codium-p6-repairs.md`, "A41 phone usage alert (F28, P6
  addendum)", and the F28 bullet in "P6 review addendum (15 Nov 2026)" below.
- **8 Nov 2026 (P4c).** Run 42450985342 (push, head `c7b6376a`, P4b's commit) was queued when P4c began and completed
  with success, 14 of 14 jobs; its Codium tests job 128639976336 passed every step, and the last part of its log shows
  the last HttpApi exerciser gate at `pass=309 fail=0` followed by `check:generated` (the picker's file count was not
  read). Job ids are in `codium-p4-repairs.md` ("CI before P4c"); `origin/codium` was still `c7b6376a` when it was
  read. P4c repaired F43 (a sanitized export kept a lifecycle record's aggregate tokens) and F46 (a client edit through
  `PATCH` part.update could relabel step usage) and records its readings and hand-offs under "P4 review decisions"
  below. Its changes were left uncommitted for the lane lead, so its commit, push
  and Vector Codium run are recorded by the package that pushes them.
- **8 Nov 2026 (P4d).** Run 42457442687 (push, head `39db0daf`, P4c's commit, which the lead committed and pushed)
  completed with success, 14 of 14 jobs; its Codium tests job 128659369695 passed every step, and the last 290 lines of
  its log show the last HttpApi exerciser gate at `pass=309 fail=0` followed by `check:generated` (the picker's file
  count was not read). Job ids are in `codium-p4-repairs.md` ("CI before P4d"); `origin/codium` was still `39db0daf`
  when it was read. P4d repaired F60 (a mixed review's wording printed `vector-plan/<model>`) and F61 (P4b's F18: the
  engine review model was never `"codium"`, so the P5 review token stop could miss a Codium review), which closes F18.
  It records the A27 public-copy divergences as owner decisions O1 to O9 and two hand-offs to Codex (F63, F64) under
  "P4 review decisions" below. With P4d, P4 is closed for A21 to A28; its open items are listed in
  `codium-p4-repairs.md` ("P4 summary"). At the time of this record (8 Nov 2026) P4d's changes were not yet committed;
  the package that pushes them adds a dated line here with the commit sha and its Vector Codium run id and conclusion.
- **15 Nov 2026 (Codium finish, H1b review): open defect, a download-only start that cannot run is still charged.**
  H1a's start path (`startHostedDownload` in `api/_lib/hosted-sessions.ts`) holds and charges the block and the 14-day
  retention without knowing whether the computer's hostd signs its heartbeats. On a disk made before signed heartbeats
  every beat is refused (`requireDaemonBeat`, `hosted-sessions.ts:1412`), hostd stops, and the person gets no files
  after paying for them. It fails closed (no agent starts, S7 holds). Until a per-computer generation record exists, a
  later server package should not charge such a session for what it never delivered. The review proposed leaving a
  download start uncharged until its first accepted heartbeat, or releasing the hold when the session ends with no
  `readyAt`. Lane reading: M8 keeps the hold before the start and also charges every minute the computer ran at no less
  than cost, so the block's minutes stay charged (closed at the stop, as `endHostedSession` does). What can wait for the
  first accepted heartbeat is the retention charge, which already goes uncharged when no download start happens (P8).
  Ending the session at its first refused beat keeps those minutes short. Who pays a download start's block stays the
  owner's question (H1a). No H1b code change. The owner bullet in `owner-actions/hosted-computer.md` stays; tracked in
  `codium-a53-hosted-sessions-notes.md` ("Not done") and "Codium finish: H1 computer (15 Nov 2026)", O6.
- **15 Nov 2026 (Codium finish, H1c).** The client half of H1 is built in the working tree, not committed by its build
  step: the desktop's bar and the phone's Cloud computer page offer an ended plan's kept files, from a new `kept` field
  on `GET /api/hosted/status`. Two deviations from the package text are for the lead: D1 (an account on
  `VECTOR_HOSTED_ALLOW_ACCOUNTS` sees nothing in the clients before `computer` is listed) and D2 (H1c, not H1a, adds the
  hosted API field `kept` to `GET /api/hosted/status` and the `Hosted.KeptDisks` type, against the lane rule that only
  H1a adds a hosted API field; the lead accepts it or sends the field back to H1a). Its Vector Codium, typecheck.yml and
  vector-hosted-ci.yml runs follow the lead's commit; H1c is done only once they are green. See "Codium finish: H1
  clients (15 Nov 2026)".
  15 Nov 2026 (Codium finish H2a): H1c's three runs are green under the lane's baseline rule (Vector Codium
  43760889035, typecheck.yml 43760891870, vector-hosted-ci.yml 43761604770); receipts at the end of "Codium finish: H1
  clients (15 Nov 2026)".
- **15 Nov 2026 (Codium finish, H2a).** The server-side image floor is built in the working tree, not committed by its
  build step: each computer keeps the generation its daemon last reported in a signed beat, and with
  `VECTOR_HOSTED_MIN_GENERATION` set a job start passes over or refuses (409 `HOSTED_REBUILD_REQUIRED`) a computer
  below it before any lease, hold or provider call. Download-only starts, running sessions and renewals are exempt;
  nothing rebuilds a disk on its own. Its Vector Codium, typecheck.yml and vector-hosted-ci.yml runs follow the lead's
  commit; H2a is done only once they are green. See "Codium finish: H2 generation floor (15 Nov 2026)".

## P4 review decisions (8 Nov 2026)

Contract readings from P4a's review of A21 and A22 ([codium-p4-repairs.md](codium-p4-repairs.md)), which changed no
source. P4b, P4c and P4d add theirs below.

- **A21's done criterion covers the client only.** Spec §5 A21's "Done: `check:generated` green" checks
  `packages/client/src/generated` and `src/generated-effect`. `vector-codium.yml` has no drift check for the legacy SDK
  (`packages/sdk/openapi.json`, `packages/sdk/js/src/gen`, `src/v2/gen`), which A21 also regenerated. That half was
  verified here by running `./packages/sdk/js/script/build.ts` at `dc64a6a5`: it left `packages/sdk` unchanged, with no
  untracked file, although A49 and P7 had changed schema and server source since the last regeneration (A45). Packages
  that change the public schema keep running both generators (AGENTS.md); an SDK drift check in CI would be a workflow
  change of its own.
- **Ancillary usage is still only added.** The A21 and A22 decisions let AncillaryUsage route on its model's provider id
  because nothing subtracts it; at `dc64a6a5` that still holds (`projector.ts:662-686` only adds).
- **A failed V2 compaction stays counted.** Compaction.Failed (`projector.ts:700-718`) adds the usage it reports, Codium
  or not, and creates no row, so no revert takes it back. §4.2's "revert, removal and moves keep working" applies to
  the records that have rows: steps, parts, messages and compaction summaries. The provider bills the failed request
  too (`compaction.ts:245`).
- **`Billing.Kind` is a closed literal.** It decodes only `"codium"`, and a record carrying any other `billing` fails to
  decode as a whole (`billing.test.ts`, "a billing value other than codium is refused", six schemas). A second billing
  kind therefore needs a decoder that tolerates unknown kinds, released before any writer of the new kind, as §6 asks
  of cost kinds.
- **The stored-flag rule governs the totals.** The A21 decision "Accounting reads the stored flag, never `Billing.of`"
  and the A22 decision "Records are routed by their own stored flag on both sides" cover cost, unpriced steps,
  `codium_steps` and tokens, and hold at `dc64a6a5`. The own-only provenance bit that A25 added beside them
  (`knownOwnOnly`, `tokens_own_only`) is a separate proof that reads the provider id through
  `Billing.hasOwnIdentity`, the same way when a record is added and when it is subtracted; P4c reviews it with A25.
- **`Billing.of` is for display, and it also answers for a V1 user message.** It reads `model.providerID`, which V1
  user messages carry, so a caller that means assistant work filters by role first. Aggregate callers that read a
  session's `model.providerID` do so on purpose, as §6's fallback for an older engine. A21 and A22 added no caller;
  P4b to P4d check the A23 to A28 callers.
- **Database downgrade (label plan §6, accepted).** An engine without A22 reads a flagged step as an ordinary one. When
  it reverts or removes such a step, it subtracts the step's stored tokens, which were never added, and one unpriced
  step, and leaves `codium_steps` alone. In a Codium-only session the token totals then go negative (`SessionTokens` is
  `Schema.Finite`, so nothing fails to encode), and after an upgrade `codium_steps` can exceed `unpriced_steps`,
  against the A22 decision's `codium_steps ≤ unpriced_steps`. No clamp is added (A21 decision); only the owner's test
  sessions hold Codium steps. No reader shows the difference below 0: `CodiumUsage.ownUnpricedSteps`
  (`packages/core/src/codium-usage.ts:13-15`) clamps it with `Math.max(0, …)` for the TUI and app surfaces, and the
  task note (`packages/engine/src/tool/task.ts:316,342`) prints its pricing sentence only when it is above 0. In such a
  session the clamp can hide an own unknown step. Nothing about the downgrade is handed on.
- **An unknown cost kind on self-evolving is a hand-off (F6).** Label plan §6 asks the self-evolving branch to decode a
  persisted cost kind it does not know as `"unknown"`. At `origin/self-evolving` `e0bfa00b`, `RunBudget.CostKind` is
  still the closed literal (`packages/schema/src/run-budget.ts:26` there) and `Task.BudgetScope.costKind` reads it
  (`packages/schema/src/task.ts:46` there), so a newer kind still fails the decode of a record's `budgetScopes`. The
  codium lane does not change self-evolving; this is handed to the self-evolving lane and owner step 9.
- **The public share keeps the raw model id in its model-switched notice (F10).** `publicArchive` writes
  `Model changed to <providerID>/<id>` (`packages/core/src/share/archive.ts:121` at `dc64a6a5`, already there at
  `4fde1a49`), so a shared Codium session shows `vector-plan/<model>`. It holds no amount, token figure or plan tier
  name, and label plan §3.7 leaves the public share unchanged, so it is accepted here; any change of that wording is
  label-surface copy for P4d.

P4b's readings, from its review of A23 and A24 (`4fde1a49..b4c05481` and the A24 follow-ups; findings F16 to F34 in
`codium-p4-repairs.md`):

- **The research Spend line follows label plan §3.2, not the A23 wording (F16).** §3.2 says a Codium-only report has no
  Spend line and a mixed one reads `$0.12 at list prices + Codium`; A23 wrote `- Spend: Codium`, and the V1 judge's
  re-save (`packages/engine/src/session/prompt.ts:1230-1233`, which the label plan does not list) dropped `+ Codium`.
  The contract wins. All three writers now call `SpendGuard.reportSpend` in `packages/core/src/spend-guard.ts`, beside
  `formatUsd`. The helper is not in `research/report.ts`, a pure renderer that would then load the guard, the event
  module and the database through it, and not in `codium-usage.ts`, which the app imports. Reports saved before the
  repair are not rewritten: one keeps `- Spend: Codium`, or a judged mixed one its line without `+ Codium`, until its
  run saves another version.
- **F16's tests reach beyond the brief's file list.** Besides `packages/core/test/spend-guard.test.ts` (listed), one
  case each went into `packages/core/test/session/research-v2.test.ts`,
  `packages/engine/test/tool/research-note.test.ts` and `packages/engine/test/session/research-judge.test.ts`, which the
  list does not name: the helper's own cases would still pass with any call site put back to its old expression, so each
  writer needs a test that saves a report. The engine cases record their Codium step in the test's guard rather than
  running a Codium provider turn, because Codium's destination is fixed (label plan C5); they prove the writer's reading
  of a real guard snapshot. The core V2 case runs the scripted research on a `vector-plan` model, so its steps are
  Codium by the runner's own classification. P4b's plan had put the helper in `research/report.ts` with cases in
  `research/report.test.ts`; both moved to the guard and its listed test file, for the reason above.
- **Known-Codium desktop runs carry no desktop budget (F19).** A subagent of such a run on its own configured model
  spends own-key dollars that the desktop windows do not stop mid-run, since no `budgetUsd` is sent. That spend is
  measured afterwards, counts in the windows and blocks later own-key runs, and the engine's own caps still apply.
  Accepted: D-3 and C8 say the desktop "neither blocks such a run … nor reserves `budgetUsd`", and the A23 decision
  records why no `usd: 0` budget is sent (the budget schema is strictly positive, and headroom checks would refuse
  it).
- **Check-ins rely on `summarizeUsage` (F20).** `UsageReport.fromSummary` adds no `vector-plan` filter of its own: both
  senders read the bundled engine, which already leaves Codium out, and label plan §6 rules out skew between desktop
  main and engine.
- **Turns that end during a pending refresh share it (F27).** The 15-second read after a Codium turn is coalesced: turns
  ending while it is pending get that one read, and a debit that lands later shows at the next focus or Refresh. Spec
  A24 asks for one refresh after a turn ends, not one per turn.
- **The Host locally exemption is the dashboard's label only (F30).** `9c5bc861` lets `agent-dashboard-model.ts` keep
  its `CodiumUsage` import, its two `billing?: "codium"` declarations, its `billing === "codium"` branch and its
  `withCodium` call, and renames the test to "have no account or plan access". Label plan §3.1 and §3.2 (the agent
  dashboard row) and C7 (`features/agents/agent-dashboard-model.ts:241-250`) put that label in this file; any other
  Codium, account, credits, pricing or plan text there, or anywhere else in the agents feature, still fails the test.
- **`Billing.of` callers from A23 and A24 read assistant work or a session on purpose (F34).** Each filters to assistant
  messages or their parts first, or reads a session's or favourite model's provider id as label plan §6's fallback.
  `reviewProgressSpend` (`features/pull-requests/ai-review.ts:1600-1602`) also reads the review prompt, whose model is
  the pass's own, so it gives the same answer; the rest of `ai-review.ts` is A26's and P4d's.
- **Hand-off to P4d (F18).** `packages/engine/src/review/model.ts:128-135` calls `costKindOf` without `codium`, against
  label plan §4.3, so `resolveReviewModel` never answers `"codium"`. A Codium review with an explicit `triageModel`,
  with no listed review roles, or with a same-lab pair never applies `CODIUM_REVIEW_TOKEN_STOP` (`review/run.ts:400`),
  and its unused or empty run reports `"unknown"` (`run.ts:310,339`). Repair:
  `codium: Billing.isCodium(model.providerID)` in that call, with a `test/review/model.test.ts` case and a
  `panel.test.ts` case that reaches the stop with an explicit `triageModel` without building `costKind: "codium"` by
  hand. Not done in P4b: label plan C11 (spec A26) owns `review/model.ts`, and the repair changes review budgets and
  footers and the P5 stop. It needs no Codex-owned file: `github.review.ts` keeps calling `resolveReviewModel` as it is.
  8 Nov 2026 (P4d): repaired as F61 (R1) in `packages/engine/src/review/model.ts`; see `codium-p4-repairs.md`, "A26
  review footer", and P4d's readings below.
- **Hand-off to the P6 addendum (F28, A41).** In `packages/app/src/components/settings-vector-codium.tsx:66-100` the
  phone usage alert (A41, `4caf1073`) is sent before the desktop notification, and a failed desktop `notify` removes the
  dedupe key, so while it keeps failing every later run of that effect with Usage open sends the phone alert again. The
  effect runs again when a status read changes a value it reads (the share left moving from 19% to 18%, or a good read
  after a failed one); `reconcile` leaves an unchanged read silent. A24's desktop path (off by default, one alert per
  account, plan and renewal, retry after a failed notify) is as spec A24 asks. The A41 interaction is outside P4b's
  range and past the P6 review, so it goes to the P6 addendum (the package that appends the A36 review to
  `codium-p6-repairs.md`). Its regression test: both switches on, the desktop `notify` rejects on two status reads whose
  share left differs (19% then 18% left), and exactly one `sendPhoneAlert` call (one `phoneAlerts.send`) is expected.
  15 Nov 2026 (Codium finish F28): repaired, with that regression; see `codium-p6-repairs.md`, "A41 phone usage alert
  (F28, P6 addendum)".

P4c's readings, from its review of A25 (`b4c05481..295ab95e`; findings F35 to F56 in `codium-p4-repairs.md`, section
"A25 output boundaries"):

- **A sanitized export strips the lifecycle record's aggregate tokens whatever its proof (F43).** C10 and the A25
  decision say editable lifecycle metadata never authorizes printed aggregate tokens, so `sanitizeLegacy` passes
  `metadata.subagent` through `taskMetadata`, the walker run JSON uses; a proven `info.tokens` stays beside it. Only
  `metadata.subagent` is walked: the rest of session metadata is the caller's (any client sets it through
  `PATCH /session/:id`), and walking the whole object would strip figures under unrelated root `usage` or `tasks` keys
  and add a `metadata` key a session lacked. The walker keeps its name and only gains `export`, so the self-evolving
  merge, which edits the same function (its `workflow` branch) and `sanitizeLegacy` (`...data,`), still merges both
  files cleanly. The raw export is a backup under D-2 and is unchanged.
- **Hand-off to self-evolving: a sanitized legacy export there carries `ancillaryUsage`.** At `origin/self-evolving`
  `a03b9718`, `sanitizeLegacy` starts its result with `...data,` ("The privacy, guest-input and usage markers travel
  with the archive"), so its output keeps the archive's `ancillaryUsage`: `SessionEvent.AncillaryUsage` records of
  title and memory model calls, with `billing` and `tokens`. After the codium-into-self-evolving merge, Codium title
  and memory tokens would print in a sanitized export. The self-evolving lane or the owner's step-9 merge resolution
  must leave `ancillaryUsage` (or at least its `tokens`) out of the sanitized output. The new `export-sanitize.test.ts`
  case "ancillary usage stays out, so Codium title and memory tokens never reach a sanitized export" passes on codium
  and fails on a merged tree that keeps the spread, so the merge sees it. Self-evolving's `setPublicMetadata` keeps
  clients from replacing `metadata.subagent` there, but F43's strip is still needed on that branch for genuine records
  that copied flagless Codium tokens. The codium lane does not change self-evolving.
- **`vector stats` keeps its own-text formatter beside Codium (F40), an accepted A25 reading.** Label plan §2's table
  reads `Cost unknown + Codium`, `free + Codium` or `ChatGPT plan + Codium` when the own work beside Codium is
  unpriced, free or plan work; stats prints `$0.00 + Codium`. §2 also keeps each surface's own-text formatter and wraps
  it with `withCodium`. Stats' formatter has always printed `$X.XX`, so an own-unpriced session without Codium reads
  `$0.00` too (the "No Codium: unchanged" row), and §3.6's `vector stats` row gives the mixed form as
  `$12.40 + Codium`. Printing "Cost unknown" only beside Codium would split one formatter by Codium presence, and
  changing it for every session is outside C9. Stats could detect the unknown case from `unpriced` and the session
  counts; free and plan work cannot be told apart in stored data. It is A25's surface, not copy for P4d.
- **`part.update` refuses edits to step usage (F46), repaired.** The brief's check that "a client-supplied provenance
  flag cannot relabel own-key usage as Codium or the reverse" is read to cover a step-finish part's `billing` flag and
  its figures sent through `PATCH /session/:id/message/:messageID/part/:partID`, not only the session proof flags (F45),
  since the engine trusts token provenance only from its own writes. Readings: (1) the guard is in the HttpApi handler,
  not in `Session.updatePart` or the projector, because the engine's processor writes steps through
  `Session.updatePart`, and replay and import, which reach the projector, already invalidate the proof; (2) usage is
  `type`, `billing`, `cost`, `unpriced` (absent and `false` read alike) and `tokens`, so an edit to a step's `reason` or
  `snapshot` still passes; (3) a part sent under another session or message than the one it is stored under is refused
  whatever its type, since the projector never moves a stored row and an accepted move only re-routed figures; (4)
  creating a step-finish part through `PATCH` is refused and creating any other part is not; (5) `BadRequest` was
  already in the endpoint's declared errors, so no HttpApi shape changed and no client or SDK was regenerated. A review
  of P4c's uncommitted first draft found this entry reading the edit path as "accepted for now" with a fix that needed
  regeneration; both were withdrawn before commit.
- **A run with no readings is unmeasured (F48).** When the guard read and the session read before the run both fail,
  `measuredRun` has no Codium evidence (the before count is unknown, and a modern row carries `codiumSteps`, so the
  legacy fallback does not apply), and the run is recorded once as unmeasured whatever its model, as before A25. No
  change: C8 rules out a dollar event for a known Codium-only run, and this run is not known to be one.
- **The A25 notes' `975b523b` run is unverifiable (F54).** The brief says the commit "does not exist on the remote".
  GitHub still serves the object, but no branch holds it and the lane clone lacks it; its change, author and author
  date match `d505d566`, which was committed again onto `4bc40a87` after run 41261226062 was created, and the commit
  API gives no parent to compare its tree with codium's A24 source. The notes' line 3 stays as written, under a dated
  status paragraph, and the claim is not repeated.
- **Privacy hand-off to the lead (F44), open.** `--sanitize` keeps the lifecycle record's text fields (`title`,
  `resultSummary`, `reason`, `error`, `successCriteria`, `ownedPaths`, `dependsOn`, `resultRef`, `batchID`,
  `notification.text`, `mailbox[].text`) and other client metadata. It predates Codium and C10 covers only Codium
  figures, so it is a separate task, not a P4 repair. Its target: in `sanitizeLegacy`, after `taskMetadata`, redact
  those string fields of `metadata.subagent` with the existing `redact()` (or pass non-lifecycle metadata through
  `data("session-metadata", ...)`), with an `export-sanitize.test.ts` case asserting a steer prompt's text is absent.
  P4c's attempt to queue it as a task suggestion timed out without a task id, so it stays with the lead's queue.
- **The brief's server file (F56).** The brief names `packages/server/src/handlers/session.ts`; A25 changed
  `packages/server/src/handlers/event.ts`. Both were read and neither needed a change.
- **The WP31 note guard is on self-evolving (F38).** `TaskNotify.render` at `a03b9718` (`task/notify.ts:180` there)
  prints tokens only with `tokensOwnOnly === true`. The A25 notes' other WP31 obligations (combined own and delegated
  proof in workflow usage, `WorkflowOwner.get.report`, `WorkflowReport` text and `workflow.tokens`) were not audited
  here and stay with the integration.
- **Range.** `git log b4c05481..295ab95e` also holds the test-only `44c35f1c` and `9c5bc861`, which P4b reviewed with
  the other A24 follow-ups; P4c read `d505d566` and `4bc40a87` only for the A25 notes' claims.

P4d's readings, from its review of A26 to A28 (`295ab95e..d13d91e3`; findings F57 to F78 in `codium-p4-repairs.md`,
sections "A26 review footer", "A27 copy and listing" and "A28 account page"):

- **F61 is repaired in `review/model.ts`, not in Codex's file.** Label plan §4.3 and C11 give the engine review cost
  kind to `packages/engine/src/review/model.ts`, which spec A26 owns, so `resolveReviewModel` now passes
  `codium: Billing.isCodium(model.providerID)`. `github.review.ts` keeps calling it as it is, so GitHub Codium reviews
  now meet the P5 token stop too. The repair adds the stop for a Codium review with an explicit `triageModel`, with no
  listed review roles and with a same-lab pair, and an unused Codium run reports `"codium"`. It also removes the dollar
  price, the dollar cap, the CLI's dollar estimate and the dollar estimate in a GitHub review's "too large" note from a
  Codium model that has a catalog price; the catalog ships Codium models unpriced (`provider.ts:1806`), so that case is
  defensive, and label plan §2 rules out dollar figures for Codium work. Step and time limits are unchanged.
- **Mixed review wording renames only the Codium model (F60).** Each Codium model of a mixed review's model list reads
  `Vector Codium · <model>` (label plan §2), and the existing `<models> · <own figure> + Codium` layout stays, as in
  the app's per-pass lines (`ai-review.ts:1889-1891`):
  `anthropic/claude-sonnet-4-5 + Vector Codium · vector-velocity · $0.21 + Codium`. With `·` as the separator,
  `$0.21` follows the Codium model, so it could be read as that model's cost; a layout with a figure per model would be
  a separate change, and the tests pin the exact strings so any reorder is deliberate. The figure is own-key spend, so
  P1 holds; the review of P4d's repairs agreed and asked for no change. If the owner or the label plan wants an
  unambiguous layout later, the own figures move next to the own models
  (`anthropic/claude-sonnet-4-5 · $0.21 + Vector Codium · vector-velocity · Codium`) and the exact-string pins in
  `format.test.ts`, `review.render.test.ts` and `codium-no-figures.test.ts` change with it. The pattern is built from
  `Billing.CODIUM_PROVIDER_ID` (label plan C1). `vector review --json` keeps the raw id: it is machine output, and
  §3.4's JSON row is `{ kind, model }`.
- **The public share's notice is an owner decision (O9, P4a's F10).** P4a accepted it under label plan §3.7. §3.7 keeps
  billing, token and cost fields out of `PublicSession` and says nothing about the notice's text, while §2 says
  `vector-plan` is never printed as a provider name; as label-surface copy it goes to the owner with the other copy
  findings. No change.
- **Public-copy divergences are owner decisions (F71, O1 to O8).** The brief allows wording changes only towards text
  the contract states verbatim, and the contract's own text is not safe to adopt: §1.3's Plus variants 1 and 2 and
  Ultra variants 1 and 2 conflict with H4, and its fallbacks name models that are not served while `ROUTE_ACCEPTANCES`
  is empty. So nothing was changed, the spec's text was not adopted either, and each item records what changes for
  either answer.
- **A27's Velocity and Labs claims stay open owner decisions (O4, O5).** The deviation "A27 public presentation" cites
  an approved owner override for "planned 550B+" and an "explicit no-Labs scope". No lane document holds either, and
  `codium-p5-repairs.md` lists both ("Vector Labs on the pricing page", "the 550B Velocity wording") as pending. H2
  bans a parameter count, and the lander (`Lander.astro`, `landing-copy.test.ts:183-189`) and investor page
  (`test/investor-page.test.ts:177-201`, whose README guard bans "Planned" and `\d+B\+`) word Velocity differently
  again. P4d changes none of it.
- **The listing's staleness bound is accepted (F66).** `listedPerks` fails closed on any read error, but a value read
  just before an outage stays for the 30 s switch cache plus the config route's `s-maxage=60` and
  `stale-while-revalidate=30`, about 2 minutes in all; a switch never written reads `on` (A11). Both are read as A11 and
  §4.14 behaviour; tightening the route's cache is the owner's one-line call.
- **Hand-offs to Codex (F63, F64).** `github.evidence.ts`'s `formatCost` omits "on your keys" from the mixed line (label
  plan §3.8) and prints `$0.00 + Codium` beside own free work (§2); `github.review.ts:692-695` logs
  `Spent $0.0000 + Codium` while own steps have reported $0. Both files are Codex's (spec §0.5) and were not edited. The
  proposed regressions are in the repairs doc; no test was added here, because it would fail until Codex repairs them.
- **Test placement (F78).** R1's regressions are in `packages/engine/test/review/model.test.ts` and `panel.test.ts`,
  the two files P4b's F18 named; the brief's list has no engine review-model test file. The panel case puts the
  resolver's kind on the file's loopback models, which run the passes, with a mock layer of only the four services
  `resolveReviewModel` reads (Provider's `getModel` and `line`, Config, Auth, ModelCatalog). `model.test.ts`'s own
  service layer is private to that file, and test files do not import each other, so the case builds its four mocks
  rather than reusing it.
- **The panel case stays, retitled (P4d review).** The review of P4d's repairs found that the panel case mostly
  repeats `model.test.ts` (the resolver's `"codium"` answer) and the existing "on Vector Codium the check and the judge
  do not start past the stop" case, builds a mock layer, and was titled "explicit triageModel" while its triage model is
  the `FIRST` fixture with the resolved kind copied onto it. It is kept, as P4b's hand-off asked for a `panel.test.ts`
  case that reaches the stop without writing `costKind: "codium"` by hand, and it fails against the previous source
  (the kind was `"unknown"`). Its title now says what it checks: "the kind resolveReviewModel returns for a Vector
  Codium model is the one the runner's token stop reads". Its mocks follow `model.test.ts`, which mocks the same
  services. A real Provider with a Codium listing can be built the way `test/provider/model-plans.test.ts` does (the
  core `codium-gateway` fixture, with its own FreeModels and ModelPlans service stand-ins and a gateway server), which
  is more setup than this one case needs; P4d left that as it is. Neither test drives the CLI or GitHub caller from the resolver into `Review.run`; F78 records that gap and why no
  end-to-end case was added (the caller harnesses fake both ends, and Codium's fixed destination cannot be served by
  the loopback LLM server).
- **A27's commit message lists no `api/_lib/model-plan-*.ts` edit (F67).** `4e993a62` edited
  `api/_lib/model-plan-config.ts` (an export) and `api/_lib/model-plan-status.ts` (the listing and its cache check),
  and its one-line message lists neither, against spec §0 item 5. Pushed commits are not amended, so the list is
  recorded in F67.

## A56 Hosted clients and budget workflow (9 Nov 2026)

- **The live view is its own window, not a pane in the app's window.** The contract names a "live-view pane (sandboxed
  webview)". Vector's app windows carry the preload with the whole IPC bridge and keep `webviewTag` off, as the billing
  and research windows do. A separate `BrowserWindow` (`packages/desktop/src/main/hosted-window.ts`) gives the same
  isolation with less reach: no preload, `sandbox`, `contextIsolation`, no `webviewTag`, an in-memory partition per
  session (`vector-live-view-<id>`, cleared on close), every request outside the computer's own viewer origin cancelled
  (https page, wss socket), new windows, downloads, title changes and every permission refused, and Vector Local's
  `cloud-computer` source applied to its session. One window per session; asking again (control after a take-over)
  loads the new link in it. Its background, and the viewer page's own frame, are the purple edge.
- **Files outside A56's list.** `packages/app/src/features/cloud/hosted/` (`hosted-requests.ts`, the only requests the
  screens may send and the only links they may open, exported as `@vectordevai/app/hosted`; `hosted-model.ts`, lenient
  decoders and copy; `hosted-composer.tsx` and `hosted.css`, the button, the bar and the dialogs), the composer
  (`components/prompt-input.tsx`: one hook, the bar, and the button beside attach in both layouts), the desktop bridge
  (`ipc.ts`, `preload/index.ts`, `preload/types.ts`, `renderer/index.tsx`, `context/platform.tsx` `HostedPlatform`),
  `egress-filter.ts` (a `cloud-computer` session kind), core `local-mode/sources.ts` and the app's source name,
  `api/_lib/hosted-handoff.ts` and its registration in `hosted-jobs-runtime.ts`, `api/_lib/hosted-sessions.ts`
  (`listHostedSessions` adds `handoff`), `packages/schema/src/hosted.ts` (`SessionView.handoff`), the phone's
  `phone.css`, `packages/cloud/src/hosted-budget.ts`, docs and tests.
- **"Vector needs you".** A54 hands the computer to the person when its credential guard meets a password, one-time-code
  or card field or a CAPTCHA, and reports only the reason. A running session's view now carries
  `handoff {reason, since}` (not during a take-over), and the screens ask the person to take over. The heartbeat's route
  sends one title-only phone alert per new hand-over ("Vector needs you on its cloud computer", tag `computer`, P7): a
  hand-over whose `since` is the beat's own time. So the cloud computer is now one of the server senders A38 said `alerts`
  should wait for.
- **Done by Morning has screens here.** A55 left its screens to A56, whose list does not name them. The start dialog has
  a Done by Morning tab (success criteria, "aims to deliver by" a local time within the next day) while `overnight` is
  listed; a jobs dialog lists jobs, reports, the second lab's verdict per criterion, recording links (owner-only R2
  links, opened in the browser) and Approve, which asks the server for the pull request's address and opens it in the
  browser (S9: nothing merges). The phone shows the same list.
- **The phone does not start or queue jobs.** The pre-start ceiling comes from `/api/model-plans/estimate`, which takes
  account and run tokens only ("a browser session is not an estimate caller"), so the phone could not show it. The phone
  watches, takes over, gives back, stops, fetches files and handles jobs; starting stays on the desktop, which shows the
  ceiling first. Links the server gives the phone (the live view, files, a pull request) open as links the person taps
  (`rel="noopener noreferrer"`), because a link opened after a request may be blocked as a pop-up on iOS.
- **Polling.** Every composer in a window shares one status reader: every 15 seconds while a session is live, every 60
  seconds otherwise, never while the window is hidden. The status route allows 600 reads an hour per account.
- **The budget workflow talks to Vercel through its CLI.** Vercel documents no REST endpoint for the Spend Management
  amount; it documents `vercel billing budgets inspect|set` (3 Nov 2026), earlier `vercel budgets` (changelog of 23 Oct
  2026), with the Owner or Billing role. The contract's "never `--pause`" names that CLI's flag. The script passes only
  `--amount`, `--json`, `--scope` and `--non-interactive` (anything else throws), tries both command forms (a usage
  error moves to the next), and pins `vercel@65.3.1` (published 26 Oct 2026, the newest at least two weeks old). Vercel
  documents only the table's columns, so the JSON is read leniently (`amount`, `spent`, nested under `budget` or the
  team entry of `budgets`, `…Cents` fields divided); anything unreadable fails the run without a change. Whether 65.3.1
  has `--json` on `inspect` is not verified here; the first dispatch shows it.
- **Readings of the budget formula.** "Never lowers within a cycle": the formula is max(current, …), so the workflow
  never lowers the budget at all; lowering is the owner's. "The rest of the cycle": Vector does not know the hosted
  team's billing cycle, so the owner names its start day in `VECTOR_HOSTED_BILLING_DAY` (1–28) and the cycle ends on
  the next such day, UTC; the server's worst case already counts the periods that start before then. Dollars are summed
  in whole cents and the result rounded up to whole dollars (the CLI takes whole dollars).
- **Additions to protect the owner.** A required ceiling, `VECTOR_HOSTED_BUDGET_MAX_USD` (not in the contract): the
  workflow never sets more, and a capped run fails so the owner sees it. It refuses to create a budget (the owner creates
  it with its spend webhook first), confirms the new amount by reading it back, and prints no amount, because this
  repository's Actions logs are public. It runs only from the default branch, and a guard job without secrets first
  checks that `hosted-production` has a required reviewer, so each daily run waits for the owner's approval.
- **A57 work left in the tree.** The earlier A56 attempt's tree also held account-deletion work written on 6 November:
  `api/_lib/codium-erase.ts`, `codium-tombstone.ts`, `api/account/deletions.ts`, and edits to `api/account/delete.ts`,
  `api/_lib/codium-provision.ts` (`forgetAccountOutbox`), `model-plan-account.ts` (the tombstone checks),
  `ops-cleanup.ts`, `ops-worker.ts` (`opsErasable`), `vercel.json` (the deletions cron), `test/account-delete.test.ts`
  and `packages/web/test/codium-configuration.test.ts`. That is contract A57's file list and P5, so it was neither
  reviewed as A56 nor committed: it stays uncommitted in the working tree for A57.

## A57 Account deletion (9 Nov 2026)

- **Started from the 6 November draft.** The account-deletion work an earlier attempt left uncommitted (see the A56
  entry) was read through, kept, corrected and finished here; nothing in it was reverted.
- **How the start and enqueue paths "check" the tombstone.** Checkout and plan changes read the tombstone themselves,
  because they can run for an account with no snapshot. Reconcile reads it, so no notification, sweep or request can
  reopen the account, and once its records are erased it answers `ended`/`closing` without writing anything back.
  `readEntitlement` reads it when the snapshot is gone, so every `requireEntitlement` caller gets 409
  `MODEL_PLAN_ACCOUNT_CLOSING`, not "no plan". Every other start or enqueue path (chat, hosted starts and jobs, Remote
  tickets, vault writes, push, ops, the vote, Release Guard and Ship Desk intake) sees the tombstone through the closing
  snapshot, which the deletion writes in the same request right after it revokes the account's tokens. Those paths do
  not read the tombstone key, so chat and status pay no extra store call. If the closing snapshot cannot be written (the
  store or the billing lease is unavailable), the deletion stops there with the tokens already revoked, and the cron
  retries it; until then services keep the account's last snapshot.
- **Order.** The contract fixes tombstone, then billing, then erase. Tokens are revoked first, then the snapshot is
  closed, then billing is cancelled, so a deletion stopped at the close step still leaves the CLI and desktop tokens
  dead. A failed close answers `BILLING_DELETION_FAILED`, as a failed billing step did before.
- **The cleanup cron is a new route**, `GET /api/account/deletions` (every 10 minutes, `CRON_SECRET`, in `vercel.json`);
  §4.19 names no deletion cron. It continues each unfinished deletion from its stage, backs off from 10 minutes to
  6 hours, and emails the owner after six failed passes (account id and part names only). Fifteen minutes after the
  identity is gone it runs every erase part once more, for anything a request already past its checks wrote, then
  finishes the deletion.
- **Store keys beyond §4.6.** `tombstones:due` (a sorted set of unfinished deletions by due time) and
  `tombstone:<account>:lease` (one deletion run at a time per account, 2 minutes). The tombstone holds times, a pass
  count, the stage and the ids of failed parts only (never an email or an error message), has no expiry while the
  deletion runs, and is kept 180 days after it finishes, past Stripe's retries, the replay window and the usual dispute
  window, so a late notification cannot write a record back.
- **The erase marker** is the tombstone's `erasedAt`, written only after every configured part succeeded. The identity
  is deleted only after it. Usage counts are erased before the identity, as before; a failure there is reported, not
  retried.
- **What is erased beyond the contract's list, and what is kept.** "Snapshots" is read as the cloud computer's saved
  disks (deleted at the provider by A52/A53's erase) and the entitlement snapshot (deleted with the account's own
  records). The account's own records also include its billing record, status cache, reconcile mark, collection pause,
  in-flight set, place in the period-end index, waiting outbox items and dead letters, and the provisioners' applied
  versions. A last part, `keys`, deletes every other key in the server's erase modes whose name carries the account id
  as a whole word: per-period meters, cached estimates (A18's hand-off), the cloud computer's hourly and daily fair-use
  counts, Done by Morning's nightly counts, the no-run spend counter, and anything a later package keys by the account.
  It is one SCAN over the store with a MATCH glob (the hosted ledger's erase already scans this way), stops at the
  request's deadline, and is finished by the cron if the store is too large for one pass. Kept on purpose, as P5's
  pseudonymous ledger lines: the hosted ledger's lines (HMAC of the account), the pool debits
  (`debits:<account>:<keyHash>`) and the spend counters keyed by the pool's hash (`held:`, `day:`, `purpose:`,
  `model-spend:`, `model-reservations:`), all expiring with their period; also the run-token revocation mark (35 days),
  the billing lease while held, the disabled OpenRouter keys and Stripe's records. A32 handed the `day:` buckets to A57;
  they are pool-keyed spend figures, so they are kept as ledger lines and expire 40 days after their period.
- **Modes.** A live server erases under both prefixes (records written under `test` before a live key was set); a test
  server erases under `test` only, as `eraseModes` already did, so the new sweep never touches a live record from a
  preview.
- **The ops Worker's data is erased with the ops services switched off.** `opsErasable()` (address and shared secret)
  lets `erase` through while `VECTOR_OPS_ENABLED` is false; every other Worker action still needs `opsConfigured()`.
- **`registerErasePart`** (not in the contract) lets another package add a part that runs before the account's own
  records, which then wait for it. It is meant for the Codex integration commit (A59): Codex's repository bindings and
  run records are not reachable from Claude's code today, so they are not erased until A59 registers a part.
- **Answers.** New codes: 503 `DELETION_UNAVAILABLE` (the tombstone could not be written; nothing changed), 409
  `ACCOUNT_DELETION_IN_PROGRESS` (another run holds the lease), 503 `ACCOUNT_ERASE_PENDING` (some records are not erased
  yet). `REVOCATION_FAILED`, `BILLING_DELETION_FAILED` and `DELETION_FAILED` keep their codes; after the tombstone they
  carry `{pending: true, stage}` and say that deletion has started and Vector finishes it. A finished deletion's answer
  adds `codium: "erased"`. The request leaves erase parts not started within 20 seconds to the cron, because the desktop
  app waits 30 seconds.
- **Test fakes.** The Codium store fake's SCAN now also understands a glob with a wildcard before its end (prefix
  patterns behave exactly as before). `test/account-delete-api.test.ts`'s minimal store answers SCAN and ZSCAN with an
  empty page, since the deletion now scans the outbox and the store; no expectation there changed.
- **Files outside A57's list:** `api/_lib/codium-tombstone.ts` and `api/account/deletions.ts` (new),
  `model-plan-account.ts` (the tombstone in reconcile, `readEntitlement`, checkout and change; `closingFacts` takes a
  missing record), `codium-provision.ts` (`forgetAccountOutbox`), `codium-keys.ts` (`codiumKeyRoot`, so the sweep
  spells no key), `ops-worker.ts` and `ops-cleanup.ts` (`opsErasable`), `vercel.json`, the store fake, the two test
  files above, `packages/web/test/codium-configuration.test.ts` (the new cron), `docs/vector/MODEL-PLANS.md` and
  `docs/vector/owner-actions/brain-vault.md`.

## A58 Deploy workflows (9 Nov 2026)

- **One home for the Worker and image jobs.** `vector-hosted-ci.yml` also has `workflow_call` (input `services_only`) and
  `workflow_dispatch`. The relay, ops Worker and image jobs that A39, A46 and A54 put in `vector-codium.yml` moved into
  it unchanged (plus `persist-credentials: false` and an explicit `--platform linux/amd64`), and the Codium lane now
  runs them through one `hosted` job that calls it with `services_only: true`, which skips its typecheck and tests
  jobs (the lane runs its own). Pull requests run the whole workflow.
- **Paths beyond §6.2's list.** Besides `api/**`, the four packages, Vault, WebAuthn and the desktop's Remote, Vault and
  hosted modules, the pull request filter also takes `test/**` (the hosted API suite), `packages/core/src/remote/**`
  and its tests (Remote's crypto, shared by the desktop and the phone since A42), `packages/cloud/src/hosted-*` and the
  test picker, `docs/vector/owner-actions/sql/**` (the SQL the root tests run on Postgres), `bun.lock` (it pins
  wrangler) and the hosted workflows. "Vault" is read as `packages/core/{src,test}/vault` and the desktop's `vault-*`;
  the engine's `vector vault` command is not in the list. A test fails if any path stops matching a tracked file.
- **Its tests.** `codium-ci-tests.ts --hosted` picks every root test, every test of the relay, ops Worker, cloud
  computer and schema packages, core's vault, webauthn and remote tests, the desktop's `remote-*`, `vault-*` and
  `hosted-*` tests and `packages/cloud`'s hosted and workflow tests, whatever the branch changed, so it needs no git
  history. The build and service steps are the Codium lane's.
- **"Protected main" is taken literally, and the environment must refuse other branches.** Both dispatch preflights
  require (1) a required reviewer on `hosted-production`, as every protected workflow here does; (2)
  `hosted-production`'s deployment branches set to protected branches only, read from the environment's
  `deployment_branch_policy`, because a workflow file edited on another branch could drop the preflight, and only the
  environment's own rule stops that; (3) `main` itself protected (`GET /repos/<repo>/branches/main` → `protected`),
  because GitHub lets every branch deploy to a "protected branches only" environment when no branch is protected; and
  (4) the commit an ancestor of `origin/main`. Each job that can see a secret checks out the preflight's commit, checks
  it is still on `main`, and installs with `bun install --frozen-lockfile --ignore-scripts` without the shared
  dependency cache action (another run could have written that cache). The CLI and container release workflows still
  use the cache action; they were not changed.
- **More checks before a Worker deploy.** `packages/cloud/src/hosted-workers.ts` (new) checks the committed
  `wrangler.jsonc` (the Worker's name, a real 32-hex kill-flag namespace id instead of the zero placeholder, no secret's
  name in `vars`) and, from `wrangler secret list --format json` (names only), that the owner set every secret the
  Worker needs: `TICKET_PUBLIC_KEYS`, `INTERNAL_SECRET`, `ACCOUNT_KEY` for the relay; `INTERNAL_SECRET`, `ACCOUNT_KEY`
  for the ops Worker. So a first deploy needs the owner's `wrangler secret put` steps done first (which the owner
  guides already order that way), and a Worker that would answer 503 to everyone is never deployed. Both Worker
  packages gained the scripts `deploy` (`wrangler deploy`) and `secret-names` (`wrangler secret list --format json`).
  Nothing in the workflow or those scripts sets, changes or deletes a secret; a test checks every `run:` and script.
- **The image's inputs and CLI.** Dispatch inputs: `generation`, `min_disk_generation` (default 1) and `cli_version`.
  The CLI is not built from source: `packages/cloud/src/hosted-image.ts` (new) takes the `linux-x64-baseline-musl`
  archive of an already published release, by exact stable version, from Vector's download store
  (`vars.VECTOR_CLI_BLOB_ORIGIN`), decoded and checked as the CLI container does (manifest rules, size, SHA-256, only
  the binary and its notices, an x86-64 ELF), and the release's own source commit must be on `main`. That is the
  precedent of `cli-container.ts` ("never a registry's moving CLI tag"). Only `bin/vector` goes into the image, because
  A54's Dockerfile copies nothing else; the CLI's notice files are not in the image (left for the legal read).
- **The image is checked before it is pushed.** After `docker build --platform linux/amd64`, the job runs
  `test/image.test.ts` with `VECTOR_TEST_HOSTED_IMAGE` on that image (the CI Docker job's checks), and pushes only if it
  passes.
- **The registry.** "The hosted team's registry" is Vercel Container Registry, `vcr.vercel.com/<team>/<project>/<name>`
  (the only registry @vercel/sandbox 3.8.0 starts images from, per its README and types). The repository comes from
  the `hosted-production` variable `VECTOR_HOSTED_IMAGE_REPOSITORY` and is checked to that form, in the characters
  `bake-snapshot.ts` accepts. Docker signs in with `vercel vcr login docker`, the command that README documents, run
  through `vercelCli` from `hosted-budget.ts` (the same pinned `vercel@65.3.1`, the token only in the environment, its
  output never echoed), with `DOCKER_CONFIG` in the runner's temp folder, deleted when the step ends. Whether 65.3.1
  has `vcr` is not verified. Each generation is pushed once as `<repository>:g<n>`: a tag the registry already has is
  refused, and a lookup error that does not read as "not found" is refused too. The bake gets the one digest
  `docker inspect` reports for that repository.
- **Settings the contract does not name**, all in `hosted-production`: the secret `VECTOR_HOSTED_VERCEL_TOKEN` and the
  variables `VECTOR_HOSTED_VERCEL_TEAM_ID` (shared with the budget workflow), `VECTOR_HOSTED_VERCEL_PROJECT_ID` and
  `VECTOR_HOSTED_IMAGE_REPOSITORY`. The names match the Vercel settings `bake-snapshot.ts` reads; the values live in
  GitHub's environment, not in Vercel's.
- **No `${{ }}` in any hosted workflow's shell.** Inputs and step outputs reach every `run:` as environment variables
  (the typecheck matrix's own fixed command is the one exception); a test checks all four hosted workflows.
- **`packages/cloud`'s `test` script** now also lists `hosted-budget.test.ts` (A56 had not added it),
  `hosted-workers.test.ts` and `hosted-image.test.ts`.
- **Dispatch needs the default branch.** GitHub lists a `workflow_dispatch` workflow under Actions only once the file
  is on the default branch, so "owner can dispatch" holds after `codium` reaches `main` (A60), with the settings above
  in place.

## P8 review decisions (9 Nov 2026)

- **A53: an ended plan's disk retention is not charged while no download exists.** §4.4 keeps an ended plan's disks 14
  days "for download" and A51 charges those days to the final period (`chargeRetention`). No route lets an ended plan
  download its disk (A53 and A56 list the download-only start as not built), so the subscriber paid for something they
  could not use, and after a downgrade to a plan without a cloud computer the new plan's pool paid it. The provisioner
  now keeps the disks the same 14 days (a returning subscriber still gets them back) without calling
  `chargeRetention`: Vector pays that storage (16 GB × 14 days per computer at the snapshot rate, well under a dollar).
  `chargeRetention` stays in the ledger for the package that builds the download-only start, which should call it
  again. The budget figure now counts those kept disks.
- **A53/A54: heartbeats are signed by hostd.** The run token cannot tell hostd from the agent, because the provider's
  proxy adds it for every process on the computer. hostd now makes a 32-byte key before the agent exists, sends it
  (`hostdKey`) until a heartbeat is answered, and signs every heartbeat (`mac`: HMAC-SHA256 over
  `Hosted.hostdMacInput(session, body without mac)`). The server registers the first key it sees for a session with
  SET NX (`hosted:hostd:<sid>`) and refuses any beat that is unsigned, signed with another key, or offers another key
  (403 `HOSTED_RUN_REFUSED`). The job is handed out only in an answer, so the agent, which hostd starts from that answer,
  can never register first. The contract names no such key; this is the smallest change that keeps §4.2's fair-use checks
  (busy processor, idle, done, hand-over) and A55's recordings trustworthy. A hostd that restarts mid-session loses its
  key and its beats are refused, so the session stops by heartbeat loss, as it would with hostd gone.
- **A55: a recording segment cannot be newer than the session's minutes allow.** A reported segment number above
  (minutes since the session's first block started) + 1 + 2 × take-overs is ignored (the recorder makes one segment a
  minute and each take-over skips at most two numbers). `takeovers` is a new optional count on the session record.
- **A55/A56: judged reports are worded as Vector's report.** The server checks that the session asked the judge it named
  after step 1, but never sees the judge's answer: the agent posts the results. Until the server asks the judge itself
  (or keeps the judge's completion from the gateway), the screens say "Vector reports N of M criteria met" and the
  composer says "the report says whether each one was met"; nothing says a model from another lab checked the work. A
  report with no judge says "This report has no pass or fail for each criterion."
- **A55: start failures end a job.** A computer that started and then failed (the boot step, or a start the provider
  could not answer that turned out to have run) misses the job at once with reason `failed`; a start the provider failed
  is tried again 5 and then 15 minutes after each failure, and the third failure misses the job. The phone alert says
  "Done by Morning: a job could not start" for these. The session end reason `failed` now says "The computer could not
  start. Only the time it ran counts." (it said nothing was used, which was not true when a computer ran).
- **A53: a start whose outcome is unknown is charged to its stop.** When creating or resuming the computer throws, the
  provider is asked to stop it: a computer that was running is charged from the block's start to that stop (M8), none is
  charged nothing, and when the stop cannot be made either the session is left stopping with its block open, so the
  reaper's stop closes it when the computer stops (or it lapses and is charged in full).
- **A53: the budget figure.** It now adds each roster account's egress at its plan's fair-use cap for every day left in
  the cycle (at `egressGbCostMicro()`), and the disks of every computer Vector still knows for accounts off the roster
  (ended plans, lost and open disputes). Billing periods are stepped by 28 days, so a period that starts before the cycle
  ends is never missed. The answer gains `retained` and `egressGb` (owner-side only).
- **A56/A58: the Vercel CLI without npx.** The finding preferred pinning `vercel` in bun.lock and installing with
  `--frozen-lockfile --ignore-scripts`. That would add the CLI's whole dependency tree to the monorepo's lockfile, which
  this step could not fetch or verify here. `vercelCli` instead installs `vercel@65.3.1` once per run with npm into a new
  temporary folder, `--ignore-scripts` and `npm_config_ignore_scripts=true`, with only PATH, HOME and TMPDIR in npm's
  environment, checks the installed version, and runs that install's `vercel` with the token and only PATH, HOME,
  TMPDIR, DOCKER_CONFIG, VERCEL_ORG_ID and VERCEL_PROJECT_ID. The CLI's dependencies are still resolved at run time
  without a lockfile; pinning them in a lockfile is left to whoever can update bun.lock with network access.

## Codium finish: CI0 lane dispatch inputs (15 Nov 2026)

- **Why.** Vector Codium run 43636507058 (a dispatch on `release-finish` at 0ee486e3), Codium tests job 132574374820:
  the merge base of 0ee486e3 with `origin/main` is 58f85edc, from before PR #33, so `codium-ci-tests.ts` picked 667
  unit files (and 24 browser specs). "Run the Codium test files" was stopped at its 40-minute limit (20:19:34 to
  20:59:46) before `test/*.test.ts`, the hosted API suite, which sorts last, had run. The browser picker also never
  picks a spec that is on main and unchanged, so the receipt specs this lane needs (`race`, `playbooks-settings`,
  `hosted-result-note`, `remote-phone` under `packages/app/e2e/regression/`) never ran in the lane.
- **A00 and §6.2 name the lane's push and dispatch triggers but no inputs.** `workflow_dispatch` now takes two optional
  string inputs, both defaulting to "": `base`, the remote branch the picker compares with, and `browser_specs`, up to
  ten more app specs, space-separated. The `on` keys, push branches, concurrency, permissions, SHA pins, runners, the
  hosted job and every `run:` script are unchanged; the lane still holds no secret. On a push the `inputs` context is
  empty, so both variables are empty strings and the picker compares with `origin/main` and adds nothing, exactly as
  before.
- **Environment only.** The inputs reach the picker only as step `env:`: "Run the Codium test files" gets
  `CODIUM_CI_BASE`; "Select the Codium browser specs" and "Run the Codium browser specs" get `CODIUM_CI_BASE` and
  `CODIUM_CI_BROWSER_SPECS`. The unit step does not read the spec list, so it does not get it. A test collects every
  env entry that mentions `inputs.` and requires exactly those five, requires that `inputs.` appears nowhere else in
  the jobs (no script, condition or called workflow's arguments), and that no step's `run:` holds a `${{ }}` other than
  the typecheck matrix's fixed command.
- **The base check.** `diffBase` answers `origin/main` for an empty or missing value and otherwise accepts only
  `/^origin\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/` with no `..` in it. The character class allows dots, so the
  regex alone would take `origin/main..HEAD`; the `..` refusal is the reading of "no ranges". Starting with `origin/`
  rules out a leading `-`, and `~`, `^`, `@{`, spaces and newlines are outside the class. Anything else fails with
  "CODIUM_CI_BASE must name a remote branch such as origin/main or origin/release-finish, not <value>". A well-formed
  name that is not fetched (a typo, a deleted branch) still fails at `git merge-base`; nothing falls back to main.
  The old `process.env.CODIUM_CI_BASE || "origin/main"` took any value, so a developer running the picker locally
  with a SHA, `main` or `upstream/main` as the base now gets this error on purpose; no workflow or script in the
  repository sets such a value (only the new env wiring sets the variable at all), so CI is unaffected.
- **Extra browser specs.** `requestedBrowserSpecs` splits on whitespace, refuses more than ten entries as given
  (duplicates count), and refuses any entry that is not a tracked path matching the browser spec pattern and outside
  the app config's ignores (performance specs and `public-share-viewer` stay excluded), naming the refused entries.
  `selectBrowserSpecs` takes them as an optional third argument and unions them with the selection, de-duplicated and
  sorted; its two-argument results are unchanged, and both stay pure. A refused input throws, so the Select step's
  `set -euo pipefail` and `specs=$(...)` fail the step before a count is written or Playwright starts. The Run step
  re-reads the same variables, so both steps pick the same specs.
- **Inputs are checked before history is read.** The browser branch checks the spec list before it compares with the
  base, and `changedSinceMain` checks the base before `git merge-base` sees it, so a bad input fails even in a shallow
  checkout. `--hosted` reads neither variable and needs no history, as before, and `vector-hosted-ci.yml` is
  unchanged. `--hosted --browser` keeps the hosted gate on the changed list (no history read); no workflow uses that
  combination.
- **Counts, measured 15 Nov 2026 after `git fetch origin release-finish main`.** HEAD 0ee486e3; `origin/main`
  58f85edc; `origin/release-finish` had moved on to cf2373c46, and its merge base with HEAD is 0ee486e3, which is what
  the picker diffs from. Against `origin/main`: 667 unit files and 24 browser specs. Against `origin/release-finish`:
  119 unit files (70 `test/*.test.ts` plus 49 Codium-named files) and 2 specs (`codium-image-routing`,
  `codium-usage-labels`); with the four receipts named, 6 specs. Once this package is committed,
  `packages/cloud/src/workflow-compliance.test.ts` is a changed file too, so its dispatch should pick 120 unit files
  and 2 specs. The task's "about 137" estimate measured 119/120. Whoever dispatches re-measures after a fresh fetch,
  because the counts follow `release-finish`'s merge base.
- **Coverage that moves to PR #33's own CI.** The 548 files the drop from 667 to 119 leaves out are files PR #33
  changed. With `base=origin/release-finish` this lane deliberately stops re-running them, because PR #33's test.yml,
  typecheck.yml and lane workflows run them on every push to `release-finish`. This lane keeps the hosted API suite,
  every Codium-named test and its own changes. An empty base restores the comparison with `origin/main` once #33 is in
  main.
- **Timing is an expectation, not evidence.** Earlier green push runs on `codium` (for example 43190646575, about 11
  minutes for the whole run) predate PR #33's content, and the 70 `test/*.test.ts` files have not run in this lane
  since PR #33 (runs 43631064967 and 43636507058 stopped before them). The dispatch's record gives the step's actual
  start and end times; a `test/*.test.ts` file failing for the first time gets a root cause, and one in another
  lane's file goes under For the lead.
- **Tests (`packages/cloud/src/workflow-compliance.test.ts`, describe "Codium CI lane").** Three cases: the base check
  (accepts `origin/main`, `origin/release-finish`, `origin/codium/a36`, `origin/codium-113`; refuses `--output=x`,
  `main..x`, `origin/main..x`, `origin/main...HEAD`, a full and a short SHA, `main`, `upstream/main`,
  `refs/heads/main`, `origin/`, `origin/main/`, `~1`, `^`, `@{1}`, a leading space, a trailing newline and a newline
  followed by an option); the extra specs (whitespace and tabs, union, de-duplication, an unchanged default; refuses an
  untracked spec, a tracked performance spec, the public-share-viewer spec, a fixture, an app unit test, a
  package-relative path, `--grep=x`, a list with one bad entry, and an 11th entry); and the workflow's inputs and
  env-only wiring, plus the Select step's own script run with `--output=x` and with an untracked spec, each failing
  with the picker's message and no `count=`. That last check runs bash with an explicit environment (PATH with the
  running Bun's folder first, joined with the platform's delimiter, `GITHUB_OUTPUT`, the variable under test), because
  the Codium tests step now exports its own `CODIUM_CI_BASE` to every test process. `packages/cloud`'s `test` script
  also runs in test.yml's Windows unit job, so on Windows only (`process.platform === "win32"`) the case also passes
  `SYSTEMROOT`, `WINDIR`, `TEMP` and `USERPROFILE` through from its own environment, matched by name without regard
  to case because Windows spells them `SystemRoot` and `windir`, and never a `CODIUM_CI_*` variable. On Linux and
  macOS the environment is exactly as before. That this is enough for Git Bash to start Bun and git on Windows is a
  reading only, shown by no run yet (see For the lead). The describe block's existing `shell` helper gained an
  optional `cwd` (undefined keeps today's working directory) and now also returns stderr: it pipes stderr instead of
  ignoring it and reads it to the end, which leaves its other callers' status and output unchanged. The spec case's
  one real-checkout check requires every tracked `packages/app/e2e/performance/**` spec to be refused; it names no
  lane-specific spec.
- **Red on the old source.** (a) With only the tests written, the file failed to load: "SyntaxError: Export named
  'requestedBrowserSpecs' not found in module '.../packages/cloud/src/codium-ci-tests.ts'" (0 pass, 1 fail, 1 error).
  (b) With the picker changed and the workflow not yet, only the workflow case failed, its `toEqual` receiving `[]`
  for the input names (53 pass, 1 fail). (c) With the workflow edited: 54 pass, 0 fail,
  1027 expect() calls. Mutations, each restored afterwards: dropping the `..` refusal fails the base case; checking only
  that a spec is tracked fails the spec case; raising the limit above ten fails the spec case.
- **Critique points taken.** The record cites the merge base separately from `release-finish`'s moving tip; the
  shallow-checkout reading below is by reasoning only; the `--hosted` gate stays on the browser branch; the existing
  `shell` helper was extended instead of a second spawn routine, with PATH built from `process.env.PATH` and no HOME
  override; the a58 status line carries no run id (a later dated line will); the timing and coverage readings above.
  No point was rejected.
- **Review points (15 Nov 2026), all non-blocking.**
  - The receipt guard (two findings that disagree). One asked to remove the assertion that the four receipt specs
    (`race`, `playbooks-settings`, `hosted-result-note`, `remote-phone`) stay tracked, the other to keep it with a
    message pointing at `codium-track-b-checkpoint.md`. Taken: removed. The test runs in test.yml's Linux and Windows
    unit jobs, so after this lane's PR merges another lane renaming one of those specs would fail a general compliance
    test for this lane's bookkeeping, and the brief asked only for synthetic cases. The lane loses nothing: a
    dispatch naming a renamed or deleted spec already fails its Select step with the picker's message naming that
    path, which is the lane's own check. The performance half stays, as the first finding allowed.
  - Windows environment for the Select-step check (two findings). Both said no change was needed until test.yml's
    Windows unit job showed a failure, then to pass a few Windows system variables through. Taken now, because it is
    cheap, changes nothing off Windows, and saves a failing round trip at the end of the lane: the union of both
    lists (`SYSTEMROOT`, `WINDIR`, `TEMP`, `USERPROFILE`), on Windows only. The case is not skipped or loosened.
  - `requestedBrowserSpecs` now builds a `Set` of the tracked files instead of scanning the list once per spec, as
    `selectUnitTests` and `selectBrowserSpecs` do. Results are unchanged.
  - Local non-origin bases are refused on purpose: the sentence is in "The base check" above.
- **Shallow checkouts, by reasoning only.** `vector-hosted-ci.yml`'s Hosted tests job runs this test file with a
  default checkout. The new cases read only `git ls-files`, and the Select-step check fails on its input before any
  merge base is needed, so they should pass there too. CI0 does not dispatch `vector-hosted-ci.yml`, so no CI run has
  shown this yet; the PR into main runs it, because the picker is in its `pull_request` paths.
- **Ran locally (15 Nov 2026, each through vector-serial, one file at a time).** `packages/cloud`:
  `bun test --timeout 30000 src/workflow-compliance.test.ts` at stages (a), (b) and (c) and for the three mutations;
  `test/`: `bun test --timeout 30000 ./no-topups.test.ts` (4 pass); `packages/cloud`: `bun typecheck` (exit 0);
  `bunx prettier --check` on the three changed files (clean after `--write` on the test file); the picker's `--list`
  smoke checks above, `CODIUM_CI_BASE=--output=x` (exit 1 with the message) and `--hosted --list` with both variables
  set to bad values (143 files, unaffected). After the review points: `src/workflow-compliance.test.ts` (54 pass,
  0 fail, 1026 expect() calls, one fewer for the removed receipt assertion), `./no-topups.test.ts` (4 pass),
  `packages/cloud` `bun typecheck` (exit 0) and `bunx prettier --check` on the picker and the test file (clean). Not
  run locally: the full turbo typecheck and the api tree (they come before the push), and everything CI-only.
- **Only in CI, still to run.** The Vector Codium dispatch on `codium-finish` with `base=origin/release-finish` and no
  `browser_specs`, and typecheck.yml on the same ref. A dated CI line with the run and job ids, the step's start and
  end, the "Codium: N/N test files passed" line and the exerciser's MISS lines follows in a later docs(codium) commit.
- **For the lead.**
  - Read PR #33's state and fetch `origin/main` right before each dispatch: while #33 is unmerged dispatch with
    `base=origin/release-finish`; once main contains it, dispatch with an empty base. Switch to an empty base before
    `release-finish` is deleted, because a dispatch naming a deleted `origin/release-finish` fails at `git merge-base`.
  - The four `/experimental/review-memory` MISS lines in the HttpApi exerciser (pass=359 missing=4 in Codium tests
    job 132574374820) belong to VectorScope and the PR #33 CI lanes; no scenario is added here.
  - The task's "about 137" unit files measured 119 against `origin/release-finish` (120 with this package).
  - Before the lane's PR merges, confirm that the Windows unit job of the single end-of-lane test.yml run passes
    "a dispatch's inputs reach the picker only as step environment, and pushes leave them empty" in
    `packages/cloud/src/workflow-compliance.test.ts`. If Bun or git fails to start there, the fix is another named
    Windows system variable in that case's pass-through list, never a skip and never a `CODIUM_CI_*` variable.
  - Edits to `api/_lib/model-plan-*.ts`: none. No MODEL-PLANS.md change: these are CI inputs, not product settings.

**Status, 15 Nov 2026 (Codium finish TB).** The CI line this section promised. Vector Codium run 43659654730, dispatched
on `codium-finish` at 02c9fc14 with `base=origin/release-finish` and no `browser_specs`, concluded failure. Codium
tests job 132645886182 (4680 lines, wholly visible): the unit step's env shows `CODIUM_CI_BASE:
origin/release-finish`; "Run the Codium test files" ran 00:49:27 to 00:51:09 and ended "Codium: 119/120 test files
passed", the one failure being `packages/web/test/model-plan-gateway-hooks.test.ts` ("ReferenceError: Cannot access
'METER_EPOCH_PATTERN' before initialization." at `api/_lib/cloud-agents-run-token.ts:57`; cause and owner in the next
section's For the lead); "Run HttpApi exerciser gates" failed with exactly the four `/experimental/review-memory` MISS
lines and "summary pass=359 fail=0 skip=0 missing=4 extra=0"; "Check generated client" passed. Codium browser specs job
132645885892 (667 lines, wholly visible): env `CODIUM_CI_BASE: origin/release-finish` with an empty spec list, the two
Codium specs (`codium-image-routing`, `codium-usage-labels`), "5 passed (38.1s)". The eleven typecheck jobs and the
relay, ops Worker and Docker image jobs passed; Hosted tests and the hosted typecheck matrix were skipped, as on every
lane call. typecheck.yml run 43659657077 on the same SHA concluded success. So the step limit is fixed (120 files in
under two minutes), but the run is not green under the lane rule, because of the gateway-hooks failure.

## Codium finish: Track B receipts and P4 closings (15 Nov 2026)

- **Why.** Track B's B06, B07 and B11 rows wait for browser runs of specs that are on main and unchanged, which the lane
  picker never chose before CI0; B02 to B05 ask for combined regressions on the joined tree; and F63, F64 and A57's
  "Codex's records are not erased" item were closed by other lanes' work while their records still read open.
- **Docs only.** No source, spec, test, workflow, generated file or setting changed. `MODEL-PLANS.md` and
  `owner-actions/` are unchanged; no perk is listed; no public, price, legal or comparative text was added. Files:
  `codium-track-b-checkpoint.md`, `codium-p4-repairs.md`, `codium-a57-account-deletion-notes.md`,
  `codium-a42-remote-phone-notes.md`, `codium-a58-deploy-workflows-notes.md` and this file (the dated line under CI0's
  section above and this section). Every addition is a new dated paragraph or bullet; no existing line was rewritten.
- **Reading: what counts as a browser receipt.** A spec passed in a job only when the job's log is wholly visible (its
  first line is "Current runner version"), its begin line `[n/N] [chromium] › <spec>:<line>:1` is in the log, it is in
  neither the failed nor the flaky block of the summary, and no `(retry #` line names it.
  `packages/app/playwright.config.ts` sets `retries: process.env.CI ? 2 : 0` (`:26`) and the line reporter (`:28`), so a
  retried test prints a `(retries)`-prefixed begin line ending `(retry #n)`. None of the four receipt specs contains
  `skip` or `fixme`.
- **Reading: the combined source.** `git merge-base --is-ancestor origin/main 0ee486e3` succeeds, so PR #33's
  pull_request merge ref 0975ed15 (run 43636452606 names `refs/pull/33/merge` at that SHA) has 0ee486e3's tree; 0975ed15
  is not in the local object store, so this is a reading from ancestry. `git diff 0ee486e3 02c9fc14` touches only CI0's
  five files and nothing under `packages/engine`, `packages/app`, `packages/core` or `api/`, so test.yml run
  43636452606 and the lane's runs on `codium-finish` test the same product source. `origin/release-finish` has since
  moved on to cf2373c4 (13 commits past 0ee486e3); runs at cf2373c4 (test.yml 43656696007, completed, failure) are a
  different tree and are not used as evidence here.
- **Reading: the named suites and the closure rule.** A row closes only when every suite named for it shows passing on
  the combined source (the merge ref or the lane head) in a visible log. B02 to B03 (combined label, prompt and
  skill-learn regression and browser checks, with the helper and bootstrap of `23a37c0b3`):
  `codium-usage-labels.spec.ts`, `codium-no-figures.test.ts`, core `review/format.test.ts`, engine
  `cli/github.evidence.test.ts`, `session/prompt.test.ts`, `session/skill-learn.test.ts`,
  `session/brain-helper.test.ts`, `session/distill.test.ts`, `server/memory-learn.test.ts` and
  `server/memory-workflow.test.ts`, core `brain/learn.test.ts` and `brain/distill.test.ts`, app
  `settings-v2/memory-brain-model.test.ts` and `memory-workflow-model.test.ts`. B04 (the integrated source check): core
  `codium-auto.test.ts` and `brain/workflow.test.ts`, engine `session/codium-auto.test.ts`,
  `orchestration/library.test.ts` and `orchestration/runs.test.ts`. B05 (combined provider and task regression): engine
  `session/second-opinion.test.ts`, `provider/provider.test.ts`, `tool/task.test.ts` and `prompt.test.ts`'s task-tool
  case.
- **Browser receipts.** PR #33 was open (merged false), so the receipt run was dispatched on `codium-finish` at
  01:06:47Z with `base=origin/release-finish` and `browser_specs` naming `race.spec.ts`, `playbooks-settings.spec.ts`,
  `hosted-result-note.spec.ts` and `remote-phone.spec.ts` under `packages/app/e2e/regression/`. It is Vector Codium run
  43661511343 (created 01:06:52Z, later than CI0's 43659654730 on the same SHA 02c9fc14), concluded failure (below).
  - Codium browser specs job 132651657817, 690 lines, wholly visible. The Select step's env shows
    `CODIUM_CI_BASE: origin/release-finish` and `CODIUM_CI_BROWSER_SPECS` with the four paths; it printed six specs
    (`codium-image-routing`, `codium-usage-labels`, `hosted-result-note`, `playbooks-settings`, `race`, `remote-phone`);
    "Running 10 tests using 1 worker"; begin lines `[6/10] … hosted-result-note.spec.ts:4:1`,
    `[7/10] … playbooks-settings.spec.ts:4:1`, `[8/10] … race.spec.ts:5:1`, `[9/10] … remote-phone.spec.ts:44:1` and
    `[10/10] … remote-phone.spec.ts:102:1`; "10 passed (1.2m)"; no failed or flaky block and no retry line.
  - test.yml run 43636452606 (the merge ref), e2e (linux) job 132574288954, 1457 lines, wholly visible: begin lines
    `[218/474]` hosted-result-note, `[265/474]` playbooks-settings, `[282/474]` race, `[283/474]` and `[284/474]`
    remote-phone, `[42/474]` and `[43/474]` codium-usage-labels; summary "4 failed" (all four in
    `vectorscope-changes-and-automatic-reviews.spec.ts`, at `:181`, `:209`, `:225` and `:244`), "1 skipped",
    "469 passed (27.9m)"; the eight `(retry #` lines are those four tests' retries 1 and 2.
  - e2e (windows) job 132574289008, 1346 lines, wholly visible: the same begin indexes, the same four failures,
    "1 skipped", "469 passed (35.9m)", and eight retries, again only those four tests.
  - So B06 (Race), B07 (the Settings regression), B11's runtime renderer and A42's Remote pairing (the base for B09's
    paired check) each passed on the first attempt on both trees.
- **Logs read for B02 to B05, and their visibility.** All from test.yml run 43636452606 unless named otherwise.
  Wholly visible: engine (linux) shards 1/4 132574289056 (3518 lines), 2/4 132574288967 (3733), 3/4 132574288925 (3127)
  and 4/4 132574289024 (3444); engine (windows) shards 6/12 132574289128 (1449) and 7/12 132574289180 (1357); and on the
  lane head the Codium tests jobs 132645886182 (4680) and 132651658143 (4666). Partly visible: unit (linux)
  132574288906 shows only its last 5000 of 10081 lines and unit (windows) 132574288900 its last 5000 of 9820; both tails
  hold only `@vectordevai/core`'s test output, so per-file results are claimed only for core files in them. Step
  conclusions come from the job listing, not the tails: unit (linux) "Run unit tests" success, "Run HttpApi exerciser
  gates" failure (its visible lines are the four review-memory MISS lines and "summary pass=359 fail=0 skip=0 missing=4
  extra=0"), the later steps skipped; core's visible summary "5408 pass", "64 skip", "0 fail", "Ran 5472 tests across
  413 files", and turbo's "Tasks: 8 successful, 8 total". Per-file counts are `(pass)` and `(fail)` lines under each
  file header.
- **B02 to B03: open.**
  - Passed: `codium-usage-labels.spec.ts` (job 132651657817; e2e jobs 132574288954 and 132574289008);
    `codium-no-figures.test.ts` 2/0 (lane head, jobs 132645886182 and 132651658143); core `review/format.test.ts` 60/0,
    `brain/learn.test.ts` 34/0 and `brain/distill.test.ts` 17/0 (132574288906's tail; `review/format` and `brain/learn`
    also 60/0 and 34/0 in 132574288900's tail); engine `cli/github.evidence.test.ts` 24/0,
    `session/skill-learn.test.ts` 17/0 and `session/brain-helper.test.ts` 3/0 (132574289056);
    `session/distill.test.ts` 6/0 and `server/memory-learn.test.ts` 5/0 (132574288967); `server/memory-workflow.test.ts`
    3/0 (132574288925).
  - Failed: engine `session/prompt.test.ts` on Linux, 156 pass, 1 fail, 1 skip (132574288967): "running task tool
    preserves metadata after tool-call transition [5316.28ms]", "error: timed out waiting for running task metadata" at
    `packages/engine/test/lib/effect.ts:180`. On Windows the whole file passed, 135 pass, 0 fail, 22 skip, that case
    included (4399.80ms; 132574289128). The RULES-v2 flake list names only Windows' `prompt.test.ts` 3 s case, so this
    Linux failure needs a root cause (For the lead).
  - Not shown: app `memory-brain-model.test.ts` and `memory-workflow-model.test.ts` (neither unit tail reaches the app
    package, and no Codium-picked run selects them).
- **B04: integrated source check done.** Core `codium-auto.test.ts` 7/0 and engine `session/codium-auto.test.ts` 19/0 on
  the lane head (132645886182 and 132651658143); on the merge ref engine `session/codium-auto.test.ts` 19/0 and
  `orchestration/library.test.ts` 7/0 (132574288925), `orchestration/runs.test.ts` 18/0 (132574289056) and core
  `brain/workflow.test.ts` 15/0 (132574288906's tail, and 132574288900's). Listing `auto-learns` stays under the perk
  acceptance policy and is the owner's.
- **B05: open.** Engine `session/second-opinion.test.ts` 9/0 (132574289024) and `provider/provider.test.ts` 121/0
  (132574289056) passed; `tool/task.test.ts` passed on Windows, 161/0 (engine (windows, shard 7/12) 132574289180,
  "Ran 711 tests across 55 files", 0 fail), and never ran on Linux (next bullet); `prompt.test.ts`'s task-tool case
  failed on Linux as above. The row stays open on that one Linux case.
- **Why `tool/task.test.ts` is not in the Linux logs.** Engine (linux) shards 2/4 and 3/4 end at "The action 'Run Engine
  shard' has timed out after 30 minutes." (step 8: 20:18:50 to 20:49:03 and 20:17:26 to 20:47:38, the last tests passing
  until the cut), while 1/4 ("2193 pass", "9 skip", "0 fail", "Ran 2202 tests across 165 files") and 4/4 ("1857 pass",
  "12 skip", "2 fail", "Ran 1871 tests across 164 files") finished. `packages/engine` holds 657 tracked test files at
  0ee486e3 (655 `*.test.ts` and 2 `*.test.tsx`; 2 under `src/`), which is the number to compare with. Sorted and dealt
  round-robin, they give exactly shard 1's 165 file headers in order, and shard 2's 149 and shard 3's 134 headers are
  prefixes of their 164-file lists; so 612 headers (165 + 149 + 134 + 164) means 45 files never ran on Linux, and
  `tool/task.test.ts` is file 158 of shard 3's 164. That Bun deals `--shard` round-robin over sorted paths is a reading
  checked only against these headers. The same reading puts `prompt.test.ts` in Linux shard 2 and Windows shard 6, and
  `tool/task.test.ts` in Windows shard 7, which is where they appear.
- **F63 and F64 closed.** This closes the hand-offs under "P4 review decisions (8 Nov 2026)", "Hand-offs to Codex (F63,
  F64)". F63: the @vector lane's approved correction (`vector-at-mention-deviations.md:537`) replaced "on your keys"
  with "from other models" and a zero subtotal with no price; label plan §3.8 (`codium-label-plan.md:196`),
  `github.evidence.ts` `formatCost` (`:293-324`, `ownPrice` at `:299`, " from other models" at `:316`) and
  `github.evidence.test.ts:348-373`, `:436` and `:483-498` agree; job 132574289056, 24/0. F64: `github.review.ts:716`
  logs `Spent: Codium` when `event.codium && event.costUsd === 0`; `packages/engine/src/review/run.ts:428` still sends
  `kind: "unknown"` once an own step reports; `github.review.test.ts:2076` and `:2098`; job 132574288967, 46/0. Each
  was checked against the code at 02c9fc14, and `origin/release-finish` does not touch these files. Dated lines are in
  `codium-p4-repairs.md`.
- **A57's Codex item closed.** The built-in `cloud-agents` part (`api/_lib/codium-erase.ts:268-277`, in `ERASE_PARTS` at
  `:244`; required by `codium` at `:293`; not `registerErasePart`, `:311`) and `eraseCloudAgentsAccount`
  (`api/_lib/cloud-agents-runs.ts:332`) erase Codex's bindings and run records; `cloudAgentView`'s `closing` answer is
  at `api/_lib/codium-cloud-agents.ts:42`, tested at `packages/web/test/cloud-agents-entitlement-contract.test.ts:38`;
  the erased-account path through `readEntitlement` is a reading. `test/account-delete.test.ts` 38/0 in jobs
  132645886182 and 132651658143, including "the last part on a real Valkey (CI only)", the `cloud-agents` feature-off
  case and the deadline case. Dated line in `codium-a57-account-deletion-notes.md`. The B08/A59 joint check stays with
  brain-transport.
- **Receipt run 43661511343's other jobs.** Codium tests job 132651658143 (wholly visible):
  `CODIUM_CI_BASE: origin/release-finish`; "Run the Codium test files" 01:08:42 to 01:10:37, "Codium: 119/120 test
  files passed", failed file `packages/web/test/model-plan-gateway-hooks.test.ts` with the same ReferenceError at
  `api/_lib/cloud-agents-run-token.ts:57`; the exerciser's exactly four review-memory MISS lines and "summary pass=359
  fail=0 skip=0 missing=4 extra=0"; "Check generated client" passed. The eleven typecheck jobs, the relay, ops Worker
  and Docker image jobs passed; Hosted tests and the hosted typecheck matrix were skipped. Receipt run 43661511343 is
  not green under the lane rule; its browser receipts stand on job 132651657817 alone.
- **Ran locally (15 Nov 2026).** Only reading and git: `git fetch`, `git merge-base --is-ancestor`, `git diff`,
  `git log -S`, `git blame`, `git ls-files`, the log tallies (`python3 -I` scripts over saved job logs), and, through
  `vector-serial`, `packages/engine` `bun test --timeout 30000 test/compliance/upstream-free.test.ts` after writing
  (it scans every tracked file's working-tree text) and `git diff --check` (clean), both run again after the last
  edits with the same results. The scan's case ("tracked paths and binary contents keep the upstream holder only in
  license notices", `:68`) passed; the file gave 11 pass, 1 fail, the failure being `:148` ("a GitHub token does not
  take the default model from an OpenAI key": default provider `amazon-bedrock`, not `openai`), which reads this
  machine's provider environment and is unrelated to Markdown (For the lead, item 7); the same file passed 12/0 on the
  merge ref (engine (linux, shard 4/4) 132574289024). No other test or typecheck ran while writing: no package
  changed. The full turbo typecheck and the api tree typecheck run before the push.
- **Only in CI.** Every receipt above (Vector Codium runs 43659654730 and 43661511343, test.yml run 43636452606,
  typecheck.yml 43659657077). This package's own CI is the Vector Codium dispatch on `codium-finish` after its push
  (the same `base` and the four receipt specs), then typecheck.yml on the same ref. That Vector Codium run cannot be
  green under the lane rule while the gateway-hooks cycle stands (For the lead, item 1): its Codium tests job is
  expected to stop at the same "Codium: 119/120" on `packages/web/test/model-plan-gateway-hooks.test.ts`, beside the
  exerciser's four review-memory MISS lines. So this package's CI is not green, for that recorded reason; a dated
  follow-up line at the end of this section gives the post-push run and job ids and what their logs show.
- **For the lead.**
  1. The gateway-hooks import cycle makes every lane Codium tests run red ("Codium: 119/120"; jobs 132645886182 and
     132651658143). `packages/web/test/model-plan-gateway-hooks.test.ts` loads `api/_lib/model-plan-gateway-hooks.ts`,
     whose `:5` imports `cloud-agents-ledger.ts`, which imports (`:4`) `cloud-agents-entitlement.ts` → (`:1`)
     `codium-cloud-agents.ts` → (`:4`) `codium-entitlements.ts` → (`:17`) `model-plan-account.ts` → (`:47`)
     `codium-perks.ts` → (`:7`) `model-plan-models.ts` → (`:6`) `model-plan-caller.ts` → (`:7`)
     `cloud-agents-run-token.ts`, whose `:9` imports `METER_EPOCH_PATTERN` back from `cloud-agents-ledger.ts` and uses
     it at module top level (`:57`) while the ledger is still initializing (the constant is defined at its `:43`). The
     import at `model-plan-caller.ts:7` that closes the cycle came in with cb9221de ("feat(github): probe real service
     dependencies without inference", 12 Nov), found by `git log -S` and `git blame`. A temporal-dead-zone error in a
     single-file run follows from import order, so it is deterministic and not a flake. The files are the GitHub-agent
     lane's and model-plan files; any fix touching `api/_lib/model-plan-caller.ts` is a model-plan-* edit, so the lead
     assigns the fix package. This package does not fix it, and no lane Vector Codium run can be green until it lands.
  2. `prompt.test.ts`'s "running task tool preserves metadata after tool-call transition" failed on Linux on the merge
     ref (job 132574288967) and passed on Windows (132574289128). It is not on the flake list; it belongs to the PR #33
     CI lanes and keeps B02 to B03 and B05 open.
  3. Engine (linux) shards 2/4 and 3/4 hit their 30-minute step limit on the merge ref (132574288967, 132574288925), so
     45 engine files, `tool/task.test.ts` among them, have no Linux result there (PR #33 CI lanes).
  4. The app `memory-brain-model` and `memory-workflow-model` suites are shown by no visible log; a log that shows them
     (or a lane run that selects them) is needed to close B02 to B03.
  5. The four `/experimental/review-memory` MISS lines (VectorScope). They are fixed on `release-finish` by 0f6fce89 and
     225905e2 (`review-memory-scenarios.ts`), which reach this lane only when #33 merges and main is merged in; this
     package does not merge `release-finish`.
  6. `release-finish` dbfca832 ("shard the Codium test files over four jobs", with aee5584c rewrapping one of its
     comments) rewrites `.github/workflows/vector-codium.yml`, `packages/cloud/src/codium-ci-tests.ts` and
     `packages/cloud/src/workflow-compliance.test.ts`, the same three files CI0 changed, and that tree has no dispatch
     inputs (its `workflow_dispatch:` takes none). Merging main into `codium-finish` after #33 merges will conflict in
     those files; the resolution must keep both the shard matrix and the `base` and `browser_specs` inputs with their
     env-only wiring and tests.
  7. `packages/engine/test/compliance/upstream-free.test.ts:148` ("a GitHub token does not take the default model from
     an OpenAI key") is not hermetic. It sets only `GITHUB_TOKEN` and `OPENAI_API_KEY` (`:151-152`), while `Env`'s state
     starts from `...process.env` (`packages/engine/src/env/index.ts:26`), so any other provider variable on the host
     reaches `Provider.use.defaultModel()` (`:155`). Run locally here it picked `amazon-bedrock`, not `openai` (the file
     11 pass, 1 fail); it passed in CI (12/0, engine (linux, shard 4/4) job 132574289024). It should clear the other
     provider variables or run with an isolated `Env`. The file is outside this lane; this package does not fix it.
     21 Nov 2026: closed on branch `engine-core-fixes`. Both GitHub-token cases now run with
     `{ trusted: true, config: { enabled_providers: ["openai", "github-copilot"] } }`, the provider allow-list
     provider.test.ts uses, so Bedrock, Vertex and other host-derived providers cannot take the default while
     github-copilot stays allowed; the assertions are unchanged. With `AWS_WEB_IDENTITY_TOKEN_FILE` and
     `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` set the file gave 11 pass, 1 fail (`amazon-bedrock`) before and 12 pass
     after; 12 pass without them too. The CI job is recorded when the branch's PR runs.
- Edits to `api/_lib/model-plan-*.ts`: none. No MODEL-PLANS.md change.
- 15 Nov 2026, post-push CI and For the lead item 1. Vector Codium run 43665227929 (codium-finish 7c479924): Codium
  tests job 132662998717 stopped at "Codium: 119/120" on `packages/web/test/model-plan-gateway-hooks.test.ts` with the
  recorded ReferenceError, and its exerciser step showed only the four review-memory MISS lines (pass=359 fail=0);
  every other job passed, Codium browser specs job 132662998928 among them. typecheck.yml run 43665230627 passed. The
  same ReferenceError fails `model-plan-gateway-hooks.test.ts` and `cloud-agents-ledger.test.ts` on `release-finish`
  (Vector Codium run 43656784344, Codium tests (shard 3/4) job 132636969121), so it is not this lane's and main, which
  has neither `cloud-agents-ledger.ts` nor `cloud-agents-run-token.ts`, cannot show it. The lane's CI check before F6
  fixed it in a separate fix(api) commit without a `model-plan-*` edit: `cloud-agents-run-token.ts` now reads
  `METER_EPOCH_PATTERN` inside the claim filter at decode time instead of passing it to `Schema.isPattern` at module
  top level, and `test/api-module-loading.test.ts` adds `cloud-agents-ledger.ts` and `model-plan-gateway-hooks.ts` to
  its fresh Node ESM entries (the ledger-first order failed with that ReferenceError before the change). The same
  two-file change is needed on `release-finish`; the lead decides whether it goes there first.

**31ddb43b's CI receipts (recorded by Codium finish DZ, 15 Nov 2026)**

These are for `31ddb43b`, the fix(api) commit named in the dated line above, read from the runs' jobs and logs.

- Vector Codium run 43668405381 had 18 jobs. 15 succeeded, and 2 were skipped by `services_only` (Hosted services'
  typecheck matrix and Hosted tests).
  - Codium tests job 132672820820 failed only at "Run HttpApi exerciser gates". Its visible tail shows "Codium:
    120/120 test files passed", no longer 119/120. It then shows exactly the four review-memory MISS lines and `summary
    pass=359 fail=0 skip=0 missing=4 extra=0`.
  - The job's step list shows that "Run the Codium test files" and "Check generated client" succeeded, so the run is
    green under the lane rule.
  - Codium browser specs job 132672821092 passed.
- typecheck.yml run 43668408121: success.
- vector-hosted-ci.yml run 43669004895: success. This is the run conclusion only; its Hosted tests log was not read.
- TB's own vector-hosted-ci.yml run 43665560776, at `7c479924`: success (run conclusion).

This closes For the lead item 1 on `codium-finish`. The same two-file change is still needed on `release-finish`, and
the lead decides that.

16 Nov 2026, For the lead item 1 corrected (codium-finish lane, phase review finding PR7, blocking). Item 1 says the
cycle's files belong to the GitHub-agent lane, that the lead assigns the fix and that this package does not fix it.
That stopped being true on this branch: the codium-finish lane's own agent fixed it, without a lead assignment, in
the separate fix(api) commit `31ddb43b` (committed as `Vector <bot@vectordev.ai>`, between TB and F6). That commit
edits a brain-transport runtime file, `api/_lib/cloud-agents-run-token.ts` (`:57`, the epoch claim's filter), and
`test/api-module-loading.test.ts`, which the lane rule says to record and not fix. The edit stays in place: reverting
it without a replacement brings back "Codium: 119/120". When fetched on 16 Nov 2026, neither origin/release-finish
(`0f034957`) nor origin/brain-transport (`09a6387a`) has the change: both still pass `METER_EPOCH_PATTERN` to
`Schema.isPattern` at module top level (`:57`), and origin/main (`58f85edc`) has neither module. The lead must decide
before this lane's PR. One option is to accept the cross-lane edit explicitly. The other is to have the brain-transport
or PR #33 lane land the same two-file change, and then keep one copy when main is merged into `codium-finish`, so the
two branches do not diverge or conflict in `cloud-agents-run-token.ts`. Until `release-finish` carries it, item 1 stays
open under "Lane status (15 Nov 2026, codium-finish)", For the lead, and in the phase review section (16 Nov 2026).

## Codium finish: F6 cost kind on read (15 Nov 2026)

- **Why.** P4 finding F6 (`codium-p4-repairs.md`, the F6 paragraph; not Everywhere's F6 in `v2-master-prompt.md`), the
  F6 bullet of "P4 review decisions (8 Nov 2026)" above, which this section closes without editing, and label plan §6,
  row "Downgrading the database" (`codium-label-plan.md:344`): the self-evolving branch should decode a persisted cost
  kind it does not know as `"unknown"`, as WP1 does for interruption causes. Self-evolving is part of this tree
  (`e0bfa00b`, `0c1f1b52` and `d36a3607` are ancestors of `codium-finish` `31ddb43b`), so F6 closes here.
- **Change.** One source file, `packages/engine/src/tool/subagent-lifecycle.ts`. `read()` (`:279`) dropped its
  `Schema.decodeUnknownOption(Schema.Array(Task.BudgetScope))(value.budgetScopes)` (old `:299`, consumed at old `:317`).
  The `budgetScopes` field (`:316-328`) now maps a stored array scope by scope through the existing `decoded()` helper
  (`:232`), after replacing a string `costKind` that `Schema.is(RunBudget.CostKind)` rejects with `"unknown"`. The
  callback parameter is typed `unknown`, so no `any` flows from `Array.isArray`. `read()`'s signature and
  `SubagentRecord.budgetScopes` (`packages/engine/src/agent/subagent-kind.ts:129`) are unchanged. `RunBudget.CostKind`
  (`packages/schema/src/run-budget.ts:26`), `RunBudget.StopReason` (`:17`), `Task.BudgetScope`
  (`packages/schema/src/task.ts:37-48`), the SDK, openapi, `src/generated`, `src/generated-effect` and `config.json` are
  unchanged, so no generator ran. No flag or setting.
- **R1, which strings are mapped.** Only a string `costKind` this build does not know becomes `"unknown"`. An absent
  `costKind` stays absent, so a 1.99.111 scope never gains `"unknown"`. A non-string `costKind` (a number, `null`) is
  malformed and drops its scope; the malformed test covers `7` and `null`.
- **R2, malformed scopes drop alone.** A scope with no `id`, no `spentUsd`, a non-finite number, a `budget` that fails
  `RunBudget.Info`, a `kind` outside run, batch and child (for example `"delegated"`), or a non-object entry is dropped
  and its siblings are kept; this answers the brief's "say which": the good scope is kept, not the old all-or-nothing.
  A `budgetScopes` value that is not an array still reads as undefined. An array whose every entry fails reads as `[]`,
  as `mailbox` does, and the malformed test pins both edges. `[]` is already a normal stored value, since `scopeFields()`
  (`:710`) stores `budgetScopes: []` for a delegated-only record (`subagent-lifecycle-read.test.ts:66-68`). The one
  visible difference: `packages/engine/src/task/manager.ts:478-480` passes a settled task's `current.budgetScopes` into
  `Task.Info`, so a stored array whose every scope is corrupt now lists as `budgetScopes: []` where the old reading left
  the field out, which is the value an active delegated-only task already lists (`:479`). In-engine consumers treat the
  two alike (`notify.ts:401` `.some` is false for both).
- **R3, unknown stop reasons.** A `stopped.reason` this build does not know still drops that scope. `RunBudget.StopReason`
  has no `"unknown"` value, adding one would change the schema, the SDK and openapi, and the contract names no fallback.
  As before, a dropped stopped scope is invisible to `notify.ts` `launchStopped` (`:401-403`), so a launch a newer
  version stopped for a new reason can still wake its parent; keeping the stop would need a StopReason fallback, which
  is a schema change outside this package. The old all-or-nothing decode behaved the same way, so this is not a
  regression.
- **R4, the WP1 test whose assertion changed.** `subagent-lifecycle-read.test.ts:143` ("budgetScopes with an unknown
  kind is ignored and does not erase delegatedScope") implements `multiagent-parity-spec.md:1547`. That line is read as
  "the scope with the unknown kind is ignored", not "the whole array is ignored", so its `budgetScopes` assertion moves
  from `toBeUndefined()` to exactly `[run]` (`:161`): a stricter exact value, not a looser one; the name and the
  `delegatedScope` assertion are unchanged. `multiagent-parity-spec.md:410` ("Older engines decode ... with
  `Schema.Array(Task.BudgetScope)`, and one unknown kind would drop every scope") describes 1.99.111-and-earlier engines,
  which this change does not alter, so it stays true, and I29 (`:181-185`) still holds: the delegated scope stays out of
  `budgetScopes` (`scopeFields()`), because those older engines still drop the whole array. Only this build's reader
  becomes per-scope.
- **R5, write-back.** `write()` (`:385`) stores `merge(read(info), patch)` (`:396`), so once this build updates a record a
  newer kind is stored as `"unknown"` and malformed scopes leave storage. Interruption causes and every other checked
  field already behave this way, and it loses strictly less than the old source, which wrote every scope away. The
  residue is one-way: a downgrade followed by an upgrade keeps the scope but stores its kind as `"unknown"` for good,
  which reads as cost unknown and never as priced, plan or Codium. Keeping the original string would need a schema
  change, which this package does not make.
- **R6, consumers of the read value.** `packages/engine/src/task/notify.ts:395-406` (`launchStopped`) reads through
  `read()`; a true there marks the note as not waking the parent (`:568-575`), so keeping more scopes can only hold a
  wake the old reading would have sent, never add one. `packages/engine/src/task/manager.ts:333` and `:478-480` (settled
  tasks keep `current.budgetScopes`) and `:674` (desktop-mirrored rows) pass the value into `Task.Info`, whose encode
  accepts `"unknown"`. No first-party UI reads a stored scope's `costKind`, and no spend decision does: the guard keeps
  its ledger in memory and is never restored from records.
- **R7, other readers grepped, none changed.** Each reads fresh values, or reads stored data without a schema decode,
  so an unknown kind fails safe:
  - `packages/engine/src/task/manager.ts:478-479` writes `scopeFields(guard.scopes())` and `:446` writes a fresh
    `costKind: "unknown"`; `packages/engine/src/tool/task.ts:1955` clears `budgetScopes` on resume; their reads go
    through `read()`.
  - `packages/core/src/spend-guard.ts` is an in-memory ledger; its kinds come from `costKindOf` (`:40`) and its
    `SessionStatusEvent.Spend` publishes (`:698`, `:712`) carry fresh values. `Spend.costKind`
    (`packages/schema/src/session-status-event.ts:66`) is a live bus event, and `packages/engine/src/server/routes/
    instance/httpapi/groups/memory.ts:565,606` are response schemas for fresh values.
  - `packages/core/src/brain/sql.ts:403` `cost_kinds` is a drizzle JSON column typed with `$type` only and never decoded.
    `packages/core/src/brain/workflow.ts:343-349` prices a run only if every counted kind is `"priced"` and gives Codium
    units only if every kind is `"codium"`, and `:586-611` counts an unknown key as a non-Codium kind, so an unknown key
    fails safe. `packages/core/src/brain/knowledge.ts:7145` (`historyDetail`) compares a stored receipt's
    `detail.costKind` with `"codium"` as a raw string. Brain files are shared with VectorScope and none drops data, so
    they are untouched.
  - `packages/core/src/codium-usage.ts:18` (`taskText`) compares `Task.Info.costKind` strings; an unknown kind falls into
    its "cost unknown" or default branches.
  - `packages/desktop/src/main/run-usage.ts:31` decodes `RunBudget.Snapshot` from the bundled engine: no skew (label plan
    §6).
- **Tests.** `packages/engine/test/tool/subagent-lifecycle-read.test.ts`, written before the source change:
  - new "a cost kind a newer version added reads as unknown and keeps the other scope" (`:166`): a codium run scope and
    a child scope with `costKind: "future-kind"` and a cap stop read back as both, the second with `costKind: "unknown"`
    and every other field intact;
  - new "a malformed budget scope drops alone and keeps the others" (`:193`): a batch scope with no `costKind` beside
    child scopes with no `id`, no `spentUsd`, a NaN `spentUsd`, `budget: { usd: 0 }`, `costKind: 7`, `costKind: null`
    and `stopped.reason: "drift"`, plus `"scope"` and `null`, reads back as exactly the batch scope, still with no
    `costKind`; `[null, { kind: "run" }]` and `[{ kind: "delegated", id: "x" }, null]` read as `[]` (R2), and a
    non-array `budgetScopes` reads as undefined;
  - changed `:143` (R4).
  - Red against the old source (tests changed, source not): 11 pass, 3 fail, each failure receiving `undefined`. Green
    now: 14 pass, 0 fail. Mutations, each restored by an edit: m1, no `costKind` mapping: 13 pass, 1 fail (the
    cost-kind case); m2, mapping every non-known kind including absent and non-string ones: 12 pass, 2 fail (`:143`, whose
    run scope gained `"unknown"`, and the malformed case); m3, the old whole-array decode: 11 pass, 3 fail; m4, added
    with the review fixes, an array whose every scope fails read as undefined: 13 pass, 1 fail (the malformed case, at
    its first `[]` assertion, received `undefined`).
  - After the review fixes (the two `[]` assertions, the shorter source comment, these records), the read file gave
    14 pass, 0 fail again, and `test/tool/subagent-lifecycle.test.ts` 18 pass, 0 fail; `bun typecheck` in
    `packages/engine` and `prettier --check` on both `.ts` files passed. `task.test.ts`, `task-manage.test.ts` and the
    `prompt.test.ts` case were not re-run: the source change since those runs is the comment only.
- **Ran locally**, each through `vector-serial`, one file at a time from `packages/engine` with `--timeout 30000`:
  `test/tool/subagent-lifecycle-read.test.ts` (14/0), `test/tool/subagent-lifecycle.test.ts` (18/0),
  `test/tool/task.test.ts` (161/0; its stopped-scope launch cases go through `read()`), `test/tool/task-manage.test.ts`
  (52/0; `:1198` checks `budgetScopes` visibility), and `test/session/prompt.test.ts` filtered with `-t` to "legacy
  accounting keeps a late background batch charge on its launch run after a new root run" (1/0; its `:6176` checks the
  scopes stored after `write()` equal the guard's exactly), not the whole file. `bun typecheck` in `packages/engine`
  passed. `prettier --check` on the two changed `.ts` files passed after `prettier --write` of the test file, and
  `git diff --check` is clean. After the records were written, `test/compliance/upstream-free.test.ts` gave 11 pass,
  1 fail, the failure being `:148` ("a GitHub token does not take the default model from an OpenAI key"), the
  host-environment failure already recorded as For the lead item 7 of "Codium finish: Track B receipts and P4 closings
  (15 Nov 2026)", unrelated to this change. `git diff --stat origin/codium-finish -- packages/schema packages/sdk
  packages/client/src/generated packages/client/src/generated-effect packages/web/public/config.json` is empty. Only
  the read test is selected by the lane picker (changed since the base); the other four are local-only until the
  lead's end-of-lane test.yml.
- **Only in CI.** The Vector Codium dispatch on `codium-finish` (the Codium tests job selects the changed
  `subagent-lifecycle-read.test.ts`; its required receipt is that file in the picker list plus the "Codium: N/N test files
  passed" summary, and its per-file line is cited only if the visible log tail shows it), the HttpApi exerciser,
  `check:generated`, and typecheck.yml on the same ref. No vector-hosted-ci.yml run: no hosted file changed. Not
  committed or pushed by this package's build step, so no CI id exists yet; a dated line follows.
- **For the lead.** The desktop task-bridge store (`packages/engine/src/task/desktop.ts:24-33`, decoded at `:100`)
  decodes stored `Task.Info` rows, `costKind` and `budgetScopes` among them, with the closed literals; it is a 75-second
  lease snapshot (`:36`) the desktop rewrites, desktop and engine ship together, `Task.Info`'s closed status, source and
  billing literals would fail the same way, and a failed read returns `invalid` with a reconnect message. VectorScope's
  `packages/core/src/review/local-result.ts:26` decodes a retained result's cost kind with its own closed literal. Both
  are recorded readings, not changed; each is a package of its own if the lead wants downgrade tolerance there.
  - 21 Nov 2026 (branch `engine-core-fixes`): the desktop task-bridge half is closed. `read()` in
    `packages/engine/src/task/desktop.ts` maps a string `costKind` that `RunBudget.CostKind` rejects to "unknown" on
    each stored task and each of its `budgetScopes` before the decode (`knownCostKinds`, below the layer), so a record
    a newer engine wrote no longer reads as damaged. Strings only: a non-string cost kind, or any other malformed
    field, still returns `invalid` (tasks are not decoded one at a time; the "damaged record" contract is unchanged).
    Tests in `packages/engine/test/task/bridge-decode.test.ts` write raw records through `Storage.Service`: the
    parent's list reads `unknown` for the task and its scope, a child's record read with the parent's descendants
    does not break the listing, and a numeric cost kind still gives `invalid`. The first is red on the old `read()`
    ("The desktop task record is damaged"). The other closed literals named here (status, source, billing) and
    `local-result.ts:26` (VectorScope's) are unchanged.
- Edits to `api/_lib/model-plan-*.ts`: none. No MODEL-PLANS.md change.

## Codium finish: F44 sanitized lifecycle text (15 Nov 2026)

- **Why.** This section closes two things without editing them:
  - P4 finding F44 (`codium-p4-repairs.md`, the F44 paragraph);
  - the "Privacy hand-off to the lead (F44), open" bullet of "P4 review decisions (8 Nov 2026)" above.
  It also answers label plan §3.7 and D-2 (a raw `vector export` is a backup; `--sanitize` output is not), and the
  `--sanitize` help text, "redact sensitive transcript and file data" (`packages/engine/src/cli/cmd/export.ts:429`).
  At `0ee486e3`, `sanitizeLegacy` spread `metadata.subagent` through `taskMetadata`, which strips aggregate tokens
  (F43) and nothing else. So every text field of the lifecycle record, and every other metadata key, was printed as
  stored.
- **Change.** One source file, `packages/engine/src/cli/cmd/export.ts`.
  - It imports `isRecord` from `@/util/record`, as `cli/cmd/run.ts:43` does.
  - In `sanitizeLegacy` (`:171`), `info.metadata` is rebuilt key by key (`:192-205`):
    - `subagent` becomes `redactLifecycle(LIFECYCLE, id, taskMetadata(value))`;
    - every other key becomes `redactStrings("session-metadata", id, value)`.
  - The allow-list is `LIFECYCLE` (`:301`), with `BUDGET` and `SCOPE` (`:288-300`). It is walked by `redactLifecycle`
    (`:392`). `redactStrings` is at `:408`. These sit below `withoutTokens`, which is the AGENTS "Complex Logic" layout.
  - A session without metadata still gains no `metadata` key.
  - Metadata without a `subagent` key is now redacted too. Before, it passed through `...info` unchanged.
  - In the review fixes below, `run()`'s choice of what to print in the local format moved, unchanged, into the
    exported `localArchive` (`:513-516`, called at `:505`): a native archive encoded, a legacy one as exported or
    sanitized.
  - Unchanged: `sanitizeLegacy`'s signature, what the unsanitized output prints (`: local`, `:515`), the native
    encode, `sanitizePublic` (`:518`), the rest of `run()`, import, the help text (so `help-snapshots.test.ts` is
    unaffected), `SessionArchive`, the schema, the SDK, openapi and the generated client. No generator ran. No flag or
    setting was added.
- **How the rule works.** A rule is `true`, a label, or a nested rule.
  - `true` keeps a scalar field as it is: a string, number, boolean or null. An object or list under it takes the
    `subagent-field` label (review fixes, below).
  - A label redacts the field: a string with `redact()` (`:16`), an object with `data()` (`:20`), and each array
    element alike, with `-<i>` added to the id.
  - A nested rule applies field by field, to an object or to each object of an array.
  - A key the rule does not name takes the `subagent-field` label. Its string or object is redacted. A number, boolean
    or null under it stays. R5 records that residual.
  - A value of the wrong shape under a nested rule, such as a string where an object belongs, is redacted the same way.
  - `Object.hasOwn` makes a key like `constructor` take the default label and not a prototype member.
  - The walkers copy and never mutate: the source archive is unchanged, and the tests pin that.
- **R1, labels and what is kept.** These are the brief's "distinct kind labels".
  - Redacted as strings:
    - `subagent-title`, `subagent-batch`, `subagent-owned-path`, `subagent-depends-on`, `subagent-success-criterion`,
      `subagent-result-ref`, `subagent-result-summary`, `subagent-reason` and `subagent-error`;
    - `subagent-notification`, `subagent-mailbox-sender`, `subagent-mailbox-text` and `subagent-waiting-summary`;
    - `subagent-workflow-title`, and `subagent-workflow-stage`, `-phase`, `-item`, `-key` and `-node`;
    - `subagent-fork-point` and `subagent-fork-from`;
    - `subagent-isolation-branch`, `-merged`, `-skipped`, `-conflict` and `-error`;
    - `subagent-stop-message`.
  - Replaced with the `data()` marker: `subagent-workflow-progress` and `subagent-structured-schema`.
  - Kept: `kind`, `agent`, `custom`, `status`, `background` and the model ids and variant.
  - Kept: the timestamps (`startedAt`, `completedAt`, `notification.claimedAt`, mailbox `createdAt` and `deliveredAt`,
    `interruption.*`, `waiting.since`, `expiresAt` and `notedAt`, `stop.at` and `reports.at`).
  - Kept: the counts and budgets (`batchIndex`, `attempt`, `usage.cost`, `toolUses`, `steps`, `unpricedSteps` and
    `codiumSteps`, `budget`, and each scope's numbers, `kind`, `costKind` and `stopped.reason`).
  - Kept: the engine ids (`parentSessionID`, `parentMessageID`, `callID`, `runtimeID`, `conversationID`,
    `rootSessionID`, `requestID`, notification `launchID` and `messageID`, mailbox `id`, `waiting.requestID`, scope ids,
    the workflow agent's `runID`, `fork.callID` and `structured.schemaHash`).
  - Kept: `effort`, `modelSource`, `owner`, `stop.by`, `mailbox[].delivery` and `from`, `fork.warm`, and the isolation
    `mode`, `state` and counts.
  - Fields the brief lists are redacted even where the engine writes an id:
    - `batchID` is `${sessionID}:${callID ?? messageID}` (`packages/engine/src/tool/task.ts:1283`);
    - `fork.point` and `fork.from` are message ids (`tool/task.ts:1308`, `:1523`);
    - the mailbox sender is a task or session id.
  - So a batch scope's `id` keeps the same value that `batchID` loses. That duplicates an id. It does not leak text.
- **R2, objects.** `workflow.progress` and `structured.schema` are replaced whole with the `data()` marker. Their leaf
  strings are not walked.
  - A JSON schema's property names, and the progress record's stage ids and keys, are text held in keys.
  - `data()` is how this file already treats every free-form object: text, reasoning and tool metadata, and tool input.
  - `SubagentLifecycle.read` still accepts both, since `progress` and `schema` are `Record<string, unknown>` there
    (`packages/engine/src/tool/subagent-lifecycle.ts:173-178` and `:208-230`). T1 asserts it.
- **R3, the session's other metadata keys.**
  - Each string at any depth is redacted as `session-metadata`, with id `-<i>` for each array element. Keys, numbers,
    booleans and null are kept.
  - The hand-off offered a second option: replace the whole value with `data("session-metadata", ...)`. It was
    considered and rejected, for two reasons. The string walk keeps numeric root fields, such as F43's root
    `usage.tokens` 7 and 8, which the F43 case pins. It also keeps the metadata's shape for an import.
  - Residual: the names of a client's own keys stay.
  - Engine-written root keys lose their string values too: `vector.kind` and `vector.parentSessionId`, which
    `packages/engine/src/task/limits.ts:179` and `:711-712` read, and VectorScope's `vectorscopeLocalRun` record
    (`packages/engine/src/review/local-run.ts:30`). So a sanitized export imported elsewhere no longer counts as a
    parallel-agent root, and its local review record no longer decodes. A sanitized export is not a backup (D-2), so
    this is the brief's choice, and is recorded here.
- **R4, judgement calls.**
  - `isolation.directory` is not in the type (`subagent-kind.ts:187`, I19), but a record written before I19 can hold
    it. The default rule redacts it, and T3 pins that.
  - `slotReason` is kept. It is only ever the engine constants `SLOT_REASON` (`packages/engine/src/task/limits.ts:50`)
    and `LAUNCHING_REASON` (`tool/task.ts:106`).
  - Each scope's `stopped.message` is redacted. Either choice was open, and this is the stricter one. `stopMessage`
    (`packages/core/src/spend-guard.ts:220-249`) is engine wording, but its loop branch names the looping tool, which
    can be a user-named MCP tool. `stopped.reason` keeps what stopped it, and a string marker still decodes in
    `Task.BudgetScope` and `DelegatedScope`.
- **R5, who writes the record, and the residuals.**
  - Clients set top-level metadata only. `PATCH /session/:id` goes through `SubagentLifecycle.setPublicMetadata`
    (`httpapi/handlers/session.ts:299`, then `subagent-lifecycle.ts:402-415`). That call keeps the stored `subagent`
    record and ignores the client's copy (F46).
  - So the record is engine-written. The exceptions are an imported archive, which can be crafted, and a record from
    an older or newer version. That is why the allow-list goes by key and not by who wrote the value.
  - A kept field keeps a scalar whatever it says. Each one the engine writes is an enum, id, number, timestamp or
    engine constant. So a string a crafted archive puts under one, such as free text under `status`, `agent`,
    `callID` or `slotReason`, stays. An object or list under a kept field is redacted (review fixes, below).
  - Numbers, booleans and null under a key the rule does not name are kept. So a numeric aggregate that a future
    version adds outside `taskMetadata`'s list would survive. `taskMetadata` (`cli/cmd/run/usage-output.ts:24-55`)
    stays the only guard for token figures, here and in run JSON (`toolForOutput`). Mutation m5 shows this: without
    it, `usage.total` 987686 and `tokensOwnOnly` survive while `usage.tokens` becomes a marker.
  - An alternative, dropping unknown numbers inside `usage`, was not taken. It needs a per-object default
    in the rule. A new aggregate field would also need adding to `taskMetadata` for run JSON anyway.
- **R6, the portable path.** It is pinned with a native fixture as well as a legacy one.
  - `export.ts:495` sends `--public`, and `--sanitize` on a native archive, through `shares.preview` and then
    `sanitizePublic`.
  - `publicArchive` (`packages/core/src/share/archive.ts:118`) builds only `version`, `engine`, `title` and
    `messages` (`:239-244`), decoded with `Schema.decodeUnknownSync(PublicSession.Archive)`
    (`packages/schema/src/public-session.ts:74-80`).
  - A native session's `Session.Info` (`packages/schema/src/session.ts:30-65`) has no metadata field at all.
  - T6 decodes a small native archive whose input `info` carries the lifecycle record. It asserts that the decoded
    `info` has no `metadata` key, and that the legacy and native portable archives have exactly those four keys and
    no private string. No change was needed there.
- **R7, the one existing assertion that changed.** The F43 case "a lifecycle record's aggregate tokens never reach a
  sanitized export: %s" (`export-sanitize.test.ts:348-373`) pinned `title: "child"` and `unrelated.label: "kept"` in
  its `toEqual`. That is the text F44 must remove.
  - They now expect `[redacted:subagent-title:ses_export]` and `[redacted:session-metadata:ses_export]`.
  - Every token assertion is unchanged: `987654`, `987686`, `tokensOwnOnly`, `info.tokens` and the unchanged source.
  - This is how the brief's "existing F43 cases still pass unchanged" is read: their token assertions pass unchanged,
    and the exact expectation is tightened, not loosened.
- **R8, unsanitized output and import.** T5 runs `localArchive` (`export.ts:513-516`), which `run()` prints for an
  export in the local format (`:505`). Without `--sanitize` it returns the decoded legacy archive itself, with the whole
  record and every private string. With `--sanitize` it returns none of those strings, and the archive it read is
  unchanged.
  - Before the review fixes, T5 only checked the decoded archive and that `sanitizeLegacy` leaves it unchanged. It did
    not run the branch, so a change that sanitized the unsanitized branch would still have passed.
  - T5 is still a unit test. It does not run `run()`'s portable or local choice (`:495`) or its stdout write.
  - The CLI round trip in `packages/engine/test/cli/import.test.ts` starts `vector serve`, so it is not run locally.
    Its sanitized-export case (`:224`) checks only the exit code and the privacy marker. It runs only in the lead's
    test.yml. No more is claimed. A CLI-level assertion there is For the lead item 3.
- **Plan review.** Before the build, a review of the plan raised eleven points. All were accepted and none was
  rejected. Each answer is recorded where it applies:
  - the numbers, booleans and null kept under a key the rule does not name (R5);
  - who writes the lifecycle record (R5);
  - a pre-I19 `isolation.directory` (R4, pinned by T3);
  - that T5 is a unit-level stand-in (R8);
  - a native fixture for the portable path (R6);
  - whole-object assertions with no cast: every T1-T4 assertion is a `toEqual` or `toMatchObject` on the whole metadata
    object, with no cast, and engine typecheck passed on the test file;
  - the privacy gaps outside the lifecycle record (For the lead item 1);
  - redacting or keeping `stopped.message` (R4);
  - what the CI receipt is ("Only in CI");
  - the engine-written root keys that lose their strings (R3);
  - formatting: prettier ran from the local install (`./node_modules/.bin/prettier`, a node script, through
    `vector-serial` except for the first `--write` of the test file). Nothing was fetched.
- **Tests** (`packages/engine/test/cli/export-sanitize.test.ts`), written before the source change. The new fixtures:
  - `TEXT` holds 27 private strings, one for each text field, plus a client string. Each appears once in the archive.
  - `steered()` builds a full `SubagentRecord` after a user steer, with usage tokens 987654 and total 987686, beside a
    root `parentSessionId` and a client `note`.
  - `leaked()` lists the `TEXT` values found in a value's JSON.

  The new describe block is "sanitizeLegacy lifecycle text":
  - T1 (`:421`): "a lifecycle record's text never reaches a sanitized export, while its status and timestamps remain".
    It checks for no leaked string, and no 987654 or 987686. Its exact `toEqual` covers every kept field and every
    marker. `SubagentLifecycle.read` still accepts the record, and the source is unchanged.
  - T2 (`:565`): the workflow agent variant.
  - T3 (`:617`): unnamed keys, a pre-I19 `isolation.directory`, and extra keys inside `notification` and `model`.
    `futureCount` 5 is kept.
  - T7 (`:656`), added in the review fixes: "an object or list under a kept field is redacted, since only a crafted
    archive holds one there".
  - T4 (`:693`): metadata with no `subagent` key, including `vector.kind`. It also checks that no `subagent` key is
    added.
  - T5 (`:718`): R8.
  - T6 (`:730`): R6.

  Results:
  - **Old source** (tests changed, source not): 11 pass, 8 fail. The failures were the four F43 cases on the two
    markers, and T1 to T4; T1's leak check listed all 27 strings. T5 and T6 passed before and after.
  - **New source:** 19 pass, 0 fail, 99 `expect()` calls.
  - **Mutations,** each restored by an edit:

    | Mutation | Pass | Fail | Failing cases |
    | --- | --- | --- | --- |
    | m1, `title: true` | 14 | 5 | the four F43 cases, T1 |
    | m2, unnamed keys kept | 18 | 1 | T3 |
    | m3, other metadata passed through | 13 | 6 | the four F43 cases on `unrelated.label`, T1, T4 |
    | m4, a labelled object walked leaf by leaf instead of `data()` | 17 | 2 | T1, T3 |
    | m5, no `taskMetadata` | 14 | 5 | the four F43 cases, T1 on 987686 (see R5) |
    | m6, `stopped.message` kept | 18 | 1 | T1 |

  - After the restores and a final comment-only edit to the rule's comment: 19 pass, 0 fail again.
- **Ran locally.** Each run went through `vector-serial`, from `packages/engine`:
  - `bun test --timeout 30000 test/cli/export-sanitize.test.ts`: red, green, the six mutations, green twice more.
  - `bun typecheck`, twice: it passed.
  - `prettier --check` on both `.ts` files passed, and `git diff --check` is clean.
  - `git diff --stat origin/codium-finish -- packages/schema packages/sdk packages/client/src/generated
    packages/client/src/generated-effect packages/web/public/config.json` is empty.
  - Not run in this build step, which neither commits nor pushes: the full `bun turbo typecheck --concurrency=2` and
    the api-tree `bun typecheck --project ../../tsconfig.json`. Both are pre-push steps.
  - Not run locally: `test/cli/import.test.ts`, which starts `vector serve`.
- **Only in CI.**
  - The Vector Codium dispatch on `codium-finish` with `base="origin/release-finish"` and no `browser_specs`. The
    Codium tests job selects the changed `export-sanitize.test.ts`. Its receipt is that file in the picker list plus
    the "Codium: N/N test files passed" summary. The per-file line is cited only if the visible log tail shows it.
  - Green means every job passes except "Run HttpApi exerciser gates", which may show exactly the 4
    `/experimental/review-memory` MISS lines and no FAIL. That log must be re-read before the run is called green.
  - typecheck.yml on the same ref.
  - No vector-hosted-ci.yml run, since no hosted file changed.
  - No CI id exists yet. A dated line under F44 and in this section adds the run and job ids. If no later lane commit
    is planned, a `docs(codium)` record commit carries them.
- **Review fixes (15 Nov 2026).** A review of this package raised six non-blocking findings. Two pairs repeat each
  other, so there are four issues: what a kept field may hold, T5 not running the unsanitized branch, the record's
  "three things" and its unexplained references, and one stale line number. All four were fixed. One optional step,
  narrowing `slotReason`, was not taken, and one suggestion, a CLI-level check, is For the lead item 3.
  - **A kept field keeps only a scalar.** Before, a `true` rule returned any value, so an object or list a crafted
    archive put under `status`, `slotReason`, `callID`, `isolation.mode` or `reports.at` was printed as it was. Now
    `redactLifecycle` (`export.ts:392-394`) sends an object or array under a `true` rule to the `subagent-field`
    label:
    - an object becomes the `data()` marker;
    - each element of an array is redacted alike: a string with `redact()`, an object with `data()`, and a number,
      boolean or null kept.
    - So `reports.at`, the engine's list of numbers, is unchanged. No `true` field the engine writes holds an object or
      list (`subagent-kind.ts:100-189`, `Task.Isolation` in `packages/schema/src/task.ts:89-101`, `RunBudget.Info`), so
      a real record sanitizes exactly as before. T1's exact `toEqual` still passes.
    - Both findings offered this. One redacted every non-scalar; the other redacted only plain objects and kept arrays
      of primitives. The first was taken: it also redacts a list of strings, and keeps `reports.at`'s numbers.
    - A string under a kept field still stays (R5).
  - **`slotReason` is not narrowed to the two engine constants.** That optional step was not taken.
    `LAUNCHING_REASON` lives in `packages/engine/src/tool/task.ts:106`. So the check would either import the task tool
    module into the export command, or move the constant out of this package's two files. It would also close one
    kept string, while `status`, `agent`, `callID` and the other kept fields keep theirs. R5 records the residual.
  - **T5 now runs the unsanitized branch.** `run()`'s local-format choice moved, unchanged, into the exported
    `localArchive` (`export.ts:513-516`; `run()` calls it at `:505`). T5 asserts that `localArchive(source)` and
    `localArchive(source, false)` return the archive itself (`toBe`), with all 27 strings. It also asserts that
    `localArchive(source, true)` returns none of them, and that the source is unchanged. A CLI-level check in
    `import.test.ts` is For the lead item 3.
  - **Record fixes.**
    - "three things" became "two things".
    - The plan review's numbered points are now described in words.
    - The planning note's report on F6's CI is replaced with the jobs and log this package read (For the lead item 2).
    - The `...msg.info` spread is cited at `:232`.
    - Every `export.ts` and test line number in this section, and in F44's dated line, was refreshed after the edit.
  - **Tests.** T7 (`export-sanitize.test.ts:656`) puts an object under `status`, `slotReason` and `isolation.mode`, a
    string and a number under `callID`, and an object among `reports.at`'s numbers. It checks that no string leaks and
    that each value gets its marker. It also checks that `reports.at`'s 35, `callID`'s 7, `isolation.state` and `files`,
    and `startedAt` stay.
    - Before the source fix (T7 added, `redactLifecycle` unchanged): 19 pass, 1 fail. T7 failed, and its leak check
      listed all five strings.
    - After: 20 pass, 0 fail, 104 `expect()` calls, twice.
    - Mutation m7, `localArchive` always sanitizing: 19 pass, 1 fail (T5).
    - Mutation m8, a `true` rule returning any value: 19 pass, 1 fail (T7).
    - Each mutation was restored from a copy, and the restored file was diffed against that copy.
    - T5 now imports `localArchive`, so this test file no longer loads on the pre-F44 source. The old-source red run
      above was taken before that import existed.
  - **Ran locally,** through `vector-serial` from `packages/engine`: the test file (red, green, m7, m8, green),
    `bun typecheck` (passed), `prettier --check` on both `.ts` files (passed) and `git diff --check` (clean). The full
    turbo typecheck and the api-tree typecheck are pre-push steps, not run in this fix step. Nothing else changed in
    "Only in CI".
- **For the lead.** These are not fixed here.
  1. **F44b, in the same function: `sanitizeLegacy` still passes these through.**
     - The assistant message's `error` (`packages/schema/src/v1/session.ts:504`) and `structured` answer (`:530`),
       through the spread at `export.ts:250`.
     - The tool error state's `error` text (`export.ts:127-131` spreads `part.state`).
     - Retry parts (the API error's message, response body, headers and metadata) and any other unhandled part type,
       whole, through the `default` branch (`:164-165`).
     - The user message's `format` JSON schema, through `...msg.info` (`:232`).
     - `info.path`, the relative sub-directory (`session.ts:615`), through `const info = { ...data.info }`
       (`export.ts:181`).
     - `info.share`, with the share URL (`session.ts:637`).
     - `info.permission`, whose rule patterns can hold paths (`session.ts:649`).
     - `info.workspaceID` (`session.ts:613`).

     Each is a privacy reading of `--sanitize` outside F44's lifecycle scope.
     21 Nov 2026: repaired on branch `engine-core-fixes`, all in `packages/engine/src/cli/cmd/export.ts`. The tool
     error state's `error` is redacted (`tool-error`); retry parts and the assistant `error` go through one
     `redactError` helper that keeps the name, codes, flags and figures, redacts `message`, `responseBody` and `ref`,
     and turns `responseHeaders`/`metadata` into markers (literal fields such as `code`/`reason` stay, so the union
     still decodes); `structured` becomes a `structured` marker (or redacted strings when it is not a record); the
     user `format`'s JSON schema becomes a `format-schema` marker; `info.path` is redacted, each permission rule's
     `pattern` is redacted (tool and action stay), and `share` and `workspaceID` are deleted. The `default` branch now
     fails closed: an unnamed part kind keeps its type and id keys (`id`, `sessionID`, `messageID`, `*_id`) and every
     other string is redacted. Tests: `packages/engine/test/cli/export-sanitize.test.ts` "sanitized export
     pass-throughs (F44b)" seeds one private value per field, checks the source holds all eleven, then that the
     sanitized archive holds none, decodes as `SessionArchive.Legacy`, and carries the exact markers; red on the old
     `export.ts` (21 pass, 1 fail). `import.test.ts` 6 pass. The CLI child-lifecycle case in
     `import.test.ts` followed later the same day (item 3 below).
  2. **F6's CI receipt is missing from the records.** F6's Vector Codium run 43674652525, on `5f19b0c9`, completed with
     conclusion failure (`get_workflow_run`). This package's review fixes read its jobs (`list_workflow_jobs`) and the
     failing job's log tail (`get_job_logs`, 140 lines):
     - Every job succeeded except "Codium tests" (job 132692043010). "Hosted services / Hosted tests" and the hosted
       typecheck matrix were skipped, as the lane's `services_only` call skips them.
     - In job 132692043010, "Run the Codium test files" and "Check generated client" succeeded. Only "Run HttpApi
       exerciser gates" failed.
     - That step's visible tail shows no FAIL line and exactly the four baseline MISS lines:
       `DELETE /experimental/review-memory/previews/{previewId}`, `GET /experimental/review-memory`,
       `POST /experimental/review-memory/confirm` and `POST /experimental/review-memory/prepare`. Its summary is
       `pass=359 fail=0 skip=0 missing=4 extra=0`.

     By the lane's baseline rule the run counts as green. F6's dated CI line is still not in `codium-p4-repairs.md` or
     in its deviations section. This package does not add it.
  3. **A CLI-level export check.** T5 runs `localArchive`, not the CLI. `packages/engine/test/cli/import.test.ts`
     could assert that a plain `vector export` output contains a child's title and mailbox text, and a `--sanitize`
     output does not. It starts `vector serve`, so it runs only in CI. It is left for the lead or a later package.
     21 Nov 2026: added on branch `engine-core-fixes`. `import.test.ts` "a sanitized CLI export of a child session
     redacts its lifecycle title and mailbox text" starts a real `vector serve`, creates a parent and a child whose
     `metadata.subagent` record holds a title and one mailbox entry, then runs the CLI: a plain `vector export` holds
     both strings, and `vector export --sanitize` holds neither and carries the `subagent-title` and
     `subagent-mailbox-text` markers. It runs locally (7 pass, 0 fail, 58 s for the file). Mutation: the LIFECYCLE
     rule's mailbox `text` set to `true` makes only this case red (the mailbox text leaks); restored from a copy. It
     uses the file's `PROCESSES` budget, like the other multi-process cases. Seen while writing it: `POST /session`
     passes a caller's `metadata.subagent` through `Session.create` unfiltered, while `PATCH` keeps it lifecycle-owned
     (`SubagentLifecycle.setPublicMetadata`). Left as a follow-up for the lead; not changed here.
- Edits to `api/_lib/model-plan-*.ts`: none. No MODEL-PLANS.md change.

**F44's CI receipts (recorded by Codium finish DZ, 15 Nov 2026)**

These are for `2924d94b`, read from the runs' jobs and logs.

- Vector Codium run 43679383178 had 18 jobs. 15 succeeded, and 2 were skipped by `services_only`.
  - Codium tests job 132706470083 failed only at the exerciser step. Its visible tail shows "Codium: 122/122 test
    files passed", then exactly the four review-memory MISS lines and `summary pass=359 fail=0 skip=0 missing=4
    extra=0`.
  - Its step list shows that "Run the Codium test files" and "Check generated client" succeeded, so the run is green
    under the lane rule.
  - Codium browser specs job 132706469934 passed.
- typecheck.yml run 43679385886: success.
- vector-hosted-ci.yml run 43679749016: success (run conclusion).
- For the lead item 2 above, F6's receipt, is completed here for F6's other two runs at `5f19b0c9`. typecheck.yml run
  43674654638 and vector-hosted-ci.yml run 43675036401 both concluded success. F6's dated CI line is now in
  `codium-p4-repairs.md`.

No per-file count for F44's test files is claimed.

## P6 review addendum (15 Nov 2026)

Contract readings from the A36 Playbooks server review (Codium finish R36). The findings, repairs and tests are in
`codium-p6-repairs.md` ("A36 Playbooks server (P6 addendum, 15 Nov 2026)"). Read on `codium-finish` `2924d94b`; scratch
and the fresh XDG and `TMPDIR` roots were under `/tmp/vector-v2/codium/r36/`.

- **One allowlist (B01's item).** `packages/core/src/playbooks/commands.ts` re-exports BrainSkill's `TARGETS`,
  `DENY_WORDS`, `CHECK_ENV`, `simple`, `helper` and `check` and keeps `allowed`. The comment-stripped diff showed no
  behavioural difference, so no list had to be chosen. `CHECK_ENV` is re-exported too, so the module's exports are
  unchanged. A plain `export { ... } from "../brain/skill"` keeps BrainSkill's own docs and is neither an alias nor a
  star import.
- **What loading BrainSkill costs.** The check's static import graph grows from 9 to 61 relative core modules, among
  them `brain/database` (`#sqlite`, drizzle, the migrations), `flag/*` and `global.ts`. A probe that imported the
  module from `test/` with `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `TMPDIR` and `HOME`
  all under the scratch root found that, at HEAD, `check.ts` created no folder. After the change it creates exactly
  these: `<XDG_DATA_HOME>/vector`, `<XDG_DATA_HOME>/vector/log`, `<XDG_DATA_HOME>/vector/repos`,
  `<XDG_CONFIG_HOME>/vector`, `<XDG_STATE_HOME>/vector`, `<XDG_CACHE_HOME>/vector/bin` and `<TMPDIR>/vector`
  (`packages/core/src/global.ts:10-29,35-43`). It also sets Flock's global state folder in memory (`:33`). Nothing was
  written under `HOME`. Bun's own transpiler cache also lands under `XDG_CACHE_HOME/bun` when that variable is set,
  with or without this change. One import each took 238 ms before and 324 ms after (indicative). So
  `script/playbooks-publish.ts check` still needs no settings and reaches no network, but it now creates Vector's own
  folders, as any Vector command does. The script header and MODEL-PLANS.md say so. The consumers are the script, the
  root test and core `install.ts` through the engine and CLI, which already load these modules. No browser bundle
  imports `check.ts` or `commands.ts`. Local root and core runs of this package set all four XDG roots and `TMPDIR`.
- **Models only as Codium roles.** This reads B07's "`codium:floor|default|ceiling` resolve per tier" and the A36
  notes' "models only as `codium:floor|default|ceiling`" as: wherever the saved schema names a model (`defaults.model`,
  an agent stage's `model`, its verifier's `model`), a playbook names either nothing or exactly one of the three roles.
  A concrete model would pin one provider or one plan's model for everyone who installs it, past the per-plan role
  resolution. An omitted model is allowed and left to the runner. `agent`, `effort` and `isolation` are not restricted:
  the engine still checks the agent against its catalog (`runs.ts:200`). The rule runs at publish and at install (the
  client runs the same `validate`). `runs.ts:202` holds the same pattern and still refuses a role outside a personal
  Vector Playbook, so the two are kept equal by hand (For the lead). No playbook is published, so no installed file is
  affected.
- **A hash field is its record's name.** §4.6 does not list the `playbooks` key; A36's reading (field = name) is now
  enforced on read. A record under another field is never listed, signed, counted toward `Playbooks.MAX_LISTED` or
  `Playbooks.MINIMUM`, or shown by `list`. `withdraw <field>` still removes it, and the answer names no version
  because the record does not decode under that name. `api/_lib/web-push.ts` `readSubscriptions` (`record.id === id`)
  is the same pattern. No further code was added for stray fields: only a hand edit makes one. A stray field stays in
  the hash and in `HGETALL`'s answer until it is withdrawn by its field name, but it counts nowhere: no playbook path
  calls `HLEN`.
- **A withdraw removes the version floor; content stays immutable.** "A published version never changes" (A36 notes,
  MODEL-PLANS.md) holds: the bucket refuses other content at any key it holds. "The library never goes back to an older
  version" holds only while a playbook stays published. After a withdraw the library holds no record, so the script
  accepts any version. A version below the withdrawn one, with new content at a new key, would be uploaded and
  recorded, because the HEAD/ETag check guards only keys that already exist. The engine client compares SHA-256 values
  (`packages/engine/src/orchestration/playbooks.ts:55`), not versions, so it would offer that lower version as a
  change. The repair is advice only: `withdraw` prints the withdrawn version and says to publish above it. The owner
  step "after a withdraw, publish only above the version the script names" is in the A36 notes and MODEL-PLANS.md. A
  floor read from the bucket (a signed LIST of `playbooks/<name>/`) is not built here.
- **Renewing past the grace.** §4.4's Playbooks row is on while renewing. Within the renewal grace (120 minutes by
  default) a renewing plan downloads. Past it, before reconcile catches up, the route gives the shared 503
  `MODEL_PLAN_RENEWING` (retry after 30 s) that the snapshot gives every perk. Now tested.
- **The 401 code.** Run tokens, Basic auth and a website session get 401 `CLI_TOKEN_INVALID`, as `api/account/profile.ts:28`
  and `api/support/bug-report.ts:99` answer a missing account token. No new code was added for "wrong kind of token".
- **S8.** The route's only outbound call is the store; signing is local. The script's HEAD and PUT and the client's
  download all use `redirect: "error"`. The client takes only `https` links without credentials
  (`Playbooks.decodeLinks`, `packages/schema/src/playbooks.ts:77`) and sends no account header to them
  (`install.ts:13`). The R2 host comes from the signer, never from the store.
- **Still open.** The estimate API's `{kind: "playbook"}` band (`api/_lib/model-plan-estimate.ts:275`), publishing any
  playbook and listing the perk (the owner's). Commands written as plain text outside code spans and fenced blocks are
  still not parsed; the owner reviews every playbook.
- **Review of this package (15 Nov 2026).** Eight non-blocking points, read against the code:
  1. The immutability test's title still said the library never goes back. Taken: renamed (R36-4).
  2. Loading BrainSkill creates Vector's folders under whatever XDG roots or `HOME` the runner has, and `test/` has no
     preload that sets them. Kept as recorded above. Splitting the allowlist into a module with no database imports
     (for example `brain/skill-commands.ts`, re-exported by `skill.ts` and `commands.ts`) is the brain lane's (For the
     lead, item 1). Until then every local root and core run sets the four XDG roots and `TMPDIR`.
  3. The 50-name cap was checked against `readPlaybooks`' sliced answer. Taken: `publish` checks the cap only for a
     name with no record (R36-15, with a regression). The reviewer's "`HLEN` still counts stray fields" does not
     apply: no playbook path calls `HLEN` (the reading above).
  4. The P1 check was only a word scan. Taken: each refusal's whole body is compared with the contract's exact detail
     (R36-13), and a mutation shows the scan alone would miss an extra figure.
  5. The `allowed` loop restated the implementation. Taken: explicit cases (R36-1).
  6. The new `install.test.ts` lines were not prettier-wrapped. Taken: those lines now match prettier's output; the
     rest of the file keeps its style.
  7. `ROLE` copies the engine's pattern (`packages/engine/src/orchestration/runs.ts:202`). Kept: one exported
     constant (for example `Playbooks.CODIUM_ROLE` in `packages/schema/src/playbooks.ts`) used by both files waits for
     one owner of both (For the lead, item 2). An equality test was not added, because the engine's pattern is an
     inline literal that a test could only copy.
  8. The withdraw read's `.catch(() => undefined)` swallows every error. Kept: `readPlaybook` throws only the store's
     503 (`api/_lib/persistent-store.ts:10,18,20`; `decodePlaybookRecord` answers undefined on any malformed record
     and never throws), so catching only that error would change nothing today and would add a rethrow after the
     `HDEL`. The comment at `script/playbooks-publish.ts:155-156` now says so.
- **Plan and critique.** All of the critique's points were taken: the full folder list, `TMPDIR` in every root and
  core run, the read before `HDEL` cannot stop the pull, the past-grace renewing case, one scratch root, a dated B07
  line in `codium-track-b-checkpoint.md`, the engine test marked local only, the plain re-export, no web test (perk
  listing is unchanged), the stray-field reading, and the lower-version consequence. The plan's `HGETALL` store-fake
  case is in `test/roadmap-fixture.ts`. The CI receipt is folded into the lane commit that follows the runs, not a
  receipt-only push.
- **Ran locally**, through `vector-serial`, one file at a time with `--timeout 30000`:
  - root: `playbooks-api` (15 before, 17 after), `api-module-loading`, `roadmap-api` and `brain-vault-api`;
  - core: `playbooks/commands` (11, then 12), `playbooks/check` (new, red then 3), `playbooks/install` (3, then 4) and
    `brain/skill-commands` (6);
  - engine: `orchestration/playbooks` (2);
  - four mutations, each restored;
  - `bun typecheck` in core and schema, and the api tree;
  - a scratch typecheck of the script and the root test;
  - `prettier --check`;
  - re-run before the commit (15 Nov 2026): all of the above files again, plus root `account-delete` and engine
    `server/httpapi-workflow`, and `bun typecheck` in engine too (`codium-p6-repairs.md`, A36 addendum);
  - after the review fixes (15 Nov 2026): root `playbooks-api` (red, then 17), the four core files, one more mutation,
    `bun typecheck` in core and the api tree, the scratch typecheck and `prettier --check` (the A36 addendum's "Review
    fixes" paragraph).
- **Only in CI:** Vector Codium and typecheck.yml, both pending. The Valkey block of `roadmap-api.test.ts` was skipped
  here. The HttpApi exerciser's `experimental.playbooks.install.invalid` scenario and the engine playbooks test are not
  selected by the picker (they are unchanged), so the engine install path has only the local receipt.
  CI, 15 Nov 2026 (recorded by Codium finish F28): Vector Codium run 43685974875 on `265f4ea7` counts as green under
  the lane's baseline rule: 15 of 18 jobs succeeded, 2 were skipped by `services_only`, and Codium tests job
  132726419932 failed only at "Run HttpApi exerciser gates" with exactly the four `/experimental/review-memory` MISS
  lines and `summary pass=359 fail=0 skip=0 missing=4 extra=0`; its step list shows "Run the Codium test files" and
  "Check generated client" succeeded. typecheck.yml run 43685977976 succeeded. Details in `codium-p6-repairs.md`
  (A36 addendum, "CI, 15 Nov 2026").
- **For the lead.**
  1. A lighter allowlist module would keep the publish check from loading the Brain database and `global.ts`. It would
     mean moving `simple`, `helper`, `check` and their lists out of `packages/core/src/brain/skill.ts`, the brain lane's
     file, into a module with no database imports, which `skill.ts` and `commands.ts` both re-export. Not done here.
  2. `ROLE` in `packages/core/src/playbooks/check.ts:137` and the pattern at
     `packages/engine/src/orchestration/runs.ts:202` should become one export once someone owns both files.
  3. F28 is still open; it has its own package.
     15 Nov 2026 (Codium finish F28): closed; see the F28 bullet below.
  4. Re-measure the picker's selection before the dispatch. This package adds one new core test file and changes
     `test/roadmap-fixture.ts`, which `test/*.test.ts` already covers.
- **F28 (Codium finish, 15 Nov 2026).** The phone usage alert repeated while the desktop notification kept failing
  (P4b's hand-off). Findings, repair, regression and tests are in `codium-p6-repairs.md` ("A41 phone usage alert (F28,
  P6 addendum)"). Read on `codium-finish` `265f4ea7`; scratch under `/tmp/vector-v2/codium/f28/`. Contract readings:
  1. **One alert per account, plan and renewal, shared by both channels (A24), and the phone at most once.** A24's
     shared key is kept: an alert on either channel still silences the other for that period, as before, so a switch
     turned on later sends nothing for a period that already alerted (pinned by a test, both orders). The phone alert is
     also recorded in a set of its own, so A24's retry after a failed desktop notification never repeats it. The plan
     proposed separate per-channel sets, under which a switch turned on later would send its own alert; the critique
     pointed out that this adds a send F28 does not ask for, and it was not taken. The fix only removes repeats.
  2. **A phone alert that `sendPhoneAlert` held back is tried again, exactly as before.** The phone set's key is added
     before the send, so overlapping reads cannot send twice, and removed when `sendPhoneAlert` resolves false (quiet
     hours, the event switch off, alerts not listed for the plan, no `phoneAlerts.send`, or a failed send). So with both
     switches on and the desktop notification failing, a held-back phone alert goes at a later read, as it did before
     F28; once the desktop notification was shown, or with only the phone switch on, A24's shared key ends the period
     and a held-back phone alert is not tried again, also as before (both pinned by the quiet-hours case). The first
     draft of this repair kept the key after a held-back send, which also dropped that retry; the package review
     (finding 1) pointed out that this narrowed behaviour beyond removing repeats, and it was changed.
  3. **The threshold is `usageShare`'s whole percentage (H5).** `share.used < 80` replaces the raw `left > 0.2`. For
     whole-percentage inputs, which are all the server sends (F24), nothing changes. A hand-made share with
     0.2 < left < 0.205 now alerts, matching the card's "80% used · 20% left".
  4. **The desktop main process's 60 s fingerprint dedupe (`packages/desktop/src/main/remote-notify.ts:23,73-74`) is
     not the guard.** Usage reads further apart than a minute (focus, Refresh) passed it.
  5. **Callers.** Every `sendPhoneAlert` caller was read: `context/notification.tsx:369` (finished), `:386` (Run
     Guard), `:459` (needsYou), `pages/layout/ask-notifications.ts:60` (needsYou; Hands' file, read only). The Usage
     card was the only sender of the "usage" event. v2-master-prompt 8.2 moves only `layout.tsx`'s alert (needsYou)
     into `ask-notifications.ts`; the usage alert was never in `layout.tsx`.
  6. **Defaults and settings.** `codium.alert80` and `notifications.events.usage` stay false (`context/settings.tsx`
     not touched; `settings.test.ts` and `notifications-model.test.ts` assert them). No setting, switch, flag, copy,
     price or page was added; both titles and the desktop text are byte-identical. `MODEL-PLANS.md` is unchanged. No
     phone receives anything until the owner lists alerts (`phoneAlertsOffered`).
  7. **The decision is a module beside the component** (`codium-usage-alert.ts`), with the dedupe state, `notify` and
     the phone sender injected, so it is tested without a browser; the component keeps the state for the app lifetime
     and its effect passes the same tracked reads.
  8. **Plan and critique.** Taken: the shared key with one phone-only set (above); an `async` fake `notify` and a
     macrotask flush after each read, with the old transcription returning the notify promise; the F28 case through the
     real `sendPhoneAlert` and `phoneAlerts.send` with `resetPhoneAlerts()` before each case; the R36 receipt read from
     the step list and a 400-line tail; dated closing lines under the P4 summary's F28 item and the Lane status note;
     the old transcription kept in scratch with its substitutions recorded; full `Status` fixtures (`plan.left` is
     optional in `ModelPlanStatus.Status`); every case each mutation turns red; word boundaries in the figure scan. Not
     taken: the plan's per-channel sets and its "switch turned on later sends its own alert" case (reading 1). Package
     review, all four findings taken: the held-back phone retry (reading 2) with its quiet-hours case; the fake platform
     checked with `satisfies` against the `Platform` and `VectorAccountPlatform` parts it implements, cast only where
     `sendPhoneAlert` takes the whole `Platform`; the readings re-wrapped; and the green receipt re-taken on the final
     test file.
  9. **Ran locally**, through `vector-serial`, one file at a time with `--isolate --timeout 30000` from `packages/app`:
     `codium-usage-alert.test.ts` (red on the old body, 5 pass and 3 fail; then 8 pass, 44 `expect()` calls), five
     mutations (each restored and checked with `cmp`), `phone-alerts.test.ts` (6), `codium-usage-model.test.ts` (10),
     `settings.test.ts` (6) and `notifications-model.test.ts` (4); `bun typecheck` in `packages/app`; `prettier --check`
     on the three code files; `git diff --check`.
  10. **Only in CI:** Vector Codium (Codium tests selects the new file and `codium-usage-model.test.ts` by name; the
      browser job runs `packages/app/e2e/regression/account-settings.spec.ts` when it is passed as `browser_specs`) and
      typecheck.yml. Pending: this step left the change uncommitted.
      CI, 15 Nov 2026 (recorded by Codium finish R45a): on `ab784e44`, Vector Codium run 43689606818 (18 jobs: 15
      succeeded, 2 skipped, and Codium tests 132737256591 failed only at "Run HttpApi exerciser gates", with the four
      baseline review-memory MISS lines and no FAIL; green under the lane rule), Codium browser specs job 132737256831
      (25 passed, `account-settings.spec.ts:586` among them in the visible tail), typecheck.yml run 43689609193 and
      vector-hosted-ci.yml run 43690118133 succeeded. Details in `codium-p6-repairs.md` (F28 section, CI line).
  11. **For the lead:** none. No other lane's file needed a change; `ask-notifications.ts` was read only.
- Edits to `api/_lib/model-plan-*.ts`: none.

## P7 review addendum (15 Nov 2026)

Contract readings from the A45 desktop vault review, part 1: the desktop main process and the engine routes (Codium
finish R45a). The findings, repairs and tests are in `codium-p7-repairs.md` ("A45 desktop vault: main process and
engine routes"). Read on `codium-finish` `ab784e44`. Scratch and the fresh XDG and `TMPDIR` roots were under
`/tmp/vector-v2/codium/r45a/`: the task's first line names `/tmp/vector-v2/codium/` as the only scratch root, and R36
and F28 used it too.

- **A key record that does not open is no key (R45-1).** The desktop's key adapter (`vaultKeys` in `vault-runtime.ts`)
  answers undefined for a record this launch cannot open (a new credential key, a damaged record) and for a value
  without the `vs1.` prefix, which no vault record ever had. The record is not deleted on read; the recovery code opens
  the vault and the next write replaces it. Delete treats the deleted vault as this computer's when the readable record
  names it or, while no record reads, when `settings.vault` does (the settings name the vault of the key written with
  them), or when the place held no vault key. Only then does it reset `vault`, `enabled` and `last`. The key is cleared
  when a readable record names the deleted vault, or when no record reads while the credential store is open, where
  that record can never open. "No record reads" is not one case. With the store open the record is gone or damaged for
  good. With the store locked (`vaultSecrets.available()` false) it may open at the next launch, so Delete keeps it.
  If it does open later, it names a vault that no longer exists, and the next backup puts that vault back at the place
  with the same key and recovery code (core `attach`), so nothing is lost either way. A backup with no readable key
  over a store that holds a vault still refuses a second vault (core `VaultBackup.create`). The adapter moved out of
  `startVault` so the sign-ins test can load it with Electron mocked; `decodeKeyRecord` now takes the opened JSON
  text.
- **`VaultError` is the plain-copy boundary (R45-2).** Spec 4.10 asks for plain copy for VAULT errors, and core's
  `vault/error.ts` says no message carries a key, code, content or amount. The desktop now shows and keeps only a
  `VaultError`'s text; any other error answers the operation's fixed fallback. The errors the desktop throws on purpose
  became `VaultError`s (`unavailable`, and `update` for an engine section this build does not know). The plan's own
  error is fixed copy from `model-plan-status.ts:169`, `:173`. One fixture changed: the "fails after the vault was made"
  case now throws the `VaultError("unavailable")` core's GitHub store really throws.
- **A move is refused while an operation runs; the switch is not (R45-3).** `configure` answers busy only when the
  backend or the repository changes while a backup, restore, forget or delete runs. Turning the nightly backup on or off
  still saves, because the running backup writes only `vault`, `last` and its own fields over a fresh read.
- **git's text (R45-4).** The desktop's own spawn-error line is fixed copy now. Core's `failed()` (A43) still appends
  git's first stderr line, which can name local paths or, through the person's own `insteadOf`, a URL with a
  credential; A43's "the URL carries no credential" holds only for Vector's URL. Handed to the lead, as the file is
  outside this package's scope.
- **Vector Local's "blocked" (R45-15).** `brain-vault` is `local: "blocked"`: with Vector Local on, both backends are
  refused before any store, sign-in or status read unless the person allows the source; GitHub needs both `git-remote`
  on github.com and `brain-vault` on api.github.com. Web access None also limits git to local remotes.
- **B10's sizes (R45-10).** Insights are bounded well under 2 MB. Skills are not shown to be: the export lists every
  skill row, archived and superseded included, and the desktop sends the file whole. Recorded as not confirmed for B10;
  nothing was changed here, because splitting or capping learned files is B10's design.
- **Who can plant a symlink or git config (R45-12, R45-20).** The desktop's bare copy is under `userData`, which the
  shell sandbox does not let commands write; without the sandbox, nothing protects any of the person's files from
  their own commands. The CLI's copy is under `~/.cache`, which the sandbox keeps writable by design, so a sandboxed
  command can plant config or hooks that run at the next `vector vault backup` (For the lead).
- **Remote's allowlist is pinned (R45-14).** `REMOTE_ROUTES` names no memory route; a test now refuses six memory
  routes from a paired phone, and the engine test covers the forwarded-guest marker on backup and restore.
- **Plan and critique.** Taken from the critique: R45-1's Delete condition and its controller case; git's stderr as
  its own finding (the desktop line repaired, core's `failed()` handed off) instead of "kept"; every later commit on
  the scoped paths classified, with the broadcast credited to `ebd6cba3`; the symlink and worktree readings; the
  git-credential test reworked to probe git's own environment through `desktopGit` with planted Vector secrets (so a
  failure never prints the environment) and without the show-scope check; `decodeKeyRecord` described as changed, the
  red run described as the refactored adapter with the old read body, and the `vs1.` prefix check with its
  no-credential-store assertion; the CLI items numbered as findings (R45-18 to R45-20); B10's size marked not
  confirmed; the redundant restore and timer cases dropped and the Local case reduced to `localRefusal`; the stale A45
  notes sentence flagged for the owner; prettier through `vector-serial`, the scratch root stated, and the F28 receipt
  worded with all 18 jobs. Not taken: deleting `VECTOR_VAULT_RECOVERY_CODE` inside `vault restore`, because agents'
  shells inherit from the long-running `vector` process, not from `vault restore`, so it would not close R45-18.
  R45-4(a)'s first test drives a git that cannot run (ENOEXEC). Bun throws from `spawn` where Electron's Node emits
  the child's `error` event, so that test pins what the person sees (either plain text).
- **Review of the R45a change (15 Nov 2026).** Taken:
  - Blocking: the first R45-1 condition cleared the key with the credential store locked. Delete now clears a record
    that does not read only while `deps.keys.secure()`, with a locked-store test.
  - The settings fallback for "this computer's vault": `record?.vault ?? current.vault`.
  - A red test for R45-4(a)'s line through an optional test-only `command` on `desktopGit`. Under Bun an absolute path
    to a mode-0644 file gives the `error` event with EACCES.
  - The credential test asks `printenv` for the names it checks, never `env`, and unsets `GIT_TERMINAL_PROMPT` first,
    which the shell had set.
  - The `VaultError` import moved up with the package imports.

  Not taken as written: the second Delete finding's formula `if (!held || !mine || held.vault === mine)` for both the
  key and the settings. With the store locked, it clears a record that may still open whenever the place held no vault
  key, or the settings name no vault. It also clears it when the settings name the deleted vault. That is the loss the
  blocking finding describes. Its settings rule is used, and the key follows the blocking finding: a record that does
  not read is kept while the store is locked.

  The F28 CI receipt (`codium-p6-repairs.md`, and item 10 of the F28 section above) is a separate record from R45a's.
- **For the lead:** R45-4(b) (`packages/core/src/vault/github.ts:115-118`: drop git's stderr line or strip paths and
  URLs from it; repaired 21 Nov 2026 on branch `engine-core-fixes` by dropping it, see `codium-p7-repairs.md` R45-4); R45-18 (`packages/core/src/child-environment.ts:5-14`: add `VECTOR_VAULT_RECOVERY_CODE` to
  `PRIVATE_RUNTIME_ENVIRONMENT`; repaired 21 Nov 2026 on branch `engine-core-fixes`, see `codium-p7-repairs.md`
  R45-18); R45-19 (`packages/engine/src/tool/shell/sandbox.ts:83`, `:496-514`: deny
  `<data>/vault/vault.json`); R45-20 (`packages/engine/src/cli/cmd/vault.ts:168` or the sandbox: move the CLI's copy
  out of the cache, or deny it; repaired 21 Nov 2026 on branch `engine-core-fixes` by moving it to the data folder and
  passing no-hooks to every ref-writing git, see `codium-p7-repairs.md` R45-20); R45-22 (`packages/desktop/src/main/remote-runtime.ts:43-45`, for A41's next review).
  For the owner's A60 legal read: backups now carry `skills` and `insights` sections (the A45 notes still say memory
  only); no privacy text changed.
- **Ran locally**, through `vector-serial`, one file at a time with `--timeout 30000`: desktop `vault-backup.test.ts`
  (23), `vault-github.test.ts` (11), `vault-secrets.test.ts` (6), `vault-secrets.sign-ins.test.ts` (5) and
  `remote-routes.test.ts` (16) with `--no-env-file`; engine `test/server/memory-vault.test.ts` (6) and
  `test/cli/vault.test.ts` (2); core `test/vault/vault.test.ts` (18). Before counts, the red runs and eleven
  mutations are in the P7 record. `bun typecheck` in desktop, engine and core; `prettier --check`; `git diff --check`.
- **Only in CI:** the HttpApi exerciser, Vector Codium (Codium tests and the browser job), typecheck.yml and
  vector-hosted-ci.yml's Hosted tests job. Pending: this step left the change uncommitted.
- `handlers/memory.ts` and `groups/memory.ts`: unchanged. No setting, flag, route, copy on a public page, price or
  listing changed, so `MODEL-PLANS.md` and the owner-actions files are unchanged.
- Edits to `api/_lib/model-plan-*.ts`: none.

Part 2 (Codium finish R45b, 15 Nov 2026): the renderer (Settings → Memory → Backup), the bridge and Vector Local's
inventory. Findings, repairs and tests are in `codium-p7-repairs.md` ("A45 Settings → Memory → Backup"). Read on
`codium-finish` `420e729f`; scratch under `/tmp/vector-v2/codium/r45b/`.

- **Only copy written for the person is shown, never a thrown IPC error (R45-24).** Brain Vault's refusals arrive as
  results. Anything that throws through `invoke` carries Electron's "Error invoking remote method …" around a
  main-process error, and the page now shows its fixed fallback for all of them. This differs on purpose from
  `vercelErrorText` and `renderer/initialization.ts`, which strip the prefix and keep Vector's sentence: after R45-27
  the page cannot reach the one plain thrown sentence ("Vector is still starting…"), and the rest (`assertTrustedRenderer`,
  structured-clone failures) were never written for a person.
- **B10's "restored as drafts for review" (R45-25).** Read as: the engine answers learned sections as waiting whatever
  they were; the desktop counts restored skills and insights apart (`totals.skills`, `totals.insights`) and adds
  nothing of theirs to in use, pinned or waiting; the page calls them "to review", and "as before" covers memory only.
  A restore that brought back only learned content shows no "0 in use, 0 waiting … as before" part
  (`memory-backup-model.ts` `restoreLine`); with no learned content the memory parts show even at zero, as before.
  `RESTORE_COPY` on the card says learned skills and workflow insights come back as proposals; no separate note
  repeats it.
- **Learned known and refused stay in the shared totals (R45-38).** `vault-backup.ts` adds a learned file's `known`
  and `refused` to the same totals as memory's, so "already in memory" and "refused (forgotten here, or past what may
  wait for review)" also count learned skills and insights, and the reason does not name a skill refused for an unsafe
  command. The review's optional split (`skillsKnown`, `skillsRefused`) was not taken: it adds fields to the restore
  result shared by main, the preload types and the page for copy only, the counts are right, and the refused wording
  was already a summary (it does not name a memory entry refused as secret or too long either).
- **The startup stand-in is marked (R45-27).** `vaultStarting()` carries `starting: true`, and `startVault` broadcasts
  the real status once. The page keeps a real status against a late stand-in answer (the broadcast can beat the
  answer to the page's own read), shows no control while starting, and takes the repository field from the first real
  status. `STARTING_COPY` makes no timing promise, because a failed engine start never runs `startVault` (R45-37).
- **Vector Local's inventory text (R45-26).** The `brain-vault` source now says a backup carries memory, learned skills
  and workflow insights. It is the in-app network inventory (Settings → Vector Local, the allow dialog's "Sends", the
  blocked notice), not privacy or legal text. The privacy draft's `#vault` wording is unchanged and stays with the
  owner's A60 read, which now names both. The page's own description says the same; `lastLine`'s "memory files" is
  kept (R45-35).
- **Validated in main, not in the preload (R45-28).** The preload passes the eight vault calls' arguments through. Main
  asserts a trusted renderer, checks types, runs `parseRepo` for `configure` and the version pattern for `forget`.
  Restore's `version` is checked only to be a string; it is kept safe by the stores (GitHub's synced-set lookup, the
  Vault API's `encodeURIComponent`, the manifest's id check). No preload check was added.
- **Storage sizes are counts, not amounts (R45-32).** The task's "no amount, size price or token figure" is read as no
  amount of money, no price for a size, and no token figure. The page shows storage sizes on purpose: `bytes()` on
  version rows, "Using X of Y", the plan's GB and version days from its entitlements, and the 1 GB repository warning.
  None is money. The lead or owner confirms the entitlement figures before `vault` is listed (For the lead in the P7
  record). The model test's existing "names no amount" case was widened to every line function and fixed copy instead
  of adding a near-duplicate case.
- **H1 is unchanged (R45-30).** Brain Vault on Vector still needs `vault` listed with storage, or to be the chosen
  place already; the GitHub backend stays free on every plan. The Backup tab stays on every desktop build, the owner's
  decision.
- **The component test is happy-dom, not browser execution.** `memory-backup.test.tsx` compiles the real page with the
  installed Solid preset, as `dialog-select-plugins.test.tsx` does, and replaces only the platform, the button and the
  switch. Its button ignores `disabled`, so the busy guard itself is tested. Browser and running-app acceptance stay
  B10's.
- Files outside the listed scope: `packages/desktop/src/main/vault-backup.ts`, `vault-runtime.ts`, their tests
  (`vault-backup.test.ts`, the new `vault-runtime.test.ts`) and the new `vault-preload.test.ts`.
  `packages/app/src/context/settings.tsx`, `settings-memory.css` and `general.tsx`: unchanged.
- **Ran locally**, through `vector-serial`, one file at a time with `--timeout 30000`: app (`--isolate`)
  `memory-backup-model.test.ts` (7), `memory-backup.test.tsx` (4), `browser-bundle.test.ts` (4),
  `features/local/local-model.test.ts` (39), `settings-v2/local-model.test.ts` (15), `memory-model.test.ts` (18),
  `settings-registry.test.ts` (21); desktop (`--no-env-file`) `vault-backup.test.ts` (24), `vault-runtime.test.ts` (1),
  `vault-preload.test.ts` (1), `vault-secrets.sign-ins.test.ts` (5); core `test/local-mode/sources.test.ts` (16); engine
  `test/compliance/egress-inventory.test.ts` (5). Red runs and eleven mutations are in the P7 record. `bun typecheck` in
  app, desktop and core; `prettier --check`; `git diff --check`.
- **Only in CI:** Vector Codium (Codium tests, the exerciser, the browser job), typecheck.yml and vector-hosted-ci.yml's
  Hosted tests job. Pending: this step left the change uncommitted.
- No flag, setting, route, listing, price or public page changed, and no SDK or generated output, so `MODEL-PLANS.md`
  and the owner-actions files are unchanged.
- Edits to `api/_lib/model-plan-*.ts`: none.

Part 3 (Codium finish R46a, 15 Nov 2026): the A46 ops Worker review, part 1, its outbound requests and protocol
(`ssrf.ts`, `check.ts`, `release-watch.ts`, `bytes.ts`, `protocol.ts` and the body validators in `ops-account.ts`).
Findings R46-1 to R46-19, repairs, mutations and tests are in `codium-p7-repairs.md` ("A46 ops Worker: outbound
checks"). Read on `codium-finish` `8a43f2b2`; scratch under `/tmp/vector-v2/codium/r46a/`.

- **Rebinding and the platform (R46-8).** The Worker cannot pin the address its DoH lookup checked; its `fetch` looks
  the name up again. Open-source workerd 1.20251118.0's default network allows `"public"` only and filters the
  addresses that lookup returns (`workerd.capnp:786-826`), so inside workerd a rebinding cannot reach a private or local
  address. miniflare 4.20251118.1 allows private addresses (`dist/src/index.js:52616`) and the smoke answers every
  outbound request in-process, so CI exercises no network filtering. Whether Cloudflare's production fetch filters the
  same way is unverified (developers.cloudflare.com is outside this session's network): A46's sentence "Cloudflare's
  own fetch also refuses private and prohibited addresses" is withdrawn from `ssrf.ts`'s header, which now says it is
  unverified, and the question goes to the outside security review (spec 8.2 step 16). Not a blocker: a probe carries
  no credentials and returns no body.
- **Every address must be known (R46-2, R46-3).** A lookup that failed for either kind (A or AAAA), or an answer with
  `TC` (cut short), now leaves the host unknown: inconclusive, never probed. This reverses A46's own reading and test
  ("public addresses of one kind are enough when the other kind's lookup failed"), because without pinning the fetch
  may use the unchecked kind. Cost: a host whose AAAA lookups fail for good is never checked and its outages are never
  reported, and no ops screen names the `resolver` reason (a product reading for the lead). The lookup rule is now
  stricter than `safe-fetch.ts`'s, which can pin; the address ranges stay the same.
- **DoH answers are read as they arrive (R46-1).** At most 64 KiB is read, counted in bytes, then the rest is
  cancelled; a longer answer, or one that is not UTF-8, is a failed lookup. The byte count and UTF-8 parts are hardening
  against a fixed endpoint, not defects on their own. `check.ts`'s 5xx sniff uses the same `readPrefix` with its old
  `size < limit` loop, so its verdicts are unchanged (the critique's exact-8-KiB-then-stall case is pinned).
- **Unknown fields (R46-4).** The plan, config and release bodies, and the nested plan, `onCall`, `releaseGuard` and
  monitor objects, refuse any field they do not list (400 `INTERNAL_BAD_REQUEST`, nothing applied). Reason: the
  repository's convention (`api/_lib/ops-api.ts:120`, `api/_lib/hosted-api.ts:94`,
  `packages/hosted-computer/src/actions.ts:273`). state, erase, suspend and flags stay lenient: refusing them during
  version skew would block the guard's hold (it reads state first, `api/_lib/ops-guard.ts:443-448`, and counts a refused
  state as a failure, not a hold), account deletion and the kill switch, since the API turns any non-2xx into 503
  (`api/_lib/ops-worker.ts:110-113`); safety actions, and the read a safety action depends on, fail toward applying.
  Every field list is checked against `protocol.ts`'s types with `satisfies`, so the two cannot drift without a
  typecheck error. During skew a refused plan leaves the stored plan running to its own `validUntil`, which is
  `min(periodEnd + 24 h, now + 39 d)` for an active or renewing push and `now + 35 d` for a paused one
  (`api/_lib/ops-worker.ts:205-212`), so a refused freeze, refund or end does not stop checks at once. Deploy order, now
  in `owner-actions/hosted-ops.md` step 6: a change that adds a field goes in two merges, the Worker first (merged and
  deployed with the hosted deploy workflow), then the API change that sends it, because the API deploys on every merge
  to main and the Worker only by an approved dispatch. The Worker is not deployed anywhere yet and every caller sends
  exactly the listed fields, so no live skew exists.
- **"protocol.ts validates every field"** was read as `ops-account.ts`'s validators of the protocol's bodies, because
  `protocol.ts` must import nothing (source.test.ts:41-43); `protocol.ts` changed by a comment only.
- **Trailing dot (R46-13).** A host with a trailing dot is verified without it and probed as entered; SSRF-safe, a
  correctness reading only. NAT64 and 6to4 stay refused even with a public embedded IPv4 (R46-14).
- **For R46b:** `index.ts:41-44` reads the whole inbound body before its 32 KiB check (R46-16); the RunState row size
  (R46-17, plausible); source.test.ts's redirect count misses direct `fetch(` calls (R46-18); no `observability` in
  `wrangler.jsonc` (R46-19).
- **Plan and critique.** Taken from the critique: erase, suspend and flags left lenient (the plan refused extras on
  all seven actions, which would have blocked deletion, the hold and the kill switch under skew); the hosted-ops.md
  rule worded as two merges, without the plan's "skew made visible" rationale (the API discards the Worker's code and
  answers 503); every citation re-derived at `8a43f2b2` (source.test.ts, release-watch.ts, index.ts and the smoke's
  ranges were wrong in the plan); the `ssrf.ts` header worded as unverified for production; `account-delete.test.ts`
  and `github-webhook.test.ts` added to the local root runs (nine root files use `ops-fixture.ts`, not five); the
  check.ts swap kept on `size < limit` so that it really is behaviour-neutral, with the exact-8-KiB case added;
  R46-2's reversal, its missed-outage cost and the divergence from `safe-fetch.ts` recorded; field lists tied to the
  types with `satisfies`; the `protocol.ts` sentence limited to the strict request bodies; Bun's pull behaviour
  measured first (`/tmp/vector-v2/codium/r46a/plan/pulls.ts`) so the pull counts are exact; the UTF-8 and byte-count
  parts labelled hardening; one mutation per repaired rule. Not taken: none rejected. The critique's base-input point
  (fetch before the ancestry check; stop and report if #33 merged without main in this branch) applies to the push
  step, which this step does not perform.
- **Ran locally**, through `vector-serial`, one file at a time with `--timeout 30000`: `packages/ops-worker`
  `test/ssrf.test.ts` (12), `check.test.ts` (16), `bytes.test.ts` (6, new), `protocol.test.ts` (4, new),
  `release-watch.test.ts` (14), `source.test.ts` (7), `internal.test.ts` (17), `on-call.test.ts` (16) and
  `schedule.test.ts` (12); root `test/ops-worker-contract.test.ts` (8), `on-call.test.ts` (30, 1 Valkey skip),
  `release-guard.test.ts` (36, 1 skip), `ops-guard.test.ts` (13), `ops-payment-pipeline.test.ts` (10),
  `account-delete.test.ts` (37, 1 skip), `github-webhook.test.ts` (30), `ops-screens.test.ts` (6),
  `ops-domain-health.test.ts` (9) and `ship-desk.test.ts` (26, 1 skip). Red runs on the HEAD sources and fifteen
  mutations are in the P7 record. `bun typecheck` in `packages/ops-worker`; `prettier --check` on the changed code;
  `git diff --check`.
- **Only in CI:** the Hosted services ops Worker job (dry run and miniflare smoke, the real runtime with the smoke's
  exact bodies), Vector Codium's Codium tests job and its HttpApi exerciser (no route changed), every Valkey case,
  typecheck.yml, and
  vector-hosted-ci.yml's Hosted tests job. Pending: this step left the change uncommitted.
- **Review round (15 Nov 2026).** All six non-blocking findings were taken; none was disagreed with. For the state
  body the review offered two options; option 1 was taken (state lenient, like erase, suspend and flags), because the
  guard's hold depends on that read and the state body stores nothing. That also settles the finding that the state
  list was the one not tied to a type with `satisfies`: the list is gone. Option 2's record corrections that still
  apply (the plan's skew bound) were made too. bytes.test.ts pins the exact-limit edge, check.test.ts's timing case
  has 8 s of margin instead of 0.5 s, the three root ops files were run locally, the Scope bullet was reworded, and
  R46-2's follow-up (an ops-screen line or a counter for checks that stay inconclusive with `resolver`) is carried to
  R46b and the lane's follow-ups.
- `MODEL-PLANS.md` is unchanged: no setting changed, and its "every address … public" description still holds. No
  flag, route, listing, price, public page, SDK or generated file changed, and nothing was deployed.
  `owner-actions/hosted-ops.md` gained one instruction for the owner and performs nothing.
- Edits to `api/_lib/model-plan-*.ts`: none.

Part 4 (Codium finish R46b, 15 Nov 2026): the A46 ops Worker review, part 2, its accounts, schedules and internal API
(`index.ts`, `internal.ts`, `limits.ts`, `runtime.ts`, the rest of `ops-account.ts`, `wrangler.jsonc`,
`e2e/ops-smoke.mjs` and `test/ops-worker-contract.test.ts`, with `025d75da`). Findings R46-16 to R46-33, repairs,
mutations and tests are in `codium-p7-repairs.md` ("A46 ops Worker: accounts, schedules and internal API"). Read on
`codium-finish` `d866364f`; scratch under `/tmp/vector-v2/codium/r46b/`.

- **Inbound bodies (R46-16).** A body with no length is read only to 32 KiB and one byte, then cancelled, before the
  signature is checked; a body of exactly 32 KiB is still taken. Before, any caller of the `workers.dev` address could
  make the Worker read a body of any size first.
- **The kill flag's order (R46-22).** `flags` calls apply in the order the API signed them, in both directions: a call
  signed before the newest one applied is ignored and answers `{kill: <the newest applied>, applied: false}`; calls in
  the same second apply in arrival order. The order is claimed before the KV write. Reason for both directions (the
  critique's preferred rule, taken over the plan's clears-only rule): the API gives up after 10 s and reports `failed`
  while the call can still arrive up to 300 s later, and `syncOpsKillFlag` runs only when the owner changes the switch
  (`api/_lib/codium-owner-api.ts:154`), so a stale raise after a newer clear would leave every account off while the
  switch shows on, with nothing to show or fix it. The cost of ordering raises too: two changes signed in different
  seconds by API instances whose clocks differ by more than that gap could apply in the wrong order, and a re-applied
  switch after a call from a clock that runs ahead is ignored until real time passes that stamp (at most 300 s; the API
  answers `failed` again when it asked for the other value). Two more limits of the claimed order: a KV write that
  throws answers 500 and leaves the order claimed, so a call signed earlier and delivered later is ignored and answers
  the claimed value, which KV may not hold; and overlapping KV writes are not ordered at KV. The owner's instruction
  after any `failed` (apply the switch again, which normally applies, or read and set the key directly;
  `owner-actions/hosted-ops.md`) covers all three. Undoing the claim when the write throws was not taken: putting back
  the value read before the write would also drop a newer claim made while the write ran, and would not order
  overlapping writes. The API reads only `answer.kill`, so it needs no change. A key set or deleted directly with
  wrangler is outside the order.
- **Environments without case (R46-23).** The Worker folds a release's environment to lower case, as GitHub and the API
  (`environmentKey`) compare it, so one environment has one watch, one dedupe key and one baseline. Its length and
  control-character check runs on the name as sent, as the API's `environmentName` checks it, because folding can
  lengthen a name ("İ" becomes two UTF-16 units): checked after folding, a 255-unit name the API accepts was refused
  with 400 and its release went unwatched. The stored name is at most 510 units. The Worker's rows,
  state and reports name it in lower case. Two spellings now show in the app: text built from the Worker's events (the
  incident record and its text, `ops-incidents.ts:541`, `:856`, and the revert pull request's body,
  `release-guard.ts:884` from `ops-incidents.ts:655`) is lower case, while the release list from the API's own record
  (`api/ops/releases.ts:20`) keeps GitHub's spelling. In-app and pull-request text, not public copy. The Worker is not
  deployed, so no stored rows have mixed case.
- **An erasure overtakes a wake or a release (R46-20, P5).** An in-memory counter, raised as the first statement of
  `erase()`, is compared by the alarm after the flag and after the probes and by `release()` after its flag read; a
  change ends the wake with nothing written or scheduled, and refuses the release with 409 `OPS_ERASED`, so the erased
  object keeps only `erased_at`. The release half and the counter (instead of comparing `erased_at` values) came from
  the critique. Not claimed: an erasure that lands while `internal()` awaits its alarm calls, which in the fake could
  leave an alarm that writes an empty run row (nothing of the account) before removing itself; under workerd's input
  gates other events wait while a storage operation runs. Deferred verification.
- **Reports are dropped after a day while the flag is set (R46-21).** Before, an account with one undelivered report
  woke every 10 minutes for as long as the flag was set (288 wakes in two days in the red run).
- **"At once" for the kill flag** means at the next wake after the KV write is visible; KV propagation time and the
  order of two KV writes from one object are deferred verification. The flag's only writers are in `flags()`, pinned by
  a source test.
- **Observability off (R46-19).** `wrangler.jsonc` sets `"observability": { "enabled": false }`. Turning Workers Logs
  or traces on is the owner's choice, made in that file, because each deploy applies it over a dashboard toggle
  (`owner-actions/hosted-ops.md`). wrangler 4.50.0's schema defines the key; the CI dry run only parses the file, so
  the evidence is the schema and the source test.
- **Entry exports (R46-32).** `handleRequest` stays exported next to `default` and `OpsAccount`, although `025d75da`'s
  message says only the two remain: workerd accepted the function export in every smoke since, and the root fixture
  imports it. A source test now pins the exports, so a non-function export fails locally.
- **The run row (R46-17).** Bounded near 1.06 MB by the API's 20 repositories and one production environment each, not
  by the Worker's own caps; Cloudflare's 2 MB row limit is unverified here. A lane follow-up if the repository cap grows.
- **Plan and critique.** Taken from the critique: the erasure check in `release()` with its own regression test and
  mutation; both-way ordering of `flags` (above), with the test step "a raise signed before the newest clear is
  refused" and M8 changed to the one-sided rule; the in-memory counter; the observability evidence worded as the schema
  and the source test, with the dashboard-reset note for the owner; comments stripped before the redirect scan, and
  runtime.ts's forwarder pinned instead of skipped silently; the kill-writer test renamed and checking the `flags()`
  body; the R46a record's ops-fixture sentence corrected by a dated line; both display spellings recorded; the CI
  follow-through named (a `docs(codium)` receipt commit after green runs); the relay and ops-cleanup items labelled as
  lane follow-ups outside R46b's scope. Also corrected from the plan: the URL bound is `ops-settings.ts:38`
  (`release-guard.ts:279` is the rollback link's bound), and `workflow-compliance.test.ts:1315` keeps the smoke out of
  the lane's other jobs rather than pinning the steps. The flag-race test runs with the flag set and clear, because with
  it clear the check after the probes masks M4. Not taken: none rejected.
- **Ran locally**, through `vector-serial`, one file at a time with `--timeout 30000`: `packages/ops-worker`
  `test/internal.test.ts` (23), `schedule.test.ts` (13), `release-watch.test.ts` (16), `source.test.ts` (9),
  `on-call.test.ts` (16), `protocol.test.ts` (4), `ssrf.test.ts` (12), `check.test.ts` (16) and `bytes.test.ts` (6);
  root `test/ops-worker-contract.test.ts` (8), `on-call.test.ts` (30, 1 Valkey skip), `ship-desk.test.ts` (26, 1 skip),
  `release-guard.test.ts` (36, 1 skip), `ops-guard.test.ts` (13), `ops-payment-pipeline.test.ts` (10),
  `account-delete.test.ts` (37, 1 skip), `github-webhook.test.ts` (30), `ops-screens.test.ts` (6) and
  `ops-domain-health.test.ts` (9). Red runs on the HEAD sources and eighteen mutations are in the P7 record. `bun
  typecheck` in `packages/ops-worker` and the api tree; `prettier --check` on the changed code; `git diff --check`.
- **Only in CI:** Vector Codium (Codium tests with Valkey and Postgres, the HttpApi exerciser, check:generated, the
  Hosted services ops Worker dry run and miniflare smoke on workerd's own request bodies), typecheck.yml and
  vector-hosted-ci.yml's Hosted tests and Ops Worker jobs. Pending: this step left the change uncommitted. R46a's
  receipts (Vector Codium 43720600992 with Codium tests job 132831553538 green under the four-MISS rule and Ops Worker
  job 132831553772; typecheck.yml 43720604063; vector-hosted-ci.yml 43721009223 with Hosted tests job 132832781366)
  are recorded in the P7 record.
- **For the lead.** No defect in another lane's file. Lane follow-ups outside this package's scope: R46-2's
  `resolver` screen line (carried from R46a); the relay's whole-body read (`packages/relay/src/index.ts:81-84`),
  unordered flags (`account-relay.ts:809-815`) and missing observability setting; `api/_lib/ops-cleanup.ts:94` skipping
  the Worker's erase silently when the address or secret was removed; `github-webhook-handlers/ops.ts:276` forwarding
  GitHub's spelling (display only after R46-23); and P5 on the API side of R46-20, `api/_lib/ops-incidents.ts:328-357`:
  a report already in flight when `eraseAccountOps` erases the Worker (`ops-cleanup.ts:94`) can reach
  `POST /api/ops/worker` after `eraseAccountOpsRecords` ran, and `handleOpsReport` does not check the tombstone, so
  `handleEvent` and `markTaken` (`:314`) can write an incident and the events set for an account being deleted (the
  `check` pass of `finishAccountDeletion`, `codium-erase.ts:566`, probably removes them only if it runs after the late
  report). Proposed: drop the events of a report whose account has a tombstone (`accountDeleting(report.account)`)
  before any write and answer 2xx, with a root test in `test/account-delete.test.ts`. Not fixed here (A48/A57 code).
- **Review round (15 Nov 2026).** All six non-blocking findings were taken (two were the same `parseRelease` case);
  none was disagreed with. The redirect source test now ends each call at its own closing parenthesis and requires an
  options argument with `redirect: "manual"`, since cutting at the next `})` let a bare `deps.fetch(url)` pass (M16).
  `parseRelease` checks the environment as sent and returns it folded (above; M17, M18). For `flags()` the review
  offered undoing the claim on a failed KV write or recording the limits; the limits were recorded (above, the
  `flags()` comment and `hosted-ops.md`), for the reason given above. `hosted-ops.md`'s "so it applies" now says
  "normally applies" and names the clock limit. The API-side P5 item is a lane follow-up (above).
- No setting, flag, route, listing, price, public page, SDK or generated file changed, and nothing was deployed.
  `MODEL-PLANS.md`'s ops Worker bullet names the case-folded dedupe, the ordered flag, the erasure rule and the
  observability setting; `owner-actions/hosted-ops.md` gained two instructions for the owner and performs nothing.
- Edits to `api/_lib/model-plan-*.ts`: none.

With R45a, R45b, R46a and R46b, P7 now covers A44–A50: A44 and A47–A50 in "P7 review decisions" (5 Nov 2026), A45 and
A46 in this addendum and in `codium-p7-repairs.md`.

## Codium finish: B10 acceptance (15 Nov 2026)

Track B B10 ("Add `skills` and `insights` sections to the vault manifest (restored as drafts for review); main-built
readers refuse with "update Vector" via `minReader`", `codium-build-spec.md:949`). The checkpoint's B10 row asks to
"validate all lanes together and execute native/browser acceptance" (`codium-track-b-checkpoint.md:17`). R45a and R45b
are its base (`codium-track-b-checkpoint.md:31-34`; this addendum's R45-10 line says "splitting or capping learned
files is B10's design"). Read and built on `codium-finish` `4bd146e7`, PR #33 unmerged. Scratch was under
`/tmp/vector-v2/codium/b10/`, and the tests' `TMPDIR` and fresh roots under `/tmp/vector-v2/codium-finish/b10/`.
Reviewed uncommitted at `4bd146e7`; that review's findings and what was done with each are under "Review fixes"
below.

**Contract readings**

- **A version-1 reader refuses the whole version (R1).** `minReader` gates the whole version in the header its tag binds
  (core `vault/format.ts:48`), and B10 chose it so "older readers must not silently omit those sections"
  (`schema/vault.ts:16`). A main-built reader therefore refuses a learned backup outright, memory included, with core's
  "This backup was made by a newer version of Vector. Update Vector to restore it." It still restores a memory-only
  version, which asks for reader 1. The Backup page's partial note ("Parts of this backup need a newer Vector; update
  Vector to restore them too.") is a different path: a reader-2 build skipping a section it does not know, which
  `minReader` allows (`totals.newer`), or a file the engine refuses (`totals.unreadable`). Both paths are tested. The
  task's "refuses the newer sections … and still restores memory" is read as these two facts.
- **The version-1 reader is this build with two constants put back (R2).** These are the reader-side constants that
  `3b1ce6d5` changed: `READER` 1 and `SECTIONS` `["memory"]`. They are mocked in a test file of their own, before
  anything that reads them loads. Every desktop test file runs in a process of its own (`scripts/test.ts` and the
  Codium CI picker), so no other file sees the mock. The writer's `MIN_READER` and `LEARNED_READER` are unchanged, so
  the bytes are a current build's. With `SECTIONS` `["memory"]`, the desktop's restore loop is the pre-B10 loop. A
  historical binary was not run.
- **A fresh profile (R3).** The desktop test runs two computers. Each has its own engine process, with its own HOME and
  XDG folders, on the same repository directory. Computer B has its own `userData` (its store file is removed and a new
  folder is used) and a new sealing key, so the restore needs the recovery code, as on another computer. The route
  test, which runs in one process with one brain, uses a second, empty git repository instead.
- **"No learner stats are seeded" (R4)** means all of these hold on the restoring side:
  - `GET /memory/workflow` has no arm in any tier.
  - Each restored skill has uses `{loads, passes, fails, ignored, reverts}` all 0, `helpful` 0, `harmful` 0 and no
    `approvedBy`.
  - Workflow history arrives only as a lesson proposal ("Imported workflow observation for thorough work …").
- **Browser (R5).** The vault bridge is desktop-only (`memory.tsx` shows the Backup tab only when `platform.vault` is
  set), so the e2e mock-server app cannot reach the page. `e2e/fixtures/vault-sections.html`/`.jsx` renders the real
  `SettingsMemoryBackup` and its real `restoreLine` against a stand-in bridge. The stand-in answers exactly what the
  desktop's real controller answered in `vault-sections.test.ts`:
  - the learned version: `restored 4, active 1, skills 2, insights 1`, all else 0;
  - the version with an unknown section: `known 1, newer true`, all else 0.
  The "update Vector" refusal is core's text. This is not the running app. The fixtures build only into `dist-e2e`
  (`e2e/vite.config.ts`), never into the app or website.
- **Spec typecheck (R6).** The app's `bun typecheck` (`tsgo -b`) does not cover `e2e/`. `typecheck:e2e`
  (`tsgo -p e2e/tsconfig.json`) does, for the files its `include` names, so the spec was added there (one line). That
  typecheck ran locally only: no job of this lane runs it.
- **CLI roundtrip (R7).** `vector vault backup/restore --github` has no knob for a local remote or API, so a run at
  process level would reach github.com. The CLI case drives the CLI's own git runner (`gitRunner(Git.run)`) and
  `VaultGitHub.store` over a local bare repository with sectioned files, and the CLI's restore tally and line as
  exported functions. `VaultRestoreCommand`'s handler and `VaultMemory.files` are not run inside the CLI's process. The
  brain side of the CLI restore is `VaultMemory.restore`, the function the route calls, and the route test covers it.
- **Insights on the backup side (R8).** No route records workflow runs. `memory-vault.test.ts` runs with the preload's
  in-memory brain and `resetDatabase` after each case. A `BrainWorkflow` runtime there would need a file database that
  `resetDatabase` unlinks under the listener, so the route test does not record runs. Instead it restores an insights
  file shaped like `BrainTransfer.insights` output. The backup side (`GET /memory/backup` carrying an `insights`
  section from recorded runs) is covered by the desktop test. There, the engine fixture records eight checked runs
  through `BrainWorkflow` over the same brain file its server reads.

**Findings (each fixed here with its own regression test)**

- **B10-1. Confirmed: `vector vault restore` called learned skills and insights "waiting for your review as before".**
  - Cause: `VaultMemory.restore` answers a learned file as `waiting = restored` (`vault-memory.ts`, learned branch).
    The CLI added that to `total.waiting` and printed "N waiting for your review as before". R45-25 fixed the same
    thing on the desktop only.
  - Repair (`cli/cmd/vault.ts:430-449`, `:474-533`): the tally is `restoreTotals` and the line is `restoredLine`, both
    exported. The tally counts learned sections in `skills` and `insights`, never in active, pinned or waiting.
    The line is the Backup page's rule: "as before" is memory's, a learned-only restore names no memory, and then
    come "N learned skill(s) to review" and "N workflow insight(s) to review". "Left out:", the skipped note and the
    documents note are unchanged.
  - Tests: `test/cli/vault.test.ts:205` (the tally, with each learned file answered as waiting) and `:236` (the line).
    The red run is HEAD, where neither export exists. Mutation: dropping the learned `continue` in `restoreTotals`
    fails `:205`.
- **B10-2 (R45-10). Confirmed by measurement: a skills backup could pass the engine's restore limit.**
  - Cause: the backup listed every skill row with its evidence (`BrainExport.collect`, `skills.list(place, "all")`).
    The desktop sends a learned file whole, and the route refuses more than `IMPORT_CHARS` (2,097,152 characters).
  - Worst case built through the routes (`memory-vault.test.ts:269`):
    - 50 skills in use (`SkillStore.KEEP.skills`), one archived, and 20 waiting (`BrainSkill.LIMIT.pending`);
    - each with a 200-character description and a 4,000-character procedure, about 3,900 characters of it `"\` pairs
      that JSON escapes;
    - each with 20 paths (`LIMIT.paths`) of about 1,200 characters. `safePath` does not limit a path's length, so no
      count of skills alone bounds the file.
  - Measured: at HEAD, one file of 2,329,515 characters, which never restores. After the repair, two files of 1,474,680
    and 819,282 characters, 2,293,962 together. Leaving out the non-restorable rows alone (the plan's repair) would
    still be past the limit, so the file is split as well.
  - Repair (`vault-memory.ts:72-123`): `restorable` keeps only skills in use or waiting, the ones a restore reads
    (`BrainExport.skills`), without their evidence, which a restore never reads. It puts the skills in use before the
    ones waiting, each in the brain's own order (why: B10-3), and cuts them into parts of at most `SKILLS_CHARS`
    (1,500,000) characters of JSON. The parts are `skills/repository-<24 hex>.json`, then `-2.json` and
    so on.
  - What is unchanged: `vector memory export`, `BrainExport`, the route schemas, the SDK and openapi, so no generator
    ran.
  - Edge case: a single skill larger than `SKILLS_CHARS` still goes in a file of its own. Only an import of almost 2 MB
    could make one, and its restore would count it unreadable.
  - Red run: the case fails at HEAD's `vault-memory.ts` on "more than one file" (one file is received).
- **B10-3. Confirmed, not changed: a restore brings back at most 20 skills per repository.**
  - Cause: `importText` proposes every restored skill (`core/src/brain/export.ts:299`), and `BrainSkill.propose`
    refuses once 20 proposed or held skills wait in the repository (`skill.ts:928-935`, `LIMIT.pending` 20).
  - Effect: a backup with 50 skills in use restores 20 proposals. The other 50 of the worst case count as "refused
    (forgotten here, or past what may wait for review)". Pinned by `memory-vault.test.ts:269`: 20 restored, 50 refused.
  - Which 20 come back. The brain lists skills newest first (`BrainSkill.list`, `skill.ts:761`), so a backup in that
    order puts the person's unapproved drafts first, and the restore's 20 would be mostly those. The backup therefore
    holds the skills in use before the skills waiting (`restorable`, B10-2), so a restore that stops at the limit
    keeps the approved ones. `:269` asserts the backup's order (50 in use, then 20 waiting) and that every one of the
    20 restored was in use. With the brain's order put back, `:269` fails.
  - The spec's "restored as drafts for review" names no number. Whether a restore should take more drafts is a product
    decision (For the lead).
  - 21 Nov 2026 (branch `engine-core-fixes`): the backup line no longer calls learned files memory. The CLI
    (`cli/cmd/vault.ts`), the desktop (`vault-backup.ts`) and Settings → Memory → Backup's last line
    (`memory-backup-model.ts`) say "Backed up N file(s)" / "N file(s)"; `last.files` stays the total. New cases: desktop
    `vault-backup.test.ts` backs up one memory, one skills and one insights file and expects "Backed up 3 files to …"
    (red on the old copy), and app `memory-backup-model.test.ts` checks a three-file last line names no memory file
    (red on the old copy); the e2e fixture's message follows. The cap is unchanged: a restore still brings back at most
    `LIMIT.pending` 20 skills per repository. Proposed for the lead to record as accepted; not decided here.
- **B10-4. Confirmed: "Show versions" on a new computer could fail in git.**
  - Cause: the desktop's `versions()` reads `store.list()` and `store.readKey()` at once (`vault-backup.ts:467`). Core's
    GitHub store did not share an overlapping read (`vault/github.ts`, `sync`), so a new computer's empty copy was set
    up and fetched twice in one directory.
  - Seen in the native test: `Vector could not set up its copy of the vault: fatal: cannot copy
    '…/templates/hooks/pre-commit.sample' to '…/vault-cache/github/octo/brain-vault.git/hooks/pr…'`.
  - Repair (`core/src/vault/github.ts:131-143`): reads that overlap share one in-flight read (`fetchTree`), and it
    clears when it settles.
  - Test: `core/test/vault/github.test.ts:212`. With a git that does not block, it requires one `init`, one
    `ls-remote` and one `fetch` for both reads. At HEAD each ran twice (red); after the repair it passes. The desktop
    test passes through the same path.

**Tests**

- New `packages/desktop/src/main/vault-sections.test.ts`, one case, 52 expectations, about 7 s. It runs the real
  `startVault`, `vaultKeys` and `vaultSecrets`, and the real `vault-github.ts` with its git. Only `githubVaultStore`'s
  test options are set: a local bare remote, `https://api.github.test`, and a privacy check that answers 404. Electron
  and the billing window are mocked as in `vault-runtime.test.ts`, and the default scrypt cost is 2^17. The case:
  1. A memory-only backup asks for reader 1, with sections `["memory"]`.
  2. After two approved skills (one private) and eight checked runs, the backup asks for reader 2, with sections
     memory, skills and insights. The skills file keeps `private` on exactly the private skill.
  3. Computer B: Show versions answers `mine: false`; restoring without the code answers `needsCode`; with the code it
     restores with the totals above.
  4. On B's engine: the same project id, no skill in use, both skills `proposed` with privacy kept, R4's empty stats, the
     lesson proposal, and the personal memory.
  5. A version with a `journal` section restores the memory beside it, with `newer: true`.
  6. Every privacy check went to the test API.
- New `packages/desktop/src/main/vault-sections-reader-one.test.ts`, one case, 8 expectations (R2). A learned backup
  answers exactly the "Update Vector" text and nothing reaches the engine. A memory-only backup restores.
- New `packages/engine/test/fixture/vault-profile.ts`, used by the desktop test. It is `Server.listen` on loopback, and
  a `workflow <directory>` line on stdin records eight checked, priced build-agent runs through `BrainWorkflow`. When
  stdin closes (the test stops it, or the test process dies) it stops its listener and exits.
- The engine child's setup:
  - spawned like `vector-account.integration.test.ts`: `run --conditions=browser`, cwd the profile home, a
    `VECTOR_CREDENTIAL_KEY` with `VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE=1`, and models fetch, plugins, channel
    database, project config and embeddings off;
  - its environment inherits only `PATH`, Windows' system variables (`SystemRoot`, `SystemDrive`, `windir`, `ComSpec`,
    `PATHEXT`), the temp folders and `LANG`, so no credential, proxy or `VECTOR_*` setting of the computer reaches it;
    `HTTP(S)_PROXY` points at `127.0.0.1:9` with `NO_PROXY` set to loopback;
  - each engine is kept as it starts (`Promise.allSettled`), so `afterAll` stops one that started when the other failed;
  - git is isolated with `/dev/null`, as `vault-github.test.ts` does;
  - `ConfigManaged`'s managed-config directory is not redirected. The engine reads the computer's real one, as the
    precedent does.
- `packages/engine/test/server/memory-vault.test.ts`: 6 cases before, 8 after. The new cases are `:269` (B10-2 and
  B10-3) and `:353` (a skills file from repository A restored into an empty repository B with an insights file:
  answers `restored 2, active 0, waiting 2`; R4 on B).
- `packages/engine/test/cli/vault.test.ts`: 2 cases before, 5 after. The new cases are `:103` (learned sections keep
  their section, repository and worktree through git and ask for reader 2; memory alone asks for reader 1; memory with
  only skills, and memory with only insights, each ask for reader 2), `:205` and `:236`.
- `packages/core/test/vault/github.test.ts`: 8 cases before, 9 after (`:212`).
- New `packages/app/e2e/regression/codium-vault-sections.spec.ts`, four cases:
  - the learned restore's exact line: "… 1 in use, 0 waiting for your review as before, 2 learned skills to review, 1
    workflow insight to review.";
  - another computer: Restore is disabled until the recovery code is entered, and the code reaches the bridge;
  - the "Parts of this backup need a newer Vector; update Vector to restore them too." note;
  - the "Update Vector" refusal as the alert, with no notice.
  Its path names codium, so the picker always selects it.
- Mutations, each reverted and checked with `git diff --stat`:
  - the desktop loop counting learned files as waiting fails the desktop test;
  - the CLI tally doing the same fails `cli/vault.test.ts:205`;
  - `VaultMemory.restore` answering learned files as active fails both learned route cases;
  - core's writer always writing `MIN_READER` fails the reader-one test;
  - `importText` dropping `private` fails both learned route cases.
- A test-writing hazard found on the way. In Bun 1.3.14, `toMatchObject` replaces each property it matched with an
  asymmetric matcher in the received object (probe: `{code: "ABCD"}` reads back as `{code: {}}`). The desktop test
  reads the recovery code before any matcher. No other desktop test reads a property after matching it with
  `expect.any` (grep).

**Ran locally**, through `vector-serial`, one file at a time with `--timeout 30000`:
- desktop (with `--no-env-file`): `vault-sections.test.ts` 1/0, `vault-sections-reader-one.test.ts` 1/0,
  `vault-backup.test.ts` 24/0, `vault-runtime.test.ts` 1/0 and `vault-github.test.ts` 11/0;
- engine: `test/server/memory-vault.test.ts` 8/0 and `test/cli/vault.test.ts` 5/0;
- core: `test/vault/github.test.ts` 9/0 and `test/vault/vault.test.ts` 18/0;
- `bun typecheck` in app, desktop, engine and core, and `bun run typecheck:e2e` in app, all clean;
- prettier on the new files, and on the blocks added to the existing ones (those files were not prettier-clean at
  HEAD, R45-23, and their other lines are left as they were);
- `git diff --check`.
- Checked again the same day, before the commit. The JSON helpers in the new route and desktop cases had read
  responses `as any`. They now read `Record<string, unknown>`, and each caller names the shape it reads (AGENTS.md).
  Everything below ran again and passed:
  - desktop: `vault-sections.test.ts` 1/0, `vault-sections-reader-one.test.ts` 1/0, `vault-backup.test.ts` 24/0,
    `vault-runtime.test.ts` 1/0 and `vault-github.test.ts` 11/0;
  - engine: `memory-vault.test.ts` 8/0 and `cli/vault.test.ts` 5/0;
  - core: `vault/github.test.ts` 9/0, `vault/vault.test.ts` 18/0 and `local-mode/sources.test.ts` 16/0;
  - typechecks:
    - `bun typecheck` in app, desktop, engine and core, and app `typecheck:e2e`;
    - the full `bun turbo typecheck --concurrency=2`, 27/27, with desktop, core and engine run uncached after the
      edit;
    - the api tree, `bun typecheck --project ../../tsconfig.json` from `packages/engine`.
- Checked again after the review fixes, the same day:
  - desktop: `vault-sections.test.ts` 1/0 (52 expectations), and no engine fixture process left after it;
    `vault-sections-reader-one.test.ts` 1/0;
  - engine: `memory-vault.test.ts` 8/0 and `cli/vault.test.ts` 5/0; the mutation putting the brain's order back in
    `restorable` fails `memory-vault.test.ts:269`;
  - core: `vault/github.test.ts` 9/0;
  - the fixture's exit on a closed stdin, as above;
  - typechecks: `bun typecheck` in core, engine and desktop, and the api tree (`bun typecheck --project
    ../../tsconfig.json` from `packages/engine`), all clean. The app was not touched by the fixes. The desktop's
    `tsgo -b` leaves out `src/**/*.test.ts`, so both new desktop test files were also checked with a scratch config
    under `/tmp/vector-v2/codium-finish/b10/` (the desktop's own options, with bun and node types): `vault-sections.test.ts`
    is clean; `vault-sections-reader-one.test.ts` has two type-only mismatches that Bun does not check and that no CI
    job typechecks (`:36` compares the mocked `SECTIONS` with `["memory"]`, whose declared type is the three-section
    tuple; `:62` answers the codium status with `{}`). Left as they are;
  - prettier on the two new files the fixes touched, clean.
Never run locally: Playwright.

**Only in CI:** the browser spec (Codium browser specs job); the Codium tests job over the changed files; typecheck.yml;
vector-hosted-ci.yml's Hosted tests (desktop `vault-*`, which includes both new desktop files, and core `test/vault/`);
and the first Windows and macOS runs of the desktop test that spawns the engine, which is test.yml's at the lead's
end-of-lane run.

**Plan and critique.** Taken from the critique:
- the worst case measured and B10-2 split, not only filtered;
- the restore-side cap of 20 recorded as B10-3;
- the CLI tally extracted and tested with a learned file answered as waiting, with the loop mutation;
- no `BrainWorkflow` runtime or database flag in `memory-vault.test.ts` (R8);
- the engine child spawned as the proven precedent;
- `vault-runtime.ts` left unchanged, with `startVault` driven through a mocked `vault-github` that keeps the real store
  and git;
- one engine process per computer, seeded over stdin instead of restarted;
- the unknown-section case folded into the one test;
- the CLI case kept short;
- a fourth browser case for the other computer;
- the exact totals named as the native test's;
- the one-line `e2e/tsconfig.json` edit.
Not taken as written:
- `os.devNull` for git's global config. The desktop's vault tests use `/dev/null` and run on Windows in test.yml.
- `--preload @opentui/solid/preload`. The precedent and the fixture start without it.
- Redirecting the managed-config directory. The precedent does not, and recorded above as not isolated.
- `NetworkGuard` in the fixture. Raw sockets are not a path these routes use, and the dead proxy covers fetch.
Found while building: B10-4, and the Bun matcher hazard.

**Review fixes (15 Nov 2026).** A review of this package before its commit raised ten non-blocking findings; none was
blocking.
- `restorable` kept the brain's newest-first order, so a restore stopping at 20 kept mostly unapproved drafts. Fixed:
  skills in use come first (B10-2, B10-3), and `memory-vault.test.ts:269` asserts the order and that the 20 restored
  were in use. Red with the old order.
- `restorable` was exported with no caller outside `files`. Fixed: no longer exported; the tests import only
  `SKILLS_CHARS`.
- Core's new store-level `read` was shadowed by `push`'s `read` (`read-tree`). Fixed: renamed `fetchTree`.
- A backup with skills only, or insights only, beside memory was never shown to ask for reader 2. Fixed: the CLI
  roundtrip (`cli/vault.test.ts:103`) now backs up each and expects `LEARNED_READER` with exactly those sections.
- The desktop test's `afterAll` used `else`. Fixed: an early `continue`.
- If one engine failed to start, `Promise.all` left the other unassigned and running. Fixed: `Promise.allSettled`,
  each engine kept as it starts, then the first rejection rethrown.
- The engine fixture outlived a closed stdin because the listener kept it running. Fixed: after the stdin loop it
  stops the listener, disposes its runtime and exits. Checked by starting it with stdin at `/dev/null`: it printed its
  address and exited 0 within 4 s.
- The engine child inherited the computer's credentials (anything not `VECTOR_*` or `*_proxy`). Fixed: an allowlist
  (`PATH`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `PATHEXT`, `TEMP`, `TMP`, `TMPDIR`, `LANG`), matched
  without regard to case for Windows, plus the values the test sets.
- This record said it was left uncommitted, which the commit would make false. Fixed: it names the state at review.
- The CLI cases never run `VaultRestoreCommand`'s handler, so its section dispatch (`cli/cmd/vault.ts:431-441`, an
  unknown section answered unreadable) has no test. Not changed, kept as R7. A handler case needs a seam in `storeFor`
  for a local remote and API, plus the owner gate and the local key file, which is a product change for a coverage
  note. The same dispatch on the desktop (a `journal` section restoring the memory beside it with `newer`) is covered
  by `vault-sections.test.ts`, and the brain side (`VaultMemory.restore`) by the route test.

**For the lead.**
- A backup now carries only the skills in use or waiting, without evidence, which the owner's A60 read of the privacy
  draft's `#vault` should know.
- B10-3: a restore takes at most 20 skill proposals per repository. The backup puts skills in use first, so the 20
  kept are ones the person had approved.
- `Backed up N memory files` in the CLI and on the desktop counts learned files as memory files (R45-35 kept the
  desktop wording).
- Held skills (hidden characters, instruction-like text) never enter a backup.
- The desktop test spawns engine processes; its first Windows and macOS run is the lead's test.yml. Nothing in it is
  skipped by platform.
- R45-23's B10 lines at `vault-memory.ts:72-73` and `cli/cmd/vault.ts:433` were rewritten here, prettier-clean.

No flag, setting, listing, route, schema, price or public page changed, and no SDK or generated output, so
`MODEL-PLANS.md` and the owner-actions files are unchanged. Edits to `api/_lib/model-plan-*.ts`: none.

**R45b's and B10's CI receipts (recorded by Codium finish DZ, 15 Nov 2026)**

- R45b, `4bd146e7`:
  - Vector Codium run 43705851187 had 18 jobs. 15 succeeded and 2 were skipped by `services_only`.
  - Codium tests job 132786637759 failed only at the exerciser step: "Codium: 136/136 test files passed", then
    exactly the four review-memory MISS lines and `summary pass=359 fail=0 skip=0 missing=4 extra=0`. "Run the Codium
    test files" and "Check generated client" succeeded.
  - Codium browser specs job 132786637589 passed.
  - typecheck.yml run 43705853689 and vector-hosted-ci.yml run 43706515849: success (run conclusions).
- B10, `8a43f2b2`:
  - Vector Codium run 43715519898 had 18 jobs, with the same 15 succeeded, 2 skipped and 1 failed.
  - Codium tests job 132816093909 failed only at the exerciser step: "Codium: 140/140 test files passed", then
    exactly the four review-memory MISS lines and `summary pass=359 fail=0 skip=0 missing=4 extra=0`. "Run the Codium
    test files" and "Check generated client" succeeded.
  - Codium browser specs job 132816094736 (679 lines, wholly visible) ran `codium-image-routing.spec.ts`,
    `codium-usage-labels.spec.ts` and `codium-vault-sections.spec.ts`. Its log shows "Running 9 tests using 1
    worker" and "9 passed (35.6s)". The cases include `codium-vault-sections.spec.ts:28:1`, `:41:1`, `:58:1` and
    `:66:1`.
  - typecheck.yml run 43715522956: success.
  - vector-hosted-ci.yml run 43715921854: Hosted tests job 132817317859 ends "Hosted: 147/147 test files passed".
- The same four browser cases passed again in B09b's browser job 132886071679. The checkpoint's B10 row and its dated
  B10 bullets now cite these runs. "Validate all lanes together" stays with the lead's end-of-lane test.yml run.

## Codium finish: B09 combined Remote authorization (15 Nov 2026)

Track B B09 ("Phone Tasks view of helper and background-job states, "Stop including helpers", waiting and interrupted
notes as push alerts", `codium-build-spec.md:947`), first half: the checkpoint's "combined remote authorization
regression" (`codium-track-b-checkpoint.md:16`, v2-master-prompt 8.4). Read and built on `codium-finish` `dfef44e3`
(equal to origin/codium-finish; PR #33 unmerged: `0ee486e3` is not an ancestor of origin/main), on `df3951ba`'s phone
helper states and Stop route. `packages/sdk/openapi.json` was only read (blob `d99dc532`); no generator ran. Scratch
was under `/tmp/vector-v2/codium/b09a/` (the review round's under `/tmp/vector-v2/codium/b09a-fix/`). Not committed or
pushed: the package was left in the working tree, so no CI has run it. CI: pending dispatch. A review round the same
day changed the code and this record before any commit ("Review round" below); line numbers here are the files' as they
now stand.

**Route inventory (openapi.json at `d99dc532`: 278 paths, 330 operations)**

- The 20 allowlisted routes are all real operations with the same method, path template, path parameters and query
  fields: `GET /project`, `GET /session`, `GET /session/status`, `GET /experimental/capabilities`,
  `GET /experimental/session/:sessionID/tasks`, `POST /experimental/session/:sessionID/stop`, `GET /session/:sessionID`,
  `GET /session/:sessionID/children`, `GET /session/:sessionID/todo`, `GET /session/:sessionID/diff`,
  `GET /session/:sessionID/message`, `GET /session/:sessionID/message/:messageID`, `POST /session`,
  `POST /session/:sessionID/prompt_async`, `POST /session/:sessionID/abort`, `GET /permission`,
  `POST /permission/:requestID/reply`, `GET /question`, `POST /question/:requestID/reply`,
  `POST /question/:requestID/reject`. No route is missing.
- The other 310 operations are refused before the engine (GET and POST with `REMOTE_ROUTE_REFUSED`, other methods with
  `REMOTE_REQUEST_INVALID`), and none collides with an allowlisted pattern when its parameters are filled. No route is
  newly exposed. Families present and all refused (operations counted by path pattern): computer (Hands) 2, connect 8,
  workspaces 7, memory 53 (`GET /memory/backup` and `POST /memory/restore` among them), review-memory 4, Playbooks 2,
  hosted jobs 2, brain 2, config 9, file and find 10, pty 15, session shell and command 2, provider, auth, credential
  and integration 20, share 10, mcp 9, tui 13, local 14, the v2 `/api/session` family 32, and the experimental tasks
  sub-routes 12 (the tasks list itself is allowlisted).
- Everywhere, GitHub and cloud-agents have no operation in openapi.json at this source. They are covered by fixed and
  random deny-by-default probes (`/experimental/everywhere/run`, `/experimental/github/webhook`,
  `/experimental/cloud-agents`, and a random suffix under each family prefix), plus `GET /doc` (served by the engine,
  `server.ts:240`, not published) and `GET /remote/approval` (the desktop's own passkey route takes only POST). A probe
  that a later regeneration publishes is filtered out of the probe list before the loop
  (`remote-routes-combined.test.ts:110`), because it is then one of the published operations the inventory case
  (`:90`) refuses; the eight random-suffix probes are never published, so the list is never empty. Neither case needs an
  edit when such a path is published.
- What the test catches and what it does not: a route another lane renames or removes (A1), and any published
  operation the matcher would forward (A2). An addition to `REMOTE_ROUTES` itself is not caught by the inventory: it
  drops out of the "others" set by design. It is caught by the existing exact list in `remote-routes.test.ts:239`
  ("matches only plain id segments") and by review of `REMOTE_ROUTES`, which is the boundary the task accepts. The
  list above is here so a later diff of it is visible.

**Stop and tasks readings**

- The phone's Stop forwards exactly `{helpers: boolean}`. `reason`, `sessionID`, `taskIDs`, `all`, any other field, a
  non-boolean `helpers`, a query field, and any method but POST are refused. Plain abort forwards `{}` whatever the phone
  sent. The published Stop body is `{helpers: boolean (required), reason?: string}` with `additionalProperties: false`.
  The test (`:216`) pins only `helpers` as a required boolean: an optional field an engine lane adds to Stop needs no
  edit, and no phone reaches it, because the forwarder sends a rebuilt `{helpers}` (`:165`).
- The tasks read accepts only `descendants`, `active`, `shells` ("true" or "false") and `limit` (1-200). `"0200"`
  passes as 200; the engine reads the same number, so it is not a widening. `directory` and `workspace` in the query
  are refused as invalid requests (readRequest), as before.

**Findings**

- **B09a-1. Confirmed: a helper's request that auto-accept answers still reached the phone as "A helper needs you".**
  - Cause: the engine records a helper's wait (`engine/src/task/attention.ts:197-246`) as soon as the request is asked,
    and clears it when the request is answered. The app sent the helper alert on the first `session.updated` carrying
    the wait (`notification.tsx:449-462` at `dfef44e3`), before auto-accept's answer could land.
  - Repair (`packages/app/src/context/helper-phone-alert.ts`): `createHelperPhoneAlerts` now owns the helper path's
    dedupe and gates (moved from `notification.tsx`, which now calls it once). It sends a waiting notice only if it is
    still the helper's latest notice after a 3 s settle, and an interrupted notice at once (auto-accept never answers
    an interruption). The waiting alert is kept, titled with the conversation's session ("A helper needs you: <root
    title>", route sessions); `helperPhoneAlert` only gains a `waiting` flag, which decides the settle.
  - Regression tests: `helper-phone-alert.test.ts:58` ("a request answered before the settle, as auto-accept answers
    it, sends nothing"), `:99` ("an interruption goes at once") and `remote-turn-alerts.test.ts:123`. Red evidence: a
    transcription of `notification.tsx:449-462` at `dfef44e3` with HEAD's `helperPhoneAlert`, run from `/tmp/vector-v2/codium/b09a/red/` (substitutions recorded
    in its header: lookup from a map, the gate's own rule inline, viewed and disposed false, sends pushed to a list):
    1 alert for a request answered at once. The repaired path sends 0. Nothing was put in the worktree for it.
  - Reading: a waiting helper's phone alert now arrives about 3 s after the wait starts. A wait that moves on to the
    helper's next request alerts once, for the request still waiting.
  - Reading: the settle is a timing bound, not a signal. If auto-accept's answer lands more than 3 s after the ask
    (the desktop `isPhoneTurn` IPC round trip, the reply itself, or timer throttling in a hidden Electron window), the
    phone still gets "A helper needs you" for a request nobody needed. That is a spurious alert, never a missing hold.
    Closing it needs a shared signal (the permission provider marking a `permission` wait whose `requestID` it is
    answering); none exists, and adding one touches `permission.tsx`, so it is left open here.
- **B09a-2. Confirmed: a helper a phone's turn started lost the person-only hold once the phone's turn ended.**
  - Cause: `createRemoteTurns().observe` (`remote-routes.ts:93-102` at `dfef44e3`) cleared a mark only when that
    session was idle, and only the phone's session was marked. Background subagents are on by default
    (`engine/src/effect/runtime-flags.ts:33-38`); once the root was idle, `isPhoneTurn([helper, root])` answered false
    and auto-accept answered the helper's later requests, against S6 (`codium-build-spec.md:175`).
  - Repair (`remote-routes.ts`, header and `createRemoteTurns`): a `session.created` whose `info.parentID` is marked
    marks `info.id` with the parent's time; so does a `session.updated` whose helper record is queued or running with a
    `startedAt` at or after the parent's mark (a helper the phone's turn resumes: task.ts writes a new `startedAt` per
    run). Such inherited marks clear at the helper's own idle or when its record's status is a string other than queued
    or running (as `SubagentLifecycle.open`). A mark the phone set directly clears only at idle (or deletion, B09a-5), as
    before, because a phone may prompt a finished helper's session whose record still reads completed. Roots carry no record and are
    unaffected. `REMOTE_ROUTES` is unchanged.
  - Regression tests: `remote-routes-combined.test.ts:294`, `:323`, `:344`, `:425` and `remote-link.test.ts:539`.
    Red with `dfef44e3`'s `remote-routes.ts`: `remote-link.test.ts` 19 pass 1 fail (`:566`). The combined file, re-run
    in the review round as it now stands: 8 pass 5 fail, first failing expects at `:307`, `:337` and `:369` (the helper
    is never held), `:402` (a refused turn deletes a newer turn's mark, B09a-4) and `:413` (the B09a-5 case stops at the
    missing inheritance). The B09a-4 and B09a-5 repairs' own red is in the mutation list below. The first draft's
    citation (`:302`, `:328`) named `turns.observe` lines of an earlier version of the file, not failing expects.
  - Kept from A41: the turn a helper's report later wakes in the root is the engine's, not the phone's, so auto-accept
    applies to it.
  - Recorded, not changed:
    - A `session.created` the desktop misses while its engine stream is down (`remote-link.ts:345-375` reopens after
      `retryMs * 5`) leaves that helper unmarked, so its later requests fail open once the root is idle. The root's mark
      still covers it while the root's turn runs.
    - Internal child sessions are held too, for their own run. Neither alert path surfaces their asks (both skip
      internal sessions), but S6 makes no exception for them, the lineage check already held them for the root's turn,
      and the change only holds more. The lead may prefer to skip inheritance for `info.internal` children.
    - A long background helper keeps the desktop reading engine events (`remote-link.ts:346`, `turns.size > 0`) until it
      ends, beyond A41's "until the engine reports the session idle". A mark whose idle, record end and deletion are
      never seen keeps holding requests and reading events, as a root mark does today.
- **B09a-3. Not a defect: a Stop body naming another session stops only the session in the path.** The handler builds
  `{ sessionID: ctx.params.sessionID, ...ctx.payload }` (`handlers/experimental.ts:225`); `SessionStopInput`
  (`groups/experimental.ts:109-112`) has no parse options, so excess fields are stripped. Measured locally: the engine
  answers 200 and the manager sees only `{sessionID, helpers}`. The case (`session-stop.test.ts:217`) accepts 200 or 400
  (the published body says `additionalProperties: false`, so refusing would be safer), never an action on the extras.
  `session-stop.test.ts:239` adds that a guest controlling only another session or only the helper gets 403
  (`allowsSession`, `protocol/src/middleware/authorization.ts:38`, decides before any lookup).

**Review round (15 Nov 2026)**

The package review's findings, each read against the code; three are confirmed defects in Codium's own files and are
repaired here.

- **B09a-4. Confirmed (blocking): a phone turn the engine refused released an earlier hold.** `createRemoteRoutes`
  marked the session and, on a non-2xx answer (400 from the engine's admit, 502 when it does not answer, 413), called
  `clear`, which deleted the mark (`remote-routes.ts:284` in the first draft). A helper an earlier phone turn started
  and still running in the background lost its inherited hold when the phone's prompt to it was refused, so auto-accept
  answered its later requests (S6); the same reset dropped a root mark an earlier, still-running phone turn had set
  (older than this package; inheritance made the helper case reachable). The reviewer's probe
  (`/tmp/vector-v2/codium/b09a-review/clear.ts`) showed `has([helper, root])` true before and false after. Repair: each
  hold is an object (`{at, inherited}`), `mark` returns a restore function that puts back the hold that stood before,
  and does nothing once something else has replaced or released this hold (a second phone turn the engine took, an
  idle); `clear` is gone. Regression tests: `remote-routes-combined.test.ts:358` and `:384`. Reading: if the helper's
  record closes while the refused turn waits on the engine, the put-back inherited hold stands until the helper's next
  idle, closed-record update or deletion (held longer, never less).
- **B09a-5. Confirmed (non-blocking): a deleted session kept its hold.** `observe` read no `session.deleted`, so a helper
  deleted mid-run (its parent deleted: `session.ts:942-948` removes children first and publishes `session.deleted` for
  each) kept its mark, `turns.size > 0` stayed true, and the desktop kept reading engine events (`remote-link.ts:346`).
  Root marks had the same gap. Repair: `session.deleted` releases `info.id`'s hold, inherited or direct. Regression
  test: `remote-routes-combined.test.ts:407`.
- **B09a-6. Confirmed (non-blocking): a late update repeating an answered wait re-armed the alert.** `latest.set` ran
  before the `sent.has` return, so a wait cleared during its settle and then repeated by a replayed or out-of-order
  `session.updated` with the same key became the latest again, and the first settle sent "A helper needs you" for an
  answered request (and left an entry in `latest`). Repair: the `sent.has` return comes first, so a sent or settling
  key never re-arms `latest`. Regression test: `helper-phone-alert.test.ts:67`.
- Taken (blocking): the fixed deny-by-default probes no longer assert absence from openapi.json; a published probe is
  filtered out (reading above). The eight random-suffix probes are asserted to remain.
- Taken: the settle applies only to a wait (B09a-1 above); its timing bound is recorded as a reading.
- Taken: the Stop body test pins only `helpers` as a required boolean (reading above).
- Taken: `remote-turn-alerts.test.ts:107` is renamed ("Codium's helper path alerts the phone once") and asserts every
  push the phone gets, Hands' stand-in ask alert and Codium's, with a comment pointing to the "For the lead" item, so a
  fix in Hands' lane visibly changes the expectation.
- Taken: the B09a-2 red citation is corrected (above).
- Not taken: pinning `session-stop.test.ts:217`'s excess-field status to 200. The "For the lead" item below recommends
  that the engine refuse excess fields (matching the published `additionalProperties: false`); a pin to 200 would turn
  that fix red. The case still fails if the engine ever acts on an extra field (calls must equal `{sessionID, helpers}`),
  and the record says the engine answers 200 at this source (B09a-3).
- Open until CI: the B09 checkpoint line and "What ran" get the Vector Codium, typecheck.yml and vector-hosted-ci.yml run
  and job ids as new dated lines once those runs finish; nothing is dispatched before the package is committed and
  pushed.

**Critique points taken and rejected**

- Taken: the waiting alert stays in `helper-phone-alert.ts` (the plan had removed it; B09 lists waiting notes as push
  alerts, and the alert from Hands' path carries the helper's title). `helper-phone-alert.test.ts:6` is unchanged, so
  no expectation was loosened. The combined app test pins Codium's alert and the fixture's stand-in for Hands' ask alert
  (title "ask", route approvals), never Hands' real wording.
- Taken: the plan's third mutation (adding `GET /config` to `REMOTE_ROUTES`) cannot turn A2 red; replaced by turning
  `/session/:sessionID/todo` into `/session/:sessionID/:part`, which A1, A2 and A3 catch.
- Taken: no case was added to the multiagent lane's `engine/test/tool/task-manage.test.ts`; the gap is under "For the
  lead".
- Taken: the excess-field Stop case accepts 200 or 400; the guest case uses only the other-session and child-only
  claims (a guest with no claims is already `session-stop.test.ts:191`).
- Taken: `directories()` is a static set outside the recorded engine; fixed deny-by-default probes were added; the
  red evidence for B09a-1 stayed in `/tmp`; the reduced Hands case only shows its ask is held and adds no Codium alert.
- Taken in part: the B09a-2 gaps are recorded above; internal children are held (reason above) rather than skipped.
- Added beyond the plan: the resume rule (a `session.updated` with a running record started since the mark) and the
  rule that only inherited marks release on a closed record, each with its own test.
- The app test's `autoResponds` composes the exported rules the provider uses (`autoRespondsPermission`,
  `phoneTurnAllows`, `sessionLineage`); the provider's own wiring stays pinned by the source guard at
  `permission-auto-respond.test.ts:223`, because the provider needs a running app.

**Mutations (each restored and checked with `cmp`)**

First draft (lines renumbered to the files as they now stand):

- Dropping the `session.created` rule: `remote-routes-combined.test.ts:294` and `remote-link.test.ts:539` fail.
- The tasks limit accepting 0: `:233` fails.
- `/session/:sessionID/todo` as `/session/:sessionID/:part`: `:71`, `:90` and `:110` fail.
- Any closed record releasing any mark: `:344` fails.

Re-run in the review round, on the current code:

- No latest-notice check after the settle in `createHelperPhoneAlerts`: `helper-phone-alert.test.ts:58`, `:67`, `:77`
  and `remote-turn-alerts.test.ts:123` fail.
- The waiting branch removed from `helperPhoneAlert`: `helper-phone-alert.test.ts:6`, `:49`, `:77` and
  `remote-turn-alerts.test.ts:107`, `:131` fail.
- `latest.set` before the `sent.has` return (the first draft's order): `helper-phone-alert.test.ts:67` fails.
- The settle applied to an interruption too: `helper-phone-alert.test.ts:99` times out (30 s).
- A refused turn deleting the mark (the first draft's `clear`): `remote-routes-combined.test.ts:358` (expect `:369`)
  and `:384` (`:402`) fail.
- The restore without its "still this hold" guard: `:384` (`:402`) fails.
- No `session.deleted` rule: `:407` (`:415`) fails.

**For the lead**

- Hands' ask path sends a second phone alert for a helper's ask: `packages/app/src/pages/layout/ask-notifications.ts:59-64`
  through `ask-notification-controller.ts:68`, titled "Needs you: <helper session title>" (route approvals). Helper
  sessions are not internal, so they are not skipped (`ask-notification-controller.ts:57`). The helper's title is
  `${title} (@agent subagent)` (`engine/src/tool/task.ts:1368`), from the parent model's task description, so it can
  carry prompt-derived text. The desktop dedupes on event plus title (`remote-notify.ts:73-74`), and the titles differ,
  so a held helper ask gives the phone two needsYou pushes. Under auto-accept Hands' path is silent, and Codium's is now
  silent too. To make one place own it: `ask-notifications.ts` skips asks from helper sessions (Codium's root-titled
  alert stays), or the lead changes B09's contract so Codium drops its waiting alert. Not changed here.
- `handlers/experimental.ts:225`: put `sessionID: ctx.params.sessionID` after the payload spread, so the path wins even
  if the schema stops stripping excess fields. The runtime strips extras while openapi publishes
  `additionalProperties: false`; refusing would match the published contract.
- No test shows that `interrupt({ helpers: true })` leaves another conversation's helper tree and its background
  commands running (`engine/test/tool/task-manage.test.ts:570`, `:716`; the multiagent lane's file).

**What ran**

- Locally, through `/home/user/.tools/vector-serial`, one file at a time (counts after the review round):
  - desktop (`bun --no-env-file test --timeout 30000`): `src/main/remote-routes-combined.test.ts` 13/0,
    `src/main/remote-link.test.ts` 20/0, `src/main/remote-routes.test.ts` 16/0, `src/main/remote-phone-app.test.ts` 15/0;
  - app (`bun test --isolate --timeout 30000`): `src/context/remote-turn-alerts.test.ts` 6/0,
    `src/context/helper-phone-alert.test.ts` 8/0, `src/context/permission-auto-respond.test.ts` 21/0,
    `src/context/phone-alerts.test.ts` 6/0, `src/context/notification-event-gate.test.ts` 4/0,
    `src/pages/layout/ask-notification-controller.test.ts` 10/0;
  - engine (`bun test --timeout 30000`): `test/server/session-stop.test.ts` 6/0;
  - `bun typecheck` in `packages/app`, `packages/desktop` and `packages/engine`: clean (app and desktop re-run after the
    review round; the engine file did not change in it). The desktop typecheck excludes
    `src/**/*.test.ts`; a scratch `tsgo --noEmit` over the two desktop test files showed no error in them (its one error
    was the app's `@/` alias, outside them, because the scratch config drops the project reference); the same check
    after the review round gave the same single error.
  - Prettier: the two new test files and `helper-phone-alert.ts` are clean; `notification.tsx` is now clean; the changed
    hunks of `remote-routes.ts` and `helper-phone-alert.test.ts` follow it (their remaining differences are HEAD's lines).
- CI only, not yet run: the Vector Codium run (the picker selects the changed and new test files), typecheck.yml and
  vector-hosted-ci.yml's Hosted tests (desktop `remote-*` tests). The paired desktop/phone browser check stays open
  (B09b).

No flag, setting, listing, route, price or page changed; `REMOTE_ROUTES` is unchanged; no SDK or generated output
changed, so `MODEL-PLANS.md` and the owner-actions files are unchanged. Edits to `api/_lib/model-plan-*.ts`: none.

## Codium finish: B09 browser acceptance (15 Nov 2026)

Track B B09 (`codium-build-spec.md:947`), second half: the checkpoint's "Actual paired desktop/phone browser check"
(`codium-track-b-checkpoint.md:16`). Read and built on `codium-finish` `03266e2e` (equal to origin/codium-finish; PR #33
unmerged: `0ee486e3` is not an ancestor of origin/main, and it is the merge base with origin/release-finish). Scratch
was under `/tmp/vector-v2/codium/b09b/`. CI: pending dispatch (see the dated checkpoint line once the Vector Codium and
typecheck.yml runs finish).

**What landed**

- `packages/app/e2e/regression/codium-remote-helpers.spec.ts` (new; the path names codium, so the picker's
  `CODIUM_PATH` selects it for the Codium browser specs job). Two cases on A42's fixture page:
  - `:88` "a paired phone shows helper and background-job states, stops including helpers with exactly {helpers:
    true}, and reaches no other route". The phone pairs with a passkey (Chromium's virtual authenticator, one credential
    for rpId localhost), opens Sessions and the session "Fix the login", and its Tasks view shows five rows from the fake
    engine's board through the phone's projection (`src/phone/remote/tasks.ts:6-22`, df3951ba): a helper waiting for
    approval ("Waiting for you", "Waiting for your approval."), one working, one interrupted ("Stopped", "Interrupted.
    Continue this task from Vector on your computer."), one disconnected ("Disconnected · last known state") and a
    background command ("Working"). Nothing on the phone holds PRIVATE or 98765. Once the Stop button shows (it waits for
    the capabilities answer, `session-tasks.tsx:46`), the engine's `/experimental/` log is exactly one capabilities read
    and one tasks read with `{descendants, shells, limit: "100", directory: "/repo"}`. "Stop including helpers" (exact
    name, so the plain "Stop" abort beside it never matches) gives the engine exactly one `POST
    /experimental/session/ses_1/stop` with query `{directory: "/repo"}` and body `{helpers: true}`, then one tasks read,
    and nothing else but a possible `GET /project`; no `/session/ses_1/abort` is ever sent. Three routes outside the
    allowlist (`POST .../tasks/stop {all: true}`, `GET .../tasks/tsk_wait`, `POST /session/ses_1/shell`) answer 403
    `REMOTE_ROUTE_REFUSED` and the engine log after them is strictly empty; Stop with `{helpers: true, sessionID:
    "ses_other"}` answers 400 `REMOTE_BODY_REFUSED` and reaches the engine with nothing but a possible `GET /project`.
  - `:176` "a waiting and an interrupted helper reach the paired phone as title-only alerts". After pairing, a helper's
    waiting update alerts once its 3 s settle has passed (polled up to 15 s), then an interrupted update alerts at once.
    Three views of each alert are checked: what the app hands the desktop is exactly `{event: "needsYou", title, route:
    "sessions"}`; what the desktop posts to `https://vectordev.ai/api/notify/send` has exactly the keys `ciphertext`,
    `key`, `urgency` (high) and no title; the sealed plaintext, opened in the page with the key the phone stored when it
    paired, is exactly `{v: 1, title, route: "sessions"}`; and what the service worker would show (`openAlert` and
    `notificationFor`) is the title with no body, tag `sessions` and `/phone/sessions`. Titles are exactly "A helper needs
    you: Fix the login" and "A helper was interrupted: Fix the login" (so neither is the unreadable-alert notice); none of
    the sealed or shown text holds PRIVATE, the helper's title "Check the login form" or "subagent".
- `packages/app/e2e/fixtures/remote-phone.jsx` (extended; `remote-phone.html` unchanged). A header paragraph for B09; a
  fake engine session list (`GET /session`, `/session/status`), capabilities, task board and Stop (its answer is a
  SessionStopResult listing only the two helpers it stopped); the phone client's real alert-key store
  (`saveAlertKey`/`forgetAlertKey`/`forgetAlertKeys`, as `app.tsx:187`); the helper alert path (`createHelperPhoneAlerts`
  with `sessionNotificationAllowed` and `sendPhoneAlert`, the desktop's `createRemoteNotify` with `link.alertKey()` and a
  fetch that only records); and `window.remoteFixture.engine`, `phone`, `helper`, `asked` and `alerts`. The phone pane
  gains the real `SessionsRoute`; `navigate` maps `/phone/sessions` to it instead of to Approvals.
- `packages/app/e2e/tsconfig.json`: the new spec is listed, so `bun run typecheck:e2e` checks it.

No product source changed.

**Readings**

- The forwarder already runs in the page. The fixture builds the desktop's real `createRemoteLink`
  (`remote-phone.jsx:13` at HEAD), which wires `createRemoteRoutes` (`packages/desktop/src/main/remote-link.ts:228-242`);
  every phone `req` goes through `routes.handle` (`remote-link.ts:436-444`) and `matchRoute` (`remote-routes.ts:321-341`,
  allowlist at `:53-79`) before the fixture's fake `engine.request` records it. A42's spec passing in CI (Codium browser
  specs job 132651657817 in Vector Codium run 43661511343, and test.yml e2e jobs 132574288954 and 132574289008, as
  `codium-a42-remote-phone-notes.md` records) shows that module graph loads under Vite, so the Node-side `page.route`
  fallback was not built. Codium browser specs job 132869451570 (run 43733017049) did not run A42's spec: its log shows
  `CODIUM_CI_BROWSER_SPECS` empty and only `codium-image-routing`, `codium-usage-labels` and `codium-vault-sections`
  selected (9 passed), because `remote-phone.spec.ts` is unchanged against the base; that is why this package names it
  in `browser_specs`. No test code restates `REMOTE_ROUTES`; the refused cases are real engine routes outside it,
  and the full inventory stays in `remote-routes-combined.test.ts`.
- `GET /project` is not a timer. It is the desktop's lazy directory cache (`DIRECTORIES_MS = 30_000`,
  `remote-link.ts:58`, read at `:216-226`), refilled when a request names a folder and the cache is older than 30 s.
  `matchRoute` refuses before the folder check (`remote-routes.ts:258-259`), so the three route-refused probes are
  checked for a strictly empty log; the body-refused probe passes the folder check first (`:270-276` before `:281-285`),
  so only it, and the Stop and tasks reads, filter out `GET /project`.
- Typecheck coverage. `bun typecheck` in `packages/app` is `tsgo -b` over `tsconfig.json` (`src` and three
  test-browser files) and does not cover `e2e/`. Only `bun run typecheck:e2e` (`tsgo -p e2e/tsconfig.json`,
  `package.json:25`) does, for the specs its include list names. No Codium-lane or typecheck.yml job runs it (only
  scope-app-validation.yml, on main and release-finish), so the local run is the type receipt. Playwright's transpile
  does not typecheck, and the `.jsx` fixtures are not typechecked anywhere.
- Fixture substitutions (each is the real module with a stand-in input): Settings → Notifications' choices are all on
  with no quiet hours; the plan status is in-page data listing `alerts` and `remote` at rank 2; the conversation lookup
  answers the fake engine's one session; nothing is viewed on screen; the helper's `session.updated` is handed to
  `createHelperPhoneAlerts` directly (standing in for `notification.tsx:450-462`); the server relay is restated as
  `{v: 1, kind: "e2e", c, k}` from `api/_lib/web-push.ts:336` (Node-only, not imported); and the service worker's open is
  called in the page (`sw.ts:44-46`). Not composed: `NotificationProvider` and the Electron IPC
  (`ipc.ts:448-451`, `phone-alert-send`); the provider's wiring is covered by `remote-turn-alerts.test.ts` and source
  review. Hands' ask path (`ask-notifications.ts`) is not composed either, so B09a's "For the lead" item on its second,
  helper-titled alert stands.
- `openAlert` rebuilds an alert as `{title, tag, route}` and drops every other field (`alerts.ts:88-95`), and
  `notificationFor` adds a body only from `alert.body`, which an end-to-end alert never has (`alerts.ts:99-108`). A check
  of the shown notification alone therefore could not fail if the desktop sealed a report, prompt or command beside the
  title. That is why the spec also checks the app's `phoneAlerts.send` argument and the raw sealed plaintext.
- The extension's effect on A42: the phone's alert keys now go to the real IndexedDB store (the client's save is inside
  its own try/catch, `client.ts:548-555`); A42 never navigates to Sessions or asks the new engine paths, and its nav
  buttons and the Pair/Approvals switch are unchanged in behaviour.
- The Tasks view shows each helper's task title. That title is the parent model's description and can be
  prompt-derived (B09a "For the lead"). It travels only on the owner's end-to-end encrypted channel, as `tasks.ts:5`'s
  design allows; alerts never carry it, which `:176` checks.
- Not a defect, recorded: the capabilities and tasks routes came with df3951ba, so a desktop without them answers 403
  and the phone shows "Tasks could not be loaded" rather than the 404 "Update Vector" hint. This is moot while no
  released desktop has Remote.

**Findings**

None. No product defect was found: every expectation the spec makes was also checked locally against the real modules
without a browser (below), and each held at HEAD.

**Critique points taken and rejected**

- Taken (major): `:176` checks the app's `phoneAlerts.send` argument and the raw sealed plaintext, not only the shown
  notification (reading above).
- Taken: the post-Stop check covers the whole slice (one Stop, one tasks read, only `GET /project` besides), uses the
  exact button name, and asserts no abort was sent.
- Taken: the `/experimental/` comparison waits for the Stop button, which shows only once both answers arrived.
- Taken: the local e2e Vite build ran before any push (it needed an 8 GB heap; below).
- Taken: B09a's CI receipts are recorded here and in the checkpoint (below), after reading the runs' jobs and logs.
- Taken: the line numbers and the `GET /project` description are corrected (sessions.tsx `ComputerSessions` 83-185,
  `SessionView` 187-349; the remote-notify body at `remote-notify.ts:89`).
- Taken: the fake Stop answer lists the two helpers it stopped; the spec's `phone` and `alerts` are typed as Promises.
- Taken: a retry or a "flaky" entry on either new case in CI counts as a failure needing a root cause (it is not in
  RULES-v2.md's flake list; `playwright.config.ts:26` gives CI two retries). The receipt records each case's attempt as
  the visible log shows it, or says the reporter lines are not visible.
- Taken in part: the helper's lifecycle record carries no prompt field (engine `agent/subagent-kind.ts` SubagentRecord
  has none), so the fixture puts private text in the fields it does have (`resultSummary`, `reason`, `error`,
  `waiting.summary`) and in the helper session's own title, which is the prompt-derived text.

**Review findings, round one (15 Nov 2026)**

- Taken (blocking): the forwarder reading above cited Codium browser specs job 132869451570 as running A42's spec. Its
  log (685 lines; the 400-line tail read holds the Select step and the whole Playwright group) shows it did not; the
  reading now cites only jobs that ran it.
- Taken: the checkpoint's B09b line said four disallowed requests were refused before the engine. Only the three
  route-refused probes are; the body-refused Stop passes the folder check first (`remote-routes.ts:270-276` before
  `:281-285`), so the line now says so.
- Taken: the opening paragraph's "Not committed or pushed" sentence, which stops being true once the package is pushed,
  is now "CI: pending dispatch".
- Taken: the spec uses dot access instead of destructuring (`auth.cdp`, `auth.authenticatorId`, `stored.credentials`,
  `(await pair(...)).phone`); the case lines stay `:88` and `:176`.
- Taken: the fixture's `alerts` decrypt carries a comment that it mirrors `openAlert`'s on purpose to read the raw
  plaintext. Not taken: exporting an `openSealed` from `alerts.ts` (a product change for a test's sake; the comment
  marks the coupling).
- Not taken: moving `authenticator` and `call` into a shared `e2e/fixtures/remote-phone-helpers.ts`. That would edit
  A42's `remote-phone.spec.ts`, which this package keeps unchanged so its CI receipt stays comparable; a later package
  that may touch A42's spec can share them.
- Open until CI: the run and job ids, both specs' per-case results as the visible log shows them (`:88` and `:176`
  here, `remote-phone.spec.ts:44` and `:102`), any retry recorded as a failure needing a root cause, and the
  typecheck.yml run id, appended as dated lines here, in the checkpoint's B09 row (closing "Actual paired
  desktop/phone browser check") and in the a42 notes.

**B09a's CI receipts (recorded here, 15 Nov 2026)**

For `03266e2e` ("Codium finish: B09 combined Remote authorization", whose "Open until CI" item this closes):

- Vector Codium run 43733017049: every job passed except Codium tests job 132869451320, which failed only at "Run
  HttpApi exerciser gates" with `summary pass=359 fail=0 skip=0 missing=4 extra=0` and exactly the four review-memory
  lines (`MISS DELETE /experimental/review-memory/previews/{previewId}`, `MISS GET /experimental/review-memory`, `MISS
  POST /experimental/review-memory/confirm`, `MISS POST /experimental/review-memory/prepare`). Its "Run the Codium test
  files" and "Check generated client" steps passed. The per-file lines of B09a's test files were not read, so no
  per-file count is claimed. Codium browser specs job 132869451570 passed.
- typecheck.yml run 43733021027: success.
- vector-hosted-ci.yml run 43733598222: every job passed; Hosted tests job 132871223524 ends "Hosted: 150/150 test files
  passed" (the desktop `remote-*` files' own lines were not read).

**For the lead**

Nothing new. B09a's items stand.

**Deferred verification**

- No real phone, real relay, real push service or real service worker; no Electron, Windows or macOS. The page uses the
  in-memory relay, a fake ticket API, a recording notify fetch and Chromium's virtual authenticator.
- `typecheck:e2e` is not in the lane's CI; the local run is the only type receipt for the spec.
- No Playwright mutations: the spec runs only in CI.

**What ran**

- Locally, through `/home/user/.tools/vector-serial`, one at a time:
  - before the edits, unchanged-module receipts: app (`bun test --isolate --timeout 30000`)
    `src/phone/remote/tasks.test.ts` 1/0, `src/phone/alerts.test.ts` 6/0, `src/phone/remote/client.test.ts` 7/0,
    `src/context/helper-phone-alert.test.ts` 8/0, `src/context/phone-alerts.test.ts` 6/0,
    `src/context/remote-turn-alerts.test.ts` 6/0; desktop (`bun --no-env-file test --timeout 30000`)
    `src/main/remote-notify.test.ts` 6/0, `src/main/remote-link.test.ts` 20/0, `src/main/remote-routes.test.ts` 16/0,
    `src/main/remote-routes-combined.test.ts` 13/0;
  - app `bun run typecheck:e2e` clean before and after the edits; `tsgo --listFiles` lists the new spec, and a
    deliberate type error appended to it was reported (`codium-remote-helpers.spec.ts(201,7)`, then the file was
    restored and checked with `cmp`); app `bun typecheck` clean;
  - the e2e build, `bunx vite build --config e2e/vite.config.ts --outDir /tmp/vector-v2/codium/b09b/dist-e2e`: the first
    attempt ran out of Node's default heap (2 GB) while transforming; with `NODE_OPTIONS=--max-old-space-size=8192` it
    built in 1 min 27 s with no missing export or unresolved import, and `remote-phone.html` with its chunks (which hold
    "Stop including helpers", "A helper needs you" and `vector-alert-v1`) is in the output;
  - scratch checks without a browser, under `/tmp/vector-v2/codium/b09b/check/`: the fixture's board (extracted from
    the fixture file) through `decodeTasks`/`taskStatus`, before and after Stop, gave exactly the rows the spec expects;
    the spec's seven phone requests through the desktop's real `createRemoteRoutes` gave exactly the engine calls and
    refusals the spec expects; and the fixture's helper alert block, with the real `createHelperPhoneAlerts`,
    `sendPhoneAlert`, `createRemoteNotify`, `openAlert` and `notificationFor` (IndexedDB replaced by a map of imported
    keys), gave exactly the asked, sent, sealed and shown values `:176` expects;
  - Prettier: the new spec and `e2e/tsconfig.json` are clean; the fixture's changed hunks follow it (its remaining
    differences are HEAD's lines).
  - after the round-one review fixes (dot access in the spec, the fixture's decrypt comment): app `bun run
    typecheck:e2e` clean again, Prettier clean on the spec and `e2e/tsconfig.json`, and the fixture's changed hunks
    still match Prettier's output.
- CI only, not yet run: the Codium browser specs job (`codium-remote-helpers.spec.ts` selected by its path, and
  `remote-phone.spec.ts` named in `browser_specs` because it is unchanged on main), the rest of the Vector Codium run,
  and typecheck.yml. vector-hosted-ci.yml is not part of this package.

No flag, setting, listing, route, `REMOTE_ROUTES` entry, price, copy or page changed; no SDK or generated output
changed, so `MODEL-PLANS.md` and the owner-actions files are unchanged. The fixture is built only by
`e2e/vite.config.ts` (into the gitignored `dist-e2e`) for Playwright, not for the app, the phone build or vectordev.ai.
Edits to `api/_lib/model-plan-*.ts`: none.

**B09b's CI receipts (recorded by Codium finish DZ, 15 Nov 2026)**

These are for `572de5c4`.

- Vector Codium run 43738423276: `get_job_logs` with `failed_only` lists one failed job of 18, Codium tests job
  132886071440. Its visible tail shows "Codium: 153/153 test files passed", then exactly the four review-memory MISS
  lines and `summary pass=359 fail=0 skip=0 missing=4 extra=0`. The job's step list (`get_workflow_job`) shows that
  "Run the Codium test files" and "Check generated client" succeeded and only "Run HttpApi exerciser gates" failed, so
  the run is green under the lane rule.
- Codium browser specs job 132886071679 (688 lines, wholly visible):
  - its env shows `CODIUM_CI_BROWSER_SPECS: packages/app/e2e/regression/remote-phone.spec.ts`;
  - "Running 13 tests using 1 worker", then "13 passed (1.1m)";
  - the cases include `codium-remote-helpers.spec.ts:88:1` and `:176:1`, `remote-phone.spec.ts:44:1` and `:102:1`,
    and `codium-vault-sections.spec.ts:28:1`, `:41:1`, `:58:1` and `:66:1`.
- typecheck.yml run 43738426563 and vector-hosted-ci.yml run 43738962650: success (run conclusions).

This closes "Actual paired desktop/phone browser check" (checkpoint, B09). It ran on A42's browser fixture with the
desktop's real forwarder. No real phone, passkey device or packaged desktop app was used.

## Codium finish: H1 download-only start (15 Nov 2026)

Package H1a, the server half of the hosted gap that "P8 review decisions (9 Nov 2026)" (first bullet),
`codium-p8-repairs.md` ("CI only and not done", last bullet), `codium-a53-hosted-sessions-notes.md` (A56 bullet and
"Not done") and `MODEL-PLANS.md` ("Other charges", "Provisioner (A53)") name: spec §4.4's Cloud computer row
(`codium-build-spec.md:354`) keeps an ended plan's disks "14 days for download (notice), then deleted", and no route
let an ended plan download its disk. Built on `codium-finish` `572de5c4` (equal to origin/codium-finish; PR #33 unmerged:
origin/main is `58f85edc`, origin/release-finish `cf2373c4`). The computer side is H1b. Scratch under
`/tmp/vector-v2/codium/`. Not committed by this build step; CI ids follow in a dated line.

**What landed**

- `POST /api/hosted/sessions {mode: "download", computer}` (`api/_lib/hosted-api.ts:148`, `readStartBody` `:168`;
  `api/hosted/sessions.ts` doc only). Same caller rules as a session start (a website session or a marked token, the
  `hosted-start` 30-an-hour limit). A session body keeps its own field list and copy ("Send only size, jobMinutes,
  prompt, title."), so the unlisted mode is never named in an error.
- `startHostedDownload` (`api/_lib/hosted-sessions.ts:682`), in order: hosted configuration and the media bucket (503),
  `requireAccountOpen` (the tombstone, 409 `MODEL_PLAN_ACCOUNT_CLOSING`), a hold on the account (403 `HOSTED_FROZEN`),
  the `hosted` switch and `hostedOpen` (503), the plan (`requireHostedDownload`, below), the disk's date
  (`hosted:disk-due`, checked before the computer, so a deleted computer answers 409 "This computer's disk is no longer
  kept." rather than 400; and refused with 409 "Too little time is left before this computer's disk is deleted." when
  less than a block and an hour, `DOWNLOAD_LINK_MS / 24`, is left, `:702`), the computer one the account has, and its lease (CLAIM's new ARGV[6], first computer: 429
  `HOSTED_BUSY` "This computer is already getting its files ready."). The record is `mode: "download"`, size standard,
  `browser: false`, `download: {requestedAt}` from the start, deadline one block; no job key. After the record and the
  live-list ZADD the date is read again, so a start racing the nightly deletion is abandoned. The start then runs the
  shared tail, `launchSession` (`:566`), which `startHostedSession` now also calls (its signature is unchanged; A55
  calls it).
- `launchSession` in download mode: `openBlock(..., download: true)`; a hold refused for the money answers 402
  `MODEL_PLAN_EXHAUSTED` "Your Vector Codium plan cannot cover getting this computer's files ready." (no amount);
  after the record update and before the provider, `chargeRetention(account, {computer, gb: HOSTED_DISK_GB_MAX, days:
  Hosted.ENDED_DISK_DAYS})` (`:611`), inside the same try as the record update, so a failure there closes the block at
  its start (nothing charged) and nothing is asked of the provider.
- Ledger (`api/_lib/hosted-ledger.ts`): `openBlock` takes `download?: true` (with `renew` 400). The plan checks moved
  into `blockPricing` (`:483`, the session path, unchanged checks in the same order) and `downloadPricing` (`:519`), so
  the one `holdPool(` call and the A51 tripwire (`test/codium-pool.test.ts`, "A51 obligation") stay as they were. The
  download block: `requireHostedDownload`; for an ended plan the entry's epoch and period end are the final key's own
  (`${key.subscription}:${key.start*1000}`, `key.end*1000`), and a hold whose pool is not that key is given back (503);
  `requireDailyRoom` kept; `computers: MAX_COMPUTERS` (`:530`, any plan's most, imported from hosted-provider.ts,
  which imports this module too: it is read only at call time, so the cycle is safe, as hosted-sessions.ts →
  codium-provisioners.ts → hosted-crons.ts → hosted-sessions.ts already is); `cap: Number.MAX_SAFE_INTEGER` (`:445`);
  `minutesAt` never in the past (`:452`). Header: the download-only block and the producers' obligation.
- `holdPool(..., "hosted", {final: true})` (`api/_lib/model-plan-account.ts:2485` validation, `finalPoolCredential`
  `:2545`; the usual path moved verbatim into `currentPoolCredential` `:2521`). `final` only with purpose hosted and no
  run (500 `MODEL_PLAN_POOL_INVALID`). It reads the private record first (closing, risk, a transition, upgrade, key
  creation or unfinished owner end, as `snapshotPoolCredential` does), requires a ready genesis and integer credits,
  reads the key's usage from the provider (a missing key or no usage refuses, 503) and never requires the key enabled,
  unrevoked or inside its period. The one `placeHold(` call gains `final: true`.
- HOLD (`api/_lib/codium-pool.ts`): `FINAL_PERIOD_REASONS` (`:241`) and `model_final_fence` (`FINAL_FENCE_LUA` `:249`):
  `model_pool_fence`'s record, risk, genesis and pool checks (a revoked key allowed), then the snapshot must be ended on
  the key's own subscription, at the given version, with no reason or one of `FINAL_PERIOD_REASONS`; anything else is
  'stale'. HOLD's body (`:292`) takes the final fence only for `fence.final == true`, purpose hosted and no run (else
  'unavailable'); floor, writes and TTL are unchanged. `model_pool_fence` and ADMIT are byte-identical.
  `poolFence`/`placeHold` carry `final`. The emulation (`packages/web/test/fixture/codium-spend-emulation.ts`) mirrors
  both steps.
- `api/_lib/hosted-entitlement.ts`: `hostedDownloadAccess` (`:110`, pure) and `requireHostedDownload` (`:137`); the
  `hostedDiskPolicy` doc now says the first download-only start charges the retention.
- Person actions and the computer (`api/_lib/hosted-sessions.ts`): `issueViewer` and `takeOverHostedSession` refuse a
  download session (400 "This session only gets the computer's files ready to download."); `listHostedSessions` gives it
  no handoff; `verifyHostedRunToken` refuses it (401 `MODEL_PLAN_RUN_EXPIRED`: chat and /models both go through
  `requireModelPlanCaller`, S3) and `assertHostedSessionLive` is false; the heartbeat answers `mode: "download"`,
  `browser: false`, no job, no heartbeat hooks (no recording links, no hand-over alert), and `pack` at once (the
  existing pack/upload code, since `download.requestedAt` is set). `requestDownload` accepts `starting` for a download
  session only (a job session keeps `running`, `takeover`, `wrapping`); while the account has a deletion date no link
  outlives it (`mintDownloadToken`'s new `until`, `api/_lib/hosted-tokens.ts:228`), and none is given once it passed
  (410).
- Crons (`api/_lib/hosted-crons.ts`): `reapDownload` (`:347`, called right after the suspension check) ends a download
  on the switch, a plan that no longer allows it, the upload or the daemon's done, the block's end (`endsAt`,
  "deadline") or a lost heartbeat; no idle or fair-use check, wrap-up, renewal or token refresh.
  `applyHostedTransition` leaves a download running while `hostedDownloadAccess(to)` is final, current or live, so the
  sweep's catch-up and replays of the ended transition never end it. The ended-transition comment and the provisioner
  doc now describe the charge at the first download. The nightly deletion pass erases the account's packed files
  (`eraseSessionArchives` over the account's sessions) before it forgets the date, and the egress waiver keys.
  `chargeComputer` sets the bytes download sessions uploaded (`hosted:download-egress:<account>:<n>`, written by the
  heartbeat when it confirms a download session's upload, at most `ARCHIVE_MAX_BYTES` per computer until its deletion
  date, counted in `hosted:download-uploaded:<account>:<n>`) against the measured egress and charges the rest.
- `packages/schema/src/hosted.ts`: `SESSION_MODES`, `SessionMode`, and `mode?: "download"` on `SessionView` and
  `HeartbeatAnswer`. `ENDED_DISK_DAYS` and `LOST_DISPUTE_DISK_DAYS` are untouched.

**Readings**

- **R1, the final-period hold, and the files outside the task's list.** "Held through `holdPool(..., "hosted")` from
  the final period" cannot be done with holdPool as it was: `requireUsableSnapshot` throws 402 for an ended snapshot
  (`codium-snapshot.ts:149-158`), `snapshotPoolCredential` requires active or renewing and an unrevoked key
  (`model-plan-account.ts:1846-1878`), `model_pool_fence` answers 'stale' for an ended snapshot or a revoked key
  (`codium-spend-ledger.ts:166-191`), and reconcile revokes an ended plan's key (`revokeEndedKey`, `:762-764`) and
  switches it off, which `readyKey` refuses. So the build edits, beyond the task's list: `api/_lib/codium-pool.ts`
  (HOLD's final fence, the only place the money fence can run atomically), `api/_lib/model-plan-account.ts` (holdPool's
  final path), `packages/web/test/fixture/codium-spend-emulation.ts` (the in-memory HOLD must match the Lua),
  `api/_lib/hosted-entitlement.ts` (the plan answer for a download, beside `requireHostedStart`), `api/_lib/hosted-api.ts`
  (the route's body), `api/_lib/hosted-tokens.ts` (the link's cap) and the CLAIM script (one optional argument). The
  final path rests on one provider assumption: that OpenRouter keeps an expired, switched-off key readable (usage) and
  patchable (its limit, when the block's debit is applied). Every final key is past `keyExpiresAt` (period end plus the
  grace, `model-plan-account.ts:319`) when a download starts. The fakes answer whatever the real provider does; if
  OpenRouter deletes or stops answering for expired keys, every download start answers 503 and nothing is held or
  charged (tested). Owner check: confirm against OpenRouter before listing. A fallback the owner could choose, not
  built: price the hold against the key's last recorded `limitMicro` instead of a usage read.
- **R2, owner question: who pays a download-only block.** Reading: the final period of the ended plan (or the current
  period after a move to a plan without a cloud computer), held and settled as any block (M2, M8), so a period that
  cannot hold it refuses with nothing charged. The payer is chosen in one place, `downloadPricing`'s `final` and its
  epoch, so the owner can change it; a Vector-paid block would need an owner decision under M8. The upload's egress is
  read the other way: Vector pays it. The nightly egress charge (`chargeComputer` → `chargeNightly` → `chargeOnce`) has
  no hold and would otherwise debit the final period the next night for up to the disk's whole size, outside the
  block's hold; the bytes a download session uploaded are set against the computer's measured egress instead (tested:
  2 GB uploaded, 2.5 GB measured, 0.5 GB charged). The waiver is bounded (review fix B1 below): every confirmed
  download upload adds its bytes to `hosted:download-uploaded:<account>:<n>`, which expires at that disk's deletion date,
  and only the part that keeps that total within one archive's worth (`ARCHIVE_MAX_BYTES`, the largest packed files a
  computer may upload in one PUT) is added to the waiver; a further upload's egress is charged as any egress, with no
  hold, the next night (tested: three 4 GB uploads, one archive's worth waived, the rest charged). The waiver offsets
  whatever egress that computer measures while it lasts (7 days), a later job session's included, should the
  subscriber come back. Owner question, no amounts: whether the subscriber should pay that egress (it would need its
  own hold, sized from the disk), and whether one archive's worth per computer and window is the right bound.
- **R3, owner question: the retention charge.** P8 said the provisioner "should charge chargeRetention again"; charging
  at the transition would charge every subscriber who ends, including those who never download. Reading: the first
  download-only start of each computer charges `chargeRetention` (the full `ENDED_DISK_DAYS`, once per computer and
  period, `hr-<computer>-<subscription>-<start>`), after the block's hold, so a tight final period grants fewer days
  while the disk stays kept the whole window; the first deletion date stands and the rest is at Vector's cost. A start
  that fails after the hold (the provider cannot start the computer, or boot fails) keeps that one retention line: the
  disk was kept, and a later start does not charge it again (tested). Disks nobody downloads stay at Vector's cost.
  After a move to a plan without a cloud computer (`current`), both the block and the retention are charged to the
  current, smaller plan's period, not the final period of the plan that had the computer (§4.4 and `hostedDiskPolicy`
  say "from the final period"; the plan that had it has no ended key to charge then). Put to the owner with R2.
- **R4, owner question: which plans may download.** `hostedDownloadAccess`, for every `PLAN_REASONS` value of an ended
  plan: `canceled`, `payment_failed`, `action_required`, `payment_pending` and no reason → final (the last period was
  paid and kept; only the renewal was not); `refunded`, `disputed` (a lost dispute; §4.4 keeps those disks with no
  download), `early_fraud_warning` and `owner` (ended by Vector) → refused, 409; `closing` → 409
  `MODEL_PLAN_ACCOUNT_CLOSING`. Frozen → 403 `HOSTED_FROZEN`; paused → 402 `HOSTED_PAUSED`; a live plan with the
  computer → 409 (start a session and ask for its files); a live plan without it → current; no plan → refused. The
  plan's two listed reasons were canceled and payment_failed; the critique was right that action_required and
  payment_pending are the same case (a paid period, an uncollected renewal), so they are final too.
- **R5, one block per session.** Each download session lasts one block, one at a time per computer (its lease); the
  account may start another once one ended, as long as the date, the money and the starts limit allow. A download: the reaper ends it at `endsAt`, on the upload, on the daemon's done or
  a lost heartbeat; it is never renewed and its token is never refreshed (it was minted to outlive its block). No idle
  or fair-use check runs: there is no agent.
- **R6, no agent.** No job, no browser, no live view, no take-over, no recording links or hand-over alert; its `vht_` is
  refused by the gateway's verifier, so chat and /models refuse it (S3); the heartbeat route still takes it.
- **R7, the OPEN payload.** `computers` is any plan's most (the computer's own lease, CLAIM over exactly that computer,
  is the real bound) and `cap` is unbounded: that period includes no hours, and the block's money and one-block life
  bound it. Rejected, the critique's alternative of a cap from the period's used and reserved minutes read first: it
  adds a read-then-write race and no bound beyond what OPEN's `prev` check and the lease give. METER still counts the
  block's minutes in that period's hash once it settles, in a period with no computer; nothing reads them there.
- **R8, the provisioner skip.** Without it, every replay of the ended transition (the sweep's catch-up) would end a
  running download. A freeze, a refund or a dispute's loss ends it.
- **R9, the schema field and hostd.** `mode` is optional and sent only as `"download"`. Corrected from the plan: an old
  image cannot run a download, because `requireDaemonBeat` refuses any unsigned heartbeat and today's deployed images
  predate signed beats (`codium-p8-repairs.md`, "CI only and not done"). A hostd built from current source handles a
  download without H1b (no job, so no agent starts; `pack` and `upload` are answered as today), once the owner rebuilds
  the image. H1b reads `mode`.
- **R10, copy.** New messages only, no amount, no GitHub or Actions: "Your Vector Codium plan cannot cover getting this
  computer's files ready."; "This computer's disk is no longer kept."; "This computer's files cannot be downloaded for
  this account."; "Your plan includes the cloud computer. Start a session and ask for its files."; "This computer is
  already getting its files ready."; "This session only gets the computer's files ready to download."; "A download
  names only the computer."; "Too little time is left before this computer's disk is deleted."; and the existing "Choose one of your computers.", "The cloud computer is on hold for this
  account." and "This session's files are no longer kept." reused. The session body's "Send only size, jobMinutes,
  prompt, title." is unchanged.
- **R11, the packed files go with the disks.** §4.4's "then deleted" now covers the packed copy too: no link outlives
  the deletion date, none is given after it, and the nightly deletion pass erases the account's archives (all its
  sessions', since a job session's packed files are a copy of the same disk) before it forgets the date; a link minted
  after that leads to 410 (tested with the R2 DELETE seen). If the media bucket cannot be signed the pass fails for that
  account and tries again the next night (the computers are deleted first, idempotently). The bucket's own lifecycle
  rule (owner-actions/hosted-computer.md step 4, 2 days under `hosted/`) can remove the packed files much earlier: a
  link then leads to 410 "no longer kept" (`downloadRedirect`'s HEAD), and the person starts another download-only
  session (or asks a running one). The code does not cap the link at the rule, since the rule's day count is the
  owner's and the code cannot read it; the owner-actions note says the link works only while the bucket keeps the files.
  No link is given or followed while the plan is frozen, after a lost dispute (§4.4: no download) or while the account
  is being deleted (`requireFilesAllowed`, `hosted-sessions.ts:1210`), whatever the session.
- **R12, not checked.** That the provider still has the disk before the hold: a start whose disk is gone pays a block
  and the retention for an empty computer. Not built (a `provider.list` read before the hold is the owner's or H1b's
  choice); the date re-read after the live-list ZADD closes the race with the deletion pass.

**Critique points taken and rejected**

- Taken (major): egress of the upload (R2, waiver and test). Taken (major): the packed files after the date (R11).
  Taken (major): the provider assumption (R1, 503 test, owner check). Taken (major): `requestDownload` keeps
  `takeover` for job sessions (regression case "a session under the person's control is still asked for its files").
- Taken: R9's wording; the extra files listed in R1; epoch and period end from the final key (a ledger case runs the
  real reconcile to `ended`/`canceled`, revoked key and switched-off key, and the block's line lands in that key's
  period); every end reason in R4 and in a table test; the date re-read and the date checked first (a case runs the
  nightly deletion, then a start); the body copy kept; retention outcomes in R3 with a provider-failure case; the extra
  local runs and the web typecheck; the a56 status line and the budget observation.
- Rejected: the read-then-cap OPEN (R7).

**Observations (not changed)**

- Own code: a job session's archive upload counts toward the account's daily egress fair-use counter, and a download
  session's upload does too (the reaper runs no fair-use check on a download, but the counter is the account's).
- The budget figure's roster drops non-live plans (`hosted-crons.ts`, budget figures), so a download block's compute for
  an ended account is outside the M9 budget figure. Owner note, no amounts.
- The drift check reads the snapshot's period; a download for a plan that ended `payment_failed` with a snapshot on the
  unpaid renewal period files its line under the final key's period, which could show as drift (owner email only).

**Not built**

- §4.4's notice of the 14 days, and every client surface: `decodeSession` in
  `packages/app/src/features/cloud/hosted/hosted-model.ts` ignores `mode` and would offer Watch or Take over (both
  refused by the server). H1b (hostd reading `mode`) and the image rebuild (owner) are separate.

**Ran locally** (through `vector-serial`, one file at a time from `test/` with `--timeout 30000`, after the last code
edit): `hosted-sessions-api.test.ts` 39 pass, 1 skip (the Valkey script case); `hosted-lifecycle.test.ts` 18/0;
`hosted-ledger.test.ts` 31 pass, 1 skip (Valkey); `hosted-reaper.test.ts` 26/0; `codium-pool.test.ts` 29/0 (in
memory; its Valkey run is CI's); regressions `hosted-copy` 5/0, `hosted-jobs` 31 pass 1 skip, `hosted-clients` 8/0,
`hosted-provider` 39/0, `hosted-internal` 12/0, `codium-mode` 18/0, `codium-usage-history` 11/0,
`codium-plan-change` 29/0 and `account-delete` 37 pass 1 skip (these last five before the final line wraps, which
changed no logic). New cases: sessions-api's "download-only starts for an ended plan's kept disk (H1a)" (9 cases) and
the take-over regression; lifecycle's "download-only starts in §4.4's row (H1a)" (3); ledger's "download-only blocks
(H1a)" (3); reaper's "download-only sessions (H1a)" (2); pool's "H1a: the final fence" (2); the CLAIM first-computer
lines in the Valkey script case. Typechecks: `packages/engine` `bun typecheck --project ../../tsconfig.json` (api, test and
the fixture), `packages/schema`, `packages/hosted-computer` and `packages/web` `bun typecheck`, all clean. `prettier
--write` on the files that were formatted at HEAD; the others were already unformatted at HEAD and only the added lines
were wrapped.

**Only in CI.** The Valkey cases (HOLD's final fence on real Lua in `codium-pool.test.ts` "H1a: the final fence", the
CLAIM first-computer case in `hosted-sessions-api.test.ts`, the ledger scripts), the Postgres ledger, and the hosted
services. Dispatches after the lead's commit: Vector Codium on `codium-finish` with `base: "origin/release-finish"`,
then typecheck.yml, then vector-hosted-ci.yml once the Vector Codium run finished.

**Review fixes (15 Nov 2026).** The package review's findings, fixed in the worktree before the commit:

- B1 (blocking), the unbounded egress waiver: bounded to one archive's worth per computer until its deletion date
  (R2). Regression: `test/hosted-lifecycle.test.ts` "Vector pays at most one archive's worth of a computer's download
  uploads until its disk's date" (three uploads on one computer; the waiver stops at `ARCHIVE_MAX_BYTES`, the counter
  expires at the date, the nightly line charges the rest), and the deletion case now checks both keys go.
- N1, a start just before the date: refused with 409 when less than a block plus `DOWNLOAD_LINK_MS / 24` is left.
  Regression: sessions-api "a start too close to the disk's date is refused; one with a block and an hour to spare goes
  ahead" (the boundary minute allowed, one minute later refused with nothing charged, leased or started).
- N2, the `current` path end to end: sessions-api "a live plan without a cloud computer downloads from its current
  period, retention included" (vector-50 snapshot, the provisioner's date, 201, the block's pool, epoch and period end
  the live period's, the retention line in it, the heartbeat asking only to pack).
- N3, the waiver key's computer number: read after the account's own prefix (`accountComputerPrefix`), any number of
  digits, no waiver for a name that is not the account's (`hosted-crons.ts:729`). R2 now says what the waiver offsets.
  Covered by the lifecycle egress cases.
- N4, links while frozen: `requireFilesAllowed` in `requestDownload` and `downloadRedirect`: 403 `HOSTED_FROZEN`
  while frozen, 409 `HOSTED_DOWNLOAD_UNAVAILABLE` after a lost dispute (beyond the finding: §4.4's row gives a lost
  dispute no download either), 409 `MODEL_PLAN_ACCOUNT_CLOSING` while closing; a plan that ended canceled is unchanged.
  It applies to job sessions too, which is a change to A53's behaviour for frozen accounts. Regression: sessions-api
  "no link is given or followed while frozen, after a lost dispute or while closing (§4.4), whatever the session".
- N5, `DOWNLOAD_COMPUTERS`: removed; `MAX_COMPUTERS` imported (see What landed), and the ledger's new `ENTITLEMENTS`
  and `PLANS` imports are gone.
- N6, the switch type: `SwitchValue` in `blockPricing` and `downloadPricing`.
- N7 and N13, the upload confirmation: the CAS updater is pure again and the waiver is decided from the saved record
  (`readyAt` and `bytes` are this beat's), with no `let` and no non-null assertion.
- N8, the commit body: for the lead's commit (the body must name `api/_lib/model-plan-account.ts` and list
  `api/_lib/codium-pool.ts` and `packages/web/test/fixture/codium-spend-emulation.ts` with the other files).
- N9, the link and the bucket's rule: owner-actions note, wording in MODEL-PLANS.md, the a53 status line and the
  owner-actions paragraph (R11).
- N10, the owner-actions paragraph: reachability as `hostedOpen` decides it, and the number of sessions as the code
  allows (one at a time per computer, each one block).
- N11, the retention after a plan change: R3.

None disagreed with. Local runs after these fixes (through `vector-serial`, one file at a time from `test/`, `--timeout
30000`): `hosted-sessions-api.test.ts` 42 pass, 1 skip (Valkey); `hosted-lifecycle.test.ts` 19/0; `hosted-ledger.test.ts`
31 pass, 1 skip; `hosted-reaper.test.ts` 26/0; regressions `hosted-provider` 39/0 (the new import cycle), `hosted-copy`
5/0, `account-delete` 37 pass 1 skip, `hosted-jobs` 31 pass 1 skip, `hosted-internal` 12/0, `hosted-clients` 8/0,
`codium-pool` 29/0. Mutations: with the waiver unbounded the lifecycle case fails; with `requireFilesAllowed` skipped
the files case fails. Typechecks: `packages/engine` `bun typecheck --project ../../tsconfig.json` and `packages/schema`
`bun typecheck`, clean. `prettier
--write` on `api/_lib/hosted-ledger.ts` (formatted at HEAD); the other edited files were unformatted at HEAD and only
the added lines were wrapped. Only in CI, as above.

**For the lead.** None in another lane's files.

Edits to `api/_lib/model-plan-*.ts`: `api/_lib/model-plan-account.ts` (`holdPool`'s `final` option and validation,
`currentPoolCredential` holding the usual path unchanged, `finalPoolCredential`).

**H1a's CI receipts (recorded by Codium finish H1b, 15 Nov 2026)**

For `ae7280f8` (this section's commit), read from the runs' jobs and logs:

- Vector Codium run 43746787694 (18 jobs): every job passed or was skipped by `services_only` (Hosted services'
  typecheck and Hosted tests) except Codium tests job 132911745874, which failed only at "Run HttpApi exerciser gates"
  with `summary pass=359 fail=0 skip=0 missing=4 extra=0` and exactly the four review-memory lines (`MISS DELETE
  /experimental/review-memory/previews/{previewId}`, `MISS GET /experimental/review-memory`, `MISS POST
  /experimental/review-memory/confirm`, `MISS POST /experimental/review-memory/prepare`). Its "Run the Codium test
  files" and "Check generated client" steps passed, so the run is green under the lane's baseline rule. The per-file
  lines of H1a's test files were not read, so no per-file count is claimed. Hosted services / Cloud computer image
  (Docker) job 132911746168 and Codium browser specs job 132911746084 passed.
- typecheck.yml run 43746790825: success.
- vector-hosted-ci.yml run 43747724868: all 12 jobs passed; Hosted tests job 132914610646 ends "Hosted: 150/150 test
  files passed", and its Cloud computer image (Docker) job 132914610309 passed.

16 Nov 2026 (codium-finish lane, phase review finding PR6). The line numbers in this section are as of `ae7280f8`,
the section's commit. `hosted-sessions.ts` has changed since then. At `bd3cc7ad`:

- `startHostedDownload` is at `:758` (cited as `:682`);
- `launchSession` is at `:641` (cited as `:566`), and its `chargeRetention` call at `:686` (cited as `:611`);
- `requireFilesAllowed` is at `:1295` (cited as `:1210`).

The phase review fixes move them a few lines further. In `hosted-crons.ts`, `reapDownload` is at `:348` (cited as
`:347`) and the waiver's prefix read at `:732` (cited as `:729`). The `hosted-ledger.ts`, `hosted-entitlement.ts` and
`hosted-api.ts` lines still match. Use the function names to find the code.

That review also changed three readings; "Codium finish: phase review fixes, codium-finish lane (16 Nov 2026)" records
them:

- R3's retention is now held and settled at its hold (M2, PR9);
- R11's "none is given after it" now also holds after the nightly pass (PR2);
- R13, new there, covers computers above a live plan's cap (PR1).

16 Nov 2026 (codium-finish lane, phase review round three). Two of this section's readings changed; "Codium finish:
phase review fixes, round three, codium-finish lane (16 Nov 2026)" records them:

- R3: the retention is charged once per computer and kept window, not once per computer and period. Its ref is now
  `hr-<computer>-<due>`, where `due` is the disk's deletion date (`hosted:disk-due`), not
  `hr-<computer>-<subscription>-<start>`. A second start in the same window after a renewal, or after an ended plan
  came back on a plan without a computer, no longer charges another `ENDED_DISK_DAYS` (PR18, R18).
- `HOSTED_DOWNLOAD_UNAVAILABLE` answers 409 for a start or a request that cannot be served and 410 for packed files
  that are gone, on the person's request (`requestDownload`) and on the download link (`downloadRedirect`) alike. This
  is A53's reading ("410 once the files are gone"); `Hosted.ERROR_CODES` keeps 409 and its comment now names both
  (PR17, R20).

## Codium finish: H1 computer (15 Nov 2026)

Package H1b, the computer half of H1 (the section above is the server half): hostd reads H1a's `mode: "download"`
and, in such a session, starts nothing a job runs and only packs and uploads the computer's disk. Built on
`codium-finish` `ae7280f8` (H1a; equal to origin/codium-finish; PR #33 unmerged: origin/main `58f85edc`,
origin/release-finish `cf2373c4`). Scratch under `/tmp/vector-v2/codium/h1b/`. Not committed by this build step; CI ids
follow in a dated line.

**What landed**

- `packages/hosted-computer/src/daemon.ts`:
  - The header (`:22-28`) describes the download-only session.
  - `downloadOnly` (`:98-99`) is set in `apply` (`:268`) by an answer with `mode: "download"` while no job has started
    (`!this.booted`), and is never unset.
  - `apply` writes no viewer state while download-only (`:269-273`). A `stopping` or `ended` answer still finishes the
    session first. A download-only session then goes to `download` (`:276`), and nothing below runs: the browser,
    recording, the job's start, a take-over, wrap-up and the job path's files.
  - `packWhenAsked` (`:348`) is the job path's pack block, moved; it now takes whether the answer asked (`answer.pack`)
    instead of the answer. The job path calls it at `:324`, `download` at `:379` and `:381`.
  - `download` (`:373`) does nothing once finishing. Until the upload went through it packs when asked and uploads to
    the answer's link when a copy exists. After a successful PUT it drops the copy (`discard`), then sets `uploaded` and
    reports at once. `archive` keeps the dropped copy's entry, so every later report carries `archiveBytes` and
    `uploaded: true`. After that only a `pack` or `upload` answered to a beat that said `uploaded` does anything: it
    packs the disk again and uploads the new size to the next link (review round, F1).
  - `tick` hands the report it sent to `apply` (`:250-252`), so `download` can tell which beat an answer answers. No new
    export and no public signature change. `DaemonDeps` and the controls are unchanged, and so are `finish`, `report`,
    `status` and `acting`.
- `packages/hosted-computer/src/hostd.ts:54-57`: header documentation only. Every spawn (`Agent.start`,
  `Browser.start` and its guard, the recorder, `writeViewerState`) is reached only through the daemon. `packWork`
  (`:339`) and `api.upload` are reused as they are.
- Tests: `test/daemon.test.ts` "download-only sessions (H1b)" (8 cases) and four more assertions on the existing
  job-session case "asked for the files, hostd packs them…"; `test/hostd.test.ts` one case in "the agent's socket"
  with a real `Daemon`.
- Not changed: `api/_lib/hosted-sessions.ts` (R4), the schema (H1a's `mode` is enough), `image/boot.sh`,
  `image/boot-lib.sh`, the Dockerfile, `nftables.conf`, `viewer-proxy.ts` and every workflow. No new setting, flag,
  credential, environment variable or host. S7 holds: `agentEnv` and the firewall are untouched, and the only link is
  the existing presigned PUT.

**Readings**

- **R1, where the mode comes from: the heartbeat answers only.** boot.sh passes exactly `--run-host <host> --session
  <id>` and `parseArgs` refuses anything else (`hostd.ts:65`). hostd starts nothing before its first answer: `main`
  makes the socket, then ticks. So the task's "start or heartbeat answer" is read as the first answer that says so.
  boot.sh still starts the display, VNC and the viewer proxy before hostd (`boot.sh:71-74`), since the mode is not known
  at boot. In a download session hostd never writes `VIEWER_STATE`. `/run/vector` is a fresh tmpfs every boot
  (`boot-lib.sh:75`), and with no state file the proxy closes every connection with "token refused"
  (`viewer-proxy.ts:155`, `:258`). The server mints no viewer token for a download session either (H1a, `issueViewer`).
- **R2, when a session is download-only.** From the first answer with `mode: "download"` before any job started, for the
  rest of the session. The mode then wins over a job, `browser: true`, a take-over or wrapping in the same or a later
  answer, and an answer without the mode does not undo it. A session whose job already started stays a job session, so
  a later download answer cannot leave a running agent without its pause, wrap-up and browser controls. The server
  makes both cases unreachable, because `mode` is fixed when the record is made.
- **R3, how a download session ends (the critique's major point, taken).** hostd never reports `done` from the files
  path. After a successful PUT it drops its copy and keeps reporting `uploaded: true` with `archiveBytes` on every beat,
  and it packs or uploads nothing more unless an answer to such a beat asks for the files again (review round, F1).
  While `beat.uploaded` is set and `readyAt` is not, the server HEADs the object
  on each beat against the kept size (`hosted-sessions.ts:1521`; the size comes from the previous beat when this one has
  none, `:1497`). So a HEAD that failed or timed out is tried again on the next beat, never taken for acceptance. Once
  it confirms, `readyAt` is set and the reaper ends the session as "finished" (`hosted-crons.ts:361`), which is the
  task's "ends the session as finished". hostd finishes, and then reports `done`, only on `stopping`, `ended` or a FINAL
  refusal.
  - Rejected, the plan's version (report `done` once the server stopped asking). On a download session the server's
    "no pack, no upload" answer means either accepted or a failed HEAD, and `done` ends the session "finished" on the
    same reaper line with no files and a block paid for nothing. On success, `done` adds nothing to `readyAt`.
  - Dropping the copy right after the PUT keeps up to 5 GiB off the system disk (`/var/lib/vector/pack`, which boot.sh
    also removes on every boot, `boot.sh:68`). The review round weighed keeping it instead (F1): the reaper stops the
    computer as soon as the upload is confirmed (`endHostedSession` calls `stopHostedComputer`), usually before hostd
    sees `ended`, so a copy kept until `finish()` would stay in nearly every saved disk.
- **R4, the image-generation check is not added; H1a already covers "must not start the agent".**
  - (a) In every hostd since A54 only `answer.job` starts the agent, and the browser and recorder start only after it
    (`daemon.ts:286-293`). H1a never sends a download session a job, a browser or hook data. `startHostedDownload`
    writes no job key, the job read is skipped for download (`hosted-sessions.ts:1508`), `browser` is false (`:1461`)
    and the hooks are skipped (`:1571`). H1a's `test/hosted-sessions-api.test.ts:691` pins this, including a beat that
    says booted (`:723-724`). So no hostd, old or new, starts the agent for a download session. The daemon case
    "answers without a mode or a job start nothing of the agent, even when they ask for the files" pins the daemon's
    side. It runs H1b's daemon on mode-less answers, so it covers the shared path, not an old build.
  - (b) There is no per-computer generation record to check. The generation lives only in the session's beat
    (`hosted-sessions.ts:1498`), which expires with the session. The first generation with this mode is not known
    either: the owner picks `generation` when building the image, and no image has been built.
  - (c) Refusing would strand an ended plan's files until its disk is deleted, against §4.4.
  - (d) Corrected after the critique: H1b reaches only computers whose disk is made from an image built after H1b. A
    resumed computer restores its whole saved disk, `/opt/vector` included, so a newer image reaches a computer that
    already has a disk only when its disk is made again ("A54 Image and hostd", "Reinstalls verified system
    components"). Download-only sessions run on ended plans' existing disks, so each runs the hostd its disk was made
    with. A signed hostd from before H1b completes a download without starting anything of a job. It writes the viewer
    state, but no token is ever issued, and it drops its copy once the server stops asking, so one failed HEAD loses
    that session's files (O1). A disk made before signed heartbeats cannot complete one: `requireDaemonBeat` refuses
    every beat (`hosted-sessions.ts:1412`), hostd takes the 403 as FINAL and finishes, and the session ends at its
    block's end or on a lost heartbeat with no files, after H1a charged the block and the retention. That fails closed
    (no agent) but charges the person. Open, server side or owner (`owner-actions/hosted-computer.md`, the H1b bullet):
    should a download start be refused, or left unpaid, when the computer's last reported generation is unknown or
    below the signed-beat floor? Not fixed here.
  - For later packages (H2a): the image floor (`VECTOR_HOSTED_MIN_GENERATION`, not built) must exempt download-only
    starts, or a disk below it can never be downloaded. Any per-computer generation record it adds is what a download
    check would read.
- **R5, `finish()` stays shared.** Its uid-10001 kill sweep with its 3-second grace, the wipe of an empty browser
  profile and the skipped recording flush are harmless in a download session.
- **R6, failures.** A failed pack is tried again on the next answer that asks for one, since the server keeps asking
  while it has no size. A failed upload is tried again with the next link: the next beat reports the size without
  `uploaded`, so the server signs another. The session's one block bounds both. Pinned by "a failed pack is tried again
  when asked again, and a failed upload with the next link".
- **R7, H1a's R12 (whether the provider still has the disk before the hold): declined here.** The task limits H1b's
  edits to `api/_lib/hosted-sessions.ts` to the generation check, and a `provider.list` read before the hold is server
  work. It is left to the owner or a later server package.

**Critique points taken and rejected**

- Taken (major): R3 as above. hostd never reports `done` from the files path, keeps `uploaded`, and drops the copy after
  the PUT. The first case was rewritten, the retry case added and the mutations adjusted.
- Taken (major): R4(d), the reach of a rebuilt image and the disks from before signed beats, here and in the a53, a54,
  MODEL-PLANS and owner-actions lines.
- Taken: H2a phrased as a requirement handed on, not an existing rule; R12 declined explicitly (R7); the oversized pack
  recorded (O2); the mode-less case renamed and cited for the shared path only; the hostd case kept short (a real
  `Daemon` driving `createAgentApi`: 409 on git, status not booted, nothing started); no return types on the new
  methods.
- Partly taken: the critique suggested keeping the job path inline. It stays inline except the pack block, which both
  paths now call (`packWhenAsked`, moved), so the pack logic is not written twice. The extended job-session case
  pins the job path's own files behaviour: no `done`, still acting, and once the copy is dropped, no `uploaded` or
  `archiveBytes`.

**Review round (15 Nov 2026)**

Five non-blocking findings. Each was read against the code; "taken" names its regression test.

- F1 (`daemon.ts`: the copy dropped at once, `uploaded` never re-uploaded): confirmed, taken in part. With today's
  server a HEAD that never confirms strands the session for its block (O4), and nothing on the computer alone can fix
  that: while hostd reports `uploaded` the server never signs another link. Taken: a `pack` or `upload` answered to a
  beat that said `uploaded` is read as a rejection, and hostd packs the disk again and uploads anew. Nothing writes
  `/data/work` in a download session, so the new pack holds the same files. An answer to a beat from before the upload
  went through is stale and changes nothing. That is why `tick` now hands `apply` the report it sent. Without it, a
  30-second beat sent during the PUT could come back with a link after the PUT finished and start a second upload of up
  to 5 GiB. The copy is now dropped before `uploaded` is set, so a new pack never races the old copy's discard. Not
  taken: keeping the copy until `finish()`, for the reason under R3. Also handed on, as O4: the server-side rejection.
  The reviewer's aside that the job path recovers is not confirmed. After the job path drops its copy the server's kept
  size stays (`hosted-sessions.ts:1497`), so it answers `upload`, not `pack`, and the job path cannot use it (O1).
  Tests: "asked for the files again after a beat that said uploaded, it packs again and uploads anew" and "a
  request for the files answered to a beat from before the upload went through changes nothing". The first case now
  ends on the answer today's server gives while it has not confirmed the upload.
- F2 (`daemon.test.ts`: the mode-less case is not old-image coverage): confirmed, taken. The case's comment now says it
  runs H1b's daemon and cites `test/hosted-sessions-api.test.ts:691` as the guarantee for older images. Comment only.
- F3 (the charged download on a disk from before signed heartbeats is tracked only as an owner choice): confirmed,
  taken in the records. The owner bullet stays. A dated "Not done" line is added in
  `codium-a53-hosted-sessions-notes.md`, and a row in "Lane status (8 Nov 2026)", handing the fix to a later server
  package. Partly disagreed: the finding's
  two fixes (no charge until the first accepted heartbeat, or releasing the hold) would leave the minutes the computer
  ran unpaid, and M8 charges every hosted minute at no less than cost. The row hands on what fits M8: hold the block
  as now, charge only the minutes that ran, and charge the retention only after the first accepted heartbeat. O6. No
  code change.
- F4 (O2: a pack over 5 GiB is attempted on every beat): confirmed, not changed, as the finding recommends. Skipping
  later attempts needs `packWork`'s rejection to carry a size marker across the hostd and daemon boundary. `packWork`
  runs `setpriv` and `tar` as the agent user, so no local test reaches that marker. The person's outcome stays the same
  (no files, one block), and `reapDownload` applies no fair-use check to a download session (`hosted-crons.ts:345`), so
  the repeated packs cannot put the computer on hold. The "too large" report in O2 is the fix.
- F5 (`hostd.test.ts`: the socket case writes a full `DaemonDeps`): confirmed, not changed. The literal goes straight
  into `new Daemon(...)`, so the typecheck fails it as soon as `DaemonDeps` changes, and it cannot drift silently.
  Moving `world()` into a shared helper would rewrite `daemon.test.ts`'s harness in a fix round for style alone.

**Observations (not changed)**

- O1, an A53 server gap, now narrower. After an `uploaded` beat, a job session's hostd (and a pre-H1b hostd on a
  download session) drops its copy as soon as the server answers neither pack nor upload, and a failed HEAD answers the
  same (`hosted-sessions.ts:1521`). The server then keeps signing links hostd cannot use, because the kept size stays
  and `beat.uploaded` is gone. H1b's download path no longer depends on that answer (R3). For job sessions the fix
  (answer `upload` again, or an explicit acceptance in the answer) is server and schema work outside H1b's files.
- O2, a work folder over 5 GiB. `packWork` refuses it (`hostd.ts:339`), so no size is reported, and the server keeps
  answering `pack` (`hosted-sessions.ts:1556`). hostd then packs again on every answer until the block ends, and a
  download-only session pays its block with nothing to download. No schema field says "too large". A later package
  should let hostd report it, so the server can end the session early and say why. The review round left the daemon
  as it is (F4).
- O3, a download session's socket. The agent's socket stays up with no agent behind it. `acting()` is false, so git is
  refused (409) and computer actions answer that the computer is paused (`computer.ts:103`).
- O4, a check that never confirms (review round, F1). While a beat says `uploaded`, today's server only HEADs the
  object (`hosted-sessions.ts:1521`) and never asks for the files again. If the object is missing despite the PUT's 2xx,
  or its `content-length` differs from the kept size, every later HEAD fails the same way. The download session then
  runs to the end of its block, and the person pays for the block and the retention with no files. H1b's hostd is
  ready for a server-only fix: a `pack` or `upload` answered to a beat that said `uploaded` makes it pack the disk again
  and report the new size without `uploaded`, so the next link is signed for that size. Handed to a later server and
  schema package: answer a definitive rejection (HEAD 404, or a length other than `archiveBytes`) with `pack` or
  `upload`, or add an explicit acceptance or rejection field to the heartbeat answer. A timed-out or failed HEAD should
  stay a retry. No image rebuild is needed for hostds built with H1b.
- O5, a lost early beat (seen while writing the review round's tests; not changed). `tick()` called after a beat's loop
  has ended but before its `finally` clears `ticking` only sets `again`, which nothing reads any more. The beat it asked
  for then goes out with the next 30-second beat instead of at once. That delays reporting and loses nothing. It is
  older than H1b, so the test fake only awaits a hook that returns a promise, and every older case keeps its timing.
- O6, the charged download that cannot run (review round, F3): R4(d) above. It is now tracked as a defect in the lane
  status ("Lane status (8 Nov 2026)", the 15 Nov H1b row) and in `codium-a53-hosted-sessions-notes.md` ("Not done").

**Not built**

- Client surfaces (H1c) and the 14-day notice (H1a's "Not built").
- The image rebuild: an owner step (`owner-actions/hosted-computer.md`, the "Download-only starts (H1a)" list).

**Unverified on a real computer.** Real-microVM behaviour is unverified until three things happen: the owner rebuilds
the image (A58's image workflow), runs `vector-codium-e2e.yml` with `hosted: true`, and a computer's disk is made from
that image (R4(d)). That covers the firewall on the provider's kernel, the real viewer proxy refusing a download
session's connections, and `packWork` and the PUT against the real bucket.

**Ran locally** (through `vector-serial`, one file at a time from `packages/hosted-computer` with `--timeout 30000`,
after the last code edit):
- `test/daemon.test.ts` 17/0 (9 at HEAD, 8 new) and `test/hostd.test.ts` 17/0 (16 at HEAD, 1 new), re-run after the
  review round.
- Regressions: `test/recording.test.ts` 7/0 (it drives `Daemon`), `test/source.test.ts` 3/0, and `test/image.test.ts`
  21 pass, 3 skip (Docker, CI).
- `bun typecheck` in `packages/hosted-computer` (`tsgo --noEmit`, src and tests): clean.
- `bun run build`, then `node --check` on `dist/hostd.mjs` and `dist/viewer-proxy.mjs`, and importing `dist/hostd.mjs`
  under Node (`main` does not run on import): pass.
- Mutations, each restored afterwards (re-run on the review round's code):
  - writing the viewer state in download mode fails 3 cases;
  - dropping the download early return fails 4 (the agent starts) and the hostd socket case;
  - dropping the `finishing` guard fails the refusal case;
  - the latch without `!this.booted` fails the job-session case;
  - not setting `uploaded` after the PUT fails 4;
  - dropping the size with the copy fails 4;
  - packing before the `finishing` check fails the refusal case;
  - review round: dropping the stale check (`!report.uploaded`) fails the stale-answer case; ignoring a request after
    `uploaded`, or packing again without clearing the dropped copy's entry, fails the re-pack case. The order of
    `discard` before `uploaded` is defensive and no case pins it: the race it closes needs a server that rejects.
- No other package was touched, so no other package typecheck ran. The full-tree typecheck and the api tree run before
  the push.
- Added lines are kept to 120 characters. No `prettier --write`: the edited files were not prettier-clean at HEAD.

**Only in CI.**
- The Docker image job, which builds the bundle with this daemon and boots the image: "Hosted services / Cloud computer
  image (Docker)" in Vector Codium and "Cloud computer image (Docker)" in vector-hosted-ci.yml.
- vector-hosted-ci.yml's Hosted tests, which run every `packages/hosted-computer` test file.
- The typecheck matrix.

Dispatches after the lead's commit, in order: Vector Codium on `codium-finish` with `base: "origin/release-finish"`,
then typecheck.yml, then vector-hosted-ci.yml once the Vector Codium run has finished.

**For the lead.** None in another lane's files. Records also touched: `codium-a53-hosted-sessions-notes.md`,
`codium-a54-hosted-image-notes.md`, `codium-p8-repairs.md`, `docs/vector/MODEL-PLANS.md` and
`docs/vector/owner-actions/hosted-computer.md`.

Edits to `api/_lib/model-plan-*.ts`: none.

**H1b's CI receipts (recorded by Codium finish H1c, 15 Nov 2026)**

For `539cddf5` (this section's commit), read from the runs' jobs and logs:

- Vector Codium run 43752968478 (18 jobs): every job passed or was skipped by `services_only` (Hosted services'
  typecheck and Hosted tests) except Codium tests job 132930785610, which failed only at "Run HttpApi exerciser gates"
  with `summary pass=359 fail=0 skip=0 missing=4 extra=0` and exactly the four review-memory lines (`MISS DELETE
  /experimental/review-memory/previews/{previewId}`, `MISS GET /experimental/review-memory`, `MISS POST
  /experimental/review-memory/confirm`, `MISS POST /experimental/review-memory/prepare`). Its "Run the Codium test
  files" and "Check generated client" steps passed, so the run is green under the lane's baseline rule. No per-file
  count is claimed. Hosted services / Cloud computer image (Docker) job 132930785857 and Codium browser specs job
  132930785921 passed.
- typecheck.yml run 43752971608: success.
- vector-hosted-ci.yml run 43753689797: all 12 jobs passed; Hosted tests job 132933033151 ends "Hosted: 150/150 test
  files passed", and its Cloud computer image (Docker) job 132933033157 passed.

## Codium finish: H1 clients (15 Nov 2026)

Package H1c, the client half of H1 (H1a is the server's start, H1b the computer's side). For an account whose plan
ended, or no longer includes a cloud computer, while its computers' disks are kept for download (§4.4,
`codium-build-spec.md:354`), the desktop's bar above the composer and the phone's Cloud computer page offer "Download
your files" with the days left, start H1a's download-only session after a confirmation, show its progress as a live
session, and then hand over the usual download link. Built on `codium-finish` `539cddf5` (H1b; equal to
origin/codium-finish; PR #33 unmerged: origin/main `58f85edc`, origin/release-finish `cf2373c4`). Scratch under
`/tmp/vector-v2/codium/h1c/`. Not committed by this build step, so no CI has run on it; the dispatches follow the
lead's commit.

**What landed**

- Server, read-only (`api/_lib/hosted-sessions.ts`): `hostedStatus` (`:1598`) reads `listHostedSessions` once
  (`:1610`) and adds `kept` from the new `keptDisks` (`:1651`). `kept` is sent only while all of these hold: the hosted
  configuration;
  the plan's download answer (`hostedDownloadAccess`) is not `live`, `frozen` or `closing`, and the plan did not end
  after a lost dispute (the same rule as `requireFilesAllowed`); the media bucket is set; the deletion date is ahead;
  the account has a computer; and either a download-only start could go ahead or some session has packed files. Its
  `state` is `open` when a start could go ahead (the start's own gates in `startHostedDownload`'s order: configured,
  `hostedOpen`, the switch on, no hold, then the plan's `final` or `current` answer), `late` when it could but less than
  `DOWNLOAD_START_MARGIN_MS` (`:120`, the start's old inline sum, now shared) is left, and `closed` otherwise. Each
  computer comes with its preferred session: the live download-only session, else the newest session (job sessions
  included) whose files are packed, else the newest download-only session; files packed before a later job session
  started on that computer never count (review fix F1). `knownComputers` (`:771`) is the
  `hosted:computers` read, now shared by `startHostedDownload`, `hostedComputers` and `keptDisks` with the same filter
  (1 to `MAX_COMPUTERS`). No new route, store key, setting, error message, flag or amount.
- Schema (`packages/schema/src/hosted.ts:238`): `Hosted.KeptDisks` `{state: "open" | "late" | "closed", until, disks:
  [{computer, session?}]}`, the return type of `keptDisks`.
- Shared app code. `hosted-requests.ts`: `{kind: "download-start", computer}` → `POST /api/hosted/sessions {mode:
  "download", computer}` (`:120`), computer 1 to `LIMITS.computers` (`:51`, 3). `hosted-model.ts`: `customer` on the
  status shape; `mode` kept on a session only for `"download"`, and such a session never gets `handoff`;
  `decodeKept` (`:261`, lenient); `keptCandidate` (`:109`); `keptView` (`:307`), `keptLine` (`:331`), `keptNote`
  (`:337`), `keptLabels` (`:345`) and `linkLine` (`:354`); download-aware `stateLabel` (`downloadStateLabel`, `:404`),
  `reasonLine` (`:433`), `sessionLine` (`:446`) and `sessionControls` (`:452`: no Watch, Take over or control; Stop as
  any session; Files once `readyAt` is set); the copy constants `KEPT_TITLE` (`:33`) to `DOWNLOAD_STARTED`.
  `context/platform.tsx`: the files answer's `expiresAt`.
- Desktop. `packages/desktop/src/main/hosted-client.ts`: `files()` returns the link's `expiresAt` (`:141`); the header
  (`:29`) says the start is one of `request`'s shapes with the account token. No IPC, preload or window change.
  `hosted-composer.tsx`: the status is read with a mode per composer (`"computer"` or `"kept"`), every 10 minutes
  (`KEPT_POLL_MS`, `:78`) when only the offer is read, 15 seconds while any session is live, 60 seconds otherwise; a
  plan that changes while the app is open is read again at once (`on(mode, …)`, `:147`). `useHostedComputer` adds
  `candidate` (`:131`) and `kept`; `HostedRunButton` still follows `shown()` only. `HostedBar` shows its live rows for
  either mode, and a quiet offer block (`data-component="hosted-kept"`, `:360`) with the line, the note, each
  computer's ended reason, "Open the download" for packed files, the start behind a confirmation
  (`startDownload`, `:268`) and "Not now". `hosted.css`: `.hosted-bar--quiet` (`:226`).
- Phone. `status.ts`: `customer` and `kept` on `PhoneStatus`; the computer route shows with `kept` (`:110`) and its
  summary says "Your cloud computer's files, kept for download." (`:128`). `api.ts`: `readPhoneStatus` (`:56`) asks
  `/api/hosted/status` only for a `keptCandidate` and keeps the last read's `kept` when that request fails.
  `app.tsx:198`: passes the last status in. `routes/computer.tsx`: `included` (`:79`) gates the plan lines, the alerts
  offer and the "Nothing runs" text; a kept-only page shows only the on-hold line (when no offer card shows, since the
  card says the hold itself), the offer card (`data-component="phone-kept"`, `:325`) with the same buttons and
  confirmation (`startDownload`, `:156`), and "Your cloud computer's files are not kept for download now." (`:236`)
  once the offer is gone and the status read succeeded; the files link line is the link's own end, or "The download
  link is ready." when the answer has no `expiresAt`.
- Tests (below). Not changed: every route, the provider, the image, the workflows and the generators (no engine route,
  SDK input or config schema change).

**Readings**

- **R1, where the offer comes from: the server's `kept`.** Only the server knows the plan's download answer, the
  deletion date, `hostedOpen` (the allowlist) and the margin, and `BLOCK_MINUTES` lives in `hosted-rates.ts`, which no
  client may import. Rejected: building it from `/api/hosted/computers`' `disksDeletedAt`, which would offer refunded,
  frozen and lost-dispute disks that are always refused.
- **D1 (a deviation from the package text, for the lead), who sees it.** The package says nothing shows "unless the
  account may see the computer (computer listed, or VECTOR_HOSTED_ALLOW_ACCOUNTS on the server, as H1 and the existing
  gating decide)". The clients ask about kept disks only for `keptCandidate` (`computer` listed, a customer, the plan
  without the computer), so an allowlisted account before listing sees nothing in the clients, though H1a's route lets
  it start. That follows H1 (spec §3, "A perk shows only when listed") and A56's own gating (`computerShown`: every A56
  surface needs `computer` listed; `VECTOR_HOSTED_ALLOW_ACCOUNTS` never reaches a client). Rejected: reading the hosted
  status for every customer without the hosted entitlement before listing. Its cost: a hosted read every 10 minutes
  from every such desktop and on every phone status read, for a perk nobody may see yet, and a surface of an unlisted
  perk for the allowlisted few. Both readings stay possible: the server's `kept` already checks `hostedOpen`, so
  showing it to allowlisted accounts would be a client-only change to `keptCandidate` (and a way for the client to
  know the account is allowlisted, which no answer carries today). The owner can still try the route before listing
  (`owner-actions/hosted-computer.md` step 4); the screens need the listing. owner-actions line 299 ("or for
  `VECTOR_HOSTED_ALLOW_ACCOUNTS`") was already wrong for every A56 surface; a dated correction line now follows it.
- **D2 (a deviation from the lane rule, for the lead), a hosted API field added outside H1a.** The lane rule for H1 is
  that only H1a adds a hosted API field. H1c adds one: `kept` on `GET /api/hosted/status` (`hostedStatus`,
  `api/_lib/hosted-sessions.ts:1598`; `keptDisks`, `:1651`), with the new exported type `Hosted.KeptDisks`
  (`packages/schema/src/hosted.ts:238`). The reason is R1's: only the server knows the plan's download answer
  (`hostedDownloadAccess`), `hostedOpen` (the owner's allowlist), the start margin and `BLOCK_MINUTES`, which lives in
  the rates file (`hosted-rates.ts`) that no client may import, so a client cannot work out the offer on its own.
  Rejected: building the offer in the clients from `/api/hosted/computers`' `disksDeletedAt` plus the server's
  refusals, which would offer refunded, frozen and lost-dispute disks that are always refused, and would show a start
  that the allowlist, the switch, a hold or the margin then refuses. `kept` is read-only: no new route, store key,
  setting, error code or amount, and it is a vectordev.ai route, not an engine `HttpApi` change, so no generator run
  is needed (`bun run generate`, the legacy SDK build). The lead accepts the field here or sends it back to H1a; either
  way the clients' decoder (`decodeKept`) stays as it is.
- **R2, the three states (critique, major).** "May start" and "has packed files" are split: `requestDownload` gives a
  link with the switch at `no-new`, off the allowlist, during a hold and for a refunded plan, so `kept` is still sent
  then, `closed`, carrying the packed session, and the clients offer only "Open the download". The clients also offer
  no start unless `kept` is `open`, the status says `available`, and there is no hold. The status does not read the
  account's deletion tombstone (O2).
- **R3, cadence.** 10 minutes while the offer is the only reason to read, 15 seconds while a session is live (the
  download's progress), 60 seconds for a plan with the computer, as before. Once `computer` is listed, every customer
  without the computer reads the hosted status every 10 minutes while the app is open (the route allows 600 an hour).
- **R4, days.** Whole days left until the account's one deletion date, rounded down: "Kept for download for N more
  days, then deleted.", "1 more day", "less than a day". A count of days only, never an amount.
- **R5, the link's end.** The files notice now gives the link's own `expiresAt` ("Its link works until …") instead of
  "24 hours", for job sessions too, since H1a caps every link at the deletion date.
- **R6, the phone starts download-only sessions.** A56's "the phone does not start jobs" was about the pre-start
  ceiling, which needs an account token. A download-only start runs no job, so there is no job length or size to
  estimate, and a refusal for the money is H1a's 402 with no amount.
- **R7, a confirmation before the start (critique, major).** One tap would start the computer and spend a block. Both
  clients now use the bar's existing two-step pattern: the first button asks, the confirmed one ("Start the computer")
  sends. The line shown while confirming is "Vector starts the computer once to pack its files for download.": it
  names no payer and no amount, because who pays the block is still the owner's question (H1a R2), so either answer
  stays possible.
- **R8, Stop.** A download session shows Stop; the minutes it ran stay charged (M8).
- **R9, "Pack them again" and packed job files (critique, minor).** A computer whose files are packed offers "Open the
  download" and the start labelled "Pack them again" (the bucket's own rule can remove packed files early, H1a R11; the
  link then answers 410 in the server's words). A job session's packed files count as the computer's files, since they
  are a copy of the same disk (H1a R11); the newest packed session wins, so a later download's packed files replace a
  job's. Files packed before a later job session started on that computer are out of date, since that job may have
  changed the disk, so they are not offered at all and the computer gets only a new start (review fix F1). A
  download-only session leaves the disk as it was, so a later one that ended without files does not hide them. Not
  handled: a job session that packed its files and then kept running; its own pack still counts (H1a R11's reading).
- **R10, ended reasons.** A download session's ended line follows its files, not only its reason: "Your files are
  ready." with `readyAt`; "The computer stopped before its files were ready." for `finished` without it (the reaper also
  ends one `finished` on the daemon's `done`, `hosted-crons.ts`); "The computer could not get the files ready in time."
  for `deadline`; otherwise A56's lines.
- **R11, the notice.** The offer's line is the desktop and phone part of §4.4's "(notice)". The email notice is not
  built.
- **R12, Vector Local.** The desktop's status read and start go through `Egress.fetch("cloud-computer")`, so Vector
  Local answers LOCAL_OFF and nothing is sent (tested). The phone is a website and has no Vector Local.
- **R13, the phone's second read (critique, minor).** The route's visibility now depends on the hosted status. A failed
  hosted read keeps what the last status read said, so a page does not turn into "This isn't part of what your plan
  shows" in the middle of a download; an answer without `kept` drops it. It keeps the last answer through any number
  of failures, not just one: the server decides every start and link anyway, and the page shows the hosted error.
- **R14, the offer's look (critique, minor).** The offer is not something the computer is doing, so it uses a quiet
  variant (`.hosted-bar--quiet`: grey edge, no purple ring). "Not now" hides it in that window until the deletion date
  changes or the app restarts; it is not persisted, so the offer comes back before the files are deleted.
- **R15, new strings** (no amount, price, token or credit figure, no GitHub or Actions, no time promise): "Your cloud
  computer's files"; "Download your files"; "Getting your cloud computer's files ready"; "Vector starts the computer
  once to pack its files for download."; "Vector is starting the computer to get its files ready."; "Kept for download
  for N more days, then deleted." (and its two variants); "Too little time is left to get them ready before they are
  deleted."; "Getting them ready again is not available right now."; "Pack them again"; "Open the download"; "Download
  computer N's files", "Pack computer N's files again", "Open computer N's download"; "Packing and uploading the
  files"; "Your files are ready" (and "."); "The computer stopped before its files were ready."; "The computer could not
  get the files ready in time."; "Its link works until …"; "Start the computer", "Not now", "Cancel"; on the phone "Your
  cloud computer's files, kept for download." and "Your cloud computer's files are not kept for download now."

**Critique points taken and rejected**

- Taken (major): may start vs packed files (R2), with server cases for `no-new`, the allowlist removed, a hold and a
  refunded plan, a model case for a hold and unavailability, and mutations.
- Taken (major): the confirmation (R7), with a source check in `test/hosted-clients.test.ts` that each screen sends
  `download-start` only from the confirmed branch.
- Taken (major): the bundle walk. `packages/app/src/phone/phone.test.ts` is unchanged on this branch, so the Codium
  picker does not select it and its bundle walk runs in no CI here; the walk was run by hand (below), as A56 did.
- Taken (major): D1 is recorded as a deviation and for the lead, with H1 cited, the rejected alternative and its cost,
  and a dated correction line under owner-actions line 299.
- Taken (minor): packed job files (R9); ended copy from `readyAt` (R10); `LIMITS.computers === MAX_COMPUTERS` asserted
  in `test/hosted-clients.test.ts`; `hosted-jobs.test.ts` and `security-policy.test.ts` added to the regressions, and
  the H1a describe "download-only starts for an ended plan's kept disk (H1a)" in `test/hosted-sessions-api.test.ts` is
  the regression for the `knownComputers` swap (it passes); the phone's on-hold line and the failed second read (R13);
  the quiet variant and "Not now" (R14); the schema type used as `keptDisks`'s return type and the array named `disks`.
- Partly taken (minor): the CI receipts. This build step may not commit, so nothing can be dispatched from it. H1c is
  not done until the lead's commit has a green Vector Codium run (with `base: "origin/release-finish"`), a green
  typecheck.yml run and, after the Vector Codium run finished, a green vector-hosted-ci.yml run; the package that pushes
  next records them here, as H1c recorded H1b's.

**Review fixes (15 Nov 2026)**

The H1c review's findings, each read against the code before it was changed. Still not committed.

- F1 (non-blocking, confirmed, fixed): `keptDisks` (`api/_lib/hosted-sessions.ts:1666`) took the newest packed
  session on a computer even when a later job session had run there, so both apps offered "Open the download" for
  files older than the disk. Now files packed before the computer's newest job session started are left out (R9);
  download-only sessions do not count as changing the disk, so the existing "a newer download that ended without
  files does not hide the packed ones" case still holds. Regression: the "each computer's session" case in
  `test/hosted-sessions-api.test.ts` gains a packed job session followed by a later unpacked job session, which must
  offer only a new start (`disks: [{ computer: 1 }]`); with the filter removed that case fails.
- F2 (non-blocking, confirmed, fixed): on a kept-only phone page a failed hosted status read showed the error and also
  "Your cloud computer's files are not kept for download now.", which the client cannot know. That text now shows
  only when the read succeeded (`routes/computer.tsx:235`). No runnable regression: JSX, and no Playwright locally;
  checked by the app typecheck.
- F3 (non-blocking, confirmed, fixed): on a kept-only phone page for an account on hold the hold sentence showed twice,
  as the access line and as the card's note. The access line now shows only when no offer card shows
  (`routes/computer.tsx:205`), so the hold still reaches a person whose card is hidden. No runnable regression (JSX).
- F4 (non-blocking, confirmed, fixed): `readShared` shares a read already in flight, so `act`'s refresh after a start
  could answer the status from before the start, and `schedule()` would then pick the 10-minute cadence. `refresh`
  (`hosted-composer.tsx:160`, called only after an action) now waits for any read in flight and then reads again. No
  runnable regression: module-level Solid signals and timers, no component test harness here.
- F5 and F8 (non-blocking, confirmed, fixed; one finding reported at two lines): the `refusal` helper in
  `test/hosted-clients.test.ts:258` typed `body` as `any`. It is now `{ error?: { code?: string; message?: string } }`.
  The file's four refusal cases still pass.
- F6 (non-blocking, confirmed, fixed): `phoneFeatures` chose the kept summary by truthiness of `hosted`, while the
  page's `included()` (`computerShown`) and `keptCandidate` use a record check. It now uses the same record check
  (`status.ts:127`), so the summary always matches what the page shows. `routeShown`'s `entitled("hosted")` is A38's
  and was left as it is: it only decides visibility, and with any value that is not a record the page shows the kept
  view. Regression: `src/phone/status.test.ts` "the computer route shows for an ended plan with kept disks, with its
  own summary" now also checks `hosted: true` with `kept`; with the old check it fails.
- F7 (blocking, confirmed, recorded; no code change): H1c added the hosted API field `kept` and the type
  `Hosted.KeptDisks` against the lane rule that only H1a adds one, and the record did not flag it. Now D2 in the
  readings, the "For the lead" paragraph below and the 15 Nov lane-status bullet all say so.
- F9 (non-blocking, confirmed, left for a later package as the finding itself says): O1 below. The later package must
  keep the check exactly as strict, by replacing session ids with a fixed placeholder before the check or by
  deterministic ids that cannot spell a money word, and must not narrow which fields it covers.
- F10 (non-blocking, confirmed, fixed): line citations in "What landed" corrected to the working tree:
  `hostedStatus` `:1598` (its `listHostedSessions` read `:1610`), `hosted-client.ts` `:141`, `app.tsx:198`, and
  `status.ts` `:110` (the computer case) and `:128` (the summary; the finding's `:125` moved down three lines with
  F6's doc comment). Citations into `hosted-composer.tsx`, `routes/computer.tsx` and `schema/src/hosted.ts` that
  these fixes moved were updated too.
- F11 (non-blocking, confirmed, fixed): the phone's files notice was empty when the answer had no `expiresAt`. It now
  falls back to "The download link is ready." (`routes/computer.tsx:153`), which names no duration. The desktop
  already always says "The download opened in your browser." No runnable regression (JSX); the copy scans in
  `hosted-model.test.ts` and `phone.test.ts` read the new string and pass.

**Observations (not changed)**

- O1, own lane's test helper: `expectNoAmounts` in `test/hosted-sessions-api.test.ts:114` matches its money words
  anywhere in the JSON, random session ids included (a 26-character base32 id can spell `usd` or `cost`). Seen once
  while writing the new status case, whose id is now replaced before the check. The existing A53 and H1a callers keep
  that rare false failure; fixing the helper is left to a later package, since this one must not loosen a test. The
  review confirmed it (F9): the fix must keep the check exactly as strict (fixed placeholders for session ids, or
  deterministic ids that cannot spell the words), never check fewer fields. **Fixed 21 Nov 2026
  (`codium-api-fixes`):** `expectNoAmounts` replaces every `hs_[a-z2-7]{26}` with `hs_session` before the unchanged
  regex, over the same JSON; the ad-hoc replace in the H1c status case is gone. No other random value (run token,
  presigned URL) is in the bodies these callers check.
- O2, the status does not read the account's deletion tombstone, so an account being deleted whose snapshot is not yet
  `closing` may show `open`; the start then refuses with `MODEL_PLAN_ACCOUNT_CLOSING`'s words. **Fixed 21 Nov 2026
  (`codium-api-fixes`):** after its early returns `keptDisks` reads the tombstone (`accountDeleting`) and answers
  undefined when it is set or cannot be read (fail closed: the offer is hidden, the status itself still answers).
  Test "absent for an account being deleted, whose download-only start is refused (O2)": `open` before
  `markAccountDeleting`, no `kept` after, and the start answers 409 `MODEL_PLAN_ACCOUNT_CLOSING`; dropping the read
  fails it. hosted-sessions-api: 60 pass, 1 skip.
- O3, cost: `keptDisks` adds at most two store reads (the deletion date, then the computers) per status read, only for
  accounts whose plan answer is not `live`, `frozen` or `closing`; accounts with no date stop after the first. Since
  21 Nov 2026 (O2's fix) at most three: the tombstone `GET` comes after the date, so only accounts with a disk date
  still ahead pay it.

**Not built**

- The email notice of the 14 days (R11), a browser spec (optional; none added), a Settings page.

**Unverified.** Nobody has seen the bar's offer or the phone's card in a browser or the app (no dev server, no
Playwright locally). A real computer is unverified until the owner rebuilds the image (H1b).

**Ran locally** (through `vector-serial`, one file at a time, `--timeout 30000`, after the last code edit):
- `packages/app` with `--isolate`: `src/features/cloud/hosted/hosted-model.test.ts` 23/0 (14 at HEAD, 9 new in
  "download-only start (H1c)"); `src/features/cloud/hosted/hosted-requests.test.ts` 7/0 (1 new);
  `src/phone/status.test.ts` 14/0 (3 new in "an ended plan's kept disks (H1c)"); regressions
  `src/features/local/local-model.test.ts` 39/0, `src/security-policy.test.ts` 2/0, `src/phone/phone.test.ts
  --test-name-pattern honesty` 1/0 (6 filtered out).
- `packages/desktop` with `bun --no-env-file test`: `src/main/hosted-client.test.ts` 11/0 (1 new, the files case now
  expects `expiresAt`).
- `test/`: `hosted-sessions-api.test.ts` 49 pass, 1 skip (Valkey; 7 new in "the kept disks on the status (H1c)", run
  three times after the id fix); `hosted-clients.test.ts` 12/0 (4 new in "the download-only start from the screens
  (H1c)"); `hosted-copy.test.ts` 6/0 (1 new); regressions `hosted-reaper` 26/0, `hosted-lifecycle` 19/0, `phone-app`
  10 pass 1 skip, `hosted-jobs` 31 pass 1 skip.
- The phone bundle walk by hand: `cd packages/app && bun script/browser-imports.ts src/phone/entry.tsx src/phone/sw.ts`:
  43 modules, `runtime: []` (no Node or Bun module); `hosted-model.ts` and `hosted-requests.ts` are in it.
- Mutations, each restored afterwards: dropping the frozen and closing gate in `keptDisks` fails "packed files are
  never offered where §4.4 gives no download"; dropping the lost-dispute gate fails the same case; dropping the margin
  fails the late case; dropping `hostedOpen` from the start's gates fails the `no-new`/allowlist/hold case; sending
  `kept` only when a start may go ahead fails that case too; dropping `customer` from `keptCandidate`, offering a start
  on a busy computer, ignoring the hold and availability in `keptView`, and reading `finished` without files as ready
  each fail their model case; dropping the phone's last-answer fallback fails the `readPhoneStatus` case.
- Typechecks: `packages/app` (`tsgo -b`), `packages/desktop` (`tsgo -b`), `packages/schema` (`tsgo --noEmit`) and the api
  tree (`packages/engine`: `bun typecheck --project ../../tsconfig.json`), all clean. The full turbo typecheck is the
  pre-push step and did not run here.
- `prettier --write` on the six edited files that were prettier-clean at HEAD (`phone/status.ts`, `phone/api.ts`,
  `phone/app.tsx`, `context/platform.tsx`, `phone/status.test.ts`, `hosted.css`; no change). The other edited files
  were not prettier-clean at HEAD; their added lines are kept to 120 characters.
- After the review fixes (same commands, after the last code edit): `packages/app` `--isolate`:
  `hosted-model.test.ts` 23/0, `hosted-requests.test.ts` 7/0, `src/phone/status.test.ts` 14/0 (the new `hosted: true`
  check is in an existing case), `src/phone/phone.test.ts` with `--test-name-pattern honesty` 1/0 and with
  `--test-name-pattern "style attribute"` 1/0 (6 filtered out each); `packages/desktop` `src/main/hosted-client.test.ts`
  11/0; `test/`: `hosted-sessions-api.test.ts` 49 pass, 1 skip (the F1 lines are in an existing case),
  `hosted-clients.test.ts` 12/0, `hosted-copy.test.ts` 6/0. Mutations, each restored: removing F1's filter fails "each
  computer's session"; going back to F6's truthiness check fails the status case above. Typechecks `packages/app`,
  `packages/desktop`, `packages/schema` and the api tree: clean. `prettier --check`: `phone/status.ts` and
  `phone/status.test.ts` still clean; no added line over 120 characters elsewhere. The phone's import graph did not
  change, so the bundle walk was not run again.

**Only in CI.** The Valkey and Postgres cases, the HttpApi exerciser, `check:generated` (no generator input changed),
the Codium browser specs (none added) and the typecheck matrix. The Codium unit job selects every test file changed
since the base, so the seven changed test files run there; `phone.test.ts`'s bundle walk does not (above).
vector-hosted-ci.yml's Hosted tests run every `test/*.test.ts` and the desktop's `hosted-*` tests. Dispatches after
the lead's commit, in order: Vector Codium on `codium-finish` with `base: "origin/release-finish"` and no
`browser_specs`, then typecheck.yml, then vector-hosted-ci.yml once the Vector Codium run has finished.

**For the lead.** D1 above (a deviation from the package text, nothing to fix in another lane). D2 above (a deviation
from the lane rule that only H1a adds a hosted API field): H1c adds `kept` to `GET /api/hosted/status` and the
`Hosted.KeptDisks` type, for R1's reason (only the server knows the plan's download answer, `hostedOpen`, the margin
and the rates file's `BLOCK_MINUTES`); the rejected alternative is `/api/hosted/computers`' `disksDeletedAt` plus the
server's refusals. It is not an engine `HttpApi` change, so no generator run is needed. Accept it here or send the
field back to H1a. None in another lane's files. Records also touched: `codium-a56-hosted-clients-notes.md`, `codium-a53-hosted-sessions-notes.md`,
`codium-p8-repairs.md`, `docs/vector/MODEL-PLANS.md` and `docs/vector/owner-actions/hosted-computer.md`.

Edits to `api/_lib/model-plan-*.ts`: none.

**H1c's CI receipts (recorded by Codium finish H2a, 15 Nov 2026)**

For `5003fa2b` (H1c's commit), read from the runs' jobs and logs:

- Vector Codium run 43760889035 (18 jobs): every job passed or was skipped by `services_only` (Hosted services'
  typecheck and Hosted tests) except Codium tests job 132955226556, which failed only at "Run HttpApi exerciser gates"
  with `summary pass=359 fail=0 skip=0 missing=4 extra=0` and exactly the four review-memory lines (`MISS DELETE
  /experimental/review-memory/previews/{previewId}`, `MISS GET /experimental/review-memory`, `MISS POST
  /experimental/review-memory/confirm`, `MISS POST /experimental/review-memory/prepare`). Its "Run the Codium test
  files" and "Check generated client" steps report success, so the run is green under the lane's baseline rule. No
  per-file count is claimed. Hosted services / Cloud computer image (Docker) job 132955227115 and Codium browser specs
  job 132955226877 passed.
- typecheck.yml run 43760891870: success.
- vector-hosted-ci.yml run 43761604770: all 12 jobs passed; Hosted tests job 132957422106 ends "Hosted: 150/150 test
  files passed", and its Cloud computer image (Docker) job 132957421851 passed.

## Codium finish: H2 generation floor (15 Nov 2026)

Package H2a, the gap in `codium-a54-hosted-image-notes.md` "For later packages" ("Server-side image floor"): hostd
reported its generation, but nothing on the server refused a computer below a floor. `boot.sh`'s
`check_disk_generation` (`packages/hosted-computer/image/boot.sh:57-58`) refuses only after the computer started and
costs began, and per H1b's R4(d) a resumed computer runs its own disk's `boot.sh`, so it never refuses an old disk at
all. The server floor is the one that acts, and it acts before anything is held. Built on `codium-finish` `5003fa2b`
(H1c; equal to origin/codium-finish; PR #33 unmerged: origin/main `58f85edc`, origin/release-finish `cf2373c4`). H1a,
H1b and H1c have landed. Scratch under `/tmp/vector-v2/codium/h2a/`. Not committed by this build step; CI ids follow
in a dated line.

**What landed** (`api/_lib/hosted-sessions.ts` unless named; line numbers after the round-one fixes below)

- The record. `hostedGenerationKey` (`:151`), `hosted:generation:<account>`: a HASH from computer number to
  `<generation>:<until>`, the generation its daemon last reported and when that report lapses. `recordHeartbeat`
  writes it (`:1593-1602`) on every beat that carries a generation, only after `requireDaemonBeat` (`:1536`) and after
  the early return for stopping and ended sessions (`:1551`). `until` is the beat's time plus the session's `diskDays`
  (R12). The session record gains `diskDays` (`:214`, optional, so records from before H2a still decode), set by
  `startHostedSession` (`:608`, the plan's `diskDays`) and `startHostedDownload` (`:815`, the days left before the
  deletion date, as before); a record without it counts one day. The hash goes with the computer: `eraseHostedComputer`
  HDELs its entry (`:1826`), the nightly deletion at the disk date DELs it with `hosted:computers:<account>`
  (`api/_lib/hosted-crons.ts:616`), and account deletion DELs it (`hosted-crons.ts:536`; `eraseAccountKeys`' SCAN also
  matches it, since the account id is in the key). A start that adds a number to `hosted:computers:<account>` (SADD
  answers 1) HDELs that number's entry (`:616-617`), because a computer made anew is not the one that reported it.
- The setting. `hostedMinGeneration` (`:364`) reads `process.env.VECTOR_HOSTED_MIN_GENERATION`: unset, blank or `0` is
  no floor; a whole number up to `GENERATION_MAX` (`:133`, 1,000,000, the bound `parseHeartbeat` already used,
  `:1433`) is the floor; anything else is `"invalid"`. It is not one of `hostedSessionProblems`, so downloads, the
  status's kept disks and `computer`'s readiness are untouched.
- The check. `computersBelow` (`:378`): among the numbers it is given (the account's known computers,
  `knownComputers`, `:844`), those whose entry has not lapsed and holds a whole number above 0 and below the floor.
  `startHostedSession` (`:566-590`), after `requireHostedStart` (which places no hold) and before any lease: an invalid
  floor throws 503 `HOSTED_UNAVAILABLE`; when every included computer is below the floor it throws 409
  `HOSTED_REBUILD_REQUIRED`, "This cloud computer needs to be rebuilt.", with detail `{computers}` (the included
  computers below it, numbers only; `rebuildRequired`, `:1843`). Otherwise the claim passes over a computer below the
  floor: a local recursive `claim` (`:580`) gives the lease back (`releaseLease`, now typed on the three fields it
  reads, `:477`; a failed release is swallowed as in `abandonSession`) and claims again from the next number, at most
  `MAX_COMPUTERS` times. When nothing is left and some included computer is below the floor, the answer is 429
  `HOSTED_BUSY` with "Every cloud computer your plan includes is running or needs to be rebuilt." (`:588`); with none
  below, the old message. With no floor the path is the old one: no store read, the same CLAIM call.
- The view. `hostedComputers` (`:1777-1805`) adds `rebuild: true`, never the generation, to a computer below a set
  floor only where a job start checks it: an included computer of a plan that has not ended (`hostedAccess(snapshot,
  "on", now) !== "stop"`, `:1791`). It hands `computersBelow` the known numbers it already read, filtered to the
  included ones, so a GET makes no second SMEMBERS. `GET /api/hosted/computers` carries it.
- `packages/schema/src/hosted.ts`: `HOSTED_REBUILD_REQUIRED: 409` in `ERROR_CODES`, with a comment. Not the Protocol
  or an `HttpApi`, so no generator run.
- `test/hosted-sessions-fixture.ts`: `VECTOR_HOSTED_MIN_GENERATION: undefined` in `hostedSessionEnvironment`, so
  `restore()` puts back what a test set.
- `.env.example`: the name with a blank value and a two-line comment. MODEL-PLANS.md (A54 bullet and "Cloud computer
  sessions (A53)" configuration line) and `owner-actions/hosted-computer.md` ("The image floor", and a dated sentence
  on the H1b bullet).
- Not changed: CLAIM, LEASE and SAVE (so the Valkey parity case is untouched), `startHostedDownload`'s checks (only its
  doc, `:755`, and the `days` it already computed, now also on the record), the reaper, renewals, take-over, the
  viewer, files, `hosted-jobs.ts`, the image and every client.

**Readings**

- **R1, starts and resumes are one path.** A job start either makes a computer (no record yet) or resumes its saved
  disk (record checked). There is no separate resume route, so "refuse new starts and resumes" is the one check in
  `startHostedSession`.
- **R2, the record and its trust.** Only signed beats count: the HSET sits after `requireDaemonBeat`, so the agent,
  which holds the run token but not hostd's key, cannot write a generation (pinned by the unsigned-beat case). The
  number is hostd's `/usr/lib/vector/GENERATION` (`packages/hosted-computer/src/limits.ts:53`, read by `readGeneration`,
  `hostd.ts:478-485`, sent on every beat, `daemon.ts:165`). `boot.sh` compares a different file,
  `/var/lib/vector/disk-generation`, written on the disk's first boot. The two agree for a resumed computer only
  because it restores its whole disk, `/usr/lib/vector` included (H1b R4(d)); so the recorded number is the
  generation the disk was made from. The record lives on the computer (per account and number), not the session; the
  provider's `hosted:computer:<name>` record is not used, because every start overwrites it and it expires an hour
  after the session's timeout.
- **R3, unrecorded passes.** A computer with no recorded generation is allowed, because it never booted, or never sent
  a signed beat (an image from before signed heartbeats). A reported `0`, which hostd sends when it cannot read its
  file, is dropped by `parseHeartbeat` and also counts as unrecorded. That is fail-open, the reading the package asks
  for; the owner may change it. There is no backfill: every computer that booted before this server version reads as
  unrecorded, so its first start after the floor is set is not checked, and the floor applies to it from its next
  start. Harmless today, since no image has been built; the owner step says so.
- **R4, download-only starts are exempt (H1a has landed).** `startHostedDownload` never reads the floor, so an ended
  plan's files stay downloadable whatever image the disk was made from (§4.4). Pinned by the lifecycle case with the
  floor above the recorded generation and with an unreadable floor. Running sessions and the reaper's
  `renewHostedBlock` are not checked either: the floor is about new work on an old disk, and stopping running sessions
  is the `hosted` switch's job.
- **R5, pass over versus refuse.** With several computers, a start passes over one below the floor and runs on the
  next free one; it is refused only when every included computer is below it. A passed-over start runs without the
  passed-over computer's files: a job that would have resumed computer 1's disk runs on a fresh computer 2. On a live
  plan those files can be kept only by not erasing the computer, since `requireHostedDownload` allows no download start
  on a live plan that includes a computer. Refusing any start while one included computer is below the floor is the
  other reading; it is listed with the owner's choices.
- **R6, busy or rebuild when the free ones are below.** Critique point taken: when the only free computers are below
  the floor and the rest are running, the old 429 message ("All the cloud computers your plan includes are running")
  was false for the free one. The answer keeps 429 `HOSTED_BUSY`, so a queued Done by Morning job waits for a running
  computer to free up (`startRefusal`, `hosted-jobs.ts:948-966`, treats `HOSTED_BUSY` as wait), and says "Every cloud
  computer your plan includes is running or needs to be rebuilt." The rebuild code would have marked the job missed
  even though a computer at or above the floor will free up.
- **R7, no automatic wipe: the conservative choice, which the owner may change.** Nothing deletes anyone's disk for
  the floor. The only rebuild is the explicit erase, `POST /api/hosted/computers {computer, action: "erase"}`
  (`api/_lib/hosted-api.ts:281-286`, `eraseHostedComputer`), which also forgets the generation, so the next start makes
  the computer again from `VECTOR_HOSTED_BASE_SNAPSHOT`. The package asks for "the subscriber's explicit, confirmed
  action". The API's erase is explicit, but it has no confirmation step of its own, and no screen offers erase yet. The
  confirmation belongs to that future screen; this package does not claim one exists. A computer whose disk lapsed at
  the provider needs no erase: its report lapses no later than the disk (R12).
- **R8, an unreadable floor.** Any value but a whole number up to 1,000,000 refuses job starts with 503
  `HOSTED_UNAVAILABLE`, never with the rebuild code: an unknown floor must neither pass a stale computer nor tell anyone
  to delete a disk. `0` is no floor (no generation is below 0), so the value an owner may type to mean "off" is not an
  outage. Critique point partly taken: it asked for an owner signal. The perk readiness (`codium-perks.ts:82`) was
  rejected as that signal, because an unready `computer` is unlisted, and unlisting closes the kept-files screens and
  `hostedOpen` for downloads. No owner page lists hosted settings today. So the signal is in writing: `.env.example`
  and the owner step say a bad value stops every job start, and to check it first when starts stop.
- **R9, Done by Morning.** A queued job whose start answers `HOSTED_REBUILD_REQUIRED` (409) is missed and alerted as
  `refused` ("Done by Morning: a job could not start in time"; `startRefusal` returns "refused" for a 4xx it does not
  list); one that answers the invalid floor's 503 or R6's 429 waits. No `hosted-jobs.ts` change. Pinned since round one
  by the hosted-jobs case "the image floor (H2a)".
- **R10, the clients.** No screen calls `GET /api/hosted/computers`: `hosted-requests.ts:98` defines the request and
  nothing sends it. The composer and the phone already show a refusal's message through `hostedErrorText`
  (`packages/app/src/features/cloud/hosted/hosted-model.ts:561-566`). So the code and the message are enough, as the
  package allows; no client change, no amounts.
- **R11, contract additions.** A new store key (not in §4.6, which names only three hosted keys), a setting (not in
  §4.16), an error code (not in §4.10; the schema already lists the extra hosted codes after its comment) and an
  optional session-record field (`diskDays`, never in a view). H2a adds two hosted API fields, which its package text
  asks for ("expose the state in the session or computer view"): `rebuild` on `GET /api/hosted/computers` and
  `error.computers` on `HOSTED_REBUILD_REQUIRED`. The lane's rule names H1a as the only package that may add a hosted
  API field, so both are named for the lead below.
- **R12, the report lapses with the disk (round one).** The provider keeps a computer's disk `diskDays` after the
  computer stops (`retentionMs`, `api/_lib/hosted-provider.ts:289`; Vercel's `snapshotExpiration` and
  `keepLastSnapshots`, `hosted-provider-vercel.ts:88-89`), and then the next start makes the computer afresh from the
  current snapshot. A report kept with no lifetime would refuse that fresh computer, or pass it over, until the person
  erased a disk that no longer exists, through an API no screen offers. So each report carries `until`, the beat's
  time plus that session's `diskDays`, and every signed beat writes it again. The computer stops after its last beat,
  so `until` is never later than the disk's deletion: the report may lapse a little early (fail-open, as R3), never
  late. The gap is the time between the last beat and the stop, normally under a minute, at most the job's length when
  the daemon stopped reporting; a start in it resumes the old disk unchecked. The other bound, the session's deadline
  plus the provider's grace plus `diskDays` (the review's example), never lapses early but refuses a lapsed disk for up
  to the job's length; the owner step lists the choice. The cost is one HSET per beat that carries a generation (every
  30 seconds while a computer runs), where the build wrote only on a change. The H1a download-only session's beats
  carry its own `diskDays` (the days to the deletion date), so they keep the report for that long; the nightly deletion
  at that date removes it anyway. On an ended plan whose final job ran more than its plan's `diskDays` before the
  deletion date the report lapses first; no job can start there, and a plan that resumes inside that window resumes
  unchecked (fail-open).

**Critique points taken and rejected**

- Taken (major): a stale entry for a number the account no longer has is never read. `computersBelow` counts only
  numbers `knownComputers` lists; erase removes the generation before the SREM, so a failed SREM leaves the computer
  unrecorded rather than refused; and a start that adds a number HDELs its entry. This closes the failed-last-write and
  beat-after-erase cases (the plan's O3). Pinned by "a generation left for a computer the account no longer has is not
  read, and a new computer drops it".
- Taken: R7 says the API's erase is the only rebuild and that the confirmation is the future screen's.
- Taken: R6 (busy with an accurate message) and its T6 case (computer 1 below, 2 and 3 running).
- Taken in part: R8 (`0` is no floor; the warning is written down). The readiness signal is rejected for R8's reason.
- Taken: the claim loop is inlined in `startHostedSession` as a local recursive closure, bounded by the claim range,
  with the release's failure swallowed. A lease on a below-floor computer exists only between the claim and its
  release in the same request; if that release fails, it lapses at its own time (the first hold plus two minutes),
  as any lease a failed start leaves does. It stays inline because it is used once and needs the start's `id`,
  `until` and `below`.
- Taken: R5 says a passed-over start runs without that computer's files; "pass over vs refuse" is in the owner's
  choices.
- Taken: R3 says there is no backfill and that a reported 0 passes; R2 names the file and the R4(d) equivalence.
- Taken: the rebuild detail is accurate: `{computers}` lists every included computer below the floor, numbers only.

**Review findings (round one, 15 Nov 2026)**

Seven findings, all non-blocking; all seven taken.

- F1 (taken, code): the report had no lifetime, so a lapsed disk was refused or passed over until erased. R12: each
  entry is `<generation>:<until>`, `until` the beat plus the session's `diskDays` (new optional record field), written
  on every signed beat that carries a generation; `computersBelow` ignores a lapsed entry. The review's own bound (the
  deadline plus grace plus `diskDays`) was not used, because it refuses a lapsed disk for up to the job's length; the
  shorter bound fails open, which the review accepted as fitting R3. The owner step's "Not checked" and "Yours to
  decide" lists say so. The hash and its three deletion paths are unchanged. Regression tests: "a report lapses with
  the disk: once the plan's disk days have passed, the old generation no longer refuses" (new) and the signed-beat case
  (each beat, the same generation included, writes the lapse time again).
- F2 (taken, code): `rebuild` was set on an ended plan's kept disk and on computers the plan no longer includes. It is
  now set only on an included computer of a plan that has not ended (`hostedAccess(...) !== "stop"`), where a job
  start checks it. Regression tests: the lifecycle download case now expects no `rebuild` on the ended plan's kept
  disk (it runs on a 30-day plan, so the report made on day 10 is still live once the plan ends on day 30), and the
  several-computers case moves back to Max and expects `rebuild` on computer 1 only.
- F3 (taken, test): `test/hosted-jobs.test.ts` "the image floor (H2a): a job whose every computer needs a rebuild is
  missed as refused; one whose free computers do waits as busy" pins R9 and R6 for Done by Morning: on Max a refused
  start misses the job with reason `refused`, nothing reaches the provider and the alert is "Done by Morning: a job
  could not start in time"; on three computers with computer 1 below the floor, two jobs run on 2 and 3 and the third
  stays queued, waiting `busy`. The setting is put back by `hostedSessionEnvironment`'s `restore()`.
- F4 (taken, code): `hostedMinGeneration` reads `process.env.VECTOR_HOSTED_MIN_GENERATION` directly; the unused `env`
  parameter is gone.
- F5 (taken, test): `test/account-delete.test.ts` seeds `hostedGenerationKey(ACCOUNT)` next to `hostedComputersKey`,
  so P5's erase checks cover the new family directly. Dropping it from `eraseAccountHosted`'s DEL list now fails
  "Worker outage: the request answers pending, the tombstone stays, and the cron retries until it finishes" there (the
  sweep still catches it on the main path).
- F6 (taken, record): R11 and "For the lead" name both hosted API fields.
- F7 (taken, code): `computersBelow` takes the known numbers; `hostedComputers` passes the ones it already read
  (filtered to the included ones, per F2), `startHostedSession` reads them as before.

**Observations (not changed)**

- O1, a lapsed disk. Closed in round one by R12: the report lapses no later than the disk. What remains is the other
  direction, a disk the provider lost early (a provider-side delete before its retention), which still reads its old
  report until that lapses or the person erases the computer; the destroy then answers "missing", and erase answers
  `deleted: false`, as before.
- O2, a store fault inside a start. If the HDEL after a SADD that added the number fails, the start is abandoned, and
  the next start's SADD answers 0, so a leftover entry for a re-made computer survives until that computer's first
  signed generation beat overwrites it, or until it lapses. It needs a failed erase or a racing beat first, then a
  store fault at that one step.
- O3, a floor above the snapshot. A floor higher than the generation `VECTOR_HOSTED_BASE_SNAPSHOT` was baked with
  refuses every computer from its second start on, and erasing only makes it again from the same snapshot. The owner
  step says never to set it above the snapshot's generation.

**Not built**

- An erase screen with a confirmation (R7), and any screen that shows `rebuild` (R10).
- Reading the record for a download start (the H1b defect on disks from before signed heartbeats stays open;
  `codium-a53-hosted-sessions-notes.md`, "Not done").

**Ran locally** (through `vector-serial`, one file at a time, `--timeout 30000`, after the last code edit of round
one):
- `test/`: `hosted-sessions-api.test.ts` 59 pass, 1 skip (10 in "the image generation floor (H2a)"; 49 pass, 1 skip at
  HEAD); `hosted-lifecycle.test.ts` 21/0 (2 new; 19 at HEAD; the H1a describe's `beat` helper moved to module scope
  unchanged); `hosted-jobs.test.ts` 32 pass, 1 skip (1 new; 31 pass, 1 skip at HEAD); `account-delete.test.ts` 37
  pass, 1 skip (the seeded hash only).
- Regressions, unchanged: `hosted-copy` 6/0 (the new message passes the copy rules), `hosted-reaper` 26/0,
  `account-delete-api` 8/0, `codium-mode` 18/0, `hosted-clients` 12/0, `hosted-ledger` 31 pass 1 skip,
  `hosted-internal` 12/0, `hosted-provider` 39/0; and, from the build step, `packages/web`
  `test/codium-configuration.test.ts` 11/0 (`.env.example` names stay unique; `.env.example` is unchanged since).
- Mutations, each restored afterwards (`cmp` against the saved copy). Build step: dropping the all-below refusal fails
  3 floor cases; applying the floor in `startHostedDownload` fails the lifecycle download case; dropping the erase's
  HDEL fails the erase case; an HSET before `requireDaemonBeat` fails the signed-beat case; dropping the known filter,
  or the HDEL on an added number, fails the leftover-entry case; dropping the pass-over fails the several-computers
  case; reading an invalid floor as none fails the unreadable-floor case; the nightly deletion or account deletion
  keeping the hash fails the lifecycle deletion case; no HSET at all fails 5 cases. Round one, each failing exactly one
  case: ignoring `until` fails the lapse case; writing only on a changed generation fails the signed-beat case;
  `rebuild` on an ended plan fails the lifecycle download case; `rebuild` on a computer the plan does not include fails
  the several-computers case; answering the rebuild refusal with 503 fails the hosted-jobs case (the job waits); the
  rebuild code for free-but-below computers fails it too (the job is missed); account deletion keeping the hash fails
  the account-delete outage case.
- Typechecks: the api tree (`packages/engine`, `bun typecheck --project ../../tsconfig.json`) clean after round one;
  `packages/schema` clean at the build step and unchanged since. The full turbo typecheck runs before the push.
- No `prettier --write`: none of the edited code files was prettier-clean at HEAD. Added code lines are kept to 120
  characters; six new test titles and one copied filter line are longer, as the files' existing ones are.

**Only in CI.** The Valkey and Postgres cases (the sessions' Lua scripts are unchanged), the HttpApi exerciser,
`check:generated` (no generator input changed), the Codium browser specs (none added), the typecheck matrix, and
vector-hosted-ci.yml's Hosted tests and Docker job. Dispatches after the lead's commit, in order: Vector Codium on
`codium-finish` with `base: "origin/release-finish"` and no `browser_specs`, then typecheck.yml, then
vector-hosted-ci.yml once the Vector Codium run has finished.

**For the lead.** None in another lane's files. H2a adds two hosted API fields under its package text, against the
H1a-only rule: `rebuild` on `GET /api/hosted/computers` and `error.computers` on `HOSTED_REBUILD_REQUIRED`. Neither is
an engine `HttpApi`, so no regeneration is needed. Accept them, or move them to H1a. Owner decisions, recorded in
`owner-actions/hosted-computer.md` ("The image floor"): an automatic rebuild (today refuse-only), pass over versus
refuse, a live plan's files on a below-floor computer, a queued job missed versus waiting, and a report that lapses at
the disk's earliest deletion versus its latest. Setting `VECTOR_HOSTED_MIN_GENERATION` is an owner step after the image
is rebuilt. Records also touched: `codium-a54-hosted-image-notes.md`, `codium-a53-hosted-sessions-notes.md`,
`docs/vector/MODEL-PLANS.md`, `docs/vector/owner-actions/hosted-computer.md` and `.env.example`.

Edits to `api/_lib/model-plan-*.ts`: none.

**H2a's CI receipts (recorded by Codium finish DZ, 15 Nov 2026)**

These are for `0d6bfc53`.

- Vector Codium run 43767172051: `failed_only` lists one failed job of 18, Codium tests job 132974801751. Its visible
  tail shows "Codium: 159/159 test files passed", then exactly the four review-memory MISS lines and `summary pass=359
  fail=0 skip=0 missing=4 extra=0`. The job's step list (`get_workflow_job`) shows that "Run the Codium test files"
  and "Check generated client" succeeded and only "Run HttpApi exerciser gates" failed, so the run is green under the
  lane rule.
- typecheck.yml run 43767175427: success.
- vector-hosted-ci.yml run 43767672460: success. Its Hosted tests job 132976338618 ends "Hosted: 150/150 test files
  passed".

## Codium finish: H2 image notices (15 Nov 2026)

Package H2b closes the gap in `codium-a58-deploy-workflows-notes.md` "Not done": "The CLI's notice files are not
copied into the image (A54's Dockerfile takes only `bin/vector`)". The CLI build writes `DEPENDENCY_NOTICES.md`
(`packages/engine/script/build.ts:181`) and ships `LICENSE`, `THIRD_PARTY_NOTICES.md` and `DEPENDENCY_NOTICES.md`
beside `bin/` (`:284`, `:293`) in every archive (`:303`, `:307`). Release packaging requires the three to be identical
across targets (`packages/cloud/src/cli-release-package.ts:93`) and puts them in each archive (`:111`). The image
took only the binary from that archive. Built on `codium-finish` `0d6bfc53` (H2a; equal to origin/codium-finish; PR
#33 unmerged: origin/main `58f85edc`, origin/release-finish `cf2373c4`). Scratch under `/tmp/vector-v2/codium/h2b/`.
Not committed by this build step; CI ids follow in a dated line.

**What landed**

- `packages/hosted-computer/image/Dockerfile`:
  - `:44-46`: `COPY --chmod=644 notices/LICENSE notices/THIRD_PARTY_NOTICES.md notices/DEPENDENCY_NOTICES.md
    /usr/share/vector/`, right after the binary's COPY. A missing file fails the build.
  - The final RUN makes the folder root's with mode 0755 explicitly (`:64` `chown -R 0:0 ... /usr/share/vector`, `:66`
    `chmod 0755 ... /usr/share/vector`), so the mode does not depend on how BuildKit creates a COPY destination.
  - The header names `notices/` (`:2`) and adds the guarantee (`:9-10`).
- `packages/hosted-computer/.gitignore`: `notices`, next to `bin`, so a local `cli` run or the CI stand-in leaves
  nothing to commit.
- `packages/cloud/src/hosted-image.ts`:
  - `unpackImageCli` takes `notices` (`:47-52`). Before anything is written it refuses when the binary or the notices
    folder already exists, checked with `lstat`, so a dangling link counts too (`:56-72`). Only ENOENT counts as
    absent; any other `lstat` error stops the run there (R6).
  - After the existing archive and ELF checks, it copies the three notices from the verified, unpacked archive with
    mode 0644 (`:104-112`), then the binary (`:113-115`), which is the last write. Every copy passes
    `COPYFILE_EXCL` (R6).
  - `fetchImageCli` passes `notices` through (`:123-146`); its answer is unchanged.
  - `main`'s `cli` needs both `--output` and `--notices` before anything is fetched (`:185-192`, "Pass --output <path>
    --notices <directory>."). A value that starts with `--` is not taken as a flag's value. The log line and the usage
    name both flags.
- `.github/workflows/vector-hosted-image.yml`: the step "Take the Vector CLI from its published release" runs
  `... cli --output packages/hosted-computer/bin/vector --notices packages/hosted-computer/notices` (`:197`). The
  header says the job takes the CLI and its three notice files from the release. No new input, env, secret or
  expression. The workflow was not dispatched.
- `.github/workflows/vector-hosted-ci.yml`, job `hosted-image`, step "Build the image with a stand-in CLI" (name kept):
  - it writes three stand-in files under the release's names into `notices/` (`:274-278`) before the same
    `docker build` (`:279`, unchanged);
  - the job comment says so (`:245-249`);
  - still SHA pins, ubuntu-24.04, no secret, no login and no push.
- `packages/hosted-computer/test/docker/in-image.mjs` (runs only in Docker):
  - `/usr/share/vector` joins the root-owned, not-writable-by-others `find` (`:35`);
  - `/usr/share/vector` is a root-owned folder with mode 0755 (`:40-41`);
  - each notice is a root-owned, non-empty regular file with mode 0644 (`:42-45`);
  - each notice can be read by the agent, uid 10001, through the existing `probe` (`:95-96`).
- Records: dated status lines in `codium-a58-deploy-workflows-notes.md` (closing its "Not done" bullet) and
  `codium-a54-hosted-image-notes.md`, and step 1 of "The image" in `owner-actions/hosted-computer.md`.
- Not changed: the notice and licence texts, `DEPENDENCY_NOTICES.md` (not regenerated), `script/dependency-notices.ts`,
  the CLI build and release packaging, `boot.sh` and its base archive, `bake-snapshot.ts`, `microvm-check.ts`, every
  server file, every setting and every flag.

**Readings**

- **R1, "from the CLI build output".** The image workflow never builds the CLI: it takes it only from the published
  release archive, checked against the release manifest's size and SHA-256, and requires the release's source commit
  on protected `main`. That archive is the CLI build's output, packed from `dist/<name>/` beside `bin/`, and packaging
  keeps the three files identical across targets. So the notices come from the same verified archive as the binary,
  unchanged (`copyFile`, no text step). The archive check already refused an archive without all three
  (`hosted-image.ts:88`).
- **R2, `/usr/share/vector` rather than the task's example `/usr/local/share/vector`.** The Vector CLI container keeps
  the same three files in `/usr/share/vector/` (`packages/cloud/container/Dockerfile:16`, copied with mode 0644 by
  `cli-container.ts:73-76`), with the binary at `/usr/local/bin/vector`, as here. One place in both images is easier
  to describe in the legal read. Moving it is one Dockerfile line plus the matching strings in `in-image.mjs`, the two
  test regexes and the owner doc; the image test ties the folder to the CLI container's, so a move in one alone fails.
- **R3, CI stand-ins.** The CI image job has no release, so its stand-in step writes three placeholder files under the
  release's names. They exist only on CI's runner and in its image, which is never pushed: the job has no login and no
  push, and the compliance test asserts that. The workflow-compliance case runs the step's own script with `docker`
  stubbed and checks the names against `cliNotices`.
- **R4, computers made from earlier images.** A resumed computer restores its whole saved disk (H1b's R4(d)), so the
  notices reach a computer only when its disk is made from an image built after H2b. No image has been built yet.
- **R5, the texts.** No notice or licence text was edited, and nothing was regenerated. The real
  `DEPENDENCY_NOTICES.md` is about 4.3 MB, against the image's 6 GB limit (`IMAGE_MAX_BYTES`).
- **R6, the existence check and the writes.** The binary's check used `stat`, and a dangling link would have passed
  it. The check now uses `lstat` on the binary and on the notices folder. It checks the folder, not each notice, because
  an absent folder holds no notice. So a leftover folder (even an empty one), a file there, or a link there (even a
  dangling one) refuses the run, and nothing is written into or through it. The refusal names the first path found.
  Only ENOENT counts as absent; any other error (ENOTDIR, EACCES and so on) stops the run at the check with its own
  error, before anything is unpacked. Each `copyFile` also passes `COPYFILE_EXCL`, so a file or link that appears
  after the check is refused by the write itself (EEXIST) rather than overwritten or written through. A link in a
  parent folder of `notices` or of `bin/vector` (in the workflow, `packages/hosted-computer` from the checkout) is not
  checked.
- **R7, the binary is the last write.** If a notice write fails, no binary is left behind for the image build, so a
  binary at `bin/vector` still means the step finished. The test makes a notice write fail with a notices path under a
  dangling link: `lstat` finds nothing there (ENOENT), and the folder's `mkdir` then fails (ENOENT) and creates nothing
  where the link points.

**Critique points taken and rejected**

- Taken (major): the in-image checks run as root, so they now also check the folder (root's, mode 0755), and they
  read each notice as the agent through `probe`. The Dockerfile sets the folder's owner and mode explicitly in the
  final RUN, pinned by `image.test.ts`, and does not rely on how `COPY --chmod` creates the folder.
- Taken (major): the spawn case runs `hosted-image.ts` by absolute path (`path.join(import.meta.dir, ...)`) from an
  empty temp folder. It checks the exact stderr line and the exit code for each call, and that the folder is still
  empty afterwards.
- Taken (major): the compliance case makes its own `mkdtemp` folder, passes it to `shell()` as the cwd (the docker
  stub logs there), reads the results before its own `rm`, and puts the `docker()` function before the step's
  `set -euo pipefail`.
- Taken: the notices are written first and the binary last (R7). The crafted-archive case checks after each failure
  that neither the binary nor any notice exists; the tampered-archive case checks both once its three failures have
  run. A sub-case (a notices path under a dangling link) pins the order.
- Taken: the `.dockerignore` guard tests each pattern against `notices` and against each `notices/<name>` path with
  `Bun.Glob`, where `*` stops at a slash as Docker's does. `**/*.md` fails it. No ban on `/` or `**` was added.
- Taken: the plan's duplicate checks are gone. The link from the Dockerfile's COPY sources to `cliNotices` lives in
  `packages/cloud` (`hosted-image.test.ts`), because `hosted-computer` must not import from `cloud`. `image.test.ts`
  keeps the destination folder, the cross-check against the CLI container's COPY line, the folder mode, and a check
  that `in-image.mjs` names the same files. The layer-order case (b) was dropped.
- Taken: no MODEL-PLANS.md change (no new setting). The Alpine and OCI questions are one neutral line under "For the
  owner". In the owner doc only step 1 changes, and it gains one sentence on the legal read.
- Taken: path choice recorded as R2. The Dockerfile header, the in-image checks and the owner doc all name
  `/usr/share/vector`.
- Taken: the CI record (a later dated line) will cite run and job ids only, and only what the visible log shows. The
  in-image lines print only when a check fails.
- Rejected: none. The `codium-a54-hosted-image-notes.md` dated line stays, because A54's Dockerfile and its Docker
  checks changed, and the lane keeps that record accurate.

**Review fixes (15 Nov 2026).** Six non-blocking findings from the package review, all in this package's own files:

1. Taken. `hosted-image.ts:56-72`: the existence check counted every `lstat` error as absent. Only ENOENT does now;
   any other error is rethrown at the check (R6). Regression: the existing-folder case's ENOTDIR step (a notices path
   under a file) expects `code: "ENOTDIR"` from the check's `lstat` (Bun reports it as `statx` on Linux, so the case
   matches `/stat/`), not from the folder's later `mkdir`.
2. Taken. `hosted-image.ts:185-189`: `value(flag)` no longer takes a following `--` flag as the value. Regression: the
   spawn case adds `--output --notices notices`, which gets the same "Pass --output <path> --notices <directory>." line.
3. Taken. The spawn case (`hosted-image.test.ts`, an `emptyFolder` resource like `cliReleaseFixture`) and the
   compliance case (`workflow-compliance.test.ts`, an inline `[Symbol.asyncDispose]` object as `scratchRepository`
   uses) now clean up with `await using`; both `try`/`finally` blocks are gone.
4. Taken. The stand-in citation is now `vector-hosted-ci.yml:274-278`, plus `:279` for the unchanged `docker build`.
5. Taken in the code, without a test. Both `copyFile` calls pass `constants.COPYFILE_EXCL` (`hosted-image.ts:109`,
   `:114`). A local Bun probe (scratch, not a test) confirmed it refuses an existing file and a dangling link with
   EEXIST and creates nothing at the link's target. No deterministic assertion was added. Once the check refuses an
   existing notices folder, the only window is between `mkdir` and each copy inside one call, and the code has no
   seam to put a file there. Adding a test-only hook to the image step was judged worse than the gap. The mutation
   table records that dropping `COPYFILE_EXCL` fails no case.
6. Taken, with one change from the suggestion. The check now covers `input.notices` itself, so a leftover folder or a
   link there refuses the run. The per-notice paths were dropped from the list rather than kept beside it (the
   suggestion was `[input.output, input.notices, ...]`). An absent folder holds no notice, so they added nothing. With
   ENOENT-only handling (finding 1), they would also have turned a file at `notices` into a raw ENOTDIR from
   `notices/LICENSE` instead of the clear "already exists" refusal. Nothing in the image workflow creates
   `packages/hosted-computer/notices` before the `cli` step (`bun run build` writes only `dist/`), so a clean checkout
   still passes. A link in a parent folder is not checked (R6). Regression: the existing-folder case (renamed "a
   notices folder already there, even empty or a dangling link, refuses the run; a failed notice write leaves no
   binary") covers a folder with a leftover notice, an empty folder, a dangling link as the folder, and a file as the
   folder. Its ordering step moved from a file in the folder's place, which the check now refuses first, to a notices
   path under a dangling link (R7).

After the fixes these mutation rows were re-run and fail as the table says: `stat` for `lstat`, binary path only,
every `lstat` error absent, binary first, the flag guard dropped, `COPYFILE_EXCL` dropped (fails none), the notice
copies skipped, and mode 0600. The other rows' code and cases are unchanged and were not re-run. Prettier: the new and
changed lines are in prettier's form, and `workflow-compliance.test.ts` is clean.

**Ran locally** (through `vector-serial`, one file at a time, `--timeout 30000`; counts at HEAD `0d6bfc53` first)

- `packages/hosted-computer`:
  - `test/image.test.ts`: 22 pass, 3 skip (21 pass, 3 skip at HEAD; 1 new case; the 3 skips are the Docker describe);
  - `test/source.test.ts`: 3/0, unchanged;
  - `node --check test/docker/in-image.mjs`: clean.
- `packages/cloud`:
  - `src/hosted-image.test.ts`: 11/0 (8 at HEAD; 3 new cases, 3 extended), again 11/0 after the review fixes;
  - `src/workflow-compliance.test.ts`: 55/0 (54 at HEAD; 1 new case, 1 exact run updated), again 55/0 after the review
    fixes;
  - `src/cli-container.test.ts` 4/0 and `src/cli-release-package.test.ts` 10/0, unchanged (regressions).
- `bun typecheck` in `packages/hosted-computer` and `packages/cloud`: clean.
- Prettier: `workflow-compliance.test.ts` was clean at HEAD and is clean now. `hosted-image.ts`, `hosted-image.test.ts`
  and `image.test.ts` were not clean at HEAD. The lines this package adds are in prettier's form, and the old lines
  were left as they were.
- Mutations, each restored afterwards and confirmed with `cmp` against the saved copy. Each fails exactly the named
  cases:

  | Mutation | Fails |
  | --- | --- |
  | drop the notices' COPY | the `image.test.ts` case and the `hosted-image.test.ts` Dockerfile case |
  | drop the folder's `chmod 0755` | the `image.test.ts` case |
  | `.dockerignore` `*.md` changed to `**/*.md` | the `image.test.ts` case |
  | drop one name from `in-image.mjs` | the `image.test.ts` case |
  | skip writing the notices (the copies; the folder's `mkdir` kept) | the release case and the crafted-archive case |
  | write the notices with mode 0600 | the release case |
  | check only the binary's path | the existing-folder case |
  | check with `stat` instead of `lstat` | the existing-folder case (its dangling-link step) |
  | count every `lstat` error as absent | the existing-folder case (its ENOTDIR step) |
  | write the binary first | the existing-folder case (its dangling-parent step) |
  | make `main` need only `--output` | the spawn case |
  | take a following flag as a flag's value | the spawn case |
  | drop `COPYFILE_EXCL` from both copies | none (see "Review fixes", finding 5) |
  | drop the stand-in loop | the new compliance case |
  | write two of the three stand-ins | the new compliance case |
  | drop `--notices` from the image workflow | its exact-run compliance case |

- Before the push, the lead's step runs the full turbo typecheck and the api tree.

**Only in CI**

- The Docker image job ("Hosted services / Cloud computer image (Docker)" in `vector-codium.yml`, and `hosted-image`
  in `vector-hosted-ci.yml`). It builds with the stand-ins and runs `test/image.test.ts` with `in-image.mjs`, including
  the new folder, file and agent-read checks.
- vector-hosted-ci.yml's typecheck matrix and Hosted tests, and typecheck.yml.
- Dispatches after the lead's commit, one at a time:
  1. Vector Codium on `codium-finish` with `base: "origin/release-finish"` and no `browser_specs`;
  2. typecheck.yml;
  3. vector-hosted-ci.yml, once the Vector Codium run has finished, because the two share a concurrency group.

**Deferred verification.** The real notice files in a real image are checked only by the owner-dispatched
vector-hosted-image.yml run. Its step "Boot the image and check it from inside" runs the same `test/image.test.ts` and
`in-image.mjs`, so the folder, mode and agent-read checks also guard that build before anything is pushed. The lane
never dispatches it.

**For the lead.** None in another lane's files.

**For the owner** (no decision taken here):

- The legal read of these three files as shipped in the image stays the owner's (spec 8.2 step 15, "hosted computer").
  `owner-actions/hosted-computer.md` ("The image", step 1) says so.
- That read may also cover whether the image's Alpine packages need notices of their own, and whether the image should
  carry an OCI licenses label like the CLI container's.

Edits to `api/_lib/model-plan-*.ts`: none.

**H2b's CI receipts (recorded by Codium finish DZ, 15 Nov 2026)**

These are for `66d0427b`.

- Vector Codium run 43771136293: `failed_only` lists one failed job of 18, Codium tests job 132987079831. Its visible
  tail shows "Codium: 161/161 test files passed", then exactly the four review-memory MISS lines and `summary pass=359
  fail=0 skip=0 missing=4 extra=0`. The job's step list (`get_workflow_job`) shows that "Run the Codium test files"
  and "Check generated client" succeeded and only "Run HttpApi exerciser gates" failed, so the run is green under the
  lane rule.
- typecheck.yml run 43771140154: success.
- vector-hosted-ci.yml run 43771677546: success (run conclusion). Its jobs, the Docker job with the stand-in notices
  among them, were not read one by one.

## Lane status (15 Nov 2026, codium-finish)

Package DZ is the lane's final package, and it changes only docs. It was built on `codium-finish` `66d0427b`, equal to
origin/codium-finish.

- The branch was cut from `release-finish` 0ee486e3. PR #33 is open and still a draft (head cf2373c4, base main
  58f85edc), so every lane dispatch used the picker base `origin/release-finish`.
- On 15 and 16 Nov 2026 this package made read-only GitHub queries (run lists, job lists, job step lists and job
  logs) and local git reads.
  Its one write was the B11 test.yml dispatch.
- Scratch is under `/tmp/vector-v2/codium/dz/`. This review step does not commit; the package's commit step commits,
  typechecks, pushes and dispatches, and its run ids go in a dated line after the runs.

Dated lines were added to:

- `codium-track-b-checkpoint.md`: the B09, B10 and B11 cells; dated B07, B09, B10 and B11 bullets; and the new "B11
  post-change measurement" subsection;
- this file: the receipt blocks above for `31ddb43b`, F44 (with F6's other two runs), R45b and B10, B09b, H2a and
  H2b;
- `codium-p7-repairs.md`: R45b, R46b and B10;
- `codium-a45-desktop-vault-notes.md`: B10, and R45b with B10;
- `codium-a46-ops-worker-notes.md`: R46b;
- `codium-p4-repairs.md`: F6 and F44;
- `codium-p6-repairs.md`: R36's vector-hosted-ci.yml run.

### Package runs

Each package commit was checked against the runs' `head_sha`, not inferred from the order of the run ids. For
example, typecheck.yml run 43726319195 has a lower id than Vector Codium run 43726343168, and both are at `dfef44e3`.

Every Vector Codium run concluded failure, and every typecheck.yml and vector-hosted-ci.yml run concluded success.
"Green" means green under the lane rule: every job passed or was skipped by `services_only`, except Codium tests, which
failed only at "Run HttpApi exerciser gates" with the four baseline MISS lines and `fail=0`.

| Package | Commit | Vector Codium | typecheck.yml | vector-hosted-ci.yml | Under the lane rule | Read in |
| --- | --- | --- | --- | --- | --- | --- |
| CI0 | `02c9fc14` | 43659654730; 43661511343 (browser receipts) | 43659657077 | none | red: "Codium: 119/120", the gateway-hooks import cycle | CI0 and TB sections |
| TB | `7c479924` | 43665227929 | 43665230627 | 43665560776 | red: the same 119/120 | TB section (dated line); hosted run in the 31ddb43b receipts block |
| TB fix (meter epoch) | `31ddb43b` | 43668405381 | 43668408121 | 43669004895 | green; fixes the cycle | this file, TB section |
| F6 | `5f19b0c9` | 43674652525 | 43674654638 | 43675036401 | green | F44 section (item 2 and receipts) |
| F44 | `2924d94b` | 43679383178 | 43679385886 | 43679749016 | green | F44 section |
| R36 (A36) | `265f4ea7` | 43685974875 | 43685977976 | 43686386024 | green | `codium-p6-repairs.md` |
| F28 | `ab784e44` | 43689606818 | 43689609193 | 43690118133 | green | `codium-p6-repairs.md` |
| R45a | `420e729f` | 43700085301 | 43700088239 | 43700704217 | green | checkpoint, `codium-p7-repairs.md` |
| R45b | `4bd146e7` | 43705851187 | 43705853689 | 43706515849 | green | B10 section |
| B10 | `8a43f2b2` | 43715519898 | 43715522956 | 43715921854 | green | B10 section |
| R46a | `d866364f` | 43720600992 | 43720604063 | 43721009223 | green | `codium-p7-repairs.md`, a46 notes |
| R46b | `dfef44e3` | 43726343168 | 43726319195 | 43726762155 | green | `codium-p7-repairs.md` |
| B09a | `03266e2e` | 43733017049 | 43733021027 | 43733598222 | green | B09 browser section, checkpoint |
| B09b | `572de5c4` | 43738423276 | 43738426563 | 43738962650 | green | B09 browser section |
| H1a | `ae7280f8` | 43746787694 | 43746790825 | 43747724868 | green | H1 download-only section |
| H1b | `539cddf5` | 43752968478 | 43752971608 | 43753689797 | green | H1 computer section |
| H1c | `5003fa2b` | 43760889035 | 43760891870 | 43761604770 | green | H1 clients section |
| H2a | `0d6bfc53` | 43767172051 | 43767175427 | 43767672460 | green | H2 generation floor section |
| H2b | `66d0427b` | 43771136293 | 43771140154 | 43771677546 | green | H2 image notices section |

**The baseline exerciser lines.** In every green run, the Codium tests tail shows these four lines and then
`summary pass=359 fail=0 skip=0 missing=4 extra=0`, as read here or in the cited record:

- `MISS DELETE /experimental/review-memory/previews/{previewId}`
- `MISS GET /experimental/review-memory`
- `MISS POST /experimental/review-memory/confirm`
- `MISS POST /experimental/review-memory/prepare`

This package read them in Codium tests jobs 132672820820, 132706470083, 132786637759, 132816093909, 132848987130
(R46b), 132886071440, 132974801751 and 132987079831. The other rows' jobs are in their records.

- For the runs of `31ddb43b`, F44, R45b and B10, the job lists were read: 15 succeeded, 2 were skipped and 1 failed.
- For R46b, B09b, H2a and H2b, `get_job_logs` with `failed_only` was read: it lists one failed job of 18. The step
  list of each of those Codium tests jobs (`get_workflow_job`) shows that "Run the Codium test files" and "Check
  generated client" succeeded and only "Run HttpApi exerciser gates" failed.
- The four lines belong to the VectorScope and PR #33 CI lanes (TB For the lead item 5).

16 Nov 2026: no longer expected. With 0f6fce89 and 225905e2 in HEAD (through main `b362fdf6`), Vector Codium run
43844651835 at `34c20b62`, job 133221689218, shows no MISS line and `summary pass=363 fail=0 skip=0 missing=0
extra=0`, and the step succeeded. A MISS line in a later run is a real failure that needs a root cause.

**Other runs.**

- B11: test.yml run 43773518841, job 132994512597, at `66d0427b` (checkpoint, "B11 post-change measurement").
- DZ's own post-push Vector Codium and typecheck.yml runs are not in this record: they run on DZ's commit, after it,
  and the package's commit step names them in a dated line after the runs. DZ lists no vector-hosted-ci.yml run.

### For the lead

These are pointers only; nothing is fixed here.

- CI0 ("Codium finish: CI0 lane dispatch inputs", For the lead):
  - switch the dispatch base to empty once main contains #33, before `release-finish` is deleted;
    16 Nov 2026: the condition is met. origin/main is `b362fdf6`, which contains #33, so every Vector Codium dispatch
    from `codium-finish` now leaves `base` empty and compares with origin/main. The `release-finish` branch is left
    alone: deleting branches is not this lane's call;
  - confirm the Windows run of the "dispatch's inputs reach the picker only as step environment" compliance case in the
    end-of-lane test.yml.
    21 Nov 2026 (v2-closeout-ci): corrected premise. No Windows job ran this case: `packages/cloud` has no turbo test
    task, so the unit job never ran `workflow-compliance.test.ts`, and the comment that said it did was wrong. test.yml's
    unit job now has a Windows-only step, "Run the Codium dispatch-input compliance case" (5 minutes, `packages/cloud`,
    `--test-name-pattern "reach the picker only as step environment"`), and the case asserts that the step exists.
    Locally the pattern selects that one case (1 pass); with the step removed the case fails. The Windows job ID is to
    be recorded after the first PR run; a failure there is fixed in the pass-through list, never skipped.
    21 Nov 2026 (v2-closeout-ci, review fix): the first pattern, "only as step environment", also matched the A58
    rollback case added later on this branch ("rolls back only to a full SHA on main, passed to the preflight only as
    step environment"), so the step ran 2 cases, and the rollback one starts bash and git without Windows' system
    variables. The pattern is now "reach the picker only as step environment", and the case also checks that the
    step's pattern matches no other test title in the file (with the old pattern it fails, listing the rollback case).
- TB ("Codium finish: Track B receipts and P4 closings", For the lead):
  - item 1 is closed on this branch by `31ddb43b`, but the same change is still needed on `release-finish`;
    16 Nov 2026: superseded. Main's `9be63d68` (`api/_lib/cloud-agents-epoch.ts`) is the one copy; `bc8cad48` drops
    `31ddb43b`. See the Lead ruling under round three;
  - item 2: `prompt.test.ts` on Linux;
  - item 3: the engine (linux) shard step limits;
    21 Nov 2026: superseded. PR #38 (`7e440a27`) split the Linux engine suite into six shards (`9506de79`), and
    `test.yml` on main runs `--shard=<n>/6`. The 30-minute step limit is unchanged;
    21 Nov 2026 (v2-closeout-ci): closed. Green 6-shard main runs took 16.3/8.1/8.9/13.2/15.0/12.5 min (run
    44848275007, `f3d7ac74`), 14.4/8.2/10.4/18.1/10.6/11.8 (44822880542, `3670461a`) and 11.4/7.8/9.7/10.5/15.5/8.1
    (44869120445, `3e90df62`). The largest shard reached 15.5-18.1 min, so the Linux engine job now runs the same
    round-robin over eight shards (`--shard=<n>/8`, required checks in `policy-199113.json` renamed to match) and keeps
    the 30-minute step limit. The 8-shard times are to be added after the first PR run;
  - item 4: the app `memory-*-model` suites, which no visible log shows;
  - item 5: the review-memory MISS lines, fixed upstream by 0f6fce89 and 225905e2;
    16 Nov 2026: closed. Vector Codium run 43844651835 at `34c20b62` (main `b362fdf6` merged), Codium tests (shard
    1/4) job 133221689218: "Run HttpApi exerciser gates" succeeded with `summary pass=363 fail=0 skip=0 missing=0
    extra=0` and no MISS line;
  - item 6: the shard-matrix merge conflict with `release-finish` dbfca832;
    21 Nov 2026: closed. `dbfca832` is an ancestor of main (through #33), and this lane merged main before PR #36
    merged as `b5cbad1c`, so no conflict is left;
  - item 7: the non-hermetic `upstream-free.test.ts:148`, which reads host provider variables.
    21 Nov 2026: closed on branch `engine-core-fixes` (the provider allow-list; see item 7 above).
- F6 ("Codium finish: F6 cost kind on read", For the lead): the desktop task-bridge store's closed literals
  (`packages/engine/src/task/desktop.ts:24-33`), and `packages/core/src/review/local-result.ts:26`'s own closed
  cost-kind literal. 21 Nov 2026: the task-bridge cost kinds are closed on branch `engine-core-fixes` (see "Codium
  finish: F6 cost kind on read", For the lead); `local-result.ts` stays open with VectorScope.
- F44 ("Codium finish: F44 sanitized lifecycle text", For the lead):
  - item 1, F44b's `sanitizeLegacy` pass-throughs (`export.ts:127-131`, `:250` and the parts listed there);
    21 Nov 2026: repaired on branch `engine-core-fixes` (see the F44b item above);
  - item 3, a CLI-level export check. Item 2 is completed above.
- P6 review addendum (For the lead):
  - item 1, an allowlist module out of `packages/core/src/brain/skill.ts`;
  - item 2, `ROLE` at `packages/core/src/playbooks/check.ts:137` against
    `packages/engine/src/orchestration/runs.ts:202`.
- P7 review addendum (For the lead) and `codium-p7-repairs.md`'s "For the lead" blocks:
  - R45-4(b), `packages/core/src/vault/github.ts:115-118`;
  - the A46 erasure tombstone check, `api/_lib/ops-incidents.ts:328-357` (a46 notes);
  - the other blocks name no defect in another lane's file.
- B10 (For the lead): the privacy-draft note, B10-3 and the "memory files" count wording.
- B09a and B09b (For the lead): Hands' second, helper-titled phone alert for a helper's ask
  (`packages/app/src/pages/layout/ask-notifications.ts:59-64`), and the `session-stop.test.ts` excess-field status.
  27 Nov 2026: both closed on branch `helper-alert-dedupe` (backlog B09-hands-alert). `ask-notification-controller.ts`
  skips Hands' phone push for a running helper (`helperOwnsAskPhoneAlert` in `helper-phone-alert.ts`), so the phone
  gets one root-titled push from `createHelperPhoneAlerts`; forks and helpers that are not running keep Hands' push.
  `sessionStop` spreads the payload before the path's `sessionID`, and the excess-field case is pinned to 200 with the
  extras dropped. The spread order is defensive: the schema already drops extras, so no test can turn red on it.
  Refusing extras with 400 to match `additionalProperties: false` stays open for the lead. CI: pending, not pushed.
- H1c's D1 and D2 and H2a's two hosted API fields: accept them, or move them to H1a.
- New from DZ:
  - the B11 shift recorded in the checkpoint, which is a decision on whether to re-measure both sources on one day;
  - this lane's PR description should cite this section, not the earlier "Lane status (8 Nov 2026)".

### What stays open

- B08 and A59 stay with the brain-transport lane (`v2-master-prompt.md` 8.4; checkpoint "A59 and launch gates").
- The estimate API's `{kind: "playbook"}` band (`api/_lib/model-plan-estimate.ts:275-277`; `codium-p6-repairs.md`
  R36-14).
- Server-side judging of Done by Morning reports. It waits for A60 and owner-accepted model captures
  (`codium-p8-repairs.md` "CI only and not done").
- The hosted git-token route (`codium-a54-hosted-image-notes.md:121`). It needs A59's repository binding and an S9
  decision.
- The Vercel CLI lockfile pin (`codium-p8-repairs.md` "CI only and not done"). It needs network access to update
  bun.lock.
- Phone job start, which needs an account-token design (`codium-a56-hosted-clients-notes.md:120` and `:143-144`). The
  phone already starts download-only sessions.
- The Cloudflare hosted-provider adapter, a stub that needs Cloudflare's written OK
  (`codium-a52-hosted-provider-notes.md:123`).
- Real-microVM checks of H1b's download mode and H2b's notice files. They need an owner image rebuild and
  `vector-codium-e2e.yml hosted: true` (H1 computer, "Unverified on a real computer"; H2 image notices, "Deferred
  verification").
- The H1b server gaps O1, O2, O4 and O6 (H1 computer section). O6, the charged download that cannot run, is a tracked
  defect.
- The owner's questions:
  - H1a's R2 (who pays a download-only block), R3 (the retention charge) and R4 (which plans may download);
  - H2a's refuse-only reading of below-floor rebuilds and its other owner decisions (`owner-actions/hosted-computer.md`,
    "The image floor").
- Track B (checkpoint):
  - B01's combined final checks;
    - 21 Nov 2026 (v2-closeout-ci): still open. Main's first test.yml push run after #56 (every lane but VectorScope),
      44885765033 at `153f9a22`, concluded failure: 31 of its 32 jobs that ran passed (unit, e2e, the desktop bundle,
      all six Linux and twelve Windows engine shards, and the other computer-helper jobs), and computer-helper mac-test
      (macos-15-intel) job 136798635643 failed at "Run required grant-free native checks" with
      `channel-eof: supervisor-pgrep-timeout` (30 passed, 1 skipped, 1 failed). That signature is not on the
      known-flake list, so it needs a root cause before B01 can close; the next push run, 44889277281 at `4fc245b6`, was
      still queued when this was written. Read through GitHub MCP.
  - B02 to B03 and B05, open on the PR #33 CI lanes;
  - B10-3, as recorded;
  - "validate all lanes together", with the lead's end-of-lane test.yml run.
- B11: the measurement and comparison are recorded, with no regression claim either way. Whether that meets B11's
  acceptance, or needs the same-day re-measurement, is the lead's call. Using the numbers anywhere else is the owner's.

### The owner's

A60 as a whole stays the owner's, and so does every account, key, price, rate, cap and retention day count. So do every
perk listing (`CODIUM_LISTED_PERKS`, `CODIUM_TRACK_B_LIVE`, the `VECTOR_HOSTED_ALLOW_ACCOUNTS` and
`VECTOR_OPS_ALLOW_ACCOUNTS` values), all legal and privacy text (`codium-privacy-proposed.patch` is never applied),
every release, `MODEL_PLANS_ENABLED` and `MODEL_PLANS_MIN_CLIENT`, and any public or comparative claim, the B11
measurement included. Nothing was enabled, listed, priced or published by this lane.

### Readings (package DZ)

- **R1. The table cells.** The checkpoint says its 12 Nov table "stays as written", which is why TB put its dated
  text in bullets. DZ's package text tells it to update the B09, B10 and B11 "Remaining acceptance" cells, so it
  appends one short dated sentence to each. The 12 Nov text is kept word for word, and the detail is in the dated
  bullets and the subsection. This departs from the "stays as written" sentence for those three cells only.
- **R2. The measured SHA.** The measured source is the pre-DZ head `66d0427b`, because DZ changes only docs. Measuring
  after the commit would measure the same app.
- **R3. The verdict rule** was written to `/tmp/vector-v2/codium/dz/verdict-rule.txt` at 23:12:13Z, before the
  dispatch at 23:12:18Z, so before any post-change number existed. It is stricter than the plan's rule:
  - it compares each median with 1.25 times the baseline median, not with the baseline maximum, whose cold first
    repeat (new session: 340.5 and 506.9 ms) would hide a doubling;
  - it leaves the child-session case out;
  - it fails on any retry or "flaky" line, and checks the run attempt.
- **R4. Runs already recorded** elsewhere are cited by their records and were not re-read. Only the unrecorded runs
  were read, and Hosted tests tails only where a line cites their counts (B10 and H2a). Elsewhere a vector-hosted-ci.yml
  run is cited by its conclusion.
- **R5. The date.** Every line says 15 Nov 2026, the day the dispatch was created (23:12:18Z). Writing may run past
  midnight UTC; the date is not moved.
- **Plan review.** All ten points were taken:
  - the stricter rule (R3);
  - the child-session caveat;
  - retries and flaky lines and the run attempt;
  - `timeline-stability/fixture.ts` and its import graph;
  - the B07 bullet and the a45 notes' line 103;
  - R1 stated honestly;
  - the 15/2/1 rule with `head_sha` checks;
  - the date (R5);
  - the parsing described in one sentence;
  - fewer reads (R4).

  Two were taken in part:
  - R36's vector-hosted-ci.yml run 43686386024 is cited by its conclusion, because its Hosted tests job id was not
    listed;
  - for four runs the 15/2/1 count rests on `failed_only` (one failed of 18), not a full job list.

### Ran locally

- git reads and diffs, including the harness diff, the renderer diff, `rev-list --count` and the import-graph walk;
- python parsing of the saved logs (scripts under `/tmp/vector-v2/codium/dz/tools/`);
- the full typecheck, `TURBO_CACHE_DIR=/home/user/wt/cf/.turbo/cache /home/user/.tools/vector-serial bun turbo
  typecheck --concurrency=2` (27 of 27 tasks, all cached because no code changed);
- the api tree, `bun typecheck --project ../../tsconfig.json` from `packages/engine` (clean).

No test file was added or changed, so no test ran.

### Only in CI

Every run cited above. The test.yml run 43773518841 is the one B11 `production_benchmark` dispatch, and it used no
keys or providers.

Edits to `api/_lib/model-plan-*.ts`: none. No MODEL-PLANS.md change (no new setting). No code, test, workflow, flag or
setting changed.

16 Nov 2026 (codium-finish lane, phase review). The phase review of the lane's packages adds four items to "What stays
open" and "For the lead" above. They are recorded in the next section:

- PR1, computers above a live plan's cap: a reading and an owner question;
- PR3, the charged download that can produce nothing: a listing gate for `computer`;
- PR5, the restore tally kept in three places: a lead follow-up;
- PR7, the cross-lane run-token fix: a lead decision before the PR (TB For the lead item 1 is corrected there).

## Codium finish: phase review fixes, codium-finish lane (16 Nov 2026)

A fix round for the phase review of the lane's packages, built on `codium-finish` `bd3cc7ad` (equal to
origin/codium-finish; PR #33 unmerged: origin/main `58f85edc`, origin/release-finish `0f034957`). Scratch is under
`/tmp/vector-v2/codium/review-fix/`. This step does not commit. The commit step commits, typechecks, pushes and
dispatches, and adds its run ids in a dated line after the runs.

Each finding below has an id, says whether reading the code confirmed it, and cites file:line in the worktree after
these fixes unless a line says otherwise.

### Findings

- **PR1 (non-blocking): computers above a live plan's cap cannot be downloaded.** Confirmed; no code change; recorded
  as reading R13 below and as an owner question in `owner-actions/hosted-computer.md`.
  - `hostedDownloadAccess` answers `live` whenever `snapshot.caps.hosted` is set (`api/_lib/hosted-entitlement.ts:124`).
  - `requireHostedDownload` then refuses with "Your plan includes the cloud computer. Start a session and ask for its
    files." (`:145`).
  - A session claims only computers 1 to `caps.computers` (CLAIM's upper bound).
  - `applyHostedTransition` sets no date while `liveHosted(to)` (`api/_lib/hosted-crons.ts:434-463`), and `keptDisks`
    offers nothing for `live` (`api/_lib/hosted-sessions.ts:1760`).
  - Not built: per-computer access needs a deletion date that §4.4 does not name (a retention day count is the
    owner's), a payer for the block and the retention (R2 and R3), and changes to `startHostedDownload`, `keptDisks`
    and the transition.
- **PR2 (non-blocking): a link after the nightly deletion pass.** Confirmed and fixed, the finding's first option.
  - The deletion pass in `runHostedNightly` now marks every session record whose files were packed
    (`download.erasedAt`, `api/_lib/hosted-sessions.ts:172`; `api/_lib/hosted-crons.ts:613-624`). It does this after
    the archives are erased and before the date is forgotten. A record that lapsed is skipped.
  - `requestDownload` (`hosted-sessions.ts:1255`) and `downloadRedirect` (`:1282`) answer 410
    `HOSTED_DOWNLOAD_UNAVAILABLE` "This session's files are no longer kept." when the mark is set. `downloadRedirect`
    then does not ask the bucket.
  - The doc comment (`:1235-1245`) now says so. The session view still carries `readyAt`, so no schema or client
    changed. The client copy "Its link works until ..." now follows only a link the server gave, and no such link
    outlives the date. What a client shows for this 410 was not re-read here.
  - Regression: `test/hosted-lifecycle.test.ts` "at the date the disks and their packed files are deleted; the
    download link answers 404 or 410" (`:375`). After the pass, the late ask now answers 410; before the fix it
    answered 200 with a link. The record carries `erasedAt`, and a link minted for the session leads to 410. Two
    mutations each failed the case: dropping the check, and dropping the mark.
- **PR3 (non-blocking): a download-only start can be charged and produce nothing.** Confirmed; no code change; kept as
  a listing gate for `computer` (`owner-actions/hosted-computer.md`, "Download-only starts (H1a)").
  - `launchSession` charges the retention (`hosted-sessions.ts:690`) before the computer has shown it can run
    download mode.
  - O6: a disk from before signed heartbeats is refused on every beat.
  - O4: a HEAD that never matches is never asked again.
  - H2a's `hosted:generation:<account>` holds signed beats only, so a disk that never reported a generation cannot be
    told apart from a new one.
  - PR9 makes the retention a held charge, but it is still taken before any upload.
  - Before listing:
    - charge the retention only once the first upload is confirmed, or give it back when no signed beat arrives in the
      block;
    - answer a definitive HEAD mismatch with `pack` or `upload` (O4).
  - Not built here. It moves the charge into the heartbeat's upload confirmation, which needs either a hold that
    outlives the block or a later unheld debit, and an unheld debit brings back PR9's M2 race. O4 is a server and
    schema change. H1b's F3 reading stands: the minutes the computer ran are charged (M8).
- **PR4 and PR7 (non-blocking and blocking): `31ddb43b` edits another lane's file.** Confirmed. Not reverted, because
  reverting without a replacement brings back "Codium: 119/120".
  - The commit edits `api/_lib/cloud-agents-run-token.ts:57`, a brain-transport file, and
    `test/api-module-loading.test.ts`.
  - The TB section's For the lead item 1 said this lane would not fix it. A dated correction line now follows the
    section's `31ddb43b` receipts. It says the codium-finish lane's agent made the fix itself, that release-finish and
    brain-transport still need it, and what the lead must decide.
  - Checked on 16 Nov 2026: origin/release-finish `0f034957` and origin/brain-transport `09a6387a` still have
    `Schema.isPattern(METER_EPOCH_PATTERN)` at `:57`.
- **PR5 (non-blocking): the restore tally and its wording exist three times.** Confirmed; not changed in this round;
  handed to the lead.
  - The three copies are `packages/engine/src/cli/cmd/vault.ts:481` and `:515`,
    `packages/desktop/src/main/vault-backup.ts:570-584` and
    `packages/app/src/components/settings-v2/memory-backup-model.ts:87-100`.
  - Why not here: a shared module needs a browser-safe core vault entry, and the app imports no core vault module
    today. That would change the exports and an import direction across core, app, desktop and engine.
  - Why no shared table test either: the desktop's tally runs inline in the restore IPC handler, which stops a
    file's parts at its first unreadable part, so a test can reach it only once it is extracted.
  - Both options are a package of their own.
- **PR6 (non-blocking): drifted line citations in the H1 record.** Confirmed. A dated line at the end of "Codium
  finish: H1 download-only start" says the numbers are as of `ae7280f8` and gives the current ones. The original text
  is unchanged.
- **PR8 (non-blocking): the H1a waiver keys outlive an erased computer.** Confirmed in part and fixed.
  - `eraseHostedComputer` now deletes `hosted:download-egress:<account>:<n>` and
    `hosted:download-uploaded:<account>:<n>` with the computer (`hosted-sessions.ts:1839-1844`).
  - `eraseAccountHosted` and the nightly deletion pass delete both keys for every number from 1 to `MAX_COMPUTERS`
    (`downloadKeys`, `hosted-crons.ts:492`, used at `:538` and `:629`), not only for the numbers still in the set.
  - Not confirmed: "keeps keys named by its account id until they expire" after a whole account deletion. The last
    erase part, `eraseAccountKeys` (`api/_lib/codium-erase.ts:191`), deletes every key whose name carries the account
    id, these two included.
  - What was confirmed:
    - the cloud computer's own part (the `hosted` provisioner on `closing`, and a deletion whose later parts are
      pending) left them;
    - the waiver offset the egress of a computer made again under the same number.
  - Regressions:
    - `test/account-delete.test.ts` `seedEverything` (`:429-436`) seeds both keys for computers 1 and 2, and 2 is a
      number the set no longer holds. "Worker outage" (`:1241`) reads the store after the computer part ran and
      before the sweep; it failed with the old set-only delete.
    - `test/hosted-lifecycle.test.ts` "erasing a computer drops its download waiver: one made again under its number
      pays its own egress (P5)" (`:435`) moves to a plan without a computer, uploads 4 GB, erases computer 1, moves
      back and makes computer 1 again. The new computer's 3 GB of egress is all charged. Without the delete in
      `eraseHostedComputer` the case failed.
- **PR9 (non-blocking): the retention's M2 race.** Confirmed and fixed with the finding's second option (reading R14
  below).
  - `chargeRetention` (`api/_lib/hosted-ledger.ts:920`) sizes the days from `finalPoolAvailable`. `holdRetention`
    (`:972`) then holds exactly that charge with `holdPool(account, usd, RETENTION_HOLD_MS, "hosted", {final})`, and
    `PoolHold.settle` settles it at once at that amount.
  - A `monthly` refusal sizes the days once more from what is left. A second refusal grants none, and the disk is
    kept at Vector's cost (R3).
  - A hold whose pool is not the key that was read is given back and refused (503). `launchSession` then closes the
    block at its start, and nothing is charged.
  - `final` comes from `startHostedDownload`'s plan answer (`download: {final}` on `launchSession`'s input), so the
    retention is held from the same kind of period as the block.
  - The ledger header and the `test/codium-pool.test.ts` "A51 obligation" tripwire now list the second producer
    (`hosted-ledger.ts: holdPool(` twice). The tripwire's comment is its review.
  - Regression: `test/hosted-ledger.test.ts` "two computers' retentions charged at the same moment never take more
    than the final period has (M2)" (`:841`). Two concurrent `chargeRetention` calls on computers 1 and 2 run against
    0.66 available. They grant 14 and 6 days, with debits of 440,132 and 188,628 micro-dollars, 628,760 in all. With
    the old logic both granted 14 days (880,264) and the case failed.
  - The existing retention case now also checks that the debit is applied and nothing is left held.
  - Not built: a start-level case with two concurrent download starts. It needs an ended three-computer plan with two
    kept disks. The race is inside `chargeRetention`, which the ledger case drives directly.

### Readings

- **R13 (H1a addendum), computers above a live plan's cap.** After a move to a plan with fewer computers (Ultra's
  three to Max's one), computers 2 and 3 keep their disks only as long as the provider keeps them: a stopped
  computer's disk lasts the `diskDays` of the session that last ran it (`hosted-provider.ts:289`, `retentionMs`). The
  server sets no date for them, offers no download-only start (409, whose advice cannot work for them) and shows no
  kept offer. Their files can be fetched only by moving back to a plan that includes them. Owner question, no
  amounts: whether such a computer should be downloadable, with what deletion date and who pays its block and
  retention. If yes, the build is to treat a number above `caps.computers` as `current` in a per-computer access
  check, set a date for those disks at the transition, and let `keptDisks` offer them.
- **R14 (H1a R3 addendum), the retention under M2.** The retention is taken up front at a known moment, so the A51
  reason for an unheld debit (a charge that accrues before anything could hold it) does not apply. It is now held
  through the pool's common HOLD, the same held set, fence and available figure as blocks and model requests (M2,
  M3), and never settled above its hold. The days are still sized from the period's available figure. The hold only
  makes that figure binding, so R3's outcomes stand: fewer paid days when the period is tight, the first deletion
  date, and a failed start keeping its line. `RETENTION_HOLD_MS` (5 minutes) bounds a hold that a crash leaves
  between hold and settle; it then lapses with nothing charged, and the next start charges again. The daily share is
  not checked for it, as it was not for the unheld debit this replaces: it is a once-per-computer charge at a plan's
  end, not daily use. The owner may add the check.
- **R15, the erase mark.** `download.erasedAt` is written only by the nightly deletion pass, on records that had
  packed files. Account deletion deletes the records instead. A record keeps its other fields, so the drift check and
  the true-up still read it.

### Disagreements

- PR8, in part: a whole account deletion did not leave the keys, because the last part sweeps them. The fix still
  makes the cloud computer's part complete on its own, as P5's part list expects.
- PR5: not done in this round, for the reasons above.
- PR1 and PR3: recorded as an owner question and a listing gate, not built, as each finding allows.
- PR9: the regression drives `chargeRetention` directly instead of two full starts.

### For the lead

1. PR4 and PR7: decide on `31ddb43b` before this lane's PR. Either accept the cross-lane edit explicitly, or have the
   brain-transport or PR #33 lane land the same two-file change and keep one copy when main is merged in. TB item 1
   stays open until release-finish carries it.
2. PR5: a follow-up package for the restore tally. It can be a browser-safe core module next to `Vault.SECTIONS`
   that the engine, desktop and app import, or a shared table test once the desktop's tally is extracted.
3. PR1 and PR3 are the owner's (owner-actions). No new defect was found in another lane's file in this round.

### Ran locally

All runs went through `vector-serial`, one file at a time from `test/` with `--timeout 30000`, after the last code
edit:

| Test file | Pass | Fail | Skip |
| --- | --- | --- | --- |
| `hosted-ledger.test.ts` | 32 | 0 | 1 |
| `hosted-sessions-api.test.ts` | 59 | 0 | 1 |
| `hosted-lifecycle.test.ts` | 22 | 0 | 0 |
| `account-delete.test.ts` | 37 | 0 | 1 |
| `codium-pool.test.ts` | 29 | 0 | 0 |
| `hosted-reaper.test.ts` | 26 | 0 | 0 |
| `hosted-provider.test.ts` | 39 | 0 | 0 |
| `hosted-jobs.test.ts` | 32 | 0 | 1 |
| `hosted-clients.test.ts` | 12 | 0 | 0 |
| `hosted-internal.test.ts` | 12 | 0 | 0 |
| `hosted-copy.test.ts` | 6 | 0 | 0 |
| `api-module-loading.test.ts` | 2 | 0 | 0 |

Five mutations each failed their case and were then restored from saved copies:

- the old retention logic;
- no delete in `eraseHostedComputer`;
- no `erasedAt` check;
- no `erasedAt` mark;
- the old set-only delete in `eraseAccountHosted`.

Typechecks were clean: `packages/engine` `bun typecheck --project ../../tsconfig.json` (api and test),
`packages/web` `bun typecheck`, and the full `bun turbo typecheck --concurrency=2` (27 of 27 tasks, 20 cached).

`git diff --check` was clean. `packages/engine` `test/compliance/upstream-free.test.ts`, which scans every tracked
file's working-tree text, gave 11 pass and 1 fail. The scan case passed. The failure is the known non-hermetic `:148`
case (TB For the lead item 7), which reads this machine's provider environment.

Formatting: `prettier --write` ran on `api/_lib/hosted-ledger.ts` and `test/hosted-ledger.test.ts`, and `--check` on
`test/codium-pool.test.ts`; all three were formatted at HEAD. `hosted-sessions.ts`, `hosted-crons.ts`,
`hosted-lifecycle.test.ts` and `account-delete.test.ts` were not formatted at HEAD, so only the added lines were
wrapped.

### Only in CI

- The Valkey cases: `codium-pool.test.ts`'s HOLD on real Lua, the ledger's script case and the sessions CLAIM case.
- The Postgres ledger, where the new M2 case's lines come from the real SQL.
- vector-hosted-ci.yml's Hosted tests.
- This step's own Vector Codium, typecheck.yml and vector-hosted-ci.yml dispatches, which run after the lead's
  commit.

Files touched:

- `api/_lib/hosted-ledger.ts`, `api/_lib/hosted-sessions.ts`, `api/_lib/hosted-crons.ts`;
- `test/hosted-ledger.test.ts`, `test/hosted-lifecycle.test.ts`, `test/account-delete.test.ts`,
  `test/codium-pool.test.ts`;
- `docs/vector/build/codium-deviations.md`, `docs/vector/owner-actions/hosted-computer.md`,
  `docs/vector/MODEL-PLANS.md`.

Edits to `api/_lib/model-plan-*.ts`: none. `hosted-ledger.ts` imports the `PoolHold` type from
`model-plan-account.ts` and does not change that file. No new setting.

16 Nov 2026 (codium-finish lane, phase review round two). The second review round changed three things this section
says. They are recorded in the next section:

- PR9 and R14: the retention is now checked against the daily share before its hold, and a `stale` refusal of its hold
  is sized again too, not only a `monthly` one. R14's sentences "The daily share is not checked for it" and "The owner
  may add the check" no longer hold (R16 and R17 there).
- PR2: "A record that lapsed is skipped" now also holds for a record that lapses between the pass's read and its
  write (PR11 there).
- Line numbers moved: `chargeRetention` is at `hosted-ledger.ts:922` (cited as `:920`), `holdRetention` at `:977`
  (cited as `:972`), and the marking loop at `hosted-crons.ts:616-628` (cited as `:613-624`).

## Codium finish: phase review fixes, round two, codium-finish lane (16 Nov 2026)

The second round of the phase review, on the first round's fixes. It is built on `codium-finish` `bd3cc7ad` with the
first round's uncommitted changes in the worktree; neither round is committed. Scratch is under
`/tmp/vector-v2/codium/review-fix2/`. This step does not commit. The commit step commits both rounds, typechecks,
pushes and dispatches, and adds its run ids in a dated line after the runs.

Each finding below has an id (continuing the first round's PR1 to PR9), says whether reading the code confirmed it,
and cites file:line in the worktree after these fixes.

### Findings

- **PR7 again (blocking, listed twice in this round): `31ddb43b` edits brain-transport's
  `api/_lib/cloud-agents-run-token.ts:57` and `test/api-module-loading.test.ts`.** Confirmed; no lane change, as both
  entries say. The lead decides before the lane's PR. One option is to accept the cross-lane edit explicitly. The other
  is to have the brain-transport or PR #33 lane land the same two-file change and keep one copy when main is merged in.
  - Kept open: TB For the lead item 1 under "Lane status (15 Nov 2026, codium-finish)" (with its dated correction after
    the `31ddb43b` receipts), and item 1 of the first round's For the lead.
  - Not re-fetched in this round. The first round's fetch (origin/release-finish `0f034957`, origin/brain-transport
    `09a6387a`, both still without the change) is the last reading.
- **PR10 (non-blocking): a retention whose hold meets another's settle is refused, not sized again.** Confirmed and
  fixed.
  - `PoolHold.settle` runs `applyPoolDebits`, whose `convergeKey` rewrites the account record with the key's new limit
    (`api/_lib/model-plan-account.ts:2340-2349`).
  - HOLD's final fence compares the stored record with the one `finalPoolCredential` read and answers `stale`
    (`api/_lib/codium-pool.ts:253`), which `placeHold` throws as 503 `MODEL_PLAN_RENEWING` (`:463`).
  - `holdRetention` now treats that refusal like a `monthly` one while a try is left: it reads the available figure
    and the credential again and sizes the days once more (`api/_lib/hosted-ledger.ts:997-1001`). On the last try the
    503 goes to the start, which fails with nothing charged and is tried again. The bound stays two tries.
  - Regression: `test/hosted-ledger.test.ts` "a retention whose credential another retention's settle made stale is
    sized again, not refused (M2)" (`:874`). A fetcher gate holds computer 2's HOLD after its reads. Computer 1's
    retention then holds and settles (14 days), and the case checks that the account record changed. Released,
    computer 2 is granted 6 days from the 0.22 left, with debits of 140 and 60 GB-days and nothing left held. With the
    retry removed, the case failed with `MODEL_PLAN_RENEWING`.
- **PR11 (non-blocking): a record that lapses during the marking loop fails the whole account for the night.**
  Confirmed and fixed with the finding's first option.
  - `updateSessionRecord` throws 404 `HOSTED_SESSION_NOT_FOUND` when the record is gone (`api/_lib/hosted-sessions.ts:291`).
  - The loop now catches that 404 for that id only and goes on (`api/_lib/hosted-crons.ts:616-628`). Every other error
    still fails the account, which stays due.
  - Regression: `test/hosted-lifecycle.test.ts` "a session record that lapses while the deletion pass marks it is
    skipped; the account is still deleted" (`:435`). The fetcher deletes the record right after the pass's read, once
    the archive was erased. The pass answers `deleted: 1, failed: 0`, and the computers, the packed files and the due
    entry are gone. Without the catch, the case failed (`deleted: 0, failed: 1`).
- **PR12 (non-blocking): a DNS-over-HTTPS answer of exactly 64 KiB read as a failed lookup.** Confirmed and fixed with
  the finding's first option.
  - `lookup` reads to 64 KiB and one byte more and requires `complete`, as `index.ts:46` does for internal bodies
    (`packages/ops-worker/src/ssrf.ts:206`). The comment now says "an answer longer than 64 KiB".
  - Regression: `packages/ops-worker/test/ssrf.test.ts` "an answer is read only to 64 KiB ..." (new lines from `:298`).
    An answer of exactly 65,536 bytes resolves `public` and one of 65,537 is `error`. The 1 KiB-chunk stream is now
    pulled 65 times, not 64, then cancelled once. With the old limit, the exactly-64-KiB answer failed.
  - R46-1's record says "An answer of 64 KiB or more ... is a failed lookup". A dated line under R46-1 in
    `codium-p7-repairs.md` now says that changed. The a46 notes' "at most 64 KiB" still holds.
- **PR13 (non-blocking): `restorable`'s comment promises every part stays under SKILLS_CHARS.** Confirmed in part;
  fixed with the finding's second option (the comment, and a regression for one oversize skill).
  - Confirmed: a single skill longer than SKILLS_CHARS becomes a part above it (`packages/engine/src/brain/vault-memory.ts:105`).
  - Not confirmed: "the whole skills file of that repository is refused". The loop never adds a skill to a part
    already past the limit, and never adds another to the oversize one, so that skill is alone in its part. Only that
    part can be refused, and only past IMPORT_CHARS (`packages/engine/src/server/routes/instance/httpapi/groups/memory.ts:276`).
  - The comment (`vault-memory.ts:95-104`) now says a skill longer than SKILLS_CHARS gets a part of its own. It
    restores while that part fits in IMPORT_CHARS, and past it only that part is refused.
  - This also corrects "Codium finish: B10 acceptance (15 Nov 2026)", whose edge case says such a skill's restore
    "would count it unreadable". It does not while its part fits in IMPORT_CHARS, as the regression shows.
  - Regression: `packages/engine/test/server/memory-vault.test.ts` "a skill longer than a part by itself gets a part of
    its own, and every part still restores" (`:353`). One skill of about 1.6 million characters (20 paths of about
    80,000) is imported between two short ones. Its part holds it alone and is longer than SKILLS_CHARS and no longer
    than IMPORT_CHARS. The other parts stay under SKILLS_CHARS, and all three skills restore into another repository
    with nothing refused.
- **PR14 (non-blocking, two entries): the A51 notes still describe the unheld debit.** Confirmed. A dated 16 Nov 2026
  line follows the "Nightly and retention" bullet of `codium-a51-hosted-core-notes.md` (`:51`); the bullet is
  unchanged. The line names the input `{computer, gb, days, final, snapshot}` and the daily check. It also names the
  hold `holdPool(…, RETENTION_HOLD_MS, "hosted", {final})` settled at once, the second try on `monthly` or `stale`,
  and the tripwire's second reviewed producer. It cites PR9, R14 and this section.
- **PR15 (non-blocking): the retention skipped the A17 producer rule's daily share.** Confirmed; fixed with the
  finding's option (a).
  - The rule is `codium-a17-admission-notes.md:328-339` ("Before a producer calls `holdPool` it must enforce the
    shared day ..."). `openBlock` checks it for the block in the same start (`hosted-ledger.ts:404`).
  - `holdRetention` now calls `requireDailyRoom(account, input.snapshot, chargeMicro, …)` before its hold
    (`hosted-ledger.ts:992`). It checks today's spend, the block's live hold included, plus the retention against the
    day's share. A day that cannot fit it refuses with 429 `MODEL_PLAN_DAILY_LIMIT` (retry tomorrow) before anything is
    held. `launchSession` then closes the block at its start, and nothing is charged.
  - `chargeRetention` takes the snapshot as input (`:922`). `startHostedDownload` passes its `requireHostedDownload`
    answer, `{snapshot, final}`, as `launchSession`'s `download` (`hosted-sessions.ts:842`). `launchSession` passes
    both on (`:697-698`).
  - The ledger header, `chargeRetention`'s and `launchSession`'s comments, the `codium-pool.test.ts` tripwire comment
    and MODEL-PLANS.md now say so.
  - Regression: `test/hosted-ledger.test.ts` "a retention the day's share cannot fit refuses with nothing charged, as
    the start's block would (A17)" (`:908`). With 19 of Max's 19.20 a day held from the final period, the retention
    is refused with 429 `MODEL_PLAN_DAILY_LIMIT`: no `hr-` debit, no line, and only the earlier hold held. Once that
    hold is given back, the same retention is granted 14 days. With the call removed, the case failed.
  - Since (a) was built, no exception line was added to `codium-a17-admission-notes.md`.

### Readings

- **R16 (R14 amended), the retention and the daily share.** The retention now meets A17's producer rule as the block
  does: it is checked before its hold, and not atomically with it. The check reads the day as status counts it, and a
  model request admitted in between can pass it by at most the retention (the same gap `requireDailyRoom`'s comment
  names for a block). The day is checked against the start's snapshot, the one `final` comes from. `openBlock` reads
  the plan again for the block a moment later and does not return it, so the two checks use two reads of the same
  plan. A day that cannot fit the retention refuses the start rather than paying fewer days: R3's "fewer days" stays
  for the period's available figure only, because a day's refusal lifts the next day.
- **R17 (R14 amended), the retention's second try.** A `stale` refusal says nothing about money, so on the last try it
  is not "grant none" as a `monthly` refusal is. It is the start's 503 `MODEL_PLAN_RENEWING`, and the start is tried
  again. With three computers' retentions charged at once, two settles inside one start's window can still give that
  start a 503. The bound stays two, as the finding asks.

### Disagreements

- PR13: "the whole skills file of that repository is refused" is not what the code does (above). The fix is the
  finding's second option. Leaving the skill out would lose it from the backup with nothing to say so. Counting it
  needs a new field in the backup's result, which the engine CLI, the desktop and the app each tally (PR5's three
  copies).
- PR15: the retention uses the start's snapshot, not the block's own read (R16).
- PR10: a second `stale` refusal is the start's 503, not "grant none" (R17).

### For the lead

1. PR7 (both entries): unchanged from the first round's item 1. Decide on `31ddb43b` before this lane's PR.
2. No defect was found in another lane's file in this round.

### Ran locally

All runs went through `vector-serial`, one file at a time with `--timeout 30000`, after the last code edit. Root files
ran from `test/`, package files from their package. The engine file ran with fresh XDG roots under the scratch folder.

| Test file | Pass | Fail | Skip |
| --- | --- | --- | --- |
| `hosted-ledger.test.ts` | 34 | 0 | 1 |
| `hosted-lifecycle.test.ts` | 23 | 0 | 0 |
| `hosted-sessions-api.test.ts` | 59 | 0 | 1 |
| `codium-pool.test.ts` | 29 | 0 | 0 |
| `account-delete.test.ts` | 37 | 0 | 1 |
| `hosted-reaper.test.ts` | 26 | 0 | 0 |
| `hosted-jobs.test.ts` | 32 | 0 | 1 |
| `hosted-clients.test.ts` | 12 | 0 | 0 |
| `hosted-internal.test.ts` | 12 | 0 | 0 |
| `hosted-provider.test.ts` | 39 | 0 | 0 |
| `hosted-copy.test.ts` | 6 | 0 | 0 |
| `api-module-loading.test.ts` | 2 | 0 | 0 |
| `packages/ops-worker` `test/ssrf.test.ts` | 12 | 0 | 0 |
| `packages/engine` `test/server/memory-vault.test.ts` | 9 | 0 | 0 |

Four mutations each failed their own case, and only that case, and were then restored from saved copies:

- no `MODEL_PLAN_RENEWING` retry in `holdRetention` (the stale case failed with `MODEL_PLAN_RENEWING`);
- no `requireDailyRoom` call in `holdRetention` (the daily case failed);
- no 404 catch in the marking loop (the lapse case answered `deleted: 0, failed: 1`);
- the old 64 KiB read limit (the exactly-64-KiB answer failed).

Typechecks were clean: the full `bun turbo typecheck --concurrency=2` (27 of 27 tasks, 25 cached) and
`packages/engine` `bun typecheck --project ../../tsconfig.json` (api and test). `git diff --check` was clean.

`packages/engine` `test/compliance/upstream-free.test.ts` gave 11 pass and 1 fail. The scan case passed. The failure is
the known non-hermetic `:148` case (TB For the lead item 7).

Formatting: `prettier --check` passed on `api/_lib/hosted-ledger.ts`, `test/hosted-ledger.test.ts`,
`test/codium-pool.test.ts`, `packages/ops-worker/src/ssrf.ts` and `packages/ops-worker/test/ssrf.test.ts`, all of them
formatted at HEAD. `hosted-sessions.ts`, `hosted-crons.ts`, `hosted-lifecycle.test.ts`, `vault-memory.ts` and
`memory-vault.test.ts` were not formatted at HEAD, so only the added lines were wrapped to 120 columns. The two test
names longer than that stay on one line, as prettier keeps a test call's name.

Not run locally: `packages/engine` `test/cli/vault.test.ts`, since `vault-memory.ts` changed only in a comment.

### Only in CI

- The Valkey cases: `codium-pool.test.ts`'s HOLD on real Lua, the ledger's script case and the sessions CLAIM case. The
  new stale and daily cases run on the in-memory store only. Their HOLD fence and day count are the emulation in
  `packages/web/test/fixture/codium-spend-emulation.ts`.
- The Postgres ledger, where the new cases' lines come from the real SQL.
- vector-hosted-ci.yml's Hosted tests (`packages/ops-worker`, `test/hosted-*`) and its ops Worker miniflare smoke.
- The commit step's Vector Codium, typecheck.yml and vector-hosted-ci.yml dispatches, which run after the lead's
  commit.

Files touched in this round:

- `api/_lib/hosted-ledger.ts`, `api/_lib/hosted-sessions.ts`, `api/_lib/hosted-crons.ts`;
- `packages/ops-worker/src/ssrf.ts`, `packages/engine/src/brain/vault-memory.ts` (a comment only);
- `test/hosted-ledger.test.ts`, `test/hosted-lifecycle.test.ts`, `test/codium-pool.test.ts` (a comment only),
  `packages/ops-worker/test/ssrf.test.ts`, `packages/engine/test/server/memory-vault.test.ts`;
- `docs/vector/build/codium-deviations.md`, `docs/vector/build/codium-a51-hosted-core-notes.md`,
  `docs/vector/build/codium-p7-repairs.md` (dated lines under R45-10 and R46-1), `docs/vector/MODEL-PLANS.md`.

Edits to `api/_lib/model-plan-*.ts`: none. No new setting, route, schema field or client change. A download-only start
can now also answer 429 `MODEL_PLAN_DAILY_LIMIT` from its retention; its block's own check could already answer it, so
what a client shows for that code was not changed or re-read.

16 Nov 2026 (codium-finish lane, phase review round three). The third review round changed three things the first two
rounds' sections say. They are recorded in the next section:

- R15 ("`download.erasedAt` is written only by the nightly deletion pass"): `eraseHostedComputer` now writes it too, on
  the records of the sessions on the computer it deletes, and deletes their packed files first (PR16, R19).
- PR8: deleting a computer now also deletes its last provider reading (`hosted:usage`), as the nightly pass and
  account deletion do.
- PR9 and PR15 (`chargeRetention`): its input now also carries the kept window's deletion date (`due`), its ref names
  that window instead of the period (PR18, R18), and it answers `{days}` only (PR19).

## Codium finish: phase review fixes, round three, codium-finish lane (16 Nov 2026)

The third round of the phase review, on the first two rounds' fixes. It is built on `codium-finish` `bd3cc7ad` with
both earlier rounds' uncommitted changes in the worktree; no round is committed. Scratch is under
`/tmp/vector-v2/codium/review-fix3/`. This step does not commit. The commit step commits all three rounds,
typechecks, pushes and dispatches, and adds its run ids in a dated line after the runs.

Each finding below has an id (continuing PR1 to PR15), says whether reading the code confirmed it, and cites file:line
in the worktree after these fixes.

### Findings

- **PR16 (non-blocking): deleting a computer left its sessions' packed files.** Confirmed and fixed with the finding's
  first option.
  - `eraseHostedComputer` deleted the computer, its generation entry, its H1a waiver and upload keys, its set member
    and its name. It did not delete the packed files of that computer's sessions (`archiveKey(account, id)`), and did
    not mark their records. `requestDownload` then still gave links for any of them whose `download.readyAt` was set,
    a download-only session's full copy of the disk included, and `downloadRedirect` still served them until the
    bucket's own rule removed the object. The comment's "nothing named by the account outlives the computer (P5)" did
    not hold.
  - Now, after `destroyHostedComputer` (`api/_lib/hosted-sessions.ts:1873`), it reads the account's session ids
    (`ZRANGE hosted:sessions:<account> 0 -1`) and keeps those whose record is the account's, names this computer and
    has `download` (an upload is signed only once `download` is set, `:1674`). It deletes their packed files
    (`deleteArchives`, `:1889`) and marks each record that had them ready (`markArchivesErased`, `:1890`). Only then
    are the computer's keys, set member and name removed, so a bucket that cannot be reached fails the deletion with
    503 while the computer is still listed, and the person asks again.
  - The delete loop of `eraseSessionArchives` is now `deleteArchives` (`:1230`), which deletes exactly the ids it is
    given. `eraseSessionArchives` itself could not be reused here: it also deletes every session in
    `hosted:archives:<account>`, other computers' included.
  - The nightly pass's marking loop is now `markArchivesErased` (`:1251`), called from `runHostedNightly`
    (`api/_lib/hosted-crons.ts:616`) with the same 404-tolerant update. The lapse case below still passes on it.
  - Parity, as the finding suggests: the computer's last provider reading (`hosted:usage`, HASH name → reading) is
    deleted with it (`:1901`), as the nightly pass and `eraseAccountHosted` do. `hostedUsageKey` moved from
    `hosted-crons.ts` to `hosted-sessions.ts` (`:156`), next to `hostedNamesKey`, because `hosted-crons.ts` imports
    `hosted-sessions.ts` and not the other way round. Nothing else imported it.
  - Regression: `test/hosted-lifecycle.test.ts` "erasing a computer drops its download waiver: one made again under
    its number pays its own egress (P5)" (`:464`). A download-only session on the kept disk uploads and gets a link
    (200). The erase then deletes exactly that object (the R2 DELETE seen), the record carries `erasedAt`, the disk's
    date still stands, a new ask answers 410 "This session's files are no longer kept.", the earlier link answers 410,
    and the seeded `hosted:usage` entry is gone. Two mutations each failed this case only: no archive deletion and
    mark, and no `hosted:usage` delete.
- **PR17 (non-blocking): `HOSTED_DOWNLOAD_UNAVAILABLE` has two statuses while the table names one.** Confirmed; the
  finding's first option (reading R20 below).
  - `Hosted.ERROR_CODES` declares it 409 (`packages/schema/src/hosted.ts:79`). `requestDownload` answers 410 when the
    disk's date passed or `erasedAt` is set (`api/_lib/hosted-sessions.ts:1299`), and `downloadRedirect` answers 410
    for `erasedAt` (`:1326`) and for a missing object (`:1332`, A54's). Every start refusal, and a request for files
    that were never packed, answers 409.
  - The table's comment now names both statuses (`hosted.ts:77-78`), and `requestDownload`'s doc comment says which
    is which. The H1 section has a dated line.
  - Pin: `test/hosted-copy.test.ts` "HOSTED_DOWNLOAD_UNAVAILABLE is the table's 409 for what cannot be served and 410
    for files that are gone" (`:184`). A download-only session uploads and gets a link; past the disk's date a new
    start answers the table's status (409) and the ask answers 410, both with that code; the table says 409. With
    `requestDownload` answering 409 for gone files, the case failed.
- **PR7 again (blocking, listed twice in this round): `31ddb43b` edits brain-transport's
  `api/_lib/cloud-agents-run-token.ts:57` and `test/api-module-loading.test.ts`.** Confirmed; no lane change, as both
  entries say. The lead decides before the lane's PR: either accept the cross-lane edit explicitly, or have the
  brain-transport or PR #33 lane land the same two-file change and keep one copy when main is merged in.
  - Read again in this round from the worktree's remote-tracking refs (not fetched): origin/release-finish `b0752dda`
    has `Schema.isPattern(METER_EPOCH_PATTERN)` at `:52`, and origin/brain-transport `1d36447e` has it at `:57`. Neither
    carries the change, so the branches still diverge there.
  - Kept open: TB For the lead item 1 (with its dated correction) and item 1 of the first two rounds' For the lead.
- **PR18 (non-blocking): one kept window could be charged twice.** Confirmed and fixed with the finding's first
  option.
  - The retention's ref was `hr-<computer>-<subscription>-<start>`, keyed on the pool period. `applyHostedTransition`
    sets the disk's date once (`ZADD NX`, `hosted-crons.ts:473`) and returns early between two states without a
    computer (`:464`). So a `current` plan whose 14-day window crossed a renewal charged another `ENDED_DISK_DAYS` at a
    second download-only start in the new period ("Pack them again", or a new start after the first ended). An ended
    plan already charged that came back on a plan without a computer did the same.
  - Now the ref names the window: `hr-<computer>-<due>`, where `due` is the account's `hosted:disk-due`
    (`api/_lib/hosted-ledger.ts:944`). `chargeRetention` takes `due` as input and refuses anything but a positive whole
    number (`:938`). `startHostedDownload` passes the date it already read (`hosted-sessions.ts:853`), and
    `launchSession` passes it on (`:709`). A later start in the same window answers the first grant, whichever period
    it is held from.
  - The ref fits `vector_hosted`'s pattern (`^h[bser]-[A-Za-z0-9_.:-]{1,197}$`) and stays one account's (the computer
    name carries the account's prefix). `docs/vector/owner-actions/sql/hosted.sql`'s comment on refs now says
    `hr-<computer>-<disk deletion date, ms>`; the SQL is unchanged.
  - Regression: `test/hosted-ledger.test.ts` "a kept window is charged once even when a renewal holds the next start
    from a new period (R3)" (`:929`). A `current` retention is charged in P1, the plan renews to P2 (a new key), and
    the same window's second retention answers `{days: 14}` with exactly one `hr-` debit (440,132) across both pools
    and one retention line filed under P1. A later window (another date) is charged once more. With the ref keyed on
    the window and the period, the case failed with two 440,132 debits.
  - Lines changed: `hosted-ledger.test.ts`'s retention cases name the window (`KEPT`, `:823`);
    `hosted-sessions-api.test.ts`'s `RETENTION` reads the account's date (`:931`); and `hosted-lifecycle.test.ts`'s
    ended case reads the date it already checks.
- **PR19 (non-blocking): `chargeRetention`'s `until` was not the disk's date.** Confirmed and fixed with the finding's
  first option: it answers `{days}` only (`hosted-ledger.ts:943`, `:946`, `:965`), and the doc comment says the disk's
  deletion date is `due`. Its only caller ignored the result. The ledger case that compared the whole answer now
  expects `{days: 14}`.

### Readings

- **R18 (R3 amended), once per kept window.** §4.4 keeps an ended plan's disks 14 days for download, and R3 charges
  that keeping to the period the first download-only start is held from. The window is named by its deletion date,
  which `applyHostedTransition` sets once and removes only when the plan includes a computer again (or the nightly
  pass deletes the disks). So one window is charged once, whichever period pays it, and a new window (a later end) is
  charged again. No line under the old ref can exist in production: the cloud computer is unlisted and
  `VECTOR_HOSTED_PROVIDER` is unset, so no migration is needed. If one did exist, a start in its window would be
  charged once more.
- **R19 (R15 amended), the erase mark.** `download.erasedAt` is now written by the nightly deletion pass and by
  `eraseHostedComputer`, on records whose packed files were ready, after those files were deleted. Account deletion
  still deletes the records instead. A record that lapsed (its own TTL, 35 days after the session ended) can give no
  link, so a computer's deletion cannot find that session's object and leaves it to the bucket's 2-day `hosted/` rule.
  Account deletion still finds it through `hosted:archives:<account>`.
- **R20 (PR17), 409 and 410.** One code, two statuses: 409 for a start or a request that cannot be served, 410 once a
  session's packed files are gone (the disk's date passed, or they were deleted with the disk), both on the person's
  request and on the download link. This is A53's own reading ("409 `HOSTED_DOWNLOAD_UNAVAILABLE` (410 once the files
  are gone)", A53's error-code bullet). The two new 410 paths follow it. The table keeps one status per code, so it
  stays 409 and its comment names both. The clients read the code and show the server's message whatever the status
  (`packages/app/src/features/cloud/hosted/hosted-model.ts:561`, `packages/desktop/src/main/hosted-client.ts:62`), so
  no client changes.

### Disagreements

- PR17: kept 410 for files that are gone rather than answering 409 on `requestDownload`, because A53 recorded that
  reading and the link route already answers 410 for the same case.
- PR16: `eraseSessionArchives` is not called for one computer, as the finding suggests, because it would delete every
  signed session's files, other computers' included. The new `deleteArchives` does the same deletion for exactly the
  computer's sessions.
- PR18: the regression drives `chargeRetention` across a real renewal at the ledger level instead of two full
  download-only starts.

### For the lead

1. PR7 (both entries): unchanged from the first two rounds' item 1. Decide on `31ddb43b` before this lane's PR.
2. No new defect was found in another lane's file in this round.

Lead ruling (16 Nov 2026): PR4 and PR7 are closed, in all three rounds, and with them TB For the lead item 1 and its
16 Nov correction. Main fixes the same import cycle in PR #33's round-two commit `9be63d68` ("fix(api): load the meter
epoch rule from a leaf module to break the ledger import cycle"): `METER_EPOCH_PATTERN` now lives in
`api/_lib/cloud-agents-epoch.ts`, which has no imports, and the ledger and the run token both import it from there.
Main's fix is the one copy. At the merge of main into `codium-finish` after PR #33 (`b362fdf6`), merge commit
"chore(codium): merge main after PR #33", `api/_lib/cloud-agents-run-token.ts` and `test/api-module-loading.test.ts`
resolve to main's version, so `31ddb43b`'s decode-time read is dropped. Nothing was added to main's version: its fresh
Node ESM entries already include the lane's two (`cloud-agents-ledger.ts`, `model-plan-gateway-hooks.ts`) plus
`hosted-run.ts` and the three `api/model-plans` routes, and on the merged tree `test/api-module-loading.test.ts` (2
pass), `packages/web` `test/model-plan-gateway-hooks.test.ts` (13 pass) and `test/cloud-agents-run-token.test.ts` (8
pass, the Redis setup case CI only) show no ReferenceError. The same merge settles TB item 6 as that item asked: it
keeps main's four-shard tests matrix and `--shard=i/n` picker split together with this lane's `base` and
`browser_specs` dispatch inputs and their env-only wiring, and the env-only test now also allows
`${{ matrix.shard }}`, a fixed matrix value like `${{ matrix.command }}`, in a run script.

### Ran locally

All runs went through `vector-serial`, one file at a time from `test/` with `--timeout 30000`, after the last code
edit; the two files changed by formatting ran again after it.

| Test file | Pass | Fail | Skip |
| --- | --- | --- | --- |
| `hosted-ledger.test.ts` | 35 | 0 | 1 |
| `hosted-lifecycle.test.ts` | 23 | 0 | 0 |
| `hosted-sessions-api.test.ts` | 59 | 0 | 1 |
| `hosted-copy.test.ts` | 7 | 0 | 0 |
| `account-delete.test.ts` | 37 | 0 | 1 |
| `hosted-reaper.test.ts` | 26 | 0 | 0 |
| `hosted-jobs.test.ts` | 32 | 0 | 1 |
| `hosted-clients.test.ts` | 12 | 0 | 0 |
| `hosted-internal.test.ts` | 12 | 0 | 0 |
| `hosted-provider.test.ts` | 39 | 0 | 0 |
| `codium-pool.test.ts` | 29 | 0 | 0 |
| `api-module-loading.test.ts` | 2 | 0 | 0 |

Four mutations each failed their own case, and were then restored from saved copies under the scratch folder:

- the retention ref keyed on the window and the period (`hr-<computer>-<due>-<start>`): only the renewal case failed,
  with two 440,132 debits. The old ref (`hr-<computer>-<subscription>-<start>`) also failed it, and the two ledger
  cases that name the ref;
- no archive deletion and mark in `eraseHostedComputer`: only the erase case failed;
- no `hosted:usage` delete there: only the erase case failed, at its usage check;
- `requestDownload` answering 409 for gone files: only the new `hosted-copy.test.ts` pin failed.

Typechecks were clean: `packages/engine` `bun typecheck --project ../../tsconfig.json` (api and test; run again after
the formatting), the full `bun turbo typecheck --concurrency=2` (27 of 27 tasks, 26 cached), and `packages/schema` and
`packages/web` `bun typecheck`. `git diff --check` was clean.

`packages/engine` `test/compliance/upstream-free.test.ts` (fresh XDG roots under `/tmp/vector-v2/codium-finish/xdg3/`)
gave 11 pass and 1 fail. The scan case passed. The failure is the known non-hermetic `:148` case (TB For the lead item
7).

Formatting: `prettier --write` ran on `api/_lib/hosted-ledger.ts` (unchanged) and `test/hosted-ledger.test.ts`, both
formatted at HEAD. `hosted-sessions.ts`, `hosted-crons.ts`, `packages/schema/src/hosted.ts`,
`hosted-lifecycle.test.ts`, `hosted-sessions-api.test.ts` and `hosted-copy.test.ts` were not formatted at HEAD, so only
the added lines were wrapped to 120 columns; test names longer than that stay on one line, as prettier keeps them.
Prettier ran on node directly, not through `vector-serial`, which queues Bun workloads.

### Only in CI

- The Valkey cases (`codium-pool.test.ts`'s HOLD on real Lua, the ledger's script case and the sessions CLAIM case).
  The new renewal case runs on the in-memory store only.
- The Postgres ledger, where the new ref goes through the real `vector_hosted` pattern check and primary key.
- vector-hosted-ci.yml's Hosted tests (`test/hosted-*`).
- The commit step's Vector Codium, typecheck.yml and vector-hosted-ci.yml dispatches, which run after the lead's
  commit.

Files touched in this round:

- `api/_lib/hosted-sessions.ts`, `api/_lib/hosted-crons.ts`, `api/_lib/hosted-ledger.ts`,
  `packages/schema/src/hosted.ts` (a comment only);
- `test/hosted-ledger.test.ts`, `test/hosted-lifecycle.test.ts`, `test/hosted-sessions-api.test.ts`,
  `test/hosted-copy.test.ts`;
- `docs/vector/build/codium-deviations.md` (this section, and dated lines after the H1 download-only section and after
  round two's section), `docs/vector/build/codium-a51-hosted-core-notes.md`,
  `docs/vector/build/codium-a53-hosted-sessions-notes.md`, `docs/vector/MODEL-PLANS.md`,
  `docs/vector/owner-actions/hosted-computer.md`, `docs/vector/owner-actions/sql/hosted.sql` (the refs comment only).

Edits to `api/_lib/model-plan-*.ts`: none. No new setting, route, schema field or client change. A computer's deletion
can now answer 503 when the media bucket cannot be reached and one of its sessions has packed files. No screen offers
the deletion yet; the app's `hostedErrorText` shows the server's message for any refusal.

## Codium finish: lane PR fixes, codium-finish lane (16 Nov 2026)

The last review before the lane's PR into main, on `a6288d72` (main `b362fdf6` merged in by `bc8cad48`). Five
non-blocking findings; none rejected.

- **Download links while the account is being deleted (`api/_lib/hosted-sessions.ts`).** `requireFilesAllowed` read
  only the stored snapshot. An account deletion sets the tombstone before codium-erase reaches its hosted step, so the
  snapshot may not say closing yet, and `downloadRedirect` has no caller check: a link given before the deletion still
  led to the packed files in that window. `requireFilesAllowed` now calls `requireAccountOpen` first, so
  `requestDownload` and the link route both answer 409 `MODEL_PLAN_ACCOUNT_CLOSING` once the tombstone exists. New
  assertions in `test/hosted-sessions-api.test.ts` "no link is given or followed while frozen, after a lost dispute or
  while closing": tombstone set, a snapshot that still downloads (ended canceled), the link given before it; both
  answer 409. With the new call removed, only that case fails.
- **PR3, O4 and O6 (download-only retention before a confirmed upload).** No code change in this lane, as the finding
  says. They are listed as listing gates for `computer` in the lane PR's description, citing
  `owner-actions/hosted-computer.md` "Download-only starts (H1a)": before listing, move the retention charge to the
  first confirmed upload (or release it when no signed beat arrives), and answer a definitive HEAD mismatch with pack
  or upload.
- **Lane status, For the lead: CI0 item 1 and TB item 1.** Each has a dated line: the dispatch base is now empty (main
  contains #33), and TB item 1 points to the Lead ruling under round three.
- **TB item 5, the four review-memory MISS lines.** 0f6fce89 and 225905e2 are ancestors of origin/main and of HEAD.
  The post-push Vector Codium run of the merged branch (43844651835 at `34c20b62`, Codium tests shard 1/4 job
  133221689218) shows `summary pass=363 fail=0 skip=0 missing=0 extra=0`, so item 5 is closed (dated lines under the
  item and under "The baseline exerciser lines"). The whole run passed: 19 jobs succeeded (the four Codium tests
  shards, Codium browser specs, the ten typecheck jobs and the three Hosted services jobs), and the two Hosted services
  jobs the dispatch does not select (typecheck matrix, Hosted tests) were skipped. Vector hosted CI is dispatched after
  it, since the two share a concurrency group.

Ran locally (through `vector-serial`, one file at a time from `test/`, `--timeout 30000`): `hosted-sessions-api.test.ts`
59 pass, 0 fail, 1 skip; `hosted-copy.test.ts` 7/0; `account-delete.test.ts` 38 pass, 0 fail, 1 skip;
`hosted-lifecycle.test.ts` 23/0. The full `bun turbo typecheck --concurrency=2` ran before the push.

- **16 Nov 2026, engine (linux, shard 4/4) red at `b2537951` (test.yml run 43859026439, job 133280588136).** "task
  isolation saves > Stop returns while Git is still saving, and a same-ID resume waits for the saved result"
  (`packages/engine/test/tool/task.test.ts`) failed with `TaskIsolation.Error` code `registry`, "Isolation data cannot
  be a symbolic or hard link." Not caused by this lane: its diff touches no task, worktree or isolation code, no Git or
  temp-dir helper and not `test.yml`; shard 4/4 ran the same 164 files in the same order in the runs for main
  (43839344467, job 133204672318) and #33's head (43829091585, job 133172046619), where the same test passed. Root
  cause, a real race in `guarded()` (`packages/engine/src/task/isolation.ts`): every save renames a fresh file over
  `record.json`, and the test polls `isolation.find` (no per-task lock) while the forked save writes. An `lstat` that
  resolved the old file just before the rename reports it with `nlink` 0, and `nlink !== 1` read that as a hard link. A
  Python probe on this machine (rename over a file in a loop while another thread lstats it) saw `nlink` 0 on 4504 of
  6.7 million calls. The guard now refuses `nlink > 1`, so a second name is still refused. New test in
  `test/task/isolation.test.ts`, "a record replaced while it is read is not taken for a hard link, and a real hard link
  still is": four readers call `find` while 3000 renames replace the record, then a second name for the record must
  still fail with `registry`. It failed before the fix with the same error on several reads and passes after. Ran
  locally through `vector-serial`, one file at a time: `test/task/isolation.test.ts` 91/0, `test/tool/task.test.ts`
  161/0; engine `bun typecheck`.
- **16 Nov 2026, one uncaptured failure of the new isolation race test.** The review of the entry above ran
  `test/task/isolation.test.ts` 43 times with the fix in place (8 full-file runs, 35 runs of the new test alone). The
  first full-file run ended 90 pass, 1 fail, 1 error: the new test's `toEqual([])` received a `find` failure whose
  kept output ended in `at readRecord (...`. Only the tail was kept, so the error message is lost, and the other 42
  runs passed. Before the push, the full file ran 20 more times in a loop (through `vector-serial`,
  `--timeout 30000`, complete logs kept), and all 20 ended 91 pass, 0 fail, with no error, in 190 to 231 s each. So 1
  failure in 28 full-file runs, cause unknown. It may be another `readRecord` failure under the renames or something
  left by an earlier test in the same process (the unexplained error). The guard cannot be the cause: on ext4 a rename
  over the record takes the old file from 1 name to 0 and never gives either file a second one, and the guard now
  refuses only `nlink > 1`. If CI shows this test red, its log has the full `Cause.pretty` text and needs a root cause.
  The assertion stays as it is.
- **16 Nov 2026, unit (linux) red at `b2537951`: HttpApi exerciser `v2.session.permission.create` (test.yml job
  133280588107, step "Run HttpApi exerciser gates", pass=362 fail=1).** "permission create should create a pending
  request" (`packages/engine/test/server/httpapi-exercise/index.ts:2038`). Not caused by this lane: its diff touches no
  permission, agent, plugin or server code, and the same tree passed on main (run 43839344467, job 133204672070). Root
  cause, a startup race on main: `POST /api/session/{sessionID}/permission` called `PermissionV2.ask` without waiting
  for the Location's built-in plugins. They load in the background (`PluginInternal.boot`, forked), and the build
  agent's rules become visible only when the whole plugin batch commits. A request that starts the Location and lands
  in that window finds no agent, so the permission service falls back to its fail-closed `* * deny` ruleset and answers
  200 with `effect: "deny"` and no pending request. The guest prompt checks in the session handler and session execution already
  wait for `PluginInternal.ready`; this route did not. Fix: the shared `pluginsLoaded` wait moved from
  `packages/server/src/handlers/session.ts` to `packages/server/src/location.ts`, and the permission create handler
  now waits on it before `ask`. `createEmbeddedRoutes` takes optional node replacements so a test can hold a
  Location's plugin boot. The fail-closed deny stays. New test
  `packages/engine/test/server/httpapi-v2-permission-plugins.test.ts` holds the boot open, posts the `.env` read, checks
  the request waits for the plugins, then releases them and expects `ask` with one pending request. Without the fix it
  failed 6 of 6 runs (the request answered at once with `effect: "deny"`, the CI symptom); with it it passed 20 of 20.
  Ran locally through `vector-serial`, one file at a time: the exerciser for `v2.session.permission.{create,list,get,
  reply}` (1/0 each), `bun run test:httpapi` (coverage, auth and effect modes 363/0 each),
  `test/server/free-model-guest.test.ts` 15/0, sdk-next `test/embedded.test.ts` 4/0; `bun typecheck` in server,
  engine and sdk-next.
- **16 Nov 2026, the isolation race test replaced by deterministic steps, and the read check moved onto the open
  file.** The stress test from the entry above (four `find` loops against 3000 renames) failed 1 time in 63 local
  runs (the 43 review runs plus the 20 full-file loop runs: 28 full-file runs and 35 runs of the test alone) with a
  `readRecord` failure whose message was lost. That one failure has no proven mechanism: a Bun probe of
  `readRecord`'s exact sequence against the test's write-then-rename loop made 1,550,821 reads with no failure other
  than 6,782 `lstat` calls that saw `nlink` 0, which the guard already accepts. Two things are established. The test
  was a stress test, not a regression test: how many reads ran was up to the scheduler, it could pass without the fix,
  and any rare failure unrelated to the race turned it red. And the product fix still had a check-then-read window:
  `guarded()` lstat'ed `record.json` by path and `readFile` then opened the path again, so every accepted `nlink` 0
  meant the bytes came from a different file than the one checked, and a symbolic link or a file with a second name
  renamed in between was read unchecked (also `deleted.json`, `enqueueDeleted`'s record and the copy baseline hashes).
  Fix in `packages/engine/src/task/isolation.ts`: one reader, `privateRead`, for those four reads. It guards the
  folders by path, opens with `O_NOFOLLOW` (`ELOOP` is the link error, `ENOTDIR` stays the "ancestor is not a
  directory" error rather than reading as absent), and checks the open file with `fstat` under the same exported rule
  as the guard, `linked` (symbolic link, or a file with `nlink > 1`; a replaced file at `nlink` 0 is accepted). A
  rename after the check can no longer change what is read. Windows has no `O_NOFOLLOW`, so there the path's `lstat`
  still runs first. Tests in `test/task/isolation.test.ts`, no timing and no mocks: "a record replaced by a save is
  still read, and a second name for it is refused" (rename a fresh copy over the record, then `find` reads it; a hard
  link and an ordinary file in place of the record's folder fail with `registry`), and, off Windows, "a record
  replaced after it was checked is not taken for a hard link, and a link renamed in is refused at the open" (a record
  replaced under an open handle shows `nlink` 0 and `linked` accepts it; a symbolic link renamed over the record fails
  with `registry`). Each step fails when its part of the fix is removed: no `O_NOFOLLOW`, the old `nlink !== 1` rule,
  or no `ENOTDIR` mapping. Ran locally through `vector-serial`, one file at a time, `--timeout 30000`, full logs kept:
  the two new tests alone 100 times (2/0 each), `test/task/isolation.test.ts` 8 times (92/0 each, no error),
  `test/tool/task.test.ts` 3 times (161/0 each), `test/task/isolation-base.test.ts` 6/0,
  engine `bun typecheck`. `test/connect/worktree-target.test.ts` ends 4/10 here with and without this change (the
  same 10 tests fail on `34def03b`'s `isolation.ts`): `ReadOnlyGit.inspect` reports "this host has no supported
  unprivileged Git verifier", a limit of this container, not of the code. The Windows and Linux engine shards in CI
  still have to confirm the change.
  21 Nov 2026 (v2-closeout-ci): confirmed on main. test.yml run 44848275007 at `f3d7ac74`, conclusion success:
  engine (windows, shard 5/12) job 136673698347 and engine (linux, shard 5/6) job 136673698352 both succeeded, with
  `isolation.test.ts` at 87/0/0 on Windows and 94/0/0 on Linux as read from their logs (three earlier main runs'
  Windows shard 5/12 jobs are listed in ci-harness-repairs.md). The uncaptured failure belonged only to the removed
  stress test and has no successor test; if the new deterministic tests ever go red, their log carries the full
  `Cause.pretty` text. The item is closed with no root cause found for that one failure.

## Codium finish: TUI runtime plugin port for spawn-inventory, codium-finish lane (16 Nov 2026)

Why `d93b40b8` (the cherry-pick of connect-finish's `1d944dd9`) is on this branch, and what proves it works here.
Its commit message and the entry it appends to `connected-workspace-deviations.md` describe only connect-finish's
`hub.test.ts` failure; this entry records the codium one.

- **Failure.** PR #36 run 43929693613 on `4435beab` failed two tests in `test/spawn-inventory.test.ts` ("the scan sees
  every spawn primitive and ignores comments and look-alikes" at :385 and "the launch check sees each other way a
  launch file can start a process" at :456) on engine (linux, shard 4/4) job 133519182004 and engine (windows, shard
  12/12) job 133519182617. Every bare import specifier in the test's source strings (for example
  `import launch from "cross-spawn"` at :349 and :436) came back as a `file:///…/node_modules/…` URL, so the
  `PRIMITIVES` patterns no longer matched. Same root cause as connect-finish's: the process-global OpenTUI runtime
  plugin text-rewrites `from "<bare>"` in later non-`node_modules` files once a resolve parent exists.
- **Shard indices** (0-based, sorted engine test files from `git ls-tree`). At `4435beab` (662 files)
  `cli/tui/plugin-loader-entrypoint.test.ts` is 143, `plugin/local-sdk.test.ts` 311 and `spawn-inventory.test.ts` 551:
  all residue 3 mod 4 and 11 mod 12, so one Bun process on both systems. `server/httpapi-v2-permission-plugins.test.ts`
  (new on this branch) moved spawn-inventory into that residue. At `3fbc3eb2` (663 files, with
  `plugin/tui-runtime-scope.test.ts` at 323) spawn-inventory is 552: Linux 1/4 and Windows 1/12. Entrypoint, local-sdk
  and tui-runtime-scope stay in Linux 4/4 and Windows 12/12. Its new shard-mates `cli/tui/plugin-add.test.ts` (140,
  Linux only) and `cli/tui/plugin-loader-pure.test.ts` (144, both) do import `src/plugin/tui/runtime`, but without the
  fix `./test/cli/tui/plugin-add.test.ts ./test/cli/tui/plugin-loader-pure.test.ts ./test/spawn-inventory.test.ts`
  passes (15/0): they register the plugin but no resolve parent follows. So spawn-inventory passing in the next CI run
  is not evidence for the fix.
- **Evidence** (`./` paths keep argument order; one invocation at a time through `vector-serial`, `--timeout 30000`).
  The suggested two-file check `./test/plugin/local-sdk.test.ts ./test/spawn-inventory.test.ts` does not reproduce:
  with `runtime.ts` and `local-sdk.test.ts` restored to `4435beab` it passes 23/0, because local-sdk registers the
  plugin without making a resolve parent. Adding the entrypoint test first reproduces the CI failure exactly:
  `./test/cli/tui/plugin-loader-entrypoint.test.ts ./test/plugin/local-sdk.test.ts ./test/spawn-inventory.test.ts`
  gives 29 pass, 2 fail (the :385 and :456 tests) on the `4435beab` sources and 31 pass, 0 fail with the fix. With the
  fix, single files: `tui-runtime-scope` 2/0, `spawn-inventory` 11/0, `local-sdk` 12/0, and the two-file pair 23/0.
  On CI, `tui-runtime-scope.test.ts` passed on PR #38 run 43913739229 (Windows shard 3/12); it must pass on both
  systems in this PR's run too. Engine `bun typecheck` passed.
- **Still to check after the push.** PR #38 run 43913739229 had engine (linux, shard 3/4) job 133464471365 hit the
  30-minute step timeout while tests were still passing, after the plugin registered in that shard. Runner variance is
  the likelier cause (the slowdown sits in a few long tests), but the scoped resolver adds one `import.meta.resolve` per
  catch-all resolve. Compare this PR's Linux 4/4 and Windows 12/12 step durations with run 43929693613 (Linux 4/4 took
  802 s). If either nears 30 minutes, profile the wrapper's extra resolve. The timeout is not to be raised.
  21 Nov 2026 (v2-closeout-ci): checked. No 6-shard main run came near 30 minutes (largest shard 18.1 min, run
  44822880542; 16.3 in 44848275007; 15.5 in 44869120445), so the resolver was not profiled. The Linux engine suite now
  runs in eight shards under the same 30-minute limit (TB item 3 above).
- **Merge note.** The pick appends connect-finish's "2026-11-16 — connect-finish lane: root cause and fix for the
  hub.test.ts load error on Linux shard 2" entry at the end of `connected-workspace-deviations.md` (about line 235
  here, about 2134 on connect-finish), and it cites connect-finish jobs and commits (`a320bdbe`, `973895e3`) that are
  not on this branch. When the second of PR #36 and PR #38 merges into main, keep one copy of that entry. The five
  code files of the pick are byte-identical to `origin/connect-finish`.
- **21 Nov 2026: merged.** The port reached main twice with the same code: first with PR #38 (`7e440a27`, which holds
  `1d944dd9`), then with PR #36 (`b5cbad1c`, which holds `d93b40b8`). `connected-workspace-deviations.md` on main has
  one copy of the hub.test.ts entry. This record does not check the Linux 4/4 and Windows 12/12 step durations asked
  for above; main now runs six Linux shards (`9506de79`), so those shard numbers no longer apply.

## A46 tombstone: late Worker reports and a Worker that cannot erase, codium-api-fixes lane (21 Nov 2026)

Closes the two A46 follow-ups codium-p7-repairs records under R46b (the P5 side of R46-20, and `eraseAccountOps`
skipping the Worker silently).

- **Late reports.** `handleOpsReport` (`api/_lib/ops-incidents.ts`) reads the account's tombstone before the loop. When
  it is set, the report answers `{taken: 0, duplicates: 0, skipped: <events>}` (200 through `POST /api/ops/worker`)
  with no incident, events-set or alert write, so the Worker stops resending. A tombstone read failure throws like any
  store failure, so the Worker retries. One extra `GET` per report.
- **A Worker that cannot be called.** `eraseAccountOps` (`api/_lib/ops-cleanup.ts`) without `opsErasable()` now
  ZSCOREs the account in `ops:accounts` for both Stripe modes (as `forgetOpsAccount` removes it). Present: 503
  `OPS_UNAVAILABLE` before any erase step, so `finishAccountDeletion`'s ops part fails (with `codium` and `keys`, which
  require it) and the deletions cron retries. Absent: erased as before, so a deployment whose accounts never used ops
  still deletes with the Worker unconfigured. The lost-dispute erase in the daily cleanup and the provisioner's
  `closing` erase take the same path and are retried the same way.
- **Review note (21 Nov 2026): the gap the list leaves.** `ops:accounts` is not a record of every account that ever
  used ops: the daily cleanup (`cleanAccount` in `ops-cleanup.ts`) drops an account from it when nothing is left to
  expire and no plan gives the Worker work, while the Worker may still hold that account's config, releases and
  baselines. Such an account's deletion without the Worker's settings still finishes without the Worker's erase, as it
  did before this lane. The `eraseAccountOps` comment now says "an account on the ops account list". Left for the
  morning list: keep a separate record of accounts the Worker holds, or stop the cleanup dropping them.
- **Tests** (`test/account-delete.test.ts`, describe "ops after the tombstone (A46)"): a late signed report after a
  finished deletion answers 200 `{taken: 0, skipped: 1}` with no incident, no events set and no alert, while the same
  report for an open account writes its incident and alerts; with `VECTOR_OPS_WORKER_URL` unset an account with ops
  history stays pending at `erase` with failed `["ops", "codium", "keys"]` and its ops records kept, and once the
  address is back the cron's retry calls the Worker's erase and finishes; an account without ops history still
  finishes with the Worker unset. Mutations: dropping the tombstone check fails the first case, and short-circuiting the
  `ops:accounts` check fails the second. `ops-payment-pipeline.test.ts`'s "account deletion erases every ops record at
  once" (`:390`) and the media-down case (`:407`) still pass: their Worker is configured. File counts: account-delete
  44 pass, 1 skip.

## R46-17: the ops Worker bounds its run row, codium-api-fixes lane (21 Nov 2026)

- **Built.** `packages/ops-worker/src/limits.ts`: `maxRunStateBytes` 1,900,000 (Cloudflare's 2 MB per string or row
  for SQLite-backed Durable Objects, with a 5 % margin) and `maxConcurrentWatches`, derived as
  `floor((1,900,000 − 100,000 reserve) / 56,384)` = 31, where 56,384 bytes is a watch at its largest (five paths at
  2,048 characters in `urls`, `streaks`, `last`, `failures` and `baseline.ok`, with JSON overhead and DNS answers).
  `ops-account.ts` `release()`: with 31 watches running, the release is inserted as `skipped` and answered
  `{accepted: false, reason: "daily-limit"}` with 200, like the day's cap, so the API (which already handles that
  reason) records it as skipped and nothing answers 500. `save()`: over the bound, the cached DNS answers are dropped,
  then the oldest watches end as `stopped`, so a wake can always write its row.
- **Deviation.** No new answer reason: a new one would need the API's decoder first and a two-step deploy
  (hosted-ops.md), so the cap reuses `daily-limit`. For the lead if a distinct reason is wanted.
- **Tests.** `packages/ops-worker/test/release-watch.test.ts` "the run state's size (R46-17)" (worst case above 80 %
  and below the bound; the 32nd release answers 200 unwatched; mutation: without the cap it is accepted and the case
  fails); `test/ops-worker-contract.test.ts` (the API's 20 repositories fit the cap). ops-worker suites
  release-watch 17, schedule 13, internal 23, on-call 16, check 16; contract 9; ops-worker typecheck clean.
- **Not run here.** The miniflare smoke (`e2e/ops-smoke.mjs`) and a real Durable Object's 2 MB refusal (CI and the
  owner's deploy).

## A23 model edit race: Codium runs carry the own-key headroom, codium-run-headroom lane (21 Nov 2026)

- **Built (lead ruling R2, option 1), parallel half.** A parallel run admitted as Codium also carries the own-key
  headroom as its engine budget: `codiumRunHeadroom` (`packages/desktop/src/main/codium-run-headroom.ts`) runs a
  second, ordinary, non-reserving `checkAllowance` and answers its `budgetUsd`, or 1 cent when that check is blocked,
  so the run still starts and its first own-key cent stops it. Codium steps stay exempt (D-3); the Codium check still
  neither blocks nor reserves (C8). The scheduled half is open PR #78 (`spend-cap-follow`), which gives the same
  answers.
- **Reverses F19's reading** ("Known-Codium desktop runs carry no desktop budget (F19)" above) by lead ruling. A25's
  assertion in `parallel-workspaces.spend.test.ts` now expects the budget, with a dated comment.
- **For the lead.** An armed prompt budget replaces the config `budget.run` and research's default caps, as it already
  does for own-key desktop runs, so a Codium desktop run under a dollar limit loses those step caps; loop limits and
  the gateway remain. The build record is `v2-p0/codium-run-headroom.md`.

## 22 Nov 2026: Codium parallel headroom tightens existing caps

After merging main with #78, `codium-run-headroom` sends `tightenBudget: true` with each bounded Codium parallel
prompt and live message. This supersedes the 21 Nov consequence above: the fence keeps stricter engine and research
caps. Own-key arming, unreserved Codium headroom, the one-cent floor and all flags remain unchanged. Verification
and the red-before/green-after regressions are in `v2-p0/codium-run-headroom.md`.
