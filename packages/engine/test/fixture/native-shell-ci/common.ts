// CI-only control code. These receipts name the reviewed trusted workflow, not a production authorization API.
import fs, { type BigIntStats } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

export const ROOT = "/usr/libexec/vector-native-shell"
export const CONTROL = "/usr/libexec/vector-native-shell-control"
export const TEMP = "/home/runner/work/_temp"
export const WORKSPACE = "/home/runner/work/vector-native-shell-checkout"
export const OUTPUT = `${TEMP}/native-shell-build`
export const READER_SHA = "ea2b75c02ca96de84b8628bb058b152afa866327f926049df7fa24e5ff9cc05f"
export const CATALOG_SHA = "784309673addec6790370607fa73cdeb6d7cede19a2406b7c39d20de2183aaf3"
export const ACTIONS = Object.freeze({
  node: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  bun: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
})
export const SUPPORT = Object.freeze({
  "ort-wasm-simd-threaded-r821n12y.wasm": "3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2",
  "photon_rs_bg-bq08arze.wasm": "10468181565c56004c867f3a4af96f89a0ef5a63a72f2b5fb12c1f1992a3615c",
  "tree-sitter-3jzf13jk.wasm": "f38dcc4b43b818f9a0785bc1c6d5611a75ac4cdd428ff3f02757c34ca4e46d7f",
  "tree-sitter-bash-hq5s6fxb.wasm": "364f0a2cd385c792239423026ef442dbd073d34c396b7bc9e5932426b8e4aa5d",
  "tree-sitter-powershell-ryb2ffqs.wasm": "1d30b5a21866354aa2eb94845556f1e19126ff00e3335048719a0e6435b1c154",
})
export interface Asset {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}
export interface Cell {
  readonly runtime: "node" | "bun"
  readonly mode: "own-key" | "codium"
  readonly family: "baseline" | "engine-death"
}
export function need(value: unknown): asserts value {
  if (!value) throw new Error("Native Shell CI control refused")
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
export function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  need(object(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)))
}
export const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
export const hashValue = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
export const revision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value)
export function ci() {
  need(
    process.platform === "linux" &&
      process.arch === "x64" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      process.env.RUNNER_TEMP === TEMP &&
      process.env.VECTOR_AGENT_SUDO !== "1",
  )
}
export function cell(runtime: unknown, mode: unknown, family: unknown): Cell {
  need(runtime === "node" || runtime === "bun")
  need(mode === "own-key" || mode === "codium")
  need(family === "baseline" || family === "engine-death")
  return { runtime, mode, family }
}
export function controllerAction(args: readonly string[]) {
  need(
    args.length === 3 &&
      args[0] === "github" &&
      args[1] === "sandbox" &&
      (args[2] === "prepare" || args[2] === "finish"),
  )
  return args[2]
}
export function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    value.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part))
  )
}
export function assets(value: unknown): Asset[] {
  need(Array.isArray(value) && value.length > 0 && value.length <= 32)
  const result = value.map((entry: unknown): Asset => {
    exact(entry, ["path", "bytes", "sha256"])
    need(
      safePath(entry.path) &&
        typeof entry.bytes === "number" &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0 &&
        entry.bytes <= 268_435_456 &&
        hashValue(entry.sha256),
    )
    return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }
  })
  need(
    result.every((entry, index) => index === 0 || result[index - 1].path < entry.path) &&
      result.reduce((n, entry) => n + entry.bytes, 0) <= 536_870_912,
  )
  return result
}
const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.nlink === b.nlink
export function ancestry(name: string) {
  need(path.isAbsolute(name) && path.normalize(name) === name && fs.realpathSync(name) === name)
  for (let parent = path.dirname(name); ; parent = path.dirname(parent)) {
    const info = fs.lstatSync(parent)
    need(
      info.isDirectory() &&
        info.uid === 0 &&
        info.gid === 0 &&
        !(info.mode & 0o022) &&
        fs.realpathSync(parent) === parent,
    )
    if (parent === "/") break
  }
}
export function stream(
  name: string,
  options: { root?: boolean; expected?: Pick<Asset, "bytes" | "sha256">; collect?: number; destination?: number } = {},
) {
  need(path.isAbsolute(name) && path.normalize(name) === name && fs.realpathSync(name) === name)
  if (options.root !== false) ancestry(name)
  const linked = fs.lstatSync(name, { bigint: true })
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    need(
      same(linked, before) &&
        before.isFile() &&
        before.nlink === 1n &&
        before.size >= 0n &&
        before.size <= 268_435_456n,
    )
    if (options.root !== false) need(before.uid === 0n && before.gid === 0n && !(Number(before.mode) & 0o022))
    if (options.expected) need(before.size === BigInt(options.expected.bytes))
    if (options.collect !== undefined) need(before.size <= BigInt(options.collect))
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65_536),
      chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - total + 1), total)
      if (!count) break
      total += count
      need(total <= Number(before.size))
      hash.update(buffer.subarray(0, count))
      if (options.collect !== undefined) chunks.push(Buffer.from(buffer.subarray(0, count)))
      if (options.destination !== undefined) {
        let written = 0
        while (written < count) {
          const step = fs.writeSync(options.destination, buffer, written, count - written)
          need(step > 0)
          written += step
        }
      }
    }
    const sha256 = hash.digest("hex")
    need(
      total === Number(before.size) &&
        same(before, fs.fstatSync(fd, { bigint: true })) &&
        same(before, fs.lstatSync(name, { bigint: true })),
    )
    if (options.expected) need(sha256 === options.expected.sha256)
    return { bytes: total, sha256, data: options.collect === undefined ? undefined : Buffer.concat(chunks) }
  } finally {
    fs.closeSync(fd)
  }
}
export function jsonFile(name: string, root = true, limit = 16_384): unknown {
  const value = stream(name, { root, collect: limit }).data
  need(value)
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value))
}
export function writeJSON(name: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value) + "\n")
  need(bytes.length <= 16_384)
  fs.writeFileSync(name, bytes, { flag: "wx", mode: 0o444 })
}
export function install(
  source: string,
  destination: string,
  expected: Pick<Asset, "bytes" | "sha256">,
  trustedSource = true,
  mode = 0o555,
): Asset {
  const fd = fs.openSync(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  )
  try {
    stream(source, { root: trustedSource, expected, destination: fd })
    fs.fchmodSync(fd, mode)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  stream(destination, { expected })
  return { path: path.basename(destination), bytes: expected.bytes, sha256: expected.sha256 }
}
export function control() {
  ci()
  const value = jsonFile(`${CONTROL}/receipt.json`)
  exact(value, [
    "v",
    "sourceRevision",
    "assetSHA256",
    "readerSHA256",
    "catalogSHA256",
    "workerSHA256",
    "provisionSHA256",
    "runtime",
    "mode",
    "family",
    "workspace",
    "assets",
  ])
  need(
    value.v === 1 &&
      revision(value.sourceRevision) &&
      hashValue(value.assetSHA256) &&
      value.readerSHA256 === READER_SHA &&
      value.catalogSHA256 === CATALOG_SHA &&
      hashValue(value.workerSHA256) &&
      hashValue(value.provisionSHA256) &&
      value.workspace === WORKSPACE,
  )
  const selected = cell(value.runtime, value.mode, value.family),
    files = assets(value.assets)
  const required = new Set([
    "runtime/node",
    "runtime/bun",
    "bootstrap.mjs",
    "controller.mjs",
    "preflight.mjs",
    "manage.mjs",
    "vector",
    "cell.json",
    "provision.json",
  ])
  need(files.length === required.size && files.every((entry) => required.has(entry.path)))
  for (const entry of files) stream(`${CONTROL}/${entry.path}`, { expected: entry })
  need(files.some((entry) => entry.path === "provision.json" && entry.sha256 === value.provisionSHA256))
  const provenance = jsonFile(`${CONTROL}/provision.json`)
  exact(provenance, [
    "v",
    "sourceRevision",
    "trust",
    "actions",
    "nodeVersion",
    "bunVersion",
    "runtimes",
    "bootstrap",
    "sources",
  ])
  exact(provenance.actions, ["node", "bun"])
  need(
    provenance.v === 1 &&
      provenance.sourceRevision === value.sourceRevision &&
      provenance.trust === "pinned-setup-actions-in-trusted-ci-before-payload" &&
      provenance.actions.node === ACTIONS.node &&
      provenance.actions.bun === ACTIONS.bun &&
      provenance.nodeVersion === "24.15.0" &&
      provenance.bunVersion === "1.3.14",
  )
  const runtimes = assets(provenance.runtimes)
  need(
    runtimes.length === 2 &&
      runtimes[0].path === "runtime/bun" &&
      runtimes[1].path === "runtime/node" &&
      runtimes.every((entry) =>
        files.some((file) => file.path === entry.path && file.bytes === entry.bytes && file.sha256 === entry.sha256),
      ),
  )
  const bootstrap = provenance.bootstrap
  exact(bootstrap, ["bytes", "sha256"])
  need(
    typeof bootstrap.bytes === "number" &&
      Number.isSafeInteger(bootstrap.bytes) &&
      bootstrap.bytes > 0 &&
      bootstrap.bytes <= 268_435_456 &&
      hashValue(bootstrap.sha256),
  )
  need(
    ["bootstrap.mjs", "manage.mjs"].every((name) =>
      files.some(
        (entry) => entry.path === name && entry.bytes === bootstrap.bytes && entry.sha256 === bootstrap.sha256,
      ),
    ),
  )
  const sources = assets(provenance.sources)
  need(
    sources.length === 2 &&
      sources[0].path === "packages/engine/test/fixture/native-shell-ci/common.ts" &&
      sources[1].path === "packages/engine/test/fixture/native-shell-ci/manage.ts",
  )
  const configured = jsonFile(`${CONTROL}/cell.json`)
  exact(configured, ["runtime", "mode", "family"])
  need(
    configured.runtime === selected.runtime &&
      configured.mode === selected.mode &&
      configured.family === selected.family,
  )
  return { ...selected, sourceRevision: value.sourceRevision, assetSHA256: value.assetSHA256, files }
}
