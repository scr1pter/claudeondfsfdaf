# Codium Track B integration checkpoint

Source checkpoint: 2026-11-12, branch `build-codium`, based on Codium `4d544e0c4`. This records software and local validation receipts; it is not a release, a deployed-service check, or permission to enable a perk.

## Source packages

| Package | Source and behavior | Remaining acceptance |
| --- | --- | --- |
| B01 | Codium source and explicit Brain helper/bootstrap commit `23a37c0b3` are in this isolated branch. | Root must integrate the other agent branches and run the final checks on that combined source. |
| B02–B03 | Existing label-plan code plus explicit helper consent/bootstrap. Workflow insight displays suppress private Codium usage figures. | Final combined label/prompt/skill-learn regression and browser checks. |
| B04 | `6eaf9b0b5` records relative units only for completely measured Codium runs. It learns only from sufficient checked runs with the pass-rate margin and 20% saving; Auto rechecks current role, context, locked and manual-only gates. Shared Engine wiring is in `1bff87a46`. | Integrated source check; publishing `auto-learns` still follows the perk acceptance policy. |
| B05 | `1bff87a46` carries the judge as an ordinary exact-model brief, rechecks the user's Second opinion choice/current catalog and ordinary subagent allowlist, and ignores the old extra-field shortcut. | Combined provider/task regression. |
| B06 | `becb7c6b4` adds the Tasks Race form and bounded independent worktree lanes, distinct labs and an unused-lab read-only judge. Preview precedes Run, edits invalidate it, and existing isolation review owns any merge. Shared routing quotes Codium per-request share bands before inference. | Browser execution of the added E2E; the typechecked test file alone is not a browser receipt. Per-request bands are not a whole-workflow bill or cap. |
| B07 | `1bff87a46` adds CLI install, bounded signed-link downloads without forwarded account auth, exact digest checks, personal-only reserved files, project-shadow refusal, and current-account role resolution. Settings now also has an owner-only listing/install surface in `12f3eafa7`, with the real client and API authorization tests passing. | Execute the added Settings browser regression; prove two Playbooks before listing the perk. No Playbook was published by this work. |
| B08 | `a80513a1c` prepares explicitly selected posting-checked repository context at `brain/bundle.json`; public repositories omit skills/procedures. Verified incoming bundles become review proposals, including historical insight lessons, without seeding live learner stats. | Transport/browser ports are checkpointed in `5da096548`, immutable approval snapshots in `20f8417ae`, separate returned proposal files in `85eb2abed`, and the actual Engine collect/import adapter in `0808ccb6d`. All local named tests/types passed. Redis/Lua remains CI-only; the GitHub lane also owns declared-key, current visibility/source/allowance, and cryptographic Brain-history hardening before activation. The real dispatch UI/live-run reader integrations still belong to the GitHub lane. Helpers alone do not establish an end-to-end upload path. Vector servers never decrypt or inspect the repository payload; the local client and authenticated run check its approved digest/schema/public policy. |
| B09 | `df3951bae` adds phone helper/shell state projection and exact owner Stop routes; fresh waiting/interrupted lifecycle alerts omit report/prompt/command content and use existing notification/privacy gates. | Actual paired desktop/phone browser check and combined remote authorization regression. |
| B10 | `3b1ce6d53` adds separate Vault skills/insights sections and `minReader:2` when needed. Learned sections restore as proposals; skill privacy survives import. Old memory-only backups retain reader 1. | Normal clients were regenerated; validate all lanes together and execute native/browser acceptance. |
| B11 | `3dd501832` adds owner-only conversation binding, GET-only durable local readers, token-rotation/restart reconnect and stable quiet result receipts. `9941eb31b` exposes owner APIs with normally generated SDKs. Focused real-state, partial-write, owner/guest and display-marker tests passed. | The shared renderer now displays only explicitly marked final hosted reports, labels them Cloud computer report and omits the human Revert action. The required pre-change measurement and local owner API regression passed; runtime browser behavior and post-change measurement/comparison remain pending. |

## Executed receipts

The root coordinator ran these checks serially. Logs are under `/tmp/vector-build-validation` in the execution workspace; they are local evidence, not repository CI links.

| Receipt | Passed |
| --- | --- |
| Core Codium Auto / Brain workflow | 7 tests / 15 tests |
| Engine Second opinion, corrected factory fixture | 9 tests |
| Core Race builder | 2 tests |
| Core Playbooks installer / command checker | 3 tests / 11 tests |
| Engine saved library / orchestration runs | 7 tests / 18 tests |
| Core Brain run bundle / export at B08 receipt | 4 tests / 11 tests |
| Core explicit-upload crypto/privacy / Web actual-HTTP upload authority denials | 3 tests / 3 tests |
| Engine Settings Playbook client | 2 tests |
| Core returned proposal pack / Engine actual review-queue roundtrip / session report marker | 4 tests / 1 test / 1 test |
| Earlier-build migration/connection fixtures / setting-based CLI distillation | 3 files / 1 targeted CLI case |
| Complete HttpApi scenario inventory | 344 declared cases, zero missing/extra/skipped |
| New Brain/Playbooks/hosted effect and authentication scenarios | 12 executed cases; all six command exits green |
| Real saved-opt-out bootstrap effect/authentication | 2 executed cases; zero model calls in the effect fixture |
| Core hosted report / Engine hosted reader / durable note partial-write repair | 4 tests / 2 tests / 1 test |
| Desktop remote routes after exact new-route snapshot update | 15 tests |
| App phone task projection / helper lifecycle alerts | 1 test / 1 test |
| Core Vault / Engine Vault HTTP / Engine Vault CLI / Desktop Vault | 18 tests / 5 tests / 2 tests / 17 tests |

Final Core, Engine, session-ui, App, App E2E and API-only types passed after the owner preview/import controls, immutable upload snapshot, proposal collection and hosted report renderer. Normal client/SDK generation passed. The final harness/source type check also passed after the inventory repair (`db44d2947`). Desktop types passed on the unchanged B09/B10 desktop source. Earlier failed logs remain for traceability; corrected factory fixtures, validation ordering, exact route snapshots, migration inventories, CLI setting copy and stable-service closure checks supersede the corresponding old failures. Inventory coverage is structural; only the specifically listed effect/auth cases are execution receipts, not all 344 routes. The opaque-upload Redis/Lua suite is CI-only and has not run locally; the coordinator has no disposable Redis here. No runtime Race/Playbooks/hosted-note browser test or native release test is claimed here.

The pre-render production benchmark was run at exact source `1bff87a46d28f582aea829e19eb232cc9c5fe0e9`: [run 43153942138, measurement job 130969401195](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43153942138/job/130969401195). The official decoded job log has nine passing cases, retry 0 and zero blank/unknown samples. This fulfills the before-change baseline requirement only. Other jobs in that workflow failed on stale migration inventories and legacy CLI-off copy; the corresponding exact local fixture tests now pass in `35a885ff6`, but the final remote workflow still must run; it is not a clean-workflow, whole-source CI or performance-improvement claim. The post-change measurement/comparison is still required.

## A59 and launch gates

`07db244c0` derives cloud-agent allowance from the canonical Codium entitlement snapshot instead of a duplicated plan table. The GitHub agent lane carries the coordinated verifier, gateway settlement hook, entitlement delegation and bounded meter registration. The existing Settings usage model already has the listed `github-agents`/`cloudAgents` row. Root must integrate and validate both lanes together; listing `@vector` still requires the specified live-run proof.

A60 remains an owner release checklist: legal approval/dates, accepted provider captures, test purchases and payment lifecycle checks, staging load/memory evidence, protected infrastructure deployments, perk acceptance/listing, minimum-client activation, and signed desktop/npm publication. None of those gates was enabled or represented as passed by this checkpoint. The global enable switches and paid infrastructure controls remain unchanged.
