import { createHash } from "node:crypto"
import { LIMITS, TIMING, decodeJob, type EverywhereJob } from "@vectordevai/schema/everywhere"
import type { FrameItem, FrameOptions } from "@vectordevai/core/everywhere/frame"
import { githubJson, type GithubAccess } from "./github-api"

type Author = { id: number; login: string; type?: string }
type Post = { id: number; body: string; user: Author; created_at: string; updated_at: string; issue_url?: string; pull_request_url?: string }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 }
function post(value: unknown): Post | undefined {
  if (!record(value) || !positive(value.id) || typeof value.body !== "string" || !record(value.user) || !positive(value.user.id) || typeof value.user.login !== "string" ||
    typeof value.created_at !== "string" || typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.created_at)) || !Number.isFinite(Date.parse(value.updated_at))) return undefined
  return value as Post
}

type ThreadReadAuthority = {
  readonly access: () => Promise<GithubAccess | undefined>
  readonly authorize: (job: EverywhereJob, signal: AbortSignal) => Promise<number>
  readonly signal: AbortSignal
  readonly now?: () => number
}

const ISSUE_KIND_QUERY = `query VectorEverywhereIssueKind($repository: ID!, $number: Int!) {
  node(id: $repository) {
    __typename
    ... on Repository {
      id
      nameWithOwner
      issue(number: $number) { number }
    }
  }
}`

async function verifyIssueKind(access: GithubAccess, job: EverywhereJob, nodeId: unknown, signal: AbortSignal) {
  const unavailable = () => new Error("The Github thread is not an issue in this repository")
  if (typeof nodeId !== "string" || nodeId.length > 200 || !/^\S+$/.test(nodeId)) throw unavailable()
  const number = job.github!.number
  signal.throwIfAborted()
  const result = await githubJson<unknown>(access, "/graphql", {
    method: "POST",
    body: { query: ISSUE_KIND_QUERY, variables: { repository: nodeId, number } },
    signal,
    redirect: "error",
  })
  if (!record(result) || (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length > 0)) ||
    !record(result.data) || !record(result.data.node)) throw unavailable()
  const node = result.data.node
  if (node.__typename !== "Repository" || node.id !== nodeId || typeof node.nameWithOwner !== "string" ||
    node.nameWithOwner.toLowerCase() !== job.repository.fullName.toLowerCase() ||
    !record(node.issue) || node.issue.number !== number) throw unavailable()
}

/** Desktop reads only the binder's authorized issue, using the same Vector GitHub credential throughout. */
export async function readAuthorizedGithubThread(input: EverywhereJob, authority: ThreadReadAuthority): Promise<FrameOptions> {
  const job = verifiedJob(input)
  const reference = job.github!
  if (!job.requester.self || reference.kind !== "issue" || reference.event === "pull_request_review_comment")
    throw new Error("The Github trigger cannot be verified")
  const now = authority.now ?? Date.now
  const remaining = Math.min(TIMING.offerWindowMs, job.lease.expiresAt - now(), job.limits.deadline - now())
  if (remaining <= 0) throw new Error("The Github lease expired")
  const signal = AbortSignal.any([authority.signal, AbortSignal.timeout(remaining)])
  const account = await authority.access()
  if (!account || account.source !== "vector" || !account.token) throw new Error("The bound Github account is unavailable")
  const access = { ...account }
  const user = await githubJson<unknown>(access, "/user", { signal, redirect: "error" })
  if (!record(user) || user.type !== "User" || user.id !== reference.actorId) throw new Error("The bound Github account changed")
  return readThread(access, job, { ...authority, signal, now })
}

function verifiedJob(input: EverywhereJob) {
  const decoded = decodeJob(input)
  if (!decoded.ok || decoded.value.platform !== "github" || !decoded.value.github?.actorId || !decoded.value.github.event) throw new Error("The Github trigger cannot be verified")
  return decoded.value
}

/** Thread validation over an already selected credential. No fetched text goes to Vector's servers. */
export async function readEverywhereGithubThread(access: GithubAccess, input: EverywhereJob): Promise<FrameOptions> {
  return readThread(access, verifiedJob(input))
}

async function readThread(access: GithubAccess, job: EverywhereJob, authority?: ThreadReadAuthority): Promise<FrameOptions> {
  const reference = job.github!
  let signal = authority?.signal
  const read = <T>(path: string, timeoutMs?: number) => {
    signal?.throwIfAborted()
    return githubJson<T>(access, path, { timeoutMs, ...(signal ? { signal, redirect: "error" } : {}) })
  }
  const repository = await read<{ id: number; full_name: string; node_id?: unknown; visibility?: unknown; private?: unknown }>(`/repositories/${job.repository.id}`)
  if (repository.id !== job.repository.id || repository.full_name.toLowerCase() !== job.repository.fullName.toLowerCase()) throw new Error("The Github repository changed")
  if (authority) {
    const visibility = repository.visibility
    if ((visibility !== "private" && visibility !== "internal" && visibility !== "public") ||
      repository.private !== (visibility !== "public") || job.repository.shared !== (visibility !== "private"))
      throw new Error("The Github repository visibility changed")
    // REST's issues endpoint also returns pull requests. Prove the native kind before reading either body.
    await verifyIssueKind(access, job, repository.node_id, authority.signal)
    const expiresAt = await authority.authorize(job, authority.signal)
    const current = await authority.access()
    if (current?.source !== "vector" || current.token !== access.token) throw new Error("The bound Github account changed")
    const remaining = expiresAt - (authority.now ?? Date.now)()
    if (!Number.isSafeInteger(remaining) || remaining <= 0 || remaining > TIMING.offerWindowMs) throw new Error("The Github lease expired")
    signal = AbortSignal.any([authority.signal, AbortSignal.timeout(remaining)])
  }
  const base = `/repos/${job.repository.fullName}`
  const issue = await read<unknown>(`${base}/issues/${reference.number}`)
  if (!record(issue) || issue.number !== reference.number || (reference.kind === "pr") !== record(issue.pull_request)) throw new Error("The Github thread changed")
  const trigger = reference.event === "issues" ? post(issue) : post(await read<unknown>(
    `${base}/${reference.event === "pull_request_review_comment" ? "pulls" : "issues"}/comments/${reference.commentId}`))
  if (!trigger || trigger.user.id !== reference.actorId || trigger.user.type === "Bot" ||
    (reference.commentId !== undefined && trigger.id !== reference.commentId) || !trigger.body.trim() || trigger.body.length > LIMITS.taskChars)
    throw new Error("The Github trigger changed")
  if (reference.event !== "issues") {
    const relation = reference.event === "pull_request_review_comment" ? trigger.pull_request_url : trigger.issue_url
    const target = reference.event === "pull_request_review_comment" ? "pulls" : "issues"
    let related = false
    try { related = typeof relation === "string" && new URL(relation).pathname.toLowerCase() === `${base}/${target}/${reference.number}`.toLowerCase() } catch {}
    if (!related) throw new Error("The Github trigger is on another thread")
  }
  // C8: an issue trigger is proved by its body hash alone (decodeJob requires it): labels, assignments and comments all
  // move an issue's updated_at. A comment trigger is unedited, or carries the hash of the body that triggered it.
  const sameBody = reference.bodySha256 !== undefined && createHash("sha256").update(trigger.body).digest("hex") === reference.bodySha256
  if (!sameBody && (reference.event === "issues" || trigger.updated_at !== trigger.created_at))
    throw new Error("The Github trigger changed")
  const rows = await read<unknown>(`${base}/${reference.event === "pull_request_review_comment" ? "pulls" : "issues"}/${reference.number}/comments?per_page=30`)
  if (!Array.isArray(rows)) throw new Error("The Github thread is unavailable")
  const cache = new Map<string, Promise<"writer" | "untrusted">>()
  const label = (author: Author) => {
    if (author.type === "Bot" || !/^[A-Za-z0-9-]{1,39}$/.test(author.login)) return Promise.resolve("untrusted" as const)
    const key = `${author.id}:${author.login.toLowerCase()}`
    const found = cache.get(key)
    if (found) return found
    const permission = read<{ permission?: string; user?: { id?: number; permissions?: { push?: boolean } } }>(
      `${base}/collaborators/${encodeURIComponent(author.login)}/permission`, 5_000).then((value): "writer" | "untrusted" =>
        value.user?.id === author.id && (["admin", "write", "maintain"].includes(value.permission ?? "") || value.user.permissions?.push === true) ? "writer" : "untrusted",
      () => "untrusted" as const)
    cache.set(key, permission)
    return permission
  }
  const context: FrameItem[] = []
  let remaining = LIMITS.contextChars
  const add = (from: FrameItem["from"], text: string) => {
    if (!remaining || context.length >= LIMITS.contextItems || !text) return
    const item = text.slice(0, Math.min(remaining, LIMITS.itemChars))
    context.push({ from, text: item })
    remaining -= item.length
  }
  if (typeof issue.title === "string") add("untrusted", issue.title)
  const original = post(issue)
  const posts = [...(reference.event === "issues" || !original ? [] : [original]), ...rows.map(post).filter((value): value is Post => value !== undefined && value.id !== trigger.id)]
  // Four bounded permission probes at a time; every unavailable/unknown grant stays untrusted.
  for (let offset = 0; offset < Math.min(posts.length, LIMITS.contextItems); offset += 4) {
    const group = posts.slice(offset, Math.min(offset + 4, LIMITS.contextItems))
    const labels = await Promise.all(group.map((item) => label(item.user)))
    for (let index = 0; index < group.length; index++) add(labels[index]!, group[index]!.body)
    if (!remaining || context.length >= LIMITS.contextItems) break
  }
  return { thread: { task: trigger.body, context } }
}
