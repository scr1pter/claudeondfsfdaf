import { constants } from "node:fs"
import { mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const filesystemCodes = ["EACCES", "EBUSY", "EEXIST", "EIO", "ENOENT", "EPERM", "ENOTEMPTY"]
function failureCode(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
  return typeof code === "string" && filesystemCodes.includes(code) ? code : "other"
}

async function replace(root: string, held: boolean) {
  const leaf = join(root, held ? "held.json" : "unheld.json")
  const temporary = leaf + ".tmp"
  await writeFile(leaf, "queued", { mode: 0o600, flag: "wx" })
  await writeFile(temporary, "terminal", { mode: 0o600, flag: "wx" })
  const lease = held
    ? await open(leaf, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
    : undefined
  let code: string | undefined
  try {
    await rename(temporary, leaf)
  } catch (error) {
    code = failureCode(error)
  } finally {
    await lease?.close()
  }
  const bytes = await readFile(leaf, "utf8")
  return { renamed: code === undefined, code, leaf: bytes === "queued" || bytes === "terminal" ? bytes : "unexpected" }
}

async function probe() {
  const root = await mkdtemp(join(tmpdir(), "vector-receipt-handle-"))
  try {
    const held = await replace(root, true)
    const unheld = await replace(root, false)
    return { held, unheld }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 })
  }
}

if (process.platform !== "win32") {
  console.log(JSON.stringify({ skipped: true, reason: "windows-only", bun: Bun.version }))
} else {
  try {
    const result = await probe()
    console.log(JSON.stringify({ bun: Bun.version, ...result }))
    const heldLeaf = result.held.renamed ? "terminal" : "queued"
    if (result.held.leaf !== heldLeaf || !result.unheld.renamed || result.unheld.leaf !== "terminal")
      process.exitCode = 1
  } catch (error) {
    console.log(JSON.stringify({ bun: Bun.version, failed: failureCode(error) }))
    process.exitCode = 1
  }
}
