import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"

/*
 * Settings > Roadmap vote (WP A34), as the app reads it. vectordev.ai keeps the ballots and decides who may vote from
 * the account's plan (Max and Ultra vote, Ultra also nominates); the app only shows its answer. The tab appears when the
 * Codium status lists the vote for this plan (`entitlements.vote`). Results are totals, after the vote closes, once at
 * least 20 ballots are counted, and the winner is "planned for the next release cycle": the page never gives a date
 * for a feature.
 */

export type RoadmapCandidate = { id: string; title: string; detail?: string }
export type RoadmapTotal = { id: string; title: string; votes: number }
export type RoadmapRefusal = "plan" | "payment" | "hold" | "unavailable"
export type RoadmapResults = {
  quarter: string
  closedAt: number
  minimum: number
  published: boolean
  counted?: number
  totals?: RoadmapTotal[]
  tied?: boolean
  winner?: { id: string; title: string; planned: string }
  choice?: string
}
export type Roadmap = {
  quarter: string
  ballot?: {
    quarter: string
    opensAt: number
    closesAt: number
    open: boolean
    candidates: RoadmapCandidate[]
    choice?: string
  }
  results?: RoadmapResults
  vote: { allowed: boolean; reason?: RoadmapRefusal }
  nominate: { allowed: boolean; nomination?: { title: string; detail?: string; at: number } }
}

export const ROADMAP_TITLE_MAX = 80
export const ROADMAP_DETAIL_MAX = 280
/** What the winner gets when vectordev.ai does not say: never a date. */
export const ROADMAP_PLANNED = "Planned for the next release cycle."

/** Whether Settings shows the Roadmap vote tab: the signed-in account's plan includes the listed vote. */
export function roadmapTab(status: ModelPlanStatus.Status | undefined) {
  return Boolean(status?.signedIn && !status.error && status.entitlements?.vote === true)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() && value.length <= max ? value : undefined
const QUARTER = /^\d{4}-q[1-4]$/

function candidates(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const list = value.flatMap((item): RoadmapCandidate[] => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id) return []
    const title = text(item.title, ROADMAP_TITLE_MAX * 2)
    if (!title) return []
    const detail = text(item.detail, ROADMAP_DETAIL_MAX * 2)
    return [{ id: item.id, title, ...(detail ? { detail } : {}) }]
  })
  return list.length === value.length && list.length > 0 ? list : undefined
}

function ballot(value: unknown): Roadmap["ballot"] {
  if (!isRecord(value) || typeof value.quarter !== "string" || !QUARTER.test(value.quarter)) return undefined
  const list = candidates(value.candidates)
  if (!list || !time(value.opensAt) || !time(value.closesAt) || typeof value.open !== "boolean") return undefined
  const choice =
    typeof value.choice === "string" && list.some((item) => item.id === value.choice) ? value.choice : undefined
  return {
    quarter: value.quarter,
    opensAt: value.opensAt,
    closesAt: value.closesAt,
    open: value.open,
    candidates: list,
    ...(choice ? { choice } : {}),
  }
}

function results(value: unknown): RoadmapResults | undefined {
  if (!isRecord(value) || typeof value.quarter !== "string" || !QUARTER.test(value.quarter)) return undefined
  if (!time(value.closedAt) || typeof value.published !== "boolean") return undefined
  const minimum = typeof value.minimum === "number" && Number.isSafeInteger(value.minimum) ? value.minimum : 20
  const base = {
    quarter: value.quarter,
    closedAt: value.closedAt,
    minimum,
    ...(typeof value.choice === "string" && value.choice ? { choice: value.choice } : {}),
  }
  if (!value.published) return { ...base, published: false }
  const totals = Array.isArray(value.totals)
    ? value.totals.flatMap((item): RoadmapTotal[] =>
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.title === "string" &&
        typeof item.votes === "number" &&
        Number.isSafeInteger(item.votes) &&
        item.votes >= 0
          ? [{ id: item.id, title: item.title, votes: item.votes }]
          : [],
      )
    : []
  if (!totals.length || typeof value.counted !== "number" || !Number.isSafeInteger(value.counted)) return undefined
  const winner =
    isRecord(value.winner) && typeof value.winner.id === "string" && typeof value.winner.title === "string"
      ? {
          id: value.winner.id,
          title: value.winner.title,
          planned:
            typeof value.winner.planned === "string" && value.winner.planned ? value.winner.planned : ROADMAP_PLANNED,
        }
      : undefined
  return {
    ...base,
    published: true,
    counted: value.counted,
    totals,
    tied: value.tied === true,
    ...(winner ? { winner } : {}),
  }
}

/**
 * vectordev.ai's roadmap answer, or undefined when it is not one. Parts this version cannot read are left out rather
 * than failing the page, and a refusal it does not know reads as "unavailable".
 */
export function decodeRoadmap(value: unknown): Roadmap | undefined {
  if (!isRecord(value) || typeof value.quarter !== "string" || !QUARTER.test(value.quarter)) return undefined
  const vote = isRecord(value.vote) ? value.vote : {}
  const nominate = isRecord(value.nominate) ? value.nominate : {}
  const nomination = isRecord(nominate.nomination) ? nominate.nomination : undefined
  const nominated =
    nomination && text(nomination.title, ROADMAP_TITLE_MAX * 2) && time(nomination.at)
      ? {
          title: nomination.title as string,
          ...(text(nomination.detail, ROADMAP_DETAIL_MAX * 2) ? { detail: nomination.detail as string } : {}),
          at: nomination.at as number,
        }
      : undefined
  const reasons: readonly RoadmapRefusal[] = ["plan", "payment", "hold", "unavailable"]
  const allowed = vote.allowed === true
  const reason = reasons.find((item) => item === vote.reason) ?? "unavailable"
  const current = ballot(value.ballot)
  const closed = results(value.results)
  return {
    quarter: value.quarter,
    ...(current ? { ballot: current } : {}),
    ...(closed ? { results: closed } : {}),
    vote: allowed ? { allowed } : { allowed, reason },
    nominate: { allowed: nominate.allowed === true && !nominated, ...(nominated ? { nomination: nominated } : {}) },
  }
}

/** Why this account cannot vote now, in Settings' words. */
export function refusalText(reason: RoadmapRefusal | undefined) {
  switch (reason) {
    case "plan":
      return "Voting is part of Vector Codium Max and Ultra."
    case "payment":
      return "Voting resumes once your Vector Codium payment goes through."
    case "hold":
      return "Voting is paused while your Vector Codium plan is on hold."
    default:
      return "Voting is unavailable right now. Try again shortly."
  }
}

/** The line under this quarter's ballot. */
export function ballotLine(current: NonNullable<Roadmap["ballot"]>, format: (time: number) => string) {
  if (!current.open) return `Voting opens ${format(current.opensAt)}.`
  return current.choice
    ? `Your vote is in. You can change it until voting closes ${format(current.closesAt)}.`
    : `Voting closes ${format(current.closesAt)}. You can change your vote until then.`
}

/** What the results say about the winner, or why there is none to show. */
export function resultsLine(closed: RoadmapResults) {
  if (!closed.published)
    return `Fewer than ${closed.minimum} ballots were counted, so no result is published for this vote.`
  if (closed.winner) return `${closed.winner.title}: ${closed.winner.planned}`
  return closed.tied ? "The top features tied. The team will say which goes first." : undefined
}

/** The title of the candidate this account voted for, from the same ballot. */
export function choiceTitle(closed: RoadmapResults) {
  return closed.choice ? closed.totals?.find((item) => item.id === closed.choice)?.title : undefined
}

/** A total's share of the counted ballots, as a whole percentage for the bar. */
export function totalShare(total: RoadmapTotal, counted: number | undefined) {
  return counted && counted > 0 ? Math.round((total.votes / counted) * 100) : 0
}

/** Whether a nomination's text is one vectordev.ai will take (it checks again). */
export function nominationReady(title: string, detail: string) {
  const name = title.replace(/\s+/g, " ").trim()
  const about = detail.replace(/\s+/g, " ").trim()
  return [...name].length >= 3 && [...name].length <= ROADMAP_TITLE_MAX && [...about].length <= ROADMAP_DETAIL_MAX
}
