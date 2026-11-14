import { EventEmitter } from "node:events"
import { registerHooks } from "node:module"
import { pathToFileURL } from "node:url"
import { readFile, appendFile } from "node:fs/promises"
import { installCapture, installLoopbackGuard, json, sha256 } from "./support.mjs"

if (process.versions.bun || !process.send) throw new Error("NODE_IPC_REQUIRED")
const settings = await json(process.argv[2])
if (sha256(await readFile(settings.bundle)) !== settings.identity.entrySha256) throw new Error("ENTRY_HASH_MISMATCH")
const parent = new EventEmitter()
parent.postMessage = (message) => process.send(message)
Object.defineProperty(process, "parentPort", { value: parent })
const recordBlock = (event) => {
  void appendFile(`${settings.out}/network-blocks.jsonl`, JSON.stringify(event) + "\n", { mode: 0o600 }).catch(() => {})
}
installLoopbackGuard(recordBlock)
installCapture(settings.out, settings.providerOrigin)
if (settings.dependencyPackage) {
  const anchor = pathToFileURL(settings.dependencyPackage).href
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context)
      } catch (error) {
        if (
          error.code !== "ERR_MODULE_NOT_FOUND" ||
          specifier.startsWith(".") ||
          specifier.startsWith("/") ||
          (specifier.includes(":") && !specifier.startsWith("node:"))
        )
          throw error
        return next(specifier, { ...context, parentURL: anchor })
      }
    },
  })
}
let server
let started = false
process.on("message", async (command) => {
  if (command?.type === "stop" && settings.entryKind === "server") {
    await server?.stop(true)
    process.send({ type: "stopped" })
    process.exit(0)
  }
  if (settings.entryKind === "packaged-sidecar") {
    parent.emit("message", { data: command })
    return
  }
  if (command?.type !== "start" || started) return
  started = true
  try {
    const entry = await import(pathToFileURL(settings.bundle).href)
    if (typeof entry.Server?.listen !== "function") throw new Error("SERVER_EXPORT_MISSING")
    server = await entry.Server.listen({
      hostname: "127.0.0.1",
      port: command.port,
      username: "vector",
      password: command.password,
      cors: ["oc://renderer"],
    })
    process.send({ type: "ready" })
  } catch (error) {
    process.send({ type: "error", error: { message: String(error.message) } })
    process.exitCode = 1
  }
})
const memory = setInterval(
  () =>
    process.send?.({
      type: "memory",
      at: Date.now(),
      ...process.memoryUsage(),
    }),
  100,
)
memory.unref()
process.send({
  type: "runtime",
  versions: { node: process.versions.node, v8: process.versions.v8 },
  platform: process.platform,
  arch: process.arch,
})
if (settings.entryKind === "packaged-sidecar") await import(pathToFileURL(settings.bundle).href)
process.send({ type: "bootstrap-ready" })
