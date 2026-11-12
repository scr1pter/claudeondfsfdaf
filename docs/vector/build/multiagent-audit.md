# Vector vs Claude Code: multi-agent orchestration and subagent spawning

Repository: `self-evolving/`. "Shipped" means commit 6eaf445a (desktop 1.99.111). "Unreleased" means commit 90acb30c. Line numbers are from 90acb30c. Everything below shipped unless it is marked unreleased.

## 1. Verdict

Vector hands work off the same basic way Claude does. The main agent can start up to 8 helpers at once. They run in the background, the main agent is told automatically when each one finishes, and it only gets each helper's short final report, so its own memory doesn't fill up.

It is less efficient at "hand off, then keep giving it work". By default Vector only lets the main agent use helpers when you ask for a "thorough" job, pick Thorough, or name a helper. A normal request, or a follow-up like "also do Y" sent while helpers are running, gets done by the main agent itself. If that follow-up comes more than about 5 minutes later (on Claude models), the main agent can't even check on, steer or stop the helpers it already started.

Vector's helpers also all edit the same folder as you, protected only by an optional rule that says which files each helper owns. Claude can give each helper its own copy of the repo. Vector also has no script-driven workflow tool like Claude's.

Vector is ahead in a few places:
- You, and the main agent, can look at a running helper's progress and message it mid-run.
- Helpers can wait for each other's results.
- Its prompts are smaller, so in offline simulated runs it cost about a third as much. That figure has not been checked with real usage.

## 2. Side by side

| # | Topic | Claude Code | Vector | Evidence |
|---|---|---|---|---|
| Q1 | Spawning and running in parallel | Several Agent calls in one response run at the same time. The Workflow tool allows up to 1000 agents, at most min(16, CPUs-2) at once. | **Partial.** 1 to 8 briefs per call, all started together, no hard cap. But the default agent only gets the task tool on Thorough requests or when you name a subagent. | packages/engine/src/tool/task.ts:1703-1755; packages/core/src/task-size.ts:96-104 |
| Q2 | Runs in the background (doesn't block) | Yes. The main agent is notified when a subagent finishes. | **Yes**, but only for subagents started by the main session. A subagent's own subagents block it. The desktop app has no way to move a blocking subagent to the background. | packages/engine/src/tool/task.ts:546; packages/engine/src/effect/runtime-flags.ts:33-38 |
| Q3 | Giving it new tasks while subagents run | Yes. You keep sending messages and tasks, and the main agent keeps working. | **Partial.** Your message is accepted. But a follow-up is sized fresh as Standard, so it can't hand the new work to a subagent. The desktop app also holds messages in a queue while the main turn is busy. | packages/engine/src/session/task-size.ts:133-142; packages/app/src/pages/session.tsx:1898-1902 |
| Q4 | Follow-ups and corrections to a subagent | SendMessage continues a subagent with its context intact. | **Yes.** `task_manage message` steers a running child at its next step. Calling `task` again with its task_id resumes a finished child. Both depend on those tools being offered that turn. | packages/engine/src/task/manager.ts:289-383; packages/engine/src/tool/task.ts:1361-1441 |
| Q5 | Agents talking to each other mid-run | No. Subagents report to the parent, not to each other. | **Partial.** Siblings can message each other, but they have no way to find each other's IDs. A child can't message its parent mid-run. `depends_on` passes one finished helper's report into another's brief. | packages/engine/src/task/manager.ts:82-105; packages/engine/src/tool/task.ts:1141-1172 |
| Q6 | How results come back | Pushed to the parent. It sees only the final report. | **Yes.** Pushed as a note capped at 3 KB / 60 lines, with the full text saved to a file. Notes within 500 ms are merged into one. The parent can also inspect progress on demand. | packages/engine/src/tool/task.ts:1204; packages/engine/src/task/manager.ts:253-287 |
| Q7 | Agent types, models and context | Types with their own prompt, tools, model and effort. Per-call model override. Fresh start or fork of the full conversation. | **Partial.** 9 built-in types plus custom ones. No per-call model or effort. No fork: a child starts from its brief only. explore moves to the small model only if that is strictly cheaper. | packages/engine/src/agent/agent.ts:485-697; packages/engine/src/tool/task.ts:900-952 |
| Q8 | Isolation (git worktrees) | `isolation: "worktree"` per subagent, cleaned up automatically. | **No** for task subagents: they share your checkout, protected only by optional owned_paths. **Yes** in the desktop Parallel Workspaces and Swarm features. | packages/engine/src/tool/task.ts:1047-1052; packages/desktop/src/main/parallel-workspaces.ts:1642-1679 |
| Q9 | Nesting, stop, timeouts, restarts | Not described in the tool definitions, apart from workflow resume and workflows nested one level deep. | **Partial.** Nesting stops at depth 2. Stop cascades to descendants and dependents. No time limit and no automatic relaunch. Running subagents are lost on restart. Stopping the parent leaves background helpers running. | packages/engine/src/tool/task.ts:99; packages/engine/src/session/run-state.ts:146-176 |
| Q10 | Scripted orchestration and structured output | Workflow tool (agent, parallel, pipeline, phase), JSON-schema output per agent, resume. | **Partial.** `depends_on` ordering plus built-in pipelines (judge loop, deep research, code review, desktop swarm). You can't write your own pipeline, and a task can't require a schema. | packages/engine/src/tool/task.ts:496-531; packages/engine/src/review/run.ts:535-615 |
| Q11 | Cost, caching and model routing | Parallelism costs tokens. Workflows share one token budget. Per-call model override. | **Partial.** Smaller prompts: about 1/3 the cost in offline simulated runs, not checked live. A child never reuses the parent's cache. Only explore gets cheap-model routing (general: unreleased). Subagent spend counts toward the main agent's budget, but there is no dollar cap unless you set one. | docs/benchmarks/vector-subagents-2026-10/README.md:30-37; packages/core/src/spend-guard.ts:3-6 |
| Q12 | Visibility and control | Completion notifications, background shell commands, Monitor tool, separate sessions that report back. | **Yes.** Desktop Tasks pane (inspect, talk, stop, stop all), TUI `/tasks`, CLI `vector tasks`. The desktop app can't move a blocking subagent to the background; only the TUI and the CLI can. | packages/app/src/features/background-tasks/background-tasks-pane.tsx:290-410; packages/engine/src/cli/cmd/tasks.ts:9-47 |

## 3. What this means in practice

- **A normal request gets no helpers.** If you type "build the settings page", Vector sizes it as Standard and removes the task tool, so the main agent does the work itself. You only get subagents if you pick Thorough, say "use subagents" or "be thorough", @-name a subagent, set `sizing.auto=false`, or the model calls escalate. escalate's own description tells the model not to do that for ordinary work (packages/core/src/task-size.ts:96-104; packages/engine/src/session/prompt.ts:2546-2556; packages/engine/src/tool/escalate.txt:1-5).
- **A follow-up sent while helpers are running is done by the main agent itself.** The main agent starts on it right away, alongside the running helpers, but it can't delegate it. Within the cache window, the task tool refuses anything you didn't @-name. After the window (5 minutes on Claude-style caching, otherwise 60), it also loses `task_manage` for that turn, so it can't list, steer or stop the helpers it started. You can still control them yourself from the desktop Tasks pane (packages/engine/src/session/task-size.ts:133-142; packages/engine/src/session/prompt.ts:4013-4027; packages/engine/src/provider/transform.ts:452-454).
- **On desktop, messages you type during a busy turn wait in a queue.** The queue holds up to 20 and sends them when the main turn ends, unless you press Steer on a queued item. Even then the engine reads your message only after the current step finishes, including any blocking subagent in that step. The desktop app has no Ctrl+B to push a blocking subagent into the background (packages/app/src/pages/session.tsx:1898-1902, 2046-2060; packages/engine/src/session/prompt.ts:2166-2172; packages/engine/src/server/routes/instance/httpapi/handlers/experimental.ts:235-252).
- **Pressing Stop on the main agent does not stop background helpers.** They keep running and spending on your keys until you use Stop or "Stop all background tasks" in the Tasks pane, `task_manage stop`, or `vector tasks stop` (packages/engine/src/session/run-state.ts:151-156). If the app or engine restarts, every running helper is lost. Each one is marked cancelled the next time someone looks at it, and you have to resume it by hand (packages/core/src/background-job.ts:135-141; packages/engine/src/task/manager.ts:107-128).
- **Parallel coding helpers edit your actual folder.** If they don't declare `owned_paths`, or if they change files through shell commands, they can overwrite each other's edits or the main agent's. `write` overwrites whole files without a lock. For real isolation, use desktop Parallel Workspaces or Swarm: each agent gets a worktree (or a copy), and conflicts are caught when you merge (packages/engine/src/tool/owned-path.ts:7-23; packages/engine/src/tool/write.ts:44-71; packages/desktop/src/main/parallel-workspaces.ts:3125-3221).

## 4. Gaps ranked

These are ranked by how much they hurt the "hand off and keep taking tasks" experience.

**1. Delegation tools are withheld on ordinary requests and follow-ups**
- **What's missing.** Below Thorough, the task tool and `task_manage` are removed (packages/core/src/task-size.ts:96-104; packages/engine/src/session/prompt.ts:2546-2556). Running background children don't keep the request open, so the next message is sized fresh (packages/engine/src/session/task-size.ts:133-142, 396-426).
- **Why it matters.** This is the core loop you asked about. New work isn't handed off, and the main agent can lose control of helpers it already started.
- **Where.** `withheld()` in core/task-size.ts, `size()`/`groups()` in session/task-size.ts, and the namedOnly wrapper in session/prompt.ts:4013-4027.
- **Size.** Small to always keep `task_manage` while the session has running or unread background children. Medium to let running children keep a request Thorough, or to offer the task tool on Standard with a cheaper default subagent.
- **Risks.** The gate exists to control cost. Without it there is no default dollar cap for interactive runs (packages/desktop/src/main/spend-limits.ts:124-135) and no hard concurrency cap (packages/engine/src/tool/task.ts:96-98). Changing the tool set between turns also changes the cached prompt prefix (comment at prompt.ts:2549-2551).

**2. Task subagents share one working tree**
- **What's missing.** The task tool has no worktree option (packages/engine/src/tool/task.ts:152-211, 1047-1052). `owned_paths` is optional and is enforced only in edit, write and apply_patch, not the shell. The parent agent is never checked against it, and siblings that declare no paths are never checked against each other (packages/engine/src/tool/task.ts:688, 693-695, 701).
- **Why it matters.** Handing off several coding tasks in parallel is unsafe without careful briefs.
- **Where.** Add an isolation parameter in task.ts and reuse the worktree code in packages/engine/src/control-plane/adapters/worktree.ts:35-84, or the desktop code in packages/desktop/src/main/parallel-workspaces.ts:1642-1679 and the merge at 3125-3221.
- **Size.** Large for worktrees plus merge-back plus cleanup. Medium for an interim fix: require `owned_paths` for parallel write-capable children, check parent edits against children's claims, and add the edit tool's per-file lock (edit.ts:38-48) to write and apply_patch.
- **Risks.** Merge conflicts, disk use, a copy fallback is needed for dirty repos (as the desktop does), and the shell still bypasses ownership.

**3. On desktop, your messages and the main agent get held up**
- **What's missing.** The client-side queue holds messages during a busy turn. The "Follow-up behavior" Queue/Steer setting exists only as text that nothing uses (packages/app/src/i18n/en.ts:916-919). The queue drains only from the open session page (packages/app/src/pages/session.tsx:2046-2060). There is no desktop caller of the promote endpoint, and foreground batches can't be promoted at all (packages/engine/src/tool/task.ts:1485; packages/core/src/background-job.ts:345-349).
- **Why it matters.** Claude Code lets you keep typing new tasks. In Vector's desktop app they wait.
- **Where.** packages/app/src/pages/session.tsx, packages/app/src/context/settings.tsx, the session header or Tasks pane, and task.ts for batch promotion.
- **Size.** Small for a steer-by-default setting and a "Move to background" button. Medium for promoting batches.
- **Risks.** Steering mid-turn can derail the model, and promoting a batch needs a notification per entry.

**4. Background work ignores Stop and doesn't survive a restart**
- **What's missing.** Stop skips background jobs (packages/engine/src/session/run-state.ts:146-176). Jobs live only in memory (packages/core/src/background-job.ts:135-141). After a crash, reports that were never delivered only come back with your next message (packages/engine/src/tool/subagent-lifecycle.ts:99-118).
- **Why it matters.** Helpers that keep spending after you press Stop, and helpers that silently vanish on an app update, both erode trust in handing work off.
- **Where.** run-state.ts, core/background-job.ts, task/manager.ts.
- **Size.** Small for a "Stop including subagents" option. Large for durable jobs with automatic resume.
- **Risks.** Resuming automatically after a crash could spend without the user noticing, so it must respect budgets.

**5. Children start cold, and each completion costs a parent turn**
- **What's missing.** There is no fork of the parent's conversation. A child gets its own system prompt (packages/engine/src/session/llm/request.ts:66) and an 8 KiB context_pack at most (packages/engine/src/tool/task.ts:532-535). Completions more than 500 ms apart each start their own parent turn (packages/engine/src/tool/task.ts:87-88, 1240-1251).
- **Why it matters.** Children re-read files the parent already read, and the parent's context is re-sent once per completion.
- **Where.** task.ts and session/llm/request.ts.
- **Size.** Small to widen the batch window. Large for a fork mode, because reusing the cache needs the same system prompt and tools, which clashes with the per-agent tool denies at task.ts:953-982.
- **Risks.** Forked children carry large contexts, and a wider window delays results.

**6. No per-call model or effort, and Thorough effort isn't passed down**
- **What's missing.** The task tool has no model or effort parameter (packages/engine/src/tool/task.ts:152-211). Children run at the variant you picked rather than Thorough's high effort (packages/engine/src/session/prompt.ts:2662-2669, 3906-3908). In the shipped build, general stays on the parent's model; small-model routing for general is unreleased (task.ts:906-912 in 90acb30c).
- **Where.** task.ts:900-952, session/prompt.ts.
- **Size.** Small to medium.
- **Risks.** The model could pick expensive models, so an allowlist is needed, and the free-route logic must be kept.

**7. No workflow tool you can script**
- **What's missing.** There is no pipeline, workflow or structured-output task tool (checked by listing every `Tool.define` in packages/engine/src/tool). Some pieces already exist: the json_schema prompt format (packages/schema/src/v1/session.ts:88-92; packages/engine/src/session/prompt.ts:2711-2717), `depends_on`, and budget linking through `SpendGuard.link`.
- **Size.** Large.
- **Risks.** Runaway fan-out cost when there is no hard cap, and resume and caching need their own design.

**8. A child can't ask its parent anything, and a child blocked on you waits forever**
- **What's missing.** There is no channel from a child up to its parent (packages/engine/src/task/manager.ts:82-105). A child stuck on a permission or question prompt shows `waiting_on_user` with no timeout and no signal to the parent (manager.ts:134-146).
- **Size.** Medium.
- **Risks.** Chatty children cost extra parent turns.

## 5. Bugs or risks found

All of these were verified by reading the code. Two are marked as plausible or inferred.

**Limits and runaway spend**
- packages/engine/src/tool/task.ts:96-98: there is no hard cap on running subagents; the 6-sibling threshold is "Not a cap". At task.ts:759-765 with 1703-1733, the warning never fires inside a single batch, because siblings are counted before any entry starts.
- packages/engine/src/session/prompt.ts:2374-2375: maxSteps defaults to Infinity and no subagent has a time limit. At packages/engine/src/task/manager.ts:134-146, a child waiting on you blocks forever.

**Stop and restart**
- packages/engine/src/session/run-state.ts:151-156: Stop on the parent leaves background subagents running and spending.
- packages/core/src/background-job.ts:135-141 with packages/engine/src/task/manager.ts:107-128: a restart kills every running subagent. They are marked cancelled only when someone next looks, and nothing resumes them.
- packages/engine/src/tool/task.ts:394-409: a completion note waits without limit while a revert is pending on the parent.

**File clobbering**
- packages/engine/src/tool/owned-path.ts:7 and packages/engine/src/tool/write.ts:44-71: ownership isn't enforced for the shell, write and apply_patch take no lock, and siblings without paths, `depends_on` targets (task.ts:688, 693-701) and the parent are unchecked. The result is silent last-writer-wins.

**Sizing gate and effort**
- packages/engine/src/session/task-size.ts:133-142 with packages/engine/src/session/prompt.ts:2546-2556: the sizing gate removes the main agent's control over its own running children on a follow-up sent after the cache window.
- **Plausible, not confirmed:** packages/engine/src/session/task-size.ts:416-426. A completion note that arrives after a Standard follow-up runs with the Standard tool set, so resuming the finished child with task_id would be refused.
- packages/engine/src/session/prompt.ts:2662-2669 with 3906-3908: a "thorough" delegation can run its workers at lower reasoning effort than the parent.
- packages/engine/src/session/system.ts:140: the system prompt says "explore runs on the provider's small model when one is available". The code (task.ts:900-952) moves it only when the small model supports tools, is priced and is cheaper. ChatGPT sign-in, Azure and free routes never move it.

**Truncated results**
- packages/engine/src/tool/task.ts:1757 with packages/engine/src/tool/tool.ts:142-155: a foreground multi-entry batch is truncated as one joined block (50 KiB / 2000 lines, head kept), so later children's reports can fall out of the parent's view.

**Desktop and TUI**
- packages/app/src/pages/session.tsx:2046-2060: queued follow-ups drain only while that session's page is open.
- packages/app/src/i18n/en.ts:916-919: the "Follow-up behavior" Queue/Steer strings are not wired to any setting.
- packages/tui/src/routes/session/index.tsx:971-995 with packages/engine/src/task/manager.ts:394-420: "Stop background subagents" actually stops every descendant, including foreground tasks, their dependents and bridged desktop workspaces, and it refuses outright above 200.
- packages/app/src/features/background-tasks/background-tasks-pane.tsx:881-882: "Open its session to continue" is misleading for engine subagents, whose session page says "Subagent sessions cannot be prompted."

**Desktop Swarm and Parallel Workspaces**
- packages/desktop/src/main/spend-limits.ts:124-135 with packages/desktop/src/main/parallel-session-scope.ts:17-38: swarm workers and parallel workspaces are separate root sessions under an interactive policy that is uncapped by default, so a default swarm has no combined dollar ceiling. At packages/desktop/src/main/swarm-orchestrator.ts:246-249, maxAgents has no maximum.
- **Inferred, not tested:** packages/desktop/src/main/parallel-workspaces.ts:1658-1679 and 3193-3221. Later swarm workers appear to get full copies, because the staging tree becomes dirty. Copy merges compare whole files by hash, so two workers editing different lines of one file conflict.
- packages/desktop/src/main/parallel-workspaces.ts:643-700: each desktop-managed wait gives up after 30 minutes, so a long single turn in a workspace is interrupted and marked failed.
- packages/app/src/pages/layout-new.tsx:3529-3550: the renderer polls the workspace list every 1.5 s, or 0.5 s for an external runtime, whenever a session route is open. packages/desktop/src/main/parallel-workspaces.ts:697 polls each running workspace every 650 ms.

## 6. Confidence

- **Nothing was run.** On your instruction, no tests, builds or processes were run. Every finding comes from reading source and git history, so timing, actual concurrency and real costs were not observed.
- **The cost comparison is not real-world.** The "about a third of Claude Code's cost" figure comes from offline runs against a scripted fake provider, with tokens estimated as characters divided by 4 and frozen Sonnet 4.5 prices. The repository's own README says it can't support live cost or quality claims (docs/benchmarks/vector-subagents-2026-10/README.md:1-3, 80), and there are no live probe results in the repo (script/agent-eval/live-efficiency.md:165-202).
- **The Claude Code column comes only from its tool definitions, not its source.** Where those definitions say nothing (timeouts, restart behaviour, cache sharing between a parent and a fork, mid-run steering), the table says so rather than guessing.
- **Not checked in depth:**
  - Tool-call concurrency under the opt-in `experimentalNativeLlm` runtime.
  - The "later swarm workers get copies" behaviour, which is inferred and only first-wave workers are covered by a test.
  - The notification-under-Standard-tool-set bug, which is plausible but not confirmed.
  - Whether OpenAI's per-session cache key helps or hurts, which the repo itself marks as unmeasured.
- **Shipped vs unreleased.** Line numbers cite 90acb30c. In the shipped 6eaf445a they sit about 1-6 lines off in task.ts and about 12 lines off in prompt.ts. The only unreleased changes in this area are:
  - learned small-model routing for general subagents (task.ts:906-912)
  - the learned "solo" advice and lower Thorough effort
  - a `prompt_source` permission prompt, which can block the main chat box more often

  All other mechanisms described here are identical in the shipped build.