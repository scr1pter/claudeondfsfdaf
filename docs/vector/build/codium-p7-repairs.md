# P7 phase review addendum (A45 and A46)

The P7 review decisions in `codium-deviations.md` ("P7 review decisions") named A44 and A47–A50 only, and "Lane status
(8 Nov 2026)" lists A45 and A46 as packages no phase review covered. This record holds those two reviews, in the format
of `codium-p6-repairs.md`. Each finding is marked confirmed or not after reading the code, cites file:line, and names
the regression test of its repair. Contract readings are in `codium-deviations.md` ("P7 review addendum (15 Nov 2026)").

## A45 desktop vault: main process and engine routes

Codium finish R45a, 15 Nov 2026. Part 1 of the A45 review; part 2 (R45b) reviews the renderer. Read on `codium-finish`
`ab784e44`. Line numbers are at `ab784e44` unless a line says "now". Scratch was under `/tmp/vector-v2/codium/r45a/`,
the root the task's first line names, as R36 and F28 used `/tmp/vector-v2/codium/r36/` and `/f28/`.

### Scope

Commit `c9cd1bdb`, restricted to `packages/desktop/src/main/vault-backup.ts`, `vault-github.ts`, `vault-runtime.ts`,
`vault-secrets.ts`, the vault handlers in `ipc.ts` (`:452-473`) and `index.ts` (`:86`, `:240`, `:669-670`),
`packages/engine/src/brain/vault-memory.ts`, `packages/engine/src/cli/cmd/vault.ts`, and the backup and restore routes
in `packages/engine/src/server/routes/instance/httpapi/groups/memory.ts` (`:913-935`) and `handlers/memory.ts`
(`:194-215`).

`git log --oneline c9cd1bdb..HEAD -- <those paths>` lists 24 commits. Each commit's first-parent diff on those paths was
searched for vault, backup and restore lines:

- `be5ac39e` (fix(hands): reconcile v2 services with computer authority), a merge. Its first-parent diff brings every
  A45 file into the Hands line (vault-backup.ts, vault-github.ts, vault-runtime.ts, vault-memory.ts, the CLI, the two
  routes and the ipc.ts and index.ts vault lines). The content is `c9cd1bdb`'s and is reviewed as such.
- `ebd6cba3` (chore(integration): join Hands with connected and cloud runtimes): the overlay-safe broadcast in
  `vault-runtime.ts` (`broadcastRendererStatus`, which skips the Hands overlay windows).
- `3b1ce6d5` (B10): the `skills` and `insights` sections, `minReader` 2 for learned content, and the engine's section
  checks in vault-memory.ts, the CLI, the restore payload and the restore handler.
- `eed4bc45`, and `5181e5fb`, its merge on the codium-wt line with the same first-parent diff on these paths: the CLI's
  owner gate (`CliOwnerGate.refuse` before backup, restore and forget), the desktop-sealed message now pointing at
  Settings → Memory → Backup, and line wrapping. Its memory.ts changes are main's other memory routes, not the vault
  lines.
- `23a37c0b`: re-wraps the restore's 2 MB refusal in `handlers/memory.ts`, with no change in behaviour; its other lines
  are the Codium helper routes.
- `2229637c` and `3e5d1bff`: bring `vault-secrets.ts` (the in-process sealing) onto their lines. Reviewed as the file
  is at HEAD.
- `90acb30c`: the learned-skill `restore` action in `groups/memory.ts` (a skill action, not Brain Vault).
- No vault line: `df0e3b1c`, `66ebcc06`, `31c4eb72`, `ae5e3e61`, `e3452398`, `16e09f55`, `1814300b`, `b7ba4fa9`,
  `01781909`, `2aa64b48`, `7f3e27a2`, `7c26a834`, `52d6ef88`, `d36a3607`, `914a9dec`. These are Hands, the browser,
  GitHub agents, the Ops UI, the hosted clients and other memory routes in the same files.

### Findings repaired here

**R45-1. Confirmed: a key record this launch cannot open locks Brain Vault on this computer.**
- Cause: `vault-runtime.ts:53-59` awaited `vaultSecrets.open(sealed, PURPOSE)` and `JSON.parse(opened.text)`. Both throw
  when the record does not open, for example after `secure-runtime.ts:37` made a new credential key because its file
  was gone, or when the record is damaged. `vault-backup.ts` reads the key before any recovery-code path: backup `:368`,
  versions `:454`, restore `:492` (before the code check at `:496`), forget `:593` and delete `:619`. Every operation
  failed with Node's "Unsupported state or unable to authenticate data". The person could neither restore with the code
  nor delete the vault. Delete was also half done once the read stopped throwing: `remove` (`:621`) cleared this
  computer's key and settings only when a record was read, so the remote vault was deleted while `settings.vault`,
  `enabled` and `last` stayed, and the nightly tick kept answering "Back up once from Settings to start."
- Repair:
  - `vault-runtime.ts` (now `:39-62`): the key adapter is the exported `vaultKeys`, which `startVault` passes. Its read
    returns undefined for a value that does not start with `vs1.`, and for a record that does not open
    (`.catch(() => undefined)`). Undefined means no key: the recovery code opens the vault and the next write replaces
    the record, which is not deleted on read. A vault record was only ever sealed in-process (A45 has always sealed
    with `vs1.`), so the prefix check means the credential store is never asked for one.
  - `vault-backup.ts` `decodeKeyRecord` (now `:65-68`) decodes the JSON text itself
    (`Schema.fromJsonString(KeyRecord)`) instead of a parsed value; its one caller is `vault-runtime.ts`.
  - `vault-backup.ts` `remove` (now `:625-641`). The vault deleted counts as this computer's (`mine`, now `:627`) when
    the place held no vault key, or when its vault is the one a readable record names or, while no record reads, the
    one `settings.vault` names. The settings name the vault of the key written with them (backup `:395-402` and
    `:421-427`, restore `:511-527`). Only then does Delete reset `vault`, `enabled`, `last` and the other run fields
    (`:631`). The key (`:630`) is cleared when a readable record names the deleted vault or the place held none, as
    before, or when no record reads while the credential store is open (`deps.keys.secure()`). Such a record never opens: the in-process seal
    depends only on the credential key, and a new one replaces it only when its file is gone (`secure-runtime.ts:37`).
    While the store is locked, `vaultKeys.read` answers undefined without trying (`vault-runtime.ts:48`). That record
    is kept, because it may open at the next launch.
  - Review fix, 15 Nov 2026. The first repair cleared the key whenever no record read
    (`!record || !held || held.vault === record.vault`), with the store locked too. Say a person backed up to vault A,
    moved the backups to a place holding vault B, and deleted B at a launch with the credential store locked. Delete
    then removed A's sealed key for good, and only A's recovery code could open A again. The current rule keeps that
    key and A's settings.
- Tests:
  - `vault-secrets.sign-ins.test.ts` "a Brain Vault key that no longer opens reads as no key, so its recovery code can
    restore it": a real record round-trips sealed with `vs1.`; after `setKey(randomBytes(32))`, for `vs1.broken`, and
    for a value only the keychain could open, `read()` is undefined, the record stays stored, and no credential-store
    call is made. The red run was the refactored adapter with the old read body (at HEAD `vaultKeys` is not exported,
    so the test cannot load the old file): 4 pass, 1 fail, with Node's GCM error.
  - `vault-backup.test.ts` "a key that no longer opens: a backup makes no second vault, the code restores it, and
    Delete clears this computer": with the record unreadable and the store holding the vault, a backup answers
    "already holds a vault" and no code, and the store's wrapped key is unchanged (core `vault.ts:31`); versions answers
    `mine: false`; a restore with the code writes the record again; Delete clears the key and settings, and no
    `nextAt` remains. It fails on the old `vault-backup.ts`.
  - `vault-backup.test.ts` "Delete while the credential store is locked keeps this computer's key; the settings forget
    only their own vault". The harness's `keys.secure` answers false and `keys.read` undefined. In the first part the
    place holds vault B, made after A's place was emptied, while the record and `settings.vault` are A's. Delete
    destroys B, never calls `keys.clear`, and keeps `settings.vault` and `last`. In the second part the settings name
    the deleted vault. Delete still keeps the key, and resets `vault`, `last` and `enabled`. It fails on the first
    repair (M5) and on the HEAD condition (M4). It also fails with the settings fallback (M7) or the store check (M6,
    M8) removed.

**R45-2. Confirmed: errors showed internal detail.**
- Cause: `vault-backup.ts:235-239` `message()` returned any Error's `.message`. That text reaches the renderer in every
  result, and backup's `fail()` (`:356-360`) also kept it in the clear as `settings.error`. Realistic cases:
  `desktopGit` runs `mkdir(options.cwd)` (`vault-github.ts:72`) and core `github.ts:120-129` runs `fs.stat` and
  `fs.mkdir`, so a failure there showed "EACCES: permission denied, mkdir '/Users/<name>/Library/…/vault-cache'".
  Store, crypto and Electron errors did the same. Spec 4.10 asks for plain copy for VAULT errors, and core
  `vault/error.ts:1-2` says so.
- Repair: `message()` (now `:236-241`) returns the text of a `VaultError` only, and the fallback for anything else. The
  errors the desktop throws on purpose are `VaultError`s now: in `vault-backup.ts` `storeFor` the Vector Local refusal,
  the sign-in, the plan's error and "not available on this account" (now `:309-324`, all `unavailable`); in
  `vault-runtime.ts` the key write and the engine's answers (`unavailable`), and "Update Vector to back up this
  engine's learned content." (`update`). `RestoreRefused` is unchanged; restore catches it by class. The log line
  `brain vault backup failed` with `{ nightly }` is unchanged.
- Fixture: "a backup that fails after the vault was made still answers the code" now throws
  `new VaultError("unavailable", "git could not push to octo/brain-vault")`, which is what core's GitHub store throws
  (`failed()`, `github.ts:115-118`). Its assertions are unchanged.
- Test: `vault-backup.test.ts` "an unexpected failure shows plain copy, never its own text, and logs nothing more": a
  store whose `readKey` rejects with an EACCES error naming `/Users/…` makes backup, versions, restore, forget (with a
  valid version id) and delete answer their fixed fallbacks; the settings never contain `/Users/`; the logs are exactly
  `[["brain vault backup failed", { nightly: false }]]`. It fails on the old source.

**R45-3. Confirmed: moving the backups while a backup ran recorded a backup the new place does not have.**
- Cause: `configure` (`vault-backup.ts:654-679`) ran outside `exclusive`, and backup's last write (`:421-434`) spreads a
  fresh `settings()` and writes `vault` and `last` there. A repository changed during a nightly run (the page disables
  only its own buttons) kept the new repository with the old one's version as its last backup, and `due()` (`:176-183`)
  then waited 20 to 36 hours before backing up to the new place.
- Repair: `configure` (now `:676-677`) answers busy for a move while an operation runs. The nightly on/off switch still
  saves.
- Test: `vault-backup.test.ts` "where backups go cannot change while a backup runs": with the memory read held, a move
  of the repository or the backend answers busy, the switch saves, the backup finishes against `octo/brain-vault` with
  `last` set, and the same move afterwards succeeds and clears `last`. It fails on the old source.

**R45-4. Confirmed: git's own text reached the person and the settings.**
- (a) Desktop, repaired: `vault-github.ts:110` answered `git could not start: ${error.message}` for any spawn error but
  ENOENT. It now answers fixed copy (now `:110-113`). Under Electron's Node such an error arrives as the child's `error`
  event and gets this copy. Tests (both skipped on Windows):
  - `vault-github.test.ts` "a git program that cannot start answers fixed copy, never the errno or its path" pins the
    line itself. `desktopGit` takes an optional test-only `command` (now `:66-67`, used at `:93`; the app always runs
    `git` from `PATH`). The test points it at an absolute path to a mode-0644 file, which Bun reports as the child's
    `error` event with EACCES. That is the branch Electron's Node takes. A probe under
    `/tmp/vector-v2/codium/r45a/eacces/` printed `error event EACCES`. The answer has exit code 127 and the fixed copy,
    with neither `EACCES` nor the folder. It fails with the old line alone restored (M9). Added after review, 15 Nov
    2026: under Bun a non-executable `git` found on `PATH` reports ENOENT and ENOEXEC throws from `spawn`, so the
    earlier test never reached this line.
  - `vault-github.test.ts` "git that cannot start shows plain copy, never the system's text" puts a file git cannot
    execute (ENOEXEC) first on `PATH`. It checks that the backup's message is one of the two plain texts, and that the
    settings name neither the errno nor the folder. Under Bun `spawn` throws here, so R45-2's fallback answers. This
    pins what the person sees through the controller, and it fails on the old `vault-backup.ts` (R45-2).
- (b) Core, not repaired here (A43 follow-up): `failed()` (`packages/core/src/vault/github.ts:115-118`) appends git's
  first stderr line, up to 200 characters, to a `VaultError("unavailable")`, so it is shown and kept in
  `settings.error`. git's stderr can name local paths ("fatal: could not create …"). With the person's own
  `url.<base>.insteadOf` rewriting github.com to a URL that carries a user and token, it can carry that URL. A43's
  reading that "the URL carries no credential" holds only for Vector's own URL. The repair belongs in core's store:
  drop the stderr line, or keep it only after removing anything that looks like a path or a URL. That file is A43's
  and outside R45a's restricted scope, so it is recorded under For the lead.

### Checks that hold

- **R45-5. No plaintext memory, key or recovery code leaves the machine, and nothing secret is logged.** Confirmed by
  reading. The code exists only in `VaultResult` (`vault-backup.ts:111-113`, `:359`, `:439`) and is never stored; the
  existing test "the first backup creates the vault and answers its code once" checks the settings and the record.
  IPC returns results and status only (`ipc.ts:452-473`); `handle()` asserts a trusted renderer (`ipc.ts:258-262`).
  The broadcast skips the Hands overlay (`vault-runtime.ts:31-33`, `renderer-status.ts`). Memory goes to the engine
  only over loopback with `redirect: "error"` (`vault-runtime.ts:98-102`, `:126-137`). The Vault API and GitHub get
  only sealed objects (core `vault.ts`). The only log line is the one R45-2 pins.
- **R45-6. safeStorage sealing and its fallback.** Confirmed. The record is AES-256-GCM with the purpose as AAD, under
  the key derived from the launch's credential key (`vault-secrets.ts:29-34`; `secure-runtime.ts:49`). Without a
  secure store there is no vault (`vault-backup.ts:361-364`; `vaultKeys` returns undefined and refuses to write).
  `290b8a04` is an ancestor of `c9cd1bdb`, so A45 has always sealed with `vs1.`, and the keychain fallback
  (`vault-secrets.ts:55-68`) never served a vault record. R45-1's prefix check now makes that explicit.
- **R45-7. The recovery code is shown once and never kept.** Confirmed: the CLI prints it once
  (`cli/cmd/vault.ts:290-297`) and the desktop as in R45-5. The renderer keeps it in a signal (`memory-backup.tsx:46`);
  that is part 2's.
- **R45-8. Restore refuses another account's vault or a tampered manifest.** Confirmed by reading: the header and AAD
  bind the vault id and version (core `format.ts:43-52`, `:119-139`), the wrapped key's AAD is
  `vector-vault-key-v1:<vault>` (`recovery.ts`), `attach` refuses a mismatch (`vault.ts:51-57`), and the desktop asks
  for the code when the store's vault is not its own (`vault-backup.ts:490-505`). Core `vault.test.ts` already covers
  another vault, moved or tampered pieces and the reader check, so no desktop copy of those cases was added.
- **R45-9. minReader and "Update Vector".** Confirmed. `READER` 2, `MIN_READER` 1, `LEARNED_READER` 2
  (`schema/vault.ts:13-17`); a backup with a skills or insights file asks for reader 2 (core `vault.ts:105-106`); the
  header and the manifest's own `minReader` are checked (`format.ts:48`, `:132`). The desktop refuses an unknown section
  from the engine (`vault-runtime.ts:110-111`, now a `VaultError("update")`). Tests: `vault-backup.test.ts` "a version
  that needs a newer Vector is refused with Update Vector, and nothing is restored" (a manifest sealed with
  `minReader: Vault.READER + 1` under the record's keys; this also shows a `VaultError("update")` still reaches the
  desktop's result after R45-2), and "learned sections keep their section and ask for reader two; they restore whole".
  Both pass before and after.
- **R45-10. Not confirmed: B10's learned files are not shown to fit the engine's 2 MB restore limit.** The desktop sends
  a skills or insights file whole (`vault-backup.ts:540-541`; no `restoreParts` split), and the engine refuses more than
  `IMPORT_CHARS`, 2 MB (`groups/memory.ts:276`, `handlers/memory.ts:204-205`), which the desktop counts as unreadable
  without saying why (`vault-runtime.ts:138`). Insights are bounded: `BrainTransfer.insights` keeps 100 rows with a
  model of at most 512 and an effort of at most 80 characters (`core/src/brain/transfer.ts:24-33`), about 70 KB, and
  `decodeInsights` refuses more than 256 KB (`:36-38`). Skills are not: `BrainExport.collect` lists `skills.list(place,
  "all")` (`core/src/brain/export.ts:64-66`), which is active, proposed, quarantined, archived and superseded rows
  (`core/src/brain/skill.ts:1484-1494`). That is 50 active and 100 archived per repository (`skill-store.ts:42-53`)
  plus superseded rows kept 180 days, each with a procedure of up to 4,000 characters (`skill.ts:37-53`), its paths,
  steps and evidence, before JSON escaping. 150 rows × 4,000 characters is already 600,000; escaping and superseded
  rows can pass 2 MB. Backup checks no size, so such a backup would hold a skills file that never restores. Not
  measured; recorded for B10 (split skills files at backup, or cap them). The learned-sections test does not prove the
  bound.
  - Status, 15 Nov 2026 (Codium finish B10): confirmed by measurement, and repaired.
    - Measured: a worst case built through the routes (50 skills in use, one archived, 20 waiting, each with the longest
      description and procedure and 20 paths of about 1,200 characters) gave one skills file of 2,329,515 characters
      at `4bd146e7`, past `IMPORT_CHARS` (2,097,152).
    - Repair in `engine/src/brain/vault-memory.ts` (`restorable`, `SKILLS_CHARS`): a backup now holds only the skills
      in use or waiting, without evidence, cut into files of at most 1,500,000 characters. The worst case gives two
      files, of 1,474,680 and 819,282 characters, and both restore.
    - Test: `engine/test/server/memory-vault.test.ts` "a skills backup holds only what a restore brings back, without
      evidence, in files under the restore limit (R45-10)". It fails at HEAD's `vault-memory.ts` (one file).
    - Also recorded there: a restore takes at most 20 skill proposals per repository (B10-3, not changed). The backup
      puts the skills in use before those waiting, so the 20 a restore keeps are approved ones; the same test asserts
      it.
    - Evidence: `codium-deviations.md`, "Codium finish: B10 acceptance (15 Nov 2026)". CI pending.
- **R45-11. The GitHub backend.** Confirmed. The privacy check is unauthenticated with `redirect: "manual"`, and only a
  404 or `private: true` passes (core `github.ts:60-87`); it runs before every push (`:182`). git runs with
  `untrustedChildEnvironment(process.env)`, which drops `VECTOR_*_TOKEN`, `_KEY`, `_SECRET` and `_PASSWORD`
  (`child-environment.ts:163-174`), plus `GIT_TERMINAL_PROMPT=0` (`vault-github.ts:73-80`). No credential flag is
  passed, the remote is a plain https URL (`vault-github.ts:137`), and nothing writes a remote into the bare copy. Only
  push overrides `core.hooksPath` (core `github.ts:205`); the person's own git config (insteadOf, global hooks on fetch
  and update-ref) applies, as for any git they run. Test: `vault-github.test.ts` "git gets only the person's own
  credentials: no token in an argument, the environment, the remote or the copy's config" records every argument and
  the core-supplied environment keys of a create and a backup, and reads the copy's `config`. It then sets
  `VECTOR_CREDENTIAL_KEY`, `VECTOR_CLOUD_TOKEN` and `VECTOR_X_SERVER_PASSWORD` and unsets `GIT_ASKPASS`, `SSH_ASKPASS`
  and `GIT_TERMINAL_PROMPT` (a shell may already set the last one, and here it did). Through `desktopGit` it runs
  `git -c "alias.probe=!printenv <names>; true" probe` for those names only, never the whole environment. None of the
  three secrets reaches git, `GIT_TERMINAL_PROMPT` is `0`, and no askpass is set. Where a value could be a secret only
  counts are compared, so a failure never prints one. It fails with the full environment passed (M10) or without
  `GIT_TERMINAL_PROMPT=0` (M11). Review fix, 15 Nov 2026: the first version ran `!env`, which read the whole
  environment into the test. The tests set `GIT_CONFIG_GLOBAL=/dev/null`, so a real
  credential helper is never exercised.
- **R45-12. Path handling: no traversal and no symlink escape.** Confirmed by reading.
  - `parseRepo` allows one segment each for owner and name, never `.` or `..` (core `github.ts:50-54`); the copy is
    `<userData>/vault-cache/github/<owner>/<name>.git` (`vault-runtime.ts:43`, now `:71`; `vault-github.ts:142`).
  - Version ids are checked by regex in forget (`vault-backup.ts:589`), by `has()` in core `github.ts:313`, and by
    `encodeURIComponent` in core `remote.ts:106`. Manifest paths are never used as file paths; the desktop sends none
    to the engine (`vault-runtime.ts:129-134`).
  - Symlinks: core's `init` (`github.ts:120-129`) runs `fs.stat` and `fs.mkdir(recursive)` and push runs `fs.rm` on the
    index, all of which follow symlinks. Planting one needs write access to `userData` (Application Support on macOS,
    `~/.config` on Linux). The shell sandbox lets commands write only the workspace, the working directory, the temp
    folder and the package caches (`engine/src/tool/shell/sandbox.ts:97`, the `CACHES` list, and `:352-358`, the
    writable list), so a sandboxed command cannot reach the desktop's copy. Without the sandbox a command can write
    anything the person can, this copy included, as for every file of theirs. The CLI's copy is different (R45-20).
  - The restored worktree: `vault-memory.ts:105` makes `worktree` the `Place.root` of another repository. Its uses are
    the failure file's name, a hash of the root (`core/src/brain/brain.ts:526`, `paths.ts:28-31`); `fs.stat` of a
    skill's paths (`skill-store.ts:380`); and the evidence stale check, which reads a cited file only to set a stale
    flag (`brain.ts:2718`). All are reads, and nothing read leaves the computer. Memory restores carry no evidence
    (`restoreParts`); a skills file goes whole and waits for review. The backup is the person's own, opened with their
    key.
- **R45-13. The nightly timer cannot overlap itself.** Confirmed by reading: `exclusive` sets `running` before it awaits
  (`vault-backup.ts:325-335`), `check()` returns while running (`:681-685`), `start()` is guarded (`:696-702`),
  `startVault` runs once per launch (`vault-runtime.ts:40`; `index.ts:669-670`) and `stopVault` only at quit
  (`index.ts:240`). The existing "one operation at a time" test covers `exclusive`; no timed test was added.
- **R45-14. The backup and restore routes are the local owner's only, and not in the phone's Remote allowlist.**
  Confirmed. `isOwnerOnlyRoute` covers `/memory` and `/memory/*` (`packages/server/src/auth.ts:197`); `refusedRequest`
  refuses a guest and owner credentials with the forwarded-guest marker (`auth.ts:167-173`). `REMOTE_ROUTES`
  (`remote-routes.ts:50-76`) names no `/memory` route, and Remote calls the engine with owner credentials
  (`remote-runtime.ts:37`), so the allowlist is the only gate. Tests: `remote-routes.test.ts` "a paired phone never
  reaches the memory routes, Brain Vault's backup and restore among them" (no allowlisted path under `/memory`; six
  memory routes answer 403 `REMOTE_ROUTE_REFUSED`; the engine hears nothing) and engine
  `test/server/memory-vault.test.ts` "owner credentials carrying the forwarded-guest marker get 403 from the backup and
  the restore". Both pass before and after.
- **R45-15. Vector Local refuses the network backends.** Confirmed. `localRefusal` (`vault-backup.ts:736-750`) runs
  before any store or sign-in (`:305-308`); `brain-vault` is `local: "blocked"` (core `local-mode/sources.ts:404`),
  which `policy.ts:225-234` blocks unless the person allows it; `desktopGit` refuses commands that connect
  (`vault-github.ts:68-71`) and sets `GIT_ALLOW_PROTOCOL=file` under Web access None (`:78`). Test:
  `vault-github.test.ts` "Vector Local refuses both network backends before anything is asked" (both backends allowed
  with Local off, both refused with Local on). The existing controller test covers the "before any store" order.
- **R45-16. Engine errors.** Confirmed. The designed refusals are plain copy (`handlers/memory.ts:205`, `:208`);
  unexpected failures answer a generic message with a reference (`middleware/error.ts:39-55`), and the local server
  log keeps the detail.
- **R45-17. The CLI.** Confirmed. The owner gate guards backup, restore and forget (`cli/cmd/vault.ts:267`, `:421`,
  `:494`; `owner-gate.ts:13-16`). `eed4bc45` changed the desktop-sealed message to "Open Settings → Memory → Backup in
  Vector.", which settles the A45 notes' "Left for others" item about the old message.
- **R45-23. Formatting.** Some B10 lines are not prettier-formatted (`vault-memory.ts:72-73`, `:95`, `:107-111`;
  `vault-backup.ts:540-541`; `cli/cmd/vault.ts:433`). Kept; R45a's own lines are prettier-clean.

### For the lead (recorded, not repaired here)

- **R45-4(b).** Core's `failed()` (`packages/core/src/vault/github.ts:115-118`), as above. A43's file, outside this
  package's scope.
- **R45-18. Confirmed: an exported `VECTOR_VAULT_RECOVERY_CODE` reaches agents' shells.** The CLI reads it
  (`cli/cmd/vault.ts:214`). `privateRuntimeKey` (`packages/core/src/child-environment.ts:163-174`) drops `VECTOR_*`
  names ending `_TOKEN`, `_KEY`, `_PASSWORD` or `_SECRET` and the names in `PRIVATE_RUNTIME_ENVIRONMENT` (`:5-14`), and
  `_CODE` is neither. A probe through `vector-serial` (a temporary file run from `packages/core`, removed afterwards;
  the copy is under `/tmp/vector-v2/codium/r45a/probe/`) printed `{"recoveryCodePasses":true,"cloudTokenPasses":false}`.
  A person who exports the code in their shell profile hands it to every command `vector` starts. The repair is one
  name in `PRIVATE_RUNTIME_ENVIRONMENT`, in core's shared child-environment file. The critique's alternative, deleting
  the variable inside `vault restore`, does not help: agents' shells inherit from the long-running `vector` process,
  not from `vault restore`.
- **R45-19. Confirmed: the shell sandbox does not hide the CLI's vault key file.** `credentialStorePaths`
  (`packages/engine/src/tool/shell/sandbox.ts:496-514`, with `CREDENTIAL_FILES` at `:83`) lists `auth.json`,
  `mcp-auth.json`, `cli-auth.json`, `plugin-oauth-approvals.json` and the databases, not `<data>/vault/vault.json`
  (`cli/cmd/vault.ts:39`). That file holds the vault key in plain base64url when the CLI has no credential key
  (`cli/cmd/vault.ts:88-93`). The repair is one entry in the sandbox's deny list (the native-isolation lane's file).
- **R45-20. Confirmed: a sandboxed command can plant git configuration in the CLI's vault copy.** The CLI's bare copy is
  `Global.Path.cache/vault/github/<owner>/<name>.git` (`cli/cmd/vault.ts:168`), and the sandbox keeps `~/.cache`
  writable on purpose (`sandbox.ts:97-98`, `:356`; its comment calls the caches the policy's soft spot). A planted
  `config` (`credential.helper=!…`) or hook (`reference-transaction` runs on fetch and update-ref; core overrides
  `core.hooksPath` only for push) would run outside the sandbox at the next `vector vault backup`. It needs
  `VECTOR_SHELL_SANDBOX`, or Web access None, to matter at all. Two repair sites: move the CLI's copy to
  `Global.Path.data` (this lane's CLI file), or deny the copy in the sandbox. Left for the lead because it changes the
  CLI's on-disk layout and touches the sandbox's chosen soft spot.
- **R45-21. Reading: `versions()` is not exclusive** (`vault-backup.ts:449-479`). It can fetch into the same bare copy
  while a backup runs and answer a transient "changed while Vector read it". Not a defect.
- **R45-22. Reading for A41's next review:** `remote-runtime.ts:43-45` reads its sealed identity the way R45-1
  repaired: a record that no longer opens throws.
- **For R45b (the renderer):** `memory-backup.tsx:88-89` shows a thrown IPC message (`ipc.ts:456` throws "Vector is
  still starting. Try again in a moment.", which is plain), and the code lives in a signal (`:46`).
- **For A60's legal read (owner):** the A45 notes' "For A60 and the legal read" item says "Backups hold memory only;
  skills and insights come with B10". B10 (`3b1ce6d5`) has landed, so backups now also carry `skills` and `insights`
  sections. No privacy text was changed and the privacy patch was not applied.

### Mutations

Each was applied with an exact one-occurrence substitution, run, and restored; `diff -q` against the saved file
confirmed each restore.

| Mutation | Turns red |
| --- | --- |
| M1: drop R45-1's `.catch(() => undefined)` | the sign-ins Brain Vault key case |
| M1b: drop R45-1's `vs1.` prefix check | the sign-ins Brain Vault key case (the keychain is asked) |
| M2: restore `if (error instanceof Error && error.message) return error.message` | "an unexpected failure shows plain copy" |
| M3: drop `if (moved && state.running) return busy()` | "where backups go cannot change while a backup runs" |
| M4: the HEAD delete condition `record && (!held \|\| held.vault === record.vault)` for both the key and the settings | "a key that no longer opens" and "Delete while the credential store is locked" |
| M5: the first R45-1 condition `!record \|\| !held \|\| held.vault === record.vault` for both | "Delete while the credential store is locked" |
| M6: clear the key whenever no record reads (`record ? mine : true`) | "Delete while the credential store is locked" |
| M7: drop the settings fallback (`held.vault === record?.vault`) | "a key that no longer opens" and "Delete while the credential store is locked" |
| M8: no record counts as this computer's vault (`record ? … : true` for `mine`) | "Delete while the credential store is locked" |
| M9: the old spawn-error line `` `git could not start: ${error.message}` `` | "a git program that cannot start answers fixed copy" |
| M10: `...process.env` in place of `untrustedChildEnvironment(process.env)` | "git gets only the person's own credentials" |
| M11: drop `GIT_TERMINAL_PROMPT: "0"` | "git gets only the person's own credentials" (it passed until the test unset the variable the shell had set) |

The whole new `vault-backup.test.ts` against the HEAD `vault-backup.ts`: 19 pass, 4 fail (the R45-2 and R45-3 cases
and both R45-1 cases). The new `vault-github.test.ts` against the HEAD `vault-backup.ts` and `vault-github.ts`: 9 pass,
2 fail (both R45-4(a) cases). M5 to M11 and these two runs were made after the review, on 15 Nov 2026, with the same
method (scratch under `/tmp/vector-v2/codium/r45a/mut2/`).

### Tests run here (one file at a time)

Through `vector-serial` with `--timeout 30000`, from each package directory: desktop with `bun --no-env-file test`;
engine with `bun test` (its preload sets its own XDG roots) and `TMPDIR` under the scratch root; core with
`XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `TMPDIR` under the scratch root.

| Package | File | Before (HEAD `ab784e44`) | After |
| --- | --- | --- | --- |
| desktop | `src/main/vault-backup.test.ts` | 17 pass | 23 pass (140 `expect()` calls) |
| desktop | `src/main/vault-github.test.ts` | 7 pass | 11 pass (66) |
| desktop | `src/main/vault-secrets.test.ts` | 6 pass | 6 pass (131) |
| desktop | `src/main/vault-secrets.sign-ins.test.ts` | 4 pass | 5 pass (38) |
| desktop | `src/main/remote-routes.test.ts` | 15 pass | 16 pass (130) |
| engine | `test/server/memory-vault.test.ts` | 5 pass | 6 pass (23) |
| engine | `test/cli/vault.test.ts` | 2 pass | 2 pass (6) |
| core | `test/vault/vault.test.ts` | 18 pass | 18 pass (102) |

Typecheck: `bun typecheck` clean in `packages/desktop` (`tsgo -b`), `packages/engine` and `packages/core`. After the
review fixes (desktop files only) the four desktop `vault-*` files and the desktop typecheck were run again.
`prettier --check` (run through `vector-serial`): `vault-runtime.ts`, `vault-backup.test.ts`, `vault-github.test.ts`
and `vault-github.ts` are prettier-clean; `vault-backup.ts`, `remote-routes.test.ts` and `memory-vault.test.ts` were
not prettier-clean at HEAD, and their prettier differences now are exactly the lines that differed at HEAD, so every
line this package touched matches prettier. `git diff --check` clean. The full turbo typecheck and the api tree are
pre-push steps and were not run during the review. Commit gate, 15 Nov 2026: the four changed desktop test files
(`vault-backup`, `vault-github`, `vault-secrets.sign-ins`, `remote-routes`), `vault-secrets.test.ts` and the engine's
`memory-vault.test.ts` were run again one at a time, with the "After" counts above; `bun typecheck` in
`packages/desktop` and `packages/engine`, the full `bun turbo typecheck --concurrency=2` (27 of 27 tasks) and the api
tree (`bun typecheck --project ../../tsconfig.json` from `packages/engine`) were clean.

**CI only:** the HttpApi exerciser (no route changed), Vector Codium's Codium tests job (it selects the changed test
files since the base), typecheck.yml, and vector-hosted-ci.yml's Hosted tests job, which runs the desktop `vault-*` and
`remote-*` files and core's vault tests whatever changed. CI: pending; the change is uncommitted, and the run and job
ids go in a dated line here in the lane commit that follows the runs. Never exercised: safeStorage in a packaged app, a
real credential helper, a push to real GitHub, and Electron's Node itself. R45-4(a)'s `error`-event branch is run
under Bun with the EACCES case.

CI, 15 Nov 2026 (R45a, `420e729f`), recorded by R45b. Vector Codium run 43700085301 (dispatched with base
`origin/release-finish`): 16 of its 18 jobs ran and all passed but one. The two Hosted services jobs the lane's call
skips (`services_only`) were skipped. Codium tests job 132769096737 failed only in "Run HttpApi exerciser gates";
"Run the Codium test files" and "Check generated client" passed. The exerciser's visible tail reads
`summary pass=359 fail=0 skip=0 missing=4 extra=0`, with exactly these MISS lines and no FAIL:
`DELETE /experimental/review-memory/previews/{previewId}`, `GET /experimental/review-memory`,
`POST /experimental/review-memory/confirm` and `POST /experimental/review-memory/prepare`. That is the baseline the
lane counts as green. Codium browser specs job 132769097037, the relay (132769096985), the ops Worker
(132769097338), the Docker image (132769097274) and the 11 typecheck jobs passed. typecheck.yml run 43700088239:
success. vector-hosted-ci.yml run 43700704217: all 12 jobs passed. Its Hosted tests job 132770987031 ends with
"Hosted: 143/143 test files passed". That job runs the desktop `vault-*` and `remote-*` files and core's vault tests,
but their own lines were not read here, so no per-file count is claimed.

`handlers/memory.ts` and `groups/memory.ts`: unchanged.

Edits to `api/_lib/model-plan-*.ts`: none.

## A45 Settings → Memory → Backup

Codium finish R45b, 15 Nov 2026. Part 2 of the A45 review: the renderer, the bridge and Vector Local's inventory.
Read on `codium-finish` `420e729f`. Line numbers are at `420e729f` unless a line says "now". Scratch was under
`/tmp/vector-v2/codium/r45b/` (the HEAD copies in `head/`, the mutation runs in `mut/`, the fresh XDG and `TMPDIR`
roots in `xdg/`).

### Scope

`packages/app/src/components/settings-v2/memory-backup.tsx` (464 lines) and `memory-backup-model.ts` (135), with
`memory-backup-model.test.ts`; the Backup wiring in `memory.tsx` (`:17-18`, `:86-88`, `:234-236`) and
`settings-registry.ts` (`:139-144`); the vault types in `packages/app/src/context/platform.tsx` (`:78-140`, `:258-259`);
`packages/app/src/features/local/local-model.ts:111`; `packages/core/src/local-mode/sources.ts` (brain-vault
`:397-412`, git-remote `:634-648`); the vault calls of `packages/desktop/src/preload/index.ts` (`:99-112`) and
`preload/types.ts` (`:99-100`, `:147-157`, `:933`); and `packages/desktop/src/renderer/index.tsx:273`.

`git log c9cd1bdb..HEAD` lists no commit on `memory-backup*.ts(x)`. The vault block of the preload and the vault types
in `platform.tsx` are byte-identical to `c9cd1bdb`. The later commits on the other files, by first-parent diff:
`be5ac39e` is the merge that brings A45's renderer lines into the Hands line with `c9cd1bdb`'s content; `23a37c0b`
changes only `memory.tsx:170`, the subtitle "an encrypted backup when those features are available" (text). The other
29 commits on these files have no vault, backup, restore or recovery line.

Two repairs reach outside the listed scope, because the cause is in the main process: `vault-backup.ts` (the restore
totals, R45-25) and `vault-runtime.ts` (the startup status, R45-27).

### Findings repaired here

**R45-24. Confirmed: a call that throws showed Electron's text.**
- Cause: `act`'s catch (`memory-backup.tsx:89-90`) showed `cause.message`. A rejected `ipcRenderer.invoke` reads
  "Error invoking remote method '<channel>': Error: …" around the main process's error. Brain Vault's own refusals are
  results, never throws (R45-2), so what still throws is `ipc.ts:456`'s "Vector is still starting…" (every vault call
  but status, before `startVault`), `assertTrustedRenderer` (`ipc.ts:260`) and structured-clone failures. None of
  them is copy written for the person.
- Repair (now `:98-101`): the catch shows "Vector could not do that. Try again.", which was already the fallback. This
  differs on purpose from the repository's other handling: `desktop/src/renderer/initialization.ts:7-11` and
  `vercelErrorText` (`app/src/features/cloud/vercel/vercel-api.ts:210-214`) strip Electron's prefix and keep Vector's
  own sentence. Here the one plain thrown sentence ("still starting") can no longer be reached from the page once
  R45-27 shows no controls while starting, so nothing worth keeping is left after the prefix.
- Test: `memory-backup.test.tsx` "a restore is sent once however fast it is pressed; a failure frees the page and shows
  plain copy". The rejection carries Electron's text; the alert reads exactly the fixed copy and the page holds no
  "Error invoking". Red on the HEAD component (it showed the whole Electron text); M1.

**R45-25. Confirmed: B10's learned skills and workflow insights restore as proposals, but the page said they came back
"as before".**
- Cause: the engine imports a skills or insights file through `BrainExport.importText`, where each entry and skill
  waits for approval (core `brain/export.ts:270-315`), and answers `active: 0, waiting: <restored>` (engine
  `brain/vault-memory.ts:106-111`). The desktop added every section into `active`, `pinned` and `waiting`
  (`vault-backup.ts:561-566`), and the page read that as "N waiting for your review as before"
  (`memory-backup-model.ts:89`) under a card that says "what waited for your review waits again"
  (`memory-backup.tsx:326-329`). Spec B10 (`codium-build-spec.md:949`) says "restored as drafts for review".
- Repair:
  - Desktop: `VaultRestoreResult.totals` gains `skills` and `insights` (now `vault-backup.ts:136-143`). In the restore
    loop, `restored`, `known` and `refused` still add for every file; a `skills` or `insights` file then adds its
    `restored` to its own count and nothing to `active`, `pinned` or `waiting` (now `:572-584`). Only memory files
    count as "as before".
  - App: the same two fields in `platform.tsx`'s `VaultRestoreResult`. `restoreLine` adds "N learned skill(s) to
    review" and "N workflow insight(s) to review" after the waiting part, each only above 0 (now
    `memory-backup-model.ts:95-96`). A restore that brought back only learned content leaves out the "in use" and
    "waiting … as before" parts, which would read "0 … as before" (now `:90-94`); with no learned content they show
    even at zero. The card now shows `RESTORE_COPY` (now `:131-132`, used at `memory-backup.tsx:341`),
    which says learned skills and workflow insights come back as proposals for you to review. The page's description
    (now `:203-205`) names them as part of a backup.
- Tests: `vault-backup.test.ts` "learned skills and workflow insights come back as proposals, counted apart from memory
  (B10)" (memory answers 3 restored, 1 in use, 1 pinned, 2 waiting; skills 2 waiting; insights 1 waiting and 1
  refused; totals are 6 restored, 1, 1, 2 waiting, 2 skills, 1 insight). Red on HEAD (`waiting` 5, no `skills`); M3.
  `memory-backup-model.test.ts` "learned skills and workflow insights come back as proposals for review, never as
  before (B10)", whose learned-only and nothing-new cases pin the exact lines; M4.

**R45-26. Confirmed (copy accuracy): Vector Local's inventory said Brain Vault sends memory only.**
- Cause: since B10 a backup also carries `skills` and `insights` files (`vault-memory.ts:72-78`). `sources.ts:402-403`
  said "Your Brain's memory, encrypted on this computer…" and "backs up and restores your memory when you ask". That
  text is the Vector Local list (`settings-v2/local.tsx:734`), the "Sends" fact of the allow dialog
  (`features/local/allow-dialog.tsx:80`) and the blocked notice (`features/local/local-model.ts:337`).
- Repair (now `sources.ts:402-403`): "Your Brain's memory, learned skills and workflow insights, encrypted on this
  computer, …" and "Brain Vault: backs up and restores your memory, learned skills and workflow insights when you
  ask". `local: "blocked"`, the hosts and the call sites are unchanged. No generated file, doc or web page holds this
  text. This is the in-app network inventory, not privacy or legal text; the allow-dialog wording is named for the
  owner's A60 read next to the privacy draft's `#vault` item (For the lead).
- Test: core `test/local-mode/sources.test.ts` "Brain Vault says a backup carries memory, learned skills and workflow
  insights, and Vector Local blocks it". Red on HEAD; M8.

**R45-27. Confirmed: a Backup page opened while Vector starts showed a stand-in status as real and never got the real
one.**
- Cause: until `startVault` runs, `vault-status` answers `vaultStarting()` (`ipc.ts:459`; `vault-runtime.ts:104-106`):
  nightly off, the GitHub backend, no repository, no vault. `startVault` runs only after `serverReady`
  (`index.ts:586`), the health wait and `vectorAccount.restore()` (`:656`), at `index.ts:669`, and broadcast nothing
  (`vault-runtime.ts:64-93`). The page read the status once (`memory-backup.tsx:61-68`) and took the repository only
  from that read (`:66`). A person with a vault saw nightly off, no repository and "Back up once to create your vault
  and get its recovery code", and every control threw (R45-24).
- Repair:
  - Desktop: `VaultStatus.starting?: true` (now `vault-backup.ts:86-87`); `vaultStarting()` sets it (now
    `vault-runtime.ts:107`); `startVault` broadcasts `backup.status()` right after `backup.start()` (now `:93-94`).
  - App: the same optional field in `platform.tsx`. One `accept` (now `memory-backup.tsx:63-71`) takes both the page's
    own read and `onChange`. It ignores a `starting` status once a real one is held, which covers the start broadcast
    arriving before the answer to the page's read. It sets the repository field from the first real status. The outer
    `Show` (now `:192-195`) renders no control while the status is `starting` and shows `STARTING_COPY` ("Vector is
    still starting. Brain Vault shows here once it has started.", now `memory-backup-model.ts:135`), so the page sends
    nothing before Brain Vault has started.
- Tests: new `packages/desktop/src/main/vault-runtime.test.ts` "before Brain Vault starts its status says so; once it
  starts, every open window gets its real status" (the stand-in carries `starting: true`; `startVault` sends exactly
  one `vault-changed` with the stored settings and no `starting`; no engine request, since start only arms the
  timers). Red on HEAD; M5, M6. `memory-backup.test.tsx` "while Vector starts the page waits for Brain Vault, then shows
  its real place": a starting answer shows `STARTING_COPY` with no "Back up now" and no repository field, and the real
  broadcast brings the controls, `octo/brain-vault` in the field and the Delete card; then, with the page's read held,
  the real broadcast comes first and the late stand-in answer replaces nothing. Red on the HEAD component; M7a, M7b,
  M9.

### Checks that hold

- **R45-28. The preload offers only what the page calls; arguments are checked in main, not in the preload.**
  `window.api.vault` has exactly `status`, `onChange`, `versions`, `backup`, `configure`, `restore`, `forget` and
  `remove` (`preload/index.ts:99-112`, `types.ts:147-157`, `renderer/index.tsx:273`), and the page uses each one
  (`memory-backup.tsx` status `:63`, onChange `:69`, versions `:99`/`:111`/`:145`/`:155`, backup `:108`, configure
  `:117`/`:128`/`:267`, restore `:136`, forget `:152`, remove `:161`). The preload passes every argument through. In
  main, `handle` asserts a trusted renderer (`ipc.ts:258-262`); the handlers check types (`:460-473`); `configure`
  runs `parseRepo` (`vault-backup.ts:662-689`); `forget` runs `/^v\d{13}-[0-9a-f]{8}$/` (`:593`); the recovery code is
  parsed before scrypt (core `vault/recovery.ts:40-51`). Restore's `version` is only checked to be a string
  (`ipc.ts:468`) and reaches `VaultBackup.read` unchanged; the stores keep it safe: the GitHub store reads only a
  version in its synced set (core `vault/github.ts:313`), the Vault API store encodes it (`remote.ts:106`), and the
  manifest must carry that id (`format.ts:136`). Pin: new `vault-preload.test.ts` "window.api.vault offers only the
  calls Settings → Memory → Backup makes, each on its own channel" (the eight keys; each call on its channel with
  exactly its arguments; `onChange` on `vault-changed`, and its unsubscribe removes the listener).
- **R45-29. The recovery code reaches no renderer storage and no log.** It lives only in signals: `code`
  (`memory-backup.tsx:46`, set at `:110`, shown at `:291-307`, cleared by "I saved it" `:301`) and `recovery` (`:50`,
  a password input with `autocomplete="off"` `:357-365`, cleared after a restore `:144`). Neither file uses
  `localStorage`, `persisted`, `platform.storage` or `console`. The desktop renderer's Sentry drops Breadcrumbs
  (`renderer/index.tsx:77-85`) and is opt-in. Copy writes the clipboard only on a click (`:168-173`). Pin:
  `memory-backup.test.tsx` "the recovery code shows once and reaches no storage" (the code shows, "I saved it" removes
  it, the recovery input is a password field with autocomplete off and is emptied after a restore that sent
  `{ version, code }`, and `localStorage`, `sessionStorage` and `platform.storage` stay untouched).
- **R45-30. H1.** Brain Vault on Vector shows only when `vectorOffer` holds (signed in, no error, `vault` listed,
  `gb` above 0; `memory-backup-model.ts:20-28`, `memory-backup.tsx:213`), or when it is already the chosen backend so
  the person can move off it. Main checks again before a write (`vault-backup.ts:317-324`) and the Vault API decides
  anyway (S1). The GitHub backend is free on every plan (spec §1.1). The Backup tab still shows on every desktop
  build; hiding it until `vault` is listed is the owner's decision and is unchanged. Pin: `memory-backup.test.tsx`
  "Brain Vault on Vector shows only for a listed vault with storage; GitHub always".
- **R45-31. Vector Local.** The page does not hide the backends: main refuses both before any request (R45-15,
  `localRefusal`, `vault-backup.ts:746-760`), and the page shows that copy. `brain-vault` is `local: "blocked"`
  (`sources.ts:404`), pinned by the R45-26 test.
- **R45-32. Copy.** No amount, price or token figure appears. The page shows counts, dates, storage sizes (`bytes()`
  on rows, "Using X of Y", the plan's GB and version days, and the 1 GB warning, `vault-github.ts:152-159`) and
  "update Vector" (`memory-backup-model.ts:95`). Storage sizes are read as counts, not amounts (deviations, P7 review
  addendum Part 2). Pin: the model test's "names no amount" case now covers every line function and fixed copy the
  page shows; the component's case for H1 checks a whole page with a usage line against the same pattern.
- **R45-33. A restore cannot be submitted twice.** `act` returns while busy and sets busy before any await
  (`memory-backup.tsx:79-80`); every action button is disabled while busy. Main's `exclusive`
  (`vault-backup.ts:329-339`) answers "Brain Vault is busy. Try again in a moment." (`:346-350`) for a page reopened
  during a running operation. Pin: the R45-24 case, whose stand-in button calls `onClick` whatever `disabled` says, so
  the page's own guard is what is tested (M2).

### Readings, not repaired

- **R45-34.** A restore that answers `needsCode` while a stale listing says `mine` hides the code input
  (`memory-backup.tsx:352`); "Refresh versions" shows it. This needs the key to change between the listing and the
  restore.
- **R45-35.** `lastLine`'s "memory files" (`memory-backup-model.ts:67`) counts every file of a backup, learned ones
  included (`vault-backup.ts:431`). Kept as written; the description and the restore line now name learned content.
- **R45-36.** `void props.vault.versions().then(setVersions)` (`memory-backup.tsx:111`, `:145`, `:155`) has no catch.
  These run only after a call that answered, so Brain Vault has started and the IPC does not throw there.
- **R45-37.** If the engine never reaches `serverReady`, or `vectorAccount.restore()` throws, `startVault` never runs
  and the page keeps showing `STARTING_COPY`. Accepted: before, it showed controls that threw, and the copy makes no
  timing promise.
- **R45-38.** The refused part ("refused (forgotten here, or past what may wait for review)") does not name a learned
  skill refused for an unsafe command (core `brain/export.ts:281`), nor a memory entry refused as secret or too long
  (`:263`). Kept: the count is right and the wording was already a summary.

### For the lead

- None in other lanes' files. `packages/app/src/context/settings.tsx`, `settings-memory.css` and `general.tsx` are
  unchanged.
- Confirm before `vault` is listed (R45-32): the page shows storage sizes on purpose, read as counts rather than
  amounts: `bytes()` on version rows, "Using X of Y", the plan's vault GB and version days from its entitlements
  (`packages/schema/src/codium-entitlements.ts`, through `vectorCopy`), and the 1 GB repository warning. The lead or
  owner confirms that showing the vault GB and version-day entitlements in client copy is acceptable.
- For the owner's A60 read, next to R45a's item on the privacy draft's `#vault`: the Vector Local "Sends" text of
  Brain Vault (shown in the allow dialog, `features/local/allow-dialog.tsx:80`) now names learned skills and workflow
  insights (R45-26). No privacy text changed and the privacy patch was not applied.

### Mutations

Each was applied with an exact one-occurrence substitution, run, and restored from a saved copy; `diff -q` confirmed
each restore (`/tmp/vector-v2/codium/r45b/mut/run.py`).

| Mutation | Turns red |
| --- | --- |
| M1: the old catch (`cause.message`) | "a restore is sent once…" (R45-24) |
| M2: drop `if (busy()) return` | "a restore is sent once…" (two restores sent) |
| M3: the old summing loop (drop the learned branch) | vault-backup "learned skills and workflow insights come back as proposals…" |
| M4: drop the learned parts of `restoreLine` | model "learned skills and workflow insights come back as proposals for review…" |
| M5: drop `starting: true` from `vaultStarting()` | vault-runtime |
| M6: drop the broadcast after `backup.start()` | vault-runtime |
| M7a: the old outer `Show when={status()}` | "while Vector starts the page waits…" |
| M7b: the repository only from the first answer (`if (!held)`) | "while Vector starts the page waits…" |
| M8: the old brain-vault `sends` and `why` | sources "Brain Vault says a backup carries…" |
| M9: drop the check that ignores a stand-in once a real status is held | "while Vector starts the page waits…" (the race part) |
| M10: `restoreLine` always shows the memory parts (`const memory = true`) | model "learned skills and workflow insights come back as proposals for review…" (the learned-only line) |

Red runs against HEAD: the new `memory-backup.test.tsx` on the HEAD component (with the new model constants, which the
test imports): 2 pass, 2 fail (the R45-24 and R45-27 cases; the H1 and recovery-code pins pass). The new
`vault-backup.test.ts` on the HEAD `vault-backup.ts`: 23 pass, 1 fail. `vault-runtime.test.ts` on the HEAD
`vault-runtime.ts`: 0 pass, 1 fail. The new `sources.test.ts` on the HEAD `sources.ts`: 15 pass, 1 fail.
`vault-preload.test.ts` pins unchanged code and passes on HEAD.

### Tests run here (one file at a time)

Through `vector-serial` with `--timeout 30000`, from each package directory: app with `bun test --isolate`; desktop
with `bun --no-env-file test`; core with `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and
`TMPDIR` under the scratch root; engine with `bun test` and `TMPDIR` under the scratch root.

| Package | File | Before (HEAD `420e729f`) | After |
| --- | --- | --- | --- |
| app | `src/components/settings-v2/memory-backup-model.test.ts` | 6 cases (not re-run) | 7 pass (74 `expect()` calls) |
| app | `src/components/settings-v2/memory-backup.test.tsx` | new | 4 pass (42) |
| app | `src/browser-bundle.test.ts` | never run (A45 notes) | 4 pass (16) |
| app | `src/features/local/local-model.test.ts` | — | 39 pass (1014) |
| app | `src/components/settings-v2/local-model.test.ts` | — | 15 pass (36) |
| app | `src/components/settings-v2/memory-model.test.ts` | — | 18 pass (313) |
| app | `src/components/settings-v2/settings-registry.test.ts` | — | 21 pass (141) |
| desktop | `src/main/vault-backup.test.ts` | 23 pass | 24 pass (143) |
| desktop | `src/main/vault-runtime.test.ts` | new | 1 pass (6) |
| desktop | `src/main/vault-preload.test.ts` | new | 1 pass (5) |
| desktop | `src/main/vault-secrets.sign-ins.test.ts` | 5 pass | 5 pass (38) |
| core | `test/local-mode/sources.test.ts` | 15 pass | 16 pass (53) |
| engine | `test/compliance/egress-inventory.test.ts` | — | 5 pass (12) |

Typecheck: `bun typecheck` clean in `packages/app` (`tsgo -b`), `packages/desktop` (`tsgo -b`) and `packages/core`.
`prettier --check` (through `vector-serial`): every touched file is prettier-clean except `vault-backup.ts`, whose only
prettier difference is HEAD's B10 lines (now `:555-556`, R45-23); the lines this package touched match prettier.
`git diff --check` clean. The full turbo typecheck and the api tree are pre-push steps and were not run during the
review. Commit gate, 15 Nov 2026: the six new or changed test files (app `memory-backup-model.test.ts` and
`memory-backup.test.tsx`, core `test/local-mode/sources.test.ts`, desktop `vault-backup.test.ts`,
`vault-runtime.test.ts` and `vault-preload.test.ts`) plus app `browser-bundle.test.ts` and
`features/local/local-model.test.ts` were run again one at a time, with the "After" counts above; `bun typecheck` in
`packages/app`, `packages/core` and `packages/desktop`, the full `bun turbo typecheck --concurrency=2` (27 of 27
tasks) and the api tree (`bun typecheck --project ../../tsconfig.json` from `packages/engine`) were clean.

**CI only:** Vector Codium's Codium tests job (it selects the changed and new test files since the base, the app
component test included), the HttpApi exerciser (no route changed), the browser job (no spec added), typecheck.yml, and
vector-hosted-ci.yml's Hosted tests job, which runs the desktop `vault-*` files whatever changed. CI: pending; the
change is uncommitted, and the run and job ids go in a dated line here in the lane commit that follows the runs. Never
exercised: the Backup screen in a real browser or the running app (B10's package), Electron's own invoke error text in
a packaged app (read from the repository's handling), safeStorage, and a real startup race.

`packages/app/src/context/settings.tsx`, `settings-memory.css` and `general.tsx`: unchanged.

Edits to `api/_lib/model-plan-*.ts`: none.
