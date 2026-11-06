import { expect } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export type Delivery = { idempotencyKey: string; attempts: number; receiptId: string | null; lastError: string | null; cancelRequested: boolean }
export type Message = { id: string; ticketId: string; body: string; status: string; delivery: Delivery | null }
type ProviderState = {
  receipts: { id: string; messageId: string; body: string; idempotencyKey: string }[]
  cancellations: unknown[]; attempts: { messageId: string }[]; held: { messageId: string }[]
}
export async function poll<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000
  let value: T
  do {
    value = await read()
    if (ready(value)) return value
    await Bun.sleep(15)
  } while (Date.now() < deadline)
  throw new Error("Observable state did not settle: " + JSON.stringify(value))
}

export class Harness {
  process?: ReturnType<typeof Bun.spawn>
  origin = ""
  providerOrigin = ""
  constructor(public dataDirectory: string) {}
  async start() {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "--no-env-file", "server/index.ts"], {
      cwd: root,
      env: { PATH: Bun.env.PATH, SystemRoot: Bun.env.SystemRoot, WINDIR: Bun.env.WINDIR, PORT: Bun.env.PORT ?? "4123", DATA_DIR: this.dataDirectory },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    })
    this.process = child
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000)
    try {
      let output = ""
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("App exited before readiness: " + await new Response(child.stderr).text())
        output += decoder.decode(chunk.value, { stream: true })
        const match = /Support desk listening on (127\.0\.0\.1:\d+)/.exec(output)
        if (match) { this.origin = "http://" + match[1]; break }
      }
    } finally { clearTimeout(timeout); reader.releaseLock() }
    const { data } = await this.request("/api/health")
    expect(data.ok).toBe(true)
    this.providerOrigin = data.providerOrigin
  }
  async stop() {
    if (this.process) { this.process.kill("SIGKILL"); await this.process.exited; this.process = undefined }
  }
  async request(path: string, method = "GET", value?: unknown, status = 200, raw = false) {
    const response = await fetch(this.origin + path, { method, headers: { "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: raw ? String(value) : JSON.stringify(value) }) })
    expect(response.headers.get("content-type")).toContain("application/json")
    const data = await response.json() as any
    expect(response.status).toBe(status)
    if (status >= 400) { expect(typeof data.error).toBe("string"); expect(data.error.length).toBeGreaterThan(0) }
    return { response, data }
  }
  async control(path: string, value?: unknown) {
    const response = await fetch(this.providerOrigin + "/control/" + path, { method: value === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })
    expect(response.ok).toBe(true)
    return await response.json() as any
  }
  async provider(): Promise<ProviderState> { return this.control("state") }
  async draft(body = "Synthetic durable reply"): Promise<Message> { return (await this.request("/api/tickets/t-101/messages", "POST", { body }, 201)).data.message }
  async get(id: string): Promise<Message> { return (await this.request("/api/messages/" + id)).data.message }
  async act(id: string, action: string): Promise<Message> { return (await this.request(`/api/messages/${id}/${action}`, "POST", {})).data.message }
  async admit(item: Message, requestId = "request_" + item.id): Promise<Message> { return (await this.request(`/api/messages/${item.id}/send`, "POST", { requestId }, 202)).data.message }
  async queued(body?: string) { return this.admit(await this.draft(body)) }
  async drain(): Promise<string[]> { return (await this.request("/api/outbox/drain", "POST", {})).data.processed }
  async held(id: string) { return poll(() => this.provider(), state => state.held.some(item => item.messageId === id)) }
}

export async function withHarness(work: (h: Harness) => Promise<void>) {
  if (!Bun.env.DATA_DIR) throw new Error("Tests require DATA_DIR outside application source")
  const base = resolve(Bun.env.DATA_DIR)
  const outside = relative(root, base)
  if (outside !== ".." && !outside.startsWith(".." + sep)) throw new Error("Test data must be outside source")
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, "outbox-check-"))
  const h = new Harness(directory)
  try { await h.start(); await work(h) }
  finally {
    await h.stop()
    if (!directory.startsWith(base + sep) || !directory.slice(base.length + 1).startsWith("outbox-check-")) throw new Error("Refusing unsafe test cleanup")
    await rm(directory, { recursive: true, force: true })
  }
}
