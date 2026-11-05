export * as Vault from "./vault.js"

import { Schema } from "effect"

/*
 * Brain Vault's formats, shared by the reader and writer in packages/core/src/vault, the CLI, the desktop (A45) and the
 * Vault API (A44). Everything the store holds is encrypted on the person's computer: the server and a GitHub repository
 * see object ids (keyed HMACs, never a plain hash of the content), sizes, version ids and the key wrapped under the
 * recovery code. Browser-safe: no Node imports.
 */

/** The reader this build implements. A version whose `minReader` is higher is refused with "update Vector". */
export const READER = 1
/** What this build's writer asks of a reader: every field and section it writes is one a reader at this level knows. */
export const MIN_READER = 1

export const LIMIT = {
  /** Objects one uploads or downloads request names. */
  batch: 1000,
  /** Plaintext bytes of one chunk; the chunker never cuts one larger. */
  chunk: 256 * 1024,
  /** Plaintext bytes of one manifest. */
  manifest: 16 * 1024 * 1024,
  /** Versions a store that prunes on the person's computer keeps (the GitHub backend), newest first. */
  githubVersions: 7,
} as const

/** A vault's id: 16 random bytes as lower-case hex. Chosen once, when the vault is created. */
export const VaultId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))
export type VaultId = typeof VaultId.Type

/** An object's id: HMAC-SHA-256 of its plaintext under the vault's id key, as lower-case hex. */
export const ObjectId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
export type ObjectId = typeof ObjectId.Type

/** A version's id: `v`, the creation time in milliseconds (13 digits, so ids sort by time), and 8 random hex digits. */
export const VersionId = Schema.String.check(Schema.isPattern(/^v\d{13}-[0-9a-f]{8}$/))
export type VersionId = typeof VersionId.Type

const Base64Url = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Time = Schema.Int.check(Schema.isGreaterThan(0))

/**
 * The vault key wrapped under the recovery code: scrypt(code, salt) opens an AES-256-GCM box holding the 32-byte key,
 * with `vector-vault-key-v1` and the vault id as associated data. The store keeps it so another computer can restore
 * with the code; without the code it is useless. `N` is 2^17 when written; a reader accepts 2^14 to 2^20, so a store
 * cannot make it spend more memory than that.
 */
export const WrappedKey = Schema.Struct({
  format: Schema.Literal("vector-vault-key"),
  version: Schema.Literal(1),
  vault: VaultId,
  kdf: Schema.Struct({
    name: Schema.Literal("scrypt"),
    N: Schema.Int.check(Schema.isGreaterThanOrEqualTo(2 ** 14), Schema.isLessThanOrEqualTo(2 ** 20)),
    r: Schema.Literal(8),
    p: Schema.Literal(1),
    salt: Base64Url,
  }),
  nonce: Base64Url,
  ciphertext: Base64Url,
  createdAt: Time,
}).annotate({ identifier: "VaultWrappedKey" })
export type WrappedKey = typeof WrappedKey.Type

/** Sections a version may hold. A reader skips a section it does not know; `minReader` says when it may not. */
export const SECTIONS = ["memory"] as const
export type Section = (typeof SECTIONS)[number]

/**
 * One file of a version: a logical path, the section that reads it, its plaintext size and the chunks that make it, in
 * order. A memory file is one export (`vector-memory` JSON) of the personal scope or of one repository.
 */
export const File = Schema.Struct({
  path: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._/-]{0,199}$/)),
  section: Schema.String,
  size: Count,
  chunks: Schema.Array(ObjectId),
  /** memory: whose memory it is. "" is the person's own (personal scope). */
  repository: Schema.optional(Schema.String),
  /** memory: the working tree it was backed up from, on that computer. */
  worktree: Schema.optional(Schema.String),
}).annotate({ identifier: "VaultFile" })
export type File = typeof File.Type

/** An object's stored (encrypted) size, which the store checks at commit. */
export const ObjectRef = Schema.Struct({ id: ObjectId, size: Count }).annotate({ identifier: "VaultObjectRef" })
export type ObjectRef = typeof ObjectRef.Type

/** A version's manifest, stored encrypted under the vault's manifest key. */
export const Manifest = Schema.Struct({
  format: Schema.Literal("vector-vault"),
  version: Schema.Literal(1),
  minReader: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  vault: VaultId,
  id: VersionId,
  createdAt: Time,
  files: Schema.Array(File),
  /** Every object the files name, once, with its stored size. */
  objects: Schema.Array(ObjectRef),
}).annotate({ identifier: "VaultManifest" })
export type Manifest = typeof Manifest.Type

/** A version as a store lists it. `bytes` is what the version's objects and manifest take in the store. */
export const Snapshot = Schema.Struct({
  id: VersionId,
  createdAt: Time,
  bytes: Count,
  objects: Count,
}).annotate({ identifier: "VaultSnapshot" })
export type Snapshot = typeof Snapshot.Type

// --- Vault API (A44): /api/vault/{setup, uploads, commit, snapshots, snapshots/:id}, DELETE /api/vault -----------------
//
// Every route takes a Vector account token (`vct_`), never a run token (S3). Errors are {error:{code, message}} with
// VAULT_QUOTA 402, VAULT_SIZE_MISMATCH 409, VAULT_READ_ONLY 409, VAULT_NOT_FOUND 404, VAULT_EXISTS 409,
// VAULT_REQUEST_INVALID 400, VAULT_UNAVAILABLE 503 (try again; also while Vault is not listed), and the plan codes of
// contract §4.10. Signed links are R2 links valid at most 900 s; a PUT carries exactly the declared size.

/** GET /api/vault/setup answers the vault (404 VAULT_NOT_FOUND without one); POST creates it once. */
export const SetupRequest = Schema.Struct({ vault: VaultId, key: WrappedKey }).annotate({
  identifier: "VaultSetupRequest",
})
export type SetupRequest = typeof SetupRequest.Type

export const Setup = Schema.Struct({ vault: VaultId, key: WrappedKey, createdAt: Time }).annotate({
  identifier: "VaultSetup",
})
export type Setup = typeof Setup.Type

/**
 * POST /api/vault/uploads: declares up to `LIMIT.batch` of a version's objects (every object it names, held already
 * or not, so the server knows what each version references) and, in the last request, the manifest's size. The
 * server reserves quota for what it does not hold before it signs anything (402 VAULT_QUOTA), and signs a PUT only
 * for those.
 */
export const UploadsRequest = Schema.Struct({
  version: VersionId,
  objects: Schema.Array(ObjectRef),
  manifest: Schema.optional(Schema.Struct({ size: Count })),
}).annotate({ identifier: "VaultUploadsRequest" })
export type UploadsRequest = typeof UploadsRequest.Type

const Signed = Schema.Struct({ url: Schema.String })

export const Uploads = Schema.Struct({
  uploads: Schema.Array(Schema.Struct({ id: ObjectId, url: Schema.String })),
  present: Schema.Array(ObjectId),
  manifest: Schema.optional(Signed),
  expiresAt: Time,
}).annotate({ identifier: "VaultUploads" })
export type Uploads = typeof Uploads.Type

/**
 * POST /api/vault/commit: the server HEADs every object it signed for the version and the manifest; a size that
 * differs from the declared one is deleted and answered 409 VAULT_SIZE_MISMATCH. `objects` is how many the client
 * declared, as a check.
 */
export const CommitRequest = Schema.Struct({ version: VersionId, objects: Count }).annotate({
  identifier: "VaultCommitRequest",
})
export type CommitRequest = typeof CommitRequest.Type

export const Commit = Schema.Struct({ snapshot: Snapshot }).annotate({ identifier: "VaultCommit" })
export type Commit = typeof Commit.Type

/** The account's vault use: bytes, never an amount (P1). */
export const Usage = Schema.Struct({ usedBytes: Count, quotaBytes: Count }).annotate({ identifier: "VaultUsage" })
export type Usage = typeof Usage.Type

/** GET /api/vault/snapshots: committed versions, newest first. `readOnly` while uploads are refused (§4.4). */
export const Snapshots = Schema.Struct({
  snapshots: Schema.Array(Snapshot),
  usage: Usage,
  readOnly: Schema.Boolean,
  /** When a read-only vault is deleted, after its plan ended. */
  deleteAt: Schema.optional(Time),
}).annotate({ identifier: "VaultSnapshots" })
export type Snapshots = typeof Snapshots.Type

/** GET /api/vault/snapshots/:id: the version and a signed link to its manifest. DELETE forgets it. */
export const SnapshotRead = Schema.Struct({ snapshot: Snapshot, manifest: Signed }).annotate({
  identifier: "VaultSnapshotRead",
})
export type SnapshotRead = typeof SnapshotRead.Type

/** POST /api/vault/snapshots/:id: signed GET links for up to `LIMIT.batch` of the version's objects. */
export const DownloadsRequest = Schema.Struct({ objects: Schema.Array(ObjectId) }).annotate({
  identifier: "VaultDownloadsRequest",
})
export type DownloadsRequest = typeof DownloadsRequest.Type

export const Downloads = Schema.Struct({
  downloads: Schema.Array(Schema.Struct({ id: ObjectId, url: Schema.String })),
}).annotate({ identifier: "VaultDownloads" })
export type Downloads = typeof Downloads.Type

/** Error codes the Vault API answers, beyond the plan codes. */
export const ERROR_CODES = [
  "VAULT_QUOTA",
  "VAULT_SIZE_MISMATCH",
  "VAULT_READ_ONLY",
  "VAULT_NOT_FOUND",
  "VAULT_EXISTS",
  "VAULT_REQUEST_INVALID",
  "VAULT_UNAVAILABLE",
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]
