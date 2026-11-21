# Process-spawn hot spot: design review (finish plan §4 item 40)

Read-only review, written 2026-11-14 03:10 UTC for the people resolving §3 steps 4, 6 and 10 (the orchestrator for `build-integrate` and `build-native-shell`, Codex for `hands`). Nothing in any repository was changed. Every file was read with `git show origin/<branch>:<path>` from `~/.cache/vector-review-main` after a fetch. Conflict lists come from the read-only legacy form `git merge-tree <base> <a> <b>`, which writes no objects.

**Second check (2026-11-14, about 05:30 UTC).** Every file:line citation in §1–§4 was re-read at the heads below with `git show`, and the pairwise conflict lists and hunk counts were re-derived with `git merge-tree --write-tree` (objects only): PF×BI 1 file (only the import line), PF×H 2 files (shells.ts 1 hunk, its test 2), BI×H 5 files (pty.ts, mcp/index.ts and tool/shell.ts 1 hunk each, ipc.ts 2, ipc-security.test.ts 1), PF×NS 1 file with 7 hunks, BI×NS none. The analysis holds. Corrected in place, each marked "Corrected in review" where it changes a recommendation: the hands head note; the list of `ProcessIsolation.launch` call sites (seven, not four); NS refusing legacy launches only once isolation is required; the origin of the `remote-changed`/`vault-changed` broadcasts (Codium, not BI's own work); where the C2 Windows refusal must go (§4.1) and what S4-3/S4-4 can expect at the ShellJobs level; two small citation and wording fixes in C3 and the NS policy. Both `hands` and `build-native-shell` moved after the first pass; see the table.

## Heads reviewed

| Short name | Branch | Head | Note |
|---|---|---|---|
| M | `main` | `0dcbb8e2d` | Every lane below is based on it (0 behind). |
| PF | `process-finish` (#26) | `3ec7fb14b` | The 2 commits after `4059f6a70` change docs only. The code is identical. |
| H | `hands` (#22) | `d883e2d78` | The one commit after `6f53a6ec9` changes 9 files: the Windows computer helper's native sources and its unit test, its self-test script, and the hands evidence and progress docs. It touches no hot-spot file, so the hot-spot files are identical. (Corrected in review: this row first said "one Windows test only".) `hands` moved again to `321b4ea7f` after this review (7 commits, 17 files, no `packages/core`, `packages/engine` or `desktop/src/main` file); the hot-spot files are still byte-identical to `6f53a6ec9`. |
| BI | `build-integrate` | `50b4f82c2` | |
| NS | `build-native-shell` | `8b2cbc76f` | Based on `017f7144b`, which is inside BI. Its `pty.ts`, `mcp/index.ts`, `mcp/stdio.ts`, `tool/shell.ts` and `util/process.ts` are byte-identical to BI's. Only `cross-spawn-spawner.ts` and `process-isolation.ts` (plus new files) differ. `build-native-shell` moved to `33e04ec12` after this review (4 commits). `cross-spawn-spawner.ts`, `process-isolation.ts`, `process-isolation/runtime.ts` and `build.ts` are unchanged there; `process-isolation/linux.ts` and `linux/entry.py` changed, so the `entry.py` line numbers below refer to `8b2cbc76f`. |

Path shorthand: `core/` = `packages/core/src/`, `engine/` = `packages/engine/src/`, `desktop/` = `packages/desktop/src/main/`. A citation `PF core/owned-process.ts:28` means that line on that branch's head.

## Summary

1. **The beforeSpawn recheck must move earlier than a textual merge suggests.** In #26 the background process is no longer spawned where Hands put its recheck. It is spawned later, inside the job's `run`, after `background.start` has written a durable row (PF engine/task/shells.ts:590-634, 671). Hands' recheck can open a permission prompt (H engine/tool/shell.ts:1871-1887), and its test expects no job row after a refusal (H packages/engine/test/task/shells.test.ts:194-229). So the recheck belongs right after the output file opens and before `background.start`, the same spot as in Hands. Taking either side of the conflict hunk alone is wrong. "Theirs" brings back an unowned spawn, and "ours" drops the recheck.
2. **On Windows, #26's background path bypasses the isolation floor, and no textual conflict will point at it.** It calls `WindowsProcess.start`, which spawns PowerShell directly (PF engine/tool/shell/windows-process.ts:181-187), so it never reaches `ProcessIsolation.launch` in the spawner. When isolation is required, every other spawn off Linux is refused (BI core/process-isolation.ts:17-22, 77). The Windows background shell would run anyway. The step-4 resolver must add the refusal, with ShellJobs' other refusals before any row is written (§4.1).
3. **Under native isolation, two owners would both try to kill the same process.** #26 kills the whole process group (PF core/owned-process.ts:128-154). NS deliberately signals only its guardian, through a "native owner" that has no group kill (NS core/cross-spawn-spawner.ts:129-174, 459). The two lanes conflict in seven hunks of the same spawn function. Each spawn needs exactly one signaler. I propose that the native owner signals and `OwnedProcess` delegates to it, so background jobs still get an ownership handle.
4. **Isolation and the job object do not overlap today.** Isolation is Linux-only. Off Linux it refuses (BI core/process-isolation.ts:18). The job object is Windows-only and covers background shells only. The rule for the future: the owner is always the outermost layer and the isolation wrapper sits inside it, never the other way round.
5. **The other conflicted files merge simply once the order is fixed.** `pty.ts`: recheck first, then the isolation plan, then the spawn. `mcp/index.ts`: Hands' computer-policy refusal runs on the configured command before `localTransport`. `tool/shell.ts`: only the imports conflict. `ipc.ts` and its test: keep both sides. One gap no conflict will show: Codium's `remote-changed` and `vault-changed` broadcasts (also on BI, which contains Codium) reach Hands' overlay window.
6. **Smaller items:** BI's isolation refusal inside the spawner surfaces as a defect, not a spawn error. #26's group-empty check runs `/bin/ps`, which cannot work inside the hosted engine sandbox, where `/proc` is empty. Before the `spawn` event, the interrupt path of an owned command kills only the direct child.

---

## 1. What each lane assumes

### Baseline (main)

- **Spawn:** one spawner, `CrossSpawnSpawner`, launches every engine command with `cross-spawn` (M core/cross-spawn-spawner.ts:298). POSIX commands are detached into their own process group by default (M :417). PTY terminals use node-pty directly (M core/pty.ts:226). MCP stdio servers are spawned by the MCP SDK (M engine/mcp/index.ts:480). `util/process.ts` spawns helpers directly (M engine/util/process.ts:68).
- **Own and kill:** the spawn scope's release kills the process group on POSIX and runs `taskkill /T /F` on Windows (M core/cross-spawn-spawner.ts:331-351, 421-450). Background shells kill through `handle.kill` with a 10-second bound (M engine/task/shells.ts:50, 472). Nothing is "owned" beyond the scope.
- **Recheck:** none after the permission ask.

### #26 process-finish: owned background processes

- **Who spawns:** still the spawner on POSIX, but the command is wrapped by `OwnedProcess.command`, which registers cleanup bounds in a WeakMap keyed by that exact command object (PF core/owned-process.ts:24-40). It refuses Windows and non-detached commands (:29-30). On Windows, background shells skip the spawner entirely. `WindowsProcess.start` launches a trusted PowerShell holder (PF engine/tool/shell/windows-process.ts:152-188). The holder creates the payload suspended, assigns it to a Job Object atomically at creation (PF engine/tool/shell/windows-holder.ts:89-100), reports `ready` with the PID, and resumes the payload only after the PID is saved (windows-process.ts:353-361, windows-holder.ts:117-125). The job's only limit flag is kill-on-close (0x2000, windows-holder.ts:90), so no breakaway is allowed.
- **Who owns:** `OwnedProcess.track` runs synchronously right after `launch` and before any native event can be lost (PF core/cross-spawn-spawner.ts:303-304, owned-process.ts:111-163). The handle is bound to its control (cross-spawn-spawner.ts:511). ShellJobs refuses to continue without that control (PF engine/task/shells.ts:608-613). The control is the only process authority. A recovered PID never acquires ownership (owned-process.ts:24; shells.ts:480-481).
- **Order inside `ShellJobs.start`:** refusals, then the durable lease, then reserving the slot, then `Truncate.hold` (PF shells.ts:448-479). Next the log file opens (:524-530) and the metadata with `cleanup: "pending"` is built (:531-539). Then `background.start` writes the row (:671), and only inside `run` is the process spawned: Windows at :592-602, POSIX at :603-634, with the PID saved at :614. `start` returns after the `ready` deferred (:738).
- **Who kills on cancel:** ShellJobs `cleanup` (PF shells.ts:482-520) calls `owned.stop` on POSIX or the holder's `stop` on Windows. POSIX stop sends SIGTERM to the group, waits for it to empty, escalates to SIGKILL and then drains (owned-process.ts:128-154). Group emptiness is checked with `kill(-pgid, 0)`, and when the leader has exited, with `/bin/ps` to ignore zombies (:74-96). The control also stops the group automatically when the leader exits (:156-161). If termination is not proven, the slot stays reserved and the row says `cleanup: "unknown"` (shells.ts:501-517). The spawner's release and `kill` defer to the owned control (cross-spawn-spawner.ts:424-429, 477-487).
- **Assumes:** no beforeSpawn hook and no isolation wrapper. The Windows path never touches the spawner.

### hands: the beforeSpawn recheck

- **Who rechecks:** the shell permission scan stores `scan.beforeRun` (H engine/tool/shell.ts:1871-1887). It refuses desktop-controlling commands while Hands holds the computer, and if computer use finished this turn and the command was not explicitly confirmed, it **asks the user again** for "Allow once" (:1873-1885). It is idempotent once confirmed. It already runs twice on the foreground path: once at admission (:1898-1899) and again just before the spawn (:2014-2016). Its type is `Effect<void>`, so a refusal is a defect (`Effect.die`).
- **Where it runs:** foreground shell, after `cmd()` and immediately before `spawner.spawn` (H tool/shell.ts:2005-2016). Background shell: it is passed into `ShellJobs.start` (:2189) and runs after the log opens and immediately before the old spawn (H engine/task/shells.ts:98-99, 495-496). Terminal: `Pty.create(input, owner, beforeSpawn)`, after config and node-pty loading and immediately before `spawn` (H core/pty.ts:113, 199-203, 231; called from H engine/tool/terminal.ts:276-289). MCP: a computer-policy refusal on `[cmd, ...args]` before the transport (H engine/mcp/index.ts:481-483), plus reserved names (:516, :1155).
- **Tests that pin the order:** background: a late refusal leaves no process, no row (`list` is `[]`), a released slot, and the original message (H packages/engine/test/task/shells.test.ts:194-229). PTY: the order must be `setup → before-spawn` with no terminal created (H packages/core/test/pty/pty-session.test.ts, "a late pre-spawn refusal after delayed configuration creates no native terminal").
- **Assumes:** the spawn happens right after the recheck in the same function, and no durable row exists while the recheck may prompt. It knows nothing of owned processes or isolation.

### build-integrate: @vector tool-process isolation (legacy bwrap)

- **Switch:** `requireIsolation()` is a one-way, process-wide flag set only by the private-channel loader (BI core/process-isolation.ts:8-15; called from `engine/cli/cmd/github.secrets.ts:354`). There is no reset, so tests need a child process.
- **Who spawns:** every engine launcher of tool processes calls `ProcessIsolation.launch(file, args, {cwd, shell, env})` first. There are seven call sites: the spawner (BI core/cross-spawn-spawner.ts:299-304), PTY (BI core/pty.ts:227-228), MCP stdio via the new `engine/mcp/stdio.ts:5-21` (BI engine/mcp/index.ts:480-487), `util/process.ts` (BI :81-88), and three this review first left out: untrusted Git (BI core/untrusted-git.ts:66), the bundle Git helper (BI engine/cli/cmd/github.bundle.ts:732) and document OCR (BI core/brain/document/ocr.ts:280). Fixed system helpers (`taskkill` in core/shell.ts, the `plutil`/`reg`/`ls` calls in core/config/managed.ts, the hardware probe in core/local-mode/hardware.ts, and PF's `/bin/ps` check) do not consult it. When the flag is off, launch returns its input unchanged (process-isolation.ts:75). When it is on, it refuses loader variables and refuses off Linux or without a root-owned `/usr/bin/bwrap` (:17-22, 76-77). Otherwise it wraps the command as `bwrap --die-with-parent --unshare-user --unshare-pid ... --proc /proc -- <file>` (:50-68, 78-80). The shell tool skips its own sandbox wrapper when isolation is required (BI engine/tool/shell.ts:1235, 1265).
- **Who owns and kills:** unchanged from main. The spawner still owns the (now bwrap) process and kills its group. `--die-with-parent` plus the PID namespace mean that killing outer bwrap tears down everything inside the namespace, including processes that called `setsid`.
- **Engine sandbox:** the hosted engine itself runs under bwrap with an empty, read-only `/proc` (BI core/process-isolation.ts:25-48, lines 31-34).
- **Assumes:** isolation sits at the launch call and needs no owner change. There is no recheck hook and no Windows path. It assumes every tool-process spawn goes through one of the launchers above, which #26's Windows holder does not.

### build-native-shell: native isolation and its lifecycle owner

- **Switch:** native mode is chosen only when `required() && nativeBuild().enabled` (NS core/cross-spawn-spawner.ts:405, 718). Source builds have `enabled = false` (NS core/process-isolation/build.ts:2), and the status doc says no production activation is authorized (NS docs/vector/build/native-isolation-status.md, last line).
- **Who spawns:** the spawner computes a plan inside `Effect.try`, so refusals become `PlatformError("spawn")` (NS cross-spawn-spawner.ts:399-438). In native mode, `commandPlan` returns a Python guardian launch with `cancellation: "native-owner"` and `shell: false` (NS core/process-isolation.ts:53-67; NS core/process-isolation/runtime.ts:169-200). In native builds, once isolation is required, `launch` refuses the legacy wrapper (NS process-isolation.ts:299-302; it returns the plain command at :300 while isolation is not required), so every other launcher above is refused: PTY, MCP, `util/process.ts`, untrusted Git, the bundle Git helper and OCR. Worker threads may not spawn at all in native builds (:37-41). `dispatch` checks pipelines first (cross-spawn-spawner.ts:717-724).
- **Who owns and kills:** `nativeOwner` (NS cross-spawn-spawner.ts:129-174) signals **only the direct child**, the guardian, through `killOne` (:459), with a bounded policy: the caller's signal (SIGTERM, SIGINT, SIGHUP or SIGKILL; SIGTERM by default), close within at most 3 s, SIGKILL, then 2 s (:95-101, 147-157). Its comment is explicit: "No process-launch port, group kill or implementation/authority toggle exists" (:129). The guardian (NS core/process-isolation/linux/entry.py) uses PDEATHSIG (:221) and pidfds, forwards cancellation, SIGKILLs the namespace init (:686-720), and tears down the broker (:1268-1314). The spawn release, the interrupt path and `kill` all defer to this owner (cross-spawn-spawner.ts:480-483, 499, 598, 647).
- **Assumes:** no `OwnedProcess`, no beforeSpawn, and it is the only signaler for a native spawn.

---

## 2. Who spawns, owns, rechecks and kills, combined

| Process | Recheck (Hands) | Isolation | Owner | Kills on cancel |
|---|---|---|---|---|
| Foreground shell | `beforeSpawn` in the tool, before `spawner.spawn` (H tool/shell.ts:2015) | Spawner plan: legacy bwrap (BI) or native guardian (NS) | Spawner scope (main), or the native owner (NS) | Main's group kill, or the native owner |
| Background shell, POSIX | `beforeSpawn` before `background.start` (proposed, §4.2) | Spawner plan, as above | `OwnedProcess` (PF), delegating to the native owner under NS (proposed, §4.4) | ShellJobs `cleanup` → `owned.stop` |
| Background shell, Windows | Same spot | **None today: must refuse when required (proposed, §4.1)** | Holder + Job Object (PF) | Holder `stop` → job termination |
| Agent terminal (PTY) | `beforeSpawn` before the plan (proposed, §4.3) | Legacy bwrap; refused in native builds | PTY service | `Pty.remove`; namespace teardown via `--die-with-parent` |
| MCP stdio server | Computer-policy refusal before the transport (H mcp/index.ts:481) | Legacy bwrap via `localTransport`; refused in native builds | MCP SDK transport | SDK close → kills bwrap → namespace teardown |
| `util/process.ts` helpers | none | Legacy bwrap; refused in native builds | Caller | Caller's abort or timeout |

---

## 3. Where the lanes conflict

### C1. The order of the beforeSpawn recheck and the owned spawn (`engine/task/shells.ts`, step 6, security-relevant)

- **Text:** a single conflict hunk. On our side (PF) nothing sits between the log open and `const metadata`. Their side (H) has `if (input.beforeSpawn) yield* input.beforeSpawn` followed by the old `spawner.spawn(input.process)` and `handle = spawned` (H shells.ts:495-500).
- **"Take theirs" is wrong.** It brings back an unowned spawn. Typecheck would catch it, because `handle` no longer exists in PF.
- **"Take ours" is wrong.** It silently drops the recheck. Hands' test would hang on its `ready` deferred, not fail cleanly.
- **Moving the recheck into `run`, right before the spawn, is also wrong.** It looks closest to "immediately before process creation", but:
  - `run` executes after `background.start` has written a durable running row (PF shells.ts:671). Hands' recheck can open a user prompt (H tool/shell.ts:1874), so a running row would sit there while the user decides, and restart recovery would report it as interrupted.
  - Hands' test expects `shells.list` to be `[]` after a refusal (H shells.test.ts:227).
  - A failure inside `run` reaches the caller only through `ready`, and `ready` replaces the cause with "The background command could not start or was stopped during startup." (PF shells.ts:663-667). Hands' test expects the original message (H shells.test.ts:224).
- **Correct spot:** right after the log opens (PF shells.ts:530) and before `const metadata` and `remember(id, live)` (:531-540). Nothing between there and `background.start` awaits anything external. `background.cancel` and `updateMetadata` on an id that was never started both return harmlessly (PF core/background-job.ts:338-352, 810-815). So the existing `onError` path gives Hands exactly what its test wants: no row, a released slot (because cleanup sees no owner and treats termination as proven) and the original defect.
- **Remaining window:** between this recheck and the real process creation sit `background.start`, the fork of `run` and, on Windows, holder startup (≤15 s to `ready`, ≤10 s to save the PID: PF windows-process.ts:28-29). Hands' foreground path has a similar but much shorter window. See §4.2 for the optional second recheck that closes it.

### C2. The Windows background path skips the isolation floor (`engine/task/shells.ts`, no textual conflict, step 4)

The PF Windows branch calls `WindowsProcess.start(processCommand, …)` (PF shells.ts:594). That uses node's `spawn` on the holder directly (PF windows-process.ts:181-187), so `ProcessIsolation` is never consulted. Under BI, every other spawn off Linux throws REFUSAL when isolation is required (BI core/process-isolation.ts:18, 77). Today `requireIsolation()` is only called by the GitHub private-channel loader on Linux runners, so this is defense in depth. But a self-hosted Windows runner would run background shells with no isolation and no refusal, while foreground shells are refused. `shells.ts` is not in BI's conflict list, so nobody will open it at step 4 unless told to.

### C3. Two owners for the same spawn (`core/cross-spawn-spawner.ts`, step 10)

PF's `spawn` returns a fourth tuple element, `OwnedProcess.Control`, and short-circuits release and `kill` to `owned.stop`, a group kill (PF cross-spawn-spawner.ts:295, 303-304, 424-429, 477-487). NS's `spawn` returns a fourth element, `NativeLifetime`, and short-circuits release, interrupt and `kill` to `nativeOwner`, which signals the guardian only (NS :445-470, 499, 598, 647). Pairwise there are seven conflict hunks: the import, the `spawn` signature, the owner construction, `resume`, the destructuring, release and `kill`.

If both are kept naively, ShellJobs still calls `owned.stop` directly (PF shells.ts:488). It would group-signal the guardian's process group on its own deadlines: 3 s grace and 3 s kill by default (PF owned-process.ts:131, 134), configurable up to 30 s each (:31-36). Meanwhile the native owner runs its own 3 s and 2 s sequence. The guardian is a group leader because `detached` defaults to true (NS :593). The likely outcome is still containment, since PDEATHSIG and namespace teardown remain. But the guardian's orderly cancellation (broker quiesce, close proof) can be cut short, and the native lane's "single signaler" invariant is broken.

If only native is kept, `OwnedProcess.get(handle)` returns undefined and every background shell fails with "The process spawner did not provide background command ownership." (PF shells.ts:610-613). That fails closed, which is acceptable while native mode is off, but it is not the end state.

### C4. Isolation refusals surface as defects in BI's spawner (`core/cross-spawn-spawner.ts`, step 4)

BI calls `ProcessIsolation.launch` bare inside the `Effect.callback` register function (BI :299-303), so REFUSAL is thrown as a defect. NS already fixed this with `Effect.try` → `PlatformError("spawn")` (NS :402-438). PF maps spawn errors to "Vector could not start the command: …" through `Effect.mapError` (PF shells.ts:606), which does not see defects. The step-4 resolution should adopt the `Effect.try` form now, so step 10 conflicts less and error messages stay consistent.

### C5. The order of the PTY recheck and the isolation plan (`core/pty.ts`, step 6)

This is one hunk. BI replaces the spawn line with `ProcessIsolation.launch` plus a spawn of `isolated.file` (BI :227-228). H inserts `if (beforeSpawn) yield* beforeSpawn` before the old spawn (H :231-232). Either side alone drops the other's security property. Order them as recheck, then plan, then spawn, with nothing awaited after the recheck. The plan is synchronous and pure. Doing it after a possible prompt avoids acting on a stale `bwrap` stat.

### C6. MCP computer policy and isolated transport (`engine/mcp/index.ts`, step 6)

This is one hunk. H keeps `const sdk = yield* loadSdk`, adds the computer-policy refusal and builds `new sdk.StdioClientTransport` (H :480-490). BI builds the transport through `localTransport`, which wraps the command in bwrap (BI :480-487; BI engine/mcp/stdio.ts:13). Either side alone drops a security property: Hands' block on MCP servers that would drive the desktop outside Hands, or tool isolation for MCP servers in GitHub runs. The refusal must judge the **configured** `[cmd, ...args]`, never `isolated.args` (which start with `/usr/bin/bwrap`). It must return before `localTransport` creates anything. The `sdk` binding in that block becomes unused. The rest of the file still uses `loadSdk`.

### C7. Imports only (`engine/tool/shell.ts`, step 6)

The only conflict is the import block (BI :37 against H :37-40). Keep both. The foreground order is already right after the merge: `cmd()` → `beforeSpawn` → `spawner.spawn`, and the isolation plan is inside the spawner. BI's sandbox skip (BI :1235, 1265) and Hands' ask changes (H :1070-1201) do not overlap.

### C8. Desktop IPC (`desktop/ipc.ts`, `desktop/ipc-security.test.ts`, step 6)

Both sides add registrations at the top of `registerIpcHandlers` and new imports (H :1-4, 259-263; BI :1-8, 270-277), plus independent tests. Keep both. BI's test only forbids a raw `ipcMain.handle` for `github-agents-*` channels (BI ipc-security.test.ts, added test), and Hands' overlay IPC uses raw `ipcMain.handle` for its own channels (H ipc.ts:259-262), so they do not clash.

**Semantic gap no conflict will show:** Hands keeps main-window broadcasts out of the computer overlay (H ipc.ts:579; H desktop/vector-account-runtime.ts:49-51). Two all-window broadcasts that do not exclude it arrive with **Codium**, and BI carries them only because it contains `codium`: `remote-changed` (desktop/remote-runtime.ts:24-27, from Codium A41 `4caf1073a`) and `vault-changed` (desktop/vault-runtime.ts:30-32, from Codium A45 `c9cd1bdbf`). Neither file exists on main or `vector-at-mention`. They reach main at step 3 (Codium), so the step-6 resolver must add the exclusion whether or not BI has merged by then. (Corrected in review: this paragraph first said BI adds them.) This is not spawn-related.

### C9. #26's group-empty check inside the hosted engine sandbox (conditional, step 4)

`groupEmpty` runs `/bin/ps -A -o pgid=,stat=` when the leader has exited but `kill(-pgid, 0)` still succeeds, which can be a lingering zombie (PF owned-process.ts:74-96). In hosted GitHub runs the engine runs with an empty, read-only `/proc` (BI core/process-isolation.ts:31-34). There `ps` fails, so the check returns false, and cleanup ends `terminated: false`: the row says `cleanup: "unknown"` and the slot stays reserved until restart. This fails closed, so it is safe but degraded. Whether background shells can run in a GitHub run at all (they need a durable lease and the `backgroundSubagents` flag): not checked. In native mode the delegate design (§4.4) avoids `ps` entirely.

### C10. The interrupt path before `spawn` kills only the direct child for owned commands (minor, step 4)

PF's `Effect.callback` canceller sends `SIGTERM` to the direct child only (PF cross-spawn-spawner.ts:328-331), even when `owned` exists. With bwrap in front, the direct child is bwrap, and `--die-with-parent` covers the namespace, so the impact is small. For consistency, it should call `owned.stop` when `owned` is set, as NS does for its owner (NS :499).

**Resolved (FIT-1, 2026-11-15).** The combined code adopted C10: the canceller calls `owned.stop` when `owned` is set. Writing S4-5 showed that `spawnCommand` runs `spawn()` as the acquire step of an `Effect.acquireRelease`, which is uninterruptible, so an interrupt requested before the `spawn` event takes effect once the process exists, and the release runs `owned.stop`. Through `spawnCommand`, which is the only caller, the C10 canceller is therefore not reached: removing it leaves S4-5 green, while removing the release's `owned.stop` makes it hang. The canceller stays as a defensive path in case the acquire ever becomes interruptible; no test reaches it. S4-5 (`packages/core/test/effect/cross-spawn-spawner.test.ts`, "owned commands") checks the outcome through the release.

---

## 4. Proposed combined design and merge resolution

### Principles

1. **One plan per spawn, in this order:**
   1. The authority recheck (`beforeSpawn`). It may prompt, and it must finish before any durable row, owner or process exists.
   2. The isolation plan. It is synchronous and pure, and it may refuse.
   3. Owner selection: native owner if the plan says so, else an owned group if the caller marked the command with `OwnedProcess.command`, else main's plain scope.
   4. `launch`, synchronous.
   5. Bind the owner synchronously, before any await, as #26 already does.
2. **Exactly one signaler per spawn:** the native guardian (NS), the owned process group (PF POSIX), the holder's Job Object (PF Windows) or main's group kill (plain). No path signals through two of them.
3. **The owner is outermost and isolation sits inside it.** On POSIX, the owned group contains bwrap. On Windows, if isolation is ever added, the holder must create the isolated payload inside the job (atomic job assignment at creation, PF windows-holder.ts:100). A wrapper that starts the holder would leave the payload outside the job.
4. **Ownership lookup always uses the caller's command object** (the WeakMap key from `OwnedProcess.command`), never an object rebuilt from the isolated argv.
5. **Every spawn site consults the isolation floor**, including the Windows holder path.

### 4.1 Step 4: `build-integrate` into main, after #26 (resolver: orchestrator)

**`core/cross-spawn-spawner.ts`** (the textual conflict is only the import line; the semantics matter):

- Keep both imports, `OwnedProcess` and `ProcessIsolation`.
- Compute the isolated launch in `Effect.try` before `Effect.callback`, the NS shape, so a refusal is `PlatformError("spawn")`:

```ts
const spawn = (command: ChildProcess.StandardCommand, opts: NodeChildProcess.SpawnOptions) =>
  Effect.try({
    try: () => ProcessIsolation.launch(command.command, command.args, {
      cwd: typeof opts.cwd === "string" ? opts.cwd : undefined, shell: opts.shell, env: opts.env }),
    catch: (error) => toPlatformError("spawn", toError(error), command),
  }).pipe(Effect.flatMap((isolated) => Effect.callback<readonly [..., OwnedProcess.Control?], PlatformError.PlatformError>((resume) => {
    const signal = Deferred.makeUnsafe<...>()
    const proc = launch(isolated.file, isolated.args, { ...opts, shell: isolated.shell })
    const captured = captureOutput(proc)
    // Ownership is keyed by the caller's command, never the isolated argv.
    const ownership = OwnedProcess.options(command)
    const owned = ownership && proc.pid ? OwnedProcess.track(proc, captured.dispose, ownership) : undefined
    ... // PF's error/exit/close/spawn handlers unchanged
    return owned
      ? Effect.promise(owned.stop).pipe(Effect.asVoid, Effect.ensuring(Effect.sync(captured.dispose)))  // C10
      : Effect.sync(() => { proc.kill("SIGTERM"); captured.dispose() })
  })))
```

- Release, `kill` and `bind` stay exactly as in PF (PF :424-429, 477-487, 511).

**`engine/task/shells.ts`** (no textual conflict; fixes C2): refuse a Windows background command when isolation is required, using the same message as the spawner, **with the other refusals at the top of `ShellJobs.start`** (PF shells.ts:450-453), before the lease, the slot and the row:

```ts
const refused =
  refusal({ subagent: session.parentID !== undefined, enabled: flags.backgroundSubagents }) ??
  timeoutRefusal(input.timeout) ??
  (process.platform === "win32" && ProcessIsolation.required() ? ProcessIsolation.REFUSAL : undefined)
```

(Corrected in review: this section first put the guard at the top of the Windows branch inside `run`, PF :593. That spot is after `background.start` has written the row (:671), and a failure there happens while `completion` is being computed, before `ended`, so `live.failed` is never set and the caller gets only the generic "could not start or was stopped during startup" message from `ready` (:663-667, see C1). The refusal text would be lost.) A guard in `WindowsProcess.start`'s preflight (PF windows-process.ts:153-156) is still worth adding as defense in depth for any future caller, but on its own it has the same message problem.

### 4.2 Step 6: `hands` into main (resolver: Codex; the orchestrator is read-only on `hands`)

**`engine/task/shells.ts`:**

- `StartInput.beforeSpawn` merges automatically (H :98-99).
- In the conflict hunk, keep PF's side (no spawn there) and add only the recheck:

```ts
        log = yield* Effect.tryPromise({ ... })          // PF :524-530
        // Dynamic authority (may ask the user). Before any durable row, owner or process.
        if (input.beforeSpawn) yield* input.beforeSpawn
        const metadata = { ..., cleanup: "pending", ... } // PF :531
```

- **Optional, Codex's call: close the window C1 describes.** Run `input.beforeSpawn` a second time inside `run`.
  - POSIX: immediately before `spawner.spawn(OwnedProcess.command(processCommand))` (PF :604).
  - Windows: inside the `onReady` callback after `persist(pid)` (PF :596). The payload then exists only suspended inside the job. If `onReady` rejects, the holder stops it with proof (PF windows-process.ts:355, 362-368), and nothing in the holder protocol changes.
  - The hook is idempotent once confirmed (H tool/shell.ts:1884), so the second call is normally a quick computer-state check. If computer use finished in the window, it may prompt while a row exists. On Windows it is bounded by the 10 s save deadline (PF windows-process.ts:29), so a slow answer fails closed.
  - If added, change `Deferred.fail(ready, new Error("…could not start…"))` (PF :665) to forward the real cause (`Deferred.failCause(ready, exit.cause)`, or append its message), so the user sees the refusal reason.
- **`packages/engine/test/task/shells.test.ts`:** mechanical. Merge both import lines (PF adds `test` from bun:test; H adds `existsSync`, `Deferred`, `Fiber` and the `ComputerSession` layer). Keep both new tests at the top of `describe("background shell commands")`.

**`core/pty.ts`:**

```ts
      const { spawn } = yield* Effect.promise(() => pty())
      if (beforeSpawn) yield* beforeSpawn
      const isolated = ProcessIsolation.launch(command, args, { cwd, env })
      const proc = yield* Effect.sync(() => spawn(isolated.file, isolated.args, { name: "xterm-256color", cwd, env }))
```

Keep H's `create` signature and its `beforeSpawn` parameter (H :113, 199-203).

**`engine/mcp/index.ts`:**

```ts
      const bridge = yield* EffectBridge.make()
      const refusal = McpComputerPolicy.refusal([cmd, ...args], (yield* cfgSvc.get()).computer)
      if (refusal)
        return { client: undefined as MCPClient | undefined, status: { status: "failed" as const, error: refusal } }
      const transport = yield* Effect.promise(() => localTransport({ command: cmd, args, cwd, env: untrustedChildEnvironment(...) }))
```

Keep H's `McpComputerPolicy` import, the `reservedName` checks (H :516, :1155) and BI's `localTransport` import. Drop the now-unused `const sdk` in this block only. Not checked: whether an isolation refusal inside `localTransport` (`Effect.promise` turns it into a defect) ends up as a "failed" status. A `tryPromise` that maps to a failed status would be cleaner.

**Answered (HF-2, 2026-11-15).** It does, so no code was changed and the `tryPromise` was not adopted. `localTransport` (`engine/mcp/stdio.ts:13`) runs `ProcessIsolation.launch` inside `Effect.promise` (`mcp/index.ts:489`), so a launch-floor refusal is a defect inside `connectLocal`. `MCP.create`'s `Effect.catchCause` (`:553-559`) re-interrupts a cause that holds only interrupts and turns every other cause into `{ status: "failed", error: message }`. `packages/engine/test/mcp/computer-policy-isolation.test.ts` proves this by running `packages/engine/test/fixture/mcp-required-isolation.ts` in its own process after `requireIsolation()`. A server whose configured environment sets a native loader variable ends, at startup and again after `connect`, as a failed status carrying the launch floor's own message, with no client, no tools and no marker file. On Linux that refusal comes from the loader-environment guard, which `ProcessIsolation.launch` applies before its platform check. While `ProcessIsolation.FLOOR` is false, Linux plans an allowed command plainly and never reaches `assertBinary`, so the literal REFUSAL variant of the same fixture runs only on the Windows engine shard. That Windows result is still pending.

**`engine/tool/shell.ts`:** keep all five imports. Nothing else conflicts, and the order is already right.

**`desktop/ipc.ts`, `desktop/ipc-security.test.ts`:** keep both sides' registrations, imports and tests. Also add `&& !isComputerOverlay(window)` to Codium's `remote-changed` and `vault-changed` broadcasts (desktop/remote-runtime.ts:25-26, desktop/vault-runtime.ts:31-32, on `codium` and BI). Those files are not conflicted, so this must be done deliberately.

### 4.3 PTY, MCP and helpers under native builds (step 10, no conflict)

NS refuses the legacy wrapper in native builds once isolation is required (NS process-isolation.ts:300-302), so PTY, MCP stdio, `util/process.ts`, untrusted Git, the bundle Git helper and OCR spawns are refused there after the recheck. That is consistent with the design. The only requirement is to keep the recheck ahead of the plan, as in §4.2, so users never get a prompt that leads to a spawn.

### 4.4 Step 10: `build-native-shell` into main (resolver: orchestrator, with the native lane's sign-off)

**`core/cross-spawn-spawner.ts`** (seven hunks): take NS's structure, with the plan computed in `Effect.try` and `nativeOwner`, `assertNativePipeline` and `dispatch` all kept. Carry the owned lifetime as a second, optional member instead of competing for the fourth tuple slot:

```ts
type Lifetime = { native?: NativeLifetime; owned?: OwnedProcess.Control }
// after launch + captureOutput, synchronously:
const native = isolated.cancellation === "native-owner" ? makeNativeOwner(...) /* NS :449-470 */ : undefined
const ownership = OwnedProcess.options(command)
const owned = !ownership || !proc.pid ? undefined
  : native ? OwnedProcess.delegate(proc, () => Effect.runPromise(native.cleanup().pipe(Effect.exit)))  // native signals
  : OwnedProcess.track(proc, captured.dispose, ownership)                                              // group signals
// interrupt before spawn: native ? native.cleanup() : owned ? owned.stop : PF's kill   (NS :499, C10)
// release:  if (native) return yield* native.cleanup().pipe(Effect.orDie)
//           if (owned) { yield* Effect.promise(owned.stop); yield* Effect.sync(captured.dispose); return }
//           ...main's path
// kill:     if (native) return native.stop(opts);  if (owned) return PF :478-487
// bind:     if (owned) OwnedProcess.bind(handle, owned)
```

**`core/owned-process.ts`:** add `delegate(proc, stop)`. It returns a `Control` that records `exit` and `close` exactly like `track` (PF :155-161) but never signals. Its `stop` and `done` run the supplied function once (memoized, like `stopping ??=` at :129). The result is `{ terminated: ok && exit !== undefined, drained: ok, exit, error }`. `nativeOwner` is already serialized and idempotent: a semaphore, an early return once close is seen, and a single dispose (NS :131-173). So ShellJobs' `owned.stop` and the scope release can both call it safely. This keeps ShellJobs unchanged and keeps the native lane's single-signaler rule. It also removes the `/bin/ps` dependency in native mode (C9).

**Minimum alternative, acceptable while `build.ts` keeps `enabled = false`:** in the `Effect.try` plan, refuse any command marked with `OwnedProcess.options(command)` when the plan is native. Use REFUSAL or a specific "background commands are unavailable under native isolation" message. Background shells then fail closed before any process starts. Record the choice in `native-isolation-status.md`.

Either way, never add a group SIGKILL fallback to the native path without the native lane's agreement. The guardian's orderly stop (entry.py:686-720, 1268-1314) is part of its proof.

---

## 5. Tests the resolvers must add

Run them in CI only (owner rule). The test shards come from `test.yml`. The Linux isolation cases need the sandbox lane in `.github/workflows/vector-at-mention.yml`, which builds `packages/engine/test/fixture/sandbox-runner.ts` (line 303). That lane's "Prepare the agent sandbox" step is currently red on BI (run 43216635783), so the cases that need root-owned bwrap cannot be proven until it is fixed.

A useful trick: `requireIsolation()` cannot be reset, but off Linux `launch` **always** refuses once it is set. So in a child-process fixture on the macOS or Windows shards, "the error is the recheck's message, not REFUSAL" proves that the recheck ran before the isolation plan. "The error is REFUSAL and no marker file exists" proves that isolation ran before any process.

### Step 4 (build-integrate × #26)

| ID | Test | Where / platform |
|---|---|---|
| S4-1 | The existing `packages/core/test/process/owned-process.test.ts` and PF's `shells.test.ts` stay green, with ownership kept when isolation is off. | test.yml, all OSes |
| S4-2 | **An isolated background command is still owned and killed on cancel (POSIX):** after `requireIsolation()`, `spawner.spawn(OwnedProcess.command(sh -c 'sleep 600 & setsid sleep 600 & wait'))` gives `OwnedProcess.get(handle)` defined and `handle.pid` equal to bwrap. Closing the scope or calling `kill()` returns `terminated: true`, and no canary (unique argv token, host-side scan) survives, including the `setsid` one. Also via `ShellJobs.start`/`stop`: the row ends with `cleanup: "confirmed"` and the slot is released. | New scenario in `packages/engine/test/fixture/sandbox-tool-probe.ts`, sandbox lane (Linux, root bwrap) |
| S4-3 | **An isolated tool process on Windows:** with `requireIsolation()` set in a child fixture, a foreground spawn fails with REFUSAL, and `ShellJobs.start` with `background` fails with REFUSAL **before** `WindowsProcess.start` (guard placed as in §4.1): no holder PowerShell child, no marker, no row (`shells.list` is `[]`), slot released. With isolation off, PF's existing Windows containment cases still kill the whole job on stop. | test.yml Windows shard, plus PF's Windows containment workflow (as in run 43151685952) |
| S4-4 | An isolation refusal is `PlatformError("spawn")`, not a defect, at the spawner. Through POSIX `ShellJobs.start`, the spawner's "Vector could not start the command: …REFUSAL" (PF shells.ts:606) does **not** reach the caller today: the spawn runs inside `run`, so `ready` replaces it with the generic startup message (:663-667) and `live.failed` stays unset. Either assert the generic message, or forward the cause through `ready` (as §4.2 suggests) and then assert REFUSAL. (Corrected in review: this row first expected ShellJobs to report the REFUSAL text.) | test.yml macOS (child fixture) |
| S4-5 | Optional, if C10 is adopted: interrupting an owned spawn before its `spawn` event runs `owned.stop`, and no group member survives. Added in FIT-1; it is satisfied by `acquireRelease`'s release, not the C10 canceller (see C10). | test.yml Linux/macOS |

### Step 6 (hands × main with #26 and BI)

| ID | Test | Where / platform |
|---|---|---|
| S6-1 | Hands' "a late pre-spawn refusal releases its reserved slot and starts no process" passes **unchanged**: no marker, `list` is `[]`, `full` is false, original message. | test.yml, POSIX and Windows |
| S6-2 | **The beforeSpawn recheck runs before the owned spawn:** wrap `ChildProcessSpawner` in a test layer that appends `"spawn"` and records whether `OwnedProcess.options(command)` is defined. The `beforeSpawn` appends `"recheck"`. Expect `["recheck", "spawn"]` and owned set. Windows variant: inside `beforeSpawn`, assert `store.forParent(root.id)` is empty, which proves the hook runs before `background.start` and so before the holder starts. | test.yml, POSIX and Windows |
| S6-3 | **A waiting recheck leaves no durable row:** while `beforeSpawn` blocks on a deferred, `store.forParent` and `shells.list` are both `[]`. After it proceeds, one row with a PID and `cleanup: "pending"` exists. | test.yml |
| S6-4 | Interrupting the start fiber while `beforeSpawn` waits starts no process, writes no row and releases the slot. | test.yml |
| S6-5 | The recheck runs before the isolation plan, for background shells, foreground shells, PTY and MCP. In an off-Linux child fixture with `requireIsolation()`, a dying `beforeSpawn` (or a refusing `McpComputerPolicy`) yields its own message, not REFUSAL, and starts nothing. Added in HF-2 for PTY and MCP; the shell halves remain with the spawn test lanes. The PTY half is `packages/core/test/pty/pty-required-isolation.test.ts`, which runs on Linux only because every PTY suite skips Windows. The MCP half is the policy case of `packages/engine/test/mcp/computer-policy-isolation.test.ts`, which runs on the Linux and Windows engine shards. On Linux the refusal that decides the order is the launch floor's loader-environment guard. | test.yml Linux unit (PTY); Linux and Windows engine shards (MCP); shells: spawn test lanes. Planned as test.yml macOS (and Windows), but test.yml has no macOS unit or engine lane |
| S6-6 | Hands' PTY ordering test (H pty-session.test.ts) and terminal mocks (H packages/engine/test/tool/terminal.test.ts:151, 1338) pass unchanged. | test.yml |
| S6-7 | The MCP computer policy judges the configured command: a denied `[cmd, ...args]` is refused while isolation is required, and the refusal text is the policy's, not bwrap's argv or REFUSAL. No transport or process is created. Added in HF-2 as a child fixture, `packages/engine/test/fixture/mcp-required-isolation.ts`, run by `packages/engine/test/mcp/computer-policy-isolation.test.ts` on the Linux and Windows engine shards. The status error equals the policy's text, and no client or marker exists. With a loader environment the launch floor refuses on every host, so that variant decides the order on Linux; the inherited-environment variant decides it only on Windows (pending). The child uses no module mock, so it cannot see a transport being constructed; `computer-policy.test.ts`'s fake transport keeps covering that. | test.yml Linux and Windows engine shards (child fixture). Planned as the sandbox lane (Linux) or a child fixture off Linux |
| S6-8 | `ipc-security.test.ts` keeps both new tests. A new test checks that `remote-changed` and `vault-changed` are not sent to a registered computer overlay. | test.yml |
| S6-9 | If the optional second recheck is added: a refusal there leaves no process. On Windows the suspended payload is stopped with proof. The row ends failed with `cleanup: "confirmed"`, the slot is released, and the tool error carries the original refusal. | test.yml, POSIX and Windows |

### Step 10 (build-native-shell × main)

| ID | Test | Where / platform |
|---|---|---|
| S10-1 | **One signaler under a native plan:** during stop and cleanup of an owned command, a `process.kill` spy sees no negative PID. Only `killOne` reaches the guardian. | NS's native shell lifecycle fixtures (`packages/engine/test/fixture/native-shell-*`), native CI lane |
| S10-2 | Delegate option: an owned background shell under the native plan has `OwnedProcess.get(handle)` defined. `ShellJobs.stop` returns `terminated: true` within the native bounds (≤ 3 s + 2 s), even when OwnedProcess options request more. The host UID sweep finds no survivors. Refuse option: `ShellJobs.start` fails with the refusal before any process and the slot is released. | native lane, with a background-shell scenario added to the matrix |
| S10-3 | A native spawn error before `spawn` runs cleanup once, and ShellJobs releases the slot. | native lane |
| S10-4 | S4-2, S4-3 and S6-2 still pass after the merge, with isolation off and with legacy isolation. | test.yml, sandbox lane |

---

## 6. Open questions for the owners of each lane

1. **Codex (hands):** do you accept the recheck before `background.start` (keeps your test as written)? And do you want the optional second recheck inside `run`: before the POSIX spawn and in Windows `onReady` before resume, with the trade-offs in §4.2?
2. **Native lane:** delegate (`OwnedProcess.delegate`) or refuse owned commands under a native plan until qualification? Either is safe. The delegate is the end state.
3. **BI lane:** can background shells run in a hosted GitHub run? If yes, decide what happens to #26's `ps`-based check when the engine's `/proc` is empty (C9). Today it fails closed and holds the slot. Refusing background shells while `ProcessIsolation.required()` is the simplest option.
4. **Outside this review's scope, noted while reading:** the legacy shell wrap joins argv with spaces, `[file, ...args].join(" ")` (BI core/process-isolation.ts:79; NS :306). The shell tool passes no args, so it is harmless there. A future caller with `shell: true` and arguments would lose its quoting.

---

**Hands lane note (HF-8, 2026-11-16).** These files were re-read at `ef9f809d`: `core/src/pty.ts`, `core/src/process-isolation.ts`, `engine/src/mcp/index.ts`, `engine/src/mcp/stdio.ts`, `engine/src/tool/shell.ts`, `engine/src/task/shells.ts`, `desktop/src/main/ipc.ts`, `renderer-status.ts`, `remote-runtime.ts` and `vault-runtime.ts`. Each is identical at `0ee486e3`, at the `hands-finish` head and at `main` `b362fdf6`.

- C5 to C8 are resolved at `0ee486e3`. C5: `core/pty.ts:240` runs `beforeSpawn`, `:241` plans with `ProcessIsolation.launch` and `:242` spawns. C6: `engine/mcp/index.ts:486-488` refuses on the configured `[cmd, ...args]` before `localTransport` (`:489-490`). C7: `engine/tool/shell.ts` keeps both sides' imports (`:37-40`) and runs `beforeSpawn` (`:1999`) right before `spawner.spawn` (`:2000`). C8: `desktop/src/main/renderer-status.ts:15` leaves out the computer overlay, and `remote-runtime.ts:26` and `vault-runtime.ts:32` broadcast through it.
- The §4.2 "Not checked" item is answered by the "Answered (HF-2, 2026-11-15)" paragraph under §4.2: `MCP.create`'s `Effect.catchCause` (`engine/mcp/index.ts:553-559`) turns an isolation refusal inside `localTransport` into a failed status. HF-2's `packages/engine/test/mcp/computer-policy-isolation.test.ts`, which runs `packages/engine/test/fixture/mcp-required-isolation.ts`, pins it. No MCP code changed.
- S6-5's PTY and MCP halves and S6-7 were added by HF-2, as the S6-5 and S6-7 rows above say: `packages/core/test/pty/pty-required-isolation.test.ts` for PTY, which skips Windows like every PTY suite, so in CI, where `test.yml`'s `unit` job has only Linux and Windows hosts (`:551-563` at main `f3d7ac74`), it runs on Linux only, and `computer-policy-isolation.test.ts` for MCP. Its Windows engine-shard branch, which expects the literal REFUSAL, has not run yet.
- The shell halves of S6-5 remain with the spawn test lanes. On Windows `ShellJobs.isolationRefusal` (`engine/task/shells.ts:96`, called at `:464`) refuses before the recheck, so S6-5's wording does not hold there as written.

## Addendum, 15 November 2026: C9, SPAWN-1 and SPAWN-2 at the native-qualify head (NQ-2)

This is a dated addendum, and nothing above it was edited. The citations are at the
`native-qualify` lane head. The code they cite is unchanged since `597dbcc9`, which is
based on `release-finish` `0ee486e3`. The path shorthand is the same as above. The
evidence and the §6 Q3 reasoning are in
[`native-qualify-notes.md`](native-qualify-notes.md#nq-2-15-november-2026), NQ-2.

**Superseded, not edited:** three sentences above say that the hosted engine has an empty
`/proc`:

- Summary item 6, line 26: "where `/proc` is empty";
- the §1 build-integrate "Engine sandbox" bullet, line 58: "runs under bwrap with an empty,
  read-only `/proc`";
- C9, line 133: "In hosted GitHub runs the engine runs with an empty, read-only `/proc`",
  with the "not checked" note on background shells.

The lines below replace them for the code as it stands now.

**C9 is not reachable.**

- Only `ProcessIsolation.engineArguments` mounts the empty `/proc`
  (`core/process-isolation.ts:215-245`, with `--tmpfs /proc --remount-ro /proc` at
  `:228-231`).
- `engineLaunch` uses it only when its `floor` argument is true
  (`engine/cli/cmd/github.sandbox.ts:629-643`). Otherwise it returns the plain sudo argv
  (`:639-640`).
- The hosted caller passes `native || ProcessIsolation.FLOOR` (`:798`):
  - `FLOOR` is the literal `false` (`core/process-isolation.ts:26`);
  - `native` is `GithubIsolation.enabled()` (`github.sandbox.ts:669`,
    `engine/cli/cmd/github.isolation.ts:872-875`), which returns the literal `false` in
    `engine/cli/cmd/github.isolation-build.ts:2`; the core literal is
    `core/process-isolation/build.ts:2`.
- So every shipped hosted engine sees the host `/proc`. The sandbox probe reads it
  (`packages/engine/test/fixture/sandbox-probe.ts:26-27`, `64`), and the `/bin/ps` call in
  `groupEmpty` works there (`core/owned-process.ts:74-96`, `/bin/ps` at `:79-82`).
- The native CI build does get the empty `/proc`, but it refuses an owned command before
  any process exists (`core/cross-spawn-spawner.ts:405-411`). So there is no owned group
  there, and no `groupEmpty` call.

**When C9 could come back:** only if FLOOR is enabled (owner-gated), or if a native build
ever routes an owned command through `OwnedProcess.track`. Adopting the §4.4
`OwnedProcess.delegate` would not bring it back, because a delegate never signals and
never calls `groupEmpty`.

`groupEmpty` is deliberately unchanged.

**SPAWN-2** (the PR #33 review's copy of C9) has the same status. It is not reachable at
the lane head, it returns only under the two conditions above, and no code change is made.

**SPAWN-1, POSIX half, is covered.** The new
`packages/engine/test/task/shell-required-isolation-posix-owned.test.ts` runs only on Linux and
is skipped explicitly elsewhere; CI runs it in the Linux engine shard of `test.yml`. Its
child process calls `requireIsolation()` and runs an owned background command through
`ShellJobs`. That command is a shell plus two sleepers, all ignoring SIGTERM. FLOOR is
false, so `decide` returns the plain command (`core/process-isolation.ts:326`). The plain
owned process group is therefore the only signaler (`core/owned-process.ts:63-70`, `track`
`:112-163`). The test asserts:

- the sleepers' parent and process group are the leader;
- `stop` returns stopped;
- the row says `cleanup: "confirmed"`;
- the stop took at least the 3 s grace and less than grace plus kill (6 s);
- each sleeper has ended: on a GitHub-hosted runner, whose PID 1 reaps, it must be gone
  (`ESRCH`) within 2 s; elsewhere a zombie already reparented away from the leader is
  also accepted;
- the slot is released while seven other commands still run.

Two local mutations make it fail: removing the fixture's TERM trap, and signalling only
the leader in `owned-process.ts`.

This is not S4-2 as written. S4-2 expects `handle.pid` to be bwrap and a `setsid` canary
that does not survive, and both need the FLOOR. Without it a `setsid` grandchild leaves
the group (`engine/task/shells.ts:31`). That is a pre-existing limit, recorded and not
asserted.

**SPAWN-1, native half, is not covered yet.** The refusal at
`core/cross-spawn-spawner.ts:411` cannot be tested from source, because the build literal
is false. It belongs to an `owned` refusal scenario in the native-shell fixture (NQ-6 or
NQ-7). By code reading, that refusal fires inside the job's `run`
(`engine/task/shells.ts:630`), after `background.start` has written the durable row
(`:695`). So the scenario should expect a row that ends with cleanup `"confirmed"`. That
differs from the Windows S4-3 contract, where no row is written.

**C10, S4-5 and SPAWN-3.** C10 is implemented: before `spawn`, the canceller of an owned
command runs `owned.stop` (`core/cross-spawn-spawner.ts:508`). S4-5 (its test) and SPAWN-3
belong to the review-fixes lane.

**§6 Q3.** From code reading, background shells are reachable in a hosted legacy
`@vector` run on Linux; the reasoning is in the lane notes. Whether to offer them is a
product decision that stays with the owner. Until it is made, uncertain cleanup keeps
failing closed: the row is failed and the slot stays held. §6 Q2 (delegate or refuse)
also stays open.

## Addendum, 15 November 2026: §4 principle 5 inventory (NQ-4)

This is a dated addendum, and nothing above it was edited. The citations are at the
`native-qualify` lane head `f05f9916`.

Principle 5 ("every spawn site consults the isolation floor") now has a mechanical guard,
`packages/engine/test/spawn-inventory.test.ts`. It lists the 31 core and engine source
files that can start a process directly, each with a stance and a reason, and fails on any
new file that reaches a spawner and on any stale entry. Stances: launch 6, pty-backend 2,
required-refusal 2, fixed-helper 5, type-only 2, windows-holder 1, runner 4, cli 2,
plugin-host 1, url-opener 5, re-export 1.

Principle 5 holds for the 6 `launch` and 2 `pty-backend` entries only. The other 23 are
listed exceptions with their reasons (fixed system helpers, the CI job's own controllers,
a person's own commands, URL openers and similar). `launch` means that a site routes every
process through the ProcessIsolation launch decision and starts only what it returns.
While FLOOR and the native build are off, that is the command unchanged, or a refusal off
Linux under required isolation; no site is isolated today.

What the test asserts beyond the list:

- each launch site calls `ProcessIsolation.launch` or `commandPlan`, starts
  `isolated.file` with `isolated.args` and no shell of its own, and makes no other start
  that the textual check can see: no other call through a name bound from a process
  module, no member call on an inline `require` or `import()` of one, and no Bun or Effect
  platform spawner. One exemption is listed, the Windows `killGroup` taskkill at
  `core/cross-spawn-spawner.ts:523`. A start through an alias beyond the check's patterns
  is not seen; the notes list those limits;
- `directory-identity.ts` and `read-only-git.ts` refuse while
  `ProcessIsolation.required()`;
- the PTY backends load only through `core/pty.ts`, which runs the launch decision first;
- the Windows holder loads only through ShellJobs, which still asks `isolationRefusal`
  (the C2 guard; SPAWN-3 adds the holder's own guard in the review-fixes lane);
- the MCP SDK's stdio transport is constructed only in `engine/mcp/stdio.ts`;
- only `core/cross-spawn-spawner.ts` builds Effect's `ChildProcessSpawner` service, so the
  Effect `ChildProcess` users spawn through it.

§4.3's list (PTY, MCP stdio, `util/process.ts`, untrusted Git, the bundle Git helper and
OCR) matches the `launch` and `pty-backend` stances; the inventory adds the Effect spawner
itself. The test does not cover spawns inside dependencies, other packages, scripts or the
Python native entry. The table, the findings (including the Windows taskkill follow-up
for the review-fixes lane and `pty/process.ts`'s `ps` for the Hands lane) and the search
model are in [`native-qualify-notes.md`](native-qualify-notes.md#nq-4-15-november-2026),
NQ-4.

## Addendum, 15 November 2026: lane-end status at the native-qualify head (NQ-8)

This is a dated addendum, and nothing above it was edited. The citations are at the
`native-qualify` lane head `ce5e5605` and use repository-relative paths.

`git diff 0ee486e3 ce5e5605` is empty for every production file cited here:

- `packages/core/src/owned-process.ts`
- `packages/core/src/cross-spawn-spawner.ts`
- `packages/core/src/process-isolation.ts`
- `packages/core/src/process-isolation/build.ts`
- `packages/engine/src/cli/cmd/github.sandbox.ts`
- `packages/engine/src/cli/cmd/github.isolation-build.ts`
- `packages/engine/src/task/shells.ts`
- `packages/engine/src/tool/shell/windows-process.ts`
- `packages/engine/src/effect/runtime-flags.ts`
- `packages/engine/src/tool/shell.ts`

The native evidence is in
[`native-isolation-status.md`](native-isolation-status.md#native-qualification-lane-end-15-november-2026),
and the package log and decisions are in
[`native-qualify-notes.md`](native-qualify-notes.md#nq-8-15-november-2026), NQ-8.

**C9:** not reachable at `0ee486e3` (the NQ-2 addendum above), and unchanged at
`ce5e5605`.

- New since NQ-2: run 43697711119 (job `132761821581`) shows that Bun `-e 0` aborts on
  the hosted image under the engine sandbox's empty read-only `/proc` segment, and starts
  under its own PID namespace procfs.
- If the `/proc` decision adopts that procfs, `ps` in `groupEmpty` would see only the
  engine's PID namespace (`packages/core/src/owned-process.ts:74-96`, `/bin/ps` at
  `:80`). C9 must then be checked again.
- **SPAWN-2** has the same status.
- The PR #33 follow-up list on `origin/review-fixes` (`1433d105`,
  `docs/vector/build/v2-notes/v2-complete-plan.md` §4.5) still tracks SPAWN-2 as
  "Remains", and says `/bin/ps` fails under the hosted sandbox's empty `/proc`. That
  contradicts the NQ-2 addendum. It is a lead item, and that file is not edited here.

**§6 Q3:** NQ-2's code-reading answer stands. Background shells are reachable in a hosted
legacy `@vector` run on Linux:

- `backgroundSubagents` is on by default (`packages/engine/src/effect/runtime-flags.ts:35`);
- `isolationRefusal` refuses on Windows only (`packages/engine/src/task/shells.ts:96-97`,
  called in start admission at `:464`);
- a durable lease is still required (`shells.ts:469`);
- the shell tool takes `ShellJobs` when the build provides it
  (`packages/engine/src/tool/shell.ts:1905`).

Whether to offer them is the owner's product decision. Until it is made, uncertain cleanup
fails closed.

**S4-2: reframed.** FLOOR is false, so `decide` returns the plain command
(`packages/core/src/process-isolation.ts:26`, `:326`).

- Owned cleanup of the plain group under `required()` is covered by
  `packages/engine/test/task/shell-required-isolation-posix-owned.test.ts:187`. That test has
  NQ-2's local passes only: `test.yml` has no run on `native-qualify`.
- Two more POSIX S4-2 tests exist only on `origin/review-fixes`, in `fa5a5639`, not merged
  here:
  - a floor-on case in `packages/core/test/process/owned-process.test.ts`
    (`ProcessIsolation.decide` with the floor on, a bwrap leader and a `setsid` canary);
  - a 136-line `packages/engine/test/task/shell-required-isolation-posix.test.ts`, the path
    NQ-2's 286-line file had until review round two renamed it (lane notes, D106), so the
    two files no longer collide.
  This addendum makes no CI claim for either test.
- The `setsid` escape from the plain group is pre-existing
  (`packages/engine/src/task/shells.ts:31`).

**S4-3:** exists, at `packages/engine/test/task/shell-required-isolation.test.ts:50`
(the refusal is asserted at `:43` and the marker at `:46`). No claim about a hosted result
is made here.

**S4-5 and SPAWN-3:** not on `origin/release-finish` `cf2373c4`, so both stay open in the
review-fixes lane.

- The candidate commits are on `origin/review-fixes` `1433d105`, not merged:
  - `8562dd7a`: the `WindowsProcess.start` guard, at
    `packages/engine/src/tool/shell/windows-process.ts:154-156` there;
  - `d6a54241` and `c8b97625`: S4-5, at
    `packages/core/test/effect/cross-spawn-spawner.test.ts:627` there.
- No CI claim is made for them.
- C10's canceller exists (`packages/core/src/cross-spawn-spawner.ts:508`). By `c8b97625`'s
  pending in-place note, S4-5 is met by `acquireRelease`'s release, and no test reaches the
  canceller through `spawnCommand`.

**SPAWN-1:**

- The POSIX half is covered by NQ-2's test, as above.
- The native half is open:
  - there is no `owned` case (`CASES` at
    `packages/engine/test/fixture/native-shell-payload.ts:17-28`);
  - the refusal at `packages/core/src/cross-spawn-spawner.ts:411` is untested on CI.

**S10 tests:**

- **S10-1:** open. Under the refusal no owned native command exists, and step 16 of
  43697711119 ran no case (`case` is null).
- **S10-2:** the refuse option applies, but it is open because no scenario exists.
  - By code reading, the refusal fires inside the job's `run` (`shells.ts:630`) after
    `background.start` has written the row (`:695`).
  - So the scenario must expect a row that ends with cleanup `"confirmed"`.
  - By code reading, `ShellJobs.start` itself fails with the refusal. It awaits `ready`
    (`shells.ts:762`). `ready` fails with the spawn error, which is wrapped as "Vector
    could not start the command: ..." (`:632`), re-raised by `run` (`:682`) and passed to
    `ready` (`:690`). `start` then re-raises it as a defect (`:766`). Its `onError`
    cancels the row (`:765`), and `cleanup` releases the slot (`:527-530`, the release at
    `:529`). The scenario must assert all three, as well as cleanup `"confirmed"`.
- **S10-3:** open; it was never reached.
- **S10-4:** open until `test.yml` runs after the merge. Its parts:
  - S4-2 as above, and S4-3 exists;
  - S6-2 is covered in part by `packages/engine/test/task/shells.test.ts:369`, whose first
    recheck sees no job row (`:389`). Its §5 spawner-layer form (a recorded
    `["recheck", "spawn"]` with ownership set) is not present;
  - legacy isolation cannot be exercised while FLOOR is false, apart from the unmerged
    `fa5a5639` floor-on `decide` case above.

**§6 Q2:** delegate versus refuse is still the native lane's or the owner's call.

- Refuse is in force (`packages/core/src/cross-spawn-spawner.ts:405-411`, the throw at
  `:411`).
- `packages/core/src/owned-process.ts` has no `delegate`.
- Owned groups use `OwnedProcess.track` (`cross-spawn-spawner.ts:456`).

Both native build switches and FLOOR stay false; no production activation is authorized
by this addendum.
