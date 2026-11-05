# Computer helper shared inputs

The macOS and Windows computer helpers (the native side of the feature whose display name is in `identity.json`) and desktop main build from the files here. Build contract: `docs/vector/build/hands-build-spec.md` sections 2.10 to 2.12 and 7.2 (C1); recorded corrections are in `docs/vector/build/hands-deviations.md` under C1.

## Single sources of truth

| File                                          | Source                                                                                                     | Committed         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- |
| `identity.json`                               | written by hand; the helper's display name, version, protocol range, bundle id suffix and executable names | yes               |
| `blocklist.json`                              | generated from `packages/schema/src/computer-apps.ts`                                                      | yes               |
| `Identity.swift`, `identity.h`, `blocklist.h` | generated from `identity.json`, `blocklist.json` and `packages/desktop/scripts/channel-ids.ts`             | no, build outputs |

Identity-bearing names stay `computer` (`ai.vector.app.computer`, `VectorComputer`, `vector-computer.exe`): renaming one resets every user's macOS grants. The display name appears only in `identity.json` and `packages/schema/src/hands.ts`, and `displayName` plus the channel word must equal `Hands.helperName(channel)`.

From `packages/desktop`:

```sh
# Regenerate blocklist.json after changing computer-apps.ts, and commit it.
bun ./scripts/computer-helper-identity.ts

# Render the generated sources for a helper build (C2 calls this). Reads the committed blocklist.json, never
# rewrites it, and refuses when it is stale.
bun ./scripts/computer-helper-identity.ts --out <dir>
```

The generator uses `node:` APIs only but runs under Bun: the schema package ships TypeScript sources with extensionless imports, which plain Node cannot resolve without a bundle. `--out` also refuses an `identity.json` that disagrees with the shared constants (`displayName` must equal `Hands.NAME` exactly).

`scripts/computer-helper-identity.test.ts` fails when the committed `blocklist.json` differs from a fresh render. The file is in `.prettierignore` (never format it by hand), and `.gitattributes` keeps it, `identity.json` and the transcripts LF on every checkout, so a Windows checkout embeds the same bytes.

## blocklist.json

- `never`, `noAlways`, `clickOnly` and `reasons` mirror `ComputerApps.NEVER`, `NO_ALWAYS`, `CLICK_ONLY` and each never category's block reason.
- `entries` keep `ComputerApps.TABLE`'s order, never entries first. Each has `key`, `name`, `category`, `list` (`never`, `system-ui`, `default-blocked`, `benign-system` or `categorized`), the patterns (`macos` bundle ids; `windows.aumid`, `windows.windowClass`, `windows.binary`) and, for the two blocking lists only, `removable`: `false` for never entries, `true` for default-blocked ones.
- `match`: ids compare case-insensitively and a pattern ending in `*` matches by prefix. On Windows a known window class is tried first, then the AUMID of an AUMID identity or the original file name from the signed image of an exe identity.
- `rules` spell out the category decision in order: a never entry decides; a child shell or REPL makes any non-developer app `terminal`; `system-ui` entries are visible in frames and never a grant target; a `system` identity (an OS platform binary) is `security` unless it matches a benign-system entry (on macOS only with `apple: true`) or a default-blocked entry; otherwise the listed category, else `general`.
- Enforcement (`enforce`): a helper refuses every target whose category is in `never` with `protected`, whatever the session approved. Default-blocked apps (trading and crypto apps, Disk Utility, Find My, Migration Assistant) are the desktop's verdict: the user can unblock them, so a helper never refuses one for being default-blocked, and the system rule exempts them.
- Click-only (`click-only`): a helper refuses text input into an app whose category is in `clickOnly` (IDEs) with `blocked`, after the owner and secure-field checks. Text input is `input.type`, `ui.setValue`, and an `input.key` or `input.hold` that types (below). Clicks, shortcuts and navigation or editing keys stay allowed.
- App keys are `Computer.appKey` strings and compare exactly; Windows exe keys escape `%` and `|` inside their parts.

## Generated sources

`Identity.swift` holds the per-channel app ids, helper bundle ids, helper names, Electron helper ids and Vector's Windows executables, the protocol range and executable names, and `blocklist.json` verbatim in a raw string. `identity.h` holds the same identity tables for the Windows helper; `blocklist.h` holds `blocklist.json` verbatim in line-aligned parts of at most 8 KB (MSVC limits one string literal), joined in order. The shapes are provisional: M1, M6 and W1 own them.

## Conformance transcripts

`packages/desktop/test/fixtures/computer-protocol/*.jsonl` hold one `{send, expect}` per line, at message level, needing no OS grant and no capture. The fake helper, D14's conformance test and C2's self-test replay them with `packages/desktop/test/computer/transcript.ts`.

- `send` is a request object, or a directive: `{"$raw": text}` (a frame with that body), `{"$oversize": n}` (a header declaring n bytes, then n filler bytes), `{"$wait": ms}`, `{"$eof": true}` (close the channel).
- `expect` is one message, an ordered array, `null` (nothing arrives) or `{"$exit": {"withinMs": 1000, "code": 0}}`. A message matches when every expected field matches, arrays element by element; `"$any"` matches any present value.
- Every received frame must also decode: a success with the schema of the op its id was sent with, a failure as `HelperFailure`, an event as `HelperEvent`.
- Events may arrive at any time (2.10): an event that decodes is skipped, and returned in `replay`'s `events`, while a line waits for a response, for nothing or for an exit, so a helper on a runner without grants may report `input_detection {alive: false}` when a foreground session starts. A line that expects an event matches the next event of that kind. No transcript expects an event today.

## Protocol decisions every helper follows

- Request ids start at 1. A failure that cannot be attributed (a body that is not a JSON object, no usable id, id 0, an oversized frame) answers with id 0.
- An inbound frame over `limits.maxFrameBytes` (16 MiB) answers `frame_too_large` at once and its bytes are discarded as they stream, never buffered; serving continues.
- `hello` answers the helper's own range and refuses a requested range it does not overlap with `helper_incompatible`.
- Five seconds after the last `heartbeat` or `session.begin`, the helper releases all input and answers every input op `stopped` until the next `session.begin`. A stop key or chord does the same, releasing input before it sends `stop`.
- Input checks run in this order: halted (`stopped`), `locked`, the OS permission, the coordinates (`stale_frame`, `out_of_bounds`), the owner (`protected`, then `not_granted`, then `changed` for a display capture or `occluded` for a window capture), then, for text input only, `secure_field` and the click-only rule (`blocked`). A keyboard op whose pid is not the focused app's answers `changed`. A zoom's capture id is never a coordinate space for input. `app.activate`, `app.launch` and `window.focus` answer `stopped` while halted and `locked` on a locked screen too, before anything else: nothing comes to the front on the lock screen or after a stop.
- Text input is `input.type`, `ui.setValue`, and an `input.key` or `input.hold` that types: its combo holds a key other than a modifier or a key that never types (Enter, Return, Tab, Backspace, Delete, Escape, the arrows, Home, End, Page Up, Page Down, Insert, Help, Caps Lock, Num Lock, Scroll Lock, Print Screen, Pause, the context menu key, F1 to F24, the media and volume keys), and no shortcut modifier. Command, Win and Control are shortcut modifiers, except that on Windows Ctrl+Alt is AltGraph; on Windows Alt is one too unless a numpad key comes with it (an Alt code). Shift, AltGraph and Fn keep a key's text, and so does Option on macOS (Option+S types ß). The list fails closed: a key name the helper does not know (`IntlBackslash`, `NumpadEqual`) counts as typing. So a credential cannot be typed key by key into a secure field, while Enter, Tab, Backspace, Delete, the arrows, Escape and shortcuts still work there.
- A background session (macOS "Alongside me") never moves the user's pointer or takes focus. A left single click with no modifiers goes through the element under the point: a button is pressed, a text field is focused inside its app. Keys go to the app the step named, in front or not, and to that app's focused element. Every other pointer step (no usable element there, another button, a double click, modifiers, `input.move`, `input.drag`, `input.scroll` without an element scroll action), `app.activate`, `app.launch`, `window.focus`, `ui.perform` `AXRaise`, and keys for a minimized app answer `needs_foreground` after the owner checks, with no side effect, so the desktop raises the pointer ask (M9, D19). A helper without the `background` feature (every Windows helper) refuses `session.begin` and `session.update` with `mode: "background"` as `unsupported_action`.
- `input_detection {alive: false, reason: "secure_input"}` is a macOS signal (secure event input, M6) and is sent only in a foreground session; a Windows helper reports its own reasons (W9).
- `hello`, `permissions.*`, `displays.list`, `apps.list`, `session.begin`, `session.end`, `heartbeat`, `input.releaseAll`, `cancel` and `shutdown` work without a session; every other op answers `unavailable` without one. `input.releaseAll` always succeeds. On Windows `permissions.request`, `permissions.reset` and `clipboard.*` answer `unsupported_action`, and `hello` reports `clipboard: false` (W2).
- A feature reported off behaves off: without `capture.exclude` the overlay windows are painted like Vector's other windows (they still take no clicks), and without `ui.secureFieldDetect` nothing is reported `secure` and nothing is refused as `secure_field`, so the desktop's own gate is what stops typing there.
- A display capture paints every window outside the approved apps and every never-listed window black, Vector's own windows as one Vector block, and leaves out the overlay windows; `masked` lists the painted rectangles. `ui.tree`, `ui.perform`, `ui.setValue`, a window capture, input, `app.activate`, `app.launch` and `window.focus` answer `protected` for a never-listed target and `not_granted` for one outside the session's approved apps. `ui.hittest` and `ui.focused` always name the owner and window, and add the element's `name` and `ref` only for an approved app that is not protected.

## The fake helper

`packages/desktop/test/computer/fake-helper.ts` (with `fake-desktop.ts` and `png.ts`) serves the protocol over a virtual desktop: Calculator, Notes with a locked-note password field, Terminal, Vector itself (one window and one overlay), a System Settings privacy pane, a fictional bank app, the desktop furniture and a notification toast, plus TextEdit and Visual Studio Code (a click-only developer app), which start closed and open on `app.launch`. It uses `node:` APIs and the shared schemas only; images are PNG whatever format a capture asks for, and a frame's hash is a 64-bit average hash.

```sh
bun ./test/computer/fake-helper.ts --stdio --parent-pid <pid> [--channel fd3|stdio] [--control-fd <n>]
  [--platform macos|windows] [--scenario calculator|notes|blocked|sensitive|multi-display]
  [--protocol <min>..<max>] [--features -<feature>,...] [--latency <ms>]
  [--fail crash-after:<n>] [--fail hang-hello] [--fail deny:screen] [--fail deny:accessibility]
bun ./test/computer/fake-helper.ts --version --json
bun ./test/computer/fake-helper.ts --probe --json
```

- The channel is fd 3 by default, and stdin and stdout on Windows; `--channel` overrides it. The fake exits within 1 s of channel EOF or the parent's death, after releasing input.
- `--control-fd` opens a control channel taking newline-delimited JSON: `{"type": "user_input", "kind": "pointer" | "key" | "click" | "scroll", "key"?, "dx"?, "dy"?}`, `{"type": "display_change"}`, `{"type": "focus", "windowId", "node"?}`, `{"type": "lock", "locked"}`. Without the option the fake serves normally.
- `--fail crash-after:<n>` exits with code 1, answering and releasing nothing, when request n + 1 arrives; `hang-hello` never answers `hello`; `deny:*` reports the permission denied in `permissions.status` and `--probe` and refuses the ops that need it (`permissions`; on Windows a blocked capture answers `blocked_by_os`).
- Its action log (`helper.log`) is in memory only and records typed text by length only, whichever op typed it: `input.type`, `ui.setValue` and `clipboard.write` as `length`, a typing `input.key` as `{types: true, length}`, a typing `input.hold` as `{types: true, ms}` with its held keys renamed `key:text-<n>` (so a release names no character), and the user's own key in a `user_input` control message as `redacted`. Shortcut and navigation combos keep their keys.
- In-process, `createFakeHelper(options, {write, exit, clock})` or `connect(options, clock)` drive it without a process; `manualClock()` makes timers deterministic. Running it under plain Node needs a bundle first, because the shared schema package ships TypeScript sources.

## macOS target

`macos/Sources` contains the M1 native transport, dispatcher, CLI and verified two-stage launcher. `macos/Tests/main.swift` is a separate unit entry and must never be linked with `Sources/main.swift`; C2 supplies the build assembly. Both targets consume `Identity.swift` rendered by `scripts/computer-helper-identity.ts --out <temporary directory>`. Build outputs belong under `native/out/darwin`, not `resources` or this source tree.

Serving uses the inherited duplex fd 3; stdout is reserved for the explicit metadata/probe/self-test modes. The one-shot probe verifies its actual parent, launches the same independent worker and never requests a permission. A direct/unverified worker or absent serving descriptor fails closed. M2 reports actual preflight-only Screen Recording, Accessibility and post-event status; only an explicit onboarding request may prompt, and reset targets the helper’s own generated identity. M3 supplies filtered display/window/zoom capture with actual geometry; M4 adds bounded, witnessed AX observations and element actions. M5 adds private tagged foreground pointer/keyboard primitives and owned-input cleanup. Stop detection/background features remain absent until M8/M9 implement their native handlers.

The grant-free unit source covers framing, phase/cancellation deadlines, caller topology, native session policy, injected permission operations and isolated pipe/socket behavior. Native CI compiles and runs the aggregate; new package checks remain source evidence until their corresponding run succeeds. Linux syntax parsing does not prove native behavior. C2/C6 own the reproducible compile and actual lifecycle/conformance evidence, and M11 supplies the final native scenario target.

## Build and safe checks

From `packages/desktop` on macOS, `bun run native:build -- --arch arm64` (or `x64`) builds one requested slice; the default `universal` is used in CI. Builds run native compilers serially and write `native/out/darwin/VectorComputer.app`, `computer-helper.json` and the separate `tests/` executables. `bun run native:test -- --privileged off` runs only the grant-free layer through a temporary, verified caller app. It never substitutes an owner application for the dedicated privileged test target. Windows builds require Windows and the W1 project/MSVC environment; another host may verify an explicitly supplied prebuilt tree.

`native:build -- --check-lock` is a native macOS check. The committed lock enforces the latest reviewed native measurement. A helper-byte change advances the helper version and fails against that prior baseline until a successful native run writes `identity.lock.computed.json`; review/commit that evidence rather than disabling enforcement or filling hashes by hand. Manifests hash final signed shipping bytes. No generated output or helper binary belongs in this source directory.

The self-test report accounts for every classified transcript and distinguishes passed, failed and skipped checks. M1’s absent keyboard implementation leaves its heartbeat-input case explicitly skipped until M5. Required grant-free checks cannot skip, privileged checks default off, and every future/override fixture must satisfy the safe catalog and operation rules.

`native:test` uses one Bun compiler host to emit a temporary driver and then runs its transport in actual Node, matching desktop main. Paired native CI proved the same helper/golden succeeds under Node while Bun's transport exits early on the oversized write. The native framing, probes and lifecycle limits are unchanged. The launcher creates no child Bun, preserves original fixture roots/CLI guards and removes its generated files on completion.

CI uses `.github/workflows/computer-helper.yml`. To run only this lane from the authorized development branch, use `gh workflow run test.yml --ref hands -f computer_helper=true`. It builds twice on pinned Xcode 16.4, requires native core checks and the measured identity lock, and restores verified shipping/test tarballs on the secondary runners. Hosted CI opts into optional scenarios only against the isolated target. Windows protocol checks remain pending W2, and the summary keeps C4/C8 obligations explicit.

## Windows target

`windows/` contains the W1 MSVC/C++20 GUI-subsystem project and its separate unit/target executables. C2 supplies generated headers, the measured digest, the exact installed MSVC toolset and Windows SDK. The builder requires the two version variables from a developer environment and CMake 3.27+ for exact SDK selection. Windows builds and native suites run in C6 on `windows-2025` and `windows-11-arm`.

The skeleton implements version JSON and a read-only token probe. It conservatively reports capture blocked, refuses protocol serving until W2 and returns 77 for unimplemented native self-test/target scenarios. The unit executable embeds its original JSON fixtures and inspects the shipping PE's real resources, architecture and GUI subsystem, so its artifact needs no repository source paths. Windows protocol/lifecycle checks remain pending W2; this source tree alone is not native execution evidence.
