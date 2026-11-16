import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Layer, Result } from "effect"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { Config } from "@vectordevai/core/config"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { Location } from "@vectordevai/core/location"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { Pty } from "@vectordevai/core/pty"
import { AbsolutePath } from "@vectordevai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const RECHECK = "Hands needs a fresh computer check before this terminal starts."

// requireIsolation() is process-global and one-way, so the cases run in a child Bun process of this same file.
if (process.env.VECTOR_TEST_PTY_REQUIRED_ISOLATION === "1") {
  ProcessIsolation.requireIsolation()
  const it = testEffect(
    AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
      [Config.node, Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })],
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(os.tmpdir()) }))),
      ],
    ]),
  )

  it.live("required isolation refuses this terminal's launch plan after a passing recheck", () =>
    Effect.gen(function* () {
      const terminal = yield* terminalInput
      const floor = launchFloor(terminal.input)
      if (Result.isSuccess(floor)) throw new Error("The launch floor must refuse a native loader environment.")
      const pty = yield* Pty.Service
      const order: string[] = []
      const result = yield* pty
        .create(
          terminal.input,
          undefined,
          Effect.sync(() => void order.push("before-spawn")),
        )
        .pipe(Effect.exit)
      expect(failure(result)).toBe(floor.failure)
      expect(order).toEqual(["before-spawn"])
      expect(yield* pty.list()).toEqual([])
      expect(yield* started(terminal.marker)).toBe(false)
    }),
  )

  // The previous case shows the launch plan refuses this terminal, so only a recheck that runs first can win here.
  it.live("S6-5: a recheck that dies reports its own message ahead of the launch floor", () =>
    Effect.gen(function* () {
      const terminal = yield* terminalInput
      const floor = launchFloor(terminal.input)
      if (Result.isSuccess(floor)) throw new Error("The launch floor must refuse a native loader environment.")
      const pty = yield* Pty.Service
      const order: string[] = []
      const result = yield* pty
        .create(
          terminal.input,
          undefined,
          Effect.gen(function* () {
            order.push("before-spawn")
            return yield* Effect.die(new Error(RECHECK))
          }),
        )
        .pipe(Effect.exit)
      const message = failure(result)
      expect(message).toBe(RECHECK)
      expect(message).not.toContain(ProcessIsolation.REFUSAL)
      expect(message).not.toContain(floor.failure)
      expect(order).toEqual(["before-spawn"])
      expect(yield* pty.list()).toEqual([])
      expect(yield* started(terminal.marker)).toBe(false)
    }),
  )
}

// Every PTY suite skips Windows (pty-session.test.ts, pty.test.ts, pty-read.test.ts). The child process skips this case.
test.skipIf(process.platform === "win32" || process.env.VECTOR_TEST_PTY_REQUIRED_ISOLATION === "1")(
  "required isolation runs a terminal's recheck before its launch plan",
  async () => {
    const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", import.meta.path], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...untrustedChildEnvironment(process.env), VECTOR_TEST_PTY_REQUIRED_ISOLATION: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stderr).toMatch(/\b2 pass\b/)
      expect(stderr).toContain(" 0 fail")
    } finally {
      clearTimeout(timer)
      child.kill("SIGKILL")
      await child.exited
    }
  },
  30_000,
)

// A terminal whose program would write a marker if it ever started. The loader variable makes the launch floor refuse
// it on every host once isolation is required.
const terminalInput = Effect.acquireRelease(
  Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "vector-pty-isolation-"))),
  (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
).pipe(
  Effect.map((directory) => {
    const marker = path.join(directory, "pty-started")
    return {
      marker,
      input: {
        command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'started')", marker],
        cwd: directory,
        env: { LD_PRELOAD: "refused-test-loader" },
      },
    }
  }),
)

// The launch floor's own decision for this terminal's argv and environment, as Pty.create asks it. Result.try keeps its
// synchronous refusal a value without a try/catch.
function launchFloor(input: { command: string; args: string[]; cwd: string; env: Record<string, string> }) {
  return Result.try({
    try: () =>
      ProcessIsolation.launch(input.command, input.args, {
        cwd: input.cwd,
        env: untrustedChildEnvironment(process.env, input.env),
      }),
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  })
}

function failure(exit: Exit.Exit<unknown>) {
  if (Exit.isSuccess(exit)) throw new Error("The terminal started under required isolation.")
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

function started(marker: string) {
  return Effect.promise(() => Bun.file(marker).exists())
}
