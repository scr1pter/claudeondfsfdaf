export * as ComputerCommunity from "./community"

/**
 * The company computer policy fields the community computer-control MCP guard reads, structurally, so the engine's
 * effective `ConfigComputerV1.Info` and the SDK's `ComputerConfig` that the plugin catalog receives both fit.
 */
export type Policy =
  | {
      readonly enabled?: boolean
      readonly default_app_access?: "ask" | "deny"
      readonly apps?: {
        readonly macos?: Readonly<Record<string, unknown>>
        readonly windows?: readonly unknown[]
      }
    }
  | undefined

/**
 * Whether company policy restricts computer use enough that the community desktop-control MCP must not run (INV-S12):
 * Hands is off, unlisted apps are denied, or any app rule exists, allow rules included and whatever the host OS.
 * The engine refuses to start the server under exactly this rule (E11) and the plugin catalog hides its entry (D11).
 * Absent policy, empty rule lists and unrelated settings (Always allow, background, retention, limits) do not count.
 */
export function restricted(policy: Policy) {
  return (
    policy?.enabled === false ||
    policy?.default_app_access === "deny" ||
    Object.keys(policy?.apps?.macos ?? {}).length > 0 ||
    (policy?.apps?.windows?.length ?? 0) > 0
  )
}
