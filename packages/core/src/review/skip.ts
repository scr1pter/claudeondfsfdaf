// Whether a pull request event gets a review (section 2.5). Rules apply in order and the first match wins. A command
// overrides the label, draft, author, branch, per-PR budget and size rules, never the month budget. Pure and
// browser-safe.

import { minimatch } from "minimatch"
import type { ReviewConfig, ReviewState, Trigger, Trust } from "./types"

// Honoured whatever `skipLabels` says; `/vector pause` and `/vector resume` add and remove it.
export const PAUSED_LABEL = "vector:paused"

export type SkipReason =
  | "month-budget"
  | "label"
  | "draft"
  | "author"
  | "branch"
  | "fork"
  | "already-reviewed"
  | "pr-budget"
  | "nothing-to-review"
  | "too-large"
  // VS-24: Review.run's zero-attempt trivial outcome (trivial.ts). decideSkip never gives it; the GitHub job's skip
  // through decideSkip state waits for the @vector merge. verdict.ts reads it as a policy skip.
  | "trivial"

export interface SkipInput {
  trigger: Trigger // "auto" for pull_request and workflow_dispatch, "command" for comments
  full?: boolean // `/vector review full`
  config: Pick<
    ReviewConfig,
    | "skipAuthors"
    | "skipLabels"
    | "skipBranches"
    | "maxFiles"
    | "maxChangedLines"
    | "maxCostUsdPerPr"
    | "maxCostUsdPerMonth"
  >
  state?: ReviewState
  head: string // full SHA of the pull request's head
  pr: { draft: boolean; author: string; labels: string[]; headBranch: string; fork: boolean }
  size: { files: number; changedLines: number } // from pulls.listFiles, after path-based ignores
  monthCostUsd?: number // this repository's review spend this month, when a month cap is set
}

// "summary" writes a note into the sticky comment; automatic runs write it once per commit (state.notedHead).
// "reply" answers the command that asked.
export type SkipNotify = "none" | "summary" | "reply"

export type SkipDecision = { skip: true; reason: SkipReason; notify: SkipNotify } | { skip: false; trust: Trust }

export function decideSkip(input: SkipInput): SkipDecision {
  const { config, state, pr } = input
  const auto = input.trigger === "auto"
  const once: SkipNotify = !auto || state?.notedHead !== input.head ? "summary" : "none"
  const skip = (reason: SkipReason, notify: SkipNotify = "none"): SkipDecision => ({ skip: true, reason, notify })

  if (config.maxCostUsdPerMonth > 0 && (input.monthCostUsd ?? 0) >= config.maxCostUsdPerMonth)
    return skip("month-budget", once)
  if (auto) {
    const skipLabels = new Set([PAUSED_LABEL, ...config.skipLabels].map((label) => label.toLowerCase()))
    if (pr.labels.some((label) => skipLabels.has(label.toLowerCase()))) return skip("label")
    if (pr.draft) return skip("draft")
    if (config.skipAuthors.some((author) => author.toLowerCase() === pr.author.toLowerCase())) return skip("author")
    if (config.skipBranches.some((glob) => minimatch(pr.headBranch, glob))) return skip("branch")
    // A command on a fork runs instead, in untrusted mode.
    if (pr.fork) return skip("fork")
  }
  if (!input.full && state?.head === input.head && state.unreviewed.length === 0 && !state.failed)
    return skip("already-reviewed", auto ? "none" : "reply")
  if (auto && config.maxCostUsdPerPr > 0 && (state?.costUsd ?? 0) >= config.maxCostUsdPerPr)
    return skip("pr-budget", once)
  if (input.size.files === 0) return skip("nothing-to-review", once)
  if (auto && (input.size.files > config.maxFiles || input.size.changedLines > config.maxChangedLines))
    return skip("too-large", once)
  return { skip: false, trust: pr.fork ? "untrusted" : "trusted" }
}
