// Which job an Actions event belongs to (sections 2.2 and 3.14). Pure, so the review job, the task job and the
// tests read the same answer. The route job in the workflow runs core's parseReviewCommand directly
// (@vectordevai/core/review/workflow); this is the CLI side of the same rules.

import { GithubAgents } from "@vectordevai/core/github-agents"
import { DEFAULT_MENTIONS, parseReviewCommand } from "@vectordevai/core/review/command"

// Task comments use the same mentions as reviews: the /vector and /vs commands and the aliases installed workflows bake
// in. The App handle (@<slug>) arrives through a workflow's MENTIONS once the workflow bakes it in.
export const TASK_MENTIONS = GithubAgents.mentions()

// The pull_request actions that start an automatic review.
export const REVIEW_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"]

export interface RouteEvent {
  eventName: string
  payload: Record<string, any>
}

export interface RouteComment {
  id: number
  kind: "issue" | "review" // an issue comment, or a pull request review comment
  author: string
  body: string
}

export type GithubRoute =
  | { job: "review"; trigger: "auto" | "command"; full: boolean; pr: number; comment?: RouteComment }
  | { job: "control"; kind: "pause" | "resume"; pr: number; comment: RouteComment }
  | { job: "task" }
  | { job: "none"; reason: string }

// A comma-separated MENTIONS value, or the fallback.
export function mentionsFrom(value: string | undefined, fallback: readonly string[] = DEFAULT_MENTIONS): string[] {
  const list = (value ?? "")
    .split(",")
    .map((mention) => mention.trim().toLowerCase())
    .filter(Boolean)
  return list.length ? list : [...fallback]
}

export function routeGithubEvent(event: RouteEvent, mentions: readonly string[] = DEFAULT_MENTIONS): GithubRoute {
  const payload = event.payload ?? {}
  switch (event.eventName) {
    case "pull_request": {
      if (!REVIEW_ACTIONS.includes(payload.action)) return none(`pull_request "${payload.action}" is not reviewed`)
      const pr = payload.pull_request?.number
      if (!isNumber(pr)) return none("the event has no pull request")
      return { job: "review", trigger: "auto", full: false, pr }
    }
    case "workflow_dispatch": {
      // Workflows without a `pr` input dispatch tasks with PROMPT, as before reviews.
      if (payload.inputs?.pr === undefined || payload.inputs?.pr === "") return { job: "task" }
      const pr = Number(payload.inputs.pr)
      if (!isNumber(pr)) return none(`inputs.pr "${payload.inputs.pr}" is not a pull request number`)
      return { job: "review", trigger: "auto", full: false, pr }
    }
    case "issue_comment":
    case "pull_request_review_comment": {
      const comment = payload.comment
      if (!comment) return none("the event has no comment")
      if (payload.action !== undefined && payload.action !== "created") return none(`comment "${payload.action}"`)
      // Bot comments never start anything, so Vector cannot answer itself.
      if (comment.user?.type === "Bot") return none("comments by bots are ignored")
      const kind = parseReviewCommand(String(comment.body ?? ""), [...mentions]).kind
      if (kind === "task") return { job: "task" }
      if (kind === "none") return none("the comment has no command")
      if (kind === "dismiss") return none("a dismissal is read on the next review")
      const review = event.eventName === "pull_request_review_comment"
      const pr = review ? payload.pull_request?.number : payload.issue?.pull_request ? payload.issue?.number : undefined
      if (!isNumber(pr)) return none(`\`${kind}\` works only on pull requests`)
      const routed: RouteComment = {
        id: comment.id,
        kind: review ? "review" : "issue",
        author: String(comment.user?.login ?? ""),
        body: String(comment.body ?? ""),
      }
      if (kind === "pause" || kind === "resume") return { job: "control", kind, pr, comment: routed }
      return { job: "review", trigger: "command", full: kind === "review-full", pr, comment: routed }
    }
    case "issues":
    case "schedule":
      return { job: "task" }
    default:
      return none(`${event.eventName} events are not handled`)
  }
}

function none(reason: string): GithubRoute {
  return { job: "none", reason }
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}
