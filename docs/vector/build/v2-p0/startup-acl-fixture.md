# startup-acl-fixture: STARTUP-ACL-FLAKE

Branch `startup-acl-fixture`, cut from origin/main `23d09a96b`. It covers one Vector v2 leftover P0 item, test only.
Four open PRs (#61, #62, #64 and #67) touch the CI harness log `ci-harness-repairs.md`, so the dated entry lives here.
Fold it back into that file once they merge, next to the 2026-11-20 entry "Windows company policy folder test reached
the real PowerShell ACL reader" (#51).

Files: `packages/core/test/local-mode/startup.test.ts` and this note. `packages/core/src/config/managed.ts` and
`packages/core/src/local-mode/startup.ts` are unchanged.

## 2026-11-21: Windows planted company file test reached the real PowerShell ACL reader

Changes: `packages/core/test/local-mode/startup.test.ts` only. A failed or timed-out PowerShell read still yields no
entries, an `unreadable` verdict and Vector Local on with Web access None. No deadline, assertion, skip or retry
changed. The 20 s PowerShell timeout in `managed.ts` and the 30 s test timeout stay.

Line numbers: :198, :199 to :201, :283 and :346 are main's at `23d09a96b`, as the job and the plan cite them. On this
branch those lines are :212, :213 to :215, :332 and :395. The new case starts at :231.

**Failure.** pull_request run 44913258841 (branch `version-regen` at `687467eb7`), attempt 1, unit (windows), job
136883105861. `startup.test.ts:199`, "LocalStartup.policy > leaves out a company file a standard user could have
written, as the engine's config does", took 15731.14 ms. It expected `enabled: false` and received `enabled: true`,
`web: "none"`, with the single warning `Vector could not read who may change <tmp>\managed.` (Expected -1, Received
+12). Attempt 2 of the same run passed, and the case took 1999.34 ms there.

**Cause.** The same isolation gap #51 closed in `local-policy.test.ts`. Three calls in `startup.test.ts` passed no
`trust` options: :198 (`LocalStartup.policy`), :283 (`LocalStartup.managed`) and :346 (`LocalStartup.ca`), at
`23d09a96b`. On Windows `companyPolicy()` then went `ConfigManaged.check()` -> `windowsCheck()` -> `cachedAcl()` -> the
real `powershellAcl()`, a `spawnSync` of `powershell.exe` with a 20,000 ms timeout. The read came back with no entry
for the managed folder, `windowsCheck` reported the first missing entry (the folder) as `unreadable`, and the policy
failed closed as designed. The product behaved correctly. The test reached a real, slow process that a policy
semantics test does not need.

**Evidence.**

- 15731.14 ms is below the 20,000 ms timeout, so this read was not cut off by the timeout, contrary to the plan's first
  reading. `powershellAcl` returns `{ entries: {} }` for any non-zero or null exit status, and a path whose read throws
  inside the script prints no owner line. Either gives this verdict. The log shows nothing from inside the spawn, so
  which one happened is not known.
- The runner was stalled at the time. Between 15:46:15 and 15:47:00, core tests ran 10 to 45 times slower than in
  attempt 2: "identity pins > reads an https server's public key pin" took 8508.4 ms against 186.5 ms, three
  `EgressHttpClient`/`EgressLogStore` cases took 525 to 560 ms against 29 to 55 ms, and the next real PowerShell read in
  this file ("LocalStartup.managed", :283) took 11598.68 ms against 256.33 ms. That case passed: its read succeeded,
  only slowly. A failed read is never cached, so :283 started PowerShell again.
- Only the three untrusted calls start PowerShell. Every other managed file read in the file already goes through
  `trusted()`, whose fixture reader answers on Windows. Those cases took 4 to 16 ms in both attempts.

**Change.**

- `plantedTrust(root)`, next to `trusted(root)`: on Windows it returns `{ trust: { acl: plantedAcl(root) } }`, and `{}`
  elsewhere, so POSIX runs keep the real owner and mode checks. It is spread into the three calls, which keep their
  place. Every assertion keeps its text. The helper is not named `planted`, because :198's `const planted` would
  shadow it.
- `plantedAcl(root)` describes a company file a standard user planted. That user's SID,
  `S-1-5-21-1000000000-1000000000-1000000000-1001`, owns the managed folder and each of its policy files that exists,
  with one allow rule for itself at `0x1F01FF` (full control). The reader also reports that SID as the user running
  Vector, as the real reader's `U` line does. Without `trust.user`, the running user is not an accepted owner.
- `trusted()` and `plantedAcl()` share one path filter, `managedAcl(root, acl, user?)`: the managed folder plus
  `vector.json` and `vector.jsonc` when they exist, and no other path. `trusted()` answers exactly as before (SYSTEM,
  no rules, no user).
- New case, run on every OS (:231): "a planted company file is left out on Windows without PowerShell, and a failed or
  timed-out ACL read turns Vector Local on". It forces the Windows checks with `trust.platform: "win32"`:
  - With `plantedAcl`, the result is `{ enabled: false, lock: false, endpoints: [], allow: [] }` with no updates, and
    the warnings are exactly ``[`${ConfigManaged.UNTRUSTED} <managed> is not owned by Administrators or SYSTEM.`]``.
  - The reader answers for the folder and the existing `vector.json`, not for an absent `vector.jsonc` or for
    `other.json`, and reports the planter as the user.
  - With `() => ({ entries: {} })`, which is what a failed or timed-out PowerShell gives back, the result is
    `{ enabled: true, web: "none" }` with exactly the warning job 136883105861 logged.
- The file's header comment now says no case starts PowerShell on Windows, and names this job.

**Why the tests still mean what they meant.** The real `windowsCheck` and `windowsReason` still judge each answer: the
owner list, the write-rights masks and the `user` flag all apply. Only the source of the owner and rules changes, from
PowerShell to a fixed answer. That answer describes what Windows reports for a file a standard user created in
`C:\ProgramData\vector`: the creator owns it and has full control. So :199 to :201 and the :283 and :346 assertions
check the same verdict ("a standard user's file is not company policy") through the same code. That `powershellAcl`
reads a real user-owned temporary file as untrusted is still tested on Windows by engine
`test/config/managed-trust.test.ts` "checks a real file's access rules with PowerShell" (:259) and "reads a real
folder's access rules in the policy file's place" (:272). Before this change, :346 would also have passed after an
empty read, because an unreadable company file adds no certificate and drops none of the user's. With the fixture it
passes because the file is left out as untrusted.

**Validation** (macOS, Bun 1.3.14, one file at a time from `packages/core`, with
`bun test --timeout 30000 test/local-mode/startup.test.ts`):

- Red before (scratch, never committed). On main's file, :198 was given
  `trust: { platform: "win32", acl: () => ({ entries: {} }) }`. :199 failed with job 136883105861's diff line for line:
  `enabled` false to true, plus `endpoint_domains`, `locked_keys`, `user_may`, the one "could not read who may change
  <managed>" warning, `web: "none"` and `web_domains`. Expected -1, Received +12. The file was restored and its sha256
  matched.
- The Windows path on this Mac (scratch, never committed). W1 made `plantedTrust` return
  `{ trust: { platform: "win32", acl: plantedAcl(root) } }` on every OS: 19 pass, 0 fail, so the three cases pass
  through the Windows checks with the fixture alone. W2 swapped the empty reader into the same spot: 17 pass, 2 fail.
  :199 failed with the job's diff and :283 got `true`. The file was restored and its sha256 matched.
- Green: 19 pass, 0 fail, 61 `expect()` calls (on main: 18 pass, 55 calls). `bun typecheck` in `packages/core` exit 0.
  Prettier check clean.
- Mutations, each restored, with the restored file's sha256 compared equal:
  - M1: `plantedAcl`'s owner set to SYSTEM (`S-1-5-18`) with no rule. The new case went red at :240 (`enabled` false to
    true).
  - M2: the owner check in `managed.ts` `windowsReason` commented out. The new case went red only at the exact-warning
    assertion (:242). The full-control rule still left the file out, now as `<managed> lets S-1-5-21-…-1001 change
    it.`, which is why the rule is there.
  - M3: `windowsCheck` changed to accept `acl.user` as an owner without `trust.user`. The new case went red at :240.
    This mutation covers the reader's `user` field.

**What Windows CI must show.**

- test.yml unit (windows) passes `packages/core`'s `startup.test.ts` with all 19 cases. The three planted cases and the
  new case take milliseconds, and none logs "could not read who may change".
- The engine (windows) shard holding `managed-trust.test.ts` still passes its real PowerShell tests (:259 and :272).
- Linux and macOS are unchanged for the three calls: `plantedTrust` is `{}` there, and the new case runs everywhere.

**What could go wrong.** Low risk. On Windows the three cases now check against a fixture instead of real ACLs. If
someone dropped `plantedTrust` from the :198 call, only Windows would show it, and only as the old flake. Linux and
macOS would stay green, because the spread is a no-op there. No warm-up hook was added, as the lead ruled: the fixture
removes the PowerShell start from these cases instead of moving it out of the timed window. Optional follow-ups, not
part of this fix, are #51's: `-InputFormat None` on the PowerShell call, and a review of the synchronous 20 s
`spawnSync` blocking the desktop's 30-second policy refresh.
