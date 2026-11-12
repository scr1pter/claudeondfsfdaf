export * as ConnectMembers from "./members"

import { Option, Schema } from "effect"
import { Connect } from "@vectordevai/schema/connect"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"

// The workspace members as people see them: what each one is, whether it can work right now, and how to reach it.
// The hub gathers the sources (its adapters, the agents, the skills, the saved workflows, MCP status, the tool ids
// in the HTTP view, and a few facts about this directory) and this file turns them into one list. Nothing here keeps
// a copy, calls a model or reaches the network. Members that already have a tool are listed with that tool as their
// way in; only members with no tool take hand-offs through connect (VectorScope, through its adapter).

type MemberInput = Connect.Member

/** One agent as the registry reads it. */
export interface AgentSource {
  readonly name: string
  readonly description?: string
  readonly mode: "subagent" | "primary" | "all"
  readonly native?: boolean
  readonly hidden?: boolean
}

export interface WorkflowSource {
  readonly name: string
  readonly title: string
  readonly description?: string
  readonly issues?: readonly { readonly message: string }[]
}

/** An MCP server's inventory snapshot; reading it never starts a configured server. */
export type McpSource =
  | { readonly status: "connected" }
  | { readonly status: "disabled" }
  | { readonly status: "needs_auth" }
  | { readonly status: "uninitialized" }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "needs_client_registration"; readonly error: string }

export interface Sources {
  /** What each adapter's `describe()` returned. They come first, so an adapter's member wins over any other source. */
  readonly adapters: readonly Connect.Member[]
  readonly agents: readonly AgentSource[]
  readonly skills: readonly { readonly name: string; readonly description?: string }[]
  readonly workflows: readonly WorkflowSource[]
  readonly mcp: Readonly<Record<string, McpSource>>
  /** MCP servers whose config says `type: "remote"`: their code runs on another host, not on this computer. */
  readonly remoteMcp?: ReadonlySet<string>
  /** `ToolRegistry.ids()`, in the HTTP view only. Without it, members reached through a tool are left out. */
  readonly tools?: readonly string[]
  /** Whether this repository has the GitHub agent's workflow file. */
  readonly githubAgent?: boolean
  /** Desktop work going now for a session, from DesktopTasks. */
  readonly desktop?: { readonly workspaces: number; readonly swarm: number }
  /** Vector Local is on. */
  readonly local: boolean
}

/** Hidden helper sessions Vector already names (core session/helper.ts), with how each is reached. */
export const HELPERS = {
  vectorscope: undefined,
  research: {
    id: "research",
    kind: "helper",
    title: "Research",
    summary:
      "Researches a question on the web and in this repository's brain, and writes a report with its sources. The agent reaches it with its research tool.",
    reach: "research",
  },
  "browser-agent": undefined,
  codespace: {
    id: "codespace",
    kind: "helper",
    title: "Codespace",
    summary: "Inline edits and autocomplete in the desktop editor.",
    reach: "ui",
  },
  swarm: {
    id: "swarm",
    kind: "runtime",
    title: "Swarm runs",
    summary: "Desktop swarm runs: a planner splits the work across workers that merge into a staging branch.",
    reach: "ui",
  },
  brain: {
    id: "brain",
    kind: "helper",
    title: "Brain",
    summary: "Keeps this repository's requirements, decisions and notes. Its helpers run in the background.",
    reach: "none",
  },
  help: {
    id: "help",
    kind: "helper",
    title: "Help",
    summary: "Answers questions about Vector itself in the app.",
    reach: "ui",
  },
} as const satisfies Record<string, Pick<MemberInput, "id" | "kind" | "title" | "summary" | "reach"> | undefined>
// `vectorscope` is listed by its adapter, `browser-agent` as the browser tool below.

/**
 * Tools listed under their own member, so the plain tool list does not repeat them, and connect's own tool, which is
 * how members are reached rather than a member.
 */
const NAMED_TOOLS = new Set(["research", "browser", "computer", "vector_cloud", "task", "workflow", "skill", "connect"])

const decode = Schema.decodeUnknownOption(Connect.Member)

/**
 * The list, in a fixed order: adapters, the agents, the helpers, the desktop's own work, the members reached through
 * a tool, skills, saved workflows and MCP servers. With Vector Local on, a member that is otherwise ready but runs in
 * a cloud or sends code past this computer and the listed model servers reads "off"; an MCP server keeps MCP's own
 * status, because MCP applies Vector Local to its servers itself. Each id appears once (the first source wins), and a
 * member the schema does not accept is left out.
 */
export function compose(sources: Sources): Connect.Member[] {
  const candidates: MemberInput[] = [
    ...sources.adapters,
    ...sources.agents.filter((agent) => !agent.hidden).map(agentMember),
    ...helperMembers(sources),
    ...desktopMembers(sources),
    ...toolMembers(sources),
    ...sources.skills.map(skillMember),
    ...sources.workflows.map(workflowMember),
    ...Object.entries(sources.mcp).map(([name, status]) =>
      mcpMember(name, status, sources.remoteMcp?.has(name) === true),
    ),
    githubAgentMember(sources.githubAgent === true),
  ]
  const seen = new Set<string>()
  return candidates.flatMap((candidate) => {
    if (seen.has(candidate.id)) return []
    seen.add(candidate.id)
    const gated = candidate.kind === "mcp" ? candidate : gate(candidate, sources.local)
    return Option.match(decode(gated), { onNone: () => [], onSome: (member) => [member] })
  })
}

/** Applies Vector Local to a member that is otherwise ready. */
export function gate(member: MemberInput, local: boolean): MemberInput {
  if (member.state !== "ready") return member
  const gated = ConnectPolicy.localGate({ local, place: member.place, sendsTo: member.sendsTo })
  return gated.state === "ready" ? member : { ...member, state: "off", reason: gated.reason }
}

function agentMember(agent: AgentSource): MemberInput {
  return {
    id: `agent:${agent.name}`,
    kind: "agent",
    title: words(agent.name, 120),
    summary: clip(agent.description ?? "", 500),
    owner: agent.native ? "main" : "user",
    place: "local",
    state: "ready",
    // A primary agent is one a person picks; a subagent is launched with the task tool.
    reach: agent.mode === "primary" ? "ui" : "task",
  }
}

function helperMembers(sources: Sources): MemberInput[] {
  return Object.values(HELPERS).flatMap((helper) =>
    helper
      ? [
          {
            ...helper,
            owner: "main" as const,
            place: "local" as const,
            state: "ready" as const,
            ...(helper.id === "swarm" && sources.desktop ? { activity: { running: sources.desktop.swarm } } : {}),
          },
        ]
      : [],
  )
}

function desktopMembers(sources: Sources): MemberInput[] {
  return [
    {
      id: "parallel-workspaces",
      kind: "runtime",
      title: "Parallel Workspaces",
      summary: "Desktop workspaces where agents work side by side on their own branches.",
      owner: "main",
      place: "local",
      state: "ready",
      reach: "ui",
      ...(sources.desktop ? { activity: { running: sources.desktop.workspaces } } : {}),
    },
  ]
}

function toolMembers(sources: Sources): MemberInput[] {
  const tools = sources.tools
  if (!tools) return []
  const has = new Set(tools)
  const offered = (id: string, reason: string) =>
    has.has(id) ? { state: "ready" as const } : { state: "unavailable" as const, reason }
  return [
    {
      id: "tasks",
      kind: "tool",
      title: "Subagents and background tasks",
      summary: "The agent hands pieces of work to subagents, in the background or in an isolated worktree.",
      owner: "main",
      place: "local",
      reach: "task",
      ...offered("task", "The task tool is not offered here."),
    },
    {
      id: "browser",
      kind: "tool",
      title: "Browser",
      summary: "The agent opens and checks web pages in the desktop app's browser.",
      owner: "main",
      place: "local",
      reach: "browser",
      ...offered("browser", "The browser works in the Vector desktop app."),
    },
    has.has("computer")
      ? {
          id: "computer",
          kind: "tool",
          title: "Vector Hands",
          summary: "The agent uses apps on this computer, with your approval.",
          owner: "hands",
          place: "local",
          reach: "computer",
          state: "ready",
        }
      : {
          id: "computer",
          kind: "tool",
          title: "Vector Hands",
          summary: "The agent uses apps on this computer, with your approval.",
          owner: "hands",
          place: "local",
          reach: "none",
          state: "not-installed",
          reason: "Not in this build.",
        },
    {
      id: "vector-cloud",
      kind: "service",
      title: "Vector Cloud",
      summary: "Deploys and publishes your project on Vector's servers.",
      owner: "main",
      place: "vector-cloud",
      reach: "vector_cloud",
      ...offered("vector_cloud", "Vector Cloud works in the Vector desktop app."),
    },
    ...tools
      .filter((id) => !NAMED_TOOLS.has(id) && /^[A-Za-z0-9_.:-]{1,128}$/.test(id))
      .map(
        (id): MemberInput => ({
          id: `tool:${id}`,
          kind: "tool",
          title: words(id, 120),
          summary: "",
          owner: "main",
          place: "local",
          state: "ready",
          reach: id,
        }),
      ),
  ]
}

function skillMember(skill: { readonly name: string; readonly description?: string }): MemberInput {
  return {
    id: `skill:${skill.name}`,
    kind: "skill",
    title: words(skill.name, 120),
    summary: clip(skill.description ?? "", 500),
    owner: "user",
    place: "local",
    state: "ready",
    reach: "skill",
  }
}

function workflowMember(workflow: WorkflowSource): MemberInput {
  const issue = workflow.issues?.[0]
  return {
    id: `workflow:${workflow.name}`,
    kind: "workflow",
    title: words(workflow.title || workflow.name, 120),
    summary: clip(workflow.description ?? "", 500),
    owner: "user",
    place: "local",
    reach: "workflow",
    ...(issue
      ? { state: "unavailable" as const, reason: words(`This workflow has errors: ${issue.message}`, 500) }
      : { state: "ready" as const }),
  }
}

function mcpMember(name: string, source: McpSource, remote: boolean): MemberInput {
  const base = {
    id: `mcp:${name}`,
    kind: "mcp" as const,
    title: words(name, 120),
    summary: remote
      ? "An MCP server you configured that runs on another host. The agent reaches it through the tools it offers."
      : "An MCP server you configured. The agent reaches it through the tools it offers.",
    owner: "user" as const,
    // A remote server's code runs on a host the user has an account with, never on this computer.
    place: remote ? ("your-cloud" as const) : ("local" as const),
    reach: `mcp:${name.replace(/[^A-Za-z0-9_.:-]/g, "-")}`.slice(0, 128),
  }
  if (source.status === "connected") return { ...base, state: "ready" }
  if (source.status === "disabled") return { ...base, state: "off", reason: "Turned off in your MCP settings." }
  if (source.status === "uninitialized")
    return { ...base, state: "unavailable", reason: "Configured, but it has not connected in this workspace." }
  if (source.status === "needs_auth")
    return { ...base, state: "unavailable", reason: words(`Needs you to sign in: vector mcp auth ${name}`, 500) }
  // MCP refuses a server Vector Local does not allow with this reason, so it reads as off.
  if (source.error.startsWith("Off in Vector Local")) return { ...base, state: "off", reason: words(source.error, 500) }
  return { ...base, state: "unavailable", reason: words(source.error || "It could not connect.", 500) }
}

function githubAgentMember(installed: boolean): MemberInput {
  const base = {
    id: "github-agent",
    kind: "agent" as const,
    title: "@vector on GitHub",
    summary: "Answers @vector on pull requests from your own GitHub Actions. Connect never posts to GitHub.",
    owner: "vector-at-mention" as const,
    place: "your-cloud" as const,
    reach: "none" as const,
  }
  return installed
    ? { ...base, state: "ready" }
    : { ...base, state: "not-installed", reason: "Not set up in this repository (.github/workflows/vector.yml)." }
}

function clip(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, max - 1) + "…"
}

/** Text for a field that may not be empty. */
function words(value: string, max: number) {
  return clip(value.trim() || "Unnamed", max)
}
