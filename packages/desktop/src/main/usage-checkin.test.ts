import { afterEach, expect, test } from "bun:test"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { createUsageCheckin, usageCheckinEndpoint } from "./usage-checkin"

// Any connection off this computer throws: the check-in only ever reaches the fake server on 127.0.0.1 here.
NetworkGuard.use()

const DAY = 24 * 60 * 60 * 1000
const TODAY = Date.UTC(2026, 9, 9, 15, 30)
const TOKEN = "vct_placeholder-account-token"
const servers: ReturnType<typeof Bun.serve>[] = []

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true))
})

/** A UTC time on the test day; hours of 24 and more fall on the following days. */
function at(hours: number, minutes = 0) {
  return Date.UTC(2026, 9, 9, hours, minutes)
}

function fixture(
  input: { listStatus?: number; checkinStatus?: number; pageSize?: number; usageInterval?: number } = {},
) {
  const state = {
    now: TODAY,
    enabled: true,
    token: TOKEN as string | undefined,
    listStatus: input.listStatus,
    checkinStatus: input.checkinStatus ?? 204,
    sessions: [] as Array<{ id: string; parentID?: string; internal?: string; updated: number }>,
    // The engine's local usage summary; undefined answers 404, as an engine without the route would.
    usage: undefined as unknown,
    usageStatus: 200,
  }
  const lists: Array<{ query: URLSearchParams; authorization: string | null }> = []
  const usageReads: Array<{ authorization: string | null }> = []
  const checkins: Array<{ body: unknown; authorization: string | null }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/experimental/session") {
        lists.push({ query: url.searchParams, authorization: request.headers.get("authorization") })
        if (state.listStatus) return new Response("unavailable", { status: state.listStatus })
        // Stands in for the engine's list: newest first, updated at or after `start` and before `cursor`, helpers only
        // when asked for, one page at a time with the next cursor in a header.
        const start = Number(url.searchParams.get("start"))
        const cursor = url.searchParams.has("cursor") ? Number(url.searchParams.get("cursor")) : Infinity
        const limit = Math.min(input.pageSize ?? Infinity, Number(url.searchParams.get("limit")))
        const rows = state.sessions
          .filter((session) => !session.internal || url.searchParams.get("internal") === "true")
          .filter((session) => session.updated >= start && session.updated < cursor)
          .sort((a, b) => b.updated - a.updated)
        const page = rows.slice(0, limit)
        return Response.json(
          page.map((session) => ({
            id: session.id,
            parentID: session.parentID,
            internal: session.internal,
            title: "private title",
            directory: "/private/repo",
            time: { updated: session.updated },
          })),
          { headers: rows.length > limit ? { "x-next-cursor": String(page[page.length - 1].updated) } : {} },
        )
      }
      if (url.pathname === "/experimental/session/usage") {
        usageReads.push({ authorization: request.headers.get("authorization") })
        if (state.usage === undefined) return new Response("missing", { status: 404 })
        return Response.json(state.usage, { status: state.usageStatus })
      }
      if (url.pathname === "/api/usage/checkin") {
        checkins.push({ body: await request.json(), authorization: request.headers.get("authorization") })
        return new Response(null, { status: state.checkinStatus })
      }
      return new Response("missing", { status: 404 })
    },
  })
  servers.push(server)
  const store = new Map<string, unknown>()
  const options = {
    endpoint: new URL("/api/usage/checkin", server.url).href as string | undefined,
    store: { get: (key: string) => store.get(key), set: (key: string, value: unknown) => store.set(key, value) },
    enabled: () => state.enabled,
    engine: { url: server.url.href, username: "vector", password: "placeholder-password" },
    token: async () => state.token,
    fetch: (url: string, init: RequestInit) => fetch(url, init),
    now: () => state.now,
    version: "1.99.105",
    platform: "darwin",
    arch: "arm64",
    usageInterval: input.usageInterval,
  }
  return { state, lists, usageReads, checkins, store, options, usage: createUsageCheckin(options) }
}

/** The engine's GET /experimental/session/usage, with the fields Settings shows and a few the report leaves out. */
function summary(input: { lifetimeTokens?: number; modelResponses?: number } = {}) {
  return {
    lifetimeTokens: input.lifetimeTokens ?? 1_250_000,
    lifetimeCost: 18.4212345,
    unpricedResponses: 2,
    inputTokens: 800_000,
    outputTokens: 250_000,
    reasoningTokens: 50_000,
    cachedTokens: 150_000,
    peakTokens: 300_000,
    longestTaskMs: 912_000,
    longestTaskTokens: 40_000,
    averageTaskMs: 41_500,
    currentStreak: 3,
    longestStreak: 6,
    completedChats: 41,
    conversations: 12,
    activeDays: 9,
    averageTokensPerChat: 30_487,
    modelResponses: input.modelResponses ?? 320,
    favoriteModels: [
      { providerID: "anthropic", modelID: "claude-sonnet-4-5", tokens: 900_000, responses: 200, percentage: 72 },
      { providerID: "my local proxy", modelID: "llama", tokens: 350_000, responses: 120, percentage: 28 },
    ],
    effortLevels: [{ id: "default", label: "Default", tokens: 1_250_000, responses: 320, percentage: 100 }],
    days: Array.from({ length: 9 }, (_, index) => ({
      date: `2026-10-0${index + 1}`,
      tokens: 1_000 * (index + 1),
      cost: 0.5,
      tasks: index + 1,
    })),
  }
}

async function until(condition: () => boolean) {
  for (let count = 0; count < 400 && !condition(); count++) await Bun.sleep(5)
}

test("sends the root and subagent sessions updated since UTC midnight, across every page", async () => {
  const app = fixture({ pageSize: 2 })
  app.state.sessions.push(
    { id: "ses_yesterday", updated: at(-2) },
    { id: "ses_a", updated: at(9) },
    { id: "ses_b", parentID: "ses_a", updated: at(10) },
    { id: "ses_c", updated: at(11) },
    { id: "ses_d", parentID: "ses_c", updated: at(12) },
    { id: "ses_e", parentID: "ses_c", updated: at(13) },
    // Vector's helpers (an autocomplete run under ses_a, a Vectorscope review outside any session) are not sessions.
    { id: "ses_autocomplete", parentID: "ses_a", internal: "codespace.autocomplete", updated: at(10, 30) },
    { id: "ses_review", internal: "vectorscope.review", updated: at(11, 30) },
  )

  expect(await app.usage.checkin()).toBe(true)

  expect(app.lists.map((list) => list.query.get("start"))).toEqual(Array(4).fill(String(at(0))))
  expect(app.lists.map((list) => list.query.get("cursor"))).toEqual([
    null,
    String(at(12)),
    String(at(11)),
    String(at(10)),
  ])
  expect(app.lists[0].query.get("archived")).toBe("true")
  // Helpers are listed only to tell when the usage report needs reading; they add to neither count.
  expect(app.lists.every((list) => list.query.get("internal") === "true")).toBe(true)
  expect(app.lists[0].authorization).toBe(`Basic ${Buffer.from("vector:placeholder-password").toString("base64")}`)
  expect(app.checkins).toHaveLength(1)
  expect(app.checkins[0].authorization).toBe(`Bearer ${TOKEN}`)
  const installId = app.store.get("installId")
  expect(installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(app.checkins[0].body).toEqual({
    installId,
    client: "desktop",
    version: "1.99.105",
    platform: "darwin",
    arch: "arm64",
    sessions: 2,
    subagentSessions: 3,
  })
})

test("sends the day's counts again whenever they grow and starts over at the next UTC day", async () => {
  const app = fixture()
  const sent = () =>
    app.checkins.map((checkin) => checkin.body as { installId: string; sessions: number; subagentSessions: number })

  // Opening the app before any work marks the install active with nothing counted yet.
  app.state.now = at(9, 1)
  expect(await app.usage.checkin()).toBe(true)

  app.state.sessions.push({ id: "ses_a", updated: at(10) }, { id: "ses_b", parentID: "ses_a", updated: at(11) })
  app.state.now = at(12, 1)
  expect(await app.usage.checkin()).toBe(true)

  app.state.now = at(15, 1)
  expect(await app.usage.checkin()).toBe(false)

  app.state.sessions.push({ id: "ses_c", parentID: "ses_a", updated: at(16) }, { id: "ses_d", updated: at(17) })
  app.state.now = at(23, 55)
  expect(await app.usage.checkin()).toBe(true)

  app.state.now = at(24, 1)
  expect(await app.usage.checkin()).toBe(true)

  app.state.sessions[0].updated = at(24, 30)
  app.state.now = at(25, 1)
  expect(await app.usage.checkin()).toBe(true)

  expect(sent().map((body) => [body.sessions, body.subagentSessions])).toEqual([
    [0, 0],
    [1, 1],
    [2, 2],
    [0, 0],
    [1, 0],
  ])
  expect(app.lists.at(-1)?.query.get("start")).toBe(String(at(24)))
  expect(new Set(sent().map((body) => body.installId)).size).toBe(1)
})

test("sends the local usage report with the check-in, read with the same engine credentials", async () => {
  const app = fixture()
  app.state.usage = summary()

  expect(await app.usage.checkin()).toBe(true)

  expect(app.usageReads.map((read) => read.authorization)).toEqual([
    `Basic ${Buffer.from("vector:placeholder-password").toString("base64")}`,
  ])
  expect((app.checkins[0].body as { usage: unknown }).usage).toEqual({
    lifetimeTokens: 1_250_000,
    lifetimeCost: 18.421235,
    inputTokens: 800_000,
    outputTokens: 250_000,
    reasoningTokens: 50_000,
    cachedTokens: 150_000,
    completedChats: 41,
    conversations: 12,
    activeDays: 9,
    currentStreak: 3,
    longestStreak: 6,
    averageTaskMs: 41_500,
    longestTaskMs: 912_000,
    modelResponses: 320,
    // The last seven days only.
    days: Array.from({ length: 7 }, (_, index) => ({
      date: `2026-10-0${index + 3}`,
      tokens: 1_000 * (index + 3),
      tasks: index + 3,
      cost: 0.5,
    })),
    // A provider name the server would refuse is left out, not the whole report.
    favoriteModels: [{ providerID: "anthropic", modelID: "claude-sonnet-4-5", tokens: 900_000, percentage: 72 }],
    effortLevels: [{ id: "default", label: "Default", tokens: 1_250_000, responses: 320, percentage: 100 }],
  })
  expect(app.store.get("sent")).toEqual({
    day: "2026-10-09",
    sessions: 0,
    subagentSessions: 0,
    tokens: 1_250_000,
    responses: 320,
  })
})

test("sends Codium activity with zero own usage and no Codium-specific fields", async () => {
  const app = fixture()
  app.state.usage = {
    ...summary({ lifetimeTokens: 0, modelResponses: 2 }),
    lifetimeCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    codiumResponses: 3,
    unpricedResponses: 3,
    completedChats: 2,
    conversations: 1,
    activeDays: 1,
    favoriteModels: [],
    effortLevels: [],
    days: [{ date: "2026-10-09", tokens: 0, cost: 0, tasks: 2, codium: 3 }],
    helpers: [{ id: "vectorscope.review", sessions: 1, responses: 1, tokens: 0, cost: 0, codiumSteps: 1 }],
  }
  expect(await app.usage.checkin()).toBe(true)
  const sent = app.checkins[0].body as {
    usage: {
      lifetimeTokens: number
      lifetimeCost: number
      modelResponses: number
      days: unknown[]
      favoriteModels: unknown[]
    }
  }
  expect(sent.usage).toMatchObject({ lifetimeTokens: 0, lifetimeCost: 0, modelResponses: 2, completedChats: 2 })
  expect(sent.usage.days).toEqual([{ date: "2026-10-09", tokens: 0, cost: 0, tasks: 2 }])
  expect(sent.usage.favoriteModels).toEqual([])
  expect(JSON.stringify(sent)).not.toMatch(/codium|vector-plan|vectorscope/)
})

test("marks the engine's history as reported only after an accepted check-in that carried the report", async () => {
  const marks: string[] = []
  const app = fixture({ checkinStatus: 503 })
  const usage = createUsageCheckin({
    ...app.options,
    usageInterval: 0,
    reported: async () => {
      marks.push(new Date(app.state.now).toISOString())
    },
  })
  app.state.usage = summary()

  expect(await usage.checkin()).toBe(false)
  expect(marks).toHaveLength(0)

  app.state.checkinStatus = 204
  app.state.usage = undefined
  expect(await usage.checkin()).toBe(true)
  expect(marks).toHaveLength(0)

  app.state.usage = summary()
  expect(await usage.checkin()).toBe(true)
  expect(marks).toEqual([new Date(TODAY).toISOString()])
})

test("still checks in, without the report, when the summary cannot be read", async () => {
  for (const [usage, status] of [
    [summary(), 500],
    [{ lifetimeTokens: "lots" }, 200],
    ["not a summary", 200],
  ] as const) {
    const app = fixture()
    app.state.usage = usage
    app.state.usageStatus = status
    app.state.sessions.push({ id: "ses_a", updated: at(14) })

    expect(await app.usage.checkin()).toBe(true)

    expect(app.checkins[0].body).toMatchObject({ sessions: 1, subagentSessions: 0 })
    expect(app.checkins[0].body).not.toHaveProperty("usage")
  }
})

test("sends again when the report shows more tokens or responses, and not when only it fails", async () => {
  // Read the summary on every check-in, as if each one came six hours after the last.
  const app = fixture({ usageInterval: 0 })
  app.state.usage = summary()
  expect(await app.usage.checkin()).toBe(true)

  // Nothing grew.
  expect(await app.usage.checkin()).toBe(false)

  app.state.usage = summary({ lifetimeTokens: 1_300_000 })
  expect(await app.usage.checkin()).toBe(true)
  app.state.usage = summary({ lifetimeTokens: 1_300_000, modelResponses: 321 })
  expect(await app.usage.checkin()).toBe(true)

  // A failed read is not growth.
  app.state.usageStatus = 503
  expect(await app.usage.checkin()).toBe(false)

  // A count that grows still goes out, without a report, and the accepted report totals are kept.
  app.state.sessions.push({ id: "ses_a", updated: at(15) })
  expect(await app.usage.checkin()).toBe(true)
  expect(app.checkins.at(-1)?.body).not.toHaveProperty("usage")
  expect(app.store.get("sent")).toMatchObject({ sessions: 1, tokens: 1_300_000, responses: 321 })

  app.state.usageStatus = 200
  expect(await app.usage.checkin()).toBe(false)
  expect(app.checkins).toHaveLength(4)
})

test("a failed count later in the day repeats the accepted counts when only the report grew", async () => {
  const app = fixture({ usageInterval: 0 })
  app.state.sessions.push({ id: "ses_a", updated: at(9) }, { id: "ses_b", parentID: "ses_a", updated: at(10) })
  expect(await app.usage.checkin()).toBe(true)

  app.state.listStatus = 503
  app.state.usage = summary()
  expect(await app.usage.checkin()).toBe(true)
  expect(app.checkins[1].body).toMatchObject({ sessions: 1, subagentSessions: 1, usage: { lifetimeTokens: 1_250_000 } })
})

test("reads the summary with the day's first check-in and when a count grows, otherwise every six hours", async () => {
  const app = fixture()
  app.state.now = at(1)
  app.state.usage = summary()
  expect(await app.usage.checkin()).toBe(true)
  expect(app.usageReads).toHaveLength(1)

  // An hour later nothing was counted: the summary, which scans every message, is not read.
  app.state.now = at(2)
  app.state.usage = summary({ lifetimeTokens: 1_300_000 })
  expect(await app.usage.checkin()).toBe(false)
  expect(app.usageReads).toHaveLength(1)

  // A new session today reads it, and sends the grown totals with the count.
  app.state.now = at(3)
  app.state.sessions.push({ id: "ses_a", updated: at(2, 30) })
  expect(await app.usage.checkin()).toBe(true)
  expect(app.usageReads).toHaveLength(2)
  expect(app.checkins.at(-1)?.body).toMatchObject({ sessions: 1, usage: { lifetimeTokens: 1_300_000 } })

  // Six hours after that read, it is read again even though no count grew.
  app.state.usage = summary({ lifetimeTokens: 1_400_000 })
  app.state.now = at(8, 59)
  expect(await app.usage.checkin()).toBe(false)
  app.state.now = at(9)
  expect(await app.usage.checkin()).toBe(true)
  expect(app.usageReads).toHaveLength(3)
  expect(app.checkins.at(-1)?.body).toMatchObject({ usage: { lifetimeTokens: 1_400_000 } })

  // The next UTC day's first check-in reads it again.
  app.state.now = at(24, 30)
  expect(await app.usage.checkin()).toBe(true)
  expect(app.usageReads).toHaveLength(4)
})

test("reads the summary again when Vector starts a helper, without counting the helper as a session", async () => {
  const app = fixture()
  app.state.now = at(1)
  app.state.usage = summary()
  app.state.sessions.push({ id: "ses_a", updated: at(0, 30) })
  expect(await app.usage.checkin()).toBe(true)
  expect(app.usageReads).toHaveLength(1)

  // A Vectorscope review's spend reaches the server only in the report, so it is read within the hour, not six hours on.
  app.state.now = at(2)
  app.state.sessions.push({ id: "ses_review", internal: "vectorscope.review", updated: at(1, 30) })
  app.state.usage = summary({ lifetimeTokens: 1_300_000 })
  expect(await app.usage.checkin()).toBe(true)
  expect(app.usageReads).toHaveLength(2)
  expect(app.checkins.at(-1)?.body).toMatchObject({
    sessions: 1,
    subagentSessions: 0,
    usage: { lifetimeTokens: 1_300_000 },
  })

  // The same helper still at work an hour later is no reason to read it again.
  app.state.now = at(3)
  app.state.sessions[1].updated = at(2, 30)
  app.state.usage = summary({ lifetimeTokens: 1_310_000 })
  expect(await app.usage.checkin()).toBe(false)
  expect(app.usageReads).toHaveLength(2)

  // An autocomplete run under the session is a helper too, not a subagent session.
  app.state.now = at(4)
  app.state.sessions.push({
    id: "ses_autocomplete",
    parentID: "ses_a",
    internal: "codespace.autocomplete",
    updated: at(3, 30),
  })
  app.state.usage = summary({ lifetimeTokens: 1_350_000 })
  expect(await app.usage.checkin()).toBe(true)
  expect(app.usageReads).toHaveLength(3)
  expect(app.checkins.at(-1)?.body).toMatchObject({
    sessions: 1,
    subagentSessions: 0,
    usage: { lifetimeTokens: 1_350_000 },
  })
})

test("a failed count reports the install once with zero counts and the next working count replaces them", async () => {
  const app = fixture({ listStatus: 503 })
  const failing = createUsageCheckin({
    ...app.options,
    token: async () => {
      throw new Error("credential store locked")
    },
  })

  expect(await failing.checkin()).toBe(true)
  expect(app.checkins[0].authorization).toBeNull()
  expect(app.checkins[0].body).toMatchObject({ sessions: 0, subagentSessions: 0 })

  expect(await failing.checkin()).toBe(false)
  expect(app.checkins).toHaveLength(1)

  app.state.listStatus = undefined
  app.state.sessions.push({ id: "ses_a", updated: at(14) }, { id: "ses_b", parentID: "ses_a", updated: at(15) })
  expect(await failing.checkin()).toBe(true)
  expect(app.checkins[1].body).toMatchObject({ sessions: 1, subagentSessions: 1 })
})

test("leaves out the account header and the usage report when signed out", async () => {
  const app = fixture()
  app.state.token = undefined
  app.state.usage = summary()

  expect(await app.usage.checkin()).toBe(true)

  expect(app.checkins[0].authorization).toBeNull()
  // The server keeps model use only with an account, so a signed-out install does not read the summary at all.
  expect(app.checkins[0].body).not.toHaveProperty("usage")
  expect(app.usageReads).toHaveLength(0)
  expect(await app.usage.checkin()).toBe(false)
})

test("retries later the same day when the check-in is not accepted", async () => {
  const app = fixture({ checkinStatus: 503 })

  expect(await app.usage.checkin()).toBe(false)
  expect(app.store.has("sent")).toBe(false)

  app.state.checkinStatus = 204
  expect(await app.usage.checkin()).toBe(true)
  expect(app.checkins).toHaveLength(2)
  expect(app.store.get("sent")).toEqual({ day: "2026-10-09", sessions: 0, subagentSessions: 0 })
})

test("never throws when the site is unreachable", async () => {
  const app = fixture()
  const offline = createUsageCheckin({ ...app.options, endpoint: "http://127.0.0.1:9/api/usage/checkin" })

  expect(await offline.checkin()).toBe(false)
  expect(app.store.has("sent")).toBe(false)
})

test("sends nothing and creates no install ID while sharing is off", async () => {
  const app = fixture()
  app.state.enabled = false

  expect(await app.usage.checkin()).toBe(false)

  expect(app.lists).toHaveLength(0)
  expect(app.checkins).toHaveLength(0)
  expect(app.store.size).toBe(0)
})

test("sends nothing without an endpoint", async () => {
  const app = fixture()
  const development = createUsageCheckin({ ...app.options, endpoint: undefined })

  expect(await development.checkin()).toBe(false)

  expect(app.lists).toHaveLength(0)
  expect(app.checkins).toHaveLength(0)
})

test("keeps a stored install ID and replaces a malformed one", async () => {
  const app = fixture()
  app.store.set("installId", "not-a-uuid")

  await app.usage.checkin()
  const replaced = app.store.get("installId")
  expect(replaced).not.toBe("not-a-uuid")

  app.state.now = TODAY + DAY
  await app.usage.checkin()
  expect(app.checkins.map((checkin) => (checkin.body as { installId: string }).installId)).toEqual([replaced, replaced])
})

test("concurrent triggers share one check-in", async () => {
  const app = fixture()

  expect(await Promise.all([app.usage.checkin(), app.usage.checkin()])).toEqual([true, true])

  expect(app.checkins).toHaveLength(1)
})

test("start checks in after the delay, keeps checking on the interval and stop ends it", async () => {
  const app = fixture()
  const usage = createUsageCheckin({ ...app.options, delay: 1, interval: 20 })
  usage.start()
  await until(() => app.checkins.length === 1)
  expect(app.checkins).toHaveLength(1)

  app.state.sessions.push({ id: "ses_a", updated: at(15) })
  await until(() => app.checkins.length === 2)
  usage.stop()
  // Joins a tick still in flight, so nothing is left running once it resolves.
  await usage.checkin()
  expect(app.checkins[1].body).toMatchObject({ sessions: 1, subagentSessions: 0 })

  const listed = app.lists.length
  await Bun.sleep(80)
  expect(app.lists).toHaveLength(listed)
})

test("the last tick of a UTC day lands just before midnight instead of a full interval later", async () => {
  const evening = fixture()
  evening.state.now = at(24) - 5 * 60 * 1000 - 30
  const late = createUsageCheckin({ ...evening.options, delay: 1, interval: 60_000 })
  late.start()
  await until(() => evening.lists.length >= 2)
  late.stop()
  await late.checkin()
  expect(evening.lists.length).toBeGreaterThanOrEqual(2)

  const afternoon = fixture()
  const early = createUsageCheckin({ ...afternoon.options, delay: 1, interval: 60_000 })
  early.start()
  await until(() => afternoon.checkins.length === 1)
  await Bun.sleep(100)
  early.stop()
  expect(afternoon.lists).toHaveLength(1)
})

test("stop cancels a pending start", async () => {
  const app = fixture()
  const usage = createUsageCheckin({ ...app.options, delay: 20, interval: 60_000 })
  usage.start()
  usage.stop()
  await Bun.sleep(60)

  expect(app.lists).toHaveLength(0)
  expect(app.checkins).toHaveLength(0)
})

test("only packaged release builds report to vectordev.ai unless a development URL is set", () => {
  expect(usageCheckinEndpoint({ packaged: true, channel: "prod", override: undefined })).toBe(
    "https://vectordev.ai/api/usage/checkin",
  )
  expect(usageCheckinEndpoint({ packaged: true, channel: "beta", override: "http://localhost:3000/x" })).toBe(
    "https://vectordev.ai/api/usage/checkin",
  )
  expect(usageCheckinEndpoint({ packaged: true, channel: "dev", override: undefined })).toBeUndefined()
  expect(usageCheckinEndpoint({ packaged: false, channel: "prod", override: undefined })).toBeUndefined()
  expect(usageCheckinEndpoint({ packaged: false, channel: "prod", override: "not a url" })).toBeUndefined()
  expect(
    usageCheckinEndpoint({ packaged: false, channel: "dev", override: "http://localhost:3000/api/usage/checkin" }),
  ).toBe("http://localhost:3000/api/usage/checkin")
})

test("reads and sends nothing while Vector Local or the first run's hold keeps the check-in back", async () => {
  const app = fixture()
  app.state.sessions.push({ id: "ses_a", updated: at(9) })
  const allowed = { current: false }
  const sent: string[] = []
  const usage = createUsageCheckin({
    ...app.options,
    allowed: () => allowed.current,
    send: (url, init) => {
      sent.push(url)
      return fetch(url, init)
    },
  })
  expect(await usage.checkin()).toBe(false)
  expect(app.lists).toHaveLength(0)
  expect(app.checkins).toHaveLength(0)
  // Allowed again (the person answered, or allowed the check-in), it checks in through Vector Local's send.
  allowed.current = true
  expect(await usage.checkin()).toBe(true)
  expect(sent).toEqual([app.options.endpoint!])
  expect(app.checkins).toHaveLength(1)
  expect(app.lists).toHaveLength(1)
})

test("stops a check-in that Vector Local closed while the sessions were being counted", async () => {
  const app = fixture()
  app.state.sessions.push({ id: "ses_a", updated: at(9) })
  const checks = { count: 0 }
  // Allowed when asked first, refused when asked again just before sending.
  const usage = createUsageCheckin({ ...app.options, allowed: () => checks.count++ === 0 })
  expect(await usage.checkin()).toBe(false)
  expect(app.lists).toHaveLength(1)
  expect(app.checkins).toHaveLength(0)
})
