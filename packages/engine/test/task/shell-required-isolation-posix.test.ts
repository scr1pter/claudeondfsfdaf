import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { fileURLToPath } from "node:url"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { ProviderV2 } from "@vectordevai/core/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { ShellJobs } from "@/task/shells"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

afterEach(disposeAllInstances)

const running = (pid: number) => {
  const state = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
  // A reparented zombie has stopped executing even when this container's PID 1 has not reaped it yet.
  return state.status === 0 && !!state.stdout.trim() && !state.stdout.trim().startsWith("Z")
}

// Exercise the irreversible production switch in a child, without affecting later tests in the shard.
if (process.env.VECTOR_TEST_SHELL_REQUIRED_ISOLATION_POSIX === "1") {
  ProcessIsolation.requireIsolation()
  const fx = testEffect(
    LayerNode.compile(LayerNode.group([ShellJobs.node, Session.node, BackgroundJobStore.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer({ backgroundSubagents: true, noteQuietMs: 20, noteHoldMs: 100 })],
    ]),
  )
  // Spawn review S4-2 at the ShellJobs level. The bubblewrap floor is held off in this build (ProcessIsolation.FLOOR),
  // so required isolation launches the payload directly; it must still be owned, and Stop must end its whole group.
  fx.instance("an owned background shell under required isolation is stopped with its whole group", () =>
    Effect.gen(function* () {
      expect(ProcessIsolation.required()).toBe(true)
      const sessions = yield* Session.Service
      const shells = yield* ShellJobs.Service
      const store = yield* BackgroundJobStore.Service
      const { directory } = yield* TestInstance
      const session = yield* sessions.create({ title: "Synthetic required isolation background shell" })
      const pidfile = path.join(directory, "child.pid")
      const shell = yield* shells.start({
        sessionID: session.id,
        command: "sleep in the background, then wait",
        process: ChildProcess.make("/bin/sh", ["-c", `sleep 300 & echo $! > '${pidfile}'; wait`], {
          detached: true,
          stdin: "ignore",
        }),
        agent: "build",
        ops: {
          cancel: () => Effect.void,
          resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
          // The stop note is recorded as a reply that starts no model request.
          prompt: (input) =>
            Effect.succeed({
              info: {
                id: MessageID.ascending(),
                role: "assistant" as const,
                parentID: input.messageID ?? MessageID.ascending(),
                sessionID: input.sessionID,
                agent: "build",
                mode: "build",
                cost: 0,
                path: { cwd: directory, root: directory },
                modelID: ModelV2.ID.make("fixture"),
                providerID: ProviderV2.ID.make("local-test"),
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: Date.now() },
              },
              parts: [],
            }),
        },
      })
      const child = yield* pollWithTimeout(
        Effect.promise(() =>
          fs
            .readFile(pidfile, "utf8")
            .then((text) => Number.parseInt(text.trim(), 10))
            .catch(() => Number.NaN),
        ).pipe(Effect.map((pid) => (Number.isSafeInteger(pid) && pid > 0 ? pid : undefined))),
        "the command must write its child's pid",
        "10 seconds",
      )
      // Never leak the group member, even when an assertion below fails.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(child, "SIGKILL")
          } catch {}
        }),
      )
      expect(running(child)).toBe(true)
      expect(yield* shells.stop(shell.id)).toMatchObject({ id: shell.id, status: "stopped" })
      yield* pollWithTimeout(
        Effect.sync(() => (running(child) ? undefined : true)),
        "the command's own child must be killed with it",
        "10 seconds",
      )
      const [row] = yield* store.forParent(session.id)
      expect(row?.metadata?.cleanup).toBe("confirmed")
      expect(yield* shells.full(session.id)).toBe(false)
      console.log("POSIX_BACKGROUND_ISOLATION_OWNED_AND_STOPPED")
    }),
  )
} else {
  // Linux only: with isolation required, every spawn off Linux is refused before it starts (ProcessIsolation.decide).
  test.skipIf(process.platform !== "linux")(
    "an owned background shell keeps its ownership and group stop under required isolation",
    async () => {
      const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, VECTOR_TEST_SHELL_REQUIRED_ISOLATION_POSIX: "1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill(), 40_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect({ code, stderr }).toMatchObject({ code: 0 })
        expect(stdout).toContain("POSIX_BACKGROUND_ISOLATION_OWNED_AND_STOPPED")
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill()
      }
    },
    45_000,
  )
}
