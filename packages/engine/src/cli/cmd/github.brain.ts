import { createDecipheriv, createHash } from "node:crypto"
import { BrainRunBundle } from "@vectordevai/core/brain/run-bundle"
import { BrainUpload } from "@vectordevai/core/brain/upload"
import { UPLOAD, isRepositoryId, type BrainDownload } from "./github.cloud"
import type { DesktopBrainApproval } from "./github.session"

/**
 * Opens the owner-approved Brain upload that `brain-download` answered to this run (spec V27, "B08 source authority").
 * Vector stores only the ciphertext and never decrypts it. This run checks that the envelope was sealed for its own
 * repository and upload, authenticates it, and checks the digest, the size, the current public-repository policy and the
 * bundle schema. Every refusal returns undefined, and the run continues without Brain context.
 *
 * `expected.publicRepository` is the run's own view of the repository's visibility (its event payload; true when it
 * cannot tell). Skills are refused when either it or the server says public, while the approval keeps the server's
 * value, which is the Brain key's domain.
 */
export function openUpload(
  download: BrainDownload,
  expected: { repositoryId: string; uploadId: string; publicRepository: boolean },
) {
  if (!bound(download, expected)) return undefined
  // Best effort: the decoded key and a refused plaintext are zeroed, including a plaintext whose tag then fails. The
  // answer's base64url strings, the decipher's own key copy and the copies core's validate and decode make cannot be
  // reached from here; the client masked both keys.
  const wipe: Uint8Array[] = []
  try {
    const key = BrainUpload.fromBase64url(download.key)
    wipe.push(key)
    const nonce = BrainUpload.fromBase64url(download.nonce)
    const sealed = BrainUpload.fromBase64url(download.ciphertext)
    if (key.length !== 32 || nonce.length !== 12 || sealed.length !== download.bytes + 16) return undefined
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 })
    decipher.setAAD(Buffer.from(download.aad))
    decipher.setAuthTag(sealed.subarray(-16))
    // The plaintext is listed for zeroing before final() authenticates it. GCM's final() adds no bytes, so the update
    // output is the whole plaintext and no copy is made.
    const bytes = decipher.update(sealed.subarray(0, -16))
    wipe.push(bytes)
    decipher.final()
    if (createHash("sha256").update(bytes).digest("hex") !== download.sha256) return undefined
    BrainUpload.validate(bytes, download.publicRepository || expected.publicRepository)
    const bundle = BrainRunBundle.decode({ path: BrainRunBundle.PATH, bytes, sha256: download.sha256 })
    // The opened bytes are the result, so they leave the wipe list; the key is still zeroed below.
    wipe.pop()
    return {
      bytes,
      bundle,
      approval: {
        source: "desktop",
        repositoryId: expected.repositoryId,
        sha256: download.sha256,
        approvedAt: download.approvedAt,
        audience: "owner-desktop",
        publicRepository: download.publicRepository,
      } satisfies DesktopBrainApproval,
      ...(download.artifactKey ? { brainKey: download.artifactKey } : {}),
    }
  } catch {
    return undefined
  } finally {
    wipe.forEach((value) => value.fill(0))
  }
}

/**
 * The checks the desktop makes before it encrypts (core `brain/upload.ts`), against this run's own repository and
 * upload. The account and generation parts are not compared: the run treats its token as opaque, GCM authenticates
 * the whole string, and the server's run reader checked both against the live run.
 */
function bound(download: BrainDownload, expected: { repositoryId: string; uploadId: string }) {
  const parts = download.aad.split("|")
  return (
    isRepositoryId(expected.repositoryId) &&
    UPLOAD.test(expected.uploadId) &&
    download.uploadId === expected.uploadId &&
    download.aad.length <= 256 &&
    parts.length === 5 &&
    parts[0] === "vector-brain-upload-v1" &&
    parts[2] === expected.repositoryId &&
    /^[1-9]\d*$(?![\s\S])/.test(parts[3] ?? "") &&
    parts[4] === expected.uploadId &&
    Number.isSafeInteger(download.bytes) &&
    download.bytes >= 1 &&
    download.bytes <= BrainRunBundle.MAX_BYTES &&
    Number.isSafeInteger(download.approvedAt) &&
    download.approvedAt > 0
  )
}

export * as GithubBrain from "./github.brain"
