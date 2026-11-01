// One wording for what a session has spent, shared by the cost pill, its hover
// and the Context tab, so the same session never reads "$0.00" in one place and
// "cost unknown" in another.
//
// A model with no catalog price reports tokens but no dollars. Printing $0.00
// for it would claim the run was free when Vector simply cannot price it, so
// such a session reads "cost unknown" instead.

import { Billing } from "@vectordevai/schema/billing"
import { CodiumUsage } from "@vectordevai/core/codium-usage"
import { isFreeModel } from "@vectordevai/schema/free-model"
import { formatSessionCost } from "@/utils/session-cost"
import { ratesFor, type ModelRates } from "./model-pricing"

// "plan" is a model whose steps the signed-in account's plan pays for, which the engine marks in the catalog it serves
// while a ChatGPT sign-in is in use. Codium contributes no tokens or dollars to displayed totals.
export type SpendKind = "free" | "plan" | "unpriced" | "priced" | "codium"

export type SpendCatalog = ReadonlyMap<
  string,
  {
    models?: Record<string, { cost?: ModelRates & { plan?: boolean }; freeModel?: { source: string } } | undefined>
  }
>

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function spendKind(
  providers: SpendCatalog | undefined,
  providerID: string | undefined,
  modelID: string | undefined,
): SpendKind {
  if (Billing.isCodium(providerID)) return "codium"
  const model = providerID && modelID ? providers?.get(providerID)?.models?.[modelID] : undefined
  if (model?.freeModel) return "free"
  if (providerID && modelID && isFreeModel({ providerID, id: modelID, cost: model?.cost })) return "free"
  // The engine zeroes a plan model's rates and marks them, so its zero rates are not an unknown price.
  if (model?.cost?.plan) return "plan"
  if (!ratesFor(providers, providerID, modelID)) return "unpriced"
  return "priced"
}

// Two decimals, except a positive amount under a cent, which would otherwise
// round down to a "$0.00" that reads as free.
export function formatUsd(usd: number) {
  if (usd > 0 && usd < 0.01) return "<$0.01"
  return money.format(usd)
}

// Totals identify Codium across model switches. The latest own model supplies only the free/plan wording.
export function sessionReading(input: {
  cost: number
  unpricedSteps: number
  codiumSteps?: number
  tokens: number
  kind: SpendKind
  format: (value: number) => string
  t: (key: "session.cost.unknown" | "session.cost.partial", params: { cost: string }) => string
}): { label: string; kind: SpendKind; codiumSteps?: number } {
  const unknown = CodiumUsage.ownUnpricedSteps(input.unpricedSteps, input.codiumSteps)
  if (input.codiumSteps && !input.cost && !input.tokens && !unknown)
    return { label: Billing.LABEL, kind: "codium", codiumSteps: input.codiumSteps }
  const kind: SpendKind =
    input.cost > 0
      ? "priced"
      : unknown > 0
        ? "unpriced"
        : input.tokens === 0 || input.kind === "free" || input.kind === "plan"
          ? input.kind
          : "unpriced"
  const own =
    kind === "free" && !input.cost && input.tokens > 0
      ? "free"
      : kind === "plan" && !input.cost && input.tokens > 0
        ? "ChatGPT plan"
        : kind === "unpriced" && !input.cost && input.tokens > 0
          ? input.t("session.cost.unknown", { cost: input.format(0) })
          : undefined
  return {
    label: own ? CodiumUsage.withCodium(own, input.codiumSteps) : formatSessionCost(input),
    kind,
    ...(input.codiumSteps ? { codiumSteps: input.codiumSteps } : {}),
  }
}

// What the cost pill reads. The run guard's cap is per run, across the root
// session and its subagents, so it is only paired with the guard's own figure for
// that run, and only while the run is going: the session total adds up every run
// the session has had, and a finished run's reading would otherwise linger.
export function spendPill(input: {
  session: { label: string; kind: SpendKind; codiumSteps?: number }
  run: { spentUsd: number; capUsd?: number; state: "ok" | "warn" | "stopped" } | undefined
  running: boolean
}) {
  const session = input.session.label
  const kind = input.session.kind
  const capUsd = input.run?.capUsd
  // A cap is a dollar figure, so it never follows "free", "ChatGPT plan", "Codium" or "unpriced" for a run
  // that spent nothing.
  if (!input.run || capUsd === undefined || !input.running) return { label: session, session, kind, warn: false }
  if (!(input.run.spentUsd > 0)) return { label: session, session, kind, warn: false }
  const run = `${formatUsd(input.run.spentUsd)} of ${formatUsd(capUsd)}`
  return {
    label: CodiumUsage.withCodium(run, input.session.codiumSteps),
    session,
    run,
    capUsd,
    kind,
    warn: input.run.state === "warn",
  }
}

// The latest own model supplies the free/plan wording; Codium is identified from totals separately.
export function lastAssistantModel(
  messages: readonly { role: string; providerID?: string; modelID?: string; billing?: string }[],
) {
  const last = messages.findLast((message) => message.role === "assistant" && !Billing.of(message))
  if (!last) return undefined
  return { providerID: last.providerID, modelID: last.modelID }
}

export const SPEND_TOOLTIP: Record<SpendKind, string> = {
  priced:
    "Counted at the charge your provider reported for a step when it reports one, as OpenRouter does, and otherwise from the tokens it reported at catalog list price. Billed to your own provider account.",
  codium:
    "Billed to your Vector Codium plan. Vector shows its usage as a percentage in Settings → Usage, never as tokens or dollars.",
  plan: "Covered by your ChatGPT plan, which is not billed per token, so Vector counts no dollars for it.",
  unpriced: "This model has no catalog price, so Vector cannot put a dollar figure on it.",
  free: "Free model. No per-token charge to your key.",
}

export function capTooltip(capUsd: number) {
  return `This run is capped at ${formatUsd(capUsd)}. Vector stops within one step of the cap for each agent running at the time.`
}
