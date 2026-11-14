import { describe, expect, test } from "bun:test"
import { JsonSchemaCheck } from "../src/json-schema-check"

const accepted = (schema: unknown, options?: JsonSchemaCheck.Options) => {
  const result = JsonSchemaCheck.accept(schema, options)
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  return result
}

const refused = (schema: unknown, options?: JsonSchemaCheck.Options) => {
  const result = JsonSchemaCheck.accept(schema, options)
  if (result.ok) throw new Error("accepted")
  return result.reason
}

const problems = (schema: Record<string, unknown>, value: unknown) =>
  JsonSchemaCheck.validate(accepted(schema).schema, value)

// A schema `levels` deep: an object whose one property is the next level, ending in a string.
const nested = (levels: number): Record<string, unknown> =>
  levels === 1 ? { type: "string" } : { type: "object", properties: { next: nested(levels - 1) } }

describe("JsonSchemaCheck.accept", () => {
  test("refuses keywords outside the subset by name", () => {
    expect(refused({ type: "string", pattern: "^a+$" })).toContain('"pattern" is not supported')
    expect(refused({ type: "object", patternProperties: { "^x": { type: "string" } } })).toContain(
      '"patternProperties" is not supported',
    )
    expect(refused({ if: { type: "string" }, then: { minLength: 1 } })).toContain('"if" is not supported')
    expect(refused({ $dynamicRef: "#meta" })).toContain('"$dynamicRef" is not supported')
    expect(refused({ type: "object", properties: { a: { type: "string", contentEncoding: "base64" } } })).toContain(
      '/properties/a: "contentEncoding" is not supported',
    )
  })

  test("refuses a remote, a missing or a non-root reference", () => {
    expect(refused({ $ref: "https://example.com/schema.json" })).toContain("$ref")
    expect(refused({ $ref: "other.json#/$defs/a" })).toContain("$ref")
    expect(refused({ $ref: "#/$defs/missing", $defs: {} })).toContain("$ref")
    expect(refused({ $ref: "#/properties/a", properties: { a: { type: "string" } } })).toContain("$ref")
    expect(refused({ properties: { a: { $defs: { b: { type: "string" } } } } })).toContain("only the root")
  })

  test("refuses enums and consts that are not strings", () => {
    expect(refused({ enum: [1, 2, 3] })).toContain("values must be strings")
    expect(refused({ enum: ["a", null] })).toContain("values must be strings")
    expect(refused({ const: 4 })).toContain("must be a string")
    expect(refused({ enum: [] })).toContain("non-empty")
  })

  test("refuses a schema past its size limits", () => {
    const big = { type: "object", description: "x".repeat(JsonSchemaCheck.LIMIT.bytes) }
    expect(refused(big)).toContain("16 KiB")
    expect(refused({ enum: Array.from({ length: 257 }, (_, index) => `v${index}`) })).toContain("more than 256 values")
    const properties = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`p${index}`, true]))
    expect(refused({ type: "object", properties })).toContain("more than 256 properties")
    expect(refused({ anyOf: Array.from({ length: 9 }, () => ({ type: "string" })) })).toContain("more than 8 schemas")
    const refs = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`p${index}`, { $ref: "#/$defs/s" }]))
    expect(refused({ type: "object", properties: refs, $defs: { s: { type: "string" } } })).toContain("64 $ref")
  })

  test("takes depth 8 and refuses depth 9", () => {
    accepted(nested(8))
    expect(refused(nested(9))).toContain("deeper than 8 levels")
  })

  test("refuses a reference cycle that never enters a value, and references that expand past the node budget", () => {
    expect(refused({ $ref: "#" })).toContain("refers back to itself")
    expect(
      refused({ $defs: { a: { $ref: "#/$defs/b" }, b: { anyOf: [{ $ref: "#/$defs/a" }] } }, $ref: "#/$defs/a" }),
    ).toContain("refers back to itself")
    // Each level holds 8 references to the next: 8^6 nodes once followed.
    const $defs: Record<string, unknown> = { l6: { type: "string" } }
    for (let level = 5; level >= 0; level--)
      $defs[`l${level}`] = { allOf: Array.from({ length: 8 }, () => ({ $ref: `#/$defs/l${level + 1}` })) }
    expect(refused({ $defs, $ref: "#/$defs/l0" })).toContain("expand past 100000 nodes")
  })

  test("takes a recursive tree that enters a value before it refers back", () => {
    const tree = {
      type: "object",
      properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#" } } },
      required: ["name"],
    }
    accepted(tree)
    expect(JsonSchemaCheck.validate(tree, { name: "a", children: [{ name: "b", children: [{ name: "c" }] }] })).toEqual(
      [],
    )
    expect(JsonSchemaCheck.validate(tree, { name: "a", children: [{ children: [] }] })).toEqual([
      { path: "/children/0/name", message: "is required." },
    ])
  })

  test("takes annotations, x- keys, nullable and the property counts", () => {
    const result = accepted({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Answer",
      description: "The answer",
      type: "object",
      "x-vendor": { anything: [1, 2] },
      minProperties: 1,
      maxProperties: 3,
      properties: {
        when: { type: "string", format: "date-time", nullable: true, examples: ["2026"], deprecated: false },
        size: { type: "integer", default: 1, readOnly: true, writeOnly: false, $comment: "c" },
      },
    })
    expect(result.schema["x-vendor"]).toEqual({ anything: [1, 2] })
  })

  test("requires an object root only when asked", () => {
    accepted({ type: "array", items: { type: "string" } })
    expect(refused({ type: "array" }, { object: true })).toContain('"type": "object"')
    accepted({ type: "object" }, { object: true })
  })

  test("normalizes key order so the same schema gives the same text", () => {
    const a = accepted({ type: "object", properties: { b: { type: "string" }, a: { type: "number" } } })
    const b = accepted({ properties: { a: { type: "number" }, b: { type: "string" } }, type: "object" })
    expect(a.normalized).toBe(b.normalized)
    expect(JSON.parse(a.normalized)).toEqual(a.schema)
  })

  test("refuses a root that is not an object", () => {
    expect(refused(true)).toContain("JSON object")
    expect(refused([{ type: "string" }])).toContain("JSON object")
  })
})

describe("JsonSchemaCheck.validate", () => {
  test("type, including integer, type lists and nullable", () => {
    expect(problems({ type: "integer" }, 1)).toEqual([])
    expect(problems({ type: "integer" }, 1.5)).toEqual([{ path: "", message: "must be integer, not number." }])
    expect(problems({ type: "number" }, 2)).toEqual([])
    expect(problems({ type: ["string", "null"] }, null)).toEqual([])
    expect(problems({ type: ["string", "null"] }, 3)).toEqual([
      { path: "", message: "must be string or null, not integer." },
    ])
    expect(problems({ type: "string", nullable: true }, null)).toEqual([])
    expect(problems({ type: "string", nullable: true }, false)).toEqual([
      { path: "", message: "must be string or null, not boolean." },
    ])
    expect(problems({ type: "object" }, [])).toEqual([{ path: "", message: "must be object, not array." }])
    expect(problems({ type: "array" }, {})).toEqual([{ path: "", message: "must be array, not object." }])
    expect(problems({ type: "boolean" }, "true")).toEqual([{ path: "", message: "must be boolean, not string." }])
  })

  test("properties, required and additionalProperties, with JSON pointers", () => {
    const schema = {
      type: "object",
      properties: { "a/b": { type: "string" }, "c~d": { type: "number" }, ok: { type: "boolean" } },
      required: ["ok", "missing"],
      additionalProperties: false,
    }
    expect(problems(schema, { "a/b": 1, "c~d": "x", ok: true, extra: 1 })).toEqual([
      { path: "/missing", message: "is required." },
      { path: "/a~1b", message: "must be string, not integer." },
      { path: "/c~0d", message: "must be number, not string." },
      { path: "/extra", message: "is not allowed." },
    ])
    expect(problems({ type: "object", additionalProperties: { type: "string" } }, { a: "x", b: 2 })).toEqual([
      { path: "/b", message: "must be string, not integer." },
    ])
    expect(problems({ type: "object", minProperties: 2 }, { a: 1 })).toEqual([
      { path: "", message: "must have at least 2 properties." },
    ])
    expect(problems({ type: "object", maxProperties: 1 }, { a: 1, b: 2 })).toEqual([
      { path: "", message: "must have at most 1 properties." },
    ])
  })

  test("items, minItems, maxItems and uniqueItems", () => {
    expect(problems({ type: "array", items: { type: "string" } }, ["a", 2, "c", null])).toEqual([
      { path: "/1", message: "must be string, not integer." },
      { path: "/3", message: "must be string, not null." },
    ])
    expect(problems({ type: "array", minItems: 2 }, [1])).toEqual([
      { path: "", message: "must have at least 2 items." },
    ])
    expect(problems({ type: "array", maxItems: 1 }, [1, 2])).toEqual([
      { path: "", message: "must have at most 1 items." },
    ])
    expect(
      problems({ type: "array", uniqueItems: true }, [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ]),
    ).toEqual([{ path: "/1", message: "repeats item 0; items must differ." }])
    expect(problems({ type: "array", uniqueItems: true }, [1, "1", true])).toEqual([])
    expect(
      problems(
        { type: "array", uniqueItems: true },
        Array.from({ length: 1001 }, (_, index) => index),
      ),
    ).toEqual([{ path: "", message: "has more than 1000 items, too many to check that they differ." }])
  })

  test("enum and const", () => {
    expect(problems({ enum: ["red", "green"] }, "red")).toEqual([])
    expect(problems({ enum: ["red", "green"] }, "blue")).toEqual([
      { path: "", message: 'must be one of "red", "green".' },
    ])
    expect(problems({ enum: ["1"] }, 1)).toEqual([{ path: "", message: 'must be one of "1".' }])
    expect(problems({ const: "yes" }, "no")).toEqual([{ path: "", message: 'must be "yes".' }])
  })

  test("string lengths count characters, not UTF-16 units", () => {
    expect(problems({ type: "string", maxLength: 2 }, "😀😀")).toEqual([])
    expect(problems({ type: "string", minLength: 3 }, "😀😀")).toEqual([
      { path: "", message: "must be at least 3 characters." },
    ])
    expect(problems({ type: "string", maxLength: 1 }, "ab")).toEqual([
      { path: "", message: "must be at most 1 characters." },
    ])
  })

  test("numeric bounds and multipleOf", () => {
    expect(problems({ type: "number", minimum: 1, maximum: 3 }, 0)).toEqual([
      { path: "", message: "must be 1 or more." },
    ])
    expect(problems({ type: "number", minimum: 1, maximum: 3 }, 4)).toEqual([
      { path: "", message: "must be 3 or less." },
    ])
    expect(problems({ type: "number", exclusiveMinimum: 1 }, 1)).toEqual([
      { path: "", message: "must be more than 1." },
    ])
    expect(problems({ type: "number", exclusiveMaximum: 1 }, 1)).toEqual([
      { path: "", message: "must be less than 1." },
    ])
    expect(problems({ type: "number", multipleOf: 0.1 }, 0.3)).toEqual([])
    expect(problems({ type: "number", multipleOf: 2 }, 3)).toEqual([{ path: "", message: "must be a multiple of 2." }])
  })

  test("anyOf, oneOf, allOf and not", () => {
    const any = { anyOf: [{ type: "string" }, { type: "integer" }] }
    expect(problems(any, 1)).toEqual([])
    expect(problems(any, true)).toEqual([{ path: "", message: "must match at least one of the 2 anyOf schemas." }])
    const one = { oneOf: [{ type: "number" }, { type: "integer" }] }
    expect(problems(one, 1.5)).toEqual([])
    expect(problems(one, 1)).toEqual([{ path: "", message: "must match exactly one of the 2 oneOf schemas, not 2." }])
    expect(problems({ allOf: [{ type: "number" }, { minimum: 2 }] }, 1)).toEqual([
      { path: "", message: "must be 2 or more." },
    ])
    expect(problems({ not: { type: "string" } }, "x")).toEqual([
      { path: "", message: "must not match the not schema." },
    ])
    expect(problems({ not: { type: "string" } }, 1)).toEqual([])
  })

  test("local references to the root, $defs and definitions", () => {
    const schema = {
      type: "object",
      properties: { a: { $ref: "#/$defs/name" }, b: { $ref: "#/definitions/count" } },
      $defs: { name: { type: "string" } },
      definitions: { count: { type: "integer", minimum: 0 } },
    }
    expect(problems(schema, { a: "x", b: 1 })).toEqual([])
    expect(problems(schema, { a: 1, b: -1 })).toEqual([
      { path: "/a", message: "must be string, not integer." },
      { path: "/b", message: "must be 0 or more." },
    ])
  })

  test("a schema that fans out over one large string or array reads it once, so the check stays fast", () => {
    // Each level tries 8 references to the next and no leaf matches: about 33,000 visits of the same value.
    const fanOut = (leaf: Record<string, unknown>) => {
      const $defs: Record<string, unknown> = { l5: leaf }
      for (let level = 4; level >= 0; level--)
        $defs[`l${level}`] = { anyOf: Array.from({ length: 8 }, () => ({ $ref: `#/$defs/l${level + 1}` })) }
      return { $defs, $ref: "#/$defs/l0" }
    }
    const missed = [{ path: "", message: "must match at least one of the 8 anyOf schemas." }]
    const text = `${"x".repeat(500_000)}😀`
    const items = Array.from({ length: 1000 }, (_, index) => `${index}`.padStart(500, "0"))
    const started = performance.now()
    expect(problems(fanOut({ enum: ["y"] }), text)).toEqual(missed)
    expect(problems(fanOut({ type: "string", maxLength: 10 }), text)).toEqual(missed)
    expect(problems(fanOut({ type: "array", minItems: 2000, uniqueItems: true }), items)).toEqual(missed)
    expect(performance.now() - started).toBeLessThan(5000)
    // Read once, the length and the repeat are still checked.
    expect(problems({ type: "string", maxLength: 500_000 }, text)).toEqual([
      { path: "", message: "must be at most 500000 characters." },
    ])
    expect(problems({ type: "array", uniqueItems: true }, [...items.slice(0, 999), items[3]])).toEqual([
      { path: "/999", message: "repeats item 3; items must differ." },
    ])
  })

  test("returns at most 20 problems", () => {
    const found = problems(
      { type: "array", items: { type: "string" } },
      Array.from({ length: 50 }, (_, index) => index),
    )
    expect(found).toHaveLength(20)
    expect(found[0]).toEqual({ path: "/0", message: "must be string, not integer." })
  })

  test("caps the depth and size of the value it checks", () => {
    let deep: unknown = "end"
    for (let level = 0; level < 70; level++) deep = [deep]
    expect(problems({}, deep)).toEqual([{ path: "", message: "nests deeper than 64 levels." }])
    expect(
      problems(
        {},
        Array.from({ length: 100_001 }, () => 0),
      ),
    ).toEqual([{ path: "", message: "holds more than 100000 values." }])
  })

  test("describe joins problems into one line", () => {
    expect(
      JsonSchemaCheck.describe([
        { path: "/a", message: "is required." },
        { path: "", message: "must be object, not array." },
      ]),
    ).toBe("/a is required. The value must be object, not array.")
    expect(JsonSchemaCheck.describe([{ path: `/${"k".repeat(300)}`, message: "is required." }])).toHaveLength(200)
  })
})

describe("JsonSchemaCheck.extract and encode", () => {
  test("extract reads the last json block, a bare block, or the whole text", () => {
    expect(JsonSchemaCheck.extract('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(JsonSchemaCheck.extract('Draft:\n```json\n{"a": 1}\n```\nFinal:\n```json\n{"a": 2}\n```\n')).toEqual({
      ok: true,
      value: { a: 2 },
    })
    expect(JsonSchemaCheck.extract('Here:\n```\n["x"]\n```')).toEqual({ ok: true, value: ["x"] })
    expect(JsonSchemaCheck.extract('```ts\nconst a = 1\n```\n```json\n{"b": true}\n```')).toEqual({
      ok: true,
      value: { b: true },
    })
  })

  test("extract says why it found no JSON", () => {
    const prose = JsonSchemaCheck.extract("I could not finish.")
    expect(prose.ok).toBe(false)
    if (!prose.ok) expect(prose.reason).toContain("not JSON")
    const broken = JsonSchemaCheck.extract("```json\n{ a: 1 }\n```")
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.reason).toContain("does not parse")
    expect(JsonSchemaCheck.extract("   ").ok).toBe(false)
  })

  test("encode escapes markup and line separators and round-trips", () => {
    const value = { html: "</script><b>&amp;</b>", lines: "a\u2028b\u2029c", nested: [1, null, { "<k>": true }] }
    const text = JsonSchemaCheck.encode(value)
    for (const raw of ["<", ">", "&", "\u2028", "\u2029"]) expect(text).not.toContain(raw)
    expect(text).toContain("\\u003c/script\\u003e")
    expect(text).not.toContain(" ")
    expect(JSON.parse(text)).toEqual(value)
    expect(JsonSchemaCheck.extract(text)).toEqual({ ok: true, value })
    expect(JsonSchemaCheck.encode(undefined)).toBe("null")
  })
})
