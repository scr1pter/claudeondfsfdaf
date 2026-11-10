import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "vector-vault-sign-ins-"))
// Every call that can reach the OS credential store. Earlier releases sealed GitLab tokens with the synchronous
// provider ("sync:") and GitHub and Vector account tokens with the asynchronous one when it was available ("async:").
const calls = { sync: 0, asyncAvailable: 0, async: 0, seal: 0 }
const electronMock = {
  app: { getPath: () => home, isPackaged: false },
  shell: { openExternal: async () => {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => {
      calls.seal++
      return Buffer.from(`sync:${value}`)
    },
    decryptString: (value: Buffer) => {
      calls.sync++
      const text = value.toString()
      if (!text.startsWith("sync:")) throw new Error("The synchronous provider did not seal this")
      return text.slice("sync:".length)
    },
    isAsyncEncryptionAvailable: async () => {
      calls.asyncAvailable++
      return true
    },
    encryptStringAsync: async (value: string) => {
      calls.seal++
      return Buffer.from(`async:${value}`)
    },
    decryptStringAsync: async (value: Buffer) => {
      calls.async++
      return { shouldReEncrypt: false, result: value.toString().replace(/^async:/, "") }
    },
  },
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))
// The billing window pulls in logging and Chromium sessions; account tokens never reach it.
mock.module("./billing-window", () => ({
  focusBillingWindow: () => {},
  isBillingWindow: () => false,
  openBillingWindow: async () => ({ outcome: "closed" }),
}))

const { vaultSecrets } = await import("./vault-secrets")
const { getStore } = await import("./store")
const { getGithubToken } = await import("./github-auth")
const { getGitlabToken } = await import("./gitlab-auth")
const { vectorAccount } = await import("./vector-account-runtime")
const sealedBy = (provider: "sync" | "async", text: string) => Buffer.from(`${provider}:${text}`).toString("base64")

afterAll(() => rmSync(home, { recursive: true, force: true }))

beforeEach(() => {
  // What secure-runtime.ts does once per launch, after its one read of the credential store.
  vaultSecrets.setKey(randomBytes(32))
  Object.assign(calls, { sync: 0, asyncAvailable: 0, async: 0, seal: 0 })
})

describe("sign-ins in the vault", () => {
  test("tokens an earlier release sealed with the keychain move into the vault the first time they are read", async () => {
    getStore("github-auth").set("token", sealedBy("async", "placeholder-github"))
    getStore("gitlab-auth").set("token", sealedBy("sync", "placeholder-gitlab"))
    getStore("vector-account").set("account", {
      ciphertext: sealedBy("async", "placeholder-account"),
      email: "person@example.test",
      expiresAt: Date.now() + 3_600_000,
    })

    expect(await getGithubToken()).toBe("placeholder-github")
    expect(getGitlabToken()).toBe("placeholder-gitlab")
    expect(await vectorAccount.token()).toBe("placeholder-account")
    // The asynchronous provider, a separate read of the credential store, was asked once for both of its tokens.
    expect(calls).toEqual({ sync: 3, asyncAvailable: 1, async: 2, seal: 0 })

    const github = getStore("github-auth").get("token")
    const gitlab = getStore("gitlab-auth").get("token")
    const account = getStore("vector-account").get("account") as { ciphertext: string; email: string }
    expect([github, gitlab, account.ciphertext].every((value) => String(value).startsWith("vs1."))).toBe(true)
    expect(account.email).toBe("person@example.test")

    // Every later read, in this launch or the next, stays in memory.
    for (let read = 0; read < 5; read++) {
      expect(await getGithubToken()).toBe("placeholder-github")
      expect(getGitlabToken()).toBe("placeholder-gitlab")
      expect(await vectorAccount.token()).toBe("placeholder-account")
    }
    expect(calls).toEqual({ sync: 3, asyncAvailable: 1, async: 2, seal: 0 })
  })

  test("a GitHub sign-in made while an earlier release's token was being read is kept", async () => {
    getStore("github-auth").set("token", sealedBy("async", "placeholder-old"))
    const reading = getGithubToken()
    const newer = vaultSecrets.seal("placeholder-new", "github-token")
    getStore("github-auth").set("token", newer)

    expect(await reading).toBe("placeholder-old")
    expect(getStore("github-auth").get("token")).toBe(newer)
    expect(await getGithubToken()).toBe("placeholder-new")
  })

  test("a token that no longer opens signs the person out instead of asking again", async () => {
    getStore("gitlab-auth").set("token", vaultSecrets.seal("placeholder-gitlab", "gitlab-token"))
    // The vault key changed, as when its file was removed.
    vaultSecrets.setKey(randomBytes(32))

    expect(getGitlabToken()).toBeUndefined()
    expect(getStore("gitlab-auth").get("token")).toBeUndefined()
    expect(calls).toEqual({ sync: 0, asyncAvailable: 0, async: 0, seal: 0 })
  })

  test("without a vault nothing is read, so a later launch with one still has the token", async () => {
    getStore("github-auth").set("token", sealedBy("sync", "placeholder-github"))
    vaultSecrets.setKey(undefined)

    expect(await getGithubToken()).toBeUndefined()
    expect(getStore("github-auth").get("token")).toBe(sealedBy("sync", "placeholder-github"))
    expect(calls).toEqual({ sync: 0, asyncAvailable: 0, async: 0, seal: 0 })
  })
})
