import { afterAll, beforeAll, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createCipheriv, createHash, randomBytes, randomInt, randomUUID } from "node:crypto"
import { BRAIN_UPLOAD_TTL, bindBrainUpload, commitBrainUpload, eraseBrainUploads, prepareBrainUpload, readBrainUpload } from "../../../api/_lib/cloud-agents-brain"
import type { persistentStore } from "../../../api/_lib/persistent-store"

const env = { VECTOR_RUN_ARTIFACT_SECRET: "brain-upload-fixture-secret-at-least-32-characters" }
const bytes = (privateEntry = false, skills = false) => Buffer.from(JSON.stringify({
  format: "vector-brain-run", version: 1,
  memory: { format: "vector-memory", version: 1, scope: "repository", exportedAt: Date.now(), documents: [],
    entries: [{ id: "mem_fixture", scope: "repository", kind: "lesson", status: "active", private: privateEntry,
      text: "private approved repository knowledge", paths: [], pinned: false, evidence: [], createdAt: Date.now() }],
    skills: skills ? [{ id: "mem_skill", scope: "repository", kind: "skill", status: "active",
      text: "A checked procedure", skill: { name: "check", procedure: "Run the focused check" } }] : [],
  }, insights: { format: "vector-workflow-insights", version: 1, rows: [] },
}))
function envelope(prepared: { key: string; aad: string }, content: Uint8Array) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(prepared.key, "base64url"), nonce)
  cipher.setAAD(Buffer.from(prepared.aad))
  return { nonce: nonce.toString("base64url"), ciphertext: Buffer.concat([cipher.update(content), cipher.final(), cipher.getAuthTag()]).toString("base64url") }
}

const configured = process.env.VECTOR_TEST_REDIS_URL
if (!configured) test.skip("Brain upload integration requires disposable loopback VECTOR_TEST_REDIS_URL", () => {})
else {
  const url = new URL(configured)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Brain upload tests require loopback Redis")
  const redis = new RedisClient(url.href, { connectionTimeout: 1000, enableOfflineQueue: false })
  const keys = new Set<string>()
  const store: typeof persistentStore = async (command) => {
    const offset = command[0] === "EVAL" ? 3 : 1
    const count = command[0] === "EVAL" ? Number(command[2]) : 1
    command.slice(offset, offset + count).forEach((key) => keys.add(String(key)))
    return redis.send(String(command[0]), command.slice(1).map(String))
  }
  beforeAll(async () => { await redis.connect() })
  afterAll(async () => { if (keys.size) await redis.send("DEL", [...keys]); redis.close() })
  async function fixture(publicRepository = false) {
    const identity = { account: randomUUID(), repositoryId: String(randomInt(100_000_000, 900_000_000)), generation: 1 }
    await store(["HSET", `vector:cloud-agents:binding:${identity.repositoryId}`, "account", identity.account, "generation", "1"])
    await store(["SET", `vector:cloud-agents:gen:${identity.repositoryId}`, "1"])
    const content = bytes()
    const selection = { ...identity, publicRepository, source: "desktop" as const, includeBrain: true as const,
      sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length }
    const prepared = await prepareBrainUpload(selection, { store, env })
    return { identity, selection, prepared, content, encrypted: envelope(prepared, content) }
  }

  test("only ciphertext and wrapped key persist; one exact ticket can read the approved bytes", async () => {
    const f = await fixture()
    // Commit needs no unwrapping secret: it must never decrypt either the key or repository payload.
    const approval = await commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...f.encrypted }, { store, env: {} })
    const raw = String(await store(["GET", `vector:cloud-agents:brain:${f.prepared.uploadId}`]))
    expect(raw).not.toContain("private approved repository knowledge")
    expect(raw).not.toContain(f.prepared.key)
    expect(Number(await store(["PTTL", `vector:cloud-agents:brain:${f.prepared.uploadId}`]))).toBeLessThanOrEqual(BRAIN_UPLOAD_TTL)
    const binding = { ...f.identity, uploadId: f.prepared.uploadId, sha256: f.selection.sha256, ticketHash: "a".repeat(64) }
    expect(await bindBrainUpload(binding, { store, env })).toEqual(approval)
    expect(await bindBrainUpload(binding, { store, env })).toEqual(approval)
    await expect(bindBrainUpload({ ...binding, ticketHash: "b".repeat(64) }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    const reader = { ...binding, originalSource: "desktop" as const, deadline: Date.now() + 60_000 }
    expect(await readBrainUpload(reader, { store, env })).toMatchObject({ ...approval, ...f.encrypted, key: f.prepared.key, aad: f.prepared.aad })
    await expect(readBrainUpload({ ...reader, ticketHash: "c".repeat(64) }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    await expect(readBrainUpload({ ...reader, account: randomUUID() }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    await expect(readBrainUpload({ ...reader, deadline: Date.now() - 1 }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
  })

  test("a generation change, revocation, or expiry refuses even an already bound upload", async () => {
    const f = await fixture()
    await commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...f.encrypted }, { store, env })
    const reader = { ...f.identity, uploadId: f.prepared.uploadId, sha256: f.selection.sha256, ticketHash: "a".repeat(64),
      originalSource: "desktop" as const, deadline: Date.now() + BRAIN_UPLOAD_TTL * 2 }
    await bindBrainUpload(reader, { store, env })
    await store(["SET", `vector:cloud-agents:gen:${f.identity.repositoryId}`, "2"])
    await expect(readBrainUpload(reader, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    await store(["SET", `vector:cloud-agents:gen:${f.identity.repositoryId}`, "1"])
    await expect(readBrainUpload(reader, { store, env, now: () => f.prepared.expiresAt + 1 })).rejects.toMatchObject({ statusCode: 400 })
    await store(["SET", `vector:cli-revoked:${f.identity.account}`, "1"])
    await expect(readBrainUpload(reader, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    await eraseBrainUploads(f.identity.account, store)
    expect(await store(["GET", `vector:cloud-agents:brain:${f.prepared.uploadId}`])).toBeNull()
    expect(await store(["EXISTS", `vector:cloud-agents:brain:account:${f.identity.account}`])).toBe(0)
  })

  test("the server stores opaque ciphertext without inspecting even deliberately invalid plaintext; malformed framing refuses", async () => {
    const f = await fixture(true)
    for (const content of [bytes(true), bytes(false, true)]) {
      const prepared = await prepareBrainUpload({ ...f.selection, bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex") }, { store, env })
      // An adversarial owner can encrypt arbitrary bytes. The shipping client and authenticated run reader, rather
      // than a Vector server, enforce the repository/public plaintext schema after local decryption.
      await expect(commitBrainUpload({ account: f.identity.account, uploadId: prepared.uploadId, ...envelope(prepared, content) }, { store, env })).resolves.toMatchObject({ sha256: createHash("sha256").update(content).digest("hex") })
    }
    await expect(commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...f.encrypted, nonce: "AA" }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    await expect(commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...f.encrypted, ciphertext: "AA" }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    await expect(bindBrainUpload({ ...f.identity, uploadId: f.prepared.uploadId, sha256: f.selection.sha256, ticketHash: "a".repeat(64) }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
  })

  test("two concurrent ticket claims admit exactly one and persistent storage failure grants nothing", async () => {
    const f = await fixture()
    await commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...f.encrypted }, { store, env })
    const outcomes = await Promise.allSettled(["a", "b"].map((letter) => bindBrainUpload({ ...f.identity,
      uploadId: f.prepared.uploadId, sha256: f.selection.sha256, ticketHash: letter.repeat(64) }, { store, env })))
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    await expect(prepareBrainUpload(f.selection, { env, store: async () => { throw new Error("offline") } })).rejects.toMatchObject({ statusCode: 503 })
  })
}
