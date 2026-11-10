import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { app, safeStorage } from "electron"
import { vaultSecrets } from "./vault-secrets"

const KEY_DIRECTORY = "secure-runtime"
const KEY_FILE = "credential-key.v1"
const SEALED_VERSION = 2

type StoredKey = { type: "legacy"; key: Buffer } | { type: "sealed"; ciphertext: Buffer }

export async function setupSecureRuntimeSecrets() {
  const directory = join(app.getPath("userData"), KEY_DIRECTORY)
  const path = join(directory, KEY_FILE)
  const stored = await readFile(path, "utf8").then(
    (value) => readStoredKey(value),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    },
  )
  const secure = secureStorageAvailable()

  if (!secure && app.isPackaged) {
    // On macOS this means the Keychain prompt was declined or dismissed, not
    // that the Mac lacks a secure store.
    throw new Error(
      process.platform === "darwin"
        ? "Vector could not open its credential vault because macOS did not allow access to “Vector Safe Storage”. " +
          "Quit and reopen Vector, then choose Always Allow when macOS asks."
        : "Vector cannot open its credential vault because this system has no OS-backed secure storage. " +
          "Enable Credential Manager, libsecret, or KWallet and restart Vector.",
    )
  }

  const key = !stored ? randomBytes(32) : stored.type === "sealed" ? decryptKey(stored.ciphertext) : stored.key
  if (key.byteLength !== 32) throw new Error("Vector's secure runtime key is invalid.")

  if (secure && stored?.type !== "sealed") {
    await writeKey(directory, path, JSON.stringify({ version: SEALED_VERSION, ciphertext: encryptKey(key) }, null, 2))
  }
  if (!secure && !stored) await writeKey(directory, path, `${key.toString("base64")}\n`)

  process.env.VECTOR_CREDENTIAL_KEY = key.toString("base64")
  process.env.VECTOR_MCP_AUTH_KEY = key.toString("base64")
  if (secure) process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE = "1"
  // This launch's one read of the OS credential store is behind us: every sign-in after this is sealed in memory.
  vaultSecrets.setKey(secure ? key : undefined)
}

function secureStorageAvailable() {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform !== "linux") return true
  return safeStorage.getSelectedStorageBackend() !== "basic_text"
}

function encryptKey(key: Buffer) {
  return useSecureStorage(() => safeStorage.encryptString(key.toString("base64"))).toString("base64")
}

function decryptKey(ciphertext: Buffer) {
  const key = Buffer.from(useSecureStorage(() => safeStorage.decryptString(ciphertext)), "base64")
  if (key.byteLength !== 32) throw new Error("Vector's secure runtime key is invalid.")
  return key
}

function useSecureStorage<T>(operation: () => T) {
  try {
    return operation()
  } catch (cause) {
    throw secureStorageAccessError(cause)
  }
}

function secureStorageAccessError(cause: unknown) {
  const detail =
    process.platform === "darwin"
      ? "Restart Vector and allow access to “Vector Safe Storage” when macOS Keychain asks. If access was previously denied, update that item in Keychain Access."
      : "Unlock Credential Manager, libsecret, or KWallet, then restart Vector."
  return new Error(`Vector could not access the operating system's secure credential store. ${detail}`, { cause })
}

async function writeKey(directory: string, path: string, value: string) {
  await mkdir(directory, { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(temporary, value, { mode: 0o600 })
  await chmod(temporary, 0o600).catch(() => undefined)
  await rename(temporary, path)
}

function readStoredKey(value: string): StoredKey {
  const text = value.trim()
  if (!text.startsWith("{")) return { type: "legacy", key: readLegacyKey(text) }

  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Vector's secure runtime key is invalid.")
  }
  if (!("version" in parsed) || parsed.version !== SEALED_VERSION) {
    throw new Error("Vector's secure runtime key uses an unsupported format.")
  }
  if (!("ciphertext" in parsed) || typeof parsed.ciphertext !== "string") {
    throw new Error("Vector's secure runtime key is invalid.")
  }
  return { type: "sealed", ciphertext: Buffer.from(parsed.ciphertext, "base64") }
}

function readLegacyKey(value: string) {
  const key = Buffer.from(value, "base64")
  if (key.byteLength !== 32) throw new Error("Vector's secure runtime key is invalid.")
  return key
}
