import { Effect, Schema } from "effect"
import { WorkflowSpec } from "@vectordevai/core/orchestration/spec"
import { WorkflowMarkers } from "@/orchestration/constants"
import { WorkflowRuns } from "@/orchestration/runs"
import GUIDE from "@/orchestration/guide.txt"
import CONNECTED_GUIDE from "@/orchestration/guide-connected.txt"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { TaskTool } from "./task"
import { Tool } from "./tool"
import { ToolJsonSchema } from "./json-schema"
import DESCRIPTION from "./workflow.txt"

const optional = Schema.optional
const fields = {
  action: optional(Schema.Literals(["run", "validate", "resume", "guide"])).annotate({
    description: "run (default), validate without starting agents, resume a run, or read the guide.",
  }),
  title: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80))),
  name: optional(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/))).annotate({
    description: "Trusted saved workflow name; use either name or spec.",
  }),
  inputs: optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Values for declared workflow inputs; each value is at most 8 KiB of JSON.",
  }),
  run_id: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).annotate({
    description: "Required for resume: the workflow run session ID.",
  }),
  retry_failed: optional(Schema.Boolean).annotate({ description: "resume: retry failed nodes (default true)." }),
}

// Providers see one shallow object. Recursive workflow grammar is documented by
// guide and checked by WorkflowRuns, not expanded into every provider request.
export const PublicParameters = Schema.Struct({
  ...fields,
  spec: optional(Schema.String.check(Schema.isMaxLength(WorkflowSpec.BYTES.model))).annotate({
    description: "WorkflowSpec v1 as JSON text, at most 32 KiB of UTF-8; use either spec or name.",
  }),
})
export const Parameters = Schema.Struct({
  ...fields,
  spec: optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)])),
  // These are engine context, never model-supplied authority or owner options.
  quiet: optional(Schema.Never),
  source: optional(Schema.Never),
  owner: optional(Schema.Never),
  [WorkflowMarkers.USER_START]: optional(Schema.Never),
  [WorkflowMarkers.RUN]: optional(Schema.Never),
  [WorkflowMarkers.AGENT]: optional(Schema.Never),
  [WorkflowMarkers.GUARD_PARENT]: optional(Schema.Never),
})
export type Parameters = typeof Parameters.Type
export type Metadata = {
  action: "run" | "validate" | "resume" | "guide"
  valid?: boolean
  runID?: string
}
export type GetTask = () => Effect.Effect<Tool.InferDef<typeof TaskTool>>

/** The late getter prevents the workflow/task registry dependency from cycling. */
export const make = (task: GetTask) =>
  Tool.define<typeof Parameters, Metadata, WorkflowRuns.Service | RuntimeFlags.Service, "workflow">(
    "workflow",
    Effect.gen(function* () {
      const runs = yield* WorkflowRuns.Service
      const flags = yield* RuntimeFlags.Service
      return {
        description: DESCRIPTION.trim(),
        parameters: Parameters,
        jsonSchema: ToolJsonSchema.fromSchema(PublicParameters),
        execute: (input: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
          Effect.gen(function* () {
            const prepared = yield* Effect.try({ try: () => normalize(input, ctx), catch: (cause) => cause }).pipe(
              Effect.orDie,
            )
            if (prepared.action === "guide")
              return {
                title: "Workflow guide",
                metadata: { action: "guide" as const },
                output: flags.experimentalConnect ? `${GUIDE.trimEnd()}\n\n${CONNECTED_GUIDE}` : GUIDE,
              }
            if (prepared.action === "validate") {
              const result = yield* runs.validate({ ctx, input: prepared.input })
              return {
                title: "Workflow validation",
                metadata: { action: "validate" as const, valid: result.ok },
                output: JSON.stringify(result),
              }
            }
            const result = yield* runs.launch({ ctx, input: prepared.input, task })
            return {
              title: result.title,
              metadata: { action: prepared.action, runID: result.runID },
              output: JSON.stringify(result),
            }
          }).pipe(Effect.orDie),
      }
    }),
  )

/** Bound the actual UTF-8 payload before the engine performs grammar or permission validation. */
export function normalize(input: Parameters, ctx: Pick<Tool.Context, "extra">) {
  const action = input.action ?? "run"
  if (action === "guide") return { action, input: {} } as const
  if (input.spec !== undefined && input.name !== undefined) invalid("Use either spec or name, not both.")
  if (action !== "resume" && input.spec === undefined && input.name === undefined)
    invalid("run and validate require a spec or saved workflow name.")
  if (action === "resume" && !input.run_id) invalid("resume requires run_id.")
  if (action !== "resume" && (input.run_id !== undefined || input.retry_failed !== undefined))
    invalid("run_id and retry_failed are only used by resume.")
  const max = ctx.extra?.[WorkflowMarkers.USER_START] === true ? WorkflowSpec.BYTES.owner : WorkflowSpec.BYTES.model
  const spec =
    input.spec === undefined ? undefined : typeof input.spec === "string" ? input.spec : json(input.spec, max, "spec")
  if (spec !== undefined && (spec.length > max || new TextEncoder().encode(spec).byteLength > max))
    invalid(`spec must be at most ${max / 1024} KiB of UTF-8.`)
  if (input.inputs && Object.keys(input.inputs).length > 16) invalid("inputs can contain at most 16 declared values.")
  const inputs =
    input.inputs === undefined
      ? undefined
      : Object.fromEntries(
          Object.keys(input.inputs).map((name) => {
            const descriptor = Object.getOwnPropertyDescriptor(input.inputs!, name)!
            if (!("value" in descriptor)) invalid(`inputs.${name} cannot be a getter or setter.`)
            return [name, JSON.parse(json(descriptor.value, 8 * 1024, `inputs.${name}`)) as typeof Schema.Json.Type]
          }),
        )
  return {
    action,
    input: {
      ...(spec === undefined ? {} : { spec }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(inputs === undefined ? {} : { inputs }),
      ...(action === "resume" ? { runID: input.run_id!, retryFailed: input.retry_failed ?? true } : {}),
    },
  }
}

function invalid(detail: string): never {
  throw new Tool.InvalidArgumentsError({ tool: "workflow", detail })
}

/** Inspect data descriptors before stringify so runtime object arguments cannot execute getters/toJSON. */
function json(value: unknown, limit: number, label: string): string {
  const stack: { value: unknown; depth: number; leave?: boolean }[] = [{ value, depth: 0 }]
  const active = new Set<object>()
  let bytes = 0
  let nodes = 0
  const add = (value: string) => {
    if (value.length > limit) invalid(`${label} must be at most ${limit / 1024} KiB of JSON.`)
    bytes += new TextEncoder().encode(value).byteLength
    if (bytes > limit) invalid(`${label} must be at most ${limit / 1024} KiB of JSON.`)
  }
  while (stack.length) {
    const current = stack.pop()!
    const item = current.value
    if (current.leave) {
      active.delete(item as object)
      continue
    }
    if (++nodes > 100_000 || current.depth > 64) invalid(`${label} JSON is too deeply nested or has too many values.`)
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      add(JSON.stringify(item))
      continue
    }
    if (typeof item === "string") {
      if (item.length > limit) invalid(`${label} must be at most ${limit / 1024} KiB of JSON.`)
      add(JSON.stringify(item))
      continue
    }
    if (typeof item !== "object" || item === null) invalid(`${label} must contain finite JSON values only.`)
    const array = Array.isArray(item)
    if (
      (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) ||
      Object.getOwnPropertySymbols(item).length
    )
      invalid(`${label} must contain plain JSON objects and arrays.`)
    const custom = Object.getOwnPropertyDescriptor(item, "toJSON")
    if (custom && (!("value" in custom) || typeof custom.value === "function"))
      invalid(`${label} cannot execute a custom JSON conversion.`)
    if (active.has(item)) invalid(`${label} must not contain a cycle.`)
    if (array && item.length > limit) invalid(`${label} has too many JSON values.`)
    const keys = Object.keys(item)
    if (keys.length > limit) invalid(`${label} has too many JSON values.`)
    if (array && keys.length !== item.length) invalid(`${label} arrays must not contain holes or named properties.`)
    active.add(item)
    stack.push({ ...current, leave: true })
    add(array ? "[]" : "{}")
    if (keys.length) add(",".repeat(keys.length - 1))
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (!("value" in descriptor)) invalid(`${label} cannot contain getters or setters.`)
      if (array && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
        invalid(`${label} arrays must not contain named properties.`)
      if (!array) {
        if (key.length > limit) invalid(`${label} contains an oversized JSON key.`)
        add(JSON.stringify(key) + ":")
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 })
    }
  }
  return JSON.stringify(value)
}

export * as WorkflowTool from "./workflow"
