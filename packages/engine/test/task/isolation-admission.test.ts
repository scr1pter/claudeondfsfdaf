import { afterEach, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { Npm } from "@vectordevai/core/npm"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { SessionTable } from "@vectordevai/core/session/sql"
import { Auth } from "@/auth"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { TaskClaims } from "@/task/claims"
import { TaskIsolation } from "@/task/isolation"
import { TaskPlace } from "@/task/place"
import { Worktree } from "@/worktree"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

// Execution admission (handoff 7.3): an isolated task, or a shared descendant of one whose work was retired, runs
// only through its parent's validated resume. A direct prompt is refused before anything is stored, so no provider
// request, spend or write can follow; it never falls back to running at home. No model is configured: a prompt that
// got past admission would store its message first, which these checks would see.
const services = AppNodeBuilder.build(
  LayerNode.group([
    TaskIsolation.node,
    Worktree.node,
    InstanceStore.node,
    Session.node,
    SessionRunState.node,
    BackgroundJob.node,
    Git.node,
    Agent.node,
    Config.node,
    CrossSpawnSpawner.node,
    SessionAudience.node,
    Database.node,
  ]),
  [
    [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
    [Auth.node, AuthTest.empty],
    [Npm.node, NpmTest.noop],
  ],
)
const it = testEffect(Layer.mergeAll(services, httpApiLayer))
const options = { trusted: true, git: true, config: { formatter: false, lsp: false } } as const
const json = { "content-type": "application/json" }
const prompt = { parts: [{ type: "text", text: "Continue the task" }] }

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const family = Effect.gen(function* () {
  const home = yield* InstanceState.context
  const sessions = yield* Session.Service
  const isolation = yield* TaskIsolation.Service
  const agents = yield* Agent.Service
  const parent = yield* sessions.create({ title: "Admission parent" })
  const child = yield* sessions.create({ parentID: parent.id, title: "Isolated child" })
  const grandchild = yield* sessions.create({ parentID: child.id, title: "Shared descendant" })
  const agent = yield* agents.get("general")
  if (!agent) throw new Error("general agent unavailable")
  const workPath = path.join(Global.Path.data, "task-worktree", home.project.id, child.id)
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      yield* store.disposeDirectory(workPath)
      const service = yield* Git.Service
      yield* service.run(["worktree", "remove", "--force", workPath], { cwd: home.directory })
      yield* service.run(["branch", "-D", `vector/subagent/${child.id}`], { cwd: home.directory })
      yield* Effect.promise(async () => {
        await fs.rm(workPath, { recursive: true, force: true })
        await fs.rm(path.join(Global.Path.data, "task-isolation", home.project.id, child.id), {
          recursive: true,
          force: true,
        })
      })
      TaskClaims.unprotect(child.id)
      for (const id of [grandchild.id, child.id, parent.id]) TaskPlace.drop(id)
    }).pipe(Effect.orDie),
  )
  yield* isolation.fence(parent.id)
  yield* isolation.reserve({ taskID: child.id, parentSessionID: parent.id, title: "Admission fixture", agent })
  yield* isolation.start(child.id)
  return { home, sessions, isolation, parent, child, grandchild }
})

const messages = (id: string) =>
  Effect.flatMap(Session.Service, (sessions) => sessions.messages({ sessionID: id as never }))

it.instance(
  "a retired isolated task and its shared descendant are refused before anything is stored",
  () =>
    Effect.gen(function* () {
      const f = yield* family
      // Saving retires the checkout: the task now runs only through its parent's resume.
      expect((yield* f.isolation.settle({ taskID: f.child.id, attempt: 1 })).state).toBe("unchanged")
      for (const id of [f.child.id, f.grandchild.id]) {
        const response = yield* requestInDirectory(`/session/${id}/message`, f.home.directory, {
          method: "POST",
          headers: json,
          body: JSON.stringify(prompt),
        })
        expect(response.status).toBe(400)
        expect(yield* messages(id)).toEqual([])
        const refused = yield* f.isolation.admit(id).pipe(Effect.flip)
        expect(refused).toMatchObject({ code: "retired" })
      }
      // The launching conversation itself stays at home and is admitted.
      yield* f.isolation.admit(f.parent.id)
    }),
  options,
)

it.instance(
  "the V2 runner refuses a helper in a conversation with isolated work instead of running it at home",
  () =>
    Effect.gen(function* () {
      const f = yield* family
      for (const id of [f.child.id, f.grandchild.id]) {
        const response = yield* requestInDirectory(`/api/session/${id}/prompt`, f.home.directory, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ prompt: { text: "Continue at home" } }),
        })
        expect(response.status).toBe(409)
        expect(yield* response.text).toContain("Continue it through its parent conversation")
        expect(yield* messages(id)).toEqual([])
      }
      expect((yield* f.isolation.settle({ taskID: f.child.id, attempt: 1 })).state).toBe("unchanged")
    }),
  options,
)

it.instance(
  "an orphan is refused only in a private family",
  () =>
    Effect.gen(function* () {
      const f = yield* family
      expect((yield* f.isolation.settle({ taskID: f.child.id, attempt: 1 })).state).toBe("unchanged")
      const database = yield* Database.Service
      // An intermediate session deleted without its descendants leaves them without a validated ancestor.
      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, f.child.id)).run().pipe(Effect.orDie)
      expect(yield* f.isolation.admit(f.grandchild.id).pipe(Effect.flip)).toMatchObject({ code: "retired" })

      // An ordinary family has no isolation, so its orphan keeps today's behaviour.
      const root = yield* f.sessions.create({ title: "Ordinary root" })
      const middle = yield* f.sessions.create({ parentID: root.id })
      const leaf = yield* f.sessions.create({ parentID: middle.id })
      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, middle.id)).run().pipe(Effect.orDie)
      yield* f.isolation.admit(leaf.id)
    }),
  options,
)

it.instance(
  "deleting an isolated child only leaves a tombstone; Git work and its record stay for the sweep",
  () =>
    Effect.gen(function* () {
      const f = yield* family
      const before = yield* f.isolation.get(f.child.id)
      // Removal runs no Git: the checkout and the record's own state are untouched, a separate tombstone is written.
      yield* f.sessions.remove(f.child.id)
      const after = yield* f.isolation.get(f.child.id)
      expect(after.deleted).toBe(true)
      expect(after.state).toBe(before.state)
      expect(yield* Effect.promise(() => fs.stat(before.directory).then(() => true))).toBe(true)
      expect(
        yield* Effect.promise(() =>
          fs
            .readFile(
              path.join(Global.Path.data, "task-isolation", f.home.project.id, f.child.id, "deleted.json"),
              "utf8",
            )
            .then(JSON.parse),
        ),
      ).toEqual({ sessionID: f.child.id, projectID: f.home.project.id })
    }),
  options,
)

it.instance(
  "an agent may merge or discard only its direct children",
  () =>
    Effect.gen(function* () {
      const f = yield* family
      yield* Effect.promise(() =>
        fs.writeFile(path.join(Global.Path.data, "task-worktree", f.home.project.id, f.child.id, "agent.txt"), "x\n"),
      )
      expect((yield* f.isolation.settle({ taskID: f.child.id, attempt: 1 })).state).toBe("changed")
      const by = (sessionID: string) => ({
        kind: "agent" as const,
        sessionID,
        ask: () => Effect.void,
        assertWritable: () => Effect.void,
        assertExternalDirectory: () => Effect.void,
      })
      // The grandchild is not the child's parent, and neither is an unrelated session.
      for (const sessionID of [f.grandchild.id, "ses_unrelated_agent"]) {
        expect(yield* f.isolation.merge({ taskID: f.child.id, by: by(sessionID) }).pipe(Effect.flip)).toMatchObject({
          code: "forbidden",
        })
        expect(yield* f.isolation.discard({ taskID: f.child.id, by: by(sessionID) }).pipe(Effect.flip)).toMatchObject({
          code: "forbidden",
        })
      }
      expect((yield* f.isolation.get(f.child.id)).state).toBe("changed")
      // Its direct parent may discard it.
      expect((yield* f.isolation.discard({ taskID: f.child.id, by: by(f.parent.id) })).record.state).toBe("discarded")
    }),
  options,
)

it.instance(
  "revert and unrevert of an isolated task are refused with a conflict before any snapshot work",
  () =>
    Effect.gen(function* () {
      const f = yield* family
      for (const route of ["revert", "unrevert"] as const) {
        const response = yield* requestInDirectory(`/session/${f.child.id}/${route}`, f.home.directory, {
          method: "POST",
          ...(route === "revert" ? { headers: json, body: JSON.stringify({ messageID: MessageID.ascending() }) } : {}),
        })
        expect(response.status).toBe(409)
        expect(yield* response.json).toMatchObject({ resource: "isolated-task" })
      }
      // Its changes are reviewed through the task; the checkout and record are untouched.
      expect((yield* f.isolation.get(f.child.id)).state).toBe("running")
      expect((yield* f.sessions.get(f.child.id)).revert).toBeUndefined()
    }),
  options,
)

it.instance(
  "a linked isolation folder breaks only isolation: an ordinary session is not isolated and reverts",
  () =>
    Effect.gen(function* () {
      const home = yield* InstanceState.context
      const sessions = yield* Session.Service
      const isolation = yield* TaskIsolation.Service
      const plain = yield* sessions.create({ title: "Ordinary helper" })
      // The isolation folder is a link, as when the data folder or part of it was moved to another disk.
      const link = path.join(Global.Path.data, "task-isolation")
      const aside = `${link}-aside-${plain.id}`
      const target = path.join(Global.Path.data, `task-isolation-target-${plain.id}`)
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          await fs.rename(link, aside).catch(() => undefined)
          await fs.mkdir(target, { recursive: true })
          await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir")
        }),
        () =>
          Effect.promise(async () => {
            // unlink drops only the link, where Bun's rm fails on a link to a folder on Windows. A link left behind
            // would refuse every later isolation test in this process.
            await fs.unlink(link).catch((cause) => {
              if (cause?.code !== "ENOENT") throw cause
            })
            await fs.rm(target, { recursive: true, force: true })
            await fs.rename(aside, link).catch(() => undefined)
          }),
      )
      expect(yield* isolation.find(plain.id)).toBeUndefined()
      expect(yield* isolation.records()).toEqual([])
      const response = yield* requestInDirectory(`/session/${plain.id}/revert`, home.directory, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ messageID: MessageID.ascending() }),
      })
      expect(response.status).toBe(200)
      // An entry that exists is still read under the full guard, and its linked ancestor is refused.
      yield* Effect.promise(() => fs.mkdir(path.join(target, home.project.id, plain.id), { recursive: true }))
      expect(yield* isolation.find(plain.id).pipe(Effect.flip)).toMatchObject({ code: "registry" })
    }),
  options,
)
