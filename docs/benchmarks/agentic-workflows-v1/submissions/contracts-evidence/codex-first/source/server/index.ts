import { openStore } from "./storage"
import { createHandler } from "./api"

const store = openStore(process.env.DATA_DIR ?? ".data")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4123),
  // JSON escaping can expand each permitted body byte into six request bytes.
  maxRequestBodySize: 1024 * 1024 * 1024,
  fetch: createHandler(store),
})

console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${server.port}` }))
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { server.stop(); store.close(); process.exit(0) })
