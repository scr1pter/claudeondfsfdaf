import { PERK_COPY } from "../../../../packages/schema/src/codium-copy.js"
import { ACCOUNT_ID_PATTERN } from "../../../../packages/schema/src/everywhere.js"
import { renewalGraceMinutes } from "../../codium-limits.js"
import { readSnapshot, requireUsableSnapshot } from "../../codium-snapshot.js"
import { remoteConfigured } from "../../remote-config.js"
import { relayCall, relayPresence } from "../../remote-relay.js"
import { LAPTOP_ROUTE_WIRED, everywhereReady, sponsorListed, type EverywhereConfig } from "../config.js"
import type { Ports } from "../ports.js"
import { codiumSwitches, readRemoteSwitch } from "../switch.js"

/*
 * VE-20 (contract 3.4 steps 3 and 5, 6.1): the laptop route's ports over Codium Remote. Presence is offline unless
 * Codium's `remote` switch is on, Remote is configured, the sponsor's plan includes Remote and the relay answers
 * (E10); an offer is one signed relay call, passed on unchanged (E9 is checked on the computer); the plan is read,
 * never reconciled or written. Every failure is offline, unavailable or not in the plan. Nothing here logs.
 */

export type RemotePortsDeps = {
  readonly config: EverywhereConfig
  readonly fetcher?: typeof fetch
  readonly now?: () => number
  /** The laptop route's wiring (config.ts); tests pass true to open the plan's half of the `everywhere` perk. */
  readonly wired?: boolean
}

export function createRemotePorts(deps: RemotePortsDeps): Pick<Ports, "presence" | "offer" | "perk"> {
  // Resolved on each call, not when the ports are built: runtime.ts builds production's ports when it loads.
  const fetcher = () => deps.fetcher ?? fetch
  const now = deps.now ?? Date.now
  const wired = deps.wired ?? LAPTOP_ROUTE_WIRED
  const offline = (reason: "remote-off" | "not-configured" | "not-in-plan" | "unreachable") =>
    ({ online: false, computers: 0, reason }) as const

  /** The plan's caps when they include Remote now, or undefined for anything else, a failed read included. */
  async function remoteCaps(account: string) {
    if (!ACCOUNT_ID_PATTERN.test(account)) return undefined
    return readSnapshot(account, fetcher())
      .then((stored) => {
        const snapshot = requireUsableSnapshot(stored, now())
        // requireEntitlement would reconcile an active plan whose period is over; a read-only check cannot, so one
        // whose period ended more than the renewal grace ago is refused as a `renewing` one past its grace is.
        if (snapshot.state === "active" && now() >= snapshot.periodEnd + renewalGraceMinutes() * 60_000)
          return undefined
        // Codium's `includes(caps, "remote")` (codium-entitlements.ts), without importing that module and the Stripe
        // reconcile behind it into every intake route. Caps are only shape-checked on read, hence the optional chain.
        return snapshot.caps.remote?.computers > 0 ? snapshot.caps : undefined
      })
      .catch(() => undefined)
  }

  return {
    presence: async (account) => {
      if ((await readRemoteSwitch(codiumSwitches(fetcher()))) !== "on") return offline("remote-off")
      if (!remoteConfigured()) return offline("not-configured")
      if (!(await remoteCaps(account))) return offline("not-in-plan")
      // Any relay error, refusal, malformed answer or the 10-second internal timeout. The relay's own `killed` and
      // `suspended` reasons are dropped by relayPresence and read as an ordinary offline answer.
      const relay = await relayPresence(account, fetcher(), now()).catch(() => undefined)
      if (!relay) return offline("unreachable")
      return { online: relay.online, computers: relay.computers.length }
    },
    offer: async (account, offer) => {
      if (!remoteConfigured()) return "unavailable"
      // Exactly one call: a 429 or a lost answer is never retried here, because the offer may already be out.
      const answer = await relayCall("job-offer", { account, offer }, fetcher(), now()).catch(() => undefined)
      const delivered = answer?.delivered
      return typeof delivered === "number" && Number.isSafeInteger(delivered) && delivered >= 1 ? "sent" : "unavailable"
    },
    perk: async (account, perk) => {
      // A non-UUID account is never looked up, not even the listing's switches.
      if (!ACCOUNT_ID_PATTERN.test(account)) return false
      if (perk === "everywhere" && sponsorListed(deps.config, account)) return true
      if (perk === "everywhere" && !(await planListsEverywhere(deps.config, wired, fetcher()))) return false
      const caps = await remoteCaps(account)
      if (!caps) return false
      return perk === "remote" || PERK_COPY.everywhere.applies(caps)
    },
  }
}

/**
 * Whether a paid plan grants the `everywhere` perk beside the VECTOR_EVERYWHERE_ALLOW_ACCOUNTS allowlist: only once the
 * laptop route is wired and Codium's own listing (listedPerks in codium-perks.ts) lists the perk, so a paying account
 * is never admitted while vectordev.ai hides it. The listing's whole rule applies: MODEL_PLANS_ENABLED and `everywhere`
 * in CODIUM_LISTED_PERKS, the `codium` and `everywhere` switches `on`, `everywhere` not in `perks-off`, its readiness
 * (everywhereReady: the offer key, CRON_SECRET, and Slack, Linear or Jira open) and Remote listed beside it
 * (CodiumCopy.requires). Only the readiness is read from this configuration and wiring instead of the listing's own
 * reads, which are the same in production. The first three checks need no I/O, so the listing module (and the Stripe
 * modules behind it) loads, and the store is read, only once they hold; a failed read is false. Until then the
 * allowlist is the only grant, so the owner can still run with the allowlist alone.
 */
async function planListsEverywhere(config: EverywhereConfig, wired: boolean, fetcher: typeof fetch) {
  if (!wired || process.env.MODEL_PLANS_ENABLED !== "true") return false
  const listed = (process.env.CODIUM_LISTED_PERKS ?? "")
    .split(",")
    .map((value) => value.trim())
    .includes("everywhere")
  if (!listed) return false
  const { listedPerks, perkServices } = await import("../../codium-perks.js")
  return listedPerks(fetcher, { services: { ...perkServices, everywhere: () => everywhereReady(config, wired) } })
    .then((perks) => perks.has("everywhere"))
    .catch(() => false)
}
