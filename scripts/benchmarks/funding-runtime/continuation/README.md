# Additional USD20 round with carried uncertainty

This is a new, explicitly authorized funding phase for the owner's November 4,
2026 instruction to use up to USD20 more in API credits. It is a benchmark
financial instrument, separate from Vector's product tokenomics implementation.
Importing the module reads no configuration or financial file, starts no server,
and acquires no credential. No paid run is asserted by these source tests.

The original ledger is retained: 1,339 settled receipts total USD29.579095, while
request 1340 has no trustworthy final usage and retains its full USD5.73
liability. No receipt is invented, no old hold is released, and none of that hold
is described as a measured charge. The maximum cumulative admitted exposure is
USD55.309095: known old cost + held old liability + the new USD20 ceiling.

Both runtime actors draw from the **same new USD20**; their individual ceilings
are not two separately spendable USD20 allocations. This avoids a USD10-per-arm
hard stop that can make the unchanged USD5.73 full-image reservation impossible
late in an otherwise useful build. All retries, specialists and helpers forwarded
under an actor consume this one central allowance. Old non-runtime actors stay
sealed. The full model, High reasoning, context, output, image and 30-minute cache
policies remain unchanged. No counting API or guessed image-token formula is used.

## Source-pinned authorization

The root-owned [phase artifact](approved-phase-plan.json) is copied byte-for-byte.
Two hashes have distinct purposes:

- Raw approved file SHA256:
  `19ee7dbe02ff9e5d3ab2d8e41c1da1f738d1977f879a4a4be284947c793b1255`.
- Sorted compact UTF-8 JSON SHA256 (`ensure_ascii=False`, separators `,` and `:`):
  `b91f3cfdd0738299f44ffa23e9a8850ca5751665a521859cf5c1fc2507ee0d5d`.
  This is the runtime `phasePlanSha256`, also used by the new matched witness.

The historical ledger and new ledger locations are additionally pinned by
normalized absolute-path hashes in source. There is no command, environment or
configuration override for approval or placement. Synthetic tests patch pins only
inside their own temporary process; that is not a production recovery mechanism.

At startup, every pinned historical file is hashed, every known receipt is
repriced using the unchanged v3 price function and immutable admission matching,
and the only permitted historical mismatch is the precise approved 1340 record.
Additional unknown historical calls, changed prefixes, malformed counts, wrong
tiers, rate changes, duplicate sequences and changed cumulative costs are refused.
The historical v3 entrypoint still rejects the unmatched request; it is not patched.

## One durable continuation, not a reset

All preexisting historical journals, status and allocations remain byte-for-byte
unchanged. A **new** `phase-placement-v6.json` audit is added to the historical
directory under its existing exclusive process lock. It binds the one approved
new ledger location, phase, bootstrap identity and new anchor hash.

The placement is fsynced before the matching new anchor, empty admission and
receipt journals, and first status snapshot. All three financial components must
exist before any key prompt or future restart. Missing placement, missing or
changed anchor, partial bootstrap, or missing current journals/status fails closed.
An alternate empty directory cannot create another USD20 allowance. The tested
same-path deletion case retains both anchors but deletes all three financial
files; restart rejects it rather than resetting spending.

New calls use a separate directory with the usual `admissions-v2.jsonl` and
`receipts.jsonl` names. Actual global sequence numbers start at 1341. Historical
1340 remains absent from the settled set. Every new admission must receive its
own known durable receipt; a new missing or uncertain receipt halts and refuses
restart. The old single carried exception cannot absorb another unknown call.

This local process/placement protocol does not claim to defeat a local
administrator who erases or rewrites all authoritative financial traces, and is
not a distributed multi-host spending service. Moving the funded study to another
host requires an explicit reviewed state/placement migration, not a fresh ledger.

## Status semantics

`active`, `reservedUsd`, `newRoundReservedUsd` and
`allCurrentRoundAdmissionsSettled` describe newly admitted calls in this round.
The historical unknown is not a live request or a silently settled request.
It remains separately visible and binding:

- `historicalLiabilityUsd = 5.73`, `carriedUnresolvedRequestCount = 1`.
- `historicalUncertaintyRemains = true`, `allHistoricalAdmissionsSettled = false`.
- `historicalKnownMeasuredUsd = 29.579095`, `historicalAttempts = 1340`.
- `newRoundMeasuredUsd = cumulative known cost - 29.579095`.
- `cumulativeUpperExposureUsd = cumulative known cost + new reservations + 5.73`.
- `remainingAdmissionUsd` subtracts that held liability as well as current costs.

The per-actor status similarly exposes its held historical liability and upper
exposure. A new-round closure can be fully settled without claiming that the old
study's unresolved request is settled. The matched financial witness must validate
this phase explicitly; translating it to the old USD48/zero-liability profile is
not permitted.

## Startup and credential boundary

Use the actual reviewed executable with explicit paths:

```text
python budget_gateway_v6.py --directory <approved-new-ledger> --historical-directory <pinned-old-ledger> --phase-plan <exact-approved-artifact> --controller-config <new-private-controller-json> --port 23128
```

The controller file must be outside the initially empty new ledger and contain
only a new local `localToken` capability. The old process lock and exclusive
loopback socket are acquired before ledger bootstrap or key entry. An occupied
socket or process lock fails before requesting a key. The provider API key is
entered through `getpass`, kept only in process memory, and has no CLI argument,
environment fallback or persistence route. The controller configuration and key
must never enter Git, terminal output, native transcripts or the investor report.
No batch is automatically armed. Unknown admission/settlement metadata is refused.

## Free verification

From this directory, using Python 3.11 or later on Windows:

```text
python -B -m unittest test_budget_gateway_v6 -q
```

The final suite has **34 passing methods**, zero failures and zero skips on the
reviewed Windows host. Tests use temporary synthetic financial records; no real
key, controller config, provider call, Bun workload or browser is used. Three
startup controls bind only owned temporary loopback sockets/process locks and
cancel a mocked key prompt. A deliberate fsync-failure control prints a redacted
synthetic storage diagnostic, then verifies further admission and restart fail.

Covered cases include shared financial ceilings with the old hold retained,
historical pricing/metadata negatives, monotonic global sequences, no credit from
duplicate or historical settlement, sealed actors, missing/uncertain current
receipts, immutable anchors, both placement pins, same/different-target races,
partial bootstrap, deleted journal inventory, caller-plan mutation isolation,
initial snapshot failure, occupied socket and process lock, masked-prompt cleanup,
and the unchanged USD5.73 full-image reservation.

A separate read-only check of the real historical files verified all 1,339 known
prices and the one precise held request. It did not construct a live `Budget`,
create the actual placement audit, read credentials, or change financial files.
The [validation record](validation.json) distinguishes those facts from tests.
