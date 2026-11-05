import { PERK_IDS, type PerkId } from "../../packages/schema/src/codium-entitlements.js"
import { CodiumCopy } from "../../packages/schema/src/codium-copy.js"
import { foundingWindowOpen } from "./codium-founding.js"
import { githubAppConfiguration } from "./github-app.js"
import { modelPlansEnabled } from "./model-plan-config.js"
import { reviewPanelServed, secondOpinionServed } from "./model-plan-models.js"
import { readDisabledSet, readSwitch, type SwitchName } from "./codium-switches.js"
import { playbooksReady } from "./playbooks.js"
import { remoteConfigured } from "./remote-config.js"
import { roadmapConfigured } from "./roadmap.js"
import { reportEmailConfigured } from "./support-reports.js"
import { phoneAppOrigin, pushConfigured } from "./web-push.js"

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
  // WP A33: reports are read first only where they reach the owner, so the report email must be configured.
  "reports-first": () => reportEmailConfigured(),
  // WP A34: the roadmap vote keeps its ballots in the store, its only service.
  vote: () => roadmapConfigured(),
  // WP A35: Second opinion runs in Vector's engine on the plan's judges, so it is ready once every plan that includes
  // it has a judge it can use among the models the gateway serves now.
  "second-opinion": (fetcher) => secondOpinionServed(fetcher),
  // WP A35: the panel runs in Vector's review on the plan's review pair and panel judge, so it is ready once every
  // plan's three are served and come from three labs.
  "review-panel": (fetcher) => reviewPanelServed(fetcher),
  // WP A38: phone alerts reach a phone through the phone app at VECTOR_PHONE_APP_ORIGIN, which subscribes with the
  // server's VAPID key (A37). Both must be configured; the `push` switch is checked with the other switches below.
  alerts: () => pushConfigured() && phoneAppOrigin() !== undefined,
  // WP A42: Remote needs both halves and the relay between them: tickets can be minted (VECTOR_REMOTE_ENABLED, the
  // relay's address and internal secret, the signing key) and phones have their app's origin to sign in from. The
  // `remote` switch is checked with the other switches below. Listing it stays the owner's call after the outside
  // security review (contract §1.2).
  remote: () => remoteConfigured() && phoneAppOrigin() !== undefined,
  // WP A36: Playbooks are downloaded from the media bucket by the Track B client, so they are ready once Track B is
  // live, the bucket can be signed and at least two playbooks are published. Which two are proven stays the owner's
  // call (contract §1.2).
  playbooks: (fetcher) => playbooksReady(fetcher),
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
