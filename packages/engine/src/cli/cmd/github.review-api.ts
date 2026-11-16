// The GitHub side of a review job (section 3.12): REST through Octokit, and review threads through GraphQL. Reads and
// other idempotent requests retry on 5xx and on rate limits. A create is never sent twice blindly: after a 5xx or a
// network error the wrapper first looks for what it tried to create, because GitHub can fail a request it carried out.

import { Octokit } from "@octokit/rest"
import { setTimeout } from "node:timers/promises"
import type { GitHubPrFile } from "@vectordevai/core/review/diff"
import type { CreateReviewPayload } from "@vectordevai/core/review/github-payload"
import { parseReviewMarker } from "@vectordevai/core/review/state"
import type { Side } from "@vectordevai/core/review/types"
import { githubFetch } from "./github.shared"

export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none"
export const WRITE_PERMISSIONS: readonly Permission[] = ["admin", "maintain", "write"]

const MAX_ATTEMPTS = 3
const MAX_WAIT_MS = 60_000
const PER_PAGE = 100
const MAX_FILE_PAGES = 30 // listFiles stops at 3,000 files, as GitHub does
const MAX_LIST_PAGES = 30
const MAX_THREAD_PAGES = 20
const PERMISSIONS: Permission[] = ["admin", "maintain", "write", "triage", "read"]

export interface PullInfo {
  number: number
  title: string
  body: string
  state: string
  draft: boolean
  author: string
  labels: string[]
  head: { sha: string; ref: string; repo?: string } // repo is "owner/name"; absent when the fork was deleted
  base: { sha: string; ref: string; repo: string }
  fork: boolean
  url: string
}

export interface IssueComment {
  id: number
  body: string
  user: { login: string; type?: string }
  association?: string
  createdAt: string
  url?: string
  issue?: number
}

export interface ReviewComment {
  id: number
  body: string
  user: { login: string; type?: string }
  path: string
  line: number | null
  side?: Side
  inReplyTo?: number
}

export interface ThreadComment {
  id: number
  body: string
  author: string
  association?: string
  createdAt?: string
  reactions: { content: string; users: string[] }[]
}

export interface ThreadNode {
  id: string
  isResolved: boolean
  isOutdated: boolean
  resolvedBy?: string
  path: string
  line: number | null // GitHub's current line; null when the thread is outdated
  side?: Side
  comments: ThreadComment[] // the first one opened the thread
}

export interface ReactionTarget {
  id: number
  kind: "issue" | "review"
}

export interface ReviewGitHub {
  getPull(n: number): Promise<PullInfo>
  listFiles(n: number): Promise<GitHubPrFile[]>
  compare(
    base: string,
    head: string,
  ): Promise<{ status: "ahead" | "behind" | "diverged" | "identical"; mergeBase: string }>
  getContent(path: string, ref: string): Promise<string | undefined>
  listIssueComments(n: number): Promise<IssueComment[]>
  listRepoIssueCommentsSince(since: string, maxPages: number): Promise<IssueComment[]>
  listRepoReviewComments(maxPages: number): Promise<ReviewComment[]>
  reviewThreads(n: number): Promise<ThreadNode[]>
  listReviews(n: number): Promise<{ id: number; body: string }[]>
  listCommentsForReview(n: number, reviewId: number): Promise<{ id: number; body: string }[]>
  createReview(n: number, payload: CreateReviewPayload): Promise<{ id: number }>
  createIssueComment(n: number, body: string): Promise<{ id: number; html_url: string }>
  updateIssueComment(id: number, body: string): Promise<void>
  updateReviewComment(id: number, body: string): Promise<void>
  replyToReviewComment(n: number, commentId: number, body: string): Promise<void>
  resolveThread(threadId: string): Promise<boolean> // false when GitHub refuses it
  permissionOf(login: string): Promise<Permission> // cached; any error is "none"
  react(target: ReactionTarget, content: "eyes" | "+1" | "confused"): Promise<void>
  unreact(target: ReactionTarget, content: "eyes"): Promise<void>
}

export interface ReviewGitHubOptions {
  token: string
  owner: string
  repo: string
  botLogin: string
  baseUrl?: string // GITHUB_API_URL on GitHub Enterprise, or a test server
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  signal?: AbortSignal
  /** What sends each request; the agent phase passes its read-only fetch, which refuses every write before sending. */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /**
   * The posting check every write goes through first (section 6.4a), one post as one text: the parts to send, in the
   * order given. `untrusted` says the pull request comes from a fork, whose posted text may link and embed only on
   * GitHub. A check that cannot run throws, and nothing is posted. Required, so a new caller cannot post unchecked; a
   * test that means to skip it passes one that sends every part as it is.
   */
  check: (parts: readonly string[], pull: { readonly untrusted: boolean }) => Promise<readonly string[]>
}

// GraphQL reports a bot as "github-actions" where REST says "github-actions[bot]", so logins compare without it.
export function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
  const plain = (login: string | null | undefined) => (login ?? "").toLowerCase().replace(/\[bot\]$/, "")
  return plain(a) !== "" && plain(a) === plain(b)
}

export function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status
  return typeof status === "number" ? status : undefined
}

function headerOf(error: unknown, name: string): string | undefined {
  const headers = (error as { response?: { headers?: Record<string, unknown> } } | null | undefined)?.response?.headers
  const value = headers?.[name]
  return value === undefined || value === null ? undefined : String(value)
}

// How long to wait before sending a rate-limited request again, or undefined when it is not rate-limited or the wait
// would be over a minute.
function rateLimitWait(error: unknown): number | undefined {
  const status = statusOf(error)
  if (status !== 403 && status !== 429) return undefined
  const after = headerOf(error, "retry-after")
  if (after !== undefined && Number.isFinite(Number(after))) {
    const ms = Math.max(0, Number(after)) * 1000
    return ms <= MAX_WAIT_MS ? ms : undefined
  }
  if (headerOf(error, "x-ratelimit-remaining") === "0") {
    const reset = Number(headerOf(error, "x-ratelimit-reset")) * 1000 - Date.now()
    const ms = Number.isFinite(reset) ? Math.max(1000, reset) : MAX_WAIT_MS
    return ms <= MAX_WAIT_MS ? ms : undefined
  }
  return undefined
}

// Octokit reports a network failure as a 500 too.
function serverError(error: unknown): boolean {
  const status = statusOf(error)
  return status !== undefined && status >= 500
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), MAX_WAIT_MS)
}

// A proxy's 502 or 504 can arrive while GitHub is still creating a review with many comments, so a create waits this
// long before it looks for what it sent.
const GATEWAY_WAIT_MS = 8_000

function settleWait(error: unknown, attempt: number): number {
  const status = statusOf(error)
  return status === 502 || status === 504 ? GATEWAY_WAIT_MS : backoff(attempt)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface GraphActor {
  __typename?: string
  login?: string
}

interface GraphComment {
  // Review comment ids no longer fit GraphQL's 32-bit `databaseId`; `fullDatabaseId` is the same id as a BigInt string.
  fullDatabaseId?: string | number | null
  databaseId?: number | null
  body?: string
  createdAt?: string
  authorAssociation?: string
  author?: GraphActor | null
  reactionGroups?: { content: string; reactors?: { nodes?: (GraphActor | null)[] | null } | null }[] | null
}

interface GraphPage {
  hasNextPage: boolean
  endCursor: string | null
}

interface GraphCommentConnection {
  pageInfo?: GraphPage
  nodes?: (GraphComment | null)[] | null
}

interface ThreadsResponse {
  repository?: {
    pullRequest?: {
      reviewThreads?: { pageInfo?: GraphPage; nodes?: (GraphThread | null)[] | null } | null
    } | null
  } | null
}

interface GraphThread {
  id: string
  isResolved?: boolean
  isOutdated?: boolean
  path: string
  line?: number | null
  diffSide?: Side | null
  resolvedBy?: GraphActor | null
  comments?: GraphCommentConnection | null
}

// `idField` is fullDatabaseId, or databaseId on a GitHub Enterprise Server that lacks it. Asking for databaseId as well
// would fail the whole query once an id passes 2^31.
const commentFields = (idField: string) => `${idField} body createdAt authorAssociation
      author { __typename login }
      reactionGroups { content reactors(first: 20) { nodes { __typename ... on Actor { login } } } }`

const threadsQuery = (idField: string) => `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line diffSide
          resolvedBy { __typename login }
          comments(first: 50) { pageInfo { hasNextPage endCursor } nodes { ${commentFields(idField)} } }
        }
      }
    }
  }
}`

const threadCommentsQuery = (idField: string) => `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${commentFields(idField)} } }
    }
  }
}`

const RESOLVE_THREAD = `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`

function graphLogin(actor: GraphActor | null | undefined): string {
  const login = actor?.login ?? ""
  return actor?.__typename === "Bot" && login && !login.endsWith("[bot]") ? `${login}[bot]` : login
}

// A comment without a usable id is left out: under one shared placeholder id, Vector's comments would overwrite each
// other and every edit would go to a comment that does not exist.
function toThreadComment(node: GraphComment): ThreadComment | undefined {
  const id = Number(node.fullDatabaseId ?? node.databaseId)
  if (!Number.isSafeInteger(id) || id <= 0) return undefined
  return {
    id,
    body: node.body ?? "",
    author: graphLogin(node.author),
    ...(node.authorAssociation ? { association: node.authorAssociation } : {}),
    ...(node.createdAt ? { createdAt: node.createdAt } : {}),
    reactions: (node.reactionGroups ?? [])
      .map((group) => ({
        content: group.content,
        users: (group.reactors?.nodes ?? []).flatMap((actor) => (actor ? [graphLogin(actor)] : [])).filter(Boolean),
      }))
      .filter((group) => group.users.length > 0),
  }
}

type RawUser = { login?: string; type?: string } | null | undefined

function toUser(user: RawUser): { login: string; type?: string } {
  return { login: user?.login ?? "", ...(user?.type ? { type: user.type } : {}) }
}

function toIssueComment(comment: {
  id: number
  body?: string | null
  user?: RawUser
  author_association?: string
  created_at?: string
  html_url?: string
  issue_url?: string
}): IssueComment {
  const issue = Number(comment.issue_url?.split("/").pop())
  return {
    id: comment.id,
    body: comment.body ?? "",
    user: toUser(comment.user),
    ...(comment.author_association ? { association: comment.author_association } : {}),
    createdAt: comment.created_at ?? "",
    ...(comment.html_url ? { url: comment.html_url } : {}),
    ...(Number.isInteger(issue) && issue > 0 ? { issue } : {}),
  }
}

function toPermission(...values: (string | undefined)[]): Permission {
  for (const value of values) {
    const found = PERMISSIONS.find((entry) => entry === value)
    if (found) return found
  }
  return "none"
}

export function createReviewGitHub(options: ReviewGitHubOptions): ReviewGitHub {
  const { owner, repo, botLogin } = options
  const sleep = options.sleep ?? ((ms: number) => setTimeout(ms, undefined, { signal: options.signal }))
  const log = options.log ?? (() => {})
  const octokit = new Octokit({
    auth: options.token,
    userAgent: "vector-review",
    request: { signal: options.signal, fetch: options.fetch ?? githubFetch },
    ...(options.baseUrl ? { baseUrl: options.baseUrl.replace(/\/+$/, "") } : {}),
    // Expected 404s (a missing review.json) are handled here; Octokit would print each one.
    log: { debug: () => {}, info: () => {}, warn: (message: string) => log(`GitHub: ${message}`), error: () => {} },
  })
  // What this job created, so a lookup after a failed create never mistakes one of its own earlier posts for it.
  const created = new Set<number>()
  const permissions = new Map<string, Promise<Permission>>()

  const idempotent = async <T>(send: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      options.signal?.throwIfAborted()
      try {
        return await send()
      } catch (error) {
        options.signal?.throwIfAborted()
        const wait = rateLimitWait(error) ?? (serverError(error) ? backoff(attempt) : undefined)
        if (wait === undefined || attempt >= MAX_ATTEMPTS) throw error
        log(`GitHub answered ${statusOf(error)}; retrying in ${Math.ceil(wait / 1000)}s.`)
        await sleep(wait)
      }
    }
  }

  const create = async <T>(send: () => Promise<T>, find: () => Promise<T | undefined>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      options.signal?.throwIfAborted()
      try {
        return await send()
      } catch (error) {
        options.signal?.throwIfAborted()
        // A rate-limited request was not carried out, so it is safe to send again.
        const limited = rateLimitWait(error)
        if (limited !== undefined && attempt < MAX_ATTEMPTS) {
          log(`GitHub answered ${statusOf(error)}; retrying in ${Math.ceil(limited / 1000)}s.`)
          await sleep(limited)
          continue
        }
        if (!serverError(error)) throw error
        // Wait, then look, then send again only if nothing is there: GitHub may still be carrying the request out.
        await sleep(settleWait(error, attempt))
        const found = await find().catch(() => undefined)
        if (found !== undefined) {
          log(`GitHub answered ${statusOf(error)}, but the request went through.`)
          return found
        }
        if (attempt >= MAX_ATTEMPTS) throw error
      }
    }
  }

  let idField = "fullDatabaseId"
  const graph = async <T>(query: (field: string) => string, variables: Record<string, unknown>): Promise<T> => {
    try {
      return await idempotent(() => octokit.graphql<T>(query(idField), variables))
    } catch (error) {
      if (idField !== "fullDatabaseId" || !/fullDatabaseId/.test(messageOf(error))) throw error
      idField = "databaseId"
      return await idempotent(() => octokit.graphql<T>(query(idField), variables))
    }
  }

  const toComments = (connection: GraphCommentConnection | null | undefined) =>
    (connection?.nodes ?? []).flatMap((node) => {
      const comment = node ? toThreadComment(node) : undefined
      return comment ? [comment] : []
    })

  const pages = async <T>(max: number, fetchPage: (page: number) => Promise<T[]>): Promise<T[]> => {
    const out: T[] = []
    for (let page = 1; page <= max; page++) {
      const items = await idempotent(() => fetchPage(page))
      out.push(...items)
      if (items.length < PER_PAGE) break
    }
    return out
  }

  const threadComments = async (id: string, first: GraphCommentConnection | null | undefined) => {
    const comments = toComments(first)
    let page = first?.pageInfo
    for (let count = 0; page?.hasNextPage && count < MAX_THREAD_PAGES; count++) {
      const cursor = page.endCursor
      const next = await graph<{ node?: { comments?: GraphCommentConnection | null } | null }>(threadCommentsQuery, {
        id,
        cursor,
      })
      const connection = next.node?.comments
      comments.push(...toComments(connection))
      page = connection?.pageInfo
    }
    return comments
  }

  const api: ReviewGitHub = {
    async getPull(n) {
      const { data } = await idempotent(() => octokit.rest.pulls.get({ owner, repo, pull_number: n }))
      const head = data.head.repo?.full_name
      return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        state: data.state,
        draft: data.draft === true,
        author: data.user?.login ?? "",
        labels: data.labels.map((label) => label.name ?? "").filter(Boolean),
        head: { sha: data.head.sha, ref: data.head.ref, ...(head ? { repo: head } : {}) },
        base: { sha: data.base.sha, ref: data.base.ref, repo: data.base.repo.full_name },
        fork: !head || head.toLowerCase() !== data.base.repo.full_name.toLowerCase(),
        url: data.html_url,
      }
    },

    listFiles: (n) =>
      pages(MAX_FILE_PAGES, async (page) => {
        const { data } = await octokit.rest.pulls.listFiles({ owner, repo, pull_number: n, per_page: PER_PAGE, page })
        return data.map(
          (file): GitHubPrFile => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            ...(file.patch !== undefined ? { patch: file.patch } : {}),
            ...(file.previous_filename ? { previous_filename: file.previous_filename } : {}),
          }),
        )
      }),

    async compare(base, head) {
      const { data } = await idempotent(() =>
        octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${head}`, per_page: 1 }),
      )
      return { status: data.status, mergeBase: data.merge_base_commit.sha }
    },

    async getContent(path, ref) {
      try {
        const { data } = await idempotent(() => octokit.rest.repos.getContent({ owner, repo, path, ref }))
        if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return undefined
        if (data.encoding !== "base64") return undefined
        return Buffer.from(data.content, "base64").toString("utf8")
      } catch (error) {
        if (statusOf(error) === 404) return undefined
        throw error
      }
    },

    listIssueComments: (n) =>
      pages(MAX_LIST_PAGES, async (page) => {
        const { data } = await octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: n,
          per_page: PER_PAGE,
          page,
        })
        return data.map(toIssueComment)
      }),

    listRepoIssueCommentsSince: (since, maxPages) =>
      pages(maxPages, async (page) => {
        const { data } = await octokit.rest.issues.listCommentsForRepo({
          owner,
          repo,
          since,
          sort: "updated",
          direction: "desc",
          per_page: PER_PAGE,
          page,
        })
        return data.map(toIssueComment)
      }),

    listRepoReviewComments: (maxPages) =>
      pages(maxPages, async (page) => {
        const { data } = await octokit.rest.pulls.listReviewCommentsForRepo({
          owner,
          repo,
          sort: "updated",
          direction: "desc",
          per_page: PER_PAGE,
          page,
        })
        return data.map(
          (comment): ReviewComment => ({
            id: comment.id,
            body: comment.body ?? "",
            user: toUser(comment.user),
            path: comment.path,
            line: comment.line ?? null,
            ...(comment.side ? { side: comment.side } : {}),
            ...(comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {}),
          }),
        )
      }),

    async reviewThreads(n) {
      const threads: ThreadNode[] = []
      let cursor: string | null = null
      for (let count = 0; count < MAX_THREAD_PAGES; count++) {
        const after: string | null = cursor
        const data: ThreadsResponse = await graph<ThreadsResponse>(threadsQuery, {
          owner,
          repo,
          number: n,
          cursor: after,
        })
        const connection = data.repository?.pullRequest?.reviewThreads
        for (const node of connection?.nodes ?? []) {
          if (!node) continue
          const resolvedBy = graphLogin(node.resolvedBy)
          threads.push({
            id: node.id,
            isResolved: node.isResolved === true,
            isOutdated: node.isOutdated === true,
            ...(resolvedBy ? { resolvedBy } : {}),
            path: node.path,
            line: node.line ?? null,
            ...(node.diffSide ? { side: node.diffSide } : {}),
            comments: await threadComments(node.id, node.comments),
          })
        }
        if (!connection?.pageInfo?.hasNextPage) break
        cursor = connection.pageInfo.endCursor
      }
      return threads
    },

    listReviews: (n) =>
      pages(MAX_LIST_PAGES, async (page) => {
        const { data } = await octokit.rest.pulls.listReviews({ owner, repo, pull_number: n, per_page: PER_PAGE, page })
        return data.map((review) => ({ id: review.id, body: review.body ?? "" }))
      }),

    listCommentsForReview: (n, reviewId) =>
      pages(MAX_LIST_PAGES, async (page) => {
        const { data } = await octokit.rest.pulls.listCommentsForReview({
          owner,
          repo,
          pull_number: n,
          review_id: reviewId,
          per_page: PER_PAGE,
          page,
        })
        return data.map((comment) => ({ id: comment.id, body: comment.body ?? "" }))
      }),

    createReview: (n, payload) =>
      create(
        async () => {
          const { data } = await octokit.rest.pulls.createReview({ owner, repo, pull_number: n, ...payload })
          created.add(data.id)
          return { id: data.id }
        },
        // The review this run meant to post carries its marker, which names this run. Its comment bodies tell apart the
        // halves a split posted, but they can still be arriving, so a single review with the marker is enough.
        async () => {
          const marker = parseReviewMarker(payload.body)
          const want = payload.comments
            .map((comment) => comment.body.trim())
            .sort()
            .join("\n\0\n")
          const candidates = (await api.listReviews(n)).toReversed().filter((review) => {
            if (created.has(review.id) || review.body.trim() !== payload.body.trim()) return false
            const found = parseReviewMarker(review.body)
            return !marker || (found?.head === marker.head && found.run === marker.run)
          })
          for (const review of candidates) {
            const comments = await api.listCommentsForReview(n, review.id)
            const have = comments
              .map((comment) => comment.body.trim())
              .sort()
              .join("\n\0\n")
            if (have !== want) continue
            created.add(review.id)
            return { id: review.id }
          }
          const [only] = candidates
          if (!marker || candidates.length !== 1 || !only) return undefined
          created.add(only.id)
          return { id: only.id }
        },
      ),

    createIssueComment: (n, body) =>
      create(
        async () => {
          const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: n, body })
          created.add(data.id)
          return { id: data.id, html_url: data.html_url }
        },
        async () => {
          const found = (await api.listIssueComments(n))
            .toReversed()
            .find(
              (comment) =>
                !created.has(comment.id) &&
                sameLogin(comment.user.login, botLogin) &&
                comment.body.trim() === body.trim(),
            )
          if (!found) return undefined
          created.add(found.id)
          return { id: found.id, html_url: found.url ?? "" }
        },
      ),

    async updateIssueComment(id, body) {
      await idempotent(() => octokit.rest.issues.updateComment({ owner, repo, comment_id: id, body }))
    },

    async updateReviewComment(id, body) {
      await idempotent(() => octokit.rest.pulls.updateReviewComment({ owner, repo, comment_id: id, body }))
    },

    async replyToReviewComment(n, commentId, body) {
      await create(
        async () => {
          const { data } = await octokit.rest.pulls.createReplyForReviewComment({
            owner,
            repo,
            pull_number: n,
            comment_id: commentId,
            body,
          })
          created.add(data.id)
          return data.id
        },
        async () => {
          const comments = await pages(MAX_LIST_PAGES, async (page) => {
            const { data } = await octokit.rest.pulls.listReviewComments({
              owner,
              repo,
              pull_number: n,
              per_page: PER_PAGE,
              page,
            })
            return data
          })
          const found = comments
            .toReversed()
            .find(
              (comment) =>
                !created.has(comment.id) &&
                comment.in_reply_to_id === commentId &&
                sameLogin(comment.user?.login, botLogin) &&
                comment.body.trim() === body.trim(),
            )
          if (!found) return undefined
          created.add(found.id)
          return found.id
        },
      )
    },

    async resolveThread(threadId) {
      try {
        await idempotent(() => octokit.graphql(RESOLVE_THREAD, { id: threadId }))
        return true
      } catch (error) {
        log(`Could not resolve review thread ${threadId}: ${messageOf(error)}`)
        return false
      }
    },

    permissionOf(login) {
      const key = login.toLowerCase()
      const known = permissions.get(key)
      if (known) return known
      const found = idempotent(() =>
        octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: login }),
      )
        .then(({ data }) => toPermission(data.role_name, data.permission))
        .catch(() => "none" as const)
      permissions.set(key, found)
      return found
    },

    async react(target, content) {
      await idempotent(() =>
        target.kind === "issue"
          ? octokit.rest.reactions.createForIssueComment({ owner, repo, comment_id: target.id, content })
          : octokit.rest.reactions.createForPullRequestReviewComment({ owner, repo, comment_id: target.id, content }),
      )
    },

    async unreact(target, content) {
      const { data } = await idempotent(() =>
        target.kind === "issue"
          ? octokit.rest.reactions.listForIssueComment({ owner, repo, comment_id: target.id, content, per_page: 100 })
          : octokit.rest.reactions.listForPullRequestReviewComment({
              owner,
              repo,
              comment_id: target.id,
              content,
              per_page: 100,
            }),
      )
      for (const reaction of data.filter((entry) => sameLogin(entry.user?.login, botLogin))) {
        await idempotent(() =>
          target.kind === "issue"
            ? octokit.rest.reactions.deleteForIssueComment({
                owner,
                repo,
                comment_id: target.id,
                reaction_id: reaction.id,
              })
            : octokit.rest.reactions.deleteForPullRequestComment({
                owner,
                repo,
                comment_id: target.id,
                reaction_id: reaction.id,
              }),
        )
      }
    },
  }
  return checked(api, options.check)
}

// What a write sends, after the posting check: a review's body and its line comments as one text, a line comment that
// lost all its words left out, and each comment, update and reply on its own. Whether the pull request is a fork comes
// from GitHub as the job reads it; a write about one the job has not read, or an edit by comment id, counts as one
// from a fork unless every pull request read so far came from the repository itself.
function checked(api: ReviewGitHub, check: ReviewGitHubOptions["check"]): ReviewGitHub {
  const forks = new Map<number, boolean>()
  const untrusted = (n?: number) =>
    n !== undefined && forks.has(n) ? forks.get(n) === true : forks.size === 0 || [...forks.values()].some(Boolean)
  const one = async (body: string, n?: number) => (await check([body], { untrusted: untrusted(n) }))[0] ?? ""
  return {
    ...api,
    async getPull(n) {
      const pull = await api.getPull(n)
      forks.set(n, pull.fork)
      return pull
    },
    async createReview(n, payload) {
      const parts = await check([payload.body, ...payload.comments.map((comment) => comment.body)], {
        untrusted: untrusted(n),
      })
      return api.createReview(n, {
        ...payload,
        body: parts[0] ?? "",
        comments: payload.comments
          .map((comment, index) => ({ ...comment, body: parts[index + 1] ?? "" }))
          .filter((comment) => comment.body.trim()),
      })
    },
    createIssueComment: async (n, body) => api.createIssueComment(n, await one(body, n)),
    updateIssueComment: async (id, body) => api.updateIssueComment(id, await one(body)),
    updateReviewComment: async (id, body) => api.updateReviewComment(id, await one(body)),
    replyToReviewComment: async (n, commentId, body) => api.replyToReviewComment(n, commentId, await one(body, n)),
  }
}
