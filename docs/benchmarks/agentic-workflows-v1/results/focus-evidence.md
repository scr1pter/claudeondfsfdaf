# First-candidate Evidence Workbench result

Both delivered applications pass all 18 API and 8 browser checks. Vector costs
0.7697271 USD versus Codex's 0.7953841 USD (3.23% less), but its
blinded score is 45/48 versus 47/48. The 20% equal-quality target is not met.

| Runtime | Provider requests | Usage-derived USD | Agent wall time | Corrected checks | Blinded score |
| --- | ---: | ---: | ---: | ---: | ---: |
| Vector | 53 | 0.7697271 | 498,515 ms | 26/26 | 45/48 |
| Codex | 31 | 0.7953841 | 489,016 ms | 26/26 | 47/48 |

[Numeric usage, activity and findings](focus-evidence.json) retain all recorded
charges. Cache reads/writes are subsets of input; reasoning is a subset of output.
Neither category is counted twice. Charges are usage-derived, not invoice-reconciled.

Codex originally received an instrument false negative: it visibly reported
“Batch import failed: Source must be a nonblank string.” after HTTP 400 invalid_batch,
but the checker rejected that useful phrasing. A read-only controller timeout
then stopped the attempted repair launch before another provider request. The
original report, aborted launch, unchanged source snapshots and charge remain
retained. The corrected checker passes all 26 checks on that same first delivery
without app changes or model calls. Vector then ran only the missing arm using
validated original source/public prompt/seed/model/tool/budget lineage.

[Exact original source publication](../submissions/focus-evidence/README.md)
contains all31 authored files, including Codex's hidden authored browser script;
hashes account for19 omitted generated databases/logs/images/reports. No generic
hidden-folder or nested build/dist exclusion discards source.

The same reviewer and48-point rubric scored blinded source and two independent
end-state screenshots for each delivery. The screenshots show paginated search,
so other interaction states remain unobserved. Neither review established a
critical finding. Static concerns include a citation-selection race for Codex;
Vector's transport-size limit for valid heavily escaped batches, avoidable large
validation allocations, and test coverage that bypasses its actual server entrypoint.
These are bounded findings, not production security or reliability certification.

The old runner advertised raw Playwright/Chrome while also requesting the common
client. Both runtimes received identical host capabilities; strict common-client
exclusivity was not established. That conflicting instrumentation is not evidence
of agent misconduct or unobserved external actions. Independent acceptance used
its separate exact-origin fence. All costs and results remain descriptive evidence.

The combined [fixed-candidate stage](focus-stage-summary.json) costs10.18% less
for Vector across the two tasks, with scores90/96 versus93/96. The broader target
remains unmet. At historical settlement the complete study is674 receipts /
16.1553280 usage-derived USD; this checkpoint excludes future activity.
