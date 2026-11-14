# Contracts candidate: three-task measured stage

The **20% cost target is unmet**. Vector cost **$2.0209317** versus Codex's
**$2.1275694**, a **5.0122%** aggregate reduction. Vector was cheaper on one task
and more expensive on two, including **5.7195% more** on Delivery Outbox.

The bounded measured quality gate passes: both runtimes passed all **76 required
checks**, Vector's fixed static score was no lower on any task, and no critical
finding was established. This satisfies the user's quality priority **within the
measured scope only**. It is not a production quality or release guarantee.
A stronger task cannot offset a weaker task; cost remains secondary.

| Task | Role | Checks each | Static score V / C | Vector USD | Codex USD |
| --- | --- | ---: | ---: | ---: | ---: |
| [Workflow Runner](contracts-workflow.md) | Development replication | 24 | 45 / 45 | 0.7512629 | 0.8919725 |
| [Evidence Workbench](contracts-evidence.md) | Development replication | 26 | 47 / 47 | 0.7276856 | 0.7229352 |
| [Delivery Outbox](contracts-outbox.md) | Held-out task | 26 | 47 / 46 | 0.5419832 | 0.5126617 |
| Total | | 76 | 139 / 138 | 2.0209317 | 2.1275694 |

[contracts-stage-summary.json](contracts-stage-summary.json) contains the numeric
stage rollup. Dollar totals use actual funded-meter provider receipts, not
invoices. The 139/138 score sum is descriptive; the quality gate was checked
separately on every task. Different dimension scores and material findings remain
relevant, including conditional lifecycle/resource risks, verification limits,
legacy failed-row recovery and editor-state gaps. Passing synthetic checks and
static review do not establish unobserved behavior.

## Controls and preserved audit lineage

Vector used the single frozen product candidate
`a35c03d6a9bb16f16ec0187ad69c6c6420d10f19`; Codex used its separately pinned
CLI. Both used `gpt-6.1-sol`, High reasoning and one autonomous agent. Every charge
is retained, with no paid repair, rerun or refund in these three pairs.

Both outbox originals retain `coordinator_review_required` and automatic
`review_required`. Separate manual dispositions record
`bounded_manual_review_no_clear_bypass_observed` without rewriting those flags.
Only the missing Codex arm continued under the immutable pre-Vector plan and
unchanged pins. The bounded manual reviews are not a hard execution fence or
proof of complete browser-protocol adherence.

Outbox source archives remain 16 Vector / 17 Codex files. One / three external
current support scripts are separate posthoc supplements, with unauthenticated
historical execution bytes. Each runtime's two independent review images show
390px queued/delivered end states; neither has an independent desktop image.
Authored manual-audit desktop material is separate. Reviewers performed static
source/screenshot assessment, without independently executing the apps or tests.

This is a small adaptive study with two development replications and one held-out
task. No statistical significance, universal cheapness, broad quality guarantee,
multi-specialist/judge result, or quality at billions of tokens is established.
The preregistered overall objective fails because aggregate savings are below
20%, despite passing the bounded measured per-task quality gate.

## Historical spending checkpoint

The stage adds 215 requests and $4.1485011 to the prior 674 requests /
$16.1553280, reaching **889 requests / $20.3038291** at final-pair settlement.
Historical spend was not reset. This is a settlement checkpoint, **not the
current bill**; later activity is excluded.
