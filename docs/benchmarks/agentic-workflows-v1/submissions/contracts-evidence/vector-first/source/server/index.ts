import { createHandler } from "./api"
import { openStore } from "./storage"

const store = openStore(process.env.DATA_DIR ?? ".data")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4123),
  // 128 maximum-sized bodies can exceed Bun's default request limit, especially escaped JSON.
  maxRequestBodySize: 1024 * 1024 * 1024,
  fetch: createHandler(store),
})

console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${server.port}` }))
function stop() { server.stop(true); store.close(); process.exit(0) }
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
