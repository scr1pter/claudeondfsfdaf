# Connected workspace: build contract

Branch `connected-workspace`, cut from `origin/main` at `0dcbb8e2` (the self-evolving merge, PR #20). Written 2026-11-09 and revised the same day after a code review (see "Review notes" at the end). Status: CW-01 to CW-08 are built (phases A1 to A3); on 2026-11-11 the build was handed to a new agent (see connected-workspace-handoff.md). The owner confirmed these recommended answers on 2026-11-09: Q2 keeps the generic `/review` and adds `/vectorscope`; Q3 builds `repair` with `off` as the default; Q4 makes `before_commit` default to `offer`; Q6 keeps connect's start route until VectorScope's VS-10 decides. Nothing lands on main without the owner's yes (Q1). Paths are relative to the repository root.

**What the owner asked for.** "Make it so that the vector agent has connections and is interconnected with all other tools in the workspace, even the code review agent, vectorscope. They should be able to work together. Remember vector is local, so vectorscope is a local AI code review tool." And: be mindful that other agents are working on other branches.

**Rules for every work package (WP).**
- The owner uses Vector on this Mac, and heavy local test runs have crashed it. A WP runs only its own test files, one file at a time from the package directory, plus that package's typecheck. Full suites, Playwright and the HttpApi exerciser run in GitHub CI on a temporary branch.
- Never edit a file on the "Do not touch" list (section 7.1). Edits to the shared files in section 7.2 are additive and go at the anchors given there.
- Never touch anything tokenomics or benchmark related. Another agent owns it.
- Never name an open-source project this code may derive from, in code, comments, docs or commit messages. Make no claim of parity with any other product.
- Engine and core runtime code uses no Bun API. The desktop runs the engine bundle under Node.
- Code is named by file and function. Line numbers are from `main` at `0dcbb8e2` and are hints only.
- Push with `git push -u origin connected-workspace`. Never push to `main`. Merging needs the owner's yes.

## 0. What gets built

| # | Piece | In one line |
|---|---|---|
| A | Registry | One list of every workspace member (agents, helpers, tools, runtimes, services, MCP servers, workflows, skills): where it runs, where it sends your code, whether it is ready, and how to reach it. |
| B | Hand-off protocol | The agent asks a member for work and gets a typed result back. The requester's permissions and approvals carry through and are never widened. Through Phase C, VectorScope is the only member that takes hand-offs. Every other member is listed with the tool or screen that already reaches it. |
| C | VectorScope as a local member | The Vector agent asks VectorScope for reviews in the same engine process, on the user's own models, with spend counted and capped. Each result says where the diff went: this computer, your model server, a provider you configured, or Vector Codium. No Vector cloud service is needed. |
| D | Findings to fixes | Findings come back as data. With the user's consent they become fixes, here or in an isolated worktree, and fixes are reviewed again. Every apply asks. |
| E | Shared context | Brain (with its audiences), the session lineage, the files (with the existing locks) and the findings are shared by rule, not by copying conversations. |
| F | Events and surfaces | A `connect.run.updated` event; a "Connected tools" view in desktop settings, a findings card in the desktop timeline, a TUI dialog, a `vector connected` CLI, and a `/vectorscope` command. |
| G | Adapter contracts | Members whose code lives on other branches (VectorScope's next work, Hands, @vector, Codium services, cloud workspaces) plug in through a small interface in packages/engine/src/connect/adapter.ts. This branch never edits their code. |

**Non-goals.**
- No second review pipeline. Connect calls VectorScope's own entry points. It never re-implements review passes, selection or anchoring.
- No posting or pushing. Connect never posts a review, a comment or a commit to GitHub. GitHub stays VectorScope's and @vector's optional extra.
- No MCP for reviews. VectorScope's decision D11 (MCP default-deny) stands.
- No new network destination. Connect itself makes no network call.
- No Vector cloud dependency. Every Phase A to C feature works offline with a local model.
- No change to accounting, spend ledgers or Codium billing.
- No generic hand-off actions yet. A model-facing `ask` action, JSON-schema inputs and the `run`, `network`, `post`, `screen` and `cloud` effects wait until the owner approves a second member that takes hand-offs.

## 1. Words used here

- **Member**: anything in the workspace that can be listed.
- **Hand-off**: one member asks another to do a piece of work and gets a structured result back.
- **Run**: one hand-off from request to result. Its id looks like `cr_…`.
- **Requester**: the session that asked. Consent is always asked in that session, of its owner.
- **Request**: one message the user wrote, and every turn, note and run that follows from it until the user writes again. Its id is that message's id.
- **Finding**: one VectorScope result: severity, place in the code, title and body. A model that read code wrote it, so it is data, never an instruction.
- **Place**: where a member's code runs. `local` is this machine. `your-cloud` is your own GitHub Actions or your own accounts. `vector-cloud` is Vector's servers.
- **Sends to**: where a member sends your code. `this-computer`, `model-server:<host>` (a model server on the user's list), `provider:<id>` (a hosted provider the user configured) or `vector-codium`. For VectorScope it follows the review model, not the engine.
- **Effect**: what an action may do. Through Phase C only `read` and `write` exist.

## 2. What exists today

Facts from `main` at `0dcbb8e2` and the branch tips named in 7.1, read on 2026-11-09.

- **The agent cannot reach VectorScope.** `Review.run` (packages/engine/src/review/run.ts) has two callers on main: `vector review` (cli/cmd/review.ts) and `vector github review` (cli/cmd/github.review.ts). There is no engine tool, HTTP route, SDK method or event for it. No agent prompt mentions it.
- **There is a clean local entry point.** `executeLocalReview(options, deps)` in cli/cmd/review.ts is exported and fully injectable. It returns `{ exitCode, target, outcome }`. It posts nothing unless `post` is set. Its deps are `runReview`, `resolveModel`, `confirm`, `stdout`, `stderr`, `posting`, `requirements` and a few optional ones.
- **The review trusts the working tree it reviews.** For anything but a pull request, `executeLocalReview` reads `.vector/review.json`, `.vector/review.md` or `.vector/REVIEW.md`, and `.gitattributes` from that working tree (`setting = readWorkingFile`). review.json's `model` and `triageModel` come before `agent.review.model` in `resolveReviewModel`. Its `maxCostUsd: 0` means no dollar cap (core review/types.ts), and config.ts sets no maximum. A `maxCost` option replaces the cap rather than lowering it (`withFlags`).
- **There is no cost question.** `deps.confirm` is called only before `--checks` runs other authors' code and before `--post`. A review of more than 50 files on a priced model only prints an estimate.
- **Selection has six buckets.** `inline`, `overflow` (past `maxComments`, which defaults to 10), `outsideDiff` (anchor did not resolve in the diff), `elsewhere`, `nits` and `stillOpen` (core review/select.ts). `matchPrior` and `fingerprint` are exported pure helpers.
- **Review state is per branch only.** The CLI keeps `<git dir>/vector/review/<branch>.json` for branch reviews. If HEAD was already reviewed, it returns the stored outcome without running a review; only the JSON on stdout says `cached: true`. Uncommitted, staged and PR reviews keep no state.
- **Spend rolls up only during a run.** `RunInput.parentID` exists, and review helper sessions are `internal` children. One that starts while its root's run is going counts against that run (the helper rule in `SessionPrompt`, just before `runSteps`). One that starts after the run ended calls `guard.unlink` and then `guard.begin` as its own run, under the user's `budget.run`, which is usually unset. Nobody passes `parentID` today.
- **The review needs only two prompt calls.** `Review.run` uses `SessionPrompt.prompt` and `SessionPrompt.cancel`, nothing else. Those are two of the three calls in `TaskPromptOps` (tool/task.ts), which every tool receives as `ctx.extra.promptOps`. Its `prompt` accepts any session id; it refuses only workflow sessions.
- **A tool cannot take SessionPrompt directly.** `SessionPrompt.node` depends on `ToolRegistry.node`, and session/prompt.ts value-imports tool/registry.ts. review/run.ts value-imports session/prompt.ts. That is why tools import `SessionPrompt` as a type only and `ReviewCommand.handler` loads `@/review/run` and `@/review/model` with `await import`.
- **Core cannot import the engine.** packages/core/package.json depends on schema, llm, plugin and the sqlite packages, never engine.
- **There are four review paths.** `Review.run` (CLI and GitHub job). A separate loop in the desktop renderer (packages/app/src/features/pull-requests/ai-review.ts, `runReview`). The `/review` slash command (command/template/review.txt), a prompt that tells the agent to read `git diff`. The generic `review`, `security` and `judge` subagents (agent/agent.ts). Only the first two share VectorScope's prompts and selection.
- **One link from VectorScope to the agent.** The desktop's "Ask the agent" button sends plain text to the composer (`askAgentPrompt` and `askAgent` in ai-review.ts, via utils/composer-handoff.ts). There is no link the other way, and nothing on the CLI or TUI.
- **Discovery is scattered.** `/agent`, `/skill`, `/command`, `/mcp`, `/experimental/tool`, `/experimental/workflow/saved` and `/experimental/capabilities`, plus desktop IPC for external agents.
- **Hidden helpers are already named.** `core/src/session/helper.ts` allows `vectorscope`, `codespace`, `browser-agent`, `swarm`, `brain`, `research` and `help`.
- **Vector Local already covers VectorScope.** The `local-inference` source in core/src/local-mode/sources.ts says it runs "the agent, subagents, the judge, Vectorscope, research and the helpers on the model servers you list".
- **Owner-only routes live in one function.** `isOwnerOnlyRoute` in packages/server/src/auth.ts (re-exported by the engine) is the only place guests and forwarded requests are refused. A route it does not name is open to guests for GET, and for POST unless it starts with one of a few prefixes (`/api/integration`, `/auth/`, `/provider/`, `/mcp`, `/config`, `/instance/dispose`).
- **"Always ask" is one list.** `requiresApproval` in packages/schema/src/permission-policy.ts makes the engine ask even when a rule allows (`Permission.ask` in engine permission/index.ts starts from it, and only a deny ends it). It also stops auto-accept (`canAutoApprove`) and saved approvals (`canAlwaysApprove`). An `"ask"` default alone can be answered by either.
- **The default permission is allow.** The build agent's rules start with `"*": "allow"` (agent/agent.ts). A new permission id asks only if it gets an explicit `"ask"` default. The `general` subagent uses the same defaults, so its bash is allowed, and the default shell sandbox keeps the network on (tool/shell/sandbox.ts).
- **Merging an isolated child asks only `edit`.** `TaskIsolation` merge asks `edit` with the diff (task/isolation.ts), and `edit` is allowed by default. A child that settles "changed" has its changes committed in its worktree ("Vector subagent: …") and its work instance disposed (`retire`, `TaskPlace.dropWork`).
- **Memory reads an unknown tool as MCP.** `SessionMemory.taint` (engine session/memory.ts) holds memory as `mcp` for any tool id not in `LOCAL_TOOLS` or `DELEGATION_TOOLS`.
- **A guard is missing.** `vector review --pr N --post --yes` is not owner-gated (`CliOwnerGate` covers workflow, tasks and memory writes). An agent's shell could post to GitHub with it. That file is VectorScope's (section 13).

## 3. The connected workspace

### 3.1 Registry

The registry answers three questions for every member: what is it, can it work right now, and how do I reach it.

**Member shape** (packages/schema/src/connect.ts, CW-01):

| Field | Meaning |
|---|---|
| `id` | Stable id: `vectorscope`, `research`, `browser`, `computer`, `tasks`, `workflow:<name>`, `mcp:<name>`, `github-agent`, `remote`, `cloud-workspace`, `external:<id>`, and so on. |
| `kind` | `agent`, `helper`, `tool`, `runtime`, `service`, `mcp`, `workflow` or `skill`. VectorScope is `agent` here. It is not an `Agent.Info`, so the task tool never sees it as a subagent type. |
| `title`, `summary` | Plain words for people. |
| `owner` | `main`, `vectorscope`, `hands`, `vector-at-mention`, `codium`, `cloud-workspaces`, `plugin` or `user`. |
| `place` | `local`, `your-cloud` or `vector-cloud`: where the member's code runs. |
| `sendsTo` | Where the member sends your code (section 1). Absent when it sends nothing. |
| `state` | `ready`, `busy`, `unavailable`, `off` (for example "Off in Vector Local") or `not-installed`, with a `reason` in plain words. |
| `reach` | How to reach it: `connect` (through the hand-off protocol), a tool id (`research`, `browser`, `computer`, `vector_cloud`, `task`, `workflow`), `ui` (a person uses it in the app), or `none`. |
| `actions` | Only for `reach: connect`. Each action has an id, a title, its effects, whether it can run in the background, and a result kind. |
| `activity` | Optional: runs going now and the last run time. |

**One way to reach each member.** Connect does not proxy members that already have a tool. Research, the browser, Hands (`computer`), Vector Cloud, tasks and workflows keep their own tools. The registry lists them with `reach` set to that tool, so people can see them. Connect's own hand-off actions are for members that have no tool: VectorScope only, through Phase C.

**Sources.** The engine composes the list. It never stores its own copy.

| Members | Source |
|---|---|
| Agents and specialists | `Agent.list()`; hidden helpers from `HELPER_NAME` |
| VectorScope | The VectorScope adapter (CW-04). Its `describe()` resolves the review model without a model call and reports `sendsTo` and refusals such as "off in Vector Local", "below 32k context" or "this model cannot make tool calls". |
| Tools | `ToolRegistry.ids()` (HTTP view only) |
| Skills | `Skill.all()` |
| Saved workflows | `WorkflowLibrary.list()` |
| MCP servers | `MCP.status()` |
| Desktop work (Parallel Workspaces, swarm runs, external agents) | `DesktopTasks` for the engine view. The desktop adds detected external agents from its own IPC when it draws the view. |
| Adapter members | `connect/adapters/index.ts`: one line per adapter (section 6) |

**Who sees it.** People see the whole list in the HTTP view (`GET /experimental/connect`, CW-09) and the surfaces built on it. The model sees no list: the `connect` tool's description names VectorScope, the only member it can hand work to. Keeping the registry out of the tool keeps `ConnectHub` out of a dependency cycle with `ToolRegistry`.

### 3.2 Hand-off protocol

**Request.**

| Field | Rule |
|---|---|
| `id` | `cr_` plus a sortable id. |
| `to`, `action` | A member and one of its actions. |
| `requester` | `{ kind: agent \| user \| workflow, sessionID?, agent? }`. `sessionID` is absent only for a run a person starts on a directory with no session (CW-18). A member never appears as a requester (no chains, invariant I9). |
| `requestID` | The request this run belongs to (section 1). Used for the per-request cap. |
| `directory` | The requester's instance directory, a task's isolated worktree (CW-14), or a desktop workspace directory (CW-18). |
| `background` | Run now and wait, or run as a background job with a note when done. |
| `budget` | Optional `maxCostUsd` (greater than 0) and `timeoutMinutes`. They can only lower limits (see Spend). |
| `since` | Optional earlier run id of the same target kind, to compare results (fixed, still open, new). |

**Result.**

| Field | Rule |
|---|---|
| `state` | `completed`, `partial`, `refused`, `failed` or `cancelled`. |
| `verdict` | For reviews: `clean`, `findings`, `blocking`, `incomplete` or `not-reviewed`. A partial review is never `clean` (section 4.2 says how the verdict is derived). |
| `summary` | At most 2,000 characters, written by Vector code, not by a model. |
| `findings` | Typed findings (section 4.4). |
| `sendsTo` | Where this run sent the code. |
| `cached` | True when VectorScope returned the stored outcome of an earlier review of the same commit. |
| `cost` | Cost kind (`free`, `priced`, `plan`, `local`, `unknown`) and dollars only when the cost is not Codium. Codium shows as plan usage, never tokens or prices. |
| `sessions` | The helper sessions the run made, for lineage and the posting guard. |
| `notes` | Deterministic notes, such as "3 files skipped: generated". |

**Lifecycle.** `queued` → `running` (with progress: pass name, a short message, time) → `done`. A run can be cancelled from the tool, the CLI, the TUI or the desktop. Cancel aborts the helper sessions through the hub's helper handle (section 6).

**Permissions carry through, never wider.**
1. Every action declares its effects. Through Phase C the hub accepts only `read` and `write`, and refuses any other effect (I10).
2. `write` maps to the requester's `edit`. If the requester's rules deny it, the run is refused before anything starts. `read` maps to the requester's `read` rules. Before a review the hub takes every `read` pattern that the requester's merged ruleset denies or asks for and that VectorScope's own review rules do not deny. Today that is `.docker/config.json` and `.kube/*` from the build agent's defaults, plus any rule the user added. It globs the review directory for those patterns (tracked, untracked and ignored files; not `.git`). If a file matches, the review is refused with a plain reason that names the pattern, until VS-08 accepts requester denies (section 13). A member never reads what its requester could not.
3. Consent is then asked in the requester's session with `ctx.ask` (or the owner service's equivalent for runs with no tool call):

| What | Permission asked | Default | Who can answer |
|---|---|---|---|
| A read-only review on a model you chose, sent to this computer or your model server, or to your own configured review model when it is not priced | `connect`, pattern `vectorscope.review` | allow (the build agent's `*` default) | A user rule can make it ask or deny. |
| A review on a priced model, or on a model or triage model that the repository's review.json picks | `connect_model`, pattern `<provider>/<model>` | ask, once per request | You, a client's auto-accept, or a saved "Always allow" for that model. |
| Writing: each fix batch, and each merge of a fix worktree into your checkout | `connect_write` | ask, every time | Only you. It is in `requiresApproval`, so no rule, saved approval or auto-accept answers it (VectorScope's decision D10). |
| A command in a fix child | the child's `bash`, check commands only | ask, per command | You, or a client's auto-accept. Every other command, and every network tool, is denied in fix children. |
| Posting | none | — | Connect never posts. |
| Later effects (`run`, `network`, `screen`, `cloud`) | added by the WP that first needs one | — | `connect_cloud` will join `requiresApproval` (CW-23). |

4. The member's own sessions run under the member's fixed rules. VectorScope's sessions keep `reviewPermissionRules` (deny everything, then allow read, grep, glob, list and StructuredOutput). Connect never adds a rule to them.
5. Nothing a model writes can choose trust, model, depth, budget, permissions, target or effects. Only the requester's tool arguments, the user's settings and the member's code do. That includes repository files the reviewed code itself changed (section 4.2, check 1). This is VectorScope's invariant I-2, applied to every member.

**Spend.**
- **The dollar cap.** Each review's cap is the smallest positive value of: review.json's or the environment's `maxCostUsd`, connect's default ($2; `connect.review.max_cost_usd` after CW-09), the tool's `max_cost`, and the run's remaining budget. A 0 or a missing value is skipped, never read as "no cap". The adapter passes the result as `maxCost`.
- **Inside a run.** Reviews count against the requester's run through `parentID` and the helper rule.
- **Outside a run.** A review that starts or keeps going after the root's run ended (CW-08 background runs, CW-13 after-run reviews) gets the ended run's remaining budget from `guard.snapshot`, or $0.50 when that run had no limit, as its cap. It is refused when that run stopped on its budget (`guard.stopped`).
- **Per request.** At most 5 connect review runs per request, whatever findings come back. After that the tool refuses with a plain note. The hub counts the runs recorded on the root session since the last message the user wrote (connect tool parts and connect notes), so turns that a note wakes share the count.
- **Local models** have no dollar cap. VectorScope's step and time limits and the per-request cap still apply.

**Foreground and background.** Foreground runs block the tool call and stream progress through `ctx.metadata`. Background runs are a `BackgroundJob` of type `connect`, started through `BackgroundJob.start`. When they end, a `TaskNotify` note of a new kind `connect` reaches the requester (CW-08). A note about clean work is quiet. A note about blocking findings may start a turn only when the user turned on repair (section 4.3).

**Restarts.** Results persist; runs in progress do not. Each run's result (target kind, head, verdict, `sendsTo`, and the findings with category, side and line) is saved in the `connect` tool part's metadata, or in the connect note for a run with no tool call. Both are stored with the session. `fix`, `findings` and `since` look run ids up in the requester's session. The in-memory ledger (last 50 runs per instance) is only a cache. A background run cut off by a restart is lost, and the run list says so.

### 3.3 Shared context

| Context | What is shared | Rule |
|---|---|---|
| Brain | VectorScope reads linked requirements, constraints, contracts and decisions through `ReviewContext.requirements`, as the CLI does. | Reviewers are the `outward` audience. Personal documents go only when the review sends to this computer or your model server (costKind `local`), and never in a shared review. This is stricter than the CLI's rule, which allows any model that does not train on prompts. |
| Learned skills | Not sent to reviewers by connect. | Placement is VectorScope's VS-26 (section 13). |
| The session | The requester's brief and its lineage (`parentID`). | A member never gets the conversation, the context pack or personal memory. This is the same rule the research tool follows. |
| Files | Members read the same checkout, or a task's isolated worktree. | Writes go through the existing `FileLock`, `FileState` and owned paths. Connect has no writer of its own. |
| Findings | Saved with each run in the requester's session (3.2 Restarts), each with a status (`open`, `fixing`, `fixed`, `still-open`, `new`, `dismissed`). | For branch targets, fixed and still-open come from VectorScope's own state (`selection.fixed`, `stillOpen`). A branch review updates the CLI's state file, as `vector review` does. For uncommitted and staged targets, connect compares with core's `matchPrior` over the saved findings; this is provisional until VS-08. Dismissal written to Brain happens only from a person's click (CW-17). |

### 3.4 Events

- `connect.run.updated` with the whole run (status, progress, result summary). Scoped to the requester's session.

It is defined in packages/schema/src/connect.ts (CW-01) and joins the event manifest in CW-09. Plugins receive it through the existing `event` hook, so a user's own plugin can react to a review without a new API.

There is no `connect.members.changed` event. Nothing changes a member's state without a probe, and connect makes none. Surfaces fetch the registry when they open and again on `connect.run.updated`.

Each surface shows what the others do through events it already has: task updates for helpers and isolated children, `computer.state` for Hands (once merged), the TaskBridge for desktop workspaces, and `connect.run.updated` for hand-offs.

### 3.5 Surfaces

**Desktop.**
- Settings → Agents gets a "Connected tools" section: every member, where it runs, where it sends your code, its state and reason, how to reach it, and switches for the review settings in section 4.3. It is mounted at the end of settings-v2/subagents.tsx, away from the Review and Security copy that VectorScope's VS-09 will probably edit.
- The session timeline draws the `connect` tool call as a findings card (CW-19): verdict, where the diff went, the findings, and "Fix", "Fix in a worktree" and "Dismiss". The card registers itself with session-ui's `ToolRegistry.register`, as the research report card does, so it does not wait for Hands. Each button sends a message in the user's name that names the run and the findings. The fix itself still asks `connect_write` and shows the findings.
- The Tasks pane gains connect rows after Hands merges (Hands edits that pane).

**TUI.** A "Connected tools" dialog (members and recent runs, cancel a run) beside the existing tasks dialog, opened from the command list. It never takes the slash name `connect`, which stays the TUI's "Connect provider" command. `/vectorscope` works in the TUI too.

**CLI.** The noun is `vector connected`, so it is not confused with connecting a provider.
- `vector connected list [--json]` shows the members.
- `vector connected runs [--session <id>] [--attach <url>] [--json]` shows recent runs.
- `vector connected review [--uncommitted|--staged|--base <ref>] --session <id> --attach <url>` hands a review into a running session, so its result lands where the agent can act on it.
- `vector connected cancel <run>`.
- `review` and `cancel` refuse under the agent marker (`CliOwnerGate.refuse`), so an agent's shell cannot get around the tool's consent.
- `vector review` stays VectorScope's: a one-shot review in its own process. Section 13 asks VectorScope to refuse `--pr` and `--post` under the agent marker and to read a 0 cap as the default there. The connect tool's description tells the agent never to run `vector review` from the shell.

**Composer.** `/vectorscope [uncommitted|staged|branch <base>]` is a built-in command, registered only while `experimentalConnect` is on. Its template asks the agent to call `connect` with `action: review`. This branch adds no `@vectorscope` mention. The engine turns an agent mention into a task-tool call (session/prompt.ts), and the agent id `vectorscope` belongs to VectorScope's VS-09.

## 4. VectorScope as a local review agent

### 4.1 Where it runs

- In the same engine process as the agent: the desktop sidecar, the TUI, `vector run` or `vector serve`. Its helper sessions go to the local database and are children of the requester.
- On the user's chosen models. The order is VectorScope's own: `.vector/review.json`, then `agent.review.model`, then the configured default. Connect never picks a model. Because review.json comes first, connect asks `connect_model` before using a model or triage model that review.json picks, and does not review at all when the reviewed changes edit review.json (4.2, check 1).
- With Vector Local on, only on the model servers the user lists. Cloud models are refused with VectorScope's own message ("off in Vector Local"). The Connected view says how to choose a local review model.
- Local models must have at least 32k context (`MIN_CONTEXT`) and must make tool calls (`capabilities.toolcall`), because the review forces a StructuredOutput call. The adapter's `describe()` checks both without a model call and shows a plain reason.
- **Where the diff goes.** `describe()` and every result report `sendsTo`, derived from the resolved review model: `vector-codium` when `Billing.isCodium(providerID)`; `this-computer` or `model-server:<host>` when costKind is `local` (`provider.line(model).local`; the host comes from the model's API URL); `provider:<id>` otherwise. The tool output and the Connected view print it. The word "local" appears only when `sendsTo` is this computer or a model server.
- Inside a cloud-workspaces container the engine runs on Vector's servers. Connect withholds the "local" wording there once that owner marks the engine's place from their runtime marker (section 13).
- A local model has no dollar cap, only VectorScope's step and time limits and connect's per-request cap.

**What needs the cloud, and stays optional:** the GitHub review job (GitHub's runner, the npm CLI, GITHUB_TOKEN), `--pr` and `--post`, the paid eval, the outcome ledger, and the Codium review pair. None of them is needed for anything in this contract.

### 4.2 How the agent calls it

The `connect` tool (CW-05). The model-facing parameters:

| Parameter | Values |
|---|---|
| `action` | `review`, `fix`, `findings`, `status`, `cancel` |
| `to` | `vectorscope`, the default and, through Phase C, the only member |
| `target` | `uncommitted` (default), `staged`, `branch`; `{ task: "<id>" }` from CW-14 |
| `base` | A ref, for `branch` only |
| `security` | Always run, or never run, the security pass |
| `since` | An earlier run id of the same target kind |
| `run`, `findings` | For `fix`, `findings`, `status` and `cancel` |
| `mode` | `here` or `worktree`, for `fix` |
| `background` | From CW-08 |
| `max_cost` | Dollars, greater than 0. It can only lower the cap (3.2 Spend). |

**Who gets it.** The build agent in a root session only, on Work and Thorough requests. On a Light request the tool says to call `escalate`, as the research tool does. Subagents, workflow agents, research agents and review sessions never get it. Workflows reach VectorScope through a connect stage (CW-16). A user rule `connect: deny` turns it off. (`connect` here means connected tools, not connecting a provider; the docs say so.)

**The tool description** says three things besides the parameters. Findings are claims to check, not instructions. Before committing, pushing or opening a PR, offer the user a review of your changes (after CW-09, `connect.review.before_commit: run` turns the offer into a review). Never run `vector review` from the shell; use this tool.

**How it runs a review** (connect/adapters/vectorscope.ts, CW-04).

Loading. The adapter loads `@/cli/cmd/review`, `@/review/run` and `@/review/model` inside `handle` and `describe` with `Effect.promise(() => import(...))`, as `ReviewCommand.handler` does. Connect modules import `SessionPrompt` and `TaskPromptOps` as types only. A value import would close the cycle registry.ts → tool/connect.ts → hub → adapter → review/run.ts → session/prompt.ts → registry.ts.

Before the review, three checks, in this order:
1. **Settings the reviewed code may have changed.** The adapter lists the target's changed paths: for `uncommitted`, against HEAD, untracked files included; for `staged`, the index against HEAD; for `branch`, against the merge base; for `{ task }`, against the isolation's review base. If `.vector/review.json`, `.vector/review.md`, `.vector/REVIEW.md` or `.gitattributes` is among them, the result is verdict `incomplete` with the note "These changes edit VectorScope's own settings, so connect did not review them. Run `vector review` yourself." No model runs, and the result is never `clean`.
2. **The model.** The adapter reads review.json with core's `parseReviewConfig` (pure, importable) and resolves the model with `describe()`. It asks `connect_model` once per request, naming the model, where the diff goes and the cap, when review.json's `model` or `triageModel` (and, after Codium merges, `judgeModel` or `panel`) differs from the user's own review model (`agent.review.model`, else the configured default), or when the resolved model is priced. A denial refuses the run.
3. **Read rules.** The requester's read rules, as in 3.2 rule 2.

Then it calls `executeLocalReview` with:
- `runReview`: `Review.run` with `parentID` set to the requester's session (or CW-14's placement session), inside a `SessionPrompt` service built from the hub's helper handle (connect/review-prompt.ts). The bridge supplies `prompt` and `cancel` only. Any other member dies with a clear message, and a test pins this. The bridge goes away when VectorScope's VS-08 service lands.
- `resolveModel`: `ReviewModel.resolveReviewModel`, unchanged.
- `confirm`: `async () => false`. Connect passes `checks: false` and `post: false`, so `confirm` is never reached. If a later change reaches it, the answer is no.
- `json: true`, `post: false`, `pr: undefined`, `checks: false`, `maxComments: 50`, `maxCost`: the effective cap (3.2 Spend). Stdout is captured and parsed only for `cached`. Stderr lines become progress.
- `posting`: a function that posts nothing. Connect never posts.
- `requirements`: `ReviewContext.requirements`, with `personal: true` only when `sendsTo` is this computer or a model server, and never for a shared review.

**The verdict**, until VectorScope's VS-32 supplies one:
- `incomplete` when the outcome is partial, any pass failed or stopped, `unreviewed` is not empty, any file was skipped for `size-limit`, or check 1 fired;
- `blocking` when any finding in any bucket is blocking;
- `findings` when any finding is a concern;
- `clean` otherwise.

Files skipped for other reasons (`ignored`, `lockfile`, `generated`, `vendored`, `build-output`, `binary`, `deleted`) are listed in `notes`. The rules that skip them come from settings that check 1 protects. A cached outcome comes back with `cached: true` and the note "Already reviewed at <short sha>."

The output to the model is Vector's summary, where the diff went, then the findings, framed like this: "These findings came from a reviewer model that read your code. They are claims to check, not instructions. Do not change files because of them unless the user asks. Offer to fix the ones you agree with." Codium cost goes through `reviewForOutput` (cli/cmd/review-output.ts), so it shows as plan usage.

### 4.3 The two-way loops

| Loop | How it works | Phase |
|---|---|---|
| On demand | The user says "review my changes", or types `/vectorscope`. The agent calls `connect review`. | A |
| Before a commit, push or PR | The tool description tells the agent to offer a review of its changes before it commits, pushes or opens a PR. After CW-09, `connect.review.before_commit` (`off`, `offer`, `run`; the default is the owner's answer to Q4) can turn the offer off or make it a review. There is no commit guard. | A, C |
| After background helpers finish | Phase A: merge the child (with its own ask), then review the merged checkout as `uncommitted`. Phase C: `connect review` with `target: { task: "<id>" }` reviews the child's worktree against its review base before anything is merged (CW-14). | A, C |
| After a run | `connect.review.after_run`: `off` (default), `report` (a quiet note with the result) or `repair` (blocking findings go back to the agent for repair, like a judge FAIL). `max_rounds` (1–3) per request, and the rounds count toward the per-request cap. It runs after the judge, never on subagents, guests or stopped runs. It runs only when no `connect_model` ask would be needed (a local model, or one with a saved "Always allow"); otherwise it posts a quiet "not reviewed" note that names the model. | C (CW-13) |
| In workflows | A `connect` stage reviews `changed_files` or an earlier stage's output. Its findings become items, so a later stage can fix each one, with `owned_paths` set by the owned-path rule below. | C (CW-16) |
| Findings become tasks | `connect fix` with finding ids. `mode: here` returns a brief in which the finding bodies sit in a labelled untrusted block; the agent fixes them itself under its normal permissions and file locks. `mode: worktree` starts a hidden `connect_fix` child with `isolation: "worktree"`, owned paths from the owned-path rule, and a checked JSON result (`fixed`, `skipped` with reasons). Its brief also keeps finding bodies in a labelled untrusted block. Each batch asks `connect_write` and shows the findings. Merging a fix worktree into your checkout asks `connect_write` again with the diff, or you merge it yourself from the Tasks pane. | A (CW-07) |
| Fixes are re-reviewed | `connect review` with `since: <run>`, on the same target kind. After `here` fixes, the re-review targets `uncommitted`. After a worktree fix in Phase A, the re-review targets the merged checkout as `uncommitted`. Labels come from 3.3. The per-request cap stops re-reviews whatever the finding ids. | A, C |
| VectorScope to Vector from the desktop | Today: "Ask the agent" (plain text). Next: the panel registers its findings with the engine (`POST /experimental/connect/findings`). The composer message then names a run id, so the findings travel as data, not pasted text (CW-15). VectorScope's owner switches the button in their file, after the route agreement in section 13. | C, D |
| Brain | Requirements reach connect reviews as they reach CLI reviews. Dismissal from a person's click goes to Brain's `review` kind (CW-17). | A, C |
| GitHub | Optional. The GitHub review job and `--pr`/`--post` stay as VectorScope and @vector built them. Connect never needs them. | none |

**The owned-path rule** (core connect/policy.ts, CW-02). A fix may write only the paths of findings whose anchor resolved in the reviewed diff (the `inline`, `overflow`, `elsewhere` and `nits` buckets; never `outsideDiff` or `stillOpen`), intersected with that diff's changed files, minus `.github/**` and `.vector/**`. A model never widens it.

**The `connect_fix` agent** (agent/agent.ts, CW-07) is hidden and native, so the model cannot launch it with the task tool (tool/task.ts refuses a hidden native subagent it was not invoked with). Its rules are `Permission.merge(defaults, user, fixed)`, so the fixed part comes last and wins. The fixed part denies everything, then allows read, glob, grep, list, edit, write, apply_patch and StructuredOutput. It sets bash to `ask` for connect's check-command list (test and typecheck commands with no flags, the same list as VectorScope's review checks) and keeps every other command denied. It denies webfetch, websearch, `network_command`, `mcp:*` and task.

**Consent summary.** A read-only review on a model you chose, sent to this computer or your model server, needs no question. A priced model, or one the repository picks, asks once per request. Every fix batch, and every merge of a fix worktree, asks every time, and no rule or auto-accept answers it. Commands in fix children ask one by one, and their network tools are denied. Posting never happens through connect.

### 4.4 Finding shape

`ConnectFinding` (schema/src/connect.ts):
- `id`: VectorScope's finding id (`Finding.id`).
- `severity`: `blocking`, `concern` or `nit`.
- `category`, `path`, `line`, `side`, `title`.
- `body`: untrusted text, at most 4,000 characters. Empty for still-open findings from VectorScope's state.
- `source`: `review` or `security`.
- `verified`: whether the verify pass confirmed it.
- `suggestion`: VectorScope's suggestion text, when allowed.
- `bucket`: `inline`, `overflow`, `outside-diff`, `elsewhere`, `nit` or `still-open`.
- `status`: as in section 3.3.

Connect fills it from every selection bucket, in VectorScope's own order: `inline`, `overflow`, `outsideDiff`, `elsewhere`, `nits`, `stillOpen` (select.ts). It asks for `maxComments: 50`. It never re-ranks or re-filters. It cuts only at the schema's limit of 200 and adds a note when it does. Every bucket counts toward the verdict.

## 5. Every other workspace tool

**Loops this contract builds.**

| Member (owner) | Loop with the agent and VectorScope | Built by | Waits for |
|---|---|---|---|
| VectorScope (main's code) | Review, findings, fix, re-review, from the agent's tool and `/vectorscope`. | CW-04 to CW-08 | Nothing |
| Task tool, background helpers, worktree isolation (main) | Fix findings in a worktree child, merge it with a fresh ask, re-review the merged checkout. Later: review the child's worktree before the merge. | Fix in a worktree: CW-07. Review before merge: CW-14 | VS-08, only if CW-14's placement test fails |
| Workflows (main) | A `connect` stage: implement, review, fix each blocking finding, review again. | CW-16 | Nothing |
| Judge gate (main) | The judge checks completion. VectorScope finds defects. With both on, the judge runs inside the run and the review runs after it. Repair rounds are capped separately and by the per-request cap. | CW-13 | Nothing |
| Brain (main) | Requirements into reviews, unchanged. Dismiss from a person's click into Brain's `review` kind. | CW-17 | VectorScope confirming that kind (section 13) |
| Plugins (main) | Plugins see `connect.run.updated` through the `event` hook, for example to tell a chat channel a review finished. Review sessions never get plugin tools. | CW-09 | Nothing |
| Desktop session timeline and settings (main) | The findings card and the Connected tools view. | CW-19, CW-12 | Nothing |
| Parallel Workspaces, swarm runs, external agents (main, desktop) | "Review with VectorScope" on a workspace card before "Open pull request" or merge, through a directory-only run (these workspaces run on the v2 session engine, so there is no engine session to attach to). Optional review before a swarm worker merges into staging, off by default. | CW-18 | Nothing |
| Scheduled agents (main, desktop) | A scheduled `/vectorscope branch main` gives a nightly review. Its findings are saved with the run in that session, so a later "fix these" there finds them. Hands is never used there. | CW-06, CW-07 | Nothing |
| Vector Local (main) | Governs every member. The registry shows each member's place and where it sends code. Cloud members show "Off in Vector Local". | CW-03, CW-12 | Nothing |

**Listed only: the agent already has these, and connect changes nothing.**
- Research (main): the agent's own `research` tool. A report may go into a fix brief, never to the reviewer, until VectorScope's VS-16 adds a typed context input.
- Terminal, shell and background shells (main): fix work runs checks under the shell's own rules. Review-side checks wait for VectorScope's VS-18 and VS-30.
- Browser (main, desktop): the agent may check a fixed web page in a root conversation. Browser output never goes to the reviewer.
- MCP servers (main): listed with status. Reviews never get MCP (D11); VectorScope's VS-14 and VS-15 decide more.
- Vector Cloud deploy and Publish (main, desktop): listed. A "review before publish" step needs a later WP and the owner's yes.
- Desktop GitHub and CI watch (main): listed. Merging a CI repair brief with open findings waits for VectorScope's panel to adopt CW-15.
- Server, attach and ACP (main): attached clients and ACP editor sessions get the same tool and routes as any client.

**After other branches merge.**

| Member (owner) | On main today | After the merge | Who and when |
|---|---|---|---|
| Vector Hands (hands, PR #22) | Listed as "not in this build". | List-only adapter and Tasks pane rows. The agent may verify a native UI fix with `computer` in the user's own conversation, with Hands' own asks; never from background runs, workflows, the after-run review or scheduled runs. Screenshots never go to the reviewer. | This branch, CW-21 |
| @vector and the GitHub review job (vector-at-mention, PR #25) | Listed with installed state (`.github/workflows/vector.yml`). | The GitHub agent adapter. A hand-off to @vector only if the owner says yes (CW-22's prerequisite). | CW-22 |
| Codium Remote (codium, PR #24) | Nothing on main; waits for the codium merge. | The phone sees connect tool cards, answers asks once with a passkey, lists runs and starts a review. | Codium's owner, CW-23 |
| Codium Playbooks (codium) | Nothing on main; waits for the codium merge. | "Implement, review, fix" recipes once workflows have connect stages and the publish check accepts read-only connect stages. | Codium's owner, after CW-16 |
| Codium Second opinion (codium) | Nothing on main. | VectorScope's own model resolution picks up the review pair. Connect adds no second model mapper. | Automatic |
| Codium ops: On Call, Release Guard, Ship Desk (codium) | Nothing on main. | Listed as `vector-cloud` services with status only. They run on servers and cannot reach a local reviewer. | A design for "Vector everywhere" |
| Codium Brain Vault (codium) | n/a | No link needed. Connect keeps no memory of its own. | n/a |
| Codium hosted computer, Done by Morning (codium, not on origin) | Not listed. | Reserved adapter slot. Any hand-off sends code or a screen to Vector's cloud, so it asks `connect_cloud` every time. | Code on origin, the owner's yes, CW-23 after Hands |
| Cloud workspaces (cloud-workspaces, PR #21) | Nothing on main; waits for the cloud-workspaces merge. | The engine in each container has the same tool. The supervisor's proxy allows the connect routes. The engine's place comes from the runtime marker. | Its owner, CW-24 |

## 6. Adapter contracts

Members whose code lives on other branches plug in through one small interface. This branch defines it in the engine, because the helper handle uses engine prompt types. Owners satisfy it on their branch or in a later merge, by adding one file under packages/engine/src/connect/adapters/ and one line to its index. packages/core/src/connect/ holds only the pure policy, findings and framing code over the schema/src/connect.ts types.

```ts
// packages/engine/src/connect/adapter.ts (CW-03)
import type { SessionPrompt } from "@/session/prompt" // type only
import type { SessionID } from "@/session/schema"

export interface ConnectAdapter {
  readonly id: string                    // member id, e.g. "hands"
  readonly owner: Connect.Owner          // "hands" | "vectorscope" | ...
  /** No model call and no new network destination. It may read a member's own cached availability. */
  readonly describe: () => Effect.Effect<Connect.Member>
  /** Absent for list-only members. */
  readonly handle?: (
    request: Connect.Request,
    context: HandoffContext,
  ) => Effect.Effect<Connect.Result, Connect.Refusal>
}

/** Accepts only internal sessions whose parent is this run's requester or its placement session; never the requester. */
export interface HelperHandle {
  readonly prompt: (input: SessionPrompt.PromptInput) => Effect.Effect<SessionV1.WithParts>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
}

export interface HandoffContext {
  readonly runID: string
  readonly sessionID?: string            // the requester; absent for a directory-only run
  readonly requestID: string
  readonly directory: string
  readonly abort: AbortSignal
  readonly ask: (consent: Connect.Consent) => Effect.Effect<void, Connect.Refusal>
  readonly progress: (update: Connect.Progress) => Effect.Effect<void>
  readonly helper?: HelperHandle         // the vectorscope adapter only
  readonly remainingUsd?: number         // from the run guard; undefined when uncapped
}
```

The hub builds the helper handle from `ctx.extra.promptOps` in a tool call, or from `SessionPrompt` in the owner service (CW-09). It checks every session id against the run before it passes a call on. Only the vectorscope adapter receives it. The hub checks effects, asks consent, records the run, emits events and frames the result. An adapter does the work only. It cannot widen its own effects at run time, because the hub checks the declared effects first.

**What each owner adds, and what works before they do.**

| Owner | What they would add | Where | What works before |
|---|---|---|---|
| VectorScope | VS-08: a review service that takes an invocation (target, directory, trust, budget, `parentID`) and returns the outcome. A session-scoped target, a worktree target that places its sessions, a stateless call, a settings source for agent-written targets, and requester read denies. VS-32's verdict wired, so `not-reviewed`, `incomplete` and `clean` come from VectorScope, not from connect. VS-10: the desktop panel calls the engine service, and "Ask the agent" calls `features/connect/handoff.ts`. VS-12: their own fix mode, which connect's `fix` routes to when present. | Their files only. The swap on our side is one file (CW-20). | Reviews through `executeLocalReview` on main's copy, with connect's checks (4.2). The verdict is derived as in 4.2. Fixes are done by the Vector agent. |
| Hands | Nothing in connect's files. This branch writes adapters/hands.ts after the merge (CW-21): list-only, `reach: "computer"`, state and reason from `ComputerAvailability.unavailable()`. | connect/adapters/hands.ts (this branch) | The registry lists Hands as "not in this build" when the `computer` tool id is absent. |
| @vector | `adapters/github-agent.ts`: installed state from `WORKFLOW_FILE`, the CLI pin against `GithubAgents.MIN_AGENTS_CLI`, and, if the owner says yes, a `task` action that asks to post a `/vector` request (`post` and `network` effects, asked every time). A decision on whether `connect` is withheld on GitHub Actions through `actionsWithheld`. | connect/adapters/github-agent.ts; their registry code for the withholding | Listed from `WORKFLOW_FILE`. No hand-off. |
| Codium | Remote: `GET /experimental/connect`, `GET /experimental/connect/runs` and the review start route in `REMOTE_ROUTES`, under the once-only passkey rule. Playbooks: the publish check accepts `connect` stages with read-only actions. Hosted computer: an adapter with the `cloud` effect only. | Their remote-routes.ts, playbooks/check.ts, and connect/adapters/hosted-computer.ts | Nothing on main. Remote and Playbooks exist only on the codium branch. |
| cloud-workspaces | The supervisor's engine proxy allows the connect GET routes and the review start route. The engine's place comes from their runtime marker. The publish screen shows the last verdict. | packages/cloud-workspaces/src/protocol.ts and their web page | Nothing on main. Cloud workspaces exist only on the cloud-workspaces branch. |

## 7. Respecting the other agents

### 7.1 Do not touch

Branch tips read on 2026-11-09: hands 2171efc6, codium eed4bc45a and vector-at-mention c65d6b5d1 (both have merged main, so their hunks sit relative to 0dcbb8e2), vectorscope bee92d8e9 (165 commits behind main), cloud-workspaces ad81939c, process-finish d2156cb2, release-coordination, finish-checks.

| Owner | Files |
|---|---|
| Tokenomics and benchmarks | docs/benchmarks/\*\*, scripts/benchmarks/\*\*, scripts/cost-profiler/\*\*, docs/investors/\*\*, docs/vector/build/tokenomics-\*.md, packages/web/src/pages/docs/tokenomics.astro, design-lab/designs/tokenomics.html, packages/core/script/bench-knowledge.ts, packages/engine/script/bench-search.ts, packages/app/e2e/performance/\*\*, packages/core/src/session/runner/{llm,publish-llm-event,model}.ts, packages/engine/src/session/processor.ts, packages/core/src/spend-guard.ts, packages/app/src/features/economics/\*\*, packages/engine/src/tool/{task,task-manage}.ts. Every tokenomics and benchmark branch. Connect only calls their exported APIs (`SpendGuard` reads, `TaskTool.execute`, the `TaskPromptOps` type). |
| VectorScope | packages/core/src/review/\*\*, packages/engine/src/review/\*\*, packages/engine/src/cli/cmd/review.ts and review.render.ts, packages/engine/script/vectorscope-\*.ts, script/vectorscope-eval/\*\*, .github/workflows/vectorscope-eval.yml, packages/app/src/features/pull-requests/{ai-review.ts,pull-requests.tsx}, packages/core/src/brain/{code,scan}.ts, packages/core/src/local-mode/guard.ts, packages/engine/src/util/tree-sitter.ts, docs/vector/build/vectorscope-\*, packages/web/src/pages/docs/vectorscope.astro. Reserved names: core review/{invocation,thread-context,fix-proposal}.ts, engine review/{service,memory,fix,mcp,checks}.ts, agent id `vectorscope`, agent/prompt/vectorscope.txt. |
| Hands | packages/desktop/native/\*\*, packages/desktop/scripts/\*\*, packages/desktop/src/main/computer-\*.ts, packages/engine/src/computer/\*\*, tool/computer.{ts,txt}, mcp/computer-policy.ts, httpapi {groups,handlers}/computer.ts, packages/core/src/computer/\*\*, core v1/config/computer.ts, packages/schema/src/{computer,computer-apps,computer-event,hands}.ts, packages/app/src/features/computer/\*\*, packages/server/src/computer-privacy.ts, .github/workflows/computer-helper.yml, docs/vector/build/hands-\*. Reserved: tool id and MCP name `computer` in any letter case, permission ids `computer_*`. |
| @vector | packages/engine/src/cli/cmd/github.\*, packages/core/src/github-agents.ts, core review/{workflow,command,schedule,state}.ts, api/cloud-agents/\*\*, api/\_lib/cloud-agents-\*.ts, api/\_lib/github-{oidc,api,app}.ts, packages/desktop/src/main/github-\*.ts, engine session/retry.ts, session/llm/request.ts, cli/vector-account.ts, effect/app-node-builder-v1.ts, .github/workflows/vector-at-mention.yml. |
| Codium | api/\_lib/{codium-\*,model-plan-\*,hosted-\*}.ts, api/{model-plans,vault,remote,ops,notify,roadmap,hosted}/\*\*, packages/{relay,ops-worker,hosted-computer}/\*\*, core {vault,playbooks,remote,webauthn}/\*\*, desktop main {remote-\*,vault-\*,ops,bug-report,vector-account,hosted-\*}.ts, engine cli/cmd/{vault,ship}.ts, session/second-opinion.ts, settings-v2 account, usage, memory and general pages, app features/cloud/hosted/, packages/web/src/components/marketing/account/\*\*, vercel.json, .env.example. Names: relay, remote, hosted, vault. |
| cloud-workspaces | packages/cloud-workspaces/\*\*, api/{\_lib/,}cloud-workspaces.ts, packages/web/src/components/workspaces/\*\*, packages/web/src/pages/workspaces.astro, test/cloud-workspaces-\*, api/account/delete.ts, packages/web/astro.config.mjs, AccountPage.tsx. Names: `workspaces`, `cloud-workspaces`. |
| process-finish (PR #26) | packages/core/src/{background-job,background-job-store,owned-process,cross-spawn-spawner}.ts and their tests, packages/engine/src/background/job.ts, packages/engine/src/task/shells.ts, packages/engine/src/tool/shell/windows-\*.ts, engine test/task/shells.test.ts, test/tool/shell-windows-process.test.ts. It adds `updateMetadata` to the `BackgroundJob` interface. |
| release-coordination (PR #27) | docs/vector/build/release-\*.md, docs/vector/build/multiagent-merge-plan.md, docs/vector/build/evidence/\*\*, docs/vector/owner-actions/release-199113.md, scripts/release-readiness/\*\*, engine test/session/learning-fixture.ts. |
| finish-checks (PR #23) | packages/engine/test/local-mode/local-run.test.ts, packages/engine/test/task/isolation-terminal.test.ts. |
| Everyone (avoid entirely) | packages/engine/src/session/{prompt,system,tools,llm,compaction,message-v2,task-size}.ts, tool/{shell,terminal,tool}.ts, provider/provider.ts, packages/app/src/pages/{layout,layout-new,session,new-session}.tsx, components/prompt-input\*, context/{platform,global,prompt,server-session,permission\*}.tsx, features/background-tasks/\*\* until Hands merges (except engine-capabilities.ts, workflow-model.ts and their tests, which Hands does not touch; Hands edits only the pane, button, css, computer card and use-background-tasks files there), desktop main index.ts, ipc.ts, preload/\*, renderer/index.tsx, core local-mode/sources.ts, .github/workflows/{test,typecheck}.yml, packages/cloud/src/workflow-compliance.test.ts, engine test/compliance/egress-inventory.test.ts, .husky/pre-push, turbo.json, .prettierignore, .oxlintrc.json, DEPENDENCY_NOTICES.md. |

Connect adds no network source, so it never needs core local-mode/sources.ts or the egress inventory test. It changes no workflow file.

### 7.2 Shared files: additive lines only

Each line goes at the anchor named, at least two unchanged lines away from the hunks other branches already have there.

| File | Lines | Anchor | Nearby hunks elsewhere |
|---|---|---|---|
| packages/engine/src/tool/registry.ts (CW-05) | 6 | Import after `import { ResearchTool } from "./research"`. `yield* ConnectTool` after `const researchtool = …`. `connect: Tool.init(…)` after `research: Tool.init(researchtool),`. `...(flags.experimentalConnect ? [tool.connect] : [])` after `tool.research,`. The offer filter after the `ResearchTool.id` line in `tools()`. `ConnectHub.node` after `TaskIsolation.node,` in the deps. | Hands near the import block (~L76), yields (~L173), init (~L311), builtin (~L347), `tools()` (~L395–405) and the top of deps. @vector in `all()`. |
| packages/engine/src/agent/agent.ts (CW-05, CW-07) | 2 + ~16 | `connect_write: "ask"` and `connect_model: "ask"` after `vector_cloud_hosting: "ask",` in the defaults (CW-05). The hidden `connect_fix` agent after the `general` agent's block, before `explore: {` (CW-07); its prompt is a new file agent/prompt/connect-fix.txt. | Hands at ~L49, ~L86, ~L302, ~L361, ~L411, ~L469 and ~L853. |
| packages/schema/src/permission-policy.ts (CW-07) | 2 | `const CONNECT_ALWAYS = new Set(["connect_write"])` after the `CLOUD_WRITES` set. `CONNECT_ALWAYS.has(permission ?? "") \|\|` after `permission === AGENT_MARKER \|\|` inside `requiresApproval`. Do not touch the doc comment above it. | Hands adds a block at ~L73, rewrites `requiresApproval`'s doc comment, adds a `computer_` line before `MEMORY_SOURCE` and shell lines after `NETWORK_COMMAND`. |
| packages/engine/src/session/memory.ts (CW-05) | 2 changed | In `taint`, the two `DELEGATION_TOOLS.has(tool)` call sites (~L967 and ~L972) also accept `tool === "connect"`, so a connect call holds memory as `subagent`. Not the `DELEGATION_TOOLS` line itself (L355). | Hands adds `"computer"` to `WEB_TOOLS` and edits its comment (~L357–364). |
| packages/engine/src/effect/runtime-flags.ts (CW-03) | 1 | `experimentalConnect: enabledByExperimental("VECTOR_EXPERIMENTAL_CONNECT")` after `experimentalIconDiscovery`. | None |
| packages/engine/src/command/index.ts (CW-06) | ~14 | Import `RuntimeFlags`; `VECTORSCOPE` in `Default`; the command after the `REVIEW` block, registered only when `flags.experimentalConnect`; `RuntimeFlags.node` in `node`'s deps. | None |
| packages/engine/src/task/notify.ts (CW-08) | ~10 | Kind `connect` in `Note.kind`; a `connectNotification` branch in `metadata()`. | None |
| packages/server/src/auth.ts (CW-09) | 2 | A comment and `if (route === "/experimental/connect" \|\| route.startsWith("/experimental/connect/") \|\| /^\/experimental\/session\/[^/]+\/connect$/.test(route)) return true` after the `/config/prompt-trust` line, for every method. | Hands adds `/computer` lines just above `/memory` (~L192). |
| packages/server/src/auth.test.ts (CW-09) | ~15 | A new test after the isolated-subagent merge test: a guest is refused every connect route, GET and POST. | None |
| packages/engine/src/config/config.ts (CW-09) | 1 | `next.connect = repositoryConnect(next.connect, base.connect)` (or a delete when it returns nothing) after the research block in `projectExecutableConfig`, before `if (!trusted)`. The function lives in a new engine connect/config.ts. | Hands adds `delete next.computer` at ~L93 and edits the layer at ~L2097. |
| packages/engine/src/index.ts (CW-10) | 2 | Import after `TasksCommand`; `.command(ConnectedCommand)` after `.command(TasksCommand)`. | Codium after `MemoryCommand`; @vector near `McpCommand` and the pre-parse block. |
| httpapi api.ts and server.ts (CW-09) | 2 + 4 | Import after `TeamsApi` (not between `ConfigApi` and `ControlApi`, where Hands puts `ComputerApi`). `.addHttpApi(ConnectApi)` after `.addHttpApi(MemoryApi)`. Handler after `memoryHandlers`. In server.ts, `import { ConnectOwner }` after the `WorkflowOwner` import and `ConnectOwner.node,` after `WorkflowOwner.node,`. | Hands at server.ts ~L22, ~L107, ~L186, ~L248 and ~L312. |
| httpapi groups/experimental.ts and handlers/experimental.ts (CW-09) | 1 + 1 | `connections` after `backgroundShells` in `CapabilitiesResponse` and in the handler's object. | Hands adds `computer` after `backgroundSubagents` and after `return {`. |
| packages/schema/src/event-manifest.ts (CW-09) | 2 | Import after `MemoryEvent`; `...Connect.Event.Definitions` after `...MemoryEvent.Definitions`. | Hands after `QuestionV1`. |
| packages/engine/test/event-manifest.test.ts (CW-09) | 2 | `expect(EventManifest.Latest.get("connect.run.updated")).toBe(…)` after the `research.updated` line, and the import. The `Latest.size` line is shared with Hands (it sets 101): CW-09 sets it at its final rebase to the real size, 101 on main alone or 102 with Hands. | Hands edits the size line and adds `computer.state` below it. |
| packages/core/src/v1/config/config.ts (CW-09) | 2 | `connect` after `research`. | Hands adds `computer` near L291. |
| packages/app/src/features/background-tasks/engine-capabilities.ts (CW-09) | 1 | `"connections"` after `"backgroundShells"` in `FLAGS`. Exempt from the background-tasks rule (7.1). | None |
| packages/app/src/components/settings-v2/subagents.tsx (CW-12) | 2 | Import with the other imports; the Connected tools section mounted at the end of the page, far from the Review and Security copy (~L334–337, ~L477–480). | None today. VectorScope's VS-09 will probably edit the Review/Security copy. |
| packages/app/src/pages/session/session-side-panel.tsx (CW-19) | 2 | Import after the `registerResearchReportCard` import (~L96); `registerConnectFindingsCard()` after `registerWorkflowChip()` (~L3870). | None |
| packages/tui/src/routes/session/index.tsx (CW-11) | ~6 | Open the Connected tools dialog beside the tasks dialog. | None |
| packages/core/src/orchestration/spec.ts, plan.ts; schema/src/workflow.ts; engine orchestration/runner.ts, guide.txt; app features/background-tasks/workflow-model.ts (CW-16) | CW-16 | A third stage kind. | None |
| Generated: packages/sdk/openapi.json, packages/sdk/js/src/v2/gen/\*, packages/client/src/generated\*/\*, packages/web/public/config.json, CLI help snapshot | Regenerated | Only in CW-09, CW-10 and CW-16, at each one's final rebase. Never hand-edited. | Hands and Codium regenerate them too. |

### 7.3 Safe zones and names

- New directories, free on every branch: packages/core/src/connect/, packages/engine/src/connect/, packages/app/src/features/connect/, packages/schema/src/connect.ts, packages/core/src/v1/config/connect.ts, packages/tui/src/routes/session/dialog-connect.tsx, engine agent/prompt/connect-fix.txt, docs/vector/build/connected-workspace-\*.
- Names: `connect` and `connect_*` for code, the tool, permissions, events and routes (`/experimental/connect…`). Taken already and never reused: the TUI's `/connect` slash command ("Connect provider", tui/src/app.tsx) and MCP's `/mcp/:name/connect` route. So people see "Connected tools", the CLI noun is `vector connected`, and the TUI dialog has no `connect` slash name. `handoff` is not free either: it is a browser tool action (tool/browser.ts). "Workspace" is avoided in code names, because main and cloud-workspaces already use it.
- Untouched by other branches and safe to extend: engine orchestration/, skill/, command/, plugin/, task/ (except task/shells.ts), core agent/ and orchestration/, the TUI session routes (except permission.tsx), app features/agents and delegation, settings-v2/subagents.tsx (VS-09 may come; see 7.2), effect/app-runtime.ts, session-side-panel.tsx. Engine background/ is not safe: process-finish edits background/job.ts.

## 8. Landing order

**Stage A: lands on main first.** CW-01 to CW-08. No generated files. All model-facing behaviour sits behind `VECTOR_EXPERIMENTAL_CONNECT`, the `/vectorscope` command included. Shared-file edits total about 55 lines across registry.ts, agent.ts, permission-policy.ts, session/memory.ts, runtime-flags.ts, command/index.ts and task/notify.ts. Other branches rebase over them with at most trivial conflicts. It uses main's own copy of `executeLocalReview` and `Review.run`.

**Stage B: one public-surface WP (CW-09).** Routes, events, config key, capability flag, the owner-only rule and all regenerated files. Before it starts, VectorScope's owner and this branch agree on who owns the review start route (section 13, Q6). It lands in one PR right after the next large merge into main (whichever of vectorscope, hands, codium or @vector comes first), so the generators run once on the merged tree. If no large branch merges within two weeks of the owner accepting Stage A, CW-09 lands on its own, and its PR tells each branch owner to re-run the generators. Every later branch that touches generated files re-runs the generators. Nobody resolves generated conflicts by hand.

**Stage C: surfaces and loops.** CW-10 to CW-19, in any order after CW-09. CW-13 (after-run) and the `before_commit: run` setting need the config key.

**Stage D: light-up as branches merge.** No branch waits on this one, and this one waits on none.

| When this merges into main | What lights up | Who does it |
|---|---|---|
| vectorscope (needs main merged in first; it is 165 commits behind) | Nothing changes on day one, because connect only calls exported entry points. When VS-08 lands, CW-20 swaps the adapter to the review service and drops the prompt bridge. When VS-10 lands, desktop panel reviews show as connect runs, and "Ask the agent" uses CW-15. | VectorScope's owner for VS-08/VS-10; this branch for CW-20 |
| hands | CW-21: the Hands adapter and connect rows in the Tasks pane. CW-23's `connect_cloud` entry can follow. | This branch, after the merge |
| codium | Second opinion applies to reviews automatically. CW-23: Remote routes and the Playbooks check. | Codium's owner |
| vector-at-mention | CW-22: the GitHub agent adapter, and the decision on withholding `connect` on Actions. | @vector's owner; this branch for the adapter file |
| cloud-workspaces | CW-24: proxy routes and the engine's place. | Its owner |

**Release.** Turning `experimentalConnect` on by default, and any visible desktop UI, waits for the owner's yes (Q1). VectorScope decision D14 keeps VectorScope features out of the visible 1.99.113 release.

## 9. Work packages

Each WP fits one agent. "Tests" names the files the WP adds or must keep green. Each one runs alone, locally. The full suite runs in CI before the WP is done.

### Phase A: contracts and the core loop (lands on main first)

| Id | Goal | Files | Done when |
|---|---|---|---|
| CW-01 | Schema contracts | New packages/schema/src/connect.ts: Member (with `place` and `sendsTo`), Action, Effect (`read`, `write`), Place, SendsTo, Request, Result, Run, Progress, Consent, Refusal, ConnectFinding; the event definition `connect.run.updated` (not yet in the manifest). | Round-trip decode and encode; unknown literals refused (an effect other than `read` or `write` included); size limits enforced (summary 2k, body 4k, 200 findings). Tests: new packages/schema/test/connect.test.ts. |
| CW-02 | Pure policy | New packages/core/src/connect/{policy,findings,frame}.ts over the schema types. `policy`: effect to base permission, the narrowing check, the consent table, place and sendsTo against Vector Local, the effective dollar cap, the owned-path rule, the check-command list, the read-pattern selection (requester patterns minus VectorScope's denies), the settings paths of check 1. `findings`: map every selection bucket in VectorScope's order; for uncommitted and staged targets, compare with core's `matchPrior`; for branch targets, take `selection.fixed` and `stillOpen`; compare only runs of the same target kind. `frame`: the model-facing framing and the untrusted block for briefs. | A deny on the base permission refuses before any ask; a partial outcome never frames as clean; the cap skips 0 and missing values and takes the smallest positive one; outsideDiff paths and `.github/**` and `.vector/**` never become owned paths; 12 findings across buckets map in order; comparison labels fixed, still open and new correctly. Tests: new core test/connect/{policy,findings,frame}.test.ts. |
| CW-03 | Engine hub | New packages/engine/src/connect/{adapter,hub,members}.ts and connect/adapters/index.ts. `ConnectHub` LayerNode with its own deps (Permission, Session and SpendGuard included, checked against the layer graph): adapters, the run ledger cache, results saved in tool part metadata, progress, cancel, the effect check, the read-pattern glob, the per-request cap, the helper handle, consent through the requester's `ctx.ask`. runtime-flags.ts: one line. | Runs move queued → running → done; cancel aborts; a run whose effects the requester lacks is refused with no ask; any effect other than `read` or `write` is refused; a file matching a requester read deny or ask pattern refuses a review; prompting the requester or an unrelated session through the helper handle fails; only the vectorscope adapter gets the handle; after a restart, `findings` with an earlier run id still works; no network or model call outside adapters. Tests: new engine test/connect/hub.test.ts. |
| CW-04 | VectorScope adapter | New connect/adapters/vectorscope.ts and connect/review-prompt.ts (section 4.2). Targets: uncommitted, staged, branch with base. Lazy imports. The three checks, the effective cap, `connect_model`, `confirm: async () => false`, `maxComments: 50`, `cached` from stdout. `describe()` through `resolveReviewModel`, `MIN_CONTEXT` and `capabilities.toolcall`, with no model call, reporting `sendsTo`. Outside a live run (`guard.running` false), the cap comes from `guard.snapshot`, and the run is refused when `guard.stopped`. | `parentID` reaches every helper session; `post` and `pr` are never set; reviewed changes that edit review.json, review.md, REVIEW.md or .gitattributes give `incomplete` with no model run; a review.json model other than the user's asks `connect_model`, and a denial refuses; a priced fake model asks once per request and a local one asks nothing; `max_cost` 0 is refused; a repository `maxCostUsd: 0` is still capped at $2; a review after the run ended with no user budget is capped; personal documents go only when `sendsTo` is this computer or a model server; 12 findings all arrive; a cached branch outcome is marked `cached`; a `size-limit` skip gives `incomplete`; "off in Vector Local" and "no tool calls" surface as `off` and `unavailable`; the bridge refuses any SessionPrompt member except `prompt` and `cancel`. Tests: new engine test/connect/vectorscope.test.ts (fake `runReview` and `resolveModel`, plus one in-process run against test/lib/llm-server.ts, no real model). Keep green: test/review/run.test.ts, test/review/model.test.ts. |
| CW-05 | The `connect` tool | New engine tool/connect.ts and connect.txt. registry.ts: 6 lines. agent.ts: 2 lines (`connect_write`, `connect_model`). session/memory.ts: 2 changed lines. Actions `review`, `findings`, `status`, `cancel`. Foreground only. Build agent in root sessions; Work and Thorough requests; Light refuses with the escalate hint. The description offers reviews before commits, pushes and PRs and forbids `vector review` from the shell. | Offered only with the flag on and only to `build`; refused for subagents and guests; output framed as data and names `sendsTo`; Codium cost shown as plan usage; `max_cost` must be greater than 0; the sixth review run in one request is refused; `SessionMemory.taint` returns `subagent`, not `mcp`, after a connect call. Tests: new engine test/tool/connect.test.ts. Keep green: test/tool/registry.test.ts (it imports the registry first, and must pass with the flag on), test/agent/agent.test.ts, test/session/task-note-taint.test.ts. |
| CW-06 | `/vectorscope` command | command/index.ts (with `RuntimeFlags.node` in its deps) and new command/template/vectorscope.txt. Size `standard`. The template parses `uncommitted`, `staged` or `branch <base>` and asks for `connect review`. | With the flag off, the command is missing from `Command.list()` and `/command`; with it on, it is listed and the arguments reach the tool; `/review` is unchanged. Tests: new engine test/connect/command.test.ts. |
| CW-07 | Fix and re-review | Tool actions `fix` (`here`, `worktree`) and `review` with `since`. agent.ts: the hidden `connect_fix` agent and agent/prompt/connect-fix.txt. permission-policy.ts: 2 lines. `worktree` calls `TaskTool.execute` (as the research tool does) with `subagent_type: "connect_fix"`, `invokedAgents: ["connect_fix"]` in `ctx.extra`, worktree isolation, owned paths from the owned-path rule, and an output schema. Merging a fix child asks `connect_write` again with the diff before `TaskIsolation` merge runs. | One `connect_write` ask per batch listing the findings, and one more before a merge; auto-accept and a saved approval answer neither; a denial changes nothing; the worktree child owns only the owned-path rule's files; a finding body asking for `curl` leads to no network call (bash outside the check list is denied, network tools are denied); the model cannot launch `connect_fix` with the task tool; `since` compares only runs of the same target kind; re-reviews stop at the per-request cap even when every review returns new findings. The loop test: `/vectorscope uncommitted` gives N findings; `connect fix mode:here` asks `connect_write` once; the fake agent edits one file; `connect review since:<run>` marks that finding `fixed` and the rest `still-open`; the helper sessions' root is the requester. Tests: new engine test/connect/fix.test.ts and test/connect/loop.test.ts (in-process against test/lib/llm-server.ts). Keep green: test/task/isolation.test.ts. |
| CW-08 | Background runs | `BackgroundJob` type `connect` in the hub, started only through `BackgroundJob.start`; task/notify.ts gets kind `connect` (about 10 lines). | A background review reports once through TaskNotify; clean results are quiet; a busy parent reads the note at its next step; a review that outlives the turn is capped from `guard.snapshot` and refused after a budget stop; test fakes are built from the real `BackgroundJob` layer, not a hand-written interface, so process-finish's `updateMetadata` does not break them. If session/task-size.ts would need the new kind, stop and coordinate (Hands edits that file). Tests: new engine test/connect/background.test.ts. Keep green: test/task/notify.test.ts, test/task/note-window.test.ts. |

### Phase B: public surface (one WP, generated files)

| Id | Goal | Files | Done when |
|---|---|---|---|
| CW-09 | Routes, events, config, capability, owner service | New core v1/config/connect.ts plus a line in config.ts. Keys: `connect.review.after_run` (`off`, `report`, `repair`), `before_commit` (`off`, `offer`, `run`), `max_rounds` (1–3), `max_cost_usd` (greater than 0, default 2). New engine connect/config.ts (`repositoryConnect`: a repository may only turn these down or lower them) and one line in engine config/config.ts. New engine connect/owner.ts: `ConnectOwner`, modelled on orchestration/owner.ts (WorkflowOwner), which depends on `SessionPrompt.node`, builds the helper handle, runs hand-offs with no tool call, and hosts the CW-13 subscriber; registered in httpapi server.ts after `WorkflowOwner.node`. New httpapi groups/connect.ts and handlers/connect.ts: `GET /experimental/connect` (members), `GET /experimental/connect/runs?sessionID=`, `GET /experimental/connect/runs/:runID`, `POST /experimental/session/:sessionID/connect` (start a hand-off as the owner), `POST /experimental/connect/review` (a directory-only review with no session, for CW-18), `POST /experimental/connect/runs/:runID/cancel`, `POST /experimental/connect/findings` (register desktop findings). packages/server/src/auth.ts: the owner-only line. Event manifest line and its test; `connections` capability; app `FLAGS`; HttpApi exerciser coverage; regenerate SDK, client and config schema. | Every connect route refuses guests and forwarded requests, GET and POST; requests pick their instance by `x-vector-directory`; an old client reads `connections` as off; a repository config turning on repair, `before_commit: run` or a higher `max_cost_usd` is ignored; generated files come only from the generators. Tests: new engine test/server/httpapi-connect.test.ts; packages/server/src/auth.test.ts; engine test/event-manifest.test.ts; engine test/config/config.test.ts (the narrowing); app features/background-tasks/engine-capabilities.test.ts; CI `check:generated`. |

### Phase C: surfaces and loops

| Id | Goal | Files | Done when |
|---|---|---|---|
| CW-10 | CLI | New engine cli/cmd/connected.ts (`vector connected`); index.ts 2 lines; help snapshot regenerated. | `list` and `runs` work with `--attach` and `--json`; `review` and `cancel` refuse under the agent marker. Tests: new engine test/cli/connected.test.ts; test/cli/help/help-snapshots.test.ts. |
| CW-11 | TUI | New tui/src/routes/session/dialog-connect.tsx and a small presentation module; session/index.tsx hook. The dialog is listed as "Connected tools" with no `connect` slash name. | Members and runs render from the routes; cancel works; hidden when `connections` is off; `/connect` still opens "Connect provider". Tests: new tui test/connect-presentation.test.ts. |
| CW-12 | Desktop Connected tools | New app/src/features/connect/{connected-tools.tsx,connect-model.ts,client.ts}; subagents.tsx 2 lines. Shows where each member runs and where it sends code, state, reason and reach; the review switches from CW-09; merges desktop-only members (external agents) from existing IPC. | Hidden on engines without `connections`; no tokens or prices shown for Codium; every member has a plain reason when not ready; VectorScope shows its review model's `sendsTo`, not the engine's place. Tests: new app features/connect/connect-model.test.ts. |
| CW-13 | After-run review | New engine connect/after-run.ts, run by `ConnectOwner`. It subscribes to `session.status` idle for root build sessions and decides "this run changed files" with `SessionTaskSize.size` and `judgeable` (read-only import). `report` posts a quiet note; `repair` posts a waking note with blocking findings. | Off by default; skipped for subagents, internal sessions, guests, stopped or errored runs and runs that end on a question; skipped with a quiet note when `connect_model` would ask; at most `max_rounds` per request, keyed on the request id, and inside the per-request cap; capped from `guard.snapshot`; never runs while a judge repair is pending. Tests: new engine test/connect/after-run.test.ts. |
| CW-14 | Worktree targets | Adapter target `{ task }`: the isolation's directory and review base, reviewed as a branch review with `full: true`. Placement without touching review/run.ts: connect creates a hidden placeholder session (`internal: "vectorscope.place"`, `parentID` = requester), loads the worktree instance through the instance store as `TaskIsolation.loadWork` does (the child's own instance is disposed when it settles), calls `TaskPlace.set` on the placeholder, and passes it as `parentID`. `Session.create` then places each review session in the worktree through `TaskPlace.inherit`, and spend still rolls up to the requester. The instance is disposed after the review. | A test where a file differs between the worktree and the main checkout proves the reviewer read the worktree copy, and the helper sessions still count against the requester's run. If that test cannot pass without a change in engine review/run.ts, stop: it becomes a request for VectorScope's VS-08. |
| CW-15 | Desktop findings hand-off | New app features/connect/handoff.ts: register findings through `POST /experimental/connect/findings`, then send a composer message that names the run id. "Fix" and "Fix in a worktree" in the Connected view use it. | Findings never travel as pasted text; the user's click sends the message; nothing in ai-review.ts changes on this branch. Tests: new app features/connect/handoff.test.ts. |
| CW-16 | Workflow connect stage | core orchestration spec.ts and plan.ts (a third stage kind `{ id, connect: { to, action, input }, after, if, title }`); schema/src/workflow.ts (`Workflow.PlanStage`, public in the SDK, gets the stage kind); engine orchestration/runner.ts; guide.txt example "implement, review, fix, review"; app features/background-tasks/workflow-model.ts (the plan view, which draws stages by agent). Regenerates the SDK and client at its final rebase. | Only actions whose effects are all `read` are allowed; findings become stage items; fix stages get owned paths from the owned-path rule; a stage that needs `connect_model` asks like any workflow ask; the workflow's own approval still applies; the plan view draws a connect stage. Tests: core test/orchestration/spec.test.ts and plan.test.ts; new engine test/orchestration/connect-stage.test.ts; app features/background-tasks/workflow-model.test.ts; CI `check:generated`. |
| CW-17 | Dismiss to Brain | New engine connect/context.ts: "Dismiss" from a person's click writes Brain's `review` kind ("what Vectorscope was told not to flag"). | A model cannot dismiss; only a person's click writes; the kind matches what VectorScope's owner confirms reviews read. Tests: new engine test/connect/context.test.ts. |
| CW-18 | Workspaces and external agents | app features/agents (workspace card action) through `POST /experimental/connect/review` with the workspace directory; optional swarm pre-merge review in desktop/src/main/swarm-orchestrator.ts, off by default. | Review shows on the card; a swarm merge waits for the review only when the switch is on; the run has no requester session and asks its consent in the desktop, of the owner. Tests: the agent-dashboard model test; desktop swarm-orchestrator single test file. |
| CW-19 | Desktop findings card | New app/src/features/connect/findings-card.tsx with `registerConnectFindingsCard()`, which calls session-ui's `ToolRegistry.register({ name: "connect", render })`, as features/research/report-card.tsx does; session-side-panel.tsx 2 lines. "Fix", "Fix in a worktree" and "Dismiss" send a message in the user's name naming the run and findings. | Guests see the plain row; the card shows the verdict and `sendsTo`; a click never applies a fix by itself (`connect_write` still asks). Tests: new app features/connect/findings-card.test.ts (model test). |

### Phase D: light-ups (after other merges)

| Id | Goal | Files | Done when |
|---|---|---|---|
| CW-20 | Use VectorScope's service | connect/adapters/vectorscope.ts; delete connect/review-prompt.ts. | Same tests as CW-04 pass against VS-08's service; the verdict comes from VectorScope when VS-32 is wired. |
| CW-21 | Hands | connect/adapters/hands.ts (list-only, `ComputerAvailability.unavailable()`); connect rows in the Tasks pane. | Hands is never reached from background, workflow, after-run or scheduled runs; screenshots never reach the reviewer. Tests: new engine test/connect/hands.test.ts; app background-tasks tests. |
| CW-22 | GitHub agent adapter | connect/adapters/github-agent.ts. Prerequisite: the owner says whether the local agent may hand a fix to @vector on GitHub (it posts a `/vector` request, asking each time). | Installed state and CLI pin are correct; the `task` action exists only if the owner said yes, and asks every time. Tests: new engine test/connect/github-agent.test.ts. |
| CW-23 | Codium and the cloud effect | Codium's parts are done by Codium's owner in their files (section 6). On our side, after Hands merges and with Hands' owner agreeing: `connect_cloud` joins `CONNECT_ALWAYS` in permission-policy.ts and gets an `"ask"` default in agent.ts; the hub accepts the `cloud` effect. | The phone starts a review only after a passkey check; `connect_cloud` asks even under auto-accept and with an allow rule. |
| CW-24 | Cloud workspaces | Done by its owner (section 6). | Connect routes pass the proxy; nothing else does; the engine reports its place from the runtime marker. |
| CW-25 | Release | Flip the flag default; a docs page and a docs-nav line; owner-actions note. | The owner said yes (Q1); the docs make no quality or comparative claim. |

## 10. Security invariants

- **I1 No widening.** A hand-off never does what its requester could not. Effects are checked against the requester's rules before anything starts, reads included: a file matching a requester read deny or ask pattern stops a review. Member sessions keep their own fixed rules.
- **I2 Data, not instructions.** Findings, member output, Brain cards, research reports, browser output, screenshots and PR text never choose trust, model, depth, budget, permissions, targets, owned paths or effects. Neither do repository settings files that the reviewed changes edit. Results and briefs are framed as data.
- **I3 Consent per effect.** A read-only review on a model you chose, sent to this computer, your model server or your own unpriced review model, needs no question. A priced or repository-chosen model asks once per request. Every fix batch and every merge of a fix worktree asks every time, through `requiresApproval`. Commands in fix children ask per command, and their network tools are denied. Cloud will always ask. Posting never happens through connect.
- **I4 Local by default.** Connect makes no network call of its own. It adds no Vector Local source. It never picks a cloud member or model on its own. Every result says where the code went (`sendsTo`), and "local" is shown only for this computer or a model server. Code or a screen goes to a Vector cloud service only after a `connect_cloud` ask that names the destination. A model provider the user configured stays the user's choice, as it is for the agent itself.
- **I5 Shared spend limits.** Every model call in a hand-off goes through the existing spend guard. Inside a run, reviews count against it through `parentID` and the helper rule. Outside a run, a review is capped at the ended run's remaining budget (or $0.50 when it had none) and refused after a budget stop. Each review's dollar cap is the smallest positive limit, and 0 never means uncapped. A request gets at most 5 review runs. Fix children count through the task tool's own ledger. Connect never raises a budget and changes no accounting code.
- **I6 Audiences hold.** Members get the brief and repository facts only. No conversation, context pack or personal memory goes to an `outward` member. Personal Brain documents reach a review only when it sends to this computer or a model server.
- **I7 Owner only.** Every connect route is owner-only through `isOwnerOnlyRoute`, for every method. CLI commands that start or cancel hand-offs refuse under the agent marker.
- **I8 No posting, no pushing.** Connect never posts reviews or comments and never pushes. GitHub writes stay with VectorScope's `--post` and @vector's publish phase.
- **I9 No chains.** A member cannot start another member's hand-off. Every hand-off starts from an agent turn, a person or a workflow stage. The helper handle reaches only the run's own helper sessions. Review lineage stays within the posting guard's bound (depth 3, 200 sessions).
- **I10 Fail closed.** A member that cannot prove it is ready shows as unavailable. A partial review, a review skipped for size, or one whose settings the changes edit, is never clean. An unknown effect is refused.
- **I11 Hands stays in the root.** `computer` is reachable only in the user's own conversation, never from background runs, workflows, the after-run review, scheduled runs or subagents.
- **I12 Repository config cannot spend.** A cloned repository's config may only turn connect features down or lower limits, never on or up. A repository's review.json can choose a model only after `connect_model` asks.
- **I13 Tokenomics untouched.** No edit to accounting files. Connect uses existing APIs only.

## 11. Test plan

- **Locally, one file at a time.** Each WP runs its own new test files and the "keep green" files named in its row, one at a time from the package directory (`bun test test/connect/hub.test.ts`), plus `bun run typecheck` in that package. Nothing heavier runs on this Mac while Vector is in use.
- **No real models in tests.** Engine tests use test/lib/llm-server.ts and fake `runReview` and `resolveModel` deps. No test spends money or reaches the network.
- **In CI.** Push a temporary branch, run the full suites (unit, typecheck, `check:generated`, the HttpApi exerciser, the desktop engine bundle under Node, Playwright), then delete the branch. Record the run id in the WP's commit message.
- **Same-result check.** CW-04 includes one test where the CLI and the connect adapter review the same fixture with the same fake model and the same options (`maxComments`, `maxCost`). Their outcomes must match apart from session ids.
- **The loop.** CW-07's test/connect/loop.test.ts walks review, fix, re-review in-process (section 9).
- **Security tests.**
  - A model-written finding asking for a fix does not start one.
  - A finding body asking for `curl` leads to no network call in a fix child.
  - An `outsideDiff` path never becomes an owned path; neither does `.github/**` or `.vector/**`.
  - Reviewed changes that edit `.vector/review.json`, `.vector/review.md`, `.vector/REVIEW.md` or `.gitattributes` give `incomplete`, never `clean`, and no model runs.
  - A review.json model other than the user's asks `connect_model`.
  - `max_cost: 0` is refused; a repository `maxCostUsd: 0` is still capped; an after-run review with no user budget is capped.
  - When every review returns new findings, the per-request cap stops them.
  - A file matching a requester read deny or ask pattern stops a review.
  - Auto-accept and saved approvals do not answer `connect_write`.
  - The helper handle refuses the requester's own session and unrelated sessions.
  - A repository config turning on repair is ignored.
  - A requester with `edit: deny` cannot `fix`.
  - A subagent cannot call the tool, and the model cannot launch `connect_fix`.
  - Guests are refused on every connect route (auth.test.ts).
  - The agent-marker refusal holds in the CLI.
  - A connect call holds memory as `subagent`, not `mcp`.

## 12. Owner questions

1. **Release.** May Stage A land on main now, behind `VECTOR_EXPERIMENTAL_CONNECT`? Which release may turn it on and show the Connected tools view? VectorScope's D14 keeps its features out of 1.99.113.
2. **`/review`.** Keep the generic `/review` and add `/vectorscope` (recommended), or point `/review` at VectorScope once connect is on?
3. **Repair after a run.** Is the `repair` mode acceptable at all (blocking findings go back to the agent for repair, like a judge FAIL), with `off` as the default?
4. **Reviews before commits.** Should the agent, on its own, do nothing (`off`), offer a review (`offer`, recommended), or run one (`run`) before it commits, pushes or opens a PR? `run` adds spend and waiting to every commit the agent makes.
5. **VectorScope's next step.** Should the VectorScope agent build VS-08 (the shared review service) before its addendum B list, so connect can drop its bridge and its own checks sooner? Its approvals Q15, Q18 and Q45 are still open.
6. **Who owns the review start route.** Should VectorScope's VS-10 use connect's `POST /experimental/session/:sessionID/connect`, or should VS-10 add its own route and connect's become a thin alias that CW-20 deletes? This must be settled before CW-09 regenerates the SDK.

Fix consent is not a question: VectorScope's D10 ("a concrete per-operation approval … with no standing preauthorization in the first release") already answers it, so `connect_write` always asks. Learned-skill context for reviews belongs to VectorScope (VS-26). The GitHub hand-off question waits for CW-22.

## 13. Requests to other owners

These are coordination items, not questions for the owner.

- **VectorScope.**
  - Under the agent marker, make `vector review` refuse `--pr` and `--post`, and read `--max-cost 0` or a repository `maxCostUsd: 0` as the default cap. Refusing all of `vector review` there would also block the owner, because Vector's own terminal carries the marker.
  - Route desktop "Apply fix" through `FileLock` and `FileState` instead of `POST /file/write`, which skips them (VS-10 or VS-12).
  - In VS-08: accept `parentID`, a session-scoped target, a worktree target that places its sessions, a stateless call that neither reads nor writes the branch state file, and a settings source (the base commit) for agent-written targets. Accept requester read denies appended after the review allow rules, and add `.docker/config.json` and `.kube/*` to the review's own denies. Export `CHECK_COMMANDS` so connect's fix children use the same list.
  - Agree before CW-09 who owns the review start route (Q6). For branch targets, connect takes fixed and still-open from VectorScope's state; please keep `selection.fixed` and `stillOpen` stable.
  - In VS-09, route the `vectorscope` agent and its @-mention through the same adapter or service, so there is one review path. VS-09's settings work will likely touch settings-v2/subagents.tsx near the Review and Security copy; connect's section is mounted at the end of that page.
  - Decide in VS-26 whether learned skills reach reviewers, and where. Connect sends none.
  - Confirm that Brain's `review` kind is the one reviews read, so CW-17's Dismiss writes the right thing.
  - Correct the docs page's claim that the desktop panel runs the same review as the CLI.
- **Hands.** Confirm that the `computer` tool id and `ComputerAvailability.unavailable()` are the stable surface for the adapter. Agree on the `requiresApproval` anchor in permission-policy.ts (after `permission === AGENT_MARKER ||`), which Stage A uses for `connect_write` and CW-23 for `connect_cloud`.
- **@vector.** Decide whether `connect` is withheld on GitHub Actions through `actionsWithheld`.
- **Codium.** Add the connect routes to `REMOTE_ROUTES` under the passkey rule. Accept read-only connect stages in the Playbooks check.
- **cloud-workspaces.** Add the connect routes to the supervisor's engine proxy. Have the engine report its place from the runtime marker (`VECTOR_CLOUD_WORKSPACE_WORKER`), so connect does not call a review in a container "local".
- **process-finish.** Connect starts background reviews only through `BackgroundJob.start` and builds its test fakes from the real layer, so `updateMetadata` needs nothing from connect.

## Appendix A. Code facts this contract relies on

| Fact | Where (main `0dcbb8e2` unless named) |
|---|---|
| `executeLocalReview(options, deps)` and its option and dep types | packages/engine/src/cli/cmd/review.ts (`LocalReviewOptions`, `LocalReviewDeps`, `executeLocalReview`) |
| Non-PR reviews are trusted and read settings from the working tree | the same file (`trust`, `setting`, `readWorkingFile`, `REVIEW_RULES_PATHS`, `.gitattributes`) |
| `maxCost` replaces the cap; `confirm` only for `--checks` and `--post`; the estimate is only printed | the same file (`withFlags`, `ESTIMATE_FILES`, `postToPull`) |
| Cached branch outcome, flagged only on stdout | the same file (the "Nothing new to review" path, `cached: true`) |
| `maxCostUsd: 0` means no cap; `maxComments` default 10, clamped to 50 | packages/core/src/review/types.ts; core review/config.ts |
| review.json model before `agent.review.model`; costKind and `local` | packages/engine/src/review/model.ts (`resolveReviewModel`, `provider.line`) |
| Selection buckets; `matchPrior`; `fingerprint`, `titleSimilarity` | packages/core/src/review/select.ts; core review/fingerprint.ts |
| Review session rules; no `.docker` or `.kube` deny; `CHECK_COMMANDS` not exported | packages/core/src/review/permission.ts |
| Build agent read defaults ask for `.docker/config.json` and `.kube/*`; `general` uses the defaults | packages/engine/src/agent/agent.ts (`readDefaults`, `general`) |
| The last matching rule wins | packages/engine/src/permission/index.ts (`evaluate`, `findLast`) |
| `requiresApproval` forces an ask even under an allow rule | permission/index.ts (`ask`); packages/schema/src/permission-policy.ts |
| Shell sandbox keeps the network on by default | packages/engine/src/tool/shell/sandbox.ts |
| `RunInput.parentID`; review sessions are internal children | packages/engine/src/review/run.ts (`RunInput`, `sessions.create`) |
| Review uses only `prompt` and `cancel`; review/run.ts value-imports session/prompt.ts | review/run.ts |
| `TaskPromptOps`; `prompt` accepts any session id except workflow ones | packages/engine/src/tool/task.ts; session/prompt.ts (`ops`, `within`) |
| SessionPrompt depends on ToolRegistry and value-imports it | packages/engine/src/session/prompt.ts (imports, `node`) |
| The helper rule; after a run, a helper is its own run under `budget.run` | session/prompt.ts (before `runSteps`: `guard.running`, `guard.unlink`, `guard.begin`) |
| `guard.snapshot`, `guard.stopped`, `guard.running` | packages/core/src/spend-guard.ts (interface only; read, never edited) |
| `ReviewCommand.handler` loads review modules lazily | cli/cmd/review.ts (`handler`) |
| Core depends on schema, llm, plugin and sqlite packages only | packages/core/package.json |
| Owner-only routes | packages/server/src/auth.ts (`isOwnerOnlyRoute`); re-exported by packages/engine/src/server/auth.ts |
| Hidden native subagents launch only when invoked | tool/task.ts (the research-judge check); session/prompt.ts (`invokedAgents`) |
| Isolation commits a settled child, disposes its instance, and merges with an `edit` ask | packages/engine/src/task/isolation.ts (settle, `retire`, `loadWork`, merge) |
| Placement and inheritance | packages/engine/src/task/place.ts (`set`, `inherit`, `dropWork`); session/session.ts (`create`) |
| Memory holds unknown tools as MCP | packages/engine/src/session/memory.ts (`LOCAL_TOOLS`, `DELEGATION_TOOLS`, `taint`) |
| Command layer deps | packages/engine/src/command/index.ts (`node`) |
| Repository config narrowing | packages/engine/src/config/config.ts (`projectExecutableConfig`, `repositoryResearch`) |
| Event count assertion | packages/engine/test/event-manifest.test.ts |
| Tool card registration from the app | packages/session-ui/src/components/message-part.tsx (`ToolRegistry`); app features/research/report-card.tsx; pages/session/session-side-panel.tsx |
| WorkflowOwner builds promptOps from SessionPrompt and is registered in the HTTP server | packages/engine/src/orchestration/owner.ts; httpapi server.ts |
| Parallel Workspaces use the v2 session engine | packages/desktop/src/main/parallel-workspaces.ts |
| Brain's `review` kind | packages/core/src/brain/schema.ts (`Kind`) |
| `/connect` is the TUI's provider command; `handoff` is a browser action | packages/tui/src/app.tsx (`provider.connect`); packages/engine/src/tool/browser.ts |
| Workflow plan stage in the public API | packages/schema/src/workflow.ts (`Workflow.PlanStage`); packages/sdk/openapi.json |
| Research tool pattern (gating, size check, `TaskTool.execute`) | packages/engine/src/tool/research.ts; registry.ts `tools()` |
| TaskNotify note kinds and metadata | packages/engine/src/task/notify.ts (`Note`, `metadata`) |
| BackgroundJob start input | packages/core/src/background-job.ts (`StartInput`); origin/process-finish adds `updateMetadata` |
| Task isolation directory and review base | packages/schema/src/task.ts (`Isolation`); task/isolation.ts (`reviewBase`) |
| Per-request instance selection | packages/server/src/location.ts (`x-vector-directory`) |
| Capability flags | httpapi groups/experimental.ts (`CapabilitiesResponse`); handlers/experimental.ts; app features/background-tasks/engine-capabilities.ts (`FLAGS`) |
| Workflow stage kinds | packages/core/src/orchestration/spec.ts (`AgentStage`, `NestedStage`) |
| Owner gate; Vector's terminal carries the agent marker | packages/engine/src/cli/owner-gate.ts (`refuse`) |
| Codium-safe review output | packages/engine/src/cli/cmd/review-output.ts (`reviewForOutput`) |
| Review context limit | packages/core/src/review/plan.ts (`MIN_CONTEXT` 32,000, `estimateCostUsd`) |
| GitHub workflow file | packages/core/src/review/workflow.ts (`WORKFLOW_FILE`) |
| Vector Local covers VectorScope | packages/core/src/local-mode/sources.ts (`local-inference`) |
| Remote allowlist | origin/codium packages/desktop/src/main/remote-routes.ts (`REMOTE_ROUTES`); absent on main |
| Cloud workspace proxy routes and worker marker | origin/cloud-workspaces packages/cloud-workspaces/src/protocol.ts, docker.ts |
| `computer` registered only with its bridge; availability probe | origin/hands packages/engine/src/tool/registry.ts, packages/engine/src/computer/availability.ts |

## Review notes

Every finding was checked against main `0dcbb8e2` and the branch tips in 7.1. Findings that repeat each other were merged: three on `overflow` and `stillOpen`, three on `confirm` and the missing cost question, two on gating `/vectorscope`, two on `place` against where the code goes, and two on the name `connect`. The rest were applied as written, except these:

- **Renaming to `handoff`:** rejected. `handoff` is already a browser tool action (tool/browser.ts), and the workflow owner uses the word too. The other naming finding was applied: `connect` stays for internal ids, people see "Connected tools", the CLI noun is `vector connected`, and the TUI never takes `/connect`.
- **"A `*: allow` rule is only stopped by a post-pass in agent.ts"** (the Hands finding): wrong. `Permission.ask` starts from `requiresApproval`, and only a deny ends it (permission/index.ts), so an allow rule cannot skip an always-ask permission. The anchor problem is real, because Hands rewrites that function's body, so 7.2 now gives an anchor. No post-pass is added.
- **Registering `ConnectOwner` in effect/app-runtime.ts:** changed. Its model, `WorkflowOwner`, is registered in httpapi server.ts, and route handlers only see services in that list, so `ConnectOwner` goes beside it.
- **Refusing a review when the requester has any read deny or ask beyond VectorScope's list:** changed. The build agent's own defaults ask for `.docker/config.json` and `.kube/*`, which VectorScope does not deny, so that rule would refuse every review under defaults. The hub refuses only when a file in the directory matches such a pattern.
- **Counting every skipped file as not reviewed:** changed. Nearly every repository has lockfiles or generated files, so every review would read `incomplete`. Only `size-limit` skips count. The other skip rules come from settings that check 1 now protects, and they are listed in `notes`.
- **Owned paths "never from `elsewhere`":** changed. An `elsewhere` finding's anchor resolved in the diff, and the intersection with changed files bounds it. `outsideDiff` and `stillOpen` never count.
- **Skipping `connect_write` when the user clicked the card's Fix:** rejected. D10 asks for a concrete approval for each apply. The click is the request, and the ask shows what will change, so there is still only one question.
- **`vector review` refusing entirely under the agent marker:** narrowed. Vector's own terminal carries the marker (cli/owner-gate.ts), so the owner could no longer run `vector review` there. The request is to refuse `--pr` and `--post` and to cap 0s.
- **A separate `connect_spend` ask, plus another ask for a repository-chosen model:** merged into one `connect_model` ask, once per request, saveable per model. A priced, repository-chosen model would otherwise ask twice.
- **Adding `connect_run`, `connect_network` and `connect_cloud` to `requiresApproval` in Stage A:** only `connect_write` is added. The scope finding removed those effects from Phases A to C, and the hub refuses them, so each always-ask entry arrives with the WP that adds its effect (`connect_cloud` in CW-23, after Hands).
- **CW-16's schema change:** of the two fixes offered, CW-16 regenerates the SDK and client at its own final rebase. Moving an unbuilt stage kind into CW-09's batch would ship a public type ahead of its feature.
- **One extra correction:** the earlier draft said `ReviewContext.requirements` carries review dismissals. It reads only requirement, constraint, contract and decision links (`REQUIREMENT_KINDS`), so 3.3 now says that.
