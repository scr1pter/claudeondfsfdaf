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
  preExistingSuspect,
  quoteMatches,
  scopeGateApplies,
  strictBlobRequests,
  strictCandidates,
  strictRules,
  strictSelect,
  type StrictBlob,
  type StrictInput,
} from "@vectordevai/core/review/guardrail"
import { buildSummaryBody } from "@vectordevai/core/review/format"
import { decodeReport, MAX_FAILURE_TEXT_CHARS, strictResultJsonSchema } from "@vectordevai/core/review/schema"
import { gap, MAX_INLINE, NEAR, sameFinding } from "@vectordevai/core/review/select"
import {
  FAILURE_CLASSES,
  FINDING_SCOPES,
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
    expect(strictBlobRequests([entry], anchors, {})).toEqual({
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

// VS-42a's S9, the introduced-by-change check, over the same change. Head line 7 (`store.reset()`) is unchanged, at
// base line 8 since the first hunk removed a line; head line 8 (`store.flush()`) is added; token.ts's line 2 is
// unchanged since old-token.ts. store.ts is outside the diff, here with a base equal to its head.
const GATE = { maxComments: 10, suggestions: true, guardrail: "strict", scopeGate: "introduced" } as const
const RESET_QUOTE: Quote = { path: SESSION, line: 7, side: "RIGHT", code: "  store.reset()" }
const STORE_QUOTE: Quote = { path: "src/auth/store.ts", line: 2, side: "RIGHT", code: "  return store.value" }
const NAME_QUOTE: Quote = { path: "src/auth/token.ts", line: 2, side: "RIGHT", code: 'export const name = "token"' }
const GATED_BLOBS = blobs({}, { "src/auth/store.ts": STORE_HEAD })

function gated(overrides: Partial<StrictInput> = {}): Partial<StrictInput> {
  return { config: GATE, blobs: GATED_BLOBS, ...overrides }
}

// A finding on the added flush line.
function onFlush(overrides: Partial<Finding> = {}) {
  return finding({ line: 8, title: "Flush runs after the store was reset", quotes: [FLUSH_QUOTE], ...overrides })
}

function suspectOf(entry: Finding, source: StrictInput["blobs"] = GATED_BLOBS, files = anchors) {
  return preExistingSuspect(entry, source.head, source.base, files)
}

// What strictSelect's rule pass counts beyond the result: the kept findings S9 could not check.
function uncheckedOf(findings: Finding[], overrides: Partial<StrictInput> = {}) {
  const options = input(overrides)
  return strictRules(strictCandidates(findings, options), {
    maxComments: options.config.maxComments,
    unanswered: options.unanswered,
  }).preExistingUnchecked
}

describe("S9: the introduced-by-change check (VS-42a)", () => {
  test("introduced: a finding that quotes the line the change added is kept", () => {
    for (const scope of [undefined, "introduced", "exacerbated"] as const) {
      const entry = onFlush(scope ? { scope } : {})
      expect(fate(entry, gated())).toBe("kept")
      expect(suspectOf(entry)).toBe(false)
    }
  })

  // The false-drop class S9 accepts by design: it rests on the quotes alone, so the anchor's added line is no evidence.
  // The new flush() may be what misuses the old reset(), or a new call site may break on an unchanged callee, and the
  // finding still drops unless it quotes a changed line. VS-42 wiring's prompt asks every blocking finding to.
  test("a finding on an added line that quotes only unchanged code is a suspect, even when the new line is the defect", () => {
    const sameFile = onFlush({ quotes: [RESET_QUOTE] })
    expect(fate(sameFile)).toBe("kept")
    expect(fate(sameFile, gated())).toBe("pre-existing")
    expect(suspectOf(sameFile)).toBe(true)
    // An unchanged file outside the diff, read at base as written.
    const crossFile = onFlush({ quotes: [STORE_QUOTE] })
    expect(fate(crossFile, gated())).toBe("pre-existing")
    expect(suspectOf(crossFile)).toBe(true)
    // Code that differs from the base is not old code, wherever the diff says it is unchanged.
    const moved = blobs({}, { "src/auth/store.ts": "export function read(store) {\n  return store.cached\n}\n" })
    expect(fate(crossFile, gated({ blobs: moved }))).toBe("kept")
    expect(suspectOf(crossFile, moved)).toBe(false)
    const edited = blobs({}, { [SESSION]: SESSION_BASE.replace("  store.reset()", "  store.clear()") })
    expect(fate(sameFile, gated({ blobs: edited }))).toBe("kept")
    // The base line is the mapped one: head line 7 is base line 8, and base line 7 holds other code.
    expect(SESSION_BASE.split("\n")[7]).toBe("  store.reset()")
    expect(SESSION_HEAD.split("\n")[6]).toBe("  store.reset()")
    // A quote one line from an added line is not on it.
    expect(touched(anchors, SESSION, 7, 0)).toBe(false)
    expect(touched(anchors, SESSION, 7, 1)).toBe(true)
  })

  test("exacerbated: an old latent bug the change makes reachable is kept when a quote is on the changed line", () => {
    const reachable = onFlush({ scope: "exacerbated", quotes: [RESET_QUOTE, FLUSH_QUOTE] })
    expect(fate(reachable, gated())).toBe("kept")
    expect(suspectOf(reachable)).toBe(false)
    const span = onFlush({ quotes: [{ ...RESET_QUOTE, code: "  store.reset()\n  store.flush()" }] })
    expect(fate(span, gated())).toBe("kept")
    // The label alone never saves a suspect (I-2).
    for (const scope of ["exacerbated", "introduced"] as const)
      expect(fate(onFlush({ scope, quotes: [RESET_QUOTE] }), gated())).toBe("pre-existing")
  })

  test("the model's pre-existing label drops a finding the suspect check would keep, under the gate only (I-2)", () => {
    const labelled = onFlush({ scope: "pre-existing" })
    expect(suspectOf(labelled)).toBe(false)
    expect(fate(labelled, gated())).toBe("pre-existing")
    expect(fate(labelled)).toBe("kept")
    expect(fate(labelled, { config: { ...GATE, guardrail: "off" } })).toBe("kept")
    // Even on a deletion defect, which the suspect check exempts.
    const removed = finding({
      side: "LEFT",
      quotes: [GUARD_QUOTE],
      suggestion: undefined,
      patch: GUARD_PATCH,
      scope: "pre-existing",
    })
    expect(fate(removed, gated())).toBe("pre-existing")
  })

  test("a renamed file's base is read at its old path", () => {
    const entry = finding({
      path: "src/auth/token.ts",
      line: 1,
      title: "Token never expires",
      quotes: [NAME_QUOTE],
      suggestion: undefined,
      patch: "x",
    })
    expect(touched(anchors, "src/auth/token.ts", 2, 0)).toBe(false)
    expect(fate(entry)).toBe("kept")
    expect(fate(entry, gated())).toBe("pre-existing")
    expect(suspectOf(entry)).toBe(true)
    expect(strictBlobRequests([entry], anchors, GATE)).toEqual({
      head: ["src/auth/token.ts"],
      base: ["src/auth/old-token.ts"],
    })
    // A base keyed at the head path is not the renamed file's base, so S9 cannot check it and keeps the finding.
    const atHeadPath = { head: GATED_BLOBS.head, base: new Map([["src/auth/token.ts", TOKEN_BASE]]) }
    expect(fate(entry, gated({ blobs: atHeadPath }))).toBe("kept")
    expect(suspectOf(entry, atHeadPath)).toBe(false)
  })

  test("deletion defects are exempt: a LEFT anchor, an anchor only next to a deletion, and a matched base quote", () => {
    const left = finding({ side: "LEFT", quotes: [GUARD_QUOTE], suggestion: undefined, patch: GUARD_PATCH })
    expect(fate(left, gated())).toBe("kept")
    expect(suspectOf(left)).toBe(false)
    // Head line 3 sits next to the removed guard and holds no added line: S3 accepts it as a deletion defect.
    const beside = finding({ quotes: [STORE_QUOTE] })
    expect(fate(beside, gated())).toBe("kept")
    expect(suspectOf(beside)).toBe(false)
    // A base quote that matches is removed code, so the finding rests on the deletion.
    const withGuard = onFlush({ quotes: [RESET_QUOTE, GUARD_QUOTE] })
    expect(fate(withGuard, gated())).toBe("kept")
    expect(suspectOf(withGuard)).toBe(false)
  })

  test("only the quotes S4 matched count: an invented quote never saves a finding nor exempts one (I-2)", () => {
    const invented = onFlush({ quotes: [RESET_QUOTE, { ...FLUSH_QUOTE, code: "  store.flush(true)" }] })
    expect(fate(invented, gated())).toBe("pre-existing")
    expect(suspectOf(invented)).toBe(true)
    const inventedBase = onFlush({ quotes: [RESET_QUOTE, { ...GUARD_QUOTE, code: "  if (!user) return undefined" }] })
    expect(fate(inventedBase, gated())).toBe("pre-existing")
    // Kept quotes are the matched ones, as before.
    expect(run([onFlush({ quotes: [{ ...RESET_QUOTE, line: 1 }, FLUSH_QUOTE] })], gated()).findings[0].quotes).toEqual([
      FLUSH_QUOTE,
    ])
  })

  test("a base S9 cannot read keeps the finding, never marks the result incomplete, and is counted (I-7)", () => {
    const entry = onFlush({ quotes: [RESET_QUOTE] })
    const without = new Map([...GATED_BLOBS.base].filter(([key]) => key !== SESSION))
    // A base the tree lacks holds no old code, so S9 checked the finding; a null or missing one leaves it unchecked.
    for (const [base, unchecked] of [
      [blobs({}, { [SESSION]: null }).base, 1],
      [blobs({}, { [SESSION]: { absent: true } }).base, 0],
      [without, 1],
    ] as const) {
      const source = { head: GATED_BLOBS.head, base }
      expect(run([entry], gated({ blobs: source }))).toMatchObject({
        complete: true,
        findings: [{ id: entry.id }],
        dropped: [],
      })
      expect(suspectOf(entry, source)).toBe(false)
      expect(uncheckedOf([entry], gated({ blobs: source }))).toBe(unchecked)
      // With S9 off, no candidate carries its fact, so nothing is counted.
      expect(uncheckedOf([entry], { blobs: source })).toBe(0)
    }
    // store.ts with no base in the map at all.
    const store = onFlush({ quotes: [STORE_QUOTE] })
    expect(run([store], { config: GATE })).toMatchObject({ complete: true, dropped: [] })
    expect(uncheckedOf([store], { config: GATE })).toBe(1)
    // A checked quote that differs from its base, or one on a changed line, decides the finding whatever the other
    // quote's base: it is not a suspect, and not unchecked.
    const both = onFlush({ quotes: [STORE_QUOTE, RESET_QUOTE] })
    expect(uncheckedOf([both], { config: GATE })).toBe(1)
    const edited = blobs({}, { [SESSION]: SESSION_BASE.replace("  store.reset()", "  store.clear()") })
    expect(uncheckedOf([both], { config: GATE, blobs: edited })).toBe(0)
    expect(uncheckedOf([onFlush({ quotes: [STORE_QUOTE, FLUSH_QUOTE] })], { config: GATE })).toBe(0)
    // Neither is a finding S9 dropped: by the suspect check with its base read, or by the model's label.
    expect(uncheckedOf([entry], gated())).toBe(0)
    expect(uncheckedOf([{ ...store, scope: "pre-existing" }], { config: GATE })).toBe(0)
    // Counted among the kept, after S8, as fixUnchecked is.
    const leak = onFlush({
      quotes: [STORE_QUOTE],
      title: "Flush leaks the handle",
      failure: { ...FAILURE, class: "leak" },
      suggestion: "  store.flush().close()",
    })
    expect(uncheckedOf([store, leak], { config: GATE })).toBe(2)
    expect(uncheckedOf([store, leak], { config: { ...GATE, maxComments: 1 } })).toBe(1)
  })

  test("a file the change added is never a suspect, and its base is never asked for", () => {
    const added = [
      ...anchors,
      ...parseUnifiedDiff(
        [
          "diff --git a/src/auth/fresh.ts b/src/auth/fresh.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/auth/fresh.ts",
          "@@ -0,0 +1,2 @@",
          "+export const a = 1",
          "+export const b = 2",
          "",
        ].join("\n"),
      ),
    ]
    const entry = finding({
      path: "src/auth/fresh.ts",
      line: 1,
      quotes: [{ path: "src/auth/fresh.ts", line: 2, side: "RIGHT", code: "export const b = 2" }],
      suggestion: undefined,
      patch: "x",
    })
    const source = blobs({ "src/auth/fresh.ts": "export const a = 1\nexport const b = 2\n" }, {})
    expect(suspectOf(entry, source, added)).toBe(false)
    expect(strictBlobRequests([entry], added, GATE)).toEqual({ head: ["src/auth/fresh.ts"], base: [] })
    expect(fate(entry, { anchors: added, config: GATE, blobs: source })).toBe("kept")
  })

  test("S9 is checked after S5 and before S6: a suspect's patch is never applied or parsed, and it hides no duplicate", () => {
    const suspect = { quotes: [RESET_QUOTE] }
    expect(fate(onFlush({ ...suspect, failure: { ...FAILURE, impact: "" } }), gated())).toBe("no-impact")
    expect(fate(onFlush({ ...suspect, suggestion: undefined }), gated())).toBe("pre-existing")
    const calls: string[] = []
    const parses = (path: string) => {
      calls.push(path)
      return true
    }
    const patched = onFlush({ ...suspect, suggestion: undefined, patch: GUARD_PATCH })
    expect(run([patched], gated({ parses })).dropped).toEqual([{ reason: "pre-existing", count: 1 }])
    expect(calls).toEqual([])
    run([patched], { blobs: GATED_BLOBS, parses })
    expect(calls.length).toBeGreaterThan(0)
    // The same class within 3 lines: a weaker suspect is counted as pre-existing, not as a duplicate.
    const strong = onFlush({ confidence: 0.95 })
    const weak = onFlush({ ...suspect, confidence: 0.8, title: "Reset discards pending writes" })
    expect(run([strong, weak]).dropped).toEqual([{ reason: "duplicate", count: 1 }])
    expect(run([strong, weak], gated())).toMatchObject({
      findings: [{ id: strong.id }],
      dropped: [{ reason: "pre-existing", count: 1 }],
    })
    // A stronger suspect never hides the introduced finding beside it.
    const loud = onFlush({ ...suspect, confidence: 0.99, title: "Reset discards pending writes" })
    expect(run([loud, strong], gated())).toMatchObject({
      findings: [{ id: strong.id }],
      dropped: [{ reason: "pre-existing", count: 1 }],
    })
    // Listed in rule order.
    expect(
      run(
        [
          onFlush({ ...suspect, suggestion: undefined }),
          onFlush({ suggestion: undefined }),
          onFlush({ failure: { ...FAILURE, trigger: "" } }),
        ],
        gated(),
      ).dropped,
    ).toEqual([
      { reason: "no-impact", count: 1 },
      { reason: "pre-existing", count: 1 },
      { reason: "no-fix", count: 1 },
    ])
  })

  test("set without guardrail: strict, or with scopeGate off, S9 does nothing", () => {
    const entries = [
      onFlush({ quotes: [RESET_QUOTE] }),
      onFlush({
        scope: "pre-existing",
        title: "Flush leaks the handle",
        failure: { ...FAILURE, class: "leak" },
        suggestion: "  store.flush().close()",
      }),
    ]
    const off = run(entries, { blobs: GATED_BLOBS })
    expect(off.dropped).toEqual([])
    for (const config of [
      { maxComments: 10, suggestions: true, scopeGate: "introduced" as const },
      { maxComments: 10, suggestions: true, guardrail: "off" as const, scopeGate: "introduced" as const },
      { maxComments: 10, suggestions: true, guardrail: "strict" as const },
      { maxComments: 10, suggestions: true, guardrail: "strict" as const, scopeGate: "off" as const },
    ]) {
      expect(run(entries, { config, blobs: GATED_BLOBS })).toEqual(off)
      expect(scopeGateApplies(config)).toBe(false)
      expect(strictBlobRequests(entries, anchors, config)).toEqual(strictBlobRequests(entries, anchors, {}))
    }
    expect(scopeGateApplies(GATE)).toBe(true)
    expect(scopeGateApplies({})).toBe(false)
  })

  test("a pre-existing drop conforms to the result schema built for its keys, and only to that one", () => {
    const result = run([onFlush({ quotes: [RESET_QUOTE] })], gated())
    expect(result.dropped).toEqual([{ reason: "pre-existing", count: 1 }])
    expect(violations(strictResultJsonSchema(GATE)!, result)).toEqual([])
    expect(violations(strictResultJsonSchema({ guardrail: "strict" })!, result)).toEqual([
      "$.dropped[0].reason is not in its enum",
    ])
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
    expect(strictBlobRequests(entries, anchors, {})).toEqual({
      head: ["./src/auth/store.ts", SESSION, "src/auth/token.ts"],
      base: ["src/auth/old-token.ts", SESSION],
    })
    const source = blobs()
    const head = new Recording(source.head)
    const base = new Recording(source.base)
    strictSelect(entries, input({ blobs: { head, base } }))
    const asked = strictBlobRequests(entries, anchors, {})
    expect(head.asked.size).toBeGreaterThan(0)
    expect(base.asked.size).toBeGreaterThan(0)
    expect([...head.asked].every((key) => asked.head.includes(key))).toBe(true)
    expect([...base.asked].every((key) => asked.base.includes(key))).toBe(true)
  })

  // VS-42a: under the gate, S9 reads each head quote's file at base too, so the engine must be asked for it; VS-27c
  // passes the same config to both calls.
  test("under scopeGate, also names each head quote's base file, and every one S9 reads", () => {
    const entries = [
      onFlush({ quotes: [RESET_QUOTE, STORE_QUOTE, GUARD_QUOTE, { ...NAME_QUOTE, path: "src/auth/old-token.ts" }] }),
      onFlush({
        quotes: [
          { ...STORE_QUOTE, path: "src/../../etc/passwd" },
          { ...RESET_QUOTE, path: "./src/x.ts" },
        ],
      }),
    ]
    expect(strictBlobRequests(entries, anchors, {})).toEqual({
      head: ["./src/x.ts", SESSION, "src/auth/store.ts", "src/auth/token.ts"],
      base: [SESSION],
    })
    expect(strictBlobRequests(entries, anchors, GATE)).toEqual({
      head: ["./src/x.ts", SESSION, "src/auth/store.ts", "src/auth/token.ts"],
      base: ["./src/x.ts", "src/auth/old-token.ts", SESSION, "src/auth/store.ts"],
    })
    const reads = (findings: Finding[]) => {
      const head = new Recording(GATED_BLOBS.head)
      const base = new Recording(GATED_BLOBS.base)
      strictSelect(findings, input({ config: GATE, blobs: { head, base } }))
      return { head: [...head.asked].toSorted(), base: [...base.asked].toSorted() }
    }
    // Each suspect alone, so every base S9 reads is read before any rule could stop early.
    for (const quote of [RESET_QUOTE, STORE_QUOTE]) {
      const entry = onFlush({ quotes: [quote] })
      const asked = strictBlobRequests([entry], anchors, GATE)
      const read = reads([entry])
      expect(read.base.length).toBeGreaterThan(0)
      expect(read.base.every((key) => asked.base.includes(key))).toBe(true)
      expect(read.head.every((key) => asked.head.includes(key))).toBe(true)
      expect(read.base.every((key) => strictBlobRequests([entry], anchors, {}).base.includes(key))).toBe(false)
    }
    const renamed = finding({
      path: "src/auth/token.ts",
      line: 1,
      quotes: [NAME_QUOTE],
      suggestion: undefined,
      patch: "x",
    })
    expect(reads([renamed]).base).toEqual(["src/auth/old-token.ts"])
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
    expect(strictBlobRequests(entries, anchors, {})).toEqual({ head: [SESSION], base: [] })
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

// Every finding kept satisfies S1 to S5, S7 and S8, S6 in one of its forms, and S9 under the gate, over generated
// candidates; the result conforms to the result schema built for its keys and does not depend on input order, and
// every file the pass reads was named by strictBlobRequests under the same config.
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
      // VS-42a, drawn last so the cases above stay as they were: half the cases run S9, their findings labelled.
      gate: next() < 0.5,
      scopes: Array.from({ length: count }, () => pick([undefined, undefined, ...FINDING_SCOPES])),
      // Drawn after the scopes, so the cases above stay as they were: some gated cases lack store.ts's base.
      storeBase: next() < 0.5,
    }
  }

  test("every kept finding satisfies the rules, over 400 generated cases", () => {
    const index = buildAnchorIndex(anchors)
    // What the generated cases exercised, so the property cannot pass by keeping nothing.
    const seen = new Set<string>()
    for (const seed of Array.from({ length: 400 }, (_, value) => value + 1)) {
      const generated = generate(seed)
      const gate = generated.gate
      const schema = strictResultJsonSchema(gate ? GATE : { guardrail: "strict" })!
      const source = gate && generated.storeBase ? GATED_BLOBS : blobs()
      const text = (side: Quote["side"], path: string) => {
        const blob = (side === "LEFT" ? source.base : source.head).get(path)
        return typeof blob === "string" ? blob : null
      }
      // A gated case without store.ts's base quotes that file in every finding, so S9 meets a base it cannot read.
      const findings = gate
        ? generated.findings.map((entry, position) => {
            const scope = generated.scopes[position]
            const quoted = generated.storeBase ? entry : { ...entry, quotes: [...(entry.quotes ?? []), STORE_QUOTE] }
            return scope ? { ...quoted, scope } : quoted
          })
        : generated.findings
      const options = input({
        config: {
          maxComments: generated.maxComments,
          suggestions: generated.suggestions,
          ...(gate ? { guardrail: "strict" as const, scopeGate: "introduced" as const } : {}),
        },
        blobs: source,
        trust: generated.trust,
        unanswered: generated.unanswered,
        ...(generated.parses ? { parses: generated.parses } : {}),
      })
      const result = strictSelect(findings, options)
      for (const entry of result.dropped) seen.add(entry.reason)
      for (const entry of result.findings) seen.add(entry.fix.kind)
      if (!result.complete) seen.add("incomplete")
      expect(violations(schema, result)).toEqual([])
      expect(result.findings.length + result.dropped.reduce((total, entry) => total + entry.count, 0)).toBe(
        findings.length,
      )
      if (!gate) expect(result.dropped.map((entry) => entry.reason)).not.toContain("pre-existing")
      expect(result.fixUnchecked).toBe(result.findings.filter((entry) => entry.fix.kind === "unchecked").length)
      // S8.
      expect(result.findings.length).toBeLessThanOrEqual(Math.min(MAX_INLINE, generated.maxComments))
      const origins = result.findings.map((kept) => {
        const origin = findings.find(
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
      expect(strictSelect(findings.toReversed(), options)).toEqual(result)
      expect(strictSelect([...findings.slice(1), ...findings.slice(0, 1)], options)).toEqual(result)
      // The same pass over recorded reads: every file it reads was named by strictBlobRequests under the same config,
      // so the engine is asked for each one (VS-27c), and S9's unchecked count is the kept findings that store.ts's
      // base, when it is missing, would have made suspects.
      const head = new Recording(source.head)
      const base = new Recording(source.base)
      const pass = strictRules(strictCandidates(findings, { ...options, blobs: { head, base } }), {
        maxComments: options.config.maxComments,
        unanswered: options.unanswered,
      })
      expect(pass.kept.map((entry) => entry.finding.id)).toEqual(result.findings.map((entry) => entry.id))
      const asked = strictBlobRequests(findings, anchors, options.config)
      expect([...head.asked].filter((key) => !asked.head.includes(key))).toEqual([])
      expect([...base.asked].filter((key) => !asked.base.includes(key))).toEqual([])
      expect(pass.preExistingUnchecked).toBe(
        gate
          ? origins.filter((origin) => preExistingSuspect(origin, source.head, GATED_BLOBS.base, anchors)).length
          : 0,
      )
      if (pass.preExistingUnchecked) seen.add("pre-existing-unchecked")

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
          fixed &&
          // S9
          !(gate && (origin.scope === "pre-existing" || preExistingSuspect(origin, source.head, source.base, anchors)))
        )
      }
    }
    expect([...seen].toSorted()).toEqual(
      [...STRICT_DROPS, "incomplete", ...STRICT_FIX_KINDS, "pre-existing-unchecked"].toSorted(),
    )
  })

  // S9 drops an unlabelled finding exactly when preExistingSuspect holds and S1 to S5 kept it; every other finding has
  // the fate it has with the gate off.
  test("preExistingSuspect agrees with strictSelect's pre-existing drops on unlabelled findings", () => {
    const lone = (entry: Finding, config: StrictInput["config"]) => {
      const result = strictSelect([entry], input({ config, blobs: GATED_BLOBS }))
      return result.findings.length ? "kept" : result.dropped[0].reason
    }
    const fates = Array.from({ length: 150 }, (_, seed) => generate(seed + 1).findings)
      .flat()
      .map((entry) => ({
        off: lone(entry, { maxComments: 10, suggestions: true }),
        on: lone(entry, GATE),
        suspect: preExistingSuspect(entry, GATED_BLOBS.head, GATED_BLOBS.base, anchors),
      }))
    for (const fate of fates)
      expect(fate.on).toBe(fate.suspect && (fate.off === "kept" || fate.off === "no-fix") ? "pre-existing" : fate.off)
    expect(fates.some((fate) => fate.on === "pre-existing")).toBe(true)
    expect(fates.some((fate) => fate.on === "kept")).toBe(true)
    // Suspects that an earlier rule drops keep that rule's reason.
    expect(fates.some((fate) => fate.suspect && fate.on !== "pre-existing")).toBe(true)
  })
})
