import { afterEach, describe, expect } from "bun:test"
import path from "node:path"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, FileSystem, Stream } from "effect"
import { TestClock } from "effect/testing"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { LayerNodePlatform } from "@vectordevai/core/effect/app-node-platform"
import { ModelV2 } from "@vectordevai/core/model"
import { WorkflowPlan } from "@vectordevai/core/orchestration/plan"
import { WorkflowSpec } from "@vectordevai/core/orchestration/spec"
import { WorkflowTemplate } from "@vectordevai/core/orchestration/template"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { SubagentRecord, SubagentUsage } from "@/agent/subagent-kind"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { WorkflowMarkers } from "@/orchestration/constants"
import { WorkflowRuntime } from "@/orchestration/runtime"
import type { WorkflowRunner } from "@/orchestration/runner"
import { WorkflowSources } from "@/orchestration/sources"
import { WorkflowState } from "@/orchestration/state"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import type { TaskPromptOps } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

afterEach(disposeAllInstances)
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      Database.node,
      SessionProjector.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      SpendGuard.node,
      Truncate.node,
      WorkflowSources.node,
      Git.node,
      LayerNodePlatform.filesystem,
    ]),
  ),
)
const model = { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("workflow-runtime-fixture") }
const agents: WorkflowPlan.Agent[] = [{ name: "explore", allowed: true, writes: false }]
const base = {
  version: 1,
  title: "Runtime fixture",
  defaults: { agent: "explore" },
  limits: { concurrency: 1, max_agents: 20, steps: 100, usd: 100, per_agent_usd: 20, per_agent_steps: 20 },
  stages: [{ id: "a", prompt: "Produce an answer" }],
}
const zero = (): WorkflowRunner.Counters => ({ launched: 0, steps: 0, tokens: 0, spentUsd: 0, elapsedMs: 0 })
const billed = (cost = 0, steps = 1, codium = false): SubagentUsage => ({
  cost,
  steps,
  total: codium ? 0 : steps * 15,
  toolUses: 0,
  tokens: {
    input: codium ? 0 : steps * 10,
    output: codium ? 0 : steps * 5,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
  unpricedSteps: codium ? steps : 0,
  codiumSteps: codium ? steps : 0,
})
type Call = {
  args: Parameters<WorkflowRuntime.Input["task"]["execute"]>[0]
  context: Tool.Context
  marker: WorkflowMarkers.Agent
  child: SessionID
  scopes: readonly SpendGuard.ScopeSnapshot[]
}
type Options = {
  readonly cpus?: number
  readonly spec?: unknown
  readonly saved?: WorkflowPlan.Options["saved"]
  readonly cost?: number
  readonly steps?: number
  readonly terminal?: SubagentUsage
  readonly missingUsage?: boolean
  readonly codium?: boolean
  readonly duplicateStep?: boolean
  readonly output?: string
  readonly runUsd?: number
  readonly delegatedUsd?: number
  readonly afterSteps?: (call: Call) => Effect.Effect<void>
  readonly beforeCallback?: (call: Call) => Effect.Effect<void>
}

/** Provider execution is injected; session events, projections, files and budgets are real. */
const fixture = Effect.fnUntraced(function* (options: Options = {}) {
  const sessions = yield* Session.Service
  const events = yield* EventV2Bridge.Service
  const guard = yield* SpendGuard.Service
  const truncate = yield* Truncate.Service
  const sources = yield* WorkflowSources.Service
  const fs = yield* FileSystem.FileSystem
  const instance = yield* TestInstance
  const parent = yield* sessions.create({ title: "Runtime parent" })
  const parentMessage = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: parent.id,
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  const run = yield* sessions.create({
    parentID: parent.id,
    title: "Runtime run",
    agent: WorkflowMarkers.WORKFLOW_AGENT,
    metadata: {
      [SubagentLifecycle.METADATA_KEY]: {
        kind: "subagent",
        custom: false,
        agent: WorkflowMarkers.WORKFLOW_AGENT,
        title: "Runtime run",
        parentSessionID: parent.id,
        rootSessionID: parent.id,
        parentMessageID: parentMessage.id,
        callID: "runtime-run",
        model,
        background: false,
        status: "running",
        startedAt: Date.now(),
        runtimeID: "runtime-test",
        attempt: 1,
        workflow: { role: "run", title: "Runtime fixture", revision: 1, progress: {} },
      } satisfies SubagentRecord,
    },
  })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: run.id,
    agent: "workflow",
    model,
    time: { created: Date.now() },
  })
  yield* guard.begin(parent.id, { usd: 1000, steps: 1000 })
  const link = () =>
    guard.link(run.id, parent.id, {
      renew: true,
      budget: { usd: options.runUsd ?? 100, steps: 100 },
      delegated: { id: `${run.id}:delegated`, budget: { usd: options.delegatedUsd ?? 100, steps: 100 } },
    })
  yield* link()
  const calls: Call[] = []
  const cancelled: SessionID[] = []
  const written: string[] = []
  yield* Effect.addFinalizer(() =>
    Effect.forEach(written, (path) => fs.remove(path).pipe(Effect.catch(() => Effect.void)), { discard: true }),
  )
  const ops: TaskPromptOps = {
    cancel: (id) =>
      Effect.gen(function* () {
        cancelled.push(id)
        yield* SubagentLifecycle.write(sessions, id, { status: "cancelled" })
      }).pipe(Effect.orDie),
    prompt: () => Effect.die(new Error("Runtime fixture cannot call a model provider")),
    resolvePromptParts: () => Effect.die(new Error("Runtime fixture cannot resolve provider prompts")),
  }
  const task: WorkflowRuntime.Input["task"] = {
    execute: (args, context) =>
      Effect.gen(function* () {
        const title = args.description ?? "Workflow child"
        const marker = context.extra?.[WorkflowMarkers.AGENT] as WorkflowMarkers.Agent
        const guardParent = context.extra?.[WorkflowMarkers.GUARD_PARENT]
        if (!marker || marker.runID !== run.id || typeof guardParent !== "string")
          return yield* Effect.die(new Error("Runtime did not provide trusted child ownership and guard lineage"))
        const child = args.task_id
          ? yield* sessions.get(SessionID.make(args.task_id))
          : yield* sessions.create({
              parentID: run.id,
              agent: "explore",
              metadata: {
                [SubagentLifecycle.METADATA_KEY]: {
                  kind: "subagent",
                  custom: false,
                  agent: "explore",
                  title,
                  parentSessionID: run.id,
                  rootSessionID: parent.id,
                  parentMessageID: context.messageID,
                  callID: context.callID,
                  model,
                  background: false,
                  status: "running",
                  startedAt: Date.now(),
                  runtimeID: "runtime-test",
                  attempt: 1,
                  workflow: { role: "agent", ...marker, output: args.output_schema ? "structured" : "text" },
                } satisfies SubagentRecord,
              },
            })
        if (args.task_id)
          yield* SubagentLifecycle.write(sessions, child.id, { status: "running", completedAt: undefined })
        yield* guard.link(child.id, SessionID.make(guardParent), { budget: args.budget })
        const call: Call = { args, context, marker, child: child.id, scopes: yield* guard.scopes(child.id) }
        calls.push(call)
        if (options.beforeCallback) yield* options.beforeCallback(call)
        yield* context.metadata({ title, metadata: { sessionId: child.id } })
        const prompt = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: child.id,
          agent: "explore",
          model,
          time: { created: Date.now() },
        })
        const reported = options.terminal ?? billed(options.cost, options.steps, options.codium)
        const answer = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: child.id,
          parentID: prompt.id,
          agent: "explore",
          mode: "explore",
          modelID: model.modelID,
          providerID: model.providerID,
          path: { cwd: instance.directory, root: instance.directory },
          cost: reported.cost,
          tokens: reported.tokens,
          time: { created: Date.now(), completed: Date.now() },
          finish: "stop",
        } satisfies SessionV1.Assistant)
        for (let index = 0; index < (options.steps ?? 1); index++) {
          const cost = (options.cost ?? 0) / (options.steps ?? 1)
          yield* guard.record(child.id, {
            costKind: options.codium ? "codium" : "priced",
            costUsd: cost,
            contextTokens: 15,
            cachedTokens: 0,
            continues: false,
            tools: [],
            patched: false,
          })
          const part = yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: child.id,
            messageID: answer.id,
            type: "step-finish",
            reason: "stop",
            cost,
            tokens: billed(0).tokens,
            ...(options.codium ? { unpriced: true, billing: "codium" as const } : {}),
          } satisfies SessionV1.StepFinishPart)
          if (options.duplicateStep) yield* sessions.updatePart(part)
        }
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: child.id,
          messageID: answer.id,
          type: "text",
          text: options.output ?? "Saved runtime answer",
        })
        if (options.afterSteps) yield* options.afterSteps(call)
        yield* SubagentLifecycle.write(sessions, child.id, {
          status: "completed",
          usage: options.missingUsage ? undefined : reported,
        })
        return {
          title,
          output: "Wrapped result",
          metadata: {
            parentSessionId: run.id,
            sessionId: child.id,
            projectId: run.projectID,
            directory: run.directory,
            model,
            modelSource: "call" as const,
            kind: "subagent" as const,
            agent: "explore",
            custom: false,
            title,
            parentMessageId: context.messageID,
            startedAt: Date.now(),
            batchID: `${run.id}:${context.callID}`,
            attempt: 1,
            status: "completed" as const,
            truncated: false,
          },
        }
      }).pipe(Effect.orDie),
  }
  const execute = (spec: unknown = options.spec ?? base) =>
    Effect.gen(function* () {
      const parsed = WorkflowSpec.parse(spec, { source: "owner" })
      const built = WorkflowPlan.build(spec, { agents, saved: options.saved, source: "owner", cpus: options.cpus ?? 2 })
      if (!parsed.ok || !built.ok) return yield* Effect.die(new Error(JSON.stringify({ parsed, built })))
      return yield* WorkflowRuntime.run({
        spec: parsed.spec,
        built,
        agents,
        rootID: parent.id,
        runID: run.id,
        sessions,
        events,
        guard,
        sources,
        fs,
        task,
        ops,
        truncate: {
          write: (text) => truncate.write(text).pipe(Effect.tap((path) => Effect.sync(() => written.push(path)))),
        },
        message: {
          parentID: user.id,
          modelID: model.modelID,
          providerID: model.providerID,
          path: { cwd: instance.directory, root: instance.directory },
        },
        ask: () => Effect.die(new Error("Fixture task cannot ask for provider or execution permissions")),
      })
    }).pipe(Effect.scoped)
  const saveRaw = (runtime: unknown) =>
    SubagentLifecycle.modify(sessions, run.id, (record) => {
      if (record.workflow?.role !== "run") throw new Error("Missing run record")
      return {
        value: true,
        patch: { workflow: { ...record.workflow, progress: { ...record.workflow.progress, runtime } } },
      }
    })
  const save = (state: WorkflowRunner.State) => WorkflowState.encode(state).pipe(Effect.flatMap(saveRaw))
  return { sessions, events, guard, fs, instance, parent, run, calls, cancelled, written, execute, save, saveRaw, link }
})

describe("workflow runtime persistence and accounting", () => {
  it.instance("missing settled usage stops admission even when partial step events were observed", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        missingUsage: true,
        spec: {
          ...base,
          stages: [...base.stages, { id: "b", after: ["a"], prompt: "Must wait for reliable accounting" }],
        },
      })
      const result = yield* f.execute()
      expect(result.outcome).toBe("failed")
      expect(result.state.uncertain).toBe(true)
      expect(f.calls).toHaveLength(1)
      expect(result.report).toContain("usage could not be read")
    }),
  )

  it.instance("completes through real task parts and persists a zero-cost runner report", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const result = yield* f.execute()
      expect(result.outcome).toBe("completed")
      expect(f.calls).toHaveLength(1)
      const owner = yield* f.sessions.get(f.run.id)
      const record = SubagentLifecycle.read(owner)!
      if (record.workflow?.role !== "run") throw new Error("Missing workflow record")
      expect(record.workflow.progress.report).toBe(result.report)
      const stored = yield* WorkflowState.decode(record.workflow.progress.runtime)
      expect(stored.nodes[0].status).toBe("completed")
      expect(stored.nodes[0].outputMessageID).toBeDefined()
      const messages = yield* f.sessions.messages({ sessionID: f.run.id })
      const assistants = messages.filter((message) => message.info.role === "assistant")
      expect(
        assistants.every(
          (message) => message.info.role === "assistant" && message.info.cost === 0 && message.info.tokens.input === 0,
        ),
      ).toBe(true)
      expect(
        assistants
          .flatMap((message) => message.parts)
          .some((part) => part.type === "text" && part.text === result.report),
      ).toBe(true)
      expect(
        assistants
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool")
          .every((part) => part.state.status === "completed"),
      ).toBe(true)
    }),
  )

  it.instance(
    "event accounting deduplicates updated parts and takes maxima with stale terminal usage and rollups",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ steps: 3, cost: 3, terminal: billed(1, 1), duplicateStep: true })
        const first = yield* f.execute()
        expect(first.state.usage).toMatchObject({ steps: 3, tokens: 45, spentUsd: 3 })
        expect((yield* f.sessions.get(f.run.id)).subagentCost).toBe(3)
        expect(first.state.sessions[f.calls[0].child]).toMatchObject({ cost: 3, steps: 3, total: 45 })
        const resumed = yield* f.execute()
        expect(f.calls).toHaveLength(1)
        expect(resumed.state.usage).toMatchObject({ steps: 3, tokens: 45, spentUsd: 3 })
      }),
  )

  it.instance("live step events stop additional work while the task is still executing", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        cost: 1,
        afterSteps: () => Effect.never,
        spec: {
          ...base,
          limits: { ...base.limits, tokens: 10 },
          stages: [...base.stages, { id: "b", after: ["a"], prompt: "Must not launch" }],
        },
      })
      const result = yield* f.execute().pipe(Effect.timeout("5 seconds"))
      expect(result.outcome).toBe("failed")
      expect(f.calls).toHaveLength(1)
      expect(f.cancelled).toEqual([f.calls[0].child])
      expect(result.state.usage.spentUsd).toBe(1)
    }),
  )

  it.instance("runtime preserves canonical token proof but cannot certify a larger forged saved subtotal", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ cost: 1 })
      const first = yield* f.execute()
      const id = f.calls[0].child
      expect(first.state.sessions[id]).toMatchObject({ total: 15, tokensOwnOnly: true })
      const owner = SubagentLifecycle.read(yield* f.sessions.get(f.run.id))!
      if (owner.workflow?.role !== "run") throw new Error("Missing workflow")
      expect((yield* WorkflowState.decode(owner.workflow.progress.runtime)).sessions[id].tokensOwnOnly).toBe(true)
      yield* f.save({
        ...first.state,
        sessions: {
          ...first.state.sessions,
          [id]: {
            ...first.state.sessions[id],
            total: 1000005,
            tokensOwnOnly: true,
            tokens: { ...first.state.sessions[id].tokens, input: 1000000 },
          },
        },
      })
      const resumed = yield* f.execute()
      expect(f.calls).toHaveLength(1)
      expect(resumed.state.sessions[id]).toMatchObject({ total: 1000005, tokensOwnOnly: false })
      expect(resumed.state.usage.tokens).toBe(1000005)
    }),
  )

  it.instance("Codium accounting stays distinct from unknown pricing and does not reintroduce token totals", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ codium: true, steps: 2 })
      const result = yield* f.execute()
      expect(result.state.usage.tokens).toBe(0)
      expect(result.state.sessions[f.calls[0].child]).toMatchObject({
        cost: 0,
        total: 0,
        steps: 2,
        unpricedSteps: 2,
        codiumSteps: 2,
      })
      expect(result.report).toContain("Codium")
      expect(result.report).not.toContain("$0")
      const resumed = yield* f.execute()
      expect(resumed.state.usage.tokens).toBe(0)
      expect(f.calls).toHaveLength(1)
    }),
  )

  it.instance("retains a higher saved run counter when per-session accounting is stale", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ cost: 3, steps: 3 })
      const first = yield* f.execute()
      yield* f.save({ ...first.state, usage: { ...first.state.usage, spentUsd: 5, steps: 5, tokens: 75 } })
      const resumed = yield* f.execute()
      expect(resumed.state.usage).toMatchObject({ spentUsd: 5, steps: 5, tokens: 75 })
      expect(f.calls).toHaveLength(1)
      const owner = SubagentLifecycle.read(yield* f.sessions.get(f.run.id))!
      if (owner.workflow?.role !== "run") throw new Error("Missing workflow")
      expect((yield* WorkflowState.decode(owner.workflow.progress.runtime)).usage.spentUsd).toBe(5)
    }),
  )

  it.instance("recovers a completed child by its exact launch key after a crash before the metadata callback", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ output: "Long immutable answer ".repeat(200) })
      const first = yield* f.execute()
      const prior = first.state.nodes[0]
      yield* f.save({
        ...first.state,
        nodes: [
          {
            ...prior,
            status: "running",
            final: false,
            execution: "producer",
            sessionID: undefined,
            output: undefined,
            outputMessageID: undefined,
            settledOrder: undefined,
            pendingLaunch: { key: f.calls[0].marker.key, verifier: false, round: 0 },
          },
        ],
      })
      const resumed = yield* f.execute()
      expect(f.calls).toHaveLength(1)
      expect(resumed.results).toEqual(first.results)
      expect(resumed.state.usage.launched).toBe(1)
      expect(resumed.state.nodes[0].sessionID).toBe(f.calls[0].child)
      expect(resumed.state.nodes[0].outputMessageID).toBe(prior.outputMessageID)
    }),
  )

  it.instance("releases an unused launch reservation when no child was created", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const first = yield* f.execute()
      yield* f.sessions.remove(f.calls[0].child)
      yield* f.save({
        nodes: [
          {
            ...first.state.nodes[0],
            status: "running",
            final: false,
            execution: "producer",
            sessionID: undefined,
            output: undefined,
            outputMessageID: undefined,
            settledOrder: undefined,
            pendingLaunch: { key: f.calls[0].marker.key, verifier: false, round: 0 },
          },
        ],
        usage: { ...zero(), launched: 1 },
        groups: {},
        sessions: {},
        sessionGroups: {},
      })
      const resumed = yield* f.execute({ ...base, limits: { ...base.limits, max_agents: 1 } })
      expect(resumed.outcome).toBe("completed")
      expect(f.calls).toHaveLength(2)
      expect(resumed.state.usage.launched).toBe(1)
      expect(resumed.state.nodes[0].sessionID).not.toBe(f.calls[0].child)
    }),
  )

  for (const damage of ["deleted", "edited"] as const)
    it.instance(`regenerates ${damage} output artifacts from saved immutable answers`, () =>
      Effect.gen(function* () {
        const f = yield* fixture({ output: "Pinned answer ".repeat(300) })
        const first = yield* f.execute()
        const path = first.state.files!.a.path
        if (damage === "deleted") yield* f.fs.remove(path)
        else yield* f.fs.writeFileString(path, '["tampered artifact"]')
        const resumed = yield* f.execute()
        expect(f.calls).toHaveLength(1)
        expect(resumed.state.files!.a.path).not.toBe(path)
        expect(JSON.parse(yield* f.fs.readFileString(resumed.state.files!.a.path))).toEqual(first.results)
        expect(resumed.results).toEqual(first.results)
      }),
    )

  it.instance("refuses malformed state and missing immutable answers before any new task launch", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ output: "Pinned answer ".repeat(300) })
      yield* f.saveRaw({ version: 999 })
      expect(Exit.isFailure(yield* Effect.exit(f.execute()))).toBe(true)
      expect(f.calls).toHaveLength(0)
      yield* f.saveRaw(undefined)
      const first = yield* f.execute()
      yield* f.sessions.removeMessage({ sessionID: f.calls[0].child, messageID: first.state.nodes[0].outputMessageID! })
      const failed = yield* Effect.exit(f.execute())
      expect(Exit.isFailure(failed)).toBe(true)
      if (Exit.isFailure(failed)) expect(Cause.pretty(failed.cause)).toContain("could not be read")
      expect(f.calls).toHaveLength(1)
      yield* f.save({ ...first.state, nodes: first.state.nodes.map((node) => ({ ...node, sessionID: f.run.id })) })
      expect(Exit.isFailure(yield* Effect.exit(f.execute()))).toBe(true)
      expect(f.calls).toHaveLength(1)
    }),
  )

  it.instance("rejects ambiguous launch ownership instead of choosing one child", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const first = yield* f.execute()
      const child = yield* f.sessions.get(f.calls[0].child)
      yield* f.sessions.create({ parentID: f.run.id, agent: "explore", metadata: child.metadata })
      yield* f.save({
        ...first.state,
        nodes: [
          {
            ...first.state.nodes[0],
            status: "running",
            final: false,
            sessionID: undefined,
            output: undefined,
            outputMessageID: undefined,
            pendingLaunch: { key: f.calls[0].marker.key, verifier: false, round: 0 },
          },
        ],
      })
      const failed = yield* Effect.exit(f.execute())
      expect(Exit.isFailure(failed)).toBe(true)
      if (Exit.isFailure(failed)) expect(Cause.pretty(failed.cause)).toContain("Multiple workflow children")
      expect(f.calls).toHaveLength(1)
    }),
  )

  for (const cap of ["run", "delegated"] as const)
    it.instance(`preserves an exhausted ${cap} guard scope across resume`, () =>
      Effect.gen(function* () {
        const f = yield* fixture({ cost: 1, ...(cap === "run" ? { runUsd: 1 } : { delegatedUsd: 1 }) })
        yield* f.execute()
        const resumed = yield* f.execute({
          ...base,
          stages: [...base.stages, { id: "b", prompt: "New work after exhaustion" }],
        })
        expect(resumed.outcome).toBe("failed")
        expect(f.calls).toHaveLength(1)
        expect(resumed.state.usage.spentUsd).toBe(1)
      }),
    )

  for (const restart of ["warm", "cold"] as const)
    it.instance(`${restart} nested resume subtracts prior spend from the private shared group cap`, () =>
      Effect.gen(function* () {
        const saved = {
          child: {
            ...base,
            title: "Nested",
            limits: { ...base.limits, usd: 5 },
            stages: [{ id: "a", prompt: "First work" }],
          },
        }
        const spec = { ...base, stages: [{ id: "nested", workflow: "child" }] }
        const f = yield* fixture({ spec, saved, cost: 3 })
        yield* f.execute()
        const priorParent = f.calls[0].context.extra?.[WorkflowMarkers.GUARD_PARENT]
        if (restart === "cold") {
          yield* f.guard.release(f.calls[0].child)
          yield* f.guard.unlink(f.calls[0].child)
          yield* f.guard.release(f.run.id)
          yield* f.guard.unlink(f.run.id)
          yield* f.guard.end(f.parent.id)
          yield* f.guard.begin(f.parent.id, { usd: 1000, steps: 1000 })
          yield* f.link()
        }
        saved.child.stages.push({ id: "b", prompt: "More work" })
        const resumed = yield* f.execute()
        expect(f.calls.map((call) => call.marker.stage)).toEqual(["nested.a", "nested.b"])
        const parent = f.calls[1].context.extra?.[WorkflowMarkers.GUARD_PARENT]
        expect(parent).toMatch(/^ses_workflow_group_/)
        expect(parent).not.toBe(priorParent)
        expect(f.calls[1].scopes.find((scope) => scope.id === parent)?.budget.usd).toBe(2)
        expect(resumed.state.groups.nested.spentUsd).toBe(6)
      }),
    )

  it.instance("exhausted saved group counters block only that group and preserve independent outer work", () =>
    Effect.gen(function* () {
      const saved = {
        child: {
          ...base,
          title: "Nested",
          limits: { ...base.limits, usd: 5 },
          stages: [{ id: "a", prompt: "Nested work" }],
        },
      }
      const spec = { ...base, stages: [{ id: "nested", workflow: "child" }] }
      const f = yield* fixture({ spec, saved, cost: 3 })
      const first = yield* f.execute()
      const originalParent = f.calls[0].context.extra?.[WorkflowMarkers.GUARD_PARENT]
      expect(originalParent).toMatch(/^ses_workflow_group_/)
      expect(first.state.groups.nested.spentUsd).toBe(3)
      yield* f.save({
        ...first.state,
        groups: { nested: { ...first.state.groups.nested, spentUsd: 5 } },
        nodes: first.state.nodes.map((node) => ({
          ...node,
          status: "pending",
          final: false,
          sessionID: undefined,
          output: undefined,
          outputMessageID: undefined,
          execution: "producer",
        })),
      })
      const resumed = yield* f.execute({
        ...spec,
        stages: [...spec.stages, { id: "outer", prompt: "Independent work" }],
      })
      expect(resumed.outcome).toBe("failed")
      expect(f.calls.map((call) => call.marker.stage)).toEqual(["nested.a", "outer"])
      expect(f.calls[1].context.extra?.[WorkflowMarkers.GUARD_PARENT]).toBe(f.run.id)
      expect(resumed.state.groups.nested.spentUsd).toBe(5)
    }),
  )

  it.instance("active cold checkpoints charge downtime once and settled pauses add no elapsed time", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const first = yield* f.execute()
      const now = yield* Clock.currentTimeMillis
      const clock = yield* TestClock.make()
      yield* clock.setTime(now)
      yield* f.save({ ...first.state, clock: { at: now - 10_000, active: true, groups: [] } })
      const resumed = yield* f.execute().pipe(Effect.provideService(Clock.Clock, clock))
      expect(resumed.state.usage.elapsedMs).toBe(first.state.usage.elapsedMs + 10_000)
      expect(resumed.state.clock).toEqual({ at: now, active: false, groups: [] })
      yield* clock.adjust("5 minutes")
      const again = yield* f.execute().pipe(Effect.provideService(Clock.Clock, clock))
      expect(again.state.usage.elapsedMs).toBe(resumed.state.usage.elapsedMs)
      expect(f.calls).toHaveLength(1)
    }),
  )

  for (const stopped of ["interruption", "completed", "both"] as const)
    it.instance(`active checkpoint downtime ends at the trusted ${stopped} timestamp`, () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const first = yield* f.execute()
        const now = yield* Clock.currentTimeMillis
        const clock = yield* TestClock.make()
        yield* clock.setTime(now)
        yield* f.save({ ...first.state, clock: { at: now - 10_000, active: true, groups: [] } })
        yield* SubagentLifecycle.write(f.sessions, f.run.id, {
          ...(stopped === "interruption" || stopped === "both"
            ? { interruption: { at: now - 4000, cause: "crash" as const } }
            : {}),
          ...(stopped === "completed" || stopped === "both" ? { completedAt: now - 2000 } : {}),
        })
        const resumed = yield* f.execute().pipe(Effect.provideService(Clock.Clock, clock))
        expect(resumed.state.usage.elapsedMs).toBe(
          first.state.usage.elapsedMs + (stopped === "completed" ? 8000 : 6000),
        )
        expect(f.calls).toHaveLength(1)
      }),
    )

  it.instance("inactive checkpoints exclude the time between completed attempts", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const first = yield* f.execute()
      const now = yield* Clock.currentTimeMillis
      const clock = yield* TestClock.make()
      yield* clock.setTime(now)
      yield* f.save({ ...first.state, clock: { at: now - 86_400_000, active: false, groups: [] } })
      const resumed = yield* f.execute().pipe(Effect.provideService(Clock.Clock, clock))
      expect(resumed.state.usage.elapsedMs).toBe(first.state.usage.elapsedMs)
      expect(f.calls).toHaveLength(1)
    }),
  )

  it.instance("downtime is charged only to groups marked active in the durable checkpoint", () =>
    Effect.gen(function* () {
      const child = { ...base, title: "Nested", stages: [{ id: "a", prompt: "Nested work" }] }
      const f = yield* fixture({
        saved: { child },
        spec: {
          ...base,
          stages: [
            { id: "active", workflow: "child" },
            { id: "idle", workflow: "child" },
          ],
        },
      })
      const first = yield* f.execute()
      const now = yield* Clock.currentTimeMillis
      const clock = yield* TestClock.make()
      yield* clock.setTime(now)
      yield* f.save({ ...first.state, clock: { at: now - 10_000, active: true, groups: ["active"] } })
      const resumed = yield* f.execute().pipe(Effect.provideService(Clock.Clock, clock))
      expect(resumed.state.usage.elapsedMs).toBe(first.state.usage.elapsedMs + 10_000)
      expect(resumed.state.groups.active.elapsedMs).toBe(first.state.groups.active.elapsedMs + 10_000)
      expect(resumed.state.groups.idle.elapsedMs).toBe(first.state.groups.idle.elapsedMs)
      expect(f.calls).toHaveLength(2)
    }),
  )

  it.instance("charged downtime enforces the existing minutes cap before any new node launches", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const first = yield* f.execute()
      const now = yield* Clock.currentTimeMillis
      const clock = yield* TestClock.make()
      yield* clock.setTime(now)
      yield* f.save({ ...first.state, clock: { at: now - 61_000, active: true, groups: [] } })
      const resumed = yield* f
        .execute({
          ...base,
          limits: { ...base.limits, minutes: 1 },
          stages: [...base.stages, { id: "b", prompt: "Must not start after the time cap" }],
        })
        .pipe(Effect.provideService(Clock.Clock, clock))
      expect(resumed.outcome).toBe("failed")
      expect(resumed.state.usage.elapsedMs).toBe(first.state.usage.elapsedMs + 61_000)
      expect(f.calls).toHaveLength(1)
    }),
  )

  for (const active of [false, true])
    it.instance(
      `future ${active ? "active" : "inactive"} clocks refuse resume instead of replenishing elapsed budget`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture()
          const first = yield* f.execute()
          const now = yield* Clock.currentTimeMillis
          const clock = yield* TestClock.make()
          yield* clock.setTime(now)
          yield* f.save({ ...first.state, clock: { at: now + 1, active, groups: [] } })
          const failed = yield* Effect.exit(f.execute().pipe(Effect.provideService(Clock.Clock, clock)))
          expect(Exit.isFailure(failed)).toBe(true)
          expect(f.calls).toHaveLength(1)
          const owner = SubagentLifecycle.read(yield* f.sessions.get(f.run.id))!
          if (owner.workflow?.role !== "run") throw new Error("Missing workflow record")
          expect((yield* WorkflowState.decode(owner.workflow.progress.runtime)).usage.elapsedMs).toBe(
            first.state.usage.elapsedMs,
          )
        }),
    )

  it.instance("a retained old interruption does not cap a newer active checkpoint", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const first = yield* f.execute()
      const now = yield* Clock.currentTimeMillis
      const clock = yield* TestClock.make()
      yield* clock.setTime(now)
      yield* f.save({ ...first.state, clock: { at: now - 10_000, active: true, groups: [] } })
      yield* SubagentLifecycle.write(f.sessions, f.run.id, {
        interruption: { at: now - 20_000, resumedAt: now - 15_000, cause: "crash" },
      })
      const resumed = yield* f.execute().pipe(Effect.provideService(Clock.Clock, clock))
      expect(resumed.state.usage.elapsedMs).toBe(first.state.usage.elapsedMs + 10_000)
      expect(resumed.state.clock).toEqual({ at: now, active: false, groups: [] })
      expect(f.calls).toHaveLength(1)
    }),
  )

  for (const replacement of ["outer", "renamed"] as const)
    it.instance(
      `cold resume replaces an old nested group with ${replacement} work without losing historical accounting`,
      () =>
        Effect.gen(function* () {
          const child = { ...base, title: "Saved child", stages: [{ id: "a", prompt: "Nested work" }] }
          const f = yield* fixture({
            cost: 2,
            steps: 2,
            saved: { child },
            spec: {
              ...base,
              stages: [{ id: "oldgroup", workflow: "child" }],
            },
          })
          const first = yield* f.execute()
          const original = f.calls[0].child
          expect(first.state.usage).toMatchObject({ launched: 1, steps: 2, tokens: 30, spentUsd: 2 })
          expect(first.state.sessionGroups?.[original]).toBe("oldgroup")
          yield* f.guard.release(original)
          yield* f.guard.unlink(original)
          yield* f.guard.release(f.run.id)
          yield* f.guard.unlink(f.run.id)
          yield* f.guard.end(f.parent.id)
          yield* f.guard.begin(f.parent.id, { usd: 1000, steps: 1000 })
          yield* f.link()
          const resumed = yield* f.execute({
            ...base,
            stages:
              replacement === "outer"
                ? [{ id: "outer", prompt: "New independent work" }]
                : [{ id: "newgroup", workflow: "child" }],
          })
          expect(resumed.outcome).toBe("completed")
          expect(f.calls.map((call) => call.marker.stage)).toEqual([
            "oldgroup.a",
            replacement === "outer" ? "outer" : "newgroup.a",
          ])
          expect(resumed.state.usage).toMatchObject({ launched: 2, steps: 4, tokens: 60, spentUsd: 4 })
          expect(resumed.state.sessions[original]).toEqual(first.state.sessions[original])
          expect(Object.keys(resumed.state.sessions)).toHaveLength(2)
          expect(resumed.state.groups.oldgroup).toBeUndefined()
          expect(resumed.state.sessionGroups?.[original]).toBeUndefined()
          if (replacement === "outer") expect(Object.keys(resumed.state.groups)).toEqual([])
          else expect(resumed.state.groups.newgroup).toMatchObject({ launched: 1, steps: 2, tokens: 30, spentUsd: 2 })
          const owner = SubagentLifecycle.read(yield* f.sessions.get(f.run.id))!
          if (owner.workflow?.role !== "run") throw new Error("Missing workflow record")
          const stored = yield* WorkflowState.decode(owner.workflow.progress.runtime)
          expect(stored.sessions[original]).toEqual(first.state.sessions[original])
          expect(stored.usage).toMatchObject({ launched: 2, steps: 4, tokens: 60, spentUsd: 4 })
          expect(stored.sessionGroups?.[original]).toBeUndefined()
          expect(yield* f.sessions.get(original)).toMatchObject({ id: original, parentID: f.run.id })
        }),
    )

  it.instance(
    "real file sources fan out matching repository paths and retain stable node identities on resume",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({
          spec: {
            ...base,
            stages: [
              {
                id: "files",
                prompt: "Inspect {{item}}",
                for_each: { files: { glob: "src/**/*.ts", exclude: ["**/*.test.ts"] } },
              },
            ],
          },
        })
        yield* f.fs.makeDirectory(path.join(f.instance.directory, "src"), { recursive: true })
        for (const file of ["src/z.ts", "src/a.ts", "src/skip.test.ts", "src/.hidden.ts", "README.md"])
          yield* f.fs.writeFileString(path.join(f.instance.directory, file), `fixture ${file}\n`)
        const result = yield* f.execute()
        expect(result.outcome).toBe("completed")
        expect(result.state.nodes.map((node) => node.value)).toEqual(["src/a.ts", "src/z.ts"])
        expect(f.calls).toHaveLength(2)
        expect(f.calls[0].args.prompt).toContain('"value":"src/a.ts"')
        expect(f.calls[1].args.prompt).toContain('"value":"src/z.ts"')
        expect(new Set(f.calls.map((call) => call.marker.item)).size).toBe(2)
        const resumed = yield* f.execute()
        expect(resumed.outcome).toBe("completed")
        expect(f.calls).toHaveLength(2)
        expect(resumed.state.nodes.map((node) => node.key)).toEqual(result.state.nodes.map((node) => node.key))
      }),
    { git: true },
  )

  it.instance(
    "real changed-files fanout distinguishes working-tree changes from an explicit Git base",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const git = yield* Git.Service
        const command = (args: string[]) =>
          git
            .run(args, { cwd: f.instance.directory })
            .pipe(Effect.tap((result) => Effect.sync(() => expect(result.exitCode).toBe(0))))
        yield* f.fs.makeDirectory(path.join(f.instance.directory, "src"), { recursive: true })
        for (const file of ["changed.ts", "deleted.ts", "stable.ts"])
          yield* f.fs.writeFileString(path.join(f.instance.directory, "src", file), "before\n")
        yield* command(["add", "--", "src"])
        yield* command(["commit", "-m", "tracked source fixture"])
        const reference = (yield* command(["rev-parse", "HEAD"])).text().trim()
        yield* f.fs.writeFileString(path.join(f.instance.directory, "src/committed.ts"), "committed later\n")
        yield* command(["add", "--", "src/committed.ts"])
        yield* command(["commit", "-m", "later source fixture"])
        yield* f.fs.writeFileString(path.join(f.instance.directory, "src/changed.ts"), "after\n")
        yield* f.fs.remove(path.join(f.instance.directory, "src/deleted.ts"))
        yield* f.fs.writeFileString(path.join(f.instance.directory, "src/untracked.ts"), "new\n")
        const result = yield* f.execute({
          ...base,
          stages: [
            { id: "working", prompt: "Inspect {{item}}", for_each: { changed_files: { include: ["src/**/*.ts"] } } },
            {
              id: "based",
              prompt: "Inspect {{item}}",
              for_each: { changed_files: { base: reference, include: ["src/**/*.ts"] } },
            },
          ],
        })
        expect(result.outcome).toBe("completed")
        expect(result.state.nodes.filter((node) => node.stage === "working").map((node) => node.value)).toEqual([
          "src/changed.ts",
          "src/untracked.ts",
        ])
        expect(result.state.nodes.filter((node) => node.stage === "based").map((node) => node.value)).toEqual([
          "src/changed.ts",
          "src/committed.ts",
          "src/untracked.ts",
        ])
        expect(f.calls).toHaveLength(5)
        expect(
          f.calls.every(
            (call) =>
              typeof call.args.prompt === "string" &&
              !call.args.prompt.includes("deleted.ts") &&
              !call.args.prompt.includes("stable.ts"),
          ),
        ).toBe(true)
      }),
    { git: true },
  )

  for (const boundary of ["fixed-prefix", "escaped-title"] as const)
    it.instance(`the complete 64 KiB prompt limit includes ${boundary} bytes before downstream admission`, () =>
      Effect.gen(function* () {
        const title = boundary === "escaped-title" ? "@".repeat(80) : "Bounded workflow"
        const source = `a#${"0".repeat(64)}:0`
        const bodyBytes = 64 * 1024 - (boundary === "escaped-title" ? 200 : 0)
        const output = "x".repeat(bodyBytes - Buffer.byteLength(WorkflowTemplate.envelope("", source)))
        expect(
          Buffer.byteLength(WorkflowTemplate.render("{{item}}", { item: output, itemSource: source, run: { title } })),
        ).toBe(bodyBytes)
        // The large data enters through an actual completed source agent, not the
        // workflow's bounded literal-items grammar.
        const f = yield* fixture({
          output,
          spec: {
            ...base,
            title,
            stages: [
              { id: "a", prompt: "Produce a large answer" },
              { id: "b", prompt: "{{item}}", for_each: { from: "a" } },
            ],
          },
        })
        const result = yield* f.execute()
        expect(result.outcome).toBe("failed")
        expect(f.calls.map((call) => call.marker.stage)).toEqual(["a"])
        expect(result.state.usage.launched).toBe(1)
        expect(result.state.nodes.find((node) => node.stage === "b")).toMatchObject({
          status: "failed",
          error: "The complete workflow prompt exceeds 64 KiB.",
        })
        expect(result.results).toEqual([output])
        expect(result.report).toContain("Failure in b: The complete workflow prompt exceeds 64 KiB.")
        expect(result.report).toContain("Full results:")
        if (boundary === "escaped-title") {
          expect(f.calls[0].args.prompt).not.toContain("@")
          expect(f.calls[0].args.prompt).toContain("\\u0040".repeat(80))
        }
      }),
    )

  it.instance("a same-session resumed child pauses new admission while waiting after another child finishes", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const resumedEntered = yield* Deferred.make<void>()
      const secondEntered = yield* Deferred.make<SessionID>()
      const thirdEntered = yield* Deferred.make<void>()
      const releaseResumed = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      let resuming = false
      let newChildren = 0
      const spec = {
        ...base,
        limits: { ...base.limits, max_agents: 1, concurrency: 2 },
        stages: [{ id: "a", prompt: "Work on {{item}}", for_each: { items: [1, 2, 3] } }],
      }
      const f = yield* fixture({
        spec,
        cpus: 18,
        beforeCallback: (call) =>
          Effect.gen(function* () {
            if (!resuming || !call.args.task_id) return
            yield* SubagentLifecycle.write(sessions, call.child, {
              waiting: {
                kind: "question",
                requestID: "workflow-wait",
                since: yield* Clock.currentTimeMillis,
              },
            })
          }).pipe(Effect.orDie),
        afterSteps: (call) =>
          Effect.gen(function* () {
            if (!resuming) return
            if (call.args.task_id) {
              yield* Deferred.succeed(resumedEntered, undefined)
              yield* Deferred.await(releaseResumed)
              return
            }
            if (++newChildren === 1) {
              yield* Deferred.succeed(secondEntered, call.child)
              yield* Deferred.await(releaseSecond)
              return
            }
            yield* Deferred.succeed(thirdEntered, undefined)
          }),
      })
      const first = yield* f.execute()
      expect(f.calls).toHaveLength(1)
      const original = f.calls[0].child
      yield* f.save({
        ...first.state,
        nodes: first.state.nodes.map((node) =>
          node.sessionID !== original
            ? node
            : {
                ...node,
                status: "interrupted",
                final: false,
                execution: "producer",
                output: undefined,
                outputMessageID: undefined,
                pendingLaunch: undefined,
                pendingResult: undefined,
              },
        ),
      })
      const now = yield* Clock.currentTimeMillis
      const clock = yield* TestClock.make()
      yield* clock.setTime(now)
      resuming = true
      const fiber = yield* f
        .execute({ ...spec, limits: { ...spec.limits, max_agents: 3 } })
        .pipe(Effect.provideService(Clock.Clock, clock), Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(resumedEntered), "Resumed child did not enter")
      const second = yield* awaitWithTimeout(Deferred.await(secondEntered), "Second child did not enter")
      expect(f.calls).toHaveLength(3)
      expect(f.calls.find((call) => call.args.task_id === original)?.child).toBe(original)
      const waitingSeen = yield* Deferred.make<void>()
      const secondFinished = yield* Deferred.make<void>()
      const freeSlotObserved = yield* Deferred.make<WorkflowState.Stored>()
      const allFinished = yield* Deferred.make<void>()
      yield* f.events.subscribe(SessionV1.Event.Updated).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.data.sessionID !== f.run.id) return
            const record = SubagentLifecycle.read(event.data.info)
            if (record?.workflow?.role !== "run") return
            const stored = record.workflow.progress.runtime as WorkflowState.Stored | undefined
            if (!stored?.nodes) return
            if (
              (stored.clock?.at ?? 0) >= now + 60_000 &&
              stored.nodes.some((node) => node.sessionID === original && node.status === "waiting")
            )
              yield* Deferred.succeed(waitingSeen, undefined)
            if (stored.nodes.some((node) => node.sessionID === second && node.status === "completed" && node.final)) {
              yield* Deferred.succeed(secondFinished, undefined)
              if ((stored.clock?.at ?? 0) >= now + 62_000) yield* Deferred.succeed(freeSlotObserved, stored)
            }
            if (stored.nodes.filter((node) => node.status === "completed" && node.final).length === 3)
              yield* Deferred.succeed(allFinished, undefined)
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* clock.adjust("61 seconds")
      yield* awaitWithTimeout(Deferred.await(waitingSeen), "Resumed same-ID child was not observed waiting")
      yield* Deferred.succeed(releaseSecond, undefined)
      yield* awaitWithTimeout(Deferred.await(secondFinished), "Second child did not persist completion")
      yield* clock.adjust("1 second")
      const paused = yield* awaitWithTimeout(
        Deferred.await(freeSlotObserved),
        "No checkpoint after the second child freed its slot",
      )
      expect(f.calls).toHaveLength(3)
      expect(paused.usage.launched).toBe(2)
      expect(paused.nodes.some((node) => node.sessionID === original && node.status === "waiting")).toBe(true)
      yield* SubagentLifecycle.write(f.sessions, original, { waiting: undefined })
      yield* Deferred.succeed(releaseResumed, undefined)
      yield* clock.adjust("1 second")
      yield* awaitWithTimeout(Deferred.await(thirdEntered), "Third child did not start after waiting cleared")
      yield* awaitWithTimeout(Deferred.await(allFinished), "All children did not persist completion")
      yield* clock.adjust("1 second")
      const result = yield* awaitWithTimeout(Fiber.join(fiber), "Resumed workflow did not finish")
      expect(result.outcome).toBe("completed")
      expect(f.calls).toHaveLength(4)
      expect(result.state.usage.launched).toBe(3)
    }),
  )
})
