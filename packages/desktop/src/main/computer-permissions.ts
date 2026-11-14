import { Option, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerError } from "./computer-bridge"

type Service = "screen" | "accessibility"
type Signing = "signed" | "adhoc" | "unknown"
export type PermissionProbe = {
  permissions: Computer.PermissionsStatus
  responsible: boolean
  captureBlocked?: boolean
  elevated?: boolean
}
const Probe = Schema.Struct({
  permissions: Computer.PermissionsStatus,
  responsible: Schema.Boolean,
  captureBlocked: Schema.optionalKey(Schema.Boolean),
  elevated: Schema.optionalKey(Schema.Boolean),
})
const PromptStamp = Schema.Struct({
  version: Schema.Literal(1),
  screen: Schema.optionalKey(Schema.Boolean),
  accessibility: Schema.optionalKey(Schema.Boolean),
})
// Main-only desktop persistence. Never a ComputerPrefs, merged-config, project or renderer-controlled key.
export const COMPUTER_PERMISSION_REQUESTS_KEY = "computerPermissionRequests"
const promptQueues = new WeakMap<object, Promise<unknown>>()
const PANES = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "windows-capture": "ms-settings:privacy",
} as const

/** D22 supplies the real helper, private store and read-only Electron queries after app readiness. */
export function createComputerPermissions(input: {
  platform: "darwin" | "win32"
  helperVersion: string
  helper: {
    probe(): Promise<PermissionProbe>
    request<T>(op: Computer.HelperOpName, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>
    refreshPermissions(): Promise<unknown>
  }
  settings: {
    get(): Computer.ResolvedComputerSettings
    setPrefs(patch: Partial<Computer.ComputerPrefs>): Promise<unknown>
  }
  promptStore: { get(key: string): unknown | Promise<unknown>; set(key: string, value: unknown): void | Promise<void> }
  signing(): Signing | Promise<Signing>
  vector: {
    getMediaAccessStatus(type: "screen"): string | Promise<string>
    isTrustedAccessibilityClient(prompt: false): boolean | Promise<boolean>
  }
  openExternal(url: string): void | Promise<void>
  elevated?(): boolean | Promise<boolean>
  resetVerified?: boolean
  now?(): number
}) {
  const verified =
    input.resetVerified ??
    (typeof VECTOR_COMPUTER_RESET_VERIFIED !== "undefined" && VECTOR_COMPUTER_RESET_VERIFIED === true)
  const state: {
    read: number
    screen?: Computer.PermissionState
    baseline?: Computer.PermissionState
    screenRevision: number
    dirty: boolean
    latest?: Computer.PermissionsView
  } = { read: 0, screenRevision: 0, dirty: false }

  function mutation<T>(callback: () => Promise<T>) {
    const previous = promptQueues.get(input.promptStore) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(callback)
    promptQueues.set(input.promptStore, pending)
    void pending.catch(() => {})
    return pending
  }
  function service(id: string): Service {
    if (id !== "screen" && id !== "accessibility")
      throw new ComputerError("failed", "That permission service is unavailable.")
    return id
  }
  async function stamps() {
    const value = await input.promptStore.get(COMPUTER_PERMISSION_REQUESTS_KEY)
    if (value === undefined) return { version: 1 as const, screen: false, accessibility: false }
    const decoded = Schema.decodeUnknownOption(PromptStamp)(value)
    // Unknown/corrupt prior state cannot prove a native prompt has never been requested.
    return Option.isSome(decoded)
      ? {
          version: 1 as const,
          screen: decoded.value.screen === true,
          accessibility: decoded.value.accessibility === true,
        }
      : { version: 1 as const, screen: true, accessibility: true }
  }

  async function list(): Promise<Computer.PermissionsView> {
    const read = ++state.read
    const results = await Promise.allSettled([
      Promise.resolve().then(() => input.helper.probe()),
      Promise.resolve().then(() => input.signing()),
      Promise.resolve().then(() =>
        input.platform === "darwin" ? input.vector.getMediaAccessStatus("screen") : "not-applicable",
      ),
      Promise.resolve().then(() =>
        input.platform === "darwin" ? input.vector.isTrustedAccessibilityClient(false) : false,
      ),
      Promise.resolve().then(() => (input.platform === "win32" && input.elevated ? input.elevated() : undefined)),
      Promise.resolve().then(() => (input.platform === "win32" ? inputSetup("status") : undefined)),
    ])
    const decoded = results[0].status === "fulfilled" ? Schema.decodeUnknownOption(Probe)(results[0].value) : undefined
    const probe = decoded && Option.isSome(decoded) ? decoded.value : undefined
    const kind = results[1].status === "fulfilled" ? results[1].value : "unknown"
    const signingKnown = kind === "signed" || kind === "adhoc"
    const captureFacts = [
      probe?.captureBlocked,
      probe?.permissions.captureBlocked,
      probe?.permissions.screen === "denied" || probe?.permissions.screen === "restricted"
        ? true
        : probe?.permissions.screen === "granted"
          ? false
          : undefined,
    ]
    const captureBlocked = captureFacts.includes(true) ? true : captureFacts.includes(false) ? false : undefined
    const elevationFacts = [results[4].status === "fulfilled" ? results[4].value : undefined, probe?.elevated]
    const elevated = elevationFacts.includes(true) ? true : elevationFacts.includes(false) ? false : undefined
    const setup = results[5].status === "fulfilled" ? results[5].value : undefined
    const healthy =
      !!probe &&
      probe.responsible &&
      signingKnown &&
      (input.platform !== "win32" ||
        (typeof captureBlocked === "boolean" && typeof elevated === "boolean" && results[4].status === "fulfilled"))
    if (healthy && probe && read === state.read) {
      if (input.platform === "darwin") {
        if (state.baseline === undefined) state.baseline = probe.permissions.screen
        if (state.screen !== probe.permissions.screen) state.screenRevision++
        state.screen = probe.permissions.screen
        if (state.screen !== state.baseline) state.dirty = true
      }
      if (
        probe.permissions.screen === "granted" &&
        probe.permissions.accessibility === "granted" &&
        (input.platform !== "darwin" ||
          probe.permissions.postEvent === undefined ||
          probe.permissions.postEvent === "granted")
      ) {
        const recorded = input.settings.get().prefs.granted
        const at = (input.now ?? Date.now)()
        if ((!recorded || recorded.helperVersion !== input.helperVersion) && Number.isSafeInteger(at) && at > 0)
          await input.settings.setPrefs({ granted: { helperVersion: input.helperVersion, at } })
      }
    }
    const previous = input.settings.get().prefs.granted
    const status = (id: Service): Computer.PermissionsView["rows"][number]["status"] => {
      if (!healthy || !probe) return "unknown"
      const value =
        id === "accessibility" &&
        input.platform === "darwin" &&
        probe.permissions.accessibility === "granted" &&
        probe.permissions.postEvent !== undefined &&
        probe.permissions.postEvent !== "granted"
          ? probe.permissions.postEvent
          : probe.permissions[id]
      if (value === "granted") return "granted"
      if (value === "denied") return previous?.helperVersion ? "reset-after-update" : "denied"
      return value === "restricted" ? "denied" : "unknown"
    }
    const view: Computer.PermissionsView = {
      rows:
        input.platform === "darwin"
          ? (["screen", "accessibility"] as const).map((id) => ({ id, status: status(id), pane: PANES[id] }))
          : [],
      canReset: input.platform === "darwin" && verified && healthy,
      adhoc: input.platform === "darwin" && kind === "adhoc",
      helperStart: healthy ? "ok" : "failed",
      vectorHoldsGrant: {
        screen: results[2].status === "fulfilled" && results[2].value === "granted",
        accessibility: results[3].status === "fulfilled" && results[3].value === true,
      },
      ...(input.platform === "win32"
        ? {
            windows: {
              captureBlocked: captureBlocked === true,
              elevated: elevated === true,
              inputSetup: healthy && setup ? setup : { state: "unavailable", mouse: false, keyboard: false },
            },
          }
        : {}),
    }
    if (read === state.read) state.latest = structuredClone(view)
    return read === state.read || !state.latest ? view : structuredClone(state.latest)
  }

  async function refreshScreen(view: Computer.PermissionsView, force = false): Promise<Computer.PermissionsView> {
    const latest = state.latest ? structuredClone(state.latest) : view
    if (input.platform !== "darwin" || (!force && latest.helperStart !== "ok") || !state.dirty) return latest
    const screen = state.screen
    const revision = state.screenRevision
    try {
      await input.helper.refreshPermissions()
      state.baseline = screen
      state.dirty = state.screenRevision !== revision || state.screen !== screen
      return state.latest ? structuredClone(state.latest) : latest
    } catch {
      const current = state.latest ? structuredClone(state.latest) : latest
      const failed: Computer.PermissionsView = {
        ...current,
        helperStart: "failed",
        canReset: false,
        rows: current.rows.map((row) => ({ ...row, status: "unknown" })),
      }
      state.latest = structuredClone(failed)
      return failed
    }
  }

  return {
    list,
    inputSetup,
    openPane(id: "screen" | "accessibility" | "windows-capture") {
      if (input.platform === "win32") {
        if (id !== "windows-capture")
          throw new ComputerError("failed", "That permission pane is unavailable on Windows.")
        return Promise.resolve().then(() => input.openExternal(PANES["windows-capture"]))
      }
      const selected = service(id)
      return mutation(async () => {
        const saved = await stamps()
        if (!saved[selected]) {
          const view = await list()
          if (view.helperStart !== "ok")
            throw new ComputerError("unavailable", "The helper cannot safely request its own permissions.")
          await input.promptStore.set(COMPUTER_PERMISSION_REQUESTS_KEY, { ...saved, [selected]: true })
          await input.helper.request("permissions.request", { service: selected })
        }
        await input.openExternal(PANES[selected])
      })
    },
    async recheck(): Promise<Computer.PermissionsView> {
      const view = await list()
      return mutation(() => refreshScreen(view))
    },
    reset(id: "screen" | "accessibility"): Promise<Computer.PermissionsView> {
      const selected = service(id)
      if (input.platform !== "darwin" || !verified)
        throw new ComputerError("unsupported_action", "Permission reset has not been verified for this build.")
      return mutation(async () => {
        const view = await list()
        if (!view.canReset)
          throw new ComputerError("unavailable", "The helper cannot safely reset its own permissions.")
        if (selected === "screen") state.dirty = true
        await input.helper.request("permissions.reset", { service: selected })
        // A successful OS reset must retire the helper's cached grants even if bookkeeping fails.
        const [saved] = await Promise.allSettled([
          stamps().then((value) =>
            input.promptStore.set(COMPUTER_PERMISSION_REQUESTS_KEY, { ...value, [selected]: false }),
          ),
        ])
        const refreshed = await list()
        const result = selected === "screen" ? await refreshScreen(refreshed, true) : refreshed
        if (saved.status === "rejected") throw saved.reason
        return result
      })
    },
  }

  async function inputSetup(action: Computer.InputSetupAction): Promise<Computer.InputSetupStatus> {
    if (input.platform !== "win32")
      throw new ComputerError("unsupported_action", "Input calibration is only available on Windows.")
    if (!input.settings.get().prefs.consentedAt)
      throw new ComputerError("unavailable", "Consent is required before starting input calibration.")
    if (!input.settings.get().policy.enabled)
      throw new ComputerError("unavailable", "Input calibration is disabled by your company.")
    const value = await input.helper.request<unknown>("input.setup", { action }, 5000)
    const decoded = Schema.decodeUnknownOption(Computer.InputSetupStatus, { onExcessProperty: "error" })(value)
    if (Option.isNone(decoded)) throw new ComputerError("unavailable", "Input setup could not be verified.")
    return decoded.value
  }
}
