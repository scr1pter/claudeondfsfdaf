import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { BrowserWindow, shell } from "electron"
import { focusBillingWindow, isBillingWindow, openBillingWindow } from "./billing-window"
import { getStore, removeStoreFileIfEmpty } from "./store"
import { vaultSecrets } from "./vault-secrets"
import { createVectorAccount, refreshVectorModels, syncVectorAccount } from "./vector-account"
import { createManagedAccountLifecycle } from "./vector-account-lifecycle"
import { isComputerOverlay } from "./computer-overlay-registry"

const STORE = "vector-account"
const TOKEN_PURPOSE = "vector-account-token"
let authorityRevision = 0
const authorityListeners = new Set<() => void>()
function changedAuthority() {
  authorityRevision++
  for (const listener of authorityListeners) listener()
}
export const vectorAccountAuthorityRevision = () => authorityRevision
/** Main-only authority invalidation; no credentials or identity are exposed to renderer listeners. */
export function onVectorAccountAuthorityChange(listener: () => void) {
  authorityListeners.add(listener)
  return () => {
    authorityListeners.delete(listener)
  }
}
const engine: {
  ready?: () => Promise<{ url: string; username: string | null; password: string | null }>
} = {}
const managed = createManagedAccountLifecycle()
/** Main-process listeners for sign-in and sign-out, such as Vector Remote's connection (remote-runtime.ts). */
const accountListeners = new Set<(status: { authenticated: boolean }) => void>()

export function onVectorAccountChanged(listener: (status: { authenticated: boolean }) => void) {
  accountListeners.add(listener)
  return () => void accountListeners.delete(listener)
}

export const vectorAccount = createVectorAccount({
  read: () => getStore(STORE).get("account"),
  write: (value) => {
    const previous = getStore(STORE).get("account")
    getStore(STORE).set("account", value)
    if (!(previous instanceof Object) || !("ciphertext" in previous) || previous.ciphertext !== value.ciphertext)
      changedAuthority()
  },
  clear: async () => {
    changedAuthority()
    getStore(STORE).delete("account")
    await removeStoreFileIfEmpty(STORE)
  },
  available: async () => vaultSecrets.available(),
  encrypt: async (token) => vaultSecrets.seal(token, TOKEN_PURPOSE),
  decrypt: async (ciphertext) => {
    const opened = await vaultSecrets.open(ciphertext, TOKEN_PURPOSE)
    const account = getStore(STORE).get("account")
    // An earlier release's token moves into the vault unless the person signed out or in again meanwhile. Restoring
    // the account at launch reads it first, before anything else holds on to the old ciphertext.
    if (opened.resealed && account instanceof Object && "ciphertext" in account && account.ciphertext === ciphertext)
      getStore(STORE).set("account", { ...account, ciphertext: opened.resealed })
    return opened.text
  },
  openBrowser: (url) => shell.openExternal(url),
  fetch: (url, init) => fetch(url, init),
  sync: async (token) => {
    if (!engine.ready) throw new Error("The local server is not ready.")
    const ready = engine.ready
    const synchronize = async () => syncVectorAccount(await ready(), token)
    await managed.sync(token, synchronize)
  },
  // Only the app's own sidecar: a WSL server gets the account when it starts, and its kept list lapses within a minute.
  models: async (token) => {
    if (!engine.ready) return
    await refreshVectorModels(await engine.ready(), token)
  },
  changed: (status) => {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed() && !isBillingWindow(window) && !isComputerOverlay(window))
        window.webContents.send("vector-account-changed", status)
    })
    accountListeners.forEach((listener) => listener(status))
  },
  // The window that asked is the one focused when the person clicked; the billing window opens over it.
  billingWindow: (url) => openBillingWindow(url, ModelPlanStatus.SITE, BrowserWindow.getFocusedWindow()),
  focusBilling: () => void focusBillingWindow(),
})

export function initializeVectorAccount(ready: NonNullable<typeof engine.ready>) {
  engine.ready = ready
}

/** Main-process lifecycle hook; never exposed through preload or renderer IPC. */
export const registerManagedVectorAccount = managed.register
