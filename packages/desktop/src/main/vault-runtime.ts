import { join } from "node:path"
import { app, BrowserWindow } from "electron"
import { getStore } from "./store"
import {
  createVaultBackup,
  decodeKeyRecord,
  localRefusal,
  RestoreRefused,
  vectorVaultStore,
  type MemoryFile,
  type RestoreCounts,
  type VaultBackupController,
  type VaultSettings,
  type VaultStatus,
} from "./vault-backup"
import { githubVaultStore } from "./vault-github"
import { vaultSecrets } from "./vault-secrets"
import { vectorAccount } from "./vector-account-runtime"
import { Vault } from "@vectordevai/schema/vault"
import { broadcastRendererStatus } from "./renderer-status"

// Brain Vault in the running app (WP A45): the backup controller (vault-backup.ts) with Electron's pieces. The vault
// key is sealed in-process with the key the OS credential store holds (vault-secrets.ts, the app's use of safeStorage)
// and kept in the `vector-vault` store beside the settings, which are in the clear. Memory is read from and restored
// to the app's own engine over its authenticated loopback server; the nightly check runs while the app is open.

const STORE = "vector-vault"
const PURPOSE = "vector-vault-key"
const state: { backup?: VaultBackupController } = {}

function broadcast(status: VaultStatus) {
  broadcastRendererStatus(BrowserWindow.getAllWindows(), "vault-changed", status)
}

/** Starts Brain Vault once the local engine is up. Safe to call once per launch. */
export function startVault(input: {
  engine: { url: string; password: string }
  log: (message: string, meta?: Record<string, unknown>) => void
}) {
  if (state.backup) return state.backup
  const authorization = `Basic ${Buffer.from(`vector:${input.engine.password}`).toString("base64")}`
  const store = () => getStore(STORE)
  const cache = join(app.getPath("userData"), "vault-cache")
  const backup = createVaultBackup({
    settings: {
      read: () => {
        const value = store().get("settings")
        return value && typeof value === "object" ? (value as Partial<VaultSettings>) : {}
      },
      write: (next) => store().set("settings", JSON.parse(JSON.stringify(next)) as unknown),
    },
    keys: {
      secure: () => vaultSecrets.available(),
      read: async () => {
        const sealed = store().get("key")
        if (typeof sealed !== "string" || !vaultSecrets.available()) return undefined
        const opened = await vaultSecrets.open(sealed, PURPOSE)
        return decodeKeyRecord(JSON.parse(opened.text) as unknown)
      },
      write: async (record) => {
        if (!vaultSecrets.available())
          throw new Error(
            "Vector cannot keep a vault key safely on this computer. Unlock the operating system's credential store.",
          )
        store().set("key", vaultSecrets.seal(JSON.stringify(record), PURPOSE))
      },
      clear: async () => store().delete("key"),
    },
    memory: () => readMemory(input.engine.url, authorization),
    restore: (file) => restoreMemory(input.engine.url, authorization, file),
    githubStore: (repo) => githubVaultStore({ repo, cache }),
    vectorStore: (token) => vectorVaultStore(token),
    token: () => vectorAccount.token().catch(() => undefined),
    codium: () => vectorAccount.codium(),
    blocked: localRefusal,
    changed: broadcast,
    log: input.log,
  })
  state.backup = backup
  backup.start()
  return backup
}

export function stopVault() {
  state.backup?.stop()
  state.backup = undefined
}

export const vaultBackup = () => state.backup

/** What the renderer sees before the engine is up and Brain Vault has started. */
export function vaultStarting(): VaultStatus {
  return { secure: vaultSecrets.available(), enabled: false, backend: "github", hasVault: false }
}

/** The engine's memory as backup files (GET /memory/backup). */
async function readMemory(base: string, authorization: string): Promise<MemoryFile[]> {
  const response = await fetch(new URL("/memory/backup", base), {
    headers: { authorization, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  }).catch(() => undefined)
  if (!response?.ok) throw new Error("Vector's engine could not read its memory for the backup. Try again in a moment.")
  const body = (await response.json().catch(() => undefined)) as { files?: unknown } | undefined
  if (!Array.isArray(body?.files)) throw new Error("Vector's engine answered the backup with something unexpected.")
  return body.files.flatMap((file: unknown) => {
    if (!file || typeof file !== "object") return []
    const item = file as Record<string, unknown>
    if (typeof item.path !== "string" || typeof item.text !== "string" || typeof item.repository !== "string") return []
    if (item.section !== undefined && !(Vault.SECTIONS as readonly unknown[]).includes(item.section))
      throw new Error("Update Vector to back up this engine's learned content.")
    return [
      {
        path: item.path,
        text: item.text,
        ...(item.section === undefined ? {} : { section: item.section as Vault.Section }),
        repository: item.repository,
        ...(typeof item.worktree === "string" ? { worktree: item.worktree } : {}),
      },
    ]
  })
}

/** Restores one memory file through the engine (POST /memory/restore); a file it cannot read throws RestoreRefused. */
async function restoreMemory(base: string, authorization: string, file: MemoryFile): Promise<RestoreCounts> {
  const response = await fetch(new URL("/memory/restore", base), {
    method: "POST",
    headers: { authorization, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      text: file.text,
      ...(file.section === undefined ? {} : { section: file.section }),
      repository: file.repository,
      ...(file.worktree !== undefined ? { worktree: file.worktree } : {}),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  }).catch(() => undefined)
  if (response?.status === 400) throw new RestoreRefused("Vector's engine could not read a file of this backup.")
  if (!response?.ok) throw new Error("Vector's engine could not restore this backup. Try again in a moment.")
  const body = (await response.json().catch(() => undefined)) as
    | Partial<Record<keyof RestoreCounts, unknown>>
    | undefined
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)
  return {
    restored: count(body?.restored),
    active: count(body?.active),
    pinned: count(body?.pinned),
    waiting: count(body?.waiting),
    known: count(body?.known),
    refused: count(body?.refused),
    documents: count(body?.documents),
  }
}
