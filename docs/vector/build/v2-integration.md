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

## Deleted branches

On 2026-11-14, with the owner's yes, these 41 branches were deleted from GitHub. Every commit in them was already in `main`. Each can be restored from its last commit with `git push origin <sha>:refs/heads/<name>`.

| Branch | Last commit |
|---|---|
| `benchmark-browser-policy` | `6683a088471822927f5315172e69c1933f5781f2` |
| `cancellation-observation` | `b86c3fbf4824d46b2203de5a09de61359cdc285b` |
| `codex-continuation` | `481ff836bbc2621c939c32947094c4676d313be0` |
| `codex-resume` | `d3c52c7f68373a30eb973f531e13259d392a5a36` |
| `compaction-accounting` | `1a3d07c4a947674c3db68f6bbc7690a8c0288587` |
| `cost-profiler` | `ba05adb5300f1ebac62ab13c23a13498bd4cc703` |
| `funding-carry` | `7c171eac9a5709a48272287653a80fd3ce6c7de2` |
| `funding-continuation` | `6f68b7e8e8e339d16552f6ca1baa44fd0feba99a` |
| `harbor-heavy` | `76ac36500fc116332c8fef4c0648095c24e26803` |
| `harbor-round-two` | `367660e67ddd25c9f5b06e6ee150e2b55ec906e8` |
| `harbor-runner` | `6abd514a5a467af62b96058f59a2bffb9873fd0c` |
| `headless-stage` | `d858eda13c25d3e889c3fa8d86bdd7f52dd9c941` |
| `headless-startup` | `39513195d5ddb2be3bda460a6864853a379a7b5e` |
| `heavy-foundry` | `8ce4af881b98aaef2d73979073910f5a538c4f31` |
| `heavy-funding` | `aef258212e5e320eb2e0ceed6432473d97997b93` |
| `heavy-nav-fix` | `61fbc62b435db3c3912f4b74f447ea4532ff3c78` |
| `heavy-team-policy` | `253936035a345bc9b93de3f1313472091d500fa8` |
| `heavy-team-runner` | `ee12d1328ca3d63714a4aa61059924904ab9a3fa` |
| `idle-heartbeat` | `661d3b36c34c68181d3b9c9b551862f8f40517ff` |
| `investor-brief` | `30203938d4aad1281ae61c3bf5deb94295a58762` |
| `layout-diagnostics` | `5a20e7faf764db2d6b4969a4fd028d091b986a90` |
| `legacy-step-accounting` | `94c27c67185bbce343e0fa0eac4ec60bb801e343` |
| `maintenance-holdout` | `764c217b897a645c93cec5486e8b1f742e866a29` |
| `maintenance-stage` | `4760d3854ea37f581779f1e96aa1002a7de6e572` |
| `meter-source` | `6f1e4181d517822db7d33270785ef3b60983e095` |
| `multiagent-study` | `c9e8f3b656d8da5373704a1fe2d3c16f70dfd6e6` |
| `publication-accounting` | `89525f448be3d2c650af528b1328d210e822d149` |
| `research-evidence` | `914a9decafee2c6491d09e952510e8d325ec966b` |
| `self-evolving` | `a68c0488191d42d26324dcac50ce94dfbfc44fba` |
| `support-inventory` | `7324b427b29d18abbc0b946a49674d35791c4843` |
| `team-runner` | `698acd510d4109af67c345c89b83077aa4f7309f` |
| `tokenomics-complete` | `587be6478aff24e2cdf98192269bc2bd3ca755bd` |
| `tokenomics-delivery` | `f2eb5a90f52309b3f77b67770686e484507c000d` |
| `tokenomics-efficiency` | `bd537fd2ccd35984bf705264daa1331bb4f39feb` |
| `tokenomics-envelope` | `a35c03d6a9bb16f16ec0187ad69c6c6420d10f19` |
| `tokenomics-focus` | `893b9629224dc4249f08c0e18712511437a35a22` |
| `tokenomics-gaps` | `94312a121d639919bfa5e78aadc421a0c8485d95` |
| `tokenomics-scale` | `479303cf229badc0fa2c770f27d7d845dfa4fa68` |
| `tokenomics-unsettled` | `46e63cdd28d32382c14a9a1e55afbf53cf9ee18f` |
| `tool-compose` | `1bfcc3fbbcd47692a503576aef5f8be7859e2ac5` |
| `v2-loop-signatures` | `dae48615985f03e85c9dede9ba0b4556a3da39f2` |
