export * as VaultBackup from "./vault"

import { Vault } from "@vectordevai/schema/vault"
import { VaultChunker } from "./chunker"
import { VaultCrypto } from "./crypto"
import { VaultError } from "./error"
import { VaultFormat } from "./format"
import { VaultRecovery } from "./recovery"
import type { VaultStore } from "./store"

// Brain Vault's backup and restore over any store (contract A43, P3). Each file is cut into content-defined chunks,
// each chunk is compressed and sealed with AES-256-GCM (associated data: the vault id and the chunk's id) and named by
// an HMAC of its plaintext, so a chunk an earlier version holds is not uploaded again. The manifest lists the files,
// their chunks and `minReader`, and is sealed too. The vault key never leaves this computer except wrapped under the
// recovery code, so neither Vector nor GitHub can read a backup, and a lost code cannot be recovered by anyone.

/** An open vault: its id and the keys its key gives. */
export type Opened = { readonly vault: string; readonly vaultKey: Uint8Array }

/** A file to back up. */
export type Input = {
  readonly path: string
  readonly section: Vault.Section
  readonly bytes: Uint8Array
  readonly repository?: string
  readonly worktree?: string
}

/** A new vault in `store`: a random key and id, and the recovery code that wraps it, which is shown once. */
export async function create(store: VaultStore.Store, options: { readonly now?: number; readonly cost?: number } = {}) {
  if (await store.readKey()) throw new VaultError("exists", `${store.label} already holds a vault. Restore it with its recovery code.`)
  const vault = VaultCrypto.vaultId()
  const vaultKey = VaultCrypto.vaultKey()
  const code = VaultRecovery.generate()
  const wrapped = await VaultRecovery.wrap({ vaultKey, vault, code, ...options })
  await store.writeKey(wrapped)
  return { vault, vaultKey, code, wrapped }
}

/** Opens the vault `store` holds with its recovery code. Throws `not-found`, `typo` or `wrong-code`. */
export async function unlock(store: VaultStore.Store, code: string): Promise<Opened & { readonly wrapped: Vault.WrappedKey }> {
  // A typo is reported before anything is read.
  VaultRecovery.parse(code)
  const wrapped = await store.readKey()
  if (!wrapped) throw new VaultError("not-found", `${store.label} holds no vault yet.`)
  const opened = await VaultRecovery.unwrap({ wrapped, code })
  return { ...opened, wrapped }
}

/** Checks that `store` holds the vault `opened` is, so a backup never mixes two vaults. */
export async function attach(store: VaultStore.Store, opened: Opened, wrapped: Vault.WrappedKey) {
  if (wrapped.vault !== opened.vault) throw new VaultError("damaged", "The vault's key record does not match this vault.")
  const held = await store.readKey()
  if (held && held.vault !== opened.vault)
    throw new VaultError("exists", `${store.label} holds another vault. Choose another place for this one.`)
  if (!held) await store.writeKey(wrapped)
}

export type BackedUp = {
  readonly snapshot: Vault.Snapshot
  /** Objects sent now, and those the store already held. */
  readonly uploaded: number
  readonly reused: number
  readonly uploadedBytes: number
  /** Versions removed to keep `store.keep`. */
  readonly pruned: readonly string[]
}

/** Backs `files` up as a new version. */
export async function backup(input: {
  readonly store: VaultStore.Store
  readonly opened: Opened
  readonly files: readonly Input[]
  readonly now?: number
}): Promise<BackedUp> {
  const { store, opened } = input
  const keys = VaultCrypto.derive(opened.vaultKey)
  const gear = VaultCrypto.gear(keys)
  const paths = new Set<string>()
  const packed = new Map<string, VaultFormat.Packed>()
  const files: Vault.File[] = []
  for (const file of input.files) {
    if (paths.has(file.path)) throw new Error(`Two files are named ${file.path}.`)
    paths.add(file.path)
    const chunks = VaultChunker.split(file.bytes, gear).map((chunk) => {
      const id = VaultCrypto.objectId(keys, chunk)
      if (!packed.has(id)) packed.set(id, VaultFormat.packChunk(chunk))
      return id
    })
    files.push({
      path: file.path,
      section: file.section,
      size: file.bytes.byteLength,
      chunks,
      ...(file.repository !== undefined ? { repository: file.repository } : {}),
      ...(file.worktree !== undefined ? { worktree: file.worktree } : {}),
    })
  }
  const objects = [...packed].map(([id, item]) => ({ id, size: item.size }))
  const now = Math.trunc(input.now ?? Date.now())
  const version = VaultCrypto.versionId(now)
  const manifest: Vault.Manifest = {
    format: "vector-vault",
    version: 1,
    minReader: Vault.MIN_READER,
    vault: opened.vault,
    id: version,
    createdAt: now,
    files,
    objects,
  }
  const sealedManifest = VaultFormat.sealManifest(keys, manifest)
  const missing = await store.prepare(version, objects)
  let uploadedBytes = 0
  for (const [id, item] of packed) {
    if (!missing.has(id)) continue
    const sealed = VaultFormat.sealPacked(keys, opened.vault, id, item)
    uploadedBytes += sealed.byteLength
    await store.putObject(version, id, sealed)
  }
  const prune = store.keep ? await pruneFor(store, keys, opened, { keep: store.keep - 1, also: objects }) : undefined
  const snapshot = await store.commit(version, sealedManifest, objects, prune)
  return {
    snapshot,
    uploaded: missing.size,
    reused: objects.length - missing.size,
    uploadedBytes: uploadedBytes + sealedManifest.byteLength,
    pruned: prune?.versions ?? [],
  }
}

/**
 * What to remove so the store keeps its `keep` newest versions besides the one being written: the older versions,
 * and the objects none of the kept versions (nor `also`) names. Each kept manifest is opened to read what it names;
 * one that does not open keeps every object, so a damaged manifest never costs another version its pieces.
 */
async function pruneFor(
  store: VaultStore.Store,
  keys: VaultCrypto.Keys,
  opened: Opened,
  input: { readonly keep: number; readonly also?: readonly Vault.ObjectRef[]; readonly without?: string },
): Promise<VaultStore.Prune | undefined> {
  if (!store.objects) return undefined
  const listed = (await store.list()).snapshots.filter((snapshot) => snapshot.id !== input.without)
  const kept = listed.slice(0, Math.max(0, input.keep))
  const versions = listed.slice(Math.max(0, input.keep)).map((snapshot) => snapshot.id)
  const named = new Set((input.also ?? []).map((ref) => ref.id))
  for (const snapshot of kept) {
    const manifest = await store
      .readManifest(snapshot.id)
      .then((bytes) => VaultFormat.openManifest(keys, opened.vault, snapshot.id, bytes))
      .catch(() => undefined)
    if (!manifest) return { versions, objects: [] }
    for (const ref of manifest.objects) named.add(ref.id)
  }
  const objects = [...(await store.objects())].filter((id) => !named.has(id))
  return { versions, objects }
}

export type Restored = {
  readonly manifest: Vault.Manifest
  /** Files of sections this reader knows, with their plaintext. */
  readonly files: readonly { readonly file: Vault.File; readonly bytes: Buffer }[]
  /** Files of sections a newer writer added that this reader may skip. */
  readonly skipped: readonly Vault.File[]
}

/** The newest version, or `version`, read back and checked. Throws `not-found`, `update` or `damaged`. */
export async function read(input: {
  readonly store: VaultStore.Store
  readonly opened: Opened
  readonly version?: string
}): Promise<Restored> {
  const { store, opened } = input
  const keys = VaultCrypto.derive(opened.vaultKey)
  const version = input.version ?? (await store.list()).snapshots[0]?.id
  if (!version) throw new VaultError("not-found", `${store.label} holds no backup yet.`)
  const manifest = VaultFormat.openManifest(keys, opened.vault, version, await store.readManifest(version))
  const known = manifest.files.filter((file) => (Vault.SECTIONS as readonly string[]).includes(file.section))
  const wanted = [...new Set(known.flatMap((file) => file.chunks))]
  const plain = new Map<string, Buffer>()
  for (let start = 0; start < wanted.length; start += Vault.LIMIT.batch) {
    const ids = wanted.slice(start, start + Vault.LIMIT.batch)
    const got = await store.readObjects(version, ids)
    for (const id of ids) {
      const bytes = got.get(id)
      if (!bytes) throw new VaultError("damaged", "A piece of this backup is missing from the store.")
      plain.set(id, VaultFormat.openChunk(keys, opened.vault, id, bytes))
    }
  }
  const files = known.map((file) => {
    const bytes = Buffer.concat(file.chunks.map((id) => plain.get(id)!))
    if (bytes.byteLength !== file.size) throw new VaultError("damaged", `${file.path} in this backup is damaged.`)
    return { file, bytes }
  })
  return { manifest, files, skipped: manifest.files.filter((file) => !known.includes(file)) }
}

/** Forgets one version; in a store the client prunes, the objects only it named go too. */
export async function forget(input: { readonly store: VaultStore.Store; readonly opened: Opened; readonly version: string }) {
  const { store, opened } = input
  const listed = (await store.list()).snapshots
  if (!listed.some((snapshot) => snapshot.id === input.version))
    throw new VaultError("not-found", `No backup version ${input.version}.`)
  const keys = VaultCrypto.derive(opened.vaultKey)
  const prune = await pruneFor(store, keys, opened, { keep: listed.length, without: input.version })
  await store.forget(input.version, prune ? { versions: [], objects: prune.objects } : undefined)
}
