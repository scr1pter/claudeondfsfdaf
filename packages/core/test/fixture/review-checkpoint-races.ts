// A real Node holder proves close/rename ordering against a genuine Bun contender.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { ReviewCheckpointLock } from "../../src/review/checkpoint-lock"

const [scenario, directory, bun, originalWorker] = process.argv.slice(2)
assert.equal(scenario, "drain")
assert.equal(process.versions.bun, undefined)
const first = await ReviewCheckpointLock.acquire("feature.json", { dir: directory })
let entered!: () => void
let resume!: () => void
const ready = new Promise<void>((resolve) => (entered = resolve))
const barrier = new Promise<void>((resolve) => (resume = resolve))
const writing = first.use(async () => {
  const temporary = path.join(first.directory, "pending")
  await fs.writeFile(temporary, "1")
  entered()
  await barrier
  await fs.rename(temporary, path.join(first.directory, "feature.json"))
  await first.sync()
})
await ready
const closing = first.release()
const second = spawn(bun, [originalWorker, directory, "0"], {
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  stdio: ["pipe", "pipe", "pipe"],
})
const events = new Set<string>()
const listeners = new Map<string, () => void>()
let errors = ""
second.stderr.on("data", (chunk) => (errors += chunk.toString()))
const lines = createInterface({ input: second.stdout })
lines.on("line", (line) => {
  const value = JSON.parse(line)
  assert.equal(value.runtime, "bun")
  assert.equal(value.pid, second.pid)
  events.add(value.event)
  listeners.get(value.event)?.()
})
const wait = (event: string) => {
  if (events.has(event)) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${event}; ${errors}`)), 4000)
    const exit = () => {
      clearTimeout(timer)
      reject(new Error(`Exited before ${event}; ${errors}`))
    }
    second.once("exit", exit)
    listeners.set(event, () => {
      clearTimeout(timer)
      second.off("exit", exit)
      resolve()
    })
  })
}
try {
  await wait("waiting")
  assert(!events.has("acquired"))
  await assert.rejects(first.use(async () => undefined))
  resume()
  await writing
  await closing
  await wait("acquired")
  second.stdin.write("write\n")
  await wait("written")
  second.stdin.write("release\n")
  await wait("released")
  assert.equal(await fs.readFile(path.join(directory, "feature.json"), "utf8"), "2")
  process.stdout.write(JSON.stringify({ scenario, passed: true, parent: "node", drivers: ["node", "bun"] }) + "\n")
} finally {
  resume()
  await writing
  await closing
  if (second.exitCode === null && second.signalCode === null) {
    const exited = new Promise<void>((resolve) => second.once("exit", () => resolve()))
    second.kill("SIGKILL")
    await exited
  }
}
