import { describe, expect, test } from "bun:test"
import { anchorText, buildAnchorIndex, parseUnifiedDiff, resolveAnchor, type DiffFile } from "@vectordevai/core/review/diff"
import { fingerprint, normalizeCode, normalizeTitle } from "@vectordevai/core/review/fingerprint"
import { buildInlineBody } from "@vectordevai/core/review/format"
import {
  categoryGroup,
  computeRisk,
  gap,
  matchPrior,
  MAX_INLINE,
  NEAR,
  sameFinding,
  selectFindings,
  teamPenalty,
  type SelectInput,
} from "@vectordevai/core/review/select"
import { nextState, priorFromComment, priorFromState } from "@vectordevai/core/review/state"
import type { Finding, PriorFinding } from "@vectordevai/core/review/types"

const HEAD = "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4"

// Head lines: refresh.ts 50–57 (52–54 added; old line 52 deleted), client.ts 10–13 (11 added), db.ts 100–102
// (101 added).
const anchors = parseUnifiedDiff(
  [
    "diff --git a/src/auth/refresh.ts b/src/auth/refresh.ts",
    "index 1111111..2222222 100644",
    "--- a/src/auth/refresh.ts",
    "+++ b/src/auth/refresh.ts",
    "@@ -50,6 +50,8 @@ class Refresher {",
    "   async rotate() {",
    "     const next = await this.request()",
    "-    this.store.write(next)",
    "+    await this.store.write(next)",
    '+    this.emit("rotated")',
    "+    return next",
    "   }",
    "   // logout",
    "   logout() {",
    "diff --git a/src/auth/client.ts b/src/auth/client.ts",
    "index 3333333..4444444 100644",
    "--- a/src/auth/client.ts",
    "+++ b/src/auth/client.ts",
    "@@ -10,3 +10,4 @@",
    " export function logout(client) {",
    "+  client.cancelRotation()",
    "   client.clear()",
    " }",
    "diff --git a/src/db.ts b/src/db.ts",
    "index 5555555..6666666 100644",
    "--- a/src/db.ts",
    "+++ b/src/db.ts",
    "@@ -100,2 +100,3 @@",
    " export function find(id) {",
    '+  return db.query("SELECT * FROM t WHERE id = " + id)',
    " }",
    "",
  ].join("\n"),
)

// A new file with `lines` added lines, for the caps and the order.
function newFile(lines: number) {
  return parseUnifiedDiff(
    [
      "diff --git a/src/big.ts b/src/big.ts",
      "new file mode 100644",
      "index 0000000..7777777",
      "--- /dev/null",
      "+++ b/src/big.ts",
      `@@ -0,0 +1,${lines} @@`,
      ...Array.from({ length: lines }, (_, i) => `+line ${i + 1}`),
      "",
    ].join("\n"),
  )
}

// A new src/big.ts of `lines` added lines, where the given lines read as given, for repeated defects.
function bigFile(lines: number, text: Record<number, string>) {
  return parseUnifiedDiff(
    [
      "diff --git a/src/big.ts b/src/big.ts",
      "new file mode 100644",
      "index 0000000..7777777",
      "--- /dev/null",
      "+++ b/src/big.ts",
      `@@ -0,0 +1,${lines} @@`,
      ...Array.from({ length: lines }, (_, i) => `+${text[i + 1] ?? `line ${i + 1}`}`),
      "",
    ].join("\n"),
  )
}

const CONFIG: SelectInput["config"] = {
  minConfidence: 0.7,
  minSeverity: "concern",
  maxComments: 10,
  maxCommentsPerPr: 25,
  suggestions: true,
}

let next = 0
function finding(overrides: Partial<Finding> = {}): Finding {
  next++
  return {
    id: next.toString(16).padStart(12, "0"),
    path: "src/auth/refresh.ts",
    line: 52,
    side: "RIGHT",
    severity: "concern",
    category: "bug",
    title: `Finding ${next}`,
    body: "Explained.",
    confidence: 0.9,
    source: "review",
    ...overrides,
  }
}

// The id the engine and the desktop give a finding: its path, category, title words and anchored code, never its line.
function withId(files: DiffFile[], entry: Finding): Finding {
  const index = buildAnchorIndex(files)
  const resolved = resolveAnchor(index, entry)
  const code = resolved.ok ? anchorText(index, resolved.anchor) : ""
  return { ...entry, id: fingerprint(entry.path, entry.category, normalizeTitle(entry.title), normalizeCode(code)) }
}

function prior(overrides: Partial<PriorFinding> = {}): PriorFinding {
  return {
    id: "3f9a1c07be21",
    where: "inline",
    path: "src/auth/refresh.ts",
    line: 52,
    side: "RIGHT",
    severity: "concern",
    category: "bug",
    title: "Refresh can restore a session after logout",
    sha: "a1b2c3d",
    status: "open",
    commentId: 123,
    ...overrides,
  }
}

function run(overrides: Partial<SelectInput>) {
  return selectFindings({
    findings: [],
    anchors,
    head: HEAD,
    trust: "trusted",
    mode: "full",
    config: CONFIG,
    ...overrides,
  })
}

describe("selectFindings: filtering", () => {
  test("places findings on changed lines and counts the confidence drop", () => {
    const selection = run({
      findings: [finding({ line: 52 }), finding({ path: "src/auth/client.ts", line: 11, confidence: 0.5 })],
    })
    expect(selection.inline.map((f) => [f.path, f.anchor.line])).toEqual([["src/auth/refresh.ts", 52]])
    expect(selection.dropped).toEqual([{ reason: "low-confidence", count: 1 }])
  })

  test("drops empty findings, ignored paths and unknown paths; lists known files outside the diff", () => {
    const selection = run({
      findings: [
        finding({ title: "  " }),
        finding({ path: "dist/app.js", line: 1 }),
        finding({ path: "src/ghost.ts", line: 3 }),
        finding({ path: "src/api/session.ts", line: 88, title: "readSession() still expects the old shape" }),
      ],
      ignored: (path) => path.startsWith("dist/"),
      knownPath: (path) => path === "src/api/session.ts",
    })
    expect(selection.dropped).toEqual([
      { reason: "empty", count: 1 },
      { reason: "ignored-path", count: 1 },
      { reason: "unknown-path", count: 1 },
    ])
    expect(selection.outsideDiff.map((f) => [f.path, f.line, f.reason])).toEqual([
      ["src/api/session.ts", 88, "file-not-in-diff"],
    ])
  })

  test("a line outside every hunk is listed; one just outside a hunk snaps to its nearest added line", () => {
    const selection = run({ findings: [finding({ line: 10 }), finding({ path: "src/db.ts", line: 104 })] })
    expect(selection.outsideDiff.map((f) => [f.line, f.reason])).toEqual([[10, "line-outside-diff"]])
    expect(selection.inline.map((f) => [f.path, f.anchor.line])).toEqual([["src/db.ts", 101]])
  })

  test("a path written with a diff prefix is the diff's own path", () => {
    const selection = run({ findings: [finding({ path: "b/src/auth/client.ts", line: 11 })] })
    expect(selection.inline.map((f) => f.path)).toEqual(["src/auth/client.ts"])
  })

  test("dedupes within the run by id and by location, keeping the stronger finding", () => {
    const selection = run({
      findings: [
        finding({ line: 52, severity: "concern", confidence: 0.95, title: "Token write races logout" }),
        finding({ line: 54, severity: "blocking", confidence: 0.75, title: "Logout races the token write" }),
        finding({ id: "0000000000ff", path: "src/auth/client.ts", line: 11, confidence: 0.8 }),
        finding({ id: "0000000000ff", path: "src/db.ts", line: 101, confidence: 0.85 }),
        finding({ line: 52, category: "security", title: "Token written without checks" }),
      ],
    })
    expect(selection.inline.map((f) => [f.path, f.anchor.line, f.category])).toEqual([
      ["src/auth/refresh.ts", 54, "bug"],
      ["src/auth/refresh.ts", 52, "security"],
      ["src/db.ts", 101, "bug"],
    ])
    expect(selection.dropped).toEqual([{ reason: "duplicate", count: 2 }])
  })

  test("leaves nits and style findings out unless they are asked for", () => {
    const findings = () => [
      finding({ line: 52, severity: "nit", category: "docs", title: "logout has no doc comment" }),
      finding({ path: "src/auth/client.ts", line: 11, category: "style", title: "Prefer a named constant" }),
      finding({
        path: "src/db.ts",
        line: 101,
        severity: "blocking",
        category: "style",
        title: "Query style hides a bug",
      }),
    ]
    const quiet = run({ findings: findings() })
    expect(quiet.nits).toEqual([])
    expect(quiet.inline.map((f) => f.path)).toEqual(["src/db.ts"])
    expect(quiet.dropped).toEqual([{ reason: "nit", count: 2 }])
    const asked = run({ findings: findings(), config: { ...CONFIG, nits: true } })
    expect(asked.dropped).toEqual([])
    expect(asked.nits.map((f) => f.line)).toEqual([52])
    const lowest = run({ findings: findings(), config: { ...CONFIG, minSeverity: "nit" } })
    expect(lowest.dropped).toEqual([])
  })

  test("merges drops counted before selection", () => {
    const selection = run({
      findings: [finding({ confidence: 0.1 })],
      dropped: [{ reason: "rejected-by-verify", count: 2 }],
    })
    expect(selection.dropped).toEqual([
      { reason: "low-confidence", count: 1 },
      { reason: "rejected-by-verify", count: 2 },
    ])
  })
})

describe("matchPrior", () => {
  test("matches by location first: a reworded title three lines away is the same finding", () => {
    const earlier = prior()
    expect(matchPrior(finding({ line: 54, title: "Race between token rotation and logout" }), [earlier])).toBe(earlier)
    expect(matchPrior(finding({ line: 49, endLine: 50 }), [earlier])).toBe(earlier)
    expect(matchPrior(finding({ line: 56 }), [earlier])).toBeUndefined()
  })

  test("bug and reliability match each other; security and bug do not", () => {
    expect(matchPrior(finding({ category: "reliability" }), [prior()])).toBeDefined()
    expect(matchPrior(finding({ category: "security" }), [prior()])).toBeUndefined()
    expect(matchPrior(finding({ category: "security" }), [prior({ category: "security" })])).toBeDefined()
  })

  test("needs the same path and side", () => {
    expect(matchPrior(finding({ path: "src/auth/client.ts" }), [prior()])).toBeUndefined()
    expect(matchPrior(finding({ side: "LEFT" }), [prior()])).toBeUndefined()
  })

  test("duplicateOf matches wherever the finding is; an outdated thread needs it, the id or a similar title", () => {
    const outdated = prior({ line: null })
    expect(matchPrior(finding({ line: 200 }), [outdated])).toBeUndefined()
    expect(matchPrior(finding({ line: 200, duplicateOf: outdated.id }), [outdated])).toBe(outdated)
    expect(matchPrior(finding({ id: outdated.id, line: 200, title: "Reworded entirely" }), [outdated])).toBe(outdated)
    expect(matchPrior(finding({ line: 54, title: "Refresh can restore a session after logout" }), [outdated])).toBe(
      outdated,
    )
    expect(matchPrior(finding({ line: 54, title: "Retry delay is not capped" }), [outdated])).toBeUndefined()
    expect(matchPrior(finding({ line: 54, category: "security", title: outdated.title }), [outdated])).toBeUndefined()
  })

  test("titles break ties between candidates", () => {
    const first = prior({ id: "000000000001", line: 51, title: "Token stored before validation" })
    const second = prior({ id: "000000000002", line: 53, title: "Logout does not cancel rotation" })
    expect(matchPrior(finding({ line: 52, title: "Rotation is not cancelled on logout" }), [first, second])).toBe(
      second,
    )
    expect(matchPrior(finding({ line: 52, title: "Validation happens after storing token" }), [first, second])).toBe(
      first,
    )
  })

  test("categoryGroup", () => {
    expect(categoryGroup("security")).toBe("security")
    expect(categoryGroup("reliability")).toBe("other")
  })
})

describe("selectFindings: earlier findings", () => {
  test("an open earlier finding is still open and is not commented again", () => {
    const earlier = prior()
    const selection = run({
      findings: [finding({ line: 54, title: "Race between token rotation and logout" })],
      prior: [earlier],
    })
    expect(selection.inline).toEqual([])
    expect(selection.stillOpen).toEqual([earlier])
  })

  test("a blocking finding over an open concern is raised and takes over its id", () => {
    const earlier = prior()
    const selection = run({ findings: [finding({ line: 53, severity: "blocking" })], prior: [earlier] })
    expect(selection.inline.map((f) => [f.id, f.severity])).toEqual([[earlier.id, "blocking"]])
    expect(selection.raised).toEqual([{ id: earlier.id, was: "concern" }])
    expect(selection.stillOpen).toEqual([])
  })

  test("a dismissed earlier finding is never raised again", () => {
    const selection = run({ findings: [finding({ line: 52 })], prior: [prior({ status: "dismissed" })] })
    expect(selection.inline).toEqual([])
    expect(selection.dropped).toEqual([{ reason: "dismissed", count: 1 }])
    expect(selection.dismissed).toHaveLength(1)
  })

  test("a fixed earlier finding that comes back is posted again as reappeared", () => {
    const earlier = prior({ status: "fixed", fixedIn: "c3d4e5f" })
    const selection = run({ findings: [finding({ line: 52 })], prior: [earlier] })
    expect(selection.inline.map((f) => f.id)).toEqual([earlier.id])
    expect(selection.reappeared).toEqual([earlier.id])
    expect(selection.fixed).toEqual([])
  })

  test("an outdated earlier finding is treated as new", () => {
    const fresh = finding({ line: 52 })
    const selection = run({ findings: [fresh], prior: [prior({ status: "outdated" })] })
    expect(selection.inline.map((f) => f.id)).toEqual([fresh.id])
  })

  test("lists findings fixed at this head, and every dismissed finding", () => {
    const now = prior({ id: "000000000001", status: "fixed", fixedIn: "e5f6a7b" })
    const before = prior({
      id: "000000000002",
      status: "fixed",
      fixedIn: "c3d4e5f",
      line: 11,
      path: "src/auth/client.ts",
    })
    const dismissed = prior({ id: "000000000003", status: "dismissed", line: 101, path: "src/db.ts" })
    const selection = run({ prior: [now, before, dismissed] })
    expect(selection.fixed).toEqual([now])
    expect(selection.dismissed).toEqual([dismissed])
  })

  test("team memory lowers confidence for findings like two dismissed patterns", () => {
    const words = normalizeTitle("Write is not awaited")
    const patterns = [
      { category: "bug" as const, dir: "src", words },
      { category: "bug" as const, dir: "lib", words },
    ]
    expect(teamPenalty({ category: "bug", title: "Write is not awaited here" }, patterns)).toBe(0.15)
    expect(teamPenalty({ category: "bug", title: "Write is not awaited" }, patterns.slice(0, 1))).toBe(0)
    expect(teamPenalty({ category: "style", title: "Write is not awaited" }, patterns)).toBe(0)

    const low = run({
      findings: [finding({ title: "Write is not awaited", confidence: 0.8 })],
      teamDismissed: patterns,
    })
    expect(low.inline).toEqual([])
    expect(low.dropped).toEqual([{ reason: "low-confidence", count: 1 }])
    const high = run({
      findings: [finding({ title: "Write is not awaited", confidence: 0.9 })],
      teamDismissed: patterns,
    })
    expect(high.inline.map((f) => f.confidence)).toEqual([0.75])
  })
})

describe("selectFindings: placement", () => {
  test("caps comments per run and per pull request; the rest overflow", () => {
    const big = newFile(200)
    const many = Array.from({ length: 12 }, (_, i) =>
      finding({ path: "src/big.ts", line: 1 + i * 10, confidence: 0.95 - i * 0.01 }),
    )
    const selection = run({ anchors: big, findings: many })
    expect(selection.inline).toHaveLength(10)
    expect(selection.overflow.map((f) => f.line)).toEqual([101, 111])
    const late = run({ anchors: big, findings: many, inlinePosted: 20 })
    expect(late.inline).toHaveLength(5)
    expect(late.overflow).toHaveLength(7)
    expect(run({ anchors: big, findings: many, inlinePosted: 30 }).inline).toEqual([])
  })

  test("clamps maxComments to 50", () => {
    const big = newFile(300)
    const many = Array.from({ length: 60 }, (_, i) => finding({ path: "src/big.ts", line: 1 + i * 5 }))
    const selection = run({
      anchors: big,
      findings: many,
      config: { ...CONFIG, maxComments: 99, maxCommentsPerPr: 100 },
    })
    expect(selection.inline).toHaveLength(50)
    expect(selection.overflow).toHaveLength(10)
  })

  test("in incremental mode a finding outside the focus goes elsewhere unless it is blocking", () => {
    const selection = run({
      mode: "incremental",
      focus: [{ path: "src/auth/client.ts", start: 8, end: 16 }],
      findings: [
        finding({ line: 52, title: "Write is not awaited" }),
        finding({ line: 54, severity: "blocking", category: "security", title: "Session token leaks into logs" }),
        finding({ path: "src/auth/client.ts", line: 11 }),
      ],
    })
    expect(selection.elsewhere.map((f) => [f.path, f.line])).toEqual([["src/auth/refresh.ts", 52]])
    expect(selection.inline.map((f) => [f.path, f.anchor.line])).toEqual([
      ["src/auth/refresh.ts", 54],
      ["src/auth/client.ts", 11],
    ])
  })

  test("a removed line counts at its hunk's head range for the focus", () => {
    const removed = finding({ line: 52, side: "LEFT", title: "Removed write" })
    const inside = run({
      mode: "incremental",
      focus: [{ path: "src/auth/refresh.ts", start: 45, end: 47 }],
      findings: [removed],
    })
    expect(inside.inline.map((f) => [f.anchor.side, f.anchor.line])).toEqual([["LEFT", 52]])
    const outside = run({
      mode: "incremental",
      focus: [{ path: "src/auth/refresh.ts", start: 70, end: 80 }],
      findings: [removed],
    })
    expect(outside.elsewhere).toHaveLength(1)
  })

  test("nits never go inline, and severities below minSeverity are listed with them", () => {
    const nits = run({
      findings: [finding({ line: 52, severity: "nit" }), finding({ path: "src/auth/client.ts", line: 11 })],
      config: { ...CONFIG, minSeverity: "nit" },
    })
    expect(nits.nits.map((f) => f.line)).toEqual([52])
    expect(nits.inline.map((f) => f.path)).toEqual(["src/auth/client.ts"])
    const strict = run({ findings: [finding({ line: 52 })], config: { ...CONFIG, minSeverity: "blocking" } })
    expect(strict.nits).toHaveLength(1)
    expect(strict.inline).toEqual([])
  })

  test("orders by severity, then verified, then confidence, then path and line", () => {
    const selection = run({
      anchors: newFile(40),
      findings: [
        finding({ path: "src/big.ts", line: 31, confidence: 0.8 }),
        finding({ path: "src/big.ts", line: 1, confidence: 0.95 }),
        finding({ path: "src/big.ts", line: 11, confidence: 0.8, verified: true }),
        finding({ path: "src/big.ts", line: 21, confidence: 0.7, severity: "blocking" }),
        finding({ path: "src/big.ts", line: 26, confidence: 0.8 }),
      ],
    })
    expect(selection.inline.map((f) => f.line)).toEqual([21, 11, 1, 26, 31])
  })

  test("suggestions are committable only when every rule allows it", () => {
    const fix = '    if (this.state !== "signed-in") return\n    await this.store.write(next)'
    const allowed = (overrides: Partial<SelectInput>, extra: Partial<Finding> = {}) =>
      run({ findings: [finding({ line: 52, suggestion: fix, ...extra })], ...overrides }).inline[0]?.suggestionAllowed
    expect(allowed({})).toBe(true)
    expect(allowed({ trust: "untrusted" })).toBe(false)
    expect(allowed({ trust: "untrusted" }, { verified: true })).toBe(true)
    expect(allowed({ config: { ...CONFIG, suggestions: false } })).toBe(false)
    expect(allowed({}, { suggestion: "    await this.store.write(next)" })).toBe(false)
    expect(allowed({}, { suggestion: undefined })).toBe(false)
  })
})

describe("selectFindings: duplicates, continuations and caps", () => {
  test("the security reviewer's copy of a bug on the same line is one finding, with the code reviewer's category", () => {
    const selection = run({
      findings: [
        finding({ path: "src/db.ts", line: 101, title: "Query built from the raw id" }),
        finding({
          path: "src/db.ts",
          line: 101,
          severity: "blocking",
          category: "security",
          source: "security",
          title: "SQL injection through id",
        }),
      ],
    })
    expect(selection.inline.map((f) => [f.severity, f.category, f.source])).toEqual([["blocking", "bug", "security"]])
    expect(selection.dropped).toEqual([{ reason: "duplicate", count: 1 }])
  })

  test("two findings with the same fix are one; a missing test three lines from a bug is its own finding", () => {
    const fix = "    await this.store.write(next)"
    const same = run({
      findings: [
        finding({ line: 52, title: "Write is not awaited", suggestion: fix }),
        finding({ line: 53, title: "Emit before the store settles", suggestion: fix }),
      ],
    })
    expect(same.inline).toHaveLength(1)
    const apart = run({
      findings: [
        finding({ line: 52, endLine: 53, severity: "blocking", title: "displayName drops await and the fallback" }),
        finding({ line: 56, category: "tests", title: "No tests for the new behavior; the existing test fails" }),
        finding({ line: 55, category: "reliability", title: "fetch has no timeout" }),
      ],
    })
    expect(apart.inline.map((f) => f.category).sort()).toEqual(["bug", "reliability", "tests"])
    expect(apart.dropped).toEqual([])
  })

  test("the same defect further down a file is one finding that names the other lines", () => {
    const write = "  store.write(next)"
    const selection = run({
      anchors: bigFile(120, { 12: write, 40: write, 60: write, 70: write, 90: write }),
      findings: [
        finding({ path: "src/big.ts", line: 90, title: "Write to the store is not awaited", confidence: 0.8 }),
        finding({ path: "src/big.ts", line: 12, title: "Store write is not awaited", confidence: 0.95 }),
        finding({ path: "src/big.ts", line: 40, title: "The store write is not awaited here" }),
        finding({ path: "src/big.ts", line: 60, category: "tests", title: "Store write is not awaited in tests" }),
        finding({ path: "src/big.ts", line: 70, severity: "blocking", title: "Store write is not awaited" }),
      ],
    })
    expect(selection.inline.map((f) => [f.line, f.severity, f.category])).toEqual([
      [70, "blocking", "bug"],
      [12, "concern", "bug"],
      [60, "concern", "tests"],
    ])
    const folded = selection.inline.find((f) => f.line === 12)!
    expect(folded.also).toEqual(["src/big.ts:40", "src/big.ts:90"])
    expect(folded.body).toBe("Explained.\n\nThe same problem is also at lines 40 and 90.")
    expect(selection.dropped).toEqual([{ reason: "duplicate", count: 2 }])
  })

  test("different defects with alike titles stay apart, each with its own text", () => {
    const selection = run({
      anchors: bigFile(160, { 10: "  return user.name", 150: "  return session.id", 20: "  db.query(id)", 120: "  db.query(name)" }),
      findings: [
        finding({ path: "src/big.ts", line: 10, title: "Missing null check on user", body: "user can be null." }),
        finding({ path: "src/big.ts", line: 150, title: "Missing null check on session", body: "session can be null." }),
        finding({ path: "src/big.ts", line: 20, title: "Unvalidated id passed to SQL query", body: "id is raw." }),
        finding({ path: "src/big.ts", line: 120, title: "Unvalidated name passed to SQL query", body: "name is raw." }),
      ],
    })
    expect(selection.inline.map((f) => [f.line, f.body, f.also])).toEqual([
      [10, "user can be null.", undefined],
      [20, "id is raw.", undefined],
      [120, "name is raw.", undefined],
      [150, "session can be null.", undefined],
    ])
    expect(selection.dropped).toEqual([])
  })

  test("a dismissed place does not hide a new place of the same defect", () => {
    const write = "  store.write(next)"
    const selection = run({
      anchors: bigFile(160, { 10: write, 150: write }),
      prior: [
        prior({
          id: "aaaaaaaaaaaa",
          path: "src/big.ts",
          line: 10,
          title: "Store write is not awaited",
          status: "dismissed",
        }),
      ],
      findings: [
        finding({ path: "src/big.ts", line: 10, title: "Store write is not awaited", confidence: 0.95 }),
        finding({ path: "src/big.ts", line: 150, title: "The store write is not awaited here", confidence: 0.8 }),
      ],
    })
    expect(selection.inline.map((f) => [f.line, f.also])).toEqual([[150, undefined]])
    expect(selection.dropped).toEqual([{ reason: "dismissed", count: 1 }])
  })

  test("folding into a finding that already names other places lists each place once", () => {
    const write = "  store.write(next)"
    const carried = finding({
      path: "src/big.ts",
      line: 12,
      title: "Store write is not awaited",
      body: "Explained.\n\nThe same problem is also at line 90.",
      also: ["src/big.ts:90"],
      confidence: 0.95,
    })
    const selection = run({
      anchors: bigFile(120, { 12: write, 40: write, 90: write }),
      findings: [
        carried,
        finding({ path: "src/big.ts", line: 90, title: "Store write is not awaited here" }),
        finding({ path: "src/big.ts", line: 40, title: "The store write is not awaited" }),
      ],
    })
    expect(selection.inline.map((f) => [f.line, f.also, f.body])).toEqual([
      [12, ["src/big.ts:40", "src/big.ts:90"], "Explained.\n\nThe same problem is also at lines 40 and 90."],
    ])
  })

  test("the same defect reported with the same words far apart is one finding that names the other places", () => {
    const write = "  store.write(next)"
    const files = bigFile(120, { 12: write, 40: write, 90: write })
    const found = [12, 40, 90].map((line) =>
      withId(files, finding({ path: "src/big.ts", line, title: "Store write is not awaited", confidence: line === 12 ? 0.95 : 0.8 })),
    )
    expect(new Set(found.map((f) => f.id)).size).toBe(1)
    const selection = run({ anchors: files, findings: found })
    expect(selection.inline.map((f) => [f.line, f.also, f.body])).toEqual([
      [12, ["src/big.ts:40", "src/big.ts:90"], "Explained.\n\nThe same problem is also at lines 40 and 90."],
    ])
    expect(selection.dropped).toEqual([{ reason: "duplicate", count: 2 }])
    // Three lines apart is the same place, so it is dropped without being named.
    const near = run({
      anchors: files,
      findings: [found[0]!, withId(files, finding({ path: "src/big.ts", line: 14, title: "Store write is not awaited" }))],
    })
    expect(near.inline.map((f) => [f.line, f.also])).toEqual([[12, undefined]])
  })

  test("a stronger copy of a finding that names other places keeps naming them", () => {
    const write = "  store.write(next)"
    const files = bigFile(120, { 12: write, 90: write })
    const carried = withId(
      files,
      finding({
        path: "src/big.ts",
        line: 12,
        title: "Store write is not awaited",
        body: "Explained.\n\nThe same problem is also at line 90.",
        also: ["src/big.ts:90"],
        confidence: 0.8,
      }),
    )
    const stronger = { ...carried, body: "Checked again.", also: undefined, confidence: 0.95, verified: true }
    const selection = run({ anchors: files, findings: [carried, stronger] })
    expect(selection.inline.map((f) => [f.line, f.confidence, f.also, f.body])).toEqual([
      [12, 0.95, ["src/big.ts:90"], "Checked again.\n\nThe same problem is also at line 90."],
    ])
  })

  test("a re-review does not post again a place the open comment already names", () => {
    const write = "  store.write(next)"
    const files = bigFile(120, { 12: write, 90: write })
    const found = () => [
      withId(files, finding({ path: "src/big.ts", line: 12, title: "Store write is not awaited", confidence: 0.95 })),
      withId(files, finding({ path: "src/big.ts", line: 90, title: "Store write never awaited", confidence: 0.8 })),
    ]
    const first = run({ anchors: files, findings: found() })
    expect(first.inline.map((f) => [f.line, f.also])).toEqual([[12, ["src/big.ts:90"]]])

    // On GitHub: the comment Vector posted for it, read back on the next review.
    const posted = first.inline[0]!
    const comment = priorFromComment({
      id: 1,
      body: buildInlineBody(posted, { head: HEAD, trust: "trusted" }),
      path: posted.path,
      line: posted.line,
      side: "RIGHT",
    })!
    expect(comment.also).toEqual([90])
    const second = run({ anchors: files, findings: found(), prior: [comment] })
    expect(second.inline).toEqual([])
    expect(second.stillOpen.map((entry) => entry.id)).toEqual([posted.id])

    // Locally: the listed finding is saved in the state, and its places follow the code.
    const saved = nextState(undefined, { head: HEAD, base: HEAD, mode: "full", now: 0, selection: first, moved: first.inline })
    const shifted = parseUnifiedDiff(
      [
        "diff --git a/src/big.ts b/src/big.ts",
        "index 7777777..8888888 100644",
        "--- a/src/big.ts",
        "+++ b/src/big.ts",
        "@@ -0,0 +1,2 @@",
        "+// one",
        "+// two",
        "",
      ].join("\n"),
    )
    const [listed] = priorFromState(saved, shifted)
    expect([listed?.line, listed?.also]).toEqual([14, [92]])
    const moved = bigFile(122, { 14: write, 92: write })
    const again = run({
      anchors: moved,
      findings: [
        withId(moved, finding({ path: "src/big.ts", line: 14, title: "Store write is not awaited", confidence: 0.95 })),
        withId(moved, finding({ path: "src/big.ts", line: 92, title: "Store write never awaited", confidence: 0.8 })),
      ],
      prior: [listed!],
    })
    expect([again.inline, again.overflow, again.nits]).toEqual([[], [], []])
    expect(again.stillOpen.map((entry) => entry.id)).toEqual([posted.id])
  })

  test("a place an open comment names is posted again when it is raised to blocking, or the comment was dismissed", () => {
    const write = "  store.write(next)"
    const files = bigFile(120, { 12: write, 90: write })
    const named = prior({ id: "bbbbbbbbbbbb", path: "src/big.ts", line: 12, title: "Store write is not awaited", also: [90] })
    const at90 = (overrides: Partial<Finding>) =>
      withId(files, finding({ path: "src/big.ts", line: 90, title: "Store write never awaited", ...overrides }))
    expect(run({ anchors: files, findings: [at90({})], prior: [named] }).inline).toEqual([])
    expect(
      run({ anchors: files, findings: [at90({ severity: "blocking" })], prior: [named] }).inline.map((f) => f.line),
    ).toEqual([90])
    expect(
      run({ anchors: files, findings: [at90({})], prior: [{ ...named, status: "dismissed" }] }).inline.map((f) => f.line),
    ).toEqual([90])
    // A different defect near a named place is its own finding.
    expect(
      run({ anchors: files, findings: [at90({ title: "Unbounded retry loop" })], prior: [named] }).inline.map((f) => f.line),
    ).toEqual([90])
  })

  test("an earlier finding on an outdated thread is still open when reported again, and stays dismissed", () => {
    const outdated = prior({ line: null })
    const open = run({ findings: [finding({ id: outdated.id, line: 52 })], prior: [outdated] })
    expect(open.inline).toEqual([])
    expect(open.stillOpen).toEqual([outdated])
    const dismissed = run({
      findings: [finding({ line: 52, title: outdated.title })],
      prior: [prior({ line: null, status: "dismissed" })],
    })
    expect(dismissed.inline).toEqual([])
    expect(dismissed.dropped).toEqual([{ reason: "dismissed", count: 1 }])
  })

  test("a finding raised to blocking but only listed keeps its own id and leaves the earlier one open", () => {
    const earlier = prior()
    const raised = finding({ line: 53, severity: "blocking", title: "Session restored after logout" })
    const selection = run({ findings: [raised], prior: [earlier], config: { ...CONFIG, maxComments: 0 } })
    expect(selection.inline).toEqual([])
    expect(selection.overflow.map((f) => f.id)).toEqual([raised.id])
    expect(selection.raised).toEqual([])
    expect(selection.stillOpen).toEqual([earlier])
    const returned = run({
      findings: [finding({ line: 52 })],
      prior: [prior({ status: "fixed", fixedIn: "c3d4e5f" })],
      config: { ...CONFIG, maxComments: 0 },
    })
    expect(returned.reappeared).toEqual([])
    expect(returned.overflow[0]?.id).not.toBe(earlier.id)
  })

  test("the finding about instructions aimed at AI reviewers is posted whatever the caps", () => {
    const big = newFile(200)
    const many = Array.from({ length: 5 }, (_, i) =>
      finding({ path: "src/big.ts", line: 1 + i * 10, severity: "blocking" }),
    )
    const warning = finding({
      path: "src/big.ts",
      line: 100,
      category: "security",
      title: "Instructions aimed at AI reviewers",
    })
    const selection = run({ anchors: big, findings: [...many, warning], config: { ...CONFIG, maxComments: 5 } })
    expect(selection.inline).toHaveLength(6)
    expect(selection.inline.some((f) => f.title === warning.title)).toBe(true)
    expect(selection.overflow).toEqual([])
    expect(run({ anchors: big, findings: [warning], config: { ...CONFIG, maxComments: 0 } }).inline).toEqual([])
  })

  test("a fix is committable only on its own lines, not after a snap", () => {
    const fix = '  return db.query("SELECT * FROM t WHERE id = ?", [id])'
    const snapped = run({ findings: [finding({ path: "src/db.ts", line: 103, suggestion: fix })] })
    expect(snapped.inline.map((f) => [f.anchor.line, f.suggestionAllowed])).toEqual([[101, false]])
    const exact = run({ findings: [finding({ path: "src/db.ts", line: 101, suggestion: fix })] })
    expect(exact.inline.map((f) => f.suggestionAllowed)).toEqual([true])
  })
})

describe("risk", () => {
  test("computeRisk", () => {
    const f = (severity: Finding["severity"], category: Finding["category"] = "bug") => ({ severity, category })
    expect(computeRisk({ findings: [f("blocking")] })).toBe("high")
    expect(computeRisk({ findings: [f("concern", "security")] })).toBe("high")
    expect(computeRisk({ findings: [f("nit", "security")] })).toBe("low")
    expect(computeRisk({ findings: [f("concern")] })).toBe("medium")
    expect(computeRisk({ findings: [f("nit")], sensitiveChanged: true })).toBe("medium")
    expect(computeRisk({ findings: [], sensitiveChanged: true })).toBe("low")
    expect(computeRisk({ findings: [], changedLines: 801 })).toBe("medium")
    expect(computeRisk({ findings: [], modelRisk: "high" })).toBe("medium")
    expect(computeRisk({ findings: [f("nit")], modelRisk: "low" })).toBe("low")
  })

  test("the selection's risk counts every current finding and the still-open ones", () => {
    expect(run({ findings: [finding({ severity: "blocking" })] }).risk).toBe("high")
    expect(
      run({ findings: [finding({ severity: "nit" })], sensitiveChanged: true, config: { ...CONFIG, nits: true } }).risk,
    ).toBe("medium")
    expect(run({ prior: [prior({ severity: "blocking" })] }).risk).toBe("high")
    expect(run({}).risk).toBe("low")
  })
})

// VS-27b exports these for the strict guardrail's S7 and S8 (guardrail.ts), unchanged.
describe("what selection shares with the strict guardrail", () => {
  test("sameFinding: same path and side, within NEAR lines, with alike titles, the same fix or two reviewers' code", () => {
    expect(NEAR).toBe(3)
    expect(MAX_INLINE).toBe(50)
    const none = () => ""
    const a = finding({ line: 52, title: "Refresh restores a session after logout" })
    expect(sameFinding(a, finding({ line: 55, title: "Refresh restores the session after logout" }), none)).toBe(true)
    expect(sameFinding(a, finding({ line: 56, title: "Refresh restores the session after logout" }), none)).toBe(false)
    expect(sameFinding(a, finding({ line: 52, side: "LEFT", title: a.title }), none)).toBe(false)
    expect(sameFinding(a, finding({ path: "src/db.ts", title: a.title }), none)).toBe(false)
    const fix = { suggestion: "    await this.store.write(next)" }
    const settles = finding({ line: 53, title: "Emit before the store settles", ...fix })
    expect(sameFinding({ ...a, ...fix }, settles, none)).toBe(true)
    const code = () => "await this.store.write(next)"
    const other = finding({ line: 52, title: "Emit before the store settles", source: "security" })
    expect(sameFinding(a, other, code)).toBe(true)
    expect(sameFinding(a, { ...other, source: "review" }, code)).toBe(false)
    expect(sameFinding(a, other, none)).toBe(false)
  })

  test("gap: 0 for overlapping ranges, otherwise the lines between them", () => {
    expect(gap(10, 12, 12, 20)).toBe(0)
    expect(gap(10, 12, 15, 15)).toBe(3)
    expect(gap(15, 15, 10, 12)).toBe(3)
  })
})
