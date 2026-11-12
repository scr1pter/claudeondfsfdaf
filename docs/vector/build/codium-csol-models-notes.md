# C-SOL record: Sol in; Terra and Astra out

This work applies the owner's decision of 30 Oct to the Codium lane. It starts from the A17 commit `66007529` on
`codium-next` (the coordinator reported its Vector Codium push run 41008803316 as successful; this record does not
restate CI it did not see). It is committed on `codium-next` after the gate below, on top of `ae14a755`, a separate
test-fixture fix the gate found. It is **not** provider acceptance: no provider, metadata or inference call, Stripe or
OpenRouter call, account setting, deployment or release-catalog change was made. Test services were loopback fakes and
a disposable local `redis-server` 7.0.15 (CI uses Valkey 7.2.14).

## The decision

The owner, 30 Oct: "Sol is ZDR on OpenRouter; Terra and Astra are not (they are on Azure, and Vector uses only
OpenRouter, not Azure directly), so add Sol to the model list." It is recorded as §8 of
[codium-tiers-v3-changes.md](codium-tiers-v3-changes.md).

- GPT-6.1 Sol stays: Sol (High) on Pro and up, Sol Deep on Max, Sol Deepest on Ultra. Its Auto ceilings, review confirm
  pairs and judges were already in the staged catalog and are unchanged.
- GPT-6.1 Terra leaves Plus (it was optional and manual only). Plus is DeepSeek, Haiku and Luna: three labs.
- GPT-6 Astra (Max) and GPT-6 Astra Long (Ultra) leave, with the Astra in-flight caps (Max 4, Ultra 8).
- Sol is **not** activated. It stays staged and `ROUTE_ACCEPTANCES` stays empty until captured OpenRouter ZDR endpoint
  evidence for Sol is committed and accepted (see "Activating Sol").

## What changed

| Area                                                                                                        | Change                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/_lib/codium-catalog.ts`                                                                                | Terra, Astra and Astra Long removed from `CODIUM_TIER_MODELS` (18 → 15 staged candidates); Terra's Pro judge entry removed (Max and Ultra judges derive from the list). `CODIUM_CATALOG_UPDATED` is `2026-10-30`. Sol entries, `CODIUM_AUTO_ROLES`, `CODIUM_REVIEW_PAIRS`, the active five and `CODIUM_RUNTIME_CATALOG_UPDATED` are unchanged. |
| `packages/schema/src/codium-entitlements.ts`                                                                | `groups` removed from `Entitlements`, all four plans and `publicEntitlements`.                                                                                                                                                                                                                                                                 |
| `api/_lib/model-plan-config.ts`, `model-plan-catalog-policy.ts`                                             | `inFlightGroup` removed from `ModelPlanModel`, its eligibility check and both qualification guards.                                                                                                                                                                                                                                            |
| `api/_lib/model-plan-admit.ts`                                                                              | The `group` input, ticket field, `SettleRetry` field and `inflight:<id>:astra` key removed. ADMIT and SETTLE take 12 keys (below).                                                                                                                                                                                                             |
| `api/_lib/model-plan-chat.ts`                                                                               | No longer passes `group` to ADMIT.                                                                                                                                                                                                                                                                                                             |
| `api/_lib/codium-spend-ledger.ts`, `packages/web/test/fixture/codium-spend-emulation.ts`                    | A stored reservation that carries `group` is malformed: the ledger read fails closed.                                                                                                                                                                                                                                                          |
| `api/_lib/codium-entitlements.ts`, `codium-snapshot.ts`                                                     | `groups` removed from `includes()` and `NO_CAPS`.                                                                                                                                                                                                                                                                                              |
| `packages/web/scripts/model-plan-catalog.ts`, `packages/web/test/fixtures/codium-endpoints-2026-10-30.json` | The offline audit's default target is a new 30 Oct manifest. It pins the unchanged 23 Oct bytes (SHA-256 `3c37e891…89e0`), keeps `providerEfforts` empty, drops the Terra and Astra items and names exactly what Sol still lacks. The 27 Oct manifest is unchanged.                                                                            |
| Contract docs                                                                                               | §8 in `codium-tiers-v3-changes.md`; `codium-build-spec.md` amended in place (see the deviations file); one-line pointers in `codium-tiers-v3.md`, `codium-label-plan.md` and the A15 and A17 notes.                                                                                                                                            |

No public Protocol or HttpApi surface changed, so no generator ran. No site, app or engine file changed: the pricing
page and the app list only the five active models, and no Terra, Astra or Sol tier copy exists yet (tier copy is A27).

### ADMIT and SETTLE keys

Old KEYS[8] (`inflight:<id>:astra`) is gone; the keys after it move down by one.

| KEYS | Key                                                                | Was |
| ---: | ------------------------------------------------------------------ | --: |
|  1–6 | account, ent, held, debits, model-spend ledger, model-reservations | 1–6 |
|    7 | `inflight:<id>`                                                    |   7 |
|    8 | `inflight:global`                                                  |   9 |
|    9 | `day:<pool>:<day>`                                                 |  10 |
|   10 | `purpose:<pool>`                                                   |  11 |
|   11 | `run:<run>`                                                        |  12 |
|   12 | `run-pool:<run>`                                                   |  13 |

ADMIT's caps check no longer requires `caps.groups`; the purge, typed-key and ZADD loops run over keys 7–8; the
refusal order is account, global, month, day, period Brain, run. SETTLE no longer compares a `group` field. Nothing else
in the A17 Lua changed.

### Unrelated "Terra" and "Astra" strings kept

Every `git grep -i 'astra\|terra'` hit outside the files above was checked and left alone: BYOK or ChatGPT model
entries (`packages/schema/src/external-agent.ts`, `packages/schema/src/model-catalog.ts`,
`packages/engine/src/provider/transform.ts`, `packages/engine/src/plugin/openai/codex.ts`, their engine tests,
`packages/app/src/utils/provider-brand.ts`, the app picker and subagent-model tests, `model-picker.spec.ts`), shipped
release copy (`packages/web/public/changelog.json`, `packages/web/src/data/vector-releases.ts`,
`packages/web/src/data/docs-content.ts`; release-owned), `packages/web/public/models/api.json`, the
`ShotBrowserPanel` marketing shot, design-lab mocks, `docs/vector/owner-actions/model-catalog.md`, benchmark and
handoff data, and words such as terraced, terraform and astral. The historical tier documents (`codium-tiers.md`,
`codium-tiers-v2.md`) and the 27 Oct manifest also keep their text; §8 and the precedence line win over them.

## Local validation

Each file ran alone through `vector-serial` with `--timeout 30000` and fresh XDG and `VECTOR_TEST_HOME` roots. "Valkey"
means `VECTOR_TEST_REDIS_URL` pointed at the disposable loopback `redis-server` (real Lua), stopped afterwards.

| File                                                  | Store             |           Result | Against A17                                                                   |
| ----------------------------------------------------- | ----------------- | ---------------: | ----------------------------------------------------------------------------- |
| `packages/schema/test/codium-entitlements.test.ts`    | in memory         |          14 pass | groups assertions removed                                                     |
| `packages/web/test/model-plan-entitlements.test.ts`   | in memory         |          61 pass | 66: two `inFlightGroup` override rows and three Terra/Astra hold rows removed |
| `packages/web/test/model-plan-catalog.test.ts`        | in memory         | 40 pass (1 skip) | unchanged; the skip is the pre-existing release-mirror case                   |
| `packages/web/test/model-plan-catalog-policy.test.ts` | in memory         |           2 pass | unchanged                                                                     |
| `packages/web/test/model-plan-reservations.test.ts`   | in memory         |           9 pass | unchanged                                                                     |
| `packages/web/test/model-plan-gateway-hooks.test.ts`  | in memory         |          13 pass | unchanged                                                                     |
| `packages/web/test/model-plans.test.ts`               | in memory         |          20 pass | unchanged                                                                     |
| `packages/web/test/model-plan-context.test.ts`        | in memory         |           6 pass | unchanged                                                                     |
| `packages/web/test/model-plan-admit.test.ts`          | Valkey (real Lua) |          68 pass | 66: two cases added, one reshaped                                             |
| `packages/web/test/model-plans-api.test.ts`           | Valkey (real Lua) |          72 pass | 67: fifth-Astra case removed, six cases added                                 |
| `packages/web/test/model-plan-models-api.test.ts`     | Valkey            |           4 pass | unchanged                                                                     |
| `packages/web/test/model-plan-status-api.test.ts`     | Valkey            |           3 pass | unchanged                                                                     |
| `test/codium-pool.test.ts`                            | in memory         |          27 pass | 26: one case added                                                            |
| `test/codium-pool.test.ts`                            | Valkey (real Lua) |          27 pass | 26: one case added                                                            |
| `test/codium-plan-change.test.ts`                     | in memory         |          29 pass | unchanged                                                                     |
| `test/codium-renewal.test.ts`                         | in memory         |          32 pass | unchanged                                                                     |
| `test/codium-billing.test.ts`                         | Valkey            |          53 pass | unchanged                                                                     |
| `test/api-module-loading.test.ts`                     | in memory         |           1 pass | unchanged                                                                     |

New and changed cases:

- **Staged Sol is unavailable** (`model-plans-api`, three ids): an Ultra subscriber asking for `gpt-6.1-sol`, `:deep` or
  `:deepest` on the production catalog and qualification gets 503 `MODEL_PLAN_MODEL_UNAVAILABLE`, with no Stripe call,
  no `/api/v1` call, no ADMIT and no store command on the `ent` key.
- **Removed models are not Codium models** (`model-plans-api`, three ids): `gpt-6.1-terra`, `gpt-6-astra` and
  `gpt-6-astra:long` get 400 `MODEL_PLAN_MODEL` with the same absences.
- **The global set is shared** (`model-plan-admit`, real Lua): with another account's live request in
  `inflight:global`, a Plus admission is `BUSY` while its own set is empty; at rank 3 it is admitted, the next is
  `BUSY`, and settling removes only its own member. Before this case, every admission test used one account, so the
  account and global sets could not be told apart.
- **The reserve case keeps its structure** (`model-plan-admit`): inFlight 10, Plus admitted then `BUSY`, rank 3
  admitted, cancel frees its global member. Only the group lines were removed.
- **A record naming the retired group fails closed** (`model-plan-admit` on real Lua; `codium-pool` in memory and on
  real Lua, the emulation check): the same record reads and counts first, with consistent counters; with
  `"group":"astra"` added, the ledger read, ADMIT, SETTLE (`model-plan-admit`) and `holdPool` (`codium-pool`) answer
  `MODEL_PLAN_POOL_UNAVAILABLE`, and nothing is written.
- **Catalog shape** (`model-plan-entitlements`): 15 candidates; unlock lists Plus [DeepSeek, Haiku, Luna], Max
  [DeepSeek Long, Sonnet, Sol Deep, Kimi Fast, Argon Fast], Ultra [Opus, Sol Deepest]; Sol, Sol Deep and Sol Deepest
  on Pro, Max and Ultra with efforts high, xhigh and max, none manual or preview; no id matches Terra or Astra.
- **No bound is invented for Sol** (`model-plan-reservations`): Sol, Sol Deep, Sol Deepest and the two fast lanes have
  no captured reservation.

**Mutation checks**, each run against the final test files and then restored (compared byte for byte):

| Mutation                                                          | Caught by                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Ledger grammar accepts `group: "astra"` again (Lua and emulation) | the group case in `model-plan-admit` (real Lua) and in `codium-pool` (in memory and real Lua) |
| ADMIT counts the global limit on KEYS[7] (the account set)        | only the new global-set case                                                                  |
| SETTLE writes the day total to KEYS[10] (purpose)                 | six `model-plan-admit` cases, including settlement one-shot and the immutable old day         |
| ADMIT reads the day total from KEYS[10]                           | two `model-plan-admit` cases (the settled bridge and the corrupt counter)                     |
| ADMIT reads the run's pool binding from KEYS[11] (run spend)      | "one run cannot reset its reservation by moving to a new pool"                                |

**Typechecks.** `packages/schema` `bun typecheck` passed. The API (`packages/engine`:
`bun typecheck --project ../../tsconfig.json`) passed; its first run failed with TS1005 because a backtick in a new Lua
comment closed the script's template literal, which is now a quoted word. Web Astro (`packages/web`: `bun typecheck`)
passed across 194 files with 0 errors, 0 warnings and 173 hints. A17 recorded 169; the 4 new hints are all ts(80007)
("'await' has no effect") on new `await expect(...).rejects` lines in `model-plan-admit.test.ts`, which now has 55
(A17: 51): five new lines in the two added cases, one removed from the reshaped reserve case.

Prettier reports one file, `packages/web/test/fixture/codium-spend-emulation.ts`, for three lines this change did not
touch (lines 276, 441 and 481); they were left as they are.

## Gate before commit

The commit gate reran each file alone through `vector-serial` with `--timeout 30000`, fresh XDG and `VECTOR_TEST_HOME`
roots and, for Valkey rows, a new disposable loopback `redis-server` 7.0.15 (`--save '' --appendonly no`, stopped
afterwards; its `cmdstat_eval` count rose on every Valkey file, so the Lua really ran). The final results match the
table above: schema `codium-entitlements` 14; web `model-plan-entitlements` 61, `model-plan-catalog` 40 (1 skip),
`model-plan-catalog-policy` 2, `model-plan-reservations` 9, `model-plan-gateway-hooks` 13, `model-plans` 20,
`model-plan-context` 6; on Valkey `model-plan-admit` 68, `model-plans-api` 72, `model-plan-models-api` 4,
`model-plan-status-api` 3; `test/codium-pool` 27 in memory and 27 on Valkey; `codium-plan-change` 29, `codium-renewal`
32, `codium-billing` 53 on Valkey, `api-module-loading` 1, each with no failures (`model-plans-api` after the fixture
fix below). The API typecheck (`packages/engine`: `bun typecheck --project ../../tsconfig.json`) passed again. The
push's pre-push hook typechecks every workspace package, Web Astro and schema included.

**An intermittent A17 test, fixed in its own commit (`ae14a755`).** The gate's first `model-plans-api` run on Valkey
failed one test, "a locked model after a recent upgrade checkout reconciles once and serves the upgraded plan": the
fake gateway expected `fixture-paid-secret-1` and received `fixture-paid-secret-2`, then the chat answered 503. Of 9
unchanged runs on Valkey, 2 failed this way. The case and its `upgrading()` fixture came with A17 (`66007529`), and C-SOL
does not touch them. The cause is in the fixture: `subscribed()` and `upgrading()` each built the subscription with a
period start read from the wall clock. When a second ticked between the two reads, the reconcile saw a new period and
provisioned a second key. The fake chat endpoint checks the first key. Two checks confirmed this:

- Shifting the upgrade's start by 5 seconds reproduced the same failure (one filtered run).
- With `await Bun.sleep(1100)` added after `subscribed()`, the old fixture failed and the fixed one passed both
  upgrade cases.

The fix reuses the subscribed period's start. It does not relax the assertion, and the probes were removed afterwards
(the file was compared byte for byte). After the fix, `model-plans-api` passed 72 of 72 on Valkey in three runs.

## Activating Sol (not done here)

The coordinator could not capture Sol's evidence on 30 Oct: this environment's network policy blocks openrouter.ai, and
the owner was asked to allow it. Activation then needs, in order:

1. A raw, dated capture of OpenRouter's public `/models`, `/endpoints/zdr` and
   `/models/openai/gpt-6.1-sol/endpoints`, committed with its SHA-256, plus a target manifest that pins it.
2. From that capture: the exact ZDR provider tag (the staged `azure` is the 27 Oct hypothesis; spec §8.3 open item 9
   asks whether OpenRouter's `azure` provider tag is acceptable for Sol, as it is for Luna), the native context, the
   maximum output including reasoning, and every price tier (prompt, completion, cache read, cache write, reasoning).
3. Exact-tag effort evidence for `xhigh` (Sol Deep) and `max` (Sol Deepest) as reviewed `providerEfforts` entries.
4. A reviewed change to the qualification path. Data alone is not enough, because:
   - `capturedGatewayModel` refuses any model with `upstream` or `tierContext`, or whose effort, output or context differ
     from its `CODIUM_MODELS` entry, so Sol Deep and Sol Deepest cannot qualify by adding Sol to the active list;
   - `capturedReservationMicro` reads `CAPTURED_RESERVATIONS[upstream ?? id]` while `capturedGatewayModel` reads
     `CAPTURED_RESERVATIONS[id]`, so the bounds need one keying rule;
   - `verifiedGatewayModel` accepts only the single 23 Oct `RESERVATION_CAPTURE` digest, so a second capture needs
     per-capture (or per-model) digests, which also shapes the active five's future acceptances.
5. `CAPTURED_RESERVATIONS` for Sol and its variants, with output bounds that include reasoning.
6. `ROUTE_ACCEPTANCES` entries only after A60's approved external acceptance (exact tag with `zdr:true` and
   `allow_fallbacks:false`, native window enforced, rates bounding charges).

## Remaining gates

- CI: pushing this commit to `codium` starts the Vector Codium workflow (`vector-codium.yml`, push on `codium`; no
  dispatch needed). It should run the renumbered ADMIT/SETTLE scripts on Valkey 7.2.14 (`model-plan-admit`,
  `model-plans-api`), its `test/` selection, the typecheck matrix and the generated-client check. `codium-next` is not
  in its push filter. Local `redis-server` 7.0.15 is not CI proof. No CI run of this change had been seen when this
  record was committed, so the run id is reported outside it.
- The non-author A17 re-review that is still open should include this diff: it changes reviewed money code (the ADMIT
  and SETTLE key order and the ledger record grammar).
- Outside this worktree: the takeover handoff's §8 owner product rules still say "Terra optional/manual" and "Max gets
  Sonnet and Astra; Ultra gets Opus/Astra Long"; that worktree is read-only for this lane, so the coordinator should
  update it. The @vector lane (`vector-at-mention`) should get §8, since tiers-v3-changes §6 listed Astra among the
  Max/Ultra premium run models; its files hold no Terra or Astra reference and were not touched.
