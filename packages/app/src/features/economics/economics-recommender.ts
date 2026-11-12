import {
  completedOutcome,
  outcomeCostCoverage,
  outcomeLatencyCoverage,
  outcomeModelKey,
  outcomeQualityScore,
  totalTokens,
  type ModelOutcome,
  type ModelRecommendation,
  type TaskCategory,
} from "./economics-types"

type Group = {
  provider: string
  model: string
  variant: string
  outcomes: ModelOutcome[]
}

type AvailableModel = { providerID: string; modelID: string; variants: readonly string[] }

export function recommendationAvailable(
  recommendation: Pick<ModelRecommendation, "provider" | "model" | "variant">,
  models: readonly AvailableModel[],
) {
  if (Billing.isCodium(recommendation.provider)) return false
  return models.some(
    (model) =>
      model.providerID === recommendation.provider &&
      model.modelID === recommendation.model &&
      model.variants.includes(recommendation.variant),
  )
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// undefined when no outcome in this group ran validation checks.
function checkPassRateOf(outcomes: ModelOutcome[]): number | undefined {
  const checked = outcomes.filter((o) => o.hadChecks && o.checksPassed !== undefined)
  if (checked.length === 0) return undefined
  return checked.filter((o) => o.checksPassed === true).length / checked.length
}

function medianTokensOf(outcomes: ModelOutcome[]): number | undefined {
  const counts = outcomes
    .map((o) => o.usage)
    .filter((usage) => usage !== undefined)
    .map(totalTokens)
  if (counts.length === 0) return undefined
  return median(counts)
}

function evidenceFor(group: Group, category: TaskCategory): string[] {
  const outcomes = group.outcomes
  const evidence: string[] = []

  const checked = outcomes.filter((o) => o.hadChecks && o.checksPassed !== undefined)
  if (checked.length > 0) {
    const passed = checked.filter((o) => o.checksPassed === true).length
    evidence.push(`checks passed ${passed}/${checked.length} runs`)
  }

  const completed = outcomes.filter(completedOutcome).length
  const unsuccessful = outcomes.filter(
    (outcome) => outcome.execution !== undefined && outcome.execution !== "completed",
  ).length
  evidence.push(`${completed} completed or positively validated runs; ${unsuccessful} failed, aborted or incomplete`)

  const coverage = outcomeCostCoverage(outcomes)
  const timing = outcomeLatencyCoverage(outcomes)
  const tokens = medianTokensOf(outcomes)
  evidence.push(
    `${coverage.pricedSamples}/${outcomes.length} priced${coverage.medianCostUsd === undefined ? "" : `; median $${coverage.medianCostUsd.toFixed(4)} per priced run`}`,
  )
  if (tokens !== undefined) evidence.push(`median ${Math.round(tokens).toLocaleString()} tokens`)
  evidence.push(`${timing.timedSamples}/${outcomes.length} timed with complete recorded reply intervals`)

  evidence.push(
    `${outcomes.length} recorded ${category} run${outcomes.length === 1 ? "" : "s"} for ${group.provider}/${group.model} · ${group.variant} effort preset`,
  )
  return evidence
}

// Completion is not test validation: observed failed checks need at least one credible passing validation.
// Rank all recorded work by checks and execution reliability before cost and latency; dropping failures
// here would reward models for stopping early.
export function recommendModel(
  outcomes: ModelOutcome[],
  category: TaskCategory,
  minSamples = 3,
  available?: readonly AvailableModel[],
): ModelRecommendation | undefined {
  const groups = new Map<string, Group>()
  for (const outcome of outcomes) {
    if (Billing.isCodium(outcome.provider)) continue
    if (!outcome.provider || !outcome.model || outcome.mixedModels) continue
    if (outcome.category !== category || outcome.variant?.kind !== "named" || !outcome.variant.name) continue
    const candidate = { provider: outcome.provider, model: outcome.model, variant: outcome.variant.name }
    if (available && !recommendationAvailable(candidate, available)) continue
    const key = outcomeModelKey(outcome)
    const group = groups.get(key) ?? { ...candidate, outcomes: [] }
    group.outcomes.push(outcome)
    groups.set(key, group)
  }

  const eligible = [...groups.values()].filter((group) => {
    if (group.outcomes.filter(completedOutcome).length < minSamples) return false
    return (
      !group.outcomes.some((outcome) => outcome.hadChecks && outcome.checksPassed === false) ||
      group.outcomes.some((outcome) => outcome.hadChecks && outcome.checksPassed === true && completedOutcome(outcome))
    )
  })
  if (eligible.length === 0) return undefined

  const ranked = eligible
    .map((group) => ({
      group,
      checkPassRate: checkPassRateOf(group.outcomes),
      qualityScore: outcomeQualityScore(group.outcomes),
      ...outcomeLatencyCoverage(group.outcomes),
      ...outcomeCostCoverage(group.outcomes),
      medianTokens: medianTokensOf(group.outcomes),
    }))
    .sort((a, b) => b.qualityScore - a.qualityScore)

  const tied = ranked.filter((entry) => entry.qualityScore === ranked[0].qualityScore)
  // Do not turn incomplete price coverage into a latency-based recommendation. A strict quality winner
  // remains actionable, but a cost comparison needs enough priced samples and no omitted paid work.
  if (tied.length > 1 && tied.some((entry) => entry.unknownCostSamples > 0 || entry.pricedSamples < minSamples))
    return undefined
  if (tied.length > 1) tied.sort((a, b) => a.medianCostUsd! - b.medianCostUsd!)
  const cheapest = tied.filter((entry) => entry.medianCostUsd === tied[0].medianCostUsd)
  // Timing is needed only after quality and price tie. Missing intervals and legacy workspace ages
  // cannot make a candidate look faster; strict quality/price winners remain actionable.
  if (
    cheapest.length > 1 &&
    cheapest.some((entry) => entry.unknownLatencySamples > 0 || entry.timedSamples < minSamples)
  )
    return undefined
  if (cheapest.length > 1)
    cheapest.sort(
      (a, b) =>
        a.medianLatencyMs! - b.medianLatencyMs! ||
        outcomeModelKey(a.group.outcomes[0]).localeCompare(outcomeModelKey(b.group.outcomes[0])),
    )

  const best = cheapest[0]
  return {
    provider: best.group.provider,
    model: best.group.model,
    variant: best.group.variant,
    sampleSize: best.group.outcomes.length,
    completedSamples: best.group.outcomes.filter(completedOutcome).length,
    pricedSamples: best.pricedSamples,
    unknownCostSamples: best.unknownCostSamples,
    checkPassRate: best.checkPassRate,
    medianLatencyMs: best.medianLatencyMs,
    timedSamples: best.timedSamples,
    unknownLatencySamples: best.unknownLatencySamples,
    medianCostUsd: best.medianCostUsd,
    medianTokens: best.medianTokens,
    evidence: evidenceFor(best.group, category),
  }
}
import { Billing } from "@vectordevai/schema/billing"
