import { expect } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export async function start(dataDirectory: string) {
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
export async function request(origin: string, path: string, method = "GET", body?: unknown, status = 200): Promise<any> {
  const response = await fetch(origin + path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  expect(response.status).toBe(status)
  expect(response.headers.get("content-type")).toContain("application/json")
  const result = await response.json() as any
  if (status >= 400) expect(typeof result.error === "string" && result.error.length > 0).toBe(true)
  return result
}
export async function harness() {
  const base = process.env.DATA_DIR
  if (!base || !isAbsolute(base) || !relative(root, base).startsWith(".." + sep)) throw new Error("Tests require DATA_DIR outside source")
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, "verification-"))
  let running = await start(directory)
  return {
    get origin() { return running.origin },
    async stop() { running.process.kill("SIGKILL"); await running.process.exited },
    async restart() { await this.stop(); running = await start(directory) },
    async close() { await this.stop(); await rm(directory, { recursive: true, force: true }) },
  }
}
export async function poll<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000
  while (true) {
    const value = await read()
    if (ready(value)) return value
    if (Date.now() >= deadline) throw new Error("Observable state did not settle: " + JSON.stringify(value))
    await Bun.sleep(20)
  }
}
