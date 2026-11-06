// Only called after verify-release-evidence admitted the pinned release archive.
import assert from "node:assert/strict"
import { access, cp, lstat, mkdir } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

assert.equal(process.argv.length, 3, "Usage: node extract-release-evidence.mjs WORK_DIRECTORY")
const root = path.resolve(process.argv[2])
const resources = path.join(root, "image", "squashfs-root", "resources")
const destination = path.join(root, "app")
// Resolve the exact extractor already locked by the desktop build; do not install a floating CLI.
const desktop = createRequire(new URL("../../packages/desktop/package.json", import.meta.url))
const builder = createRequire(desktop.resolve("electron-builder/package.json"))
const library = createRequire(builder.resolve("app-builder-lib/package.json"))
const { extractAll } = await import(library.resolve("@electron/asar"))
await access(path.join(resources, "app.asar"))
await mkdir(destination)
extractAll(path.join(resources, "app.asar"), destination)
const unpacked = path.join(resources, "app.asar.unpacked")
if (
  await lstat(unpacked).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
)
  await cp(unpacked, destination, { recursive: true, force: true })
await access(path.join(destination, "out", "main", "sidecar.js"))
