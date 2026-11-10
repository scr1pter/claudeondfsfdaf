import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EditTool } from "../../src/tool/edit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Format } from "../../src/format"
import { Instruction } from "../../src/session/instruction"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import { Watcher } from "@vectordevai/core/filesystem/watcher"
import { FileState } from "../../src/tool/file-state"
import { Database } from "@vectordevai/core/database/database"
import { SessionAudience } from "@vectordevai/core/session/audience"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node, Instruction.node]),
)

const it = testEffect(layer)

const init = Effect.fn("EditToolTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("EditToolTest.fail")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

// Writes the file as it was before the session started; the session has not read it.
const putUnread = Effect.fn("EditToolTest.putUnread")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

// Records that `sessionID` read the file as it is now, as the read tool does.
const seen = Effect.fn("EditToolTest.seen")(function* (p: string, sessionID: string = ctx.sessionID) {
  return FileState.record(sessionID, p, yield* FileState.stamp(p))
})

// The usual fixture: the file exists and the session has read it.
const put = Effect.fn("EditToolTest.put")(function* (p: string, content: string) {
  yield* putUnread(p, content)
  yield* seen(p)
})

const load = Effect.fn("EditToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("EditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

const makeDirectory = Effect.fn("EditToolTest.makeDirectory")(function* (p: string) {
  const fs = yield* FSUtil.Service
  yield* fs.makeDirectory(p)
})

const onceBus = Effect.fn("EditToolTest.onceBus")(function* (def: typeof Watcher.Event.Updated) {
  const events = yield* EventV2Bridge.Service
  const deferred = yield* Deferred.make<void>()
  const unsub = yield* events.listen((event) => {
    if (event.type === def.type) Deferred.doneUnsafe(deferred, Effect.void)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsub)
  return deferred
})

describe("tool.edit", () => {
  describe("creating new files", () => {
    it.instance("creates new file when oldString is empty", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, oldString: "", newString: "new content" })

        expect(result.metadata.diff).toContain("new content")
        expect(yield* load(filepath)).toBe("new content")
      }),
    )

    it.instance("rejects empty oldString on existing files and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        const original = `${bom}using System;\n`
        yield* put(filepath, original)

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "using Up;\n" })).message).toContain(
          "oldString cannot be empty",
        )

        const content = yield* loadRaw(filepath)
        expect(content).toBe(original)
      }),
    )

    it.instance("creates new file with nested directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "dir", "file.txt")

        yield* run({ filePath: filepath, oldString: "", newString: "nested file" })

        expect(yield* load(filepath)).toBe("nested file")
      }),
    )

    it.instance("emits add event for new files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: path.join(test.directory, "new.txt"), oldString: "", newString: "content" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("editing existing files", () => {
    it.instance("replaces text in existing file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "old content here")

        const result = yield* run({ filePath: filepath, oldString: "old content", newString: "new content" })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("replaces the first visible line in BOM files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}using System;\nclass Test {}\n`)

        const result = yield* run({ filePath: filepath, oldString: "using System;", newString: "using Up;" })

        expect(result.metadata.diff).toContain("-using System;")
        expect(result.metadata.diff).toContain("+using Up;")
        expect(result.metadata.diff).not.toContain(bom)

        const content = yield* loadRaw(filepath)
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\nclass Test {}\n")
      }),
    )

    it.instance("throws error when file does not exist", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect(
          (yield* fail({ filePath: path.join(test.directory, "nonexistent.txt"), oldString: "old", newString: "new" }))
            .message,
        ).toContain("not found")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "same", newString: "same" })).message).toContain(
          "identical",
        )
      }),
    )

    it.instance("throws error when oldString not found in file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "actual content")

        expect(yield* fail({ filePath: filepath, oldString: "not in file", newString: "replacement" })).toBeInstanceOf(
          Error,
        )
      }),
    )

    it.instance("rejects loose block-anchor matches and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = [
          "function configure() {",
          "  keepImportantState()",
          "  removeAllUserData()",
          "  archiveBackups()",
          "  auditLog()",
          "}",
        ].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("rejects block-anchor matches with unrelated middle content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = ["function configure() {", "  removeAllUserData()", "}"].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("replaces all occurrences with replaceAll option", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "foo bar foo baz foo")

        yield* run({ filePath: filepath, oldString: "foo", newString: "qux", replaceAll: true })

        expect(yield* load(filepath)).toBe("qux bar qux baz qux")
      }),
    )

    it.instance("emits change event for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "original")
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: filepath, oldString: "original", newString: "modified" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("edge cases", () => {
    it.instance("handles multiline replacements", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        yield* run({ filePath: filepath, oldString: "line2", newString: "new line 2\nextra line" })

        expect(yield* load(filepath)).toBe("line1\nnew line 2\nextra line\nline3")
      }),
    )

    it.instance("handles CRLF line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\r\nold\r\nline3")

        yield* run({ filePath: filepath, oldString: "old", newString: "new" })

        expect(yield* load(filepath)).toBe("line1\r\nnew\r\nline3")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "" })).message).toContain("identical")
      }),
    )

    it.instance("throws error when path is directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dirpath = path.join(test.directory, "adir")
        yield* makeDirectory(dirpath)

        expect((yield* fail({ filePath: dirpath, oldString: "old", newString: "new" })).message).toContain("directory")
      }),
    )

    it.instance("tracks file diff statistics", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        const result = yield* run({ filePath: filepath, oldString: "line2", newString: "new line a\nnew line b" })

        expect(result.metadata.filediff).toBeDefined()
        expect(result.metadata.filediff.file).toBe(filepath)
        expect(result.metadata.filediff.additions).toBeGreaterThan(0)
      }),
    )
  })

  describe("line endings", () => {
    const old = "alpha\nbeta\ngamma"
    const next = "alpha\nbeta-updated\ngamma"
    const alt = "alpha\nbeta\nomega"

    const normalize = (text: string, ending: "\n" | "\r\n") => {
      const normalized = text.replaceAll("\r\n", "\n")
      if (ending === "\n") return normalized
      return normalized.replaceAll("\n", "\r\n")
    }

    const count = (content: string) => {
      const crlf = content.match(/\r\n/g)?.length ?? 0
      const lf = content.match(/\n/g)?.length ?? 0
      return {
        crlf,
        lf: lf - crlf,
      }
    }

    const expectLf = (content: string) => {
      const counts = count(content)
      expect(counts.crlf).toBe(0)
      expect(counts.lf).toBeGreaterThan(0)
    }

    const expectCrlf = (content: string) => {
      const counts = count(content)
      expect(counts.lf).toBe(0)
      expect(counts.crlf).toBeGreaterThan(0)
    }

    type Input = {
      content: string
      oldString: string
      newString: string
      replaceAll?: boolean
    }

    const apply = Effect.fn("EditToolTest.lineEndings.apply")(function* (input: Input) {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "test.txt")
      yield* put(filePath, input.content)
      yield* run({
        filePath,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll,
      })
      return yield* load(filePath)
    })

    it.instance("preserves LF with LF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with CRLF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when old/new use CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when old/new use LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when newString uses CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when newString uses LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: "alpha\nbeta\r\ngamma",
          newString: "alpha\r\nbeta\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: "alpha\r\nbeta\ngamma",
          newString: "alpha\nbeta\r\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("replaceAll preserves LF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\n"),
          newString: normalize(blockNew, "\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("replaceAll preserves CRLF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\r\n"),
          newString: normalize(blockNew, "\r\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )
  })

  describe("concurrent editing", () => {
    it.instance("preserves concurrent edits to different sections of the same file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\nmiddle = keep\nbottom = 0\n")

        const firstAsk = yield* Deferred.make<void>()
        let asks = 0
        const delayedCtx = {
          ...ctx,
          ask: () =>
            Effect.gen(function* () {
              asks++
              if (asks !== 1) return
              yield* Deferred.succeed(firstAsk, undefined)
              yield* Effect.sleep("50 millis")
            }),
        }

        const first = yield* run(
          {
            filePath: filepath,
            oldString: "top = 0",
            newString: "top = 1",
          },
          delayedCtx,
        ).pipe(Effect.forkScoped)

        yield* Deferred.await(firstAsk)
        yield* Effect.all([
          Fiber.join(first),
          run(
            {
              filePath: filepath,
              oldString: "bottom = 0",
              newString: "bottom = 2",
            },
            delayedCtx,
          ),
        ])

        expect(yield* load(filepath)).toBe("top = 1\nmiddle = keep\nbottom = 2\n")
      }),
    )

    it.instance("two parallel edits in one step both land", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "a = 0\nb = 0\nc = 0\n")

        yield* Effect.all(
          [
            run({ filePath: filepath, oldString: "a = 0", newString: "a = 1" }),
            run({ filePath: filepath, oldString: "b = 0", newString: "b = 1" }),
            run({ filePath: filepath, oldString: "c = 0", newString: "c = 1" }),
          ],
          { concurrency: "unbounded" },
        )

        expect(yield* load(filepath)).toBe("a = 1\nb = 1\nc = 1\n")
      }),
    )

    it.instance("a same-session change during the ask is re-applied", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "first = 0\nsecond = 0\n")
        const asking = yield* Deferred.make<void>()
        const answer = yield* Deferred.make<void>()
        const held = {
          ...ctx,
          ask: () => Deferred.succeed(asking, undefined).pipe(Effect.andThen(Deferred.await(answer))),
        }

        const first = yield* run({ filePath: filepath, oldString: "first = 0", newString: "first = 1" }, held).pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(asking)
        yield* run({ filePath: filepath, oldString: "second = 0", newString: "second = 2" })
        yield* Deferred.succeed(answer, undefined)
        const result = yield* Fiber.join(first)

        expect(yield* load(filepath)).toBe("first = 1\nsecond = 2\n")
        // The result shows the edit as applied to the text the other edit left.
        expect(result.metadata.diff).toContain("+first = 1")
        expect(result.metadata.diff).not.toContain("-second = 0")
      }),
    )
  })

  describe("read before write", () => {
    it.instance("edit without a read is refused", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "unread.txt")
        yield* putUnread(filepath, "old content")
        let asked = false

        const exit = yield* run(
          { filePath: filepath, oldString: "old", newString: "new" },
          { ...ctx, ask: () => Effect.sync(() => void (asked = true)) },
        ).pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          message: `${filepath} has not been read in this conversation, so it was not changed. Read it first.`,
        })
        expect(asked).toBe(false)
        expect(yield* load(filepath)).toBe("old content")

        // After a read the same edit goes through.
        yield* seen(filepath)
        yield* run({ filePath: filepath, oldString: "old", newString: "new" })
        expect(yield* load(filepath)).toBe("new content")
      }),
    )

    it.instance("another session writing between read and edit is refused, naming it only to its own family", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // The family relation as SessionTools binds it to the caller, over a database of its own.
        const audience = SessionAudience.make(yield* Database.Service)
        const filepath = path.join(test.directory, "shared.ts")
        yield* put(filepath, "export const value = 1\n")
        const helper = {
          ...ctx,
          sessionID: SessionID.make("ses_test-edit-helper"),
          parentID: ctx.sessionID,
          extra: { subagentTitle: "Bump the value" },
        }
        const neighbour = {
          ...ctx,
          sessionID: SessionID.make("ses_test-edit-neighbour"),
          inFamily: (id: string) => audience.inFamily("ses_test-edit-neighbour", id),
        }
        yield* audience.register({ sessionID: ctx.sessionID })
        yield* audience.register({ sessionID: helper.sessionID, parentID: ctx.sessionID })
        yield* audience.register({ sessionID: neighbour.sessionID })
        yield* seen(filepath, helper.sessionID)
        yield* seen(filepath, neighbour.sessionID)
        yield* run({ filePath: filepath, oldString: "value = 1", newString: "value = 2" }, helper)

        // Another conversation in the same folder is refused without the helper's title or session.
        const unnamed = yield* run(
          { filePath: filepath, oldString: "value = 1", newString: "value = 4" },
          neighbour,
        ).pipe(Effect.exit)
        expect(Exit.isFailure(unnamed) && Cause.squash(unnamed.cause)).toMatchObject({
          reason: "changed",
          message: `${filepath} changed since you last read it, written by another conversation. Nothing was written; read it again first.`,
        })
        expect(yield* load(filepath)).toBe("export const value = 2\n")

        const exit = yield* run(
          { filePath: filepath, oldString: "value = 1", newString: "value = 3" },
          { ...ctx, inFamily: (id) => audience.inFamily(ctx.sessionID, id) },
        ).pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          reason: "changed",
          message: `${filepath} changed since you last read it, written by the subagent "Bump the value" (ses_test-edit-helper). Nothing was written; read it again first.`,
        })
        expect(yield* load(filepath)).toBe("export const value = 2\n")
      }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
    )

    it.instance("a change by anyone else during the ask is refused and nothing is written", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "value = 0\n")

        const exit = yield* run(
          { filePath: filepath, oldString: "value = 0", newString: "value = 1" },
          { ...ctx, ask: () => Effect.promise(() => fs.writeFile(filepath, "value = 0\nextra = 1\n")) },
        ).pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ reason: "changed" })
        expect(yield* load(filepath)).toBe("value = 0\nextra = 1\n")
      }),
    )

    it.instance("the edit's metadata carries the file as written, which seeds the session after a restart", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "value = 0\n")
        const result = yield* run({ filePath: filepath, oldString: "value = 0", newString: "value = 1" })
        expect(FileState.known(ctx.sessionID, filepath, [])).toEqual(result.metadata.fileState)

        FileState.forget(ctx.sessionID)
        const messages = [
          {
            info: { id: "msg_1", role: "assistant" },
            parts: [{ type: "tool", tool: "edit", state: { status: "completed", metadata: result.metadata } }],
          },
        ] as unknown as Tool.Context["messages"]
        yield* run({ filePath: filepath, oldString: "value = 1", newString: "value = 2" }, { ...ctx, messages })
        expect(yield* load(filepath)).toBe("value = 2\n")
      }),
    )
  })
})
