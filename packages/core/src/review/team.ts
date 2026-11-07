// Guarded team memory (VS-35a, addendum A, the Now window): the rules `teamMemory: "guarded"` will apply. Which
// dismissals may become team memory, which findings must never be suppressed by it, and when a finding is demoted.
// Pure and browser-safe. Nothing calls it before VS-35 wiring: prompt.ts and select.ts keep the legacy rule. Actors and
// untrusted signals may only exclude data here (I-2): no rule lets a dismissal, a role or a time add a pattern that
// the writer gate would not.

import { normalizeTitle, titleSimilarity } from "./fingerprint"
import type { TeamPattern } from "./prompt"
import type { Finding, ReviewConfig } from "./types"

// The same value as select.ts's own TEAM_SIMILARITY, held equal by a behaviour test; the wiring makes select.ts
// import this one.
export const TEAM_SIMILARITY = 0.5
// A pattern needs dismissals from at least this many distinct writers.
export const TEAM_WRITERS = 2
// The window a dismissal must fall in, in days. It is swept, so it is a parameter (GuardedTeamInput.windowDays), and
// a value outside these bounds counts no dismissal at all.
export const TEAM_WINDOW_DAYS = 90
export const TEAM_MIN_WINDOW_DAYS = 1
export const TEAM_MAX_WINDOW_DAYS = 365
// How far after `now` a dismissal may be dated and still count: the job's clock against GitHub's event times.
export const TEAM_CLOCK_SKEW_MS = 300_000
// At least this many threads resolved by one actor within this span, with no reply and no code change, are a batch.
export const BULK_RESOLVE_THREADS = 5
export const BULK_RESOLVE_MS = 60_000
// A dismissal this close to a push by a bot login, before or after it, on the same pull request.
export const BOT_PUSH_MS = 120_000
const MAX_PATTERNS = 30 // as teamPatterns
const DAY_MS = 86_400_000

// The `vector-dismissal` marker's tokens, as the addendum spells them, so the later writer needs no mapping. `w` is
// a writer who is not the PR author, `a` the PR author.
export const DISMISSAL_BY = ["w", "a"] as const
export type DismissalBy = (typeof DISMISSAL_BY)[number]
export const DISMISSAL_WHY = ["fp", "wontfix", "thumbs", "resolved", "cmd"] as const
export type DismissalWhy = (typeof DISMISSAL_WHY)[number]
// A salted hash of the dismissing login: lowercase hex, at least 12 characters (48 bits) so writers do not collide.
const DISMISSAL_HASH = /^[0-9a-f]{12,64}$/

export interface DismissalMarker {
  by: DismissalBy
  why: DismissalWhy
  hash: string
}

// Why a dismissal is not counted. The order is the precedence: a dismissal is counted under the first reason that
// applies, so the counts add up to the dismissals left out.
export const TEAM_EXCLUSIONS = [
  "unmarked", // no dismissal marker, or one that does not parse: the role is unknown
  "author", // the PR author dismissed it
  "own", // Vector's own action
  "undated",
  "outside-window",
  "bot-push",
  "bulk-resolve",
  "security", // a security pattern never becomes team memory
] as const
export type TeamExclusion = (typeof TEAM_EXCLUSIONS)[number]

export interface TeamDismissal {
  pattern: TeamPattern // the dismissed finding's category, directory and marker words
  marker?: DismissalMarker // absent: the role is unknown
  pr: number // the pull request the dismissal happened on
  // When the dismissing action itself happened, in ms since the epoch: the reaction's createdAt, the dismissing
  // reply's createdAt, or the thread's resolve event. Never the comment's created_at or updated_at: Vector rewrites
  // the marker of every dismissal it finds in one run within seconds, usually just after a push, so those times would
  // make every run look like a bulk resolve inside a bot-push window.
  at?: number
  // The thread has a reply from someone other than the dismissing actor. A reply by the actor itself (an agent posting
  // "Done" before it resolves the thread) is not one.
  replied?: boolean
  // The code at the finding's anchor changed between the finding and the dismissal.
  codeChanged?: boolean
}

export interface GuardedTeamInput {
  now: number // ms since the epoch
  windowDays?: number // TEAM_WINDOW_DAYS when absent
  botPushes?: readonly { pr: number; at: number }[] // pushes by a bot login, at the push's own time
  own?: readonly string[] // the dismissal-marker hashes of Vector's own logins
  max?: number // at most this many patterns, 30 when absent
}

// Only guardedMemory makes one: the key is not exported, so a legacy TeamPattern[] (teamPatterns' unfiltered,
// author-made patterns) cannot reach teamDemotion by mistake, and a copy decoded from JSON loses the key and demotes
// nothing.
const GUARDED = Symbol("vector-team-guarded")

export interface GuardedTeamMemory {
  readonly [GUARDED]: true
  patterns: TeamPattern[]
  // Every dismissal left out, by reason in TEAM_EXCLUSIONS order, whatever `max` is; zero counts are left out.
  excluded: { reason: TeamExclusion; count: number }[]
}

// Team memory from dismissals, newest first. A dismissal counts only with a well-formed marker from a writer who is not
// the PR author, dated inside the window, away from bot pushes and bulk resolves, and outside the security category. A
// pattern is kept when dismissals like it (sameTeamPattern) come from at least TEAM_WRITERS distinct writer hashes.
export function guardedMemory(dismissals: readonly TeamDismissal[], input: GuardedTeamInput): GuardedTeamMemory {
  const bulk = bulkMembers(dismissals)
  const reasons = dismissals.map((dismissal, index) => exclusion(dismissal, bulk.has(index), input))
  const counted = dismissals.flatMap((dismissal, index) =>
    reasons[index] === undefined && dismissal.marker
      ? [{ pattern: dismissal.pattern, hash: dismissal.marker.hash }]
      : [],
  )
  const max = input.max ?? MAX_PATTERNS
  const seen = new Set<string>()
  const patterns: TeamPattern[] = []
  for (const entry of counted) {
    // Written so a NaN `max` keeps no pattern.
    if (!(patterns.length < max)) break
    const key = `${entry.pattern.category} ${entry.pattern.dir} ${entry.pattern.words.join(",")}`
    if (seen.has(key)) continue
    seen.add(key)
    const writers = new Set(
      counted.filter((other) => sameTeamPattern(entry.pattern, other.pattern)).map((other) => other.hash),
    )
    if (writers.size < TEAM_WRITERS) continue
    patterns.push({ category: entry.pattern.category, dir: entry.pattern.dir, words: [...entry.pattern.words] })
  }
  return {
    [GUARDED]: true,
    patterns,
    excluded: TEAM_EXCLUSIONS.map((reason) => ({
      reason,
      count: reasons.filter((entry) => entry === reason).length,
    })).filter((entry) => entry.count > 0),
  }
}

// The directory team memory scopes a pattern to: the text before the last "/", or "" at the repository root, as
// teamPatterns computes it.
export function teamDir(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "" : path.slice(0, slash)
}

// The same category, the exact same directory, and titles at least TEAM_SIMILARITY alike.
export function sameTeamPattern(a: TeamPattern, b: TeamPattern): boolean {
  return a.category === b.category && a.dir === b.dir && titleSimilarity(a.words, b.words) >= TEAM_SIMILARITY
}

// A marker as the addendum's grammar allows it: a known role and reason, and a 12 to 64 character lowercase hex hash.
// state.ts's parser and guardedMemory both check it, so a record built from JSON fails closed as well.
export function isDismissalMarker(value: { by: string; why: string; hash: string }): value is DismissalMarker {
  return (
    DISMISSAL_BY.some((entry) => entry === value.by) &&
    DISMISSAL_WHY.some((entry) => entry === value.why) &&
    typeof value.hash === "string" &&
    DISMISSAL_HASH.test(value.hash)
  )
}

type NeverSuppressFinding = Pick<Finding, "category" | "severity" | "title" | "body"> &
  Partial<Pick<Finding, "source" | "failure" | "severityUnreadable">>

// Findings team memory never demotes: the security category or the security pass, any severity but concern or nit
// (blocking, or a value outside SEVERITIES), a severity the strict decoder could not read, any failure class under
// `guardrail: "strict"`, a crash or data-corruption failure under any guardrail, and crash or data-loss wording in the
// title or body. Over-matching only keeps a finding visible.
export function neverSuppress(finding: NeverSuppressFinding, config: Pick<ReviewConfig, "guardrail">): boolean {
  if (finding.category === "security" || finding.source === "security") return true
  if (finding.severityUnreadable === true) return true
  if (finding.severity !== "concern" && finding.severity !== "nit") return true
  if (config.guardrail === "strict" && finding.failure !== undefined) return true
  // The decoder keeps `failure` only under strict, so outside it this holds only for a hand-built finding.
  if (finding.failure?.class === "crash" || finding.failure?.class === "data-corruption") return true
  return SEVERE_WORDING.test(finding.title) || SEVERE_WORDING.test(finding.body)
}

// The guarded pattern a finding is demoted by, or none. One pattern is enough, because guardedMemory already required
// TEAM_WRITERS writers for it (legacy teamPenalty needs two patterns). The finding's title is normalized to up to 8
// tokens and a pattern keeps at most 6 marker words, as in teamPenalty, so an identical long title scores below 1.
export function teamDemotion(
  finding: NeverSuppressFinding & Pick<Finding, "path">,
  memory: GuardedTeamMemory,
  config: Pick<ReviewConfig, "guardrail">,
): TeamPattern | undefined {
  // A memory decoded from JSON has no key.
  if (!memory[GUARDED]) return undefined
  if (neverSuppress(finding, config)) return undefined
  const probe = { category: finding.category, dir: teamDir(finding.path), words: normalizeTitle(finding.title) }
  return memory.patterns.find((pattern) => sameTeamPattern(probe, pattern))
}

// Crash and data-loss wording, matched on word boundaries so "crashpad", "panicle" and "lossless" stay out.
const SEVERE_WORDING = new RegExp(
  [
    String.raw`\bcrash(?:es|ed|ing)?\b`,
    String.raw`\bpanic(?:s|ked|king)?\b`,
    String.raw`\bsegfaults?\b`,
    String.raw`\bsegmentation faults?\b`,
    String.raw`\bdata[ -]loss\b`,
    // "loses data", "lost update", "drops the user's writes", "deletes user data", "discards unsaved changes", "wipes
    // the database", "erases the user's settings". The verb needs one of these objects within two words, so "Delete
    // the unused import" stays out.
    String.raw`\b(?:lose|loses|losing|lost|drop|drops|dropped|dropping|delete|deletes|deleted|deleting|discard|discards|discarded|discarding|wipe|wipes|wiped|wiping|erase|erases|erased|erasing)\s+(?:[\w'’-]+\s+){0,2}(?:data|writes?|records?|rows?|updates?|changes?|databases?|settings)\b`,
    // "data is lost", "data gets overwritten", "data is deleted"
    String.raw`\bdata\s+(?:(?:is|are|was|were|gets|got|will be|can be|may be|might be|could be|would be)\s+)?(?:lost|wiped|erased|destroyed|corrupted|overwritten|truncated|dropped|deleted|discarded)\b`,
    String.raw`\bcorrupt(?:s|ed|ing|ion)?\b`,
    String.raw`\btruncat(?:e|es|ed|ing|ion)\b`,
    String.raw`\boverwr(?:ite|ites|ote|itten|iting)\b`,
    String.raw`\b(?:uncaught|unhandled)\s+(?:promise\s+)?(?:exceptions?|rejections?|errors?)\b`,
    String.raw`\b(?:null|nil)[ -](?:pointer|dereference)s?\b`,
    String.raw`\bdereferenc(?:e|es|ed|ing)\s+(?:a\s+)?(?:null|nil)\b`,
    String.raw`\bout[ -]of[ -]memory\b`,
    String.raw`\boom\b`,
    String.raw`\bstack[ -]overflows?\b`,
  ].join("|"),
  "i",
)

// Indices of the dismissals in a bulk batch: at least BULK_RESOLVE_THREADS `resolved` dismissals by one hash within
// BULK_RESOLVE_MS, none with a reply from someone else or a code change (unknown reads as none). Every dated record
// with a `resolved` marker joins the scan whatever else excludes it, across pull requests and roles, so a batch that
// straddles the window edge or mixes roles still marks each of its members.
function bulkMembers(dismissals: readonly TeamDismissal[]): Set<number> {
  const candidates = dismissals.flatMap((dismissal, index) => {
    const marker = dismissal.marker
    const at = dismissal.at
    if (!marker || marker.why !== "resolved" || at === undefined || !Number.isFinite(at)) return []
    if (dismissal.replied === true || dismissal.codeChanged === true) return []
    return [{ index, hash: marker.hash, at }]
  })
  const members = new Set<number>()
  for (const hash of new Set(candidates.map((entry) => entry.hash))) {
    const sorted = candidates.filter((entry) => entry.hash === hash).toSorted((a, b) => a.at - b.at)
    sorted.forEach((start, first) => {
      const last = sorted.findLastIndex((entry) => entry.at - start.at <= BULK_RESOLVE_MS)
      if (last - first + 1 < BULK_RESOLVE_THREADS) return
      sorted.slice(first, last + 1).forEach((entry) => members.add(entry.index))
    })
  }
  return members
}

// The first reason in TEAM_EXCLUSIONS that applies, or none. Each comparison is written so a NaN fails closed.
function exclusion(dismissal: TeamDismissal, bulk: boolean, input: GuardedTeamInput): TeamExclusion | undefined {
  const marker = dismissal.marker
  if (!marker || !isDismissalMarker(marker)) return "unmarked"
  if (marker.by === "a") return "author"
  if (input.own?.includes(marker.hash)) return "own"
  const at = dismissal.at
  if (at === undefined || !Number.isFinite(at)) return "undated"
  if (!inWindow(at, input)) return "outside-window"
  const pushes = input.botPushes ?? []
  // A bot push on the same pull request whose time is not a number excludes every dismissal there.
  if (pushes.some((push) => push.pr === dismissal.pr && !(Math.abs(push.at - at) > BOT_PUSH_MS))) return "bot-push"
  if (bulk) return "bulk-resolve"
  if (dismissal.pattern.category === "security") return "security"
  return undefined
}

// From `now` minus the window to `now` plus the clock skew, both ends inclusive, for a finite `at`. So a `now` that is
// not finite counts nothing (NaN fails both ends, +Infinity the first, -Infinity the second), and neither does a
// window outside TEAM_MIN_WINDOW_DAYS to TEAM_MAX_WINDOW_DAYS (NaN, Infinity, zero or negative).
function inWindow(at: number, input: GuardedTeamInput): boolean {
  const days = input.windowDays ?? TEAM_WINDOW_DAYS
  if (!(days >= TEAM_MIN_WINDOW_DAYS && days <= TEAM_MAX_WINDOW_DAYS)) return false
  return at >= input.now - days * DAY_MS && at <= input.now + TEAM_CLOCK_SKEW_MS
}
