const STORE_NAME = "background-mode"
const STORE_KEY = "preference"

// "auto" keeps Vector resident only while it has work to do, which is the
// behaviour the product promises without leaving an idle process behind.
export type BackgroundModePreference = "auto" | "always" | "never"

const PREFERENCES: BackgroundModePreference[] = ["auto", "always", "never"]

export type BackgroundWorkState = {
  armedTasks: number
  inFlightRuns: number
  everywhereWaiting?: boolean
  // Epoch milliseconds of the soonest armed task; absent when nothing is armed.
  nextRunAt?: number
}

export type BackgroundModeInput = BackgroundWorkState & {
  preference: BackgroundModePreference
  platform: NodeJS.Platform
  quitRequested: boolean
  now?: number
}

// Decides whether losing the last window should end the process, and returns
// the one-line status the tray shows for that decision. Deliberately free of
// Electron so the whole table is testable.
export function decideBackgroundMode(input: BackgroundModeInput) {
  if (input.quitRequested) return { keepAlive: false, reason: "Quitting Vector" }
  // "Never" governs whether Vector idles in the background, not whether it may
  // abandon an agent that is mid-run — killing a run in flight destroys work
  // the user cannot recover. Quit Vector completely remains the way out.
  if (input.inFlightRuns > 0)
    return { keepAlive: true, reason: `${plural(input.inFlightRuns, "background run")} in progress` }
  if (input.preference === "never") return { keepAlive: false, reason: "Background mode is off" }
  if (input.armedTasks > 0) {
    return {
      keepAlive: true,
      reason: `${plural(input.armedTasks, "scheduled task")} armed${nextRunSuffix(input.nextRunAt, input.now ?? Date.now())}`,
    }
  }
  if (input.everywhereWaiting) return { keepAlive: true, reason: "Waiting for Vector everywhere jobs" }
  if (input.preference === "always") return { keepAlive: true, reason: "Idle · staying resident" }
  // macOS apps conventionally outlive their last window and Vector always has,
  // so background mode must not turn that into a quit.
  if (input.platform === "darwin") return { keepAlive: true, reason: "Idle" }
  return { keepAlive: false, reason: "Nothing scheduled" }
}

// ./store reaches electron-store and app.getPath, so it stays behind a lazy
// import: a static one would link the real electron module into every bun test
// that merely touches this file and defeat the mocks other suites install.
export async function getBackgroundModePreference(): Promise<BackgroundModePreference> {
  const { getStore } = await import("./store")
  const stored = getStore(STORE_NAME).get(STORE_KEY)
  return PREFERENCES.find((preference) => preference === stored) ?? "auto"
}

export async function setBackgroundModePreference(preference: BackgroundModePreference) {
  const { getStore } = await import("./store")
  getStore(STORE_NAME).set(STORE_KEY, preference)
  return preference
}

let quitRequested = false

// Without this flag every keep-alive path would cancel the user's own "Quit
// Vector completely", because window-all-closed fires before the app is gone
// and would decide to stay resident all over again.
export function requestQuit() {
  quitRequested = true
}

export function isQuitRequested() {
  return quitRequested
}

export function clearQuitRequest() {
  quitRequested = false
}

// Reads the persisted preference and the quit intent for callers that only know
// the live work counts.
export async function backgroundModeStatus(state: BackgroundWorkState) {
  return decideBackgroundMode({
    ...state,
    preference: await getBackgroundModePreference(),
    platform: process.platform,
    quitRequested,
  })
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function nextRunSuffix(nextRunAt: number | undefined, now: number) {
  if (nextRunAt === undefined || !Number.isFinite(nextRunAt)) return ""
  const remaining = nextRunAt - now
  if (remaining <= 0) return " · next run is due"
  if (remaining < 60_000) return ` · next in ${Math.max(1, Math.floor(remaining / 1_000))}s`
  const minutes = Math.round(remaining / 60_000)
  if (minutes < 60) return ` · next in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return ` · next in ${hours}h${minutes % 60 === 0 ? "" : ` ${minutes % 60}m`}`
  return ` · next in ${Math.round(hours / 24)}d`
}
