import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import type { ConfigLocalV1 } from "@vectordevai/core/v1/config/local"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { MessageID, SessionID } from "../../src/session/schema"
import { ShellTool } from "../../src/tool/shell"
import { Sandbox } from "../../src/tool/shell/sandbox"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ComputerSession } from "@/computer/session"
import { Session } from "@/session/session"

// Vector Local's Web access None for the commands the agent runs (section 4.3.5): on macOS and Linux every command runs
// in the sandbox with no network but this computer's, whatever VECTOR_SHELL_SANDBOX says, and one the sandbox cannot
// wrap is refused rather than run unwrapped. Windows has no sandbox and says so. The engine suite's strict guard does
// not cover a child's own sockets, so every address a command here tries is one that cannot leave this computer or
// reach anyone: loopback, and TEST-NET-1 (192.0.2.0/24, never routed) standing in for example.com.

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
        ComputerSession.node,
        Session.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

const sandbox = Sandbox.sandboxAvailability()
const darwin = process.platform === "darwin"
const linux = process.platform === "linux"
// curl reports a connection the kernel refused (the sandbox) as 7 at once; an unroutable address that was really tried
// would time out instead (28), after --max-time.
const OUTSIDE = "curl -sS --noproxy '*' --max-time 8 --resolve example.com:443:192.0.2.1 https://example.com/"

const asked: Array<Parameters<Tool.Context["ask"]>[0]> = []
const context = (sessionID = "ses_sandbox_local"): Tool.Context => ({
  sessionID: SessionID.make(sessionID),
  messageID: MessageID.make("msg_sandbox_local"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  // Every ask is answered yes, so what stops a command here is the sandbox and nothing else.
  ask: (input) => Effect.sync(() => void asked.push(input)),
})

// Vector Local as the owner sets it in their own config, so the config watcher applies the same policy if it reads
// the files again in the middle of a test.
const setLocal = (block?: ConfigLocalV1.Info) => {
  const file = path.join(Global.Path.config, "vector.json")
  rmSync(file, { force: true })
  if (block) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ local: block }))
  }
  Config.refreshLocal()
  Config.confirmLocal()
}
const local = (web: "ask" | "none") =>
  Effect.sync(() => {
    asked.length = 0
    setLocal({ enabled: true, web })
  })
afterEach(() => {
  setLocal()
  rmSync(Config.localConfirmedFile(), { force: true })
})

// it.live, skipped where the condition holds.
const liveUnless = (skip: boolean) => (skip ? it.live.skip : it.live)

// One shell tool, so the sessions it has told about the sandbox carry over between its calls.
const shell = Effect.fn("ShellSandboxLocalTest.shell")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

describe("the shell sandbox under Vector Local's Web access None", () => {
  liveUnless(!darwin && !linux)("a command cannot reach another computer", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* local("none")
      const tool = yield* shell().pipe(provideInstance(dir))
      const started = Date.now()
      const result = yield* tool.execute({ command: OUTSIDE }, context()).pipe(provideInstance(dir), Effect.exit)
      if (!sandbox.supported) {
        // Linux without bubblewrap: refused before anything was asked, never run unwrapped.
        expect(Exit.isFailure(result)).toBe(true)
        expect(String(Exit.isFailure(result) ? result.cause : "")).toContain("Vector did not run this command")
        expect(asked).toEqual([])
        return
      }
      expect(Exit.isSuccess(result)).toBe(true)
      if (!Exit.isSuccess(result)) return
      expect(result.value.metadata.exit).toBe(7)
      expect(result.value.output).toMatch(/Failed to connect|Couldn't connect/)
      expect(Date.now() - started).toBeLessThan(6_000)
      expect(result.value.metadata.sandbox).toBe(Sandbox.OFFLINE_NOTICE[sandbox.mechanism as "seatbelt" | "bubblewrap"])
    }),
  )

  liveUnless(!darwin)("on macOS a command still reaches servers on this computer", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("served on this computer") }),
        ),
        (server) => Effect.sync(() => void server.stop(true)),
      )
      yield* local("none")
      const tool = yield* shell().pipe(provideInstance(dir))
      const result = yield* tool
        .execute(
          {
            command: `curl -sS --noproxy '*' --max-time 8 http://127.0.0.1:${server.port}/ && echo && curl -sS --noproxy '*' --max-time 8 http://localhost:${server.port}/`,
          },
          context(),
        )
        .pipe(provideInstance(dir))
      expect(result.metadata.exit).toBe(0)
      expect(result.output.match(/served on this computer/g)).toHaveLength(2)
    }),
  )

  liveUnless(!linux || !sandbox.supported)("on Linux the sandbox cuts off servers on this computer too", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reached") })),
        (server) => Effect.sync(() => void server.stop(true)),
      )
      yield* local("none")
      const tool = yield* shell().pipe(provideInstance(dir))
      const result = yield* tool
        .execute({ command: `curl -sS --noproxy '*' --max-time 8 http://127.0.0.1:${server.port}/` }, context())
        .pipe(provideInstance(dir))
      // Bubblewrap's own network namespace has a loopback of its own, with nothing listening.
      expect(result.metadata.exit).toBe(7)
      expect(result.output).not.toContain("reached")
    }),
  )

  liveUnless(!sandbox.supported)("the first command of a session says what the sandbox limits, and only once", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* local("none")
      const tool = yield* shell().pipe(provideInstance(dir))
      const notice = Sandbox.OFFLINE_NOTICE[sandbox.mechanism as "seatbelt" | "bubblewrap"]
      const first = yield* tool.execute({ command: "echo first" }, context()).pipe(provideInstance(dir))
      const second = yield* tool.execute({ command: "echo second" }, context()).pipe(provideInstance(dir))
      const other = yield* tool
        .execute({ command: "echo other" }, context("ses_sandbox_other"))
        .pipe(provideInstance(dir))
      expect(first.output).toBe(`${notice}\n\nfirst\n`)
      expect(second.output).toBe("second\n")
      expect(other.output).toBe(`${notice}\n\nother\n`)
      // The app can show it on every command run this way.
      expect([first, second, other].map((item) => item.metadata.sandbox)).toEqual([notice, notice, notice])
      expect(notice).toContain("they can write only in this repository")
    }),
  )

  it.live("with Web access Ask a command runs as before, with no sandbox of Vector Local's", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* local("ask")
      const tool = yield* shell().pipe(provideInstance(dir))
      const result = yield* tool.execute({ command: 'echo "as before"' }, context()).pipe(provideInstance(dir))
      expect(result.output).toBe(process.platform === "win32" ? "as before\r\n" : "as before\n")
      expect(result.metadata.sandbox).toBeUndefined()
    }),
  )

  liveUnless(!linux)("on Linux a command is refused before anything is asked when bwrap is missing", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const marker = path.join(dir, "ran")
      yield* local("none")
      const tool = yield* shell().pipe(provideInstance(dir))
      const result = yield* withoutBwrap(() =>
        tool.execute({ command: `touch ${marker}` }, context()).pipe(provideInstance(dir), Effect.exit),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(String(Exit.isFailure(result) ? result.cause : "")).toContain("bubblewrap (bwrap) is not on PATH")
      expect(asked).toEqual([])
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
    }),
  )

  liveUnless(process.platform !== "win32")("on Windows a command runs and says it is not network-filtered", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* local("none")
      const tool = yield* shell().pipe(provideInstance(dir))
      const result = yield* tool.execute({ command: "echo windows" }, context()).pipe(provideInstance(dir))
      expect(result.output).toStartWith(`${Sandbox.WINDOWS_UNFILTERED}\n\n`)
      expect(result.metadata.sandbox).toBe(Sandbox.WINDOWS_UNFILTERED)
    }),
  )
})

describe("Sandbox.offline", () => {
  const input = (env: NodeJS.ProcessEnv = process.env) => ({
    shell: "/bin/sh",
    command: "true",
    cwd: os.tmpdir(),
    env,
    workspaceRoot: os.tmpdir(),
  })

  test("refuses a command on Linux without bwrap rather than running it unwrapped", () => {
    const refused = withoutBwrapSync(() => Sandbox.offline({ ...input(), platform: "linux" }))
    expect(refused).toEqual({
      type: "refused",
      message:
        "Vector did not run this command. With Web access None in Vector Local, commands run only inside Vector's sandbox, and bubblewrap (bwrap) is not on PATH, so no sandbox can be applied. Install bubblewrap (the bwrap command) to run commands, or change Web access in Vector Local.",
    })
    expect(withoutBwrapSync(() => Sandbox.offlineRefusal("linux"))).toBe(
      refused.type === "refused" ? refused.message : "",
    )
    // A platform with no sandbox at all is refused too.
    expect(Sandbox.offline({ ...input(), platform: "freebsd" }).type).toBe("refused")
  })

  test("runs a command on Windows as it is, saying it is not network-filtered", () => {
    expect(Sandbox.offline({ ...input(), platform: "win32" })).toEqual({
      type: "unfiltered",
      notice: Sandbox.WINDOWS_UNFILTERED,
    })
    expect(Sandbox.WINDOWS_UNFILTERED).toStartWith("Commands the agent runs are not network-filtered on Windows.")
    expect(Sandbox.offlineRefusal("win32")).toBeUndefined()
  })

  test.skipIf(!sandbox.supported)("wraps a command with no network and no proxy to carry it", () => {
    const decided = Sandbox.offline(
      input({
        PATH: process.env.PATH,
        HTTP_PROXY: "http://127.0.0.1:3128",
        https_proxy: "http://127.0.0.1:3128",
        ALL_PROXY: "socks5://127.0.0.1:1080",
        NO_PROXY: "localhost",
      }),
    )
    expect(decided.type).toBe("sandboxed")
    if (decided.type !== "sandboxed") return
    // A proxy on this computer is reachable from the sandbox, so a command gets none to send its requests through.
    expect(decided.wrapped.env).toEqual({ PATH: process.env.PATH, NO_PROXY: "localhost" })
    if (decided.wrapped.mechanism === "bubblewrap") expect(decided.wrapped.args).toContain("--unshare-net")
    if (decided.wrapped.mechanism === "seatbelt") expect(decided.wrapped.args[1]).toContain("(deny network*)")
  })

  test("the seatbelt profile with no network lets loopback through and nothing else", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/work"], denyRead: [], allowNetwork: false })
    const network = profile.split("\n").filter((line) => line.includes("network"))
    expect(network).toEqual([
      "(deny network*)",
      "(allow network* (local unix) (remote unix))",
      '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-bind network-inbound (local ip "localhost:*"))',
    ])
    // Under network*, a rule on the local address also let connections to other hosts out.
    expect(profile).not.toMatch(/\(allow network\* \(local ip/)
    expect(Sandbox.seatbeltProfile({ writable: ["/work"], denyRead: [], allowNetwork: true })).toContain(
      "(allow network*)\n",
    )
  })
})

// Runs with no bwrap on PATH, wherever this test runs: PATH names an empty folder until it is done.
function withoutBwrapSync<T>(run: () => T): T {
  const empty = mkdtempSync(path.join(os.tmpdir(), "vector-no-bwrap-"))
  const before = process.env.PATH
  process.env.PATH = empty
  try {
    return run()
  } finally {
    process.env.PATH = before
    rmSync(empty, { recursive: true, force: true })
  }
}

function withoutBwrap<A, E, R>(run: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const empty = mkdtempSync(path.join(os.tmpdir(), "vector-no-bwrap-"))
      const before = process.env.PATH
      process.env.PATH = empty
      return { empty, before }
    }),
    run,
    (state) =>
      Effect.sync(() => {
        process.env.PATH = state.before
        rmSync(state.empty, { recursive: true, force: true })
      }),
  )
}
