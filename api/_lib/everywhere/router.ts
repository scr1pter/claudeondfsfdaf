import { TERMINAL_STATES, TIMING, type InboundTrigger } from "../../../packages/schema/src/everywhere.js"
import { decideRoute, type CapCounts, type RouteDecision, type RouteInput } from "../../../packages/schema/src/everywhere-policy.js"
import { createJobEvents } from "./events.js"
import { dispatchJob, offerJob, queueJob, readComputer, readJob, refuseJob, type JobRecord, type JobsContext } from "./jobs.js"
import type { PlatformAdapter, JobView } from "./platform.js"
import type { Ports } from "./ports.js"

export type Routing = {
  readonly context: () => JobsContext
  readonly ports: Ports
  readonly adapter: PlatformAdapter
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly view: (job: JobRecord) => JobView
}

/** Facts use the pre-admission counters. An accepted job must never count itself against its own route. */
export async function routeFacts(input: {
  readonly ctx: JobsContext
  readonly ports: Ports
  readonly trigger: InboundTrigger
  readonly sponsor: string
  readonly repository?: { readonly id: number; readonly fullName: string }
  readonly counts: CapCounts
  readonly receivedAt: number
  readonly github?: { readonly actorId: number; readonly binderId: number }
}): Promise<RouteInput & { readonly computers: number }> {
  const [everywhere, remote, inPlan, remotePerk, presence, computer] = await Promise.all([
    input.ports.switch("everywhere"), input.ports.switch("remote"),
    input.ports.perk(input.sponsor, "everywhere"), input.ports.perk(input.sponsor, "remote"),
    input.ports.presence(input.sponsor).catch(() => ({ online: false, computers: 0, reason: "unreachable" as const })),
    readComputer(input.ctx.store, input.sponsor),
  ])
  const binding = input.repository && input.ports.prepareCloud
    ? await input.ports.binding(input.repository.id) : undefined
  const visibility = binding && input.repository && input.ports.visibility
    ? await input.ports.visibility(input.repository.id).catch(() => undefined) : undefined
  return {
    platform: input.trigger.platform,
    switches: { everywhere, remote, platform: true },
    requester: { ...input.trigger.actor, account: input.sponsor },
    sponsor: input.sponsor,
    inPlan,
    counts: input.counts,
    repository: input.repository,
    github: input.github,
    laptop: {
      configured: presence.reason !== "not-configured" && presence.reason !== "unreachable",
      perk: remotePerk,
      online: presence.online && Number.isSafeInteger(presence.computers) && presence.computers > 0,
      lastSeen: computer.lastSeen,
      waitForComputer: computer.readiness?.waitForComputer !== false,
    },
    computers: Number.isSafeInteger(presence.computers) ? Math.max(0, presence.computers) : 0,
    actions: input.ports.prepareCloud ? {
      sourceEnabled: input.trigger.platform !== "github", bodyByReference: true, modeRecorded: true,
      binding, visibility,
    } : undefined,
    receivedAt: input.receivedAt,
    now: input.ctx.now,
  }
}

/** A dispatch reserves the state before its external side effect, so a late laptop claim cannot race an Actions run. */
async function actions(deps: Routing, job: JobRecord): Promise<boolean> {
  if (!deps.ports.prepareCloud || job.platform === "github") return false
  const prepared = await deps.ports.prepareCloud({
    jid: job.jid, source: job.platform, sponsor: job.sponsor,
    requestedBy: { platform: job.platform, userId: job.requester.userId },
    repositoryId: job.repository.id, bodyReference: job.jid,
  })
  if (!prepared) return false
  // Live visibility and both kill switches are checked again immediately before the fenced transition.
  const abandon = async () => { await prepared.cancel?.().catch(() => undefined); return false }
  if (await deps.ports.switch("everywhere") === "stop") return abandon()
  if (!deps.ports.visibility || await deps.ports.visibility(job.repository.id).catch(() => undefined) !== "private") return abandon()
  const binding = await deps.ports.binding(job.repository.id)
  if (!binding || binding.account.toLowerCase() !== job.sponsor.toLowerCase() || !binding.appInstalled || binding.codiumMode !== true) return abandon()
  const moved = await dispatchJob(deps.context(), job.jid, { ticketHash: prepared.ticketHash })
  if (!moved.ok) return abandon()
  // An uncertain dispatch is never handed back to a laptop. The start-hook deadline settles it safely.
  await prepared.commit().catch(() => undefined)
  await deps.adapter.progress(deps.view(moved.job), "actions")
  return true
}

export async function routeJob(deps: Routing, job: JobRecord, facts: RouteInput & { readonly computers: number }) {
  let decision = decideRoute(facts)
  if (decision.action === "offer") {
    const fallback = decideRoute({ ...facts, offer: { claimed: false, declines: [], unanswered: facts.computers } })
    const offered = await offerJob(deps.context(), job.jid, fallback.action === "queue" ? { queueUntil: fallback.until } : {})
    if (offered.ok) {
      await deps.adapter.progress(deps.view(offered.job), "finding")
      const deadline = deps.now() + TIMING.offerWindowMs
      const sent = await deps.ports.offer(job.sponsor, offered.offer.offer).catch(() => "unavailable" as const)
      let current = offered.job
      while (sent === "sent" && deps.now() < deadline) {
        const seen = await readJob(deps.context().store, job.jid)
        if (!seen) return { action: "hand-back", code: "no-place" } as const
        current = seen
        if (seen.claimedAt !== undefined || TERMINAL_STATES.has(seen.state)) break
        if ((seen.declines?.length ?? 0) >= facts.computers || seen.declines?.some((item) => item.reason === "busy")) break
        await deps.sleep(Math.min(2_000, deadline - deps.now()))
      }
      // A relay can deliver an offer and still lose its response. Always reconcile the actual winner.
      current = await readJob(deps.context().store, job.jid) ?? current
      if (TERMINAL_STATES.has(current.state)) return { action: "hand-back", code: current.code ?? "no-place" } as const
      if (current.claimedAt !== undefined) {
        if (await deps.ports.switch("everywhere") === "stop") return { action: "refuse", code: "switched-off" } as const
        await deps.adapter.progress(deps.view(current), "laptop")
        return { action: "laptop" } as const
      }
      decision = decideRoute({ ...facts, now: deps.now(), offer: {
        claimed: false,
        declines: (current.declines ?? []).map((item) => item.reason),
        unanswered: Math.max(0, facts.computers - (current.declines?.length ?? 0)),
      } })
    } else decision = decideRoute({ ...facts, offer: { claimed: false, declines: [], unanswered: facts.computers } })
  }
  if (decision.action === "actions" && await actions(deps, job)) return decision
  if (decision.action === "actions") {
    const current = await readJob(deps.context().store, job.jid)
    if (current?.claimedAt !== undefined && !TERMINAL_STATES.has(current.state)) return { action: "laptop" } as const
    decision = decideRoute({ ...facts, laptop: { ...facts.laptop, online: false }, actions: undefined })
  }
  if (decision.action === "queue") {
    const moved = await queueJob(deps.context(), job.jid, decision.until)
    if (moved.ok) await deps.adapter.progress(deps.view(moved.job), "waiting")
    else {
      const current = await readJob(deps.context().store, job.jid)
      if (current?.claimedAt !== undefined && !TERMINAL_STATES.has(current.state)) return { action: "laptop" } as const
    }
    return decision
  }
  if (decision.action === "refuse" || decision.action === "hand-back") {
    const moved = await refuseJob(deps.context(), job.jid, decision.code)
    if (moved.ok && decision.action === "refuse") await createJobEvents(deps.context, { [job.platform]: deps.adapter }).ended?.({ job: moved.job })
  }
  return decision satisfies RouteDecision
}
