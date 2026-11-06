# Contracts candidate: Evidence Workbench, Task 2

Both first submissions passed all **26 required independent checks** without
repair and tied at **47/48** in blinded static review, with different dimension
scores and material findings. Vector's complete episode cost $0.7276856 versus
Codex's $0.7229352: **0.6571% more**. Vector used 1.58% more agent wall time.

Quality takes priority: no task may have lower quality, and improvement on
another task cannot offset a weaker task. Cost is secondary. There is no overall
candidate decision before the complete three-task evaluation, and this pair does
not establish the 20% cost target.

[contracts-evidence.json](contracts-evidence.json) contains factual usage,
acceptance, bounded browser-audit metadata, and the historical accounting
checkpoint. Dollar figures come from actual provider usage under the funded
meter, not invoice reconciliation. Every charge is retained.

| Complete episode = first submission | Provider requests | Usage-derived USD | Agent wall time (ms) | API / browser checks | Blinded score |
| --- | ---: | ---: | ---: | --- | ---: |
| Vector | 44 | 0.7276856 | 526,703 | 18/18 + 8/8 | 47/48 |
| Codex | 35 | 0.7229352 | 518,515 | 18/18 + 8/8 | 47/48 |

Vector ran candidate `a35c03d6a9bb16f16ec0187ad69c6c6420d10f19`; Codex ran its
separately pinned CLI. Both arms used task digest
`1c9887ee0aacb62830942559ac845dda8c3e5d9a5765f20a17e38b67a0e20094` and one
autonomous `gpt-6.1-sol` agent with High reasoning. Each settled its first attempt,
with source unchanged through independent evaluation, no protected-input
violations, and no worker/delegation calls. All selected receipts returned HTTP
200. Wall times measure normal completed episodes and exclude independent
evaluation time.

The exact [Vector source](../submissions/contracts-evidence/vector-first/source)
and [Codex source](../submissions/contracts-evidence/codex-first/source) are retained
under the [source publication and verifier](../submissions/contracts-evidence/README.md).
The publication includes 15 Vector and 20 Codex files. Eight generated Codex
verification artifacts are excluded with complete path/hash/byte accounting;
authored `.verification/REPORT.md`, `browser-check.cjs`, and `restart-check.cjs`
remain included even when ignored. No blanket hidden-directory filter is used.

## Usage and bounded audit

| Runtime | Input tokens | Cached input | Cache writes | Output tokens | Reasoning tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Vector | 1,953,348 | 1,877,091 | 76,125 | 34,940 | 10,030 |
| Codex | 1,761,353 | 1,679,527 | 81,721 | 35,047 | 7,430 |

Cache reads and writes are subsets of input; reasoning is a subset of output.
They must not be added again. Numeric categories and recorded funded rates
reconcile both costs exactly. Vector provides TTL detail for all 44 receipts;
Codex's 35 omit it and use the funded meter's 30-minute cache-write default.
The JSON also retains uncached non-write input and total tokens. These are study
rates, not a public pricing claim; raw token totals do not measure cost.

Both shared-client profile audits recorded `no_clear_bypass_observed`. This
bounded observation is not proof of adherence or an operating-system hard fence.
Transitive imports were not inspected, posthoc script bytes do not establish
executed bytes, and success is not inferred from an execution reference. Audit
counts measure coverage rather than complete comparable tool-payload or model
token activity. An empty runtime tool inventory does not establish zero tool use.

## Blinded review and material limits

The fixed mapping is Cedar = Vector and Aspen = Codex. Both reviews used exact
source and two supplied independent end-state screenshots under the
[48-point rubric](../quality-rubric.md), without independently executing the
applications or authored tests.

| Dimension | Maximum | Vector | Codex |
| --- | ---: | ---: | ---: |
| Contract and data integrity | 12 | 12 | 12 |
| Durable state and recovery | 10 | 10 | 10 |
| Structure and maintainability | 8 | 8 | 8 |
| Errors and resource bounds | 6 | 6 | 5 |
| Added verification | 6 | 5 | 6 |
| User interface and accessibility | 6 | 6 | 6 |
| Total | 48 | 47 | 47 |

Neither review established a critical finding. Vector's added HTTP tests invoke
the handler directly and represent restart by reopening the store. They do not
launch/restart the direct server, check built static serving, or exercise browser
workflows. That is missing authored coverage, not an established behavior failure.
Codex's source/title validation materializes arrays over oversized fields before
rejecting the 200-scalar limit, creating conditional memory/work amplification
under its 1 GiB raw request allowance. No exhaustion or latency failure was
measured. Both whole-request buffering and large-input load remain limitations.

The screenshots show search/pagination, leaving importer feedback, stale restart,
history, citation detail and cited-version opening source-assessed. Authored pass
reports and scripts do not provide independent execution evidence. The review
also notes that a whole matching token over 512 bytes cannot satisfy both the
whole-token rule and 512-byte excerpt cap; no separate exact-byte citation defect
was established from that contradictory edge. Tied bounded static scores do not
guarantee exact quality equivalence, production readiness, or a universal or
causal product improvement. The overall candidate decision remains pending the
third task and the per-task quality assessment.

## Historical accounting checkpoint

At pair settlement, 79 new provider requests added $1.4506208. The study moved
from 751 requests / $17.7985634 to **830 requests / $19.2491842**, without resetting
spending. This is a historical checkpoint, **not the current bill**; later task
activity is excluded.
