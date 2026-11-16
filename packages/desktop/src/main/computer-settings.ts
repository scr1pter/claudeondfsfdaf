import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { Hands } from "@vectordevai/schema/hands"
import { defaultPolicy, policyAccess } from "./computer-policy"

const KEY = "computerAlwaysKey"
const RESET = "computerAlwaysReset"
const DOMAIN = "vector-computer-always-v1\0"
const DAYS: Record<Computer.Retention, number> = { task: 0, "1d": 1, "7d": 7, "30d": 30, session: Infinity }

export function defaultPrefs(platform: "darwin" | "win32" = "darwin"): Computer.ComputerPrefs {
  return {
    enabled: false,
    mode: platform === "darwin" ? "background" : "foreground",
    pointer: "ask",
    blocked: [],
    unblocked: [],
    retention: "7d",
    stopChord: Hands.STOP_CHORD[platform],
    keepAwake: true,
    notify: true,
    reduceMotion: false,
  }
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Stored preferences are not authority to add new fields, unblock never apps or invent consent. */
export function normalizePrefs(value: unknown, platform: "darwin" | "win32" = "darwin"): Computer.ComputerPrefs {
  const input = record(value)
  const defaults = defaultPrefs(platform)
  const consentedAt = timestamp(input.consentedAt) ? input.consentedAt : undefined
  const granted = record(input.granted)
  return {
    ...defaults,
    enabled: input.enabled === true && consentedAt !== undefined,
    ...(consentedAt === undefined ? {} : { consentedAt }),
    mode: platform === "win32" ? "foreground" : input.mode === "foreground" ? "foreground" : defaults.mode,
    pointer: input.pointer === "take" ? "take" : "ask",
    blocked: Array.isArray(input.blocked)
      ? input.blocked
          .flatMap((entry) => {
            const row = record(entry)
            if (typeof row.key !== "string" || !Computer.parseAppKey(row.key) || typeof row.name !== "string") return []
            const name = Computer.clean(row.name, 256)
            return name && timestamp(row.addedAt) ? [{ key: row.key, name, addedAt: row.addedAt }] : []
          })
          .filter((row, index, rows) => rows.findIndex((item) => item.key === row.key) === index)
      : [],
    unblocked: Array.isArray(input.unblocked)
      ? [
          ...new Set(
            input.unblocked.filter(
              (key): key is string =>
                typeof key === "string" && ComputerApps.DEFAULT_BLOCKED.some((entry) => entry.key === key),
            ),
          ),
        ]
      : [],
    retention: Schema.is(Computer.Retention)(input.retention) ? input.retention : defaults.retention,
    stopChord:
      typeof input.stopChord === "string" && input.stopChord.length <= 128 && /^[A-Za-z0-9+_-]+$/.test(input.stopChord)
        ? input.stopChord
        : defaults.stopChord,
    keepAwake: typeof input.keepAwake === "boolean" ? input.keepAwake : defaults.keepAwake,
    notify: typeof input.notify === "boolean" ? input.notify : defaults.notify,
    reduceMotion: input.reduceMotion === true,
    ...(typeof granted.helperVersion === "string" &&
    Computer.clean(granted.helperVersion, 64) === granted.helperVersion &&
    timestamp(granted.at)
      ? { granted: { helperVersion: granted.helperVersion, at: granted.at } }
      : {}),
  }
}

export function clampRetention(retention: Computer.Retention, maxDays?: number): Computer.Retention {
  if (maxDays === undefined) return retention
  if (!Number.isFinite(maxDays) || maxDays <= 0) return "task"
  if (DAYS[retention] <= maxDays) return retention
  return (["30d", "7d", "1d", "task"] as const).find((value) => DAYS[value] <= maxDays) ?? "task"
}

export function locked(field: keyof Computer.ComputerPrefs, policy: Computer.ComputerPolicy) {
  return (
    (field === "enabled" && !policy.enabled) ||
    (field === "mode" && !policy.background) ||
    (field === "keepAwake" && !policy.keepAwake) ||
    (field === "retention" && policy.maxRetentionDays === 0)
  )
}

export function resolve(
  prefs: Computer.ComputerPrefs,
  policy: Computer.ComputerPolicy = defaultPolicy(),
  always: readonly Computer.AlwaysAllowed[] = [],
  alwaysReset = false,
): Computer.ResolvedComputerSettings {
  const next = structuredClone(prefs)
  next.enabled = next.enabled && timestamp(next.consentedAt) && policy.enabled
  if (!policy.background) next.mode = "foreground"
  if (!policy.keepAwake) next.keepAwake = false
  next.retention = clampRetention(next.retention, policy.maxRetentionDays)
  return {
    prefs: next,
    policy: { ...policy, apps: new Map(policy.apps), ignored: [...policy.ignored] },
    always: structuredClone([...always]),
    builtins: ComputerApps.TABLE.filter(
      (entry) => ComputerApps.NEVER.has(entry.category) || ComputerApps.DEFAULT_BLOCKED.includes(entry),
    ).map((entry) => ({
      key: entry.key,
      name: entry.name,
      reason: ComputerApps.NEVER.has(entry.category) ? builtinReason(entry.category) : "user",
      removable: ComputerApps.DEFAULT_BLOCKED.includes(entry),
    })),
    locked: Computer.PREFS_KEYS.filter((field) => locked(field, policy)),
    ...(alwaysReset ? { alwaysReset: true } : {}),
  }
}

// Only used to obtain the shared never-reason for a table row; no display label participates in access decisions.
function identityFor(entry: ComputerApps.AppMatcher): Computer.AppIdentity {
  return {
    platform: "macos",
    bundleId: entry.macos?.[0] ?? `invalid.${entry.key}`,
    apple: true,
    system: false,
    verified: true,
    name: entry.name,
  }
}

function builtinReason(category: ComputerApps.AppCategory): ComputerApps.BlockReason {
  const entry = ComputerApps.TABLE.find((entry) => entry.category === category && entry.macos?.length)
  return entry ? (ComputerApps.builtinRule(identityFor(entry))?.reason ?? "security") : "security"
}

export type AppGrants = {
  task?: ReadonlyMap<string, { identity: Computer.AppIdentity; level: Computer.AskLevel }>
  denied?: ReadonlySet<string>
  liftDeny?: boolean
  ownBuild?: { repo: string }
  signals?: ComputerApps.Signals
}

function saveable(app: Computer.AppIdentity) {
  return (
    app.platform !== "remote" &&
    app.verified &&
    (app.platform === "macos"
      ? app.apple || (typeof app.teamId === "string" && /^[A-Z0-9]{10}$/i.test(app.teamId))
      : app.kind === "aumid" || (Boolean(app.publisher.trim()) && app.publisher.toLowerCase() !== "unsigned"))
  )
}

function matchesSaved(app: Computer.AppIdentity, saved: Computer.AlwaysAllowed) {
  if (!saveable(app) || Computer.appKey(app) !== saved.key) return false
  if (app.platform === "macos")
    return saved.teamId
      ? saved.teamId.toLowerCase() === app.teamId?.toLowerCase()
      : app.apple && app.teamId === undefined
  if (app.platform === "windows") return (saved.publisher ?? "").toLowerCase() === (app.publisher ?? "").toLowerCase()
  return false
}

function savedIdentity(app: Computer.AppIdentity, at: number): Computer.AlwaysAllowed {
  return {
    key: Computer.appKey(app),
    name: Computer.clean(app.name, 256),
    addedAt: at,
    ...(app.platform === "macos" && app.teamId ? { teamId: app.teamId } : {}),
    ...(app.platform === "windows" && app.publisher ? { publisher: app.publisher } : {}),
  }
}

function sameTaskIdentity(app: Computer.AppIdentity, expected: Computer.AppIdentity) {
  if (
    Computer.appKey(app) !== Computer.appKey(expected) ||
    app.platform !== expected.platform ||
    app.verified !== expected.verified
  )
    return false
  if (app.platform === "macos" && expected.platform === "macos")
    return (
      app.apple === expected.apple &&
      app.teamId?.toLowerCase() === expected.teamId?.toLowerCase() &&
      (app.verified ||
        (Boolean(app.path) && timestamp(app.pid) && app.path === expected.path && app.pid === expected.pid))
    )
  if (app.platform === "windows" && expected.platform === "windows")
    return (
      app.kind === expected.kind &&
      app.publisher?.toLowerCase() === expected.publisher?.toLowerCase() &&
      (app.verified || (Boolean(app.exe) && timestamp(app.pid) && app.exe === expected.exe && app.pid === expected.pid))
    )
  return false
}

export function access(
  app: Computer.AppIdentity,
  settings: Computer.ResolvedComputerSettings,
  grants: AppGrants = {},
): Computer.AccessVerdict {
  const builtin = ComputerApps.builtinVerdict(app, settings.prefs, grants.signals)
  if (builtin) return builtin
  if (app.platform === "remote") return { verdict: "never", reason: "remote" }
  if (ComputerApps.category(app, grants.signals) === "system-ui") return { verdict: "never", reason: "security" }
  const key = Computer.appKey(app)
  if (settings.prefs.blocked.some((row) => row.key === key)) return { verdict: "blocked", reason: "user" }
  const company = policyAccess(app, settings.policy)
  if (
    !settings.policy.enabled ||
    company === "deny" ||
    (company !== "allow" && settings.policy.defaultAccess === "deny")
  )
    return { verdict: "company-deny" }
  if (
    !settings.prefs.enabled ||
    !timestamp(settings.prefs.consentedAt) ||
    (grants.denied?.has(key) && !grants.liftDeny)
  )
    return { verdict: "denied" }
  const saved =
    settings.always.find((entry) => entry.key === key) ??
    settings.always.find((entry) => {
      if (app.platform !== "windows" || app.kind !== "exe") return false
      const old = Computer.parseAppKey(entry.key)
      const current = Computer.parseAppKey(key)
      return (
        old?.platform === "windows" &&
        old.parts[0] === "exe" &&
        old.parts.slice(-2).join("|") === current?.parts.slice(-2).join("|")
      )
    })
  const changed = Boolean(saved && !matchesSaved(app, saved))
  const task = grants.task?.get(key)
  const liftedDeny = grants.denied?.has(key) === true && grants.liftDeny === true
  if (!liftedDeny && task && sameTaskIdentity(app, task.identity))
    return { verdict: "granted", level: task.level, via: "task" }
  const category = ComputerApps.category(app, grants.signals)
  if (!liftedDeny && saved && !changed && settings.policy.allowAlways && !ComputerApps.NO_ALWAYS.has(category))
    return { verdict: "granted", level: "interact", via: "always" }
  const why = !settings.policy.allowAlways
    ? "policy"
    : changed
      ? "changed"
      : !saveable(app)
        ? "unverified"
        : ComputerApps.NO_ALWAYS.has(category)
          ? "category"
          : undefined
  return {
    verdict: "ask",
    canAlways: why === undefined,
    ...(why ? { alwaysWhyNot: why } : {}),
    companyAllowed: company === "allow",
    changed,
    ...(grants.ownBuild ? { ownBuild: { repo: Computer.clean(grants.ownBuild.repo, 256) } } : {}),
  }
}

type Store = { get(key: string): unknown; set(key: string, value: unknown): void; delete(key: string): void }
type Vault = { available(): boolean; seal(text: string): Buffer; open(bytes: Buffer): string }
type Files = { read(): Promise<string | undefined>; write(text: string): Promise<void> }
export class ApprovalVaultUnavailable extends Error {
  constructor() {
    super("Secure storage is required to read or remember app approvals.")
  }
}
const Entry = Schema.Struct({
  key: Computer.AppKey,
  name: Schema.String,
  addedAt: Schema.Int,
  teamId: Schema.optional(Schema.String),
  publisher: Schema.optional(Schema.String),
})
const Envelope = Schema.Struct({ version: Schema.Literal(1), entries: Schema.Array(Entry), mac: Schema.String })

/** Desktop-owned persistence. All mutations serialize; neither key nor saved approvals are renderer-writable. */
export async function createComputerSettings(input: {
  store: Store
  vault: Vault
  files: Files
  policy?: () => Computer.ComputerPolicy
  platform?: "darwin" | "win32"
  now?: () => number
}) {
  const state = {
    prefs: normalizePrefs(input.store.get("computer"), input.platform),
    always: [] as Computer.AlwaysAllowed[],
    key: undefined as Buffer | undefined,
    reset: input.store.get(RESET) === true,
  }
  let tail: Promise<unknown> = Promise.resolve()
  const policy = input.policy ?? defaultPolicy
  const now = input.now ?? Date.now
  const queue = <T>(run: () => Promise<T>) => {
    const result = tail.then(run)
    tail = result.catch(() => {})
    return result
  }
  const snapshot = () => resolve(state.prefs, policy(), state.always, state.reset)
  const reset = () => {
    state.always = []
    state.key = undefined
    state.reset = true
    input.store.delete(KEY)
    input.store.set(RESET, true)
  }
  const mac = (entries: readonly Computer.AlwaysAllowed[], key: Buffer) =>
    createHmac("sha256", key)
      .update(DOMAIN)
      .update(JSON.stringify({ version: 1, entries }))
      .digest()

  function key(create: boolean) {
    if (state.key) return state.key
    if (!input.vault.available()) throw new ApprovalVaultUnavailable()
    const sealed = input.store.get(KEY)
    if (typeof sealed === "string") {
      const opened = (() => {
        try {
          return input.vault.open(Buffer.from(sealed, "base64"))
        } catch {
          throw new ApprovalVaultUnavailable()
        }
      })()
      const decoded = Buffer.from(opened, "base64")
      if (decoded.length !== 32) throw new Error("The saved approval key is invalid.")
      state.key = decoded
      return decoded
    }
    if (!create) throw new Error("The saved approval key is missing.")
    const next = randomBytes(32)
    input.store.set(KEY, input.vault.seal(next.toString("base64")).toString("base64"))
    state.key = next
    return next
  }

  const stored = await input.files.read()
  if (stored !== undefined) {
    const decoded =
      stored.length <= 1024 * 1024
        ? Schema.decodeUnknownOption(Schema.fromJsonString(Envelope), { onExcessProperty: "error" })(stored)
        : Option.none()
    if (Option.isNone(decoded)) reset()
    else {
      try {
        const signature = /^[0-9a-f]{64}$/.test(decoded.value.mac)
          ? Buffer.from(decoded.value.mac, "hex")
          : Buffer.alloc(0)
        const expected = mac(decoded.value.entries, key(false))
        if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) reset()
        else
          state.always = decoded.value.entries.filter(
            (entry) => timestamp(entry.addedAt) && Computer.clean(entry.name, 256) === entry.name,
          )
      } catch (error) {
        if (error instanceof ApprovalVaultUnavailable) throw error
        reset()
      }
    }
  }

  async function persist(entries: Computer.AlwaysAllowed[]) {
    const signature = mac(entries, key(true)).toString("hex")
    await input.files.write(JSON.stringify({ version: 1, entries, mac: signature }))
    state.always = entries
    state.reset = false
    input.store.delete(RESET)
  }

  return {
    get: snapshot,
    access: (app: Computer.AppIdentity, grants?: AppGrants) => access(app, snapshot(), grants),
    setPrefs(patch: Partial<Computer.ComputerPrefs>) {
      return queue(async () => {
        if (Object.keys(patch).some((field) => !Computer.PREFS_KEYS.includes(field as keyof Computer.ComputerPrefs)))
          throw new Error("Unknown computer preference.")
        const normalized = normalizePrefs({ ...state.prefs, ...patch }, input.platform)
        if (patch.enabled && !normalized.enabled) throw new Error("Explicit onboarding consent is required.")
        input.store.set("computer", normalized)
        state.prefs = normalized
        return snapshot()
      })
    },
    acceptAlways(identity: Computer.AppIdentity) {
      return queue(async () => {
        if (!Schema.is(Computer.AppIdentity)(identity)) return false
        const verdict = access(identity, snapshot())
        if (verdict.verdict !== "ask" || !verdict.canAlways) return false
        const entry = savedIdentity(identity, now())
        await persist([...state.always.filter((row) => row.key !== entry.key), entry])
        return true
      })
    },
    removeAlways(key: string) {
      return queue(async () => {
        const next = state.always.filter((entry) => entry.key !== key)
        if (next.length === state.always.length) return
        state.always = next
        try {
          await persist(next)
        } catch (error) {
          reset()
          throw error
        }
      })
    },
    removeAllAlways() {
      return queue(async () => {
        state.always = []
        try {
          await persist([])
        } catch (error) {
          reset()
          throw error
        }
      })
    },
    block(app: { key: string; name: string }) {
      return queue(async () => {
        if (!Computer.parseAppKey(app.key) || !Computer.clean(app.name, 256)) throw new Error("Invalid app block.")
        const blocked = [
          ...state.prefs.blocked.filter((entry) => entry.key !== app.key),
          { key: app.key, name: Computer.clean(app.name, 256), addedAt: now() },
        ]
        input.store.set("computer", { ...state.prefs, blocked })
        state.prefs = { ...state.prefs, blocked }
      })
    },
    unblock(key: string) {
      return queue(async () => {
        const next = { ...state.prefs, blocked: state.prefs.blocked.filter((entry) => entry.key !== key) }
        input.store.set("computer", next)
        state.prefs = next
      })
    },
  }
}

/** D22 calls this only after the desktop has selected its own user-data directory. Tests inject all persistence. */
export async function openComputerSettings(policy: () => Computer.ComputerPolicy) {
  const { app, safeStorage } = await import("electron")
  const { getStore } = await import("./store")
  const directory = app.getPath("userData")
  const file = path.join(directory, "computer-always.json")
  return createComputerSettings({
    store: getStore(),
    platform: process.platform === "win32" ? "win32" : "darwin",
    policy,
    vault: {
      available: () =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
      seal: (text) => safeStorage.encryptString(text),
      open: (bytes) => safeStorage.decryptString(bytes),
    },
    files: {
      read: () =>
        readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        }),
      async write(text) {
        await mkdir(directory, { recursive: true })
        const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`
        try {
          await writeFile(temporary, text, { mode: 0o600, flag: "wx" })
          await chmod(temporary, 0o600)
          await rename(temporary, file)
        } finally {
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
          })
        }
      },
    },
  })
}
