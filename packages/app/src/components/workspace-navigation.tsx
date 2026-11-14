import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { usePlatform } from "@/context/platform"
import { accountChip, onCodiumChange, type VectorAccountStatus } from "../vector-account"
import { createUpdateRestart } from "./updater-action"

export type WorkspaceNavigationItem = {
  id: string
  name: string
  status: string
  runtime: string
  added: number
  removed: number
  active: boolean
  running: boolean
  reviewable: boolean
  removable: boolean
  removeArmed: boolean
}

const statusTone = (status: string) => {
  if (status === "failed") return "bg-rose-400"
  if (status === "waiting for approval" || status === "needs review") return "bg-amber-300"
  if (status === "complete" || status === "merged") return "bg-emerald-400"
  if (status === "stopped" || status === "discarded") return "bg-white/30"
  return "bg-[color:var(--vx-purple-bright)]"
}

const statusTextTone = (status: string) => {
  if (status === "failed") return "text-rose-300"
  if (status === "waiting for approval" || status === "needs review") return "text-amber-200"
  if (status === "complete" || status === "merged") return "text-emerald-300"
  if (status === "stopped" || status === "discarded") return "text-white/34"
  return "text-[color:var(--vx-purple-bright)]"
}

const Icon = (props: { children: JSX.Element }) => (
  <span class="grid size-[18px] shrink-0 place-items-center text-[color:var(--vx-workspace-text-tertiary)]">
    {props.children}
  </span>
)

const BranchIcon = () => (
  <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
    <path
      d="M4.15 2.25v6.2a2.65 2.65 0 0 0 2.65 2.65h2.45M4.15 2.25a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Zm7.7 8.85a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Zm0 0V5.8A2.65 2.65 0 0 0 9.2 3.15H7.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.15"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)

const SettingsIcon = (props: { class: string }) => (
  <svg viewBox="0 0 16 16" class={props.class} aria-hidden="true">
    <path
      d="M8 10.35A2.35 2.35 0 1 0 8 5.65a2.35 2.35 0 0 0 0 4.7Zm4.72-1.35a4.8 4.8 0 0 0 0-2l1.2-.92-1.2-2.08-1.42.58a5.1 5.1 0 0 0-1.72-1L9.4 2H6.6l-.18 1.58a5.1 5.1 0 0 0-1.72 1L3.28 4l-1.2 2.08 1.2.92a4.8 4.8 0 0 0 0 2l-1.2.92L3.28 12l1.42-.58a5.1 5.1 0 0 0 1.72 1L6.6 14h2.8l.18-1.58a5.1 5.1 0 0 0 1.72-1l1.42.58 1.2-2.08-1.2-.92Z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.15"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)

export function WorkspaceNavigation(props: {
  width: number
  minimumWidth: number
  maximumWidth: number
  macDesktop: boolean
  visible: boolean
  resizing: boolean
  projectName: string
  mainLabel: string
  /** The main checkout's current branch; it changes when the branch picker switches it. */
  mainBranch?: string
  mainActive: boolean
  treeOpen: boolean
  items: WorkspaceNavigationItem[]
  mode?: "agent" | "editor"
  onModeChange?: (mode: "agent" | "editor") => void
  activeTool?: "browser"
  currentVersion?: string
  onResizeStart: (event: PointerEvent) => void
  onResize: (width: number) => void
  onResetWidth: () => void
  onHome: () => void
  onHide: () => void
  onToggleTree: () => void
  onNewWorkspace: () => void
  onOpenMain: () => void
  onOpenWorkspace: (id: string) => void
  onReviewWorkspace: (id: string) => void
  onRemoveWorkspace: (id: string) => void
  onMoveWorkspace: (sourceID: string, targetID: string) => void
  onCodeEditor: () => void
  onAgentDashboard: () => void
  /** The open task's coordinated runs; the entry only shows once there is one. */
  coordinatedRuns?: { total: number; running: number }
  onCoordinatedRuns?: () => void
  onPullRequests: () => void
  onBrowser: () => void
  onMcp: () => void
  onPlugins: () => void
  onFind: () => void
  onReportBug: () => void
  onGettingStarted: () => void
  onSettings: () => void
  /** Settings' shortcut as the command palette shows it, for the Help menu's Settings item. */
  settingsKeybind?: string
  /** Settings at its Account page, for the account chip, signed in or out. */
  onAccount: () => void
  /** A downloaded update, or one installing. The Update button then takes the Settings gear's place. */
  update?: { version: string; installing: boolean }
  /** Restarts Vector into the downloaded update. */
  onUpdate?: () => void
  /** Counts, when Update is clicked, the agents a restart would stop in every repository; above zero, Update asks first. */
  runningAgents?: () => number | Promise<number>
}) {
  const platform = usePlatform()
  const [localMode, setLocalMode] = createSignal<"agent" | "editor">(props.mode ?? "agent")
  const [helpOpen, setHelpOpen] = createSignal(false)
  const [account, setAccount] = createSignal<VectorAccountStatus>({ authenticated: false, pending: false })
  const [codium, setCodium] = createSignal<ModelPlanStatus.Status>()
  const mode = () => props.mode ?? localMode()
  const chip = createMemo(() => accountChip(account(), codium()))
  // The account chip opens Settings whenever the desktop's account bridge is there, so Update can take the gear's place
  // and Settings stays one click away. Without the bridge the chip is plain text, and the gear stays beside Update.
  const showGear = () => !props.update || !platform.vectorAccount
  const restart = createUpdateRestart({
    update: () => props.update,
    install: () => props.onUpdate?.(),
    runningAgents: props.runningAgents,
  })
  let updateButton: HTMLButtonElement | undefined
  let updateLater: HTMLButtonElement | undefined

  const update = async () => {
    if (!(await restart.start())) return
    setHelpOpen(false)
    queueMicrotask(() => updateLater?.focus())
  }
  const closeUpdateConfirm = () => {
    restart.setConfirming(false)
    updateButton?.focus()
  }

  onMount(() => {
    const vectorAccount = platform.vectorAccount
    if (!vectorAccount) return
    // The plan beside the name is read on launch, on signing in or out, after a billing window and, at most once a
    // minute, when Vector comes back to the front, which covers a plan bought or changed on vectordev.ai. Only the
    // latest read counts, so a slow answer about an earlier account never replaces a newer one.
    const reads = { latest: 0, at: 0 }
    const readPlan = () => {
      const read = vectorAccount.codium
      if (!read) return
      const current = ++reads.latest
      reads.at = Date.now()
      void read()
        .catch(() => undefined)
        .then((status) => {
          if (current === reads.latest) setCodium(status)
        })
    }
    const focused = () => {
      if (Date.now() - reads.at >= 60_000) readPlan()
    }
    onCleanup(
      vectorAccount.onChange((next) => {
        // Another account, or none, never shows the last one's plan, even for the moment before it is read.
        if (next.email !== account().email) setCodium(undefined)
        setAccount(next)
        readPlan()
      }),
    )
    onCleanup(onCodiumChange(readPlan))
    window.addEventListener("focus", focused)
    onCleanup(() => window.removeEventListener("focus", focused))
    void vectorAccount
      .status()
      .then(setAccount)
      .catch(() => undefined)
    readPlan()
  })

  const selectMode = (next: "agent" | "editor") => {
    setLocalMode(next)
    props.onModeChange?.(next)
    if (next === "editor") props.onCodeEditor()
  }

  const openLink = (href: string) => {
    setHelpOpen(false)
    platform.openLink(href)
  }

  return (
    <nav
      data-vector-navigation
      class="fixed inset-y-0 left-0 z-50 flex flex-col text-[color:var(--vx-workspace-text-secondary)] transition-opacity duration-200 [font-family:var(--vx-workspace-font)]"
      style={{
        width: `${props.width}px`,
        "padding-top": props.macDesktop ? "48px" : "0px",
        display: props.visible ? undefined : "none",
      }}
    >
      <div data-vector-nav-top class="flex h-[48px] shrink-0 items-center gap-2 px-3">
        <div
          data-vector-mode-switch
          class="flex h-8 min-w-0 flex-1 items-center rounded-[7px] bg-black/15 p-[2px] text-[13px] font-medium"
          role="group"
          aria-label="Workspace mode"
        >
          <For each={["agent", "editor"] as const}>
            {(value) => (
              <button
                type="button"
                class="h-7 min-w-0 flex-1 rounded-[5px] px-3 capitalize transition"
                classList={{
                  "bg-white/[0.075] text-[color:var(--vx-workspace-text-primary)] shadow-[inset_0_0_0_1px_rgba(182,159,247,0.24)]":
                    mode() === value,
                  "text-[color:var(--vx-workspace-text-tertiary)] hover:text-[color:var(--vx-workspace-text-primary)]":
                    mode() !== value,
                }}
                aria-pressed={mode() === value}
                onClick={() => selectMode(value)}
              >
                {value}
              </button>
            )}
          </For>
        </div>
        <button
          type="button"
          class="grid size-8 shrink-0 place-items-center rounded-[5px] text-[color:var(--vx-workspace-text-tertiary)] transition hover:bg-white/[0.055] hover:text-[color:var(--vx-workspace-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(147,116,236,0.55)]"
          aria-label="Hide Vector sidebar"
          title="Hide Vector sidebar"
          onClick={props.onHide}
        >
          <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
            <rect
              x="2.25"
              y="2.5"
              width="11.5"
              height="11"
              rx="1.75"
              fill="none"
              stroke="currentColor"
              stroke-width="1.15"
            />
            <path
              d="M6 2.75v10.5m3.5-7-2 2 2 2"
              fill="none"
              stroke="currentColor"
              stroke-width="1.15"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>

      <div data-vector-nav-scroll class="min-h-0 flex-1 overflow-y-auto">
        <section data-vector-nav-primary class="space-y-px border-y border-[color:var(--vx-line)] px-2 py-2">
          <button type="button" data-vector-nav-item data-vector-nav-home onClick={props.onHome}>
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
              <path
                d="M3 7.15 8 3l5 4.15v5.6a.75.75 0 0 1-.75.75h-2.6V9.9h-3.3v3.6h-2.6A.75.75 0 0 1 3 12.75v-5.6Z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linejoin="round"
              />
            </svg>
            <span>Home</span>
          </button>
          <button type="button" data-vector-nav-item onClick={props.onFind}>
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
              <path
                d="M7.1 12.1a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm3.55-1.45 3 3"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
              />
            </svg>
            <span>Search</span>
            <kbd class="ml-auto text-[11px] font-normal text-[color:var(--vx-workspace-text-tertiary)]">⌘P</kbd>
          </button>
        </section>

        <section data-vector-project-group>
          <div class="flex h-9 items-center gap-2 px-3.5 text-[12px] font-medium text-[color:var(--vx-workspace-text-tertiary)]">
            <span class="min-w-0 flex-1">Agents</span>
            <button
              type="button"
              data-tour="nav-new-workspace"
              class="grid size-6 place-items-center rounded-[5px] text-[color:var(--vx-workspace-text-tertiary)] transition hover:bg-white/[0.045] hover:text-[color:var(--vx-workspace-text-primary)]"
              title="New workspace"
              aria-label="New workspace"
              onClick={props.onNewWorkspace}
            >
              <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
            </button>
          </div>
          <button
            type="button"
            data-vector-project-heading
            class="mx-2 flex h-9 w-[calc(100%-1rem)] items-center gap-2 rounded-[5px] px-2 text-left text-[13px] font-medium text-[color:var(--vx-workspace-text-primary)] transition hover:bg-white/[0.04]"
            onClick={props.onToggleTree}
            aria-expanded={props.treeOpen}
          >
            <svg
              viewBox="0 0 16 16"
              class="size-3.5 shrink-0 text-[color:var(--vx-workspace-text-tertiary)] transition-transform duration-150"
              classList={{ "-rotate-90": !props.treeOpen }}
              aria-hidden="true"
            >
              <path
                d="m4.75 6.25 3.25 3 3.25-3"
                fill="none"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span class="grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-[color:var(--vx-purple-soft)] text-[color:var(--vx-purple-bright)]">
              <svg viewBox="0 0 16 16" class="size-3" aria-hidden="true">
                <rect
                  x="3"
                  y="3"
                  width="10"
                  height="10"
                  rx="2.2"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.1"
                />
                <path
                  d="M5.5 8h5M8 5.5v5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.05"
                  stroke-linecap="round"
                />
              </svg>
            </span>
            <span class="min-w-0 flex-1 truncate">{props.projectName}</span>
            <span class="shrink-0 text-[11px] font-normal tabular-nums text-[color:var(--vx-workspace-text-tertiary)]">
              {props.items.length + 1}
            </span>
          </button>

          <Show when={props.treeOpen}>
            <div data-vector-workspace-list class="space-y-px px-2 pb-3">
              <button
                type="button"
                data-vector-workspace-row
                data-active={props.mainActive ? "true" : "false"}
                class="group relative flex min-h-[50px] w-full items-center gap-2.5 rounded-[5px] px-2.5 py-1.5 text-left transition"
                classList={{
                  "bg-white/[0.075] text-[color:var(--vx-workspace-text-primary)]": props.mainActive,
                  "text-[color:var(--vx-workspace-text-secondary)] hover:bg-white/[0.045] hover:text-[color:var(--vx-workspace-text-primary)]":
                    !props.mainActive,
                }}
                onClick={props.onOpenMain}
              >
                <Icon>
                  <BranchIcon />
                </Icon>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[13px] font-medium">{props.mainLabel}</span>
                  <span class="mt-0.5 flex items-center gap-1.5 truncate text-[12px] text-[color:var(--vx-workspace-text-secondary)]">
                    <span class="size-1.5 shrink-0 rounded-full bg-emerald-400" />
                    <span class="truncate">{props.mainBranch ?? "main"} · Ready</span>
                  </span>
                </span>
                <span class="shrink-0 rounded-[4px] border border-white/[0.08] px-1.5 py-0.5 text-[11px] text-[color:var(--vx-workspace-text-tertiary)]">
                  main
                </span>
              </button>

              <For each={props.items}>
                {(item, index) => (
                  <div
                    data-vector-workspace-row
                    data-active={item.active ? "true" : "false"}
                    data-status={item.status}
                    class="group relative rounded-[5px] transition"
                    classList={{ "bg-white/[0.075]": item.active, "hover:bg-white/[0.045]": !item.active }}
                    draggable={true}
                    onDragStart={(event) => {
                      event.dataTransfer?.setData("text/vector-agent-workspace", item.id)
                      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
                    }}
                    onDragOver={(event) => {
                      if (!event.dataTransfer?.types.includes("text/vector-agent-workspace")) return
                      event.preventDefault()
                      event.dataTransfer.dropEffect = "move"
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      const sourceID = event.dataTransfer?.getData("text/vector-agent-workspace")
                      if (!sourceID || sourceID === item.id) return
                      props.onMoveWorkspace(sourceID, item.id)
                    }}
                  >
                    <button
                      type="button"
                      class="flex min-h-[55px] w-full items-center gap-2.5 rounded-[5px] px-2.5 py-1.5 pr-[78px] text-left"
                      onClick={() => props.onOpenWorkspace(item.id)}
                      title={`${item.name} · ${item.status}`}
                    >
                      <span class="relative grid size-[18px] shrink-0 place-items-center text-[color:var(--vx-workspace-text-tertiary)]">
                        <Show when={item.running}>
                          <span class="absolute size-4 animate-ping rounded-full bg-[color:var(--vx-purple-bright)]/12" />
                        </Show>
                        <BranchIcon />
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-[13px] font-medium text-[color:var(--vx-workspace-text-primary)]">
                          {item.name}
                        </span>
                        <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-[color:var(--vx-workspace-text-secondary)]">
                          <span class={`size-1.5 shrink-0 rounded-full ${statusTone(item.status)}`} />
                          <span class={`truncate capitalize ${statusTextTone(item.status)}`}>{item.status}</span>
                          <span class="shrink-0 text-[color:var(--vx-workspace-text-tertiary)]">·</span>
                          <span class="truncate">{item.runtime}</span>
                        </span>
                      </span>
                    </button>

                    <div class="absolute right-2 top-2 flex items-center gap-1">
                      <span class="flex h-6 items-center gap-1 rounded-[4px] border border-white/[0.07] bg-black/10 px-1.5 text-[11px] tabular-nums opacity-100 transition group-hover:opacity-0">
                        <span class="text-emerald-400">+{item.added}</span>
                        <span class="text-rose-400">-{item.removed}</span>
                      </span>
                      <div class="absolute right-0 top-0 hidden items-center gap-0.5 group-hover:flex">
                        <Show when={item.reviewable}>
                          <button
                            type="button"
                            class="grid size-6 place-items-center rounded-[4px] bg-[#343235] text-white/45 transition hover:bg-white/[0.09] hover:text-white"
                            title="Review changes"
                            aria-label={`Review changes from ${item.name}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              props.onReviewWorkspace(item.id)
                            }}
                          >
                            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                              <path
                                d="M3.25 3.5h9.5v9h-9.5zM5.4 6h5.2M5.4 8h5.2M5.4 10h3.1"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.1"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                              />
                            </svg>
                          </button>
                        </Show>
                        <Show when={item.removable}>
                          <button
                            type="button"
                            class="grid size-6 place-items-center rounded-[4px] bg-[#343235] text-white/42 transition hover:bg-rose-400/10 hover:text-rose-300"
                            classList={{ "text-rose-300": item.removeArmed }}
                            title={item.removeArmed ? "Click again to remove" : "Close workspace"}
                            aria-label={item.removeArmed ? "Click again to remove workspace" : "Close workspace"}
                            onClick={(event) => {
                              event.stopPropagation()
                              props.onRemoveWorkspace(item.id)
                            }}
                          >
                            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                              <path
                                d="m4.5 4.5 7 7m0-7-7 7"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.25"
                                stroke-linecap="round"
                              />
                            </svg>
                          </button>
                        </Show>
                      </div>
                    </div>
                    <span class="pointer-events-none absolute bottom-1.5 right-2 text-[10px] tabular-nums text-[color:var(--vx-workspace-text-tertiary)] group-hover:opacity-0">
                      #{index() + 1}
                    </span>
                  </div>
                )}
              </For>

              <Show when={!props.items.length}>
                <div class="px-3 py-2 text-[12px] leading-[18px] text-[color:var(--vx-workspace-text-tertiary)]">
                  Launch an isolated workspace to run another agent without touching main.
                </div>
              </Show>
            </div>
          </Show>
        </section>

        <section data-vector-nav-group class="border-t border-[color:var(--vx-line)] px-2 py-3">
          <div data-vector-nav-label>Repository tools</div>
          <button type="button" data-vector-nav-item data-tour="nav-agent-dashboard" onClick={props.onAgentDashboard}>
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
              <rect
                x="2.3"
                y="2.6"
                width="4.7"
                height="4.7"
                rx="1.1"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
              />
              <rect
                x="9"
                y="2.6"
                width="4.7"
                height="4.7"
                rx="1.1"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
              />
              <rect
                x="2.3"
                y="8.7"
                width="4.7"
                height="4.7"
                rx="1.1"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
              />
              <rect
                x="9"
                y="8.7"
                width="4.7"
                height="4.7"
                rx="1.1"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
              />
            </svg>
            <span>Agent Dashboard</span>
          </button>
          {/* A coordinated run's overlay is where it is stopped, resumed, merged or discarded. Launching opens it once;
              this brings it back after it was closed. */}
          <Show when={props.coordinatedRuns?.total ? props.coordinatedRuns : undefined}>
            {(runs) => (
              <button
                type="button"
                data-vector-nav-item
                data-vector-nav-coordinated-runs
                onClick={() => props.onCoordinatedRuns?.()}
              >
                <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
                  <circle cx="8" cy="3.4" r="1.6" fill="none" stroke="currentColor" stroke-width="1.15" />
                  <circle cx="3.6" cy="12.4" r="1.6" fill="none" stroke="currentColor" stroke-width="1.15" />
                  <circle cx="12.4" cy="12.4" r="1.6" fill="none" stroke="currentColor" stroke-width="1.15" />
                  <path
                    d="M7.2 4.8 4.4 11M8.8 4.8l2.8 6.2M5.2 12.4h5.6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.15"
                    stroke-linecap="round"
                  />
                </svg>
                <span>Coordinated runs</span>
                <span class="ml-auto text-[11px] font-normal tabular-nums text-[color:var(--vx-workspace-text-tertiary)]">
                  {runs().running ? `${runs().running} running` : runs().total}
                </span>
              </button>
            )}
          </Show>
          <button
            type="button"
            data-vector-nav-item
            data-tour="nav-browser"
            classList={{ active: props.activeTool === "browser" }}
            onClick={props.onBrowser}
          >
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
              <rect
                x="2.25"
                y="3"
                width="11.5"
                height="10"
                rx="1.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
              />
              <path
                d="M2.75 5.45h10.5M4.4 4.2h.01M6 4.2h.01"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
                stroke-linecap="round"
              />
            </svg>
            <span>Browser</span>
          </button>
        </section>

        <section data-vector-nav-group class="border-t border-[color:var(--vx-line)] px-2 py-3">
          <div data-vector-nav-label>Connections</div>
          <button type="button" data-vector-nav-item data-tour="nav-pull-requests" onClick={props.onPullRequests}>
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
              <circle cx="4.2" cy="3.6" r="1.5" fill="none" stroke="currentColor" stroke-width="1.15" />
              <circle cx="4.2" cy="12.4" r="1.5" fill="none" stroke="currentColor" stroke-width="1.15" />
              <circle cx="11.8" cy="12.4" r="1.5" fill="none" stroke="currentColor" stroke-width="1.15" />
              <path
                d="M4.2 5.1v5.8M11.8 10.9V6.4a2 2 0 0 0-2-2H7.4m0 0 1.6-1.5M7.4 4.4 9 5.9"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span>Vectorscope</span>
          </button>
          <button type="button" data-vector-nav-item data-tour="nav-mcp" onClick={props.onMcp}>
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
              <path
                d="M3.25 5.25a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm9.5 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 14.75a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM4.95 4.3l1.8 6.5M11.05 4.3l-1.8 6.5M5.1 3.25h5.8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span>MCP</span>
          </button>
          <button type="button" data-vector-nav-item data-tour="nav-plugins" onClick={props.onPlugins}>
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
              <path
                d="M6.1 1.6v2.7M9.9 1.6v2.7M4.6 4.3h6.8v1.7a3.4 3.4 0 0 1-6.8 0V4.3ZM8 9.4v.9c0 1.5-3.2.9-3.2 2.4 0 1.4 2.7 1.6 4.6.9"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span>Plugins</span>
          </button>
        </section>
      </div>

      <Show when={helpOpen()}>
        <div
          data-vector-help-menu
          role="dialog"
          aria-label="Vector help"
          class="absolute bottom-[58px] left-3 right-3 z-40"
        >
          <button
            type="button"
            class="vector-help-menu-item"
            data-help-menu-settings
            onClick={() => {
              setHelpOpen(false)
              props.onSettings()
            }}
          >
            <SettingsIcon class="size-4 shrink-0" />
            <span class="min-w-0 flex-1">Settings</span>
            <Show when={props.settingsKeybind}>{(keybind) => <kbd>{keybind()}</kbd>}</Show>
          </button>

          <div data-help-menu-group role="group" aria-label="Resources">
            <button type="button" class="vector-help-menu-item" onClick={() => openLink("https://vectordev.ai/docs")}>
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <path
                  d="M2.8 3.1h3.1c1.2 0 2.1.55 2.1 1.5v8.2c0-.95-.9-1.5-2.1-1.5H2.8V3.1Zm10.4 0h-3.1c-1.2 0-2.1.55-2.1 1.5v8.2c0-.95.9-1.5 2.1-1.5h3.1V3.1Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.05"
                  stroke-linejoin="round"
                />
              </svg>
              <span class="min-w-0 flex-1">Docs</span>
              <span aria-hidden="true" data-help-menu-external>
                ↗
              </span>
            </button>
            <button
              type="button"
              class="vector-help-menu-item"
              data-help-menu-sub
              onClick={() => openLink("https://vectordev.ai/docs")}
            >
              <span class="min-w-0 flex-1">Best practices</span>
              <span aria-hidden="true" data-help-menu-external>
                ↗
              </span>
            </button>
            <button
              type="button"
              class="vector-help-menu-item"
              data-help-menu-sub
              onClick={() => openLink("https://vectordev.ai/docs/changelog")}
            >
              <span class="min-w-0 flex-1">Changelog</span>
              <span aria-hidden="true" data-help-menu-external>
                ↗
              </span>
            </button>
          </div>

          <div data-help-menu-group role="group" aria-label="Support">
            <button
              type="button"
              class="vector-help-menu-item"
              onClick={() => {
                setHelpOpen(false)
                props.onReportBug()
              }}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <path
                  d="M2.5 3.2h11v7.2H7l-3.2 2.4v-2.4H2.5V3.2Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.05"
                  stroke-linejoin="round"
                />
              </svg>
              <span class="min-w-0 flex-1">Send feedback</span>
            </button>
            <button
              type="button"
              class="vector-help-menu-item"
              onClick={() => {
                setHelpOpen(false)
                if (platform.exportDebugLogs) {
                  void platform.exportDebugLogs()
                  return
                }
                props.onGettingStarted()
              }}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <path
                  d="M5.1 2.2v4.5a2.9 2.9 0 0 0 5.8 0V2.2M3.2 5.8v1a4.8 4.8 0 0 0 9.6 0v-1M8 11.6v2.2M5.7 13.8h4.6"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.05"
                  stroke-linecap="round"
                />
              </svg>
              <span class="min-w-0 flex-1">Diagnostics</span>
            </button>
            <Show when={platform.platform === "desktop"}>
              <button
                type="button"
                class="vector-help-menu-item"
                data-help-menu-sub
                onClick={() => {
                  setHelpOpen(false)
                  void platform.runDesktopMenuAction?.("view.toggleDevTools")
                }}
              >
                <span class="min-w-0 flex-1">Open debug tools</span>
              </button>
            </Show>
          </div>

          <div data-help-menu-footer>Vector{props.currentVersion ? ` v${props.currentVersion}` : ""}</div>
        </div>
      </Show>

      <Show when={restart.confirming() && props.update}>
        {(pending) => (
          <div
            data-vector-update-confirm
            role="dialog"
            aria-label="Restart to update"
            aria-describedby="vector-update-confirm-detail"
            class="absolute bottom-[58px] left-3 right-3 z-40"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              event.preventDefault()
              event.stopPropagation()
              closeUpdateConfirm()
            }}
          >
            <p data-update-confirm-title>Restart to update to Vector {pending().version}?</p>
            <p id="vector-update-confirm-detail" data-update-confirm-detail>
              {restart.stopping() === 1
                ? "1 agent in the workspace is still running and will stop."
                : `${restart.stopping()} agents in the workspace are still running and will stop.`}
            </p>
            <div data-update-confirm-actions>
              <button type="button" data-update-confirm-later ref={updateLater} onClick={closeUpdateConfirm}>
                Later
              </button>
              <button
                type="button"
                data-update-confirm-restart
                onClick={() => {
                  restart.setConfirming(false)
                  props.onUpdate?.()
                }}
              >
                Restart now
              </button>
            </div>
          </div>
        )}
      </Show>

      <div
        data-vector-nav-footer
        class="grid min-h-[50px] shrink-0 items-center gap-1 border-t border-[color:var(--vx-line)] px-3 py-2"
        classList={{
          "grid-cols-[1fr_auto_auto]": showGear() !== Boolean(props.update),
          "grid-cols-[1fr_auto_auto_auto]": showGear() && Boolean(props.update),
        }}
      >
        <span data-vector-update-status role="status" aria-live="polite" class="sr-only">
          {restart.announcement()}
        </span>
        <Show
          when={platform.vectorAccount}
          fallback={
            <span class="truncate px-1 text-[11px] text-[color:var(--vx-workspace-text-tertiary)]">
              Vector workspace
            </span>
          }
        >
          <Show
            when={account().authenticated && chip().label}
            fallback={
              <button
                type="button"
                data-vector-account-chip
                class="flex min-w-0 items-center gap-2 rounded-[6px] px-1 py-1 text-left text-[12px] text-white/60 transition hover:bg-white/[0.05] hover:text-white"
                aria-label={`${account().pending ? "Finish signing in in your browser" : "Sign in to Vector"}. Open account settings`}
                onClick={props.onAccount}
              >
                <span class="truncate">
                  {account().pending ? "Finish signing in in your browser" : "Sign in to Vector"}
                </span>
              </button>
            }
          >
            <button
              type="button"
              data-vector-account-chip
              class="flex min-w-0 items-center gap-2 rounded-[6px] px-1 py-1 text-left transition hover:bg-white/[0.05]"
              title={account().email}
              aria-label={`Account: ${chip().name}${chip().plan ? `, ${chip().plan} plan` : ""}${chip().founding ? `, founding member #${chip().founding}` : ""}. Open account settings`}
              onClick={props.onAccount}
            >
              <Show
                when={chip().photo}
                fallback={
                  <span
                    aria-hidden="true"
                    class="grid size-6 shrink-0 place-items-center rounded-full bg-[color:var(--vx-purple)] text-[11px] font-medium uppercase text-[#fff]"
                  >
                    {chip().initial}
                  </span>
                }
              >
                {(photo) => (
                  <img
                    src={photo()}
                    alt=""
                    decoding="async"
                    draggable={false}
                    class="size-6 shrink-0 rounded-full bg-[color:var(--vx-control)] object-cover"
                  />
                )}
              </Show>
              <span class="flex min-w-0 items-baseline text-[12.5px]">
                <span class="truncate text-[color:var(--vx-workspace-text-primary)]">{chip().label}</span>
                <Show when={chip().plan}>
                  {(plan) => (
                    <span
                      data-vector-account-plan
                      class="shrink-0 whitespace-pre text-[color:var(--vx-workspace-text-secondary)]"
                    >
                      <span aria-hidden="true" class="text-[color:var(--vx-workspace-text-tertiary)]">
                        {" · "}
                      </span>
                      {plan()}
                    </span>
                  )}
                </Show>
                <Show when={chip().founding}>
                  {(number) => (
                    <span
                      data-vector-account-founding
                      aria-hidden="true"
                      title={`Founding member #${number()}`}
                      class="ml-1.5 shrink-0 self-center rounded-full border border-[color:var(--vx-purple)] px-1.5 text-[10px] leading-[16px] text-[color:var(--vx-workspace-text-secondary)]"
                    >
                      Founding
                    </span>
                  )}
                </Show>
              </span>
            </button>
          </Show>
        </Show>
        <button
          type="button"
          data-tour="nav-getting-started"
          class="grid size-8 place-items-center rounded-[5px] text-white/38 transition hover:bg-white/[0.05] hover:text-white"
          onClick={() => {
            restart.setConfirming(false)
            setHelpOpen((open) => !open)
          }}
          title="Help"
          aria-label="Help"
          aria-expanded={helpOpen()}
        >
          <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
            <circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.15" />
            <path
              d="M6.2 6.25a1.85 1.85 0 0 1 3.6.55c0 1.15-1.8 1.35-1.8 2.4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.15"
              stroke-linecap="round"
            />
            <circle cx="8" cy="11.35" r="0.7" fill="currentColor" />
          </svg>
        </button>
        <Show when={props.update}>
          {(pending) => (
            <button
              type="button"
              ref={updateButton}
              data-vector-update
              data-state={pending().installing ? "installing" : "ready"}
              disabled={pending().installing}
              aria-busy={pending().installing ? "true" : undefined}
              aria-haspopup={!pending().installing && props.runningAgents ? "dialog" : undefined}
              aria-expanded={!pending().installing && props.runningAgents ? restart.confirming() : undefined}
              aria-label={
                pending().installing
                  ? `Updating to Vector ${pending().version}`
                  : `Restart to update to Vector ${pending().version}`
              }
              title={
                pending().installing
                  ? `Updating to Vector ${pending().version}`
                  : `Restart to update to Vector ${pending().version}`
              }
              onClick={() => void update()}
            >
              <Show
                when={pending().installing}
                fallback={
                  <svg viewBox="0 0 14 14" class="size-3.5 shrink-0" aria-hidden="true">
                    <path
                      d="M7 11V3M3.5 7.63128L7 11L10.5 7.63128"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.3"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                }
              >
                <span data-vector-update-spinner aria-hidden="true" />
              </Show>
              <span>{pending().installing ? "Updating…" : "Update"}</span>
            </button>
          )}
        </Show>
        <Show when={showGear()}>
          <button
            type="button"
            data-vector-settings
            class="grid size-8 place-items-center rounded-[5px] text-white/38 transition hover:bg-white/[0.05] hover:text-white"
            onClick={props.onSettings}
            title="Settings"
            aria-label="Settings"
          >
            <SettingsIcon class="size-3.5" />
          </button>
        </Show>
      </div>

      <div
        data-vector-navigation-resizer
        role="separator"
        aria-label="Resize Vector sidebar"
        aria-orientation="vertical"
        aria-valuemin={props.minimumWidth}
        aria-valuemax={props.maximumWidth}
        aria-valuenow={props.width}
        tabIndex={0}
        class="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none focus-visible:outline-none"
        classList={{ "is-resizing": props.resizing }}
        title="Drag to resize. Double-click to reset."
        onPointerDown={props.onResizeStart}
        onDblClick={props.onResetWidth}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault()
            props.onResize(props.width - (event.shiftKey ? 32 : 12))
            return
          }
          if (event.key === "ArrowRight") {
            event.preventDefault()
            props.onResize(props.width + (event.shiftKey ? 32 : 12))
            return
          }
          if (event.key === "Home") {
            event.preventDefault()
            props.onResize(props.minimumWidth)
            return
          }
          if (event.key === "End") {
            event.preventDefault()
            props.onResize(props.maximumWidth)
          }
        }}
      >
        <span class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-[color:var(--vx-purple)] group-focus-visible:bg-[color:var(--vx-purple-bright)]" />
      </div>
    </nav>
  )
}
