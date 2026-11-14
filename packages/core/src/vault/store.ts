export * as VaultStore from "./store"

import type { Vault } from "@vectordevai/schema/vault"
import { VaultError } from "./error"

// Where a vault's encrypted objects live. Three stores implement this: Vector's Vault API (`remote.ts`, a paid perk
// whose quota the server enforces), a private GitHub repository the person owns (`github.ts`, free), and memory, for
// tests. A store only ever holds what the vault's format sealed: object ids, sizes, version ids and the wrapped key.

export type Listing = {
  /** Committed versions, newest first. */
  readonly snapshots: readonly Vault.Snapshot[]
  /** Vector's backend: the bytes used and the plan's quota. */
  readonly usage?: Vault.Usage
  /** Uploads are refused now (a paused or ended plan, §4.4); restore still works. */
  readonly readOnly?: boolean
  /** When a read-only vault is deleted. */
  readonly deleteAt?: number
  /** A store with no quota (GitHub): the bytes the vault takes there. */
  readonly storedBytes?: number
}

/** What a commit or a forget also removes, in a store the client prunes itself. */
export type Prune = {
  readonly versions: readonly string[]
  readonly objects: readonly string[]
}

export interface Store {
  /** Where backups go, as the person reads it. */
  readonly label: string
  /**
   * How many versions the client keeps, newest first, when it prunes the store itself (the GitHub backend). Undefined
   * when the server prunes (Vector's, by the plan's version days).
   */
  readonly keep?: number
  /** The wrapped vault key, or undefined when the store holds no vault. */
  readonly readKey: () => Promise<Vault.WrappedKey | undefined>
  /** Records the wrapped key of a new vault; throws `exists` when the store holds another vault. */
  readonly writeKey: (key: Vault.WrappedKey) => Promise<void>
  /** Declares every object of a version and answers the ids the store does not hold yet. */
  readonly prepare: (version: string, objects: readonly Vault.ObjectRef[]) => Promise<ReadonlySet<string>>
  readonly putObject: (version: string, id: string, bytes: Uint8Array) => Promise<void>
  /** Stores the version's manifest and commits it, removing `prune` in the same step where the store allows. */
  readonly commit: (
    version: string,
    manifest: Uint8Array,
    objects: readonly Vault.ObjectRef[],
    prune?: Prune,
  ) => Promise<Vault.Snapshot>
  readonly list: () => Promise<Listing>
  /** A committed version's manifest; throws `not-found`. */
  readonly readManifest: (version: string) => Promise<Uint8Array>
  /** The objects asked for, of a committed version; an id the store lacks is left out. */
  readonly readObjects: (version: string, ids: readonly string[]) => Promise<ReadonlyMap<string, Uint8Array>>
  /** Removes a version and, in a store the client prunes, the objects only it referenced. */
  readonly forget: (version: string, prune?: Prune) => Promise<void>
  /** Removes the vault: every object, every version and the wrapped key. */
  readonly destroy: () => Promise<void>
  /** Every object id the store holds, for a store the client prunes. */
  readonly objects?: () => Promise<ReadonlySet<string>>
}

/** A store in memory, which tests use and which shows what every store must do. */
export function memory(options: { readonly keep?: number; readonly label?: string } = {}) {
  let key: Vault.WrappedKey | undefined
  const objects = new Map<string, Uint8Array>()
  const manifests = new Map<string, { bytes: Uint8Array; snapshot: Vault.Snapshot }>()
  const pending = new Map<string, Set<string>>()
  const puts: string[] = []
  const store: Store & { readonly puts: readonly string[]; readonly raw: ReadonlyMap<string, Uint8Array> } = {
    label: options.label ?? "memory",
    ...(options.keep ? { keep: options.keep } : {}),
    puts,
    raw: objects,
    readKey: async () => key,
    writeKey: async (next) => {
      if (key && key.vault !== next.vault) throw new VaultError("exists", "This store already holds another vault.")
      key = next
    },
    prepare: async (version, refs) => {
      const missing = new Set(refs.filter((ref) => !objects.has(ref.id)).map((ref) => ref.id))
      pending.set(version, missing)
      return missing
    },
    putObject: async (version, id, bytes) => {
      if (!pending.get(version)?.has(id)) throw new VaultError("unavailable", "That piece was not declared.")
      objects.set(id, Uint8Array.from(bytes))
      puts.push(id)
    },
    commit: async (version, manifest, refs, prune) => {
      const missing = refs.filter((ref) => !objects.has(ref.id))
      if (missing.length) throw new VaultError("size-mismatch", "A piece of this backup did not arrive.")
      pending.delete(version)
      const snapshot: Vault.Snapshot = {
        id: version,
        createdAt: Number(version.slice(1, 14)),
        bytes: refs.reduce((sum, ref) => sum + (objects.get(ref.id)?.byteLength ?? 0), manifest.byteLength),
        objects: refs.length,
      }
      manifests.set(version, { bytes: Uint8Array.from(manifest), snapshot })
      for (const id of prune?.versions ?? []) manifests.delete(id)
      for (const id of prune?.objects ?? []) objects.delete(id)
      return snapshot
    },
    list: async () => ({
      snapshots: [...manifests.values()].map((item) => item.snapshot).toSorted((a, b) => b.id.localeCompare(a.id)),
    }),
    readManifest: async (version) => {
      const found = manifests.get(version)
      if (!found) throw new VaultError("not-found", `No backup version ${version}.`)
      return found.bytes
    },
    readObjects: async (_version, ids) =>
      new Map(ids.flatMap((id) => (objects.has(id) ? [[id, objects.get(id)!] as const] : []))),
    forget: async (version, prune) => {
      if (!manifests.delete(version)) throw new VaultError("not-found", `No backup version ${version}.`)
      for (const id of prune?.objects ?? []) objects.delete(id)
    },
    destroy: async () => {
      key = undefined
      objects.clear()
      manifests.clear()
    },
    objects: async () => new Set(objects.keys()),
  }
  return store
}
