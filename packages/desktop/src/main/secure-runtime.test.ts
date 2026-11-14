import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let userDataPath = ""
let encryptionAvailable = true
let encryptFailure: Error | undefined
let decryptFailure: Error | undefined
// Every call that can reach the OS credential store ("Vector Safe Storage" in the macOS Keychain).
const calls = { available: 0, encrypt: 0, decrypt: 0, async: 0 }
const platform = Object.getOwnPropertyDescriptor(process, "platform")
const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...platform, value })
const electronMock = {
  app: {
    isPackaged: true,
    getPath: () => userDataPath,
  },
  safeStorage: {
    isEncryptionAvailable: () => {
      calls.available++
      return encryptionAvailable
    },
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => {
      calls.encrypt++
      if (encryptFailure) throw encryptFailure
      return Buffer.from(`sealed:${value}`)
    },
    decryptString: (value: Buffer) => {
      calls.decrypt++
      if (decryptFailure) throw decryptFailure
      return value.toString().replace(/^sealed:/, "")
    },
    isAsyncEncryptionAvailable: async () => {
      calls.async++
      return true
    },
    encryptStringAsync: async (value: string) => {
      calls.async++
      return Buffer.from(`sealed:${value}`)
    },
    decryptStringAsync: async (value: Buffer) => {
      calls.async++
      return { shouldReEncrypt: false, result: value.toString().replace(/^sealed:/, "") }
    },
  },
  // Bun keeps a module mock for the rest of the run, so it carries every export a later test file's imports bind.
  shell: { openExternal: async () => {} },
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))

const { setupSecureRuntimeSecrets } = await import("./secure-runtime")
const { vaultSecrets } = await import("./vault-secrets")
const previousCredentialKey = process.env.VECTOR_CREDENTIAL_KEY
const previousMcpKey = process.env.VECTOR_MCP_AUTH_KEY
const previousRequirement = process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE

beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), "vector-secure-runtime-"))
  electronMock.app.isPackaged = true
  encryptionAvailable = true
  encryptFailure = undefined
  decryptFailure = undefined
  delete process.env.VECTOR_CREDENTIAL_KEY
  delete process.env.VECTOR_MCP_AUTH_KEY
  delete process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE
})

afterEach(async () => {
  await rm(userDataPath, { recursive: true, force: true })
  if (platform) Object.defineProperty(process, "platform", platform)
  if (previousCredentialKey === undefined) delete process.env.VECTOR_CREDENTIAL_KEY
  else process.env.VECTOR_CREDENTIAL_KEY = previousCredentialKey
  if (previousMcpKey === undefined) delete process.env.VECTOR_MCP_AUTH_KEY
  else process.env.VECTOR_MCP_AUTH_KEY = previousMcpKey
  if (previousRequirement === undefined) delete process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE
  else process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE = previousRequirement
})

test("migrates the legacy file key into OS-backed encrypted storage", async () => {
  const key = Buffer.alloc(32, 9).toString("base64")
  const directory = join(userDataPath, "secure-runtime")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "credential-key.v1"), `${key}\n`)

  await setupSecureRuntimeSecrets()

  const stored = await readFile(join(directory, "credential-key.v1"), "utf8")
  expect(stored).not.toContain(key)
  expect(JSON.parse(stored)).toEqual({
    version: 2,
    ciphertext: Buffer.from(`sealed:${key}`).toString("base64"),
  })
  expect(process.env.VECTOR_CREDENTIAL_KEY).toBe(key)
  expect(process.env.VECTOR_MCP_AUTH_KEY).toBe(key)
  expect(process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE).toBe("1")

  await setupSecureRuntimeSecrets()
  expect(process.env.VECTOR_CREDENTIAL_KEY).toBe(key)
})

test("reads the OS credential store once per launch, then keeps every sign-in in memory", async () => {
  // The first launch makes and seals the vault key.
  await setupSecureRuntimeSecrets()
  Object.assign(calls, { available: 0, encrypt: 0, decrypt: 0, async: 0 })

  // A later launch opens it: that is the one read, so a Mac build without a Developer ID asks at most once.
  await setupSecureRuntimeSecrets()
  expect(calls).toEqual({ available: 1, encrypt: 0, decrypt: 1, async: 0 })
  expect(vaultSecrets.available()).toBe(true)

  const tokens = Array.from({ length: 20 }, (_, index) => `placeholder-token-${index}`)
  const sealed = tokens.map((token) => vaultSecrets.seal(token, "github-token"))
  expect(await Promise.all(sealed.map(async (value) => (await vaultSecrets.open(value, "github-token")).text))).toEqual(
    tokens,
  )
  expect(sealed.map((value) => vaultSecrets.openSync(value, "github-token").text)).toEqual(tokens)
  expect(calls).toEqual({ available: 1, encrypt: 0, decrypt: 1, async: 0 })
})

test("keeps sign-ins out of a vault no OS credential store protects", async () => {
  await setupSecureRuntimeSecrets()
  expect(vaultSecrets.available()).toBe(true)

  // A development build without a keychain keeps a plain key file, which must not guard sign-ins.
  electronMock.app.isPackaged = false
  encryptionAvailable = false
  await rm(join(userDataPath, "secure-runtime"), { recursive: true, force: true })
  await setupSecureRuntimeSecrets()

  expect(process.env.VECTOR_CREDENTIAL_KEY).toBeDefined()
  expect(vaultSecrets.available()).toBe(false)
  expect(() => vaultSecrets.seal("placeholder-token", "github-token")).toThrow("not open")
})

test("fails closed in packaged builds without OS-backed secure storage", async () => {
  setPlatform("linux")
  encryptionAvailable = false

  await expect(setupSecureRuntimeSecrets()).rejects.toThrow("no OS-backed secure storage")
  expect(process.env.VECTOR_CREDENTIAL_KEY).toBeUndefined()
  expect(process.env.VECTOR_MCP_AUTH_KEY).toBeUndefined()
})

test("tells macOS users to allow Keychain access instead of blaming the system", async () => {
  setPlatform("darwin")
  encryptionAvailable = false

  const error = await setupSecureRuntimeSecrets().catch((cause) => cause)

  expect(error.message).toContain("Always Allow")
  expect(error.message).not.toContain("no OS-backed secure storage")
  expect(process.env.VECTOR_CREDENTIAL_KEY).toBeUndefined()
  expect(process.env.VECTOR_MCP_AUTH_KEY).toBeUndefined()
})

test("explains OS credential-store access failures while sealing the key", async () => {
  const key = Buffer.alloc(32, 7).toString("base64")
  const directory = join(userDataPath, "secure-runtime")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "credential-key.v1"), `${key}\n`)
  encryptFailure = new Error("The user denied Keychain access")

  const error = await setupSecureRuntimeSecrets().catch((cause) => cause)

  expect(error).toBeInstanceOf(Error)
  expect(error.message).toContain("could not access the operating system's secure credential store")
  expect(error.cause).toBe(encryptFailure)
  expect(await readFile(join(directory, "credential-key.v1"), "utf8")).toBe(`${key}\n`)
  expect(process.env.VECTOR_CREDENTIAL_KEY).toBeUndefined()
  expect(process.env.VECTOR_MCP_AUTH_KEY).toBeUndefined()
})

test("explains OS credential-store access failures while opening the key", async () => {
  await setupSecureRuntimeSecrets()
  decryptFailure = new Error("The user denied Keychain access")
  delete process.env.VECTOR_CREDENTIAL_KEY
  delete process.env.VECTOR_MCP_AUTH_KEY

  const error = await setupSecureRuntimeSecrets().catch((cause) => cause)

  expect(error).toBeInstanceOf(Error)
  expect(error.message).toContain("could not access the operating system's secure credential store")
  expect(error.cause).toBe(decryptFailure)
  expect(process.env.VECTOR_CREDENTIAL_KEY).toBeUndefined()
  expect(process.env.VECTOR_MCP_AUTH_KEY).toBeUndefined()
})
