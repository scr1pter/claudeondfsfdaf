import { expect, test } from "bun:test"
import { createHash, createDecipheriv } from "node:crypto"
import { BrainUpload } from "@vectordevai/core/brain/upload"
import { RunProposalsCodec } from "@vectordevai/core/brain/run-proposals-codec"
import { createGithubAgentsBrain } from "./github-agents-brain"
import { encryptConversation } from "../../../engine/src/cli/cmd/github.session"
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js"

function fixture() {
  const bytes = Buffer.from(
    JSON.stringify({
      format: "vector-brain-run",
      version: 1,
      memory: {
        format: "vector-memory",
        version: 1,
        scope: "repository",
        documents: [],
        entries: [{ scope: "repository", kind: "lesson", status: "active", text: "OWNER_APPROVED_CONTEXT" }],
        skills: [],
      },
      insights: { format: "vector-workflow-insights", version: 1, rows: [] },
    }),
  )
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const state = {
    token: "desktop-account-a",
    repositoryId: 41,
    failCommit: false,
    private: false,
    githubIdentity: "github-only",
    localRequests: 0,
  }
  const hooks: { preview?: () => Promise<void>; prepare?: () => Promise<void>; engine?: () => Promise<void> } = {}
  const calls: { path: string; body: unknown; account: string }[] = []
  const key = Buffer.alloc(32, 9)
  const uploadId = "vbu_" + "a".repeat(32)
  const aad = `vector-brain-upload-v1|owner|41|1|${uploadId}`
  const brain = createGithubAgentsBrain({
    token: async () => state.token,
    context: async () => ({
      authority: JSON.stringify([state.repositoryId, state.githubIdentity, state.private]),
      access: { token: state.githubIdentity, source: "vector" },
      info: { id: state.repositoryId, full_name: "acme/repo", private: state.private, permissions: { push: true } },
    }),
    engine: async () => {
      await hooks.engine?.()
      return { url: "http://127.0.0.1:4096", username: "vector", password: "local-owner-only" }
    },
    vector: async (path, body, account) => {
      expect(account).toBe(createHash("sha256").update(state.token).digest("hex"))
      calls.push({ path, body, account })
      if (path.endsWith("brain-prepare")) {
        await hooks.prepare?.()
        return { uploadId, key: key.toString("base64url"), aad, expiresAt: Date.now() + 60_000, publicRepository: true }
      }
      if (path.endsWith("brain-commit")) {
        if (state.failCommit) throw new Error("Synthetic commit refusal")
        return { uploadId, sha256, bytes: bytes.length, approvedAt: Date.now() }
      }
      if (path.endsWith("desktop-run")) return { ok: true, dispatchedAt: Date.now() }
      throw new Error("Unexpected account request")
    },
    fetch: async (input, init) => {
      const url = new URL(String(input))
      state.localRequests++
      await hooks.preview?.()
      expect(url.origin).toBe("http://127.0.0.1:4096")
      expect(url.pathname).toBe("/experimental/brain/preview")
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Basic " + Buffer.from("vector:local-owner-only").toString("base64"),
      )
      expect(JSON.parse(String(init?.body))).toEqual({ includeBrain: true, publicRepository: true })
      return Response.json({
        path: "brain/bundle.json",
        base64url: BrainUpload.base64url(bytes),
        sha256,
        bytes: bytes.length,
        entries: 1,
        skills: 0,
      })
    },
  })
  return { brain, state, hooks, calls, bytes, sha256, key, aad }
}

test("Brain preview is readable, performs no upload and never returns an account or GitHub credential", async () => {
  const f = fixture()
  const preview = await f.brain.preview("/fixture")
  expect(preview.text).toContain("OWNER_APPROVED_CONTEXT")
  expect(preview.sha256).toBe(f.sha256)
  expect(f.calls).toEqual([])
  expect(JSON.stringify(preview)).not.toContain("desktop-account-a")
  expect(JSON.stringify(preview)).not.toContain("github-only")
})

test("Start encrypts exactly approved bytes and dispatches only the committed opaque attachment", async () => {
  const f = fixture()
  const preview = await f.brain.preview("/fixture")
  await f.brain.start({
    cwd: "/fixture",
    prompt: "Run repository tests",
    previewId: preview.id,
    approvedSha256: preview.sha256,
  })
  expect(f.calls.map((item) => item.path)).toEqual([
    "/api/cloud-agents/brain-prepare",
    "/api/cloud-agents/brain-commit",
    "/api/cloud-agents/desktop-run",
  ])
  const commit = f.calls[1]!.body as { nonce: string; ciphertext: string }
  expect(JSON.stringify(commit)).not.toContain("OWNER_APPROVED_CONTEXT")
  const encrypted = Buffer.from(commit.ciphertext, "base64url")
  const decrypt = createDecipheriv("aes-256-gcm", f.key, Buffer.from(commit.nonce, "base64url"))
  decrypt.setAAD(Buffer.from(f.aad))
  decrypt.setAuthTag(encrypted.subarray(-16))
  expect(Buffer.concat([decrypt.update(encrypted.subarray(0, -16)), decrypt.final()])).toEqual(f.bytes)
  expect(f.calls[2]!.body).toEqual({
    repositoryId: "41",
    prompt: "Run repository tests",
    brain: { uploadId: "vbu_" + "a".repeat(32), sha256: f.sha256 },
  })
})

test("changed digest, repository or account refuses before any upload", async () => {
  for (const change of ["digest", "repository", "account"]) {
    const f = fixture()
    const preview = await f.brain.preview("/fixture")
    if (change === "repository") f.state.repositoryId = 42
    if (change === "account") f.state.token = "desktop-account-b"
    await expect(
      f.brain.start({
        cwd: "/fixture",
        prompt: "task",
        previewId: preview.id,
        approvedSha256: change === "digest" ? "0".repeat(64) : preview.sha256,
      }),
    ).rejects.toThrow()
    expect(f.calls).toEqual([])
  }
})

test("one preview authorizes only one concurrent Start, and commit refusal never starts a run", async () => {
  const f = fixture()
  const preview = await f.brain.preview("/fixture")
  const input = { cwd: "/fixture", prompt: "task", previewId: preview.id, approvedSha256: preview.sha256 }
  const results = await Promise.allSettled([f.brain.start(input), f.brain.start(input)])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(f.calls.filter((item) => item.path.endsWith("desktop-run"))).toHaveLength(1)
  const refused = fixture()
  refused.state.failCommit = true
  const selected = await refused.brain.preview("/fixture")
  await expect(
    refused.brain.start({ cwd: "/fixture", prompt: "task", previewId: selected.id, approvedSha256: selected.sha256 }),
  ).rejects.toThrow("commit refusal")
  expect(refused.calls.some((item) => item.path.endsWith("desktop-run"))).toBe(false)
})

test("a public run artifact in a now-private repository keeps public screening through preview and explicit import", async () => {
  const identity = { repositoryId: "41", thread: "17", rid: "gh-41-99-1-7" }
  const key = { key: Buffer.alloc(32, 19).toString("base64url"), keyId: "a".repeat(16) }
  const file = {
    format: "vector-brain-proposals",
    version: 1,
    memory: {
      format: "vector-memory",
      version: 1,
      scope: "repository",
      exportedAt: 30,
      documents: [],
      skills: [],
      entries: [
        {
          id: "draft",
          scope: "repository",
          kind: "lesson",
          status: "proposed",
          text: "REVIEWED_PROPOSAL",
          paths: [],
          pinned: false,
          evidence: [],
          createdAt: 20,
        },
      ],
    },
  }
  const drafts = Buffer.from(JSON.stringify(file))
  const procedures = Buffer.from(
    JSON.stringify({
      ...file,
      memory: {
        ...file.memory,
        skills: [
          {
            ...file.memory.entries[0]!,
            id: "procedure",
            kind: "skill",
            skill: {
              name: "focused-check",
              description: "Run a focused check",
              procedure: "Run bun test",
              checks: ["bun test"],
              commands: [],
              version: 1,
            },
          },
        ],
      },
    }),
  )
  expect(
    RunProposalsCodec.parse({ path: "brain/proposals.json", bytes: procedures, publicRepository: false }).memory.skills,
  ).toHaveLength(1)
  async function archiveFor(bytes: Uint8Array) {
    const ciphertext = await encryptConversation({
      identity,
      key,
      session: { messages: ["PRIVATE_SESSION_CANARY"] },
      proposals: { path: "brain/proposals.json", bytes },
    })
    const writer = new ZipWriter(new Uint8ArrayWriter())
    await writer.add("session.vsa", new Uint8ArrayReader(ciphertext), {
      level: 0,
      useWebWorkers: false,
      useCompressionStream: false,
    })
    return writer.close()
  }
  const archive = await archiveFor(drafts)
  const procedureArchive = await archiveFor(procedures)
  const state = {
    imports: 0,
    keys: 0,
    downloads: 0,
    name: "vector-session-17",
    token: "desktop-only",
    authority: 0,
    procedures: false,
  }
  const hooks: { engine?: () => Promise<void>; download?: () => Promise<void> } = {}
  const metadata = () => ({
    id: 7,
    name: state.name,
    expired: false,
    size_in_bytes: (state.procedures ? procedureArchive : archive).byteLength,
    workflow_run: { id: 99, repository_id: 41 },
  })
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/experimental/brain/run-proposals/import") {
        expect(request.headers.get("authorization")).toBe(
          "Basic " + Buffer.from("vector:owner-only").toString("base64"),
        )
        const body = await request.json()
        expect(Object.keys(body).sort()).toEqual(["base64url", "path", "publicRepository", "sha256"])
        expect(body.path).toBe("brain/proposals.json")
        expect(body.publicRepository).toBe(true)
        expect(BrainUpload.fromBase64url(body.base64url)).toEqual(Uint8Array.from(drafts))
        expect(body.sha256).toBe(createHash("sha256").update(drafts).digest("hex"))
        state.imports++
        return Response.json({ proposed: 1, known: 0, refused: 0, over: 0 })
      }
      expect(request.headers.get("authorization")).toBe("Bearer github-only")
      if (url.pathname.endsWith("/runs/99/artifacts")) return Response.json({ artifacts: [metadata()] })
      if (url.pathname.endsWith("/artifacts/7")) return Response.json(metadata())
      if (url.pathname.endsWith("/artifacts/7/zip")) {
        state.downloads++
        return new Response(Buffer.from(state.procedures ? procedureArchive : archive))
      }
      return new Response(null, { status: 404 })
    },
  })
  const brain = createGithubAgentsBrain({
    token: async () => state.token,
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      // Hold the client result after a real HTTP response; delaying Bun's server handler can replay a GET.
      if (new URL(String(input)).pathname.endsWith("/artifacts/7/zip")) await hooks.download?.()
      return response
    },
    engine: async () => {
      await hooks.engine?.()
      return { url: server.url.origin, username: "vector", password: "owner-only" }
    },
    context: async () => ({
      authority: "returned-owner-authority-" + state.authority,
      access: { token: "github-only", source: "vector", apiUrl: server.url.origin },
      info: { id: 41, full_name: "acme/repo", private: true, permissions: { push: true } },
    }),
    vector: async (path, body, owner) => {
      expect(path).toBe("/api/cloud-agents/owner-artifact-key")
      expect(body).toEqual({ rid: identity.rid, artifactId: "7" })
      expect(owner).toBe(createHash("sha256").update(state.token).digest("hex"))
      state.keys++
      return { ...key, ...identity, artifactId: "7", publicRepository: true }
    },
  })
  try {
    expect(await brain.artifacts({ cwd: "/fixture", rid: identity.rid })).toEqual([
      { artifactId: "7", name: "vector-session-17" },
    ])
    expect(state.keys).toBe(0)
    state.procedures = true
    await expect(brain.previewReturned({ cwd: "/fixture", rid: identity.rid, artifactId: "7" })).rejects.toThrow(
      "Invalid returned repository Brain drafts",
    )
    expect(state.imports).toBe(0)
    state.procedures = false
    const preview = await brain.previewReturned({ cwd: "/fixture", rid: identity.rid, artifactId: "7" })
    expect(preview.currentPublicRepository).toBe(false)
    expect(preview.publicRepository).toBe(true)
    expect(preview.text).toContain("REVIEWED_PROPOSAL")
    for (const secret of [key.key, "github-only", "desktop-only", "PRIVATE_SESSION_CANARY"])
      expect(JSON.stringify(preview)).not.toContain(secret)
    expect(state.imports).toBe(0)
    await expect(brain.importReturned({ previewId: preview.id, approvedSha256: "0".repeat(64) })).rejects.toThrow()
    expect(state.imports).toBe(0)
    expect(await brain.importReturned({ previewId: preview.id, approvedSha256: preview.sha256 })).toEqual({
      proposed: 1,
      known: 0,
      refused: 0,
      over: 0,
    })
    expect(state.imports).toBe(1)
    await expect(brain.importReturned({ previewId: preview.id, approvedSha256: preview.sha256 })).rejects.toThrow()
    expect(state.imports).toBe(1)
    // An old approval must not reach the local import endpoint if authority changes during engine discovery.
    const pendingPreview = await brain.previewReturned({ cwd: "/fixture", rid: identity.rid, artifactId: "7" })
    const engineEntered = Promise.withResolvers<void>()
    const engineRelease = Promise.withResolvers<void>()
    hooks.engine = async () => {
      engineEntered.resolve()
      await engineRelease.promise
    }
    const pendingImport = brain.importReturned({ previewId: pendingPreview.id, approvedSha256: pendingPreview.sha256 })
    await engineEntered.promise
    state.authority++
    engineRelease.resolve()
    await expect(pendingImport).rejects.toThrow("changed")
    expect(state.imports).toBe(1)
    hooks.engine = undefined
    // Downloaded bytes from an old account must never become a readable renderer result.
    const downloadEntered = Promise.withResolvers<void>()
    const downloadRelease = Promise.withResolvers<void>()
    hooks.download = async () => {
      downloadEntered.resolve()
      await downloadRelease.promise
    }
    const delayedPreview = brain.previewReturned({ cwd: "/fixture", rid: identity.rid, artifactId: "7" })
    await downloadEntered.promise
    state.token = "desktop-account-b"
    downloadRelease.resolve()
    await expect(delayedPreview).rejects.toThrow("changed")
    hooks.download = undefined
    state.name = "wrong-artifact"
    await expect(brain.previewReturned({ cwd: "/fixture", rid: identity.rid, artifactId: "7" })).rejects.toThrow(
      "identity changed",
    )
    expect(state.downloads).toBe(4)
  } finally {
    brain.clear()
    server.stop(true)
  }
})

test("delayed readable Brain preview is retired when its account changes", async () => {
  const f = fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.hooks.preview = async () => {
    entered.resolve()
    await release.promise
  }
  const preview = f.brain.preview("/fixture")
  await entered.promise
  f.state.token = "desktop-account-b"
  release.resolve()
  await expect(preview).rejects.toThrow("changed")
  expect(f.calls).toEqual([])
})

test("a pending engine handshake cannot expose a previous account's local preview", async () => {
  const f = fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.hooks.engine = async () => {
    entered.resolve()
    await release.promise
  }
  const preview = f.brain.preview("/fixture")
  await entered.promise
  f.state.token = "desktop-account-b"
  release.resolve()
  await expect(preview).rejects.toThrow("changed")
  expect(f.state.localRequests).toBe(0)
})

test("GitHub identity and visibility changes invalidate exact Brain approval before upload", async () => {
  const f = fixture()
  const preview = await f.brain.preview("/fixture")
  f.state.githubIdentity = "different-github-owner"
  await expect(
    f.brain.start({ cwd: "/fixture", prompt: "task", previewId: preview.id, approvedSha256: preview.sha256 }),
  ).rejects.toThrow("changed")
  expect(f.calls).toEqual([])
  f.state.githubIdentity = "github-only"
  const another = await f.brain.preview("/fixture")
  f.state.private = true
  await expect(
    f.brain.start({ cwd: "/fixture", prompt: "task", previewId: another.id, approvedSha256: another.sha256 }),
  ).rejects.toThrow("changed")
  expect(f.calls).toEqual([])
})

test("a binding or GitHub authority change during prepare prevents commit and dispatch", async () => {
  const f = fixture()
  const preview = await f.brain.preview("/fixture")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.hooks.prepare = async () => {
    entered.resolve()
    await release.promise
  }
  const start = f.brain.start({
    cwd: "/fixture",
    prompt: "task",
    previewId: preview.id,
    approvedSha256: preview.sha256,
  })
  await entered.promise
  f.state.githubIdentity = "different-authority"
  release.resolve()
  await expect(start).rejects.toThrow("changed")
  expect(f.calls.map((call) => call.path)).toEqual(["/api/cloud-agents/brain-prepare"])
})
