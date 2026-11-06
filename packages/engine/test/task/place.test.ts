import { afterEach, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Fiber } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Global } from "@vectordevai/core/global"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { TaskPlace } from "@/task/place"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Permission.node,
      Question.node,
      SessionStatus.node,
      Session.node,
      SessionProjector.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

const tracked = new Set<string>()
const sessionID = () => {
  const id = SessionID.descending()
  tracked.add(id)
  return id
}

afterEach(() => {
  for (const id of tracked) TaskPlace.drop(id)
  tracked.clear()
})

const placement = Effect.gen(function* () {
  const home = yield* InstanceState.context
  const directory = yield* tmpdirScoped()
  const work = { ...home, directory, worktree: directory }
  const id = sessionID()
  TaskPlace.set(id, { work, home })
  return { id, home, work }
})

it.instance("within and atHome scope context without changing their caller's context", () =>
  Effect.gen(function* () {
    const place = yield* placement
    expect(yield* TaskPlace.within(place.id)(InstanceState.context)).toEqual(place.work)
    expect(yield* TaskPlace.within(place.id)(TaskPlace.atHome(place.id)(InstanceState.context))).toEqual(place.home)
    expect(yield* InstanceState.context).toEqual(place.home)
    yield* TaskPlace.within(place.id)(Effect.die("fixture failure")).pipe(Effect.exit)
    expect(yield* InstanceState.context).toEqual(place.home)
    const unknown = sessionID()
    expect(yield* TaskPlace.within(unknown)(InstanceState.context)).toEqual(place.home)
    expect(yield* TaskPlace.atHome(unknown)(InstanceState.context)).toEqual(place.home)
  }),
)

it.instance("trusted lineage survives a replacement place and descendants inherit work", () =>
  Effect.gen(function* () {
    const place = yield* placement
    const root = sessionID()
    const shared = sessionID()
    TaskPlace.inherit(shared, root)
    TaskPlace.inherit(place.id, shared)
    TaskPlace.set(place.id, place)
    expect(TaskPlace.parentOf(place.id)).toBe(shared)
    expect(TaskPlace.get(shared)).toEqual({ work: place.home, home: place.home })
    expect(yield* TaskPlace.within(place.id)(TaskPlace.within(root)(InstanceState.context))).toEqual(place.home)
    const grandchild = sessionID()
    TaskPlace.inherit(grandchild, place.id)
    expect(TaskPlace.get(grandchild)).toEqual({ home: place.home, work: place.work })
    expect(TaskPlace.parentOf(grandchild)).toBe(place.id)
    expect(TaskPlace.places().find((entry) => entry.sessionID === grandchild)?.parentID).toBe(place.id)
    TaskPlace.dropWork(place.id)
    expect(TaskPlace.get(place.id)).toEqual({ work: place.home, home: place.home })
    expect(TaskPlace.get(grandchild)).toEqual({ work: place.home, home: place.home })
    expect(TaskPlace.parentOf(place.id)).toBe(shared)
    TaskPlace.drop(place.id)
    expect(TaskPlace.get(place.id)).toBeUndefined()
    expect(TaskPlace.parentOf(place.id)).toBeUndefined()
  }),
)

it.instance("a real created child registers its root's home before replacement with isolated work", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const home = yield* InstanceState.context
    const root = yield* sessions.create({})
    const child = yield* sessions.create({ parentID: root.id })
    tracked.add(root.id)
    tracked.add(child.id)
    const directory = yield* tmpdirScoped()
    TaskPlace.set(child.id, { home, work: { ...home, directory, worktree: directory } })
    expect(TaskPlace.parentOf(child.id)).toBe(root.id)
    expect(yield* TaskPlace.within(child.id)(TaskPlace.within(root.id)(InstanceState.context))).toEqual(home)
    expect(yield* TaskPlace.within(child.id)(TaskPlace.atHome(root.id)(InstanceState.context))).toEqual(home)
    const grandchild = yield* TaskPlace.within(child.id)(sessions.create({ parentID: child.id }))
    tracked.add(grandchild.id)
    expect(grandchild.directory).toBe(home.directory)
    expect(TaskPlace.get(grandchild.id)?.work.directory).toBe(directory)
    TaskPlace.dropWork(child.id)
    expect(TaskPlace.get(grandchild.id)?.work.directory).toBe(home.directory)
    const resumed = yield* tmpdirScoped()
    TaskPlace.set(child.id, { home, work: { ...home, directory: resumed, worktree: resumed } })
    yield* sessions.get(grandchild.id)
    expect(TaskPlace.get(grandchild.id)?.work.directory).toBe(resumed)
    // Explicit work is not an inherited assignment and cannot be overwritten by re-reading its parent.
    const independent = sessionID()
    TaskPlace.set(independent, { home, work: home })
    TaskPlace.inherit(independent, child.id)
    expect(TaskPlace.get(independent)?.work.directory).toBe(home.directory)
  }),
)

it.instance("status get, set and list use home, including an unmapped root from a work callback", () =>
  Effect.gen(function* () {
    const place = yield* placement
    const statuses = yield* SessionStatus.Service
    const root = sessionID()
    // The root intentionally has no Place: the ambient work directory still identifies its unique home.
    expect(TaskPlace.get(root)).toBeUndefined()
    yield* TaskPlace.within(place.id)(statuses.set(place.id, { type: "busy" }))
    yield* TaskPlace.within(place.id)(statuses.set(root, { type: "busy" }))
    expect((yield* statuses.get(place.id)).type).toBe("busy")
    expect((yield* statuses.get(root)).type).toBe("busy")
    expect((yield* TaskPlace.within(place.id)(statuses.get(root))).type).toBe("busy")
    expect([...(yield* TaskPlace.within(place.id)(statuses.list())).keys()].sort()).toEqual([place.id, root].sort())
    yield* TaskPlace.within(place.id)(statuses.set(place.id, { type: "idle" }))
    expect((yield* statuses.list()).has(place.id)).toBe(false)
  }),
)

it.instance("ambient home routing resolves a symlink spelling of the same work directory", () =>
  Effect.gen(function* () {
    const place = yield* placement
    const outside = yield* tmpdirScoped()
    const alias = path.join(outside, "alias")
    yield* Effect.promise(() =>
      fs.symlink(place.work.directory, alias, process.platform === "win32" ? "junction" : "dir"),
    )
    const context = { ...place.work, directory: alias, worktree: alias }
    expect(yield* TaskPlace.atHome()(InstanceState.context).pipe(Effect.provideService(InstanceRef, context))).toEqual(
      place.home,
    )
  }),
)

it.instance("an ambiguous ambient work context fails instead of choosing another home's requests", () =>
  Effect.gen(function* () {
    const place = yield* placement
    const directory = yield* tmpdirScoped()
    TaskPlace.set(sessionID(), { work: place.work, home: { ...place.home, directory } })
    const exit = yield* TaskPlace.within(place.id)(TaskPlace.atHome()(InstanceState.context)).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("more than one home")
  }),
)

it.instance("a permission asked at work is listed and answered at home with its patterns intact", () =>
  Effect.gen(function* () {
    const place = yield* placement
    const permissions = yield* Permission.Service
    const patterns = [path.join(place.work.directory, "src", "file.ts")]
    const fiber = yield* TaskPlace.within(place.id)(
      permissions.ask({ sessionID: place.id, permission: "edit", patterns, always: [], metadata: {}, ruleset: [] }),
    ).pipe(Effect.forkScoped)
    const pending = yield* pollWithTimeout(
      permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === place.id))),
      "the home permission never became pending",
    )
    expect(pending.patterns).toEqual(patterns)
    expect(yield* TaskPlace.within(place.id)(permissions.list())).toEqual([])
    yield* permissions.reply({ requestID: pending.id, reply: "once" })
    yield* Fiber.join(fiber)
    expect(yield* permissions.list()).toEqual([])
  }),
)

it.instance("a question asked at work is listed and answered at home", () =>
  Effect.gen(function* () {
    const place = yield* placement
    const questions = yield* Question.Service
    const fiber = yield* TaskPlace.within(place.id)(
      questions.ask({
        sessionID: place.id,
        questions: [{ question: "Choose", header: "Choice", options: [{ label: "One", description: "First" }] }],
      }),
    ).pipe(Effect.forkScoped)
    const pending = yield* pollWithTimeout(
      questions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === place.id))),
      "the home question never became pending",
    )
    expect(yield* TaskPlace.within(place.id)(questions.list())).toEqual([])
    yield* questions.reply({ requestID: pending.id, answers: [["One"]] })
    expect(yield* Fiber.join(fiber)).toEqual([["One"]])
    expect(yield* questions.list()).toEqual([])
  }),
)

it.instance("interrupting work askers withdraws both home-hosted request kinds", () =>
  Effect.gen(function* () {
    const place = yield* placement
    const permissions = yield* Permission.Service
    const questions = yield* Question.Service
    const permission = yield* TaskPlace.within(place.id)(
      permissions.ask({
        sessionID: place.id,
        permission: "edit",
        patterns: ["src/a.ts"],
        always: [],
        metadata: {},
        ruleset: [],
      }),
    ).pipe(Effect.forkScoped)
    const question = yield* TaskPlace.within(place.id)(
      questions.ask({
        sessionID: place.id,
        questions: [{ question: "Choose", header: "Choice", options: [{ label: "One", description: "First" }] }],
      }),
    ).pipe(Effect.forkScoped)
    yield* pollWithTimeout(
      Effect.gen(function* () {
        return (yield* permissions.list()).length === 1 && (yield* questions.list()).length === 1 ? true : undefined
      }),
      "the home requests never became pending",
    )
    yield* Fiber.interrupt(permission)
    yield* Fiber.interrupt(question)
    expect(yield* permissions.list()).toEqual([])
    expect(yield* questions.list()).toEqual([])
  }),
)

it.instance("only a matching authoritative registry identifies a task directory", () =>
  Effect.gen(function* () {
    const id = sessionID()
    const home = yield* InstanceState.context
    const project = `place-test-${id}`
    const directory = path.join(Global.Path.data, "task-worktree", project, id)
    const registry = path.join(Global.Path.data, "task-isolation", project, id, "record.json")
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await fs.rm(path.join(Global.Path.data, "task-worktree", project), { recursive: true, force: true })
        await fs.rm(path.join(Global.Path.data, "task-isolation", project), { recursive: true, force: true })
      }),
    )
    yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
    TaskPlace.set(id, { home, work: { ...home, directory, worktree: directory } })
    expect(TaskPlace.isTaskDirectory(directory)).toBe(false)
    yield* Effect.promise(async () => {
      await fs.mkdir(path.dirname(registry), { recursive: true })
      await fs.writeFile(registry, JSON.stringify({ directory, branch: `vector/subagent/${id}` }))
    })
    expect(TaskPlace.isTaskDirectory(directory)).toBe(true)
    yield* Effect.promise(() => fs.writeFile(registry, JSON.stringify({ directory, mode: "copy" })))
    expect(TaskPlace.isTaskDirectory(directory)).toBe(true)
    yield* Effect.promise(() => fs.writeFile(registry, JSON.stringify({ directory, mode: "unknown" })))
    expect(TaskPlace.isTaskDirectory(directory)).toBe(false)
    yield* Effect.promise(() => fs.writeFile(registry, JSON.stringify({ directory, mode: "copy", branch: "main" })))
    expect(TaskPlace.isTaskDirectory(directory)).toBe(false)
    yield* Effect.promise(() => fs.writeFile(registry, JSON.stringify({ directory, branch: "main" })))
    expect(TaskPlace.isTaskDirectory(directory)).toBe(false)
    yield* Effect.promise(() =>
      fs.writeFile(registry, JSON.stringify({ directory: home.directory, branch: `vector/subagent/${id}` })),
    )
    expect(TaskPlace.isTaskDirectory(directory)).toBe(false)
    const nested = path.join(directory, "nested")
    yield* Effect.promise(() => fs.mkdir(nested))
    expect(TaskPlace.isTaskDirectory(nested)).toBe(false)
  }),
)
