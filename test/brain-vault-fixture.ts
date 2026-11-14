import { SQL } from "bun"
import { randomUUID } from "node:crypto"
import { presignSigV4 } from "../api/_lib/r2-presign"
import { roadmapFakes, ROADMAP_KV_URL } from "./roadmap-fixture"

// WP A44's fakes. Nothing here reaches a network: an unexpected address throws.
// - The store is `vector_brain_vault` (docs/vector/owner-actions/sql/brain-vault.sql). Locally an in-memory emulation of
//   that function answers; with VECTOR_TEST_POSTGRES_URL set (CI), the real SQL runs on a disposable Postgres, as the
//   service role, so every case also checks the SQL and its grants.
// - R2 is a bucket in memory that checks each presigned URL as R2 would: the SigV4 signature over the headers actually
//   sent (so a PUT must carry exactly the signed size), and the expiry.
// - The account service answers the admin user lookup; Resend records the emails.

export const SUPABASE_ORIGIN = "https://vault-db.supabase.invalid"
export const R2_ACCOUNT = "0123456789abcdef0123456789abcdef"
export const R2_ORIGIN = `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`
const R2_KEY_ID = "fixturevaultkey00001"
const R2_SECRET = "fixtureVaultSecretAccessKey0123456789abcdefXY"
export const SERVICE_ROLE = "fixture-service-role"

export const VAULT_ENVIRONMENT: Record<string, string | undefined> = {
  MODEL_PLANS_ENABLED: "true",
  CODIUM_LISTED_PERKS: "vault",
  VECTOR_VAULT_ENABLED: "true",
  VECTOR_VAULT_ACCOUNT_SALT: "fixture-vault-account-salt-".padEnd(48, "s"),
  SUPABASE_URL: SUPABASE_ORIGIN,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
  VECTOR_R2_ACCOUNT_ID: R2_ACCOUNT,
  VECTOR_R2_VAULT_ACCESS_KEY_ID: R2_KEY_ID,
  VECTOR_R2_VAULT_SECRET_ACCESS_KEY: R2_SECRET,
  VECTOR_R2_VAULT_BUCKET: undefined,
  RESEND_API_KEY: "re_fixture",
  RESEND_BASE_URL: undefined,
  VECTOR_PURCHASE_EMAIL_FROM: "Vector <vault@example.invalid>",
  CRON_SECRET: "fixture-vault-cron-secret",
  CODIUM_RENEWAL_GRACE_MINUTES: undefined,
}

// ── The store ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type BlobView = { kind: "object" | "manifest"; id: string; size: number; state: string }
export type VaultView = {
  vault: string
  wrappedKey: unknown
  deleting: boolean
  held: boolean
  noticeAt: number | null
  deleteAt: number | null
}

export interface VaultBackend {
  readonly real: boolean
  call(request: Record<string, unknown>): Promise<unknown>
  reset(): Promise<void>
  vaults(account: string): Promise<VaultView[]>
  blobs(account: string): Promise<BlobView[]>
  versions(account: string): Promise<{ id: string; committed: boolean; createdAt: number }[]>
  /** A stored, unreferenced object of `size` bytes in the account's open vault. */
  seedStored(account: string, size: number): Promise<string>
  /** Moves a version's creation time (for pruning by age). */
  age(account: string, version: string, createdAt: number): Promise<void>
  close(): Promise<void>
}

type VaultRow = {
  id: string
  mode: string
  account: string
  vault: string
  wrappedKey: unknown
  deleting: boolean
  held: boolean
  versionDays: number
  createdAt: number
  updatedAt: number
  noticeAt: number | null
  deleteAt: number | null
}
type VersionRow = {
  vaultId: string
  id: string
  committed: boolean
  createdAt: number
  touchedAt: number
  committedAt: number | null
  objects: number
  bytes: number
}
type BlobRow = {
  vaultId: string
  kind: "object" | "manifest"
  id: string
  size: number
  state: "pending" | "stored" | "trash" | "claimed"
  reservedUntil: number | null
  /** When the newest PUT link signed for it stops working; it is not deleted from R2 before. */
  signedUntil: number | null
  claimedAt: number | null
  updatedAt: number
}

const OBJECT = /^[0-9a-f]{64}$/
const VERSION = /^v[0-9]{13}-[0-9a-f]{8}$/
const LIVE = new Set(["pending", "stored"])

/**
 * The emulation of `public.vector_brain_vault`, statement by statement. Each call runs to completion before the next
 * starts, which is what the SQL's row locks give the real function.
 */
export class MemoryVaultBackend implements VaultBackend {
  readonly real = false
  vaultRows: VaultRow[] = []
  versionRows: VersionRow[] = []
  refRows: { vaultId: string; version: string; object: string }[] = []
  blobRows = new Map<string, BlobRow>()

  async reset() {
    this.vaultRows = []
    this.versionRows = []
    this.refRows = []
    this.blobRows.clear()
  }

  async close() {}

  private blob(vaultId: string, kind: string, id: string) {
    return this.blobRows.get(`${vaultId}|${kind}|${id}`)
  }

  private blobsOf(vaultId: string) {
    return [...this.blobRows.values()].filter((blob) => blob.vaultId === vaultId)
  }

  private open(mode: string, account: string) {
    return this.vaultRows.find((row) => row.mode === mode && row.account === account && !row.deleting)
  }

  private referenced(vaultId: string, object: string) {
    return this.refRows.some((ref) => ref.vaultId === vaultId && ref.object === object)
  }

  private dropVersion(vaultId: string, id: string) {
    this.versionRows = this.versionRows.filter((row) => !(row.vaultId === vaultId && row.id === id))
    this.refRows = this.refRows.filter((ref) => !(ref.vaultId === vaultId && ref.version === id))
  }

  private trash(blob: BlobRow, now: number) {
    blob.state = "trash"
    blob.reservedUntil = null
    blob.updatedAt = now
  }

  private destroy(row: VaultRow, now: number) {
    Object.assign(row, { deleting: true, wrappedKey: null, held: false, noticeAt: null, deleteAt: null, updatedAt: now })
    for (const version of this.versionRows.filter((item) => item.vaultId === row.id)) this.dropVersion(row.id, version.id)
    for (const blob of this.blobsOf(row.id)) if (LIVE.has(blob.state)) this.trash(blob, now)
    if (!this.blobsOf(row.id).length) this.vaultRows = this.vaultRows.filter((item) => item !== row)
  }

  private used(vaultId: string) {
    const live = this.blobsOf(vaultId).filter((blob) => LIVE.has(blob.state))
    return { bytes: live.reduce((sum, blob) => sum + blob.size, 0), count: live.length }
  }

  private snapshot(version: VersionRow) {
    return { id: version.id, createdAt: version.createdAt, bytes: version.bytes, objects: version.objects }
  }

  async call(request: Record<string, unknown>): Promise<unknown> {
    const r = request as Record<string, any>
    const invalid = { status: "invalid" }
    if (!["live", "test"].includes(r.mode) || typeof r.now !== "number") return invalid
    const now: number = r.now
    const mode: string = r.mode
    const account: string | undefined = r.account ?? undefined
    const version: string | undefined = r.version ?? undefined
    if (account !== undefined && !/^[a-f0-9]{64}$/.test(account)) return invalid
    if (version !== undefined && !VERSION.test(version)) return invalid

    if (r.action === "claim") {
      if (typeof r.staleMs !== "number") return invalid
      const limit = Math.min(Math.max(r.limit ?? 100, 1), 1000)
      const vaults = new Map(this.vaultRows.map((row) => [row.id, row]))
      const picked = [...this.blobRows.values()]
        .filter((blob) => {
          const row = vaults.get(blob.vaultId)
          return (
            row?.mode === mode &&
            (account === undefined || row.account === account) &&
            (blob.signedUntil ?? 0) < now &&
            (blob.state === "trash" || (blob.state === "claimed" && blob.claimedAt! < now - r.staleMs))
          )
        })
        .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit)
      for (const blob of picked) Object.assign(blob, { state: "claimed", claimedAt: now, updatedAt: now })
      return {
        status: "ok",
        items: picked.map((blob) => {
          const row = vaults.get(blob.vaultId)!
          return { vaultId: blob.vaultId, account: row.account, vault: row.vault, kind: blob.kind, id: blob.id }
        }),
        claimedAt: now,
      }
    }

    if (r.action === "purged") {
      if (!Array.isArray(r.items) || typeof r.claimedAt !== "number") return invalid
      let removed = 0
      for (const item of r.items) {
        const blob = this.blob(item.vaultId, item.kind, item.id)
        const row = this.vaultRows.find((vault) => vault.id === item.vaultId)
        if (blob?.state === "claimed" && blob.claimedAt === r.claimedAt && row?.mode === mode) {
          this.blobRows.delete(`${item.vaultId}|${item.kind}|${item.id}`)
          removed++
        }
      }
      this.vaultRows = this.vaultRows.filter((row) => !(row.mode === mode && row.deleting && !this.blobsOf(row.id).length))
      return { status: "ok", removed }
    }

    if (r.action === "cleanup") {
      if (typeof r.uncommittedMs !== "number") return invalid
      const limit = Math.min(Math.max(r.limit ?? 50, 1), 500)
      const cursor: string | undefined = typeof r.cursor === "string" ? r.cursor : undefined
      const totals = { vaults: 0, lapsed: 0, uncommitted: 0, expired: 0, pruned: 0, collected: 0 }
      let last: string | undefined = cursor
      const batch = this.vaultRows
        .filter((row) => row.mode === mode && !row.deleting && (cursor === undefined || row.id > cursor))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit)
      for (const row of batch) {
        totals.vaults++
        last = row.id
        if (!row.held && row.noticeAt !== null && row.deleteAt !== null && row.deleteAt <= now) {
          this.destroy(row, now)
          totals.lapsed++
          continue
        }
        for (const old of this.versionRows.filter(
          (item) => item.vaultId === row.id && !item.committed && item.touchedAt < now - r.uncommittedMs,
        )) {
          this.dropVersion(row.id, old.id)
          const manifest = this.blob(row.id, "manifest", old.id)
          if (manifest && LIVE.has(manifest.state)) this.trash(manifest, now)
          totals.uncommitted++
        }
        for (const blob of this.blobsOf(row.id)) {
          if (blob.state !== "pending" || blob.reservedUntil === null || blob.reservedUntil >= now) continue
          const unnamed =
            blob.kind === "object"
              ? !this.referenced(row.id, blob.id)
              : !this.versionRows.some((item) => item.vaultId === row.id && item.id === blob.id)
          if (unnamed) {
            this.trash(blob, now)
            totals.expired++
          }
        }
        if (row.held) continue
        const committed = this.versionRows
          .filter((item) => item.vaultId === row.id && item.committed)
          .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        for (const old of committed.slice(1).filter((item) => item.createdAt < now - row.versionDays * 86_400_000)) {
          this.dropVersion(row.id, old.id)
          const manifest = this.blob(row.id, "manifest", old.id)
          if (manifest && LIVE.has(manifest.state)) this.trash(manifest, now)
          totals.pruned++
        }
        for (const blob of this.blobsOf(row.id)) {
          if (blob.state !== "stored") continue
          const unnamed =
            blob.kind === "object"
              ? !this.referenced(row.id, blob.id)
              : !this.versionRows.some((item) => item.vaultId === row.id && item.id === blob.id)
          if (unnamed) {
            this.trash(blob, now)
            totals.collected++
          }
        }
      }
      return { status: "ok", ...totals, cursor: totals.vaults < limit ? null : last }
    }

    if (account === undefined) return invalid

    if (r.action === "setup") {
      if (typeof r.vault !== "string" || !/^[a-f0-9]{32}$/.test(r.vault) || !r.key || typeof r.key !== "object")
        return invalid
      if (typeof r.versionDays !== "number") return invalid
      const found = this.open(mode, account)
      if (found)
        return found.vault === r.vault
          ? { status: "ok", vault: found.vault, key: found.wrappedKey, createdAt: found.createdAt }
          : { status: "exists" }
      if (this.vaultRows.some((row) => row.mode === mode && row.account === account && row.vault === r.vault))
        return { status: "exists" }
      const row: VaultRow = {
        id: randomUUID(),
        mode,
        account,
        vault: r.vault,
        wrappedKey: r.key,
        deleting: false,
        held: false,
        versionDays: r.versionDays,
        createdAt: now,
        updatedAt: now,
        noticeAt: null,
        deleteAt: null,
      }
      this.vaultRows.push(row)
      return { status: "ok", vault: row.vault, key: row.wrappedKey, createdAt: row.createdAt }
    }

    if (["read", "usage", "list", "lapse-status"].includes(r.action)) {
      const row = this.open(mode, account)
      if (!row) return { status: "not_found" }
      const used = this.used(row.id).bytes
      if (r.action === "read")
        return { status: "ok", vault: row.vault, key: row.wrappedKey, createdAt: row.createdAt, deleteAt: row.deleteAt, usedBytes: used }
      if (r.action === "usage") return { status: "ok", usedBytes: used }
      if (r.action === "lapse-status") return { status: "ok", held: row.held, noticeAt: row.noticeAt, deleteAt: row.deleteAt }
      const snapshots = this.versionRows
        .filter((item) => item.vaultId === row.id && item.committed)
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .map((item) => this.snapshot(item))
      return { status: "ok", vault: row.vault, snapshots, usedBytes: used, deleteAt: row.deleteAt }
    }

    if (r.action === "reserve") {
      if (
        version === undefined ||
        !Array.isArray(r.objects) ||
        typeof r.versionAt !== "number" ||
        typeof r.quota !== "number" ||
        typeof r.reserveMs !== "number" ||
        typeof r.signedMs !== "number" ||
        typeof r.versionDays !== "number" ||
        !r.limits ||
        ("manifest" in r && typeof r.manifest !== "number")
      )
        return invalid
      const manifest: number | undefined = "manifest" in r ? r.manifest : undefined
      const declared = new Map<string, number>()
      for (const item of r.objects) if (!declared.has(item.id)) declared.set(item.id, item.size)
      const ids = [...declared.keys()].sort()
      if (ids.some((id) => !OBJECT.test(id) || !(declared.get(id)! >= 0)) || (manifest !== undefined && manifest < 0))
        return invalid
      const row = this.open(mode, account)
      if (!row) return { status: "not_found" }
      const existing = this.versionRows.find((item) => item.vaultId === row.id && item.id === version)
      if (existing?.committed) return { status: "committed" }
      let drop = 0
      if (!existing) {
        const versions = this.versionRows.filter((item) => item.vaultId === row.id)
        const open = versions.filter((item) => !item.committed && item.touchedAt >= now - r.reserveMs)
        if (open.length >= r.limits.open) return { status: "open" }
        const committed = versions.filter((item) => item.committed).length
        drop = Math.max(committed - r.limits.versions + 1, 0)
        if (drop > 0 && (row.held || drop > committed - 1)) return { status: "versions" }
      }
      const blobs = ids.map((id) => [id, this.blob(row.id, "object", id)] as const)
      const manifestBlob = this.blob(row.id, "manifest", version)
      if (blobs.some(([, blob]) => blob?.state === "claimed") || (manifest !== undefined && manifestBlob?.state === "claimed"))
        return { status: "busy" }
      if (
        blobs.some(([id, blob]) => blob?.state === "pending" && blob.size !== declared.get(id)) ||
        (manifest !== undefined && manifestBlob && LIVE.has(manifestBlob.state) && manifestBlob.size !== manifest)
      )
        return { status: "mismatch" }
      const present = blobs.filter(([, blob]) => blob?.state === "stored").map(([id]) => id)
      const fresh = blobs.filter(([, blob]) => !blob || blob.state === "trash")
      let added = fresh.reduce((sum, [id]) => sum + declared.get(id)!, 0)
      let addedCount = fresh.length
      if (manifest !== undefined && !(manifestBlob && LIVE.has(manifestBlob.state))) {
        added += manifest
        addedCount++
      }
      const used = this.used(row.id)
      if (used.bytes + added > r.quota || used.count + addedCount > r.limits.objects)
        return { status: "quota", usedBytes: used.bytes }
      const refs = new Set(this.refRows.filter((ref) => ref.vaultId === row.id && ref.version === version).map((ref) => ref.object))
      if (refs.size + ids.filter((id) => !refs.has(id)).length > r.limits.refs) return { status: "quota", usedBytes: used.bytes }
      if (drop > 0) {
        const dropped = this.versionRows
          .filter((item) => item.vaultId === row.id && item.committed)
          .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, drop)
          .map((item) => item.id)
        const orphans = new Set(
          this.refRows.filter((ref) => ref.vaultId === row.id && dropped.includes(ref.version)).map((ref) => ref.object),
        )
        for (const id of dropped) {
          this.dropVersion(row.id, id)
          const blob = this.blob(row.id, "manifest", id)
          if (blob && LIVE.has(blob.state)) this.trash(blob, now)
        }
        for (const id of orphans) {
          const blob = this.blob(row.id, "object", id)
          if (blob && LIVE.has(blob.state) && !declared.has(id) && !this.referenced(row.id, id)) this.trash(blob, now)
        }
      }
      if (existing) existing.touchedAt = Math.max(existing.touchedAt, now)
      else
        this.versionRows.push({
          vaultId: row.id,
          id: version,
          committed: false,
          createdAt: r.versionAt,
          touchedAt: now,
          committedAt: null,
          objects: 0,
          bytes: 0,
        })
      Object.assign(row, { versionDays: r.versionDays, updatedAt: now })
      const upsert = (kind: "object" | "manifest", id: string, size: number) => {
        const blob = this.blob(row.id, kind, id)
        if (!blob)
          this.blobRows.set(`${row.id}|${kind}|${id}`, {
            vaultId: row.id,
            kind,
            id,
            size,
            state: "pending",
            reservedUntil: now + r.reserveMs,
            signedUntil: now + r.signedMs,
            claimedAt: null,
            updatedAt: now,
          })
        else if (blob.state === "pending" || blob.state === "trash")
          Object.assign(blob, {
            size,
            state: "pending",
            claimedAt: null,
            updatedAt: now,
            reservedUntil: Math.max(blob.reservedUntil ?? 0, now + r.reserveMs),
            signedUntil: Math.max(blob.signedUntil ?? 0, now + r.signedMs),
          })
      }
      for (const id of ids) upsert("object", id, declared.get(id)!)
      if (manifest !== undefined) {
        upsert("manifest", version, manifest)
        // The manifest is signed even when a commit round already confirmed it.
        const signed = this.blob(row.id, "manifest", version)!
        signed.signedUntil = Math.max(signed.signedUntil ?? 0, now + r.signedMs)
      }
      for (const id of ids) if (!refs.has(id)) this.refRows.push({ vaultId: row.id, version, object: id })
      return {
        status: "ok",
        vault: row.vault,
        sign: ids.filter((id) => !present.includes(id)),
        present: [...present].sort(),
        manifest: manifest !== undefined,
        usedBytes: used.bytes + added,
      }
    }

    if (r.action === "check" || r.action === "commit") {
      if (version === undefined || typeof r.objects !== "number") return invalid
      const row = this.open(mode, account)
      if (!row) return { status: "not_found" }
      const item = this.versionRows.find((entry) => entry.vaultId === row.id && entry.id === version)
      if (!item) return { status: "not_found" }
      if (item.committed) return { status: "committed", vault: row.vault, snapshot: this.snapshot(item) }
      const refs = this.refRows.filter((ref) => ref.vaultId === row.id && ref.version === version).map((ref) => ref.object)
      if (refs.length !== r.objects) return { status: "count" }
      if (r.action === "commit" && Array.isArray(r.verified))
        for (const head of r.verified) {
          const blob = this.blob(row.id, head.kind, head.id)
          if (blob && blob.size === head.size && blob.state === "pending" && (head.kind === "object" || head.id === version))
            Object.assign(blob, { state: "stored", reservedUntil: null, updatedAt: now })
        }
      const manifestBlob = this.blob(row.id, "manifest", version)
      if (!manifestBlob || !LIVE.has(manifestBlob.state)) return { status: "manifest" }
      const objects = refs.map((id) => this.blob(row.id, "object", id))
      if (objects.some((blob) => !blob || !LIVE.has(blob.state))) return { status: "missing" }
      if (r.action === "check") {
        const limit = Math.min(Math.max(r.limit ?? 1000, 1), 10000)
        const pending = objects
          .filter((blob) => blob!.state === "pending")
          .sort((a, b) => (a!.id < b!.id ? -1 : 1))
          .slice(0, limit)
          .map((blob) => ({ kind: "object", id: blob!.id, size: blob!.size }))
        return {
          status: "ok",
          vault: row.vault,
          heads: [
            ...(manifestBlob.state === "pending" ? [{ kind: "manifest", id: manifestBlob.id, size: manifestBlob.size }] : []),
            ...pending,
          ],
        }
      }
      if (manifestBlob.state === "pending" || objects.some((blob) => blob!.state === "pending")) return { status: "more" }
      Object.assign(item, {
        committed: true,
        committedAt: now,
        touchedAt: now,
        objects: refs.length,
        bytes: manifestBlob.size + objects.reduce((sum, blob) => sum + blob!.size, 0),
      })
      return { status: "ok", vault: row.vault, snapshot: this.snapshot(item) }
    }

    if (r.action === "discard") {
      if (!Array.isArray(r.items)) return invalid
      const row = this.open(mode, account)
      if (!row) return { status: "not_found" }
      for (const head of r.items) {
        const blob = this.blob(row.id, head.kind, head.id)
        if (blob?.state === "pending") this.trash(blob, now)
      }
      return { status: "ok" }
    }

    if (r.action === "version" || r.action === "downloads") {
      const row = this.open(mode, account)
      if (!row) return { status: "not_found" }
      const item = this.versionRows.find((entry) => entry.vaultId === row.id && entry.id === version && entry.committed)
      if (!item) return { status: "not_found" }
      if (r.action === "version") return { status: "ok", vault: row.vault, snapshot: this.snapshot(item) }
      if (!Array.isArray(r.objects)) return invalid
      const asked = new Set(r.objects)
      const objects = this.refRows
        .filter((ref) => ref.vaultId === row.id && ref.version === version && asked.has(ref.object))
        .filter((ref) => this.blob(row.id, "object", ref.object)?.state === "stored")
        .map((ref) => ref.object)
        .sort()
      return { status: "ok", vault: row.vault, objects }
    }

    if (r.action === "forget") {
      if (version === undefined) return invalid
      const row = this.open(mode, account)
      if (!row) return { status: "not_found" }
      const gone = this.refRows.filter((ref) => ref.vaultId === row.id && ref.version === version).map((ref) => ref.object)
      if (!this.versionRows.some((item) => item.vaultId === row.id && item.id === version && item.committed))
        return { status: "not_found" }
      this.dropVersion(row.id, version)
      const manifest = this.blob(row.id, "manifest", version)
      if (manifest && LIVE.has(manifest.state)) this.trash(manifest, now)
      for (const id of gone) {
        const blob = this.blob(row.id, "object", id)
        if (blob && LIVE.has(blob.state) && !this.referenced(row.id, id)) this.trash(blob, now)
      }
      return { status: "ok" }
    }

    if (r.action === "destroy") {
      const row = this.open(mode, account)
      if (!row) return { status: "not_found" }
      this.destroy(row, now)
      return { status: "ok" }
    }

    if (r.action === "hold" || r.action === "release") {
      const row = this.open(mode, account)
      const held = r.action === "hold"
      if (row && (row.held !== held || row.noticeAt !== null || row.deleteAt !== null))
        Object.assign(row, { held, noticeAt: null, deleteAt: null, updatedAt: now })
      return { status: "ok" }
    }

    if (r.action === "notice") {
      if (typeof r.deleteAt !== "number") return invalid
      const row = this.open(mode, account)
      if (!row) return { status: "not_found" }
      Object.assign(row, { held: false, noticeAt: row.noticeAt ?? now, deleteAt: row.deleteAt ?? r.deleteAt, updatedAt: now })
      return { status: "ok", noticeAt: row.noticeAt, deleteAt: row.deleteAt }
    }

    return invalid
  }

  async vaults(account: string): Promise<VaultView[]> {
    return this.vaultRows
      .filter((row) => row.account === account)
      .map((row) => ({
        vault: row.vault,
        wrappedKey: row.wrappedKey,
        deleting: row.deleting,
        held: row.held,
        noticeAt: row.noticeAt,
        deleteAt: row.deleteAt,
      }))
  }

  async blobs(account: string): Promise<BlobView[]> {
    const vaults = new Set(this.vaultRows.filter((row) => row.account === account).map((row) => row.id))
    return [...this.blobRows.values()]
      .filter((blob) => vaults.has(blob.vaultId))
      .map((blob) => ({ kind: blob.kind, id: blob.id, size: blob.size, state: blob.state }))
      .sort((a, b) => (a.kind + a.id < b.kind + b.id ? -1 : 1))
  }

  async versions(account: string) {
    const vaults = new Set(this.vaultRows.filter((row) => row.account === account).map((row) => row.id))
    return this.versionRows
      .filter((item) => vaults.has(item.vaultId))
      .map((item) => ({ id: item.id, committed: item.committed, createdAt: item.createdAt }))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  async seedStored(account: string, size: number) {
    const row = this.vaultRows.find((item) => item.account === account && !item.deleting)!
    const id = seedId()
    this.blobRows.set(`${row.id}|object|${id}`, {
      vaultId: row.id,
      kind: "object",
      id,
      size,
      state: "stored",
      reservedUntil: null,
      signedUntil: null,
      claimedAt: null,
      updatedAt: 1,
    })
    return id
  }

  async age(account: string, version: string, createdAt: number) {
    const vaults = new Set(this.vaultRows.filter((row) => row.account === account).map((row) => row.id))
    for (const item of this.versionRows) if (vaults.has(item.vaultId) && item.id === version) item.createdAt = createdAt
  }
}

let seeded = 0
function seedId() {
  return (++seeded).toString(16).padStart(64, "e")
}

/** The real SQL on a disposable Postgres (CI), called as the service role exactly as PostgREST would. */
export class PostgresVaultBackend implements VaultBackend {
  readonly real = true
  private constructor(private readonly database: SQL) {}

  static async connect(address: string) {
    const url = new URL(address)
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/vector_shares_test")
      throw new Error("Brain Vault SQL tests require the disposable loopback vector_shares_test database")
    const database = new SQL(url.href)
    await database
      .unsafe(
        `
      do $$ begin create role anon; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
    `,
      )
      .simple()
    await database
      .unsafe(await Bun.file(new URL("../docs/vector/owner-actions/sql/brain-vault.sql", import.meta.url)).text())
      .simple()
    return new PostgresVaultBackend(database)
  }

  async call(request: Record<string, unknown>) {
    const rows = await this.database.begin(async (transaction) => {
      await transaction`set local role service_role`
      return transaction`select public.vector_brain_vault(${request}::jsonb) as result`
    })
    return rows[0].result
  }

  async reset() {
    await this.database`truncate public.vector_brain_vaults cascade`
  }

  async close() {
    await this.database.close()
  }

  async vaults(account: string): Promise<VaultView[]> {
    const rows = await this.database`
      select vault, wrapped_key, deleting, held, notice_at, delete_at from public.vector_brain_vaults where account = ${account}`
    return rows.map((row: any) => ({
      vault: row.vault,
      wrappedKey: row.wrapped_key,
      deleting: row.deleting,
      held: row.held,
      noticeAt: row.notice_at === null ? null : Number(row.notice_at),
      deleteAt: row.delete_at === null ? null : Number(row.delete_at),
    }))
  }

  async blobs(account: string): Promise<BlobView[]> {
    const rows = await this.database`
      select b.kind, b.id, b.size, b.state from public.vector_brain_vault_blobs b
        join public.vector_brain_vaults v on v.id = b.vault_id
       where v.account = ${account} order by b.kind || b.id`
    return rows.map((row: any) => ({ kind: row.kind, id: row.id, size: Number(row.size), state: row.state }))
  }

  async versions(account: string) {
    const rows = await this.database`
      select s.id, s.committed, s.created_at from public.vector_brain_vault_versions s
        join public.vector_brain_vaults v on v.id = s.vault_id
       where v.account = ${account} order by s.id`
    return rows.map((row: any) => ({ id: row.id, committed: row.committed, createdAt: Number(row.created_at) }))
  }

  async seedStored(account: string, size: number) {
    const id = seedId()
    await this.database`
      insert into public.vector_brain_vault_blobs (vault_id, kind, id, size, state, updated_at)
      select v.id, 'object', ${id}::text, ${size}::bigint, 'stored', 1 from public.vector_brain_vaults v
       where v.account = ${account} and not v.deleting`
    return id
  }

  async age(account: string, version: string, createdAt: number) {
    await this.database`
      update public.vector_brain_vault_versions s set created_at = ${createdAt}::bigint
        from public.vector_brain_vaults v
       where v.id = s.vault_id and v.account = ${account} and s.id = ${version}`
  }
}

export async function vaultBackend(): Promise<VaultBackend> {
  const address = process.env.VECTOR_TEST_POSTGRES_URL
  return address ? PostgresVaultBackend.connect(address) : new MemoryVaultBackend()
}

// ── R2, the account service and email ──────────────────────────────────────────────────────────────────────────────

export type R2Call = { method: string; key: string; status: number }

/** A bucket that checks each presigned request the way R2 does, against the clock it is given. */
export function vaultBucket(clock: () => number, log: string[] = []) {
  const objects = new Map<string, Uint8Array>()
  const calls: R2Call[] = []
  const state = { down: false, alter: undefined as undefined | ((key: string, bytes: Uint8Array) => Uint8Array) }
  async function handle(url: URL, init: RequestInit | undefined): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase()
    const prefix = "/vector-vault/"
    const key = decodeURIComponent(url.pathname.slice(prefix.length))
    const answer = (status: number, body?: BodyInit | null, headers?: Record<string, string>) => {
      calls.push({ method, key, status })
      log.push(`r2:${method}:${status}`)
      return new Response(body ?? null, { status, ...(headers ? { headers } : {}) })
    }
    if (state.down) return answer(503)
    if (!url.pathname.startsWith(prefix)) return answer(404)
    const headers = new Headers(init?.headers)
    // The signature must cover exactly what is sent, and the URL must not have expired.
    const signed = (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";")
    const date = url.searchParams.get("X-Amz-Date") ?? ""
    const at = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +date.slice(9, 11), +date.slice(11, 13), +date.slice(13, 15))
    const expires = Number(url.searchParams.get("X-Amz-Expires"))
    const base = new URL(url.origin + url.pathname)
    const expected = presignSigV4({
      method,
      url: base,
      region: "auto",
      service: "s3",
      accessKeyId: R2_KEY_ID,
      secretAccessKey: R2_SECRET,
      now: at,
      expiresIn: expires,
      headers: Object.fromEntries(signed.filter((name) => name !== "host").map((name) => [name, headers.get(name) ?? ""])),
    })
    if (new URL(expected).searchParams.get("X-Amz-Signature") !== url.searchParams.get("X-Amz-Signature"))
      return answer(403)
    if (clock() > at + expires * 1000) return answer(403)
    if (method === "PUT") {
      if (!signed.includes("content-length")) return answer(403)
      let bytes: Uint8Array = new Uint8Array(await new Response(init?.body).arrayBuffer())
      if (String(bytes.byteLength) !== headers.get("content-length")) return answer(400)
      if (state.alter) bytes = state.alter(key, bytes)
      objects.set(key, bytes)
      return answer(200)
    }
    const stored = objects.get(key)
    if (method === "HEAD")
      return stored ? answer(200, null, { "content-length": String(stored.byteLength) }) : answer(404)
    if (method === "GET") return stored ? answer(200, stored.slice()) : answer(404)
    if (method === "DELETE") {
      objects.delete(key)
      return answer(204)
    }
    return answer(405)
  }
  return { objects, calls, state, handle }
}

export type SentEmail = { from: string; to: string[]; subject: string; text: string; key: string | null }

/** Everything the server may reach in these tests, behind one `fetch`. */
export function vaultWorld(backend: VaultBackend, clock: () => number) {
  const kv = roadmapFakes()
  const log: string[] = []
  const bucket = vaultBucket(clock, log)
  const users = new Map<string, string>()
  const emails: SentEmail[] = []
  const rpc: Record<string, unknown>[] = []
  const state = { dbDown: false, mailDown: false }
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === ROADMAP_KV_URL) return kv.fetcher(input, init)
    if (url.origin === R2_ORIGIN) return bucket.handle(url, init)
    const headers = new Headers(init?.headers)
    if (url.origin === SUPABASE_ORIGIN) {
      if (headers.get("apikey") !== SERVICE_ROLE || headers.get("authorization") !== `Bearer ${SERVICE_ROLE}`)
        return new Response(null, { status: 401 })
      if (url.pathname === "/rest/v1/rpc/vector_brain_vault" && init?.method === "POST") {
        if (state.dbDown) return new Response(null, { status: 503 })
        const body = JSON.parse(String(init.body)) as { request: Record<string, unknown> }
        rpc.push(body.request)
        log.push(`rpc:${String(body.request.action)}`)
        return Response.json(await backend.call(body.request))
      }
      const user = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(url.pathname)?.[1]
      if (user && (init?.method ?? "GET") === "GET") {
        const email = users.get(decodeURIComponent(user))
        return email
          ? Response.json({ id: decodeURIComponent(user), email, user_metadata: {} })
          : Response.json({ msg: "User not found" }, { status: 404 })
      }
    }
    if (url.href === "https://api.resend.com/emails" && init?.method === "POST") {
      if (state.mailDown) return Response.json({ message: "fixture failure" }, { status: 500 })
      const body = JSON.parse(String(init.body))
      emails.push({ ...body, key: headers.get("idempotency-key") })
      return Response.json({ id: `email_${emails.length}` })
    }
    throw new Error(`Unexpected request to ${url.origin}${url.pathname}`)
  }) as typeof fetch
  return { kv, store: kv.store, bucket, users, emails, rpc, log, state, fetcher }
}
