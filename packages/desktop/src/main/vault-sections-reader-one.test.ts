import { expect, mock, test } from "bun:test"
import type { KeyRecord, MemoryFile, RestoreCounts, VaultSettings } from "./vault-backup"

// Track B B10 acceptance: what a main-built desktop (a reader of version 1, from before B10) does with a backup that
// holds learned sections. That build is this code with the two reader-side constants commit 3b1ce6d5 changed put back:
// READER 1 and SECTIONS ["memory"]. The writer's MIN_READER and LEARNED_READER stay as they are, so the backups below
// are a current build's bytes. The schema is replaced before anything that reads it loads, and only in this file:
// every desktop test file runs in a process of its own (packages/desktop/scripts/test.ts, the Codium CI picker).
//
// minReader is the whole version's gate, in the header its tag binds (core vault/format.ts), so an older reader
// refuses a learned backup whole, memory included, with "update Vector", rather than restore part of it silently. It
// still restores a memory-only backup, which asks for reader 1.

const actual = { ...(await import("@vectordevai/schema/vault")).Vault }
mock.module("@vectordevai/schema/vault", () => ({ Vault: { ...actual, READER: 1, SECTIONS: ["memory"] } }))
const { Vault } = await import("@vectordevai/schema/vault")
const { VaultStore } = await import("@vectordevai/core/vault/store")
const { createVaultBackup } = await import("./vault-backup")

const UPDATE = "This backup was made by a newer version of Vector. Update Vector to restore it."
const memory: MemoryFile = {
  path: "memory/personal.json",
  text: '{"format":"vector-memory","version":1,"scope":"personal","exportedAt":1,"entries":[],"documents":[]}',
  repository: "",
}
const skills: MemoryFile = {
  path: "skills/repository-0123456789abcdef01234567.json",
  section: "skills",
  text: '{"format":"vector-memory","version":1,"scope":"repository","exportedAt":1,"entries":[],"documents":[],"skills":[]}',
  repository: "prj_a",
  worktree: "/repo",
}
const COUNTS: RestoreCounts = { restored: 1, active: 1, pinned: 0, waiting: 0, known: 0, refused: 0, documents: 0 }

test("a version-1 reader refuses a backup with learned sections whole, with Update Vector, and restores a memory-only one", async () => {
  expect([Vault.READER, Vault.SECTIONS, Vault.LEARNED_READER]).toEqual([1, ["memory"], 2])
  const state: { settings: Partial<VaultSettings>; record?: KeyRecord; files: MemoryFile[] } = {
    settings: { backend: "github", githubRepo: "octo/brain-vault" },
    files: [memory, skills],
  }
  const restored: MemoryFile[] = []
  const github = VaultStore.memory({ keep: 7, label: "your GitHub repository octo/brain-vault" })
  const backup = createVaultBackup({
    cost: 2 ** 14,
    settings: { read: () => state.settings, write: (next) => void (state.settings = JSON.parse(JSON.stringify(next))) },
    keys: {
      secure: () => true,
      read: async () => state.record,
      write: async (next) => void (state.record = next),
      clear: async () => void (state.record = undefined),
    },
    memory: async () => state.files,
    restore: async (file) => {
      restored.push(file)
      return COUNTS
    },
    githubStore: () => github,
    vectorStore: () => {
      throw new Error("Brain Vault on Vector is not used here")
    },
    token: async () => undefined,
    codium: async () => ({}),
  })

  expect((await backup.backup()).ok).toBe(true)
  const learned = await backup.restore()
  expect([learned.ok, learned.message, learned.totals]).toEqual([false, UPDATE, undefined])
  expect(restored).toEqual([])

  state.files = [memory]
  expect((await backup.backup()).ok).toBe(true)
  const plain = await backup.restore()
  expect(plain.ok).toBe(true)
  expect(plain.totals).toMatchObject({ restored: 1, active: 1, skills: 0, insights: 0, unreadable: 0, newer: false })
  expect(restored).toEqual([{ ...memory, section: "memory" }])
})
