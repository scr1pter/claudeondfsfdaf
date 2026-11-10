# Integration hand-off — 9 November 2026

The runtime foundation is on main. The feature agents still own Hands, Codium,
`@vector`, Vectorscope and their follow-ups. This hand-off identifies shared
conflict points so they can integrate their work without competing fixes.
It does not authorize merging drafts or adding these products to desktop .113.

The [branch/PR/check snapshot](release-status-2026-11-09.md) and
[machine-readable dry runs](evidence/integration-dry-runs-2026-11-09.json) pin
every source revision. Refresh the evidence after a source head moves.

## Current integration blockers

| Pinned pair                                  | Result              | Existing owners need to reconcile                                                                                               |
| -------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| main `0dcbb8e2` + Vectorscope `bee92d8e`     | 11 conflicted files | Review UI/types/runner plus migration, CLI, compliance and tool tests                                                           |
| Codium `eed4bc45` + `@vector` `c65d6b5d`     | 1 conflicted file   | Provider routing in `packages/engine/src/provider/provider.ts`                                                                  |
| Codium `eed4bc45` + Hands `2171efc6`         | 8 conflicted files  | Settings, platform/layout, desktop startup/tray/account runtime, and CLI export                                                 |
| process-finish `d2156cb2` + Hands `2171efc6` | 2 conflicted files  | Background shell ownership and its tests in `packages/engine/src/task/shells.ts` and `packages/engine/test/task/shells.test.ts` |

Fourteen other listed pairwise simulations were textually clean, including the
committed coordination branch against `finish-checks`, `process-finish`, Hands
and Codium. `@vector` + Hands and `process-finish` + Codium / `@vector` were also
textually clean. Most main-to-feature comparisons are trivial because the
feature already contains main. These results do not establish behavior or show
that an eventual combined merge is conflict-free.

The `finish-checks` and `process-finish` tip commits have the same stable patch
ID. Their complete branches are different: `process-finish` additionally has
production background-command ownership/cleanup in `11111071`. Their owners
should account for that shared fix when choosing the reviewed follow-up; do
not assume either entire branch replaces the other.

## Keep the release paths separate

Desktop .113 retains its existing learned-skills and multiagent scope. Its
candidate still needs exact-source CI, platform acceptance, privacy review and
release artifact/publication gates. The new `process-finish` draft has unknown
.113 inclusion until reviewed. Hands, Codium, `@vector`, Vectorscope upgrades
and the workspace pilot retain their existing launch plans.

For each proposed integration, its owner should reconcile the shared paths,
retain the other side's behavior and tests, and check the resulting source.
Changes to provider routing must retain usage/spend accounting; shell changes
must retain Stop and process ownership behavior; migration and generated
contract obligations still apply. A pairwise merge simulation supplies none of
that behavioral evidence.

## Coordinator validation delivered

- Portable Windows learned-skill fixture: isolated cases changed from two
  failures to two passes without weakening learning assertions.
- Core accounting diagnostics: 94 passed, including simulated accounting of
  one billion logical tokens; no production-scale inference claim.
- Release observer: 27 tests passed; incomplete, stale, skipped and unavailable
  evidence stays explicit.
- Mandatory pre-push checks: all 23 workspace typechecks passed on both initial
  pushed commits.
- [Production UI completion](evidence/ui-completion-2026-11-09/README.md): three
  scenarios passed, with raw metrics and lossless compressed traces retained.
  This battery-powered single run supplies no comparative speed evidence.
- [AC-powered first-navigation comparison](evidence/ui-comparison-ac-2026-11-09/README.md):
  60 runs passed across two source revisions and reversed run orders. All 46
  power samples reported AC. Existing-conversation navigation was modestly slower;
  the selected subset does not establish a general speed improvement or full
  timeline qualification.

The [validation record](evidence/release-coordination-2026-11-09.json) preserves
the initial failures, repairs, commands and limits. No live provider calls,
paid benchmarks, service enablement or release publication were performed.
