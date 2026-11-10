# Agentic workflow optimization study

This followup studies existing-application maintenance rather than another empty-app build. It continues the [tokenomics study](../tokenomics-2026-11-01/README.md) without resetting any spending. The previous 449 provider receipts total $11.2319408. The broader cost/quality goal remains unproven by that earlier single-task result.

## Preregistered objective and sequence

The target is at least 20% lower aggregate usage-derived cost to an accepted delivery, with all required functional checks passing, no lower aggregate blinded code-quality score, and no new critical reliability/security finding. This target is a decision rule for the measured tasks, not a promise of universal superiority.

1. Use Workflow Runner as the development task: upgrade a neutral, working v1 application with durable DAG workflows, subprocess lifecycle management and a truthful live UI.
2. Run one baseline pair. Inspect actual provider usage and tool activity before selecting an optimization. Retain both first submissions and all repair charges.
3. Implement a narrowly supported product change, validate it locally, commit it, and freeze a separate candidate revision. Repeat the same development task only when the change and earlier data justify the expense.
4. Keep a second Evidence Workbench task as a holdout. Its detailed seed and evaluator must be frozen after the candidate product change, before either paid arm sees it. It exercises versioned document ingestion, indexing and exact citations. Do not select or discard a task according to which runtime won.
5. Report every attempted arm, including failures, budget stops and negative optimization results. If the target is unmet, say so and use the remaining authorized budget only for justified work.

Before spending on an arm, the public task, seed, protected files, independent evaluator and runner must be committed and hash-pinned. Prototype instrument revisions are drafts until their controls pass. Ambiguous evaluator behavior is investigated without paid repair calls. A corrected instrument is applied to all affected unchanged submissions; original failures and every charge remain retained.

## Matched execution

Both runtimes use `gpt-6.1-sol`, High reasoning, automatic reasoning summaries, low text verbosity, one autonomous coding agent, a 1,050,000-token context ceiling and a 32,000-token output ceiling. Vector uses Standard with its judge off. All four worker/delegation tools are denied and removed by the shared policy witness. Codex multi-agent execution is disabled and its maximum thread count is one.

Each pair receives identical public task bytes, seed bytes, package pins and functional requirements. Both can use the same local browser driver and its observation/action protocol. The driver uses a fresh isolated headless profile, explicit loopback origins and synthetic application data. There are no cloud deployments, real-account browser sessions or external research operations in these tasks.

Allow at most 300 provider calls and two hours of agent wall time per arm, including one same-session repair for a frozen product failure. Preserve the original fixed Vector session allowance during repair; do not subtract already-accounted session spend twice. A failed prerequisite or unknown settlement is never a product success.

## Spending controls

The hard study cap remains $48. The existing cumulative $20 `foundry-vector` and $20 `foundry-codex` allocations remain enforced by the previously reviewed funded meter. At resumption they have $13.5207499 and $18.1910774 remaining respectively. All other historical actors and charges remain unchanged.

The default per-arm $3 limit is a **stopping threshold**, not a hard per-request reservation cap. A provider response already admitted can cross that smaller threshold; its full charge remains counted. The funded meter separately enforces the hard global and actor limits before admitting a request. No running allocation is expanded or reset. New task labels affect reporting, not spending history.

Two tasks, two runtimes, and a before/after stage would target $24 of new spend if each arm reached that threshold. Do not spend an allocation merely to fill it. Repairs are included in each arm's total. Earlier private transcripts, credentials, controller tokens and machine configuration are excluded from GitHub; source, tests, specifications and sanitized evidence are published on `tokenomics-complete`.

## Evaluation and reporting

Primary cost is the complete accepted-delivery episode, including repairs. Record the first submission separately. A cheaper failing application does not establish equal-quality savings. Report requests, input/output/cache categories, wall time, tool categories, functional outcomes and blinded source/screenshot review separately. Reasoning tokens are a subset of output and are not charged twice.

The functional gate must distinguish `passed`, `product_failure` and `instrument_failure`. Failed or skipped checks remain failed or not run. Source integrity covers protected task inputs and authored application files; model-produced tests cannot replace the independent evaluator. Static review is bounded evidence, not a production-readiness guarantee. Repeated adaptive runs on one task are not independent proof of generalization.

The reusable runner and browser driver live in `scripts/benchmarks/agentic-study` and `scripts/benchmarks/browser-driver`. Neither should make a paid call by default. Runtime paths and the private study directory are explicit command-line inputs; no provider key belongs in source or GitHub.

## Development-task baseline and instrument correction

The first Workflow Runner pair and Vector's repair have completed. A postlaunch
investigation found that the original single-Tab mobile check could mistake an
ordinary transition from the last page control into browser chrome for missing
keyboard access. The [explicit keyboard-v2 revision](workflow-runner/instrument-revisions/postlaunch-keyboard-v2/README.md)
preserves the original instrument bytes, original task digest, provenance, and
positive/negative controls.

Under the same corrected instrument, free reevaluation of Codex's first
submission, Vector's first submission, and Vector's repair passed all sixteen
API groups and eight browser groups. All three authored source inventories
remained unchanged. Original charged results and all repair spending are
retained. This establishes corrected functional acceptance on this development
task; it does not establish the aggregate 20% accepted-delivery savings target
or equal blinded code quality. Paid cost/quality reporting and subsequent
candidate/holdout results are reported separately.

The [follow-up candidate plan](followup-stage.md) preregisters the next fixed
candidate, repeat tasks, new holdout, browser-provisioning correction and unchanged
spending limits. It makes no claim that the broader objective has been achieved.


## Completed contracts stage

The [three-task quality-first summary](results/contracts-stage-summary.md) records
all 76 checks per runtime, fixed per-task Vector scores 45/47/47 versus 45/47/46,
and 5.0122% lower aggregate Vector cost. The20% cost target remains unmet; no
universal quality or cost claim is established. Exact submissions, separate
posthoc support code and the [constructed outbox calibration reference](references/outbox-gold/README.md)
are published with byte verifiers. The reference was released after both outbox
paid arms settled, outside the frozen task tree.

The owner subsequently authorized a separately labeled matched multiagent study
within the existing cumulative caps. Free native registry, metering and closure
controls are being validated; no paid multiagent result is included here.
