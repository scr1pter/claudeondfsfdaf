import { branchFor, commitMessage } from "@vectordevai/core/everywhere/publish"
import { COMPUTER_CAPS, OFFER_PATTERN, PERMISSION_ID_PATTERN, READINESS_FIELDS, READINESS_QUERY, TIMING, decodeJob, decodeSettle, type DeclineCode, type EverywhereJob, type Milestone, type Outcome, type Readiness, type Settle } from "@vectordevai/schema/everywhere"
import { responseText, unattendedRules, type RunnerEngine } from "./everywhere-engine"
import type { RunnerGit } from "./everywhere-git"
import type { JobLedger } from "./everywhere-ledger"
import { checkedSummary, mayPushDiff } from "./everywhere-scan"
import type { RunnerSettings } from "./everywhere-settings"
import { frameTask, type FrameOptions } from "@vectordevai/core/everywhere/frame"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { Option, Schema } from "effect"

export type JobsClient = {
  readonly claim: (jid: string) => Promise<EverywhereJob>
  readonly decline: (jid: string, reason: DeclineCode, lease?: string) => Promise<void>
  readonly report: (job: EverywhereJob, seq: number, milestone: Milestone, files?: number) => Promise<"continue" | "stop" | "lost">
  readonly settle: (result: Settle) => Promise<void>
  /**
   * Waiting jobs for this computer (3.4 `pending`), asked with its readiness booleans: fresh signed offers, verified
   * and claimed like a relay's. The service's off answers (200 `action: "stop"`, and any 404) are no jobs.
   */
  readonly pending: (readiness: Readiness) => Promise<{ readonly offers: readonly string[]; readonly waiting: number }>
}

/** The most offers kept from one `pending` answer; the server keeps at most three jobs live (SERVER_CAPS). */
const PENDING_OFFERS = 32
/** 32 offers of at most 2,140 characters each, with room for the JSON around them. */
const PENDING_BYTES = 128 * 1024
const NO_JOBS = { offers: [], waiting: 0 } as const
/** The pending answer, from the network: the off answer, or offers and a count. Other keys are ignored. */
const PendingAnswer = Schema.fromJsonString(Schema.Struct({
  action: Schema.optional(Schema.String),
  offers: Schema.optional(Schema.Array(Schema.Unknown)),
  waiting: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}))
const decodeSettlement = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ settled: Schema.Literal(true) })),
  { onExcessProperty: "error" },
)
const decodeEnded = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: Schema.Literal("JOB_ENDED") }) })),
)
const SETTLE_ANSWER_BYTES = 4_096
class SettlementEnded extends Error {}

export function createEverywhereJobsClient(input: { readonly token: () => Promise<string>; readonly device: string; readonly fetcher?: typeof fetch; readonly url?: string }): JobsClient {
  const origin = new URL(input.url ?? "https://vectordev.ai")
  if (!(origin.origin === "https://vectordev.ai" || (origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))) || origin.username || origin.password || origin.search || origin.hash) throw new Error("Invalid Everywhere service")
  const post = async (route: string, body: unknown) => {
    // Each request is the `everywhere` source: Vector Local decides and logs it first, and one it blocks rejects with
    // EgressGuard.EgressBlocked before anything is sent. With Vector Local off it goes to the fetcher unchanged (under
    // Bun, with a company's certificate authorities added: LocalCA).
    return Egress.fetch("everywhere", new URL(`/api/everywhere/jobs/${route}`, origin), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${await input.token()}`, "x-vector-device": input.device, "content-type": "application/json" },
      body: JSON.stringify(body),
    }, input.fetcher)
  }
  const call = async (route: string, body: unknown) => {
    const response = await post(route, body)
    if (!response.ok) throw new Error(response.status === 404 || response.status === 409 ? "Everywhere job stopped" : "Everywhere service unavailable")
    return await response.json() as Record<string, unknown>
  }
  return {
    async claim(jid) {
      const result = decodeJob((await call("claim", { jid, device: input.device })).job)
      if (!result.ok) throw new Error("Invalid Everywhere claim")
      return result.value
    },
    decline: async (jid, reason, lease) => { await call("decline", { jid, device: input.device, reason, ...(lease ? { lease } : {}) }) },
    async report(job, seq, milestone, files) {
      try {
        const result = await call("report", { jid: job.jid, lease: job.lease.id, seq, milestone, ...(files === undefined ? {} : { files }) })
        if (result.action !== "continue" && result.action !== "stop" && result.action !== "lost") throw new Error("Invalid Everywhere report")
        return result.action
      } catch (error) {
        if (error instanceof Error && error.message === "Everywhere job stopped") return "stop"
        throw error
      }
    },
    settle: async (result) => {
      const checked = decodeSettle(result)
      if (!checked.ok) throw new Error("Invalid Everywhere result")
      const response = await post("settle", checked.value)
      if (response.status === 200 || response.status === 409) {
        const body = await responseText(response, SETTLE_ANSWER_BYTES)
        if (response.status === 200 && Option.isSome(decodeSettlement(body))) return
        // The settle route emits this code only after proving the sponsor, the device and the exact lease.
        if (response.status === 409 && Option.isSome(decodeEnded(body))) throw new SettlementEnded()
      } else await response.body?.cancel().catch(() => undefined)
      throw new Error("Everywhere result was not acknowledged")
    },
    async pending(readiness) {
      // The same label, sign-in, device and ten-second bound as the POST routes; a GET with the booleans as `1` or `0`.
      const url = new URL("/api/everywhere/jobs/pending", origin)
      for (const field of READINESS_FIELDS) url.searchParams.set(READINESS_QUERY[field], readiness[field] ? "1" : "0")
      const response = await Egress.fetch("everywhere", url, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${await input.token()}`, "x-vector-device": input.device,
          accept: "application/json" },
      }, input.fetcher)
      // 404: a deployment without the route, or a platform route's EVERYWHERE_OFF. Either way there is nothing to take.
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined)
        return NO_JOBS
      }
      if (!response.ok) throw new Error("Everywhere service unavailable")
      // A longer body is refused unread, so a misbehaving service cannot make this process parse an unbounded answer.
      const answer = Option.getOrUndefined(Schema.decodeUnknownOption(PendingAnswer)(
        await responseText(response, PENDING_BYTES).catch(() => undefined)))
      if (!answer) throw new Error("Invalid Everywhere pending answer")
      // While the feature or its Codium switch is off the route answers 200 `action: "stop"` (jobs-api.ts pending).
      if (answer.action === "stop") return NO_JOBS
      if (!answer.offers || answer.waiting === undefined) throw new Error("Invalid Everywhere pending answer")
      const offers = answer.offers.filter((offer): offer is string => typeof offer === "string" &&
        OFFER_PATTERN.test(offer))
      return { offers: offers.slice(0, PENDING_OFFERS), waiting: answer.waiting }
    },
  }
}

/**
 * The job's own checkout (vector-everywhere-main-requests.md): the engine's owner-only POST
 * /experimental/worktree/unattended (EV-13), offered only while its probe answers `unattended-v1`
 * (everywhere-wiring.ts unattendedWorktree, EV-18). There is no fallback to POST /experimental/worktree.
 */
export type SafeWorktree = {
  readonly policy: "unattended-v1"
  readonly create: (input: { directory: string; repository: string; jid: string; from: string; branch: string; signal: AbortSignal }) => Promise<{ directory: string; from: string; branch: string }>
}

/** The engine refused the checkout for this repository here (it is not listed, open in Vector or trusted): the job is held. */
export class WorktreeUnavailable extends Error {
  constructor() {
    super("The unattended worktree is not available for this repository here")
  }
}

const UNAVAILABLE_HERE = "This computer could not take the job: its repository must be listed for Vector everywhere, open in Vector and trusted. No changes were pushed."

export type RunnerDeps = {
  readonly settings: () => Promise<RunnerSettings>
  readonly verify: (offer: unknown) => Promise<{ jid: string } | undefined>
  readonly ledger: JobLedger
  /** The runner never asks for waiting jobs; everywhere-wiring.ts does. */
  readonly jobs: Omit<JobsClient, "pending">
  readonly safeWorktree?: SafeWorktree
  readonly git: (directory: string, repository: string, signal: AbortSignal) => RunnerGit
  readonly engine: (directory: string) => RunnerEngine
  readonly githubThread?: (job: EverywhereJob) => Promise<FrameOptions>
  readonly privateRepository: (job: EverywhereJob) => Promise<boolean>
  readonly openPr: (input: { job: EverywhereJob; branch: string; base: string; summary: string; held: number }) => Promise<string | undefined>
  readonly now?: () => number
  readonly every?: (ms: number, work: () => Promise<void>) => () => void
  /** Vector Local's policy in effect. Default: this process's (Egress.policy). */
  readonly localPolicy?: () => LocalMode.Policy
  /** Local diagnostics with fixed text only: no repository output, paths or job content. */
  readonly log?: (message: string) => void
}

const MAPPING_LOG = {
  "unsafe-config": "Vector everywhere declined a job: the workspace folder's local git settings include a key it never runs unattended (a filter, include, URL rewrite, helper or command).",
  "other-repository": "Vector everywhere declined a job: the workspace folder's git remote is not the allowed repository.",
  unavailable: "Vector everywhere declined a job: git could not read the workspace folder.",
} as const

function settingsValid(settings: RunnerSettings) {
  return Number.isFinite(settings.maxUsd) && settings.maxUsd > 0 && settings.maxUsd <= COMPUTER_CAPS.maxUsd.max &&
    Number.isInteger(settings.minutes) && settings.minutes >= 1 && settings.minutes <= COMPUTER_CAPS.minutes.max &&
    Number.isInteger(settings.atOnce) && settings.atOnce >= 1 && settings.atOnce <= COMPUTER_CAPS.atOnce.max &&
    Number.isInteger(settings.perDay) && settings.perDay >= 1 && settings.perDay <= COMPUTER_CAPS.perDay.max
}

// What a laptop job reaches, by registry source (E15): the jobs service; git's fetch and push on GitHub, which run in a
// child process the backstop guard never sees, so they are decided here and again before git starts
// (everywhere-git.ts); and GitHub's API, for the visibility check, the GitHub thread and the draft pull request.
const LOCAL_NEEDS = [
  { source: "everywhere", url: "https://vectordev.ai/api/everywhere/jobs" },
  { source: "git-remote", url: "https://github.com/" },
  { source: "github", url: "https://api.github.com/" },
] as const

/**
 * Whether Vector Local lets this computer take and publish a laptop job (E15): every source the job needs is allowed.
 * With Vector Local off every verdict allows. A source the registry lacks, and a pending policy, refuse. Pure, so the
 * runner's one-second check logs nothing; the requests themselves are decided and logged where they are made.
 */
export function localAllows(policy: LocalMode.Policy) {
  return LOCAL_NEEDS.every((need) => {
    // 2026-11-16 (EV-15): desktop github-api.ts still sends unlabelled, so under Vector Local the backstop refuses every
    // GitHub API call whatever is allowed, and a claimed job could only end held. Until EV-21 labels those calls
    // `github`, that need refuses whenever Vector Local is on, and laptop jobs stay declined under it.
    if (need.source === "github" && policy.enabled) return false
    const source = LocalSources.get(need.source)
    return (
      source !== undefined &&
      LocalPolicy.decide(policy, { purpose: source.purpose, url: need.url, source: source.id }).decision === "allow"
    )
  })
}

const every = (ms: number, work: () => Promise<void>) => {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void work().finally(() => { running = false }).catch(() => undefined)
  }, ms)
  return () => clearInterval(timer)
}

export function createEverywhereRunner(deps: RunnerDeps) {
  const now = deps.now ?? Date.now
  const active = new Map<string, AbortController>()
  const localAllowed = () => localAllows((deps.localPolicy ?? Egress.policy)())

  function warn(message: string) {
    if (!deps.log) return false
    try {
      deps.log(message)
      return true
    } catch {
      return false
    }
  }

  async function deliver(result: Settle, journaled = false) {
    // JobsClient has a ten-second request bound. An acknowledgement loss must replay this
    // exact result, never substitute a contradictory terminal outcome.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await deps.jobs.settle(result)
        if (journaled)
          await deps.ledger.clearReceipt(result).catch(() => warn("Vector everywhere could not clear an acknowledged publication receipt."))
        return true
      } catch (error) {
        if (!(error instanceof SettlementEnded)) continue
        if (journaled && warn("Vector everywhere could not report a publication because the job had ended."))
          await deps.ledger.clearReceipt(result).catch(() => warn("Vector everywhere could not retire a publication receipt."))
        return false
      }
    }
    warn("Vector everywhere could not acknowledge a job result.")
    return false
  }

  async function run(jid: string, settings: RunnerSettings, controller: AbortController) {
    let job: EverywhereJob | undefined
    let session: string | undefined
    let engine: RunnerEngine | undefined
    let stopTimer: () => void = () => undefined
    let outcome: Outcome = "failed"
    let settled = false
    let publication: Settle | undefined
    const needs = new Set<string>()
    // EV-03: latched, because the timer keeps running after an abort and a later deadline or lease abort overwrites
    // `outcome`. A cancel heard once stays heard.
    let cancelHeard = false
    const abort = async (reason: Outcome) => {
      outcome = reason
      if (reason === "cancelled") cancelHeard = true
      controller.abort()
      if (session && engine) await engine.abort(session).catch(() => undefined)
    }
    /** Read through a function: `abort` sets the latch from callbacks, which the inline narrowing cannot see. */
    const stopHeard = () => cancelHeard
    try {
      const claimed = decodeJob(await deps.jobs.claim(jid))
      if (!claimed.ok || claimed.value.jid !== jid) throw new Error("Invalid Everywhere claim")
      job = claimed.value
      await deps.ledger.update({ jid, lease: job.lease.id, startedAt: now() })
      const project = settings.projects.find((item) => item.repository.toLowerCase() === job!.repository.fullName.toLowerCase())
      if (!project) {
        await deps.jobs.decline(jid, "not-mapped", job.lease.id)
        settled = true
        return
      }
      const git = deps.git(project.directory, project.repository, controller.signal)
      const mapping = await git.mapping()
      if (mapping !== "mapped") {
        deps.log?.(MAPPING_LOG[mapping])
        await deps.jobs.decline(jid, "not-mapped", job.lease.id)
        settled = true
        return
      }
      // Read once: the wiring offers the worktree only while the engine's probe does, and that may change mid-job.
      const worktree = deps.safeWorktree
      if (!worktree || worktree.policy !== "unattended-v1") {
        settled = await deliver({
          jid,
          lease: job.lease.id,
          outcome: "held",
          summary: "This computer cannot yet create an unattended worktree safely. No changes were pushed.",
        })
        return
      }
      let frame: FrameOptions | undefined
      if (job.platform === "github") {
        try {
          frame = await deps.githubThread?.(job)
          if (!frame?.thread) throw new Error("The Github trigger is unavailable")
          frameTask(job, frame)
        } catch {
          await deps.jobs.decline(jid, "trigger-changed", job.lease.id)
          settled = true
          return
        }
      }
      if (controller.signal.aborted) throw new Error("Everywhere job stopped")
      const deadline = Math.min(job.limits.deadline, now() + Math.min(job.limits.minutes, settings.minutes) * 60_000)
      let acknowledgedAt = now()
      let lastReport = 0
      let milestone: Milestone | undefined
      let seq = 0
      let reportTail = Promise.resolve(true)
      const report = (next: Milestone, force = false, files?: number) => {
        const result = reportTail.then(async () => {
          if (controller.signal.aborted) return false
          if (!force && next === milestone && now() - lastReport < 30_000) return true
          try {
            const action = await deps.jobs.report(job!, seq++, next, files)
            if (action !== "continue") { await abort("cancelled"); return false }
            acknowledgedAt = now()
            lastReport = now()
            milestone = next
            return true
          } catch {
            if (now() - acknowledgedAt >= TIMING.leaseMs) await abort("interrupted")
            return false
          }
        })
        reportTail = result.catch(() => false)
        return result
      }
      stopTimer = (deps.every ?? every)(1_000, async () => {
        const current = await deps.settings().catch(() => undefined)
        if (!current?.enabled || !localAllowed() || !current.modelAllowed) return abort("cancelled")
        if (now() >= deadline) return abort("over-budget")
        if (now() - acknowledgedAt >= TIMING.leaseMs) return abort("interrupted")
        if (now() - acknowledgedAt >= 60_000) await report("heartbeat", true)
      })
      if (deadline <= now() || !await report("started", true)) throw new Error("Everywhere has no current lease")
      const original = await git.snapshot()
      const from = await git.fetch(original, project.base, jid)
      const branch = branchFor(jid, job.issue ? { key: job.issue.key, platform: job.platform } : undefined)
      const placed = await worktree.create({ directory: project.directory, repository: project.repository, jid, from, branch, signal: controller.signal })
        .catch((error: unknown) => {
          if (error instanceof WorktreeUnavailable) return undefined
          throw error
        })
      if (!placed) {
        settled = await deliver({ jid, lease: job.lease.id, outcome: "held", summary: UNAVAILABLE_HERE })
        return
      }
      if (placed.from !== from || placed.branch !== branch || !placed.directory || placed.directory === project.directory || !await git.unchanged(original)) throw new Error("Invalid unattended worktree authority")
      const snapshot = await git.snapshot(placed.directory)
      if (snapshot.baseSha !== from) throw new Error("The unattended worktree has a different base")
      engine = deps.engine(placed.directory)
      session = await engine.create(job, unattendedRules(settings.rules, settings.shell))
      await deps.ledger.update({ jid, lease: job.lease.id, sessionID: session, startedAt: now() })
      const sessions = new Set([session])
      let ready!: () => void
      const subscribed = new Promise<void>((resolve) => { ready = resolve })
      let completed!: () => void
      let failed!: (error: Error) => void
      const idle = new Promise<void>((resolve, reject) => { completed = resolve; failed = reject })
      // Attach a rejection observer before starting the subscription; it may fail before prompt admission.
      void idle.catch(() => undefined)
      let busy = false
      const watched = (async () => {
        try {
          for await (const event of engine!.events(controller.signal, ready)) {
            const props = event.properties
            const info = props.info as { id?: string; parentID?: string } | undefined
            if (event.type === "session.created" && info?.id && info.parentID && sessions.has(info.parentID)) sessions.add(info.id)
            const part = props.part as { sessionID?: string; type?: string; tool?: string } | undefined
            const eventSession = typeof props.sessionID === "string" ? props.sessionID : part?.sessionID
            if (!eventSession || !sessions.has(eventSession)) continue
            if (event.type === "permission.asked" && typeof props.id === "string") {
              if (typeof props.permission === "string" && PERMISSION_ID_PATTERN.test(props.permission) && needs.size < 20) needs.add(props.permission)
              await engine!.rejectPermission(props.id)
            }
            if (event.type === "question.asked" && typeof props.id === "string") { needs.add("question"); await engine!.rejectQuestion(props.id) }
            const status = props.status as { type?: string } | undefined
            if (event.type === "session.status" && props.sessionID === session) {
              if (status?.type === "busy") busy = true
              if (status?.type === "idle" && busy) { completed(); return }
            }
            if (event.type === "session.error") throw new Error("The unattended session failed")
            if (event.type === "message.part.updated" && part?.type === "tool" && ["edit", "write", "apply_patch"].includes(part.tool ?? "")) await report("editing")
          }
          if (!controller.signal.aborted) throw new Error("The unattended event stream ended")
        } catch {
          failed(new Error("The unattended event stream failed"))
          ready()
        }
      })()
      const cancelled = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Everywhere job stopped")), { once: true }))
      void cancelled.catch(() => undefined)
      await Promise.race([subscribed, idle, cancelled])
      if (controller.signal.aborted) throw new Error("Everywhere job stopped")
      await engine.prompt(session, job, Math.min(job.limits.maxUsd, settings.maxUsd), settings.model, frame)
      await Promise.race([idle, cancelled])
      if (controller.signal.aborted) throw new Error("Everywhere job stopped")
      const summary = await checkedSummary(job, await engine.summary(session), [...sessions], engine.posting)
      if (needs.size > 0) {
        settled = await deliver({ jid, lease: job.lease.id, outcome: "needs-approval", summary, needs: [...needs] })
        return
      }
      const staged = await git.stage(snapshot, placed.directory)
      if (!staged) outcome = "held"
      else if (staged.files === 0) outcome = "no-changes"
      else if (!await mayPushDiff(staged.diff, [...sessions], engine.posting)) outcome = "held"
      else {
        if (controller.signal.aborted) throw new Error("Everywhere job stopped")
        const task = frame?.thread?.task ?? job.task
        const headSha = await git.commit(snapshot, placed.directory, commitMessage({ jid, task, issueKey: job.issue?.key }))
        const current = await deps.settings()
        const mapped = current.projects.some((item) => item.directory === project.directory && item.repository.toLowerCase() === project.repository.toLowerCase())
        if (!headSha || !settings.push || !current.enabled || !current.push || !current.modelAllowed || !mapped || !localAllowed() || job.repository.shared || now() >= deadline || controller.signal.aborted || !await report("pushing", true) || !await deps.privateRepository(job).catch(() => false)) outcome = "held"
        else {
          // Persist before crossing the remote side-effect boundary. A process crash or
          // ambiguous transport failure can then never recover as "nothing published".
          const uncertain: Settle = { jid, lease: job.lease.id, outcome: "failed", summary: "Publication was not confirmed. Check the remote branch before retrying this task.", branch, headSha, files: staged.files, checks: "skipped" }
          await deps.ledger.remember(uncertain)
          publication = uncertain
          if (controller.signal.aborted || now() >= deadline) {
            await deps.ledger.clearReceipt(uncertain)
            publication = undefined
            outcome = "held"
          } else {
            // The job's deadline may stop generation, but must not interrupt a push
            // already admitted. The git executor retains its own 60-second bound.
            const publishingGit = deps.git(project.directory, project.repository, new AbortController().signal)
            if (!await publishingGit.push(snapshot, placed.directory, branch)) {
              await deps.ledger.clearReceipt(uncertain)
              publication = undefined
              outcome = "held"
            } else {
              publication = { jid, lease: job.lease.id, outcome: "changes", summary, branch, headSha, files: staged.files, checks: "skipped" }
              await deps.ledger.remember(publication)
              // EV-03: a cancel heard during the push (stop, lost, a switch turned off) opens no draft PR, even when a later
              // deadline or lease abort replaced the outcome; a deadline or lease alone still opens it.
              const prUrl = stopHeard() ? undefined : await deps.openPr({ job: { ...job, task }, branch, base: project.base, summary, held: staged.held.length }).catch(() => undefined)
              if (prUrl) {
                publication = { ...publication, prUrl }
                await deps.ledger.remember(publication)
              }
              settled = await deliver(publication, true)
              return
            }
          }
        }
      }
      // A lost acknowledgement replays this exact result, keeping its summary and local branch.
      settled = await deliver({ jid, lease: job.lease.id, outcome, summary, branch, checks: "skipped" })
      await watched
    } catch {
      if (controller.signal.aborted && outcome === "failed") outcome = "cancelled"
      controller.abort()
      if (session && engine) await engine.abort(session).catch(() => undefined)
      if (job && !settled) {
        if (publication) settled = await deliver(publication, true)
        else await deliver({ jid, lease: job.lease.id, outcome, summary: "The unattended job ended without publishing changes." })
      }
    } finally {
      stopTimer()
      controller.abort()
      if (session && engine) await engine.abort(session).catch(() => undefined)
      try { await deps.ledger.release(jid) }
      catch { deps.log?.("Vector everywhere could not release a local job reservation.") }
      finally { active.delete(jid) }
    }
  }

  return {
    async offer(offer: unknown) {
      const verified = await deps.verify(offer)
      if (!verified || active.has(verified.jid)) return false
      const settings = await deps.settings()
      // While Vector Local blocks the jobs service itself (its default), the jobs client refuses this decline before
      // sending it and the offer rejects: the server hears no answer from this computer.
      const reason: DeclineCode | undefined = !settings.enabled ? "off" : !localAllowed() ? "local-mode" : !settings.modelAllowed ? "model-not-allowed" : !settingsValid(settings) ? "busy" : undefined
      if (reason) { await deps.jobs.decline(verified.jid, reason); return false }
      if (!await deps.ledger.reserve(verified.jid, settings)) { await deps.jobs.decline(verified.jid, "busy"); return false }
      const controller = new AbortController()
      active.set(verified.jid, controller)
      await run(verified.jid, settings, controller)
      return true
    },
    stop() { for (const controller of active.values()) controller.abort() },
    async recover() {
      const state = await deps.ledger.inspect()
      for (const result of state.pending) await deliver(result, true)
      for (const job of state.jobs) {
        try {
          if (job.lease && !state.pending.some((result) => result.jid === job.jid)) await deliver({ jid: job.jid, lease: job.lease, outcome: "interrupted", summary: "Vector restarted during this unattended job. No continuation was started." })
        } finally {
          await deps.ledger.release(job.jid).catch(() => deps.log?.("Vector everywhere could not release a local job reservation."))
        }
      }
    },
  }
}
