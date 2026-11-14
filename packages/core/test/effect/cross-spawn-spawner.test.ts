import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import childProcess, { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { testEffect } from "../lib/effect"

const live = LayerNode.compile(CrossSpawnSpawner.node)
const fx = testEffect(live)

function js(code: string, opts?: ChildProcess.CommandOptions) {
  return ChildProcess.make("node", ["-e", code], opts)
}

function stdoutEofCommand(pid: string) {
  const close =
    process.platform === "win32"
      ? `const native = require("bun:ffi").dlopen("kernel32.dll", {
  GetStdHandle: { args: ["u32"], returns: "u64" },
  CloseHandle: { args: ["u64"], returns: "i32" },
});
const stdout = native.symbols.GetStdHandle(0xfffffff5);
if (stdout === 0n || stdout === 0xffffffffffffffffn) throw new Error("No stdout handle");
if (native.symbols.CloseHandle(stdout) === 0) throw new Error("CloseHandle(stdout) failed");`
      : "fs.closeSync(1);"
  // Node's Windows libuv deliberately ignores fs.closeSync on fd 0-2. Close the
  // actual standard handle without opening a wrapper that duplicates it.
  // https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/win/fs.c#L649-L675
  const code = `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid));
fs.writeSync(1, "stdout-closed\\n");
${close}
fs.writeSync(2, "stderr-open\\n");
setInterval(() => {}, 1000);`
  return ChildProcess.make(
    process.platform === "win32" ? process.execPath : "node",
    process.platform === "win32" ? ["--no-env-file", "-e", code] : ["-e", code],
    { forceKillAfter: "100 millis" },
  )
}

function decodeByteStream(stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) {
  return Stream.runCollect(stream).pipe(
    Effect.map((chunks) => {
      const total = chunks.reduce((acc, x) => acc + x.length, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const chunk of chunks) {
        out.set(chunk, off)
        off += chunk.length
      }
      return new TextDecoder("utf-8").decode(out).trim()
    }),
  )
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vector-core-test-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function gone(pid: number, timeout = 5_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

describe("cross-spawn spawner", () => {
  describe("basic spawning", () => {
    fx.live(
      "fixture produces stdout EOF while the same child and stderr remain open",
      Effect.promise(async () => {
        await using tmp = await tmpdir()
        const command = stdoutEofCommand(path.join(tmp.path, "pid"))
        const child = spawn(command.command, command.args, {
          stdio: [
            "ignore",
            process.platform === "win32" ? "overlapped" : "pipe",
            process.platform === "win32" ? "overlapped" : "pipe",
          ],
          windowsHide: true,
        })
        const state = {
          stdout: "",
          stderr: "",
          stdoutEnded: false,
          stderrEnded: false,
          exited: false,
        }
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
        const ready = Promise.withResolvers<void>()
        const check = () => {
          if (state.stdoutEnded && state.stderr === "stderr-open\n") ready.resolve()
        }
        child.once("error", ready.reject)
        child.once("exit", () => {
          state.exited = true
        })
        child.stdout!.on("data", (chunk) => {
          state.stdout += chunk.toString()
        })
        child.stdout!.once("end", () => {
          state.stdoutEnded = true
          check()
        })
        child.stderr!.on("data", (chunk) => {
          state.stderr += chunk.toString()
          check()
        })
        child.stderr!.once("end", () => {
          state.stderrEnded = true
        })
        const timer = setTimeout(
          () => ready.reject(new Error(`Native stdout EOF fixture did not close: ${JSON.stringify(state)}`)),
          5_000,
        )
        try {
          await ready.promise
          expect(state.stdout).toBe("stdout-closed\n")
          expect(state.stderr).toBe("stderr-open\n")
          expect(state.stdoutEnded).toBe(true)
          expect(state.stderrEnded).toBe(false)
          expect(state.exited).toBe(false)
          expect(child.exitCode).toBeNull()
          expect(Number(await Bun.file(path.join(tmp.path, "pid")).text())).toBe(child.pid!)
          expect(alive(child.pid!)).toBe(true)
        } finally {
          clearTimeout(timer)
          child.kill("SIGKILL")
          const cleanup = Promise.withResolvers<never>()
          const deadline = setTimeout(
            () => cleanup.reject(new Error("Native stdout EOF fixture child did not close after kill")),
            2_000,
          )
          try {
            await Promise.race([closed, cleanup.promise])
          } finally {
            clearTimeout(deadline)
          }
        }
        expect(await gone(child.pid!)).toBe(true)
      }),
      10_000,
    )

    fx.live(
      "collection helpers finish at stdout EOF and reap a child with stderr still open",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const pid = path.join(tmp.path, "pid")
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const output = yield* spawner.string(stdoutEofCommand(pid)).pipe(Effect.timeout("5 seconds"))
        expect(output).toBe("stdout-closed\n")
        const child = Number(yield* Effect.promise(() => Bun.file(pid).text()))
        expect(yield* Effect.promise(() => gone(child))).toBe(true)
      }),
      10_000,
    )

    fx.live(
      "collection helpers retain both channels when includeStderr is selected",
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const output = yield* spawner.string(
          ChildProcess.make(process.execPath, [
            "--no-env-file",
            "-e",
            'process.stdout.write("included-stdout\\n"); process.stderr.write("included-stderr\\n")',
          ]),
          { includeStderr: true },
        )
        expect(output).toContain("included-stdout\n")
        expect(output).toContain("included-stderr\n")
      }),
    )

    for (const method of ["exitCode", "string", "lines"] as const) {
      fx.live(
        `${method} drains ignored output without blocking a write-completed child`,
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const command = ChildProcess.make(process.execPath, [
            "--no-env-file",
            "-e",
            `await new Promise((resolve, reject) => process.stderr.write("y".repeat(16777216), error => error ? reject(error) : resolve()))
await new Promise((resolve, reject) => process.stdout.write(${method === "exitCode" ? '"x".repeat(16777216)' : '"first\\nlast\\n"'}, error => error ? reject(error) : resolve()))`,
          ])
          if (method === "exitCode") {
            expect(yield* spawner.exitCode(command).pipe(Effect.timeout("5 seconds"))).toBe(
              ChildProcessSpawner.ExitCode(0),
            )
            return
          }
          if (method === "string") {
            expect(yield* spawner.string(command).pipe(Effect.timeout("5 seconds"))).toBe("first\nlast\n")
            return
          }
          expect(yield* spawner.lines(command).pipe(Effect.timeout("5 seconds"))).toEqual(["first", "last"])
        }),
        10_000,
      )
    }

    for (const combined of [false, true]) {
      fx.live(
        `retains ${combined ? "combined" : "separate"} output until consumers attach after process close`,
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make(process.execPath, [
            "--no-env-file",
            "-e",
            'process.stdout.write("held-stdout\\n"); process.stderr.write("held-stderr\\n")',
          ])
          // The real native close must precede the first Effect stream subscription.
          expect(yield* handle.exitCode).toBe(ChildProcessSpawner.ExitCode(0))
          expect(yield* handle.isRunning).toBe(false)
          if (combined) {
            const output = yield* decodeByteStream(handle.all)
            expect(output).toContain("held-stdout")
            expect(output).toContain("held-stderr")
            return
          }
          const output = yield* Effect.all([decodeByteStream(handle.stdout), decodeByteStream(handle.stderr)], {
            concurrency: 2,
          })
          expect(output).toEqual(["held-stdout", "held-stderr"])
        }),
      )
    }

    fx.effect(
      "captures stdout",
      Effect.gen(function* () {
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(ChildProcess.make(process.execPath, ["-e", 'process.stdout.write("ok")'])),
        )
        expect(out).toBe("ok")
      }),
    )

    fx.effect(
      "captures multiple lines",
      Effect.gen(function* () {
        const handle = yield* js('console.log("line1"); console.log("line2"); console.log("line3")')
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("line1\nline2\nline3")
      }),
    )

    fx.effect(
      "returns exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(0)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )

    fx.effect(
      "returns non-zero exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(42)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(42))
      }),
    )
  })

  describe("cwd option", () => {
    fx.effect(
      "uses cwd when spawning commands",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: tmp.path }),
          ),
        )
        expect(yield* Effect.promise(() => fs.realpath(out))).toBe(yield* Effect.promise(() => fs.realpath(tmp.path)))
      }),
    )

    fx.effect(
      "fails for invalid cwd",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
            svc.spawn(ChildProcess.make("echo", ["test"], { cwd: "/nonexistent/directory/path" })),
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  describe("env option", () => {
    fx.effect(
      "passes environment variables with extendEnv",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write(process.env.TEST_VAR ?? "")', {
          env: { TEST_VAR: "test_value" },
          extendEnv: true,
        })
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("test_value")
      }),
    )

    fx.effect(
      "passes multiple environment variables",
      Effect.gen(function* () {
        const handle = yield* js(
          "process.stdout.write(`${process.env.VAR1}-${process.env.VAR2}-${process.env.VAR3}`)",
          {
            env: { VAR1: "one", VAR2: "two", VAR3: "three" },
            extendEnv: true,
          },
        )
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("one-two-three")
      }),
    )
  })

  describe("stderr", () => {
    fx.effect(
      "captures stderr output",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error message")')
        const err = yield* decodeByteStream(handle.stderr)
        expect(err).toBe("error message")
      }),
    )

    fx.effect(
      "captures both stdout and stderr",
      Effect.gen(function* () {
        const handle = yield* js(
          [
            "let pending = 2",
            "const done = () => {",
            "  pending -= 1",
            "  if (pending === 0) setTimeout(() => process.exit(0), 0)",
            "}",
            'process.stdout.write("stdout\\n", done)',
            'process.stderr.write("stderr\\n", done)',
          ].join("\n"),
        )
        const [stdout, stderr] = yield* Effect.all([decodeByteStream(handle.stdout), decodeByteStream(handle.stderr)], {
          concurrency: 2,
        })
        expect(stdout).toBe("stdout")
        expect(stderr).toBe("stderr")
      }),
    )
  })

  describe("combined output (all)", () => {
    fx.effect(
      "captures stdout via .all when no stderr",
      Effect.gen(function* () {
        const handle = yield* js("console.log('hello from stdout')")
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stdout")
      }),
    )

    fx.effect(
      "captures stderr via .all when no stdout",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("hello from stderr")')
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stderr")
      }),
    )
  })

  describe("stdin", () => {
    fx.effect(
      "allows providing standard input to a command",
      Effect.gen(function* () {
        const input = "a b c"
        const stdin = Stream.make(Buffer.from(input, "utf-8"))
        const handle = yield* js(
          'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
          { stdin },
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("a b c")
      }),
    )
  })

  describe("process control", () => {
    fx.live(
      "scope exit reaps a process with unread backpressured output",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const ready = path.join(tmp.path, "ready")
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* ChildProcess.make(
              process.execPath,
              [
                "--no-env-file",
                "-e",
                `process.stdout.write("x".repeat(262144)); process.stderr.write("y".repeat(262144)); await Bun.write(${JSON.stringify(ready)}, "ready"); setInterval(() => {}, 1000)`,
              ],
              { forceKillAfter: "100 millis" },
            )
            yield* Effect.promise(async () => {
              while (!(await Bun.file(ready).exists())) await Bun.sleep(5)
            }).pipe(Effect.timeout("2 seconds"))
            return Number(handle.pid)
          }),
        )
        expect(yield* Effect.promise(() => gone(pid))).toBe(true)
      }),
    )

    fx.effect(
      "kills a running process",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js("setTimeout(() => {}, 10_000)")
            yield* handle.kill()
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "kills a child when scope exits",
      Effect.gen(function* () {
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* js("setInterval(() => {}, 10_000)")
            return Number(handle.pid)
          }),
        )
        const done = yield* Effect.promise(() => gone(pid))
        expect(done).toBe(true)
      }),
    )

    fx.effect(
      "forceKillAfter escalates for stubborn processes",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const started = Date.now()
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js('process.on("SIGTERM", () => {}); setInterval(() => {}, 10_000)')
            yield* handle.kill({ forceKillAfter: 100 })
            return yield* handle.exitCode
          }),
        )

        expect(Date.now() - started).toBeLessThan(1_000)
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "isRunning reflects process state",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("done")')
        yield* handle.exitCode
        const running = yield* handle.isRunning
        expect(running).toBe(false)
      }),
    )
  })

  describe("error handling", () => {
    fx.effect(
      "fails for invalid command",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* ChildProcess.make("nonexistent-command-12345")
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    // On Windows cross-spawn reports exit status 1 from a command it did not resolve itself, which is every command
    // run under a shell (cmd's `dir *.log` finding nothing, a failing test run), as ENOENT: the child emits error in
    // place of exit. Every child spawned here does the same, so the spawner meets it on any platform. The child exits
    // while a process it started still holds its output open, so the error always arrives before the output ends. That
    // process is detached: on Windows libuv kills a child that is not when its parent exits.
    fx.live(
      "keeps the output and exit status of a child whose exit is reported as an error",
      Effect.gen(function* () {
        const proto = childProcess.ChildProcess.prototype
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const own = Object.getOwnPropertyDescriptor(proto, "emit")
            const emit = proto.emit
            Object.defineProperty(proto, "emit", {
              configurable: true,
              writable: true,
              value(this: childProcess.ChildProcess, name: string | symbol, ...args: unknown[]) {
                if (name !== "exit" || args[0] !== 1) return Reflect.apply(emit, this, [name, ...args])
                return Reflect.apply(emit, this, [
                  "error",
                  Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
                ])
              },
            })
            return own
          }),
          (own) =>
            Effect.sync(() => {
              if (own) Object.defineProperty(proto, "emit", own)
              else Reflect.deleteProperty(proto, "emit")
            }),
        )
        const code = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => console.log(\\'late\\'), 500)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref(); console.log('early'); process.exit(1)`
        const handle = yield* ChildProcess.make(`"${process.execPath}" -e "${code}"`, [], { shell: true })
        const [output, exit] = yield* Effect.all([decodeByteStream(handle.all), handle.exitCode], {
          concurrency: 2,
        }).pipe(Effect.timeout("5 seconds"))
        expect({ output: output.split(/\r?\n/), exit }).toEqual({
          output: ["early", "late"],
          exit: ChildProcessSpawner.ExitCode(1),
        })
      }),
      10_000,
    )
  })

  describe("hosted isolation", () => {
    // requireIsolation has no reset and test files share one process, so a child process turns it on.
    fx.live(
      "a refused isolation plan fails the spawn with a platform error instead of a defect",
      Effect.gen(function* () {
        const script = `
import { Cause, Effect, Exit } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
ProcessIsolation.requireIsolation()
const exit = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* spawner.string(ChildProcess.make("node", ["-e", "0"], { env: { LD_PRELOAD: "/fixture/loader.so" } }))
  }).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)), Effect.scoped),
)
const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined
console.log(JSON.stringify({
  failed: Exit.isFailure(exit),
  died: Exit.isFailure(exit) && Cause.hasDies(exit.cause),
  platform: failure?._tag === "Some" && failure.value?._tag === "PlatformError",
  method: failure?._tag === "Some" ? failure.value?.reason?.method : undefined,
  refusal: Exit.isFailure(exit) && Cause.pretty(exit.cause).includes("native loader environment"),
}))
`
        const output = yield* Effect.promise(
          () =>
            new Promise<string>((resolve, reject) => {
              const child = spawn(process.execPath, ["-e", script], {
                cwd: path.join(import.meta.dir, "..", ".."),
                stdio: ["ignore", "pipe", "inherit"],
              })
              const parts: Buffer[] = []
              child.stdout.on("data", (part: Buffer) => parts.push(part))
              child.once("error", reject)
              child.once("close", (code) =>
                code === 0 ? resolve(Buffer.concat(parts).toString()) : reject(new Error(`child exited ${code}`)),
              )
            }),
        )
        expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
          failed: true,
          died: false,
          platform: true,
          method: "spawn",
          refusal: true,
        })
      }),
      30_000,
    )
  })

  describe("pipeline", () => {
    fx.effect(
      "pipes stdout of one command to stdin of another",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO WORLD")
      }),
    )

    fx.effect(
      "three-stage pipeline",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.replaceAll(" ", "-")))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO-WORLD")
      }),
    )

    fx.effect(
      "pipes stderr with { from: 'stderr' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "stderr" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("error")
      }),
    )

    fx.effect(
      "pipes combined output with { from: 'all' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("stdout\\n"); process.stderr.write("stderr\\n")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "all" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toContain("stdout")
        expect(out).toContain("stderr")
      }),
    )
  })

  describe("Windows-specific", () => {
    fx.effect(
      "uses shell routing on Windows",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make("set", ["VECTOR_TEST_SHELL"], {
              shell: true,
              extendEnv: true,
              env: { VECTOR_TEST_SHELL: "ok" },
            }),
          ),
        )
        expect(out).toContain("VECTOR_TEST_SHELL=ok")
      }),
    )

    fx.effect(
      "runs cmd scripts with spaces on Windows without shell",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const dir = path.join(tmp.path, "with space")
        const file = path.join(dir, "echo cmd.cmd")

        yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n"))

        const code = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.exitCode(
            ChildProcess.make(file, ["--stdio"], {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            }),
          ),
        )
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )
  })
})
