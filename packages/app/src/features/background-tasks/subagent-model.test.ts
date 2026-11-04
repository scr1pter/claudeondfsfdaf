import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, Session, SessionStatus, ToolPart } from "@vectordevai/sdk/v2"
import {
  agentLabel,
  agentStatus,
  aggregateStatus,
  buildTaskCards,
  childRecord,
  childFacts,
  countAgents,
  elapsedMs,
  formatAgentCount,
  formatDuration,
  formatTokens,
  freshestSession,
  idleLiveSessions,
  isDismissed,
  isInterrupted,
  isolationLabel,
  kindLabel,
  liveAgentCount,
  liveBackgroundSessions,
  locateTaskPart,
  modelEffortLabel,
  modelShortName,
  phaseName,
  queuedLabel,
  readLifecycle,
  resultChip,
  resolveAgent,
  runningAgentCount,
  statusSummary,
  statusWord,
  stripSubagentSuffix,
  subagentKind,
  subagentTitle,
  taskPartLocations,
  waitingAgentCount,
  waitingLabel,
  type TaskSource,
} from "./subagent-model"

const ROOT = "ses_root"

type Fixture = {
  messages: Record<string, Message[]>
  parts: Record<string, Part[]>
  sessions: Record<string, Session>
  status: Record<string, SessionStatus>
  waiting: Set<string>
}

function fixture(): Fixture {
  return { messages: {}, parts: {}, sessions: {}, status: {}, waiting: new Set() }
}

function source(data: Fixture, children?: Session[]): TaskSource {
  return {
    rootID: ROOT,
    messages: (id) => data.messages[id],
    parts: (id) => data.parts[id],
    session: (id) => data.sessions[id],
    children: children ?? Object.values(data.sessions),
    status: (id) => data.status[id],
    waiting: (id) => data.waiting.has(id),
    modelName: (providerID, modelID) =>
      providerID === "anthropic" && modelID === "claude-opus-5" ? "Claude Opus 5" : undefined,
  }
}

function addUser(data: Fixture, id: string, text: string, sessionID = ROOT) {
  const message = { id, sessionID, role: "user", time: { created: 1 } } as unknown as Message
  data.messages[sessionID] = [...(data.messages[sessionID] ?? []), message]
  data.parts[id] = [{ id: `${id}_text`, sessionID, messageID: id, type: "text", text } as Part]
}

function addAssistant(
  data: Fixture,
  id: string,
  parentID: string,
  parts: Part[],
  extra: Partial<AssistantMessage> = {},
  sessionID = ROOT,
) {
  const message = {
    id,
    sessionID,
    role: "assistant",
    parentID,
    time: { created: 10 },
    modelID: "claude-opus-5",
    providerID: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...extra,
  } as AssistantMessage
  data.messages[sessionID] = [...(data.messages[sessionID] ?? []), message]
  data.parts[id] = parts.map((part) => ({ ...part, messageID: id, sessionID }) as Part)
}

function taskPart(input: {
  id: string
  callID?: string
  status?: "pending" | "running" | "completed" | "error"
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  error?: string
  start?: number
  end?: number
}): ToolPart {
  const status = input.status ?? "completed"
  const base = {
    id: input.id,
    sessionID: ROOT,
    messageID: "",
    type: "tool" as const,
    callID: input.callID ?? `call_${input.id}`,
    tool: "task",
  }
  const args = input.input ?? {}
  if (status === "pending") return { ...base, state: { status, input: args, raw: "" } }
  if (status === "running")
    return { ...base, state: { status, input: args, metadata: input.metadata, time: { start: input.start ?? 100 } } }
  if (status === "error")
    return {
      ...base,
      state: {
        status,
        input: args,
        error: input.error ?? "boom",
        metadata: input.metadata,
        time: { start: input.start ?? 100, end: input.end ?? 200 },
      },
    }
  return {
    ...base,
    state: {
      status,
      input: args,
      output: "",
      title: "",
      metadata: input.metadata ?? {},
      time: { start: input.start ?? 100, end: input.end ?? 200 },
    },
  }
}

function child(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    slug: id,
    projectID: "p",
    directory: "/",
    parentID: ROOT,
    title: "Child",
    version: "1",
    time: { created: 50, updated: 60 },
    ...extra,
  }
}

function ownUsage(input: number) {
  return { tokensOwnOnly: true, tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
}

function usage(total: number, toolUses = 3) {
  return {
    cost: 0.1,
    tokens: { input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    total,
    toolUses,
    steps: 2,
  }
}

function lifecycle(extra: Record<string, unknown> = {}) {
  return {
    parentSessionId: ROOT,
    projectId: "p",
    directory: "/",
    model: { providerID: "anthropic", modelID: "claude-opus-5" },
    kind: "specialist",
    agent: "explore",
    custom: false,
    title: "Map the auth flow",
    startedAt: 1_000,
    status: "completed",
    completedAt: 61_000,
    usage: usage(12_000),
    ...extra,
  }
}

// ---------------------------------------------------------------------------

describe("formatting", () => {
  test("tokens read like the reference: 228.6k, 1.23M", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(950)).toBe("950")
    expect(formatTokens(1000)).toBe("1.0k")
    expect(formatTokens(228_600)).toBe("228.6k")
    expect(formatTokens(999_949)).toBe("999.9k")
    expect(formatTokens(999_950)).toBe("1.00M")
    expect(formatTokens(1_234_567)).toBe("1.23M")
  })

  test("unknown tokens show a dash, never undefined or NaN", () => {
    expect(formatTokens(undefined)).toBe("—")
    expect(formatTokens(Number.NaN)).toBe("—")
    expect(formatTokens(-5)).toBe("—")
  })

  test("durations read 42s, 1m 04s, 26m 14s, 1h 04m", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(42_000)).toBe("42s")
    expect(formatDuration(59_999)).toBe("59s")
    expect(formatDuration(60_000)).toBe("1m 00s")
    expect(formatDuration(64_000)).toBe("1m 04s")
    expect(formatDuration(1_574_000)).toBe("26m 14s")
    expect(formatDuration(3_840_000)).toBe("1h 04m")
    expect(formatDuration(-100)).toBe("0s")
    expect(formatDuration(undefined)).toBe("—")
  })

  test("agent counts are singular or plural", () => {
    expect(formatAgentCount(1)).toBe("1 agent")
    expect(formatAgentCount(3)).toBe("3 agents")
  })

  test("elapsed runs to now while live and to the end once finished", () => {
    expect(elapsedMs({ startedAt: 1_000, status: "running" }, 5_000)).toBe(4_000)
    expect(elapsedMs({ startedAt: 1_000, endedAt: 3_000, status: "done" }, 9_000)).toBe(2_000)
    expect(elapsedMs({ startedAt: 1_000, status: "done" }, 9_000)).toBeUndefined()
    expect(elapsedMs({ status: "running" }, 9_000)).toBeUndefined()
  })

  test("model names drop a leading Claude", () => {
    expect(modelShortName("Claude Opus 5")).toBe("Opus 5")
    expect(modelShortName("GPT-6 Astra")).toBe("GPT-6 Astra")
  })

  test("status words", () => {
    expect(statusWord("done")).toBe("Done")
    expect(statusWord("failed")).toBe("Failed")
    expect(statusWord("stopped")).toBe("Stopped")
    expect(statusWord("waiting")).toBe("Needs you")
  })
})

describe("kinds and names", () => {
  test("the resolved metadata agent wins over the requested type", () => {
    expect(resolveAgent({ metadata: "review", requested: "explore" })).toBe("review")
    expect(resolveAgent({ record: "debug", child: "test" })).toBe("debug")
    expect(resolveAgent({ child: "test", requested: "explore" })).toBe("test")
  })

  test("an omitted subagent_type means the general Subagent", () => {
    expect(resolveAgent({})).toBe("general")
    expect(resolveAgent({ requested: "  " })).toBe("general")
  })

  test("the requested type maps the general aliases models emit", () => {
    expect(resolveAgent({ requested: "general-purpose" })).toBe("general")
    expect(resolveAgent({ requested: "Subagent" })).toBe("general")
    expect(resolveAgent({ requested: "docs-writer" })).toBe("docs-writer")
  })

  test("the child title suffix is the last resort", () => {
    expect(resolveAgent({ title: "Find the bug (@debug subagent)" })).toBe("debug")
  })

  test("general is a Subagent; every other agent, custom ones included, is a specialist", () => {
    expect(subagentKind("general")).toBe("subagent")
    expect(subagentKind("explore")).toBe("specialist")
    expect(subagentKind("docs-writer")).toBe("specialist")
    expect(subagentKind("explore", "subagent")).toBe("subagent")
    expect(subagentKind("general", "nonsense")).toBe("subagent")
  })

  test("labels come from the identities, custom agents keep their id", () => {
    expect(agentLabel("general")).toBe("Subagent")
    expect(agentLabel("explore")).toBe("Explore")
    expect(agentLabel("docs-writer")).toBe("docs-writer")
  })

  test("card kind labels", () => {
    const general = { agent: "general", kind: "subagent" as const }
    const explore = { agent: "explore", kind: "specialist" as const }
    const review = { agent: "review", kind: "specialist" as const }
    const custom = { agent: "docs-writer", kind: "specialist" as const }
    expect(kindLabel([])).toBe("Subagent")
    expect(kindLabel([general])).toBe("Subagent")
    expect(kindLabel([general, general])).toBe("Subagents")
    expect(kindLabel([explore])).toBe("Specialist · Explore")
    expect(kindLabel([explore, explore])).toBe("Specialist · Explore")
    expect(kindLabel([explore, review])).toBe("Specialists")
    expect(kindLabel([general, review])).toBe("Subagents & specialists")
    expect(kindLabel([custom])).toBe("Specialist · docs-writer")
  })

  test("phase names append the specialist only when every agent in it is that specialist", () => {
    const general = { agent: "general", kind: "subagent" as const }
    const review = { agent: "review", kind: "specialist" as const }
    const explore = { agent: "explore", kind: "specialist" as const }
    expect(phaseName(1, [general, general])).toBe("Phase 1")
    expect(phaseName(2, [review, review])).toBe("Phase 2 · Review")
    expect(phaseName(3, [review, explore])).toBe("Phase 3")
    expect(phaseName(1, [review, general])).toBe("Phase 1")
    expect(phaseName(4, [])).toBe("Phase 4")
  })

  test("the engine's child-title suffix is stripped", () => {
    expect(stripSubagentSuffix("Map the auth flow (@explore subagent)")).toBe("Map the auth flow")
    expect(stripSubagentSuffix("Map the auth flow")).toBe("Map the auth flow")
    expect(stripSubagentSuffix(undefined)).toBe("")
  })

  test("titles mirror the engine: description, else the prompt's first six words, capped", () => {
    expect(subagentTitle("  Map   the auth flow ", "ignored")).toBe("Map the auth flow")
    expect(subagentTitle("", "Look through the billing module and list every entry point")).toBe(
      "Look through the billing module and",
    )
    expect(subagentTitle(undefined, undefined)).toBe("")
    const long = subagentTitle("word ".repeat(30), "")
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long.endsWith("…")).toBe(true)
  })
})

describe("status", () => {
  test("a reported final status is trusted", () => {
    expect(agentStatus({ reported: "completed", part: "completed" })).toBe("done")
    expect(agentStatus({ reported: "error", part: "error" })).toBe("failed")
    expect(agentStatus({ reported: "cancelled", part: "error" })).toBe("stopped")
    expect(agentStatus({ reported: "completed", waiting: true })).toBe("done")
    expect(agentStatus({ reported: "error", waiting: true })).toBe("failed")
    expect(agentStatus({ reported: "cancelled", waiting: true })).toBe("stopped")
  })

  test("a live record follows the child: busy or retrying is running, waiting on a permission is waiting", () => {
    expect(agentStatus({ reported: "running", part: "running", child: "busy" })).toBe("running")
    expect(agentStatus({ reported: "running", part: "running", child: "retry" })).toBe("running")
    expect(agentStatus({ reported: "running", part: "running", child: "busy", waiting: true })).toBe("waiting")
    expect(agentStatus({ reported: "queued", part: "running" })).toBe("pending")
    expect(agentStatus({ reported: "queued", part: "running", child: "busy" })).toBe("running")
  })

  test("a foreground error before the lifecycle merge maps its text", () => {
    expect(agentStatus({ reported: "running", part: "error", partError: "boom" })).toBe("failed")
    expect(agentStatus({ reported: "running", part: "error", partError: "Tool execution aborted" })).toBe("stopped")
  })

  test("a permission or question is visible before the child's busy event arrives", () => {
    expect(agentStatus({ reported: "queued", part: "running", waiting: true })).toBe("waiting")
    expect(agentStatus({ part: "pending", waiting: true })).toBe("waiting")
    expect(agentStatus({ reported: "queued", part: "running", waiting: false })).toBe("pending")
  })

  test("a background part completes at launch but stays running while the child works", () => {
    expect(agentStatus({ reported: "running", part: "completed", background: true, child: "busy" })).toBe("running")
    expect(agentStatus({ reported: "running", part: "completed", background: true })).toBe("running")
  })

  test("a stale live record after an engine restart settles from the child's last reply of this run", () => {
    const base = { reported: "running" as const, part: "completed" as const, background: true, startedAt: 100 }
    expect(agentStatus({ ...base, child: "idle", last: { created: 150, completed: 900 } })).toBe("done")
    expect(agentStatus({ ...base, last: { created: 150, completed: 900 } })).toBe("done")
    expect(agentStatus({ ...base, last: { created: 150, completed: 900, error: "MessageAbortedError" } })).toBe(
      "stopped",
    )
    expect(agentStatus({ ...base, last: { created: 150, completed: 900, error: "APIError" } })).toBe("failed")
  })

  test("a reply from an earlier run does not settle a resumed task", () => {
    expect(
      agentStatus({ reported: "running", part: "completed", startedAt: 1_000, last: { created: 10, completed: 20 } }),
    ).toBe("running")
    expect(agentStatus({ reported: "running", part: "running", last: { created: 10 } })).toBe("running")
  })

  test("sessions from before the lifecycle record fall back to the part and the child", () => {
    expect(agentStatus({ part: "pending" })).toBe("pending")
    expect(agentStatus({ part: "running" })).toBe("running")
    expect(agentStatus({ part: "error", partError: "Task cancelled" })).toBe("stopped")
    expect(agentStatus({ part: "error", partError: "Provider exploded" })).toBe("failed")
    expect(agentStatus({ part: "completed" })).toBe("done")
    expect(agentStatus({ part: "completed", background: true, child: "busy" })).toBe("running")
    expect(agentStatus({ part: "completed", last: { error: "MessageAbortedError" } })).toBe("stopped")
    expect(agentStatus({ part: "completed", last: { error: "APIError" } })).toBe("failed")
    expect(agentStatus({})).toBe("done")
  })

  test("a row of squares is spoken as counts per status", () => {
    expect(statusSummary(["running", "pending"])).toBe("1 running, 1 not started")
    expect(statusSummary(["done", "failed", "done", "waiting"])).toBe("1 waiting on you, 2 done, 1 failed")
    expect(statusSummary([])).toBe("")
  })

  test("aggregate: waiting, then running, pending, failed, stopped, done", () => {
    expect(aggregateStatus(["done", "running", "waiting"])).toBe("waiting")
    expect(aggregateStatus(["done", "running", "pending"])).toBe("running")
    expect(aggregateStatus(["done", "waiting", "pending"])).toBe("waiting")
    expect(aggregateStatus(["done", "pending", "failed"])).toBe("pending")
    expect(aggregateStatus(["done", "stopped", "failed"])).toBe("failed")
    expect(aggregateStatus(["done", "stopped"])).toBe("stopped")
    expect(aggregateStatus(["done"])).toBe("done")
    expect(aggregateStatus([])).toBe("done")
  })
})

describe("lifecycle fields", () => {
  test("part metadata spells parentMessageId, the record parentMessageID; both read the same", () => {
    expect(readLifecycle({ parentMessageId: "m1" }).parentMessageID).toBe("m1")
    expect(readLifecycle({ parentMessageID: "m2" }).parentMessageID).toBe("m2")
  })

  test("invalid values are dropped rather than trusted", () => {
    const value = readLifecycle({ status: "exploded", kind: "robot", startedAt: "yesterday", model: { modelID: "x" } })
    expect(value.status).toBeUndefined()
    expect(value.kind).toBeUndefined()
    expect(value.startedAt).toBeUndefined()
    expect(value.model).toBeUndefined()
    expect(readLifecycle(null)).toEqual({})
    expect(readLifecycle("nope")).toEqual({})
  })

  test("usage totals are summed from the token breakdown when total is missing", () => {
    const value = readLifecycle({
      usage: { tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 3, write: 1 } }, toolUses: 2 },
    })
    expect(value.usage).toEqual({ total: 20, toolUses: 2 })
  })

  test("a child record is only read from an object at metadata.subagent", () => {
    expect(childRecord(undefined)).toBeUndefined()
    expect(childRecord(child("c", { metadata: { subagent: "x" } }))).toBeUndefined()
    expect(childRecord(child("c", { metadata: { subagent: { agent: "debug" } } }))?.agent).toBe("debug")
  })
})

describe("buildTaskCards", () => {
  test("one turn with two parallel explores: one card, one phase, lifecycle fields throughout", () => {
    const data = fixture()
    addUser(data, "msg_u1", "\n  Find every place we check auth  \nand summarise")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({
        id: "prt_1",
        metadata: lifecycle({ sessionId: "ses_c1", title: "Map the auth flow", completedAt: 61_000 }),
      }),
      taskPart({
        id: "prt_2",
        metadata: lifecycle({
          sessionId: "ses_c2",
          title: "Find token checks",
          startedAt: 2_000,
          completedAt: 91_000,
          usage: usage(216_600, 7),
        }),
      }),
    ])
    data.sessions.ses_c1 = child("ses_c1", ownUsage(12_000))
    data.sessions.ses_c2 = child("ses_c2", ownUsage(216_600))
    const cards = buildTaskCards(source(data))
    expect(cards).toHaveLength(1)
    const card = cards[0]!
    expect(card.key).toBe("msg_u1")
    expect(card.title).toBe("Find every place we check auth")
    expect(card.description).toBe("Map the auth flow, Find token checks")
    expect(card.kindLabel).toBe("Specialist · Explore")
    expect(card.status).toBe("done")
    expect(card.live).toBe(false)
    expect(card.tokens).toBe(228_600)
    expect(formatTokens(card.tokens)).toBe("228.6k")
    expect(card.startedAt).toBe(1_000)
    expect(card.endedAt).toBe(91_000)
    expect(card.phases).toHaveLength(1)
    expect(card.phases[0]!.name).toBe("Phase 1 · Explore")
    expect(card.phases[0]!.done).toBe(2)
    expect(card.phases[0]!.total).toBe(2)
    const agent = card.agents[0]!
    expect(agent.sessionID).toBe("ses_c1")
    expect(agent.kind).toBe("specialist")
    expect(agent.label).toBe("Explore")
    expect(agent.model?.name).toBe("Claude Opus 5")
    expect(agent.model?.short).toBe("Opus 5")
    expect(agent.toolUses).toBe(3)
  })

  test("two assistant messages in one turn are two phases; a running agent makes the card live", () => {
    const data = fixture()
    addUser(data, "msg_u1", "Refactor the billing module")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({ id: "prt_1", metadata: lifecycle({ sessionId: "ses_c1", agent: "general", kind: "subagent" }) }),
      taskPart({ id: "prt_2", metadata: lifecycle({ sessionId: "ses_c2", agent: "general", kind: "subagent" }) }),
    ])
    addAssistant(data, "msg_a2", "msg_u1", [
      taskPart({
        id: "prt_3",
        status: "running",
        metadata: lifecycle({
          sessionId: "ses_c3",
          agent: "review",
          status: "running",
          completedAt: undefined,
          usage: undefined,
        }),
      }),
    ])
    data.status.ses_c3 = { type: "busy" }
    const card = buildTaskCards(source(data))[0]!
    expect(card.phases.map((phase) => phase.name)).toEqual(["Phase 1", "Phase 2 · Review"])
    expect(card.kindLabel).toBe("Subagents & specialists")
    expect(card.status).toBe("running")
    expect(card.live).toBe(true)
    expect(card.endedAt).toBeUndefined()
    expect(card.phases[0]!.status).toBe("done")
    expect(card.phases[1]!.status).toBe("running")
    expect(card.phases[1]!.done).toBe(0)
    expect(card.agents[2]!.endedAt).toBeUndefined()
  })

  test("an old session without lifecycle fields falls back to the part, the child and its messages", () => {
    const data = fixture()
    addUser(data, "msg_u1", "Where is auth?")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({
        id: "prt_1",
        input: { description: "Find auth code", prompt: "Look for auth", subagent_type: "explore" },
        metadata: { sessionId: "ses_c1", model: { providerID: "openai", modelID: "gpt-6-astra" } },
        start: 5_000,
        end: 65_000,
      }),
    ])
    data.sessions.ses_c1 = child("ses_c1", { title: "Find auth code (@explore subagent)", agent: "explore" })
    addAssistant(
      data,
      "msg_c1a",
      "msg_c1u",
      [
        { id: "p1", type: "tool", tool: "grep" } as Part,
        { id: "p2", type: "tool", tool: "read" } as Part,
        {
          id: "p3",
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 1_000, output: 200, reasoning: 0, cache: { read: 300, write: 0 } },
        } as Part,
        {
          id: "p4",
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 500, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as Part,
      ],
      { time: { created: 6_000, completed: 64_000 } },
      "ses_c1",
    )
    const card = buildTaskCards(source(data))[0]!
    const agent = card.agents[0]!
    expect(agent.title).toBe("Find auth code")
    expect(agent.agent).toBe("explore")
    expect(agent.kind).toBe("specialist")
    expect(agent.status).toBe("done")
    expect(agent.startedAt).toBe(5_000)
    expect(agent.endedAt).toBe(65_000)
    expect(agent.tokens).toBe(2_000)
    expect(agent.toolUses).toBe(2)
    expect(agent.model?.name).toBe("gpt-6-astra")
    expect(agent.prompt).toBe("Look for auth")
    expect(card.description).toBe("Look for auth")
    expect(card.title).toBe("Find auth code")
  })

  test("an omitted subagent_type is the general Subagent", () => {
    const data = fixture()
    addUser(data, "msg_u1", "Do three things")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({ id: "prt_1", status: "running", input: { description: "Thing one", prompt: "one" } }),
    ])
    const agent = buildTaskCards(source(data))[0]!.agents[0]!
    expect(agent.agent).toBe("general")
    expect(agent.kind).toBe("subagent")
    expect(agent.label).toBe("Subagent")
    expect(agent.status).toBe("running")
  })

  test("a part still streaming its input shows safe defaults and never undefined", () => {
    const data = fixture()
    addUser(data, "msg_u1", "go")
    addAssistant(data, "msg_a1", "msg_u1", [taskPart({ id: "prt_1", status: "pending" })])
    const card = buildTaskCards(source(data))[0]!
    const agent = card.agents[0]!
    expect(agent.title).toBe("Subagent task")
    expect(agent.status).toBe("pending")
    expect(agent.sessionID).toBeUndefined()
    expect(agent.tokens).toBeUndefined()
    expect(agent.model).toBeUndefined()
    expect(formatTokens(agent.tokens)).toBe("—")
    expect(card.live).toBe(true)
    expect(card.kindLabel).toBe("Subagent")
  })

  test("an errored call that lost its metadata finds its child by call id and is not duplicated", () => {
    const data = fixture()
    addUser(data, "msg_u1", "go")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({ id: "prt_1", callID: "call_9", status: "error", error: "Tool execution aborted" }),
    ])
    data.sessions.ses_c1 = child("ses_c1", {
      title: "Hunt the flake",
      metadata: {
        subagent: { kind: "specialist", agent: "debug", title: "Hunt the flake", callID: "call_9", status: "running" },
      },
    })
    const cards = buildTaskCards(source(data))
    expect(cards).toHaveLength(1)
    const agent = cards[0]!.agents[0]!
    expect(agent.sessionID).toBe("ses_c1")
    expect(agent.agent).toBe("debug")
    expect(agent.status).toBe("stopped")
  })

  test("a failed agent carries its error; others do not", () => {
    const data = fixture()
    addUser(data, "msg_u1", "go")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({
        id: "prt_1",
        status: "error",
        error: "Provider exploded",
        metadata: lifecycle({ sessionId: "ses_c1", status: "error", error: "Rate limited" }),
      }),
      taskPart({ id: "prt_2", metadata: lifecycle({ sessionId: "ses_c2" }) }),
    ])
    const card = buildTaskCards(source(data))[0]!
    expect(card.agents[0]!.status).toBe("failed")
    expect(card.agents[0]!.error).toBe("Rate limited")
    expect(card.agents[1]!.error).toBeUndefined()
    expect(card.status).toBe("failed")
  })

  test("subagents the user can open stay as cards while Vector's helper sessions under the same task do not", () => {
    const data = fixture()
    data.sessions.ses_sub = child("ses_sub", { title: "Find the flaky test (@explore subagent)", agent: "explore" })
    // A helper that even looks like a subagent is still not the user's background work.
    data.sessions.ses_review = child("ses_review", {
      title: "Vectorscope review (@review subagent)",
      internal: "vectorscope.review",
    })
    data.sessions.ses_autocomplete = child("ses_autocomplete", {
      title: "Autocomplete",
      internal: "codespace.autocomplete",
    })
    const cards = buildTaskCards(source(data))
    expect(cards.flatMap((card) => card.agents.map((agent) => agent.sessionID))).toEqual(["ses_sub"])
  })

  test("children with no part in the loaded history still appear, grouped by their launching message", () => {
    const data = fixture()
    data.sessions.ses_c1 = child("ses_c1", {
      ...ownUsage(900),
      metadata: {
        subagent: {
          kind: "subagent",
          agent: "general",
          title: "Old job one",
          parentMessageID: "msg_old",
          status: "completed",
          startedAt: 100,
          completedAt: 400,
          usage: usage(900),
        },
      },
    })
    data.sessions.ses_c2 = child("ses_c2", {
      metadata: {
        subagent: {
          kind: "subagent",
          agent: "general",
          title: "Old job two",
          parentMessageID: "msg_old",
          status: "cancelled",
          startedAt: 150,
          completedAt: 300,
        },
      },
    })
    data.sessions.ses_c3 = child("ses_c3", { title: "Legacy lookup (@explore subagent)", agent: "explore" })
    data.sessions.ses_fork = child("ses_fork", { title: "A plain child session" })
    data.sessions.ses_other = child("ses_other", { parentID: "ses_elsewhere", title: "Other (@debug subagent)" })
    const cards = buildTaskCards(source(data))
    expect(cards).toHaveLength(2)
    const grouped = cards.find((card) => card.key === "orphan:msg_old")!
    expect(grouped.agents.map((agent) => agent.title)).toEqual(["Old job one", "Old job two"])
    expect(grouped.status).toBe("stopped")
    expect(grouped.title).toBe("Old job one and 1 more")
    expect(grouped.tokens).toBe(900)
    const legacy = cards.find((card) => card.key === "orphan:session:ses_c3")!
    expect(legacy.agents[0]!.agent).toBe("explore")
    expect(legacy.agents[0]!.title).toBe("Legacy lookup")
    expect(legacy.agents[0]!.status).toBe("done")
    expect(legacy.agents[0]!.endedAt).toBe(60)
  })

  test("a task_id resume: the old part keeps its outcome, the new part follows the rewritten record", () => {
    const data = fixture()
    addUser(data, "msg_u1", "go")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({
        id: "prt_old",
        callID: "call_1",
        metadata: lifecycle({ sessionId: "ses_c1", callID: "call_1", status: "completed" }),
      }),
    ])
    addUser(data, "msg_u2", "keep going")
    addAssistant(data, "msg_a2", "msg_u2", [
      taskPart({ id: "prt_new", callID: "call_2", status: "running", metadata: { sessionId: "ses_c1" } }),
    ])
    data.sessions.ses_c1 = child("ses_c1", {
      metadata: {
        subagent: { agent: "explore", kind: "specialist", callID: "call_2", status: "running", startedAt: 5_000 },
      },
    })
    data.status.ses_c1 = { type: "busy" }
    const cards = buildTaskCards(source(data))
    const older = cards.find((card) => card.key === "msg_u1")!
    const newer = cards.find((card) => card.key === "msg_u2")!
    expect(older.agents[0]!.status).toBe("done")
    expect(newer.agents[0]!.status).toBe("running")
    expect(newer.agents[0]!.startedAt).toBe(5_000)
  })

  test("editable lifecycle totals are ignored; identified assistant tokens stand in when no step parts are loaded", () => {
    const data = fixture()
    addUser(data, "msg_u1", "go")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({ id: "prt_1", metadata: { sessionId: "ses_c1" } }),
      taskPart({ id: "prt_2", metadata: { sessionId: "ses_c2" } }),
      taskPart({ id: "prt_3", metadata: { sessionId: "ses_c3" } }),
    ])
    data.sessions.ses_c1 = child("ses_c1", { metadata: { subagent: { usage: usage(5) } } })
    data.sessions.ses_c2 = child("ses_c2")
    data.messages.ses_c2 = [
      {
        id: "m2",
        providerID: "own",
        sessionID: "ses_c2",
        role: "assistant",
        parentID: "u",
        time: { created: 1, completed: 2 },
        tokens: { input: 40, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      } as unknown as Message,
    ]
    const agents = buildTaskCards(source(data))[0]!.agents
    expect(agents[0]!.tokens).toBeUndefined()
    expect(agents[1]!.tokens).toBe(42)
    expect(agents[2]!.tokens).toBeUndefined()
  })

  test("a waiting child surfaces attention on its card and phase while siblings keep running", () => {
    const data = fixture()
    addUser(data, "msg_u1", "go")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({ id: "prt_1", status: "running", metadata: lifecycle({ sessionId: "ses_c1", status: "running" }) }),
      taskPart({ id: "prt_2", status: "running", metadata: lifecycle({ sessionId: "ses_c2", status: "running" }) }),
    ])
    data.status.ses_c1 = { type: "busy" }
    data.status.ses_c2 = { type: "busy" }
    data.waiting.add("ses_c2")
    const card = buildTaskCards(source(data))[0]!
    expect(card.agents.map((agent) => agent.status)).toEqual(["running", "waiting"])
    expect(card.status).toBe("waiting")
    expect(card.phases[0]!.status).toBe("waiting")
    expect(card.live).toBe(true)
    expect(waitingAgentCount([card])).toBe(1)
    expect(runningAgentCount([card])).toBe(2)
    data.waiting.delete("ses_c2")
    const resumed = buildTaskCards(source(data))[0]!
    expect(resumed.status).toBe("running")
    expect(resumed.phases[0]!.status).toBe("running")
    expect(waitingAgentCount([resumed])).toBe(0)
  })

  test("live cards sort first, newest first; finished cards by most recent end", () => {
    const data = fixture()
    addUser(data, "msg_u1", "first")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({ id: "prt_1", metadata: lifecycle({ sessionId: "c1", startedAt: 100, completedAt: 900 }) }),
    ])
    addUser(data, "msg_u2", "second")
    addAssistant(data, "msg_a2", "msg_u2", [
      taskPart({ id: "prt_2", metadata: lifecycle({ sessionId: "c2", startedAt: 200, completedAt: 500 }) }),
    ])
    addUser(data, "msg_u3", "third")
    addAssistant(data, "msg_a3", "msg_u3", [
      taskPart({
        id: "prt_3",
        status: "running",
        metadata: lifecycle({ sessionId: "c3", startedAt: 300, status: "running" }),
      }),
    ])
    const cards = buildTaskCards(source(data))
    expect(cards.map((card) => card.key)).toEqual(["msg_u3", "msg_u1", "msg_u2"])
  })

  test("malformed parts from any engine version never throw", () => {
    const data = fixture()
    addUser(data, "msg_u1", "go")
    data.parts.msg_u1!.push({ id: "bad_text", type: "text" } as unknown as Part)
    addAssistant(data, "msg_a1", "msg_u1", [
      { id: "prt_bad", type: "tool", tool: "task", callID: "c" } as unknown as Part,
      taskPart({ id: "prt_odd", metadata: { sessionId: 42, status: "exploded", usage: "lots", model: "big" } }),
    ])
    const cards = buildTaskCards(source(data))
    expect(cards).toHaveLength(1)
    const [bad, odd] = cards[0]!.agents
    expect(bad!.title).toBe("Subagent task")
    expect(bad!.agent).toBe("general")
    expect(odd!.sessionID).toBeUndefined()
    expect(odd!.tokens).toBeUndefined()
    expect(odd!.model).toBeUndefined()
    expect(odd!.status).toBe("done")
  })

  test("a root with no task parts and no children has no cards", () => {
    const data = fixture()
    addUser(data, "msg_u1", "hello")
    addAssistant(data, "msg_a1", "msg_u1", [{ id: "t", type: "text", text: "hi" } as Part])
    expect(buildTaskCards(source(data))).toEqual([])
    expect(
      buildTaskCards({ rootID: ROOT, messages: () => undefined, parts: () => undefined, session: () => undefined }),
    ).toEqual([])
  })

  test("a stale running record with no status entry settles once the child's messages load", () => {
    const data = fixture()
    addUser(data, "msg_u1", "go")
    const running = (id: string) =>
      lifecycle({ sessionId: id, status: "running", background: true, completedAt: undefined, usage: undefined })
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({ id: "prt_1", metadata: running("ses_c1") }),
      taskPart({ id: "prt_2", metadata: running("ses_c2") }),
      taskPart({ id: "prt_3", metadata: running("ses_c3") }),
    ])
    for (const id of ["1", "2", "3"]) {
      data.sessions[`ses_c${id}`] = child(`ses_c${id}`, {
        metadata: { subagent: { agent: "explore", callID: `call_prt_${id}`, status: "running", startedAt: 1_000 } },
      })
    }
    // After a reload an idle child has no session_status entry and no messages.
    const stale = buildTaskCards(source(data))[0]!
    expect(stale.agents.map((agent) => agent.status)).toEqual(["running", "running", "running"])
    expect(stale.live).toBe(true)

    const reply = (sessionID: string, error?: string) =>
      addAssistant(
        data,
        `msg_${sessionID}_a`,
        `msg_${sessionID}_u`,
        [],
        {
          time: { created: 2_000, completed: 9_000 },
          ...(error ? { error: { name: error, data: {} } } : {}),
        } as unknown as Partial<AssistantMessage>,
        sessionID,
      )
    reply("ses_c1")
    reply("ses_c2", "APIError")
    reply("ses_c3", "MessageAbortedError")
    const settled = buildTaskCards(source(data))[0]!
    expect(settled.agents.map((agent) => agent.status)).toEqual(["done", "failed", "stopped"])
    expect(settled.live).toBe(false)
    expect(settled.agents[0]!.endedAt).toBe(9_000)
    expect(settled.agents[1]!.error).toBe("APIError")
  })

  test("a task_id call on a running job folds into it: one row and square, tokens counted once", () => {
    const build = (settled: boolean) => {
      const data = fixture()
      addUser(data, "msg_u1", "go")
      const outcome = settled
        ? { status: "completed", completedAt: 30_000, usage: usage(40_000) }
        : { status: "running", completedAt: undefined, usage: undefined }
      addAssistant(data, "msg_a1", "msg_u1", [
        taskPart({
          id: "prt_launch",
          callID: "call_1",
          metadata: lifecycle({
            sessionId: "ses_c1",
            callID: "call_1",
            background: true,
            startedAt: 1_000,
            ...outcome,
          }),
        }),
      ])
      // The engine's "Background task updated" part: the same child, its own call id.
      addAssistant(data, "msg_a2", "msg_u1", [
        taskPart({
          id: "prt_extend",
          callID: "call_2",
          metadata: lifecycle({
            sessionId: "ses_c1",
            callID: "call_2",
            background: true,
            startedAt: 12_000,
            ...outcome,
          }),
        }),
      ])
      // An extend leaves the child's record on the launching call.
      data.sessions.ses_c1 = child("ses_c1", {
        ...(settled ? ownUsage(40_000) : {}),
        metadata: { subagent: { agent: "explore", callID: "call_1", startedAt: 1_000, background: true, ...outcome } },
      })
      if (!settled) data.status.ses_c1 = { type: "busy" }
      return buildTaskCards(source(data))
    }

    const live = build(false)
    expect(live).toHaveLength(1)
    expect(live[0]!.agents.map((agent) => agent.partID)).toEqual(["prt_launch"])
    expect(live[0]!.phases).toHaveLength(1)
    expect(live[0]!.status).toBe("running")
    expect(liveAgentCount(live)).toBe(1)
    expect(locateTaskPart(live, "prt_extend")?.agent.partID).toBe("prt_launch")
    expect(locateTaskPart(live, "prt_extend")?.first).toBe(false)

    // Once the run settles the engine patches both parts with the same usage.
    const done = build(true)
    expect(done[0]!.agents.map((agent) => agent.partID)).toEqual(["prt_launch"])
    expect(done[0]!.status).toBe("done")
    expect(done[0]!.tokens).toBe(40_000)
    expect(formatAgentCount(countAgents(done[0]!.agents))).toBe("1 agent")
    expect(locateTaskPart(done, "prt_extend")?.first).toBe(false)
  })

  test("a child resumed in the same turn keeps both runs but counts once, at its newest cumulative usage", () => {
    const data = fixture()
    addUser(data, "msg_u1", "go")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({
        id: "prt_first",
        callID: "call_1",
        metadata: lifecycle({ sessionId: "ses_c1", callID: "call_1", startedAt: 1_000, completedAt: 9_000 }),
      }),
    ])
    addAssistant(data, "msg_a2", "msg_u1", [
      taskPart({
        id: "prt_resume",
        callID: "call_2",
        metadata: lifecycle({
          sessionId: "ses_c1",
          callID: "call_2",
          startedAt: 20_000,
          completedAt: 30_000,
          usage: usage(25_000),
        }),
      }),
    ])
    // The resume rewrote the child's record; its usage includes the first run's 12k.
    data.sessions.ses_c1 = child("ses_c1", {
      ...ownUsage(25_000),
      metadata: {
        subagent: { agent: "explore", callID: "call_2", status: "completed", startedAt: 20_000, usage: usage(25_000) },
      },
    })
    const card = buildTaskCards(source(data))[0]!
    expect(card.agents.map((agent) => agent.partID)).toEqual(["prt_first", "prt_resume"])
    expect(card.phases).toHaveLength(2)
    expect(card.agents.map((agent) => agent.tokens)).toEqual([25_000, 25_000])
    expect(card.tokens).toBe(25_000)
    expect(countAgents(card.agents)).toBe(1)
    expect(card.kindLabel).toBe("Specialist · Explore")
  })
})

describe("indexed task batches", () => {
  test("one real part exposes each indexed outcome and keeps its first inline chip", () => {
    const data = fixture()
    addUser(data, "u", "Implement CSV and JSON")
    addAssistant(data, "a", "u", [
      taskPart({
        id: "batch",
        input: {
          tasks: [
            { description: "CSV", subagent_type: "general" },
            { description: "JSON", subagent_type: "test" },
          ],
        },
        metadata: {
          taskBatch: 1,
          status: "completed",
          tasks: [
            { index: 1, sessionId: "json", status: "error", error: "JSON tests failed", usage: usage(200) },
            { index: 0, sessionId: "csv", status: "completed", usage: usage(100) },
          ],
        },
      }),
    ])
    data.sessions.csv = child("csv", ownUsage(100))
    data.sessions.json = child("json", ownUsage(200))
    const cards = buildTaskCards(source(data))
    expect(cards).toHaveLength(1)
    expect(cards[0]!.phases).toHaveLength(1)
    expect(
      cards[0]!.agents.map((agent) => ({
        key: agent.key,
        partID: agent.partID,
        batchIndex: agent.batchIndex,
        sessionID: agent.sessionID,
        status: agent.status,
        title: agent.title,
        error: agent.error,
      })),
    ).toEqual([
      {
        key: "batch:0",
        partID: "batch",
        batchIndex: 0,
        sessionID: "csv",
        status: "done",
        title: "CSV",
        error: undefined,
      },
      {
        key: "batch:1",
        partID: "batch",
        batchIndex: 1,
        sessionID: "json",
        status: "failed",
        title: "JSON",
        error: "JSON tests failed",
      },
    ])
    expect(cards[0]!.tokens).toBe(300)
    expect(cards[0]!.status).toBe("failed")
    expect(countAgents(cards[0]!.agents)).toBe(2)
    expect(taskPartLocations(cards).get("batch")?.agent.batchIndex).toBe(0)
    expect(locateTaskPart(cards, "batch")?.first).toBe(true)
  })

  test("parent failure cannot overwrite finished siblings or invent missing success", () => {
    const data = fixture()
    addUser(data, "u", "go")
    addAssistant(data, "a", "u", [
      taskPart({
        id: "batch",
        status: "error",
        error: "Parent interrupted",
        input: { tasks: [{ description: "CSV" }, { description: "JSON" }, { description: "YAML" }] },
        metadata: {
          taskBatch: 1,
          tasks: [
            { index: 0, status: "completed", sessionId: "csv" },
            { index: 1, status: "cancelled", sessionId: "json" },
          ],
        },
      }),
    ])
    const agents = buildTaskCards(source(data))[0]!.agents
    expect(agents.map((agent) => agent.status)).toEqual(["done", "stopped", "failed"])
    expect(agents.map((agent) => agent.error)).toEqual([undefined, undefined, undefined])
    expect(agents.map((agent) => agent.sessionID)).toEqual(["csv", "json", undefined])
  })

  test("input-only children remain pending after a completed parent", () => {
    const data = fixture()
    addUser(data, "u", "go")
    addAssistant(data, "a", "u", [
      taskPart({ id: "batch", input: { tasks: [{ description: "CSV" }, { description: "JSON" }] } }),
    ])
    const card = buildTaskCards(source(data))[0]!
    expect(card.agents.map((agent) => agent.status)).toEqual(["pending", "pending"])
    expect(card.agents.map((agent) => agent.sessionID)).toEqual([undefined, undefined])
    expect(card.agents.map((agent) => agent.startedAt)).toEqual([undefined, undefined])
    expect(elapsedMs(card, 100_000)).toBeUndefined()
    expect(card.tokens).toBeUndefined()
    expect(card.live).toBe(true)
  })

  test("lost parent metadata recovers only the matching message, real call and index", () => {
    const data = fixture()
    addUser(data, "u", "go")
    addAssistant(data, "a", "u", [
      taskPart({
        id: "batch",
        callID: "same_call",
        status: "error",
        input: { tasks: [{ description: "CSV" }, { description: "JSON" }] },
      }),
    ])
    data.sessions.csv = child("csv", {
      ...ownUsage(100),
      metadata: {
        subagent: lifecycle({
          parentMessageID: "a",
          callID: "same_call",
          batchIndex: 0,
          status: "completed",
          usage: usage(100),
        }),
      },
    })
    data.sessions.json = child("json", {
      ...ownUsage(200),
      metadata: {
        subagent: lifecycle({
          parentMessageID: "a",
          callID: "same_call",
          batchIndex: 1,
          status: "error",
          error: "Child failed",
          usage: usage(200),
        }),
      },
    })
    data.sessions.unrelated = child("unrelated", {
      metadata: {
        subagent: lifecycle({
          parentMessageID: "other_message",
          callID: "same_call",
          batchIndex: 0,
          status: "completed",
        }),
      },
    })
    const cards = buildTaskCards(source(data))
    const card = cards.find((card) => card.key === "u")!
    expect(card.agents.map((agent) => agent.sessionID)).toEqual(["csv", "json"])
    expect(card.agents.map((agent) => agent.status)).toEqual(["done", "failed"])
    expect(card.tokens).toBe(300)
    expect(cards.flatMap((card) => card.agents).filter((agent) => agent.sessionID === "csv")).toHaveLength(1)
    expect(cards.flatMap((card) => card.agents).filter((agent) => agent.sessionID === "unrelated")).toHaveLength(1)
  })

  test("metadata-only items retain sparse indexes after history trimming", () => {
    const data = fixture()
    addUser(data, "u", "go")
    addAssistant(data, "a", "u", [
      taskPart({
        id: "batch",
        metadata: {
          taskBatch: 1,
          tasks: [{ index: 3, sessionId: "yaml", title: "YAML", status: "completed" }],
        },
      }),
    ])
    expect(buildTaskCards(source(data))[0]!.agents.map((agent) => [agent.key, agent.title, agent.sessionID])).toEqual([
      ["batch:3", "YAML", "yaml"],
    ])
  })

  test("reused provider call IDs do not split an extension of the same indexed run", () => {
    const data = fixture()
    addUser(data, "u", "go")
    for (const messageID of ["launch", "extend"]) {
      addAssistant(data, messageID, "u", [
        taskPart({
          id: messageID,
          callID: "reused_call",
          input: { tasks: [{ description: "CSV", ...(messageID === "extend" ? { task_id: "csv" } : {}) }] },
          metadata: {
            taskBatch: 1,
            tasks: [
              {
                index: 0,
                ...lifecycle({
                  sessionId: "csv",
                  callID: "reused_call",
                  parentMessageId: messageID,
                  status: "running",
                  background: true,
                  startedAt: 1_000,
                  completedAt: undefined,
                }),
              },
            ],
          },
        }),
      ])
    }
    data.sessions.csv = child("csv", {
      metadata: {
        subagent: lifecycle({
          callID: "reused_call",
          batchIndex: 0,
          parentMessageID: "launch",
          status: "running",
          background: true,
          startedAt: 1_000,
          completedAt: undefined,
        }),
      },
    })
    data.status.csv = { type: "busy" }
    const cards = buildTaskCards(source(data))
    expect(cards[0]!.agents.map((agent) => agent.partID)).toEqual(["launch"])
    expect(cards[0]!.phases).toHaveLength(1)
    expect(locateTaskPart(cards, "extend")?.first).toBe(false)
    expect(locateTaskPart(cards, "extend")?.agent.messageID).toBe("launch")
  })

  test("one-item batches preserve extension folding and cumulative resume accounting", () => {
    const data = fixture()
    addUser(data, "u", "go")
    addAssistant(data, "launch", "u", [
      taskPart({
        id: "first",
        metadata: lifecycle({
          sessionId: "csv",
          callID: "call_first",
          startedAt: 1_000,
          completedAt: 9_000,
          usage: usage(100),
        }),
      }),
    ])
    addAssistant(data, "extension", "u", [
      taskPart({
        id: "extend",
        input: { tasks: [{ task_id: "csv" }] },
        metadata: {
          taskBatch: 1,
          tasks: [
            {
              index: 0,
              ...lifecycle({
                sessionId: "csv",
                callID: "call_extend",
                startedAt: 2_000,
                completedAt: 9_000,
                usage: usage(100),
              }),
            },
          ],
        },
      }),
    ])
    data.sessions.csv = child("csv", {
      ...ownUsage(100),
      metadata: {
        subagent: lifecycle({
          callID: "call_first",
          parentMessageID: "launch",
          startedAt: 1_000,
          completedAt: 9_000,
          usage: usage(100),
        }),
      },
    })
    const extended = buildTaskCards(source(data))
    expect(extended[0]!.agents).toHaveLength(1)
    expect(extended[0]!.tokens).toBe(100)
    expect(locateTaskPart(extended, "extend")?.first).toBe(false)
    addAssistant(data, "resume", "u", [
      taskPart({
        id: "resume",
        input: { tasks: [{ task_id: "csv" }] },
        metadata: {
          taskBatch: 1,
          tasks: [
            {
              index: 0,
              ...lifecycle({
                sessionId: "csv",
                callID: "call_resume",
                startedAt: 20_000,
                completedAt: 30_000,
                usage: usage(250),
              }),
            },
          ],
        },
      }),
    ])
    data.sessions.csv.metadata = {
      subagent: lifecycle({
        parentMessageID: "resume",
        callID: "call_resume",
        batchIndex: 0,
        startedAt: 20_000,
        completedAt: 30_000,
        usage: usage(250),
      }),
    }
    Object.assign(data.sessions.csv, ownUsage(250))
    const resumed = buildTaskCards(source(data))[0]!
    expect(resumed.agents.map((agent) => agent.partID)).toEqual(["first", "resume"])
    expect(resumed.tokens).toBe(250)
    expect(countAgents(resumed.agents)).toBe(1)
  })
})

describe("chips, counts and dismissal", () => {
  function twoPhaseCards() {
    const data = fixture()
    addUser(data, "msg_u1", "go")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({ id: "prt_1", status: "running", metadata: lifecycle({ sessionId: "c1", status: "running" }) }),
      taskPart({ id: "prt_2", status: "running", metadata: lifecycle({ sessionId: "c2", status: "queued" }) }),
    ])
    addAssistant(data, "msg_a2", "msg_u1", [taskPart({ id: "prt_3", metadata: lifecycle({ sessionId: "c3" }) })])
    return buildTaskCards(source(data))
  }

  test("only the first task part of each phase carries the chip", () => {
    const cards = twoPhaseCards()
    expect(locateTaskPart(cards, "prt_1")?.first).toBe(true)
    expect(locateTaskPart(cards, "prt_2")?.first).toBe(false)
    expect(locateTaskPart(cards, "prt_3")?.first).toBe(true)
    expect(locateTaskPart(cards, "prt_3")?.phase.index).toBe(2)
    expect(locateTaskPart(cards, "missing")).toBeUndefined()
  })

  test("the live count is running, waiting and queued agents; the header badge leaves out queued ones", () => {
    expect(liveAgentCount(twoPhaseCards())).toBe(2)
    expect(liveAgentCount([])).toBe(0)
    expect(runningAgentCount(twoPhaseCards())).toBe(1)
    expect(runningAgentCount([])).toBe(0)
    expect(waitingAgentCount([])).toBe(0)
  })

  test("Stop all reaches every live background agent once and leaves foreground and finished ones", () => {
    const cards = [
      {
        agents: [
          { sessionID: "ses_bg_running", status: "running" as const, background: true },
          { sessionID: "ses_bg_waiting", status: "waiting" as const, background: true },
          { sessionID: "ses_fg_running", status: "running" as const, background: false },
          { sessionID: "ses_bg_done", status: "done" as const, background: true },
          { sessionID: undefined, status: "pending" as const, background: true },
        ],
      },
      // A task_id call that added to a live run shows the same session again.
      { agents: [{ sessionID: "ses_bg_running", status: "running" as const, background: true }] },
    ]
    expect(liveBackgroundSessions(cards)).toEqual(["ses_bg_running", "ses_bg_waiting"])
    expect(liveBackgroundSessions([])).toEqual([])
  })

  test("counts are per child session: two parts driving one child are one agent", () => {
    const agents = [
      { key: "a", sessionID: "s1", status: "running" as const },
      { key: "b", sessionID: "s1", status: "waiting" as const },
      { key: "c", sessionID: "s2", status: "pending" as const },
      { key: "d", status: "pending" as const },
      { key: "e", sessionID: "s3", status: "done" as const },
    ]
    expect(countAgents(agents)).toBe(4)
    expect(liveAgentCount([{ agents }])).toBe(3)
    expect(runningAgentCount([{ agents }])).toBe(1)
    expect(waitingAgentCount([{ agents }, { agents }])).toBe(1)
  })

  test("the trash hides a finished card until it finishes again", () => {
    expect(isDismissed({ live: false, endedAt: 500 }, 600)).toBe(true)
    expect(isDismissed({ live: false, endedAt: 700 }, 600)).toBe(false)
    expect(isDismissed({ live: false }, 600)).toBe(true)
    expect(isDismissed({ live: true, endedAt: 100 }, 600)).toBe(false)
    expect(isDismissed({ live: false, endedAt: 500 }, undefined)).toBe(false)
  })
})

describe("cards the event stream left behind", () => {
  const running = (sessionId: string, callID: string) =>
    lifecycle({ sessionId, callID, status: "running", background: true, completedAt: undefined, usage: undefined })

  test("a finished child record outranks a task part whose mirror of it never landed", () => {
    const data = fixture()
    addUser(data, "msg_u1", "go")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({ id: "prt_1", callID: "call_1", metadata: running("ses_c1", "call_1") }),
    ])
    data.sessions.ses_c1 = child("ses_c1", {
      ...ownUsage(12_000),
      metadata: {
        subagent: {
          agent: "explore",
          callID: "call_1",
          status: "completed",
          startedAt: 1_000,
          completedAt: 61_000,
          usage: usage(12_000),
        },
      },
    })
    const card = buildTaskCards(source(data))[0]!
    expect(card.live).toBe(false)
    expect(card.agents[0]!.status).toBe("done")
    expect(card.agents[0]!.endedAt).toBe(61_000)
    expect(card.agents[0]!.tokens).toBe(12_000)
  })

  test("a failed or cancelled record settles the part the same way", () => {
    for (const [status, expected] of [
      ["error", "failed"],
      ["cancelled", "stopped"],
    ] as const) {
      const data = fixture()
      addUser(data, "msg_u1", "go")
      addAssistant(data, "msg_a1", "msg_u1", [
        taskPart({ id: "prt_1", callID: "call_1", metadata: running("ses_c1", "call_1") }),
      ])
      data.sessions.ses_c1 = child("ses_c1", {
        metadata: {
          subagent: { callID: "call_1", status, startedAt: 1_000, completedAt: 5_000, error: "Rate limited" },
        },
      })
      const agent = buildTaskCards(source(data))[0]!.agents[0]!
      expect(agent.status).toBe(expected)
      expect(agent.error).toBe(status === "error" ? "Rate limited" : undefined)
    }
  })

  test("a record from another call or a live record never overrides the part", () => {
    const data = fixture()
    addUser(data, "msg_u1", "go")
    addAssistant(data, "msg_a1", "msg_u1", [
      // The record moved on to a later run, so it says nothing about this call.
      taskPart({ id: "prt_1", callID: "call_1", metadata: running("ses_c1", "call_1") }),
      // The part settled while the record still says running.
      taskPart({
        id: "prt_2",
        callID: "call_2",
        metadata: lifecycle({ sessionId: "ses_c2", callID: "call_2", status: "completed" }),
      }),
    ])
    data.sessions.ses_c1 = child("ses_c1", {
      metadata: { subagent: { callID: "call_9", status: "completed", startedAt: 90_000, completedAt: 95_000 } },
    })
    data.sessions.ses_c2 = child("ses_c2", {
      metadata: { subagent: { callID: "call_2", status: "running", startedAt: 1_000 } },
    })
    const agents = buildTaskCards(source(data))[0]!.agents
    expect(agents.map((agent) => agent.status)).toEqual(["running", "done"])
  })

  test("the freshest copy of a session wins, whichever source it came from", () => {
    const stale = child("ses_c1", { time: { created: 50, updated: 60 } })
    const fresh = child("ses_c1", { time: { created: 50, updated: 9_000 } })
    expect(freshestSession(stale, fresh)).toBe(fresh)
    expect(freshestSession(fresh, stale)).toBe(fresh)
    expect(freshestSession(undefined, stale)).toBe(stale)
    expect(freshestSession(stale, undefined)).toBe(stale)
    expect(freshestSession(undefined, undefined)).toBeUndefined()
    // A tie keeps the store's copy, which live events keep current.
    const twin = child("ses_c1", { time: { created: 50, updated: 60 } })
    expect(freshestSession(stale, twin)).toBe(stale)
  })

  test("live agents whose child is not busy or retrying need a fresh copy, cached messages or not", () => {
    const agents = [
      { sessionID: "ses_cached", status: "running" as const },
      { sessionID: "ses_idle", status: "pending" as const },
      { sessionID: "ses_busy", status: "running" as const },
      { sessionID: "ses_retry", status: "waiting" as const },
      { sessionID: "ses_done", status: "done" as const },
      { sessionID: "ses_cached", status: "running" as const },
      { sessionID: undefined, status: "pending" as const },
    ]
    const status: Record<string, SessionStatus["type"]> = { ses_busy: "busy", ses_retry: "retry", ses_cached: "idle" }
    expect(idleLiveSessions(agents, (id) => status[id])).toEqual(["ses_cached", "ses_idle"])
    expect(idleLiveSessions([], () => undefined)).toEqual([])
  })
})

test("child usage retains own-key step tokens and suppresses Codium raw usage", () => {
  const data = fixture()
  const tokens = { input: 90000, output: 10000, reasoning: 0, cache: { read: 0, write: 0 } }
  addAssistant(
    data,
    "codium",
    "user",
    [{ id: "codium-step", type: "step-finish", reason: "stop", cost: 9, tokens } as Part],
    { providerID: "vector-plan", tokens },
    "ses_child",
  )
  addAssistant(
    data,
    "own",
    "user",
    [
      {
        id: "own-step",
        type: "step-finish",
        reason: "stop",
        cost: 0.12,
        tokens: { ...tokens, input: 50, output: 10 },
      } as Part,
    ],
    {},
    "ses_child",
  )
  expect(childFacts(source(data), "ses_child")).toMatchObject({ tokens: 60, codiumSteps: 1 })
  delete data.parts.codium
  delete data.parts.own
  expect(childFacts(source(data), "ses_child")).toMatchObject({ tokens: 0, codiumSteps: 1 })
})

test("unknown child aggregate and identity cannot be relabeled as proven own usage", () => {
  const data = fixture()
  data.sessions.ses_old = child("ses_old", {
    tokens: { input: 987654, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  expect(childFacts(source(data), "ses_old").tokens).toBeUndefined()
  expect(childFacts(source(data), "ses_old").tokensOwnOnly).toBeFalse()
  addAssistant(
    data,
    "missing",
    "user",
    [],
    { providerID: "  ", tokens: { input: 987654, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    "ses_old",
  )
  expect(childFacts(source(data), "ses_old").tokens).toBeUndefined()
  addAssistant(
    data,
    "own",
    "user",
    [],
    { tokens: { input: 123, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    "ses_old",
  )
  expect(childFacts(source(data), "ses_old")).toMatchObject({ tokens: 123, tokensOwnOnly: true })
})

test("a forged lifecycle proof cannot certify raw metadata totals", () => {
  const data = fixture()
  addUser(data, "user", "go")
  addAssistant(data, "assistant", "user", [
    taskPart({
      id: "task",
      metadata: lifecycle({ sessionId: "ses_forged", usage: { ...usage(987654), tokensOwnOnly: true } }),
    }),
  ])
  data.sessions.ses_forged = child("ses_forged", {
    metadata: { subagent: { usage: { ...usage(987654), tokensOwnOnly: true } } },
  })
  expect(buildTaskCards(source(data))[0]?.agents[0]?.tokens).toBeUndefined()
  data.sessions.ses_forged = {
    ...data.sessions.ses_forged!,
    tokensOwnOnly: true,
    tokens: { input: 123, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  expect(buildTaskCards(source(data))[0]?.agents[0]?.tokens).toBe(123)
})

describe("1.99.113 lifecycle fields", () => {
  test("the part's mirror and the child's record read the same", () => {
    const part = readLifecycle({
      effort: "high",
      fork: true,
      modelSource: "fork",
      inheritedTokens: 12_000,
      queuedReason: "Waiting for a free subagent slot",
      structured: { valid: true, attempts: 2 },
      isolation: { mode: "worktree", state: "changed", branch: "vector/task-c1", files: 2, additions: 9, deletions: 1 },
      groupID: "workflow:ses_run",
      workflow: {
        role: "agent",
        runID: "ses_run",
        stage: "scan",
        phase: "find",
        item: "a.ts",
        key: "scan:0",
        round: 1,
      },
    })
    expect(part).toMatchObject({
      effort: "high",
      fork: true,
      queuedReason: "Waiting for a free subagent slot",
      result: { format: "json", valid: true, attempts: 2 },
      isolation: { mode: "worktree", state: "changed", branch: "vector/task-c1", files: 2, additions: 9, deletions: 1 },
      groupID: "workflow:ses_run",
      workflow: { role: "agent", runID: "ses_run", stage: "scan", phase: "find", item: "a.ts", round: 1 },
    })
    const stored = readLifecycle({
      effort: "low",
      fork: { point: "msg_1", callID: "call_1", warm: true },
      slotReason: "Waiting for the launching response",
      structured: { schema: { type: "object" }, schemaHash: "abc", attempts: 1 },
      interruption: { at: 5, cause: "crash", reportedAt: 6 },
      waiting: { kind: "question", requestID: "que_1", since: 40, notedAt: 41, summary: "Which file?" },
      workflow: {
        role: "run",
        title: "Audit",
        revision: 1,
        progress: {
          stages: [{ id: "scan", title: "Scan", total: 3, done: 1, failed: 1, skipped: 0, running: 1, waiting: 0 }],
          agents: { launched: 3, max: 100, running: 1 },
        },
      },
    })
    expect(stored).toMatchObject({
      effort: "low",
      fork: true,
      queuedReason: "Waiting for the launching response",
      result: { format: "json", attempts: 1 },
      interrupted: { at: 5, cause: "crash" },
      waiting: { kind: "question", since: 40, summary: "Which file?" },
      workflow: {
        role: "run",
        title: "Audit",
        stages: [
          { id: "scan", title: "Scan", phase: "", total: 3, done: 1, failed: 1, skipped: 0, running: 1, waiting: 0 },
        ],
        agents: { launched: 3, max: 100, running: 1 },
      },
    })
    expect(stored.result?.valid).toBeUndefined()
  })

  test("malformed new fields are dropped, never trusted or thrown on", () => {
    const value = readLifecycle({
      effort: "<script>",
      fork: "yes",
      structured: "valid",
      result: { format: 7 },
      queuedReason: 3,
      isolation: { mode: "worktree", directory: "/secret" },
      interruption: { cause: "crash" },
      waiting: { kind: "permission", since: "now" },
      workflow: { runID: "ses_run" },
      groupID: ["workflow:x"],
    })
    expect(value.effort).toBeUndefined()
    expect(value.fork).toBeUndefined()
    expect(value.result).toBeUndefined()
    expect(value.queuedReason).toBeUndefined()
    expect(value.isolation).toBeUndefined()
    expect(value.interrupted).toBeUndefined()
    expect(value.waiting).toBeUndefined()
    expect(value.workflow).toBeUndefined()
    expect(value.groupID).toBeUndefined()
    // A directory is never read into the display copy, and the conflict list is bounded.
    const isolation = readLifecycle({
      isolation: {
        mode: "worktree",
        state: "changed",
        directory: "/secret",
        files: -1,
        conflicts: [...Array.from({ length: 60 }, (_, index) => `f${index}`), 5],
      },
    }).isolation!
    expect("directory" in isolation).toBe(false)
    expect(isolation.files).toBeUndefined()
    expect(isolation.conflicts).toHaveLength(50)
    // A cause a newer engine adds is still an interruption.
    expect(readLifecycle({ interruption: { at: 1, cause: 42 } }).interrupted).toEqual({ at: 1, cause: "unknown" })
  })

  test("part metadata and the record reach the agent; a queued reason only while it waits", () => {
    const data = fixture()
    addUser(data, "msg_u1", "go")
    addAssistant(data, "msg_a1", "msg_u1", [
      taskPart({
        id: "prt_1",
        status: "running",
        metadata: lifecycle({
          sessionId: "ses_q",
          callID: "call_prt_1",
          status: "queued",
          effort: "medium",
          fork: true,
          queuedReason: "Waiting for a free subagent slot",
          structured: { attempts: 0 },
        }),
      }),
      taskPart({
        id: "prt_2",
        metadata: lifecycle({
          sessionId: "ses_i",
          status: "cancelled",
          queuedReason: "Waiting for a free subagent slot",
          isolation: { mode: "worktree", state: "changed", files: 1 },
        }),
      }),
    ])
    data.sessions.ses_i = child("ses_i", {
      metadata: { subagent: lifecycle({ status: "cancelled", interruption: { at: 9, cause: "shutdown" } }) },
    })
    const agents = buildTaskCards(source(data))[0]!.agents
    const queued = agents.find((agent) => agent.sessionID === "ses_q")!
    expect(queued).toMatchObject({
      status: "pending",
      effort: "medium",
      fork: true,
      queuedReason: "Waiting for a free subagent slot",
      result: { format: "json", attempts: 0 },
    })
    const stopped = agents.find((agent) => agent.sessionID === "ses_i")!
    expect(stopped.status).toBe("stopped")
    expect(stopped.queuedReason).toBeUndefined()
    expect(stopped.isolation).toMatchObject({ mode: "worktree", state: "changed", files: 1 })
    expect(stopped.interrupted).toEqual({ at: 9, cause: "shutdown" })
    expect(isInterrupted(stopped)).toBe(true)
    expect(isInterrupted({ ...stopped, interrupted: { at: 9, cause: "shutdown", resumedAt: 10 } })).toBe(false)
    expect(isInterrupted({ ...stopped, interrupted: { at: 9, cause: "shutdown", dismissedAt: 10 } })).toBe(false)
    expect(isInterrupted({ ...stopped, status: "running" })).toBe(false)
  })
})

describe("1.99.113 labels", () => {
  const model = { providerID: "anthropic", modelID: "claude-opus-5", name: "Claude Opus 5", short: "Opus 5" }

  test("model as short · effort, with default effort left out", () => {
    expect(modelEffortLabel({ model, effort: "high" })).toBe("Opus 5 · high")
    expect(modelEffortLabel({ model, effort: "default" })).toBe("Opus 5")
    expect(modelEffortLabel({ model })).toBe("Opus 5")
    expect(modelEffortLabel({ effort: "low" })).toBe("low")
    expect(modelEffortLabel({})).toBeUndefined()
  })

  test("queued, waiting and worktree lines", () => {
    expect(queuedLabel("Waiting for a free subagent slot")).toBe("Queued: waiting for a free subagent slot")
    expect(queuedLabel("OAuth refresh pending")).toBe("Queued: OAuth refresh pending")
    expect(waitingLabel({ kind: "permission", since: 0 }, 3 * 60_000 + 5_000)).toBe("Needs your permission · 3m")
    expect(waitingLabel({ kind: "question", since: 1_000 }, 20_000)).toBe("Needs your answer · <1m")
    expect(waitingLabel({ kind: "permission", since: 50_000 }, 0)).toBe("Needs your permission · <1m")
    expect(isolationLabel({ mode: "worktree", state: "changed", branch: "vector/task-c1", files: 3 })).toBe(
      "Worktree: vector/task-c1 · changed · 3 files changed",
    )
    expect(isolationLabel({ mode: "copy", state: "unchanged", files: 1 })).toBe("Copy: unchanged · 1 file changed")
    expect(isolationLabel({ mode: "worktree", state: "preparing" })).toBe("Worktree: preparing")
  })

  test("the JSON chip is green when valid, red when it failed, and absent for text results", () => {
    expect(resultChip({ format: "json", valid: true })).toMatchObject({ state: "valid", label: "JSON" })
    expect(resultChip({ format: "json", valid: false, attempts: 3 })).toEqual({
      state: "invalid",
      label: "JSON",
      title: "Its JSON answer did not match the schema after 3 attempts",
    })
    expect(resultChip({ format: "json" })?.state).toBe("pending")
    expect(resultChip({ format: "text" })).toBeUndefined()
    expect(resultChip(undefined)).toBeUndefined()
  })

  test("a workflow run's loaded agents leave the counts as they were with the run row alone", () => {
    const task = (id: string, workflow: Record<string, unknown>) =>
      ({ id, workflow }) as unknown as NonNullable<
        Parameters<typeof liveAgentCount>[0][number]["agents"][number]["task"]
      >
    const run = {
      key: "r",
      sessionID: "ses_run",
      status: "running" as const,
      task: task("ses_run", { role: "run", runID: "ses_run" }),
    }
    const agents = ["w1", "w2"].map((id) => ({
      key: id,
      sessionID: id,
      status: "waiting" as const,
      task: task(id, { role: "agent", runID: "ses_run", stage: "scan" }),
    }))
    expect(liveAgentCount([{ agents: [run, ...agents] }])).toBe(1)
    expect(runningAgentCount([{ agents: [run, ...agents] }])).toBe(1)
    expect(waitingAgentCount([{ agents: [run, ...agents] }])).toBe(0)
    // Without their run row they count as themselves.
    expect(liveAgentCount([{ agents }])).toBe(2)
  })
})
