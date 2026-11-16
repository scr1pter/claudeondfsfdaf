// The account gateway and workspace supervisor authenticate the user. Embed the
// existing server as desktop does; never put a long-lived account token in tools.
if (process.env.VECTOR_CLOUD_WORKSPACE_WORKER !== "1" ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(process.env.VECTOR_SERVER_PASSWORD ?? "")) {
  throw new Error("The cloud engine requires its workspace supervisor and a scoped server credential.")
}
const { Server } = await import("./engine.mjs")
const listener = await Server.listen({ hostname: "0.0.0.0", port: 4096, trustedNetwork: true, cors: [] })
let closing = false
async function close() {
  if (closing) return
  closing = true
  await listener.stop(true)
}
process.once("SIGTERM", () => { void close() })
process.once("SIGINT", () => { void close() })
console.info("Vector cloud workspace engine is ready.")
