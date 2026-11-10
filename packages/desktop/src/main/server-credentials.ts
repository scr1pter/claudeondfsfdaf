import { getStore } from "./store"
import { vaultSecrets } from "./vault-secrets"

// Not a renderer store (those end in .dat), so the generic store IPC cannot read the sealed values.
const STORE = "vector.server-credentials"

export type ServerCredential = { username?: string; password: string }

/**
 * Passwords for remote Vector servers, sealed with Vector's credential vault, which the OS keychain (Keychain, DPAPI,
 * libsecret) protects. Without a real keychain nothing is saved and the app keeps the password where it was.
 */
export function saveServerCredential(url: string, credential: ServerCredential) {
  if (!vaultSecrets.available()) return false
  const sealed = vaultSecrets.seal(
    JSON.stringify({ username: credential.username, password: credential.password }),
    purpose(url),
  )
  getStore(STORE).set(key(url), sealed)
  return true
}

export function readServerCredential(url: string): ServerCredential | undefined {
  const sealed = getStore(STORE).get(key(url))
  if (typeof sealed !== "string" || !vaultSecrets.available()) return
  const opened = vaultSecrets.openSync(sealed, purpose(url))
  if (opened.resealed) getStore(STORE).set(key(url), opened.resealed)
  const value: unknown = JSON.parse(opened.text)
  if (!value || typeof value !== "object" || !("password" in value) || typeof value.password !== "string") return
  const username = "username" in value && typeof value.username === "string" ? value.username : undefined
  return { username, password: value.password }
}

export function deleteServerCredential(url: string) {
  getStore(STORE).delete(key(url))
}

function key(url: string) {
  if (typeof url !== "string" || !URL.canParse(url)) throw new Error("Invalid server address")
  return url
}

// A password sealed for one server does not open as another's.
function purpose(url: string) {
  return `server-credential:${key(url)}`
}
