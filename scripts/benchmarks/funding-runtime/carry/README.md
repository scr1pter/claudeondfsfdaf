# Conservative continuation of the existing additional $20 round

This source does not authorize another $20. It resumes the unused part of the
same additional allowance after the comparator's upstream connection closed
before response headers. That arm remains incomplete; it is not a benchmark win.

The approved plan conserves the original upper exposure ceiling:

| Item | USD |
| --- | ---: |
| Known spending before the additional round | 29.5790950 |
| Known additional-round spending before this continuation | 1.5835914 |
| Original unresolved request, sequence 1340 | 5.7300000 |
| Later unresolved request, sequence 1419 | 1.4477650 |
| Maximum further admitted exposure | 16.9686436 |
| Unchanged cumulative upper exposure ceiling | 55.3090950 |

The second unknown is a durable `measuredUsd: null` observation with failure
`RemoteDisconnected`; it has no HTTP status, response ID or usage. Neither its
reservation nor the earlier missing receipt is converted into measured spending,
invented as zero, credited, refunded or automatically retried. Its original row
and both histories remain byte-for-byte unchanged. The next admission is 1420.

## What is reused and what changes

The gateway inherits the existing audited reservation/settlement implementation,
Responses transport, rates and model policy. It adds a strictly pinned audit of
the two immutable histories and exactly two carried liabilities. Actor ceilings
and the cumulative ceiling remain those of the original additional-$20 plan.
Both runtime actors share the remaining allowance. Historical non-runtime actors
remain sealed. New helper, retry, judge and comparator calls all consume it.

Only the new continuation's journal and derived snapshot are writable. A
source-pinned placement marker outside both histories is written exclusively and
fsynced before the matching anchor and empty financial inventory. A restart
requires the same placement, anchor, inventory, fully priced current receipts,
and clean current snapshot. Missing, malformed, unknown or unpaired **new**
receipts fail closed. There is no automatic third-liability exception.

`reservedUsd` and `active` cover only this continuation's live calls.
`historicalLiabilityUsd` remains 7.177765 and
`allHistoricalAdmissionsSettled` remains false.
`allCurrentRoundAdmissionsSettled` can become true only for the newly owned
continuation scope. `newRoundMeasuredUsd` includes the earlier 1.5835914 plus
new measured usage; `newRoundExposureUsd` also includes the later 1.447765 hold
and new live reservations, all under the original additional $20 allowance.
No claim about final invoices is inferred from these usage-derived amounts.

## Verification

Run the free tests with Python, without a provider key:

```text
python -B -m unittest discover -s scripts/benchmarks/funding-runtime/carry -p test_budget_gateway_v7.py
python -B scripts/benchmarks/funding-runtime/carry/verify_source.py --git-index
```

The 15 synthetic tests exercise actual v6 temporary-ledger production behavior
to create known and unknown observations, then the actual continuation audit and
budget. They cover conservation, immutable histories, sequence, shared holds,
clean restart, no historical settlement, duplicate protection, new uncertainty,
history and inventory tampering, placement and anchor deletion, alternate paths,
plan byte identity, returned-state isolation, concurrent bootstrap, and an
occupied Windows port before any budget/config/key access.

Root independently reran all 15 tests and reviewed the source before freeze.
A separate read-only audit of the exact real histories passed. That audit did
not initialize a new ledger, read credentials or call the provider. These checks
do not assert that a funded continuation has run or that either benchmark arm
has completed.

## Starting an owner-reviewed continuation

Use `budget_gateway_v7.py` with the source-pinned private paths supplied by the
owner's operations record. Its arguments are `--directory`,
`--original-directory`, `--previous-directory`, `--placement-file`, `--phase-plan`,
`--controller-config`, and optional `--port` (23128). There is no runtime override
for approved hashes or locations. Both prior process locks and the exclusive
listener are acquired before a masked provider-key prompt. The key stays only
in process memory. The gateway starts with no batch armed.

Do not edit either running runtime or immutable history. Stop only an owned,
quiescent old process before replacing it. Preserve all holds and the complete
audit trail when reporting outcomes. Private journals, local capabilities,
credentials, raw transcripts and machine paths are excluded from this source.
