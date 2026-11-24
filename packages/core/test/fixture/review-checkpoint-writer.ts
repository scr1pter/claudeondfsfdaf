// Test-owned synthetic receipt only. No provider, credentials, host socket or product process launch.
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { ReviewCheckpointLock } from "../../src/review/checkpoint-lock"

const directory = process.argv[2]
const timeout = Number(process.argv[3] ?? "0")
const send = (event: string) =>
  process.stdout.write(
    JSON.stringify({ event, runtime: process.versions.bun ? "bun" : "node", pid: process.pid }) + "\n",
  )
let waiting = false
try {
  const lease = await ReviewCheckpointLock.acquire("feature.json", {
    dir: directory,
    ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}),
    onWait() {
      if (waiting) return
      waiting = true
      send("waiting")
    },
  })
  send("acquired")
  const lines = createInterface({ input: process.stdin })
  for await (const command of lines) {
    if (command === "write") {
      await lease.use(async () => {
        const file = path.join(lease.directory, "feature.json")
        const before = await fs.readFile(file, "utf8").catch(() => "0")
        const temporary = `${file}.${randomUUID()}.tmp`
        const handle = await fs.open(temporary, "wx", 0o600)
        try {
          await handle.writeFile(String(Number(before) + 1))
          await handle.sync()
        } finally {
          await handle.close()
        }
        await fs.rename(temporary, file)
        await lease.sync()
      })
      send("written")
      continue
    }
    if (command !== "release") throw new Error("Unexpected test command")
    await lease.release()
    send("released")
    lines.close()
    process.stdin.pause()
    break
  }
} catch (error) {
  if (timeout && error instanceof Error && error.name === "TimeoutError") send("aborted")
  else {
    process.stderr.write(String(error) + "\n")
    process.exitCode = 1
  }
}
