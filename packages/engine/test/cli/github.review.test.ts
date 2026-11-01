// The review job end to end against a fake GitHub (section 11.4). A Bun.serve server answers the REST and GraphQL
// calls Octokit makes, and works out diffs, merge-bases and file contents from a real bare repository; every run gets
// a fresh depth-1 checkout, as actions/checkout makes one. Review.run is replaced by a reviewer that answers with fixed
// findings and selects them with core's own selectFindings, the way Review.run does.

import { $ } from "bun"
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, ManagedRuntime } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { buildAnchorIndex, fromGitHubFiles, parseUnifiedDiff, type GitHubPrFile } from "@vectordevai/core/review/diff"
import {
  noteCannotStart,
  noteCommitGone,
  noteMonthBudget,
  noteRebase,
  noteSuperseded,
} from "@vectordevai/core/review/format"
import { selectFindings } from "@vectordevai/core/review/select"
import { SUMMARY_MARKER, emptyState, parseFindingMarker, readState, stateMarker } from "@vectordevai/core/review/state"
import type { ModelFinding, ModelReport, ReviewCost, ReviewOutcome, ReviewState } from "@vectordevai/core/review/types"
import { createReviewGitHub } from "../../src/cli/cmd/github.review-api"
import { createReviewGit, executeReviewJob, type ReviewJobContext } from "../../src/cli/cmd/github.review"
import type { RouteComment } from "../../src/cli/cmd/github.route"
import { Git } from "../../src/git"
import type { ResolvedModel } from "../../src/review/model"
import { normalizeFindings, type RunInput } from "../../src/review/run"
import { tmpdir } from "../fixture/fixture"
import { cliIt, type CliFixture } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const OWNER = "o"
const REPO = "r"
const PR = 7
const BOT = "github-actions[bot]"
const NOW = Date.UTC(2026, 8, 14, 14, 2)
const TIMEOUT = 60_000

const MODEL = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4-5",
  context: 200_000,
  price: { input: 3, output: 15, cacheRead: 0.3 },
  costKind: "priced",
} as unknown as ResolvedModel

const COST: ReviewCost = {
  costUsd: 0.21,
  input: 17_200,
  output: 3_100,
  reasoning: 0,
  cacheRead: 31_000,
  cacheWrite: 0,
  kind: "priced",
  model: "anthropic/claude-sonnet-4-5",
}

const runtime = ManagedRuntime.make(LayerNode.compile(LayerNode.group([Git.node])))
const runGit = <A, E>(effect: Effect.Effect<A, E, Git.Service>) => runtime.runPromise(effect)
afterAll(() => runtime.dispose())

// ---------------------------------------------------------------------------------------------------------------
// The repository

const git = (cwd: string, ...args: string[]) =>
  $`git ${args}`
    .cwd(cwd)
    .quiet()
    .text()
    .then((text) => text.trim())

const lines = (count: number, name: string) =>
  Array.from({ length: count }, (_, index) => `export const ${name}${index + 1} = ${index + 1}`).join("\n") + "\n"

const edit = (text: string, edits: Record<number, string>) =>
  text
    .split("\n")
    .map((line, index) => edits[index + 1] ?? line)
    .join("\n")

const insert = (text: string, after: number, added: string[]) => {
  const all = text.split("\n")
  all.splice(after, 0, ...added)
  return all.join("\n")
}

const LIST = lines(40, "list")
const AUTH = lines(40, "auth")
const DB = lines(30, "db")
// Head lines of the pull request: list.ts 10 changed and 21–23 added, auth.ts 15 and db.ts 5 changed.
const FEATURE_LIST = insert(edit(LIST, { 10: "export const list10 = 100" }), 20, [
  "export function page(n: number) {",
  "  return n - 1",
  "}",
])
const FEATURE = {
  "src/list.ts": FEATURE_LIST,
  "src/auth.ts": edit(AUTH, { 15: "export const auth15 = token()" }),
  "src/db.ts": edit(DB, { 5: 'export const db5 = sql("SELECT * FROM t WHERE id = " + id)' }),
}
// A later push far from every finding.
const UNRELATED_LIST = edit(FEATURE_LIST, { 43: "export const list40 = 400" })

class Repo {
  private runners = 0
  constructor(
    readonly root: string,
    readonly author: string,
    readonly remote: string,
  ) {}

  static async create(root: string) {
    const remote = path.join(root, "remote.git")
    const author = path.join(root, "author")
    await fs.mkdir(author)
    await $`git init -q --bare ${remote}`.quiet()
    await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true")
    await git(author, "init", "-q", "-b", "main")
    const config = { "user.email": "test@example.com", "user.name": "Test", "commit.gpgsign": "false" }
    for (const [key, value] of Object.entries(config)) await git(author, "config", key, value)
    await git(author, "remote", "add", "origin", `file://${remote}`)
    return new Repo(root, author, remote)
  }

  git(...args: string[]) {
    return git(this.author, ...args)
  }

  async commit(message: string, files: Record<string, string>) {
    for (const [file, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(this.author, file)), { recursive: true })
      await Bun.write(path.join(this.author, file), text)
    }
    await this.git("add", "-A")
    await this.git("commit", "-q", "-m", message)
    return this.git("rev-parse", "HEAD")
  }

  // A checkout of one commit at depth 1 with no credentials, as the review job's actions/checkout step makes it.
  async runner(sha: string) {
    const dir = path.join(this.root, `runner-${++this.runners}`)
    await fs.mkdir(dir)
    await git(dir, "init", "-q")
    await git(dir, "remote", "add", "origin", `file://${this.remote}`)
    await git(dir, "fetch", "-q", "--depth=1", "origin", sha)
    await git(dir, "checkout", "-q", "--detach", "FETCH_HEAD")
    return dir
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The fake GitHub

type Json = Record<string, any>

interface FakeUser {
  login: string
  type: string
}

interface FakeIssueComment {
  id: number
  issue: number
  body: string
  user: FakeUser
  created_at: string
  updated_at: string
}

interface FakeReviewComment {
  id: number
  review_id: number
  body: string
  path: string
  line: number
  side: "RIGHT" | "LEFT"
  user: FakeUser
  in_reply_to_id?: number
}

interface FakeThread {
  id: string
  comments: number[]
  isResolved: boolean
  resolvedBy?: string
  path: string
  line: number | null
  side: "RIGHT" | "LEFT"
}

interface Fault {
  method: string
  path: RegExp
  status: number
  headers?: Record<string, string>
  after?: boolean // carry the request out, then fail it
  times: number
  body?: Json // the error body; `{ message: "fault <status>" }` by default
}

const BOT_USER: FakeUser = { login: BOT, type: "Bot" }
const REACTIONS: Record<string, string> = { "+1": "THUMBS_UP", "-1": "THUMBS_DOWN", eyes: "EYES", confused: "CONFUSED" }

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } })
}

function page<T>(items: T[], params: URLSearchParams) {
  const size = Number(params.get("per_page") ?? 30)
  const number = Number(params.get("page") ?? 1)
  return items.slice((number - 1) * size, number * size)
}

class FakeGitHub {
  requests: { method: string; path: string; body?: Json }[] = []
  issueComments: FakeIssueComment[] = []
  reviews: { id: number; body: string; commit_id: string }[] = []
  reviewComments: FakeReviewComment[] = []
  threads: FakeThread[] = []
  reactions: { id: number; kind: "issues" | "pulls"; subject: number; content: string; user: string }[] = []
  permissions: Record<string, string> = { alice: "write", bob: "maintain", carol: "read", mallory: "read" }
  faults: Fault[] = []
  rejected: { path: string; line: number }[] = []
  id = 1000 // the last id handed out; set it past 2^31 to test ids GraphQL's databaseId cannot hold
  private clock = 0
  private server?: ReturnType<typeof Bun.serve>
  url = ""

  constructor(
    readonly gitDir: string,
    readonly pull: {
      title: string
      body: string
      draft: boolean
      author: string
      labels: string[]
      head: { sha: string; ref: string; repo: string }
      base: { sha: string; ref: string }
    },
  ) {}

  start() {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.handle(request) })
    this.url = `http://127.0.0.1:${this.server.port}`
  }

  stop() {
    this.server?.stop(true)
  }

  // Requests that change something: REST writes and GraphQL mutations.
  get writes() {
    return this.requests.filter((request) =>
      request.path === "/graphql"
        ? String(request.body?.["query"]).trim().startsWith("mutation")
        : request.method !== "GET",
    )
  }

  stamp() {
    return new Date(NOW + ++this.clock * 1000).toISOString()
  }

  addIssueComment(issue: number, body: string, user: FakeUser, id = ++this.id) {
    const at = this.stamp()
    const comment = { id, issue, body, user, created_at: at, updated_at: at }
    this.issueComments.push(comment)
    return comment
  }

  react(kind: "issues" | "pulls", subject: number, content: string, user: string) {
    this.reactions.push({ id: ++this.id, kind, subject, content, user })
  }

  threadAt(file: string) {
    const thread = this.threads.find((entry) => entry.path === file)
    if (!thread) throw new Error(`no thread on ${file}`)
    return thread
  }

  rootComment(file: string) {
    const thread = this.threadAt(file)
    return this.reviewComments.find((comment) => comment.id === thread.comments[0])!
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const route = decodeURIComponent(url.pathname)
    const body = request.method === "GET" || request.method === "DELETE" ? undefined : ((await request.json()) as Json)
    this.requests.push({ method: request.method, path: route, ...(body ? { body } : {}) })
    const fault = this.faults.find(
      (entry) => entry.times > 0 && entry.method === request.method && entry.path.test(route),
    )
    if (fault && !fault.after) {
      fault.times--
      return json(fault.body ?? { message: `fault ${fault.status}` }, fault.status, fault.headers)
    }
    const response = await this.answer(request.method, route, url.searchParams, body ?? {})
    if (fault?.after) {
      fault.times--
      return json(fault.body ?? { message: `fault ${fault.status}` }, fault.status, fault.headers)
    }
    return response
  }

  private async answer(method: string, route: string, params: URLSearchParams, body: Json): Promise<Response> {
    if (route === "/graphql") return this.graphql(body)
    const prefix = `/repos/${OWNER}/${REPO}`
    if (!route.startsWith(prefix)) return json({ message: "Not Found" }, 404)
    const rest = route.slice(prefix.length)
    let match: RegExpMatchArray | null
    const is = (verb: string, pattern: RegExp) => method === verb && (match = rest.match(pattern)) !== null

    if (is("GET", /^\/pulls\/\d+$/)) return json(this.pullJson())
    if (is("GET", /^\/pulls\/\d+\/files$/)) return json(page(await this.filesAt(this.pull.head.sha), params))
    if (is("GET", /^\/compare\/(.+)\.\.\.(.+)$/)) return json(await this.compare(match![1]!, match![2]!))
    if (is("GET", /^\/contents\/(.+)$/)) return this.contents(match![1]!, params.get("ref") ?? "")
    if (is("GET", /^\/issues\/(\d+)\/comments$/))
      return json(
        page(
          this.issueComments
            .filter((comment) => comment.issue === Number(match![1]))
            .map((comment) => this.issueJson(comment)),
          params,
        ),
      )
    if (is("POST", /^\/issues\/(\d+)\/comments$/))
      return json(this.issueJson(this.addIssueComment(Number(match![1]), body["body"], BOT_USER)), 201)
    if (is("PATCH", /^\/issues\/comments\/(\d+)$/)) {
      const comment = this.issueComments.find((entry) => entry.id === Number(match![1]))
      if (!comment) return json({ message: "Not Found" }, 404)
      comment.body = body["body"]
      comment.updated_at = this.stamp()
      return json(this.issueJson(comment))
    }
    if (is("GET", /^\/issues\/comments$/)) {
      const since = params.get("since") ?? ""
      const recent = this.issueComments
        .filter((comment) => comment.updated_at >= since)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      return json(
        page(
          recent.map((comment) => this.issueJson(comment)),
          params,
        ),
      )
    }
    if (is("GET", /^\/pulls\/comments$/))
      return json(
        page(
          [...this.reviewComments].reverse().map((comment) => this.reviewCommentJson(comment)),
          params,
        ),
      )
    if (is("GET", /^\/pulls\/\d+\/comments$/))
      return json(
        page(
          this.reviewComments.map((comment) => this.reviewCommentJson(comment)),
          params,
        ),
      )
    if (is("GET", /^\/pulls\/\d+\/reviews$/))
      return json(
        page(
          this.reviews.map((review) => ({ ...review, user: BOT_USER })),
          params,
        ),
      )
    if (is("POST", /^\/pulls\/\d+\/reviews$/)) return this.createReview(body)
    if (is("GET", /^\/pulls\/\d+\/reviews\/(\d+)\/comments$/))
      return json(
        page(
          this.reviewComments
            .filter((comment) => comment.review_id === Number(match![1]))
            .map((comment) => this.reviewCommentJson(comment)),
          params,
        ),
      )
    if (is("PATCH", /^\/pulls\/comments\/(\d+)$/)) {
      const comment = this.reviewComments.find((entry) => entry.id === Number(match![1]))
      if (!comment) return json({ message: "Not Found" }, 404)
      comment.body = body["body"]
      return json(this.reviewCommentJson(comment))
    }
    if (is("POST", /^\/pulls\/\d+\/comments\/(\d+)\/replies$/)) {
      const root = this.reviewComments.find((entry) => entry.id === Number(match![1]))
      if (!root) return json({ message: "Not Found" }, 404)
      const reply = { ...root, id: ++this.id, body: body["body"], user: BOT_USER, in_reply_to_id: root.id }
      this.reviewComments.push(reply)
      this.threads.find((thread) => thread.comments[0] === root.id)?.comments.push(reply.id)
      return json(this.reviewCommentJson(reply), 201)
    }
    if (is("GET", /^\/collaborators\/([^/]+)\/permission$/)) {
      const role = this.permissions[match![1]!]
      if (!role) return json({ message: "Not Found" }, 404)
      return json({ permission: role === "maintain" ? "write" : role === "triage" ? "read" : role, role_name: role })
    }
    if (is("POST", /^\/(issues|pulls)\/comments\/(\d+)\/reactions$/)) {
      const reaction = {
        id: ++this.id,
        kind: match![1] as "issues" | "pulls",
        subject: Number(match![2]),
        content: body["content"],
        user: BOT,
      }
      this.reactions.push(reaction)
      return json({ id: reaction.id, content: reaction.content, user: BOT_USER }, 201)
    }
    if (is("GET", /^\/(issues|pulls)\/comments\/(\d+)\/reactions$/)) {
      const content = params.get("content")
      return json(
        this.reactions
          .filter((entry) => entry.kind === match![1] && entry.subject === Number(match![2]))
          .filter((entry) => !content || entry.content === content)
          .map((entry) => ({ id: entry.id, content: entry.content, user: { login: entry.user, type: "User" } })),
      )
    }
    if (is("DELETE", /^\/(issues|pulls)\/comments\/(\d+)\/reactions\/(\d+)$/)) {
      this.reactions = this.reactions.filter((entry) => entry.id !== Number(match![3]))
      return new Response(null, { status: 204 })
    }
    return json({ message: `Not handled: ${method} ${route}` }, 404)
  }

  private pullJson() {
    return {
      number: PR,
      title: this.pull.title,
      body: this.pull.body,
      state: "open",
      draft: this.pull.draft,
      user: { login: this.pull.author, type: "User" },
      labels: this.pull.labels.map((name) => ({ name })),
      head: { sha: this.pull.head.sha, ref: this.pull.head.ref, repo: { full_name: this.pull.head.repo } },
      base: { sha: this.pull.base.sha, ref: this.pull.base.ref, repo: { full_name: `${OWNER}/${REPO}` } },
      html_url: `https://github.com/${OWNER}/${REPO}/pull/${PR}`,
    }
  }

  private issueJson(comment: FakeIssueComment) {
    return {
      id: comment.id,
      body: comment.body,
      user: comment.user,
      author_association: comment.user.type === "Bot" ? "NONE" : "MEMBER",
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      html_url: `https://github.com/${OWNER}/${REPO}/pull/${comment.issue}#issuecomment-${comment.id}`,
      issue_url: `https://api.github.com/repos/${OWNER}/${REPO}/issues/${comment.issue}`,
    }
  }

  private reviewCommentJson(comment: FakeReviewComment) {
    return {
      id: comment.id,
      pull_request_review_id: comment.review_id,
      body: comment.body,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      user: comment.user,
      ...(comment.in_reply_to_id ? { in_reply_to_id: comment.in_reply_to_id } : {}),
    }
  }

  async filesAt(head: string): Promise<GitHubPrFile[]> {
    const mergeBase = await git(this.gitDir, "merge-base", this.pull.base.sha, head)
    const text =
      await $`git diff --no-color --no-ext-diff --find-renames --src-prefix=a/ --dst-prefix=b/ ${mergeBase} ${head}`
        .cwd(this.gitDir)
        .quiet()
        .text()
    return parseUnifiedDiff(text).map((file) => ({
      filename: file.path,
      status: file.status === "deleted" ? "removed" : file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
      ...(file.binary ? {} : { patch: file.patch }),
      ...(file.oldPath ? { previous_filename: file.oldPath } : {}),
    }))
  }

  private async compare(a: string, b: string) {
    const mergeBase = await git(this.gitDir, "merge-base", a, b).catch(() => "")
    const status = a === b ? "identical" : mergeBase === a ? "ahead" : mergeBase === b ? "behind" : "diverged"
    return { status, merge_base_commit: { sha: mergeBase }, ahead_by: 0, behind_by: 0, commits: [], files: [] }
  }

  private async contents(file: string, ref: string) {
    const text = await git(this.gitDir, "cat-file", "blob", `${ref}:${file}`).catch(() => undefined)
    if (text === undefined) return json({ message: "Not Found" }, 404)
    return json({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64"), path: file })
  }

  // GitHub checks every comment's line against the pull request's diff at commit_id.
  private async createReview(body: Json) {
    if (body["event"] !== "COMMENT") return json({ message: "Vector only comments" }, 422)
    const index = buildAnchorIndex(fromGitHubFiles(await this.filesAt(body["commit_id"])))
    const comments = body["comments"] as Json[]
    for (const comment of comments) {
      const entry = index.files.get(comment["path"])
      const lines = comment["side"] === "LEFT" ? entry?.left : entry?.right
      const refused = this.rejected.some((item) => item.path === comment["path"] && item.line === comment["line"])
      if (!lines?.has(comment["line"]) || refused)
        return json({ message: "Unprocessable Entity", errors: ["Line could not be resolved"] }, 422)
    }
    const review = { id: ++this.id, body: body["body"], commit_id: body["commit_id"] }
    this.reviews.push(review)
    for (const comment of comments) {
      const posted: FakeReviewComment = {
        id: ++this.id,
        review_id: review.id,
        body: comment["body"],
        path: comment["path"],
        line: comment["line"],
        side: comment["side"],
        user: BOT_USER,
      }
      this.reviewComments.push(posted)
      this.threads.push({
        id: `T_${posted.id}`,
        comments: [posted.id],
        isResolved: false,
        path: posted.path,
        line: posted.line,
        side: posted.side,
      })
    }
    return json({ ...review, user: BOT_USER })
  }

  private graphql(body: Json) {
    const query = String(body["query"])
    const variables = (body["variables"] ?? {}) as Json
    if (query.includes("resolveReviewThread")) {
      const thread = this.threads.find((entry) => entry.id === variables["id"])
      if (!thread) return json({ data: null, errors: [{ message: "Could not resolve to a node" }] })
      thread.isResolved = true
      thread.resolvedBy = BOT
      return json({ data: { resolveReviewThread: { thread: { id: thread.id, isResolved: true } } } })
    }
    if (query.includes("reviewThreads"))
      return json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: this.threads.map((thread) => this.threadNode(thread)),
              },
            },
          },
        },
      })
    return json({ data: null, errors: [{ message: "unknown query" }] })
  }

  private actor(login: string) {
    const bot = login.endsWith("[bot]")
    return { __typename: bot ? "Bot" : "User", login: login.replace(/\[bot\]$/, "") }
  }

  private threadNode(thread: FakeThread) {
    return {
      id: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.line === null,
      path: thread.path,
      line: thread.line,
      diffSide: thread.side,
      resolvedBy: thread.resolvedBy ? this.actor(thread.resolvedBy) : null,
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: thread.comments.map((id) => {
          const comment = this.reviewComments.find((entry) => entry.id === id)!
          const groups = new Map<string, string[]>()
          for (const reaction of this.reactions.filter((entry) => entry.kind === "pulls" && entry.subject === id)) {
            const content = REACTIONS[reaction.content] ?? reaction.content.toUpperCase()
            groups.set(content, [...(groups.get(content) ?? []), reaction.user])
          }
          // GitHub gives no 32-bit databaseId for newer, larger ids; fullDatabaseId is a BigInt string.
          return {
            databaseId: comment.id > 2 ** 31 - 1 ? null : comment.id,
            fullDatabaseId: String(comment.id),
            body: comment.body,
            createdAt: new Date(NOW).toISOString(),
            authorAssociation: comment.user.type === "Bot" ? "NONE" : "MEMBER",
            author: this.actor(comment.user.login),
            reactionGroups: [...groups].map(([content, users]) => ({
              content,
              reactors: { nodes: users.map((user) => this.actor(user)) },
            })),
          }
        }),
      },
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A world: the repository, the fake GitHub and a pull request from `feature` into `main`

interface World {
  repo: Repo
  fake: FakeGitHub
  base: string
  head: string
  [Symbol.asyncDispose](): Promise<void>
}

async function world(options: { fork?: boolean; baseFiles?: Record<string, string> } = {}): Promise<World> {
  const tmp = await tmpdir()
  const repo = await Repo.create(tmp.path)
  const base = await repo.commit("base", {
    "src/list.ts": LIST,
    "src/auth.ts": AUTH,
    "src/db.ts": DB,
    ...options.baseFiles,
  })
  await repo.git("checkout", "-q", "-b", "feature")
  const head = await repo.commit("feature", FEATURE)
  await repo.git("push", "-q", "-f", "origin", "main", options.fork ? `${head}:refs/pull/${PR}/head` : "feature")
  const fake = new FakeGitHub(repo.remote, {
    title: "Pagination for lists",
    body: "Adds page().",
    draft: false,
    author: "carol",
    labels: [],
    head: { sha: head, ref: "feature", repo: options.fork ? "mallory/r" : `${OWNER}/${REPO}` },
    base: { sha: base, ref: "main" },
  })
  fake.start()
  return {
    repo,
    fake,
    base,
    head,
    async [Symbol.asyncDispose]() {
      fake.stop()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

// Pushes a new head to `feature` and points the pull request at it.
async function push(w: World, files: Record<string, string>) {
  const sha = await w.repo.commit("push", files)
  await w.repo.git("push", "-q", "-f", "origin", "feature")
  w.fake.pull.head.sha = sha
  return sha
}

interface ReviewerOptions {
  findings?: (input: RunInput) => ModelFinding[]
  priorStatus?: (input: RunInput) => ModelReport["priorStatus"]
  summary?: string
  partial?: ReviewOutcome["partial"]
  unreviewed?: string[]
  failed?: string
  verified?: string[] // titles the verify pass confirmed
  during?: (input: RunInput) => Promise<void>
}

function reviewer(options: ReviewerOptions = {}) {
  const calls: RunInput[] = []
  const run = async (input: RunInput): Promise<ReviewOutcome> => {
    calls.push(input)
    await input.onCheckpoint?.(COST)
    await options.during?.(input)
    const report: ModelReport = {
      summary: options.summary ?? "Adds page() to the list helpers.",
      risk: "medium",
      files: input.files.map((file) => ({ path: file.path, note: "Changed" })),
      findings: options.failed ? [] : (options.findings?.(input) ?? []),
      ...(options.priorStatus ? { priorStatus: options.priorStatus(input) } : {}),
    }
    const findings = normalizeFindings(report.findings, "review", input.anchors).map((finding) =>
      options.verified?.includes(finding.title) ? { ...finding, verified: true } : finding,
    )
    const selection = selectFindings({
      findings,
      anchors: input.anchors,
      head: input.head,
      trust: input.trust,
      mode: input.mode,
      config: input.config,
      prior: input.prior,
      ...(input.focus ? { focus: input.focus } : {}),
      inlinePosted: input.inlinePosted ?? 0,
      knownPath: () => true,
      modelRisk: report.risk,
    })
    return {
      report,
      selection,
      skipped: input.skipped,
      cost: COST,
      durationMs: 90_000,
      base: input.base,
      head: input.head,
      ...(input.since ? { since: input.since } : {}),
      mode: input.mode,
      ...(options.partial ? { partial: options.partial } : {}),
      unreviewed: options.unreviewed ?? [],
      specialists: [
        options.failed
          ? { name: "review", status: "failed", steps: 1, detail: options.failed }
          : { name: "review", status: "ok", steps: 3 },
      ],
      sessions: ["ses_review"],
      stats: {
        files: input.files.length,
        additions: input.files.reduce((sum, file) => sum + file.additions, 0),
        deletions: input.files.reduce((sum, file) => sum + file.deletions, 0),
      },
      notes: [],
    }
  }
  return { run, calls }
}

let nonce = 0

async function job(
  w: World,
  review: ReturnType<typeof reviewer>,
  options: {
    runner?: string
    trigger?: "auto" | "command"
    full?: boolean
    comment?: RouteComment
    env?: Record<string, string>
    dryRun?: boolean
    expectedHead?: string
    botLogin?: string
    resolveModel?: () => Promise<ResolvedModel>
  } = {},
) {
  const runner = options.runner ?? (await w.repo.runner(w.fake.pull.head.sha))
  const log: string[] = []
  const waits: number[] = []
  const context: ReviewJobContext = {
    owner: OWNER,
    repo: REPO,
    pr: PR,
    trigger: options.trigger ?? "auto",
    full: options.full ?? false,
    ...(options.comment ? { comment: options.comment } : {}),
    ...(options.expectedHead ? { expectedHead: options.expectedHead } : {}),
    directory: runner,
    botLogin: options.botLogin ?? BOT,
    runUrl: `https://github.com/${OWNER}/${REPO}/actions/runs/1`,
    env: { ...options.env },
  }
  const result = await executeReviewJob(context, {
    gh: createReviewGitHub({
      token: "test-token-placeholder",
      owner: OWNER,
      repo: REPO,
      botLogin: options.botLogin ?? BOT,
      baseUrl: w.fake.url,
      sleep: async (ms) => {
        waits.push(ms)
      },
      log: (line) => log.push(line),
      // GitHub Actions has no brain to check against; these tests are about what the job posts and where.
      check: async (parts) => parts,
    }),
    git: createReviewGit({ directory: runner, run: runGit }),
    runReview: review.run,
    resolveModel: options.resolveModel ?? (async () => MODEL),
    log: (line) => log.push(line),
    now: () => NOW,
    nonce: () => `run${++nonce}`,
    ...(options.dryRun ? { dryRun: true } : {}),
  })
  return { result, log, waits, runner }
}

function sticky(w: World) {
  return w.fake.issueComments
    .filter((comment) => comment.issue === PR && comment.user.login === BOT && comment.body.includes(SUMMARY_MARKER))
    .sort((a, b) => a.id - b.id)[0]
}

function state(w: World): ReviewState | undefined {
  const found = sticky(w)
  return found ? readState(found.body) : undefined
}

function posts(w: World, pattern: RegExp) {
  return w.fake.requests.filter((request) => request.method === "POST" && pattern.test(request.path))
}

const short = (sha: string) => sha.slice(0, 7)

// Findings on the pull request's changed lines.
const OFF_BY_ONE: ModelFinding = {
  path: "src/list.ts",
  line: 22,
  severity: "blocking",
  category: "bug",
  title: "Off-by-one in page",
  body: "`page(1)` returns 0, so the first page is empty.",
  suggestion: "  return n",
  confidence: 0.9,
}
const TOKEN_AT_IMPORT: ModelFinding = {
  path: "src/auth.ts",
  line: 15,
  severity: "concern",
  category: "reliability",
  title: "token() can throw at import time",
  body: "A missing token makes the whole module fail to load.",
  confidence: 0.8,
}
const SQL: ModelFinding = {
  path: "src/db.ts",
  line: 5,
  severity: "blocking",
  category: "security",
  title: "SQL built by concatenation",
  body: "`id` goes into the query unescaped.",
  confidence: 0.95,
}

// ---------------------------------------------------------------------------------------------------------------

describe("vector github review against a fake GitHub", () => {
  test(
    "App identity reuses the prior Actions-bot review state without duplicate findings",
    async () => {
      await using w = await world()
      const first = reviewer({ findings: () => [OFF_BY_ONE] })
      await job(w, first)
      const previous = sticky(w)!
      const review = reviewer({ findings: () => [OFF_BY_ONE] })
      const result = await job(w, review, { botLogin: "fixture-vector[bot]" })
      expect(result.result.exitCode).toBe(0)
      expect(review.calls).toHaveLength(0)
      expect(posts(w, /\/issues\/7\/comments$/)).toHaveLength(1)
      expect(posts(w, /\/pulls\/7\/reviews$/)).toHaveLength(1)
      expect(sticky(w)?.id).toBe(previous.id)
      expect(state(w)).toMatchObject({ head: w.head, reviews: 1, inlinePosted: 1, costUsd: COST.costUsd })
    },
    TIMEOUT,
  )

  test(
    "1. opened: the summary starts as Reviewing, then one review with a committable suggestion, then state",
    async () => {
      await using w = await world()
      const review = reviewer({ findings: () => [OFF_BY_ONE, TOKEN_AT_IMPORT] })
      const { result } = await job(w, review)
      expect(result.exitCode).toBe(0)

      const created = posts(w, /\/issues\/7\/comments$/)
      expect(created).toHaveLength(1)
      expect(created[0]?.body?.["body"]).toStartWith(`## Vectorscope review · Reviewing \`${short(w.head)}\`…`)
      const reviews = posts(w, /\/pulls\/7\/reviews$/)
      expect(reviews).toHaveLength(1)
      expect(w.fake.requests.indexOf(created[0]!)).toBeLessThan(w.fake.requests.indexOf(reviews[0]!))

      const summary = sticky(w)!
      const payload = reviews[0]!.body!
      expect(payload["commit_id"]).toBe(w.head)
      expect(payload["event"]).toBe("COMMENT")
      expect(payload["body"]).toBe(
        `Vectorscope review of \`${short(w.head)}\`: 1 blocking issue and 1 concern on the changed lines. [Summary](https://github.com/o/r/pull/7#issuecomment-${summary.id})\n<!-- vector-review:review head=${short(w.head)} run=run${nonce} -->`,
      )
      const comments = payload["comments"] as Json[]
      expect(
        comments.map((comment) => ({ path: comment["path"], line: comment["line"], side: comment["side"] })),
      ).toEqual([
        { path: "src/list.ts", line: 22, side: "RIGHT" },
        { path: "src/auth.ts", line: 15, side: "RIGHT" },
      ])
      expect(comments[0]?.["body"]).toStartWith("**Blocking** · Off-by-one in page")
      expect(comments[0]?.["body"]).toContain("```suggestion\n  return n\n```")
      expect(comments[0]?.["body"]).toContain("reply `/vector fix` to have Vector apply this")
      expect(parseFindingMarker(comments[0]?.["body"])).toMatchObject({
        severity: "blocking",
        category: "bug",
        sha: short(w.head),
        status: "open",
      })
      expect(comments[1]?.["body"]).not.toContain("```suggestion")
      expect(Object.keys(payload).sort()).toEqual(["body", "comments", "commit_id", "event"])

      expect(summary.body).toContain("## Vectorscope review · Risk: High")
      expect(summary.body).toContain("**1 blocking · 1 concern** on the changed lines")
      expect(state(w)).toMatchObject({ head: w.head, base: w.base, reviews: 1, inlinePosted: 2, costUsd: 0.21 })
      expect(state(w)?.inflight).toBeUndefined()
      expect(review.calls[0]).toMatchObject({ trust: "trusted", mode: "full", head: w.head, base: w.base })
    },
    TIMEOUT,
  )

  test(
    "2. synchronize: the fix is edited and resolved, only the new finding is posted, and nothing twice",
    async () => {
      await using w = await world()
      await job(w, reviewer({ findings: () => [OFF_BY_ONE, TOKEN_AT_IMPORT] }))
      const first = w.fake.rootComment("src/list.ts")
      const fixedList = insert(edit(FEATURE_LIST, { 22: "  return n" }), 33, ["export const extra = list31 / 0"])
      const h2 = await push(w, { "src/list.ts": fixedList })
      // GitHub marks the thread outdated: its line was replaced.
      w.fake.threadAt("src/list.ts").line = null

      const review = reviewer({
        findings: () => [
          { ...TOKEN_AT_IMPORT, line: 16, title: "token() may throw when the module loads" },
          {
            path: "src/list.ts",
            line: 34,
            severity: "concern",
            category: "bug",
            title: "Division by zero in extra",
            body: "`list31 / 0` is Infinity.",
            confidence: 0.85,
          },
        ],
        priorStatus: (input) =>
          input.prior
            .filter((prior) => prior.path === "src/list.ts")
            .map((prior) => ({ id: prior.id, status: "fixed" as const, reason: "The subtraction is gone." })),
      })
      const { result } = await job(w, review)
      expect(result.exitCode).toBe(0)
      expect(review.calls[0]).toMatchObject({ mode: "incremental", since: w.head, head: h2 })

      const edited = w.fake.reviewComments.find((comment) => comment.id === first.id)!
      expect(edited.body.split("\n")[0]).toBe(`**Fixed in \`${short(h2)}\`.** ~~Off-by-one in page~~`)
      expect(edited.body).not.toContain("```suggestion")
      expect(edited.body).toContain("<details><summary>Original suggestion</summary>")
      expect(parseFindingMarker(edited.body)).toMatchObject({ status: "fixed", fixedIn: short(h2) })
      expect(w.fake.threadAt("src/list.ts").isResolved).toBe(true)

      const reviews = posts(w, /\/pulls\/7\/reviews$/)
      expect(reviews).toHaveLength(2)
      const second = reviews[1]!.body!["comments"] as Json[]
      expect(second.map((comment) => [comment["path"], comment["line"]])).toEqual([["src/list.ts", 34]])
      const ids = w.fake.reviewComments.map((comment) => parseFindingMarker(comment.body)?.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(sticky(w)!.body).toContain(
        `**Since last review** (\`${short(w.head)}\` → \`${short(h2)}\`): 1 fixed · 1 still open · 1 new`,
      )
      expect(state(w)).toMatchObject({ head: h2, reviews: 2, inlinePosted: 3 })
    },
    TIMEOUT,
  )

  test(
    "a re-review after the lines moved does not post again a place the open comment already names",
    async () => {
      await using w = await world()
      const write = "export const saved = store.write(next)"
      const twice = insert(insert(FEATURE_LIST, 30, [write]), 5, [write])
      await push(w, { "src/list.ts": twice })
      const repeated = (first: number, second: number): ModelFinding[] => [
        { ...OFF_BY_ONE, line: first, title: "Store write is not awaited", suggestion: undefined, confidence: 0.95 },
        { ...OFF_BY_ONE, line: second, title: "Store write never awaited", suggestion: undefined, confidence: 0.85 },
      ]
      await job(w, reviewer({ findings: () => repeated(6, 32) }))
      const posted = w.fake.rootComment("src/list.ts")
      expect([posted.line, posted.body]).toEqual([6, expect.stringContaining("The same problem is also at line 32.")])

      // Five lines added at the top move both places; GitHub moves the thread with them.
      await push(w, { "src/list.ts": insert(twice, 0, ["// a", "// b", "// c", "// d", "// e"]) })
      w.fake.threadAt("src/list.ts").line = 11
      const again = reviewer({ findings: () => repeated(11, 37) })
      const { result } = await job(w, again)
      expect(result.exitCode).toBe(0)
      expect(again.calls[0]?.prior.find((entry) => entry.id === parseFindingMarker(posted.body)?.id)?.also).toEqual([37])
      expect(posts(w, /\/pulls\/7\/reviews$/)).toHaveLength(1)
      expect(w.fake.reviewComments).toHaveLength(1)
    },
    TIMEOUT,
  )

  test(
    "3. one bad anchor out of four: the halves are posted, the refused comment moves to the summary",
    async () => {
      await using w = await world()
      w.fake.rejected.push({ path: "src/auth.ts", line: 15 })
      const concern = (finding: Partial<ModelFinding>) => ({
        ...TOKEN_AT_IMPORT,
        ...finding,
        severity: "concern" as const,
      })
      const review = reviewer({
        findings: () => [
          concern({
            path: "src/list.ts",
            line: 10,
            category: "bug",
            title: "list10 changes its value",
            confidence: 0.95,
          }),
          concern({
            path: "src/list.ts",
            line: 22,
            category: "bug",
            title: "page returns the wrong index",
            confidence: 0.9,
          }),
          concern({ confidence: 0.85 }),
          concern({ path: "src/db.ts", line: 5, category: "bug", title: "db5 ignores errors", confidence: 0.8 }),
        ],
      })
      const { result } = await job(w, review)
      expect(result.exitCode).toBe(0)
      expect(result.posted.reviewIds).toHaveLength(2)
      expect(w.fake.reviews.map((entry) => entry.body.split("\n")[0])).toEqual([
        `Vectorscope review of \`${short(w.head)}\`: 4 concerns on the changed lines. [Summary](https://github.com/o/r/pull/7#issuecomment-${sticky(w)!.id})`,
        `Vectorscope review of \`${short(w.head)}\` (continued).`,
      ])
      expect(w.fake.reviewComments.map((comment) => `${comment.path}:${comment.line}`).sort()).toEqual([
        "src/db.ts:5",
        "src/list.ts:10",
        "src/list.ts:22",
      ])
      const body = sticky(w)!.body
      expect(body).toContain(
        "Vector could not attach 1 comment to lines; it is listed under Outside the changed lines.",
      )
      expect(body).toContain("<details><summary>Outside the changed lines (1)</summary>")
      expect(body).toContain("`src/auth.ts:15`")
      expect(state(w)).toMatchObject({ inlinePosted: 3 })
      expect(state(w)?.findings.map((finding) => `${finding.path}:${finding.line}`)).toEqual(["src/auth.ts:15"])
    },
    TIMEOUT,
  )

  test(
    "4. a 502 after GitHub created the review: the marker is found and no second review is posted",
    async () => {
      await using w = await world()
      w.fake.faults.push({ method: "POST", path: /\/pulls\/7\/reviews$/, status: 502, after: true, times: 1 })
      const { result, log, waits } = await job(w, reviewer({ findings: () => [OFF_BY_ONE, TOKEN_AT_IMPORT] }))
      expect(result.exitCode).toBe(0)
      // A gateway error waits before it looks, since GitHub may still be creating the review.
      expect(waits).toContain(8_000)
      expect(posts(w, /\/pulls\/7\/reviews$/)).toHaveLength(1)
      expect(w.fake.reviews).toHaveLength(1)
      expect(w.fake.reviewComments).toHaveLength(2)
      expect(result.posted.reviewIds).toEqual([w.fake.reviews[0]!.id])
      expect(log.some((line) => line.includes("but the request went through"))).toBe(true)
      expect(state(w)).toMatchObject({ inlinePosted: 2 })
    },
    TIMEOUT,
  )

  test(
    "5. a 502 after GitHub created the summary: no second summary",
    async () => {
      await using w = await world()
      w.fake.faults.push({ method: "POST", path: /\/issues\/7\/comments$/, status: 502, after: true, times: 1 })
      const { result } = await job(w, reviewer({ findings: () => [TOKEN_AT_IMPORT] }))
      expect(result.exitCode).toBe(0)
      const summaries = w.fake.issueComments.filter((comment) => comment.body.includes(SUMMARY_MARKER))
      expect(summaries).toHaveLength(1)
      expect(result.posted.summaryId).toBe(summaries[0]!.id)
      expect(state(w)).toMatchObject({ head: w.head, reviews: 1 })
    },
    TIMEOUT,
  )

  test(
    "5b. a model that cannot run fails the job even when GitHub cannot list the comments to say why",
    async () => {
      await using w = await world()
      w.fake.faults.push({ method: "GET", path: /\/issues\/7\/comments$/, status: 502, times: 100 })
      const reason = "acme/model needs ACME_API_KEY."
      const { result, log } = await job(w, reviewer(), {
        resolveModel: () => Promise.reject(new Error(reason)),
      })
      expect(result.exitCode).toBe(1)
      expect(result.error).toBe(reason)
      expect(log).toContain(`Configuration error: ${reason}`)
      expect(posts(w, /\/pulls\/7\/reviews$/)).toHaveLength(0)
    },
    TIMEOUT,
  )

  test(
    "5c. a model that cannot run says nothing on a pull request the settings skip without a word",
    async () => {
      const reason = "acme/model needs ACME_API_KEY."
      const broken = { resolveModel: () => Promise.reject(new Error(reason)) }
      const skipped: { name: string; review?: Json; labels?: string[]; draft?: boolean }[] = [
        // A default skip label that the workflow's own `if:` lets through.
        { name: "no-review label", labels: ["no-review"] },
        { name: "paused", labels: ["vector:paused"] },
        { name: "skipLabels", review: { skipLabels: ["wip"] }, labels: ["WIP"] },
        { name: "skipAuthors", review: { skipAuthors: ["carol"] } },
        { name: "skipBranches", review: { skipBranches: ["feat*"] } },
        { name: "draft", draft: true },
      ]
      for (const item of skipped) {
        await using w = await world(
          item.review ? { baseFiles: { ".vector/review.json": JSON.stringify(item.review) } } : {},
        )
        if (item.labels) w.fake.pull.labels = item.labels
        if (item.draft) w.fake.pull.draft = true
        const { result, log } = await job(w, reviewer(), broken)
        expect({ name: item.name, exitCode: result.exitCode, comments: w.fake.issueComments.length }).toEqual({
          name: item.name,
          exitCode: 0,
          comments: 0,
        })
        expect(log.some((line) => line.startsWith("Skipped: "))).toBe(true)
        expect(posts(w, /\/issues\/7\/comments$/)).toHaveLength(0)
      }

      // An automatic run on a head that is already reviewed leaves the summary as it was.
      await using w = await world()
      await job(w, reviewer({ findings: () => [TOKEN_AT_IMPORT] }))
      const before = sticky(w)!.body
      const { result } = await job(w, reviewer(), broken)
      expect(result.exitCode).toBe(0)
      expect(sticky(w)!.body).toBe(before)
      expect(w.fake.issueComments.filter((comment) => comment.body.includes(SUMMARY_MARKER))).toHaveLength(1)
    },
    TIMEOUT * 2,
  )

  test(
    "5d. a model that cannot run still says why when the review would have run",
    async () => {
      const reason = "acme/model needs ACME_API_KEY."
      const broken = { resolveModel: () => Promise.reject(new Error(reason)) }
      // A command overrides the skip label, so the person who asked hears why nothing happened.
      await using w = await world()
      w.fake.pull.labels = ["no-review"]
      const command: RouteComment = { id: 7001, kind: "issue", author: "alice", body: "/vector review" }
      const asked = await job(w, reviewer(), { ...broken, trigger: "command", comment: command })
      expect(asked.result.exitCode).toBe(1)
      expect(asked.result.error).toBe(reason)
      expect(sticky(w)!.body).toContain(noteCannotStart(reason))

      // A new head on a reviewed pull request is due a review, so it gets the note too.
      await using reviewed = await world()
      await job(reviewed, reviewer({ findings: () => [TOKEN_AT_IMPORT] }))
      await push(reviewed, { "src/list.ts": UNRELATED_LIST })
      const pushed = await job(reviewed, reviewer(), broken)
      expect(pushed.result.exitCode).toBe(1)
      expect(sticky(reviewed)!.body).toContain(noteCannotStart(reason))
      expect(state(reviewed)).toMatchObject({ reviews: 1 })
    },
    TIMEOUT * 2,
  )

  test(
    "6. the head moved during the review: commit_id is the reviewed head, anchors are its own, and the summary says so",
    async () => {
      await using w = await world()
      let moved = ""
      const review = reviewer({
        findings: () => [OFF_BY_ONE, TOKEN_AT_IMPORT],
        during: async () => {
          moved = await push(w, { "src/list.ts": UNRELATED_LIST })
        },
      })
      const { result } = await job(w, review)
      expect(result.exitCode).toBe(0)
      const payload = posts(w, /\/pulls\/7\/reviews$/)[0]!.body!
      expect(payload["commit_id"]).toBe(w.head)
      expect((payload["comments"] as Json[]).map((comment) => `${comment["path"]}:${comment["line"]}`)).toEqual([
        "src/list.ts:22",
        "src/auth.ts:15",
      ])
      expect(sticky(w)!.body).toContain(noteSuperseded(moved))
      // The next run reviews the new head.
      expect(state(w)?.head).toBe(w.head)
    },
    TIMEOUT,
  )

  test(
    "7. dismissal authority: a writer's resolve dismisses; the author's resolve of a blocking security finding does not",
    async () => {
      await using w = await world()
      await job(w, reviewer({ findings: () => [TOKEN_AT_IMPORT, SQL] }))
      const token = w.fake.rootComment("src/auth.ts")
      const sql = w.fake.rootComment("src/db.ts")
      Object.assign(w.fake.threadAt("src/auth.ts"), { isResolved: true, resolvedBy: "alice" })
      Object.assign(w.fake.threadAt("src/db.ts"), { isResolved: true, resolvedBy: "carol" })
      const sqlBody = sql.body
      await push(w, { "src/list.ts": UNRELATED_LIST })

      const { result } = await job(w, reviewer({ findings: () => [SQL] }))
      expect(result.exitCode).toBe(0)
      expect(parseFindingMarker(w.fake.reviewComments.find((comment) => comment.id === token.id)!.body)).toMatchObject({
        status: "dismissed",
      })
      expect(w.fake.reviewComments.find((comment) => comment.id === sql.id)!.body).toBe(sqlBody)
      const body = sticky(w)!.body
      expect(body).toContain("<details><summary>Dismissed (1)</summary>")
      expect(body).toContain(`dismissed by @${String.fromCharCode(0x200b)}alice`)
      expect(body).toContain("<details><summary>Still open from earlier reviews (1)</summary>")
      expect(body).toContain("resolved by the author without a change")
      // The SQL finding is still open, so it is not posted again.
      expect(posts(w, /\/pulls\/7\/reviews$/)).toHaveLength(1)
    },
    TIMEOUT,
  )

  test(
    "8. thumbs-down: a writer's dismisses, an outsider's is ignored",
    async () => {
      await using w = await world()
      await job(w, reviewer({ findings: () => [OFF_BY_ONE, TOKEN_AT_IMPORT] }))
      const offByOne = w.fake.rootComment("src/list.ts")
      const token = w.fake.rootComment("src/auth.ts")
      const tokenBody = token.body
      w.fake.react("pulls", offByOne.id, "-1", "bob")
      w.fake.react("pulls", token.id, "-1", "mallory")
      await push(w, { "src/list.ts": UNRELATED_LIST })

      await job(w, reviewer())
      expect(
        parseFindingMarker(w.fake.reviewComments.find((comment) => comment.id === offByOne.id)!.body)?.status,
      ).toBe("dismissed")
      expect(w.fake.reviewComments.find((comment) => comment.id === token.id)!.body).toBe(tokenBody)
      const body = sticky(w)!.body
      expect(body).toContain("<details><summary>Still open from earlier reviews (1)</summary>")
      expect(body).toContain("token() can throw at import time")
    },
    TIMEOUT,
  )

  test(
    "9. a force-push that only rebased: no model call, and the summary says so",
    async () => {
      await using w = await world()
      const review = reviewer({ findings: () => [TOKEN_AT_IMPORT] })
      await job(w, review)
      await w.repo.git("checkout", "-q", "main")
      const moved = await w.repo.commit("main moves on", { "src/other.ts": "export const other = 1\n" })
      await w.repo.git("checkout", "-q", "feature")
      await w.repo.git("rebase", "-q", "main")
      const rebased = await w.repo.git("rev-parse", "HEAD")
      await w.repo.git("push", "-q", "-f", "origin", "main", "feature")
      Object.assign(w.fake.pull.base, { sha: moved })
      w.fake.pull.head.sha = rebased

      const { result } = await job(w, review)
      expect(result.exitCode).toBe(0)
      expect(review.calls).toHaveLength(1)
      expect(sticky(w)!.body).toContain(noteRebase("main"))
      expect(state(w)).toMatchObject({ head: rebased, base: moved, reviews: 1 })
      expect(posts(w, /\/pulls\/7\/reviews$/)).toHaveLength(1)
    },
    TIMEOUT,
  )

  test(
    "10. a push that merges main: the review's focus leaves main's changes out",
    async () => {
      await using w = await world()
      const review = reviewer()
      await job(w, review)
      await w.repo.git("checkout", "-q", "main")
      const moved = await w.repo.commit("main moves on", { "src/other.ts": "export const other = 1\n" })
      await w.repo.git("checkout", "-q", "feature")
      await w.repo.git("merge", "-q", "--no-edit", "main")
      const head = await w.repo.commit("more", { "src/list.ts": UNRELATED_LIST })
      await w.repo.git("push", "-q", "-f", "origin", "main", "feature")
      Object.assign(w.fake.pull.base, { sha: moved })
      w.fake.pull.head.sha = head

      await job(w, review)
      const input = review.calls[1]!
      expect(input).toMatchObject({ mode: "incremental", since: w.head, head, base: moved })
      expect(input.files.map((file) => file.path).sort()).toEqual(["src/auth.ts", "src/db.ts", "src/list.ts"])
      expect([...new Set(input.focus?.map((hunk) => hunk.path))]).toEqual(["src/list.ts"])
      // Only the hunk around the new change: the earlier hunks (lines 10 and 21–23) were reviewed before.
      expect(input.focus?.length).toBeGreaterThan(0)
      expect(input.focus?.every((hunk) => hunk.start > 26)).toBe(true)
    },
    TIMEOUT,
  )

  test(
    "11. a partial review records what it missed, and a re-run of the same commit reviews only that",
    async () => {
      await using w = await world()
      const partial = reviewer({ findings: () => [OFF_BY_ONE], partial: "budget", unreviewed: ["src/auth.ts"] })
      await job(w, partial)
      expect(state(w)).toMatchObject({ head: w.head, unreviewed: ["src/auth.ts"] })
      expect(sticky(w)!.body).toContain(
        "> **Partial review.** Stopped at the $2.00 budget after 2 of 3 files. Not reviewed: `src/auth.ts`.",
      )

      const rerun = reviewer()
      await job(w, rerun)
      expect(rerun.calls).toHaveLength(1)
      expect(rerun.calls[0]).toMatchObject({ mode: "incremental" })
      expect([...new Set(rerun.calls[0]!.focus?.map((hunk) => hunk.path))]).toEqual(["src/auth.ts"])
      expect(state(w)?.unreviewed).toEqual([])

      // Now the commit is fully reviewed.
      const third = reviewer()
      await job(w, third)
      expect(third.calls).toHaveLength(0)
    },
    TIMEOUT,
  )

  test(
    "12. a failed model: the head does not advance, the job exits 0, and a re-run retries",
    async () => {
      await using w = await world()
      const failed = reviewer({ failed: "HTTP 500 from the provider" })
      const { result } = await job(w, failed)
      expect(result.exitCode).toBe(0)
      expect(sticky(w)!.body).toContain(
        "Vector could not finish this review: HTTP 500 from the provider. Used before it stopped: anthropic/claude-sonnet-4-5 · $0.21 (48.2k in, 31.0k of it cached / 3.1k out). Comment `/vector review` to try again.",
      )
      expect(state(w)).toMatchObject({ failed: true, costUsd: 0.21 })
      expect(state(w)?.head).toBeUndefined()
      expect(w.fake.reviews).toHaveLength(0)

      const retry = reviewer({ findings: () => [TOKEN_AT_IMPORT] })
      await job(w, retry)
      expect(retry.calls).toHaveLength(1)
      expect(state(w)).toMatchObject({ head: w.head })
      expect(state(w)?.failed).toBeUndefined()
    },
    TIMEOUT,
  )

  test(
    "13. a fork command: untrusted, the head from git objects, no checkout, and an unverified fix as a diff",
    async () => {
      await using w = await world({ fork: true })
      const runner = await w.repo.runner(w.base)
      const token = { ...TOKEN_AT_IMPORT, suggestion: "export const auth15 = safeToken()" }
      const review = reviewer({ findings: () => [OFF_BY_ONE, token], verified: [token.title] })
      const comment: RouteComment = { id: 5001, kind: "issue", author: "alice", body: "/vector review" }
      const { result } = await job(w, review, { runner, trigger: "command", comment, expectedHead: w.base })
      expect(result.exitCode).toBe(0)

      const input = review.calls[0]!
      expect(input.trust).toBe("untrusted")
      expect(input.head).toBe(w.head)
      expect(input.headFiles?.find((file) => file.path === "src/list.ts")).toEqual({
        path: "src/list.ts",
        text: FEATURE_LIST,
        exact: true,
      })
      expect(await git(runner, "rev-parse", "HEAD")).toBe(w.base)
      expect(await git(runner, "for-each-ref")).toBe("")
      expect(await git(runner, "status", "--porcelain")).toBe("")

      const comments = posts(w, /\/pulls\/7\/reviews$/)[0]!.body!["comments"] as Json[]
      const offByOne = String(comments.find((entry) => entry["path"] === "src/list.ts")?.["body"])
      const verified = String(comments.find((entry) => entry["path"] === "src/auth.ts")?.["body"])
      expect(offByOne).toContain("```diff\n+  return n\n```")
      expect(offByOne).not.toContain("```suggestion")
      expect(offByOne).not.toContain("/vector fix")
      expect(verified).toContain("```suggestion\nexport const auth15 = safeToken()\n```")
      expect(
        w.fake.reactions.filter((reaction) => reaction.subject === 5001).map((reaction) => reaction.content),
      ).toEqual(["+1"])
      expect(posts(w, /\/issues\/comments\/5001\/reactions$/).map((request) => request.body?.["content"])).toEqual([
        "eyes",
        "+1",
      ])
    },
    TIMEOUT,
  )

  test(
    "14. a secondary rate limit (403 with retry-after) is waited out and retried",
    async () => {
      await using w = await world()
      w.fake.faults.push({ method: "GET", path: /\/pulls\/7$/, status: 403, headers: { "retry-after": "1" }, times: 1 })
      const { result, waits } = await job(w, reviewer({ findings: () => [TOKEN_AT_IMPORT] }))
      expect(result.exitCode).toBe(0)
      expect(waits).toContain(1000)
      expect(
        w.fake.requests.filter((request) => request.method === "GET" && request.path === "/repos/o/r/pulls/7").length,
      ).toBeGreaterThanOrEqual(3)
      expect(w.fake.reviews).toHaveLength(1)
    },
    TIMEOUT,
  )

  test(
    "15. --dry-run prints every write and makes none",
    async () => {
      await using w = await world()
      const review = reviewer({ findings: () => [OFF_BY_ONE, TOKEN_AT_IMPORT] })
      const { result, log } = await job(w, review, { dryRun: true })
      expect(result.exitCode).toBe(0)
      expect(review.calls).toHaveLength(1)
      expect(w.fake.writes).toEqual([])
      const printed = log.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Json)
      expect(printed.map((entry) => entry["write"])).toContain("createReview")
      expect(printed.find((entry) => entry["write"] === "createReview")?.["payload"]).toMatchObject({
        commit_id: w.head,
        event: "COMMENT",
      })
    },
    TIMEOUT,
  )

  test(
    "16. a run that dies after createReview and before the summary: the next run rebuilds from the markers",
    async () => {
      await using w = await world()
      w.fake.faults.push({ method: "PATCH", path: /\/issues\/comments\/\d+$/, status: 500, times: 99 })
      await job(w, reviewer({ findings: () => [OFF_BY_ONE, TOKEN_AT_IMPORT] }))
      expect(w.fake.reviewComments).toHaveLength(2)
      expect(state(w)?.head).toBeUndefined()
      w.fake.faults = []

      const again = reviewer({ findings: () => [OFF_BY_ONE, { ...TOKEN_AT_IMPORT, line: 16 }] })
      const { result } = await job(w, again)
      expect(result.exitCode).toBe(0)
      expect(again.calls).toHaveLength(1)
      expect(w.fake.reviews).toHaveLength(1)
      expect(w.fake.reviewComments).toHaveLength(2)
      expect(sticky(w)!.body).toContain("<details><summary>Still open from earlier reviews (2)</summary>")
      expect(state(w)).toMatchObject({ head: w.head })
    },
    TIMEOUT,
  )

  test(
    "17. the per-PR inline cap: what does not fit goes to the summary",
    async () => {
      await using w = await world({ baseFiles: { ".vector/review.json": JSON.stringify({ maxCommentsPerPr: 2 }) } })
      const { result } = await job(
        w,
        reviewer({
          findings: () => [
            OFF_BY_ONE,
            TOKEN_AT_IMPORT,
            { ...TOKEN_AT_IMPORT, path: "src/list.ts", line: 10, category: "bug", title: "list10 changes its value" },
          ],
        }),
      )
      expect(result.exitCode).toBe(0)
      expect(w.fake.reviewComments).toHaveLength(2)
      const body = sticky(w)!.body
      expect(body).toContain("This pull request reached its 2 inline comments. Further findings are listed here.")
      expect(body).toContain("<details><summary>More findings (1)</summary>")
      expect(state(w)).toMatchObject({ inlinePosted: 2 })
    },
    TIMEOUT,
  )

  test(
    "18. the month cap: automatic reviews and commands both stop, with a note",
    async () => {
      await using w = await world()
      const spent: ReviewState = { ...emptyState(), reviews: 4, costUsd: 6, month: { key: "2026-09", costUsd: 6 } }
      w.fake.addIssueComment(3, `## Vectorscope review\n${SUMMARY_MARKER}\n${stateMarker(spent)}`, BOT_USER)
      const env = { REVIEW_MAX_COST_USD_PER_MONTH: "5" }
      const note = noteMonthBudget({ maxUsd: 5, spentUsd: 6, reviews: 1, month: "2026-09" })
      const review = reviewer({ findings: () => [TOKEN_AT_IMPORT] })

      const auto = await job(w, review, { env })
      expect(auto.result.exitCode).toBe(0)
      expect(sticky(w)!.body).toContain(note)
      const command: RouteComment = { id: 6001, kind: "issue", author: "alice", body: "/vector review" }
      const asked = await job(w, review, { env, trigger: "command", comment: command })
      expect(asked.result.exitCode).toBe(0)
      expect(review.calls).toHaveLength(0)
      expect(w.fake.reviews).toHaveLength(0)
      expect(sticky(w)!.body).toContain("Reviews are paused for this repository until October 1")
    },
    TIMEOUT,
  )

  test(
    '19. failOn "blocking": the job fails after posting',
    async () => {
      await using w = await world()
      const { result } = await job(w, reviewer({ findings: () => [OFF_BY_ONE] }), {
        env: { REVIEW_FAIL_ON: "blocking" },
      })
      expect(result.exitCode).toBe(1)
      expect(result.error).toContain("failOn")
      expect(w.fake.reviews).toHaveLength(1)
      expect(state(w)).toMatchObject({ head: w.head, reviews: 1 })
    },
    TIMEOUT,
  )

  test(
    "20. a forged newer summary is ignored: the oldest bot summary holds the state",
    async () => {
      await using w = await world()
      const genuine = w.fake.addIssueComment(
        PR,
        `## Vectorscope review\n\n${SUMMARY_MARKER}\n${stateMarker(emptyState())}`,
        BOT_USER,
      )
      const forgedState: ReviewState = { ...emptyState(), head: w.head, base: w.base, reviews: 1, costUsd: 999 }
      const forgedBody = `## Vectorscope review\n${SUMMARY_MARKER}\n${stateMarker(forgedState)}`
      const forged = w.fake.addIssueComment(PR, forgedBody, BOT_USER)
      const review = reviewer({ findings: () => [TOKEN_AT_IMPORT] })
      const { result } = await job(w, review)
      expect(result.exitCode).toBe(0)
      expect(review.calls).toHaveLength(1)
      expect(result.posted.summaryId).toBe(genuine.id)
      expect(w.fake.issueComments.find((comment) => comment.id === forged.id)!.body).toBe(forgedBody)
      expect(readState(genuine.body)).toMatchObject({ head: w.head, reviews: 1, costUsd: 0.21 })
    },
    TIMEOUT,
  )

  test(
    "21. a state or finding marker inside model text is escaped and never read back",
    async () => {
      await using w = await world()
      const forged: ReviewState = { ...emptyState(), head: "f".repeat(40), costUsd: 999 }
      const findingMarker = "<!-- vector-finding v1 id=aaaaaaaaaaaa sev=n cat=style sha=0000000 st=d -->"
      const review = reviewer({
        summary: `Adds page(). ${stateMarker(forged)}`,
        findings: () => [{ ...OFF_BY_ONE, body: `Off by one. ${findingMarker}` }],
      })
      await job(w, review)
      const body = sticky(w)!.body
      expect(body).toContain("&lt;!-- vector-review:state v1")
      expect(readState(body)).toMatchObject({ head: w.head, costUsd: 0.21 })
      const comment = w.fake.rootComment("src/list.ts")
      expect(comment.body).toContain("&lt;!-- vector-finding v1 id=aaaaaaaaaaaa")
      expect(parseFindingMarker(comment.body)).toMatchObject({ severity: "blocking", category: "bug", status: "open" })
      expect(parseFindingMarker(comment.body)?.id).not.toBe("aaaaaaaaaaaa")
    },
    TIMEOUT,
  )

  test(
    "a checkout of the wrong commit is a configuration error: exit 1 and nothing posted",
    async () => {
      await using w = await world()
      const review = reviewer()
      const { result } = await job(w, review, { runner: await w.repo.runner(w.base) })
      expect(result.exitCode).toBe(1)
      expect(result.error).toContain("working tree")
      expect(w.fake.writes).toEqual([])
      expect(review.calls).toHaveLength(0)
    },
    TIMEOUT,
  )

  test(
    "a command from someone without write access posts nothing",
    async () => {
      await using w = await world()
      const review = reviewer()
      const comment: RouteComment = { id: 7001, kind: "issue", author: "mallory", body: "/vector review" }
      const { result } = await job(w, review, { trigger: "command", comment })
      expect(result.exitCode).toBe(0)
      expect(w.fake.writes).toEqual([])
      expect(review.calls).toHaveLength(0)
    },
    TIMEOUT,
  )

  test(
    "a command on a commit already reviewed gets one reply, and review full reviews it again",
    async () => {
      await using w = await world()
      const review = reviewer({ findings: () => [TOKEN_AT_IMPORT] })
      await job(w, review)
      const comment: RouteComment = { id: 8001, kind: "issue", author: "alice", body: "/vector review" }
      await job(w, review, { trigger: "command", comment })
      expect(review.calls).toHaveLength(1)
      const replies = w.fake.issueComments.filter((entry) => entry.body.includes("was already reviewed"))
      expect(replies.map((entry) => entry.body)).toEqual([
        `\`${short(w.head)}\` was already reviewed. Comment \`/vector review full\` to review it again.`,
      ])

      const full: RouteComment = { id: 8002, kind: "issue", author: "alice", body: "/vector review full" }
      await job(w, review, { trigger: "command", comment: full, full: true })
      expect(review.calls).toHaveLength(2)
      expect(review.calls[1]).toMatchObject({ mode: "full" })
      // The open finding is not posted again.
      expect(w.fake.reviewComments).toHaveLength(1)
    },
    TIMEOUT,
  )
})

describe("vector github review: ids, failures and edge cases", () => {
  const fixedAll = (input: RunInput) =>
    input.prior.map((prior) => ({ id: prior.id, status: "fixed" as const, reason: "The code is gone." }))

  test(
    "comment ids past 2^31 come from fullDatabaseId, and a fixed finding is edited in place",
    async () => {
      await using w = await world()
      w.fake.id = 3_000_000_000
      await job(w, reviewer({ findings: () => [OFF_BY_ONE, TOKEN_AT_IMPORT] }))
      const first = w.fake.rootComment("src/list.ts")
      expect(first.id).toBeGreaterThan(2 ** 31)
      const h2 = await push(w, { "src/list.ts": edit(FEATURE_LIST, { 22: "  return n" }) })
      w.fake.threadAt("src/list.ts").line = null

      const { result } = await job(w, reviewer({ priorStatus: fixedAll }))
      expect(result.exitCode).toBe(0)
      const edited = w.fake.reviewComments.find((comment) => comment.id === first.id)!
      expect(parseFindingMarker(edited.body)).toMatchObject({ status: "fixed", fixedIn: short(h2) })
      expect(w.fake.requests.some((request) => request.path.endsWith("/pulls/comments/0"))).toBe(false)
      expect(state(w)).toMatchObject({ head: h2 })
      expect(state(w)?.failed).toBeUndefined()
    },
    TIMEOUT,
  )

  test(
    "an edit GitHub refuses after the review is posted is logged, and the commit still counts as reviewed",
    async () => {
      await using w = await world()
      await job(w, reviewer({ findings: () => [OFF_BY_ONE] }))
      const h2 = await push(w, {
        "src/list.ts": insert(edit(FEATURE_LIST, { 22: "  return n" }), 33, ["export const extra = list31 / 0"]),
      })
      w.fake.threadAt("src/list.ts").line = null
      w.fake.faults.push({ method: "PATCH", path: /\/pulls\/comments\/\d+$/, status: 404, times: 99 })
      const second = reviewer({
        findings: () => [
          {
            path: "src/list.ts",
            line: 34,
            severity: "concern",
            category: "bug",
            title: "Division by zero in extra",
            body: "`list31 / 0` is Infinity.",
            confidence: 0.85,
          },
        ],
        priorStatus: fixedAll,
      })
      const { result, log } = await job(w, second)
      expect(result.exitCode).toBe(0)
      expect(w.fake.reviews).toHaveLength(2)
      expect(log.some((line) => line.startsWith("Could not mark the comment on src/list.ts fixed"))).toBe(true)
      expect(state(w)).toMatchObject({ head: h2, reviews: 2, inlinePosted: 2 })
      expect(state(w)?.failed).toBeUndefined()
      const third = reviewer()
      await job(w, third)
      expect(third.calls).toHaveLength(0)
    },
    TIMEOUT,
  )

  test(
    "a finding raised to blocking that only fits in the summary leaves the earlier comment open",
    async () => {
      await using w = await world()
      await job(w, reviewer({ findings: () => [{ ...OFF_BY_ONE, severity: "concern", suggestion: undefined }] }))
      const earlier = w.fake.rootComment("src/list.ts")
      const earlierBody = earlier.body
      const raised = { ...OFF_BY_ONE, title: "page(1) returns an empty first page", suggestion: undefined }
      const comment: RouteComment = { id: 9101, kind: "issue", author: "alice", body: "/vector review full" }
      const { result } = await job(w, reviewer({ findings: () => [raised] }), {
        trigger: "command",
        comment,
        full: true,
        env: { REVIEW_MAX_COMMENTS: "0" },
      })
      expect(result.exitCode).toBe(0)
      expect(w.fake.reviewComments.find((entry) => entry.id === earlier.id)!.body).toBe(earlierBody)
      const body = sticky(w)!.body
      expect(body).toContain("## Vectorscope review · Risk: High")
      expect(body).toContain("<details><summary>More findings (1)</summary>")
      expect(body).toContain("<details><summary>Still open from earlier reviews (1)</summary>")
      expect(state(w)?.findings.map((finding) => [finding.severity, finding.title])).toEqual([
        ["blocking", raised.title],
      ])
    },
    TIMEOUT,
  )

  test(
    "when the month's spend cannot be read, automatic reviews wait for a command",
    async () => {
      await using w = await world()
      w.fake.faults.push({ method: "GET", path: /^\/repos\/o\/r\/issues\/comments$/, status: 403, times: 99 })
      const env = { REVIEW_MAX_COST_USD_PER_MONTH: "5" }
      const review = reviewer({ findings: () => [TOKEN_AT_IMPORT] })
      const auto = await job(w, review, { env })
      expect(auto.result.exitCode).toBe(0)
      expect(review.calls).toHaveLength(0)
      expect(sticky(w)!.body).toContain(
        "Automatic reviews are paused: Vector could not read this month's review spending for the repository",
      )
      const comment: RouteComment = { id: 9201, kind: "issue", author: "alice", body: "/vector review" }
      await job(w, review, { env, trigger: "command", comment })
      expect(review.calls).toHaveLength(1)
    },
    TIMEOUT,
  )

  test(
    "GitHub failing before the review starts exits cleanly with a note; a missing pull request fails the job",
    async () => {
      await using w = await world()
      await job(w, reviewer({ findings: () => [TOKEN_AT_IMPORT] }))
      const before = state(w)
      await push(w, { "src/list.ts": UNRELATED_LIST })
      w.fake.faults.push({ method: "POST", path: /^\/graphql$/, status: 502, times: 99 })
      const review = reviewer()
      const { result } = await job(w, review)
      expect(result.exitCode).toBe(0)
      expect(review.calls).toHaveLength(0)
      expect(sticky(w)!.body).toContain("Vector could not finish this review:")
      expect(state(w)).toEqual(before)

      w.fake.faults = [{ method: "GET", path: /^\/repos\/o\/r\/pulls\/7$/, status: 404, times: 99 }]
      expect((await job(w, reviewer(), { runner: await w.repo.runner(w.head) })).result.exitCode).toBe(1)
    },
    TIMEOUT,
  )

  test(
    "a 422 that refuses the commit itself is not split in halves",
    async () => {
      await using w = await world()
      w.fake.faults.push({
        method: "POST",
        path: /\/pulls\/7\/reviews$/,
        status: 422,
        times: 99,
        body: { message: "Unprocessable Entity", errors: ["commit_id is not part of the pull request"] },
      })
      const { result } = await job(w, reviewer({ findings: () => [OFF_BY_ONE, TOKEN_AT_IMPORT, SQL] }))
      expect(result.exitCode).toBe(0)
      expect(posts(w, /\/pulls\/7\/reviews$/)).toHaveLength(1)
      const body = sticky(w)!.body
      expect(body).toContain(noteCommitGone(w.head, 3))
      expect(body).toContain("<details><summary>Outside the changed lines (3)</summary>")
    },
    TIMEOUT,
  )

  test(
    "an open finding on a file renamed since the last review stays open",
    async () => {
      await using w = await world()
      await job(w, reviewer({ findings: () => [TOKEN_AT_IMPORT] }))
      await w.repo.git("mv", "src/auth.ts", "src/auth2.ts")
      await push(w, { "src/list.ts": UNRELATED_LIST })
      const { result } = await job(w, reviewer())
      expect(result.exitCode).toBe(0)
      expect(sticky(w)!.body).toContain("<details><summary>Still open from earlier reviews (1)</summary>")
    },
    TIMEOUT,
  )
})

// The workflow's review job as it runs in Actions: the real `vector github review` command, the real reviewer on the
// fake LLM, and the fake GitHub above.
describe("vector github review: the workflow's command end to end", () => {
  const actions = (w: World, llmUrl: string, event: { name: string; path: string }) => ({
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
    GITHUB_EVENT_NAME: event.name,
    GITHUB_EVENT_PATH: event.path,
    GITHUB_API_URL: w.fake.url,
    GITHUB_RUN_ID: "1",
    GITHUB_TOKEN: "test-token-placeholder",
    VECTOR_WORKFLOW_VERSION: "2",
    VECTOR_DISABLE_USAGE: "1",
    VECTOR_REVIEW_PR: String(PR),
    VECTOR_REVIEW_REF: w.head,
    MODEL: "lmstudio/test-model",
    VECTOR_PURE: "1",
    VECTOR_DISABLE_PROJECT_CONFIG: "1",
    VECTOR_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(llmUrl), snapshot: false }),
  })
  const setup = (home: string, payload: (w: World) => Json) =>
    Effect.gen(function* () {
      const w = yield* Effect.acquireRelease(
        Effect.promise(() => world()),
        (w) => Effect.promise(() => w[Symbol.asyncDispose]()),
      )
      const runner = yield* Effect.promise(() => w.repo.runner(w.head))
      const event = path.join(home, "event.json")
      yield* Effect.promise(() => Bun.write(event, JSON.stringify(payload(w))))
      return { w, runner, event }
    })
  const opened = (w: World): Json => ({
    action: "opened",
    number: PR,
    pull_request: {
      number: PR,
      draft: false,
      user: { login: "carol" },
      labels: [],
      head: { sha: w.head, ref: "feature", repo: { full_name: `${OWNER}/${REPO}` } },
      base: { sha: w.base, ref: "main", repo: { full_name: `${OWNER}/${REPO}` } },
    },
    repository: { full_name: `${OWNER}/${REPO}` },
  })
  const answers = (llm: CliFixture["llm"]) =>
    Effect.gen(function* () {
      yield* llm.pushMatch(
        (hit) => lastUserText(hit.body).includes("You are Vector's code reviewer"),
        reply()
          .tool("StructuredOutput", {
            summary: "Adds page() to the list helpers.",
            risk: "medium",
            files: [{ path: "src/list.ts", note: "page() added" }],
            findings: [OFF_BY_ONE],
          })
          .usage({ input: 1200, output: 300 }),
      )
      yield* llm.pushMatch(
        (hit) => lastUserText(hit.body).includes("You are Vector's security reviewer"),
        reply()
          .tool("StructuredOutput", { summary: "Nothing else.", risk: "low", files: [], findings: [] })
          .usage({ input: 900, output: 40 }),
      )
      yield* llm.pushMatch(
        (hit) => lastUserText(hit.body).includes("You are checking candidate findings"),
        reply().tool("StructuredOutput", { results: [] }).usage({ input: 500, output: 20 }),
      )
    })

  cliIt.live(
    "an opened pull request is reviewed on the real reviewer, and the review and its tokens are posted",
    ({ llm, vector, home }) =>
      Effect.gen(function* () {
        const { w, runner, event } = yield* setup(home, opened)
        yield* answers(llm)
        const result = yield* vector.spawn(["github", "review"], {
          cwd: runner,
          timeoutMs: 100_000,
          env: actions(w, llm.url, { name: "pull_request", path: event }),
        })
        vector.expectExit(result, 0, "the review job")
        const reviews = posts(w, /\/pulls\/7\/reviews$/)
        expect(reviews).toHaveLength(1)
        const comments = reviews[0]!.body!["comments"] as Json[]
        expect(comments.map((comment) => [comment["path"], comment["line"]])).toEqual([["src/list.ts", 22]])
        const body = sticky(w)!.body
        expect(body).toContain("## Vectorscope review · Risk: High")
        expect(body).toContain("**1 blocking** on the changed lines")
        // What the reviewers spent reaches the pull request, not just the job's log.
        expect(body).toContain("(2.6k in / 360 out)")
        expect(state(w)).toMatchObject({ head: w.head, reviews: 1, inlinePosted: 1 })
      }),
    120_000,
  )

  cliIt.live(
    "a writer's /vectorscope review comment is answered with eyes, the review, then +1",
    ({ llm, vector, home }) =>
      Effect.gen(function* () {
        const { w, runner, event } = yield* setup(home, (w) => {
          const comment = w.fake.addIssueComment(PR, "/vectorscope review", { login: "alice", type: "User" }, 5001)
          return {
            action: "created",
            comment: { id: comment.id, body: comment.body, user: comment.user },
            issue: { number: PR, pull_request: { url: `${w.fake.url}/repos/${OWNER}/${REPO}/pulls/${PR}` } },
            repository: { full_name: `${OWNER}/${REPO}` },
          }
        })
        yield* answers(llm)
        const result = yield* vector.spawn(["github", "review"], {
          cwd: runner,
          timeoutMs: 100_000,
          env: actions(w, llm.url, { name: "issue_comment", path: event }),
        })
        vector.expectExit(result, 0, "the review job")
        expect(posts(w, /\/pulls\/7\/reviews$/)).toHaveLength(1)
        expect(posts(w, /\/issues\/comments\/5001\/reactions$/).map((request) => request.body?.["content"])).toEqual([
          "eyes",
          "+1",
        ])
      }),
    120_000,
  )

  cliIt.live(
    "a model whose key the workflow does not pass fails the job and says which secret on the pull request",
    ({ llm, vector, home }) =>
      Effect.gen(function* () {
        const { w, runner, event } = yield* setup(home, opened)
        const result = yield* vector.spawn(["github", "review"], {
          cwd: runner,
          timeoutMs: 100_000,
          env: {
            ...actions(w, llm.url, { name: "pull_request", path: event }),
            MODEL: "anthropic/claude-sonnet-4-5",
          },
        })
        vector.expectExit(result, 1, "the review job")
        const reason =
          "anthropic/claude-sonnet-4-5 needs ANTHROPIC_API_KEY. Add it as a repository secret and pass it to the Review step in .github/workflows/vector.yml."
        expect(result.stderr).toContain(reason)
        expect(result.stderr).not.toContain("older Vector")
        expect(sticky(w)!.body).toContain(noteCannotStart(reason))
        expect(posts(w, /\/pulls\/7\/reviews$/)).toHaveLength(0)
        expect(yield* llm.hits).toHaveLength(0)
      }),
    120_000,
  )

  cliIt.live(
    "a retired model whose key is passed is called retired, not a missing secret, on the pull request",
    ({ llm, vector, home }) =>
      Effect.gen(function* () {
        const { w, runner, event } = yield* setup(home, opened)
        const result = yield* vector.spawn(["github", "review"], {
          cwd: runner,
          timeoutMs: 100_000,
          env: {
            ...actions(w, llm.url, { name: "pull_request", path: event }),
            MODEL: "deepinfra/zai-org/GLM-4.5",
            DEEPINFRA_API_KEY: "test-placeholder-not-a-key",
          },
        })
        vector.expectExit(result, 1, "the review job")
        const reason =
          "Deep Infra has retired zai-org/GLM-4.5. Set MODEL in .github/workflows/vector.yml to one of its current models."
        expect(result.stderr).toContain(reason)
        expect(result.stderr).not.toContain("needs DEEPINFRA_API_KEY")
        expect(sticky(w)!.body).toContain(noteCannotStart(reason))
        expect(yield* llm.hits).toHaveLength(0)
      }),
    120_000,
  )
})

function lastUserText(body: Record<string, unknown>) {
  const messages: unknown[] = Array.isArray(body["messages"]) ? body["messages"] : []
  const user = messages.findLast((message) => isJson(message) && message["role"] === "user")
  const content = isJson(user) ? user["content"] : undefined
  if (typeof content === "string") return content
  const parts: unknown[] = Array.isArray(content) ? content : []
  return parts.map((part) => (isJson(part) && typeof part["text"] === "string" ? part["text"] : "")).join("\n")
}

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null
}

test("Codium progress, sticky footer and durable review count contain no private figures", async () => {
  await using w = await world()
  const base = reviewer()
  const review = {
    calls: base.calls,
    run: async (input: RunInput): Promise<ReviewOutcome> => {
      input.onProgress?.({ type: "cost", kind: "codium", codium: true, costUsd: 0 })
      return {
        ...(await base.run(input)),
        cost: { ...COST, kind: "codium", codium: true, model: "vector-plan/vector-flash", costUsd: 99, input: 987654 },
      }
    },
  }
  const result = await job(w, review)
  expect(result.log).toContain("Spent: Codium")
  expect(result.log.join("\n")).not.toContain("Spent $0.0000")
  expect(sticky(w)?.body).toContain("Vector Codium · vector-flash · Codium")
  expect(sticky(w)?.body).not.toContain("987")
  expect(sticky(w)?.body).not.toContain("$99")
  expect(state(w)).toMatchObject({ costUsd: 0, tokens: [0, 0], codiumReviews: 1 })
}, 30_000)
