# Vector v2 integration

Vector v2 is the next release. It ships together with the desktop redesign. There is no separate 1.99.113 release.

**Current source assembly (14 November):** PR #33 joins the surviving feature branches for direct integration into
`main`, including the owner-approved historical benchmark and the archive-only legal disposition. It is awaiting
exact-head CI and preview qualification. The earlier `v2` merge-order table below is historical; see
[the current integration record](./main-integration-2026-11-14.md) for included source and held runtime/owner gates.
No branch should be deleted from this assembly until its contents are verified in `main` and its last SHA is recorded.

**Update (21 November):** PR #33 merged into `main` as `b362fdf6`. See "Merged pull requests" below for every merge since.

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
| 5 | `cloud-workspaces` (#21) | Finished on `workspaces-finish` (WS-01 to WS-05), awaiting its PR: workspace cleanup inside Codium's staged account deletion, tested against the real workspace supervisor; the token revocation re-asserted in each follow-up check pass, stopping at `revoke` when the write fails (`review-fixes`' DP-2 fix `cbf83048`, not yet in `release-finish`, is the best-effort form); usage shown only as percentages; the account and workspace page tests in CI. The `cloud-workspaces` branch is retired (its head `d0300404` is in PR #33). CW-24's proxy routes moved to the Connect lane (CN-19, not built yet). Off by default. |
| 6 | `hands` (#22) | Built by Codex. Codex merges v2 into `hands` and resolves its conflicts there, following `v2-spawn-review.md`. Then it merges into v2. |
| 7 | `v2-scope`: VectorScope, the fold of the `build-scope*` branches | In progress: fold, Brain migration order after Codium, the 7 known failures, missing modules. |
| 8 | `v2-connect`: connected workspace, from `build-connect` | In progress: final review, the CW-08 gaps, Verify. CW-20 to CW-25 come after their dependencies. |
| 9 | `v2-everywhere`: Vector everywhere | In progress: final review, runner tests, Verify. Phases 3, 4 and S come after Codium and @vector are on v2. |
| 10 | `build-native-shell`: @vector native isolation | After step 4. Needs its qualification matrix. |
| 11 | `agent-environment`: the agent's own terminals and browser | In progress: bug review, finish, update onto v2. |

## main

On 2026-11-14 the owner chose to have everything live in `main` with no long-lived integration branch. `main` was fast-forwarded to `v2` at `983fe7025`, and every later merge goes straight into `main`. Each push to `main` deploys vectordev.ai, so new features stay off by default.

## After the merges

1. Retarget the version to 2.0.0, including the live site copy that still says "Coming in desktop 1.99.113".
2. Build the redesign (Vector Signature) behind a flag on v2.
3. Then build the new features it shows: On-call, Plan and Artifacts.

Owner gates such as signing, the legal read, Stripe, platform registrations and device checks can finish during the redesign. They are listed in each area's own owner-actions notes.

## Merged pull requests (16 to 21 November 2026)

Each pull request below merged into `main` with a merge commit. The merge commits were checked against `git log` (each subject ends in its PR number, and each is an ancestor of `main` `f3d7ac74`), and the head branches against the GitHub API. Dates are UTC.

| PR  | Branch                    | Merge commit | Merged |
| --- | ------------------------- | ------------ | ------ |
| #33 | `release-finish`          | `b362fdf6`   | 16 Nov |
| #34 | `workspaces-finish`       | `1b1563dd`   | 16 Nov |
| #37 | `e2e-linux-budget`        | `33fc9fbc`   | 16 Nov |
| #35 | `native-qualify`          | `2034e1da`   | 16 Nov |
| #39 | `windows-stop-observe`    | `3ab7858e`   | 16 Nov |
| #40 | `hands-finish`            | `2f64aca2`   | 16 Nov |
| #38 | `connect-finish`          | `7e440a27`   | 16 Nov |
| #41 | `ci-install-retry`        | `dabc4821`   | 16 Nov |
| #44 | `parse-test-windows`      | `dc89e4ec`   | 17 Nov |
| #42 | `windows-stop-guardian`   | `4bb9bcb2`   | 17 Nov |
| #43 | `brain-transport`         | `7c7508d2`   | 17 Nov |
| #36 | `codium-finish`           | `b5cbad1c`   | 20 Nov |
| #47 | `ownership-windows`       | `56b2862b`   | 20 Nov |
| #46 | `stop-release-thread`     | `6a771354`   | 20 Nov |
| #48 | `windows-engine-timeouts` | `481973c9`   | 20 Nov |
| #49 | `scrollback-bun-crash`    | `14cb9720`   | 20 Nov |
| #50 | `piped-output-drain`      | `8e34d05e`   | 20 Nov |
| #52 | `native-build-parallel`   | `c776fb60`   | 20 Nov |
| #51 | `policy-acl-timeout`      | `15f3ba77`   | 20 Nov |
| #53 | `region-compile-budget`   | `3670461a`   | 20 Nov |
| #54 | `windows-test-budgets`    | `f3d7ac74`   | 21 Nov |

PR #45 (`uia-first-lookup`) was closed without merging. Still open on 21 November: the Everywhere lane (`everywhere-finish`) is about to open its pull request, and VectorScope (`scope-finish`) is in progress in another session.

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


### Prepared final cleanup batch (not yet deleted)

Superseded on 21 November 2026 by "Branches to delete" below, which rechecks every remaining branch against `main` `f3d7ac74`. Several tips marked "ancestor" here are not ancestors of that `main`.

The owner requested main-only branch storage. These 42 feature-branch tips were verified against source assembly
`2aaa4f5e28efe14c630e892146fad28239f48813`: each is an ancestor or has no unique patch under `git cherry`.
This is a recovery registry and prepared queue, not a claim that deletion already happened. Before deletion,
recheck each exact remote tip against the merged `main`; retain any branch that moved or has a unique patch.
The temporary assembly branch is handled only after its final CI-qualified tip reaches `main`.

| Branch | Recorded tip | Inclusion proof |
| --- | --- | --- |
| `agent-environment` | `fa938a090bc60f427809db5b904796594432cd7c` | ancestor |
| `benchmark-before` | `3abfbd1c3555c8efdc4e7a26b1ac178e3488c9d6` | ancestor |
| `build-candidate` | `dfc26ee931fb622beac46ce800e9a65dafadd915` | ancestor |
| `build-codium` | `1bff87a46d28f582aea829e19eb232cc9c5fe0e9` | ancestor |
| `build-complete` | `00b87034faa1e3c1604ab7160f5e5c33f3745805` | ancestor |
| `build-connect` | `a8234d9ac34f74bb84d48bce17c0de48d4b18c38` | ancestor |
| `build-coordination` | `41dac6f728ee67dc083950614fd143b0d45507b4` | patch-equivalent |
| `build-everywhere` | `5053d4907383ef31a61844995215eb86a53e7845` | ancestor |
| `build-github-ui` | `017f7144b031649967c0a1cae4f0a5be23bef34c` | ancestor |
| `build-integrate` | `ceed2426aa546ecc7d18357ebb1058d4598b3832` | ancestor |
| `build-isolation` | `cf34ffe29e5cd1b5fd05d5749f6ee4a418500b8d` | ancestor |
| `build-native-shell` | `faa1fa09b697b900e6125ad316a7e961de616981` | ancestor |
| `build-process` | `a193d18d9053f4240443415c64b9935fb2a7f8ec` | ancestor |
| `build-scope` | `0dcd814e6ac69edefcdffb10ff4bbd95c7062398` | ancestor |
| `build-scope-checks` | `7bbf4d88bca2302bb74940919597fe513ea00979` | ancestor |
| `build-scope-joined` | `3bb2b2ba223ced69af19ff67465de1adee34e646` | ancestor |
| `build-scope-owner` | `892202d4a603e7e0afc75065bb8459c2825e17c8` | ancestor |
| `build-scope-ui` | `e00d579b3f7ffc1a62ea1f8050aadf5c266257d5` | ancestor |
| `build-scope-wire` | `82cbb103e3c8ebf1299ce81a1197e93dbf2205a4` | ancestor |
| `build-scope-witness` | `5d672a22898770f7b3cca865dacc36586b98d513` | ancestor |
| `cloud-workspaces` | `d0300404e9e280891cda85122bee21bf47eb2b02` | ancestor |
| `codium` | `1ce8f5f3012fa2b5de738dc234773e07ce226c0d` | ancestor |
| `codium-legal` | `fd4db7f47ff1553658aff5817049e1f6dbdbb1bb` | ancestor |
| `codium-track` | `c262f74b33fdf3b8b5faddbc24395891227878be` | patch-equivalent |
| `connected-workspace` | `9d77e1942e596a00b4fb7739adf88466a3ba54c8` | ancestor |
| `finish-checks` | `00b50f72b90ed1885b50098ed2e9eaf0cbeedf5a` | patch-equivalent |
| `hands` | `4eb9f52fdf2ee7d04a1da0bdc1f394ca9ff70dec` | ancestor |
| `hands-diagnostics` | `ead163391a558f7a94c1fdb589b87b2c71bb1a84` | ancestor |
| `hands-ui-check` | `24b21a02727f578fbefbd1d599f00da50b0c4237` | ancestor |
| `native-finish` | `f141ef16e1a1306c065531ef22088f06103d143e` | ancestor |
| `owner-setup` | `6f4a7c5bb8940bb32888677ea23247208b4c7c68` | patch-equivalent |
| `process-finish` | `3ec7fb14b7533133e04589f754cb9041e054f26d` | ancestor |
| `release-coordination` | `4df0956d98b4e0406d314c496a7054a0d9ecb1ae` | ancestor |
| `v2-connect` | `0c58e7f698ccc47fd7e4c16e2dea9f6e5ea22237` | ancestor |
| `v2-everywhere` | `40e7086143bad6bd6bc53d586f93ffae5082c55c` | ancestor |
| `v2-hands` | `3d5a45a09f0126f77591902901adfe934ec7511f` | ancestor |
| `v2-locks` | `06814f1df410c7105ef4f1a83dcf80d467a41611` | ancestor |
| `v2-scope` | `76b5619f1b63038c7c2fe7bbb9edb653baacbe6f` | ancestor |
| `v2-vector` | `5dbdcfb4669575ddb936c9d83b97d25613abfba4` | ancestor |
| `vector-at-mention` | `c0d10fb85a0cecc8264abd0bb37693a95d93e07d` | ancestor |
| `vector-everywhere` | `890bb072b096bf380d245321a4120ef07b12b2ea` | ancestor |
| `vectorscope` | `bee92d8e92ab8b058814e5825e381602b87d279a` | ancestor |

## Branches to delete

This session's GitHub access refuses branch deletion (HTTP 403), so the owner deletes these on GitHub. Each can be restored from its last commit with `git push origin <sha>:refs/heads/<name>`. `everywhere-finish` and `scope-finish` are still active and are not listed.

### Fully in main (32 branches)

Each branch's last commit is an ancestor of `origin/main` (`f3d7ac74`), rechecked on 21 November 2026 with `git merge-base --is-ancestor origin/<name> origin/main`. No branch had moved since the list was made.

| Branch                    | Last commit                                | Date       |
| ------------------------- | ------------------------------------------ | ---------- |
| `benchmark-before`        | `3abfbd1c3555c8efdc4e7a26b1ac178e3488c9d6` | 2026-11-10 |
| `brain-transport`         | `0d18f75035688348171f5f97b878fb3303bbc7cc` | 2026-11-17 |
| `build-codium`            | `1bff87a46d28f582aea829e19eb232cc9c5fe0e9` | 2026-11-12 |
| `build-process`           | `a193d18d9053f4240443415c64b9935fb2a7f8ec` | 2026-11-12 |
| `ci-install-retry`        | `218d8991294e450c2090937f10cdb35478e215c6` | 2026-11-16 |
| `codium`                  | `1ce8f5f3012fa2b5de738dc234773e07ce226c0d` | 2026-11-12 |
| `codium-finish`           | `58663f5b6256c453311a62d8e5e41ba92481e5b2` | 2026-11-17 |
| `codium-legal`            | `fd4db7f47ff1553658aff5817049e1f6dbdbb1bb` | 2026-11-13 |
| `connect-finish`          | `19c48b89267e61ab6d9aaf5eee23eb03f62578e8` | 2026-11-16 |
| `e2e-linux-budget`        | `0137cda3e2b403fd241558da807a70cc216364a3` | 2026-11-16 |
| `hands-diagnostics`       | `ead163391a558f7a94c1fdb589b87b2c71bb1a84` | 2026-11-10 |
| `hands-finish`            | `8139e5fc4abd5bf1a8393b5f27a9166a31507cf1` | 2026-11-16 |
| `native-build-parallel`   | `8aa95269c1166e69a387309dceb74cb1f7d73ff5` | 2026-11-20 |
| `native-qualify`          | `2677c32cb813e2c4c7d3262986a0d3e60286673d` | 2026-11-16 |
| `native-stop-fix`         | `a0fbfa3b16b65c0def4459d83892ee1f09c71daa` | 2026-11-14 |
| `ownership-windows`       | `42f7b3d490c7d507dd0ad769aee8998bc1318336` | 2026-11-20 |
| `parse-test-windows`      | `5dd70f9ed33ddd1674e50ca3c4678389e839afda` | 2026-11-17 |
| `piped-output-drain`      | `6f3071505e59a611665f2578774da5216d765442` | 2026-11-20 |
| `policy-acl-timeout`      | `a3fe7af1ed46240150d693263d36e2c59d410d4e` | 2026-11-20 |
| `process-finish`          | `3ec7fb14b7533133e04589f754cb9041e054f26d` | 2026-11-13 |
| `region-compile-budget`   | `5002a8ce40891b919f2da5fc37485374284c97cb` | 2026-11-20 |
| `release-coordination`    | `4df0956d98b4e0406d314c496a7054a0d9ecb1ae` | 2026-11-13 |
| `release-finish`          | `67ec3a60a59973b252cf442ae25e1b3311ce60e5` | 2026-11-16 |
| `review-fixes`            | `1433d10542073a123d2c85f3879bb36293d12edd` | 2026-11-15 |
| `scrollback-bun-crash`    | `79912e49120901855fec492ef068bccf31632982` | 2026-11-20 |
| `stop-release-thread`     | `47ca8cca8275c78a3f21cf82df181334ee1cb0b1` | 2026-11-20 |
| `windows-engine-timeouts` | `506600e10d348f190c16b14ca8b615e57343953d` | 2026-11-20 |
| `windows-stop-guardian`   | `24436c868035b12caf2bd70efe72465826e56e48` | 2026-11-17 |
| `windows-stop-observe`    | `b6370e89fec521ae153e7e9578c645969565de87` | 2026-11-16 |
| `windows-stop-release`    | `10343ebde8ad5605440ced942a0351ec78084d41` | 2026-11-16 |
| `windows-test-budgets`    | `625153c74946bd0e8b0e46ca8806980d7843a5f1` | 2026-11-20 |
| `workspaces-finish`       | `e37ec1b5fd338ded9d39e4bf9b510162ab9088f7` | 2026-11-16 |

### Needs the owner's decision (35 branches)

These branches are not ancestors of `main`. "Commits not in main" counts the branch's non-merge commits whose patch `git cherry` does not find in `main`. Their work looks superseded by later branches that did merge (for example, `cloud-workspaces` by `workspaces-finish` and `v2-hands` by `hands-finish`), but that is not proven: a branch's own patch may differ from the merged version. The owner decides whether to keep or delete each one.

| Branch                | Last commit                                | Date       | Commits not in main |
| --------------------- | ------------------------------------------ | ---------- | ------------------- |
| `agent-environment`   | `fa938a090bc60f427809db5b904796594432cd7c` | 2026-11-14 | 39                  |
| `build-candidate`     | `dfc26ee931fb622beac46ce800e9a65dafadd915` | 2026-11-14 | 219                 |
| `build-complete`      | `00b87034faa1e3c1604ab7160f5e5c33f3745805` | 2026-11-14 | 351                 |
| `build-connect`       | `a8234d9ac34f74bb84d48bce17c0de48d4b18c38` | 2026-11-14 | 59                  |
| `build-coordination`  | `41dac6f728ee67dc083950614fd143b0d45507b4` | 2026-11-14 | 1                   |
| `build-everywhere`    | `5053d4907383ef31a61844995215eb86a53e7845` | 2026-11-14 | 25                  |
| `build-github-ui`     | `017f7144b031649967c0a1cae4f0a5be23bef34c` | 2026-11-12 | 70                  |
| `build-integrate`     | `ceed2426aa546ecc7d18357ebb1058d4598b3832` | 2026-11-14 | 104                 |
| `build-isolation`     | `cf34ffe29e5cd1b5fd05d5749f6ee4a418500b8d` | 2026-11-12 | 103                 |
| `build-native-shell`  | `faa1fa09b697b900e6125ad316a7e961de616981` | 2026-11-14 | 117                 |
| `build-scope`         | `0dcd814e6ac69edefcdffb10ff4bbd95c7062398` | 2026-11-13 | 117                 |
| `build-scope-checks`  | `7bbf4d88bca2302bb74940919597fe513ea00979` | 2026-11-12 | 87                  |
| `build-scope-joined`  | `3bb2b2ba223ced69af19ff67465de1adee34e646` | 2026-11-14 | 145                 |
| `build-scope-owner`   | `892202d4a603e7e0afc75065bb8459c2825e17c8` | 2026-11-13 | 113                 |
| `build-scope-ui`      | `e00d579b3f7ffc1a62ea1f8050aadf5c266257d5` | 2026-11-12 | 86                  |
| `build-scope-wire`    | `82cbb103e3c8ebf1299ce81a1197e93dbf2205a4` | 2026-11-14 | 109                 |
| `build-scope-witness` | `5d672a22898770f7b3cca865dacc36586b98d513` | 2026-11-13 | 102                 |
| `cloud-workspaces`    | `d0300404e9e280891cda85122bee21bf47eb2b02` | 2026-11-14 | 9                   |
| `codium-track`        | `c262f74b33fdf3b8b5faddbc24395891227878be` | 2026-11-10 | 35                  |
| `connected-workspace` | `9d77e1942e596a00b4fb7739adf88466a3ba54c8` | 2026-11-12 | 19                  |
| `finish-checks`       | `00b50f72b90ed1885b50098ed2e9eaf0cbeedf5a` | 2026-11-10 | 0                   |
| `hands`               | `4eb9f52fdf2ee7d04a1da0bdc1f394ca9ff70dec` | 2026-11-13 | 286                 |
| `hands-ui-check`      | `24b21a02727f578fbefbd1d599f00da50b0c4237` | 2026-11-10 | 246                 |
| `native-finish`       | `f141ef16e1a1306c065531ef22088f06103d143e` | 2026-11-14 | 120                 |
| `owner-setup`         | `6f4a7c5bb8940bb32888677ea23247208b4c7c68` | 2026-11-02 | 1                   |
| `uia-first-lookup`    | `321a02983a8aa8f7a910d807280566fb893a81e2` | 2026-11-17 | 2                   |
| `v2-connect`          | `0c58e7f698ccc47fd7e4c16e2dea9f6e5ea22237` | 2026-11-13 | 60                  |
| `v2-everywhere`       | `40e7086143bad6bd6bc53d586f93ffae5082c55c` | 2026-11-13 | 27                  |
| `v2-hands`            | `3d5a45a09f0126f77591902901adfe934ec7511f` | 2026-11-14 | 287                 |
| `v2-locks`            | `06814f1df410c7105ef4f1a83dcf80d467a41611` | 2026-11-14 | 4                   |
| `v2-scope`            | `76b5619f1b63038c7c2fe7bbb9edb653baacbe6f` | 2026-11-13 | 173                 |
| `v2-vector`           | `5dbdcfb4669575ddb936c9d83b97d25613abfba4` | 2026-11-14 | 111                 |
| `vector-at-mention`   | `c0d10fb85a0cecc8264abd0bb37693a95d93e07d` | 2026-11-12 | 78                  |
| `vector-everywhere`   | `890bb072b096bf380d245321a4120ef07b12b2ea` | 2026-11-12 | 24                  |
| `vectorscope`         | `bee92d8e92ab8b058814e5825e381602b87d279a` | 2026-11-08 | 58                  |
