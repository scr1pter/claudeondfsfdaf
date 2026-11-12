import type { Argv } from "yargs"
import fs from "node:fs/promises"
import path from "node:path"
import * as prompts from "@clack/prompts"
import { Effect, Option, Schema, Stream } from "effect"
import { Global } from "@vectordevai/core/global"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { VaultBackup } from "@vectordevai/core/vault/vault"
import { VaultCrypto } from "@vectordevai/core/vault/crypto"
import { isVaultError } from "@vectordevai/core/vault/error"
import { VaultGitHub } from "@vectordevai/core/vault/github"
import { VaultRecovery } from "@vectordevai/core/vault/recovery"
import { VaultRemote } from "@vectordevai/core/vault/remote"
import type { VaultStore } from "@vectordevai/core/vault/store"
import { VectorAccount } from "@vectordevai/core/vector-account"
import { Vault } from "@vectordevai/schema/vault"
import { Auth } from "@/auth"
import { VaultMemory } from "@/brain/vault-memory"
import { Git } from "@/git"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { CliOwnerGate } from "../owner-gate"
import { UI } from "../ui"

// `vector vault`: Brain Vault from the terminal (contract A43). A backup is the Brain's memory (the person's own and
// every repository's), encrypted on this computer, sent to Vector's Brain Vault (a paid perk the server enforces) or,
// free on every plan, to a private GitHub repository the person owns over their own git. The vault key stays in this
// computer's data folder; the recovery code, shown once, is the only way to restore on another computer. Restore goes
// through the brain's own writes (BrainExport.restore), never a copy of brain.db.
//
// Connections: the Vault API and its signed storage links, and GitHub's public API for the privacy check, are the
// brain-vault source; git's fetches and pushes go through Git.run, which Vector Local decides as git-remote; the plan's
// status is read as plans-catalog.

const GITHUB_API = "https://api.github.com"
const LOCAL_FILE = () => path.join(Global.Path.data, "vault", "vault.json")

/** The vault's own requests (the Vault API, its signed links, GitHub's privacy check), labelled brain-vault. */
export const send = (url: string, init: RequestInit) => Egress.fetch("brain-vault", url, init)

/** git for the GitHub backend, through the engine's Git.run, which Vector Local decides for each command that connects. */
export function gitRunner(git: Git.Interface): VaultGitHub.Git {
  return (args, options) =>
    Effect.runPromise(
      git.run([...args], {
        cwd: Global.Path.cache,
        ...(options?.env ? { env: { ...options.env } } : {}),
        ...(options?.input !== undefined
          ? {
              stdin: Stream.make(
                typeof options.input === "string" ? new TextEncoder().encode(options.input) : options.input,
              ),
            }
          : {}),
      }),
    ).then((result) => ({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr.toString("utf8") }))
}

const Backend = Schema.Union([
  Schema.Struct({ type: Schema.Literal("vector") }),
  Schema.Struct({ type: Schema.Literal("github"), repo: Schema.String }),
])
type Backend = typeof Backend.Type

const Local = Schema.Struct({
  v: Schema.Literal(1),
  vault: Vault.VaultId,
  /** The vault key, base64url, or sealed with the desktop's credential key when the desktop started this engine. */
  key: Schema.String,
  wrapped: Vault.WrappedKey,
  backend: Backend,
  last: Schema.optional(Schema.Struct({ version: Schema.String, at: Schema.Finite })),
})
type Local = typeof Local.Type

function credentialKey() {
  const raw = process.env.VECTOR_CREDENTIAL_KEY
  const key = raw ? Buffer.from(raw, "base64") : undefined
  return key?.byteLength === 32 ? key : undefined
}

const SEALED = "sealed:"
const LOCAL_AAD = Buffer.from("vector-vault-local-v1")

function encodeKey(vaultKey: Uint8Array) {
  const sealing = credentialKey()
  return sealing
    ? SEALED + VaultCrypto.toBase64Url(VaultCrypto.seal(sealing, vaultKey, LOCAL_AAD))
    : VaultCrypto.toBase64Url(vaultKey)
}

function decodeKey(text: string) {
  if (!text.startsWith(SEALED)) return VaultCrypto.fromBase64Url(text)
  const sealing = credentialKey()
  if (!sealing)
    throw new Error(
      "This computer's vault key is sealed by the desktop app. Open Settings → Memory → Backup in Vector.",
    )
  return VaultCrypto.open(
    sealing,
    VaultCrypto.fromBase64Url(text.slice(SEALED.length)),
    LOCAL_AAD,
    "This computer's vault key",
  )
}

async function readLocal(): Promise<Local | undefined> {
  const text = await fs.readFile(LOCAL_FILE(), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const parsed = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  })()
  const decoded = Schema.decodeUnknownOption(Local)(parsed)
  if (Option.isNone(decoded))
    throw new Error(`${LOCAL_FILE()} is damaged. Restore with your recovery code to set it up again.`)
  return decoded.value
}

// Written owner-only, beside auth.json, and replaced in one rename.
async function writeLocal(local: Local) {
  const file = LOCAL_FILE()
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(Schema.encodeSync(Local)(local), null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, file)
}

const promise = <A>(body: () => Promise<A>) =>
  Effect.tryPromise({ try: body, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      fail(isVaultError(error) || error instanceof Error ? error.message : "Brain Vault could not finish. Try again."),
    ),
  )

const githubOption = <T>(yargs: Argv<T>) =>
  yargs.option("github", {
    describe: "a private GitHub repository you own, as owner/repo (free; nothing goes to Vector)",
    type: "string",
  })

// The store a command uses: --github, or the backend this computer backs up to, or Vector's Brain Vault. `write` is a
// backup, which Vector's backend takes only while the plan includes Brain Vault; reading a vault that exists (status,
// versions, restore, forget) stays open while the plan is paused or has ended (§4.4), and the API decides.
const storeFor = Effect.fnUntraced(function* (input: {
  readonly github?: string
  readonly local?: Local
  readonly write?: boolean
}) {
  const backend: Backend = input.github
    ? { type: "github", repo: input.github }
    : (input.local?.backend ?? { type: "vector" })
  if (backend.type === "github") {
    const repo = VaultGitHub.parseRepo(backend.repo)
    if (!repo) return yield* fail("Name the repository as owner/repo, for example --github octocat/brain-vault.")
    yield* Effect.promise(() => fs.mkdir(Global.Path.cache, { recursive: true }))
    const runGit = gitRunner(yield* Git.Service)
    const store = VaultGitHub.store({
      repo: repo.full,
      remote: `https://github.com/${repo.owner}/${repo.name}.git`,
      api: GITHUB_API,
      dir: path.join(Global.Path.cache, "vault", "github", repo.owner, `${repo.name}.git`),
      git: runGit,
      send,
    })
    return { store, backend: { type: "github" as const, repo: repo.full } }
  }
  // Vector's backend is a perk: offered only while the account's status lists it (H1), and enforced by the API (S1).
  const auth = yield* Auth.Service
  const stored = yield* auth.get("vector").pipe(Effect.orElseSucceed(() => undefined))
  const token = yield* Effect.promise(() =>
    VectorAccount.resolveVectorToken({
      environment: process.env.VECTOR_CLI_TOKEN,
      stored: async () => (stored?.type === "api" ? stored.key : undefined),
    }).catch(() => undefined),
  )
  const instead = input.write
    ? "Back up to a private GitHub repository you own instead: vector vault backup --github owner/repo"
    : "For a backup in your own GitHub repository, add --github owner/repo."
  if (!token) return yield* fail(`Sign in with vector login to use Brain Vault on Vector. ${instead}`)
  if (input.write) {
    const status = yield* Effect.promise(() => ModelPlanStatus.fetchStatus(token, ModelPlans.plansCatalog))
    const vault = status.entitlements?.vault as { gb?: unknown } | undefined
    if (status.error) return yield* fail(status.error)
    if (!status.listed?.includes("vault") || typeof vault?.gb !== "number" || vault.gb <= 0)
      return yield* fail(`Brain Vault on Vector is not available on this account. ${instead}`)
  }
  const store = VaultRemote.store({
    base: `${ModelPlanStatus.SITE}/api/vault`,
    token,
    send,
    headers: ModelPlanStatus.clientHeaders(),
  })
  return { store, backend: { type: "vector" as const } }
})

/** This computer's memory, as files for a backup (VaultMemory.files, which the desktop's backup reads too). */
const memoryFiles = Effect.fnUntraced(function* () {
  const encoder = new TextEncoder()
  const { files, here } = yield* VaultMemory.files(yield* VaultMemory.services())
  return {
    files: files.map(({ text, ...file }): VaultBackup.Input => ({ ...file, bytes: encoder.encode(text) })),
    here,
  }
})

const recoveryCode = Effect.fnUntraced(function* () {
  const environment = process.env.VECTOR_VAULT_RECOVERY_CODE
  if (environment) return environment
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return yield* fail(
      "Restoring on a new computer needs the vault's recovery code: set VECTOR_VAULT_RECOVERY_CODE or run this in a terminal.",
    )
  const code = yield* Effect.promise(() =>
    prompts.password({
      message: "Recovery code",
      validate: (value) =>
        value && VaultRecovery.valid(value) ? undefined : "That does not read as a recovery code. Check each group.",
    }),
  )
  if (prompts.isCancel(code)) return yield* fail("Cancelled.")
  return code
})

function bytes(count: number) {
  if (count < 1000) return `${count} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = count
  let unit = -1
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

function when(at: number) {
  return new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC"
}

export const VaultCommand = cmd({
  command: "vault",
  describe: "back up your Brain, end-to-end encrypted, and restore it on another computer",
  builder: (yargs: Argv) =>
    yargs
      .command(VaultBackupCommand)
      .command(VaultStatusCommand)
      .command(VaultRestoreCommand)
      .command(VaultVersionsCommand)
      .command(VaultForgetCommand)
      .demandCommand(),
  async handler() {},
})

export const VaultBackupCommand = effectCmd({
  command: "backup",
  describe: "back up your memory now, encrypted on this computer",
  instance: () => process.env[ChildEnvironment.AGENT_MARKER] === undefined,
  builder: (yargs) => githubOption(yargs),
  handler: Effect.fn("Cli.vault.backup")(function* (args) {
    yield* CliOwnerGate.refuse("change Brain Vault backups")
    const local = yield* promise(readLocal)
    const { store, backend } = yield* storeFor({
      ...(args.github ? { github: args.github } : {}),
      ...(local ? { local } : {}),
      write: true,
    })
    // Read first, so a computer with nothing to back up creates no vault and shows no code.
    const { files } = yield* memoryFiles()
    if (files.length === 0) return UI.println("Nothing in memory to back up yet.")
    let opened: VaultBackup.Opened
    let wrapped: Vault.WrappedKey
    if (local) {
      opened = { vault: local.vault, vaultKey: yield* promise(async () => decodeKey(local.key)) }
      wrapped = local.wrapped
      yield* promise(() => VaultBackup.attach(store, opened, wrapped))
    } else {
      const created = yield* promise(() => VaultBackup.create(store))
      opened = created
      wrapped = created.wrapped
      yield* promise(() =>
        writeLocal({ v: 1, vault: created.vault, key: encodeKey(created.vaultKey), wrapped, backend }),
      )
      UI.println(UI.Style.TEXT_NORMAL_BOLD + "Your Brain Vault recovery code" + UI.Style.TEXT_NORMAL)
      UI.empty()
      UI.println(`    ${created.code}`)
      UI.empty()
      UI.println(
        "Write it down and keep it somewhere safe. It is the only way to restore these backups on another computer: Vector never sees it and cannot recover it.",
      )
      UI.empty()
    }
    const done = yield* promise(() => VaultBackup.backup({ store, opened, files }))
    yield* promise(() =>
      writeLocal({
        v: 1,
        vault: opened.vault,
        key: encodeKey(opened.vaultKey),
        wrapped,
        backend,
        last: { version: done.snapshot.id, at: done.snapshot.createdAt },
      }),
    )
    UI.println(
      UI.Style.TEXT_SUCCESS_BOLD +
        `Backed up ${files.length} memory file${files.length === 1 ? "" : "s"} to ${store.label}` +
        UI.Style.TEXT_NORMAL,
    )
    UI.println(
      UI.Style.TEXT_DIM +
        `Version ${done.snapshot.id}: ${done.uploaded} new piece${done.uploaded === 1 ? "" : "s"} (${bytes(done.uploadedBytes)} sent), ${done.reused} unchanged.` +
        (done.pruned.length
          ? ` Removed ${done.pruned.length} older version${done.pruned.length === 1 ? "" : "s"}.`
          : "") +
        UI.Style.TEXT_NORMAL,
    )
  }),
})

export const VaultStatusCommand = effectCmd({
  command: "status",
  describe: "where your Brain backs up to, and its versions",
  builder: (yargs) => githubOption(yargs),
  handler: Effect.fn("Cli.vault.status")(function* (args) {
    const local = yield* promise(readLocal)
    UI.println(UI.Style.TEXT_NORMAL_BOLD + "Brain Vault" + UI.Style.TEXT_NORMAL)
    if (!local && !args.github) {
      UI.println("This computer does not back up its Brain yet.")
      UI.println("Run vector vault backup --github owner/repo to back up to a private GitHub repository you own.")
      return
    }
    const { store } = yield* storeFor({ ...(args.github ? { github: args.github } : {}), ...(local ? { local } : {}) })
    const listing = yield* promise(() => store.list())
    UI.println(`Backs up to ${store.label}.`)
    if (local?.last) UI.println(`Last backup from this computer: ${when(local.last.at)}.`)
    const newest = listing.snapshots[0]
    UI.println(
      newest
        ? `${listing.snapshots.length} version${listing.snapshots.length === 1 ? "" : "s"}, the newest from ${when(newest.createdAt)}.`
        : "No backup yet.",
    )
    if (listing.usage) UI.println(`Using ${bytes(listing.usage.usedBytes)} of ${bytes(listing.usage.quotaBytes)}.`)
    else if (listing.storedBytes !== undefined) UI.println(`The vault takes ${bytes(listing.storedBytes)} there.`)
    if (listing.readOnly)
      UI.println(
        `Your vault takes no new backups now; restoring still works.${listing.deleteAt ? ` It is deleted on ${when(listing.deleteAt)}.` : ""}`,
      )
    UI.println(
      UI.Style.TEXT_DIM +
        "Encrypted on this computer before it leaves; nobody else can read it. Keep your recovery code: without it, these backups cannot be restored on another computer." +
        UI.Style.TEXT_NORMAL,
    )
  }),
})

export const VaultVersionsCommand = effectCmd({
  command: "versions",
  describe: "list the versions of your Brain backup",
  builder: (yargs) => githubOption(yargs),
  handler: Effect.fn("Cli.vault.versions")(function* (args) {
    const local = yield* promise(readLocal)
    if (!local && !args.github)
      return yield* fail("This computer does not back up its Brain yet. Name the backup with --github owner/repo.")
    const { store } = yield* storeFor({ ...(args.github ? { github: args.github } : {}), ...(local ? { local } : {}) })
    const listing = yield* promise(() => store.list())
    if (listing.snapshots.length === 0) return UI.println(`${store.label} holds no backup yet.`)
    for (const snapshot of listing.snapshots)
      UI.println(
        `${UI.Style.TEXT_HIGHLIGHT}${snapshot.id}${UI.Style.TEXT_NORMAL} ${when(snapshot.createdAt)}${snapshot.bytes ? `, ${bytes(snapshot.bytes)}` : ""}`,
      )
  }),
})

// The vault this computer's key opens, or the one `store` holds opened with its recovery code; restoring another
// vault makes it the one this computer backs up to.
const openFor = Effect.fnUntraced(function* (input: {
  readonly store: VaultStore.Store
  readonly local: Local | undefined
  readonly backend: Backend
  readonly adopt: boolean
}) {
  const held = yield* promise(() => input.store.readKey())
  if (!held) return yield* fail(`${input.store.label} holds no vault.`)
  const local = input.local
  if (local && local.vault === held.vault)
    return {
      vault: local.vault,
      vaultKey: yield* promise(async () => decodeKey(local.key)),
    } satisfies VaultBackup.Opened
  const code = yield* recoveryCode()
  const unlocked = yield* promise(() => VaultBackup.unlock(input.store, code))
  if (input.adopt)
    yield* promise(() =>
      writeLocal({
        v: 1,
        vault: unlocked.vault,
        key: encodeKey(unlocked.vaultKey),
        wrapped: unlocked.wrapped,
        backend: input.backend,
      }),
    )
  return { vault: unlocked.vault, vaultKey: unlocked.vaultKey } satisfies VaultBackup.Opened
})

export const VaultRestoreCommand = effectCmd({
  command: "restore [id]",
  describe: "restore your memory from a backup; what was in use comes back in use",
  instance: () => process.env[ChildEnvironment.AGENT_MARKER] === undefined,
  builder: (yargs) =>
    githubOption(yargs).positional("id", {
      describe: "a version from vector vault versions (the newest by default)",
      type: "string",
    }),
  handler: Effect.fn("Cli.vault.restore")(function* (args) {
    yield* CliOwnerGate.refuse("restore memory from Brain Vault")
    const local = yield* promise(readLocal)
    const { store, backend } = yield* storeFor({
      ...(args.github ? { github: args.github } : {}),
      ...(local ? { local } : {}),
    })
    const opened = yield* openFor({ store, local, backend, adopt: true })
    const read = yield* promise(() => VaultBackup.read({ store, opened, ...(args.id ? { version: args.id } : {}) }))
    const services = yield* VaultMemory.services()
    const total = { restored: 0, active: 0, pinned: 0, waiting: 0, known: 0, refused: 0, unreadable: 0, documents: 0 }
    for (const { file, bytes: content } of read.files) {
      const done =
        (file.section === "memory" || file.section === "skills" || file.section === "insights")
          ? yield* VaultMemory.restore(services, {
              text: content.toString("utf8"),
              section: file.section,
              ...(file.repository !== undefined ? { repository: file.repository } : {}),
              ...(file.worktree !== undefined ? { worktree: file.worktree } : {}),
            })
          : ({ unreadable: true } as const)
      if (done.unreadable) {
        total.unreadable++
        continue
      }
      total.restored += done.restored
      total.active += done.active
      total.pinned += done.pinned
      total.waiting += done.waiting
      total.known += done.known
      total.refused += done.refused
      total.documents += done.documents
    }
    UI.println(
      UI.Style.TEXT_SUCCESS_BOLD +
        `Restored ${total.restored} entr${total.restored === 1 ? "y" : "ies"} from version ${read.manifest.id}` +
        UI.Style.TEXT_NORMAL,
    )
    UI.println(
      `${total.active} in use${total.pinned ? ` (${total.pinned} pinned)` : ""}, ${total.waiting} waiting for your review as before.`,
    )
    const left = [
      total.known ? `${total.known} already in memory here` : undefined,
      total.refused ? `${total.refused} refused (forgotten here, or past what may wait for review)` : undefined,
      total.unreadable
        ? `${total.unreadable} file${total.unreadable === 1 ? "" : "s"} this version of Vector cannot read`
        : undefined,
    ].filter((item): item is string => item !== undefined)
    if (left.length) UI.println(UI.Style.TEXT_DIM + `Left out: ${left.join(", ")}.` + UI.Style.TEXT_NORMAL)
    if (read.skipped.length)
      UI.println(
        UI.Style.TEXT_DIM +
          "Parts of this backup need a newer Vector; update Vector to restore them too." +
          UI.Style.TEXT_NORMAL,
      )
    if (total.documents)
      UI.println(
        UI.Style.TEXT_DIM +
          "Documents are not part of a restore: add their files again for Vector to read them." +
          UI.Style.TEXT_NORMAL,
      )
  }),
})

export const VaultForgetCommand = effectCmd({
  instance: () => process.env[ChildEnvironment.AGENT_MARKER] === undefined,
  command: "forget [id]",
  describe: "delete one version of your backup, or the whole vault with --everything",
  builder: (yargs) =>
    githubOption(yargs)
      .positional("id", { describe: "a version from vector vault versions", type: "string" })
      .option("everything", { describe: "delete every version and the vault itself", type: "boolean", default: false })
      .option("yes", { describe: "confirm --everything", type: "boolean", default: false }),
  handler: Effect.fn("Cli.vault.forget")(function* (args) {
    yield* CliOwnerGate.refuse("delete Brain Vault backups")
    const local = yield* promise(readLocal)
    if (!local && !args.github)
      return yield* fail("This computer does not back up its Brain yet. Name the backup with --github owner/repo.")
    const { store, backend } = yield* storeFor({
      ...(args.github ? { github: args.github } : {}),
      ...(local ? { local } : {}),
    })
    const mine =
      local !== undefined &&
      (backend.type === "vector"
        ? local.backend.type === "vector"
        : local.backend.type === "github" && local.backend.repo === backend.repo)
    if (args.everything) {
      if (!args.yes)
        return yield* fail(
          `This deletes every version in ${store.label} and the vault itself, and nothing can restore it afterwards. Run it again with --yes to confirm.`,
        )
      yield* promise(() => store.destroy())
      if (mine) yield* promise(() => fs.rm(LOCAL_FILE(), { force: true }))
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Deleted the vault in ${store.label}` + UI.Style.TEXT_NORMAL)
      if (backend.type === "github")
        UI.println(
          UI.Style.TEXT_DIM +
            "Delete the repository on GitHub to remove what its history may keep." +
            UI.Style.TEXT_NORMAL,
        )
      return
    }
    if (!args.id) return yield* fail("Name a version from vector vault versions, or use --everything.")
    const opened = yield* openFor({ store, local, backend, adopt: false })
    const version = args.id
    yield* promise(() => VaultBackup.forget({ store, opened, version }))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Forgot ${version}` + UI.Style.TEXT_NORMAL)
  }),
})
