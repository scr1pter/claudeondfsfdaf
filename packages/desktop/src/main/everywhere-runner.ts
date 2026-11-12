import { branchFor, commitMessage } from "@vectordevai/core/everywhere/publish"
import { COMPUTER_CAPS, PERMISSION_ID_PATTERN, TIMING, decodeJob, decodeSettle, type DeclineCode, type EverywhereJob, type Milestone, type Outcome, type Settle } from "@vectordevai/schema/everywhere"
import type { PermissionV1 } from "@vectordevai/schema/permission-v1"
import { unattendedRules, type RunnerEngine } from "./everywhere-engine"
import type { RunnerGit } from "./everywhere-git"
import type { JobLedger } from "./everywhere-ledger"
import { checkedSummary, mayPushDiff } from "./everywhere-scan"
import type { FrameOptions } from "@vectordevai/core/everywhere/frame"

export type RunnerSettings = {
  readonly enabled: boolean
  readonly localMode: boolean
  readonly modelAllowed: boolean
  readonly maxUsd: number
  readonly minutes: number
  readonly atOnce: number
  readonly perDay: number
  readonly push: boolean
  readonly projects: readonly { readonly directory: string; readonly repository: string; readonly base: string }[]
  readonly rules?: readonly PermissionV1.Rule[]
  readonly model?: { readonly providerID: string; readonly modelID: string }
}

export type JobsClient = {
  readonly claim: (jid: string) => Promise<EverywhereJob>
  readonly decline: (jid: string, reason: DeclineCode, lease?: string) => Promise<void>
  readonly report: (job: EverywhereJob, seq: number, milestone: Milestone, files?: number) => Promise<"continue" | "stop" | "lost">
  readonly settle: (result: Settle) => Promise<void>
}

export function createEverywhereJobsClient(input: { readonly token: () => Promise<string>; readonly device: string; readonly fetcher?: typeof fetch; readonly url?: string }): JobsClient {
  const origin = new URL(input.url ?? "https://vectordev.ai")
  if (!(origin.origin === "https://vectordev.ai" || (origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))) || origin.username || origin.password || origin.search || origin.hash) throw new Error("Invalid Everywhere service")
  const call = async (route: string, body: unknown) => {
    const response = await (input.fetcher ?? fetch)(new URL(`/api/everywhere/jobs/${route}`, origin), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${await input.token()}`, "x-vector-device": input.device, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
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
      await call("settle", checked.value)
    },
  }
}

/** This capability is absent on main; see vector-everywhere-main-requests.md. No unsafe endpoint fallback exists. */
export type SafeWorktree = {
  readonly policy: "unattended-v1"
  readonly create: (input: { directory: string; repository: string; jid: string; from: string; branch: string; signal: AbortSignal }) => Promise<{ directory: string; from: string; branch: string }>
}

export type RunnerDeps = {
  readonly settings: () => Promise<RunnerSettings>
  readonly verify: (offer: unknown) => Promise<{ jid: string } | undefined>
  readonly ledger: JobLedger
  readonly jobs: JobsClient
  readonly safeWorktree?: SafeWorktree
  readonly git: (directory: string, repository: string, signal: AbortSignal) => RunnerGit
  readonly engine: (directory: string) => RunnerEngine
  readonly githubThread?: (job: EverywhereJob) => Promise<FrameOptions>
  readonly privateRepository: (job: EverywhereJob) => Promise<boolean>
  readonly openPr: (input: { job: EverywhereJob; branch: string; base: string; summary: string; held: number }) => Promise<string | undefined>
  readonly now?: () => number
  readonly every?: (ms: number, work: () => Promise<void>) => () => void
}

function settingsValid(settings: RunnerSettings) {
  return Number.isFinite(settings.maxUsd) && settings.maxUsd > 0 && settings.maxUsd <= COMPUTER_CAPS.maxUsd.max &&
    Number.isInteger(settings.minutes) && settings.minutes >= 1 && settings.minutes <= COMPUTER_CAPS.minutes.max &&
    Number.isInteger(settings.atOnce) && settings.atOnce >= 1 && settings.atOnce <= COMPUTER_CAPS.atOnce.max &&
    Number.isInteger(settings.perDay) && settings.perDay >= 1 && settings.perDay <= COMPUTER_CAPS.perDay.max
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

  async function run(jid: string, settings: RunnerSettings, controller: AbortController) {
    let job: EverywhereJob | undefined
    let session: string | undefined
    let engine: RunnerEngine | undefined
    let stopTimer: () => void = () => undefined
    let outcome: Outcome = "failed"
    let settled = false
    const needs = new Set<string>()
    const abort = async (reason: Outcome) => {
      outcome = reason
      controller.abort()
      if (session && engine) await engine.abort(session).catch(() => undefined)
    }
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
      if (!deps.safeWorktree || deps.safeWorktree.policy !== "unattended-v1") {
        await deps.jobs.settle({ jid, lease: job.lease.id, outcome: "held", summary: "This computer cannot yet create an unattended worktree safely. No changes were pushed." })
        settled = true
        return
      }
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
        if (!current?.enabled || current.localMode || !current.modelAllowed) return abort("cancelled")
        if (now() >= deadline) return abort("over-budget")
        if (now() - acknowledgedAt >= TIMING.leaseMs) return abort("interrupted")
        if (now() - acknowledgedAt >= 60_000) await report("heartbeat", true)
      })
      if (deadline <= now() || !await report("started", true)) throw new Error("Everywhere has no current lease")
      const git = deps.git(project.directory, project.repository, controller.signal)
      const original = await git.snapshot()
      const from = await git.fetch(original, project.base, jid)
      const branch = branchFor(jid, job.issue ? { key: job.issue.key, platform: job.platform } : undefined)
      const placed = await deps.safeWorktree.create({ directory: project.directory, repository: project.repository, jid, from, branch, signal: controller.signal })
      if (placed.from !== from || placed.branch !== branch || !placed.directory || placed.directory === project.directory || !await git.unchanged(original)) throw new Error("Invalid unattended worktree authority")
      const snapshot = await git.snapshot(placed.directory)
      if (snapshot.baseSha !== from) throw new Error("The unattended worktree has a different base")
      engine = deps.engine(placed.directory)
      session = await engine.create(job, unattendedRules(settings.rules))
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
      const frame = job.platform === "github" ? await deps.githubThread?.(job) : undefined
      if (job.platform === "github" && !frame?.thread) throw new Error("The GitHub trigger is unavailable")
      await engine.prompt(session, job, Math.min(job.limits.maxUsd, settings.maxUsd), settings.model, frame)
      await Promise.race([idle, cancelled])
      if (controller.signal.aborted) throw new Error("Everywhere job stopped")
      const summary = await checkedSummary(job, await engine.summary(session), [...sessions], engine.posting)
      if (needs.size > 0) {
        await deps.jobs.settle({ jid, lease: job.lease.id, outcome: "needs-approval", summary, needs: [...needs] })
        settled = true
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
        if (!headSha || !settings.push || !current.enabled || !current.push || !current.modelAllowed || !mapped || current.localMode || job.repository.shared || now() >= deadline || controller.signal.aborted || !await report("pushing", true) || !await deps.privateRepository(job).catch(() => false)) outcome = "held"
        else if (await git.push(snapshot, placed.directory, branch)) {
          const prUrl = await deps.openPr({ job: { ...job, task }, branch, base: project.base, summary, held: staged.held.length }).catch(() => undefined)
          await deps.jobs.settle({ jid, lease: job.lease.id, outcome: "changes", summary, branch, headSha, files: staged.files, checks: "skipped", ...(prUrl ? { prUrl } : {}) })
          settled = true
          return
        } else outcome = "held"
      }
      await deps.jobs.settle({ jid, lease: job.lease.id, outcome, summary, branch, checks: "skipped" })
      settled = true
      await watched
    } catch {
      if (controller.signal.aborted && outcome === "failed") outcome = "cancelled"
      controller.abort()
      if (session && engine) await engine.abort(session).catch(() => undefined)
      if (job && !settled) await deps.jobs.settle({ jid, lease: job.lease.id, outcome, summary: "The unattended job ended without publishing changes." }).catch(() => undefined)
    } finally {
      stopTimer()
      controller.abort()
      if (session && engine) await engine.abort(session).catch(() => undefined)
      await deps.ledger.release(jid)
      active.delete(jid)
    }
  }

  return {
    async offer(offer: unknown) {
      const verified = await deps.verify(offer)
      if (!verified || active.has(verified.jid)) return false
      const settings = await deps.settings()
      const reason: DeclineCode | undefined = !settings.enabled ? "off" : settings.localMode ? "local-mode" : !settings.modelAllowed ? "model-not-allowed" : !settingsValid(settings) ? "busy" : undefined
      if (reason) { await deps.jobs.decline(verified.jid, reason); return false }
      if (!await deps.ledger.reserve(verified.jid, settings)) { await deps.jobs.decline(verified.jid, "busy"); return false }
      const controller = new AbortController()
      active.set(verified.jid, controller)
      await run(verified.jid, settings, controller)
      return true
    },
    stop() { for (const controller of active.values()) controller.abort() },
    async recover() {
      for (const job of (await deps.ledger.inspect()).jobs) {
        if (job.lease) await deps.jobs.settle({ jid: job.jid, lease: job.lease, outcome: "interrupted", summary: "Vector restarted during this unattended job. No continuation was started." }).catch(() => undefined)
        await deps.ledger.release(job.jid)
      }
    },
  }
}
