# Interrupted request accounting

This change prevents two started-request paths from looking like measured free
work when the provider has not supplied terminal usage. It does not estimate a
provider bill or establish inference-cost savings.

The legacy processor now observes successful SDK streaming-response acceptance,
including an accepted HTTP response interrupted before its first SDK event. An
empty usage marker preserves the existing incomplete/unpriced settlement path.
The acceptance callback is separate from the usage callback, so ancillary
attempts are not started a second time.

The V2 runner retains an observed protocol step start. If the turn exits without
a terminal step settlement, it persists one incomplete settlement using the
existing durable event and records uncertainty in the spend guard. The durable
cost field remains finite zero with `unpriced: true`; that zero is a placeholder,
not a measured charge. A real terminal settlement remains authoritative. Known
free routes retain their free cost kind and do not consume unknown-cost allowance.

## Verification

From base `a35c03d6a9bb16f16ec0187ad69c6c6420d10f19`, on Windows with Bun 1.3.14:

| Package | Command | Result |
| --- | --- | --- |
| core | `bun test test/session-runner.test.ts test/session-runner-model.test.ts test/session-projector.test.ts test/spend-guard.test.ts --timeout 30000` | 190 passed, 653 assertions |
| engine | `bun test test/session/processor-effect.test.ts --timeout 30000` | 36 passed, 195 assertions |
| core | `bun run typecheck` | exit 0 |
| engine | `bun run typecheck` | exit 0 |

Prettier and `git diff --check` passed. No paid provider requests were used.
Nine targeted controls cover queued pretransport work, rejected HTTP, accepted
HTTP before chunks, partial V2 interruption, explicit zero, known terminal
usage/replay, and guaranteed-free allowance preservation.

Before/after evidence uses the final synchronized fixtures. Disabling only the
new legacy acceptance mark while retaining an additive callback barrier caused
the accepted-response unknown-usage assertion to fail. Restoring the three V2
production files to the base revision caused the partial-interruption unknown
assertion to fail while its three original controls passed. Restoring the fix
made the checks pass. Earlier legacy attempts that waited only for server receipt
had a fixture race and are excluded from accounting-defect evidence. Test setup
also needed independent model pricing, reset captured requests, a historical
guard-snapshot assertion and complete cache-rate types; failed intermediate
checks were retained privately rather than reported as successful runs.

## Remaining boundaries

- V2 accepted HTTP without any parsed protocol event is outside the step-start
  fallback.
- V2 terminal `step-finish` without usage still needs separate unknown-usage
  treatment.
- These local checks validate accounting and regression behavior. They do not
  establish full multiagent quality, actual billion-token inference behavior, or
  a general cost advantage over another harness.

The patch is isolated from the frozen paid-study candidate. No benchmark outcome
is attributed to this change.
