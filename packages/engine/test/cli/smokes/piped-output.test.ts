import { expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

// Far more than the link between the two stages holds (on Linux Bun's shell uses an AF_UNIX
// socketpair with about 208 KB of buffer; a pipe holds 64 KB), so most of the output is still queued
// in the CLI when the command finishes and the CLI reaches its exit.
const prompt = "x".repeat(512_000)

// The config travels in a file: Linux refuses to start a process whose environment holds a single
// variable over 128 KB. The file sits outside the project the CLI runs in, so it counts as the user's own.
const bigConfig = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vector-piped-output-"))
    const file = path.join(dir, "agent-settings.json")
    await Bun.write(file, JSON.stringify({ agent: { big: { prompt } } }))
    return { dir, env: { VECTOR_AGENT_CONFIG: file } }
  }),
  (config) => Effect.promise(() => rm(config.dir, { recursive: true, force: true })),
)

cliIt.live(
  "piped output larger than the pipe buffer all reaches a reader that starts late",
  ({ vector }) =>
    Effect.gen(function* () {
      // `vector debug config | (sleep 3; cat)`. Three seconds is past the CLI's startup on a fast
      // machine and inside the five seconds the CLI waits at exit for a pipe to drain.
      const config = yield* bigConfig
      const result = yield* vector.pipe(
        ["debug", "config"],
        [process.execPath, "-e", "await Bun.sleep(3000); await Bun.write(Bun.stdout, await Bun.stdin.bytes())"],
        { env: config.env },
      )
      vector.expectExit(result, 0, "vector debug config | late reader")
      expect(result.stdout.length).toBeGreaterThan(prompt.length)
      // The command prints JSON.stringify(config, null, 2) and a newline, so a complete copy reprints exactly.
      expect(result.stdout).toBe(JSON.stringify(JSON.parse(result.stdout), null, 2) + "\n")
      expect(JSON.parse(result.stdout).agent.big.prompt).toBe(prompt)
    }),
  60_000,
)

cliIt.live(
  "piped output to a reader that has already exited does not hold the CLI open",
  ({ vector }) =>
    Effect.gen(function* () {
      // `vector debug config | true`: the reader is gone before the CLI writes, so every write fails.
      // The pipeline only finishes once the CLI has exited too.
      const config = yield* bigConfig
      const result = yield* vector.pipe(["debug", "config"], [process.execPath, "-e", "process.exit(0)"], {
        env: config.env,
      })
      expect(result.timedOut).toBeFalsy()
      vector.expectExit(result, 0, "vector debug config | exited reader")
    }),
  60_000,
)
