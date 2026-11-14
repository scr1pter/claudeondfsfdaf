import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { handleRoadmap } from "../api/roadmap/index"
import { mintCliToken } from "../api/_lib/cli-token"
import { perkServices } from "../api/_lib/codium-perks"
import { buildSnapshot, snapshotKey, type SnapshotFacts } from "../api/_lib/codium-snapshot"
import {
  ballotKey,
  ballotsKey,
  castBallot,
  closeBallot,
  decideBallot,
  eraseAccountBallots,
  nominateFeature,
  nominationsKey,
  openBallot,
  ownerNominations,
  ownerTally,
  previousQuarter,
  quarterBounds,
  quarterOf,
  quartersKey,
  ROADMAP_MINIMUM,
  ROADMAP_PLANNED,
  roadmapText,
  voterField,
} from "../api/_lib/roadmap"
import type { PlanId } from "../packages/schema/src/codium-plan"
import { parseRoadmapArguments, runRoadmapBallot } from "../script/roadmap-ballot"
import { roadmapEnvironment, roadmapFakes } from "./roadmap-fixture"
import { invoke, jsonHeaders } from "./support-reports-fixture"

// WP A34: the roadmap vote. Max and Ultra vote once a quarter and may change the vote until it closes; Ultra
// nominates once a quarter (HSETNX); results show only after the close, as totals, once at least 20 ballots from
// accounts entitled when they voted are counted; the winner is "planned for the next release cycle", with no date.
// Who may vote is the server's decision from the snapshot (S1). The store is a fake (roadmap-fixture.ts); the last
// case sends the same commands to a real Valkey when VECTOR_TEST_REDIS_URL is set (the CI lane).

const DAY = 86_400_000
const HOUR = 3_600_000
// Mid-November 2026: the vote below runs in 2026-q4; last quarter's closed in 2026-q3.
const NOW = Date.UTC(2026, 10, 15, 12)
const QUARTER = quarterOf(NOW)
const PREVIOUS = previousQuarter(QUARTER)
const CANDIDATES = [
  { id: "offline-sync", title: "Offline sync for agent sessions" },
  { id: "diff-search", title: "Search inside diffs", detail: "Find a change across every open review." },
  { id: "voice-notes", title: "Voice notes in the composer" },
]
const MAX = "1a2b3c4d-0000-4000-8000-000000000001"
const ULTRA = "1a2b3c4d-0000-4000-8000-000000000002"
const PRO = "1a2b3c4d-0000-4000-8000-000000000003"

let restore = () => {}
let fakes = roadmapFakes()
beforeEach(() => {
  restore = roadmapEnvironment()
  fakes = roadmapFakes()
})
afterEach(() => restore())

const token = (account: string) =>
  mintCliToken({ id: account, email: `${account}@example.invalid` }, Date.now(), "desktop").token

function seedPlan(account: string, plan: PlanId | null, state: SnapshotFacts["state"] = "active", now = NOW) {
  const reason =
    state === "paused"
      ? ("payment_failed" as const)
      : state === "frozen"
        ? ("disputed" as const)
        : state === "ended"
          ? ("canceled" as const)
          : undefined
  const snapshot = buildSnapshot(
    {
      account,
      state,
      ...(reason ? { reason } : {}),
      plan,
      ...(plan ? { subscription: `sub_${account.slice(-4)}` } : {}),
      periodStart: state === "renewing" ? now - 30 * DAY : now - DAY,
      periodEnd: state === "renewing" ? now - 60_000 : now + 29 * DAY,
      cancelAtPeriodEnd: false,
      source: "webhook",
    },
    undefined,
    now,
  )
  fakes.store.command(["SET", snapshotKey(account), JSON.stringify(snapshot)])
}

/** Publishes `quarter`'s ballot as the owner's script does, at a time inside that quarter. */
async function publish(quarter: string, times: { opensAt?: number; closesAt?: number; at?: number } = {}) {
  const bounds = quarterBounds(quarter)
  const at = times.at ?? bounds.start + HOUR
  return openBallot(
    {
      quarter,
      opensAt: times.opensAt ?? bounds.start,
      closesAt: times.closesAt ?? bounds.end - DAY,
      candidates: CANDIDATES,
    },
    { mode: "test", fetcher: fakes.fetcher, now: at },
  )
}

function roadmap(
  account: string | undefined,
  input: { body?: Record<string, unknown>; now?: number; authorization?: string; ip?: string } = {},
) {
  const authorization = input.authorization ?? (account ? `Bearer ${token(account)}` : undefined)
  return invoke((request, response) => handleRoadmap(request, response, fakes.fetcher, () => input.now ?? NOW), {
    method: input.body ? "POST" : "GET",
    headers: jsonHeaders(input.ip ?? "192.0.2.40", authorization ? { authorization } : {}),
    ...(input.body ? { body: input.body } : {}),
  })
}

const vote = (account: string, choice: string, now = NOW, quarter = quarterOf(now)) =>
  roadmap(account, { body: { action: "vote", quarter, choice }, now })

/** Casts `count` ballots for `choice` in a closed quarter, each from its own Max or Ultra account. */
async function castMany(quarter: string, choice: string, count: number, prefix: string) {
  const bounds = quarterBounds(quarter)
  for (let index = 0; index < count; index++)
    await castBallot(
      `${prefix}-${index}`,
      { quarter, choice, plan: index % 2 ? "vector-200" : "vector-100" },
      fakes.fetcher,
      bounds.start + 2 * HOUR + index,
    )
}

describe("voting", () => {
  test("Max votes, changes the vote until the close, and keeps one ballot per account", async () => {
    await publish(QUARTER, { closesAt: NOW + 10 * DAY })
    seedPlan(MAX, "vector-100")
    const before = await roadmap(MAX)
    expect(before.status).toBe(200)
    expect(before.body).toMatchObject({
      quarter: QUARTER,
      ballot: { quarter: QUARTER, open: true, closesAt: NOW + 10 * DAY, candidates: CANDIDATES },
      vote: { allowed: true },
      nominate: { allowed: false },
    })
    expect(before.body.ballot.choice).toBeUndefined()

    const first = await vote(MAX, "diff-search")
    expect(first.status).toBe(200)
    expect(first.body.ballot.choice).toBe("diff-search")
    const changed = await vote(MAX, "voice-notes", NOW + DAY)
    expect(changed.status).toBe(200)
    expect(changed.body.ballot.choice).toBe("voice-notes")

    const ballots = fakes.store.hash(ballotsKey(QUARTER))
    expect([...ballots.keys()]).toEqual([voterField(MAX)])
    expect(JSON.parse(ballots.get(voterField(MAX))!)).toEqual({
      v: 1,
      choice: "voice-notes",
      plan: "vector-100",
      at: NOW + DAY,
    })
    // An open vote shows no counts at all.
    expect(JSON.stringify(changed.body)).not.toContain("votes")
    expect(changed.body.results).toBeUndefined()
  })

  test("Ultra nominates once a quarter; a second nomination is refused (HSETNX)", async () => {
    seedPlan(ULTRA, "vector-200")
    const view = await roadmap(ULTRA)
    expect(view.body).toMatchObject({ vote: { allowed: true }, nominate: { allowed: true } })
    // No ballot is needed to nominate: a nomination is for the next one.
    expect(view.body.ballot).toBeUndefined()

    const nominated = await roadmap(ULTRA, {
      body: { action: "nominate", quarter: QUARTER, title: "  Pinned   agent tabs ", detail: "Keep\nthem open." },
    })
    expect(nominated.status).toBe(200)
    expect(nominated.body.nominate).toEqual({
      allowed: false,
      nomination: { title: "Pinned agent tabs", detail: "Keep them open.", at: NOW },
    })
    const again = await roadmap(ULTRA, { body: { action: "nominate", quarter: QUARTER, title: "Another feature" } })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("ROADMAP_ALREADY_NOMINATED")
    expect(fakes.store.commands.filter((command) => command[0] === "HSETNX")).toHaveLength(2)
    expect([...fakes.store.hash(nominationsKey(QUARTER)).values()].map((value) => JSON.parse(value).title)).toEqual([
      "Pinned agent tabs",
    ])
    expect(fakes.store.members(quartersKey())).toEqual([QUARTER])
    // The next quarter starts afresh.
    const next = quarterBounds(QUARTER).end + DAY
    seedPlan(ULTRA, "vector-200", "active", next)
    expect((await roadmap(ULTRA, { now: next })).body.nominate).toEqual({ allowed: true })
  })

  test("nominations are plain text of a bounded length", async () => {
    seedPlan(ULTRA, "vector-200")
    const refused = [
      { title: "ab" },
      { title: "x".repeat(81) },
      { title: "Pinned tabs\u202e" },
      { title: "Pinned\u0007tabs" },
      { title: "Pinned tabs", detail: "y".repeat(281) },
      { title: 42 },
    ]
    for (const body of refused) {
      const result = await roadmap(ULTRA, { body: { action: "nominate", quarter: QUARTER, ...body } })
      expect(result.status).toBe(400)
      expect(result.body.error.code).toBe("ROADMAP_NOMINATION_INVALID")
    }
    expect(fakes.store.hash(nominationsKey(QUARTER)).size).toBe(0)
    // A blank detail is no detail.
    const blank = await roadmap(ULTRA, {
      body: { action: "nominate", quarter: QUARTER, title: "Pinned tabs", detail: "  " },
    })
    expect(blank.status).toBe(200)
    expect(blank.body.nominate.nomination).toEqual({ title: "Pinned tabs", at: NOW })
    expect(roadmapText(" a\tb\n c ", 10)).toBe("a b c")
    expect(roadmapText("é".repeat(80), 80, 3)).toBe("é".repeat(80))
  })

  test("a vote only reaches this quarter's open ballot, for one of its candidates", async () => {
    seedPlan(MAX, "vector-100")
    const none = await vote(MAX, "diff-search")
    expect(none.status).toBe(409)
    expect(none.body.error.code).toBe("ROADMAP_CLOSED")

    await publish(QUARTER, { opensAt: NOW + DAY, closesAt: NOW + 5 * DAY })
    const early = await vote(MAX, "diff-search")
    expect(early.status).toBe(409)
    // An upcoming ballot is shown, not open.
    expect((await roadmap(MAX)).body.ballot).toMatchObject({ open: false, opensAt: NOW + DAY })

    const later = NOW + 5 * DAY
    seedPlan(MAX, "vector-100", "active", later)
    expect((await vote(MAX, "diff-search", later)).body.error.code).toBe("ROADMAP_CLOSED")

    const during = NOW + 2 * DAY
    seedPlan(MAX, "vector-100", "active", during)
    expect((await vote(MAX, "diff-search", during, PREVIOUS)).body.error.code).toBe("ROADMAP_CLOSED")
    const unknown = await vote(MAX, "teleport", during)
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.code).toBe("ROADMAP_CHOICE_INVALID")
    const action = await roadmap(MAX, { body: { action: "delete" }, now: during })
    expect(action.status).toBe(400)
    expect(action.body.error.code).toBe("ROADMAP_ACTION_INVALID")
    expect(fakes.store.hash(ballotsKey(QUARTER)).size).toBe(0)
    expect((await vote(MAX, "diff-search", during)).status).toBe(200)
  })
})

describe("who may vote (S1, S3)", () => {
  test("the server refuses Plus, Pro, no plan, a paused, frozen or ended plan, and a Max nomination", async () => {
    await publish(QUARTER, { closesAt: NOW + 10 * DAY })
    const cases: [string, PlanId | null, SnapshotFacts["state"], number, string, Record<string, unknown>?][] = [
      [PRO, "vector-50", "active", 403, "CODIUM_PERK_REQUIRED", { perk: "vote", plan: "vector-100" }],
      ["1a2b3c4d-0000-4000-8000-000000000010", "vector-10", "active", 403, "CODIUM_PERK_REQUIRED"],
      ["1a2b3c4d-0000-4000-8000-000000000011", null, "none", 402, "MODEL_PLAN_REQUIRED"],
      ["1a2b3c4d-0000-4000-8000-000000000012", "vector-100", "paused", 402, "MODEL_PLAN_PAYMENT_REQUIRED"],
      ["1a2b3c4d-0000-4000-8000-000000000013", "vector-200", "frozen", 403, "MODEL_PLAN_BLOCKED"],
      ["1a2b3c4d-0000-4000-8000-000000000014", "vector-200", "ended", 402, "MODEL_PLAN_REQUIRED"],
    ]
    for (const [account, plan, state, status, code, detail] of cases) {
      seedPlan(account, plan, state)
      // A patched client that claims a bigger plan changes nothing: only the snapshot counts.
      const result = await roadmap(account, {
        body: { action: "vote", quarter: QUARTER, choice: "diff-search", plan: "vector-200", vote: true },
      })
      expect(result.status).toBe(status)
      expect(result.body.error.code).toBe(code)
      if (detail) expect(result.body.error).toMatchObject(detail)
      const view = await roadmap(account)
      expect(view.status).toBe(200)
      expect(view.body.vote.allowed).toBe(false)
    }
    expect(fakes.store.hash(ballotsKey(QUARTER)).size).toBe(0)
    expect((await roadmap(PRO)).body.vote).toEqual({ allowed: false, reason: "plan" })
    expect((await roadmap("1a2b3c4d-0000-4000-8000-000000000012")).body.vote.reason).toBe("payment")
    expect((await roadmap("1a2b3c4d-0000-4000-8000-000000000013")).body.vote.reason).toBe("hold")

    seedPlan(MAX, "vector-100")
    const nominate = await roadmap(MAX, { body: { action: "nominate", quarter: QUARTER, title: "Pinned agent tabs" } })
    expect(nominate.status).toBe(403)
    expect(nominate.body.error).toMatchObject({ code: "CODIUM_PERK_REQUIRED", perk: "nominate", plan: "vector-200" })
    expect(fakes.store.hash(nominationsKey(QUARTER)).size).toBe(0)
  })

  test("a renewing plan still votes, with no Stripe call (M4)", async () => {
    await publish(QUARTER, { closesAt: NOW + 10 * DAY })
    seedPlan(ULTRA, "vector-200", "renewing")
    const origins = new Set<string>()
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      origins.add(new URL(input instanceof Request ? input.url : String(input)).origin)
      return fakes.fetcher(input, init)
    }) as typeof fetch
    const result = await invoke((request, response) => handleRoadmap(request, response, spy, () => NOW), {
      method: "POST",
      headers: jsonHeaders("192.0.2.41", { authorization: `Bearer ${token(ULTRA)}` }),
      body: { action: "vote", quarter: QUARTER, choice: "offline-sync" },
    })
    expect(result.status).toBe(200)
    expect(result.body.ballot.choice).toBe("offline-sync")
    expect([...origins]).toEqual(["https://kv.roadmap.invalid"])
  })

  test("only a Vector account token is accepted: no token, a run token or a revoked account get 401", async () => {
    seedPlan(MAX, "vector-100")
    expect((await roadmap(undefined)).status).toBe(401)
    for (const authorization of ["Bearer vrt_fixture.run", "Bearer vht_fixture.hosted", "Basic abc", "Bearer vct_x"])
      expect((await roadmap(MAX, { authorization })).status).toBe(401)
    fakes.store.command(["SET", `vector:cli-revoked:${MAX}`, "1"])
    const revoked = await roadmap(MAX)
    expect(revoked.status).toBe(401)
    expect(revoked.body.error.code).toBe("CLI_TOKEN_INVALID")
    expect((await roadmap(MAX, { body: { action: "vote", quarter: QUARTER, choice: "x" } })).status).toBe(401)
  })

  test("other methods are refused, and votes are limited per account", async () => {
    seedPlan(MAX, "vector-100")
    const put = await invoke((request, response) => handleRoadmap(request, response, fakes.fetcher, () => NOW), {
      method: "PUT",
      headers: jsonHeaders("192.0.2.42", { authorization: `Bearer ${token(MAX)}` }),
    })
    expect(put.status).toBe(405)
    await publish(QUARTER, { closesAt: NOW + 10 * DAY })
    const answers: number[] = []
    for (let index = 0; index < 31; index++) answers.push((await vote(MAX, "diff-search")).status)
    expect(answers.slice(0, 30).every((status) => status === 200)).toBe(true)
    expect(answers[30]).toBe(429)
  })
})

describe("results", () => {
  test("results show only after the close, once at least 20 ballots from entitled accounts are counted", async () => {
    await publish(PREVIOUS)
    // 19 good ballots, plus ballots that must not count: a plan without the vote, one cast after the close, and a
    // choice that is not on the ballot.
    await castMany(PREVIOUS, "diff-search", 12, "a")
    await castMany(PREVIOUS, "offline-sync", 7, "b")
    const ballots = fakes.store.hash(ballotsKey(PREVIOUS))
    ballots.set("forged-pro", JSON.stringify({ v: 1, choice: "voice-notes", plan: "vector-50", at: NOW - 60 * DAY }))
    ballots.set("forged-late", JSON.stringify({ v: 1, choice: "voice-notes", plan: "vector-200", at: NOW }))
    ballots.set("forged-choice", JSON.stringify({ v: 1, choice: "teleport", plan: "vector-200", at: NOW - 60 * DAY }))
    ballots.set("garbage", "{not json")

    seedPlan(MAX, "vector-100")
    const short = await roadmap(MAX)
    expect(short.body.results).toEqual({
      quarter: PREVIOUS,
      closedAt: quarterBounds(PREVIOUS).end - DAY,
      minimum: ROADMAP_MINIMUM,
      published: false,
    })

    // The 20th: this account's own ballot, cast last quarter while it had Max.
    await castBallot(
      MAX,
      { quarter: PREVIOUS, choice: "offline-sync", plan: "vector-100" },
      fakes.fetcher,
      NOW - 70 * DAY,
    )
    // It has since moved to Pro: a ballot counts by the plan it was cast with.
    seedPlan(MAX, "vector-50")
    const published = await roadmap(MAX)
    expect(published.body.results).toEqual({
      quarter: PREVIOUS,
      closedAt: quarterBounds(PREVIOUS).end - DAY,
      minimum: ROADMAP_MINIMUM,
      published: true,
      counted: 20,
      totals: [
        { id: "diff-search", title: "Search inside diffs", votes: 12 },
        { id: "offline-sync", title: "Offline sync for agent sessions", votes: 8 },
        { id: "voice-notes", title: "Voice notes in the composer", votes: 0 },
      ],
      tied: false,
      winner: { id: "diff-search", title: "Search inside diffs", planned: ROADMAP_PLANNED },
      choice: "offline-sync",
    })
    expect(ROADMAP_PLANNED).toBe("Planned for the next release cycle.")
    // Results are only totals: no voter, no account and no time of any ballot.
    const text = JSON.stringify(published.body)
    expect(text).not.toContain(MAX)
    expect(text).not.toContain(voterField(MAX))
    expect(text).not.toContain("a-0")
  })

  test("this quarter's results replace last quarter's once its vote closes", async () => {
    await publish(PREVIOUS)
    await castMany(PREVIOUS, "voice-notes", 20, "p")
    await publish(QUARTER, { closesAt: NOW + DAY, at: NOW - DAY })
    await castMany(QUARTER, "offline-sync", 20, "q")
    seedPlan(MAX, "vector-100")
    const open = await roadmap(MAX)
    expect(open.body.results.quarter).toBe(PREVIOUS)
    expect(open.body.ballot.quarter).toBe(QUARTER)
    const after = NOW + 2 * DAY
    seedPlan(MAX, "vector-100", "active", after)
    const closed = await roadmap(MAX, { now: after })
    expect(closed.body.ballot).toBeUndefined()
    expect(closed.body.results).toMatchObject({ quarter: QUARTER, published: true, counted: 20 })
    expect(closed.body.results.winner.id).toBe("offline-sync")
  })

  test("a tie names no winner until the owner records one of the tied candidates", async () => {
    await publish(PREVIOUS)
    await castMany(PREVIOUS, "diff-search", 10, "a")
    await castMany(PREVIOUS, "voice-notes", 10, "b")
    seedPlan(MAX, "vector-100")
    const tied = await roadmap(MAX)
    expect(tied.body.results).toMatchObject({ published: true, counted: 20, tied: true })
    expect(tied.body.results.winner).toBeUndefined()
    const owner = { mode: "test" as const, fetcher: fakes.fetcher, now: NOW }
    await expect(decideBallot(PREVIOUS, "offline-sync", owner)).rejects.toThrow("tied candidates")
    await decideBallot(PREVIOUS, "voice-notes", owner)
    const decided = await roadmap(MAX)
    expect(decided.body.results.winner).toEqual({
      id: "voice-notes",
      title: "Voice notes in the composer",
      planned: ROADMAP_PLANNED,
    })
    expect(decided.body.results.tied).toBe(true)
  })
})

describe("deleting an account (P5, for A57)", () => {
  test("erases the account's ballots and nominations from every quarter, and nobody else's", async () => {
    await publish(PREVIOUS)
    await castMany(PREVIOUS, "diff-search", 20, "keep")
    await castBallot(
      ULTRA,
      { quarter: PREVIOUS, choice: "voice-notes", plan: "vector-200" },
      fakes.fetcher,
      NOW - 70 * DAY,
    )
    await publish(QUARTER, { closesAt: NOW + DAY, at: NOW - DAY })
    await castBallot(ULTRA, { quarter: QUARTER, choice: "offline-sync", plan: "vector-200" }, fakes.fetcher, NOW)
    await nominateFeature(
      ULTRA,
      { quarter: QUARTER, title: "Pinned agent tabs", plan: "vector-200" },
      fakes.fetcher,
      NOW,
    )
    // A nomination in a quarter without a ballot is found too.
    const lastYear = Date.UTC(2025, 7, 1)
    await nominateFeature(
      ULTRA,
      { quarter: quarterOf(lastYear), title: "Older nomination", plan: "vector-200" },
      fakes.fetcher,
      lastYear,
    )
    seedPlan(MAX, "vector-100")
    expect((await roadmap(MAX)).body.results.counted).toBe(21)

    expect(await eraseAccountBallots(ULTRA, fakes.fetcher, NOW)).toBe(4)
    const field = voterField(ULTRA)
    for (const quarter of [PREVIOUS, QUARTER, quarterOf(lastYear)]) {
      expect(fakes.store.hash(ballotsKey(quarter)).has(field)).toBe(false)
      expect(fakes.store.hash(nominationsKey(quarter)).has(field)).toBe(false)
    }
    expect(fakes.store.hash(ballotsKey(PREVIOUS)).size).toBe(20)
    // The closed vote's totals drop the erased ballot.
    expect((await roadmap(MAX)).body.results.counted).toBe(20)
    expect(await eraseAccountBallots(ULTRA, fakes.fetcher, NOW)).toBe(0)
    // No key or field ever named the account.
    const everything = [...fakes.store.keys(), ...fakes.store.commands.flat()].join("\n")
    expect(everything).not.toContain(`roadmap:${ULTRA}`)
    expect(fakes.store.keys().some((key) => key.includes(ULTRA) && key.includes("roadmap"))).toBe(false)
  })
})

describe("the owner's ballot", () => {
  const owner = () => ({ mode: "test" as const, fetcher: fakes.fetcher, now: NOW })

  test("a ballot opens and closes inside its quarter, in the future, with 2 to 10 undated candidates", async () => {
    const bounds = quarterBounds(QUARTER)
    const base = { quarter: QUARTER, opensAt: NOW, closesAt: NOW + DAY, candidates: CANDIDATES }
    const refused: [Partial<typeof base> & { candidates?: unknown }, string][] = [
      [{ candidates: CANDIDATES.slice(0, 1) }, "2 to 10 candidates"],
      [{ candidates: [...CANDIDATES, { id: "offline-sync", title: "Duplicate id" }] }, "2 to 10 candidates"],
      [{ candidates: [{ id: "Bad Id", title: "Valid title" }, CANDIDATES[0]] }, "2 to 10 candidates"],
      [{ candidates: [{ id: "a", title: "Two  spaces" }, CANDIDATES[0]] }, "2 to 10 candidates"],
      [{ candidates: [{ id: "a", title: "Ships in December" }, CANDIDATES[0]] }, "never says when"],
      [{ candidates: [{ id: "a", title: "Coming soon" }, CANDIDATES[0]] }, "never says when"],
      [{ candidates: [{ id: "a", title: "Sync", detail: "Planned for Q1" }, CANDIDATES[0]] }, "never says when"],
      [{ candidates: [{ id: "a", title: "Ready by 2027" }, CANDIDATES[0]] }, "never says when"],
      [{ opensAt: bounds.start - 1 }, "open inside"],
      [{ closesAt: bounds.end + 1 }, "no later than the end"],
      [{ closesAt: NOW - 1, opensAt: NOW - DAY }, "close in the future"],
      [{ quarter: "2026-q5" }, "2026-q4"],
    ]
    for (const [change, message] of refused)
      await expect(openBallot({ ...base, ...change }, owner())).rejects.toThrow(message)
    expect(fakes.store.get(ballotKey(QUARTER))).toBeUndefined()

    await openBallot(base, owner())
    expect(fakes.store.members(quartersKey())).toEqual([QUARTER])
    await expect(openBallot(base, owner())).rejects.toThrow("--replace")
    const replaced = await openBallot({ ...base, candidates: CANDIDATES.slice(0, 2) }, { ...owner(), replace: true })
    expect(replaced.candidates).toHaveLength(2)
    seedPlan(MAX, "vector-100")
    await vote(MAX, "diff-search")
    await expect(openBallot(base, { ...owner(), replace: true })).rejects.toThrow("has 1 vote and")
  })

  test("close moves the close within the quarter; results and nominations print no voter", async () => {
    await publish(QUARTER, { closesAt: NOW + 10 * DAY, at: NOW - DAY })
    await expect(closeBallot(QUARTER, { ...owner(), at: quarterBounds(QUARTER).end + 1 })).rejects.toThrow("within")
    expect((await closeBallot(QUARTER, { ...owner(), at: NOW + 2 * DAY })).closesAt).toBe(NOW + 2 * DAY)
    expect((await closeBallot(QUARTER, owner())).closesAt).toBe(NOW)
    await expect(closeBallot(QUARTER, owner())).rejects.toThrow("already closed")

    await publish(PREVIOUS)
    await castMany(PREVIOUS, "diff-search", 21, "c")
    expect((await ownerTally(PREVIOUS, owner())).counted).toBe(21)
    const lines = await runRoadmapBallot(
      { command: "results", quarter: PREVIOUS, mode: "test" },
      { fetcher: fakes.fetcher, now: NOW },
    )
    expect(lines[0]).toContain("21 ballots counted, closed")
    expect(lines.at(-1)).toBe(`Winner: diff-search. ${ROADMAP_PLANNED}`)

    await nominateFeature(
      ULTRA,
      { quarter: QUARTER, title: "Pinned agent tabs", detail: "Keep them open.", plan: "vector-200" },
      fakes.fetcher,
      NOW,
    )
    expect((await ownerNominations(QUARTER, owner())).map((item) => item.title)).toEqual(["Pinned agent tabs"])
    const printed = await runRoadmapBallot(
      { command: "nominations", quarter: QUARTER, mode: "test" },
      { fetcher: fakes.fetcher, now: NOW },
    )
    expect(printed).toEqual([
      `${QUARTER}: 1 nomination (test store), for the next ballot:`,
      `- Pinned agent tabs (vector-200, ${new Date(NOW).toISOString().slice(0, 16)}Z)`,
      "  Keep them open.",
    ])
    expect([...lines, ...printed].join("\n")).not.toContain(voterField(ULTRA))
  })

  test("the command line", async () => {
    expect(
      parseRoadmapArguments([
        "open",
        "2026-q4",
        "--candidates",
        "ballot.json",
        "--closes",
        "2026-12-15",
        "--opens",
        "2026-11-20T09:00Z",
        "--mode",
        "live",
      ]),
    ).toEqual({
      command: "open",
      quarter: "2026-q4",
      candidates: "ballot.json",
      closesAt: Date.UTC(2026, 11, 15),
      opensAt: Date.UTC(2026, 10, 20, 9),
      replace: false,
      mode: "live",
    })
    expect(parseRoadmapArguments(["decide", "2026-q3", "diff-search", "--mode", "test"])).toEqual({
      command: "decide",
      quarter: "2026-q3",
      winner: "diff-search",
      mode: "test",
    })
    for (const argv of [
      ["open", "2026-q4", "--candidates", "b.json", "--closes", "2026-12-15"],
      ["open", "2026-q4", "--closes", "2026-12-15", "--mode", "test"],
      ["open", "2026-q4", "--candidates", "b.json", "--closes", "15/12/2026", "--mode", "test"],
      ["close", "2026-q4", "--replace", "--mode", "test"],
      ["results", "2026-4", "--mode", "test"],
      ["results", "2026-q4", "--at", "2026-12-01", "--mode", "test"],
      ["vote", "2026-q4", "--mode", "test"],
      ["decide", "2026-q4", "--mode", "test"],
    ])
      expect(() => parseRoadmapArguments(argv)).toThrow()
    const opened = await runRoadmapBallot(
      {
        command: "open",
        quarter: QUARTER,
        candidates: "ballot.json",
        closesAt: NOW + DAY,
        replace: false,
        mode: "test",
      },
      { fetcher: fakes.fetcher, now: NOW, read: async () => JSON.stringify(CANDIDATES) },
    )
    expect(opened[0]).toBe(`${QUARTER}: ballot published (test store) with 3 candidates.`)
  })
})

describe("listing", () => {
  test("the vote perk is ready wherever the store is configured", () => {
    expect(perkServices.vote?.(fakes.fetcher)).toBe(true)
    const restoreStore = roadmapEnvironment({ KV_REST_API_URL: undefined, KV_REST_API_TOKEN: undefined })
    expect(perkServices.vote?.(fakes.fetcher)).toBe(false)
    restoreStore()
  })
})

// ── The same commands on Valkey (CI) ───────────────────────────────────────────────────────────────────────────────

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL

describe.skipIf(!valkeyURL)("the roadmap store on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as (string | number)[]
    return Response.json({ result: (await client!.send(String(command[0]), command.slice(1).map(String))) ?? null })
  }) as typeof fetch
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
  })

  test("ballots, nominations, results and erase", async () => {
    const owner = { mode: "test" as const, fetcher, now: NOW - DAY }
    await openBallot({ quarter: QUARTER, opensAt: NOW - DAY, closesAt: NOW + DAY, candidates: CANDIDATES }, owner)
    await expect(
      openBallot({ quarter: QUARTER, opensAt: NOW - DAY, closesAt: NOW + DAY, candidates: CANDIDATES }, owner),
    ).rejects.toThrow("--replace")
    for (let index = 0; index < 20; index++)
      await castBallot(`voter-${index}`, { quarter: QUARTER, choice: "diff-search", plan: "vector-100" }, fetcher, NOW)
    await castBallot("voter-0", { quarter: QUARTER, choice: "voice-notes", plan: "vector-100" }, fetcher, NOW + 1)
    await nominateFeature("voter-1", { quarter: QUARTER, title: "Pinned agent tabs", plan: "vector-200" }, fetcher, NOW)
    await expect(
      nominateFeature("voter-1", { quarter: QUARTER, title: "Again", plan: "vector-200" }, fetcher, NOW),
    ).rejects.toThrow("already nominated")
    const tally = await ownerTally(QUARTER, { mode: "test", fetcher })
    expect(tally.counted).toBe(20)
    expect(tally.totals.map((item) => item.votes)).toEqual([19, 1, 0])
    expect((await ownerNominations(QUARTER, { mode: "test", fetcher })).map((item) => item.title)).toEqual([
      "Pinned agent tabs",
    ])
    expect(await eraseAccountBallots("voter-1", fetcher, NOW)).toBe(2)
    expect((await ownerTally(QUARTER, { mode: "test", fetcher })).counted).toBe(19)
    expect(await ownerNominations(QUARTER, { mode: "test", fetcher })).toEqual([])
  })
})
