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
