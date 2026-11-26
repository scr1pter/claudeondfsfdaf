import { Option, Schema } from "effect"
import { createHash } from "node:crypto"
import type { EverywhereSessionWire } from "@vectordevai/core/everywhere/session-binding"
import { everywhereSystemInstructions, frameTask, outsideMetadata, sessionTitle, unattendedMetadata, UNATTENDED_SHELL_KEY, UNATTENDED_SHELL_OFFLINE, type FrameOptions } from "@vectordevai/core/everywhere/frame"
import { RUN_STEPS, type EverywhereJob } from "@vectordevai/schema/everywhere"
import type { PermissionV1 } from "@vectordevai/schema/permission-v1"
import type { PostingCheck } from "./everywhere-scan"
import { Wildcard } from "@vectordevai/core/util/wildcard"

const EDITING = ["read", "edit", "glob", "grep", "list", "lsp", "todowrite"] as const
const DENIED = ["bash", "unsandboxed_shell", "terminal", "terminal_input", "browser*", "teammate", "workflow", "task", "skill", "learned_skill", "webfetch", "websearch", "research*", "external_directory", "private_network", "computer*", "vector_cloud*", "question", "plan_enter", "plan_exit", "mcp*", "connect*"] as const

/** What the local engine promises an unattended session's commands (GET /experimental/shell/unattended, EV-16). */
export type UnattendedShellPolicy = "offline-v1" | "none"

/**
 * The session's ruleset (spec §3.5 step 5, E7): an allowlist that wins over the user's own config, `permission: "allow"`
 * included, because the engine evaluates a session's rules last (findLast over Permission.merge(agent, session)).
 *
 * - First `*` denied, then for the editing ids `allow` followed by the user's own rules for that id, so their denies
 *   still hold, then explicit denies for the shell, terminals and every other tool family.
 * - `bash` is allowed again, after those denies, only when `shell` is the engine's `offline-v1`: the session then runs
 *   every command in the offline sandbox (the engine refuses its commands anywhere that sandbox is missing). The
 *   user's own shell rules follow that allow, so their denies hold and their asks are refused. `unsandboxed_shell`,
 *   the terminals and the rest of the denied list are never allowed again.
 * - The user's rules arrive through GET /global/config, which re-encodes the block with the known keys first, so the
 *   order of its keys is not the user's. Only the order inside one key's own patterns survives. So for each id this
 *   copies the rules written for that id itself, in their order, then of the rules under a wildcard key (`*`, `b*`)
 *   the asks and then the denies, never the allows. No allow can outrank an ask or a deny whose position is not
 *   known, and no wildcard deny is outranked at all; a wildcard ask may outrank an exact rule, which the runner then
 *   refuses as it refuses every ask.
 */
export function unattendedRules(user: readonly PermissionV1.Rule[] = [], shell: UnattendedShellPolicy = "none"): PermissionV1.Rule[] {
  const own = (permission: string) => {
    const wildcard = user.filter((rule) => rule.permission !== permission && Wildcard.match(permission, rule.permission))
    return [
      ...user.filter((rule) => rule.permission === permission),
      ...wildcard.filter((rule) => rule.action === "ask"),
      ...wildcard.filter((rule) => rule.action === "deny"),
    ].map((rule) => ({ ...rule, permission }))
  }
  return [
    { permission: "*", pattern: "*", action: "deny" },
    ...EDITING.flatMap((permission) => [{ permission, pattern: "*", action: "allow" as const }, ...own(permission)]),
    ...DENIED.map((permission) => ({ permission, pattern: "*", action: "deny" as const })),
    ...(shell === "offline-v1" ? [{ permission: "bash", pattern: "*", action: "allow" as const }, ...own("bash")] : []),
  ]
}

/** What the local engine offers an unattended job. A field it gave no definite answer for (yet) is absent. */
export type UnattendedCapabilities = { readonly worktree?: boolean; readonly shell?: UnattendedShellPolicy }

const WorktreePolicy = Schema.fromJsonString(Schema.Struct({ policy: Schema.Literal("unattended-v1") }))
const ShellPolicy = Schema.fromJsonString(Schema.Struct({ shell: Schema.Literals(["offline-v1", "none"]) }))
/** The engine's own bubblewrap self-test may take 10 s on the first ask, so the shell probe waits longer. */
const SHELL_PROBE_MS = 20_000

/**
 * Asks the local engine, as its owner, whether it creates unattended worktrees (`unattended-v1`, EV-13) and runs an
 * unattended session's commands offline (`offline-v1`, EV-16). Both probes are engine-wide: no `directory` is sent and
 * no instance is loaded. Only the exact answers count. A 4xx (404 from an engine without the route, 401 or 403) or a
 * 200 with any other body, an over-long one included, is a definite no; a timeout, a refused connection, a redirect, a
 * 5xx or a body that breaks off leaves that field absent, so the caller asks again later and offers nothing meanwhile.
 * It throws only for an address that is not this computer's loopback engine.
 */
export async function unattendedCapabilities(input: { readonly url: string; readonly authorization: string; readonly fetcher?: typeof fetch }): Promise<UnattendedCapabilities> {
  const origin = localEngineOrigin(input.url)
  const fetcher = input.fetcher ?? fetch
  const ask = async (route: string, ms: number) => {
    const signal = AbortSignal.timeout(ms)
    const response = await fetcher(new URL(route, origin), { redirect: "error", signal,
      headers: { authorization: input.authorization, accept: "application/json" } }).catch(() => undefined)
    if (!response) return undefined
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return response.status >= 500 ? undefined : ""
    }
    // An answer too long to be one of the exact answers is a no; one cut off (the timeout, a reset) is no answer.
    return responseText(response, 4096).catch((error) => (error instanceof ResponseTooLarge ? "" : undefined))
  }
  const [worktree, shell] = await Promise.all([ask("/experimental/worktree/unattended", 10_000), ask("/experimental/shell/unattended", SHELL_PROBE_MS)])
  const exact = { onExcessProperty: "error" } as const
  return {
    ...(worktree === undefined ? {} : { worktree: Option.isSome(Schema.decodeUnknownOption(WorktreePolicy)(worktree, exact)) }),
    ...(shell === undefined ? {} : { shell: Option.getOrUndefined(Schema.decodeUnknownOption(ShellPolicy)(shell, exact))?.shell ?? "none" }),
  }
}

/** The local engine's origin; anything but a plain loopback http address is refused before any request. */
export function localEngineOrigin(url: string) {
  const origin = new URL(url)
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || origin.username || origin.password || origin.search || origin.hash) throw new Error("Everywhere requires the local engine")
  return origin
}

export type EngineEvent = { readonly type: string; readonly properties: Record<string, unknown> }
export type RunnerEngine = {
  readonly create: (job: EverywhereJob, rules: readonly PermissionV1.Rule[], placement?: EverywhereSessionWire.Placement) => Promise<string>
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

/** responseText's refusal past its limit, which the capability probes read as a definite no. */
class ResponseTooLarge extends Error {
  constructor() { super("The local engine response is too large") }
}

/** A response body as text, refused past `limit` bytes. The jobs client's `pending` answer uses it too. */
export async function responseText(response: Response, limit: number) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const buffer = new Uint8Array(limit)
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (bytes + next.value.byteLength > limit) throw new ResponseTooLarge()
      buffer.set(next.value, bytes)
      bytes += next.value.byteLength
    }
    return new TextDecoder().decode(buffer.subarray(0, bytes))
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

export function createEverywhereEngine(input: {
  readonly url: string
  readonly directory: string
  readonly authorization: string
  readonly fetcher?: typeof fetch
  readonly createSession?: (request: EverywhereSessionWire.Request) => Promise<EverywhereSessionWire.Result>
}): RunnerEngine {
  const origin = localEngineOrigin(input.url)
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
    const text = await responseText(response, 2 * 1024 * 1024)
    return text ? JSON.parse(text) : undefined
  }
  const id = (value: string) => {
    if (!/^[A-Za-z0-9_:-]{1,150}$/.test(value)) throw new Error("Invalid local engine identifier")
    return encodeURIComponent(value)
  }
  return {
    async create(job, rules, placement) {
      // Every unattended session carries the shell mark, whatever the probe said: its commands then run only in the
      // engine's offline sandbox and are refused where that is missing, and its terminals and session shell are refused.
      const title = sessionTitle(job)
      if (input.createSession) {
        if (!placement || placement.directory !== input.directory || placement.jid !== job.jid)
          throw new Error("The unattended session has no verified worktree")
        const request = {
          ...placement,
          version: 1 as const,
          claim: createHash("sha256").update(job.lease.id).digest("hex"),
          platform: job.platform,
          title,
          permission: rules,
        }
        const response = await input.createSession(request)
        if (response.kind === "created") return response.sessionID
        // The first reply can be lost after the receipt is durable. No failure on this path may fall back to HTTP.
        if (response.kind === "unavailable") {
          const retry = await input.createSession(request)
          if (retry.kind === "created") return retry.sessionID
        }
        if (response.kind !== "unsupported") throw new Error("The unattended session could not be bound")
      }
      const metadata = { ...unattendedMetadata(job), [UNATTENDED_SHELL_KEY]: UNATTENDED_SHELL_OFFLINE }
      const result = await call("POST", "/session", { title, metadata, permission: rules })
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
          // Network chunks can contain many complete events. Bound one frame, not the
          // aggregate chunk, and feed large chunks incrementally to bound retained text.
          for (let offset = 0; offset < next.value.byteLength; offset += 32 * 1024) {
            pending = (pending + decoder.decode(next.value.subarray(offset, offset + 32 * 1024), { stream: true })).replace(/\r\n/g, "\n")
            let end: number
            while ((end = pending.indexOf("\n\n")) >= 0) {
              if (end > 8 * 1024 * 1024) throw new Error("An engine event is too large")
              const frame = pending.slice(0, end)
              pending = pending.slice(end + 2)
              const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
              if (!data) continue
              const value: unknown = JSON.parse(data)
              if (record(value) && typeof value.type === "string" && record(value.properties)) yield { type: value.type, properties: value.properties }
            }
            // Patch events can repeat a diff in multiple fields. They are larger than
            // ordinary status events, but still have a finite per-frame ceiling.
            if (pending.length > 8 * 1024 * 1024) throw new Error("An engine event is too large")
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
