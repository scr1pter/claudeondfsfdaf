import { expect } from "bun:test"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { Auth } from "@/auth"
import { Npm } from "@vectordevai/core/npm"
import { Shell } from "@vectordevai/core/shell"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID, SessionID } from "@/session/schema"
import { TaskManager } from "@/task/manager"
import { TaskJobs } from "@/task/jobs"
import { TaskPlace } from "@/task/place"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import type { TaskPromptOps } from "@/tool/task"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionPrompt.node,
      SessionRunState.node,
      Session.node,
      SessionStatus.node,
      SessionProjector.node,
      Permission.node,
      Question.node,
      BackgroundJob.node,
      TaskManager.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
    ]),
    [
      [Auth.node, AuthTest.empty],
      [Npm.node, NpmTest.noop],
    ],
  ),
)
const model = { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") }
const metadata = (parentID: SessionID) => ({
  subagent: {
    kind: "subagent",
    custom: false,
    agent: "general",
    title: "Routing fixture",
    callID: "call_routing",
    parentSessionID: parentID,
    parentMessageID: MessageID.ascending(),
    model,
    status: "running",
    background: true,
    startedAt: Date.now(),
    attempt: 1,
    runtimeID: SubagentLifecycle.RUNTIME_ID,
  },
})
const response = (sessionID: SessionID) => ({
  info: {
    id: MessageID.ascending(),
    sessionID,
    parentID: MessageID.ascending(),
    role: "assistant" as const,
    agent: "general",
    mode: "general",
    modelID: model.modelID,
    providerID: model.providerID,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
    path: { cwd: "/", root: "/" },
  },
  parts: [],
})

function cwdCommand() {
  const shell = Shell.preferred()
  const executable = Shell.quote(shell, process.execPath)
  const script = Shell.quote(shell, "process.stdout.write(process.cwd())")
  if (!executable || !script) throw new Error("The test command cannot be quoted for the selected shell.")
  return `${Shell.ps(shell) ? "& " : ""}${executable} -e ${script}`
}

const placed = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const store = yield* InstanceStore.Service
  const home = yield* InstanceState.context
  const directory = yield* tmpdirScoped()
  const root = yield* sessions.create({ title: "Root" })
  const child = yield* sessions.create({ parentID: root.id, metadata: metadata(root.id) })
  // Load through the real store twice: routing reuses this context, it does not bootstrap on each call.
  const work = yield* store.load({ directory, worktree: directory, project: home.project })
  expect(yield* store.load({ directory, worktree: directory, project: home.project })).toBe(work)
  TaskPlace.set(child.id, { home, work })
  const ids = new Set<string>([root.id, child.id])
  yield* Effect.addFinalizer(() => Effect.sync(() => ids.forEach(TaskPlace.drop)))
  return { home, work, root, child, ids, store, sessions }
})

it.instance("a helper's direct shell uses work cwd and reuses one loaded instance", () =>
  Effect.gen(function* () {
    const place = yield* placed
    const prompt = yield* SessionPrompt.Service
    const command = cwdCommand()
    const result = yield* prompt.shell({ sessionID: place.child.id, agent: "general", model, command })
    const tool = result.parts.find((part) => part.type === "tool")
    expect(tool?.state.status).toBe("completed")
    if (tool?.state.status === "completed") expect(tool.state.output.trim()).toBe(place.work.directory)
    expect(result.info.role === "assistant" && result.info.path.cwd).toBe(place.work.directory)
    expect((yield* place.store.loaded()).filter((ctx) => ctx.directory === place.work.directory)).toHaveLength(1)
    expect((yield* place.sessions.get(place.child.id)).directory).toBe(place.home.directory)
  }),
)

it.instance(
  "cancel at home stops the work runner and rejects all of its home asks, leaving another session's ask",
  () =>
    Effect.gen(function* () {
      const place = yield* placed
      const prompt = yield* SessionPrompt.Service
      const runners = yield* SessionRunState.Service
      const permissions = yield* Permission.Service
      const questions = yield* Question.Service
      const ready = yield* Deferred.make<void>()
      const running = yield* runners
        .startRunning(
          place.child.id,
          Effect.succeed(response(place.child.id)),
          Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(ready)
      const ask = (sessionID: SessionID, suffix: string) =>
        permissions
          .ask({
            sessionID,
            permission: "edit",
            patterns: [path.join(place.work.directory, suffix)],
            always: [],
            metadata: {},
            ruleset: [],
          })
          .pipe(Effect.exit, Effect.forkScoped)
      const first = yield* TaskPlace.within(place.child.id)(ask(place.child.id, "one"))
      const second = yield* TaskPlace.within(place.child.id)(ask(place.child.id, "two"))
      const other = yield* ask(place.root.id, "other")
      const question = yield* TaskPlace.within(place.child.id)(
        questions.ask({
          sessionID: place.child.id,
          questions: [
            { question: "Proceed?", header: "Proceed", options: [{ label: "Yes", description: "Continue" }] },
          ],
        }),
      ).pipe(Effect.exit, Effect.forkScoped)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* permissions.list()).length === 3 && (yield* questions.list()).length === 1 ? true : undefined
        }),
        "asks never reached home",
      )
      yield* prompt.cancel(place.child.id)
      expect(Exit.isSuccess(yield* Fiber.await(running))).toBe(true)
      expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true)
      expect(Exit.isFailure(yield* Fiber.join(second))).toBe(true)
      expect(Exit.isFailure(yield* Fiber.join(question))).toBe(true)
      expect((yield* permissions.list()).map((request) => request.sessionID)).toEqual([place.root.id])
      expect(yield* questions.list()).toEqual([])
      const statuses = yield* SessionStatus.Service
      expect((yield* statuses.get(place.child.id)).type).toBe("idle")
      yield* Fiber.interrupt(other)
    }),
)

it.instance("direct busy checks from home see the runner at work", () =>
  Effect.gen(function* () {
    const place = yield* placed
    const runners = yield* SessionRunState.Service
    const prompt = yield* SessionPrompt.Service
    const ready = yield* Deferred.make<void>()
    const running = yield* runners
      .startRunning(
        place.child.id,
        Effect.succeed(response(place.child.id)),
        Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkScoped)
    yield* Deferred.await(ready)
    const busy = yield* runners.assertNotBusy(place.child.id).pipe(Effect.exit)
    expect(Exit.isFailure(busy)).toBe(true)
    if (Exit.isFailure(busy)) expect(Cause.squash(busy.cause)).toBeInstanceOf(Session.BusyError)
    const shell = yield* prompt
      .shell({ sessionID: place.child.id, agent: "general", model, command: "echo should-not-run" })
      .pipe(Effect.exit)
    expect(Exit.isFailure(shell)).toBe(true)
    if (Exit.isFailure(shell)) expect(Cause.squash(shell.cause)).toBeInstanceOf(Session.BusyError)
    yield* prompt.cancel(place.child.id)
    yield* Fiber.await(running)
  }),
)

it.instance("an existing grandchild recovers inherited work before shell and event publication", () =>
  Effect.gen(function* () {
    const place = yield* placed
    const prompt = yield* SessionPrompt.Service
    const events = yield* EventV2Bridge.Service
    const grandchild = yield* TaskPlace.within(place.child.id)(place.sessions.create({ parentID: place.child.id }))
    place.ids.add(grandchild.id)
    TaskPlace.drop(grandchild.id)
    expect(TaskPlace.get(grandchild.id)).toBeUndefined()
    const locations: string[] = []
    const off = yield* events.listen((event) =>
      Effect.sync(() => {
        if (
          event.type === SessionV1.Event.PartUpdated.type &&
          typeof event.data === "object" &&
          event.data &&
          "sessionID" in event.data &&
          event.data.sessionID === grandchild.id
        )
          locations.push(String(event.location?.directory))
      }),
    )
    yield* Effect.addFinalizer(() => off)
    const result = yield* prompt.shell({
      sessionID: grandchild.id,
      agent: "general",
      model,
      command: cwdCommand(),
    })
    expect(result.info.role === "assistant" && result.info.path.cwd).toBe(place.work.directory)
    expect(TaskPlace.get(grandchild.id)?.work.directory).toBe(place.work.directory)
    expect(locations.length).toBeGreaterThan(0)
    expect(new Set(locations)).toEqual(new Set([place.home.directory]))
  }),
)

it.instance(
  "the root can message, wait on and stop grandchildren whose jobs live in the isolated parent's registry",
  () =>
    Effect.gen(function* () {
      const place = yield* placed
      const jobs = yield* BackgroundJob.Service
      const manager = yield* TaskManager.Service
      const prompt = yield* SessionPrompt.Service
      const grandchild = yield* TaskPlace.within(place.child.id)(
        place.sessions.create({ parentID: place.child.id, metadata: metadata(place.child.id) }),
      )
      place.ids.add(grandchild.id)
      const gate = yield* Deferred.make<void>()
      yield* TaskPlace.within(place.child.id)(
        jobs.start({
          id: grandchild.id,
          type: "task",
          metadata: {
            parentSessionId: place.child.id,
            sessionId: grandchild.id,
            background: true,
          },
          run: Deferred.await(gate).pipe(Effect.as("initial")),
        }),
      )
      expect(yield* jobs.get(grandchild.id)).toBeUndefined()
      const delivered: string[] = []
      const ops: TaskPromptOps = {
        cancel: (id) => prompt.cancel(id),
        resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
        prompt: (input) =>
          InstanceState.directory.pipe(
            Effect.map((directory) => {
              delivered.push(directory)
              return response(input.sessionID)
            }),
          ),
      }
      expect(
        (yield* manager.message(
          { sessionID: place.root.id, taskID: grandchild.id, text: "Continue", delivery: "queue", origin: "user" },
          ops,
        )).accepted,
      ).toBe(true)
      yield* Deferred.succeed(gate, undefined)
      expect(
        (yield* manager.wait({ sessionID: place.root.id, taskIDs: [grandchild.id], timeout: 2000 })).timedOut,
      ).toBe(false)
      expect(delivered).toEqual([place.work.directory])
      const second = yield* TaskPlace.within(place.child.id)(
        place.sessions.create({ parentID: place.child.id, metadata: metadata(place.child.id) }),
      )
      place.ids.add(second.id)
      yield* TaskPlace.within(place.child.id)(
        jobs.start({
          id: second.id,
          type: "task",
          metadata: { parentSessionId: place.child.id, sessionId: second.id, background: true },
          run: Effect.never,
        }),
      )
      yield* manager.stop({ sessionID: place.root.id, taskIDs: [second.id], origin: "user" }, ops)
      expect((yield* TaskPlace.within(place.child.id)(jobs.get(second.id)))?.status).toBe("cancelled")
      expect(
        (yield* manager.wait({ sessionID: place.root.id, taskIDs: [second.id], timeout: 0 })).tasks[0]?.status,
      ).toBe("stopped")
    }),
)

it.instance("known job enumeration does not cross another home's boundary", () =>
  Effect.gen(function* () {
    const place = yield* placed
    const jobs = yield* BackgroundJob.Service
    const unrelated = yield* tmpdirScoped()
    const context = { ...place.home, directory: unrelated, worktree: unrelated }
    const other = SessionID.descending()
    place.ids.add(other)
    TaskPlace.set(other, { home: context, work: context })
    yield* jobs.start({ id: "own-registry-fixture", type: "fixture", run: Effect.never })
    yield* jobs
      .start({ id: "unrelated-registry-fixture", type: "fixture", run: Effect.never })
      .pipe(Effect.provideService(InstanceRef, context))
    expect((yield* TaskJobs.all(jobs)).map(({ info }) => info.id)).toContain("own-registry-fixture")
    expect((yield* TaskJobs.all(jobs)).map(({ info }) => info.id)).not.toContain("unrelated-registry-fixture")
  }),
)
