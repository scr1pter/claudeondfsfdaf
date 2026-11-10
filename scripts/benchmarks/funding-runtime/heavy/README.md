# Equal remainder allocation

The owner approved splitting the remaining allowance equally on November 2,
2026. Total authorization stays **$48**. The immutable historical checkpoint is
889 requests / $20.3038291; nothing is refunded, repriced or reclassified.

Each runtime receives **$13.84808545 additional allowance**. Cumulative ceilings
become $24.73654725 for `foundry-vector` and $20.31968465 for `foundry-codex`.
All three other actors are sealed at their historical spending. The sum of all
cumulative ceilings is exactly $48. These are API study limits, not a statement
of the account's promotional-credit balance.

`budget_gateway_v5.py` reuses the archived v3 reservation, transport, pricing,
durable journal and settlement implementations. It changes only the explicitly
approved immutable allocation at process startup. It accepts only
[`heavy-phase-plan.json`](../heavy-phase-plan.json), SHA256
`5f75ba025ae3d4f3cde51b4d85586df63fee00e76fdcc300dc1ecd530a0e4c6e`.
That plan binds both historical journal prefixes and the previous durable v4
allocation. Existing allocation and journal bytes must remain unchanged.

The new allocation is fsynced before any request. Full v3 reconciliation still
checks every historical usage/price/admission/receipt. Missing receipts,
unresolved reservations, altered prefixes, changed allocation audits and
post-boundary sealed-actor activity fail closed. There is no reset, force,
unseal, automatic recovery, key argument or live allowance-mutation option.
Importing the module starts nothing and reads no runtime configuration.

The explicit Windows CLI requires the existing private ledger, owner-total
authorization and controller configuration. It takes the same exclusive
process lock and binds an exclusive loopback socket before key entry. The
provider key is read through a hidden console prompt and retained only in
process memory. No batch is armed at startup. Do not check private configuration,
raw journals or keys into GitHub. This historical plan cannot initialize a new
empty ledger on another computer; its exact private history is required.

Free controls run from this directory:

```sh
python -B -m unittest test_budget_gateway_v5 -v
```

Tests use temporary synthetic journals and a process-local fixture approval
digest. Production exposes no caller-configurable approval digest. Tests do not
read live configuration, start an HTTP server or call a provider. The archived
v2/v3/v4 source and its existing manifest remain untouched.
