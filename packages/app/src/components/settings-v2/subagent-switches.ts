import type { Config } from "@vectordevai/sdk/v2/client"
import { createSignal } from "solid-js"
import { GENERAL_SUBAGENT_ID, SUBAGENT_IDENTITIES } from "@vectordevai/session-ui/subagent-identity"

// Settings → Agents has a switch for General subagents and one for each
// Subagent specialist that ships with Vector. Each maps to the engine's
// `agent.<id>.disable` in the global config. The engine removes a disabled
// agent from its agent list (packages/engine/src/agent/agent.ts), so the task
// tool can no longer launch it and the @ list no longer offers it. Vector's own
// helpers that run as a specialist, such as a Vectorscope review, keep a copy
// of it (Agent.helper). A switch is on unless the global config says exactly
// `disable: true`.
export const agentEnabled = (config: Config, id: string) => config.agent?.[id]?.disable !== true

// The specialists the page lists, and the only agents the all-specialists
// switch changes: never build or plan, never general, never Vector's hidden
// engine agents and never an agent the user defined. The engine's own list is
// NATIVE_SPECIALISTS (@vectordevai/core/agent/specialists), and the tests check
// the two agree.
export const SPECIALIST_IDS = Object.keys(SUBAGENT_IDENTITIES).filter((id) => id !== GENERAL_SUBAGENT_ID)

// The global config update deep-merges this patch, so other agent entries,
// user-defined ones included, are kept. Turning a switch back on writes
// `false` rather than removing the key, because JSON cannot carry `undefined`
// and the engine treats `false` the same as no key.
export const agentSwitchPatch = (picks: Record<string, boolean>): Config => ({
  agent: Object.fromEntries(Object.entries(picks).map(([id, enabled]) => [id, { disable: !enabled }])),
})

// Every config save makes the engine reload, so switches flipped in quick
// succession are saved together. A pick waits `delay` for the next one, then
// the picks go out as one update; picks made while it is in flight go out in
// one more update once it settles. A pick that matches the saved value is
// dropped, so flipping a switch off and back on saves nothing. A switch shows
// its latest pick until the save carrying it settles, so it never flicks back
// mid-save. `save` must resolve only once `saved` reads the new values (server
// sync writes the update's result into the config cache before it resolves).
// A failed save drops the picks it carried, so their switches return to the
// saved value, and `onError` names them.
export function createAgentSwitchSaver(input: {
  saved: (id: string) => boolean
  save: (patch: Config) => Promise<unknown>
  onError: (error: unknown, ids: string[]) => void
  delay?: number
}) {
  const [picks, setPicks] = createSignal<Record<string, boolean>>({})
  const [sending, setSending] = createSignal<Record<string, boolean>>({})
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = async (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    // The save in flight sends these picks when it settles.
    if (Object.keys(sending()).length > 0) return
    const batch = Object.fromEntries(Object.entries(picks()).filter((entry) => entry[1] !== input.saved(entry[0])))
    setPicks({})
    if (Object.keys(batch).length === 0) return
    setSending(batch)
    await input.save(agentSwitchPatch(batch)).catch((error: unknown) => input.onError(error, Object.keys(batch)))
    setSending({})
    if (Object.keys(picks()).length > 0) return flush()
  }

  return {
    enabled: (id: string) => picks()[id] ?? sending()[id] ?? input.saved(id),
    // What the engine has, or will have once the save in flight lands. A pick that matches it saves nothing.
    committed: (id: string) => sending()[id] ?? input.saved(id),
    pick(next: Record<string, boolean>) {
      setPicks((current) => ({ ...current, ...next }))
      clearTimeout(timer)
      timer = setTimeout(() => void flush(), input.delay ?? 500)
    },
    // Saves the waiting picks now, so closing Settings right after a flip keeps it.
    flush,
  }
}

// Saving a switch makes the engine reload its state, which stops every
// session working at that moment, in every repository, subagents included.
// The page asks before it does that, and these say how much would stop.
// Vector's helpers (a Vectorscope review, autocomplete) stop too, but they are
// in no list the user can open, so they are named instead of counted as
// sessions. `helperOf` gives the helper's name for a helper session.
export const runningWork = (
  status: Record<string, { type: string } | undefined>,
  helperOf: (sessionID: string) => string | undefined,
) => {
  const busy = Object.entries(status).flatMap(([sessionID, item]) =>
    item !== undefined && item.type !== "idle" ? [sessionID] : [],
  )
  const helpers = busy.flatMap((sessionID) => helperOf(sessionID) ?? [])
  return { sessions: busy.length - helpers.length, helpers: [...new Set(helpers)] }
}

/**
 * What a save would stop. `commands` counts running background commands: they run in conversations that are idle, so
 * the session statuses miss them, and the reload stops them as it stops a turn (5.H).
 */
export type RunningWork = { sessions: number; helpers: readonly string[]; commands?: number }

/** How many conversations a save asks for their background commands, the most recently updated first. */
export const COMMAND_ROOTS = 20

/**
 * The conversations whose background commands a save asks about: the root sessions this app has seen a status for,
 * since only the main agent of a conversation starts one, and it does so in a turn. Subagents and Vector's helpers
 * start none.
 */
export const commandRoots = <S extends { id: string; directory: string; parentID?: string; time: { updated: number } }>(
  status: Record<string, unknown>,
  get: (sessionID: string) => S | undefined,
  internal: (session: S) => boolean,
) =>
  Object.keys(status)
    .flatMap((sessionID) => {
      const session = get(sessionID)
      return session && !session.parentID && !internal(session) ? [session] : []
    })
    .sort((left, right) => right.time.updated - left.time.updated)
    .slice(0, COMMAND_ROOTS)

export const nothingRunning = (work: RunningWork) =>
  work.sessions === 0 && work.helpers.length === 0 && (work.commands ?? 0) === 0

export const stopWorkDescription = (work: RunningWork) => {
  const commands = work.commands ?? 0
  const sessions =
    work.sessions === 1
      ? "1 session is working right now."
      : `${work.sessions} sessions are working right now, subagents included.`
  const helpers = `${work.helpers.length === 1 ? "One of Vector's helpers is" : "Vector's helpers are"} working ${work.sessions > 0 ? "too" : "right now"} (${work.helpers.join(", ")}).`
  const running = commands === 1 ? "1 background command is running." : `${commands} background commands are running.`
  // A save reloads each folder once its turns and subagents end, and that reload stops its background commands
  // (global-lifecycle.ts): work in progress keeps the current setting, and nothing stops it.
  const working = work.sessions + work.helpers.length > 0
  const outcome = !working
    ? `Changing this setting stops ${commands === 1 ? "it" : "them"}, and the new setting applies from your next message.`
    : commands > 0
      ? "Changing this setting stops the background commands. Other work keeps the current setting until it ends; the new setting applies after that."
      : "That work keeps the current setting until it ends; the new setting applies after that."
  return [
    ...(work.sessions > 0 ? [sessions] : []),
    ...(work.helpers.length > 0 ? [helpers] : []),
    ...(commands > 0 ? [running] : []),
    outcome,
  ].join(" ")
}
