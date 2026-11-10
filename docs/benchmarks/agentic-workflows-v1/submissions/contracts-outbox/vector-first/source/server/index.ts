import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { startProvider } from "../fixtures/provider"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const configuredDirectory = process.env.DATA_DIR ?? join(root, "..", "support-data")
const dataDirectory = resolve(configuredDirectory)
const relativeData = relative(root, dataDirectory)
if (!isAbsolute(configuredDirectory) || (relativeData !== ".." && !relativeData.startsWith(".." + sep))) throw new Error("DATA_DIR must be absolute and outside application source")
mkdirSync(dataDirectory, { recursive: true })
const db = new Database(join(dataDirectory, "support.sqlite"), { create: true })
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, ticket_id TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, delivery TEXT);
  CREATE TABLE IF NOT EXISTS outbox (
    message_id TEXT PRIMARY KEY REFERENCES messages(id), request_id TEXT UNIQUE NOT NULL,
    idempotency_key TEXT UNIQUE NOT NULL, envelope TEXT NOT NULL
  );
`)
type Ticket = { id: string; subject: string; customer: string; summary: string }
type Status = "draft" | "queued" | "sending" | "retryable" | "delivered" | "cancelled"
type Delivery = { idempotencyKey: string; attempts: number; receiptId: string | null; lastError: string | null; cancelRequested: boolean }
type Row = { seq: number; id: string; ticket_id: string; body: string; status: Status; delivery: string | null }
type Envelope = { idempotencyKey: string; messageId: string; ticketId: string; body: string }
type Receipt = Envelope & { id: string }
type Work = { message_id: string; request_id: string; idempotency_key: string; envelope: string }
const get = (id: string) => db.query<Row, [string]>("SELECT * FROM messages WHERE id = ?").get(id)
const work = (id: string) => db.query<Work, [string]>("SELECT * FROM outbox WHERE message_id = ?").get(id)
const deliveryOf = (row: Row) => row.delivery ? JSON.parse(row.delivery) as Delivery : null
const message = (row: Row) => ({ id: row.id, ticketId: row.ticket_id, body: row.body, status: row.status, delivery: deliveryOf(row) })
const save = (row: Row, status: Status, delivery: Delivery | null) => db.query("UPDATE messages SET status = ?, delivery = ? WHERE id = ?").run(status, delivery ? JSON.stringify(delivery) : null, row.id)

// Preserve envelopes from the previous direct-send version, including unknown attempts.
db.transaction(() => {
  for (const row of db.query<Row, []>("SELECT * FROM messages WHERE delivery IS NOT NULL").all()) {
    const delivery = deliveryOf(row)!
    const envelope: Envelope = { idempotencyKey: delivery.idempotencyKey, messageId: row.id, ticketId: row.ticket_id, body: row.body }
    db.query("INSERT OR IGNORE INTO outbox (message_id, request_id, idempotency_key, envelope) VALUES (?, ?, ?, ?)").run(row.id, "legacy-" + row.id, delivery.idempotencyKey, JSON.stringify(envelope))
  }
  db.exec("UPDATE messages SET status = 'retryable' WHERE status = 'failed'; UPDATE messages SET status = 'queued' WHERE status = 'sending';")
})()
const tickets = await Bun.file(join(root, "fixtures/tickets.json")).json() as Ticket[]
const provider = startProvider(dataDirectory)
const json = (value: unknown, status = 200) => Response.json(value, { status })
class HttpError extends Error { constructor(public status: number, text: string) { super(text) } }
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value)
const validBody = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= 2000
async function input(request: Request): Promise<Record<string, unknown>> {
  let value: unknown
  try { value = await request.json() } catch { throw new HttpError(400, "Request body must be valid JSON") }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Request body must be a JSON object")
  return value as Record<string, unknown>
}
function bodyFrom(value: Record<string, unknown>) {
  if (!validBody(value.body)) throw new HttpError(400, "Reply must contain 1-2000 Unicode characters and cannot be blank")
  return value.body
}
function requiredMessage(id: string) {
  const row = get(id)
  if (!row) throw new HttpError(404, "Message not found")
  return row
}
const tooLate = "Cancellation was too late: the provider already accepted this message."
const terminal = (row: Row) => row.status === "delivered" || row.status === "cancelled"

async function providerCall(route: "/deliver" | "/cancel", envelope: Envelope) {
  const response = await fetch(provider.origin + route, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(route === "/deliver" ? envelope : { idempotencyKey: envelope.idempotencyKey }),
  })
  if (!response.ok) throw new Error(`Provider ${route === "/cancel" ? "cancellation" : "delivery"} returned HTTP ${response.status}; the outcome is not confirmed.`)
  const result = await response.json() as { status?: unknown; receipt?: Partial<Receipt>; idempotencyKey?: unknown } | null
  if (result?.status === "cancelled" && result.idempotencyKey === envelope.idempotencyKey) return { status: "cancelled" as const }
  const receipt = result?.receipt
  if (result?.status === "accepted" && receipt && typeof receipt.id === "string" && receipt.id.length > 0 &&
    receipt.idempotencyKey === envelope.idempotencyKey && receipt.messageId === envelope.messageId && receipt.ticketId === envelope.ticketId && receipt.body === envelope.body) {
    return { status: "accepted" as const, receipt: receipt as Receipt }
  }
  throw new Error("Provider returned an invalid response; the outcome is not confirmed.")
}
function settle(id: string, result: Awaited<ReturnType<typeof providerCall>>) {
  const row = requiredMessage(id)
  const delivery = deliveryOf(row)!
  // Every continuation re-reads durable state. A late HTTP response cannot undo a terminal outcome.
  if (terminal(row)) return
  if (result.status === "accepted") {
    delivery.receiptId = result.receipt.id
    delivery.lastError = delivery.cancelRequested ? tooLate : null
    save(row, "delivered", delivery)
  } else {
    delivery.lastError = null
    save(row, "cancelled", delivery)
  }
}
function failed(id: string, failure: unknown, cancelling: boolean) {
  const row = requiredMessage(id)
  if (terminal(row)) return
  const delivery = deliveryOf(row)!
  // Do not let an older send failure replace the cancellation's more useful explanation.
  if (!cancelling && delivery.cancelRequested) return
  delivery.lastError = (cancelling ? "Cancellation unresolved. " : "Delivery unconfirmed. ") + (failure instanceof Error ? failure.message : "Provider connection failed.")
  save(row, "retryable", delivery)
}
const cancellations = new Map<string, Promise<void>>()
function cancel(id: string): Promise<void> {
  const row = requiredMessage(id)
  const delivery = deliveryOf(row)
  if (!delivery) { save(row, "cancelled", null); return Promise.resolve() }
  delivery.cancelRequested = true
  if (row.status === "delivered") delivery.lastError = tooLate
  save(row, terminal(row) ? row.status : "sending", delivery)
  if (terminal(row)) return Promise.resolve()
  if (delivery.attempts === 0) { save(row, "cancelled", delivery); return Promise.resolve() }
  const existing = cancellations.get(id)
  if (existing) return existing
  const envelope = JSON.parse(work(id)!.envelope) as Envelope
  const operation = (async () => {
    try { settle(id, await providerCall("/cancel", envelope)) }
    catch (failure) { failed(id, failure, true) }
  })().finally(() => { cancellations.delete(id) })
  cancellations.set(id, operation)
  return operation
}
const active = new Map<string, Promise<void>>()
function attempt(id: string): Promise<void> {
  const existing = active.get(id)
  if (existing) return existing
  const row = requiredMessage(id)
  if (row.status !== "queued") return Promise.resolve()
  const delivery = deliveryOf(row)!
  if (delivery.cancelRequested) return cancel(id)
  const envelope = JSON.parse(work(id)!.envelope) as Envelope
  delivery.attempts += 1
  delivery.lastError = null
  save(row, "sending", delivery)
  const operation = (async () => {
    try { settle(id, await providerCall("/deliver", envelope)) }
    catch (failure) { failed(id, failure, false) }
  })().finally(() => { active.delete(id) })
  active.set(id, operation)
  return operation
}
let draining: Promise<string[]> | null = null
function drain() {
  if (draining) return draining
  const ids = db.query<{ id: string }, []>("SELECT id FROM messages WHERE status = 'queued' ORDER BY seq").all().map((row) => row.id)
  draining = Promise.all(ids.map(attempt)).then(() => ids).finally(() => { draining = null })
  return draining
}

async function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname
  if (request.method === "GET" && path === "/api/health") return json({ ok: true, providerOrigin: provider.origin })
  if (request.method === "GET" && path === "/api/tickets") return json({ tickets })
  if (request.method === "GET" && path === "/api/outbox") return json({ items: db.query<Row, []>("SELECT messages.* FROM messages JOIN outbox ON outbox.message_id = messages.id ORDER BY seq").all().map(message) })
  if (request.method === "POST" && path === "/api/outbox/drain") { await input(request); return json({ processed: await drain() }) }
  const ticketRoute = /^\/api\/tickets\/([^/]+)(\/messages)?$/.exec(path)
  if (ticketRoute) {
    const ticket = tickets.find((item) => item.id === ticketRoute[1])
    if (!ticket) throw new HttpError(404, "Ticket not found")
    if (request.method === "GET" && !ticketRoute[2]) return json({ ticket, messages: db.query<Row, [string]>("SELECT * FROM messages WHERE ticket_id = ? ORDER BY seq").all(ticket.id).map(message) })
    if (request.method === "POST" && ticketRoute[2]) {
      const body = bodyFrom(await input(request))
      const id = crypto.randomUUID()
      db.query("INSERT INTO messages (id, ticket_id, body, status) VALUES (?, ?, ?, 'draft')").run(id, ticket.id, body)
      return json({ message: message(get(id)!) }, 201)
    }
  }
  const messageRoute = /^\/api\/messages\/([^/]+)(\/(send|cancel|retry))?$/.exec(path)
  if (messageRoute) {
    const id = messageRoute[1]!
    requiredMessage(id)
    if (request.method === "GET" && !messageRoute[2]) return json({ message: message(requiredMessage(id)) })
    if (request.method === "PATCH" && !messageRoute[2]) {
      const body = bodyFrom(await input(request))
      const row = requiredMessage(id)
      if (row.status !== "draft") throw new HttpError(409, "Only drafts can be edited")
      db.query("UPDATE messages SET body = ? WHERE id = ?").run(body, id)
      return json({ message: message(get(id)!) })
    }
    if (request.method === "POST" && messageRoute[3]) {
      const value = await input(request)
      if (messageRoute[3] === "send") {
        if (!validId(value.requestId)) throw new HttpError(400, "requestId must contain 1-80 ASCII letters, digits, underscores or hyphens")
        const requestId = value.requestId
        const admitted = db.transaction(() => {
          const row = requiredMessage(id)
          const previous = work(id)
          if (previous) {
            if (previous.request_id !== requestId) throw new HttpError(409, "Message already admitted with a different requestId")
            return row
          }
          if (db.query("SELECT 1 FROM outbox WHERE request_id = ?").get(requestId)) throw new HttpError(409, "requestId is already used by another message")
          if (row.status !== "draft") throw new HttpError(409, "Only drafts can be queued")
          const delivery: Delivery = { idempotencyKey: crypto.randomUUID(), attempts: 0, receiptId: null, lastError: null, cancelRequested: false }
          const envelope: Envelope = { idempotencyKey: delivery.idempotencyKey, messageId: id, ticketId: row.ticket_id, body: row.body }
          db.query("INSERT INTO outbox (message_id, request_id, idempotency_key, envelope) VALUES (?, ?, ?, ?)").run(id, requestId, delivery.idempotencyKey, JSON.stringify(envelope))
          save(row, "queued", delivery)
          return requiredMessage(id)
        })()
        return json({ message: message(admitted) }, 202)
      }
      if (messageRoute[3] === "cancel") { await cancel(id); return json({ message: message(requiredMessage(id)) }) }
      if (messageRoute[3] === "retry") {
        const row = requiredMessage(id)
        if (row.status !== "retryable" && row.status !== "queued") throw new HttpError(409, "Only retryable or queued messages can be retried")
        save(row, "queued", deliveryOf(row))
        return json({ message: message(requiredMessage(id)) })
      }
    }
  }
  if (path.startsWith("/api/")) return json({ error: "Not found" }, 404)
  const asset = path === "/" ? "index.html" : path === "/app.js" ? "app.js" : path === "/style.css" ? "style.css" : null
  if (!asset || request.method !== "GET") return json({ error: "Not found" }, 404)
  return new Response(Bun.file(join(root, "web", asset)))
}
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.PORT ?? 4123), idleTimeout: 0,
  async fetch(request) {
    try { return await handle(request) }
    catch (failure) {
      if (failure instanceof HttpError) return json({ error: failure.message }, failure.status)
      console.error(failure)
      return json({ error: "The request could not be completed" }, 500)
    }
  },
})
console.log(`Support desk listening on 127.0.0.1:${server.port}`)
