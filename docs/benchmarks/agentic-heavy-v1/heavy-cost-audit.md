# Closed heavy Vector cost audit

The closed Vector arm spent **$6.7876388 across 300 requests**. All receipts were
reconciled and all charges remain included. This is a descriptive audit of one
development replication, with no matched savings claim. The portable
[audit data](heavy-cost-audit.json) complements the [observed result](interim-result.json)
and the [study requirements](STAGE.md).

| Role | Requests | Measured USD |
| --- | ---: | ---: |
| Lead | 128 | 1.9251992 |
| Backend coordinator | 12 | 0.2801839 |
| Frontend worker | 17 | 0.7480924 |
| Backend API | 25 | 0.6611075 |
| Backend data | 17 | 0.3053056 |
| QA specialist | 64 | 1.8676269 |
| Team judge | 37 | 1.0001233 |

The provider meter is authoritative for these dollars; they are not an account
invoice reconciliation. Ordinary input cost $0.02344, cache reads $2.4992788,
30-minute cache writes $2.14254, and output including reasoning $2.12238.
The 25,861,524 processed input tokens include replay. Reasoning is already
included in output and is not charged again in these totals.

## Verification and coordination

QA and judge together used 101 requests and **$2.8677502 (42.25%)**. Their work
includes useful API, browser, concurrency and permission verification. The
145 turns labelled execution or verification cost $3.0039491; that broad
heuristic category cannot be described as polling waste. The lead's 41 read
calls had 41 distinct exact inputs, so this trace does not establish broad
identical source rereading waste.

There is a narrower opportunity in lead coordination: 24 wait-only turns cost
**$0.3638841 (5.36%)**. Eighteen timed out with tasks still running, accounting
for **$0.2666752 (3.93%)**. These amounts attribute provider turns that requested
waits; they are not prices for the wait tools or proven recoverable savings.
Some waits returned completion or failure, and timeout results may still help
coordination. Wait, todo and message-only turns together cost $0.5268907;
their full cost is not assumed removable.

Implementation consumed 294 requests/$6.5005907. The formal repair consumed
**six requests/$0.2870481** before request-limit refusal. Only five repair
steps/$0.1472696 have completed native activity joins. Provider ordinal 300,
the frontend request costing $0.1397785, is fully charged and lacks a completed
native step. Its tool activity is not inferred. Both invocation source manifests
match: the repair delivered no source change.

The original evaluation had 64 passing, four failing and eight not-run rows.
A documented navigation correction on unchanged source yielded 74 passing and
two failing rows. Bodyless order cancellation and whole-document mobile overflow
remain genuine failures. Original false feedback remains a confound. The 76 rows
include four prerequisites and are not 76 independent business behaviors.

## Opportunities to measure next

- Coalesce waits and status notifications before another model turn, retaining
  completion, failure and user-progress delivery.
- Bound browser/tool evidence and summarize completed work while preserving
  cacheable prefixes. Wait-only prompt input ranged from 26,476 to 126,060 tokens;
  cached replay still costs money, but shortening context can harm quality.
- Batch deterministic checks and reuse receipts bound to the delivered source
  and relevant test state. Retain required independent QA and targeted judge checks.
- Allocate request capacity for final verification and repair earlier. This repair
  reached the request ceiling; another allocation has not been shown to succeed.

These are hypotheses for a separately frozen stage. No measured percentage
saving follows from deleting an activity category after the fact.

## Evidence limits

The audit rechecked the witness hash chain, all 300 request/response/receipt
tuples and seven transcript file hashes, then reproduced the existing sanitized
projection without writing it or making provider calls. It uniquely joins 299
completed native steps/$6.6478603 by role, exact token tuple and a bounded timing
interval. This is not a provider-response-ID join. Turn labels are heuristic and
do not divide mixed-turn cost among tools. The remaining $0.1397785 stays in the
total. Private native identities, local locations and raw transcripts are omitted.
This arm does not establish passing quality, causal savings, a matched efficiency
result or an operating-system sandbox guarantee.
