import fs from "node:fs/promises"
import { constants, fstatSync } from "node:fs"
import path from "node:path"
import { GithubSecrets } from "../../src/cli/cmd/github.secrets"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { LinuxIsolation } from "@vectordevai/core/process-isolation/linux"
import {
  ROOT,
  PAYLOAD,
  MANIFEST,
  PREFIX,
  CASES,
  ARTIFACT,
  need,
  digest,
  decodeManifest,
  rootFile,
  verifyAssets,
  acknowledgement,
  counters,
  json,
} from "./native-shell-payload"

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

async function main() {
  // First main action: the real global loader admits actual stdin and activates the monotonic authority itself.
  await GithubSecrets.credentials.load()
  need(
    process.platform === "linux" &&
      GithubSecrets.credentials.loaded() &&
      GithubSecrets.credentials.isolatedTools() &&
      ProcessIsolation.required(),
  )
  const manifest = decodeManifest(json(await rootFile(MANIFEST, 16_384)))
  const spec = LinuxIsolation.decodeSpec(await rootFile(LinuxIsolation.SPEC, 65_536))
  need(
    manifest.nonce === spec.nonce &&
      manifest.observer === spec.container + "/native-shell-observer" &&
      process.cwd() === spec.stage &&
      process.getuid?.() === spec.uid &&
      process.getgid?.() === spec.gid &&
      manifest.mode === process.env.VECTOR_MODE &&
      (manifest.runtime === "bun") === Boolean(process.versions.bun),
  )
  const native = ProcessIsolation.nativeBuild()
  need(native.enabled && typeof native.entrySHA === "string")
  const { GithubIsolation } = await import("../../src/cli/cmd/github.isolation")
  need(GithubIsolation.enabled())
  await verifyAssets(manifest)
  need(
    (await fs.realpath(process.execPath)) === manifest.runtimePath &&
      (await fs.realpath(manifest.runtimePath)) === manifest.runtimePath,
  )
  const runtime = await fs.lstat(manifest.runtimePath)
  need(runtime.isFile() && runtime.uid === 0 && runtime.gid === 0 && !(runtime.mode & 0o022))
  const holder = GithubSecrets.credentials
  const keys = holder.providerKeys()
  const githubToken = holder.githubToken()
  const token = holder.pendingRunToken()
  const cli = holder.cliToken()
  need(typeof githubToken === "string")
  if (manifest.mode === "codium")
    need(typeof token === "string" && cli === undefined && Object.keys(keys).length === 0 && holder.sessionProof())
  else
    need(
      token === undefined &&
        typeof cli === "string" &&
        Object.keys(keys).length === 1 &&
        typeof keys.DEEPSEEK_KEY === "string" &&
        !holder.sessionProof(),
    )
  const channel = { v: 1, githubToken, ...(manifest.mode === "codium" ? { runToken: token } : { cliToken: cli }), keys }
  const privateValues = [githubToken, token, cli, ...Object.values(keys)].filter(
    (value): value is string => typeof value === "string",
  )
  need(
    privateValues.every(
      (value) => !JSON.stringify(process.env).includes(value) && !JSON.stringify(process.argv).includes(value),
    ),
  )
  const proof = manifest.mode === "codium" ? fstatSync(3, { bigint: true }) : undefined
  if (proof)
    need(
      proof.isFile() &&
        proof.nlink === 1n &&
        proof.size === 0n &&
        !(Number(proof.mode) & 0o077) &&
        proof.uid !== BigInt(spec.uid),
    )
  const heldFile = await fs.open(
    `${ProcessIsolation.ENGINE_PRIVATE_DIRECTORIES[0]}/native-shell-held-${manifest.nonce}`,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  await heldFile.writeFile("synthetic open-handle control\n")
  const heldIdentity = await heldFile.stat({ bigint: true })
  need(heldIdentity.isFile() && heldIdentity.nlink === 1n && heldIdentity.uid === BigInt(spec.uid))
  const emit = (event: string, fields: Record<string, unknown> = {}) => {
    const text = PREFIX + JSON.stringify({ v: 1, event, nonce: manifest.nonce, ...fields }) + "\n"
    need(Buffer.byteLength(text) <= 4096 && privateValues.every((value) => !text.includes(value)))
    process.stdout.write(text)
  }
  let controlSignals = 0
  process.on("SIGUSR2", () => {
    controlSignals++
    emit("signal-control", { count: controlSignals })
  })
  const procEmpty = async () => need((await fs.readdir("/proc")).length === 0)
  await procEmpty()
  const directory = counters(spec, manifest)
  await fs.mkdir(directory, { mode: 0o700 })
  await fs.writeFile(`${directory}/engine.json`, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 })
  await fs.symlink(`/tmp/native-shell-canary-${manifest.nonce}`, `${spec.stage}/native-shell-canary-link`)
  process.env.VECTOR_DISABLE_MODELS_FETCH = "true"
  process.env.VECTOR_BRAIN_EMBED = "off"
  process.env.VECTOR_DISABLE_PROJECT_CONFIG = "1"
  process.env.VECTOR_PURE = "1"
  const { EgressGuard } = await import("@vectordevai/core/local-mode/guard")
  const guard = EgressGuard.installStrict()
  try {
    const { Effect, Layer, Cause, Exit, Stream } = await import("effect")
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
    const { ComputerSession } = await import("../../src/computer/session")
    const { Session } = await import("../../src/session/session")
    const { ChildProcess, ChildProcessSpawner } = await import("effect/unstable/process")
    const { SessionID, MessageID } = await import("../../src/session/schema")
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
        ComputerSession.node,
        Session.node,
      ]),
      [[InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })]],
    )
    // The SOLE approved harness omission is aggregate unrelated bootstrap; every directly consumed service is real.
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* InstanceStore.Service
        return yield* store.provide(
          { directory: spec.stage },
          Effect.gen(function* () {
            const info = yield* ShellTool
            const tool = yield* info.init()
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            emit("engine-ready", {
              pid: process.pid,
              runtime: manifest.runtime,
              mode: manifest.mode,
              family: manifest.family,
              channelSHA256: digest(Buffer.from(JSON.stringify(channel))),
              proof: proof ? { device: String(proof.dev), inode: String(proof.ino) } : null,
              heldFile: { device: String(heldIdentity.dev), inode: String(heldIdentity.ino) },
              omission: "aggregate-instance-bootstrap-only",
            })
            yield* Effect.promise(() => acknowledgement(manifest, "engine", "baseline"))
            need(controlSignals === 1)
            const selected = manifest.family === "engine-death" ? ["death"] : CASES
            for (const name of selected) {
              yield* Effect.promise(procEmpty)
              emit("round-begin", { case: name })
              yield* Effect.promise(() => acknowledgement(manifest, name, "baseline"))
              if (["inspect", "nonzero", "timeout", "abort", "death", "shell-pipeline"].includes(name)) {
                const controller = new AbortController()
                let asks = 0
                let metadata = 0
                const invoke = (mode: string) =>
                  `${quote(manifest.runtimePath)} ${quote(PAYLOAD)} ${quote(mode)} ${quote(name)}`
                const command =
                  name === "shell-pipeline" ? `${invoke("pipe-source")} | ${invoke("pipe-sink")}` : invoke(name)
                const ctx = {
                  sessionID: SessionID.make("ses_native_shell_fixture"),
                  messageID: MessageID.make("msg_native_shell_fixture"),
                  callID: `native-${name}`,
                  agent: "build",
                  abort: controller.signal,
                  messages: [],
                  metadata: () =>
                    Effect.sync(() => {
                      metadata++
                    }),
                  ask: (request: { permission: string; patterns: readonly string[] }) =>
                    Effect.sync(() => {
                      need(
                        ["bash", "external_directory", "read"].includes(request.permission),
                        "Unexpected fixture permission or fallback",
                      )
                      need(
                        request.patterns.every(
                          (value) =>
                            value.includes(PAYLOAD) ||
                            value.startsWith(ROOT + "/") ||
                            value.startsWith(path.dirname(manifest.runtimePath) + "/") ||
                            value.startsWith(spec.stage + "/"),
                        ),
                      )
                      asks++
                    }),
                }
                if (name === "abort")
                  yield* Effect.forkScoped(
                    Effect.promise(async () => {
                      await acknowledgement(manifest, name, "abort")
                      controller.abort(new Error("Synthetic owner abort"))
                    }),
                  )
                const result = yield* tool.execute({ command, timeout: name === "timeout" ? 5_000 : 20_000 }, ctx)
                need(name !== "death", "Engine-death family unexpectedly completed")
                need(asks > 0 && metadata > 0 && !result.metadata.truncated)
                if (name === "inspect")
                  need(
                    result.metadata.exit === 0 &&
                      result.output.includes("native-inspect-stdout") &&
                      result.output.includes("native-inspect-stderr"),
                  )
                if (name === "nonzero")
                  need(
                    result.metadata.exit === 17 &&
                      result.output.includes("Command exited with code 17") &&
                      result.output.includes("native-nonzero-stdout") &&
                      result.output.includes("native-nonzero-stderr"),
                  )
                if (name === "timeout")
                  need(result.metadata.exit === null && result.output.includes("exceeding timeout 5000 ms"))
                if (name === "abort")
                  need(result.metadata.exit === null && result.output.includes("User aborted the command"))
                if (name === "shell-pipeline")
                  need(
                    result.metadata.exit === 0 &&
                      result.output.includes("OUT:native-pipeline-input\n") &&
                      result.output.includes(`ERR:${digest(Buffer.from("native-pipeline-input\n"))}`),
                  )
                emit("round-done", {
                  case: name,
                  exit: result.metadata.exit,
                  asks,
                  metadata,
                  outputSHA256: digest(Buffer.from(result.output)),
                })
              } else {
                const command = (mode: string) =>
                  ChildProcess.make(manifest.runtimePath, [PAYLOAD, mode, name], {
                    cwd: spec.stage,
                    extendEnv: true,
                    forceKillAfter: "3 seconds",
                  })
                const collect = <E, R>(stream: import("effect").Stream.Stream<Uint8Array, E, R>) =>
                  Stream.runCollect(stream).pipe(
                    Effect.map((chunks) => {
                      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
                      need(bytes.length <= 1_100_000)
                      return bytes
                    }),
                  )
                if (name === "fd-source" || name === "fd-dest") {
                  const piped = ChildProcess.pipeTo(
                    command("pipe-source"),
                    command("pipe-sink"),
                    name === "fd-source" ? { from: "fd3" } : { to: "fd3" },
                  )
                  const refused = yield* spawner.spawn(piped).pipe(Effect.exit)
                  need(Exit.isFailure(refused) && Cause.pretty(refused.cause).includes(ProcessIsolation.REFUSAL))
                  emit("round-done", { case: name, refused: true })
                } else {
                  const input =
                    name === "pipeline" ? Buffer.from("native-pipeline-input\n") : Buffer.alloc(1_048_576, 0x78)
                  const proc =
                    name === "pipeline"
                      ? ChildProcess.pipeTo(command("pipe-source"), command("pipe-sink"))
                      : name === "delayed"
                        ? command("delayed")
                        : ChildProcess.make(manifest.runtimePath, [PAYLOAD, "stdio", name], {
                            cwd: spec.stage,
                            extendEnv: true,
                            stdin: Stream.succeed(input),
                            forceKillAfter: "3 seconds",
                          })
                  const result = yield* Effect.scoped(
                    Effect.gen(function* () {
                      const handle = yield* spawner.spawn(proc)
                      if (name === "delayed") need((yield* handle.exitCode) === 0)
                      const [stdout, stderr, exit] = yield* Effect.all(
                        [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
                        { concurrency: 3 },
                      )
                      return { stdout, stderr, exit }
                    }),
                  )
                  need(result.exit === 0)
                  if (name === "delayed")
                    need(result.stdout.equals(Buffer.from("d".repeat(4096))) && result.stderr.length === 0)
                  else
                    need(
                      result.stdout.equals(Buffer.concat([Buffer.from("OUT:"), input])) &&
                        result.stderr.toString() === `ERR:${digest(input)}\n`,
                    )
                  emit("round-done", {
                    case: name,
                    exit: result.exit,
                    stdoutBytes: result.stdout.length,
                    stderrBytes: result.stderr.length,
                    stdoutSHA256: digest(result.stdout),
                    stderrSHA256: digest(result.stderr),
                  })
                }
              }
              yield* Effect.promise(() => acknowledgement(manifest, name, "stopped"))
              yield* Effect.promise(procEmpty)
              need(controlSignals === 1)
            }
            need(guard.attempts().length === 0, "A fixture attempted an unexpected network call")
            let proofWritten = false
            if (manifest.mode === "codium") {
              const { GithubSessionProof } = yield* Effect.promise(
                () => import("../../src/cli/cmd/github.session-proof"),
              )
              proofWritten = GithubSessionProof.attestSessionArtifact(ARTIFACT)
              need(proofWritten && !GithubSessionProof.attestSessionArtifact(ARTIFACT))
            }
            emit("engine-summary", {
              cases: selected.length,
              proofWritten,
              signalCount: controlSignals,
              emptyProc: true,
            })
            yield* Effect.promise(() => acknowledgement(manifest, "engine", "summary"))
          }),
        )
      }).pipe(Effect.scoped, Effect.provide(layer), Effect.timeout("160 seconds")),
    )
  } finally {
    guard.uninstall()
    await heldFile.close()
  }
}

void main().catch(() => {
  process.stderr.write("Native Shell engine fixture refused\n")
  process.exitCode = 125
})
