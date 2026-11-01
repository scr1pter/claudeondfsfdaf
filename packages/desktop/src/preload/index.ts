import { contextBridge, ipcRenderer, webUtils } from "electron"
import type { ElectronAPI, WslServersEvent } from "./types"
import { vercelPreloadApi } from "./cloud-vercel"
import type { UpdaterState } from "@vectordevai/app/updater"

const updaterCallbacks = new Set<(state: UpdaterState) => void>()
let updaterState: UpdaterState | undefined
let updaterSubscription: Promise<void> | undefined
const updaterHandler = (_: unknown, state: UpdaterState) => {
  updaterState = state
  updaterCallbacks.forEach((callback) => callback(state))
}

let taskBoardSubscribers = 0
let researchWatchers = 0
const api: ElectronAPI = {
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
  wslServers: {
    getState: () => ipcRenderer.invoke("wsl-servers-get-state"),
    subscribe: (cb) => {
      const handler = (_: unknown, event: WslServersEvent) => cb(event)
      ipcRenderer.on("wsl-servers-event", handler)
      void ipcRenderer.invoke("wsl-servers-subscribe")
      return () => {
        ipcRenderer.removeListener("wsl-servers-event", handler)
        void ipcRenderer.invoke("wsl-servers-unsubscribe")
      }
    },
    probeRuntime: () => ipcRenderer.invoke("wsl-servers-probe-runtime"),
    refreshDistros: () => ipcRenderer.invoke("wsl-servers-refresh-distros"),
    installWsl: () => ipcRenderer.invoke("wsl-servers-install-wsl"),
    installDistro: (name) => ipcRenderer.invoke("wsl-servers-install-distro", name),
    probeAddable: (distros) => ipcRenderer.invoke("wsl-servers-probe-addable", distros),
    installVector: (name) => ipcRenderer.invoke("wsl-servers-install-vector", name),
    openTerminal: (name) => ipcRenderer.invoke("wsl-servers-open-terminal", name),
    addServer: (distro) => ipcRenderer.invoke("wsl-servers-add", distro),
    removeServer: (id) => ipcRenderer.invoke("wsl-servers-remove", id),
    startServer: (id) => ipcRenderer.invoke("wsl-servers-start", id),
  },
  updater: {
    subscribe: async (cb) => {
      updaterCallbacks.add(cb)
      if (updaterState) cb(updaterState)
      if (!updaterSubscription) {
        ipcRenderer.on("updater-state", updaterHandler)
        updaterSubscription = ipcRenderer.invoke("updater-subscribe")
      }
      await updaterSubscription
      return () => {
        updaterCallbacks.delete(cb)
        if (updaterCallbacks.size > 0) return
        ipcRenderer.removeListener("updater-state", updaterHandler)
        updaterSubscription = undefined
        void ipcRenderer.invoke("updater-unsubscribe")
      }
    },
    check: () => ipcRenderer.invoke("updater-check"),
    install: () => ipcRenderer.invoke("updater-install"),
  },
  reportBug: (input) => ipcRenderer.invoke("report-bug", input),
  askHelpAssistant: (input) => ipcRenderer.invoke("help-assistant-ask", input),
  agentTeams: {
    list: (scope) => ipcRenderer.invoke("agent-teams-list", scope),
    get: (id) => ipcRenderer.invoke("agent-teams-get", id),
    create: (input) => ipcRenderer.invoke("agent-teams-create", input),
    addMember: (teamId, workspaceId) => ipcRenderer.invoke("agent-teams-add-member", teamId, workspaceId),
    removeMember: (teamId, workspaceId) => ipcRenderer.invoke("agent-teams-remove-member", teamId, workspaceId),
    post: (input) => ipcRenderer.invoke("agent-teams-post", input),
    claim: (teamId, workspaceId) => ipcRenderer.invoke("agent-teams-claim", teamId, workspaceId),
    delete: (teamId) => ipcRenderer.invoke("agent-teams-delete", teamId),
    getGraph: (teamId) => ipcRenderer.invoke("agent-teams-get-graph", teamId),
    setGraph: (teamId, graph) => ipcRenderer.invoke("agent-teams-set-graph", teamId, graph),
  },
  convertHeic: (bytes) => ipcRenderer.invoke("convert-heic", bytes),
  runtime: {
    ensure: (name) => ipcRenderer.invoke("runtime-ensure", name),
    preparePluginCommand: (command) => ipcRenderer.invoke("runtime-prepare-plugin-command", command),
  },
  vectorLocal: {
    status: () => ipcRenderer.invoke("vector-local-status"),
  },
  localMemory: {
    read: () => ipcRenderer.invoke("local-memory-read"),
    write: (content) => ipcRenderer.invoke("local-memory-write", content),
    clear: () => ipcRenderer.invoke("local-memory-clear"),
  },
  repoRules: {
    list: (repositoryPath) => ipcRenderer.invoke("repo-rules-list", repositoryPath),
    save: (input) => ipcRenderer.invoke("repo-rules-save", input),
    remove: (id) => ipcRenderer.invoke("repo-rules-delete", id),
  },
  pullRequests: {
    status: () => ipcRenderer.invoke("pr-access-status"),
    list: (cwd, options) => ipcRenderer.invoke("pr-list", cwd, options),
    view: (cwd, number) => ipcRenderer.invoke("pr-view", cwd, number),
    diff: (cwd, number, head) => ipcRenderer.invoke("pr-diff", cwd, number, head),
    checks: (cwd, number, head) => ipcRenderer.invoke("pr-checks", cwd, number, head),
    create: (input) => ipcRenderer.invoke("pr-create", input),
    review: (input) => ipcRenderer.invoke("pr-review", input),
    merge: (input) => ipcRenderer.invoke("pr-merge", input),
    autoReview: {
      status: (cwd) => ipcRenderer.invoke("pr-auto-review-status", cwd),
      preview: (input) => ipcRenderer.invoke("pr-auto-review-preview", input),
      setup: (input) => ipcRenderer.invoke("pr-auto-review-setup", input),
    },
  },
  ci: {
    status: (projectPath) => ipcRenderer.invoke("ci-status", projectPath),
    runs: (projectPath, options) => ipcRenderer.invoke("ci-runs-list", projectPath, options),
    failure: (projectPath, runId) => ipcRenderer.invoke("ci-failure-view", projectPath, runId),
    repair: (projectPath, runId) => ipcRenderer.invoke("ci-repair-prepare", projectPath, runId),
  },
  spendLimits: {
    limits: () => ipcRenderer.invoke("spend-limits-get"),
    setLimits: (next) => ipcRenderer.invoke("spend-limits-set", next),
    status: () => ipcRenderer.invoke("spend-limits-status"),
    recent: (limit) => ipcRenderer.invoke("spend-limits-recent", limit),
  },
  failureMemory: {
    read: (projectPath) => ipcRenderer.invoke("failure-memory-read", projectPath),
    clear: (projectPath) => ipcRenderer.invoke("failure-memory-clear", projectPath),
  },
  consumeInitialDeepLinks: () => ipcRenderer.invoke("consume-initial-deep-links"),
  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),
  getDisplayBackend: () => ipcRenderer.invoke("get-display-backend"),
  setDisplayBackend: (backend) => ipcRenderer.invoke("set-display-backend", backend),
  parseMarkdownCommand: (markdown) => ipcRenderer.invoke("parse-markdown", markdown),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  pathExists: (path) => ipcRenderer.invoke("path-exists", path),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),
  voice: {
    speak: (text) => ipcRenderer.invoke("voice-speak", text),
    stop: () => ipcRenderer.invoke("voice-stop"),
  },

  getWindowCount: () => ipcRenderer.invoke("get-window-count"),
  getWindowID: () => ipcRenderer.invoke("get-window-id"),
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  readPickedFile: (token, path) => ipcRenderer.invoke("read-picked-file", token, path),
  releasePickedFiles: (token) => ipcRenderer.invoke("release-picked-files", token),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  openLink: (url) => ipcRenderer.send("open-link", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  showNotification: (title, body) => ipcRenderer.send("show-notification", title, body),
  getMicrophonePermission: () => ipcRenderer.invoke("get-microphone-permission"),
  requestMicrophonePermission: () => ipcRenderer.invoke("request-microphone-permission"),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  getUsageSharing: () => ipcRenderer.invoke("get-usage-sharing"),
  setUsageSharing: (enabled) => ipcRenderer.invoke("set-usage-sharing", enabled),
  getPinchZoomEnabled: () => ipcRenderer.invoke("get-pinch-zoom-enabled"),
  setPinchZoomEnabled: (enabled) => ipcRenderer.invoke("set-pinch-zoom-enabled", enabled),
  onPinchZoomEnabledChanged: (cb) => {
    const handler = (_: unknown, enabled: boolean) => cb(enabled)
    ipcRenderer.on("pinch-zoom-enabled-changed", handler)
    return () => ipcRenderer.removeListener("pinch-zoom-enabled-changed", handler)
  },
  onZoomFactorChanged: (cb) => {
    const handler = (_: unknown, factor: number) => cb(factor)
    ipcRenderer.on("zoom-factor-changed", handler)
    return () => ipcRenderer.removeListener("zoom-factor-changed", handler)
  },
  setTitlebar: (theme) => ipcRenderer.invoke("set-titlebar", theme),
  runDesktopMenuAction: (action) => ipcRenderer.invoke("run-desktop-menu-action", action),
  setBackgroundColor: (color: string) => ipcRenderer.invoke("set-background-color", color),
  runBrowserAgent: (input) => ipcRenderer.invoke("browser-agent-command", input),
  prepareAgentTask: (root, task) => ipcRenderer.invoke("agent-task-prepare", root, task),
  onBrowserAgentPageEvent: (cb) => {
    const handler = (_: unknown, event: Parameters<typeof cb>[0]) => cb(event)
    ipcRenderer.on("browser-agent-page-event", handler)
    return () => ipcRenderer.removeListener("browser-agent-page-event", handler)
  },
  parallelWorkspaces: {
    list: (scope) => ipcRenderer.invoke("parallel-workspaces-list", scope),
    create: (input) => ipcRenderer.invoke("parallel-workspaces-create", input),
    refresh: (id) => ipcRenderer.invoke("parallel-workspaces-refresh", id),
    run: (id, concurrency) => ipcRenderer.invoke("parallel-workspaces-run", id, concurrency),
    followUp: (id, text) => ipcRenderer.invoke("parallel-workspaces-follow-up", id, text),
    repair: (id) => ipcRenderer.invoke("parallel-workspaces-repair", id),
    setRuntimeModel: (id, model) => ipcRenderer.invoke("parallel-workspaces-set-runtime-model", id, model),
    stop: (id) => ipcRenderer.invoke("parallel-workspaces-stop", id),
    merge: (id, force, commit) => ipcRenderer.invoke("parallel-workspaces-merge", id, force, commit),
    mainDiff: (sourcePath) => ipcRenderer.invoke("parallel-workspaces-main-diff", sourcePath),
    pullRequest: (id) => ipcRenderer.invoke("parallel-workspaces-pull-request", id),
    mergeSelection: (id, selection, force) =>
      ipcRenderer.invoke("parallel-workspaces-merge-selection", id, selection, force),
    discard: (id) => ipcRenderer.invoke("parallel-workspaces-discard", id),
    remove: (id) => ipcRenderer.invoke("parallel-workspaces-remove", id),
  },
  researchWatch: {
    list: () => ipcRenderer.invoke("research-watch-list"),
    snapshot: (id) => ipcRenderer.invoke("research-watch-snapshot", id),
    stop: (id) => ipcRenderer.invoke("research-watch-stop", id),
    onChange: (callback) => {
      if (researchWatchers++ === 0) void ipcRenderer.invoke("research-watch-subscribe")
      ipcRenderer.on("research-watch-changed", callback)
      return () => {
        ipcRenderer.removeListener("research-watch-changed", callback)
        if (--researchWatchers === 0) void ipcRenderer.invoke("research-watch-unsubscribe")
      }
    },
  },
  agentTasks: {
    list: (input) => ipcRenderer.invoke("agent-tasks-list", input),
    inspect: (input) => ipcRenderer.invoke("agent-tasks-inspect", input),
    message: (input) => ipcRenderer.invoke("agent-tasks-message", input),
    stop: (input) => ipcRenderer.invoke("agent-tasks-stop", input),
    onChange: (callback) => {
      if (taskBoardSubscribers++ === 0) void ipcRenderer.invoke("agent-tasks-subscribe")
      ipcRenderer.on("agent-tasks-changed", callback)
      return () => {
        ipcRenderer.removeListener("agent-tasks-changed", callback)
        if (--taskBoardSubscribers === 0) void ipcRenderer.invoke("agent-tasks-unsubscribe")
      }
    },
  },
  swarmOrchestrator: {
    list: (scope) => ipcRenderer.invoke("swarm-runs-list", scope),
    create: (input) => ipcRenderer.invoke("swarm-runs-create", input),
    resume: (id) => ipcRenderer.invoke("swarm-runs-resume", id),
    stop: (id) => ipcRenderer.invoke("swarm-runs-stop", id),
    merge: (id, force) => ipcRenderer.invoke("swarm-runs-merge", id, force),
    mergeSelection: (id, selection, force) => ipcRenderer.invoke("swarm-runs-merge-selection", id, selection, force),
    discard: (id) => ipcRenderer.invoke("swarm-runs-discard", id),
  },
  backgroundTasks: {
    list: (scope) => ipcRenderer.invoke("background-tasks-list", scope),
    cancel: (id) => ipcRenderer.invoke("background-tasks-cancel", id),
    clearCompleted: (scope) => ipcRenderer.invoke("background-tasks-clear-completed", scope),
  },
  publish: {
    targets: () => ipcRenderer.invoke("publish-targets"),
    run: (input) => ipcRenderer.invoke("publish-project", input),
    subscribe: (cb) => {
      const handler = (_: unknown, event: Parameters<typeof cb>[0]) => cb(event)
      ipcRenderer.on("cloud-publish-progress", handler)
      return () => ipcRenderer.removeListener("cloud-publish-progress", handler)
    },
  },
  cloud: {
    overview: (directory) => ipcRenderer.invoke("cloud-overview", directory),
    onChange: (cb) => {
      const handler = () => cb()
      ipcRenderer.on("cloud-changed", handler)
      return () => ipcRenderer.removeListener("cloud-changed", handler)
    },
    connections: {
      list: () => ipcRenderer.invoke("cloud-connections-list"),
      connect: (provider) => ipcRenderer.invoke("cloud-connections-connect", provider),
      connectWithToken: (provider, token) => ipcRenderer.invoke("cloud-connections-connect-token", provider, token),
      disconnect: (provider) => ipcRenderer.invoke("cloud-connections-disconnect", provider),
    },
    providers: {
      resources: (provider) => ipcRenderer.invoke("cloud-provider-resources-list", provider),
      links: (projectPath, taskId) => ipcRenderer.invoke("cloud-provider-links-list", projectPath, taskId),
    },
    vercel: vercelPreloadApi(ipcRenderer),
    deployments: {
      list: (projectPath, taskId) => ipcRenderer.invoke("cloud-deployments-list", projectPath, taskId),
      remove: (projectPath, taskId, id) => ipcRenderer.invoke("cloud-deployments-remove", projectPath, taskId, id),
      check: (projectPath, taskId, id) => ipcRenderer.invoke("cloud-deployments-check", projectPath, taskId, id),
      checkAll: (projectPath, taskId) => ipcRenderer.invoke("cloud-deployments-check-all", projectPath, taskId),
      rerunChecks: (projectPath, taskId, id) =>
        ipcRenderer.invoke("cloud-deployments-rerun-checks", projectPath, taskId, id),
    },
    env: {
      list: (projectPath, taskId) => ipcRenderer.invoke("cloud-env-list", projectPath, taskId),
      set: (projectPath, taskId, key, value, visibility) =>
        ipcRenderer.invoke("cloud-env-set", projectPath, taskId, key, value, visibility),
      remove: (projectPath, taskId, key) => ipcRenderer.invoke("cloud-env-remove", projectPath, taskId, key),
      apply: (projectPath, taskId) => ipcRenderer.invoke("cloud-env-apply", projectPath, taskId),
    },
    database: {
      get: (projectPath, taskId) => ipcRenderer.invoke("cloud-db-get", projectPath, taskId),
    },
    supabase: {
      run: (command, input) => ipcRenderer.invoke("cloud-supabase", command, input),
      subscribe: (cb) => {
        const handler = (_: unknown, event: Parameters<typeof cb>[0]) => cb(event)
        ipcRenderer.on("cloud-supabase-progress", handler)
        return () => ipcRenderer.removeListener("cloud-supabase-progress", handler)
      },
    },
    build: {
      get: (projectPath, taskId) => ipcRenderer.invoke("cloud-build-get", projectPath, taskId),
      detect: (projectPath, taskId) => ipcRenderer.invoke("cloud-build-detect", projectPath, taskId),
      set: (projectPath, taskId, input) => ipcRenderer.invoke("cloud-build-set", projectPath, taskId, input),
    },
  },
  serverCredentials: {
    get: (url) => ipcRenderer.invoke("server-credential-get", url),
    set: (url, credential) => ipcRenderer.invoke("server-credential-set", url, credential),
    delete: (url) => ipcRenderer.invoke("server-credential-delete", url),
  },
  vectorAccount: {
    status: () => ipcRenderer.invoke("vector-account-status"),
    start: () => ipcRenderer.invoke("vector-account-start"),
    cancel: () => ipcRenderer.invoke("vector-account-cancel"),
    logout: () => ipcRenderer.invoke("vector-account-logout"),
    codium: () => ipcRenderer.invoke("vector-account-codium"),
    offers: () => ipcRenderer.invoke("vector-account-offers"),
    refreshModels: () => ipcRenderer.invoke("vector-account-refresh-models"),
    billing: (request) => ipcRenderer.invoke("vector-account-billing", request),
    confirmDeletion: () => ipcRenderer.invoke("vector-account-confirm-deletion"),
    cancelDeletion: () => ipcRenderer.invoke("vector-account-cancel-deletion"),
    deleteAccount: (email) => ipcRenderer.invoke("vector-account-delete", email),
    onChange: (callback) => {
      const handler = (_event: unknown, status: Parameters<typeof callback>[0]) => callback(status)
      ipcRenderer.on("vector-account-changed", handler)
      return () => ipcRenderer.removeListener("vector-account-changed", handler)
    },
  },
  github: {
    detect: (options) => ipcRenderer.invoke("github-detect", options),
    publish: (input) => ipcRenderer.invoke("github-publish", input),
    auth: {
      status: () => ipcRenderer.invoke("github-auth-status"),
      start: (input) => ipcRenderer.invoke("github-auth-start", input),
      openVerification: () => ipcRenderer.invoke("github-auth-open-verification"),
      complete: () => ipcRenderer.invoke("github-auth-complete"),
      cancel: () => ipcRenderer.invoke("github-auth-cancel"),
      logout: () => ipcRenderer.invoke("github-auth-logout"),
    },
    repos: {
      list: () => ipcRenderer.invoke("github-repos-list"),
      create: (input) => ipcRenderer.invoke("github-repos-create", input),
    },
    pushOauth: (input) => ipcRenderer.invoke("github-push-oauth", input),
    clone: {
      parent: () => ipcRenderer.invoke("github-clone-parent"),
      pickParent: () => ipcRenderer.invoke("github-clone-pick-parent"),
      parse: (input) => ipcRenderer.invoke("github-clone-parse", input),
      start: (input) => ipcRenderer.invoke("github-clone-start", input),
      cancel: (runId) => ipcRenderer.invoke("github-clone-cancel", runId),
      subscribe: (cb) => {
        const handler = (_: unknown, event: Parameters<typeof cb>[0]) => cb(event)
        ipcRenderer.on("github-clone-progress", handler)
        return () => ipcRenderer.removeListener("github-clone-progress", handler)
      },
    },
  },
  gitlab: {
    auth: {
      status: () => ipcRenderer.invoke("gitlab-auth-status"),
      start: () => ipcRenderer.invoke("gitlab-auth-start"),
      openVerification: () => ipcRenderer.invoke("gitlab-auth-open-verification"),
      complete: () => ipcRenderer.invoke("gitlab-auth-complete"),
      cancel: () => ipcRenderer.invoke("gitlab-auth-cancel"),
      logout: () => ipcRenderer.invoke("gitlab-auth-logout"),
    },
    repos: {
      list: () => ipcRenderer.invoke("gitlab-repos-list"),
      create: (input) => ipcRenderer.invoke("gitlab-repos-create", input),
    },
    pushOauth: (input) => ipcRenderer.invoke("gitlab-push-oauth", input),
  },
  scheduledAgents: {
    list: (scope) => ipcRenderer.invoke("scheduled-agents-list", scope),
    create: (input) => ipcRenderer.invoke("scheduled-agents-create", input),
    cancel: (id) => ipcRenderer.invoke("scheduled-agents-cancel", id),
    setPaused: (id, paused) => ipcRenderer.invoke("scheduled-agents-set-paused", id, paused),
    remove: (id) => ipcRenderer.invoke("scheduled-agents-remove", id),
  },
  externalAgents: {
    detect: (options) => ipcRenderer.invoke("external-agents-detect", options),
    models: (id, options) => ipcRenderer.invoke("external-agents-models", id, options),
    commands: (id) => ipcRenderer.invoke("external-agents-commands", id),
    launchTerminal: (input) => ipcRenderer.invoke("external-agents-launch-terminal", input),
    openInEditor: (input) => ipcRenderer.invoke("external-agents-open-editor", input),
    prepareWorkspace: (projectPath) => ipcRenderer.invoke("external-agents-prepare-workspace", projectPath),
  },
  exportDebugLogs: () => ipcRenderer.invoke("export-debug-logs"),
  recordFatalRendererError: (error) => ipcRenderer.invoke("record-fatal-renderer-error", error),
}

contextBridge.exposeInMainWorld("api", api)
