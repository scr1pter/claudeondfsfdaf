# Workflow Runner baseline results

The baseline does **not** establish the preregistered 20% cost reduction at equal
quality. Vector's first submission was cheaper and passes the corrected functional
gate, but every charged repair remains in the primary episode: Vector cost
$0.9495773 versus Codex's $0.9333972, or 1.73% more. The blinded code scores were
44/48 and 45/48 respectively. No critical finding was established for either
submission within that bounded review.

[baseline.json](baseline.json) contains the sanitized numeric evidence. All dollar
figures are derived from recorded provider usage receipts, not reconciled to an
invoice. Agent wall time excludes independent evaluation time.

| Delivery record | Provider requests | Usage-derived USD | Agent wall time (ms) | Original API / browser | Corrected API / browser |
| --- | ---: | ---: | ---: | --- | --- |
| Codex first submission and complete episode | 28 | 0.9333972 | 681,078 | 16/16 + 8/8 | 16/16 + 8/8 |
| Vector first submission | 37 | 0.6540243 | 440,922 | 16/16 + 7/8 | 16/16 + 8/8 |
| Vector paid repair, incremental | 17 | 0.2955530 | 227,641 | 16/16 + 7/8 | 16/16 + 8/8 |
| Vector complete episode, including repair | 54 | 0.9495773 | 668,563 | Final record: 16/16 + 7/8 | Final record: 16/16 + 8/8 |

Vector's 29.93% lower first-submission cost is a secondary observation. It cannot
replace the complete charged episode or the no-lower-quality requirement in the
[study decision rule](../README.md). This is one development-task pair with a
postlaunch instrument correction, not independent evidence of generalization.

## Original failure and correction

Both Vector evaluations originally recorded `product_failure`; their sole failed
check was `mobile_layout_and_keyboard`, reporting "No keyboard-focusable dashboard
control". The checker pressed Tab once from the preceding Events control. Chrome
could move focus into browser chrome, exposing `body` as the active document
element; a subsequent Tab returned to the native form. The checker mistook that
ordinary transition for an inaccessible dashboard.

The [postlaunch keyboard revision](../workflow-runner/instrument-revisions/postlaunch-keyboard-v2/README.md)
replaced that assumption with bounded native Tab traversal to all four required
form controls. The other seven browser contracts and sixteen API assertions did
not change. The original task commit and digest are retained in `baseline.json`
and in the revision's public provenance.

After both paid arms and the Vector repair had settled, the revised evaluator
was applied without model calls to all three unchanged submissions. Each passed
16 API and 8 browser checks; each source-integrity comparison was unchanged.
The public [corrected candidate results](../workflow-runner/instrument-revisions/postlaunch-keyboard-v2/corrected-candidate-results.json)
retain the free reevaluation provenance.
The two original Vector failures are therefore classified retrospectively as
instrument failures. Original verdicts, the repair itself, and every charge remain
historical evidence. The correction adds no provider charge and does not remove
the $0.2955530 repair from the primary cost.

## Blinded review and accounting

The recorded opaque mapping is Larch = Codex and Rowan = Vector. Both received
static source review and two supplied independent screenshots under the
[48-point rubric](../quality-rubric.md), without independent execution by the
reviewer. Codex scored 45 and Vector 44; the one-point difference was in added
verification (6/6 versus 5/6). Neither review established a critical finding.
These observations have the limits of static source and screenshot coverage.

The baseline pair adds 82 provider requests and $1.8829745, including repair.
The study therefore moves from 449 requests / $11.2319408 to **531 requests /
$13.1149153**. Historical spending was not reset.

The permitted aggregate evidence supplies request counts and cost but no numeric
input/output/cache/reasoning token totals. Those categories are explicitly missing
in the JSON, not zero; reasoning tokens must not be charged again on top of output.

[baseline-tool-activity.json](baseline-tool-activity.json) separately records
deduplicated observed CLI events: 35 tool calls for Codex, 57 for Vector's first
submission and 24 for its repair. Array positions `codex[0]`, `vector[0]`, and
`vector[1]` map to those three records. Byte counts describe observed tool payloads,
not model tokens or cost. Missing input/output/diff fields mean no observations,
not measured zero size. Error counts include explicit tool errors and nonzero
command exits; expected negative checks can produce those outcomes. Repeated
inputs likewise do not alone establish waste. The original aggregate's Codex tool
inventory is unpopulated, while this separate projection supplies observed counts.

Private paths, session identifiers, credentials, raw logs, and runtime configuration
are excluded from this evidence package.
