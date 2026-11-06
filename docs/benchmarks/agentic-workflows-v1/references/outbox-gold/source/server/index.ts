import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { startProvider } from "../fixtures/provider"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dataDirectory = resolve(process.env.DATA_DIR ?? join(root, "..", "support-data"))
if (relative(root, dataDirectory) !== ".." && !relative(root, dataDirectory).startsWith(".." + sep)) throw new Error("DATA_DIR must be outside application source")
mkdirSync(dataDirectory, { recursive: true })
const db = new Database(join(dataDirectory, "support.sqlite"), { create: true })
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
    ticket_id TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outbox (
    message_id TEXT PRIMARY KEY REFERENCES messages(id), request_id TEXT UNIQUE NOT NULL,
    idempotency_key TEXT UNIQUE NOT NULL, envelope_ticket TEXT NOT NULL, envelope_body TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, receipt_id TEXT, last_error TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0, work_state TEXT NOT NULL
  );
`)

type Ticket = { id: string; subject: string; customer: string; summary: string }
type Row = { seq: number; id: string; ticket_id: string; body: string; status: string;
  message_id: string | null; request_id: string | null; idempotency_key: string | null;
  envelope_ticket: string | null; envelope_body: string | null; attempts: number | null;
  receipt_id: string | null; last_error: string | null; cancel_requested: number | null; work_state: string | null }
type Envelope = { idempotencyKey: string; messageId: string; ticketId: string; body: string }
type Receipt = Envelope & { id: string }
type Outcome = { status: "accepted"; receipt: Receipt } | { status: "cancelled" } | { status: "failed"; error: string }
const tickets = await Bun.file(join(root, "fixtures/tickets.json")).json() as Ticket[]
const provider = startProvider(dataDirectory)
const select = "SELECT m.seq, m.id, m.ticket_id, m.body, m.status, o.* FROM messages m LEFT JOIN outbox o ON o.message_id = m.id "
const get = (id: string) => db.query<Row, [string]>(select + "WHERE m.id = ?").get(id)
const terminal = (status: string) => status === "delivered" || status === "cancelled"
const json = (value: unknown, status = 200) => Response.json(value, { status })
const failure = (error: string, status = 400) => json({ error }, status)
const validID = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value)
const validBody = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= 2000
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const message = (row: Row) => ({ id: row.id, ticketId: row.ticket_id, body: row.body, status: row.status,
  delivery: row.message_id ? { idempotencyKey: row.idempotency_key!, attempts: row.attempts!, receiptId: row.receipt_id,
    lastError: row.last_error, cancelRequested: Boolean(row.cancel_requested) } : null })
const envelope = (row: Row): Envelope => ({ idempotencyKey: row.idempotency_key!, messageId: row.id,
  ticketId: row.envelope_ticket!, body: row.envelope_body! })
const tooLate = "Cancellation was too late: the provider had already accepted this reply."

// An active claim is advisory. The immutable envelope and attempt count survive its owner.
db.transaction(() => {
  db.query("UPDATE messages SET status = 'queued' WHERE status NOT IN ('delivered', 'cancelled') AND id IN (SELECT message_id FROM outbox WHERE work_state = 'active')").run()
  db.query("UPDATE outbox SET work_state = 'pending', last_error = COALESCE(last_error, 'Interrupted attempt; process the queue to reconcile its original delivery key.') WHERE work_state = 'active' AND receipt_id IS NULL").run()
})()

async function providerRequest(path: "/deliver" | "/cancel", row: Row): Promise<Outcome> {
  const expected = envelope(row)
  const response = await fetch(provider.origin + path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(path === "/deliver" ? expected : { idempotencyKey: expected.idempotencyKey }) }).catch(() => null)
  if (!response) return { status: "failed", error: "The provider response was unavailable. Retry to reconcile the original delivery key." }
  const result: unknown = await response.json().catch(() => null)
  if (!response.ok) return { status: "failed", error: "The provider did not confirm the request (HTTP " + response.status + ")." }
  if (!object(result)) return { status: "failed", error: "The provider returned an invalid response." }
  if (result.status === "cancelled" && result.idempotencyKey === expected.idempotencyKey) return { status: "cancelled" }
  const receipt = result.receipt
  if (result.status !== "accepted" || !object(receipt) || typeof receipt.id !== "string" || !receipt.id ||
      receipt.idempotencyKey !== expected.idempotencyKey || receipt.messageId !== expected.messageId ||
      receipt.ticketId !== expected.ticketId || receipt.body !== expected.body) return { status: "failed", error: "The provider did not return a matching delivery receipt." }
  return { status: "accepted", receipt: { ...expected, id: receipt.id } }
}

const settle = db.transaction((id: string, outcome: Outcome) => {
  const row = get(id)!
  // An established outcome wins over a late HTTP failure or cancellation result.
  if (terminal(row.status)) return
  if (outcome.status === "accepted") {
    db.query("UPDATE outbox SET receipt_id = ?, last_error = ?, work_state = 'terminal' WHERE message_id = ?").run(outcome.receipt.id, row.cancel_requested ? tooLate : null, id)
    db.query("UPDATE messages SET status = 'delivered' WHERE id = ?").run(id)
    return
  }
  if (outcome.status === "cancelled") {
    db.query("UPDATE outbox SET cancel_requested = 1, last_error = NULL, work_state = 'terminal' WHERE message_id = ?").run(id)
    db.query("UPDATE messages SET status = 'cancelled' WHERE id = ?").run(id)
    return
  }
  db.query("UPDATE outbox SET last_error = ?, work_state = 'retry_wait' WHERE message_id = ?").run(outcome.error, id)
  db.query("UPDATE messages SET status = 'retryable' WHERE id = ?").run(id)
})

const admit = db.transaction((id: string, requestId: string) => {
  const row = get(id)!
  const binding = db.query<{ message_id: string }, [string]>("SELECT message_id FROM outbox WHERE request_id = ?").get(requestId)
  if (binding && binding.message_id !== id) return failure("This request ID already belongs to another reply.", 409)
  if (row.message_id) return row.request_id === requestId ? json({ message: message(row) }, 202) : failure("This reply already has a different admission request.", 409)
  if (row.status !== "draft") return failure("Only a draft can be admitted for delivery.", 409)
  db.query("INSERT INTO outbox (message_id, request_id, idempotency_key, envelope_ticket, envelope_body, work_state) VALUES (?, ?, ?, ?, ?, 'pending')").run(id, requestId, crypto.randomUUID(), row.ticket_id, row.body)
  db.query("UPDATE messages SET status = 'queued' WHERE id = ?").run(id)
  return json({ message: message(get(id)!) }, 202)
})

const claim = db.transaction((id: string) => {
  const row = get(id)!
  if (row.work_state !== "pending" || terminal(row.status)) return null
  db.query("UPDATE outbox SET work_state = 'active', attempts = attempts + ?, last_error = NULL WHERE message_id = ?").run(row.cancel_requested ? 0 : 1, id)
  db.query("UPDATE messages SET status = 'sending' WHERE id = ?").run(id)
  return get(id)!
})

async function processQueue() {
  const eligible = db.query<{ message_id: string }, []>("SELECT o.message_id FROM outbox o JOIN messages m ON m.id = o.message_id WHERE o.work_state = 'pending' ORDER BY m.seq").all()
  const processed: string[] = []
  for (const item of eligible) {
    const row = claim(item.message_id)
    if (!row) continue
    processed.push(row.id)
    settle(row.id, await providerRequest(row.cancel_requested ? "/cancel" : "/deliver", row))
  }
  return { processed }
}

async function cancel(id: string) {
  const preparation = db.transaction(() => {
    const row = get(id)!
    if (row.status === "cancelled") return null
    if (row.status === "draft") {
      db.query("UPDATE messages SET status = 'cancelled' WHERE id = ?").run(id)
      return null
    }
    db.query("UPDATE outbox SET cancel_requested = 1 WHERE message_id = ?").run(id)
    if (row.status === "delivered") {
      db.query("UPDATE outbox SET last_error = ? WHERE message_id = ?").run(tooLate, id)
      return null
    }
    if (row.attempts === 0 && row.work_state === "pending") {
      db.query("UPDATE messages SET status = 'cancelled' WHERE id = ?").run(id)
      db.query("UPDATE outbox SET work_state = 'terminal', last_error = NULL WHERE message_id = ?").run(id)
      return null
    }
    return get(id)!
  })()
  if (preparation) settle(id, await providerRequest("/cancel", preparation))
  return json({ message: message(get(id)!) })
}

const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT ?? 4123), idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (request.method === "GET" && path === "/api/health") return json({ ok: true, providerOrigin: provider.origin })
    if (request.method === "GET" && path === "/api/tickets") return json({ tickets })
    if (request.method === "GET" && path === "/api/outbox") return json({ items: db.query<Row, []>(select + "WHERE o.message_id IS NOT NULL ORDER BY m.seq").all().map(message) })
    if (path === "/api/outbox/drain" && request.method === "POST") {
      const input: unknown = await request.json().catch(() => null)
      return object(input) ? json(await processQueue()) : failure("Request must be a JSON object.")
    }
    const ticketRoute = /^\/api\/tickets\/([^/]+)(\/messages)?$/.exec(path)
    if (ticketRoute) {
      const ticket = tickets.find((item) => item.id === ticketRoute[1])
      if (!ticket) return failure("Ticket not found.", 404)
      if (request.method === "GET" && !ticketRoute[2]) return json({ ticket, messages: db.query<Row, [string]>(select + "WHERE m.ticket_id = ? ORDER BY m.seq").all(ticket.id).map(message) })
      if (request.method === "POST" && ticketRoute[2]) {
        const input: unknown = await request.json().catch(() => null)
        if (!object(input)) return failure("Request must be a JSON object.")
        if (!validBody(input.body)) return failure("Reply must contain 1–2000 characters.")
        const id = crypto.randomUUID()
        db.query("INSERT INTO messages (id, ticket_id, body, status) VALUES (?, ?, ?, 'draft')").run(id, ticket.id, input.body)
        return json({ message: message(get(id)!) }, 201)
      }
    }
    const messageRoute = /^\/api\/messages\/([^/]+)(\/(send|retry|cancel))?$/.exec(path)
    if (messageRoute) {
      const id = messageRoute[1]!
      if (!get(id)) return failure("Message not found.", 404)
      if (request.method === "GET" && !messageRoute[2]) return json({ message: message(get(id)!) })
      if (request.method === "PATCH" && !messageRoute[2]) {
        const input: unknown = await request.json().catch(() => null)
        if (!object(input)) return failure("Request must be a JSON object.")
        if (!validBody(input.body)) return failure("Reply must contain 1–2000 characters.")
        return db.transaction((body: string) => {
          if (get(id)!.status !== "draft") return failure("Only drafts can be edited.", 409)
          db.query("UPDATE messages SET body = ? WHERE id = ?").run(body, id)
          return json({ message: message(get(id)!) })
        })(input.body)
      }
      if (request.method === "POST" && messageRoute[2]) {
        const input: unknown = await request.json().catch(() => null)
        if (!object(input)) return failure("Request must be a JSON object.")
        if (messageRoute[3] === "send") return validID(input.requestId) ? admit(id, input.requestId) : failure("Admission request ID must contain 1–80 letters, digits, underscores or hyphens.")
        if (messageRoute[3] === "cancel") return cancel(id)
        if (messageRoute[3] === "retry") return db.transaction(() => {
          const row = get(id)!
          if (row.status !== "retryable" && row.status !== "queued") return failure("Only a retryable reply can be queued again.", 409)
          if (row.status === "retryable") {
            db.query("UPDATE messages SET status = 'queued' WHERE id = ?").run(id)
            db.query("UPDATE outbox SET work_state = 'pending' WHERE message_id = ?").run(id)
          }
          return json({ message: message(get(id)!) })
        })()
      }
    }
    if (path.startsWith("/api/")) return failure("Not found.", 404)
    const asset = path === "/" ? "index.html" : path === "/app.js" ? "app.js" : path === "/style.css" ? "style.css" : null
    if (!asset || request.method !== "GET") return new Response("Not found", { status: 404 })
    return new Response(Bun.file(join(root, "web", asset)))
  },
})
console.log(`Support desk listening on 127.0.0.1:${server.port}`)
