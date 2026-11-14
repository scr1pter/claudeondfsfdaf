# A23: spend guards and usage summaries

Continues A22 at `4fde1a49` on `codium`. Implements label plan C4/C5. This is an implementation checkpoint, not a release or provider acceptance claim.

## Behavior

- Codium is classified before free, plan, local or priced models. Its provider steps increment `codiumSteps`, and add no dollars or unknown steps to the run guard. Step and loop limits still apply. A mixed run retains its ordinary dollar limits.
- Codium counts survive run/scope snapshots, both spend events, the V2 spend response, budget-stop errors and desktop drain aggregation. V1 and V2 model execution use the same classification; research estimates and reports identify Codium without price or token figures.
- Known Codium desktop runs reserve no dollars and skip the local dollar windows. The gateway remains their financial cap. Unknown model identities keep the normal local check. The allowance returns no `budgetUsd`: zero is not a valid `RunBudget.Info.usd` and would incorrectly trigger desktop headroom refusals.
- A recurring automation reads its existing session's current model before deciding the exemption, rather than trusting its older schedule's model. New sessions use their pinned model. Parallel workspaces create a fresh session and use the model pinned to that creation.
- V1/V2 transcript and ancillary Codium usage is excluded from usage dollars, token totals, peaks, averages and model/effort preferences. Activity, completed chats, streaks and optional Codium counters remain. Local per-step tokens remain for context and compaction. The projector's stored-flag accounting from A22 is unchanged.
- Usage check-ins carry activity and ordinary usage only. Codium model identifiers and the internal Codium counters are absent.

## Review and limits

An independent static review found a stale-model exemption in the initial recurring-automation draft. It was corrected to read the current session model and covered with both direction regressions (saved Codium/current own key, and saved own key/current Codium). The review then found no blocking defect in its C4/C5 scope. No review test result is implied.

An owner can still change an existing session's model concurrently between the desktop read and prompt admission. This is the existing mutable-session behavior; A23 does not add an atomic model fence or change the prompt contract. The saved-model mismatch is fixed, but that concurrent owner-edit race is not claimed solved.

A24–A26 still own display labels, remaining CLI/desktop surfaces and review exports. A23 alone is not a completed Codium release.

## Integration with self-evolving

After merging A23 into `self-evolving`, also adapt its newer, separate delegated-scope type and decoder (`agent/subagent-kind.ts`, `tool/subagent-lifecycle.ts`, including `scopeFields`) to retain `codiumSteps` across restart. Its `task/limits.ts` durable SQL seed must subtract session Codium counts from unknown counts and retain Codium seed counts; otherwise restart reintroduces the unknown-step stop. These paths do not exist in this Codium branch and are a required integration gate, not optional cleanup.

## Validation

Focused tests ran one file at a time with the serial workload lock and a 30-second default timeout: **245 passing cases across ten files**, no failures in the final runs.

| File                                                                | Passed |
| ------------------------------------------------------------------- | -----: |
| core `spend-guard.test.ts`                                          |     56 |
| core `model-plans.test.ts`                                          |     36 |
| core `research/estimate.test.ts`                                    |     10 |
| desktop `run-usage.test.ts`                                         |     16 |
| desktop `spend-limits.test.ts`                                      |     36 |
| desktop `usage-checkin.test.ts`                                     |     24 |
| desktop `scheduled-agents.test.ts` (new model-boundary cases)       |      2 |
| engine `session/usage.test.ts`                                      |     16 |
| engine `session/processor-effect.test.ts` (Codium settlement cases) |      3 |
| root test package `usage-api.test.ts`                               |     46 |

The first processor regression run failed because the fixture did not expose the real SpendGuard service. Adding its node to the fixture's group fixed that test setup; all three settled/interrupted/failed provider cases then passed, including actual guard accounting assertions. The other processor and scheduled-agent cases run in scoped CI.

Core, Server, Engine and Desktop package typechecks passed. The mandatory pre-push check is pending. The added HTTP exerciser scenarios use the actual session and guard services with seeded Codium results, without provider requests; they run only in CI. GitHub CI has not yet run on this source.

No provider/Stripe/customer GitHub API call, account setting, deployment, sales activation, catalog acceptance or main merge is part of A23. Larger fixed reservations, context windows, staged Sol and the empty route acceptance registry remain unchanged.

## Completed CI evidence

The A23/preparation push at `ad1878309645adb5409e02bab678b145b73b7d3b` passed the normal 23-package pre-push hook. [Scoped workflow 41256437634](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/41256437634) completed successfully: eight package typechecks, Codium test files, browser specs, HttpApi exerciser scenarios and generated-client check. This supersedes the pending CI status above. The later native billing-fixture timeout correction is isolated in `67e3161e`: raw independent snapshot reads are handled by `Promise.allSettled`, preserving all assertions and fitting the native five-second timeout (2.048 seconds locally).

## Status on 8 Nov 2026 (P4b)

The P4 review of A23 and A24 (`codium-p4-repairs.md`, F16 to F34) found one defect in A23's scope: the research report's
Spend line wrote `- Spend: Codium` for a run that spent no dollars beside its Codium steps, and the V1 judge's re-save
of a mixed run dropped `+ Codium`, against label plan §3.2 (F16). Both report tools and the judge's re-save now call
`SpendGuard.reportSpend`; reports saved earlier are not rewritten. The self-evolving integration gate under "Integration
with self-evolving" is met at `origin/self-evolving` `245f730f` (F22). The engine review model's missing `codium` cost
kind (F18) is handed to P4d. The "Validation" section above describes its own day: its pending pre-push and CI lines are
superseded by "Completed CI evidence", whose run 41256437634 (push, head `ad187830`, success) was checked again by id
under `scr1pter/vectordev.ai`; the link above names the repository `scr1pter/claudeondfsfdaf`, as GitHub's run records
still do. Nothing earlier in this record was changed.
