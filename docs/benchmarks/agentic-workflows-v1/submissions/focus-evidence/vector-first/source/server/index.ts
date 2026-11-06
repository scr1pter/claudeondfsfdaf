import { openStore } from "./storage"
import { createHandler } from "./http"

const store = openStore(process.env.DATA_DIR ?? ".data")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4123),
  maxRequestBodySize: 160 * 1024 * 1024,
  fetch: createHandler(store),
})

console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${server.port}` }))
const shutdown = () => { server.stop(true); store.close(); process.exit(0) }
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
