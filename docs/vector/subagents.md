# Working with subagents

Substantial independent tasks can run while you keep chatting with Vector. A delegated batch starts in the background by default. Vector tells you what it launched, continues useful work, and receives compact results when workers finish. Closely timed results are combined into one notification.

You can say:

- “What is the explore agent doing? Check its current progress.”
- “Tell the parser agent to preserve the existing public API.”
- “Ask the test agent to cover the empty-input case too.”
- “Stop the documentation agent, but let the other work finish.”
- “Stop all background work and summarize what was completed.”

Vector uses its task controls to inspect current work or deliver your instruction. A message is admitted at a safe execution boundary; admission does not mean the requested edit has already been made. A finished child is not silently restarted by a message. Continuing finished work is an explicit new instruction using that task's identity.

The Background tasks panel groups work by batch, team or swarm. Expand an agent to inspect recent steps, its dependency IDs and assigned files. **Talk to this subagent** preserves your draft if delivery fails. **Ask Vector about this** adds a progress question to your conversation without discarding your current draft. **Needs you** leads to a pending question or permission request. Available controls reflect each runtime's capabilities; outside agents may report cost without tokens and may not support live messages.

Stopping a prerequisite also stops dependent work. Partial output and completed changes are retained. If a swarm task has already started merging verified changes into staging, Vector records the completed merge before settling the stop. Disconnected desktop observations show the last known state; a lost connection does not prove that the executor stopped. An engine restart does not automatically retry paid work.

## Terminal controls

With the new standalone CLI installed, `/tasks` opens the task board in the TUI. From another terminal, attach to the server that owns the tasks:

```sh
vector tasks list --attach http://localhost:4096 --session ses_PARENT --descendants
vector tasks inspect ses_CHILD --attach http://localhost:4096 --session ses_PARENT
vector tasks message ses_CHILD 'Preserve the existing API' --attach http://localhost:4096 --session ses_PARENT
vector tasks wait --task ses_FIRST --task ses_SECOND --mode all --timeout 30000 --attach http://localhost:4096 --session ses_PARENT
vector tasks stop ses_CHILD --reason 'Requirements changed' --attach http://localhost:4096 --session ses_PARENT
vector tasks stop --all --attach http://localhost:4096 --session ses_PARENT
```

Replace the URL and IDs with the owning server and IDs from `list`. Use `--dir` when selecting a project and `--json` for structured output. Supply server authentication through your existing secure environment; avoid putting a password in shell history. A desktop update does not upgrade a separately installed CLI or WSL engine.

## Delegation boundaries

Each brief should specify the goal, existing findings, owned files and success criteria. Supply a small context pack when the parent already knows the relevant paths or symbols. Dependencies refer to existing task IDs; they cannot refer to another unnamed entry in the same new batch. The parent can explicitly select foreground execution when it cannot continue without the result.

Child and batch budgets tighten the launching run's Run Guard. They cannot increase the parent's cap, and an unrelated new parent turn does not reset an existing child's cap. Known token and dollar usage is counted once; unknown prices remain visible as unknown. Assigned paths are enforced for explicit file-edit tools. Vector also checks shell writes it can identify: redirects, common copy, move and removal commands, and common git operations. It refuses conflicting ownership before a permission prompt and blocks whole-tree git changes while shared helpers are editing. This scan is best effort: interpreter scripts, `bash -c` strings, the V2 bash tool and filesystem MCP servers are not covered. Shell access is not a filesystem sandbox, so isolated workspaces and merge conflict checks remain important for concurrent editing.

The app's parent conversation exposes the engine's task tools. Pure SDK-next V2 parent sessions require their own canonical application-tool integration; this release does not add those tools to every V2 tool catalog.
