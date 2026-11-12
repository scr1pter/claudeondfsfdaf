import { expect, test } from "bun:test"
import { createHash, createDecipheriv } from "node:crypto"
import { BrainUpload } from "../../src/brain/upload"

const content = (privateEntry = false, skills = false) => new TextEncoder().encode(JSON.stringify({
  format: "vector-brain-run", version: 1,
  memory: { format: "vector-memory", version: 1, scope: "repository", documents: [],
    entries: [{ scope: "repository", kind: "lesson", status: "active", private: privateEntry, text: "approved repository context" }],
    skills: skills ? [{ scope: "repository", kind: "skill", status: "active", skill: { procedure: "Read the focused check" } }] : [],
  }, insights: { format: "vector-workflow-insights", version: 1, rows: [] },
}))

test("only the exact owner-approved preview is encrypted for the selected repository", async () => {
  const bytes = content()
  const approvedBytes = Buffer.from(bytes)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const uploadId = `vbu_${"a".repeat(32)}`
  const key = new Uint8Array(32).fill(7)
  const aad = `vector-brain-upload-v1|11111111-1111-4111-8111-111111111111|42|1|${uploadId}`
  const calls: string[] = []
  const result = await BrainUpload.upload({ repositoryId: "42", selection: { bytes, sha256 }, approvedSha256: sha256, includeBrain: true,
    transport: async (kind, body) => {
      calls.push(kind)
      if (kind === "prepare") {
        expect(body).toEqual({ repositoryId: "42", sha256, bytes: bytes.length, includeBrain: true })
        expect(JSON.stringify(body)).not.toContain("approved repository context")
        // Mutating a still-mounted preview during the network wait must not change the captured approved payload.
        bytes.fill(0)
        return { uploadId, key: BrainUpload.base64url(key), aad, expiresAt: Date.now() + 60_000, publicRepository: false }
      }
      const ciphertext = Buffer.from(String(body.ciphertext), "base64url")
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(String(body.nonce), "base64url"))
      decipher.setAAD(Buffer.from(aad))
      decipher.setAuthTag(ciphertext.subarray(-16))
      expect(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()])).toEqual(approvedBytes)
      return { uploadId, sha256, bytes: bytes.length, approvedAt: Date.now() }
    },
  })
  expect(calls).toEqual(["prepare", "commit"])
  expect(result).toEqual({ uploadId, sha256 })
})

test("no approval, altered bytes, or changed repository cannot upload plaintext or start a run", async () => {
  const bytes = content()
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  let calls = 0
  const transport: BrainUpload.Transport = async () => { calls++; throw new Error("must not call") }
  for (const patch of [{ includeBrain: false }, { approvedSha256: "0".repeat(64) }, { selection: { bytes: new Uint8Array([0]), sha256 } }])
    await expect(BrainUpload.upload({ repositoryId: "42", selection: { bytes, sha256 }, approvedSha256: sha256, includeBrain: true, transport, ...patch })).rejects.toThrow()
  expect(calls).toBe(0)
  await expect(BrainUpload.upload({ repositoryId: "42", selection: { bytes, sha256 }, approvedSha256: sha256, includeBrain: true,
    transport: async (kind) => {
      calls++
      expect(kind).toBe("prepare")
      return { uploadId: `vbu_${"a".repeat(32)}`, key: BrainUpload.base64url(new Uint8Array(32)),
        aad: `vector-brain-upload-v1|account|43|1|vbu_${"a".repeat(32)}`, expiresAt: Date.now() + 60_000, publicRepository: false }
    },
  })).rejects.toThrow("repository changed")
  expect(calls).toBe(1)
})

test("private context is refused locally before upload and public repositories omit all procedures", async () => {
  expect(() => BrainUpload.validate(content(true), false)).toThrow("private")
  expect(() => BrainUpload.validate(content(false, true), true)).toThrow()
  expect(() => BrainUpload.validate(content(false, true), false)).not.toThrow()
  let requests = 0
  const bytes = content(true)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  await expect(BrainUpload.upload({ repositoryId: "42", selection: { bytes, sha256 }, approvedSha256: sha256,
    includeBrain: true, transport: async () => { requests++; throw new Error("must not request") },
  })).rejects.toThrow("private")
  expect(requests).toBe(0)
})
