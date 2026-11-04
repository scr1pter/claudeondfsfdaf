# Vector Hands: desktop phase review (not yet repaired)

This is the review of the desktop phase, C1 and D13 to D23 (`07dad9c6..0e1e6d56`), done from two angles: contract and tests, and safety, consent and portability. It was the phase's first review. Nothing here has been fixed yet. Whoever builds next confirms each finding against the code, fixes the real ones, rejects the wrong ones with a reason in the commit body, and commits the result as `fix(hands): Desktop review`.

16 findings: 5 medium and 11 low. None is high.

## 1. Medium: D22

- Lens: Contract and tests
- File: `packages/desktop/src/main/computer-notify.ts`

**Problem.** Check-in questions trigger two OS notifications. This breaks INV-T6 ("no duplicate notifications from the renderer") and the D9 obligation carried to D22. createAskMirror (computer-startup.ts ~L268) puts a Hands check-in question into state.ask as kind "check_in" in phase "asking". createComputerNotify then sends "Vector Hands needs you" for any state.ask in asking/handoff/paused, with no filter on kind. The renderer predicate packages/app/src/pages/layout-computer-notify.ts (rendererNotifies) still notifies for check-in questions, because it skips only the two Hands permission asks and handoff questions, and it was not changed in this range. So when Vector is not focused, a "Keep going?" check-in on the built-in engine raises both the renderer notification and desktop main's notification. D9 obligation (c) is also unmet: no test pins layout.tsx's use of rendererNotifies end to end (on the built-in engine, a computer_app ask and a handoff raise no renderer notification while an ordinary ask still does). Neither gap is recorded in D22's deviations or its list of carried obligations.

**Fix.** Do one of the two in the same change. Either exclude kind "check_in" from the needs-you path in createComputerNotify, or extend rendererNotifies to skip question metadata {computer:{kind:"check_in"}} when desktopOwns is true. Add a test in computer-notify.test.ts or layout-computer-notify.test.ts showing exactly one notification for a check-in. Add the end-to-end layout pin as a CI-only browser case, for example in hands-journey.spec.ts. Record the choice as a D22 deviation.

## 2. Medium: D18

- Lens: Contract and tests
- File: `packages/desktop/src/main/computer-startup.ts`

**Problem.** state.apps does not keep the app in use last. D9.12 put this obligation on D18 ("'Using <app>' reads state.apps.at(-1): D18 must keep the app in use last"). The controller (computer-session.ts ~L668) builds state.apps from input.approved(). D22's approved() (computer-startup.ts L574-578) returns the helper's apps.list order, filtered to apps whose verdict is granted, and that includes Always-allowed apps that are running but not used in this task (D22.13). At least four places read state.apps.at(-1) as the current app: the banner fallback line (overlay-page.ts statusLine), the composer's working line (computer-card-model.ts workingLine), the tray (computer-tray.ts computerTrayState, "Working in <app>") and the end notification's app list. Example: Hands acts in Numbers while an Always-allowed Notes window is open and comes later in apps.list. The banner, tray and composer then say "Working in Notes" / "Using Notes", which is a false transparency line.

**Fix.** Have the controller track the app currently acted on: the gate-checked owner from the executor (beforeStep metadata or didStep), or the last granted target. Order that identity last in state.apps, or add an explicit current-app field and point the three consumers at it. Add a computer-session.test.ts case where the approved set contains an untouched app after the target, and assert state.apps.at(-1) is the target.

## 3. Medium: D19

- Lens: Contract and tests
- File: `packages/desktop/src/main/computer-executor.ts`

**Problem.** Deadlines for hold_key steps are too short. The engine allows hold_key seconds up to LIMITS.holdSecondsMax (10) with repeat up to 20 (engine/src/computer/actions.ts L110-115). The executor sends each repeat as input.hold {ms: holdMs} with a per-op deadline of Computer.LIMITS.inputStepMs (10 000 ms) (~L733-739), and actDeadline (L93-99) counts the whole key step as one 10 s budget, whatever holdMs × repeat is. Results: a 10-second hold always reaches the client timeout before the helper answers, so the client cancels, releases all input and fails the step. A hold of 5 s × 8 repeats (40 s) goes past the act deadline of about 35 s plus settle and is cancelled. The deadline-formula test (computer-executor.test.ts L468-475) pins this undercount: {kind:"key", repeat:20, holdMs:10_000} is counted as 10 000 ms. The contract's "waits as requested" intent covers requested hold time. The engine transport (engine/src/computer/transport.ts L30) uses the same formula, so both sides time out.

**Fix.** Set the per-op deadline for input.hold to holdMs + inputStepMs. In actDeadline, count a key step with holdMs as repeat × (holdMs + inputStepMs), or inputStepMs + repeat × holdMs. Make the same change in engine transport.ts so both sides agree. Correct the formula test, add an executor case with a 10 s hold that succeeds under fake timers, and append a D19 deviation note.

## 4. Medium: D16

- Lens: Contract and tests
- File: `packages/desktop/src/main/computer-gate.test.ts`

**Problem.** INV-S2's named test is missing. Section 1.6 and the D16 entry require computer-gate.test.ts › "focus moves to another app between type chunks: the remaining chunks are not sent". The chunk tests here (L581-717) and the executor's chunk tests (L1407-1443) only change the field, role, label, policy or deny inside the same app, PID and window (Notes). None moves focus to a different app, PID or bundle between chunks, so the app-change path in sameTarget/typeChecked is never exercised by the invariant's own test. No deviation records the substitution.

**Fix.** Add the named test. After the first chunk is sent, set fake.state.hit.owner to a different app (another bundleId and pid, granted or not). Expect {verdict:"refuse", code:"changed"} and exactly one input.type chunk in fake.state.inputs.

## 5. Medium: D22 (D16.5 / D19.1 obligation)

- Lens: Safety, consent and portability
- File: `packages/desktop/src/main/computer-startup.ts`

**Problem.** The desktop gate's protected-document floor is weaker than the engine's, but INV-S3 says the desktop must enforce it whatever the engine says. Startup builds the executor with `protectedPaths: []` (line 610) and `protectedDirectories: protectedLocations(...)` (line 611, built at lines 105-118). Those directories are raw strings and are never passed through realpath. The gate does realpath the document (`canonicalPath` → `realpath`) before `ComputerSensitive.protectedDocument` compares prefixes, while the engine canonicalizes both sides (`[global.config, global.data, global.state].map(canonical)`). Failure case: `~/.config/vector` is a symlink into a dotfiles repo. A document such as `~/dotfiles/vector/agent/reviewer.md` resolves outside every protected prefix and matches none of core's filename regexes (agents/claude/context/rules/brain/memory.md, vector.json), so the desktop lets Hands type into Vector's own agent prompt file. Second gap: configured instruction files (`cfg.instructions`, arbitrary paths) and memory files outside those directories are never given to the desktop. D16 deviation 5 and D19 deviation 1 required the D22 composition to supply instruction, memory and configuration paths; D22 deviation 10 lists only the directories.

**Fix.** In startComputer, realpath every entry from protectedLocations and pass both the raw and the canonical forms. Do the same for `VECTOR_AGENT_CONFIG_DIR`, and resolve its parents when the leaf does not exist yet. Also supply the configured instruction and memory paths: read them from the engine's authenticated config route after attach (engine code, not model output), canonicalize them, and refresh them when config changes. Fill `protectedPaths` with these, or have the executor take a getter. Add a computer-gate test with a symlinked config directory and one with a configured instruction file outside the default directories. If any part cannot be done, record it as a numbered deviation under D22.

## 6. Low: D16

- Lens: Contract and tests
- File: `packages/desktop/src/main/computer-gate.test.ts`

**Problem.** The D16 contract test "overlay windows are skipped in the hit-test" is missing, and no deviation records that. The only overlay-related gate test (L251) asserts the opposite case, that hitting a Vector-owned window is refused. Overlay skipping depends on the helper honouring session.begin overlayWindowIds. Nothing in the gate, conformance or session tests checks that a pointer step over an overlay strip, banner or cursor host resolves to the app underneath and is allowed. (The fake-helper test checks only that overlays are left out of capture pixels.)

**Fix.** Add the case. Either drive checkStep through NativeHelperBackend with the C1 fake: begin with overlayWindowIds including OVERLAY, hit-test a point covered by OVERLAY over a granted Calculator window, and expect ok with owner Calculator. Or put the equivalent hit-test assertion in computer-conformance.test.ts and record in a D16 deviation that the test moved there.

## 7. Low: D17

- Lens: Contract and tests
- File: `packages/desktop/src/main/computer-overlay.test.ts`

**Problem.** The D17 contract test "a theme change leaves overlays transparent" is missing. The D17 checkpoint and D17.1 say theme and zoom changes exclude overlays (windows.ts setBackgroundColor and setPinchZoomEnabled skip isComputerOverlay windows), but no test covers it. A grep of every desktop test finds no setBackgroundColor case that involves an overlay.

**Fix.** Add a test that mocks BrowserWindow.getAllWindows with one main window and one registered overlay. Call setBackgroundColor and setPinchZoomEnabled, then assert the overlay's setBackgroundColor, zoom and send were never called while the main window's were.

## 8. Low: D18

- Lens: Contract and tests
- File: `packages/desktop/src/main/computer-executor.ts`

**Problem.** Two section 1.5 D/E lines carried from earlier packages are not wired. (1) D10.2's D18 obligation: in background mode, when the ghost cursor is not drawn, the step must be ComputerMainCopy.workingBehind({app}) ("Working in Numbers behind your windows"). The executor's cursor() (~L599-631) only sends visible:false, and workingBehind / ComputerOverlayLayout.cursorVisible are used nowhere in desktop main. (2) D9.12: the Tasks card note "<app> needs the screen; Vector Hands will ask before using your mouse" after a background failure needs a state field from D18. None was added, and ComputerMainCopy.foregroundFallback and computer.working.foregroundFallback have no consumer. Neither gap appears in the D18, D19 or D22 deviations.

**Fix.** When a background pointer step's target is not visible, set state.step via the controller to workingBehind({app: verified name}). Expose the foreground-fallback app in ComputerState, or as a fixed step line, once task().foreground gains an app, and render it in the Tasks card. Add tests for both, or record explicit deviations deferring them.

## 9. Low: D19

- Lens: Contract and tests
- File: `packages/schema/src/computer.ts`

**Problem.** D19 changed the section 2.8 bridge wire without naming the changes in a deviation. It added a new bridge command prepareOpen ({lease, app} returning {kind:"app"|"program"}), widened openApp's app to accept {program: ProgramLaunch}, and widened openApp's response to a union with {program, launched:true} and {pending:{kind:"sensitive", why:"run_program", program}}. D19.5 and D19.10 describe the new helper ops (apps.resolve, program.launch) and the idea of preparing open targets, but no note names the new bridge command or the changed openApp shapes, as the rules require for any departure from section 2 interfaces.

**Fix.** Append a numbered D19 note listing the exact section 2.8 additions: the prepareOpen request and response, the openApp {program} target and the openApp response union, with the reason and the engine consumer (engine/src/tool/computer.ts).

## 10. Low: D21

- Lens: Contract and tests
- File: `docs/vector/build/hands-progress.md`

**Problem.** The progress file is not current on a CI result that had already been seen. The D21 checkpoint (and the D22 checkpoint, which repeats that the earlier items are pending) says full run 41268414135's "Windows full browser execution is still pending". The GitHub API shows that run's e2e (windows) job finished with success at 2026-11-01T03:51:07Z, before the D21 commit. Nothing is overclaimed; the record understates what is known.

**Fix.** In the D21 or Resumed checkpoint, record that e2e (windows) in 41268414135 passed at 75e84c4b. Keep the unit (windows) failure fixed by 9b2edb55 as the only failing job of that run.

## 11. Low: D16

- Lens: Safety, consent and portability
- File: `packages/desktop/src/main/computer-grants.ts`

**Problem.** Two pieces of grant state live for the whole process and are never pruned, so they eventually lock Hands out, failing closed. First, `seen` (every Hands ask id) is never cleared, not even in disconnect(). Once it reaches MAX_SEEN=10000 (line 220), every new ask calls endTask. Second, roots that hold a Deny are kept for as long as the process runs: `forgetRoot` (line 461) has no production caller, and `session.deleted` never reaches the grants manager. Once 1000 conversations have recorded a Deny, `beginTask` throws `Too many computer grant scopes are retained` (line 106). From then on every acquire fails as `unavailable` until the user quits Vector, and the desktop app is normally left running for weeks.

**Fix.** Call `grants.forgetRoot(root, directory)` when the session controller sees `session.deleted` for a root session. Evict the least recently used deny-only roots past the cap; dropping a Deny only brings the ask back and never grants. Replace the unbounded `seen` Set with a bounded LRU: replay protection still holds, because a reply must match a live, task-bound proof. Alternatively keep a per-engine-connection high-water mark, since PermissionV1 IDs are ascending. Add tests that cross each cap and check that Hands still admits a new task.

## 12. Low: D16

- Lens: Safety, consent and portability
- File: `packages/desktop/src/main/computer-grants.ts`

**Problem.** Consent is checked across two unordered channels, so a real Allow can be refused. The engine publishes `permission.replied` on its SSE stream, resolves the ask, and immediately sends `grant` (or an `act` with `approvals`) over a separate bridge HTTP connection. `grant()` (lines 292-303) and the gate's `peekSensitive`/`consumeApp` only `synchronize()` observations that are already queued. If the bridge request is handled before startup's `events()` loop has passed the reply to `controller.observe` (that loop awaits each event in turn, including `updateGrants()`/`beforeStep` helper round trips), `proof.reply` is still undefined. The result is a spurious `not_granted` (`That app approval is not current.`), and the user's answer is lost.

**Fix.** When a request id matches a live proof whose reply has not been observed yet, wait a bounded time (for example up to 2 s) for its reply instead of failing at once. Register the waiter in `task.waiting` so that task end, Stop and disconnect cancel it, and refuse after the timeout. Add a grants test in which `grant` arrives before the replied event and the event follows within the bound.

## 13. Low: D16

- Lens: Safety, consent and portability
- File: `packages/desktop/src/main/computer-gate.ts`

**Problem.** A `wait` step sends no input, but the gate still resolves `ctx.backend.focused()` (line 65) and runs the full owner gate on whatever app is frontmost. A wait is therefore refused as `blocked` when Vector or any never-listed app (such as Terminal) has focus, `protected` for system UI, and `pending(app)` for any ungranted app. In background mode the user usually keeps chatting in Vector, so every wait step fails as blocked. The engine then records a refusal and the model is told the app is blocked.

**Fix.** For `step.kind === "wait"`, keep the liveness checks (`synchronize`, `isActive`) and the approval-proof handling, but skip target resolution and the owner/category/access checks. The waiter then works through `wait()`, which re-checks `live()`. Add a gate test: a wait while a never-listed app has focus returns ok, and nothing is sent to the helper.

## 14. Low: D16

- Lens: Safety, consent and portability
- File: `packages/desktop/src/main/computer-gate.ts`

**Problem.** Before the user has approved an app, `checkStep` builds `inspect` (lines 78-99) from the helper's hit, including `element.label` (hit.name), a freshly minted bridge `ref`, `document`, `programPath`, `layout` and `focusedMenuShortcuts`. It returns this in `pending("app", inspect)` (line 108), and the executor forwards it to the engine in `ActResponse.pending.inspect`. The fake helper withholds these fields for apps that are not approved, but the desktop relies entirely on the helper to do so. INV-S3 makes the desktop the enforcement point, and INV-C8 says content of apps not granted for the task stays hidden. A native helper that reports, say, a document path would send content from the unapproved app (for example a file name or menu labels) to the engine before consent.

**Fix.** When the result is `pending("app")`, return an inspect limited to identity, category, pid, window id and the element's role/secure/enabled/editable flags. Drop label, ref, elementId, document, programPath, layout and focusedMenuShortcuts, and mint no registry ref for that hit. Add a gate test in which the helper reports those fields for an ungranted app and the pending inspect leaves them out.

## 15. Low: D22

- Lens: Safety, consent and portability
- File: `packages/desktop/src/main/computer-startup.ts`

**Problem.** `processElevated` on Windows runs `execFile("whoami", ...)` (line 96) by bare name. On Windows, libuv searches the current directory before PATH, so a `whoami.exe` in Vector's working directory, or earlier on PATH, could print a medium-integrity SID. Hands would then treat an elevated Vector as unelevated, which defeats INV-S10's 'not offered while Vector runs elevated'. The macOS checks already use absolute tool paths (`/usr/bin/codesign`).

**Fix.** Run `path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe")`, or better, read the token integrity level natively or through the helper's probe (W1 already reports `elevated`). Treat a missing or failed check as elevated, as the code already does.

## 16. Low: D19 (binds W5)

- Lens: Safety, consent and portability
- File: `packages/desktop/src/main/computer-executor.ts`

**Problem.** Ref clicks always call `input.backend.perform(hit.ref, "AXPress", ...)` (line 756), using the macOS Accessibility action name on both platforms. W5 acts through UI Automation `InvokePattern`, and neither the contract nor any deviation tells the Windows helper to accept `AXPress`. The fake accepts `AXPress` whatever `--platform` is set, so Windows conformance cannot catch it. On a real Windows helper, every ref click could come back `took: false` and be refused as `unsupported_action`.

**Fix.** Have NativeHelperBackend map a neutral press action to each platform's native action (or send a platform-neutral `press`), and make the fake reject the macOS-only name under `--platform windows`. Otherwise, append a D19 deviation that binds W5 to accept `AXPress` as the Invoke action, with a conformance transcript.
