# Completed-task cost audit

The two completed task pairs show **no demonstrated major product-engine waste**.
Vector cost $1.4789485 versus Codex's $1.6149077: **8.4190% lower**, below 20%.
Recorded static quality ties are 45/45 for [Workflow Runner](contracts-workflow.md)
and 47/47 for [Evidence Workbench](contracts-evidence.md); the latter has different
dimension scores and material findings. These bounded ties are not a quality
guarantee. Quality is primary: one stronger task cannot offset a weaker task.
The third task and overall candidate decision remain pending.

Every component below comes from actual usage receipts and recorded funded-meter
rates, not invoices. [contracts-cost-audit.json](contracts-cost-audit.json) retains
the token partitions and exact reconciliation. Reasoning partitions output;
cache reads/writes partition input. Neither is charged twice.

| Episode | Visible output USD | Reasoning USD | Cache writes USD | Cache reads USD | Fresh input USD | Total USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Workflow Codex | 0.3791100 | 0.1199800 | 0.2285500 | 0.1641525 | 0.0001800 | 0.8919725 |
| Workflow Vector | 0.2382200 | 0.0992300 | 0.2012225 | 0.2123084 | 0.0002820 | 0.7512629 |
| Evidence Codex | 0.2761700 | 0.0743000 | 0.2043025 | 0.1679527 | 0.0002100 | 0.7229352 |
| Evidence Vector | 0.2491000 | 0.1003000 | 0.1903125 | 0.1877091 | 0.0002640 | 0.7276856 |

The read-only activity audit found:

- All 10 Vector patch calls succeeded. One select-schema mismatch per Vector run
  used `value` where the shared client documents a `values` array. This concerns
  the common client/shared adapter; it does not establish a native product Browser
  defect. The two whole recovery model steps cost $0.0208206, already included
  above. They also contain useful checks, so that amount is exposure, not isolated
  avoidable cost or demonstrated savings.
- Scripts already batch common-client calls. The runs contain 29 and 13 observed
  full snapshots, totaling 108,509 and 47,893 characters; repeated `snapshot.text`
  accounts for 25,670 and 5,564 characters. References and state differ, so whole
  snapshots cannot simply be deduplicated. Codex repeats observations too. These
  character counts are not token or dollar estimates.
- The wrong shutdown-probe exception and expected 400/409 validation console
  messages are authored diagnostics, not demonstrated engine defects.

The model, High reasoning and one-agent settings stayed fixed; Vector's product
revision and the separately pinned Codex CLI are distinct. No blanket verification
reduction or model downgrade is justified. Schema alignment or narrower stable
text presentation are hypotheses to measure while preserving coverage and
quality on every task. This small single-agent study does not test multi-specialist
or judge operation, quality at billions of tokens, or broad deployment behavior.
Accounting stress remains pending.
