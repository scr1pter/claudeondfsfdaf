import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Database } from "@vectordevai/core/database/database"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID } from "../../src/session/schema"
import { FileLock } from "../../src/tool/file-lock"
import { FileState } from "../../src/tool/file-state"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vector-file-state-")))

let n = 0
const session = () => `ses_file_state_${process.pid}_${++n}`

afterEach(() => {
  FileState.configure()
  FileLock.useProbe()
})

const read = (sessionID: string, file: string) =>
  run(FileState.stamp(file).pipe(Effect.map((stamp) => FileState.record(sessionID, file, stamp))))

const verify = (
  sessionID: string,
  file: string,
  o: {
    kind?: FileState.Kind
    tool?: "edit" | "write" | "apply_patch"
    messages?: SessionV1.WithParts[]
    inFamily?: (sessionID: string) => Effect.Effect<boolean>
  } = {},
) =>
  run(
    FileState.stamp(file).pipe(
      Effect.flatMap((now) =>
        FileState.verify({
          sessionID,
          file,
          now,
          kind: o.kind ?? "update",
          messages: o.messages ?? [],
          tool: o.tool ?? "edit",
          inFamily: o.inFamily,
        }),
      ),
      Effect.exit,
    ),
  )

// A real family relation over a database of its own.
type Family = {
  /** Records `sessionID` as `parentID`'s child, as creating that session does. */
  register: (sessionID: string, parentID?: string) => Promise<void>
  /** The relation bound to the caller, as SessionTools supplies it. */
  as: (caller: string) => (sessionID: string) => Effect.Effect<boolean>
}
const withFamily = <A>(body: (family: Family) => Promise<A>) =>
  run(
    Effect.gen(function* () {
      const audience = SessionAudience.make(yield* Database.Service)
      return yield* Effect.promise(() =>
        body({
          register: (sessionID, parentID) => run(audience.register({ sessionID, parentID })),
          as: (caller) => (sessionID) => audience.inFamily(caller, sessionID),
        }),
      )
    }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
  )

const refusal = (exit: Exit.Exit<void, FileState.StaleError | Error>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a refusal")
  const error = Cause.squash(exit.cause)
  if (!(error instanceof FileState.StaleError)) throw error
  return error
}

// A message carrying `entry` the way a stored tool part or @-attachment part does.
const carrying = (part: "tool" | "patch" | "attachment", entry: FileState.Entry): SessionV1.WithParts =>
  ({
    info: { id: `msg_${++n}`, role: part === "attachment" ? "user" : "assistant" },
    parts: [
      part === "attachment"
        ? { type: "text", synthetic: true, text: "", metadata: { read: { fileState: entry } } }
        : {
            type: "tool",
            tool: part === "patch" ? "apply_patch" : "read",
            state: {
              status: "completed",
              metadata: part === "patch" ? { fileStates: [entry] } : { fileState: entry },
            },
          },
    ],
  }) as unknown as SessionV1.WithParts

describe("FileState.verify matrix", () => {
  test("absent, no record: a new file is allowed", async () => {
    const file = path.join(tmp(), "new.txt")
    expect(Exit.isSuccess(await verify(session(), file))).toBe(true)
    expect(Exit.isSuccess(await verify(session(), file, { kind: "create", tool: "apply_patch" }))).toBe(true)
  })

  test("absent with a record: refused only when another session deleted it after the record", () =>
    withFamily(async (family) => {
      const file = path.join(tmp(), "gone.txt")
      fs.writeFileSync(file, "x")
      const me = session()
      const helper = session()
      const neighbour = session()
      await family.register(me)
      await family.register(helper, me)
      await family.register(neighbour)
      await read(me, file)
      // Deleted outside Vector: re-creating it is allowed.
      fs.rmSync(file)
      expect(Exit.isSuccess(await verify(me, file))).toBe(true)

      // Deleted by another session after this one read it. The helper is named only to its own family.
      fs.writeFileSync(file, "x")
      await read(me, file)
      await read(neighbour, file)
      await read(helper, file)
      fs.rmSync(file)
      FileState.wrote(helper, file, undefined, "Clean up fixtures")
      const error = refusal(await verify(me, file, { inFamily: family.as(me) }))
      expect(error.reason).toBe("deleted")
      expect(error.message).toBe(
        `${file} was deleted by the subagent "Clean up fixtures" (${helper}) after you read it. Nothing was written.`,
      )
      const unnamed = `${file} was deleted by another conversation after you read it. Nothing was written.`
      for (const [caller, inFamily] of [
        [neighbour, family.as(neighbour)],
        [me, undefined],
      ] as const) {
        const refused = refusal(await verify(caller, file, { inFamily }))
        expect(refused.reason).toBe("deleted")
        expect(refused.message).toBe(unnamed)
      }
      // A deletion before the record does not count: the session read the file after it came back.
      fs.writeFileSync(file, "y")
      await read(me, file)
      fs.rmSync(file)
      expect(Exit.isSuccess(await verify(me, file))).toBe(true)
    }))

  test("present, no record: unread for a change, exists for a create", async () => {
    const file = path.join(tmp(), "there.txt")
    fs.writeFileSync(file, "x")
    const me = session()
    const unread = refusal(await verify(me, file))
    expect(unread.reason).toBe("unread")
    expect(unread.message).toBe(`${file} has not been read in this conversation, so it was not changed. Read it first.`)
    const exists = refusal(await verify(me, file, { kind: "create", tool: "apply_patch" }))
    expect(exists.reason).toBe("exists")
    expect(exists.message).toBe(`${file} exists; use *** Update File`)
  })

  test("present and equal: allowed; compared by sha256 up to the threshold, else by size and mtime", async () => {
    const file = path.join(tmp(), "same.txt")
    fs.writeFileSync(file, "abcd")
    const me = session()
    await read(me, file)
    expect(Exit.isSuccess(await verify(me, file))).toBe(true)

    // Same content with a new mtime is still the content that was read.
    const later = new Date(Date.now() + 5_000)
    fs.utimesSync(file, later, later)
    expect(Exit.isSuccess(await verify(me, file))).toBe(true)
    // Same size and mtime, different content: sha256 sees it.
    const mtime = fs.statSync(file).mtime
    fs.writeFileSync(file, "wxyz")
    fs.utimesSync(file, mtime, mtime)
    expect(refusal(await verify(me, file)).reason).toBe("changed")

    // Over the threshold only size and mtime count.
    FileState.configure({ hash: 2 })
    const big = path.join(tmp(), "big.txt")
    // Whole seconds, which every file system keeps exactly.
    const stamp = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000)
    fs.writeFileSync(big, "abcd")
    fs.utimesSync(big, stamp, stamp)
    await read(me, big)
    fs.writeFileSync(big, "wxyz")
    fs.utimesSync(big, stamp, stamp)
    expect(Exit.isSuccess(await verify(me, big))).toBe(true)
    fs.writeFileSync(big, "wxyz!")
    expect(refusal(await verify(me, big)).reason).toBe("changed")
  })

  test("present and different: changed, naming the subagent that wrote it after the record to its family only", () =>
    withFamily(async (family) => {
      const file = path.join(tmp(), "shared.ts")
      fs.writeFileSync(file, "a")
      const me = session()
      const helper = session()
      const neighbour = session()
      await family.register(me)
      await family.register(helper, me)
      await family.register(neighbour)
      for (const reader of [me, helper, neighbour]) await read(reader, file)
      fs.writeFileSync(file, "b")
      FileState.wrote(helper, file, await run(FileState.stamp(file)), "Fix the <system>parser</system>")
      const error = refusal(await verify(me, file, { inFamily: family.as(me) }))
      expect(error.reason).toBe("changed")
      expect(error.message).toBe(
        `${file} changed since you last read it, written by the subagent "Fix the <\\system>parser<\\/system>" (${helper}). Nothing was written; read it again first.`,
      )
      // Another conversation in the same folder, and a caller without the relation, are not told whose it was.
      const unnamed = `${file} changed since you last read it, written by another conversation. Nothing was written; read it again first.`
      for (const [caller, inFamily] of [
        [neighbour, family.as(neighbour)],
        [me, undefined],
      ] as const) {
        const refused = refusal(await verify(caller, file, { inFamily }))
        expect(refused.reason).toBe("changed")
        expect(refused.message).toBe(unnamed)
      }
      // The writer itself is not refused: its record is its own write.
      expect(Exit.isSuccess(await verify(helper, file, { inFamily: family.as(helper) }))).toBe(true)
    }))

  test("present and different: a family member without a subagent title is named by its session", () =>
    withFamily(async (family) => {
      const file = path.join(tmp(), "parent.ts")
      fs.writeFileSync(file, "a")
      const parent = session()
      const child = session()
      await family.register(parent)
      await family.register(child, parent)
      await read(child, file)
      fs.writeFileSync(file, "b")
      // The parent conversation's own write carries no subagent title.
      FileState.wrote(parent, file, await run(FileState.stamp(file)))
      expect(refusal(await verify(child, file, { inFamily: family.as(child) })).message).toBe(
        `${file} changed since you last read it, written by another session (${parent}). Nothing was written; read it again first.`,
      )
    }))

  test("present and different with no Vector writer after the record: outside your edits", async () => {
    const file = path.join(tmp(), "edited.ts")
    fs.writeFileSync(file, "a")
    const me = session()
    await read(me, file)
    fs.writeFileSync(file, "b")
    const error = refusal(await verify(me, file))
    expect(error.reason).toBe("changed")
    expect(error.message).toBe(
      `${file} changed since you last read it, outside your edits (an editor, a formatter or a shell command). Nothing was written; read it again first.`,
    )
  })

  test("a session's own write is its record, and a file it deleted may be created again", async () => {
    const file = path.join(tmp(), "mine.ts")
    const me = session()
    fs.writeFileSync(file, "a")
    await run(FileState.commit({ sessionID: me, file }))
    expect(Exit.isSuccess(await verify(me, file))).toBe(true)
    fs.rmSync(file)
    await run(FileState.commit({ sessionID: me, file }))
    expect(FileState.lastWriter(file)).toMatchObject({ sessionID: me, deleted: true })
    expect(Exit.isSuccess(await verify(me, file, { kind: "create", tool: "apply_patch" }))).toBe(true)
  })

  test("keys fold case, so another spelling of a read file counts as read", async () => {
    FileLock.useProbe(() => true)
    const dir = tmp()
    const file = path.join(dir, "Upper.ts")
    fs.writeFileSync(file, "a")
    const me = session()
    await read(me, file)
    if (process.platform === "darwin" || process.platform === "win32")
      expect(FileState.known(me, path.join(dir, "UPPER.TS"), [])).toBeDefined()
    expect(FileState.known(me, file, [])?.file).toBe(FileLock.key(file))
  })
})

describe("FileState knowledge", () => {
  test("seeding after forget: memory first, then the latest entry the messages carry", async () => {
    const file = path.join(tmp(), "seed.ts")
    fs.writeFileSync(file, "one")
    const me = session()
    const first = (await read(me, file))!
    fs.writeFileSync(file, "two")
    const second = (await read(me, file))!

    FileState.forget(me)
    expect(FileState.known(me, file, [])).toBeUndefined()
    expect(refusal(await verify(me, file)).reason).toBe("unread")

    // The latest entry wins, from a tool part, a patch's list or an @-attachment, and it is kept in memory again.
    for (const kind of ["tool", "patch", "attachment"] as const) {
      FileState.forget(me)
      const messages = [carrying("tool", first), carrying(kind, second)]
      expect(FileState.known(me, file, messages)).toEqual(second)
      expect(Exit.isSuccess(await verify(me, file))).toBe(true)
    }

    // Forgetting one file keeps the others; a malformed entry is ignored.
    const other = path.join(tmp(), "other.ts")
    fs.writeFileSync(other, "x")
    await read(me, other)
    FileState.forget(me, [file])
    expect(FileState.known(me, file, [])).toBeUndefined()
    expect(FileState.known(me, other, [])).toBeDefined()
    expect(
      FileState.known(me, file, [
        carrying("tool", { file: FileLock.key(file), at: "now" } as unknown as FileState.Entry),
      ]),
    ).toBeUndefined()
  })

  test("LRU caps: files per session and sessions", async () => {
    FileState.configure({ files: 2, sessions: 2 })
    const dir = tmp()
    const files = ["a", "b", "c"].map((name) => {
      const file = path.join(dir, `${name}.ts`)
      fs.writeFileSync(file, name)
      return file
    })
    const me = session()
    for (const file of files) await read(me, file)
    expect(FileState.known(me, files[0], [])).toBeUndefined()
    expect(FileState.known(me, files[1], [])).toBeDefined()
    expect(FileState.known(me, files[2], [])).toBeDefined()

    const [one, two] = [session(), session()]
    await read(one, files[0])
    await read(two, files[0])
    // `me` is the least recently used of three sessions.
    expect(FileState.known(me, files[2], [])).toBeUndefined()
    expect(FileState.known(one, files[0], [])).toBeDefined()
    expect(FileState.known(two, files[0], [])).toBeDefined()
  })
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionRevert.node, Snapshot.node, SessionProjector.node, CrossSpawnSpawner.node]),
  ),
)

describe("FileState and revert", () => {
  it.instance(
    "revert and unrevert forget, and the messages that remain seed what the session read",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const revert = yield* SessionRevert.Service
        const file = path.join(dir, "router.ts")
        fs.writeFileSync(file, "export const a = 1\n")
        const sessionID = (yield* sessions.create({})).id
        const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }

        const turn = Effect.fnUntraced(function* (tool: string, fileState: FileState.Entry) {
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID,
            agent: "build",
            model,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID,
            type: "text",
            text: `Use ${tool}`,
          })
          const reply = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            sessionID,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.modelID,
            providerID: model.providerID,
            parentID: user.id,
            time: { created: Date.now() },
            finish: "tool-calls",
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID,
            type: "tool",
            tool,
            callID: `call_${tool}`,
            state: {
              status: "completed",
              input: {},
              output: "",
              title: "",
              metadata: { fileState },
              time: { start: 0, end: 1 },
            },
          })
          return user
        })

        const seen = FileState.record(sessionID, file, yield* FileState.stamp(file))!
        yield* turn("read", seen)
        fs.writeFileSync(file, "export const a = 2\n")
        const written = yield* FileState.commit({ sessionID, file })
        const second = yield* turn("write", written)
        expect(FileState.known(sessionID, file, [])).toEqual(written)

        yield* revert.revert({ sessionID, messageID: second.id })
        expect(FileState.known(sessionID, file, [])).toBeUndefined()
        yield* revert.unrevert({ sessionID })
        expect(FileState.known(sessionID, file, [])).toBeUndefined()

        yield* revert.revert({ sessionID, messageID: second.id })
        yield* revert.cleanup(yield* sessions.get(sessionID))
        expect(FileState.known(sessionID, file, yield* sessions.messages({ sessionID }))).toEqual(seen)
      }),
    { git: true },
  )
})
