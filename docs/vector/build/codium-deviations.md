# Codium implementation notes

Updated October 30, 2026. These notes describe the committed build on `codium`; they do not replace the contract or the owner's tier decisions.

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
