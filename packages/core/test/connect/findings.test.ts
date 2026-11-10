import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Connect } from "@vectordevai/schema/connect"
import { ConnectFindings } from "../../src/connect/findings"
import type { Finding, PlacedFinding, PriorFinding, ReviewOutcome, Selection } from "../../src/review/types"

const decodeFinding = Schema.decodeUnknownSync(Connect.Finding)
const decodeResult = Schema.decodeUnknownSync(Connect.Result)

const core = (id: string, overrides: Partial<Finding> = {}): Finding => ({
  id,
  path: `src/${id}.ts`,
  line: 10,
  side: "RIGHT",
  severity: "concern",
  category: "bug",
  title: `Problem ${id}`,
  body: `Body of ${id}.`,
  confidence: 0.9,
  source: "review",
  ...overrides,
})

const placed = (id: string, overrides: Partial<PlacedFinding> = {}): PlacedFinding => ({
  ...core(id),
  anchor: { path: `src/${id}.ts`, side: "RIGHT", line: 10, hunk: 0 },
  suggestionAllowed: false,
  ...overrides,
})

const prior = (id: string, overrides: Partial<PriorFinding> = {}): PriorFinding => ({
  id,
  where: "summary",
  path: `src/${id}.ts`,
  line: 4,
  side: "RIGHT",
  severity: "concern",
  category: "reliability",
  title: `Earlier ${id}`,
  sha: "abc1234def",
  status: "open",
  ...overrides,
})

// Twelve findings across every bucket, each bucket already in VectorScope's own order.
const selection: Pick<Selection, "inline" | "overflow" | "outsideDiff" | "elsewhere" | "nits" | "stillOpen"> = {
  inline: [
    placed("i1", { severity: "blocking", verified: true, suggestion: "fixed()", suggestionAllowed: true }),
    placed("i2", { suggestion: "not allowed()", suggestionAllowed: false }),
    placed("i3", { source: "security", category: "security" }),
  ],
  overflow: [core("o1"), core("o2", { side: "LEFT" })],
  outsideDiff: [
    { ...core("x1", { path: "lib/elsewhere.ts" }), reason: "file-not-in-diff" },
    { ...core("x2"), reason: "line-outside-diff" },
  ],
  elsewhere: [core("e1"), core("e2")],
  nits: [core("n1", { severity: "nit", category: "style" }), core("n2", { severity: "nit" })],
  stillOpen: [prior("s1", { line: null })],
}

const outcome = (
  overrides: Partial<ReviewOutcome> = {},
): ConnectFindings.OutcomeFacts & Pick<ReviewOutcome, "notes"> => ({
  partial: undefined,
  specialists: [
    { name: "review", status: "ok", steps: 4 },
    { name: "security", status: "skipped", steps: 0 },
  ],
  unreviewed: [],
  skipped: [],
  notes: [],
  ...overrides,
})

describe("mapping VectorScope's selection", () => {
  test("12 findings across buckets map in VectorScope's order", () => {
    const findings = ConnectFindings.fromSelection(selection)
    expect(findings.map((finding) => finding.id)).toEqual([
      "i1",
      "i2",
      "i3",
      "o1",
      "o2",
      "x1",
      "x2",
      "e1",
      "e2",
      "n1",
      "n2",
      "s1",
    ])
    expect(findings.map((finding) => finding.bucket)).toEqual([
      "inline",
      "inline",
      "inline",
      "overflow",
      "overflow",
      "outside-diff",
      "outside-diff",
      "elsewhere",
      "elsewhere",
      "nit",
      "nit",
      "still-open",
    ])
    for (const finding of findings) decodeFinding(finding)
    expect(findings[0]).toMatchObject({ severity: "blocking", verified: true, suggestion: "fixed()", status: "open" })
    expect(findings[1].suggestion).toBeUndefined()
    expect(findings[2].source).toBe("security")
    expect(findings[4].side).toBe("LEFT")
    expect(findings[5].path).toBe("lib/elsewhere.ts")
    // State keeps no body, and an outdated thread has no line.
    expect(findings[11]).toMatchObject({ body: "", status: "still-open", source: "review" })
    expect("line" in findings[11]).toBe(false)
  })

  test("text is cut to the schema's limits, a long suggestion is left out, and a bad line is dropped", () => {
    const long = placed("big", {
      title: `  A title\nwith   breaks ${"t".repeat(400)}`,
      body: "b".repeat(5_000),
      suggestion: "s".repeat(4_001),
      suggestionAllowed: true,
      line: 0,
      id: "id\u0000with-control",
    })
    const [finding] = ConnectFindings.fromSelection({ ...empty(), inline: [long] })
    decodeFinding(finding)
    expect(finding.title.length).toBe(300)
    expect(finding.title.startsWith("A title with breaks")).toBe(true)
    expect(finding.body.length).toBe(Connect.MAX_BODY)
    expect(finding.suggestion).toBeUndefined()
    expect("line" in finding).toBe(false)
    expect(finding.id).toBe("id_with-control")
  })

  test("the cut at 200 comes after the verdict has counted every finding", () => {
    const many = Array.from({ length: 205 }, (_, index) => core(`f${index}`, { severity: "nit" }))
    many.push(core("last", { severity: "blocking" }))
    const findings = ConnectFindings.fromSelection({ ...empty(), nits: many })
    expect(ConnectFindings.verdict({ outcome: outcome(), findings })).toBe("blocking")
    const finished = ConnectFindings.finish(findings)
    expect(finished.findings.length).toBe(Connect.MAX_FINDINGS)
    expect(finished.notes).toEqual(["Showing the first 200 of 206 findings."])
    expect(ConnectFindings.finish(findings.slice(0, 3)).notes).toEqual([])
  })
})

describe("the verdict", () => {
  const findings = ConnectFindings.fromSelection(selection)
  const nitsOnly = ConnectFindings.fromSelection({ ...empty(), nits: [core("n", { severity: "nit" })] })

  test("a partial outcome is never clean", () => {
    for (const partial of ["budget", "steps", "timeout", "model-error"] as const)
      expect(ConnectFindings.verdict({ outcome: outcome({ partial }), findings: [] })).toBe("incomplete")
    for (const status of ["failed", "timeout", "stopped"] as const)
      expect(
        ConnectFindings.verdict({
          outcome: outcome({ specialists: [{ name: "security", status, steps: 1 }] }),
          findings: nitsOnly,
        }),
      ).toBe("incomplete")
    expect(ConnectFindings.verdict({ outcome: outcome({ unreviewed: ["src/big.ts"] }), findings: [] })).toBe(
      "incomplete",
    )
    expect(
      ConnectFindings.verdict({
        outcome: outcome({ skipped: [{ path: "huge.ts", reason: "size-limit" }] }),
        findings: [],
      }),
    ).toBe("incomplete")
    expect(ConnectFindings.verdict({ settingsEdited: true, outcome: outcome(), findings: [] })).toBe("incomplete")
    expect(ConnectFindings.verdict({ settingsEdited: true, findings: [] })).toBe("incomplete")
  })

  test("other skips are notes, not a reason to call the review incomplete", () => {
    const skipped = [
      { path: "bun.lock", reason: "lockfile" as const },
      { path: "gen/a.ts", reason: "generated" as const },
      { path: "gen/b.ts", reason: "generated" as const },
      { path: "gen/c.ts", reason: "generated" as const },
    ]
    expect(ConnectFindings.verdict({ outcome: outcome({ skipped }), findings: nitsOnly })).toBe("clean")
    expect(ConnectFindings.skipNotes(skipped)).toEqual(["1 file skipped: lockfile", "3 files skipped: generated"])
  })

  test("blocking, findings and clean from every bucket; settled findings do not count", () => {
    expect(ConnectFindings.verdict({ outcome: outcome(), findings })).toBe("blocking")
    const stillOpenBlocking = ConnectFindings.fromSelection({
      ...empty(),
      stillOpen: [prior("s", { severity: "blocking" })],
    })
    expect(ConnectFindings.verdict({ outcome: outcome(), findings: stillOpenBlocking })).toBe("blocking")
    const outsideConcern = ConnectFindings.fromSelection({
      ...empty(),
      outsideDiff: [{ ...core("x"), reason: "no-patch" }],
    })
    expect(ConnectFindings.verdict({ outcome: outcome(), findings: outsideConcern })).toBe("findings")
    expect(ConnectFindings.verdict({ outcome: outcome(), findings: nitsOnly })).toBe("clean")
    expect(ConnectFindings.verdict({ outcome: outcome(), findings: [] })).toBe("clean")
    const settled = findings.map((finding) => ({ ...finding, status: "fixed" as const }))
    expect(ConnectFindings.verdict({ outcome: outcome(), findings: settled })).toBe("clean")
    expect(ConnectFindings.verdict({ findings: [] })).toBe("not-reviewed")
  })

  test("Vector's notes about an outcome, and the cached note", () => {
    const notes = ConnectFindings.outcomeNotes(
      outcome({
        partial: "budget",
        specialists: [{ name: "security", status: "timeout", steps: 2 }],
        unreviewed: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
        skipped: [{ path: "gen.ts", reason: "generated" }],
        notes: ["1 generated file header found."],
      }),
    )
    expect(notes).toEqual([
      "The review stopped early because it reached its spend cap.",
      "The security pass timed out.",
      "6 files were not reviewed: a.ts, b.ts, c.ts, d.ts, e.ts and 1 more.",
      "1 file skipped: generated",
      "1 generated file header found.",
    ])
    expect(ConnectFindings.cachedNote("0123456789abcdef")).toBe("Already reviewed at 0123456.")
  })
})

describe("comparing two reviews", () => {
  const finding = (id: string, overrides: Partial<Connect.Finding> = {}): Connect.Finding => ({
    id,
    severity: "concern",
    category: "bug",
    path: `src/${id}.ts`,
    line: 10,
    side: "RIGHT",
    title: `Problem ${id}`,
    body: `Body ${id}`,
    source: "review",
    bucket: "inline",
    status: "open",
    ...overrides,
  })

  test("only reviews of the same target kind compare", () => {
    expect(ConnectFindings.comparable({ kind: "uncommitted" }, { kind: "uncommitted" })).toBe(true)
    expect(ConnectFindings.comparable({ kind: "branch", base: "main" }, { kind: "branch" })).toBe(true)
    expect(ConnectFindings.comparable({ kind: "staged" }, { kind: "uncommitted" })).toBe(false)
    expect(ConnectFindings.comparable(undefined, { kind: "staged" })).toBe(false)
    const refused = ConnectFindings.compare({
      target: { kind: "uncommitted" },
      previous: { target: { kind: "staged" }, findings: [finding("a")] },
      current: [finding("a")],
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("input")
      expect(refused.refusal.message).toContain("staged changes")
    }
  })

  test("the working tree: matched findings are still open, unmatched ones new, and missing ones fixed", () => {
    const previous = [
      finding("a"),
      finding("b", { path: "src/shared.ts", line: 20, title: "Missing null check on user" }),
      finding("c", { severity: "blocking", suggestion: "x()" }),
      finding("d", { status: "dismissed", path: "src/dismissed.ts" }),
      finding("e", { status: "fixed" }),
    ]
    const current = [
      // The same id: still open.
      finding("a", { line: 14 }),
      // A new id two lines away with a similar title: still open, by place.
      finding("b2", { path: "src/shared.ts", line: 22, title: "Missing null check on the user" }),
      // A person dismissed it before, so it stays dismissed.
      finding("d2", { path: "src/dismissed.ts", title: "Problem d" }),
      // Nothing like it before.
      finding("n", { path: "src/new.ts" }),
      // Matches the already fixed one only: new again.
      finding("e"),
    ]
    const result = ConnectFindings.compare({
      target: { kind: "uncommitted" },
      previous: { target: { kind: "uncommitted" }, findings: previous },
      current,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.findings.map((entry) => [entry.id, entry.status])).toEqual([
      ["a", "still-open"],
      ["b2", "still-open"],
      ["d2", "dismissed"],
      ["n", "new"],
      ["e", "new"],
      ["c", "fixed"],
    ])
    const fixed = result.findings.at(-1)!
    expect(fixed.body).toBe("")
    expect(fixed.suggestion).toBeUndefined()
    expect(result.notes).toEqual([])
    decodeResult({
      state: "completed",
      verdict: "findings",
      summary: "s",
      findings: result.findings,
      sessions: [],
      notes: [],
    })
  })

  test("an earlier finding in a file this review no longer covers is not called fixed", () => {
    const result = ConnectFindings.compareWorktree({
      previous: [finding("a"), finding("gone", { path: "src/committed.ts" })],
      current: [],
      changed: ["src/a.ts"],
    })
    expect(result.findings.map((entry) => [entry.id, entry.status])).toEqual([["a", "fixed"]])
    expect(result.notes[0]).toContain("1 earlier finding is in files this review no longer covers")
  })

  test("each earlier finding is claimed once, by the first match in VectorScope's order", () => {
    const result = ConnectFindings.compareWorktree({
      previous: [finding("a")],
      current: [finding("a"), finding("a2", { title: "Problem a", line: 11 })],
    })
    expect(result.findings.map((entry) => entry.status)).toEqual(["still-open", "new"])
  })

  test("a branch: fixed and still open come from VectorScope's state", () => {
    const current = [
      ...ConnectFindings.fromSelection({
        ...empty(),
        inline: [placed("p1"), placed("raised", { severity: "blocking" })],
        stillOpen: [prior("open1")],
      }),
    ]
    const result = ConnectFindings.compare({
      target: { kind: "branch", base: "main" },
      previous: { target: { kind: "branch", base: "main" }, findings: [finding("gone1", { bucket: "overflow" })] },
      current,
      selection: {
        fixed: [prior("gone1", { status: "fixed", fixedIn: "abc" }), prior("gone2", { status: "fixed" })],
        raised: [{ id: "raised", was: "concern" }],
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.findings.map((entry) => [entry.id, entry.status, entry.bucket])).toEqual([
      ["p1", "new", "inline"],
      ["raised", "still-open", "inline"],
      ["open1", "still-open", "still-open"],
      ["gone1", "fixed", "overflow"],
      ["gone2", "fixed", "still-open"],
    ])
    for (const entry of result.findings) decodeFinding(entry)
  })

  test("target words", () => {
    expect(ConnectFindings.targetWords({ kind: "uncommitted" })).toBe("uncommitted changes")
    expect(ConnectFindings.targetWords({ kind: "branch", base: "main" })).toBe("the branch against main")
  })
})

function empty(): Pick<Selection, "inline" | "overflow" | "outsideDiff" | "elsewhere" | "nits" | "stillOpen"> {
  return { inline: [], overflow: [], outsideDiff: [], elsewhere: [], nits: [], stillOpen: [] }
}
