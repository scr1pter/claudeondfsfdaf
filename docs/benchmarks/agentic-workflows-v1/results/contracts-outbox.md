# Contracts candidate: Delivery Outbox, Task 3

Both first submissions passed **26/26 independent functional checks**. Fixed
blinded static scores are **Vector 47/48 and Codex 46/48**. Vector cost
$0.5419832 versus Codex's $0.5126617: **5.7195% more**. This task does not meet
the cost target. The [three-task summary](contracts-stage-summary.md) records the
bounded stage decision.

Both original runs still record `coordinator_review_required` and automatic
browser audit `review_required`. Each separate manual disposition is
`bounded_manual_review_no_clear_bypass_observed`. These manual reviews supplement
the flags without rewriting them or proving complete adherence.

| Original complete episode | Provider requests | Usage-derived USD | Agent wall time (ms) | Checks | Static score |
| --- | ---: | ---: | ---: | --- | ---: |
| Vector | 36 | 0.5419832 | 427,813 | 18/18 API + 8/8 browser | 47/48 |
| Codex | 23 | 0.5126617 | 427,360 | 18/18 API + 8/8 browser | 46/48 |

Each arm settled one attempt without paid repair. Every charge remains counted;
there was no rerun or refund. Only the previously missing Codex arm was continued
under the immutable pre-Vector plan and unchanged task/execution pins. The
original Vector record was retained. App source and instrument were unchanged
through both independent evaluators. Vector used product revision
`a35c03d6a9bb16f16ec0187ad69c6c6420d10f19`; Codex used its separately pinned
CLI. Both used one `gpt-6.1-sol` agent with High reasoning. The runtime task digest
is `a20b22b9e3f8c7d4768b5db5d19fb09e8f3b33efff64ccf49b7b895ee74d2ce7`,
distinct from the source-only freeze.

## Usage and source provenance

[contracts-outbox.json](contracts-outbox.json) retains numeric receipt projections,
original automatic audits, separate manual reviews and fixed quality findings.
All selected receipts returned HTTP 200. Recorded funded rates exactly reconcile
both charges; costs are usage-derived, not invoice-reconciled.

| Runtime | Input tokens | Cached input | Cache writes | Output tokens | Reasoning tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Vector | 1,398,460 | 1,341,547 | 56,805 | 26,560 | 6,576 |
| Codex | 834,634 | 778,762 | 55,803 | 29,514 | 6,603 |

Cache reads/writes partition input and reasoning partitions output; none is added
or charged twice. Vector supplies TTL detail for all 36 receipts. Codex's 23 omit
that detail and use the funded meter's 30-minute cache-write default. Wall times
exclude independent evaluation time.

The [source publication](../submissions/contracts-outbox/README.md) preserves exact
original application archives: **16 Vector files and 17 Codex files**, with no
exclusions. Separately, it publishes one Vector and three Codex current authored
support scripts from mutable data directories outside the immutable app manifests.
Those supplements do not become original archive files.

Vector's current support hash matches logged AddFile creation content, but its
historical executed bytes are unauthenticated. Codex's current hashes authenticate
the copied posthoc scripts; simple creation-text extraction did not reproduce
nested shell escaping. That does not establish an unlogged mutation, and no
creation-to-execution equivalence is claimed. Authored records and logged exits
are not independent success attestations. App-source integrity checks do not
cover those external mutable scripts. Both manual dispositions remain bounded
static/transcript evidence, with no hard execution fence or complete adherence
claim.

## Fixed blinded review and material findings

Maple = Vector and Birch = Codex. Reviewers compared exact original source and
separate current support code against the neutral seed and fixed rubric. Neither
reviewer independently executed apps, tests, builds, browser automation or network
requests.

| Dimension | Maximum | Vector | Codex |
| --- | ---: | ---: | ---: |
| Contract and data integrity | 12 | 12 | 12 |
| Durable state and recovery | 10 | 10 | 9 |
| Structure and maintainability | 8 | 8 | 8 |
| Errors and resource bounds | 6 | 5 | 6 |
| Added verification | 6 | 6 | 6 |
| User interface and accessibility | 6 | 6 | 5 |
| Total | 48 | 47 | 46 |

Neither review established a critical finding. Material source findings remain:

- Vector drains the entire queued backlog with unbounded `Promise.all` fan-out.
  Duplicate-attempt coalescing does not cap distinct-message delivery concurrency;
  no overload or data loss was observed.
- Codex leaves legitimate legacy `failed` rows outside retry/drain recovery paths.
  Data and keys remain, and provider cancellation can still reconcile an outcome;
  irreversible receipt or data loss was not established.
- Codex Queue/Cancel does not release an open editor, leaving later saves aimed
  at a now-immutable message and returning 409. Reloading or editing another draft
  can recover the page; saved message data is not lost.

For **each runtime, both independent images are 390px queued/delivered end
states**. No independent desktop view was supplied. The authored manual-audit
desktop PNG is not substituted for those images. Below-fold mobile reachability,
keyboard/screen-reader behavior, live races/restarts, legacy upgrades, SQLite
faults and large-backlog load were not independently observed. These bounded
scores do not guarantee production quality.

## Historical accounting checkpoint

The complete pair adds 59 requests and $1.0546449, moving the study from
830 requests / $19.2491842 to **889 requests / $20.3038291**. The intermediate
Vector-only checkpoint remains in the JSON. These are historical settlement
checkpoints, **not the current bill**; later activity is excluded.
