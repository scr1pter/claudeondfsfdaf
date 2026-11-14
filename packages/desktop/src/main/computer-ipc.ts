import { Option, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { ComputerScreenshotHistory } from "@vectordevai/app/computer/screenshot-history"
import { isComputerOverlay } from "./computer-overlay-registry"
import { settingsToWire, type ComputerSettingsWire } from "./computer-wire"

type Status = Awaited<ReturnType<Computer.ComputerPlatform["status"]>>
type AppRow = Awaited<ReturnType<Computer.ComputerPlatform["apps"]>>[number]
type Pane = Parameters<Computer.ComputerPlatform["openPane"]>[0]
type PermissionID = Parameters<Computer.ComputerPlatform["reset"]>[0]

/** What desktop main serves behind `window.api.computer`. D22's startup supplies it; nothing here touches Electron. */
export type ComputerIpcService = {
  status(): Promise<Status>
  state(): Computer.ComputerState
  command(command: Computer.Command, arg?: { sessionID?: string }): Promise<void>
  prefs(): Computer.ResolvedComputerSettings
  setPrefs(patch: Partial<Computer.ComputerPrefs>): Promise<Computer.ResolvedComputerSettings>
  permissions(): Promise<Computer.PermissionsView>
  recheck(): Promise<Computer.PermissionsView>
  inputSetup?(action: Computer.InputSetupAction): Promise<Computer.InputSetupStatus>
  openPane(id: Pane): Promise<void>
  reset(id: PermissionID): Promise<Computer.PermissionsView>
  apps(query?: string): Promise<AppRow[]>
  removeAlways(key: string): Promise<void>
  removeAllAlways(): Promise<void>
  block(app: { key: string; name: string }): Promise<void>
  unblock(key: string): Promise<void>
  deleteScreenshots(): Promise<{ removed: number }>
}

const STATE_CHANNEL = "computer-state-changed"
const PANES = new Set<string>(["screen", "accessibility", "windows-capture"])
const SERVICES = new Set<string>(["screen", "accessibility"])
const decodeArg = Schema.decodeUnknownOption(Computer.CommandArg, { onExcessProperty: "error" })
const isCommand = Schema.is(Computer.Command)

let service: ComputerIpcService | undefined

/** Startup attaches the live service before any main window loads; shutdown detaches it before disposing it. */
export function setComputerService(next: ComputerIpcService | undefined) {
  service = next
}

function current() {
  if (!service) throw new Error(`${Hands.NAME} is not available in this window.`)
  return service
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.length > max)
    throw new Error(`That ${Hands.NAME} request is invalid.`)
  return value
}

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error(`That ${Hands.NAME} request is invalid.`)
  return value as Record<string, unknown>
}

/**
 * Section 2.9's renderer channels. Every handler first checks the sender with `assert` (ipc.ts passes
 * assertTrustedRenderer, which also refuses every overlay window) before reading an argument.
 */
export function registerComputerIpc<E>(
  handle: (channel: string, listener: (event: E, ...args: unknown[]) => unknown) => void,
  _on: (channel: string, listener: (event: E, ...args: unknown[]) => void) => void,
  options: { assert(event: E): void },
) {
  const add = <A extends unknown[], R>(channel: (typeof Computer.IPC_CHANNELS)[number], run: (...args: A) => R) =>
    handle(channel, (event: E, ...args: unknown[]) => {
      options.assert(event)
      return run(...(args as A))
    })

  add("computer-status", () => current().status())
  add("computer-state", () => current().state())
  add("computer-command", (command: unknown, arg?: unknown) => {
    if (!isCommand(command)) throw new Error(`That ${Hands.NAME} command is invalid.`)
    const decoded = arg === undefined ? Option.some({}) : decodeArg(arg)
    if (Option.isNone(decoded)) throw new Error(`That ${Hands.NAME} command is invalid.`)
    return current().command(command, decoded.value)
  })
  add("computer-prefs", (): ComputerSettingsWire => settingsToWire(current().prefs()))
  add("computer-set-prefs", async (patch: unknown): Promise<ComputerSettingsWire> => {
    const value = plain(patch)
    if (Object.keys(value).some((key) => !Computer.PREFS_KEYS.includes(key as keyof Computer.ComputerPrefs)))
      throw new Error(`Unknown ${Hands.NAME} preference.`)
    return settingsToWire(await current().setPrefs(value as Partial<Computer.ComputerPrefs>))
  })
  add("computer-permissions", () => current().permissions())
  add("computer-recheck", () => current().recheck())
  add("computer-input-setup", (action: unknown) => {
    if (!Schema.is(Computer.InputSetupAction)(action)) throw new Error("That input setup action is invalid.")
    const setup = current().inputSetup
    if (!setup) throw new Error("Input setup is unavailable.")
    return setup(action)
  })
  add("computer-open-pane", (id: unknown) => {
    if (typeof id !== "string" || !PANES.has(id)) throw new Error("That settings pane is unavailable.")
    return current().openPane(id as Pane)
  })
  add("computer-reset", (id: unknown) => {
    if (typeof id !== "string" || !SERVICES.has(id)) throw new Error("That permission is unavailable.")
    return current().reset(id as PermissionID)
  })
  add("computer-apps", (query?: unknown) => current().apps(query === undefined ? undefined : text(query, 256)))
  add("computer-remove-always", (key: unknown) => current().removeAlways(text(key, 1024)))
  add("computer-remove-all-always", () => current().removeAllAlways())
  add("computer-block", (app: unknown) => {
    const value = plain(app)
    if (Object.keys(value).some((key) => key !== "key" && key !== "name"))
      throw new Error(`That ${Hands.NAME} request is invalid.`)
    return current().block({ key: text(value.key, 1024), name: text(value.name, 1024) })
  })
  add("computer-unblock", (key: unknown) => current().unblock(text(key, 1024)))
  add("computer-delete-screenshots", () => current().deleteScreenshots())
}

type Window = {
  isDestroyed(): boolean
  webContents: { isDestroyed(): boolean; getURL(): string; send(channel: string, value: unknown): void }
}

function broadcast(
  channel: string,
  value: unknown,
  windows: () => readonly Window[],
  trustedUrl: (url?: string) => boolean,
) {
  for (const window of windows()) {
    try {
      if (window.isDestroyed() || isComputerOverlay(window) || window.webContents.isDestroyed()) continue
      if (!trustedUrl(window.webContents.getURL())) continue
      window.webContents.send(channel, value)
    } catch {
      // A window closing mid-broadcast misses one message; it reads current state when it next opens.
    }
  }
}

/** Sends Hands state to Vector's own trusted renderer windows only: never an overlay or any other page. */
export function broadcastComputerState(
  state: Computer.ComputerState,
  windows: () => readonly Window[],
  trustedUrl: (url?: string) => boolean,
) {
  broadcast(STATE_CHANNEL, state, windows, trustedUrl)
}

/**
 * Tells Vector's own trusted renderer windows which screenshots the engine deleted, so each refreshes the history it
 * holds (D23). It carries only the deletion's selection, never a screenshot, and never reaches an overlay.
 */
export function broadcastScreenshotsRemoved(
  removal: ComputerScreenshotHistory.Removal,
  windows: () => readonly Window[],
  trustedUrl: (url?: string) => boolean,
) {
  broadcast(ComputerScreenshotHistory.CHANNEL, removal, windows, trustedUrl)
}
