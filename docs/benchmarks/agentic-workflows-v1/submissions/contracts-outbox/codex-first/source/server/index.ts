import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { startProvider } from "../fixtures/provider"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const configuredData = process.env.DATA_DIR ?? join(root, "..", "support-data")
const dataDirectory = resolve(configuredData)
const dataRelative = relative(root, dataDirectory)
if (!isAbsolute(configuredData) || (dataRelative !== ".." && !dataRelative.startsWith(".." + sep))) {
  throw new Error("DATA_DIR must be absolute and outside application source")
}
mkdirSync(dataDirectory, { recursive: true })
const db = new Database(join(dataDirectory, "support.sqlite"), { create: true })
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
    ticket_id TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, delivery TEXT
  );
  CREATE TABLE IF NOT EXISTS admissions (
    request_id TEXT PRIMARY KEY, message_id TEXT UNIQUE NOT NULL REFERENCES messages(id)
  );
`)

type Ticket = { id: string; subject: string; customer: string; summary: string }
type Status = "draft" | "queued" | "sending" | "retryable" | "delivered" | "cancelled"
type Delivery = { idempotencyKey: string; attempts: number; receiptId: string | null; lastError: string | null; cancelRequested: boolean }
type Row = { seq: number; id: string; ticket_id: string; body: string; status: Status; delivery: string | null }
type Message = { id: string; ticketId: string; body: string; status: Status; delivery: Delivery | null }
type Envelope = { idempotencyKey: string; messageId: string; ticketId: string; body: string }
type Outcome = { status: "accepted"; receipt: Envelope & { id: string } } | { status: "cancelled"; idempotencyKey: string }

const tickets = await Bun.file(join(root, "fixtures/tickets.json")).json() as Ticket[]
const provider = startProvider(dataDirectory)
const get = (id: string) => db.query<Row, [string]>("SELECT * FROM messages WHERE id = ?").get(id)
const message = (row: Row): Message => ({ id: row.id, ticketId: row.ticket_id, body: row.body, status: row.status, delivery: row.delivery ? JSON.parse(row.delivery) : null })
const read = (id: string) => message(get(id)!)
const store = (item: Message) => db.query("UPDATE messages SET status = ?, delivery = ? WHERE id = ?").run(item.status, item.delivery ? JSON.stringify(item.delivery) : null, item.id)
const json = (value: unknown, status = 200) => Response.json(value, { status })
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 80 && !/[^A-Za-z0-9_-]/.test(value)
const terminal = (item: Message) => item.status === "delivered" || item.status === "cancelled"
const tooLate = "Cancellation was too late: the provider had already accepted this message."
class HttpError extends Error { constructor(public status: number, text: string) { super(text) } }
async function input(request: Request): Promise<Record<string, unknown>> {
  let result: unknown
  try { result = await request.json() } catch { throw new HttpError(400, "Request must contain valid JSON") }
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new HttpError(400, "Request must be a JSON object")
  return result as Record<string, unknown>
}
function bodyFrom(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > 2000) {
    throw new HttpError(400, "Reply must contain 1–2000 Unicode characters and cannot be blank")
  }
  return value
}
const envelope = (item: Message): Envelope => ({ idempotencyKey: item.delivery!.idempotencyKey, messageId: item.id, ticketId: item.ticketId, body: item.body })

// Trust a provider receipt only after HTTP success and a complete match to the
// immutable envelope. Failed responses never establish non-delivery.
async function providerRequest(route: "deliver" | "cancel", item: Message): Promise<Outcome> {
  const expected = envelope(item)
  const response = await fetch(provider.origin + "/" + route, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(route === "deliver" ? expected : { idempotencyKey: expected.idempotencyKey }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`Provider ${route === "deliver" ? "delivery" : "cancellation"} returned HTTP ${response.status}; outcome is unresolved.`)
  const result = await response.json() as Partial<Outcome> | null
  if (result?.status === "cancelled" && result.idempotencyKey === expected.idempotencyKey) return result as Outcome
  if (result?.status === "accepted") {
    const receipt = result.receipt
    if (receipt && typeof receipt.id === "string" && receipt.id.trim() &&
        receipt.idempotencyKey === expected.idempotencyKey && receipt.messageId === expected.messageId &&
        receipt.ticketId === expected.ticketId && receipt.body === expected.body) return result as Outcome
  }
  throw new Error("Provider returned an invalid response; outcome is unresolved.")
}

function settle(id: string, outcome: Outcome) {
  const item = read(id)
  const delivery = item.delivery!
  if (outcome.status === "accepted") {
    item.status = "delivered"
    delivery.receiptId = outcome.receipt.id
    delivery.lastError = delivery.cancelRequested ? tooLate : null
  } else if (!terminal(item)) {
    item.status = "cancelled"
    delivery.lastError = null
  }
  store(item)
}
function unresolved(id: string, failure: unknown, cancellation: boolean) {
  const item = read(id)
  if (terminal(item)) return
  item.status = "retryable"
  // A late failed send must not erase a concurrent cancellation explanation.
  if (cancellation || !item.delivery!.cancelRequested) {
    item.delivery!.lastError = `${cancellation ? "Cancellation unresolved" : "Delivery unresolved"}: ${failure instanceof Error ? failure.message : "Provider connection failed"}`
  }
  store(item)
}

const cancellations = new Map<string, Promise<void>>()
function cancel(id: string): Promise<void> {
  const existing = cancellations.get(id)
  if (existing) return existing
  const item = read(id)
  if (item.delivery) item.delivery.cancelRequested = true
  if (item.status === "delivered") {
    item.delivery!.lastError = tooLate
    store(item)
    return Promise.resolve()
  }
  if (item.status === "cancelled") { store(item); return Promise.resolve() }
  if (!item.delivery || item.delivery.attempts === 0) {
    item.status = "cancelled"
    store(item)
    return Promise.resolve()
  }
  item.delivery.lastError = "Cancellation requested; awaiting the provider's decision."
  store(item)
  const work = (async () => {
    try { settle(id, await providerRequest("cancel", item)) }
    catch (failure) { unresolved(id, failure, true) }
  })()
  cancellations.set(id, work)
  void work.finally(() => { cancellations.delete(id) })
  return work
}

// Admission commits both the immutable message and recoverable outbox work in
// one transaction. No asynchronous work or transmission occurs here.
const admit = db.transaction((id: string, requestId: string) => {
  const item = read(id)
  const prior = db.query<{ message_id: string }, [string]>("SELECT message_id FROM admissions WHERE request_id = ?").get(requestId)
  if (prior) {
    if (prior.message_id !== id) throw new HttpError(409, "Request ID already belongs to another message")
    return item
  }
  if (item.status !== "draft") throw new HttpError(409, "Message has already been admitted or cancelled")
  item.status = "queued"
  item.delivery = { idempotencyKey: crypto.randomUUID(), attempts: 0, receiptId: null, lastError: null, cancelRequested: false }
  db.query("INSERT INTO admissions (request_id, message_id) VALUES (?, ?)").run(requestId, id)
  store(item)
  return item
})

let draining: Promise<string[]> | null = null
function drain(): Promise<string[]> {
  if (draining) return draining
  const ids = db.query<{ id: string }, []>("SELECT id FROM messages WHERE status IN ('queued', 'sending') AND delivery IS NOT NULL ORDER BY seq").all().map(row => row.id)
  const work = (async () => {
    const processed: string[] = []
    for (const id of ids) {
      const item = read(id)
      if (terminal(item)) continue
      processed.push(id)
      if (item.delivery!.cancelRequested) { await cancel(id); continue }
      // Persist intent before the wire. Recovery replays this same envelope on
      // an explicit drain, also reconciling acceptance before a process death.
      item.status = "sending"
      item.delivery!.attempts += 1
      item.delivery!.lastError = null
      store(item)
      try { settle(id, await providerRequest("deliver", item)) }
      catch (failure) { unresolved(id, failure, false) }
    }
    return processed
  })()
  draining = work
  void work.finally(() => { if (draining === work) draining = null })
  return work
}

const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.PORT ?? 4123), idleTimeout: 0,
  async fetch(request) {
    try {
      const path = new URL(request.url).pathname
      const method = request.method
      if (method === "GET" && path === "/api/health") return json({ ok: true, providerOrigin: provider.origin })
      if (method === "GET" && path === "/api/tickets") return json({ tickets })
      if (method === "GET" && path === "/api/outbox") return json({ items: db.query<Row, []>("SELECT * FROM messages WHERE delivery IS NOT NULL ORDER BY seq").all().map(message) })
      if (method === "POST" && path === "/api/outbox/drain") { await input(request); return json({ processed: await drain() }) }
      const ticketRoute = /^\/api\/tickets\/([^/]+)(\/messages)?$/.exec(path)
      if (ticketRoute) {
        const ticket = tickets.find(item => item.id === ticketRoute[1])
        if (!ticket) throw new HttpError(404, "Ticket not found")
        if (method === "GET" && !ticketRoute[2]) return json({ ticket, messages: db.query<Row, [string]>("SELECT * FROM messages WHERE ticket_id = ? ORDER BY seq").all(ticket.id).map(message) })
        if (method === "POST" && ticketRoute[2]) {
          const body = bodyFrom((await input(request)).body)
          const id = crypto.randomUUID()
          db.query("INSERT INTO messages (id, ticket_id, body, status) VALUES (?, ?, ?, 'draft')").run(id, ticket.id, body)
          return json({ message: read(id) }, 201)
        }
      }
      const messageRoute = /^\/api\/messages\/([^/]+)(?:\/(send|retry|cancel))?$/.exec(path)
      if (messageRoute) {
        const id = messageRoute[1]!
        if (!get(id)) throw new HttpError(404, "Message not found")
        const action = messageRoute[2]
        if (method === "GET" && !action) return json({ message: read(id) })
        if (method === "PATCH" && !action) {
          const body = bodyFrom((await input(request)).body)
          if (read(id).status !== "draft") throw new HttpError(409, "Only drafts can be edited")
          db.query("UPDATE messages SET body = ? WHERE id = ?").run(body, id)
          return json({ message: read(id) })
        }
        if (method === "POST" && action) {
          const value = await input(request)
          if (action === "send") {
            if (!validId(value.requestId)) throw new HttpError(400, "Request ID must contain 1–80 ASCII letters, digits, underscores or hyphens")
            return json({ message: admit(id, value.requestId) }, 202)
          }
          if (action === "cancel") { await cancel(id); return json({ message: read(id) }) }
          if (action === "retry") {
            const item = read(id)
            if (!["queued", "retryable"].includes(item.status)) throw new HttpError(409, "Only queued or retryable messages can be retried")
            item.status = "queued"
            store(item)
            return json({ message: item })
          }
        }
      }
      if (path.startsWith("/api/")) throw new HttpError(404, "Not found")
      const asset = path === "/" ? "index.html" : path === "/app.js" ? "app.js" : path === "/style.css" ? "style.css" : null
      if (!asset || method !== "GET") return new Response("Not found", { status: 404 })
      return new Response(Bun.file(join(root, "web", asset)))
    } catch (failure) {
      if (failure instanceof HttpError) return json({ error: failure.message }, failure.status)
      console.error("Application request failed", failure)
      return json({ error: "The request could not be completed" }, 500)
    }
  },
})
console.log(`Support desk listening on 127.0.0.1:${server.port}`)
