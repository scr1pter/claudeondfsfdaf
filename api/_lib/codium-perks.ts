import { PERK_IDS, type PerkId } from "../../packages/schema/src/codium-entitlements.js"
import { CodiumCopy } from "../../packages/schema/src/codium-copy.js"
import { foundingWindowOpen } from "./codium-founding.js"
import { githubAppConfiguration } from "./github-app.js"
import { modelPlansEnabled } from "./model-plan-config.js"
import { readDisabledSet, readSwitch, type SwitchName } from "./codium-switches.js"

export type PerkServices = Readonly<Partial<Record<PerkId, (fetcher: typeof fetch) => boolean | Promise<boolean>>>>
export type ListedPerksOptions = { services?: PerkServices; runtime?: boolean }

/**
 * Implemented service checks, not deployment intent. Later work packages add their actual configured checks here;
 * a listing variable cannot turn an unfinished service into a purchase promise. GitHub's integration/live gate is
 * A59/A60, and Track B's release gate remains independent of service configuration.
 */
export const perkServices: PerkServices = {
  priority: () => {
    const limit = Number(process.env.MODEL_PLAN_GLOBAL_INFLIGHT)
    const reserve = Number(process.env.MODEL_PLAN_PRIORITY_RESERVE?.trim() || "0.2")
    return (
      Number.isSafeInteger(limit) &&
      limit > 0 &&
      limit <= 100_000 &&
      Number.isFinite(reserve) &&
      reserve > 0 &&
      reserve < 1
    )
  },
  // WP A31: founding is listed only while its window is open (the limit and the days after sales opened), read at
  // runtime; a prerender never sees it, and a closed window takes it off every page on the next config read.
  founding: (fetcher) => foundingWindowOpen(fetcher),
}

const switches: Readonly<Partial<Record<PerkId, SwitchName>>> = {
  "github-agents": "cloudAgents",
  "github-no-secret": "cloudAgents",
  scheduled: "cloudAgents",
  reviews: "cloudAgents",
  remote: "remote",
  alerts: "push",
  vault: "vault",
  computer: "hosted",
  overnight: "hosted",
  "on-call": "ops",
  "release-guard": "ops",
  "ship-desk": "ops",
  "brain-cloud": "cloudAgents",
}
const trackB: readonly PerkId[] = ["brain", "auto-learns", "brain-cloud", "playbooks"]
const app: readonly PerkId[] = ["github-no-secret", "on-call", "release-guard", "ship-desk"]

/** Public display permission only. Runtime entitlement/admission checks never rely on this set. */
export async function listedPerks(
  fetcher: typeof fetch = fetch,
  options: ListedPerksOptions = {},
): Promise<Set<PerkId>> {
  if (options.runtime === false || !modelPlansEnabled()) return new Set()
  const configured = new Set((process.env.CODIUM_LISTED_PERKS ?? "").split(",").map((value) => value.trim()))
  const candidates = PERK_IDS.filter((perk) => configured.has(perk))
  if (!candidates.length) return new Set()
  try {
    const names = [
      ...new Set<SwitchName>(["codium", ...candidates.flatMap((perk) => (switches[perk] ? [switches[perk]!] : []))]),
    ]
    const [disabled, states, ready] = await Promise.all([
      readDisabledSet("perks-off", fetcher),
      Promise.all(names.map(async (name) => [name, await readSwitch(name, fetcher)] as const)),
      Promise.all(
        candidates.map(
          async (perk) => [perk, (await (options.services ?? perkServices)[perk]?.(fetcher)) === true] as const,
        ),
      ),
    ])
    const state = new Map(states)
    if (state.get("codium") !== "on") return new Set()
    const services = new Map(ready)
    const listed = new Set(
      candidates.filter(
        (perk) =>
          !disabled.has(perk) &&
          services.get(perk) === true &&
          (!switches[perk] || state.get(switches[perk]!) === "on") &&
          (!trackB.includes(perk) || process.env.CODIUM_TRACK_B_LIVE === "true") &&
          (!app.includes(perk) || githubAppConfiguration() !== undefined),
      ),
    )
    // A parent disappearing also hides its descendants. The copy module owns this same dependency graph.
    for (let changed = true; changed; ) {
      changed = false
      for (const perk of listed) {
        if (!(CodiumCopy.requires[perk] ?? []).every((required) => listed.has(required))) {
          listed.delete(perk)
          changed = true
        }
      }
    }
    return listed
  } catch {
    // An unavailable/corrupt store or configured service cannot advertise stale capabilities.
    return new Set()
  }
}
