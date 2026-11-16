import { Computer } from "@vectordevai/schema/computer"
import { ComputerOnboarding } from "@/features/computer/onboarding-model"
import { ComputerSendGate } from "@/features/computer/send-gate"
import type { dict } from "@/i18n/en"
import { ComputerSettings } from "./computer-model"

type Status = Awaited<ReturnType<Computer.ComputerPlatform["status"]>>
type CopyKey = keyof typeof dict

export type SettingsState = {
  /** The first read, including its permission probe, has not finished. */
  loading: boolean
  /** No preferences, status and state could be read yet. */
  failed: boolean
  checking: boolean
  saving: boolean
  deleting: boolean
  settings?: Computer.ResolvedComputerSettings
  status?: Status
  phase?: Computer.ComputerPhase
  backend?: Computer.ComputerState["backend"]
  permissions?: Computer.PermissionsView
  /** How many screenshots the last Delete all removed. */
  deleted?: number
  error?: CopyKey
}

export type AppResult = { key: string; name: string; running: boolean }

/** At most this many apps answer a Block an app… search. */
export const SEARCH_LIMIT = 8

/**
 * Owns the Hands Settings page's asynchronous boundary, like onboarding's controller: one serialized queue for probes
 * and changes, and nothing published after dispose. Permissions are read once on start and again on window focus and
 * Check again, never on a timer: each recheck starts a fresh helper probe on the desktop (D21). A probe that does not
 * answer within the send gate's limit reads as a failed check, so it cannot hold the page or the changes behind it.
 */
export function createComputerSettings(
  computer: Computer.ComputerPlatform,
  options: { focus?: Pick<EventTarget, "addEventListener" | "removeEventListener"> } = {},
) {
  let state: SettingsState = { loading: true, failed: false, checking: false, saving: false, deleting: false }
  const listeners = new Set<(state: SettingsState) => void>()
  let disposed = false
  let started = false
  let tail = Promise.resolve()
  let checking: Promise<boolean> | undefined
  let deleting: Promise<boolean> | undefined
  let saving = 0
  // Live state events seen so far. A state() snapshot requested before the latest event is older than that event.
  let events = 0
  let search = 0
  let unsubscribe = () => {}
  const focus = options.focus ?? globalThis.window

  const publish = (patch: Partial<SettingsState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }
  const enqueue = (work: () => Promise<boolean>) => {
    const task = tail.then(() => (disposed ? false : work()))
    tail = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }
  const platform = () => ComputerSettings.platformOf(state.backend)

  const settings = async () => {
    const seen = events
    const [settings, status, snapshot] = await Promise.all([computer.prefs(), computer.status(), computer.state()])
    if (disposed) return false
    publish({ settings, status, ...(events === seen ? { phase: snapshot.phase, backend: snapshot.backend } : {}) })
    return true
  }
  const preferences = async () => {
    const settings = await computer.prefs()
    publish({ settings })
    return settings
  }
  // The first read uses permissions(), the desktop's current view, never recheck().
  const first = async () => {
    const [read, probe] = await Promise.allSettled([settings(), ComputerSendGate.bounded(computer.permissions())])
    if (disposed) return false
    if (read.status === "rejected") {
      publish({ failed: true })
      return false
    }
    publish(probe.status === "fulfilled" ? { permissions: probe.value } : { error: "computer.onboarding.checkFailed" })
    return true
  }
  const read = async () => {
    const permissions = await ComputerSendGate.bounded(computer.recheck()).catch(() => undefined)
    if (disposed) return false
    // Read policy after the probe finishes: a company change during a slow probe wins over the older snapshot.
    const fresh = await settings().catch(() => false)
    if (disposed) return false
    // A failed probe leaves no permission view: an old one would read as current.
    publish({
      permissions,
      ...(fresh ? { failed: false } : {}),
      error: !permissions || !fresh ? "computer.onboarding.checkFailed" : undefined,
    })
    return !!permissions && fresh
  }
  const check = () => {
    if (disposed || !started || !computer.supported) return Promise.resolve(false)
    if (checking) return checking
    publish({ checking: true })
    const task = enqueue(read).finally(() => {
      checking = undefined
      publish({ checking: false })
    })
    checking = task
    return task
  }
  const mutate = (work: (settings: Computer.ResolvedComputerSettings) => Promise<boolean>) => {
    if (disposed || !state.settings) return Promise.resolve(false)
    saving++
    publish({ saving: true, error: undefined })
    return enqueue(() => (state.settings ? work(state.settings) : Promise.resolve(false)))
      .catch(() => {
        publish({ error: "computer.settings.saveFailed" })
        return false
      })
      .finally(() => {
        saving--
        publish({ saving: saving > 0 })
      })
  }
  // Allow (or block again) DEFAULT_BLOCKED keys in one write, built from preferences read inside the queue, so a
  // grouped row never ends half allowed and an older list never overwrites a newer one.
  const defaults = (keys: readonly string[], allow: boolean) =>
    mutate(async () => {
      const fresh = await preferences()
      const unblocked = ComputerSettings.unblockedAfter(fresh, keys, allow)
      if (!ComputerSettings.writable({ unblocked }, fresh)) return false
      publish({ settings: await computer.setPrefs({ unblocked }) })
      return true
    })
  const onFocus = () => {
    void check()
  }

  return {
    get state() {
      return state
    },
    subscribe(listener: (state: SettingsState) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      if (started || disposed) return Promise.resolve(false)
      started = true
      if (!computer.supported) {
        publish({ loading: false })
        return Promise.resolve(false)
      }
      unsubscribe = computer.onState((snapshot) => {
        if (disposed) return
        events++
        publish({ phase: snapshot.phase, backend: snapshot.backend })
      })
      focus?.addEventListener("focus", onFocus)
      publish({ checking: true })
      // A focus during the first read joins it instead of queueing a probe right behind it.
      const task = enqueue(first).finally(() => {
        checking = undefined
        publish({ loading: false, checking: false })
      })
      checking = task
      return task
    },
    dispose() {
      disposed = true
      search++
      unsubscribe()
      focus?.removeEventListener("focus", onFocus)
      listeners.clear()
    },
    check,
    inputSetupChanged(setup: Computer.InputSetupStatus | undefined) {
      if (!state.permissions?.windows || disposed) return
      publish({ permissions: { ...state.permissions, windows: { ...state.permissions.windows, inputSetup: setup } } })
    },
    /** Writes Settings' own fields. Locked fields, consent, grants and turning Hands on are refused without a call. */
    setPrefs: (patch: Partial<Computer.ComputerPrefs>) =>
      mutate(async (current) => {
        if (!ComputerSettings.writable(patch, current)) return false
        publish({ settings: await computer.setPrefs(patch) })
        return true
      }),
    removeAlways: (key: string) =>
      mutate(async () => {
        await computer.removeAlways(key)
        await preferences()
        return true
      }),
    removeAllAlways: () =>
      mutate(async () => {
        await computer.removeAllAlways()
        await preferences()
        return true
      }),
    block: (app: { key: string; name: string }) =>
      mutate(async (current) => {
        if (ComputerSettings.locked("blocked", current) || !Computer.parseAppKey(app.key)) return false
        await computer.block({ key: app.key, name: Computer.clean(app.name, 256) || app.key })
        await preferences()
        return true
      }),
    unblock: (key: string) =>
      mutate(async (current) => {
        if (ComputerSettings.locked("blocked", current)) return false
        await computer.unblock(key)
        await preferences()
        return true
      }),
    allowDefault: (keys: readonly string[]) => defaults(keys, true),
    blockDefault: (keys: readonly string[]) => defaults(keys, false),
    /** One deletion at a time: a second press while one runs joins it, so its count is never replaced by zero. */
    deleteScreenshots() {
      if (deleting) return deleting
      if (disposed) return Promise.resolve(false)
      publish({ deleting: true, deleted: undefined, error: undefined })
      const task = enqueue(async () => {
        const result = await computer.deleteScreenshots()
        if (!Number.isSafeInteger(result?.removed) || result.removed < 0) throw new Error("Invalid deletion count")
        publish({ deleted: result.removed })
        return true
      })
        .catch(() => {
          publish({ error: "computer.settings.screenshots.deleteFailed" })
          return false
        })
        .finally(() => {
          deleting = undefined
          publish({ deleting: false })
        })
      deleting = task
      return task
    },
    openPane: (id: "screen" | "accessibility" | "windows-capture") =>
      mutate(async () => {
        if (platform() === "windows" ? id !== "windows-capture" : id === "windows-capture") return false
        await computer.openPane(id)
        return true
      }),
    reset: (id: "screen" | "accessibility") =>
      mutate(async (current) => {
        if (platform() !== "macos" || state.permissions?.canReset !== true) return false
        if (!ComputerOnboarding.rowsFor(state.permissions, current.prefs).some((row) => row.reset === id)) return false
        const permissions = await computer.reset(id)
        publish({ permissions })
        await preferences()
        return true
      }),
    /** Apps a person may block: never-listed and already blocked apps are left out. A newer search drops older answers. */
    async searchApps(query: string): Promise<AppResult[] | undefined> {
      const id = ++search
      const apps = await computer.apps(query).catch(() => [])
      if (disposed || id !== search) return
      return apps
        .filter((app) => app.rule !== "never" && app.rule !== "blocked" && !!Computer.parseAppKey(app.key))
        .slice(0, SEARCH_LIMIT)
        .map((app) => ({ key: app.key, name: Computer.clean(app.name, 256) || app.key, running: app.running === true }))
    },
    /** Drops the answer of any search still running, such as when the search box closes. */
    cancelSearch() {
      search++
    },
  }
}
