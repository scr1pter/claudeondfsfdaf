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
  - Repaired, 21 Nov 2026 (branch `engine-core-fixes`): `failed()` now takes only the fixed copy and returns
    `${what}.`; git's stderr is never appended (the comment there says why). The push branch's stale/rejected test of
    stderr is unchanged and still answers its own copy. Two cases in `packages/core/test/vault/github.test.ts` wrap the
    real git: `ls-remote` and, separately, `push` exit 128 with a token URL and a `/home/person` path on stderr. They
    assert the exact fixed message and that it holds none of `ghp_`, `/home/person`, `fatal` or `https://`. On the old
    `failed()` both fail (9 pass, 2 fail, the token URL in the message). Stripping paths and URLs by pattern was not
    taken: it misses Windows paths and home folders. One consequence: desktop's runner copy "Git could not start on
    this computer…" is no longer appended to "Vector could not set up its copy of the vault"; the desktop case
    "git that cannot start shows plain copy" now lists the bare fixed copy as its second accepted text.

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
    - CI, 15 Nov 2026 (recorded by Codium finish DZ): B10's runs at `8a43f2b2`. Vector Codium run 43715519898 is
      green under the lane rule; its Codium browser specs job 132816094736 ran the four `codium-vault-sections.spec.ts`
      cases ("9 passed"). typecheck.yml run 43715522956 passed. In vector-hosted-ci.yml run 43715921854, Hosted tests
      job 132817317859 ends "Hosted: 147/147 test files passed". See `codium-deviations.md` "Lane status (15 Nov 2026,
      codium-finish)".
    - 16 Nov 2026 (codium-finish lane, phase review round two, PR13): "files of at most 1,500,000 characters" holds
      for every file but one with a single skill longer than that, which gets a file of its own. Such a file restores
      while it fits in `IMPORT_CHARS`; past it only that file is refused. `restorable`'s comment now says so, and
      `engine/test/server/memory-vault.test.ts` "a skill longer than a part by itself gets a part of its own, and every
      part still restores" pins it. See `codium-deviations.md` "Codium finish: phase review fixes, round two,
      codium-finish lane (16 Nov 2026)".
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
  package's scope. Repaired 21 Nov 2026 on branch `engine-core-fixes` (see R45-4 (b) above).
- **R45-18. Confirmed: an exported `VECTOR_VAULT_RECOVERY_CODE` reaches agents' shells.** The CLI reads it
  (`cli/cmd/vault.ts:214`). `privateRuntimeKey` (`packages/core/src/child-environment.ts:163-174`) drops `VECTOR_*`
  names ending `_TOKEN`, `_KEY`, `_PASSWORD` or `_SECRET` and the names in `PRIVATE_RUNTIME_ENVIRONMENT` (`:5-14`), and
  `_CODE` is neither. A probe through `vector-serial` (a temporary file run from `packages/core`, removed afterwards;
  the copy is under `/tmp/vector-v2/codium/r45a/probe/`) printed `{"recoveryCodePasses":true,"cloudTokenPasses":false}`.
  A person who exports the code in their shell profile hands it to every command `vector` starts. The repair is one
  name in `PRIVATE_RUNTIME_ENVIRONMENT`, in core's shared child-environment file. The critique's alternative, deleting
  the variable inside `vault restore`, does not help: agents' shells inherit from the long-running `vector` process,
  not from `vault restore`.
  - Repaired, 21 Nov 2026 (branch `engine-core-fixes`): `VECTOR_VAULT_RECOVERY_CODE` is in
    `PRIVATE_RUNTIME_ENVIRONMENT` (`packages/core/src/child-environment.ts`), so `untrustedChildEnvironment` drops it
    in any letter case. `packages/core/test/child-environment.test.ts`'s first case now passes it upper and lower case
    and expects both gone; without the one-name fix it fails (11 pass, 1 fail, the two names left in the output).
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
  - Repaired, 21 Nov 2026 (branch `engine-core-fixes`), sandbox untouched: the CLI's copy is now
    `Global.Path.data/vault/github/<owner>/<name>.git` (`githubCopy` in `cli/cmd/vault.ts`), beside `vault.json`, and
    `gitRunner` runs in the data folder. `storeFor` removes the old `Global.Path.cache/vault` before use, so a copy
    that was already tampered with is never fetched into again; the next backup sets up a fresh copy from GitHub. In
    core, `init`, `fetch`, `update-ref` and `push` all pass `-c core.hooksPath=<copy>/no-hooks` (push alone did), so a
    `reference-transaction` hook cannot run even where the copy is writable (the desktop's copy in its own cache
    included). Tests: engine `test/cli/vault.test.ts` asserts the copy resolves under data and outside the cache (red
    with the cache path put back); core `test/vault/github.test.ts` "hooks planted in the copy…" plants the hook in
    `hooks/` and in a folder the copy's config names as `core.hooksPath`, backs up twice against a local bare remote,
    and asserts no marker (red on the old core: 11 pass, 1 fail). The B10 overlap case's subcommand reader now skips
    each `-c` value. Not done: a `credential.helper=` reset, which would also drop the person's own helper that the
    push relies on; with the copy out of the sandbox's reach a planted helper has nowhere to be written. R45-19 (the
    sandbox's deny list) stays with `v2-closeout-ci`.
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

CI, 15 Nov 2026 (recorded by Codium finish DZ): R45b's runs at `4bd146e7`.

- Vector Codium run 43705851187 had 18 jobs: 15 succeeded, 2 were skipped by `services_only`, and Codium tests job
  132786637759 failed only at the exerciser step. Its visible tail shows "Codium: 136/136 test files passed" and the
  four baseline review-memory MISS lines with `fail=0`, so the run is green under the lane rule.
- typecheck.yml run 43705853689 and vector-hosted-ci.yml run 43706515849: success (run conclusions).

The receipts are in `codium-deviations.md` "Lane status (15 Nov 2026, codium-finish)" and in the B10 section's receipt
block. The Backup screen's browser run is B10's, recorded there.

`packages/app/src/context/settings.tsx`, `settings-memory.css` and `general.tsx`: unchanged.

Edits to `api/_lib/model-plan-*.ts`: none.

## A46 ops Worker: outbound checks

Codium finish R46a, 15 Nov 2026. Part 1 of the A46 review: the Worker's outbound requests and its protocol. Part 2
(R46b) reviews `index.ts`, `internal.ts`, `limits.ts`, `runtime.ts` and the rest of `ops-account.ts`. Read on
`codium-finish` `8a43f2b2`; line numbers are at `8a43f2b2` unless a line says "now". Scratch was under
`/tmp/vector-v2/codium/r46a/` (HEAD copies in `head/`, the repaired copies in `new/`, the mutation runner in `mut/`, the
planning probes in `plan/`). Nothing here boots the engine.

### Scope

- `packages/ops-worker/src/ssrf.ts` (223 lines), `check.ts` (159), `release-watch.ts` (135), `bytes.ts` (50) and
  `protocol.ts` (135).
- `git log --oneline 334aab8d..HEAD -- packages/ops-worker/src` lists two commits, and both touch `src/`. `3082bb2c`
  changed the probe's user agent (check.ts:23) from `VectorOps/1` to `Vector/Ops (+https://vectordev.ai/docs/codium)`,
  with check.test.ts's expectation; `packages/web/src/pages/docs/codium.astro` already existed, so this links no new
  page. `025d75da` dropped the `KILL_KEY` export from `index.ts` (R46b's file). A third commit in range for
  `packages/ops-worker` (not `src/`), `c4f5ad28`, touched the package's `package.json` only.
- `protocol.ts` is types only and must import nothing (source.test.ts:41-43), so the task's "protocol.ts validates every
  field" was read as the validators of its bodies, which live in `ops-account.ts`: the body parse in `internal()`
  (`:152-160`), `suspend` (`:319-327`), `flags` (`:440-441`), `parsePlan` (`:916-948`), `parseConfig` (`:950-966`) and
  `parseRelease` (`:968-983`). Only those parts of `ops-account.ts` were reviewed and edited.

### Findings repaired here

**R46-1. Confirmed: a DNS-over-HTTPS answer was read whole before its size cap.**
- Cause: `ssrf.ts:200` `await response.text()`, then `:201` `text.length > 64 * 1024`. A streamed 1 MiB answer was
  pulled to its end (1,025 pulls in the planning probe) before the check. Severity low: the endpoint is fixed
  (`cloudflare-dns.com`, `:154`), and the 8 s signal (`:194`) bounds the time but not the memory.
- Hardening in the same repair (not defects on their own, since the endpoint is fixed): the cap counted UTF-16 code
  units, so an 80 KB answer of two-byte characters passed, and an answer that was not UTF-8 was decoded with
  replacement characters and accepted.
- Repair:
  - `bytes.ts` gains `readPrefix(body, limit)` (now `bytes.ts:18-49`). It reads as the bytes arrive until `limit` came
    or the body ended, then cancels the rest, so at most `limit` bytes plus one chunk are held. `complete` means the body
    ended before `limit` bytes came; a failed read (an error, or the request's signal) answers undefined; no body is
    empty and complete. No try/catch.
  - `ssrf.ts`'s lookup (now `:204-207`) reads with `readPrefix(response.body, 64 * 1024)` and decodes with `bytes.ts`'s
    fatal `fromUtf8` (unused before, its first caller). An answer of 64 KiB or more, or one that is not UTF-8, is a
    failed lookup (`error`).
  - `check.ts`'s `sniff` (`:105-136`, single use, the same loop) is removed; the 5xx HTML branch (now `:80-86`) uses
    `readPrefix` with the same `size < limit` loop, so its verdicts do not change. The critique's case, a page that sends
    exactly 8 KiB and then stalls, is still judged at once (pinned by a new case). The one difference: a body that ended
    is no longer cancelled after its end, which did nothing. The page is still decoded with a non-fatal `TextDecoder`,
    since the challenge markers are ASCII.
- Regression tests: ssrf.test.ts "an answer is read only to 64 KiB as it arrives, counted in bytes, and must be UTF-8"
  (80 KB of "é" → error; a 1 MiB stream → error after exactly 64 pulls and one cancel, where HEAD pulls 1,025; a 0xff
  byte → error; the same answer in UTF-8 → public); the new `test/bytes.test.ts` (its exact-limit case pins that a
  body of exactly `limit` bytes reads as `complete: false` with one cancel, so a 65,536-byte DoH answer is a failed
  lookup and check.ts's exact-8-KiB-then-stall page is judged without a ninth read); check.test.ts "a 5xx HTML page is read
  only to its first 8 KiB, and the rest is cancelled", "…of exactly 8 KiB that then stalls is judged at once" and
  "…whose body stalls past the timeout fails as a timeout" (these three pass on HEAD and pin the swap).
- 16 Nov 2026 (codium-finish lane, phase review round two, PR12): "An answer of 64 KiB or more ... is a failed lookup"
  no longer holds. `ssrf.ts`'s lookup now reads with `readPrefix(response.body, 64 * 1024 + 1)` (`:206`), as
  `index.ts:46` does, so an answer of exactly 65,536 bytes is used and one of 65,537 or more is a failed lookup. The
  ssrf case above now also checks both sizes, and its 1 MiB stream is pulled 65 times, then cancelled once.
  `readPrefix` and `test/bytes.test.ts`'s exact-limit case are unchanged. See `codium-deviations.md` "Codium finish:
  phase review fixes, round two, codium-finish lane (16 Nov 2026)".

**R46-2. Confirmed: a failed lookup of one address kind was ignored when the other kind answered public.**
- Cause: `resolvePublic` returned public (`ssrf.ts:177-181`) before its error rule (`:184`). That contradicts the
  module's own rule (`:7-10`: every address, looked up just before, is public). With AAAA SERVFAIL the host's IPv6
  addresses were never checked, while the Worker's fetch, which looks the name up again (R46-8), may connect over IPv6.
- This reverses a reading A46 made on purpose: ssrf.test.ts:222, "public addresses of one kind are enough when the other
  kind's lookup failed".
- Repair: the error rule moved to just after the blocked check (now `ssrf.ts:181-182`). A blocked address still wins
  over an error.
- Effect: such a check is inconclusive (`resolver`, `check.ts:38-42`): not probed, never reported down, and it neither
  counts toward nor breaks a run of failures.
- Cost, recorded: if a host's DNS fails AAAA lookups for good, its monitor stays inconclusive and a real outage there is
  never reported. Failed lookups are not cached (only public, blocked and missing are, `ops-account.ts:493-495`), so
  each wake asks again. The app's ops screens (`packages/app/src/features/cloud/ops/ops-model.ts`) show incidents,
  which an inconclusive check never opens, and no screen line names the `resolver` reason, so the person is not told
  the host is not being checked. A product reading for the lead; no screen was changed.
- Divergence, recorded: the API's `safe-fetch.ts` takes every address the system resolver returns (`:226-230`) and
  connects straight to the checked address (`:233`). The Worker cannot pin, so its lookup rule is now the stricter one;
  the address ranges are still the same (R46-6).
- Test: ssrf.test.ts:222-225 is replaced, with its expectation tightened, by "a lookup that failed for either kind leaves
  the host unknown; a private address still refuses it" (A public + AAAA SERVFAIL, A 502 + AAAA public, A SERVFAIL +
  AAAA public → error; A 127.0.0.1 + AAAA SERVFAIL → blocked).

**R46-3. Confirmed: a truncated answer (TC) was judged complete.**
- Cause: the lookup never read `TC` (`ssrf.ts:202-205`).
- Repair: now `ssrf.ts:208-210`: `TC: true` is a failed lookup.
- Test: ssrf.test.ts "an answer cut short (TC) is a failed lookup". The fakes and the smoke's resolver
  (`e2e/ops-smoke.mjs:78-85`) never send TC.

**R46-4. Confirmed: a field the Worker does not know was ignored, not refused, at every level of plan, config and
release.**
- Cause: the parsers pick the fields they know (`parsePlan` `:916-948`, `parseConfig` `:950-966` with the monitor at
  `:957-958`, `parseRelease` `:968-983`, and `internal()`'s parse `:152-160`). Nothing unknown was stored, because each
  parser rebuilds its value, but the repository's rule elsewhere is refusal: `packages/hosted-computer/src/actions.ts:273`
  ("unknown fields and out-of-range values are refused, never ignored"), `api/_lib/ops-api.ts:120` and
  `api/_lib/hosted-api.ts:94`.
- Repair, `ops-account.ts`:
  - `BODY_FIELDS` (now `:62-80`) lists the fields of plan, config and release, each checked with
    `satisfies Record<keyof PlanBody, true>` (and `ConfigBody`, `ReleaseBody`). `PLAN_FIELDS`, `ON_CALL_FIELDS`,
    `RELEASE_GUARD_FIELDS` and `MONITOR_FIELDS` (now `:81-93`) are tied to `OpsPlan` and the `ConfigBody` monitor the
    same way, so a field added to a protocol type without its list, or a list key the type lacks, fails `bun typecheck`
    (mutations M13 and M14). Every list in `BODY_FIELDS` is tied to a type; the state body has none (it is lenient,
    below).
  - `onlyFields` (now `:959-962`) checks own keys with `Object.hasOwn`, so a JSON `__proto__` key counts as a field
    (with `in`, it and `toString` would pass: M10).
  - `internal()` refuses (now `:203-204`) before anything is written or scheduled; `parsePlan` (now `:968`, `:978`,
    `:991`) and `parseConfig` (now `:1009`) refuse nested extras. The answer is 400 `INTERNAL_BAD_REQUEST`.
- Kept lenient on purpose: state, erase, suspend and flags. They rebuild their values and store nothing unknown, and
  the API turns any non-2xx answer into 503 `OPS_UNAVAILABLE` (`api/_lib/ops-worker.ts:110-113`). Refusing them while
  the API sent a field the Worker did not know yet would block account deletion (`ops-cleanup.ts:93-94`), the guard's
  hold (`ops-guard.ts:320-321`, "did not apply the hold"), the guard's read before that hold (`ops-guard.ts:443-448`:
  a refused state is counted as a failure and the account is not held) and the owner's kill switch
  (`ops-worker.ts:159-162` answers `failed`). Safety actions, and the read a safety action depends on, fail toward
  applying. erase, suspend and flags came from the critique; state was moved here in the review round below.
- What a refusal of the strict three leaves during version skew: a refused plan leaves the stored plan, which runs to
  its own `validUntil` (`api/_lib/ops-worker.ts:205-212`): `min(periodEnd + 24 h, now + 39 d)` when it was pushed for an
  active or renewing account, `now + 35 d` when pushed for a paused one. So a refused push that would stop checks (a
  freeze, a refund, an end) does not stop them at once: they run until that stored `validUntil`, up to 39 days after the
  last accepted push. A refused config leaves the previous monitors probed, within that same bound; a refused release
  is not watched. The Worker is not deployed anywhere yet and every caller sends exactly the listed fields, so no live
  skew exists.
- Every caller already sends exactly the known fields: plan `codium-provisioners.ts:305` with `opsPlanFor`
  (`ops-worker.ts:184-213`), config `ops-settings.ts:354-360` (`workerConfig`), release `release-guard.ts:391-403`,
  state `ops-guard.ts:443`, and the smoke (`e2e/ops-smoke.mjs:146-152`, `:168-182`, `:232-240`). The root tests that
  drive the real Worker with API-built bodies pass (Tests below).
- `protocol.ts`: a comment only (now `:5-9`), limited to the request bodies and naming the lenient four; it still
  imports nothing. `owner-actions/hosted-ops.md` step 6 gains the deploy order, as two merges.
- Regression test: the new `test/protocol.test.ts` (exact bodies taken; extras refused at eight places with a snapshot
  of meta, monitors, releases, the alarm and the kill value unchanged; the lenient four still apply with an extra, state
  answering exactly as without it; every field required at every level).

### Checks that hold

- **R46-5. Every URL form.** The WHATWG parser folds decimal, octal, hex, shorthand, percent-encoded and full-width IPv4
  into dotted form, which the all-numeric last label catches (`ssrf.ts:40-46`, `:70-71`). IPv6 literals are refused by
  the `[` check (`:71`). Trailing dots are stripped before the name rules (`:50`, `:70`). Userinfo (`:68`), ports other
  than 443 (`:69`; `:0443` parses to 443), schemes other than https (`:67`), zone ids (a parse error) and URLs over 2,048
  characters (`:60`) are refused. The fetched URL is the parser's own `href` (`:73-74`), so the checked and fetched
  spellings cannot differ; a backslash reads as a slash, so `https://host\@evil.example/` probes the path
  `/@evil.example/` on the verified host. Bun's parser runs in the tests and workerd's in production; both follow WHATWG.
  The table now holds 52 refused spellings and 4 more normalised ones.
- **R46-6. Address ranges** (`ssrf.ts:78-116`). IPv4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16 (169.254.169.254
  included), 172.16/12, 192.0.0/24, the documentation and benchmarking blocks, 192.168/16, 224/4, 240/4 and Azure's
  168.63.129.16. IPv6: everything outside 2000::/3 (::1, ::, fc00::/7, fe80::/10, NAT64 64:ff9b::/96 and /48,
  IPv4-compatible), mapped ::ffff:a.b.c.d judged as IPv4, 2001::/23, 2001:db8::/32, 2002::/16, 3fff::/20, and any zone.
  Parity with `safe-fetch.ts` stays the root contract test's job (`test/ops-worker-contract.test.ts`, unchanged).
- **R46-7. DNS answers are checked, not only the literal host.** `probeAll` looks up every host of the wake before any
  probe (`ops-account.ts:475-506`), A and AAAA both (`ssrf.ts:174`), and one non-public address refuses the host
  (`:176`); a host whose only A record is 169.254.169.254 is blocked (new row).
- **R46-8. Rebinding and the platform (a reading).** The Worker cannot pin the address it checked: `fetch` looks the
  name up again. workerd 1.20251118.0 (installed with wrangler 4.50.0) says its default network allows `"public"` only
  and filters the addresses returned by the fetch's own lookup
  (`node_modules/.bun/workerd@1.20251118.0/node_modules/workerd/workerd.capnp:786-826`), so inside open-source workerd a
  rebinding between the DoH check and the fetch cannot reach a private or local address. miniflare 4.20251118.1 allows
  `["public", "private", "240.0.0.0/4"]` (`dist/src/index.js:52616`), and the smoke answers every outbound request
  in-process (`e2e/ops-smoke.mjs:76-119`), so neither CI nor the unit tests exercise network filtering. Cloudflare's
  production network is not described by that file, and developers.cloudflare.com is outside this session's network:
  A46's sentence "Cloudflare's own fetch also refuses private and prohibited addresses" (old `ssrf.ts:11-12`) stays
  unverified and is left to the outside security review (spec 8.2 step 16). The header comment now says so. The residual
  is blind: a probe carries no credentials (`check.ts:22-26`) and keeps no body; only outcome, reason and status leave
  (`protocol.ts:98-108`). The 60 s to 5 min reuse of DoH answers (`ssrf.ts:179-180`) does not change this boundary.
- **R46-9. Redirects are never followed.** `redirect: "manual"` at `check.ts:52`, `ssrf.ts:193` and `internal.ts:188`;
  source.test.ts:45-51 counts them; the smoke's `/moved` 302 (`e2e/ops-smoke.mjs:105`) covers the real runtime.
- **R46-10. Timeouts while streaming.** One `AbortSignal.timeout` (8 s) covers a probe's headers and its 5xx read
  (`check.ts:49`, `:80`); each DoH request has its own 8 s signal (`ssrf.ts:194`), which now also bounds its
  `readPrefix`. The new check case shows a stalled body ending as a timeout under Bun. That workerd errors a body read
  when the request's signal aborts follows the Fetch standard and is not exercised in CI: deferred verification.
- **R46-11. Release-watch parsing is bounded.** `release-watch.ts` parses nothing. `parseRelease`
  (`ops-account.ts:968-983`) caps `urls` at the plan's paths (at most 5) of at most 2,048 characters each, `environment`
  at 255 code units without control characters, `deployment` at 64, and `repositoryId`/`at` to safe integers, all in a
  32 KiB body. A watch's maps are keyed by its own URLs (`release-watch.ts:35-39`, created at `:78-80`). `watchWindow`
  clamps the window (`:56-59`), and `stepWatch` never lets the next round fall at or before now (`:113-114`).
- **R46-12. No secret or account key is logged.** source.test.ts:31-39 bans `console.` in `src/`. `ssrf.ts`,
  `check.ts`, `release-watch.ts`, `bytes.ts` and `protocol.ts` touch no secret; probe and DoH requests carry only fixed
  headers.

### Readings, not repaired

- **R46-13. Trailing dot.** A URL host with a trailing dot is verified without the dot but probed as entered, and the
  API's `monitorUrl` (`api/_lib/ops-settings.ts:244-258`) keeps it too; a server that answers 301 to the dotless host
  reads as a cross-origin redirect. SSRF-safe (the DoH lookup and the fetch use names that resolve alike); a
  correctness reading only.
- **R46-14. NAT64 and 6to4** are refused even when the embedded IPv4 is public. Conservative.
- **R46-15. DoH privacy.** Monitored host names go to `cloudflare-dns.com`, the platform the Worker already runs on.

### For R46b (recorded, not repaired here)

- **R46-16.** `index.ts:41-44` reads the whole inbound body with `arrayBuffer()` when `content-length` is absent, before
  the 32 KiB check (confirmed by reading; reachable by unsigned callers on `workers.dev`). `readPrefix` can serve it.
- **R46-17 (plausible).** `RunState` is one JSON meta row (`ops-account.ts:843-851`); the watch maps hold up to perDay
  concurrent watches × 5 URLs × 2,048 characters in about four copies. Check it against Cloudflare's per-value limit.
- **R46-18.** source.test.ts's redirect count (`:45-51`) matches only `fetcher(` and `deps.fetch(`, not a direct
  `runtime.fetch(` or bare `fetch(` call.
- **R46-19.** `wrangler.jsonc` has no `observability` setting (uncaught-exception logs).
- **Carry forward.** R46-2's follow-up for the lead (below) must be carried into R46b's close-out record and the
  lane's follow-ups, so it is not lost when R46b closes.

### For the lead

- No defect was found in another lane's file.
- R46-2's product reading, a lane follow-up (no code change in R46a): a monitor whose host keeps failing one kind's
  lookup (an AAAA SERVFAIL, say) stays inconclusive with `resolver`, is never probed, and its outages are never
  reported, and no ops screen says so. Proposed: an ops-screen line for a monitor that stays inconclusive with
  `resolver`, or a counter of such checks in the Worker's state answer. A product decision for the lead.

### Review round (15 Nov 2026)

Six non-blocking findings from the package review; all taken, none disagreed with.
- The state body is now lenient (the review's option 1): the guard reads it before it holds an account
  (`api/_lib/ops-guard.ts:443-448`), so refusing it under skew would count a failure instead of a hold, the M9 risk
  the critique used to keep suspend lenient. `BODY_FIELDS` drops `state`; protocol.test.ts moves the state row from the
  refused case to the lenient one (M15); `protocol.ts`'s comment and `owner-actions/hosted-ops.md` step 6 name the
  strict three. This also settles the finding that `state` was the one list not tied to a type with `satisfies`: there
  is no state list now, so every list in `BODY_FIELDS` is tied.
- R46-4's skew effects were corrected: a refused plan runs to the stored plan's own `validUntil` (up to now + 39 d, or
  now + 35 d after a paused push), not simply periodEnd + 24 h.
- bytes.test.ts pins the exact-limit edge (`complete: false`, one cancel); `readPrefix` is unchanged.
- check.test.ts's exact-8-KiB-then-stall case waits with `timeoutMs: 10_000` and passes under 2,000 ms, so a slow
  runner cannot reach the timeout path; `pulled: 8, cancelled: 1` still shows no ninth read.
- The root `ops-domain-health`, `ops-screens` and `ship-desk` files were run locally (Tests below), and the Scope bullet
  now says that two commits touch `src/` and that `c4f5ad28` touched `package.json` only.
- R46-2's follow-up is worded as a lane follow-up for the lead and carried forward to R46b (above).

### Mutations

Each was applied as an exact one-occurrence substitution by `/tmp/vector-v2/codium/r46a/mut/run.py`, run, and restored;
`diff -q` against the saved repaired copy confirmed every restore.

| Mutation | Turns red |
| --- | --- |
| M1: the HEAD `await response.text()` and character cap | ssrf "an answer is read only to 64 KiB…" |
| M2: `new TextDecoder().decode` in place of `fromUtf8` | ssrf "an answer is read only to 64 KiB…" (the 0xff row) |
| M3: the error rule back after public, as at HEAD | ssrf "a lookup that failed for either kind…" |
| M4: drop the TC line | ssrf "an answer cut short (TC)…" |
| M5: drop the `BODY_FIELDS` check in `internal()` | protocol "a field the Worker does not know…" |
| M6: drop the `onCall` `onlyFields` | protocol "a field the Worker does not know…" |
| M7: drop the monitor `onlyFields` | protocol "a field the Worker does not know…" |
| M8: `readPrefix` loops `size <= limit` | bytes "reading stops once the limit has come…" and (review round) "a body of exactly the limit is not complete…"; check "…first 8 KiB…" and "…exactly 8 KiB that then stalls…" |
| M9: `readPrefix` without its cancel | bytes "reading stops once the limit has come…" |
| M10: `key in fields` in place of `Object.hasOwn` | protocol "a field the Worker does not know…" (the `__proto__` row) |
| M11: drop the plan `onlyFields` | protocol "a field the Worker does not know…" |
| M12: drop the `releaseGuard` `onlyFields` | protocol "a field the Worker does not know…" |
| M13: an extra key `name` in `MONITOR_FIELDS` | `bun typecheck` (TS2353) |
| M14: drop `repositoryId` from the release fields | `bun typecheck` (TS2741) |
| M15 (review round): `state: { account: true }` back in `BODY_FIELDS` | protocol "state, erase, suspend and flags still apply…" |

Red runs against the HEAD sources (copied back into `src/`, then restored and checked with `diff -q`): ssrf.test.ts 9
pass, 3 fail (the R46-1, R46-2 and R46-3 cases); protocol.test.ts 3 pass, 1 fail (the unknown-field case);
bytes.test.ts fails to load (no `readPrefix` export); check.test.ts 16 pass (its three new cases pin unchanged
behaviour). The bytes and check pull counts are exact because their streams hold nothing ahead (`highWaterMark: 0`):
measured first in `/tmp/vector-v2/codium/r46a/plan/pulls.ts`, Bun pulls once per read then, and once more ahead with
the default high-water mark.

### Tests run here (one file at a time)

Through `vector-serial` with `--timeout 30000`: `packages/ops-worker` with `bun test`; the root `test/` with
`bun test ./<file>`.

| Package | File | Before (HEAD `8a43f2b2`) | After |
| --- | --- | --- | --- |
| ops-worker | `test/ssrf.test.ts` | 10 pass (171 `expect()` calls) | 12 pass (271) |
| ops-worker | `test/check.test.ts` | 13 pass (63) | 16 pass (70) |
| ops-worker | `test/bytes.test.ts` | new | 6 pass (12) |
| ops-worker | `test/protocol.test.ts` | new | 4 pass (63) |
| ops-worker | `test/release-watch.test.ts` | 14 pass (85) | 14 pass (85) |
| ops-worker | `test/source.test.ts` | 7 pass (58) | 7 pass (58) |
| ops-worker | `test/internal.test.ts` | 17 pass (97) | 17 pass (97) |
| ops-worker | `test/on-call.test.ts` | 16 pass (60) | 16 pass (60) |
| ops-worker | `test/schedule.test.ts` | 12 pass (137) | 12 pass (137) |
| root | `test/ops-worker-contract.test.ts` | — | 8 pass (59) |
| root | `test/on-call.test.ts` | — | 30 pass, 1 skip (299) |
| root | `test/release-guard.test.ts` | — | 36 pass, 1 skip (345) |
| root | `test/ops-guard.test.ts` | — | 13 pass (87) |
| root | `test/ops-payment-pipeline.test.ts` | — | 10 pass (78) |
| root | `test/account-delete.test.ts` | — | 37 pass, 1 skip (454) |
| root | `test/github-webhook.test.ts` | — | 30 pass (223) |
| root | `test/ops-screens.test.ts` | — | 6 pass (41) |
| root | `test/ops-domain-health.test.ts` | — | 9 pass (57) |
| root | `test/ship-desk.test.ts` | — | 26 pass, 1 skip (270) |

The root skips are the Valkey cases (`VECTOR_TEST_REDIS_URL`), CI only. Nine root files import `test/ops-fixture.ts`;
the other three ops files (`ops-domain-health`, `ops-screens`, `ship-desk`) import none and need no Valkey, and were
run locally in the review round. `bun typecheck` clean in
`packages/ops-worker`. `prettier --check` clean on the five changed sources and four changed or new tests (prettier
rewrapped three lines this package wrote); the Markdown records are not prettier-formatted (`codium-p7-repairs.md`
was not prettier-clean at HEAD either). `git diff --check` clean. The full turbo typecheck and the api tree are
pre-push steps and were not run in this step.

**CI only:** Vector Codium's Codium tests job (it selects the changed ops-worker test files since the base, plus the
root files it always runs), its Hosted services ops Worker job (the dry run and the miniflare smoke, which sends the
smoke's exact bodies to the real runtime), the HttpApi exerciser (no route changed), typecheck.yml, and
vector-hosted-ci.yml's Hosted tests job, which runs every `packages/ops-worker` test. CI: pending; this step left the
change uncommitted, and the run and job ids go in a dated line here in the lane commit that follows the runs.

Edits to `api/_lib/model-plan-*.ts`: none.

**CI receipts (15 Nov 2026, recorded by R46b).** R46a's commit `d866364f` on `codium-finish`. Vector Codium run
43720600992: every job passed except Codium tests job 132831553538, whose "Run the Codium test files" and "Check
generated client" steps passed and whose "Run HttpApi exerciser gates" step reported `pass=359 fail=0 skip=0 missing=4`
with exactly the four baseline lines `MISS DELETE /experimental/review-memory/previews/{previewId}`,
`MISS GET /experimental/review-memory`, `MISS POST /experimental/review-memory/confirm` and
`MISS POST /experimental/review-memory/prepare`, and no FAIL line: green under the lane's rule. Its Hosted services job
"Ops Worker (dry run and miniflare smoke)" 132831553772 passed (the run's own Hosted tests job is skipped by
`services_only`). typecheck.yml run 43720604063 passed. vector-hosted-ci.yml run 43721009223 passed, with Hosted tests
job 132832781366 (every `packages/ops-worker` test, among the hosted files) and Ops Worker job 132832781290.

**Correction (15 Nov 2026, R46b).** The sentence above "the other three ops files (`ops-domain-health`, `ops-screens`,
`ship-desk`) import none" is wrong: all three import `./ops-fixture` (`ops-domain-health.test.ts:24`,
`ops-screens.test.ts:33`, `ship-desk.test.ts:47`). The nine root files that import `test/ops-fixture.ts` are
`account-delete`, `github-webhook`, `on-call`, `ops-domain-health`, `ops-guard`, `ops-payment-pipeline`, `ops-screens`,
`release-guard` and `ship-desk`; `ops-worker-contract` imports the Worker's sources directly. The fixture drives the
real Worker code (`test/ops-fixture.ts:17-21`), so all ten exercise it. The runs above are unaffected.

## A46 ops Worker: accounts, schedules and internal API

Codium finish R46b, 15 Nov 2026. Part 2 of the A46 review, the second half of the P7 addendum for A46. Read on
`codium-finish` `d866364f` (R46a); line numbers are at `d866364f` unless a line says "now". Scratch is under
`/tmp/vector-v2/codium/r46b/` (HEAD copies in `head/`, the repaired copies in `new/`, the mutation runner in `mut/`, the
read-only planning probe in `plan/`). Nothing here boots the engine, and nothing was deployed.

### Scope

- `packages/ops-worker/src/ops-account.ts` (1,046 lines at `d866364f`; R46a reviewed only its body validators),
  `index.ts`, `internal.ts`, `limits.ts` and `runtime.ts`; `wrangler.jsonc`; `e2e/ops-smoke.mjs`;
  `test/ops-worker-contract.test.ts`.
- `git log 334aab8d..HEAD` on those files lists `025d75da` (it removed the `KILL_KEY` export from `index.ts` after the
  Workers runtime refused it) and R46a's `d866364f` (validators only).
- API callers, read only as far as the contract: `api/_lib/ops-worker.ts` (`opsCall` `:90-125`, `syncOpsKillFlag`
  `:152-164`, `opsPlanFor` `:184-213`), `api/_lib/ops-cleanup.ts` (`eraseAccountOps` `:93-101`) and
  `api/_lib/codium-owner-api.ts:154` (the only caller of `syncOpsKillFlag`).
- Unchanged: `limits.ts`, `runtime.ts`, `e2e/ops-smoke.mjs`, `test/ops-worker-contract.test.ts` and every API file.

### Findings repaired here

**R46-16. Confirmed: an inbound body was read whole before its size check.**
- Cause: `index.ts:41-43`. `Number(content-length ?? "0")` let a body with no length through, then
  `await request.arrayBuffer()` read all of it before the 32 KiB check. Any caller of the `workers.dev` address can do
  this before the signature is checked. Red run: a 1 MiB stream with no length was pulled 1,025 times, never cancelled,
  then refused with 413.
- Repair: `index.ts` (now `:42-48`) keeps the declared-length check, then reads with
  `readPrefix(request.body, OPS_LIMITS.internalBodyBytes + 1)` (R46a's reader): a failed read is 400
  `INTERNAL_BAD_REQUEST`, a body that did not end within 32 KiB and one byte is 413, and `read.bytes` goes to the
  signature check and the JSON parse. A body of exactly 32,768 bytes is still taken, as before. No export or signature
  changed.
- Regression test: internal.test.ts "a body sent with no length is read only to 32 KiB and one more byte, and the rest
  is cancelled" (`{status: 413, pulled: 33, cancelled: 1}`; then a signed body of exactly 32,768 bytes, streamed with no
  length, answers 200 with no cancel).

**R46-20. Confirmed (P5): an erasure that came while a wake or a release waited left account data in the erased
object.**
- Cause: the alarm (`ops-account.ts:159-182`) awaits the kill flag (`:162`) and the probes (`:171`), then `applyWake`
  (`:553-616`) writes the run row with the account's host names in its DNS cache (`:556`) and `pruned_at` (`:615`).
  The kill branch (`:162-168`) writes the run row too. The critique found the same race in `release()`: `internal()`
  reads `known` (`:207`) and the late-call guard (`:212-213`) before `release()` awaits the flag (`:293`); an erasure in
  that await let a fresh object answer `not-in-plan` with 200, and `internal()` then stored the raw account id
  (`:231`); a re-subscription in the same await let a release signed before the erasure insert a releases row. Red
  run: erase during a held probe left meta `["erased_at","pruned_at","run"]` with the monitored host name, and nothing
  ever removed it; erase during a release's flag read left meta `["account","erased_at"]`.
- Repair (the critique's counter, not the plan's comparison of `erased_at` values, which would miss a second erasure
  with the same time and relies on erase's own awaits finishing first): a private in-memory counter `erasures` (now
  `:146`), incremented as the first statement of `erase()` (now `:490`), before its first await. The alarm captures
  it before its first await (now `:172`) and returns with nothing written and nothing scheduled if it changed after
  the flag (now `:175`) or after the probes (now `:187`); erase already deleted the alarm, and a call that set the
  account up again scheduled its own. `release()` captures it before its one await (now `:310`) and answers 409
  `OPS_ERASED` if it changed (now `:312`), so `internal()` stores neither the release nor the account id. `deliver()`
  needs no check on the Worker's side: after its `sendReport` await it only deletes or updates outbox rows by id, which
  the erasure removed. A report already in flight still reaches the API after the erasure; the API's side of that is a
  lane follow-up under For the lead (`api/_lib/ops-incidents.ts:328-357`).
  The counter is in memory, which holds because the runtime keeps one instance of an object while it runs.
- Regression tests (internal.test.ts): "an erasure while a wake waits on its probes leaves nothing of that wake"; "an
  erasure while a wake waits on the kill flag leaves nothing of that wake, with the flag set or not"; "an erasure while
  a release waits on the kill flag stores neither the release nor the account" (a fresh object, then a re-subscription
  during the wait). Each asserts meta exactly `["erased_at"]`, neither the host name nor the account id in it, the
  monitors, changes, hourly, releases, baselines and outbox tables empty, and no alarm.
- What this does not claim: an erasure that lands while `internal()` awaits `schedule()`'s alarm calls. In the fake
  those are separate awaits, so a schedule could set an alarm after erase deleted it; the next wake would then find no
  plan and write an empty run row and `pruned_at` (nothing of the account) before removing the alarm. Under workerd's
  input gates other events wait while a storage operation runs; that interleaving was not exercised and is deferred
  verification.

**R46-21. Confirmed (M9 cost; the documented report retention): while the kill flag was set, reports older than a day
were never dropped.**
- Cause: only `deliver()` dropped expired reports (`:752`), and the kill branch (`:162-168`) skips `deliver()`; any
  outbox row counts as work (`dueTimes`, `:817-820`). An account with one undelivered report woke every 10 minutes for
  as long as the flag was set, against `limits.ts:56-58` ("kept at most … this long"). Red run: 288 wakes in two days,
  with the row and the alarm still there.
- Repair: a private `expireReports(now)` (now `:811`) runs `DELETE FROM outbox WHERE created_at < now − outboxKeepMs`;
  `deliver()` calls it in place of its statement (now `:783`) and the kill branch calls it before `hasWork` (now
  `:180`).
- Regression test: schedule.test.ts "while set, a report past its day is dropped, so an account with nothing else to
  do stops waking" (at most 145 wakes in two days, then an empty outbox and no alarm).

**R46-22. Confirmed (M9): a delayed call to the kill flag could undo a newer one.**
- Cause: `flags()` (`:484-489`) applied every call in arrival order. The API gives up after 10 s
  (`api/_lib/hosted-internal.ts:33`, `:129`) and reports `failed` (`ops-worker.ts:158-163`), while the Worker still
  accepts a call signed up to 300 s earlier (`internal.ts:25`, `:120`). Red run: `{kill:true}` signed now, then
  `{kill:false}` signed 60 s earlier, cleared the flag.
- Repair, both directions (the critique's preferred rule; the plan ordered only clears): the control object keeps meta
  `flags` = `{kill, signedAt}` of the newest call applied. A call signed strictly earlier is ignored and answers `{kill:
  <the newest applied>, applied: false}`; a call signed in the same second applies in arrival order, so the existing
  "set and cleared" test still passes. The order is claimed (`setMeta`) before the KV write, so a delayed call that
  arrives while a newer one writes is ignored too (now `:512-520`; `internal()` passes `signedAt`, now `:221`). What the
  claim does not give: a KV write that throws answers 500 (the API reports `failed`) and leaves the order claimed, so a
  call signed earlier and delivered later is ignored and answers the claimed value, which KV may not hold
  (`syncOpsKillFlag` then reports `updated` when that value matches the one it asked for); and two calls whose KV writes
  overlap are not ordered at KV, so the older call's write can land last. The owner's step after any `failed` (apply
  again, or read and set the key directly; `owner-actions/hosted-ops.md`) covers both. Not taken (review round below):
  undoing the claim when the write throws, since putting back the value read before the write would also drop a newer
  claim made while the write ran, and it would not order overlapping writes either. Why both ways: `syncOpsKillFlag`
  runs only when the owner changes the switch (`codium-owner-api.ts:154`), with no periodic resync, so a stale raise
  applied after a newer clear would leave every account off while the switch shows on and answered `updated`, and
  nothing would show or fix it.
- The API reads only `answer.kill` (`ops-worker.ts:160`): a refused call answers `updated` when the newest flag already
  matches it and `failed` otherwise, which is right, so no API change is needed.
- Regression test: internal.test.ts "a delayed call to the kill flag cannot undo a newer one, either way" (a clear 60 s
  earlier, a raise 120 s earlier and a clear 30 s earlier are ignored after a raise; a clear 1 s later applies; then a
  raise signed before that clear is ignored; a later raise applies).

**R46-23. Confirmed (contract mismatch): the Worker compared release environments with case; GitHub and the API
compare without case.**
- API side: the handler matches the configured environment without case (`github-webhook-handlers/ops.ts:247`) and
  forwards GitHub's spelling (`:276`); records, incidents and snoozes are keyed by `environmentKey`, which lower-cases
  (`release-guard.ts:83-85`, `ops-incidents.ts:115-119`). Worker side: the dedupe and supersede checks
  (`ops-account.ts:298-313`, `release-watch.ts:47-52`) and the baselines were exact. Red run: "Production" then
  "production" with the same sha were two watches.
- Repair: `parseRelease` (now `:1066`, `:1077`) checks the pattern (no control character, 1 to 255 UTF-16 units) on the
  environment as sent, as the API's `environmentName` (`ops-settings.ts:280-288`) and the webhook handler
  (`github-webhook-handlers/ops.ts:239`) check it, and returns it folded to lower case. Folding can lengthen a name ("İ"
  becomes two units), so checking after folding, as the first draft did, refused a 255-unit name the API accepts with
  400 and that release went unwatched (review round below); the stored name is at most 510 units. Stored rows, state and
  reports name the environment in lower case. `protocol.ts`, `release-watch.ts` and `release()`'s comments say so.
- Display effect, recorded: text built from the Worker's events shows the lower-case spelling, namely the incident
  record and its text (`ops-incidents.ts:541`, `:856`) and the revert pull request's body (`release-guard.ts:884`,
  whose input is the event's environment, `ops-incidents.ts:655`). The release list from the API's own record
  (`api/ops/releases.ts:20`) keeps GitHub's spelling. In-app and pull-request text, not public copy.
- Regression test: release-watch.test.ts "environments are compared without case, as GitHub and the API compare them"
  ("Production" sha1 accepted, "production" sha1 a duplicate, "PRODUCTION" sha2 supersedes it; rows and the state's
  watches in lower case), and "the length is checked on the name as sent: a 255-unit name with İ, longer once folded,
  is watched" (accepted and stored folded, 256 units; 256 units as sent are refused with 400).

**R46-18. Test only: the redirect check counted only `fetcher(` and `deps.fetch(` and ran on raw text.**
- Repair: source.test.ts strips comments first (a shared `code()` helper, also used by the logging test), finds every
  `fetch(` or `fetcher(` call, bare or as a member, splits its arguments up to the call's own closing parenthesis
  (`callArguments`: nested parentheses, brackets and braces counted, quoted strings skipped), and requires a second
  (options) argument that says `redirect: "manual"`; a call with no options, or one that never closes, fails. The first
  draft cut each call at the next `})` anywhere later in the file, so a bare `deps.fetch(url)` before a call with
  options passed (review round below; mutation M16). Left out, with the reason in the test: method and interface
  definitions (their first parameter has a type), `stub.fetch(` (the Durable Object), and runtime.ts's forwarder, which
  hands each caller's options to the platform unchanged and is pinned to exactly `fetch: (input, init) => fetch(input,
  init),`. The outbound calls must be exactly those in `check.ts`, `internal.ts` and `ssrf.ts`.

**R46-19. `wrangler.jsonc` had no `observability` setting.**
- Repair: `"observability": { "enabled": false }` (now `wrangler.jsonc:24-27`) with a comment: the Worker writes no
  log, but the platform's logs and traces would record each request and possibly the checked URLs, so turning them on
  is the owner's choice, made in this file because each deploy resets a dashboard toggle. wrangler 4.50.0's schema
  defines `Observability.enabled` as a boolean (`node_modules/wrangler/config-schema.json`). The CI dry run only parses
  the file (wrangler warns on unknown fields rather than failing), so the evidence is the schema and the source test.
- Regression test: source.test.ts's wrangler test asserts `observability` is exactly `{ enabled: false }`.

Comments only: `internal.ts`'s `callbackOrigin` comment said plain http was for "the CI smoke test's stand-in API"; the
smoke uses `https://vectordev.ai` answered in-process (`e2e/ops-smoke.mjs:34`, `:87`), so it now says "a local stand-in
API". `protocol.ts` (still importing nothing) names the case-folded release dedupe and the ordered `flags`.

### Checks that hold

- **R46-24. The secret is checked first.** `index.ts:35-50`, in order and before any storage: method, action,
  `internalSecret` (at least 32 characters, else 503), size, then `verifyInternalSignature`: header shapes, 300 s skew,
  HMAC over method, path, timestamp, nonce and the body's SHA-256, compared by `equalBytes` over 32 bytes in time that
  depends only on the lengths (`internal.ts:110-137`, `bytes.ts:77-83`). `accountHandle` runs after the signature. The
  first storage read is the nonce in the Durable Object (`once()`, `ops-account.ts:192`, `:933-938`), which is reached
  only through `stub.fetch`.
- **R46-25. No raw account id in a storage key or a log.** Object names are HMAC(ACCOUNT_KEY,
  `"vector-ops-account-v1\n"` + account) in hex (`internal.ts:143-148`); the control object is `control`, which no
  64-hex-digit name can equal. The value `meta.account` (`:231`) holds the id by design, to name the account in reports
  (`:765`), as A46's own reading says. No logs: source.test.ts's logging test.
- **R46-26. The kill flag.** Read at every wake and before a watch starts (`:162`, `:293`); fails closed when unreadable
  (`:879-885`); while set nothing is probed or delivered (`:162-169`). The only writers are in `flags()` (pinned now by
  source.test.ts "the kill flag is written in one place: one put and one delete, both inside flags()"); `sendReport`
  discards the API's answer (`internal.ts:191`), so no report can lower it. "At once" means the next wake after the KV
  write is visible; `hosted-ops.md` already says "while its flag spreads". KV propagation time is deferred
  verification.
- **R46-27. Caps come from the plan the Worker was sent (S1, P1).** Monitors probed (`:841-852`), release perDay and
  paths (`:319-339`), the interval (`:245-247`, `:563`, `:625-626`), validUntil and suspension (`:836-838`). `state`
  reaches only the guard (`api/_lib/ops-guard.ts:443`) and carries `plan {version, validUntil}`, counts and times,
  never caps or amounts; the config answer is counts; error answers are codes.
- **R46-28. Alarms cannot multiply or loop.** One alarm (`schedule`, `:792-802`), never less than 25 s ahead (`:798`);
  at most 125 wakes an hour (`:800`, counted at `:828-832`); a 10-minute recheck while killed (`:166`); no work deletes
  the alarm (`:794-796`); a missed due time catches up by one interval, not a burst (`:625-626`); the control object
  never schedules. Worst case if a save keeps failing: one wake per 25 s.
- **R46-29. Storage per account is bounded.** At most 10 monitors; changes and hourly totals pruned after 30 days
  (`:868-876`); releases bounded by the API's daily cap × 30 days; outbox at most 200 (`:741-744`) and now at most a day
  old even while killed; nonces 600 s. The run row: R46-17 below.
- **R46-30. Erase (P5).** Everything goes but the unexpired nonces and `erased_at` (`:470-481`), now also against a wake
  or a release in flight (R46-20). A repeated erase answers `{erased:true}` again and moves `erased_at` forward:
  idempotent, pinned by internal.test.ts "a repeated erase answers the same and keeps only the erasure time".
- **R46-31. Reports are bounded.** Batches of 20 (`limits.ts:53`). Worst case, 20 `release.regressed` events with 5
  failing URLs of 2,048 characters and a 255-character environment: about 233 KB, under the API's 256 KiB
  (`api/ops/worker.ts:32`) and its 100-event cap (`ops-incidents.ts:237`). Retries at 30 s doubling to an hour; dropped
  after a day (`expireReports`, now also while killed); without `API_ORIGIN` they wait (documented).
- **R46-32. The entry module's exports.** `default` (`{fetch}`), `OpsAccount` (a class) and `handleRequest` (an async
  function, `index.ts:28`). `025d75da`'s message says "only OpsAccount and the default handler", but `handleRequest`
  stayed; workerd accepted it (the smoke passed in 42136600777/127626223269, 42138157347/127631455750 and
  43720600992/132831553772), and the relay exports two functions the same way. Kept, since moving it would change
  `test/ops-fixture.ts:17` for no runtime gain. Pinned by source.test.ts "the entry module exports only the default
  handler and functions the runtime takes" (keys exactly `OpsAccount`, `default`, `handleRequest`; `default` exactly
  `{fetch}`; every named export a function), so a string export like `KILL_KEY` now fails locally, not only in the CI
  smoke.
- **R46-33. Nothing deploys from tests.** `workflow-compliance.test.ts:1279-1280` pin the CI steps to
  `bun run dry-run` and `bun run smoke` (and `:1312-1316` keep any copy of them out of the lane's other jobs), and
  `:1285` pins `"dry-run": "wrangler deploy --dry-run --outdir dist"`. The
  smoke only calls `mf.dispatchFetch` on `dist/` with throwaway keys; the unit tests use fakes.
- `limits.ts` and `runtime.ts`: the root contract test still holds (`test/ops-worker-contract.test.ts:83-117`), and
  `runtime.ts` declares only what the Worker calls.

### Readings, not repaired

- **R46-17 (plausible: bounded by the API, not by the Worker).** The run state is one JSON meta row. A watch holds about
  51.6 KB at worst (5 URLs × 2,048 characters in `urls`, `streaks`, `last`, `failures` and `baseline.ok`). With the
  API's bounds (20 repositories, `ops-settings.ts:33`; one production environment each, case-folded now; URLs of at
  most 2,048 characters, `ops-settings.ts:38`) and one running watch per repository and environment, the row stays near
  1.06 MB. Cloudflare's published 2 MB limit per row of SQLite-backed Durable Objects would be reached near 40
  concurrent watches; that limit is unverified here (developers.cloudflare.com is outside this session's network). The
  Worker's own bounds (100 releases a day, 120 minutes) do not keep the row under it. If it were exceeded, `release()`
  would answer 500 and the API 503, and a failing save in a wake skips the wake count, so the account wakes once per
  25 s. Lane follow-up: move watches to their own table if the repository cap grows. **Bounded in the Worker 21 Nov
  2026 (`codium-api-fixes`):** `OPS_LIMITS.maxRunStateBytes` 1,900,000 and `maxConcurrentWatches` 31, derived from
  the worst watch (`limits.ts`); `release()` records a release past the cap as skipped and answers 200
  `{accepted: false, reason: "daily-limit"}` (a reason the API already records), and `save()` drops the cached DNS
  answers and then ends the oldest watches (stopped) instead of writing a row over the bound. Test: an Ultra account
  with 10 monitors and 10 domains at 2,048-character URLs and 31 watches of five such paths, each with a passed
  baseline and a failure per path, stores a run row above 80 % and below the bound, and a 32nd release answers 200
  unwatched (dropping the cap fails it). `test/ops-worker-contract.test.ts` pins `OPS_SETTINGS_LIMITS.repos` (20) at
  or below the cap. The trim in `save()` is a backstop: at these limits the API cannot reach it. Needs the owner's
  Worker deploy to take effect; no API change.
- A `release` to a fresh object that is accepted or refused with 200 stores `meta.account` and nothing else (`:231`);
  an erasure in between now refuses it (R46-20).
- Running watches continue after `releaseGuard` becomes null (paused) until they end, matching "no new watches".
- The erase tombstone, an HMAC-named object holding `erased_at`, holds nothing about the account.
- A refused `flags` call answers the newest call applied through the switch; a key set or deleted directly with
  wrangler is not part of that order and is not seen by the answer (`hosted-ops.md` says so).
- Clock skew between API instances: two switch changes signed in different seconds by instances whose clocks differ
  by more than that gap could apply in the wrong order. After an earlier call from an instance whose clock runs ahead,
  a re-applied switch from a correct clock is ignored as older until real time passes the skewed stamp (at most the
  300 s the Worker accepts), so applying again does not always apply; the API then answers `failed` again
  (`ops-worker.ts:160`) when it asked for the other value, so the owner is not misled. `owner-actions/hosted-ops.md`
  says "normally applies" and points to setting the key directly when it answers `failed` again.

### For the lead

- No defect was found in another lane's file.
- Lane follow-ups outside R46b's scope (Codium lane files; file:line and why), not fixed here:
  - R46-2's product reading, carried forward from R46a: a monitor that stays inconclusive with `resolver` is never
    probed or reported, and no screen says so. Proposed: an ops-screen line, or a counter in the Worker's `state`.
  - Relay (A39), the same three patterns: `packages/relay/src/index.ts:81-84` reads the whole body before its check
    (R46-16); `packages/relay/src/account-relay.ts:810-815` applies flags in arrival order (R46-22);
    `packages/relay/wrangler.jsonc` has no observability setting (R46-19). Its index also exports the functions
    `handleRequest` and `offeredTicket` (`:32`, `:41`), which workerd accepts.
  - `api/_lib/ops-cleanup.ts:94` skips the Worker's erase silently when `!opsErasable()`: if the Worker's address or
    secret was removed after an account used ops, deletion finishes while the Worker may still hold its data.
    Proposed: keep the erase pending for accounts in `ops:accounts`. **Fixed 21 Nov 2026 (`codium-api-fixes`):** an
    account on `ops:accounts` in either mode now throws 503 `OPS_UNAVAILABLE` before any erase step, so the ops part
    fails and the deletion is retried; codium-deviations "A46 tombstone".
  - `github-webhook-handlers/ops.ts:276` could forward `repo.environment`; after R46-23 that only changes display, and
    the incident record stores the lower-case environment either way.
  - P5 on the API side of R46-20: `api/_lib/ops-incidents.ts:328-357`. A report already in flight in the Worker's
    `sendReport` when `eraseAccountOps` calls the Worker's erase (`api/_lib/ops-cleanup.ts:94`) can reach
    `POST /api/ops/worker` after `eraseAccountOpsRecords` has run. `handleOpsReport` does not check the deletion
    tombstone, so `handleEvent` (`monitorDown`, `releaseRegressed`) and `markTaken` (`:314`, `:353`) can write an
    incident and the events set for an account being deleted. The `check` pass of `finishAccountDeletion`
    (`api/_lib/codium-erase.ts:566`) probably removes them, but only if it runs after the late report lands. Proposed:
    before any write, drop the events of a report whose account has a tombstone (`accountDeleting(report.account)`,
    `api/_lib/codium-tombstone.ts:106`) and answer 2xx so the Worker stops resending, with a root test in
    `test/account-delete.test.ts`. A48/A57 code, outside R46b's files; not fixed here. **Fixed 21 Nov 2026
    (`codium-api-fixes`)** as proposed: `handleOpsReport` answers `{taken: 0, duplicates: 0, skipped: n}` before the
    loop when the tombstone is set; codium-deviations "A46 tombstone".
- R46-17's row bound (above) if the repository cap grows. (21 Nov 2026: the Worker now bounds it itself; the contract
  test fails if the cap grows past `maxConcurrentWatches`.)

### Review round (15 Nov 2026)

Six non-blocking findings from the package review (two of them the same `parseRelease` case); all taken, none disagreed
with. One offered a choice; the reason for the option chosen is below.
- The redirect source test cut each call at the next `})` anywhere later in the file, so a bare `deps.fetch(url)`
  before a call with options passed (the review's probe showed both calls as `true`), and a call followed by no `})`
  ran to the end of the file. `callArguments` now ends each call at its own closing parenthesis and the test requires
  a second (options) argument with `redirect: "manual"` (R46-18 above; M16 added, and M10 re-run against it).
- `parseRelease` checked the length after folding, and folding can lengthen a name, so a 255-unit environment the API
  accepts could fold to 256 and be refused with 400. The pattern now runs on the name as sent and the folded name is
  returned with no second check (R46-23 above; a new release-watch case; M17 and M18).
- `flags()`'s claimed order: the review offered undoing the claim when the KV write throws, or recording the limits.
  Recorded, not undone: putting back the value read before the write would also drop a newer call's claim made while
  the write ran (a later delayed call could then apply over it), and it would not order overlapping writes either.
  R46-22 above, the `flags()` comment and `owner-actions/hosted-ops.md` now name both limits, and the owner's step
  after `failed` covers them.
- `owner-actions/hosted-ops.md` stated "the new call is signed later, so it applies" as a guarantee; with API clocks up
  to 300 s apart a re-applied switch can be ignored as older. It now says "normally applies" and points to setting the
  key directly when the switch answers `failed` again, and names the clock limit. Code unchanged (Readings above).
- P5 on the API side of R46-20 (`api/_lib/ops-incidents.ts:328-357`): added under For the lead as a lane follow-up
  with its proposed fix and root test; not fixed here (A48/A57 code outside R46b's files).

### Mutations

Each was applied as an exact one-occurrence substitution by `/tmp/vector-v2/codium/r46b/mut/run.py` (M16–M18, and M9
and M10 again against the repaired tests, by `/tmp/vector-v2/codium/r46b-fix/run.py`), run against the named file with
`-t`, and restored; a byte comparison with the saved copy confirmed every restore.

| Mutation | Turns red |
| --- | --- |
| M1: read the body with `arrayBuffer()` again (index.ts) | internal "a body sent with no length…" |
| M2: `readPrefix` limit without `+ 1` | internal "a body sent with no length…" (the exact-32-KiB step) |
| M3: drop the erasure check after the probes | internal "an erasure while a wake waits on its probes…" |
| M4: drop the erasure check after the flag | internal "…waits on the kill flag…" (the flag-set round; with the flag clear, the check after the probes still catches it, so the test runs both) |
| M5: drop `expireReports` in the kill branch | schedule "while set, a report past its day is dropped…" |
| M6: drop the flags ordering check | internal "a delayed call to the kill flag cannot undo a newer one, either way" |
| M7: `<=` in place of `<` (ties refused) | internal "the kill flag is set and cleared through the control object…" (existing) |
| M8: record the order only on raises (the plan's one-sided rule) | internal "a delayed call…" (the raise signed before the newer clear) |
| M9: no `toLowerCase()` | release-watch "environments are compared without case…" |
| M10: add `?? (await fetch(url, { method: "GET" }))` to check.ts's probe call | source "every outbound fetch refuses to follow redirects" (HEAD's version of that test stays green under it) |
| M11: restore `export { OpsAccount, KILL_KEY }` (the pre-`025d75da` defect) | source "the entry module exports only…" |
| M12: remove the `observability` line | source wrangler "one Worker, the OpsAccount object on SQLite storage…" |
| M13: add `OPS_FLAGS.delete(KILL_KEY)` in `deliver()` | source "the kill flag is written in one place…" |
| M14: drop the erasure check in `release()` | internal "an erasure while a release waits on the kill flag…" |
| M15: drop `this.erasures++` | all three erasure-race tests |
| M16: add a bare `await deps.fetch(url)` before check.ts's probe call | source "every outbound fetch refuses to follow redirects" (the first draft of that test stayed green under it: the review's probe, `/tmp/vector-v2/codium/r46b-review/probe.ts`) |
| M17: check the environment's pattern after folding (the first draft) | release-watch "the length is checked on the name as sent…" |
| M18: drop the environment's pattern check | release-watch "the length is checked on the name as sent…" (the 256-unit refusal) |

Red runs against the HEAD sources (`index.ts`, `ops-account.ts`, `internal.ts`, `protocol.ts`, `release-watch.ts` and
`wrangler.jsonc` copied back, then restored and checked with `diff -q`): internal.test.ts 18 pass, 5 fail (the body,
flag-order and three erasure-race cases; the body case saw `pulled: 1025, cancelled: 0`); schedule.test.ts 12 pass,
1 fail (288 wakes); release-watch.test.ts 14 pass, 2 fail (the case and the length-as-sent cases; the second run
after the review round, with `ops-account.ts` alone copied back); source.test.ts 8 pass, 1 fail (the observability
assertion; the tightened redirect, exports and kill-writer tests pass on HEAD and pin it).

### Tests run here (one file at a time)

Through `vector-serial` with `--timeout 30000`: `packages/ops-worker` with `bun test`; the root `test/` with
`bun test ./<file>`.

| Package | File | Before (HEAD `d866364f`) | After |
| --- | --- | --- | --- |
| ops-worker | `test/internal.test.ts` | 17 pass (97) | 23 pass (168) |
| ops-worker | `test/schedule.test.ts` | 12 pass (137) | 13 pass (141) |
| ops-worker | `test/release-watch.test.ts` | 14 pass (85) | 16 pass (94) |
| ops-worker | `test/source.test.ts` | 7 pass (58) | 9 pass (62) |
| ops-worker | `test/on-call.test.ts` | 16 pass (60) | 16 pass (60) |
| ops-worker | `test/protocol.test.ts` | 4 pass (63) | 4 pass (63) |
| ops-worker | `test/ssrf.test.ts` | 12 pass (271) | 12 pass (271) |
| ops-worker | `test/check.test.ts` | 16 pass (70) | 16 pass (70) |
| ops-worker | `test/bytes.test.ts` | 6 pass (12) | 6 pass (12) |

Root files, after the change (what each imports):

| File | Imports | After |
| --- | --- | --- |
| `test/ops-worker-contract.test.ts` | the Worker's sources directly | 8 pass (59) |
| `test/on-call.test.ts` | `./ops-fixture` | 30 pass, 1 skip (299) |
| `test/ship-desk.test.ts` | `./ops-fixture` | 26 pass, 1 skip (270) |
| `test/release-guard.test.ts` | `./ops-fixture` | 36 pass, 1 skip (345) |
| `test/ops-guard.test.ts` | `./ops-fixture` | 13 pass (87) |
| `test/ops-payment-pipeline.test.ts` | `./ops-fixture` | 10 pass (78) |
| `test/account-delete.test.ts` | `./ops-fixture` | 37 pass, 1 skip (454) |
| `test/github-webhook.test.ts` | `./ops-fixture` | 30 pass (223) |
| `test/ops-screens.test.ts` | `./ops-fixture` | 6 pass (41) |
| `test/ops-domain-health.test.ts` | `./ops-fixture` | 9 pass (57) |

After the review round, re-run with the same counts as above: `packages/ops-worker` `internal`, `on-call`, `schedule`,
`source` and `release-watch` (16 pass, 94), and root `ops-worker-contract`, `release-guard`, `on-call` and `ship-desk`;
`bun typecheck` in `packages/ops-worker` and the api tree, and `prettier --check` on the three changed files, clean
again. The root skips are the Valkey cases (`VECTOR_TEST_REDIS_URL`), CI only. `bun typecheck` clean in
`packages/ops-worker`, and the api tree (`packages/engine`, `bun typecheck --project ../../tsconfig.json`) clean.
`prettier --check` clean on the five changed sources and four changed tests; `git diff --check` clean. The full turbo
typecheck is a pre-push step and was not run in this step.

**CI only:** Vector Codium's Codium tests job (the changed ops-worker test files since the base and the root files it
always runs, with Valkey and Postgres), its HttpApi exerciser (no route changed) and check:generated, its Hosted
services "Ops Worker (dry run and miniflare smoke)" job (every signed call in the smoke now goes through `readPrefix`
on workerd's own request body; the dry run parses the new `observability` key), typecheck.yml, and
vector-hosted-ci.yml's Hosted tests job (every `packages/ops-worker` test) and its Ops Worker job. CI: pending; this
step left the change uncommitted. After the package commit is pushed and the three dispatches (Vector Codium with
base `origin/release-finish`, typecheck.yml, then vector-hosted-ci.yml once the Vector Codium run has finished) are
green, a `docs(codium)` receipt commit adds dated lines with the run and job ids here and in the a46 notes. A failure
gets a root-caused fix commit, not a re-run, except for the RULES-v2 flakes.

CI, 15 Nov 2026 (recorded by Codium finish DZ): R46b's runs at `dfef44e3`. Vector Codium run 43726343168 is green
under the lane rule. `failed_only` lists one failed job of 18, Codium tests job 132848987130. Its visible tail shows
"Codium: 148/148 test files passed" and the four baseline MISS lines with `fail=0`, and its step list
(`get_workflow_job`) shows that "Run the Codium test files" and "Check generated client" succeeded and only "Run
HttpApi exerciser gates" failed. typecheck.yml run 43726319195 and vector-hosted-ci.yml run 43726762155 concluded
success (run conclusions; the Ops Worker and Hosted tests job logs were not read). See `codium-deviations.md` "Lane
status (15 Nov 2026, codium-finish)".

Edits to `api/_lib/model-plan-*.ts`: none.

With R45a, R45b, R46a and R46b, P7 now covers A44–A50: A44 and A47–A50 in "P7 review decisions", A45 and A46 here.
