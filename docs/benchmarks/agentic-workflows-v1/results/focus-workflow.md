# Focus candidate: Workflow Runner repeat

Vector's complete episode cost $0.6689756 versus Codex's $0.8063259: **17.03%
lower**, below the 20% cost threshold. Vector used 19.86% less agent wall time.
Both first submissions passed all required functional checks without repair, but
their blinded code scores were 45/48 for Vector and 46/48 for Codex. This pair
does not establish the study's cost and equal-quality objective.

[focus-workflow.json](focus-workflow.json) contains the numeric usage and tool
projections, gate results, review scores, and accounting. All costs are derived
from provider usage receipts, not reconciled to an invoice.

| Complete episode = first submission | Provider requests | Usage-derived USD | Agent wall time (ms) | API / browser checks | Blinded code score |
| --- | ---: | ---: | ---: | --- | ---: |
| Vector | 34 | 0.6689756 | 439,640 | 16/16 + 8/8 | 45/48 |
| Codex | 25 | 0.8063259 | 548,609 | 16/16 + 8/8 | 46/48 |

Both arms used candidate `893b9629224dc4249f08c0e18712511437a35a22` and the
same reviewed keyboard-v2 instrument. Each completed one attempt, with authored
source unchanged through independent evaluation, no protected-input violations,
and no worker/delegation calls. Every charge is retained. Agent wall time excludes
independent evaluation time. All receipts requested `gpt-6.1-sol` with High
reasoning and returned HTTP 200.

The original [Vector source](../submissions/focus-workflow/vector-first/source)
and [Codex source](../submissions/focus-workflow/codex-first/source) are published
byte-for-byte. The [source publication and verifier](../submissions/focus-workflow/README.md)
record the complete inventories and task/evaluator provenance.

## Usage and observed tool activity

| Runtime | Input tokens | Cached input | Cache writes | Output tokens | Reasoning tokens | Observed tool calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Vector | 1,427,098 | 1,365,691 | 61,305 | 37,894 | 6,131 | 46 |
| Codex | 1,429,698 | 1,337,134 | 92,489 | 44,124 | 8,264 | 70 |

Cache reads and writes are subsets of input; reasoning is a subset of output.
They must not be added again to those totals. All recorded cache writes use the
30-minute category. The JSON also retains uncached non-write input and total
tokens. Cost comparisons use the recorded category-dependent charges, not
unweighted token totals.

The activity projection counts deduplicated observed CLI events. Tool payload
bytes are not model tokens or costs, and missing input/output/diff observations
do not establish zero size. Nonzero command exits can be expected negative checks;
errors and repeated inputs do not alone establish waste or product failure.
Codex file-change events have no observed payload sizes in this projection.

Vector has one recorded patch-envelope formatting failure. Its retry also changed
code, so the record cannot isolate the cost of formatting or predict an exact
saving from an envelope-only fix. A prospective envelope fix was not benchmarked
in this pair.

## Blinded review and material limits

The mapping is Cypress = Vector and Alder = Codex. The review used exact source
and two supplied independent screenshots per submission, without independently
executing either app or its authored tests, under the [same rubric](../quality-rubric.md).

| Dimension | Maximum | Vector | Codex |
| --- | ---: | ---: | ---: |
| Contract and data integrity | 12 | 12 | 12 |
| Durable state and recovery | 10 | 8 | 9 |
| Structure and maintainability | 8 | 8 | 8 |
| Errors and resource bounds | 6 | 5 | 6 |
| Added verification | 6 | 6 | 6 |
| User interface and accessibility | 6 | 6 | 5 |
| Total | 48 | 45 | 46 |

Neither review established a critical finding. Both implementations change the
default data directory: upgrading without an explicit `DATA_DIR` can open a new
database and leave retained v1 history undiscovered. The history is not deleted.
Vector also has a cancellation/crash window that can leave legacy status stale,
and conditional persistence/stream failures can escape child ownership or skip
live-slot cleanup. Codex's small, muted history and metadata text limits
readability; its lifecycle guards still leave conditional reaping and persisted
state limitations. Both buffer output streams in full, and storage/pipe failure
and immediate restart overlap were not independently exercised. Passing synthetic
checks and bounded static review do not establish production security,
reliability, or usability.

This is one adaptive repeat of the development task. The candidate bundles
browser-focus metadata and revised verification guidance, so their individual
effects cannot be isolated. Both candidate arms and the free baseline
reevaluations share the corrected browser instrument, while the original paid
baseline repair followed the earlier checker. Comparing before and after cannot
attribute a cost or quality change to a single product change. No held-out task
result is established here.

## Historical accounting checkpoint

At settlement, this pair added 59 provider requests and $1.4753015. The study moved
from 531 requests / $13.1149153 to **590 requests / $14.5902168** without resetting
spending. This is a historical checkpoint at pair settlement, **not the current
bill**: subsequent holdout activity is excluded.

## Browser provisioning limitation

Both CLI environments exposed the same Playwright module and Chrome executable
in addition to the common browser client. In the baseline, Codex authored and ran
`scripts/verify-browser.mjs` directly; in the focus run, Vector authored and ran
`scripts/browser-check.mjs` directly. Three execution references were verified for
each of those scripts. Their sources import Playwright and launch Chrome.

The task requested the common client, while the runner preamble explicitly
advertised PLAYWRIGHT_MODULE and CHROME_PATH. Those instructions conflicted;
shared-client exclusivity was not enforced. This is an instrument limitation,
not assumed agent misconduct. The runtimes received identical host capabilities, but their own
browser checks did not all use the same interface. These are exploratory results,
not clean evidence of strict shared-client protocol adherence. Model, reasoning,
agent-count, cost and authored-source records remain intact. The independent
acceptance browser used its separate exact-origin fence. This observation does
not establish unobserved external interaction or cheating; no such claim is made.
