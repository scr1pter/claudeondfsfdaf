import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHandler } from "./backend/api.mjs"
import { openStore } from "./backend/store.mjs"

let store
let server
let closing = false
let released = false

function release() {
  if (!store || released) return
  store.close()
  released = true
}

function diagnostic(code, message) {
  process.stderr.write(JSON.stringify({ error: { code, message } }) + "\n")
}

function shutdown(exitCode = 0) {
  if (closing) return
  closing = true
  process.exitCode = exitCode
  const finish = () => {
    clearTimeout(deadline)
    try { release() } catch {
      diagnostic("shutdown_failed", "Cannot release the local store")
      process.exitCode = 1
    }
  }
  // Bound shutdown even when a client has left a request body incomplete.
  const deadline = setTimeout(() => server.closeAllConnections(), 2_000)
  deadline.unref()
  server.close(finish)
}

try {
  const port = Number(process.env.PORT || 4125)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port")
  const directory = process.env.DATA_DIR || join(tmpdir(), "ledgerdesk")
  store = openStore({ directory })
  server = createServer(createHandler(store))
  server.on("error", () => {
    diagnostic("server_start_failed", "Cannot bind the local service")
    if (server.listening) shutdown(1)
    else {
      process.exitCode = 1
      try { release() } catch {
        diagnostic("shutdown_failed", "Cannot release the local store")
      }
    }
  })
  process.once("SIGTERM", () => shutdown())
  process.once("SIGINT", () => shutdown())
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`LedgerDesk listening on http://127.0.0.1:${server.address().port}\n`)
  })
} catch {
  process.exitCode = 1
  diagnostic("startup_failed", "Cannot open the local service")
  try { release() } catch {
    diagnostic("shutdown_failed", "Cannot release the local store")
  }
}
