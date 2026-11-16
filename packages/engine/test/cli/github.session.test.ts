import { expect, test } from "bun:test"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js"
import type { BrainExport } from "@vectordevai/core/brain/export"
import { BrainRunProposals } from "@vectordevai/core/brain/run-proposals"
import { RunProposalsCodec } from "@vectordevai/core/brain/run-proposals-codec"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { cloudBrainArtifactKey, cloudRunArtifactKey } from "../../../../api/_lib/cloud-agents-artifact"
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

// BT07b: the keys the server derives for one conversation scope (account, repository, generation, thread), as the
// artifact-key endpoint, brain-download and the owner result read derive them, with a fixture master secret.
const master = { VECTOR_RUN_ARTIFACT_SECRET: "s".repeat(32) }
const claims = {
  sub: "00000000-0000-4000-8000-0000000000aa",
  repo: identity.repositoryId,
  gen: 1,
  thr: identity.thread,
}
const brainKey = cloudBrainArtifactKey(claims, { sha256: approval.sha256, publicRepository: false }, master)
const withBrain = {
  identity,
  key: brainKey,
  session,
  brain: { path: "brain/bundle.json" as const, bytes: brain, approval },
}

test("the ordinary conversation key never opens a Brain-key conversation of the same scope and key id, nor does a Brain key for another digest or visibility", async () => {
  const ordinary = cloudRunArtifactKey(claims, master)
  // Both are derived from the same master, so the clear header cannot tell them apart: only GCM does.
  expect(ordinary.keyId).toBe(brainKey.keyId)
  expect(ordinary.key).not.toBe(brainKey.key)
  const bytes = await encryptConversation(withBrain)
  const opened = await decryptConversation({ bytes, key: brainKey, expected: { ...expected, rid: identity.rid } })
  expect(opened?.session).toEqual(session)
  expect(opened?.brain).toEqual(brain)
  for (const other of [
    ordinary,
    cloudBrainArtifactKey(claims, { sha256: "c".repeat(64), publicRepository: false }, master),
    cloudBrainArtifactKey(claims, { sha256: approval.sha256, publicRepository: true }, master),
    cloudBrainArtifactKey({ ...claims, thr: "18" }, { sha256: approval.sha256, publicRepository: false }, master),
  ]) {
    expect(other.keyId).toBe(brainKey.keyId)
    expect(await decryptConversation({ bytes, key: other, expected })).toBeUndefined()
  }
})

// The drafts a desktop Brain run could return (B08), as core's BrainRunProposals.pack selects them.
const startedAt = 1_800_000_000_000
const draft = (extra: Partial<BrainExport.Item> = {}): BrainExport.Item => ({
  id: "d1",
  kind: "lesson",
  scope: "repository",
  status: "proposed",
  text: "Run the parser fixtures before a release.",
  paths: [],
  pinned: false,
  evidence: [],
  createdAt: startedAt + 1,
  ...extra,
})
const drafts = (entries: BrainExport.Item[]): BrainExport.File => ({
  format: "vector-memory",
  version: 1,
  scope: "repository",
  exportedAt: startedAt + 2,
  documents: [],
  entries,
  skills: [
    draft({
      id: "s1",
      kind: "skill",
      text: "Check the parser",
      skill: {
        name: "parser-check",
        description: "Check the parser",
        procedure: "Run bun test",
        checks: ["bun test"],
        commands: [],
        version: 1,
      },
    }),
  ],
})
const packDrafts = (input: { entries?: BrainExport.Item[]; publicRepository?: boolean; maxBytes?: number }) =>
  BrainRunProposals.pack({
    memory: drafts(
      input.entries ?? [
        draft(),
        draft({ id: "a1", status: "active", text: "An active entry stays home." }),
        draft({ id: "p1", private: true, text: "A private draft stays home." }),
        draft({ id: "o1", createdAt: startedAt - 1, text: "An older draft stays home." }),
      ],
    ),
    startedAt,
    publicRepository: input.publicRepository ?? false,
    maxBytes: input.maxBytes ?? BrainRunProposals.MAX_BYTES - brain.byteLength,
    screen: async (parts) => parts.map(() => true),
  })

test("returned drafts packed by core obey the proposal limits, leave skills out on a public repository, and open on the desktop only as unapproved proposals", async () => {
  const packed = await packDrafts({})
  if (!packed) throw new Error("Fixture drafts did not pack")
  expect({ entries: packed.entries, skills: packed.skills }).toEqual({ entries: 1, skills: 1 })
  expect((await packDrafts({ publicRepository: true }))?.skills).toBe(0)
  expect(await packDrafts({ maxBytes: packed.bytes.byteLength - 1 })).toBeUndefined()
  const many = Array.from({ length: BrainRunProposals.LIMIT.entries + 1 }, (_, index) => draft({ id: `m${index}` }))
  expect((await packDrafts({ entries: many }))?.entries).toBe(BrainRunProposals.LIMIT.entries)
  const bytes = await encryptConversation({
    ...withBrain,
    proposals: { path: "brain/proposals.json", bytes: packed.bytes },
  })
  // As the desktop's returned-proposals preview reads it: the owner read's Brain key, the exact run.
  const opened = await decryptConversation({ bytes, key: brainKey, expected: { ...expected, rid: identity.rid } })
  if (!opened?.proposals) throw new Error("The returned drafts do not open")
  const descriptor = opened.manifest.files.find((file) => file.path === RunProposalsCodec.PATH)
  expect(descriptor).toMatchObject({ kind: "brain-proposals", origin: identity, sha256: packed.sha256 })
  expect(descriptor?.approval).toBeUndefined()
  const file = RunProposalsCodec.parse({
    path: RunProposalsCodec.PATH,
    bytes: opened.proposals,
    publicRepository: false,
  })
  expect(BrainRunProposals.decode({ ...packed, bytes: opened.proposals, publicRepository: false })).toEqual(file)
  const records = [...file.memory.entries, ...(file.memory.skills ?? [])]
  expect(records.map((record) => record.id)).toEqual(["d1", "s1"])
  expect(records.every((record) => record.status === "proposed" && !record.pinned && !record.private)).toBe(true)
  // A repository that is public by now refuses drafts that carry a skill.
  expect(() =>
    RunProposalsCodec.parse({ path: RunProposalsCodec.PATH, bytes: opened.proposals!, publicRepository: true }),
  ).toThrow()
})

/**
 * Seals a manifest the codec never writes, under the right key and identity. It mirrors github.session.ts's framing on
 * purpose: no public function produces an authenticated artifact with a forged manifest.
 */
async function forged(manifest: unknown, files: { path: string; bytes: Uint8Array }[]) {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  for (const file of [{ path: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) }, ...files])
    await writer.add(file.path, new Uint8ArrayReader(Uint8Array.from(file.bytes)), {
      level: 6,
      useWebWorkers: false,
      useCompressionStream: false,
    })
  const content = await writer.close()
  const header = { keyId: brainKey.keyId, ...identity, iv: randomBytes(12).toString("base64url") }
  const encoded = Buffer.from(JSON.stringify(header))
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(brainKey.key, "base64url"),
    Buffer.from(header.iv, "base64url"),
  )
  cipher.setAAD(Buffer.from(`VSA1|${header.keyId}|${header.repositoryId}|${header.thread}|${header.rid}`))
  const prefix = Buffer.alloc(6)
  prefix.write("VSA1")
  prefix.writeUInt16BE(encoded.length, 4)
  return Buffer.concat([prefix, encoded, cipher.update(content), cipher.final(), cipher.getAuthTag()])
}

test("returned drafts that claim a desktop approval or another run's origin do not open", async () => {
  const proposals = Buffer.from('{"format":"vector-brain-proposals","version":1}')
  const sessionBytes = Buffer.from(JSON.stringify(session))
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
  const files = [
    { path: "session.json", bytes: sessionBytes },
    { path: "brain/proposals.json", bytes: proposals },
  ]
  const manifest = (entry: Record<string, unknown>) => ({
    v: 1,
    thread: identity.thread,
    rid: identity.rid,
    files: [
      { path: "session.json", bytes: sessionBytes.length, sha256: sha(sessionBytes), kind: "session" },
      {
        path: "brain/proposals.json",
        bytes: proposals.length,
        sha256: sha(proposals),
        kind: "brain-proposals",
        ...entry,
      },
    ],
  })
  // The control: the manifest the codec writes, sealed the same way, opens.
  expect(
    (await decryptConversation({ bytes: await forged(manifest({ origin: identity }), files), key: brainKey, expected }))
      ?.proposals,
  ).toEqual(proposals)
  for (const entry of [
    { origin: identity, approval: { ...approval, sha256: sha(proposals) } },
    { origin: { ...identity, rid: "gh-123-43-1-99" } },
  ])
    expect(
      await decryptConversation({ bytes: await forged(manifest(entry), files), key: brainKey, expected }),
    ).toBeUndefined()
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

// The run that uploaded an artifact, as the list names it: one on this repository's own head, and a fork's pull_request run.
const own = { id: 901, repository_id: 123, head_repository_id: 123, head_branch: "main", head_sha: "0".repeat(40) }
const fork = { ...own, id: 902, head_repository_id: 456, head_branch: "patch-1" }

test("restore selects newest matching unexpired artifact of this repository's own runs and never forwards GitHub authorization to signed storage", async () => {
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
            { id: 4, name: "vector-session-17", expired: true, created_at: "2026-11-12T03:00:00Z", workflow_run: own },
            { id: 2, name: "vector-session-17", expired: false, created_at: "2026-11-11T03:00:00Z", workflow_run: own },
            {
              id: 3,
              name: "vector-session-17",
              expired: false,
              created_at: "2026-11-12T02:00:00Z",
              archive_download_url: "https://unexpected.invalid",
              workflow_run: own,
            },
            { id: 5, name: "vector-session-18", expired: false, created_at: "2026-11-12T04:00:00Z", workflow_run: own },
            // Newer, but a fork's pull_request run uploaded it, or nothing says which run did (BT06).
            {
              id: 6,
              name: "vector-session-17",
              expired: false,
              created_at: "2026-11-12T05:00:00Z",
              workflow_run: fork,
            },
            {
              id: 7,
              name: "vector-session-17",
              expired: false,
              created_at: "2026-11-12T06:00:00Z",
              workflow_run: null,
            },
            { id: 8, name: "vector-session-17", expired: false, created_at: "2026-11-12T07:00:00Z" },
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

test("a thread whose only artifacts a fork's run uploaded, or whose run is not named, downloads nothing", async () => {
  const seen: string[] = []
  const result = await latestConversation({
    repository: "owner/project",
    thread: "17",
    token: "fixture-read-only-github",
    request: async (url) => {
      seen.push(url)
      return Response.json({
        artifacts: [
          { id: 6, name: "vector-session-17", expired: false, created_at: "2026-11-12T05:00:00Z", workflow_run: fork },
          { id: 7, name: "vector-session-17", expired: false, created_at: "2026-11-12T06:00:00Z", workflow_run: null },
          { id: 8, name: "vector-session-17", expired: false, created_at: "2026-11-12T07:00:00Z" },
        ],
      })
    },
  })
  expect(result).toBeUndefined()
  expect(seen).toEqual([
    "https://api.github.com/repos/owner/project/actions/artifacts?name=vector-session-17&per_page=100&page=1",
  ])
})

test("a listed entry in an unexpected shape is skipped and the thread's own artifact is still restored", async () => {
  const bytes = await encryptConversation({ identity, key, session })
  const zipped = await outer(bytes)
  const seen: string[] = []
  const result = await latestConversation({
    repository: "owner/project",
    thread: "17",
    token: "fixture-read-only-github",
    request: async (url) => {
      seen.push(url)
      if (url.includes("?name="))
        return Response.json({
          artifacts: [
            { id: 3, name: "vector-session-17", expired: false, created_at: "2026-11-12T02:00:00Z", workflow_run: own },
            // Each newer than the own artifact, and each one GitHub could list: a deleted fork's run names no head
            // repository, and the others carry a value the reader does not accept.
            {
              id: 9,
              name: "vector-session-17",
              expired: false,
              created_at: "2026-11-12T08:00:00Z",
              workflow_run: { ...own, head_repository_id: null },
            },
            {
              id: 10,
              name: "vector-session-17",
              expired: false,
              created_at: "2026-11-12T09:00:00Z",
              workflow_run: { ...own, repository_id: 0, head_repository_id: 0 },
            },
            { id: 0, name: "vector-session-17", expired: false, created_at: "2026-11-12T10:00:00Z", workflow_run: own },
            { id: 11, name: "vector-session-17", expired: "no", created_at: "2026-11-12T11:00:00Z", workflow_run: own },
            "not an artifact",
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
  expect(seen).toEqual([
    "https://api.github.com/repos/owner/project/actions/artifacts?name=vector-session-17&per_page=100&page=1",
    "https://api.github.com/repos/owner/project/actions/artifacts/3/zip",
    "https://fixture.blob.core.windows.net/artifact?signed=fixture",
  ])
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
                artifacts: [
                  {
                    id: 1,
                    name: "vector-session-17",
                    expired: false,
                    created_at: "2026-11-12T02:00:00Z",
                    workflow_run: own,
                  },
                ],
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
