import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { BrowserWindow, safeStorage, shell } from "electron"
import { focusBillingWindow, isBillingWindow, openBillingWindow } from "./billing-window"
import { getStore, removeStoreFileIfEmpty } from "./store"
import { createVectorAccount, syncVectorAccount } from "./vector-account"
import { createManagedAccountLifecycle } from "./vector-account-lifecycle"
import { isComputerOverlay } from "./computer-overlay-registry"

const STORE = "vector-account"
const engine: {
  ready?: () => Promise<{ url: string; username: string | null; password: string | null }>
} = {}
const managed = createManagedAccountLifecycle()

async function available() {
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") return false
  return (await safeStorage.isAsyncEncryptionAvailable().catch(() => false)) || safeStorage.isEncryptionAvailable()
}

export const vectorAccount = createVectorAccount({
  read: () => getStore(STORE).get("account"),
  write: (value) => getStore(STORE).set("account", value),
  clear: async () => {
    getStore(STORE).delete("account")
    await removeStoreFileIfEmpty(STORE)
  },
  available,
  encrypt: async (token) => {
    if (!(await available())) throw new Error("Secure storage is unavailable.")
    const encrypted = (await safeStorage.isAsyncEncryptionAvailable().catch(() => false))
      ? await safeStorage.encryptStringAsync(token)
      : safeStorage.encryptString(token)
    return encrypted.toString("base64")
  },
  decrypt: async (ciphertext) => {
    if (!(await available())) throw new Error("Secure storage is unavailable.")
    const encrypted = Buffer.from(ciphertext, "base64")
    if (await safeStorage.isAsyncEncryptionAvailable().catch(() => false))
      return (await safeStorage.decryptStringAsync(encrypted)).result
    return safeStorage.decryptString(encrypted)
  },
  openBrowser: (url) => shell.openExternal(url),
  fetch: (url, init) => fetch(url, init),
  sync: async (token) => {
    if (!engine.ready) throw new Error("The local server is not ready.")
    const ready = engine.ready
    const synchronize = async () => syncVectorAccount(await ready(), token)
    await managed.sync(token, synchronize)
  },
  changed: (status) =>
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed() && !isBillingWindow(window) && !isComputerOverlay(window))
        window.webContents.send("vector-account-changed", status)
    }),
  // The window that asked is the one focused when the person clicked; the billing window opens over it.
  billingWindow: (url) => openBillingWindow(url, ModelPlanStatus.SITE, BrowserWindow.getFocusedWindow()),
  focusBilling: () => void focusBillingWindow(),
})

export function initializeVectorAccount(ready: NonNullable<typeof engine.ready>) {
  engine.ready = ready
}

/** Main-process lifecycle hook; never exposed through preload or renderer IPC. */
export const registerManagedVectorAccount = managed.register
