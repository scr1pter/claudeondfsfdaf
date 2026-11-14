# Handoff: finish building Vector Hands (Vector's computer use)

> **Current continuation supersedes this historical briefing.** All **73/73 source packages** are implemented. Continue from the [current checkpoint](./hands-progress.md#current-continuation-main-integration-and-native-validation-pending), not D5b. Main `0dcbb8e2` integration is in progress and awaits validation. Published desktop 1.99.112 did **not** include Hands; Hands is unversioned and unreleased, with its own [owner checklist](../owner-actions/hands-release.md). Windows native Stop/capture and final x64/ARM64 packaging evidence remain open. The early-accessibility fixture change is diagnostic only. Signing, real-device OS checks and public release remain owner gates. The full original handoff below is preserved as historical context; its package count, next task and release target are superseded.

## Historical handoff

You are taking over a build started in an earlier Claude session and continued by Codex. Read this whole briefing first. Continue the implementation, validation and review through completion of the remaining work packages for **Vector desktop 1.99.112**.

Everything lives on GitHub. The owner works across several computers, so nothing essential may stay on one machine. Clone the repository, work on the **`hands`** branch, and push each completed package. This is the same Vector repository and workspace discussed with the owner; do not search for a separate Hands product or restart the project.

**Update: D5b to D12 have since been implemented on `hands`; [hands-progress.md](./hands-progress.md) holds the current status and CI evidence, and the paragraph below records the original pause.**

**Checkpoint: 23 of 73 work packages are implemented and committed, through D6a. The next package is D5b. Fifty remain.** D5b was investigated, but no D5b implementation or test changes were made before work stopped. There is no partial D5b patch to recover. The last code checkpoint is **`491552280a0421d86ab8b6489fd4332e28b4251f`** (`fix(hands): engine review`). Later commits may contain this handoff and checkpoint documentation. Fetch the latest `hands`; do not reset to the checkpoint.

The user paused implementation to transfer the work. This briefing records the state at that pause. The feature is **not release-ready**: most app integration, the desktop controller, the real native helpers and packaging remain. Some validation is also outstanding; do not interpret the completed-package count as an entirely green release or full CI result.

## 1. What Vector is

Vector (<https://vectordev.ai>) is an AI coding-agent harness made by a solo founder, referred to here as the owner. It has these parts:

- An Electron 42 desktop app: `packages/desktop` is the main process and `packages/app` is the SolidJS UI.
- A CLI and terminal UI.
- An engine in `packages/engine`. In the desktop app it runs as an Electron utility process under **Node**. Engine runtime code must not acquire a dependency on Bun runtime APIs.
- Shared packages including `packages/core`, `packages/schema` and `packages/session-ui`.
- A website in `packages/web` and backend services in `api/`.

The public repository is **<https://github.com/scr1pter/claudeondfsfdaf>**. Its default branch is `main`. An older origin URL, `scr1pter/bjikdoy`, redirects to this repository; that is not a second project. The stack includes Bun **1.3.14**, Turborepo, Effect and TypeScript checked with `tsgo` through package scripts.

At the original handoff the shipped desktop version was **1.99.111**. The owner explicitly assigned Hands to **1.99.112**. This is a target, not a statement that 1.99.112 has already shipped. Check current release files when the release packages require them; do not make unrelated version or release changes during UI work.

Read the repository's `AGENTS.md` and the instructions in every package you touch. App work prioritizes stability, simplicity and performance, in that order. Session and timeline changes require production benchmark evidence before and after the change. Engine code follows the repository's Effect service, layer, scope and Node-runtime conventions.

## 2. What Vector Hands is

Vector Hands is Vector's own computer use. With the user's permission, Vector sees and operates apps on the user's computer to perform tasks the user requested. The intended quality reference is ChatGPT's Computer Use: <https://learn.chatgpt.com/docs/computer-use>. Many users are non-technical; reliability, understandable controls and quality matter more than minimizing tokens.

The product requirements remain:

- **Name:** user-facing “Vector Hands”, mentioned as “@Hands”. The shared naming source is `packages/schema/src/hands.ts`. Use its constants rather than scattering names through code. Internal identifiers remain `computer`, including permissions such as `computer_*`.
- **Visible operation:** purple edges on every display and the fixed top banner “Vector is using your computer” with Stop. There is no hidden mode. The later overlay packages must handle multiple displays, Spaces, fullscreen and notch-safe placement, and exclude the overlay from captures.
- **Explicit approval:** per-app Allow / Always allow / Deny; an always-allowed list in Settings; separate confirmation before sensitive actions; company restrictions that personal settings cannot relax.
- **Normal OS consent:** macOS Screen Recording and Accessibility onboarding, with appropriate deep links. The user obtains permissions through the normal OS flow. The helper owns the required permissions; a grant to Vector's main app is not a fallback.
- **Mentions:** @Hands and @AppName add structured hints. Mentioning an app does not grant access to it.
- **Platform behavior:** macOS supports background operation where the target allows it; Windows is foreground-only. Supported targets are macOS 14+ and Windows 10 2004+ / 11. Linux shows an unsupported desktop status where specified; the web build, CLI and TUI do not acquire local computer-control capability.
- **User control:** Stop, Take over, physical input handling, lock/sleep/away handling and check-ins are essential behavior. Locked use is deferred.
- **Protected apps:** never operate terminals, Vector itself, password managers, OS security/privacy settings or credential prompts. Built-in never rules cannot be removed. Remote-viewer and other protected categories follow the shared table and contract.
- **Prefer appropriate integrations:** use a fitting plugin, MCP server or built-in browser before computer interaction where possible.

Describe protections as requirements and tests. Screen content is untrusted data, not permission, instructions or a source of durable configuration. Do not write descriptions of ways to evade OS protections. Local tests must use fake platforms/helpers and must not request permissions or operate the owner's computer. Native-helper checks against controlled, isolated CI targets follow the narrower rules in Section 5.

The full contract's 38 invariants are authoritative. In particular, preserve these boundaries as later packages are connected:

- Computer tools are limited to the eligible, local, attended owner V1 flow. E5 withholds them in unsupported contexts, including internal/subagent, scheduled, guest-touched and V2 execution. Read its actual availability predicate before changing registration.
- The engine never persists an app grant. Desktop verification and the helper enforce actual access. “Always” is restricted to verified, eligible identities and the company ceiling; browsers, file managers, financial/developer apps, changed signatures and unverified identities have the exclusions specified in the contract.
- Sensitive approval is one-time, armed after 700 ms, has no autofocus and is pointer-only. An app hint or provider safety-check identifier is not a grant.
- D16 must bind and consume proofs against the request, target, frame, step and lease. Engine-side and provider-check proofs also need the documented verification; do not validate only the easiest app-approval case.
- Root-family FIFO ownership and bounded cleanup must survive cancellation, engine exit and helper exit. Shared deadlines include desktop heartbeats every 2 seconds, a 5-second helper watchdog and a 10-second engine-quiet boundary. Input must be released before waiting for workers to join; cancel/release cleanup is bounded at 5 seconds.
- Check-ins occur after 300 actions or 45 active minutes, excluding time spent asking. The proposed away default is 30 minutes, with company limits. Use shared constants.
- Coordinates refer to the latest full frame. A zoom image does not replace that coordinate space. Native provider scaling, including Gemini's 0–999 coordinates, must preserve the same rule.
- Private screenshots, provider history, public sharing, guest visibility and deletion are different paths with explicit policies. Preserve E13's filtering and tombstones when adding UI and retention.

## 3. Where everything is

**Getting the code**

```sh
git clone https://github.com/scr1pter/claudeondfsfdaf.git vector
cd vector
git checkout hands
bun install --ignore-scripts
```

Use the owner's existing GitHub sign-in as `scr1pter`. If authentication is absent, use the normal `gh auth login` flow; do not inspect credential files. Existing clones should inspect their working tree and fetch safely. Do not overwrite another session's edits. The previous local worktree was `/workspace/vector-hands`, but no continuation step should depend on that machine or a temporary artifact there.

**Read these files first**

1. `docs/vector/build/hands-build-spec.md`: the build contract. Section 0 is the exact order and dependencies; Section 1 is the journey, invariants and owner decisions; Section 2 defines shared interfaces; Sections 3–7 define the E/D/M/W/C work packages.
2. `docs/vector/build/hands-deviations.md`: recorded, intent-preserving corrections to the contract. Some later packages must implement obligations recorded here.
3. `docs/vector/build/hands-progress.md`: the shorter checkpoint and outstanding validation.
4. This handoff, plus the actual source and package instructions. If something differs, inspect current code and history rather than treating a planning note here as an implemented API.

The original design-review conversations are not stored. The contract and committed deviations contain the necessary design decisions. Do not spend time trying to reconstruct the earlier chats.

**Committed work**

The branch was cut from `main` at `42346154`. `e435d807` added the plan files. These are the 23 implemented work packages, in the contract's order:

| Package | What was built | Commit |
|---|---|---|
| E0 | Shared schemas and computer app identities | `3ef62034` |
| D1 | Brand constant and naming guard | `6a739acd` |
| E1 | Computer permission IDs always ask | `ed02c05a` |
| E2 | `ctx.ask` returns the answer; no engine-persisted computer grant | `3b1389b6` |
| E3 | Agent defaults and plan-mode gating | `3af17736` |
| E4 | Company-only computer policy | `2adcd7eb` |
| E5 | Availability and tool registration | `95e01032` |
| E6a | Transport deadlines and cancellation | `9879983d` |
| E7 | Sensitive-action and screen-trust classifiers | `987dab32` |
| E8 | Screenshot sizing, history and repeated-action handling | `e6a44c3b` |
| E6 | App actions, leases and approval flow | `6e76ccdb` |
| E6b | Batches, check-ins and attended flow | `7dd013dc` |
| E14 | Private action log | `4c65ee3a` |
| E9 | Provider-native tools and generic fallback | `235aa610` |
| E10 | Shell guards after computer observations | `e846cfab` |
| E11 | Community desktop-control MCP policy | `c7bddc8c` |
| E12 | Offered-tool policy and copy | `d8728416` |
| E13 | Screenshot privacy, shares and pruning | `8e1d52bc` |
| D2 | Shared English and desktop copy | `f0382a54` |
| D3 | Fake platform and browser harness | `c9157a18` |
| D4 | Explicit app and sensitive approvals | `2772e1f1` |
| D5a | Pure mention options, editor pills and request markers | `ba845338` |
| D6a | Explicit consent and OS-permission onboarding | `3bb67725` |

Review and validation fixes are additional commits, not additional work packages. Notable ones are `0c774349` and `51f06247` for engine review, `a227c869` for SQLite statement cleanup, and `49155228` for the remaining V2 policy fixture. Follow the latest branch state, not just the original feature commits.

**Engine implementation details that later work must preserve**

The main entry points are `packages/engine/src/tool/computer.ts`, `packages/engine/src/computer/`, `packages/core/src/computer/`, `packages/schema/src/computer.ts` and `packages/schema/src/computer-apps.ts`. Focused tests live in the corresponding core/engine test directories, including `engine/test/tool/computer.test.ts` and `engine/test/computer/`.

- Native-tool configuration is **`auto | off`, default `off`**. Do not invent an `on` setting. Selection is sticky per conversation and requires an actual validated mention. Generic-first behavior locks the choice. Anthropic subscription sign-in and OpenAI sign-in without the required fetch override remain generic. Helper/title/memory requests must not alter it.
- Native OpenAI pending checks are bounded and attached once to the first input step. Unknown or partial provider classifications stay unknown. Provider fixtures verify mapping and behavior; they do not establish live-provider interoperability.
- Native pixel scrolling already has an optional **`unit: "pixel"`** on the wire. D19, M5 and W4 must preserve and honor it. Omission keeps generic wheel semantics; treating pixel deltas as wheel counts would be a regression.
- Anthropic tool/version and clearing behavior is already implemented and documented. Preserve frozen generic schemas with the current executor, valid signed history and the `clear_tool_uses_20250919` behavior. Unverifiable older signed thinking is dropped where required. Do not change a session's native/generic choice through unrelated helper requests.
- E10 uses the exact reserved **`#after-screen `** marker for a fresh, once-only shell confirmation in the same user turn, including asynchronous observation completion before spawn. Both permission evaluators remove it before ordinary command-policy matching. It must not become an Always or automatic approval path. Preserve root-ancestry/history recovery.
- E11 limits the company guard to recognized community desktop-control MCP processes using focused argv classification. Unrelated MCP servers keep their existing behavior.
- E12 adds computer policy only when `computer` is explicitly in the offered tool set. An omitted tool list does not justify claiming computer access.
- E14's private JSONL log uses restricted directory/file permissions, serializes writes and honors deletion tombstones. Sensitive typed values are recorded only as length/hash metadata. Logging failure stops the action path.

**E13: privacy and deletion are implemented; their remaining UI consumers are not**

Manual sharing requires an explicit screenshot opt-in for that publication. Automatic/live sharing strips screenshots. Local export strips them by default; CLI `--include-screenshots` opts in, while sanitized export still strips them. Public image handling is bounded to the documented PNG/JPEG/WebP formats.

The explicitly opted-in initial archive is stored using the existing archive field, without a new migration. It survives unchanged live flushes, then follows the policy for actual transcript updates. State is reread after asynchronous publication so a late share response cannot restore an archive pruned in the meantime.

Filtering covers V1 and native/provider duplicates across guest JSON, SSE, sync, history/replay/import and the relevant model-training/helper/Brain boundaries. Preserve ordinary owner UI and private replay where permitted. Do not replace the explicit projection policy with blanket deletion of unrelated attachments.

The prune endpoint supports the specified exclusive cutoff, session and all scopes, reports counts, and removes screenshot data from legacy/native history and pending archives. It leaves removal metadata/tombstones. The all path checks transaction, VACUUM and WAL truncation behavior. Late completion or event replay must not restore screenshots. Do not republish stale whole parts after pruning: that can overwrite concurrent state.

**D7 must implement both the checkbox and screenshot rendering in the public viewer.** The server can publish opted-in bytes, but the existing viewer was text-only. **D7 (done) also changed core publication semantics that later share and prune work must keep** (deviations D7.4, D7.6, D7.8–D7.10): a manual publish withdraws an unconfirmed `creating` row (guarded mark to `deleting`, idempotent DELETE leaving a tombstone, then a fresh identity) instead of resending it, and resumes a `deleting` row's removal; a reviewed publication (one with `previewHash` or `includeScreenshots: true`) that finds a confirmed share answers `CONFLICT` after restating that share, while unreviewed callers such as `vector run --share` still receive it; an opted-in publication must match its review hash even with future updates; the share dialog's review (`PublicSessionShare.review`) refuses an opted-in copy over `PublicSession.MAX_BYTES` with `TOO_LARGE`, while local `preview`/export stays uncapped; and the live-update queue withdraws an unconfirmed opted-in attempt rather than completing it in the background. **D23 must invalidate/refetch both V1 and native-history screenshot caches** after deletion. Local pruning does not remove an already published remote copy; unsharing is a separate explicit operation.

The SDK/client generators were run for E13's public surfaces. D4–D6a did not change those inputs.

**D2 and D3: copy and the fake platform**

`packages/app/src/features/computer/main-copy.ts` owns fixed desktop copy without a renderer dependency. English `computer.*` templates inject the shared name, mention and verified target labels. Keep raw model intent and typed secrets out of status copy.

`features/computer/fake-platform.ts` implements the full in-memory `ComputerPlatform`, isolated snapshots, independent permission/recheck/reset sequences and mutation logs. A sequence repeats its last value when exhausted. Reads are not mutation-log entries. Commands record intent; explicit fixture emissions drive authoritative state. `setPrefs` does not silently change the session phase.

The fake is dynamically imported before render only under `import.meta.env.DEV && window.__vectorE2E?.computer`. Do not allow it into production behavior. Browser fixtures still have a web host platform; derive the simulated computer OS from computer state/permissions rather than assuming the host platform identifies it. The desktop renderer tolerates an older preload with no computer API. Ordinary web hides Hands Settings; unsupported desktop can show the unsupported status. The mock capabilities endpoint returns 404 when absent.

D3 pulled forward only Settings registration and a small status panel to make the smoke possible. **D6b replaced that panel:** the Settings page is `packages/app/src/components/settings-v2/computer.tsx`, with its pure model `computer-model.ts` (`ComputerSettings`) and asynchronous controller `computer-controller.ts`; `computer-status.tsx` no longer exists. See deviations D6b.1–13. The real desktop computer backend has not been built.

**D4: approvals are already integrated and tested**

`features/computer/ask-model.ts` validates metadata, strips control/bidi/zero-width characters, and never displays raw machine keys or permission patterns. Saveable approval requires the exact app key, verified identity and eligible category; company and changed-signature restrictions remain. Read-only asks describe observation truthfully. Missing sensitive metadata does not cause invented key names or repositories. Only a verified Apple-anchored macOS identity gets the fixed Apple publisher label.

The Solid dock remounts by request ID. Preserve the keyed `Show` callback's argument and the per-request reply latch through delayed SSE removal. Failed HTTP responses permit retry; stale responses cannot answer the next request. Computer replies use `/permission/{requestID}/reply`; ordinary permission routing retains its existing behavior.

The composer remains available during computer asks and queues ordinary/Plan follow-ups until the ask is answered. Questions and ordinary permission prompts keep their existing visibility behavior. Sensitive confirmation ignores keyboard activation, including native keyboard-generated button clicks; app confirmation follows the armed, focused-dock rules. The TUI uses sanitized titles and request-keyed state without a sensitive Always action.

The actual dock has 16 happy-dom checks using the existing Solid transform and a controlled clock. D4's relevant app/TUI/engine checks and typechecks passed, as did its Linux/Windows browser run. Do not replace behavioral tests with copies of the implementation.

**D5a: the primitives exist, but the popover and send gate do not**

- `features/computer/mention.ts` exports `ComputerMention`. Feature options use the naming constants and carry localization keys. App options preserve opaque identity keys, sanitize bounded names/icons, filter never/blocked apps, expose company-denied reasons, put running apps first and cap the list at eight.
- `context/prompt.tsx` has `ComputerPart`: `{type: "computer", content, start, end, app?: {key, name}}`.
- The actual pill creation/parsing/normalization lives in `components/prompt-input/editor-dom.ts` and has real DOM round-trip tests. Pills are atomic and violet in both composer layouts. Malformed app datasets or editable computer spans become ordinary text, not a feature hint.
- Prompt history clones the nested app identity and compares it correctly. Each pill creates exactly one empty synthetic text marker after the typed text. Marker shapes contain no approval fields. Reserved synthetic IDs and optimistic metadata survive; normal queued dispatch preserves markers through the request builder.
- Six focused files passed 114 tests and the app typecheck passed. Selection UI, readiness checks, destination capability checks and the new browser fixture remain D5b.

**D6a: use the existing onboarding controller and opener**

`features/computer/onboarding-model.ts` exports `ComputerOnboarding`; `onboarding-controller.ts` owns asynchronous behavior; `onboarding.tsx` renders the wizard and exports **`showComputerOnboarding(dialog, {computer, onTry?, onFinished?})`**.

The contract had conflicting wording about consent and enabling. The committed resolution is deliberate: the first explicit action records `consentedAt`; **only Finish enables Hands**, after a fresh permission probe and current policy check. Do not revert to enabling on the first step.

Consent must be a valid positive safe timestamp. macOS requires exactly the expected unique permission rows, granted, and a healthy helper. Windows requires the explicit clean status flags, no grant rows and a healthy helper. Missing, duplicated, contradictory or ambiguous status cannot enable Hands. A main-app grant is a warning, never automatically changed. Reset is offered only when supported and only acts after the user's click. The Preview row is macOS/ad-hoc only.

The controller serializes/coalesces requests and mutations. Finish waits for older polls, performs a new probe, then rereads prefs, policy and state. It honors company/locked gates. Polling is every two seconds, plus focus and explicit recheck. The opener disposes the controller at **close-start**, before the dialog's exit animation; directly mounting the component can miss that lifecycle protection.

Try-it examples insert without sending. Finish enables only after validation, then calls the optional insertion callback, which may return a boolean or promise. Rejected insertion preserves the existing draft/selected example and reports the problem. Settings currently uses `requestComposerPrompt({text, send: false})`; it can decline when a destination or empty draft is unavailable. Keep that behavior when D5b adds pill-aware insertion.

D6a passed 10 model tests, 13 controller tests, English dictionary checks, app typecheck and browser-fixture typecheck. Its eight new browser scenarios plus seven earlier Hands scenarios passed on both operating systems.

**Validation evidence and what remains unresolved**

| Evidence | Commit / run | Result |
|---|---|---|
| Latest focused Hands browser checks | `3bb67725`, [40816142340](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40816142340) | All 15 scenarios passed on Linux and Windows |
| Latest completed full CI | `a227c869`, [40813327379](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40813327379) | Two Windows jobs failed; details below |
| D4 focused browser checks | `2772e1f1`, [40812108743](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40812108743) | All seven then-existing scenarios passed on both OSes |
| D4 production benchmark | `2772e1f1`, [40812112827](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40812112827) | 12 successful measurements; no production fake markers |
| Production baseline | `58a904d7`, [40808896303](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40808896303) | 12 successful measurements |
| Public-sharing integration | `8e1d52bc`, [40803252203](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40803252203) | Passed with real PostgreSQL/Valkey and hosted API typecheck |

The full run predates D5a, D6a and the last V2 fixture correction. It passed all Linux jobs, all four Linux engine shards, Windows engine shards 1–5, both browser suites and the Node utility-process bundle. The HTTP API inventory covered 305 scenarios in each of three modes, with no failures or inventory mismatches. Do not describe this as full green CI because of these two failures:

1. **Windows unit job `123248533002`:** `packages/core/test/util/windows-powershell.test.ts`, “pwsh to Bun to Windows PowerShell loads native certificate and installer commands”, exceeded its bounded native deadline. Diagnostics showed certificate/archive commands loaded and hashing progressed before watchdog termination. The child imports Node utilities and the direct Windows PowerShell helper, not Hands or SQLite. This file was unchanged by Hands. It is an **unconfirmed timing failure**, not an established flake. Preserve its deadline and assertions. A fresh run or one failed-job retry can distinguish transient runner timing from a reproducible issue. **Later:** it passed in fresh full CI (Windows unit job `123880822522` of run 40999656844 at `d1c04c5d`); the earlier timeout was not reproduced and its cause is not established.
2. **Windows engine shard 6, job `123248533096`:** `packages/engine/test/local-mode/local-run.test.ts`, “refuses a V2 runner turn on a model off in Vector Local before a route is built, and picks none”, unexpectedly resolved the free `vector/north` model. A configuration watcher could replace its in-memory policy with the off-on-disk policy. **Fixed in `49155228`:** the refusal/automatic-selection phase now uses the existing persisted `withLocal` fixture. The initial Local-off assertion and zero-outbound guard remain. The focused case passed all six assertions, and engine typecheck passed. **Fresh Windows/full CI has not run after this correction.**

An older Windows screenshot-prune cleanup failure is separately resolved. Commit `a227c869` gives the Bun SQLite adapter ownership of a bounded prepared-statement cache, finalizes evictions/remaining statements, then closes the connection. The original adapter reproducibly failed strict close after enough statements; the fix passes all three regressions. Both OS unit jobs passed those regressions, and Windows engine shard 1 passed all five pruning cases with immediate strict directory cleanup. Do not reintroduce sleeps, ignored cleanup errors or ineffective filesystem retries. The desktop Node database adapter was unchanged.

**Production performance evidence**

Committed artifacts are in `docs/benchmarks/vector-hands-1.99.112/`: `baseline-manifest.json`, `baseline-metrics.json`, `d4-manifest.json`, `d4-metrics.json` and `d4-comparison.json`. Both successful runs used Node 24.15.0, Bun 1.3.14, Playwright 1.59.1, production builds, one worker, three repeats, history 80, 40 streaming deltas and CPU throttle 4.

The hosted CPU changed from AMD EPYC 9V45 to 9V74. Navigation first/stable medians in milliseconds were task 105.2/117.7 → 107.9/127.9; new session 95.9/170.4 → 124.0/191.4; child session 62.4/115.7 → 84.3/136.7. Streaming initial/completion medians were 530.3/10319.6 → 528.1/10128.8. Blank/unknown samples were zero; rows/markdown were not replaced; all 40 deltas arrived with none pending. The production scan found no fake-platform markers in 843 JavaScript files.

These are observations, not proof of a causal performance improvement or regression. Use the committed manifests/raw data and collect comparable evidence around later session/timeline changes. An earlier incomplete child-navigation baseline was corrected to use the current task-chip control; the linked successful baseline is the usable one.

## 4. What you have to do

**Start from the actual checkpoint**

1. Read the contract, deviations, progress and relevant `AGENTS.md` files. Inspect `git status`, branch and current history. Confirm you have the latest pushed `hands` and the `49155228` fixture correction.
2. Inspect any currently running GitHub workflows before dispatching more. Obtain fresh full CI for the latest code, including the V2 fixture fix. Investigate the remaining Windows native-command timeout without weakening the test. Do not rerun the same already-passing local checks merely to repeat prior evidence.
3. Implement **D5b** next. The notes below are research, not existing code. Establish the required production baseline before changing session code, then compare after the change using GitHub CI.
4. Continue the exact remaining order. Do not start later work packages in parallel or silently pull in their implementation. Parallel read-only review or tightly bounded work within the current package is fine if it cannot violate the resource rules or conflict with edits.

**The remaining 50 work packages, in order**

| Phase | Work packages |
|---|---|
| App UI | **D5b**, D6b, D7, D8, D9, D10, D11, D12 |
| Desktop | C1, D13, D14, D15, D16, D17, D18, D19, D20, D21, D22, D23 |
| Helper bases | M1, M10, C2, C6, W1 |
| macOS helper | M6, M2, M3, M4, M5, M7, M8, M9, M11 |
| Windows helper | W2, W6, W7, W3, W4, W5, W8, W9, W11 |
| CI and release | C3, C4, C5, W10, C7, C8, C9 |

D5 and D6 are split labels, not additional packages. The order is intentional: for example, C1 precedes the desktop fake-helper consumers, M6 precedes capture/input, and W6/W7 precede Windows capture/input.

**D5b: detailed starting notes**

Read the D5b entry, Sections 2.5 and 2.9, D5a implementation, the actual composer submit paths and D6a's opener before editing.

- Extend `components/prompt-input/slash-popover.tsx` with computer/app rows. Resolve `ComputerMention` description and disabled-reason localization keys to actual display text. Support `display` and `search`; rank the computer group after agents. Disabled company rows must reject both pointer and keyboard selection.
- In `components/prompt-input.tsx`, add supported-platform feature options and a 150 ms debounced `platform.computer.apps(query)` lookup. Preserve identity keys, bounded icons and sanitized names. Never/blocked apps remain hidden; company-denied apps remain disabled. Handle stale lookup results and component disposal normally.
- Selecting an option adds a real `ComputerPart`. If setup is incomplete, open onboarding with `showComputerOnboarding`, preserving the draft. Do not interpret selecting a pill as permission or silently send a Try-it example.
- D5b expects a `hands` glyph, although the full icon package is D6b. If needed, pull forward only the glyph in `packages/ui/src/components/icon.tsx` and document the dependency correction. That was a proposed solution, not a completed change. Do not implement all of D6b early.
- Before clearing a draft, creating a conversation, queuing or sending a computer-marked message, validate the relevant local readiness: supported platform, consent, enabled state, required permissions/helper health and company policy. Missing setup gets the localized setup toast with its Set up action. Preserve the draft on rejection.
- Probe the **actual destination engine** through the existing experimental capabilities API. Require `computer.available` and the matching `Computer.PROTOCOL` where represented. A missing capability, unavailable result, old engine or 404 is unavailable, not implicit support. Follow the existing unavailable-feature handling style.
- Revalidate at **actual queued dispatch**, not only when a draft enters the queue. The current `FollowupSendInput` has no computer context. Both `createPromptSubmit` and the `sendFollowupDraft` caller in `pages/session.tsx` need consideration. An optional platform/context field or a focused validation helper was only a proposal; choose the smallest sound interface after reading the current code.
- Shell and custom slash-command submissions bypass the normal request-builder path. The custom command protocol accepts files, not arbitrary computer markers. Do not silently drop pills. Prefer rejecting an unsupported combination with a localized explanation before clearing the draft; any intentional protocol extension needs its proper generators and tests.
- Undo/fork restoration in `utils/prompt.ts` currently ignores synthetic markers. Restore computer pills only from schema-valid explicit markers paired with exact canonical visible mention text in otherwise unclaimed text spans. Respect existing file/agent pills and offsets; do not let multiple markers claim the same span. With no exact visible match, retain plain text and omit the pill. Do not infer identities from arbitrary `@` text or add undocumented marker fields.
- Dictation's append path currently flattens non-image pills. Preserve existing pills, offsets, images and nested app identities when appending transcription. A tested pure append helper may be appropriate; it does not exist yet.
- Onboarding examples must preserve any existing draft and never autosend. Where D5b inserts a computer mention, use the actual pill/marker path so visible text and sent intent agree.

Add the required `hands-mention.spec.ts` browser fixture: @han finds Hands; @Num finds Numbers with its icon; Terminal is absent; company-denied apps cannot be selected; the intercepted POST contains exactly the documented marker shape; missing setup shows Set up. Add focused regression coverage for the actual send/queue/restore paths you change. Execute browser tests only in GitHub CI. Typecheck app, browser fixtures and UI if touched.

**Later package obligations that are easy to miss**

- D6b (done; see progress for its CI) replaced the temporary Settings status panel with the complete page/model, controls, company locks, always/blocked lists, retention and delete confirmation, kept search ordering and the keyboard/terminal search results, and syncs the reduced-motion preference through a root mirror. D15/D22 must accept its `block({key, name})` and `setPrefs({unblocked})` writes (deviations D6b.1 and D6b.8).
- D7 (done; see progress for its evidence and deviations D7.1–10) owns the screenshot opt-in UI and public-viewer image rendering described above. Automatic shares never inherit a manual opt-in. The viewer's full-snapshot revocation poll needs a conditional share read before the site ships screenshot sharing (C9 owner step; see the D7 open risks).
- D8/D9 must use Vector-built status labels, not model intent, and preserve stable timeline rows. Collect production comparisons for timeline/session changes. Keep notification de-duplication limited to the documented computer events when the desktop platform owns those notifications.
- C1/helper category generation must preserve the distinction between permanently protected system tools and user-removable default-blocked system apps. Disk Utility, Find My and Migration Assistant cannot accidentally become permanent never entries merely because their identities are system binaries. The helper must still enforce the documented never floor and preserve escaped opaque app identities.
- D13/D19 cancellation without a lease removes only the authenticated queued root, never an active holder. An acquire request that disconnects must clean up any undelivered lease.
- D16/D19/native helpers must enforce observed ask/reply IDs, exact sensitive `stepDigest`, live target/frame ownership, cancellation and pixel-scroll units consistently. Resolve canonical launch paths; `act.allowedApps` can only restrict access. Consume proofs once. A schema field or an engine test is not proof that the desktop/helper enforcement exists.
- D18/D20 must release held input on stop, cancellation, lock and process failure, and handle physical user takeover. The real overlay and stop controls remain necessary even when mocked journey tests pass.
- D21/D22 must satisfy the onboarding API already consumed by the app. Probe actions are separate from user-requested permission actions. Do not replace strict ambiguous-status rejection with optimistic enabling.
- D23 needs both legacy and native history invalidation, retention scheduling and explicit delete-all behavior while preserving E13's tombstones.
- M/W helper self-tests and C6 CI distinguish genuine success from unavailable privileged environments using the contract's skip behavior, including exit 77 where specified. Never turn a skipped privileged scenario into a claimed pass.
- C3–C9 still own real native packaging, signing, verification, smoke lanes, documentation and release wiring. Existing optional Hands UI/benchmark dispatches do **not** mean the native-helper C6 package is complete. C6 must preserve pinned Actions, bounded jobs, shipping-only tarballs and the contract's prohibition on cached helper binaries. Its proposed `ci/computer-*` validation push conflicts with the owner's explicit ban on new remote branches: implement/test the required trigger, validate through `workflow_dispatch` on `hands` or an equivalent existing-branch route, and record that correction. Do not create the extra branch. C9 legal changes remain drafts until owner sign-off.

**For every work package**

1. Read its contract entry, the shared interfaces it uses, invariants it owns, deviations and actual code.
2. Implement that package and meaningful tests of its behavior. Keep interface changes minimal and recorded.
3. Run applicable individual test files, one at a time, from their package directories; then each touched package's typecheck, serially. Keep CI-only checks in CI.
4. Record any necessary intent-preserving contract correction in `hands-deviations.md`, committed with the work it explains. Keep `hands-progress.md` useful for the next computer/session.
5. Commit as `feat(hands): <id> <short title>` using the required author, then push `origin hands`. Do not claim a package's CI-only done criteria passed before the workflow result exists.

After each phase, review the commits from two angles: contract/tests, and safety/portability. Fix real findings as `fix(hands): <phase> review`, push, and run full CI. Read the failures and fix branch-caused regressions. The initial baseline at `42346154` was described as green apart from a Linux Bun segfault and certain Windows local-fit timing flakes. That history does not establish that a newly observed failure is a flake.

**Existing GitHub workflow entry points**

```sh
# Full CI
gh workflow run test.yml -R scr1pter/claudeondfsfdaf --ref hands

# Focused Linux/Windows Hands browser fixtures
gh workflow run test.yml -R scr1pter/claudeondfsfdaf --ref hands -f hands_ui=true

# Serial production benchmark and development-fixture exclusion check
gh workflow run test.yml -R scr1pter/claudeondfsfdaf --ref hands -f hands_benchmark=true
```

Full, UI and benchmark lanes have separate concurrency groups. A new full run on `hands` can cancel an older full run, so inspect active runs first. Focused UI uses `hands-*.spec.ts` with one worker on each OS. Normal full-CI coverage was preserved when these dispatch inputs were added. Save relevant artifact evidence with commit/runtime/workload provenance; workflow links alone are insufficient for a future performance comparison.

**When the build is done**

Report implemented packages, exact validation, remaining CI-only/manual checks and any unresolved failures. Distinguish mocked behavior, native self-tests, packaged-app smokes and actual owner device checks. Do not announce a released or fully working Hands feature merely because all source files exist.

Report the open owner decisions in Section 1.9 and release steps in Section 7.3:

- **O1:** recommended macOS ad-hoc gate is dev/beta Preview until Developer ID signing and notarization; stable follows signing. Windows unsigned-helper warnings are a separate release concern.
- **O2:** formal name approval and trademark search. Keep the shared name constant and fixed bundle/executable identities.
- **O3:** recommended macOS default is Alongside me where supported, with Ask me first for pointer use.
- **O4:** confirm the 30-minute away default and company maximum behavior.
- **O5:** confirm off until onboarding, keep-awake on, screenshots retained seven days, notifications on, specified default-blocked apps and 300-action/45-active-minute check-ins.

Owner release work includes Developer ID enrollment/signing configuration through the approved workflow; first signed beta and grant persistence on the next beta; the documented later release-policy/identity-lock changes; ad-hoc grant/reset checks on the supported macOS versions before setting reset verification; Windows Trusted Signing and unsigned distribution checks; display names/icon/docs/release-note approval; and the Codium gateway image-support deployment before desktop release. Until that gateway support exists, affected models use screen-reader mode.

Manual clean-device checks include all-display/fullscreen/Spaces visibility, notch placement, capture exclusion, Stop and Take over, engine/helper exit cleanup, the helper's own OS permission entry, update grant persistence, Windows elevated/UAC handoff, AZERTY input and an iOS Simulator flow. Perform them only in the intended owner-approved manual setting when the computer is available; automated tests must not manipulate the real device. Describe prompt-injection and protected-target checks as requirements that must hold, as the contract does.

Continue ordinary implementation without repeatedly asking about decisions that matter only at release. Prepare concrete evidence and report the unresolved owner steps at the appropriate gate.

## 5. Rules (non-negotiable)

**Git and continuity**

- Work only on `hands`. Never push or merge into `main`. Never create another remote branch for this work. Contract wording about packages being “merged” means integrated on this working branch, not permission to merge to main.
- Push each finished package so another computer can resume. The owner already authorized continuing the build and pushing this branch; the contract's general push-approval note does not require asking again for each package.
- Never use `git stash`, `git reset --hard` or `--no-verify`. Preserve unrelated changes and other worktrees. Do not disable hooks.
- Commit with `git -c user.name=Vector -c user.email=bot@vectordev.ai commit ...`.
- The original handoff says the pre-push hook runs full typechecking. The managed clone was installed with `--ignore-scripts` and had no configured hooks path. A successful push here is **not evidence of full typechecking**. Honor installed hooks, keep explicit package checks, and use CI for full validation. Do not bypass a hook to resolve a resource conflict; report an actual blocker with the applicable instruction.
- Keep durable notes and evidence in the branch. Do not leave the next agent dependent on private chat memory, a local-only patch, a terminal session or temporary downloaded CI artifacts.

**Keep the computer light**

The owner may be using Vector on the same machine. Heavy local runs have caused problems before. These limits apply even if a cloud machine appears capable of more:

- Run **one Bun process at a time**. Coordinate this across all agents.
- Run only individual test files, normally `bun test --timeout 30000 <file>` from the relevant package directory. Never run tests from the repository root.
- Run per-package `bun typecheck`, serially. Browser fixture typechecking uses `bun typecheck:e2e` in `packages/app`. Do not invoke `tsc` directly.
- Never run local Turbo, whole suites, Playwright, Electron or multiple concurrent Bun processes. Full suites and browser execution belong in GitHub CI.
- Inspect tests for nested Bun processes before running them. A single test file can still violate the rule. CLI-help, migration-generation and subprocess fixtures stay in CI when they would spawn overlapping Bun processes.
- Do not start/restart the running app or server to test Hands. The app instructions explicitly forbid restarts. Use focused model/component tests and CI fixtures.
- Compiling the Swift helper and running its own self-tests with `swiftc` is allowed on a Mac. Windows-native builds/tests run on Windows CI; say clearly when they were not executed locally. This checkpoint was produced without starting the real desktop or using real OS input.

**Never operate the owner's computer in automated tests**

Local tests use the fake platform and fake helper defined by the contract. Never grant, request, reset or change real OS privacy permissions from tests. Never drive the owner's real mouse/keyboard, capture their screen, modify personal settings or interact with a real credential prompt.

The native-helper contract also requires checks against controlled TestTarget apps in isolated CI/VM environments. Those checks may exercise the intended native capture/input APIs only within that test environment, with any required grants already provisioned outside the test. They must not request or change grants or run against the owner's active desktop. Missing permissions or an interactive desktop produce the specified skip result, including exit 77 where required; skips are reported separately from passes. This exception covers the contract's isolated native fixtures, not general automation of a user's computer. Manual owner checks remain separate.

**Code, generated files and content**

- Engine runtime is Node-compatible. A general root preference for Bun APIs does not override the utility-process runtime requirement. Existing Bun-specific adapters and build/test code are distinct from the engine runtime path.
- Keep dependency direction, Effect lifecycle and schema conventions from `AGENTS.md`. Do not add import aliases or star imports. Prefer existing exported namespaces and package typecheck scripts.
- In Solid, prefer `createStore` to a collection of independent signals, and preserve stable keyed UI ownership. Keep heavyweight/optional imports lazy where the repository does.
- Run required generators when their inputs change, one at a time: `./packages/sdk/js/script/build.ts`; `bun run generate` from `packages/client`; and `packages/engine/script/schema.ts` as appropriate to its inputs. Follow their package instructions, and do not hand-edit generated client directories.
- Never read credential files or put the owner's personal email in the repository. Never name the open-source project Vector was originally forked from in new code, docs, messages or release copy.
- Do not weaken tests, relax meaningful deadlines, swallow errors or label failures flakes without evidence. Fix the behavior or a demonstrated fixture defect while retaining the assertion's intent.
- Preserve the public interfaces in Section 2. Make the smallest necessary correction when the actual code proves the contract wrong, and record why in deviations. Planning suggestions in this handoff do not authorize unrelated redesigns.

**Other concurrent work**

Other sessions have worked on `self-evolving`, `codium` and `vector-at-mention`. Leave those branches/worktrees alone. Integration conflicts are handled later; do not merge their work into Hands speculatively.

**Effort and delegation**

The owner's stated preference for Claude is **Opus at xhigh effort, not max**. Use bounded delegation when it saves time or improves review quality, but keep one work package active and one Bun process running at most. Give delegates explicit file ownership and resource limits. Do not duplicate broad repository exploration or repeat passing suites without a new reason.

Proceed from D5b, maintain a clear checkpoint after each package, and carry the authorized implementation through the remaining order while accurately reporting CI and owner-release boundaries.
