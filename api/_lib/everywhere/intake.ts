import { createJobId, decodeInboundTrigger, isRepositoryName } from "../../../packages/schema/src/everywhere.js"
import { decideRoute, mayTrigger } from "../../../packages/schema/src/everywhere-policy.js"
import { ApiError, json, readRawBody, requireMethod, type ApiRequest, type ApiResponse } from "../http.js"
import { after } from "./after.js"
import { platformOn, readConfig, type EverywhereConfig } from "./config.js"
import { claimDelivery, finishDelivery } from "./dedupe.js"
import { createJobEvents } from "./events.js"
import { findLink, findMapping, installationAuthority, readInstallSnapshot } from "./identity.js"
import { cancelJob, createJob, openReply, readJob, sweepAccount, type JobsContext } from "./jobs.js"
import { everywhereKeys } from "./keys.js"
import { readCounts } from "./limits.js"
import type { JobView, ParsedTrigger, PlatformAdapter, Platforms } from "./platform.js"
import { safePorts, type Ports, type Repository } from "./ports.js"
import { routeFacts, routeJob } from "./router.js"
import { everywhereStore, type Store } from "./store.js"

export type IntakeDeps = {
  readonly config?: EverywhereConfig
  readonly store?: Store
  readonly ports?: Ports
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly platforms?: Platforms
}

const BODY_LIMIT = { github: 16_384, slack: 262_144, linear: 1_048_576, jira: 1_048_576 } as const

/** Verified HTTP intake acknowledges before any Redis, entitlement or relay work. No payload is logged. */
export function createIntake(adapter: PlatformAdapter, deps: IntakeDeps = {}) {
  const config = () => deps.config ?? readConfig()
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const store = deps.store ?? everywhereStore()
  const ports = deps.ports ?? safePorts(config())
  const platforms = { ...deps.platforms, [adapter.id]: adapter }
  const context = (): JobsContext => ({ store, now: now(), keys: config().dataKeys, offer: config().offer })
  const events = createJobEvents(context, platforms)

  async function repository(parsed: ParsedTrigger): Promise<Repository | undefined> {
    const mapping = await findMapping(store, parsed.trigger.installation, parsed.place)
    const named = parsed.trigger.repository?.fullName
    const selected = named
      ? mapping?.repositories.find((item) => item.fullName.toLowerCase() === named.toLowerCase())
      : mapping?.repositories.length === 1 ? mapping.repositories[0] : undefined
    if (!selected || !isRepositoryName(selected.fullName)) return undefined
    const resolved = await ports.repository?.(selected.fullName)
    // An id or visibility copied from a webhook cannot widen the mapped repository's authority.
    if (!resolved || resolved.fullName.toLowerCase() !== selected.fullName.toLowerCase()) return undefined
    if (selected.id !== undefined && resolved.id !== selected.id) return undefined
    return resolved
  }

  async function process(original: ParsedTrigger, initial: JobView) {
    let parsed = original
    let trigger = parsed.trigger
    let view = initial
    const claim = await claimDelivery(store, trigger.platform, trigger.deliveryId, initial.jid)
    if (claim === "seen") return
    const acknowledged = await adapter.acknowledge(view)
    if (acknowledged) view = { ...view, reply: { ...view.reply, ...acknowledged } }
    const snapshot = await readInstallSnapshot(store, trigger.installation)
    const installation = snapshot?.record
    if (!installation || trigger.actor.bot || trigger.actor.external || trigger.actor.guest || trigger.actor.userId === installation.botUserId) {
      await finishDelivery(store, trigger.platform, trigger.deliveryId, initial.jid)
      return
    }
    if (adapter.prepare) {
      const prepared = await adapter.prepare(parsed, installation)
      if ("ignore" in prepared) { await finishDelivery(store, trigger.platform, trigger.deliveryId, initial.jid); return }
      const decoded = decodeInboundTrigger(prepared.trigger)
      if (!decoded.ok || prepared.trigger.platform !== trigger.platform || prepared.trigger.installation !== trigger.installation ||
        prepared.trigger.deliveryId !== trigger.deliveryId || prepared.trigger.actor.userId !== trigger.actor.userId ||
        prepared.trigger.thread.ref !== trigger.thread.ref || prepared.place !== parsed.place || (trigger.shared && !prepared.trigger.shared))
        throw new ApiError(400, "TRIGGER_INVALID", "The native trigger could not be verified.")
      parsed = prepared
      trigger = prepared.trigger
      view = { ...view, shared: trigger.shared, reply: { ...view.reply, ...prepared.reply } }
      if (trigger.actor.bot || trigger.actor.external || trigger.actor.guest) {
        await adapter.refuse(trigger, trigger.actor.bot ? "bot" : trigger.actor.external ? "external" : "guest")
        await finishDelivery(store, trigger.platform, trigger.deliveryId, initial.jid)
        return
      }
    }
    if (await adapter.control?.(parsed, installation)) {
      await finishDelivery(store, trigger.platform, trigger.deliveryId, initial.jid)
      return
    }
    const linked = await findLink(store, trigger.installation, trigger.actor.userId)
    if (!linked) {
      await adapter.linkPrompt(trigger)
      await finishDelivery(store, trigger.platform, trigger.deliveryId, initial.jid)
      return
    }
    const sponsor = linked.account
    const verdict = mayTrigger({ route: "laptop", sponsor, requester: { ...trigger.actor, account: linked.account } })
    if (!verdict.ok) {
      await adapter.refuse(trigger, verdict.code)
      await finishDelivery(store, trigger.platform, trigger.deliveryId, initial.jid)
      return
    }
    if (trigger.kind === "command") {
      await adapter.help(trigger)
      await finishDelivery(store, trigger.platform, trigger.deliveryId, initial.jid)
      return
    }
    if (trigger.kind === "stop") {
      const members = await store(["ZRANGE", everywhereKeys.jobs(sponsor), 0, -1])
      for (const jid of Array.isArray(members) ? members : []) {
        if (typeof jid !== "string") continue
        const job = await readJob(store, jid)
        if (!job || job.installation !== trigger.installation || job.requester.userId !== trigger.actor.userId) continue
        const reply = openReply(context(), job)
        if (!reply || reply.ref !== parsed.reply.ref || reply.ref === undefined) continue
        const cancelled = await cancelJob(context(), job.jid)
        if (cancelled.ok) await events.ended?.({ job: cancelled.job })
      }
      await finishDelivery(store, trigger.platform, trigger.deliveryId, initial.jid)
      return
    }
    for (const ended of await sweepAccount(context(), sponsor, { stop: await ports.switch("everywhere") === "stop" })) await events.ended?.(ended)
    const subject = { sponsor, installation: trigger.installation, userId: trigger.actor.userId }
    const counts = await readCounts(store, subject, now())
    const resolved = await repository(parsed)
    const facts = await routeFacts({ ctx: context(), ports, trigger, sponsor, repository: resolved, counts, receivedAt: now() })
    const decision = decideRoute(facts)
    if (decision.action === "refuse" || decision.action === "hand-back") {
      await adapter.refuse(trigger, decision.code)
      await finishDelivery(store, trigger.platform, trigger.deliveryId, initial.jid)
      return
    }
    if (decision.action === "ask-repository" || !resolved) {
      const mapping = await findMapping(store, trigger.installation, parsed.place)
      await adapter.repositoryPrompt(trigger, mapping?.repositories ?? [])
      await finishDelivery(store, trigger.platform, trigger.deliveryId, initial.jid)
      return
    }
    // Always server-derived: a webhook, native payload or laptop cannot choose the authority for later posts.
    view = { ...view, reply: { ...view.reply, installRevision: installationAuthority(snapshot!) } }
    const created = await createJob(context(), {
      platform: trigger.platform, installation: trigger.installation, kind: trigger.kind,
      requester: { userId: trigger.actor.userId, account: linked.account }, sponsor,
      repository: resolved, shared: trigger.shared, issue: trigger.issue, github: trigger.github,
      task: trigger.task, context: trigger.context, reply: view.reply,
    }, { jid: initial.jid, deliveryId: trigger.deliveryId, installationRecord: snapshot!.raw })
    if (!created.ok) {
      if (created.code === "duplicate") return
      if (created.code === "installation-changed") {
        await finishDelivery(store, trigger.platform, trigger.deliveryId, initial.jid)
        return
      }
      await adapter.refuse(trigger, created.code === "over-limit" ? "over-limit" : "unsupported")
      await finishDelivery(store, trigger.platform, trigger.deliveryId, initial.jid)
      return
    }
    // Dedupe is durable before the 20-second offer window. A platform retry must not create another accepted job.
    await finishDelivery(store, trigger.platform, trigger.deliveryId, initial.jid)
    return routeJob({ context, ports, adapter, now, sleep, view: (job) => ({ ...view, job }) }, created.job, facts)
  }

  return {
    process,
    async handler(request: ApiRequest, response: ApiResponse) {
      try {
        requireMethod(request, "POST")
        if (!platformOn(config(), adapter.id)) return json(response, 404, { error: { code: "EVERYWHERE_OFF" } })
        const raw = await readRawBody(request, BODY_LIMIT[adapter.id])
        const headers = new Headers()
        for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value)
        const verified = await adapter.verify(raw, headers, now())
        if (!verified.ok) return json(response, verified.status, { error: { code: "SIGNATURE_INVALID" } })
        const parsed = adapter.parse(verified.body)
        if ("ignore" in parsed) return json(response, 200, { received: true })
        const decoded = decodeInboundTrigger(parsed.trigger)
        if (!decoded.ok || parsed.trigger.platform !== adapter.id) return json(response, 400, { error: { code: "TRIGGER_INVALID" } })
        if (parsed.trigger.actor.bot || parsed.trigger.actor.external || parsed.trigger.actor.guest) return json(response, 200, { received: true })
        const view: JobView = { jid: createJobId(now()), platform: adapter.id, installation: parsed.trigger.installation,
          shared: parsed.trigger.shared, reply: parsed.reply }
        // Slow stores never delay the platform's HTTP acknowledgement. The first signal precedes every routing port.
        after("intake", () => process(parsed, view))
        return json(response, 200, { received: true })
      } catch (error) {
        // ApiError messages can contain platform text; only a fixed public code leaves this boundary.
        return json(response, error instanceof ApiError ? error.statusCode : 503, { error: { code: error instanceof ApiError ? error.code : "EVERYWHERE_UNAVAILABLE" } })
      }
    },
  }
}
