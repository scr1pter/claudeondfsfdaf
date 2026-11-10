# Contracts candidate: Workflow Runner, Task 1

Both first submissions passed all 24 required independent checks and scored
**45/48**, with identical dimension scores in blinded static review. Vector's
complete episode cost $0.7512629 versus Codex's $0.8919725: **15.78% lower**.
Vector used 22.67% less agent wall time. Neither arm needed a repair.

This is the first task of the candidate's three-task evaluation. Quality takes
priority: no task may have lower quality, and a stronger result on another task
cannot offset a weaker task. Equal recorded scores here are bounded evidence;
they do not establish broader release quality. Cost is secondary. The full
candidate decision awaits all three tasks, and this pair does not establish the
20% cost target.

[contracts-workflow.json](contracts-workflow.json) contains the numeric usage,
bounded browser-audit metadata, acceptance results, review scores, and accounting.
All costs are derived from actual provider usage under the funded meter, not
reconciled to an invoice. Every charge is retained.

| Complete episode = first submission | Provider requests | Usage-derived USD | Agent wall time (ms) | API / browser checks | Blinded code score |
| --- | ---: | ---: | ---: | --- | ---: |
| Codex | 30 | 0.8919725 | 664,828 | 16/16 + 8/8 | 45/48 |
| Vector | 47 | 0.7512629 | 514,140 | 16/16 + 8/8 | 45/48 |

Vector used the clean candidate revision
`a35c03d6a9bb16f16ec0187ad69c6c6420d10f19`; Codex used its separately pinned CLI.
Both arms used the same keyboard-v2 task digest
`bc418928e76adaebed02f7de9339d23c881c0d10bca33adb7b4b5002b6de7547`, and one
autonomous `gpt-6.1-sol` agent with High reasoning. Each completed one attempt,
with authored source unchanged through independent evaluation, no protected-input
violations, and no worker/delegation calls. All selected receipts returned HTTP
200. Agent wall time measures normal completed episodes and excludes independent
evaluation time.

The [Codex source](../submissions/contracts-workflow/codex-first/source) and
[Vector source](../submissions/contracts-workflow/vector-first/source) preserve
the original application bytes, including protected task/dependency files and
authored hidden files. The [publication and verifier](../submissions/contracts-workflow/README.md)
account for all 19 Codex and 15 Vector archive files. No generated runtime files
were present to exclude. The verifier also supports a Git-index byte check after
the repository owner stages the publication.

## Usage and shared-client audit

| Runtime | Input tokens | Cached input | Cache writes | Output tokens | Reasoning tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Codex | 1,733,035 | 1,641,525 | 91,420 | 49,909 | 11,998 |
| Vector | 2,203,714 | 2,123,084 | 80,489 | 33,745 | 9,923 |

Cache reads and writes are subsets of input; reasoning is a subset of output.
They must not be added again to those totals. The JSON retains uncached non-write
input, total tokens, and the funded rates that exactly reconcile both episode
costs. Vector supplies cache-write TTL detail for all 47 receipts. Codex's 30
receipts omit that detail, so generic writes use the funded meter's 30-minute
default. These are recorded study rates, not a public pricing claim. Unweighted
token counts do not measure cost.

The new profile required the shared browser client and did not advertise direct
library environment variables. Both bounded posthoc audits reported
`no_clear_bypass_observed`, with no unresolved browser/telemetry observations.
That finding does not prove adherence or an operating-system hard fence. The
auditor did not inspect transitive imports; script bytes, when inspected, are
posthoc snapshots, and execution success is not inferred. Audit execution/command
counts in the JSON measure audit coverage, not complete comparable tool payloads
or model tokens. Missing observations must not be treated as measured zeros.

## Blinded review and material risks

The mapping is Juniper = Codex and Elm = Vector. Both reviews used exact source
and two supplied independent screenshots under the [48-point rubric](../quality-rubric.md),
without independently executing either app or its authored tests.

| Dimension | Maximum | Codex | Vector |
| --- | ---: | ---: | ---: |
| Contract and data integrity | 12 | 12 | 12 |
| Durable state and recovery | 10 | 9 | 9 |
| Structure and maintainability | 8 | 8 | 8 |
| Errors and resource bounds | 6 | 5 | 5 |
| Added verification | 6 | 6 | 6 |
| User interface and accessibility | 6 | 5 | 5 |
| Total | 48 | 45 | 45 |

Neither review established a critical finding. Both implementations change the
default data directory: upgrading without explicit `DATA_DIR` can open a new
database and leave retained v1 history undiscovered, without deleting it. Both
also have a child-start persistence window without a kill/reap guard and lack
deliberate handling of asynchronous completion failures. Those conditional
storage/stream failure risks were not injected or observed.

Vector's native required-field validation can prevent submit before the requested
inline `role=alert` receives feedback for empty name/definition fields; resolved
cancellation promises also remain in its in-memory map. Codex's small,
low-contrast history/metadata text limits readability, and its output pipes are
fully buffered. These task-specific findings remain material despite equal
scores. The supplied screenshots and synthetic passing checks do not establish
production reliability, security, accessibility, or exact quality equivalence
across unobserved states. One adaptive task pair cannot establish a universal or
causal product improvement.

## Historical accounting checkpoint

At pair settlement, the 77 new provider requests cost $1.6432354. The study moved
from 674 requests / $16.1553280 to **751 requests / $17.7985634**, without resetting
spending. This checkpoint precedes subsequent active-task work and is **not the
current bill**; later activity is excluded.
