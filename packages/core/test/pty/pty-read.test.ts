import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { Config } from "@vectordevai/core/config"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { Location } from "@vectordevai/core/location"
import { Pty } from "@vectordevai/core/pty"
import type { PtyID } from "@vectordevai/core/pty/schema"
import { AbsolutePath } from "@vectordevai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [Config.node, Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/tmp") }))),
    ],
  ]),
)
const ptyTest = process.platform === "win32" ? it.live.skip : it.live

const createPty = Effect.fn("PtyReadTest.createPty")(function* (script: string, owner?: Pty.Owner) {
  const pty = yield* Pty.Service
  return yield* Effect.acquireRelease(
    pty.create({ command: "/usr/bin/env", args: ["sh", "-c", script], cwd: "/tmp" }, owner),
    (info) => pty.remove(info.id).pipe(Effect.ignore),
  )
})

const readUntil = (id: PtyID, input: Pty.ReadInput | undefined, done: (read: Pty.ReadOutput) => boolean) =>
  Effect.gen(function* () {
    const pty = yield* Pty.Service
    while (true) {
      const read = yield* pty.read(id, input)
      if (done(read)) return read
      yield* Effect.sleep("20 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("timeout waiting for pty output")),
    }),
  )

const waitForExit = (id: PtyID) => readUntil(id, { limit: 0 }, (read) => read.info.status === "exited")

describe("pty read", () => {
  it.live("returns typed not found errors for read and reveal of a missing session", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const id = "pty_missing" as PtyID

      for (const result of [
        yield* pty.read(id).pipe(Effect.asVoid, Effect.exit),
        yield* pty.reveal(id, { focus: true }).pipe(Effect.exit),
      ]) {
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toMatchObject({ _tag: "Pty.NotFoundError", ptyID: id })
      }
    }),
  )

  ptyTest("reads from a cursor, keeps the first units under a limit and returns nothing past the end", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty('printf "one\\ntwo\\nthree\\n"; exec cat')
      const first = yield* readUntil(info.id, { cursor: 0 }, (read) => read.output.includes("three\r\n"))
      expect(first).toMatchObject({ output: "one\r\ntwo\r\nthree\r\n", start: 0, cursor: first.end })

      expect(yield* pty.read(info.id, { cursor: 5, limit: 3 })).toMatchObject({
        output: "two",
        start: 5,
        cursor: 8,
        end: first.end,
      })

      // Only output after the cursor comes back, and cursor < end tells there is more.
      yield* pty.write(info.id, "four\n")
      const next = yield* readUntil(info.id, { cursor: first.cursor }, (read) => read.output.includes("four"))
      expect(next.start).toBe(first.cursor)
      expect(next.output).toStartWith("four")
      expect(next.output).not.toContain("three")
      expect(next.cursor).toBe(next.start + next.output.length)

      const past = yield* pty.read(info.id, { cursor: next.end + 100 })
      expect(past.output).toBe("")
      expect(past.cursor).toBe(past.end)
      expect(past.start).toBe(past.end)
      expect((yield* pty.read(info.id, { cursor: past.end })).output).toBe("")
    }),
  )

  ptyTest("returns the trailing lines of the retained output, cut to a limit", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty('printf "one\\ntwo\\nthree\\n"')
      const full = yield* readUntil(info.id, undefined, (read) => read.output.includes("three\r\n"))
      expect(full).toMatchObject({ output: "one\r\ntwo\r\nthree\r\n", start: 0, cursor: full.end })

      const lines = yield* pty.read(info.id, { lines: 2 })
      expect(lines).toMatchObject({ output: "two\r\nthree\r\n", cursor: full.end, end: full.end })
      expect(lines.start).toBe(full.end - lines.output.length)
      expect((yield* pty.read(info.id, { lines: 1 })).output).toBe("three\r\n")
      expect((yield* pty.read(info.id, { lines: 10 })).output).toBe(full.output)
      expect((yield* pty.read(info.id, { lines: 0 })).output).toBe("")

      const limited = yield* pty.read(info.id, { lines: 2, limit: 4 })
      expect(limited).toMatchObject({ output: "ee\r\n", start: full.end - 4, cursor: full.end })
      expect((yield* pty.read(info.id, { limit: 5 })).output).toBe("ree\r\n")

      // A line still being written, such as a prompt, counts as the last line.
      const prompt = yield* createPty('printf "one\\ntwo\\n> "; exec cat')
      yield* readUntil(prompt.id, undefined, (read) => read.output.endsWith("> "))
      expect((yield* pty.read(prompt.id, { lines: 1 })).output).toBe("> ")
      expect((yield* pty.read(prompt.id, { lines: 2 })).output).toBe("two\r\n> ")
    }),
  )

  ptyTest("reports output lost to the retention limit with start past the requested cursor", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty("head -c 2200000 /dev/zero | tr '\\000' a; printf END")
      yield* readUntil(info.id, { limit: 3 }, (read) => read.output === "END")

      const read = yield* pty.read(info.id, { cursor: 0 })
      expect(read.start).toBeGreaterThan(0)
      expect(read.start + read.output.length).toBe(read.end)
      expect(read.cursor).toBe(read.end)
      expect(read.output).toEndWith("aaaEND")

      expect(yield* pty.read(info.id, { cursor: 0, limit: 10 })).toMatchObject({
        output: "a".repeat(10),
        start: read.start,
        cursor: read.start + 10,
        end: read.end,
      })
    }),
  )

  ptyTest("keeps status, exit code and output readable after the process exits", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty('printf "done\\n"; exit 3')
      yield* waitForExit(info.id)

      const read = yield* readUntil(info.id, undefined, (next) => next.output.includes("done\r\n"))
      expect(read.info).toMatchObject({ id: info.id, status: "exited", exitCode: 3 })
      expect(read.output).toBe("done\r\n")
      expect((yield* pty.read(info.id, { cursor: 0 })).output).toBe("done\r\n")
    }),
  )

  ptyTest("reveal publishes pty.revealed with focus, for running and exited sessions", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const events = yield* EventV2.Service
      const running = yield* createPty("exec cat")
      const exited = yield* createPty("exit 0")
      yield* waitForExit(exited.id)
      const revealed = yield* events
        .subscribe(Pty.Event.Revealed)
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* pty.reveal(running.id)
      yield* pty.reveal(running.id, { focus: true })
      yield* pty.reveal(exited.id, { focus: false })

      expect(
        Array.from(yield* Fiber.join(revealed).pipe(Effect.timeout("5 seconds"))).map((event) => event.data),
      ).toEqual([
        { id: running.id, focus: false },
        { id: running.id, focus: true },
        { id: exited.id, focus: false },
      ])
    }),
  )

  ptyTest("create puts an agent owner on the info and on pty.created, and leaves it off otherwise", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const events = yield* EventV2.Service
      const created = yield* events
        .subscribe(Pty.Event.Created)
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      const owner = { kind: "agent" as const, sessionID: "ses_agent" }
      const agent = yield* createPty("exec cat", owner)
      const user = yield* createPty("exec cat")

      expect(agent.owner).toEqual(owner)
      expect((yield* pty.get(agent.id)).owner).toEqual(owner)
      expect((yield* pty.list()).find((info) => info.id === agent.id)?.owner).toEqual(owner)
      expect("owner" in user).toBe(false)

      const published = Array.from(yield* Fiber.join(created).pipe(Effect.timeout("5 seconds")))
      expect(published.map((event) => event.data.info.owner)).toEqual([owner, undefined])
      expect("owner" in published[1].data.info).toBe(false)
    }),
  )

  ptyTest("a program started with arguments gets exactly those, and only the default shell starts as a login one", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* Effect.acquireRelease(
        pty.create({ command: "/bin/sh", args: ["-c", 'echo "ARGS[$0][$#]"; exec cat', "x"], cwd: "/tmp" }),
        (created) => pty.remove(created.id).pipe(Effect.ignore),
      )
      expect(info.args).toEqual(["-c", 'echo "ARGS[$0][$#]"; exec cat', "x"])
      const read = yield* readUntil(info.id, undefined, (next) => next.output.includes("ARGS[")).pipe(
        Effect.timeout("5 seconds"),
      )
      expect(read.output).toContain("ARGS[x][0]")
    }),
  )
})
