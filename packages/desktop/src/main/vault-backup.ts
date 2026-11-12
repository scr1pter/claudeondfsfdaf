import { Option, Schema } from "effect"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { VaultCrypto } from "@vectordevai/core/vault/crypto"
import { isVaultError } from "@vectordevai/core/vault/error"
import { VaultGitHub } from "@vectordevai/core/vault/github"
import { VaultRemote } from "@vectordevai/core/vault/remote"
import type { VaultStore } from "@vectordevai/core/vault/store"
import { VaultBackup } from "@vectordevai/core/vault/vault"
import { Vault } from "@vectordevai/schema/vault"
import { sizeWarning } from "./vault-github"

// Brain Vault in the desktop app (WP A45): Settings → Memory → Backup and the nightly backup while the app is open.
//
// - What is backed up is the engine's memory (GET /memory/backup): the person's own and each repository's, as export
//   JSON. It is encrypted here with the vault key (core vault/, A43) before anything leaves the computer, and sent to
//   a private GitHub repository the person owns (vault-github.ts, free on every plan, nothing to Vector) or to Brain
//   Vault on Vector (VaultRemote, the Vault API of A44, a paid perk whose quota and plan states the server enforces).
// - The first backup creates the vault and answers its recovery code once, for the Backup page to show; it is never
//   stored. The vault key is kept only sealed with the key the OS credential store holds (safeStorage, through
//   vault-secrets.ts in the runtime), so a computer without a secure credential store gets no vault.
// - The nightly backup runs once a day, in the small hours while the app is open, or as soon as the app has been open
//   for a while when the last backup is more than a day and a half old. It never creates a vault: that needs the
//   person, who has to keep the code.
// - A restore opens the vault with this computer's key, or with the recovery code on another computer (which then
//   keeps the vault's key and backs up to it), and puts each memory file back through the engine (POST
//   /memory/restore): what was in use and pinned comes back in use and pinned, never a copy of brain.db.
// - Vector's backend is offered only while the account's status lists `vault` with a plan whose `vault.gb` is above 0
//   (H1); a backup checks that first, and the Vault API decides anyway (S1). Its requests are the brain-vault source,
//   which Vector Local blocks, as are the GitHub backend's privacy check and git's pushes (git-remote).

export type VaultBackendKind = "vector" | "github"

/** What the main process keeps in the clear (store `vector-vault`): §4.15's vault settings and what the last run did. */
export type VaultSettings = {
  readonly enabled: boolean
  readonly backend: VaultBackendKind
  readonly githubRepo?: string
  /** The vault this computer holds the key of (an id, not a secret). */
  readonly vault?: string
  readonly last?: { readonly version: string; readonly at: number; readonly files: number; readonly sentBytes: number }
  readonly attemptAt?: number
  readonly error?: string
  readonly warning?: string
  readonly storedBytes?: number
}

const Backend = Schema.Union([
  Schema.Struct({ type: Schema.Literal("vector") }),
  Schema.Struct({ type: Schema.Literal("github"), repo: Schema.String }),
])
type Backend = typeof Backend.Type

/** This computer's vault key, which the runtime keeps sealed with the OS credential store's key. */
export const KeyRecord = Schema.Struct({
  v: Schema.Literal(1),
  vault: Vault.VaultId,
  /** The vault key, base64url. */
  key: Schema.String,
  wrapped: Vault.WrappedKey,
  backend: Backend,
})
export type KeyRecord = typeof KeyRecord.Type

export function decodeKeyRecord(input: unknown): KeyRecord | undefined {
  return Option.getOrUndefined(Schema.decodeUnknownOption(KeyRecord)(input))
}

/** What Settings → Memory → Backup reads. No key, code, content or amount. */
export type VaultStatus = {
  /** A secure credential store holds the vault key's sealing key; without one no vault is made here. */
  readonly secure: boolean
  readonly enabled: boolean
  readonly backend: VaultBackendKind
  readonly githubRepo?: string
  readonly hasVault: boolean
  readonly running?: "backup" | "restore" | "forget" | "delete"
  readonly last?: VaultSettings["last"]
  readonly error?: string
  readonly warning?: string
  /** GitHub: the bytes the vault takes in the repository. */
  readonly storedBytes?: number
  /** When the nightly backup is next due, while it is on and a vault exists. */
  readonly nextAt?: number
}

/** A file of the engine's backup (GET /memory/backup). */
export type MemoryFile = {
  readonly path: string
  readonly section?: Vault.Section
  readonly text: string
  readonly repository: string
  readonly worktree?: string
}

/** What the engine answers for one restored file (POST /memory/restore). */
export type RestoreCounts = {
  readonly restored: number
  readonly active: number
  readonly pinned: number
  readonly waiting: number
  readonly known: number
  readonly refused: number
  readonly documents: number
}

export type VaultResult = {
  readonly ok: boolean
  readonly message: string
  readonly status: VaultStatus
  /** The new vault's recovery code: answered once, by the backup that created the vault, even if the backup failed. */
  readonly code?: string
}

export type VaultVersions =
  | {
      readonly ok: true
      readonly label: string
      readonly snapshots: readonly { readonly id: string; readonly createdAt: number; readonly bytes: number }[]
      readonly usage?: { readonly usedBytes: number; readonly quotaBytes: number }
      readonly storedBytes?: number
      readonly readOnly?: boolean
      readonly deleteAt?: number
      /** Whether this computer holds the key of the vault there; otherwise a restore asks for the recovery code. */
      readonly mine: boolean
      readonly status: VaultStatus
    }
  | { readonly ok: false; readonly message: string; readonly status: VaultStatus }

export type VaultRestoreResult = VaultResult & {
  /** The vault there is not this computer's: the recovery code opens it. */
  readonly needsCode?: boolean
  readonly totals?: RestoreCounts & { readonly unreadable: number; readonly version: string; readonly newer: boolean }
}

export type VaultDeps = {
  readonly settings: { read(): Partial<VaultSettings>; write(next: VaultSettings): void }
  readonly keys: {
    /** Whether the OS credential store can seal the key. */
    secure(): boolean
    read(): Promise<KeyRecord | undefined>
    write(record: KeyRecord): Promise<void>
    clear(): Promise<void>
  }
  /** The engine's memory files; throws when the engine cannot be read. */
  memory(): Promise<readonly MemoryFile[]>
  /** Restores one memory file through the engine. */
  restore(file: MemoryFile): Promise<RestoreCounts>
  githubStore(repo: string): VaultStore.Store
  vectorStore(token: string): VaultStore.Store
  /** The desktop's Vector sign-in, for Vector's backend only. */
  token(): Promise<string | undefined>
  /** The account's Codium status, read before a backup to Vector's backend (H1). */
  codium(): Promise<ModelPlanStatus.Status>
  /** Why Vector Local blocks `backend` now, decided before any request, or undefined. */
  blocked?(backend: Backend): string | undefined
  readonly now?: () => number
  /** For tests: the recovery code's scrypt cost (2^17 otherwise). */
  readonly cost?: number
  /** The local hour of `at` (0–23). */
  readonly hour?: (at: number) => number
  changed?(status: VaultStatus): void
  log?(message: string, meta?: Record<string, unknown>): void
}

const HOUR = 60 * 60_000
/** The nightly backup's window, in local hours: from 02:00 to before 06:00. */
export const NIGHT = { from: 2, to: 6 }
const CHECK_MS = 15 * 60_000
const FIRST_CHECK_MS = 3 * 60_000
/** Each restore request carries at most this much JSON (the engine takes 2 MB) and 500 entries. */
const RESTORE_CHARS = 1_500_000
const RESTORE_ENTRIES = 500

/** Whether the nightly backup is due at `now`. */
export function due(settings: Partial<VaultSettings>, now: number, hour: number) {
  if (!settings.enabled || !settings.vault) return false
  const sinceSuccess = now - (settings.last?.at ?? 0)
  const sinceAttempt = now - (settings.attemptAt ?? 0)
  if (hour >= NIGHT.from && hour < NIGHT.to && sinceSuccess >= 20 * HOUR && sinceAttempt >= HOUR) return true
  // A computer that sleeps at night catches up after a day and a half, at most once every 6 hours.
  return sinceSuccess >= 36 * HOUR && sinceAttempt >= 6 * HOUR
}

/** When `due` is next true, roughly: the next night window, or the catch-up time if sooner. */
export function nextDue(settings: Partial<VaultSettings>, now: number, hour: number) {
  if (!settings.enabled || !settings.vault) return undefined
  const catchUp = Math.max((settings.last?.at ?? 0) + 36 * HOUR, (settings.attemptAt ?? 0) + 6 * HOUR)
  const hoursToNight = hour < NIGHT.from ? NIGHT.from - hour : hour >= NIGHT.to ? 24 - hour + NIGHT.from : 0
  const night = Math.max(
    now + hoursToNight * HOUR,
    (settings.last?.at ?? 0) + 20 * HOUR,
    (settings.attemptAt ?? 0) + HOUR,
  )
  return Math.max(now, Math.min(catchUp, night))
}

/**
 * A memory file cut into restore requests: entries without their evidence (a restore does not read it) and without
 * documents, at most RESTORE_ENTRIES entries and about RESTORE_CHARS characters each. A file that is not JSON of the
 * export shape goes as it is, for the engine to refuse.
 */
export function restoreParts(text: string) {
  const parsed = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  })()
  if (!parsed || typeof parsed !== "object" || !("entries" in parsed) || !Array.isArray(parsed.entries))
    return { parts: [text], documents: 0 }
  const { entries, documents, ...head } = parsed as { entries: unknown[]; documents?: unknown }
  const slim = entries.map((entry) =>
    entry && typeof entry === "object" && "evidence" in entry ? { ...entry, evidence: [] } : entry,
  )
  const parts: string[] = []
  let current: unknown[] = []
  let length = 0
  const flush = () => {
    parts.push(JSON.stringify({ ...head, entries: current, documents: [] }))
    current = []
    length = 0
  }
  for (const entry of slim) {
    const size = JSON.stringify(entry).length + 1
    if (current.length > 0 && (current.length >= RESTORE_ENTRIES || length + size > RESTORE_CHARS)) flush()
    current.push(entry)
    length += size
  }
  if (current.length > 0 || parts.length === 0) flush()
  return { parts, documents: Array.isArray(documents) ? documents.length : 0 }
}

function message(error: unknown, fallback: string) {
  if (isVaultError(error)) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/** Whether the status lets Vector's backend be offered: `vault` listed with a plan whose `vault.gb` is above 0. */
export function vectorOffered(status: ModelPlanStatus.Status | undefined) {
  const vault = status?.entitlements?.vault as { gb?: unknown } | undefined
  return Boolean(status?.listed?.includes("vault") && typeof vault?.gb === "number" && vault.gb > 0)
}

export function createVaultBackup(deps: VaultDeps) {
  const now = deps.now ?? Date.now
  const hour = deps.hour ?? ((at: number) => new Date(at).getHours())
  const state: {
    running?: VaultStatus["running"]
    timer?: ReturnType<typeof setInterval>
    first?: ReturnType<typeof setTimeout>
  } = {}

  const settings = (): VaultSettings => {
    const stored = deps.settings.read()
    return {
      enabled: stored.enabled === true,
      backend: stored.backend === "vector" ? "vector" : "github",
      ...(typeof stored.githubRepo === "string" && VaultGitHub.parseRepo(stored.githubRepo)
        ? { githubRepo: stored.githubRepo }
        : {}),
      ...(typeof stored.vault === "string" ? { vault: stored.vault } : {}),
      ...(stored.last ? { last: stored.last } : {}),
      ...(typeof stored.attemptAt === "number" ? { attemptAt: stored.attemptAt } : {}),
      ...(stored.error ? { error: stored.error } : {}),
      ...(stored.warning ? { warning: stored.warning } : {}),
      ...(typeof stored.storedBytes === "number" ? { storedBytes: stored.storedBytes } : {}),
    }
  }

  const status = (): VaultStatus => {
    const current = settings()
    const at = now()
    const next = nextDue(current, at, hour(at))
    return {
      secure: deps.keys.secure(),
      enabled: current.enabled,
      backend: current.backend,
      ...(current.githubRepo ? { githubRepo: current.githubRepo } : {}),
      hasVault: Boolean(current.vault),
      ...(state.running ? { running: state.running } : {}),
      ...(current.last ? { last: current.last } : {}),
      ...(current.error ? { error: current.error } : {}),
      ...(current.warning ? { warning: current.warning } : {}),
      ...(current.storedBytes !== undefined ? { storedBytes: current.storedBytes } : {}),
      ...(next !== undefined ? { nextAt: next } : {}),
    }
  }

  const write = (next: VaultSettings) => {
    deps.settings.write(next)
    deps.changed?.(status())
  }

  const backendOf = (current: VaultSettings): Backend | undefined =>
    current.backend === "vector"
      ? { type: "vector" }
      : current.githubRepo
        ? { type: "github", repo: current.githubRepo }
        : undefined

  /** The store `backend` names. A backup to Vector's backend first checks the status lists it (H1). */
  const storeFor = async (backend: Backend, write: boolean) => {
    const blocked = deps.blocked?.(backend)
    if (blocked) throw new Error(blocked)
    if (backend.type === "github") return deps.githubStore(backend.repo)
    const token = await deps.token()
    if (!token)
      throw new Error(
        "Sign in to Vector to use Brain Vault on Vector, or back up to a private GitHub repository you own.",
      )
    if (write) {
      const plan = await deps.codium()
      if (plan.error) throw new Error(plan.error)
      if (!vectorOffered(plan))
        throw new Error(
          "Brain Vault on Vector is not available on this account. Back up to a private GitHub repository you own instead.",
        )
    }
    return deps.vectorStore(token)
  }

  const exclusive = async <T>(kind: NonNullable<VaultStatus["running"]>, run: () => Promise<T>, busy: T) => {
    if (state.running) return busy
    state.running = kind
    deps.changed?.(status())
    try {
      return await run()
    } finally {
      state.running = undefined
      deps.changed?.(status())
    }
  }

  const openedOf = (record: KeyRecord): VaultBackup.Opened => ({
    vault: record.vault,
    vaultKey: VaultCrypto.fromBase64Url(record.key),
  })

  const busy = (): VaultResult => ({
    ok: false,
    message: "Brain Vault is busy. Try again in a moment.",
    status: status(),
  })

  /** Backs the memory up now. `nightly` never creates a vault. */
  const backup = (options: { readonly nightly?: boolean } = {}) =>
    exclusive<VaultResult>(
      "backup",
      async () => {
        const current = settings()
        const at = now()
        let code: string | undefined
        const fail = (reason: string): VaultResult => {
          write({ ...settings(), attemptAt: at, error: reason })
          deps.log?.("brain vault backup failed", { nightly: options.nightly === true })
          return { ok: false, message: reason, status: status(), ...(code ? { code } : {}) }
        }
        if (!deps.keys.secure())
          return fail(
            "Vector cannot keep a vault key safely on this computer. Unlock the operating system's credential store, then try again.",
          )
        const backend = backendOf(current)
        if (!backend) return fail("Choose a private GitHub repository you own for the backups first.")
        try {
          const record = await deps.keys.read()
          if (!record && options.nightly)
            return { ok: false, message: "Back up once from Settings to start.", status: status() }
          const store = await storeFor(backend, true)
          // Read first, so a computer with nothing to back up creates no vault and shows no code.
          const memory = await deps.memory()
          if (memory.length === 0) {
            write({ ...settings(), attemptAt: at, error: undefined })
            return { ok: true, message: "Nothing in memory to back up yet.", status: status() }
          }
          let opened: VaultBackup.Opened
          let wrapped: Vault.WrappedKey
          if (record) {
            opened = openedOf(record)
            wrapped = record.wrapped
            await VaultBackup.attach(store, opened, wrapped)
            if (JSON.stringify(record.backend) !== JSON.stringify(backend))
              await deps.keys.write({ ...record, backend })
          } else {
            const created = await VaultBackup.create(store, deps.cost ? { cost: deps.cost } : {})
            opened = created
            wrapped = created.wrapped
            code = created.code
            await deps.keys.write({
              v: 1,
              vault: created.vault,
              key: VaultCrypto.toBase64Url(created.vaultKey),
              wrapped,
              backend,
            })
            write({ ...settings(), vault: created.vault })
          }
          const encoder = new TextEncoder()
          const done = await VaultBackup.backup({
            store,
            opened,
            files: memory.map((file) => ({
              path: file.path,
              section: file.section ?? "memory",
              bytes: encoder.encode(file.text),
              repository: file.repository,
              ...(file.worktree !== undefined ? { worktree: file.worktree } : {}),
            })),
            now: at,
          })
          const storedBytes =
            backend.type === "github"
              ? await store
                  .list()
                  .then((listing) => listing.storedBytes)
                  .catch(() => undefined)
              : undefined
          const warning = backend.type === "github" ? sizeWarning(storedBytes, backend.repo) : undefined
          write({
            ...settings(),
            vault: opened.vault,
            last: {
              version: done.snapshot.id,
              at: done.snapshot.createdAt,
              files: memory.length,
              sentBytes: done.uploadedBytes,
            },
            attemptAt: at,
            error: undefined,
            warning,
            storedBytes,
          })
          return {
            ok: true,
            message: `Backed up ${memory.length} memory file${memory.length === 1 ? "" : "s"} to ${store.label}.`,
            status: status(),
            ...(code ? { code } : {}),
          }
        } catch (error) {
          return fail(message(error, "Brain Vault could not finish the backup. Try again."))
        }
      },
      busy(),
    )

  /** The versions where backups go now, and whether this computer holds their vault's key. */
  const versions = async (): Promise<VaultVersions> => {
    const backend = backendOf(settings())
    if (!backend) return { ok: false, message: "Choose where your backups go first.", status: status() }
    try {
      const store = await storeFor(backend, false)
      const [listing, held, record] = await Promise.all([store.list(), store.readKey(), deps.keys.read()])
      return {
        ok: true,
        label: store.label,
        snapshots: listing.snapshots.map((snapshot) => ({
          id: snapshot.id,
          createdAt: snapshot.createdAt,
          bytes: snapshot.bytes,
        })),
        ...(listing.usage
          ? { usage: { usedBytes: listing.usage.usedBytes, quotaBytes: listing.usage.quotaBytes } }
          : {}),
        ...(listing.storedBytes !== undefined ? { storedBytes: listing.storedBytes } : {}),
        ...(listing.readOnly ? { readOnly: true } : {}),
        ...(listing.deleteAt !== undefined ? { deleteAt: listing.deleteAt } : {}),
        mine: Boolean(held && record && held.vault === record.vault),
        status: status(),
      }
    } catch (error) {
      return {
        ok: false,
        message: message(error, "Brain Vault could not list the backups. Try again."),
        status: status(),
      }
    }
  }

  /** Restores a version (the newest by default) with this computer's key, or with the recovery code. */
  const restore = (input: { readonly version?: string; readonly code?: string } = {}) =>
    exclusive<VaultRestoreResult>(
      "restore",
      async () => {
        const backend = backendOf(settings())
        if (!backend) return { ok: false, message: "Choose where your backups are first.", status: status() }
        try {
          const store = await storeFor(backend, false)
          const held = await store.readKey()
          if (!held) return { ok: false, message: `${capital(store.label)} holds no vault.`, status: status() }
          const record = await deps.keys.read()
          let opened: VaultBackup.Opened
          if (record && record.vault === held.vault) opened = openedOf(record)
          else {
            const code = input.code?.trim()
            if (!code)
              return {
                ok: false,
                needsCode: true,
                message: `Enter the recovery code of the vault in ${store.label}.`,
                status: status(),
              }
            const unlocked = await VaultBackup.unlock(store, code)
            opened = { vault: unlocked.vault, vaultKey: unlocked.vaultKey }
            // The vault restored here becomes the one this computer backs up to, when its key can be kept safely.
            if (deps.keys.secure()) {
              await deps.keys.write({
                v: 1,
                vault: unlocked.vault,
                key: VaultCrypto.toBase64Url(unlocked.vaultKey),
                wrapped: unlocked.wrapped,
                backend,
              })
              write({
                ...settings(),
                vault: unlocked.vault,
                last: undefined,
                storedBytes: undefined,
                warning: undefined,
              })
            }
          }
          const read = await VaultBackup.read({ store, opened, ...(input.version ? { version: input.version } : {}) })
          const totals = {
            restored: 0,
            active: 0,
            pinned: 0,
            waiting: 0,
            known: 0,
            refused: 0,
            documents: 0,
            unreadable: 0,
          }
          for (const { file, bytes } of read.files) {
            if (!(Vault.SECTIONS as readonly string[]).includes(file.section) || file.repository === undefined) {
              totals.unreadable++
              continue
            }
            const { parts, documents } = file.section === "memory" ? restoreParts(bytes.toString("utf8")) :
              { parts: [bytes.toString("utf8")], documents: 0 }
            totals.documents += documents
            for (const text of parts) {
              const done = await deps
                .restore({
                  path: file.path,
                  text,
                  section: file.section as Vault.Section,
                  repository: file.repository,
                  ...(file.worktree !== undefined ? { worktree: file.worktree } : {}),
                })
                .catch((error: unknown) => (error instanceof RestoreRefused ? undefined : Promise.reject(error)))
              if (!done) {
                totals.unreadable++
                break
              }
              totals.restored += done.restored
              totals.active += done.active
              totals.pinned += done.pinned
              totals.waiting += done.waiting
              totals.known += done.known
              totals.refused += done.refused
            }
          }
          return {
            ok: true,
            message: `Restored ${totals.restored} entr${totals.restored === 1 ? "y" : "ies"} from the backup of ${when(read.manifest.createdAt)}.`,
            status: status(),
            totals: { ...totals, version: read.manifest.id, newer: read.skipped.length > 0 },
          }
        } catch (error) {
          return {
            ok: false,
            message: message(error, "Brain Vault could not restore this backup. Try again."),
            status: status(),
          }
        }
      },
      busy(),
    )

  /** Forgets one version. With this computer's key, the pieces only it named go too (GitHub); else the next backup's pruning removes them. */
  const forget = (version: string) =>
    exclusive<VaultResult>(
      "forget",
      async () => {
        const backend = backendOf(settings())
        if (!backend) return { ok: false, message: "Choose where your backups are first.", status: status() }
        if (!/^v\d{13}-[0-9a-f]{8}$/.test(version))
          return { ok: false, message: "That is not a backup version.", status: status() }
        try {
          const store = await storeFor(backend, false)
          const [held, record] = await Promise.all([store.readKey(), deps.keys.read()])
          if (held && record && held.vault === record.vault)
            await VaultBackup.forget({ store, opened: openedOf(record), version })
          else await store.forget(version)
          return { ok: true, message: "Forgot that version.", status: status() }
        } catch (error) {
          return {
            ok: false,
            message: message(error, "Brain Vault could not forget that version. Try again."),
            status: status(),
          }
        }
      },
      busy(),
    )

  /** Deletes the whole vault where backups go now; this computer forgets its key when it was that vault's. */
  const remove = () =>
    exclusive<VaultResult>(
      "delete",
      async () => {
        const current = settings()
        const backend = backendOf(current)
        if (!backend) return { ok: false, message: "Choose where your backups are first.", status: status() }
        try {
          const store = await storeFor(backend, false)
          const [held, record] = await Promise.all([store.readKey(), deps.keys.read()])
          await store.destroy()
          if (record && (!held || held.vault === record.vault)) {
            await deps.keys.clear()
            write({
              ...settings(),
              enabled: false,
              vault: undefined,
              last: undefined,
              attemptAt: undefined,
              error: undefined,
              warning: undefined,
              storedBytes: undefined,
            })
          }
          return {
            ok: true,
            message:
              backend.type === "github"
                ? `Deleted the vault in ${store.label}. Delete the repository on GitHub to remove what its history may keep.`
                : `Deleted your Brain Vault on Vector.`,
            status: status(),
          }
        } catch (error) {
          return {
            ok: false,
            message: message(error, "Brain Vault could not delete the vault. Try again."),
            status: status(),
          }
        }
      },
      busy(),
    )

  /** Changes where backups go and whether they run nightly. A repository is checked only for its shape here. */
  const configure = (input: {
    readonly enabled?: unknown
    readonly backend?: unknown
    readonly githubRepo?: unknown
  }) => {
    const current = settings()
    const repo = typeof input.githubRepo === "string" ? VaultGitHub.parseRepo(input.githubRepo) : undefined
    if (typeof input.githubRepo === "string" && input.githubRepo.trim() && !repo)
      return {
        ok: false,
        message: "Name the repository as owner/repo, for example octocat/brain-vault.",
        status: status(),
      }
    const backend = input.backend === "vector" || input.backend === "github" ? input.backend : current.backend
    const githubRepo = typeof input.githubRepo === "string" ? repo?.full : current.githubRepo
    const moved = backend !== current.backend || githubRepo !== current.githubRepo
    write({
      ...current,
      enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
      backend,
      githubRepo,
      // A new place starts with no backup there yet; the next backup writes the vault's key to it.
      ...(moved ? { last: undefined, storedBytes: undefined, warning: undefined, error: undefined } : {}),
    })
    return { ok: true, message: "Saved.", status: status() }
  }

  const check = () => {
    const at = now()
    if (state.running || !due(settings(), at, hour(at))) return
    void backup({ nightly: true })
  }

  return {
    status,
    configure,
    backup,
    versions,
    restore,
    forget,
    remove,
    /** Checks every 15 minutes, first a few minutes after launch, whether the nightly backup is due. */
    start() {
      if (state.timer) return
      state.first = setTimeout(check, FIRST_CHECK_MS)
      state.timer = setInterval(check, CHECK_MS)
      state.timer.unref?.()
      state.first.unref?.()
    },
    stop() {
      clearTimeout(state.first)
      clearInterval(state.timer)
      state.timer = undefined
      state.first = undefined
    },
    /** For tests: one scheduler tick. */
    check,
  }
}

export type VaultBackupController = ReturnType<typeof createVaultBackup>

/** The engine refused a restore file (400): a version this build cannot read. */
export class RestoreRefused extends Error {}

function when(at: number) {
  return new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC"
}

function capital(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The vault's requests to Vector (the Vault API and its signed storage links), labelled brain-vault. */
export const send: VaultRemote.Send = (url, init) => Egress.fetch("brain-vault", url, init)

/** Vector's backend for `token`, the desktop's sign-in. */
export function vectorVaultStore(token: string, api = `${ModelPlanStatus.SITE}/api/vault`) {
  return VaultRemote.store({ base: api, token, send, headers: ModelPlanStatus.clientHeaders() })
}

/** Why Vector Local blocks `backend` now, decided on the hosts it would reach, or undefined. */
export function localRefusal(backend: Backend) {
  if (!Egress.policy().enabled) return undefined
  const checks =
    backend.type === "github"
      ? [
          { source: "git-remote", url: "https://github.com/" },
          { source: "brain-vault", url: "https://api.github.com/" },
        ]
      : [{ source: "brain-vault", url: `${ModelPlanStatus.SITE}/` }]
  for (const check of checks) {
    const decided = Egress.decide(check)
    if (decided.decision !== "allow") return `Vector Local keeps Brain Vault off. ${decided.reason}`
  }
  return undefined
}
