import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js"
import { z } from "zod"
import { GithubAgents } from "@vectordevai/core/github-agents"

const LIMIT = GithubAgents.PATCH_LIMITS.sessionBytes
const ZIP = { useWebWorkers: false, useCompressionStream: false }
const Header = z
  .object({
    keyId: z.string().regex(/^[0-9a-f]{16}$(?![\s\S])/),
    repositoryId: z.string().regex(/^[1-9]\d{0,19}$(?![\s\S])/),
    thread: z.string().regex(GithubAgents.THREAD_PATTERN),
    rid: z.string().regex(GithubAgents.RUN_ID_PATTERN),
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$(?![\s\S])/),
  })
  .strict()
const Approval = z
  .object({
    source: z.literal("desktop"),
    repositoryId: z.string().regex(/^[1-9]\d{0,19}$(?![\s\S])/),
    sha256: z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/),
    approvedAt: z.number().int().positive().safe(),
    audience: z.literal("owner-desktop"),
    publicRepository: z.boolean(),
  })
  .strict()
const Origin = z
  .object({
    repositoryId: z.string().regex(/^[1-9]\d{0,19}$(?![\s\S])/),
    thread: z.string().regex(GithubAgents.THREAD_PATTERN),
    rid: z.string().regex(GithubAgents.RUN_ID_PATTERN),
  })
  .strict()
const File = z
  .object({
    path: z.enum(["session.json", "brain/bundle.json", "brain/proposals.json"]),
    bytes: z.number().int().nonnegative().max(LIMIT),
    sha256: z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/),
    kind: z.enum(["session", "brain", "brain-proposals"]),
    approval: Approval.optional(),
    origin: Origin.optional(),
  })
  .strict()
const Manifest = z
  .object({
    v: z.literal(1),
    thread: z.string().regex(GithubAgents.THREAD_PATTERN),
    rid: z.string().regex(GithubAgents.RUN_ID_PATTERN),
    files: z.array(File).min(1).max(3),
  })
  .strict()

export type ArtifactIdentity = Pick<z.infer<typeof Header>, "repositoryId" | "thread" | "rid">
export type DesktopBrainApproval = z.infer<typeof Approval>
export type ArtifactKey = { key: string; keyId: string }
export type BrainAttachment = {
  path: "brain/bundle.json"
  bytes: Uint8Array
  approval: z.infer<typeof Approval>
}
export type ProposalAttachment = { path: "brain/proposals.json"; bytes: Uint8Array }

function keyBytes(key: ArtifactKey) {
  if (!/^[A-Za-z0-9_-]{43}$(?![\s\S])/.test(key.key) || !/^[0-9a-f]{16}$(?![\s\S])/.test(key.keyId))
    throw new Error("Invalid artifact key")
  const bytes = Buffer.from(key.key, "base64url")
  if (bytes.length !== 32 || bytes.toString("base64url") !== key.key) throw new Error("Invalid artifact key")
  return bytes
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const aad = (header: z.infer<typeof Header>) =>
  Buffer.from(`VSA1|${header.keyId}|${header.repositoryId}|${header.thread}|${header.rid}`)

async function zipped(files: { path: string; bytes: Uint8Array }[]) {
  const output = new Uint8ArrayWriter()
  const writer = new ZipWriter(output)
  try {
    for (const file of files)
      await writer.add(file.path, new Uint8ArrayReader(Uint8Array.from(file.bytes)), { ...ZIP, level: 6 })
    const bytes = await writer.close()
    if (bytes.byteLength > LIMIT) throw new Error("Artifact ZIP is too large")
    return bytes
  } catch (error) {
    await writer.close().catch(() => {})
    throw error
  }
}

/** No ZIP entry is extracted to a path; both declared and actual uncompressed bytes are bounded while streaming. */
async function unzipped(bytes: Uint8Array, allowed: ReadonlyMap<string, number>, maximumBytes: number = LIMIT) {
  if (bytes.byteLength > maximumBytes) throw new Error("Artifact ZIP is too large")
  // zip.js uses Uint8Array.slice() as an owned zero-offset buffer for DataView. Buffer.slice() is a view instead.
  const reader = new ZipReader(new Uint8ArrayReader(Uint8Array.from(bytes)), ZIP)
  const files = new Map<string, Uint8Array>()
  let total = 0
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      const maximum = allowed.get(entry.filename)
      if (
        maximum === undefined ||
        files.has(entry.filename) ||
        entry.directory ||
        entry.encrypted ||
        !entry.getData ||
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0 ||
        entry.uncompressedSize > maximum ||
        files.size >= allowed.size
      )
        throw new Error("Unexpected artifact ZIP entry")
      const chunks: Uint8Array[] = []
      let length = 0
      await entry.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            length += chunk.byteLength
            total += chunk.byteLength
            if (length > maximum || total > LIMIT) throw new Error("Artifact ZIP expanded past its limit")
            chunks.push(Uint8Array.from(chunk))
          },
        }),
        { ...ZIP, checkSignature: true },
      )
      if (length !== entry.uncompressedSize) throw new Error("Artifact ZIP size differs")
      files.set(entry.filename, Buffer.concat(chunks))
    }
    return files
  } finally {
    await reader.close()
  }
}

/** The caller supplies an explicitly approved Brain attachment only for an owner-started desktop dispatch. */
export async function encryptConversation(input: {
  identity: ArtifactIdentity
  key: ArtifactKey
  session: unknown
  brain?: BrainAttachment
  proposals?: ProposalAttachment
}) {
  const header = Header.parse({ ...input.identity, keyId: input.key.keyId, iv: randomBytes(12).toString("base64url") })
  if (!header.rid.startsWith(`gh-${header.repositoryId}-`)) throw new Error("Artifact repository differs")
  const session = Buffer.from(JSON.stringify(input.session))
  if (session.length > LIMIT) throw new Error("Session artifact is too large")
  const files = [{ path: "session.json", bytes: session }]
  const listed: z.infer<typeof File>[] = [
    { path: "session.json", bytes: session.length, sha256: digest(session), kind: "session" },
  ]
  if (input.brain) {
    const brain = input.brain
    const approval = Approval.parse(brain.approval)
    if (
      brain.path !== "brain/bundle.json" ||
      brain.bytes.byteLength > 512 * 1024 ||
      approval.repositoryId !== header.repositoryId ||
      approval.sha256 !== digest(brain.bytes)
    )
      throw new Error("Brain attachment lacks approval for its exact bytes")
    files.push({ path: brain.path, bytes: Buffer.from(brain.bytes) })
    listed.push({ path: brain.path, bytes: brain.bytes.byteLength, sha256: approval.sha256, kind: "brain", approval })
  }
  if (input.proposals) {
    const proposals = input.proposals
    if (
      proposals.path !== "brain/proposals.json" ||
      proposals.bytes.byteLength + (input.brain?.bytes.byteLength ?? 0) > 512 * 1024
    )
      throw new Error("Brain proposals exceed their combined budget")
    files.push({ path: proposals.path, bytes: Buffer.from(proposals.bytes) })
    listed.push({
      path: proposals.path,
      bytes: proposals.bytes.byteLength,
      sha256: digest(proposals.bytes),
      kind: "brain-proposals",
      origin: input.identity,
    })
  }
  const manifest = Manifest.parse({ v: 1, thread: header.thread, rid: header.rid, files: listed })
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  if (manifestBytes.length + files.reduce((sum, file) => sum + file.bytes.length, 0) > LIMIT)
    throw new Error("Session artifact is too large")
  const content = await zipped([{ path: "manifest.json", bytes: manifestBytes }, ...files])
  const encoded = Buffer.from(JSON.stringify(header))
  if (encoded.length > 1024) throw new Error("Artifact header is too large")
  const cipher = createCipheriv("aes-256-gcm", keyBytes(input.key), Buffer.from(header.iv, "base64url"))
  cipher.setAAD(aad(header))
  const prefix = Buffer.alloc(6)
  prefix.write("VSA1")
  prefix.writeUInt16BE(encoded.length, 4)
  const result = Buffer.concat([prefix, encoded, cipher.update(content), cipher.final(), cipher.getAuthTag()])
  if (result.length > LIMIT) throw new Error("Session artifact is too large")
  return result
}

/** Corrupt, rebound, mismatched or unavailable history falls back to the live GitHub thread, never to another key. */
export async function decryptConversation(input: {
  bytes: Uint8Array
  key: ArtifactKey
  expected: Pick<ArtifactIdentity, "repositoryId" | "thread"> & { rid?: string }
}) {
  try {
    const bytes = Buffer.from(input.bytes)
    if (bytes.length > LIMIT || bytes.length < 6 + 16 || bytes.subarray(0, 4).toString() !== "VSA1") return undefined
    const length = bytes.readUInt16BE(4)
    if (length > 1024 || bytes.length < 6 + length + 16) return undefined
    const header = Header.parse(JSON.parse(bytes.subarray(6, 6 + length).toString("utf8")))
    if (
      header.keyId !== input.key.keyId ||
      header.repositoryId !== input.expected.repositoryId ||
      header.thread !== input.expected.thread ||
      (input.expected.rid !== undefined && header.rid !== input.expected.rid) ||
      !header.rid.startsWith(`gh-${header.repositoryId}-`)
    )
      return undefined
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(input.key), Buffer.from(header.iv, "base64url"))
    decipher.setAAD(aad(header))
    decipher.setAuthTag(bytes.subarray(-16))
    const plain = Buffer.concat([decipher.update(bytes.subarray(6 + length, -16)), decipher.final()])
    const files = await unzipped(
      plain,
      new Map([
        ["manifest.json", 4096],
        ["session.json", LIMIT],
        ["brain/bundle.json", 512 * 1024],
        ["brain/proposals.json", 512 * 1024],
      ]),
    )
    if (
      (files.get("brain/bundle.json")?.byteLength ?? 0) + (files.get("brain/proposals.json")?.byteLength ?? 0) >
      512 * 1024
    )
      return undefined
    const manifestBytes = files.get("manifest.json")
    const sessionBytes = files.get("session.json")
    if (!manifestBytes || !sessionBytes) return undefined
    const manifest = Manifest.parse(JSON.parse(Buffer.from(manifestBytes).toString("utf8")))
    if (manifest.thread !== header.thread || manifest.rid !== header.rid || manifest.files.length !== files.size - 1)
      return undefined
    const names = new Set<string>()
    for (const file of manifest.files) {
      const content = files.get(file.path)
      if (!content || names.has(file.path) || content.byteLength !== file.bytes || digest(content) !== file.sha256)
        return undefined
      names.add(file.path)
      if (
        file.path === "session.json" &&
        (file.kind !== "session" || file.approval !== undefined || file.origin !== undefined)
      )
        return undefined
      if (
        file.path === "brain/bundle.json" &&
        (file.kind !== "brain" ||
          !file.approval ||
          file.approval.repositoryId !== header.repositoryId ||
          file.approval.sha256 !== file.sha256 ||
          file.origin !== undefined)
      )
        return undefined
      if (
        file.path === "brain/proposals.json" &&
        (file.kind !== "brain-proposals" ||
          file.approval !== undefined ||
          file.origin?.repositoryId !== header.repositoryId ||
          file.origin.thread !== header.thread ||
          file.origin.rid !== header.rid)
      )
        return undefined
    }
    if (!names.has("session.json")) return undefined
    return {
      header,
      manifest,
      session: JSON.parse(Buffer.from(sessionBytes).toString("utf8")) as unknown,
      brain: files.get("brain/bundle.json"),
      proposals: files.get("brain/proposals.json"),
    }
  } catch {
    return undefined
  }
}

/** Derived assistant history is withheld together with its source context unless current desktop consent matches. */
export function allowConversationRestore(
  conversation: NonNullable<Awaited<ReturnType<typeof decryptConversation>>>,
  current?: z.infer<typeof Approval>,
) {
  if (!conversation.brain && !conversation.proposals) return true
  const previous = conversation.manifest.files.find((file) => file.path === "brain/bundle.json")?.approval
  return (
    previous !== undefined &&
    current !== undefined &&
    current.source === "desktop" &&
    current.repositoryId === conversation.header.repositoryId &&
    previous.repositoryId === current.repositoryId &&
    previous.sha256 === current.sha256 &&
    previous.audience === current.audience &&
    previous.publicRepository === current.publicRepository
  )
}
// Artifact transport uses the same bounded ZIP reader without extracting paths.
const Artifact = z.object({
  id: z.number().int().positive().safe(),
  name: z.string().max(256),
  expired: z.boolean(),
  created_at: z.string().datetime({ offset: true }),
})
type ArtifactTransport = {
  repository: string
  token: string
  signal?: AbortSignal
  baseUrl?: string
  request: (url: string, init: RequestInit) => Promise<Response>
}

function artifactTransport(input: ArtifactTransport) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$(?![\s\S])/.test(input.repository)) return undefined
  const base = new URL(input.baseUrl ?? "https://api.github.com")
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))
  )
    return undefined
  return {
    base,
    signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    headers: {
      authorization: `Bearer ${input.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10",
    },
  }
}

async function responseBytes(response: Response, maximum: number) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Missing artifact response")
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) return Buffer.concat(chunks)
      length += item.value.byteLength
      if (length > maximum) throw new Error("Artifact response is too large")
      chunks.push(item.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Reconstruct the API URL from the verified repo and id. Never follow an artifact's arbitrary URL with a token. */
export async function latestConversation(input: ArtifactTransport & { thread: string }) {
  const name = `vector-session-${input.thread}`
  const artifacts: z.infer<typeof Artifact>[] = []
  try {
    if (!GithubAgents.THREAD_PATTERN.test(input.thread)) return undefined
    const transport = artifactTransport(input)
    if (!transport) return undefined
    const { base, signal, headers } = transport
    for (let page = 1; page <= 10; page++) {
      const response = await input.request(
        `${base.origin}/repos/${input.repository}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100&page=${page}`,
        { headers, redirect: "manual", signal },
      )
      if (!response.ok) {
        await response.body?.cancel()
        return undefined
      }
      const list = z
        .object({ artifacts: z.array(Artifact).max(100) })
        .parse(JSON.parse((await responseBytes(response, 1_000_000)).toString("utf8")))
      artifacts.push(...list.artifacts.filter((entry) => !entry.expired && entry.name === name))
      if (list.artifacts.length < 100) break
    }
    const latest = artifacts.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0]
    if (!latest) return undefined
    return downloadConversationArtifact({ ...input, signal, artifactId: String(latest.id) })
  } catch {
    return undefined
  }
}

/** Shared with the trusted desktop owner reader, which independently verifies exact run/artifact metadata. */
export async function downloadConversationArtifact(input: ArtifactTransport & { artifactId: string }) {
  try {
    if (!/^[1-9]\d{0,15}$(?![\s\S])/.test(input.artifactId) || !Number.isSafeInteger(Number(input.artifactId)))
      return undefined
    const transport = artifactTransport(input)
    if (!transport) return undefined
    const { base, signal, headers } = transport
    let response = await input.request(
      `${base.origin}/repos/${input.repository}/actions/artifacts/${input.artifactId}/zip`,
      { headers, redirect: "manual", signal },
    )
    for (
      let redirects = 0;
      response.status === 302 || response.status === 301 || response.status === 307 || response.status === 308;
      redirects++
    ) {
      const location = response.headers.get("location")
      await response.body?.cancel()
      if (!location || redirects >= 3) return undefined
      const url = new URL(location)
      if (
        url.protocol !== "https:" ||
        url.port ||
        url.username ||
        url.password ||
        url.hash ||
        !(
          /^[a-z0-9-]+\.blob\.core\.windows\.net$/i.test(url.hostname) ||
          /^[a-z0-9-]+\.actions\.githubusercontent\.com$/i.test(url.hostname)
        )
      )
        return undefined
      // Signed Azure/Actions URLs authorize themselves; the repository token is NEVER sent off the API origin.
      response = await input.request(url.href, {
        headers: { accept: "application/octet-stream" },
        redirect: "manual",
        signal,
      })
    }
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    const outer = await responseBytes(response, LIMIT + 65_536)
    const files = await unzipped(outer, new Map([[GithubAgents.SESSION_FILE, LIMIT]]), LIMIT + 65_536)
    return files.size === 1 ? files.get(GithubAgents.SESSION_FILE) : undefined
  } catch {
    return undefined
  }
}
