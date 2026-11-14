import { CodiumCopy, type PerkId } from "@vectordevai/schema/codium-copy"
import { ENTITLEMENTS, PERK_IDS } from "@vectordevai/schema/codium-entitlements"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { readModelPlanConfig } from "./model-plans"

/**
 * The perks that run on computers Vector hosts. `/docs/codium#hosted` names one only while the server lists it, and
 * shows "None yet" while it lists none of them.
 */
export const HOSTED_PERKS = [
  "computer",
  "overnight",
  "on-call",
  "release-guard",
  "ship-desk",
] as const satisfies readonly PerkId[]

export type CodiumDocsView = ReturnType<typeof codiumDocs>

const isHosted = (id: PerkId) => HOSTED_PERKS.some((item) => item === id)

/**
 * What `/docs/codium` shows, from `CodiumCopy` and `ENTITLEMENTS` only: prices, the computed tagline, the usage line,
 * the public limits and the perks the server listed. No model list (the page links to /codium for it), no allowance
 * amount and no perk the listing left out. The prerender passes no listing; the page script passes the live one.
 */
export function codiumDocs(listed: readonly string[]) {
  const known = new Set(PERK_IDS.filter((id) => listed.includes(id)))
  const plans = CodiumPlan.PLANS.map((plan) => {
    const view = CodiumCopy.tierView(plan.id, known, [])
    return {
      id: plan.id,
      name: plan.name,
      price: plan.price,
      tagline: view.tagline,
      usage: view.usage,
      // Requests at once, requests a minute and the daily limit. The context line needs an offered model, and the
      // docs list none, so it is never here.
      limits: view.limits.slice(0, 3),
      // Every listed perk of the plan, as the pricing page's comparison table has them. Hosted ones are described
      // once, under #hosted, so the plan names them only.
      features: view.perks
        .filter((perk) => !isHosted(perk.id))
        .map((perk) => ({ id: perk.id, label: perk.label, text: perk.text })),
      hostedLabels: view.perks.filter((perk) => isHosted(perk.id)).map((perk) => perk.label),
      perks: view.perks,
      ramp: ENTITLEMENTS[plan.id].rank >= 3,
    }
  })
  const hosted = HOSTED_PERKS.flatMap((id) => {
    const offers = plans.flatMap((plan) => {
      const perk = plan.perks.find((item) => item.id === id)
      return perk ? [{ plan: plan.name, text: perk.text }] : []
    })
    return offers.length ? [{ id, label: CodiumCopy.PERK_COPY[id].label, offers }] : []
  })
  const coming = (Object.keys(CodiumCopy.COMING) as (keyof typeof CodiumCopy.COMING)[]).map((key) => ({
    id: key,
    ...CodiumCopy.COMING[key],
    plans: CodiumPlan.PLANS.filter((plan) => ENTITLEMENTS[plan.id][key] === "coming").map((plan) => plan.name),
  }))
  return {
    plans: plans.map(({ perks: _perks, ...plan }) => plan),
    hosted,
    coming,
    free: CodiumCopy.FREE_WORKSPACE,
    everyPlan: CodiumCopy.EVERY_PLAN,
  }
}

/**
 * The page's runtime listing. The server decides what is listed; a failed or malformed answer lists nothing, so a
 * perk switched off never stays on the page.
 */
export async function refreshCodiumDocs(
  fetcher: (input: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<CodiumDocsView> {
  return fetcher("/api/model-plans/config", { headers: { accept: "application/json" }, cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error("Plan configuration is unavailable")
      return codiumDocs(readModelPlanConfig(await response.json()).listed ?? [])
    })
    .catch(() => codiumDocs([]))
}
