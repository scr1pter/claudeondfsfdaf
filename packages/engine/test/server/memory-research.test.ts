import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import type { Brain } from "@vectordevai/core/brain/brain"
import { Flag } from "@vectordevai/core/flag/flag"
import { ResearchStore } from "@vectordevai/core/research/store"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// The research routes under /memory/research, over a real listener with an owner and an invited guest, as the app's
// Settings > Memory > Research reads them: the list, one run, a source's saved text, Keep, export, and Forget for a
// source, a run and all of a repository's research, and the memory erases that forget research with what they erase.
// No route starts a run, so runs are written through the store the research tools use. The listener builds its own
// services, so both open the brain as a file in the test's data folder rather than in memory, where each would have a
// brain of its own.

const guard = NetworkGuard.use()

const keys = [
  "VECTOR_SERVER_USERNAME",
  "VECTOR_SERVER_PASSWORD",
  "VECTOR_SERVER_GUEST_USERNAME",
  "VECTOR_SERVER_GUEST_PASSWORD",
  "VECTOR_SERVER_GUEST_WORKSPACES",
  "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
  "VECTOR_DISABLE_DEFAULT_PLUGINS",
] as const
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
const previousDatabase = Flag.VECTOR_AGENT_DB
const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""
const owner = { authorization: basic("vector", "owner-secret") }
const guest = { authorization: basic("guest", "guest-secret") }

// The store over the brain file the listener uses.
const runtime = ManagedRuntime.make(AppNodeBuilderV1.build(ResearchStore.node))
const store = <A>(body: (research: ResearchStore.Interface) => Effect.Effect<A>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const research = yield* ResearchStore.Service
      return yield* body(research)
    }),
  )

let listener: Awaited<ReturnType<typeof Server.listen>>
let shared: Awaited<ReturnType<typeof tmpdir>>

beforeAll(async () => {
  shared = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: shared.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
  // A file name, under the test's own data folder: brain.db goes beside it.
  Flag.VECTOR_AGENT_DB = "memory-research.db"
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
})

afterAll(async () => {
  await listener.stop(true)
  await runtime.dispose()
  Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
  Flag.VECTOR_AGENT_DB = previousDatabase
  for (const key of keys) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await shared[Symbol.asyncDispose]()
})

afterEach(async () => {
  await disposeAllInstances()
})

const at = (directory: string, route: string) => {
  const url = new URL(route, listener.url)
  url.searchParams.set("directory", directory)
  return url
}
// A listener reused across tests: a pooled keep-alive socket could carry one test's request into another's.
const call = (url: URL, init: RequestInit = {}) => fetch(url, { ...init, keepalive: false })
const send = (directory: string, route: string, method: string, headers = owner) =>
  call(at(directory, route), { method, headers })
const get = async (directory: string, route: string) => {
  const response = await send(directory, route, "GET")
  expect([route, response.status]).toEqual([route, 200])
  return (await response.json()) as any
}

// The directory's event stream, from its first event: `act` runs once it is connected, and the first event of `type`
// is returned, or nothing after `ms`.
const awaitEvent = async (directory: string, type: string, act: () => Promise<unknown>, ms = 5_000) => {
  const controller = new AbortController()
  const response = await call(at(directory, "/event"), { headers: owner, signal: controller.signal })
  const reader = response.body!.getReader()
  const state = { text: "", acted: false }
  const deadline = Date.now() + ms
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => undefined)])
      if (!chunk || chunk.done) return undefined
      state.text += new TextDecoder().decode(chunk.value)
      if (!state.acted && state.text.includes("server.connected")) {
        state.acted = true
        await act()
      }
      const found = state.text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; properties: unknown })
        .find((event) => event.type === type)
      if (found) return found
    }
    return undefined
  } finally {
    controller.abort()
  }
}

// The brain place the routes use for a repository: its key is the repository's id.
const place = async (directory: string): Promise<Brain.Place> => {
  const project = (await get(directory, "/project/current")) as { id: string }
  return { repository: project.id, root: directory, sources: [], held: false }
}

const STUDY = [
  "Heat pump field study. The study followed 412 homes through two winters in northern climates.",
  "Results. Delivered heating energy fell by 61 percent compared with the gas boilers the homes had before.",
]

// A run that read one page, saved one note and wrote its report.
const seed = (where: Brain.Place, session = "ses_root") =>
  store((research) =>
    Effect.gen(function* () {
      const run = yield* research.start(where, {
        sessionID: session,
        question: "How much do heat pumps cut heating energy?",
        depth: "focused",
        scope: "web",
      })
      yield* research.addSource(where, run.id, {
        url: "https://homes.web.test/study",
        canonical: "https://homes.web.test/study",
        site: "homes.web.test",
        title: "Heat pump field study",
        status: "read",
        chunks: STUDY.map((text, index) => ({ text, chunk: index + 1 })),
      })
      yield* research.note(where, run.id, {
        subquestion: "How much energy do heat pumps save?",
        claim: "Delivered heating energy fell by 61 percent",
        source: "S1",
        quote: "Delivered heating energy fell by 61 percent compared with the gas boilers",
      })
      yield* research.report(where, run.id, {
        title: "Heat pump savings",
        answer: "Delivered heating energy fell by 61 percent against gas boilers [N1].",
        sections: [{ heading: "Measured savings", body: "Delivered heating energy fell by 61 percent [N1]." }],
        open_questions: [],
      })
      return run.id
    }),
  )

describe("memory research routes", () => {
  test("every research route is the owner's own: an invited guest gets 403 on each", async () => {
    const where = await place(shared.path)
    const run = await seed(where)
    // The guest may use this workspace (a session list answers), so a 403 below is the owner-only gate itself.
    expect((await call(at(shared.path, "/session"), { headers: guest })).status).toBe(200)
    const routes: [string, string][] = [
      ["GET", "/memory/research"],
      ["DELETE", "/memory/research"],
      ["GET", `/memory/research/${run}`],
      ["DELETE", `/memory/research/${run}`],
      ["POST", `/memory/research/${run}/keep`],
      ["GET", `/memory/research/${run}/export`],
      ["GET", `/memory/research/${run}/export?format=json`],
      ["GET", `/memory/research/${run}/export?format=docx`],
      ["GET", `/memory/research/${run}/export?format=pdf`],
      ["GET", `/memory/research/${run}/sources/S1`],
      ["DELETE", `/memory/research/${run}/sources/S1`],
    ]
    for (const [method, route] of routes) {
      const response = await send(shared.path, route, method, guest)
      expect([method, route, response.status]).toEqual([method, route, 403])
    }
    // Nothing the guest sent changed the run.
    expect((await get(shared.path, `/memory/research/${run}`)).run).toMatchObject({ id: run, kept: false })
    expect((await get(shared.path, `/memory/research/${run}/sources/S1`)).source.forgotten).toBeUndefined()
  }, 30_000)

  test("the owner lists a run, opens it and its source, keeps it, exports it and forgets it", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    const directory = tmp.path
    const run = await seed(await place(directory))
    const list = await get(directory, "/memory/research")
    const detail = await get(directory, `/memory/research/${run}`)
    const source = await get(directory, `/memory/research/${run}/sources/S1`)
    const markdown = await send(directory, `/memory/research/${run}/export`, "GET")
    const json = await send(directory, `/memory/research/${run}/export?format=json`, "GET")
    const word = await send(directory, `/memory/research/${run}/export?format=docx`, "GET")
    const pdf = await send(directory, `/memory/research/${run}/export?format=pdf`, "GET")
    const kept = await send(directory, `/memory/research/${run}/keep`, "POST")
    const forgotSource = await send(directory, `/memory/research/${run}/sources/S1`, "DELETE")
    const after = await get(directory, `/memory/research/${run}`)
    const forgot = await send(directory, `/memory/research/${run}`, "DELETE")
    const gone = await send(directory, `/memory/research/${run}`, "GET")
    const missing = await send(directory, `/memory/research/${run}/sources/S9`, "GET")

    expect(list).toMatchObject({ bytes: expect.any(Number), limit: 1024 * 1024 * 1024, retain: 30 })
    expect(list.runs).toEqual([
      expect.objectContaining({ run: expect.objectContaining({ id: run }), sources: 1, notes: 1 }),
    ])
    expect(detail.sources.map((item: { id: string }) => item.id)).toEqual(["S1"])
    expect(detail.notes.map((item: { id: string; support: boolean }) => [item.id, item.support])).toEqual([
      ["N1", true],
    ])
    expect(detail.report).toContain("# Heat pump savings")
    expect(detail.guest).toBe(false)
    expect(source.chunks.map((chunk: { text: string }) => chunk.text)).toEqual(STUDY)
    expect(source.private).toBe(false)
    expect(markdown.status).toBe(200)
    expect(markdown.headers.get("content-type")).toContain("text/markdown")
    expect(markdown.headers.get("content-disposition")).toBe(
      'attachment; filename="research-how-much-do-heat-pumps-cut-heating-energy.md"',
    )
    expect(markdown.headers.get("content-security-policy")).toBe("sandbox")
    expect(await markdown.text()).toContain("## Bibliography")
    expect(json.headers.get("content-type")).toContain("application/json")
    expect((await json.json()).notes[0].quote).toBe(
      "Delivered heating energy fell by 61 percent compared with the gas boilers",
    )
    expect(word.status).toBe(200)
    expect(word.headers.get("content-type")).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    expect(word.headers.get("content-disposition")).toEndWith('.docx"')
    expect(new TextDecoder().decode(new Uint8Array(await word.arrayBuffer()).slice(0, 2))).toBe("PK")
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get("content-type")).toBe("application/pdf")
    expect(pdf.headers.get("content-disposition")).toEndWith('.pdf"')
    expect(new TextDecoder().decode(new Uint8Array(await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-")
    expect(pdf.headers.get("cache-control")).toBe("no-store")
    expect(kept.status).toBe(200)
    expect((await kept.json()).run.kept).toBe(true)
    expect(forgotSource.status).toBe(200)
    expect(after.sources[0]).toMatchObject({ id: "S1", forgotten: true })
    expect(forgot.status).toBe(200)
    expect(gone.status).toBe(400)
    expect(await gone.json()).toMatchObject({ name: "MemoryError", data: { code: "not-found" } })
    expect(missing.status).toBe(400)
    expect(guard.outside()).toEqual([])
  }, 30_000)

  test("keeping a run tells the app through the directory's event stream", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    const run = await seed(await place(tmp.path))
    const event = await awaitEvent(tmp.path, "research.updated", () =>
      send(tmp.path, `/memory/research/${run}/keep`, "POST"),
    )
    expect(event).toMatchObject({ type: "research.updated", properties: { runID: run, status: "done" } })
  }, 30_000)

  test("forgetting all research, or erasing the repository's memory, leaves no run", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    const directory = tmp.path
    const where = await place(directory)
    await seed(where, "ses_one")
    await seed(where, "ses_two")
    const forgot = await send(directory, "/memory/research", "DELETE")
    expect(await forgot.json()).toBe(2)
    expect((await get(directory, "/memory/research")).runs).toEqual([])

    const erase = (scope: string) =>
      call(at(directory, "/memory/erase"), {
        method: "POST",
        headers: { ...owner, "content-type": "application/json" },
        body: JSON.stringify({ scope }),
      })
    // Erase clears the tombstones Forget left too, so the same page can be read again.
    expect((await erase("repository")).status).toBe(200)
    await seed(where, "ses_three")
    expect((await get(directory, "/memory/research")).runs[0]).toMatchObject({ sources: 1, notes: 1 })
    expect((await erase("repository")).status).toBe(200)
    expect((await get(directory, "/memory/research")).runs).toEqual([])
    // Erasing only what Vector learned about the user keeps the repository's research.
    const run = await seed(where, "ses_four")
    expect((await erase("personal")).status).toBe(200)
    expect((await get(directory, "/memory/research")).runs.map((item: { run: { id: string } }) => item.run.id)).toEqual(
      [run],
    )
  }, 30_000)

  test("erasing what Vector learned in a session forgets the runs it started, and erasing all forgets every run", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    const directory = tmp.path
    const where = await place(directory)
    const ids = async () =>
      (await get(directory, "/memory/research")).runs.map((item: { run: { id: string } }) => item.run.id)
    const one = await seed(where, "ses_one")
    const two = await seed(where, "ses_two")
    // The guest may not erase a session's memory, nor its research.
    expect((await send(directory, "/memory/sessions/ses_one", "DELETE", guest)).status).toBe(403)
    expect((await ids()).toSorted()).toEqual([one, two].toSorted())

    const erased = await send(directory, "/memory/sessions/ses_one", "DELETE")
    expect(erased.status).toBe(200)
    // The answer is still the count of entries: the session taught Vector nothing, and its run went all the same.
    expect(await erased.json()).toBe(0)
    expect(await ids()).toEqual([two])
    expect((await send(directory, `/memory/research/${one}`, "GET")).status).toBe(400)

    const all = await call(at(directory, "/memory/erase"), {
      method: "POST",
      headers: { ...owner, "content-type": "application/json" },
      body: JSON.stringify({ scope: "all" }),
    })
    expect(all.status).toBe(200)
    expect(await ids()).toEqual([])
    expect(guard.outside()).toEqual([])
  }, 30_000)
})
