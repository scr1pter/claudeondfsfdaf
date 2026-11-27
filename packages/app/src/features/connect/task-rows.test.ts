import { expect, test } from "bun:test"
import { Connect } from "@vectordevai/schema/connect"
import { SessionID } from "@vectordevai/schema/session-id"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { createConnectClient } from "./client"
import { MAX_TASK_ROWS, cancelTaskRow, goingFirst, readTaskRows, runState, taskRows } from "./task-rows"
import { finding, reviewRun, sessionID } from "./test-fixture"

const review: Connect.Action = { id: "review", title: "Review", effects: ["read"], background: true, result: "review" }
const vectorscope: Connect.Member = {
  id: "vectorscope",
  kind: "agent",
  title: "VectorScope",
  summary: "Review selected changes.",
  owner: "vectorscope",
  place: "local",
  sendsTo: "this-computer",
  state: "ready",
  reach: "connect",
  actions: [review],
}
const codium: Connect.Member = {
  id: "codium",
  kind: "service",
  title: "Vector Codium",
  summary: "Review on Vector's servers.",
  owner: "codium",
  place: "vector-cloud",
  sendsTo: "vector-codium",
  state: "ready",
  reach: "connect",
  actions: [review],
}

function run(id: string, change: Partial<Connect.Run> = {}): Connect.Run {
  const base = reviewRun()
  const runID = Connect.RunID.make(id)
  return { ...base, id: runID, request: { ...base.request, id: runID }, ...change }
}

function going(id: string, status: "queued" | "running" = "running", message?: string): Connect.Run {
  return run(id, {
    status,
    result: undefined,
    progress: message ? { message, at: 4 } : undefined,
    time: { created: 1, started: 2 },
  })
}

function ended(id: string, result: Partial<Connect.Result> = {}): Connect.Run {
  return run(id, { result: { ...reviewRun().result!, ...result } })
}

function to(member: string, value: Connect.Run): Connect.Run {
  return { ...value, request: { ...value.request, to: member } }
}

/** The real directory-scoped SDK transport over a recording fetch that never leaves the process. */
function engine(answer: {
  runs?: () => Response | Promise<Response>
  members?: () => Response | Promise<Response>
  cancel?: (signal: AbortSignal) => Response | Promise<Response>
}) {
  const calls: { method: string; path: string; query: URLSearchParams }[] = []
  const client = createConnectClient(
    createVectorClient({
      baseUrl: "http://engine.test",
      directory: "/fixture/project",
      fetch: async (request) => {
        const url = new URL(request.url)
        calls.push({ method: request.method, path: url.pathname, query: url.searchParams })
        if (url.pathname === "/experimental/connect/runs") return answer.runs?.() ?? Response.json([])
        if (url.pathname === "/experimental/connect") return answer.members?.() ?? Response.json([])
        if (url.pathname.endsWith("/cancel")) return answer.cancel?.(request.signal) ?? Response.json(true)
        return Response.json({ message: "Unexpected route" }, { status: 404 })
      },
    }),
  )
  return { client, calls }
}

/** An owner read that answered with runs; a refused or failed read, or none, fails the case. */
async function answered(input: Parameters<typeof readTaskRows>[0]) {
  const read = await readTaskRows(input)
  if (read === undefined || typeof read === "string") throw new Error(`Expected an owner read, got ${read}.`)
  return read
}

test("an owner read maps running and finished reviews to rows over the registry member", async () => {
  const done = ended("cr_done", {
    state: "completed",
    verdict: "findings",
    sendsTo: "provider:anthropic",
    cost: { kind: "priced", usd: 0.42 },
  })
  const fake = engine({
    runs: () => Response.json([done, going("cr_running", "running", "Reviewing src/example.ts")]),
    members: () => Response.json([vectorscope]),
  })
  const read = await answered({ client: fake.client, sessionID, connections: true })
  expect(read.rows).toStrictEqual([
    {
      id: Connect.RunID.make("cr_running"),
      title: "VectorScope",
      action: "Review",
      status: "Running",
      tone: "running",
      verdict: undefined,
      sendsTo: "Sends code to: This computer",
      spend: undefined,
      detail: "Reviewing src/example.ts",
      cancellable: true,
    },
    {
      id: Connect.RunID.make("cr_done"),
      title: "VectorScope",
      action: "Review",
      status: "Done",
      tone: "done",
      verdict: "Findings",
      sendsTo: "Code sent to: Your provider: anthropic",
      spend: "$0.42",
      detail: undefined,
      cancellable: false,
    },
  ])
  expect(read.members.map((member) => member.id)).toEqual(["vectorscope"])
  expect(fake.calls.map((call) => [call.method, call.path])).toEqual([
    ["GET", "/experimental/connect/runs"],
    ["GET", "/experimental/connect"],
  ])
  expect(fake.calls.every((call) => call.query.get("sessionID") === sessionID)).toBe(true)
  expect(fake.calls.every((call) => call.query.get("directory") === "/fixture/project")).toBe(true)
})

test("a fix run has no verdict, an unknown member shows its id and no spend it cannot place, and other sessions' and directory runs are dropped", () => {
  const base = reviewRun()
  const fixID = Connect.RunID.make("cr_fix")
  const fix: Connect.Run = {
    ...base,
    id: fixID,
    request: {
      id: fixID,
      to: "fixer",
      action: "fix",
      requester: { kind: "agent", sessionID },
      requestID: "message-fix",
      directory: "/fixture/project",
      background: true,
      run: base.id,
      findings: [finding.id],
      mode: "worktree",
    },
    result: {
      state: "completed",
      summary: "Applied the fix.",
      findings: [],
      sessions: [],
      notes: [],
      cost: { kind: "free" },
    },
  }
  const other = run("cr_other", {
    request: {
      ...base.request,
      id: Connect.RunID.make("cr_other"),
      requester: { kind: "user", sessionID: SessionID.make("ses_other_fixture") },
    },
  })
  const directory = run("cr_directory", {
    request: { ...base.request, id: Connect.RunID.make("cr_directory"), requester: { kind: "user" } },
  })
  const rows = taskRows({ sessionID, runs: [fix, other, directory], members: [vectorscope] })
  expect(rows.map((row) => row.id)).toEqual([fixID])
  expect(rows[0]).toMatchObject({
    title: "fixer",
    action: "Fix",
    status: "Done",
    verdict: undefined,
    spend: "Usage unavailable",
  })
})

test("runs still going come first and the cap never cuts one", () => {
  const finished = Array.from({ length: 12 }, (_, index) => ended(`cr_done_${index}`))
  expect(taskRows({ sessionID, runs: finished })).toHaveLength(MAX_TASK_ROWS)
  const many = Array.from({ length: 11 }, (_, index) => going(`cr_going_${index}`))
  const crowded = taskRows({ sessionID, runs: [...finished.slice(0, 3), ...many] })
  expect(crowded.map((row) => row.id)).toEqual(many.map((value) => value.id))
  // At most 10 rows in all: four runs going leave room for six finished ones, newest first as the engine sent them.
  const mixed = taskRows({
    sessionID,
    runs: [
      finished[0],
      going("cr_a"),
      finished[1],
      going("cr_b", "queued"),
      ...finished.slice(2),
      going("cr_c"),
      going("cr_d"),
    ],
  })
  expect(mixed.map((row) => String(row.id))).toEqual([
    "cr_a",
    "cr_b",
    "cr_c",
    "cr_d",
    ...finished.slice(0, 6).map((value) => String(value.id)),
  ])
})

test("without connections or a session nothing is read and nothing shows", async () => {
  const fake = engine({ runs: () => Response.json([ended("cr_done")]) })
  expect(await readTaskRows({ client: fake.client, sessionID, connections: false })).toBeUndefined()
  expect(await readTaskRows({ client: fake.client, sessionID: undefined, connections: true })).toBeUndefined()
  expect(fake.calls).toEqual([])
})

test("a guest's refusal and an engine refusal are refused, and never read the registry", async () => {
  const refusals = [
    () => Response.json({ message: "This operation requires the server owner" }, { status: 403 }),
    ...["forbidden", "disabled", "invalid"].map(
      (code) => () => Response.json({ code, message: "Connected tools refused this." }, { status: 400 }),
    ),
  ]
  for (const runs of refusals) {
    const fake = engine({ runs, members: () => Response.json([vectorscope]) })
    expect(await readTaskRows({ client: fake.client, sessionID, connections: true })).toBe("refused")
    expect(fake.calls.map((call) => call.path)).toEqual(["/experimental/connect/runs"])
  }
})

test("a dropped, timed-out, failing or unreadable read is a failure, not a refusal, and never reads the registry", async () => {
  const failures: (() => Response)[] = [
    () => {
      throw new TypeError("fetch failed")
    },
    () => {
      throw new DOMException("The operation timed out.", "TimeoutError")
    },
    () => {
      throw new DOMException("The operation was aborted.", "AbortError")
    },
    () => Response.json({ message: "Internal error" }, { status: 500 }),
    () => Response.json({ message: "Bad gateway" }, { status: 502 }),
    () => Response.json([{ id: "cr_not_a_run" }]),
  ]
  for (const runs of failures) {
    const fake = engine({ runs, members: () => Response.json([vectorscope]) })
    expect(await readTaskRows({ client: fake.client, sessionID, connections: true })).toBe("failed")
    expect(fake.calls.map((call) => call.path)).toEqual(["/experimental/connect/runs"])
  }
})

test("an owner read with no runs shows no rows and skips the registry", async () => {
  const fake = engine({ runs: () => Response.json([]) })
  expect(await readTaskRows({ client: fake.client, sessionID, connections: true })).toEqual({ rows: [], members: [] })
  expect(fake.calls.map((call) => call.path)).toEqual(["/experimental/connect/runs"])
})

test("the registry is read only for a member the caller does not know, and a failed read keeps the ids", async () => {
  const known = engine({ runs: () => Response.json([going("cr_running")]) })
  const cached = await answered({ client: known.client, sessionID, connections: true, members: [vectorscope] })
  expect(cached.rows[0]?.title).toBe("VectorScope")
  expect(known.calls.map((call) => call.path)).toEqual(["/experimental/connect/runs"])

  const unknown = engine({
    runs: () => Response.json([going("cr_running"), to("codium", going("cr_codium"))]),
    members: () => Response.json([vectorscope, codium]),
  })
  const listed = await answered({ client: unknown.client, sessionID, connections: true, members: [vectorscope] })
  expect(listed.rows.map((row) => row.title)).toEqual(["VectorScope", "Vector Codium"])
  expect(unknown.calls.map((call) => call.path)).toEqual(["/experimental/connect/runs", "/experimental/connect"])

  const failing = engine({
    runs: () => Response.json([to("codium", going("cr_codium"))]),
    members: () => Response.json({ message: "Owner only" }, { status: 403 }),
  })
  const fallback = await answered({ client: failing.client, sessionID, connections: true, members: [vectorscope] })
  expect(fallback.rows.map((row) => row.title)).toEqual(["codium"])
  expect(fallback.members).toEqual([vectorscope])
  expect(failing.calls.map((call) => call.path)).toEqual(["/experimental/connect/runs", "/experimental/connect"])
})

test("only queued and running rows can be cancelled; a refused or failed row explains itself", () => {
  const rows = taskRows({
    sessionID,
    members: [vectorscope],
    runs: [
      going("cr_queued", "queued"),
      going("cr_running"),
      ended("cr_completed", { state: "completed", verdict: "clean", findings: [] }),
      ended("cr_partial"),
      ended("cr_refused", {
        state: "refused",
        verdict: undefined,
        refusal: "budget",
        summary: "The review cap was reached.",
      }),
      ended("cr_failed", { state: "failed", verdict: undefined, summary: "The review model did not answer." }),
      ended("cr_cancelled", { state: "cancelled", verdict: undefined }),
    ],
  })
  expect(rows.map((row) => [String(row.id), row.status, row.tone, row.cancellable])).toEqual([
    ["cr_queued", "Queued", "pending", true],
    ["cr_running", "Running", "running", true],
    ["cr_completed", "Done", "done", false],
    ["cr_partial", "Partial", "done", false],
    ["cr_refused", "Refused", "failed", false],
    ["cr_failed", "Failed", "failed", false],
    ["cr_cancelled", "Cancelled", "stopped", false],
  ])
  expect(rows.map((row) => row.verdict)).toEqual([
    undefined,
    undefined,
    "No blocking findings",
    "Incomplete review",
    undefined,
    undefined,
    undefined,
  ])
  expect(rows.map((row) => row.detail)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    "The review cap was reached.",
    "The review model did not answer.",
    undefined,
  ])
})

test("cancel posts through the owner transport and reports whether the run was still going", async () => {
  const row = { id: Connect.RunID.make("cr_running"), cancellable: true }
  const yes = engine({ cancel: () => Response.json(true) })
  expect(await cancelTaskRow({ client: yes.client, sessionID, row })).toBe("cancelled")
  expect(yes.calls).toHaveLength(1)
  expect(yes.calls[0].method).toBe("POST")
  expect(yes.calls[0].path).toBe("/experimental/connect/runs/cr_running/cancel")
  expect(yes.calls[0].query.get("sessionID")).toBe(sessionID)
  expect(yes.calls[0].query.get("directory")).toBe("/fixture/project")
  const no = engine({ cancel: () => Response.json(false) })
  expect(await cancelTaskRow({ client: no.client, sessionID, row })).toBe("ended")
  const guest = engine({ cancel: () => Response.json({ message: "Owner only" }, { status: 403 }) })
  expect(await cancelTaskRow({ client: guest.client, sessionID, row })).toBe("failed")
  const finished = engine({})
  expect(await cancelTaskRow({ client: finished.client, sessionID, row: { ...row, cancellable: false } })).toBe("ended")
  expect(finished.calls).toEqual([])
  const hung = engine({
    cancel: (signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  })
  expect(await cancelTaskRow({ client: hung.client, sessionID, row, signal: AbortSignal.timeout(20) })).toBe("failed")
  expect(hung.calls.map((call) => call.path)).toEqual(["/experimental/connect/runs/cr_running/cancel"])
})

test("a finished row names only where its result says the code went", () => {
  const model: Connect.Member = { ...vectorscope, sendsTo: "model-server:gpu.local" }
  const rows = taskRows({
    sessionID,
    members: [model],
    runs: [
      going("cr_going"),
      ended("cr_here", { sendsTo: "this-computer" }),
      ended("cr_model", { sendsTo: "model-server:gpu.local" }),
      ended("cr_none", { sendsTo: undefined }),
    ],
  })
  expect(rows.map((row) => row.sendsTo)).toEqual([
    "Sends code to: Your model server: gpu.local",
    "Code sent to: This computer",
    "Code sent to: Your model server: gpu.local",
    "Code sent to: No destination reported",
  ])
})

test("in a Vector cloud workspace a run on the engine's own machine never reads this computer (CW-24)", () => {
  const cloud: Connect.Member = { ...vectorscope, place: "vector-cloud" }
  const rows = taskRows({
    sessionID,
    members: [cloud],
    runs: [going("cr_going"), ended("cr_here", { sendsTo: "this-computer" })],
  })
  expect(rows.map((row) => row.sendsTo)).toEqual([
    "Sends code to: This Vector cloud workspace",
    "Code sent to: This Vector cloud workspace",
  ])
  // A member on this computer, or one the registry does not know, keeps the words it had.
  expect(
    taskRows({ sessionID, members: [], runs: [ended("cr_unknown", { sendsTo: "this-computer" })] }).map(
      (row) => row.sendsTo,
    ),
  ).toEqual(["Code sent to: This computer"])
})

test("a Codium member's runs show plan usage, never dollars or tokens", () => {
  const rows = taskRows({
    sessionID,
    members: [codium],
    runs: [
      to("codium", going("cr_codium_going")),
      to("codium", ended("cr_codium_priced", { sendsTo: undefined, cost: { kind: "priced", usd: 1.25 } })),
      to("codium", ended("cr_codium_plan", { sendsTo: "vector-codium", cost: { kind: "plan" } })),
    ],
  })
  expect(rows.map((row) => row.spend)).toEqual(["Plan usage", "Plan usage", "Plan usage"])
  const text = JSON.stringify(rows)
  expect(text).not.toContain("$")
  expect(text).not.toMatch(/token/i)
  expect(text).not.toContain("1.25")
  const priced = taskRows({
    sessionID,
    members: [vectorscope],
    runs: [ended("cr_priced", { sendsTo: "provider:anthropic", cost: { kind: "priced", usd: 1.25 } })],
  })
  expect(priced[0]?.spend).toBe("$1.25")
})

test("with the registry unread a run shows dollars only when its result names a destination other than Codium", async () => {
  const failing = engine({
    runs: () =>
      Response.json([
        to("codium", ended("cr_codium_priced", { sendsTo: undefined, cost: { kind: "priced", usd: 1.25 } })),
        to("elsewhere", ended("cr_provider", { sendsTo: "provider:anthropic", cost: { kind: "priced", usd: 0.5 } })),
      ]),
    members: () => Response.json({ message: "Owner only" }, { status: 403 }),
  })
  const read = await answered({ client: failing.client, sessionID, connections: true })
  expect(read.members).toEqual([])
  expect(read.rows.map((row) => [row.title, row.spend])).toEqual([
    ["codium", "Usage unavailable"],
    ["elsewhere", "$0.50"],
  ])
  expect(JSON.stringify(read.rows)).not.toContain("1.25")
  expect(failing.calls.map((call) => call.path)).toEqual(["/experimental/connect/runs", "/experimental/connect"])
})

test("finding text never reaches a row and a row carries no action besides cancel", () => {
  const rows = taskRows({
    sessionID,
    members: [vectorscope],
    runs: [
      going("cr_running", "running", "Reviewing src/example.ts"),
      ended("cr_done"),
      ended("cr_failed", { state: "failed", verdict: undefined }),
    ],
  })
  const text = JSON.stringify(rows)
  expect(text).not.toContain(finding.title)
  expect(text).not.toContain(finding.body)
  for (const row of rows)
    expect(Object.keys(row).sort()).toEqual([
      "action",
      "cancellable",
      "detail",
      "id",
      "sendsTo",
      "spend",
      "status",
      "title",
      "tone",
      "verdict",
    ])
})

test("the row order and the run states are shared with the phone's runs list (CW-23c)", () => {
  const done = Array.from({ length: 12 }, (_, index) => ({ id: `d${index}`, going: false }))
  const rows = goingFirst([...done, { id: "g1", going: true }], (item) => item.going)
  expect(rows.map((item) => item.id)).toEqual(["g1", ...done.slice(0, MAX_TASK_ROWS - 1).map((item) => item.id)])
  expect(runState({ status: "queued" })).toEqual({ status: "Queued", tone: "pending" })
  expect(runState({ status: "running" })).toEqual({ status: "Running", tone: "running" })
  expect(runState({ status: "done", result: { state: "partial" } })).toEqual({ status: "Partial", tone: "done" })
  expect(runState({ status: "done", result: { state: "cancelled" } })).toEqual({ status: "Cancelled", tone: "stopped" })
})
