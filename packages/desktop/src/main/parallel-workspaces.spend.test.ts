import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The spend ledger is one per process and takes its path from the first call,
// so every test in this file shares one user data folder.
const userDataPath = await mkdtemp(join(tmpdir(), "vector-parallel-spend-"))
const store = new Map<string, Map<string, unknown>>()
// parallel-workspaces pulls in the cloud and publish modules transitively, so
// the stub has to cover every electron export they touch at module load.
const electronMock = {
  app: { isPackaged: false, getPath: () => userDataPath, getVersion: () => "test", on: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => undefined, openPath: async () => "" },
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  Notification: class {
    static isSupported() {
      return false
    }
  },
  dialog: {},
  clipboard: {},
  systemPreferences: {},
  utilityProcess: {},
  net: {},
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))
mock.module("./store", () => ({
  getStore: (name = "default") => {
    if (!store.has(name)) store.set(name, new Map())
    const bucket = store.get(name)!
    return {
      get: (key: string) => bucket.get(key),
      set: (key: string, value: unknown) => bucket.set(key, value),
      delete: (key: string) => bucket.delete(key),
      path: join(userDataPath, `${name}.json`),
    }
  },
  removeStoreFileIfEmpty: () => undefined,
}))

const {
  createParallelWorkspace,
  getParallelWorkspace,
  listParallelWorkspaces,
  runParallelWorkspace,
  sweepTeamOutboxes,
} = await import("./parallel-workspaces")
const { addTeamMember, createAgentTeam, postTeamMessage } = await import("./agent-teams")
const { listBackgroundTasks } = await import("./background-tasks")
const { spendLedger } = await import("./spend-limits")

// A stand-in for the engine's HTTP API: a session costs $0.42 once prompted,
// is busy for one poll and then idle, and answers the spend route with
// whatever the test says.
type PromptBody = { prompt: { text: string }; budget?: { usd?: number } }
const engineState = {
  prompts: [] as { sessionId: string; body: PromptBody }[],
  prompted: new Set<string>(),
  activePolls: 0,
  activeFails: false,
  spend: (_sessionId: string): unknown => ({}),
  // The session's messages, none unless set.
  messages: (_sessionId: string): unknown[] => [],
  // Whether a prompted session is busy, else busy for the first poll only.
  busy: undefined as (() => boolean) | undefined,
  // What a prompted session has cost.
  cost: 0.42,
  tokens: { input: 100, output: 20 },
  codiumSteps: undefined as number | undefined,
  provider: "provider-test",
}
let sessionCount = 0
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname
    if (request.method === "POST" && path === "/session") {
      sessionCount += 1
      return Response.json({ id: `ses_spend_${sessionCount}` })
    }
    if (path === "/api/session/active") {
      if (engineState.activeFails) return new Response("engine wedged", { status: 500 })
      engineState.activePolls += 1
      const busy = engineState.busy?.() ?? engineState.activePolls === 1
      return Response.json({
        data: Object.fromEntries([...engineState.prompted].filter(() => busy).map((id) => [id, {}])),
      })
    }
    const match = /^\/api\/session\/([^/]+)(?:\/([a-z]+))?$/.exec(path)
    const sessionId = decodeURIComponent(match?.[1] ?? "")
    if (match && !match[2]) {
      const prompted = engineState.prompted.has(sessionId)
      return Response.json({
        data: {
          cost: prompted ? engineState.cost : 0,
          tokens: { input: prompted ? engineState.tokens.input : 0, output: prompted ? engineState.tokens.output : 0 },
          ...(engineState.codiumSteps === undefined ? {} : { codiumSteps: prompted ? engineState.codiumSteps : 0 }),
          model: { providerID: engineState.provider, id: "model-test" },
        },
      })
    }
    if (match?.[2] === "prompt") {
      engineState.prompts.push({ sessionId, body: (await request.json()) as PromptBody })
      engineState.prompted.add(sessionId)
      return Response.json({ data: { id: "msg_0001" } })
    }
    if (match?.[2] === "spend") return Response.json(engineState.spend(sessionId))
    if (match?.[2] === "message") return Response.json({ data: engineState.messages(sessionId) })
    return Response.json({})
  },
})
const engine = { url: `http://127.0.0.1:${server.port}`, username: null, password: null }

const stoppedSnapshot = (sessionId: string) => ({
  data: {
    sessionID: sessionId,
    state: "stopped",
    reason: "cap",
    message: "Spend cap reached: $0.42 spent against a $5.00 cap for this run.",
    budget: { usd: 5 },
    spentUsd: 0.42,
    steps: 4,
    unpricedSteps: 0,
    costKind: "priced",
  },
})

beforeAll(async () => {
  const ledger = await spendLedger()
  await ledger.setPolicy({ interactive: { perDay: { usd: 10 } } })
})

afterAll(async () => {
  server.stop(true)
  await rm(userDataPath, { recursive: true, force: true })
})

beforeEach(() => {
  engineState.prompts.length = 0
  engineState.prompted.clear()
  engineState.activePolls = 0
  engineState.activeFails = false
  engineState.spend = () => ({})
  engineState.messages = () => []
  engineState.busy = undefined
  engineState.cost = 0.42
  engineState.tokens = { input: 100, output: 20 }
  engineState.codiumSteps = undefined
  engineState.provider = "provider-test"
})

async function launch(name: string) {
  const sourcePath = join(userDataPath, name)
  await mkdir(sourcePath, { recursive: true })
  await writeFile(join(sourcePath, "README.md"), "# Spend\n", "utf8")
  const created = await createParallelWorkspace({
    name,
    taskPrompt: "Read README.md and report its title.",
    runtime: "vector",
    parentSessionId: "session-spend",
    provider: engineState.provider,
    model: "model-test",
    sourcePath,
  })
  await runParallelWorkspace(created.id, engine)
  return created
}

async function settle(id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    const record = listParallelWorkspaces().find((item) => item.id === id)
    if (
      record &&
      ["needs review", "complete", "failed", "stopped"].includes(record.status) &&
      (record.actualCost || record.costKind !== undefined)
    )
      return record
  }
  throw new Error("the Vector-runtime run never settled")
}

async function ledgerEventsFor(id: string) {
  const ledger = await spendLedger()
  return (await ledger.recentEvents()).filter((event) => event.runId.startsWith(`${id}:`))
}

async function headroomSeenByAnotherRun() {
  const ledger = await spendLedger()
  const allowance = await ledger.checkAllowance({ runId: "someone-else", source: "parallel" })
  return allowance.remainingUsd ?? 0
}

describe("a Vector-runtime parallel agent's spend", () => {
  test("a guard stop fails the run, and its measured cost reaches the ledger and the card", async () => {
    engineState.spend = (sessionId) => (engineState.prompted.has(sessionId) ? stoppedSnapshot(sessionId) : {})
    const headroom = await headroomSeenByAnotherRun()
    const created = await launch("stopped")

    const record = await settle(created.id)

    // No per-run limit is set, so the run holds half of the day's headroom.
    expect(engineState.prompts[0]?.body).toMatchObject({ resume: true, budget: { usd: headroom / 2 } })
    expect(record.status).toBe("failed")
    expect(record.logs.join("\n")).toContain("Stopped by spend guard: Spend cap reached")
    expect(record.actualCost).toBe("$0.42")
    const events = await ledgerEventsFor(created.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ costUsd: 0.42, tokens: 120, provider: "provider-test", source: "parallel" })
    expect(await headroomSeenByAnotherRun()).toBeCloseTo(headroom - 0.42)
  })

  test("a guard stop on a final answer leaves the run to its checks", async () => {
    engineState.spend = (sessionId) =>
      engineState.prompted.has(sessionId)
        ? {
            data: {
              ...stoppedSnapshot(sessionId).data,
              message:
                "Spend cap reached: $0.42 spent against a $0.40 cap for this run, on a step that ended its turn. Its answer stands, and Vector starts no further step under this cap.",
            },
          }
        : {}
    engineState.messages = (sessionId) =>
      engineState.prompted.has(sessionId) ? [{ type: "assistant", id: "msg_0002", finish: "stop" }] : []
    const created = await launch("final-answer")

    const record = await settle(created.id)

    expect(record.status).not.toBe("failed")
    expect(record.logs.join("\n")).not.toContain("Stopped by spend guard")
    expect(record.actualCost).toBe("$0.42")
  })

  test("a finished run's card shows its measured cost, not an estimate", async () => {
    engineState.spend = (sessionId) =>
      engineState.prompted.has(sessionId)
        ? { data: { ...stoppedSnapshot(sessionId).data, state: "ok", message: undefined } }
        : {}
    const created = await launch("finished")
    expect(created.estimatedCost).toBe("")

    const record = await settle(created.id)

    expect(record.status).not.toBe("failed")
    expect(record.actualCost).toBe("$0.42")
    expect((await ledgerEventsFor(created.id)).map((event) => event.costUsd)).toEqual([0.42])
  })

  test("a teammate note sent mid-drain keeps the drain's cap instead of counting its spend twice", async () => {
    const sourcePath = join(userDataPath, "mid-drain")
    await mkdir(sourcePath, { recursive: true })
    await writeFile(join(sourcePath, "README.md"), "# Spend\n", "utf8")
    const team = createAgentTeam({ name: "spend team", topology: "isolated", sourcePath })
    const created = await createParallelWorkspace({
      name: "mid-drain",
      taskPrompt: "Read README.md and report its title.",
      runtime: "vector",
      parentSessionId: "session-spend",
      sourcePath,
      teamId: team.id,
    })
    addTeamMember(team.id, created.id)
    const lead = await createParallelWorkspace({
      name: "Lead",
      taskPrompt: "Coordinate the task",
      runtime: "vector",
      parentSessionId: "session-spend",
      sourcePath,
      teamId: team.id,
    })
    addTeamMember(team.id, lead.id)
    // The drain runs under the cap its prompt was sent with and has spent $0.30 of it so far.
    let busy = true
    engineState.busy = () => busy
    engineState.cost = 0.3
    engineState.spend = (sessionId) =>
      engineState.prompted.has(sessionId)
        ? {
            data: {
              sessionID: sessionId,
              state: "ok",
              budget: { usd: engineState.prompts[0]?.body.budget?.usd },
              spentUsd: 0.3,
              steps: 2,
              unpricedSteps: 0,
              costKind: "priced",
            },
          }
        : {}
    await runParallelWorkspace(created.id, engine)
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (getParallelWorkspace(created.id)?.logs.some((log) => log.startsWith("Task admitted"))) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    postTeamMessage({
      teamId: team.id,
      fromWorkspaceId: lead.id,
      fromName: "Lead",
      toWorkspaceId: created.id,
      text: "The auth module moved to src/auth.",
    })
    await sweepTeamOutboxes(team.id)
    busy = false
    await settle(created.id)

    const cap = engineState.prompts[0]?.body.budget?.usd
    expect(cap).toBeGreaterThan(0.3)
    const note = engineState.prompts.find((item) => item.body.prompt.text.includes("The auth module moved"))
    expect(note?.body.budget).toEqual({ usd: cap })
  })

  test("a run that fails mid-drain is still measured in the finally and gives back its hold", async () => {
    engineState.activeFails = true
    engineState.spend = (sessionId) =>
      engineState.prompted.has(sessionId)
        ? { data: { ...stoppedSnapshot(sessionId).data, state: "ok", message: undefined } }
        : {}
    const headroom = await headroomSeenByAnotherRun()
    const created = await launch("wedged")

    const record = await settle(created.id)

    expect(record.status).toBe("failed")
    expect(record.actualCost).toBe("$0.42")
    const events = await ledgerEventsFor(created.id)
    expect(events.map((event) => event.costUsd)).toEqual([0.42])
    // Only what the run spent is counted; its hold is gone.
    expect(await headroomSeenByAnotherRun()).toBeCloseTo(headroom - 0.42)
  })
})

test("legacy zero-price Codium cards use pinned provider provenance without rewriting usage", async () => {
  engineState.provider = "vector-plan"
  engineState.cost = 0
  const created = await launch("legacy-codium-card")
  await settle(created.id)
  const bucket = store.get("parallel-workspaces-state")!
  const records = bucket.get("records") as Array<Record<string, unknown>>
  const legacy = {
    ...records.find((record) => record.id === created.id)!,
    billing: undefined,
    costKind: undefined,
    measuredCost: 0,
    actualCost: "$0.00",
  }
  bucket.set("records", [
    ...records.filter((record) => record.id !== created.id),
    legacy,
    { ...legacy, id: `${created.id}-own`, provider: "provider-test" },
  ])
  expect(getParallelWorkspace(created.id)?.billing).toBe("codium")
  expect(listParallelWorkspaces().find((record) => record.id === created.id)?.billing).toBe("codium")
  expect(getParallelWorkspace(`${created.id}-own`)?.billing).toBeUndefined()
  expect(
    (bucket.get("records") as Array<Record<string, unknown>>).find((record) => record.id === created.id)?.billing,
  ).toBeUndefined()
})

for (const mixed of [false, true]) {
  test(`${mixed ? "mixed" : "Codium-only"} parallel usage reaches the persisted card without a fake zero charge`, async () => {
    engineState.provider = "vector-plan"
    engineState.cost = mixed ? 0.12 : 0
    engineState.tokens = { input: mixed ? 80 : 0, output: 0 }
    engineState.codiumSteps = 3
    engineState.spend = (sessionId) =>
      engineState.prompted.has(sessionId)
        ? {
            data: {
              sessionID: sessionId,
              state: "ok",
              budget: {},
              spentUsd: engineState.cost,
              steps: mixed ? 4 : 3,
              unpricedSteps: 0,
              codiumSteps: 3,
              costKind: "codium",
            },
          }
        : {}
    const headroom = await headroomSeenByAnotherRun()
    const created = await launch(mixed ? "mixed-codium" : "only-codium")
    expect(created.billing).toBe("codium")
    expect(created.measuredCost).toBeUndefined()
    const record = await settle(created.id)
    expect(engineState.prompts[0]?.body.budget).toBeUndefined()
    expect(record.billing).toBe("codium")
    expect(record.measuredCost).toBe(engineState.cost)
    expect(record.actualCost).toBe(mixed ? "$0.12" : undefined)
    expect(record.costKind).toBe(mixed ? "priced" : "codium")
    const background = listBackgroundTasks({ taskId: "session-spend" }).find((task) => task.workspaceId === created.id)
    expect(background?.billing).toBe("codium")
    expect(background?.actualUsage).toBe(mixed ? "$0.12" : undefined)
    const events = await ledgerEventsFor(created.id)
    expect(events).toHaveLength(mixed ? 1 : 0)
    if (mixed) expect(events[0]).toMatchObject({ costUsd: 0.12, tokens: 80, billing: "codium" })
    expect(await headroomSeenByAnotherRun()).toBeCloseTo(headroom - engineState.cost)
  })
}
