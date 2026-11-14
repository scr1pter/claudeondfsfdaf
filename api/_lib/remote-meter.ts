import { registerStatusMeter } from "./model-plan-status.js"
import { relayConfigured, relayDevices } from "./remote-relay.js"

/*
 * The Remote status meter (WP A42; contract §4.11 `meters.remote {computers, limit}`): how many computers the account
 * has paired at the relay, against the plan's limit, for "N of limit computers paired" in Settings → Remote and on the
 * phone's Devices page. It is read only while `remote` is listed (the meter registry's rule) and only from routes that
 * import this module, so registering it never sits beside the provisioner, whose import would form a cycle through
 * model-plan-account.ts (A40's note). A relay that cannot be asked in time leaves the meter out; the pages then show
 * the plan's limit alone.
 */

export async function readRemoteMeter(
  snapshot: { account: string; caps: { remote: { computers: number } } },
  fetcher: typeof fetch,
  signal?: AbortSignal,
) {
  if (!relayConfigured()) return undefined
  const limited: typeof fetch = signal
    ? (input, init) => fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })
    : fetcher
  const relay = await relayDevices(snapshot.account, limited)
  const computers = relay.devices.filter((device) => device.role === "computer").length
  return { computers, limit: snapshot.caps.remote.computers }
}

registerStatusMeter("remote", "remote", (snapshot, fetcher, signal) => readRemoteMeter(snapshot, fetcher, signal))
