# VectorScope lane plan (scope-finish): remaining packages and lane context

This file is generated from the lead's lane definition (the `A` object of the lane workflow script) on 2026-11-21, so the next agent has the exact package briefs, lane context and rulings that drove SF-01 to SF-15. Read `vectorscope-lane-handoff.md` first; it says how to use this file.

## Status

Done and pushed to `origin/scope-finish` (head `e6d34fed`): SF-01, SF-02, SF-03, SF-04, SF-05a, SF-05b, SF-06, SF-07, SF-08, SF-09, SF-10a, SF-10b, SF-11, SF-12a, SF-12b, SF-13a, SF-13b, SF-14, SF-15 (19 of 47).

Remaining (28), in build order:

| Package | Title                                                                            |
| ------- | -------------------------------------------------------------------------------- |
| SF-16   | VS-24 part a: trivial zero-token skip in Review.run                              |
| SF-17   | VS-24 part b: pre-dispatch estimate, staged shrink and maxInputTokens            |
| SF-18   | VS-25 impact slice wiring through the private Git view                           |
| SF-19   | VS-27c part a: strict guardrail in the runner                                    |
| SF-20   | VS-27c part b: StrictResult in CLI JSON and the desktop half                     |
| SF-21   | VS-42 wiring: introduced-by-change gate under strict                             |
| SF-22   | VS-43 wiring: ruleCheck key and rule citation gate                               |
| SF-23   | VS-44 wiring: certificate-backed verification under strict                       |
| SF-24   | VS-28 part a: automatic depth from the risk band                                 |
| SF-25   | VS-28 part b: bounded parallel single-class lens sessions                        |
| SF-26   | VS-26 Brain context cards for local CLI reviews                                  |
| SF-27   | VS-19 part a: durable large-PR batch plan and cursor (core)                      |
| SF-28   | VS-19 part b: run large-PR batches in Review.run                                 |
| SF-29   | VS-14 part a: default-deny MCP review broker policy                              |
| SF-30a  | VS-14 part b1: filter MCP listings, instructions and prompts for review sessions |
| SF-30b  | VS-14 part b2: execution-time MCP enforcement, nested tools and reconnects       |
| SF-31   | VS-15 pre-exposure bounded MCP snapshots                                         |
| SF-32   | VS-18 part a: offline secret and dependency diagnostics evidence lane            |
| SF-33   | VS-18 part b: pinned diagnostic adapter contract on the isolated executor        |
| SF-34   | VS-29b trusted local authorship inversion                                        |
| SF-35   | VS-23/VS-33 all-route production wire audit (Codium route stays refused)         |
| SF-36   | VS-05 compatible CLI reconciliation (no version change)                          |
| SF-37   | GitHub half: privacy and holdback into the job, sessions into the posting check  |
| SF-38   | GitHub half: trivial skip through decideSkip state                               |
| SF-39   | GitHub half: fail-closed review verdict in the job and posting plan              |
| SF-40   | VS-13 part a: bind /vector fix to the fix proposal and current authority         |
| SF-41   | VS-13 part b: execute GitHub fixes through the run bundle and publish phase      |
| SF-42   | Refresh the VectorScope inventory, continuation and final pin                    |

## Lane context (given to every package agent)

- Lane name: `vectorscope-finish`; branch `scope-finish` (remote `scope-finish`); the lead's worktree was `<worktree>`; scratch `<scratch>/scope/`.
- Workflows checked after every package: `typecheck.yml`, `scope-directory-identity.yml`, `review-memory-fence.yml`, `scope-app-validation.yml`, `vector-at-mention.yml`; dispatched on scope-finish after each push: `typecheck.yml`, `scope-directory-identity.yml`, `review-memory-fence.yml`, `scope-app-validation.yml`, `vector-at-mention.yml`; at the end: `test.yml`.
- Review loop: up to 3 two-lens review rounds per package; up to 3 continue-agents if an implementer stops early; CI check before the first package: False.

### Documents to read

docs/vector/build/vectorscope-lane-handoff.md (section "Binding rules"): the binding lane rules. Covers the never-list, vector-serial, running one test file at a time, pushes, CI flakes and the spawn hot spot.
AGENTS.md: the repo style guide. Covers dependency direction (Schema→Core/Protocol→Server), generators, and where tests and typecheck run.
docs/vector/build/v2-handoff.md: the owner's list under "After those merges" item 3. It names the VS-12 executor, VS-14, 15, 18, 19 and 26; the wiring of VS-23/24/25/27/28/34/42/43/44 with defaults unchanged; VS-05 and VS-13 plus the GitHub and Codium halves. It also has the owner-only items and item 6, the single regeneration step that belongs to the lead.
docs/vector/build/vectorscope-remaining.md: the source inventory of every VS-01–49 package, the software and acceptance that remain, and the external gates. It is dated 12 Nov and stale in places (see v2 plan §4).
docs/vector/build/v2-notes/vectorscope-v2-plan.md: §4 "What remains to build" has the build table (VS-12/14/15/18/19/26), the wiring table, the @vector/Codium waits and the owner list. §5 has the build order.
docs/vector/build/vectorscope-plan.md: the original plan. Covers Fix proposals and consent and MCP without PR-driven egress. The phased table rows VS-05..VS-20 are at :315-330. The reuse table at :395-410 names the VS-12 mechanisms: task/isolation.ts, FileLock/FileState/owned-path and workflow ledgers for VS-19.
docs/vector/build/vectorscope-upgrade.md: the upgrade contract. §0.3 lists the six items a behaviour-changing package carries, §0.5 is Never, §1 covers pipeline and route-check placement, §2 has invariants I-1..I-14, §3 the integration map, §4 the VS-23..VS-31 specs (VS-23b :422, VS-23c :430, VS-23d :440, VS-24 :450, VS-25b :517, VS-26 :534, VS-27c :588, VS-28 :602, VS-29b :645) and §5 sequencing.
docs/vector/build/vectorscope-upgrade-addendum-a.md: §1 has the new opt-in keys and their sources, §1a the replay variants and desktop halves, §2 the VS-32..VS-49 specs (VS-32 :81, VS-34 :207, VS-42 :592, VS-43 :641, VS-44 :682), :323-355 the I-8 amendment (cat-file --batch, owner Q18), and §3 the amendments to VS-12/13/18/19/26/27/28/29.
docs/vector/build/vectorscope-upgrade-addendum-b.md: §1 has the Now packages: VS-22d :102, VS-37c :132, VS-46c :185, VS-46d :206, VS-44c :229. VS-33b, VS-21e, VS-40a, VS-35b, VS-48a and VS-32b are already built. §2.1 has runner-wiring R1-R7 and §2.2 the Later items L1-L11.
docs/vector/build/vectorscope-continuation.md: the current qualified checkpoints and what each receipt does and does not prove.
docs/vector/build/vectorscope-deviations.md: dated deviation entries "## YYYY-MM-DD · VS-xx <title>". The last are VS-35b at :15891 and VS-11 physical scope at :15932. Line :16000 still says "routes and controls remain unregistered" and is stale. Every package appends an entry.
docs/vector/build/v2-scope-finish-2026-11-14.md: the latest integration repair note. Recompute the pipeline source pin after further pipeline changes. Runner Session fixtures must call the real SessionAudience.register.
docs/vector/build/v2-spawn-review.md: mandatory before touching cross-spawn-spawner.ts, task/shells.ts, core/pty.ts, tool/shell.ts, mcp/index.ts or the Windows holder. Applies to SF-08, SF-30a/b and SF-33.
script/vectorscope-eval/README.md: eval script conventions, how replay/outcomes tests run, and the VARIANTS registry rules. Halves are { pending } -> { from: "VS-xx" } plus keys.

### Invariants

I-1: every new behaviour is opt-in and off by default. With the new key unset, each runner sends byte-identical wire bodies and permission rules and returns the same outcome as before the package. The runners are engine Review.run (which the CLI and GitHub job call), the CLI, the GitHub job and the desktop's own pipeline in packages/app/src/features/pull-requests/ai-review.ts. The proof is a D3 parity test on the fake provider (the run.test.ts pattern and ReviewEval.project, engine review/eval.ts:409), never a shape-only test.

Every key-driven step lives inside Review.run and reads RunInput.config (upgrade.md §0.3 item 1). The runners read parseReviewConfig today. Only the privacy package (SF-11) switches the local surfaces to mergeReviewConfig, and with every sourced key unset its result must equal parseReviewConfig's. A key leaves UNAPPLIED_REVIEW_KEYS (core types.ts:569) and loses its warning (config.ts:235-279) only in the package that applies it. A new key may be parsed into UNAPPLIED_REVIEW_KEYS in an "a" part and removed in its "b" part. OPTIONAL_REVIEW_DEFAULTS never changes. A new key enters policyDigest/EVIDENCE_POLICY_KEYS (model-evidence.ts:80) only when set to a non-default value. New prompt text and schemas enter promptsDigest only under their key (I-12). REVIEW_PIPELINE_SOURCES (model-evidence.ts:62) is recomputed whenever a pinned file changes. The pinned list (model-evidence.test.ts:49) includes run.ts, model.ts, git.ts, service.ts, the review HttpApi group and handlers, cli/cmd/review.ts, session prompt/tools and connect/hub.ts. New pure pipeline modules join that list. REVIEW_PIPELINE_REVISION stays 4 unless a default review's findings change, and none should.

I-2: untrusted text never chooses an invocation field or acts as a verdict, and it stays in wrapped untrusted blocks. Untrusted text means PR title/body/comments/diff, commit messages, trailers, branch names, model output, MCP data, test output and Brain cards.

I-3: privacy fails closed under zdr on every transport. There is no free-model fallback and no retry on another model. The Codium plan route stays refused as codium-unaccepted: the client plan status carries no exactTagWithZdr, which exists only in api/\_lib.

I-4: redaction and the fail-closed posting guard (session/posting.ts lineage) cover everything that leaves the machine.

I-5: SessionAdmission admits every provider attempt, and a zero-token stop makes zero attempts.

I-6: project code runs only through the single per-operation consent path (createFixConsentPolicy, fix-proposal.ts:127, and the existing --checks). Consent is single-use and bound to the head SHA and the command/patch digest. Code runs in a task/isolation.ts worktree with network off (Sandbox.offline, tool/shell/sandbox.ts:252) and a clean env with no keys. It never runs for --pr, forks, untrusted reviews or CI.

I-7: incomplete, partial, zero-attempt or held-back reviews are never shown as clean.

I-8: forks and reviewed repos are read only through `git show`/`git grep` of the head tree-ish inside the private ReviewGit view (engine review/git.ts), with no live Git fallback. `git cat-file --batch` waits for the owner's Q18 and the I-8 amendment.

I-9/I-10: @vector-owned files may be edited only inside their existing interfaces. Those files are core review/workflow.ts and command.ts, engine cli/cmd/github._.ts, desktop main/github-_.ts and the GitHub docs sections. No second publisher, push route, coordinator, ledger, isolation layer (the fix worktree reuses task/isolation.ts, not a new registry), lab mapper or code reader.

I-11: the renderer never imports engine runtime, and the engine stays Node-compatible. Protocol and HttpApi changes are regenerated with `bun run generate` in packages/client (test.yml runs check:generated). The SDK is regenerated with ./packages/sdk/js/script/build.ts, config.json with the engine schema script, and the help snapshot through its snapshot test's update mode. Generated files are never hand-edited.

Local review, private Git, review memory and the fix/diagnostic executors are Linux-only. Other platforms get an explicit unavailable refusal and no ports.

Tests use only fakes, loopback servers, local bare repos (file://) and recording GitHub clients. Runner Session fixtures register SessionAudience through the real register call. No real GitHub, Slack, Stripe, model provider, relay or paid call.

Never touch tokenomics, benchmark, dataset or protected-budget files: script/vectorscope-eval/dataset.ts, dataset/, budget.ts, _bench_.ts and docs/benchmarks/. Never edit packages/engine/test/cli/review.test.ts.

The flags MODEL_PLANS_ENABLED, VECTOR_EXPERIMENTAL_CONNECT, VECTOR_EVERYWHERE_ENABLED and VECTOR_GITHUB_BRAIN_ENABLED stay off. The VectorScope UI stays behind experimental.vectorscope. The global review.privacy and review.holdback settings ship hidden (Q16).

### Lane rules, dispatch, hazards and owner gates

**Deviation entries.** Every package appends a dated entry to docs/vector/build/vectorscope-deviations.md ("## 2026-11-DD · VS-xx <title>"). The entry states:

- scope;
- the default/parity proof;
- the pin, old -> new;
- the replay variant change;
- the desktop half, or the documented difference (variant desktop half left pending with a reason);
- the tests actually run (file and pass/fail counts);
- what is NOT claimed (no paid run, no quality claim, no default change).

Wiring packages flip only the half they wire in script/vectorscope-eval/replay.ts VARIANTS (:163-265), from { pending } to { from: "VS-xx" } plus keys. The final package refreshes vectorscope-remaining.md and -continuation.md. It also appends a correcting entry for the stale deviations.md:16000 sentence, because the entries are append-only.

**Naming and commits.** Commit titles use feat(review), fix(review), test(review), feat(app), docs(scope) and chore(sdk) for regeneration. Branch scope-finish only. Commit as Vector <bot@vectordev.ai> with the Co-Authored-By and Claude-Session trailer.

**Local checks.**

- Run every bun command through ~/.tools/vector-serial.
- Run one test file at a time from its package directory: `bun test --timeout 30000 <file>`.
- Run eval-script tests from packages/script against ../../script/vectorscope-eval/<file> as test.yml does. That CI glob covers only top-level _.test.ts, and the eval tsconfig includes only top-level _.ts. A research/ script must therefore be tested from a top-level eval test or a core test, as VS-48a does with packages/core/test/review/instruction-count-script.test.ts.
- Typecheck each touched package plus the eval tsconfig (`bun tsgo -p ../../script/vectorscope-eval/tsconfig.json` from packages/engine).
- Before each push, run the full TURBO typecheck with TURBO_CACHE_DIR=<worktree>/.turbo/cache.
- Scratch goes under <scratch>/scope-finish/, with fresh XDG roots for anything that boots the engine.
- CLI tests go in NEW files (packages/engine/test/cli/review-strict.test.ts, review-fix.test.ts, review-pr-verdict.test.ts), never review.test.ts.

**CI-only tests (never run locally):** Playwright/Chromium app e2e (scope-app-validation.yml), the strace/systemd directory-identity and private-mount cases (scope-directory-identity.yml), the engine HTTP shard (review-http-regression.yml scope=shard), and the Windows/macOS legs of test.yml.

**Dispatch.** The scope-\* and review-memory-fence push triggers do not list scope-finish, and review-http-regression is dispatch-only, so dispatch each relevant workflow explicitly:

- typecheck.yml always;
- test.yml for every package that changes runtime code (it is the only workflow that runs engine run.test.ts, provider and app unit files, plus the top-level eval tests). For docs-only or eval-only packages it may be batched with the next runtime package to spare the shared runner queue;
- scope-directory-identity.yml for any packages/{core,engine}/src/review/** or engine test/review/** change;
- review-memory-fence.yml when run.ts, model.ts or session/llm.ts change;
- review-http-regression.yml (scope local) when the review HttpApi group/handler or review service changes;
- scope-app-validation.yml when packages/app VectorScope code changes;
- vector-at-mention.yml for any core review/\*_ or engine cli/cmd/github_.ts change. It runs packages/core test/review/_.test.ts and engine test/cli/github_.test.ts.

**Cross-lane hazards.**

- The connect-finish lane edits files in the pipeline pin (connect/hub.ts, adapters/vectorscope.ts), so pins conflict on merge. Recompute the pin after every merge of main.
- The brain-transport lane (@vector V27 runtime) edits github.bundle.ts and github.publish.ts. Do not start SF-41 without the lead's go.
- The codium-finish lane owns the plan-status protocol.

**Owner gates.** No package enables a key, approves a model, adds a GitHub App permission, names an MCP server, publishes, uses cat-file --batch, or runs vectorscope-eval in paid mode or on benchmark cases. Anything that needs one of those stops at the gate and records it.

- Owner-gated (never do it or decide it; build so either answer stays possible): Any default change, and enabling any key: trivial, maxInputTokens, impact, guardrail, scopeGate, verifyEvidence, ruleCheck, depth, lenses, cards, holdback, privacy, the batch key, diagnostics, inversion. VS-31 precise mode and a REVIEW_PIPELINE_REVISION default bump need a held-out D2 pass and owner approval. | Formal approvals Q13/Q15/Q18/Q45 and D15/D16. remaining.md:4-6 already authorizes reversible software; activation is not authorized. | Q18 with the I-8 amendment: reading fork or reviewed-repo blobs with `git cat-file --batch`. SF-18 keeps git show/git grep of the head tree-ish. | D7, the protected vectorscope-eval environment with a spend-limited key; D5, the funded pilot; any paid vectorscope-eval run; funded ablations (Q9) for lenses, cards, cross-family, isolated verify and ZDR-route quality. | Zero-spend projections on benchmark or dataset cases, including VS-37c's caddy re-measure and VS-38a large-repository runs (benchmark agent). | D9: publishing the CLI to npm, MIN_AGENTS_CLI naming a published version, and the 2.0.0 version change. These are lead/owner release steps; SF-36 changes no version. | Owner-named MCP servers and resources, and any live MCP calls (D11: none in the first release). SF-29..SF-31 ship with an empty grant source. | Owner ZDR destination attestations (zdrAttested entries). | The Codium route under zdr. The client has no exactTagWithZdr acceptance field; it exists only in api/\_lib. Adding it is a hosted/protocol change for the Codium lane and owner, so SF-35 keeps Codium refused. | Q16/D14: un-hiding the global review.privacy and review.holdback settings, and any user-facing VectorScope surface beyond experimental.vectorscope. | Choice and pinning of real third-party linters and scanners for VS-18 adapters (licences, supply chain). | VS-22d dataset parts: manifest fields and strata in dataset.ts, curation, external SWR-Bench/ReviewBench/Archer data (Q36, Q27, Q31), ci.ts mirrors --with-fixes fetching, and owner adjudication. The lead also decides whether SF-06's licence classifier counts as benchmark-adjacent. | VS-35b classifier activation (an owner-repository precision sample >= 0.9) and the VS-35 marker/Brain-proposal wiring. | VS-46d owner hand labels for the audit sample; VS-46's actual owner repository and window. | The @vector owner should co-sign edits to @vector-owned files in SF-36..SF-41 (I-9). No new GitHub App permissions, ever. A new verb or reply route is the @vector owner's call. | SF-41 starts only on the lead's go, after the brain-transport (@vector V27) lane's changes to github.bundle.ts and github.publish.ts are merged. | Protected transport changes in provider.ts and session/llm.ts (SF-12a, SF-12b, SF-35), coordinated with the lead. | Whether the VS-11 remainder (review-context memory consumer, older-binary forget compatibility) and the VS-47 runner wiring / GitHub half join this lane. The v2 plan's build order puts VS-11 first, but the owner's handoff list does not name it. Lead decision. | Merging scope-finish into main (lead, via a PR after #33 merges).
- This branch starts from origin/release-finish (PR #33, the combined v2 integration). When #33 merges into main, the lead merges main into this branch; until then never merge main yourself.
- Everything ends up in main through a PR; keep commits focused and the lane docs accurate so the PR can be reviewed.

## Lead rulings already in force

### SF-07 (resolved planner blocker)

LEAD RULING ON THE SF-07 HOSTING GAP (2026-11-16): Option A is approved, with these limits. (1) Add the fix lifecycle as a separate, additive record kind (fix.json) with reserveFix/startFix/verifyFix/removeFix beside the task records in the isolation registry; do not change any existing task record, key, fence, check/reserve/start path or its behaviour, and do not seed a parent session's uncommitted or untracked files into a fix checkout. (2) The fix checkout is detached at the exact verified commit, owned by the registry's existing cleanup and stop rules; widen OwnedPath only at the type level as the plan says, with no runtime loosening for task sessions. (3) Every existing isolation, worktree and owned-path test must pass unchanged; add tests that prove task consumers never see fix records and that a fix record cannot be claimed as a task. (4) Follow docs/vector/build/v2-spawn-review.md: anything that starts a process stays behind the existing owner and single-signaller rules; no new spawn path. (5) Record the ruling and the second-lifecycle trade-off in the VectorScope deviation log. The same ruling applies to every later package that builds on the fix executor (SF-08, SF-09, SF-10a, SF-10b, SF-40, SF-41).

### SF-08 (resolved planner blocker)

LEAD RULING ON THE SF-07 HOSTING GAP (2026-11-16): Option A is approved, with these limits. (1) Add the fix lifecycle as a separate, additive record kind (fix.json) with reserveFix/startFix/verifyFix/removeFix beside the task records in the isolation registry; do not change any existing task record, key, fence, check/reserve/start path or its behaviour, and do not seed a parent session's uncommitted or untracked files into a fix checkout. (2) The fix checkout is detached at the exact verified commit, owned by the registry's existing cleanup and stop rules; widen OwnedPath only at the type level as the plan says, with no runtime loosening for task sessions. (3) Every existing isolation, worktree and owned-path test must pass unchanged; add tests that prove task consumers never see fix records and that a fix record cannot be claimed as a task. (4) Follow docs/vector/build/v2-spawn-review.md: anything that starts a process stays behind the existing owner and single-signaller rules; no new spawn path. (5) Record the ruling and the second-lifecycle trade-off in the VectorScope deviation log. The same ruling applies to every later package that builds on the fix executor (SF-08, SF-09, SF-10a, SF-10b, SF-40, SF-41).

### SF-09 (resolved planner blocker)

LEAD RULING ON THE SF-07 HOSTING GAP (2026-11-16): Option A is approved, with these limits. (1) Add the fix lifecycle as a separate, additive record kind (fix.json) with reserveFix/startFix/verifyFix/removeFix beside the task records in the isolation registry; do not change any existing task record, key, fence, check/reserve/start path or its behaviour, and do not seed a parent session's uncommitted or untracked files into a fix checkout. (2) The fix checkout is detached at the exact verified commit, owned by the registry's existing cleanup and stop rules; widen OwnedPath only at the type level as the plan says, with no runtime loosening for task sessions. (3) Every existing isolation, worktree and owned-path test must pass unchanged; add tests that prove task consumers never see fix records and that a fix record cannot be claimed as a task. (4) Follow docs/vector/build/v2-spawn-review.md: anything that starts a process stays behind the existing owner and single-signaller rules; no new spawn path. (5) Record the ruling and the second-lifecycle trade-off in the VectorScope deviation log. The same ruling applies to every later package that builds on the fix executor (SF-08, SF-09, SF-10a, SF-10b, SF-40, SF-41).

### SF-10a (resolved planner blocker)

LEAD RULING ON THE SF-07 HOSTING GAP (2026-11-16): Option A is approved, with these limits. (1) Add the fix lifecycle as a separate, additive record kind (fix.json) with reserveFix/startFix/verifyFix/removeFix beside the task records in the isolation registry; do not change any existing task record, key, fence, check/reserve/start path or its behaviour, and do not seed a parent session's uncommitted or untracked files into a fix checkout. (2) The fix checkout is detached at the exact verified commit, owned by the registry's existing cleanup and stop rules; widen OwnedPath only at the type level as the plan says, with no runtime loosening for task sessions. (3) Every existing isolation, worktree and owned-path test must pass unchanged; add tests that prove task consumers never see fix records and that a fix record cannot be claimed as a task. (4) Follow docs/vector/build/v2-spawn-review.md: anything that starts a process stays behind the existing owner and single-signaller rules; no new spawn path. (5) Record the ruling and the second-lifecycle trade-off in the VectorScope deviation log. The same ruling applies to every later package that builds on the fix executor (SF-08, SF-09, SF-10a, SF-10b, SF-40, SF-41).

### SF-10b (resolved planner blocker)

LEAD RULING ON THE SF-07 HOSTING GAP (2026-11-16): Option A is approved, with these limits. (1) Add the fix lifecycle as a separate, additive record kind (fix.json) with reserveFix/startFix/verifyFix/removeFix beside the task records in the isolation registry; do not change any existing task record, key, fence, check/reserve/start path or its behaviour, and do not seed a parent session's uncommitted or untracked files into a fix checkout. (2) The fix checkout is detached at the exact verified commit, owned by the registry's existing cleanup and stop rules; widen OwnedPath only at the type level as the plan says, with no runtime loosening for task sessions. (3) Every existing isolation, worktree and owned-path test must pass unchanged; add tests that prove task consumers never see fix records and that a fix record cannot be claimed as a task. (4) Follow docs/vector/build/v2-spawn-review.md: anything that starts a process stays behind the existing owner and single-signaller rules; no new spawn path. (5) Record the ruling and the second-lifecycle trade-off in the VectorScope deviation log. The same ruling applies to every later package that builds on the fix executor (SF-08, SF-09, SF-10a, SF-10b, SF-40, SF-41).

### SF-40 (resolved planner blocker)

LEAD RULING ON THE SF-07 HOSTING GAP (2026-11-16): Option A is approved, with these limits. (1) Add the fix lifecycle as a separate, additive record kind (fix.json) with reserveFix/startFix/verifyFix/removeFix beside the task records in the isolation registry; do not change any existing task record, key, fence, check/reserve/start path or its behaviour, and do not seed a parent session's uncommitted or untracked files into a fix checkout. (2) The fix checkout is detached at the exact verified commit, owned by the registry's existing cleanup and stop rules; widen OwnedPath only at the type level as the plan says, with no runtime loosening for task sessions. (3) Every existing isolation, worktree and owned-path test must pass unchanged; add tests that prove task consumers never see fix records and that a fix record cannot be claimed as a task. (4) Follow docs/vector/build/v2-spawn-review.md: anything that starts a process stays behind the existing owner and single-signaller rules; no new spawn path. (5) Record the ruling and the second-lifecycle trade-off in the VectorScope deviation log. The same ruling applies to every later package that builds on the fix executor (SF-08, SF-09, SF-10a, SF-10b, SF-40, SF-41).

### SF-41 (resolved planner blocker)

LEAD RULING ON THE SF-07 HOSTING GAP (2026-11-16): Option A is approved, with these limits. (1) Add the fix lifecycle as a separate, additive record kind (fix.json) with reserveFix/startFix/verifyFix/removeFix beside the task records in the isolation registry; do not change any existing task record, key, fence, check/reserve/start path or its behaviour, and do not seed a parent session's uncommitted or untracked files into a fix checkout. (2) The fix checkout is detached at the exact verified commit, owned by the registry's existing cleanup and stop rules; widen OwnedPath only at the type level as the plan says, with no runtime loosening for task sessions. (3) Every existing isolation, worktree and owned-path test must pass unchanged; add tests that prove task consumers never see fix records and that a fix record cannot be claimed as a task. (4) Follow docs/vector/build/v2-spawn-review.md: anything that starts a process stays behind the existing owner and single-signaller rules; no new spawn path. (5) Record the ruling and the second-lifecycle trade-off in the VectorScope deviation log. The same ruling applies to every later package that builds on the fix executor (SF-08, SF-09, SF-10a, SF-10b, SF-40, SF-41).

### SF-06 (resume note)

LEAD RULING ON YOUR EARLIER BLOCKER (2026-11-16): part 1 (the licence classifier, script/vectorscope-eval/research/licences.ts and its test) is DROPPED. It is dataset and benchmark-adjacent, and the owner's rules keep dataset and benchmark work out of this finish. Do not build it. Finish part 2 (the narrative-invariance recording test) so the package is done when the part-2 test passes, and add a short deviation entry that lists part 1 as excluded by the lead with this reason.

## Remaining package briefs

### SF-16: VS-24 part a: trivial zero-token skip in Review.run

**Spec:** upgrade.md VS-24 implementation items 1-3 (:450-471); remaining.md VS-24 row; the v2 plan wiring table. The pure classifyTrivial exists (core trivial.ts:114, with parse-based comment ranges through engine review/parse.ts).

**Skip.** Under trivial: "skip" only, when every changed file is trivial, Review.run returns a zero-attempt outcome with skip reason "trivial" and its note.

- Only RunInput.forceFull (review-full) bypasses it.
- Never trivial: sensitive paths, CI files, manifests and lockfiles, config, SQL and migrations.
- Parse through the private Git view (head tree-ish).

**GitHub.** The GitHub job calls Review.run, so a base review.json with trivial: skip reaches it now. It must render "not reviewed / policy skip", never a pass, and must not record the head as reviewed. SF-38 adds the decideSkip state; add a github.review.test.ts case or keep GitHub refusing the key until SF-38, and record the choice.

**Bookkeeping.**

- Remove trivial from UNAPPLIED_REVIEW_KEYS and drop its warning.
- Add it to EVIDENCE_POLICY_KEYS, default-stable.
- Flip the engine:trivial-skip engine half.
- Desktop half: the same pure call in ai-review.ts, or a documented difference.

**Tests** (run.test.ts):

- zero attempts on the observer for a trivial change;
- forceFull bypass;
- each trivial-looking bug fixture is still reviewed: directive comment, Python indentation, .mdx component, requirements.txt bump, import-breaking rename, case-only rename;
- D3 parity with the key unset;
- a format golden says "Not reviewed" or policy skip, never "No issues found".

**Done:** tests, typecheck, pin, deviation entry.

### SF-17: VS-24 part b: pre-dispatch estimate, staged shrink and maxInputTokens

**Spec:** upgrade.md VS-24 item 4 (:472-486); addendum-a.md VS-40 (estimate v2 recorded only; VS-40a is built); the core dispatch.ts header (gate on the legacy LOW estimate and first-turn tokens only). Depends on SF-16.

**Gate.** In Review.run, when maxInputTokens > 0 or a dollar cap applies under the opt-in:

- build every planned pass's first prompt before the specialists fan out (run.ts :838-890);
- estimate with decideDispatch (dispatch.ts:215);
- shrink in order: lenses, cards, the lowest-ranked dependents, then trim the diff to changed hunks with partial-coverage notes. The lenses, cards and dependents levers are no-ops until SF-25, SF-26 and SF-18 register them;
- if still over, stop with partial: "budget-estimate", zero attempts, every file unreviewed, "Not reviewed".

Token caps cover free, plan and local models. The high band and v2 go only into notes and artifacts. Record each shrink step in the replay artifact.

**Bookkeeping.** Remove maxInputTokens from UNAPPLIED_REVIEW_KEYS. Desktop: documented difference (no dollar cap).

**Tests** (run.test.ts):

- zero attempts on the observer for the budget stop;
- shrink notes and order;
- free and local models are counted;
- D3 parity with the keys unset;
- default maxSteps;
- core dispatch tests unchanged.

**Done:** tests, typecheck, pin, deviation entry.

### SF-18: VS-25 impact slice wiring through the private Git view

**Spec:** upgrade.md VS-25b implementation items 1-8 (:517-528); addendum-a.md VS-36..38 (inside impact: graph) and §3 VS-25 notes; remaining.md VS-25 row ('safe Git object port; parser scheduling decision'). The builder exists in engine review/impact.ts (Git.Service reads at :147/:165/:183), core impact.ts and parse.ts.

**Git reads.** Move every builder read, including SF-01's sibling reads, to the bound private view (engine review/git.ts: ReviewGit.client and ReviewGit.within) with no live Git fallback. Keep reading with `git show --no-textconv` and `git grep` of the head tree-ish. Do NOT switch to `git cat-file --batch`: that needs the owner's Q18 and the I-8 amendment (addendum-a.md:334). Record the parser scheduling decision in the deviation entry: in-process with the existing time and size caps, or off-main-thread.

**Under impact: "graph" only, Review.run:**

- builds the slice and sends it as <untrusted_impact>;
- orders the diff by impact rank before budgetDiff;
- lists over-budget files as not reviewed;
- records ImpactSlice.locations, stages and ms in the eval artifact;
- registers the 'dependents' shrink lever for SF-17.

An incomplete impact slice is context, never coverage.

**Bookkeeping.** Remove impact from UNAPPLIED_REVIEW_KEYS and flip the engine:impact-graph engine half. The desktop half stays a documented difference.

**Tests:**

- run.test.ts: the wire body carries the block only under the key;
- D3 parity unset;
- a fork is read through the head tree-ish;
- no read outside the reviewed tree;
- a timeout gives an incomplete note, not partial coverage;
- the existing impact.test.ts stays green.

**Done:** typecheck; scope-directory-identity.yml and test.yml green; pin; deviation entry.

### SF-19: VS-27c part a: strict guardrail in the runner

**Spec:** upgrade.md VS-27c (:588-597); addendum-a.md §3 VS-27 amendments and addendum-b.md R4 (the omitted-finding sentence); remaining.md VS-27 row. The pure strictSelect exists (core guardrail.ts:372).

**Under guardrail: "strict":**

- shared verify with all, blocking minimum severity, no nits;
- the strict prompts define the five classes and ask for a failure block and quotes. They enter promptsDigest only under the key;
- Review.run reads the head and base blobs that strictBlobRequests names, through the private Git view;
- it runs strictSelect after verify, at select (run.ts :1055);
- it sets ReviewOutcome.strict (StrictResult), with complete false whenever any stage, verify or coverage did not finish;
- wording: empty-complete "No verified production-breaking issues", empty-incomplete "Review incomplete";
- the R4 omitted-finding sentence goes in format.ts only under strict, with counts summed from dropped[].count;
- artifacts record the pre-guardrail candidates in the shape the existing report.ts --reselect strict (reselectRun) already reads.

GitHub posts strict findings through the existing path.

**Bookkeeping.** Remove guardrail from UNAPPLIED_REVIEW_KEYS and flip the engine:guardrail-strict engine half.

**Tests** (run.test.ts):

- an unreadable verdict fails closed;
- an incomplete review is never clean;
- strict JSON validates against STRICT_RESULT_JSON_SCHEMA;
- D3 parity and a byte-identical summary with the key unset;
- the recorded artifact is accepted by report.ts reselectRun.

**Done:** typecheck, pin, deviation entry.

### SF-20: VS-27c part b: StrictResult in CLI JSON and the desktop half

**Spec:** upgrade.md VS-27c items 3-5 and I-14 (StrictResult goes inside the existing vector review --json outcome, with no new flag). Depends on SF-19. report.ts --reselect strict already exists from VS-27b (report.ts:121-222), so do not rebuild it; only extend its test with an artifact produced by SF-19.

**CLI.** In packages/engine/src/cli/cmd/review.ts, include StrictResult in the existing --json outcome only under guardrail: strict. Human output uses the strict wording.

**Desktop.** In app ai-review.ts, run the same pure strictSelect where it runs the guardrail. The S6 parse check is engine-only, which is a documented difference. Otherwise record the difference and leave the desktop half pending. Flip the engine:guardrail-strict desktop half accordingly.

**Tests:**

- a NEW packages/engine/test/cli/review-strict.test.ts (never review.test.ts): the JSON shape under the key, and byte-identical JSON unset;
- app ai-review.test.ts parity;
- script/vectorscope-eval/report.test.ts: reselect on an SF-19-shaped artifact.

**Done:** tests, engine/app/eval typecheck, pin (review.ts is pinned), deviation entry.

### SF-21: VS-42 wiring: introduced-by-change gate under strict

**Spec:** addendum-a.md VS-42 (:592-640) design items 2-4 and Window ('runner-wiring: the prompt clause and the scope schema field reaching the model, with VS-27c'); addendum-b.md R5. Depends on SF-19.

**Under scopeGate: "introduced" AND guardrail: "strict" only:**

- add the prompt clause "do not report bugs that exist at the merge-base unless this change makes them reachable or worse";
- add the scope schema field to the strict report schema. Both the clause and the field enter promptsDigest only under the key;
- apply strictSelect's S9 drop with preExistingSuspect (guardrail.ts:169), using base and head blobs from the private Git view;
- record the omitted-finding and drop evidence;
- R5: local eval artifacts record pre-existing drops (path, base span, class, base SHA, fingerprint), never GitHub state or markers.

scopeGate without strict is ignored with the existing parser note; test that. A pre-existing guess is never a suppression outside S9.

**Bookkeeping.** Remove scopeGate from UNAPPLIED_REVIEW_KEYS and flip the engine:scope-introduced engine half. The desktop half follows SF-20 or is a documented difference.

**Tests** (run.test.ts):

- the wire body carries the clause and field only under both keys;
- the S9 drop is counted in dropped;
- the artifact drop record;
- D3 parity.

**Done:** typecheck, pin, deviation entry.

### SF-22: VS-43 wiring: ruleCheck key and rule citation gate

**Spec:** addendum-a.md VS-43 (:641-690) design items 1-7 and Window ('runner-wiring: the config parse, the schema switch under strict, the prompt clauses, the rule-unverified drop in select.ts and the desktop half'); the §1 keys table (ruleCheck: off|strict, no env). The "strict" here is ruleCheck's own value, so this does not depend on guardrail: strict (SF-19). The pure ruleCited and trustedRules exist (core citation.ts:137/:109). ruleCheck is not parsed today.

**Key.** Add ruleCheck with OPTIONAL_REVIEW_DEFAULTS off, read from review.json at base or the trusted global config only, and a policy key that is default-stable.

**Under ruleCheck: "strict":**

- the rule field becomes the structured {source, quote, lines?};
- propagate the exact trusted rule blocks Review.run sent (prompt.ts trusted(), after clipping, with rulesSource) to the citation gate;
- add the prompt clause "cite a rule only by quoting its smallest supporting line range; never raise a finding solely because a rule file exists" (promptsDigest only under the key);
- drop, or strip the rule claim from, findings that fail as rule-unverified in select.ts;
- a citation never raises a finding;
- scoped (VS-48) sources stay unavailable.

**Variant.** Flip the engine:rule-strict engine half. On the desktop, ai-review.ts calls ruleCited on its trusted rules, or the difference is recorded.

**Tests:**

- run.test.ts and app ai-review.test.ts D3 parity;
- a head-added quote never passes in base-branch runs;
- the rule-unverified drop;
- the config parse rejects env and working-tree sources.

**Done:** typecheck, pin, deviation entry.

### SF-23: VS-44 wiring: certificate-backed verification under strict

**Spec:** addendum-a.md VS-44 (:682-731) and Window ('runner-wiring: the prompt, with VS-27c'); remaining.md VS-44 row (blind verification, individually admitted calls). Depends on SF-19.

**Under verifyEvidence: "certificate" AND guardrail: "strict" only**, the verify pass (run.ts :892-950):

- uses the certificate prompt and verifyCertJsonSchema (promptsDigest only under the key);
- uses blind inputs: no reviewer body or suggestion;
- has every verify attempt admitted by SessionAdmission.

strictSelect counts a confirmed finding as verified only when certified() (guardrail.ts:212) holds. An unreadable certificate fails closed and marks the review incomplete. verifyEvidence without strict is ignored with the parser note; test that.

**Bookkeeping.** Remove verifyEvidence from UNAPPLIED_REVIEW_KEYS and flip the engine:verify-cert engine half. The desktop half follows SF-20 or is a documented difference. Isolated-per-finding verify (R3, verify-isolated) is NOT wired here.

**Tests** (run.test.ts):

- the certificate schema is on the wire only under both keys;
- an uncertified confirmation is dropped;
- an unreadable certificate gives incomplete;
- D3 parity.

**Done:** typecheck, pin, deviation entry.

### SF-24: VS-28 part a: automatic depth from the risk band

**Spec:** upgrade.md VS-28 items 1-2 and 4 (:602-627); addendum-a.md VS-39 and the §3 VS-28 amendments (effective depth recorded, an explicit depth that cannot run fails loudly, raise-only); remaining.md VS-28 row. The pure riskOf (risk.ts:159) and planDepth (plan.ts:126) exist.

**Inputs under depth: "auto".** Compute risk features from:

- the diff;
- safe, bounded history facts through the private Git view. riskOf records which features were available; CI has no history;
- isSensitivePath;
- test-file changes;
- the impact dependents count when SF-18's slice is available.

**Passes by band:**

- low: review, plus security only on a sensitive path;
- medium: review and security;
- high: review and security, with lenses only via SF-25.

Depth is raise-only and never lower than today's security rule for sensitive paths. Record the effective depth and plain-language reasons in the notes. Risk never feeds Selection.risk or the header's Risk line.

**Bookkeeping.** Remove depth from UNAPPLIED_REVIEW_KEYS and flip the engine:depth-auto engine half. The desktop half is a documented difference.

**Tests** (run.test.ts):

- band -> passes;
- inputs with history missing;
- the same band across surfaces for the same inputs;
- D3 parity with the key unset;
- cost notes.

**Done:** typecheck, pin, deviation entry.

### SF-25: VS-28 part b: bounded parallel single-class lens sessions

**Spec:** upgrade.md VS-28 items 3-4: lenses take at most 5 steps and 4 findings each on the review model, at most 3 run in parallel, results go through union, dedup and verify, then the guardrail, and a review has at most 8 sessions. I-4: the fail-closed posting guard in session/posting.ts lineage. addendum-b.md L4 is NOT built. Depends on SF-24.

**Under lenses: "high" with depth: "auto" and band high only:**

- run REVIEW_LENSES (concurrency, resource, access, data-integrity) as internal vectorscope.\* sessions on the review model;
- use the lens prompts (buildLensPrompt; promptsDigest only under the key);
- each session is admitted, with bounded concurrency 3;
- findings are unioned, deduped, and sent through verify and the guardrail;
- register the 'lenses' lever as the first shrink in SF-17.

lenses without depth: auto is ignored with the parser note.

**Bookkeeping.** Remove lenses from UNAPPLIED_REVIEW_KEYS and flip the engine:lenses-high engine half. The desktop half is a documented difference.

**Tests** (run.test.ts):

- parallel runs bounded at 3;
- union and dedup;
- findings verified before the guardrail;
- the 8-session bound and the lineage-bound refusal;
- the lens is dropped first by the budget shrink;
- D3 parity.

**Done:** typecheck, pin, deviation entry.

### SF-26: VS-26 Brain context cards for local CLI reviews

**Spec:** upgrade.md VS-26 (:534-561); addendum-a.md §3 VS-26 (base-config files.json-style card source, base-SHA artifact, cost criterion); v2 plan §4 table. Depends on SF-11 for the zdr route rule.

**Key.** cards: off|brain, with OPTIONAL_REVIEW_DEFAULTS off and a policy key that is default-stable.

**Gatherer** in engine packages/engine/src/review/context.ts, beside requirements (:224):

- use only read-only BrainKnowledge.links (weight >= 0.6, drift flags) and search (changed symbols and paths, limit 3); never brief;
- dedupe by id, with anchored cards above lexical hits;
- at most 3 cards, 160 chars each, 200 tokens in total; linked requirements count toward this;
- personal items only when the review is not shared, the model does not train on prompts, and, under zdr, the route is ZDR or loopback;
- untrusted reviews get repository-scoped kinds only.

Core prompt.ts gets <untrusted_context_cards> (promptsDigest only under the key). Register the 'cards' shrink lever for SF-17.

**Scope.** Local CLI only. GitHub/CI cards wait for VS-11 and the nightly artifact (not this lane). The desktop is a documented difference.

**Tests:**

- packages/engine/test/review/knowledge.test.ts: limits and the personal-item rules;
- core prompt.test.ts;
- a posting-guard test with a card quoted in a finding;
- 0 personal items in shared reviews;
- a local-only eval with a Brain seeded from base-commit documents, built from synthetic in-test documents rather than dataset cases;
- D3 parity.

**Done:** typecheck, pin, flip the engine:cards-brain engine half, deviation entry. The key stays off (funded ablation, Q9).

### SF-27: VS-19 part a: durable large-PR batch plan and cursor (core)

**Spec:** vectorscope-plan.md VS-19 row (:329) and the reuse table (VS-19 may reuse workflow run state and WorkflowLedger scoping under a fixed trusted spec; it must not add a second ledger); upgrade.md §4 re-scope (batches by VS-25 impact clusters and VS-28 depth); addendum-a.md §3 VS-19 (VS-39 density order); remaining.md VS-19 row.

**Key.** Add an off-by-default key; record its name in the deviation entry, e.g. largeChanges: "skip" | "batch". The existing size skips remain the default. Add it to UNAPPLIED_REVIEW_KEYS until SF-28.

**Pure core:**

- packages/core/src/review/plan.ts: a batch planner ordered by risk.ts density, using impact clusters when present;
- state.ts: a durable cursor (batch ids, head SHA, covered files);
- types.ts and skip.ts: coverage fields.

**Behaviour:**

- deterministic batches under maxFiles, maxChangedLines and maxDiffChars;
- exactly-once cursor advance;
- a head change invalidates the cursor;
- the cross-batch context summary is trusted-derived data only;
- coverage accounting never turns incomplete into clean (I-7).

No runner call yet.

**Tests** (core plan, state and skip tests):

- exactly-once batches;
- head invalidation;
- cap exhaustion;
- partial coverage;
- deterministic order;
- cursor tamper: an unknown or forged state is refused.

**Done:** core typecheck, pin, deviation entry.

### SF-28: VS-19 part b: run large-PR batches in Review.run

**Spec:** as SF-27; I-5 and I-7. Depends on SF-27, and uses SF-18 and SF-24 when their keys are set.

Under the SF-27 key only, Review.run replaces the too-large skip with the batch plan:

- review one batch per run, or a bounded number per run, with each pass admitted;
- persist the cursor through the existing review state;
- carry the cross-batch context;
- mark remaining files unreviewed with the existing partial-coverage note;
- never record the head as reviewed until every batch has completed on the same head;
- a head change restarts from a fresh plan.

**Bookkeeping.** Remove the key from UNAPPLIED_REVIEW_KEYS. The CLI shows batch progress. The desktop is a documented difference. GitHub job persistence goes through ReviewState only if no @vector-owned file change is needed; otherwise record it as a GitHub-half follow-up.

**Tests** (run.test.ts):

- exactly-once across two runs with a recorded cursor;
- head-change invalidation;
- cap exhaustion leaves partial, not clean;
- a cross-file defect spanning batches gets the context summary;
- D3 parity with the key unset (the too-large skip is unchanged).

**Done:** typecheck, pin, deviation entry.

### SF-29: VS-14 part a: default-deny MCP review broker policy

**Spec:** vectorscope-plan.md 'MCP support without PR-driven egress' and the VS-14 row (:324); remaining.md VS-14 row. D11: no live local calls in the first release and no approved server by default.

**Broker.** New engine packages/engine/src/review/mcp.ts. Pure policy parts may live in core review/permission.ts or a new core module.

- Grants are keyed by owner + repository/context + server.
- A grant records the server identity, transport endpoint, tool/resource schema hashes and a capability hash.
- Only explicitly selected read capabilities are granted. readOnlyHint and tool names never grant.
- Unknown or possibly-writing tools are denied.
- Any schema, endpoint or capability change invalidates the grant.
- Untrusted (PR) reviews get no live model-controlled calls at all.
- Trusted local live reads stay disabled by a hard-off constant per D11: the broker returns unavailable.

Grants come only from an injected trusted source that defaults to empty: no persistence, no UI, no named servers in this lane. The audit records identifiers and hashes, never query data. Core permission.ts keeps `read mcp:*` denied (:101-103). This package does not touch mcp/index.ts.

**Tests** in a new packages/engine/test/review/mcp.test.ts with an in-process fake MCP server:

- a missing grant;
- an unknown write tool;
- fake annotations;
- a changed schema or endpoint;
- the token never reaches model tools;
- the alternate read mcp:\* path is denied;
- the audit has no raw arguments.

**Done:** engine/core typecheck, pin if pinned files change, deviation entry.

### SF-30a: VS-14 part b1: filter MCP listings, instructions and prompts for review sessions

**Spec:** vectorscope-plan.md 'MCP support...' paragraphs on instructions, prompts and resource listings; remaining.md VS-14 row. Depends on SF-29.

Read docs/vector/build/v2-spawn-review.md first: engine mcp/index.ts (1409 lines) is a spawn hot spot. Do not change process ownership or spawning.

For every vectorscope.\* session, consult the broker at tool listing in the existing MCP lifecycle. Filter server instructions, prompts and resource listings before they reach the agent: a server with zero tools must not be able to inject through the system-prompt instructions path. Non-review sessions are byte-identical.

**Tests:**

- engine MCP lifecycle tests plus review/mcp.test.ts with the fake server;
- a zero-tool server's instructions are filtered;
- listings are filtered;
- ordinary sessions are unchanged (snapshot of listed tools and instructions).

**Done:** engine typecheck, test.yml green, deviation entry.

### SF-30b: VS-14 part b2: execution-time MCP enforcement, nested tools and reconnects

**Spec:** vectorscope-plan.md 'MCP support...' paragraphs on execution-time enforcement, nested subagents and plugin tools. Depends on SF-30a. Spawn hot spot rules as in SF-30a.

For vectorscope.\* sessions:

- consult the broker again at tool execution, so a call denied at listing stays denied even when listing is bypassed;
- deny nested subagents and plugin-exposed MCP tools;
- resource redirects and reconnects re-check the grant;
- cancellation stops pending calls.

**Tests:**

- execution is still denied when listing is bypassed;
- a reconnect with a changed schema is refused;
- a redirect is refused;
- the nested-subagent path is denied;
- the plugin MCP tool is denied;
- cancellation;
- ordinary sessions are unchanged.

**Done:** engine typecheck, test.yml green, deviation entry.

### SF-31: VS-15 pre-exposure bounded MCP snapshots

**Spec:** vectorscope-plan.md 'MCP support...' (snapshots before PR exposure, fixed owner-selected arguments) and the VS-15 row (:325); remaining.md VS-15 row. Depends on SF-29 and SF-30b.

**Broker operation.** Before any PR text is exposed to a session, it takes explicitly authorized, bounded snapshots from owner-selected resources:

- arguments are fixed and come from trusted configuration only. No PR title, body, diff, comments, model queries or derived identifiers appear in any request;
- size and time bounds apply;
- results are wrapped as untrusted data blocks;
- after exposure, the broker refuses every outbound MCP call for that invocation;
- dynamic discovery and resource expansion are disabled;
- a server that cannot snapshot safely is unavailable, with an explicit note.

It is off by default. The snapshot list comes from the same injected trusted grant source, which is empty.

**Tests** (broker instrumentation with the fake server):

- zero PR- or model-influenced arguments;
- zero post-exposure calls;
- injection attempts via query, URI, cursor and comments;
- nested tools, retries, redirects and reconnects;
- cancellation;
- an unsupported server fails closed with the note.

**Done:** typecheck, pin if pipeline files change, deviation entry. Real resources wait for owner-named servers.

### SF-32: VS-18 part a: offline secret and dependency diagnostics evidence lane

**Spec:** vectorscope-plan.md VS-18 row (:328); upgrade.md §4 re-scope (the code-running half moved to VS-30); addendum-a.md §3 VS-18: offline pinned secret and dependency scanning as evidence lanes the model filters, sharing VS-34's scanner (core holdback.ts and brain/scan.ts).

**Module.** New engine packages/engine/src/review/checks.ts, with an off-by-default key whose name the deviation entry records, e.g. diagnostics: off|offline. It runs in-process only: no subprocess, no network, no telemetry.

- a secret scan of changed lines using the shared scanner;
- pinned offline dependency-manifest rules, e.g. a manifest changed without its lockfile, or lockfile integrity fields removed.

**Evidence.** It produces typed evidence with provenance in core (finding provenance and dedup fields), which the model filters as untrusted-derived evidence. Output is always redacted: never print a discovered secret. Dedup against model findings. The key goes into UNAPPLIED_REVIEW_KEYS until the Review.run hook lands in this same package; then remove it. Linux only for the engine hook; refuse elsewhere.

**Tests:**

- a new packages/engine/test/review/checks.test.ts and core tests;
- secret redaction: the value never appears in output or a wire body;
- a malicious repository config cannot change the rules;
- no network (loopback guard);
- dedup with a model finding;
- cancellation;
- D3 parity with the key unset.

**Done:** typecheck, pin, deviation entry.

### SF-33: VS-18 part b: pinned diagnostic adapter contract on the isolated executor

**Spec:** vectorscope-plan.md VS-18 row ('Treat runner isolation as a prerequisite for executing project code; unsupported CI reports unavailable diagnostics'); I-6. Read docs/vector/build/v2-spawn-review.md. Depends on SF-08 and SF-32.

**Contract** for pinned linters and scanners:

- an exact tool version and digest;
- fixed argv;
- no repository-provided plugins or configs are loaded unless the adapter declares them safe;
- network off, clean env;
- output caps and redaction.

Adapters execute only through the SF-08 isolated executor, with per-operation consent. Unsupported platforms and missing isolation return "diagnostics not run" with a reason. Ship the contract with a fake adapter used only in tests. Choosing and pinning real third-party tools is owner-gated (licences, supply chain) and recorded as such.

**Tests:**

- the fake adapter cannot read keys;
- it cannot reach the network;
- a malicious config or script in the fixture repo is not executed outside the sandbox;
- consent is required per run;
- output is redacted and capped;
- cancellation and cleanup.

**Done:** typecheck, deviation entry.

### SF-34: VS-29b trusted local authorship inversion

**Spec:** upgrade.md VS-29b (:645-656); addendum-a.md §3 VS-29 (29b stays a local opt-in, and detection signals are untrusted); remaining.md VS-29 row (reuse the existing Codium lab API, no duplicate lab mapper). Reuse core model-lab.ts labOf (:94) and review/second-lab.ts labOfModel (:31). Depends on SF-11 and SF-15: the alternate model comes from the trusted global config, and both models must pass VS-23.

**Author module.** New engine packages/engine/src/review/author.ts. It reads only trusted local provenance:

- V2 Assistant.model with snapshot.files for the changed files (packages/schema session-message);
- desktop parallel-workspace records.

PR body lines, commit trailers and branch names are recorded as claimedAuthor and never choose a model.

**Model switch.** Engine review/model.ts ResolveInput.author, under a new off-by-default local key whose name the entry records (e.g. inversion: off|local), with an owner-configured equal-tier alternate model from the trusted global config. When labOf(reviewer) equals the authoring lab, pick the alternate and name the switch in the notes. Never in GitHub or CI: there is no trusted provenance there. Both models must pass VS-23 and the no-training rule.

**Tests** (engine model and author tests):

- only trusted sources are used;
- forged trailers and PR text are ignored;
- the switch is named in the notes;
- no same-lab author -> no switch;
- CI refusal;
- D3 parity unset.

**Done:** typecheck, pin, review-memory-fence.yml green (model.ts), deviation entry.

### SF-35: VS-23/VS-33 all-route production wire audit (Codium route stays refused)

**Spec:** remaining.md VS-23/VS-33 rows ('all-route production wire audit ... native/Codium route proof'); addendum-b.md R1; upgrade.md VS-23 'Later halves'. Depends on SF-12b.

**Correction to the earlier plan.** The client cannot accept the Codium route yet. exactTagWithZdr exists only in the hosted api/\_lib (codium-reservations.ts:95, model-plan-catalog-policy.ts:123), and the client plan status (core model-plan-status.ts) carries no ZDR acceptance. Reading it would need a hosted/protocol field, which belongs to the Codium lane and the owner. This package therefore keeps decideRoute's codium-unaccepted refusal (privacy.ts:435, :533) and records the gap. It does not edit api/. MODEL_PLANS_ENABLED stays off.

**Build.** Extend the loopback fake server to speak Anthropic Messages and to record bodies from the OpenRouter SDK and @ai-sdk/openai-compatible, so the audit covers production wire formats. Add one audit test: every vectorscope.\* request kind on every transport (generic fetch, plan route, free route, native runtime) is either compliant or refused before sending.

**Tests:**

- zdr-route.test.ts audit rows;
- privacy.test.ts: Codium stays refused when a forged acceptance appears in model or PR text.

**Done:** typecheck, deviation entry naming the Codium acceptance field as the open external gate. Owner destination attestations remain external.

### SF-36: VS-05 compatible CLI reconciliation (no version change)

**Spec:** vectorscope-plan.md VS-05 row (:315); remaining.md VS-05 row: reconcile with the actual merged @vector CLI and publication status; publication is an owner release step; no moving version pin.

Re-check the generated review job's CLI pin against these:

- core review/workflow.ts cliVersionSpec (:34, used at :159, MIN check at :594);
- core github-agents.ts MIN_AGENTS_CLI (:12, currently 1.99.113);
- the readWorkflowOptions header;
- the desktop cli-too-old status (packages/desktop/src/main/github-agents.ts:344).

Make only reconciling changes that keep @vector's contracts: no second status, and no pointing workflows at an unpublished version or latest. Do NOT change MIN_AGENTS_CLI or any version string. The 2.0.0 change is the lead's step and publication is the owner's.

**Tests.** There is no core test/review/workflow.test.ts; the plan's path was wrong. Extend the files that exist:

- packages/engine/test/cli/github.workflow.test.ts (its **snapshots**/github.workflow.test.ts.snap is updated only through the snapshot update mode);
- packages/core/test/github-agents.test.ts;
- packages/desktop/src/main/github-pr.test.ts and github-agents.test.ts;
- packages/desktop/scripts/build-identity.test.ts.

Cover the release, dev and missing-publication paths.

**Done:** tests, core/engine/desktop typecheck, vector-at-mention.yml and test.yml green, deviation entry listing what remains for the owner's publication. Co-sign with the @vector owner.

### SF-37: GitHub half: privacy and holdback into the job, sessions into the posting check

**Spec:** upgrade.md §5 'After vector-at-mention merges' row (VS-23's privacy passed to GitHub model resolution, the GitHub posting check receiving outcome.sessions, REVIEW_PRIVACY in the generated workflow) and I-4 ('the GitHub job passes no session IDs': github.review.ts:1247 calls SessionPosting.headless without sessions). Depends on SF-11..SF-15.

In packages/engine/src/cli/cmd/github.review.ts, inside @vector's existing interfaces:

- switch to mergeReviewConfig({ surface: "github" }) with parity when unset;
- pass the merged privacy to review model resolution, so the CI free fallback is skipped under zdr;
- pass outcome.sessions to SessionPosting, so the fail-closed lineage check covers every contributor.

In core review/workflow.ts, only when the base review.json opts in, emit the REVIEW_PRIVACY and REVIEW_HOLDBACK passthrough. With them unset, the generated workflow is byte-identical.

**Tests:**

- engine test/cli/github.review.test.ts (recording GitHub client, fake provider): zdr refuses the free fallback with zero attempts, posting is refused when the lineage lookup fails, sessions are forwarded;
- engine test/cli/github.workflow.test.ts: the snapshot is byte-identical by default.

**Done:** typecheck, vector-at-mention.yml and test.yml green, deviation entry noting the @vector-owned files touched (co-sign).

### SF-38: GitHub half: trivial skip through decideSkip state

**Spec:** upgrade.md VS-24 'When: ... The GitHub trivial skip waits for the @vector merge (decideSkip state)' and the §5 row; the core skip.ts SkipReason "trivial" comment (:22-24). Depends on SF-16.

Under trivial: "skip", from base review.json only:

- the GitHub job records the trivial zero-attempt outcome in ReviewState through decideSkip, so re-triggers on the same head skip consistently;
- the check run and the sticky comment say not reviewed / policy skip, never a pass;
- the head is not recorded as reviewed for findings;
- review-full still bypasses.

No new GitHub permission.

**Tests:**

- core skip.test.ts;
- engine test/cli/github.review.test.ts with a recording GitHub client: the trivial-skip state round-trips, a re-trigger on the same head, a new head re-evaluates, review-full bypasses, the default config is byte-identical.

**Done:** typecheck, vector-at-mention.yml green, deviation entry.

### SF-39: GitHub half: fail-closed review verdict in the job and posting plan

**Spec:** addendum-a.md VS-32 (:81-147) and the §4 'Later, after vector-at-mention' row; addendum-b.md §1.12 (postingPlan, already built in core verdict.ts:36) and §2.2 L1/L2; remaining.md VS-32 row.

**Config.** Add the failOn value "blocking-or-incomplete" (types.ts:483), parsed from base review.json only (never env), raise-only through the source-tagged merge.

**GitHub job and the CLI --pr path:**

- store reviewVerdict in ReviewState;
- write it to $GITHUB_OUTPUT;
- exit 1 on not-reviewed, incomplete and blocking only under the new value;
- call postingPlan, so not-reviewed and policy-skip never create a PR review;
- an incomplete review gets the constant <!-- vectorscope-verdict: incomplete --> marker, only under the new value;
- put the verdict token in the check run's title and summary as well as its conclusion (L1);
- document the tokens in the GitHub docs section with the @vector owner.

Default failOn values stay byte-identical.

**Tests:**

- engine test/cli/github.review.test.ts (recording client): not-reviewed and policy-skip never call createReview, exit codes per verdict, the marker is constant and only under the new value, env cannot set it;
- core config and verdict tests;
- --pr CLI cases in a NEW packages/engine/test/cli/review-pr-verdict.test.ts, never review.test.ts.

**Done:** typecheck, vector-at-mention.yml and test.yml green, pin (cli review.ts), deviation entry.

### SF-40: VS-13 part a: bind /vector fix to the fix proposal and current authority

**Spec:** vectorscope-plan.md VS-13 row (:323) and 'Fix proposals and consent' (GitHub verifies the requester's current write access, and no fork code runs with privileged tokens); addendum-a.md §3 VS-12/13 bullet; remaining.md VS-13 row. Depends on the SF-07 contract use; the local executor is not used on GitHub.

In the existing @vector `/vector fix` path (engine cli/cmd/github.run-helpers.ts :290, :1229-1320; github.handler.ts :889-891):

- build a FixProposal (core fix-proposal.ts, FixScope github with an immutable repositoryID) for the exact addressed Vector-authored thread and the PR's exact head;
- require createFixConsentPolicy approval tied to the requester's CURRENT collaborator authority, read through existing installed permissions (no new GitHub permission);
- refuse forks, bot loops, quoted or fenced commands, duplicate delivery and replay, force-pushed or moved heads, and stale findings;
- replies go through the current redaction and posting guards.

No second verb, route or push path. A new verb or reply route is a request to the @vector owner, not this lane.

**Tests** with a recording GitHub client and @vector's route fixtures:

- revoked collaborator rights;
- a fork request;
- a bot loop;
- duplicate delivery;
- a quoted command;
- force-push;
- a stale finding;
- exact thread binding.

**Done:** typecheck, vector-at-mention.yml and test.yml green, deviation entry noting the @vector-owned files touched (co-sign).

### SF-41: VS-13 part b: execute GitHub fixes through the run bundle and publish phase

**Spec:** vectorscope-plan.md VS-13 row. GitHub execution is @vector's: the agent-phase run bundle (V18), the publish phase (V21) for apply, commit and push, and V27 session artifacts for follow-ups. Pushes happen only under V21's branch rules, on a vector/... branch. Depends on SF-40.

**Gate.** The brain-transport lane is building the @vector V27 runtime now and edits engine cli/cmd/github.bundle.ts and github.publish.ts. Start only with the lead's go, after merging that lane's head. Otherwise stop at the gate and record it.

Route an approved GitHub FixProposal into the existing agent-phase bundle (github.bundle.ts) and the publish phase (github.publish.ts):

- apply with preimage and digest checks;
- separate commit and push consent;
- push only to the consented vector/... destination branch through V21, never the base branch;
- a short-lived write credential only after approval;
- no fork code with privileged tokens;
- follow-ups through the existing session artifacts only if V27 is present; otherwise record the gap.

No new push or reply route.

**Tests** with a recording GitHub client and local bare repos:

- permission separation: apply without commit or push consent stops;
- branch-rule enforcement;
- a digest or head mismatch is refused at publish;
- no token in logs or commits;
- cancellation.

**Done:** typecheck, vector-at-mention.yml and test.yml green, deviation entry (co-sign).

### SF-42: Refresh the VectorScope inventory, continuation and final pin

**Spec:** v2-notes/vectorscope-v2-plan.md §5 item 5 ('Update vectorscope-remaining.md, -continuation.md and -deviations.md to match the head'); v2-scope-finish-2026-11-14.md ('The final aggregate must recompute its source pin').

**vectorscope-remaining.md.** Update the row for every package this lane built: what exists, what acceptance remains, and which halves are documented differences. Also:

- mark as built: VS-33b, VS-21e, VS-40a, VS-35b, VS-48a and VS-32b, plus the VS-47 pure receipt;
- correct stale entries: the VS-09 picker is closed in source (CI proof pending), the VS-12 contract exists, and the VS-11 routes and controls are registered behind experimental;
- list the external gates unchanged, including Q18/cat-file and the Codium exactTagWithZdr client field.

**Deviations.** Append a correcting deviation entry for the stale deviations.md:16000 sentence.

**Continuation.** Add a continuation checkpoint naming each package commit and the CI runs that qualified it. List only runs that actually passed.

**Pin and keys.** After merging the latest main:

- verify that REVIEW_PIPELINE_SOURCES matches the final head through core model-evidence.test.ts, and recompute it if the merge moved it;
- check that UNAPPLIED_REVIEW_KEYS lists only the keys still unwired (runtime, plus any key whose b-part stopped at a gate).

**Constraints.** No code beyond the pin, and no benchmark, dataset or tokenomics file changes. No quality, release or default claim.

**Done:** the model-evidence test passes, the docs are consistent with the head, and the lane summary deviation entry is written.

## Phase review (after SF-42)

- Base for the review diff: `0ee486e3412c29512022d369325a3747b567d090`; commit title: `fix(scope): vectorscope-finish lane review`.

Both lenses cover every package of this lane (from 0ee486e3). Check the lane documents match the code, nothing owner-gated slipped in, flags stay off by default, and the packages agree with each other.

## Done package briefs (for reference)

<details><summary>SF-01: VS-37c tier b for same-package Go outbound references</summary>

**Spec:** addendum-b.md §1.5 (VS-37c, :132-148); vectorscope-remaining.md VS-37 row.

**Problem.** Engine packages/engine/src/review/impact.ts readTargets (:1114-1180) and core packages/core/src/review/impact.ts outboundUses (:710) bind tier-b targets only to import statements. A Go change that uses a field of a type declared in a sibling .go file therefore packs 0 tokens.

**Step 1, test first.** In packages/engine/test/review/impact.test.ts, add a two-file Go package fixture (real local git repo) where a changed line uses a field of a type in the sibling file. Assert that today's tier b is empty.

**Step 2, Go only.** Resolve identifiers on changed lines against declarations in the other .go files of the same directory. Exclude \_test.go unless the changed file is a test. Read them exactly as tier b reads today: `git show --no-textconv <head>:<path>` through the existing runner, inside the 10-signature and 6k-token caps. SF-18 later moves all builder reads into the ReviewGit view, so SF-01 must not add a new read path; it reuses readTargets' runner. If the test unexpectedly passes, record why in the deviation entry and change no code. Other directory-scoped languages are listed for later, not changed.

**Constraints.** No runner calls the builder. The caddy projection re-measure in the spec's Done line runs on a benchmark case, so it is recorded as not done (benchmark agent).

**Tests:**

- the fixture;
- the caps;
- dedup against the diff and tier a;
- no read outside the reviewed tree;
- under impact: graph with packing unset, still byte-identical (existing test);
- non-Go tiered output byte-identical: a golden over the existing impact.test.ts fixtures, which only reads seed data and never edits dataset/.

**Done:** tests pass, REVIEW_PIPELINE_SOURCES pin updated, deviation entry.

</details>

<details><summary>SF-02: VS-44c isolated verification planner and pending variant</summary>

**Spec:** addendum-b.md §1.10 (VS-44c, :229-242).

**Planner.** Add pure planIsolatedVerify(calls, { k = 3 }) to packages/core/src/review/plan.ts.

- Input per candidate: { candidate, promptTokens, maxSteps, price: ReviewPrice }.
- Pick the top k blocking candidates in a deterministic order (severity, class, then path, line) for one verify call each. The rest go through the batched pass.
- Return per-call candidate lists, each with plan.ts's own estimateCostUsd (:298). Do not use dispatch.ts, which would create an import cycle.
- Inputs are blind: no reviewer body or suggestion reaches any planned call.

**Variant.** Register "verify-isolated" in script/vectorscope-eval/replay.ts VARIANTS, using the existing VariantEntry shape.

- engine half: { pending: "VS-44c wiring (R3)" };
- desktop half: pending, with the reason "VS-27 desktop guardrail".
- It must refuse with exit 2 and create nothing, like the other pending names.

No runner calls the planner; the R3 wiring is not in this lane.

**Tests:**

- packages/core/test/review/plan.test.ts: ordering and tie-breaks, k larger than the candidate count, no reviewer text in any call, estimates sum to the batched estimate at k=0;
- script/vectorscope-eval/replay.test.ts: the pending refusal.

**Done:** tests pass, core and eval typecheck pass, pin moved (plan.ts is pinned), deviation entry.

</details>

<details><summary>SF-03: VS-46c/d part a: outcome ledger schema v2 collection fields</summary>

**Spec:** addendum-b.md §1.8 'Compatibility: a ledger schema change, shared with VS-46d' and §1.9 'Compatibility and byte-identity'.

**One schema change** in script/vectorscope-eval/outcomes.ts. LEDGER_SCHEMA (:69) becomes "vectorscope-outcomes/2".

New LedgerPull fields:

- added and deleted, counted as riskFeatures counts them;
- fixesFiltered, beside the unfiltered fixes: blame with -w -M -C, skipping blank and comment-only deleted lines by a fixed per-language prefix table;
- per fix: deleted { code, blank, comment, moved };
- per fix: location { path (hashed), fn? };
- sameAgent, from trusted local records only; untrusted markers may only exclude.

New ledger-level subjects { commits, fix, revert }, taken over the base branch's first-parent history in the window.

**Compatibility.** ledgerProblem keeps refusing other schemas for collection. open() reads a /1 ledger read-only and marks every new section "unavailable: a /1 ledger has no added or deleted counts".

**Constraints.** No runner, core or digest change. Output is sealed. 0 writes on a recording GitHub client and 0 model calls.

**Tests** in script/vectorscope-eval/outcomes.test.ts, on synthetic local git histories only:

- the new fields;
- the -w and comment filter;
- a moved-lines fixture: a block moved within and across files, then fixed, is blamed on the original PR under -M -C;
- a /1 ledger opens read-only;
- the v1 sections stay byte-identical on synthetic histories;
- 0 writes.

**Done:** tests pass, eval tsconfig typecheck passes, deviation entry. The report sections are SF-04, SF-05a and SF-05b.

</details>

<details><summary>SF-04: VS-46c part b: outcome measurement rule report</summary>

**Spec:** addendum-b.md §1.8 design items 1-9. Depends on SF-03. All changes are in the script/vectorscope-eval/outcomes.ts report.

**Base rates first.** Report observed per-repository base rates (reverts, follow-up fixes, fix/revert subject shares) and the expected positives per compared band before anything else.

**Power rules.**

- Fewer than 10 expected positives in either band: report underpowered and give no verdict.
- Reverts decide only with at least 10 expected reverts in both bands. Otherwise the follow-up-fix label decides, flagged "SZZ-based, size-biased" and "unaudited".
- Print the minimum detectable effect (MDE) first.

**Capture comparison.**

- Capture at 10/20/50%, ranked by final band (the riskOf band with floors, ties broken by score), against log-size ranking and against random.
- A seeded paired bootstrap of band-minus-size.
- The count of floor-moved PRs and its MDE.
- The low-band miss rate and Effort@20%.

**Verdicts:** underpowered, beats-size, no-better-than-size, undecided. The margin is pre-registered in the report config and sealed.

**Wording and suppression.**

- Remove the word "never" from the old sentence at :1878.
- Suppress depth rows below the MDE.
- Note that reach is untested (dependents absent, :895).

**Tests:**

- synthetic histories that reach each verdict;
- a history where only floor-moved PRs differ from size;
- bootstrap determinism;
- the old sentence is absent;
- depth suppression;
- /1 ledger sections show unavailable;
- 0 writes.

**Done:** a dry run on synthetic data prints every section; deviation entry.

</details>

<details><summary>SF-05a: VS-46d part b1: audited outcome labels</summary>

**Spec:** addendum-b.md §1.9 design items 1-5 (labels half). Depends on SF-03. All changes are in the script/vectorscope-eval/outcomes.ts report.

**Audit sample.** Take a seeded sample of at least 50 positive and 50 negative matured PRs (hashed ids). Write it to a local file that is never sent anywhere.

**Label rates.**

- With owner labels, report precision and recall with Wilson intervals.
- Without them, mark every rate "unaudited".
- Report the untraceable share: fix commits with zero deleted lines.
- The filtered label is primary, with the reattribution split by whitespace, comment and move.
- Report fix-edited lines per kLOC by band.

**Tests:**

- audit determinism and stable hashed ids;
- unaudited marking with no labels file;
- Wilson intervals on a fixture labels file;
- the untraceable share;
- the reattribution split on the SF-03 moved-lines history;
- /1 ledger shows unavailable;
- 0 writes.

**Done:** a dry run prints these sections; deviation entry. The owner's hand labels stay external.

</details>

<details><summary>SF-05b: VS-46d part b2: outcome strata, dismissals, agent split and latent scoring</summary>

**Spec:** addendum-b.md §1.9 design items 6-11. Depends on SF-05a. VS-35b team.ts dismissalWhy (:45) is already built. All changes are in the script/vectorscope-eval/outcomes.ts report.

**Sections:**

- Verdict against outcome within each band and size tercile. The raw difference is shown only beside the stratified one and is labelled "confounded by size". ReviewState has no verdict until SF-39, so use a sticky-state proxy labelled as a proxy.
- Dismissal reasons by severity, through dismissalWhy.
- The addressed rate, with its definition, its population and the no-cross-population-comparison text (D12).
- The human-review rate by band.
- The agent-authored split within terciles from trusted local records, with the same-agent follow-up share.
- The descriptive recurrence share.
- Latent-forecast scoring from local eval artifacts. It prints "no drops recorded" until R5 records exist (SF-21).

**Tests:**

- a synthetic history per section;
- the stratum within band and tercile;
- agent splits only exclude;
- the proxy is labelled;
- latent scoring on a fixture artifact, and its kill rule;
- 0 writes.

**Done:** a dry run prints every section; deviation entry.

</details>

<details><summary>SF-06: VS-22d (non-dataset part): licence classifier and narrative-invariance recording test</summary>

**Spec:** addendum-b.md §1.4 items 2 ('Now: a recording test') and 5 (licence classifier, :117-122).

**Out of scope.** The rules forbid editing anything named dataset. dataset.ts, script/vectorscope-eval/dataset/, the manifest fields and strata, curation, and ci.ts mirrors --with-fixes are OUT of this package (owner or benchmark agent). The classifier exists only to admit external benchmark data, so the lead may drop part (1) as benchmark-adjacent. Ask before building it.

**(1) Licence classifier**, script/vectorscope-eval/research/licences.ts:

- classify on an SPDX-License-Identifier header, else on the licence title line, never on body keywords;
- BSD+MIT text counts as mixed;
- check at each PR's own base commit;
- run a per-path pass over bundled dirs (src/libs, third_party, vendor...);
- output {spdx, path, commit, classifierVersion}, the shape already used by the VS-48a fixture in core test/review/instruction-count-script.test.ts;
- results stay uncommitted.

The test-file location matters. The CI glob (test.yml step 'Run VectorScope eval script tests') and the eval tsconfig cover only top-level files, so a research/licences.test.ts would never run or typecheck in CI. Put the test at packages/core/test/review/licence-script.test.ts, following the VS-48a precedent, or at a top-level script/vectorscope-eval/licences.test.ts.

Tests use synthetic local repos only:

- GPL-2.0 mentioning the Library GPL;
- GPL-3.0 with its section 13 Affero mention;
- AGPL-3.0;
- an SPDX header that disagrees with the body;
- BSD bundling MIT;
- no licence file;
- a licence change between two base commits.

No network and no external benchmark data (Q36).

**(2) Narrative-invariance test.** A new packages/engine/test/review/narrative-invariance.test.ts on ReviewEval.project (eval.ts:409), with synthetic in-test cases. Across 3-5 framings with a neutral non-empty pr.body:

- the projection's scope (including the policy digest), models, pass list and maxSteps are identical;
- the wire bodies differ only inside <untrusted_pr_body>.

**Done:** both tests pass, core/engine and eval typecheck pass, deviation entry naming the excluded dataset parts.

</details>

<details><summary>SF-07: VS-12a fix executor: isolated worktree, preimage-checked apply, states and cleanup</summary>

**Spec:**

- vectorscope-plan.md 'Fix proposals and consent', row VS-12 (:322), and the reuse table (:404-405): the fix worktree uses engine task/isolation.ts (registry with Review/Merge/Discard surfaces), task/isolation-base.ts and core isolation/copy.ts. Patches go through tool/file-lock.ts FileLock, tool/file-state.ts FileState stamps (the compare-and-write preimage) and tool/owned-path.ts, never a separate writer.
- v2 plan §4 VS-12 row.
- The consent contract already exists in core packages/core/src/review/fix-proposal.ts: prepareFixProposal :91, createFixConsentPolicy :127, FIX_LIMITS, FixScope local, FixOperation apply/checks/commit/push at :54-64.

**New engine module** packages/engine/src/review/fix.ts, with states proposal -> preview -> apply. Checks, commit and push are SF-08.

- Create a detached fix worktree at the proposal's exact head through the task/isolation.ts registry, never the user's checkout.
- Do NOT use engine worktree/index.ts or any new isolation registry (I-10).
- If the registry cannot host a non-task fix worktree without a second layer, stop and record the gap for the lead.
- Re-verify the head SHA, the patch digest and every file preimage, then compare-and-write atomically.
- Refuse: symlinks, path traversal, paths outside the worktree, binary or over-limit patches, a moved head, a changed digest, and revoked, expired or used consent.
- Never touch dirty user changes or the base branch.
- Cancellation and cleanup remove the worktree and leave no partial writes. Cleanup that is uncertain stays owned and is reported.
- Linux only. Other platforms return an explicit unavailable refusal; no port.

**Constraints.** No model call, no new permission for review mode, and nothing wired to a route yet.

**Tests** in a new packages/engine/test/review/fix.test.ts against real local git fixtures:

- a dirty checkout is untouched;
- traversal and symlink refusal;
- head movement;
- a changed digest;
- revoked, expired and reused consent;
- cancellation mid-apply;
- the base branch and unrelated work stay intact.

**Done:** tests and engine typecheck pass; deviation entry.

</details>

<details><summary>SF-08: VS-12b fix executor: consented checks, commit and push operations</summary>

**Spec:** vectorscope-plan.md 'Fix proposals and consent' (commit and push are separate permissions, no push to base, checks are not run when isolation is unavailable); upgrade.md I-6 and the VS-30 item 2 executor rules. Depends on SF-07. Read docs/vector/build/v2-spawn-review.md before spawning anything. Spawn only through the existing shell/spawner path, with exactly one signaler per process.

Extend engine review/fix.ts with the FixOperation operations.

**checks**

- argv only from core permission.ts CHECK_COMMANDS (:32);
- run in the fix worktree under Sandbox.offline (tool/shell/sandbox.ts:252) with network off;
- a clean environment with no provider keys or tokens, CI=1;
- 120 s and 80 KB per command;
- writes only inside the worktree;
- refuse when the sandbox reports { type: "unfiltered" };
- missing dependencies -> "checks not run: dependencies unavailable".

**commit:** separate consent, the message comes from the consented operation, and the trusted adapter supplies the Vector author identity.

**push:** separate consent, only to the consented non-base destination. The branch or draft-pr mode is recorded, but no GitHub call is made here.

Each operation's consent is single-use and bound to the head SHA and the patch/command digest. Test failures or a model pass never authorize new changes. The VS-30 runtime key stays unapplied. Linux only.

**Tests** (extend fix.test.ts):

- an unconsented check is refused;
- a flagged or non-allowlisted argv is refused;
- no env keys are visible to the check;
- network is denied;
- timeout and output caps;
- a commit without commit consent is refused;
- push goes only to a local bare repo (file://) and never to the base branch;
- cancellation and cleanup.

**Done:** tests and engine typecheck pass; deviation entry.

</details>

<details><summary>SF-09: VS-12c CLI consented apply step for verified findings</summary>

**Spec:** addendum-a.md §3 'Other approved packages' VS-12/13 bullet (a CLI consented apply on StrictResult, looping on verified findings, never on a score); vectorscope-plan.md VS-12 row. Depends on SF-07 and SF-08.

In packages/engine/src/cli/cmd/review.ts (pinned file), add an explicit apply step that is off by default:

- build a FixProposal only from verified findings' committable suggestions and patches of the current local review. Never from PR text, and never for --pr, forks or CI;
- show the complete diff, the paths, the destination and the requested commands;
- obtain the person's interactive approval per operation through createFixConsentPolicy before calling the SF-07/08 executor;
- a non-interactive run never applies.

Existing no-push fix prompts stay in effect. Review mode itself gains no write permission.

**Tests** in a NEW file packages/engine/test/cli/review-fix.test.ts (never edit test/cli/review.test.ts):

- no apply without an explicit approval;
- --pr and CI are refused;
- the proposal is built only from verified findings;
- approval of apply does not grant commit or push;
- a head that moved between preview and apply is refused.

If `--help` output changes, update packages/engine/test/cli/help/**snapshots**/help-snapshots.test.ts.snap through the snapshot test's update mode only.

**Done:** tests pass, engine typecheck, pin, deviation entry.

</details>

<details><summary>SF-10a: VS-12d part a: owner-only engine fix API and regenerated client</summary>

**Spec:** vectorscope-plan.md VS-12 row and 'Identity, modes...'. The desktop is an adapter, and the renderer never imports engine runtime. Depends on SF-07..SF-09.

Add owner-only experimental operations to the existing review HttpApi group: server/routes/instance/httpapi/groups/review.ts and handlers/review.ts, both pinned.

- They preview and execute one consented fix operation through engine review/fix.ts.
- Consent is bound to actor, head, patch digest and expiry.
- Owner authority comes from the existing owner middleware.
- Regenerate with `bun run generate` in packages/client (never edit src/generated\*). Also run ./packages/sdk/js/script/build.ts if the public SDK is affected.

**Tests:** an engine handler test (a new packages/engine/test/server/httpapi-review-fix.test.ts) against a real local git fixture:

- owner authority required;
- a stale head is refused;
- the operations stay separate;
- non-owner callers are refused.

The generated client passes check:generated.

**Done:** engine/client typecheck pass, pin moved, review-http-regression.yml (local) and test.yml green, deviation entry. Linux only.

</details>

<details><summary>SF-10b: VS-12d part b: desktop fix preview and apply actions</summary>

**Spec:** as SF-10a. Depends on SF-10a.

In packages/app, behind experimental.vectorscope, using the generated client only:

- the preview: full diff, paths, destination and commands;
- separate apply, checks, commit and push buttons.

Posting a suggestion is never consent.

**Tests:**

- an app unit test under happydom (bun test --preload ./happydom.ts) for the presentation;
- the separate operation buttons;
- no engine import reaches the renderer (extend browser-bundle.test.ts if needed).

Playwright coverage runs only through scope-app-validation.yml in CI.

**Done:** app typecheck, scope-app-validation.yml and test.yml green, deviation entry.

</details>

<details><summary>SF-11: VS-23b ZDR admission and model resolution in Review.run</summary>

**Spec:** upgrade.md VS-23b (:422) and §1 'Where the route check sits'; addendum-a.md VS-33 (structured attestations, built as VS-33b); remaining.md VS-23/VS-33 rows. The pure rules are in core packages/core/src/review/privacy.ts (decideRoute, refusals).

**Config switch.** No runner reads privacy today: the runners call parseReviewConfig, and config.ts:338-341 says they switch to mergeReviewConfig in VS-23b. Switch the local surfaces (CLI review.ts, the local service, the eval replay entry) to mergeReviewConfig({ surface: "local", ... }). Prove that with every sourced key unset the RunInput.config is identical to parseReviewConfig's. zdrAttested comes only from the global config, which arrives in SF-15, so until then a local zdr review refuses every non-loopback route. That is fail-closed. Record it and test positive admission through injected trusted config.

**Route registry.** New engine packages/engine/src/review/route.ts: ReviewRoutes, a session-ID-to-policy map that Review.run registers.

**Model resolution.** In engine review/model.ts, under zdr, check the review, triage, judge and any alternate model, and skip the CI free fallback (:90-110). A refusal is a typed error that becomes a zero-attempt outcome with partial: "privacy", every file unreviewed, and notePrivacyRefused (format.ts).

**Admission.** In engine review/run.ts:

- check the route in the SessionAdmission policy's admit (:631-633) before the step and budget logic, and in ask() (:580) before session creation, never inside reserve();
- this covers retries, finalizers, verify, judge and any model switch;
- a refusal is never retried on another model.

privacy is raise-only. Leave the engine:privacy-zdr engine half pending "VS-23c". The GitHub job's switch is SF-37.

**Tests:**

- packages/engine/test/review/model.test.ts: no free fallback under zdr;
- run.test.ts: refusal on retry, finalizer and verify, with zero attempts on the observer;
- run.test.ts: a GitHub-shaped free fallback is refused inside Review.run;
- D3 parity with privacy unset;
- the mergeReviewConfig-equals-parseReviewConfig parity.

**Done:** tests, engine/core typecheck, pin, review-memory-fence.yml green (run.ts/model.ts), deviation entry.

</details>

<details><summary>SF-12a: VS-23c part a: ZDR backstop in provider resolution and request bodies</summary>

**Spec:** upgrade.md VS-23c (:430) and the integration-map rows for provider.ts; addendum-b.md §2.1 R1; I-3. Depends on SF-11. This is a protected transport file: get the lead's go before you start.

In packages/engine/src/provider/provider.ts:

- At the top of resolveSDK (:2429), before the plan and free-model branches, refuse a zdr-registered session's model when decideRoute refuses it. The Codium plan route stays refused as codium-unaccepted (see SF-35).
- In the generic V1 fetch, apply zdrRequestBody to the final body after promptCacheBreakpointBody against requestInput, or throw before sending.
- Under an active zdr review, refuse non-string bodies, bodies inside a Request, and a malformed x-session-id.
- Requests without x-session-id are the owner's non-session calls and stay unchanged.
- Apply zdrPathRefusal and the body-shape checks to OpenRouter and OpenAI-compatible requests (R1).

**Tests** in a new packages/engine/test/provider/zdr-route.test.ts, against loopback fake servers only, one case per path:

- generic fetch;
- the plan route refused;
- the free route;
- a non-string body;
- a Request body;
- a malformed header;
- an unattested provider throws before fetch;
- a LAN baseURL is refused;
- OpenRouter and OpenAI-compatible bodies;
- byte-identical requests for unregistered sessions.

**Done:** tests, engine typecheck, pin if a pinned file changed, deviation entry. Keep the engine:privacy-zdr half pending until SF-12b.

</details>

<details><summary>SF-12b: VS-23c part b: ZDR backstop in the session LLM runtime and helpers</summary>

**Spec:** upgrade.md VS-23c and the integration-map row llm.ts; I-3. Depends on SF-12a. This is a protected transport file: get the lead's go before you start.

In packages/engine/src/session/llm.ts:

- never select the native runtime (LLMNativeRuntime, :33/:376) for zdr-registered sessions;
- prove that no title, compaction or memory helper request is sent for a vectorscope.\* session under zdr.

Flip the engine:privacy-zdr engine half in replay.ts to { from: "VS-23c" } with keys { privacy: "zdr" }.

**Tests:**

- extend zdr-route.test.ts with native runtime, compaction and title/helper rows;
- packages/engine/test/session/llm.test.ts stays green;
- byte-identical behaviour for non-review sessions.

**Done:** tests, engine typecheck, review-memory-fence.yml green (llm.ts), pin, deviation entry.

</details>

<details><summary>SF-13a: VS-34 part a1: holdback key, held-back skip reason and labels</summary>

**Spec:** addendum-a.md VS-34 (:207-258) design items 2-8 and the §1 keys table (holdback: off|secrets, REVIEW_HOLDBACK, raise-only); remaining.md VS-34 row.

**Key.** Add holdback to ReviewConfig and OPTIONAL_REVIEW_DEFAULTS (off), parsed through the source-tagged raise-only merge (config.ts) from review.json and REVIEW_HOLDBACK. The hidden global source is SF-15. There is no PR-text override. Add holdback to UNAPPLIED_REVIEW_KEYS with its 'not applied' warning until SF-13b. Add it to EVIDENCE_POLICY_KEYS, default-stable.

**Skip reason.** Add the new SkippedFile.reason "held-back", with labels in the exhaustive maps:

- core format.ts;
- the engine github review render;
- app ai-review.ts.

Nothing applies it yet.

**Tests:**

- config raise-only: repo can raise, env can raise, neither lowers;
- the warning is present;
- the policy digest is unchanged with the key unset;
- format/render golden for held-back;
- core config, format and model-evidence tests green.

**Done:** core/engine/app typecheck, pin, deviation entry.

</details>

<details><summary>SF-13b: VS-34 part a2: pre-payload holdback in Review.run</summary>

**Spec:** addendum-a.md VS-34 design items 2-8. Depends on SF-13a. The pure holdbackFiles is in core holdback.ts:88.

In Review.run, before prompt building, under holdback: secrets only:

- compute the gitignored-but-committed list through the private ReviewGit view (git check-ignore --no-index over the changed paths);
- call holdbackFiles;
- drop held files with SkippedFile.reason "held-back", and NOT into state.unreviewed;
- value-redact every remaining untrusted PromptInput block: diff hunks, head files, context.related, history, human comments, PR title and body;
- add the one input-redaction sentence to the prompts, only under the key (promptsDigest);
- add a deterministic zero-token note.

Remove holdback from UNAPPLIED_REVIEW_KEYS when the payload half lands, but keep the engine:holdback-secrets half pending until SF-14.

**Desktop.** ai-review.ts calls holdbackFiles, or the entry records a documented difference.

**Tests** (run.test.ts):

- wire bodies through the projection, with secrets in related, comment, body and history;
- a held file lands in skipped, not unreviewed, and a re-trigger still takes the already-reviewed files;
- the prompt sentence and its promptsDigest are absent with the key unset;
- D3 parity;
- app ai-review.test.ts parity.

**Done:** tests, typecheck, pin, deviation entry.

</details>

<details><summary>SF-14: VS-34 part b: holdback tool rules and tool-output redaction</summary>

**Spec:** addendum-a.md VS-34 design item 2 ('Tool rules under holdback: secrets only'), item 3 (tool output) and item 8 (placement); I-4. Depends on SF-13b.

Under holdback: secrets only:

- Add read deny rules for the payload-only list in core permission.ts, keeping SECRET_FILES exported unchanged. Use Wildcard matching with both root and nested \*/ forms.
- grep inherits the rules through its per-file read check. There are no path-keyed grep rules, so `process.env` searches stay allowed.
- As a backstop, withhold grep output lines from listed paths.
- Value-redact every read and grep tool result of a vectorscope.\* session before it enters the next request. This also covers the impact slice once SF-18 lands.

With the key unset, session permission rules are byte-identical. Flip the engine:holdback-secrets engine half in replay.ts.

**Tests:**

- a projection fixture whose canned model output reads and greps a held-back path: no secret appears in the next wire body;
- reading a non-listed file that contains a token shape: the token is absent;
- nested config/prod/.envrc;
- grep for process.env is allowed;
- a directory grep returns no line from config/.envrc;
- permission rules are byte-identical unset, and when set differ only by the added deny rules;
- the ~40-diff fixture set in core holdback tests stays green.

**Done:** under the key, 0 secret-shaped strings in recorded wire bodies across fixtures; typecheck, pin, deviation entry.

</details>

<details><summary>SF-15: VS-23d hidden global review privacy and holdback settings with desktop enforcement</summary>

**Spec:** upgrade.md VS-23d (:440) and §0.4 (regeneration); addendum-a.md §1 (holdback's hidden global source, 'Config schema changes'); I-14 (ships hidden, Q16). Depends on SF-11..SF-14.

**Global config.** The global config schema is ConfigV1 in packages/core/src/v1/config/config.ts, not packages/engine/src/config.

- Add a hidden `review` block with privacy, holdback and zdrAttested as a new self-exported module per AGENTS.md.
- Load it in the engine config.
- Pass it as mergeReviewConfig's `global` for every vectorscope.\* session the engine server runs, including desktop-originated and local-service reviews.
- It is raise-only against review.json and env.

**Regeneration.** Regenerate packages/web/public/config.json with the engine schema script, the SDK with ./packages/sdk/js/script/build.ts, and the client with `bun run generate` in packages/client. Never hand-edit generated files. This is a per-package regeneration; the lead's single final regeneration is separate.

**Desktop.** app ai-review.ts reads the base blob when a PR changes review.json (privacyOnly) and shows the privacy and holdback notes. Flip the engine:privacy-zdr desktop half, or record the documented difference.

**Tests:**

- a core/engine config test: the field is hidden, raise-only, and never lowered by repo or env;
- a desktop-shaped review under the global setting is refused on an unattested route (app ai-review.test.ts and an engine service test);
- generated client/SDK parity (check:generated).

**Done:** typecheck across core/engine/app/client/sdk; scope-app-validation.yml and test.yml green; deviation entry. The UI stays hidden (owner Q16).

</details>

## Appendix: the lane runner the lead used

A Workflow-tool script (plain JavaScript). Each package runs: CI check of the previous push, plan, adversarial critique, implement (plus up to two continue agents), a readiness gate if the implementer reports blockers, a two-lens review loop with fix rounds, then a commit gate that commits, pushes through the lock and dispatches the lane workflows. A planner or implementer blocker stops the lane for a lead ruling, recorded in `resolved` or `resumeNotes` and resumed. Adapt it; do not run it blind.

```js
export const meta = {
  name: "lane-scope",
  description:
    "Build one Vector lane package by package: plan, critique, implement, two-lens review loop, commit, push through the lock, CI check, then an optional phase review",
  phases: [
    { title: "CI check" },
    { title: "Plan" },
    { title: "Implement" },
    { title: "Review" },
    { title: "Commit" },
    { title: "Phase review" },
  ],
}

const A = {
  /* the lane definition summarised above */
}
const L = A.lane
const MAX_ROUNDS = A.maxRounds || 3
const MAX_CONTINUE = A.maxContinue || 3
const RESUME = A.resumeNotes || {}
const FIX_RESUME = A.fixResumeNotes || {}
const RESOLVED = A.resolved || {}
const TRIAGE = `${L.scratch}ci-triage.md`
const TC = `TURBO_CACHE_DIR=${L.worktree}/.turbo/cache`
const TYPECHECK = `cd ${L.worktree} && ${TC} ~/.tools/vector-serial bun turbo typecheck --concurrency=2`
const PUSH = `cd ${L.worktree} && git fetch origin ${L.remoteBranch} 2>/dev/null; if origin/${L.remoteBranch} exists and has commits HEAD lacks, merge it in with a merge commit (never rebase, never overwrite) and re-run the affected checks; then ${TC} ~/.tools/vector-serial git push -u origin HEAD:${L.remoteBranch} (fast-forward only; never force, never --no-verify). If a pre-push hook runs, fix whatever it reports.`
const DISPATCH = L.dispatchWorkflows || []
const CI_AFTER_PUSH = DISPATCH.length
  ? `dispatch the lane's CI on ref ${L.remoteBranch} with mcp__github__actions_run_trigger (method run_workflow, owner scr1pter, repo vectordev.ai, ref ${L.remoteBranch}, inputs {}), one call per workflow file: ${DISPATCH.join(", ")}. The push itself starts ${L.ciWorkflows.filter((w) => !DISPATCH.includes(w)).join(", ") || "nothing else"}. Then list the newest runs to record their ids. Never dispatch any other workflow.`
  : `do NOT dispatch any workflow: the push starts the lane's CI (${L.ciWorkflows.join(", ")}) by itself. List the newest runs for the new head to record their ids.`

const CONTEXT = `You are an agent in the Vector "${L.name}" lane.
Worktree: ${L.worktree} (local branch ${L.localBranch}, pushes to origin/${L.remoteBranch}). Work ONLY in that worktree. Never touch the owner's Vectordev.ai checkout or any other lane's worktree.
Binding rules: read ${L.rules} FIRST and follow every rule in it exactly (one Bun workload at a time through ~/.tools/vector-serial, tests one file at a time from the package dir with --timeout 30000, git rules, commit identity and trailers). Put scratch files under ${L.scratch} only.
Lane documents (read the parts your task needs; they are the lane's own spec, progress record and deviation log, and you must keep them accurate):
${L.docs}
Lane notes:
${L.extra}
Dependencies: if bun install is needed, run `~/.tools/vector-serial bun install --ignore-scripts --frozen-lockfile` (drop --frozen-lockfile only when the package adds a dependency, and pin it exactly).
GitHub: load the GitHub MCP tools with ToolSearch (query "+github") and use owner scr1pter, repo vectordev.ai. Read job logs with mcp__github__get_job_logs (job_id, return_content true, tail_lines 400, more if needed); full-log zip downloads are blocked.`

const PLAN = {
  type: "object",
  properties: {
    plan: {
      type: "string",
      description: "Step-by-step implementation plan with exact files, functions, types and tests",
    },
    files: { type: "array", items: { type: "string" } },
    tests: { type: "array", items: { type: "string" } },
    blockers: {
      type: "array",
      items: { type: "string" },
      description: "Only things that truly need the owner; empty otherwise",
    },
  },
  required: ["plan", "files", "tests", "blockers"],
}

const CRIT = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          issue: { type: "string" },
          fix: { type: "string" },
        },
        required: ["severity", "issue", "fix"],
      },
    },
    verdict: { type: "string" },
  },
  required: ["issues", "verdict"],
}

const IMPL = {
  type: "object",
  properties: {
    done: {
      type: "boolean",
      description: "true only when the package is fully implemented, its tests pass and the touched packages typecheck",
    },
    summary: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    remaining: { type: "string" },
    testsRun: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
  },
  required: ["done", "summary", "changedFiles", "remaining", "testsRun", "blockers"],
}

const REVIEW = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocking", "non-blocking"] },
          file: { type: "string" },
          line: { type: "number" },
          issue: { type: "string" },
          fix: { type: "string" },
        },
        required: ["severity", "file", "issue", "fix"],
      },
    },
    summary: { type: "string" },
  },
  required: ["findings", "summary"],
}

const GATE = {
  type: "object",
  properties: {
    ready: { type: "boolean" },
    blockers: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["ready", "blockers", "reason"],
}

const VERIFY = {
  type: "object",
  properties: {
    allFixed: { type: "boolean" },
    unresolved: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["allFixed", "unresolved", "summary"],
}

const COMMIT = {
  type: "object",
  properties: {
    committed: { type: "boolean" },
    shas: { type: "array", items: { type: "string" } },
    pushed: { type: "boolean" },
    ciRuns: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    blockers: { type: "array", items: { type: "string" } },
  },
  required: ["committed", "shas", "pushed", "ciRuns", "summary", "blockers"],
}

const CI = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["green", "red-fixed", "red-unfixed", "pending", "none"] },
    branchCaused: {
      type: "boolean",
      description: "true only if some failure on the branch does not also fail on main and was not fixed",
    },
    failures: {
      type: "array",
      items: {
        type: "object",
        properties: {
          test: { type: "string" },
          file: { type: "string" },
          job: { type: "string" },
          onMain: { type: "boolean" },
          cause: { type: "string" },
        },
        required: ["test", "job", "onMain", "cause"],
      },
    },
    summary: { type: "string" },
    blockers: { type: "array", items: { type: "string" } },
  },
  required: ["status", "branchCaused", "failures", "summary", "blockers"],
}

const GENERIC_LENSES = [
  {
    key: "correctness",
    text: `CORRECTNESS AND SCOPE lens. Check that the change implements exactly this package's scope from the lane documents and its brief, and nothing outside it. Hunt for correctness bugs: wrong logic, edge cases, races, wrong types, unsafe parsing, missing error paths, Windows and macOS path or process differences, tests that do not really test the behaviour or duplicate the implementation, missing test cases. Check AGENTS.md style (no any, no aliased or star imports, const, no else, early returns, Effect service binding, inline single-use values) and that core stays browser-safe and the engine Node-compatible.`,
  },
  {
    key: "safety",
    text: `SAFETY AND INVARIANTS lens. ${L.invariants} Also look for security problems: secrets in code, docs or logs, injection, path traversal, unbounded resources, fail-open defaults, network calls to real paid or customer services in tests, and anything that would operate a real person's computer in an automated test. Check that the lane's progress record and deviation log describe exactly what the code does.`,
  },
]
const LENSES = L.lenses && L.lenses.length ? L.lenses : GENERIC_LENSES

const PLAN_BLOCKER_RULE = `
Blockers: list only what prevents building and testing this package without the owner (a purchase, an account, key, certificate or repository setting, a paid run, a public claim, a legal text, a merge to main, a release, or an owner decision the lane documents list as open that the package cannot stay neutral on). A limit on what can be verified locally (for example a test that needs a real Mac or Windows desktop, or a real GitHub App) is not a blocker: plan the parts that CI or fakes can verify, record the rest as deferred verification in the lane documents. Anonymous read-only clones of public repositories from github.com work in this container; clone only under ${L.scratch}.`
const COMMIT_BLOCKER_RULE = `
In the report, blockers are only what stopped you committing or pushing. Put notes, decisions for the lead and owner questions in the summary instead.`

async function ciCheck(wp) {
  return agent(
    `${CONTEXT}

TASK: CI check before package ${wp.id}. The lane's CI workflows are ${L.ciWorkflows.join(", ")} on branch ${L.remoteBranch}. Check \`git status\` first (the worktree should be clean).
- The newest runs are usually still in progress, because the previous package was pushed moments ago. Judge the branch by the newest COMPLETED run of each lane workflow on branch ${L.remoteBranch}, whatever its head commit. Record the ids of in-progress runs for the current head but do not wait for them.
- If every newest completed run is green, report green. If no run has completed since the newest green one, report pending with no blockers.
- If a completed run failed, list every failing test or step (job, file, test name, first error line) from the failed job logs. Then for each failure:
  - If it also fails the same way on main (main's newest completed run of the same workflow; compare by test file and name, never by shard), or ${TRIAGE} records it as main's, as already fixed, or as assigned to a named later package of this lane, record that, change nothing, and leave it out of blockers (a failure assigned to a later package is that package's work, not this check's).
  - If a commit after that run's head (\`git log --oneline <run head>..origin/${L.remoteBranch}\`) already fixes it, name that commit, change nothing, and leave it out of blockers.
  - Otherwise it is this branch's. Find the root cause (reason from logs and code for Windows- or macOS-only failures), fix it in the worktree, run the failing test files and the touched packages' typecheck, then the full turbo typecheck, commit it as a separate "fix(<scope>): ..." commit with the required identity and trailers, push with: ${PUSH}, then ${CI_AFTER_PUSH} Append the failure, cause and fix to ${TRIAGE}. Report red-fixed.
  - If a branch-caused failure cannot be fixed, report red-unfixed with branchCaused true and say exactly why in blockers.
- Report red-unfixed with branchCaused false when every failure is main's or already fixed.
Never skip, disable or loosen a test. "Flake" is not a root cause: a timeout that appears only on this branch needs a reason from the code, and a runner that slowed down needs evidence from the log's timings.`,
    { label: `ci:${wp.id}`, phase: "CI check", schema: CI },
  )
}

async function runPackage(wp, index) {
  const ci = index > 0 || A.ciFirst ? await ciCheck(wp) : null
  if (ci && ci.branchCaused && ci.status === "red-unfixed") return { id: wp.id, stopped: "ci", ci }
  if (ci)
    log(
      `${wp.id} CI check: ${ci.status}${ci.failures.length ? ` (${ci.failures.filter((f) => f.onMain).length} of ${ci.failures.length} failures also on main)` : ""}`,
    )

  const brief = `PACKAGE ${wp.id}: ${wp.title}
${wp.brief}`

  const plan = await agent(
    `${CONTEXT}

${brief}

TASK: plan this package. Read the rules file, the lane documents that cover this package, and the current code at HEAD in the worktree (re-locate every file and line citation on HEAD). Produce a precise implementation plan: every file to add or change, every exported type and function with its signature, the tests to write (by file and case), the lane-document updates (progress record and deviation entry), and how the change stays safe by default. Do not edit any file.${RESOLVED[wp.id] ? "" : PLAN_BLOCKER_RULE}`,
    { label: `plan:${wp.id}`, phase: "Plan", schema: PLAN },
  )
  if (!plan) return { id: wp.id, stopped: "plan-failed" }
  if (plan.blockers.length && !RESOLVED[wp.id]) return { id: wp.id, stopped: "plan-blockers", blockers: plan.blockers }
  const resolution = RESOLVED[wp.id]
    ? `\n\n${RESOLVED[wp.id]}\nPLANNER'S BLOCKERS (resolved above): ${plan.blockers.join(" | ")}`
    : ""

  const crit = await agent(
    `${CONTEXT}

${brief}${resolution}

TASK: adversarially critique this implementation plan before any code is written. Check it against the lane documents, the code at HEAD and the rules. Find what is wrong, missing, over-scoped, or unsafe. Do not edit any file.

PLAN:
${plan.plan}

FILES: ${plan.files.join(", ")}
TESTS: ${plan.tests.join(", ")}`,
    { label: `critique:${wp.id}`, phase: "Plan", schema: CRIT, effort: "high" },
  )

  const critText = crit
    ? crit.issues.map((i) => `- [${i.severity}] ${i.issue} => ${i.fix}`).join("\n")
    : "(critique unavailable)"
  let impl = await agent(
    `${CONTEXT}

${brief}${resolution}

TASK: implement this package in the worktree. Apply the plan, corrected by the critique (the critique wins where it is right; where you reject a point, say why in the deviation entry). Write the tests, run each new or changed test file through the lock, run \`bun typecheck\` in every touched package, and update the lane's progress record and deviation log with a dated entry for ${wp.id} (what landed, what is deferred, decisions, evidence). Do NOT commit. Leave all changes in the working tree. Report every changed or new file.

PLAN:
${plan.plan}

CRITIQUE:
${critText}${RESUME[wp.id] ? "\n\n" + RESUME[wp.id] : ""}`,
    { label: `impl:${wp.id}`, phase: "Implement", schema: IMPL },
  )
  if (!impl) return { id: wp.id, stopped: "impl-failed" }
  let n = 0
  while (!impl.done && !impl.blockers.length && n < MAX_CONTINUE) {
    n++
    const next = await agent(
      `${CONTEXT}

${brief}

TASK: continue implementing this package in the worktree. A previous agent stopped before finishing. Inspect \`git status\` and \`git diff HEAD\` first, then finish the remaining work, run the tests and typechecks, and complete the lane-document entries. Do NOT commit.

PREVIOUS SUMMARY: ${impl.summary}
REMAINING: ${impl.remaining}`,
      { label: `continue:${wp.id}:${n}`, phase: "Implement", schema: IMPL },
    )
    if (!next) break
    impl = { ...next, changedFiles: [...new Set([...impl.changedFiles, ...next.changedFiles])] }
  }
  if (impl.blockers.length && !impl.done) {
    const gate = await agent(
      `${CONTEXT}

${brief}

TASK: decide whether this package is ready for review and commit. The implementer stopped, reporting it not done, with the blockers below. Inspect \`git status\` and \`git diff HEAD\` and the lane documents' entry for this package. Do not edit any file.
A blocker that only says some verification must wait for the push, for the lane's CI on its runners (for example native code that only builds or runs on Windows or macOS CI), or for a later package is NOT a reason to hold the commit: the commit step pushes and dispatches CI, and the next package's CI check reads the result. Answer ready=true when all the local work for this package is complete and its local tests and typechecks pass. Answer ready=false, listing the real blockers, when work is missing, a local test or typecheck fails, or something truly needs the owner.

IMPLEMENTER SUMMARY: ${impl.summary}
REMAINING: ${impl.remaining}
BLOCKERS: ${impl.blockers.join(" | ")}`,
      { label: `gate:${wp.id}`, phase: "Implement", schema: GATE, effort: "high" },
    )
    if (!gate || !gate.ready)
      return { id: wp.id, stopped: "impl-blockers", blockers: gate ? gate.blockers : impl.blockers, impl }
    log(`${wp.id} readiness gate: ready (${gate.reason})`)
    impl = { ...impl, done: true, blockers: [] }
  }
  if (impl.blockers.length) log(`${wp.id} implement notes (package done, not blocking): ${impl.blockers.join(" | ")}`)
  if (!impl.done) return { id: wp.id, stopped: "impl-unfinished", impl }

  const rounds = []
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const reviews = await parallel(
      LENSES.map(
        (lens) => () =>
          agent(
            `${CONTEXT}

${brief}

TASK: review the UNCOMMITTED changes for this package (\`git status\`, \`git diff HEAD\`, and every untracked file). ${lens.text}
You may run focused tests and typechecks through the lock to confirm a finding. Do not edit any file. Mark a finding "blocking" only if it is a real defect, scope violation, invariant break or missing required test; style preferences and optional polish are "non-blocking". Give file, line and a concrete fix for each.`,
            { label: `review:${wp.id}:${lens.key}:${round}`, phase: "Review", schema: REVIEW, effort: "high" },
          ),
      ),
    )
    const findings = reviews.filter(Boolean).flatMap((r) => r.findings)
    const blocking = findings.filter((f) => f.severity === "blocking")
    const minor = findings.filter((f) => f.severity !== "blocking")
    rounds.push({ round, blocking: blocking.length, nonBlocking: minor.length })
    log(`${wp.id} review round ${round}: ${blocking.length} blocking, ${minor.length} non-blocking`)
    if (!blocking.length && round > 1) break
    if (!blocking.length && !minor.length) break
    const list = findings
      .map((f) => `- [${f.severity}] ${f.file}${f.line ? ":" + f.line : ""} ${f.issue} => ${f.fix}`)
      .join("\n")
    await agent(
      `${CONTEXT}

${brief}

TASK: fix the review findings below in the worktree. Fix every blocking finding. Fix non-blocking ones that are plainly correct and cheap. Where you disagree with a finding, leave the code and record why in the deviation entry. Re-run the affected tests and typechecks. Do NOT commit.

FINDINGS:
${list}${FIX_RESUME[wp.id + ":" + round] ? "\n\n" + FIX_RESUME[wp.id + ":" + round] : ""}`,
      { label: `fix:${wp.id}:${round}`, phase: "Review" },
    )
    if (!blocking.length) break
    const check = await agent(
      `${CONTEXT}

${brief}

TASK: verify that each blocking finding below is really fixed in the uncommitted changes (or rejected with a sound recorded reason). Re-run the affected tests. Do not edit files.

BLOCKING FINDINGS:
${blocking.map((f) => `- ${f.file}${f.line ? ":" + f.line : ""} ${f.issue}`).join("\n")}`,
      { label: `verify:${wp.id}:${round}`, phase: "Review", schema: VERIFY, effort: "high" },
    )
    if (check && check.allFixed) break
  }

  const commit = await agent(
    `${CONTEXT}

${brief}

TASK: commit gate for this package.
1. Inspect \`git status\` and \`git diff HEAD\`. Only this package's changes may be committed; if anything unrelated is present, leave it unstaged and report it.
2. Run every new or changed test file for this package (one at a time, through the lock) and \`bun typecheck\` in each touched package. Fix any failure first.
3. Run the full typecheck: ${TYPECHECK}. It must pass.
4. Stage explicit paths only and commit with the title "${wp.commitTitle}", a body that summarises what landed and what is deferred, and the required identity and trailers from the rules file.
5. Fetch origin ${L.remoteBranch}, confirm \`git merge-base --is-ancestor origin/${L.remoteBranch} HEAD\`, then push: ${PUSH}
6. Then: ${CI_AFTER_PUSH}
Report the commit sha(s), whether the push succeeded, and the CI run ids.${COMMIT_BLOCKER_RULE}`,
    { label: `commit:${wp.id}`, phase: "Commit", schema: COMMIT },
  )
  if (!commit) return { id: wp.id, stopped: "commit-failed", impl, rounds }
  if (!commit.committed || commit.blockers.length) return { id: wp.id, stopped: "commit-blockers", commit, rounds }
  return { id: wp.id, commit, rounds, ci }
}

const results = []
for (let i = 0; i < A.wps.length; i++) {
  const wp = A.wps[i]
  log(`[${L.name}] starting ${wp.id}: ${wp.title}`)
  const r = await runPackage(wp, i)
  results.push(r)
  if (r.stopped) {
    log(`[${L.name}] stopped at ${wp.id}: ${r.stopped}`)
    return { lane: L.name, results, stoppedAt: wp.id }
  }
}

const pr = A.phaseReview
if (!pr) return { lane: L.name, results }
phase("Phase review")
const phaseFindings = []
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const reviews = await parallel(
    LENSES.map(
      (lens) => () =>
        agent(
          `${CONTEXT}

TASK: phase review "${pr.name}". Commits under review: ${pr.from}..HEAD (\`git log --oneline ${pr.from}..HEAD\`, \`git diff ${pr.from}..HEAD\`). Also inspect any uncommitted changes from an earlier round of this phase review. ${lens.text}
${pr.notes}
Look especially at how the packages fit together: consistent types and names, duplicated logic, and gaps between what the lane documents claim and what the code does. Do not edit files.`,
          { label: `phase:${lens.key}:${round}`, phase: "Phase review", schema: REVIEW, effort: "high" },
        ),
    ),
  )
  const findings = reviews.filter(Boolean).flatMap((r) => r.findings)
  const blocking = findings.filter((f) => f.severity === "blocking")
  phaseFindings.push({ round, blocking: blocking.length, total: findings.length })
  log(`[${L.name}] phase review round ${round}: ${blocking.length} blocking of ${findings.length}`)
  if (!findings.length || (!blocking.length && round > 1)) break
  await agent(
    `${CONTEXT}

TASK: fix these phase-review findings in the worktree (every blocking one; plainly correct cheap non-blocking ones). Record disagreements in the deviation log under a dated "${pr.name}" entry. Re-run affected tests and typechecks. Do NOT commit.

FINDINGS:
${findings.map((f) => `- [${f.severity}] ${f.file}${f.line ? ":" + f.line : ""} ${f.issue} => ${f.fix}`).join("\n")}`,
    { label: `phase-fix:${round}`, phase: "Phase review" },
  )
  if (!blocking.length) break
}
const FINAL = A.finalWorkflows || []
const phaseCommit = await agent(
  `${CONTEXT}

TASK: commit gate for the phase review "${pr.name}". If there are no uncommitted changes, report committed=false with no blockers and stop. Otherwise run the affected test files and package typechecks, then the full turbo typecheck (${TYPECHECK}), stage explicit paths, commit as "${pr.commitTitle}" with the required identity and trailers, confirm origin/${L.remoteBranch} is an ancestor, push: ${PUSH}, then ${CI_AFTER_PUSH}${FINAL.length ? ` Also dispatch once, on ref ${L.remoteBranch}: ${FINAL.join(", ")} (the lane's end-of-lane full run), and record their run ids.` : ""}`,
  { label: "phase-commit", phase: "Phase review", schema: COMMIT },
)
return { lane: L.name, results, phaseFindings, phaseCommit }
```
