import { createEffect, createSignal, For, lazy, onCleanup, Show, Suspense, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createAutoScroll } from "@vectordevai/ui/hooks"
import { MenuV2 } from "@vectordevai/ui/v2/menu-v2"
import { Terminal } from "@/components/terminal"
import { FileProvider } from "@/context/file"
import type { ServerConnection } from "@/context/server"
import { SDKProvider } from "@/context/sdk"
import { TerminalProvider, useTerminal } from "@/context/terminal"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import { externalActivityEntries, type ExternalActivityEntry } from "@/pages/session/agent-follow"
import { externalAgentWorkspaceTabs, type ExternalAgentWorkspaceView } from "./external-agent-workspace-model"
import { NativeDirectoryReview } from "@/features/connect/directory-review"
import "./external-agent-chat.css"

const CodespaceWorkbench = lazy(() =>
  import("@/pages/session/session-side-panel").then((module) => ({ default: module.CodespaceWorkbench })),
)
const PreviewPanel = lazy(() =>
  import("@/pages/session/session-side-panel").then((module) => ({ default: module.PreviewPanel })),
)

export function ExternalAgentWorkspace(props: {
  id: string
  directory: string
  server: ServerConnection.Key
  name: string
  runtimeLabel: string
  statusLabel: string
  statusTone: string
  branchLabel: string
  model: string
  cost: string
  running: boolean
  changedFiles: number
  changedFilePaths: readonly string[]
  added: number
  removed: number
  risk: string
  initialView: ExternalAgentWorkspaceView
  chat: JSX.Element
  changes: JSX.Element
  activity: JSX.Element
  composer: JSX.Element
  actions: JSX.Element
  onBack: () => void
  onRefresh: () => void
  onViewChange: (view: ExternalAgentWorkspaceView) => void
  /** The runner's activity steps. Without them, the files view reads them from the desktop bridge. */
  activityEntries?: () => readonly ExternalActivityEntry[]
}) {
  const [state, setState] = createStore({ view: props.initialView })
  createEffect(() => setState("view", props.initialView))
  const openView = (view: ExternalAgentWorkspaceView) => {
    setState("view", view)
    props.onViewChange(view)
  }

  return (
    <SDKProvider directory={() => props.directory}>
      <DirectoryDataProvider directory={() => props.directory} server={() => props.server}>
        <TerminalProvider>
          <FileProvider>
            <section
              data-vector-external-agent-workspace
              data-workspace-id={props.id}
              data-workspace-directory={props.directory}
              data-active-view={state.view}
              class="vector-agent-workspace"
            >
              <header class="vector-agent-workspace-header">
                <button type="button" aria-label="Back to main agent" title="Back to main agent" onClick={props.onBack}>
                  <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                    <path
                      d="M9.75 3.75 5.5 8l4.25 4.25"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
                <h1 class="vector-agent-workspace-title">{props.name}</h1>
                <span class="vector-agent-workspace-status" data-running={props.running}>
                  <span />
                  {props.running ? "Working" : props.statusLabel}
                </span>
                <Show when={state.view !== "chat"}>
                  <button type="button" onClick={() => openView("chat")} aria-label="Back to conversation">
                    Chat
                  </button>
                </Show>
                <button
                  type="button"
                  aria-pressed={state.view === "files"}
                  onClick={() => openView(state.view === "files" ? "chat" : "files")}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M5.5 2.5h5l3 3v8h-8zM10.5 2.5v3h3M2.5 5.5v8h3" />
                  </svg>
                  Files
                </button>
                <button
                  type="button"
                  aria-pressed={state.view === "changes"}
                  onClick={() => openView(state.view === "changes" ? "chat" : "changes")}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 2.5h10v11H3zM5.5 5.5h5M8 3.5v4M5.5 10.5h5" />
                  </svg>
                  Changes{" "}
                  <Show when={props.changedFiles > 0}>
                    <span class="vector-agent-header-count">{props.changedFiles}</span>
                  </Show>
                </button>
                <MenuV2 placement="bottom-end" gutter={8}>
                  <MenuV2.Trigger aria-label="More workspace tools" title="More workspace tools">
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="3" cy="8" r=".75" />
                      <circle cx="8" cy="8" r=".75" />
                      <circle cx="13" cy="8" r=".75" />
                    </svg>
                  </MenuV2.Trigger>
                  <MenuV2.Portal>
                    <MenuV2.Content class="vector-agent-workspace-menu">
                      <For
                        each={externalAgentWorkspaceTabs.filter((view) =>
                          ["terminal", "browser", "activity"].includes(view.value),
                        )}
                      >
                        {(view) => (
                          <MenuV2.Item onSelect={() => openView(view.value)}>
                            {view.value === "activity" ? "Run details" : view.label}
                          </MenuV2.Item>
                        )}
                      </For>
                      <MenuV2.Item onSelect={props.onRefresh}>Refresh activity</MenuV2.Item>
                      <MenuV2.Separator />
                      <div class="vector-agent-workspace-meta">
                        <span>
                          {props.runtimeLabel} · {props.model}
                        </span>
                        <span>{props.branchLabel}</span>
                        <span>{props.cost}</span>
                      </div>
                    </MenuV2.Content>
                  </MenuV2.Portal>
                </MenuV2>
              </header>

              <div class="min-h-0 flex-1 overflow-hidden">
                <Show when={state.view === "chat"}>
                  <ExternalAgentChatPane chat={props.chat} composer={props.composer}>
                    <Show when={props.changedFiles > 0 && !props.running}>
                      <button type="button" class="vector-agent-change-summary" onClick={() => openView("changes")}>
                        Review {props.changedFiles} changed {props.changedFiles === 1 ? "file" : "files"}
                        <span data-added>+{props.added}</span>
                        <span data-removed>−{props.removed}</span>
                      </button>
                    </Show>
                  </ExternalAgentChatPane>
                </Show>
                <Show when={state.view === "files"}>
                  <ExternalAgentFiles
                    workspaceId={props.id}
                    activityEntries={props.activityEntries}
                    changedFiles={() => props.changedFilePaths}
                    runtimeLabel={props.runtimeLabel}
                    running={props.running}
                    chat={props.chat}
                    composer={props.composer}
                    onClose={() => openView("chat")}
                    onReview={() => openView("changes")}
                  />
                </Show>
                <Show when={state.view === "changes"}>
                  <div class="size-full overflow-y-auto px-5 py-5">
                    <div class="mx-auto w-full max-w-[1180px]">{props.changes}</div>
                  </div>
                </Show>
                <Show when={state.view === "terminal"}>
                  <ExternalAgentTerminal />
                </Show>
                <Show when={state.view === "browser"}>
                  <div data-vector-agent-browser class="size-full min-h-0">
                    <Suspense fallback={<ToolLoading label="Opening browser" />}>
                      <PreviewPanel
                        sessionKey={`external-agent:${props.id}`}
                        contextId={`external-agent:${props.id}`}
                        directory={props.directory}
                        onClose={() => openView("chat")}
                      />
                    </Suspense>
                  </div>
                </Show>
                <Show when={state.view === "activity"}>
                  <div class="size-full overflow-y-auto px-5 py-5">
                    <div class="mx-auto w-full max-w-[1080px]">{props.activity}</div>
                  </div>
                </Show>
              </div>

              <Show when={state.view === "changes"}>
                <footer class="vector-agent-review-actions">
                  <NativeDirectoryReview workspaceID={props.id} directory={props.directory} running={props.running} />
                  {props.actions}
                </footer>
              </Show>
            </section>
          </FileProvider>
        </TerminalProvider>
      </DirectoryDataProvider>
    </SDKProvider>
  )
}

function ExternalAgentChatPane(props: { chat: JSX.Element; composer: JSX.Element; children?: JSX.Element }) {
  // Follow new text and late markdown layout until the reader scrolls away.
  // This also covers reopening a completed conversation with cached messages.
  const scroll = createAutoScroll({ working: () => true, overflowAnchor: "dynamic" })
  return (
    <div class="vector-agent-chat-pane">
      <div
        class="vector-agent-chat-scroll"
        ref={scroll.scrollRef}
        onScroll={scroll.handleScroll}
        onPointerUp={scroll.handleInteraction}
      >
        <div class="vector-agent-chat-content" ref={scroll.contentRef}>
          {props.chat}
          {props.children}
        </div>
      </div>
      <Show when={scroll.userScrolled()}>
        <button type="button" class="vector-agent-scroll-latest" onClick={scroll.resume}>
          ↓ Latest message
        </button>
      </Show>
      {props.composer}
    </div>
  )
}

function ExternalAgentFiles(props: {
  workspaceId: string
  activityEntries?: () => readonly ExternalActivityEntry[]
  changedFiles: () => readonly string[]
  runtimeLabel: string
  running: boolean
  chat: JSX.Element
  composer: JSX.Element
  onClose: () => void
  onReview: () => void
}) {
  const [portalMount, setPortalMount] = createSignal<HTMLDivElement>()
  // Created once. Inside the externalAgent literal below it would be rebuilt
  // every time the editor reads that prop.
  const panel = <ExternalAgentChatPane chat={props.chat} composer={props.composer} />

  // The runner reports which files a step touches, so the editor can open the
  // file with the agent's cursor before the write reaches the watcher. Nothing
  // passes the record in yet, so read it from the desktop bridge while this
  // view is open. Runners that predate the field report no files, and nothing
  // is followed from them. Undefined until the first read: the follow store
  // takes the first real snapshot as history, so nothing may stand in for it
  // (an empty placeholder would make every step already finished look live).
  const [polled, setPolled] = createSignal<readonly ExternalActivityEntry[]>()
  createEffect(() => {
    if (props.activityEntries) return
    const running = props.running
    const api = globalThis.window?.api?.parallelWorkspaces
    if (!api) return
    let alive = true
    const read = () =>
      void api
        .list()
        .then((records) => {
          if (!alive) return
          const record = records.find((item) => item.id === props.workspaceId)
          // Not listed yet is not "no activity": wait for the record.
          if (!record) return
          setPolled(externalActivityEntries((record as Record<string, unknown>).turns))
        })
        .catch(() => undefined)
    read()
    onCleanup(() => {
      alive = false
    })
    // A stopped run is read once more, which catches its final step.
    if (!running) return
    const timer = setInterval(read, 1_000)
    onCleanup(() => clearInterval(timer))
  })
  const activity = () => props.activityEntries?.() ?? polled()

  return (
    <div
      ref={setPortalMount}
      data-vector-agent-files
      class="relative size-full min-h-0 overflow-hidden bg-[color:var(--vx-canvas)]"
    >
      <Show when={portalMount()}>
        {(mount) => (
          <Suspense fallback={<ToolLoading label="Opening isolated code editor" />}>
            <CodespaceWorkbench
              modified={props.changedFiles}
              kinds={() => new Map()}
              empty={() => <span>No changed files yet.</span>}
              diffs={() => []}
              focusReviewDiff={props.onReview}
              onClose={props.onClose}
              embedded
              portalMount={mount()}
              externalAgent={{
                label: props.runtimeLabel,
                running: props.running,
                panel,
                activity,
              }}
            />
          </Suspense>
        )}
      </Show>
    </div>
  )
}

function ExternalAgentTerminal() {
  const terminal = useTerminal()
  const [state, setState] = createStore({ created: false })

  createEffect(() => {
    if (!terminal.ready() || terminal.all().length || state.created) return
    setState("created", true)
    terminal.new()
  })

  return (
    <div data-vector-agent-terminal class="flex size-full min-h-0 flex-col bg-[color:var(--vx-canvas)]">
      <div class="flex h-10 shrink-0 items-center border-b border-[color:var(--vx-line)] bg-[#18181a] px-2">
        <For each={terminal.all()}>
          {(pty) => (
            <div
              class="group flex h-8 min-w-[112px] max-w-[220px] items-center rounded-[6px] text-[11px] transition"
              classList={{
                "bg-white/[0.07] text-white/82": terminal.active() === pty.id,
                "text-white/38 hover:bg-white/[0.04] hover:text-white/68": terminal.active() !== pty.id,
              }}
            >
              <button
                type="button"
                class="flex h-full min-w-0 flex-1 items-center gap-2 px-2.5 text-left"
                onClick={() => terminal.open(pty.id)}
              >
                <span class="size-1.5 shrink-0 rounded-full bg-emerald-400/70" />
                <span class="min-w-0 flex-1 truncate">{pty.title || `Terminal ${pty.titleNumber}`}</span>
              </button>
              <button
                type="button"
                class="mr-1 grid size-4 shrink-0 place-items-center rounded text-white/25 opacity-0 transition hover:bg-white/[0.08] hover:text-white group-hover:opacity-100"
                aria-label={`Close ${pty.title || "terminal"}`}
                onClick={() => void terminal.close(pty.id)}
              >
                ×
              </button>
            </div>
          )}
        </For>
        <button
          type="button"
          class="ml-1 grid size-7 place-items-center rounded-[6px] text-white/35 transition hover:bg-white/[0.06] hover:text-white"
          aria-label="New terminal in isolated workspace"
          title="New terminal"
          onClick={() => terminal.new()}
        >
          +
        </button>
      </div>
      <div class="relative min-h-0 flex-1">
        <Show when={terminal.ready()} fallback={<ToolLoading label="Connecting terminal" />}>
          <Show when={terminal.active()} fallback={<ToolLoading label="Starting terminal" />} keyed>
            {(id) => {
              const operations = terminal.bind()
              return (
                <Show when={terminal.all().find((pty) => pty.id === id)}>
                  {(pty) => (
                    <div id={`terminal-wrapper-${id}`} class="absolute inset-0">
                      <Terminal
                        pty={pty()}
                        autoFocus
                        onConnect={() => operations.trim(id)}
                        onCleanup={operations.update}
                        onConnectError={() => void operations.clone(id)}
                      />
                    </div>
                  )}
                </Show>
              )
            }}
          </Show>
        </Show>
      </div>
    </div>
  )
}

function ToolLoading(props: { label: string }) {
  return (
    <div class="grid size-full place-items-center bg-[#151517] text-[11.5px] text-white/38">
      <div class="flex items-center gap-2">
        <span class="size-1.5 animate-pulse rounded-full bg-[color:var(--vx-purple-bright)]" />
        {props.label}…
      </div>
    </div>
  )
}
