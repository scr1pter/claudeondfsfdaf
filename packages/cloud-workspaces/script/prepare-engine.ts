import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../../..")
const output = process.argv[2]
if (!output || !path.isAbsolute(output)) throw new Error("Supply a new absolute build-context directory.")
const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
if (status.trim() && !process.argv.includes("--preview"))
  throw new Error(
    "Commit the reviewed source before preparing a production engine; --preview permits a local test context.",
  )
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
const catalog = path.join(root, "packages/web/public/models/api.json")
const catalogSha256 = createHash("sha256")
  .update(await readFile(catalog))
  .digest("hex")
execFileSync(process.execPath, ["--no-env-file", "script/build-node.ts"], {
  cwd: path.join(root, "packages/engine"),
  stdio: "inherit",
  env: { ...process.env, VECTOR_RELEASE_CATALOG_PATH: catalog, VECTOR_RELEASE_CATALOG_SHA256: catalogSha256 },
})
await mkdir(output)
await cp(path.join(root, "packages/engine/dist/node/node.js"), path.join(output, "engine.mjs")).catch(
  async (error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      await cp(path.join(root, "packages/engine/dist/node/index.js"), path.join(output, "engine.mjs"))
      return
    }
    throw error
  },
)
await cp(path.join(root, "packages/cloud-workspaces/worker/entry.mjs"), path.join(output, "entry.mjs"))
for (const file of await readdir(path.join(root, "packages/engine/dist/node"))) {
  if (file.endsWith(".js") || file.endsWith(".map")) continue
  await cp(path.join(root, "packages/engine/dist/node", file), path.join(output, file))
}
const require = createRequire(path.join(root, "packages/core/package.json"))
const runtimePackages = ["jsonc-parser", "@lydell/node-pty", `@lydell/node-pty-linux-${process.arch}`]
for (const name of runtimePackages) {
  const resolver = name.startsWith("@lydell/node-pty-") ? createRequire(require.resolve("@lydell/node-pty")) : require
  let location = path.dirname(await realpath(resolver.resolve(name)))
  while (true) {
    const metadata = await readFile(path.join(location, "package.json"), "utf8")
      .then((text) => JSON.parse(text) as { name?: string })
      .catch(() => undefined)
    if (metadata?.name === name) break
    if (path.dirname(location) === location) throw new Error(`Cannot resolve the pinned runtime package ${name}.`)
    location = path.dirname(location)
  }
  await mkdir(path.dirname(path.join(output, "node_modules", name)), { recursive: true })
  await cp(location, path.join(output, "node_modules", name), { recursive: true, dereference: true })
}
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"])
  await cp(path.join(root, name), path.join(output, name))
await writeFile(
  path.join(output, "CONTAINER-INFO.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      sourceRevision: revision,
      preview: Boolean(status.trim()),
      catalogSha256,
      engineSha256: createHash("sha256")
        .update(await readFile(path.join(output, "engine.mjs")))
        .digest("hex"),
      workerSha256: createHash("sha256")
        .update(await readFile(path.join(output, "entry.mjs")))
        .digest("hex"),
      platform: "linux",
      arch: process.arch,
      runtimePackages,
    },
    null,
    2,
  ) + "\n",
)
console.info(`Prepared cloud engine context at ${output}.`)
