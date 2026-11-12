import type { AgentsWorkflowOptions } from "@vectordevai/core/review/workflow"

export const ACTIONS_COPY = "in your own repo, on your own Actions minutes"
export type AgentListing = { agents: boolean; scheduled: boolean; noSecret: boolean; brain: boolean }
export type AgentBinding = {
  repositoryId: string
  repository?: string
  binder?: { login: string }
  boundAt: number
  lastUsedAt?: number
  workflowVersion: string
  codium: "ready" | "unavailable"
  suspended?: string
}
export type AgentRun = {
  rid: string
  repositoryId: string
  repository?: string
  runUrl?: string
  event: string
  source: string
  purpose: "task" | "review" | "scheduled"
  startedAt: number
  endedAt?: number
  outcome?: string
  verdict?: "pass" | "fail" | "none"
}
export type AgentsStatus = {
  repo?: string
  repositoryId?: string
  defaultBranch?: string
  publicRepository?: boolean
  signedIn: boolean
  canDispatch: boolean
  workflow: "missing" | "old" | "current" | "cli-too-old"
  options?: AgentsWorkflowOptions
  handleAvailable?: string
  listed: AgentListing
  bound: "yours" | "not-yours-or-unknown"
  binding?: AgentBinding
  timeoutMinutes?: number
  url?: string
}
export type AgentSetupInput = {
  cwd: string
  mode: "codium" | "own-key"
  model?: string
  keys?: string[]
  autoReview: boolean
  share?: boolean
}
export type AgentSetupPreview = {
  path: string
  content: string
  secrets: { name: string; detail: string; url?: string }[]
}
export type BrainPreview = {
  id: string
  repositoryId: string
  publicRepository: boolean
  sha256: string
  bytes: number
  entries: number
  skills: number
  text: string
}
export type ReturnedPreview = {
  id: string
  repositoryId: string
  rid: string
  sha256: string
  bytes: number
  text: string
  publicRepository: boolean
}
export type GithubAgentsAPI = {
  status(cwd: string): Promise<AgentsStatus>
  preview(input: AgentSetupInput): Promise<AgentSetupPreview>
  setup(input: AgentSetupInput): Promise<{ url: string }>
  bind(cwd: string): Promise<{ state: "bound" | "pending" | "failed"; runUrl?: string; workflowUpdate?: string }>
  run(input: {
    cwd: string
    prompt: string
    brain?: { previewId: string; approvedSha256: string }
  }): Promise<{ runUrl?: string; dispatchedAt: number }>
  schedules(input: {
    cwd: string
    schedules: NonNullable<AgentsWorkflowOptions["schedules"]>
  }): Promise<{ url: string }>
  bindings(): Promise<AgentBinding[]>
  unbind(repositoryId: string): Promise<void>
  runs(): Promise<AgentRun[]>
  previewBrain(cwd: string): Promise<BrainPreview>
  previewReturned(input: { cwd: string; rid: string; artifactId: string }): Promise<ReturnedPreview>
  returnedArtifacts(input: {
    cwd: string
    rid: string
  }): Promise<{ artifactId: string; name: string; expiresAt?: string }[]>
  importReturned(input: {
    previewId: string
    approvedSha256: string
  }): Promise<{ proposed: number; known: number; refused: number; over: number }>
}

export function agentsApi(): GithubAgentsAPI | undefined {
  return (globalThis.window as unknown as { api?: { githubAgents?: GithubAgentsAPI } } | undefined)?.api?.githubAgents
}

export function agentListing(value?: Partial<AgentListing>): AgentListing {
  const agents = value?.agents === true
  return {
    agents,
    scheduled: agents && value?.scheduled === true,
    noSecret: agents && value?.noSecret === true,
    brain: agents && value?.brain === true,
  }
}

/** Own-key setup stays available independently of Codium's listing or the person's plan. */
export function agentsView(status: AgentsStatus | undefined) {
  if (!status) return { kind: "loading" as const, ownKey: true, codium: false, scheduled: false, noSecret: false }
  const listed = agentListing(status.listed)
  const availability = {
    ownKey: true,
    codium: listed.agents,
    scheduled: status.options?.mode === "own-key" || listed.scheduled,
    noSecret: listed.noSecret,
  }
  if (!status.signedIn) return { ...availability, kind: "sign-in" as const }
  if (status.workflow === "cli-too-old") return { ...availability, kind: "update-cli" as const }
  if (status.workflow === "missing" || status.workflow === "old") return { ...availability, kind: "setup" as const }
  if (status.options?.mode === "codium" && !listed.agents) return { ...availability, kind: "unavailable" as const }
  if (status.options?.mode === "codium" && status.bound !== "yours") return { ...availability, kind: "bind" as const }
  return { ...availability, kind: "ready" as const }
}

export function agentHandle(status: AgentsStatus) {
  return status.handleAvailable ? `@${status.handleAvailable}` : "/vector"
}

export function runMinutes(status: AgentsStatus) {
  return status.timeoutMinutes !== undefined && Number.isSafeInteger(status.timeoutMinutes) && status.timeoutMinutes > 0
    ? `Up to ${status.timeoutMinutes} minutes, from this workflow's timeout.`
    : undefined
}

export function brainApproval(
  preview: BrainPreview | undefined,
  repositoryId: string | undefined,
  approvedSha256: string | undefined,
) {
  return !!preview && preview.repositoryId === repositoryId && preview.sha256 === approvedSha256
}
