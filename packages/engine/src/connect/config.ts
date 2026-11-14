export * as ConnectConfig from "./config"

import { ConfigConnectV1 } from "@vectordevai/core/v1/config/connect"

/** A checked-in configuration can turn features down and lower limits, never authorize more work. */
export function repositoryConnect(
  input: ConfigConnectV1.Info | undefined,
  base: ConfigConnectV1.Info | undefined,
): ConfigConnectV1.Info | undefined {
  if (!input?.review) return undefined
  const current = ConfigConnectV1.review(base)
  const next = input.review
  const after = ["off", "report", "repair"] as const
  const before = ["off", "offer", "run"] as const
  const narrowed = {
    ...(next.after_run !== undefined && after.indexOf(next.after_run) < after.indexOf(current.after_run)
      ? { after_run: next.after_run }
      : {}),
    ...(next.before_commit !== undefined && before.indexOf(next.before_commit) < before.indexOf(current.before_commit)
      ? { before_commit: next.before_commit }
      : {}),
    ...(next.max_rounds !== undefined && next.max_rounds < current.max_rounds ? { max_rounds: next.max_rounds } : {}),
    ...(next.max_cost_usd !== undefined && next.max_cost_usd < current.max_cost_usd
      ? { max_cost_usd: next.max_cost_usd }
      : {}),
  }
  return Object.keys(narrowed).length ? { review: narrowed } : undefined
}
