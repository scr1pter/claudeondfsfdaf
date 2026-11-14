import { queryOptions } from "@tanstack/solid-query"
import type { VectorClient } from "@vectordevai/sdk/v2/client"
import type { ServerScope } from "@/utils/server-scope"

/*
 * What the connected engine can do, from `GET /experimental/capabilities` (I30). The desktop uses each feature only
 * behind its flag: a missing flag, a non-JSON answer or an HTML page (an engine older than the route, or a web server
 * in front of it) means "unsupported", so a new desktop on an older engine hides what that engine lacks.
 */

export const FLAGS = [
  "backgroundSubagents",
  "workDelegation",
  "subagentLimits",
  "sessionStop",
  "taskPromote",
  "taskResume",
  "taskAttention",
  "taskIsolation",
  "workflows",
  "backgroundShells",
  "vectorscopeSettings",
  "vectorscopeRuns",
  "vectorscopeReviewMemoryControls",
  "connections",
] as const

export type EngineFlag = (typeof FLAGS)[number]
export type EngineCapabilities = Readonly<Record<EngineFlag, boolean>>

/** Every flag off: what an engine without the route, or one that answered with something else, reads as. */
export const NO_CAPABILITIES: EngineCapabilities = Object.freeze(
  Object.fromEntries(FLAGS.map((flag) => [flag, false])) as Record<EngineFlag, boolean>,
)

/** A flag is on only when the engine sent `true` for it; anything else, or an answer that is not an object, is off. */
export function parseCapabilities(data: unknown): EngineCapabilities {
  if (!data || typeof data !== "object" || Array.isArray(data)) return NO_CAPABILITIES
  const record = data as Record<string, unknown>
  return Object.fromEntries(FLAGS.map((flag) => [flag, record[flag] === true])) as Record<EngineFlag, boolean>
}

// The SDK's response interceptor throws this for a text/html answer (packages/sdk/js/src/v2/client.ts).
const HTML_ANSWER = /Server responded with text\/html/

type CapabilitiesClient = {
  experimental: { capabilities: Pick<VectorClient["experimental"]["capabilities"], "get"> }
}

/**
 * Reads the flags once. Any answer the engine gave (a 404, an error status, HTML, text or JSON that is not an object)
 * is final and reads as every flag off. Only a failure with no answer at all (the network) throws, so the query
 * retries it instead of hiding features until the next reconnect.
 */
export async function readEngineCapabilities(client: CapabilitiesClient, signal?: AbortSignal) {
  const result = await client.experimental.capabilities
    .get(undefined, { throwOnError: false, signal: signal ?? AbortSignal.timeout(30_000) })
    .catch((error: unknown) => {
      if (error instanceof Error && HTML_ANSWER.test(error.message)) return undefined
      throw error
    })
  if (!result) return NO_CAPABILITIES
  if (!result.response) throw result.error instanceof Error ? result.error : new Error("Cannot reach the engine")
  if (!result.response.ok) return NO_CAPABILITIES
  return parseCapabilities(result.data)
}

/**
 * Whether an engine event may change what its flags say (server-sync.tsx reads them again): a reconnect may reach
 * another engine, and a reload of its settings may turn workflows on or off. A global config save emits
 * `global.disposed`; a folder that waited for its running work reloads later, with `server.instance.disposed`.
 */
export function capabilitiesChanged(type: string, reconnect: boolean) {
  return (type === "server.connected" && reconnect) || type === "global.disposed" || type === "server.instance.disposed"
}

/** The server-sync query: one copy per server, refetched after a reconnect or a settings reload (server-sync.tsx). */
export const engineCapabilitiesQuery = (scope: ServerScope, client: CapabilitiesClient) =>
  queryOptions<EngineCapabilities>({
    queryKey: [scope, "capabilities"] as const,
    queryFn: ({ signal }) => readEngineCapabilities(client, signal),
    staleTime: Infinity,
  })

/** The first engine that joins a message into the running turn (`prompt_async`) instead of refusing it. */
export const STEER_SINCE = "1.99.100"

function versionParts(version: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/**
 * Whether the engine can take a follow-up while it works (5.I.1). Engines before 1.99.100, as `/global/health` reports
 * them, queue instead. An unknown or unreadable version steers: only a known older engine is held back.
 */
export function steerSupported(version: string | undefined) {
  if (!version) return true
  const parts = versionParts(version)
  if (!parts) return true
  const since = versionParts(STEER_SINCE)!
  for (const [index, part] of parts.entries()) {
    if (part !== since[index]) return part > since[index]!
  }
  return true
}

const steerNoticeShown = new Set<string>()

/** True the first time a server's older engine queues a follow-up in this window, so its notice shows once. */
export function firstSteerNotice(serverKey: string) {
  if (steerNoticeShown.has(serverKey)) return false
  steerNoticeShown.add(serverKey)
  return true
}
