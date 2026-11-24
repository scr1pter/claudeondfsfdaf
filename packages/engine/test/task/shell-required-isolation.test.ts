import { afterEach, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { fileURLToPath } from "node:url"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { ShellJobs } from "@/task/shells"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(disposeAllInstances)

// Exercise the irreversible production switch in a child, without affecting later tests in the shard. Each case runs in
// a child of its own ("1", "before-recheck"), so neither stretches the other's child or parent budget.
const mode = process.env.VECTOR_TEST_SHELL_REQUIRED_ISOLATION
if (mode === "1") {
  ProcessIsolation.requireIsolation()
  const fx = testEffect(
    LayerNode.compile(LayerNode.group([ShellJobs.node, Session.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer({ backgroundSubagents: true })],
    ]),
  )
  fx.instance("a Windows holder refuses required isolation before writing a job", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const shells = yield* ShellJobs.Service
      const session = yield* sessions.create({ title: "Synthetic Windows isolation admission" })
      const result = yield* shells
        .start({
          sessionID: session.id,
          command: "synthetic no-op",
          process: ChildProcess.make(process.execPath, ["-e", "process.exit(0)"], { stdin: "ignore" }),
          agent: "build",
          ops: {
            cancel: () => Effect.void,
            resolvePromptParts: () => Effect.succeed([]),
            prompt: () => Effect.die(new Error("A refused command must never notify a model.")),
          },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isSuccess(result)) throw new Error("The required boundary was bypassed.")
      expect(String(Cause.squash(result.cause))).toContain(ProcessIsolation.REFUSAL)
      expect(yield* shells.list(session.id)).toEqual([])
      expect(yield* shells.full(session.id)).toBe(false)
      console.log("WINDOWS_BACKGROUND_ISOLATION_REFUSED_WITHOUT_JOB")
    }),
  )
} else if (mode === "before-recheck") {
  ProcessIsolation.requireIsolation()
  const fx = testEffect(
    LayerNode.compile(LayerNode.group([ShellJobs.node, Session.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer({ backgroundSubagents: true })],
    ]),
  )
  // Spawn review S6-5: on Windows the isolation refusal wins by design (shells.ts isolationRefusal, at admission), so a
  // recheck that would itself fail never runs and its failure never becomes the cause.
  fx.instance("a Windows holder refuses required isolation before the authority recheck runs", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const shells = yield* ShellJobs.Service
      const session = yield* sessions.create({ title: "Synthetic Windows isolation before recheck" })
      const ran: string[] = []
      const result = yield* shells
        .start({
          sessionID: session.id,
          command: "synthetic no-op",
          process: ChildProcess.make(process.execPath, ["-e", "process.exit(0)"], { stdin: "ignore" }),
          agent: "build",
          ops: {
            cancel: () => Effect.void,
            resolvePromptParts: () => Effect.succeed([]),
            prompt: () => Effect.die(new Error("A refused command must never notify a model.")),
          },
          beforeSpawn: Effect.suspend(() => {
            ran.push("recheck")
            return Effect.die(new Error("The recheck must not run under the refusal."))
          }),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isSuccess(result)) throw new Error("The required boundary was bypassed.")
      expect(String(Cause.squash(result.cause))).toContain(ProcessIsolation.REFUSAL)
      expect(ran).toEqual([])
      expect(yield* shells.list(session.id)).toEqual([])
      expect(yield* shells.full(session.id)).toBe(false)
      console.log("WINDOWS_BACKGROUND_REFUSAL_BEFORE_RECHECK")
    }),
  )
} else {
  test.skipIf(process.platform !== "win32")(
    "Windows background admission cannot bypass required tool isolation",
    async () => {
      const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, VECTOR_TEST_SHELL_REQUIRED_ISOLATION: "1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill(), 25_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect({ code, stderr }).toMatchObject({ code: 0 })
        expect(stdout).toContain("WINDOWS_BACKGROUND_ISOLATION_REFUSED_WITHOUT_JOB")
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill()
      }
    },
    30_000,
  )

  test.skipIf(process.platform !== "win32")(
    "Windows background admission refuses required isolation before the authority recheck",
    async () => {
      const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, VECTOR_TEST_SHELL_REQUIRED_ISOLATION: "before-recheck" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill(), 25_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect({ code, stderr }).toMatchObject({ code: 0 })
        expect(stdout).toContain("WINDOWS_BACKGROUND_REFUSAL_BEFORE_RECHECK")
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill()
      }
    },
    30_000,
  )
}
