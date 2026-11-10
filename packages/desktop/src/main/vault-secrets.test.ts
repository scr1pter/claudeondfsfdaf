import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { createVaultSecrets } from "./vault-secrets"

// A stand-in for Electron's safeStorage that counts every call. The synchronous provider opens only what it sealed
// ("sync:"); the asynchronous one reads the credential store on its own, so each of its calls is a separate prompt on
// a Mac build without a Developer ID signature.
function keychain(asyncAvailable = true) {
  const calls = { sync: 0, asyncAvailable: 0, async: 0 }
  const backend = {
    decryptString(encrypted: Buffer) {
      calls.sync++
      const text = encrypted.toString()
      if (!text.startsWith("sync:")) throw new Error("The synchronous provider did not seal this")
      return text.slice("sync:".length)
    },
    async isAsyncEncryptionAvailable() {
      calls.asyncAvailable++
      return asyncAvailable
    },
    async decryptStringAsync(encrypted: Buffer) {
      calls.async++
      return { result: encrypted.toString().replace(/^async:/, "") }
    },
  }
  return { calls, secrets: createVaultSecrets(() => backend) }
}

const sealedBy = (provider: "sync" | "async", text: string) => Buffer.from(`${provider}:${text}`).toString("base64")

describe("vault secrets", () => {
  test("once the vault is open, sealing and opening sign-ins never reaches the OS credential store", async () => {
    const { calls, secrets } = keychain()
    secrets.setKey(randomBytes(32))

    const tokens = Array.from({ length: 25 }, (_, index) => `placeholder-token-${index}`)
    for (const token of tokens) {
      const sealed = secrets.seal(token, "github-token")
      expect(sealed).not.toContain(token)
      expect(sealed.startsWith("vs1.")).toBe(true)
      expect(await secrets.open(sealed, "github-token")).toEqual({ text: token })
      expect(secrets.openSync(sealed, "github-token")).toEqual({ text: token })
    }
    expect(secrets.openSync(secrets.seal("", "gitlab-token"), "gitlab-token")).toEqual({ text: "" })

    expect(calls).toEqual({ sync: 0, asyncAvailable: 0, async: 0 })
  })

  test("seals nothing and opens nothing until the vault is open", async () => {
    const { calls, secrets } = keychain()
    expect(secrets.available()).toBe(false)
    expect(() => secrets.seal("placeholder-token", "github-token")).toThrow("credential vault is not open")
    expect(() => secrets.openSync(sealedBy("sync", "placeholder-token"), "gitlab-token")).toThrow("not open")
    await expect(secrets.open(sealedBy("async", "placeholder-token"), "github-token")).rejects.toThrow("not open")

    secrets.setKey(randomBytes(32))
    expect(secrets.available()).toBe(true)
    // A launch without an OS credential store keeps the vault shut.
    secrets.setKey(undefined)
    expect(secrets.available()).toBe(false)
    expect(calls).toEqual({ sync: 0, asyncAvailable: 0, async: 0 })
  })

  test("a sealed secret opens only for what it was sealed for, and only with the same vault key", () => {
    const key = randomBytes(32)
    const { secrets } = keychain()
    secrets.setKey(key)
    const sealed = secrets.seal("placeholder-password", "server-credential:https://engine.example.test")

    expect(() => secrets.openSync(sealed, "server-credential:https://other.example.test")).toThrow()
    const [iv, tag, data] = sealed.slice("vs1.".length).split(".")
    const tampered = Buffer.from(data!, "base64url")
    tampered[0] = tampered[0]! ^ 1
    expect(() => secrets.openSync(`vs1.${iv}.${tag}.${tampered.toString("base64url")}`, "github-token")).toThrow()
    expect(() => secrets.openSync(`vs1.${iv}.${tag!.slice(0, 8)}.${data}`, "github-token")).toThrow()
    expect(() => secrets.openSync(`${sealed}.extra`, "server-credential:https://engine.example.test")).toThrow("invalid")

    secrets.setKey(randomBytes(32))
    expect(() => secrets.openSync(sealed, "server-credential:https://engine.example.test")).toThrow()
    secrets.setKey(key)
    expect(secrets.openSync(sealed, "server-credential:https://engine.example.test").text).toBe("placeholder-password")
  })

  test("an earlier release's secret opens through the synchronous provider and comes back sealed in memory", async () => {
    const { calls, secrets } = keychain()
    secrets.setKey(randomBytes(32))

    const opened = secrets.openSync(sealedBy("sync", "placeholder-token"), "gitlab-token")
    expect(opened.text).toBe("placeholder-token")
    expect(opened.resealed?.startsWith("vs1.")).toBe(true)
    // The synchronous provider shares the read that opened the vault; the asynchronous one is never asked.
    const viaAsync = await secrets.open(sealedBy("sync", "placeholder-account"), "vector-account-token")
    expect(viaAsync.text).toBe("placeholder-account")
    expect(calls).toEqual({ sync: 2, asyncAvailable: 0, async: 0 })

    expect(secrets.openSync(opened.resealed!, "gitlab-token")).toEqual({ text: "placeholder-token" })
    expect(await secrets.open(viaAsync.resealed!, "vector-account-token")).toEqual({ text: "placeholder-account" })
    expect(calls).toEqual({ sync: 2, asyncAvailable: 0, async: 0 })
  })

  test("the asynchronous provider is asked once per launch, only for secrets the synchronous one cannot open", async () => {
    const { calls, secrets } = keychain()
    secrets.setKey(randomBytes(32))

    const [github, account] = await Promise.all([
      secrets.open(sealedBy("async", "placeholder-github"), "github-token"),
      secrets.open(sealedBy("async", "placeholder-account"), "vector-account-token"),
    ])
    expect(github.text).toBe("placeholder-github")
    expect(account.text).toBe("placeholder-account")
    await secrets.open(sealedBy("async", "placeholder-github"), "github-token")
    expect(calls).toEqual({ sync: 3, asyncAvailable: 1, async: 3 })

    // Stored back, they never reach either provider again.
    expect(await secrets.open(github.resealed!, "github-token")).toEqual({ text: "placeholder-github" })
    expect(await secrets.open(account.resealed!, "vector-account-token")).toEqual({ text: "placeholder-account" })
    expect(calls).toEqual({ sync: 3, asyncAvailable: 1, async: 3 })
  })

  test("a secret neither provider can open fails, so the caller can sign the person out", async () => {
    const { calls, secrets } = keychain(false)
    secrets.setKey(randomBytes(32))

    await expect(secrets.open(sealedBy("async", "placeholder-github"), "github-token")).rejects.toThrow(
      "The synchronous provider did not seal this",
    )
    expect(() => secrets.openSync(sealedBy("async", "placeholder-gitlab"), "gitlab-token")).toThrow()
    expect(calls).toEqual({ sync: 2, asyncAvailable: 1, async: 0 })
  })
})
