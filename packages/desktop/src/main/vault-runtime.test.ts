import { afterAll, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Brain Vault in the running app (WP A45). Until the engine is up the renderer reads a stand-in status; a page opened
// then must learn it is one, and every open window must get the real status once Brain Vault starts (R45-27).
const home = mkdtempSync(join(tmpdir(), "vector-vault-runtime-"))
const sent: [string, unknown][] = []
const window = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, status: unknown) => void sent.push([channel, status]) },
}
const electronMock = {
  app: { getPath: () => home, isPackaged: false },
  shell: { openExternal: async () => {} },
  BrowserWindow: { getAllWindows: () => [window], getFocusedWindow: () => null },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))
// The billing window pulls in logging and Chromium sessions; Brain Vault never reaches it.
mock.module("./billing-window", () => ({
  focusBillingWindow: () => {},
  isBillingWindow: () => false,
  openBillingWindow: async () => ({ outcome: "closed" }),
}))

const { startVault, stopVault, vaultBackup, vaultStarting } = await import("./vault-runtime")
const { getStore } = await import("./store")

afterAll(() => {
  stopVault()
  rmSync(home, { recursive: true, force: true })
})

test("before Brain Vault starts its status says so; once it starts, every open window gets its real status", () => {
  expect(vaultBackup()).toBeUndefined()
  expect(vaultStarting()).toEqual({
    secure: expect.any(Boolean),
    enabled: false,
    backend: "github",
    hasVault: false,
    starting: true,
  })
  getStore("vector-vault").set("settings", {
    enabled: true,
    backend: "github",
    githubRepo: "octo/brain-vault",
    vault: "vlt_test",
  })
  // start() only arms the nightly timers, so no engine request is made here; afterAll stops them.
  startVault({ engine: { url: "http://127.0.0.1:9", password: "test" }, log: () => {} })
  expect(sent).toHaveLength(1)
  expect(sent[0]![0]).toBe("vault-changed")
  expect(sent[0]![1]).toMatchObject({ enabled: true, githubRepo: "octo/brain-vault", hasVault: true })
  expect(sent[0]![1]).not.toHaveProperty("starting")
})
