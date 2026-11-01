import { afterEach, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@vectordevai/core/database/database"
import type { SubagentRecord } from "@/agent/subagent-kind"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { TaskManager } from "@/task/manager"
import { formatTasks } from "@/cli/cmd/tasks"
import { TaskNotify } from "@/task/notify"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import type { TaskPromptOps } from "@/tool/task"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { fixture, layer, ref } from "../tool/workflow-fixture"

afterEach(disposeAllInstances)
const it = testEffect(layer())

const child = Effect.fn("WorkflowManagerTest.child")(function* (
  parentID: SessionID,
  input: Partial<SubagentRecord> = {},
) {
  const sessions = yield* Session.Service
  return yield* sessions.create({
    parentID,
    agent: input.workflow?.role === "run" ? "workflow" : "explore",
    title: input.title ?? "Workflow child",
    metadata: {
      subagent: {
        kind: "subagent",
        agent: input.workflow?.role === "run" ? "workflow" : "explore",
        custom: false,
        title: "Workflow child",
        parentSessionID: parentID,
        parentMessageID: MessageID.ascending(),
        model: ref,
        background: true,
        startedAt: Date.now(),
        status: "running",
        attempt: 1,
        runtimeID: SubagentLifecycle.RUNTIME_ID,
        ...input,
      } satisfies SubagentRecord,
    },
  })
})
const run = (parentID: SessionID, input: Partial<SubagentRecord> = {}) =>
  child(parentID, {
    workflow: {
      role: "run",
      title: "Review changes",
      revision: 1,
      progress: {
        report: "Review complete: one finding.",
        agents: { launched: 1, max: 100, running: 1 },
        stages: [{ id: "review", title: "Review", done: 0, failed: 0, skipped: 0, running: 1, waiting: 0 }],
      },
    },
    ...input,
  })
const agent = (runID: SessionID, key: string, input: Partial<SubagentRecord> = {}) =>
  child(runID, {
    workflow: { role: "agent", runID, stage: "review", phase: "", item: key, key },
    ...input,
  })
const refused = Effect.fnUntraced(function* (effect: Effect.Effect<unknown, TaskManager.Error>, message: string) {
  const exit = yield* Effect.exit(effect)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ code: "invalid", message })
})

it.instance("the board exposes one run with child totals, inspect report and no message or generic resume", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const manager = yield* TaskManager.Service
    const coordinator = yield* run(f.parent.id)
    const worker = yield* agent(coordinator.id, "one")
    yield* f.ops.prompt({
      sessionID: worker.id,
      agent: "explore",
      model: ref,
      parts: [{ type: "text", text: "Review" }],
    })
    const listed = yield* manager.list({ sessionID: f.parent.id, descendants: true })
    expect(listed.truncated).toBe(false)
    expect(listed.tasks.map((task) => task.id)).toEqual([coordinator.id])
    expect(listed.tasks[0]).toMatchObject({
      workflow: { role: "run", runID: coordinator.id, stages: [{ id: "review", phase: "" }] },
      usage: { total: 2, steps: 1, toolUses: 0 },
      controls: { inspect: true, message: false, stop: true },
    })
    expect(listed.tasks[0].controls.resume).toBeUndefined()
    expect(listed.tasks[0].controls.background).toBeUndefined()
    const inspected = yield* manager.inspect({ sessionID: f.parent.id, taskID: coordinator.id })
    expect(inspected.output).toBe("Review complete: one finding.")
    const workerInfo = yield* manager.inspect({ sessionID: coordinator.id, taskID: worker.id })
    expect(workerInfo.task).toMatchObject({
      groupID: `workflow:${coordinator.id}`,
      workflow: { role: "agent", item: "one" },
    })
    const before = f.prompts.length
    yield* refused(
      manager.message({ sessionID: f.parent.id, taskID: coordinator.id, text: "Change the plan" }, f.ops),
      "Workflow runs do not take messages. Stop the run, then resume it through workflow with an edited spec.",
    )
    expect(f.prompts).toHaveLength(before)
    expect(yield* f.sessions.messages({ sessionID: coordinator.id })).toEqual([])
  }),
)

it.instance("stopping one run cancels its 300 durable agents without relying on a live coordinator fiber", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const manager = yield* TaskManager.Service
    const coordinator = yield* run(f.parent.id)
    const other = yield* run(f.parent.id)
    const unrelated = yield* agent(other.id, "unrelated")
    const children = yield* Effect.forEach(
      Array.from({ length: 300 }, (_, index) => index),
      (index) => agent(coordinator.id, String(index), { status: index % 2 === 0 ? "queued" : "running" }),
      { concurrency: 4 },
    )
    const cancelled: SessionID[] = []
    const ops: TaskPromptOps = {
      ...f.ops,
      cancel: (id) =>
        Effect.sync(() => {
          cancelled.push(id)
        }),
    }
    const stopped = yield* manager.stop({ sessionID: f.parent.id, taskIDs: [coordinator.id], origin: "user" }, ops)
    expect(stopped.tasks).toHaveLength(301)
    expect(new Set(cancelled)).toEqual(new Set([coordinator.id, ...children.map((item) => item.id)]))
    expect(stopped.tasks.every((task) => task.status === "stopped")).toBe(true)
    expect(SubagentLifecycle.read(yield* f.sessions.get(children[299].id))).toMatchObject({
      status: "cancelled",
      stop: { by: "user" },
    })
    expect(SubagentLifecycle.read(yield* f.sessions.get(unrelated.id))?.status).toBe("running")
    expect(SubagentLifecycle.stopping.size).toBe(0)
    expect(
      (yield* manager.list({ sessionID: f.parent.id, active: true, descendants: true })).tasks.map((task) => task.id),
    ).toEqual([other.id])
  }),
)

it.instance(
  "an explicit workflow agent stop reaches dependent siblings and descendants but leaves other work running",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const manager = yield* TaskManager.Service
      const coordinator = yield* run(f.parent.id)
      const first = yield* agent(coordinator.id, "first")
      const dependent = yield* agent(coordinator.id, "dependent", { dependsOn: [first.id] })
      const unrelated = yield* agent(coordinator.id, "unrelated")
      const descendant = yield* child(first.id)
      const stopped = yield* manager.stop({ sessionID: f.parent.id, taskIDs: [first.id] }, f.ops)
      expect(new Set(stopped.tasks.map((task) => task.id))).toEqual(new Set([first.id, dependent.id, descendant.id]))
      expect(SubagentLifecycle.read(yield* f.sessions.get(coordinator.id))?.status).toBe("running")
      expect(SubagentLifecycle.read(yield* f.sessions.get(unrelated.id))?.status).toBe("running")
    }),
)

it.instance("ordinary dependency edges still select workflow runs, while public selections remain capped at 200", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const manager = yield* TaskManager.Service
    const first = yield* child(f.parent.id)
    const coordinator = yield* run(f.parent.id, { dependsOn: [first.id] })
    const worker = yield* agent(coordinator.id, "dependent")
    yield* refused(
      manager.stop({ sessionID: f.parent.id, taskIDs: Array.from({ length: 201 }, () => first.id) }, f.ops),
      "Choose 1–200 task IDs.",
    )
    expect(SubagentLifecycle.read(yield* f.sessions.get(first.id))?.status).toBe("running")
    const stopped = yield* manager.stop({ sessionID: f.parent.id, taskIDs: [first.id] }, f.ops)
    expect(new Set(stopped.tasks.map((task) => task.id))).toEqual(new Set([first.id, coordinator.id, worker.id]))
  }),
)

it.instance("observing a dead run interrupts its dead agents and preserves agents whose runtime is still alive", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const manager = yield* TaskManager.Service
    const database = yield* Database.Service
    const coordinator = yield* run(f.parent.id, { runtimeID: "previous-engine" })
    const down = yield* agent(coordinator.id, "down", { runtimeID: "previous-engine" })
    const queued = yield* agent(coordinator.id, "queued", { runtimeID: "previous-engine", status: "queued" })
    const live = yield* agent(coordinator.id, "live")
    const finished = yield* agent(coordinator.id, "finished", { status: "completed" })
    yield* database.db.run(sql`UPDATE session SET time_updated = ${Date.now() - SubagentLifecycle.LEGACY_IDLE - 1_000}
      WHERE id IN (${coordinator.id}, ${down.id}, ${queued.id})`)
    const listed = yield* manager.list({ sessionID: f.parent.id, descendants: true })
    expect(listed.tasks).toHaveLength(1)
    expect(listed.tasks[0]).toMatchObject({ status: "stopped", interrupted: { cause: "unknown" } })
    for (const item of [down, queued])
      expect(SubagentLifecycle.read(yield* f.sessions.get(item.id))).toMatchObject({
        status: "cancelled",
        interruption: { cause: "unknown" },
      })
    expect(SubagentLifecycle.read(yield* f.sessions.get(live.id))?.status).toBe("running")
    expect(SubagentLifecycle.read(yield* f.sessions.get(finished.id))?.status).toBe("completed")
  }),
)

it.instance("an unreadable workflow checkpoint leaves usage unknown instead of showing coordinator-only zero", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const manager = yield* TaskManager.Service
    const coordinator = yield* run(f.parent.id, {
      workflow: {
        role: "run",
        title: "Incomplete checkpoint",
        revision: 1,
        progress: { runtime: { version: 99 }, report: "Partial results were retained." },
      },
    })
    const inspected = yield* manager.inspect({ sessionID: f.parent.id, taskID: coordinator.id })
    expect(inspected.task.usage).toBeUndefined()
    expect(inspected.output).toBe("Partial results were retained.")
  }),
)

it.instance("workflow display pairs both canonical token proofs with their own values and retains mixed pricing", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const database = yield* Database.Service
    const manager = yield* TaskManager.Service
    for (const own of [false, true])
      for (const delegated of [false, true])
        for (const ownCodium of [false, true]) {
          const coordinator = yield* run(f.parent.id, {
            workflow: {
              role: "run",
              title: "Accounting",
              revision: 1,
              progress: {
                tokens: { used: 987654, max: 1000000 },
                stages: [],
                agents: { launched: 0, max: 100, running: 0 },
              },
            },
          })
          yield* database.db.run(sql`UPDATE session SET tokens_input = 111, subagent_tokens_input = 222,
        cost = 0.12, subagent_cost = 0.03, unpriced_steps = 1, subagent_unpriced_steps = 1,
        codium_steps = ${ownCodium ? 1 : 0}, subagent_codium_steps = ${ownCodium ? 0 : 1},
        tokens_own_only = ${own ? 1 : 0}, subagent_tokens_own_only = ${delegated ? 1 : 0}
        WHERE id = ${coordinator.id}`)
          const result = yield* manager.inspect({ sessionID: f.parent.id, taskID: coordinator.id })
          expect(result.task).toMatchObject({
            billing: "codium",
            costKind: "unknown",
            usage: { cost: 0.15, tokensOwnOnly: own && delegated },
          })
          expect(result.task.workflow?.tokens).toEqual(own && delegated ? { used: 333, max: 1000000 } : undefined)
          const display = formatTasks([result.task])
          expect(display).toContain("$0.1500 + unpriced + Codium")
          expect(display.includes("333 tokens")).toBe(own && delegated)
          const note = TaskNotify.render({
            taskID: coordinator.id,
            title: "Accounting",
            state: "completed",
            usage: result.task.usage,
            text: "Report",
            workflow: true,
          })
          expect(note.includes('tokens="333"')).toBe(own && delegated)
          expect(note).not.toContain("987654")
        }
  }),
)

it.instance("inspect keeps an ordinary task's final answer and a workflow report's header", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const manager = yield* TaskManager.Service
    const ordinary = yield* child(f.parent.id)
    const reply = yield* f.ops.prompt({
      sessionID: ordinary.id,
      agent: "explore",
      model: ref,
      parts: [{ type: "text", text: "Inspect" }],
    })
    const text = reply.parts.find((part) => part.type === "text")!
    const output = `EARLY_ORDINARY_MARKER${"x".repeat(5000)}FINAL_ORDINARY_ANSWER`
    yield* f.sessions.updatePart({ ...text, text: output })
    const report = `WORKFLOW_HEADER_AND_RESULTS${"y".repeat(5000)}WORKFLOW_END`
    const coordinator = yield* run(f.parent.id, {
      workflow: { role: "run", title: "Review", revision: 1, progress: { report } },
    })
    const normal = yield* manager.inspect({ sessionID: f.parent.id, taskID: ordinary.id })
    expect(normal.output).toBe(output.slice(-4096))
    expect(normal.output).not.toContain("EARLY_ORDINARY_MARKER")
    expect(normal.output).toContain("FINAL_ORDINARY_ANSWER")
    expect(normal.truncated).toBe(true)
    const workflow = yield* manager.inspect({ sessionID: f.parent.id, taskID: coordinator.id })
    expect(workflow.output).toBe(report.slice(0, 4096))
    expect(workflow.output).toContain("WORKFLOW_HEADER_AND_RESULTS")
    expect(workflow.output).not.toContain("WORKFLOW_END")
    expect(workflow.truncated).toBe(true)
  }),
)

it.instance("a proven pure Codium workflow has no token gauge", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const database = yield* Database.Service
    const manager = yield* TaskManager.Service
    const coordinator = yield* run(f.parent.id, {
      workflow: { role: "run", title: "Codium", revision: 1, progress: { tokens: { used: 987654, max: 1000 } } },
    })
    yield* database.db.run(sql`UPDATE session SET codium_steps = 1, unpriced_steps = 1,
      tokens_own_only = 1, subagent_tokens_own_only = 1 WHERE id = ${coordinator.id}`)
    const result = yield* manager.inspect({ sessionID: f.parent.id, taskID: coordinator.id })
    expect(result.task.usage).toMatchObject({ total: 0, codiumSteps: 1, tokensOwnOnly: true })
    expect(result.task.workflow?.tokens).toBeUndefined()
    expect(formatTasks([result.task])).toContain("Codium")
    expect(formatTasks([result.task])).not.toContain(" tokens")
  }),
)
