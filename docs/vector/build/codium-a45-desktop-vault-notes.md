# A45: Desktop vault and Settings → Memory → Backup

A45 brings Brain Vault to the desktop app. It adds Settings → Memory → Backup, a nightly backup while the app is open,
the free GitHub backend over the desktop's own git, and Brain Vault on Vector through A44's API. It builds on A43 (core
vault, formats, `BrainExport.restore`) and A44 (the Vault API). No service, account or provider was called: GitHub is a
bare repository on this computer in the tests, with its API answers given, and the Vault API is core's in-memory
store. Nothing was pushed or deployed.

## What changed

| Area | Files |
|---|---|
| Desktop main | `packages/desktop/src/main/vault-github.ts` (new): the GitHub store with the desktop's git, the Vector Local decision for git's remote, the labelled privacy check, the 1 GB warning. `vault-backup.ts` (new): the controller (backup, nightly schedule, versions, restore, forget, delete, the H1 check for Vector's backend). `vault-runtime.ts` (new): Electron wiring (store `vector-vault`, the key sealed with `vault-secrets.ts`, the engine's routes, broadcasts) |
| Desktop wiring | `ipc.ts` (`vault-*` handlers), `index.ts` (start and stop after the engine is up), `preload/index.ts`, `preload/types.ts` (`VaultAPI`), `renderer/index.tsx` (`platform.vault`) |
| App | `context/platform.tsx` (`VaultPlatform` and its types), `settings-v2/memory-backup.tsx` and `memory-backup-model.ts` (new), `memory.tsx` (the Backup tab where `platform.vault` exists), `memory-model.ts` (`MemoryTab` gains `backup`), `settings-memory.css`, `settings-registry.ts` (search keywords), `features/local/local-model.ts` (the `brain-vault` source's name) |
| Engine | `packages/engine/src/brain/vault-memory.ts` (new; the CLI's memory files and restore loop, now shared), `GET /memory/backup` and `POST /memory/restore` in the memory group and handlers, the CLI using `VaultMemory`, two exerciser entries |
| Core | `local-mode/sources.ts`: `brain-vault` and `git-remote` list the desktop call sites; `brain-vault` lost `planned` |
| SDK | regenerated (`memory.backup`, `memory.restore`, additive); the client generator changed nothing |
| Docs | `docs/vector/MODEL-PLANS.md` (Brain Vault: the desktop), `owner-actions/brain-vault.md`, `codium-deviations.md` ("A45 Desktop vault and Settings → Memory → Backup") |
| Tests | `packages/desktop/src/main/vault-github.test.ts` (the contract's), `vault-backup.test.ts`, `packages/app/src/components/settings-v2/memory-backup-model.test.ts`, `packages/engine/test/server/memory-vault.test.ts` |

No `api/_lib/model-plan-*.ts` file was edited. Nothing in `api/` changed.

## How it works

- **Where backups go.** A private GitHub repository the person owns (free on every plan), or Brain Vault on Vector,
  offered only while the account's status lists `vault` with `vault.gb` above 0 (H1). A backup to Vector reads the status
  first and refuses without it; the Vault API decides every upload anyway (S1).
- **The GitHub backend** is core's store (A43). The desktop gives it `git` from PATH with the person's own credentials,
  `GIT_TERMINAL_PROMPT=0`, Vector's own secrets kept out of git's environment, and a 10-minute limit per command. Each
  backup is one commit with no parent, which git pushes as a packfile with a lease. The repository is checked private
  through GitHub's API (`brain-vault`, unauthenticated) before every push; only a 404 or `private: true` lets it go. It
  keeps 7 versions, and after each backup the vault's size in the repository is compared with 1 GB for the warning.
  `ls-remote`, `fetch` and `push` are decided as `git-remote` on github.com before git starts. Nothing goes to
  vectordev.ai.
- **The vault key** is a record `{vault, key, wrapped, backend}`, sealed in-process with `vault-secrets.ts`, whose key the
  OS credential store holds through safeStorage. It is kept in the `vector-vault` store. The settings (`enabled`,
  `backend`, `githubRepo`, the last backup, the last error, the warning) are in the same store in the clear. Without a
  secure credential store no vault is made.
- **Back up now** reads the engine's memory (`GET /memory/backup`, owner-only). With nothing in memory it makes no
  vault. The first backup creates the vault and answers its recovery code once, even if the backup then fails. The
  Backup page shows the code with Copy and "I saved it"; it is never stored.
- **Nightly.** A check runs every 15 minutes, first 3 minutes after launch. The backup is due between 02:00 and 06:00
  local time when the last backup is 20 hours old, or at any time once it is 36 hours old (a computer asleep at night).
  Attempts are at least 1 hour apart in the night window and 6 hours apart otherwise. It never creates a vault.
- **Versions and restore.** The listing shows the versions, the storage used (the plan's quota on Vector, the
  repository's size on GitHub) and a read-only vault's deletion date. A restore uses this computer's key, or the recovery
  code for a vault made elsewhere; that vault then becomes the one this computer backs up to. Each memory file goes back
  through the engine (`POST /memory/restore`, owner-only, `BrainExport.restore` with `trust: "vault"`). Files are sent
  without evidence and documents, in parts of at most 500 entries and about 1.5 MB.
- **Forget and delete.** Forgetting a version with this computer's key also removes the pieces only that version named
  on GitHub; without the key, the next backup's pruning removes them. Deleting the vault deletes everything where
  backups go now; this computer forgets its key when the vault was its own.
- **Vector Local** blocks `brain-vault` (the privacy check, the Vault API) and decides `git-remote` for github.com. Every
  operation checks first and says "Vector Local keeps Brain Vault off" without sending anything.

## Tests run here (one file at a time)

| Package | File | Result |
|---|---|---|
| desktop | `src/main/vault-github.test.ts` (new; real git, a bare repository on this computer) | 7 pass |
| desktop | `src/main/vault-backup.test.ts` (new) | 17 pass |
| app | `src/components/settings-v2/memory-backup-model.test.ts` (new) | 6 pass |
| engine | `test/server/memory-vault.test.ts` (new; the engine's server on loopback) | 4 pass |
| engine | `test/cli/vault.test.ts` (unchanged; after the CLI refactor) | 2 pass |
| engine | `test/compliance/egress-inventory.test.ts` (unchanged) | 5 pass |
| core | `test/local-mode/sources.test.ts` (unchanged) | 15 pass |
| app | `settings-registry.test.ts`, `memory-model.test.ts`, `settings-v2/local-model.test.ts` (unchanged) | 14, 18, 15 pass |
| app | `features/local/local-model.test.ts` (unchanged; it failed before this work because A43's `brain-vault` had no name) | 39 pass |
| root | `test/no-project-wording.test.ts`, `test/no-topups.test.ts` (unchanged) | 2, 4 pass |

`vault-github.test.ts` covers the contract's two cases:
- A public repository, and any answer that does not prove the repository private (403, a redirect, a body without
  `private: true`), refuse the push: the bare remote has no refs afterwards.
- A whole desktop backup to a private repository goes through the controller with fetch replaced by a spy. Only GitHub's
  API is asked, once before each push. The global fetch, the sign-in, the status and the Vault API are never called, and
  no URL names vectordev.ai.

It also covers keeping 7 versions, the 1 GB warning, Vector Local refusing git's `ls-remote` and `push` and the privacy
check before they start, and reading git's subcommand.

Typecheck: engine, core, desktop (`tsgo -b`) and app (`tsgo -b`) are clean. The SDK build's `tsc --build` passed.

## CI only, or not exercised anywhere

- The Codium CI lane picks up the four new test files; none has run in CI yet. None needs a service.
- **Status on 8 Nov 2026.** Pushed with the A44–A50 batch (head `d5975d28`). Vector Codium run 42138157347 of `5a079cbd`
  was green (Codium tests job 127631456285). The file-level result for the four files is unconfirmed: the job logs read
  hold only their last ~5,000 lines, and these files are not in them.
- `packages/engine/test/server/httpapi-exercise/index.ts` gained `memory.backup` and `memory.restore`; the exerciser runs
  only in CI.
- `packages/app/src/browser-bundle.test.ts` walks the app bundle; the new app files import only `@vectordevai/schema/vault`
  and types. It was not run here.
- Nobody has looked at Settings → Memory → Backup in a browser or the running app, because no dev server runs on this
  Mac. Its model is unit-tested and the component typechecks.
- Never exercised anywhere: a push to real GitHub with real credentials (the tests push to a local bare repository),
  GitHub's real API, Brain Vault on Vector against the deployed Vault API (A44's tests drive A43's client against the
  routes), safeStorage sealing in a packaged app, and the nightly timer in a running app.

## Left for others, and owner decisions

- **Owner decision:** the Backup tab and its GitHub backend show on every plan now, as §1.1 lists "back up to my own
  GitHub" as free. Brain Vault on Vector appears only once `vault` is listed after the legal read (A60). The owner may
  prefer to hide the tab until then.
- **For A60 and the legal read:** the privacy draft's `#vault` says "the desktop application encrypts each backup".
  That is true, and the CLI encrypts too. Backups hold memory only; skills and insights come with B10. The GitHub
  privacy check sends the repository's name to GitHub's public API with no sign-in, from the desktop as from the CLI.
- **The desktop's vault is separate from the CLI's.** To use one vault from both, restore it in the CLI with the
  recovery code (`vector vault restore --github owner/repo`), or in the desktop. A43's CLI message "This computer's vault
  key is sealed by the desktop app. Run vector vault from Vector's desktop terminal." cannot be followed: the desktop's
  terminal does not pass the credential key to its children. It is shown only for a `vault.json` written with
  `VECTOR_CREDENTIAL_KEY` set, which the app never does. Left unchanged, because it is A43's file.
- The README that core's GitHub store writes says the backups were made by `vector vault backup --github`; from the
  desktop that wording is slightly off. It is A43's text and was left as it is.
- The desktop's GitHub sign-in is not used for these pushes; git uses the person's own credential helper.
- A57: account deletion does not touch this computer's key (it is local); the vault on Vector is erased by A44's
  provisioner.
- bun.lock was not touched. Nothing was pushed (the orchestrator pushes).
