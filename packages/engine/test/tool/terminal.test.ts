import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { Location } from "@vectordevai/core/location"
import { buildLocationServiceMap, LocationServiceMap } from "@vectordevai/core/location-services"
import { Pty } from "@vectordevai/core/pty"
import { AbsolutePath } from "@vectordevai/core/schema"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { MessageID, SessionID } from "../../src/session/schema"
import { TerminalTool } from "../../src/tool/terminal"
import type { Tool } from "../../src/tool/tool"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The location services the tool reaches, built as the app's are, except that they publish on this test's event bus
// so a test sees what its terminals announce. The tool and the agent's own node reach this same map.
const locations = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: Layer.unwrap(
    EventV2.Service.use((events) =>
      Effect.succeed(buildLocationServiceMap([[EventV2.node, Layer.succeed(EventV2.Service, events)]])),
    ),
  ),
  deps: [EventV2.node],
})

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
        Permission.node,
        EventV2.node,
        locations,
      ]),
      [[locations, locations]],
    ),
    testInstanceStoreLayer,
  ),
)
const ptyTest = process.platform === "win32" ? it.live.skip : it.live

type Ask = Parameters<Tool.Context["ask"]>[0]

const context = (
  asked: Ask[] = [],
  options: { sessionID?: string; parentID?: string; reject?: (ask: Ask) => boolean } = {},
): Tool.Context => ({
  sessionID: SessionID.make(options.sessionID ?? "ses_terminal"),
  ...(options.parentID ? { parentID: SessionID.make(options.parentID) } : {}),
  messageID: MessageID.make("msg_terminal"),
  callID: "call_terminal",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (input) =>
    Effect.sync(() => {
      asked.push(input)
      if (options.reject?.(input)) throw new Error(`rejected ${input.permission}`)
    }),
})

// One tool for the whole test: it remembers what was typed into each terminal between calls.
const init = Effect.fn("TerminalToolTest.init")(function* () {
  const info = yield* TerminalTool
  return yield* info.init()
})

// In a fresh project, with the location's own terminal service at hand for terminals the tool did not open.
const project = <A, E, R>(
  body: (input: { directory: string; worktree: string; pty: Pty.Interface }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    return yield* Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const locations = yield* LocationServiceMap.Service
      const pty = yield* Pty.Service.pipe(
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(instance.directory) }))),
      )
      return yield* body({ directory: instance.directory, worktree: instance.worktree, pty })
    }).pipe(provideInstance(dir))
  })

const bun = (code: string) => ({ command: process.execPath, args: ["-e", code] })
const IDLE = "setInterval(() => {}, 1000)"
// Prints every byte it reads, unchanged by the terminal's line editing.
const RAW = `process.stdin.setRawMode(true); process.stdin.on("data", (data) => console.log("got " + [...data].join(","))); console.log("ready")`

const bytes = (output: string) =>
  [...output.matchAll(/got ([\d,]+)/g)].flatMap((match) => match[1].split(",").map(Number))

const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected the call to fail")
  return String(Cause.squash(exit.cause))
}

describe("tool.terminal", () => {
  ptyTest("opens a command line through the configured shell, as the shell tool runs it", () =>
    project(({ pty }) =>
      Effect.gen(function* () {
        const tool = yield* init()
        const asked: Ask[] = []
        const opened = yield* tool.execute(
          { action: "open", command: "printf 'one\\ntwo\\n'; sleep 5" },
          context(asked),
        )
        expect(opened.metadata).toMatchObject({
          action: "open",
          status: "running",
          title: "printf 'one\\ntwo\\n'; sleep 5",
        })
        expect(asked).toEqual([
          expect.objectContaining({ permission: "bash", patterns: ["printf 'one\\ntwo\\n'", "sleep 5"] }),
        ])
        const waited = yield* tool.execute({ action: "wait", id: opened.metadata.id, pattern: "^two$" }, context())
        expect(waited.metadata.matched).toBe("pattern")
        expect(waited.output).toContain("one\ntwo")
        expect(yield* pty.list()).toEqual([
          expect.objectContaining({ id: opened.metadata.id, owner: { kind: "agent", sessionID: "ses_terminal" } }),
        ])
      }),
    ),
  )
  ptyTest("starts a program with args directly and asks for it as one quoted command line", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        const asked: Ask[] = []
        const opened = yield* tool.execute({ action: "open", ...bun("console.log(40 + 2)") }, context(asked))
        expect(asked).toEqual([
          expect.objectContaining({ permission: "bash", patterns: [`${process.execPath} -e 'console.log(40 + 2)'`] }),
        ])
        const waited = yield* tool.execute({ action: "wait", id: opened.metadata.id, exit: true }, context())
        expect(waited.metadata).toMatchObject({ matched: "exit", status: "exited", exitCode: 0 })
        expect(waited.output).toContain("42")
      }),
    ),
  )

  ptyTest("reads the tail and from a cursor, without escape sequences, redrawn progress or backspaced text", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        const opened = yield* tool.execute(
          {
            action: "open",
            ...bun(
              `process.stdout.write("\\x1b[31mred\\x1b[0m\\nprogress 10%\\rprogress 100%\\nab\\bc\\n"); setTimeout(() => console.log("later"), 400); ${IDLE}`,
            ),
          },
          context(),
        )
        const id = opened.metadata.id
        const first = yield* tool.execute({ action: "wait", id, pattern: "^ac$" }, context())
        expect(first.output).toContain("red\nprogress 100%\nac")
        expect(first.output).not.toContain("progress 10%")
        expect(first.output).not.toContain("\x1b")
        const next = yield* tool.execute(
          { action: "wait", id, pattern: "later", cursor: first.metadata.cursor },
          context(),
        )
        expect(next.output.split("\n\n")[1]).toBe("later\n")
        const fromCursor = yield* tool.execute({ action: "read", id, cursor: first.metadata.cursor }, context())
        expect(fromCursor.output).toContain(`cursor=${next.metadata.cursor}`)
        expect(fromCursor.output.split("\n\n")[1]).toBe("later\n")
        const tail = yield* tool.execute({ action: "read", id, lines: 2 }, context())
        expect(tail.output.split("\n\n")[1]).toBe("ac\nlater\n")
        expect(tail.metadata).toMatchObject({ action: "read", status: "running", cursor: next.metadata.cursor })
      }),
    ),
  )

  ptyTest("reads a terminal after its process exits, with its status, exit code and output", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        const opened = yield* tool.execute({ action: "open", ...bun(`console.log("bye"); process.exit(3)`) }, context())
        yield* tool.execute({ action: "wait", id: opened.metadata.id, exit: true }, context())
        const read = yield* tool.execute({ action: "read", id: opened.metadata.id }, context())
        expect(read.metadata).toMatchObject({ status: "exited", exitCode: 3 })
        expect(read.output).toContain("exited with code 3, yours")
        expect(read.output).toContain("bye")
        const typed = yield* tool.execute({ action: "type", id: opened.metadata.id, text: "x", enter: true }, context())
        expect(typed.output).toContain("Nothing was typed.")
      }),
    ),
  )

  ptyTest("type and keys write the bytes they stand for", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        const opened = yield* tool.execute({ action: "open", ...bun(RAW) }, context())
        const id = opened.metadata.id
        const ready = yield* tool.execute({ action: "wait", id, pattern: "ready" }, context())
        yield* tool.execute({ action: "type", id, text: "ab\tc\nd", enter: true }, context())
        const typed = yield* tool.execute(
          { action: "wait", id, pattern: "got .*13$", cursor: ready.metadata.cursor },
          context(),
        )
        expect(bytes(typed.output)).toEqual([97, 98, 9, 99, 13, 100, 13])
        yield* tool.execute(
          { action: "keys", id, keys: ["up", "ctrl-c", "escape", "enter", "space", "delete"] },
          context(),
        )
        const pressed = yield* tool.execute(
          { action: "wait", id, pattern: "got .*126$", cursor: typed.metadata.cursor },
          context(),
        )
        expect(bytes(pressed.output)).toEqual([27, 91, 65, 3, 27, 13, 32, 27, 91, 51, 126])
      }),
    ),
  )

  ptyTest("refuses control characters in typed text, before anything is asked or written", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        const opened = yield* tool.execute({ action: "open", ...bun(RAW) }, context())
        const ready = yield* tool.execute({ action: "wait", id: opened.metadata.id, pattern: "ready" }, context())
        const asked: Ask[] = []
        for (const text of ["a\x1b[A", "\x03", "a\x7f"]) {
          const typed = yield* tool.execute({ action: "type", id: opened.metadata.id, text }, context(asked))
          expect(typed.output).toContain("Use keys for control keys.")
        }
        expect(asked).toEqual([])
        const read = yield* tool.execute(
          { action: "read", id: opened.metadata.id, cursor: ready.metadata.cursor },
          context(),
        )
        expect(read.output).not.toContain("got")
      }),
    ),
  )

  ptyTest("waits for a pattern already printed, for quiet and until its timeout", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        const opened = yield* tool.execute({ action: "open", ...bun(`console.log("READY a(b"); ${IDLE}`) }, context())
        const id = opened.metadata.id
        yield* tool.execute({ action: "wait", id, quiet: 300 }, context())
        // Printed before this call, and an invalid expression is looked for as text.
        const literal = yield* tool.execute({ action: "wait", id, pattern: "a(b" }, context())
        expect(literal.metadata.matched).toBe("pattern")
        const quiet = yield* tool.execute({ action: "wait", id, quiet: 200 }, context())
        expect(quiet.metadata.matched).toBe("quiet")
        const started = Date.now()
        const timeout = yield* tool.execute({ action: "wait", id, pattern: "never", timeout: 300 }, context())
        expect(timeout.metadata.matched).toBe("timeout")
        expect(timeout.output).toContain("Gave up after 300 ms.")
        expect(Date.now() - started).toBeGreaterThanOrEqual(300)
        const aimless = yield* tool.execute({ action: "wait", id }, context())
        expect(aimless.output).toContain("wait needs pattern")
      }),
    ),
  )

  ptyTest("reveal and open with reveal publish pty.revealed, with focus only when asked", () =>
    project(() =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const revealed: unknown[] = []
        const unsubscribe = yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type === Pty.Event.Revealed.type) revealed.push(event.data)
          }),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        const tool = yield* init()
        const opened = yield* tool.execute({ action: "open", ...bun(IDLE), reveal: true }, context())
        const shown = yield* tool.execute({ action: "reveal", id: opened.metadata.id, focus: true }, context())
        expect(shown.output).toBe(
          `Asked Vector to show ${opened.metadata.id} in the terminal panel. A client without a terminal panel shows nothing.`,
        )
        expect(revealed).toEqual([
          { id: opened.metadata.id, focus: false },
          { id: opened.metadata.id, focus: true },
        ])
      }),
    ),
  )

  ptyTest("list shows the command line a terminal runs, not the shell's wrapper around it", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        yield* tool.execute(
          { action: "open", command: "sleep 30 && echo started-the-server", title: "server" },
          context(),
        )
        const listed = (yield* tool.execute({ action: "list" }, context())).output
        expect(listed).toContain("  command: sleep 30 && echo started-the-server")
        expect(listed).not.toContain("source")
      }),
    ),
  )

  ptyTest("a program opened with args gets exactly those arguments, with no login flag after them", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        const opened = yield* tool.execute(
          { action: "open", command: "/bin/sh", args: ["-c", 'echo "ARGS[$0][$#]"', "x"] },
          context(),
        )
        const waited = yield* tool.execute({ action: "wait", id: opened.metadata.id, exit: true }, context())
        expect(waited.output).toContain("ARGS[x][0]")
        const listed = (yield* tool.execute({ action: "list" }, context())).output
        expect(listed).toContain('  command: /bin/sh -c echo "ARGS[$0][$#]" x')
        expect(listed).not.toContain(" x -l")
      }),
    ),
  )

  ptyTest("type names the cursor to read from when its result shows only the end of the new output", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        // Prints a first line and then far more than a result shows, all at once, for each line it reads.
        const opened = yield* tool.execute(
          {
            action: "open",
            ...bun(
              `process.stdin.on("data", () => process.stdout.write("FIRST-LINE\\n" + "x".repeat(20000) + "\\nLAST-LINE\\n")); console.log("ready")`,
            ),
          },
          context(),
        )
        const id = opened.metadata.id
        yield* tool.execute({ action: "wait", id, pattern: "ready" }, context())
        const typed = yield* tool.execute({ action: "type", id, text: "go", enter: true }, context())
        expect(typed.output).toContain("LAST-LINE")
        expect(typed.output).not.toContain("FIRST-LINE")
        const from = /Read with cursor=(\d+) to see the output before them\./.exec(typed.output)?.[1]
        expect(from).toBeDefined()
        const earlier = yield* tool.execute({ action: "read", id, cursor: Number(from) }, context())
        expect(earlier.output).toContain("FIRST-LINE")
      }),
    ),
  )

  ptyTest("close removes the terminal, and an unknown terminal is reported, not thrown", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        const opened = yield* tool.execute({ action: "open", ...bun(IDLE), title: "idle" }, context())
        const id = String(opened.metadata.id)
        expect((yield* tool.execute({ action: "list" }, context())).output).toContain(`Terminal ${id} "idle"`)
        expect((yield* tool.execute({ action: "close", id }, context())).output).toContain(`Closed Terminal ${id}`)
        expect((yield* tool.execute({ action: "list" }, context())).output).toBe(
          "No terminals here. Open one with action open.",
        )
        for (const missing of [id, "pty_missing", "not-a-terminal"])
          expect((yield* tool.execute({ action: "read", id: missing }, context())).output).toBe(
            `No terminal ${missing} here. List terminals with action list.`,
          )
      }),
    ),
  )
})

describe("tool.terminal permissions", () => {
  ptyTest("own terminals ask nothing to resize or close; the user's and other sessions' ask under other:<id>", () =>
    project(({ pty }) =>
      Effect.gen(function* () {
        const tool = yield* init()
        const own = yield* tool.execute({ action: "open", ...bun(IDLE) }, context())
        const user = yield* pty.create(bun(IDLE))
        const other = yield* pty.create(bun(IDLE), { kind: "agent", sessionID: "ses_other" })
        const listed = (yield* tool.execute({ action: "list" }, context())).output
        expect(listed).toContain(`Terminal ${own.metadata.id} "${own.metadata.title}": running`)
        expect(listed).toContain(`Terminal ${user.id} "${user.title}": running (pid ${user.pid}), the user's`)
        expect(listed).toContain(
          `Terminal ${other.id} "${other.title}": running (pid ${other.pid}), another agent session's`,
        )

        const asked: Ask[] = []
        const clamped = yield* tool.execute(
          { action: "resize", id: own.metadata.id, cols: 10, rows: 1000 },
          context(asked),
        )
        expect(clamped.output).toBe(`Resized ${own.metadata.id} to 20 columns and 200 rows.`)
        const half = yield* tool.execute({ action: "resize", id: own.metadata.id, cols: 100 }, context(asked))
        expect(half.output).toBe("resize needs both cols and rows.")
        expect(asked).toEqual([])
        for (const id of [user.id, other.id]) {
          const resized = yield* tool.execute({ action: "resize", id, cols: 120, rows: 40 }, context(asked))
          expect(resized.output).toBe(`Resized ${id} to 120 columns and 40 rows.`)
          yield* tool.execute({ action: "type", id, text: "x" }, context(asked))
          yield* tool.execute({ action: "close", id }, context(asked))
        }
        expect(asked.map((ask) => [ask.permission, ask.patterns, ask.always])).toEqual(
          [user.id, other.id].flatMap((id) => [
            ["terminal", [`other:${id}`], [`other:${id}`]],
            ["terminal_input", [`other:${id}`], [`other:${id}`]],
            ["terminal", [`other:${id}`], [`other:${id}`]],
          ]),
        )

        // A subagent works in the terminals its parent opened as its own.
        const parents = yield* pty.create(bun(IDLE), { kind: "agent", sessionID: "ses_parent" })
        asked.length = 0
        yield* tool.execute(
          { action: "type", id: parents.id, text: "x" },
          context(asked, { sessionID: "ses_child", parentID: "ses_parent" }),
        )
        yield* tool.execute({ action: "close", id: own.metadata.id }, context(asked))
        expect(asked.map((ask) => [ask.permission, ask.patterns])).toEqual([["terminal_input", [`own:${parents.id}`]]])
      }),
    ),
  )

  ptyTest("a submitted line is asked as the shell command it is, before anything is written", () =>
    project(({ directory, worktree }) =>
      Effect.gen(function* () {
        const tool = yield* init()
        const opened = yield* tool.execute({ action: "open", ...bun(RAW) }, context())
        const id = opened.metadata.id
        const ready = yield* tool.execute({ action: "wait", id, pattern: "ready" }, context())
        const asked: Ask[] = []
        yield* tool.execute({ action: "type", id, text: "echo hello\ncat .env /etc/hosts" }, context(asked))
        expect(asked.map((ask) => [ask.permission, ask.patterns])).toEqual([
          ["terminal_input", [`own:${id}`]],
          ["bash", ["echo hello"]],
        ])
        asked.length = 0
        yield* tool.execute({ action: "keys", id, keys: ["enter"] }, context(asked))
        expect(asked.map((ask) => [ask.permission, ask.patterns])).toEqual([
          ["terminal_input", [`own:${id}`]],
          ["external_directory", [path.join("/etc", "*")]],
          ["bash", ["cat .env /etc/hosts"]],
          ["read", [path.relative(worktree, path.join(directory, ".env"))]],
        ])

        // A cloud CLI asks under Vector Cloud's permission; refused, nothing reaches the terminal.
        asked.length = 0
        const cloud = yield* tool
          .execute(
            { action: "type", id, text: "vercel --prod", enter: true },
            context(asked, { reject: (ask) => ask.permission.startsWith("vector_cloud_") }),
          )
          .pipe(Effect.exit)
        expect(failure(cloud)).toContain("rejected vector_cloud_publish")
        expect(asked.map((ask) => ask.permission)).toEqual(["terminal_input", "bash", "vector_cloud_publish"])
        expect(asked[2].patterns).toEqual([`vercel/${path.basename(directory)}/production/shell deploy`])
        const read = yield* tool.execute({ action: "read", id, cursor: ready.metadata.cursor }, context())
        expect(bytes(read.output)).toEqual(
          Array.from("echo hello\rcat .env /etc/hosts\r", (char) => char.charCodeAt(0)),
        )
      }),
    ),
  )

  ptyTest("a line continued with a backslash is asked together with the next, as the shell runs them", () =>
    project(({ directory }) =>
      Effect.gen(function* () {
        const tool = yield* init()
        // Raw input: ctrl-c reaches the program as a byte instead of interrupting it.
        const opened = yield* tool.execute({ action: "open", ...bun(RAW) }, context())
        const id = opened.metadata.id
        const asked: Ask[] = []
        const reject = (ask: Ask) => ask.permission.startsWith("vector_cloud_")
        yield* tool.execute({ action: "type", id, text: "vercel \\", enter: true }, context(asked, { reject }))
        expect(asked.map((ask) => ask.permission)).toEqual(["terminal_input"])
        const exit = yield* tool
          .execute({ action: "type", id, text: "--prod", enter: true }, context(asked, { reject }))
          .pipe(Effect.exit)
        expect(failure(exit)).toContain("rejected vector_cloud_publish")
        expect(asked.slice(1).map((ask) => [ask.permission, ask.patterns])).toEqual([
          ["terminal_input", [`own:${id}`]],
          ["bash", ["vercel --prod"]],
          ["vector_cloud_publish", [`vercel/${path.basename(directory)}/production/shell deploy`]],
        ])
        // The refused line never reached the terminal, whose shell still holds `vercel `: the next line is more of it,
        // until ctrl-c clears it. An escaped backslash then ends a line as usual.
        asked.length = 0
        yield* tool
          .execute({ action: "type", id, text: "echo", enter: true }, context(asked, { reject }))
          .pipe(Effect.exit)
        yield* tool.execute({ action: "keys", id, keys: ["ctrl-c"] }, context(asked))
        yield* tool.execute({ action: "type", id, text: "echo \\\\", enter: true }, context(asked))
        expect(asked.filter((ask) => ask.permission === "bash").map((ask) => ask.patterns)).toEqual([
          ["vercel echo"],
          ["echo \\\\"],
        ])
      }),
    ),
  )

  ptyTest("a network command asks under Vector Local, every time", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        const opened = yield* tool.execute({ action: "open", ...bun(IDLE) }, context())
        yield* Effect.acquireRelease(
          Effect.sync(() => Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))),
          () => Effect.sync(() => Egress.configure(LocalPolicy.OFF)),
        )
        const asked: Ask[] = []
        const exit = yield* tool
          .execute(
            { action: "type", id: opened.metadata.id, text: "curl https://example.com", enter: true },
            context(asked, { reject: (ask) => ask.permission === "network_command" }),
          )
          .pipe(Effect.exit)
        expect(failure(exit)).toContain("rejected network_command")
        expect(asked.map((ask) => [ask.permission, ask.patterns])).toEqual([
          ["terminal_input", [`own:${opened.metadata.id}`]],
          ["bash", ["curl https://example.com"]],
          ["network_command", ["curl https://example.com"]],
        ])
      }),
    ),
  )

  ptyTest("a line Vector cannot know exactly is asked only as written, behind the unread prefix", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        const opened = yield* tool.execute({ action: "open", ...bun(IDLE) }, context())
        const id = opened.metadata.id
        const asked: Ask[] = []
        // Tab completion, a recalled line and history expansion all run something other than what was typed.
        yield* tool.execute({ action: "type", id, text: "git sta" }, context(asked))
        yield* tool.execute({ action: "keys", id, keys: ["tab", "enter", "up", "enter"] }, context(asked))
        yield* tool.execute({ action: "type", id, text: "sudo !!", enter: true }, context(asked))
        // ctrl-u starts the line over, exactly known again; backspace edits it in place.
        yield* tool.execute({ action: "type", id, text: "rm -rf /" }, context(asked))
        yield* tool.execute({ action: "keys", id, keys: ["ctrl-u"] }, context(asked))
        yield* tool.execute({ action: "type", id, text: "lsx" }, context(asked))
        yield* tool.execute({ action: "keys", id, keys: ["backspace", "enter"] }, context(asked))
        expect(asked.filter((ask) => ask.permission === "bash").map((ask) => ask.patterns)).toEqual([
          ["git sta", "#unread git sta"],
          ["#unread "],
          ["sudo !!", "#unread sudo !!"],
          ["ls"],
        ])
        // The recalled line and the history expansion may run any command, a cloud CLI among them.
        expect(asked.filter((ask) => ask.permission === "vector_cloud_unread").map((ask) => ask.patterns)).toEqual([
          ["#unread "],
          ["#unread sudo !!"],
        ])
      }),
    ),
  )

  ptyTest("a line Vector cannot read asks as a network command under Vector Local, whatever its typed text", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        const opened = yield* tool.execute({ action: "open", ...bun(IDLE) }, context())
        const id = opened.metadata.id
        yield* Effect.acquireRelease(
          Effect.sync(() => Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))),
          () => Effect.sync(() => Egress.configure(LocalPolicy.OFF)),
        )
        const asked: Ask[] = []
        // A line recalled from history.
        yield* tool.execute({ action: "keys", id, keys: ["up", "enter"] }, context(asked))
        // A line cleared into the kill ring and yanked back: nothing typed is left, yet the shell runs the curl.
        yield* tool.execute({ action: "type", id, text: "curl https://example.com" }, context(asked))
        yield* tool.execute({ action: "keys", id, keys: ["ctrl-u", "ctrl-y", "enter"] }, context(asked))
        // A word tab completion finishes, which the typed text does not show.
        yield* tool.execute({ action: "type", id, text: "npm in\t", enter: true }, context(asked))
        expect(
          asked.filter((ask) => ask.permission !== "terminal_input").map((ask) => [ask.permission, ask.patterns]),
        ).toEqual([
          ["bash", ["#unread "]],
          ["network_command", ["#unread "]],
          ["vector_cloud_unread", ["#unread "]],
          ["bash", ["#unread "]],
          ["network_command", ["#unread "]],
          ["vector_cloud_unread", ["#unread "]],
          ["bash", ["npm in", "#unread npm in"]],
          ["network_command", ["#unread npm in"]],
        ])
        expect(asked.find((ask) => ask.permission === "network_command")?.metadata).toMatchObject({
          reason: expect.stringContaining("Vector cannot read what this terminal line runs"),
        })
        // Refused, the recalled line never reaches the terminal.
        const refused = yield* tool
          .execute(
            { action: "keys", id, keys: ["up", "enter"] },
            context([], { reject: (ask) => ask.permission === "network_command" }),
          )
          .pipe(Effect.exit)
        expect(failure(refused)).toContain("rejected network_command")
      }),
    ),
  )

  ptyTest(
    "a line the shell may fill from history asks as a cloud CLI every time, which auto-accept never answers",
    () =>
      project(() =>
        Effect.gen(function* () {
          const tool = yield* init()
          // Raw input: ctrl-c reaches the program as a byte instead of interrupting it.
          const opened = yield* tool.execute({ action: "open", ...bun(RAW) }, context())
          const id = opened.metadata.id
          yield* tool.execute({ action: "wait", id, pattern: "ready" }, context())
          const submit = Effect.fn("TerminalToolTest.submit")(function* (text: string) {
            const asked: Ask[] = []
            yield* tool.execute({ action: "type", id, text, enter: true }, context(asked))
            return {
              text,
              unread: asked.some(
                (ask) => ask.permission === "bash" && ask.patterns.some((item) => item.startsWith("#unread")),
              ),
              cloud: asked.filter((ask) => ask.permission === "vector_cloud_unread"),
            }
          })
          // History builtins run a saved line again, and a word tab completion finishes may be a cloud CLI's name.
          for (const text of ["r", "cd x; fc -s", "fc -e -", "ihy 3", "Invoke-History 3", "echo !!", "verc\t --prod"]) {
            const result = yield* submit(text)
            expect({ text, unread: result.unread, cloud: result.cloud.length }).toEqual({
              text,
              unread: true,
              cloud: 1,
            })
            const ask = result.cloud[0]
            expect(PermissionPolicy.canAutoApprove(ask.permission, ask.always, ask.patterns)).toBe(false)
            expect(ask.always).toEqual([])
          }
          // A `!` the shell never expands, a word that only starts with r, and a completion that cannot be a cloud CLI.
          for (const [text, unread] of [
            ['[ "$a" != b ]', false],
            ["echo r2 rm", false],
            ["git sta\t", true],
          ] as const) {
            const result = yield* submit(text)
            expect({ text, unread: result.unread, cloud: result.cloud.length }).toEqual({ text, unread, cloud: 0 })
          }
          // Keys that may pull text from history or the kill ring mark the line the same way, and ctrl-u keeps it so,
          // since vi's command mode reads the next letters as commands.
          for (const keys of [["up"], ["ctrl-r"], ["ctrl-y"], ["escape"], ["page_up"], ["up", "ctrl-u"]] as const) {
            const asked: Ask[] = []
            yield* tool.execute({ action: "keys", id, keys: [...keys] }, context())
            yield* tool.execute({ action: "type", id, text: "ls", enter: true }, context(asked))
            expect({ keys, cloud: asked.filter((ask) => ask.permission === "vector_cloud_unread").length }).toEqual({
              keys,
              cloud: 1,
            })
          }
          // ctrl-c starts a new line, exactly known again.
          const asked: Ask[] = []
          yield* tool.execute({ action: "keys", id, keys: ["up", "ctrl-c"] }, context())
          yield* tool.execute({ action: "type", id, text: "ls", enter: true }, context(asked))
          expect(asked.filter((ask) => ask.permission !== "terminal_input").map((ask) => ask.patterns)).toEqual([
            ["ls"],
          ])
        }),
      ),
    30_000,
  )

  ptyTest("ctrl-o and ctrl-d hand a line over as Enter does, and input to a line Vector cannot follow asks first", () =>
    project(({ directory, worktree }) =>
      Effect.gen(function* () {
        const tool = yield* init()
        // Raw input: every key reaches the program as its byte, so the test sees what was written.
        const opened = yield* tool.execute({ action: "open", ...bun(RAW) }, context())
        const id = opened.metadata.id
        const ready = yield* tool.execute({ action: "wait", id, pattern: "ready" }, context())
        const asked: Ask[] = []
        // bash's operate-and-get-next runs the line it ends, and a program reading lines takes the line at ctrl-d.
        yield* tool.execute({ action: "type", id, text: "cat .env" }, context(asked))
        yield* tool.execute({ action: "keys", id, keys: ["ctrl-o", "ctrl-d"] }, context(asked))
        expect(asked.find((ask) => ask.permission === "read")?.patterns).toEqual([
          path.relative(worktree, path.join(directory, ".env")),
        ])
        yield* tool.execute({ action: "type", id, text: "echo one" }, context(asked))
        yield* tool.execute({ action: "keys", id, keys: ["ctrl-d"] }, context(asked))
        // A line editor keeps the line at ctrl-d, so clearing it is one more chance to run it.
        yield* tool.execute({ action: "keys", id, keys: ["ctrl-c"] }, context(asked))
        // After ctrl-x, bash reads the next key as a command: ctrl-e hands the line to an editor, which runs it on ZZ.
        yield* tool.execute({ action: "type", id, text: "echo two" }, context(asked))
        yield* tool.execute({ action: "keys", id, keys: ["ctrl-x"] }, context(asked))
        yield* tool.execute({ action: "keys", id, keys: ["ctrl-e"] }, context(asked))
        const refused = yield* tool
          .execute(
            { action: "type", id, text: "ZZ" },
            context(asked, { reject: (ask) => ask.patterns.includes("#unread echo twoZZ") }),
          )
          .pipe(Effect.exit)
        expect(failure(refused)).toContain("rejected bash")
        yield* tool.execute({ action: "keys", id, keys: ["enter"] }, context(asked))
        expect(asked.filter((ask) => ask.permission === "bash").map((ask) => ask.patterns)).toEqual([
          ["cat .env"],
          ["echo one"],
          ["echo one", "#unread echo one"],
          ["echo two", "#unread echo two"],
          ["echo twoZZ", "#unread echo twoZZ"],
          ["echo two", "#unread echo two"],
        ])
        const read = yield* tool.execute({ action: "read", id, cursor: ready.metadata.cursor }, context())
        expect(bytes(read.output)).toEqual([
          ...Array.from("cat .env", (char) => char.charCodeAt(0)),
          15,
          4,
          ...Array.from("echo one", (char) => char.charCodeAt(0)),
          4,
          3,
          ...Array.from("echo two", (char) => char.charCodeAt(0)),
          24,
          5,
          13,
        ])
      }),
    ),
  )

  ptyTest("a refused open starts no process: its shell, network and cloud asks all come before the terminal", () =>
    project(({ pty }) =>
      Effect.gen(function* () {
        const tool = yield* init()
        const asked: Ask[] = []
        const cloud = yield* tool
          .execute(
            { action: "open", command: "vercel --prod" },
            context(asked, { reject: (ask) => ask.permission.startsWith("vector_cloud_") }),
          )
          .pipe(Effect.exit)
        expect(failure(cloud)).toContain("rejected vector_cloud_publish")
        expect(asked.map((ask) => ask.permission)).toEqual(["bash", "vector_cloud_publish"])
        expect(yield* pty.list()).toEqual([])

        const program = yield* tool
          .execute(
            { action: "open", ...bun("console.log(1)") },
            context([], { reject: (ask) => ask.permission === "bash" }),
          )
          .pipe(Effect.exit)
        expect(failure(program)).toContain("rejected bash")
        expect(yield* pty.list()).toEqual([])

        yield* Effect.acquireRelease(
          Effect.sync(() => Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))),
          () => Effect.sync(() => Egress.configure(LocalPolicy.OFF)),
        )
        asked.length = 0
        const network = yield* tool
          .execute(
            { action: "open", command: "curl https://example.com" },
            context(asked, { reject: (ask) => ask.permission === "network_command" }),
          )
          .pipe(Effect.exit)
        expect(failure(network)).toContain("rejected network_command")
        expect(asked.map((ask) => [ask.permission, ask.patterns])).toEqual([
          ["bash", ["curl https://example.com"]],
          ["network_command", ["curl https://example.com"]],
        ])
        expect(yield* pty.list()).toEqual([])
      }),
    ),
  )

  ptyTest("the plan agent never types into a terminal, whatever it may run", () =>
    project(() =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const permission = yield* Permission.Service
        const plan = yield* agents.get("plan")
        const tool = yield* init()
        const opened = yield* tool.execute({ action: "open", ...bun(RAW) }, context())
        const ready = yield* tool.execute({ action: "wait", id: opened.metadata.id, pattern: "ready" }, context())
        const planned = {
          ...context(),
          agent: "plan",
          ask: (input: Ask) =>
            permission
              .ask({ ...input, sessionID: SessionID.make("ses_terminal"), ruleset: plan.permission })
              .pipe(Effect.orDie),
        }
        const exit = yield* tool
          .execute({ action: "type", id: opened.metadata.id, text: "ls", enter: true }, planned)
          .pipe(Effect.exit)
        expect(failure(exit)).toContain("terminal_input")
        const read = yield* tool.execute(
          { action: "read", id: opened.metadata.id, cursor: ready.metadata.cursor },
          context(),
        )
        expect(read.output).not.toContain("got")
      }),
    ),
  )

  ptyTest("open asks for a directory outside the project and, with the sandbox on, to run unsandboxed", () =>
    project(({ directory }) =>
      Effect.gen(function* () {
        const tool = yield* init()
        const asked: Ask[] = []
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env.VECTOR_SHELL_SANDBOX
            process.env.VECTOR_SHELL_SANDBOX = "1"
            return previous
          }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.VECTOR_SHELL_SANDBOX
              else process.env.VECTOR_SHELL_SANDBOX = previous
            }),
        )
        const opened = yield* tool.execute({ action: "open", cwd: path.dirname(directory) }, context(asked))
        expect(asked.map((ask) => [ask.permission, ask.patterns])).toEqual([
          ["unsandboxed_shell", [process.platform]],
          ["external_directory", [path.join(path.dirname(directory), "*")]],
        ])
        expect(asked[0].metadata).toMatchObject({ reason: "Terminals run outside the shell sandbox." })
        asked.length = 0
        yield* tool.execute({ action: "type", id: opened.metadata.id, text: "pwd", enter: true }, context(asked))
        // The terminal's own directory is outside the project too.
        expect(asked.map((ask) => ask.permission)).toEqual([
          "terminal_input",
          "unsandboxed_shell",
          "external_directory",
          "bash",
        ])
      }),
    ),
  )

  ptyTest("with Web access None, open, type and keys refuse before anything is asked", () =>
    project(() =>
      Effect.gen(function* () {
        const tool = yield* init()
        const opened = yield* tool.execute({ action: "open", ...bun(IDLE) }, context())
        yield* Effect.acquireRelease(
          Effect.sync(() => Egress.configure(LocalPolicy.resolve({ global: { enabled: true, web: "none" } }))),
          () => Effect.sync(() => Egress.configure(LocalPolicy.OFF)),
        )
        const asked: Ask[] = []
        for (const params of [
          { action: "open" as const, command: "echo hi" },
          { action: "type" as const, id: opened.metadata.id, text: "echo hi", enter: true },
          { action: "keys" as const, id: opened.metadata.id, keys: ["enter" as const] },
        ])
          expect(failure(yield* tool.execute(params, context(asked)).pipe(Effect.exit))).toContain(
            "Vector did not use the terminal. With Web access None",
          )
        expect(asked).toEqual([])
        // Reading asks nothing and runs nothing, so it still works.
        expect((yield* tool.execute({ action: "read", id: opened.metadata.id }, context())).metadata.status).toBe(
          "running",
        )
      }),
    ),
  )
})
