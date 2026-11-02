import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { startProvider } from "../fixtures/provider"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dataDirectory = resolve(process.env.DATA_DIR ?? join(root, "..", "support-data"))
if (!isAbsolute(dataDirectory) || (relative(root, dataDirectory) !== ".." && !relative(root, dataDirectory).startsWith(".." + sep))) throw new Error("DATA_DIR must be outside application source")
mkdirSync(dataDirectory, { recursive: true })
const db = new Database(join(dataDirectory, "support.sqlite"), { create: true })
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
  CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, ticket_id TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, delivery TEXT);
`)
type Ticket = { id: string; subject: string; customer: string; summary: string }
type Row = { seq: number; id: string; ticket_id: string; body: string; status: string; delivery: string | null }
const tickets = await Bun.file(join(root, "fixtures/tickets.json")).json() as Ticket[]
const provider = startProvider(dataDirectory)
const message = (row: Row) => ({ id: row.id, ticketId: row.ticket_id, body: row.body, status: row.status, delivery: row.delivery ? JSON.parse(row.delivery) as Record<string, unknown> : null })
const get = (id: string) => db.query<Row, [string]>("SELECT * FROM messages WHERE id = ?").get(id)
const json = (value: unknown, status = 200) => Response.json(value, { status })
const validBody = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 2000

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4123),
  idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (request.method === "GET" && path === "/api/health") return json({ ok: true, providerOrigin: provider.origin })
    if (request.method === "GET" && path === "/api/tickets") return json({ tickets })
    const ticketRoute = /^\/api\/tickets\/([^/]+)(\/messages)?$/.exec(path)
    if (ticketRoute) {
      const ticket = tickets.find((item) => item.id === ticketRoute[1])
      if (!ticket) return json({ error: "Ticket not found" }, 404)
      if (request.method === "GET" && !ticketRoute[2]) return json({ ticket, messages: db.query<Row, [string]>("SELECT * FROM messages WHERE ticket_id = ? ORDER BY seq").all(ticket.id).map(message) })
      if (request.method === "POST" && ticketRoute[2]) {
        const input = await request.json().catch(() => null) as { body?: unknown } | null
        if (!validBody(input?.body)) return json({ error: "Reply must contain 1–2000 characters" }, 400)
        const id = crypto.randomUUID()
        db.query("INSERT INTO messages (id, ticket_id, body, status) VALUES (?, ?, ?, 'draft')").run(id, ticket.id, input.body)
        return json({ message: message(get(id)!) }, 201)
      }
    }
    const messageRoute = /^\/api\/messages\/([^/]+)(\/(send|cancel))?$/.exec(path)
    if (messageRoute) {
      const row = get(messageRoute[1]!)
      if (!row) return json({ error: "Message not found" }, 404)
      if (request.method === "GET" && !messageRoute[2]) return json({ message: message(row) })
      if (request.method === "PATCH" && !messageRoute[2]) {
        if (row.status !== "draft") return json({ error: "Only drafts can be edited" }, 409)
        const input = await request.json().catch(() => null) as { body?: unknown } | null
        if (!validBody(input?.body)) return json({ error: "Reply must contain 1–2000 characters" }, 400)
        db.query("UPDATE messages SET body = ? WHERE id = ?").run(input.body, row.id)
        return json({ message: message(get(row.id)!) })
      }
      if (request.method === "POST" && messageRoute[3] === "cancel") {
        if (row.status !== "draft" && row.status !== "cancelled") return json({ error: "Only drafts can be cancelled in this version" }, 409)
        db.query("UPDATE messages SET status = 'cancelled' WHERE id = ?").run(row.id)
        return json({ message: message(get(row.id)!) })
      }
      if (request.method === "POST" && messageRoute[3] === "send") {
        if (row.status !== "draft" && row.status !== "failed") return json({ error: "Message has already been sent" }, 409)
        const delivery = { idempotencyKey: crypto.randomUUID(), attempts: 1, receiptId: null as string | null, lastError: null as string | null, cancelRequested: false }
        db.query("UPDATE messages SET status = 'sending', delivery = ? WHERE id = ?").run(JSON.stringify(delivery), row.id)
        const response = await fetch(provider.origin + "/deliver", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: delivery.idempotencyKey, messageId: row.id, ticketId: row.ticket_id, body: row.body }) }).catch(() => null)
        const result = response ? await response.json().catch(() => null) as { receipt?: { id?: string } } | null : null
        delivery.receiptId = response?.ok && typeof result?.receipt?.id === "string" ? result.receipt.id : null
        delivery.lastError = delivery.receiptId ? null : "Delivery failed. Save your reply and try again."
        db.query("UPDATE messages SET status = ?, delivery = ? WHERE id = ?").run(delivery.receiptId ? "delivered" : "failed", JSON.stringify(delivery), row.id)
        return json({ message: message(get(row.id)!) })
      }
    }
    if (path.startsWith("/api/")) return json({ error: "Not found" }, 404)
    const asset = path === "/" ? "index.html" : path === "/app.js" ? "app.js" : path === "/style.css" ? "style.css" : null
    if (!asset || request.method !== "GET") return new Response("Not found", { status: 404 })
    return new Response(Bun.file(join(root, "web", asset)))
  },
})
console.log(`Support desk listening on 127.0.0.1:${server.port}`)
