import fs from "node:fs/promises"
import path from "node:path"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"

/** CI-only: the real ShellTool must not signal an engine-shaped process outside its tool namespace. */
export async function probeToolProcesses() {
  const root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP!, "tool-process-probe-"))
  for (const [name, directory] of Object.entries({
    XDG_DATA_HOME: "data",
    XDG_CONFIG_HOME: "config",
    XDG_STATE_HOME: "state",
    XDG_CACHE_HOME: "cache",
  })) {
    process.env[name] = path.join(root, directory)
    await fs.mkdir(process.env[name]!, { recursive: true })
  }
  process.env.VECTOR_DISABLE_MODELS_FETCH = "true"
  process.env.VECTOR_BRAIN_EMBED = "off"
  process.env.VECTOR_DISABLE_PROJECT_CONFIG = "1"
  process.env.VECTOR_PURE = "1"
  const { EgressGuard } = await import("@vectordevai/core/local-mode/guard")
  const network = EgressGuard.installStrict()
  try {
    const { Effect, Layer, Cause, Exit } = await import("effect")
    const { LayerNode } = await import("@vectordevai/core/effect/layer-node")
    const { CrossSpawnSpawner } = await import("@vectordevai/core/cross-spawn-spawner")
    const { FSUtil } = await import("@vectordevai/core/fs-util")
    const { Config } = await import("../../src/config/config")
    const { Agent } = await import("../../src/agent/agent")
    const { Plugin } = await import("../../src/plugin")
    const { Truncate } = await import("../../src/tool/truncate")
    const { RuntimeFlags } = await import("../../src/effect/runtime-flags")
    const { InstanceStore } = await import("../../src/project/instance-store")
    const { InstanceBootstrap } = await import("../../src/project/bootstrap-service")
    const { ShellTool } = await import("../../src/tool/shell")
    const { ReadTool } = await import("../../src/tool/read")
    const { GlobTool } = await import("../../src/tool/glob")
    const { GrepTool } = await import("../../src/tool/grep")
    const { Instruction } = await import("../../src/session/instruction")
    const { LSP } = await import("../../src/lsp/lsp")
    const { Ripgrep } = await import("@vectordevai/core/ripgrep")
    const { Process } = await import("../../src/util/process")
    const { LSPLaunch } = await import("../../src/lsp/launch")
    const { localTransport } = await import("../../src/mcp/stdio")
    const { ChildProcess, ChildProcessSpawner } = await import("effect/unstable/process")
    const { SessionID, MessageID } = await import("../../src/session/schema")
    // Only startup work unrelated to the shell is omitted; command preparation, permission flow and spawning are real.
    const layer = LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
        InstanceStore.node,
        Instruction.node,
        LSP.node,
        Ripgrep.node,
      ]),
      [[InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })]],
    )
    const node = path.join(process.env.PATH!.split(path.delimiter)[0]!, "node")
    const dummy = spawn(
      node,
      [
        "--input-type=module",
        "-e",
        `
    import inspector from 'node:inspector';
    const privateValue = 'synthetic-engine-memory-9126';
    process.on('message', async message => {
      if (message === 'report') process.send({kind:'report',opened:!!inspector.url()});
      if (message === 'close') {inspector.close();process.send({kind:'close',opened:!!inspector.url()})}
      if (message === 'guard') {
        const {assertNoDebugger}=await import('/opt/vector-inspector-guard.mjs');
        let refused=false;try{await assertNoDebugger()}catch{refused=true}
        process.send({kind:'guard',opened:!!inspector.url(),refused});
      }
    });
    process.send({kind:'ready',pid:process.pid,uid:process.getuid(),opened:!!inspector.url(),node:process.version});
    setInterval(()=>void privateValue,1000);
  `,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    )
    let phase = "ready"
    let probeError: unknown
    const lifecycle: {
      spawnError?: string
      exit?: { code: number | null; signal: string | null }
      closed: boolean
      disconnected: boolean
      term?: boolean
      kill?: boolean
    } = { closed: false, disconnected: false }
    dummy.on("error", (error: Error & { code?: string }) => {
      lifecycle.spawnError = error.code ?? error.name
    })
    dummy.once("close", () => {
      lifecycle.closed = true
    })
    dummy.once("disconnect", () => {
      lifecycle.disconnected = true
    })
    let diagnostics = ""
    dummy.stderr!.on("data", (part: Buffer) => {
      diagnostics = (diagnostics + part.toString()).slice(-4096)
    })
    const closed = new Promise<void>((resolve) =>
      dummy.once("exit", (code, signal) => {
        lifecycle.exit = { code, signal }
        resolve()
      }),
    )
    const details = () =>
      JSON.stringify({
        phase,
        pid: dummy.pid,
        connected: dummy.connected,
        killed: dummy.killed,
        ...lifecycle,
        stderr: diagnostics
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
          .replace(/[\r\n\t]+/g, " ")
          .slice(-800),
      })
    const message = (kind: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          dummy.off("message", receive)
          dummy.off("error", failed)
          dummy.off("exit", failed)
          dummy.off("disconnect", failed)
        }
        const failed = () => {
          cleanup()
          reject(new Error(`Disposable engine did not acknowledge ${kind}: ${details()}`))
        }
        const timer = setTimeout(failed, 5000)
        const receive = (value: unknown) => {
          if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== kind) return
          cleanup()
          resolve(value as Record<string, unknown>)
        }
        dummy.on("message", receive)
        dummy.once("error", failed)
        dummy.once("exit", failed)
        dummy.once("disconnect", failed)
        if (lifecycle.spawnError || lifecycle.exit || lifecycle.disconnected) failed()
      })
    try {
      const ready = await message("ready")
      if (
        !Number.isSafeInteger(ready.pid) ||
        ready.pid !== dummy.pid ||
        ready.uid !== process.getuid?.() ||
        ready.opened !== false
      )
        throw new Error("The disposable engine is not a matching uninspected user process")
      phase = "loader-positive-control"
      const loaderMarker = path.join(root, "loader-constructor")
      const loaderEnv = {
        LD_PRELOAD: "/opt/vector-probe-loader.so",
        VECTOR_PROBE_TARGET_PID: String(dummy.pid),
        VECTOR_PROBE_LOADER_MARKER: loaderMarker,
      }
      // Trusted positive control, deliberately outside the shared API: never runs repository code or a real engine.
      await promisify(execFile)("/usr/bin/true", [], { env: { ...process.env, ...loaderEnv }, timeout: 5000 })
      if ((await fs.readFile(loaderMarker, "utf8")) !== "synthetic loader constructor")
        throw new Error("The native loader positive control did not execute")
      const loaderUntil = Date.now() + 5000
      while (!diagnostics.includes("Debugger listening") && Date.now() < loaderUntil)
        await new Promise((resolve) => setTimeout(resolve, 10))
      if (!diagnostics.includes("Debugger listening"))
        throw new Error("The preload constructor did not signal the disposable target")
      phase = "loader-inspector-close"
      const loaderClosed = message("close")
      dummy.send("close")
      if ((await loaderClosed).opened !== false)
        throw new Error("The disposable inspector did not close after its loader control")
      diagnostics = ""
      await fs.unlink(loaderMarker)
      phase = "loader-refusals"
      const refusedLoader = (error: unknown) =>
        error instanceof Error && error.message.includes("native loader environment")
      if (!(await Process.run([node, "-e", "0"], { env: loaderEnv }).then(() => false, refusedLoader)))
        throw new Error("The actual utility launcher accepted a native preload")
      try {
        const child = LSPLaunch.spawn(node, ["-e", "0"], { env: loaderEnv })
        child.kill("SIGKILL")
        throw new Error("The actual LSP launcher accepted a native preload")
      } catch (error) {
        if (!refusedLoader(error)) throw error
      }
      if (
        !(await localTransport({ command: node, args: ["-e", "0"], cwd: process.cwd(), env: loaderEnv }).then(
          () => false,
          refusedLoader,
        ))
      )
        throw new Error("The actual MCP transport accepted a native preload")
      const refusedEffect = await Effect.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          return yield* spawner.string(ChildProcess.make(node, ["-e", "0"], { env: loaderEnv }))
        }).pipe(Effect.exit, Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)), Effect.scoped),
      )
      if (!Exit.isFailure(refusedEffect) || !Cause.pretty(refusedEffect.cause).includes("native loader environment"))
        throw new Error("The shared Effect launcher accepted a native preload")
      if (await fs.stat(loaderMarker).catch(() => undefined))
        throw new Error("A refused native loader constructor executed")
      phase = "loader-report"
      const loaderReport = message("report")
      dummy.send("report")
      if ((await loaderReport).opened !== false) throw new Error("A refused loader signalled the disposable engine")
      const code = `const fs=require('node:fs');let visible=true;try{fs.readFileSync('/proc/'+process.argv[1]+'/cmdline')}catch{visible=false}let sent=false;try{process.kill(Number(process.argv[1]),'SIGUSR1');sent=true}catch{}const result={visible,sent,pid:process.pid,ppid:process.ppid};process.stdout.write(JSON.stringify(result))`
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      phase = "actual-shell-tool"
      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* InstanceStore.Service
          return yield* store.provide(
            { directory: process.cwd() },
            Effect.gen(function* () {
              const info = yield* ShellTool
              const tool = yield* info.init()
              return yield* tool.execute(
                {
                  command: `${quote(node)} -e ${quote(code)} ${dummy.pid}`,
                  timeout: 10000,
                },
                {
                  sessionID: SessionID.make("ses_tool_pid_probe"),
                  messageID: MessageID.make("msg_tool_pid_probe"),
                  callID: "tool-process-probe",
                  agent: "build",
                  abort: new AbortController().signal,
                  messages: [],
                  metadata: () => Effect.void,
                  ask: (request) =>
                    request.permission === "unsandboxed_shell"
                      ? Effect.die(new Error("A compulsory process boundary offered an unsandboxed fallback"))
                      : Effect.void,
                },
              )
            }),
          )
        }).pipe(Effect.scoped, Effect.provide(layer), Effect.timeout("20 seconds")),
      )
      const actual: unknown = JSON.parse(output.output)
      function assertBlocked(value: unknown, label: string) {
        if (
          !value ||
          typeof value !== "object" ||
          !("visible" in value) ||
          value.visible !== false ||
          !("sent" in value) ||
          value.sent !== false
        )
          throw new Error(`The ${label} can reach or signal the disposable engine`)
      }
      assertBlocked(actual, "actual ShellTool")
      phase = "actual-utility-launch"
      const utility = await Process.run(
        [
          node,
          "-e",
          code.replace("{visible,sent,pid:", "{visible,sent,ordinary:process.env.VECTOR_PROBE_ORDINARY,pid:"),
          String(dummy.pid),
        ],
        { env: { VECTOR_PROBE_ORDINARY: "ordinary environment positive control" } },
      )
      if (utility.code !== 0) throw new Error("The shared utility launch failed")
      assertBlocked(JSON.parse(utility.stdout.toString()), "shared utility launch")
      if (JSON.parse(utility.stdout.toString()).ordinary !== "ordinary environment positive control")
        throw new Error("The ordinary child environment was not preserved")
      phase = "actual-lsp-launch"
      const lsp = LSPLaunch.spawn(node, ["-e", code, String(dummy.pid)])
      const lspOutput = new Promise<string>((resolve, reject) => {
        const parts: Buffer[] = []
        lsp.stdout.on("data", (part: Buffer) => parts.push(part))
        lsp.once("error", reject)
        lsp.once("close", (exit) =>
          exit === 0 ? resolve(Buffer.concat(parts).toString()) : reject(new Error("LSP launch failed")),
        )
      })
      try {
        assertBlocked(JSON.parse(await lspOutput), "actual LSP launch")
      } finally {
        lsp.kill("SIGKILL")
      }
      phase = "actual-mcp-launch"
      const transport = await localTransport({
        command: node,
        args: [
          "-e",
          code.replace("JSON.stringify(result)", 'JSON.stringify({jsonrpc:"2.0",method:"probe",params:result})'),
          String(dummy.pid),
        ],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined),
        ),
      })
      let mcpTimer: ReturnType<typeof setTimeout> | undefined
      const mcpOutput = new Promise<unknown>((resolve, reject) => {
        mcpTimer = setTimeout(() => reject(new Error("MCP launch did not report")), 5000)
        transport.onmessage = (message) => resolve("params" in message ? message.params : undefined)
        transport.onerror = reject
      })
      try {
        await transport.start()
        assertBlocked(await mcpOutput, "actual MCP stdio transport")
      } finally {
        clearTimeout(mcpTimer)
        await transport.close()
      }
      phase = "actual-effect-launch"
      const backend = await Effect.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          return yield* spawner.string(ChildProcess.make(node, ["-e", code, String(dummy.pid)]))
        }).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)), Effect.scoped, Effect.timeout("10 seconds")),
      )
      assertBlocked(JSON.parse(backend), "formatter/shared Effect spawn backend")

      const pseudo = ["/proc/self/fd/3", "/dev/fd/3", `/proc/${process.pid}/mem`]
      for (const target of pseudo) {
        const opened = await fs.open(target, "r").then(
          async (file) => {
            await file.close()
            return true
          },
          () => false,
        )
        if (opened) throw new Error("The engine can still open its process filesystem")
      }
      phase = "actual-file-tools"
      const alias = path.join(process.cwd(), "probe-process-alias")
      await fs.symlink("/proc/self/fd/3", alias)
      let permissionAsks = 0
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* InstanceStore.Service
          yield* store.provide(
            { directory: process.cwd() },
            Effect.gen(function* () {
              const context = {
                sessionID: SessionID.make("ses_tool_file_probe"),
                messageID: MessageID.make("msg_tool_file_probe"),
                callID: "file-probe",
                agent: "build",
                abort: new AbortController().signal,
                messages: [],
                metadata: () => Effect.void,
                extra: { bypassCwdCheck: true },
                ask: () =>
                  Effect.sync(() => {
                    permissionAsks++
                  }),
              }
              const read = yield* ReadTool
              const glob = yield* GlobTool
              const grep = yield* GrepTool
              const reader = yield* read.init()
              const globber = yield* glob.init()
              const searcher = yield* grep.init()
              for (const target of [...pseudo, alias, "/sys/kernel"]) {
                const outcome = yield* reader.execute({ filePath: target }, context).pipe(Effect.exit)
                if (
                  !Exit.isFailure(outcome) ||
                  !Cause.pretty(outcome.cause).includes("GitHub agent tools cannot access kernel process files.")
                )
                  throw new Error("The actual Read tool did not enforce its non-bypassable kernel path refusal")
              }
              const globOutcome = yield* globber
                .execute({ path: "/proc", pattern: "*" }, context)
                .pipe(Effect.asVoid, Effect.exit)
              const grepOutcome = yield* searcher
                .execute({ path: "/proc", pattern: "." }, context)
                .pipe(Effect.asVoid, Effect.exit)
              for (const outcome of [globOutcome, grepOutcome]) {
                if (
                  !Exit.isFailure(outcome) ||
                  !Cause.pretty(outcome.cause).includes("GitHub agent tools cannot access kernel process files.")
                )
                  throw new Error("An actual filesystem search did not enforce its kernel path refusal")
              }
              if (permissionAsks !== 0) throw new Error("Kernel file refusal was bypassable by a permission grant")
              const safe = path.join(process.cwd(), "probe-readable.txt")
              yield* Effect.promise(() => fs.writeFile(safe, "ordinary repository read positive control\n"))
              const ordinary = yield* reader.execute({ filePath: safe }, context)
              if (!ordinary.output.includes("ordinary repository read positive control"))
                throw new Error("The actual Read positive control failed")
            }),
          )
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.timeout("20 seconds")),
      )
      await fs.unlink(alias)
      phase = "tool-inspector-report"
      const report = message("report")
      dummy.send("report")
      if ((await report).opened !== false) throw new Error("A tool activated the disposable engine inspector")
      // Positive control: the same-UID fixture parent can signal it; this proves the target/observer are operational.
      phase = "parent-inspector-positive-control"
      dummy.kill("SIGUSR1")
      const until = Date.now() + 5000
      while (!diagnostics.includes("Debugger listening") && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 10))
      if (!diagnostics.includes("Debugger listening"))
        throw new Error("The inspector positive control did not activate")
      phase = "active-inspector-guard"
      const guarded = message("guard")
      dummy.send("guard")
      const guard = await guarded
      if (guard.opened !== true || guard.refused !== true)
        throw new Error("A running Node inspector was not refused before private-channel loading")
      if (network.attempts().some((attempt) => !attempt.allowed))
        throw new Error("The tool process probe attempted external network access")
      return {
        actualShellTool: true,
        sameUid: true,
        targetInvisible: true,
        signalBlocked: true,
        inspectorStayedClosed: true,
        controlInspectorOpened: true,
        activeInspectorRefused: true,
        utilityLaunch: true,
        lspLaunch: true,
        mcpLaunch: true,
        effectLaunch: true,
        engineProcHidden: true,
        actualFileToolsRefused: true,
        nativeLoaderRefused: true,
        ordinaryEnvironmentPreserved: true,
        loaderControlExecuted: true,
        dummyNode: ready.node,
        callerRuntime: process.versions.bun ? `bun-${process.versions.bun}` : `node-${process.versions.node}`,
      }
    } catch (error) {
      probeError = error
      throw error
    } finally {
      lifecycle.term = dummy.kill("SIGTERM")
      const kill = setTimeout(() => {
        lifecycle.kill = dummy.kill("SIGKILL")
      }, 1000)
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`The disposable engine did not stop: ${details()}`)), 2000)
          }),
        ])
      } catch (cleanupError) {
        if (probeError !== undefined)
          throw new AggregateError(
            [probeError, cleanupError],
            "The disposable tool probe failed and its child cleanup was not proven",
          )
        throw cleanupError
      } finally {
        clearTimeout(kill)
        clearTimeout(timeout)
      }
    }
  } finally {
    network.uninstall()
    await fs.rm(root, { recursive: true, force: true })
  }
}
