import { describe, expect, test } from "bun:test"
import { normalizeTitle, titleSimilarity } from "@vectordevai/core/review/fingerprint"
import type { TeamPattern } from "@vectordevai/core/review/prompt"
import { teamPenalty } from "@vectordevai/core/review/select"
import {
  escapeVectorMarkers,
  findingMarker,
  guardedTeamPatterns,
  parseDismissalMarker,
  parseFindingMarker,
  setFindingStatus,
  teamPatterns,
  type GuardedComment,
} from "@vectordevai/core/review/state"
import {
  BOT_PUSH_MS,
  BULK_RESOLVE_MS,
  BULK_RESOLVE_THREADS,
  DISMISSAL_BY,
  DISMISSAL_WHY,
  guardedMemory,
  neverSuppress,
  sameTeamPattern,
  TEAM_CLOCK_SKEW_MS,
  TEAM_EXCLUSIONS,
  TEAM_MAX_WINDOW_DAYS,
  TEAM_MIN_WINDOW_DAYS,
  TEAM_SIMILARITY,
  TEAM_WINDOW_DAYS,
  TEAM_WRITERS,
  teamDemotion,
  teamDir,
  type DismissalBy,
  type DismissalWhy,
  type GuardedTeamInput,
  type GuardedTeamMemory,
  type TeamDismissal,
} from "@vectordevai/core/review/team"
import { FAILURE_CLASSES, type Category, type Finding } from "@vectordevai/core/review/types"

// VS-35a: guarded team memory's pure rules, on synthetic markers. No real `vector-dismissal` marker exists before
// VS-35's later window (the job writes none yet), so every body here is built from findingMarker() plus a literal
// dismissal-marker template, and every time is synthetic. The bulk-resolve and bot-push tests assume `at` is the
// dismissing action's own time (a reaction, a reply, a resolve event), as TeamDismissal.at requires, never a comment's
// created_at or updated_at.

const NOW = Date.UTC(2026, 10, 7, 12, 0)
const DAY = 86_400_000
const EDGE = NOW - TEAM_WINDOW_DAYS * DAY
const OFF = { guardrail: "off" } as const
const STRICT = { guardrail: "strict" } as const
const INPUT: GuardedTeamInput = { now: NOW }
const WORDS = ["button", "color", "contrast"]
const PATTERN: TeamPattern = { category: "style", dir: "src/ui", words: WORDS }
const hash = (n: number) => n.toString(16).padStart(12, "0")

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}

function dismissal(
  n: number,
  options: {
    by?: DismissalBy
    why?: DismissalWhy
    at?: number
    pr?: number
    pattern?: TeamPattern
    replied?: boolean
    codeChanged?: boolean
  } = {},
): TeamDismissal {
  return {
    pattern: options.pattern ?? PATTERN,
    marker: { by: options.by ?? "w", why: options.why ?? "fp", hash: hash(n) },
    pr: options.pr ?? 1,
    at: options.at ?? NOW - DAY,
    ...(options.replied === undefined ? {} : { replied: options.replied }),
    ...(options.codeChanged === undefined ? {} : { codeChanged: options.codeChanged }),
  }
}

const excludedOf = (dismissals: readonly TeamDismissal[], input: GuardedTeamInput = INPUT) =>
  guardedMemory(dismissals, input).excluded
const patternsOf = (dismissals: readonly TeamDismissal[], input: GuardedTeamInput = INPUT) =>
  guardedMemory(dismissals, input).patterns
const writers = (pattern: TeamPattern = PATTERN) => [dismissal(1, { pattern }), dismissal(2, { pattern })]
// A batch of `count` resolves by one hash, `step` ms apart, starting at `start`.
const batch = (
  n: number,
  count: number,
  step: number,
  start = NOW - DAY,
  extra: Parameters<typeof dismissal>[1] = {},
) => Array.from({ length: count }, (_, i) => dismissal(n, { why: "resolved", at: start + i * step, ...extra }))

function concern(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "0123456789ab",
    path: "src/ui/button.tsx",
    line: 3,
    side: "RIGHT",
    source: "review",
    severity: "concern",
    category: "style",
    title: "Button color contrast",
    body: "The colour fails contrast on the dark theme.",
    confidence: 0.9,
    ...overrides,
  }
}

const finding = (status: "open" | "dismissed" = "dismissed", words = WORDS, category: Category = "style") =>
  findingMarker({ id: "0123456789ab", severity: "concern", category, sha: "a1b2c3d", status, words })
const mark = (by: string, why: string, h: string) => `<!-- vector-dismissal by=${by} why=${why} h=${h} -->`
const body = (...parts: string[]) => ["The colour fails contrast on the dark theme.", ...parts].join("\n")

describe("constants", () => {
  test("hold the addendum's values and marker tokens", () => {
    expect(TEAM_SIMILARITY).toBe(0.5)
    expect(TEAM_WRITERS).toBe(2)
    expect(TEAM_WINDOW_DAYS).toBe(90)
    expect([TEAM_MIN_WINDOW_DAYS, TEAM_MAX_WINDOW_DAYS]).toEqual([1, 365])
    expect(TEAM_CLOCK_SKEW_MS).toBe(300_000)
    expect(BULK_RESOLVE_THREADS).toBe(5)
    expect(BULK_RESOLVE_MS).toBe(60_000)
    expect(BOT_PUSH_MS).toBe(120_000)
    expect(DISMISSAL_BY).toEqual(["w", "a"])
    expect(DISMISSAL_WHY).toEqual(["fp", "wontfix", "thumbs", "resolved", "cmd"])
    expect(TEAM_EXCLUSIONS).toEqual([
      "unmarked",
      "author",
      "own",
      "undated",
      "outside-window",
      "bot-push",
      "bulk-resolve",
      "security",
    ])
  })

  test("TEAM_SIMILARITY matches select.ts's legacy threshold (the wiring imports this one)", () => {
    // Jaccard 2/4 = 0.5 and 2/5 = 0.4 against the finding's three title words.
    const at = { category: "style", dir: "src/ui", words: ["alpha", "beta", "delta"] } satisfies TeamPattern
    const below = { ...at, words: ["alpha", "beta", "delta", "epsilon"] } satisfies TeamPattern
    const title = "alpha beta gamma"
    expect(titleSimilarity(title, at.words)).toBe(0.5)
    expect(titleSimilarity(title, below.words)).toBe(0.4)
    expect(teamPenalty({ category: "style", title }, [at, at])).toBeGreaterThan(0)
    expect(teamPenalty({ category: "style", title }, [below, below])).toBe(0)
    const probe = { category: "style", dir: "src/ui", words: normalizeTitle(title) } satisfies TeamPattern
    expect(sameTeamPattern(probe, at)).toBe(true)
    expect(sameTeamPattern(probe, below)).toBe(false)
  })
})

describe("teamDir and sameTeamPattern", () => {
  test("teamDir is teamPatterns' directory", () => {
    expect(teamDir("src/ui/button.tsx")).toBe("src/ui")
    expect(teamDir("README.md")).toBe("")
    expect(teamDir("/abs.ts")).toBe("")
    const comments = ["src/ui/button.tsx", "README.md", "a/b/c/d.ts"].map((path) => ({ path, body: body(finding()) }))
    expect(teamPatterns(comments).map((pattern) => pattern.dir)).toEqual(
      comments.map((comment) => teamDir(comment.path)),
    )
  })

  test("needs the same category, the exact same directory and similar words", () => {
    expect(sameTeamPattern(PATTERN, PATTERN)).toBe(true)
    expect(sameTeamPattern(PATTERN, { ...PATTERN, category: "docs" })).toBe(false)
    expect(sameTeamPattern(PATTERN, { ...PATTERN, dir: "src" })).toBe(false)
    expect(sameTeamPattern(PATTERN, { ...PATTERN, dir: "src/ui/theme" })).toBe(false)
    expect(sameTeamPattern(PATTERN, { ...PATTERN, words: ["button", "color", "padding"] })).toBe(true) // 2/4
    expect(sameTeamPattern(PATTERN, { ...PATTERN, words: ["button", "padding", "margin"] })).toBe(false) // 1/5
    expect(sameTeamPattern(PATTERN, { ...PATTERN, words: [] })).toBe(false)
  })
})

describe("guardedMemory: who counts", () => {
  test("a pattern needs two distinct writer hashes, not two markers", () => {
    expect(patternsOf(writers())).toEqual([PATTERN])
    expect(patternsOf([dismissal(1), dismissal(1)])).toEqual([])
    expect(patternsOf([dismissal(1), dismissal(1), dismissal(1), dismissal(1, { pr: 2 })])).toEqual([])
    expect(patternsOf([dismissal(1)])).toEqual([])
    expect(excludedOf(writers())).toEqual([])
  })

  test("support is counted per category and exact directory, by similarity", () => {
    expect(patternsOf([dismissal(1), dismissal(2, { pattern: { ...PATTERN, dir: "src" } })])).toEqual([])
    expect(patternsOf([dismissal(1), dismissal(2, { pattern: { ...PATTERN, dir: "src/ui/theme" } })])).toEqual([])
    expect(patternsOf([dismissal(1), dismissal(2, { pattern: { ...PATTERN, category: "docs" } })])).toEqual([])
    // Two writers with similar (2/4) words support each other: each key is kept once, as teamPatterns keys them.
    const similar = { ...PATTERN, words: ["button", "color", "padding"] }
    expect(patternsOf([dismissal(1), dismissal(2, { pattern: similar })])).toEqual([PATTERN, similar])
    expect(patternsOf([dismissal(1), dismissal(2), dismissal(3)])).toEqual([PATTERN])
  })

  test("forged author dismissals never count, however many authors", () => {
    const authors = Array.from({ length: 12 }, (_, i) => dismissal(i + 1, { by: "a", pr: i + 1 }))
    expect(guardedMemory(authors, INPUT).patterns).toEqual([])
    expect(excludedOf(authors)).toEqual([{ reason: "author", count: 12 }])
    // One writer beside them is still one writer.
    expect(patternsOf([...authors, dismissal(99)])).toEqual([])
  })

  test("Vector's own actions never count", () => {
    const memory = guardedMemory([...writers(), dismissal(3)], { now: NOW, own: [hash(1), hash(2)] })
    expect(memory.patterns).toEqual([])
    expect(memory.excluded).toEqual([{ reason: "own", count: 2 }])
  })

  test("a marker built from JSON that the grammar does not allow reads as unmarked", () => {
    const forged: TeamDismissal[] = JSON.parse(
      JSON.stringify([
        { pattern: PATTERN, marker: { by: "x", why: "fp", hash: hash(1) }, pr: 1, at: NOW - DAY },
        { pattern: PATTERN, marker: { by: "w", why: "spam", hash: hash(2) }, pr: 1, at: NOW - DAY },
        { pattern: PATTERN, marker: { by: "w", why: "fp", hash: "ABCDEF012345" }, pr: 1, at: NOW - DAY },
        { pattern: PATTERN, marker: { by: "w", why: "fp", hash: 123456789012 }, pr: 1, at: NOW - DAY },
        { pattern: PATTERN, pr: 1, at: NOW - DAY },
      ]),
    )
    expect(guardedMemory(forged, INPUT).patterns).toEqual([])
    expect(excludedOf(forged)).toEqual([{ reason: "unmarked", count: 5 }])
  })

  test("a thumbs-down on a real security finding never becomes memory, even from writers", () => {
    const security = { category: "security", dir: "src/auth", words: ["token", "logged"] } satisfies TeamPattern
    const thumbs = [1, 2, 3].map((n) => dismissal(n, { why: "thumbs", pattern: security }))
    expect(guardedMemory(thumbs, INPUT).patterns).toEqual([])
    expect(excludedOf(thumbs)).toEqual([{ reason: "security", count: 3 }])
    // Legacy teamPatterns learns it from one dismissed marker.
    const legacy = teamPatterns([
      { path: "src/auth/session.ts", body: body(finding("dismissed", security.words, "security")) },
    ])
    expect(legacy).toEqual([security])
  })
})

describe("guardedMemory: the window", () => {
  test("starts 90 days back, inclusive, and allows only a bounded clock skew ahead", () => {
    expect(excludedOf([dismissal(1, { at: EDGE }), dismissal(2, { at: EDGE })])).toEqual([])
    expect(patternsOf([dismissal(1, { at: EDGE }), dismissal(2, { at: EDGE })])).toEqual([PATTERN])
    expect(excludedOf([dismissal(1, { at: EDGE - 1 })])).toEqual([{ reason: "outside-window", count: 1 }])
    expect(excludedOf([dismissal(1, { at: NOW + TEAM_CLOCK_SKEW_MS })])).toEqual([])
    expect(excludedOf([dismissal(1, { at: NOW + TEAM_CLOCK_SKEW_MS + 1 })])).toEqual([
      { reason: "outside-window", count: 1 },
    ])
    expect(excludedOf([dismissal(1, { at: NOW + 365 * DAY })])).toEqual([{ reason: "outside-window", count: 1 }])
  })

  test("is swept as a parameter within 1 to 365 days", () => {
    const old = [dismissal(1, { at: NOW - 31 * DAY }), dismissal(2, { at: NOW - 31 * DAY })]
    expect(patternsOf(old, { now: NOW, windowDays: 30 })).toEqual([])
    expect(patternsOf(old, { now: NOW, windowDays: 31 })).toEqual([PATTERN])
    expect(excludedOf([dismissal(1, { at: NOW - DAY })], { now: NOW, windowDays: 1 })).toEqual([])
    expect(excludedOf([dismissal(1, { at: NOW - 365 * DAY })], { now: NOW, windowDays: 365 })).toEqual([])
  })

  test("a window or a now that is not a usable number counts nothing", () => {
    const fresh = [dismissal(1, { at: NOW }), dismissal(2, { at: NOW - 1 })]
    for (const windowDays of [Number.NaN, Infinity, -Infinity, -1, 0, 0.5, 366])
      expect(guardedMemory(fresh, { now: NOW, windowDays })).toMatchObject({
        patterns: [],
        excluded: [{ reason: "outside-window", count: 2 }],
      })
    for (const now of [Number.NaN, Infinity, -Infinity])
      expect(guardedMemory(fresh, { now })).toMatchObject({
        patterns: [],
        excluded: [{ reason: "outside-window", count: 2 }],
      })
  })

  test("a dismissal with no usable time is undated", () => {
    const undated = [undefined, Number.NaN, Infinity, -Infinity].map((at) => ({ ...dismissal(1), at }))
    expect(excludedOf(undated)).toEqual([{ reason: "undated", count: 4 }])
  })
})

describe("guardedMemory: exclude-only signals", () => {
  test("an agent bulk resolve: five resolves by one actor within 60 s", () => {
    expect(excludedOf(batch(1, 5, 10_000))).toEqual([{ reason: "bulk-resolve", count: 5 }])
    expect(excludedOf(batch(1, 6, 12_000))).toEqual([{ reason: "bulk-resolve", count: 6 }])
    // The span is inclusive: 0 to 60 000 ms.
    expect(excludedOf(batch(1, 5, BULK_RESOLVE_MS / 4))).toEqual([{ reason: "bulk-resolve", count: 5 }])
    expect(excludedOf(batch(1, 4, 1_000))).toEqual([])
    const late = [...batch(1, 4, 15_000), dismissal(1, { why: "resolved", at: NOW - DAY + BULK_RESOLVE_MS + 1 })]
    expect(excludedOf(late)).toEqual([])
    // Five different actors are not a batch.
    expect(excludedOf([1, 2, 3, 4, 5].map((n) => dismissal(n, { why: "resolved", at: NOW - DAY + n })))).toEqual([])
    // A batch is a batch across pull requests, and a dismissal of another kind beside it still counts.
    const spread = [
      ...[1, 2, 3, 4, 5].map((pr) => dismissal(1, { why: "resolved", pr, at: NOW - DAY + pr })),
      dismissal(1),
    ]
    expect(excludedOf(spread)).toEqual([{ reason: "bulk-resolve", count: 5 }])
  })

  test("a reply from someone else or a code change takes a thread out of the batch; unknown reads as none", () => {
    const replied = [...batch(1, 4, 1_000), dismissal(1, { why: "resolved", at: NOW - DAY + 4_000, replied: true })]
    expect(excludedOf(replied)).toEqual([])
    const changed = [...batch(1, 4, 1_000), dismissal(1, { why: "resolved", at: NOW - DAY + 4_000, codeChanged: true })]
    expect(excludedOf(changed)).toEqual([])
    // batch() leaves both unset (unknown); an explicit "no" reads the same.
    expect(excludedOf(batch(1, 5, 1_000))).toEqual([{ reason: "bulk-resolve", count: 5 }])
    const no = batch(1, 5, 1_000, NOW - DAY, { replied: false, codeChanged: false })
    expect(excludedOf(no)).toEqual([{ reason: "bulk-resolve", count: 5 }])
  })

  test("only resolves are batched; five thumbs-downs within 60 s are not", () => {
    const thumbs = [0, 1, 2, 3, 4].map((i) => dismissal(1, { why: "thumbs", at: NOW - DAY + i * 1_000 }))
    expect(excludedOf(thumbs)).toEqual([])
    const commands = [0, 1, 2, 3, 4].map((i) => dismissal(1, { why: "cmd", at: NOW - DAY + i * 1_000 }))
    expect(excludedOf(commands)).toEqual([])
  })

  test("the scan sees every marked, dated resolve: a batch straddling the window edge or mixing roles", () => {
    const straddle = [-30_000, -15_000, 0, 15_000, 30_000].map((offset) =>
      dismissal(1, { why: "resolved", at: EDGE + offset }),
    )
    expect(excludedOf(straddle)).toEqual([
      { reason: "outside-window", count: 2 },
      { reason: "bulk-resolve", count: 3 },
    ])
    const roles = [0, 1, 2, 3, 4].map((i) =>
      dismissal(1, { why: "resolved", by: i < 3 ? "a" : "w", pr: i + 1, at: NOW - DAY + i * 1_000 }),
    )
    expect(excludedOf(roles)).toEqual([
      { reason: "author", count: 3 },
      { reason: "bulk-resolve", count: 2 },
    ])
  })

  test("a dismissal within 2 minutes of a bot push on the same pull request, before or after it", () => {
    const push = NOW - DAY
    const input = (at = push, pr = 1): GuardedTeamInput => ({ now: NOW, botPushes: [{ pr, at }] })
    expect(excludedOf([dismissal(1, { at: push + BOT_PUSH_MS })], input())).toEqual([{ reason: "bot-push", count: 1 }])
    expect(excludedOf([dismissal(1, { at: push - BOT_PUSH_MS })], input())).toEqual([{ reason: "bot-push", count: 1 }])
    expect(excludedOf([dismissal(1, { at: push })], input())).toEqual([{ reason: "bot-push", count: 1 }])
    expect(excludedOf([dismissal(1, { at: push + BOT_PUSH_MS + 1 })], input())).toEqual([])
    expect(excludedOf([dismissal(1, { at: push - BOT_PUSH_MS - 1 })], input())).toEqual([])
    expect(excludedOf([dismissal(1, { at: push })], input(push, 2))).toEqual([])
    // A push whose time is not a number excludes every dismissal on its pull request.
    expect(excludedOf([dismissal(1, { at: push }), dismissal(2, { pr: 2 })], input(Number.NaN))).toEqual([
      { reason: "bot-push", count: 1 },
    ])
  })
})

describe("guardedMemory: counts and output", () => {
  test("each dismissal is counted once, under the first reason in TEAM_EXCLUSIONS order", () => {
    const input: GuardedTeamInput = { now: NOW, own: [hash(3)], botPushes: [{ pr: 9, at: NOW - DAY }] }
    const security = { ...PATTERN, category: "security" } satisfies TeamPattern
    const list = [
      { ...dismissal(1), marker: undefined },
      { ...dismissal(2, { by: "a" }), at: undefined }, // author before undated
      { ...dismissal(3, { by: "w" }), at: undefined }, // own before undated
      { ...dismissal(4), at: undefined },
      dismissal(5, { at: EDGE - 1, pattern: security }), // outside-window before security
      dismissal(6, { pr: 9, pattern: security }), // bot-push before security
      ...batch(7, 5, 1_000, NOW - 2 * DAY, { pattern: security }), // bulk-resolve before security
      dismissal(8, { pattern: security }),
      dismissal(9),
    ]
    expect(excludedOf(list, input)).toEqual([
      { reason: "unmarked", count: 1 },
      { reason: "author", count: 1 },
      { reason: "own", count: 1 },
      { reason: "undated", count: 1 },
      { reason: "outside-window", count: 1 },
      { reason: "bot-push", count: 1 },
      { reason: "bulk-resolve", count: 5 },
      { reason: "security", count: 1 },
    ])
  })

  test("excluded counts every dismissal whatever max is, and support reaches past max", () => {
    const authors = Array.from({ length: 40 }, (_, i) => dismissal(i + 100, { by: "a" }))
    const other = { ...PATTERN, words: ["modal", "focus", "trap"] }
    const list = [
      dismissal(1),
      dismissal(1, { pattern: other }),
      ...authors,
      dismissal(2),
      dismissal(2, { pattern: other }),
    ]
    const memory = guardedMemory(list, { now: NOW, max: 1 })
    expect(memory.patterns).toEqual([PATTERN])
    expect(memory.excluded).toEqual([{ reason: "author", count: 40 }])
    expect(patternsOf(list)).toEqual([PATTERN, other])
    expect(patternsOf(list, { now: NOW, max: 0 })).toEqual([])
    expect(patternsOf(list, { now: NOW, max: Number.NaN })).toEqual([])
  })

  test("keeps at most 30 patterns by default, newest first", () => {
    const list = Array.from({ length: 35 }, (_, i) => {
      const pattern = { ...PATTERN, dir: `src/dir${i}` }
      return [dismissal(1, { pattern }), dismissal(2, { pattern })]
    }).flat()
    const patterns = patternsOf(list)
    expect(patterns).toHaveLength(30)
    expect(patterns[0]?.dir).toBe("src/dir0")
    expect(patterns.at(-1)?.dir).toBe("src/dir29")
  })

  test("is pure: a frozen input, fresh output", () => {
    const list = deepFreeze(writers({ ...PATTERN, words: [...WORDS] }))
    const input = deepFreeze({ now: NOW, own: [hash(9)], botPushes: [{ pr: 3, at: NOW }] })
    const first = guardedMemory(list, input)
    const second = guardedMemory(list, input)
    expect(first.patterns).toEqual([PATTERN])
    expect(first.patterns[0]).not.toBe(list[0]?.pattern)
    expect(first.patterns[0]?.words).not.toBe(list[0]?.pattern.words)
    expect(first.patterns).not.toBe(second.patterns)
    first.patterns[0]?.words.push("mutated")
    expect(list[0]?.pattern.words).toEqual(WORDS)
    expect(second.patterns).toEqual([PATTERN])
  })
})

describe("neverSuppress", () => {
  test("security, blocking, unreadable or unknown severity, and failures under strict", () => {
    expect(neverSuppress(concern(), OFF)).toBe(false)
    expect(neverSuppress(concern({ severity: "nit" }), OFF)).toBe(false)
    expect(neverSuppress(concern({ category: "security" }), OFF)).toBe(true)
    expect(neverSuppress(concern({ source: "security", category: "bug" }), OFF)).toBe(true)
    expect(neverSuppress(concern({ severity: "blocking" }), OFF)).toBe(true)
    expect(neverSuppress(concern({ severityUnreadable: true }), OFF)).toBe(true)
    expect(neverSuppress(concern({ severityUnreadable: false }), OFF)).toBe(false)
    for (const name of FAILURE_CLASSES) {
      const failure = { class: name, mechanism: "resource", trigger: "t", impact: "i" } as const
      expect(neverSuppress(concern({ failure }), STRICT)).toBe(true)
    }
    expect(neverSuppress(concern(), STRICT)).toBe(false)
  })

  test("a crash or data-corruption failure under any guardrail", () => {
    // The decoder keeps `failure` only under strict (schema.ts), so outside strict a failure is never present in a
    // review; these are hand-built. Whether the other classes outside strict are kept is left unasserted on purpose.
    for (const name of ["crash", "data-corruption"] as const) {
      const failure = { class: name, mechanism: "logic", trigger: "t", impact: "i" } as const
      expect(neverSuppress(concern({ failure }), OFF)).toBe(true)
      expect(neverSuppress(concern({ failure }), {})).toBe(true)
    }
  })

  test("a severity outside SEVERITIES (a hand-built or JSON-cast finding) or severityUnreadable counts as blocking", () => {
    const decoded: Finding[] = JSON.parse(
      JSON.stringify([
        concern({ severityUnreadable: true }),
        { ...concern(), severity: "critical" },
        { ...concern(), severity: "" },
        { ...concern(), severity: "Concern" },
      ]),
    )
    for (const entry of decoded) expect(neverSuppress(entry, OFF)).toBe(true)
  })

  test("crash and data-loss wording, in the title or the body", () => {
    const severe = [
      "Crashes when the list is empty",
      "crash on startup",
      "The worker crashed",
      "Panics on a nil map",
      "panicked while parsing",
      "Segfault in the decoder",
      "segmentation fault on resize",
      "Possible data loss on retry",
      "data-loss when the queue is full",
      "Loses unsaved data on reload",
      "lost update under concurrent saves",
      "Lost updates when two tabs save",
      "drops writes after a reconnect",
      "Drops the last rows of the export",
      "dropped records during migration",
      "losing the user's records",
      "Data is lost when the cache evicts",
      "data gets overwritten by the default",
      "data could be corrupted on a partial write",
      "Corrupts the index",
      "index corruption after a crashloop",
      "Truncates the file to the first chunk",
      "truncation of long values",
      "Overwrites the user's config",
      "the config is overwritten",
      "Unhandled promise rejection in the loader",
      "uncaught exception in the handler",
      "Null pointer dereference on logout",
      "nil dereference when the cache is cold",
      "dereferences a null session",
      "Out of memory on large inputs",
      "out-of-memory with many tabs",
      "OOM on the build agent",
      "Stack overflow on deep recursion",
      "Deletes user data on logout",
      "data is deleted when the cache evicts",
      "data was discarded after the timeout",
      "Discards unsaved changes",
      "deleting the user's records on sync",
      "Wipes the database on retry",
      "wiped rows after a failed import",
      "erases the user's settings",
      "Erasing pending updates on reconnect",
      "loses unsaved changes on reload",
    ]
    for (const text of severe) {
      expect(neverSuppress(concern({ title: text }), OFF)).toBe(true)
      expect(neverSuppress(concern({ body: text }), OFF)).toBe(true)
    }
  })

  test("near misses stay demotable", () => {
    const safe = [
      "Crashpad upload URL is hard-coded",
      "Panicle icon is misaligned",
      "Use lossless compression for icons",
      "Dropdown rows are misaligned",
      "CSS overflow hides the label",
      "Rename the zoom handler",
      "Input lost focus after submit",
      "Delete the unused import",
      "Deleted file is still imported",
      "Discard the return value explicitly",
      "Wipe the mock between tests",
      "Erase the debug border",
      "Delete this comment",
    ]
    for (const text of safe) expect(neverSuppress(concern({ title: text, body: text }), OFF)).toBe(false)
  })
})

describe("teamDemotion", () => {
  const memory = guardedMemory(writers(), INPUT)

  test("demotes a matching finding on one guarded pattern and names it", () => {
    expect(teamDemotion(concern(), memory, OFF)).toEqual(PATTERN)
    expect(teamDemotion(concern({ severity: "nit" }), memory, OFF)).toEqual(PATTERN)
    // Legacy teamPenalty needs two patterns for the same finding.
    expect(teamPenalty(concern(), memory.patterns)).toBe(0)
    expect(teamDemotion(concern({ path: "src/ui/theme/button.tsx" }), memory, OFF)).toBeUndefined()
    expect(teamDemotion(concern({ path: "button.tsx" }), memory, OFF)).toBeUndefined()
    expect(teamDemotion(concern({ category: "docs" }), memory, OFF)).toBeUndefined()
    expect(teamDemotion(concern({ title: "Modal focus trap" }), memory, OFF)).toBeUndefined()
    expect(teamDemotion(concern(), guardedMemory([], INPUT), OFF)).toBeUndefined()
  })

  test("an identical long title scores 0.75 against its 6 marker words and is demoted, as in teamPenalty", () => {
    const title = "alpha beta gamma delta epsilon zeta eta theta"
    const words = normalizeTitle(title)
    expect(words).toHaveLength(8)
    const marked = parseFindingMarker(finding("dismissed", words))?.words ?? []
    expect(marked).toHaveLength(6)
    expect(titleSimilarity(words, marked)).toBe(0.75)
    const pattern = { ...PATTERN, words: marked }
    expect(teamDemotion(concern({ title }), guardedMemory(writers(pattern), INPUT), OFF)).toEqual(pattern)
    expect(teamPenalty(concern({ title }), [pattern, pattern])).toBeGreaterThan(0)
  })

  test("never demotes what neverSuppress keeps (fixture (a): legacy suppresses it, guarded posts it)", () => {
    const blocking = concern({ severity: "blocking", title: "Button color contrast crashes renderer" })
    expect(teamPenalty(blocking, [PATTERN, PATTERN])).toBeGreaterThan(0)
    expect(teamDemotion(blocking, memory, OFF)).toBeUndefined()
    expect(teamDemotion(concern({ title: "Button color contrast crashes" }), memory, OFF)).toBeUndefined()
    expect(teamDemotion(concern({ source: "security" }), memory, OFF)).toBeUndefined()
    expect(teamDemotion(concern({ severityUnreadable: true }), memory, OFF)).toBeUndefined()
    const failure = { class: "leak", mechanism: "logic", trigger: "t", impact: "i" } as const
    expect(teamDemotion(concern({ failure }), memory, STRICT)).toBeUndefined()
    expect(teamDemotion(concern({ failure: { ...failure, class: "crash" } }), memory, OFF)).toBeUndefined()
  })

  test("takes only memory guardedMemory made: not legacy patterns, not a copy decoded from JSON", () => {
    const legacy = teamPatterns([{ path: "src/ui/button.tsx", body: body(finding()) }])
    expect(legacy).toEqual([PATTERN])
    // @ts-expect-error a legacy TeamPattern[] is not guarded memory
    expect(teamDemotion(concern(), legacy, OFF)).toBeUndefined()
    // @ts-expect-error neither is a look-alike object
    expect(teamDemotion(concern(), { patterns: [PATTERN], excluded: [] }, OFF)).toBeUndefined()
    const decoded: GuardedTeamMemory = JSON.parse(JSON.stringify(memory))
    expect(decoded.patterns).toEqual([PATTERN])
    expect(teamDemotion(concern(), decoded, OFF)).toBeUndefined()
  })
})

describe("parseDismissalMarker", () => {
  const h = hash(0xabc)

  test("reads the last well-formed marker after the comment's own finding marker", () => {
    expect(parseDismissalMarker(body(finding(), mark("w", "fp", h)))).toEqual({ by: "w", why: "fp", hash: h })
    for (const by of DISMISSAL_BY)
      for (const why of DISMISSAL_WHY)
        expect(parseDismissalMarker(body(finding(), mark(by, why, h)))).toEqual({ by, why, hash: h })
    expect(parseDismissalMarker(body(finding(), mark("w", "fp", hash(1)), mark("a", "thumbs", h)))).toEqual({
      by: "a",
      why: "thumbs",
      hash: h,
    })
    expect(parseDismissalMarker(`${finding()}${mark("w", "cmd", h)}`)?.why).toBe("cmd")
  })

  test("needs a finding marker before it", () => {
    expect(parseDismissalMarker(body(mark("w", "fp", h)))).toBeUndefined()
    expect(parseDismissalMarker(body(mark("w", "fp", h), finding()))).toBeUndefined()
    // A marker inside model text before an earlier finding marker does not count either: only the comment's own counts.
    expect(parseDismissalMarker(body(finding(), mark("w", "fp", h), finding("open")))).toBeUndefined()
    expect(parseDismissalMarker("")).toBeUndefined()
  })

  test("a malformed last marker reads as none, never as an earlier one", () => {
    const valid = mark("w", "fp", h)
    const malformed = [
      mark("x", "fp", h),
      mark("w", "spam", h),
      mark("W", "fp", h),
      mark("w", "fp", h.slice(1)), // 11 hex
      mark("w", "fp", "a".repeat(65)),
      mark("w", "fp", h.toUpperCase().replace(/^0/, "A")),
      mark("w", "fp", `${h.slice(0, 11)}g`),
      `<!-- vector-dismissal v1 by=w why=fp h=${h} -->`,
      `<!-- vector-dismissal by=w why=fp h=${h} at=1 -->`,
      `<!-- vector-dismissal by=w h=${h} -->`,
      `<!-- vector-dismissal why=fp by=w h=${h} -->`,
      `<!-- vector-dismissal  by=w why=fp h=${h} -->`,
      `<!-- vector-dismissal -->`,
      `<!-- vector-dismissal-v2 by=w why=fp h=${h} -->`,
      // Shapes a strict pattern alone would skip, so an earlier marker would be read: no space before `-->`, a `>`
      // inside, no space after `<!--`, another case, and no `-->` at all.
      `<!-- vector-dismissal by=w why=fp h=${h}-->`,
      `<!-- vector-dismissal by=w why=f>p h=${h} -->`,
      `<!-- vector-dismissal by=w why=fp h=${h} > -->`,
      `<!--vector-dismissal by=w why=fp h=${h} -->`,
      `<!-- Vector-Dismissal by=w why=fp h=${h} -->`,
      `<!-- vector-dismissal by=w why=fp h=${h}`,
    ]
    for (const bad of malformed) {
      expect(parseDismissalMarker(body(finding(), bad))).toBeUndefined()
      expect(parseDismissalMarker(body(finding(), valid, bad))).toBeUndefined()
    }
    expect(parseDismissalMarker(body(finding(), mark("w", "fp", "a".repeat(12))))?.hash).toBe("a".repeat(12))
    expect(parseDismissalMarker(body(finding(), mark("w", "fp", "f".repeat(64))))?.hash).toBe("f".repeat(64))
  })

  test("reads only the text after the finding marker, and a marker's first `-->` ends it", () => {
    // A long run of unterminated starts, before or after the finding marker, is no marker.
    const run = "<!-- vector-dismissal ".repeat(3_000)
    expect(parseDismissalMarker(body(run, finding(), mark("w", "fp", h)))).toEqual({ by: "w", why: "fp", hash: h })
    expect(parseDismissalMarker(body(finding(), mark("w", "fp", h), run))).toBeUndefined()
    // The last start counts, up to its own first `-->`.
    expect(parseDismissalMarker(body(finding(), `<!-- vector-dismissal ${mark("a", "cmd", h)}`))).toEqual({
      by: "a",
      why: "cmd",
      hash: h,
    })
    expect(parseDismissalMarker(body(finding(), `${mark("w", "cmd", h)} -->`))?.why).toBe("cmd")
  })

  test("an escaped marker is inert", () => {
    expect(parseDismissalMarker(body(finding(), escapeVectorMarkers(mark("w", "fp", h))))).toBeUndefined()
  })

  test("legacy readers ignore it, and setFindingStatus keeps it", () => {
    const plain = body(finding("open"))
    const marked = body(finding("open"), mark("w", "fp", h))
    expect(parseFindingMarker(marked)).toEqual(parseFindingMarker(plain))
    const dismissed = setFindingStatus(marked, "dismissed")
    expect(dismissed).toBe(body(finding("dismissed"), mark("w", "fp", h)))
    expect(parseFindingMarker(dismissed)?.status).toBe("dismissed")
    expect(parseDismissalMarker(dismissed)).toEqual({ by: "w", why: "fp", hash: h })
    expect(teamPatterns([{ path: "src/ui/button.tsx", body: dismissed }])).toEqual(
      teamPatterns([{ path: "src/ui/button.tsx", body: setFindingStatus(plain, "dismissed") }]),
    )
  })
})

describe("guardedTeamPatterns", () => {
  const comment = (
    n: number,
    overrides: Partial<GuardedComment> & { by?: string; why?: string } = {},
  ): GuardedComment => ({
    path: overrides.path ?? "src/ui/button.tsx",
    body: overrides.body ?? body(finding(), mark(overrides.by ?? "w", overrides.why ?? "fp", hash(n))),
    pr: overrides.pr ?? 1,
    at: overrides.at ?? NOW - DAY,
    ...(overrides.replied === undefined ? {} : { replied: overrides.replied }),
    ...(overrides.codeChanged === undefined ? {} : { codeChanged: overrides.codeChanged }),
  })

  test("learns a pattern from two writers' markers", () => {
    const memory = guardedTeamPatterns([comment(1), comment(2)], INPUT)
    expect(memory.patterns).toEqual([PATTERN])
    expect(memory.excluded).toEqual([])
    expect(teamDemotion(concern(), memory, OFF)).toEqual(PATTERN)
  })

  test("passes each comment's pull request, reply and code change through", () => {
    // A bot push on pull request 1 excludes only that pull request's dismissals.
    const pushed = guardedTeamPatterns([comment(1), comment(2), comment(3, { pr: 2 }), comment(4, { pr: 2 })], {
      ...INPUT,
      botPushes: [{ pr: 1, at: NOW - DAY + 1_000 }],
    })
    expect(pushed).toMatchObject({ patterns: [PATTERN], excluded: [{ reason: "bot-push", count: 2 }] })
    // Six resolves by one hash in 10 s are a batch; with one replied and one changed thread, the four left are not.
    const resolves = (flags: Partial<GuardedComment>[] = []) =>
      [0, 1, 2, 3, 4, 5].map((i) => comment(7, { why: "resolved", pr: i + 1, at: NOW - DAY + i * 2_000, ...flags[i] }))
    expect(guardedTeamPatterns([...resolves(), comment(8)], INPUT)).toMatchObject({
      patterns: [],
      excluded: [{ reason: "bulk-resolve", count: 6 }],
    })
    const mixed = guardedTeamPatterns([...resolves([{ replied: true }, { codeChanged: true }]), comment(8)], INPUT)
    expect(mixed).toMatchObject({ patterns: [PATTERN], excluded: [] })
  })

  test("is empty on today's comments, which carry no dismissal marker", () => {
    const today = Array.from({ length: 6 }, (_, i) => ({ path: "src/ui/button.tsx", body: body(finding()), pr: i + 1 }))
    expect(teamPatterns(today)).toEqual([PATTERN])
    expect(guardedTeamPatterns(today, INPUT)).toMatchObject({
      patterns: [],
      excluded: [{ reason: "unmarked", count: 6 }],
    })
  })

  test("skips what teamPatterns skips, silently", () => {
    const skipped = [
      { path: "src/a.ts", body: body(finding("open"), mark("w", "fp", hash(1))), pr: 1 },
      { path: "src/a.ts", body: body(finding("dismissed", []), mark("w", "fp", hash(1))), pr: 1 },
      { path: "src/a.ts", body: "no marker", pr: 1 },
    ]
    expect(guardedTeamPatterns(skipped, INPUT)).toMatchObject({ patterns: [], excluded: [] })
  })

  test("fixture (b): author-only and agent-bulk dismissals never enter team memory", () => {
    const authors = [1, 2, 3, 4, 5].map((n) => comment(n, { by: "a", pr: n }))
    expect(teamPatterns(authors)).toEqual([PATTERN])
    expect(guardedTeamPatterns(authors, INPUT)).toMatchObject({
      patterns: [],
      excluded: [{ reason: "author", count: 5 }],
    })
    const agent = [0, 1, 2, 3, 4].map((i) => comment(7, { why: "resolved", pr: i + 1, at: NOW - DAY + i * 2_000 }))
    expect(guardedTeamPatterns([...agent, comment(8)], INPUT)).toMatchObject({
      patterns: [],
      excluded: [{ reason: "bulk-resolve", count: 5 }],
    })
  })

  test("fixture (c): non-writer brigading never counts", () => {
    // Non-writers' thumbs-downs get no writer marker, so their dismissals are unmarked; a marker an attacker plants
    // before the finding marker, or that GitHub shows escaped, does not count either.
    const unmarked = Array.from({ length: 10 }, (_, i) => ({ path: "src/ui/button.tsx", body: body(finding()), pr: i }))
    const planted = Array.from({ length: 10 }, (_, i) => ({
      path: "src/ui/button.tsx",
      body: body(mark("w", "thumbs", hash(i + 1)), finding()),
      pr: i,
      at: NOW - DAY,
    }))
    const escaped = Array.from({ length: 10 }, (_, i) => ({
      path: "src/ui/button.tsx",
      body: body(finding(), escapeVectorMarkers(mark("w", "thumbs", hash(i + 20)))),
      pr: i,
      at: NOW - DAY,
    }))
    const brigade = [...unmarked, ...planted, ...escaped]
    expect(teamPatterns(brigade)).toEqual([PATTERN])
    expect(guardedTeamPatterns(brigade, INPUT)).toMatchObject({
      patterns: [],
      excluded: [{ reason: "unmarked", count: 30 }],
    })
  })
})
