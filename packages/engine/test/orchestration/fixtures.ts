import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { WorkflowPlan } from "@vectordevai/core/orchestration/plan"
import { WorkflowSpec } from "@vectordevai/core/orchestration/spec"
import { SessionID } from "@/session/schema"
import { WorkflowLaunch } from "@/orchestration/launch"
import { WorkflowRunner } from "@/orchestration/runner"
import { WorkflowSources } from "@/orchestration/sources"

const agents: WorkflowPlan.Agent[] = [
  { name: "general", allowed: true, writes: true },
  { name: "explore", allowed: true, writes: false },
]
export const base = {
  version: 1,
  title: "Review",
  defaults: { agent: "explore" },
  stages: [{ id: "a", prompt: "Do {{item}}", for_each: { items: [1, 2] } }],
}
const zero = { steps: 0, tokens: 0, spentUsd: 0 }
const tick = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})

export function harness(
  spec: unknown,
  options: {
    seed?: WorkflowRunner.State
    saved?: WorkflowPlan.Options["saved"]
    retryFailed?: boolean
    launch?: (
      request: WorkflowLaunch.Request,
    ) => Effect.Effect<Pick<WorkflowLaunch.Result, "status" | "output" | "error">>
    observe?: () => Effect.Effect<WorkflowRunner.Observation>
    checkpoint?: (state: WorkflowRunner.State) => Effect.Effect<void>
    progress?: () => Effect.Effect<void>
  } = {},
) {
  const parsed = WorkflowSpec.parse(spec)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  const built = WorkflowPlan.build(spec, { agents, cpus: 18, saved: options.saved })
  if (!built.ok) throw new Error(JSON.stringify(built.issues))
  const calls: WorkflowLaunch.Request[] = []
  const checkpoints: WorkflowRunner.State[] = []
  const progress: unknown[] = []
  const writes: unknown[] = []
  const reports: string[] = []
  const sessions = new Map<string, number>(
    Object.entries(options.seed?.sessions ?? {}).map(([id, value]) => [id, value.steps]),
  )
  let next = Math.max(0, ...[...sessions.keys()].map((id) => Number(id.split("_").at(-1)) || 0))
  const artifacts = randomUUID()
  const ops: WorkflowRunner.Ops = {
    initial: (source) =>
      Effect.succeed(
        !source
          ? [{ key: "single", value: null }]
          : "items" in source
            ? source.items.map((value, index) => ({ key: String(index), value }))
            : [],
      ),
    launch: (request, onSession) =>
      Effect.gen(function* () {
        calls.push(request)
        const sessionID = request.sessionID ?? SessionID.make(`ses_workflow_test_${++next}`)
        yield* onSession(sessionID)
        const result = options.launch
          ? yield* options.launch(request)
          : { status: "completed" as const, output: { stage: request.marker.stage, value: request.marker.item } }
        const steps = (sessions.get(sessionID) ?? 0) + 1
        sessions.set(sessionID, steps)
        return {
          ...result,
          sessionID,
          usage: {
            steps,
            cost: steps / 100,
            toolUses: 0,
            total: steps * 10,
            tokens: { input: steps * 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        }
      }),
    observe: options.observe ?? (() => Effect.succeed({ usage: zero })),
    checkpoint: (state) =>
      Effect.sync(() => {
        checkpoints.push(structuredClone(state))
      }).pipe(Effect.andThen(options.checkpoint?.(state) ?? Effect.void)),
    progress: (value) =>
      Effect.sync(() => {
        progress.push(value)
      }).pipe(Effect.andThen(options.progress?.() ?? Effect.void)),
    write: (value) =>
      Effect.sync(() => {
        writes.push(value)
        return `/tmp/workflow-${artifacts}-${writes.length}.json`
      }),
    finish: (report) =>
      Effect.sync(() => {
        reports.push(report)
      }),
  }
  const input: WorkflowRunner.Input = {
    runID: SessionID.make("ses_workflow_run"),
    rootID: SessionID.make("ses_workflow_root"),
    spec: parsed.spec,
    built,
    agents,
    seed: options.seed,
    retryFailed: options.retryFailed,
  }
  return { calls, checkpoints, progress, writes, reports, run: WorkflowRunner.schedule(input, ops).pipe(Effect.scoped) }
}
