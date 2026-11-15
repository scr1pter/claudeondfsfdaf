import { describe, expect, test } from "bun:test"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { VaultCrypto } from "@vectordevai/core/vault/crypto"
import { VaultError } from "@vectordevai/core/vault/error"
import { VaultFormat } from "@vectordevai/core/vault/format"
import { VaultStore } from "@vectordevai/core/vault/store"
import { VaultBackup } from "@vectordevai/core/vault/vault"
import { Vault } from "@vectordevai/schema/vault"
import {
  createVaultBackup,
  due,
  nextDue,
  NIGHT,
  restoreParts,
  vectorOffered,
  type KeyRecord,
  type MemoryFile,
  type RestoreCounts,
  type VaultDeps,
  type VaultSettings,
} from "./vault-backup"

// WP A45: the desktop's Brain Vault controller. The first backup creates the vault and answers its recovery code once;
// the nightly backup never does. Vector's backend is used only while the account's status lists `vault` with storage
// (H1); a restore opens the vault with this computer's key or the recovery code and puts memory back through the
// engine, file by file.

const HOUR = 60 * 60_000
const T0 = Date.UTC(2026, 10, 4, 12)
const memoryFile = (
  text = '{"format":"vector-memory","version":1,"scope":"personal","exportedAt":1,"entries":[],"documents":[]}',
): MemoryFile => ({
  path: "memory/personal.json",
  text,
  repository: "",
})
const COUNTS: RestoreCounts = { restored: 1, active: 1, pinned: 0, waiting: 0, known: 0, refused: 0, documents: 0 }

function harness(
  input: Omit<Partial<VaultDeps>, "settings"> & { settings?: Partial<VaultSettings>; listed?: boolean } = {},
) {
  const { settings: initial, listed, ...overrides } = input
  let settings: Partial<VaultSettings> = { backend: "github", githubRepo: "octo/brain-vault", ...initial }
  let record: KeyRecord | undefined
  let secure = true
  const calls: string[] = []
  const restored: MemoryFile[] = []
  const github = VaultStore.memory({ keep: 7, label: "your GitHub repository octo/brain-vault" })
  const vector = VaultStore.memory({ label: "Brain Vault on Vector" })
  let time = T0
  const deps: VaultDeps = {
    cost: 2 ** 14,
    settings: { read: () => settings, write: (next) => void (settings = JSON.parse(JSON.stringify(next))) },
    keys: {
      secure: () => secure,
      read: async () => record,
      write: async (next) => {
        calls.push("key written")
        record = next
      },
      clear: async () => {
        calls.push("key cleared")
        record = undefined
      },
    },
    memory: async () => {
      calls.push("memory read")
      return [memoryFile()]
    },
    restore: async (file) => {
      restored.push(file)
      return COUNTS
    },
    githubStore: () => {
      calls.push("github store")
      return github
    },
    vectorStore: (token) => {
      calls.push(`vector store ${token}`)
      return vector
    },
    token: async () => {
      calls.push("token")
      return "vct_test"
    },
    codium: async () => {
      calls.push("status")
      return {
        signedIn: true,
        listed: listed === false ? [] : ["vault"],
        entitlements: { vault: { gb: 10, versionDays: 30 } },
      } as unknown as ModelPlanStatus.Status
    },
    now: () => time,
    hour: (at) => new Date(at).getUTCHours(),
    ...overrides,
  }
  return {
    backup: createVaultBackup(deps),
    calls,
    restored,
    github,
    vector,
    settings: () => settings,
    record: () => record,
    setRecord: (next: KeyRecord | undefined) => void (record = next),
    setSecure: (next: boolean) => void (secure = next),
    advance: (ms: number) => void (time += ms),
    at: (next: number) => void (time = next),
  }
}

describe("the nightly schedule", () => {
  const night = Date.UTC(2026, 10, 5, NIGHT.from)
  const hourOf = (at: number) => new Date(at).getUTCHours()

  test("runs once in the small hours, and catches up after a day and a half", () => {
    const ready = {
      enabled: true,
      vault: "a".repeat(32),
      last: { version: "v", at: night - 22 * HOUR, files: 1, sentBytes: 1 },
    }
    expect(due(ready, night, hourOf(night))).toBe(true)
    expect(due(ready, night - 3 * HOUR, hourOf(night - 3 * HOUR))).toBe(false)
    expect(due({ ...ready, last: { ...ready.last, at: night - 2 * HOUR } }, night, hourOf(night))).toBe(false)
    expect(due({ ...ready, attemptAt: night - 10 * 60_000 }, night, hourOf(night))).toBe(false)
    const noon = night + 10 * HOUR
    expect(due({ ...ready, last: { ...ready.last, at: noon - 37 * HOUR } }, noon, hourOf(noon))).toBe(true)
    expect(
      due({ ...ready, last: { ...ready.last, at: noon - 37 * HOUR }, attemptAt: noon - HOUR }, noon, hourOf(noon)),
    ).toBe(false)
  })

  test("never runs while it is off or before the first backup", () => {
    expect(due({ enabled: false, vault: "a".repeat(32) }, T0, NIGHT.from)).toBe(false)
    expect(due({ enabled: true }, T0, NIGHT.from)).toBe(false)
    expect(nextDue({ enabled: true }, T0, 12)).toBeUndefined()
    const next = nextDue(
      { enabled: true, vault: "a".repeat(32), last: { version: "v", at: T0, files: 1, sentBytes: 1 } },
      T0,
      12,
    )
    expect(next).toBe(T0 + 20 * HOUR)
  })

  test("the scheduler's tick never creates a vault", async () => {
    const run = harness({ settings: { enabled: true, vault: "a".repeat(32) } })
    run.at(Date.UTC(2026, 10, 5, NIGHT.from + 1))
    run.backup.check()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(run.calls).not.toContain("memory read")
    expect(run.calls).not.toContain("key written")
  })
})

describe("backing up", () => {
  test("the first backup creates the vault and answers its code once; the key is kept sealed, never the code", async () => {
    const run = harness()
    const first = await run.backup.backup()
    expect(first.ok).toBe(true)
    expect(first.code).toBeDefined()
    expect(run.record()?.vault).toBe(run.settings().vault!)
    expect(JSON.stringify(run.settings())).not.toContain(first.code!)
    expect(JSON.stringify(run.record())).not.toContain(first.code!)
    expect(run.settings().last?.files).toBe(1)
    const second = await run.backup.backup()
    expect(second.ok).toBe(true)
    expect(second.code).toBeUndefined()
    expect((await run.github.list()).snapshots).toHaveLength(2)
    // The code opens the vault on another computer.
    const opened = await VaultBackup.unlock(run.github, first.code!)
    expect(opened.vault).toBe(run.record()!.vault)
  })

  test("a backup that fails after the vault was made still answers the code", async () => {
    const store = VaultStore.memory({ keep: 7 })
    const run = harness({
      githubStore: () => ({
        ...store,
        // What core's GitHub store throws when git fails (its failed()).
        commit: async () => {
          throw new VaultError("unavailable", "git could not push to octo/brain-vault")
        },
      }),
    })
    const result = await run.backup.backup()
    expect(result.ok).toBe(false)
    expect(result.code).toBeDefined()
    expect(result.message).toContain("git could not push")
    expect(run.settings().error).toContain("git could not push")
    expect(run.record()).toBeDefined()
  })

  test("nothing in memory makes no vault and shows no code", async () => {
    const run = harness({ memory: async () => [] })
    const result = await run.backup.backup()
    expect(result.ok).toBe(true)
    expect(result.code).toBeUndefined()
    expect(run.record()).toBeUndefined()
  })

  test("without a secure credential store no vault is made", async () => {
    const run = harness()
    const result = await run.backup.backup({})
    expect(result.ok).toBe(true)
    const insecure = harness({
      keys: {
        secure: () => false,
        read: async () => undefined,
        write: async () => undefined,
        clear: async () => undefined,
      },
    })
    const refused = await insecure.backup.backup()
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain("credential store")
    expect(insecure.calls).not.toContain("memory read")
  })

  test("Vector's backend is used only while the status lists vault with storage (H1)", async () => {
    const unlisted = harness({ settings: { backend: "vector" }, listed: false })
    const refused = await unlisted.backup.backup()
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain("not available on this account")
    expect(unlisted.calls.some((call) => call.startsWith("vector store"))).toBe(false)
    expect(unlisted.calls).not.toContain("memory read")

    const listed = harness({ settings: { backend: "vector" } })
    expect((await listed.backup.backup()).ok).toBe(true)
    expect(listed.calls).toContain("vector store vct_test")
    expect(listed.calls).not.toContain("github store")

    const signedOut = harness({ settings: { backend: "vector" }, token: async () => undefined })
    expect((await signedOut.backup.backup()).message).toContain("Sign in to Vector")
  })

  test("the GitHub backend asks for no sign-in and no status", async () => {
    const run = harness()
    await run.backup.backup()
    expect(run.calls).not.toContain("token")
    expect(run.calls).not.toContain("status")
  })

  test("Vector Local blocking the backend stops it before any store is made", async () => {
    const run = harness({ blocked: () => "Vector Local keeps Brain Vault off. Allow it in Vector Local." })
    const result = await run.backup.backup()
    expect(result.ok).toBe(false)
    expect(result.message).toStartWith("Vector Local keeps Brain Vault off.")
    expect(run.calls).not.toContain("github store")
  })

  test("an unexpected failure shows plain copy, never its own text, and logs nothing more", async () => {
    const logs: unknown[][] = []
    const failing = VaultStore.memory({ keep: 7 })
    const run = harness({
      githubStore: () => ({
        ...failing,
        readKey: async () => {
          throw Object.assign(
            new Error(
              "EACCES: permission denied, mkdir '/Users/someone/Library/Application Support/Vector/vault-cache'",
            ),
            { code: "EACCES" },
          )
        },
      }),
      log: (message, meta) => void logs.push([message, meta]),
    })
    const backedUp = await run.backup.backup()
    expect(backedUp.ok).toBe(false)
    expect(backedUp.message).toBe("Brain Vault could not finish the backup. Try again.")
    expect(JSON.stringify(run.settings())).not.toContain("/Users/")
    const listed = await run.backup.versions()
    expect(listed.ok ? "" : listed.message).toBe("Brain Vault could not list the backups. Try again.")
    expect((await run.backup.restore()).message).toBe("Brain Vault could not restore this backup. Try again.")
    expect((await run.backup.forget("v1800000000000-0123abcd")).message).toBe(
      "Brain Vault could not forget that version. Try again.",
    )
    expect((await run.backup.remove()).message).toBe("Brain Vault could not delete the vault. Try again.")
    expect(logs).toEqual([["brain vault backup failed", { nightly: false }]])
  })

  test("learned sections keep their section and ask for reader two; they restore whole", async () => {
    const skills = JSON.stringify({ format: "vector-memory", version: 1, scope: "repository", skills: [{ id: "s1" }] })
    const files: MemoryFile[] = [
      memoryFile(),
      { path: "skills/repository-a.json", section: "skills", text: skills, repository: "prj_a", worktree: "/repo" },
    ]
    const run = harness({ memory: async () => files })
    expect((await run.backup.backup()).ok).toBe(true)
    const opened = { vault: run.record()!.vault, vaultKey: VaultCrypto.fromBase64Url(run.record()!.key) }
    const read = await VaultBackup.read({ store: run.github, opened })
    expect(read.manifest.minReader).toBe(Vault.LEARNED_READER)
    expect(read.files.map((item) => item.file.section)).toEqual(["memory", "skills"])
    expect((await run.backup.restore()).ok).toBe(true)
    expect(run.restored.find((file) => file.section === "skills")).toEqual({ ...files[1]!, text: skills })

    const plain = harness()
    await plain.backup.backup()
    const own = { vault: plain.record()!.vault, vaultKey: VaultCrypto.fromBase64Url(plain.record()!.key) }
    expect((await VaultBackup.read({ store: plain.github, opened: own })).manifest.minReader).toBe(Vault.MIN_READER)
  })

  test("one operation at a time", async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const run = harness({
      memory: async () => {
        await gate
        return [memoryFile()]
      },
    })
    const first = run.backup.backup()
    expect(run.backup.status().running).toBe("backup")
    const second = await run.backup.backup()
    expect(second.ok).toBe(false)
    expect(second.message).toContain("busy")
    release()
    expect((await first).ok).toBe(true)
    expect(run.backup.status().running).toBeUndefined()
  })
})

describe("restoring, forgetting and deleting", () => {
  test("this computer's key restores each memory file through the engine", async () => {
    const run = harness()
    await run.backup.backup()
    const result = await run.backup.restore()
    expect(result.ok).toBe(true)
    expect(result.totals?.restored).toBe(1)
    expect(run.restored).toHaveLength(1)
    expect(run.restored[0]!.repository).toBe("")
  })

  test("another computer's vault needs its recovery code, and is kept here afterwards", async () => {
    const first = harness()
    const made = await first.backup.backup()
    const other = harness({ githubStore: () => first.github })
    const asked = await other.backup.restore()
    expect(asked.ok).toBe(false)
    expect(asked.needsCode).toBe(true)
    const wrong = await other.backup.restore({ code: "0000-0000-0000-0000-0000-0000-0000" })
    expect(wrong.ok).toBe(false)
    const restored = await other.backup.restore({ code: made.code! })
    expect(restored.ok).toBe(true)
    expect(other.record()?.vault).toBe(first.record()!.vault)
    expect(other.settings().vault).toBe(first.record()!.vault)
  })

  test("a version that needs a newer Vector is refused with Update Vector, and nothing is restored", async () => {
    const run = harness()
    await run.backup.backup()
    const record = run.record()!
    const at = T0 + HOUR
    const version = VaultCrypto.versionId(at)
    const sealed = VaultFormat.sealManifest(VaultCrypto.derive(VaultCrypto.fromBase64Url(record.key)), {
      format: "vector-vault",
      version: 1,
      minReader: Vault.READER + 1,
      vault: record.vault,
      id: version,
      createdAt: at,
      files: [],
      objects: [],
    })
    await run.github.prepare(version, [])
    await run.github.commit(version, sealed, [])
    const result = await run.backup.restore({ version })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("Update Vector")
    expect(run.restored).toEqual([])
  })

  test("a key that no longer opens: a backup makes no second vault, the code restores it, and Delete clears this computer", async () => {
    const run = harness()
    const made = await run.backup.backup()
    const wrapped = await run.github.readKey()
    // What the runtime's key store reads for a record this launch cannot open.
    run.setRecord(undefined)

    const refused = await run.backup.backup()
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain("already holds a vault")
    expect(refused.code).toBeUndefined()
    expect(await run.github.readKey()).toEqual(wrapped)
    const listed = await run.backup.versions()
    expect(listed.ok && listed.mine).toBe(false)

    const restored = await run.backup.restore({ code: made.code! })
    expect(restored.ok).toBe(true)
    expect(run.record()?.vault).toBe(wrapped!.vault)

    run.setRecord(undefined)
    const removed = await run.backup.remove()
    expect(removed.ok).toBe(true)
    expect(run.calls).toContain("key cleared")
    expect(run.settings().vault).toBeUndefined()
    expect(run.settings().last).toBeUndefined()
    expect(run.settings().enabled).toBe(false)
    expect(run.backup.status().nextAt).toBeUndefined()
    expect(await run.github.readKey()).toBeUndefined()
  })

  test("Delete while the credential store is locked keeps this computer's key; the settings forget only their own vault", async () => {
    const other = harness()
    await other.backup.backup()
    const mine = other.record()!
    // The place now holds another vault than the one this computer's key and settings name.
    await other.github.destroy()
    expect((await VaultBackup.create(other.github, { cost: 2 ** 14 })).vault).not.toBe(mine.vault)
    // What the runtime's key store reads while the OS credential store is locked: no record, though it is kept.
    other.setSecure(false)
    other.setRecord(undefined)
    const last = other.settings().last
    expect((await other.backup.remove()).ok).toBe(true)
    expect(await other.github.readKey()).toBeUndefined()
    expect(other.calls).not.toContain("key cleared")
    expect(other.settings().vault).toBe(mine.vault)
    expect(other.settings().last).toEqual(last)

    const own = harness()
    await own.backup.backup()
    own.setSecure(false)
    own.setRecord(undefined)
    expect((await own.backup.remove()).ok).toBe(true)
    expect(own.calls).not.toContain("key cleared")
    expect(own.settings().vault).toBeUndefined()
    expect(own.settings().last).toBeUndefined()
    expect(own.settings().enabled).toBe(false)
  })

  test("a restore file is sent without evidence or documents, in parts the engine takes", () => {
    const entries = Array.from({ length: 1201 }, (_, index) => ({
      id: `m${index}`,
      text: `entry ${index}`,
      evidence: [{ type: "user" }],
    }))
    const { parts, documents } = restoreParts(
      JSON.stringify({
        format: "vector-memory",
        version: 1,
        scope: "personal",
        exportedAt: 1,
        entries,
        documents: [{ id: "d1" }],
      }),
    )
    expect(documents).toBe(1)
    expect(parts).toHaveLength(3)
    const decoded = parts.map(
      (part) => JSON.parse(part) as { entries: { evidence: unknown[] }[]; documents: unknown[]; format: string },
    )
    expect(decoded.map((part) => part.entries.length)).toEqual([500, 500, 201])
    expect(decoded.every((part) => part.format === "vector-memory" && part.documents.length === 0)).toBe(true)
    expect(decoded.every((part) => part.entries.every((entry) => entry.evidence.length === 0))).toBe(true)
    expect(restoreParts("not json").parts).toEqual(["not json"])
  })

  test("forgetting a version and deleting the vault", async () => {
    const run = harness()
    await run.backup.backup()
    run.advance(1000)
    await run.backup.backup()
    const listed = await run.backup.versions()
    expect(listed.ok && listed.snapshots).toHaveLength(2)
    expect(listed.ok && listed.mine).toBe(true)
    const oldest = listed.ok ? listed.snapshots[1]!.id : ""
    expect((await run.backup.forget(oldest)).ok).toBe(true)
    expect((await run.github.list()).snapshots).toHaveLength(1)
    expect((await run.backup.forget("not-a-version")).ok).toBe(false)
    const removed = await run.backup.remove()
    expect(removed.ok).toBe(true)
    expect(run.record()).toBeUndefined()
    expect(run.settings().vault).toBeUndefined()
    expect(run.settings().enabled).toBe(false)
    expect(await run.github.readKey()).toBeUndefined()
  })

  test("where backups go cannot change while a backup runs", async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const run = harness({
      memory: async () => {
        await gate
        return [memoryFile()]
      },
    })
    const running = run.backup.backup()
    const moved = run.backup.configure({ githubRepo: "octo/other-vault" })
    expect(moved.ok).toBe(false)
    expect(moved.message).toContain("busy")
    expect(run.backup.configure({ backend: "vector" }).ok).toBe(false)
    expect(run.backup.configure({ enabled: true }).ok).toBe(true)
    release()
    expect((await running).ok).toBe(true)
    expect(run.settings().githubRepo).toBe("octo/brain-vault")
    expect(run.settings().enabled).toBe(true)
    expect(run.settings().last).toBeDefined()
    expect(run.backup.configure({ githubRepo: "octo/other-vault" }).ok).toBe(true)
    expect(run.settings().githubRepo).toBe("octo/other-vault")
    expect(run.settings().last).toBeUndefined()
  })

  test("settings take only owner/repo, and moving the backups starts a new place", () => {
    const run = harness()
    expect(run.backup.configure({ githubRepo: "not a repo" }).ok).toBe(false)
    expect(run.backup.configure({ githubRepo: "octo/other-vault", enabled: true }).ok).toBe(true)
    expect(run.settings().githubRepo).toBe("octo/other-vault")
    expect(run.settings().enabled).toBe(true)
    expect(run.backup.status().backend).toBe("github")
  })
})

test("Vector's backend is offered only for a listed vault with storage", () => {
  const status = (fields: object) => fields as unknown as ModelPlanStatus.Status
  expect(vectorOffered(status({ listed: ["vault"], entitlements: { vault: { gb: 10 } } }))).toBe(true)
  expect(vectorOffered(status({ listed: [], entitlements: { vault: { gb: 10 } } }))).toBe(false)
  expect(vectorOffered(status({ listed: ["vault"], entitlements: { vault: { gb: 0 } } }))).toBe(false)
  expect(vectorOffered(undefined)).toBe(false)
})
