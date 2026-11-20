import { afterAll, expect, mock, test } from "bun:test"
import type { ElectronAPI } from "../preload/types"

// The main window's preload, with Electron replaced: window.api.vault offers only what Settings → Memory → Backup
// calls, each on its own channel (WP A45, R45-28). The arguments are checked in the main process's handlers.
const invokes: unknown[][] = []
const listeners = new Map<string, Set<(event: unknown, value: unknown) => void>>()
const state: { api?: ElectronAPI } = {}
mock.module("electron", () => ({
  contextBridge: {
    exposeInMainWorld(name: string, api: ElectronAPI) {
      expect(name).toBe("api")
      state.api = api
    },
  },
  ipcRenderer: {
    invoke: async (...args: unknown[]) => void invokes.push(args),
    send: () => {},
    on(name: string, callback: (event: unknown, value: unknown) => void) {
      listeners.set(name, (listeners.get(name) ?? new Set()).add(callback))
    },
    removeListener(name: string, callback: (event: unknown, value: unknown) => void) {
      listeners.get(name)?.delete(callback)
    },
  },
  webUtils: { getPathForFile: () => "" },
}))
await import("../preload/index")
afterAll(() => mock.restore())

test("window.api.vault offers only the calls Settings → Memory → Backup makes, each on its own channel", async () => {
  const vault = state.api!.vault
  expect(Object.keys(vault).sort()).toEqual([
    "backup",
    "configure",
    "forget",
    "onChange",
    "remove",
    "restore",
    "status",
    "versions",
  ])
  await vault.status()
  await vault.configure({ backend: "github", githubRepo: "octo/brain-vault" })
  await vault.backup()
  await vault.versions()
  await vault.restore({ version: "v1762225200000-0123abcd", code: "code" })
  await vault.forget("v1762225200000-0123abcd")
  await vault.remove()
  expect(invokes).toEqual([
    ["vault-status"],
    ["vault-configure", { backend: "github", githubRepo: "octo/brain-vault" }],
    ["vault-backup"],
    ["vault-versions"],
    ["vault-restore", { version: "v1762225200000-0123abcd", code: "code" }],
    ["vault-forget", "v1762225200000-0123abcd"],
    ["vault-delete"],
  ])

  const seen: unknown[] = []
  const stop = vault.onChange((status) => seen.push(status))
  for (const listener of listeners.get("vault-changed") ?? []) listener({ sender: "ignored" }, { enabled: true })
  stop()
  for (const listener of listeners.get("vault-changed") ?? []) listener({}, { enabled: false })
  expect(seen).toEqual([{ enabled: true }])
  expect(listeners.get("vault-changed")?.size).toBe(0)
})
