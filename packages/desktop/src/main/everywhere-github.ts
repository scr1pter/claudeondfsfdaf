import { createHash } from "node:crypto"
import { LIMITS, decodeJob, type EverywhereJob } from "@vectordevai/schema/everywhere"
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

/** VE-21 supplies the owner's getGithubToken result. No token or fetched thread text goes to Vector's servers. */
export async function readEverywhereGithubThread(access: GithubAccess, input: EverywhereJob): Promise<FrameOptions> {
  const decoded = decodeJob(input)
  if (!decoded.ok || decoded.value.platform !== "github" || !decoded.value.github?.actorId || !decoded.value.github.event) throw new Error("The Github trigger cannot be verified")
  const job = decoded.value
  const reference = job.github!
  const repository = await githubJson<{ id: number; full_name: string }>(access, `/repositories/${job.repository.id}`)
  if (repository.id !== job.repository.id || repository.full_name.toLowerCase() !== job.repository.fullName.toLowerCase()) throw new Error("The Github repository changed")
  const base = `/repos/${job.repository.fullName}`
  const issue = await githubJson<unknown>(access, `${base}/issues/${reference.number}`)
  if (!record(issue) || issue.number !== reference.number || (reference.kind === "pr") !== record(issue.pull_request)) throw new Error("The Github thread changed")
  const trigger = reference.event === "issues" ? post(issue) : post(await githubJson<unknown>(access,
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
  const unedited = trigger.updated_at === trigger.created_at
  const sameBody = reference.bodySha256 !== undefined && createHash("sha256").update(trigger.body).digest("hex") === reference.bodySha256
  if (!unedited && !sameBody) throw new Error("The Github trigger changed")
  const rows = await githubJson<unknown>(access, `${base}/${reference.event === "pull_request_review_comment" ? "pulls" : "issues"}/${reference.number}/comments?per_page=30`)
  if (!Array.isArray(rows)) throw new Error("The Github thread is unavailable")
  const cache = new Map<string, Promise<"writer" | "untrusted">>()
  const label = (author: Author) => {
    if (author.type === "Bot" || !/^[A-Za-z0-9-]{1,39}$/.test(author.login)) return Promise.resolve("untrusted" as const)
    const key = `${author.id}:${author.login.toLowerCase()}`
    const found = cache.get(key)
    if (found) return found
    const permission = githubJson<{ permission?: string; user?: { id?: number; permissions?: { push?: boolean } } }>(access,
      `${base}/collaborators/${encodeURIComponent(author.login)}/permission`, { timeoutMs: 5_000 }).then((value): "writer" | "untrusted" =>
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
