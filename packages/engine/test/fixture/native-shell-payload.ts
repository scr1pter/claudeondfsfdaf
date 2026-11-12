import fs from "node:fs/promises"
import { constants, type BigIntStats } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { spawn } from "node:child_process"
import { setTimeout } from "node:timers/promises"
import { LinuxIsolation } from "@vectordevai/core/process-isolation/linux"

/** CI-only immutable fixtures. None of these helpers is a production authorization or launcher service. */
export const ROOT = "/usr/libexec/vector-native-shell"
export const MANIFEST = `${ROOT}/manifest.json`
export const ENGINE = `${ROOT}/engine.mjs`
export const HOST = `${ROOT}/host.mjs`
export const PAYLOAD = `${ROOT}/payload.mjs`
export const PREFIX = "VECTOR_NATIVE_SHELL "
export const CASES = [
  "inspect",
  "nonzero",
  "timeout",
  "abort",
  "shell-pipeline",
  "stdio",
  "delayed",
  "pipeline",
  "fd-source",
  "fd-dest",
] as const
export const ARTIFACT = Buffer.from("synthetic native-shell session ciphertext\n")
// Exact supporting outputs from the coherent fixture build; a new output requires an explicit reviewed update.
export const SUPPORT_ASSETS = Object.freeze([
  "ort-wasm-simd-threaded-r821n12y.wasm",
  "photon_rs_bg-bq08arze.wasm",
  "tree-sitter-3jzf13jk.wasm",
  "tree-sitter-bash-hq5s6fxb.wasm",
  "tree-sitter-powershell-ryb2ffqs.wasm",
])
export interface Asset {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}
export const CANARY_ROOTS = Object.freeze([
  ...LinuxIsolation.MASKS,
  "/home/vector-agent/.config/vector",
  "/home/vector-agent/.local/share/vector",
  "/home/vector-agent/.cache/vector",
  "/home/vector-agent/tmp/vector-agent",
])
export interface Manifest {
  readonly v: 1
  readonly nonce: string
  readonly runtime: "node" | "bun"
  readonly runtimePath: string
  readonly mode: "own-key" | "codium"
  readonly family: "baseline" | "engine-death"
  readonly observer: string
  readonly sourceRevision: string
  readonly fixtureSHA256: { readonly engine: string; readonly host: string; readonly payload: string }
  readonly assets: readonly Asset[]
}
export function need(value: unknown, message = "Native Shell fixture contract refused"): asserts value {
  if (!value) throw new Error(message)
}
export function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  need(value !== null && typeof value === "object" && !Array.isArray(value))
  const found = Reflect.ownKeys(value)
  need(found.length === keys.length && found.every((key) => typeof key === "string" && keys.includes(key)))
}
export const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
export function decodeManifest(value: unknown): Manifest {
  exact(value, [
    "v",
    "nonce",
    "runtime",
    "runtimePath",
    "mode",
    "family",
    "observer",
    "sourceRevision",
    "fixtureSHA256",
    "assets",
  ])
  need(value.v === 1 && typeof value.nonce === "string" && /^[a-f0-9]{32}$/.test(value.nonce))
  need(value.runtime === "node" || value.runtime === "bun")
  need(value.mode === "own-key" || value.mode === "codium")
  need(value.family === "baseline" || value.family === "engine-death")
  need(typeof value.runtimePath === "string" && value.runtimePath === `${ROOT}/runtime/${value.runtime}`)
  need(
    typeof value.observer === "string" &&
      LinuxIsolation.CONTAINERS.some((parent) => value.observer === parent + "/native-shell-observer"),
  )
  need(typeof value.sourceRevision === "string" && /^[a-f0-9]{40}$/.test(value.sourceRevision))
  exact(value.fixtureSHA256, ["engine", "host", "payload"])
  const hashes = value.fixtureSHA256
  need(typeof hashes.engine === "string" && /^[a-f0-9]{64}$/.test(hashes.engine))
  need(typeof hashes.host === "string" && /^[a-f0-9]{64}$/.test(hashes.host))
  need(typeof hashes.payload === "string" && /^[a-f0-9]{64}$/.test(hashes.payload))
  need(Array.isArray(value.assets) && value.assets.length > 0 && value.assets.length <= 32)
  const assets = value.assets.map((entry: unknown): Asset => {
    exact(entry, ["path", "bytes", "sha256"])
    need(
      typeof entry.path === "string" &&
        entry.path.length <= 256 &&
        entry.path.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part)),
    )
    need(
      typeof entry.bytes === "number" &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0 &&
        entry.bytes <= 268_435_456,
    )
    need(typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256))
    return Object.freeze({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 })
  })
  need(
    assets.every((entry, index) => index === 0 || assets[index - 1]!.path < entry.path) &&
      assets.reduce((sum, entry) => sum + entry.bytes, 0) <= 536_870_912,
  )
  const required = new Set([
    "engine.mjs",
    "host.mjs",
    "payload.mjs",
    "runtime/node",
    ...(value.runtime === "bun" ? ["runtime/bun"] : []),
    ...SUPPORT_ASSETS,
  ])
  need(assets.length === required.size && assets.every((entry) => required.has(entry.path)))
  need(
    assets.some((entry) => entry.path === "engine.mjs" && entry.sha256 === hashes.engine) &&
      assets.some((entry) => entry.path === "host.mjs" && entry.sha256 === hashes.host) &&
      assets.some((entry) => entry.path === "payload.mjs" && entry.sha256 === hashes.payload),
  )
  return Object.freeze({
    v: 1,
    nonce: value.nonce,
    runtime: value.runtime,
    runtimePath: value.runtimePath,
    mode: value.mode,
    family: value.family,
    observer: value.observer,
    sourceRevision: value.sourceRevision,
    fixtureSHA256: Object.freeze({ engine: hashes.engine, host: hashes.host, payload: hashes.payload }),
    assets: Object.freeze(assets),
  })
}
export async function boundedFile(name: string, limit: number) {
  const file = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    need(before.isFile() && before.nlink === 1n && before.size >= 0n && before.size <= BigInt(limit))
    const bytes = Buffer.alloc(limit + 1)
    let size = 0
    while (size < bytes.length) {
      const value = await file.read(bytes, size, bytes.length - size, size)
      if (value.bytesRead === 0) break
      size += value.bytesRead
    }
    const after = await file.stat({ bigint: true })
    need(
      BigInt(size) === before.size &&
        size <= limit &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs &&
        before.size === after.size &&
        before.uid === after.uid &&
        before.gid === after.gid &&
        before.mode === after.mode &&
        after.nlink === 1n,
    )
    return bytes.subarray(0, size)
  } finally {
    await file.close()
  }
}
export async function rootFile(name: string, limit: number) {
  await rootAncestry(name)
  const before = await fs.lstat(name, { bigint: true })
  need(
    before.isFile() && before.uid === 0n && before.gid === 0n && before.nlink === 1n && !(Number(before.mode) & 0o022),
  )
  const bytes = await boundedFile(name, limit)
  const after = await fs.lstat(name, { bigint: true })
  need(sameFile(before, after))
  return bytes
}
async function rootAncestry(name: string) {
  need(path.posix.isAbsolute(name) && path.posix.normalize(name) === name && (await fs.realpath(name)) === name)
  for (let parent = path.posix.dirname(name); ; parent = path.posix.dirname(parent)) {
    const info = await fs.lstat(parent)
    need(
      info.isDirectory() &&
        info.uid === 0 &&
        info.gid === 0 &&
        !(info.mode & 0o022) &&
        (await fs.realpath(parent)) === parent,
    )
    if (parent === "/") break
  }
}
const sameFile = (first: BigIntStats, second: BigIntStats) =>
  first.dev === second.dev &&
  first.ino === second.ino &&
  first.size === second.size &&
  first.mtimeNs === second.mtimeNs &&
  first.ctimeNs === second.ctimeNs &&
  first.mode === second.mode &&
  first.uid === second.uid &&
  first.gid === second.gid &&
  first.nlink === second.nlink

export async function verifyAssets(manifest: Manifest) {
  // The Root installer performs this before starting Host. Host/driver repeat before capture, then Engine
  // repeats after the actual global loader. Root-owned nonwritable ancestry excludes mutable package fallbacks.
  for (const asset of manifest.assets) {
    const name = `${ROOT}/${asset.path}`
    await rootAncestry(name)
    const linked = await fs.lstat(name, { bigint: true })
    const file = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await file.stat({ bigint: true })
      need(
        sameFile(linked, before) &&
          before.isFile() &&
          before.uid === 0n &&
          before.gid === 0n &&
          before.nlink === 1n &&
          !(Number(before.mode) & 0o022) &&
          before.size === BigInt(asset.bytes),
      )
      const hash = createHash("sha256")
      const buffer = Buffer.alloc(65_536)
      let size = 0
      while (true) {
        const block = await file.read(buffer, 0, Math.min(buffer.length, asset.bytes - size + 1), size)
        if (block.bytesRead === 0) break
        size += block.bytesRead
        need(size <= asset.bytes)
        hash.update(buffer.subarray(0, block.bytesRead))
      }
      need(
        size === asset.bytes &&
          hash.digest("hex") === asset.sha256 &&
          sameFile(before, await file.stat({ bigint: true })) &&
          sameFile(before, await fs.lstat(name, { bigint: true })),
      )
    } finally {
      await file.close()
    }
  }
}
export const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
export const counters = (spec: LinuxIsolation.PublicSpec, manifest: Manifest) =>
  `${spec.stage}/.native-shell-${manifest.nonce}`
export function validCase(value: string) {
  need([...CASES, "death"].some((item) => item === value))
  return value
}
export async function acknowledgement(
  manifest: Manifest,
  name: string,
  phase: "baseline" | "release" | "abort" | "stopped" | "summary",
) {
  need(name === "engine" || [...CASES, "death"].some((item) => item === name))
  const target = `${manifest.observer}/${name}-${phase}.ack`
  const deadline = Date.now() + 5_000
  while (true) {
    const info = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (info) {
      // Root is unmapped in the nested payload. The mapped agent must never own/write an acknowledgement.
      need(
        info.isFile() &&
          !info.isSymbolicLink() &&
          info.nlink === 1 &&
          info.size === 0 &&
          !(info.mode & 0o022) &&
          info.uid !== process.getuid?.() &&
          (await fs.realpath(target)) === target,
      )
      return
    }
    need(Date.now() < deadline, "Missing fixed host acknowledgement")
    await setTimeout(10)
  }
}

async function main() {
  need(process.platform === "linux" && process.getuid?.() === 1000 && process.getgid?.() === 1000)
  need(process.argv.length === 4)
  const mode = process.argv[2]
  const name = validCase(process.argv[3]!)
  need(
    mode !== undefined &&
      [
        "inspect",
        "nonzero",
        "timeout",
        "abort",
        "death",
        "stdio",
        "delayed",
        "pipe-source",
        "pipe-sink",
        "daemon",
      ].includes(mode),
  )
  // Public metadata is data here; only the external host supplies verdicts/Root authority.
  const manifest = decodeManifest(json(await boundedFile(MANIFEST, 16_384)))
  const spec = LinuxIsolation.decodeSpec(await boundedFile(LinuxIsolation.SPEC, 65_536))
  need(manifest.nonce === spec.nonce && manifest.observer === spec.container + "/native-shell-observer")
  const directory = counters(spec, manifest)
  const prefix = `${directory}/${name}-${mode}`
  await fs.writeFile(prefix + ".count", "1\n", { mode: 0o600, flag: "wx" })
  const namespaces = Object.fromEntries(
    await Promise.all(
      ["user", "mnt", "pid"].map(async (kind) => {
        const info = await fs.stat(`/proc/self/ns/${kind}`, { bigint: true })
        return [kind, { device: String(info.dev), inode: String(info.ino) }]
      }),
    ),
  )
  const ready = {
    v: 1,
    case: name,
    mode,
    pid: process.pid,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    namespaces,
  }
  await fs.writeFile(prefix + ".tmp", JSON.stringify(ready) + "\n", { mode: 0o600, flag: "wx" })
  await fs.rename(prefix + ".tmp", prefix + ".json")
  if (mode === "daemon") {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => {})
    setInterval(() => {}, 1000)
    return
  }
  if (["timeout", "abort", "death"].includes(mode)) {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => {})
    const daemon = spawn("/usr/bin/setsid", [manifest.runtimePath, PAYLOAD, "daemon", name], {
      stdio: "ignore",
      env: process.env,
    })
    daemon.once("error", () => {
      process.exitCode = 125
    })
    setInterval(() => {}, 1000)
    return
  }
  await acknowledgement(manifest, name, "release")
  if (mode === "pipe-source") {
    process.stdout.write("native-pipeline-input\n")
    return
  }
  if (mode === "delayed") {
    process.stdout.write("d".repeat(4096))
    return
  }
  if (mode === "stdio" || mode === "pipe-sink") {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      const block = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += block.length
      need(bytes <= 1_048_576)
      chunks.push(block)
    }
    const input = Buffer.concat(chunks)
    process.stdout.write(Buffer.concat([Buffer.from("OUT:"), input]))
    process.stderr.write(`ERR:${digest(input)}\n`)
    return
  }
  if (mode === "nonzero") {
    process.stdout.write("native-nonzero-stdout\n")
    process.stderr.write("native-nonzero-stderr\n")
    process.exitCode = 17
    return
  }
  need(mode === "inspect")
  const status = await fs.readFile("/proc/self/status", "utf8")
  need(/^Groups:\s*$/m.test(status) && /^NoNewPrivs:\s+1\s*$/m.test(status))
  for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])
    need(new RegExp(`^${field}:\\s+0+\\s*$`, "m").test(status))
  for (const variable of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "VECTOR_CLI_TOKEN",
    "DEEPSEEK_KEY",
    "VECTOR_GITHUB_SESSION_PROOF",
    "VECTOR_GITHUB_TOOL_PID_NAMESPACE",
  ])
    need(process.env[variable] === undefined)
  const parent: unknown = json(await boundedFile(`${directory}/engine.json`, 4096))
  exact(parent, ["pid"])
  need(typeof parent.pid === "number" && Number.isSafeInteger(parent.pid) && parent.pid > 1)
  let signaled = false
  try {
    process.kill(parent.pid, "SIGUSR2")
    signaled = true
  } catch (error) {
    need(error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM"))
  }
  need(!signaled)
  const targets = CANARY_ROOTS.flatMap((root) =>
    [root, "/proc/self/root" + root, "/proc/1/root" + root].map(
      (alias) => `${alias}/native-shell-canary-${manifest.nonce}`,
    ),
  )
  targets.push(
    `/var/run/native-shell-canary-${manifest.nonce}`,
    `${spec.stage}/native-shell-canary-link`,
    `/proc/${parent.pid}/cmdline`,
  )
  for (const target of targets) {
    let visible = false
    try {
      await fs.readFile(target)
      visible = true
    } catch (error) {
      need(
        error instanceof Error &&
          "code" in error &&
          ["ENOENT", "EACCES", "ESRCH", "EPERM"].includes(String(error.code)),
      )
    }
    need(!visible)
  }
  for (const base of LinuxIsolation.MASKS) {
    for (const alias of [base, "/proc/self/root" + base, "/proc/1/root" + base]) {
      let readonly = false
      try {
        await fs.writeFile(`${alias}/native-shell-write-${manifest.nonce}`, "denied", { flag: "wx" })
      } catch (error) {
        readonly = error instanceof Error && "code" in error && error.code === "EROFS"
      }
      need(readonly)
    }
  }
  const trusted = `${ROOT}/readonly-control.txt`
  let immutable = false
  try {
    await fs.writeFile(trusted, "denied")
  } catch (error) {
    immutable = error instanceof Error && "code" in error && error.code === "EROFS"
  }
  need(immutable)
  need(
    process.env.HOME === process.env.TMPDIR &&
      process.env.TMPDIR === process.env.RUNNER_TEMP &&
      typeof process.env.TMPDIR === "string" &&
      process.env.TMPDIR.startsWith(spec.scratch + "/"),
  )
  for (const root of [spec.stage, process.env.TMPDIR]) {
    const file = `${root}/native-shell-writable-${manifest.nonce}`
    await fs.writeFile(file, "writable\n", { flag: "wx", mode: 0o600 })
    need((await fs.readFile(file, "utf8")) === "writable\n")
    await fs.unlink(file)
  }
  process.stdout.write("native-inspect-stdout\n")
  process.stderr.write("native-inspect-stderr\n")
}

// The other two fixture bundles import only these shared pure/bounded helpers; they never run the payload role.
if (process.argv[1] === PAYLOAD)
  void main().catch(() => {
    process.stderr.write("Native Shell payload refused\n")
    process.exitCode = 125
  })
