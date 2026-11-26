import { randomUUID } from "node:crypto"
import { renderMilestone } from "../../../../packages/schema/src/everywhere-policy.js"
import { TERMINAL_STATES, type Milestone } from "../../../../packages/schema/src/everywhere.js"
import { ApiError } from "../../http.js"
import { openReply, readJob, updateJobReply, type JobsContext } from "../jobs.js"
import { everywhereKeys } from "../keys.js"
import type { JobView } from "../platform.js"
import { getValue, setValue, swapValue } from "../store.js"

/** R-C5's configured App port must find only the App's own exact job marker, never another user's comment. */
export type GithubStatusPort = {
  findOwnComment(repositoryId: number, issue: number, marker: string): Promise<{ id: number } | undefined>
  comment(repositoryId: number, issue: number, body: string): Promise<{ id: number }>
  editComment(repositoryId: number, id: number, body: string): Promise<void>
}

export function githubStatus(input: { readonly context: () => JobsContext; readonly port?: GithubStatusPort }) {
  async function post(view: JobView, text: string, terminal: boolean) {
    const port = input.port
    if (!port && !terminal) return
    const ctx = input.context()
    const lock = everywhereKeys.jobStatusLock(view.jid)
    const token = randomUUID()
    // Exclusion only, as Slack's: it outlasts a whole serverless invocation and is released below.
    // The 30 s edit throttle is its own key.
    if (!await setValue(ctx.store, lock, token, { onlyNew: true, ttlMs: 120_000 })) {
      if (terminal) throw new Error("Github status delivery is still locked")
      return
    }
    try {
      // Read under the lock: a progress post that read `running` before a terminal post took and released the lock
      // would otherwise overwrite the result with stale progress.
      const job = await readJob(ctx.store, view.jid)
      // Github's existing route job supplies the received reaction. Never post a refused handoff.
      if (!job?.github || job.platform !== "github" || job.startedAt === undefined) return
      if (terminal !== TERMINAL_STATES.has(job.state)) return
      // The outbox clears the summary only on successful delivery.
      if (!port) throw new ApiError(503, "GITHUB_STATUS_UNAVAILABLE", "GitHub status delivery is unavailable.")
      // VE-10: progress edits the status comment at most every 30 s. A terminal post ignores this.
      const edited = everywhereKeys.jobStatusEdited(job.jid)
      if (!terminal && await getValue(ctx.store, edited) !== undefined) return
      const marker = `<!-- vector:job ${job.jid} -->`
      const body = `${text}\n\n${marker}`
      const reply = openReply(ctx, job)
      const existing = typeof reply?.statusCommentId === "number" && Number.isSafeInteger(reply.statusCommentId) && reply.statusCommentId > 0
        ? { id: reply.statusCommentId } : await port.findOwnComment(job.repository.id, job.github.number, marker)
      if (existing && (!Number.isSafeInteger(existing.id) || existing.id < 1)) throw new Error("Invalid Github status reference")
      if (existing) await port.editComment(job.repository.id, existing.id, body)
      const comment = existing ?? await port.comment(job.repository.id, job.github.number, body)
      const retained = () => new Error("Github status reference was not retained")
      if (!Number.isSafeInteger(comment.id) || comment.id < 1) throw retained()
      // Set once Github holds the post and before the reference write, so a lost reference write cannot buy a
      // second edit within 30 s. A failed platform write sets none.
      if (!terminal) await setValue(ctx.store, edited, "1", { ttlMs: 30_000 })
      if (!await updateJobReply(input.context(), job.jid, { statusCommentId: comment.id })) throw retained()
    } finally {
      await swapValue(ctx.store, lock, token, undefined)
    }
  }
  return {
    progress: (view: JobView, step: Milestone | "laptop") => post(view, step === "laptop" ? "Working on your computer" : `Working on your computer: ${renderMilestone(step, { platform: "github", files: view.job?.files })}`, false),
    finish: (view: JobView, text: string) => post(view, text, true),
  }
}
