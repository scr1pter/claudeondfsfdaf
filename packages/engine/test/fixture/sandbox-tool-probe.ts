import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"

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
    let diagnostics = ""
    dummy.stderr!.on("data", (part: Buffer) => {
      diagnostics = (diagnostics + part.toString()).slice(-4096)
    })
    const closed = new Promise<void>((resolve) => dummy.once("exit", () => resolve()))
    const message = (kind: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          dummy.off("message", receive)
          reject(new Error("Disposable engine did not acknowledge the probe"))
        }, 5000)
        const receive = (value: unknown) => {
          if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== kind) return
          clearTimeout(timer)
          dummy.off("message", receive)
          resolve(value as Record<string, unknown>)
        }
        dummy.on("message", receive)
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
      const code = `const fs=require('node:fs');let visible=true;try{fs.readFileSync('/proc/'+process.argv[1]+'/cmdline')}catch{visible=false}let sent=false;try{process.kill(Number(process.argv[1]),'SIGUSR1');sent=true}catch{}const result={visible,sent,pid:process.pid,ppid:process.ppid};process.stdout.write(JSON.stringify(result))`
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
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
      const utility = await Process.run([node, "-e", code, String(dummy.pid)])
      if (utility.code !== 0) throw new Error("The shared utility launch failed")
      assertBlocked(JSON.parse(utility.stdout.toString()), "shared utility launch")
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
              const globOutcome = yield* globber.execute({ path: "/proc", pattern: "*" }, context).pipe(Effect.exit)
              const grepOutcome = yield* searcher.execute({ path: "/proc", pattern: "." }, context).pipe(Effect.exit)
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
      const report = message("report")
      dummy.send("report")
      if ((await report).opened !== false) throw new Error("A tool activated the disposable engine inspector")
      // Positive control: the same-UID fixture parent can signal it; this proves the target/observer are operational.
      dummy.kill("SIGUSR1")
      const until = Date.now() + 5000
      while (!diagnostics.includes("Debugger listening") && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 10))
      if (!diagnostics.includes("Debugger listening"))
        throw new Error("The inspector positive control did not activate")
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
        dummyNode: ready.node,
        callerRuntime: process.versions.bun ? `bun-${process.versions.bun}` : `node-${process.versions.node}`,
      }
    } finally {
      dummy.kill("SIGTERM")
      const kill = setTimeout(() => dummy.kill("SIGKILL"), 1000)
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("The disposable engine did not stop")), 2000)
          }),
        ])
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
