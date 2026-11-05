import { describe, expect, test } from "bun:test"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import type { VaultRestoreResult, VaultStatus, VaultVersions } from "@/context/platform"
import {
  BACKUP_TAB,
  GITHUB_COPY,
  RECOVERY_COPY,
  bytes,
  lastLine,
  nextLine,
  placeLine,
  readOnlyLine,
  repoValid,
  restoreLine,
  usageLine,
  vectorCopy,
  vectorOffer,
} from "./memory-backup-model"
import { MEMORY_TABS } from "./memory-model"
import { filterSettingsGroups } from "./settings-registry"

// WP A45: Settings → Memory → Backup. Brain Vault on Vector is offered only for a listed vault with storage (H1), its
// numbers come from the plan's entitlements, and the GitHub backend is always there.

const status = (fields: Partial<ModelPlanStatus.Status>) =>
  ({
    signedIn: true,
    enabled: true,
    access: true,
    purchased: { bought: false },
    empty: false,
    low: false,
    ...fields,
  }) as ModelPlanStatus.Status
const vault = (fields: Partial<VaultStatus> = {}): VaultStatus => ({
  secure: true,
  enabled: false,
  backend: "github",
  hasVault: false,
  ...fields,
})
const NOW = new Date(2026, 10, 4, 12, 0).getTime()

describe("Settings → Memory → Backup", () => {
  test("is a tab after Memory's own, found by searching for backups", () => {
    expect(BACKUP_TAB).toEqual({ value: "backup", label: "Backup" })
    expect(MEMORY_TABS.map((item) => item.value)).not.toContain("backup")
    for (const query of ["backup", "brain vault", "restore", "recovery code"])
      expect(filterSettingsGroups(query).flatMap((group) => group.items.map((item) => item.value))).toEqual(["memory"])
  })

  test("offers Brain Vault on Vector only for a listed vault with storage (H1)", () => {
    expect(vectorOffer(status({ listed: ["vault"], entitlements: { vault: { gb: 25, versionDays: 30 } } }))).toEqual({
      gb: 25,
      versionDays: 30,
    })
    expect(vectorOffer(status({ listed: [], entitlements: { vault: { gb: 25 } } }))).toBeUndefined()
    expect(vectorOffer(status({ listed: ["vault"], entitlements: { vault: { gb: 0 } } }))).toBeUndefined()
    expect(vectorOffer(status({ listed: ["vault"], entitlements: { vault: { gb: 10 } }, error: "x" }))).toBeUndefined()
    expect(vectorOffer(undefined)).toBeUndefined()
  })

  test("takes the plan's storage and version days from its entitlements, and names no amount", () => {
    expect(vectorCopy({ gb: 50, versionDays: 30 })).toContain("up to 50 GB and 30 days of versions")
    expect(vectorCopy(undefined)).not.toMatch(/\d/)
    for (const copy of [GITHUB_COPY, RECOVERY_COPY, vectorCopy({ gb: 10, versionDays: 30 })]) {
      expect(copy).not.toMatch(/\$|credit|token|price/i)
      expect(copy).not.toMatch(/guaranteed|exclusive|24\/7/i)
    }
    expect(GITHUB_COPY).toContain("7 newest versions")
  })

  test("says where backups go, the last one, and when the next runs", () => {
    expect(placeLine(vault())).toContain("Choose a private GitHub repository")
    expect(placeLine(vault({ githubRepo: "octo/brain-vault" }))).toContain("octo/brain-vault")
    expect(placeLine(vault({ backend: "vector" }))).toBe("Backups go to Brain Vault on Vector.")
    expect(lastLine(vault(), NOW)).toContain("recovery code")
    expect(lastLine(vault({ running: "backup" }), NOW)).toBe("Backing up…")
    expect(lastLine(vault({ last: { version: "v", at: NOW - 60_000, files: 2, sentBytes: 12_500 } }), NOW)).toMatch(
      /^Last backup today at .+: 2 memory files, 12\.5 KB sent\.$/,
    )
    expect(nextLine(vault(), NOW)).toBeUndefined()
    expect(nextLine(vault({ enabled: true }), NOW)).toBe("Nightly backups start after your first backup.")
    expect(nextLine(vault({ enabled: true, hasVault: true, nextAt: NOW }), NOW)).toBe("The next backup runs shortly.")
  })

  test("reads a restore, the storage used and a read-only vault", () => {
    const restored: VaultRestoreResult = {
      ok: true,
      message: "Restored 3 entries from the backup of 2026-11-04 03:00 UTC.",
      status: vault(),
      totals: {
        restored: 3,
        active: 2,
        pinned: 1,
        waiting: 1,
        known: 4,
        refused: 0,
        documents: 2,
        unreadable: 0,
        version: "v",
        newer: false,
      },
    }
    const line = restoreLine(restored)
    expect(line).toContain("2 in use (1 pinned), 1 waiting for your review as before, 4 already in memory.")
    expect(line).toContain("Documents are not part of a restore")
    expect(restoreLine({ ok: false, message: "Enter the recovery code.", status: vault(), needsCode: true })).toBe(
      "Enter the recovery code.",
    )
    const listing = (fields: object) =>
      ({ ok: true, label: "x", snapshots: [], mine: true, status: vault(), ...fields }) as VaultVersions
    expect(usageLine(listing({ usage: { usedBytes: 1_200_000_000, quotaBytes: 10_000_000_000 } }))).toBe(
      "Using 1.2 GB of 10.0 GB.",
    )
    expect(usageLine(listing({ storedBytes: 420 }))).toBe("The vault takes 420 B in the repository.")
    expect(readOnlyLine(listing({ readOnly: true }), NOW)).toContain("restoring still works")
    expect(readOnlyLine(listing({}), NOW)).toBeUndefined()
  })

  test("checks a repository's name the way GitHub writes it", () => {
    expect(repoValid("octo/brain-vault")).toBe(true)
    expect(repoValid(" octo/brain.vault ")).toBe(true)
    for (const bad of ["octo", "octo/", "/vault", "octo/vault.git", "octo/..", "-octo/vault", "octo/a/b"])
      expect(repoValid(bad)).toBe(false)
    expect(bytes(999)).toBe("999 B")
    expect(bytes(1_000_000_000)).toBe("1.0 GB")
  })
})
