import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import { safeStorage } from "electron"

// Vector's sign-ins (GitHub, GitLab, the Vector account, remote server passwords) are sealed in-process with a key
// derived from the credential vault key that secure-runtime.ts opens at launch and keeps in memory, as the cloud
// credential vault already does. Opening that key is the launch's one read of the OS credential store ("Vector Safe
// Storage" in the macOS Keychain). A Mac build that is not signed with an Apple Developer ID gets a Keychain prompt
// for every separate read after an update, and Electron's synchronous and asynchronous safeStorage each read the item
// on their own. So nothing here asks the credential store again, except to open a secret an earlier release sealed
// with it, which comes back sealed in-process for the caller to store.

const PREFIX = "vs1."
const KEY_INFO = "vector desktop secrets v1"
const LOCKED = "Vector's credential vault is not open."

/** The parts of Electron's safeStorage that can open a secret an earlier release sealed with it. */
type Keychain = {
  decryptString(encrypted: Buffer): string
  isAsyncEncryptionAvailable?(): Promise<boolean>
  decryptStringAsync?(encrypted: Buffer): Promise<{ result: string }>
}

/** `resealed` is set when the secret came from the credential store: the same secret, sealed in-process, to store. */
export type OpenedSecret = { text: string; resealed?: string }

export function createVaultSecrets(keychain: () => Keychain) {
  const state: { key?: Buffer; asyncKeychain?: Promise<boolean> } = {}

  const seal = (text: string, purpose: string) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", requireKey(state.key), iv).setAAD(Buffer.from(purpose))
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
    return PREFIX + [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".")
  }

  return {
    /** The key for the rest of the launch, or undefined when no OS credential store backs the vault. */
    setKey(vaultKey: Buffer | undefined) {
      state.key = vaultKey ? Buffer.from(hkdfSync("sha256", vaultKey, Buffer.alloc(0), KEY_INFO, 32)) : undefined
    },
    available: () => Boolean(state.key),
    seal,
    /** For secrets earlier releases sealed with Electron's synchronous safeStorage only. */
    openSync(value: string, purpose: string): OpenedSecret {
      const key = requireKey(state.key)
      if (value.startsWith(PREFIX)) return { text: openSealed(key, value, purpose) }
      // Chromium keeps the key it read to open the vault, so this reuses that read instead of asking again.
      const text = keychain().decryptString(Buffer.from(value, "base64"))
      return { text, resealed: seal(text, purpose) }
    },
    /** For secrets earlier releases may have sealed with Electron's asynchronous safeStorage. */
    async open(value: string, purpose: string): Promise<OpenedSecret> {
      const key = requireKey(state.key)
      if (value.startsWith(PREFIX)) return { text: openSealed(key, value, purpose) }
      const encrypted = Buffer.from(value, "base64")
      const text = await Promise.resolve()
        .then(() => keychain().decryptString(encrypted))
        .catch(async (cause: unknown) => {
          // The asynchronous provider reads the credential store on its own, so it is asked once per launch and only
          // for a secret the synchronous one could not open.
          state.asyncKeychain ??= Promise.resolve()
            .then(() => keychain().isAsyncEncryptionAvailable?.() ?? false)
            .catch(() => false)
          const decrypt = keychain().decryptStringAsync
          if (!(await state.asyncKeychain) || !decrypt) throw cause
          return (await decrypt.call(keychain(), encrypted)).result
        })
      return { text, resealed: seal(text, purpose) }
    },
  }
}

export const vaultSecrets = createVaultSecrets(() => safeStorage)

function requireKey(key: Buffer | undefined) {
  if (!key) throw new Error(LOCKED)
  return key
}

function openSealed(key: Buffer, value: string, purpose: string) {
  const parts = value.slice(PREFIX.length).split(".")
  const [iv, tag, data] = parts
  if (parts.length !== 3 || !iv || !tag || data === undefined) throw new Error("Vector's sealed secret is invalid.")
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: 16 })
  decipher.setAAD(Buffer.from(purpose)).setAuthTag(Buffer.from(tag, "base64url"))
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8")
}
