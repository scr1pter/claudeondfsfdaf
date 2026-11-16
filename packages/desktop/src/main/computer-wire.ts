import type { Computer } from "@vectordevai/schema/computer"

type Rule = "allow" | "deny"

/**
 * Settings as they cross Electron IPC and the context bridge. The bridge copies plain objects by their own enumerable
 * properties, which would turn `policy.apps` (a Map) into an empty object, so the rules travel as entry pairs and the
 * renderer rebuilds the Map before the app reads it.
 */
export type ComputerSettingsWire = Omit<Computer.ResolvedComputerSettings, "policy"> & {
  policy: Omit<Computer.ComputerPolicy, "apps"> & { apps: [string, Rule][] }
}

export function settingsToWire(settings: Computer.ResolvedComputerSettings): ComputerSettingsWire {
  return {
    ...settings,
    policy: { ...settings.policy, apps: [...settings.policy.apps].map(([key, rule]) => [key, rule]) },
  }
}

/** Rebuilds the company rules as a Map. Anything that is not a list of string/allow|deny pairs yields no rules. */
export function settingsFromWire(settings: ComputerSettingsWire): Computer.ResolvedComputerSettings {
  const value: unknown = settings.policy.apps
  const apps = new Map<string, Rule>()
  const entries = value instanceof Map ? [...value] : Array.isArray(value) ? value : []
  for (const entry of entries)
    if (
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string" &&
      (entry[1] === "allow" || entry[1] === "deny")
    )
      apps.set(entry[0], entry[1])
  return { ...settings, policy: { ...settings.policy, apps } }
}
