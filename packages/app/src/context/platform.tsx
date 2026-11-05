import { createSimpleContext } from "@vectordevai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import type { DesktopMenuAction } from "../desktop-menu"
import type { ServerConnection } from "./server"
import type { WslServersPlatform } from "../wsl/types"
import type { UpdaterPlatform } from "../updater"
import type { VectorAccountPlatform } from "../vector-account"
import type { ReportsPlatform } from "../support-reports"
import type { PhoneAlertEvent } from "./settings"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenAttachmentPickerOptions = {
  title?: string
  multiple?: boolean
  accept?: string[]
  extensions?: string[]
  defaultPath?: string
}
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type PlatformName = "web" | "desktop"
type DesktopOS = "macos" | "windows" | "linux"

/** What a computer sends its phones (WP A41 implements it; the phone app opens it, packages/app/src/phone/alerts.ts). */
export type PhoneAlertsPlatform = {
  send(alert: { event: PhoneAlertEvent; title: string; route?: "sessions" | "approvals" }): Promise<void>
}

/** Vector Remote on this computer, as the desktop's main process reports it (WP A41; Settings → Remote is A42). */
export type RemoteStatus = {
  enabled: boolean
  state:
    | "off"
    | "ready"
    | "signed-out"
    | "connecting"
    | "online"
    | "paused"
    | "not-in-plan"
    | "unavailable"
    | "device-limit"
    | "fair-use"
    | "revoked"
    | "replaced"
    | "local-off"
  message?: string
  phones: { device: string; name: string; pairedAt: number; connected: boolean; watching: boolean }[]
  limit: number
  viewers: number
  pairing:
    | { state: "idle" }
    | { state: "waiting"; link: string; expiresAt: number }
    | { state: "confirm"; code: string; phone: string; expiresAt: number }
    | { state: "paired"; phone: string }
    | { state: "failed"; message: string }
}

export type RemotePlatform = {
  status(): Promise<RemoteStatus>
  setEnabled(enabled: boolean): Promise<RemoteStatus>
  /** A pairing offer: `link` is what the QR code shows. */
  startPairing(): Promise<{ link: string; expiresAt: number; status: RemoteStatus }>
  /** The person saw the same six digits on the phone. */
  confirmPairing(code?: string): Promise<RemoteStatus>
  cancelPairing(): Promise<RemoteStatus>
  unpair(device: string): Promise<RemoteStatus>
  /** "Disconnect all phones": a new identity on this computer, and every relay connection closed. */
  disconnectAll(): Promise<RemoteStatus & { killed: boolean }>
  /** Whether a phone started the turn any of these sessions runs (auto-accept leaves those to a person, S6). */
  isPhoneTurn(sessionIDs: string[]): Promise<boolean>
  onChange(callback: (status: RemoteStatus) => void): () => void
}

/** Brain Vault on this computer, as the desktop's main process reports it (WP A45). No key, code or content. */
export type VaultStatus = {
  /** The OS credential store can keep the vault key; without it no vault is made on this computer. */
  secure: boolean
  /** The nightly backup while the app is open. */
  enabled: boolean
  backend: "vector" | "github"
  githubRepo?: string
  hasVault: boolean
  running?: "backup" | "restore" | "forget" | "delete"
  last?: { version: string; at: number; files: number; sentBytes: number }
  error?: string
  warning?: string
  /** GitHub: the bytes the vault takes in the repository. */
  storedBytes?: number
  nextAt?: number
}

export type VaultResult = { ok: boolean; message: string; status: VaultStatus; code?: string }

export type VaultVersions =
  | {
      ok: true
      label: string
      snapshots: readonly { id: string; createdAt: number; bytes: number }[]
      usage?: { usedBytes: number; quotaBytes: number }
      storedBytes?: number
      readOnly?: boolean
      deleteAt?: number
      mine: boolean
      status: VaultStatus
    }
  | { ok: false; message: string; status: VaultStatus }

export type VaultRestoreResult = VaultResult & {
  needsCode?: boolean
  totals?: {
    restored: number
    active: number
    pinned: number
    waiting: number
    known: number
    refused: number
    documents: number
    unreadable: number
    version: string
    newer: boolean
  }
}

export type VaultPlatform = {
  status(): Promise<VaultStatus>
  configure(input: { enabled?: boolean; backend?: "vector" | "github"; githubRepo?: string }): Promise<VaultResult>
  /** Backs up now; the first backup answers the new vault's recovery code once. */
  backup(): Promise<VaultResult>
  versions(): Promise<VaultVersions>
  /** Restores a version (the newest by default) with this computer's key, or with the recovery code. */
  restore(input: { version?: string; code?: string }): Promise<VaultRestoreResult>
  forget(version: string): Promise<VaultResult>
  /** Deletes the whole vault where backups go now. */
  remove(): Promise<VaultResult>
  onChange(callback: (status: VaultStatus) => void): () => void
}

export type FatalRendererErrorLog = {
  error: string
  url: string
  version?: string
  platform: PlatformName
  os?: DesktopOS
}

type PlatformBase = {
  /** App version */
  version?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Restart the app  */
  restart(): Promise<void>

  /** Navigate back in history */
  back(): void

  /** Navigate forward in history */
  forward(): void

  /** Send a system notification (optional deep link) */
  notify(title: string, description?: string, href?: string, options?: { force?: boolean }): Promise<void>

  /** Open a native attachment picker and read selected files sequentially (desktop only) */
  openAttachmentPickerDialog?(
    opts: OpenAttachmentPickerOptions,
    onFile: (file: File) => Promise<unknown>,
  ): Promise<void>

  /** Resolve the native source path for a desktop File. */
  getPathForFile?(file: File): string

  /** Open a native save file picker dialog (desktop only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Stable platform window identity for window-scoped persistence */
  windowID?: string

  /** Application-global desktop updater */
  updater?: UpdaterPlatform

  /** Desktop account status and sign-in; credentials stay in the main process. */
  vectorAccount?: VectorAccountPlatform

  /** Bug reports this computer sent and what became of each (desktop only); the report ids stay in the main process. */
  reports?: ReportsPlatform

  /**
   * Alerts from this computer to the account's phones (desktop only; Remote's desktop half, WP A41, provides it): each
   * alert is encrypted end to end to the paired phones' alert keys before vectordev.ai relays it. Settings →
   * Notifications offers the phone events and quiet hours only where it exists.
   */
  phoneAlerts?: PhoneAlertsPlatform

  /** Vector Remote on this computer (desktop only; WP A41): pairing, the paired phones and "Disconnect all phones". */
  remote?: RemotePlatform

  /** Brain Vault on this computer (desktop only; WP A45): Settings → Memory → Backup and the nightly backup. */
  vault?: VaultPlatform

  /** Saved remote-server passwords in the OS keychain (desktop only); set resolves false when none is available. */
  serverCredentials?: {
    get: (url: string) => Promise<{ username?: string; password: string } | null>
    set: (url: string, credential: { username?: string; password: string }) => Promise<boolean>
    delete: (url: string) => Promise<void>
  }

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Manage WSL sidecar servers (Electron on Windows only) */
  wslServers?: WslServersPlatform

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Parse markdown to HTML using native parser (desktop only, returns unprocessed code blocks) */
  parseMarkdown?(markdown: string): Promise<string>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Get whether native pinch/Ctrl-scroll zoom gestures are enabled (desktop only) */
  getPinchZoomEnabled?(): Promise<boolean> | boolean

  /** Allow native pinch/Ctrl-scroll zoom gestures (desktop only) */
  setPinchZoomEnabled?(enabled: boolean): Promise<void> | void

  /** Get whether the daily usage counts check-in is on (desktop only) */
  getUsageSharing?(): Promise<boolean>

  /** Turn the daily usage counts check-in on or off (desktop only) */
  setUsageSharing?(enabled: boolean): Promise<void>

  /** Run a desktop-only menu action from the app chrome */
  runDesktopMenuAction?(action: DesktopMenuAction): Promise<void> | void

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Export collected diagnostic logs (desktop only) */
  exportDebugLogs?(): Promise<string>

  /** Record a fatal renderer error in platform logs (desktop only) */
  recordFatalRendererError?(error: FatalRendererErrorLog): Promise<void>
}

export type Platform = PlatformBase &
  (
    | { platform: "web"; os?: never }
    | {
        platform: "desktop"
        os?: DesktopOS
        openDirectoryPickerDialog(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>
      }
  )

export type DisplayBackend = "auto" | "wayland"

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
