import { expect, test } from "bun:test"
import { createHash, createDecipheriv } from "node:crypto"
import type { BrainExport } from "@vectordevai/core/brain/export"
import { BrainUpload } from "@vectordevai/core/brain/upload"
import { RunProposalsCodec } from "@vectordevai/core/brain/run-proposals-codec"
import { createGithubAgentsBrain } from "./github-agents-brain"
import { encryptConversation } from "../../../engine/src/cli/cmd/github.session"
import { cloudBrainArtifactKey, cloudRunArtifactKey } from "../../../../api/_lib/cloud-agents-artifact"
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
      expect(url.pathname).toBe("/experimental/brain/run-bundle/preview")
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

// BT10: the returned-draft owner read on the artifact a desktop Brain run's engine seals (BT07b's save in
// github.agent.ts `writeConversation`: the approved bundle and its approval under the run's Brain key), with the drafts
// core's `BrainRunProposals.pack` returns beside them (BT07b's codec case S2). No production run writes drafts yet
// (deviations "2026-11-16 BT07b" item 2); the third case pins the artifact it writes today.
const RUN = { repositoryId: "41", thread: "dispatch-99", rid: "gh-41-99-1-7" }
const STARTED = 1_800_000_000_000
const EXPIRES = "2026-11-23T00:00:00Z"
const BLOB = "https://fixture.blob.core.windows.net/artifacts/7.zip?sig=fixture"
// The server's own key derivations, with a fixture master passed as env and never read from the process.
const MASTER = { VECTOR_RUN_ARTIFACT_SECRET: "m".repeat(32) }
const CLAIMS = { sub: "00000000-0000-4000-8000-0000000000bb", repo: RUN.repositoryId, gen: 1, thr: RUN.thread }
const ENGINE_ANSWER = { proposed: 1, known: 1, refused: 0, over: 0 }
const RETURNED = { cwd: "/fixture", rid: RUN.rid, artifactId: "7" }

test("a desktop Brain run's returned drafts, sealed as its save writes them, are found, previewed only as drafts and imported once at the previewed digest", async () => {
  const artifact = await brainArtifact({ publicRun: false, drafts: "lessons-and-skill" })
  const proposals = artifact.proposals!
  using desk = returnedDesk(artifact)
  // The run's own artifact only: another name and another run's artifact are left out, and listing reads no key.
  expect(await desk.brain.artifacts({ cwd: "/fixture", rid: RUN.rid })).toEqual([
    { artifactId: "7", name: "vector-session-dispatch-99", expiresAt: EXPIRES },
  ])
  expect(desk.seen.vector).toHaveLength(0)
  const preview = await desk.brain.previewReturned(RETURNED)
  expect(desk.seen.vector).toHaveLength(1)
  expect(desk.seen.github.map((request) => request.path)).toEqual([
    "/repos/acme/repo/actions/runs/99/artifacts?per_page=100",
    "/repos/acme/repo/actions/artifacts/7",
    "/repos/acme/repo/actions/artifacts/7/zip",
  ])
  // GitHub's zip route redirects to signed storage, which gets no credential (expectDomains).
  expect(desk.seen.blob.map((request) => request.path)).toEqual([BLOB])
  expect(preview).toMatchObject({
    repositoryId: "41",
    rid: RUN.rid,
    sha256: proposals.sha256,
    bytes: proposals.bytes.byteLength,
    currentPublicRepository: false,
    publicRepository: false,
  })
  const file = RunProposalsCodec.parse({
    path: RunProposalsCodec.PATH,
    bytes: proposals.bytes,
    publicRepository: false,
  })
  expect(JSON.parse(preview.text)).toEqual(file)
  // Only this run's proposed records, as drafts: the active, private and older records stayed home.
  expect(
    [...file.memory.entries, ...(file.memory.skills ?? [])].map((record) => [
      record.id,
      record.kind,
      record.status,
      record.pinned,
      record.private,
    ]),
  ).toEqual([
    ["d1", "lesson", "proposed", false, undefined],
    ["s1", "skill", "proposed", false, undefined],
  ])
  // The approved bundle and the session travel in the same artifact and never reach the renderer.
  for (const secret of [
    artifact.key.key,
    "github-only",
    "desktop-only",
    "PRIVATE_SESSION_CANARY",
    "OWNER_APPROVED_CONTEXT",
  ])
    expect(JSON.stringify(preview)).not.toContain(secret)
  await expect(desk.brain.importReturned({ previewId: preview.id, approvedSha256: "0".repeat(64) })).rejects.toThrow(
    "Review and approve this exact attachment again",
  )
  expect(desk.seen.engine).toHaveLength(0)
  expect(await desk.brain.importReturned({ previewId: preview.id, approvedSha256: preview.sha256 })).toEqual(
    ENGINE_ANSWER,
  )
  expect(desk.seen.engine.map((request) => [request.path, request.json])).toEqual([
    [
      "/experimental/brain/run-proposals/import?directory=%2Ffixture",
      {
        path: "brain/proposals.json",
        base64url: BrainUpload.base64url(proposals.bytes),
        sha256: proposals.sha256,
        publicRepository: false,
      },
    ],
  ])
  // The Import click reads the owner key again.
  expect(desk.seen.vector).toHaveLength(2)
  await expect(desk.brain.importReturned({ previewId: preview.id, approvedSha256: preview.sha256 })).rejects.toThrow(
    "Review and approve this exact attachment again",
  )
  expect(desk.seen.engine).toHaveLength(1)
  expect(desk.seen.vector).toHaveLength(2)
  // An old approval must not reach the local import endpoint if authority changes during engine discovery.
  const pending = await desk.brain.previewReturned(RETURNED)
  const engineEntered = Promise.withResolvers<void>()
  const engineRelease = Promise.withResolvers<void>()
  desk.hooks.engine = async () => {
    engineEntered.resolve()
    await engineRelease.promise
  }
  const pendingImport = desk.brain.importReturned({ previewId: pending.id, approvedSha256: pending.sha256 })
  await engineEntered.promise
  desk.state.authority++
  engineRelease.resolve()
  await expect(pendingImport).rejects.toThrow("changed")
  desk.hooks.engine = undefined
  // Downloaded bytes from an old account must never become a readable renderer result.
  const downloadEntered = Promise.withResolvers<void>()
  const downloadRelease = Promise.withResolvers<void>()
  desk.hooks.download = async () => {
    downloadEntered.resolve()
    await downloadRelease.promise
  }
  const delayed = desk.brain.previewReturned(RETURNED)
  await downloadEntered.promise
  desk.state.token = "desktop-account-b"
  downloadRelease.resolve()
  await expect(delayed).rejects.toThrow("changed")
  desk.hooks.download = undefined
  // Back under the first account, the first call sees the change too, and is refused.
  desk.state.token = "desktop-only"
  await expect(desk.brain.artifacts({ cwd: "/fixture", rid: RUN.rid })).rejects.toThrow("changed")
  // This fake's authority leaves visibility out, so only the controller's own check sees the flip. In production the
  // authority hashes visibility (github-agents.ts `context`), so the same flip is refused one step earlier.
  const visible = await desk.brain.previewReturned(RETURNED)
  desk.state.private = false
  await expect(desk.brain.importReturned({ previewId: visible.id, approvedSha256: visible.sha256 })).rejects.toThrow(
    "visibility changed",
  )
  desk.state.private = true
  const rebound = await desk.brain.previewReturned(RETURNED)
  desk.state.private = false
  desk.state.authority++
  await expect(desk.brain.importReturned({ previewId: rebound.id, approvedSha256: rebound.sha256 })).rejects.toThrow(
    "authority changed",
  )
  desk.state.private = true
  desk.state.name = "wrong-artifact"
  await expect(desk.brain.previewReturned(RETURNED)).rejects.toThrow("identity changed")
  expect(desk.seen.engine).toHaveLength(1)
  expect(desk.seen.blob).toHaveLength(5)
  expectDomains(desk, artifact.key.key)
})

// The owner read answers the repository's current visibility (api/_lib/github-app.ts `ownerArtifact`); the run's own,
// at its first download, is in the artifact's approval. The last row is the race where the owner read already sees
// the repository public and the desktop's own view does not.
test.each([
  ["a public run in a now-private repository", { publicRun: true, private: true, ownerPublic: undefined }],
  ["a private run in a now-public repository", { publicRun: false, private: false, ownerPublic: undefined }],
  ["a private run the owner read already sees public", { publicRun: false, private: true, ownerPublic: true }],
])("returned drafts keep public screening when the run or the repository is public (%s)", async (_, row) => {
  // Lessons only is what a public run packs; a private run with no new skill packs the same.
  const lessons = await brainArtifact({ publicRun: row.publicRun, drafts: "lessons" })
  using desk = returnedDesk(lessons)
  desk.state.private = row.private
  desk.state.ownerPublic = row.ownerPublic
  const preview = await desk.brain.previewReturned(RETURNED)
  expect(preview.publicRepository).toBe(true)
  expect(preview.currentPublicRepository).toBe(!row.private)
  expect(await desk.brain.importReturned({ previewId: preview.id, approvedSha256: preview.sha256 })).toEqual(
    ENGINE_ANSWER,
  )
  expect(desk.seen.engine.map((request) => request.json)).toEqual([
    {
      path: "brain/proposals.json",
      base64url: BrainUpload.base64url(lessons.proposals!.bytes),
      sha256: lessons.proposals!.sha256,
      publicRepository: true,
    },
  ])
  // A procedure draft, which a private run packs (and a public run's engine never would), is refused before any
  // import. The bundle is the same, so the run's Brain key opens it.
  const procedures = await brainArtifact({ publicRun: row.publicRun, drafts: "lessons-and-skill" })
  expect(procedures.key).toEqual(lessons.key)
  desk.state.zip = procedures.zip
  await expect(desk.brain.previewReturned(RETURNED)).rejects.toThrow("Invalid returned repository Brain drafts")
  expect(desk.seen.engine).toHaveLength(1)
  expectDomains(desk, lessons.key.key)
})

// B08 (BT10 item 4): the owner read also answers the visibility the server recorded for the run's Brain context. It can
// only make screening stricter, and with neither it nor an approved bundle the run's visibility is unknown.
test("the server's recorded public visibility screens a private run's drafts as public in preview and import", async () => {
  const lessons = await brainArtifact({ publicRun: false, drafts: "lessons" })
  using desk = returnedDesk(lessons)
  desk.state.historical = true
  const preview = await desk.brain.previewReturned(RETURNED)
  expect(preview).toMatchObject({ currentPublicRepository: false, publicRepository: true })
  // The Import click's fresh read leaves the field out; the value cached with the preview still screens as public.
  desk.state.historical = undefined
  expect(await desk.brain.importReturned({ previewId: preview.id, approvedSha256: preview.sha256 })).toEqual(
    ENGINE_ANSWER,
  )
  expect(desk.seen.engine.map((request) => (request.json as { publicRepository: boolean }).publicRepository)).toEqual([
    true,
  ])
  // A procedure draft is refused when only the server says the run was public.
  const procedures = await brainArtifact({ publicRun: false, drafts: "lessons-and-skill" })
  desk.state.zip = procedures.zip
  desk.state.historical = true
  await expect(desk.brain.previewReturned(RETURNED)).rejects.toThrow("Invalid returned repository Brain drafts")
  expectDomains(desk, lessons.key.key)
})

test("a run's public approval is never lowered by the server's recorded private visibility", async () => {
  const lessons = await brainArtifact({ publicRun: true, drafts: "lessons" })
  using desk = returnedDesk(lessons)
  desk.state.historical = false
  const preview = await desk.brain.previewReturned(RETURNED)
  expect(preview).toMatchObject({ currentPublicRepository: false, publicRepository: true })
  expect(await desk.brain.importReturned({ previewId: preview.id, approvedSha256: preview.sha256 })).toEqual(
    ENGINE_ANSWER,
  )
  expect(desk.seen.engine.map((request) => (request.json as { publicRepository: boolean }).publicRepository)).toEqual([
    true,
  ])
})

test("returned drafts with no approved bundle and no recorded visibility, or a malformed field, are refused", async () => {
  const bare = await brainArtifact({ publicRun: false, drafts: "lessons", bundle: false })
  using desk = returnedDesk(bare)
  await expect(desk.brain.previewReturned(RETURNED)).rejects.toThrow(
    "This run has no recorded visibility for its returned proposals.",
  )
  // The server's recorded visibility alone is enough.
  desk.state.historical = false
  const preview = await desk.brain.previewReturned(RETURNED)
  expect(preview.publicRepository).toBe(false)
  desk.state.historical = "true"
  await expect(desk.brain.importReturned({ previewId: preview.id, approvedSha256: preview.sha256 })).rejects.toThrow(
    "no longer authorized",
  )
  await expect(desk.brain.previewReturned(RETURNED)).rejects.toThrow("Vector could not authorize this run artifact.")
  expect(desk.seen.engine).toHaveLength(0)
})

test("what a desktop Brain run saves today, with no returned drafts, previews nothing, and only that run's Brain key opens its artifact", async () => {
  const today = await brainArtifact({ publicRun: false, drafts: "none" })
  using desk = returnedDesk(today)
  await expect(desk.brain.previewReturned(RETURNED)).rejects.toThrow(
    "This run has no valid returned repository Brain proposals.",
  )
  const packed = await brainArtifact({ publicRun: false, drafts: "lessons-and-skill" })
  expect(packed.key).toEqual(today.key)
  desk.state.zip = packed.zip
  expect((await desk.brain.previewReturned(RETURNED)).sha256).toBe(packed.proposals!.sha256)
  // The ordinary key, and a Brain key for another digest, visibility or thread, share the key id; only GCM refuses.
  for (const other of [
    cloudRunArtifactKey(CLAIMS, MASTER),
    cloudBrainArtifactKey(CLAIMS, { sha256: "c".repeat(64), publicRepository: false }, MASTER),
    cloudBrainArtifactKey(CLAIMS, { sha256: packed.bundle.sha256, publicRepository: true }, MASTER),
    cloudBrainArtifactKey(
      { ...CLAIMS, thr: "dispatch-100" },
      { sha256: packed.bundle.sha256, publicRepository: false },
      MASTER,
    ),
  ]) {
    expect(other.keyId).toBe(packed.key.keyId)
    expect(other.key).not.toBe(packed.key.key)
    desk.state.ownerKey = other
    await expect(desk.brain.previewReturned(RETURNED)).rejects.toThrow(
      "This run has no valid returned repository Brain proposals.",
    )
  }
  expect(desk.seen.engine).toHaveLength(0)
  expectDomains(desk, packed.key.key)
})

// Zeroing the cached plaintext (`clear` and `take`'s refusal) cannot be seen through the ports, so these variants pin
// what can: the preview is gone, nothing reaches the import endpoint, and the first account does not revive it. An
// account change this controller never observes is the main process's to retire (github-agents.ts `invalidateAuthority`).
test("an account change or sign-out retires a returned preview before any import, and returning to the first account does not revive it", async () => {
  const artifact = await brainArtifact({ publicRun: false, drafts: "lessons-and-skill" })
  using desk = returnedDesk(artifact)
  const approve = (preview: { id: string; sha256: string }) =>
    desk.brain.importReturned({ previewId: preview.id, approvedSha256: preview.sha256 })
  // The first call that sees another account (or sees the first one again) is refused, and retires the cache.
  const settle = () => expect(desk.brain.artifacts({ cwd: "/fixture", rid: RUN.rid })).rejects.toThrow("changed")
  const observed = await desk.brain.previewReturned(RETURNED)
  desk.state.token = "desktop-account-b"
  await settle()
  desk.state.token = "desktop-only"
  await expect(approve(observed)).rejects.toThrow("Review and approve this exact attachment again")
  await settle()
  const direct = await desk.brain.previewReturned(RETURNED)
  desk.state.token = "desktop-account-b"
  await expect(approve(direct)).rejects.toThrow("changed")
  desk.state.token = "desktop-only"
  await expect(approve(direct)).rejects.toThrow("Review and approve this exact attachment again")
  await settle()
  const signedOut = await desk.brain.previewReturned(RETURNED)
  desk.state.token = undefined
  await expect(desk.brain.artifacts({ cwd: "/fixture", rid: RUN.rid })).rejects.toThrow("Sign in to Vector")
  desk.state.token = "desktop-only"
  await expect(approve(signedOut)).rejects.toThrow("Review and approve this exact attachment again")
  const held = await desk.brain.previewReturned(RETURNED)
  const ownerEntered = Promise.withResolvers<void>()
  const ownerRelease = Promise.withResolvers<void>()
  desk.hooks.owner = async () => {
    ownerEntered.resolve()
    await ownerRelease.promise
  }
  const heldImport = approve(held)
  await ownerEntered.promise
  desk.state.token = "desktop-account-b"
  ownerRelease.resolve()
  await expect(heldImport).rejects.toThrow("changed")
  desk.hooks.owner = undefined
  expect(desk.seen.engine).toHaveLength(0)
  expectDomains(desk, artifact.key.key)
})

/** Seals what the engine's save writes for a desktop Brain run, zipped as GitHub serves the uploaded artifact. */
async function brainArtifact(input: {
  publicRun: boolean
  drafts: "none" | "lessons" | "lessons-and-skill"
  // Leave the approved bundle (and its approval) out of the sealed artifact.
  bundle?: false
}) {
  // Core's Brain graph, and the engine's opener and upload fixture, load only in the cases that seal an artifact. Core's
  // Brain graph creates core's global directories when imported, so a local run sets XDG_DATA_HOME, XDG_CONFIG_HOME,
  // XDG_STATE_HOME, XDG_CACHE_HOME and VECTOR_TEST_HOME to scratch directories, as the lane's runs do.
  const { BrainRunBundle } = await import("@vectordevai/core/brain/run-bundle")
  const { BrainRunProposals } = await import("@vectordevai/core/brain/run-proposals")
  const { GithubBrain } = await import("../../../engine/src/cli/cmd/github.brain")
  const { brainUploaded } = await import("../../../engine/test/cli/github.agent-fixture")
  const screen = async (parts: readonly string[]) => parts.map(() => true)
  const bundle = await BrainRunBundle.pack({
    ownerStartedDesktop: true,
    includeBrain: true,
    publicRepository: input.publicRun,
    memory: {
      format: "vector-memory",
      version: 1,
      scope: "repository",
      exportedAt: STARTED - 60_000,
      documents: [],
      entries: [draft({ id: "c1", status: "active", text: "OWNER_APPROVED_CONTEXT", createdAt: STARTED - 120_000 })],
    },
    shareableSkills: [],
    insights: { format: "vector-workflow-insights", version: 1, rows: [] },
    screen,
  })
  // brain-download's answer for the desktop's own upload of this bundle (core's `BrainUpload.upload`), opened by the
  // run's own `GithubBrain.openUpload`, so the bytes and the approval are the ones the engine's save writes.
  const download = await brainUploaded(bundle.bytes, {
    repositoryId: RUN.repositoryId,
    publicRepository: input.publicRun,
  })
  const opened = GithubBrain.openUpload(download, {
    repositoryId: RUN.repositoryId,
    uploadId: download.uploadId,
    publicRepository: input.publicRun,
  })
  if (!opened) throw new Error("Fixture upload did not open")
  // brain-download's Brain key, derived by the server (the fixture answer's own key is not used); the owner read
  // derives the same key from the run record.
  const key = cloudBrainArtifactKey(CLAIMS, { sha256: bundle.sha256, publicRepository: input.publicRun }, MASTER)
  const proposals =
    input.drafts === "none"
      ? undefined
      : await BrainRunProposals.pack({
          memory: {
            format: "vector-memory",
            version: 1,
            scope: "repository",
            exportedAt: STARTED + 2,
            documents: [],
            entries: [
              draft({ id: "d1" }),
              draft({ id: "a1", status: "active", text: "An active entry stays home." }),
              draft({ id: "p1", private: true, text: "A private draft stays home." }),
              draft({ id: "o1", createdAt: STARTED - 1, text: "An older draft stays home." }),
            ],
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
          },
          startedAt: STARTED,
          // Packing as public leaves skills out, as a public run's engine does.
          publicRepository: input.drafts === "lessons",
          maxBytes: BrainRunProposals.MAX_BYTES - bundle.bytes.byteLength,
          screen,
        })
  if (input.drafts !== "none" && !proposals) throw new Error("Fixture drafts did not pack")
  const sealed = await encryptConversation({
    identity: RUN,
    key,
    session: { messages: ["PRIVATE_SESSION_CANARY"] },
    ...(input.bundle === false
      ? {}
      : { brain: { path: BrainRunBundle.PATH, bytes: opened.bytes, approval: opened.approval } }),
    ...(proposals ? { proposals: { path: RunProposalsCodec.PATH, bytes: proposals.bytes } } : {}),
  })
  const writer = new ZipWriter(new Uint8ArrayWriter())
  await writer.add("session.vsa", new Uint8ArrayReader(sealed), {
    level: 0,
    useWebWorkers: false,
    useCompressionStream: false,
  })
  return { zip: await writer.close(), key, bundle, proposals }
}

function draft(extra: Partial<BrainExport.Item>): BrainExport.Item {
  return {
    id: "d1",
    kind: "lesson",
    scope: "repository",
    status: "proposed",
    text: "Run the parser fixtures before a release.",
    paths: [],
    pinned: false,
    evidence: [],
    createdAt: STARTED + 1,
    ...extra,
  }
}

/**
 * The returned-draft controller behind fake ports: GitHub (one run's artifacts, a zip route that redirects to signed
 * storage), the local engine's import route, and vectordev.ai's owner read, which answers like
 * `createOwnerArtifactReadApi`: the run record's key with the repository's current visibility.
 */
function returnedDesk(artifact: { zip: Uint8Array; key: { key: string; keyId: string } }) {
  const state = {
    token: "desktop-only" as string | undefined,
    private: true,
    ownerPublic: undefined as boolean | undefined,
    // The owner read's `historicalPublicRepository`: left out when undefined, as a server before B08's field answers.
    historical: undefined as unknown,
    ownerKey: artifact.key,
    authority: 0,
    name: "vector-session-dispatch-99",
    zip: artifact.zip,
  }
  const hooks: { engine?: () => Promise<void>; download?: () => Promise<void>; owner?: () => Promise<void> } = {}
  const seen = {
    github: [] as Seen[],
    blob: [] as Seen[],
    engine: [] as (Seen & { json: unknown })[],
    vector: [] as { path: string; body: unknown; account: string; scope: unknown }[],
  }
  const metadata = (extra: Record<string, unknown> = {}) => ({
    id: 7,
    name: state.name,
    expired: false,
    size_in_bytes: state.zip.byteLength,
    expires_at: EXPIRES,
    workflow_run: { id: 99, repository_id: 41, head_repository_id: 41 },
    ...extra,
  })
  const github = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      seen.github.push(await observe(request))
      if (request.headers.get("authorization") !== "Bearer github-only")
        return Response.json({ message: "Wrong credential domain" }, { status: 401 })
      if (url.pathname === "/repos/acme/repo/actions/runs/99/artifacts")
        return Response.json({
          total_count: 3,
          artifacts: [
            metadata(),
            metadata({ id: 8, name: "vector-out" }),
            metadata({ id: 9, workflow_run: { id: 100, repository_id: 41, head_repository_id: 41 } }),
          ],
        })
      if (url.pathname === "/repos/acme/repo/actions/artifacts/7") return Response.json(metadata())
      if (url.pathname === "/repos/acme/repo/actions/artifacts/7/zip")
        return new Response(null, { status: 302, headers: { location: BLOB } })
      return Response.json({ message: "Not Found" }, { status: 404 })
    },
  })
  const engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const observed = await observe(request)
      seen.engine.push({ ...observed, json: JSON.parse(observed.body) })
      if (url.pathname !== "/experimental/brain/run-proposals/import") return new Response(null, { status: 404 })
      return Response.json(ENGINE_ANSWER)
    },
  })
  const brain = createGithubAgentsBrain({
    token: async () => state.token,
    context: async () => ({
      authority: JSON.stringify(["returned-owner-authority", state.authority]),
      access: { token: "github-only", source: "vector", apiUrl: github.url.origin },
      info: { id: 41, full_name: "acme/repo", private: state.private, permissions: { push: true } },
    }),
    engine: async () => {
      await hooks.engine?.()
      return { url: engine.url.origin, username: "vector", password: "owner-only" }
    },
    vector: async (path, body, account, scope) => {
      // Checked on entry, so a held read released after an account switch is refused by the controller itself.
      expect(account).toBe(sha256(state.token ?? ""))
      seen.vector.push({ path, body, account, scope })
      await hooks.owner?.()
      expect(path).toBe("/api/cloud-agents/owner-artifact-key")
      expect(body).toEqual({ rid: RUN.rid, artifactId: "7" })
      return {
        ...state.ownerKey,
        repositoryId: RUN.repositoryId,
        thread: RUN.thread,
        rid: RUN.rid,
        artifactId: "7",
        publicRepository: state.ownerPublic ?? !state.private,
        ...(state.historical === undefined ? {} : { historicalPublicRepository: state.historical }),
      }
    },
    // Loopback requests reach the fakes and the signed storage URL is answered here; any other host fails closed, so no
    // real host can be called.
    fetch: async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return fetch(input, init)
      if (url.hostname !== "fixture.blob.core.windows.net") throw new Error("Unexpected host " + url.host)
      seen.blob.push(await observe(new Request(url, init)))
      const response = new Response(Uint8Array.from(state.zip))
      // Hold the client result after the response; delaying Bun's server handler can replay a GET.
      await hooks.download?.()
      return response
    },
  })
  return {
    brain,
    state,
    hooks,
    seen,
    [Symbol.dispose]() {
      brain.clear()
      github.stop(true)
      engine.stop(true)
    },
  }
}
type Seen = { path: string; authorization: string | null; text: string; body: string }

async function observe(request: Request): Promise<Seen> {
  const url = new URL(request.url)
  const body = await request.text()
  return {
    path: url.hostname === "fixture.blob.core.windows.net" ? url.href : url.pathname + url.search,
    authorization: request.headers.get("authorization"),
    text: JSON.stringify([url.href, [...request.headers], body]),
    body,
  }
}

/** Each credential stays in its own domain: GitHub, signed storage, the local engine and vectordev.ai. */
function expectDomains(desk: ReturnType<typeof returnedDesk>, key: string) {
  const desktop = ["desktop-only", "desktop-account-b"].flatMap((token) => [token, sha256(token)])
  for (const request of desk.seen.github) {
    expect(request.authorization).toBe("Bearer github-only")
    for (const secret of [...desktop, key, "owner-only", "PRIVATE_SESSION_CANARY"])
      expect(request.text).not.toContain(secret)
  }
  for (const request of desk.seen.blob) {
    expect(request.authorization).toBeNull()
    for (const secret of [...desktop, key, "github-only", "owner-only"]) expect(request.text).not.toContain(secret)
  }
  for (const request of desk.seen.engine) {
    expect(request.authorization).toBe("Basic " + Buffer.from("vector:owner-only").toString("base64"))
    for (const secret of [...desktop, key, "github-only"]) expect(request.text).not.toContain(secret)
  }
  for (const call of desk.seen.vector)
    expect(JSON.stringify([call.path, call.body, call.scope])).not.toContain("github-only")
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}
