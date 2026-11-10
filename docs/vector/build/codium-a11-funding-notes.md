# A11 funding observations and owner alerts

This slice extends the existing funding guard and owner notifier. It does not
change the provider key inventory, deferred A10 liability/version protocol,
checkout reservations, renewal collection or customer access. Collection and
runtime-switch changes belong to the rest of A11.

## Private observations

Successful checks retain private readings at `funding:history` in the existing
mode namespace. Readings use five-minute buckets, retain seven days, contain at
most 2,017 points and expire after seven days without a write. The funding lease
already serializes updates. Repeated checks in one bucket replace its sample;
the current `funding` record retains the latest full reading separately.

All stored monetary amounts and spend rates use integer cents. Runway is days,
rounded to two decimal places. At least five minutes of observations are needed
before reporting a spend rate. Runway remains unknown with no observed spend.
Daily spend uses the available seven-day history; hourly spend uses available
samples from the last hour. Shorter meaningful windows are normalized to those
rates, so an early hourly alert can fire before a full hour has elapsed.

Rates use OpenRouter's cumulative `total_usage`, so a credit addition cannot hide
consumption by increasing the balance. A decrease in cumulative usage starts a
new observation baseline; a private reset timestamp preserves that boundary even
when a same-bucket sample replaces the higher counter. Runway estimates remaining balance divided by observed
daily consumption; the separate `required` amount still includes all paid
obligations, reservations, room for another largest sale and the configured
margin. A runway estimate never authorizes a sale.

Invalid history, invalid configured alert thresholds, unsafe amounts or failed
measurements fail closed through the existing unavailable-funding pause. They do
not become a zero-spend or zero-liability reading. No telemetry code skips the
A10 liability-version check or changes the financial reservation scripts.

Sales and early renewal charges accept cached readings only when their timestamp
is no later than the decision time and their age is below fifteen minutes. A clock
rollback therefore triggers a fresh check. A busy checker returning the old
future-dated reading cannot authorize either operation. The funding clock rollback
follow-up in [the A11 record](codium-a11-notes.md) documents the reproduced cases
and verification.

## Alerts

- Low water warns while sales remain funded at or below 1.25 times `required`.
  It does not pause existing access or renewal collection.
- `CODIUM_OPENROUTER_TOPUP_THRESHOLD_USD` has no invented default. When configured,
  the watchdog warns after twenty minutes below that threshold without a detected
  credit addition. Same-bucket checks retain the original wait. A credit addition
  restarts the wait even if the balance remains low; reaching the threshold clears
  it. A temporary failed reading preserves the last observed wait.
- `CODIUM_SPEND_SPIKE_USD_PER_HOUR` has no invented default. When configured, it
  warns when the observed hourly spend rate reaches it. Alert thresholds must
  represent positive, safely representable integer cents.
- Existing pause, unavailable and reopened email subjects remain unchanged and
  use the shared `notifyOwner` sender. Failed delivery is retried; successful
  owner alerts are deduplicated. Failed reopened emails retain a pending marker
  so the next healthy check can retry them.

The owner emails and server store may contain private funding information. The
funding cron serializes only enabled/status/ran/notified and an alert count; it
never serializes money, history, rates, runway or email addresses. Production
owner configuration and sending real emails are outside this implementation
work; focused checks use only isolated store/provider/mail fakes.

## Validation status

The new focused file is `test/codium-funding.test.ts`. It covers history retention,
actual usage, unknown runway, usage adjustments, alert boundaries, deduplication,
watchdog continuity/refills, delivery retries, preserved deferred liability and
checkout reservations, version races and cron response redaction.

The A11 lead ran the checks serially in the coordinated validation slot:

- `test/codium-funding.test.ts`: **21 passing**, including same-bucket counter
  reset and count-only cron response checks.
- API typecheck: **passed** after the final reset-boundary change.
- `packages/web/test/codium-payments.test.ts`: **22 passing** against the existing
  local provider/Valkey fixtures. Existing pause/reopen subjects, funding
  reservations and owner delivery retries remain covered.

The broader A11 switch, collection, billing and A10 regression results belong to
the lead's integration record. These local results do not establish protected
provider e2e, a deployment, real account settings or production email delivery.
