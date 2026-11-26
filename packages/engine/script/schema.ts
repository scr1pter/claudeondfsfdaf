#!/usr/bin/env bun

import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { ConfigResearchV1 } from "@vectordevai/core/v1/config/research"
import { TuiConfig } from "@vectordevai/tui/config"
import { Schema } from "effect"

type JsonSchema = Record<string, unknown>

function generateEffect(schema: Schema.Top) {
  const document = Schema.toJsonSchemaDocument(schema)
  const normalized = normalize({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    $defs: document.definitions,
  })
  if (!isRecord(normalized)) throw new Error("schema generator produced a non-object schema")
  normalized.allowComments = true
  normalized.allowTrailingCommas = true
  return normalized
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!isRecord(value)) return value

  const schema = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))

  if (Array.isArray(schema.anyOf)) {
    const anyOf = schema.anyOf.filter((item) => !isRecord(item) || item.type !== "null")
    if (anyOf.length !== schema.anyOf.length) {
      const { anyOf: _, ...rest } = schema
      if (anyOf.length === 1 && isRecord(anyOf[0])) return normalize({ ...anyOf[0], ...rest })
      return { ...rest, anyOf }
    }
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length === 1 && isRecord(schema.allOf[0])) {
    const { allOf: _, ...rest } = schema
    return normalize({ ...schema.allOf[0], ...rest })
  }

  if (schema.type === "integer" && schema.maximum === undefined) {
    return { ...schema, maximum: Number.MAX_SAFE_INTEGER }
  }

  return schema
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const configFile = process.argv[2]
const tuiFile = process.argv[3]

// Keys Vector loads and drops are not in the schema it decodes with, so the published schema adds them, marked
// deprecated: an earlier version's research block then checks without an error, as Vector loads it.
function withRetired(schema: JsonSchema) {
  const defs = schema.$defs
  const research = isRecord(defs) ? defs.ResearchConfig : undefined
  if (!isRecord(research) || !isRecord(research.properties)) throw new Error("schema generator lost ResearchConfig")
  research.properties = { ...research.properties, ...ConfigResearchV1.RETIRED }
  return schema
}

// VS-23d (SF-15): the user config's `review` block ships hidden until the owner decides it is user-facing (I-14, Q16).
// Vector decodes it, but the published schema leaves it out, so an editor offers no completion for it. Un-hiding it is
// deleting this step and regenerating. A generator that no longer produces either part fails here, not silently.
function withHidden(schema: JsonSchema) {
  const defs = schema.$defs
  const config = isRecord(defs) ? defs.Config : undefined
  if (!isRecord(defs) || !isRecord(config) || !isRecord(config.properties) || !config.properties.review)
    throw new Error("schema generator lost Config.review")
  if (!defs.GlobalReviewConfig) throw new Error("schema generator lost GlobalReviewConfig")
  const { review: _, ...properties } = config.properties
  config.properties = properties
  delete defs.GlobalReviewConfig
  return schema
}

console.log(configFile)
await Bun.write(configFile, JSON.stringify(withHidden(withRetired(generateEffect(ConfigV1.Info))), null, 2))

if (tuiFile) {
  console.log(tuiFile)
  await Bun.write(tuiFile, JSON.stringify(generateEffect(TuiConfig.Info), null, 2))
}
