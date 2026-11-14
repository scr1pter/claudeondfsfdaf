export * as ComputerSettings from "./computer-model"

import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { ComputerOnboarding } from "@/features/computer/onboarding-model"
import type { dict } from "@/i18n/en"

// The Hands Settings page as data (section 1.5 K): the status pill, what a company locks, the screenshot retention
// choices, the Always-allowed, company and blocked lists, and the stop shortcut. Nothing here reads the platform.

type CopyKey = keyof typeof dict
type Status = Awaited<ReturnType<Computer.ComputerPlatform["status"]>>
type Settings = Computer.ResolvedComputerSettings
type Field = keyof Computer.ComputerPrefs

export type Platform = "macos" | "windows"

export type View = {
  settings?: Settings
  status?: Status
  phase?: Computer.ComputerPhase
  backend?: Computer.ComputerState["backend"]
  permissions?: Computer.PermissionsView
  /** The first read of preferences, status and state failed, so nothing is known yet. */
  failed?: boolean
  /** The first read, including its permission probe, has not finished. */
  loading?: boolean
}

export type PillKey = Extract<
  CopyKey,
  | "computer.status.ready"
  | "computer.status.needsPermissions"
  | "computer.status.off"
  | "computer.status.companyOff"
  | "computer.status.linux"
  | "computer.status.preview"
  | "computer.settings.readFailed"
>
export type Pill = {
  key: PillKey
  kind: "ready" | "preview" | "setup" | "off" | "failed"
  /** The fixed sentence for what keeps it from being ready, shown under the pill. */
  note?: ComputerOnboarding.BlockedKey
}

// What onboarding can fix: a check to retry, and Windows' capture setting, which it opens. Everything else (company,
// administrator, macOS version, helper failure, no desktop backend) only has its sentence, as in the send gate.
const FIXABLE = new Set<ComputerOnboarding.BlockedKey>([
  "computer.onboarding.checkFailed",
  "computer.onboarding.windows.captureBlocked",
])

/**
 * The status pill. It reads the desktop's status, live phase and policy, and the latest permission probe, so it never
 * says Ready while a send would be refused.
 */
export function status(view: View, supported: boolean): Pill | undefined {
  if (!supported) return { key: "computer.status.linux", kind: "off" }
  if (view.failed) return { key: "computer.settings.readFailed", kind: "failed" }
  if (view.loading || !view.settings || !view.status || !view.backend) return
  const settings = view.settings
  const blocked =
    ComputerOnboarding.setupBlocked(view, true) ??
    ComputerOnboarding.probeBlocked(view.permissions) ??
    (view.permissions ? undefined : "computer.onboarding.checkFailed")
  if (blocked === "computer.availability.company" || blocked === "computer.settings.managed")
    return { key: "computer.status.companyOff", kind: "off" }
  const note = blocked ? { note: blocked } : {}
  if (blocked && !FIXABLE.has(blocked)) return { key: "computer.status.off", kind: "off", ...note }
  if (settings.prefs.enabled !== true || view.phase === "off")
    return { key: "computer.status.off", kind: "off", ...note }
  if (
    blocked ||
    view.phase === "setup" ||
    view.status.reason === "permissions" ||
    !ComputerOnboarding.canFinish(view.permissions, settings.prefs.consentedAt)
  )
    return { key: "computer.status.needsPermissions", kind: "setup", ...note }
  if (view.permissions?.adhoc === true || view.status.helper?.signing === "adhoc")
    return { key: "computer.status.preview", kind: "preview" }
  return { key: "computer.status.ready", kind: "ready" }
}

export function platformOf(backend: Computer.ComputerState["backend"] | undefined): Platform {
  return backend === "local-windows" ? "windows" : "macos"
}

/** Whether a company sets this field: an explicit lock, or the policy ceiling behind it. */
export function locked(field: Field, settings: Settings): boolean {
  if (settings.locked.includes(field)) return true
  if (field === "enabled") return settings.policy.enabled !== true
  if (field === "mode") return settings.policy.background !== true
  if (field === "keepAwake") return settings.policy.keepAwake !== true
  return false
}

/** What applies: company policy forces Take the screen and keep-awake off, and caps retention. */
export function effective(settings: Settings) {
  return {
    mode: settings.policy.background === true ? settings.prefs.mode : ("foreground" as const),
    keepAwake: settings.policy.keepAwake === true && settings.prefs.keepAwake === true,
    retention: clampRetention(settings.prefs.retention, settings.policy.maxRetentionDays),
  }
}

// The fields Settings may write. Consent, grants and blocks have their own paths (onboarding's Finish, D21, and the
// block calls), and Settings may only turn Hands off: only onboarding's Finish turns it on (INV-C1).
const WRITABLE = new Set<Field>([
  "enabled",
  "mode",
  "pointer",
  "keepAwake",
  "notify",
  "retention",
  "stopChord",
  "unblocked",
])

/** Whether Settings may send this patch: only its own fields, none a company sets, and `enabled` only as false. */
export function writable(patch: Partial<Computer.ComputerPrefs>, settings: Settings): boolean {
  const fields = Object.keys(patch) as Field[]
  if (fields.length === 0) return false
  if (fields.some((field) => !WRITABLE.has(field) || locked(field, settings))) return false
  if ("enabled" in patch && patch.enabled !== false) return false
  if ("retention" in patch && !retentionOptions(settings.policy.maxRetentionDays).includes(patch.retention!))
    return false
  if ("stopChord" in patch && (typeof patch.stopChord !== "string" || !patch.stopChord)) return false
  return true
}

// ---------------------------------------------------------------------------------------------------------------
// Screenshots

export const RETENTION = ["task", "1d", "7d", "30d", "session"] as const satisfies readonly Computer.Retention[]
const DAYS: Record<Computer.Retention, number> = { task: 0, "1d": 1, "7d": 7, "30d": 30, session: Infinity }
export const RETENTION_LABEL = {
  task: "computer.settings.screenshots.task",
  "1d": "computer.settings.screenshots.day",
  "7d": "computer.settings.screenshots.week",
  "30d": "computer.settings.screenshots.month",
  session: "computer.settings.screenshots.conversation",
} as const satisfies Record<Computer.Retention, CopyKey>

/** "Until the task ends" always; each period only within the company maximum; "until I delete" only without one. */
export function retentionOptions(maxDays: number | undefined): Computer.Retention[] {
  const max = maximum(maxDays)
  return RETENTION.filter((retention) => retention === "task" || DAYS[retention] <= max)
}

/** The longest choice within the company maximum. An unknown value reads as the shortest. */
export function clampRetention(retention: Computer.Retention, maxDays: number | undefined): Computer.Retention {
  const options = retentionOptions(maxDays)
  if (options.includes(retention)) return retention
  return RETENTION.includes(retention) ? options.at(-1)! : "task"
}

// A maximum that is not a non-negative number is read as the strictest one.
function maximum(maxDays: number | undefined) {
  if (maxDays === undefined) return Infinity
  return typeof maxDays === "number" && Number.isFinite(maxDays) && maxDays >= 0 ? maxDays : 0
}

// ---------------------------------------------------------------------------------------------------------------
// App lists

export type AlwaysRow = { key: string; name: string; publisher?: string; teamId?: string; addedAt?: number }

/** Always-allowed apps as Settings lists them. Every string is cleaned; a date is shown only when it is real. */
export function alwaysRows(always: readonly Computer.AlwaysAllowed[]): AlwaysRow[] {
  return always.map((entry) => {
    const publisher = typeof entry.publisher === "string" ? Computer.clean(entry.publisher, 256) : ""
    return {
      key: entry.key,
      name: label(entry.name, entry.key),
      ...(publisher ? { publisher } : {}),
      ...(typeof entry.teamId === "string" && /^[A-Z0-9]{10}$/.test(entry.teamId) ? { teamId: entry.teamId } : {}),
      ...(timestamp(entry.addedAt) ? { addedAt: entry.addedAt } : {}),
    }
  })
}

export type CompanyRow = { key: string; name: string }

/** The company's allowed and denied apps and its ignored rules; read-only, and empty unless the policy is managed. */
export function companyRows(policy: Computer.ComputerPolicy) {
  if (policy.managed !== true) return { allowed: [], denied: [], ignored: [] }
  // The desktop sends a Map; anything else is read as no rules rather than guessed at.
  const rules = policy.apps instanceof Map ? [...policy.apps] : []
  const rows = (access: "allow" | "deny") =>
    rules.filter((rule) => rule[1] === access).map((rule): CompanyRow => ({ key: rule[0], name: keyLabel(rule[0]) }))
  return {
    allowed: rows("allow"),
    denied: rows("deny"),
    ignored: (Array.isArray(policy.ignored) ? policy.ignored : [])
      .map((id) => Computer.clean(String(id), 256))
      .filter(Boolean),
  }
}

/** The five permanent groups, from ComputerApps' never categories. They have no buttons. */
export const NEVER_GROUPS = [
  {
    id: "terminal",
    title: "computer.settings.blocked.terminals",
    description: "computer.settings.blocked.terminals.description",
  },
  { id: "vector", title: "computer.settings.blocked.vector" },
  { id: "security", title: "computer.settings.blocked.security" },
  { id: "passwords", title: "computer.settings.blocked.passwords" },
  {
    id: "remote",
    title: "computer.settings.blocked.remote",
    description: "computer.settings.blocked.remote.description",
  },
] as const satisfies readonly { id: string; title: CopyKey; description?: CopyKey }[]

export type DefaultRow = {
  id: string
  /** A fixed name for a known group; otherwise `name` is the app's own cleaned name. */
  title?: CopyKey
  name?: string
  /** Every DEFAULT_BLOCKED key the row stands for; Allow removes the block from all of them. */
  keys: string[]
  allowed: boolean
  editable: boolean
}
export type UserRow = { key: string; name: string; addedAt?: number; editable: boolean }

const NAMED: Record<string, CopyKey> = {
  "builtin:disk-utility": "computer.settings.blocked.diskUtility",
  "builtin:find-my": "computer.settings.blocked.findMy",
  "builtin:migration-assistant": "computer.settings.blocked.migrationAssistant",
}

/**
 * Blocked apps in the three groups of 1.5 K. Default blocks come from the desktop's removable built-ins, so a
 * platform lists only its own; trading and crypto apps share one row.
 */
export function blockedRows(settings: Settings) {
  const unblocked = new Set(settings.prefs.unblocked)
  const defaults = new Map<string, DefaultRow>()
  for (const builtin of settings.builtins) {
    if (builtin.removable !== true) continue
    const entry = ComputerApps.DEFAULT_BLOCKED.find((item) => item.key === builtin.key)
    const id = entry?.category === "finance" ? "finance" : builtin.key
    const title = id === "finance" ? "computer.settings.blocked.finance" : NAMED[builtin.key]
    const row = defaults.get(id) ?? {
      id,
      ...(title ? { title } : { name: label(builtin.name, builtin.key) }),
      keys: [],
      allowed: false,
      editable: !locked("unblocked", settings),
    }
    if (!row.keys.includes(builtin.key)) row.keys.push(builtin.key)
    defaults.set(id, row)
  }
  return {
    never: NEVER_GROUPS,
    defaults: [...defaults.values()].map((row) => ({ ...row, allowed: row.keys.every((key) => unblocked.has(key)) })),
    yours: settings.prefs.blocked.map(
      (app): UserRow => ({
        key: app.key,
        name: label(app.name, app.key),
        ...(timestamp(app.addedAt) ? { addedAt: app.addedAt } : {}),
        editable: !locked("blocked", settings),
      }),
    ),
  }
}

/** `unblocked` after allowing (or blocking again) a default row; only keys the desktop lists as removable change. */
export function unblockedAfter(settings: Settings, keys: readonly string[], allow: boolean): string[] {
  const removable = new Set(settings.builtins.filter((builtin) => builtin.removable === true).map((item) => item.key))
  const change = new Set(keys.filter((key) => removable.has(key)))
  const kept = settings.prefs.unblocked.filter((key) => !change.has(key))
  return allow ? [...kept, ...change] : kept
}

/** What a person reads for an app: its cleaned name, or the identity its key names. */
function label(name: unknown, key: string) {
  return (typeof name === "string" && Computer.clean(name, 256)) || keyLabel(key)
}

function keyLabel(key: string) {
  const parsed = Computer.parseAppKey(key)
  if (!parsed) return Computer.clean(key, 256)
  if (parsed.platform === "windows")
    return parsed.parts[0] === "aumid" ? parsed.parts[1]! : parsed.parts[2] || parsed.parts[3]!
  return parsed.parts[0]!
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

// ---------------------------------------------------------------------------------------------------------------
// Stop shortcut (its label is ComputerMainCopy.chord, which the banner shares)

export type KeyPress = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">
export type Recorded =
  | { type: "chord"; accelerator: string }
  | { type: "cancel" }
  | { type: "pending" }
  | { type: "invalid"; reason: "keys" | "reserved" }

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "AltGraph", "Meta", "OS", "Super", "Hyper"])

// Chords the operating system keeps for itself. D20's validateChord is the authority; this only spares a save that
// main would refuse. macOS: Force Quit, the screenshot tools, Lock Screen and Log Out. Windows: Task Manager.
const RESERVED: Record<Platform, ReadonlySet<string>> = {
  macos: new Set([
    "Command+Alt+Escape",
    "Command+Shift+3",
    "Command+Shift+4",
    "Command+Shift+5",
    "Command+Control+Q",
    "Command+Shift+Q",
  ]),
  windows: new Set(["Control+Shift+Escape"]),
}

/**
 * One key press while recording the stop shortcut. The main key comes from the physical key (`code`), so Option,
 * Shift and non-Latin layouts, which change `key`, still record the key the person pressed. It needs two modifiers;
 * a plain Esc cancels. macOS refuses Control+Option (VoiceOver); Windows refuses the Windows key.
 */
export function recordChord(event: KeyPress, platform: Platform): Recorded {
  if (MODIFIER_KEYS.has(event.key) || /^(Control|Shift|Alt|Meta|OS)(Left|Right)$/.test(event.code))
    return { type: "pending" }
  const main = mainKey(event.code)
  const modifiers = (
    platform === "macos"
      ? [event.metaKey && "Command", event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift"]
      : [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift"]
  ).filter((name): name is string => !!name)
  if (main === "Escape" && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey)
    return { type: "cancel" }
  if (!main || modifiers.length < 2 || (platform === "windows" && event.metaKey))
    return { type: "invalid", reason: "keys" }
  const accelerator = [...modifiers, main].join("+")
  if ((platform === "macos" && event.ctrlKey && event.altKey) || RESERVED[platform].has(accelerator))
    return { type: "invalid", reason: "reserved" }
  return { type: "chord", accelerator }
}

function mainKey(code: string) {
  if (code === "Escape") return "Escape"
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]
  if (/^F([1-9]|1[0-2])$/.test(code)) return code
}
