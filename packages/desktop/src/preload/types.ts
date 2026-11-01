import type { VectorAccountPlatform } from "@vectordevai/app/vector-account"
import type { DesktopMenuAction } from "@vectordevai/app/desktop-menu"
import type { WslServersPlatform } from "@vectordevai/app/wsl/types"
import type { UpdaterState } from "@vectordevai/app/updater"
import type { PublishProgressEvent, PublishProjectInput, PublishResult, PublishTarget } from "../main/publish"
import type {
  CloudBuildSettings,
  CloudDatabaseConnection,
  CloudDeployment,
  CloudEnvVar,
  CloudEnvVisibility,
} from "../main/cloud-console"
import type {
  CloudProviderConnection,
  CloudProviderId,
  CloudProviderProjectLink,
  CloudProviderResource,
} from "../main/cloud-connections"
import type { Observed, PageRead } from "../main/browser-page"
import type { Chip as ResearchBrowserChip } from "../main/research-browser"
import type { CloudOverview } from "../main/cloud-overview"
import type { SupabaseCommand, SupabaseProgressEvent } from "../main/cloud-supabase"
import type { VercelCloudApi } from "../main/cloud-vercel-ipc"
import type { GithubOauthPushInput, GithubPublishInput, GithubPublishResult, GithubStatus } from "../main/github"
import type {
  GithubAuthStatus,
  GithubCreateRepoInput,
  GithubDeviceLoginResult,
  GithubDeviceLoginStart,
  GithubRepo,
} from "../main/github-auth"
import type {
  GithubCloneInput,
  GithubCloneParent,
  GithubCloneParse,
  GithubCloneProgress,
  GithubCloneResult,
} from "../main/github-clone"
import type { GitlabOauthPushInput, GitlabPublishResult } from "../main/gitlab"
import type {
  GitlabAuthStatus,
  GitlabCreateRepoInput,
  GitlabDeviceLoginResult,
  GitlabDeviceLoginStart,
  GitlabRepo,
} from "../main/gitlab-auth"
import type { CreateScheduledAgentInput, ScheduledAgentRecord } from "../main/scheduled-agents"
import type {
  ExternalAgentStatus,
  OpenInEditorInput,
  OpenInEditorResult,
  PrepareWorkspaceResult,
  TerminalAgentInput,
} from "../main/external-agents"
import type { ExternalAgent } from "@vectordevai/schema/external-agent"
import type { AgentTaskPreparation } from "../main/context-budget"
import type { VoiceSpeechResult } from "../main/voice-synthesis"
import type {
  AutoReviewSetup,
  AutoReviewStatus,
  AutoReviewWorkflow,
  PullRequestAccessStatus,
  PullRequestChecks,
  PullRequestDetail,
  PullRequestReviewComment,
  PullRequestSummary,
} from "../main/github-pr"
import type { LocalMemoryState } from "../main/local-memory"
import type { DesktopLocalStatus } from "../main/local-mode"
import type { RuntimeName, RuntimeStatus } from "../main/runtime-bootstrap"
export type { RuntimeName, RuntimeStatus } from "../main/runtime-bootstrap"
import type { CiFailure, CiRepo, CiRun, CiUnavailable } from "../main/ci-watch"
export type {
  CiFailedStep,
  CiFailure,
  CiFailureKind,
  CiRepo,
  CiRun,
  CiUnavailable,
  CiUnavailableReason,
} from "../main/ci-watch"
import type { SpendEvent, SpendPolicy, SpendSummary } from "../main/spend-limits"
export type {
  SpendDayTotal,
  SpendEvent,
  SpendLimit,
  SpendLimitSet,
  SpendPolicy,
  SpendSource,
  SpendSummary,
  SpendWindowTotal,
} from "../main/spend-limits"
import type { FailureMemory } from "../main/failure-memory"
export type { FailureMemory, FailureRepair, FailureSignatureRecord } from "../main/failure-memory"
import type { AgentTeam, TeamCollaborationGraph, TeamMessage, TeamTopology } from "../main/agent-team-model"
export type { AgentTeam, TeamCollaborationGraph, TeamLink, TeamMessage, TeamTopology } from "../main/agent-team-model"
export type { LocalMemoryState } from "../main/local-memory"
export type { DesktopLocalStatus } from "../main/local-mode"
export type {
  AutoReviewSecret,
  AutoReviewSetup,
  AutoReviewStatus,
  AutoReviewWorkflow,
  PullRequestAccessStatus,
  PullRequestChecks,
  PullRequestDetail,
  PullRequestReviewComment,
  PullRequestSummary,
} from "../main/github-pr"
export type { PublishProgressEvent, PublishProjectInput, PublishResult, PublishTarget } from "../main/publish"
export type {
  CloudBuildSettings,
  CloudDatabaseConnection,
  CloudDeployment,
  CloudDeploymentCheck,
  CloudEnvVar,
  CloudEnvVisibility,
  CloudGitMetadata,
  CloudRequiredChecks,
} from "../main/cloud-console"
export type { VercelCloudApi } from "../main/cloud-vercel-ipc"
export type {
  CloudProviderConnection,
  CloudProviderId,
  CloudProviderProjectLink,
  CloudProviderResource,
} from "../main/cloud-connections"
export type { GithubOauthPushInput, GithubPublishInput, GithubPublishResult, GithubStatus } from "../main/github"
export type {
  GithubAuthStatus,
  GithubCreateRepoInput,
  GithubDeviceLoginResult,
  GithubDeviceLoginStart,
  GithubRepo,
} from "../main/github-auth"
export type {
  GithubCloneErrorKind,
  GithubCloneInput,
  GithubCloneParent,
  GithubCloneParse,
  GithubClonePhase,
  GithubCloneProgress,
  GithubCloneRepo,
  GithubCloneResult,
} from "../main/github-clone"
export type { GitlabOauthPushInput, GitlabPublishResult } from "../main/gitlab"
export type {
  GitlabAuthStatus,
  GitlabCreateRepoInput,
  GitlabDeviceLoginResult,
  GitlabDeviceLoginStart,
  GitlabRepo,
} from "../main/gitlab-auth"
export type {
  ExternalAgentId,
  ExternalAgentStatus,
  OpenInEditorApp,
  OpenInEditorInput,
  OpenInEditorResult,
} from "../main/external-agents"
export type {
  CreateScheduledAgentInput,
  ScheduledAgentEngine,
  ScheduledAgentRecord,
  ScheduledAgentStatus,
} from "../main/scheduled-agents"
export type { AgentTaskPreparation, TaskDifficulty } from "../main/context-budget"
export type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslVectorCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "@vectordevai/app/wsl/types"

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type { OpenPathApplication } from "../main/open-path"

export type WslServersAPI = WslServersPlatform
export type UpdaterAPI = {
  subscribe: (cb: (state: UpdaterState) => void) => Promise<() => void>
  check: () => Promise<UpdaterState>
  install: () => Promise<void>
}

export type AgentTeamsAPI = {
  list: (scope?: { sourcePath?: string; parentSessionId?: string }) => Promise<AgentTeam[]>
  get: (id: string) => Promise<AgentTeam | undefined>
  create: (input: {
    name: string
    topology: TeamTopology
    sourcePath: string
    parentSessionId?: string
    sharedPath?: string
  }) => Promise<AgentTeam>
  addMember: (teamId: string, workspaceId: string) => Promise<AgentTeam | undefined>
  removeMember: (teamId: string, workspaceId: string) => Promise<AgentTeam | undefined>
  // Routing can refuse a message when the collaboration graph does not link the
  // two members, so this reports the outcome rather than a team snapshot.
  post: (input: {
    teamId: string
    fromWorkspaceId: string
    fromName: string
    toWorkspaceId?: string
    text: string
    memberNames?: Record<string, string>
  }) => Promise<
    { ok: true; team?: AgentTeam; recipients: string[] } | { ok: false; reason: string; allowedRecipients: string[] }
  >
  claim: (teamId: string, workspaceId: string) => Promise<TeamMessage[]>
  delete: (teamId: string) => Promise<void>
  // `explicit` distinguishes a graph the user actually configured from the
  // all-to-all default that is synthesised for a team without one — a caller
  // that cannot tell them apart will persist the default over the user's own
  // pairing. Undefined only when the team is gone.
  getGraph: (teamId: string) => Promise<{ explicit: boolean; graph: TeamCollaborationGraph } | undefined>
  // Validation failures come back as errors rather than throwing, so the caller
  // can show which links were rejected instead of losing the edit.
  setGraph: (
    teamId: string,
    graph: TeamCollaborationGraph | undefined,
  ) => Promise<{ ok: true; errors: string[]; team?: AgentTeam } | { ok: false; errors: string[] }>
}

export type RuntimeAPI = {
  ensure: (name: RuntimeName) => Promise<RuntimeStatus>
  preparePluginCommand: (command: string[]) => Promise<{ command: string[]; status?: RuntimeStatus }>
}

/** Vector Local as the app's windows see it: the policy desktop main uses, the first run's hold and the mismatch. */
export type VectorLocalAPI = {
  status: () => Promise<DesktopLocalStatus>
}

export type LocalMemoryAPI = {
  read: () => Promise<LocalMemoryState>
  write: (content: string) => Promise<LocalMemoryState>
  clear: () => Promise<LocalMemoryState>
}

// Hand-mirrored from main/repo-rules-model.ts, the same convention every other
// type crossing this boundary follows.
export type RepoRule = {
  id: string
  description: string
  repositoryPath: string
  filePatterns: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type SaveRepoRuleInput = {
  id?: string
  description: string
  repositoryPath: string
  filePatterns: string[]
  enabled?: boolean
}

export type RepoRulesAPI = {
  list: (repositoryPath?: string) => Promise<RepoRule[]>
  save: (input: SaveRepoRuleInput) => Promise<RepoRule>
  remove: (id: string) => Promise<RepoRule[]>
}

export type PullRequestsAPI = {
  // Whether Vector can act on GitHub: the user's GitHub sign-in, or an existing GitHub CLI login.
  status: () => Promise<PullRequestAccessStatus>
  list: (
    cwd: string,
    options?: { state?: "open" | "closed" | "merged" | "all"; limit?: number },
  ) => Promise<PullRequestSummary[]>
  view: (cwd: string, number: number) => Promise<PullRequestDetail>
  // With the head the panel saw, a diff of a newer commit is refused rather than reviewed under that head's name.
  diff: (cwd: string, number: number, head?: string) => Promise<string>
  // The check runs of that exact commit, with the failing step's log of the first few failed Actions jobs.
  checks: (cwd: string, number: number, head: string) => Promise<PullRequestChecks>
  create: (input: {
    cwd: string
    title: string
    body: string
    base?: string
    draft?: boolean
  }) => Promise<{ url: string }>
  // inline is how many line comments were posted: 0 without head, or when the review fell back to fallbackBody.
  review: (input: {
    cwd: string
    number: number
    // The commit the review ran on. GitHub records it, and the post is refused if the pull request moved since.
    head?: string
    body: string
    event: "comment" | "approve" | "request-changes"
    // Sent only with head. If GitHub refuses any of them, the review is posted once more without line comments,
    // using fallbackBody (or body) as its body.
    comments?: PullRequestReviewComment[]
    fallbackBody?: string
    // The review's sessions, whose recalled memory the posting check compares the text with, and whether the pull
    // request comes from someone Vector cannot trust (its links and images may then point only at GitHub).
    sessionIDs?: string[]
    untrusted?: boolean
  }) => Promise<{ posted: boolean; inline?: number }>
  merge: (input: {
    cwd: string
    number: number
    strategy: "merge" | "squash" | "rebase"
    // The commit the user last saw. GitHub refuses the merge if anything was pushed since.
    head?: string
  }) => Promise<{ merged: boolean }>
  // "Set up automatic reviews": a pull request that adds the workflow `vector github install` writes. model is
  // provider/model and keys are the provider's key variables, which become repository secrets the user adds.
  autoReview: {
    status: (cwd: string) => Promise<AutoReviewStatus>
    // The file the pull request would add, and the secrets it needs. Nothing is sent to GitHub.
    preview: (input: { model: string; keys: string[] }) => Promise<AutoReviewWorkflow>
    setup: (input: { cwd: string; model: string; keys: string[] }) => Promise<AutoReviewSetup>
  }
}

// Nothing here rejects: `gh` missing, `gh` signed out, or a project that is not
// a GitHub repository all arrive as CiUnavailable, which names the reason and
// the one command that fixes it.
export type CiAPI = {
  status: (projectPath: string) => Promise<{ ok: true; repo: CiRepo } | CiUnavailable>
  runs: (
    projectPath: string,
    options?: { branch?: string; limit?: number },
  ) => Promise<{ ok: true; repo: CiRepo; runs: CiRun[] } | CiUnavailable>
  failure: (projectPath: string, runId: number) => Promise<{ ok: true; failure: CiFailure } | CiUnavailable>
  repair: (
    projectPath: string,
    runId: number,
  ) => Promise<{ ok: true; failure: CiFailure; prompt: string } | CiUnavailable>
}

export type SpendLimitsAPI = {
  limits: () => Promise<SpendPolicy>
  // Omitted limit sets keep their stored value, so a settings pane can save the
  // interactive caps without also rewriting the unattended ones.
  setLimits: (next: Partial<SpendPolicy>) => Promise<SpendPolicy>
  // Day and month totals across every repository; no repository has its own.
  status: () => Promise<SpendSummary>
  recent: (limit?: number) => Promise<SpendEvent[]>
}

export type FailureMemoryAPI = {
  read: (projectPath: string) => Promise<FailureMemory>
  clear: (projectPath: string) => Promise<FailureMemory>
}

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
}
export type MicrophonePermissionState = "not-determined" | "granted" | "denied" | "restricted" | "unknown"
export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

export type BrowserAgentPageEvent = {
  contextId: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export type BrowserAgentBounds = { x: number; y: number; width: number; height: number }

export type BrowserAutomationRun = {
  url: string
  finalUrl: string
  status: number
  ok: boolean
  title: string
  description: string
  htmlBytes: number
  links: number
  scripts: number
  stylesheets: number
  checkedAt: string
  error?: string
  viewport: BrowserAgentBounds
  screenshotDataUrl: string
  console: { level: string; message: string; location?: string }[]
  pageErrors: string[]
  networkErrors?: { url: string; status?: number; error?: string; method?: string }[]
  domSummary?: {
    title: string
    description: string
    textSample: string
    links: number
    scripts: number
    stylesheets: number
    htmlBytes: number
    interactives: BrowserAutomationRun["interactives"]
    inputs: BrowserAutomationRun["inputs"]
  }
  /** For an inspectDom with a selector: the element it matches and the name of what a click there would press. */
  target?: { found: boolean; label: string }
  computedStyles?: {
    tag: string
    selector: string
    text: string
    display: string
    visibility: string
    color: string
    backgroundColor: string
    fontSize: string
    rect: { x: number; y: number; width: number; height: number }
  }[]
  pageHtml?: string
  /** For readPage: the page as the research reader reads it. */
  page?: PageRead
  /** For observePage: the page's text and its controls, each with a ref handle clickRef takes. */
  observed?: Observed
  diagnostics?: {
    consoleCount: number
    runtimeErrorCount: number
    networkErrorCount: number
    interactiveCount: number
    inputCount: number
    htmlBytes: number
  }
  actions: { label: string; ok: boolean; error?: string; result?: unknown; at?: string }[]
  interactives: { tag: string; text: string; selector: string; role?: string; type?: string }[]
  inputs: { tag: string; selector: string; placeholder?: string; type?: string; name?: string }[]
  browserStatus?: "stopped" | "launching" | "running"
  currentPage?: string
  tabs?: BrowserAgentTab[]
  activeTab?: string
  /** JavaScript dialogs the page opened since the last report, all answered automatically (dismissed). */
  dialogs?: BrowserAgentDialog[]
  /** readLogs: the active tab's request log, oldest first, at most 200. */
  network?: BrowserAgentRequest[]
  /** inspectPageHtml: the length of the whole document's HTML, of which pageHtml is the start. */
  pageHtmlTotal?: number
  /** Driving commands: how the page settled afterwards. */
  settled?: { navigated: boolean; idle: boolean; waitedMs: number }
}

export type BrowserAgentTab = { id: string; url: string; title: string; active: boolean; loading: boolean }

export type BrowserAgentDialog = {
  type: "alert" | "confirm" | "prompt" | "beforeunload"
  message: string
  url: string
  at: string
}

export type BrowserAgentRequest = {
  method: string
  url: string
  status?: number
  /** Electron's resourceType: mainFrame, subFrame, script, xhr, fetch, image, stylesheet, … */
  type: string
  error?: string
  at: string
  durationMs?: number
}

export type BrowserAgentInput = {
  contextId: string
  command?:
    | "attach"
    | "setBounds"
    | "detach"
    | "closeBrowser"
    | "openUrl"
    | "click"
    | "type"
    | "press"
    | "wait"
    | "waitForSelector"
    | "waitForText"
    | "takeScreenshot"
    | "inspectDom"
    | "inspectComputedStyles"
    | "inspectPageHtml"
    | "reload"
    | "goBack"
    | "goForward"
    | "scroll"
    | "clearLogs"
    | "setVisible"
    | "readPage"
    | "observePage"
    | "clickRef"
    | "typeRef"
    | "selectOption"
    | "hover"
    | "listTabs"
    | "openTab"
    | "switchTab"
    | "closeTab"
    | "readLogs"
  url?: string
  allowExternal?: boolean
  selector?: string
  /**
   * A ref_N handle from observePage, for clickRef, typeRef, selectOption and hover, or for inspectDom to name what a
   * click there would press.
   */
  ref?: string
  text?: string
  key?: string
  milliseconds?: number
  deltaY?: number
  bounds?: BrowserAgentBounds
  visible?: boolean
  /** A tab handle from listTabs (tab_N), for switchTab and closeTab. */
  tabId?: string
  /** selectOption: the option values or visible labels to select. */
  values?: string[]
  /** A driving command runs only while the active tab's page still has this origin: the one the engine checked and asked about. */
  expectOrigin?: string
  /** A click runs only while its target still has this name (clickTargetLabel): the one the engine judged. */
  expectLabel?: string
  /** false: return once the action is sent, without waiting for the page to settle. */
  settle?: boolean
}

export type ParallelWorkspaceStatus =
  | "queued"
  | "planning"
  | "editing"
  | "running commands"
  | "testing"
  | "complete"
  | "failed"
  | "needs review"
  | "stopped"
  | "merged"
  | "discarded"

export type WorkspaceValidationCheck = {
  id: string
  label: string
  command: string
  args: string[]
  reason: string
  status: "passed" | "failed" | "skipped"
  exitCode?: number
  durationMs: number
  output: string
}

export type WorkspaceValidationReport = {
  startedAt: string
  completedAt: string
  passed: boolean
  hadChecks: boolean
  checks: WorkspaceValidationCheck[]
  failureSummary: string
}

// Hand-mirrored from main/parallel-workspace-turns.ts, the same convention the
// record below already follows across this boundary.
export type ParallelWorkspaceTurn = {
  id: string
  role: "user" | "agent" | "vector"
  text: string
  at: string
  state: "running" | "done" | "failed" | "stopped"
  resumed?: boolean
  cost?: string
  streamTail?: string[]
}

export type ParallelWorkspaceRecord = {
  id: string
  revision?: number
  name: string
  taskPrompt: string
  runtime: "vector" | ExternalAgent.ChatId
  provider: string
  model: string
  sourcePath: string
  parentSessionId?: string
  engineParentSessionId?: string
  isolatedPath: string
  isolation: "git-worktree" | "copy"
  gitBranch?: string
  baseCommit?: string
  agentSessionId?: string
  externalSessionId?: string
  /** The external CLI's model flag value for its next turn. Unset runs the CLI's own default. */
  runtimeModel?: string
  /** The last model this workspace's CLI refused, and when (ISO). */
  refusedRuntimeModel?: { model: string; at: string }
  turns?: ParallelWorkspaceTurn[]
  backgroundTaskId?: string
  agent?: string
  swarmRunId?: string
  swarmTaskId?: string
  swarmRole?: "coordinator" | "worker"
  status: ParallelWorkspaceStatus
  progress: number
  lastAction: string
  createdAt: string
  lastActivityAt: string
  changedFilesCount: number
  riskLevel: "low" | "medium" | "high"
  estimatedCost: string
  actualCost?: string
  finalSummary: string
  mergeState: "none" | "merged" | "discarded"
  logs: string[]
  terminalOutput: string[]
  browserResults: string[]
  changedFiles: string[]
  diff: string
  checkpointPath?: string
  pullRequestUrl?: string
  /** The latest Vercel preview of this workspace, at its stable branch address when Vercel assigned one. */
  previewUrl?: string
  baselineHashes?: Record<string, string>
  contextFiles?: string[]
  contextIndexedFiles?: number
  contextTokenEstimate?: number
  contextSummary?: string
  validationReport?: WorkspaceValidationReport
  validationPassed?: boolean
  repairAttempts?: number
  error?: string
}

export type CreateParallelWorkspaceInput = {
  sourcePath: string
  parentSessionId?: string
  engineParentSessionId?: string
  name?: string
  taskPrompt: string
  runtime?: "vector" | ExternalAgent.ChatId
  provider?: string
  model?: string
  runtimeModel?: string
  agent?: string
  swarmRunId?: string
  swarmTaskId?: string
  swarmRole?: "coordinator" | "worker"
}

export type ParallelWorkspaceMergeSelection = {
  hunkIds?: string[]
  files?: string[]
}

export type SwarmRunStatus =
  | "planning"
  | "running"
  | "needs review"
  | "complete"
  | "failed"
  | "canceled"
  | "interrupted"
  | "merged"
  | "discarded"

export type SwarmTaskStatus =
  | "planned"
  | "blocked"
  | "creating"
  | "queued"
  | "running"
  | "merging"
  | "complete"
  | "failed"
  | "canceled"
  | "interrupted"

export type SwarmModelCandidate = {
  provider: string
  model: string
  label?: string
  /** Codium Auto, a model the plan does not include, or one chosen only by name: a swarm never adds these itself. */
  codium?: { locked?: boolean; manualOnly?: boolean; auto?: boolean }
}

export type SwarmTaskRecord = {
  id: string
  title: string
  prompt: string
  role: "explore" | "implement" | "debug" | "test" | "review" | "security" | "docs"
  dependsOn: string[]
  fileHints: string[]
  provider: string
  model: string
  status: SwarmTaskStatus
  workspaceId?: string
  startedAt?: string
  completedAt?: string
  lastAction: string
  changedFilesCount: number
  riskLevel: "low" | "medium" | "high"
  summary: string
  error?: string
}

export type SwarmRunRecord = {
  id: string
  name: string
  objective: string
  sourcePath: string
  parentSessionId?: string
  strategy: "economy" | "balanced" | "quality"
  maxAgents: number
  maxConcurrency: number
  modelPool: SwarmModelCandidate[]
  plannerProvider: string
  plannerModel: string
  plannerSessionId?: string
  coordinatorWorkspaceId?: string
  status: SwarmRunStatus
  currentStep: string
  progress: number
  planSummary: string
  tasks: SwarmTaskRecord[]
  createdAt: string
  updatedAt: string
  completedAt?: string
  changedFiles: string[]
  diff: string
  riskLevel: "low" | "medium" | "high"
  summary: string
  logs: string[]
  error?: string
}

export type CreateSwarmRunInput = {
  sourcePath: string
  parentSessionId?: string
  name?: string
  objective: string
  primaryProvider: string
  primaryModel: string
  modelPool?: SwarmModelCandidate[]
  strategy?: "economy" | "balanced" | "quality"
  maxAgents?: number
  maxConcurrency?: number
}

export type BackgroundTaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "needs_input"
  | "complete"
  | "needs_review"
  | "failed"
  | "canceled"
  | "merged"
  | "discarded"
  | "interrupted"

export type BackgroundTaskRecord = {
  id: string
  kind: "parallel-workspace" | "browser-agent" | "terminal" | "agent" | "checkpoint"
  projectPath?: string
  workspaceId?: string
  workspaceName?: string
  name: string
  prompt: string
  provider: string
  model: string
  status: BackgroundTaskStatus
  progress: number
  currentStep: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  elapsedMs?: number
  changedFilesCount: number
  terminalActive: boolean
  browserActive: boolean
  costEstimate: string
  actualUsage?: string
  errorSummary?: string
  logs: string[]
  actions: {
    id: string
    at: string
    label: string
    status: "pending" | "running" | "success" | "warning" | "failed"
    detail?: string
  }[]
  mergeState?: "none" | "merged" | "discarded"
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  awaitInitialization: () => Promise<ServerReadyData>
  wslServers: WslServersAPI
  updater: UpdaterAPI
  vectorAccount: VectorAccountPlatform
  /** Saved remote-server passwords, sealed with the OS keychain; set resolves false when none is available. */
  serverCredentials: {
    get: (url: string) => Promise<{ username?: string; password: string } | null>
    set: (url: string, credential: { username?: string; password: string }) => Promise<boolean>
    delete: (url: string) => Promise<void>
  }
  reportBug: (input: { message: string; email?: string }) => Promise<{ delivered: boolean; error?: string }>
  askHelpAssistant: (input: {
    messages: { role: "user" | "assistant"; content: string }[]
    context: string
  }) => Promise<{ reply?: string; error?: string }>
  agentTeams: AgentTeamsAPI
  convertHeic: (bytes: Uint8Array) => Promise<{ data: Uint8Array; mime: string } | { error: string }>
  runtime: RuntimeAPI
  vectorLocal: VectorLocalAPI
  localMemory: LocalMemoryAPI
  repoRules: RepoRulesAPI
  pullRequests: PullRequestsAPI
  ci: CiAPI
  spendLimits: SpendLimitsAPI
  failureMemory: FailureMemoryAPI
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  parseMarkdownCommand: (markdown: string) => Promise<string>
  checkAppExists: (application: import("../main/open-path").OpenPathApplication) => Promise<boolean>
  pathExists: (path: string) => Promise<boolean>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>
  voice: {
    speak: (text: string) => Promise<VoiceSpeechResult>
    stop: () => Promise<void>
  }

  getWindowCount: () => Promise<number>
  getWindowID: () => Promise<string>
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    extensions?: string[]
  }) => Promise<{ token: string; files: { path: string; name: string; size: number }[] } | null>
  readPickedFile: (token: string, path: string) => Promise<ArrayBuffer>
  releasePickedFiles: (token: string) => Promise<void>
  getPathForFile: (file: File) => string
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openLink: (url: string) => void
  openPath: (path: string, app?: import("../main/open-path").OpenPathApplication) => Promise<void>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  showNotification: (title: string, body?: string) => void
  getMicrophonePermission: () => Promise<MicrophonePermissionState>
  requestMicrophonePermission: () => Promise<MicrophonePermissionState>
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  getUsageSharing: () => Promise<boolean>
  setUsageSharing: (enabled: boolean) => Promise<void>
  getPinchZoomEnabled: () => Promise<boolean>
  setPinchZoomEnabled: (enabled: boolean) => Promise<void>
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  runBrowserAgent: (input: BrowserAgentInput) => Promise<BrowserAutomationRun>
  prepareAgentTask: (root: string, task: string) => Promise<AgentTaskPreparation>
  onBrowserAgentPageEvent: (cb: (event: BrowserAgentPageEvent) => void) => () => void
  parallelWorkspaces: {
    list: (scope?: { sourcePath?: string; parentSessionId?: string }) => Promise<ParallelWorkspaceRecord[]>
    create: (input: CreateParallelWorkspaceInput) => Promise<ParallelWorkspaceRecord>
    refresh: (id: string) => Promise<ParallelWorkspaceRecord>
    run: (id: string, concurrency?: number) => Promise<ParallelWorkspaceRecord>
    followUp: (id: string, text: string) => Promise<ParallelWorkspaceRecord>
    /** Try a fix: sends the failed check to the user's own coding agent, once. */
    repair: (id: string) => Promise<ParallelWorkspaceRecord>
    /** The external CLI's model from its next turn; undefined goes back to the CLI's default. */
    setRuntimeModel: (id: string, model?: string) => Promise<ParallelWorkspaceRecord>
    stop: (id: string) => Promise<ParallelWorkspaceRecord>
    merge: (id: string, force?: boolean, commit?: { message: string }) => Promise<ParallelWorkspaceRecord>
    mainDiff: (sourcePath: string) => Promise<string>
    pullRequest: (id: string) => Promise<ParallelWorkspaceRecord>
    mergeSelection: (
      id: string,
      selection: ParallelWorkspaceMergeSelection,
      force?: boolean,
    ) => Promise<ParallelWorkspaceRecord>
    discard: (id: string) => Promise<ParallelWorkspaceRecord>
    remove: (id: string) => Promise<ParallelWorkspaceRecord[]>
  }
  agentTasks: {
    list: (input: {
      parentSessionID: string
      sourcePath: string
    }) => Promise<import("@vectordevai/schema/task").ListResult>
    inspect: (input: {
      parentSessionID: string
      sourcePath: string
      taskID: string
    }) => Promise<import("@vectordevai/schema/task").InspectResult>
    message: (input: {
      parentSessionID: string
      sourcePath: string
      taskID: string
      text: string
    }) => Promise<import("@vectordevai/schema/task").MessageResult>
    stop: (input: {
      parentSessionID: string
      sourcePath: string
      taskID: string
    }) => Promise<import("@vectordevai/schema/task").StopResult>
    onChange: (callback: () => void) => () => void
  }
  /**
   * Watching research browsers from the Sources tab: one chip per browser, snapshots of its page (about two a second is
   * what a watcher needs) and Stop. There is no way to send input to one.
   */
  researchWatch: {
    list: () => Promise<ResearchBrowserChip[]>
    snapshot: (id: string) => Promise<string | undefined>
    stop: (id: string) => Promise<boolean>
    onChange: (callback: () => void) => () => void
  }
  swarmOrchestrator: {
    list: (scope?: { sourcePath?: string; parentSessionId?: string }) => Promise<SwarmRunRecord[]>
    create: (input: CreateSwarmRunInput) => Promise<SwarmRunRecord>
    resume: (id: string) => Promise<SwarmRunRecord>
    stop: (id: string) => Promise<SwarmRunRecord>
    merge: (id: string, force?: boolean) => Promise<SwarmRunRecord>
    mergeSelection: (id: string, selection: ParallelWorkspaceMergeSelection, force?: boolean) => Promise<SwarmRunRecord>
    discard: (id: string) => Promise<SwarmRunRecord>
  }
  backgroundTasks: {
    list: (scope?: { projectPath?: string; taskId?: string }) => Promise<BackgroundTaskRecord[]>
    cancel: (id: string) => Promise<BackgroundTaskRecord>
    clearCompleted: (scope?: { projectPath?: string; taskId?: string }) => Promise<BackgroundTaskRecord[]>
  }
  publish: {
    targets: () => Promise<PublishTarget[]>
    run: (input: PublishProjectInput) => Promise<PublishResult>
    subscribe: (cb: (event: PublishProgressEvent) => void) => () => void
  }
  cloud: {
    /** The live summary for the session's Cloud card; `directory` may be an agent workspace. */
    overview: (directory: string) => Promise<CloudOverview>
    /** Fires whenever cloud state changes; returns the unsubscribe. */
    onChange: (cb: () => void) => () => void
    connections: {
      list: () => Promise<CloudProviderConnection[]>
      connect: (provider: CloudProviderId) => Promise<CloudProviderConnection>
      connectWithToken: (provider: CloudProviderId, token: string) => Promise<CloudProviderConnection>
      disconnect: (provider: CloudProviderId) => Promise<{ revoked: boolean; detail: string }>
    }
    providers: {
      resources: (provider: CloudProviderId) => Promise<CloudProviderResource[]>
      links: (projectPath: string, taskId?: string) => Promise<CloudProviderProjectLink[]>
    }
    vercel: VercelCloudApi
    deployments: {
      list: (projectPath: string, taskId?: string) => Promise<CloudDeployment[]>
      remove: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment[]>
      check: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment>
      checkAll: (projectPath: string, taskId?: string) => Promise<CloudDeployment[]>
      rerunChecks: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment>
    }
    env: {
      list: (projectPath: string, taskId?: string) => Promise<CloudEnvVar[]>
      set: (
        projectPath: string,
        taskId: string | undefined,
        key: string,
        value: string,
        visibility?: CloudEnvVisibility,
      ) => Promise<CloudEnvVar[]>
      remove: (projectPath: string, taskId: string | undefined, key: string) => Promise<CloudEnvVar[]>
      apply: (projectPath: string, taskId?: string) => Promise<{ written: string; gitignoreUpdated: boolean }>
    }
    database: {
      get: (projectPath: string, taskId?: string) => Promise<CloudDatabaseConnection>
    }
    supabase: {
      run: (
        command: SupabaseCommand,
        input: Record<string, unknown>,
      ) => Promise<{ ok: boolean; error?: string; needsSetup?: boolean; nextStep?: string } & Record<string, unknown>>
      subscribe: (cb: (event: SupabaseProgressEvent) => void) => () => void
    }
    build: {
      get: (projectPath: string, taskId?: string) => Promise<CloudBuildSettings | null>
      detect: (projectPath: string, taskId?: string) => Promise<CloudBuildSettings>
      set: (
        projectPath: string,
        taskId: string | undefined,
        input: Omit<CloudBuildSettings, "source" | "updatedAt">,
      ) => Promise<CloudBuildSettings>
    }
  }
  github: {
    detect: (options?: { refresh?: boolean }) => Promise<GithubStatus>
    publish: (input: GithubPublishInput) => Promise<GithubPublishResult>
    auth: {
      status: () => Promise<GithubAuthStatus>
      start: (input?: { workflow?: boolean }) => Promise<GithubDeviceLoginStart>
      openVerification: () => Promise<void>
      complete: () => Promise<GithubDeviceLoginResult>
      cancel: () => Promise<void>
      logout: () => Promise<void>
    }
    repos: {
      list: () => Promise<GithubRepo[]>
      create: (input: GithubCreateRepoInput) => Promise<GithubRepo>
    }
    pushOauth: (input: GithubOauthPushInput) => Promise<GithubPublishResult>
    clone: {
      parent: () => Promise<GithubCloneParent>
      pickParent: () => Promise<GithubCloneParent | null>
      parse: (input: string) => Promise<GithubCloneParse>
      start: (input: GithubCloneInput) => Promise<GithubCloneResult>
      cancel: (runId: string) => Promise<void>
      subscribe: (cb: (progress: GithubCloneProgress) => void) => () => void
    }
  }
  gitlab: {
    auth: {
      status: () => Promise<GitlabAuthStatus>
      start: () => Promise<GitlabDeviceLoginStart>
      openVerification: () => Promise<void>
      complete: () => Promise<GitlabDeviceLoginResult>
      cancel: () => Promise<void>
      logout: () => Promise<void>
    }
    repos: {
      list: () => Promise<GitlabRepo[]>
      create: (input: GitlabCreateRepoInput) => Promise<GitlabRepo>
    }
    pushOauth: (input: GitlabOauthPushInput) => Promise<GitlabPublishResult>
  }
  scheduledAgents: {
    list: (scope?: { directory?: string; parentSessionId?: string }) => Promise<ScheduledAgentRecord[]>
    create: (input: CreateScheduledAgentInput) => Promise<ScheduledAgentRecord>
    cancel: (id: string) => Promise<ScheduledAgentRecord | undefined>
    setPaused: (id: string, paused: boolean) => Promise<ScheduledAgentRecord | undefined>
    remove: (id: string) => Promise<ScheduledAgentRecord[]>
  }
  externalAgents: {
    /** `refresh` re-probes the login shell and skips the 60-second detection cache, after an install or sign-in. */
    detect: (options?: { refresh?: boolean }) => Promise<ExternalAgentStatus[]>
    models: (id: string, options?: { refresh?: boolean }) => Promise<ExternalAgent.ModelList>
    /** The official install commands for this platform and the agent's sign-in, ready for the built-in terminal. */
    commands: (id: string) => Promise<ExternalAgent.Commands>
    /** Prepares the isolated workspace and returns the agent's own screen to open in the built-in terminal there. */
    launchTerminal: (input: TerminalAgentInput) => Promise<ExternalAgent.TerminalAgentLaunch>
    openInEditor: (input: OpenInEditorInput) => Promise<OpenInEditorResult>
    prepareWorkspace: (projectPath: string) => Promise<PrepareWorkspaceResult>
  }
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
}
