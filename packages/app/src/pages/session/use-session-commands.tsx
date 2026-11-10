import { useNavigate, useParams } from "@solidjs/router"
import { useCommand, type CommandOption } from "@/context/command"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { previewSelectedLines } from "@vectordevai/session-ui/pierre/selection-bridge"
import { useFile, selectionFromLines, type FileSelection, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { showToast } from "@/utils/toast"
import { findLast } from "@vectordevai/core/util/array"
import { createSessionTabs } from "@/pages/session/helpers"
import { extractPromptFromParts } from "@/utils/prompt"
import { UserMessage } from "@vectordevai/sdk/v2"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useTabs } from "@/context/tabs"
import { requireServerKey } from "@/utils/session-route"
import { announceWorkspaceMode } from "@/utils/workspace-mode"
import { createSessionOwnership } from "./session-ownership"
import { BACKGROUND_TASKS_COMMAND, backgroundTasksPane } from "@/features/background-tasks/background-tasks-state"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { useFollowups } from "@/features/followup/followup-queue"
import { useBackgroundTasks } from "@/features/background-tasks/use-background-tasks"
import { helperTargets, stopSession } from "@/features/background-tasks/stop-helpers"
import { isLive } from "@/features/background-tasks/subagent-model"
import {
  appendWorkflowRequest,
  WORKFLOW_EVENT,
  type WorkflowOpenDetail,
} from "@/features/background-tasks/workflow-model"
import { WORKFLOW_COMMAND } from "@/components/prompt-input/slash-popover"

export type SessionCommandContext = {
  navigateMessageByOffset: (offset: number) => void
  setActiveMessage: (message: UserMessage | undefined) => void
  focusInput: () => void
  review?: () => boolean
}

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useSessionCommands = (actions: SessionCommandContext) => {
  const command = useCommand()
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
  const sdk = useSDK()
  const settings = useSettings()
  const sync = useSync()
  const terminal = useTerminal()
  const sessionTabs = useTabs()
  const layout = useLayout()
  const navigate = useNavigate()
  const { params, sessionKey, tabs, view } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)
  const openDialog = async <T,>(load: () => Promise<T>, show: (value: T) => void) => {
    const owner = sessionOwnership.capture()
    const value = await load()
    owner.run(() => show(value))
  }
  const runCommand = async <T,>(input: {
    owner: ReturnType<ReturnType<typeof createSessionOwnership>["capture"]>
    prompt: T
    request: () => Promise<unknown>
    updatePrompt: (prompt: T) => void
    updateViewport: () => void
  }) => {
    await input.request()
    input.updatePrompt(input.prompt)
    input.owner.run(input.updateViewport)
  }

  const info = () => {
    const id = params.id
    if (!id) return
    return sync().session.get(id)
  }
  const hasReview = () => !!params.id
  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: actions.review,
    hasReview,
  })
  const activeFileTab = tabState.activeFileTab
  const closableTab = tabState.closableTab
  const shown = settings.visibility.fileTree

  const messages = () => {
    const id = params.id
    if (!id) return []
    return sync().data.message[id] ?? []
  }
  const userMessages = () => messages().filter((m) => m.role === "user") as UserMessage[]
  const visibleUserMessages = () => {
    const revert = info()?.revert?.messageID
    if (!revert) return userMessages()
    return userMessages().filter((m) => m.id < revert)
  }

  const showAllFiles = () => {
    if (layout.fileTree.tab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addSelectionToContext = (path: string, selection: FileSelection) => {
    const preview = selectionPreview(path, selection)
    prompt.context.add({ type: "file", path, selection, preview })
  }

  const canAddSelectionContext = () => {
    const tab = activeFileTab()
    if (!tab) return false
    const path = file.pathFromTab(tab)
    if (!path) return false
    return file.selectedLines(path) != null
  }

  const navigateMessageByOffset = actions.navigateMessageByOffset
  const setActiveMessage = actions.setActiveMessage
  const focusInput = actions.focusInput

  const sessionCommand = withCategory(language.t("command.category.session"))
  const fileCommand = withCategory(language.t("command.category.file"))
  const contextCommand = withCategory(language.t("command.category.context"))
  const viewCommand = withCategory(language.t("command.category.view"))
  const terminalCommand = withCategory(language.t("command.category.terminal"))
  const mcpCommand = withCategory(language.t("command.category.mcp"))
  const permissionsCommand = withCategory(language.t("command.category.permissions"))

  const isAutoAcceptActive = () => {
    const sessionID = params.id
    if (sessionID) return permission.isAutoAccepting(sessionID, sdk().directory)
    return permission.isAutoAcceptingDirectory(sdk().directory)
  }
  const openFile = () => {
    void openDialog(
      () => import("@/components/dialog-select-file"),
      (x) => dialog.show(() => <x.DialogSelectFile onOpenFile={showAllFiles} />),
    )
  }

  const closeTab = () => {
    const tab = closableTab()
    if (!tab) return
    tabs().close(tab)
  }

  const addSelection = () => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (!path) return

    const range = file.selectedLines(path) as SelectedLineRange | null | undefined
    if (!range) {
      showToast({
        title: language.t("toast.context.noLineSelection.title"),
        description: language.t("toast.context.noLineSelection.description"),
      })
      return
    }

    addSelectionToContext(path, selectionFromLines(range))
  }

  const openTerminal = () => {
    if (terminal.all().length > 0) terminal.new()
    view().terminal.open()
  }

  const vectorspace = () => {
    const alreadyOpen = view().reviewPanel.opened() && tabs().active() === "codespace"
    layout.fileTree.close()
    view().reviewPanel.open("other")
    void tabs().open("codespace")
    tabs().setActive("codespace")
    announceWorkspaceMode("editor")
    if (alreadyOpen) return
    showToast({
      title: "Vector Codespace opened",
      description: "The synced editor is open. Pick a file in Codespace to inspect or review code.",
    })
  }

  const closeCodespace = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    if (tabs().active() === "codespace") tabs().close("codespace")
    announceWorkspaceMode("agent")
  }

  const closeWorkspacePanel = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    if (tabs().active() === "codespace") tabs().close("codespace")
    if (tabs().active() === "preview") tabs().close("preview")
    announceWorkspaceMode("agent")
  }

  const openPreview = () => {
    const alreadyOpen = view().reviewPanel.opened() && tabs().active() === "preview"
    layout.fileTree.close()
    view().reviewPanel.open("other")
    void tabs().open("preview")
    tabs().setActive("preview")
    if (alreadyOpen) return
    showToast({
      title: "Browser opened",
      description: "Browse any URL or start your app in Terminal and open its localhost address here.",
    })
  }

  const vectorWorkflowCmds = () => [
    viewCommand({
      id: "vector.codespace.open",
      title: "Open Vector Codespace",
      description: "Open the synced editor with files, review, and repository context.",
      slash: "codespace",
      onSelect: vectorspace,
    }),
    viewCommand({
      id: "vector.codespace.close",
      title: "Return to Vector Agent",
      description: "Close the full-screen editor and return to the current agent conversation.",
      onSelect: closeCodespace,
    }),
    viewCommand({
      id: "vector.workspace-panel.close",
      title: "Close workspace panel",
      description: "Close the active editor or browser panel before opening another full-screen workspace.",
      onSelect: closeWorkspacePanel,
    }),
    viewCommand({
      id: "vector.preview.open",
      title: "Toggle Browser",
      description: "Open Vector's controlled browser beside the current task.",
      slash: "browser",
      onSelect: openPreview,
    }),
  ]

  const chooseMcp = () => {
    void openDialog(
      () => import("@/components/dialog-select-mcp"),
      (x) => dialog.show(() => <x.DialogSelectMcp />),
    )
  }

  const choosePlugins = () => {
    void openDialog(
      () => import("@/components/dialog-select-plugins"),
      (x) => dialog.show(() => <x.DialogSelectPlugins />),
    )
  }

  const toggleAutoAccept = () => {
    const sessionID = params.id
    if (sessionID) permission.toggleAutoAccept(sessionID, sdk().directory)
    else permission.toggleAutoAcceptDirectory(sdk().directory)

    const active = sessionID
      ? permission.isAutoAccepting(sessionID, sdk().directory)
      : permission.isAutoAcceptingDirectory(sdk().directory)
    showToast({
      title: active
        ? language.t("toast.permissions.autoaccept.on.title")
        : language.t("toast.permissions.autoaccept.off.title"),
      description: active
        ? language.t("toast.permissions.autoaccept.on.description")
        : language.t("toast.permissions.autoaccept.off.description"),
    })
  }

  const undo = async () => {
    const sessionID = params.id
    if (!sessionID) return
    const owner = sessionOwnership.capture()
    const client = sdk().client
    const directory = sdk().directory
    const promptSession = prompt.capture()
    const revert = info()?.revert?.messageID
    const messages = userMessages()
    const message = findLast(messages, (x) => !revert || x.id < revert)
    if (!message) return
    const parts = sync().data.part[message.id]

    if (sync().data.session_working(sessionID)) {
      await client.session.abort({ sessionID }).catch(() => {})
    }

    await runCommand({
      owner,
      prompt: promptSession,
      request: () => client.session.revert({ sessionID, messageID: message.id }),
      updatePrompt: (promptSession) => {
        if (parts) promptSession.set(extractPromptFromParts(parts, { directory }))
      },
      updateViewport: () => setActiveMessage(findLast(messages, (x) => x.id < message.id)),
    })
  }

  const redo = async () => {
    const sessionID = params.id
    if (!sessionID) return
    const owner = sessionOwnership.capture()
    const client = sdk().client
    const messages = userMessages()
    const promptSession = prompt.capture()

    const revertMessageID = info()?.revert?.messageID
    if (!revertMessageID) return

    const next = messages.find((x) => x.id > revertMessageID)
    if (!next) {
      await runCommand({
        owner,
        prompt: promptSession,
        request: () => client.session.unrevert({ sessionID }),
        updatePrompt: (promptSession) => promptSession.reset(),
        updateViewport: () => setActiveMessage(findLast(messages, (x) => x.id >= revertMessageID)),
      })
      return
    }

    await runCommand({
      owner,
      prompt: promptSession,
      request: () => client.session.revert({ sessionID, messageID: next.id }),
      updatePrompt: () => undefined,
      updateViewport: () => setActiveMessage(findLast(messages, (x) => x.id < next.id)),
    })
  }

  const compact = async () => {
    const sessionID = params.id
    if (!sessionID) return

    const model = local.model.current()
    if (!model) {
      showToast({
        title: language.t("toast.model.none.title"),
        description: language.t("toast.model.none.description"),
      })
      return
    }

    await sdk().client.session.summarize({
      sessionID,
      modelID: model.id,
      providerID: model.provider.id,
    })
  }

  const fork = () => {
    void openDialog(
      () => import("@/components/dialog-fork"),
      (x) => dialog.show(() => <x.DialogFork />),
    )
  }

  const sessionCmds = () => [
    sessionCommand({
      id: "session.share",
      title: "Share session publicly…",
      description: "Review the public copy, publish, copy its link, or unshare",
      slash: "share",
      disabled: !params.id,
      onSelect: () => {
        const sessionID = params.id
        if (!sessionID) return
        void openDialog(
          () => import("@/components/dialog-share-session"),
          (x) => dialog.show(() => <x.DialogShareSession sessionID={sessionID} />),
        )
      },
    }),
    sessionCommand({
      id: "session.new",
      title: language.t("command.session.new"),
      keybind: "mod+shift+s",
      slash: "new",
      onSelect: () => {
        if (params.serverKey) {
          sessionTabs.newDraft({ server: requireServerKey(params.serverKey), directory: sdk().directory })
          return
        }
        navigate(`/${params.dir}/session`)
      },
    }),
    sessionCommand({
      id: "session.undo",
      title: language.t("command.session.undo"),
      description: language.t("command.session.undo.description"),
      slash: "undo",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: undo,
    }),
    sessionCommand({
      id: "session.redo",
      title: language.t("command.session.redo"),
      description: language.t("command.session.redo.description"),
      slash: "redo",
      disabled: !params.id || !info()?.revert?.messageID,
      onSelect: redo,
    }),
    sessionCommand({
      id: "session.compact",
      title: language.t("command.session.compact"),
      description: language.t("command.session.compact.description"),
      slash: "compact",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: compact,
    }),
    sessionCommand({
      id: "session.fork",
      title: language.t("command.session.fork"),
      description: language.t("command.session.fork.description"),
      slash: "fork",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: fork,
    }),
  ]

  const fileCmds = () => {
    const tab = closableTab()
    return [
      fileCommand({
        id: "file.open",
        title: language.t("command.file.open"),
        description: language.t("palette.search.placeholder"),
        keybind: "mod+k,mod+p",
        slash: "open",
        onSelect: openFile,
      }),
      tab &&
        fileCommand({
          id: "tab.close",
          title: language.t("command.tab.close"),
          keybind: "mod+w",
          onSelect: closeTab,
        }),
    ].filter((v) => !!v)
  }

  const contextCmds = () => [
    contextCommand({
      id: "context.window.open",
      title: "Open Context Window",
      description: "Open only the session context window without switching to Codespace review.",
      slash: "context",
      onSelect: () => {
        view().reviewPanel.open("context-button")
        layout.fileTree.close()
        void tabs().open("context")
        tabs().setActive("context")
      },
    }),
    contextCommand({
      id: "context.addSelection",
      title: language.t("command.context.addSelection"),
      description: language.t("command.context.addSelection.description"),
      keybind: "mod+shift+l",
      disabled: !canAddSelectionContext(),
      onSelect: addSelection,
    }),
  ]

  const viewCmds = () => [
    viewCommand({
      id: "terminal.toggle",
      title: language.t("command.terminal.toggle"),
      keybind: "ctrl+`",
      slash: "terminal",
      onSelect: () => view().terminal.toggle(),
    }),
    viewCommand({
      id: "review.toggle",
      title: language.t("command.review.toggle"),
      keybind: "mod+shift+r",
      onSelect: () => {
        view().reviewPanel.toggle()
        if (view().reviewPanel.opened()) tabs().setActive("review")
      },
    }),
    viewCommand({
      id: "review.open",
      title: language.t("command.review.toggle"),
      hidden: true,
      onSelect: () => {
        view().reviewPanel.open()
        tabs().setActive("review")
      },
    }),
    viewCommand({
      id: BACKGROUND_TASKS_COMMAND,
      title: "Toggle background tasks",
      description: "Show the subagents and subagent specialists working for this session.",
      keybind: "mod+shift+b",
      disabled: !params.id,
      onSelect: () => backgroundTasksPane.toggle(),
    }),
    ...(shown()
      ? [
          viewCommand({
            id: "fileTree.toggle",
            title: language.t("command.fileTree.toggle"),
            keybind: "mod+\\",
            onSelect: () => layout.fileTree.toggle(),
          }),
        ]
      : []),
    viewCommand({
      id: "input.focus",
      title: language.t("command.input.focus"),
      keybind: "ctrl+l",
      onSelect: focusInput,
    }),
  ]

  const terminalCmds = () => [
    terminalCommand({
      id: "terminal.new",
      title: language.t("command.terminal.new"),
      description: language.t("command.terminal.new.description"),
      keybind: "ctrl+alt+t",
      onSelect: openTerminal,
    }),
  ]

  const messageCmds = () => [
    sessionCommand({
      id: "message.previous",
      title: language.t("command.message.previous"),
      description: language.t("command.message.previous.description"),
      keybind: "mod+alt+[",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(-1),
    }),
    sessionCommand({
      id: "message.next",
      title: language.t("command.message.next"),
      description: language.t("command.message.next.description"),
      keybind: "mod+alt+]",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(1),
    }),
  ]

  const mcpCmds = () => [
    mcpCommand({
      id: "mcp.toggle",
      title: language.t("command.mcp.toggle"),
      description: language.t("command.mcp.toggle.description"),
      keybind: "mod+;",
      slash: "mcp",
      onSelect: chooseMcp,
    }),
    mcpCommand({
      id: "plugins.open",
      title: "Plugins",
      description: "Connect GitHub, Linear, Sentry and more to Vector.",
      slash: "plugins",
      onSelect: choosePlugins,
    }),
  ]

  const permissionsCmds = () => [
    permissionsCommand({
      id: "permissions.autoaccept",
      title: isAutoAcceptActive()
        ? language.t("command.permissions.autoaccept.disable")
        : language.t("command.permissions.autoaccept.enable"),
      keybind: "mod+shift+a",
      disabled: false,
      onSelect: toggleAutoAccept,
    }),
  ]

  command.register("session", () => [
    ...sessionCmds(),
    ...fileCmds(),
    ...contextCmds(),
    ...vectorWorkflowCmds(),
    ...viewCmds(),
    ...terminalCmds(),
    ...messageCmds(),
    ...mcpCmds(),
    ...permissionsCmds(),
  ])
}

/*
 * Commands that act on the open conversation's helpers (5.I.4): Move to background (Ctrl+Alt+B), Stop including
 * helpers, Resume interrupted helpers, and /workflow. They need the Background tasks state, which the session page
 * provides below its own component body, so the page mounts SessionTaskCommands inside its provider.
 */
export function SessionTaskCommands() {
  useSessionTaskCommands()
  return null
}

export const useSessionTaskCommands = () => {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const prompt = usePrompt()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const sync = useSync()
  const followups = useFollowups()
  const tasks = useBackgroundTasks()
  const params = useParams()
  const sessionCommand = withCategory(language.t("command.category.session"))

  const root = () => {
    const id = params.id
    return id && tasks?.rootID() === id ? id : undefined
  }
  const agents = () => tasks?.cards().flatMap((card) => card.agents) ?? []
  const live = () => agents().filter((agent) => isLive(agent.status))
  const promotable = () => (tasks ? tasks.promotable(live()) : [])
  const blocked = () => !!tasks?.promoteBlocked(live())
  const resumable = () =>
    tasks?.capabilities().taskResume ? tasks.interrupted().filter((agent) => agent.task?.controls.resume === true) : []

  // Move to background frees the main turn from every blocking subagent the engine can move, batches included.
  const promote = async () => {
    if (!tasks) return
    if (blocked()) {
      showToast({ title: language.t("backgroundTasks.promote.batchUnsupported") })
      return
    }
    if (!promotable().length) {
      showToast({
        title: language.t("backgroundTasks.promote.none.title"),
        description: language.t("backgroundTasks.promote.none.description"),
      })
      return
    }
    await tasks.promote(live())
  }

  // "Stop including helpers" from the palette, which works while the main turn is idle too (5.I.2).
  const stopAll = async () => {
    const sessionID = tasks?.rootID() ?? params.id
    if (!sessionID || !tasks) return
    // Stop pauses the conversation's queue until Resume, as the composer's Stop does (I7).
    void followups.pause(ServerConnection.key(serverSDK().server), sessionID, "aborted")
    const result = await stopSession({
      client: sdk().client,
      sessionID,
      capabilities: tasks.capabilities(),
      targets: helperTargets(agents()),
    }).catch((error: unknown) => {
      showToast({
        variant: "error",
        title: language.t("prompt.toast.stopHelpersFailed.title"),
        description: error instanceof Error ? error.message : undefined,
      })
      return undefined
    })
    if (!result) return
    if (result.failed > 0)
      showToast({
        variant: "error",
        title: language.t("prompt.toast.stopHelpersFailed.title"),
        description: language.t("prompt.toast.stopHelpersFailed.description"),
      })
    else if (result.excluded > 0)
      showToast({
        title: language.t("prompt.toast.workspacesKept.title"),
        description: language.t("prompt.toast.workspacesKept.description"),
      })
  }

  const resumeInterrupted = async () => {
    const targets = resumable()
    if (!tasks || !targets.length) return
    await tasks.resume(targets)
  }

  const openWorkflow = (name?: string) => {
    const sessionID = root()
    if (!sessionID || !tasks?.capabilities().workflows) return
    const client = sdk().client
    void import("@/features/background-tasks/workflow-dialog").then((x) =>
      dialog.show(() => (
        <x.DialogWorkflow
          client={client}
          sessionID={sessionID}
          name={name}
          busy={() => sync().data.session_working(sessionID)}
          compose={(text) => {
            const target = prompt.capture()
            const next = appendWorkflowRequest(target.current(), text)
            target.set(
              next,
              next.reduce((end, part) => (part.type === "image" ? end : Math.max(end, part.end)), 0),
            )
            requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-component="prompt-input"]')?.focus())
          }}
        />
      )),
    )
  }

  // `/workflow <name>` sent from the composer (submit.ts) opens the form for that saved workflow.
  makeEventListener(window, WORKFLOW_EVENT, (event) => {
    const detail = (event as CustomEvent<WorkflowOpenDetail>).detail
    if (!detail || detail.sessionID !== root()) return
    openWorkflow(detail.name)
  })

  command.register("session-tasks", () => [
    sessionCommand({
      id: "backgroundTasks.promote",
      title: language.t("command.backgroundTasks.promote"),
      description: language.t("command.backgroundTasks.promote.description"),
      keybind: "ctrl+alt+b",
      disabled: !root() || (promotable().length === 0 && !blocked()),
      onSelect: () => void promote(),
    }),
    sessionCommand({
      id: "session.stopAll",
      title: language.t("command.session.stopAll"),
      description: language.t("command.session.stopAll.description"),
      disabled: !params.id || !tasks,
      onSelect: () => void stopAll(),
    }),
    sessionCommand({
      id: "backgroundTasks.resumeInterrupted",
      title: language.t("command.backgroundTasks.resumeInterrupted"),
      description: language.t("command.backgroundTasks.resumeInterrupted.description"),
      disabled: !root() || resumable().length === 0,
      onSelect: () => void resumeInterrupted(),
    }),
    sessionCommand({
      id: WORKFLOW_COMMAND,
      title: language.t("command.workflow.open"),
      description: language.t("command.workflow.open.description"),
      slash: "workflow",
      disabled: !root() || !tasks?.capabilities().workflows,
      onSelect: () => openWorkflow(),
    }),
  ])
}
