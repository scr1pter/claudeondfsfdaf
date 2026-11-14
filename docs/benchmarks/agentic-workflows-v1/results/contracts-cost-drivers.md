# Where the remaining cost goes

The fixed single-agent stage saved 5.0122%, below its 20% goal. This breakdown
uses the same complete provider receipts as the published task results. It
does not compare subscription prices or claim invoice reconciliation.

| Three-task total | Vector | Codex |
| --- | ---: | ---: |
| Provider requests | 127 | 88 |
| Input, including repeated context | 5,555,522 | 4,329,022 |
| Cache-read input | 5,341,722 | 4,099,814 |
| Cache-write input | 213,419 | 228,944 |
| Output, including reasoning | 95,245 | 114,470 |
| Usage-derived USD | 2.0209317 | 2.1275694 |

Vector generated less output, saving $0.19225, and wrote less cache, saving
$0.0388125. Its additional cache reads cost $0.1241908, consuming much of that
advantage. Ordinary input adds a further $0.000234. Reasoning is already within
output and must never be added a second time.

Delivery Outbox makes the tradeoff particularly clear: Vector's additional
replay reads cost $0.0562785, and writes cost $0.002505. Output was $0.02954
cheaper; the remaining ordinary-input difference was $0.000078. Together these
produce Vector's $0.0293215 premium on that task.

These observations support investigating redundant turns and repeated context.
They do not prove that every additional turn was unnecessary. Verification,
recovery and independent review can justify additional calls. Cache reuse was
already 96.15% for Vector and 94.71% for Codex, so enabling a cache alone cannot
explain or solve the gap. No long-context pricing surcharge appeared in this
stage. Cache/session privacy controls and the model's reasoning settings remain
intact.

The separate matched-team study will count the lead, both workers, the judge,
helpers and repairs. It must retain every functional check and pass the same
per-task blinded quality gate before any saving is accepted. These three tasks
are development replications for that later study, since their outcomes are
already known. Its outcomes must not be pooled with this single-agent stage.

The category projection is in [contracts-cost-drivers.json](contracts-cost-drivers.json).
The original [stage summary](contracts-stage-summary.md) retains quality findings,
browser-audit limitations and all charges. Historical unequal development runs
are retained in the study ledger and are not fair matched comparisons.

## Tool orchestration observed in the same deliveries

Read-only native trace inspection found a capability difference worth testing
as a future Vector candidate:

| Task | Vector provider requests | Vector primitive tool calls | Codex provider requests | Codex composition calls | Codex command executions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Workflow Runner | 47 | 60 | 30 | 29 | 74 |
| Evidence Workbench | 44 | 61 | 35 | 34 | 39 |
| Delivery Outbox | 36 | 57 | 23 | 22 | 27 |

Codex's native programmatic tool wrapper can compose dependent operations and
loops within one inference turn. Vector's inspected engine mostly exposes
primitive tools; independent file reads were already batched. Provider requests,
primitive calls and command executions are different units and cannot be compared
as if each were an inference. These traces do not show that all 39 additional
Vector requests were avoidable.

Nine standalone progress-bookkeeping turns carried $0.113275 of provider charges.
That is an upper bound for investigation, not a demonstrated recoverable saving:
batching can shift subsequent context and behavior. Later file reads often
followed edits or final review. Browser failures included corrected selectors
and real debugging, while both products made some common-client schema mistakes.
Suppressing those checks or treating deliberate Ctrl+C shutdown exits as product
failures would misread the evidence.

A bounded composition tool is a plausible separate candidate. It would need to
retain each underlying tool's permissions, cancellation, durable records,
accounting and verification, then pass new delivery-quality comparisons. No such
feature or saving is established here. The heavier control preserves Codex's
native composition capability. No proprietary runtime prompt is copied.
