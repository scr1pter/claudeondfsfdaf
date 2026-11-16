export * as WorkflowSpec from "./spec"

import { Option, Result, Schema, SchemaIssue } from "effect"
import { Connect } from "@vectordevai/schema/connect"
import { JsonSchemaCheck } from "../json-schema-check"

const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const integer = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }))
const list = <S extends Schema.Top>(schema: S, max: number, min = 0) =>
  Schema.Array(schema).check(Schema.isMinLength(min), Schema.isMaxLength(max))
const optional = Schema.optional
export const StageID = Schema.String.check(Schema.isPattern(/^(?!(?:constructor|prototype)$)[a-z][a-z0-9_-]{0,31}$/))
const InputID = Schema.String.check(Schema.isPattern(/^(?!(?:constructor|prototype)$)[a-z][a-z0-9_]{0,31}$/))
const SavedName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/))
const Path = text(512)
export const Settings = Schema.Struct({
  agent: optional(text(80)),
  model: optional(text(256)),
  effort: optional(Schema.Literals(["default", "low", "medium", "high"])),
  isolation: optional(Schema.Literals(["none", "worktree"])),
})
export const Limits = Schema.Struct({
  max_agents: optional(integer(1, 1000)),
  concurrency: optional(integer(1, 16)),
  usd: optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  tokens: optional(integer(1)),
  steps: optional(integer(1)),
  per_agent_usd: optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  per_agent_steps: optional(integer(1)),
  minutes: optional(integer(1, 1440)),
})
const comparator = { path: optional(Path) }
export const Comparison = Schema.Union([
  Schema.Struct({ ...comparator, equals: Schema.Json }),
  Schema.Struct({ ...comparator, not_equals: Schema.Json }),
  Schema.Struct({ ...comparator, in: list(Schema.Json, 1000) }),
  Schema.Struct({ ...comparator, exists: Schema.Boolean }),
  Schema.Struct({ ...comparator, contains: Schema.Json }),
  Schema.Struct({ ...comparator, gt: Schema.Finite }),
  Schema.Struct({ ...comparator, gte: Schema.Finite }),
  Schema.Struct({ ...comparator, lt: Schema.Finite }),
  Schema.Struct({ ...comparator, lte: Schema.Finite }),
])
export const Predicate = Schema.Union([
  Comparison,
  Schema.Struct({ all: list(Comparison, 32, 1) }),
  Schema.Struct({ any: list(Comparison, 32, 1) }),
  Schema.Struct({ not: Comparison }),
])
export const Source = Schema.Union([
  Schema.Struct({ items: list(Schema.Json, 1000) }),
  Schema.Struct({
    from: Schema.Union([StageID, list(StageID, 32, 1)]),
    path: optional(Path),
    where: optional(Predicate),
    dedupe_by: optional(Path),
    sort_by: optional(Path),
    desc: optional(Schema.Boolean),
    limit: optional(integer(1, 1000)),
    wait: optional(Schema.Literals(["each", "all"])),
    batch: optional(integer(1, 100)),
  }),
  Schema.Struct({
    files: Schema.Struct({
      glob: Path,
      exclude: optional(list(Path, 32)),
      limit: optional(integer(1, 1000)),
      hidden: optional(Schema.Boolean),
    }),
  }),
  Schema.Struct({
    changed_files: Schema.Struct({
      base: optional(text(256)),
      include: optional(list(Path, 32)),
      limit: optional(integer(1, 1000)),
      include_deleted: optional(Schema.Boolean),
    }),
  }),
])
const Output = Schema.Struct({ schema: Schema.Record(Schema.String, Schema.Json) })
export const Verify = Schema.Struct({
  ...Settings.fields,
  prompt: text(16 * 1024),
  output: Output,
  until: Predicate,
  max_rounds: optional(integer(1, 5)),
  on_fail: optional(Schema.Literals(["keep", "drop", "fail"])),
})
export const AgentStage = Schema.Struct({
  ...Settings.fields,
  id: StageID,
  title: optional(text(60)),
  phase: optional(text(40)),
  prompt: text(16 * 1024),
  for_each: optional(Source),
  after: optional(list(StageID, 32)),
  if: optional(Predicate),
  when: optional(Predicate),
  output: optional(Output),
  owned_paths: optional(list(Path, 16)),
  success_criteria: optional(list(text(4096), 8)),
  verify: optional(Verify),
  retries: optional(integer(0, 2)),
  on_error: optional(Schema.Literals(["skip", "fail"])),
})
export const NestedStage = Schema.Struct({
  id: StageID,
  workflow: SavedName,
  inputs: optional(Schema.Record(InputID, Schema.Json).check(Schema.isMaxProperties(16))),
  after: optional(list(StageID, 32)),
})
export const ConnectStage = Schema.Struct({
  id: StageID,
  title: optional(text(60)),
  after: optional(list(StageID, 32)),
  if: optional(Predicate),
  connect: Schema.Struct({
    to: Connect.MemberID,
    action: Connect.ActionID,
    input: optional(
      Schema.Struct({
        target: Connect.ReviewInput.fields.target,
        security: Connect.ReviewInput.fields.security,
        budget: Connect.ReviewInput.fields.budget,
        since: Connect.ReviewInput.fields.since,
      }),
    ),
  }),
})
export const Spec = Schema.Struct({
  version: Schema.Literal(1),
  title: text(80),
  description: optional(text(500)),
  inputs: optional(
    Schema.Record(
      InputID,
      Schema.Struct({
        description: optional(text(500)),
        default: optional(Schema.Json),
        required: optional(Schema.Boolean),
      }),
    ).check(Schema.isMaxProperties(16)),
  ),
  defaults: optional(Settings),
  limits: optional(Limits),
  stages: list(Schema.Union([AgentStage, NestedStage, ConnectStage]), 32, 1),
  result: optional(
    Schema.Struct({
      stages: optional(list(StageID, 32)),
      where: optional(Predicate),
      max_items: optional(integer(1, 1000)),
    }),
  ),
}).annotate({ identifier: "WorkflowSpec" })
export type Spec = typeof Spec.Type
export type AgentStage = typeof AgentStage.Type
export type NestedStage = typeof NestedStage.Type
export type ConnectStage = typeof ConnectStage.Type
export type ExecutableStage = AgentStage | ConnectStage
export type Stage = Spec["stages"][number]
export type Source = typeof Source.Type
export type Predicate = typeof Predicate.Type
export type Comparison = typeof Comparison.Type
export type Settings = typeof Settings.Type
export type Limits = typeof Limits.Type
export type Issue = { readonly path: string; readonly message: string }
export type Parsed =
  | { readonly ok: true; readonly spec: Spec; readonly issues: readonly Issue[] }
  | { readonly ok: false; readonly issues: readonly Issue[] }
export const BYTES = { model: 32 * 1024, saved: 256 * 1024, owner: 256 * 1024 } as const

/** Bounds are checked before schema traversal; JSON input never executes workflow code. */
export function parse(value: unknown, options: { source?: keyof typeof BYTES } = {}): Parsed {
  const source = options.source ?? "owner"
  const encoded = typeof value === "string" ? value : serialize(value)
  if (encoded === undefined) return { ok: false, issues: [{ path: "", message: "The workflow must be JSON." }] }
  if (new TextEncoder().encode(encoded).byteLength > BYTES[source])
    return {
      ok: false,
      issues: [{ path: "", message: `A ${source} workflow must be at most ${BYTES[source] / 1024} KiB.` }],
    }
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(encoded)
  if (Option.isNone(json)) return { ok: false, issues: [{ path: "", message: "The workflow must be valid JSON." }] }
  const depth = checkDepth(json.value)
  if (depth) return { ok: false, issues: [{ path: "", message: depth }] }
  const decoded = Schema.decodeUnknownResult(Spec, { onExcessProperty: "error", errors: "all" })(json.value)
  if (Result.isFailure(decoded)) {
    const extra = unknownKeys(json.value)
    const issues = SchemaIssue.makeFormatterStandardSchemaV1()(decoded.failure.issue).issues.map((issue) => ({
      path:
        "/" +
        (issue.path ?? [])
          .map((part) =>
            String(typeof part === "object" ? part.key : part)
              .replaceAll("~", "~0")
              .replaceAll("/", "~1"),
          )
          .join("/"),
      message: issue.message,
    }))
    return { ok: false, issues: [...extra, ...issues].slice(0, 32) }
  }
  const spec = decoded.success
  const issues: Issue[] = []
  spec.stages.forEach((stage, i) => {
    if ("connect" in stage) {
      const strings = (value: unknown): string[] =>
        typeof value === "string"
          ? [value]
          : value && typeof value === "object"
            ? Object.values(value).flatMap(strings)
            : []
      if (strings(stage.connect.input).some((value) => value.includes("{{") || value.includes("}}")))
        issues.push({
          path: `/stages/${i}/connect/input`,
          message: "Connected stage inputs are literal JSON; template references are unavailable.",
        })
      return
    }
    if (!("prompt" in stage)) return
    if (new TextEncoder().encode(stage.prompt).byteLength > 16 * 1024)
      issues.push({ path: `/stages/${i}/prompt`, message: "Prompt exceeds 16 KiB." })
    if (stage.for_each && "items" in stage.for_each) {
      if (source === "model" && stage.for_each.items.length > 200)
        issues.push({
          path: `/stages/${i}/for_each/items`,
          message: "Model workflows allow at most 200 literal items; use files, changed_files or from.",
        })
      stage.for_each.items.forEach((item, j) => {
        if (new TextEncoder().encode(JSON.stringify(item)).byteLength > 4096)
          issues.push({ path: `/stages/${i}/for_each/items/${j}`, message: "Literal item exceeds 4 KiB." })
      })
    }
    for (const [name, output] of [
      ["output", stage.output],
      ["verify/output", stage.verify?.output],
    ] as const) {
      if (!output) continue
      const accepted = JsonSchemaCheck.accept(output.schema, { object: true })
      if (!accepted.ok) issues.push({ path: `/stages/${i}/${name}/schema`, message: accepted.reason })
    }
    if (stage.verify && new TextEncoder().encode(stage.verify.prompt).byteLength > 16 * 1024)
      issues.push({ path: `/stages/${i}/verify/prompt`, message: "Prompt exceeds 16 KiB." })
  })
  return issues.length ? { ok: false, issues } : { ok: true, spec, issues: [] }
}

function serialize(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}
function checkDepth(value: unknown): string | undefined {
  const stack = [{ value, depth: 0 }]
  let nodes = 0
  while (stack.length) {
    const entry = stack.pop()!
    if (++nodes > 100_000 || entry.depth > 64) return "The workflow JSON is too deeply nested or has too many values."
    if (entry.value && typeof entry.value === "object")
      for (const child of Object.values(entry.value)) stack.push({ value: child, depth: entry.depth + 1 })
  }
}

const settings = ["agent", "model", "effort", "isolation"]
const comparisons = ["path", "equals", "not_equals", "in", "gt", "gte", "lt", "lte", "exists", "contains"]
function unknownKeys(value: unknown): Issue[] {
  const issues: Issue[] = []
  const visit = (input: unknown, keys: readonly string[], at: string) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return
    for (const key of Object.keys(input))
      if (!keys.includes(key)) {
        const near = keys.find((candidate) => distance(candidate, key) <= 2)
        issues.push({ path: `${at}/${key}`, message: `Unknown key "${key}".${near ? ` Did you mean "${near}"?` : ""}` })
      }
  }
  const predicate = (input: unknown, at: string) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return
    const p = input as Record<string, unknown>
    const kind = ["all", "any", "not"].find((key) => Object.hasOwn(p, key))
    visit(input, kind ? [kind] : comparisons, at)
    if (kind === "not") visit(p.not, comparisons, `${at}/not`)
    if ((kind === "all" || kind === "any") && Array.isArray(p[kind]))
      p[kind].forEach((c, i) => visit(c, comparisons, `${at}/${kind}/${i}`))
  }
  visit(value, ["version", "title", "description", "inputs", "defaults", "limits", "stages", "result"], "")
  if (!value || typeof value !== "object") return issues
  const root = value as Record<string, unknown>
  visit(root.defaults, settings, "/defaults")
  visit(root.limits, Object.keys(Limits.fields), "/limits")
  visit(root.result, ["stages", "where", "max_items"], "/result")
  if (root.result && typeof root.result === "object")
    predicate((root.result as Record<string, unknown>).where, "/result/where")
  if (root.inputs && typeof root.inputs === "object")
    Object.entries(root.inputs).forEach(([key, item]) =>
      visit(item, ["description", "default", "required"], `/inputs/${key}`),
    )
  if (!Array.isArray(root.stages)) return issues
  root.stages.forEach((stage: Record<string, unknown>, i) => {
    if (!stage || typeof stage !== "object") return
    const at = `/stages/${i}`
    visit(
      stage,
      "workflow" in stage
        ? Object.keys(NestedStage.fields)
        : "connect" in stage
          ? Object.keys(ConnectStage.fields)
          : Object.keys(AgentStage.fields),
      at,
    )
    if ("connect" in stage) {
      visit(stage.connect, ["to", "action", "input"], `${at}/connect`)
      if (stage.connect && typeof stage.connect === "object")
        visit(
          (stage.connect as Record<string, unknown>).input,
          ["target", "security", "budget", "since"],
          `${at}/connect/input`,
        )
    }
    visit(stage.output, ["schema"], `${at}/output`)
    predicate(stage.if, `${at}/if`)
    predicate(stage.when, `${at}/when`)
    if (stage.verify && typeof stage.verify === "object") {
      const verify = stage.verify as Record<string, unknown>
      visit(verify, Object.keys(Verify.fields), `${at}/verify`)
      visit(verify.output, ["schema"], `${at}/verify/output`)
      predicate(verify.until, `${at}/verify/until`)
    }
    if (stage.for_each && typeof stage.for_each === "object") {
      const source = stage.for_each as Record<string, unknown>
      const kind = ["items", "from", "files", "changed_files"].find((key) => key in source)
      visit(
        source,
        kind === "from"
          ? ["from", "path", "where", "dedupe_by", "sort_by", "desc", "limit", "wait", "batch"]
          : kind
            ? [kind]
            : [],
        `${at}/for_each`,
      )
      visit(source.files, ["glob", "exclude", "limit", "hidden"], `${at}/for_each/files`)
      visit(source.changed_files, ["base", "include", "limit", "include_deleted"], `${at}/for_each/changed_files`)
      predicate(source.where, `${at}/for_each/where`)
    }
  })
  return issues
}
function distance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])))
    row = next
  }
  return row[b.length]
}
