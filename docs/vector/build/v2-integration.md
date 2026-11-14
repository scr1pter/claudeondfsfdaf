# Vector v2 integration

Vector v2 is the next release. It ships together with the desktop redesign. There is no separate 1.99.113 release.

**How integration works:**
- Every finished feature branch merges into the `v2` branch. Only Vercel previews deploy from it.
- `main` and the live site stay as they are until v2 ships. Then `v2` merges into `main` once, and that merge publishes the site.
- Each branch merges only when it is finished, reviewed, and green on CI at its head.
- Conflicts are resolved on the feature branch, never on `v2`.

The version becomes **2.0.0**. The 1.99.112 and 1.99.113 strings are retargeted in one change after the feature merges.

## Merge order and status (2026-11-14)

| Step | Branch / PR | Status |
|---|---|---|
| 1 | `process-finish` (#26): background command ownership and cleanup | Merged into v2. Supersedes #23 (closed). |
| 2 | `release-coordination` (#27): release tooling | Merged into v2. Its 1.99.113 names move to 2.0.0 in the version change. |
| 3 | `codium` (#24) | Merged into v2. Off behind `MODEL_PLANS_ENABLED`. Supersedes #28 (closed). Still open: B08–B11 acceptance, the A59 joint check after @vector, and the A60 owner gates. |
| 4 | `v2-vector`: @vector, built from `build-integrate`; replaces #25 | In progress: sandbox lane, red test groups, V27 runtime, V30 acceptance. The process-spawn conflict with #26 is resolved per `v2-spawn-review.md`. |
| 5 | `cloud-workspaces` (#21) | In progress: merge v2, move workspace cleanup into Codium's staged account deletion, percentages-only copy. |
| 6 | `hands` (#22) | Built by Codex. Codex merges v2 into `hands` and resolves its conflicts there, following `v2-spawn-review.md`. Then it merges into v2. |
| 7 | `v2-scope`: VectorScope, the fold of the `build-scope*` branches | In progress: fold, Brain migration order after Codium, the 7 known failures, missing modules. |
| 8 | `v2-connect`: connected workspace, from `build-connect` | In progress: final review, the CW-08 gaps, Verify. CW-20 to CW-25 come after their dependencies. |
| 9 | `v2-everywhere`: Vector everywhere | In progress: final review, runner tests, Verify. Phases 3, 4 and S come after Codium and @vector are on v2. |
| 10 | `build-native-shell`: @vector native isolation | After step 4. Needs its qualification matrix. |
| 11 | `agent-environment`: the agent's own terminals and browser | In progress: bug review, finish, update onto v2. |

## After the merges

1. Retarget the version to 2.0.0, including the live site copy that still says "Coming in desktop 1.99.113".
2. Build the redesign (Vector Signature) behind a flag on v2.
3. Then build the new features it shows: On-call, Plan and Artifacts.

Owner gates such as signing, the legal read, Stripe, platform registrations and device checks can finish during the redesign. They are listed in each area's own owner-actions notes.
