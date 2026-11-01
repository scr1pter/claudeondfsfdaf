import { initializeVectorAccount, vectorAccount } from "./vector-account-runtime"
import { execFile } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, shell, systemPreferences } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@vectordevai/app/desktop-menu"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"

import type { BrowserAgentInput, FatalRendererError, ServerReadyData, TitlebarTheme } from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore, removeStoreFileIfEmpty } from "./store"
import { isRendererStoreName } from "./store-keys"
import { write } from "./logging"
import { sendBugReport } from "./bug-report"
import { askHelpAssistant, type HelpInput } from "./help-assistant"
import { clearLocalMemory, readLocalMemory, writeLocalMemory } from "./local-memory"
import { desktopLocalStatus } from "./local-mode"
import { deleteRepoRule, listRepoRules, saveRepoRule, type SaveRepoRuleInput } from "./repo-rules"
import { ensureRuntime, preparePluginCommand, type RuntimeName } from "./runtime-bootstrap"
import { convertHeicToJpeg } from "./image-convert"
import {
  addTeamMember,
  claimPendingMessages,
  createAgentTeam,
  deleteAgentTeam,
  getAgentTeam,
  getCollaborationGraph,
  listAgentTeams,
  postTeamMessage,
  removeTeamMember,
  setCollaborationGraph,
} from "./agent-teams"
import type { TeamCollaborationGraph, TeamTopology } from "./agent-team-model"
import {
  automaticReviewStatus,
  autoReviewWorkflow,
  createPullRequest,
  listPullRequests,
  mergePullRequest,
  pullRequestAccessStatus,
  pullRequestChecks,
  pullRequestDiff,
  setUpAutomaticReviews,
  submitPullRequestReview,
  viewPullRequest,
} from "./github-pr"
import {
  getMainWindowCount,
  getPinchZoomEnabled,
  getWindowID,
  setPinchZoomEnabled,
  setTitlebar,
  updateTitlebar,
} from "./windows"
import { assertTrustedRenderer } from "./ipc-security"
import {
  openPathApplicationCommand,
  openPathArguments,
  openPathCommand,
  isLaunchableBundle,
  requireOpenPathApplication,
  requireOpenPathDirectory,
} from "./open-path"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"
import { inspectAgentTask, listAgentTasks, messageAgentTask, stopAgentTask, type TaskScope } from "./agent-task-board"
import { onTaskBoardChange } from "./task-board-events"
import { initTaskRelay } from "./task-relay"
import { runBrowserAgent } from "./browser-agent"
import { ResearchWatch } from "./research-browser"
import { prepareAgentTask } from "./context-budget"
import { speakVoiceText, stopVoiceSynthesis } from "./voice-synthesis"
import { cancelBackgroundTask, clearCompletedBackgroundTasks, listBackgroundTasks } from "./background-tasks"
import { cloudOverview, recordPublishAttempt, watchCloudChanges } from "./cloud-overview"
import {
  checkAllDeploymentHealth,
  checkDeploymentHealth,
  detectPublishTargets,
  publishProject,
  rerunDeploymentChecks,
  type PublishProjectInput,
} from "./publish"
import {
  applyEnv,
  detectBuildSettings,
  getBuildSettings,
  getDatabase,
  listDeployments,
  listEnv,
  removeDeployment,
  removeEnv,
  setBuildSettings,
  setEnv,
} from "./cloud-console"
import {
  connectCloudProvider,
  connectCloudProviderWithToken,
  disconnectCloudProvider,
  listCloudProviderConnections,
  listCloudProviderProjectLinks,
  listCloudProviderResources,
  type CloudProviderId,
} from "./cloud-connections"
import { runSupabaseCommand } from "./cloud-supabase"
import { vercelIpc, VERCEL_IPC_PREFIX } from "./cloud-vercel-ipc"
import {
  detectGithub,
  publishToGithub,
  pushWithOauth,
  type GithubOauthPushInput,
  type GithubPublishInput,
} from "./github"
import {
  cancelDeviceLogin,
  completeDeviceLogin,
  createRepo,
  getAuthStatus,
  listRepos,
  logoutGithub,
  openVerification,
  startDeviceLogin,
  type GithubCreateRepoInput,
} from "./github-auth"
import {
  cancelGithubClone,
  cancelGithubClonesFor,
  cloneGithubRepository,
  githubCloneParent,
  parseGithubCloneSource,
  pickGithubCloneParent,
  sweepGithubCloneSecrets,
  type GithubCloneInput,
} from "./github-clone"
import { pushWithOauth as pushToGitlab, type GitlabOauthPushInput } from "./gitlab"
import { usePostingEngine } from "./posting-check"
import {
  cancelDeviceLogin as cancelGitlabLogin,
  completeDeviceLogin as completeGitlabLogin,
  createRepo as createGitlabRepo,
  getAuthStatus as getGitlabAuthStatus,
  listRepos as listGitlabRepos,
  logoutGitlab,
  openVerification as openGitlabVerification,
  startDeviceLogin as startGitlabLogin,
  type GitlabCreateRepoInput,
} from "./gitlab-auth"
import {
  agentCommands,
  detectExternalAgents,
  launchAgentTerminal,
  listAgentModels,
  openInEditor,
  prepareWorkspace,
  refreshAgentEnvironment,
  type OpenInEditorInput,
  type TerminalAgentInput,
} from "./external-agents"
import {
  createParallelWorkspace,
  discardParallelWorkspace,
  followUpParallelWorkspace,
  listParallelWorkspaces,
  mainWorkingTreeDiff,
  mergeParallelWorkspace,
  mergeParallelWorkspaceSelection,
  openParallelWorkspacePullRequest,
  parallelWorkspaceCloudScopes,
  refreshParallelWorkspace,
  removeParallelWorkspaceRecord,
  repairParallelWorkspace,
  runningChatAgents,
  runParallelWorkspace,
  setParallelWorkspaceRuntimeModel,
  stopParallelWorkspace,
  type CreateParallelWorkspaceInput,
} from "./parallel-workspaces"
import {
  createSwarmRun,
  discardSwarmRun,
  listSwarmRuns,
  mergeSwarmRun,
  mergeSwarmRunSelection,
  resumeSwarmRun,
  stopSwarmRun,
  type CreateSwarmRunInput,
} from "./swarm-orchestrator"
import {
  cancelScheduledAgent,
  createScheduledAgent,
  initScheduledAgents,
  listScheduledAgents,
  removeScheduledAgent,
  type CreateScheduledAgentInput,
  setScheduledAgentPaused,
} from "./scheduled-agents"
import { ciStatus, listCiRuns, prepareCiRepair, viewCiFailure } from "./ci-watch"
import { spendLedger, type SpendPolicy } from "./spend-limits"
import { clearFailureMemory, readFailureMemory } from "./failure-memory"
import {
  deleteServerCredential,
  readServerCredential,
  saveServerCredential,
  type ServerCredential,
} from "./server-credentials"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()

type Deps = {
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
  getUsageSharing: () => boolean
  setUsageSharing: (enabled: boolean) => void
}

// A research browser's key: its run and its agent's session, as the bridge validated them.
function watchID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(value)
}

function handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: T) => R) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedRenderer(event)
    return listener(event, ...(args as T))
  })
}

function on<T extends unknown[]>(channel: string, listener: (event: IpcMainEvent, ...args: T) => void) {
  ipcMain.on(channel, (event, ...args) => {
    assertTrustedRenderer(event)
    listener(event, ...(args as T))
  })
}

export function registerIpcHandlers(deps: Deps) {
  initializeVectorAccount(deps.awaitInitialization)
  // Pull requests, reviews and commits Vector makes are checked against the owner's memory by the engine first.
  usePostingEngine(deps.awaitInitialization)
  app.once("will-quit", initTaskRelay(deps.awaitInitialization))
  handle("vector-account-status", () => vectorAccount.status())
  handle("vector-account-start", () => vectorAccount.start())
  handle("vector-account-cancel", () => vectorAccount.cancel())
  handle("vector-account-logout", () => vectorAccount.logout())
  handle("vector-account-codium", () => vectorAccount.codium())
  handle("vector-account-offers", () => vectorAccount.offers())
  handle("vector-account-refresh-models", () => vectorAccount.refreshModels())
  handle("vector-account-billing", (_event, input: unknown) => vectorAccount.billing(input))
  handle("vector-account-confirm-deletion", () => vectorAccount.confirmDeletion())
  handle("vector-account-cancel-deletion", () => vectorAccount.cancelDeletion())
  handle("vector-account-delete", (_event, email: unknown) => vectorAccount.deleteAccount(email))

  const voiceOwners = new Set<number>()
  const updaterSubscriptions = createUpdaterSubscriptions()
  const taskSubscriptions = new Map<number, () => void>()
  app.once("will-quit", updaterSubscriptions.clear)
  app.once("will-quit", () => {
    taskSubscriptions.forEach((stop) => stop())
    taskSubscriptions.clear()
  })
  handle("agent-tasks-list", (_event, input: TaskScope) => listAgentTasks(input))
  handle("agent-tasks-inspect", (_event, input: TaskScope & { taskID: string }) => inspectAgentTask(input))
  handle("agent-tasks-message", (_event, input: TaskScope & { taskID: string; text: string }) =>
    messageAgentTask(input),
  )
  handle("agent-tasks-stop", (_event, input: TaskScope & { taskID: string }) => stopAgentTask(input))
  handle("agent-tasks-subscribe", (event) => {
    const id = event.sender.id
    taskSubscriptions.get(id)?.()
    taskSubscriptions.set(
      id,
      onTaskBoardChange(() => {
        if (!event.sender.isDestroyed()) event.sender.send("agent-tasks-changed")
      }),
    )
    event.sender.once("destroyed", () => {
      taskSubscriptions.get(id)?.()
      taskSubscriptions.delete(id)
    })
  })
  handle("agent-tasks-unsubscribe", (event) => {
    taskSubscriptions.get(event.sender.id)?.()
    taskSubscriptions.delete(event.sender.id)
  })

  // The Sources tab watches research browsers: their chips, snapshots and Stop. Nothing here sends input to a page.
  const researchSubscriptions = new Map<number, () => void>()
  app.once("will-quit", () => {
    researchSubscriptions.forEach((stop) => stop())
    researchSubscriptions.clear()
  })
  handle("research-watch-list", () => ResearchWatch.list())
  handle("research-watch-snapshot", (_event, id: unknown) => (watchID(id) ? ResearchWatch.snapshot(id) : undefined))
  handle("research-watch-stop", (_event, id: unknown) => (watchID(id) ? ResearchWatch.stop(id) : false))
  handle("research-watch-subscribe", (event) => {
    const id = event.sender.id
    researchSubscriptions.get(id)?.()
    researchSubscriptions.set(
      id,
      ResearchWatch.subscribe(() => {
        if (!event.sender.isDestroyed()) event.sender.send("research-watch-changed")
      }),
    )
    event.sender.once("destroyed", () => {
      researchSubscriptions.get(id)?.()
      researchSubscriptions.delete(id)
    })
  })
  handle("research-watch-unsubscribe", (event) => {
    researchSubscriptions.get(event.sender.id)?.()
    researchSubscriptions.delete(event.sender.id)
  })

  handle("kill-sidecar", () => deps.killSidecar())
  handle("await-initialization", () => deps.awaitInitialization())
  handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  handle("get-default-server-url", () => deps.getDefaultServerUrl())
  handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) => deps.setDefaultServerUrl(url))
  handle("get-display-backend", () => deps.getDisplayBackend())
  handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) => deps.setDisplayBackend(backend))
  handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  handle("check-app-exists", (_event: IpcMainInvokeEvent, value: unknown) => {
    const application = requireOpenPathApplication(value)
    if (!application) return false
    const command = openPathApplicationCommand(application, process.platform)
    return command ? deps.checkAppExists(command) : false
  })
  handle("path-exists", async (_event: IpcMainInvokeEvent, targetPath: string) => {
    if (!targetPath?.trim()) return false
    return Boolean(await stat(targetPath).catch(() => undefined))
  })
  handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  handle("report-bug", (_event, input: { message: string; email?: string }) => sendBugReport(input))
  handle("help-assistant-ask", (_event, input: HelpInput) => askHelpAssistant(input))
  handle("agent-teams-list", (_event, scope?: { sourcePath?: string; parentSessionId?: string }) =>
    listAgentTeams(scope),
  )
  handle("agent-teams-get", (_event, id: string) => getAgentTeam(id))
  handle(
    "agent-teams-create",
    (
      _event,
      input: {
        name: string
        topology: TeamTopology
        sourcePath: string
        parentSessionId?: string
        sharedPath?: string
      },
    ) => createAgentTeam(input),
  )
  handle("agent-teams-add-member", (_event, teamId: string, workspaceId: string) => addTeamMember(teamId, workspaceId))
  handle("agent-teams-remove-member", (_event, teamId: string, workspaceId: string) =>
    removeTeamMember(teamId, workspaceId),
  )
  handle(
    "agent-teams-post",
    (
      _event,
      input: { teamId: string; fromWorkspaceId: string; fromName: string; toWorkspaceId?: string; text: string },
    ) => postTeamMessage(input),
  )
  handle("agent-teams-claim", (_event, teamId: string, workspaceId: string) =>
    claimPendingMessages(teamId, workspaceId),
  )
  handle("agent-teams-delete", (_event, teamId: string) => deleteAgentTeam(teamId))
  handle("agent-teams-get-graph", (_event, teamId: string) => getCollaborationGraph(teamId))
  handle("agent-teams-set-graph", (_event, teamId: string, graph: TeamCollaborationGraph | undefined) =>
    setCollaborationGraph(teamId, graph),
  )
  handle("convert-heic", (_event, bytes: Uint8Array) => convertHeicToJpeg(new Uint8Array(bytes)))
  handle("runtime-ensure", (_event, name: RuntimeName) => ensureRuntime(name))
  handle("runtime-prepare-plugin-command", (_event, command: string[]) =>
    preparePluginCommand(Array.isArray(command) ? command.map(String) : []),
  )
  handle("local-memory-read", () => readLocalMemory())
  handle("local-memory-write", (_event, content: string) => writeLocalMemory(String(content ?? "")))
  handle("local-memory-clear", () => clearLocalMemory())
  handle("vector-local-status", () => desktopLocalStatus())
  handle("repo-rules-list", (_event: IpcMainInvokeEvent, repositoryPath?: string) =>
    listRepoRules(repositoryPath ? String(repositoryPath) : undefined),
  )
  handle("repo-rules-save", (_event: IpcMainInvokeEvent, input: SaveRepoRuleInput) => saveRepoRule(input))
  handle("repo-rules-delete", (_event: IpcMainInvokeEvent, id: string) => deleteRepoRule(String(id)))
  handle("pr-access-status", () => pullRequestAccessStatus())
  handle("pr-list", (_event, cwd: string, options?: { state?: "open" | "closed" | "merged" | "all"; limit?: number }) =>
    listPullRequests(cwd, options),
  )
  handle("pr-view", (_event, cwd: string, number: number) => viewPullRequest(cwd, number))
  handle("pr-diff", (_event, cwd: string, number: number, head?: string) => pullRequestDiff(cwd, number, head))
  handle("pr-checks", (_event, cwd: string, number: number, head: string) => pullRequestChecks(cwd, number, head))
  handle("pr-create", (_event, input: { cwd: string; title: string; body: string; base?: string; draft?: boolean }) =>
    createPullRequest(input),
  )
  handle("pr-review", (_event, input: Parameters<typeof submitPullRequestReview>[0]) => submitPullRequestReview(input))
  handle("pr-merge", (_event, input: Parameters<typeof mergePullRequest>[0]) => mergePullRequest(input))
  // The workflow pins the CLI version this desktop build requires, as development builds of the CLI do.
  handle("pr-auto-review-status", (_event, cwd: string) => automaticReviewStatus(cwd))
  handle("pr-auto-review-preview", (_event, input: { model: string; keys: string[] }) =>
    autoReviewWorkflow(input, import.meta.env.VECTOR_REQUIRED_CLI_VERSION),
  )
  handle("pr-auto-review-setup", (_event, input: { cwd: string; model: string; keys: string[] }) =>
    setUpAutomaticReviews(input, import.meta.env.VECTOR_REQUIRED_CLI_VERSION),
  )
  handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  handle("updater-check", () => deps.updater.check())
  handle("updater-install", () => deps.updater.install())
  handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  handle("browser-agent-command", (event: IpcMainInvokeEvent, input: BrowserAgentInput) =>
    runBrowserAgent(event, input),
  )
  handle("agent-task-prepare", (_event: IpcMainInvokeEvent, root: string, task: string) => prepareAgentTask(root, task))
  handle(
    "parallel-workspaces-list",
    (_event: IpcMainInvokeEvent, scope?: { sourcePath?: string; parentSessionId?: string }) =>
      listParallelWorkspaces(scope),
  )
  handle("parallel-workspaces-create", (_event: IpcMainInvokeEvent, input: CreateParallelWorkspaceInput) =>
    createParallelWorkspace(input),
  )
  handle("parallel-workspaces-refresh", (_event: IpcMainInvokeEvent, id: string) => refreshParallelWorkspace(id))
  handle("parallel-workspaces-run", async (_event: IpcMainInvokeEvent, id: string, concurrency?: number) => {
    const engine = await deps.awaitInitialization()
    return runParallelWorkspace(id, engine, concurrency)
  })
  handle("parallel-workspaces-follow-up", async (_event: IpcMainInvokeEvent, id: string, text: string) => {
    const engine = await deps.awaitInitialization()
    return followUpParallelWorkspace(id, engine, text)
  })
  handle("parallel-workspaces-repair", async (_event: IpcMainInvokeEvent, id: string) => {
    const engine = await deps.awaitInitialization()
    return repairParallelWorkspace(String(id), engine)
  })
  handle("parallel-workspaces-set-runtime-model", (_event: IpcMainInvokeEvent, id: string, model?: string) =>
    setParallelWorkspaceRuntimeModel(id, model),
  )
  handle("parallel-workspaces-stop", (_event: IpcMainInvokeEvent, id: string) => stopParallelWorkspace(id))
  handle(
    "parallel-workspaces-merge",
    (_event: IpcMainInvokeEvent, id: string, force?: boolean, commit?: { message: string }) =>
      mergeParallelWorkspace(id, Boolean(force), commit),
  )
  handle("parallel-workspaces-main-diff", (_event: IpcMainInvokeEvent, sourcePath: string) =>
    mainWorkingTreeDiff(sourcePath),
  )
  handle("parallel-workspaces-pull-request", (_event: IpcMainInvokeEvent, id: string) =>
    openParallelWorkspacePullRequest(id),
  )
  handle(
    "parallel-workspaces-merge-selection",
    (_event: IpcMainInvokeEvent, id: string, selection: { hunkIds?: string[]; files?: string[] }, force?: boolean) =>
      mergeParallelWorkspaceSelection(id, selection, Boolean(force)),
  )
  handle("parallel-workspaces-discard", (_event: IpcMainInvokeEvent, id: string) => discardParallelWorkspace(id))
  handle("parallel-workspaces-remove", (_event: IpcMainInvokeEvent, id: string) => removeParallelWorkspaceRecord(id))
  handle("swarm-runs-list", (_event: IpcMainInvokeEvent, scope?: { sourcePath?: string; parentSessionId?: string }) =>
    listSwarmRuns(scope),
  )
  handle("swarm-runs-create", async (_event: IpcMainInvokeEvent, input: CreateSwarmRunInput) => {
    const engine = await deps.awaitInitialization()
    return createSwarmRun(input, engine)
  })
  handle("swarm-runs-resume", async (_event: IpcMainInvokeEvent, id: string) => {
    const engine = await deps.awaitInitialization()
    return resumeSwarmRun(id, engine)
  })
  handle("swarm-runs-stop", (_event: IpcMainInvokeEvent, id: string) => stopSwarmRun(id))
  handle("swarm-runs-merge", (_event: IpcMainInvokeEvent, id: string, force?: boolean) =>
    mergeSwarmRun(id, Boolean(force)),
  )
  handle(
    "swarm-runs-merge-selection",
    (_event: IpcMainInvokeEvent, id: string, selection: { hunkIds?: string[]; files?: string[] }, force?: boolean) =>
      mergeSwarmRunSelection(id, selection, Boolean(force)),
  )
  handle("swarm-runs-discard", (_event: IpcMainInvokeEvent, id: string) => discardSwarmRun(id))
  initScheduledAgents(() => deps.awaitInitialization())
  handle(
    "scheduled-agents-list",
    (_event: IpcMainInvokeEvent, scope?: { directory?: string; parentSessionId?: string }) =>
      listScheduledAgents(scope),
  )
  handle("scheduled-agents-create", (_event: IpcMainInvokeEvent, input: CreateScheduledAgentInput) =>
    createScheduledAgent(input),
  )
  handle("scheduled-agents-cancel", (_event: IpcMainInvokeEvent, id: string) => cancelScheduledAgent(id))
  handle("scheduled-agents-set-paused", (_event, id: string, paused: boolean) =>
    setScheduledAgentPaused(id, Boolean(paused)),
  )
  handle("scheduled-agents-remove", (_event: IpcMainInvokeEvent, id: string) => removeScheduledAgent(id))
  // Every ci-* handler resolves to either the ok result or the module's typed
  // CiUnavailable, so a missing or signed-out `gh` reaches the renderer as a
  // reason plus the command that fixes it rather than as a rejected invoke.
  handle("ci-status", (_event: IpcMainInvokeEvent, projectPath: string) => ciStatus(projectPath))
  handle(
    "ci-runs-list",
    (_event: IpcMainInvokeEvent, projectPath: string, options?: { branch?: string; limit?: number }) =>
      listCiRuns(projectPath, options),
  )
  handle("ci-failure-view", (_event: IpcMainInvokeEvent, projectPath: string, runId: number) =>
    viewCiFailure(projectPath, runId),
  )
  handle("ci-repair-prepare", (_event: IpcMainInvokeEvent, projectPath: string, runId: number) =>
    prepareCiRepair(projectPath, runId),
  )
  handle("spend-limits-get", async () => {
    const ledger = await spendLedger()
    return ledger.policy()
  })
  handle("spend-limits-set", async (_event: IpcMainInvokeEvent, next: Partial<SpendPolicy>) => {
    const ledger = await spendLedger()
    return ledger.setPolicy(next)
  })
  handle("spend-limits-status", async () => {
    const ledger = await spendLedger()
    return ledger.summary()
  })
  handle("spend-limits-recent", async (_event: IpcMainInvokeEvent, limit?: number) => {
    const ledger = await spendLedger()
    return ledger.recentEvents(limit)
  })
  handle("failure-memory-read", (_event: IpcMainInvokeEvent, projectPath: string) => readFailureMemory(projectPath))
  handle("failure-memory-clear", (_event: IpcMainInvokeEvent, projectPath: string) => clearFailureMemory(projectPath))
  handle("publish-targets", () => detectPublishTargets())
  handle("publish-project", (event: IpcMainInvokeEvent, input: PublishProjectInput) =>
    publishProject(input, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("cloud-publish-progress", progress)
    }).then((result) => {
      // A first deployment reaches production whatever was asked.
      recordPublishAttempt(
        input.scopeProjectPath ?? input.projectPath,
        input.production === true || result.environment === "production",
        result,
      )
      return result
    }),
  )
  // Every window's Cloud card refreshes when cloud state changes, whether a
  // Cloud screen, the preview panel or the agent changed it.
  watchCloudChanges(() =>
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) window.webContents.send("cloud-changed")
    }),
  )
  handle("cloud-overview", (_event: IpcMainInvokeEvent, directory: string) =>
    cloudOverview(directory, parallelWorkspaceCloudScopes()),
  )
  handle("github-detect", (_event, options?: { refresh?: boolean }) =>
    detectGithub(options?.refresh === true ? refreshAgentEnvironment() : undefined),
  )
  handle("github-publish", (_event: IpcMainInvokeEvent, input: GithubPublishInput) => publishToGithub(input))
  handle("github-auth-status", () => getAuthStatus())
  handle("github-auth-start", (_event, input?: { workflow?: boolean }) =>
    startDeviceLogin({ workflow: input?.workflow === true }),
  )
  handle("github-auth-open-verification", () => openVerification())
  handle("github-auth-complete", () => completeDeviceLogin())
  handle("github-auth-cancel", () => cancelDeviceLogin())
  handle("github-auth-logout", () => {
    logoutGithub()
    // A clone Vector couldn't clean up may have left the token in its private auth config.
    void sweepGithubCloneSecrets()
  })
  handle("github-repos-list", () => listRepos())
  handle("github-repos-create", (_event: IpcMainInvokeEvent, input: GithubCreateRepoInput) => createRepo(input))
  handle("github-push-oauth", (_event: IpcMainInvokeEvent, input: GithubOauthPushInput) => pushWithOauth(input))
  // Removes auth config that a clone interrupted by a crash or force quit left behind.
  void sweepGithubCloneSecrets()
  handle("github-clone-parent", () => githubCloneParent())
  handle("github-clone-pick-parent", (event: IpcMainInvokeEvent) =>
    pickGithubCloneParent(BrowserWindow.fromWebContents(event.sender) ?? undefined),
  )
  handle("github-clone-parse", (_event: IpcMainInvokeEvent, input: unknown) =>
    parseGithubCloneSource(typeof input === "string" ? input : ""),
  )
  handle("github-clone-start", (event: IpcMainInvokeEvent, input: GithubCloneInput) => {
    const sender = event.sender
    const senderID = sender.id
    // Closing, reloading or crashing the page that started a clone cancels it, which also removes the partial folder.
    // A reload keeps the same WebContents, so "destroyed" alone would leave a run no page can cancel.
    const stop = () => cancelGithubClonesFor(senderID)
    const navigated = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame && !details.isSameDocument) stop()
    }
    sender.once("destroyed", stop)
    sender.on("did-start-navigation", navigated)
    sender.on("render-process-gone", stop)
    return cloneGithubRepository(input, {
      sender: senderID,
      emit: (progress) => {
        if (!sender.isDestroyed()) sender.send("github-clone-progress", progress)
      },
      log: (line) => write("github-clone", line),
    }).finally(() => {
      if (sender.isDestroyed()) return
      sender.removeListener("destroyed", stop)
      sender.removeListener("did-start-navigation", navigated)
      sender.removeListener("render-process-gone", stop)
    })
  })
  handle("github-clone-cancel", (event: IpcMainInvokeEvent, runId: unknown) =>
    cancelGithubClone(event.sender.id, runId),
  )
  handle("gitlab-auth-status", () => getGitlabAuthStatus())
  handle("gitlab-auth-start", () => startGitlabLogin())
  handle("gitlab-auth-open-verification", () => openGitlabVerification())
  handle("gitlab-auth-complete", () => completeGitlabLogin())
  handle("gitlab-auth-cancel", () => cancelGitlabLogin())
  handle("gitlab-auth-logout", () => logoutGitlab())
  handle("gitlab-repos-list", () => listGitlabRepos())
  handle("gitlab-repos-create", (_event: IpcMainInvokeEvent, input: GitlabCreateRepoInput) => createGitlabRepo(input))
  handle("gitlab-push-oauth", (_event: IpcMainInvokeEvent, input: GitlabOauthPushInput) => pushToGitlab(input))
  handle("external-agents-detect", (_event, options?: { refresh?: boolean }) =>
    detectExternalAgents({ refresh: options?.refresh === true }),
  )
  handle("external-agents-models", (_event, id: string, options?: { refresh?: boolean }) =>
    listAgentModels(id, { refresh: options?.refresh === true }),
  )
  handle("external-agents-commands", (_event, id: string) => agentCommands(id))
  handle("external-agents-launch-terminal", (_event, input: TerminalAgentInput) =>
    launchAgentTerminal(input, { chatRunning: runningChatAgents }),
  )
  handle("external-agents-open-editor", (_event: IpcMainInvokeEvent, input: OpenInEditorInput) => openInEditor(input))
  handle("external-agents-prepare-workspace", (_event: IpcMainInvokeEvent, projectPath: string) =>
    prepareWorkspace(projectPath),
  )
  handle("cloud-connections-list", () => listCloudProviderConnections())
  handle("cloud-connections-connect", (_event: IpcMainInvokeEvent, provider: CloudProviderId) =>
    connectCloudProvider(provider),
  )
  handle("cloud-connections-connect-token", (_event: IpcMainInvokeEvent, provider: CloudProviderId, token: string) =>
    connectCloudProviderWithToken(provider, token),
  )
  handle("cloud-connections-disconnect", (_event: IpcMainInvokeEvent, provider: CloudProviderId) =>
    disconnectCloudProvider(provider),
  )
  handle("cloud-provider-resources-list", (_event: IpcMainInvokeEvent, provider: CloudProviderId) =>
    listCloudProviderResources(provider),
  )
  handle("cloud-provider-links-list", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    listCloudProviderProjectLinks(projectPath, taskId),
  )
  // The Vercel controls in Vector Cloud (window.api.cloud.vercel), one
  // channel each; the agent's vector_cloud actions call the same functions.
  for (const [name, listener] of Object.entries(vercelIpc)) {
    const call = listener as (...args: unknown[]) => unknown
    handle(`${VERCEL_IPC_PREFIX}${name}`, (_event: IpcMainInvokeEvent, ...args: unknown[]) => call(...args))
  }

  // Every Supabase control in the console, through the same commands the agent uses.
  handle("cloud-supabase", (event: IpcMainInvokeEvent, command: unknown, input: unknown) =>
    runSupabaseCommand(command, input, {
      caller: "console",
      workspaces: parallelWorkspaceCloudScopes,
      progress: (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("cloud-supabase-progress", progress)
      },
    }),
  )
  handle("cloud-deployments-list", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    listDeployments(projectPath, taskId),
  )
  handle(
    "cloud-deployments-remove",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, id: string) =>
      removeDeployment(projectPath, taskId, id),
  )
  handle(
    "cloud-deployments-check",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, id: string) =>
      checkDeploymentHealth({ projectPath, taskId, id }),
  )
  handle("cloud-deployments-check-all", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    checkAllDeploymentHealth(projectPath, taskId),
  )
  handle(
    "cloud-deployments-rerun-checks",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, id: string) =>
      rerunDeploymentChecks({ projectPath, taskId, id }),
  )
  handle("cloud-env-list", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    listEnv(projectPath, taskId),
  )
  handle(
    "cloud-env-set",
    (
      _event: IpcMainInvokeEvent,
      projectPath: string,
      taskId: string | undefined,
      key: string,
      value: string,
      visibility?: "public" | "server",
    ) =>
      setEnv(
        projectPath,
        taskId,
        key,
        value,
        visibility === "public" || visibility === "server" ? visibility : undefined,
      ),
  )
  handle(
    "cloud-env-remove",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, key: string) =>
      removeEnv(projectPath, taskId, key),
  )
  handle("cloud-env-apply", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    applyEnv(projectPath, taskId),
  )

  handle("cloud-db-get", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    getDatabase(projectPath, taskId),
  )
  handle("cloud-build-get", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    getBuildSettings(projectPath, taskId),
  )
  handle("cloud-build-detect", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    detectBuildSettings(projectPath, taskId),
  )
  handle(
    "cloud-build-set",
    (
      _event: IpcMainInvokeEvent,
      projectPath: string,
      taskId: string | undefined,
      input: Parameters<typeof setBuildSettings>[2],
    ) => setBuildSettings(projectPath, taskId, input),
  )
  handle("background-tasks-list", (_event: IpcMainInvokeEvent, scope?: { projectPath?: string; taskId?: string }) =>
    listBackgroundTasks(scope),
  )
  handle("background-tasks-cancel", (_event: IpcMainInvokeEvent, id: string) => cancelBackgroundTask(id))
  handle(
    "background-tasks-clear-completed",
    (_event: IpcMainInvokeEvent, scope?: { projectPath?: string; taskId?: string }) =>
      clearCompletedBackgroundTasks(scope),
  )
  handle("export-debug-logs", () => deps.exportDebugLogs())
  handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  // The renderer reaches only its own .dat stores. vector.settings (which holds the remembered clone folder) and the
  // encrypted sign-in stores belong to the main process.
  handle("server-credential-get", (_event: IpcMainInvokeEvent, url: string) => {
    try {
      return readServerCredential(url) ?? null
    } catch {
      return null
    }
  })
  handle("server-credential-set", (_event: IpcMainInvokeEvent, url: string, credential: ServerCredential) =>
    saveServerCredential(url, credential),
  )
  handle("server-credential-delete", (_event: IpcMainInvokeEvent, url: string) => deleteServerCredential(url))
  handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    if (!isRendererStoreName(name)) return null
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(requireRendererStore(name)).set(key, value)
  })
  handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(requireRendererStore(name)).delete(key)
    void removeStoreFileIfEmpty(name)
  })
  handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(requireRendererStore(name)).clear()
    void removeStoreFileIfEmpty(name)
  })
  handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(requireRendererStore(name))
    return Object.keys(store.store)
  })
  handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(requireRendererStore(name))
    return Object.keys(store.store).length
  })
  handle("voice-speak", (event: IpcMainInvokeEvent, text: string) => {
    const ownerID = event.sender.id
    if (!voiceOwners.has(ownerID)) {
      voiceOwners.add(ownerID)
      event.sender.once("destroyed", () => {
        voiceOwners.delete(ownerID)
        stopVoiceSynthesis(ownerID)
      })
    }
    return speakVoiceText(ownerID, text)
  })
  handle("voice-stop", (event: IpcMainInvokeEvent) => stopVoiceSynthesis(event.sender.id))

  handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  handle("save-file-picker", async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
    const result = await dialog.showSaveDialog({
      title: opts?.title ?? "Save file",
      defaultPath: opts?.defaultPath,
    })
    if (result.canceled) return null
    return result.filePath ?? null
  })

  on("open-link", (_event: IpcMainEvent, url: string) => {
    const external = safeExternalUrl(url)
    if (!external) throw new Error("Vector blocked an unsafe external link.")
    void shell.openExternal(external)
  })

  handle("open-path", async (_event: IpcMainInvokeEvent, path: string, value?: unknown) => {
    // Checked and opened by its real path, so a link named like a folder cannot point at an application.
    const real = typeof path === "string" ? await realpath(path).catch(() => undefined) : undefined
    const target = requireOpenPathDirectory(real, {
      directory: Boolean(real && (await stat(real).catch(() => undefined))?.isDirectory()),
      bundle:
        real !== undefined &&
        isLaunchableBundle(
          real,
          await stat(join(real, "Contents", "Info.plist")).then(
            () => true,
            () => false,
          ),
        ),
    })
    const application = requireOpenPathApplication(value)
    if (!application) return shell.openPath(target)
    const configured = openPathApplicationCommand(application, process.platform)
    if (!configured) throw new Error(`Vector cannot open paths in ${application} on this platform.`)
    const resolved = process.platform === "win32" ? await deps.resolveAppPath(configured) : undefined
    const executable = openPathCommand(application, process.platform, resolved)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin"
          ? (["open", ["-a", executable, target]] as const)
          : ([executable, openPathArguments(application, process.platform, target)] as const)
      execFile(cmd, args, { env: untrustedChildEnvironment() }, (err) => (err ? reject(err) : resolve()))
    })
  })

  handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title: title.slice(0, 120), body: body?.slice(0, 500) }).show()
  })

  handle("get-microphone-permission", () => {
    if (process.platform !== "darwin" && process.platform !== "win32") return "unknown"
    return systemPreferences.getMediaAccessStatus("microphone")
  })

  handle("request-microphone-permission", async () => {
    if (process.platform === "darwin") {
      const current = systemPreferences.getMediaAccessStatus("microphone")
      if (current === "not-determined") await systemPreferences.askForMediaAccess("microphone")
      return systemPreferences.getMediaAccessStatus("microphone")
    }
    if (process.platform === "win32") return systemPreferences.getMediaAccessStatus("microphone")
    return "unknown"
  })

  // Main windows only: a hidden helper window, such as the research browsers' host, is not one the user has open.
  handle("get-window-count", () => getMainWindowCount())

  handle("get-window-id", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return id
  })

  handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  on("relaunch", () => {
    deps.relaunch()
  })

  handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  handle("get-usage-sharing", () => deps.getUsageSharing())
  handle("set-usage-sharing", (_event: IpcMainInvokeEvent, enabled: boolean) => deps.setUsageSharing(enabled === true))
  handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}

function requireRendererStore(name: unknown) {
  if (!isRendererStoreName(name)) throw new Error("Vector rejected access to a private settings store.")
  return name
}

function safeExternalUrl(value: string) {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) return
  return url.toString()
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
