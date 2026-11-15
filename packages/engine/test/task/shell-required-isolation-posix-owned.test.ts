import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { ShellJobs } from "@/task/shells"
import type { TaskPromptOps } from "@/tool/task"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// SPAWN-1, POSIX half: an owned background command under required isolation, stopped through ShellJobs. With the
// bubblewrap floor off, the plain owned process group is the only signaler and the engine reads the host /proc.

afterEach(disposeAllInstances)

const FLAG = "VECTOR_TEST_SHELL_REQUIRED_ISOLATION_POSIX"
// Set by the parent on a GitHub-hosted runner, whose PID 1 reaps orphans, so a stopped sleeper must end as ESRCH there.
const REAPING = "VECTOR_TEST_SHELL_REQUIRED_ISOLATION_POSIX_REAPING"
const reaping = process.env[REAPING] === "1"
const MARKER = "POSIX_OWNED_BACKGROUND_CLEANUP_CONFIRMED_UNDER_REQUIRED_ISOLATION"
// ShellJobs passes no bounds, so OwnedProcess uses its defaults (packages/core/src/owned-process.ts:131, 134).
const GRACE = 3_000
const KILL = 3_000

// Exercise the irreversible production switch in a child, without affecting later tests in the shard.
if (process.env[FLAG] === "1") {
  ProcessIsolation.requireIsolation()
  const fx = testEffect(
    LayerNode.compile(LayerNode.group([ShellJobs.node, Session.node, BackgroundJobStore.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer({ backgroundSubagents: true })],
    ]),
  )
  // The notes TaskNotify delivers. A stopped command is reported quietly and never starts a model turn.
  const notes: SessionPrompt.PromptInput[] = []
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
    prompt: (input) =>
      Effect.sync(() => {
        notes.push(input)
        return reply(input)
      }),
  }

  fx.instance(
    "a stopped owned background group under required isolation ends with confirmed cleanup and a released slot",
    () =>
      Effect.gen(function* () {
        // The premise, and a tripwire for C9: with the floor or a native build the pids below would not be the host's.
        expect(ProcessIsolation.required()).toBe(true)
        expect(ProcessIsolation.FLOOR).toBe(false)
        expect(ProcessIsolation.nativeBuild().enabled).toBe(false)
        // The guarded launch branch is live here: it refuses a loader variable and otherwise adds no wrapper.
        expect(() => ProcessIsolation.launch("/bin/true", [], { env: { LD_PRELOAD: "x" } })).toThrow(
          "GitHub agent tools cannot set a native loader environment.",
        )
        expect(ProcessIsolation.launch("/bin/true", [], { env: { PATH: "/usr/bin:/bin" } })).toEqual({
          file: "/bin/true",
          args: [],
          shell: undefined,
        })

        const sessions = yield* Session.Service
        const shells = yield* ShellJobs.Service
        const store = yield* BackgroundJobStore.Service
        const session = yield* sessions.create({ title: "Synthetic POSIX isolation cleanup" })
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "vector-owned-isolation-"))),
          (made) => Effect.promise(() => fs.rm(made, { recursive: true, force: true })),
        )
        const files = [path.join(directory, "a.pid"), path.join(directory, "b.pid")]
        // The shell and both sleepers ignore SIGTERM, so only the group SIGKILL after the grace period ends them.
        const shell = yield* shells.start({
          sessionID: session.id,
          command: "two TERM-ignoring sleepers",
          process: ChildProcess.make(
            "/bin/sh",
            ["-c", `trap "" TERM; sleep 600 & echo $! > '${files[0]}'; sleep 600 & echo $! > '${files[1]}'; wait`],
            { detached: true, stdin: "ignore" },
          ),
          agent: "build",
          ops,
        })
        const leader = Number((yield* store.forParent(session.id)).find((row) => row.id === shell.id)?.metadata?.pid)
        expect(Number.isSafeInteger(leader) && leader > 1).toBe(true)
        const pids = yield* Effect.forEach(files, readPid)
        // Only a sleeper still running in this group is killed here; a pid reused by another process is left alone.
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            pids,
            (pid) =>
              Effect.promise(() => stat(pid)).pipe(
                Effect.flatMap((found) =>
                  found?.pgrp === leader && found.state !== "Z"
                    ? Effect.try({ try: () => process.kill(pid, "SIGKILL"), catch: () => undefined }).pipe(
                        Effect.ignore,
                      )
                    : Effect.void,
                ),
              ),
            { discard: true },
          ),
        )
        // Both sleepers are the shell's children in the shell's own group: no bwrap or guardian sits in between.
        const geometry = yield* Effect.forEach(pids, (pid) => Effect.promise(() => stat(pid)))
        expect(geometry).toEqual(pids.map(() => expect.objectContaining({ ppid: leader, pgrp: leader })))
        expect(geometry.every((found) => found?.state !== "Z")).toBe(true)

        // Fill the conversation, so the released slot is visible while the other commands still run. Each filler is
        // stopped when this inner scope closes, before the listing below.
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forEach(
              Array.from({ length: ShellJobs.LIMIT - 1 }),
              () =>
                shells
                  .start({
                    sessionID: session.id,
                    command: "sleep",
                    process: ChildProcess.make("sleep", ["600"], { detached: true, stdin: "ignore" }),
                    agent: "build",
                    ops,
                  })
                  .pipe(Effect.tap((filler) => Effect.addFinalizer(() => Effect.asVoid(shells.stop(filler.id))))),
              { discard: true },
            )
            expect(yield* shells.full(session.id)).toBe(true)

            const started = performance.now()
            const stopped = yield* shells.stop(shell.id)
            const elapsed = performance.now() - started
            // Task.Shell has no cleanup field. Its "stopped" is the stop result's half of the proof, because the shape
            // reports unknown or pending cleanup as "failed"; the row's cleanup is asserted below.
            expect(stopped).toMatchObject({ id: shell.id, status: "stopped" })
            expect(stopped?.exitCode).toBeUndefined()
            // SIGTERM was ignored, so the kill phase ran, and the whole stop finished within grace plus kill.
            expect(elapsed).toBeGreaterThanOrEqual(GRACE - 100)
            expect(elapsed).toBeLessThan(GRACE + KILL)
            const row = (yield* store.forParent(session.id)).find((item) => item.id === shell.id)
            expect(row?.metadata?.cleanup).toBe("confirmed")
            const ended = yield* Effect.forEach(pids, (pid) =>
              reaping ? reaped(pid, leader) : Effect.promise(() => outcome(pid, leader)),
            )
            expect(ended).toEqual(pids.map(() => expect.stringMatching(/^(ESRCH|Z)$/)))
            expect(yield* shells.full(session.id)).toBe(false)
            return { elapsed: Math.round(elapsed), reaping, ended }
          }),
        )

        const listed = yield* shells.list(session.id)
        expect(listed.filter((item) => item.status === "running")).toEqual([])
        expect(listed.find((item) => item.id === shell.id)).toMatchObject({ status: "stopped" })
        expect(yield* shells.full(session.id)).toBe(false)
        const note = yield* pollWithTimeout(
          Effect.sync(() =>
            notes.find((input) =>
              input.parts.some(
                (part) =>
                  part.type === "text" &&
                  (part.metadata?.shellNotification as { shellID?: string } | undefined)?.shellID === shell.id,
              ),
            ),
          ),
          "the stopped command's note must reach its session",
          "10 seconds",
        )
        expect(note.noReply).toBe(true)
        expect(
          (yield* store.forParent(session.id)).find((item) => item.id === shell.id)?.metadata?.ended,
        ).toMatchObject({ state: "stopped" })
        console.log(`${MARKER} ${JSON.stringify(result)}`)
      }),
    30_000,
  )
} else {
  test.skipIf(process.platform !== "linux")(
    "owned background cleanup is confirmed under required isolation (Linux)",
    async () => {
      const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", import.meta.path], {
        // The package directory, so the child gets the same bunfig preloads.
        cwd: path.join(import.meta.dir, "..", ".."),
        // A fixed minimal environment: no inherited loader or runtime option variable reaches the guarded launch. The
        // engine shard sets GITHUB_ACTIONS=false, so the runner is recognised by RUNNER_ENVIRONMENT.
        env: {
          PATH: "/usr/bin:/bin",
          [FLAG]: "1",
          ...(process.env.RUNNER_ENVIRONMENT === "github-hosted" ? { [REAPING]: "1" } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 50_000,
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, stderr }).toMatchObject({ code: 0 })
      expect(stdout).toContain(MARKER)
      // The evidence line: the stop's duration, whether strict reaping applied and how each sleeper ended on this host.
      console.log(stdout.split("\n").find((line) => line.startsWith(MARKER)))
    },
    60_000,
  )
}

function reply(input: SessionPrompt.PromptInput): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      agent: "build",
      mode: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      modelID: ModelV2.ID.make("fixture"),
      providerID: ProviderV2.ID.make("local-test"),
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
    },
    parts: [],
  }
}

const readPid = (file: string) =>
  pollWithTimeout(
    Effect.promise(() =>
      fs
        .readFile(file, "utf8")
        // `echo` writes the digits and a newline once; anything else is a partial write, read again.
        .then((text) => (/^\d+\n$/.test(text) ? Number(text) : Number.NaN))
        .catch(() => Number.NaN),
    ).pipe(Effect.map((pid) => (Number.isSafeInteger(pid) && pid > 0 ? pid : undefined))),
    "the command must write each sleeper's pid",
    "10 seconds",
  )

function probe(pid: number) {
  try {
    process.kill(pid, 0)
    return "exists"
  } catch (error) {
    return (error as NodeJS.ErrnoException).code
  }
}

// State, parent and process group from the host /proc, read after the command name so a space in it cannot shift them.
async function stat(pid: number) {
  const text = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined)
  if (!text) return undefined
  const [state, ppid, pgrp] = text.slice(text.lastIndexOf(")") + 2).split(" ")
  return { state, ppid: Number(ppid), pgrp: Number(pgrp) }
}

// How a stopped sleeper ended: gone, or, off a reaping host, a dead zombie already reparented away from its shell and
// waiting for a reaper (a container whose PID 1 reaps late or never). Anything else is returned as it was found, so
// the assertion names it.
async function outcome(pid: number, leader: number) {
  if (probe(pid) === "ESRCH") return "ESRCH"
  const found = await stat(pid)
  if (!found) return "ESRCH"
  if (!reaping && found.state === "Z" && found.ppid !== leader && found.pgrp === leader) return "Z"
  return JSON.stringify(found)
}

// On a reaping host a stopped sleeper must be gone within 2 s. Otherwise its last state is returned, so the assertion
// names it.
const reaped = (pid: number, leader: number) =>
  pollWithTimeout(
    Effect.promise(() => outcome(pid, leader)).pipe(Effect.map((found) => (found === "ESRCH" ? found : undefined))),
    `sleeper ${pid} was not reaped within 2 seconds`,
    "2 seconds",
  ).pipe(Effect.catch(() => Effect.promise(() => outcome(pid, leader))))
