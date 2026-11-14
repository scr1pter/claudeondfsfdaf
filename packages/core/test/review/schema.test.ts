import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  decodeReport,
  decodeRuleCitation,
  decodeVerify,
  decodeVerifyCertificates,
  extractJson,
  MAX_FAILURE_TEXT_CHARS,
  MAX_FINDING_QUOTES,
  MAX_QUOTES_READ,
  MAX_QUOTE_CHARS,
  MAX_QUOTE_LINES,
  MAX_REPORT_FINDINGS,
  MAX_RULE_QUOTE_CHARS,
  MAX_SUGGESTION_CHARS,
  MAX_TITLE_CHARS,
  MAX_TRACE_QUOTES,
  REVIEW_REPORT_JSON_SCHEMA,
  strictReportJsonSchema,
  strictResultJsonSchema,
  VERIFY_JSON_SCHEMA,
  verifyCertJsonSchema,
} from "@vectordevai/core/review/schema"
import {
  CATEGORIES,
  CERTIFICATE_REACH,
  CERTIFICATE_VERDICTS,
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

// VS-43a: the structured rule decoder, which no runner calls before VS-43 wiring. A problem is one of three kinds, so a
// measurement can count format mismatches apart from wrong quotes.
describe("decodeRuleCitation (VS-43a)", () => {
  const quote = "Never log access tokens."
  const source = (said: unknown) => {
    const read = decodeRuleCitation({ source: said, quote })
    return "citation" in read ? read.citation.source : read.problem
  }

  test("anything but an object is not structured, the legacy quoted text included", () => {
    for (const input of [quote, null, undefined, [{ source: "review_rules", quote }], 3, true])
      expect(decodeRuleCitation(input)).toEqual({ problem: "not-structured" })
  })

  test("reads the two block names leniently, and nothing else", () => {
    for (const said of [
      "review_rules",
      "<review_rules>",
      "</review_rules>",
      "<review_rules/>",
      " Review Rules ",
      "review-rules",
      "REVIEW_RULES",
    ])
      expect(source(said)).toEqual({ kind: "review_rules" })
    for (const said of [
      "repository_instructions",
      "<repository_instructions>",
      "Repository Instructions",
      "repository-instructions",
    ])
      expect(source(said)).toEqual({ kind: "repository_instructions" })
    // File names name no block: the prompt clause added with wiring must name the exact source tokens.
    for (const said of [
      "AGENTS.md",
      ".vector/review.md",
      "review.json",
      "rules",
      "instructions",
      "review rules!",
      "",
      1,
      null,
      { kind: "review_rules" },
    ])
      expect(source(said)).toBe("source")
  })

  test("paths[i] is a 0-based index into ReviewConfig.paths, and only a whole one", () => {
    expect(source("paths[0]")).toEqual({ kind: "paths", index: 0 })
    expect(source(" PATHS [ 12 ] ")).toEqual({ kind: "paths", index: 12 })
    expect(source("paths[007]")).toEqual({ kind: "paths", index: 7 })
    for (const said of [
      "paths[-1]",
      "paths[1.5]",
      "paths[]",
      "paths[x]",
      "paths 1",
      "paths[1][2]",
      "paths[99999999999999999999]",
    ])
      expect(source(said)).toBe("source")
  })

  test("a scoped path keeps its case and is trimmed; one that is empty, holds a control character or escapes is refused", () => {
    expect(source("scoped:src/AGENTS.md")).toEqual({ kind: "scoped", path: "src/AGENTS.md" })
    expect(source("Scoped : ./src/Api/AGENTS.md ")).toEqual({ kind: "scoped", path: "src/Api/AGENTS.md" })
    expect(source("scoped: src/AGENTS.md \n")).toEqual({ kind: "scoped", path: "src/AGENTS.md" })
    expect(source("scoped:/.github/instructions/api.instructions.md")).toEqual({
      kind: "scoped",
      path: ".github/instructions/api.instructions.md",
    })
    for (const said of [
      "scoped:",
      "scoped:   ",
      "scoped: src/a\nb.md",
      "scoped: src/a\tb.md",
      "scoped: ../AGENTS.md",
      "scoped: src/../../x",
      "scoped: src\\AGENTS.md",
      "scoped: C:/x",
    ])
      expect(source(said)).toBe("source")
  })

  test("a quote is trimmed text with CRLF folded, holding a letter or a digit, dropped rather than cut when too long", () => {
    expect(decodeRuleCitation({ source: "review_rules", quote: "  - Never log\r\n  access tokens.\r\n" })).toEqual({
      citation: { source: { kind: "review_rules" }, quote: "- Never log\n  access tokens." },
    })
    const longest = "é".repeat(MAX_RULE_QUOTE_CHARS)
    expect(decodeRuleCitation({ source: "review_rules", quote: longest })).toEqual({
      citation: { source: { kind: "review_rules" }, quote: longest },
    })
    for (const said of [longest + "é", "", "   ", "— … —", "---", 42, undefined, ["Never log access tokens."]])
      expect(decodeRuleCitation({ source: "review_rules", quote: said })).toEqual({ problem: "quote" })
    // The source is read first.
    expect(decodeRuleCitation({ source: "AGENTS.md", quote: "" })).toEqual({ problem: "source" })
  })

  test("lines are optional and never block a citation: a bad range is dropped", () => {
    const lines = (said: unknown) => {
      const read = decodeRuleCitation({ source: "review_rules", quote, lines: said })
      if (!("citation" in read)) throw new Error("expected a citation")
      return read.citation.lines
    }
    expect(lines(4)).toEqual({ start: 4, end: 4 })
    expect(lines("L3-L7")).toEqual({ start: 3, end: 7 })
    expect(lines(" 3 – 7 ")).toEqual({ start: 3, end: 7 })
    expect(lines("l5")).toEqual({ start: 5, end: 5 })
    expect(lines("5-5")).toEqual({ start: 5, end: 5 })
    expect(lines({ start: 2, end: 9 })).toEqual({ start: 2, end: 9 })
    for (const said of [
      undefined,
      0,
      -2,
      2.5,
      "7-3",
      "0-4",
      "L3-",
      "3..7",
      "lines 3-7",
      { start: 4 },
      { start: 5, end: 2 },
      [3, 7],
    ])
      expect(lines(said)).toBeUndefined()
  })

  test("other keys are ignored, and decodeReport does not read a structured rule", () => {
    expect(decodeRuleCitation({ source: "paths[1]", quote, severity: "blocking", extra: { a: 1 } })).toEqual({
      citation: { source: { kind: "paths", index: 1 }, quote },
    })
    const finding = {
      path: "src/a.ts",
      line: 3,
      severity: "concern",
      category: "style",
      title: "Logs a token",
      body: "b",
      confidence: 0.9,
    }
    for (const keys of [undefined, { guardrail: "strict" as const }]) {
      const decoded = decodeReport(
        { summary: "s", findings: [{ ...finding, rule: { source: "review_rules", quote } }] },
        keys,
      )
      expect(decoded?.findings[0]).not.toHaveProperty("rule")
      expect(decoded?.findings[0]).not.toHaveProperty("citation")
      expect(decodeReport({ summary: "s", findings: [{ ...finding, rule: quote }] }, keys)?.findings[0]?.rule).toBe(
        quote,
      )
    }
  })
})

// VS-44a: the certificate verify schema and its decoder. Nothing sends the schema or calls the decoder before VS-44
// wiring, with VS-27c.
describe("the certificate verify schema (VS-44a)", () => {
  const CERT = { guardrail: "strict", verifyEvidence: "certificate" } as const

  test("exists only under guardrail: strict with verifyEvidence: certificate", () => {
    for (const keys of [
      {},
      STRICT,
      { verifyEvidence: "certificate" as const },
      { guardrail: "off" as const, verifyEvidence: "certificate" as const },
      { guardrail: "strict" as const, verifyEvidence: "off" as const },
      { guardrail: "strict" as const, scopeGate: "introduced" as const },
    ])
      expect(verifyCertJsonSchema(keys)).toBeUndefined()
    expect(verifyCertJsonSchema(CERT)).toBeDefined()
    expect(verifyCertJsonSchema({ ...CERT, scopeGate: "introduced" })).toEqual(verifyCertJsonSchema(CERT))
    expect([...CERTIFICATE_VERDICTS]).toEqual(["confirmed", "rejected", "unsure"])
    expect([...CERTIFICATE_REACH]).toEqual(["caller-shown", "entry-point", "assumed"])
    expect(MAX_TRACE_QUOTES).toBe(6)
  })

  test("is the legacy verify schema with unsure and a certificate added to each result", () => {
    const cert = verifyCertJsonSchema(CERT)!
    const legacy = VERIFY_JSON_SCHEMA.properties.results.items
    const result = cert.properties.results.items
    expect(Object.keys(result.properties)).toEqual([
      ...Object.keys(legacy.properties),
      "trace",
      "guards",
      "noGuards",
      "reach",
    ])
    expect(result.properties.verdict).toEqual({ ...legacy.properties.verdict, enum: [...CERTIFICATE_VERDICTS] })
    expect({
      ...cert,
      properties: { ...cert.properties, results: VERIFY_JSON_SCHEMA.properties.results },
    }).toEqual(VERIFY_JSON_SCHEMA)
    // Fixed claims share the results, and a rejected verdict needs no trace: certified() enforces the rest.
    expect(result.required).toEqual(legacy.required)
    expect({ ...result, properties: legacy.properties }).toEqual({ ...legacy, properties: legacy.properties })
    for (const name of ["trace", "guards"] as const) {
      expect(result.properties[name].type).toBe("array")
      expect(result.properties[name].items).toEqual(
        strictReportJsonSchema(STRICT)!.properties.findings.items.properties.quotes.items,
      )
    }
    expect(result.properties.trace.description).toContain(`1 to ${MAX_TRACE_QUOTES} quotes`)
    expect(result.properties.guards.description).toContain(`Up to ${MAX_FINDING_QUOTES} quotes`)
    expect(result.properties.noGuards).toMatchObject({ type: "string", maxLength: MAX_FAILURE_TEXT_CHARS })
    expect(result.properties.reach).toMatchObject({ type: "string", enum: [...CERTIFICATE_REACH] })
  })

  test("shares no object with the legacy schema or another call, and sends no keyword the legacy schemas lack", () => {
    const cert = verifyCertJsonSchema(CERT)!
    // The legacy enum never holds "unsure", so a shared array would show it there.
    cert.properties.results.items.properties.verdict.enum.push("unsure")
    cert.properties.results.items.required.push("trace")
    cert.properties.results.items.properties.trace.items.required.push("extra")
    expect(VERIFY_JSON_SCHEMA.properties.results.items.properties.verdict.enum).toEqual(["confirmed", "rejected"])
    expect(VERIFY_JSON_SCHEMA.properties.results.items.required).toEqual(["id", "verdict", "reason"])
    expect(verifyCertJsonSchema(CERT)).not.toEqual(cert)
    expect(verifyCertJsonSchema(CERT)).not.toBe(verifyCertJsonSchema(CERT))
    const fresh = verifyCertJsonSchema(CERT)!.properties.results.items.properties
    expect(fresh.trace.items).not.toBe(fresh.guards.items)
    // It goes to providers in a forced tool call, so it sends only keywords the legacy schemas already send.
    const legacy = new Set([...keywords(VERIFY_JSON_SCHEMA), ...keywords(REVIEW_REPORT_JSON_SCHEMA)])
    expect(keywords(verifyCertJsonSchema(CERT)).filter((key) => !legacy.has(key))).toEqual([])
    expect(keywords(verifyCertJsonSchema(CERT))).not.toContain("maxItems")
    expect(keywords(verifyCertJsonSchema(CERT))).not.toContain("minItems")
  })

  test("a certificate answer conforms, a legacy answer still does, and a malformed one does not", () => {
    const schema = verifyCertJsonSchema(CERT)!
    const quote = { path: "src/a.ts", line: 3, side: "RIGHT", code: "x" }
    const answer = (result: Record<string, unknown>) => ({
      results: [{ id: "a", verdict: "confirmed", reason: "r", ...result }],
    })
    expect(violations(schema, answer({}))).toEqual([])
    expect(violations(schema, answer({ verdict: "unsure" }))).toEqual([])
    expect(
      violations(schema, answer({ trace: [quote], guards: [], noGuards: "Read the caller.", reach: "caller-shown" })),
    ).toEqual([])
    expect(violations(VERIFY_JSON_SCHEMA, answer({ verdict: "unsure" }))).toEqual([
      "$.results[0].verdict is not in its enum",
    ])
    expect(violations(schema, answer({ reach: "probably" }))).toEqual(["$.results[0].reach is not in its enum"])
    expect(violations(schema, answer({ trace: [{ ...quote, line: 0 }] }))).toEqual([
      "$.results[0].trace[0].line is under its minimum",
    ])
    expect(violations(schema, answer({ noGuards: "n".repeat(MAX_FAILURE_TEXT_CHARS + 1) }))).toEqual([
      "$.results[0].noGuards is too long",
    ])
  })
})

describe("decodeVerifyCertificates (VS-44a)", () => {
  const quote = (line: number, code = `line ${line}`) => ({ path: "src/a.ts", line, side: "RIGHT", code })
  const decoded = (line: number, code = `line ${line}`) => ({ path: "src/a.ts", line, side: "RIGHT" as const, code })
  const one = (result: Record<string, unknown>) =>
    decodeVerifyCertificates({ results: [{ id: "a", verdict: "confirmed", reason: "r", ...result }] })?.[0]

  test("reads a certificate, and leaves decodeVerify as it was", () => {
    const answer = {
      results: [
        {
          id: "a",
          verdict: "Confirmed.",
          reason: " The caller\n passes null. ",
          trace: [quote(3), { ...quote(9), side: "left" }],
          guards: [quote(5)],
          noGuards: "  ignored  when guards are given ",
          reach: "Caller shown",
        },
        { id: "b", verdict: "reject", reason: "Not reachable." },
        { id: "c", verdict: "UNSURE", reason: "Could not tell." },
        { id: "d", verdict: "maybe", reason: "?" },
        { verdict: "confirmed" },
      ],
    }
    expect(decodeVerifyCertificates(answer)).toEqual([
      {
        id: "a",
        verdict: "confirmed",
        reason: "The caller passes null.",
        trace: [decoded(3), { ...decoded(9), side: "LEFT" }],
        guards: [decoded(5)],
        noGuards: "ignored when guards are given",
        reach: "caller-shown",
      },
      { id: "b", verdict: "rejected", reason: "Not reachable.", guards: [] },
      { id: "c", verdict: "unsure", reason: "Could not tell.", guards: [] },
    ])
    // decodeVerify reads the same answer as it always has: unsure drops, so its id stays unanswered.
    expect(decodeVerify(answer)).toEqual([
      { id: "a", verdict: "confirmed", reason: "The caller passes null." },
      { id: "b", verdict: "rejected", reason: "Not reachable." },
    ])
  })

  test("accepts a bare array or text, and returns undefined when there are no results", () => {
    expect(decodeVerifyCertificates([{ id: "a", verdict: "unsure", reason: "r" }])).toEqual([
      { id: "a", verdict: "unsure", reason: "r", guards: [] },
    ])
    expect(
      decodeVerifyCertificates(
        '```json\n{"path":"src/a.ts"}\n```\nThen: {"results":[{"id":"a","verdict":"unsure","reason":"r"}]} done.',
      ),
    ).toEqual([{ id: "a", verdict: "unsure", reason: "r", guards: [] }])
    // The two decoders differ only in the verdicts they accept: text whose only results are unsure is no answer to
    // decodeVerify.
    expect(decodeVerify('{"results":[{"id":"a","verdict":"unsure","reason":"r"}]}')).toBeUndefined()
    expect(decodeVerifyCertificates('{"results":[{"id":"a","verdict":"unsure","reason":"r"}]}')).toHaveLength(1)
    expect(decodeVerifyCertificates('Files I read: {"results":["src/a.ts"]}')).toBeUndefined()
    expect(decodeVerifyCertificates({ summary: "no results" })).toBeUndefined()
    expect(decodeVerifyCertificates("nothing")).toBeUndefined()
    expect(decodeVerifyCertificates({ results: [] })).toEqual([])
    // Results with the same id are all kept: what conflicting ones mean is VS-44 wiring's to decide.
    expect(
      decodeVerifyCertificates([
        { id: "a", verdict: "confirmed", reason: "r" },
        { id: "a", verdict: "rejected", reason: "r" },
      ])?.map((entry) => entry.verdict),
    ).toEqual(["confirmed", "rejected"])
  })

  test("keeps a trace whole or not at all, and marks one it could not keep", () => {
    const six = Array.from({ length: MAX_TRACE_QUOTES }, (_, index) => quote(index + 1))
    expect(one({ trace: six })?.trace).toEqual(six.map((entry) => decoded(entry.line)))
    const dropped = [
      [...six, quote(7)],
      [quote(1), { ...quote(2), line: 0 }],
      [quote(1), { ...quote(2), line: "line 2" }],
      [quote(1), { ...quote(2), path: "../secret.ts" }],
      [quote(1), { ...quote(2), code: "" }],
      [quote(1), { ...quote(2), code: "x".repeat(MAX_QUOTE_CHARS + 1) }],
      [quote(1), { ...quote(2), code: Array.from({ length: MAX_QUOTE_LINES + 1 }, () => "x").join("\n") }],
      [quote(1), "src/a.ts:2"],
    ]
    // A trace that is not a list is a format failure too: one quote object instead of a list, or a text.
    for (const trace of [...dropped, quote(1), "src/a.ts:3", "none", 3, false]) {
      const certificate = one({ trace })
      expect(certificate).not.toHaveProperty("trace")
      expect(certificate?.traceUnreadable).toBe(true)
    }
    // No trace, a null one, an empty list or a blank text is no trace, and is not marked.
    for (const trace of [undefined, null, [], "", " \n "]) {
      const certificate = one({ trace })
      expect(certificate).not.toHaveProperty("trace")
      expect(certificate).not.toHaveProperty("traceUnreadable")
    }
  })

  test("a quote with no path keeps path '', for certified() to read as the finding's file", () => {
    const { path: _, ...pathless } = quote(4)
    expect(one({ trace: [pathless], guards: [{ ...pathless, path: "  " }] })).toMatchObject({
      trace: [{ ...decoded(4), path: "" }],
      guards: [{ ...decoded(4), path: "" }],
    })
    // A line given as text is read as decodeQuote reads it, and the line moves past empty lines the cleaning strips.
    expect(one({ trace: [{ ...quote(4), line: "L4", code: "\n\nline 6" }] })?.trace).toEqual([decoded(6)])
  })

  test("keeps the first guards that decode, at most MAX_FINDING_QUOTES of the first MAX_QUOTES_READ", () => {
    const bad = { ...quote(1), line: 0 }
    const guards = [bad, ...Array.from({ length: MAX_FINDING_QUOTES + 2 }, (_, index) => quote(index + 1))]
    expect(one({ guards })?.guards).toEqual(
      Array.from({ length: MAX_FINDING_QUOTES }, (_, index) => decoded(index + 1)),
    )
    const late = [...Array.from({ length: MAX_QUOTES_READ }, () => bad), quote(1)]
    expect(one({ guards: late })?.guards).toEqual([])
    // A bad guard never drops the trace or the certificate.
    expect(one({ trace: [quote(1)], guards: [bad] })).toMatchObject({ trace: [decoded(1)], guards: [] })
    expect(one({ guards: "none" })?.guards).toEqual([])
  })

  test("noGuards is one line, dropped rather than cut when too long; reach is read leniently or left out", () => {
    expect(one({ noGuards: " Looked in\n the caller. " })?.noGuards).toBe("Looked in the caller.")
    expect(one({ noGuards: "é".repeat(MAX_FAILURE_TEXT_CHARS) })?.noGuards).toHaveLength(MAX_FAILURE_TEXT_CHARS)
    expect(one({ noGuards: "n".repeat(MAX_FAILURE_TEXT_CHARS + 1) })).not.toHaveProperty("noGuards")
    expect(one({ noGuards: "   " })).not.toHaveProperty("noGuards")
    expect(one({ noGuards: 4 })).not.toHaveProperty("noGuards")
    for (const [said, reach] of [
      ["caller-shown", "caller-shown"],
      ["Entry Point", "entry-point"],
      ["entry_point", "entry-point"],
      [" ASSUMED ", "assumed"],
    ] as const)
      expect(one({ reach: said })?.reach).toBe(reach)
    for (const said of ["callers", "shown", "", 3, undefined]) expect(one({ reach: said })).not.toHaveProperty("reach")
  })
})
