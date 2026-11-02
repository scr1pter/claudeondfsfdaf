# Follow-up candidate study: contracts, patch recovery and browser provisioning

This plan is recorded before any paid calls on product candidate
`a35c03d6a9bb16f16ec0187ad69c6c6420d10f19` and before the study owner inspects the
new Delivery Outbox task in detail. The candidate is committed, pushed and clean.
Its parser/tool checks passed 63 tests, system/request checks passed 52 tests,
and core/engine typechecks passed. These checks establish bounded correctness;
quality and cost gains remain hypotheses.

## Why another candidate is justified

The first candidate development pair passed all 24 checks for both runtimes.
Vector cost 17.03% less, but scored 45/48 versus Codex's 46/48. Review identified
compatibility, related-state recovery and cleanup risks. The new generic guidance
prioritizes inherited public behavior, storage defaults, persisted state and
resource ownership through failure/recovery. It contains no benchmark-specific
solution or fixture hints.

One paid trace also contained a complete 24 KB patch rejected solely for a
missing opening marker. The new tool recovers that envelope only after strict
body validation, retaining path/permission/context checks and never inventing
an ending marker. The subsequent model retry changed three functional lines as
well; this observation cannot establish equivalent retry semantics or an exact
cost saving.

Both old CLI environments exposed raw browser-library paths. The runner
preamble explicitly advertised those libraries while requesting the common
client elsewhere: these were conflicting instrument instructions. Baseline Codex and
first-candidate Vector executed authored Playwright scripts instead of staying
entirely in the common client. Those descriptive results, all charges and the
provisioning limitation remain published. The next matched stage will advertise
only the shared browser client to both runtimes, remove raw browser-library and
executable variables from their environments, and record bounded posthoc protocol
observations. Full shell access is not an operating-system security sandbox;
absence of an observed bypass is not proof of impossible bypass.

## Fixed evaluation set and decision rule

Use fresh matched pairs on all three tasks: Workflow Runner and Evidence
Workbench as development replications, then independently authored Delivery
Outbox as the new holdout. Do not discard an earlier task, failed attempt or
negative result according to which runtime won. Delivery Outbox remains a draft
until its seed, independent evaluator, positive/negative controls and runtime
qualification pass review and a final source freeze is committed. Its draft has
41 passing pure controls; no runtime success is inferred from those controls.

The target remains at least 20% lower aggregate complete-delivery API cost, all
required functional checks passing, no lower aggregate blinded score, and no new
critical reliability/security finding. Apply the same 48-point rubric and same
reviewer to both arms of each task; retain material findings and coverage limits.
These are two previously seen tasks and one new holdout, not three independent
holdouts or evidence of universal/statistically significant superiority.

Retain original and corrected instrument results. Investigate ambiguous gates
without another model call, apply corrections to every affected unchanged
submission, and count every historical charge. Manual missing-arm continuation
must preserve source, public task, seed, execution pins, settlement and ledger
lineage; it must never rerun the charged arm.

## Execution and spending

Keep gpt-6.1-sol, High reasoning, one autonomous coding agent per runtime,
Standard/judge-off for Vector, identical browser access, context/output ceilings,
worker denials and fixed dependencies. Freeze source, task, runner, browser driver
and binaries before each paid arm. Reverse the previous development-pair order
on each repeated task. Determine the new holdout order from its frozen task hash,
not observed performance.

The existing $48 global cap and cumulative $20 per-runtime actor caps remain
unchanged. Each arm keeps the $3 soft stopping threshold, 300-call/two-hour ceiling
and at most one same-session product repair. Six new arms target at most $18 at
that stopping threshold; an admitted response can cross the soft threshold, while
the funded meter independently enforces hard reservation limits. Do not spend an
allocation just to fill it. Earlier charges, interrupted cases and the active
first-candidate holdout continuation remain counted in the same study.

Run one Bun workload at a time. Use synthetic local applications and fresh owned
headless browser profiles; no cloud deployments, real-account browser actions or
company data. Publish completed code, exact synthetic application sources, tests
and sanitized outcomes on GitHub. Never publish provider/controller credentials,
raw private logs or machine configuration. Report each candidate stage separately
and the complete financial history together. If the target is unmet, say so and
continue only when observations support another useful change.

## User quality-priority update

During the running document-workbench pair, before its deliveries were evaluated,
the user explicitly made equal-or-better quality priority one. The stricter
acceptance rule is now no lower blinded score on **any task**, all required
functional checks passing, and no established critical regression. Aggregate
scores remain diagnostic; a stronger result on one task cannot offset a weaker
result elsewhere. The already completed new-candidate Workflow Runner pair scored
45/48 for both runtimes and passed24/24, but its15.78% cost saving alone does not
establish the broader objective.

Retain the20% aggregate complete-episode cost target only after those per-task
quality gates pass. Do not reduce model effort, required verification or workflow
completeness just to lower the bill. Experimental code remains isolated from
release until its applicable tests and quality gates pass. These bounded checks
cannot guarantee absence of every production defect.

The single-agent comparisons do not establish full specialist/judge economics or
quality at billion-token scale. A separate free accounting stress study may use
billions of logical tokens in bounded synthetic usage records; it must not be
reported as real inference or full-workflow quality validation. Any additional
paid multiagent mode must be labeled separately and reconciled with the user's
earlier one-agent fairness restriction before enabling it.
