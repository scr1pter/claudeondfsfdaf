import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { createDockerRuntime } from "./docker.js"
import { createWorkspaceService } from "./service.js"
import { WorkspaceStore } from "./store.js"

const directory = resolve(process.env.VECTOR_WORKSPACES_DATA ?? "./data")
mkdirSync(directory, { recursive: true, mode: 0o700 })
const secret = required("VECTOR_WORKSPACES_SECRET")
const port = integer("PORT", 4097, 1024, 65535)
const development = process.env.NODE_ENV !== "production" && process.env.VECTOR_WORKSPACES_DEV_UNSAFE === "true"
const runtime = createDockerRuntime({
  image: required("VECTOR_WORKSPACES_IMAGE"),
  network: required("VECTOR_WORKSPACES_NETWORK"),
  runtime: process.env.VECTOR_WORKSPACES_RUNTIME ?? "runsc",
  volumeDriver: process.env.VECTOR_WORKSPACES_VOLUME_DRIVER,
  volumeSizeOption: process.env.VECTOR_WORKSPACES_VOLUME_SIZE_OPTION,
  allowInsecure: development,
})
const store = new WorkspaceStore({
  path: resolve(directory, "workspaces.sqlite"),
  maxActivePerAccount: integer("VECTOR_WORKSPACES_MAX_ACTIVE", 2, 1, 10),
  maxTotalPerAccount: integer("VECTOR_WORKSPACES_MAX_TOTAL", 10, 1, 100),
})
const service = createWorkspaceService({
  store,
  runtime,
  secret,
  nonceDatabase: resolve(directory, "requests.sqlite"),
  relayOrigin: process.env.VECTOR_WORKSPACES_RELAY_ORIGIN ?? `http://host.docker.internal:${port}`,
  model: {
    id: required("VECTOR_WORKSPACES_MODEL"),
    name: process.env.VECTOR_WORKSPACES_MODEL_NAME ?? required("VECTOR_WORKSPACES_MODEL"),
    origin: required("VECTOR_WORKSPACES_MODEL_ORIGIN"),
    key: required("VECTOR_WORKSPACES_MODEL_KEY"),
    maxOutputTokens: integer("VECTOR_WORKSPACES_MAX_OUTPUT", 4096, 1, 16384),
  },
  maxModelCalls: integer("VECTOR_WORKSPACES_MAX_MODEL_CALLS", 50, 1, 1000),
  maxRunMs: integer("VECTOR_WORKSPACES_MAX_RUN_MINUTES", 120, 1, 1440) * 60_000,
})
await service.recover()
const server = Bun.serve({
  hostname: process.env.HOST ?? "0.0.0.0",
  port,
  maxRequestBodySize: 1_000_000,
  idleTimeout: 255,
  fetch: (request) => service.fetch(request),
})
const reaper = setInterval(() => {
  void service.reap().catch(() => console.error("Cloud workspace cleanup needs attention."))
}, 20_000)
console.info(`Vector cloud workspace service listening on port ${server.port}.`)

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  clearInterval(reaper)
  await server.stop()
  await service.close()
  store.close()
}
process.once("SIGTERM", () => {
  void shutdown()
})
process.once("SIGINT", () => {
  void shutdown()
})

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Configure ${name} before starting the cloud workspace service.`)
  return value
}
function integer(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}.`)
  return value
}
