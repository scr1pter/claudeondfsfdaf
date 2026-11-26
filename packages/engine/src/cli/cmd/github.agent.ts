// The agent phase of a v3 workflow's agent job (contract 2.13, V18b). `vector github sandbox run -- vector github run
// --phase agent` starts it as the sandbox's agent user, with the run's credentials on the secret channel, which index.ts
// loads before the account gate. It reads the event, builds the task from its trigger and the thread (thread text as
// labelled JSON, INV-S14), runs one session on the checked-out head and records the result as the run bundle (2.12). It
// reacts, comments and pushes nowhere, runs no network git, reads GitHub only through a client that refuses every write
// before sending it, and never writes process.env. A Codium run (V18c) also heartbeats from the gate's starting beat to
// its settle, stops its session at VECTOR_RUN_DEADLINE minus STOP_MARGIN_SECONDS or when the heartbeat says stop, follows
// 2.9.2 in its retries and its bundle's stop, and logs gateway errors only as their reason lines (P6). With the
// runner's session proof it also saves its conversation for the thread's next run as vector-out/session.vsa, attested
// to the runner (V27), and before its first turn continues the conversation its thread's last run saved, when that
// conversation opens under the thread's key and fits; otherwise it reads the thread as before. A desktop-started run
// (Vector's ticket dispatch with VECTOR_BRAIN_UPLOAD, B08) reads the Brain context its owner approved once, before any
// session, and gives it to its first task message as labelled untrusted JSON; it never enters the runner's Brain, and
// any failure runs the task without it. With the runner's session proof such a run saves its conversation, with the
// exact approved bundle and its approval, only under the Brain key its download gave it, never the ordinary key, and a
// re-run attempt of it continues that conversation only under the same approval (Brain history restriction). It writes
// no returned Brain drafts (deviations BT07b). A Codium ticket dispatch whose whole prompt is Vector everywhere's job
// line (R-A4, the exception to INV-S14) reads that job's request once from vectordev.ai with its run token, after
// begin's checks and before any model request, and frames it with core's frameTask: the pinned system instructions
// gain the platform's everywhere policy, the task turn is the framed block, marked with the platform, whose task field
// alone is the task, and the run reads no Brain context and saves no conversation. Any failure ends that run with one
// fixed line, no model request and no bundle. An own-key run never heartbeats, settles, waits, saves, restores or
// reads Brain context (INV-K1). Schedules run only the exact default-branch configuration. Node APIs only: the desktop
// sidecar runs the engine under Node.

import fs from "node:fs/promises"
import path from "node:path"
import { Octokit } from "@octokit/rest"
import { APICallError } from "ai"
import { graphql } from "@octokit/graphql"
import { Effect, Option, Schema, type Types } from "effect"
import { z } from "zod"
import { BrainPosting } from "@vectordevai/core/brain/posting"
import { EventV2 } from "@vectordevai/core/event"
import { everywhereSystemInstructions, frameTask } from "@vectordevai/core/everywhere/frame"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { Location } from "@vectordevai/core/location"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { parseReviewCommand } from "@vectordevai/core/review/command"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import { SessionArchive } from "@vectordevai/core/share/archive"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { AbsolutePath } from "@vectordevai/core/schema"
import { isRepositoryName, jobOfActionsPrompt } from "@vectordevai/schema/everywhere"
import { PublicSession } from "@vectordevai/schema/public-session"
import { LLMError } from "@vectordevai/llm"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { SessionCompaction } from "@/session/compaction"
import { LLMRequestPrep } from "@/session/llm/request"
import { SessionPosting } from "@/session/posting"
import { SessionPrompt } from "@/session/prompt"
import { SessionRetry } from "@/session/retry"
import { Session } from "@/session/session"
import { Token } from "@/util/token"
import type { SessionID } from "../../session/schema"
import { GITHUB_ACTIONS_BOT } from "./github.auth"
import { GithubBundle } from "./github.bundle"
import type { GithubBrain } from "./github.brain"
import {
  MINTED_RUN_ID,
  TICKET,
  UPLOAD,
  artifactKey,
  brainDownload,
  everywhereJobBody,
  isRepositoryId,
  type Services,
} from "./github.cloud"
import { buildEvidenceBody, parseNumstat, type EvidenceChange } from "./github.evidence"
import { withGithubCallbacks, withGithubSignals, withRunHeartbeat } from "./github.lifecycle"
import { githubSystemInstructions, untrustedJson } from "./github.policy"
import { WRITE_PERMISSIONS, createReviewGitHub } from "./github.review-api"
import { TASK_MENTIONS, mentionsFrom } from "./github.route"
import { GithubRunHelpers } from "./github.run-helpers"
import { GithubSecrets } from "./github.secrets"
import type { ArtifactIdentity, ArtifactKey, BrainAttachment, DesktopBrainApproval } from "./github.session"
import { GithubSessionProof } from "./github.session-proof"
import { lookupSchedule, UNKNOWN_SCHEDULE } from "./github.schedule"
import { sanitizeActionsLog } from "./github.output"
import { githubFetch } from "./github.shared"

// Fixed log lines. None names a plan, a price or a billing state, and none uses an INV-H1 word.
export const AGENT_NEEDS_CHANNEL =
  "The agent phase runs only inside `vector github sandbox run`, which hands it the run's credentials."
export const DEADLINE_MISSING = "A Codium run needs the deadline its mint step sets in VECTOR_RUN_DEADLINE."
export const SCHEDULE_NOT_YET = UNKNOWN_SCHEDULE
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
// The task line above a request Vector's service dispatched (a ticket run); the request itself follows as labelled JSON.
export const SERVICE_TASK =
  "Vector's service started this task from the Vector app. Its request follows as JSON data labelled untrusted, because it can quote logs and messages from people without write access. Do the repository work it asks for, within this repository's policy."
// The one line a run that serves a Vector everywhere job (R-A4) logs when it cannot read or use the job's request. The
// run then exits 1 with no model request and no bundle, so its settle is `failed`.
export const EVERYWHERE_UNREAD = "Vector could not read this Vector everywhere job's request, so it made no changes."
// A Codium run's conversation save (V27): written and attested to the runner, which uploads it after the job.
export const SESSION_SAVED = "Vector prepared this conversation for follow-ups in this thread."
export const SESSION_NOT_SAVED =
  "Vector could not save this conversation for follow-ups; a follow-up reads the thread instead."
export const SESSION_TOO_LARGE =
  "This conversation is too large to save for follow-ups; a follow-up reads the thread instead."
// A Codium run's conversation restore (V27 "The next run"): one of these when a restore was attempted, none otherwise.
export const SESSION_RESTORED = "Vector continued this thread's saved conversation."
export const SESSION_NOT_RESTORED = "Vector found no saved conversation it could continue; it reads the thread instead."
// The most of the run model's context window a restored history may take, by the compaction's preflight estimate of
// what its turns would send (images at their visual tokens, not their base64): the new trigger, the thread (which every
// run sends again), the system prompt, the tools and the reply need the rest. A history over it, or one that holds a
// compaction, starts a new session from the thread instead.
export const RESTORE_CONTEXT_SHARE = 0.5
// What the codec can add to a conversation of any content: the manifest (at most 4 KiB, its own read cap), the cipher
// header (at most 1 KiB) and frame, the zip headers, and deflate's worst case of about 5 bytes per 16 KiB block (6,533
// bytes in all for 20 MB of random bytes). A conversation within it always fits PATCH_LIMITS.sessionBytes, so no key is
// asked for one that cannot.
export const SESSION_HEADROOM = 16_384
// A desktop-started run's Brain context (B08): one of these when the read was attempted, none otherwise.
export const BRAIN_ATTACHED = "Vector added the Brain context approved in the Vector app to this task."
export const BRAIN_NOT_ATTACHED = "Vector could not add the approved Brain context; this task continues without it."
const BRAIN_REPLY_WITHHELD = "Vector left out output that repeats the approved Brain context."
// The label of the approved Brain context in the first task message. It is descriptive only: the rule for text
// labelled untrusted stays in the system instructions (INV-S14).
export const BRAIN_CONTEXT_LABEL = "Repository context the owner approved in the Vector app (untrusted):"
// How that block opens. A desktop Brain run's task text is a ticket dispatch's prompt, a JSON string literal with every
// "<" escaped (untrustedJson), so in a restored history only the runner's own block holds this.
const BRAIN_CONTEXT_OPEN = `<brain_context>\n${BRAIN_CONTEXT_LABEL} `
// The most of the run model's window the approved Brain context may take, by Token.estimate (about four characters a
// token) of its labelled block: the task, the system prompt, the tools, the work and the reply need the rest. A block
// over it is not attached.
export const BRAIN_CONTEXT_SHARE = 0.25

export function refusedEvent(name: string) {
  return `Nothing to do: ${name} events do not start agent tasks.`
}

/** The log line for a run that stopped early: 2.9.2's reason line, never a gateway's message (P6). */
export function stoppedLine(stop: GithubBundle.Stop) {
  return stop.reason === GithubBundle.STOP_REASON.early ? `${stop.reason}.` : `Vector stopped early: ${stop.reason}.`
}

// GitHub's own limit for a webhook payload is 25 MB.
const EVENT_LIMIT = 25 * 1024 * 1024
const RUN_ID = /^[1-9]\d{0,19}$/
// No real mint's deadline lies further ahead than the Codium agent job's own timeout (O8), so no timer needs clamping.
const DEADLINE_AHEAD_MS = GithubAgents.TIMEOUT_MIN.codiumAgent * 60_000
// How often a stopped run cancels its session again while the session's turns may still run.
export const CANCEL_REPEAT_MS = 1000
// Nobody can answer a question in an Action. A new session is created with this rule, and a restored one, which the
// archive's import creates with no rule, gets it before its first turn.
const NO_QUESTIONS = [{ permission: "question", action: "deny" as const, pattern: "*" }]

export type AgentCredentials = Pick<
  ReturnType<typeof GithubSecrets.createGithubSecrets>,
  "loaded" | "githubToken" | "runToken" | "redact" | "sessionProof"
>

/** The run's root session as an encoded archive, the format SessionArchive.import reads. */
export type SessionExport = (
  sessionID: SessionID,
) => Effect.Effect<{ readonly [field: string]: unknown; readonly privacy?: "owner-only" }, unknown>

/**
 * What a Codium run's conversation save uses (V27), each the real one by default: the ordinary conversation key client,
 * the session archive's export (absent when this process has no archive), the session codec (given the approved Brain
 * bundle on a desktop Brain run), and the runner's attestation of the written bytes.
 */
export type SessionSave = {
  artifactKey: typeof artifactKey
  exportSession?: SessionExport
  encrypt: (input: {
    identity: ArtifactIdentity
    key: ArtifactKey
    session: unknown
    brain?: BrainAttachment
  }) => Promise<Uint8Array>
  attest: (bytes: Uint8Array) => boolean
}

/** The archive's import of a restored session.json into this instance's directory (SessionArchive.import). */
export type SessionImport = (
  archive: unknown,
) => Effect.Effect<{ readonly sessionID: SessionID; readonly engine: "v1" | "v2" }, unknown>

/**
 * What a Codium run's conversation restore uses (V27 "The next run"), each the real one by default: the GET-only
 * transport (readOnlyFetch) for the artifact list, the artifact's zip and its signed storage address, and the archive's
 * import (absent when this process has no archive). The key client is SessionSave's artifactKey.
 */
export type SessionRestore = {
  request: (url: string, init: RequestInit) => Promise<Response>
  importSession?: SessionImport
}

/**
 * What a desktop Brain run's context read uses (B08), the real one by default: the local open and verify of the
 * envelope brain-download answered (GithubBrain.openUpload, loaded only once a download answered).
 */
export type BrainRead = {
  open: (...input: Parameters<typeof GithubBrain.openUpload>) => Promise<ReturnType<typeof GithubBrain.openUpload>>
}

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
  /** Time, the deadline timer and the heartbeat interval; the process's own by default. */
  clock?: Partial<AgentClock>
  /** What a Codium run's conversation save uses; the real ones by default. */
  session?: Partial<SessionSave>
  /** What a Codium run's conversation restore uses; the real ones by default. */
  restore?: Partial<SessionRestore>
  /** What a desktop Brain run's context read uses; the real opener by default. */
  brain?: Partial<BrainRead>
}

export type AgentClock = {
  /** Epoch milliseconds, the clock VECTOR_RUN_DEADLINE is written in. */
  now: () => number
  /** Calls `fire` after `ms`; the answer cancels it. */
  timer: (ms: number, fire: () => void) => () => void
  /** The time between a Codium run's running heartbeats. */
  heartbeatMs: number
  /** The shortest wait between a Codium run's concurrency retries (SessionRetry's GatewayRule.minDelayMs). */
  minDelayMs: number
}

const CLOCK: AgentClock = {
  now: Date.now,
  timer: (ms, fire) => {
    const id = setTimeout(fire, ms)
    return () => clearTimeout(id)
  },
  heartbeatMs: GithubAgents.HEARTBEAT_SECONDS * 1000,
  minDelayMs: SessionRetry.RETRY_INITIAL_DELAY,
}

export type AgentPhaseResult = {
  exitCode: 0 | 1
  outcome?: GithubAgents.Outcome
  summary?: GithubBundle.RunSummary
}

export type AgentRoute = {
  kind: "issue" | "pr" | "dispatch" | "schedule"
  scheduleId?: string
  thread: string
  number?: number
  /** The writer's task: the comment, the issue's text after its mention, or the dispatch's prompt. */
  trigger: string
  /** Whose write access the phase checks again before any model request. */
  login: string
  comment?: GithubRunHelpers.AgentComment & { id: number; in_reply_to_id?: number }
  review: boolean
  /** A Codium dispatch from Vector's App bot with a one-time ticket: its prompt is labelled untrusted data. */
  ticket?: true
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
  const env = input.env ?? process.env
  const credentials = input.credentials ?? GithubSecrets.credentials
  const clock = { ...CLOCK, ...input.clock }
  const codium = env.VECTOR_MODE === "codium"
  // Only an own-key run with the workflow's consent shares; the service is looked up then, never required. Codium
  // never shares (2.13).
  const consent = codium ? undefined : input.share
  const share = consent ? Option.getOrUndefined(yield* Effect.serviceOption(PublicSessionShare.Service)) : undefined
  // A Codium run's conversation save and restore use only the archive's export and import, never publish or flush, so
  // they reach no sharing endpoint (2.13). The service is looked up only then; own key never looks it up for this.
  const archive =
    codium && (!input.session?.exportSession || !input.restore?.importSession)
      ? Option.getOrUndefined(yield* Effect.serviceOption(PublicSessionShare.Service))
      : undefined
  const session: SessionSave = {
    artifactKey: input.session?.artifactKey ?? artifactKey,
    exportSession:
      input.session?.exportSession ??
      (archive ? (sessionID) => archive.export({ sessionID }).pipe(Effect.map(portableArchive)) : undefined),
    encrypt: input.session?.encrypt ?? encryptSession,
    attest: input.session?.attest ?? GithubSessionProof.attestSessionArtifact,
  }
  // The restored session lives in this instance's directory, where sessions.create puts a new one: in a hosted run,
  // the checked-out worktree.
  const restore: SessionRestore = {
    request: input.restore?.request ?? readOnlyFetch,
    importSession:
      input.restore?.importSession ??
      (archive
        ? (value) =>
            archive.import({
              archive: value,
              location: Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }),
            })
        : undefined),
  }
  const brain: BrainRead = { open: input.brain?.open ?? openBrain }
  const kept: Deps["kept"] = {}
  const halt = haltSwitch()
  const settled = { outcome: "failed" as GithubAgents.Outcome }
  const phase = withGithubCallbacks((run) =>
    Effect.promise((signal) =>
      agentPhase({
        env,
        credentials,
        services: input.services,
        consent,
        log: (line) => (input.log ?? console.log)(sanitizeActionsLog(credentials.redact(line))),
        error: (line) => (input.error ?? console.error)(sanitizeActionsLog(credentials.redact(line))),
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
        codium,
        clock,
        halt,
        session,
        restore,
        brain,
        kept,
      }),
    ),
  ).pipe(Effect.tap((result) => Effect.sync(() => (settled.outcome = result.outcome ?? "failed"))))
  // A Codium run heartbeats from the gate's starting beat to its settle, which carries the phase's outcome: the
  // bundle's, `refused` for a refusal, `failed` for an exit 1, `cancelled` on a signal. A heartbeat that says stop, or
  // fails, stops the session as the deadline does. The mode decides, not the token: own key never heartbeats or
  // settles (INV-K1).
  return yield* (
    codium
      ? withRunHeartbeat(phase, {
          onStop: () => halt.halt(GithubBundle.DEADLINE),
          outcome: () => settled.outcome,
          credentials,
          services: input.services,
          intervalMs: clock.heartbeatMs,
        })
      : phase
  ).pipe(withGithubSignals)
})

/**
 * The run's one stop: the first of the local deadline and the heartbeat's stop wins, and what waits on it (the session's
 * cancel) runs once, at once when the run had already stopped.
 */
function haltSwitch() {
  const state: { stop?: GithubBundle.Stop; hooks: Set<() => void> } = { hooks: new Set() }
  return {
    reason: () => state.stop,
    halt(stop: GithubBundle.Stop) {
      if (state.stop) return
      state.stop = stop
      state.hooks.forEach((hook) => hook())
    },
    onHalt(hook: () => void) {
      if (state.stop) {
        hook()
        return () => {}
      }
      state.hooks.add(hook)
      return () => {
        state.hooks.delete(hook)
      }
    },
  }
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
  /** VECTOR_MODE is codium: the run heartbeats, follows 2.9.2 and logs P6-safe lines. */
  codium: boolean
  clock: AgentClock
  halt: ReturnType<typeof haltSwitch>
  session: SessionSave
  restore: SessionRestore
  brain: BrainRead
  /**
   * What a desktop Brain run opened, set by readBrain right after an open that carried the Brain key, and read by the
   * conversation restore before any session exists and by the save in record() whatever work() returned. A run that
   * failed has no session, so it saves nothing (deviations BT07b item 4).
   */
  kept: { brain?: BrainContext; publicBrain?: readonly string[] }
}

// What a phase that SIGINT or SIGTERM cancelled hands back: nobody reads it, and it writes no bundle (2.13).
const CANCELLED: AgentPhaseResult = { exitCode: 1, outcome: "cancelled" }

async function agentPhase(deps: Deps): Promise<AgentPhaseResult> {
  if (!deps.credentials.loaded()) {
    deps.error(AGENT_NEEDS_CHANNEL)
    return { exitCode: 1 }
  }
  if (deps.env.VECTOR_MODE !== "own-key" && deps.env.VECTOR_MODE !== "codium") {
    deps.error(UNKNOWN_MODE)
    return { exitCode: 1 }
  }
  // Only the account gate's starting heartbeat authorizes a run token; without one there is no run to settle.
  if (deps.codium && !deps.credentials.runToken()) {
    deps.error(GithubSecrets.CODIUM_UNAUTHORIZED)
    return { exitCode: 1 }
  }
  const now = deps.clock.now()
  const deadline = runDeadline(deps.env.VECTOR_RUN_DEADLINE, now)
  // Without its mint's deadline a Codium run cannot stop in time to save its work, so it fails closed.
  if (deps.codium && deadline === undefined) {
    deps.error(DEADLINE_MISSING)
    return { exitCode: 1 }
  }
  const left = deadline === undefined ? undefined : deadline - GithubAgents.STOP_MARGIN_SECONDS * 1000 - now
  // A stop time already passed stops the run now, before any model request; otherwise a timer stops it then.
  if (left !== undefined && left <= 0) deps.halt.halt(GithubBundle.DEADLINE)
  const clear =
    left !== undefined && left > 0 ? deps.clock.timer(left, () => deps.halt.halt(GithubBundle.DEADLINE)) : () => {}
  if (deps.codium) SessionRetry.pinGateway(gatewayRule(deps.clock))
  return runTask(deps).finally(() => {
    clear()
    if (deps.codium) SessionRetry.pinGateway(undefined)
  })
}

async function runTask(deps: Deps): Promise<AgentPhaseResult> {
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
  if ("cancelled" in start) return CANCELLED
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

type Start = Exclude<Awaited<ReturnType<typeof begin>>, { refused: string } | { cancelled: true }>

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
  // R-A4: a ticket dispatch of Vector everywhere's job line reads that job's request here, after every check above and
  // before any model request or GitHub read. A throw ends the run with its line and no bundle, and settles `failed`; a
  // signal during the read ends it as every other signal does, cancelled and with no line (2.13).
  const everywhere = route.ticket
    ? await everywhereRequest(route, { repository, payload: event.payload }, deps)
    : undefined
  if (everywhere === "cancelled") return { cancelled: true as const }
  return {
    route,
    instructions: everywhere ? `${instructions}\n\n${everywhere.instructions}` : instructions,
    owner,
    repo,
    token,
    gh,
    review,
    baseSha: head.text().trim(),
    runUrl: `${(deps.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "")}/${owner}/${repo}/actions/runs/${runId}`,
    // The run's own view of its visibility (deviations BT04 item 5): public whenever the payload cannot tell.
    publicRepository: !PrivateRepository.safeParse(event.payload).success,
    everywhere,
  }
}

/**
 * R-A4: the request of the Vector everywhere job a ticket dispatch serves, framed for the run, or undefined when its
 * prompt is not the job line. Only a raw VECTOR_PROMPT that is exactly ACTIONS_JOB_PROMPT and a job id reads. The id
 * is only a claim: only the body route's 200 makes the run an everywhere job (vector-everywhere-deviations.md, EV-27
 * (b)), and every other outcome throws EVERYWHERE_UNREAD before any model request, except a SIGINT or SIGTERM that
 * ended the read or its wait, which answers "cancelled" (2.13). The run cannot tell a run no job links from a job whose
 * body is spent or lost, so the job line never runs as a service task, and neither does a prompt that is the line only
 * once trimmed, which reads nothing.
 */
async function everywhereRequest(route: AgentRoute, input: { repository: string; payload: unknown }, deps: Deps) {
  const jid = jobOfActionsPrompt(deps.env.VECTOR_PROMPT)
  if (jid === undefined && jobOfActionsPrompt(route.trigger) === undefined) return undefined
  const request = jid === undefined ? undefined : await readRequest(jid, input, deps).catch(() => undefined)
  if (request) return request
  // The run's signal ended the read or its wait: that is the run's cancel, not a request it could not read.
  if (deps.signal.aborted) return "cancelled" as const
  throw new Error(EVERYWHERE_UNREAD)
}

/**
 * The read and the frame, in order. Nothing is read for a payload that does not say the repository is private (E11,
 * the event's view; the route checks the job's own), a malformed repository name, or a Brain upload (the server pairs
 * one only with a desktop run, never with an everywhere job). The run's stop is joined to the read's signal, and
 * onHalt fires at once for a run that has already stopped, so a stop before or during the read, like a signal, ends
 * it with no further request. A 200 becomes frameTask's block, whose task field alone is the task, the platform's
 * everywhere policy for the system text, and the platform as the task turns' outside marker. The kind is fixed:
 * frameTask reads it only for an empty task, which the body never has. Any failure answers undefined or throws.
 */
async function readRequest(jid: string, input: { repository: string; payload: unknown }, deps: Deps) {
  if (
    !PrivateRepository.safeParse(input.payload).success ||
    !isRepositoryName(input.repository) ||
    deps.env.VECTOR_BRAIN_UPLOAD
  )
    return undefined
  const stop = new AbortController()
  const unhook = deps.halt.onHalt(() => stop.abort())
  const answer = await everywhereJobBody({
    jid,
    holder: deps.credentials,
    services: deps.services,
    signal: AbortSignal.any([deps.signal, stop.signal]),
  }).finally(unhook)
  if (answer.status !== "ok") return undefined
  const job = {
    platform: answer.body.outside,
    kind: "mention" as const,
    repository: { fullName: input.repository },
    task: answer.body.task,
    context: answer.body.context,
  }
  return { outside: job.platform, instructions: everywhereSystemInstructions(job), message: frameTask(job) }
}

// What the task is: the writer checked again, the thread's labelled text, and the pull request's head branch.
async function gather(start: Start, deps: Deps) {
  // R-A4: a Vector everywhere job's framed request is the message as it stands. Only its task field is the task, and
  // the policy and the untrusted-data rule are in the pinned system instructions, so it gets no SERVICE_TASK line.
  if (start.everywhere)
    return {
      message: start.everywhere.message,
      files: [] as GithubRunHelpers.PromptFiles,
      threadTitle: undefined,
      headRef: undefined,
    }
  if (start.route.kind === "schedule")
    return {
      message: start.route.trigger,
      files: [] as GithubRunHelpers.PromptFiles,
      threadTitle: undefined,
      headRef: undefined,
    }
  // Vector's App bot has no collaborator permission: mint step 8 verified the bot and its one-time ticket instead. Its
  // prompt can quote people without write access, so it is labelled untrusted data under a fixed task line (INV-S14).
  if (start.route.ticket)
    return {
      message: `${SERVICE_TASK}\n\n<service_request>\nPrompt (untrusted): ${untrustedJson(start.route.trigger)}\n</service_request>`,
      files: [] as GithubRunHelpers.PromptFiles,
      threadTitle: undefined,
      headRef: undefined,
    }
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
        log: deps.log,
        error: deps.error,
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

/**
 * What a desktop Brain run opened with its Brain key (B08), as GithubBrain.openUpload returned it: the exact approved
 * bytes, their approval and the Brain conversation key. Never active memory.
 */
type BrainContext = { bytes: Uint8Array; approval: DesktopBrainApproval; brainKey: ArtifactKey }

async function work(start: Start, task: Task, deps: Deps): Promise<Result> {
  const fallback = () => task.threadTitle?.trim() || FALLBACK_TITLE
  // The stop time had passed before the session: nothing is sent, and the run is recorded as stopped.
  const early = deps.halt.reason()
  if (early) {
    deps.error(stoppedLine(early))
    return { end: early, title: fallback(), body: "", comment: "" }
  }
  const providers = await deps.run(deps.provider.list())
  const model = agentModel({ mode: deps.codium ? "codium" : "own-key", model: deps.env.MODEL, providers })
  const info = providers[model.providerID]?.models[model.modelID]
  // B08: a desktop-started Codium run reads the Brain context its owner approved, once, before any session. A signal
  // during it ends the run here, before any session is created.
  const block = deps.codium ? await brainContext(start, info, deps) : undefined
  if (block === "aborted") return { end: deps.halt.reason(), title: fallback(), body: "", comment: "" }
  // V27 "The next run": a Codium run continues its thread's saved conversation when it can, otherwise starts a new
  // session exactly as before. It runs before the log subscription, since the import publishes the restored parts and
  // none of them may reach the public log. A signal during it ends the run here, before any session is created.
  const restored = deps.codium ? await restoreConversation(start, info, deps) : undefined
  if (restored === "aborted") return { end: deps.halt.reason(), title: fallback(), body: "", comment: "" }
  if (!block && !restored?.brain) deps.kept.publicBrain = undefined
  const sessionID = restored?.sessionID ?? (await deps.run(deps.sessions.create({ permission: NO_QUESTIONS }))).id
  const shared = await publish(sessionID, deps)
  await GithubRunHelpers.subscribeSessionEvents({
    run: deps.run,
    sessions: deps.sessions,
    sessionID,
    events: deps.events,
    permissions: deps.permissions,
    clean: deps.credentials.redact,
    write: deps.log,
    // A public Brain run's generated text is logged after checking the whole result. A phrase can span events.
    logDetails: !deps.kept.publicBrain,
  })
  deps.log(`vector session ${sessionID}`)
  const chat = {
    run: deps.run,
    prompt: deps.prompt,
    sessionID,
    model,
    halted: () => deps.halt.reason() !== undefined,
    // A Vector everywhere job's turns are its platform's outside text (R-A4); every other run's are GitHub's.
    outside: start.everywhere?.outside,
    // On Codium a turn's error object holds the gateway's own words, which no public log may print (P6).
    reportError: deps.codium ? () => {} : (label: string, error: unknown) => deps.error(`${label} ${messageOf(error)}`),
  }
  // A stop cancels the session's running turn, and chat sends no turn once the run has stopped. A stop that lands
  // after chat's check and before the turn's loop starts finds nothing to cancel, so the cancel repeats every
  // CANCEL_REPEAT_MS until the session's turns are over. Nothing between here and the end of the turns rejects: chat's
  // failure is handled below, and summarize answers the fallback title on any failure.
  const cancels = { over: false, clear: () => {} }
  const cancel = () => {
    if (cancels.over) return
    void deps.run(deps.prompt.cancel(sessionID)).catch(() => {})
    cancels.clear = deps.clock.timer(CANCEL_REPEAT_MS, cancel)
  }
  const unhook = deps.halt.onHalt(cancel)
  // The approved Brain context follows the task once, as labelled data; it is never written into the runner's Brain. A
  // re-run attempt that continued a history saved with the same approved bundle, whose task message already holds
  // the block, does not send it twice; one whose earlier attempt had no room for it sends it now.
  const reply = await GithubRunHelpers.chat(chat, task.message, task.files, restored?.brain ? undefined : block).then(
    (response) => ({ response, end: deps.halt.reason() }),
    (cause: unknown) => {
      const end = deps.halt.reason() ?? stopOf(cause, deps.codium)
      deps.error(errorLine(cause, end, deps))
      return { response: "", end }
    },
  )
  const title =
    reply.end || deps.halt.reason() ? fallback() : await GithubRunHelpers.summarize(chat, reply.response, fallback)
  unhook()
  cancels.over = true
  cancels.clear()
  // A stop that cut only the title turn still marks the run as stopped, the more conservative outcome (INV-S17).
  const end = reply.end ?? deps.halt.reason()
  const evidence = await GithubRunHelpers.collectSessionEvidence({ run: deps.run, sessions: deps.sessions, sessionID })
  const body = buildEvidenceBody({
    response: reply.response,
    changes: await changesOf(start, sessionID, deps),
    // Restored turns are earlier runs' own work: their checks and cost are not this run's evidence and are never
    // posted again.
    messages: evidence.messages.filter((message) => !restored?.messages.has(message.info.id)),
    judge: evidence.judge,
    runUrl: start.runUrl,
    shareUrl: shared?.url,
    checkFormat: "indented",
    trigger: start.route.kind === "dispatch" ? "Triggered by workflow_dispatch" : undefined,
  })
  return {
    end,
    title,
    body,
    comment: reply.response,
    sessionID,
    shared: shared !== undefined,
  }
}

// A failure before the session could finish: the run's own stop, or the error's row, with the fixed title.
function failure(cause: unknown, deps: Deps): Result {
  const end = deps.halt.reason() ?? stopOf(cause, deps.codium)
  deps.error(errorLine(cause, end, deps))
  return { end, title: FALLBACK_TITLE, body: "", comment: "" }
}

async function record(start: Start, task: Partial<Task>, result: Result, deps: Deps): Promise<AgentPhaseResult> {
  // A signal ended the phase: its settle is `cancelled`, and no bundle is written (2.13).
  if (deps.signal.aborted) return CANCELLED
  // Everything the run hands publish still goes through the owner's memory check (section 6.4a). Nobody is there to
  // answer, so repeated text is dropped, and a check that cannot run keeps none.
  const fallback = task.threadTitle?.trim() || FALLBACK_TITLE
  const parts = [result.title, result.body, result.comment]
  const publicBrain = deps.kept.publicBrain
  // Check the three destinations together. The verified attachment is held only as facts for this output check.
  const echoed = new Set(
    publicBrain
      ? BrainPosting.check({
          parts,
          typed: false,
          memory: { habits: [], facts: publicBrain },
          known: new Set(),
        }).dropped.map((item) => item.part)
      : [],
  )
  const replacements = [FALLBACK_TITLE, BRAIN_REPLY_WITHHELD, BRAIN_REPLY_WITHHELD]
  if (echoed.size) deps.log(BRAIN_REPLY_WITHHELD)
  const [title, body, comment] = await deps
    .run(
      SessionPosting.headless({
        parts: parts.map((value, index) => (echoed.has(index) ? replacements[index]! : value)),
        typed: false,
        untrusted: false,
        sessionIDs: result.sessionID ? [result.sessionID] : [],
        log: deps.log,
      }),
    )
    .catch((cause: unknown) => {
      deps.error(publicBrain ? WITHHELD : messageOf(cause))
      return [fallback, WITHHELD, WITHHELD]
    })
  if (result.shared && result.sessionID && deps.share) {
    // The bundle is written either way (2.13): a share that cannot finish only logs.
    await deps.run(deps.share.flush(result.sessionID)).catch((cause: unknown) => {
      deps.error(`Could not finish updating the public session: ${messageOf(cause)}`)
    })
  }
  // V27: a Codium run saves its conversation for the next run of its thread before the bundle; own key never does
  // (INV-K1).
  if (deps.codium && !deps.signal.aborted) await saveConversation(start, result, deps)
  if (deps.signal.aborted) return CANCELLED
  const written = await GithubBundle.writeBundle({
    cwd: deps.worktree,
    baseSha: start.baseSha,
    route: bundleRoute(start.route, task.headRef, deps.codium ? "codium" : "own-key"),
    // The check drops whole sentences, so a title that only repeats memory comes back empty.
    title: deps.credentials.redact(title?.trim() || fallback),
    body: deps.credentials.redact(body ?? ""),
    comment: deps.credentials.redact(comment ?? ""),
    ...(result.end ? { end: result.end } : {}),
  }).catch((cause: unknown) => ({ crash: publicBrain ? "Vector could not record this run." : messageOf(cause) }))
  if ("crash" in written) {
    deps.error(written.crash)
    return { exitCode: 1 }
  }
  if (publicBrain && !echoed.has(2) && comment) deps.log(comment)
  deps.log(`Vector recorded the run: ${written.summary.outcome}.`)
  return { exitCode: 0, outcome: written.summary.outcome, summary: written.summary }
}

/**
 * V27 "The file": a Codium run saves its conversation for the next run of its own thread. The run's root session, in
 * the encoded archive format SessionArchive.import reads and redacted with the run's credentials, is encrypted for this
 * run's identity, written once to `<worktree>/vector-out/session.vsa`, and then attested to the runner, whose finish
 * refuses the whole bundle for a session file it cannot match. On return the file holds exactly the attested bytes or
 * is absent. The key is the ordinary conversation key, except on a desktop Brain run (Brain history restriction): a
 * run that can download Brain context, whose download may already have recorded it at the server, saves only under the
 * Brain key its opened download gave it, with the exact approved bundle and its approval as brain/bundle.json, and
 * never asks for the ordinary key. It writes no brain/proposals.json (deviations BT07b item 2). Failure is never fatal:
 * it costs only the saved conversation and logs one fixed line. Nothing is attempted, and nothing is logged, without
 * the runner's proof channel or a session, on a run with an upload id that opened no Brain key, or once a signal ended
 * the run. It never rejects.
 */
async function saveConversation(start: Start, result: Result, deps: Deps) {
  const dir = path.join(deps.worktree, GithubAgents.BUNDLE_DIR)
  const file = path.join(dir, GithubAgents.SESSION_FILE)
  // Only inside a real directory: a linked vector-out is never followed.
  const clear = () =>
    fs
      .lstat(dir)
      .then((info) => (info.isDirectory() ? fs.rm(file, { force: true, recursive: true }) : undefined))
      .catch(() => undefined)
  // A session file the model left would make the runner refuse the whole bundle, so it goes on every Codium run.
  await clear()
  // R-A4: a Vector everywhere job's conversation holds its platform's text, which must not outlive the job's body (E4)
  // or be kept where erasing the job cannot reach it (E13), so it is never saved and asks for no key.
  if (start.everywhere) return
  const sessionID = result.sessionID
  // Without the proof channel the runner accepts no session file, so the run never asks for the key. A run with an
  // upload id saves only under the Brain key its opened download gave it: a writer's dispatch that carries one, a
  // refused, failed or unopened read, or an answer without the key saves nothing and asks for no ordinary key. A ticket
  // dispatch without an upload still asks: only the server knows its trigger source, and it refuses only a desktop run
  // (2.8), so a ticket run from any other source (Release Guard, On Call) saves what its owner's result read opens.
  if (!sessionID || !deps.credentials.sessionProof()) return
  if (deps.env.VECTOR_BRAIN_UPLOAD && !deps.kept.brain) return
  const attempted = await writeConversation(start, sessionID, { dir, file }, deps).catch(() => "failed" as const)
  // A signal ended the run while the save ran: nothing is kept and nothing is said, whatever the save reached.
  const outcome = deps.signal.aborted ? "aborted" : attempted
  if (outcome !== "saved") await clear()
  if (outcome === "aborted") return
  deps.log(outcome === "saved" ? SESSION_SAVED : outcome === "too-large" ? SESSION_TOO_LARGE : SESSION_NOT_SAVED)
}

/**
 * The save's steps in order. Every check of the run and its conversation comes before the key request, so a run that
 * cannot save its conversation spends none of its artifact-key requests; a desktop Brain run makes none, since its key
 * came with its download. Its approved bundle travels in the same encrypted zip, so the size counts it too; it is
 * written as approved (the desktop's posting check screened it at pack time, and its digest binds it), while the
 * session is redacted. Only the write's own refusal of a vector-out that is not a real directory comes after the key,
 * where it guards the write itself. Any throw is the caller's "failed".
 */
async function writeConversation(start: Start, sessionID: SessionID, paths: { dir: string; file: string }, deps: Deps) {
  const identity = conversationIdentity(start, deps.env)
  if (!identity || !deps.session.exportSession) return "failed"
  const local = await deps.run(deps.session.exportSession(sessionID))
  // Owner-only work would reach every later run of the thread.
  if (local.privacy === "owner-only") return "failed"
  const text = deps.credentials.redact(JSON.stringify(local))
  const brain = deps.kept.brain
  if (
    Buffer.byteLength(text) + (brain?.bytes.byteLength ?? 0) >
    GithubAgents.PATCH_LIMITS.sessionBytes - SESSION_HEADROOM
  )
    return "too-large"
  const conversation = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text))
  if (conversation === undefined) return "failed"
  const answer = brain
    ? { status: "ok" as const, key: brain.brainKey }
    : await deps.session.artifactKey({
        env: deps.env,
        holder: deps.credentials,
        services: deps.services,
        signal: deps.signal,
      })
  if (deps.signal.aborted) return "aborted"
  if (answer.status !== "ok") return "failed"
  const bytes = await deps.session.encrypt({
    identity,
    key: answer.key,
    session: conversation,
    ...(brain ? { brain: { path: "brain/bundle.json" as const, bytes: brain.bytes, approval: brain.approval } } : {}),
  })
  if (deps.signal.aborted) return "aborted"
  // The first point where vector-out may be created; each write is new, exclusive and private, as writeBundle's are.
  await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 })
  if (!(await fs.lstat(paths.dir)).isDirectory()) return "failed"
  await fs.rm(paths.file, { force: true, recursive: true })
  await fs.writeFile(paths.file, bytes, { flag: "wx", mode: 0o600 })
  return deps.session.attest(bytes) ? "saved" : "failed"
}

/**
 * The conversation's identity, only from what the runner and mint set: the repository id GitHub gives the job, the
 * route's thread (begin() checked it equals VECTOR_THREAD) and the run id mint wrote to VECTOR_RUN_ID, which must name
 * this repository, run and attempt. Anything else is no identity, so no key is asked for.
 */
function conversationIdentity(start: Start, env: Readonly<Record<string, string | undefined>>) {
  const repositoryId = env.GITHUB_REPOSITORY_ID ?? ""
  const rid = env.VECTOR_RUN_ID ?? ""
  if (
    !isRepositoryId(repositoryId) ||
    !MINTED_RUN_ID.test(rid) ||
    !rid.startsWith(`gh-${repositoryId}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-`)
  )
    return undefined
  return { repositoryId, thread: start.route.thread, rid }
}

// The encoded archive SessionArchive.import decodes; `vector export` writes a native one the same way (export.ts).
function portableArchive(local: SessionArchive.Local) {
  return "engine" in local
    ? Schema.encodeSync(SessionArchive.Native)(local)
    : Schema.encodeSync(SessionArchive.Legacy)(local)
}

// The codec loads zip.js, so only a run that saves its conversation loads it.
async function encryptSession(input: Parameters<SessionSave["encrypt"]>[0]) {
  const { encryptConversation } = await import("./github.session")
  return encryptConversation(input)
}

/**
 * B08 (spec V27 "B08 source authority"): a desktop-started Codium run reads the Brain context its owner approved in the
 * Vector app. Only Vector's App-bot ticket dispatch (`route.ticket`: Codium, workflow_dispatch, task mode, a verified
 * ticket) with a well-formed VECTOR_BRAIN_UPLOAD asks, once, after every check of the run: the stop, the job's
 * repository id and the run model's window (`model`, BRAIN_CONTEXT_SHARE). The envelope is opened and verified here
 * against the server's and the event's view of the repository's visibility, and the decoded bundle (memory entries,
 * skills, which only a private repository's bundle can hold, and insight rows) becomes one labelled untrusted JSON block
 * for the first task message, which this answers; it never enters this runner's Brain. An open that carried the Brain
 * key also keeps the bytes, the approval and the key for the conversation's restore and save (`Deps.kept`). Failure is
 * never fatal: a refusal, an outage, a failed open or a block over the share logs one fixed line and the task runs
 * without it. Nothing is attempted, and nothing is logged, on any other route, without a well-formed id, or once the
 * run stopped; a stop during the read attaches nothing and logs nothing, and a signal answers "aborted". It never
 * rejects.
 */
async function brainContext(start: Start, model: Provider.Model | undefined, deps: Deps) {
  const uploadId = deps.env.VECTOR_BRAIN_UPLOAD ?? ""
  if (!start.route.ticket || !UPLOAD.test(uploadId) || deps.halt.reason()) return undefined
  const repositoryId = deps.env.GITHUB_REPOSITORY_ID ?? ""
  const room = Math.floor((model?.limit.input || model?.limit.context || 0) * BRAIN_CONTEXT_SHARE)
  if (!isRepositoryId(repositoryId) || room <= 0) {
    deps.log(BRAIN_NOT_ATTACHED)
    return undefined
  }
  const read = await readBrain({ repositoryId, uploadId, publicRepository: start.publicRepository }, room, deps).catch(
    () => undefined,
  )
  if (deps.signal.aborted) return "aborted" as const
  if (deps.halt.reason()) return undefined
  deps.log(read ? BRAIN_ATTACHED : BRAIN_NOT_ATTACHED)
  return read
}

/**
 * The read's steps in order: the one brain-download request, then the local open and verify, then the block and its
 * size. The download answer, whose `aad` names the account and whose `key` opens the envelope, is used only here and
 * never logged or given to the model. A stop or a signal during the download skips the open. An open that carried the
 * Brain key is kept before the size gate: the server recorded Brain context at this read, so this run's conversation
 * can be saved only under that key even when the block is too large to attach. Any refusal answers undefined, and any
 * throw is the caller's undefined.
 */
async function readBrain(
  expected: { repositoryId: string; uploadId: string; publicRepository: boolean },
  room: number,
  deps: Deps,
) {
  const answer = await brainDownload({
    env: deps.env,
    holder: deps.credentials,
    services: deps.services,
    signal: deps.signal,
  })
  if (answer.status !== "ok" || deps.signal.aborted || deps.halt.reason()) return undefined
  const opened = await deps.brain.open(answer.download, expected)
  if (!opened) return undefined
  if (opened.brainKey) deps.kept.brain = { bytes: opened.bytes, approval: opened.approval, brainKey: opened.brainKey }
  if (expected.publicRepository || opened.approval.publicRepository) {
    const { BrainRunBundle } = await import("@vectordevai/core/brain/run-bundle")
    const { parts } = BrainRunBundle.select({
      publicRepository: true,
      memory: opened.bundle.memory,
      shareableSkills: [],
      insights: opened.bundle.insights,
    })
    if (parts.length) deps.kept.publicBrain = parts
  }
  const block = `${BRAIN_CONTEXT_OPEN}${untrustedJson(
    JSON.stringify({
      memory: opened.bundle.memory.entries,
      skills: opened.bundle.memory.skills ?? [],
      insights: opened.bundle.insights.rows,
    }),
  )}\n</brain_context>`
  return Token.estimate(block) > room ? undefined : block
}

// The opener pulls core's Brain module graph (deviations BT04 item 8), so only a run whose download answered loads it.
async function openBrain(...input: Parameters<BrainRead["open"]>) {
  const { GithubBrain } = await import("./github.brain")
  return GithubBrain.openUpload(...input)
}

/**
 * V27 "The next run": a Codium run continues the conversation its thread's last run saved. The newest unexpired
 * `vector-session-<thread>` artifact that a run of this repository (never a fork's) uploaded is read with the job's
 * read-only GITHUB_TOKEN, opened under the ordinary key for this run's own thread and bound to the job's repository id
 * and that thread, and imported into this instance as a new session, which gets the question rule. A desktop Brain run
 * opens it only under the Brain key its own download gave it, and continues it only when its Brain provenance has the
 * same approved digest, audience and visibility (allowConversationRestore with its approval; the Brain history
 * restriction). `model` is the run model, whose window bounds the restored history (RESTORE_CONTEXT_SHARE, by
 * SessionCompaction.estimate). Failure is never fatal: no artifact, a list or download that fails, a key refusal, a
 * file that does not open, Brain or proposal provenance without that approval, an archive the agent phase cannot
 * continue, a history over the share or one that holds a compaction, or a failed import each start a new session from
 * the thread with one fixed line. Nothing is attempted, and nothing is logged, without the runner's proof channel, on
 * a run with an upload id that opened no Brain key, on a ticket dispatch without one, on a dispatch's first attempt, or
 * once the run stopped; a signal that ended the run answers "aborted". It never rejects.
 */
async function restoreConversation(start: Start, model: Provider.Model | undefined, deps: Deps) {
  // A key is used only where the run could also save its conversation: with the runner's proof channel. A run with an
  // upload id never gets the ordinary key (2.8, ARTIFACT_KEY_NOT_ALLOWED), so it restores only under the Brain key its
  // opened download gave it. A ticket dispatch without one has nothing to restore: its thread is dispatch-<runId>, and
  // its single-use ticket lets no re-run attempt mint (deviations BT06 item 3). That holds for a Brain run's re-run
  // attempt too, so its restore cannot be reached in production today (deviations BT07b item 5).
  if (!deps.credentials.sessionProof() || (deps.env.VECTOR_BRAIN_UPLOAD ? !deps.kept.brain : start.route.ticket))
    return undefined
  // A dispatch's thread is dispatch-<runId>: only an earlier attempt of this run can have saved it.
  if (start.route.kind === "dispatch" && !(Number(deps.env.GITHUB_RUN_ATTEMPT) > 1)) return undefined
  const restored = await readConversation(start, model, deps).catch(() => undefined)
  if (deps.signal.aborted) return "aborted" as const
  if (restored === "stopped") return undefined
  deps.log(restored ? SESSION_RESTORED : SESSION_NOT_RESTORED)
  return restored
}

/**
 * The restore's steps in order. The run's own checks come before the list, and the list and download before the key
 * request, so a thread with no artifact spends none of its artifact-key requests; a desktop Brain run (`Deps.kept`)
 * makes none, since its key came with its download. A stop (the deadline or the heartbeat) seen before the list, the
 * key request or the import answers "stopped", so a stopped run spends nothing more on it. Any throw is the caller's
 * fallback.
 */
async function readConversation(start: Start, model: Provider.Model | undefined, deps: Deps) {
  if (deps.halt.reason()) return "stopped" as const
  const brain = deps.kept.brain
  const repositoryId = deps.env.GITHUB_REPOSITORY_ID ?? ""
  const importSession = deps.restore.importSession
  const room = Math.floor((model?.limit.input || model?.limit.context || 0) * RESTORE_CONTEXT_SHARE)
  if (!isRepositoryId(repositoryId) || !importSession || !model || room <= 0) return undefined
  // The codec loads zip.js, so only a run that restores loads it.
  const { allowConversationRestore, decryptConversation, latestConversation } = await import("./github.session")
  const thread = start.route.thread
  const bytes = await latestConversation({
    repository: `${start.owner}/${start.repo}`,
    thread,
    token: start.token,
    baseUrl: deps.env.GITHUB_API_URL,
    signal: deps.signal,
    request: deps.restore.request,
  })
  if (deps.signal.aborted || !bytes) return undefined
  if (deps.halt.reason()) return "stopped" as const
  // The key is used only inside this callback, so nothing here holds it once the file is open.
  const conversation = await (
    brain
      ? Promise.resolve({ status: "ok" as const, key: brain.brainKey })
      : deps.session.artifactKey({
          env: deps.env,
          holder: deps.credentials,
          services: deps.services,
          signal: deps.signal,
        })
  ).then((answer) =>
    answer.status === "ok"
      ? decryptConversation({ bytes, key: answer.key, expected: { repositoryId, thread } })
      : undefined,
  )
  if (deps.signal.aborted || !conversation) return undefined
  // History with Brain or proposal provenance continues only in a desktop Brain run whose approval has the same digest,
  // audience and visibility; every other run falls back whole (the Brain history restriction).
  if (!allowConversationRestore(conversation, brain?.approval)) return undefined
  // Only what the save writes for the agent phase's v1 sessions, decoded as the import decodes it: a legacy archive
  // that is not owner-only. A native v2 archive cannot continue in the v1 agent phase.
  const local = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Union([SessionArchive.Native, SessionArchive.Legacy]))(conversation.session),
  )
  if (!local || "engine" in local || local.privacy === "owner-only") return undefined
  // The import turns a compaction into plain text, so everything before it would be sent again in full.
  if (local.messages.some((message) => message.parts.some((part) => part.type === "compaction"))) return undefined
  // The estimate a compaction makes before a turn, over the history as its turns would send it: an image or a tool's
  // attachment counts its visual tokens, a text file its text once. The archive decodes SessionV1's own WithParts
  // schema and estimate only reads it, so the cast drops only `readonly`: any other difference from the session type
  // fails to compile.
  const estimate = SessionCompaction.estimate({
    messages: local.messages as Types.DeepMutable<typeof local.messages>,
    model,
  })
  if ((await deps.run(estimate)) > room) return undefined
  if (deps.halt.reason()) return "stopped" as const
  const imported = await deps.run(importSession(conversation.session))
  // A failure from here leaves an unused session in the runner's database, and the run starts a new one.
  if (imported.engine !== "v1") return undefined
  await deps.run(deps.sessions.setPermission({ sessionID: imported.sessionID, permission: NO_QUESTIONS }))
  const messages = await deps.run(deps.sessions.messages({ sessionID: imported.sessionID }))
  return {
    sessionID: imported.sessionID,
    messages: new Set<string>(messages.map((message) => message.info.id)),
    // Whether the history already holds this run's block: it was saved with the same approved bundle (checked above),
    // and one of its task messages carries the block. An earlier attempt whose model had no room for the block still
    // saved the bundle, but no message of its history holds the block, so this run sends it.
    brain:
      conversation.brain !== undefined &&
      local.messages.some(
        (message) =>
          message.info.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text.includes(BRAIN_CONTEXT_OPEN)),
      ),
  }
}

function bundleRoute(
  route: AgentRoute,
  headRef: string | undefined,
  mode: GithubBundle.BundleRoute["mode"],
): GithubBundle.BundleRoute {
  if (route.kind === "issue") return { mode, kind: "issue", thread: route.thread, issue: route.number }
  if (route.kind === "pr")
    return { mode, kind: "pr", thread: route.thread, pr: route.number, ...(headRef ? { headRef } : {}) }
  if (route.kind === "schedule") return { mode, kind: "schedule", thread: route.thread, scheduleId: route.scheduleId }
  return { mode, kind: "dispatch", thread: route.thread }
}

/**
 * The run's stop for an error (2.9.2). In a Codium run the root turn always runs on the Codium model (agentModel), so
 * its final error is the gateway's; an own-key run's errors always take the default row (INV-K1), since no provider's
 * body can stand for a Codium stop. A "wait" row has already waited out its window in the session's retries
 * (gatewayRetry), so it drafts.
 */
function stopOf(cause: unknown, codium: boolean): GithubBundle.Stop {
  const stop = GithubBundle.stopReason(cause instanceof Error && cause.cause !== undefined ? cause.cause : cause, {
    codium,
  })
  return stop.behaviour === "wait" ? { ...stop, behaviour: "draft" } : stop
}

/**
 * The log line for an error. A stop the run made itself is its reason line. On Codium a model turn's error, or any
 * error with a model provider's answer in its cause chain, is its reason line too: its message can be the gateway's,
 * which may name credits, a plan or a price, and Actions logs are public (P6). Any other error, a GitHub read or a git
 * failure for example, keeps its own message.
 */
function errorLine(cause: unknown, end: GithubBundle.Stop, deps: Pick<Deps, "codium" | "halt">) {
  if (deps.halt.reason()) return stoppedLine(end)
  if (deps.codium && (end.stop !== undefined || turnError(cause) || providerAnswer(cause))) return stoppedLine(end)
  return messageOf(cause)
}

/**
 * Whether a link of the error's cause chain is a model provider's answer: a session API error (instance or object),
 * the LLM layer's error, or the AI SDK's call error. A Codium run's only model provider is the gateway (agentModel), so
 * any of them can carry the gateway's words, however many wrappers sit above it.
 */
function providerAnswer(cause: unknown, depth = 0): boolean {
  if (depth > 16 || typeof cause !== "object" || cause === null) return false
  if (SessionV1.APIError.isInstance(cause) || cause instanceof LLMError || APICallError.isInstance(cause)) return true
  return "cause" in cause && providerAnswer(cause.cause, depth + 1)
}

// A model turn's error as chat keeps it in `cause`: the session's NamedError object. A context overflow carries
// chat's own fixed advice, so it keeps its line.
function turnError(cause: unknown) {
  const error = cause instanceof Error ? cause.cause : undefined
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    "data" in error &&
    !SessionV1.ContextOverflowError.isInstance(error)
  )
}

/** VECTOR_RUN_DEADLINE (epoch ms) when it is well formed: no leading zero, a safe integer, no later than any mint gives. */
export function runDeadline(value: string | undefined, now: number) {
  if (!/^[1-9]\d{0,15}$(?![\s\S])/.test(value ?? "")) return undefined
  const deadline = Number(value)
  if (!Number.isSafeInteger(deadline) || deadline - now > DEADLINE_AHEAD_MS) return undefined
  return deadline
}

/**
 * How a Codium run's session retries a gateway answer (2.9.2), for SessionRetry's pinned rule: "wait" for
 * MODEL_PLAN_CONCURRENCY; the usual retries (undefined) for MODEL_PLAN_BUSY, MODEL_PLAN_RENEWING and the default row,
 * whose 5xx the deadline bounds; "stop" for every other table code, which drafts at once. Any provider but the model
 * plans provider keeps the usual retries.
 */
export function gatewayRetry(error: unknown, provider: string): "stop" | "wait" | undefined {
  if (provider !== ModelPlans.PROVIDER_ID) return undefined
  const stop = GithubBundle.stopReason(error, { codium: true })
  if (stop.behaviour === "wait") return "wait"
  if (stop.stop === undefined || stop.stop === "MODEL_PLAN_BUSY" || stop.stop === "MODEL_PLAN_RENEWING")
    return undefined
  return "stop"
}

/**
 * A Codium run's retry rule (gatewayRetry). Its concurrency window is the run's: it opens at the run's first
 * concurrency refusal, and a later refusal after a recovered one keeps it, so a run's waits together stay within
 * CONCURRENCY_RETRY_MS. Its waits are never shorter than the clock's `minDelayMs` (SessionRetry's default when absent).
 */
export function gatewayRule(
  clock: Pick<AgentClock, "now"> & Partial<Pick<AgentClock, "minDelayMs">>,
): SessionRetry.GatewayRule {
  const window: { first?: number } = {}
  return {
    classify: gatewayRetry,
    minDelayMs: clock.minDelayMs,
    remaining: () => {
      const now = clock.now()
      window.first ??= now
      return GithubAgents.CONCURRENCY_RETRY_MS - (now - window.first)
    },
  }
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
// Only a payload that says its repository is private counts as private (begin()'s publicRepository).
const PrivateRepository = z.object({ repository: z.object({ private: z.literal(true) }) })

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
    // Only Vector's App bot with a one-time ticket, on Codium; own key refuses every bot (2.11.3).
    const ticket = bot(payload.sender) && serviceDispatch(payload, env)
    if (bot(payload.sender) && !ticket) return { refused: BOT_REFUSED }
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
        ...(ticket ? { ticket: true as const } : {}),
      },
    }
  }
  if (event.name === "schedule") {
    const schedule = lookupSchedule(env, event.payload)
    if (!schedule) return { refused: UNKNOWN_SCHEDULE }
    return {
      route: {
        kind: "schedule",
        scheduleId: schedule.id,
        thread: schedule.thread,
        trigger: schedule.prompt,
        login: GITHUB_ACTIONS_BOT,
        review: false,
      },
    }
  }
  return { refused: refusedEvent(event.name || "unknown") }
}

function bot(user: z.infer<typeof User>) {
  return user.type === "Bot" || /\[bot\]$/i.test(user.login)
}

/**
 * Whether a dispatch is Vector's service starting a Codium task, as mint step 8 verified it (INV-S2): the sender is a
 * `Bot` whose login is `<slug>[bot]` for the App handle MENTIONS names first, compared exactly as the route script
 * compares the login (2.11.3), and `inputs.ticket` is a well-formed one-time ticket. This is defence in depth: the
 * server checked the bot and consumed the ticket before any token existed. The phase is stricter than the route script,
 * which admits the login without a type; it does not compare the bot's user id, because nothing trusted gives it yet.
 */
function serviceDispatch(payload: z.infer<typeof Dispatch>, env: Readonly<Record<string, string | undefined>>) {
  const handle =
    mentionsFrom(env.MENTIONS, TASK_MENTIONS)
      .find((mention) => mention.startsWith("@"))
      ?.slice(1) ?? ""
  const ticket = payload.inputs?.ticket
  return (
    env.VECTOR_MODE === "codium" &&
    GithubAgents.mentions(handle)[0] === `@${handle}` &&
    payload.sender.type === "Bot" &&
    payload.sender.login === `${handle}[bot]` &&
    typeof ticket === "string" &&
    TICKET.test(ticket)
  )
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
