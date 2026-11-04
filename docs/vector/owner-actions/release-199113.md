# Desktop 1.99.113: release notes and owner steps (draft)

Desktop 1.99.113 brings learned skills, workflow insights (learned workflow defaults) and the prompt guard, and the multi-agent parity build in its own section below. This file is a draft written before the release: no version is bumped yet, and the notes below go into `packages/web/src/data/vector-releases.ts` and `packages/web/public/changelog.json` only in the release preparation commit. The build contract is `.vector-build/self-evolving-spec.md` on the `self-evolving` branch.

The site deploys from main, so every docs paragraph about these features starts with `release113.since` ("Coming in desktop 1.99.113:" until `publishedDesktopVersion` reaches 1.99.113, then "From desktop 1.99.113:"). `packages/web/test/release-113-docs.test.ts` holds the pages to it.

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

On ordinary and Thorough requests Vector's agent now hands independent, substantial parts of the work, broad searches and new work you send while it is busy to subagents in the background, keeps working, and reads each report as it arrives. At most 8 subagents run at once in a conversation, one request starts at most 32, and they share a $25 spend ceiling at catalog prices (4, 8 and $5 for guests), all in Settings → Agents → Limits. Stop still stops only the main turn; Stop including helpers stops every helper and keeps their work, and Move to background frees the turn from a blocking subagent or batch. After an update, restart or crash nothing restarts on its own: the conversation lists the interrupted helpers, and Resume all continues them. A helper waiting on your permission says so. Briefs may pick a cheaper model or lower effort, fork from the whole conversation and its prompt cache, or ask for checked JSON. Every edit takes a per-file lock, a file must be read before it is changed, helpers' files are protected from each other, and a helper can work in its own git worktree whose changes you review, merge or discard. Workflows run many agents in stages from a declarative plan you approve, with ceilings, stop and resume. Long commands can run in the background and report when they exit. In the desktop app a message sent while Vector works steers the turn by default, with Queue in Settings → General and a queue that sends with the session closed. After this upgrade each conversation's next request writes the provider's prompt cache again once, because the subagent policy and tool descriptions changed. Vector's edit, write and apply_patch tools no longer change a file the conversation has not read, or one that changed since it was read; they say why, and the agent reads it again. apply_patch's Add File no longer overwrites an existing file.

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
- launch a fork on Anthropic, and check its cache read in the Tasks pane;
- run the three workflow examples from the docs, stop one, restart Vector, and resume it;
- run `vector run --workflow` from Vector's own terminal, and check it refuses;
- ask for a background `sleep 30; echo done`, and check the agent is told when it exits.

### CLI

`vector tasks` and its new actions, `vector workflow`, `vector run --workflow` and `--stop-helpers`, the Ctrl+C handling, and the TUI's `<leader>k`, `/stop-all`, the Esc toggle, Ctrl+B for batches, the new `/tasks` actions and `/workflow` reach the terminal with the next CLI release. Windows WSL servers keep the engine version the desktop requires until a later desktop release requires that CLI.
