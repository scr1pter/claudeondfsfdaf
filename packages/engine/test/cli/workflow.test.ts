import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import yargs from "yargs"
import { createVectorClient } from "@vectordevai/sdk/v2"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import type { Workflow } from "@vectordevai/schema/workflow"
import {
  assertWorkflowOwner,
  executeWorkflowCommand,
  formatWorkflowPlan,
  formatWorkflowResult,
  parseWorkflowInputs,
  readWorkflowSource,
  validateWorkflowOffline,
  WorkflowCommand,
} from "@/cli/cmd/workflow"
import { tmpdir } from "../fixture/fixture"

const marker = process.env[ChildEnvironment.AGENT_MARKER]
beforeEach(() => {
  delete process.env[ChildEnvironment.AGENT_MARKER]
})
afterEach(() => {
  if (marker === undefined) delete process.env[ChildEnvironment.AGENT_MARKER]
  else process.env[ChildEnvironment.AGENT_MARKER] = marker
})

const spec = {
  version: 1,
  title: "Review changes",
  inputs: { topic: { required: true } },
  stages: [{ id: "review", prompt: "Review {{inputs.topic}}", agent: "custom-reviewer", model: "custom/model" }],
}
const plan: Workflow.Plan = {
  title: "Review changes",
  stages: [
    {
      id: "review",
      title: "Review",
      phase: "",
      agent: "general",
      items: 1,
      serial: false,
      writes: "read only",
      asks: [],
    },
  ],
  maxAgents: 4,
  concurrency: 2,
  steps: 20,
  perAgentSteps: 5,
  minutes: 3,
  usd: 0.25,
  tokens: 1000,
}

test("file validation works offline and defers engine authority without inventing a plan", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "review.json")
  await Bun.write(file, JSON.stringify(spec))
  const result = await executeWorkflowCommand(undefined, { action: "validate", target: file, input: ["topic=changes"] })
  expect(result).toMatchObject({ ok: true, issues: [] })
  expect(result).not.toHaveProperty("plan")
  expect(formatWorkflowResult(result)).toContain("Agent, model, permission and configured limit checks require")
  expect(await readWorkflowSource("review-changes")).toEqual({ name: "review-changes" })
  await expect(executeWorkflowCommand(undefined, { action: "validate", target: "review-changes" })).rejects.toThrow(
    "requires --attach",
  )
})

test("offline validation catches malformed JSON, cycles, missing inputs and unknown input names", () => {
  expect(validateWorkflowOffline("{")).toMatchObject({ ok: false })
  expect(validateWorkflowOffline(JSON.stringify(spec)).issues).toContainEqual({
    path: "/inputs/topic",
    message: "Required workflow input is missing.",
  })
  const cycle = validateWorkflowOffline(
    JSON.stringify({
      version: 1,
      title: "Cycle",
      stages: [
        { id: "first", prompt: "One", after: ["second"] },
        { id: "second", prompt: "Two", after: ["first"] },
      ],
    }),
  )
  expect(cycle.ok).toBe(false)
  expect(cycle.issues.some((issue) => issue.message.includes("directed acyclic"))).toBe(true)
  expect(validateWorkflowOffline(JSON.stringify(spec), { topic: "work", extra: "no" }).issues).toContainEqual({
    path: "/inputs/extra",
    message: "Unknown workflow input.",
  })
})

test("offline nested saved workflows require the trusted server library", () => {
  const result = validateWorkflowOffline(
    JSON.stringify({ version: 1, title: "Nested", stages: [{ id: "review", workflow: "saved-review" }] }),
  )
  expect(result.ok).toBe(false)
  expect(result.issues.some((issue) => issue.message.includes("Use --attach to resolve trusted saved workflows"))).toBe(
    true,
  )
})

test("offline validation does not impose the default engine agent-count policy", () => {
  expect(validateWorkflowOffline(JSON.stringify({ ...spec, limits: { max_agents: 500 } }), { topic: "work" }).ok).toBe(
    true,
  )
})

test("input parsing preserves JSON, literal strings, empty strings and embedded equals", () => {
  expect(
    parseWorkflowInputs([
      "topic=a=b",
      "count=3",
      "enabled=false",
      "items=[1,2]",
      'config={"key":"value"}',
      "missing=null",
      "empty=",
      'quoted="3"',
    ]),
  ).toEqual({
    topic: "a=b",
    count: 3,
    enabled: false,
    items: [1, 2],
    config: { key: "value" },
    missing: null,
    empty: "",
    quoted: "3",
  })
  expect(Object.getPrototypeOf(parseWorkflowInputs(["topic=work"]))).toBeNull()
})

test("ambiguous, unsafe and oversized workflow inputs are refused before a request", () => {
  for (const value of [
    "missing-equals",
    "=empty-key",
    "__proto__=bad",
    "constructor=x",
    "prototype=x",
    "UPPER=x",
    "space key=x",
  ])
    expect(() => parseWorkflowInputs([value])).toThrow()
  expect(() => parseWorkflowInputs(["topic=one", "topic=two"])).toThrow("Duplicate")
  expect(() => parseWorkflowInputs(Array.from({ length: 17 }, (_, i) => `key${i}=value`))).toThrow("at most 16")
  expect(() => parseWorkflowInputs([`topic=${"é".repeat(4097)}`])).toThrow("8 KiB")
  expect(() => parseWorkflowInputs([`topic=${"\\".repeat(4096)}`])).toThrow("8 KiB")
})

test("workflow file reads enforce regular-file and actual byte bounds", async () => {
  await using tmp = await tmpdir()
  await expect(readWorkflowSource(tmp.path, true)).rejects.toThrow()
  const file = path.join(tmp.path, "large.json")
  await Bun.write(file, " ".repeat(256 * 1024 + 1))
  await expect(readWorkflowSource(file, true)).rejects.toThrow("256 KiB")
  await Bun.write(file, " ".repeat(256 * 1024))
  const loaded = await readWorkflowSource(file, true)
  expect("spec" in loaded && loaded.spec.length).toBe(256 * 1024)
})

test("workflow commands use the real SDK routes and preserve inputs and resume options", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "replacement.json")
  await Bun.write(file, JSON.stringify(spec))
  const requests: Request[] = []
  const client = fixture(requests)
  await executeWorkflowCommand(client, { action: "saved" })
  await executeWorkflowCommand(client, { action: "validate", target: "review-changes", input: ["topic=fixes"] })
  await executeWorkflowCommand(client, { action: "list", session: "parent" })
  await executeWorkflowCommand(client, { action: "show", session: "parent", target: "run-child" })
  await executeWorkflowCommand(client, {
    action: "resume",
    session: "parent",
    target: "run-child",
    file,
    input: ["topic=fixes"],
    retryFailed: false,
  })
  await executeWorkflowCommand(client, {
    action: "stop",
    session: "parent",
    target: "run-child",
    reason: "Requirements changed",
  })
  const operations = requests.filter((request) => new URL(request.url).pathname !== "/experimental/capabilities")
  expect(operations.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", "/experimental/workflow/saved"],
    ["POST", "/experimental/workflow/validate"],
    ["GET", "/experimental/session/parent/workflow"],
    ["GET", "/experimental/session/parent/workflow/run-child"],
    ["POST", "/experimental/session/parent/workflow/run-child/resume"],
    ["POST", "/experimental/session/parent/tasks/stop"],
  ])
  expect(await operations[1].json()).toEqual({ name: "review-changes", inputs: { topic: "fixes" } })
  expect(await operations[4].json()).toEqual({
    spec: JSON.stringify(spec),
    inputs: { topic: "fixes" },
    retryFailed: false,
  })
  expect(await operations[5].json()).toEqual({ taskIDs: ["run-child"], reason: "Requirements changed" })
  expect(requests).toHaveLength(12)
  for (const request of requests) {
    expect(request.headers.get("x-vector-directory")).toBe(encodeURIComponent("/fixture/workspace"))
    expect(new URL(request.url).searchParams.get("directory")).toBe("/fixture/workspace")
  }
})

test("workflow option parsing carries repeated inputs and --no-retry-failed into the SDK", async () => {
  const requests: Request[] = []
  const client = fixture(requests)
  await yargs([])
    .exitProcess(false)
    .command({
      ...WorkflowCommand,
      handler: async (args) => {
        await executeWorkflowCommand(client, args)
      },
    })
    .parseAsync([
      "workflow",
      "resume",
      "run-child",
      "--session",
      "parent",
      "--input",
      "topic=changes",
      "--input",
      "count=2",
      "--no-retry-failed",
    ])
  expect(await requests[1].json()).toEqual({ inputs: { topic: "changes", count: 2 }, retryFailed: false })
})

test("agent marker refuses resume and owner starts before transport but allows stop", async () => {
  process.env[ChildEnvironment.AGENT_MARKER] = ""
  const requests: Request[] = []
  const client = fixture(requests)
  await expect(
    executeWorkflowCommand(client, { action: "resume", session: "parent", target: "run-child" }),
  ).rejects.toThrow("Vector's agents cannot")
  await expect(assertWorkflowOwner("start workflows")).rejects.toThrow("terminal outside Vector")
  expect(requests).toHaveLength(0)
  await executeWorkflowCommand(client, { action: "stop", session: "parent", target: "run-child" })
  expect(requests).toHaveLength(2)
})

test("invalid selections and inputs never send a capability or mutation request", async () => {
  const requests: Request[] = []
  const client = fixture(requests)
  for (const action of ["list", "show", "resume", "stop"])
    await expect(executeWorkflowCommand(client, { action })).rejects.toThrow("requires --session")
  for (const action of ["show", "resume", "stop"])
    await expect(executeWorkflowCommand(client, { action, session: "parent" })).rejects.toThrow("run ID")
  await expect(
    executeWorkflowCommand(client, { action: "stop", session: "parent", target: "run-child", input: ["topic=x"] }),
  ).rejects.toThrow("--input")
  await expect(
    executeWorkflowCommand(client, {
      action: "resume",
      session: "parent",
      target: "run-child",
      input: ["topic=x", "topic=y"],
    }),
  ).rejects.toThrow("Duplicate")
  await expect(executeWorkflowCommand(client, { action: "invalid" })).rejects.toThrow("Unknown")
  expect(requests).toHaveLength(0)
})

test("missing and HTML capabilities give the update instruction before mutation", async () => {
  for (const response of [
    Response.json({}),
    new Response("<html>old server</html>", { headers: { "content-type": "text/html" } }),
    Response.json({}, { status: 404 }),
  ]) {
    const requests: Request[] = []
    const client = createVectorClient({
      baseUrl: "http://fixture.invalid",
      throwOnError: true,
      fetch: async (request) => {
        requests.push(request)
        return response
      },
    })
    await expect(
      executeWorkflowCommand(client, { action: "resume", session: "parent", target: "run-child" }),
    ).rejects.toThrow("predates 1.99.113")
    expect(requests).toHaveLength(1)
  }
})

test("permission-disabled workflows retain list, show and stop management", async () => {
  const requests: Request[] = []
  const client = fixture(requests, false)
  await expect(
    executeWorkflowCommand(client, { action: "resume", session: "parent", target: "run-child" }),
  ).rejects.toThrow("disabled")
  expect(requests).toHaveLength(1)
  await executeWorkflowCommand(client, { action: "list", session: "parent" })
  await executeWorkflowCommand(client, { action: "show", session: "parent", target: "run-child" })
  await executeWorkflowCommand(client, { action: "stop", session: "parent", target: "run-child" })
  expect(requests).toHaveLength(7)
})

test("capability authorization failures are not mislabeled as an old engine", async () => {
  const client = createVectorClient({
    baseUrl: "http://fixture.invalid",
    throwOnError: true,
    fetch: async () => Response.json({ message: "private" }, { status: 403 }),
  })
  await expect(executeWorkflowCommand(client, { action: "saved" })).rejects.toThrow("HTTP 403")
})

test("capability connection failures preserve the transport error", async () => {
  const client = createVectorClient({
    baseUrl: "http://fixture.invalid",
    throwOnError: true,
    fetch: async () => {
      throw new Error("Connection refused by the owning server")
    },
  })
  await expect(executeWorkflowCommand(client, { action: "saved" })).rejects.toThrow(
    "Connection refused by the owning server",
  )
})

test("plans render ceilings and sanitize remote terminal control text", () => {
  const output = formatWorkflowPlan({
    ...plan,
    title: "Review\x1b[2J\u202eevil",
    stages: [{ ...plan.stages[0], title: "Title\nforged", asks: ["ask\x1b[2J"], model: "test/model", effort: "high" }],
  })
  expect(output).toContain("4 agents · 2 concurrent · 20 steps · 5 steps/agent · 3 minutes · $0.25 · 1000 tokens")
  expect(output).toContain("test/model · high")
  expect(output).toContain("Titleforged")
  expect(output).not.toContain("\x1b")
  expect(output).not.toContain("\u202e")
})

function fixture(requests: Request[], workflows = true) {
  return createVectorClient({
    baseUrl: "http://fixture.invalid",
    directory: "/fixture/workspace",
    throwOnError: true,
    fetch: async (request) => {
      requests.push(request)
      const url = new URL(request.url)
      if (url.pathname === "/experimental/capabilities") return Response.json({ workflows })
      if (url.pathname.endsWith("/saved")) return Response.json({ workflows: [] })
      if (url.pathname.endsWith("/validate")) return Response.json({ ok: true, issues: [], warnings: [], plan })
      if (url.pathname.endsWith("/resume")) return Response.json({ runID: "run-child", title: plan.title, plan })
      if (url.pathname.endsWith("/stop")) return Response.json({ tasks: [] })
      if (url.pathname.endsWith("/workflow")) return Response.json({ runs: [] })
      return Response.json({ nodes: [], truncated: false })
    },
  })
}
