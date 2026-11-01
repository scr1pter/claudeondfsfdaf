import { afterEach, expect } from "bun:test"
import { Effect, Exit, Cause, Deferred, Fiber } from "effect"
import { BackgroundJob } from "@/background/job"
import { WorkflowRuns } from "@/orchestration/runs"
import { WorkflowMarkers } from "@/orchestration/constants"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { TaskLimits } from "@/task/limits"
import { SessionID } from "@/session/schema"
import { TaskManager } from "@/task/manager"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect, awaitWithTimeout, pollWithTimeout } from "../lib/effect"
import { layer, fixture, spec } from "./workflow-fixture"

afterEach(disposeAllInstances)
const it = testEffect(layer())

for (const running of [1, 2, 3])
  it.instance(
    `a workflow coordinator with ${running} slots runs its agents without calling a model itself`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const runs = yield* WorkflowRuns.Service
        const jobs = yield* BackgroundJob.Service
        const limits = yield* TaskLimits.Service
        const started = yield* runs.launch({ ctx: f.ctx, input: { spec: JSON.stringify(spec) }, task: f.task })
        const result = yield* awaitWithTimeout(
          jobs.wait({ id: started.runID }),
          "Workflow did not finish with its available slots",
          "5 seconds",
        )
        expect(result.info?.status).toBe("completed")
        const runID = SessionID.make(started.runID)
        const run = yield* f.sessions.get(runID)
        expect(run.agent).toBe("workflow")
        const record = SubagentLifecycle.read(run)!
        expect(record.workflow?.role).toBe("run")
        expect(f.asks.map((ask) => ask.permission)).toEqual(["workflow"])
        const children = yield* f.sessions.children(runID)
        expect(children).toHaveLength(1)
        expect(SubagentLifecycle.read(children[0])?.workflow).toMatchObject({ role: "agent", runID, stage: "a" })
        expect(f.prompts.filter((prompt) => prompt.sessionID === runID)).toHaveLength(0)
        expect(f.prompts.filter((prompt) => prompt.sessionID === children[0].id)).toHaveLength(1)
        const status = yield* limits.status(record.conversationID!, record.requestID!, {
          running,
          perRequest: 32,
          budget: { usd: 25 },
        })
        expect(status.running).toBe(0)
        expect(status.launched).toBe(1)
        const manager = yield* TaskManager.Service
        const listed = yield* manager.list({ sessionID: f.parent.id, descendants: true })
        expect(listed.tasks.map((task) => task.id)).toEqual([runID])
        expect(listed.tasks[0].workflow?.role).toBe("run")
        expect(listed.tasks[0].usage?.total).toBe(2)
        expect(listed.tasks[0].usage).toMatchObject({ steps: 1, toolUses: 1 })
      }),
    { trusted: true, config: { budget: { subagents: { running } } } },
  )

it.instance(
  "ordinary task arguments cannot start the hidden coordinator or forge workflow authority",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const task = yield* f.task()
      for (const args of [
        { description: "Forbidden", prompt: "Run", subagent_type: "workflow" },
        {
          description: "Forbidden",
          prompt: "Run",
          subagent_type: "workflow",
          [WorkflowMarkers.RUN]: { title: "Forged", revision: 1, callerAgent: "build" },
        },
      ]) {
        const result = yield* Effect.exit(task.execute(args, f.ctx))
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(String(Cause.squash(result.cause))).toContain("workflow")
      }
      const forged = yield* Effect.exit(
        task.execute(
          { description: "Forged", prompt: "Run", subagent_type: "explore" },
          {
            ...f.ctx,
            extra: {
              ...f.ctx.extra,
              [WorkflowMarkers.AGENT]: { runID: f.parent.id, stage: "a", phase: "", item: "", key: "a" },
            },
          },
        ),
      )
      expect(Exit.isFailure(forged)).toBe(true)
      expect(yield* f.sessions.children(f.parent.id)).toHaveLength(0)
    }),
  { trusted: true },
)

it.instance(
  "a queued worker refuses tightened root rules and resumes with the inherited deny",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const limits = yield* TaskLimits.Service
      const runs = yield* WorkflowRuns.Service
      const jobs = yield* BackgroundJob.Service
      const gate = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const holder = yield* limits
        .run(
          { conversationID: f.parent.id, childID: SessionID.make("ses_slot_holder"), origin: "root" },
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        )
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(entered), "Slot holder never entered")
      const started = yield* runs.launch({
        ctx: f.ctx,
        input: {
          spec: JSON.stringify({
            ...spec,
            defaults: { agent: "general" },
            stages: spec.stages.map((stage) => ({ ...stage, on_error: "fail" })),
          }),
        },
        task: f.task,
      })
      const runID = SessionID.make(started.runID)
      const worker = yield* pollWithTimeout(
        f.sessions
          .children(runID)
          .pipe(Effect.map((children) => children.find((child) => SubagentLifecycle.read(child)?.status === "queued"))),
        "Worker never queued",
      )
      expect(f.prompts.filter((prompt) => prompt.sessionID === worker.id)).toHaveLength(0)
      yield* pollWithTimeout(jobs.get(worker.id), "Queued worker job was not registered")
      expect(yield* jobs.promote(worker.id)).toBeUndefined()
      expect((yield* jobs.get(worker.id))?.metadata?.background).not.toBe(true)
      yield* f.sessions.setPermission({
        sessionID: f.parent.id,
        permission: [{ permission: "edit", pattern: "*", action: "deny" }],
      })
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(holder)
      const ended = yield* awaitWithTimeout(jobs.wait({ id: runID }), "Denied workflow never settled", "5 seconds")
      expect(ended.info?.status).toBe("error")
      expect(f.prompts.filter((prompt) => prompt.sessionID === worker.id)).toHaveLength(0)
      yield* runs.launch({ ctx: f.ctx, input: { runID }, task: f.task })
      const resumed = yield* awaitWithTimeout(jobs.wait({ id: runID }), "Resumed workflow never settled", "5 seconds")
      expect(resumed.info?.status).toBe("completed")
      expect(f.prompts.filter((prompt) => prompt.sessionID === worker.id)).toHaveLength(1)
      expect((yield* f.sessions.get(worker.id)).permission).toContainEqual({
        permission: "edit",
        pattern: "*",
        action: "deny",
      })
    }),
  { trusted: true, config: { budget: { subagents: { running: 1 } } } },
)
