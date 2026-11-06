// What Settings > Memory > Skills says about each learned skill, kept apart from the page so the wording is tested and
// stays honest. A learned skill is a procedure Vector drafted after a run turned a failing check green: guidance the
// agent may load, never a rule.

import { UNDO_DAYS, type MemoryHold, type MemoryStatus } from "./memory-model"

export type SkillUses = { loads: number; passes: number; fails: number; ignored: number; reverts: number }

export type SkillInfo = {
  key: string
  name: string
  description: string
  procedure: string
  checks: readonly string[]
  commands: readonly string[]
  failure?: string
  version: number
  drafter: "rules" | "model" | "user" | "import"
  approvedBy?: "user" | "vector"
  approvedAt?: number
  sharedPath?: string
  sharedAt?: number
  proven: number
  uses: SkillUses
  instructionLikeFailure: boolean
  fading: boolean
}

export type SkillEntryView = {
  id: string
  status: MemoryStatus
  hold?: MemoryHold
  private?: boolean
  stale: boolean
  createdAt?: number
  updatedAt: number
  lastUsedAt?: number
  skill?: SkillInfo
}

export type SkillLearning = "review" | "auto" | "off"
export type SkillDrafter = "off" | "local-only" | "always"

/** How Vector learns skills: the owner's review first, by default. */
export const LEARNING: readonly { value: SkillLearning; label: string }[] = [
  { value: "review", label: "Review first" },
  { value: "auto", label: "Apply automatically after a second matching success" },
  { value: "off", label: "Off" },
]

/** When a model may word a draft: Vector Local by default, since a draft names a run's commands and files. */
export const DRAFTERS: readonly { value: SkillDrafter; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "local-only", label: "Only with Vector Local" },
  {
    value: "always",
    label: "Always (sends a run's commands, file names and a short error excerpt to your model provider)",
  },
]

/** The page's own words (section 14). */
export const SKILLS = {
  intro:
    "When a run turns a failing check green, Vector drafts the steps that worked as a skill the agent may load in later sessions here. A learned skill is guidance the agent may load, never a rule.",
  privacy:
    "Learned skills and workflow insights are stored only in brain.db on this computer. Vector sends them nowhere, except that the optional skill drafter, when you set it to Always, sends one run's commands, file names and a short redacted error excerpt to your model provider. By default it runs only with Vector Local on.",
  draft:
    "A skill draft holds commands from a short allowed list, file names and a short redacted error excerpt from your own run. Secrets are refused.",
  guests:
    "Sessions with an invited guest teach nothing, and guests never see learned skills. Sessions that read the web, used MCP tools, took a subagent's report or read an outside document only draft skills held for your review.",
  shares:
    "A learned skill's steps stay out of public session shares and exports, and out of requests to models that may train on your prompts.",
  commands: "Every command in a skill still goes through your permission rules.",
  instructionLike: "The error text reads like instructions",
  share: "This changes repository settings. You'll be asked to trust them again when your running sessions finish.",
  shared: "Vector will ask you to trust this repository's new settings when your running sessions finish.",
  team: "A skill reaches your team only when you choose Share. Sharing writes one file in .vector/skills/ that you commit yourself. It carries no error excerpt, session ids, stats or evidence, and Vector checks it against your personal memory first.",
}

/** Days a draft waits for review before tidying drops it (the brain's pendingDays). */
export const PENDING_DAYS = 60

const DAY = 86_400_000

export type SkillSections = {
  review: SkillEntryView[]
  inUse: SkillEntryView[]
  archived: SkillEntryView[]
}

/** The tab's three lists: drafts waiting for the owner, skills in use, and what was put away, replaced or shared. */
export function sections(entries: readonly SkillEntryView[]): SkillSections {
  const newest = entries.toSorted((a, b) => b.updatedAt - a.updatedAt)
  return {
    review: newest.filter((entry) => entry.status === "proposed" || entry.status === "quarantined"),
    inUse: newest.filter((entry) => entry.status === "active"),
    archived: newest.filter((entry) => entry.status === "archived" || entry.status === "superseded"),
  }
}

function ago(at: number, now: number) {
  const days = Math.floor((now - at) / DAY)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  return `${days} days ago`
}

/** Why a draft is there: "Turned `bun typecheck` green in 2 sessions, last 3 days ago". */
export function why(input: { check?: string; sessions: number; lastAt: number }, now = Date.now()) {
  const sessions = Math.max(1, input.sessions)
  const what = input.check ? `Turned \`${input.check}\` green` : "The judge passed the work"
  return `${what} in ${sessions} session${sessions === 1 ? "" : "s"}, last ${ago(input.lastAt, now)}`
}

/** How long a draft still waits before tidying drops it. */
export function expiry(entry: Pick<SkillEntryView, "createdAt" | "updatedAt">, now = Date.now()) {
  const left = PENDING_DAYS - Math.floor((now - (entry.createdAt ?? entry.updatedAt)) / DAY)
  if (left <= 0) return "Dropped at the next tidy unless you approve it"
  return `Dropped in ${left} day${left === 1 ? "" : "s"} unless you approve it`
}

/** The badges a skill in use carries. */
export function badges(skill: Pick<SkillInfo, "fading" | "approvedBy">, entry?: Pick<SkillEntryView, "stale">) {
  return [
    ...(skill.approvedBy === "vector" ? ["Approved by Vector"] : []),
    ...(skill.fading ? ["Fading"] : []),
    ...(entry?.stale ? ["Its files are gone"] : []),
  ]
}

/** What the badges mean, for their titles. */
export const BADGE_TITLES: Record<string, string> = {
  "Approved by Vector":
    "Vector put it in use after a second matching success in another session. The agent asks you before it loads it.",
  Fading: "Loaded again and again without its check passing after it, so the agent is no longer offered it.",
  "Its files are gone": "Most of the files it names are gone, so the agent is not offered it until they are back.",
}

/** How proven a skill is, as the width of its weight bar. */
export function weight(proven: number) {
  return Math.round(Math.min(1, Math.max(0, proven)) * 100)
}

/** How a skill's loads fared, in one line. */
export function fared(uses: SkillUses) {
  return [
    `${uses.loads} load${uses.loads === 1 ? "" : "s"}`,
    `${uses.passes} passed`,
    `${uses.fails} failed`,
    `${uses.ignored} check not run`,
    `${uses.reverts} reverted`,
  ].join(" · ")
}

export function lastUsed(entry: Pick<SkillEntryView, "lastUsedAt">, now = Date.now()) {
  if (!entry.lastUsedAt) return "Not loaded yet"
  return `Last loaded ${ago(entry.lastUsedAt, now)}`
}

/** Undo takes back the version in use while it is new; after that the owner rolls back or archives it. */
export function undoable(
  entry: Pick<SkillEntryView, "status" | "updatedAt"> & { skill?: Pick<SkillInfo, "approvedAt"> },
  now = Date.now(),
) {
  if (entry.status !== "active") return false
  return now - (entry.skill?.approvedAt ?? entry.updatedAt) <= UNDO_DAYS * DAY
}

/** Only a skill the owner approved, in use, not private, held or stale, is shared. */
export function shareable(
  entry: Pick<SkillEntryView, "status" | "private" | "hold" | "stale"> & { skill?: Pick<SkillInfo, "approvedBy"> },
) {
  return (
    entry.status === "active" && entry.skill?.approvedBy === "user" && !entry.private && !entry.hold && !entry.stale
  )
}

export function sharePath(name: string) {
  return `.vector/skills/${name}/SKILL.md`
}

/** What a version's row says. */
export function versionLabel(
  version: { version: number; reason: string; actor: string; createdAt: number },
  current: number,
  now = Date.now(),
) {
  const reason =
    { learned: "learned", edited: "edited", imported: "imported", rollback: "rolled back" }[version.reason] ??
    version.reason
  const actor = { agent: "Vector", vector: "Vector", user: "you", import: "an import" }[version.actor] ?? version.actor
  return `Version ${version.version}: ${reason} by ${actor} ${ago(version.createdAt, now)}${version.version === current ? " (in use)" : ""}`
}

/** Whether the directory has no session at work, so reloading it for the shared skill's settings interrupts nothing. */
export function idle(statuses: Readonly<Record<string, { readonly type: string }>>) {
  return Object.values(statuses).every((status) => status.type === "idle")
}
