import { afterEach, expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { BackgroundJob } from "@/background/job"
import { WorkflowRuns } from "@/orchestration/runs"
import { WorkflowMarkers } from "@/orchestration/constants"
import { ToolRegistry } from "@/tool/registry"
import { SessionID, PartID } from "@/session/schema"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect, awaitWithTimeout, pollWithTimeout } from "../lib/effect"
import { layer, fixture, spec } from "../tool/workflow-fixture"
import { testProviderConfig } from "../lib/test-provider"
import { examples } from "../../../core/test/orchestration/examples"

afterEach(disposeAllInstances)
const it = testEffect(layer())
const off = testEffect(layer({ backgroundSubagents: false }))

it.instance("an inline workflow cannot grant itself Codium Playbook role access", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const runs = yield* WorkflowRuns.Service
    const result = yield* runs.validate({ ctx: f.ctx, input: { spec: JSON.stringify({ ...spec,
      stages: [{ id: "a", prompt: "Work", model: "codium:ceiling" }],
    }) } })
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes("personal Vector Playbook"))).toBe(true)
    expect(f.asks).toHaveLength(0)
    expect(yield* f.sessions.children(f.parent.id)).toHaveLength(0)
  }), { trusted: true },
)

it.instance(
  "validate returns graph and agent issues without asking or creating a child",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const runs = yield* WorkflowRuns.Service
      for (const value of [
        { ...spec, stages: [{ id: "a", agent: "workflow", prompt: "Nested coordinator" }] },
        { ...spec, stages: [{ id: "a", prompt: "Bad edge", after: ["missing"] }] },
      ]) {
        const result = yield* runs.validate({ ctx: f.ctx, input: { spec: JSON.stringify(value) } })
        expect(result.ok).toBe(false)
        expect(result.issues.length).toBeGreaterThan(0)
      }
      expect(f.asks).toHaveLength(0)
      expect(yield* f.sessions.children(f.parent.id)).toHaveLength(0)
    }),
  { trusted: true },
)

it.instance(
  "explicit models and default verifier agents are validated and disclosed",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const runs = yield* WorkflowRuns.Service
      const value = {
        ...spec,
        defaults: { agent: "explore", model: "lmstudio/test-model" },
        stages: [
          {
            id: "a",
            prompt: "Review",
            verify: {
              prompt: "Check the answer",
              output: { schema: { type: "object", properties: { ok: { type: "boolean" } } } },
              until: { path: "ok", equals: true },
              max_rounds: 1,
            },
          },
        ],
      }
      const accepted = yield* runs.validate({ ctx: f.ctx, input: { spec: JSON.stringify(value) } })
      expect(accepted).toMatchObject({ ok: true, issues: [] })
      expect(accepted.plan?.stages[0].model).toBe("lmstudio/test-model")
      const denied = yield* runs.validate({
        ctx: f.ctx,
        input: {
          spec: JSON.stringify({
            ...value,
            stages: [{ ...value.stages[0], verify: { ...value.stages[0].verify, model: "missing/model" } }],
          }),
        },
      })
      expect(denied.ok).toBe(false)
      expect(denied.issues.some((issue) => issue.path.endsWith("/verify/model"))).toBe(true)
    }),
  { trusted: true, config: testProviderConfig("http://127.0.0.1:1") },
)

it.instance(
  "refuses subagent, guest, capped, Light and unavailable-task starts before approval",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const runs = yield* WorkflowRuns.Service
      const child = yield* f.sessions.create({ parentID: f.parent.id, title: "Child" })
      for (const ctx of [
        { ...f.ctx, sessionID: child.id },
        { ...f.ctx, extra: { ...f.ctx.extra, taskSize: { tier: "standard", capped: true } } },
        { ...f.ctx, extra: { ...f.ctx.extra, taskSize: { tier: "light" } } },
        { ...f.ctx, extra: { ...f.ctx.extra, [WorkflowMarkers.TASK_OFFERED]: false } },
      ]) {
        const refused = yield* runs
          .launch({ ctx, input: { spec: JSON.stringify(spec) }, task: f.task })
          .pipe(Effect.flip)
        expect(refused.code).toBe("forbidden")
      }
      const guests = yield* FreeModelGuests.Service
      yield* guests.mark(f.parent.id)
      const guest = yield* runs
        .launch({ ctx: f.ctx, input: { spec: JSON.stringify(spec) }, task: f.task })
        .pipe(Effect.flip)
      expect(guest.message).toContain("guest")
      expect(f.asks).toHaveLength(0)
      expect(f.prompts).toHaveLength(0)
    }),
  { trusted: true },
)

off.instance(
  "background-disabled starts are refused before the ask",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const runs = yield* WorkflowRuns.Service
      const refused = yield* runs
        .launch({ ctx: f.ctx, input: { spec: JSON.stringify(spec) }, task: f.task })
        .pipe(Effect.flip)
      expect(refused.message).toContain("Background subagents")
      expect(f.asks).toHaveLength(0)
    }),
  { trusted: true },
)

for (const outside of ["webfetch", "mcp_fixture", "none", "large", "agent"] as const)
  it.instance(
    `approval discloses ceilings and applies ${outside} hold`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const runs = yield* WorkflowRuns.Service
        const jobs = yield* BackgroundJob.Service
        if (outside === "agent") {
          const previous = process.env[ChildEnvironment.AGENT_MARKER]
          process.env[ChildEnvironment.AGENT_MARKER] = "ses_outer"
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env[ChildEnvironment.AGENT_MARKER]
              else process.env[ChildEnvironment.AGENT_MARKER] = previous
            }),
          )
        }
        if (outside === "webfetch" || outside === "mcp_fixture")
          yield* f.sessions.updatePart({
            id: PartID.ascending(),
            messageID: f.message.id,
            sessionID: f.parent.id,
            type: "tool",
            tool: outside,
            callID: "outside",
            state: {
              status: "completed",
              input: {},
              output: "Untrusted content",
              title: "Outside",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          })
        yield* f.sessions.updatePart({
          id: PartID.ascending(),
          messageID: f.message.id,
          sessionID: f.parent.id,
          type: "tool",
          tool: "workflow",
          callID: "workflow-pending",
          state: { status: "pending", input: {}, raw: "{}" },
        })
        const started = yield* runs.launch({
          ctx: f.ctx,
          input: { spec: JSON.stringify(outside === "large" ? { ...spec, limits: { per_agent_steps: 61 } } : spec) },
          task: f.task,
        })
        yield* awaitWithTimeout(jobs.wait({ id: started.runID }), "Workflow did not settle", "5 seconds")
        expect(f.asks).toHaveLength(1)
        expect(f.asks[0].patterns).toEqual([
          outside === "none"
            ? "run"
            : `after-web workflow:${outside === "webfetch" ? "web" : outside === "mcp_fixture" ? "mcp" : outside}`,
        ])
        expect(f.asks[0].always).toEqual(outside === "none" ? ["run"] : [])
        expect(f.asks[0].metadata).toMatchObject({
          maxAgents: 100,
          steps: 4000,
          delegated: { usd: 25 },
          stages: [{ agent: "explore" }],
        })
      }),
    { trusted: true },
  )

for (const change of ["guest", "task", "edit"] as const)
  it.instance(
    `approval does not authorize stale policy after ${change} changes`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const runs = yield* WorkflowRuns.Service
        const guests = yield* FreeModelGuests.Service
        const ctx = {
          ...f.ctx,
          ask: () =>
            change === "guest"
              ? guests.mark(f.parent.id)
              : f.sessions
                  .setPermission({
                    sessionID: f.parent.id,
                    permission: [{ permission: change, pattern: "*", action: "deny" }],
                  })
                  .pipe(Effect.asVoid),
        }
        const denied = yield* runs
          .launch({ ctx, input: { spec: JSON.stringify({ ...spec, defaults: { agent: "general" } }) }, task: f.task })
          .pipe(Effect.flip)
        expect(denied.code).toBe("forbidden")
        expect(yield* f.sessions.children(f.parent.id)).toHaveLength(0)
        expect(f.prompts).toHaveLength(0)
      }),
    { trusted: true },
  )

it.instance(
  "an agent ceiling ends the run with a failed partial report",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const runs = yield* WorkflowRuns.Service
      const jobs = yield* BackgroundJob.Service
      const value = {
        ...spec,
        limits: { max_agents: 1 },
        stages: [{ id: "a", prompt: "Review {{item}}", for_each: { items: [1, 2] } }],
      }
      const started = yield* runs.launch({ ctx: f.ctx, input: { spec: JSON.stringify(value) }, task: f.task })
      const job = yield* awaitWithTimeout(
        jobs.wait({ id: started.runID }),
        "Partial workflow did not finish",
        "5 seconds",
      )
      expect(job.info?.status).toBe("error")
      const record = yield* pollWithTimeout(
        f.sessions.get(SessionID.make(started.runID)).pipe(
          Effect.map((session) => {
            const record = SubagentLifecycle.read(session)
            return record?.status === "error" ? record : undefined
          }),
        ),
        "Workflow lifecycle never recorded the failed run",
      )
      expect(record.status).toBe("error")
      expect(record.workflow?.role === "run" && record.workflow.progress.report).toContain("Full results:")
      expect(yield* f.sessions.children(SessionID.make(started.runID))).toHaveLength(1)
    }),
  { trusted: true },
)

it.instance(
  "trusted owner start skips approval; concurrent starts and running resumes are refused without another ask",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const runs = yield* WorkflowRuns.Service
      const jobs = yield* BackgroundJob.Service
      const entered = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const ctx = {
        ...f.ctx,
        extra: {
          ...f.ctx.extra,
          [WorkflowMarkers.USER_START]: true,
          promptOps: {
            ...f.ops,
            prompt: (input: Parameters<typeof f.ops.prompt>[0]) =>
              input.sessionID === f.parent.id
                ? f.ops.prompt(input)
                : Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.andThen(f.ops.prompt(input)),
                  ),
          },
        },
      }
      const started = yield* runs.launch({ ctx, input: { spec: JSON.stringify(spec) }, task: f.task })
      yield* awaitWithTimeout(Deferred.await(entered), "Child never entered")
      const second = yield* runs.launch({ ctx, input: { spec: JSON.stringify(spec) }, task: f.task }).pipe(Effect.flip)
      expect(second.code).toBe("limit")
      const resume = yield* runs.launch({ ctx, input: { runID: started.runID }, task: f.task }).pipe(Effect.flip)
      expect(resume.code).toBe("running")
      expect(f.asks).toHaveLength(0)
      yield* Deferred.succeed(gate, undefined)
      yield* awaitWithTimeout(jobs.wait({ id: started.runID }), "Child never finished", "5 seconds")
      const again = yield* runs.launch({ ctx, input: { runID: started.runID }, task: f.task })
      yield* awaitWithTimeout(jobs.wait({ id: again.runID }), "Resumed workflow never finished", "5 seconds")
      expect(again.runID).toBe(started.runID)
      expect(f.prompts.filter((prompt) => prompt.sessionID !== f.parent.id)).toHaveLength(1)
      expect(SubagentLifecycle.read(yield* f.sessions.get(SessionID.make(again.runID)))?.workflow).toMatchObject({
        role: "run",
        revision: 1,
      })
    }),
  { trusted: true },
)

it.instance(
  "read-only specialists plan as readers with the real agent catalog, and a general writer stays serial",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const runs = yield* WorkflowRuns.Service
      // The guide's review-changes example: explore only allows Git reads and asks for test commands.
      const review = yield* runs.validate({ ctx: f.ctx, input: { spec: JSON.stringify(examples[0].spec) } })
      expect(review.ok).toBe(true)
      for (const stage of review.plan!.stages) expect(stage).toMatchObject({ serial: false, writes: "read only" })
      expect(review.warnings.some((warning) => warning.message.includes("one at a time"))).toBe(false)
      for (const agent of ["review", "security"]) {
        const checked = yield* runs.validate({
          ctx: f.ctx,
          input: { spec: JSON.stringify({ ...spec, defaults: { agent } }) },
        })
        expect(checked.plan?.stages[0]).toMatchObject({ serial: false, writes: "read only" })
      }
      const writer = yield* runs.validate({
        ctx: f.ctx,
        input: { spec: JSON.stringify({ ...spec, defaults: { agent: "general" } }) },
      })
      expect(writer.plan?.stages[0]).toMatchObject({ serial: true, writes: "in this checkout, one at a time" })
    }),
  { trusted: true },
)

it.instance(
  "a read-only fan-out runs its agents together instead of through the exclusive writer gate",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const runs = yield* WorkflowRuns.Service
      const jobs = yield* BackgroundJob.Service
      const both = yield* Deferred.make<void>()
      const inside = new Set<string>()
      const value = { ...spec, stages: [{ id: "a", prompt: "Review {{item}}", for_each: { items: [1, 2] } }] }
      const ctx = {
        ...f.ctx,
        extra: {
          ...f.ctx.extra,
          promptOps: {
            ...f.ops,
            prompt: (input: Parameters<typeof f.ops.prompt>[0]) =>
              input.sessionID === f.parent.id
                ? f.ops.prompt(input)
                : Effect.gen(function* () {
                    inside.add(input.sessionID)
                    if (inside.size === 2) yield* Deferred.succeed(both, undefined)
                    // Each child waits until the other is in flight too; a serial gate would never let that happen.
                    yield* Deferred.await(both)
                    return yield* f.ops.prompt(input)
                  }),
          },
        },
      }
      const started = yield* runs.launch({ ctx, input: { spec: JSON.stringify(value) }, task: f.task })
      // The in-flight cap follows the machine's CPUs; with room for two, both explore agents must run at once.
      if (started.plan.concurrency < 2) return
      expect(started.plan.stages[0]).toMatchObject({ serial: false, writes: "read only" })
      yield* awaitWithTimeout(Deferred.await(both), "The read-only agents never ran together", "10 seconds")
      const ended = yield* awaitWithTimeout(jobs.wait({ id: started.runID }), "Workflow did not finish", "10 seconds")
      expect(ended.info?.status).toBe("completed")
    }),
  { trusted: true },
)

it.instance(
  "a resumed run's tool part shows progress only, never its report or runtime state",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const runs = yield* WorkflowRuns.Service
      const jobs = yield* BackgroundJob.Service
      const parts: Record<string, unknown>[] = []
      const ctx = {
        ...f.ctx,
        metadata: (value: { metadata?: Record<string, unknown> }) =>
          Effect.sync(() => {
            if (value.metadata) parts.push(value.metadata)
          }),
      }
      const started = yield* runs.launch({ ctx, input: { spec: JSON.stringify(spec) }, task: f.task })
      yield* awaitWithTimeout(jobs.wait({ id: started.runID }), "Workflow did not finish", "5 seconds")
      const record = SubagentLifecycle.read(yield* f.sessions.get(SessionID.make(started.runID)))
      expect(record?.workflow?.role === "run" && record.workflow.progress.report).toContain("Full results:")
      parts.length = 0
      yield* runs.launch({ ctx, input: { runID: started.runID }, task: f.task })
      yield* awaitWithTimeout(jobs.wait({ id: started.runID }), "Resumed workflow did not finish", "5 seconds")
      const shown = parts.flatMap((metadata) => {
        const workflow = metadata.workflow as { role?: string; progress?: Record<string, unknown> } | undefined
        return workflow?.role === "run" ? [workflow.progress ?? {}] : []
      })
      expect(shown.length).toBeGreaterThan(0)
      for (const progress of shown) {
        expect(progress.report).toBeUndefined()
        expect(progress.runtime).toBeUndefined()
        expect(progress.accounting).toBeUndefined()
      }
    }),
  { trusted: true },
)
