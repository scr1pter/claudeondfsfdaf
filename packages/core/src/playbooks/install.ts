export * as PlaybookInstall from "./install"

import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Playbooks } from "@vectordevai/schema/playbooks"
import { PlaybookCheck } from "./check"
export type Request = (url: string, init?: RequestInit) => Promise<Response>

/** The link comes from the authenticated account listing. Tokens are never forwarded to its signed download URL. */
export async function download(link: Playbooks.Link, request: Request = fetch) {
  if (!Playbooks.decodeLinks([link])) throw new Error("The playbook listing is invalid.")
  const response = await request(link.url, { redirect: "error", signal: AbortSignal.timeout(30_000) })
  if (!response.ok || !response.body) throw new Error("The playbook could not be downloaded.")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > Playbooks.MAX_BYTES) throw new Error("The playbook exceeds 256 KiB.")
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = Buffer.concat(chunks)
  if (createHash("sha256").update(bytes).digest("hex") !== link.sha256)
    throw new Error("The playbook does not match its published SHA-256.")
  const checked = PlaybookCheck.validate({ name: link.name, bytes })
  if (!checked.ok) throw new Error(checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"))
  return bytes
}

/** Only the owning client supplies its personal configuration directory; no project root is accepted by the CLI. */
export async function install(input: {
  readonly link: Playbooks.Link
  readonly directory: string
  readonly request?: Request
  readonly replace?: boolean
}) {
  const bytes = await download(input.link, input.request)
  const directory = path.join(input.directory, "workflows")
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("The workflows folder must not be a symbolic link.")
  const target = path.join(directory, `${input.link.name}.json`)
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error("An installed playbook must be a regular file.")
  if (existing && !input.replace) throw new Error("This playbook is installed already. Use --replace to replace it.")
  const temporary = path.join(directory, `.${input.link.name}-${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
    if (input.replace) await fs.rename(temporary, target)
    else await fs.link(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true })
  }
  return { path: target, name: input.link.name, version: input.link.version, sha256: input.link.sha256 }
}
