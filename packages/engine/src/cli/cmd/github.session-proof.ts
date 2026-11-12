import { createHash } from "node:crypto"
import { fstatSync, writeSync } from "node:fs"
import { z } from "zod"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { GithubSecrets } from "./github.secrets"

export const LIMIT = 256
export const Proof = z
  .object({
    v: z.literal(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().positive().max(GithubAgents.PATCH_LIMITS.sessionBytes),
  })
  .strict()
export type Proof = z.infer<typeof Proof>

export function digest(bytes: Uint8Array): Proof {
  return Proof.parse({ v: 1, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength })
}

export function parse(bytes: Uint8Array) {
  if (bytes.byteLength > LIMIT) throw new Error("The session artifact proof is invalid.")
  const line = Buffer.from(bytes).toString("utf8")
  if (!line.endsWith("\n") || line.slice(0, -1).includes("\n"))
    throw new Error("The session artifact proof is invalid.")
  return Proof.parse(JSON.parse(line))
}

let written = false

/** Called only after the trusted codec writes its final ciphertext; no path or caller-selected hash is accepted. */
export function attestSessionArtifact(bytes: Uint8Array): boolean {
  if (written || !GithubSecrets.credentials.sessionProof()) return false
  try {
    const info = fstatSync(3)
    // The runner's private regular file remains owned by the runner, not this agent UID.
    if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.uid === process.getuid?.() || info.size !== 0)
      return false
    const record = Buffer.from(JSON.stringify(digest(bytes)) + "\n")
    if (record.byteLength > LIMIT) return false
    written = true
    return writeSync(3, record) === record.byteLength
  } catch {
    return false
  }
}

export * as GithubSessionProof from "./github.session-proof"
