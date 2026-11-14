import "./background-tasks.css"
import { createEffect, createSignal, on, Show, type Accessor } from "solid-js"
import { useLanguage } from "@/context/language"
import { backgroundTasksPane } from "./background-tasks-state"
import { ChevronIcon } from "./icons"
import {
  countAgents,
  elapsedMs,
  formatAgentCount,
  formatDuration,
  kindLabel,
  statusSummary,
  statusWord,
  type TaskLocation,
} from "./subagent-model"
import { TaskSquares } from "./task-squares"
import { useBackgroundTasks } from "./use-background-tasks"

/**
 * The inline card where a phase of subagents started: one chip per assistant
 * message, drawn at its first task part. Clicking it shows the phase in
 * Background tasks; Cmd or Ctrl-click on a single agent opens its session.
 * While the phase blocks the main turn, "Move to background" sits beside the
 * chip, never inside its button.
 */
export function SubagentTaskChip(props: { location: Accessor<TaskLocation>; onSizeChange?: () => void }) {
  const tasks = useBackgroundTasks()
  const language = useLanguage()
  const card = () => props.location().card
  const phase = () => props.location().phase
  const agents = () => phase().agents
  // More agents can wrap the squares onto another line; the timeline is virtualized.
  createEffect(
    on(
      () => agents().length,
      () => props.onSizeChange?.(),
      { defer: true },
    ),
  )
  const single = () => (agents().length === 1 ? agents()[0] : undefined)
  const title = () =>
    single()?.title ??
    agents()
      .map((agent) => agent.title)
      .join(", ")
  const kind = () => kindLabel(agents())
  const count = () => formatAgentCount(countAgents(agents()))
  const word = () => {
    const status = phase().status
    return status === "running" || status === "pending" ? undefined : statusWord(status)
  }
  const elapsed = () => formatDuration(elapsedMs(phase(), tasks?.now() ?? Date.now()))
  const label = () =>
    [title(), kind(), count(), elapsed(), statusSummary(agents().map((a) => a.status))].filter(Boolean).join(", ") +
    ". Show in Background tasks"

  // Only agents the root launched in the foreground, offered by the engine (`controls.background`).
  const promotable = () => (tasks ? tasks.promotable(agents()) : [])
  const blocked = () => !!tasks && promotable().length > 0 && tasks.promoteBlocked(agents())
  const [promoting, setPromoting] = createSignal(false)
  // The row grows or shrinks when the control comes or goes; the timeline measures it again.
  createEffect(
    on(
      () => [promotable().length > 0, blocked()] as const,
      () => props.onSizeChange?.(),
      { defer: true },
    ),
  )
  const promote = async () => {
    if (!tasks || promoting()) return
    setPromoting(true)
    await tasks.promote(agents()).finally(() => setPromoting(false))
  }

  const open = (event: MouseEvent) => {
    const agent = single()
    if ((event.metaKey || event.ctrlKey) && agent?.sessionID && tasks) {
      tasks.openAgent(agent)
      return
    }
    backgroundTasksPane.revealCard(card().key, phase().key)
  }

  return (
    <div data-component="tool-part-wrapper" data-timeline-part-id={props.location().agent.partID}>
      <button
        type="button"
        class="vector-task-chip"
        data-status={phase().status}
        aria-controls="vector-bg-tasks"
        aria-expanded={backgroundTasksPane.opened()}
        aria-label={label()}
        onClick={open}
      >
        <span class="vector-task-chip-title">{title()}</span>
        <ChevronIcon />
        <span class="vector-task-chip-meta">
          <span>{kind()}</span>
          <Show when={phase().index > 1}>
            <span>Phase {phase().index}</span>
          </Show>
          <span class="vector-task-chip-dim">{count()}</span>
          <Show when={word()}>
            <span class="vector-task-chip-status" data-status={phase().status}>
              {word()}
            </span>
          </Show>
          <span class="vector-task-chip-dim">
            <time>{elapsed()}</time>
          </span>
        </span>
        <TaskSquares agents={agents()} class="vector-task-chip-squares" squareClass="vector-task-chip-square" />
      </button>
      <Show when={promotable().length > 0}>
        <div class="vector-task-chip-actions">
          <Show
            when={!blocked()}
            fallback={
              <span class="vector-task-chip-note">{language.t("backgroundTasks.promote.batchUnsupported")}</span>
            }
          >
            <button
              type="button"
              class="vector-task-chip-promote"
              disabled={promoting()}
              aria-busy={promoting()}
              onClick={promote}
            >
              {language.t("backgroundTasks.promote")}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
