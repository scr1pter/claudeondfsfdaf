import { Billing } from "@vectordevai/schema/billing"
import type { ReviewOutcome, ReviewPass } from "@vectordevai/core/review/types"

function codiumPass(pass: ReviewPass, fallback = false) {
  return (
    pass.costKind === "codium" ||
    Billing.isCodium(pass.model.split("/")[0]) ||
    (!pass.costKind && !pass.model.includes("/") && fallback)
  )
}

/** Printed JSON cannot expose a Codium review's raw internal usage, including cached outcomes from old clients. */
export function reviewForOutput(outcome: ReviewOutcome) {
  const models = outcome.cost?.model.split(" + ") ?? []
  const only = outcome.cost?.kind === "codium"
  const codium =
    only ||
    models.some((model) => Billing.isCodium(model.split("/")[0])) ||
    outcome.passes?.some((pass) => codiumPass(pass, only))
  if (!codium) return outcome
  const own =
    outcome.passes?.some((pass) => !codiumPass(pass, only)) ||
    models.some((model) => model.includes("/") && !Billing.isCodium(model.split("/")[0]))
  return {
    ...outcome,
    ...(outcome.cost
      ? {
          // A legacy mixed aggregate cannot partition token categories. Its own dollars remain valid and each own
          // pass below retains its known tokens; do not invent a split for the aggregate.
          cost: own
            ? {
                kind: outcome.cost.kind,
                model: outcome.cost.model,
                costUsd: outcome.cost.costUsd,
                billing: "codium",
                ...(outcome.cost.usageMissing ? { usageMissing: true } : {}),
                ...(outcome.cost.partial ? { partial: true } : {}),
              }
            : { kind: "codium", model: outcome.cost.model },
        }
      : {}),
    ...(outcome.passes
      ? {
          passes: outcome.passes.map((pass) =>
            codiumPass(pass, only) ? { name: pass.name, model: pass.model, costKind: "codium" } : pass,
          ),
        }
      : {}),
  }
}
