import { createHash } from "node:crypto"
import { parseWorkspaceSnapshot, snapshotDigest, type ExportWorkspaceSnapshot } from "./docker"

export class WorkspacePublishError extends Error {
  constructor(
    readonly code:
      | "invalid_publication"
      | "no_changes"
      | "github_unavailable"
      | "repository_access_denied"
      | "base_branch_changed"
      | "publication_conflict",
  ) {
    super(code)
    this.name = "WorkspacePublishError"
  }
}
export type PublishWorkspaceInput = {
  repository: string
  baseBranch: string
  baseCommit: string
  snapshot: ExportWorkspaceSnapshot
  token: string
  workspaceId: string
  title: string
  signal?: AbortSignal
}

/** Publishes only the reviewed immutable snapshot. The one-shot token never reaches an agent or container. */
export async function publishWorkspaceChanges(input: PublishWorkspaceInput, fetcher: typeof fetch = fetch) {
  validate(input)
  const snapshot = (() => {
    try {
      return parseWorkspaceSnapshot(input.snapshot, input.baseCommit)
    } catch {
      throw new WorkspacePublishError("invalid_publication")
    }
  })()
  if (snapshotDigest(snapshot) !== input.snapshot.digest) throw new WorkspacePublishError("invalid_publication")
  if (!snapshot.changes.length) throw new WorkspacePublishError("no_changes")
  const [owner, repository] = input.repository.split("/") as [string, string]
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
  const branch = `vector/${input.workspaceId}`
  const trailer = `\n\nVector-Workspace: ${input.workspaceId}\nVector-Snapshot: ${input.snapshot.digest}`
  const deadline = AbortSignal.timeout(120_000)
  const api = async (method: "GET" | "POST", path: string, body?: unknown, missing = false): Promise<unknown> => {
    input.signal?.throwIfAborted()
    const response = await fetcher(new URL(path, "https://api.github.com"), {
      method,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000), ...(input.signal ? [input.signal] : [])]),
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "Vector/cloud-workspaces",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(() => {
      throw new WorkspacePublishError("github_unavailable")
    })
    if (missing && response.status === 404) {
      await response.body?.cancel()
      return undefined
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new WorkspacePublishError(
        response.status === 401 || response.status === 403
          ? "repository_access_denied"
          : response.status === 409 || response.status === 422
            ? "publication_conflict"
            : "github_unavailable",
      )
    }
    return readJSON(response)
  }
  const access = await api("GET", prefix)
  if (
    !record(access) ||
    typeof access.full_name !== "string" ||
    access.full_name.toLowerCase() !== input.repository.toLowerCase() ||
    !record(access.permissions) ||
    access.permissions.push !== true
  )
    throw new WorkspacePublishError("repository_access_denied")
  const basePath = `${prefix}/git/ref/heads/${input.baseBranch.split("/").map(encodeURIComponent).join("/")}`
  const checkBase = async () => {
    const current = await api("GET", basePath)
    if (
      !record(current) ||
      !record(current.object) ||
      current.object.sha !== input.baseCommit ||
      current.object.type !== "commit"
    )
      throw new WorkspacePublishError("base_branch_changed")
  }
  await checkBase()
  const original = await api("GET", `${prefix}/git/commits/${input.baseCommit}`)
  if (!record(original) || original.sha !== input.baseCommit || !record(original.tree) || !sha(original.tree.sha))
    throw new WorkspacePublishError("github_unavailable")
  const tree: { path: string; mode: "100644" | "100755"; type: "blob"; sha: string | null }[] = []
  // Sequential uploads stay below the four-request concurrency ceiling and bound cancellation accounting.
  for (const change of snapshot.changes) {
    if (change.content === null) {
      tree.push({ path: change.path, mode: change.mode, type: "blob", sha: null })
      continue
    }
    const bytes = Buffer.from(change.content, "base64")
    const expected = createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
    const blob = await api("POST", `${prefix}/git/blobs`, { content: change.content, encoding: "base64" })
    if (!record(blob) || blob.sha !== expected) throw new WorkspacePublishError("github_unavailable")
    tree.push({ path: change.path, mode: change.mode, type: "blob", sha: expected })
  }
  const built = await api("POST", `${prefix}/git/trees`, { base_tree: original.tree.sha, tree })
  if (!record(built) || !sha(built.sha)) throw new WorkspacePublishError("github_unavailable")
  const branchPath = `${prefix}/git/ref/heads/${branch}`
  const existing = await api("GET", branchPath, undefined, true)
  let commit: string
  const verifyCommit = async (value: unknown) => {
    if (!record(value) || !record(value.object) || !sha(value.object.sha) || value.object.type !== "commit")
      throw new WorkspacePublishError("publication_conflict")
    const saved = await api("GET", `${prefix}/git/commits/${value.object.sha}`)
    if (
      !record(saved) ||
      !record(saved.tree) ||
      saved.tree.sha !== built.sha ||
      typeof saved.message !== "string" ||
      !saved.message.endsWith(trailer) ||
      !Array.isArray(saved.parents) ||
      saved.parents.length !== 1 ||
      !record(saved.parents[0]) ||
      saved.parents[0].sha !== input.baseCommit
    )
      throw new WorkspacePublishError("publication_conflict")
    return value.object.sha
  }
  if (existing !== undefined) commit = await verifyCommit(existing)
  else {
    const created = await api("POST", `${prefix}/git/commits`, {
      message: `Vector Cloud: ${input.title.trim()}${trailer}`,
      tree: built.sha,
      parents: [input.baseCommit],
    })
    if (!record(created) || !sha(created.sha)) throw new WorkspacePublishError("github_unavailable")
    commit = created.sha
    await checkBase()
    try {
      const reference = await api("POST", `${prefix}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit })
      if (
        !record(reference) ||
        reference.ref !== `refs/heads/${branch}` ||
        !record(reference.object) ||
        reference.object.sha !== commit
      )
        throw new WorkspacePublishError("github_unavailable")
    } catch (error) {
      // The request may have reached GitHub even if its reply did not reach the host.
      if (
        !(error instanceof WorkspacePublishError) ||
        !["publication_conflict", "github_unavailable"].includes(error.code)
      )
        throw error
      const observed = await api("GET", branchPath, undefined, true)
      if (observed === undefined) throw error
      commit = await verifyCommit(observed)
    }
  }
  await checkBase()
  const query = new URLSearchParams({
    state: "open",
    head: `${owner}:${branch}`,
    base: input.baseBranch,
    per_page: "100",
  })
  const findPull = async () => {
    const values = await api("GET", `${prefix}/pulls?${query}`)
    if (!Array.isArray(values) || values.length > 100) throw new WorkspacePublishError("github_unavailable")
    const matching = values.filter((value) => matchingPull(value, input.repository, branch, input.baseBranch, commit))
    if (matching.length > 1) throw new WorkspacePublishError("publication_conflict")
    if (record(matching[0]) && matching[0].draft !== true) throw new WorkspacePublishError("publication_conflict")
    return matching[0]
  }
  const saved = await findPull()
  await checkBase()
  const currentHead = await api("GET", branchPath)
  if (
    !record(currentHead) ||
    !record(currentHead.object) ||
    currentHead.object.type !== "commit" ||
    currentHead.object.sha !== commit
  )
    throw new WorkspacePublishError("publication_conflict")
  if (saved) return { url: pullURL(saved, input.repository), branch, commit }
  try {
    const pull = await api("POST", `${prefix}/pulls`, {
      title: input.title.trim(),
      head: branch,
      base: input.baseBranch,
      draft: true,
      body: `Changes reviewed in Vector Cloud workspace ${input.workspaceId}.\n\nSnapshot: \`${input.snapshot.digest}\`\nBase: \`${input.baseCommit}\`\n\nCreated as a draft for human review. No merge was performed.`,
    })
    if (!matchingPull(pull, input.repository, branch, input.baseBranch, commit) || !record(pull) || pull.draft !== true)
      throw new WorkspacePublishError("github_unavailable")
    return { url: pullURL(pull, input.repository), branch, commit }
  } catch (error) {
    if (
      !(error instanceof WorkspacePublishError) ||
      !["publication_conflict", "github_unavailable"].includes(error.code)
    )
      throw error
    const observed = await findPull()
    if (!observed) throw error
    return { url: pullURL(observed, input.repository), branch, commit }
  }
}

function validate(input: PublishWorkspaceInput) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repository) ||
    [".", ".."].includes(input.repository.split("/")[1]!) ||
    !/^[a-z0-9][a-z0-9_-]{7,63}$/.test(input.workspaceId) ||
    !sha(input.baseCommit) ||
    !input.title.trim() ||
    input.title.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(input.title) ||
    !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,179}$/.test(input.baseBranch) ||
    input.baseBranch.includes("..") ||
    input.baseBranch.includes("//") ||
    input.baseBranch.endsWith("/") ||
    input.baseBranch.endsWith(".") ||
    input.baseBranch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")) ||
    !/^[A-Za-z0-9_]{20,512}$/.test(input.token) ||
    !/^[a-f0-9]{64}$/.test(input.snapshot.digest)
  )
    throw new WorkspacePublishError("invalid_publication")
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value)
}
function matchingPull(value: unknown, repository: string, branch: string, baseBranch: string, commit: string) {
  return (
    record(value) &&
    record(value.head) &&
    value.head.ref === branch &&
    value.head.sha === commit &&
    record(value.head.repo) &&
    typeof value.head.repo.full_name === "string" &&
    value.head.repo.full_name.toLowerCase() === repository.toLowerCase() &&
    record(value.base) &&
    value.base.ref === baseBranch &&
    record(value.base.repo) &&
    typeof value.base.repo.full_name === "string" &&
    value.base.repo.full_name.toLowerCase() === repository.toLowerCase() &&
    value.state === "open"
  )
}
function pullURL(value: unknown, repository: string) {
  if (!record(value) || typeof value.html_url !== "string" || !URL.canParse(value.html_url))
    throw new WorkspacePublishError("github_unavailable")
  const url = new URL(value.html_url)
  const parts = url.pathname.split("/")
  if (
    url.origin !== "https://github.com" ||
    parts.length !== 5 ||
    `${parts[1]}/${parts[2]}`.toLowerCase() !== repository.toLowerCase() ||
    parts[3] !== "pull" ||
    !/^[1-9][0-9]*$/.test(parts[4]!) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new WorkspacePublishError("github_unavailable")
  return url.href
}
async function readJSON(response: Response): Promise<unknown> {
  if (!response.body) throw new WorkspacePublishError("github_unavailable")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > 1_048_576) {
        await reader.cancel()
        throw new WorkspacePublishError("github_unavailable")
      }
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new WorkspacePublishError("github_unavailable")
  } finally {
    reader.releaseLock()
  }
}
