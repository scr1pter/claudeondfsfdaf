// Protected benchmark-local fixture. All data and delivery effects are synthetic.
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { isAbsolute, join } from "node:path"

type Envelope = { idempotencyKey: string; messageId: string; ticketId: string; body: string }
type Receipt = Envelope & { id: string }
type StoredReceipt = { key: string; envelope: string; receipt: string }
type Plan = { message_id: string; mode: string; consumed: number }
type Held = { envelope: Envelope; stage: string; resolve: (response: Response) => void }
const modes = ["accept", "reject", "fail_once", "before_accept", "after_accept"]
const json = (value: unknown, status = 200) => Response.json(value, { status })
const validID = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value)

export function startProvider(dataDirectory: string) {
  if (!isAbsolute(dataDirectory)) throw new Error("Provider DATA_DIR must be absolute")
  mkdirSync(dataDirectory, { recursive: true })
  const db = new Database(join(dataDirectory, "provider.sqlite"), { create: true })
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, envelope TEXT NOT NULL, receipt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cancellations (key TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS plans (message_id TEXT PRIMARY KEY, mode TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS cancel_plans (key TEXT PRIMARY KEY, mode TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS attempts (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, message_id TEXT NOT NULL, envelope TEXT NOT NULL);
  `)
  const held = new Map<string, Held>()
  const getReceipt = (key: string) => db.query<StoredReceipt, [string]>("SELECT * FROM receipts WHERE key = ?").get(key)
  const receiptReply = (row: StoredReceipt) => json({ status: "accepted", receipt: JSON.parse(row.receipt) as Receipt })
  const cancelled = (key: string) => Boolean(db.query("SELECT key FROM cancellations WHERE key = ?").get(key))
  const cancelledReply = (key: string) => json({ status: "cancelled", idempotencyKey: key })
  const accept = db.transaction((envelope: Envelope) => {
    const prior = getReceipt(envelope.idempotencyKey)
    if (prior) return prior.envelope === JSON.stringify(envelope) ? receiptReply(prior) : json({ error: "idempotency_conflict" }, 409)
    if (cancelled(envelope.idempotencyKey)) return cancelledReply(envelope.idempotencyKey)
    const receipt = { ...envelope, id: "receipt-" + crypto.randomUUID() }
    db.query("INSERT INTO receipts (key, envelope, receipt) VALUES (?, ?, ?)").run(envelope.idempotencyKey, JSON.stringify(envelope), JSON.stringify(receipt))
    return json({ status: "accepted", receipt })
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true })
      if (request.method === "GET" && url.pathname === "/control/state") return json({
        receipts: db.query<StoredReceipt, []>("SELECT * FROM receipts ORDER BY rowid").all().map((row) => JSON.parse(row.receipt) as Receipt),
        cancellations: db.query<{ key: string }, []>("SELECT key FROM cancellations ORDER BY rowid").all().map((row) => row.key),
        plans: db.query<Plan, []>("SELECT * FROM plans ORDER BY message_id").all(),
        cancelPlans: db.query("SELECT * FROM cancel_plans ORDER BY key").all(),
        attempts: db.query<{ seq: number; key: string; message_id: string; envelope: string }, []>("SELECT * FROM attempts ORDER BY seq").all().map((row) => ({ ...row, envelope: JSON.parse(row.envelope) as Envelope })),
        held: [...held.values()].map((item) => ({ messageId: item.envelope.messageId, idempotencyKey: item.envelope.idempotencyKey, stage: item.stage })),
      })
      if (request.method !== "POST") return json({ error: "not_found" }, 404)
      const input: unknown = await request.json().catch(() => null)
      if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "invalid_json_object" }, 400)
      const body = input as Record<string, unknown>
      if (url.pathname === "/control/plan") {
        if (!validID(body.messageId) || typeof body.mode !== "string" || !modes.includes(body.mode)) return json({ error: "invalid_plan" }, 400)
        db.query("INSERT INTO plans (message_id, mode, consumed) VALUES (?, ?, 0) ON CONFLICT(message_id) DO UPDATE SET mode = excluded.mode, consumed = 0").run(body.messageId, body.mode)
        return json({ ok: true })
      }
      if (url.pathname === "/control/release") {
        if (!validID(body.messageId) || !["receipt", "lost"].includes(String(body.response))) return json({ error: "invalid_release" }, 400)
        const item = held.get(body.messageId)
        if (!item) return json({ error: "not_held" }, 409)
        held.delete(body.messageId)
        db.query("UPDATE plans SET mode = 'accept', consumed = 0 WHERE message_id = ?").run(body.messageId)
        const accepted = accept(item.envelope)
        item.resolve(body.response === "lost" ? json({ error: "accepted_response_lost" }, 503) : accepted)
        return json({ ok: true })
      }
      if (url.pathname === "/control/cancel-plan") {
        if (!validID(body.idempotencyKey) || !["accept", "fail_once"].includes(String(body.mode))) return json({ error: "invalid_cancel_plan" }, 400)
        db.query("INSERT INTO cancel_plans (key, mode, consumed) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET mode = excluded.mode, consumed = 0").run(body.idempotencyKey, String(body.mode))
        return json({ ok: true })
      }
      if (url.pathname === "/cancel") {
        if (!validID(body.idempotencyKey)) return json({ error: "invalid_key" }, 400)
        const plan = db.query<{ mode: string; consumed: number }, [string]>("SELECT mode, consumed FROM cancel_plans WHERE key = ?").get(body.idempotencyKey)
        if (plan?.mode === "fail_once" && plan.consumed === 0) {
          db.query("UPDATE cancel_plans SET consumed = 1 WHERE key = ?").run(body.idempotencyKey)
          return json({ error: "synthetic_cancellation_failure" }, 503)
        }
        const result = db.transaction((key: string) => {
          const prior = getReceipt(key)
          if (prior) return receiptReply(prior)
          db.query("INSERT OR IGNORE INTO cancellations (key) VALUES (?)").run(key)
          for (const [messageId, item] of held) {
            if (item.envelope.idempotencyKey !== key || item.stage !== "before_accept") continue
            held.delete(messageId)
            item.resolve(cancelledReply(key))
          }
          return cancelledReply(key)
        })(body.idempotencyKey)
        return result
      }
      if (url.pathname !== "/deliver") return json({ error: "not_found" }, 404)
      if (!validID(body.idempotencyKey) || !validID(body.messageId) || !validID(body.ticketId) || typeof body.body !== "string" || !body.body.trim() || body.body.length > 2000) return json({ error: "invalid_envelope" }, 400)
      const envelope: Envelope = { idempotencyKey: body.idempotencyKey, messageId: body.messageId, ticketId: body.ticketId, body: body.body }
      db.query("INSERT INTO attempts (key, message_id, envelope) VALUES (?, ?, ?)").run(envelope.idempotencyKey, envelope.messageId, JSON.stringify(envelope))
      const prior = getReceipt(envelope.idempotencyKey)
      if (prior) return prior.envelope === JSON.stringify(envelope) ? receiptReply(prior) : json({ error: "idempotency_conflict" }, 409)
      if (cancelled(envelope.idempotencyKey)) return cancelledReply(envelope.idempotencyKey)
      const plan = db.query<Plan, [string]>("SELECT * FROM plans WHERE message_id = ?").get(envelope.messageId)
      if (plan?.mode === "reject") return json({ error: "synthetic_rejection" }, 503)
      if (plan?.mode === "fail_once" && plan.consumed === 0) {
        db.query("UPDATE plans SET consumed = 1 WHERE message_id = ?").run(envelope.messageId)
        return json({ error: "synthetic_first_attempt_failure" }, 503)
      }
      if (plan?.mode === "before_accept" || plan?.mode === "after_accept") {
        if (held.has(envelope.messageId)) return json({ error: "already_held" }, 503)
        if (plan.mode === "after_accept") accept(envelope)
        return new Promise<Response>((resolve) => held.set(envelope.messageId, { envelope, stage: plan.mode, resolve }))
      }
      return accept(envelope)
    },
  })
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => { server.stop(true); db.close() } }
}
