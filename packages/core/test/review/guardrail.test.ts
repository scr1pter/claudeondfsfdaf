import { describe, expect, test } from "bun:test"
import {
  anchorText,
  applyFixPatch,
  buildAnchorIndex,
  parseUnifiedDiff,
  resolveAnchor,
  suggestionAllowed,
  touched,
} from "@vectordevai/core/review/diff"
import { normalizeCode } from "@vectordevai/core/review/fingerprint"
import {
  MAX_FIX_HUNKS,
  quoteMatches,
  strictBlobRequests,
  strictSelect,
  type StrictBlob,
  type StrictInput,
} from "@vectordevai/core/review/guardrail"
import { buildSummaryBody } from "@vectordevai/core/review/format"
import { decodeReport, MAX_FAILURE_TEXT_CHARS, strictResultJsonSchema } from "@vectordevai/core/review/schema"
import { gap, MAX_INLINE, NEAR, sameFinding } from "@vectordevai/core/review/select"
import {
  FAILURE_CLASSES,
  STRICT_DROPS,
  STRICT_FIX_KINDS,
  type FailureInfo,
  type Finding,
  type Quote,
  type StrictFinding,
  type StrictResult,
} from "@vectordevai/core/review/types"
import type { VerdictCoverage } from "@vectordevai/core/review/verdict"
import { violations } from "./fixtures/json-schema"

// VS-27b's strict guardrail over a small change: session.ts loses a null check (base line 3) and gains a line (head
// line 8), and old-token.ts is renamed to token.ts with its first line changed. store.ts is outside the diff.
const SESSION_BASE = [
  "export function current(store) {",
  "  const session = store.read()",
  "  if (!session) return undefined",
  "  return session.user.id",
  "}",
  "",
  "export function clear(store) {",
  "  store.reset()",
  "}",
  "",
].join("\n")
const SESSION_HEAD = [
  "export function current(store) {",
  "  const session = store.read()",
  "  return session.user.id",
  "}",
  "",
  "export function clear(store) {",
  "  store.reset()",
  "  store.flush()",
  "}",
  "",
].join("\n")
const TOKEN_BASE = 'export const ttl = 60\nexport const name = "token"\n'
const TOKEN_HEAD = 'export const ttl = 0\nexport const name = "token"\n'
const STORE_HEAD = "export function read(store) {\n  return store.value\n}\n"

const anchors = parseUnifiedDiff(
  [
    "diff --git a/src/auth/session.ts b/src/auth/session.ts",
    "index 1111111..2222222 100644",
    "--- a/src/auth/session.ts",
    "+++ b/src/auth/session.ts",
    "@@ -1,5 +1,4 @@",
    " export function current(store) {",
    "   const session = store.read()",
    "-  if (!session) return undefined",
    "   return session.user.id",
    " }",
    "@@ -7,3 +6,4 @@",
    " export function clear(store) {",
    "   store.reset()",
    "+  store.flush()",
    " }",
    "diff --git a/src/auth/old-token.ts b/src/auth/token.ts",
    "similarity index 90%",
    "rename from src/auth/old-token.ts",
    "rename to src/auth/token.ts",
    "--- a/src/auth/old-token.ts",
    "+++ b/src/auth/token.ts",
    "@@ -1,2 +1,2 @@",
    "-export const ttl = 60",
    "+export const ttl = 0",
    ' export const name = "token"',
    "",
  ].join("\n"),
)

const HEAD = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00"
const VERIFIER = "anthropic/claude-sonnet-4-5"
const SESSION = "src/auth/session.ts"
const FAILURE: FailureInfo = {
  class: "crash",
  mechanism: "regression",
  trigger: "Calling current() after logout cleared the store.",
  impact: "The request handler throws and the page fails to load.",
}
const RETURN_QUOTE: Quote = { path: SESSION, line: 3, side: "RIGHT", code: "  return session.user.id" }
const GUARD_QUOTE: Quote = { path: SESSION, line: 3, side: "LEFT", code: "  if (!session) return undefined" }
const FLUSH_QUOTE: Quote = { path: SESSION, line: 8, side: "RIGHT", code: "  store.flush()" }
// Re-adds the removed guard: one hunk that applies to head at its own lines.
const GUARD_PATCH = [
  "--- a/src/auth/session.ts",
  "+++ b/src/auth/session.ts",
  "@@ -2,2 +2,3 @@",
  "   const session = store.read()",
  "+  if (!session) return undefined",
  "   return session.user.id",
].join("\n")
const COMPLETE: VerdictCoverage = {
  unreviewed: [],
  skipped: [],
  specialists: [
    { name: "review", status: "ok" },
    { name: "verify", status: "ok" },
  ],
}

let next = 0
function finding(overrides: Partial<Finding> = {}): Finding {
  next++
  return {
    id: `f${next.toString(16).padStart(11, "0")}`,
    path: SESSION,
    line: 3,
    side: "RIGHT",
    severity: "blocking",
    category: "bug",
    title: "Null session read after logout",
    body: "Explained.",
    confidence: 0.9,
    source: "review",
    verified: true,
    failure: FAILURE,
    quotes: [RETURN_QUOTE],
    suggestion: "  return session?.user.id",
    ...overrides,
  }
}

function blobs(head: Record<string, StrictBlob> = {}, base: Record<string, StrictBlob> = {}): StrictInput["blobs"] {
  return {
    head: new Map(
      Object.entries({
        [SESSION]: SESSION_HEAD,
        "src/auth/token.ts": TOKEN_HEAD,
        "src/auth/store.ts": STORE_HEAD,
        ...head,
      }),
    ),
    base: new Map(Object.entries({ [SESSION]: SESSION_BASE, "src/auth/old-token.ts": TOKEN_BASE, ...base })),
  }
}

function input(overrides: Partial<StrictInput> = {}): StrictInput {
  return {
    head: HEAD,
    anchors,
    blobs: blobs(),
    config: { maxComments: 10, suggestions: true },
    trust: "trusted",
    verifier: VERIFIER,
    unanswered: [],
    coverage: COMPLETE,
    ...overrides,
  }
}

function run(findings: Finding[], overrides: Partial<StrictInput> = {}) {
  return strictSelect(findings, input(overrides))
}

// The one drop a lone finding gets, or "kept".
function fate(entry: Finding, overrides: Partial<StrictInput> = {}) {
  const result = run([entry], overrides)
  if (result.findings.length) return "kept"
  expect(result.dropped).toHaveLength(1)
  expect(result.dropped[0].count).toBe(1)
  return result.dropped[0].reason
}

function fixOf(entry: Finding, overrides: Partial<StrictInput> = {}) {
  const result = run([entry], overrides)
  expect(result.findings).toHaveLength(1)
  return { ...result.findings[0].fix, unchecked: result.fixUnchecked }
}

describe("strictSelect: what it keeps", () => {
  test("a verified, blocking, anchored, quoted finding with its impact and a fix, as a StrictResult", () => {
    const kept = finding({ id: "3f9a1c07be21" })
    const result = run([kept])
    const expected: StrictResult = {
      version: 1,
      head: HEAD,
      complete: true,
      findings: [
        {
          id: "3f9a1c07be21",
          class: "crash",
          mechanism: "regression",
          path: SESSION,
          line: 3,
          side: "RIGHT",
          title: "Null session read after logout",
          trigger: FAILURE.trigger,
          impact: FAILURE.impact,
          quotes: [RETURN_QUOTE],
          fix: { kind: "suggestion", text: "  return session?.user.id" },
          verifiedBy: "model",
          verifier: VERIFIER,
        },
      ],
      dropped: [],
      fixUnchecked: 0,
    }
    expect(result).toEqual(expected)
    expect(Object.keys(result.findings[0])).toEqual(Object.keys(expected.findings[0]))
    expect(violations(strictResultJsonSchema({ guardrail: "strict" })!, result)).toEqual([])
  })

  test("a path written with a diff prefix, a range and a runtime confirmation", () => {
    const result = run([
      finding({
        path: "./src/auth/session.ts",
        line: 2,
        endLine: 3,
        verifiedBy: "runtime",
        quotes: [{ ...RETURN_QUOTE, path: "b/src/auth/session.ts" }],
        suggestion: undefined,
        patch: GUARD_PATCH,
      }),
    ])
    expect(result.findings[0]).toMatchObject({
      path: SESSION,
      line: 2,
      endLine: 3,
      quotes: [RETURN_QUOTE],
      fix: { kind: "patch", text: GUARD_PATCH },
      verifiedBy: "runtime",
      verifier: "runtime",
    })
  })

  test("never changes its input", () => {
    const entries = [finding({ path: "./src/auth/session.ts" }), finding({ line: 8, quotes: [FLUSH_QUOTE] })]
    const copy = structuredClone(entries)
    const options = input()
    run(entries, options)
    expect(entries).toEqual(copy)
    expect(options.blobs.head.get(SESSION)).toBe(SESSION_HEAD)
  })
})

describe("strictSelect: every drop reason, at the first rule that fails", () => {
  test("S1: unverified, and an unreadable verdict, which is never kept by default", () => {
    expect(fate(finding({ verified: false }))).toBe("unverified")
    expect(fate(finding({ verified: undefined }))).toBe("unverified")
    const unread = finding({ verified: undefined })
    const result = run([unread], { unanswered: [unread.id] })
    expect(result.findings).toEqual([])
    expect(result.dropped).toEqual([{ reason: "verdict-unreadable", count: 1 }])
    expect(result.complete).toBe(false)
    expect(result.incomplete).toEqual(["verdict-unreadable"])
    // A verdict that confirmed it was readable, whatever the list says.
    const confirmed = finding()
    expect(run([confirmed], { unanswered: [confirmed.id] }).findings).toHaveLength(1)
  })

  test("S2: an unreadable severity, then one other than blocking, then no class of the five", () => {
    expect(fate(finding({ severity: "concern", severityUnreadable: true }))).toBe("severity-unreadable")
    expect(fate(finding({ severity: "concern" }))).toBe("not-blocking")
    expect(fate(finding({ severity: "nit" }))).toBe("not-blocking")
    expect(fate(finding({ failure: undefined }))).toBe("out-of-scope")
    // The strict prompt asks for a failure block only on blocking findings, so a concern without one is not-blocking,
    // and an unreadable severity without one is counted as such.
    expect(fate(finding({ severity: "concern", failure: undefined }))).toBe("not-blocking")
    expect(fate(finding({ severity: "concern", severityUnreadable: true, failure: undefined }))).toBe(
      "severity-unreadable",
    )
  })

  test("S2 through the strict decoder: 'critical' with no failure block is severity-unreadable", () => {
    const decoded = (fields: Record<string, unknown>) => {
      const model = decodeReport(
        {
          summary: "s",
          findings: [
            {
              path: SESSION,
              line: 3,
              category: "bug",
              title: "Null session read after logout",
              body: "b",
              confidence: 0.9,
              quotes: [RETURN_QUOTE],
              suggestion: "  return session?.user.id",
              ...fields,
            },
          ],
        },
        { guardrail: "strict" },
      )!.findings[0]
      return { ...model, id: "d1", side: model.side ?? "RIGHT", source: "review" as const, verified: true }
    }
    expect(fate(decoded({ severity: "critical" }))).toBe("severity-unreadable")
    expect(fate(decoded({ severity: "concern" }))).toBe("not-blocking")
    expect(fate(decoded({ severity: "blocking" }))).toBe("out-of-scope")
    // A failure block with a class but an unrecognised mechanism decodes as none: a known mislabel, as out-of-scope.
    expect(fate(decoded({ severity: "blocking", failure: { ...FAILURE, mechanism: "race" } }))).toBe("out-of-scope")
    expect(fate(decoded({ severity: "blocking", failure: FAILURE }))).toBe("kept")
  })

  test("S3: a context line, a snapped line and a file outside the diff are not anchored on a change", () => {
    // Head line 7 is context with no deletion beside it; 10 is past the last hunk and would snap onto line 8.
    expect(fate(finding({ line: 7, quotes: [{ ...RETURN_QUOTE, line: 7, code: "  store.reset()" }] }))).toBe("anchor")
    expect(fate(finding({ line: 10, quotes: [FLUSH_QUOTE] }))).toBe("anchor")
    expect(
      fate(
        finding({
          path: "src/auth/store.ts",
          line: 2,
          quotes: [{ ...RETURN_QUOTE, path: "src/auth/store.ts", line: 2, code: "  return store.value" }],
        }),
      ),
    ).toBe("anchor")
    // The lines around a deletion and an added line are changed lines.
    expect(
      fate(finding({ line: 2, quotes: [{ ...RETURN_QUOTE, line: 2, code: "  const session = store.read()" }] })),
    ).toBe("kept")
    expect(fate(finding({ line: 8, quotes: [FLUSH_QUOTE], suggestion: undefined, patch: GUARD_PATCH }))).toBe("kept")
    // A range with one changed line in it.
    expect(
      fate(finding({ line: 7, endLine: 8, quotes: [FLUSH_QUOTE], suggestion: undefined, patch: GUARD_PATCH })),
    ).toBe("kept")
  })

  test("S4: no quote that is the file's text at its line, on its own side", () => {
    expect(fate(finding({ quotes: undefined }))).toBe("quote-mismatch")
    expect(fate(finding({ quotes: [{ ...RETURN_QUOTE, code: "  return session.user.name" }] }))).toBe("quote-mismatch")
    expect(fate(finding({ quotes: [{ ...RETURN_QUOTE, line: 4 }] }))).toBe("quote-mismatch")
    // Removed code quoted as head code, and head code quoted as base code at a line where base has other code.
    expect(fate(finding({ quotes: [{ ...GUARD_QUOTE, side: "RIGHT" }] }))).toBe("quote-mismatch")
    expect(fate(finding({ quotes: [{ ...RETURN_QUOTE, side: "LEFT" }] }))).toBe("quote-mismatch")
    // A quote that runs past the end of the file, though the lines that are there match once blank lines are dropped.
    expect(fate(finding({ quotes: [{ ...FLUSH_QUOTE, code: "store.flush()\n\n\n}" }] }))).toBe("quote-mismatch")
    expect(fate(finding({ quotes: [{ ...FLUSH_QUOTE, code: "store.flush()\n}" }] }))).toBe("kept")
    // One matching quote among others is enough, and only the matching ones are kept.
    const result = run([finding({ quotes: [{ ...RETURN_QUOTE, line: 1 }, RETURN_QUOTE] })])
    expect(result.findings[0].quotes).toEqual([RETURN_QUOTE])
  })

  test("S5: a trigger and an impact, each at most 400 characters", () => {
    expect(fate(finding({ failure: { ...FAILURE, trigger: "" } }))).toBe("no-impact")
    expect(fate(finding({ failure: { ...FAILURE, impact: "  " } }))).toBe("no-impact")
    expect(fate(finding({ failure: { ...FAILURE, impact: "i".repeat(MAX_FAILURE_TEXT_CHARS + 1) } }))).toBe("no-impact")
    expect(fate(finding({ failure: { ...FAILURE, trigger: "t".repeat(MAX_FAILURE_TEXT_CHARS + 1) } }))).toBe(
      "no-impact",
    )
    expect(fate(finding({ failure: { ...FAILURE, impact: "i".repeat(MAX_FAILURE_TEXT_CHARS) } }))).toBe("kept")
    // Counted in code points, as JSON Schema's maxLength counts: 400 emoji are 800 UTF-16 units.
    expect(fate(finding({ failure: { ...FAILURE, impact: "💥".repeat(MAX_FAILURE_TEXT_CHARS) } }))).toBe("kept")
    expect(fate(finding({ failure: { ...FAILURE, impact: "💥".repeat(MAX_FAILURE_TEXT_CHARS + 1) } }))).toBe(
      "no-impact",
    )
  })

  test("S6: no fix text", () => {
    expect(fate(finding({ suggestion: undefined }))).toBe("no-fix")
    expect(fate(finding({ suggestion: "  " }))).toBe("no-fix")
    expect(fate(finding({ suggestion: undefined, patch: "" }))).toBe("no-fix")
    expect(fate(finding({ suggestion: "x".repeat(8_001) }))).toBe("no-fix")
  })

  test("S7: the same id, the same finding as selection reads it, or the same class within 3 lines", () => {
    const strong = finding({ confidence: 0.95 })
    expect(
      run([finding({ id: strong.id, line: 8, quotes: [FLUSH_QUOTE], title: "Flush runs twice" }), strong]),
    ).toMatchObject({
      findings: [{ id: strong.id, line: 3 }],
      dropped: [{ reason: "duplicate", count: 1 }],
    })
    // Alike titles two lines apart (sameFinding).
    const alike = finding({
      line: 2,
      title: "Null session read after logout here",
      quotes: [{ ...RETURN_QUOTE, line: 2, code: "  const session = store.read()" }],
    })
    expect(run([strong, alike]).dropped).toEqual([{ reason: "duplicate", count: 1 }])
    // Unlike titles, the same class, within 3 lines: one root cause. Another class there is its own finding.
    const other = {
      line: 2,
      title: "Store read is not awaited",
      quotes: [{ ...RETURN_QUOTE, line: 2, code: "  const session = store.read()" }],
      suggestion: "  const session = await store.read()",
    }
    expect(run([strong, finding(other)]).dropped).toEqual([{ reason: "duplicate", count: 1 }])
    expect(
      run([strong, finding({ ...other, failure: { ...FAILURE, class: "data-corruption" } })]).findings,
    ).toHaveLength(2)
    // The same class further away, or on the other side, is its own finding.
    expect(
      run([strong, finding({ line: 8, title: "Flush throws on a closed store", quotes: [FLUSH_QUOTE] })]).findings,
    ).toHaveLength(2)
    expect(
      run([
        strong,
        finding({
          side: "LEFT",
          title: "Guard removed",
          quotes: [GUARD_QUOTE],
          suggestion: undefined,
          patch: GUARD_PATCH,
        }),
      ]).findings,
    ).toHaveLength(2)
  })

  test("S7 keeps the stronger: a runtime confirmation, then confidence, whatever the input order", () => {
    const model = finding({ confidence: 0.99 })
    const runtime = finding({ confidence: 0.6, verifiedBy: "runtime" })
    for (const order of [
      [model, runtime],
      [runtime, model],
    ])
      expect(run(order).findings.map((entry) => entry.id)).toEqual([runtime.id])
    const low = finding({ confidence: 0.7 })
    expect(run([low, model]).findings.map((entry) => entry.id)).toEqual([model.id])
  })

  test("S8: at most maxComments, clamped as selection clamps it", () => {
    const two = [finding(), finding({ line: 8, title: "Flush throws on a closed store", quotes: [FLUSH_QUOTE] })]
    expect(run(two, { config: { maxComments: 1, suggestions: true } })).toMatchObject({
      findings: [{ id: two[0].id }],
      dropped: [{ reason: "cap", count: 1 }],
      complete: true,
    })
    for (const maxComments of [0, -3, 0.5])
      expect(run(two, { config: { maxComments, suggestions: true } })).toMatchObject({
        findings: [],
        dropped: [{ reason: "cap", count: 2 }],
        complete: true,
      })
    expect(MAX_INLINE).toBe(50)
    const many = Array.from({ length: 60 }, (_, index) =>
      finding({
        path: `src/gen/f${index}.ts`,
        line: 1,
        quotes: [{ ...RETURN_QUOTE, path: `src/gen/f${index}.ts`, line: 1, code: "x" }],
      }),
    )
    const files = parseUnifiedDiff(
      many
        .map(
          (entry) =>
            `diff --git a/${entry.path} b/${entry.path}\n--- a/${entry.path}\n+++ b/${entry.path}\n@@ -1 +1 @@\n-y\n+x`,
        )
        .join("\n"),
    )
    const result = strictSelect(many, {
      ...input({ anchors: files, config: { maxComments: 500, suggestions: true } }),
      blobs: { head: new Map(many.map((entry) => [entry.path, "x\n"])), base: new Map() },
    })
    expect(result.findings).toHaveLength(MAX_INLINE)
    expect(result.dropped).toEqual([{ reason: "cap", count: 10 }])
  })

  test("drops are listed in rule order, each with its count", () => {
    const result = run([
      finding({ quotes: undefined }),
      finding({ verified: false }),
      finding({ severity: "concern" }),
      finding({ verified: false }),
      finding({ failure: undefined }),
      finding({ line: 7, quotes: [{ ...RETURN_QUOTE, line: 7, code: "  store.reset()" }] }),
    ])
    expect(result.dropped).toEqual([
      { reason: "unverified", count: 2 },
      { reason: "not-blocking", count: 1 },
      { reason: "out-of-scope", count: 1 },
      { reason: "anchor", count: 1 },
      { reason: "quote-mismatch", count: 1 },
    ])
    expect(result.dropped.map((entry) => STRICT_DROPS.indexOf(entry.reason))).toEqual(
      result.dropped.map((entry) => STRICT_DROPS.indexOf(entry.reason)).toSorted((a, b) => a - b),
    )
  })
})

describe("strictSelect: fixes (S6)", () => {
  test("a committable suggestion under the existing rules", () => {
    expect(fixOf(finding())).toEqual({ kind: "suggestion", text: "  return session?.user.id", unchecked: 0 })
    // Untrusted and verified is the existing rule's allowed case (S1 kept only verified findings).
    expect(fixOf(finding(), { trust: "untrusted" }).kind).toBe("suggestion")
  })

  test("a suggestion the existing rules refuse is kept unchecked: suggestions off, LEFT, a range that moved, repeated lines", () => {
    expect(fixOf(finding(), { config: { maxComments: 10, suggestions: false } })).toEqual({
      kind: "unchecked",
      text: "  return session?.user.id",
      unchecked: 1,
    })
    expect(
      fixOf(finding({ side: "LEFT", quotes: [GUARD_QUOTE], suggestion: "  if (!session) return null" })).kind,
    ).toBe("unchecked")
    // Head line 5 is between the hunks, so a range from it anchors at line 8 only.
    expect(fixOf(finding({ line: 5, endLine: 8, quotes: [FLUSH_QUOTE], suggestion: "  store.flush(true)" })).kind).toBe(
      "unchecked",
    )
    // The fix's last line is the line after its range, which would be there twice once committed.
    expect(
      fixOf(
        finding({
          line: 2,
          quotes: [{ ...RETURN_QUOTE, line: 2, code: "  const session = store.read()" }],
          suggestion: "  const session = store.read() ?? {}\n  return session.user.id",
        }),
      ).kind,
    ).toBe("unchecked")
  })

  test("a patch of at most 3 hunks that applies to head at its own lines", () => {
    expect(fixOf(finding({ suggestion: undefined, patch: GUARD_PATCH }))).toEqual({
      kind: "patch",
      text: GUARD_PATCH,
      unchecked: 0,
    })
    // A suggestion the rules allow wins over a patch; one they refuse leaves the patch.
    expect(fixOf(finding({ patch: GUARD_PATCH })).kind).toBe("suggestion")
    expect(fixOf(finding({ patch: GUARD_PATCH }), { config: { maxComments: 10, suggestions: false } }).kind).toBe(
      "patch",
    )
    expect(MAX_FIX_HUNKS).toBe(3)
    const lines = SESSION_HEAD.split("\n")
    const hunks = (count: number) =>
      [1, 3, 6, 8]
        .slice(0, count)
        .flatMap((line) => [`@@ -${line},1 +${line},1 @@`, `-${lines[line - 1]}`, `+${lines[line - 1]} // checked`])
        .join("\n")
    expect(fixOf(finding({ suggestion: undefined, patch: hunks(3) })).kind).toBe("patch")
    expect(fixOf(finding({ suggestion: undefined, patch: hunks(4) }))).toEqual({
      kind: "unchecked",
      text: hunks(4),
      unchecked: 1,
    })
    // Context that is not head's, and a head file that could not be read, leave the patch unchecked, not dropped.
    const stale = GUARD_PATCH.replace("   return session.user.id", "   return session.id")
    expect(fixOf(finding({ suggestion: undefined, patch: stale })).kind).toBe("unchecked")
    // A deletion defect quoted from base, so only the patch reads the head file.
    for (const head of [null, { absent: true } as const]) {
      const result = run(
        [finding({ side: "LEFT", quotes: [GUARD_QUOTE], suggestion: undefined, patch: GUARD_PATCH })],
        {
          blobs: blobs({ [SESSION]: head }),
        },
      )
      expect(result.findings[0].fix).toEqual({ kind: "unchecked", text: GUARD_PATCH })
      expect(result.complete).toBe(true)
    }
  })

  test("a cross-file defect whose fix is in another file is kept with its fix unchecked (C-14)", () => {
    const storePatch = [
      "--- a/src/auth/store.ts",
      "+++ b/src/auth/store.ts",
      "@@ -1,3 +1,3 @@",
      " export function read(store) {",
      "-  return store.value",
      "+  return store.value ?? null",
      " }",
    ].join("\n")
    // The patch applies to store.ts itself, but it is not the finding's file, so it is never posted as a patch.
    expect(applyFixPatch(STORE_HEAD, storePatch, { path: "src/auth/store.ts", maxHunks: 3 }).ok).toBe(true)
    const result = run([
      finding({
        suggestion: undefined,
        patch: storePatch,
        quotes: [RETURN_QUOTE, { path: "src/auth/store.ts", line: 2, side: "RIGHT", code: "return store.value" }],
      }),
    ])
    expect(result.findings[0].fix).toEqual({ kind: "unchecked", text: storePatch })
    expect(result.findings[0].quotes.map((entry) => entry.path)).toEqual([SESSION, "src/auth/store.ts"])
    expect(result.fixUnchecked).toBe(1)
    expect(result.complete).toBe(true)
  })

  test("the parse check rejects a patch only when head parsed and the patched file does not", () => {
    const calls: string[] = []
    const parses = (broken: boolean | undefined) => (path: string, text: string) => {
      calls.push(text === SESSION_HEAD ? `head ${path}` : `patched ${path}`)
      if (text === SESSION_HEAD) return broken === undefined ? undefined : true
      return broken === undefined ? undefined : !broken
    }
    const patched = finding({ suggestion: undefined, patch: GUARD_PATCH })
    expect(fixOf(patched, { parses: parses(false) }).kind).toBe("patch")
    expect(fixOf(patched, { parses: parses(true) }).kind).toBe("unchecked")
    // A language the engine does not parse: no check.
    expect(fixOf(patched, { parses: parses(undefined) }).kind).toBe("patch")
    // Head that already fails to parse cannot be broken by the patch.
    expect(fixOf(patched, { parses: () => false }).kind).toBe("patch")
    // Head is parsed once per file, however many patches touch it.
    calls.length = 0
    run(
      [
        patched,
        finding({
          line: 8,
          title: "Flush throws on a closed store",
          quotes: [FLUSH_QUOTE],
          suggestion: undefined,
          patch: GUARD_PATCH,
        }),
      ],
      { parses: parses(false) },
    )
    expect(calls.filter((call) => call.startsWith("head"))).toEqual([`head ${SESSION}`])
    expect(calls.filter((call) => call.startsWith("patched"))).toHaveLength(2)
  })

  test("a parse check that throws leaves that patch unchecked and the rest of the selection as it was", () => {
    const patched = finding({ suggestion: undefined, patch: GUARD_PATCH })
    const throwsOn = (which: "head" | "patched") => (_path: string, text: string) => {
      if ((text === SESSION_HEAD) === (which === "head")) throw new Error("parse timed out")
      return true
    }
    for (const which of ["head", "patched"] as const) {
      const result = run([patched, finding({ line: 8, title: "Flush throws", quotes: [FLUSH_QUOTE] })], {
        parses: throwsOn(which),
      })
      expect(result.findings.map((entry) => entry.fix.kind).toSorted()).toEqual(["suggestion", "unchecked"])
      expect(result).toMatchObject({ complete: true, fixUnchecked: 1 })
    }
  })
})

describe("strictSelect: deletion-only defects", () => {
  test("a LEFT anchor on the removed guard with a base quote is kept, its fix re-adding the guard as a patch", () => {
    const result = run([finding({ side: "LEFT", quotes: [GUARD_QUOTE], suggestion: undefined, patch: GUARD_PATCH })])
    expect(result.findings[0]).toMatchObject({ side: "LEFT", line: 3, quotes: [GUARD_QUOTE], fix: { kind: "patch" } })
    // The base quote is read from base only.
    expect(
      run([finding({ side: "LEFT", quotes: [GUARD_QUOTE], suggestion: undefined, patch: GUARD_PATCH })], {
        blobs: blobs({}, { [SESSION]: SESSION_HEAD }),
      }).dropped,
    ).toEqual([{ reason: "quote-mismatch", count: 1 }])
    // A LEFT line the change kept is not on removed code.
    expect(
      fate(finding({ side: "LEFT", line: 4, quotes: [{ ...GUARD_QUOTE, line: 4, code: "  return session.user.id" }] })),
    ).toBe("anchor")
  })

  test("a renamed file's base quote is read at its old path", () => {
    const ttl = { path: "src/auth/token.ts", line: 1, side: "LEFT" as const, code: "export const ttl = 60" }
    const entry = finding({
      path: "src/auth/token.ts",
      line: 1,
      side: "LEFT",
      quotes: [ttl],
      suggestion: undefined,
      patch: "x",
    })
    const result = run([entry])
    expect(result.findings[0].quotes).toEqual([{ ...ttl, path: "src/auth/old-token.ts" }])
    expect(strictBlobRequests([entry], anchors)).toEqual({
      head: ["src/auth/token.ts"],
      base: ["src/auth/old-token.ts"],
    })
  })
})

describe("strictSelect: completeness", () => {
  test("empty and complete, versus empty and incomplete, with reasons in a fixed order", () => {
    expect(run([])).toEqual({ version: 1, head: HEAD, complete: true, findings: [], dropped: [], fixUnchecked: 0 })
    const coverage = (overrides: Partial<VerdictCoverage>) => run([], { coverage: { ...COMPLETE, ...overrides } })
    expect(coverage({ partial: "timeout" })).toMatchObject({ complete: false, incomplete: ["timeout"] })
    expect(coverage({ unreviewed: ["src/a.ts"] }).incomplete).toEqual(["unreviewed"])
    expect(coverage({ skipped: [{ reason: "size-limit" }] }).incomplete).toEqual(["size-limit"])
    expect(coverage({ skipped: [{ reason: "lockfile" }] }).complete).toBe(true)
    expect(coverage({ held: [{ status: "modified" }] }).incomplete).toEqual(["held-back"])
    expect(
      coverage({
        specialists: [
          { name: "review", status: "ok" },
          { name: "verify", status: "timeout" },
        ],
      }).incomplete,
    ).toEqual(["specialist"])
    expect(coverage({ specialists: [{ name: "verify", status: "ok" }] }).incomplete).toEqual(["no-reviewer"])
    const unread = finding({ verified: undefined })
    const all = run([unread, finding({ quotes: [{ ...RETURN_QUOTE, path: "src/auth/gone.ts" }] })], {
      coverage: { ...COMPLETE, partial: "steps", unreviewed: ["src/a.ts"] },
      unanswered: [unread.id],
    })
    expect(all.incomplete).toEqual(["steps", "unreviewed", "verdict-unreadable", "blob-unreadable"])
    expect(all.findings).toEqual([])
  })

  test("an unanswered id whose finding was not handed in still marks the result incomplete (I-7)", () => {
    // A caller that narrowed the list first (selection folding a duplicate, or minConfidence) cannot hide an unread
    // verdict: the empty result reads "Review incomplete", never "No verified production-breaking issues".
    const other = finding()
    for (const findings of [[], [other]]) {
      const result = run(findings, { unanswered: ["ghost"] })
      expect(result).toMatchObject({ complete: false, incomplete: ["verdict-unreadable"] })
      expect(result.findings).toHaveLength(findings.length)
    }
    const empty = run([], { unanswered: ["ghost"] })
    const body = buildSummaryBody({
      head: HEAD,
      baseRef: "main",
      mode: "full",
      selection: {
        inline: [],
        outsideDiff: [],
        elsewhere: [],
        nits: [],
        overflow: [],
        stillOpen: [],
        fixed: [],
        dismissed: [],
        reappeared: [],
        raised: [],
        dropped: [],
        risk: "low",
      },
      strict: empty,
    })
    expect(body).toContain("**Review incomplete**")
    expect(body).not.toContain("No verified production-breaking issues")
    // An id a handed-in finding confirms was read.
    expect(run([other], { unanswered: [other.id] }).complete).toBe(true)
  })

  test("a blob the engine could not read, or forgot, marks the result incomplete; a file not in the tree does not", () => {
    const quoted = finding({
      quotes: [{ ...RETURN_QUOTE, path: "src/auth/store.ts", line: 2, code: "return store.value" }],
    })
    const source = blobs()
    const forgotten = new Map([...source.head].filter(([key]) => key !== "src/auth/store.ts"))
    for (const head of [blobs({ "src/auth/store.ts": null }).head, forgotten])
      expect(run([quoted], { blobs: { head, base: source.base } })).toMatchObject({
        complete: false,
        incomplete: ["blob-unreadable"],
        dropped: [{ reason: "quote-mismatch", count: 1 }],
      })
    const absent = run([quoted], { blobs: blobs({ "src/auth/store.ts": { absent: true } }) })
    expect(absent).toMatchObject({ complete: true, dropped: [{ reason: "quote-mismatch", count: 1 }] })
    // An unreadable file that another quote makes up for, or on a finding an earlier rule drops, changes nothing.
    const both = finding({ quotes: [{ ...RETURN_QUOTE, path: "src/auth/store.ts" }, RETURN_QUOTE] })
    expect(run([both], { blobs: blobs({ "src/auth/store.ts": null }) }).complete).toBe(true)
    expect(run([{ ...quoted, verified: false }], { blobs: blobs({ "src/auth/store.ts": null }) }).complete).toBe(true)
  })

  test("impact-slice incompleteness is not coverage and never changes complete", () => {
    // A replay outcome carries its Tier 1 slice beside what it covered; only the coverage is read.
    const outcome = {
      ...COMPLETE,
      tier1: { incomplete: ["time", "partial-clone"] },
      impact: { incomplete: ["output"] },
    }
    const result = run([finding()], { coverage: outcome })
    expect(result.complete).toBe(true)
    expect(result).not.toHaveProperty("incomplete")
    const probe: VerdictCoverage = COMPLETE
    // @ts-expect-error VerdictCoverage has no impact field: the guardrail cannot be handed the slice's incompleteness.
    expect(probe.impact).toBeUndefined()
  })
})

describe("quoteMatches (S4's matcher)", () => {
  const head = "  if (a)   {\r\n\treturn  b\r\n\r\n  }\r\nend\n"
  test("matches the file's lines at the quote's line, apart from whitespace", () => {
    const quote = (line: number, code: string, side: Quote["side"] = "RIGHT"): Quote => ({
      path: "a.ts",
      line,
      side,
      code,
    })
    expect(quoteMatches(quote(1, "if (a) {\n  return b"), { head })).toBe(true)
    expect(quoteMatches(quote(1, "if (a) {\nreturn b\n\n}"), { head })).toBe(true)
    expect(quoteMatches(quote(2, "return b"), { head })).toBe(true)
    // The span is exact: the quote's line count, at its line.
    expect(quoteMatches(quote(1, "if (a) {\nreturn b\n}"), { head })).toBe(false)
    expect(quoteMatches(quote(2, "if (a) {"), { head })).toBe(false)
    expect(quoteMatches(quote(1, "if (a) {\nreturn c"), { head })).toBe(false)
    // Whitespace present on one side only is ignored too.
    expect(quoteMatches(quote(1, "if(a){"), { head })).toBe(true)
    expect(quoteMatches(quote(2, "returnb"), { head })).toBe(true)
    // Whitespace-only lines at the end are left out, and those at the start move the quote's line past them.
    expect(quoteMatches(quote(2, "return b\n"), { head })).toBe(true)
    expect(quoteMatches(quote(2, "return b\n  "), { head })).toBe(true)
    expect(quoteMatches(quote(2, "return b\n  \n\t"), { head })).toBe(true)
    expect(quoteMatches(quote(1, "  \n\treturn b"), { head })).toBe(true)
    expect(quoteMatches(quote(2, "  \nreturn b"), { head })).toBe(false)
    // A quote with no letter or digit matches almost anywhere, so it matches nothing.
    expect(quoteMatches(quote(4, "}"), { head })).toBe(false)
    expect(quoteMatches(quote(4, "  );\n"), { head: "a\nb\nc\n);\n" })).toBe(false)
    expect(quoteMatches(quote(4, "}\nend"), { head })).toBe(true)
    // Inside the file, with code to match.
    expect(quoteMatches(quote(5, "end\n\nmore"), { head })).toBe(false)
    expect(quoteMatches(quote(0, "if (a) {"), { head })).toBe(false)
    expect(quoteMatches(quote(4, "  \n"), { head })).toBe(false)
    // The side picks the text, and a text that is missing or null never matches.
    expect(quoteMatches(quote(2, "return b", "LEFT"), { head })).toBe(false)
    expect(quoteMatches(quote(2, "return b", "LEFT"), { base: head })).toBe(true)
    expect(quoteMatches(quote(2, "return b"), { head: null, base: head })).toBe(false)
    expect(quoteMatches(quote(2, "return b"), {})).toBe(false)
  })
})

// A blob map that records every key read from it.
class Recording extends Map<string, StrictBlob> {
  readonly asked = new Set<string>()
  override get(key: string) {
    this.asked.add(key)
    return super.get(key)
  }
}

describe("strictBlobRequests", () => {
  test("names every head and base key strictSelect reads, once each, sorted", () => {
    const entries = [
      finding({
        quotes: [RETURN_QUOTE, GUARD_QUOTE, { ...RETURN_QUOTE, path: "./src/auth/store.ts" }],
        patch: GUARD_PATCH,
      }),
      finding({ path: "b/src/auth/token.ts", quotes: [{ ...GUARD_QUOTE, path: "src/auth/token.ts" }], patch: "x" }),
    ]
    expect(strictBlobRequests(entries, anchors)).toEqual({
      head: ["./src/auth/store.ts", SESSION, "src/auth/token.ts"],
      base: ["src/auth/old-token.ts", SESSION],
    })
    const source = blobs()
    const head = new Recording(source.head)
    const base = new Recording(source.base)
    strictSelect(entries, input({ blobs: { head, base } }))
    const asked = strictBlobRequests(entries, anchors)
    expect(head.asked.size).toBeGreaterThan(0)
    expect(base.asked.size).toBeGreaterThan(0)
    expect([...head.asked].every((key) => asked.head.includes(key))).toBe(true)
    expect([...base.asked].every((key) => asked.base.includes(key))).toBe(true)
  })

  test("asks for no patch head outside the diff and no path that could leave the repository", () => {
    const escaping = ["src/../../etc/passwd", "..\\secret.ts", "C:/secret.ts", "../secret.ts"]
    const entries = [
      // S3 drops a finding outside the diff before S6 reads its file, so its patch needs no head.
      finding({ path: "src/auth/store.ts", line: 2, quotes: [], patch: GUARD_PATCH }),
      // Findings built without decodeReport (the desktop, the eval scripts) get the decoder's path check.
      finding({
        quotes: [RETURN_QUOTE, ...escaping.map((path) => ({ ...RETURN_QUOTE, path }))],
        patch: GUARD_PATCH,
      }),
      finding({ path: "src/../../x", quotes: [{ ...GUARD_QUOTE, path: "src/../../x" }], patch: GUARD_PATCH }),
    ]
    expect(strictBlobRequests(entries, anchors)).toEqual({ head: [SESSION], base: [] })
    // strictSelect reads such a path as a file the tree lacks: a plain mismatch, never read and never incomplete.
    const source = blobs()
    const head = new Recording(source.head)
    const base = new Recording(source.base)
    const result = strictSelect(
      [finding({ quotes: escaping.map((path) => ({ ...RETURN_QUOTE, path })) })],
      input({ blobs: { head, base } }),
    )
    expect(result).toMatchObject({ complete: true, dropped: [{ reason: "quote-mismatch", count: 1 }] })
    expect([...head.asked, ...base.asked]).toEqual([])
    // A finding kept on its matching quote is unchanged by an escaping one beside it.
    expect(run([entries[1]]).findings[0].quotes).toEqual([RETURN_QUOTE])
  })
})

// Every finding kept satisfies S1 to S5, S7 and S8, and S6 in one of its forms, over generated candidates; the result
// conforms to the result schema and does not depend on input order.
describe("strictSelect: properties", () => {
  const places: Pick<Finding, "path" | "line" | "endLine" | "side">[] = [
    { path: SESSION, line: 3, side: "RIGHT" },
    { path: SESSION, line: 2, side: "RIGHT" },
    { path: SESSION, line: 8, side: "RIGHT" },
    { path: SESSION, line: 7, side: "RIGHT" },
    { path: SESSION, line: 7, endLine: 8, side: "RIGHT" },
    { path: SESSION, line: 10, side: "RIGHT" },
    { path: SESSION, line: 3, side: "LEFT" },
    { path: "./src/auth/session.ts", line: 3, side: "RIGHT" },
    { path: "src/auth/token.ts", line: 1, side: "RIGHT" },
    { path: "src/auth/store.ts", line: 2, side: "RIGHT" },
  ]
  const quotes: Quote[] = [
    RETURN_QUOTE,
    GUARD_QUOTE,
    FLUSH_QUOTE,
    { path: SESSION, line: 2, side: "RIGHT", code: "const   session = store.read()" },
    { path: SESSION, line: 7, side: "RIGHT", code: "  store.reset()\n  store.flush()" },
    { path: "src/auth/token.ts", line: 1, side: "RIGHT", code: "export const ttl = 0" },
    { path: "src/auth/store.ts", line: 2, side: "RIGHT", code: "return store.value" },
    { path: SESSION, line: 3, side: "RIGHT", code: "  return session.id" },
    { path: "src/auth/missing.ts", line: 1, side: "RIGHT", code: "x" },
  ]
  const failures: (FailureInfo | undefined)[] = [
    FAILURE,
    { ...FAILURE, class: "leak" },
    { ...FAILURE, class: "data-corruption", trigger: "t".repeat(MAX_FAILURE_TEXT_CHARS + 1) },
    { ...FAILURE, impact: "" },
    undefined,
  ]
  const fixes: Pick<Finding, "suggestion" | "patch">[] = [
    { suggestion: "  return session?.user.id" },
    { suggestion: "  store.flush(true)" },
    { patch: GUARD_PATCH },
    { patch: GUARD_PATCH.replace("session.user.id", "session.id") },
    { patch: "--- a/src/auth/store.ts\n+++ b/src/auth/store.ts\n@@ -2 +2 @@\n-  return store.value\n+  return null" },
    {},
  ]
  const titles = [
    "Null session read after logout",
    "Flush throws on a closed store",
    "Token never expires",
    "Store read is not awaited",
  ]

  function random(seed: number) {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let value = state
      value = Math.imul(value ^ (value >>> 15), value | 1)
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }
  }

  function generate(seed: number) {
    const next = random(seed)
    const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]
    const count = 1 + Math.floor(next() * 9)
    return {
      findings: Array.from({ length: count }, (): Finding => {
        const failure = pick(failures)
        return {
          id: pick(["a1", "a2", "a3", "a4", "a5", "a6", "a7"]),
          ...pick(places),
          severity: pick(["blocking", "blocking", "blocking", "concern", "nit"] as const),
          ...(next() < 0.1 ? { severityUnreadable: true } : {}),
          category: "bug",
          title: pick(titles),
          body: "b",
          confidence: pick([0.5, 0.7, 0.9, 0.95]),
          source: pick(["review", "security"] as const),
          verified: pick([true, true, true, false, undefined]),
          ...(next() < 0.2 ? { verifiedBy: pick(["model", "runtime"] as const) } : {}),
          ...(failure ? { failure } : {}),
          quotes: Array.from({ length: Math.floor(next() * 3) }, () => pick(quotes)),
          ...pick(fixes),
        }
      }),
      maxComments: Math.floor(next() * 6),
      suggestions: next() < 0.8,
      trust: pick(["trusted", "untrusted"] as const),
      unanswered: next() < 0.3 ? ["a1", "a2"] : [],
      parses: next() < 0.5 ? (_path: string, text: string) => !text.includes("session.id") : undefined,
    }
  }

  test("every kept finding satisfies the rules, over 400 generated cases", () => {
    const schema = strictResultJsonSchema({ guardrail: "strict" })!
    const index = buildAnchorIndex(anchors)
    const source = blobs()
    const text = (side: Quote["side"], path: string) => {
      const blob = (side === "LEFT" ? source.base : source.head).get(path)
      return typeof blob === "string" ? blob : null
    }
    // What the generated cases exercised, so the property cannot pass by keeping nothing.
    const seen = new Set<string>()
    for (const seed of Array.from({ length: 400 }, (_, value) => value + 1)) {
      const generated = generate(seed)
      const options = input({
        config: { maxComments: generated.maxComments, suggestions: generated.suggestions },
        trust: generated.trust,
        unanswered: generated.unanswered,
        ...(generated.parses ? { parses: generated.parses } : {}),
      })
      const result = strictSelect(generated.findings, options)
      for (const entry of result.dropped) seen.add(entry.reason)
      for (const entry of result.findings) seen.add(entry.fix.kind)
      if (!result.complete) seen.add("incomplete")
      expect(violations(schema, result)).toEqual([])
      expect(result.findings.length + result.dropped.reduce((total, entry) => total + entry.count, 0)).toBe(
        generated.findings.length,
      )
      expect(result.fixUnchecked).toBe(result.findings.filter((entry) => entry.fix.kind === "unchecked").length)
      // S8.
      expect(result.findings.length).toBeLessThanOrEqual(Math.min(MAX_INLINE, generated.maxComments))
      const origins = result.findings.map((kept) => {
        const origin = generated.findings.find(
          (entry) =>
            entry.id === kept.id &&
            entry.line === kept.line &&
            entry.side === kept.side &&
            entry.title === kept.title &&
            entry.failure?.trigger === kept.trigger &&
            entry.failure?.impact === kept.impact &&
            entry.failure?.class === kept.class &&
            satisfies(entry, kept),
        )
        expect(origin).toBeDefined()
        return { ...origin!, path: kept.path }
      })
      // S7 among the kept, read on the findings they came from.
      const code = (entry: Finding) => {
        const resolved = resolveAnchor(index, entry)
        return resolved.ok ? normalizeCode(anchorText(index, resolved.anchor)) : ""
      }
      for (const [position, a] of origins.entries())
        for (const b of origins.slice(position + 1)) {
          expect(a.id).not.toBe(b.id)
          expect(sameFinding(a, b, code)).toBe(false)
          const near =
            a.path === b.path &&
            a.side === b.side &&
            gap(a.line, a.endLine ?? a.line, b.line, b.endLine ?? b.line) <= NEAR
          expect(near && a.failure?.class === b.failure?.class).toBe(false)
        }
      // The result does not depend on the input order.
      expect(strictSelect(generated.findings.toReversed(), options)).toEqual(result)
      expect(strictSelect([...generated.findings.slice(1), ...generated.findings.slice(0, 1)], options)).toEqual(result)

      function satisfies(origin: Finding, kept: StrictFinding) {
        const resolved = resolveAnchor(index, origin)
        if (!resolved.ok) return false
        const anchor = resolved.anchor
        const lines = Array.from(
          { length: anchor.line - (anchor.startLine ?? anchor.line) + 1 },
          (_, offset) => (anchor.startLine ?? anchor.line) + offset,
        )
        const head = text("RIGHT", kept.path)
        const applied =
          head === null ? undefined : applyFixPatch(head, kept.fix.text, { path: kept.path, maxHunks: MAX_FIX_HUNKS })
        const fixed =
          kept.fix.kind === "suggestion"
            ? options.config.suggestions &&
              kept.fix.text === origin.suggestion &&
              suggestionAllowed(index, anchor, kept.fix.text, { trust: options.trust, verified: true, range: origin })
            : kept.fix.kind === "patch"
              ? kept.fix.text === origin.patch &&
                applied?.ok === true &&
                !(options.parses?.(kept.path, head!) === true && options.parses(kept.path, applied.text) === false)
              : kept.fix.text === (origin.patch ?? origin.suggestion)
        return (
          // S1
          origin.verified === true &&
          // S2
          origin.severity === "blocking" &&
          origin.severityUnreadable !== true &&
          FAILURE_CLASSES.includes(kept.class) &&
          // S3
          anchor.line >= origin.line &&
          anchor.line <= (origin.endLine ?? origin.line) &&
          (anchor.side === "LEFT" || lines.some((line) => touched(anchors, anchor.path, line, 0))) &&
          // S4
          kept.quotes.length > 0 &&
          kept.quotes.every((quote) =>
            quoteMatches(quote, { head: text("RIGHT", quote.path), base: text("LEFT", quote.path) }),
          ) &&
          // S5
          kept.trigger.trim() !== "" &&
          kept.impact.trim() !== "" &&
          Array.from(kept.trigger).length <= MAX_FAILURE_TEXT_CHARS &&
          Array.from(kept.impact).length <= MAX_FAILURE_TEXT_CHARS &&
          // S6
          fixed
        )
      }
    }
    expect([...seen].toSorted()).toEqual([...STRICT_DROPS, "incomplete", ...STRICT_FIX_KINDS].toSorted())
  })
})
