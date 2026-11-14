import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { SubagentAvatar, subagentIdentity } from "@/features/agents/identities"
import { DirectoryReview } from "@/features/connect/directory-review"
import {
  agentCardDetails,
  boardColumns,
  directoryReviewTarget,
  elapsedLabel,
  filterAgents,
  findClashes,
  groupAgents,
  hasActiveFilters,
  isDirected,
  isRunning,
  orderConversation,
  summarize,
  type DashboardAgentInput,
  type DashboardAgentStatus,
  type TeamConversation,
} from "./agent-dashboard-model"
import "./agent-dashboard.css"

function toggled<T>(values: readonly T[], value: T) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

type FilterOption<T extends string> = { value: T; label: string }

function FilterMenu<T extends string>(props: {
  label: string
  options: FilterOption<T>[]
  selected: T[]
  onToggle: (value: T) => void
}) {
  const [open, setOpen] = createSignal(false)
  const summary = () => {
    if (!props.selected.length) return ""
    const first = props.options.find((option) => option.value === props.selected[0])?.label ?? ""
    return props.selected.length > 1 ? `${first} +${props.selected.length - 1}` : first
  }

  return (
    <div class="relative shrink-0">
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-[8px] border px-3 text-[12px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--vx-purple)]/60"
        classList={{
          "border-[color:var(--vx-purple)]/45 bg-[color:var(--vx-purple-soft)] text-[color:var(--vx-text)]":
            props.selected.length > 0,
          "border-[color:var(--vx-line)] bg-[color:var(--vx-control)] text-[color:var(--vx-text-muted)] hover:bg-[color:var(--vx-control-hover)] hover:text-[color:var(--vx-text)]":
            props.selected.length === 0,
        }}
        aria-expanded={open()}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.stopPropagation()
          setOpen(false)
        }}
      >
        <span>{props.label}</span>
        <Show when={summary()}>
          <span class="max-w-28 truncate text-[color:var(--vx-text-subtle)]">{summary()}</span>
        </Show>
        <svg viewBox="0 0 12 12" class="size-2.5 opacity-55" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="fixed inset-0 z-[1]" onClick={() => setOpen(false)} aria-hidden="true" />
        <div
          role="menu"
          aria-label={`${props.label} filter`}
          class="absolute left-0 z-[2] mt-1.5 min-w-[204px] overflow-hidden rounded-[10px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface-raised)] py-1.5 shadow-[var(--vx-shadow-float)]"
        >
          <div class="px-3 py-1 text-[10px] font-medium text-[color:var(--vx-text-muted)]">{props.label}</div>
          <For each={props.options}>
            {(option) => (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={props.selected.includes(option.value)}
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-[color:var(--vx-text-subtle)] transition hover:bg-[color:var(--vx-control-hover)] hover:text-[color:var(--vx-text)]"
                onClick={() => props.onToggle(option.value)}
              >
                <span class="min-w-0 flex-1 truncate">{option.label}</span>
                <Show when={props.selected.includes(option.value)}>
                  <svg viewBox="0 0 12 12" class="size-3 text-[color:var(--vx-purple-bright)]" aria-hidden="true">
                    <path
                      d="m2.5 6.5 2.5 2.5 4.5-5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function statusTone(status: DashboardAgentInput["status"]) {
  if (status === "failed") return "bg-[color:var(--vx-red)]"
  if (status === "needs review") return "bg-[color:var(--vx-amber)]"
  if (status === "complete" || status === "merged") return "bg-[color:var(--vx-green)]"
  if (status === "stopped" || status === "discarded") return "bg-[color:var(--vx-text-muted)]"
  return "bg-[color:var(--vx-purple-bright)]"
}

function statusLabel(status: DashboardAgentInput["status"]) {
  return status.replace(/(^|\s)\S/g, (letter) => letter.toUpperCase())
}

function AgentMark(props: { agent: DashboardAgentInput; size?: number }) {
  const identity = () => subagentIdentity(props.agent.agent)
  const initials = () =>
    props.agent.runtime
      .split(/\s+/)
      .map((word) => word[0])
      .join("")
      .slice(0, 2)
      .toUpperCase()

  return (
    <Show
      when={identity()}
      fallback={
        <span
          class="grid shrink-0 place-items-center rounded-[8px] border border-[color:var(--vx-purple)]/25 bg-[color:var(--vx-purple-soft)] font-medium text-[color:var(--vx-purple-bright)]"
          style={{
            width: `${props.size ?? 28}px`,
            height: `${props.size ?? 28}px`,
            "font-size": `${Math.max(9, (props.size ?? 28) * 0.36)}px`,
          }}
          aria-hidden="true"
        >
          {initials() || "V"}
        </span>
      }
    >
      <SubagentAvatar id={identity()!.id} size={props.size ?? 28} />
    </Show>
  )
}

function StatusDot(props: { status: DashboardAgentInput["status"]; pulse?: boolean }) {
  return (
    <span class="relative flex size-2 shrink-0" aria-hidden="true">
      <Show when={props.pulse}>
        <span
          class={`absolute inline-flex size-full animate-ping rounded-full opacity-30 ${statusTone(props.status)}`}
        />
      </Show>
      <span class={`relative inline-flex size-2 rounded-full ${statusTone(props.status)}`} />
    </span>
  )
}

function BoardCard(props: {
  agent: DashboardAgentInput
  now: number
  groupLabel?: string
  onOpen?: (id: string) => void
}) {
  const details = () => agentCardDetails(props.agent)
  const title = () => props.agent.taskPrompt.trim() || props.agent.name

  return (
    <button
      type="button"
      class="group w-full rounded-[13px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] p-3.5 text-left shadow-[0_8px_24px_rgba(0,0,0,0.1)] transition duration-150 hover:-translate-y-px hover:border-[color:var(--vx-line-strong)] hover:bg-[color:var(--vx-surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--vx-purple)]/65"
      aria-label={`Open ${props.agent.name}: ${title()}, ${statusLabel(props.agent.status)}`}
      onClick={() => props.onOpen?.(props.agent.id)}
    >
      <div class="mb-2.5 flex items-start gap-2.5">
        <AgentMark agent={props.agent} size={28} />
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-1.5">
            <span class="truncate text-[11.5px] text-[color:var(--vx-text-muted)]">
              {props.groupLabel || props.agent.runtime}
            </span>
            <Show when={props.agent.swarmRole}>
              <span class="rounded-full bg-[color:var(--vx-purple-soft)] px-1.5 py-0.5 text-[9.5px] text-[color:var(--vx-purple-bright)]">
                {props.agent.swarmRole}
              </span>
            </Show>
          </div>
          <div class="mt-0.5 truncate text-[11px] text-[color:var(--vx-text-muted)]/75">{props.agent.name}</div>
        </div>
        <span class="shrink-0 text-[10.5px] tabular-nums text-[color:var(--vx-text-muted)]">
          {elapsedLabel(props.agent, props.now)}
        </span>
      </div>

      <div class="line-clamp-2 min-h-10 text-[13.5px] font-medium leading-5 text-[color:var(--vx-text)]">{title()}</div>

      <div class="mt-3 flex min-w-0 items-center gap-2">
        <StatusDot status={props.agent.status} pulse={isRunning(props.agent.status)} />
        <span class="min-w-0 flex-1 truncate text-[11.5px] text-[color:var(--vx-text-subtle)]">
          {details().activity}
        </span>
      </div>

      <Show when={isRunning(props.agent.status)}>
        <div
          class="mt-2.5 h-1 overflow-hidden rounded-full bg-[color:var(--vx-control)]"
          role="progressbar"
          aria-label={`${props.agent.name} progress`}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={props.agent.progress}
        >
          <div
            class="h-full rounded-full bg-[linear-gradient(90deg,var(--vx-purple),var(--vx-purple-bright))] transition-[width] duration-500"
            style={{ width: `${Math.max(2, Math.min(100, props.agent.progress))}%` }}
          />
        </div>
      </Show>

      <div class="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-[color:var(--vx-line)] pt-2.5 text-[10.5px] text-[color:var(--vx-text-muted)]">
        <span>{details().changes}</span>
        <Show when={details().cost}>
          <span aria-hidden="true">·</span>
          <span>{details().cost}</span>
        </Show>
        <span class="ml-auto max-w-[48%] truncate">{props.agent.model}</span>
      </div>

      <Show when={props.agent.pullRequestUrl}>
        <div class="mt-2 flex items-center gap-1.5 text-[10.5px] text-[color:var(--vx-green)]">
          <span class="size-1.5 rounded-full bg-[color:var(--vx-green)]" aria-hidden="true" />
          Pull request ready
        </div>
      </Show>
      <Show when={props.agent.previewUrl}>
        {(url) => (
          <div class="mt-2 flex min-w-0 items-center gap-1.5 text-[10.5px] text-[color:var(--vx-text-muted)]">
            <span class="size-1.5 shrink-0 rounded-full bg-[color:var(--vx-purple)]" aria-hidden="true" />
            <span class="truncate">Preview: {url().replace(/^https:\/\//, "")}</span>
          </div>
        )}
      </Show>
    </button>
  )
}

function ListRow(props: {
  agent: DashboardAgentInput
  now: number
  groupLabel?: string
  onOpen?: (id: string) => void
}) {
  const details = () => agentCardDetails(props.agent)
  return (
    <button
      type="button"
      class="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-[color:var(--vx-line)] px-4 py-3 text-left transition last:border-0 hover:bg-[color:var(--vx-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--vx-purple)]/60 sm:grid-cols-[auto_minmax(0,1fr)_minmax(100px,0.5fr)_auto_auto]"
      aria-label={`Open ${props.agent.name}, ${statusLabel(props.agent.status)}`}
      onClick={() => props.onOpen?.(props.agent.id)}
    >
      <AgentMark agent={props.agent} size={28} />
      <div class="min-w-0">
        <div class="truncate text-[12.5px] font-medium text-[color:var(--vx-text)]">
          {props.agent.taskPrompt || props.agent.name}
        </div>
        <div class="mt-0.5 truncate text-[10.5px] text-[color:var(--vx-text-muted)]">
          {props.groupLabel || props.agent.name} · {details().runtime}
        </div>
      </div>
      <div class="hidden min-w-0 items-center gap-2 sm:flex">
        <StatusDot status={props.agent.status} pulse={isRunning(props.agent.status)} />
        <span class="truncate text-[11.5px] text-[color:var(--vx-text-subtle)]">{details().activity}</span>
      </div>
      <span class="hidden shrink-0 text-[11px] text-[color:var(--vx-text-muted)] sm:block">{details().changes}</span>
      <span class="shrink-0 text-[10.5px] tabular-nums text-[color:var(--vx-text-muted)]">
        {elapsedLabel(props.agent, props.now)}
      </span>
    </button>
  )
}

function Conversation(props: { conversation: TeamConversation }) {
  return (
    <details class="mb-3 overflow-hidden rounded-[12px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)]">
      <summary class="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-[12px] text-[color:var(--vx-text-subtle)] hover:bg-[color:var(--vx-control-hover)]">
        <span class="font-medium text-[color:var(--vx-text)]">{props.conversation.teamName}</span>
        <span class="text-[color:var(--vx-text-muted)]">
          {props.conversation.messages.length} message{props.conversation.messages.length === 1 ? "" : "s"}
        </span>
        <span class="ml-auto text-[color:var(--vx-text-muted)]">Team conversation</span>
      </summary>
      <div class="max-h-[260px] overflow-y-auto border-t border-[color:var(--vx-line)] px-3.5 py-3">
        <For each={orderConversation(props.conversation.messages)}>
          {(message) => (
            <div class="mb-2.5 last:mb-0">
              <div class="flex items-baseline gap-2">
                <span class="text-[11.5px] font-medium text-[color:var(--vx-purple-bright)]">{message.fromName}</span>
                <Show when={isDirected(message)}>
                  <span class="text-[10px] text-[color:var(--vx-text-muted)]">replied</span>
                </Show>
                <span class="text-[10px] text-[color:var(--vx-text-muted)]">
                  {new Date(message.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <p class="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed text-[color:var(--vx-text-subtle)]">
                {message.text}
              </p>
            </div>
          )}
        </For>
      </div>
    </details>
  )
}

export function AgentDashboard(props: {
  open: boolean
  agents: DashboardAgentInput[]
  conversations?: TeamConversation[]
  onClose: () => void
  onOpenAgent?: (id: string) => void
}) {
  let dialog: HTMLDivElement | undefined
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))

  createEffect(() => {
    if (!props.open) return
    queueMicrotask(() => dialog?.focus())
  })

  const [view, setView] = createSignal<"board" | "list">("board")
  const [query, setQuery] = createSignal("")
  const [statuses, setStatuses] = createSignal<DashboardAgentStatus[]>([])
  const [runtimes, setRuntimes] = createSignal<string[]>([])
  const [teams, setTeams] = createSignal<string[]>([])
  const [pullRequest, setPullRequest] = createSignal<"open" | "merged" | "none" | undefined>()

  const filters = createMemo(() => ({
    query: query(),
    statuses: statuses(),
    runtimes: runtimes(),
    groups: teams(),
    pullRequest: pullRequest(),
  }))
  const visible = createMemo(() => filterAgents(props.agents, filters()))
  const statusOptions = createMemo(() => [...new Set(props.agents.map((agent) => agent.status))].sort())
  const runtimeOptions = createMemo(() => [...new Set(props.agents.map((agent) => agent.runtime))].sort())
  const teamOptions = createMemo(() =>
    groupAgents(props.agents)
      .filter((group) => group.swarm)
      .map((group) => ({ id: group.id, label: group.label })),
  )

  const clearFilters = () => {
    setQuery("")
    setStatuses([])
    setRuntimes([])
    setTeams([])
    setPullRequest(undefined)
  }

  const teamLabelFor = (agent: DashboardAgentInput) =>
    teamOptions().find((team) => team.id === (agent.swarmRunId ?? agent.teamId))?.label

  const summary = createMemo(() => summarize(visible()))
  const clashes = createMemo(() => findClashes(visible()))
  const columns = createMemo(() => boardColumns(visible()))
  const conversations = createMemo(() => {
    if (!hasActiveFilters(filters())) return props.conversations ?? []
    const groups = new Set(visible().flatMap((agent) => [agent.swarmRunId, agent.teamId].filter(Boolean)))
    return (props.conversations ?? []).filter((conversation) => groups.has(conversation.teamId))
  })

  return (
    <Show when={props.open}>
      <div
        ref={dialog}
        data-vector-agent-dashboard
        role="dialog"
        aria-modal="true"
        aria-label="Agent Dashboard"
        tabIndex={-1}
        class="fixed inset-0 z-[90] flex min-h-0 flex-col overflow-hidden bg-[color:var(--vx-canvas)] text-[color:var(--vx-text)] outline-none"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.stopPropagation()
          props.onClose()
        }}
      >
        <header
          data-vector-agent-dashboard-header
          class="flex h-[60px] shrink-0 items-center gap-3 border-b border-[color:var(--vx-line)] bg-[color:var(--vx-sidebar)] px-4 sm:px-6"
        >
          <span
            class="grid size-8 shrink-0 place-items-center rounded-[9px] bg-[color:var(--vx-purple-soft)] text-[color:var(--vx-purple-bright)]"
            aria-hidden="true"
          >
            <svg viewBox="0 0 18 18" class="size-4">
              <rect x="2.5" y="3" width="4.3" height="5" rx="1" fill="currentColor" opacity=".7" />
              <rect x="6.9" y="3" width="4.3" height="7.5" rx="1" fill="currentColor" />
              <rect x="11.3" y="3" width="4.3" height="11" rx="1" fill="currentColor" opacity=".75" />
            </svg>
          </span>
          <div class="min-w-0">
            <h1 class="truncate text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--vx-text)]">
              Agent Dashboard
            </h1>
            <p class="hidden truncate text-[10.5px] text-[color:var(--vx-text-muted)] sm:block">
              Every workspace, agent, and review in one place
            </p>
          </div>
          <div class="ml-auto hidden items-center gap-4 text-[11px] text-[color:var(--vx-text-muted)] md:flex">
            <span>
              <strong class="font-medium text-[color:var(--vx-text-subtle)]">{summary().running}</strong> running
            </span>
            <span>
              <strong class="font-medium text-[color:var(--vx-text-subtle)]">{summary().attention}</strong> need you
            </span>
            <span>
              <strong class="font-medium text-[color:var(--vx-text-subtle)]">{summary().finished}</strong> done
            </span>
          </div>
          <button
            type="button"
            aria-label="Close Agent Dashboard"
            class="ml-1 grid size-8 place-items-center rounded-[8px] text-[color:var(--vx-text-muted)] transition hover:bg-[color:var(--vx-control-hover)] hover:text-[color:var(--vx-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--vx-purple)]/60"
            onClick={props.onClose}
          >
            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
              <path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <main data-vector-agent-dashboard-main class="min-h-0 flex-1 overflow-y-auto">
          <div class="mx-auto w-full max-w-[1580px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
            <section aria-label="Dashboard controls" class="mb-5">
              <div class="flex flex-col gap-3 xl:flex-row xl:items-center">
                <div class="flex h-9 w-fit shrink-0 items-center rounded-[9px] border border-[color:var(--vx-line)] bg-[color:var(--vx-control)] p-0.5">
                  <For each={["board", "list"] as const}>
                    {(mode) => (
                      <button
                        type="button"
                        class="h-7 rounded-[7px] px-4 text-[12px] capitalize transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--vx-purple)]/60"
                        classList={{
                          "bg-[color:var(--vx-purple-soft)] font-medium text-[color:var(--vx-text)] shadow-sm":
                            view() === mode,
                          "text-[color:var(--vx-text-muted)] hover:text-[color:var(--vx-text)]": view() !== mode,
                        }}
                        aria-pressed={view() === mode}
                        onClick={() => setView(mode)}
                      >
                        {mode}
                      </button>
                    )}
                  </For>
                </div>

                <label class="relative block w-full xl:max-w-[460px]">
                  <span class="sr-only">Search agents</span>
                  <svg
                    viewBox="0 0 16 16"
                    class="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[color:var(--vx-text-muted)]"
                    aria-hidden="true"
                  >
                    <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" stroke-width="1.3" />
                    <path
                      d="m10.2 10.2 3 3"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.3"
                      stroke-linecap="round"
                    />
                  </svg>
                  <input
                    class="h-9 w-full rounded-[9px] border border-[color:var(--vx-line)] bg-[color:var(--vx-control)] pl-9 pr-3 text-[12.5px] text-[color:var(--vx-text)] outline-none transition placeholder:text-[color:var(--vx-text-muted)] focus:border-[color:var(--vx-purple)]/55 focus:ring-2 focus:ring-[color:var(--vx-purple)]/15"
                    placeholder="Search agents, tasks, models, or activity"
                    value={query()}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                  />
                </label>

                <div class="flex flex-wrap items-center gap-1.5 xl:ml-auto">
                  <FilterMenu
                    label="Status"
                    options={statusOptions().map((status) => ({ value: status, label: statusLabel(status) }))}
                    selected={statuses()}
                    onToggle={(value) => setStatuses((current) => toggled(current, value))}
                  />
                  <Show when={teamOptions().length}>
                    <FilterMenu
                      label="Team"
                      options={teamOptions().map((team) => ({ value: team.id, label: team.label }))}
                      selected={teams()}
                      onToggle={(value) => setTeams((current) => toggled(current, value))}
                    />
                  </Show>
                  <FilterMenu
                    label="Runtime"
                    options={runtimeOptions().map((runtime) => ({ value: runtime, label: runtime }))}
                    selected={runtimes()}
                    onToggle={(value) => setRuntimes((current) => toggled(current, value))}
                  />
                  <FilterMenu
                    label="Pull request"
                    options={
                      [
                        { value: "open", label: "Open" },
                        { value: "merged", label: "Merged" },
                        { value: "none", label: "No pull request" },
                      ] satisfies FilterOption<"open" | "merged" | "none">[]
                    }
                    selected={pullRequest() ? [pullRequest()!] : []}
                    onToggle={(value) => setPullRequest((current) => (current === value ? undefined : value))}
                  />
                  <Show when={hasActiveFilters(filters())}>
                    <button
                      type="button"
                      class="h-8 shrink-0 px-2 text-[11.5px] text-[color:var(--vx-text-muted)] transition hover:text-[color:var(--vx-text)]"
                      onClick={clearFilters}
                    >
                      Clear
                    </button>
                  </Show>
                </div>
              </div>

              <div class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-[color:var(--vx-text-muted)]">
                <span>
                  {summary().total} {summary().total === 1 ? "agent" : "agents"}
                </span>
                <span>{summary().changedFiles} files touched</span>
                <Show when={summary().teams}>
                  <span>
                    {summary().teams} {summary().teams === 1 ? "team" : "teams"}
                  </span>
                </Show>
                <Show when={summary().clashes}>
                  <span class="text-[color:var(--vx-red)]">
                    {summary().clashes} {summary().clashes === 1 ? "file conflict" : "file conflicts"}
                  </span>
                </Show>
              </div>
            </section>

            <Show when={clashes().length}>
              <section
                aria-label="File conflicts"
                class="mb-4 rounded-[12px] border border-[color:var(--vx-red)]/25 bg-[color:var(--vx-red)]/[0.055] px-3.5 py-3"
              >
                <div class="mb-1 text-[12px] font-medium text-[color:var(--vx-text)]">
                  {clashes().length === 1
                    ? "Two agents are editing the same file"
                    : `${clashes().length} files are being edited by multiple agents`}
                </div>
                <For each={clashes()}>
                  {(clash) => (
                    <div class="text-[11px] text-[color:var(--vx-text-subtle)]">
                      <span class="font-mono">{clash.file}</span> · {clash.agentNames.join(", ")}
                    </div>
                  )}
                </For>
                <div class="mt-1 text-[10.5px] text-[color:var(--vx-text-muted)]">
                  Review one workspace before merging the other.
                </div>
              </section>
            </Show>

            <For each={conversations()}>
              {(conversation) => (
                <Show when={conversation.messages.length}>
                  <Conversation conversation={conversation} />
                </Show>
              )}
            </For>

            <Show
              when={visible().length}
              fallback={
                <div class="rounded-[14px] border border-dashed border-[color:var(--vx-line)] bg-[color:var(--vx-stage)] px-5 py-14 text-center">
                  <div class="text-[13px] font-medium text-[color:var(--vx-text)]">
                    {props.agents.length ? "No matching agents" : "No agents yet"}
                  </div>
                  <p class="mt-1 text-[11.5px] text-[color:var(--vx-text-muted)]">
                    {props.agents.length
                      ? "Try clearing one or more filters."
                      : "Start an isolated workspace and its live status will appear here."}
                  </p>
                  <Show when={props.agents.length}>
                    <button
                      type="button"
                      class="mt-3 rounded-[8px] bg-[color:var(--vx-purple-soft)] px-3 py-1.5 text-[11.5px] text-[color:var(--vx-purple-bright)]"
                      onClick={clearFilters}
                    >
                      Clear filters
                    </button>
                  </Show>
                </div>
              }
            >
              <Show when={view() === "board"}>
                <div class="grid grid-cols-1 items-start gap-3 lg:grid-cols-3" aria-label="Agent board">
                  <For each={columns()}>
                    {(column) => (
                      <section
                        class="min-w-0 rounded-[15px] border border-[color:var(--vx-line)] bg-[color:var(--vx-stage)] p-2.5 shadow-[0_12px_36px_rgba(0,0,0,0.08)]"
                        aria-labelledby={`agent-column-${column.id}`}
                      >
                        <div class="mb-2.5 flex items-center gap-2 px-1.5 py-1">
                          <h2
                            id={`agent-column-${column.id}`}
                            class="text-[12.5px] font-semibold text-[color:var(--vx-text-subtle)]"
                          >
                            {column.label}
                          </h2>
                          <span class="grid min-w-5 place-items-center rounded-full bg-[color:var(--vx-control)] px-1.5 py-0.5 text-[10px] tabular-nums text-[color:var(--vx-text-muted)]">
                            {column.agents.length}
                          </span>
                        </div>
                        <div class="flex flex-col gap-2">
                          <For each={column.agents}>
                            {(item) => (
                              <div>
                                <BoardCard
                                  agent={item}
                                  now={now()}
                                  groupLabel={teamLabelFor(item)}
                                  onOpen={props.onOpenAgent}
                                />
                                <Show when={directoryReviewTarget(item)}>
                                  {(target) => <DirectoryReview {...target()} />}
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                        <Show when={!column.agents.length}>
                          <div class="rounded-[11px] border border-dashed border-[color:var(--vx-line)] px-3 py-8 text-center text-[11px] text-[color:var(--vx-text-muted)]">
                            Nothing here
                          </div>
                        </Show>
                      </section>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={view() === "list"}>
                <div
                  class="overflow-hidden rounded-[14px] border border-[color:var(--vx-line)] bg-[color:var(--vx-stage)]"
                  aria-label="Agent list"
                >
                  <For each={columns()}>
                    {(column) => (
                      <Show when={column.agents.length}>
                        <div class="flex items-center gap-2 border-b border-[color:var(--vx-line)] bg-[color:var(--vx-control)] px-4 py-2.5">
                          <span class="text-[11.5px] font-medium text-[color:var(--vx-text-subtle)]">
                            {column.label}
                          </span>
                          <span class="text-[10.5px] text-[color:var(--vx-text-muted)]">{column.agents.length}</span>
                        </div>
                        <For each={column.agents}>
                          {(item) => (
                            <div>
                              <ListRow
                                agent={item}
                                now={now()}
                                groupLabel={teamLabelFor(item)}
                                onOpen={props.onOpenAgent}
                              />
                              <Show when={directoryReviewTarget(item)}>
                                {(target) => <DirectoryReview {...target()} />}
                              </Show>
                            </div>
                          )}
                        </For>
                      </Show>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </main>
      </div>
    </Show>
  )
}
