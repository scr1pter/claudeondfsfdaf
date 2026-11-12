# P3 phase review repairs (A17 to A20)

These repairs answer the P3 phase review of `14bc7d42..a5cad27a` on `codium-next`. The review merged into three
defects: two reports of the same retry multiplication, two reports of the same missing-snapshot answer, and two
reports about a lost admission answer. Each was checked against the code, reproduced by a focused test where feasible,
and repaired with a regression that fails against the previous source. The owner's policy is unchanged: the larger
fixed reservations, the current context windows, the unknown-outcome charge, the gateway's single Max/Ultra retry,
`ROUTE_ACCEPTANCES` empty and Sol staged. No live provider, Stripe, OpenRouter or GitHub call was made, and no
cloud-agent file was touched. The contract corrections are in `codium-deviations.md` ("P3 review decisions").

## Charged refusals were resent automatically

**Confirmed.** After dispatch, the gateway answers a provider 429 as `MODEL_PLAN_BUSY`, a 402 as `MODEL_PLAN_CAPACITY`,
any other non-OK answer as `MODEL_PLAN_UPSTREAM` (503), and a transport failure or the Max/Ultra retry's deadline as
`MODEL_PLAN_UNAVAILABLE` (503). Its `finally` then settles `broken`, committing every dispatched attempt at its full
reservation for the period. A19 classified `MODEL_PLAN_BUSY` and `MODEL_PLAN_CAPACITY` as temporary and left the two
503 codes to the ordinary 5xx retry. So the engine's loop resent one refused request up to ten times in 15 minutes,
each time with a fresh admission and a fresh commitment. The AI SDK's own retries on titles and model learning, and the
V2 executor's two retries, added more. `MODEL_PLAN_BUSY` is also ADMIT's answer for a full global set, which costs
nothing, so a client could not tell the two apart. The engine test asserted this retry for all three codes.
`MODEL_PLAN_UPSTREAM` is also a free answer before dispatch (`model-plan-account.ts`, a failed key read), so
reclassifying the existing codes was not an option.

**Repair.** `handleModelPlanChat` adds `dispatched: true` to every error answer it gives once a request was sent to the
provider, whatever the code. The one exception is `MODEL_PLAN_CONTEXT`, which the client compacts rather than resends
unchanged. `ModelPlanStatus.gatewayFailure` treats a marked answer as final: kind and action `unavailable`, a message
saying the request counts toward the month's usage and was not sent again, and the " Choose another model." suffix.
Because both transports already pass final answers on as client errors (`ModelPlans.finalAnswer`, the V2 route's
`finalAnswers`), neither the AI SDK nor the V2 executor resends one, and the engine's loop stops on `metadata.codium`.
Unmarked codes keep their retry. With this repair, each refused request the person or an agent sends commits at most
one reservation, which is what the A17 sizing note prices. That note (`codium-a17-context-decision.md`) now states the
multiplier and the pre-repair figure for the A60 review.

Regressions:

- `packages/web/test/model-plans-api.test.ts`:
  - "a provider refusal after dispatch is committed once, and Vector's transport hands it on as final" sends provider
    429, 503 and 402 through Vector's own `ModelPlans.createFetch`. Each turn reaches the provider exactly once, the
    session gets 400, 400 and 402, `retry: false` and kind `unavailable`, and each commits exactly one attempt
    (12,288 micro).
  - The existing upstream-refusal case now asserts the mark.
  - The global-reserve case asserts that ADMIT's free `MODEL_PLAN_BUSY` is unmarked and still `retry: true`.
- `packages/core/test/model-plans.test.ts`:
  - The code table covers marked `MODEL_PLAN_BUSY`, `MODEL_PLAN_CAPACITY`, `MODEL_PLAN_UPSTREAM` and
    `MODEL_PLAN_UNAVAILABLE`.
  - The SDK transport turns a marked 503 or 429 into a 400.
  - On V2, each marked answer is sent once, against three sends for the unmarked `MODEL_PLAN_UPSTREAM`. The fixture
    gateway (`test/fixture/codium-gateway.ts`) gained the `dispatched` option.
- `packages/engine/test/session/retry.test.ts`: "an answer given after the gateway dispatched the request is final,
  since each resend is committed again".

## A first snapshot still being written was a final 402

**Confirmed.** `readEntitlement` returned undefined when no snapshot existed and another request held this minute's
reconcile beyond its 2-second wait. Status answered 503 `MODEL_PLAN_RENEWING` for that case. But chat, estimate and
`holdPool` passed the undefined to `requireUsableSnapshot`, which answers 402 `MODEL_PLAN_REQUIRED`. The client treats
that answer as final ("See plans"), so an account that had just paid could be refused. This contradicted the A17
deviation.

**Repair.** After its wait, `readEntitlement` itself answers `modelSpendStale()` (503 `MODEL_PLAN_RENEWING`,
retry-after 1) when the account has a Codium record. Every checkout makes one, so every caller (chat, estimate,
`holdPool`, `requireEntitlement`'s perk callers, status) gets the retryable answer. An account without a record still
gets undefined, and so the 402. The extra record read happens only on that slow path. `requireUsableSnapshot` is
unchanged for snapshots that exist.

Regression in `test/codium-billing.test.ts`: "a first snapshot another request is still writing answers RENEWING to a
paying account, never a final 402". With `reconcile:<id>` held and no snapshot, `requireEntitlement` and `holdPool`
answer 503 `MODEL_PLAN_RENEWING`, with retry-after 1 and no Stripe call. An account without a record still gets 402.
Once the slot is free, the paying account is served.

## A lost admission answer held its slot for 11 minutes, and the record overstated its cleanup

**Confirmed, both parts.** The only cancellation of an admission whose EVAL answer was lost was queued for its
deadline plus 60 seconds. If the EVAL had run, the account's in-flight slot, the global slot and the full reservation
stayed live for those 720 seconds although nothing could have been dispatched. Three such losses on Plus would refuse
every chat with `MODEL_PLAN_CONCURRENCY` for about 11 minutes. Separately, `queueSettlement` swallows a failed enqueue,
so when the enqueue also failed nothing ever cancelled the ticket. The deviation nevertheless said it was "never left
as an abandoned reservation for the rest of the period".

**Repair.** `admitModelPlan` now cancels the exact ticket at once (one SETTLE `cancel` at the admission's clock).
`ok` means the EVAL ran, and the slot and reservation are free now. When the cancel answers `missing` (not run yet) or
is lost too, the deferred cancel past the deadline is queued as before, for an EVAL still on its way. SETTLE is
idempotent and answers `missing` for a ticket ADMIT never recorded, and ADMIT refuses a ticket that already has a
record. So neither order can charge, release or admit twice. The deviation and the A17 notes now name the two cases
left as an abandoned reservation that counts in full until the ledger expires: an EVAL delayed past the margin, and a
cancel and queue write that both fail. Both are customer-conservative and never free money, like a lost settlement
whose queue also failed.

Regressions in `packages/web/test/model-plan-admit.test.ts`:

- The adapter case checks the immediate SETTLE `cancel` for that ticket. On `ok` nothing is queued. On `missing`, or
  on a lost answer, the queue is written for that ticket at deadline + 60 s, and no credential is in the payload.
- On real Lua:
  - "an admission that ran but lost its answer is cancelled at once, freeing its slot before its deadline" (in-flight
    cap 1; the next admission succeeds at once; nothing is queued).
  - "an admission that lands after its cancel is cancelled past its deadline, never kept as abandoned" (the delayed
    EVAL lands after the immediate cancel answered `missing`; the queued cancel cleans it up).
  - "an admission whose answer, cancel and queue write are all lost keeps counting in full, never free" (abandoned
    past its deadline; a request needing that allowance is refused `MODEL_PLAN_EXHAUSTED`).

## Not changed

- The gateway's single retry before any byte on Max and Ultra, the fixed reservations, the unknown-outcome charge and
  the abandoned-reservation rules are the owner's policy and stay as they were.
- Helper calls keep their AI SDK `maxRetries`. A marked answer reaches them as a client error the SDK never retries,
  and the unmarked retried answers cost nothing.
- The error frame of a stream that breaks off after output also carries the mark. It is not an HTTP answer, so
  `gatewayFailure` does not classify it. The AI SDK's OpenAI-compatible parser (2.0.41) passes on only that frame's
  message, so the mark never reaches the engine. `MessageV2.fromError` records the message as an unclassified error,
  which the engine's retry loop does not resend. This comes from reading the code; no new test covers it.

## Validation

Each file ran alone from the directory that owns it (`test/` files from `test/`, whose `bunfig.toml` owns them, as
the Codium CI picker runs them) through `vector-serial` with `--timeout 30000` and fresh XDG and `VECTOR_TEST_HOME`
roots. "Valkey" means `VECTOR_TEST_REDIS_URL` pointed at a disposable loopback `redis-server` 7.0.15 (no persistence),
which was stopped afterwards. Every row ran twice with the same result: once when the repairs were made (roots under
`/tmp/vector-codium-p3review/`), and again at the commit gate on the final tree, after the last source and test edit
(roots under `/tmp/vector-codium-p3commit/`).

| File                                              | Store     | Result                       |
| ------------------------------------------------- | --------- | ---------------------------- |
| `packages/web/test/model-plan-admit.test.ts`      | Valkey    | 70 pass                      |
| `packages/web/test/model-plans-api.test.ts`       | Valkey    | 76 pass                      |
| `packages/web/test/model-plan-status-api.test.ts` | in memory | 20 pass                      |
| `packages/web/test/model-plan-caller.test.ts`     | in memory | 40 pass                      |
| `packages/web/test/model-plan-context.test.ts`    | in memory | 6 pass                       |
| `packages/core/test/model-plans.test.ts`          | fixture   | 36 pass                      |
| `packages/engine/test/session/retry.test.ts`      | none      | 40 pass                      |
| `test/codium-billing.test.ts`                     | in memory | 51 pass, 2 skip, 1 fail (\*) |
| `test/codium-billing.test.ts`                     | Valkey    | 53 pass, 1 fail (\*)         |
| `test/codium-pool.test.ts`                        | in memory | 27 pass                      |
| `test/codium-pool.test.ts`                        | Valkey    | 27 pass                      |
| `test/codium-plan-change.test.ts`                 | in memory | 29 pass                      |
| `test/codium-renewal.test.ts`                     | in memory | 31 pass, 1 fail (\*)         |
| `test/codium-risk.test.ts`                        | in memory | 23 pass, 1 skip              |
| `test/codium-switches.test.ts`                    | in memory | 17 pass, 2 skip              |

(\*) These failures are not caused by these repairs and are not flakes: the cause is the calendar. The
`active-paid` and `frozen-dispute-previous-charge` Stripe fixtures end their period at `current_period_end`
1793404800 (2026-10-31T00:00Z). "a dispute on last month's charge…" and "when the reconcile cannot be queued
either…" reconcile on the real clock at a step that does not pass the fixture's time. On 31 October that clock is past
the period, so reconcile sees a renewal (`paused`, `payment_pending`, received in the first case) instead of the paid
month the test assumes. Neither path reaches the code changed here. The Vector Codium workflow runs every file in
`test/`, so these two cases fail there too on any date past that period, until the fixtures or the two tests stop
depending on the real clock. That fix was outside this review. CFIX makes it: the fixture scenarios now run on their
fixtures' clocks, with no fixture change and one production change, reconcile's own `now` reaching its purchase
confirmation (see [codium-cfix-clock-notes.md](codium-cfix-clock-notes.md)).

Mutation checks (each reverted by restoring the tested file):

| Change removed                   | Cases that fail                                  |
| -------------------------------- | ------------------------------------------------ |
| The gateway mark                 | 2 in `model-plans-api.test.ts`                   |
| `gatewayFailure`'s marked branch | 3 in `model-plans.test.ts`, 1 in `retry.test.ts` |
| `readEntitlement`'s record check | The new `codium-billing.test.ts` case            |
| The immediate cancel             | The adapter case and the real-Lua slot case      |

Typechecks, all through `vector-serial`, with the same results at both runs:

- API: `bun typecheck --project ../../tsconfig.json` from `packages/engine` passed.
- `packages/core` and `packages/engine`: `bun typecheck` passed.
- `packages/web`: `bun typecheck` (Astro check) gave 0 errors, 0 warnings and 177 hints across 195 files.

Prettier `--check` passes on every changed file except `test/codium-billing.test.ts`. That file was already
unformatted at `HEAD` on a line this change does not touch, and that line was left as it was.

Committed as `fix(codium): P3 review` and pushed to `codium-next` and `codium`. The push to `codium` started the
Vector Codium workflow (`.github/workflows/vector-codium.yml`). That run, 41164998802 at `99fcf1c0`, failed only on
the two calendar cases (\*) in its "Run the Codium test files" step. Its browser specs, its 8 typecheck jobs, the
HttpApi exerciser gates and the generated-client check passed. CFIX records the run's evidence.
