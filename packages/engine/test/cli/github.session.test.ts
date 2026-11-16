import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js"
import { GithubAgents } from "@vectordevai/core/github-agents"
import {
  allowConversationRestore,
  decryptConversation,
  encryptConversation,
  latestConversation,
} from "../../src/cli/cmd/github.session"

const identity = { repositoryId: "123", thread: "17", rid: "gh-123-42-1-99" }
const key = { key: Buffer.alloc(32, 19).toString("base64url"), keyId: "a".repeat(16) }
const session = {
  info: { title: "private repository conversation" },
  messages: [{ role: "user", text: "PRIVATE_REPO_CONTEXT" }],
}
const expected = { repositoryId: identity.repositoryId, thread: identity.thread }
const brain = Buffer.from('{"private":"owner-approved repository context"}')
const approval = {
  source: "desktop" as const,
  audience: "owner-desktop" as const,
  publicRepository: false,
  repositoryId: identity.repositoryId,
  sha256: createHash("sha256").update(brain).digest("hex"),
  approvedAt: 1_800_000_000_000,
}

test("conversation ciphertext round-trips without clear repository content and is bound to its exact owner-read run when supplied", async () => {
  const bytes = await encryptConversation({ identity, key, session })
  expect(bytes.subarray(0, 4).toString()).toBe("VSA1")
  expect(bytes.includes(Buffer.from("PRIVATE_REPO_CONTEXT"))).toBe(false)
  const result = await decryptConversation({ bytes, key, expected: { ...expected, rid: identity.rid } })
  expect(result?.session).toEqual(session)
  expect(result?.header).toMatchObject(identity)
  const pooled = Buffer.concat([Buffer.alloc(13), bytes, Buffer.alloc(11)])
  expect((await decryptConversation({ bytes: pooled.subarray(13, -11), key, expected }))?.session).toEqual(session)
  expect(result && allowConversationRestore(result)).toBe(true)
  expect(await decryptConversation({ bytes, key, expected: { ...expected, rid: "gh-123-43-1-99" } })).toBeUndefined()
})

test("wrong key, new binding-generation key, foreign context, tampering, bad version and truncation fall back", async () => {
  const bytes = await encryptConversation({ identity, key, session })
  for (const changed of [
    { ...key, key: Buffer.alloc(32, 20).toString("base64url") },
    { ...key, keyId: "b".repeat(16) },
  ])
    expect(await decryptConversation({ bytes, key: changed, expected })).toBeUndefined()
  for (const context of [
    { ...expected, repositoryId: "124" },
    { ...expected, thread: "18" },
  ])
    expect(await decryptConversation({ bytes, key, expected: context })).toBeUndefined()
  const tampered = Buffer.from(bytes)
  tampered[tampered.length - 17]! ^= 1
  const future = Buffer.from(bytes)
  future.write("VSA2")
  for (const corrupt of [
    tampered,
    future,
    bytes.subarray(0, 12),
    Buffer.alloc(GithubAgents.PATCH_LIMITS.sessionBytes + 1),
  ])
    expect(await decryptConversation({ bytes: corrupt, key, expected })).toBeUndefined()
})

test("authenticated routing header fields cannot be replaced even when the caller changes its expected context", async () => {
  const bytes = await encryptConversation({ identity, key, session })
  const length = bytes.readUInt16BE(4)
  const header = JSON.parse(bytes.subarray(6, 6 + length).toString("utf8"))
  header.thread = "18"
  const encoded = Buffer.from(JSON.stringify(header))
  const prefix = Buffer.alloc(6)
  prefix.write("VSA1")
  prefix.writeUInt16BE(encoded.length, 4)
  expect(
    await decryptConversation({
      bytes: Buffer.concat([prefix, encoded, bytes.subarray(6 + length)]),
      key,
      expected: { ...expected, thread: "18" },
    }),
  ).toBeUndefined()
  await expect(encryptConversation({ identity: { ...identity, repositoryId: "124" }, key, session })).rejects.toThrow()
})

test("initial approved context and returned proposals have separate authenticated authority and a combined Brain budget", async () => {
  const proposalBytes = Buffer.from('{"format":"vector-brain-proposals","version":1}')
  const bytes = await encryptConversation({
    identity,
    key,
    session,
    brain: { path: "brain/bundle.json", bytes: brain, approval },
    proposals: { path: "brain/proposals.json", bytes: proposalBytes },
  })
  const result = await decryptConversation({ bytes, key, expected })
  expect(result?.brain).toEqual(brain)
  expect(result?.proposals).toEqual(proposalBytes)
  expect(result?.manifest.files.find((file) => file.path === "brain/proposals.json")).toMatchObject({
    kind: "brain-proposals",
    origin: identity,
  })
  expect(result?.manifest.files.find((file) => file.path === "brain/proposals.json")?.approval).toBeUndefined()
  await expect(
    encryptConversation({
      identity,
      key,
      session,
      brain: { path: "brain/bundle.json", bytes: brain, approval: { ...approval, sha256: "0".repeat(64) } },
    }),
  ).rejects.toThrow()
  await expect(
    encryptConversation({
      identity,
      key,
      session,
      brain: { path: "brain/bundle.json", bytes: brain, approval },
      proposals: { path: "brain/proposals.json", bytes: Buffer.alloc(512 * 1024) },
    }),
  ).rejects.toThrow()
})

test("repository triggers and changed approval digest/audience/visibility cannot revive Brain-derived session history", async () => {
  const bytes = await encryptConversation({
    identity,
    key,
    session,
    brain: { path: "brain/bundle.json", bytes: brain, approval },
  })
  const result = await decryptConversation({ bytes, key, expected })
  if (!result) throw new Error("Fixture could not decrypt")
  expect(allowConversationRestore(result)).toBe(false)
  expect(allowConversationRestore(result, { ...approval, approvedAt: approval.approvedAt + 1000 })).toBe(true)
  expect(allowConversationRestore(result, { ...approval, sha256: "c".repeat(64) })).toBe(false)
  expect(allowConversationRestore(result, { ...approval, repositoryId: "124" })).toBe(false)
  expect(allowConversationRestore(result, { ...approval, publicRepository: true })).toBe(false)
})

test("highly compressible session content is refused when the complete expanded archive exceeds its bound", async () => {
  await expect(
    encryptConversation({ identity, key, session: "x".repeat(GithubAgents.PATCH_LIMITS.sessionBytes - 3) }),
  ).rejects.toThrow("too large")
})

async function outer(bytes: Uint8Array) {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  await writer.add("session.vsa", new Uint8ArrayReader(Uint8Array.from(bytes)), {
    level: 0,
    useWebWorkers: false,
    useCompressionStream: false,
  })
  return writer.close()
}

test("restore selects newest matching unexpired artifact and never forwards GitHub authorization to signed storage", async () => {
  const bytes = await encryptConversation({ identity, key, session })
  const zipped = await outer(bytes)
  const seen: { url: string; authorization: string | null; redirect?: RequestRedirect }[] = []
  const result = await latestConversation({
    repository: "owner/project",
    thread: "17",
    token: "fixture-read-only-github",
    request: async (url, init) => {
      seen.push({ url, authorization: new Headers(init.headers).get("authorization"), redirect: init.redirect })
      if (url.includes("?name="))
        return Response.json({
          artifacts: [
            { id: 4, name: "vector-session-17", expired: true, created_at: "2026-11-12T03:00:00Z" },
            { id: 2, name: "vector-session-17", expired: false, created_at: "2026-11-11T03:00:00Z" },
            {
              id: 3,
              name: "vector-session-17",
              expired: false,
              created_at: "2026-11-12T02:00:00Z",
              archive_download_url: "https://unexpected.invalid",
            },
            { id: 5, name: "vector-session-18", expired: false, created_at: "2026-11-12T04:00:00Z" },
          ],
        })
      if (url.endsWith("/3/zip"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://fixture.blob.core.windows.net/artifact?signed=fixture" },
        })
      if (url.startsWith("https://fixture.blob.core.windows.net/")) return new Response(Uint8Array.from(zipped))
      throw new Error("Unexpected artifact request")
    },
  })
  expect(result).toEqual(bytes)
  expect(seen).toHaveLength(3)
  expect(seen[0]?.authorization).toBe("Bearer fixture-read-only-github")
  expect(seen[1]?.url).toBe("https://api.github.com/repos/owner/project/actions/artifacts/3/zip")
  expect(seen[2]?.authorization).toBeNull()
  expect(seen.every((entry) => entry.redirect === "manual")).toBe(true)
})

test("storage redirects to metadata/internal/arbitrary hosts and unavailable artifact lists fall back", async () => {
  for (const location of [
    "http://169.254.169.254/latest/meta-data",
    "https://unexpected.invalid/file",
    "https://user:password@fixture.blob.core.windows.net/file",
  ]) {
    let calls = 0
    expect(
      await latestConversation({
        repository: "owner/project",
        thread: "17",
        token: "fixture",
        request: async () => {
          calls++
          return calls === 1
            ? Response.json({
                artifacts: [{ id: 1, name: "vector-session-17", expired: false, created_at: "2026-11-12T02:00:00Z" }],
              })
            : new Response(null, { status: 302, headers: { location } })
        },
      }),
    ).toBeUndefined()
    expect(calls).toBe(2)
  }
  expect(
    await latestConversation({
      repository: "owner/project",
      thread: "17",
      token: "fixture",
      request: async () => new Response(null, { status: 503 }),
    }),
  ).toBeUndefined()
})
