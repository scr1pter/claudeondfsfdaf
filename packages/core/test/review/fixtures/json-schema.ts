// A structural JSON Schema check shared by the review tests (schema.test.ts, guardrail.test.ts). The branch has no JSON
// Schema validator, so this checks a value against the keywords the review schemas use, as the VS-27a deviations entry
// says. maxLength counts code points, as JSON Schema does.

export function violations(schema: Record<string, unknown>, value: unknown, at = "$"): string[] {
  const kind = Array.isArray(value)
    ? "array"
    : value === null
      ? "null"
      : Number.isInteger(value)
        ? "integer"
        : typeof value
  if (schema.type !== kind && !(schema.type === "number" && kind === "integer"))
    return [`${at} is not ${String(schema.type)}`]
  const number = typeof value === "number" ? value : undefined
  const string = typeof value === "string" ? value : undefined
  const list = Array.isArray(value) ? value : undefined
  const record = isRecord(value) ? value : undefined
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const items = isRecord(schema.items) ? schema.items : undefined
  const required = Array.isArray(schema.required) ? schema.required : []
  return [
    ...[
      Array.isArray(schema.enum) && !schema.enum.includes(value) ? "is not in its enum" : "",
      typeof schema.minimum === "number" && number !== undefined && number < schema.minimum
        ? "is under its minimum"
        : "",
      typeof schema.maximum === "number" && number !== undefined && number > schema.maximum
        ? "is over its maximum"
        : "",
      typeof schema.maxLength === "number" && string !== undefined && Array.from(string).length > schema.maxLength
        ? "is too long"
        : "",
      typeof schema.minItems === "number" && list && list.length < schema.minItems ? "has too few items" : "",
      typeof schema.maxItems === "number" && list && list.length > schema.maxItems ? "has too many items" : "",
      ...required.map((key) =>
        record && typeof key === "string" && !Object.hasOwn(record, key) ? `lacks ${key}` : "",
      ),
    ]
      .filter(Boolean)
      .map((problem) => `${at} ${problem}`),
    ...Object.entries(record ?? {}).flatMap(([key, inner]) => {
      const nested = properties[key]
      return isRecord(nested) ? violations(nested, inner, `${at}.${key}`) : []
    }),
    ...(list && items ? list.flatMap((inner, index) => violations(items, inner, `${at}[${index}]`)) : []),
  ]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
