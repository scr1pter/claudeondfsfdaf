import {
  git,
  gitRemotes,
  githubFetch,
  githubGraphql,
  githubJson,
  GithubRequestError,
  parseGithubRemote,
  pickBaseRemote,
  readTail,
  type GithubAccess,
  type GithubRepoRef,
} from "./github-api"
import { WORKFLOW_FILE } from "@vectordevai/core/review/workflow"
import { agentsWorkflowPreview } from "./github-agents"
import { githubSignInConfigured, resolveGithubAccess } from "./github-access"
import {
  requireMergeStrategy,
  requirePullRequestComments,
  requirePullRequestDirectory,
  requirePullRequestHead,
  requirePullRequestLimit,
  requirePullRequestNumber,
  requirePullRequestState,
  requirePullRequestText,
  requireReviewEvent,
} from "./github-pr-input"
import { cleanLogLine, failedStepLog, MAX_LOG_BYTES } from "./ci-watch"
import { checkPost } from "./posting-check"
import { redactText } from "./security-redaction"

// Pull requests through GitHub's API with the user's GitHub sign-in in Vector. Nothing has to be installed: the
// token is Vector's own device-flow sign-in, or an existing GitHub CLI login for someone who already has one.

export type PullRequestAccessStatus = {
  authenticated: boolean
  // Whether this build of Vector can sign in to GitHub at all.
  configured: boolean
  login?: string
  source?: GithubAccess["source"]
  detail: string
}

export async function pullRequestAccessStatus(): Promise<PullRequestAccessStatus> {
  const configured = await githubSignInConfigured()
  const access = await resolveGithubAccess()
  if (!access) {
    return { authenticated: false, configured, detail: "Sign in to GitHub to load pull requests." }
  }
  const user = await githubJson<{ login?: string }>(access, "/user", { timeoutMs: 15_000 }).then(
    (value) => ({ login: value.login, error: undefined }),
    (error: unknown) => ({ login: undefined, error }),
  )
  // A revoked or expired token needs a new sign-in; anything else (offline, rate limit) is reported by the
  // calls that follow rather than sending a signed-in user back to the sign-in screen.
  if (user.error instanceof GithubRequestError && user.error.status === 401) {
    return { authenticated: false, configured, source: access.source, detail: user.error.message }
  }
  const login = user.login
  return {
    authenticated: true,
    configured,
    login,
    source: access.source,
    detail: login ? `Signed in to GitHub as ${login}.` : "Signed in to GitHub.",
  }
}

export type PullRequestSummary = {
  number: number
  title: string
  author: string
  state: string
  isDraft: boolean
  baseRefName: string
  headRefName: string
  additions: number
  deletions: number
  changedFiles: number
  url: string
  updatedAt: string
  reviewDecision?: string
  // The SHAs and the fork flag let a review tell whether the user's checkout is this pull request.
  headRefOid?: string
  baseRefOid?: string
  isCrossRepository?: boolean
}

export type PullRequestDetail = PullRequestSummary & {
  body: string
  files: { path: string; additions: number; deletions: number }[]
  comments: { author: string; body: string; createdAt: string }[]
}

const SUMMARY_FIELDS = `number title author { login } state isDraft baseRefName headRefName additions deletions
  changedFiles url updatedAt reviewDecision headRefOid baseRefOid isCrossRepository`

type RawPullRequest = Omit<PullRequestSummary, "author" | "reviewDecision"> & {
  author?: { login?: string } | null
  reviewDecision?: string | null
}

export function toPullRequestSummary(raw: RawPullRequest): PullRequestSummary {
  return {
    ...raw,
    // A deleted account shows as GitHub's "ghost" user.
    author: raw.author?.login ?? "ghost",
    reviewDecision: raw.reviewDecision ?? undefined,
  }
}

// The same states the GitHub CLI offers, where "closed" includes merged pull requests.
const STATES = {
  open: ["OPEN"],
  closed: ["CLOSED", "MERGED"],
  merged: ["MERGED"],
  all: ["OPEN", "CLOSED", "MERGED"],
} as const

export async function listPullRequests(
  cwd: string,
  options?: { state?: "open" | "closed" | "merged" | "all"; limit?: number },
) {
  const { access, repo } = await pullRequestContext(cwd)
  return fetchPullRequests(
    access,
    repo,
    requirePullRequestState(options?.state ?? "open"),
    requirePullRequestLimit(options?.limit ?? 100),
  )
}

export async function fetchPullRequests(
  access: GithubAccess,
  repo: GithubRepoRef,
  state: keyof typeof STATES,
  limit: number,
) {
  const query = `query($owner: String!, $name: String!, $states: [PullRequestState!], $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: $states, first: $first, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { ${SUMMARY_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`
  const collected: PullRequestSummary[] = []
  let after: string | undefined
  while (collected.length < limit) {
    const data = await githubGraphql<{
      repository: {
        pullRequests: { nodes: RawPullRequest[]; pageInfo: { hasNextPage: boolean; endCursor?: string } }
      } | null
    }>(access, query, {
      owner: repo.owner,
      name: repo.name,
      states: STATES[state],
      first: Math.min(100, limit - collected.length),
      after,
    })
    const page = data.repository?.pullRequests
    if (!page) throw new Error(`GitHub couldn't find ${repo.owner}/${repo.name}, or this account can't see it.`)
    collected.push(...page.nodes.map(toPullRequestSummary))
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break
    after = page.pageInfo.endCursor
  }
  return collected
}

export async function viewPullRequest(cwd: string, number: number): Promise<PullRequestDetail> {
  const { access, repo } = await pullRequestContext(cwd)
  return fetchPullRequest(access, repo, requirePullRequestNumber(number))
}

// GitHub lists at most 3,000 files for a pull request; the newest 100 comments are what a reviewer reads.
const MAX_FILE_PAGES = 30

export async function fetchPullRequest(access: GithubAccess, repo: GithubRepoRef, number: number) {
  const query = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        ${SUMMARY_FIELDS} body
        files(first: 100, after: $after) {
          nodes { path additions deletions }
          pageInfo { hasNextPage endCursor }
        }
        comments(last: 100) { nodes { author { login } body createdAt } }
      }
    }
  }`
  type Page = {
    repository: {
      pullRequest:
        | (RawPullRequest & {
            body?: string
            files: {
              nodes: { path: string; additions: number; deletions: number }[]
              pageInfo: { hasNextPage: boolean; endCursor?: string }
            }
            comments: { nodes: { author?: { login?: string } | null; body?: string; createdAt?: string }[] }
          })
        | null
    } | null
  }
  const first = await githubGraphql<Page>(access, query, { owner: repo.owner, name: repo.name, number })
  const raw = first.repository?.pullRequest
  if (!raw) throw new Error(`GitHub couldn't find pull request #${number} in ${repo.owner}/${repo.name}.`)
  const files = [...raw.files.nodes]
  let pageInfo = raw.files.pageInfo
  for (let page = 1; page < MAX_FILE_PAGES && pageInfo.hasNextPage && pageInfo.endCursor; page += 1) {
    const next = await githubGraphql<Page>(access, query, {
      owner: repo.owner,
      name: repo.name,
      number,
      after: pageInfo.endCursor,
    })
    const more = next.repository?.pullRequest?.files
    if (!more) break
    files.push(...more.nodes)
    pageInfo = more.pageInfo
  }
  return {
    ...toPullRequestSummary(raw),
    body: raw.body ?? "",
    files,
    comments: raw.comments.nodes.map((comment) => ({
      author: comment.author?.login ?? "ghost",
      body: comment.body ?? "",
      createdAt: comment.createdAt ?? "",
    })),
  } satisfies PullRequestDetail
}

// With the commit the panel last saw, a diff of anything newer is refused: the review reads, anchors and posts
// against that one commit, so it must not review a later push under its name.
export async function pullRequestDiff(cwd: string, number: number, head?: string) {
  const expected = head === undefined ? undefined : requirePullRequestHead(head)
  const { access, repo } = await pullRequestContext(cwd)
  return fetchPullRequestDiff(access, repo, requirePullRequestNumber(number), expected)
}

export async function fetchPullRequestDiff(access: GithubAccess, repo: GithubRepoRef, number: number, head?: string) {
  const response = await githubFetch(access, `${repoPath(repo)}/pulls/${number}`, {
    accept: "application/vnd.github.diff",
    timeoutMs: 90_000,
  }).catch((error: unknown) => {
    // GitHub refuses to render one diff past 300 files or 20,000 lines.
    if (error instanceof GithubRequestError && (error.status === 406 || error.status === 422)) {
      throw new Error(`Pull request #${number} is too large for GitHub to return as one diff. ${error.message}`)
    }
    throw error
  })
  const diff = await response.text()
  // GitHub always renders the newest commit, so a head that still matches after the read is the commit this diff is.
  if (head && (await currentHead(access, repo, number)) !== head) {
    throw new Error("This pull request changed while Vector was reading it. Run Review with Vector again.")
  }
  return diff
}

export async function createPullRequest(input: {
  cwd: string
  title: string
  body: string
  base?: string
  draft?: boolean
}) {
  const cwd = requirePullRequestDirectory(input.cwd)
  // The user typed the title and body, so the check only asks when they repeat what Vector knows about them.
  const checked = await checkPost({
    cwd,
    parts: [
      requirePullRequestText(input.title, "Pull request title", 256, false),
      requirePullRequestText(input.body, "Pull request body", 1_000_000),
    ],
    typed: true,
  })
  if (!checked) throw new Error("Nothing was posted.")
  const [title, body] = checked as [string, string]
  const { access, repo } = await pullRequestContext(cwd)
  const head = await pushedHead(cwd, repo)
  const base = input.base
    ? requirePullRequestText(input.base, "Base branch", 255, false)
    : (await githubJson<{ default_branch: string }>(access, repoPath(repo))).default_branch
  const created = await githubJson<{ html_url?: string }>(access, `${repoPath(repo)}/pulls`, {
    method: "POST",
    body: { title, body, head, base, draft: input.draft === true },
    timeoutMs: 60_000,
  })
  return { url: created.html_url ?? "" }
}

// A comment on one line of the diff, or on the lines startLine through line. side is the diff column the lines
// are counted in: LEFT for the base commit's lines, RIGHT for the head commit's.
export type PullRequestReviewComment = {
  path: string
  line: number
  side: "LEFT" | "RIGHT"
  startLine?: number
  body: string
}

// Posting a review is the one action here other people see, so the UI only makes this call after the user
// confirms. With the commit the review was run on, GitHub records that exact commit, and the post is refused if
// the pull request has moved since.
export async function submitPullRequestReview(input: {
  cwd: string
  number: number
  head?: string
  body: string
  event: "comment" | "approve" | "request-changes"
  comments?: PullRequestReviewComment[]
  // Posted instead of body, without line comments, if GitHub refuses the comments.
  fallbackBody?: string
  // The review's sessions, whose recalled memory the posting check compares the text with.
  sessionIDs?: string[]
  // A pull request from someone Vector cannot trust: links and images then point only at GitHub.
  untrusted?: boolean
}) {
  const number = requirePullRequestNumber(input.number)
  const event = requireReviewEvent(input.event)
  const body = requirePullRequestText(input.body, "Review body", 1_000_000, false)
  const head = input.head === undefined ? undefined : requirePullRequestHead(input.head)
  const comments = input.comments === undefined ? undefined : requirePullRequestComments(input.comments)
  const fallbackBody =
    input.fallbackBody === undefined
      ? undefined
      : requirePullRequestText(input.fallbackBody, "Review fallback body", 1_000_000)
  const cwd = requirePullRequestDirectory(input.cwd)
  const sessionIDs = (input.sessionIDs ?? []).filter((id) => typeof id === "string").slice(0, 50)
  const { access, repo } = await pullRequestContext(cwd)
  // The renderer can only make the review stricter: GitHub says whether the pull request is a fork or another
  // author's, and either makes it one Vector cannot trust.
  return postPullRequestReview(
    access,
    repo,
    number,
    { body, event, head, comments, fallbackBody },
    (parts, untrusted) =>
      checkPost({ cwd, parts, typed: false, sessionIDs, untrusted: untrusted || input.untrusted === true }),
  )
}

/**
 * The posting check a review goes through: the parts to post, or undefined when nothing is posted. `untrusted` says,
 * from GitHub, that the pull request comes from a fork or from someone other than the signed-in account (6.4a).
 */
export type ReviewCheck = (parts: string[], untrusted: boolean) => Promise<string[] | undefined>

export async function postPullRequestReview(
  access: GithubAccess,
  repo: GithubRepoRef,
  number: number,
  review: {
    body: string
    event: "comment" | "approve" | "request-changes"
    head?: string
    comments?: PullRequestReviewComment[]
    fallbackBody?: string
  },
  check: ReviewCheck,
) {
  const head = review.head
  const pull = await githubJson<RawPull>(access, `${repoPath(repo)}/pulls/${number}`)
  if (head && pull.head?.sha?.toLowerCase() !== head) {
    throw new Error("This pull request changed after the review started. Run Review with Vector again before posting.")
  }
  // Everything the review sends is checked as one text, so a sentence split across two comments is still found. A
  // line comment that loses all its text is not sent.
  const sent = head ? (review.comments ?? []) : []
  const checked = await check(
    [review.body, ...sent.map((comment) => comment.body), review.fallbackBody ?? review.body],
    await fromSomeoneElse(access, pull),
  )
  if (!checked) return { posted: false, inline: 0 }
  const body = checked[0] ?? ""
  const fallbackBody = checked.at(-1) ?? body
  // Line numbers belong to one commit's diff, so line comments are only sent pinned to the commit they were read on.
  const comments = sent
    .map((comment, index) => ({ ...comment, body: checked[index + 1] ?? "" }))
    .filter((comment) => comment.body.trim())
    .map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: comment.body,
      ...(comment.startLine !== undefined && comment.startLine < comment.line
        ? { start_line: comment.startLine, start_side: comment.side }
        : {}),
    }))
  const post = (body: string, lineComments: typeof comments) =>
    githubJson(access, `${repoPath(repo)}/pulls/${number}/reviews`, {
      method: "POST",
      body: {
        body,
        event: review.event.toUpperCase().replaceAll("-", "_"),
        ...(head ? { commit_id: head } : {}),
        ...(lineComments.length ? { comments: lineComments } : {}),
      },
      timeoutMs: 60_000,
    })
  // GitHub refuses the whole review when any one comment's line is outside the diff, so it is posted once more
  // without line comments, under a body that lists every finding instead.
  const inline = await post(body, comments)
    .then(() => comments.length)
    .catch((error: unknown) => {
      if (error instanceof GithubRequestError && error.status === 422 && comments.length) {
        return post(fallbackBody, []).then(() => 0)
      }
      throw error
    })
  return { posted: true, inline }
}

export type PullRequestChecks = {
  head: string
  // conclusion is "" while a check is still running.
  runs: { name: string; status: string; conclusion: string; url: string }[]
  // The failing step's log of the first few failed GitHub Actions jobs. step and excerpt are "" when GitHub
  // returned no log for the job.
  failures: { name: string; step: string; excerpt: string }[]
}

// The CI results of the commit a review runs on, so a reviewer reads what already failed alongside the diff.
export async function pullRequestChecks(cwd: string, number: number, head: string) {
  requirePullRequestNumber(number)
  const commit = requirePullRequestHead(head)
  const { access, repo } = await pullRequestContext(cwd)
  return fetchPullRequestChecks(access, repo, commit)
}

// Each failure downloads the tail of a job log, so only the first few are read.
const MAX_FAILURE_LOGS = 3
const MAX_FAILURE_EXCERPT = 4_000
// A job that timed out leaves the step it was running cancelled rather than failed.
const FAILED_STEP_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled"])

export async function fetchPullRequestChecks(
  access: GithubAccess,
  repo: GithubRepoRef,
  head: string,
): Promise<PullRequestChecks> {
  const checks = await githubJson<{ check_runs?: RawCheckRun[] }>(
    access,
    `${repoPath(repo)}/commits/${head}/check-runs?per_page=100`,
    { timeoutMs: 45_000 },
  ).catch((error: unknown) => {
    // GitHub answers 404 for a commit it has not seen, which has no checks yet.
    if (error instanceof GithubRequestError && error.status === 404) return { check_runs: [] }
    throw error
  })
  const runs = checks.check_runs ?? []
  return {
    head,
    runs: runs.map((run) => ({
      name: run.name ?? "",
      status: run.status ?? "",
      conclusion: run.conclusion ?? "",
      url: run.html_url ?? "",
    })),
    failures: await Promise.all(
      runs
        .filter(
          (run) =>
            (run.conclusion === "failure" || run.conclusion === "timed_out") && run.app?.slug === "github-actions",
        )
        .slice(0, MAX_FAILURE_LOGS)
        .map((run) => checkFailure(access, repo, run)),
    ),
  }
}

// GitHub's REST shape of a check run.
type RawCheckRun = {
  id?: number
  name?: string
  status?: string | null
  conclusion?: string | null
  html_url?: string | null
  app?: { slug?: string } | null
}

// A GitHub Actions check run's id is its job's id, which names the job's steps and its log. A job whose log GitHub
// has expired, or never wrote, still lists as a failure, just without an excerpt.
async function checkFailure(access: GithubAccess, repo: GithubRepoRef, run: RawCheckRun) {
  const path = `${repoPath(repo)}/actions/jobs/${run.id}`
  const name = run.name ?? ""
  const loaded = await Promise.all([
    githubJson<{ name?: string; steps?: { name?: string; conclusion?: string | null }[] }>(access, path, {
      timeoutMs: 45_000,
    }),
    // GitHub answers with a redirect to a short-lived download URL, which fetch follows.
    githubFetch(access, `${path}/logs`, { timeoutMs: 120_000 }).then((response) => readTail(response, MAX_LOG_BYTES)),
  ]).catch(() => undefined)
  if (!loaded) return { name, step: "", excerpt: "" }
  const [job, tail] = loaded
  // failedStepLog labels each line "<job>\t<step>\t" for parseFailureLog; the excerpt is the bare log text.
  const text = failedStepLog(tail.text, job)
    .map((line) => cleanLogLine(line.split("\t").slice(2).join("\t")))
    .join("\n")
  return {
    name,
    step: job.steps?.find((step) => FAILED_STEP_CONCLUSIONS.has(step.conclusion ?? ""))?.name ?? "",
    // The end of a step holds the error. Redaction runs on a window a little wider than the excerpt rather than
    // the whole step, which can be megabytes, and the result is cut again since redacting can lengthen a line.
    excerpt: redactText(text.slice(-2 * MAX_FAILURE_EXCERPT)).slice(-MAX_FAILURE_EXCERPT),
  }
}

// With the commit the user last saw, GitHub refuses the merge if anything was pushed since, so a commit nobody
// looked at is never merged by this button.
export async function mergePullRequest(input: {
  cwd: string
  number: number
  strategy: "merge" | "squash" | "rebase"
  head?: string
}) {
  const number = requirePullRequestNumber(input.number)
  const strategy = requireMergeStrategy(input.strategy)
  const head = input.head === undefined ? undefined : requirePullRequestHead(input.head)
  const { access, repo } = await pullRequestContext(requirePullRequestDirectory(input.cwd))
  return putPullRequestMerge(access, repo, number, { strategy, head })
}

export async function putPullRequestMerge(
  access: GithubAccess,
  repo: GithubRepoRef,
  number: number,
  merge: { strategy: "merge" | "squash" | "rebase"; head?: string },
) {
  await githubJson(access, `${repoPath(repo)}/pulls/${number}/merge`, {
    method: "PUT",
    body: { merge_method: merge.strategy, ...(merge.head ? { sha: merge.head } : {}) },
    timeoutMs: 90_000,
  }).catch((error: unknown) => {
    if (error instanceof GithubRequestError && error.status === 409 && merge.head) {
      throw new Error("New commits were pushed to this pull request. Look them over, then merge again.")
    }
    throw error
  })
  return { merged: true }
}

// ---- Automatic reviews ----------------------------------------------------------------------------------------
// "Set up automatic reviews" opens a pull request that adds the workflow `vector github install` writes. Nothing runs
// until someone merges it, and no API key goes to GitHub: the user adds the repository secrets it names.

export const AUTO_REVIEW_BRANCH = "vector-automatic-reviews"
// The monthly review budget `vector github install` suggests.
const AUTO_REVIEW_MONTHLY_USD = 50

export type AutoReviewStatus = {
  // installed: the default branch has the workflow. on-request: it has the workflow `vector github install` writes when
  // asked to review only on a `/vector review` comment. pending: a pull request that adds it is open. read-only: this
  // account cannot push to the repository. needs-scope: this sign-in may not write workflow files.
  state: "installed" | "on-request" | "pending" | "read-only" | "needs-scope" | "available"
  repo: string // owner/name
  defaultBranch: string
  secretsUrl: string // the repository's Actions secrets settings
  url?: string // installed and on-request: the workflow file; pending: the pull request
  source: GithubAccess["source"]
}

export type AutoReviewSecret = { name: string; detail: string; url?: string }

export type AutoReviewWorkflow = {
  path: string
  content: string
  model: string
  monthlyUsd: number
  secrets: AutoReviewSecret[]
}

export type AutoReviewSetup = {
  url: string
  number: number
  branch: string
  secrets: AutoReviewSecret[]
  secretsUrl: string
}

// The file the pull request adds: `vector github install`'s workflow with automatic reviews on, on the given model,
// with that command's default monthly limit, the repository's own GITHUB_TOKEN and no public sharing.
export function autoReviewWorkflow(input: { model: unknown; keys: unknown }, version: string): AutoReviewWorkflow {
  return {
    ...agentsWorkflowPreview(
      { mode: "own-key", model: input.model, keys: input.keys, autoReview: true },
      version,
      undefined,
      AUTO_REVIEW_MONTHLY_USD,
    ),
    monthlyUsd: AUTO_REVIEW_MONTHLY_USD,
  }
}

export async function automaticReviewStatus(cwd: string) {
  const { access, repo } = await pullRequestContext(cwd)
  return fetchAutoReviewStatus(access, repo)
}

export async function fetchAutoReviewStatus(access: GithubAccess, repo: GithubRepoRef): Promise<AutoReviewStatus> {
  const response = await githubFetch(access, repoPath(repo))
  // OAuth tokens list their scopes here, and writing a file under .github/workflows needs "workflow". A token that
  // lists none, such as a fine-grained one, is tried as it is.
  const scopes = response.headers.get("x-oauth-scopes")
  const info = (await response.json()) as {
    full_name?: string
    default_branch: string
    html_url: string
    permissions?: { push?: boolean }
  }
  const status = {
    repo: info.full_name ?? `${repo.owner}/${repo.name}`,
    defaultBranch: info.default_branch,
    secretsUrl: `${info.html_url}/settings/secrets/actions`,
    source: access.source,
  }
  const installed = await githubJson<{ html_url?: string; content?: string; encoding?: string }>(
    access,
    `${repoPath(repo)}/contents/${WORKFLOW_FILE}?ref=${encodeURIComponent(info.default_branch)}`,
  ).catch((error: unknown) => {
    if (error instanceof GithubRequestError && error.status === 404) return undefined
    throw error
  })
  if (installed)
    return {
      ...status,
      state:
        installed.encoding === "base64" &&
        reviewsOnlyOnRequest(Buffer.from(installed.content ?? "", "base64").toString())
          ? "on-request"
          : "installed",
      url: installed.html_url ?? `${info.html_url}/blob/${info.default_branch}/${WORKFLOW_FILE}`,
    }
  const pending = await pendingAutoReviewPullRequest(access, repo, status.repo)
  if (pending) return { ...status, state: "pending", url: pending }
  if (!info.permissions?.push) return { ...status, state: "read-only" }
  if (scopes !== null && !scopes.split(",").some((scope) => scope.trim() === "workflow"))
    return { ...status, state: "needs-scope" }
  return { ...status, state: "available" }
}

// `vector github install` leaves out the pull_request trigger when asked to review only on a `/vector review` comment.
// A file that names no pull_request event in any form (`pull_request:`, `[push, pull_request]`, `- pull_request`) is
// that workflow; anything else, including a file someone rewrote, counts as reviewing every pull request.
function reviewsOnlyOnRequest(content: string) {
  return content.includes("issue_comment") && !/(^|[\s[,])pull_request\s*(:|,|\]|$)/m.test(content)
}

// The open pull request an earlier set-up made, found by its branch rather than in a page of every open pull request,
// so a busy repository never hides it. Branches of the same name in forks belong to someone else.
async function pendingAutoReviewPullRequest(access: GithubAccess, repo: GithubRepoRef, fullName: string) {
  const branches = await githubJson<{ ref: string }[]>(
    access,
    `${repoPath(repo)}/git/matching-refs/heads/${AUTO_REVIEW_BRANCH}`,
  )
  const owner = fullName.split("/")[0]
  for (const branch of branches) {
    const head = `${owner}:${branch.ref.replace(/^refs\/heads\//, "")}`
    const [open] = await githubJson<{ html_url: string }[]>(
      access,
      `${repoPath(repo)}/pulls?state=open&per_page=1&head=${encodeURIComponent(head)}`,
    )
    if (open) return open.html_url
  }
}

export async function setUpAutomaticReviews(input: { cwd: string; model: string; keys: string[] }, version: string) {
  const workflow = autoReviewWorkflow(input, version)
  const { access, repo } = await pullRequestContext(requirePullRequestDirectory(input.cwd))
  return openAutoReviewPullRequest(access, repo, workflow)
}

// Branches from the default branch, commits the workflow, and opens the pull request. The state is read again first,
// so a second click, or a workflow someone else added meanwhile, never opens a second pull request.
export async function openAutoReviewPullRequest(
  access: GithubAccess,
  repo: GithubRepoRef,
  workflow: AutoReviewWorkflow,
): Promise<AutoReviewSetup> {
  const status = await fetchAutoReviewStatus(access, repo)
  if (status.state !== "available") throw new Error(autoReviewRefusal(status))
  const base = await githubJson<{ object: { sha: string } }>(
    access,
    `${repoPath(repo)}/git/ref/heads/${refPath(status.defaultBranch)}`,
  )
  const branch = await createAutoReviewBranch(access, repo, base.object.sha)
  await githubJson(access, `${repoPath(repo)}/contents/${workflow.path}`, {
    method: "PUT",
    body: {
      message: "Review pull requests with Vectorscope",
      content: Buffer.from(workflow.content).toString("base64"),
      branch,
    },
    timeoutMs: 60_000,
  }).catch(async (error: unknown) => {
    // The branch exists only for this file, so it is not left behind.
    await deleteBranch(access, repo, branch)
    if (error instanceof GithubRequestError && (error.status === 403 || error.status === 404))
      throw new Error(
        `GitHub refused to add ${workflow.path} (${error.message}). ${
          access.source === "gh"
            ? "Your GitHub CLI login may not be allowed to change workflows: run `gh auth refresh -s workflow`, then try again."
            : "Your GitHub sign-in may not be allowed to change workflows: sign out of GitHub in Vectorscope and sign in again."
        } If it still fails, a rule in ${status.repo} may protect workflow files; ask a maintainer.`,
      )
    throw error
  })
  const pull = await githubJson<{ html_url: string; number: number }>(access, `${repoPath(repo)}/pulls`, {
    method: "POST",
    body: {
      title: "Review pull requests with Vectorscope",
      head: branch,
      base: status.defaultBranch,
      body: autoReviewBody(workflow),
    },
    timeoutMs: 60_000,
  }).catch(async (error: unknown) => {
    // GitHub refused the pull request, so its branch goes too and a retry starts clean. After a timeout or a server
    // error the pull request may exist, so the branch stays for the next status check to find.
    if (error instanceof GithubRequestError && error.status >= 400 && error.status < 500)
      await deleteBranch(access, repo, branch)
    throw error
  })
  return { url: pull.html_url, number: pull.number, branch, secrets: workflow.secrets, secretsUrl: status.secretsUrl }
}

function deleteBranch(access: GithubAccess, repo: GithubRepoRef, branch: string) {
  return githubFetch(access, `${repoPath(repo)}/git/refs/heads/${refPath(branch)}`, { method: "DELETE" }).catch(
    () => undefined,
  )
}

// A branch left from an earlier set-up whose pull request was closed is kept; the new one gets a suffix instead.
async function createAutoReviewBranch(access: GithubAccess, repo: GithubRepoRef, sha: string) {
  const create = (branch: string) =>
    githubJson(access, `${repoPath(repo)}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha },
    }).then(
      () => true,
      (error: unknown) => {
        if (error instanceof GithubRequestError && error.status === 422) return false
        throw error
      },
    )
  if (await create(AUTO_REVIEW_BRANCH)) return AUTO_REVIEW_BRANCH
  const fresh = `${AUTO_REVIEW_BRANCH}-${Date.now().toString(36)}`
  if (await create(fresh)) return fresh
  throw new Error(`GitHub would not create the branch ${fresh}. Try again.`)
}

function autoReviewRefusal(status: AutoReviewStatus) {
  if (status.state === "installed") return `Automatic reviews are already set up in ${status.repo}.`
  if (status.state === "on-request")
    return `${status.repo} already has ${WORKFLOW_FILE}, set up to review when someone comments /vector review. Run \`vector github install\` and choose to review every pull request to change it.`
  if (status.state === "pending")
    return `A pull request that sets up automatic reviews is already open in ${status.repo}: ${status.url}`
  if (status.state === "read-only") return `You need write access to ${status.repo} to add a workflow.`
  return status.source === "gh"
    ? "Your GitHub CLI login can't change workflow files. Run `gh auth refresh -s workflow`, then try again."
    : "Your GitHub sign-in can't change workflow files yet. Sign out of GitHub in Vectorscope and sign in again to allow it."
}

function autoReviewBody(workflow: AutoReviewWorkflow) {
  return [
    `Adds \`${workflow.path}\`, the workflow \`vector github install\` writes, so Vectorscope reviews every pull request when it opens and on every push. Reviews run on \`${workflow.model}\` and stop at $${workflow.monthlyUsd} a month (\`REVIEW_MAX_COST_USD_PER_MONTH\`).`,
    "",
    "Before merging, add these repository secrets under Settings → Secrets and variables → Actions:",
    "",
    ...workflow.secrets.map((secret) => `- \`${secret.name}\`: ${secret.detail}`),
    "",
    "This pull request runs the workflow too, and that run fails until the secrets exist. After adding them, re-run it to see a review. Comment `/vectorscope review` on any pull request to ask for one.",
    "",
    "Opened from Vectorscope in Vector.",
  ].join("\n")
}

// A branch name in a URL path: each segment encoded, its slashes kept.
function refPath(branch: string) {
  return branch.split("/").map(encodeURIComponent).join("/")
}

type RawPull = {
  head?: { sha?: string; repo?: { full_name?: string } | null }
  base?: { repo?: { full_name?: string } }
  user?: { login?: string } | null
}

// Whether the pull request comes from a fork (its head repository is another, or deleted) or was opened by someone
// other than the signed-in account. Either way the owner did not write it (section 6.4a). A login GitHub does not
// give counts as someone else.
async function fromSomeoneElse(access: GithubAccess, pull: RawPull) {
  const head = pull.head?.repo?.full_name?.toLowerCase()
  if (!head || head !== pull.base?.repo?.full_name?.toLowerCase()) return true
  const viewer = await githubJson<{ login?: string }>(access, "/user", { timeoutMs: 15_000 }).then(
    (user) => user.login?.toLowerCase(),
    () => undefined,
  )
  return !viewer || viewer !== pull.user?.login?.toLowerCase()
}

async function currentHead(access: GithubAccess, repo: GithubRepoRef, number: number) {
  const pull = await githubJson<{ head?: { sha?: string } }>(access, `${repoPath(repo)}/pulls/${number}`)
  return pull.head?.sha?.toLowerCase()
}

async function pullRequestContext(cwd: string) {
  const directory = requirePullRequestDirectory(cwd)
  const access = await resolveGithubAccess()
  if (!access) throw new Error("Sign in to GitHub to work with pull requests.")
  const remote = pickBaseRemote(await gitRemotes(directory))
  if (!remote) {
    throw new Error(
      "This repository has no GitHub remote. Add one with: git remote add origin https://github.com/<owner>/<repo>.git",
    )
  }
  return { access, repo: remote.repo }
}

// The branch GitHub knows this checkout by. A pull request from a fork names its owner, as "owner:branch".
export async function pushedHead(cwd: string, base: GithubRepoRef) {
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd)
  const tracking = upstream.failed ? "" : upstream.stdout.trim()
  const slash = tracking.indexOf("/")
  if (slash < 1) throw new Error("Push this branch to GitHub first, then create the pull request.")
  const remoteName = tracking.slice(0, slash)
  const branch = tracking.slice(slash + 1)
  const url = await git(["remote", "get-url", remoteName], cwd)
  const pushed = parseGithubRemote(url.stdout)
  if (url.failed || !pushed) throw new Error(`The branch tracks ${remoteName}, which is not a GitHub repository.`)
  return pushed.owner.toLowerCase() === base.owner.toLowerCase() ? branch : `${pushed.owner}:${branch}`
}

function repoPath(repo: GithubRepoRef) {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}
