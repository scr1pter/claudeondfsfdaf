// The agent phase of a v3 workflow's agent job (contract 2.13, V18b). `vector github sandbox run -- vector github run
// --phase agent` starts it as the sandbox's agent user, with the run's credentials on the secret channel, which index.ts
// loads before the account gate. It reads the event, builds the task from its trigger and the thread (thread text as
// labelled JSON, INV-S14), runs one session on the checked-out head and records the result as the run bundle (2.12). It
// reacts, comments and pushes nowhere, runs no network git, reads GitHub only through a client that refuses every write
// before sending it, and never writes process.env. Own key only for now: a Codium run is refused and settled before any
// catalog or model request until V18c, and a schedule is refused until V22. Node APIs only: the desktop sidecar runs the
// engine under Node.

import fs from "node:fs/promises"
import { Octokit } from "@octokit/rest"
import { graphql } from "@octokit/graphql"
import { Effect, Option, Schema } from "effect"
import { z } from "zod"
import { EventV2 } from "@vectordevai/core/event"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { parseReviewCommand } from "@vectordevai/core/review/command"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { PublicSession } from "@vectordevai/schema/public-session"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { LLMRequestPrep } from "@/session/llm/request"
import { SessionPosting } from "@/session/posting"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import type { SessionID } from "../../session/schema"
import { GITHUB_ACTIONS_BOT } from "./github.auth"
import { GithubBundle } from "./github.bundle"
import { settle, type Services } from "./github.cloud"
import { buildEvidenceBody, parseNumstat, type EvidenceChange } from "./github.evidence"
import { withGithubCallbacks, withGithubSignals } from "./github.lifecycle"
import { githubSystemInstructions } from "./github.policy"
import { WRITE_PERMISSIONS, createReviewGitHub } from "./github.review-api"
import { TASK_MENTIONS, mentionsFrom } from "./github.route"
import { GithubRunHelpers } from "./github.run-helpers"
import { GithubSecrets } from "./github.secrets"
import { githubFetch } from "./github.shared"

// Fixed log lines. None names a plan, a price or a billing state, and none uses an INV-H1 word.
export const AGENT_NEEDS_CHANNEL =
  "The agent phase runs only inside `vector github sandbox run`, which hands it the run's credentials."
export const CODIUM_NOT_YET = "This Vector version does not run Codium agent tasks yet."
export const SCHEDULE_NOT_YET = "This Vector version does not run scheduled tasks yet."
export const UNKNOWN_MODE = "The agent phase needs VECTOR_MODE own-key or codium."
export const NO_PROMPT = "A dispatched task needs a prompt."
export const NOT_A_TASK = "Nothing to do: this event does not ask Vector for a task."
export const BOT_REFUSED = "Bots cannot start Vector tasks."
export const AUTHOR_REFUSED = "Only the person who opened an issue can start a task from it."
export const NOT_WRITER = "Only people with write access to this repository can start Vector tasks."
export const FORK_REFUSED = "Vector does not run tasks on pull requests from forks."
export const THREAD_MISMATCH = "The workflow's thread does not match this event."
export const READ_ONLY = "The agent phase only reads from GitHub."
export const WITHHELD =
  "Vector left out this run's text: it repeats what Vector knows about you, or could not be checked."
export const FALLBACK_TITLE = "Changes from Vector"

export function refusedEvent(name: string) {
  return `Nothing to do: ${name} events do not start agent tasks.`
}

// GitHub's own limit for a webhook payload is 25 MB.
const EVENT_LIMIT = 25 * 1024 * 1024
const RUN_ID = /^[1-9]\d{0,19}$/

export type AgentCredentials = Pick<
  ReturnType<typeof GithubSecrets.createGithubSecrets>,
  "loaded" | "githubToken" | "runToken"
>

export type AgentPhaseInput = {
  /** The step's environment, read and never written; process.env by default. */
  env?: Readonly<Record<string, string | undefined>>
  /** The credential holder; the process's loaded channel by default. */
  credentials?: AgentCredentials
  /** The vectordev.ai client a Codium run settles through. */
  services?: Services
  share?: PublicSession.Consent
  log?: (line: string) => void
  error?: (line: string) => void
}

export type AgentPhaseResult = {
  exitCode: 0 | 1
  outcome?: GithubAgents.Outcome
  summary?: GithubBundle.RunSummary
}

export type AgentRoute = {
  kind: "issue" | "pr" | "dispatch"
  thread: string
  number?: number
  /** The writer's task: the comment, the issue's text after its mention, or the dispatch's prompt. */
  trigger: string
  /** Whose write access the phase checks again before any model request. */
  login: string
  comment?: GithubRunHelpers.AgentComment & { id: number; in_reply_to_id?: number }
  review: boolean
}

/**
 * Runs the agent phase in this process's instance. Returns how the CLI should exit, or nothing when SIGINT or SIGTERM
 * ended it first (withGithubSignals then sets 130 or 143).
 */
export const githubAgentPhase = Effect.fn("Cli.github.agentPhase")(function* (input: AgentPhaseInput = {}) {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die("InstanceRef not provided")
  const git = yield* Git.Service
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const provider = yield* Provider.Service
  const events = yield* EventV2Bridge.Service
  const permissions = yield* Permission.Service
  // Only an own-key run with the workflow's consent shares; the service is looked up then, never required.
  const share = input.share ? Option.getOrUndefined(yield* Effect.serviceOption(PublicSessionShare.Service)) : undefined
  return yield* withGithubCallbacks((run) =>
    Effect.promise((signal) =>
      agentPhase({
        env: input.env ?? process.env,
        credentials: input.credentials ?? GithubSecrets.credentials,
        services: input.services,
        consent: input.share,
        log: input.log ?? console.log,
        error: input.error ?? console.error,
        worktree: ctx.worktree,
        signal,
        run,
        git,
        sessions,
        prompt,
        provider,
        events,
        permissions,
        share,
      }),
    ),
  ).pipe(withGithubSignals)
})

/**
 * A Codium run's agent phase until V18c: one log line and a `refused` settle, so the at-once slot the gate's starting
 * heartbeat opened is released. No instance, catalog, model or GitHub request.
 */
export async function refuseCodiumAgent(
  input: Pick<AgentPhaseInput, "services" | "log"> & { credentials?: Pick<AgentCredentials, "runToken"> } = {},
): Promise<AgentPhaseResult> {
  ;(input.log ?? console.log)(CODIUM_NOT_YET)
  await settle({
    token: (input.credentials ?? GithubSecrets.credentials).runToken(),
    outcome: "refused",
    services: input.services,
    signal: AbortSignal.timeout(5000),
  })
  return { exitCode: 0, outcome: "refused" }
}

type CallbackRunner = <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>

type Deps = {
  env: Readonly<Record<string, string | undefined>>
  credentials: AgentCredentials
  services?: Services
  consent?: PublicSession.Consent
  log: (line: string) => void
  error: (line: string) => void
  worktree: string
  signal: AbortSignal
  run: CallbackRunner
  git: Git.Interface
  sessions: Session.Interface
  prompt: SessionPrompt.Interface
  provider: Provider.Interface
  events: EventV2.Interface
  permissions: Permission.Interface
  share?: PublicSessionShare.Interface
}

async function agentPhase(deps: Deps): Promise<AgentPhaseResult> {
  if (!deps.credentials.loaded()) {
    deps.error(AGENT_NEEDS_CHANNEL)
    return { exitCode: 1 }
  }
  // An own-key run never heartbeats or settles (INV-K1), whatever token its holder has: the mode decides, not the token.
  if (deps.env.VECTOR_MODE === "codium") return refuseCodiumAgent(deps)
  if (deps.env.VECTOR_MODE !== "own-key") {
    deps.error(UNKNOWN_MODE)
    return { exitCode: 1 }
  }
  // Until the route and the base are known there is nothing to record, so a failure here exits 1 with no bundle.
  const start = await begin(deps).catch((cause: unknown) => ({ crash: messageOf(cause) }))
  if ("crash" in start) {
    deps.error(start.crash)
    return { exitCode: 1 }
  }
  if ("refused" in start) {
    deps.log(start.refused)
    return { exitCode: 0, outcome: "refused" }
  }
  // Every model request of this process carries the policy and the untrusted-data rule in its system instructions
  // (INV-S14). It is never unpinned: the process serves this one task, and background work may still send requests.
  LLMRequestPrep.pin(start.instructions)
  // From here every failure is recorded as a bundle (the default row), except a refusal, which writes none.
  const task = await gather(start, deps).catch((cause: unknown) => ({ failed: cause }))
  if ("refused" in task) {
    deps.log(task.refused)
    return { exitCode: 0, outcome: "refused" }
  }
  const result =
    "failed" in task
      ? failure(task.failed, deps)
      : await work(start, task, deps).catch((cause: unknown) => failure(cause, deps))
  return record(start, "failed" in task ? {} : task, result, deps)
}

type Start = Exclude<Awaited<ReturnType<typeof begin>>, { refused: string }>

async function begin(deps: Deps) {
  const event = await readEvent(deps.env)
  const routed = agentRoute(event, deps.env)
  if ("refused" in routed) return refusal(routed.refused)
  const route = routed.route
  if (deps.env.VECTOR_THREAD !== route.thread || !GithubAgents.THREAD_PATTERN.test(route.thread))
    throw new Error(THREAD_MISMATCH)
  const repository = deps.env.GITHUB_REPOSITORY ?? ""
  // Throws on anything but an exact owner/repository, so no name carries text into the system layer.
  const instructions = githubSystemInstructions(repository)
  const [owner, repo] = repository.split("/") as [string, string]
  const runId = deps.env.GITHUB_RUN_ID ?? ""
  if (!RUN_ID.test(runId)) throw new Error("The agent phase needs the run's GITHUB_RUN_ID.")
  const token = deps.credentials.githubToken()
  if (!token) throw new Error(AGENT_NEEDS_CHANNEL)
  const head = await deps.run(deps.git.run(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: deps.worktree }))
  if (head.exitCode !== 0) throw new Error("The agent phase needs a checked-out commit.")
  const gh = readOnlyGithub({ token, baseUrl: deps.env.GITHUB_API_URL, signal: deps.signal })
  // Only permission lookups are used; its posting check refuses every write, and its requests go through the same
  // read-only fetch.
  const review = createReviewGitHub({
    token,
    owner,
    repo,
    botLogin: GITHUB_ACTIONS_BOT,
    baseUrl: apiBase(deps.env.GITHUB_API_URL),
    signal: deps.signal,
    fetch: readOnlyFetch,
    check: () => Promise.reject(new Error(READ_ONLY)),
  })
  return {
    route,
    instructions,
    owner,
    repo,
    token,
    gh,
    review,
    baseSha: head.text().trim(),
    runUrl: `${(deps.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "")}/${owner}/${repo}/actions/runs/${runId}`,
  }
}

// What the task is: the writer checked again, the thread's labelled text, and the pull request's head branch.
async function gather(start: Start, deps: Deps) {
  // The route job checked the trigger's author; the agent phase asks again, so a workflow that skips it starts nothing.
  if (!WRITE_PERMISSIONS.includes(await start.review.permissionOf(start.route.login))) return refusal(NOT_WRITER)
  const mentions = mentionsFrom(deps.env.MENTIONS, TASK_MENTIONS)
  const context = { triggerCommentId: start.route.comment?.id, permissionOf: start.review.permissionOf }
  const query = { octoGraph: start.gh.graphql, owner: start.owner, repo: start.repo, issueId: start.route.number }
  const issue = start.route.kind === "issue" ? await GithubRunHelpers.fetchIssue(query) : undefined
  const pr = start.route.kind === "pr" ? await GithubRunHelpers.fetchPR(query) : undefined
  if (pr && pr.headRepository?.nameWithOwner !== pr.baseRepository?.nameWithOwner) return refusal(FORK_REFUSED)
  const data = issue
    ? await GithubRunHelpers.buildAgentPromptForIssue(context, issue)
    : pr
      ? await GithubRunHelpers.buildAgentPromptForPR(context, pr)
      : undefined
  const prompt = start.route.comment
    ? await GithubRunHelpers.getAgentUserPrompt({
        comment: start.route.comment,
        review: start.route.review,
        mentions,
        finding: await GithubRunHelpers.fixContext(start.gh.rest, {
          owner: start.owner,
          repo: start.repo,
          botLogin: GITHUB_ACTIONS_BOT,
          mentions,
          eventName: start.route.review ? "pull_request_review_comment" : "issue_comment",
          comment: start.route.comment,
          format: GithubRunHelpers.agentFindingForPrompt,
        }),
        appToken: start.token,
        signal: deps.signal,
      })
    : { userPrompt: start.route.trigger, promptFiles: [] }
  return {
    message: data ? `${prompt.userPrompt}\n\n${data}` : prompt.userPrompt,
    files: prompt.promptFiles,
    threadTitle: issue?.title ?? pr?.title,
    headRef: pr?.headRefName,
  }
}

type Task = Exclude<Awaited<ReturnType<typeof gather>>, { refused: string }>

type Result = {
  end?: GithubBundle.Stop
  title: string
  body: string
  comment: string
  sessionID?: SessionID
  shared?: boolean
}

async function work(start: Start, task: Task, deps: Deps): Promise<Result> {
  const model = agentModel({
    mode: "own-key",
    model: deps.env.MODEL,
    providers: await deps.run(deps.provider.list()),
  })
  const session = await deps.run(
    deps.sessions.create({ permission: [{ permission: "question", action: "deny", pattern: "*" }] }),
  )
  const shared = await publish(session.id, deps)
  await GithubRunHelpers.subscribeSessionEvents({
    run: deps.run,
    sessions: deps.sessions,
    sessionID: session.id,
    events: deps.events,
    permissions: deps.permissions,
  })
  deps.log(`vector session ${session.id}`)
  const chat = { run: deps.run, prompt: deps.prompt, sessionID: session.id, model }
  const fallback = () => task.threadTitle?.trim() || FALLBACK_TITLE
  const reply = await GithubRunHelpers.chat(chat, task.message, task.files).then(
    (response) => ({ response, end: undefined }),
    (cause: unknown) => {
      deps.error(messageOf(cause))
      return { response: "", end: stopFor(cause) }
    },
  )
  const title = reply.end ? fallback() : await GithubRunHelpers.summarize(chat, reply.response, fallback)
  const evidence = await GithubRunHelpers.collectSessionEvidence({
    run: deps.run,
    sessions: deps.sessions,
    sessionID: session.id,
  })
  const body = buildEvidenceBody({
    response: reply.response,
    changes: await changesOf(start, session.id, deps),
    messages: evidence.messages,
    judge: evidence.judge,
    runUrl: start.runUrl,
    shareUrl: shared?.url,
    trigger: start.route.kind === "dispatch" ? "Triggered by workflow_dispatch" : undefined,
  })
  return { end: reply.end, title, body, comment: reply.response, sessionID: session.id, shared: shared !== undefined }
}

// A failure before the session could finish: the default row, with the fixed title.
function failure(cause: unknown, deps: Deps): Result {
  deps.error(messageOf(cause))
  return { end: stopFor(cause), title: FALLBACK_TITLE, body: "", comment: "" }
}

async function record(start: Start, task: Partial<Task>, result: Result, deps: Deps): Promise<AgentPhaseResult> {
  // Everything the run hands publish is checked against the owner's memory first (section 6.4a), as githubRun checks
  // what it posts. Nobody is there to answer, so what repeats it is dropped, and a check that cannot run keeps none.
  const fallback = task.threadTitle?.trim() || FALLBACK_TITLE
  const [title, body, comment] = await deps
    .run(
      SessionPosting.headless({
        parts: [result.title, result.body, result.comment],
        typed: false,
        untrusted: false,
        sessionIDs: result.sessionID ? [result.sessionID] : [],
        log: deps.log,
      }),
    )
    .catch((cause: unknown) => {
      deps.error(messageOf(cause))
      return [fallback, WITHHELD, WITHHELD]
    })
  if (result.shared && result.sessionID && deps.share) {
    // The bundle is written either way (2.13): a share that cannot finish only logs.
    await deps.run(deps.share.flush(result.sessionID)).catch((cause: unknown) => {
      deps.error(`Could not finish updating the public session: ${messageOf(cause)}`)
    })
  }
  const written = await GithubBundle.writeBundle({
    cwd: deps.worktree,
    baseSha: start.baseSha,
    route: bundleRoute(start.route, task.headRef),
    // The check drops whole sentences, so a title that only repeats memory comes back empty.
    title: title?.trim() || fallback,
    body: body ?? "",
    comment: comment ?? "",
    ...(result.end ? { end: result.end } : {}),
  }).catch((cause: unknown) => ({ crash: messageOf(cause) }))
  if ("crash" in written) {
    deps.error(written.crash)
    return { exitCode: 1 }
  }
  deps.log(`Vector recorded the run: ${written.summary.outcome}.`)
  return { exitCode: 0, outcome: written.summary.outcome, summary: written.summary }
}

function bundleRoute(route: AgentRoute, headRef: string | undefined): GithubBundle.BundleRoute {
  if (route.kind === "issue") return { mode: "own-key", kind: "issue", thread: route.thread, issue: route.number }
  if (route.kind === "pr")
    return { mode: "own-key", kind: "pr", thread: route.thread, pr: route.number, ...(headRef ? { headRef } : {}) }
  return { mode: "own-key", kind: "dispatch", thread: route.thread }
}

// An own-key run's errors always take the default row (INV-K1): no provider's body can stand for a Codium stop.
function stopFor(cause: unknown) {
  return GithubBundle.stopReason(cause instanceof Error && cause.cause !== undefined ? cause.cause : cause, {
    codium: false,
  })
}

async function publish(sessionID: SessionID, deps: Deps) {
  if (!deps.share || !deps.consent) return undefined
  deps.log("Publishing this task conversation, code, and tool output publicly, including future updates.")
  const info = await deps.run(
    deps.share.publish({
      sessionID,
      engine: "v1",
      consent: deps.consent,
      expiresAt: Date.now() + PublicSession.MAX_AGE_MS,
    }),
  )
  deps.log(`Public session: ${info.url}`)
  return info
}

// What the evidence lists as changed: the session's own file changes, which include new files, or, when it kept none,
// git's count against the base (tracked files only). The agent wrote this worktree's .git, so that count runs pinned as
// writeBundle's commands do; when it fails, the evidence lists no changes and the bundle still records the patch.
async function changesOf(start: Start, sessionID: SessionID, deps: Deps): Promise<EvidenceChange[]> {
  const diffs = await deps.run(deps.sessions.diff(sessionID)).catch(() => [])
  const listed = diffs.flatMap((diff) =>
    diff.file ? [{ file: diff.file, additions: diff.additions, deletions: diff.deletions }] : [],
  )
  if (listed.length) return listed
  return GithubBundle.numstat({ cwd: deps.worktree, baseSha: start.baseSha }).then(parseNumstat, () => [])
}

async function readEvent(env: Readonly<Record<string, string | undefined>>) {
  const file = env.GITHUB_EVENT_PATH
  if (!file) throw new Error("The agent phase needs GITHUB_EVENT_PATH.")
  const info = await fs.stat(file)
  if (!info.isFile() || info.size > EVENT_LIMIT) throw new Error("The event payload is missing or too large.")
  const payload = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(await fs.readFile(file, "utf8")),
  )
  if (payload === undefined) throw new Error("The event payload is not JSON.")
  return { name: env.GITHUB_EVENT_NAME, payload }
}

// A declared type, so a refusal stays its own member of a result union rather than merging with the success shape.
function refusal(refused: string): { refused: string } {
  return { refused }
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

// ---------------------------------------------------------------------------------------------------------------------
// Routing

const User = z.object({ login: z.string().min(1), id: z.number().optional(), type: z.string().optional() })
const CommentPayload = z.object({
  id: z.number().int().positive(),
  body: z.string(),
  user: User,
  path: z.string().optional(),
  line: z.number().nullable().optional(),
  diff_hunk: z.string().optional(),
  in_reply_to_id: z.number().int().positive().optional(),
})
const Id = z.number().int().positive().max(9_999_999_999)
const IssueComment = z.object({
  action: z.string(),
  issue: z.object({ number: Id, pull_request: z.unknown().optional() }),
  comment: CommentPayload,
})
const ReviewComment = z.object({ action: z.string(), pull_request: z.object({ number: Id }), comment: CommentPayload })
const Issues = z.object({
  action: z.string(),
  issue: z.object({ number: Id, title: z.string(), body: z.string().nullable().optional(), user: User }),
  sender: User,
})
const Dispatch = z.object({ inputs: z.record(z.string(), z.unknown()).nullable().optional(), sender: User })

/**
 * Which task an event asks for, by the same rules as the v3 route job (2.11.3), checked again because the agent phase
 * trusts no earlier step: a comment or review comment that was just created and asks for a task, by a person; an issue
 * just opened by its author whose title or body asks for one; a dispatch in task mode with a prompt, by a person. A
 * schedule waits for V22. A payload without the fields read throws.
 */
export function agentRoute(
  event: { name: string | undefined; payload: unknown },
  env: Readonly<Record<string, string | undefined>>,
): { route: AgentRoute } | { refused: string } {
  const mentions = mentionsFrom(env.MENTIONS, TASK_MENTIONS)
  const asks = (text: string) => parseReviewCommand(text, mentions).kind === "task"
  if (event.name === "issue_comment" || event.name === "pull_request_review_comment") {
    const review = event.name === "pull_request_review_comment"
    const payload = review ? ReviewComment.parse(event.payload) : IssueComment.parse(event.payload)
    if (payload.action !== "created") return { refused: NOT_A_TASK }
    if (bot(payload.comment.user)) return { refused: BOT_REFUSED }
    if (!asks(payload.comment.body)) return { refused: NOT_A_TASK }
    const number = "pull_request" in payload ? payload.pull_request.number : payload.issue.number
    const pr = "pull_request" in payload || !!payload.issue.pull_request
    return {
      route: {
        kind: pr ? "pr" : "issue",
        thread: String(number),
        number,
        trigger: payload.comment.body,
        login: payload.comment.user.login,
        comment: payload.comment,
        review,
      },
    }
  }
  if (event.name === "issues") {
    const payload = Issues.parse(event.payload)
    if (payload.action !== "opened") return { refused: NOT_A_TASK }
    if (bot(payload.issue.user) || bot(payload.sender)) return { refused: BOT_REFUSED }
    if (payload.issue.user.id === undefined || payload.issue.user.id !== payload.sender.id)
      return { refused: AUTHOR_REFUSED }
    const text = `${payload.issue.title}\n\n${payload.issue.body ?? ""}`
    if (!asks(`${payload.issue.title}\n${payload.issue.body ?? ""}`)) return { refused: NOT_A_TASK }
    return {
      route: {
        kind: "issue",
        thread: String(payload.issue.number),
        number: payload.issue.number,
        trigger: afterMention(text, mentions),
        login: payload.issue.user.login,
        review: false,
      },
    }
  }
  if (event.name === "workflow_dispatch") {
    const payload = Dispatch.parse(event.payload)
    // Own key refuses every bot: it cannot check a one-time ticket (2.11.3). V18c admits Codium's ticket dispatches.
    if (bot(payload.sender)) return { refused: BOT_REFUSED }
    const mode = payload.inputs?.mode
    if (mode !== undefined && mode !== "" && mode !== "task") return { refused: NOT_A_TASK }
    const prompt = env.VECTOR_PROMPT?.trim()
    if (!prompt) return { refused: NO_PROMPT }
    const runId = env.GITHUB_RUN_ID ?? ""
    if (!RUN_ID.test(runId)) throw new Error("The agent phase needs the run's GITHUB_RUN_ID.")
    return {
      route: {
        kind: "dispatch",
        thread: `dispatch-${runId}`,
        trigger: prompt,
        login: payload.sender.login,
        review: false,
      },
    }
  }
  if (event.name === "schedule") return { refused: SCHEDULE_NOT_YET }
  return { refused: refusedEvent(event.name || "unknown") }
}

function bot(user: z.infer<typeof User>) {
  return user.type === "Bot" || /\[bot\]$/i.test(user.login)
}

/**
 * The text after the first mention in `text`, which is the writer's task: "@vector add dark mode" asks for "add dark
 * mode". A mention counts as a word, as parseReviewCommand counts it. With nothing after it, the whole text is the task.
 * The whole issue is in the thread block either way, labelled.
 */
export function afterMention(text: string, mentions: readonly string[]) {
  const ends = mentions
    .map((mention) => mention.trim())
    .filter(Boolean)
    .flatMap((mention) => {
      const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const found = new RegExp(`(^|[\\s(\\["'])${escaped}(?=$|[\\s)\\]}"',:;!?]|\\.(?:$|\\s))`, "i").exec(text)
      return found ? [{ start: found.index + found[1]!.length, end: found.index + found[0].length }] : []
    })
    .sort((a, b) => a.start - b.start || b.end - a.end)
  // Punctuation that only ends the mention ("@vector, add dark mode") is not part of the task.
  const rest = ends[0]
    ? text
        .slice(ends[0].end)
        .replace(/^[\s,:;]+/, "")
        .trim()
    : ""
  return rest || text.trim()
}

// ---------------------------------------------------------------------------------------------------------------------
// Model

/**
 * The run's model. Codium: MODEL `vector-plan` (or none) is the catalog's first entry, the one it recommends, and
 * `vector-plan/<id>` must be listed. Own key: MODEL is required, since a v3 workflow always sets it, it must be listed,
 * and it is never a Codium model (INV-K1). Throws with the reason otherwise.
 */
export function agentModel(input: {
  mode: "codium" | "own-key"
  model: string | undefined
  providers: Record<string, { models: Record<string, { id: string }> }>
}) {
  const value = input.model?.trim() ?? ""
  if (input.mode === "codium") {
    const plans = input.providers[ModelPlans.PROVIDER_ID]
    const chosen =
      value === "" || value === ModelPlans.PROVIDER_ID
        ? Provider.defaultModelIDs(plans ? { [ModelPlans.PROVIDER_ID]: plans } : {})[ModelPlans.PROVIDER_ID]
        : value.startsWith(`${ModelPlans.PROVIDER_ID}/`)
          ? value.slice(ModelPlans.PROVIDER_ID.length + 1)
          : undefined
    if (chosen === undefined) throw new Error("A Codium workflow runs a Codium model: set VECTOR_MODEL to vector-plan.")
    if (!plans?.models[chosen]) throw new Error("This Codium model is not available for this repository.")
    return { providerID: ProviderV2.ID.make(ModelPlans.PROVIDER_ID), modelID: ModelV2.ID.make(chosen) }
  }
  if (!value) throw new Error("No GitHub model is set. Set MODEL in the workflow to provider/model.")
  const parsed = Provider.parseModel(value)
  if (!parsed.providerID.length || !parsed.modelID.length)
    throw new Error(`Invalid model ${value}. Model must be in the format "provider/model".`)
  if (parsed.providerID === ModelPlans.PROVIDER_ID) throw new Error(GithubSecrets.OWN_KEY_CODIUM)
  if (!input.providers[parsed.providerID]?.models[parsed.modelID])
    throw new Error("This workflow was set up by an older Vector; run vector github install again.")
  return parsed
}

// ---------------------------------------------------------------------------------------------------------------------
// The read-only GitHub client

function apiBase(value: string | undefined) {
  return (value || "https://api.github.com").replace(/\/+$/, "")
}

/**
 * Octokit and GraphQL clients for the agent phase. Both send through readOnlyFetch, so a write is refused before it is
 * sent, whatever the token allows (the job's token is read-only too).
 */
export function readOnlyGithub(input: { token: string; baseUrl?: string; signal?: AbortSignal }) {
  const baseUrl = apiBase(input.baseUrl)
  return {
    rest: new Octokit({
      auth: input.token,
      baseUrl,
      request: { signal: input.signal, fetch: readOnlyFetch },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }),
    graphql: graphql.defaults({
      baseUrl,
      headers: { authorization: `token ${input.token}` },
      request: { signal: input.signal, fetch: readOnlyFetch },
    }),
  }
}

/** githubFetch for reads only: GET and HEAD, and a GraphQL POST that is one query. Anything else rejects unsent. */
export async function readOnlyFetch(input: RequestInfo | URL, init?: RequestInit) {
  if (!readOnly(input, init)) throw new Error(READ_ONLY)
  return githubFetch(input, init)
}

function readOnly(input: RequestInfo | URL, init?: RequestInit) {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
  if (method === "GET" || method === "HEAD") return true
  if (method !== "POST" || input instanceof Request || typeof init?.body !== "string") return false
  const url = URL.canParse(String(input)) ? new URL(String(input)) : undefined
  return url !== undefined && url.pathname.endsWith("/graphql") && readOnlyQuery(init.body)
}

// What Octokit's GraphQL client sends. An operationName could pick another operation of the document to run.
const GraphqlBody = z.object({ query: z.string(), variables: z.record(z.string(), z.unknown()).optional() }).strict()

/**
 * Whether a GraphQL request body holds one query and nothing that writes: only `query` and `variables`, and a document
 * that names no `mutation` or `subscription` anywhere, holds exactly one `query` keyword, or none for a shorthand `{`,
 * and opens with it once the leading whitespace, commas, byte order mark and comments, which GraphQL ignores, are
 * skipped. The words are looked for in the raw text: a `#` inside a string is text, not a comment, so stripping
 * comments first could hide a second operation. A comment or a string that holds one of the words refuses the body.
 */
export function readOnlyQuery(body: string) {
  const parsed = GraphqlBody.safeParse(
    Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body)),
  )
  if (!parsed.success) return false
  const document = parsed.data.query
  if (/\b(?:mutation|subscription)\b/i.test(document)) return false
  const queries = document.match(/\bquery\b/g)?.length ?? 0
  const lead = document.replace(/^(?:[\s,\uFEFF]+|#[^\n\r]*)*/, "")
  if (lead.startsWith("{")) return queries === 0
  return /^query\b/.test(lead) && queries === 1
}

export * as GithubAgent from "./github.agent"
