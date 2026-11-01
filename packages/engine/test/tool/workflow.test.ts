import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { WorkflowPlan } from "@vectordevai/core/orchestration/plan"
import { WorkflowSpec } from "@vectordevai/core/orchestration/spec"
import { Agent } from "@/agent/agent"
import { WorkflowMarkers } from "@/orchestration/constants"
import { WorkflowRuns } from "@/orchestration/runs"
import GUIDE from "@/orchestration/guide.txt"
import { SessionID, MessageID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Truncate } from "@/tool/truncate"
import { WorkflowTool } from "@/tool/workflow"
import DESCRIPTION from "@/tool/workflow.txt"
import { examples } from "../../../core/test/orchestration/examples"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const spec = {
  version: 1,
  title: "Fixture workflow",
  stages: [{ id: "review", agent: "explore", prompt: "Review the change" }],
}
const plan = WorkflowPlan.build(spec, { agents: [{ name: "explore", allowed: true, writes: false }] }).plan!
const ctx = (extra?: Tool.Context["extra"]): Tool.Context => ({
  sessionID: SessionID.make("ses_workflow_tool_parent"),
  messageID: MessageID.make("msg_workflow_tool_parent"),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  extra,
  metadata: () => Effect.void,
  ask: () => Effect.die(new Error("Only the run service may ask for workflow approval")),
})
const fixture = Effect.fnUntraced(function* () {
  const validations: Parameters<WorkflowRuns.Interface["validate"]>[0][] = []
  const launches: Parameters<WorkflowRuns.Interface["launch"]>[0][] = []
  let tasks = 0
  const task: WorkflowTool.GetTask = () =>
    Effect.sync(() => {
      tasks++
      throw new Error("Only the run service may initialize the task tool")
    })
  const tool = yield* WorkflowTool.make(task).pipe(
    Effect.flatMap(Tool.init),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(WorkflowRuns.Service, {
          validate: (request) =>
            Effect.sync(() => {
              validations.push(request)
              return { ok: true, issues: [], warnings: [], plan }
            }),
          launch: (request) =>
            Effect.sync(() => {
              launches.push(request)
              return { runID: "ses_started_workflow", title: "Fixture workflow", plan }
            }),
        }),
        Layer.mock(Truncate.Service, { output: (text) => Effect.succeed({ content: text, truncated: false }) }),
        Layer.mock(Agent.Service, {
          get: () => Effect.succeed({ name: "build", mode: "primary", permission: [], options: {} }),
        }),
      ),
    ),
  )
  return { tool, task, validations, launches, tasks: () => tasks }
})
const refused = Effect.fnUntraced(function* (effect: Effect.Effect<unknown>) {
  const exit = yield* Effect.exit(effect)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("Invalid workflow input was accepted")
  const error = exit.cause.reasons.find(Cause.isDieReason)?.defect
  expect(error).toBeInstanceOf(Tool.InvalidArgumentsError)
  return error as Tool.InvalidArgumentsError
})

describe("workflow tool parameters and guide", () => {
  test("advertises one shallow object with string specs and no recursive workflow grammar", () => {
    const schema = ToolJsonSchema.fromSchema(WorkflowTool.PublicParameters)
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        action: { enum: ["run", "validate", "resume", "guide"] },
        title: { type: "string", maxLength: 80 },
        spec: { type: "string", maxLength: 32768 },
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
        inputs: { type: "object" },
        run_id: { type: "string" },
        retry_failed: { type: "boolean" },
      },
    })
    expect(JSON.stringify(schema)).not.toContain('"$ref"')
    expect(schema).not.toHaveProperty("anyOf")
    expect(schema).not.toHaveProperty("$defs")
    expect(schema).toMatchSnapshot()
  })

  test("keeps the fixed description near 900 characters without embedding the guide", () => {
    expect(DESCRIPTION.trim().length).toBeGreaterThan(800)
    expect(DESCRIPTION.trim().length).toBeLessThan(1050)
    expect(DESCRIPTION).not.toContain("```json")
    expect(DESCRIPTION.trim()).toMatchSnapshot()
  })

  it.effect("returns the existing guide and its same three complete examples without validating or launching", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const result = yield* f.tool.execute({ action: "guide" }, ctx())
      expect(result.output).toBe(GUIDE)
      expect(result.metadata).toMatchObject({ action: "guide" })
      const specifications = [...result.output.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
        JSON.parse(match[1]),
      )
      expect(specifications).toEqual(examples.map((example) => example.spec))
      expect(specifications).toHaveLength(3)
      for (const value of specifications) expect(WorkflowSpec.parse(value).ok).toBe(true)
      expect(f.validations).toEqual([])
      expect(f.launches).toEqual([])
      expect(f.tasks()).toBe(0)
    }),
  )

  it.effect(
    "defaults to run, accepts runtime object specs, and forwards the original context and late task getter",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const context = ctx({ promptOps: { fixture: true } })
        const result = yield* f.tool.execute({ spec, title: "Display title", inputs: { target: "src" } }, context)
        expect(f.launches).toHaveLength(1)
        expect(f.launches[0].ctx).toBe(context)
        expect(f.launches[0].task).toBe(f.task)
        expect(f.launches[0].input).toEqual({
          spec: JSON.stringify(spec),
          title: "Display title",
          inputs: { target: "src" },
        })
        expect(JSON.parse(result.output)).toEqual(
          JSON.parse(JSON.stringify({ runID: "ses_started_workflow", title: "Fixture workflow", plan })),
        )
        expect(result.metadata).toMatchObject({ action: "run", runID: "ses_started_workflow" })
        expect(f.tasks()).toBe(0)
      }),
  )

  it.effect(
    "validate reaches the engine without launching, and resume defaults retryFailed while retaining explicit false",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const context = ctx()
        const validation = yield* f.tool.execute(
          { action: "validate", name: "review-changes", inputs: { target: ["a", "b"] } },
          context,
        )
        expect(JSON.parse(validation.output)).toEqual(
          JSON.parse(JSON.stringify({ ok: true, issues: [], warnings: [], plan })),
        )
        expect(f.validations).toHaveLength(1)
        expect(f.validations[0]).toEqual({
          ctx: context,
          input: { name: "review-changes", inputs: { target: ["a", "b"] } },
        })
        expect(f.launches).toEqual([])
        yield* f.tool.execute({ action: "resume", run_id: "ses_old_run" }, context)
        yield* f.tool.execute(
          { action: "resume", run_id: "ses_old_run", spec: JSON.stringify(spec), retry_failed: false },
          context,
        )
        expect(f.launches.map((call) => call.input)).toEqual([
          { runID: "ses_old_run", retryFailed: true },
          { runID: "ses_old_run", spec: JSON.stringify(spec), retryFailed: false },
        ])
        expect(f.tasks()).toBe(0)
      }),
  )

  it.effect("rejects invalid action shapes and public attempts to supply engine authority before invoking runs", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const invalid: unknown[] = [
        {},
        { action: "validate" },
        { action: "resume" },
        { action: "resume", run_id: "" },
        { action: "unknown" },
        { spec, name: "review" },
        { spec, run_id: "ses_run" },
        { spec, retry_failed: true },
        { spec, title: "x".repeat(81) },
        { name: "UpperCase" },
        { name: "../outside" },
        { spec: [] },
        { spec, quiet: true },
        { spec, source: "owner" },
        { spec, owner: true },
        ...[WorkflowMarkers.USER_START, WorkflowMarkers.RUN, WorkflowMarkers.AGENT, WorkflowMarkers.GUARD_PARENT].map(
          (key) => ({ spec, [key]: true }),
        ),
      ]
      for (const input of invalid) yield* refused(f.tool.execute(input as WorkflowTool.Parameters, ctx()))
      expect(f.validations).toEqual([])
      expect(f.launches).toEqual([])
    }),
  )

  it.effect("enforces the actual model UTF-8 spec boundary before the run service", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const encoded = JSON.stringify(spec)
      const exact = " ".repeat(32768 - Buffer.byteLength(encoded)) + encoded
      yield* f.tool.execute({ spec: exact }, ctx())
      expect(f.launches).toHaveLength(1)
      const error = yield* refused(f.tool.execute({ spec: exact + "é" }, ctx()))
      expect(error.detail).toContain("32 KiB")
      yield* refused(f.tool.execute({ spec: { ...spec, padding: "😀".repeat(8192) } }, ctx()))
      expect(f.launches).toHaveLength(1)
    }),
  )

  it.effect("allows the owner size ceiling only through a true trusted context marker", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const encoded = JSON.stringify(spec)
      const exact = " ".repeat(256 * 1024 - Buffer.byteLength(encoded)) + encoded
      for (const extra of [undefined, { [WorkflowMarkers.USER_START]: "true" }, { [WorkflowMarkers.USER_START]: 1 }])
        yield* refused(f.tool.execute({ spec: exact }, ctx(extra)))
      const context = ctx({ [WorkflowMarkers.USER_START]: true })
      yield* f.tool.execute({ spec: exact }, context)
      expect(f.launches).toHaveLength(1)
      expect(f.launches[0].ctx).toBe(context)
      expect(f.launches[0].input).not.toHaveProperty("source")
      expect(f.launches[0].input).not.toHaveProperty("owner")
      expect(f.launches[0].input).not.toHaveProperty("quiet")
      yield* refused(f.tool.execute({ spec: exact + "a" }, context))
      expect(f.launches).toHaveLength(1)
    }),
  )

  it.effect("bounds each supplied input by JSON UTF-8 bytes, including escapes", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      for (const value of ["é".repeat(4095), '"'.repeat(4095)]) {
        expect(Buffer.byteLength(JSON.stringify(value))).toBe(8192)
        yield* f.tool.execute({ spec, inputs: { target: value } }, ctx())
        const error = yield* refused(f.tool.execute({ spec, inputs: { target: value + "a" } }, ctx()))
        expect(error.detail).toContain("8 KiB")
      }
      yield* refused(
        f.tool.execute(
          { spec, inputs: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`input${index}`, index])) },
          ctx(),
        ),
      )
      expect(f.launches).toHaveLength(2)
    }),
  )

  test("runtime normalization refuses non-JSON input without executing getters or custom serialization", () => {
    let calls = 0
    const getter = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        calls++
        return "unsafe"
      },
    })
    const conversion = Object.defineProperty({}, "toJSON", {
      value: () => {
        calls++
        return "unsafe"
      },
    })
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    let deep: unknown = null
    for (let index = 0; index < 66; index++) deep = [deep]
    for (const value of [getter, conversion, cycle, deep, NaN, Infinity, undefined, new Date(0), new Array(2)])
      expect(() => WorkflowTool.normalize({ spec, inputs: { target: value } }, ctx())).toThrow(
        Tool.InvalidArgumentsError,
      )
    expect(calls).toBe(0)
    expect(Schema.decodeUnknownSync(WorkflowTool.Parameters)({ action: "guide" })).toEqual({ action: "guide" })
  })
})
