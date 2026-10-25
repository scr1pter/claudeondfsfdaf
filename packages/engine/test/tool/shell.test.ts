import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { describe, expect, test } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Layer, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import type * as Scope from "effect/Scope"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "@vectordevai/core/shell"
import { ShellTool } from "../../src/tool/shell"
import { UNREAD } from "../../src/tool/shell/unread"
import { ShellPrompt } from "../../src/tool/shell/prompt"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { Global } from "@vectordevai/core/global"

const shellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | InstanceStore.Service
  | Scope.Scope

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const initBash = initShell

const run = Effect.fn("ShellToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const fail = Effect.fn("ShellToolTest.fail")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected command to fail")
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const bash = (() => {
  const shell = Shell.acceptable()
  if (Shell.name(shell) === "bash") return shell
  return Shell.gitbash()
})()
const shells = (() => {
  if (process.platform !== "win32") {
    const shell = Shell.acceptable()
    return [{ label: Shell.name(shell), shell }]
  }

  const list = [bash, Bun.which("pwsh"), Bun.which("powershell"), process.env.COMSPEC || Bun.which("cmd.exe")]
    .filter((shell): shell is string => Boolean(shell))
    .map((shell) => ({ label: Shell.name(shell), shell }))

  return list.filter(
    (item, i) => list.findIndex((other) => other.shell.toLowerCase() === item.shell.toLowerCase()) === i,
  )
})()
const PS = new Set(["pwsh", "powershell"])
const ps = shells.filter((item) => PS.has(item.label))
const cmdShell = shells.find((item) => item.label === "cmd")

// The command scan does not run the shell, so how it reads a Windows shell's commands is checked on every platform:
// under the real shells on Windows, elsewhere under a stand-in of the same name that only exits non-zero, so a command
// the scan wrongly lets through fails the test instead of running.
const scanShells = Effect.fn("ShellToolTest.scanShells")(function* (name: "pwsh" | "cmd") {
  if (process.platform === "win32") return name === "pwsh" ? ps : shells.filter((item) => item.label === "cmd")
  const dir = yield* tmpdirScoped()
  const shell = path.join(dir, name)
  yield* Effect.promise(async () => {
    await Bun.write(shell, "#!/bin/sh\nexit 3\n")
    await fs.chmod(shell, 0o755)
  })
  return [{ label: name, shell }]
})

const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

const fill = (mode: "lines" | "bytes", n: number) => {
  const code =
    mode === "lines"
      ? "console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>i+1).join(String.fromCharCode(10)))"
      : "process.stdout.write(String.fromCharCode(97).repeat(Number(Bun.argv[1])))"
  const text = `${bin} -e ${evalarg(code)} ${n}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

const forms = (dir: string) => {
  if (process.platform !== "win32") return [dir]
  const full = Filesystem.normalizePath(dir)
  const slash = full.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([full, slash, root, root.toLowerCase()]))
}

const withShell = <A, E, R>(item: { label: string; shell: string }, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = item.shell
      Shell.acceptable.reset()
      Shell.preferred.reset()
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.acceptable.reset()
        Shell.preferred.reset()
      }),
  )

const each = (
  name: string,
  fn: (item: { label: string; shell: string }) => Effect.Effect<void, unknown, ShellTestServices>,
) => {
  for (const item of shells) {
    it.live(`${name} [${item.label}]`, () => withShell(item, fn(item)))
  }
}

const capture = (requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">>, stop?: Error) => ({
  ...ctx,
  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      requests.push(req)
      if (stop) throw stop
    }),
})

const mustTruncate = (result: {
  metadata: { truncated?: boolean; exit?: number | null } & Record<string, unknown>
  output: string
}) => {
  if (result.metadata.truncated) return
  throw new Error(
    [`shell: ${process.env.SHELL || ""}`, `exit: ${String(result.metadata.exit)}`, "output:", result.output].join("\n"),
  )
}

describe("tool.shell", () => {
  test("every shell's description sends long-running and interactive work to the terminal tool", () => {
    for (const name of ["bash", "zsh", "pwsh", "powershell", "cmd"]) {
      const description = ShellPrompt.render(name, "linux", { maxLines: 2000, maxBytes: 30_000 }, 120_000).description
      expect(description).toContain(
        "Long-running or interactive work (dev servers, watchers, REPLs, prompts that wait for input, ssh) belongs in the terminal tool",
      )
      expect(description).toContain("Never start it here with & or nohup")
    }
  })

  each("basic", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: "echo test",
        })
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      }),
    ),
  )

  it.live("falls back from terminal-only configured shell", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ trusted: true, config: { shell: "fish" } })
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const bash = yield* initBash()
          const fallback = Shell.name(Shell.acceptable("fish"))
          expect(fallback).not.toBe("fish")
          expect(bash.description).toContain(fallback)

          const result = yield* bash.execute(
            {
              command: "echo fallback",
            },
            ctx,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("fallback")
        }),
      )
    }),
  )

  for (const scenario of [
    { mode: "exit", name: "drains final output after process exit while a metadata update is pending" },
    { mode: "abort", name: "aborts a pending metadata update after process exit without killing the closed process" },
    {
      mode: "timeout",
      name: "times out a pending metadata update after process exit without killing the closed process",
    },
    { mode: "failure", name: "preserves a metadata failure after process exit instead of reporting a timeout" },
    { mode: "early-failure", name: "fails and reaps a running process when its metadata consumer fails" },
  ] as const) {
    it.live(
      scenario.name,
      () =>
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped({
            init: (directory) =>
              Effect.promise(() =>
                Bun.write(
                  path.join(directory, "drain-child.ts"),
                  `if (${scenario.mode === "early-failure"}) process.on("SIGTERM", () => { void Bun.write(".term-received", "received") })
await Bun.write(".child-pid", String(process.pid))
process.stdout.write("first chunk\\n")
while (!(await Bun.file(".metadata-ready").exists())) await Bun.sleep(5)
process.stderr.write("final chunk\\n")
if (${scenario.mode === "early-failure"}) while (true) await Bun.sleep(10)
`,
                ),
              ).pipe(Effect.asVoid),
          })
          const closed = yield* Deferred.make<void>()
          const controller = new AbortController()
          const metadataError = new Error("metadata update failed")
          const completed: string[] = []
          const killed: number[] = []
          const running: ChildProcessSpawner.ChildProcessHandle["isRunning"][] = []
          const outcome = yield* runIn(
            tmp,
            run(
              {
                command: `${scenario.mode === "early-failure" && process.platform !== "win32" ? "exec " : PS.has(sh()) ? "& " : ""}${bin} --no-env-file ./drain-child.ts`,
                timeout: 5_000,
              },
              {
                ...ctx,
                abort: controller.signal,
                metadata: (input) => {
                  const output = (input.metadata as { output?: string })?.output
                  if (!output?.includes("first chunk") || output.includes("final chunk")) return Effect.void
                  return Effect.gen(function* () {
                    yield* Effect.promise(() => Bun.write(path.join(tmp, ".metadata-ready"), "ready"))
                    if (scenario.mode === "early-failure") return yield* Effect.die(metadataError)
                    yield* Deferred.await(closed)
                    if (scenario.mode === "failure") return yield* Effect.die(metadataError)
                    if (scenario.mode === "abort") controller.abort()
                    if (scenario.mode !== "exit") return yield* Effect.never
                    // Simulate an output update still writing after the real process has closed.
                    yield* Effect.sleep("100 millis")
                    completed.push(output)
                  })
                },
              },
            ).pipe(
              Effect.updateService(ChildProcessSpawner.ChildProcessSpawner, (real) =>
                ChildProcessSpawner.make((command) =>
                  real.spawn(command).pipe(
                    Effect.map((handle) => {
                      running.push(handle.isRunning)
                      return ChildProcessSpawner.makeHandle({
                        ...handle,
                        exitCode: handle.exitCode.pipe(Effect.tap(() => Deferred.succeed(closed, undefined))),
                        kill: (options) => {
                          killed.push(handle.pid)
                          return handle.kill(options)
                        },
                      })
                    }),
                  ),
                ),
              ),
            ),
          ).pipe(Effect.exit)
          expect(yield* Deferred.isDone(closed)).toBe(scenario.mode !== "early-failure")
          expect(running).toHaveLength(1)
          expect(yield* running[0]).toBe(false)
          expect(killed).toHaveLength(scenario.mode === "early-failure" ? 1 : 0)
          if (scenario.mode === "early-failure" && process.platform !== "win32") {
            expect(Number(yield* Effect.promise(() => Bun.file(path.join(tmp, ".child-pid")).text()))).toBe(killed[0])
            expect(yield* Effect.promise(() => Bun.file(path.join(tmp, ".term-received")).exists())).toBe(true)
          }
          if (scenario.mode === "failure" || scenario.mode === "early-failure") {
            expect(Exit.isFailure(outcome)).toBe(true)
            if (Exit.isFailure(outcome)) expect(Cause.squash(outcome.cause)).toBe(metadataError)
            return
          }
          const result = yield* outcome
          expect(result.output).toContain("first chunk")
          if (scenario.mode === "exit") {
            expect(result.metadata.exit).toBe(0)
            expect(result.output).toContain("final chunk")
            expect(completed).toHaveLength(1)
            return
          }
          expect(result.metadata.exit).toBeNull()
          expect(result.output).toContain(
            scenario.mode === "abort"
              ? "User aborted the command"
              : "shell tool terminated command after exceeding timeout 5000 ms",
          )
          expect(completed).toHaveLength(0)
        }),
      15_000,
    )
  }

  it.live("does not expose Vector's internal vault and bridge secrets to commands", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const values = {
          BLOB_READ_WRITE_TOKEN: "release-store-secret",
          VECTOR_AUTH_CONTENT: "aggregate-secret",
          VECTOR_CONSOLE_TOKEN: "console-secret",
          VECTOR_SERVER_PASSWORD: "server-secret",
          VECTOR_CLOUD_TOKEN: "cloud-secret",
          VECTOR_CREDENTIAL_KEY: "vault-secret",
          VECTOR_INSTALLER_BLOB_TOKEN: "installer-secret",
          VECTOR_MCP_AUTH_KEY: "mcp-secret",
          OPENAI_API_KEY: "provider-secret",
        }
        const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
        Object.assign(process.env, values)
        return previous
      }),
      () =>
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const code = `process.stdout.write(JSON.stringify({
              blob: process.env.BLOB_READ_WRITE_TOKEN,
              aggregate: process.env.VECTOR_AUTH_CONTENT,
              console: process.env.VECTOR_CONSOLE_TOKEN,
              password: process.env.VECTOR_SERVER_PASSWORD,
              cloud: process.env.VECTOR_CLOUD_TOKEN,
              vault: process.env.VECTOR_CREDENTIAL_KEY,
              installer: process.env.VECTOR_INSTALLER_BLOB_TOKEN,
              mcp: process.env.VECTOR_MCP_AUTH_KEY,
              provider: process.env.OPENAI_API_KEY,
            }))`
            const command = `${PS.has(sh()) ? "& " : ""}${bin} -e ${evalarg(code)}`
            const result = yield* run({ command })
            expect(result.output).toContain('"provider":"provider-secret"')
            ;[
              "release-store-secret",
              "aggregate-secret",
              "console-secret",
              "server-secret",
              "cloud-secret",
              "vault-secret",
              "installer-secret",
              "mcp-secret",
            ].forEach((secret) => expect(result.output).not.toContain(secret))
          }),
        ),
      (previous) =>
        Effect.sync(() => {
          Object.entries(previous).forEach(([key, value]) => {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          })
        }),
    ),
  )
})

describe("tool.shell permissions", () => {
  each("asks for bash permission with correct pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo hello",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo hello")
        }),
      )
    }),
  )

  each("asks for bash permission with multiple commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo foo && echo bar",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo foo")
          expect(requests[0].patterns).toContain("echo bar")
        }),
      )
    }),
  )

  for (const item of ps) {
    it.live(`parses PowerShell conditionals for permission prompts [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: "Write-Host foo; if ($?) { Write-Host bar }",
              },
              capture(requests),
            )
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            expect(bashReq!.patterns).toContain("Write-Host foo")
            expect(bashReq!.patterns).toContain("Write-Host bar")
            expect(bashReq!.always).toContain("Write-Host *")
          }),
        ),
      ),
    )
  }

  for (const item of ps) {
    it.live(`uses PowerShell cmdlet prefixes for always-allow prompts [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Remove-Item -Recurse tmp",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.always).toContain("Remove-Item *")
              expect(bashReq!.always).not.toContain("Remove-Item -Recurse *")
            }),
          )
        }),
      ),
    )
  }

  each("asks every time under Vector Cloud's permission before a cloud CLI changes an account", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("cloud prompt rejected")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          // Rejecting the cloud prompt stops the command, so no real CLI runs.
          const rejectCloud = {
            ...ctx,
            ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
              Effect.sync(() => {
                requests.push(req)
                if (req.permission.startsWith("vector_cloud_")) throw err
              }),
          }
          expect(yield* fail({ command: "echo ready && npx --yes vercel@59.26.0 --prod" }, rejectCloud)).toMatchObject({
            message: err.message,
          })
          expect(requests.map((item) => item.permission)).toEqual(["bash", "vector_cloud_publish"])
          expect(requests[1]).toMatchObject({
            patterns: [`vercel/${path.basename(tmp)}/production/shell deploy`],
            always: [],
            metadata: { provider: "Vercel", environment: "production", action: "deploy" },
          })
          expect(String(requests[1].metadata.summary)).toContain("npx --yes vercel@59.26.0 --prod")
        }),
      )
    }),
  )

  each("asks for a cloud CLI behind eval, xargs, wrappers and a shell's -c string", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("cloud prompt rejected")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const rejectCloud = {
            ...ctx,
            ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
              Effect.sync(() => {
                requests.push(req)
                if (req.permission.startsWith("vector_cloud_")) throw err
              }),
          }
          // `false &&` keeps a real CLI from running if the check missed one:
          // the scan reads every command, the shell runs none after `false`.
          const cases = [
            ["false && eval vercel --prod", "vector_cloud_publish"],
            ["false && nice -n 5 vercel --prod", "vector_cloud_publish"],
            ["false && echo x | xargs vercel --prod", "vector_cloud_publish"],
            ["false && sh -c 'vercel --prod'", "vector_cloud_publish"],
            [`false && bash -lc "cd web && vercel deploy --prod"`, "vector_cloud_publish"],
            [`false && timeout 60 bash -c 'eval "supabase db push"'`, "vector_cloud_database"],
            // bash passes the words after a redirect to the command.
            ["false && supabase </dev/null db push", "vector_cloud_database"],
          ] as const
          for (const [command, permission] of cases) {
            requests.length = 0
            expect({ command, error: (yield* fail({ command }, rejectCloud)).message }).toEqual({
              command,
              error: err.message,
            })
            expect({ command, asked: requests.map((item) => item.permission) }).toEqual({
              command,
              asked: ["bash", permission],
            })
            expect(requests[1].always).toEqual([])
          }
        }),
      )
    }),
  )

  each("asks under read, as the read tool does, before a command reads an environment file", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("read prompt rejected")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const rejectRead = {
            ...ctx,
            ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
              Effect.sync(() => {
                requests.push(req)
                if (req.permission === "read") throw err
              }),
          }
          const cases = PS.has(sh())
            ? ([
                // `cat` is PowerShell's own alias for Get-Content, so the bash spelling reads the file there too.
                ["cat .env", ".env"],
                ["Get-Content .env", ".env"],
                ["Select-String STRIPE apps/web/.env.local", path.join("apps", "web", ".env.local")],
                ["Get-Content -Raw ./.env", ".env"],
                ["Get-Content .env.production | ForEach-Object { $_ }", ".env.production"],
              ] as const)
            : ([
                ["cat .env", ".env"],
                ["grep STRIPE apps/web/.env.local", path.join("apps", "web", ".env.local")],
                ["source ./.env", ".env"],
                ["while read line; do echo $line; done < .env.production", ".env.production"],
                // cd adds no shell pattern of its own, but the substitution still reads the file.
                ['cd "$(<.env)"', ".env"],
              ] as const)
          for (const [command, file] of cases) {
            requests.length = 0
            expect({ command, error: (yield* fail({ command }, rejectRead)).message }).toEqual({
              command,
              error: err.message,
            })
            expect({ command, read: requests.find((item) => item.permission === "read")?.patterns }).toEqual({
              command,
              read: [file],
            })
          }
          requests.length = 0
          yield* run(
            {
              command: PS.has(sh())
                ? "Get-Content .env.example,.envrc -ErrorAction SilentlyContinue"
                : "cat .env.example .envrc 2>/dev/null; true",
            },
            rejectRead,
          )
          expect(requests.map((item) => item.permission)).not.toContain("read")
        }),
      )
    }),
  )

  // A link opens the file it points at, and on Windows an 8.3 short name (`ENV~1`) opens `.env`, so the name a file
  // really has asks under read as the read tool does.
  it.live("asks under read for an environment file reached through a link", () =>
    Effect.gen(function* () {
      const items = [
        ...shells.filter((item) => !PS.has(item.label) && item.label !== "cmd"),
        ...(yield* scanShells("pwsh")),
        ...(yield* scanShells("cmd")),
      ]
      for (const item of items) {
        yield* withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped({ git: true })
            yield* Effect.promise(() => Bun.write(path.join(tmp, ".env"), "KEY=1\n"))
            // File links need a privilege on Windows, which CI runners hold.
            const linked = yield* Effect.promise(() =>
              fs
                .symlink(path.join(tmp, ".env"), path.join(tmp, "secrets"), "file")
                .then(() => true)
                .catch((error) => {
                  if (process.platform === "win32" && error?.code === "EPERM") return false
                  throw error
                }),
            )
            if (!linked) return
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("read prompt rejected")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                const rejectRead = {
                  ...ctx,
                  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      requests.push(req)
                      if (req.permission === "read") throw err
                    }),
                }
                const command = PS.has(item.label)
                  ? "Get-Content secrets"
                  : item.label === "cmd"
                    ? "type secrets"
                    : "cat secrets"
                const error = (yield* fail({ command }, rejectRead)).message
                const read = requests.find((r) => r.permission === "read")?.patterns ?? []
                expect({ shell: item.label, error, env: read.some((file) => /(^|[\\/])\.env$/.test(file)) }).toEqual({
                  shell: item.label,
                  error: err.message,
                  env: true,
                })
                // A plain file is not asked for.
                requests.length = 0
                yield* Effect.promise(() => Bun.write(path.join(tmp, "notes.txt"), "notes\n"))
                yield* run({ command: command.replace("secrets", "notes.txt") }, rejectRead)
                expect(requests.map((r) => r.permission)).not.toContain("read")
              }),
            )
          }),
        )
      }
    }),
  )

  // bash passes the words after a redirect's file to the command, so `cat 2>/dev/null .env` reads `.env`, though the
  // grammar keeps them with the redirect, and with the whole statement after `a && b`. `<>` opens its file for writing.
  for (const item of shells.filter((item) => !PS.has(item.label) && item.label !== "cmd")) {
    it.live(`checks the words after a redirect's file as the command's, and <> as a write [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const outside = yield* tmpdirScoped()
          const away = path.join(outside, "secret.txt").replaceAll("\\", "/")
          yield* Effect.promise(() => Bun.write(away, "secret"))
          const tmp = yield* tmpdirScoped({ git: true })
          yield* Effect.promise(() => Bun.write(path.join(tmp, ".env"), "KEY=1\n"))
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("prompt rejected")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const stopAt = (permission: string) => ({
                ...ctx,
                ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                  Effect.sync(() => {
                    requests.push(req)
                    if (req.permission === permission) throw err
                  }),
              })
              for (const command of ["cat 2>/dev/null .env", "true && cat < /dev/null .env", "echo | cat >&2 .env"]) {
                requests.length = 0
                const error = (yield* fail({ command }, stopAt("read"))).message
                expect({ command, error, read: requests.find((r) => r.permission === "read")?.patterns }).toEqual({
                  command,
                  error: err.message,
                  read: [".env"],
                })
              }
              requests.length = 0
              const command = `cat < /dev/null ${away}`
              expect((yield* fail({ command }, stopAt("external_directory"))).message).toBe(err.message)
              expect(requests[0]?.patterns).toEqual([glob(path.join(outside, "*"))])
              // A command's pattern holds the words bash passes it, so a rule for `cat *.env` sees `.env`.
              requests.length = 0
              yield* fail({ command: "true && cat 2>/dev/null .env" }, stopAt("bash"))
              expect(requests[0]?.patterns).toContain("cat 2>/dev/null .env")
              for (const command of ["cat <> notes.txt", "exec 3<>notes.txt"]) {
                requests.length = 0
                yield* fail({ command }, stopAt("edit"))
                expect({ command, edit: requests.find((r) => r.permission === "edit")?.patterns }).toEqual({
                  command,
                  edit: ["notes.txt"],
                })
              }
            }),
          )
        }),
      ),
    )
  }

  // bash removes quotes and escapes and expands wildcards before it opens a redirect's file, and `$(<file)` prints that
  // file without running any command, so a read written that way asks what `cat` of the same file asks: under read, and
  // for its folder when that lies outside the project.
  for (const item of shells.filter((item) => !PS.has(item.label) && item.label !== "cmd")) {
    it.live(`asks for the file a bash redirect or substitution reads, by the name bash opens [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const outside = yield* tmpdirScoped()
          const away = path.join(outside, "secret.txt").replaceAll("\\", "/")
          const key = path.join(outside, ".ssh", "id_rsa").replaceAll("\\", "/")
          yield* Effect.promise(async () => {
            await Bun.write(away, "secret")
            await Bun.write(key, "secret")
          })
          const tmp = yield* tmpdirScoped({ git: true })
          yield* Effect.promise(async () => {
            await Bun.write(path.join(tmp, ".env"), "KEY=1\n")
            await Bun.write(path.join(tmp, "notes.txt"), "notes\n")
            await Bun.write(path.join(tmp, "id.pem"), "key\n")
          })
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("prompt rejected")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const stopAt = (permission: string) => ({
                ...ctx,
                ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                  Effect.sync(() => {
                    requests.push(req)
                    if (req.permission === permission) throw err
                  }),
              })
              for (const command of [
                'cd "$(<.e""nv)"',
                'cd "$(<.e\\nv)"',
                'cd "$(<.en?)"',
                "cd \"$(<$'.env')\"",
                "cd \"$(<$'\\x2eenv')\"",
                'cd "$(<.e"$UNSET_NAME"nv)"',
                "cd `<.env`",
                "cat .e''nv",
                "c''at .env",
              ]) {
                requests.length = 0
                const error = (yield* fail({ command }, stopAt("read"))).message
                const read = requests.find((r) => r.permission === "read")?.patterns ?? []
                expect({
                  command,
                  error,
                  env: read.includes(".env"),
                }).toEqual({
                  command,
                  error: err.message,
                  env: true,
                })
              }
              // Any file a redirect opens meets the read rules, by the name a wildcard matches.
              requests.length = 0
              yield* fail({ command: 'cd "$(<id.pe?)"' }, stopAt("read"))
              expect(requests.find((r) => r.permission === "read")?.patterns).toContain("id.pem")
              for (const [command, folder] of [
                [`cd "$(<${away})"`, outside],
                [`pushd "$(<${key})"`, path.join(outside, ".ssh")],
                [`git log "$(<${key})"`, path.join(outside, ".ssh")],
                [`while read l; do echo "$l"; done < ${away}`, outside],
              ] as const) {
                requests.length = 0
                const error = (yield* fail({ command }, stopAt("external_directory"))).message
                expect({
                  command,
                  error,
                  dirs: requests[0]?.patterns,
                }).toEqual({
                  command,
                  error: err.message,
                  dirs: [glob(path.join(folder, "*"))],
                })
              }
              // Past the outside-folder prompt, the read rules see the file too.
              const rules = Permission.fromConfig({
                read: { "*": "allow", "**/.ssh/*": "ask" },
              })
              requests.length = 0
              yield* fail({ command: `cd "$(<${key})"` }, stopAt("read"))
              expect(
                requests
                  .find((r) => r.permission === "read")
                  ?.patterns.some((p) => Permission.evaluate("read", p, rules).action === "ask"),
              ).toBe(true)
              // `$(<file)` runs no command, so it is approved only as written, like a statement.
              requests.length = 0
              yield* fail({ command: 'git log "$(<notes.txt)"' }, stopAt("bash"))
              expect(requests.find((r) => r.permission === "bash")?.always).toContain("$(<notes.txt)")
              // Reading a device opens no file, and bash's `*` does not match the leading dot of `.env`.
              for (const command of ["cat < /dev/null", "ls *"]) {
                requests.length = 0
                yield* run({ command }, stopAt("read"))
                expect({ command, asked: requests.map((r) => r.permission) }).toEqual({ command, asked: ["bash"] })
              }
            }),
          )
        }),
      ),
    )
  }

  // PowerShell reads a file through a .NET call as easily as through a command, and refuses to parse `<` rather than
  // reading from it, so neither may slip past the read prompt the bash forms get.
  it.live("asks under read before PowerShell reads an environment file by command, redirect or .NET call", () =>
    Effect.gen(function* () {
      for (const item of yield* scanShells("pwsh")) {
        yield* withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped({ git: true })
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("read prompt rejected")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                const rejectRead = {
                  ...ctx,
                  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      requests.push(req)
                      if (req.permission === "read") throw err
                    }),
                }
                for (const [command, file] of [
                  // PowerShell's built-in aliases for Get-Content.
                  ["cat .env", ".env"],
                  ["type .env", ".env"],
                  ["Get-Content -Path .env -Raw | Select-String KEY", ".env"],
                  ["gc '.env.local'", ".env.local"],
                  ['Get-Content "$PWD/.env"', ".env"],
                  // A name the scan cannot resolve is asked for as written.
                  ["Get-Content *.env", "*.env"],
                  ["while read line; do echo $line; done < .env.production", ".env.production"],
                  ['[IO.File]::ReadAllText(".env")', ".env"],
                  [
                    "$lines = [System.IO.File]::ReadAllLines('apps/web/.env.local')",
                    path.join("apps", "web", ".env.local"),
                  ],
                ] as const) {
                  requests.length = 0
                  const error = (yield* fail({ command }, rejectRead)).message
                  expect({
                    command,
                    error,
                    read: requests.find((r) => r.permission === "read")?.patterns,
                    edit: requests.find((r) => r.permission === "edit")?.patterns,
                  }).toEqual({ command, error: err.message, read: [file], edit: undefined })
                }
                // A .NET call is a statement of its own: checked and approved only as written.
                requests.length = 0
                const call = "[IO.File]::Delete('notes.txt')"
                yield* fail({ command: call }, capture(requests, err))
                expect(requests.map((r) => [r.permission, r.patterns, r.always])).toEqual([["bash", [call], [call]]])
                requests.length = 0
                yield* run({ command: "Get-Content .env.example; [IO.File]::ReadAllText('.envrc')" }, rejectRead)
                expect(requests.map((r) => r.permission)).not.toContain("read")
              }),
            )
          }),
        )
      }
    }),
  )

  // Windows opens `.env` for `.ENV`, `.env ` and `.env.`, and a wildcard such as `.en?` opens whatever it matches, so
  // under PowerShell and cmd none of these may skip the read prompt that `.env` gets.
  it.live("asks under read for the Windows spellings of an environment file and for wildcards that match one", () =>
    Effect.gen(function* () {
      const cases: Record<"pwsh" | "cmd", { asked: Array<[string, RegExp[]]>; quiet: string[] }> = {
        pwsh: {
          asked: [
            ["Get-Content .\\.ENV", [/^(\.\\)?\.env$/i]],
            ["Get-Content '.env '", [/^\.env$/]],
            ["Get-Content .env.", [/^\.env$/]],
            ["Get-Content .e`Nv", [/^\.env$/i]],
            ["[IO.File]::ReadAllText('.ENV.local')", [/^\.env\.local$/i]],
            ["Get-Content .e*", [/^\.env$/, /^\.env\.local$/]],
            ["Get-Content .en?", [/^\.env$/]],
            ["Get-Content *.ENV", [/^\*\.ENV$/]],
            ["switch -File .ENV { default { $_ } }", [/^\.env$/i]],
            ['Get-Content ".e$($null)nv"', [/^\.env$/]],
            ['Get-Content "$dir/.en?"', [/^\$dir\/\.env$/]],
            // NTFS streams: `::$DATA` is the file's own content, `:name` one of its alternate streams.
            ["Get-Content '.env::$DATA'", [/^\.env$/]],
            ["[IO.File]::ReadAllText('.env::$DATA')", [/^\.env$/]],
            ["Get-Content -LiteralPath .\\.env:stream", [/^(\.\\)?\.env$/]],
            ["Get-Content '.en?:stream:$DATA'", [/^\.env$/]],
          ],
          quiet: ["Get-Content *.txt", "Get-Content notes.txt", "Write-Output $x", "Get-Content .env.example"],
        },
        cmd: {
          asked: [
            ["type .ENV", [/^\.env$/i]],
            ['type ".env "', [/^\.env$/]],
            ["type .env.", [/^\.env$/]],
            ["type .en?", [/^\.env$/]],
            ["type .e*", [/^\.env$/, /^\.env\.local$/]],
            ["type *.ENV", [/^\*\.ENV$/]],
            ["type .e%OS:~0,0%nv", [/^\.env$/]],
            ["type %CD%\\.en?", [/^%CD%\\\.env$/]],
            ["more < .env::$DATA", [/^\.env$/]],
            ["type .env:notes", [/^\.env$/]],
            ["type .e%OS:~0,0%nv:notes", [/^\.env$/]],
          ],
          quiet: ["type *.txt", "dir *.log", "echo %PATH%", "type .env.example"],
        },
      }
      for (const name of ["pwsh", "cmd"] as const) {
        for (const item of yield* scanShells(name)) {
          yield* withShell(
            item,
            Effect.gen(function* () {
              const tmp = yield* tmpdirScoped({ git: true })
              yield* Effect.promise(() =>
                Promise.all([
                  Bun.write(path.join(tmp, ".env"), "KEY=1\n"),
                  Bun.write(path.join(tmp, ".env.local"), "KEY=2\n"),
                  Bun.write(path.join(tmp, "notes.txt"), "notes\n"),
                ]),
              )
              yield* runIn(
                tmp,
                Effect.gen(function* () {
                  const err = new Error("read prompt rejected")
                  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                  const rejectRead = {
                    ...ctx,
                    ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                      Effect.sync(() => {
                        requests.push(req)
                        if (req.permission === "read") throw err
                      }),
                  }
                  for (const [command, files] of cases[name].asked) {
                    requests.length = 0
                    // A command that never finishes fails with its name, so a stalled Windows run says which one.
                    const error = (yield* awaitWithTimeout(fail({ command }, rejectRead), `${name} hung on ${command}`, "20 seconds"))
                      .message
                    const read = requests.find((r) => r.permission === "read")?.patterns.toSorted()
                    expect({ command, error, read }).toEqual({
                      command,
                      error: err.message,
                      read: files.map((file) => expect.stringMatching(file)),
                    })
                  }
                  // The PowerShell grammar cannot parse an unquoted `$dir/.en?`, so the scan does not know what it reads:
                  // the whole command is approved only as written, behind the prefix no allow rule matches.
                  if (name === "pwsh") {
                    requests.length = 0
                    const command = "Get-Content $dir/.en?"
                    yield* awaitWithTimeout(run({ command }, rejectRead), `${name} hung on ${command}`, "20 seconds")
                    const bash = requests.find((r) => r.permission === "bash")
                    expect(bash?.patterns).toContain(UNREAD + command)
                    expect(bash?.always).toContain(UNREAD + command)
                  }
                  for (const command of cases[name].quiet) {
                    requests.length = 0
                    yield* awaitWithTimeout(run({ command }, rejectRead), `${name} hung on ${command}`, "20 seconds")
                    expect({ command, permissions: requests.map((r) => r.permission) }).toEqual({
                      command,
                      permissions: ["bash"],
                    })
                  }
                }),
              )
            }),
          )
        }
      }
    }),
    90_000,
  )

  // `${C:\x}` reads a file through the FileSystem provider and assigning to it writes the file, with no command in the
  // statement at all. Neither may run without the shell, read and edit prompts, under any agent.
  it.live("asks before a PowerShell provider variable reads or writes a file", () =>
    Effect.gen(function* () {
      for (const item of yield* scanShells("pwsh")) {
        yield* withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped({ git: true })
            const outside = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("prompt rejected")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                const stopAt = (permission: string) => ({
                  ...ctx,
                  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      requests.push(req)
                      if (req.permission === permission) throw err
                    }),
                })
                const cases: Array<{ command: string; bash: string[]; read?: RegExp; edit?: RegExp }> = [
                  { command: "${C:\\Users\\me\\proj\\.env}", bash: ["${C:\\Users\\me\\proj\\.env}"], read: /\.env$/ },
                  {
                    command: "$k = ${C:\\Users\\me\\.ssh\\id_rsa}; $k",
                    bash: ["$k = ${C:\\Users\\me\\.ssh\\id_rsa}", "$k"],
                    read: /id_rsa$/,
                  },
                  {
                    command: "${C:\\Users\\me\\.bashrc} = 'evil'",
                    bash: ["${C:\\Users\\me\\.bashrc} = 'evil'"],
                    edit: /\.bashrc$/,
                  },
                  {
                    command: "${C:\\Users\\me\\.bashrc} += 'evil'",
                    bash: ["${C:\\Users\\me\\.bashrc} += 'evil'"],
                    read: /\.bashrc$/,
                    edit: /\.bashrc$/,
                  },
                  {
                    command: "${Microsoft.PowerShell.Core\\FileSystem::C:\\Users\\me\\.ssh\\id_rsa}",
                    bash: ["${Microsoft.PowerShell.Core\\FileSystem::C:\\Users\\me\\.ssh\\id_rsa}"],
                    read: /id_rsa$/,
                  },
                  { command: "$c:id_rsa", bash: ["$c:id_rsa"], read: /id_rsa$/ },
                  {
                    command: 'Write-Output "${C:\\Users\\me\\.ssh\\id_rsa}"',
                    bash: ['Write-Output "${C:\\Users\\me\\.ssh\\id_rsa}"'],
                    read: /id_rsa$/,
                  },
                  { command: "foreach (${C:\\x} in 1) {}", bash: ["foreach (${C:\\x} in 1) {}"], edit: /x$/ },
                  {
                    command: "${function:git} = { Get-Date }; git status",
                    bash: ["${function:git} = { Get-Date }", "Get-Date", "git status"],
                    edit: /^function:git$/,
                  },
                ]
                for (const entry of cases) {
                  requests.length = 0
                  const error = (yield* fail({ command: entry.command }, stopAt(entry.read ? "read" : "bash"))).message
                  const bash = requests.find((r) => r.permission === "bash")
                  const read = requests.find((r) => r.permission === "read")?.patterns
                  const edit = requests.find((r) => r.permission === "edit")?.patterns
                  expect({ command: entry.command, error, bash: bash?.patterns.toSorted() }).toEqual({
                    command: entry.command,
                    error: err.message,
                    bash: entry.bash.toSorted(),
                  })
                  if (entry.read) expect(read).toEqual([expect.stringMatching(entry.read)])
                  else expect(read).toBeUndefined()
                  if (entry.edit) expect(edit).toEqual([expect.stringMatching(entry.edit)])
                  else expect(edit).toBeUndefined()
                }
                // A statement whose only command changes directory adds no shell pattern, but it still reads the
                // variable, and Set-Location prints the value it was given.
                for (const command of [
                  'cd "${C:\\Users\\me\\proj\\.env}"',
                  "cd ${C:\\Users\\me\\proj\\.env}",
                  'Set-Location -Path "${C:\\Users\\me\\proj\\.env}"',
                  "if (${C:\\Users\\me\\proj\\.env}) { cd x }",
                  "foreach ($l in ${C:\\Users\\me\\proj\\.env}) { cd $l }",
                ]) {
                  requests.length = 0
                  const error = (yield* fail({ command }, stopAt("read"))).message
                  const read = requests.find((r) => r.permission === "read")?.patterns
                  expect({ command, error, read }).toEqual({
                    command,
                    error: err.message,
                    read: [expect.stringMatching(/\.env$/)],
                  })
                }

                // The provider globs a variable's path and reads a stream by its file's name, so these read `.env`.
                yield* Effect.promise(() => Bun.write(path.join(tmp, ".env"), "KEY=1\n"))
                for (const command of [
                  `git log \${FileSystem::${tmp}/.en?}`,
                  `git log "\${FileSystem::${tmp}/.env::$DATA}"`,
                  'git log "${C:\\Users\\me\\proj\\.env::$DATA}"',
                ]) {
                  requests.length = 0
                  const error = (yield* fail({ command }, stopAt("read"))).message
                  const read = requests.find((r) => r.permission === "read")?.patterns ?? []
                  expect({ command, error, env: read.some((item) => /(^|[\\/])\.env$/.test(item)) }).toEqual({
                    command,
                    error: err.message,
                    env: true,
                  })
                }

                // A drive the scan cannot place may map any folder, so it asks as a folder outside the project does.
                requests.length = 0
                const temp = "git log ${Temp:\\x}"
                expect((yield* fail({ command: temp }, stopAt("external_directory"))).message).toBe(err.message)
                requests.length = 0
                yield* run({ command: "${function:git}" }, capture(requests))
                expect(requests.map((r) => r.permission)).not.toContain("external_directory")

                // A statement without a command is approved only as written.
                requests.length = 0
                yield* fail({ command: "${C:\\Users\\me\\proj\\.env}" }, stopAt("read"))
                expect(requests.find((r) => r.permission === "bash")?.always).toEqual(["${C:\\Users\\me\\proj\\.env}"])

                // A file outside the project asks for its folder, as the read and edit tools do.
                for (const command of [
                  `\${FileSystem::${outside}/notes.txt} = 'evil'`,
                  `sc ${outside}/notes.txt evil`,
                  `gi ${outside}/notes.txt`,
                  `Microsoft.PowerShell.Management\\Get-Content ${outside}/notes.txt`,
                  `Get-Content Microsoft.PowerShell.Core\\FileSystem::${outside}/notes.txt`,
                ]) {
                  requests.length = 0
                  expect((yield* fail({ command }, stopAt("external_directory"))).message).toBe(err.message)
                  expect({ command, dirs: requests[0]?.patterns }).toEqual({
                    command,
                    dirs: [glob(path.join(outside, "*"))],
                  })
                }

                // Environment, scoped and plain variables are not files.
                requests.length = 0
                yield* run(
                  { command: "$env:PATH; ${env:PATH}; $global:a = 1; $b = $a; $variable:b" },
                  capture(requests),
                )
                expect(requests.map((r) => r.permission)).toEqual(["bash"])
              }),
            )
          }),
        )
      }
    }),
  )

  each("asks for edit permission for the files a redirect writes", () =>
    Effect.gen(function* () {
      const outside = yield* tmpdirScoped()
      yield* runIn(
        projectRoot,
        Effect.gen(function* () {
          const err = new Error("stop before running")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const target = path.join(outside, "notes.txt").replaceAll("\\", "/")
          yield* fail(
            { command: `git status > zz-redirect.txt 2>&1 >> "${target}"` },
            {
              ...ctx,
              ask: (req) =>
                Effect.sync(() => {
                  requests.push(req)
                  if (req.permission === "bash") throw err
                }),
            },
          )
          const edit = requests.find((r) => r.permission === "edit")
          expect(edit?.patterns).toHaveLength(2)
          expect(edit?.patterns.some((item) => item.replaceAll("\\", "/").endsWith("engine/zz-redirect.txt"))).toBe(
            true,
          )
          expect(requests.find((r) => r.permission === "external_directory")?.patterns).toContain(
            glob(path.join(outside, "*")),
          )
          // Descriptor merges and the null device write no file.
          requests.length = 0
          yield* fail({ command: "git status 2>&1 > /dev/null" }, capture(requests, err))
          expect(requests.map((r) => r.permission)).toEqual(["bash"])
        }),
      )
    }),
  )

  each("asks for external_directory permission for wildcard external paths", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
        const file = process.platform === "win32" ? `${process.env.WINDIR!.replaceAll("\\", "/")}/*` : "/etc/*"
        const want = process.platform === "win32" ? glob(path.join(process.env.WINDIR!, "*")) : "/etc/*"
        expect(
          yield* fail(
            {
              command: `cat ${file}`,
            },
            capture(requests, err),
          ),
        ).toMatchObject({ message: err.message })
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(want)
      }),
    ),
  )

  // git diff prints whole files once one of them lies outside the work tree, with or without --no-index.
  for (const item of shells.filter((item) => !PS.has(item.label) && item.label !== "cmd")) {
    it.live(`asks for external_directory permission for files git diff reads [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const outside = yield* tmpdirScoped()
          const file = path.join(outside, "id_rsa").replaceAll("\\", "/")
          yield* Effect.promise(() => Bun.write(file, "secret"))
          const tmp = yield* tmpdirScoped({ git: true })
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              for (const [command, want] of [
                [`git diff /dev/null ${file}`, glob(path.join(outside, "*"))],
                [`git diff ${file} README.md`, glob(path.join(outside, "*"))],
                [`git diff --no-index -- README.md ${file}`, glob(path.join(outside, "*"))],
                ["git diff /dev/null .env", "/dev/*"],
              ]) {
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(yield* fail({ command }, capture(requests, err))).toMatchObject({ message: err.message })
                expect(requests.find((r) => r.permission === "external_directory")?.patterns).toContain(want)
              }
              // Revisions and paths inside the workspace ask only for the command.
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* fail({ command: "git diff main..HEAD -- src/index.ts HEAD~1" }, capture(requests, err))
              expect(requests.map((r) => r.permission)).toEqual(["bash"])
            }),
          )
        }),
      ),
    )
  }

  if (process.platform === "win32") {
    if (bash) {
      it.live("asks for nested bash command permissions [bash]", () =>
        withShell(
          { label: "bash", shell: bash },
          Effect.gen(function* () {
            const outerTmp = yield* tmpdirScoped()
            yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
            yield* runIn(
              projectRoot,
              Effect.gen(function* () {
                const file = path.join(outerTmp, "outside.txt").replaceAll("\\", "/")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                yield* run(
                  {
                    command: `echo $(cat "${file}")`,
                  },
                  capture(requests),
                )
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                const bashReq = requests.find((r) => r.permission === "bash")
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(glob(path.join(outerTmp, "*")))
                expect(bashReq).toBeDefined()
                expect(bashReq!.patterns).toContain(`cat "${file}"`)
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell paths after switches [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Copy-Item -PassThru "${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini" ./out`,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for nested PowerShell command permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const file = `${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`
              yield* run(
                {
                  command: `Write-Output $(Get-Content ${file})`,
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain(`Get-Content ${file}`)
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for drive-relative PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "C:../outside.txt"',
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $HOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$HOME/.ssh/config"',
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(os.homedir(), ".ssh", "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PWD PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "$PWD/../outside.txt"',
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PSHOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$PSHOME/outside.txt"',
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(item.shell), "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for missing PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const key = "VECTOR_TEST_MISSING"
              const prev = process.env[key]
              delete process.env[key]
              return { key, prev }
            }),
            ({ key }) =>
              runIn(
                projectRoot,
                Effect.gen(function* () {
                  const err = new Error("stop after permission")
                  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                  const root = path.parse(process.env.WINDIR!).root.replace(/[\\/]+$/, "")
                  expect(
                    yield* fail(
                      {
                        command: `Get-Content -Path "${root}$env:${key}\\Windows\\win.ini"`,
                      },
                      capture(requests, err),
                    ),
                  ).toMatchObject({ message: err.message })
                  const extDirReq = requests.find((r) => r.permission === "external_directory")
                  expect(extDirReq).toBeDefined()
                  expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
                }),
              ),
            ({ key, prev }) =>
              Effect.sync(() => {
                if (prev === undefined) delete process.env[key]
                else process.env[key] = prev
              }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Get-Content $env:WINDIR/win.ini",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell FileSystem paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Get-Content -Path FileSystem::${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for braced PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Get-Content ${env:WINDIR}/win.ini",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`treats Set-Location like cd for permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Set-Location C:/Windows",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
              expect(bashReq).toBeUndefined()
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`does not add nested PowerShell expressions to permission prompts [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Write-Output ('a' * 3)",
                },
                capture(requests),
              )
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).not.toContain("a * 3")
              expect(bashReq!.always).not.toContain("a *")
            }),
          ),
        ),
      )
    }
  }

  if (process.platform === "win32" && cmdShell) {
    it.live("asks for external_directory permission for cmd file commands [cmd]", () =>
      withShell(
        cmdShell,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: `TYPE "${path.join(process.env.WINDIR!, "win.ini")}"`,
              },
              capture(requests),
            )
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            expect(extDirReq).toBeDefined()
            expect(extDirReq!.patterns).toContain(Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")))
          }),
        ),
      ),
    )
  }

  each("asks for external_directory permission when cd to parent", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "cd ../",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
        }),
      )
    }),
  )

  each("asks for external_directory permission when workdir is outside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "echo ok",
                workdir: os.tmpdir(),
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(glob(path.join(os.tmpdir(), "*")))
        }),
      )
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes external_directory workdir variants on Windows", () =>
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const outerTmp = yield* tmpdirScoped()
        const tmp = yield* tmpdirScoped()
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const want = Filesystem.normalizePathPattern(path.join(outerTmp, "*"))

            for (const dir of forms(outerTmp)) {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: dir,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })

              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect({ dir, patterns: extDirReq?.patterns, always: extDirReq?.always }).toEqual({
                dir,
                patterns: [want],
                always: [want],
              })
            }
          }),
        )
      }),
    )

    if (bash) {
      it.live("uses Git Bash /tmp semantics for external workdir", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: "/tmp",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )

      it.live("uses Git Bash /tmp semantics for external file paths", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "cat /tmp/vector-does-not-exist",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )
    }
  }

  each("asks for external_directory permission when file arg is outside project", () =>
    Effect.gen(function* () {
      const outerTmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const filepath = path.join(outerTmp, "outside.txt")
          expect(
            yield* fail(
              {
                command: `cat ${filepath}`,
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(expected)
          expect(extDirReq!.always).toContain(expected)
          expect(extDirReq!.metadata).toMatchObject({
            command: `cat ${filepath}`,
            directories: [outerTmp],
            patterns: [expected],
          })
        }),
      )
    }),
  )

  each("does not ask for external_directory permission when rm inside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(tmp, "tmpfile"), "x"))
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: `rm -rf ${path.join(tmp, "nested")}`,
            },
            capture(requests),
          )
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeUndefined()
        }),
      )
    }),
  )

  each("includes always patterns for auto-approval", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "git log --oneline -5",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].always.length).toBeGreaterThan(0)
          expect(requests[0].always.some((item) => item.endsWith("*"))).toBe(true)
        }),
      )
    }),
  )

  each("does not ask for bash permission when command is cd only", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "cd .",
            },
            capture(requests),
          )
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeUndefined()
        }),
      )
    }),
  )

  each("matches redirects in permission pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const stopAtBash = {
            ...ctx,
            ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
              Effect.sync(() => {
                requests.push(req)
                if (req.permission === "bash") throw err
              }),
          }
          expect(yield* fail({ command: "echo test > output.txt" }, stopAtBash)).toMatchObject({
            message: err.message,
          })
          expect(requests.map((r) => r.permission)).toEqual(["edit", "bash"])
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq!.patterns).toContain("echo test > output.txt")
        }),
      )
    }),
  )

  each("always pattern has space before wildcard to not include different commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run({ command: "ls -la" }, capture(requests))
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.always[0]).toBe("ls *")
        }),
      )
    }),
  )
})

describe("tool.shell read-only allowlist", () => {
  // Shaped like agent.ts's readonlyVerificationBash, the rules the review,
  // judge, explore and security agents run under.
  const readonly = Permission.fromConfig({
    bash: {
      "*": "deny",
      "git diff*": "allow",
      "git status*": "allow",
      "git show*": "allow",
      "git log*": "allow",
      "*--no-index*": "deny",
    },
  })

  // Decides a request the way Permission.ask does: one denied pattern denies
  // the whole command.
  const enforce = (requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">>) => ({
    ...ctx,
    ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
      Effect.sync(() => {
        requests.push(req)
        const rules = req.patterns.map((pattern) => Permission.evaluate(req.permission, pattern, readonly))
        if (rules.some((rule) => rule.action === "deny")) throw new PermissionV1.DeniedError({ ruleset: readonly })
        if (rules.some((rule) => rule.action === "ask")) throw new Error(`unexpected prompt: ${req.patterns}`)
      }),
  })

  // [command, the pattern that must be checked for it]
  const denied = [
    ["export GIT_EXTERNAL_DIFF=/bin/sh; git diff", "export GIT_EXTERNAL_DIFF=/bin/sh"],
    ["declare -x X=1; git status", "declare -x X=1"],
    ["readonly X=1", "readonly X=1"],
    ["unset X", "unset X"],
    ["X=1; git status", "X=1"],
    ["f() { rm -rf x; }; git diff", "f() { rm -rf x; }"],
    ["A=1 git diff", "A=1 git diff"],
    // `$(<file)` reads a file without running a command.
    ['git log "$(<notes.txt)"', "$(<notes.txt)"],
  ]

  // cmd expands %NAME% before git sees the path, so `%USERPROFILE%\.ssh\id_rsa` may point anywhere: git diff may
  // compare it whole, the way --no-index does, and naming an environment file that way still asks under read.
  it.live("denies git diff of a path cmd expands, and asks under read for an environment file named that way", () =>
    Effect.gen(function* () {
      for (const item of yield* scanShells("cmd")) {
        yield* withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped({ git: true })
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                for (const command of [
                  "git diff %USERPROFILE%\\.ssh\\id_rsa README.md",
                  "git diff README.md %HOMEDRIVE%%HOMEPATH%\\.aws\\credentials",
                ]) {
                  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                  expect(yield* fail({ command }, enforce(requests))).toBeInstanceOf(PermissionV1.DeniedError)
                  expect(requests.find((r) => r.permission === "bash")?.patterns).toContain(
                    command.replace("git diff", "git diff --no-index"),
                  )
                }
                const err = new Error("read prompt rejected")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                const rejectRead = {
                  ...ctx,
                  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      requests.push(req)
                      if (req.permission === "read") throw err
                    }),
                }
                expect((yield* fail({ command: "type %USERPROFILE%\\.env" }, rejectRead)).message).toBe(err.message)
                expect(requests.find((r) => r.permission === "read")?.patterns).toEqual(["%USERPROFILE%\\.env"])
              }),
            )
          }),
        )
      }
    }),
  )

  // cmd removes `^` escapes and double quotes before the program sees a word, so `type .e^nv` opens `.env`.
  it.live("asks under read and for outside folders by the name cmd passes after its escapes and quotes", () =>
    Effect.gen(function* () {
      for (const item of yield* scanShells("cmd")) {
        yield* withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped({ git: true })
            const outside = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("prompt rejected")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                const stopAt = (permission: string) => ({
                  ...ctx,
                  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      requests.push(req)
                      if (req.permission === permission) throw err
                    }),
                })
                for (const [command, file] of [
                  ["type .e^nv", ".env"],
                  ['type ".e"nv', ".env"],
                  ["more < .e^nv.local", ".env.local"],
                  ["findstr KEY .e^n^v.production", ".env.production"],
                  // bash's grammar takes `(.env)` for a subshell, but cmd reads the file.
                  ['for /f "delims=" %a in (.env) do @echo %a', ".env"],
                  ["for %f in (.e^nv) do type %f", ".env"],
                ] as const) {
                  requests.length = 0
                  const error = (yield* fail({ command }, stopAt("read"))).message
                  expect({ command, error, read: requests.find((r) => r.permission === "read")?.patterns }).toEqual({
                    command,
                    error: err.message,
                    read: [file],
                  })
                }
                // A command the bash grammar cannot parse is approved only as written.
                requests.length = 0
                const loop = 'for /f "delims=" %a in (notes.txt) do @echo %a'
                yield* fail({ command: loop }, stopAt("bash"))
                expect(requests.find((r) => r.permission === "bash")?.always).toContain(UNREAD + loop)
                // A caret no longer hides a path, or the command that takes it, from the outside-folder check.
                requests.length = 0
                const command = `ty^pe ..^/${path.basename(outside)}/notes.txt`
                expect((yield* fail({ command }, stopAt("external_directory"))).message).toBe(err.message)
                expect(requests[0]?.patterns).toEqual([glob(path.join(outside, "*"))])
              }),
            )
          }),
        )
      }
    }),
  )

  // PowerShell parses these as different statements.
  for (const item of shells.filter((item) => !PS.has(item.label))) {
    for (const [command, pattern] of denied) {
      it.live(`denies ${command} [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(yield* fail({ command }, enforce(requests))).toBeInstanceOf(PermissionV1.DeniedError)
                expect(requests.find((r) => r.permission === "bash")?.patterns).toContain(pattern)
              }),
            )
          }),
        ),
      )
    }

    // Outside a git work tree git diff compares the two files whole, the way --no-index does.
    it.live(`denies git diff of two files outside a git work tree [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* Effect.promise(() => Bun.write(path.join(tmp, ".env"), "PLACEHOLDER=1"))
          yield* Effect.promise(() => Bun.write(path.join(tmp, "README.md"), "readme"))
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(yield* fail({ command: "git diff .env README.md" }, enforce(requests))).toBeInstanceOf(
                PermissionV1.DeniedError,
              )
              expect(requests.find((r) => r.permission === "bash")?.patterns).toContain(
                "git diff --no-index .env README.md",
              )
            }),
          )
        }),
      ),
    )

    // Inside a git work tree git diff still compares two whole files once one of them lies outside the work tree git
    // starts in, so the explore agent's own rules must deny each of these before .env reaches it.
    it.live(`denies the explore agent git diff of whole files in a git project [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped({ git: true })
          const nested = path.join(tmp, "nested")
          const output = path.join(Truncate.DIR, `tool_${path.basename(tmp)}`)
          yield* Effect.promise(async () => {
            await Bun.write(path.join(tmp, ".env"), "PLACEHOLDER_SECRET=1")
            await Bun.write(path.join(tmp, "README.md"), "readme")
            await Bun.write(path.join(nested, "n.txt"), "n")
            await Bun.$`git init -q`.cwd(nested).quiet()
            await Bun.write(output, "earlier output")
            await Bun.write(path.join(Global.Path.tmp, ".keep"), "")
          })
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const explore = yield* Agent.Service.use((svc) => svc.get("explore"))
              const ruleset = explore!.permission
              // The person approves only the prompts a case names; any other prompt fails the test.
              const decide = (
                requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">>,
                approve: readonly string[] = [],
              ) => ({
                ...ctx,
                agent: "explore",
                ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                  Effect.sync(() => {
                    requests.push(req)
                    const rules = req.patterns.map((pattern) => Permission.evaluate(req.permission, pattern, ruleset))
                    if (rules.some((rule) => rule.action === "deny")) throw new PermissionV1.DeniedError({ ruleset })
                    if (rules.some((rule) => rule.action === "ask") && !req.patterns.every((p) => approve.includes(p)))
                      throw new Error(`unexpected prompt: ${req.patterns}`)
                  }),
              })
              const env = path.join(tmp, ".env")
              const readme = path.join(tmp, "README.md")
              for (const [command, workdir] of [
                // A tool-output file and a whitelisted directory lie outside the work tree.
                [`git diff ${output} .env`, undefined],
                [`git diff ${Truncate.DIR} .`, undefined],
                // Run from a directory outside any work tree, by workdir or by cd.
                [`git diff ${env} ${readme}`, Global.Path.tmp],
                [`cd ${Global.Path.tmp} && git diff ${env} ${readme}`, undefined],
                ["git diff -- -a -b", Global.Path.tmp],
                // A nested repository's work tree ends at its own root, and a .git directory has none.
                ["git diff ../.env n.txt", nested],
                ["git diff ../.env HEAD", path.join(tmp, ".git")],
                // The shell decides where these point, so the scan cannot show them inside.
                ['git diff "$HOME/.env" README.md', undefined],
                ["git diff ~root/.profile README.md", undefined],
              ] as const) {
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                const exit = yield* run({ command, workdir }, decide(requests)).pipe(Effect.exit)
                const err = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
                if (!(err instanceof PermissionV1.DeniedError))
                  throw new Error(
                    `${command} (workdir ${workdir ?? "-"}) was not denied: ${Exit.isSuccess(exit) ? exit.value.output : String(err)}`,
                  )
                expect(
                  requests.find((r) => r.permission === "bash")?.patterns.some((p) => p.includes("--no-index")),
                ).toBe(true)
              }
              // Paths git sees inside its work tree still diff without a --no-index prompt, a nested repository's own
              // included. Naming .env still asks under read, as `cat .env` does.
              for (const [command, workdir, approve] of [
                ["git diff", undefined, []],
                ["git diff HEAD -- README.md", undefined, []],
                [`git diff ${readme} .env`, undefined, [".env"]],
                ["git diff n.txt", nested, []],
              ] as const) {
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                const result = yield* run({ command, workdir }, decide(requests, approve))
                expect(result.output).not.toContain("PLACEHOLDER_SECRET")
                expect(requests.flatMap((r) => r.patterns).some((p) => p.includes("--no-index"))).toBe(false)
                expect(requests.filter((r) => r.permission === "read").flatMap((r) => r.patterns)).toEqual([...approve])
              }
            }),
          )
        }),
      ),
    )

    for (const command of ["git diff main", "git log -5"]) {
      it.live(`allows ${command} [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped({ git: true })
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                const result = yield* run({ command }, enforce(requests))
                expect(requests.map((r) => r.patterns)).toEqual([[command]])
                expect(result.metadata.exit).toEqual(expect.any(Number))
              }),
            )
          }),
        ),
      )
    }

    it.live(`always-allow covers only the exact statement [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(yield* fail({ command: "export X=1; git status" }, capture(requests, err))).toMatchObject({
                message: err.message,
              })
              expect(requests[0]?.always).toContain("export X=1")
              expect(requests[0]?.always).toContain("git status *")
              expect(requests[0]?.always).not.toContain("export *")
            }),
          )
        }),
      ),
    )
  }
})

describe("tool.shell statements the scan cannot read", () => {
  type Request = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">
  // A stand-in of each name that only exits non-zero: the scan reads each command as that shell, and nothing runs.
  // Windows cannot run a script without an extension, so there it is a batch file; Vector reads a shell's kind from
  // its name without the extension.
  const standIns = Effect.fn("ShellToolTest.standIns")(function* () {
    const dir = yield* tmpdirScoped()
    return yield* Effect.forEach(["bash", "zsh"], (name) =>
      Effect.promise(async () => {
        const shell = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name)
        await Bun.write(shell, process.platform === "win32" ? "@exit /b 3\r\n" : "#!/bin/sh\nexit 3\n")
        await fs.chmod(shell, 0o755)
        return { label: name, shell }
      }),
    )
  })
  // Approves every prompt but the shell's, which it decides by the agent's rules, so a denied or asked shell pattern
  // stops the command.
  const decide = (requests: Request[], ruleset: PermissionV1.Ruleset, agent: string) => ({
    ...ctx,
    agent,
    ask: (req: Request) =>
      Effect.sync(() => {
        requests.push(req)
        if (req.permission !== "bash") return
        const rules = req.patterns.map((pattern) => Permission.evaluate(req.permission, pattern, ruleset))
        if (rules.some((rule) => rule.action === "deny")) throw new PermissionV1.DeniedError({ ruleset })
        if (rules.some((rule) => rule.action === "ask")) throw new Error("asked")
      }),
  })
  const record = (requests: Request[]) => ({
    ...ctx,
    ask: (req: Request) => Effect.sync(() => void requests.push(req)),
  })

  // Command substitutions bash and zsh run although the grammar keeps them as text, a command it cannot parse, and
  // redirects from a file the scan cannot place.
  const hidden = [
    "git log --stdin <<EOF\n`echo hi`\nEOF",
    "git log -1 ${HOME#`echo hi`}",
    "git log -1 ${HOME/a/`echo hi`}",
    "git log -1; [[ x =~ `echo hi` ]]",
    "git log -1 `#c` `echo hi`",
    'git log --stdin < "$HOME/x"',
    "git log --stdin < ~root/x",
    '< "$HOME/x"',
    // A backslash-newline inside the opener.
    "git log -1 $\\\n(echo hi)",
  ]
  // Syntax only zsh runs: parameter flags and glob qualifiers that evaluate text.
  const zshOnly = ["git log -1 ${(e)X}", 'git log -1 "${(e)X}"', "git log -1 *(e:true:)", "git log -1 .env(N)"]

  it.live("the read-only agents refuse what the scan cannot read, and build asks for it", () =>
    Effect.gen(function* () {
      for (const item of yield* standIns()) {
        yield* withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped({ git: true })
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const explore = (yield* Agent.Service.use((svc) => svc.get("explore")))!
                const build = (yield* Agent.Service.use((svc) => svc.get("build")))!
                for (const command of item.label === "zsh" ? [...hidden, ...zshOnly] : hidden) {
                  const requests: Request[] = []
                  const denied = yield* fail({ command }, decide(requests, explore.permission, "explore"))
                  if (!(denied instanceof PermissionV1.DeniedError))
                    throw new Error(`[${item.label}] explore ran ${JSON.stringify(command)}: ${denied.message}`)
                  requests.length = 0
                  expect((yield* fail({ command }, decide(requests, build.permission, "build"))).message).toBe("asked")
                  expect(
                    requests.some((r) => r.permission === "bash" && r.patterns.some((p) => p.startsWith(UNREAD))),
                  ).toBe(true)
                }
              }),
            )
          }),
        )
      }
    }),
  )

  it.live("leaves commands the scan reads in full as they were", () =>
    Effect.gen(function* () {
      for (const item of yield* standIns()) {
        yield* withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped({ git: true })
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                for (const command of [
                  "git log -1 --oneline",
                  "git status",
                  "git diff",
                  "git show --stat HEAD",
                  'git log --format="%h $(echo x)"',
                  "echo `echo hi`",
                  "ls -la",
                  "grep -rn 'a`b' .",
                  "cat README.md",
                  "find . -name '*.ts'",
                  "git log --stdin <<'EOF'\n`echo hi`\nEOF",
                  "echo \\`echo hi\\`",
                  'git log --grep="fix(app): x"',
                  "git log --format='%h (%s)'",
                ]) {
                  const requests: Request[] = []
                  yield* run({ command }, record(requests))
                  expect([command, requests.flatMap((r) => r.patterns).filter((p) => p.startsWith(UNREAD))]).toEqual([
                    command,
                    [],
                  ])
                }
              }),
            )
          }),
        )
      }
    }),
  )

  it.live("asks under read for an environment file a brace or zsh glob names, and for a linked file's real folder", () =>
    Effect.gen(function* () {
      for (const item of yield* standIns()) {
        yield* withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped({ git: true })
            const outside = yield* tmpdirScoped()
            yield* Effect.promise(async () => {
              await Bun.write(path.join(tmp, ".env"), "PLACEHOLDER=1")
              await Bun.write(path.join(outside, "secret.txt"), "placeholder")
              await fs.symlink(path.join(outside, "secret.txt"), path.join(tmp, "keylink"))
            })
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                for (const command of ["cat .e{n,}v", "cat {.env,}", "cat .e{a..z}v"]) {
                  const requests: Request[] = []
                  yield* run({ command }, record(requests))
                  expect([command, requests.filter((r) => r.permission === "read").flatMap((r) => r.patterns)]).toEqual(
                    [command, expect.arrayContaining([".env"])],
                  )
                }
                const requests: Request[] = []
                yield* run({ command: "git log --stdin < keylink" }, record(requests))
                expect(
                  requests.find((r) => r.permission === "external_directory")?.patterns.some((p) =>
                    p.startsWith(glob(FSUtil.realpath(outside))),
                  ),
                ).toBe(true)
              }),
            )
          }),
        )
      }
    }),
  )
})

describe("permission for statements the scan cannot read", () => {
  test("only a rule written for them allows them; a wildcard allow asks instead", () => {
    const rules = Permission.fromConfig({ bash: { "*": "ask", "*--version": "allow", "git log*": "allow" } })
    expect(Permission.evaluate("bash", UNREAD + "git log -1 --version", rules).action).toBe("ask")
    expect(Permission.evaluate("bash", "git log -1 --version", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", UNREAD + "x", Permission.fromConfig({ bash: "allow" })).action).toBe("ask")
    expect(Permission.evaluate("bash", UNREAD + "x", Permission.fromConfig({ bash: { "*": "deny" } })).action).toBe("deny")
    expect(
      Permission.evaluate("bash", UNREAD + "x", Permission.fromConfig({ bash: { [UNREAD + "*"]: "allow" } })).action,
    ).toBe("allow")
    // An "always" approval made from a wildcard does not cover them either.
    const approved = [{ permission: "bash", pattern: "*", action: "allow" as const }]
    expect(Permission.evaluate("bash", UNREAD + "x", rules, approved).action).toBe("ask")
  })
})

describe("tool.shell abort", () => {
  it.live(
    "preserves output when aborted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const controller = new AbortController()
          const collected: string[] = []
          const res = yield* run(
            {
              command: `echo before && sleep 30`,
            },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output && output.includes("before") && !controller.signal.aborted) {
                    collected.push(output)
                    controller.abort()
                  }
                }),
            },
          )
          expect(res.output).toContain("before")
          expect(res.output).toContain("User aborted the command")
          expect(collected.length).toBeGreaterThan(0)
        }),
      ),
    15_000,
  )

  it.live(
    "terminates command on timeout",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `sleep 60`,
            timeout: 500,
          })
          expect(result.output).toContain("shell tool terminated command after exceeding timeout")
          expect(result.output).toContain("retry with a larger timeout value in milliseconds")
        }),
      ),
    15_000,
  )

  it.live(
    "uses RuntimeFlags bashDefaultTimeoutMs when timeout is omitted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const tool = yield* initShell()
          expect(tool.description).toContain("Commands time out after 500ms")
          const result = yield* tool.execute(
            {
              command: `sleep 60`,
            },
            ctx,
          )
          expect(result.output).toContain("exceeding timeout 500 ms")
        }),
      ).pipe(Effect.provide(RuntimeFlags.layer({ bashDefaultTimeoutMs: 500 }))),
    15_000,
  )

  if (process.platform !== "win32") {
    it.live("captures stderr in output", () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `echo stdout_msg && echo stderr_msg >&2`,
          })
          expect(result.output).toContain("stdout_msg")
          expect(result.output).toContain("stderr_msg")
          expect(result.metadata.exit).toBe(0)
        }),
      ),
    )
  }

  it.live("returns non-zero exit code", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: `exit 42`,
        })
        expect(result.metadata.exit).toBe(42)
      }),
    ),
  )

  it.live("streams metadata updates progressively", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const updates: string[] = []
        const result = yield* run(
          {
            command: `echo first && sleep 0.1 && echo second`,
          },
          {
            ...ctx,
            metadata: (input) =>
              Effect.sync(() => {
                const output = (input.metadata as { output?: string })?.output
                if (output) updates.push(output)
              }),
          },
        )
        expect(result.output).toContain("first")
        expect(result.output).toContain("second")
        expect(updates.length).toBeGreaterThan(1)
      }),
    ),
  )
})

describe("tool.shell truncation", () => {
  it.live("truncates output exceeding line limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 500
        const result = yield* run({
          command: fill("lines", lineCount),
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("keeps the start and the end of long output within a 30KB budget", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        // 12,000 numbered lines is about 64KB: past the 30KB shell budget, under the generic line cap.
        const result = yield* run({ command: fill("lines", 12_000) })
        mustTruncate(result)
        const lines = result.output.split(/\r?\n/)
        // A build prints the failing step early and the summary late, so both ends survive.
        expect(lines).toContain("1")
        expect(lines).toContain("12000")
        expect(result.output).toMatch(/\.\.\.\d+ bytes omitted\.\.\./)
        expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThan(31_000 + 500)
      }),
    ),
  )

  it.live("preserves the output tail when a large pipe chunk is followed by only a newline", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({ command: fill("lines", 12_000) }).pipe(
          Effect.updateService(ChildProcessSpawner.ChildProcessSpawner, (real) =>
            ChildProcessSpawner.make((command) =>
              real.spawn(command).pipe(
                Effect.map((handle) =>
                  ChildProcessSpawner.makeHandle({
                    ...handle,
                    // Windows can deliver console.log's content and final newline separately.
                    all: Stream.unwrap(
                      Stream.runCollect(handle.all).pipe(
                        Effect.map((chunks) => {
                          const bytes = Buffer.concat(chunks)
                          return Stream.make(bytes.subarray(0, -1), bytes.subarray(-1))
                        }),
                      ),
                    ),
                  }),
                ),
              ),
            ),
          ),
        )
        mustTruncate(result)
        expect(result.output.split(/\r?\n/)).toContain("12000")
        expect(result.output.split(/\r?\n/)).toContain("1")
        expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThan(31_500)
      }),
    ),
  )

  it.live("truncates output exceeding byte limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = yield* run({
          command: fill("bytes", byteCount),
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("does not truncate small output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: fill("lines", 1),
        })
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        expect(result.output).toContain("1")
      }),
    ),
  )

  it.live("full output is saved to file when truncated", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 100
        const result = yield* run({
          command: fill("lines", lineCount),
        })
        mustTruncate(result)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = yield* (yield* FSUtil.Service).readFileString(filepath!)
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      }),
    ),
  )
})
