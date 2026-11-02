import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

async function start(dataDirectory: string) {
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "--no-env-file", "server/index.ts"], {
    cwd: root,
    env: { PATH: Bun.env.PATH, SystemRoot: Bun.env.SystemRoot, WINDIR: Bun.env.WINDIR, PORT: "0", DATA_DIR: dataDirectory },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("App did not become ready")), 10_000)
      const reader = process.stdout.getReader()
      const decoder = new TextDecoder()
      void (async () => {
        let text = ""
        while (text.length < 4096) {
          const chunk = await reader.read()
          if (chunk.done) throw new Error("App exited before readiness")
          text += decoder.decode(chunk.value, { stream: true })
          const ready = /Support desk listening on (127\.0\.0\.1:\d+)/.exec(text)
          if (!ready) continue
          resolve("http://" + ready[1])
          return
        }
        throw new Error("Unexpected startup output")
      })().catch(reject).finally(() => { clearTimeout(deadline); reader.releaseLock() })
    })
    return { process, origin }
  } catch (failure) {
    process.kill("SIGKILL")
    await process.exited
    throw failure
  }
}

test("existing ticket and draft workflow persists across an app restart", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "support-seed-smoke-"))
  let running: Awaited<ReturnType<typeof start>> | undefined
  try {
    running = await start(dataDirectory)
    const catalog = await fetch(running.origin + "/api/tickets").then((response) => response.json()) as { tickets: { id: string }[] }
    expect(catalog.tickets.map((ticket) => ticket.id)).toEqual(["t-101", "t-102", "t-103"])
    const created = await fetch(running.origin + "/api/tickets/t-101/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "Synthetic saved draft" }) })
    expect(created.status).toBe(201)
    const draft = await created.json() as { message: { id: string; status: string } }
    expect(draft.message.status).toBe("draft")
    const edited = await fetch(running.origin + "/api/messages/" + draft.message.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "Edited synthetic draft" }) })
    expect(edited.status).toBe(200)
    running.process.kill("SIGKILL")
    await running.process.exited
    running = await start(dataDirectory)
    const restored = await fetch(running.origin + "/api/messages/" + draft.message.id).then((response) => response.json()) as { message: { body: string; status: string } }
    expect(restored.message.body).toBe("Edited synthetic draft")
    expect(restored.message.status).toBe("draft")
    const health = await fetch(running.origin + "/api/health").then((response) => response.json()) as { providerOrigin: string }
    const provider = await fetch(health.providerOrigin + "/control/state").then((response) => response.json()) as { attempts: unknown[] }
    expect(provider.attempts).toEqual([])
  } finally {
    if (running) { running.process.kill("SIGKILL"); await running.process.exited }
    if (!resolve(dataDirectory).startsWith(resolve(tmpdir()) + sep) || !basename(dataDirectory).startsWith("support-seed-smoke-")) throw new Error("Refusing cleanup outside the owned temporary directory")
    await rm(dataDirectory, { recursive: true, force: true })
  }
}, 30_000)
