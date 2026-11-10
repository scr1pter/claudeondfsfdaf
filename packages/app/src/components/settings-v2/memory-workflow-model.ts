// What Settings > Memory > Workflow insights says, kept apart from the page so the wording is tested and stays honest.
// For each size, the effort, subagent split and subagent model the build agent ran with in this repository, how often
// their checks passed, and what they cost. Learned defaults only ever make work cheaper.

export type WorkflowTier = "chat" | "light" | "standard" | "thorough"
export type WorkflowMode = "apply" | "observe" | "off"

export type WorkflowArm = {
  effortTier: WorkflowTier
  effort: string
  split: "solo" | "subagents"
  providerID: string
  modelID: string
  subagentModel?: "parent" | "small"
}

export type WorkflowArmStats = {
  arm: WorkflowArm
  rows: number
  weight: number
  signal: number
  passRate?: number
  lower?: number
  checkedShare: number
  costUsd?: number
  pricedWeight: number
  tokens?: number
  lastAt: number
}

export type WorkflowAdvice = {
  effortTier: WorkflowTier
  effort?: "default"
  split?: "solo"
  subagentModel?: "small"
  source: "learned" | "explore"
  reason: string
}

export type WorkflowTierInsights = {
  tier: WorkflowTier
  arms: readonly WorkflowArmStats[]
  advice?: WorkflowAdvice
  wouldAdvise?: WorkflowAdvice
  excluded: number
}

export const MODES: readonly { value: WorkflowMode; label: string }[] = [
  { value: "apply", label: "Apply" },
  { value: "observe", label: "Observe only" },
  { value: "off", label: "Off" },
]

/** The page's own words (sections 12 and 14). */
export const WORKFLOW = {
  intro:
    "For each size of work, Vector records which effort, subagent split and subagent model got this repository's checks passing, and at what cost. Where the runs show a cheaper setting passes as often for at least 20% less, it becomes the learned default.",
  own: "Your own picks always win. Learned defaults only drop Thorough's extra effort, skip subagents or use a cheaper subagent model; spend caps are unchanged.",
  privacy:
    "Workflow insights record numbers only: size, effort, subagent count, model id, outcome, steps, tokens and cost. They record no prompt or file text.",
  explore:
    "On one request in ten, try a setting that is cheaper by construction while it has too few runs to decide: default effort for Thorough work, or the small model for subagents. Off by default.",
  reset:
    "Reset forgets the runs these insights learned from. Resetting every size also clears the app's model recommendations for this repository.",
  empty: "No runs of this size yet.",
}

const SIZE: Record<WorkflowTier, string> = { chat: "Chat", light: "Light", standard: "Standard", thorough: "Thorough" }

/**
 * What the mode and Explore controls show: the owner's saved settings, which hold for every repository, so they show
 * the same whether a repository is open or its insights have loaded; the insights' copy only until settings load.
 */
export function controls(
  settings: { readonly workflow: WorkflowMode; readonly workflowExplore: boolean } | undefined,
  insights: { readonly mode: WorkflowMode; readonly explore: boolean } | undefined,
) {
  return {
    mode: settings?.workflow ?? insights?.mode ?? ("apply" as const),
    explore: settings?.workflowExplore ?? insights?.explore ?? false,
  }
}

export function tierLabel(tier: WorkflowTier) {
  return SIZE[tier]
}

/** The sizes insights cover: a greeting is never sized for effort, so Chat has none. */
export function sized<T extends { tier: WorkflowTier }>(tiers: readonly T[]) {
  return tiers.filter((item): item is T & { tier: Exclude<WorkflowTier, "chat"> } => item.tier !== "chat")
}

/**
 * What a size runs with when nothing is learned: Thorough raises effort for the agent and its subagents and pushes it
 * to split the work, Standard hands off a part when the agent decides it should, and Light works solo.
 */
export function sizeDefault(tier: WorkflowTier) {
  if (tier === "thorough") return "High effort, with subagents"
  if (tier === "standard") return "The model's default effort; subagents when the agent decides"
  return "The model's default effort, working solo"
}

/** What a learned default changes, in a few words. */
export function adviceLabel(advice: Pick<WorkflowAdvice, "effort" | "split" | "subagentModel">) {
  return [
    ...(advice.effort ? ["Default effort"] : []),
    ...(advice.split ? ["Working solo"] : []),
    ...(advice.subagentModel ? ["The small model for subagents"] : []),
  ].join(", ")
}

/**
 * One card's head: the size's own default against the learned one, and the sentence behind it. Outside Apply mode the
 * card says what would apply.
 */
export function card(insights: WorkflowTierInsights) {
  const advice = insights.advice ?? insights.wouldAdvise
  const verb = !insights.advice ? "Would use" : insights.advice.source === "explore" ? "Trying" : "Learned"
  return {
    title: tierLabel(insights.tier),
    current: sizeDefault(insights.tier),
    learned: advice ? `${verb}: ${adviceLabel(advice)}` : "No learned default yet",
    ...(advice ? { reason: advice.reason } : {}),
    excluded:
      insights.excluded > 0
        ? `${insights.excluded} run${insights.excluded === 1 ? "" : "s"} left out: you, the agent or config chose the effort, or the run read the web.`
        : undefined,
  }
}

/** An arm's row in the table: effort · split · model, runs, pass rate, checked share and cost. */
export function armRow(stats: WorkflowArmStats) {
  const arm = stats.arm
  return {
    setting: [
      arm.effort === "default"
        ? "Default effort"
        : `${arm.effort[0]?.toUpperCase() ?? ""}${arm.effort.slice(1)} effort`,
      arm.split === "solo" ? "solo" : arm.subagentModel === "small" ? "subagents on the small model" : "subagents",
      `${arm.providerID}/${arm.modelID}`,
    ].join(" · "),
    runs: `${stats.rows}`,
    passRate: passRate(stats),
    checked: `${Math.round(stats.checkedShare * 100)}%`,
    cost: cost(stats),
  }
}

/** Passed of checked runs, or why there is no rate. */
export function passRate(stats: Pick<WorkflowArmStats, "passRate" | "signal">) {
  if (stats.passRate === undefined || stats.signal <= 0) return "No checked runs"
  return `${Math.round(stats.passRate * stats.signal)} of ${Math.round(stats.signal)} (${Math.round(stats.passRate * 100)}%)`
}

/** Average dollars over priced runs. A run with an unpriced step has no cost, which is unknown, never $0. */
export function cost(stats: Pick<WorkflowArmStats, "costUsd">) {
  if (stats.costUsd === undefined) return "unknown"
  return `$${stats.costUsd.toFixed(2)}`
}
