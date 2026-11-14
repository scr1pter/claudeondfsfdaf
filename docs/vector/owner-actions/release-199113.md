# Desktop 1.99.113: release notes and owner steps (draft)

Desktop 1.99.113 brings learned skills, workflow insights (learned workflow defaults) and the prompt guard, and the multi-agent parity build in its own section below. This file is a draft written before the release: no version is bumped yet, and the notes below go into `packages/web/src/data/vector-releases.ts` and `packages/web/public/changelog.json` only in the release preparation commit. The build contract is `.vector-build/self-evolving-spec.md` on the `self-evolving` branch.

The site deploys from main, so every docs paragraph about these features starts with `release113.since` ("Coming in desktop 1.99.113:" until `publishedDesktopVersion` reaches 1.99.113, then "From desktop 1.99.113:"). `packages/web/test/release-113-docs.test.ts` holds the pages to it.

**Source and release checkpoint, 9 November 2026.** The multi-agent and learned-skills source was merged through pull request #20 at `0dcbb8e2d1cc01d22d4b98695d651430f10f1d2c` on 8 November. That source includes the earlier tokenomics and research consolidation. The desktop manifest and the website's `publishedDesktopVersion` still say **1.99.112**, and the desktop still requires standalone CLI **1.99.99**. This is a source integration, not publication of desktop or CLI 1.99.113. The owner's current implementation request covers routine isolated candidate preparation and free checks. The draft packet below records outstanding acceptance evidence and the actual privacy, paid-measurement and protected-publication decisions; preparing it does not mark those decisions approved. Recheck the selected candidate and production artifacts before making a release decision.

## Release notes (draft)

**Title:** Learned skills, workflow insights and the prompt guard

**Summary:**

When a run turns a failing check green, Vector drafts the steps that worked as a skill for that repository. A draft waits for your review in Settings → Memory → Skills; a learned skill is guidance the agent may load, never a rule, and it names only a short allowed list of commands. Settings → Memory → Workflow insights shows which effort, subagent split and subagent model got each size of work passing here, and at what cost, and a cheaper setting that passes as often becomes the learned default when you leave effort on Default. Learned defaults never raise spend, never override your own picks and leave spend caps unchanged. Owner-only `vector memory` commands refuse to run from an agent's shell or Vector's own terminal, and an edit to a file that feeds a system prompt asks every time. Learned skills and workflow insights stay in brain.db on this computer; usage check-ins are unchanged.

## What blocks the publish

The 1.99.113 publish waits for these work packages and their focused tests. Each runs its own test files from its package directory, one file at a time.

1. **WP1, core brain data and learning logic.** `packages/core/test/brain/database.test.ts`, `migration-learned.test.ts`, `skill-commands.test.ts`, `skill.test.ts`, `skill-older-builds.test.ts`, `brain.test.ts`, `workflow.test.ts` and `export.test.ts`; `packages/core/test/spend-guard.test.ts`, `share/archive-learned.test.ts` and `task-size.test.ts`.
2. **WP2, the engine runtime.** `packages/engine/test/session/skill-learn.test.ts`, `workflow-learn.test.ts`, `skill-credit.test.ts`, `local-carried.test.ts`, `system.test.ts` and `llm-request.test.ts`; `test/skill/learned.test.ts`; `test/tool/skill.test.ts` and `memory-skill.test.ts`.
3. **WP3, the surfaces.** `packages/engine/test/server/memory-skills.test.ts` and `memory-workflow.test.ts`; `test/cli/memory-agent.test.ts`, `memory-skill.test.ts` and `usage-report-learning.test.ts`; `packages/desktop/src/main/usage-checkin.test.ts`; the app's `memory-skills-model.test.ts`, `memory-workflow-model.test.ts`, `memory-model.test.ts`, `settings-registry.test.ts`, `learned.test.ts`, `workflow.test.ts` and `economics-repository.test.ts`; and `packages/web/test/release-113-docs.test.ts`, `brain-docs.test.ts` and `release-111-docs.test.ts`.
4. **WP5, owner trust and the prompt guard.** `packages/schema/test/permission-policy.test.ts`, `packages/tui/test/util/permission.test.ts`, `packages/engine/test/session/prompt-guard.test.ts`, `test/cli/trust.test.ts` and `test/skill/fmt.test.ts`.

Offline prompt evolution (WP4) is a script harness that never ships, so it does not block the publish.

Then the release needs the usual checks on the release commit: the package typechecks, both SDK generators, CI on Linux and Windows, and the Verify workflow.

## Before you release the desktop

1. **Decide what the build leaves open:**
   - A `vector serve` with no password treats every local program, the agent's shell included, as the owner, so it could approve a skill over HTTP. The docs tell you to set `VECTOR_SERVER_PASSWORD` when serving.
   - A check a skill names runs the repository's own code (`npm test` runs whatever `package.json` says), as any check the agent runs does.
   - Erasing one session from an older Vector build does not reach learned skills; erasing a repository or everything from an older build is finished the next time 1.99.113 opens that memory.
   - The prompt guard asks before Vector's own edits and common shell writes change a prompt file, and holds changed prompt files outside the repository until you approve them. It does not catch interpreters, the V2 bash tool or MCP filesystem servers: it is an ask and a hold, and the docs and app copy say no more than that.
   - The owner-only commands (`vector memory skills approve`, `vector trust prompts approve` and the rest) refuse under the agent marker, and the shell asks every time before a command that removes it (`unset`, `env -u`, `env -i`, `exec -c`). A program that clears its children's environment some way the shell scan does not see (a script, an interpreter) can still run them as the owner, as an interpreter can still write brain.db or the prompt baseline. Only the opt-in shell sandbox (`VECTOR_SHELL_SANDBOX`) is a boundary.
   - `vector memory skills` and `vector memory skills show` stay open to the agent, as the contract keeps read-only commands open, so an agent that runs them reads a skill's steps through its shell.
2. **Legal review.** The privacy policy does not yet describe learned skills, workflow insights or the optional skill drafter, which, set to Always, sends one run's commands, file names and a short redacted error excerpt to the user's model provider. Legal text changes only with your sign-off.
3. **Start the release** as for 1.99.111: the preparation commit sets `packages/desktop/package.json` to 1.99.113, adds the entry above to `release199` and runs `bun scripts/build-changelog.ts` from `packages/web`.

## After the release

4. **Try it.** In a signed-in 1.99.113:
   - make a check fail, fix it in a Standard request, and check that Settings → Memory → Skills shows a draft with why it was drafted, and that Approve puts it in use;
   - run `vector memory skills approve <id>` from Vector's own terminal and check it refuses;
   - share an approved skill and check `.vector/skills/<name>/SKILL.md` holds no error excerpt, and that Vector asks you to trust the repository again once its sessions finish;
   - open Workflow insights and check each size lists its runs, with unknown cost said as unknown.
5. **Mark 1.99.113 published** (a repository change; ask Claude). Set `publishedDesktopVersion` to `1.99.113`; the docs then say "From desktop 1.99.113:", and `release-113-docs.test.ts` follows.
6. **CLI.** `vector memory skills`, `vector memory workflow` and the owner gates come to the terminal with the next CLI release.

## Multi-agent parity

Desktop 1.99.113 also carries the multi-agent parity build: delegation on ordinary work, limits, Stop including helpers, Move to background, restart recovery, waiting helpers, forks, per-brief models and effort, checked JSON results, file safety, worktree isolation, workflows and background commands. The build contract is `docs/vector/build/multiagent-parity-spec.md`, and every place the code departs from it is in `docs/vector/build/multiagent-parity-deviations.md`. The website paragraphs carry the same `release113.since` label; `packages/web/test/release-113-multiagent-docs.test.ts` holds the pages to it.

### Release note (draft)

**Title:** Subagents on ordinary work, with limits, Stop including helpers and workflows

**Summary:**

On ordinary and Thorough requests Vector's agent now hands independent, substantial parts of the work, broad searches and new work you send while it is busy to subagents in the background, keeps working, and reads each report as it arrives. At most 8 subagents run at once in a conversation, one request starts at most 32, and they share a $25 spend ceiling at catalog prices (4, 8 and $5 for guests), all in Settings → Agents → Limits. Stop still stops only the main turn; Stop including helpers stops every helper and keeps their work, and Move to background frees the turn from a blocking subagent or batch. After an update, restart or crash nothing restarts on its own: the conversation lists the interrupted helpers, and Resume all continues them. A helper waiting on your permission says so. Briefs may pick a cheaper model or lower effort, fork from the whole conversation and its prompt cache, or ask for checked JSON. Every edit takes a per-file lock, a file must be read before it is changed, helpers' files are protected from each other, and a helper can work in its own git worktree whose changes you review, merge or discard. Workflows run many agents in stages from a declarative plan you approve, with ceilings, stop and resume. Long commands can run in the background and report when they exit. In the desktop app a message sent while Vector works steers the turn by default, with Queue in Settings → General and a queue that sends with the session closed while a Vector window is open. After this upgrade each conversation's next request writes the provider's prompt cache again once, because the subagent policy and tool descriptions changed. Vector's edit, write and apply_patch tools no longer change a file the conversation has not read, or one that changed since it was read; they say why, and the agent reads it again. apply_patch's Add File no longer overwrites an existing file.

### What blocks the publish

The publish waits for these work packages and their focused tests. Each runs its own test files from its package directory, one file at a time; full suites, the HttpApi exerciser and Playwright run in CI.

1. **WP1, shared contract.** `packages/schema/test/compatibility.test.ts`, `packages/engine/test/config/subagent-config.test.ts`, `packages/engine/test/tool/subagent-lifecycle-read.test.ts` and `packages/engine/test/task/bridge-decode.test.ts`.
2. **WP2, one note pipeline.** `packages/engine/test/task/note-window.test.ts`, `packages/engine/test/task/notify.test.ts`, `packages/engine/test/session/task-size-history.test.ts` and `packages/engine/test/tool/task.test.ts`.
3. **WP3, lifecycle helpers.** `packages/engine/test/tool/subagent-lifecycle.test.ts` and `packages/engine/test/tool/task.test.ts`.
4. **WP4, the delegated spend ledger.** `packages/core/test/spend-guard.test.ts`.
5. **WP5, the limits service.** `packages/engine/test/task/limits.test.ts`.
6. **WP6, admission and slots.** `packages/engine/test/tool/task.test.ts`.
7. **WP7, limits on the board, research reservation, fair batch reports.** `packages/engine/test/tool/task-manage.test.ts`, `packages/engine/test/session/research-sizing.test.ts`, `packages/engine/test/tool/research-tool.test.ts`, `packages/engine/test/tool/task-report.test.ts` and `packages/engine/test/tool/task.test.ts`.
8. **WP8, sizing rules and the request model.** `packages/core/test/task-size.test.ts` and `packages/engine/test/session/task-size-history.test.ts`.
9. **WP9, prompt wiring, policy and tool text.** `packages/engine/test/session/task-size.test.ts`, `packages/engine/test/session/system.test.ts` and `packages/engine/test/session/prompt.test.ts`.
10. **WP10, durable job rows and liveness.** `packages/core/test/background-job.test.ts`, `packages/core/test/background-job-store.test.ts`, `packages/core/test/database-migration.test.ts` and `packages/engine/test/background/job.test.ts`.
11. **WP11, interrupted helpers and restart recovery.** `packages/engine/test/task/recovery.test.ts`, `packages/engine/test/tool/task.test.ts` and `packages/engine/test/tool/task-manage.test.ts`.
12. **WP12, Stop including helpers.** `packages/engine/test/tool/task-manage.test.ts`, `packages/engine/test/server/session-stop.test.ts` and `packages/engine/test/server/auth-guest.test.ts`.
13. **WP13, Move to background for singles and batches.** `packages/engine/test/tool/task.test.ts` and `packages/engine/test/server/task-batch-promotion.test.ts`.
14. **WP14, resume.** `packages/engine/test/tool/task-manage.test.ts`, `packages/engine/test/tool/task-manage-schema.test.ts`, `packages/engine/test/tool/task.test.ts` and `packages/engine/test/server/auth-guest.test.ts`.
15. **WP15, waiting on you and `ask_timeout`.** `packages/engine/test/task/attention.test.ts`, `packages/engine/test/permission/expire.test.ts` and `packages/engine/test/question/expire.test.ts`.
16. **WP16, notes up, siblings and taint.** `packages/engine/test/tool/task-manage.test.ts`, `packages/engine/test/session/task-note-taint.test.ts` and `packages/core/test/task-mailbox.test.ts`.
17. **WP17, checked structured output.** `packages/core/test/json-schema-check.test.ts`, `packages/engine/test/session/structured-output.test.ts`, `packages/engine/test/session/structured-output-thinking.test.ts` and `packages/engine/test/provider/transform.test.ts`.
18. **WP18, per-brief model and effort, Thorough passdown.** `packages/engine/test/agent/subagent-model.test.ts`, `packages/engine/test/tool/task-model-effort.test.ts`, `packages/engine/test/tool/parameters.test.ts` and `packages/engine/test/session/workflow-learn.test.ts`.
19. **WP19, `output_schema` on task.** `packages/engine/test/tool/task-structured.test.ts` and `packages/engine/test/tool/task-manage.test.ts`.
20. **WP20, fork core.** `packages/engine/test/session/fork.test.ts`, `packages/engine/test/session/compaction-tail.test.ts`, `packages/engine/test/session/llm-request.test.ts` and `packages/engine/test/provider/transform.test.ts`.
21. **WP21, fork wiring.** `packages/engine/test/session/fork-cache.test.ts` and `packages/engine/test/tool/task-fork.test.ts`.
22. **WP22, per-file lock and read-before-write.** `packages/engine/test/tool/file-lock.test.ts`, `packages/engine/test/tool/file-state.test.ts`, `packages/engine/test/tool/edit.test.ts`, `packages/engine/test/tool/write.test.ts` and `packages/engine/test/tool/apply_patch.test.ts`.
23. **WP23, claims and the write chokepoint.** `packages/engine/test/task/claims.test.ts`, `packages/engine/test/tool/owned-path.test.ts` and `packages/engine/test/session/session-tools-writable.test.ts`.
24. **WP24, shell writes and git rules.** `packages/engine/test/tool/git-mutation.test.ts` and `packages/engine/test/tool/shell-ownership.test.ts`.
25. **WP25, isolation building blocks.** `packages/core/test/isolation/copy.test.ts`, `packages/core/test/workspace-trust/inherit.test.ts`, `packages/engine/test/worktree/create-for-task.test.ts`, `packages/desktop/src/main/parallel-workspaces.merge.test.ts` and `packages/desktop/src/main/parallel-workspaces.follow-up.test.ts`.
26. **WP26, routing for helpers in another instance.** `packages/engine/test/task/place.test.ts`, `packages/engine/test/session/prompt-routing.test.ts`, `packages/engine/test/event-bridge-routing.test.ts`, `packages/engine/test/server/session-metadata.test.ts` and `packages/engine/test/session/cleanup.test.ts`.
27. **WP27, the isolation module.** `packages/engine/test/task/isolation.test.ts`, with `packages/engine/test/lsp/isolation.test.ts` and `packages/engine/test/mcp/isolation.test.ts` (no language server or MCP process for a task worktree).
28. **WP28, isolation wiring, merge and discard.** `packages/engine/test/tool/task.test.ts`, `packages/engine/test/tool/task-manage.test.ts`, `packages/engine/test/server/task-isolation.test.ts` and `packages/engine/test/server/auth-guest.test.ts`.
29. **WP29, workflow core and the published schema.** `packages/core/test/orchestration/spec.test.ts`, `template.test.ts`, `predicate.test.ts`, `limits.test.ts`, `progress.test.ts`, `report.test.ts`, `plan.test.ts` and `schema-file.test.ts`; `packages/schema/test/permission-policy.test.ts`; `packages/web/test/deployed-schemas.test.ts`.
30. **WP30, the workflow runtime.** `packages/engine/test/orchestration/runner.test.ts`, `packages/engine/test/orchestration/resume.test.ts`, `packages/engine/test/orchestration/sources.test.ts` and `packages/engine/test/orchestration/library.test.ts`, with `launch.test.ts`, `ledger.test.ts`, `state.test.ts`, `bounds.test.ts`, `scheduling.test.ts` and `runtime.test.ts` beside them.
31. **WP31, the workflow tool and engine integration.** `packages/engine/test/tool/workflow.test.ts`, `packages/engine/test/tool/task-workflow.test.ts`, `packages/engine/test/task/manager-workflow.test.ts`, `packages/engine/test/session/workflow-guards.test.ts`, `packages/engine/test/session/prompt-guard.test.ts`, `packages/engine/test/config/workflow-config.test.ts` and `packages/engine/test/tool/structured-output-providers.test.ts`.
32. **WP32, workflow routes and CLI.** `packages/engine/test/server/httpapi-workflow.test.ts` and `packages/engine/test/cli/workflow.test.ts`, with `packages/engine/test/cli/run-workflow.test.ts`.
33. **WP33, background shell commands.** `packages/engine/test/task/shells.test.ts` and `packages/engine/test/tool/task-manage.test.ts`, with `packages/engine/test/cli/run/background-wait.test.ts` from the Phase 7 review.
34. **WP34, `vector tasks` and `vector run` interrupts.** `packages/engine/test/cli/tasks.test.ts`, `packages/engine/test/cli/run/interrupt.test.ts`, `packages/engine/test/cli/run/footer.menu.test.ts` and `packages/engine/test/cli/run/runtime.test.ts`.
35. **WP35, app capabilities, stop and settings.** `packages/app/src/features/background-tasks/engine-capabilities.test.ts`, `packages/app/src/features/background-tasks/stop-helpers.test.ts`, `packages/app/src/context/settings.test.ts`, `packages/app/src/components/settings-v2/settings-registry.test.ts`, `packages/app/src/components/prompt-input/submit.test.ts` and `packages/app/src/context/command-keybind.test.ts`.
36. **WP36, the app's follow-up queue.** `packages/app/src/features/followup/followup-model.test.ts`, `packages/app/src/features/followup/followup-store.test.ts` and `packages/app/src/features/followup/followup-queue.test.ts`.
37. **WP37, the Tasks pane and chips.** `packages/app/src/features/background-tasks/task-board-model.test.ts`, `packages/app/src/features/background-tasks/subagent-model.test.ts`, `packages/app/src/features/background-tasks/task-limits.test.ts` and `packages/app/src/features/background-tasks/background-tasks-state.test.ts`.
38. **WP38, docks, pages, Settings → Agents and workflow UI.** `packages/app/src/components/settings-v2/subagent-limits.test.ts`, `packages/app/src/features/background-tasks/workflow-model.test.ts`, `packages/app/src/components/settings-v2/workflow-settings-model.test.ts`, `packages/app/src/components/settings-v2/settings-registry.test.ts`, `packages/app/src/pages/session/composer/session-interrupted-dock.test.ts` and `packages/session-ui/src/components/workflow-part.test.ts`.
39. **WP39, the TUI.** `packages/tui/test/task-presentation.test.ts`, `packages/tui/test/keymap.test.tsx`, `packages/engine/test/config/tui.test.ts`, `packages/tui/test/cli/tui/task-batch.test.ts`, `packages/tui/test/util/permission.test.ts` and `packages/tui/test/cli/cmd/tui/sync.test.tsx`.
40. **WP40a, website docs, release notes and CI wiring.** `packages/web/test/release-113-multiagent-docs.test.ts`, `packages/web/test/docs-settings.test.ts` and `packages/web/test/release-113-docs.test.ts`, which CI's "Run website release copy tests" step runs with `release-copy.test.ts` and `deployed-schemas.test.ts`.
41. **WP40b, Playwright specs.** `followup-steer-queue.spec.ts`, `stop-helpers.spec.ts`, `background-tasks-controls.spec.ts`, `background-tasks-details.spec.ts`, `subagent-limits.spec.ts`, `isolated-subagent.spec.ts`, `workflow-progress.spec.ts`, `workflow-permission.spec.ts` and `background-commands.spec.ts` in `packages/app/e2e/regression/`, passing with `bun --cwd packages/app test:e2e:local` in CI.

CI must also show the engine shards green on Linux and Windows, the HttpApi exerciser covering every new route with no skips, `check:generated` clean in `packages/client`, the desktop engine bundle booting under Node, and the turbo package tests for core, schema, app and tui.

### Decide what the build leaves open

- **The defaults.** 8 running, 32 per request and $25 per request for subagents; guests 4, 8 and $5; notes wait 1.5 s of quiet and are held at most 5 s; `workflow: ask` with 100 agents, `per_agent_steps` 60 and 120 minutes; language servers and MCP servers off in worktrees; no default `isolation.link` entries.
- **Extra tool tokens on providers without a prompt cache.** Work requests now carry the `task`, `task_manage` and `workflow` definitions, about 3k tokens, which such providers bill on every request. Re-run the offline footprint harness (`script/agent-eval/footprint.ts` with `VECTOR_PURE=1`) when you choose, and update the stale `docs/benchmarks` numbers.
- **The desktop queue drains only while a Vector window is open.** There is no engine-side queue, and a browser without Web Locks (`vector web` over plain HTTP) sends a queued message only while its session is open.
- **Shell detection is best effort.** Interpreters, scripts, `bash -c` strings, the V2 bash tool and MCP filesystem servers are not seen, and ownership taken from a helper's first write can hold the main agent off a file until it finishes.
- **Downgrading with kept worktrees.** An older Vector would resume their helpers in the main folder, so merge or discard every kept worktree before going back.
- **Ctrl+Alt+B and AltGr.** Move to background is Ctrl+Alt+B, which is AltGr+B on some keyboards; the app ignores the press while AltGraph is held, except on macOS, which has no AltGr.
- **Windows locks on worktree removal.** A worktree another program holds is removed on a later pass instead of at once.
- **A settings save stops background commands.** Every global settings change reloads each open folder once its turns and subagents finish, and that reload stops the running background commands, a dev server included; the agent gets a note and may start one again. Waiting for them instead would keep the old settings, a lowered spend ceiling among them, for as long as a dev server runs. Settings → Agents asks first when it finds running commands in the 20 most recent conversations the app has seen work; other Settings pages, such as provider keys, do not ask.
- **Linked folders in worktrees.** An `isolation.link` folder is the main checkout's own folder, so what a helper writes there (an `npm install`, a build) changes it at once, outside Review, Merge, Discard and checkpoints. No folder is linked by default, and the docs say so.
- **The load of several conversations.** The limits are per conversation, so several conversations can run dozens of subagents on this computer at once, each with its shell checks. No machine-wide ceiling is added.
- **The live fork cache measurement.** Cache sharing is proven only against a fake provider; measure the cache reads of a real fork on Anthropic before you rely on the savings.
- **Workflow asks on older clients.** Desktop 1.99.111 and 1.99.112 show a workflow ask after outside content or past the defaults with their generic reason about the web.
- **`vector serve` without a password.** It treats local callers as the owner, so merge and workflow start are reachable from the agent's shell; the docs repeat that `VECTOR_SERVER_PASSWORD` should be set.

### Try it

In a signed-in 1.99.113, on a scratch repository:

- ask an ordinary question that needs a broad search, and check that a subagent does the search in the background while the main agent keeps going;
- five minutes into a run with a helper, send a follow-up that makes its work unnecessary, and check the agent stops that helper;
- set `budget.subagents.running` to 8 and ask for nine independent parts, and check the ninth shows "Queued: waiting for a free subagent slot" and starts on its own;
- set `budget.subagents.usd` to 0.5, and check that subagents stop at the ceiling, keep their work, and the main agent carries on;
- use Stop including helpers while helpers run, and check nothing starts again until you write;
- use Move to background on a foreground batch, and check each entry reports on its own;
- start two helpers, `kill -9` the engine, reopen the repository, and check one note lists both and Resume all continues them;
- set `sizing.subagents.ask_timeout` to 1 and let a helper's web fetch ask wait, and check it is declined after a minute and the helper carries on;
- launch two isolated helpers that edit one file, merge one, and check the other's merge reports a conflict;
- launch a fork on Anthropic, open its own session from the Tasks pane, and check the read figure of Cache Tokens (read/write) in its Context tab (the Tasks pane shows one combined token total);
- run the three workflow examples from the docs, stop one, restart Vector, and resume it;
- run `vector run --workflow` from Vector's own terminal, and check it refuses;
- ask for a background `sleep 30; echo done`, and check the agent is told when it exits.

### CLI

`vector tasks` and its new actions, `vector workflow`, `vector run --workflow` and `--stop-helpers`, the Ctrl+C handling, and the TUI's `<leader>k`, `/stop-all`, the Esc toggle, Ctrl+B for batches, the new `/tasks` actions and `/workflow` reach the terminal with the next CLI release. Windows WSL servers keep the engine version the desktop requires until a later desktop release requires that CLI.

## Owner-review and acceptance packet — draft, 9 November 2026

This packet prepares the decisions and evidence for an owner review. Every empty
approval field and every `Not run` result below is outstanding. The feature
checklists above remain applicable. Source integration, a green test run, a
website deployment and a published desktop installer are separate events.
Routine coding, isolated release-candidate preparation and free checks proceed
under the current implementation request; this packet adds no permission step
for that reversible work.

Other agents currently own Hands/computer use, @vector, Codium and the
multi-agent/self-evolving implementation. This packet does not authorize edits,
merges or test interruptions in those workstreams. A candidate that takes later
feature merges needs its own refreshed checks and acceptance record.

### Candidate and review record

| Field                                                                         | Owner or release coordinator records                                                                                                            |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Source checkpoint used to prepare this packet                                 | `0dcbb8e2d1cc01d22d4b98695d651430f10f1d2c`; documentation/source inspection only                                                                |
| Exact release-candidate commit, including selected feature merges             | Pending                                                                                                                                         |
| Intended desktop version / compatible standalone CLI / plugin version         | Candidate target 1.99.113; record the compatible CLI/plugin during preparation. Current manifests are desktop 1.99.112 and required CLI 1.99.99 |
| Immutable model-catalog revision and digest                                   | Pending; verify against the candidate's embedded catalog                                                                                        |
| Linux and Windows general-CI runs, attempt and conclusion                     | Pending for the selected candidate; do not substitute an older branch run                                                                       |
| Verify, generated clients/SDKs, API coverage and desktop Node-bundle evidence | Pending for the selected candidate                                                                                                              |
| Mac and Windows RC artifact hashes, OS versions and acceptance operator       | Pending                                                                                                                                         |
| Privacy-copy reviewer, decision and date                                      | Pending; proposed text below is not approved or published policy                                                                                |
| Final release reviewer, decision and date                                     | Pending; publication is a separate decision after the evidence is complete                                                                      |

### Proposed privacy disclosure — draft for owner and legal review

The following is proposed feature-specific wording, not a legal conclusion or a
change to the published privacy policy. It must be reconciled with the existing
provider, account, sharing and usage-check-in disclosures before publication.

> Vector stores learned skills and workflow insights in `brain.db` on the
> computer running its engine. By default, skill drafts wait for your review,
> the optional model drafter runs only when Vector Local is enabled, and
> workflow exploration is off. You can inspect and manage these features in
> Settings → Memory. Local storage describes where the records are kept: when
> an eligible learned skill is listed or loaded for a task, its description or
> procedure can become context sent to the model used for that task, subject
> to Vector's memory and permission controls.
>
> You can turn the model drafter off, leave it at Only with Vector Local, or
> select Always. Always permits a separate helper request to your configured
> model provider, which may be outside this computer when Vector Local is off.
> The helper uses an available small model from that provider, falling back to
> the task's model when no small model is available. Its input is a filtered
> trace of one eligible run: the check command and, when present, up to 600
> characters of the redacted failing output; allowed helper commands; and the
> repository-relative names of files read or changed. A judge-only trace may
> identify that the run was judged instead of carrying a check failure. The
> drafter does not attach the full conversation or file bodies as its input,
> and it has no tools. File names, paths and command arguments can still reveal
> information about your work; filtering and redaction are not a promise that
> all sensitive information has been removed.
>
> The drafter is withheld for guest sessions, held traces, models marked as
> able to train on prompts, and runs stopped or warned by the budget guard.
> These checks use Vector's configuration and model metadata; they do not
> establish how a provider retains data. Helper usage is charged
> to the run that launched it. Turning off the model drafter still permits
> deterministic skill drafts while skill learning remains enabled; turning
> skill learning off prevents new skill drafts. Choosing Share writes an
> approved skill to `.vector/skills/<name>/SKILL.md` in the repository; Vector
> does not commit it for you. That explicit export omits the stored error
> excerpt, session identifiers, usage statistics and evidence. Commit or
> otherwise distribute that file only when you intend to share its procedure.

Source checks supporting this draft:

| Source                                                                                 | Behavior checked                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/brain/brain.ts`, `learnSettings`                                    | `learning: true`, `skills: "review"`, `skillDrafter: "local-only"`, `workflow: "apply"`, `workflowExplore: false` when unset                          |
| `packages/core/src/brain/skill.ts`, `LIMIT`, `request`, `safePath`, `lock`             | Trace fields, 600-character failure cap, allowed commands and repository-relative paths; returned steps constrained to the observed trace             |
| `packages/engine/src/session/skill-learn.ts`, `run`, `drafts`, `drafter`, `modelDraft` | Eligibility/hold checks, Local/default/Always behavior, small-model fallback, tool-free helper, original-run spend settlement                         |
| `packages/engine/src/session/system.ts`; `skill/learned.ts`; `session/prompt.ts`       | Eligible skill descriptions are listed; loaded procedures fill a request where personal memory may go, while the stored transcript uses a placeholder |
| `packages/app/src/components/settings-v2/memory-skills-model.ts`                       | Review-first/auto/off and drafter choices; explicit sharing exclusions                                                                                |

This draft deliberately does not promise zero data egress, zero retention,
perfect secret removal, a security certification or a reduction in model cost.
The draft is not evidence that any provider configuration or optional feature
has been enabled on an owner's machine.

### Default-behavior decisions — no boxes accepted yet

An owner may keep the recorded defaults or request a separate product change
from that workstream's owner. Preparing this list changes no setting.

- [ ] Accept skill learning at **Review first**, with the model drafter **Only
      with Vector Local**; record any requested alternative and its disclosure.
- [ ] Accept learned workflow defaults at **Apply**, only where the existing
      rules permit them and the user has not made an explicit choice, with
      **workflow exploration off**. Do not describe these as proven general savings.
- [ ] Accept per-conversation helper limits of **8 running / 32 per request /
      $25 at catalog prices**; guests **4 / 8 / $5**. Acknowledge that several
      conversations can exceed those counts in aggregate. Provider invoices may
      differ from these catalog-price estimates.
- [ ] Accept **no automatic resume after restart**, steer-by-default follow-ups,
      and a desktop queue that drains only while a Vector window is open.
- [ ] Accept the existing workflow approval policy and ceilings: an ask by
      default, up to 100 agents, 60 steps per agent and 120 minutes; no broader
      grant is created by this packet.
- [ ] Decide whether to retain helper terminal access. Current behavior is
      retained; Stop including helpers also closes their terminals. Any different
      behavior belongs to the multi-agent owner.
- [ ] Decide whether to retain refusal of unmarked settings imported from a
      shared ancestor folder that is not a Git repository. No import is enabled here.
- [ ] Acknowledge prompt-file checks are an ask/hold with documented coverage
      gaps, not a complete execution sandbox. Owner commands and a passwordless
      `vector serve` are not a boundary against arbitrary local programs; use the
      existing server-password and optional sandbox controls as appropriate.
- [ ] Accept that saving settings may stop background commands, linked worktree
      folders are shared immediately, and kept worktrees must be merged or discarded
      before downgrading. Confirm an appropriate recovery copy before RC testing.

Owner name: **Pending**. Decision/date: **Pending**. Requested changes and
responsible workstream, if any: **Pending**.

### Synthetic release-candidate acceptance record

Use only a disposable repository, fabricated documents and a dedicated test
profile, OS account or test machine. Arrange an exclusive test window with the
active workstream owners before any stop, restart, crash or settings-save test.
Do not interrupt their current sessions or use a company's real corpus. New paid
provider measurements still require the budget and credential approval below;
synthetic inputs alone do not make those calls free.

For every row, record the exact candidate, artifact hash, OS, operator, date and
redacted evidence link. Leave an unavailable check `Not run`, never `Pass`.

| ID    | Synthetic scenario and required observation                                                                                                                                                                                                                            | Mac result | Windows result |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- |
| RC-01 | Install the selected beta RC over a supported prior build in the disposable profile; confirm version, sign-in, existing synthetic session and settings, and update-channel identity.                                                                                   | Not run    | Not run        |
| RC-02 | Fix a fabricated failing check in an eligible Standard run with at least three completed tool calls and a changed file. The draft waits for review; Approve makes it available. Reject/delete leaves it unavailable.                                                   | Not run    | Not run        |
| RC-03 | With the drafter Off, observe a deterministic draft without a drafter call; with the default and Vector Local off, observe no model-drafter call. Inspect the allowed trace and exercise Always using a fake provider; live paid calls use the measurement gate below. | Not run    | Not run        |
| RC-04 | From Vector's own terminal, attempt the documented owner approval command and confirm refusal. Share one approved synthetic skill deliberately, inspect the exact file and exclusions, and confirm renewed repository trust is requested.                              | Not run    | Not run        |
| RC-05 | Inspect Workflow insights with explicit user choices and fabricated unknown-cost evidence. Explicit choices remain effective; unknown cost stays unknown; exploration remains off.                                                                                     | Not run    | Not run        |
| RC-06 | Launch synthetic independent helper work, lower the configured helper ceiling and observe queue/budget behavior. Stop including helpers stops descendants and their terminals while preserving completed work.                                                         | Not run    | Not run        |
| RC-07 | In the isolated test instance only, interrupt the engine while two helpers run. Reopen: both are reported interrupted; neither resumes before the user's explicit action; Resume all continues the intended work.                                                      | Not run    | Not run        |
| RC-08 | Run two isolated helpers against one fabricated file. Review/merge one, then require an explicit conflict for the other's stale merge. Confirm unrelated files and the primary checkout are preserved.                                                                 | Not run    | Not run        |
| RC-09 | Run a small synthetic workflow through its normal product permission ask, stop it, restart the isolated instance and resume it. Verify its plan, ceilings, job notes and final state.                                                                                  | Not run    | Not run        |
| RC-10 | Run a short synthetic background command, observe its completion note, and test the documented settings-save warning/stop behavior in the disposable profile.                                                                                                          | Not run    | Not run        |
| RC-11 | Send a follow-up while work runs, then exercise Queue, session navigation and a reload. Confirm the documented steer/queue behavior, with no duplicate send; record the window-open limitation.                                                                        | Not run    | Not run        |
| RC-12 | Erase synthetic learned/research data through the supported owner controls; inspect the resulting lists and recall. Exercise any downgrade only after disposing of kept worktrees and preserve the documented older-build erase limitations.                           | Not run    | Not run        |

### Preparation, measurements and publication

Routine preparation and free checks are covered by the current implementation
request. Record their evidence as they finish; keep the paid, privacy and
protected-publication decisions distinct.

- [ ] Schedule an exclusive window for the free before/after production
      session/timeline benchmark on exact source revisions, run it with synthetic
      or fake-provider inputs and no paid inference, and record the run IDs and
      comparison. No additional permission is needed merely to run this free check.
      The older title benchmark does not cover these session/timeline changes.
      Partial evidence: the [9 November local AC-powered first-navigation study](../build/evidence/ui-comparison-ac-2026-11-09/README.md)
      completed 60 passing runs on pinned before/after revisions and reversed
      orders. It is a selected three-scenario comparison on a shared Windows host;
      it does not clear the exclusive full-timeline or native-platform checks.
- [ ] Obtain approval for any paid live fork-cache or matched multi-agent measurement: provider,
      model/reasoning, task and quality gate, maximum total spend, responsible
      operator and permitted credential entry all **Pending**. Use a newly approved
      credential/budget arrangement; do not reuse the previous tokenomics study's
      chat-supplied key or spending authorization. Fake-provider cache checks do not
      establish live savings.
- [ ] Approve the final privacy wording and any public feature/cost claims.
      Reviewer/name/date and the exact text revision are **Pending**.
- [ ] Prepare an isolated release-candidate commit, including the version,
      lockfile and changelog when the selected scope is coherent; verify compatible
      CLI/plugin availability and the catalog, then run the relevant generators and
      free checks. This reversible preparation needs no additional permission.
      Existing published versions may satisfy compatibility; no new npm publication
      is implied. Preparation/version bump is **not run** by this documentation edit.
- [ ] Approve the actual desktop publish workflow and protected environment
      separately. Record run/attempt, immutable artifacts, production download and
      updater-feed verification before marking 1.99.113 published. Publishing the
      website or merging source does not satisfy these checks.

Packet preparation itself was source inspection and documentation. The later
free UI measurements are linked above and retain their own source and scope.
No RC acceptance, paid model call, workflow dispatch, account change, invitation,
version bump or publication is implied by this packet.
