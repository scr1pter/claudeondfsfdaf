import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { WorkflowPlan } from "@vectordevai/core/orchestration/plan"
import { WorkflowSpec } from "@vectordevai/core/orchestration/spec"
import { WorkflowRunner } from "@/orchestration/runner"
import { WorkflowRuns } from "@/orchestration/runs"
import { SessionID } from "@/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { fixture, layer, spec } from "../tool/workflow-fixture"
import { harness } from "./fixtures"

const connected = {
  version: 1,
  title: "Held connected workflow",
  stages: [
    { id: "implement", agent: "explore", prompt: "Must not run before the unsupported review is refused" },
    {
      id: "review",
      connect: { to: "vectorscope", action: "review", input: { target: { kind: "branch", base: "main" } } },
      after: ["implement"],
    },
  ],
}
const agents: WorkflowPlan.Agent[] = [{ name: "explore", allowed: true, writes: false }]
const connections: NonNullable<WorkflowPlan.Options["connections"]> = [
  {
    id: "vectorscope",
    actions: [{ id: "review", title: "Review", effects: ["read"], background: true, result: "review" }],
  },
]

test("a real connected plan is refused structurally before every scheduler source, checkpoint, task and model port", async () => {
  const parsed = WorkflowSpec.parse(connected)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  const built = WorkflowPlan.build(connected, { agents, connections })
  expect(built.ok).toBe(true)
  const calls: string[] = []
  const forbidden = (name: string) =>
    Effect.sync(() => {
      calls.push(name)
      throw new Error(`Unexpected ${name}`)
    })
  const refused = await Effect.runPromise(
    WorkflowRunner.schedule(
      {
        runID: SessionID.make("ses_held_workflow"),
        rootID: SessionID.make("ses_held_root"),
        spec: parsed.spec,
        built,
        agents,
      },
      {
        initial: () => forbidden("source"),
        launch: () => forbidden("task/model"),
        observe: () => forbidden("observation"),
        checkpoint: () => forbidden("checkpoint"),
        progress: () => forbidden("progress"),
        write: () => forbidden("artifact"),
        finish: () => forbidden("finish"),
      },
    ).pipe(Effect.scoped, Effect.flip),
  )
  expect(refused).toBeInstanceOf(WorkflowRunner.ConnectUnavailable)
  expect(refused).toMatchObject({ _tag: "WorkflowConnectUnavailable", code: "unsupported", stage: "review" })
  expect(refused.message).toContain("ancestor budget scopes")
  expect(calls).toEqual([])
})

test("legacy agent-only workflows still execute without any connected member manifest", async () => {
  const run = harness({
    version: 1,
    title: "Legacy reader",
    stages: [{ id: "read", agent: "explore", prompt: "Inspect" }],
  })
  const result = await Effect.runPromise(run.run)
  expect(result.outcome).toBe("completed")
  expect(run.calls).toHaveLength(1)
})

afterEach(disposeAllInstances)
const it = testEffect(layer())
const off = testEffect(layer({ backgroundSubagents: false }))

it.instance(
  "the actual workflow start refuses connected execution before approval, children or provider prompts",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const runs = yield* WorkflowRuns.Service
      const preview = yield* runs.validate({ ctx: f.ctx, input: { spec: JSON.stringify(connected) } })
      expect(preview.ok).toBe(false)
      expect(preview.issues.some((issue) => issue.message.includes("trusted member manifest"))).toBe(true)
      const refused = yield* runs
        .launch({ ctx: f.ctx, input: { spec: JSON.stringify(connected) }, task: f.task })
        .pipe(Effect.flip)
      expect(refused.code).toBe("invalid")
      expect(f.asks).toEqual([])
      expect(f.prompts).toEqual([])
      expect(yield* f.sessions.children(f.parent.id)).toEqual([])
    }),
  { trusted: true },
)

off.instance(
  "default-disabled workflow admission stays disabled before any approval or model",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const runs = yield* WorkflowRuns.Service
      const refused = yield* runs
        .launch({ ctx: f.ctx, input: { spec: JSON.stringify(spec) }, task: f.task })
        .pipe(Effect.flip)
      expect(refused.message).toContain("Background subagents")
      expect(f.asks).toEqual([])
      expect(f.prompts).toEqual([])
    }),
  { trusted: true },
)
