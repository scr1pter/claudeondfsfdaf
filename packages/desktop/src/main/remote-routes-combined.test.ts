import { describe, expect, test } from "bun:test"
import { createPasskeyApprovals } from "./remote-passkey"
import {
  createRemoteRoutes,
  createRemoteTurns,
  matchRoute,
  projectDirectories,
  REMOTE_ROUTES,
  type EngineAnswer,
  type EngineRequest,
} from "./remote-routes"

// Track B B09, the combined Remote authorization regression: the phone's allowlist read against the engine's whole
// published API (packages/sdk/openapi.json, read only), so a route another lane adds, renames or removes is seen here
// without this file naming it. Only REMOTE_ROUTES itself changing should need an edit below.

type Operation = { parameters?: { in: string; name: string }[]; requestBody?: unknown }
const openapi = (await Bun.file(new URL("../../../sdk/openapi.json", import.meta.url)).json()) as {
  paths: Record<string, Record<string, Operation>>
  components?: { schemas?: Record<string, unknown> }
}
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"]
const operations = Object.entries(openapi.paths).flatMap(([path, item]) =>
  Object.keys(item)
    .filter((method) => METHODS.includes(method))
    .map((method) => ({ method: method.toUpperCase(), path, operation: item[method]! })),
)
/** "/session/:sessionID" as openapi writes it, "/session/{sessionID}". */
const templateOf = (path: string) => path.replace(/:([A-Za-z]+)/g, "{$1}")
/** A request path for a template: each parameter and wildcard filled with an id. */
const concrete = (template: string) => template.replace(/\{[^}]+\}/g, "id_1").replace(/\*/g, "id_1")
const listed = new Set(REMOTE_ROUTES.map((route) => `${route.method} ${templateOf(route.path)}`))

const PHONE = "AAAAAAAAAAAAAAAAAAAAAA"
const PROJECTS = [
  { id: "prj_1", worktree: "/repo", name: "repo", sandboxes: [] },
  { id: "global", worktree: "/", sandboxes: [] },
]

/** `answer` gives the fake engine's answer for a request; it answers 200 for any request `answer` leaves alone. */
function setup(
  answer: (request: EngineRequest) => Promise<EngineAnswer | undefined> | EngineAnswer | undefined = () => undefined,
) {
  const requests: EngineRequest[] = []
  const turns = createRemoteTurns()
  const routes = createRemoteRoutes({
    engine: async (request) => {
      requests.push(request)
      if (request.path === "/project") return { status: 200, body: PROJECTS }
      return (await answer(request)) ?? { status: 200, body: { ok: true } }
    },
    // Outside the recorded engine, so every recorded request is one the phone's request caused.
    directories: async () => projectDirectories(PROJECTS),
    approvals: createPasskeyApprovals({ origin: "https://remote.vectordev.ai" }),
    credential: () => undefined,
    saveCredential: async () => {},
    turns,
  })
  const ask = (request: Record<string, unknown>) => routes.handle(PHONE, { directory: "/repo", ...request })
  return { requests, turns, ask }
}

const code = (answer: { body: unknown }) => (answer.body as { error?: { code?: string } }).error?.code
/** What the forwarder answers for a method it never sends (readRequest knows only GET and POST). */
const refusal = (method: string) =>
  method === "GET" || method === "POST"
    ? { status: 403, code: "REMOTE_ROUTE_REFUSED" }
    : { status: 400, code: "REMOTE_REQUEST_INVALID" }

describe("the allowlist against the engine's published API", () => {
  test("every allowlisted route is a real engine operation with the same method, path parameters and query fields", () => {
    expect(listed.size).toBe(REMOTE_ROUTES.length)
    for (const route of REMOTE_ROUTES) {
      const template = templateOf(route.path)
      const operation = openapi.paths[template]?.[route.method.toLowerCase()]
      expect({ route: `${route.method} ${route.path}`, found: operation !== undefined }).toEqual({
        route: `${route.method} ${route.path}`,
        found: true,
      })
      const parameters = operation?.parameters ?? []
      const named = (where: string) => parameters.filter((item) => item.in === where).map((item) => item.name)
      const pathNames = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]!)
      expect(named("path").toSorted()).toEqual(pathNames.toSorted())
      for (const field of Object.keys(route.query ?? {})) expect(named("query")).toContain(field)
      // Positive control: the forwarder's own matcher finds this route for a request to it.
      expect(matchRoute(route.method, concrete(template))?.route).toBe(route)
    }
  })

  test("every other engine operation is refused and never reaches the engine", async () => {
    const { ask, requests } = setup()
    const others = operations.filter((item) => !listed.has(`${item.method} ${item.path}`))
    expect(others.length).toBe(operations.length - REMOTE_ROUTES.length)
    expect(others.length).toBeGreaterThan(0)
    for (const item of others) {
      const path = concrete(item.path)
      expect({ operation: `${item.method} ${item.path}`, match: matchRoute(item.method, path) }).toEqual({
        operation: `${item.method} ${item.path}`,
        match: undefined,
      })
      const answer = await ask({ method: item.method, path, body: { helpers: true } })
      expect({ operation: `${item.method} ${item.path}`, status: answer.status, code: code(answer) }).toEqual({
        operation: `${item.method} ${item.path}`,
        ...refusal(item.method),
      })
    }
    expect(requests).toEqual([])
  })

  test("deny by default: routes the engine does not publish, and listed paths under other methods", async () => {
    const { ask, requests } = setup()
    const suffix = `b09-${crypto.randomUUID().slice(0, 8)}`
    const probes = [
      // Served by the engine or the desktop but absent from openapi.json at this source.
      "/doc",
      "/remote/approval",
      // Families with no published operation at this source.
      "/experimental/everywhere/run",
      "/experimental/github/webhook",
      "/experimental/cloud-agents",
      "/experimental/cloud-agents/run",
      ...[
        "",
        "/session/ses_1",
        "/experimental/session/ses_1",
        "/experimental/everywhere",
        "/experimental/github",
        "/experimental/cloud-agents",
        "/experimental/brain",
        "/api",
      ].map((prefix) => `${prefix}/${suffix}`),
    ].filter(
      // A probe a later regeneration publishes is an operation the case above refuses; it is not probed again here.
      (path) => openapi.paths[path] === undefined && openapi.paths[path.replace(/ses_1/g, "{sessionID}")] === undefined,
    )
    // The random-suffix probes are never published, so there is always something to probe.
    expect(probes.filter((path) => path.endsWith(suffix)).length).toBe(8)
    for (const path of probes) {
      // POST /remote/approval is the desktop's own passkey route, handled before the allowlist.
      for (const method of path === "/remote/approval" ? ["GET"] : ["GET", "POST"]) {
        const answer = await ask({ method, path, body: { helpers: true } })
        expect({ method, path, status: answer.status, code: code(answer) }).toEqual({
          method,
          path,
          status: 403,
          code: "REMOTE_ROUTE_REFUSED",
        })
      }
    }
    for (const route of REMOTE_ROUTES)
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (listed.has(`${method} ${templateOf(route.path)}`)) continue
        const path = concrete(templateOf(route.path))
        expect(matchRoute(method, path)).toBeUndefined()
        const answer = await ask({ method, path, body: {} })
        expect({ method, path, status: answer.status }).toEqual({ method, path, status: refusal(method).status })
      }
    expect(requests).toEqual([])
  })
})

describe("the phone's helper controls", () => {
  const STOP = "/experimental/session/ses_1/stop"

  test("the phone's Stop takes only {helpers: boolean} by POST and sends exactly that", async () => {
    const { ask, requests } = setup()
    for (const helpers of [true, false]) {
      expect((await ask({ method: "POST", path: STOP, body: { helpers } })).status).toBe(200)
      expect(requests.at(-1)).toEqual({ method: "POST", path: STOP, query: { directory: "/repo" }, body: { helpers } })
    }
    const refused = [
      undefined,
      null,
      [],
      "true",
      1,
      {},
      { helpers: "true" },
      { helpers: 1 },
      { helpers: null },
      { helpers: true, reason: "x" },
      { helpers: true, sessionID: "ses_2" },
      { helpers: true, taskIDs: ["t"] },
      { helpers: true, all: true },
      { helpers: false, permission: "always" },
      [{ helpers: true }],
    ]
    for (const body of refused) {
      const answer = await ask({ method: "POST", path: STOP, body })
      expect({ body, status: answer.status, code: code(answer) }).toEqual({
        body,
        status: 400,
        code: "REMOTE_BODY_REFUSED",
      })
    }
    expect(code(await ask({ method: "POST", path: STOP, query: { helpers: "true" }, body: { helpers: true } }))).toBe(
      "REMOTE_QUERY_REFUSED",
    )
    expect((await ask({ method: "GET", path: STOP })).status).toBe(403)
    for (const method of ["PUT", "PATCH", "DELETE"])
      expect(code(await ask({ method, path: STOP, body: { helpers: true } }))).toBe("REMOTE_REQUEST_INVALID")
    for (const path of ["/experimental/session/ses_1/tasks/stop", "/experimental/session/ses_1/review/run_1/stop"])
      expect((await ask({ method: "POST", path, body: { helpers: true } })).status).toBe(403)
    expect(requests.length).toBe(2)
    // Plain abort never carries the helper choice on.
    expect((await ask({ method: "POST", path: "/session/ses_1/abort", body: { helpers: true } })).status).toBe(200)
    expect(requests.at(-1)).toEqual({
      method: "POST",
      path: "/session/ses_1/abort",
      query: { directory: "/repo" },
      body: {},
    })
    expect(requests.length).toBe(3)
  })

  test("the engine's published Stop body requires helpers as a boolean", () => {
    const content = (
      openapi.paths["/experimental/session/{sessionID}/stop"]?.post?.requestBody as {
        content?: Record<string, { schema?: Record<string, unknown> }>
      }
    )?.content?.["application/json"]?.schema
    const ref = typeof content?.$ref === "string" ? content.$ref.split("/").at(-1)! : undefined
    const schema = (ref ? openapi.components?.schemas?.[ref] : content) as {
      properties?: Record<string, { type?: string }>
      required?: string[]
    }
    expect(schema.properties?.helpers?.type).toBe("boolean")
    expect(schema.required).toContain("helpers")
    // Any other field the engine takes (its own `reason` today) stays out of a phone's reach: the forwarder sends only
    // `{helpers}` (the case above), so an optional field an engine lane adds needs no edit here.
  })

  test("the tasks read takes only its bounded query", async () => {
    const { ask, requests } = setup()
    const TASKS = "/experimental/session/ses_1/tasks"
    const read = (query: Record<string, string>) => ask({ method: "GET", path: TASKS, query })
    for (const limit of ["1", "37", "200"]) {
      expect((await read({ limit })).status).toBe(200)
      expect(requests.at(-1)).toEqual({ method: "GET", path: TASKS, query: { limit, directory: "/repo" } })
    }
    for (const limit of ["0", "201", "-1", "1.5", "", " 1", "1e2", "abc", "0x10", "9999999999"]) {
      const answer = await read({ limit })
      expect({ limit, code: code(answer) }).toEqual({ limit, code: "REMOTE_QUERY_REFUSED" })
    }
    for (const field of ["descendants", "active", "shells"]) {
      for (const value of ["true", "false"]) {
        expect((await read({ [field]: value })).status).toBe(200)
        expect(requests.at(-1)?.query).toEqual({ [field]: value, directory: "/repo" })
      }
      for (const value of ["1", "yes", "TRUE", ""])
        expect({ field, value, code: code(await read({ [field]: value })) }).toEqual({
          field,
          value,
          code: "REMOTE_QUERY_REFUSED",
        })
    }
    for (const field of ["cursor", "status", "taskID", "internal", "scope", "path"])
      expect({ field, code: code(await read({ [field]: "x" })) }).toEqual({ field, code: "REMOTE_QUERY_REFUSED" })
    for (const field of ["directory", "workspace"])
      expect({ field, code: code(await read({ [field]: "/repo" })) }).toEqual({ field, code: "REMOTE_REQUEST_INVALID" })
    const forwarded = requests.length
    expect((await ask({ method: "POST", path: TASKS, body: {} })).status).toBe(403)
    for (const path of [`${TASKS}/task_1`, `${TASKS}/task_1/changes`])
      expect((await ask({ method: "GET", path })).status).toBe(403)
    expect(requests.length).toBe(forwarded)
    // The phone's own Tasks view (packages/app/src/phone/routes/session-tasks.tsx) passes unchanged.
    const board = { descendants: "true", shells: "true", limit: "100" }
    expect((await read(board)).status).toBe(200)
    expect(requests.at(-1)).toEqual({ method: "GET", path: TASKS, query: { ...board, directory: "/repo" } })
    expect(
      (await ask({ method: "POST", path: "/experimental/session/ses_1/stop", body: { helpers: true } })).status,
    ).toBe(200)
  })
})

describe("helpers a phone's turn starts", () => {
  // A created session is the phone's when the session above it is, whatever its metadata holds (none here).
  const created = (id: string, parentID?: string) => ({
    type: "session.created",
    properties: { sessionID: id, info: { id, ...(parentID ? { parentID } : {}), metadata: {} } },
  })
  const updated = (id: string, parentID: string, subagent: Record<string, unknown>) => ({
    type: "session.updated",
    properties: { sessionID: id, info: { id, parentID, metadata: { subagent } } },
  })
  const idle = (id: string) => ({ type: "session.status", properties: { sessionID: id, status: { type: "idle" } } })
  const deleted = (id: string, parentID?: string) => ({
    type: "session.deleted",
    properties: { sessionID: id, info: { id, ...(parentID ? { parentID } : {}) } },
  })
  const prompt = (ask: ReturnType<typeof setup>["ask"], sessionID: string) =>
    ask({ method: "POST", path: `/session/${sessionID}/prompt_async`, body: { parts: [{ type: "text", text: "Go" }] } })

  test("a helper the phone's turn starts keeps the hold after the turn's session is idle, until it is idle or ended", async () => {
    const { ask, turns } = setup()
    await ask({
      method: "POST",
      path: "/session/ses_root/prompt_async",
      body: { parts: [{ type: "text", text: "Go" }] },
    })
    expect(turns.has(["ses_root"])).toBe(true)
    turns.observe(created("ses_helper", "ses_root"))
    expect(turns.has(["ses_helper", "ses_root"])).toBe(true)
    turns.observe({ type: "session.idle", properties: { sessionID: "ses_root" } })
    // The phone's turn ended; the helper it started in the background is still the phone's.
    expect(turns.has(["ses_root"])).toBe(false)
    expect(turns.has(["ses_helper", "ses_root"])).toBe(true)
    expect(turns.size).toBe(1)
    // A helper's own helper inherits the hold.
    turns.observe(created("ses_grandchild", "ses_helper"))
    expect(turns.has(["ses_grandchild", "ses_helper", "ses_root"])).toBe(true)
    // A record that is still open keeps it; the helper's idle, or a record that ended, releases it.
    turns.observe(updated("ses_grandchild", "ses_helper", { status: "running" }))
    turns.observe(updated("ses_helper", "ses_root", { status: "queued" }))
    expect(turns.size).toBe(2)
    turns.observe(idle("ses_helper"))
    expect(turns.has(["ses_helper", "ses_root"])).toBe(false)
    expect(turns.has(["ses_grandchild"])).toBe(true)
    turns.observe(updated("ses_grandchild", "ses_helper", { status: "cancelled" }))
    expect(turns.size).toBe(0)
  })

  test("a helper the phone's turn resumes is held too; one started before the turn is not", async () => {
    const { ask, turns } = setup()
    const before = Date.now() - 60_000
    await ask({
      method: "POST",
      path: "/session/ses_root/prompt_async",
      body: { parts: [{ type: "text", text: "Go" }] },
    })
    // Resumed by this turn: its record starts running again after the mark.
    turns.observe(updated("ses_resumed", "ses_root", { status: "running", startedAt: Date.now() + 1 }))
    // A background helper this computer started earlier, whose record changes while the phone's turn runs.
    turns.observe(updated("ses_earlier", "ses_root", { status: "running", startedAt: before }))
    turns.observe(updated("ses_ended", "ses_root", { status: "completed", startedAt: Date.now() + 1 }))
    turns.observe({ type: "session.idle", properties: { sessionID: "ses_root" } })
    expect(turns.has(["ses_resumed"])).toBe(true)
    expect(turns.has(["ses_earlier"])).toBe(false)
    expect(turns.has(["ses_ended"])).toBe(false)
    turns.observe(updated("ses_resumed", "ses_root", { status: "error" }))
    expect(turns.size).toBe(0)
  })

  test("a session the phone prompts itself keeps its mark until it is idle, whatever its record says", async () => {
    const { ask, turns } = setup()
    // A phone may continue a finished helper's session directly; its record still reads completed.
    await ask({
      method: "POST",
      path: "/session/ses_helper/prompt_async",
      body: { parts: [{ type: "text", text: "More" }] },
    })
    turns.observe(updated("ses_helper", "ses_root", { status: "completed" }))
    expect(turns.has(["ses_helper"])).toBe(true)
    turns.observe(idle("ses_helper"))
    expect(turns.size).toBe(0)
  })

  test("a phone turn the engine does not take puts back the hold that stood: a background helper's, or an earlier turn's", async () => {
    const refused = new Set<string>()
    const { ask, turns } = setup((request) =>
      refused.has(request.path) ? { status: 400, body: { error: "bad" } } : undefined,
    )
    expect((await prompt(ask, "ses_root")).status).toBe(200)
    turns.observe(created("ses_helper", "ses_root"))
    turns.observe(idle("ses_root"))
    refused.add("/session/ses_helper/prompt_async")
    expect((await prompt(ask, "ses_helper")).status).toBe(400)
    // The helper the earlier turn started still runs in the background, and stays with a person.
    expect(turns.has(["ses_helper"])).toBe(true)
    // Its hold is still the inherited one, so its record ending releases it.
    turns.observe(updated("ses_helper", "ses_root", { status: "completed" }))
    expect(turns.has(["ses_helper"])).toBe(false)
    // A second phone turn the engine refuses while the first still runs leaves the first turn's mark.
    expect((await prompt(ask, "ses_root")).status).toBe(200)
    refused.add("/session/ses_root/prompt_async")
    expect((await prompt(ask, "ses_root")).status).toBe(400)
    expect(turns.has(["ses_root"])).toBe(true)
    turns.observe(idle("ses_root"))
    // With nothing held before it, a refused turn holds nothing.
    expect((await prompt(ask, "ses_root")).status).toBe(400)
    expect(turns.size).toBe(0)
  })

  test("a refused turn leaves alone a hold that changed while it waited", async () => {
    const reached = Promise.withResolvers<void>()
    const slow = Promise.withResolvers<void>()
    const prompts: EngineRequest[] = []
    const { ask, turns } = setup(async (request) => {
      if (request.path !== "/session/ses_root/prompt_async") return undefined
      prompts.push(request)
      if (prompts.length > 1) return undefined
      reached.resolve()
      await slow.promise
      return { status: 400, body: { error: "bad" } }
    })
    const first = prompt(ask, "ses_root")
    await reached.promise
    // A second phone turn the engine takes while the first one waits on the engine.
    expect((await prompt(ask, "ses_root")).status).toBe(200)
    slow.resolve()
    expect((await first).status).toBe(400)
    expect(turns.has(["ses_root"])).toBe(true)
    turns.observe(idle("ses_root"))
    expect(turns.size).toBe(0)
  })

  test("a deleted session holds nothing, so a helper deleted mid-run does not keep the hold or the event stream", async () => {
    const { ask, turns } = setup()
    await prompt(ask, "ses_root")
    turns.observe(created("ses_helper", "ses_root"))
    turns.observe(created("ses_other", "ses_root"))
    turns.observe(idle("ses_root"))
    expect(turns.size).toBe(2)
    turns.observe(deleted("ses_helper", "ses_root"))
    expect(turns.has(["ses_helper"])).toBe(false)
    expect(turns.has(["ses_other"])).toBe(true)
    turns.observe(deleted("ses_other", "ses_root"))
    // A session the phone prompted directly, too.
    await prompt(ask, "ses_root")
    expect(turns.has(["ses_root"])).toBe(true)
    turns.observe(deleted("ses_root"))
    expect(turns.size).toBe(0)
  })

  test("only a marked parent passes its mark on, and only a phone's turn marks", async () => {
    const { ask, turns } = setup()
    turns.observe(created("ses_child", "ses_unmarked"))
    turns.observe(created("ses_root2"))
    turns.observe({ type: "session.created", properties: { sessionID: "ses_bad", info: "ses_root" } })
    expect(turns.size).toBe(0)
    for (const [path, body] of [
      ["/session", { title: "x" }],
      ["/session/ses_1/abort", {}],
      ["/experimental/session/ses_1/stop", { helpers: true }],
      ["/question/que_1/reply", { answers: [["Yes"]] }],
      ["/question/que_1/reject", {}],
    ] as const)
      expect((await ask({ method: "POST", path, body })).status).toBe(200)
    expect(turns.size).toBe(0)
  })
})
