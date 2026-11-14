import { registerStatusMeter } from "./model-plan-status.js"
import { hoursUsedShare } from "./hosted-entitlement.js"

/*
 * The cloud computer status meter (WP A51; contract §4.11 `meters.hosted {used}`): the share of this period's cloud
 * computer hours used, a whole percent, for Settings, the account page and the phone. Shown only while `computer` is
 * listed (the meter registry's rule), and read only from routes that import this module, so registering it never sits
 * beside the hosted provisioner (an import cycle through model-plan-account.ts, as A40 found for Remote). A plan without
 * a cloud computer, or a store that cannot answer in time, leaves the meter out.
 */

registerStatusMeter("computer", "hosted", async (snapshot, fetcher) => {
  if (!snapshot.caps.hosted) return undefined
  return { used: await hoursUsedShare(snapshot, fetcher) }
})
