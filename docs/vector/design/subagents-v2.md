# Subagent orchestration v2

Status: implementation design for desktop 1.99.108. Baseline: `bdec3b29e` (`final-integration`); integrate the release branch's later `origin/main` before shipping.

## User outcome

Delegation leaves the parent conversation available. The user can keep talking, see what each worker is doing and spending, send a correction, answer a question, and stop work without losing its partial results. The parent has the same truthful controls. Independent substantial tasks run together; small tasks stay with the parent.

## Design decision

Three independent proposals reviewed runtime correctness, experience, and cost. All favored extending the existing execution primitives and persisted lifecycle rather than replacing the scheduler. Adopt a shared Schema task observation contract, durable session-backed child records, and adapters for the engine and desktop runners. Keep `BackgroundJob` as process-local execution ownership. Keep desktop worktree merge preflight, rollback, external-process cleanup, and keep-awake behavior.

Use one compact `task_manage` tool with typed `list`, `inspect`, `message`, `stop`, and `wait` actions. This gives the parent first-class management without repeating five tool descriptions in every request. HTTP, app, TUI, and CLI controls use the same methods. Execution permissions remain attached to the child and cannot be widened by a message.

## Launch and identity

`task` accepts one to eight complete briefs. Background is the default for a root session's batch; `background: false` explicitly waits when the parent cannot usefully continue. The trusted disable flag remains supported. Nested children must remain attached to an observed ownership chain; do not detach grandchildren that no parent will await.

Preflight all briefs before launching any work. Retain permission checks, model validation, depth limits, duplicate detection, ownership claims, and cycle detection. A task ID identifies an existing child; an unknown ID never creates replacement work. A completed child's continuation is explicit, not a side effect of a racing message.

Persist grouping, owned paths, dependencies, success criteria, launch identity, attempt/revision, and result availability alongside the existing child lifecycle. Keep parent tool metadata for older clients. Hidden internal helpers remain hidden and retain existing spend roll-up.

## Shared observation and controls

The common public states are `queued`, `running`, `waiting_on_user`, `completed`, `failed`, and `stopped`. Runtime-specific merge stages and reasons are separate fields. Unknown external usage remains unknown. Each record includes its owner/parent, runtime/source, group, title, model, times, current step/tool, direct usage, dependency IDs, owned paths, result availability, and supported controls.

List returns compact direct children by default and bounded descendants on request. Inspect reads bounded recent steps and partial output, never a whole transcript. Full results remain in session storage or referenced artifacts, with an explicit truncation indicator in compact views.

Message accepts bounded text and explicit steer/queue delivery, returns an admission receipt, and rejects a child that finished before admission. Stop validates the entire selection before mutation, preserves a reason and partial output, reaches descendants/dependents, and waits for execution cleanup. Wait is event-driven, supports any/all and a finite timeout, and returns fresh status on timeout. No management read or wait invokes a model.

Authorization derives from the request principal and stored ownership, never a caller-supplied owner field. Guests may only control their authorized sessions. A sibling's coordination message is data, not permission to control the recipient or widen tools, budgets, ownership, or user intent.

## Notifications and safe boundaries

Hold notes in one window per parent. A busy parent gets them at once, so they join its next step. An idle parent gets them after 1.5 s without a new note, at most 5 s after the first, and after the whole 5 s while another of its background jobs runs. A turn the user starts takes held notes with it. Notes are recorded without starting a turn when the user stopped the helpers with the main agent (until the user writes again), when the spend guard halted the parent, or when no note in the batch wakes it, such as one that only reports stopped helpers. Suppress reports whose launching message was reverted. Notifications carry bounded reports and references, clearly attributed as automated output with no human authority.

V1 uses its own prompt admission adapter and serialized provider-turn boundary. Synthetic notifications must not become the user's selected model/format/budget or displace a pending human message. V2 continues to admit durable inputs through `SessionV2.prompt` and `SessionExecution`; never bridge its runner to the legacy loop. Steer promotes at a safe provider-turn boundary; queue promotes only when the session would otherwise become idle.

The current app conversation uses the engine's V1 task tools. Its desktop bridge controls native V2 workspace workers through their durable prompt API. Pure SDK-next V2 parent sessions do not automatically receive `task` or `task_manage`; their canonical application-tool registration remains a separate integration surface. Native V2 team members retain their scoped teammate mailbox. This release does not claim identical tool catalogs across the two runners.

Persist observation across restarts. A persisted running state is not evidence of a surviving executor: reconcile abandoned work as stopped with an interruption reason, retain partial results, and require an explicit continuation. Do not retry paid provider work automatically after a crash.

## Collaboration and file ownership

Dependency edges are persisted, checked under the admission lock, and resolved to compact result summaries/artifact references. Failed or stopped prerequisites settle waiting work without a provider request. Dependencies on existing task IDs remain supported; same-batch labels require IDs allocated before execution and must not be advertised before implementation.

Peer mailboxes have server-side size, rate, and pending-queue limits. Sender identity comes from the running context. Encode the payload inside a fixed untrusted-data envelope; peer reports cannot escape into instructions.

Reject overlapping live ownership early. Enforce canonical owned paths at explicit edit/write/patch boundaries. Shell access is not a filesystem sandbox: preserve isolated worktree execution and changed-path/merge preflight where required. Never describe prompt-only ownership as enforced isolation.

## Cost and budgets

Keep stable system/tool content before variable briefs and context packs. Preserve specialist tool restrictions and share prefixes only across compatible tool/permission/model cohorts. Keep existing price-checked Explore routing and free-route preservation; general inherits the parent model unless configured. No automatic paid fallback.

Add bounded context packs for established findings, paths, and symbols. Reports describe findings, changed files, checks, remaining work, and artifact references. Success criteria tell a child when to stop.

Child and batch ceilings tighten the launching run's Run Guard. Bind children to launch lineage so a later user turn cannot reset their caps. Record a provider step once, check every applicable scope, and keep counting in-flight spend after a stop. Do not use `arm(child, budget)` to accidentally replace the root's budget. Parent spend is direct session cost plus persisted descendant cost; do not sum recursive totals again.

## Experience

Retain the compact background panel and inline chips. Add current activity, direct tokens/cost, grouping, dependency details, bounded progress, Talk to this subagent, Ask Vector about this, Stop, and Open. Keep Needs-you prominent. Preserve drafts and state clearly whether a correction was admitted or the child already finished. Stale connectivity is shown separately from task progress.

TUI and CLI expose the same list, inspect, steer, and stop semantics. Headless execution waits for children and resulting notifications, with a real finite timeout even if event delivery stalls. Batch tool calls must display every child.

## Implemented desktop bridge boundaries

The desktop registers observations through the authenticated engine connection it already owns. Registration binds the real parent session and project directory to a private, unpredictable lease; it never accepts an agent-supplied callback URL. The engine queues bounded inspect/message/stop commands, and the desktop publishes durable receipts. An interrupted command is retained as uncertain rather than blindly replayed. Guest bridge registration, polling, and receipts are denied before remote proxying.

Swarm workers retain the real parent identity even though their workspace records use an internal staging directory and synthetic parent. Authorization joins only workspace IDs recorded by a swarm owned by that parent and project. Synthetic coordinator workspace records do not create additional task scopes. A bounded snapshot advertises truncation; stop-all rejects an incomplete selection. Snapshots prioritize active tasks, then recent history.

A missing desktop lease means disconnected, not stopped: the executor may still be running. A lease deadline publishes a parent update without requiring a read, preserves last-known progress, and disables remote mutations. Reconnection requires a fresh lease after expiry or engine restart. Native desktop restart reconciliation separately settles work whose process owner no longer exists. No path automatically retries paid work.

Live steering is supported for native workspace sessions at durable V2 admission boundaries. External CLI runners expose only controls their existing executor can perform; unsupported live messaging remains unavailable. Parent corrections carry a host-derived parent relationship in the bounded coordination envelope, preserving the child's permissions, budget, and safe delivery boundary.

The parent cost readout keeps the native ledger's cumulative session and descendant total. Desktop measured dollars appear as a separate **Desktop task spend** subtotal for the latest recorded workspace runs. Native ledger mirrors are excluded from that subtotal. A desktop record's measured cost is not established as lifetime cumulative across continuations, so the subtotal is not added to Session cost or the native run-cap meter. Missing external usage and unmeasured swarm planning remain unknown; no synthetic token counts or free-cost claims are produced.

## Verification and release

Tests cover all management actions, preflight atomicity, completion/steer/stop races, failed dependencies, cycles, restart interruption, mailbox limits, ownership, guest authorization, budget lineage, coalescing boundaries, and exactly-once spend. Run package suites in bounded chunks on this eight-core machine; rerun timing failures alone. Run package `bun typecheck`, client/legacy SDK generation after public API changes, and the website build.

Capture baseline and final offline footprint runs against the same fake-server work. Route concurrent scripts by logical actor, count side requests, reject incomplete workloads, and retain failed attempts. Add multi-child, dependency, steer, and stop scenarios. Offline token/cost estimates are not live quality, latency, caching, or price evidence. Do not claim parity with Claude Code unless measured results support the exact claim. Preserve owner-run live commands and the existing unmet live behavior gate.

Prepare desktop 1.99.108 and truthful release notes only after validating implemented behavior. Leave `publishedDesktopVersion` unchanged. Merge without rewriting main, push only after green gates, delete our merged short-lived branches, and leave release dispatch, production approval, live model benchmarks, and any npm 2FA to the owner.

## Public reference research

Reviewed Claude Code's [subagents](https://code.claude.com/docs/en/sub-agents), [agent teams](https://code.claude.com/docs/en/agent-teams), and [interactive controls](https://code.claude.com/docs/en/interactive-mode), plus Anthropic's [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). These informed independent-context workers, bounded reports, explicit controls, and exact-prefix cache structure. Vector's durable input, ownership, and spend invariants determine its implementation.
