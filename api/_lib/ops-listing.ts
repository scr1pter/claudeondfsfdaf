import type { PerkId } from "../../packages/schema/src/codium-entitlements.js"
import { listedPerks } from "./codium-perks.js"
import { ApiError } from "./http.js"

/*
 * The listing gate of the ops perks on the server (review of P7): On Call, Release Guard and Ship Desk do new work only
 * while their perk is listed (`listedPerks`: CODIUM_LISTED_PERKS, the services, the `ops` switch, the App, phone
 * alerts), the way Brain Vault's writes need `vault` listed. `VECTOR_OPS_ENABLED=true` and the App's registration come
 * before listing and before the outside review of the revert path (contract §1.2, §8.2 step 16), so without this gate
 * any Max or Ultra subscriber could reach the routes directly once the Worker is set up.
 *
 * Before listing, the owner can try the perks with the accounts in `VECTOR_OPS_ALLOW_ACCOUNTS` (account ids, comma
 * separated), as `VECTOR_HOSTED_ALLOW_ACCOUNTS` does for the cloud computer. Those accounts still need a plan with the
 * perk, the ops services and the `ops` switch on; only the listing is skipped.
 *
 * Reading, removing and updates to what already exists (a card's new head, a resolved incident) never check this.
 */

export type OpsPerk = Extract<PerkId, "on-call" | "release-guard" | "ship-desk">

const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The accounts the owner lets use the ops perks before they are listed. */
export function opsAllowedAccounts(env: Record<string, string | undefined> = process.env) {
  return new Set(
    (env.VECTOR_OPS_ALLOW_ACCOUNTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => ACCOUNT.test(value)),
  )
}

/** Whether the account may start new work for any of `perks` now: one of them listed, or the owner's allowlist. */
export async function opsPerkOpen(account: string, perks: readonly OpsPerk[], fetcher: typeof fetch = fetch) {
  if (opsAllowedAccounts().has(account.toLowerCase())) return true
  const listed = await listedPerks(fetcher)
  return perks.some((perk) => listed.has(perk))
}

/** Refuses with 503 `OPS_UNAVAILABLE` unless `opsPerkOpen`. */
export async function requireOpsPerk(account: string, perks: readonly OpsPerk[], fetcher: typeof fetch = fetch) {
  if (!(await opsPerkOpen(account, perks, fetcher)))
    throw new ApiError(503, "OPS_UNAVAILABLE", "This production check is not available on Vector yet.", {
      detail: { perks: [...perks] },
    })
}
