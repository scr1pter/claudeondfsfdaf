import type { SwitchState } from "../../../packages/schema/src/everywhere-policy.js"
import { SWITCH_NAMES, readSwitch, type SwitchName as CodiumSwitchName } from "../codium-switches.js"
import type { EverywhereConfig } from "./config.js"

/*
 * Kill switches (contract 3.2 step 3, E10). Three values: `on`; `no-new`, which finishes running jobs but takes no new
 * ones; and `stop`, which also stops running jobs (claims refused, every report and heartbeat answered `stop`, waiting
 * jobs expired, Actions dispatch refused).
 *
 * The `everywhere` switch is the environment first: anything but VECTOR_EVERYWHERE_ENABLED=true with a usable data key
 * reads `stop`. Codium's switch can only make it stricter. Codium has no `everywhere` switch until R-C6; the seam reads
 * it as soon as Codium's SWITCH_NAMES lists it, with no change here. Codium's `off` reads `stop`, and a switch that
 * cannot be read reads `stop`: the switches fail closed.
 *
 * Relay presence ignores Codium's `remote` switch, so the router reads it here too (E10).
 */

export type { SwitchState }
export type EverywhereSwitch = "everywhere" | "remote"

/** Codium's raw value of a switch, or undefined while Codium has no switch by that name. Throws when unreadable. */
export type CodiumSwitches = (name: EverywhereSwitch) => Promise<string | undefined>

/** The seam over Codium's `readSwitch` (api/_lib/codium-switches.ts), which this branch only calls. */
export function codiumSwitches(fetcher: typeof fetch = fetch): CodiumSwitches {
  return async (name) => {
    if (!(SWITCH_NAMES as readonly string[]).includes(name)) return undefined
    return readSwitch(name as CodiumSwitchName, fetcher)
  }
}

/** Codium's values as ours: `on` and `no-new` as they are; `off`, `stop` and anything unknown as `stop`. */
export function fromCodium(value: unknown): SwitchState {
  return value === "on" || value === "no-new" ? value : "stop"
}

const RANK: Readonly<Record<SwitchState, number>> = { on: 0, "no-new": 1, stop: 2 }

/** The strictest of several switch values. */
export function strictest(...states: readonly SwitchState[]): SwitchState {
  return states.reduce<SwitchState>((worst, state) => (RANK[state] > RANK[worst] ? state : worst), "on")
}

async function codiumValue(codium: CodiumSwitches, name: EverywhereSwitch): Promise<SwitchState | undefined> {
  try {
    const value = await codium(name)
    return value === undefined ? undefined : fromCodium(value)
  } catch {
    return "stop"
  }
}

/** The `everywhere` switch: the environment, made stricter by Codium's switch once it exists. */
export async function readEverywhereSwitch(
  config: EverywhereConfig,
  codium: CodiumSwitches = codiumSwitches(),
): Promise<SwitchState> {
  if (!config.enabled) return "stop"
  return strictest("on", (await codiumValue(codium, "everywhere")) ?? "on")
}

/** Codium's `remote` switch (`on` or `off`), read as `on` or `stop`. Unreadable or absent reads `stop`. */
export async function readRemoteSwitch(codium: CodiumSwitches = codiumSwitches()): Promise<SwitchState> {
  return (await codiumValue(codium, "remote")) ?? "stop"
}

/**
 * What a switch value lets through. `new` is work that would start a job: a new trigger at the intake. `running` is
 * work on a job already taken: a claim of an offered or waiting job, a report, a heartbeat, a settle, a dispatch of an
 * accepted job, an offer of a waiting job. `no-new` lets only running work through; `stop` lets nothing through.
 */
export function admits(state: SwitchState, work: "new" | "running"): boolean {
  if (state === "on") return true
  if (state === "no-new") return work === "running"
  return false
}
