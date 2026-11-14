import { afterEach, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ConfigProvider, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { Flag } from "@vectordevai/core/flag/flag"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { Npm } from "@vectordevai/core/npm"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import { Auth } from "@/auth"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { ServerAuth } from "@/server/auth"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionRunState } from "@/session/run-state"
import { TaskClaims } from "@/task/claims"
import { TaskIsolation } from "@/task/isolation"
import { TaskPlace } from "@/task/place"
import { Worktree } from "@/worktree"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Routes 4–6 (§4.9) through the production HttpApi stack, so compression, CORS and the final response gate all run.
// Owner requests carry no credentials (no server password is configured); a forwarded guest is the owner's
// credentials with the relay marker, which the stack must treat as a guest.
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
const relay = { "x-vector-guest-request": "1", "content-type": "application/json" }
const json = { "content-type": "application/json" }

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const git = Effect.fn("TaskIsolationRouteTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.text().trim()
})
const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })

// The committed shared.txt each isolated child below changes.
const base = Effect.gen(function* () {
  const home = yield* InstanceState.context
  yield* write(path.join(home.directory, "shared.txt"), "base\n")
  yield* git(home.directory, ["add", "shared.txt"])
  yield* git(home.directory, ["commit", "-m", "base"])
})

// One isolated child of the parent, whose worktree changed shared.txt. The child's stored title is hostile.
const isolate = Effect.fn("TaskIsolationRouteTest.isolate")(function* (parent: Session.Info) {
  const home = yield* InstanceState.context
  const sessions = yield* Session.Service
  const isolation = yield* TaskIsolation.Service
  const agents = yield* Agent.Service
  const child = yield* sessions.create({
    parentID: parent.id,
    title: "/private/hostile-stored-title",
    metadata: {
      [SubagentLifecycle.METADATA_KEY]: {
        kind: "subagent",
        custom: false,
        agent: "general",
        title: "/private/hostile-stored-title",
        parentSessionID: parent.id,
        parentMessageID: MessageID.ascending(),
        model: { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("fixture") },
        background: true,
        status: "completed",
        startedAt: 1,
        runtimeID: SubagentLifecycle.RUNTIME_ID,
        attempt: 1,
      },
    },
  })
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
      TaskPlace.drop(child.id)
      TaskPlace.drop(parent.id)
    }).pipe(Effect.orDie),
  )
  yield* isolation.fence(parent.id)
  yield* isolation.reserve({ taskID: child.id, parentSessionID: parent.id, title: "Route fixture", agent })
  yield* isolation.start(child.id)
  yield* write(path.join(workPath, "shared.txt"), "child change\n")
  return { home, isolation, parent, child, workPath }
})

const isolated = Effect.gen(function* () {
  const sessions = yield* Session.Service
  yield* base
  return yield* isolate(yield* sessions.create({ title: "Isolation route parent" }))
})

// The exact counts projection: whitelisted identity, status and counts, nothing a stored record could carry.
const projection = (f: { parent: { id: string }; child: { id: string } }) => ({
  task: {
    id: f.child.id,
    sessionID: f.child.id,
    parentSessionID: f.parent.id,
    source: "subagent",
    title: "Isolated task",
    status: "completed",
    startedAt: 0,
    elapsedMs: 0,
    ownedPaths: [],
    dependsOn: [],
    resultAvailable: false,
    attempt: 0,
    controls: { inspect: false, message: false, stop: false },
    isolation: { mode: "worktree", state: "changed", files: 1, additions: 1, deletions: 1 },
  },
  files: [],
  truncated: false,
  mergeable: "unknown",
})

const changes = (f: { parent: { id: string }; child: { id: string }; home: { directory: string } }, headers = {}) =>
  requestInDirectory(`/experimental/session/${f.parent.id}/tasks/${f.child.id}/changes?diff=true`, f.home.directory, {
    headers,
  })
const post = (f: { home: { directory: string } }, route: string, body: unknown, headers: Record<string, string>) =>
  requestInDirectory(route, f.home.directory, { method: "POST", headers, body: JSON.stringify(body) })

it.instance(
  "changes give the owner the patch and directory, and a forwarded guest only the exact counts",
  () =>
    Effect.gen(function* () {
      const f = yield* isolated
      expect((yield* f.isolation.settle({ taskID: f.child.id, attempt: 1 })).state).toBe("changed")

      const owner = yield* changes(f)
      expect(owner.status).toBe(200)
      const full = (yield* owner.json) as {
        files: { path: string }[]
        patch?: string
        task: { isolation?: { directory?: string; state: string } }
      }
      expect(full.files.map((file) => file.path)).toEqual(["shared.txt"])
      expect(full.patch).toContain("child change")
      expect(full.task.isolation).toMatchObject({ state: "changed", directory: f.workPath })

      // Owner credentials relaying a guest are a guest: diff=true still yields counts only, built without Git.
      const relayed = yield* changes(f, relay)
      expect(relayed.status).toBe(200)
      const text = yield* relayed.text
      expect(JSON.parse(text)).toEqual(projection(f))
      for (const secret of [f.workPath, "hostile-stored-title", "shared.txt", "child change", "vector/subagent"])
        expect(text).not.toContain(secret)

      // The raw task routes stay owner-only for this family.
      expect(
        (yield* requestInDirectory(`/experimental/session/${f.parent.id}/tasks/${f.child.id}`, f.home.directory, {
          headers: relay,
        })).status,
      ).toBe(403)
      // Merge and discard are the authenticated owner's alone.
      for (const action of ["merge", "discard"]) {
        const refused = yield* post(f, `/experimental/session/${f.parent.id}/tasks/${f.child.id}/${action}`, {}, relay)
        expect(refused.status).toBe(403)
      }
      expect((yield* f.isolation.get(f.child.id)).state).toBe("changed")
    }),
  options,
)

it.instance(
  "the owner's merge and discard report running and conflict, and a discard reason stays private",
  () =>
    Effect.gen(function* () {
      const f = yield* isolated
      const merge = `/experimental/session/${f.parent.id}/tasks/${f.child.id}/merge`
      // Saving in progress: merge is refused with code running and nothing is written. No body merges everything, as
      // the SDK sends it with no option; the request still reaches the task manager.
      expect((yield* f.isolation.markSettling(f.child.id, 1))?.state).toBe("settling")
      const running = yield* requestInDirectory(merge, f.home.directory, { method: "POST", headers: json })
      expect(running.status).toBe(400)
      expect(yield* running.json).toMatchObject({ code: "running" })
      expect((yield* f.isolation.settle({ taskID: f.child.id, attempt: 1 })).state).toBe("changed")

      // The parent changed the same line meanwhile: the merge is refused with code conflict and the file is kept.
      yield* write(path.join(f.home.directory, "shared.txt"), "parent change\n")
      const conflict = yield* post(f, merge, {}, json)
      expect(conflict.status).toBe(400)
      expect(yield* conflict.json).toMatchObject({ code: "conflict" })
      expect(yield* Effect.promise(() => fs.readFile(path.join(f.home.directory, "shared.txt"), "utf8"))).toBe(
        "parent change\n",
      )

      // The owner may discard; the reason stays on the private record.
      const discarded = yield* post(
        f,
        `/experimental/session/${f.parent.id}/tasks/${f.child.id}/discard`,
        { reason: "Superseded" },
        json,
      )
      expect(discarded.status).toBe(200)
      expect(((yield* discarded.json) as { task: { isolation?: { state: string } } }).task.isolation?.state).toBe(
        "discarded",
      )
      expect((yield* f.isolation.get(f.child.id)).discardReason).toBe("Superseded")
    }),
  options,
)

it.instance(
  "a task launched by another session is neither shown nor changed through this one",
  () =>
    Effect.gen(function* () {
      const f = yield* isolated
      const other = yield* InstanceState.context
      const sessions = yield* Session.Service
      const stranger = yield* sessions.create({ title: "Unrelated root" })
      // The task belongs to another parent: the route never reveals or changes it through this session.
      const response = yield* requestInDirectory(
        `/experimental/session/${stranger.id}/tasks/${f.child.id}/changes`,
        other.directory,
      )
      expect(response.status).toBe(400)
      expect(yield* response.json).toMatchObject({ code: "forbidden" })
      // Merge and discard without a body reach the task manager, which refuses them for this session.
      for (const action of ["merge", "discard"]) {
        const refused = yield* requestInDirectory(
          `/experimental/session/${stranger.id}/tasks/${f.child.id}/${action}`,
          f.home.directory,
          { method: "POST", headers: json },
        )
        expect(refused.status).toBe(400)
        expect(yield* refused.json).toMatchObject({ code: "forbidden" })
      }
      expect((yield* f.isolation.get(f.child.id)).state).toBe("running")
    }),
  options,
)

// Real guest credentials through the same production stack (route 4). The stack reads credentials and claims when it
// is built, so this case builds it once the directory its guest workspace claim names exists.
const claimedParentID = SessionV2.ID.create()
const guestWorkspace = WorkspaceV2.ID.make("wrk_task_isolation_guest")
const basic = (username: string, password: string) => ({
  authorization: ServerAuth.header({ username, password }) ?? "",
  ...json,
})
const guestStack = (directory: string) =>
  Layer.mergeAll(services, httpApiLayer).pipe(
    Layer.provide(
      ConfigProvider.layerAdd(
        ConfigProvider.fromUnknown({
          VECTOR_SERVER_USERNAME: "vector",
          VECTOR_SERVER_PASSWORD: "owner-secret",
          VECTOR_SERVER_GUEST_USERNAME: "guest",
          VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
          VECTOR_SERVER_GUEST_SESSIONS: claimedParentID,
          VECTOR_SERVER_GUEST_WORKSPACES: guestWorkspace,
          VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ [guestWorkspace]: directory }),
        }),
        { asPrimary: true },
      ),
    ),
  )
const guestIt = testEffect(Layer.empty)

guestIt.instance(
  "a guest whose session claim or workspace directory covers a fenced family gets only the counts; outside it, 403",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const owner = basic("vector", "owner-secret")
        const guest = basic("guest", "guest-secret")
        yield* base
        // A conversation the guest is invited to by its session ID, and one it reaches only through its workspace's
        // directory. Each fenced family has an isolated child with saved changes.
        const created = yield* requestInDirectory("/api/session", directory, {
          method: "POST",
          headers: owner,
          body: JSON.stringify({ id: claimedParentID, location: { directory } }),
        })
        expect(created.status).toBe(200)
        const claimed = yield* isolate(yield* sessions.get(SessionID.make(claimedParentID)))
        const workspace = yield* isolate(
          yield* sessions.create({ title: "Workspace parent", workspaceID: guestWorkspace }),
        )
        expect(claimed.parent.workspaceID).toBeUndefined()
        expect(workspace.parent.directory).toBe(directory)
        for (const f of [claimed, workspace])
          expect((yield* f.isolation.settle({ taskID: f.child.id, attempt: 1 })).state).toBe("changed")
        // This engine serves the guest's workspace, so that workspace's sessions are local.
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = Flag.VECTOR_WORKSPACE_ID
            Flag.VECTOR_WORKSPACE_ID = guestWorkspace
            return previous
          }),
          (previous) =>
            Effect.sync(() => {
              Flag.VECTOR_WORKSPACE_ID = previous
            }),
        )

        for (const f of [claimed, workspace]) {
          // The scoped guest asks for the patch and gets the exact counts, built from the registry alone.
          const response = yield* changes(f, guest)
          expect(response.status).toBe(200)
          const text = yield* response.text
          expect(JSON.parse(text)).toEqual(projection(f))
          for (const secret of [f.workPath, "hostile-stored-title", "shared.txt", "child change", "vector/subagent"])
            expect(text).not.toContain(secret)
          // The authenticated owner still gets the full patch.
          const full = yield* changes(f, owner)
          expect(full.status).toBe(200)
          expect(((yield* full.json) as { patch?: string }).patch).toContain("child change")
          // Neither a merge nor a discard is the guest's.
          for (const action of ["merge", "discard"])
            expect(
              (yield* requestInDirectory(
                `/experimental/session/${f.parent.id}/tasks/${f.child.id}/${action}`,
                directory,
                {
                  method: "POST",
                  headers: guest,
                },
              )).status,
            ).toBe(403)
        }

        // Outside its scope: a member of the invited family the guest holds no claim to, through its own route.
        const outside = yield* requestInDirectory(
          `/experimental/session/${claimed.child.id}/tasks/${claimed.child.id}/changes?diff=true`,
          directory,
          { headers: guest },
        )
        expect(outside.status).toBe(403)
        expect(yield* outside.text).not.toContain(claimed.workPath)
        for (const f of [claimed, workspace]) expect((yield* f.isolation.get(f.child.id)).state).toBe("changed")
      }).pipe(Effect.provide(guestStack(directory)))
    }),
  options,
)
