# install-ps1-cmdlets: CI-INSTALL-PS1

Branch `install-ps1-cmdlets`, cut from origin/main `609763f72`. It covers one Vector v2 leftover P0 item, CI-INSTALL-PS1. It changes the live Windows installer, `packages/web/public/install.ps1`, so the PR opens as a draft for the owner's final look. It is kept alone on purpose, so it can be reverted alone. No flag is involved.

Files: `packages/web/public/install.ps1`, the new `packages/engine/test/installation/windows-installer-script.test.ts`, `packages/engine/script/verify-windows-installer.ts`, this file, and a pointer beside the flag in `docs/vector/build/ci-harness-repairs.md` (no open PR touches that file now).

## 2026-11-21, CI-INSTALL-PS1: the deferred upgrade path without cmdlets

**The gap.** `ci-harness-repairs.md` (2026-11-20, "Windows deferred removal without PowerShell command discovery") flagged that install.ps1's deferred upgrade keeps the exposure #47 removed from `windows-remove.ts`: `ConvertTo-Json` and `Join-Path` in the status writer, `Get-FileHash` at three sites, and `Get-Process`, `Test-Path` and `Start-Sleep` in the identity check and both waits. Every Windows `vector upgrade` downloads the live script (`standalone.ts:106`), runs it detached in Windows PowerShell 5.1 and waits 310 s for `prepared` (`standalone.ts:264`). A stall in command discovery or module auto-load there fails safe, because nothing is replaced, but the upgrade hangs until a deadline.

**The fix.** It copies #47's shapes. The file stays ASCII with LF line endings. Line numbers are this branch's.

1. `Write-OperationStatus` (:46). The JSON is built from literals, and each value goes through `[regex]::Replace` with the class `'[\\"\x00-\x1f]'` and an evaluator that writes `\u` and four lowercase hex digits. This is #47's escaper, held in one `$escape` script block and used for `state`, `version` and `message`. `Join-Path` became `[IO.Path]::Combine`. The signature line is byte for byte the same, because `verify-windows-installer.ts` lifts the function out by it. The JSON field order is now fixed (schemaVersion, state, version, message). That is harmless: the engine's `Schema.Struct` in `prepared()` and the harness read fields by name.
2. `parentTicks` (:98) and `$expected = $WaitForStartTicks.ToString()`. The `if ($WaitForProcessId -gt 0)` block (:169) is now the cmdlet-free twin of `windows-remove.ts:50-70`:
   - the identity check before `prepared`;
   - the acknowledgement wait, using `[IO.File]::Exists` and `[Threading.Thread]::Sleep(50)`;
   - the ReparsePoint attribute check in place of `Assert-Regular`, because that function runs `Get-Item`;
   - the exit wait, using `Sleep(200)`.

   The deadlines stay the same (10 s for the acknowledgement, 15 min for the exit), and so do all six messages. The link check on the acknowledgement keeps `Assert-Regular`'s message, and the identity and timeout throws stay separate, so no message changed. There are two small behaviour changes, and both leave the installation unchanged:
   - In the exit wait, a process that is exiting (its start time cannot be read) now counts as still running until it is gone, as in #47. Before, reading its start time threw, so the upgrade failed. Before `prepared` and during the acknowledgement wait, it still fails, with the identity message.
   - A directory at the acknowledgement path used to pass `Test-Path` and then be refused by `Assert-Regular`. `[IO.File]::Exists` is false for a directory, so the wait now runs to its 10 s deadline and fails with the "did not acknowledge" message.
3. `fileSha256` (:103) uses `[IO.File]::OpenRead` (FileShare.Read, the same sharing as `Get-FileHash`), `SHA256`, `BitConverter` and lowercase. It replaces the three `Get-FileHash` sites: the existing install's receipt check (:124), the archive check (:143) and the new receipt (:167). This is the only change on the interactive `irm | iex` path. There, `Write-OperationStatus` returns at once and the waits never run.

**Left as is, by the lead's minimal-change ruling (plan section 3; rulings file, "Section 3 defaulted calls").**

- The top of the script still runs `Add-Type` (:11-12) and `Join-Path` (:23). These are the first uses of Microsoft.PowerShell.Utility and Microsoft.PowerShell.Management, alongside `Set-StrictMode`, `New-Object`, `Out-Null` and `Test-Path`. They run before any lock or status file exists. A stall there shows as the engine's 310 s "did not become ready" error, with nothing replaced.
- Between `preparing` and `prepared`, the receipt check and the download still use cmdlets: `Test-Path`, `Get-Item` (also inside `Assert-Regular`), `Get-ChildItem`, `ForEach-Object`, `Sort-Object`, `Join-Path`, `New-Object`, `ConvertFrom-Json`, and `Get-Item` for the archive length. All of them are in Core, Utility or Management, which the top lines have already loaded, so none needs a module auto-load. Each still goes through command lookup. A stall there also fails safe (310 s, nothing replaced).
- So this item takes command lookup out of the status writer, the three hashes, the identity check and both waits. It does not make the whole deferred path cmdlet-free. Doing that would be a larger change to the live script, and it is not done here.

**Tests.**

- T1, the new portable `windows-installer-script.test.ts`: "install.ps1's deferred upgrade path runs no cmdlet that needs command discovery".
  - It checks that the file is ASCII, then blanks strings and comments without moving offsets (the strip regex of `ownership.test.ts`).
  - It finds `Write-OperationStatus`, `parentTicks`, `fileSha256` and the `if ($WaitForProcessId -gt 0)` block by brace matching. Each must be present exactly once.
  - In those spans, every Verb-Noun word and every command-position word must be a language keyword or one of those three functions. The script's other functions are excluded on purpose, because `Assert-Regular` runs `Get-Item`.
  - No double-quoted string in those spans may hold a `$( )` subexpression.
  - The waits keep their deadlines, polling and messages.
  - `parentTicks` keeps its `$null` and `''` contract.
  - No `get-filehash` appears anywhere, `fileSha256` appears 4 times, and the three call sites are exact.
  - `verify-windows-installer.ts` still holds the extraction regex, which still lifts the same function.
- T2, the same file: "install.ps1's status writer escapes JSON the way JSON.parse reads it back".
  - The writer must apply exactly the class `[\\"\x00-\x1f]` to `$state`, `$Version` and `$message`, with the `'\u{0:x4}'` evaluator.
  - It then evaluates the writer's `$json = ...` line (literals joined by `+` with the Replace calls) and round-trips several values through `JSON.parse`: code points 0x00-0x1f, a quote, a backslash, a Windows path with quotes plus CR, LF and TAB, non-ASCII text with a surrogate pair, and a state and version that need escaping too.
- T3, Windows PowerShell 5.1, runs only in the `windows` job of `vector-standalone-installers.yml`. The "atomic status transitions" checkpoint adds a fourth transition whose message holds a quote, a backslash, CR, LF, TAB, `[char]1` and non-ASCII text, and `ConvertFrom-Json` must give it back exactly. The writer's literals now hold double quotes and backslashes, so the checkpoint runs as `-EncodedCommand` (the pattern `standalone.ts` `launch()` uses) instead of `-Command`. That keeps command-line quoting out of the result. New evidence key: `statusMessageEscaping`. The later checkpoints already run the waits and all three hash sites on real PowerShell: "unacknowledged update preparation", "running executable update preparation" and "running executable replacement".
- Commits: the test-only commit comes first, so T1 and T2 are red on it, and the fix follows. To see red-before on the fix commit, put main's `packages/web/public/install.ps1` back and keep the tests.

**Evidence so far.** This was drafted without a Bun turn, so no Bun test, typecheck or PowerShell has run on this branch yet. As a logic check only, a Python transcription of T1 and T2 was run over the installer text:

- It passed on this branch's `install.ps1`.
- It failed on main's. T1 named `ConvertTo-Json`, `Join-Path`, `Get-Process`, `Test-Path`, `Start-Sleep` and `Assert-Regular`, and reported `parentTicks` and `fileSha256` missing. T2 found no escape class.
- It caught each scratch mutation, applied to copies, never to the branch file:
  - `Start-Sleep -Milliseconds 50` back in the acknowledgement loop: T1, naming `Start-Sleep`.
  - The backslash dropped from the escape class: T2, on the class and on the round trip.
  - `Assert-Regular $acknowledgement` back: T1.
  - One `Get-FileHash` back: T1.
  - `AddSeconds(20)`: T1.
  - The alias `gps` in the block: T1.
  - A `$(Join-Path ...)` inside a string: T1.

This does not replace the runs below.

**Pending, for the verifier and the PR** (record each result here):

- Red-before: `git checkout origin/main -- packages/web/public/install.ps1`, then `cd packages/engine && bun test --timeout 30000 test/installation/windows-installer-script.test.ts`. Expect 0 pass and 2 fail. Restore the file with `git checkout HEAD -- packages/web/public/install.ps1` and compare its sha256.
- Green: the same command, 2 pass. Regression: `bun test --timeout 30000 test/installation/ownership.test.ts` (the same counts as on main) and `bun typecheck` in packages/engine.
- Mutations: the two from the plan (`Start-Sleep -Milliseconds 50` in the acknowledgement loop, which turns T1 red; the backslash dropped from the class, which turns T2 red and T3 red on Windows). Compare the sha256 after each restore.
- Windows: the `windows` and `windows-native` jobs of `vector-standalone-installers.yml` must pass on the PR, and so must a re-run of `windows`. Record the run and job ids, the time of the "atomic status transitions" checkpoint, and the evidence artifact's `statusMessageEscaping`, `unacknowledgedExitPreservesOld` and `runningExecutableReplacement`. The engine (windows) shards of `test.yml` also run T1 and T2. The test normalizes CRLF, in case a Windows checkout converts line endings.

**Owner actions.**

- Merging this deploys it. Vercel builds main on every push, and `/install.ps1` is served `no-store` (`vercel.json:439`), so the next Windows install, and every `vector upgrade` after it, runs the new script. The draft PR is therefore the gate. A reviewer reads the whole `install.ps1` diff for PowerShell 5.1 parse safety. A parse error anywhere breaks every Windows install, interactive ones too, because `iex` parses the whole script before it runs. Most new constructs are already in #47's CI-proven worker. The ones that are not: `$escape` passed to `[regex]::Replace` as a variable rather than inline, `[IO.Path]::Combine`, and `fileSha256`'s typed parameter, which has the same form as `Assert-Regular`'s.
- After the deploy, an optional check: `https://vectordev.ai/install.ps1` serves this branch's bytes.
- Rollback: revert the fix commit. The push to main redeploys.

**What could go wrong.**

- The blast radius is every Windows install and upgrade.
- On a machine with the FIPS-only policy, `[Security.Cryptography.SHA256]::Create()` is expected to give .NET Framework's FIPS-approved class, as `windows-remove.ts` already relies on. This is not tested on such a machine. If it throws, the install stops with nothing replaced.
- The auto-loads at :11-12 and :23, and the cmdlets in the receipt check and the download, stay (see above).
