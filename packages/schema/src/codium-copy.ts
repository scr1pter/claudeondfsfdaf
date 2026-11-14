import { ENTITLEMENTS, publicEntitlements, type Entitlements, type PerkId } from "./codium-entitlements.js"
import { CodiumPlan, type PlanId } from "./codium-plan.js"

export * as CodiumCopy from "./codium-copy.js"
export { PERK_IDS, type PerkId } from "./codium-entitlements.js"

/** Listing is decided by the server; copy never turns a feature on. */
export const requires: Readonly<Partial<Record<PerkId, readonly PerkId[]>>> = {
  "github-no-secret": ["github-agents"],
  scheduled: ["github-agents"],
  reviews: ["github-agents"],
  overnight: ["computer"],
  "on-call": ["alerts"],
  "ship-desk": ["alerts"],
}

export const COMPUTER_LABEL = "a computer Vector runs for you"
const ACTIONS = "in your own repo, on your own Actions minutes"

type PerkCopy = { label: string; applies: (caps: Entitlements) => boolean; text: (caps: Entitlements) => string }
const every = () => true

export const PERK_COPY: Readonly<Record<PerkId, PerkCopy>> = {
  "github-agents": {
    label: "GitHub agents on Codium",
    applies: every,
    text: (c) =>
      `Codium agents ${ACTIONS}: ${c.cloudAgents.atOnce} at once, ${c.cloudAgents.hours} hours a month, runs up to ${c.cloudAgents.longestRunMin} minutes.`,
  },
  "github-no-secret": {
    label: "No repo secret",
    applies: every,
    text: () => `Connect without adding a repo secret; runs stay ${ACTIONS}.`,
  },
  scheduled: {
    label: "Scheduled GitHub runs",
    applies: (c) => c.cloudAgents.scheduledPerDay > 0,
    text: (c) => `${c.cloudAgents.scheduledPerDay} scheduled runs a day ${ACTIONS}.`,
  },
  reviews: {
    label: "Reviews checked by a second lab",
    applies: every,
    text: () => `A second lab checks PR review findings ${ACTIONS}.`,
  },
  "second-opinion": {
    label: "Second opinion",
    applies: (c) => c.secondOpinion,
    text: () => "A second lab checks completed work using your plan's available judge models.",
  },
  remote: {
    label: "Vector Remote",
    applies: every,
    text: (c) =>
      `Follow your agents and approve their requests from your phone, with ${c.remote.computers} paired computers.`,
  },
  alerts: {
    label: "Phone alerts",
    applies: every,
    text: () => "Phone alerts when work finishes or needs your approval.",
  },
  vault: {
    label: "Brain Vault",
    applies: (c) => c.vault.gb > 0,
    text: (c) => `${c.vault.gb} GB of encrypted Brain backups, with versions kept for ${c.vault.versionDays} days.`,
  },
  computer: {
    label: "Cloud computer",
    applies: (c) => c.hosted !== null,
    text: (c) =>
      `Use ${COMPUTER_LABEL}: ${c.hosted!.computers} at once, ${c.hosted!.hours} hours a month, jobs up to ${c.hosted!.jobMin / 60} hours. Disks stay for ${c.hosted!.diskDays} days.`,
  },
  overnight: {
    label: "Done by Morning",
    applies: (c) => c.overnight !== null,
    text: (c) =>
      `${c.overnight!.perNight} jobs a night on ${COMPUTER_LABEL}, ${c.overnight!.atOnce} at once and ${c.overnight!.recurringPerDay} recurring jobs a day. Work that would go live waits for your approval.`,
  },
  "on-call": {
    label: "On Call",
    applies: (c) => c.ops !== null,
    text: (c) =>
      `${c.ops!.onCall.urls} verified URLs checked every ${c.ops!.onCall.intervalSec / 60} minutes, across ${c.ops!.onCall.domains} domains, with up to ${c.ops!.onCall.fixRunsPerDay} fix runs a day. Vector's agent is on call, not a person.`,
  },
  "release-guard": {
    label: "Release Guard",
    applies: (c) => c.ops !== null,
    text: (c) =>
      `${c.ops!.releaseGuard.perDay} releases a day, watched for ${c.ops!.releaseGuard.watchMin} minutes. Revert proposals wait for you to merge.`,
  },
  "ship-desk": {
    label: "Ship Desk",
    applies: (c) => c.ops !== null,
    text: (c) =>
      `${c.ops!.shipDesk.cardsPerMonth} private review cards a month, kept for ${c.ops!.shipDesk.keepDays} days, with checks and screenshots to review from your phone.`,
  },
  vote: {
    label: "Roadmap vote",
    applies: (c) => c.vote,
    text: (c) => (c.nominate ? "Vote on the roadmap and nominate a candidate each quarter." : "Vote on the roadmap."),
  },
  "reports-first": {
    label: "Reports read first",
    applies: (c) => c.reports.readFirst,
    text: (c) => `Reports read first, with up to ${c.reports.perHour} reports an hour.`,
  },
  priority: {
    label: "Priority when busy",
    applies: (c) => c.priority,
    text: () => "First in line when Codium is busy.",
  },
  "review-panel": {
    label: "Three-lab review panel",
    applies: every,
    text: () => "Use your available Codium models in a review panel with three different labs.",
  },
  founding: {
    label: "Founding member",
    applies: every,
    text: (c) =>
      `${c.foundingBoost ? "A usage boost, " : "A "}founding member mark and a price lock while your subscription stays active.`,
  },
  brain: {
    label: "Codium Brain",
    applies: every,
    text: () => "Let Codium helpers maintain your Brain. Their usage counts toward your month.",
  },
  "auto-learns": {
    label: "Auto learns your repo",
    applies: every,
    text: () => "Auto learns which models pass your repo's checks and keeps routine work on smaller models.",
  },
  "brain-cloud": {
    label: "Brain in GitHub runs",
    applies: every,
    text: () => `Bring your Brain to Codium runs ${ACTIONS}.`,
  },
  playbooks: {
    label: "Vector Playbooks",
    applies: (c) => c.playbooks,
    text: () => "Replay proven workflows with Codium models.",
  },
}

// The owner's approved 550B+ target is a plan, not a released model or part of a current purchase.
export const COMING = {
  velocity: {
    name: "Vector Velocity",
    label: "Coming",
    text: "Vector's planned 550B+ parameter coding model. Intended for Max and Ultra if it launches; no date, and not part of today's purchase.",
  },
} as const

type Tagline = { requires: readonly PerkId[]; text: string }
export const TAGLINES: Readonly<Record<PlanId, readonly Tagline[]>> = {
  "vector-10": [
    {
      requires: ["github-agents", "reviews", "remote"],
      text: `No keys. Reviews checked by a second lab, agents ${ACTIONS}, and approvals on your phone.`,
    },
    { requires: ["github-agents", "reviews"], text: `No keys. Agents and reviews checked by a second lab ${ACTIONS}.` },
    { requires: [], text: "Start with Codium. Bring your code, without provider keys." },
  ],
  "vector-50": [
    { requires: ["second-opinion", "vault"], text: "Two labs checking each other's work, and your Brain kept safe." },
    { requires: ["second-opinion"], text: "More room for your work, with a second lab checking it." },
    { requires: [], text: "More monthly usage for regular coding." },
  ],
  "vector-100": [
    { requires: ["computer"], text: `Close the laptop. Vector finishes on ${COMPUTER_LABEL}.` },
    { requires: ["github-agents"], text: `Close the laptop. Codium keeps working ${ACTIONS}.` },
    { requires: [], text: "A larger monthly allowance for demanding work." },
  ],
  "vector-200": [
    {
      requires: ["computer", "github-agents"],
      text: `The most time on ${COMPUTER_LABEL}. Codium agents ${ACTIONS}. No daily limit.`,
    },
    { requires: ["github-agents"], text: `The most Codium agent time ${ACTIONS}, with no daily limit.` },
    { requires: [], text: "The largest monthly allowance, with no daily limit." },
  ],
}

export const HEADLINE_ORDER: Readonly<Record<PlanId, readonly PerkId[]>> = {
  "vector-10": ["github-agents", "reviews", "brain", "remote"],
  "vector-50": ["second-opinion", "vault", "playbooks"],
  "vector-100": ["computer", "overnight", "github-agents", "scheduled", "release-guard", "ship-desk"],
  "vector-200": ["computer", "on-call", "github-agents", "scheduled"],
}

export const FREE_WORKSPACE = [
  "Desktop app and CLI",
  "Your own provider keys and free models",
  "Memory, skills and workflow insights",
  "Subagents and workflows you write",
  "Vectorscope with your own key, including its three-lab panel",
  "Automations",
  "Self-hosted sessions and invitations",
  "Desktop notifications",
  "Memory export and import",
  "Report status and fixes",
  "Race",
  "Outbound webhooks",
  "GitHub agents with your own key as a repo secret",
  "Back up your Brain to your own GitHub",
] as const

export const EVERY_PLAN = [
  "Zero-data-retention routing",
  "No provider keys needed",
  "No overage charges",
  "Monthly plans only, no top-ups",
  "Usage shown as a percentage",
  "Upgrade and keep what's left of this month",
] as const

/** Public, qualified model data only. No provider prices, private allowance or inferred staged routes. */
export type Model = {
  id: string
  name: string
  minPlan?: PlanId
  contextLength?: number
  plans?: readonly PlanId[]
  contextByPlan?: Partial<Record<PlanId, number>>
  category?: "everyday" | "advanced"
  description?: string
  previewUntil?: number
}

export function modelAvailable(model: Model, plan: PlanId) {
  return model.plans
    ? model.plans.includes(plan)
    : CodiumPlan.rank(plan) >= CodiumPlan.rank(model.minPlan ?? "vector-10")
}

export function tierView(plan: PlanId, listed: ReadonlySet<PerkId>, models: readonly Model[]) {
  const caps = ENTITLEMENTS[plan]
  const enabled = (id: PerkId): boolean => listed.has(id) && (requires[id] ?? []).every(enabled)
  const perks = (Object.keys(PERK_COPY) as PerkId[])
    .filter((id) => enabled(id) && PERK_COPY[id].applies(caps))
    .map((id) => ({ id, label: PERK_COPY[id].label, text: PERK_COPY[id].text(caps) }))
  const tagline = TAGLINES[plan].find((entry) => entry.requires.every((id) => perks.some((perk) => perk.id === id)))!
  const available = models.filter((model) => modelAvailable(model, plan))
  const previous = CodiumPlan.PLANS[CodiumPlan.rank(plan) - 2]
  const inherited = previous ? models.filter((model) => modelAvailable(model, previous.id)) : []
  const inherits =
    !!previous && inherited.length > 0 && inherited.every((model) => available.some((item) => item.id === model.id))
  const additions = inherits ? available.filter((model) => !inherited.some((item) => item.id === model.id)) : available
  const price = CodiumPlan.PLANS.find((entry) => entry.id === plan)!.price
  const morePerDollar = Math.round((caps.usageMultiple / (price / CodiumPlan.PLANS[0].price) - 1) * 100)
  const contexts = available.map((model) => model.contextByPlan?.[plan] ?? model.contextLength ?? 0)
  const context = contexts.length ? Math.min(caps.contextMax, Math.max(...contexts)) : 0
  return {
    tagline: tagline.text,
    taglineRequires: tagline.requires,
    usage:
      caps.rank === 1
        ? "Codium · coding models without provider keys"
        : `${caps.usageMultiple}x Plus's usage${morePerDollar > 0 ? ` · ${morePerDollar}% more per dollar` : ""}`,
    caps: publicEntitlements(plan, new Set(perks.map((perk) => perk.id))),
    perks,
    headlines: HEADLINE_ORDER[plan].flatMap((id) => perks.filter((perk) => perk.id === id)),
    models: available,
    additions,
    modelLead: inherits ? `Everything in ${previous.name}${additions.length ? ", plus:" : "."}` : undefined,
    coming: caps.velocity ? [COMING.velocity] : [],
    limits: [
      `${caps.inFlight} Codium requests at once`,
      `${caps.perMinute} requests a minute`,
      caps.dailyShare === null ? "No daily limit" : `Up to ${Math.round(caps.dailyShare * 100)}% of your month a day`,
      ...(context > 0 ? [`Up to ${Math.floor(context / 1000)}K context on available models`] : []),
    ],
  }
}
