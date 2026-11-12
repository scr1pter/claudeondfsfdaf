import { createHash, randomUUID } from "node:crypto"
import { BrainUpload } from "@vectordevai/core/brain/upload"
import { RunProposalsCodec } from "@vectordevai/core/brain/run-proposals-codec"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { githubJson, type GithubAccess } from "./github-api"
import type { BrainPreview, ReturnedPreview } from "../../../app/src/features/github-agents/agents-model"
import type { ServerReadyData } from "../preload/types"

export type RepositoryContext = {
  authority: string
  access: GithubAccess
  info: { id: number; full_name: string; private: boolean; permissions?: { push?: boolean } }
}
export type BrainPorts = {
  context(cwd: string): Promise<RepositoryContext>
  vector(
    path: string,
    body: unknown,
    expectedAccount: string,
    scope: { cwd: string; authorityId: string },
  ): Promise<unknown>
  token(): Promise<string | undefined>
  engine(): Promise<ServerReadyData>
  fetch?: typeof fetch
  now?: () => number
}
type Selection = {
  cwd: string
  repositoryId: string
  account: string
  authority: string
  epoch: number
  publicRepository: boolean
  expiresAt: number
  bytes: Uint8Array
  sha256: string
  rid?: string
  artifactId?: string
}
const LIMIT = 512 * 1024
const LIFE = 5 * 60_000

/** This controller lives only in main. Renderers receive readable previews and opaque consent IDs, never keys or tokens. */
export function createGithubAgentsBrain(ports: BrainPorts) {
  const request = ports.fetch ?? fetch
  const now = ports.now ?? Date.now
  const selected = new Map<string, Selection>()
  const returned = new Map<string, Selection>()
  const active = new Set<Selection>()
  let currentAccount: string | undefined
  let epoch = 0
  function clear() {
    epoch++
    for (const item of [...selected.values(), ...returned.values(), ...active]) item.bytes.fill(0)
    selected.clear()
    returned.clear()
    currentAccount = undefined
  }
  function prune() {
    for (const cache of [selected, returned]) {
      for (const [id, item] of cache) {
        if (item.expiresAt > now()) continue
        item.bytes.fill(0)
        cache.delete(id)
      }
    }
    if (selected.size + returned.size >= 8) clear()
  }
  async function account() {
    const token = await ports.token()
    if (!token) {
      clear()
      throw new Error("Sign in to Vector before reviewing repository Brain attachments.")
    }
    const identity = createHash("sha256").update(token).digest("hex")
    if (currentAccount !== undefined && currentAccount !== identity) clear()
    currentAccount = identity
    return identity
  }
  async function check(cwd: string, owner: string, authority: string, expectedEpoch: number) {
    const [ctx, current] = await Promise.all([ports.context(cwd), account()])
    if (epoch !== expectedEpoch || owner !== current || ctx.authority !== authority || !ctx.info.permissions?.push)
      throw new Error("Your sign-in or repository authority changed. Review the attachment again.")
    return ctx
  }
  async function checkItem(item: Selection) {
    return check(item.cwd, item.account, item.authority, item.epoch)
  }
  async function local(cwd: string, path: string, body: unknown, fence: () => Promise<unknown>): Promise<unknown> {
    const engine = await ports.engine()
    await fence()
    const url = new URL(path, engine.url)
    url.searchParams.set("directory", cwd)
    const response = await request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(engine.password
          ? {
              authorization: `Basic ${Buffer.from(`${engine.username ?? "vector"}:${engine.password}`).toString("base64")}`,
            }
          : {}),
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error("Vector could not review this local Brain attachment.")
    const text = await response.text()
    if (Buffer.byteLength(text) > 1_500_000) throw new Error("The local Brain preview is too large.")
    await fence()
    return JSON.parse(text)
  }
  async function preview(cwd: string): Promise<BrainPreview> {
    prune()
    const expectedEpoch = epoch
    const [ctx, owner] = await Promise.all([ports.context(cwd), account()])
    const fence = () => check(cwd, owner, ctx.authority, expectedEpoch)
    const value = await local(
      cwd,
      "/experimental/brain/preview",
      {
        includeBrain: true,
        publicRepository: !ctx.info.private,
      },
      fence,
    )
    if (
      !record(value) ||
      value.path !== "brain/bundle.json" ||
      typeof value.base64url !== "string" ||
      value.base64url.length > 700_000 ||
      typeof value.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.sha256) ||
      !count(value.bytes, LIMIT) ||
      !count(value.entries, 200) ||
      !count(value.skills, 20)
    )
      throw new Error("Vector returned an invalid local Brain preview.")
    const bytes = BrainUpload.fromBase64url(value.base64url)
    if (bytes.byteLength !== value.bytes || digest(bytes) !== value.sha256)
      throw new Error("The local Brain preview changed. Review it again.")
    BrainUpload.validate(bytes, !ctx.info.private)
    await fence().catch((error: unknown) => {
      bytes.fill(0)
      throw error
    })
    const id = randomUUID()
    selected.set(id, {
      cwd,
      account: owner,
      authority: ctx.authority,
      epoch: expectedEpoch,
      publicRepository: !ctx.info.private,
      repositoryId: String(ctx.info.id),
      expiresAt: now() + LIFE,
      bytes,
      sha256: value.sha256,
    })
    return {
      id,
      repositoryId: String(ctx.info.id),
      publicRepository: !ctx.info.private,
      sha256: value.sha256,
      bytes: bytes.byteLength,
      entries: value.entries,
      skills: value.skills,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    }
  }
  async function take(
    cache: Map<string, Selection>,
    input: { previewId: string; approvedSha256: string },
    cwd?: string,
  ) {
    prune()
    const item = cache.get(input.previewId)
    if (!item || input.approvedSha256 !== item.sha256 || (cwd !== undefined && item.cwd !== cwd))
      throw new Error("Review and approve this exact attachment again before continuing.")
    cache.delete(input.previewId)
    const ctx = await checkItem(item).catch((error: unknown) => {
      item.bytes.fill(0)
      throw error
    })
    if (String(ctx.info.id) !== item.repositoryId || !ctx.info.private !== item.publicRepository) {
      item.bytes.fill(0)
      throw new Error("The repository or its visibility changed. Review the attachment again.")
    }
    active.add(item)
    return { item, ctx }
  }
  async function start(input: { cwd: string; prompt: string; previewId: string; approvedSha256: string }) {
    const { item, ctx } = await take(selected, input, input.cwd)
    try {
      BrainUpload.validate(item.bytes, !ctx.info.private)
      const brain = await BrainUpload.upload({
        repositoryId: item.repositoryId,
        selection: { bytes: item.bytes, sha256: item.sha256 },
        approvedSha256: input.approvedSha256,
        includeBrain: true,
        transport: async (kind, body) => {
          await checkItem(item)
          const response = await ports.vector(`/api/cloud-agents/brain-${kind}`, body, item.account, {
            cwd: item.cwd,
            authorityId: item.authority,
          })
          await checkItem(item)
          return response
        },
      })
      await checkItem(item)
      const result = await ports.vector(
        "/api/cloud-agents/desktop-run",
        {
          repositoryId: item.repositoryId,
          prompt: input.prompt,
          brain,
        },
        item.account,
        { cwd: item.cwd, authorityId: item.authority },
      )
      await checkItem(item)
      if (
        !record(result) ||
        result.ok !== true ||
        typeof result.dispatchedAt !== "number" ||
        !Number.isFinite(result.dispatchedAt)
      )
        throw new Error("Vector could not confirm the GitHub task. Check its Actions page before trying again.")
      return { dispatchedAt: result.dispatchedAt }
    } finally {
      active.delete(item)
      item.bytes.fill(0)
    }
  }
  async function artifacts(input: { cwd: string; rid: string }) {
    const expectedEpoch = epoch
    const [ctx, owner] = await Promise.all([ports.context(input.cwd), account()])
    const id = githubRun(input.rid, String(ctx.info.id))
    const body = await githubJson<{ artifacts?: unknown[] }>(
      ctx.access,
      `${repoPath(ctx)}/actions/runs/${id}/artifacts?per_page=100`,
    )
    await check(input.cwd, owner, ctx.authority, expectedEpoch)
    if (!Array.isArray(body.artifacts) || body.artifacts.length > 100)
      throw new Error("GitHub returned invalid run artifacts.")
    return body.artifacts.flatMap((value) => {
      if (
        !record(value) ||
        !decimal(value.id) ||
        typeof value.name !== "string" ||
        !value.name.startsWith("vector-session-") ||
        value.expired !== false ||
        !count(value.size_in_bytes, GithubAgents.PATCH_LIMITS.sessionBytes + 65_536) ||
        !record(value.workflow_run) ||
        decimal(value.workflow_run.id) !== id ||
        decimal(value.workflow_run.repository_id) !== String(ctx.info.id)
      )
        return []
      return [
        {
          artifactId: decimal(value.id)!,
          name: value.name,
          ...(typeof value.expires_at === "string" ? { expiresAt: value.expires_at } : {}),
        },
      ]
    })
  }
  async function previewReturned(input: { cwd: string; rid: string; artifactId: string }): Promise<ReturnedPreview> {
    prune()
    const expectedEpoch = epoch
    const [ctx, owner] = await Promise.all([ports.context(input.cwd), account()])
    const fence = () => check(input.cwd, owner, ctx.authority, expectedEpoch)
    githubRun(input.rid, String(ctx.info.id))
    if (!decimal(input.artifactId)) throw new Error("Choose a GitHub run artifact.")
    const key = await ports.vector(
      "/api/cloud-agents/owner-artifact-key",
      {
        rid: input.rid,
        artifactId: input.artifactId,
      },
      owner,
      { cwd: input.cwd, authorityId: ctx.authority },
    )
    if (
      !record(key) ||
      key.repositoryId !== String(ctx.info.id) ||
      key.rid !== input.rid ||
      key.artifactId !== input.artifactId ||
      typeof key.thread !== "string" ||
      !GithubAgents.THREAD_PATTERN.test(key.thread) ||
      typeof key.key !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(key.key) ||
      typeof key.keyId !== "string" ||
      !/^[0-9a-f]{16}$/.test(key.keyId) ||
      typeof key.publicRepository !== "boolean"
    )
      throw new Error("Vector could not authorize this run artifact.")
    await fence()
    const metadata = await githubJson<unknown>(ctx.access, `${repoPath(ctx)}/actions/artifacts/${input.artifactId}`)
    if (
      !record(metadata) ||
      decimal(metadata.id) !== input.artifactId ||
      metadata.name !== GithubAgents.sessionArtifact(key.thread) ||
      metadata.expired !== false ||
      !record(metadata.workflow_run) ||
      decimal(metadata.workflow_run.id) !== githubRun(input.rid, String(ctx.info.id)) ||
      decimal(metadata.workflow_run.repository_id) !== String(ctx.info.id)
    )
      throw new Error("The GitHub artifact identity changed.")
    const { downloadConversationArtifact, decryptConversation } = await import(
      "../../../engine/src/cli/cmd/github.session"
    )
    await fence()
    const ciphertext = await downloadConversationArtifact({
      repository: ctx.info.full_name,
      artifactId: input.artifactId,
      token: ctx.access.token,
      request,
      ...(ctx.access.apiUrl ? { baseUrl: ctx.access.apiUrl } : {}),
    })
    if (!ciphertext) throw new Error("The encrypted GitHub run artifact is unavailable.")
    const decoded = await decryptConversation({
      bytes: ciphertext,
      key: { key: key.key, keyId: key.keyId },
      expected: { repositoryId: String(ctx.info.id), thread: key.thread, rid: input.rid },
    })
    const descriptor = decoded?.manifest.files.find((file) => file.path === RunProposalsCodec.PATH)
    if (!decoded?.proposals || !descriptor || digest(decoded.proposals) !== descriptor.sha256)
      throw new Error("This run has no valid returned repository Brain proposals.")
    const current = await fence()
    const publicRepository = key.publicRepository || !current.info.private
    const file = RunProposalsCodec.parse({ path: RunProposalsCodec.PATH, bytes: decoded.proposals, publicRepository })
    const id = randomUUID()
    const bytes = Uint8Array.from(decoded.proposals)
    returned.set(id, {
      cwd: input.cwd,
      account: owner,
      authority: ctx.authority,
      epoch: expectedEpoch,
      publicRepository: !ctx.info.private,
      repositoryId: String(ctx.info.id),
      expiresAt: now() + LIFE,
      bytes,
      sha256: descriptor.sha256,
      rid: input.rid,
      artifactId: input.artifactId,
    })
    return {
      id,
      repositoryId: String(ctx.info.id),
      rid: input.rid,
      sha256: descriptor.sha256,
      bytes: bytes.byteLength,
      publicRepository,
      text: JSON.stringify(file, null, 2),
    }
  }
  async function importReturned(input: { previewId: string; approvedSha256: string }) {
    const { item, ctx } = await take(returned, input)
    try {
      // Re-read owner authority and current visibility at the separate Import click, after any settlement/rebind.
      const key = await ports.vector(
        "/api/cloud-agents/owner-artifact-key",
        {
          rid: item.rid,
          artifactId: item.artifactId,
        },
        item.account,
        { cwd: item.cwd, authorityId: item.authority },
      )
      if (
        !record(key) ||
        key.repositoryId !== item.repositoryId ||
        key.rid !== item.rid ||
        key.artifactId !== item.artifactId ||
        typeof key.publicRepository !== "boolean"
      )
        throw new Error("This returned attachment is no longer authorized.")
      const current = await checkItem(item)
      const publicRepository = key.publicRepository || !current.info.private
      RunProposalsCodec.parse({ path: RunProposalsCodec.PATH, bytes: item.bytes, publicRepository })
      const result = await local(
        item.cwd,
        "/experimental/brain/run-proposals/import",
        {
          path: RunProposalsCodec.PATH,
          base64url: BrainUpload.base64url(item.bytes),
          sha256: item.sha256,
          publicRepository,
        },
        () => checkItem(item),
      )
      if (
        !record(result) ||
        !count(result.proposed, 220) ||
        !count(result.known, 220) ||
        !count(result.refused, 220) ||
        !count(result.over, 220)
      )
        throw new Error("Vector returned invalid proposal import results.")
      return { proposed: result.proposed, known: result.known, refused: result.refused, over: result.over }
    } finally {
      active.delete(item)
      item.bytes.fill(0)
    }
  }
  return { preview, start, artifacts, previewReturned, importReturned, clear }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function count(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
}
function digest(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}
function decimal(value: unknown) {
  const id =
    typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : ""
  return /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)) ? id : undefined
}
function repoPath(ctx: RepositoryContext) {
  return `/repos/${ctx.info.full_name.split("/").map(encodeURIComponent).join("/")}`
}
function githubRun(rid: string, repositoryId: string) {
  const match = /^gh-([1-9]\d{0,19})-([1-9]\d{0,19})-([1-9]\d{0,19})-([1-9]\d{0,19})$/.exec(rid)
  if (!match || match[1] !== repositoryId) throw new Error("Choose a run from this repository.")
  return match[2]!
}
