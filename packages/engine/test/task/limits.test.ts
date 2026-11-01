import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber, Option, Scope } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Database } from "@vectordevai/core/database/database"
import { EventV2 } from "@vectordevai/core/event"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Project } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionTable } from "@vectordevai/core/session/sql"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"

// The conversation's subagent slots, the request's launch count and its delegated ceiling, on their own.

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([TaskLimits.node, Database.node, FreeModelGuests.node, SpendGuard.node, EventV2.node]),
  ),
)

const CONVERSATION = "ses_conversation"
const REQUEST = "msg_request"
const limits = (running = 8, perRequest = 32, usd = 25): TaskLimits.Limits => ({
  running,
  perRequest,
  budget: { usd },
})
const id = (name: string) => SessionID.make(`ses_${name}`)
const admitInput = (origin: TaskLimits.Origin, values: Partial<TaskLimits.AdmitInput> = {}): TaskLimits.AdmitInput => ({
  conversationID: CONVERSATION,
  requestID: REQUEST,
  limits: limits(),
  origin,
  count: 1,
  ...values,
})

// Lets forked fibers run until they block.
const settle = Effect.gen(function* () {
  for (let i = 0; i < 25; i++) yield* Effect.yieldNow
})

// A child's run that records when it starts and holds its slot until released.
function holder(service: TaskLimits.Interface, started: string[], name: string, origin: TaskLimits.Origin = "root") {
  return Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const fiber = yield* service
      .run(
        { conversationID: CONVERSATION, childID: id(name), origin },
        Effect.sync(() => started.push(name)).pipe(Effect.andThen(Deferred.await(gate))),
      )
      .pipe(Effect.forkChild)
    yield* settle
    return { gate, fiber, release: Deferred.succeed(gate, undefined).pipe(Effect.andThen(settle)) }
  })
}

const status = (service: TaskLimits.Interface, value = limits()) => service.status(CONVERSATION, REQUEST, value)

describe("TaskLimits.resolve", () => {
  test("clamps each count to its range and fills the defaults", () => {
    expect(TaskLimits.resolve({}, false)).toEqual({ running: 8, perRequest: 32, budget: { usd: 25 } })
    expect(TaskLimits.resolve({ budget: { subagents: { running: 0, per_request: 0 } } }, false)).toMatchObject({
      running: 1,
      perRequest: 1,
    })
    expect(TaskLimits.resolve({ budget: { subagents: { running: 17, per_request: 5000 } } }, false)).toMatchObject({
      running: 16,
      perRequest: 1000,
    })
    // Budget fields replace the defaults one by one; a spend ceiling of 0 cannot be set by mistake.
    expect(
      TaskLimits.resolve({ budget: { subagents: { usd: 0, steps: 400, warnAt: 0.5, unpricedSteps: 20 } } }, false)
        .budget,
    ).toEqual({ usd: 25, steps: 400, warnAt: 0.5, unpricedSteps: 20 })
    expect(TaskLimits.resolve({ budget: { subagents: { usd: 60 } } }, false).budget).toEqual({ usd: 60 })
  })

  test("a guest gets the lower of each limit and the guest budget", () => {
    expect(TaskLimits.resolve({}, true)).toEqual({ running: 4, perRequest: 8, budget: { usd: 5 } })
    expect(TaskLimits.resolve({ budget: { subagents: { running: 16, per_request: 100, usd: 50 } } }, true)).toEqual({
      running: 4,
      perRequest: 8,
      budget: { usd: 5 },
    })
    expect(
      TaskLimits.resolve({ budget: { subagents: { running: 2, per_request: 3, usd: 1, steps: 10 } } }, true),
    ).toEqual({ running: 2, perRequest: 3, budget: { usd: 1, steps: 10 } })
  })

  test("the ledger id names the conversation and the request", () => {
    expect(TaskLimits.ledger("ses_a", "msg_b")).toBe("delegated:ses_a:msg_b")
  })
})

describe("TaskLimits.conversation", () => {
  const session = (values: Omit<Partial<Session.Info>, "id"> & { id: string }): Session.Info =>
    ({
      slug: values.id,
      projectID: Project.ID.global,
      directory: "/project",
      title: values.id,
      version: "test",
      time: { created: 0, updated: 0 },
      ...values,
      id: SessionID.make(values.id),
    }) as Session.Info
  const parallel = (name: string, parent: string, values: Omit<Partial<Session.Info>, "id"> = {}) =>
    session({ id: name, metadata: { vector: { kind: "parallel-agent", parentSessionId: parent } }, ...values })
  const all = [
    session({ id: "ses_root" }),
    session({ id: "ses_child", parentID: SessionID.make("ses_root") }),
    session({ id: "ses_grandchild", parentID: SessionID.make("ses_child") }),
    parallel("ses_swarm", "ses_root"),
    session({ id: "ses_swarm_child", parentID: SessionID.make("ses_swarm") }),
    parallel("ses_nested_swarm", "ses_swarm"),
    parallel("ses_from_child", "ses_child"),
    parallel("ses_elsewhere", "ses_other_project"),
    session({ id: "ses_other_project", projectID: "prj_other" as Session.Info["projectID"] }),
    parallel("ses_orphan", "ses_missing"),
  ]
  const byID = new Map(all.map((item) => [item.id as string, item]))
  const parentOf = (value: string) => byID.get(value)
  const of = (name: string, guest = false) => TaskLimits.conversation(byID.get(name)!, parentOf, guest)

  test("a subagent counts in its root's conversation", () => {
    expect(of("ses_root")).toBe("ses_root")
    expect(of("ses_grandchild")).toBe("ses_root")
  })

  test("a parallel-agent root joins the conversation of the session it names, one hop only", () => {
    expect(of("ses_swarm")).toBe("ses_root")
    expect(of("ses_swarm_child")).toBe("ses_root")
    expect(of("ses_from_child")).toBe("ses_root")
    // Started from a parallel-agent session: that session's own root, not the conversation it joined.
    expect(of("ses_nested_swarm")).toBe("ses_swarm")
  })

  test("a guest-marked, foreign-project or orphaned parallel-agent root keeps its own pool", () => {
    expect(of("ses_swarm", true)).toBe("ses_swarm")
    expect(of("ses_swarm_child", true)).toBe("ses_swarm")
    expect(of("ses_elsewhere")).toBe("ses_elsewhere")
    expect(of("ses_orphan")).toBe("ses_orphan")
  })
})

describe("TaskLimits admission", () => {
  it.effect("admit, bind and the finalizer release", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      // Unbound: the place is the admission's until its scope closes.
      const unbound = yield* Scope.make()
      const first = yield* Scope.provide(unbound)(service.admit(admitInput("root")))
      expect(first).toMatchObject({ launched: 1, active: 1, waits: false, prepaid: 0, running: 0, queued: 0 })
      expect((yield* status(service)).launched).toBe(1)
      yield* Scope.close(unbound, Exit.void)
      expect((yield* status(service)).launched).toBe(0)

      // Bound: the place is the child's.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const admission = yield* service.admit(admitInput("root"))
          yield* service.bind(admission, id("bound"))
        }),
      )
      expect((yield* status(service)).launched).toBe(1)

      // A launch that fails before its child starts gives the place and its reserved slot back.
      const failing = yield* Scope.make()
      const nested = yield* Scope.provide(failing)(service.admit(admitInput("nested", { limits: limits(1) })))
      expect(nested.prepaid).toBe(1)
      yield* service.bind(nested, id("failed"))
      const full = yield* Effect.scoped(service.admit(admitInput("nested", { limits: limits(1) }))).pipe(Effect.flip)
      expect(full.reason).toBe("slots")
      yield* Scope.close(failing, Exit.fail("start failed"))
      expect((yield* status(service, limits(1))).launched).toBe(1)
      const again = yield* Effect.scoped(service.admit(admitInput("nested", { limits: limits(1) })))
      expect(again.prepaid).toBe(1)
    }),
  )

  it.effect("capacity refuses a batch past the request's total with the batch message", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      const small = limits(8, 3)
      const refused = yield* service
        .capacity({ conversationID: CONVERSATION, requestID: REQUEST, limits: small, need: 4 })
        .pipe(Effect.flip)
      expect(refused.reason).toBe("batch")
      expect(refused.message).toBe(
        "This batch would start 4 subagents, but this request may start only 3 more (budget.subagents.per_request). Launch fewer, or do the rest yourself. No child was started.",
      )
      for (const name of ["one", "two"])
        yield* Effect.scoped(
          service
            .admit(admitInput("root", { limits: small }))
            .pipe(Effect.flatMap((admission) => service.bind(admission, id(name)))),
        )
      const left = yield* service
        .capacity({ conversationID: CONVERSATION, requestID: REQUEST, limits: small, need: 2 })
        .pipe(Effect.flip)
      expect(left.message).toContain("may start only 1 more")
      yield* service.capacity({ conversationID: CONVERSATION, requestID: REQUEST, limits: small, need: 1 })
      // Resumes and workflow agents are not counted against the request.
      yield* Effect.scoped(service.admit(admitInput("resume", { limits: small })))
      yield* Effect.scoped(service.admit(admitInput("workflow", { limits: small })))
      yield* Effect.scoped(
        service
          .admit(admitInput("nested", { limits: small }))
          .pipe(Effect.flatMap((a) => service.bind(a, id("three")))),
      )
      const over = yield* Effect.scoped(service.admit(admitInput("root", { limits: small }))).pipe(Effect.flip)
      expect(over.reason).toBe("per_request")
      expect(over.message).toBe(
        "This request has already started 3 of the 3 subagents one request may start (budget.subagents.per_request). Do the remaining work yourself, or continue a finished child with its task_id. No child was started.",
      )
      // Another request has its own count.
      yield* Effect.scoped(service.admit(admitInput("root", { limits: small, requestID: "msg_next" })))
    }),
  )

  it.effect("waits and active count admitted launches that have not started", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      const started: string[] = []
      const running = yield* holder(service, started, "running")
      const three = limits(3)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* service.admit(admitInput("root", { limits: three }))
          const second = yield* service.admit(admitInput("root", { limits: three }))
          const third = yield* service.admit(admitInput("root", { limits: three }))
          // Two free slots: the third entry of this batch would wait for one.
          expect([first.waits, second.waits, third.waits]).toEqual([false, false, true])
          expect([first.active, second.active, third.active]).toEqual([2, 3, 4])
        }),
      )
      yield* running.release
    }),
  )

  it.effect("the request's delegated ceiling refuses launches until the budget is raised", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      const guard = yield* SpendGuard.Service
      const one = limits(8, 32, 1)
      yield* Effect.scoped(service.admit(admitInput("root", { limits: one })))
      const child = id("spender")
      yield* guard.link(child, id("conversation"), {
        delegated: { id: TaskLimits.ledger(CONVERSATION, REQUEST), budget: one.budget },
      })
      yield* guard.record(child, {
        costUsd: 2,
        costKind: "priced",
        contextTokens: 0,
        cachedTokens: 0,
        continues: false,
        tools: [],
        patched: false,
      })
      const refused = yield* Effect.scoped(service.admit(admitInput("root", { limits: one }))).pipe(Effect.flip)
      expect(refused.reason).toBe("spend")
      expect(refused.message).toBe(
        "Subagents in this request reached their spend ceiling ($2.00 of $1.00). Do the remaining work yourself; the user can raise budget.subagents.usd, or a new request continues under a fresh ceiling. No child was started.",
      )
      // Resumes spend on the same ledger.
      expect(
        (yield* Effect.scoped(service.admit(admitInput("resume", { limits: one }))).pipe(Effect.flip)).reason,
      ).toBe("spend")
      const spend = (yield* status(service, one)).spend
      expect(spend).toEqual({ spentUsd: 2, limitUsd: 1, unknownSteps: 0, warned: true, stopped: true })
      // A raised ceiling re-arms the ledger, which keeps what was spent.
      yield* Effect.scoped(service.admit(admitInput("root", { limits: limits(8, 32, 5) })))
      const raised = yield* guard.delegated(TaskLimits.ledger(CONVERSATION, REQUEST))
      expect(raised).toMatchObject({ spentUsd: 2, budget: { usd: 5 } })
      expect(raised?.stopped).toBeUndefined()
      // A new request starts under a fresh ceiling.
      yield* Effect.scoped(service.admit(admitInput("root", { limits: one, requestID: "msg_fresh" })))
    }),
  )
})

describe("TaskLimits slots", () => {
  it.effect("root launches wait in one queue and start in arrival order", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      yield* service.status(CONVERSATION, undefined, limits(1))
      const started: string[] = []
      const first = yield* holder(service, started, "a")
      const b = yield* holder(service, started, "b")
      const c = yield* holder(service, started, "c")
      const d = yield* holder(service, started, "d")
      expect(started).toEqual(["a"])
      expect(yield* service.status(CONVERSATION)).toMatchObject({ running: 1, queued: 3, limit: 1 })
      yield* first.release
      expect(started).toEqual(["a", "b"])
      yield* b.release
      yield* c.release
      expect(started).toEqual(["a", "b", "c", "d"])
      yield* d.release
      expect(yield* service.status(CONVERSATION)).toMatchObject({ running: 0, queued: 0 })
    }),
  )

  it.effect("a waiting root launch goes before a waiting workflow launch", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      yield* service.status(CONVERSATION, undefined, limits(1))
      const started: string[] = []
      const first = yield* holder(service, started, "a")
      const agent = yield* holder(service, started, "agent", "workflow")
      const root = yield* holder(service, started, "root")
      yield* first.release
      expect(started).toEqual(["a", "root"])
      yield* root.release
      expect(started).toEqual(["a", "root", "agent"])
      yield* agent.release
    }),
  )

  it.effect("workflow launches never take the last 2 slots while any workflow launch waits", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      yield* service.status(CONVERSATION, undefined, limits(4))
      const started: string[] = []
      const w1 = yield* holder(service, started, "w1", "workflow")
      const w2 = yield* holder(service, started, "w2", "workflow")
      const w3 = yield* holder(service, started, "w3", "workflow")
      expect(started).toEqual(["w1", "w2"])
      // The two free slots stay for task launches, which start at once.
      const r1 = yield* holder(service, started, "r1")
      const r2 = yield* holder(service, started, "r2")
      expect(started).toEqual(["w1", "w2", "r1", "r2"])
      yield* w1.release
      yield* r1.release
      expect(started).not.toContain("w3")
      yield* r2.release
      expect(started).toContain("w3")
      yield* w2.release
      yield* w3.release

      // With two slots, workflow agents still run, one at a time.
      yield* service.status("ses_small", undefined, limits(2))
      const small: string[] = []
      const run = (name: string) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const fiber = yield* service
            .run(
              { conversationID: "ses_small", childID: id(name), origin: "workflow" },
              Effect.sync(() => small.push(name)).pipe(Effect.andThen(Deferred.await(gate))),
            )
            .pipe(Effect.forkChild)
          yield* settle
          return { gate, fiber }
        })
      const a = yield* run("a")
      const b = yield* run("b")
      expect(small).toEqual(["a"])
      yield* Deferred.succeed(a.gate, undefined)
      yield* settle
      expect(small).toEqual(["a", "b"])
      yield* Deferred.succeed(b.gate, undefined)
      yield* Fiber.join(b.fiber)
    }),
  )

  it.effect("nested launches are refused when no slot is free, or a root launch waits for the free one", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      const two = limits(2)
      yield* service.status(CONVERSATION, undefined, two)
      const started: string[] = []
      const a = yield* holder(service, started, "a")
      const b = yield* holder(service, started, "b")
      const refused = yield* Effect.scoped(service.admit(admitInput("nested", { limits: two }))).pipe(Effect.flip)
      expect(refused.reason).toBe("slots")
      expect(refused.message).toBe(
        "All 2 subagent slots of this conversation are in use, and a subagent's own subagents cannot wait for one. Do this part yourself. No child was started.",
      )
      yield* b.release
      // A lead that reserves a slot for its own launch waits for both; the free one is promised to it.
      const lead = yield* Scope.make()
      const admission = yield* Scope.provide(lead)(service.admit(admitInput("root", { limits: two, reserve: 1 })))
      expect(admission).toMatchObject({ waits: true, prepaid: 0 })
      yield* service.bind(admission, id("lead"))
      const leadRun = yield* holder(service, started, "lead")
      expect(started).toEqual(["a", "b"])
      expect(
        (yield* Effect.scoped(service.admit(admitInput("nested", { limits: two }))).pipe(Effect.flip)).reason,
      ).toBe("slots")
      yield* a.release
      expect(started).toEqual(["a", "b", "lead"])
      yield* leadRun.release
      yield* Scope.close(lead, Exit.void)
    }),
  )

  it.effect("a prepaid slot bound before start is used by run and released on exit", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      const one = limits(1)
      const started: string[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const admission = yield* service.admit(admitInput("nested", { limits: one }))
          expect(admission.prepaid).toBe(1)
          yield* service.bind(admission, id("nested"))
          // The slot is the child's: a root launch waits for it.
          const root = yield* holder(service, started, "root")
          expect(started).toEqual([])
          const nested = yield* holder(service, started, "nested", "nested")
          expect(started).toEqual(["nested"])
          yield* nested.release
          expect(started).toEqual(["nested", "root"])
          yield* root.release
        }),
      )
      expect(yield* service.status(CONVERSATION)).toMatchObject({ running: 0, queued: 0 })
    }),
  )

  it.effect("a released slot goes to the queue head before any later launch", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      const one = limits(1)
      yield* service.status(CONVERSATION, undefined, one)
      const started: string[] = []
      const gate = yield* Deferred.make<void>()
      // B waits in a slow queued transition, so it has not resumed when the slot is handed to it.
      const a = yield* holder(service, started, "a")
      const b = yield* service
        .run(
          { conversationID: CONVERSATION, childID: id("b"), origin: "root", waiting: Deferred.await(gate) },
          Effect.sync(() => started.push("b")),
        )
        .pipe(Effect.forkChild)
      yield* settle
      yield* a.release
      expect(started).toEqual(["a"])
      expect(yield* service.status(CONVERSATION)).toMatchObject({ running: 1, queued: 0 })
      expect(
        (yield* Effect.scoped(service.admit(admitInput("nested", { limits: one }))).pipe(Effect.flip)).reason,
      ).toBe("slots")
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(b)
      expect(started).toEqual(["a", "b"])
    }),
  )

  it.effect("an interrupted waiter leaves the queue, and one woken first passes its slot on", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      yield* service.status(CONVERSATION, undefined, limits(1))
      const started: string[] = []
      const a = yield* holder(service, started, "a")
      const b = yield* holder(service, started, "b")
      const c = yield* holder(service, started, "c")
      yield* Fiber.interrupt(b.fiber)
      expect(yield* service.status(CONVERSATION)).toMatchObject({ running: 1, queued: 1 })
      yield* a.release
      expect(started).toEqual(["a", "c"])
      yield* c.release

      // D is granted the slot while still in its queued transition, then stopped: E gets the slot.
      const gate = yield* Deferred.make<void>()
      const f = yield* holder(service, started, "f")
      const d = yield* service
        .run(
          { conversationID: CONVERSATION, childID: id("d"), origin: "root", waiting: Deferred.await(gate) },
          Effect.sync(() => started.push("d")),
        )
        .pipe(Effect.forkChild)
      yield* settle
      const e = yield* holder(service, started, "e")
      yield* f.release
      expect(yield* service.status(CONVERSATION)).toMatchObject({ running: 1, queued: 1 })
      yield* Fiber.interrupt(d)
      yield* settle
      expect(started).toEqual(["a", "c", "f", "e"])
      yield* e.release
      expect(yield* service.status(CONVERSATION)).toMatchObject({ running: 0, queued: 0 })
    }),
  )

  it.effect("run is reentrant per child", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      yield* service.status(CONVERSATION, undefined, limits(1))
      const input = { conversationID: CONVERSATION, childID: id("steered"), origin: "root" as const }
      // A run inside the child's own run does not wait for a second slot.
      expect(yield* service.run(input, service.run(input, Effect.succeed("inner")))).toBe("inner")
      const started: string[] = []
      const outer = yield* holder(service, started, "steered")
      // A concurrent steer shares the slot.
      const steer = yield* holder(service, started, "steered")
      expect(started).toEqual(["steered", "steered"])
      expect(yield* service.status(CONVERSATION)).toMatchObject({ running: 1, queued: 0 })
      const other = yield* holder(service, started, "other")
      yield* outer.release
      expect(started).not.toContain("other")
      yield* steer.release
      expect(started).toContain("other")
      yield* other.release
    }),
  )

  it.effect("a research lead's reserved slots go to its own launches and come back to it", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      const seven = limits(7)
      yield* service.status(CONVERSATION, undefined, seven)
      const started: string[] = []
      const others = [yield* holder(service, started, "x"), yield* holder(service, started, "y")]
      const lead = yield* Scope.make()
      const admission = yield* Scope.provide(lead)(service.admit(admitInput("root", { limits: seven, reserve: 4 })))
      expect(admission).toMatchObject({ waits: false, prepaid: 5 })
      yield* service.bind(admission, id("lead"))
      yield* Scope.close(lead, Exit.void)
      const leadRun = yield* holder(service, started, "lead")
      // Every slot is taken: a root launch waits, and only the lead's researchers start.
      const waiting = yield* holder(service, started, "waiting")
      expect(started).toEqual(["x", "y", "lead"])
      const researcher = (name: string) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make()
          const nested = yield* Scope.provide(scope)(
            service.admit(admitInput("nested", { limits: seven, parentID: id("lead") })),
          )
          yield* service.bind(nested, id(name))
          const run = yield* holder(service, started, name, "nested")
          return { scope, run }
        })
      const researchers = [
        yield* researcher("r1"),
        yield* researcher("r2"),
        yield* researcher("r3"),
        yield* researcher("r4"),
      ]
      expect(started).toEqual(["x", "y", "lead", "r1", "r2", "r3", "r4"])
      const fifth = yield* Effect.scoped(
        service.admit(admitInput("nested", { limits: seven, parentID: id("lead") })),
      ).pipe(Effect.flip)
      expect(fifth.reason).toBe("slots")
      // A researcher's slot goes back to the lead, not to the waiting root launch.
      yield* researchers[0].run.release
      yield* Scope.close(researchers[0].scope, Exit.void)
      expect(started).not.toContain("waiting")
      yield* Effect.scoped(service.admit(admitInput("nested", { limits: seven, parentID: id("lead") })))
      for (const item of researchers.slice(1)) {
        yield* item.run.release
        yield* Scope.close(item.scope, Exit.void)
      }
      yield* leadRun.release
      expect(started).toContain("waiting")
      yield* waiting.release
      for (const item of others) yield* item.release
      expect(yield* service.status(CONVERSATION)).toMatchObject({ running: 0, queued: 0 })
    }),
  )

  it.effect("a reserve never asks for every slot, and a lead stopped before its run gives its slots back", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      // A Deep lead's 1 + 4 in a conversation of 3 slots: the lead and 2 researchers.
      const three = limits(3)
      const lead = yield* Scope.make()
      const admission = yield* Scope.provide(lead)(service.admit(admitInput("root", { limits: three, reserve: 4 })))
      expect(admission).toMatchObject({ waits: false, prepaid: 3 })
      yield* service.bind(admission, id("stopped_lead"))
      yield* Scope.close(lead, Exit.void)
      // The lead's job was stopped before its run took the slots: they would stay taken, so a launch would wait.
      const started: string[] = []
      const blocked = yield* holder(service, started, "blocked")
      expect(started).toEqual([])
      yield* service.release(admission, id("stopped_lead"))
      yield* settle
      expect(started).toEqual(["blocked"])
      // A child that took its slots keeps them: release() gives back only what never started.
      const second = yield* Scope.make()
      const again = yield* Scope.provide(second)(service.admit(admitInput("root", { limits: three, reserve: 1 })))
      yield* service.bind(again, id("running_lead"))
      yield* Scope.close(second, Exit.void)
      const running = yield* holder(service, started, "running_lead")
      yield* service.release(again, id("running_lead"))
      expect(yield* service.status(CONVERSATION)).toMatchObject({ running: 2, queued: 0 })
      const late = yield* holder(service, started, "late")
      expect(started).not.toContain("late")
      yield* blocked.release
      expect(started).toContain("late")
      yield* running.release
      yield* late.release
      expect(yield* service.status(CONVERSATION)).toMatchObject({ running: 0, queued: 0 })
    }),
  )
})

describe("TaskLimits seed and status", () => {
  it.effect("seed counts the request's children and their spend from the database once", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const insert = (
        name: string,
        values: {
          parent?: string
          metadata?: Record<string, unknown>
          request?: string
          role?: string
          cost?: number
          subagent?: number
          unpriced?: number
          subagentUnpriced?: number
          codium?: number
          subagentCodium?: number
        } = {},
      ) =>
        db
          .insert(SessionTable)
          .values({
            id: id(name),
            parent_id: values.parent ? id(values.parent) : undefined,
            project_id: Project.ID.global,
            slug: name,
            directory: "/project",
            title: name,
            version: "test",
            cost: values.cost ?? 0,
            subagent_cost: values.subagent ?? 0,
            unpriced_steps: values.unpriced ?? 0,
            subagent_unpriced_steps: values.subagentUnpriced ?? 0,
            codium_steps: values.codium ?? 0,
            subagent_codium_steps: values.subagentCodium ?? 0,
            metadata:
              values.metadata ??
              (values.request
                ? {
                    subagent: {
                      requestID: values.request,
                      ...(values.role ? { workflow: { role: values.role } } : {}),
                    },
                  }
                : undefined),
          })
          .run()
          .pipe(Effect.orDie)
      const request = "msg_seeded"
      yield* insert("conversation")
      yield* insert("swarm", { metadata: { vector: { kind: "parallel-agent", parentSessionId: id("conversation") } } })
      yield* insert("c1", {
        parent: "conversation",
        request,
        cost: 1,
        subagent: 0.5,
        unpriced: 101,
        codium: 100,
        subagentUnpriced: 80,
        subagentCodium: 80,
      })
      // Its child's spend and Codium steps are in c1's subagent rollups already.
      yield* insert("g1", { parent: "c1", request, cost: 0.5, unpriced: 80, codium: 80 })
      yield* insert("c2", { parent: "conversation", request, cost: 2 })
      yield* insert("c3", { parent: "conversation", request: "msg_other", cost: 4 })
      yield* insert("g2", { parent: "c3", request, cost: 0.3, unpriced: 55, codium: 55 })
      yield* insert("w1", { parent: "swarm", request, cost: 0.25, unpriced: 70, codium: 70 })
      // A workflow run counts once; its agents count against the run.
      yield* insert("run", {
        parent: "conversation",
        request,
        role: "run",
        subagent: 0.2,
        subagentUnpriced: 140,
        subagentCodium: 140,
      })
      yield* insert("agent1", { parent: "run", request, role: "agent", cost: 0.1, unpriced: 70, codium: 70 })
      yield* insert("agent2", { parent: "run", request, role: "agent", cost: 0.1, unpriced: 70, codium: 70 })
      yield* insert("helper", { parent: "conversation", cost: 9 })
      yield* insert("stranger")
      yield* insert("stranger_child", { parent: "stranger", request, cost: 7 })

      const service = yield* TaskLimits.Service
      const conversation = id("conversation")
      const seed = yield* service.seed(conversation, request)
      expect(seed.steps).toBe(0)
      expect(seed.unpricedSteps).toBe(1)
      expect(seed.codiumSteps).toBe(445)
      expect(seed.spentUsd).toBeCloseTo(4.25, 10)
      const seven = { ...limits(8, 7), budget: { usd: 25, unpricedSteps: 40 } }
      const counted = yield* service.status(conversation, request, seven)
      expect(counted.launched).toBe(6)
      expect(counted.spend).toMatchObject({ limitUsd: 25, unknownSteps: 1, warned: false, stopped: false })
      // Once per key: later rows are not read again, launches in this process are counted on top.
      yield* insert("late", { parent: "conversation", request, cost: 1 })
      yield* Effect.scoped(
        service
          .admit({ conversationID: conversation, requestID: request, limits: seven, origin: "root", count: 1 })
          .pipe(Effect.flatMap((admission) => service.bind(admission, id("late")))),
      )
      expect((yield* service.status(conversation, request)).launched).toBe(7)
      // The request's delegated ledger starts at the seeded spend.
      const guard = yield* SpendGuard.Service
      const ledger = yield* guard.delegated(TaskLimits.ledger(conversation, request))
      expect(ledger?.spentUsd).toBeCloseTo(4.25, 10)
      expect(ledger).toMatchObject({ steps: 0, unpricedSteps: 1, codiumSteps: 445 })
      const over = yield* Effect.scoped(
        service.admit({ conversationID: conversation, requestID: request, limits: seven, origin: "nested", count: 1 }),
      ).pipe(Effect.flip)
      expect(over.message).toContain("already started 7 of the 7")
    }),
  )

  it.effect("restarted requests exclude Codium from the unknown-step cap while mixed unknown usage stays bounded", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* TaskLimits.Service
      const guard = yield* SpendGuard.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const conversationID = id("codium_restart")
      const row = { project_id: Project.ID.global, directory: "/project", version: "test" }
      yield* db
        .insert(SessionTable)
        .values({ ...row, id: conversationID, slug: "restart", title: "Restart" })
        .run()
        .pipe(Effect.orDie)
      for (const unknown of [0, 39, 40]) {
        const requestID = `msg_codium_restart_${unknown}`
        const childID = id(`codium_restart_${unknown}`)
        // These durable rows exist before this process first seeds the request.
        yield* db
          .insert(SessionTable)
          .values({
            ...row,
            id: childID,
            parent_id: conversationID,
            slug: requestID,
            title: requestID,
            cost: 1,
            unpriced_steps: 80 + unknown,
            codium_steps: 80,
            metadata: { subagent: { requestID } },
          })
          .run()
          .pipe(Effect.orDie)
        expect(yield* service.seed(conversationID, requestID)).toEqual({
          spentUsd: 1,
          steps: 0,
          unpricedSteps: unknown,
          codiumSteps: 80,
        })
        const admission = Effect.scoped(
          service.admit({
            conversationID,
            requestID,
            limits: { ...limits(), budget: { usd: 25, unpricedSteps: 40 } },
            origin: "root",
            count: 1,
          }),
        )
        if (unknown < 40) expect((yield* admission).launched).toBe(2)
        else expect((yield* admission.pipe(Effect.flip)).reason).toBe("spend")
        const ledger = yield* guard.delegated(TaskLimits.ledger(conversationID, requestID))
        expect(ledger).toMatchObject({ spentUsd: 1, steps: 0, unpricedSteps: unknown, codiumSteps: 80 })
        expect(ledger?.stopped?.reason).toBe(unknown === 40 ? "unpriced" : undefined)
        expect((yield* service.status(conversationID, requestID)).spend).toMatchObject({
          unknownSteps: unknown,
          stopped: unknown === 40,
        })
      }
    }),
  )

  it.effect("status counts running and waiting children and the request's launches and spend", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      const two = limits(2, 10)
      const started: string[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          for (const name of ["a", "b", "c"]) {
            const admission = yield* service.admit(admitInput("root", { limits: two }))
            yield* service.bind(admission, id(name))
          }
        }),
      )
      const a = yield* holder(service, started, "a")
      const b = yield* holder(service, started, "b")
      const c = yield* holder(service, started, "c")
      const agent = yield* holder(service, started, "agent", "workflow")
      expect(yield* service.status(CONVERSATION, REQUEST)).toEqual({
        running: 2,
        queued: 2,
        limit: 2,
        launched: 3,
        perRequest: 10,
        spend: { spentUsd: 0, limitUsd: 25, unknownSteps: 0, warned: false, stopped: false },
      })
      // A new request with no launches shows none.
      expect((yield* service.status(CONVERSATION, "msg_new")).launched).toBe(0)
      for (const item of [a, b, c, agent]) yield* item.release
      expect(yield* service.status(CONVERSATION)).toMatchObject({ running: 0, queued: 0 })

      // A guest's conversation that never launched shows the guest limits.
      const guests = yield* FreeModelGuests.Service
      yield* guests.mark(id("guest"))
      expect(yield* service.status(id("guest"))).toMatchObject({ limit: 4, perRequest: 8, launched: 0 })
    }),
  )
})

describe("TaskLimits limits and requests", () => {
  // A conversation of its own, so its pool starts empty.
  const RAISED = "ses_raised_conversation"
  const run = (service: TaskLimits.Interface, started: string[], name: string) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const fiber = yield* service
        .run(
          { conversationID: RAISED, childID: id(name), origin: "root" },
          Effect.sync(() => started.push(name)).pipe(Effect.andThen(Deferred.await(gate))),
        )
        .pipe(Effect.forkChild)
      yield* settle
      return { fiber, release: Deferred.succeed(gate, undefined).pipe(Effect.andThen(settle)) }
    })

  it.effect("a raised running limit starts the waiters it now has room for, by status or by admit", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      const started: string[] = []
      yield* service.status(RAISED, undefined, limits(2))
      const runs = yield* Effect.forEach(["raise_1", "raise_2", "raise_3", "raise_4", "raise_5"], (name) =>
        run(service, started, name),
      )
      expect(started).toEqual(["raise_1", "raise_2"])
      expect(yield* service.status(RAISED)).toMatchObject({ running: 2, queued: 3 })
      // The config now allows 4: reading the board with it starts two waiters, in order, at once.
      expect(yield* service.status(RAISED, undefined, limits(4))).toMatchObject({ running: 4, queued: 1, limit: 4 })
      yield* settle
      expect(started).toEqual(["raise_1", "raise_2", "raise_3", "raise_4"])
      // An admission under 5 starts the last waiter before it takes its own place, which then waits behind the five.
      const admission = yield* Effect.scoped(
        service.admit({ conversationID: RAISED, requestID: REQUEST, limits: limits(5), origin: "root", count: 1 }),
      )
      yield* settle
      expect(started).toEqual(["raise_1", "raise_2", "raise_3", "raise_4", "raise_5"])
      expect(admission).toMatchObject({ running: 5, queued: 0, waits: true })
      for (const item of runs) yield* item.release
      expect(yield* service.status(RAISED)).toMatchObject({ running: 0, queued: 0 })
    }),
  )

  it.effect("a request whose count cannot be read is refused, not counted as none, and read again next time", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* TaskLimits.Service
      const request = "msg_unreadable"
      const moved = db.run(sql`ALTER TABLE session RENAME TO session_moved`).pipe(Effect.orDie)
      const back = db.run(sql`ALTER TABLE session_moved RENAME TO session`).pipe(Effect.orDie)
      const refused = yield* Effect.acquireUseRelease(
        moved,
        () =>
          Effect.gen(function* () {
            const admitted = yield* Effect.scoped(
              service.admit({ conversationID: RAISED, requestID: request, limits: limits(), origin: "root", count: 1 }),
            ).pipe(Effect.flip)
            const batch = yield* service
              .capacity({ conversationID: RAISED, requestID: request, limits: limits(), need: 2 })
              .pipe(Effect.flip)
            // The board still answers, with nothing kept for the request.
            expect((yield* service.status(RAISED, request, limits())).launched).toBe(0)
            return [admitted, batch]
          }),
        () => back,
      )
      for (const item of refused) {
        expect(item.reason).toBe("unavailable")
        expect(item.message).toContain("No child was started.")
      }
      // Readable again: the next launch reads the count and is admitted.
      const admitted = yield* Effect.scoped(
        service
          .admit({ conversationID: RAISED, requestID: request, limits: limits(), origin: "root", count: 1 })
          .pipe(Effect.tap((admission) => service.bind(admission, id("readable")))),
      )
      expect(admitted.launched).toBe(1)
      expect((yield* service.status(RAISED, request)).launched).toBe(1)
    }),
  )

  it.effect("the request a root's launches count in is the one its prompt loop tracked, else its latest message", () =>
    Effect.gen(function* () {
      const service = yield* TaskLimits.Service
      const root = id("tracked_root")
      const latest = { findMessage: () => Effect.succeed(Option.none()) } as never
      expect(yield* service.tracked(root)).toBeUndefined()
      // Nothing tracked and no message: the root's own ID, as currentRequest gives.
      expect(yield* TaskLimits.requestFor(service, latest, root)).toBe(root)
      yield* service.track(root, "msg_opener")
      yield* service.track(id("other_root"), "msg_other")
      expect(yield* TaskLimits.requestFor(service, latest, root)).toBe("msg_opener")
      yield* service.track(root, "msg_next")
      expect(yield* service.tracked(root)).toBe("msg_next")
    }),
  )
})
