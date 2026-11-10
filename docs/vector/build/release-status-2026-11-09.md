# Release evidence snapshot

Observed: 2026-11-10T02:57:14.580005+00:00
Main: `0dcbb8e2d1cc01d22d4b98695d651430f10f1d2c`

53 branches observed (including main); 41 other branches included in main; 11 unmerged; 0 ancestry unknown.
Inventory: ls-remote; completeness: remote inventory observed
Snapshot: incomplete. Release approval is not assessed; active-agent count is unknown.

| Lane            | .113 scope | Branches                                 | Required-check evidence |
| --------------- | ---------- | ---------------------------------------- | ----------------------- |
| main            | included   | main                                     | failed                  |
| coordination    | included   | release-coordination                     | unknown                 |
| runtime         | included   | self-evolving                            | unknown                 |
| release-fixes   | included   | finish-checks                            | passed                  |
| hands           | separate   | hands, hands-ui-check, hands-diagnostics | unknown                 |
| process-cleanup | unknown    | process-finish                           | unknown                 |
| codium          | separate   | codium                                   | unknown                 |
| github-agent    | separate   | vector-at-mention                        | unknown                 |
| vectorscope     | separate   | vectorscope                              | unknown                 |
| workspaces      | separate   | cloud-workspaces                         | unknown                 |
| setup           | separate   | owner-setup                              | unknown                 |

| Branch                   | Pinned SHA                               | Ahead | Behind |
| ------------------------ | ---------------------------------------- | ----: | -----: |
| benchmark-browser-policy | 6683a088471822927f5315172e69c1933f5781f2 |     0 |    387 |
| cancellation-observation | b86c3fbf4824d46b2203de5a09de61359cdc285b |     0 |    287 |
| cloud-workspaces         | ad81939c77ddc8170b778ee378475bc57c1623ec |     3 |      0 |
| codex-continuation       | 481ff836bbc2621c939c32947094c4676d313be0 |     0 |    287 |
| codex-resume             | d3c52c7f68373a30eb973f531e13259d392a5a36 |     0 |    281 |
| codium                   | eed4bc45a5c24c87d9d9505306c048ba9ebec3c7 |    38 |      0 |
| compaction-accounting    | 1a3d07c4a947674c3db68f6bbc7690a8c0288587 |     0 |    266 |
| cost-profiler            | ba05adb5300f1ebac62ab13c23a13498bd4cc703 |     0 |    264 |
| finish-checks            | 00b50f72b90ed1885b50098ed2e9eaf0cbeedf5a |     1 |      0 |
| funding-carry            | 7c171eac9a5709a48272287653a80fd3ce6c7de2 |     0 |    330 |
| funding-continuation     | 6f68b7e8e8e339d16552f6ca1baa44fd0feba99a |     0 |    332 |
| hands                    | 2171efc6664ea084f9ca2ba626cca657e0d86bb9 |   252 |      0 |
| hands-diagnostics        | 792e4fedb45a846119c0621f3e37a93426d0de16 |   255 |    447 |
| hands-ui-check           | 24b21a02727f578fbefbd1d599f00da50b0c4237 |   247 |      0 |
| harbor-heavy             | 76ac36500fc116332c8fef4c0648095c24e26803 |     0 |    288 |
| harbor-round-two         | 367660e67ddd25c9f5b06e6ee150e2b55ec906e8 |     0 |    266 |
| harbor-runner            | 6abd514a5a467af62b96058f59a2bffb9873fd0c |     0 |    280 |
| headless-stage           | d858eda13c25d3e889c3fa8d86bdd7f52dd9c941 |     0 |    264 |
| headless-startup         | 39513195d5ddb2be3bda460a6864853a379a7b5e |     0 |    261 |
| heavy-foundry            | 8ce4af881b98aaef2d73979073910f5a538c4f31 |     0 |    331 |
| heavy-funding            | aef258212e5e320eb2e0ceed6432473d97997b93 |     0 |    333 |
| heavy-nav-fix            | 61fbc62b435db3c3912f4b74f447ea4532ff3c78 |     0 |    329 |
| heavy-team-policy        | 253936035a345bc9b93de3f1313472091d500fa8 |     0 |    360 |
| heavy-team-runner        | ee12d1328ca3d63714a4aa61059924904ab9a3fa |     0 |    338 |
| idle-heartbeat           | 661d3b36c34c68181d3b9c9b551862f8f40517ff |     0 |    390 |
| investor-brief           | 30203938d4aad1281ae61c3bf5deb94295a58762 |     0 |    252 |
| layout-diagnostics       | 5a20e7faf764db2d6b4969a4fd028d091b986a90 |     0 |    388 |
| legacy-step-accounting   | 94c27c67185bbce343e0fa0eac4ec60bb801e343 |     0 |    265 |
| main                     | 0dcbb8e2d1cc01d22d4b98695d651430f10f1d2c |     0 |      0 |
| maintenance-holdout      | 764c217b897a645c93cec5486e8b1f742e866a29 |     0 |    262 |
| maintenance-stage        | 4760d3854ea37f581779f1e96aa1002a7de6e572 |     0 |    254 |
| meter-source             | 6f1e4181d517822db7d33270785ef3b60983e095 |     0 |    372 |
| multiagent-study         | c9e8f3b656d8da5373704a1fe2d3c16f70dfd6e6 |     0 |    363 |
| owner-setup              | 6f4a7c5bb8940bb32888677ea23247208b4c7c68 |     1 |    430 |
| process-finish           | d2156cb2d188bde0876309135a9039529870d609 |     2 |      0 |
| publication-accounting   | 89525f448be3d2c650af528b1328d210e822d149 |     0 |    264 |
| release-coordination     | 02098b2b6d971b5346bdd368e95236d8d2d939dc |     2 |      0 |
| research-evidence        | 914a9decafee2c6491d09e952510e8d325ec966b |     0 |    432 |
| self-evolving            | a68c0488191d42d26324dcac50ce94dfbfc44fba |     0 |      1 |
| support-inventory        | 7324b427b29d18abbc0b946a49674d35791c4843 |     0 |    262 |
| team-runner              | 698acd510d4109af67c345c89b83077aa4f7309f |     0 |    347 |
| tokenomics-complete      | 587be6478aff24e2cdf98192269bc2bd3ca755bd |     0 |    267 |
| tokenomics-delivery      | f2eb5a90f52309b3f77b67770686e484507c000d |     0 |    224 |
| tokenomics-efficiency    | bd537fd2ccd35984bf705264daa1331bb4f39feb |     0 |    415 |
| tokenomics-envelope      | a35c03d6a9bb16f16ec0187ad69c6c6420d10f19 |     0 |    404 |
| tokenomics-focus         | 893b9629224dc4249f08c0e18712511437a35a22 |     0 |    406 |
| tokenomics-gaps          | 94312a121d639919bfa5e78aadc421a0c8485d95 |     0 |    426 |
| tokenomics-scale         | 479303cf229badc0fa2c770f27d7d845dfa4fa68 |     0 |    395 |
| tokenomics-unsettled     | 46e63cdd28d32382c14a9a1e55afbf53cf9ee18f |     0 |    402 |
| tool-compose             | 1bfcc3fbbcd47692a503576aef5f8be7859e2ac5 |     0 |    393 |
| v2-loop-signatures       | dae48615985f03e85c9dede9ba0b4556a3da39f2 |     0 |    386 |
| vector-at-mention        | c65d6b5d1000ca3dd5b961d0f9f63d73baa46d64 |    55 |      0 |
| vectorscope              | bee92d8e92ab8b058814e5825e381602b87d279a |    61 |    165 |

PR metadata: unknown; complete: True.

| Open PR | Draft | Head                                     | Base                                     |
| ------- | ----- | ---------------------------------------- | ---------------------------------------- |
| 26      | True  | d2156cb2d188bde0876309135a9039529870d609 | 0dcbb8e2d1cc01d22d4b98695d651430f10f1d2c |
| 25      | True  | c65d6b5d1000ca3dd5b961d0f9f63d73baa46d64 | 0dcbb8e2d1cc01d22d4b98695d651430f10f1d2c |
| 24      | True  | eed4bc45a5c24c87d9d9505306c048ba9ebec3c7 | 0dcbb8e2d1cc01d22d4b98695d651430f10f1d2c |
| 23      | True  | 00b50f72b90ed1885b50098ed2e9eaf0cbeedf5a | 0dcbb8e2d1cc01d22d4b98695d651430f10f1d2c |
| 22      | True  | 2171efc6664ea084f9ca2ba626cca657e0d86bb9 | 0dcbb8e2d1cc01d22d4b98695d651430f10f1d2c |
| 21      | True  | ad81939c77ddc8170b778ee378475bc57c1623ec | 0dcbb8e2d1cc01d22d4b98695d651430f10f1d2c |

External gate candidate-source (main): unknown - Choose and record the reviewed release candidate SHA, scope, catalog digest and supported platforms; approve any scope change.

External gate privacy-legal (main): unknown - Review the concrete draft disclosure and residual-risk decisions in release-199113.md; no legal approval is inferred.

External gate mac-rc (main): unknown - Authenticated real Mac release-candidate acceptance with source/artifact identity and actual outcome evidence.

External gate windows-rc (main): unknown - Authenticated real Windows release-candidate acceptance with source/artifact identity and actual outcome evidence.

External gate release-artifacts (main): unknown - Version/lock/changelog, generated SDK parity, exact-candidate CI, packaging/signing and protected publication approval.

External gate live-cost-claims (main): unknown - Separate funded real-provider fork/heavy-team comparisons before claiming current runtime savings; no old API key or allowance reused by this observer.

External gate hands-platforms (hands): unknown - Native Windows Stop/capture/UIA and ARM64/package/real-device acceptance supplied by Hands owner.

External gate codium-routes-sales (codium): unknown - Qualified provider routes, protected billing tests, complete hosted integration and explicit launch approval supplied by Codium owner.

External gate github-app (github-agent): unknown - Owner-supervised App registration, installation, scoped credentials, complete workflow/publish journey and compatible CLI publication.

External gate workspace-host (workspaces): unknown - Dedicated host, runsc/quota/network isolation, TLS, backups, real sign-in/cross-device and authorized publication acceptance.

Collection issue: GitHub API HTTP 403

Collection issue: owner-setup: GitHub API HTTP 403
