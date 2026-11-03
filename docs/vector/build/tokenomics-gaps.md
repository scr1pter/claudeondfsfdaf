# Vector tokenomics live evaluation

Updated November 2, 2026 (Pacific). The broader study continues; the cost objective is **not met**. In the latest completed [three-task single-agent stage](../../benchmarks/agentic-workflows-v1/results/contracts-stage-summary.md), both runtimes passed all 76 required checks. Vector had no lower fixed static score on any task (139/144 versus 138/144 in total) and cost **$2.0209317 versus $2.1275694: 5.0122% less**. It was more expensive on two tasks. These bounded observations do not establish general quality equivalence or the 20% savings target.

The owner requested a [heavier seven-agent nested-workflow study](../../benchmarks/agentic-heavy-v1/STAGE.md), including every specialist and judge cost. The owner approved splitting the remaining $27.6961709 equally: $13.84808545 additional allowance each, with the total still $48. Cumulative runtime caps become Vector $24.73654725 and Codex $20.31968465; all other actors are sealed. This replaces the earlier $20 ceilings for this explicitly approved phase. The [interim heavy result](../../benchmarks/agentic-heavy-v1/interim-result.json) retains Vector's 300-request / $6.7876388 limit stop. Correcting an evaluator navigation assumption gives 74/76 on its unchanged source, with bodyless order cancellation and mobile document overflow still failing. The original 64/76, both identical source snapshots and every charge remain preserved. Codex stopped after nine requests / $0.1423925 because the witness treated a downstream disconnect during inter-agent messaging as fatal, although all upstream usage settled. No Codex evaluator ran; this is an instrument investigation, not a Codex product failure or a completed comparison.

The [cost-category and trace audit](../../benchmarks/agentic-workflows-v1/results/contracts-cost-drivers.md) identifies extra replay and tool-orchestration turns as remaining leverage. Cache reuse is already strong. Codex's programmatic composition capability remains enabled in the control; a comparable permission-preserving Vector feature is a hypothesis, not a shipped or measured saving.

[Interrupted-usage corrections](tokenomics-cancellation.md) and [provider-bill/tier-admission corrections](tokenomics-price-admission.md) are published on the integrated branch. Later accounting changes were outside the frozen paid candidate, so the completed cost result is not attributed to them. The stopped-launch notification fix is integrated after 254 focused integration tests and both package typechecks passed. Its broader TaskTool run retains readiness failures: baseline and patched code reproduced the same five failures, followed by a clean six-case pass with unchanged bytes. The cause of that startup variance remains unexplained; the report preserves the original 109/6 broad result.

The settled interim checkpoint is **1,198 provider requests / $27.2338604**, including all historical charges, with no active or reserved requests at that observation. It is not an invoice or a permanent current-bill statement. A 10,000-record component test represents one billion logical input tokens; it is accounting evidence, not real billion-token inference. The source of the [funding controls](../../../scripts/benchmarks/funding-runtime/README.md), exact synthetic deliveries and calibration reference is on GitHub; credentials, raw prompts and runtime histories remain private. The earlier Foundry findings and shutdown checkpoint below describe their own completed stage, rather than the active continuation.

The data supports a combined terminal-start/readiness operation and several accounting and context-display corrections. It does not support making raw-text patch format the default. Product fixes are published on GitHub branch [tokenomics-efficiency](https://github.com/scr1pter/claudeondfsfdaf/tree/tokenomics-efficiency), source head `bd537fd2ccd35984bf705264daa1331bb4f39feb`. The [tokenomics-complete](https://github.com/scr1pter/claudeondfsfdaf/tree/tokenomics-complete) branch combines code, tests, reports and portable benchmark evidence. These branches have not been merged into `main` or released.

The [sanitized results](../../benchmarks/tokenomics-2026-11-01/live-results.json) contain costs, revisions, evaluation hashes and limitations. The [earlier offline audit](tokenomics-gaps-offline-2026-10-30.md) remains a historical snapshot; its pending work and approval requests describe that earlier stage.

## Matched large application task

Foundry is a business operations SaaS task covering accounts, workspaces, permissions, customers, inventory movements, atomic order fulfillment, invoice snapshots, projects, attachments, imports, activity and analytics. Each submission starts with the same five-file scaffold and public specification.

Both runtimes use one autonomous coding agent, exact model `gpt-6.1-sol`, High reasoning, automatic reasoning summaries, low text verbosity, a 1,050,000-token context limit and a common 32,000-token output ceiling. Vector uses Standard with its coding judge off. Codex uses CLI 0.166.0-alpha.5.1 with multi-agent execution disabled. The original Vector source is `70613cc47a175f29a96d17b8883df55c774d1373`; the readiness trial uses `0586df500618520e7f4be3df74f391dbbed3f965`.

| First completed submission | Original Vector | Vector with readiness | Codex CLI control |
| -------------------------- | --------------: | --------------------: | ----------------: |
| Usage-derived API cost     |      $1.5378689 |            $1.5751466 |        $1.5790564 |
| Provider requests          |              68 |                    55 |                46 |
| Agent runtime              |   17.25 minutes |         17.34 minutes |     18.60 minutes |
| Independent API groups     |           32/32 |                 32/32 |             32/32 |
| Independent browser checks |           40/40 |                 40/40 |             40/40 |

The latest Vector cost is 0.25% below Codex: an effective tie. It uses 19.1% fewer requests and 16.7% less input than the original Vector sample, but generates 14.7% more output. Its total cost is consequently slightly higher than the original Vector sample. Generated implementations differ, so these total differences cannot be attributed solely to the terminal feature.

Ordinary task delegation is disabled through configuration and a common definition filter. An invocation audit found zero research or escalation worker calls in the historical runs. The readiness followup also explicitly removes those two previously offered but unused definitions. That additional harness change is a disclosed confound, rather than treating readiness as the only changed variable.

The same second blinded reviewer scores the readiness submission and Codex control as follows:

| Source and screenshot rubric | Vector with readiness | Codex control |
| ---------------------------- | --------------------: | ------------: |
| Static code quality          |                 39/48 |         39/48 |
| Supplied screenshots         |                 25/40 |         24/40 |

The reviewer inspected source and nine screenshots per application, without runtime identity or costs. This was not an interactive usability audit or production-readiness review. It does not establish global quality parity. A separate earlier reviewer scored the original Vector and Codex code 37/48 and 39/48, with both at 25/40 visually; scores from the two reviewers are not pooled.

The readiness app still has review risks: a 10,000-row display helper reused for some integrity and aggregate operations; filesystem cleanup that can swallow unlink failures; a live-status badge that does not clearly represent failed polling; and a closed mobile sidebar that can remain keyboard-focusable. Passing the specified gate does not imply those untested properties are solved.

## What the data says about cost

The original Vector submission used 5,596,173 input tokens, including 5,485,584 cache reads, and 71,294 output tokens. The readiness submission used 4,663,075 input tokens, including 4,541,616 cache reads, and 81,742 output tokens. Codex used 3,843,534 input tokens, including 3,715,379 cache reads, and 88,720 output tokens. Reasoning tokens are a subset of output, not a second charge.

Under the study schedule, output costs $10 per million tokens and cache reads cost $0.10 per million. Therefore fewer total tokens can still cost more when the remaining mix contains more output or cache writes. Request count alone is also insufficient: the readiness trial reduced replay and requests, while increased output offset those savings.

The CLI accounting audit reconciled 166 observed primary turns from the original Vector and native-patch cases against independently calculated provider-usage costs, with every observed step matching. This did not reveal a CLI overbilling defect. Existing frontend monetary totals already include ordinary input, cache reads, cache writes, output, and applicable delegated/helper costs. The display fixes below clarify context and scope; they do not reduce provider charges.

Costs throughout are recorded provider usage multiplied by the study's verified rate schedule, not reconciled invoices or a comparison with subscription-included usage. High cache reuse does not justify removing session isolation, privacy invalidation or meaningful verification.

## Changes implemented and validated

The new work adds three local commits:

- `0586df5` — terminal `open` can optionally wait for a readiness pattern in the same call. Existing no-pattern behavior remains available. Permission, ownership, abort, timeout and process-exit handling remain enforced. The latest first submission used three combined opens and zero separate readiness waits; the original sample used five separate wait-only assistant messages. Nine actual-tool tests with synthetic PTY I/O pass, plus engine typecheck. The 26 existing real-PTY cases were skipped on Windows, not passed.
- `1d0246d` — TUI context gauges select the latest measured assistant turn even when it has zero visible output, rather than falling back to an older output-producing turn. Context captions distinguish latest-turn context, cumulative own-chat categories, and totals including other agents/helpers. Finite reported totals and existing token semantics are preserved; hidden reasoning is not added twice. Monetary totals are unchanged.
- `c1eda0e` — the Windows checkout's shared element-declaration link is replaced with a regular declaration reference. Normal app typecheck and production build pass without a temporary file-content workaround or a global Git configuration change.

For the final UI tree, TUI selector tests pass 6/6, rendered sidebar tests 3/3, app context metrics 6/6, and app session-cost tests 7/7: 22 focused checks, no failures or skips. TUI and app typechecks pass; the production app build passes with its normal import/chunk-size warnings. Together with the nine terminal checks, this iteration has 31 focused passing checks. Those source checks are separate from the benchmark application's 32 API groups and 40 browser checks.

Earlier locally committed fixes remain in the implementation branch: title output caps that survive provider hooks; consistent Standard-mode guidance; ancillary and helper cost ownership; cancellation of obsolete autocomplete requests; explicit provider-reported OpenRouter charges including zero; durable memory revocation and document visibility withdrawal; and the supported official API-key cache policy with per-session keys and explicit opt-out.

The earlier memory/privacy package passed 78 checks plus core and engine typechecks; the cache package passed 110 checks plus engine typecheck. These package counts overlap other validations and are not summed into a new independent benchmark count. OpenRouter accounting and autocomplete were tested locally, not established by this paid CLI comparison.

## Raw-text patch trial

The opt-in native patch trial cost $1.6664941 across 73 requests before repair, taking 19.13 minutes. Its unchanged first submission passes 31/32 API groups and 40/40 browser checks. A partial draft-order update remains a genuine API failure. After one same-session repair, it passes all 32 API groups and 40 browser checks; the entire episode costs $2.2288281 across 98 requests and takes 23.40 minutes of agent time.

Actual wire requests verified the custom text format and `store: false`. However, the first submission produced 77,681 output tokens and 6,104,096 input tokens, exceeding the original Vector sample in both categories. A smaller local serialization does not establish an application-level saving. The same second reviewer scores this trial's first code 38/48 and its eight supplied screenshots 24/40, against the reference's 39/48 and 24/40. Screenshot coverage differs. Native patch format remains opt-in; one stochastic trial does not prove the format is inherently worse.

## Evaluator corrections and retained failures

The final common evaluator is manifest SHA-256 `fcc3611fc1a5ca397405e00073936c51a60c5d2327ac93373563dc11d89966bd`. All five unchanged selected submissions were rebuilt and evaluated with this identical instrument: original Vector, original Codex, native first, native repaired, and readiness first. All pass 40 browser checks; all pass 32 API groups except the native first submission's genuine API failure. These re-evaluations made zero model calls. Authored-source hashes were unchanged before and after evaluation.

Earlier instruments mishandled numeric navigation badges, asynchronous workspace selection, hidden actor labels, delayed invoice dialogs and wrapping-label select controls. The final correction addresses dialogs that temporarily ignore Escape while a foreground refresh is busy, and locators that can retarget an underlying dialog. It uses bounded normal Escape/navigation retries and binds the actual dialog node, without force-clicking, programmatic closing or repeating business mutations. The strict idle-dialog Escape/focus check remains unchanged. Revised controls pass 30/30 pure checks and 11/11 synthetic Chromium cases, including negative controls that must still reject invalid behavior.

Every original freeze, failed result and repair charge remains retained. No benchmark application was manually fixed. The native trial's feedback mixed a genuine API defect with false UI failures, so its entire repair cost cannot be assigned exclusively to either cause. A free native final evaluation interrupted for 15 hours remains recorded as interrupted; later unchanged-source checks are separate results.

The readiness first submission completed normally with exit code 0. Its paid repair sequence was subsequently stopped by the controller while investigating evaluator modal races; the raw coordinator status remains `agent_fatal_or_timeout`. The corrected free evaluation proves the unchanged first submission passes. It does not relabel the interrupted repair as a clean paid completion. Its full $2.5160773 episode, including $0.9409307 of harness-induced repair charges, remains counted.

## Final spending and scope

| Retained study portion              | Provider receipts | Usage-derived cost |
| ----------------------------------- | ----------------: | -----------------: |
| Earlier diagnostics and small tasks |               135 |         $2.9437681 |
| Original Vector episode             |                77 |         $1.7343447 |
| Original Codex episode              |                53 |         $1.8089226 |
| Native patch episode                |                98 |         $2.2288281 |
| Readiness episode                   |                86 |         $2.5160773 |
| **Total**                           |           **449** |    **$11.2319408** |

The authorized study cap is $48. No historical charges, failed attempts or repairs were reset. Final status has zero active requests, zero reservations and zero open batch calls. The owned policy proxy and funded meter were shut down after their process identities and listeners were verified; the process holding the provider credential is stopped. The study did not persist that credential in source, configuration or reports. User applications were left running.

On November 1 the owner stopped cloud work and requested coding-only tests. No paid cloud-agent task ran. Previously created synthetic repositories and a disposable seed deployment remain unchanged; they are not benchmark passes. There are no pending deployment or authentication actions in this study.

The earlier Relay comparison used Vector Thorough with two child agents versus Codex without children, so it is not a matched single-agent result. Small probes and an optional cache-key-off experiment likewise do not establish a large-task default-policy saving. The supported conclusion is competitive cost and measured quality on this one substantial application task, with demonstrated workflow improvements and specific remaining quality limits.

## Followup: accounting regression fixed

A subsequent coding-only recheck found another defensive accounting defect: `getUsage` returned a provider's malformed total-token counter unchanged, while durable message/step schemas require finite numbers. A valid input/output subtotal and charge could therefore coexist with a receipt that failed encoding. This case was not observed in the 449 paid receipts and is not a measured cost-saving claim.

Commit `bd537fd` omits invalid totals while preserving known input/output counters, the calculated charge, and `unpriced: true`. It keeps valid and missing totals unchanged rather than inventing a replacement. Six new cases exercise the actual accounting function and durable step encoder. Before the fix, the suite had 25 passing and four failing tests; after the fix, all 29 pass.

The recheck's latest results across 12 focused suites are 104 passing tests and zero failures, with 26 existing real-PTY cases skipped on Windows. Cache eligibility, cache breakpoints, title caps, usage, CLI budget stops, stats, readiness, TUI context and app cost/context checks are covered. Engine typecheck and formatting checks pass. One initial cache-suite hook timeout remains recorded; all six assertions passed then, and the unchanged test's retry completed with no hook failure. These totals replace overlapping rerun counts rather than adding them.

This followup used no provider calls, no further cloud actions and no additional API spend. It did not rerun the large paid application benchmark or change its results. The source changes are published on the GitHub branches linked above and remain unreleased.

## GitHub publication

The [portable evidence bundle](../../benchmarks/tokenomics-2026-11-01/README.md) contains the exact selected synthetic app sources, free evaluator and empty scaffold, per-check outcomes, snapshot hashes, and an allowlisted projection of all 449 usage receipts. Completed code and evidence belong on GitHub so work can continue from another computer. Private credentials and raw runtime data are excluded. GitHub publication does not merge or release these changes.


## Follow-up study checkpoint: fixed candidate on two maintenance tasks

The [fixed candidate stage summary](../../benchmarks/agentic-workflows-v1/results/focus-stage-summary.json)
retains two completed matched pairs on gpt-6.1-sol, High, one agent. Both runtimes
pass all 50 required API/browser checks. Vector costs 1.4387027 USD versus
1.6017100 USD (10.18% less); blinded source/screenshot scores are
90/96 versus 93/96. The broader 20% equal-quality objective remains unmet.
This is a small adaptive study, with explicit checker corrections and conflicting
browser-provisioning instructions; every original result and charge is retained.

At the historical settlement checkpoint, the complete study totals 674 receipts
and 16.1553280 usage-derived USD. This is not invoice reconciliation or a current
future bill. The [next-stage plan](../../benchmarks/agentic-workflows-v1/followup-stage.md)
freezes candidate a35c03d with validated patch-envelope recovery and compatibility
guidance. Its future cost and quality effects remain unproven.
