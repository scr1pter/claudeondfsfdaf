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
    const { Effect, Layer } = await import("effect")
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
    dummy.stderr.on("data", (part: Buffer) => {
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
      const code = `const fs=require('node:fs');let visible=true;try{fs.readFileSync('/proc/'+process.argv[1]+'/cmdline')}catch{visible=false}let sent=false;try{process.kill(Number(process.argv[1]),'SIGUSR1');sent=true}catch{}process.stdout.write(JSON.stringify({visible,sent,pid:process.pid,ppid:process.ppid}))`
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
                  description: "Check disposable tool process isolation",
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
      if (
        !actual ||
        typeof actual !== "object" ||
        !("visible" in actual) ||
        actual.visible !== false ||
        !("sent" in actual) ||
        actual.sent !== false
      )
        throw new Error("The actual ShellTool can reach or signal the disposable engine")
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
