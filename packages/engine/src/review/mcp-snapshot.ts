import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { Context } from "effect"
import { holdbackText } from "@vectordevai/core/review/holdback"
import { ReviewMcp } from "./mcp"

export * as ReviewMcpSnapshot from "./mcp-snapshot"

export const LIMITS = { count: 4, bytes: 16_384, resourceBytes: 8192, ms: 1500 } as const
export const unavailable = "Some owner-selected MCP context was unavailable for this review."
const empty = () => ({ blocks: [] as string[], incomplete: false })

// An initialized stock connection has a unique, opaque generation. Reconnection or a catalog change invalidates
// its readers. The marker carries no SDK client, URL, header, authentication data or model-controlled arguments.
export interface Generation {
  readonly id: symbol
}

export interface Selection {
  readonly context: ReviewMcp.Context
  readonly uri: string
}

// Only trusted integrations can supply this capability for an existing generation. A generic SDK read materializes
// an unbounded result and cannot prove redirect/reconnect behavior, so it has no adapter by default. A reader must
// implement one pinned request, no retries/redirects, streaming byte limits and cancellation at the transport.
export interface FixedReader {
  readonly identity: ReviewMcp.Identity
  readonly schemaHash: string
  readOnce(input: {
    readonly uri: string
    readonly signal: AbortSignal
    readonly maxBytes: number
    readonly redirect: "error"
    readonly retries: 0
  }): Promise<{ readonly uri: string; readonly bytes: AsyncIterable<Uint8Array> }>
}

export interface Authority {
  readonly directory: string
  readonly selections: readonly Selection[]
  readonly grants: ReviewMcp.GrantSource
  readonly reader: (generation: Generation, selection: Readonly<Selection>) => FixedReader | undefined
}
export const Trusted = Context.Reference<Authority | undefined>("@vector/ReviewMcpSnapshots", {
  defaultValue: () => undefined,
})

// Fix the selected names at cache admission. Grants, readers and connection generations remain live through the
// final check, and an initially empty selection cannot begin using resources after a cache-backed review starts.
export function freezeSelection(source: Authority | undefined): Authority | undefined {
  if (!source?.selections.length) return
  return {
    directory: source.directory,
    selections: source.selections
      .slice(0, LIMITS.count + 1)
      .map(({ context, uri }) => ({ context: { ...context }, uri })),
    grants: (context) => source.grants(context),
    reader: (generation, selection) => source.reader(generation, selection),
  }
}

type Current = (server: string) => Promise<Generation | undefined>

// The manager can belong to another checkout even when both worktrees share the same Git history. A missing
// directory is never reconstructed as a valid authority. This check runs inside the capture deadline.
export async function sameCheckout(selected: string, reviewed: string, manager: string) {
  const roots = [selected, reviewed, manager]
  if (!roots.every((root) => path.isAbsolute(root))) return false
  try {
    const [owner, checkout, active] = await Promise.all([realpath(selected), realpath(reviewed), realpath(manager)])
    return (
      path.relative(owner, checkout) === "" && path.relative(owner, active) === "" && (await stat(owner)).isDirectory()
    )
  } catch {
    return false
  }
}

function exactUri(uri: string) {
  if (!uri || uri.length > 2048 || /[\s{}\\\u0000-\u001f]/u.test(uri)) return false
  try {
    const parsed = new URL(uri)
    return !parsed.username && !parsed.password && !parsed.hash
  } catch {
    return false
  }
}

// No PR, message, cursor, input args, or model result is an input to the invocation. Its fixed resource addresses
// are copied before the first await. Only the owner-bound directory may use the selection.
export function invocation(authority: Authority, directory: string, current: Current) {
  const controller = new AbortController()
  let phase: "ready" | "reading" | "closed" = "ready"
  const close = () => {
    phase = "closed"
    controller.abort()
  }
  let deadline = 0
  const checkTime = () => {
    if (performance.now() >= deadline) close()
    controller.signal.throwIfAborted()
  }
  const read = async (selection: Selection, reserve: () => number, signal: AbortSignal) => {
    checkTime()
    const generation = await current(selection.context.server)
    checkTime()
    if (!generation) return
    const get = () => {
      const reader = authority.reader(generation, selection)
      if (
        !reader ||
        ReviewMcp.decide(
          {
            context: selection.context,
            identity: reader.identity,
            capability: { kind: "resource", id: selection.uri, schemaHash: reader.schemaHash },
            trust: "untrusted",
            use: "snapshot",
          },
          authority.grants,
        ).status !== "granted-read"
      )
        return
      return reader
    }
    const pin = (reader: FixedReader) =>
      ReviewMcp.digest([
        reader.identity.serverIdentity,
        reader.identity.endpointHash,
        reader.identity.capabilitiesHash,
        reader.schemaHash,
      ])
    const reader = get()
    if (!reader) return
    const before = pin(reader)
    const maxBytes = reserve()
    if (maxBytes <= 0) return
    checkTime()
    const response = await reader.readOnce({ uri: selection.uri, signal, maxBytes, redirect: "error", retries: 0 })
    // A redirect or resource expansion must never cause a second operation.
    checkTime()
    if (response.uri !== selection.uri) return
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const parts: string[] = []
    let size = 0
    for await (const chunk of response.bytes) {
      checkTime()
      if (!(chunk instanceof Uint8Array) || !chunk.byteLength || size + chunk.byteLength > maxBytes) return
      size += chunk.byteLength
      parts.push(decoder.decode(chunk, { stream: true }))
    }
    parts.push(decoder.decode())
    checkTime()
    if ((await current(selection.context.server)) !== generation) return
    checkTime()
    const after = get()
    if (!after || pin(after) !== before) return
    const value = holdbackText(parts.join(""))
    if (!value.trim() || value.includes("\u0000")) return
    return { value, size, allowance: maxBytes }
  }
  const capture = async (signal?: AbortSignal) => {
    if (phase !== "ready") return { blocks: [], incomplete: true }
    phase = "reading"
    const result = empty()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (signal?.aborted || authority.directory !== directory || authority.selections.length > LIMITS.count)
        return { blocks: [], incomplete: true }
      const chosen = authority.selections.map(({ context, uri }) => ({ context: { ...context }, uri }))
      const seen = new Set<string>()
      if (
        chosen.some(({ context, uri }) => {
          const id = JSON.stringify([context.owner, context.repository, context.server, uri])
          if (seen.has(id) || !exactUri(uri)) return true
          seen.add(id)
          return false
        })
      )
        return { blocks: [], incomplete: true }
      const canceled = new Promise<void>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve(), { once: true }),
      )
      signal?.addEventListener("abort", close, { once: true })
      if (signal?.aborted) close()
      deadline = performance.now() + LIMITS.ms
      timer = setTimeout(close, LIMITS.ms)
      let remaining: number = LIMITS.bytes
      // A failed or incomplete transport may already have consumed its entire allowance.
      const reserve = () => {
        const allowance = Math.min(remaining, LIMITS.resourceBytes)
        remaining -= allowance
        return allowance
      }
      for (const selection of chosen) {
        if (performance.now() >= deadline) close()
        if (controller.signal.aborted) {
          result.incomplete = true
          break
        }
        const request = new AbortController()
        const item = await Promise.race([
          read(selection, reserve, AbortSignal.any([controller.signal, request.signal])).catch(() => undefined),
          canceled,
        ]).finally(() => request.abort())
        if (performance.now() >= deadline) close()
        if (controller.signal.aborted || !item) {
          result.incomplete = true
          continue
        }
        result.blocks.push(item.value)
        remaining += item.allowance - item.size
      }
      return result
    } catch {
      return { blocks: [], incomplete: true }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", close)
      close()
    }
  }
  return { capture, close }
}
