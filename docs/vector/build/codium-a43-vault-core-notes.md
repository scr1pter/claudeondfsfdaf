# A43: Vault core and CLI

A43 builds Brain Vault's encryption, chunking, recovery code and format, a trusted restore mode for memory, the
`vector vault` command, and the shared formats A44 (Vault API) and A45 (desktop) build on. It depends on A01 only. No
config schema, server route or SDK input changed, so no generator ran. No service, account or provider was called:
GitHub is a bare repository on this computer in the tests and its API answers are given.

## What changed

| Area | Files |
|---|---|
| Formats (shared with A44 and A45) | `packages/schema/src/vault.ts` (new): ids, `WrappedKey`, `Manifest`, `Snapshot`, the Vault API's request and answer shapes, error codes, `READER`/`MIN_READER`, limits |
| Core | `packages/core/src/vault/` (new): `crypto.ts` (keys, AES-256-GCM, HMAC ids, gear), `chunker.ts`, `format.ts` (object header, chunk and manifest sealing, `minReader`), `recovery.ts`, `vault.ts` (create, unlock, attach, backup, read, forget), `store.ts` (store interface, memory store), `github.ts` (GitHub backend), `remote.ts` (Vault API client), `error.ts` |
| Brain | `packages/core/src/brain/export.ts`: `decodeBackup`, `batches`, `restore({trust: "vault"})`, `RESTORE_VERSIONS` |
| CLI | `packages/engine/src/cli/cmd/vault.ts` (new), registered in `packages/engine/src/index.ts` |
| Vector Local | `packages/core/src/local-mode/sources.ts`: source `brain-vault` (blocked under Vector Local) |
| Docs | `docs/vector/MODEL-PLANS.md` (Brain Vault section), `codium-deviations.md` ("A43 Vault core and CLI") |
| Tests | `packages/core/test/vault/vault.test.ts` (P3), `packages/core/test/vault/github.test.ts`, `packages/core/test/vault/remote.test.ts`, `packages/engine/test/cli/vault.test.ts` |

No `api/_lib/model-plan-*.ts` file was edited.

## How it works

- **Keys.** One random 32-byte vault key per vault. HKDF-SHA-256 gives four keys: chunk and manifest keys (AES-256-GCM),
  the object-id key (ids are HMAC-SHA-256 of the plaintext, so equal chunks dedupe between versions and the store cannot
  test a guess) and the chunker key (the gear table, so cut points depend on a secret too).
- **Objects.** Each file is cut into content-defined chunks (gear hash, normalized chunking, 16/64/256 KiB min/avg/max),
  then each chunk is brotli-compressed (stored raw when that is not smaller) and sealed. A stored object is a 12-byte
  header (`VVLT`, format 1, kind, `minReader` uint16, compression, 3 zero bytes) and nonce ‖ ciphertext ‖ tag. The
  associated data is the header, the vault id and the object's id (the chunk's HMAC id, or the manifest's version id),
  so a piece cannot be renamed, moved to another vault, or have its header changed.
- **Manifest.** `{format: "vector-vault", version: 1, minReader, vault, id, createdAt, files: [{path, section, size,
  chunks, repository?, worktree?}], objects: [{id, size}]}`, sealed under the manifest key. A reader refuses a format or
  `minReader` above its own with "Update Vector" before it opens anything. A section it does not know is skipped when
  `minReader` allows it (B10 adds `skills` and `insights` and raises `minReader` where an old reader must not skip).
- **Recovery code.** 26 Crockford base32 symbols (130 random bits) plus 2 checksum symbols, seven groups of four, any
  case, O/I/L read as 0/1/1. scrypt N=2^17, r=8, p=1, 16-byte salt, wraps the vault key under AES-256-GCM with
  `vector-vault-key-v1:<vault id>` as associated data. A typo fails the checksum before scrypt; another code fails the
  tag. A reader accepts N from 2^14 to 2^20.
- **Backup.** Chunk and pack every file, declare every object with its stored size (`prepare`), send only the ones the
  store lacks, then the manifest (`commit`). A store the client prunes (GitHub) also drops versions past its 7 and the
  objects no kept version names, in the same commit.
- **Restore.** `VaultBackup.read` opens the manifest, fetches the chunks in batches of 1000, checks each against its
  HMAC id and each file against its size. The CLI then runs `BrainExport.restore({trust: "vault"})` per memory file:
  propose as an import, then approve and pin at once what the backup had in use and pinned; waiting entries wait again.
  Batches of 500 entries or 2 MB of JSON. Never a copy of brain.db.

## `vector vault`

- `backup [--github owner/repo]`: reads the memory first (nothing to back up makes no vault). The first backup creates
  the vault and prints the recovery code once. The key and the wrapped key go to `<data>/vault/vault.json` (0600; sealed
  with `VECTOR_CREDENTIAL_KEY` when the desktop started the engine). A `--github` different from the saved backend
  moves backups there (the wrapped key is written to the new store).
- `status`, `versions [--github]`: where backups go, the versions, the space used (bytes; the plan's quota on Vector's
  backend).
- `restore [version] [--github]`: this computer's key opens its own vault; another vault (a new computer) asks for the
  recovery code (`VECTOR_VAULT_RECOVERY_CODE` or a hidden prompt) and becomes the one this computer backs up to.
- `forget <version>`, `forget --everything --yes`.
- What a backup holds: `memory/personal.json` and one `memory/repository-<hash>.json` per repository in the engine's
  project list (plus the current directory's) that has learned entries. Each is the `vector-memory` export JSON.
- Without `--github` the CLI uses Brain Vault on Vector. A backup needs the account's status to list `vault` with a
  plan whose `vault.gb` is above 0 (H1); status, versions, restore and forget need only the sign-in, so a paused or
  ended plan can still restore in its read-only days (§4.4), and the API decides. Until A44 ships and the owner lists
  `vault`, a backup says to use `--github`.

## For A44 (Vault API)

Implement the routes in `packages/schema/src/vault.ts` exactly, or change both sides together:

- `GET /api/vault/setup` → `Setup` or 404 `VAULT_NOT_FOUND`; `POST {vault, key}` creates it once (409 `VAULT_EXISTS`
  for another vault id). Store the wrapped key as given; it is useless without the code.
- `POST /api/vault/uploads {version, objects ≤1000, manifest?}`: the client declares every object of the version,
  present or not, in batches, and the manifest's size in its last request. Reserve quota for the missing ones atomically
  before signing (402 `VAULT_QUOTA`), sign PUTs (≤900 s, exact `content-length`) only for those, and record the
  version's references. Answer `present` for the others.
- `POST /api/vault/commit {version, objects}`: HEAD what was signed and the manifest, delete and 409
  `VAULT_SIZE_MISMATCH` on a mismatch, answer `{snapshot}`. `objects` is the client's count, as a check.
- `GET /api/vault/snapshots` → `{snapshots (newest first), usage {usedBytes, quotaBytes}, readOnly, deleteAt?}`.
- `GET /api/vault/snapshots/:id` → `{snapshot, manifest: {url}}`; `POST {objects ≤1000}` → signed GET links;
  `DELETE` forgets the version. `DELETE /api/vault` deletes the vault.
- Object keys in R2 can be `<account hash>/objects/<id>` and `<account hash>/versions/<id>`; the ids are already
  keyed HMACs. The server collects unreferenced objects; the client never prunes Vector's store.
- Every route takes a `vct_` account token only (S3). Read-only states per §4.4 answer 409 `VAULT_READ_ONLY` to
  uploads and still serve snapshots.

## For A45 (desktop)

- Reuse `VaultBackup` and `VaultGitHub.store` with a desktop git runner (`VaultGitHub.Git`) and a labelled `send`, and
  `VaultRemote.store` for Vector's backend. Keep the vault key in `safeStorage`. Add the desktop call sites to the
  `brain-vault` source (they are listed as `planned`).
- The CLI's `vault.json` and the desktop's key store are separate today. A computer that uses both should share one
  vault; A45 decides whether the desktop reads the CLI's file or the CLI asks the desktop.
- "Warns on total repo size above 1 GB": `list().storedBytes` is the vault's size in the repository's tree.

## Tests run here (one file at a time)

| Package | File | Result |
|---|---|---|
| core | `test/vault/vault.test.ts` | 17 pass |
| core | `test/vault/github.test.ts` (real git, bare repository on this computer) | 8 pass |
| core | `test/vault/remote.test.ts` (a fake of A44's API and its signed links) | 2 pass |
| core | `test/brain/export.test.ts` (unchanged) | 7 pass |
| core | `test/local-mode/sources.test.ts` (unchanged; reads the new source) | 15 pass |
| engine | `test/cli/vault.test.ts` (Git.run, Vector Local) | 2 pass |
| engine | `test/compliance/egress-inventory.test.ts` (unchanged; reads the new call site) | 5 pass |

Typecheck: schema, core and engine pass. `vector vault --help`, `vault status`, `vault backup` (signed out, no
`--github`) and `vault versions` were run in an isolated data folder and print what they should.

## Not exercised anywhere

- `vector vault --github` against real GitHub: the CLI's remote and API addresses are fixed to github.com, and calling
  them is not allowed here. The store itself ran over real git against a local bare repository, and through the
  engine's `Git.run`.
- The Vector backend against a real Vault API: A44 is not built. `remote.ts` ran against an in-memory fake of the
  routes in `@vectordevai/schema/vault`; A44's tests should drive it against the real routes.

## Left for others

- A44: the Vault API and `brain-vault.sql`; the `vault` readiness check in `perkServices`; the `meters.vault` status
  meter; `/api/vault/cleanup`.
- A45: the desktop backup, Settings → Memory → Backup, the `vault.*` app settings (§4.15) and the warning above 1 GB.
- A57: account deletion erasing the vault (delete the wrapped key first).
- A60 / legal read: the privacy draft's `#vault` says "the desktop application encrypts each backup" and that Vault
  backs up "memory and learned skills". The CLI encrypts too, and main-built backups hold memory only (skills arrive with
  B10). The GitHub backend's privacy check reads GitHub's public API with the repository's name and no sign-in.
- `vector vault` is visible in `vector --help` now and its GitHub backend works on every plan; the owner may want it
  hidden until A45 and the legal read.
- Docs pages for `vector vault` (`docs-content.ts`, `brain-vault.md`) are not in A43's file list.
- bun.lock was already modified in the worktree before this work and is not mine; it is left out of the commit.
  Nothing was pushed.
