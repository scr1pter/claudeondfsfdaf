import "./background-tasks.css"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { createMediaQuery } from "@solid-primitives/media"
import { backgroundTasksPane } from "./background-tasks-state"
import {
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  CollapseIcon,
  DockIcon,
  ExpandIcon,
  PopOutIcon,
  StopIcon,
  TrashIcon,
} from "./icons"
import {
  countAgents,
  elapsedMs,
  formatDuration,
  formatTokens,
  isLive,
  isolationLabel,
  KIND_LABEL,
  modelEffortLabel,
  queuedLabel,
  resultChip,
  statusWord,
  waitingLabel,
  type TaskAgent,
  type TaskCard,
  type TaskPhase,
  type TaskStatus,
  type TaskWorkflowStage,
} from "./subagent-model"
import { TaskSquares } from "./task-squares"
import { ownerOnlyRefusal, type BackgroundTasks } from "./background-tasks"
import { useBackgroundTasks } from "./use-background-tasks"
import type { Task } from "@vectordevai/schema/task"
import { taskCost, taskSpend } from "./task-board-model"
import { limitsLine, type TaskTranslate } from "./task-limits"
import { CodiumUsage } from "@vectordevai/core/codium-usage"
import { useLanguage } from "@/context/language"

const MAX_ROWS = 12
/** How long a first click on Merge or Discard stays armed, as the workspace controls' confirmTwice. */
const CONFIRM_MS = 4_000

/** Destructive controls confirm inline: the first click arms the button, a second within 4 s runs it. */
function createConfirm() {
  const [armed, setArmed] = createSignal<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  return {
    armed,
    run(key: string, action: () => void) {
      clearTimeout(timer)
      if (armed() === key) {
        setArmed(undefined)
        action()
        return
      }
      setArmed(key)
      timer = setTimeout(() => setArmed(undefined), CONFIRM_MS)
    },
  }
}

const failureText = (error: unknown) =>
  error instanceof Error ? error.message : "The action could not be completed. Partial work has been kept."

function bytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

/** Structured JSON as text: re-indented when it parses, as sent when it was cut short. Never markup. */
function prettyJson(json: string) {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

const SENDERS = ["user", "parent", "peer", "task"] as const
function senderLabel(sender: string, t: TaskTranslate) {
  const known = SENDERS.find((value) => value === sender)
  return known ? t(`backgroundTasks.messages.${known}`) : sender
}

const SHELL_STATUSES = ["running", "completed", "failed", "stopped", "interrupted"] as const
function shellStatus(status: string, t: TaskTranslate) {
  const known = SHELL_STATUSES.find((value) => value === status)
  return known ? t(`backgroundTasks.shells.status.${known}`) : status
}

const domKey = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_")
const cardDomID = (cardKey: string) => `vector-bg-tasks-card-${domKey(cardKey)}`
const phaseDomID = (cardKey: string, phaseKey: string) => `${cardDomID(cardKey)}-p-${domKey(phaseKey)}`

function focusLauncher() {
  document.querySelector<HTMLElement>("[data-vector-bg-tasks-launch]")?.focus()
}

/**
 * The Background tasks pane. Docked, it is the last column of the session
 * split row (session.tsx reserves its width). Popped out, or as the sheet
 * below 768px, it is portalled to the body and floats over the window.
 */
export function BackgroundTasksPane() {
  const tasks = useBackgroundTasks()
  return (
    <Show when={tasks && tasks.rootID() && backgroundTasksPane.opened()}>
      <Pane tasks={tasks!} />
    </Show>
  )
}

function Pane(props: { tasks: BackgroundTasks }) {
  const tasks = props.tasks
  const pane = backgroundTasksPane
  const language = useLanguage()
  const [finishedOpen, setFinishedOpen] = createSignal(false)
  const [announcement, setAnnouncement] = createSignal("")
  const [cardOpen, setCardOpen] = createStore<Record<string, boolean>>({})
  const [phaseOpen, setPhaseOpen] = createStore<Record<string, boolean>>({})
  let aside: HTMLElement | undefined

  const total = () => tasks.live().length + tasks.finished().length

  // Cards already listed when the pane opens are simply there; one that
  // arrives later eases in. For maps a new card before this effect records
  // its key, so the check in card() sees it as new exactly once.
  const seen = new Set(tasks.cards().map((card) => card.key))
  createEffect(() => {
    for (const card of tasks.cards()) seen.add(card.key)
  })

  // The session <main> is its own stacking context (z-index 1, contain:
  // strict), so a fixed pane inside it stays under the sidebar and is clipped
  // to the session column whatever its z-index. Popped out, and as the sheet
  // below 768px (the breakpoint in background-tasks.css), the same element
  // moves to the body, where z-index 40 clears the sidebar and stays under
  // dialogs and toasts. Docked, it stays in the split row.
  const wide = createMediaQuery("(min-width: 768px)")
  const detached = createMemo(() => pane.floating() || !wide())
  const [portaled, setPortaled] = createSignal(detached())
  // The move detaches the pane for a moment, which drops focus: hand it back
  // if nothing else took it.
  createEffect(
    on(
      detached,
      (next) => {
        const active = document.activeElement
        const focused = active instanceof HTMLElement && aside?.contains(active) ? active : undefined
        setPortaled(next)
        requestAnimationFrame(() => {
          const current = document.activeElement
          if (focused?.isConnected && (!current || current === document.body)) focused.focus({ preventScroll: true })
        })
      },
      { defer: true },
    ),
  )

  // Popped out, the pane hangs from the session header's bottom edge, clear of
  // the composer's send and stop button at the bottom of the window. The edge
  // is measured, not assumed, and measured again when it moves without the
  // window resizing: density changes the header's height, and the legacy 40px
  // titlebar pushes it down by shrinking the stage that holds it, so both are
  // watched. Another root session can mount a new header, so it is looked up
  // again then (rootID is always set while the pane is shown).
  //
  // It hangs below the conversation's title bar too, when there is one, so it
  // never covers the title's controls at the conversation's top right.
  //
  // It also stands clear of an open Changes panel (#review-panel): 16px left
  // of the panel while the conversation leaves room for that and the 16px gap
  // on its other side, else 16px from the window edge, over the panel. Its
  // right edge glides as the panel opens, closes or resizes, but only once
  // placed (`settled`), so it never slides in from the window edge.
  const [float, setFloat] = createStore<{ top?: number; right?: number; settled: boolean }>({ settled: false })
  createEffect(() => {
    if (!pane.floating() || !tasks.rootID()) return
    const find = () => document.querySelector<HTMLElement>("[data-vector-session-header]")
    const place = () => {
      const header = find()
      const title = document.querySelector("[data-vector-session-conversation] [data-session-title]")
      const bottom = Math.max(header?.getBoundingClientRect().bottom ?? 0, title?.getBoundingClientRect().bottom ?? 0)
      const panel = document.getElementById("review-panel")
      const edge = panel?.getAttribute("aria-hidden") === "true" ? undefined : panel?.getBoundingClientRect()
      const start = document.querySelector("[data-vector-session-conversation]")?.getBoundingClientRect().left ?? 0
      const clear = edge !== undefined && edge.width > 0 && edge.left - 32 - (aside?.offsetWidth ?? 0) >= start
      setFloat({
        top: bottom > 0 ? Math.round(bottom) : undefined,
        right: clear ? Math.round(window.innerWidth - edge.left + 16) : 16,
      })
    }
    let observer: ResizeObserver | undefined
    // A frame later, once a new session's header has rendered.
    const frame = requestAnimationFrame(() => {
      place()
      setFloat("settled", true)
      if (typeof ResizeObserver === "undefined") return
      const resize = new ResizeObserver(place)
      observer = resize
      const header = find()
      const stage = header?.closest<HTMLElement>("[data-vector-main-stage]")
      const panel = document.getElementById("review-panel")
      for (const element of [header, stage, panel, aside]) if (element) resize.observe(element)
    })
    place()
    window.addEventListener("resize", place)
    onCleanup(() => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener("resize", place)
      setFloat("settled", false)
    })
  })

  const close = () => {
    pane.close()
    focusLauncher()
  }

  // Esc closes in both modes; the dock button is the way to dock.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  // An inline chip asks for its card: open it, expand the phase, bring it into view.
  createEffect(
    on(pane.reveal, (target) => {
      if (!target) return
      pane.clearReveal()
      const card = tasks.cards().find((item) => item.key === target.cardKey)
      if (!card) return
      if (!card.live) {
        // The Finished list leaves out cards the trash hid; bring this one back.
        tasks.undismiss(card.key)
        setFinishedOpen(true)
        setCardOpen(card.key, true)
      }
      if (target.phaseKey) setPhaseOpen(`${card.key}\n${target.phaseKey}`, true)
      requestAnimationFrame(() => {
        const element = document.getElementById(cardDomID(card.key))
        element?.scrollIntoView({ block: "nearest" })
        const toggle = target.phaseKey ? document.getElementById(phaseDomID(card.key, target.phaseKey)) : undefined
        ;(toggle ?? element)?.focus({ preventScroll: true })
      })
    }),
  )

  // Announce transitions only, never the ticking clock. A card that first
  // shows up already settled (children fetched, history loaded, another
  // session opened) is not a transition, so only keys seen before count.
  let previous: { root: string | undefined; statuses: Map<string, TaskStatus> } | undefined
  createEffect(() => {
    const root = tasks.rootID()
    const cards = tasks.cards()
    const statuses = new Map(cards.map((card) => [card.key, card.status] as const))
    if (previous && previous.root === root) {
      for (const card of cards) {
        const before = previous.statuses.get(card.key)
        if (before === undefined || before === card.status) continue
        if (card.status === "done") setAnnouncement(`${card.title}: done`)
        if (card.status === "failed") setAnnouncement(`${card.title}: failed`)
        if (card.status === "stopped") setAnnouncement(`${card.title}: stopped`)
        if (card.status === "waiting") setAnnouncement(`${card.title}: needs you`)
      }
    }
    previous = { root, statuses }
  })

  const [stoppingAll, setStoppingAll] = createSignal(false)
  const stopAll = async () => {
    if (stoppingAll()) return
    setStoppingAll(true)
    await tasks.stopAllBackground().finally(() => setStoppingAll(false))
  }

  const toggleFinished = () => {
    const next = !finishedOpen()
    setFinishedOpen(next)
    if (!next) return
    requestAnimationFrame(() =>
      document.getElementById("vector-bg-tasks-finished")?.scrollIntoView({ block: "nearest" }),
    )
  }

  // Clearing takes the Finished row, and the Clear button that had focus,
  // with it; the pane's title takes focus instead of the page.
  const clearFinished = () => {
    tasks.clearFinished()
    setFinishedOpen(false)
    requestAnimationFrame(() => {
      const current = document.activeElement
      if (!current || current === document.body)
        document.getElementById("vector-bg-tasks-title")?.focus({ preventScroll: true })
    })
  }

  const phaseState = (card: TaskCard, phase: TaskPhase) => {
    const key = `${card.key}\n${phase.key}`
    return {
      open: () => phaseOpen[key] ?? (phase.status === "running" || phase.status === "waiting"),
      toggle: () => setPhaseOpen(key, !(phaseOpen[key] ?? (phase.status === "running" || phase.status === "waiting"))),
    }
  }

  const card = (item: TaskCard, finished: boolean) => (
    <li>
      <CardView
        card={item}
        finished={finished}
        fresh={!seen.has(item.key)}
        tasks={tasks}
        open={!!cardOpen[item.key]}
        onToggle={() => setCardOpen(item.key, !cardOpen[item.key])}
        phase={phaseState}
      />
    </li>
  )

  // Built once and moved between the split row and the portal, so open
  // cards, phases and the scroll position survive a pop-out or a resize.
  const view = (
    <aside
      ref={(element) => {
        aside = element
      }}
      id="vector-bg-tasks"
      class="vector-bg-tasks"
      data-docked={pane.floating() ? undefined : ""}
      data-floating={pane.floating() ? "" : undefined}
      data-expanded={pane.expanded() ? "" : undefined}
      data-settled={float.settled ? "" : undefined}
      style={{
        "--bgt-float-top": float.top === undefined ? undefined : `${float.top}px`,
        "--bgt-float-right": float.right === undefined ? undefined : `${float.right}px`,
      }}
      aria-labelledby="vector-bg-tasks-title"
      onKeyDown={onKeyDown}
    >
      <header class="vector-bg-tasks-header">
        <h2 id="vector-bg-tasks-title" class="vector-bg-tasks-title" tabIndex={-1}>
          Background tasks
        </h2>
        <button
          type="button"
          class="vector-bg-tasks-icon-btn"
          aria-pressed={pane.floating()}
          aria-label={pane.floating() ? "Dock background tasks" : "Pop out background tasks"}
          title={pane.floating() ? "Dock" : "Pop out"}
          onClick={() => pane.setFloating(!pane.floating())}
        >
          <Show when={pane.floating()} fallback={<PopOutIcon />}>
            <DockIcon />
          </Show>
        </button>
        <button
          type="button"
          class="vector-bg-tasks-icon-btn"
          aria-pressed={pane.expanded()}
          aria-label={pane.expanded() ? "Collapse panel" : "Expand panel"}
          title={pane.expanded() ? "Collapse" : "Expand"}
          onClick={() => pane.setExpanded(!pane.expanded())}
        >
          <Show when={pane.expanded()} fallback={<ExpandIcon />}>
            <CollapseIcon />
          </Show>
        </button>
        <button
          type="button"
          class="vector-bg-tasks-icon-btn"
          aria-label="Close background tasks"
          title="Close"
          onClick={close}
        >
          <CloseIcon />
        </button>
      </header>
      <Show when={tasks.error()}>
        <p class="vector-bg-tasks-notice" role="status">
          {tasks.error()}
        </p>
      </Show>
      {/* The conversation's limits and this request's delegated spend; only the owner's engine sends them. */}
      <Show when={tasks.limits()}>
        {(limits) => (
          <p class="vector-bg-tasks-limits" data-component="task-limits">
            {limitsLine(limits(), language.t)}
          </p>
        )}
      </Show>
      <Show when={total() > 0}>
        <p class="vector-bg-tasks-total">Subagent spend · {taskCost(tasks.cards().flatMap((card) => card.agents))}</p>
      </Show>

      <Show
        when={total() > 0 || tasks.shells().length > 0 || tasks.interrupted().length > 0}
        fallback={
          <div class="vector-bg-tasks-empty">
            <p class="vector-bg-tasks-empty-title">No background tasks</p>
            <p class="vector-bg-tasks-empty-body">Subagents and subagent specialists show up here while they work.</p>
          </div>
        }
      >
        {/* Two sections under quiet labels, as in the reference: Running, then
            Finished, whose label is its toggle and carries the Clear button. */}
        <div class="vector-bg-tasks-list">
          <Show when={tasks.interrupted().length > 0}>
            <InterruptedSection tasks={tasks} t={language.t} />
          </Show>
          <section class="vector-bg-tasks-section" aria-labelledby="vector-bg-tasks-running">
            <div class="vector-bg-tasks-section-head">
              <h3 id="vector-bg-tasks-running" class="vector-bg-tasks-section-label">
                Running
              </h3>
              {/* Stop on the main turn leaves background agents running, so they are stopped together here. */}
              <Show when={tasks.liveBackground().length > 0}>
                <button
                  type="button"
                  class="vector-bg-tasks-icon-btn"
                  aria-label="Stop all background tasks"
                  title="Stop all background tasks"
                  aria-busy={stoppingAll()}
                  onClick={stopAll}
                >
                  <StopIcon />
                </button>
              </Show>
            </div>
            <Show
              when={tasks.live().length > 0}
              fallback={<p class="vector-bg-tasks-idle">Nothing running right now</p>}
            >
              <ul class="vector-bg-tasks-cards" aria-label="Running tasks">
                <For each={tasks.live()}>{(item) => card(item, false)}</For>
              </ul>
            </Show>
          </section>
          <Show when={tasks.shells().length > 0}>
            <ShellsSection tasks={tasks} t={language.t} />
          </Show>
          <Show when={tasks.finished().length > 0}>
            <section class="vector-bg-tasks-section" aria-labelledby="vector-bg-tasks-finished-label">
              <div class="vector-bg-tasks-section-head">
                <h3 id="vector-bg-tasks-finished-label" class="vector-bg-tasks-section-label">
                  <button
                    type="button"
                    class="vector-bg-tasks-finished-toggle"
                    aria-expanded={finishedOpen()}
                    aria-controls="vector-bg-tasks-finished"
                    aria-label={`Finished ${tasks.finished().length}`}
                    onClick={toggleFinished}
                  >
                    <span>Finished</span>
                    <span class="vector-bg-tasks-count" aria-hidden="true">
                      {tasks.finished().length}
                    </span>
                    <ChevronIcon />
                  </button>
                </h3>
                <button
                  type="button"
                  class="vector-bg-tasks-icon-btn"
                  aria-label="Clear finished tasks"
                  title="Clear finished tasks"
                  onClick={clearFinished}
                >
                  <TrashIcon />
                </button>
              </div>
              <Show when={finishedOpen()}>
                <ul id="vector-bg-tasks-finished" class="vector-bg-tasks-cards" aria-label="Finished tasks">
                  <For each={tasks.finished()}>{(item) => card(item, true)}</For>
                </ul>
              </Show>
            </section>
          </Show>
        </div>
      </Show>

      <div class="vector-bg-tasks-sr" aria-live="polite">
        {announcement()}
      </div>
    </aside>
  )

  return (
    <Show when={portaled()} fallback={view}>
      <Portal>{view}</Portal>
    </Show>
  )
}

function CardView(props: {
  card: TaskCard
  finished: boolean
  /** Mounted after the pane's first render: plays the entry animation once. */
  fresh: boolean
  tasks: BackgroundTasks
  open: boolean
  onToggle: () => void
  phase: (card: TaskCard, phase: TaskPhase) => { open: () => boolean; toggle: () => void }
}) {
  const id = () => cardDomID(props.card.key)
  const language = useLanguage()
  const [stopping, setStopping] = createSignal(false)
  const [promoting, setPromoting] = createSignal(false)
  // Read once: only a card's first mount can be new.
  const [entering, setEntering] = createSignal(props.fresh)
  const promotable = () => (props.card.live ? props.tasks.promotable(props.card.agents) : [])
  const promote = async () => {
    if (promoting()) return
    setPromoting(true)
    await props.tasks.promote(props.card.agents).finally(() => setPromoting(false))
  }
  const expanded = () => !props.finished || props.open
  const canStop = () =>
    props.card.agents.some((agent) => isLive(agent.status) && (agent.task?.controls.stop ?? !!agent.sessionID))
  const waiting = () => props.card.agents.find((agent) => agent.status === "waiting" && agent.sessionID)
  const mixed = () => new Set(props.card.agents.map((agent) => agent.status)).size > 1
  const agentCount = () => countAgents(props.card.agents)

  const stop = async () => {
    if (stopping()) return
    setStopping(true)
    await props.tasks.stop(props.card).finally(() => setStopping(false))
  }

  return (
    <article
      class="vector-bg-tasks-card"
      id={id()}
      tabIndex={-1}
      data-status={props.card.status}
      data-new={entering() ? "" : undefined}
      aria-labelledby={`${id()}-title`}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setEntering(false)
      }}
    >
      <div class="vector-bg-tasks-card-head">
        <Show
          when={props.finished}
          fallback={
            <h4 id={`${id()}-title`} class="vector-bg-tasks-card-title" title={props.card.title}>
              {props.card.title}
            </h4>
          }
        >
          <h4 id={`${id()}-title`} class="vector-bg-tasks-card-heading">
            <button
              type="button"
              class="vector-bg-tasks-card-toggle"
              aria-expanded={props.open}
              title={props.card.title}
              onClick={props.onToggle}
            >
              <span>{props.card.title}</span>
              <ChevronIcon />
            </button>
          </h4>
        </Show>
        <Show
          when={props.card.live}
          fallback={
            <span class="vector-bg-tasks-card-status" data-status={props.card.status}>
              {statusWord(props.card.status)}
            </span>
          }
        >
          <button
            type="button"
            class="vector-bg-tasks-stop"
            aria-label={`Stop ${props.card.title}`}
            title="Stop"
            aria-busy={stopping()}
            disabled={stopping() || !canStop()}
            onClick={stop}
          >
            <StopIcon />
          </button>
        </Show>
      </div>
      {/* What it is and how long it has run, then how big it is: the counts
          read a step brighter than the words after them. */}
      <p class="vector-bg-tasks-meta">
        <span class="vector-bg-tasks-kind">{props.card.kindLabel}</span>
        <Show when={waiting()}>
          {(agent) => (
            <button
              type="button"
              class="vector-bg-tasks-attention"
              aria-label={`Respond to ${agent().title}`}
              title={`Open ${agent().title} to respond`}
              onClick={() => props.tasks.openAgent(agent())}
            >
              Needs you
            </button>
          )}
        </Show>
        <time class="vector-bg-tasks-time">{formatDuration(elapsedMs(props.card, props.tasks.now()))}</time>
      </p>
      <p class="vector-bg-tasks-meta vector-bg-tasks-counts">
        <span>
          <span class="vector-bg-tasks-num">{agentCount()}</span> {agentCount() === 1 ? "agent" : "agents"}
        </span>
        <Show when={props.card.tokens !== undefined || taskSpend(props.card.agents).codiumSteps}>
          <span>
            <span class="vector-bg-tasks-num">
              {CodiumUsage.withCodium(
                props.card.tokens || !taskSpend(props.card.agents).codiumSteps
                  ? `${formatTokens(props.card.tokens)} tokens`
                  : undefined,
                taskSpend(props.card.agents).codiumSteps,
              )}
            </span>
          </span>
        </Show>
        <span>{taskCost(props.card.agents)}</span>
      </p>
      {/* Frees the main turn from the card's blocking subagents; each reports later on its own. */}
      <Show when={promotable().length > 0}>
        <Show
          when={!props.tasks.promoteBlocked(props.card.agents)}
          fallback={
            <p class="vector-bg-tasks-promote-note">{language.t("backgroundTasks.promote.batchUnsupported")}</p>
          }
        >
          <div class="vector-bg-tasks-actions vector-bg-tasks-card-actions">
            <button type="button" disabled={promoting()} aria-busy={promoting()} onClick={promote}>
              {language.t("backgroundTasks.promote")}
            </button>
          </div>
        </Show>
      </Show>
      {/* Collapsed, a finished card is its head and facts: the status says
          how it ended. Only when its agents ended differently ("Failed" with two
          done) do the marks show which, read out as "2 done, 1 failed". */}
      <Show
        when={expanded()}
        fallback={
          <Show when={mixed()}>
            <TaskSquares
              agents={props.card.agents}
              class="vector-bg-tasks-squares"
              squareClass="vector-bg-tasks-square"
              labelled
            />
          </Show>
        }
      >
        <Show
          when={!props.card.runID}
          fallback={<WorkflowBody card={props.card} tasks={props.tasks} t={language.t} domID={id()} />}
        >
          {/* Clamped to four lines; the whole of it is the tooltip, and a
              screen reader reads all of it anyway. */}
          <Show when={props.card.description}>
            <p class="vector-bg-tasks-desc" title={props.card.description}>
              {props.card.description}
            </p>
          </Show>
          <h5 id={`${id()}-phases`} class="vector-bg-tasks-phases-label">
            Phases
          </h5>
          <ol class="vector-bg-tasks-phases" aria-labelledby={`${id()}-phases`}>
            <For each={props.card.phases}>
              {(phase) => {
                const state = props.phase(props.card, phase)
                return (
                  <PhaseView
                    cardKey={props.card.key}
                    phase={phase}
                    tasks={props.tasks}
                    open={state.open()}
                    onToggle={state.toggle}
                  />
                )
              }}
            </For>
          </ol>
        </Show>
      </Show>
    </article>
  )
}

function PhaseView(props: {
  cardKey: string
  phase: TaskPhase
  tasks: BackgroundTasks
  open: boolean
  onToggle: () => void
}) {
  const toggleID = () => phaseDomID(props.cardKey, props.phase.key)
  const bodyID = () => `${toggleID()}-body`
  return (
    <li class="vector-bg-tasks-phase" data-state={props.phase.status}>
      <button
        type="button"
        id={toggleID()}
        class="vector-bg-tasks-phase-toggle"
        aria-expanded={props.open}
        aria-controls={bodyID()}
        onClick={props.onToggle}
      >
        <span class="vector-bg-tasks-phase-name">{props.phase.name}</span>
        <span class="vector-bg-tasks-phase-count">
          <span aria-hidden="true">
            {props.phase.done}/{props.phase.total}
          </span>
          <span class="vector-bg-tasks-sr">
            {props.phase.done} of {props.phase.total} done
          </span>
        </span>
        <ChevronIcon />
        <TaskSquares
          agents={props.phase.agents}
          class="vector-bg-tasks-squares"
          squareClass="vector-bg-tasks-square"
          labelled
        />
      </button>
      <div class="vector-bg-tasks-phase-body" id={bodyID()} hidden={!props.open}>
        <Show when={props.open}>
          <PhaseTable phase={props.phase} tasks={props.tasks} />
        </Show>
      </div>
    </li>
  )
}

function agentTooltip(agent: TaskAgent) {
  const kind = agent.kind === "specialist" ? `${agent.label} · ${KIND_LABEL.specialist}` : KIND_LABEL.subagent
  const detail = agent.status === "failed" && agent.error ? ` · ${agent.error}` : ""
  return `${agent.title} (${kind})${detail}`
}

function modelTooltip(agent: TaskAgent) {
  if (!agent.model) return agent.effort
  const name = agent.model.variant ? `${agent.model.name} · ${agent.model.variant}` : agent.model.name
  return agent.effort && agent.effort !== "default" ? `${name} · ${agent.effort} effort` : name
}

/**
 * The docked table leaves an agent's name about 77px, so a cut name loses its
 * middle, not its end: the last word stays ("Time t… build", "Time t… tests"),
 * and siblings that share a start stay apart. A one-word name, or a last word
 * too long to keep whole (over 8 letters), cuts at the end as usual.
 */
function nameParts(title: string) {
  const at = title.lastIndexOf(" ")
  if (at <= 0 || title.length - at > 9) return { head: title, tail: "" }
  return { head: title.slice(0, at), tail: title.slice(at) }
}

function PhaseTable(props: { phase: TaskPhase; tasks: BackgroundTasks }) {
  props.tasks.hold(() => props.phase.agents)
  return <AgentTable name={props.phase.name} agents={props.phase.agents} tasks={props.tasks} />
}

/** The agents of a phase or a workflow stage: one row each, with its details below it. */
function AgentTable(props: { name: string; agents: readonly TaskAgent[]; tasks: BackgroundTasks }) {
  const language = useLanguage()
  const [all, setAll] = createSignal(false)
  const rows = () => (all() ? props.agents : props.agents.slice(0, MAX_ROWS))
  const hidden = () => Math.max(0, props.agents.length - MAX_ROWS)
  return (
    <>
      <table class="vector-bg-tasks-table">
        <caption class="vector-bg-tasks-sr">Agents in {props.name}</caption>
        <colgroup>
          <col />
          <col class="vector-bg-tasks-col-model" />
          <col class="vector-bg-tasks-col-tokens" />
          <col class="vector-bg-tasks-col-time" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Model</th>
            <th scope="col">Tokens</th>
            <th scope="col">Time</th>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(agent) => {
              const name = () => nameParts(agent.title)
              return (
                <>
                  <tr class="vector-bg-tasks-row" data-status={agent.status}>
                    <td>
                      <button
                        type="button"
                        class="vector-bg-tasks-agent"
                        title={agentTooltip(agent)}
                        aria-label={`Open ${agent.title} (${KIND_LABEL[agent.kind]}, ${statusWord(agent.status)})`}
                        disabled={!props.tasks.canOpenAgent(agent)}
                        onClick={() => props.tasks.openAgent(agent)}
                      >
                        {/* A check once done; before that the agent's square (a dot
                        for a specialist) in its status colour. */}
                        <span
                          class="vector-bg-tasks-agent-state"
                          data-status={agent.status}
                          data-kind={agent.kind}
                          aria-hidden="true"
                        >
                          <Show when={agent.status === "done"}>
                            <CheckIcon />
                          </Show>
                        </span>
                        <span class="vector-bg-tasks-agent-name">
                          <span class="vector-bg-tasks-agent-head">{name().head}</span>
                          <Show when={name().tail}>
                            <span class="vector-bg-tasks-agent-tail">{name().tail}</span>
                          </Show>
                        </span>
                      </button>
                    </td>
                    <td title={modelTooltip(agent)}>{modelEffortLabel(agent, language.t) ?? "—"}</td>
                    <td>
                      {CodiumUsage.withCodium(
                        agent.tokens || !agent.codiumSteps ? formatTokens(agent.tokens) : undefined,
                        agent.codiumSteps,
                      )}
                    </td>
                    <td>
                      <time>{formatDuration(elapsedMs(agent, props.tasks.now()))}</time>
                    </td>
                  </tr>
                  <tr class="vector-bg-tasks-detail-row">
                    <td colSpan={4}>
                      <AgentDetails agent={agent} tasks={props.tasks} />
                    </td>
                  </tr>
                </>
              )
            }}
          </For>
        </tbody>
      </table>
      <Show when={!all() && hidden() > 0}>
        <button type="button" class="vector-bg-tasks-more" onClick={() => setAll(true)}>
          Show {hidden()} more
        </button>
      </Show>
    </>
  )
}

function AgentDetails(props: { agent: TaskAgent; tasks: BackgroundTasks }) {
  const [state, setState] = createStore<{
    talk: boolean
    expanded: boolean
    loading: boolean
    sending: boolean
    stopping: boolean
    error?: string
    notice?: string
    detail?: Task.InspectResult
  }>({
    talk: false,
    expanded: false,
    loading: false,
    sending: false,
    stopping: false,
  })
  const language = useLanguage()
  const t = language.t
  const editable = () => props.agent.task?.controls.message ?? (isLive(props.agent.status) && !!props.agent.sessionID)
  const canStop = () => props.agent.task?.controls.stop ?? (isLive(props.agent.status) && !!props.agent.sessionID)
  const identify = () => domKey(props.agent.task?.id ?? props.agent.key)
  const failure = (error: unknown) =>
    error instanceof Error
      ? error.message
      : "The action could not be completed. Your draft and partial work have been kept."
  // A finished engine subagent (never a desktop workspace or a workflow run) can be continued: with this message
  // through route 3 when the engine offers it, or by asking Vector, which continues it by its task_id.
  const desktopTask = () => !!props.agent.task && /^(workspace|swarm):/.test(props.agent.task.id)
  const continuable = () =>
    !isLive(props.agent.status) &&
    !desktopTask() &&
    props.agent.task?.workflow === undefined &&
    !!(props.agent.task?.id ?? props.agent.sessionID)
  const resumable = () => props.agent.task?.controls.resume === true && props.tasks.capabilities().taskResume
  const result = () => resultChip(props.agent.result, t)
  const continueWith = async (text: string) => {
    setState({ sending: true, error: undefined, notice: undefined })
    // A refusal arrives as a toast from resume(); the draft stays for another try.
    const outcome = await props.tasks.resume([props.agent], text)
    if (outcome.resumed.length) {
      if (props.tasks.draft(props.agent).trim() === text) props.tasks.setDraft(props.agent, "")
      setState("notice", t("backgroundTasks.continue.sent"))
    }
    setState("sending", false)
  }
  const inspect = async () => {
    setState({ expanded: !state.expanded, error: undefined })
    if (!state.expanded || state.loading) return
    setState("loading", true)
    await props.tasks
      .inspect(props.agent)
      .then((detail) => setState("detail", detail))
      .catch((error: unknown) => setState("error", failure(error)))
    setState("loading", false)
  }
  const send = async (event: SubmitEvent) => {
    event.preventDefault()
    const text = props.tasks.draft(props.agent).trim()
    const continuing = !editable() && continuable() && resumable()
    if (!text || state.sending || (!editable() && !continuing)) return
    if (new TextEncoder().encode(text).byteLength > 4096) {
      setState("error", "Keep your message within 4 KB. Send a concise direction or file reference.")
      return
    }
    if (continuing) return continueWith(text)
    setState({ sending: true, error: undefined, notice: undefined })
    await props.tasks
      .message(props.agent, text)
      .then(() => {
        if (props.tasks.draft(props.agent).trim() === text) props.tasks.setDraft(props.agent, "")
        setState("notice", "Message queued for the next safe step.")
      })
      .catch((error: unknown) => setState("error", failure(error)))
    setState("sending", false)
  }
  const stop = async () => {
    if (state.stopping) return
    setState({ stopping: true, error: undefined, notice: undefined })
    await props.tasks
      .stopAgent(props.agent)
      .then(() => setState("notice", "Stopped. Partial work has been kept."))
      .catch((error: unknown) => setState("error", failure(error)))
    setState("stopping", false)
  }
  return (
    <div class="vector-bg-tasks-detail">
      <p class="vector-bg-tasks-activity">
        {props.agent.currentStep ?? statusWord(props.agent.status)} <span>· {taskCost([props.agent])}</span>
      </p>
      {/* What the engine says about this run: how it started and what it returns. */}
      <Show when={props.agent.fork || result()}>
        <p class="vector-bg-tasks-badges">
          <Show when={props.agent.fork}>
            <span class="vector-bg-tasks-badge" data-kind="fork" title={t("backgroundTasks.fork.title")}>
              {t("backgroundTasks.fork")}
            </span>
          </Show>
          <Show when={result()}>
            {(chip) => (
              <span class="vector-bg-tasks-badge" data-kind="json" data-state={chip().state} title={chip().title}>
                {chip().label}
              </span>
            )}
          </Show>
        </p>
      </Show>
      <Show when={props.agent.status === "pending" && props.agent.queuedReason}>
        {(reason) => <p class="vector-bg-tasks-queued">{queuedLabel(reason(), t)}</p>}
      </Show>
      <Show when={props.agent.status === "waiting" && props.agent.waiting}>
        {(waiting) => (
          <p class="vector-bg-tasks-waiting">
            <span>{waitingLabel(waiting(), props.tasks.now(), t)}</span>
            <Show when={waiting().summary}>
              <span class="vector-bg-tasks-waiting-summary">{waiting().summary}</span>
            </Show>
            <button
              type="button"
              disabled={!props.tasks.canOpenAgent(props.agent)}
              onClick={() => props.tasks.openAgent(props.agent)}
            >
              {t("backgroundTasks.waiting.answer")}
            </button>
          </p>
        )}
      </Show>
      <Show when={props.agent.isolation}>
        {(isolation) => <WorktreeRow agent={props.agent} isolation={isolation()} tasks={props.tasks} t={t} />}
      </Show>
      <div class="vector-bg-tasks-actions">
        <button
          type="button"
          disabled={!props.agent.sessionID && !props.agent.task?.controls.inspect}
          aria-expanded={state.expanded}
          aria-controls={`task-detail-${identify()}`}
          onClick={inspect}
        >
          {state.loading ? "Loading…" : "Details"}
        </button>
        <Show when={editable() || continuable() || state.talk || props.tasks.draft(props.agent)}>
          <button
            type="button"
            aria-expanded={state.talk}
            aria-controls={`task-message-${identify()}`}
            onClick={() => {
              setState("talk", !state.talk)
              if (state.talk)
                requestAnimationFrame(() => document.getElementById(`task-message-input-${identify()}`)?.focus())
            }}
          >
            Talk to this subagent
          </button>
        </Show>
        <button type="button" onClick={() => props.tasks.ask(props.agent)}>
          Ask Vector about this
        </button>
        <Show when={canStop()}>
          <button type="button" disabled={state.stopping} onClick={stop}>
            {state.stopping ? "Stopping…" : "Stop"}
          </button>
        </Show>
      </div>
      <Show when={(props.agent.dependsOn?.length ?? 0) > 0}>
        <p class="vector-bg-tasks-dependencies">
          Depends on:{" "}
          <For each={props.agent.dependsOn}>
            {(id, index) => {
              const dependency = () =>
                props.tasks
                  .cards()
                  .flatMap((card) => card.agents)
                  .find((agent) => agent.task?.id === id || agent.sessionID === id)
              return (
                <>
                  {index() ? ", " : ""}
                  <button
                    type="button"
                    disabled={!dependency() || !props.tasks.canOpenAgent(dependency()!)}
                    onClick={() => {
                      const agent = dependency()
                      if (agent) props.tasks.openAgent(agent)
                    }}
                  >
                    {dependency()?.title ?? id}
                  </button>
                </>
              )
            }}
          </For>
        </p>
      </Show>
      <Show when={state.talk}>
        <form id={`task-message-${identify()}`} class="vector-bg-tasks-message" onSubmit={send}>
          <label for={`task-message-input-${identify()}`}>Message {props.agent.title}</label>
          <textarea
            id={`task-message-input-${identify()}`}
            rows={3}
            value={props.tasks.draft(props.agent)}
            onInput={(event) => props.tasks.setDraft(props.agent, event.currentTarget.value)}
            placeholder="Add a direction or share a finding…"
          />
          <Show
            when={!editable() && continuable()}
            fallback={
              <>
                <p>
                  {editable()
                    ? "Delivered at the next safe step. Your conversation stays open."
                    : "This task has finished. Open its session to continue; your draft is kept."}
                </p>
                <button type="submit" disabled={!editable() || state.sending || !props.tasks.draft(props.agent).trim()}>
                  {state.sending ? "Sending…" : "Send message"}
                </button>
              </>
            }
          >
            <Show
              when={resumable()}
              fallback={
                <>
                  <p>{t("backgroundTasks.continue.askHelp")}</p>
                  <button type="button" onClick={() => props.tasks.askToContinue(props.agent)}>
                    {t("backgroundTasks.continue.ask")}
                  </button>
                </>
              }
            >
              <p>{t("backgroundTasks.continue.help")}</p>
              <button type="submit" disabled={state.sending || !props.tasks.draft(props.agent).trim()}>
                {state.sending ? t("backgroundTasks.continue.sending") : t("backgroundTasks.continue.send")}
              </button>
            </Show>
          </Show>
        </form>
      </Show>
      <Show when={state.expanded}>
        <div id={`task-detail-${identify()}`} class="vector-bg-tasks-inspect" aria-busy={state.loading}>
          <Show when={(props.agent.ownedPaths?.length ?? 0) > 0}>
            <p>Owned paths: {props.agent.ownedPaths?.join(", ")}</p>
          </Show>
          <Show when={state.detail}>
            {(detail) => (
              <>
                <ol>
                  <For each={detail().steps}>
                    {(step) => <li>{[step.tool, step.status, step.text].filter(Boolean).join(" · ")}</li>}
                  </For>
                </ol>
                <Show when={detail().output}>
                  <pre>{detail().output}</pre>
                </Show>
                {/* A checked JSON answer, as text in a <pre>: whatever it holds is never markup. */}
                <Show when={detail().structured}>
                  {(structured) => (
                    <div class="vector-bg-tasks-structured">
                      <p>
                        {t("backgroundTasks.structured")}{" "}
                        <span
                          class="vector-bg-tasks-badge"
                          data-kind="json"
                          data-state={structured().valid ? "valid" : "invalid"}
                        >
                          {structured().valid
                            ? t("backgroundTasks.structured.valid")
                            : t("backgroundTasks.structured.invalid")}
                        </span>
                      </p>
                      <pre data-component="task-structured">{prettyJson(structured().json)}</pre>
                      <Show when={structured().truncated}>
                        <p>{t("backgroundTasks.structured.truncated")}</p>
                      </Show>
                    </div>
                  )}
                </Show>
                {/* Messages to and from it, each with who sent it, as plain text. */}
                <Show when={(detail().messages?.length ?? 0) > 0}>
                  <div class="vector-bg-tasks-messages">
                    <p>{t("backgroundTasks.messages")}</p>
                    <ol>
                      <For each={detail().messages}>
                        {(message) => (
                          <li data-direction={message.direction}>
                            <span class="vector-bg-tasks-sender">{senderLabel(message.sender, t)}</span>{" "}
                            <span>{message.text}</span>
                          </li>
                        )}
                      </For>
                    </ol>
                  </div>
                </Show>
                <Show when={detail().truncated}>
                  <p>Showing a bounded summary. Open the session for the full history.</p>
                </Show>
                <Show when={detail().task.resultRef}>
                  <p>
                    Artifact: <code>{detail().task.resultRef}</code>
                  </p>
                </Show>
                <Show when={!detail().output && !detail().steps.length}>
                  <p>No activity reported yet.</p>
                </Show>
              </>
            )}
          </Show>
        </div>
      </Show>
      <Show when={state.error}>
        <p class="vector-bg-tasks-action-error" role="alert">
          {state.error}
        </p>
      </Show>
      <Show when={state.notice}>
        <p class="vector-bg-tasks-notice" role="status">
          {state.notice}
        </p>
      </Show>
    </div>
  )
}

/**
 * An isolated child's worktree: branch, state and files, Review (route 4), and Merge and Discard for the owner, each
 * armed by a first click. A merge that conflicts lists the paths and offers to hand them to Vector.
 */
function WorktreeRow(props: {
  agent: TaskAgent
  isolation: NonNullable<TaskAgent["isolation"]>
  tasks: BackgroundTasks
  t: TaskTranslate
}) {
  const confirm = createConfirm()
  const [state, setState] = createStore<{
    reviewing: boolean
    loading: boolean
    busy?: "merge" | "discard"
    changes?: Task.ChangesResult
    conflicts?: readonly string[]
    notice?: string
    error?: string
  }>({ reviewing: false, loading: false })
  const key = (action: string) => `${action}:${props.agent.task?.id ?? props.agent.key}`
  const conflicts = () => state.conflicts ?? props.isolation.conflicts ?? []
  const refused = (error: unknown) =>
    setState("error", ownerOnlyRefusal(error) ? props.t("backgroundTasks.worktree.ownerOnly") : failureText(error))
  const review = async () => {
    const next = !state.reviewing
    setState({ reviewing: next, error: undefined })
    if (!next || state.loading) return
    setState("loading", true)
    await props.tasks
      .changes(props.agent)
      .then((changes) => setState("changes", changes))
      .catch(refused)
    setState("loading", false)
  }
  const merge = () =>
    confirm.run(key("merge"), async () => {
      setState({ busy: "merge", error: undefined, notice: undefined })
      await props.tasks
        .merge(props.agent)
        .then((result) => {
          setState("conflicts", result.conflicts)
          if (!result.conflicts.length)
            setState(
              "notice",
              props.t(`backgroundTasks.worktree.merged.${result.merged.length === 1 ? "one" : "other"}`, {
                count: result.merged.length,
              }),
            )
        })
        .catch(refused)
      setState("busy", undefined)
    })
  const discard = () =>
    confirm.run(key("discard"), async () => {
      setState({ busy: "discard", error: undefined, notice: undefined })
      await props.tasks
        .discard(props.agent)
        .then((result) =>
          setState(
            "notice",
            result.saved
              ? props.t("backgroundTasks.worktree.saved", { path: result.saved })
              : props.t("backgroundTasks.worktree.discarded"),
          ),
        )
        .catch(refused)
      setState("busy", undefined)
    })
  return (
    <div class="vector-bg-tasks-worktree" data-state={props.isolation.state}>
      <p class="vector-bg-tasks-worktree-label">{isolationLabel(props.isolation, props.t)}</p>
      <div class="vector-bg-tasks-actions">
        <Show when={props.agent.task?.id}>
          <button type="button" aria-expanded={state.reviewing} onClick={review}>
            {state.reviewing
              ? props.t("backgroundTasks.worktree.hideReview")
              : props.t("backgroundTasks.worktree.review")}
          </button>
        </Show>
        <Show when={props.agent.task?.controls.merge}>
          <button
            type="button"
            data-action="merge"
            data-armed={confirm.armed() === key("merge") ? "" : undefined}
            disabled={state.busy !== undefined}
            onClick={merge}
          >
            {state.busy === "merge"
              ? props.t("backgroundTasks.worktree.merging")
              : confirm.armed() === key("merge")
                ? props.t("backgroundTasks.worktree.mergeConfirm")
                : props.t("backgroundTasks.worktree.merge")}
          </button>
        </Show>
        <Show when={props.agent.task?.controls.discard}>
          <button
            type="button"
            data-action="discard"
            data-armed={confirm.armed() === key("discard") ? "" : undefined}
            disabled={state.busy !== undefined}
            onClick={discard}
          >
            {state.busy === "discard"
              ? props.t("backgroundTasks.worktree.discarding")
              : confirm.armed() === key("discard")
                ? props.t("backgroundTasks.worktree.discardConfirm")
                : props.t("backgroundTasks.worktree.discard")}
          </button>
        </Show>
      </div>
      <Show when={props.isolation.error}>
        <p class="vector-bg-tasks-action-error">{props.isolation.error}</p>
      </Show>
      <Show when={conflicts().length > 0}>
        <p class="vector-bg-tasks-conflicts">
          {props.t("backgroundTasks.worktree.conflicts", { paths: conflicts().join(", ") })}{" "}
          <button type="button" onClick={() => props.tasks.resolveConflicts(props.agent, conflicts())}>
            {props.t("backgroundTasks.worktree.resolve")}
          </button>
        </p>
      </Show>
      <Show when={state.reviewing}>
        <div class="vector-bg-tasks-inspect" aria-busy={state.loading}>
          <Show when={state.loading}>
            <p>{props.t("backgroundTasks.worktree.loading")}</p>
          </Show>
          <Show when={state.changes}>
            {(changes) => (
              <>
                <Show when={changes().files.length > 0} fallback={<p>{props.t("backgroundTasks.worktree.noFiles")}</p>}>
                  <ul class="vector-bg-tasks-files">
                    <For each={changes().files}>
                      {(file) => (
                        <li data-status={file.status}>
                          <span>{file.path}</span>{" "}
                          <span class="vector-bg-tasks-file-stat">
                            {file.binary ? file.status : `${file.status} +${file.additions} -${file.deletions}`}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={changes().detail}>
                  <p>{changes().detail}</p>
                </Show>
                <Show when={changes().patch}>
                  <pre data-component="task-patch">{changes().patch}</pre>
                </Show>
                <Show when={changes().truncated}>
                  <p>{props.t("backgroundTasks.worktree.patchTruncated")}</p>
                </Show>
              </>
            )}
          </Show>
        </div>
      </Show>
      <Show when={state.error}>
        <p class="vector-bg-tasks-action-error" role="alert">
          {state.error}
        </p>
      </Show>
      <Show when={state.notice}>
        <p class="vector-bg-tasks-notice" role="status">
          {state.notice}
        </p>
      </Show>
    </div>
  )
}

/**
 * Helpers a restart interrupted, above Running. Nothing resumes on its own: Resume continues one, Resume all every
 * one the engine offers, each in the background and within the conversation's running limit.
 */
function InterruptedSection(props: { tasks: BackgroundTasks; t: TaskTranslate }) {
  const [busy, setBusy] = createSignal<string>()
  const resumable = () =>
    props.tasks.capabilities().taskResume
      ? props.tasks.interrupted().filter((agent) => agent.task?.controls.resume === true)
      : []
  const run = async (key: string, agents: readonly TaskAgent[]) => {
    if (busy() || !agents.length) return
    setBusy(key)
    await props.tasks.resume(agents).finally(() => setBusy(undefined))
  }
  const max = () => props.tasks.limits()?.maxRunning
  return (
    <section
      class="vector-bg-tasks-section vector-bg-tasks-interrupted"
      aria-labelledby="vector-bg-tasks-interrupted-label"
    >
      <div class="vector-bg-tasks-section-head">
        <h3 id="vector-bg-tasks-interrupted-label" class="vector-bg-tasks-section-label">
          {props.t("backgroundTasks.interrupted.title")}
        </h3>
      </div>
      <Show
        when={resumable().length > 0}
        fallback={
          <Show when={!props.tasks.capabilities().taskResume}>
            <p class="vector-bg-tasks-idle">{props.t("backgroundTasks.interrupted.update")}</p>
          </Show>
        }
      >
        <div class="vector-bg-tasks-actions">
          <button
            type="button"
            data-action="resume-all"
            disabled={busy() !== undefined}
            aria-busy={busy() === "all"}
            onClick={() => run("all", resumable())}
          >
            {busy() === "all"
              ? props.t("backgroundTasks.interrupted.resuming")
              : max() !== undefined
                ? props.t("backgroundTasks.interrupted.resumeAllAtOnce", { count: resumable().length, max: max()! })
                : props.t("backgroundTasks.interrupted.resumeAll", { count: resumable().length })}
          </button>
        </div>
      </Show>
      <ul class="vector-bg-tasks-interrupted-list">
        <For each={props.tasks.interrupted()}>
          {(agent) => {
            const key = () => agent.task?.id ?? agent.sessionID ?? agent.key
            return (
              <li>
                <button
                  type="button"
                  class="vector-bg-tasks-interrupted-name"
                  title={agent.title}
                  disabled={!props.tasks.canOpenAgent(agent)}
                  onClick={() => props.tasks.openAgent(agent)}
                >
                  {agent.title}
                </button>
                <Show when={resumable().includes(agent)}>
                  <span class="vector-bg-tasks-actions">
                    <button
                      type="button"
                      disabled={busy() !== undefined}
                      aria-busy={busy() === key()}
                      onClick={() => run(key(), [agent])}
                    >
                      {busy() === key()
                        ? props.t("backgroundTasks.interrupted.resuming")
                        : props.t("backgroundTasks.interrupted.resume")}
                    </button>
                  </span>
                </Show>
              </li>
            )
          }}
        </For>
      </ul>
    </section>
  )
}

/** The root session's background commands: running ones with Stop, every one with its output file for the owner. */
function ShellsSection(props: { tasks: BackgroundTasks; t: TaskTranslate }) {
  const [stopping, setStopping] = createStore<Record<string, boolean>>({})
  const stop = async (shell: Task.Shell) => {
    if (stopping[shell.id]) return
    setStopping(shell.id, true)
    await props.tasks.stopShell(shell).finally(() => setStopping(shell.id, false))
  }
  return (
    <section class="vector-bg-tasks-section vector-bg-tasks-shells" aria-labelledby="vector-bg-tasks-shells-label">
      <div class="vector-bg-tasks-section-head">
        <h3 id="vector-bg-tasks-shells-label" class="vector-bg-tasks-section-label">
          {props.t("backgroundTasks.shells")}
        </h3>
      </div>
      <ul class="vector-bg-tasks-shell-list">
        <For each={props.tasks.shells()}>
          {(shell) => (
            <li class="vector-bg-tasks-shell" data-status={shell.status}>
              <p class="vector-bg-tasks-shell-command" title={shell.command}>
                {shell.title || shell.command}
              </p>
              <p class="vector-bg-tasks-meta">
                <span class="vector-bg-tasks-card-status" data-status={shellCardStatus(shell.status)}>
                  {shellStatus(shell.status, props.t)}
                </span>
                <time>{formatDuration(Math.max(0, (shell.completedAt ?? props.tasks.now()) - shell.startedAt))}</time>
                <span>{props.t("backgroundTasks.shells.output", { size: bytes(shell.outputBytes) })}</span>
                <Show when={shell.exitCode !== undefined}>
                  <span>{props.t("backgroundTasks.shells.exit", { code: shell.exitCode! })}</span>
                </Show>
              </p>
              <div class="vector-bg-tasks-actions">
                <Show when={shell.status === "running"}>
                  <button type="button" disabled={stopping[shell.id]} onClick={() => stop(shell)}>
                    {stopping[shell.id]
                      ? props.t("backgroundTasks.shells.stopping")
                      : props.t("backgroundTasks.shells.stop")}
                  </button>
                </Show>
                <Show when={props.tasks.canOpenOutput(shell)}>
                  <button type="button" title={shell.outputPath} onClick={() => props.tasks.openOutput(shell)}>
                    {props.t("backgroundTasks.shells.open")}
                  </button>
                </Show>
              </div>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}

function shellCardStatus(status: string): TaskStatus {
  if (status === "running") return "running"
  if (status === "completed") return "done"
  if (status === "failed") return "failed"
  return "stopped"
}

/**
 * A workflow run's card body: one bar per stage from the run's progress, its agents loaded when a stage is opened
 * (`task.list` on the run), Resume for the owner when the run did not finish, and its results (the run's report).
 */
function WorkflowBody(props: { card: TaskCard; tasks: BackgroundTasks; t: TaskTranslate; domID: string }) {
  const run = () =>
    props.card.agents.find((agent) => agent.task?.workflow?.role === "run" || agent.workflow?.role === "run")
  const stages = () => run()?.task?.workflow?.stages ?? run()?.workflow?.stages ?? []
  const [open, setOpen] = createStore<Record<string, boolean>>({})
  const [resuming, setResuming] = createSignal(false)
  const [results, setResults] = createStore<{ shown: boolean; loading: boolean; text?: string; error?: string }>({
    shown: false,
    loading: false,
  })
  // Load the run's agents only while a stage is open.
  const anyOpen = createMemo(() => Object.values(open).some(Boolean))
  props.tasks.watchRun(() => (anyOpen() ? props.card.runID : undefined))
  const agents = (stage: TaskWorkflowStage) =>
    props.card.agents.filter(
      (agent) => agent.task?.workflow?.role === "agent" && agent.task.workflow.stage === stage.id,
    )
  const resume = async () => {
    const current = run()
    if (!current || resuming()) return
    setResuming(true)
    await props.tasks.resumeRun(current).finally(() => setResuming(false))
  }
  const showResults = async () => {
    const current = run()
    const next = !results.shown
    setResults({ shown: next, error: undefined })
    if (!next || !current || results.loading) return
    setResults("loading", true)
    await props.tasks
      .inspect(current)
      .then((detail) => setResults("text", detail.output))
      .catch((error: unknown) => setResults("error", failureText(error)))
    setResults("loading", false)
  }
  const agentsLine = () => {
    const counts = run()?.task?.workflow?.agents ?? run()?.workflow?.agents
    return counts
      ? props.t("backgroundTasks.workflow.agents", { launched: counts.launched, max: counts.max })
      : undefined
  }
  return (
    <>
      <Show when={run()?.task?.workflow?.stop?.message}>
        {(message) => <p class="vector-bg-tasks-desc">{message()}</p>}
      </Show>
      <h5 id={`${props.domID}-stages`} class="vector-bg-tasks-phases-label">
        {props.t("backgroundTasks.workflow.stages")}
        <Show when={agentsLine()}>{(line) => <span class="vector-bg-tasks-stage-agents"> · {line()}</span>}</Show>
      </h5>
      <ol class="vector-bg-tasks-phases" aria-labelledby={`${props.domID}-stages`}>
        <For each={stages()}>
          {(stage) => {
            const total = () => stage.total ?? stage.done + stage.failed + stage.skipped + stage.running + stage.waiting
            const share = (value: number) => (total() > 0 ? `${(value / total()) * 100}%` : "0%")
            const status = (): TaskStatus =>
              stage.waiting > 0
                ? "waiting"
                : stage.running > 0
                  ? "running"
                  : stage.failed > 0
                    ? "failed"
                    : total() > 0 && stage.done + stage.skipped >= total()
                      ? "done"
                      : "pending"
            const bodyID = () => `${props.domID}-s-${domKey(stage.id)}`
            return (
              <li class="vector-bg-tasks-phase" data-state={status()}>
                <button
                  type="button"
                  class="vector-bg-tasks-phase-toggle"
                  aria-expanded={!!open[stage.id]}
                  aria-controls={bodyID()}
                  onClick={() => setOpen(stage.id, !open[stage.id])}
                >
                  <span class="vector-bg-tasks-phase-name">{stage.title}</span>
                  <span class="vector-bg-tasks-phase-count">
                    {stage.done}/{stage.total ?? "?"}
                    <Show when={stage.waiting > 0}>
                      <span> · {props.t("backgroundTasks.workflow.waiting")}</span>
                    </Show>
                  </span>
                  <ChevronIcon />
                  <span class="vector-bg-tasks-stage-bar" aria-hidden="true">
                    <span data-part="done" style={{ width: share(stage.done) }} />
                    <span data-part="failed" style={{ width: share(stage.failed) }} />
                    <span data-part="skipped" style={{ width: share(stage.skipped) }} />
                    <span data-part="running" style={{ width: share(stage.running) }} />
                    <span data-part="waiting" style={{ width: share(stage.waiting) }} />
                  </span>
                </button>
                <div class="vector-bg-tasks-phase-body" id={bodyID()} hidden={!open[stage.id]}>
                  <Show when={open[stage.id]}>
                    <Show
                      when={agents(stage).length > 0}
                      fallback={
                        <p class="vector-bg-tasks-idle">
                          {props.card.runID && props.tasks.runLoading(props.card.runID)
                            ? props.t("backgroundTasks.workflow.loading")
                            : props.t("backgroundTasks.workflow.noAgents")}
                        </p>
                      }
                    >
                      <AgentTable name={stage.title} agents={agents(stage)} tasks={props.tasks} />
                    </Show>
                  </Show>
                </div>
              </li>
            )
          }}
        </For>
      </ol>
      <div class="vector-bg-tasks-actions vector-bg-tasks-card-actions">
        <Show when={run()?.task}>
          <button type="button" aria-expanded={results.shown} onClick={showResults}>
            {props.t("backgroundTasks.workflow.results")}
          </button>
        </Show>
        <Show when={run() && props.tasks.canResumeRun(run()!)}>
          <button type="button" disabled={resuming()} aria-busy={resuming()} onClick={resume}>
            {resuming() ? props.t("backgroundTasks.workflow.resuming") : props.t("backgroundTasks.workflow.resume")}
          </button>
        </Show>
      </div>
      <Show when={results.shown}>
        <div class="vector-bg-tasks-inspect" aria-busy={results.loading}>
          <Show when={results.text}>
            <pre>{results.text}</pre>
          </Show>
          <Show when={results.error}>
            <p class="vector-bg-tasks-action-error" role="alert">
              {results.error}
            </p>
          </Show>
        </div>
      </Show>
    </>
  )
}
