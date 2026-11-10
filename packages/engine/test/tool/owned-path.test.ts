import { describe, expect } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect, Exit } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { InstanceState } from "@/effect/instance-state"
import { TaskClaims } from "@/task/claims"
import { FileLock } from "@/tool/file-lock"
import { FileState } from "@/tool/file-state"
import { assertWritable, assertOwnedPath } from "@/tool/owned-path"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))
const context: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  agent: "general",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  ownedPaths: ["src/owned"],
}
// A caller with the family relation SessionTools binds to it, over the case's own database.
const caller = (audience: SessionAudience.Interface, sessionID: string, parentID?: string): Tool.Context => ({
  ...context,
  sessionID: SessionID.make(sessionID),
  ...(parentID ? { parentID: SessionID.make(parentID) } : {}),
  ownedPaths: undefined,
  inFamily: (id) => audience.inFamily(sessionID, id),
})
const refusal = <E>(exit: Exit.Exit<void, E>) => String(Exit.isFailure(exit) && exit.cause)

describe("owned file mutation boundary", () => {
  it.instance("allows assigned descendants and rejects prefix lookalikes and traversal", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* assertOwnedPath(context, path.join(instance.directory, "src/owned/new.ts"))
      for (const target of ["src/owned-other/new.ts", "src/owned/../other.ts", "../outside.ts"]) {
        expect(
          Exit.isFailure(yield* assertOwnedPath(context, path.resolve(instance.directory, target)).pipe(Effect.exit)),
        ).toBe(true)
      }
    }),
  )

  it.instance("refreshes trusted ownership after an explicit parent assignment update", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const refreshed = { ...context, getOwnedPaths: () => Effect.succeed(["src/owned", "src/added"]) }
      yield* assertOwnedPath(refreshed, path.join(instance.directory, "src/added/new.ts"))
      expect(
        Exit.isFailure(
          yield* assertOwnedPath(refreshed, path.join(instance.directory, "src/other/new.ts")).pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )

  it.instance("resolves symlink ancestors before enforcing ownership", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const external = yield* tmpdirScoped()
      yield* Effect.promise(() => fs.mkdir(path.join(instance.directory, "src/owned"), { recursive: true }))
      yield* Effect.promise(() => fs.symlink(external, path.join(instance.directory, "src/owned/escape")))
      expect(
        Exit.isFailure(
          yield* assertOwnedPath(context, path.join(instance.directory, "src/owned/escape/new.ts")).pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* assertOwnedPath({ ...context, ownedPaths: undefined }, path.join(instance.directory, "unassigned.ts"))
    }),
  )
})

describe("write ownership chokepoint", () => {
  it.instance("refuses a parent's write with the exact owned-path text and permits the child's helper", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const audience = SessionAudience.make(yield* Database.Service)
      for (const [sessionID, parentID] of [
        ["ses_root", undefined],
        ["ses_owner", "ses_root"],
        ["ses_helper", "ses_owner"],
        ["ses_neighbour", undefined],
      ] as const)
        yield* audience.register({ sessionID, parentID })
      const file = path.join(instance.directory, "src/owned/new.ts")
      const owner = TaskClaims.reserve({
        tree: instance.worktree,
        directory: instance.directory,
        parentSessionID: "ses_root",
        taskID: "ses_owner",
        title: "Owner",
        paths: ["src/owned"],
      })
      const child = TaskClaims.reserve({
        tree: instance.worktree,
        directory: instance.directory,
        parentSessionID: "ses_owner",
        taskID: "ses_helper",
        title: "Helper",
        paths: [],
      })
      TaskClaims.bind(owner, "ses_owner")
      TaskClaims.bind(child, "ses_helper")
      const parent = caller(audience, "ses_root")
      const refused = yield* assertWritable(parent, { files: [file] }).pipe(Effect.exit)
      expect(refusal(refused)).toContain(
        `${file} belongs to the running subagent "Owner" (ses_owner), which owns src/owned. It was not changed. Wait for its report, send it the change with task_manage message, or stop it first.`,
      )
      // Another conversation in the same folder is refused too, without the subagent's title, session or owned path.
      const neighbour = refusal(
        yield* assertWritable(caller(audience, "ses_neighbour"), { files: [file] }).pipe(Effect.exit),
      )
      expect(neighbour).toContain(
        `${file} belongs to another conversation's running subagent. It was not changed. Wait for it to finish.`,
      )
      for (const hidden of ['"Owner"', "ses_owner", "ses_root", "which owns"]) expect(neighbour).not.toContain(hidden)
      yield* assertWritable(caller(audience, "ses_helper", "ses_owner"), { files: [file] })
      TaskClaims.release(child)
      TaskClaims.release(owner)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
  )

  it.instance("refuses a sibling's changed file until its owner settles", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const audience = SessionAudience.make(yield* Database.Service)
      for (const [sessionID, parentID] of [
        ["ses_root", undefined],
        ["ses_owner", "ses_root"],
        ["ses_sibling", "ses_root"],
      ] as const)
        yield* audience.register({ sessionID, parentID })
      const file = path.join(instance.directory, "changed.ts")
      const claim = TaskClaims.reserve({
        tree: instance.worktree,
        directory: instance.directory,
        parentSessionID: "ses_root",
        taskID: "ses_owner",
        title: "Owner",
        paths: [],
      })
      TaskClaims.bind(claim, "ses_owner")
      FileState.wrote("ses_owner", file, undefined)
      const sibling = caller(audience, "ses_sibling", "ses_root")
      const refused = yield* assertWritable(sibling, { files: [file] }).pipe(Effect.exit)
      expect(refusal(refused)).toContain(
        `${file} was changed by the running subagent "Owner" (ses_owner) and stays its file until it finishes. It was not changed. Report the change you need to the parent.`,
      )
      // Without the family relation the refusal holds and names no one; a helper still reports to its parent.
      const unnamed = refusal(
        yield* assertWritable({ ...sibling, inFamily: undefined }, { files: [file] }).pipe(Effect.exit),
      )
      expect(unnamed).toContain(
        `${file} was changed by another conversation's running subagent and stays its file until it finishes. It was not changed. Report the change you need to the parent.`,
      )
      expect(unnamed).not.toContain("ses_owner")
      TaskClaims.release(claim)
      yield* assertWritable(sibling, { files: [file] })
    }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
  )

  it.instance("a protected task tree is named only to the task's own family", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const audience = SessionAudience.make(yield* Database.Service)
      yield* audience.register({ sessionID: "ses_root" })
      yield* audience.register({ sessionID: "ses_kept", parentID: "ses_root" })
      yield* audience.register({ sessionID: "ses_neighbour" })
      const directory = path.join(instance.directory, "kept")
      yield* Effect.acquireRelease(
        Effect.sync(() => TaskClaims.protect({ taskID: "ses_kept", directories: [directory] })),
        () => Effect.sync(() => TaskClaims.unprotect("ses_kept")),
      )
      const file = path.join(directory, "new.ts")
      expect(
        refusal(yield* assertWritable(caller(audience, "ses_root"), { files: [file] }).pipe(Effect.exit)),
      ).toContain(`${file} is protected for subagent ses_kept. It was not changed.`)
      const neighbour = refusal(
        yield* assertWritable(caller(audience, "ses_neighbour"), { files: [file] }).pipe(Effect.exit),
      )
      expect(neighbour).toContain(`${file} is protected for another conversation's subagent. It was not changed.`)
      expect(neighbour).not.toContain("ses_kept")
    }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
  )

  it.instance("two unscoped writers recheck ownership inside the same file lock", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const file = path.join(instance.directory, "race.ts")
      const claims = ["ses_first", "ses_second"].map((taskID) =>
        TaskClaims.reserve({
          tree: instance.worktree,
          directory: instance.directory,
          parentSessionID: "ses_root",
          taskID,
          title: taskID,
          paths: [],
        }),
      )
      claims.forEach((claim) => TaskClaims.bind(claim, claim.taskID!))
      const contexts = claims.map((claim) => ({
        ...context,
        sessionID: SessionID.make(claim.taskID!),
        parentID: SessionID.make("ses_root"),
        ownedPaths: undefined,
      }))
      // Both passed before either changed the file: the second check must run inside the lock.
      for (const writer of contexts) yield* assertWritable(writer, { files: [file] })
      const writes: string[] = []
      const exits = yield* Effect.forEach(
        contexts,
        (writer) =>
          FileLock.withFiles([file])(
            Effect.gen(function* () {
              yield* assertWritable(writer, { files: [file] })
              yield* Effect.promise(() => fs.writeFile(file, writer.sessionID))
              yield* FileState.commit({ sessionID: writer.sessionID, file })
              writes.push(writer.sessionID)
            }),
          ).pipe(Effect.exit),
        { concurrency: 2 },
      )
      expect(writes).toHaveLength(1)
      expect(exits.filter(Exit.isFailure)).toHaveLength(1)
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(writes[0])
      claims.forEach(TaskClaims.release)
    }),
  )
})
