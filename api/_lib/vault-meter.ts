import { registerStatusMeter } from "./model-plan-status.js"
import { vaultQuotaBytes, vaultStoreConfigured, vaultUsage } from "./vault-store.js"

/*
 * The Brain Vault status meter (WP A44; contract §4.11 `meters.vault {usedBytes, quotaBytes}`): the bytes the vault
 * takes against the plan's quota, for Settings → Memory → Backup (A45) and `vector vault status`. Bytes, never an
 * amount (P1). Shown only while `vault` is listed (the meter registry's rule) and read only from routes that import
 * this module, so registering it never sits beside the provisioner (an import cycle through model-plan-account.ts, as
 * A40 found for Remote). A store that cannot answer in time leaves the meter out.
 */

export async function readVaultMeter(
  snapshot: { account: string; caps: { vault: { gb: number } } },
  fetcher: typeof fetch,
  signal?: AbortSignal,
) {
  if (!vaultStoreConfigured()) return undefined
  const limited = signal
    ? (((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })) as typeof fetch)
    : fetcher
  return { usedBytes: await vaultUsage(snapshot.account, { fetcher: limited }), quotaBytes: vaultQuotaBytes(snapshot.caps.vault.gb) }
}

registerStatusMeter("vault", "vault", (snapshot, fetcher, signal) => readVaultMeter(snapshot, fetcher, signal))
