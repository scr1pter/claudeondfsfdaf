import { renderEnd, renderRefusal, renderResult } from "../../../packages/schema/src/everywhere-policy.js"
import type { JobEvents } from "./jobs-api.js"
import { clearSummary, openReply, openSummary, readJob, type EndedJob, type JobRecord, type JobsContext } from "./jobs.js"
import { everywhereKeys } from "./keys.js"
import type { JobView, Platforms } from "./platform.js"
import { setValue } from "./store.js"

export function jobView(ctx: JobsContext, job: JobRecord): JobView {
  return { jid: job.jid, platform: job.platform, installation: job.installation, shared: job.shared,
    reply: openReply(ctx, job) ?? {}, job }
}

/** A summary is erased only after its adapter confirms the post, never after a failed delivery. */
export function createJobEvents(context: () => JobsContext, platforms: Platforms | (() => Platforms)): JobEvents {
  const adapters = () => typeof platforms === "function" ? platforms() : platforms
  const finish = async (job: JobRecord, ending?: EndedJob["ending"]) => {
    const adapter = adapters()[job.platform]
    if (!adapter) return
    const ctx = context()
    const queued = await ctx.store(["ZSCORE", everywhereKeys.jobsPosts(), job.jid])
    if (queued === null || queued === undefined) return
    // Platform requests are bounded below this lock's lifetime. Adapters edit their job-marked result on retries.
    if (!await setValue(ctx.store, everywhereKeys.jobPostLock(job.jid), "1", { ttlMs: 60_000, onlyNew: true })) return
    const view = jobView(ctx, job)
    try {
      if (ending) await adapter.finish(view, { text: renderEnd(ending, job.platform) })
      else if (job.code) await adapter.finish(view, { text: renderRefusal(job.code, { platform: job.platform, repository: job.repository.fullName, shared: job.shared }) })
      else {
        const rendered = renderResult({
          platform: job.platform, repository: job.repository.fullName, shared: job.shared,
          route: job.route === "actions" ? "actions" : "laptop", outcome: job.outcome ?? "cancelled",
          summary: openSummary(ctx, job), ...job.result,
        })
        await adapter.finish(view, rendered)
      }
      await clearSummary(ctx, job.jid)
      await ctx.store(["ZREM", everywhereKeys.jobsPosts(), job.jid])
    } catch (error) {
      await ctx.store(["ZADD", everywhereKeys.jobsPosts(), ctx.now + 60_000, job.jid])
      throw error
    }
  }
  return {
    claimed: async (job) => { await adapters()[job.platform]?.progress(jobView(context(), job), "laptop") },
    reported: async (job) => {
      if (job.milestone !== "heartbeat") await adapters()[job.platform]?.progress(jobView(context(), job), job.milestone ?? "started")
    },
    settled: finish,
    declined: async (job) => { if (job.state === "refused") await finish(job) },
    ended: ({ job, ending }) => finish(job, ending),
  }
}

/** The terminal transition itself enqueues this work, so process death before the HTTP event cannot strand a result. */
export async function postPending(context: () => JobsContext, platforms: Platforms | (() => Platforms), limit = 200) {
  const ctx = context()
  const members = await ctx.store(["ZRANGEBYSCORE", everywhereKeys.jobsPosts(), "-inf", ctx.now, "LIMIT", 0, limit])
  if (!Array.isArray(members)) return 0
  const events = createJobEvents(context, platforms)
  let posted = 0
  for (const jid of members) {
    if (typeof jid !== "string") continue
    let job: JobRecord | undefined
    try { job = await readJob(ctx.store, jid) } catch {
      // A record from a newer deployment remains queued for that deployment, as jobs:due does.
      console.error("Vector everywhere: a queued record was unreadable", { jid, code: "record-unreadable" })
      // Keep newer records, but move this bounded page aside so a rollback cannot starve later replies.
      await ctx.store(["ZADD", everywhereKeys.jobsPosts(), "XX", ctx.now + 60_000, jid])
      continue
    }
    if (!job) {
      await ctx.store(["ZREM", everywhereKeys.jobsPosts(), jid])
      continue
    }
    try {
      await events.ended?.({ job, ending: job.ending })
      if (await ctx.store(["ZSCORE", everywhereKeys.jobsPosts(), jid]) === null) posted++
      else await ctx.store(["ZADD", everywhereKeys.jobsPosts(), "XX", ctx.now + 60_000, jid])
    } catch {
      console.error("Vector everywhere: a queued reply failed", { jid, code: "post-failed" })
    }
  }
  return posted
}
