import { everywhereSystemInstructions, frameTask, outsideMetadata, sessionTitle, unattendedMetadata, type FrameOptions } from "@vectordevai/core/everywhere/frame"
import { RUN_STEPS, type EverywhereJob } from "@vectordevai/schema/everywhere"
import type { PermissionV1 } from "@vectordevai/schema/permission-v1"
import type { PostingCheck } from "./everywhere-scan"
import { Wildcard } from "@vectordevai/core/util/wildcard"

const EDITING = ["read", "edit", "glob", "grep", "list", "lsp", "todowrite"] as const
const DENIED = ["bash", "unsandboxed_shell", "terminal", "terminal_input", "browser*", "teammate", "workflow", "task", "skill", "learned_skill", "webfetch", "websearch", "research*", "external_directory", "private_network", "computer*", "vector_cloud*", "question", "plan_enter", "plan_exit", "mcp*", "connect*"] as const

/** There is no shell-allow boolean: R-M2 must add an actual engine capability before any command is permitted. */
export function unattendedRules(user: readonly PermissionV1.Rule[] = []): PermissionV1.Rule[] {
  return [
    { permission: "*", pattern: "*", action: "deny" },
    ...EDITING.flatMap((permission) => [
      { permission, pattern: "*", action: "allow" as const },
      ...user.filter((rule) => Wildcard.match(permission, rule.permission)).map((rule) => ({ ...rule, permission })),
    ]),
    ...DENIED.map((permission) => ({ permission, pattern: "*", action: "deny" as const })),
  ]
}

export type EngineEvent = { readonly type: string; readonly properties: Record<string, unknown> }
export type RunnerEngine = {
  readonly create: (job: EverywhereJob, rules: readonly PermissionV1.Rule[]) => Promise<string>
  readonly prompt: (session: string, job: EverywhereJob, maxUsd: number, model?: { providerID: string; modelID: string }, options?: FrameOptions) => Promise<void>
  readonly events: (signal: AbortSignal, ready: () => void) => AsyncIterable<EngineEvent>
  readonly abort: (session: string) => Promise<void>
  readonly rejectPermission: (id: string) => Promise<void>
  readonly rejectQuestion: (id: string) => Promise<void>
  readonly summary: (session: string) => Promise<string>
  readonly posting: PostingCheck
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createEverywhereEngine(input: {
  readonly url: string
  readonly directory: string
  readonly authorization: string
  readonly fetcher?: typeof fetch
}): RunnerEngine {
  const origin = new URL(input.url)
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || origin.username || origin.password || origin.search || origin.hash) throw new Error("Everywhere requires the local engine")
  const fetcher = input.fetcher ?? fetch
  const endpoint = (route: string) => {
    const url = new URL(route, origin)
    if (url.origin !== origin.origin) throw new Error("Invalid local engine route")
    url.searchParams.set("directory", input.directory)
    return url
  }
  const call = async (method: string, route: string, body?: unknown, guest = false): Promise<unknown> => {
    const response = await fetcher(endpoint(route), { method, redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: input.authorization, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(guest ? { "x-vector-guest-request": "1" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) })
    if (!response.ok) throw new Error("The local Everywhere engine request failed")
    const text = await response.text()
    if (text.length > 2 * 1024 * 1024) throw new Error("The local engine response is too large")
    return text ? JSON.parse(text) : undefined
  }
  const id = (value: string) => {
    if (!/^[A-Za-z0-9_:-]{1,150}$/.test(value)) throw new Error("Invalid local engine identifier")
    return encodeURIComponent(value)
  }
  return {
    async create(job, rules) {
      const result = await call("POST", "/session", { title: sessionTitle(job), metadata: unattendedMetadata(job), permission: rules })
      if (!record(result) || typeof result.id !== "string" || !/^ses[A-Za-z0-9_]+$/.test(result.id)) throw new Error("Invalid unattended session")
      return result.id
    },
    async prompt(session, job, maxUsd, model, options) {
      await call("POST", `/session/${id(session)}/prompt_async`, {
        system: everywhereSystemInstructions(job), budget: { usd: maxUsd, steps: RUN_STEPS },
        ...(model ? { model } : {}), parts: [{ type: "text", text: frameTask(job, options), metadata: outsideMetadata(job) }],
      }, true)
    },
    async *events(signal, ready) {
      const response = await fetcher(endpoint("/event"), { headers: { authorization: input.authorization }, redirect: "error", signal })
      if (!response.ok || !response.body) throw new Error("Everywhere could not subscribe to the engine")
      ready()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ""
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) return
          pending = (pending + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, "\n")
          if (pending.length > 1024 * 1024) throw new Error("An engine event is too large")
          let end: number
          while ((end = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, end)
            pending = pending.slice(end + 2)
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
            if (!data) continue
            const value: unknown = JSON.parse(data)
            if (record(value) && typeof value.type === "string" && record(value.properties)) yield { type: value.type, properties: value.properties }
          }
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    },
    abort: async (session) => { await call("POST", `/session/${id(session)}/abort`) },
    rejectPermission: async (permission) => { await call("POST", `/permission/${id(permission)}/reply`, { reply: "reject" }) },
    rejectQuestion: async (question) => { await call("POST", `/question/${id(question)}/reject`) },
    async summary(session) {
      const result = await call("GET", `/session/${id(session)}/message?limit=20`)
      if (!Array.isArray(result)) return ""
      const last = result.filter((message) => record(message) && record(message.info) && message.info.role === "assistant").at(-1)
      if (!record(last) || !Array.isArray(last.parts)) return ""
      return last.parts.filter((part) => record(part) && part.type === "text" && typeof part.text === "string").map((part) => String(part.text)).join("\n")
    },
    async posting(parts, sessions) {
      const result = await call("POST", "/memory/posting-check", { parts, sessionIDs: sessions, typed: false, untrusted: true })
      if (!record(result) || !["clean", "changed", "ask"].includes(String(result.status)) || !Array.isArray(result.parts) || result.parts.some((part) => typeof part !== "string")) throw new Error("Invalid posting check result")
      return { status: result.status as "clean" | "changed" | "ask", parts: result.parts as string[] }
    },
  }
}
