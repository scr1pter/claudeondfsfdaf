// Source compilation only; emitted controller/Reader/fixtures are never imported here.
import fs from "node:fs/promises"
import path from "node:path"
import { builtinModules } from "node:module"
import {
  linuxIsolationBuildPlugin,
  linuxIsolationCIMode,
  linuxIsolationDefines,
} from "../../../../../script/linux-isolation-asset"
import { bundleBrainWorker } from "../../../script/brain-worker"
import { brainWorkerModule } from "../../../script/brain-worker-module"
import { catalogBody } from "../../../script/release-catalog"
import { allowed, unguardedBunReferences } from "../../../script/node-bundle-guard"
import {
  ACTIONS,
  CONTROL,
  OUTPUT,
  CATALOG_SHA,
  READER_SHA,
  SUPPORT,
  ci,
  need,
  sha,
  revision,
  jsonFile,
  object,
  stream,
  assets,
} from "./common"

ci()
need(
  process.argv.length === 3 &&
    linuxIsolationCIMode(process.argv, process.env.GITHUB_ACTIONS) &&
    process.versions.bun === "1.3.14",
)
const checkout = await fs.realpath(path.join(import.meta.dir, "../../../../.."))
need(checkout === process.env.GITHUB_WORKSPACE && revision(process.env.GITHUB_SHA))
const sourceRevision = process.env.GITHUB_SHA
const provision = jsonFile(`${CONTROL}/provision.json`)
need(
  object(provision) &&
    provision.sourceRevision === sourceRevision &&
    provision.trust === "pinned-setup-actions-in-trusted-ci-before-payload" &&
    object(provision.actions) &&
    provision.actions.node === ACTIONS.node &&
    provision.actions.bun === ACTIONS.bun,
)
const provisionSHA256 = stream(`${CONTROL}/provision.json`).sha256
const sources = assets(provision.sources)
need(
  sources.length === 2 &&
    sources[0].path === "packages/engine/test/fixture/native-shell-ci/common.ts" &&
    sources[1].path === "packages/engine/test/fixture/native-shell-ci/manage.ts",
)
for (const source of sources) stream(path.join(checkout, source.path), { root: false, expected: source })
need(sha(await fs.readFile(path.join(checkout, "packages/core/src/directory-identity.ts"))) === READER_SHA)
const catalog = await fs.readFile(path.join(checkout, "packages/web/public/models/api.json"), "utf8")
need(sha(catalog) === CATALOG_SHA && catalogBody(catalog) === catalog)
const isolation = await linuxIsolationBuildPlugin(true)
const asset: unknown = JSON.parse((await linuxIsolationDefines(true)).VECTOR_LINUX_ISOLATION_ASSET)
need(object(asset) && typeof asset.sha256 === "string")
const identity = { version: "0.0.0-native-shell-ci", channel: "native-shell-ci" }
const worker = await bundleBrainWorker(identity, isolation)
const define = {
  VECTOR_VERSION: JSON.stringify(identity.version),
  VECTOR_CHANNEL: JSON.stringify(identity.channel),
  VECTOR_MODEL_CATALOG: catalog,
}
// Match the existing non-embedded CLI seam; no App is built, started or part of this Shell witness.
const files = { "brain-worker.gen.ts": brainWorkerModule(worker), "vector-web-ui.gen.ts": "export default {}" }
await fs.mkdir(OUTPUT, { mode: 0o700 })
const outputs: Array<{ path: string; bytes: number; sha256: string; kind: string }> = []
const imports: Array<{ path: string; imports: ReadonlyArray<{ path: string; kind: string }> }> = []
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "node:sqlite",
  "bun:sqlite",
  "bun:ffi",
])
const parser = new Bun.Transpiler({ loader: "js" })
// The existing two exceptions use Engine-cwd module headers; this build and the bootstrap compile run at repo root.
const nodeAllowed = allowed.map((entry) => ({
  module: path.posix.normalize(path.posix.join("packages/engine", entry.module)),
  api: entry.api,
}))
async function retain(entry: string, target: "node" | "bun", relative: string, expected: number) {
  const directory = path.join(OUTPUT, path.dirname(relative))
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const result = await Bun.build({
    entrypoints: [entry],
    target,
    format: "esm",
    plugins: [isolation],
    external: ["@lydell/node-pty"],
    define,
    files,
  })
  if (!result.success) throw new AggregateError(result.logs, "Native Shell source build refused")
  need(result.outputs.length === expected)
  for (const output of result.outputs) {
    const name = path.basename(output.path)
    const entrypoint = output.kind === "entry-point"
    if (entrypoint) need(name === path.basename(entry).replace(/\.ts$/, ".js"))
    const allowedAsset = Object.hasOwn(SUPPORT, name)
    need(entrypoint || (relative.endsWith("native-shell-engine.js") && allowedAsset && output.kind === "asset"))
    const destination = entrypoint ? path.join(OUTPUT, relative) : path.join(directory, name)
    const bytes = new Uint8Array(await output.arrayBuffer())
    if (entrypoint) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      if (target === "node") need(unguardedBunReferences(text, nodeAllowed).length === 0)
      const scanned = parser.scan(text).imports
      // No required external package is resolved from mutable workspace/node_modules. Optional PTY is never used.
      // Bun 1.3.14 embeds this third-party alias before filesystem resolution; Node must still bundle it.
      // https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/resolve_builtins/HardcodedModule.zig#L377
      need(
        scanned.every(
          (item) =>
            builtins.has(item.path) ||
            item.path === "@lydell/node-pty" ||
            (target === "bun" && item.path === "node-fetch"),
        ),
      )
      imports.push({ path: path.relative(OUTPUT, destination), imports: scanned })
      if (relative.endsWith("native-shell-engine.js")) {
        for (const support of Object.keys(SUPPORT)) need(text.includes(JSON.stringify(`./${support}`)))
      }
    }
    await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 })
    outputs.push({
      path: path.relative(OUTPUT, destination),
      bytes: bytes.length,
      sha256: sha(bytes),
      kind: output.kind,
    })
  }
}
for (const target of ["node", "bun"] as const)
  for (const name of ["engine", "host", "payload"] as const)
    await retain(
      path.join(import.meta.dir, `../native-shell-${name}.ts`),
      target,
      `${target}/native-shell-${name}.js`,
      name === "engine" ? 6 : 1,
    )
for (const name of ["controller", "preflight", "manage"])
  await retain(path.join(import.meta.dir, `${name}.ts`), "node", `control/${name}.mjs`, 1)
for (const target of ["node", "bun"] as const)
  for (const entry of [
    "packages/core/src/process-isolation/build.ts",
    "packages/engine/src/cli/cmd/github.isolation-build.ts",
  ]) {
    const result = await Bun.build({
      entrypoints: [path.join(checkout, entry)],
      target,
      format: "esm",
      plugins: [isolation],
    })
    need(result.success && result.outputs.length === 1)
    const text = await result.outputs[0].text()
    need(text.includes(asset.sha256) && text.includes("var enabled = true"))
  }
outputs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
const receipt = {
  v: 1,
  sourceRevision,
  assetSHA256: asset.sha256,
  readerSHA256: READER_SHA,
  catalogSHA256: CATALOG_SHA,
  workerSHA256: sha(worker),
  provisionSHA256,
  outputs,
}
const bytes = Buffer.from(JSON.stringify(receipt) + "\n")
need(bytes.length <= 16_384 && outputs.length === 19)
await fs.writeFile(`${OUTPUT}/receipt.json`, bytes, { flag: "wx", mode: 0o600 })
await fs.writeFile(`${OUTPUT}/imports.json`, JSON.stringify(imports) + "\n", { flag: "wx", mode: 0o600 })
need(process.env.GITHUB_OUTPUT)
await fs.appendFile(process.env.GITHUB_OUTPUT, `receipt_sha256=${sha(bytes)}\n`)
