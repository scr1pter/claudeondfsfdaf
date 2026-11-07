import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  decodeReport,
  decodeVerify,
  extractJson,
  MAX_FAILURE_TEXT_CHARS,
  MAX_FINDING_QUOTES,
  MAX_QUOTES_READ,
  MAX_QUOTE_CHARS,
  MAX_QUOTE_LINES,
  MAX_REPORT_FINDINGS,
  MAX_SUGGESTION_CHARS,
  MAX_TITLE_CHARS,
  REVIEW_REPORT_JSON_SCHEMA,
  strictReportJsonSchema,
  strictResultJsonSchema,
  VERIFY_JSON_SCHEMA,
} from "@vectordevai/core/review/schema"
import {
  CATEGORIES,
  FAILURE_CLASSES,
  FAILURE_MECHANISMS,
  FINDING_SCOPES,
  SEVERITIES,
  STRICT_DROPS,
  STRICT_FIX_KINDS,
  VERIFIED_BY,
  type StrictFinding,
  type StrictResult,
} from "@vectordevai/core/review/types"
import { isRecord, violations } from "./fixtures/json-schema"

// Every key used anywhere in a schema, at any depth.
function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys)
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)])
}

describe("schemas", () => {
  const finding = REVIEW_REPORT_JSON_SCHEMA.properties.findings.items

  test("the finding enums equal SEVERITIES and CATEGORIES", () => {
    expect(finding.properties.severity.enum).toEqual([...SEVERITIES])
    expect(finding.properties.category.enum).toEqual([...CATEGORIES])
    expect(finding.properties.side.enum).toEqual(["RIGHT", "LEFT"])
    expect(REVIEW_REPORT_JSON_SCHEMA.properties.risk.enum).toEqual(["low", "medium", "high"])
  })

  test("the finding shape and its required fields", () => {
    expect(finding.required).toEqual(["path", "line", "severity", "category", "title", "body", "confidence"])
    expect(finding.properties.line).toMatchObject({ type: "integer", minimum: 1 })
    expect(finding.properties.title.maxLength).toBe(100)
    expect(finding.properties.confidence).toMatchObject({ minimum: 0, maximum: 1 })
    expect(Object.keys(finding.properties)).toContain("duplicateOf")
    expect(REVIEW_REPORT_JSON_SCHEMA.properties.priorStatus.items.properties.status.enum).toEqual(["fixed", "open"])
  })

  test("uses only conservative JSON Schema", () => {
    for (const schema of [REVIEW_REPORT_JSON_SCHEMA, VERIFY_JSON_SCHEMA]) {
      const used = keys(schema)
      expect(used).not.toContain("anyOf")
      expect(used).not.toContain("oneOf")
      expect(used).not.toContain("$ref")
      expect(used).not.toContain("additionalProperties")
    }
  })

  test("the verify schema", () => {
    const result = VERIFY_JSON_SCHEMA.properties.results.items
    expect(result.properties.verdict.enum).toEqual(["confirmed", "rejected"])
    expect(result.required).toEqual(["id", "verdict", "reason"])
  })
})

describe("extractJson", () => {
  test("recovers a fenced block, with or without a language", () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```\nDone.')).toEqual({ a: 1 })
    expect(extractJson('```\n{"b":2}\n```')).toEqual({ b: 2 })
  })

  test("skips a fence that is not JSON", () => {
    expect(extractJson('```ts\nconst x = 1\n```\n```json\n{"c":3}\n```')).toEqual({ c: 3 })
  })

  test("recovers the outermost object from prose, even with a fence inside a string", () => {
    const text = 'Result: {"summary":"ok","findings":[{"suggestion":"```js\\nx\\n```"}]} (end)'
    expect(extractJson(text)).toEqual({ summary: "ok", findings: [{ suggestion: "```js\nx\n```" }] })
  })

  test("returns undefined when nothing parses to an object", () => {
    expect(extractJson("no json here")).toBeUndefined()
    expect(extractJson("42")).toBeUndefined()
    expect(extractJson("{ broken")).toBeUndefined()
  })
})

describe("decodeReport", () => {
  test("decodes a well-formed report", () => {
    const report = decodeReport({
      summary: "Adds rotation.",
      risk: "medium",
      files: [{ path: "src/a.ts", note: "rotation loop" }],
      findings: [
        {
          path: "src/a.ts",
          line: 52,
          endLine: 54,
          side: "RIGHT",
          severity: "blocking",
          category: "bug",
          title: "Refresh can restore a session after logout",
          body: "Explained.",
          suggestion: "    if (x) return",
          confidence: 0.86,
          evidence: ["src/auth/client.ts:31"],
          rule: "Auth state changes must be race-free",
          duplicateOf: "3f9a1c07be21",
        },
      ],
      priorStatus: [{ id: "abcdefabcdef", status: "fixed", reason: "the guard was added" }],
    })
    expect(report).toEqual({
      summary: "Adds rotation.",
      risk: "medium",
      files: [{ path: "src/a.ts", note: "rotation loop" }],
      findings: [
        {
          path: "src/a.ts",
          line: 52,
          endLine: 54,
          side: "RIGHT",
          severity: "blocking",
          category: "bug",
          title: "Refresh can restore a session after logout",
          body: "Explained.",
          suggestion: "    if (x) return",
          confidence: 0.86,
          evidence: ["src/auth/client.ts:31"],
          rule: "Auth state changes must be race-free",
          duplicateOf: "3f9a1c07be21",
        },
      ],
      priorStatus: [{ id: "abcdefabcdef", status: "fixed", reason: "the guard was added" }],
    })
  })

  test("is lenient about sides, enums, numbers and paths", () => {
    const report = decodeReport({
      summary: "s",
      risk: "extreme",
      findings: [
        {
          path: "./src/a.ts",
          line: "52",
          severity: "critical",
          category: "correctness",
          title: "A",
          body: "b",
          confidence: "0.8",
        },
        { path: "src/b.ts", line: 3, side: "left", severity: "NIT", category: "Style", title: "B", confidence: 85 },
        {
          path: "src/c.ts",
          line: "L7",
          endLine: 7,
          severity: "concern",
          category: "tests",
          title: "C",
          confidence: 2.5e3,
        },
        { path: "src/d.ts", line: 0, severity: "concern", category: "docs", title: "D", confidence: -1 },
        { path: "src/e.ts", severity: "concern", category: "bug", title: "E" },
      ],
    })
    expect(report?.risk).toBe("low")
    expect(
      report?.findings.map((f) => [f.path, f.line, f.endLine, f.side, f.severity, f.category, f.confidence]),
    ).toEqual([
      ["src/a.ts", 52, undefined, "RIGHT", "concern", "bug", 0.8],
      ["src/b.ts", 3, undefined, "LEFT", "nit", "style", 0.85],
      ["src/c.ts", 7, undefined, "RIGHT", "concern", "tests", 1],
      ["src/d.ts", 1, undefined, "RIGHT", "concern", "docs", 0],
      ["src/e.ts", 1, undefined, "RIGHT", "concern", "bug", 0.5],
    ])
    expect(report?.files).toEqual([])
  })

  test("drops findings without a path or a title, and clamps the title", () => {
    const report = decodeReport({
      summary: "s",
      findings: [
        { line: 1, title: "no path", severity: "nit", category: "bug", confidence: 1 },
        { path: "src/a.ts", line: 1, title: "   ", severity: "nit", category: "bug", confidence: 1 },
        { path: "src/a.ts", line: 1, title: `  ${"x".repeat(150)}\n`, severity: "nit", category: "bug", confidence: 1 },
        "not an object",
      ],
    })
    expect(report?.findings).toHaveLength(1)
    expect(report?.findings[0]?.title).toBe("x".repeat(100))
  })

  test("cleans suggestions but keeps their indentation", () => {
    const decode = (suggestion: unknown) =>
      decodeReport({
        summary: "s",
        findings: [{ path: "a.ts", line: 1, title: "t", severity: "nit", category: "bug", confidence: 1, suggestion }],
      })?.findings[0]?.suggestion
    expect(decode("```ts\n    return x\n```")).toBe("    return x")
    expect(decode("\n    return x\n\n")).toBe("    return x")
    expect(decode("\treturn x\r\n\treturn y")).toBe("\treturn x\n\treturn y")
    expect(decode("   \n  ")).toBeUndefined()
    expect(decode(42)).toBeUndefined()
  })

  test("keeps only valid priorStatus entries", () => {
    const report = decodeReport({
      summary: "s",
      findings: [],
      priorStatus: [
        { id: "a", status: "FIXED", reason: "yes" },
        { id: "b", status: "maybe", reason: "?" },
        { status: "open", reason: "no id" },
      ],
    })
    expect(report?.priorStatus).toEqual([{ id: "a", status: "fixed", reason: "yes" }])
  })

  test("decodes text, and returns undefined when there is no report", () => {
    expect(decodeReport('```json\n{"summary":"from text","findings":[]}\n```')?.summary).toBe("from text")
    expect(decodeReport({ findings: [] })).toEqual({ summary: "", risk: "low", files: [], findings: [] })
    expect(decodeReport({ note: "nothing" })).toBeUndefined()
    expect(decodeReport("plain text")).toBeUndefined()
    expect(decodeReport(null)).toBeUndefined()
    expect(decodeReport([{ summary: "array" }])).toBeUndefined()
  })

  test("finds the report after an unrelated JSON fence", () => {
    const output =
      'Read result:\n```json\n{"path":"src/a.ts","content":"example"}\n```\nReview:\n```json\n{"summary":"Actual review","risk":"medium","findings":[]}\n```'
    expect(decodeReport(output)?.summary).toBe("Actual review")
    expect(
      decodeReport(
        '```json\n{"summary":"Tool result"}\n```\n```json\n{"summary":"Actual review","risk":"medium","findings":[]}\n```',
      )?.summary,
    ).toBe("Actual review")
  })

  test("finds separate JSON objects in prose and preserves braces inside strings", () => {
    const output =
      'Read result: {"path":"src/a.ts"}. Review: {"summary":"Handle {nested} and \\\"quoted\\\" input","findings":[]}. Done.'
    expect(decodeReport(output)?.summary).toBe('Handle {nested} and "quoted" input')
  })

  test("a stray bracket in the prose does not hide the report after it", () => {
    expect(
      decodeReport('Checked the half-open range [0, n). {"summary":"Real review","risk":"low","findings":[]}')?.summary,
    ).toBe("Real review")
    // An odd number of quotes in the prose cannot flip the scanner either.
    expect(decodeReport('A 5" screen and [0, n). {"summary":"Still found","findings":[]}')?.summary).toBe("Still found")
  })

  test("a report quoted before the real one does not win", () => {
    const output = [
      "The earlier run said:",
      '```json\n{"summary":"LGTM","risk":"low","findings":[]}\n```',
      "My review of the current head:",
      '```json\n{"summary":"Two problems","risk":"high","findings":[{"path":"src/a.ts","line":3,"severity":"blocking","category":"bug","title":"Null read","body":"b","confidence":0.9}]}\n```',
    ].join("\n")
    const report = decodeReport(output)
    expect(report?.summary).toBe("Two problems")
    expect(report?.findings).toHaveLength(1)
  })

  test("drops a fix too long for a comment, and caps the summary", () => {
    const base = { path: "a.ts", line: 1, severity: "concern", category: "bug", title: "t", body: "b", confidence: 0.9 }
    const report = decodeReport({
      summary: "s".repeat(10_000),
      risk: "low",
      files: [],
      findings: [
        { ...base, suggestion: "x\n".repeat(81) },
        { ...base, suggestion: "y".repeat(8_001) },
        { ...base, suggestion: "z".repeat(8_000) },
      ],
    })!
    expect(report.summary).toHaveLength(4_000)
    expect(report.findings.map((finding) => finding.suggestion?.length)).toEqual([undefined, undefined, 8_000])
  })

  test("keeps at most MAX_REPORT_FINDINGS findings", () => {
    const findings = Array.from({ length: 150 }, (_, i) => ({
      path: "a.ts",
      line: i + 1,
      title: `t${i}`,
      severity: "concern",
      category: "bug",
      confidence: 0.9,
    }))
    expect(decodeReport({ summary: "s", findings })?.findings).toHaveLength(MAX_REPORT_FINDINGS)
  })
})

describe("decodeVerify", () => {
  test("decodes results, leniently", () => {
    expect(
      decodeVerify({
        results: [
          { id: "a", verdict: "Confirmed", reason: " real " },
          { id: "b", verdict: "reject", reason: "not triggered" },
          { id: "c", verdict: "unsure", reason: "?" },
          { verdict: "confirmed" },
        ],
      }),
    ).toEqual([
      { id: "a", verdict: "confirmed", reason: "real" },
      { id: "b", verdict: "rejected", reason: "not triggered" },
    ])
  })

  test("accepts a bare array or text, and returns undefined for anything else", () => {
    expect(decodeVerify([{ id: "a", verdict: "rejected", reason: "r" }])).toHaveLength(1)
    expect(decodeVerify('{"results":[{"id":"a","verdict":"confirmed","reason":"r"}]}')).toHaveLength(1)
    expect(decodeVerify({ summary: "no results" })).toBeUndefined()
    expect(decodeVerify("nothing")).toBeUndefined()
  })

  test("unrelated JSON never reads as an empty set of verdicts", () => {
    expect(decodeVerify('Files I read: {"results":["src/a.ts","src/b.ts"]}')).toBeUndefined()
    expect(decodeVerify('{"results":[{"path":"src/a.ts"}]}')).toBeUndefined()
  })

  test("finds verification results after unrelated JSON", () => {
    expect(
      decodeVerify(
        '```json\n{"path":"src/a.ts"}\n```\n```json\n{"results":[{"id":"a","verdict":"confirmed","reason":"Read the caller"}]}\n```',
      ),
    ).toEqual([{ id: "a", verdict: "confirmed", reason: "Read the caller" }])
    expect(decodeVerify('Results: [{"id":"a","verdict":"rejected","reason":"Not reachable"}] Done.')).toEqual([
      { id: "a", verdict: "rejected", reason: "Not reachable" },
    ])
    expect(
      decodeVerify(
        '```json\n["src/a.ts"]\n```\n```json\n{"results":[{"id":"a","verdict":"confirmed","reason":"Read the caller"}]}\n```',
      ),
    ).toEqual([{ id: "a", verdict: "confirmed", reason: "Read the caller" }])
  })
})

// VS-27a: the strict schemas and the strict decoding they go with. Nothing asks for either before VS-27c.

const STRICT = { guardrail: "strict" } as const

// The keywords a schema uses, read only at schema positions: the names under `properties` are property names, so only
// their values are walked, and `items` is one schema.
function keywords(schema: unknown): string[] {
  if (!isRecord(schema)) return []
  return Object.entries(schema).flatMap(([key, value]) => [
    key,
    ...(key === "properties" && isRecord(value) ? Object.values(value).flatMap(keywords) : []),
    ...(key === "items" ? keywords(value) : []),
  ])
}

// Every field set, so a field added to the type without the schema, or the other way round, fails below.
const STRICT_FINDING: Required<StrictFinding> = {
  id: "3f9a1c07be21",
  class: "crash",
  mechanism: "logic",
  path: "src/auth/client.ts",
  line: 52,
  endLine: 54,
  side: "RIGHT",
  title: "Refresh reads a session that logout cleared",
  trigger: "Logging out while a token refresh is in flight.",
  impact: "The refresh handler throws on a null session and the tab crashes.",
  quotes: [{ path: "src/auth/client.ts", line: 52, side: "RIGHT", code: "  return session.user.id" }],
  fix: { kind: "suggestion", text: "  return session?.user.id" },
  verifiedBy: "model",
  verifier: "acme/large",
}
const STRICT_RESULT: Required<StrictResult> = {
  version: 1,
  head: "a".repeat(40),
  complete: false,
  incomplete: ["verdict-unreadable"],
  findings: [STRICT_FINDING],
  dropped: [{ reason: "not-blocking", count: 2 }],
  fixUnchecked: 0,
}

describe("the strict schemas (VS-27a)", () => {
  test("exist only under guardrail: strict", () => {
    // VS-42's scopeGate is ignored without strict, by the schemas as by the guardrail.
    for (const keys of [
      {},
      { guardrail: "off" as const },
      { guardrail: undefined },
      { scopeGate: "introduced" as const },
      { guardrail: "off" as const, scopeGate: "introduced" as const },
    ]) {
      expect(strictReportJsonSchema(keys)).toBeUndefined()
      expect(strictResultJsonSchema(keys)).toBeUndefined()
    }
    expect(strictReportJsonSchema(STRICT)).toBeDefined()
    expect(strictResultJsonSchema(STRICT)).toBeDefined()
  })

  test("the constants are the contract's lists, in its order", () => {
    expect([...FAILURE_CLASSES]).toEqual(["crash", "data-corruption", "leak", "runaway-loop", "auth-bypass"])
    expect([...FAILURE_MECHANISMS]).toEqual(["logic", "concurrency", "regression", "resource", "access"])
    expect([...VERIFIED_BY]).toEqual(["model", "runtime"])
    expect([...STRICT_FIX_KINDS]).toEqual(["suggestion", "patch", "unchecked"])
    // VS-27b added severity-unreadable and checks S2's severity half before its class half. VS-42 added pre-existing,
    // checked after S5 and before S6.
    expect([...STRICT_DROPS]).toEqual([
      "unverified",
      "verdict-unreadable",
      "severity-unreadable",
      "not-blocking",
      "out-of-scope",
      "anchor",
      "quote-mismatch",
      "no-impact",
      "pre-existing",
      "no-fix",
      "duplicate",
      "cap",
    ])
  })

  test("the strict report schema is the legacy one with failure, quotes and patch added to a finding", () => {
    const strict = strictReportJsonSchema(STRICT)!
    const legacy = REVIEW_REPORT_JSON_SCHEMA.properties.findings.items
    const finding = strict.properties.findings.items
    expect(Object.keys(finding.properties)).toEqual([...Object.keys(legacy.properties), "failure", "quotes", "patch"])
    expect({ ...finding, properties: legacy.properties }).toEqual(legacy)
    expect({
      ...strict,
      properties: { ...strict.properties, findings: REVIEW_REPORT_JSON_SCHEMA.properties.findings },
    }).toEqual(REVIEW_REPORT_JSON_SCHEMA)
    // The required list stays the legacy one: the rules, not the schema, require the strict fields on blocking findings.
    expect(finding.required).toEqual(legacy.required)
    expect(finding.properties.failure.required).toEqual(["class", "mechanism", "trigger", "impact"])
    expect(finding.properties.failure.properties.class.enum).toEqual([...FAILURE_CLASSES])
    expect(finding.properties.failure.properties.mechanism.enum).toEqual([...FAILURE_MECHANISMS])
    expect(finding.properties.failure.properties.trigger.maxLength).toBe(MAX_FAILURE_TEXT_CHARS)
    expect(finding.properties.failure.properties.impact.maxLength).toBe(MAX_FAILURE_TEXT_CHARS)
    expect(finding.properties.quotes.items.required).toEqual(["path", "line", "side", "code"])
    expect(finding.properties.quotes.items.properties.side.enum).toEqual(["RIGHT", "LEFT"])
    expect(finding.properties.quotes.items.properties.line).toMatchObject({ type: "integer", minimum: 1 })
    expect(finding.properties.quotes.items.properties.code.maxLength).toBe(MAX_QUOTE_CHARS)
    expect(finding.properties.quotes.description).toContain(`up to ${MAX_FINDING_QUOTES} quotes`)
    expect(finding.properties.patch).toMatchObject({ type: "string", maxLength: MAX_SUGGESTION_CHARS })
  })

  test("shares no object with the legacy schema or with another call", () => {
    const strict = strictReportJsonSchema(STRICT)!
    strict.properties.findings.items.properties.path.description = "changed"
    strict.properties.findings.items.required.push("failure")
    strict.required.push("extra")
    expect(REVIEW_REPORT_JSON_SCHEMA.properties.findings.items.properties.path.description).toBe(
      "Repository-relative path.",
    )
    expect(REVIEW_REPORT_JSON_SCHEMA.properties.findings.items.required).not.toContain("failure")
    expect(REVIEW_REPORT_JSON_SCHEMA.required).toEqual(["summary", "risk", "files", "findings"])
    expect(strictReportJsonSchema(STRICT)).toEqual(strictReportJsonSchema(STRICT))
    expect(strictReportJsonSchema(STRICT)).not.toBe(strictReportJsonSchema(STRICT))
    expect(strictReportJsonSchema(STRICT)!.properties.findings.items.properties.quotes.items).not.toBe(
      strictResultJsonSchema(STRICT)!.properties.findings.items.properties.quotes.items,
    )
  })

  test("use only conservative JSON Schema keywords, and the report schema no keyword the legacy one lacks", () => {
    const allowed = [
      "type",
      "properties",
      "required",
      "items",
      "enum",
      "minimum",
      "maximum",
      "maxItems",
      "minItems",
      "maxLength",
      "description",
    ]
    const schemas = [
      REVIEW_REPORT_JSON_SCHEMA,
      VERIFY_JSON_SCHEMA,
      strictReportJsonSchema(STRICT),
      strictResultJsonSchema(STRICT),
    ]
    for (const schema of schemas) expect(keywords(schema).filter((key) => !allowed.includes(key))).toEqual([])
    // The report schema goes to providers in a forced tool call, so it sends only the keywords it already sends.
    const used = (schema: unknown) => [...new Set(keywords(schema))].toSorted()
    expect(used(strictReportJsonSchema(STRICT))).toEqual(used(REVIEW_REPORT_JSON_SCHEMA))
    expect(used(strictReportJsonSchema(STRICT))).not.toContain("maxItems")
  })

  test("the result schema names every StrictResult and StrictFinding field, with the type's enums", () => {
    const result = strictResultJsonSchema(STRICT)!
    const finding = result.properties.findings.items
    expect(Object.keys(result.properties)).toEqual(Object.keys(STRICT_RESULT))
    expect(result.required).toEqual(Object.keys(STRICT_RESULT).filter((key) => key !== "incomplete"))
    expect(Object.keys(finding.properties)).toEqual(Object.keys(STRICT_FINDING))
    expect(finding.required).toEqual(Object.keys(STRICT_FINDING).filter((key) => key !== "endLine"))
    expect(result.properties.version.enum).toEqual([1])
    expect(finding.properties.class.enum).toEqual([...FAILURE_CLASSES])
    expect(finding.properties.mechanism.enum).toEqual([...FAILURE_MECHANISMS])
    expect(finding.properties.side.enum).toEqual(["RIGHT", "LEFT"])
    expect(finding.properties.fix.properties.kind.enum).toEqual([...STRICT_FIX_KINDS])
    expect(finding.properties.verifiedBy.enum).toEqual([...VERIFIED_BY])
    expect(finding.properties.title.maxLength).toBe(MAX_TITLE_CHARS)
    expect(finding.properties.quotes).toMatchObject({ minItems: 1, maxItems: MAX_FINDING_QUOTES })
    // VS-42's pre-existing joins the enum only under scopeGate (below).
    expect(result.properties.dropped.items.properties.reason.enum).toEqual(
      STRICT_DROPS.filter((reason) => reason !== "pre-existing"),
    )
    expect(result.properties.dropped.items.properties.count.minimum).toBe(1)
    expect(result.properties.fixUnchecked.minimum).toBe(0)
  })

  test("a StrictResult conforms to the result schema, and a malformed one does not", () => {
    const schema = strictResultJsonSchema(STRICT)!
    expect(violations(schema, STRICT_RESULT)).toEqual([])
    const bare: StrictResult = {
      version: 1,
      head: "b".repeat(40),
      complete: true,
      findings: [],
      dropped: [],
      fixUnchecked: 0,
    }
    expect(violations(schema, bare)).toEqual([])
    const broken = (change: Record<string, unknown>, finding: Record<string, unknown> = {}) =>
      violations(schema, { ...STRICT_RESULT, ...change, findings: [{ ...STRICT_FINDING, ...finding }] })
    expect(broken({ version: 2 })).toEqual(["$.version is not in its enum"])
    expect(broken({ dropped: [{ reason: "not-blocking", count: 0 }] })).toEqual([
      "$.dropped[0].count is under its minimum",
    ])
    // A later package's drop is not in the base list.
    expect(broken({ dropped: [{ reason: "pre-existing", count: 1 }] })).toEqual([
      "$.dropped[0].reason is not in its enum",
    ])
    expect(broken({ fixUnchecked: -1 })).toEqual(["$.fixUnchecked is under its minimum"])
    expect(broken({ complete: "yes" })).toEqual(["$.complete is not boolean"])
    expect(broken({}, { class: "other" })).toEqual(["$.findings[0].class is not in its enum"])
    expect(broken({}, { quotes: [] })).toEqual(["$.findings[0].quotes has too few items"])
    expect(broken({}, { quotes: Array.from({ length: 7 }, () => STRICT_FINDING.quotes[0]) })).toEqual([
      "$.findings[0].quotes has too many items",
    ])
    expect(broken({}, { line: 0 })).toEqual(["$.findings[0].line is under its minimum"])
    expect(broken({}, { line: 1.5 })).toEqual(["$.findings[0].line is not integer"])
    expect(broken({}, { trigger: "t".repeat(MAX_FAILURE_TEXT_CHARS + 1) })).toEqual([
      "$.findings[0].trigger is too long",
    ])
    expect(broken({}, { fix: { kind: "none", text: "x" } })).toEqual(["$.findings[0].fix.kind is not in its enum"])
    expect(broken({}, { verifiedBy: "human" })).toEqual(["$.findings[0].verifiedBy is not in its enum"])
    const { verifier: _, ...unverified } = STRICT_FINDING
    expect(violations(schema, { ...STRICT_RESULT, findings: [unverified] })).toEqual(["$.findings[0] lacks verifier"])
  })

  // VS-42a: under scopeGate "introduced" the result schema's drop enum gains pre-existing, and nothing else changes; the
  // report schema's `scope` field and its decoding wait for VS-42 wiring, with VS-27c.
  test("VS-42's scopeGate adds only the pre-existing drop, and changes neither the report schema nor the decoder", () => {
    const GATE = { guardrail: "strict", scopeGate: "introduced" } as const
    const gated = strictResultJsonSchema(GATE)!
    const plain = strictResultJsonSchema(STRICT)!
    expect(gated.properties.dropped.items.properties.reason.enum).toEqual([...STRICT_DROPS])
    expect({
      ...gated,
      properties: {
        ...gated.properties,
        dropped: plain.properties.dropped,
      },
    }).toEqual(plain)
    expect(strictResultJsonSchema({ guardrail: "strict", scopeGate: "off" })).toEqual(plain)
    expect(strictReportJsonSchema(GATE)).toEqual(strictReportJsonSchema(STRICT))
    const dropped = { ...STRICT_RESULT, dropped: [{ reason: "pre-existing", count: 1 }] }
    expect(violations(gated, dropped)).toEqual([])
    expect(violations(plain, dropped)).toEqual(["$.dropped[0].reason is not in its enum"])
    expect([...FINDING_SCOPES]).toEqual(["introduced", "exacerbated", "pre-existing"])
    // A model's scope label is not read before VS-42 wiring, under any keys.
    const report = {
      summary: "s",
      findings: [
        {
          path: "src/a.ts",
          line: 3,
          severity: "blocking",
          category: "bug",
          title: "Null read",
          body: "b",
          confidence: 0.9,
          scope: "pre-existing",
        },
      ],
    }
    const decoded = decodeReport(report, GATE)!
    expect(decoded).toEqual(decodeReport(report, STRICT)!)
    expect(Object.hasOwn(decoded.findings[0], "scope")).toBe(false)
    expect(Object.hasOwn(decodeReport(report)!.findings[0], "scope")).toBe(false)
  })

  test("a strict finding conforms to the strict report schema, and a legacy one still does", () => {
    const schema = strictReportJsonSchema(STRICT)!
    const legacy = {
      path: "src/a.ts",
      line: 3,
      severity: "blocking",
      category: "bug",
      title: "Null read",
      body: "b",
      confidence: 0.9,
    }
    const report = (finding: Record<string, unknown>) => ({ summary: "s", risk: "low", files: [], findings: [finding] })
    const failure = { class: "crash", mechanism: "logic", trigger: "t", impact: "i" }
    const quote = { path: "src/a.ts", line: 3, side: "RIGHT", code: "x" }
    expect(violations(schema, report(legacy))).toEqual([])
    expect(violations(schema, report({ ...legacy, failure, quotes: [quote], patch: "--- a" }))).toEqual([])
    expect(violations(schema, report({ ...legacy, failure: { ...failure, class: "other" } }))).toEqual([
      "$.findings[0].failure.class is not in its enum",
    ])
    expect(
      violations(schema, report({ ...legacy, quotes: [{ ...quote, code: "x".repeat(MAX_QUOTE_CHARS + 1) }] })),
    ).toEqual(["$.findings[0].quotes[0].code is too long"])
    expect(violations(schema, report({ ...legacy, failure: { class: "crash" } }))).toEqual([
      "$.findings[0].failure lacks mechanism",
      "$.findings[0].failure lacks trigger",
      "$.findings[0].failure lacks impact",
    ])
  })

  test("types.ts stays import-free", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "..", "..", "src", "review", "types.ts")).text()
    expect(source).not.toMatch(/^\s*(import\b|export\b[^\n]*\bfrom\s*["'])/m)
    expect(source).not.toMatch(/\brequire\s*\(|\bimport\s*\(/)
    // The matcher is anchored: prose that says "from" is not an import.
    expect(source).toContain("copied out of a file")
  })
})

describe("decodeReport under guardrail: strict (VS-27a)", () => {
  const base = {
    path: "src/a.ts",
    line: 12,
    severity: "blocking",
    category: "bug",
    title: "Null read",
    body: "b",
    confidence: 0.9,
  }
  const failure = {
    class: "crash",
    mechanism: "logic",
    trigger: "Logging out mid-refresh.",
    impact: "The tab crashes.",
  } as const
  const quote = { path: "src/a.ts", line: 12, side: "RIGHT", code: "  return session.user.id" } as const
  const patch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -12 +12 @@\n-  return session.user.id\n+  return session?.user.id"
  const decode = (fields: Record<string, unknown>) =>
    decodeReport({ summary: "s", findings: [{ ...base, ...fields }] }, STRICT)?.findings[0]
  const quotesOf = (...quotes: unknown[]) => decode({ quotes })?.quotes

  test("without the key, failure, quotes and patch are ignored, as before VS-27a", () => {
    const legacy = decodeReport({ summary: "s", findings: [base] })
    const fields = { ...base, failure, quotes: [quote], patch }
    for (const keys of [undefined, {}, { guardrail: "off" as const }]) {
      expect(decodeReport({ summary: "s", findings: [fields] }, keys)).toEqual(legacy)
      expect(decodeReport(JSON.stringify({ summary: "s", findings: [fields] }), keys)).toEqual(legacy)
    }
    expect(decodeReport({ summary: "s", findings: [fields] })).toEqual(legacy)
  })

  test("reads them after every legacy field, which decode as before", () => {
    const legacy = decodeReport({ summary: "s", findings: [base] })!.findings[0]
    const strict = decode({ failure, quotes: [quote], patch })!
    expect(strict).toEqual({ ...legacy, failure, quotes: [quote], patch })
    expect(Object.keys(strict).slice(-3)).toEqual(["failure", "quotes", "patch"])
    expect(decode({})).toEqual(legacy)
    expect(
      decodeReport(
        `Review:\n\`\`\`json\n${JSON.stringify({ summary: "s", findings: [{ ...base, failure }] })}\n\`\`\``,
        STRICT,
      )?.findings[0]?.failure,
    ).toEqual(failure)
  })

  test("a failure needs a class and a mechanism its enums name", () => {
    const read = (value: unknown) => decode({ failure: value })?.failure
    expect(read({ ...failure, class: "Data Corruption", mechanism: " LOGIC " })).toMatchObject({
      class: "data-corruption",
      mechanism: "logic",
    })
    expect(read({ ...failure, class: "runaway_loop", mechanism: "Concurrency" })).toMatchObject({
      class: "runaway-loop",
      mechanism: "concurrency",
    })
    expect(read({ ...failure, class: "AUTH-BYPASS" })?.class).toBe("auth-bypass")
    for (const value of [
      { ...failure, class: "other" },
      { ...failure, class: "memory-leak" },
      { ...failure, mechanism: "race" },
      { mechanism: "logic", trigger: "t", impact: "i" },
      { class: "crash", trigger: "t", impact: "i" },
      "crash",
      ["crash", "logic"],
      null,
    ])
      expect(read(value)).toBeUndefined()
    expect(Object.hasOwn(decode({ failure: { class: "other" } })!, "failure")).toBe(false)
  })

  test("trigger and impact are kept whole, even empty, for S5 to judge", () => {
    const long = "x".repeat(MAX_FAILURE_TEXT_CHARS + 100)
    expect(decode({ failure: { ...failure, trigger: "  spans\n two   lines ", impact: long } })?.failure).toEqual({
      class: "crash",
      mechanism: "logic",
      trigger: "spans two lines",
      impact: long,
    })
    expect(decode({ failure: { class: "crash", mechanism: "logic" } })?.failure).toEqual({
      class: "crash",
      mechanism: "logic",
      trigger: "",
      impact: "",
    })
  })

  test("a quote's path, line and side", () => {
    expect(quotesOf({ ...quote, path: "" }, { ...quote, path: undefined }, { ...quote, path: "./src/b.ts" })).toEqual([
      quote,
      quote,
      { ...quote, path: "src/b.ts" },
    ])
    expect(quotesOf({ ...quote, path: "/src/c.ts" })?.[0]?.path).toBe("src/c.ts")
    // A quote's line is read strictly, unlike a finding's: a whole number of 1 or more, or text that is only one after
    // an optional L. Anything else drops the quote rather than point it at another line.
    expect(
      quotesOf(
        { ...quote, line: "12" },
        { ...quote, line: "L14" },
        { ...quote, line: " l16 " },
        { ...quote, line: 1 },
      )?.map((q) => q.line),
    ).toEqual([12, 14, 16, 1])
    for (const line of [
      0,
      -5,
      "-5",
      " -5",
      "L-5",
      "line -5",
      "line 12",
      "12.5",
      "1e3",
      0.6,
      15.4,
      "99999999999999999999",
      Number.POSITIVE_INFINITY,
      undefined,
      "none",
      Number.NaN,
    ])
      expect(quotesOf({ ...quote, line })).toBeUndefined()
    expect(decode({ line: "line -5" })?.line).toBe(5)
    expect(decode({ line: 15.4 })?.line).toBe(15)
    expect(
      quotesOf(
        { ...quote, side: "left" },
        { ...quote, side: "LEFT" },
        { ...quote, side: "base" },
        { ...quote, side: undefined },
      )?.map((q) => q.side),
    ).toEqual(["LEFT", "LEFT", "RIGHT", "RIGHT"])
  })

  // I-8: the path is meant to select a file to read. VS-27b's S4 still checks containment against the tree-ish.
  test("a quote whose path could leave the repository is dropped", () => {
    for (const path of [
      "../etc/passwd",
      "a/../../b",
      "..",
      "src/..",
      "/../x.ts",
      "./../x.ts",
      "src\\a.ts",
      "C:/Windows/x.ts",
      "c:x.ts",
    ])
      expect(quotesOf({ ...quote, path })).toBeUndefined()
    expect(
      quotesOf(
        { ...quote, path: "src/a..b.ts" },
        { ...quote, path: "..x/y.ts" },
        { ...quote, path: "src/.../z.ts" },
      )?.map((q) => q.path),
    ).toEqual(["src/a..b.ts", "..x/y.ts", "src/.../z.ts"])
    // A quote with no path takes the finding's, which the legacy decoder keeps as it is, so it is checked too.
    expect(decode({ path: "../x.ts", quotes: [{ ...quote, path: "" }] })?.quotes).toBeUndefined()
  })

  test("a quote's line stays the first line of its code, and a Markdown file keeps its fence", () => {
    const at = (code: string, path: string = quote.path) => quotesOf({ ...quote, path, code })?.[0]
    expect(at("\n\n\tone")).toEqual({ ...quote, line: 14, code: "\tone" })
    expect(at("\r\n\r\n\tone\r\n\n")).toEqual({ ...quote, line: 14, code: "\tone" })
    expect(at("  \n\tone")).toEqual({ ...quote, code: "  \n\tone" })
    // A fence is presentation outside Markdown: the line is the first line inside it.
    expect(at("```ts\n  x\n```")).toEqual({ ...quote, code: "  x" })
    expect(at("\n\n```ts\n\n  x\n```")).toEqual({ ...quote, line: 13, code: "  x" })
    expect(at("```\nx\n```", "src/a.md.ts")?.code).toBe("x")
    for (const path of ["docs/a.md", "README.MD", "a.mdx", "b.markdown", "c.qmd"])
      expect(at("```ts\nconst a = 1\n```", path)).toEqual({ ...quote, path, code: "```ts\nconst a = 1\n```" })
    expect(at("\n```ts\nx\n```\n", "docs/a.md")).toEqual({
      ...quote,
      path: "docs/a.md",
      line: 13,
      code: "```ts\nx\n```",
    })
  })

  // A long run of backticks or tildes makes the fence regex backtrack quadratically (40,000 took over a second), so
  // text over its cap plus a small fence allowance is dropped before the regex runs.
  test("a huge quote or patch is dropped before the fence is looked for", () => {
    const legacy = decode({})
    const started = performance.now()
    for (const run of ["`".repeat(200_000), "~".repeat(200_000), `\`\`\`\n${"\n".repeat(200_000)}x`]) {
      expect(decode({ quotes: [{ ...quote, code: run }], patch: run })).toEqual(legacy)
      expect(decode({ quotes: [{ ...quote, path: "docs/a.md", code: run }] })).toEqual(legacy)
    }
    expect(performance.now() - started).toBeLessThan(1_000)
    // Within the allowance a fence still comes off a quote at its cap.
    expect(quotesOf({ ...quote, code: `\`\`\`ts\n${"x".repeat(MAX_QUOTE_CHARS)}\n\`\`\`` })?.[0]?.code).toBe(
      "x".repeat(MAX_QUOTE_CHARS),
    )
  })

  test("a quote's code keeps its indentation and is dropped, not cut, over a cap", () => {
    const code = (value: unknown) => quotesOf({ ...quote, code: value })?.[0]?.code
    expect(code("```ts\n  if (x) return  \n```")).toBe("  if (x) return  ")
    expect(code("\n\n\tone\r\n\ttwo\r\n\n")).toBe("\tone\n\ttwo")
    expect(code("  a\n\n  b")).toBe("  a\n\n  b")
    for (const value of ["", "  \n \n", 42, undefined, "```\n\n```"]) expect(code(value)).toBeUndefined()
    const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join("\n")
    expect(code(lines(MAX_QUOTE_LINES))).toBe(lines(MAX_QUOTE_LINES))
    expect(code(lines(MAX_QUOTE_LINES + 1))).toBeUndefined()
    expect(code("x".repeat(MAX_QUOTE_CHARS))).toBe("x".repeat(MAX_QUOTE_CHARS))
    expect(code("x".repeat(MAX_QUOTE_CHARS + 1))).toBeUndefined()
  })

  test("keeps the first quotes that decode, at most MAX_FINDING_QUOTES", () => {
    const valid = Array.from({ length: MAX_FINDING_QUOTES + 2 }, (_, index) => ({ ...quote, line: index + 1 }))
    const kept = quotesOf("not a quote", { ...quote, line: 0 }, null, ...valid)
    expect(kept?.map((q) => q.line)).toEqual(valid.slice(0, MAX_FINDING_QUOTES).map((q) => q.line))
    expect(Object.hasOwn(decode({ quotes: [{ ...quote, code: "" }] })!, "quotes")).toBe(false)
    expect(Object.hasOwn(decode({ quotes: "src/a.ts:12" })!, "quotes")).toBe(false)
    // Only the first MAX_QUOTES_READ entries are read, so a report cannot make the decoder clean thousands of quotes.
    const junk = Array.from({ length: MAX_QUOTES_READ }, () => ({ ...quote, line: 0 }))
    expect(quotesOf(...junk.slice(1), quote)).toEqual([quote])
    expect(quotesOf(...junk, quote)).toBeUndefined()
  })

  test("a patch is unwrapped and kept whole, with its context lines' spaces, or dropped", () => {
    const read = (value: unknown) => decode({ patch: value })?.patch
    expect(read(`\`\`\`diff\n${patch}\n\`\`\``)).toBe(patch)
    expect(read(`${patch.replace(/\n/g, "\r\n")}\r\n`)).toBe(patch)
    expect(read("@@ -1,2 +1,2 @@\n \n-a\n+b\n ")).toBe("@@ -1,2 +1,2 @@\n \n-a\n+b\n ")
    const many = Array.from({ length: 200 }, (_, index) => `+line ${index}`).join("\n")
    expect(read(many)).toBe(many)
    expect(read("p".repeat(MAX_SUGGESTION_CHARS))).toBe("p".repeat(MAX_SUGGESTION_CHARS))
    for (const value of ["p".repeat(MAX_SUGGESTION_CHARS + 1), "", " \n ", 7, undefined])
      expect(read(value)).toBeUndefined()
  })

  // GP3 (addendum §3, for precise mode): an unreadable severity is never read as the lowest level, nor as blocking.
  // Strict decoding keeps the legacy reading, "concern", and marks it (VS-27b, the round-two amendment), so S2 drops it
  // with its own count instead of as a concern the model chose.
  test("an unreadable severity stays concern, never blocking, and is marked", () => {
    for (const severity of ["critical", "", undefined, "BLOCKING!", 3]) {
      const finding = decode({ severity, failure, quotes: [quote] })
      expect(finding?.severity).toBe("concern")
      expect(finding?.severityUnreadable).toBe(true)
    }
    for (const [severity, read] of [
      [" Blocking ", "blocking"],
      ["concern", "concern"],
      ["NIT", "nit"],
    ] as const) {
      const finding = decode({ severity })
      expect(finding?.severity).toBe(read)
      expect(finding).not.toHaveProperty("severityUnreadable")
    }
  })

  test("the legacy decoder never marks a severity", () => {
    for (const keys of [undefined, {}, { guardrail: "off" as const }]) {
      const finding = decodeReport({ summary: "s", findings: [{ ...base, severity: "critical" }] }, keys)?.findings[0]
      expect(finding?.severity).toBe("concern")
      expect(finding).not.toHaveProperty("severityUnreadable")
    }
  })
})
