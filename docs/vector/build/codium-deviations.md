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
