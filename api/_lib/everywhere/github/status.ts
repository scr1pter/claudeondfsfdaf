import { renderMilestone } from "../../../../packages/schema/src/everywhere-policy.js"
import { TERMINAL_STATES, type Milestone } from "../../../../packages/schema/src/everywhere.js"
import { openReply, readJob, updateJobReply, type JobsContext } from "../jobs.js"
import { everywhereKeys } from "../keys.js"
import type { JobView } from "../platform.js"
import { setValue } from "../store.js"

/** R-C5's configured App port must find only the App's own exact job marker, never another user's comment. */
export type GithubStatusPort = {
  findOwnComment(repositoryId: number, issue: number, marker: string): Promise<{ id: number } | undefined>
  comment(repositoryId: number, issue: number, body: string): Promise<{ id: number }>
  editComment(repositoryId: number, id: number, body: string): Promise<void>
}

export function githubStatus(input: { readonly context: () => JobsContext; readonly port?: GithubStatusPort }) {
  async function post(view: JobView, text: string, terminal: boolean) {
    if (!input.port) return
    const ctx = input.context()
    const job = await readJob(ctx.store, view.jid)
    // Github's existing route job supplies the received reaction. Never post a refused handoff.
    if (!job?.github || job.platform !== "github" || job.startedAt === undefined) return
    if (terminal !== TERMINAL_STATES.has(job.state)) return
    if (!await setValue(ctx.store, everywhereKeys.jobStatusLock(job.jid), "1", { onlyNew: true, ttlMs: 30_000 })) {
      if (terminal) throw new Error("Github status delivery is still locked")
      return
    }
    const marker = `<!-- vector:job ${job.jid} -->`
    const body = `${text}\n\n${marker}`
    const reply = openReply(ctx, job)
    const existing = typeof reply?.statusCommentId === "number" && Number.isSafeInteger(reply.statusCommentId) && reply.statusCommentId > 0
      ? { id: reply.statusCommentId } : await input.port.findOwnComment(job.repository.id, job.github.number, marker)
    if (existing && (!Number.isSafeInteger(existing.id) || existing.id < 1)) throw new Error("Invalid Github status reference")
    if (existing) await input.port.editComment(job.repository.id, existing.id, body)
    const comment = existing ?? await input.port.comment(job.repository.id, job.github.number, body)
    if (!Number.isSafeInteger(comment.id) || comment.id < 1 || !await updateJobReply(input.context(), job.jid, { statusCommentId: comment.id }))
      throw new Error("Github status reference was not retained")
  }
  return {
    progress: (view: JobView, step: Milestone | "laptop") => post(view, step === "laptop" ? "Working on your computer" : `Working on your computer: ${renderMilestone(step, { platform: "github", files: view.job?.files })}`, false),
    finish: (view: JobView, text: string) => post(view, text, true),
  }
}
