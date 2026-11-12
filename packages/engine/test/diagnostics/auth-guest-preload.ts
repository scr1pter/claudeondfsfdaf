import { afterAll, afterEach, beforeEach } from "bun:test"

// Initialize the normal XDG fixture and strict network guard before importing any source module.
await import("../preload")
// This module imports only EventEmitter and Identifier; it does not build a runtime or start services.
const { GlobalBus } = await import("../../src/bus/global")

const MAX_BYTES = 4096
const MAX_SESSIONS = 256
const MAX_RECEIPTS = 1024
const sessions = new Map<string, string>()
const directories = new Map<string, string>()
const repeats = new Map<string, number>()
const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>()
const state = { active: true, test: 0, receipts: 0, dropped: 0 }
let installed: { original: typeof fetch; observer: typeof fetch } | undefined

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const choice = (value: unknown, allowed: readonly string[]) =>
  typeof value === "string" && allowed.includes(value) ? value : value === undefined ? "absent" : "other"
const alias = (values: Map<string, string>, value: string, prefix: string) => {
  const known = values.get(value)
  if (known) return known
  if (values.size >= MAX_SESSIONS) return "capacity"
  const next = `${prefix}${values.size + 1}`
  values.set(value, next)
  return next
}

function emit(value: Record<string, unknown>) {
  if (!state.active) return
  try {
    const signature = JSON.stringify(value)
    const count = repeats.get(signature)
    if (count !== undefined) {
      repeats.set(signature, count + 1)
      return
    }
    if (state.receipts >= MAX_RECEIPTS) {
      state.dropped++
      return
    }
    repeats.set(signature, 1)
    state.receipts++
    process.stdout.write(`CONNECT_GUEST_DIAGNOSTIC ${signature}\n`)
  } catch {
    // Diagnostics never replace a test's result or error, including when its output pipe has closed.
  }
}

function errorKind(value: unknown) {
  if (!object(value)) return value === undefined ? "absent" : "other"
  const data = object(value.data) ? value.data : undefined
  const message = typeof value.message === "string" ? value.message : data?.message
  if (typeof message !== "string") return "other"
  if (/model not found/i.test(message)) return "model-not-found"
  if (/agent not found/i.test(message)) return "agent-not-found"
  if (/configuration scope|configuration directory|ENOENT|ENOTDIR/.test(message)) return "directory-unavailable"
  if (/permission|forbidden|unauthorized/i.test(message)) return "permission"
  if (/abort|interrupt|cancel/i.test(message)) return "interrupted"
  return "other"
}

function route(args: readonly unknown[]) {
  try {
    const input = args[0]
    const init = args[1]
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : "",
    )
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return
    // Do not invoke an unknown init.method getter a second time merely to observe a request.
    const descriptor = object(init) ? Object.getOwnPropertyDescriptor(init, "method") : undefined
    if (descriptor && !("value" in descriptor)) return
    const requested: unknown = descriptor?.value ?? (input instanceof Request ? input.method : "GET")
    if (typeof requested !== "string") return
    const method = requested.toUpperCase()
    const create = method === "POST" && url.pathname === "/session"
    const prompt = method === "POST" ? /^\/session\/(ses_[A-Za-z0-9_-]+)\/prompt_async$/.exec(url.pathname) : undefined
    const spend = method === "GET" ? /^\/api\/session\/(ses_[A-Za-z0-9_-]+)\/spend$/.exec(url.pathname) : undefined
    if (!create && !prompt && !spend) return
    const id = prompt?.[1] ?? spend?.[1]
    return {
      test: state.test,
      route: create ? "create" : prompt ? "prompt-async" : "spend",
      directory: alias(directories, url.searchParams.get("directory") ?? "", "d"),
      ...(id ? { session: alias(sessions, id, "s") } : {}),
    }
  } catch {
    return
  }
}

type Receipt = NonNullable<ReturnType<typeof route>>

async function observe(response: Response, receipt: Receipt) {
  emit({ phase: "response", ...receipt, status: response.status })
  // A 204 has no payload. Clone only the bounded JSON receipts, never any request or transcript body.
  if (response.status === 204) return
  const reader = response.clone().body?.getReader()
  if (!reader) return
  readers.add(reader)
  const chunks: Uint8Array[] = []
  let bytes = 0
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    void reader.cancel().catch(() => undefined)
  }, 1000)
  try {
    while (state.active) {
      const part = await reader.read()
      if (expired) return emit({ phase: "shape", ...receipt, body: "observation-timeout" })
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_BYTES) return emit({ phase: "shape", ...receipt, body: "oversized" })
      chunks.push(part.value)
    }
    if (!state.active) return
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
    if (receipt.route === "create" && object(value) && typeof value.id === "string")
      emit({ phase: "created", ...receipt, session: alias(sessions, value.id, "s") })
    if (receipt.route !== "spend") return
    const data = object(value) && object(value.data) ? value.data : undefined
    const budget = data && object(data.budget) ? data.budget : undefined
    emit({
      phase: "shape",
      ...receipt,
      body: object(value) ? "object" : "other",
      hasData: data !== undefined,
      hasBudget: budget !== undefined,
      budget: Object.fromEntries(["usd", "steps", "warnAt"].map((key) => [key, typeof budget?.[key]])),
      state: choice(data?.state, ["ok", "warn", "stopped"]),
      error: object(value) ? errorKind(value.error ?? value) : "other",
    })
  } catch {
    emit({ phase: "shape", ...receipt, body: "unreadable" })
  } finally {
    clearTimeout(timer)
    readers.delete(reader)
    void reader.cancel().catch(() => undefined)
  }
}

function uninstall() {
  if (!installed) return
  if (globalThis.fetch === installed.observer) globalThis.fetch = installed.original
  else emit({ phase: "observer-replaced", test: state.test })
  installed = undefined
}

// Per-file NetworkGuard.use() replaces the suite guard. Observe the current guarded fetch anew for each test,
// and never restore a stale fetch over a replacement the real guard installed itself.
beforeEach(() => {
  uninstall()
  state.test++
  const original = globalThis.fetch
  const observer = new Proxy(original, {
    apply(target, receiver, args) {
      const result: ReturnType<typeof fetch> = Reflect.apply(target, receiver, args)
      try {
        const receipt = route(args)
        if (receipt) {
          emit({ phase: "request", ...receipt })
          void result.then(
            (response) => {
              try {
                void observe(response, receipt).catch(() => emit({ phase: "observation-failed", ...receipt }))
              } catch {
                emit({ phase: "observation-registration-failed", ...receipt })
              }
            },
            () => emit({ phase: "transport-rejected", ...receipt }),
          )
        }
      } catch {
        emit({ phase: "observation-registration-failed", test: state.test })
      }
      return result
    },
  })
  installed = { original, observer }
  globalThis.fetch = observer
})
afterEach(uninstall)

const onEvent = (event: Parameters<typeof GlobalBus.emit>[1]) => {
  try {
    const payload: unknown = event.payload
    if (!object(payload) || !object(payload.properties)) return
    const properties = payload.properties
    const info = object(properties.info) ? properties.info : undefined
    const id =
      typeof properties.sessionID === "string"
        ? properties.sessionID
        : payload.type === "message.updated"
          ? info?.sessionID
          : payload.type === "session.created"
            ? info?.id
            : undefined
    if (typeof id !== "string") return
    const session = sessions.get(id)
    if (!session) return
    const common = {
      phase: "event",
      session,
      directory: alias(directories, event.directory ?? "", "d"),
    }
    if (payload.type === "session.status" && object(properties.status))
      return emit({
        ...common,
        type: "session.status",
        status: choice(properties.status.type, ["idle", "busy", "retry"]),
      })
    if (payload.type === "session.error")
      return emit({ ...common, type: "session.error", error: errorKind(properties.error) })
    if (payload.type === "message.updated" && info)
      return emit({
        ...common,
        type: "message.updated",
        role: choice(info.role, ["user", "assistant"]),
        finish: choice(info.finish, ["stop", "tool-calls", "length", "error"]),
        error: errorKind(info.error),
      })
    if (payload.type === "session.created") emit({ ...common, type: "session.created" })
  } catch {
    emit({ phase: "event-observation-failed" })
  }
}
GlobalBus.on("event", onEvent)

afterAll(() => {
  uninstall()
  GlobalBus.off("event", onEvent)
  emit({
    phase: "summary",
    receipts: state.receipts,
    repeated: [...repeats.values()].reduce((sum, count) => sum + count - 1, 0),
    dropped: state.dropped,
    pendingReaders: readers.size,
  })
  state.active = false
  for (const reader of readers) void reader.cancel().catch(() => undefined)
  readers.clear()
})
