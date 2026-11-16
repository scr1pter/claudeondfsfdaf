import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawnSync } from "node:child_process"
import { readlinkSync } from "node:fs"
import { promisify } from "node:util"
import { Effect, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { OwnedProcess } from "@vectordevai/core/owned-process"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))
const execute = promisify(execFile)
const bounds = { grace: 200, kill: 800, drain: 300 }
const directory = Effect.acquireRelease(
  Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "vector-owned-process-"))),
  (value) => Effect.promise(() => fs.rm(value, { recursive: true, force: true })),
)

async function alive(pid: number) {
  const result = await execute("/bin/ps", ["-o", "stat=", "-p", String(pid)]).catch(() => undefined)
  return !!result?.stdout.trim() && !result.stdout.trim().startsWith("Z")
}

function waitFor(file: string) {
  return Effect.promise(async () => {
    const deadline = performance.now() + 5_000
    do {
      const text = await fs.readFile(file, "utf8").catch(() => undefined)
      if (text) return text
      await new Promise((resolve) => setTimeout(resolve, 10))
    } while (performance.now() < deadline)
    throw new Error(`The owned process did not publish ${path.basename(file)}`)
  })
}

describe.skipIf(process.platform === "win32")("owned POSIX command groups", () => {
  it.live("opting a background command in leaves the original foreground command unchanged", () =>
    Effect.gen(function* () {
      const command = ChildProcess.make(process.execPath, ["-e", ""], { stdin: "ignore" })
      const owned = OwnedProcess.command(command, bounds)
      expect(owned).not.toBe(command)
      expect(OwnedProcess.options(command)).toBeUndefined()
      expect(OwnedProcess.options(owned)).toEqual(bounds)
      const spawner = yield* ChildProcessSpawner
      const handle = yield* spawner.spawn(command)
      expect(OwnedProcess.get(handle)).toBeUndefined()
      expect(Number(yield* handle.exitCode)).toBe(0)
    }),
  )

  it.live("preserves buffered final output and the real successful leader exit", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      const handle = yield* spawner.spawn(
        OwnedProcess.command(
          ChildProcess.make(process.execPath, ["-e", 'process.stdout.write("final\\n".repeat(40_000))'], {
            stdin: "ignore",
          }),
          bounds,
        ),
      )
      const control = OwnedProcess.get(handle)!
      const output = yield* Stream.runFold(
        Stream.decodeText(handle.stdout),
        () => "",
        (all, part) => all + part,
      )
      const result = yield* Effect.promise(() => control.done)
      expect(output).toBe("final\n".repeat(40_000))
      expect(result).toMatchObject({ terminated: true, drained: true, exit: { code: 0, signal: null } })
      expect(Number(yield* handle.exitCode)).toBe(0)
    }),
  )

  for (const inherited of [true, false])
    it.live(
      `cleans a TERM-ignoring descendant after successful parent exit (${inherited ? "open" : "closed"} pipes)`,
      () =>
        Effect.gen(function* () {
          const dir = yield* directory
          const ready = path.join(dir, "child")
          const term = path.join(dir, "term")
          const child = `const fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(term)},'received'));fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`
          const script = `const fs=require('node:fs');const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:${inherited ? "'inherit'" : "'ignore'"}});p.unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(t);process.exit(0)}},5)`
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(
            OwnedProcess.command(ChildProcess.make(process.execPath, ["-e", script], { stdin: "ignore" }), bounds),
          )
          const output = yield* Stream.runDrain(handle.all).pipe(Effect.forkScoped)
          const pid = Number(yield* waitFor(ready))
          const control = OwnedProcess.get(handle)!
          expect((yield* Effect.promise(() => control.exited)).code).toBe(0)
          const result = yield* Effect.promise(() => control.done)
          yield* Fiber.join(output)
          expect(result.terminated).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(term, "utf8"))).toBe("received")
          expect(yield* Effect.promise(() => alive(pid))).toBe(false)
        }),
    )

  it.live("explicit stop escalates a TERM-ignoring live leader and remains idempotent", () =>
    Effect.gen(function* () {
      const dir = yield* directory
      const ready = path.join(dir, "ready")
      const script = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`
      const spawner = yield* ChildProcessSpawner
      const handle = yield* spawner.spawn(
        OwnedProcess.command(ChildProcess.make(process.execPath, ["-e", script], { stdin: "ignore" }), bounds),
      )
      yield* waitFor(ready)
      const control = OwnedProcess.get(handle)!
      const started = performance.now()
      const result = yield* Effect.promise(control.stop)
      expect(performance.now() - started).toBeLessThan(2_500)
      expect(result.terminated).toBe(true)
      expect(result.exit?.signal).toBe("SIGKILL")
      expect(yield* Effect.promise(control.stop)).toBe(result)
      expect(yield* Effect.promise(() => alive(control.pid))).toBe(false)
    }),
  )

  it.live("scope disposal joins the owned tree cleanup", () =>
    Effect.gen(function* () {
      const dir = yield* directory
      const ready = path.join(dir, "ready")
      let pid = 0
      yield* Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner
          const script = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`
          const handle = yield* spawner.spawn(
            OwnedProcess.command(ChildProcess.make(process.execPath, ["-e", script], { stdin: "ignore" }), bounds),
          )
          pid = Number(handle.pid)
          yield* waitFor(ready)
        }),
      )
      expect(yield* Effect.promise(() => alive(pid))).toBe(false)
    }),
  )

  it.live("a pipe outside the owned group cannot make close unbounded or fabricate termination proof", () =>
    Effect.gen(function* () {
      const dir = yield* directory
      const ready = path.join(dir, "escaped")
      const child = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`
      const script = `const fs=require('node:fs');const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit',detached:true});p.unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(t);process.exit(0)}},5)`
      const spawner = yield* ChildProcessSpawner
      const handle = yield* spawner.spawn(
        OwnedProcess.command(ChildProcess.make(process.execPath, ["-e", script], { stdin: "ignore" }), bounds),
      )
      const pid = Number(yield* waitFor(ready))
      // This deliberately escaped test child is ours, not a recovered PID; always clean it even on assertion failure.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(pid, "SIGKILL")
          } catch {}
        }),
      )
      const started = performance.now()
      const result = yield* Effect.promise(() => OwnedProcess.get(handle)!.done)
      expect(performance.now() - started).toBeLessThan(2_500)
      expect(result.terminated).toBe(false)
      expect(result.drained).toBe(false)
      expect(result.error).toContain("output")
      expect(yield* Effect.promise(() => alive(pid))).toBe(true)
    }),
  )
})

// The legacy bubblewrap floor is held off in this build (ProcessIsolation.FLOOR), so the plan it would launch is built
// with ProcessIsolation.decide. This runs where a usable root-owned bwrap exists (the Linux sandbox lanes) and is
// skipped elsewhere: macOS and Windows have no bubblewrap, and some Linux runners refuse its user namespace.
const bubblewrap = (() => {
  if (process.platform !== "linux") return false
  try {
    ProcessIsolation.assertBinary()
  } catch {
    return false
  }
  return (
    spawnSync(ProcessIsolation.BINARY, ProcessIsolation.argumentsForTool("/bin/true", [], os.tmpdir()), {
      stdio: "ignore",
      timeout: 10_000,
    }).status === 0
  )
})()

describe.skipIf(!bubblewrap)("owned POSIX command groups under the legacy bubblewrap floor", () => {
  // Spawn review S4-2: the owner is the outermost layer and isolation sits inside it.
  it.live("an isolated background command stays owned, and stopping it ends its whole tree", () =>
    Effect.gen(function* () {
      const dir = yield* directory
      // Unique sleep durations are the canaries: a host-side scan finds them by argv, inside or outside the group.
      const token = `${process.pid}${Math.floor(performance.now())}`
      const canaries = () =>
        Effect.promise(async () => {
          const result = await execute("/bin/ps", ["-A", "-o", "pid=,stat=,args="])
          return result.stdout
            .split("\n")
            .map((row) => row.trim().split(/\s+/))
            .filter((row) => !row[1]?.startsWith("Z") && row.slice(2).join(" ").startsWith(`sleep 600.${token}`))
            .map((row) => Number(row[0]))
        })
      const plan = ProcessIsolation.decide(
        "/bin/sh",
        ["-c", `sleep 600.${token}1 & setsid sleep 600.${token}2 & wait`],
        { cwd: dir },
        { guarded: true, floor: true },
      )
      expect(plan.file).toBe(ProcessIsolation.BINARY)
      const spawner = yield* ChildProcessSpawner
      const handle = yield* spawner.spawn(
        OwnedProcess.command(ChildProcess.make(plan.file, plan.args, { cwd: dir, stdin: "ignore" }), bounds),
      )
      // Never leak a canary, even when an assertion below fails.
      yield* Effect.addFinalizer(() =>
        canaries().pipe(
          Effect.map((pids) =>
            pids.forEach((pid) => {
              try {
                process.kill(pid, "SIGKILL")
              } catch {}
            }),
          ),
        ),
      )
      const control = OwnedProcess.get(handle)
      expect(control).toBeDefined()
      // Ownership is keyed by the caller's command: the owned leader is bwrap itself, not the payload inside it.
      expect(control?.pid).toBe(Number(handle.pid))
      expect(readlinkSync(`/proc/${handle.pid}/exe`)).toBe(ProcessIsolation.BINARY)
      const started = performance.now()
      while ((yield* canaries()).length < 2) {
        if (performance.now() - started > 5_000) throw new Error("The isolated command did not start both canaries")
        yield* Effect.sleep("20 millis")
      }
      const result = yield* Effect.promise(control!.stop)
      expect(result.terminated).toBe(true)
      // The setsid canary left the process group, but not bwrap's PID namespace, which ends with the owned leader.
      const deadline = performance.now() + 2_000
      while ((yield* canaries()).length > 0 && performance.now() < deadline) yield* Effect.sleep("20 millis")
      expect(yield* canaries()).toEqual([])
      expect(yield* Effect.promise(() => alive(control!.pid))).toBe(false)
    }),
  )
})
