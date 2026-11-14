import { afterAll, describe, expect, mock, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "vector-server-credentials-"))
let keychainReads = 0
// A stand-in keychain: sealed bytes differ from the plaintext, as with the real safeStorage.
const electronMock = {
  app: { getPath: () => home, isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => {
      keychainReads++
      return Buffer.from(value).reverse()
    },
    decryptString: (value: Buffer) => {
      keychainReads++
      return Buffer.from(value).reverse().toString()
    },
  },
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))

const { vaultSecrets } = await import("./vault-secrets")
const { getStore } = await import("./store")
const { deleteServerCredential, readServerCredential, saveServerCredential } = await import("./server-credentials")
const storeFile = () => readFileSync(join(home, "vector.server-credentials"), "utf8")

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe("server credentials", () => {
  test("seals a saved password with the vault and reads it back without asking the keychain", () => {
    // What secure-runtime.ts does once per launch after it opens the vault key with the keychain.
    vaultSecrets.setKey(randomBytes(32))
    keychainReads = 0
    const url = "https://engine.example.test"
    expect(saveServerCredential(url, { username: "vector", password: "placeholder-password" })).toBe(true)

    expect(storeFile()).not.toContain("placeholder-password")
    expect(readServerCredential(url)).toEqual({ username: "vector", password: "placeholder-password" })
    expect(readServerCredential(url)).toEqual({ username: "vector", password: "placeholder-password" })
    expect(keychainReads).toBe(0)

    deleteServerCredential(url)
    expect(readServerCredential(url)).toBeUndefined()
  })

  test("a password an earlier release sealed with the keychain still reads, and moves into the vault", () => {
    vaultSecrets.setKey(randomBytes(32))
    keychainReads = 0
    const url = "https://legacy.example.test"
    const legacy = Buffer.from(JSON.stringify({ username: "vector", password: "placeholder-password" }))
      .reverse()
      .toString("base64")
    getStore("vector.server-credentials").set(url, legacy)

    expect(readServerCredential(url)).toEqual({ username: "vector", password: "placeholder-password" })
    expect(keychainReads).toBe(1)
    expect(storeFile()).not.toContain(legacy)
    expect(storeFile()).not.toContain("placeholder-password")

    expect(readServerCredential(url)).toEqual({ username: "vector", password: "placeholder-password" })
    expect(keychainReads).toBe(1)
    deleteServerCredential(url)
  })

  test("a password sealed for one server does not open as another's", () => {
    vaultSecrets.setKey(randomBytes(32))
    const store = getStore("vector.server-credentials")
    expect(saveServerCredential("https://one.example.test", { password: "placeholder-password" })).toBe(true)
    store.set("https://two.example.test", store.get("https://one.example.test"))

    expect(() => readServerCredential("https://two.example.test")).toThrow()
    deleteServerCredential("https://one.example.test")
    deleteServerCredential("https://two.example.test")
  })

  test("saves nothing without a keychain, so the app keeps the password where it was", () => {
    // A launch whose vault no OS keychain protects never opens it for sign-ins.
    vaultSecrets.setKey(undefined)
    expect(saveServerCredential("http://192.168.1.20:4096", { password: "placeholder-password" })).toBe(false)
    expect(readServerCredential("http://192.168.1.20:4096")).toBeUndefined()
  })
})
