export * as JsonSchemaCheck from "./json-schema-check"

// Checks JSON against a hand-written subset of JSON Schema: no regular expressions, no remote references and no
// dependency, so a schema a model or a user wrote can neither run code nor take unbounded time. A schema with any
// keyword outside the subset is refused by name rather than half-checked. Pure: the app uses it too.

export const LIMIT = {
  /** The schema's JSON text, in UTF-8 bytes. */
  bytes: 16 * 1024,
  /** Nested schemas, the root being 1. */
  depth: 8,
  /** Entries of one `properties`. */
  properties: 256,
  /** Values of one `enum`. */
  enum: 256,
  /** `$ref`s in the whole schema. */
  refs: 64,
  /** Entries of one `anyOf`, `oneOf` or `allOf`. */
  combiners: 8,
  /** Schema nodes once every `$ref` is followed. */
  nodes: 100_000,
  /** The longest array `uniqueItems` is checked on. */
  unique: 1_000,
  /** How deeply a checked value may nest. */
  valueDepth: 64,
  /** How many values (every object, array and scalar) a checked value may hold. */
  valueNodes: 100_000,
  /** Problems one check returns. */
  problems: 20,
} as const

// Schema nodes one check may visit before it gives up: anyOf and oneOf try every branch on a value. Reading a string's
// length or an array's items for uniqueItems costs one more unit per this many characters.
const WORK = 1_000_000
const CHARS_PER_WORK = 1024

const SUPPORTED = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minProperties",
  "maxProperties",
  "nullable",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "$ref",
  "$defs",
  "definitions",
])

const IGNORED = new Set([
  "title",
  "description",
  "default",
  "examples",
  "format",
  "$schema",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
])

const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"])
const COUNTS = ["minItems", "maxItems", "minLength", "maxLength", "minProperties", "maxProperties"] as const
const BOUNDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const
const COMBINERS = ["anyOf", "oneOf", "allOf"] as const

type Schema = boolean | Record<string, unknown>

export type Problem = {
  /** A JSON pointer to the value, "" for the root. */
  readonly path: string
  readonly message: string
}

export type Accepted = {
  readonly ok: true
  /** A plain JSON copy of the schema as given. */
  readonly schema: Record<string, unknown>
  /** The schema as JSON with sorted keys: the same schema always gives the same text, for hashing. */
  readonly normalized: string
}

export type Refused = { readonly ok: false; readonly reason: string }

export type Options = {
  /** The root must be `type: "object"`: task and workflow outputs. */
  readonly object?: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function escape(key: string) {
  return key.replaceAll("~", "~0").replaceAll("/", "~1")
}

function unescape(segment: string) {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~")
}

function child(pointer: string, ...keys: (string | number)[]) {
  return keys.reduce<string>((path, key) => `${path}/${escape(String(key))}`, pointer)
}

function where(pointer: string) {
  return pointer || "the root"
}

function bytes(text: string) {
  return new TextEncoder().encode(text).length
}

/** The `$defs`/`definitions` entry a local `$ref` names, "#" for the root, or undefined when it names none. */
function target(root: Record<string, unknown>, ref: string): Schema | undefined {
  if (ref === "#") return root
  for (const container of ["$defs", "definitions"]) {
    const prefix = `#/${container}/`
    if (!ref.startsWith(prefix)) continue
    const name = unescape(ref.slice(prefix.length))
    if (name.includes("/")) return undefined
    const defs = root[container]
    if (!record(defs) || !Object.hasOwn(defs, name)) return undefined
    const found = defs[name]
    return typeof found === "boolean" || record(found) ? found : undefined
  }
  return undefined
}

/** A string's length in code points, as `[...text].length` counts it, without building the array. */
function codePoints(text: string) {
  let length = text.length
  for (let index = 0; index < text.length - 1; index++) {
    const code = text.charCodeAt(index)
    if (code < 0xd800 || code > 0xdbff) continue
    const next = text.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) {
      length--
      index++
    }
  }
  return length
}

/** JSON with every object's keys sorted, so equal values give equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (record(value))
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

/**
 * Accepts a schema the checker can enforce in full, or says why not. A refused schema is not checked at all, so callers
 * decide whether that is an error (task and workflow outputs) or a schema they pass on unchecked (StructuredOutput).
 */
export function accept(schema: unknown, options: Options = {}): Accepted | Refused {
  if (!record(schema)) return { ok: false, reason: "The schema must be a JSON object." }
  let text: string
  try {
    text = JSON.stringify(schema)
  } catch {
    return { ok: false, reason: "The schema is not JSON." }
  }
  if (bytes(text) > LIMIT.bytes) return { ok: false, reason: `The schema is larger than ${LIMIT.bytes / 1024} KiB.` }
  const root = JSON.parse(text) as Record<string, unknown>
  let refs = 0

  const walk = (node: unknown, pointer: string, depth: number): string | undefined => {
    if (typeof node === "boolean") return undefined
    if (!record(node)) return `${where(pointer)}: a schema must be an object or a boolean.`
    if (depth > LIMIT.depth) return `${where(pointer)}: schemas nest deeper than ${LIMIT.depth} levels.`
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("x-") || IGNORED.has(key)) continue
      const at = child(pointer, key)
      if (!SUPPORTED.has(key)) return `${where(pointer)}: "${key}" is not supported.`
      const refused = keyword(key, value, at, pointer, depth)
      if (refused) return refused
    }
    return undefined
  }

  const keyword = (key: string, value: unknown, at: string, pointer: string, depth: number): string | undefined => {
    switch (key) {
      case "type": {
        const list = Array.isArray(value) ? value : [value]
        if (list.length === 0 || list.some((item) => typeof item !== "string" || !TYPES.has(item)))
          return `${at}: must be one of ${[...TYPES].join(", ")}, or a list of them.`
        return undefined
      }
      case "properties": {
        if (!record(value)) return `${at}: must be an object.`
        const entries = Object.entries(value)
        if (entries.length > LIMIT.properties) return `${at}: more than ${LIMIT.properties} properties.`
        for (const [name, item] of entries) {
          const refused = walk(item, child(at, name), depth + 1)
          if (refused) return refused
        }
        return undefined
      }
      case "required":
        return Array.isArray(value) && value.every((item) => typeof item === "string")
          ? undefined
          : `${at}: must be a list of property names.`
      case "additionalProperties":
      case "not":
        return walk(value, at, depth + 1)
      case "items":
        return Array.isArray(value)
          ? `${at}: must be one schema; tuple items are not supported.`
          : walk(value, at, depth + 1)
      case "uniqueItems":
      case "nullable":
        return typeof value === "boolean" ? undefined : `${at}: must be true or false.`
      case "enum": {
        if (!Array.isArray(value) || value.length === 0) return `${at}: must be a non-empty list.`
        if (value.length > LIMIT.enum) return `${at}: more than ${LIMIT.enum} values.`
        return value.every((item) => typeof item === "string") ? undefined : `${at}: values must be strings.`
      }
      case "const":
        return typeof value === "string" ? undefined : `${at}: must be a string.`
      case "multipleOf":
        return finite(value) && value > 0 ? undefined : `${at}: must be a number above 0.`
      case "anyOf":
      case "oneOf":
      case "allOf": {
        if (!Array.isArray(value) || value.length === 0) return `${at}: must be a non-empty list of schemas.`
        if (value.length > LIMIT.combiners) return `${at}: more than ${LIMIT.combiners} schemas.`
        for (const [index, item] of value.entries()) {
          const refused = walk(item, child(at, index), depth + 1)
          if (refused) return refused
        }
        return undefined
      }
      case "$ref": {
        if (++refs > LIMIT.refs) return `The schema has more than ${LIMIT.refs} $ref entries.`
        if (typeof value !== "string" || target(root, value) === undefined)
          return `${at}: only "#", "#/$defs/<name>" and "#/definitions/<name>" that exist are supported.`
        return undefined
      }
      case "$defs":
      case "definitions": {
        if (pointer !== "") return `${at}: only the root may hold ${key}.`
        if (!record(value)) return `${at}: must be an object.`
        for (const [name, item] of Object.entries(value)) {
          const refused = walk(item, child(at, name), depth + 1)
          if (refused) return refused
        }
        return undefined
      }
    }
    if ((COUNTS as readonly string[]).includes(key))
      return count(value) ? undefined : `${at}: must be a whole number of 0 or more.`
    if ((BOUNDS as readonly string[]).includes(key)) return finite(value) ? undefined : `${at}: must be a number.`
    return undefined
  }

  const refused = walk(root, "", 1)
  if (refused) return { ok: false, reason: refused }
  if (options.object && root.type !== "object") return { ok: false, reason: 'The root must be "type": "object".' }

  // Follows every $ref with a node budget, so a schema whose references multiply or loop costs a refusal here instead
  // of unbounded work in validate. A reference back into itself is fine once a value was entered on the way (a tree);
  // one reached again without entering a value would loop forever.
  let nodes = 0
  const active = new Map<string, number>()
  const expand = (node: Schema, entered: number): string | undefined => {
    if (++nodes > LIMIT.nodes) return `The schema's references expand past ${LIMIT.nodes} nodes.`
    if (typeof node === "boolean") return undefined
    if (typeof node.$ref === "string") {
      const ref = node.$ref
      const since = active.get(ref)
      if (since === entered) return `The $ref "${ref}" refers back to itself before any value is entered.`
      if (since === undefined) {
        active.set(ref, entered)
        const refused = expand(target(root, ref)!, entered)
        active.delete(ref)
        if (refused) return refused
      }
    }
    const values = [
      ...(record(node.properties) ? Object.values(node.properties) : []),
      ...(record(node.additionalProperties) ? [node.additionalProperties] : []),
      ...(record(node.items) || typeof node.items === "boolean" ? [node.items] : []),
    ] as Schema[]
    for (const item of values) {
      const refused = expand(item, entered + 1)
      if (refused) return refused
    }
    const same = [
      ...COMBINERS.flatMap((key) => (Array.isArray(node[key]) ? (node[key] as Schema[]) : [])),
      ...(node.not !== undefined ? [node.not as Schema] : []),
    ]
    for (const item of same) {
      const refused = expand(item, entered)
      if (refused) return refused
    }
    return undefined
  }
  const expanded = expand(root, 0)
  if (expanded) return { ok: false, reason: expanded }
  return { ok: true, schema: root, normalized: canonical(root) }
}

/** Where a value breaks the limits on its own size, before any schema is applied. */
function measure(value: unknown): Problem | undefined {
  let nodes = 0
  const stack: [unknown, number][] = [[value, 1]]
  while (stack.length > 0) {
    const [item, depth] = stack.pop()!
    if (++nodes > LIMIT.valueNodes) return { path: "", message: `holds more than ${LIMIT.valueNodes} values.` }
    if (depth > LIMIT.valueDepth) return { path: "", message: `nests deeper than ${LIMIT.valueDepth} levels.` }
    if (Array.isArray(item)) for (const entry of item) stack.push([entry, depth + 1])
    else if (record(item)) for (const entry of Object.values(item)) stack.push([entry, depth + 1])
  }
  return undefined
}

function typeOf(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  return typeof value
}

function matches(type: string, value: unknown) {
  switch (type) {
    case "null":
      return value === null
    case "boolean":
      return typeof value === "boolean"
    case "string":
      return typeof value === "string"
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "number":
      return finite(value)
    case "object":
      return record(value)
    case "array":
      return Array.isArray(value)
  }
  return false
}

function quote(value: string) {
  return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)
}

/**
 * Checks a value against a schema `accept` took, and returns at most `LIMIT.problems` problems, each at a JSON pointer.
 * An empty list means the value matches.
 */
export function validate(schema: Record<string, unknown>, value: unknown): Problem[] {
  const big = measure(value)
  if (big) return [big]
  const root = schema
  let work = WORK
  // A string's length and an array's repeated item are read once per check, however many schema nodes visit them, and
  // charged by size, so a schema that fans out over one large value stays within WORK.
  const lengths = new Map<string, number>()
  const repeats = new WeakMap<unknown[], { first: number; index: number } | null>()
  const length = (text: string) => {
    const known = lengths.get(text)
    if (known !== undefined) return known
    work -= Math.ceil(text.length / CHARS_PER_WORK)
    const counted = codePoints(text)
    lengths.set(text, counted)
    return counted
  }
  const repeated = (items: unknown[]) => {
    const known = repeats.get(items)
    if (known !== undefined) return known
    const seen = new Map<string, number>()
    let found: { first: number; index: number } | null = null
    for (const [index, entry] of items.entries()) {
      const key = canonical(entry)
      work -= Math.ceil(key.length / CHARS_PER_WORK)
      const first = seen.get(key)
      if (first !== undefined) {
        found = { first, index }
        break
      }
      seen.set(key, index)
    }
    repeats.set(items, found)
    return found
  }

  // Records problems into `out`, or, with no `out`, stops at the first one: anyOf, oneOf and not only ask whether a
  // branch matches.
  const check = (node: Schema, item: unknown, path: string, out?: Problem[]): boolean => {
    const fail = (message: string, at = path) => {
      if (out && out.length < LIMIT.problems) out.push({ path: at, message })
      return false
    }
    if (--work < 0) {
      work = 0
      if (out && !out.some((problem) => problem.message === "is too complex to check.") && out.length < LIMIT.problems)
        out.push({ path: "", message: "is too complex to check." })
      return false
    }
    if (node === true) return true
    if (node === false) return fail("is not allowed here.")
    if (item === null && node.nullable === true) return true
    let ok = true
    const full = () => out !== undefined && out.length >= LIMIT.problems

    if (node.type !== undefined) {
      const types = (Array.isArray(node.type) ? node.type : [node.type]) as string[]
      if (!types.some((type) => matches(type, item)))
        return fail(`must be ${types.join(" or ")}${node.nullable === true ? " or null" : ""}, not ${typeOf(item)}.`)
    }
    if (typeof node.$ref === "string") {
      const found = target(root, node.$ref)
      if (found !== undefined && !check(found, item, path, out)) {
        ok = false
        if (!out || full()) return false
      }
    }
    if (typeof node.const === "string" && item !== node.const) ok = fail(`must be ${quote(node.const)}.`)
    if (Array.isArray(node.enum) && !(typeof item === "string" && (node.enum as unknown[]).includes(item))) {
      const listed = (node.enum as string[]).slice(0, 10).map(quote).join(", ")
      ok = fail(`must be one of ${listed}${node.enum.length > 10 ? ", …" : ""}.`)
    }
    if (!ok && !out) return false

    if (typeof item === "string" && (count(node.minLength) || count(node.maxLength))) {
      const size = length(item)
      if (count(node.minLength) && size < node.minLength) ok = fail(`must be at least ${node.minLength} characters.`)
      if (count(node.maxLength) && size > node.maxLength) ok = fail(`must be at most ${node.maxLength} characters.`)
    }
    if (typeof item === "number") {
      if (finite(node.minimum) && item < node.minimum) ok = fail(`must be ${node.minimum} or more.`)
      if (finite(node.maximum) && item > node.maximum) ok = fail(`must be ${node.maximum} or less.`)
      if (finite(node.exclusiveMinimum) && item <= node.exclusiveMinimum)
        ok = fail(`must be more than ${node.exclusiveMinimum}.`)
      if (finite(node.exclusiveMaximum) && item >= node.exclusiveMaximum)
        ok = fail(`must be less than ${node.exclusiveMaximum}.`)
      if (finite(node.multipleOf) && node.multipleOf > 0) {
        const ratio = item / node.multipleOf
        if (Math.abs(ratio - Math.round(ratio)) > 1e-9) ok = fail(`must be a multiple of ${node.multipleOf}.`)
      }
    }
    if (!ok && !out) return false

    if (record(item)) {
      const keys = Object.keys(item)
      if (count(node.minProperties) && keys.length < node.minProperties)
        ok = fail(`must have at least ${node.minProperties} properties.`)
      if (count(node.maxProperties) && keys.length > node.maxProperties)
        ok = fail(`must have at most ${node.maxProperties} properties.`)
      const properties = record(node.properties) ? node.properties : {}
      if (Array.isArray(node.required))
        for (const name of node.required as string[])
          if (!Object.hasOwn(item, name)) ok = fail("is required.", child(path, name))
      for (const key of keys) {
        if (full() || (!ok && !out)) return false
        const at = child(path, key)
        if (Object.hasOwn(properties, key)) {
          if (!check(properties[key] as Schema, item[key], at, out)) ok = false
        } else if (node.additionalProperties === false) ok = fail("is not allowed.", at)
        else if (record(node.additionalProperties) && !check(node.additionalProperties, item[key], at, out)) ok = false
      }
    }
    if (Array.isArray(item)) {
      if (count(node.minItems) && item.length < node.minItems) ok = fail(`must have at least ${node.minItems} items.`)
      if (count(node.maxItems) && item.length > node.maxItems) ok = fail(`must have at most ${node.maxItems} items.`)
      if (node.uniqueItems === true) {
        if (item.length > LIMIT.unique)
          ok = fail(`has more than ${LIMIT.unique} items, too many to check that they differ.`)
        else {
          const repeat = repeated(item)
          if (repeat) ok = fail(`repeats item ${repeat.first}; items must differ.`, child(path, repeat.index))
        }
      }
      if (node.items !== undefined)
        for (const [index, entry] of item.entries()) {
          if (full() || (!ok && !out)) return false
          if (!check(node.items as Schema, entry, child(path, index), out)) ok = false
        }
    }
    if (!ok && !out) return false

    if (Array.isArray(node.allOf))
      for (const branch of node.allOf as Schema[]) if (!check(branch, item, path, out)) ok = false
    if (Array.isArray(node.anyOf) && !(node.anyOf as Schema[]).some((branch) => check(branch, item, path)))
      ok = fail(`must match at least one of the ${node.anyOf.length} anyOf schemas.`)
    if (Array.isArray(node.oneOf)) {
      const matched = (node.oneOf as Schema[]).filter((branch) => check(branch, item, path)).length
      if (matched !== 1) ok = fail(`must match exactly one of the ${node.oneOf.length} oneOf schemas, not ${matched}.`)
    }
    if (node.not !== undefined && check(node.not as Schema, item, path)) ok = fail("must not match the not schema.")
    return ok
  }

  const problems: Problem[] = []
  check(root, value, "", problems)
  return problems
}

/** The problems as one line for a model or a person: "/a/0 must be string, not integer.; /b is required." */
export function describe(problems: readonly Problem[]): string {
  return problems
    .map((problem) => {
      const line = `${problem.path || "The value"} ${problem.message}`
      return line.length > 200 ? `${line.slice(0, 199)}…` : line
    })
    .join(" ")
}

/** The fenced code blocks of a text, in order, with each one's language tag. */
function blocks(text: string) {
  const found: { language: string; body: string }[] = []
  let open: { language: string; lines: string[] } | undefined
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!open) {
      if (trimmed.startsWith("```")) open = { language: trimmed.slice(3).trim().toLowerCase(), lines: [] }
      continue
    }
    if (trimmed === "```") {
      found.push({ language: open.language, body: open.lines.join("\n") })
      open = undefined
      continue
    }
    open.lines.push(line)
  }
  return found
}

/**
 * The JSON a text answer carries: its last ```json block, else its last bare ``` block, else the whole text. Used for
 * answers written as text, where no StructuredOutput call carries the value.
 */
export function extract(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const fenced = blocks(text)
  const block = fenced.findLast((item) => item.language === "json") ?? fenced.findLast((item) => item.language === "")
  const source = (block?.body ?? text).trim()
  if (!source) return { ok: false, reason: "The answer holds no JSON." }
  try {
    return { ok: true, value: JSON.parse(source) }
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : "it does not parse"
    return {
      ok: false,
      reason: block
        ? `The JSON block does not parse: ${detail}`
        : `The answer is not JSON and has no \`\`\`json block: ${detail}`,
    }
  }
}

/**
 * Compact JSON with <, >, &, U+2028 and U+2029 escaped, so the text can sit inside markup or a script without closing
 * it, and still parses back to the same value.
 */
export function encode(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029")
}
