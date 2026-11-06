import { createServer } from "node:http"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { createHandler } from "./backend/api.mjs"
import { openStore } from "./backend/data.mjs"

const sourceDirectory = dirname(fileURLToPath(import.meta.url))

function configuration() {
  if (!process.env.DATA_DIR?.trim()) throw new Error("DATA_DIR is required")
  const directory = resolve(process.env.DATA_DIR)
  const sourceRelative = relative(sourceDirectory, directory)
  if (sourceRelative === "" || (sourceRelative !== ".." && !sourceRelative.startsWith(`..${sep}`) && !isAbsolute(sourceRelative))) {
    throw new Error("DATA_DIR must be outside the authored source directory")
  }
  const rawPort = process.env.PORT || "4125"
  if (!/^\d+$/.test(rawPort)) throw new Error("PORT must be an integer from 1 through 65535")
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 through 65535")
  return { directory, port }
}

function startupFailure() {
  process.stderr.write(JSON.stringify({ error: { code: "server_start_failed", message: "Cannot start the local service; check configuration, data integrity and directory ownership" } }) + "\n")
  process.exitCode = 1
}

let store
let server
let stopping = false

async function shutdown() {
  if (stopping) return
  stopping = true
  if (server?.listening) {
    const closed = new Promise((done) => server.close(done))
    server.closeIdleConnections()
    server.closeAllConnections()
    await closed
  }
  await store?.close()
}

try {
  const { directory, port } = configuration()
  store = await openStore(directory)
  server = createServer(createHandler(store))
  await new Promise((done, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", done)
  })
  server.on("error", async () => {
    startupFailure()
    await shutdown()
  })
  process.once("SIGTERM", () => { shutdown().catch(startupFailure) })
  process.once("SIGINT", () => { shutdown().catch(startupFailure) })
} catch {
  startupFailure()
  await shutdown()
}
