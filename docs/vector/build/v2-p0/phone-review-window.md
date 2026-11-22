# phone-review-window: CW-23b-30s-window

Branch `phone-review-window`, cut from origin/main `609763f7`. It covers one Vector v2 leftover P0 item: a review a phone starts was cancelled after 30 s if its own question was not answered by then. No flag changes. `VECTOR_REMOTE_ENABLED` and `VECTOR_EXPERIMENTAL_CONNECT` stay off.

The dated entry lives here so that parallel PRs do not conflict. Fold it into `connected-workspace-deviations.md` (line numbers at `609763f7`):

- It closes the Known limits "The shared 30 s request window" (:1735) and "The shared 30 s window remains" (:1858).
- :1831 quotes the old `REMOTE_REVIEW_TIMEOUT` text, which is now "Your computer did not answer within 3 minutes. …".
- :1737 and :1797 say "up to the 30 s window" about how long a start can wait. That is now up to 3 minutes. The reasoning there is unchanged.

`connected-workspace-spec.md` and `connected-workspace-handoff.md` do not cite the window. `connected-workspace-release.md:67`, the cloud-workspaces supervisor's 20 s engine window, is the same problem in another place. It stays a separate item.

## 2026-11-22, CW-23b a phone's review start gets its own window

**What was wrong.** Every Remote request had one 30 s window: the desktop's `AbortSignal.timeout(30_000)` (remote-runtime.ts:157) and the phone's `REQUEST_MS` (client.ts:226). The engine answers a background review start only once the review's own `connect` or `connect_model` question has been answered. So a phone start worked only if a person answered that question, on the desktop or from the phone with a passkey, within 30 s of tapping Start. Otherwise the desktop dropped the request, `withRequestAbort` (engine handlers/connect.ts:14) cancelled the review, and the phone showed `REMOTE_REVIEW_TIMEOUT`. That failed closed, but in practice it was too short.

**Lead ruling.** Only the phone-started review-start request gets the longer, stated window that the plan proposes. Every other Remote request keeps 30 s. Flags stay off. Remote's outside security review is still pending, and this change is part of what it should look at.

**The fix.**

- Desktop. `EngineRequest` has an optional `timeoutMs` (remote-routes.ts:34). It is read by `engineRequest` alone and never sent to the engine: the URL is built from the path and query, and the body from `body`. The new constant `REVIEW_START_MS = 3 * 60_000` (remote-routes.ts:46) is set only on `startReview`'s POST `/experimental/session/:sessionID/connect` (:369). The generic tail and every other connect route are unchanged. `engineRequest` uses `AbortSignal.timeout(request.timeoutMs ?? 30_000)` (remote-runtime.ts:157).
- Phone. `request()` takes an optional window (client.ts:873), which defaults to `timing.requestMs`. The new `timing.reviewStartMs` defaults to `PHONE_REVIEW_START_MS = 3 * 60_000 + 15_000` (client.ts:239). The extra 15 s covers the relay both ways and the computer's own checks, so the phone never gives up on a start the computer is still waiting on. `startReview` passes it (:1090). The public `remote.request` keeps its two-argument form (:1051), so no other caller can choose a longer window. The `REMOTE_REVIEW_TIMEOUT` mapping stays; its comment and message now name the 3 minutes.

**Why 3 minutes.** The plan offered 5 minutes, or 2 to 3 minutes aligned with `APPROVAL_TTL_MS`. I chose 3 minutes for these reasons:

- It covers one full 2-minute passkey challenge (`APPROVAL_TTL_MS`, remote-passkey.ts:10) for the review's question, plus a minute for the question to appear and be seen.
- It stays under the 300 s default `headersTimeout` of Node's fetch (undici's `lib/dispatcher/client.js:261`, `300e3`, read in the 7.26.0 copy in node_modules; Node's bundled undici has the same default). The desktop's main process uses that fetch to reach the engine. With 5 minutes, undici's timer and ours would race at the same moment, and the stated window would not be the real one.
- A shorter window keeps the HTTP request and the conversation's hold open for less time on a surface whose security review is still pending.

The engine sets no limit of its own on a phone review's question: a phone cannot send a budget. The relay holds no per-request slot, and its idle limit for viewers is 30 minutes. The desktop engine is the Node sidecar. Its `node:http` server sets no response timeout: Node's `requestTimeout` covers only receiving the request.

**Tests** (each file run alone, `--timeout 30000`).

- remote-routes.test.ts:
  - :677 "a review start needs a passkey check …" now also expects `timeoutMs: REVIEW_START_MS` on the start.
  - New :719 "only a review start waits longer than 30 s …". It runs eleven other routes (project, sessions, messages, prompt, abort, permission reject, question reply, connect members, runs, run read, cancel) and one permission allowed once with a passkey, plus the capability and permission reads the computer makes for them. It asserts that the start is the only engine call with a window. It also checks that `REVIEW_START_MS` is above 30 s and below 300 s.
- remote-phone-app.test.ts (the phone's real client against the desktop's real link, through the in-memory relay):
  - New :569 "a review start may wait past the plain request window, which every other request keeps". It uses `requestMs: 1_500` and `reviewStartMs: 10_000`. The phone answers the review's question 2 s after it appears, which is past the plain window, and the start still succeeds. The desktop gave the start, and only the start, `timeoutMs: REVIEW_START_MS`. A plain runs read held 2 s by the fake engine still ends at the plain window with `REMOTE_TIMEOUT`. The test also checks `PHONE_REVIEW_START_MS > REVIEW_START_MS`.
  - :611, renamed "… says so, and the conversation stays held". It now uses `reviewStartMs: 2_500` and expects the new message. After the timeout, it checks that the question still waits for a person and that `isPhoneTurn(["ses_1"])` is still true (fail-closed).
  - :406 and :516 expect `timeoutMs: REVIEW_START_MS` on the start.
  - Test fixtures: `phone()` takes `reviewStartMs`, which defaults to 6 s at test scale. The fake engine has a `slow` map (path to delay). The fake start's wait for its question is now bounded at 20 s instead of `until`'s default 3 s. The real engine sets no bound there, and the new case waits longer than 3 s. No test deadline or `--timeout` changed.
- The plan suggested client.test.ts. It was not extended, because its harness has no open channel to a paired computer. The per-call window is tested end to end with the real client, in remote-phone-app.test.ts.
- The desktop's `AbortSignal` is not exercised by a test: remote-runtime.ts imports Electron, and no test drives `engineRequest`. The change there is one expression.

**Evidence.**

- Red-before, sources only (remote-routes.ts, remote-runtime.ts and client.ts from origin/main, tests unchanged): both files fail to load, with `SyntaxError: Export named 'REVIEW_START_MS'` (and `'PHONE_REVIEW_START_MS'`) `not found`.
- Red-before, behaviour only (the constants kept, but no `timeoutMs` on the start, the runtime at 30 s, and the phone's start on `requestMs`):
  - remote-routes.test.ts gave 30 pass and 2 fail (:677 and :719).
  - remote-phone-app.test.ts gave 18 pass and 3 fail. :569 failed with `REMOTE_REVIEW_TIMEOUT` at 1.5 s, which is the bug itself. :406 and :516 also failed.
  - The fixed files were restored, and `sha256sum -c` was OK for all three.
- Green: remote-routes 32/32 (583 expect calls), remote-phone-app 21/21 (130), remote-routes-combined 13/13 (1063), remote-link 33/33 (199), app phone/remote/client.test.ts 12/12 (80). `bun typecheck` exited 0 in packages/desktop and packages/app.
- After those runs, `REVIEW_START_MS` was moved below the answer types in remote-routes.ts. Only its position changed. remote-routes 32/32, remote-phone-app 21/21 and the desktop typecheck were run again and passed.
- Mutation M1: the phone's default window was set to `timing.reviewStartMs`, so every request waited longer. :569 went red, because the plain runs read resolved instead of timing out. Restored, sha256 OK.
- Mutation M2: `timeoutMs: REVIEW_START_MS` was added to the generic route tail. Five remote-routes cases went red, :719 among them. Restored, sha256 OK.
- Mutation M3: `PHONE_REVIEW_START_MS` was set equal to the desktop's window. :569 went red. Restored, sha256 OK.

**Risks.**

1. Remote is security-sensitive, and its outside security review is still pending. A phone start can now keep one loopback HTTP request open, and the conversation held, for up to 3 minutes instead of 30 s. Holding longer is fail-safe: it only leaves more questions to a person. When the window ends, the start fails closed as before: the request is dropped, the engine cancels the waiting review, and the hold stays until the next idle.
2. The value is a product choice. The lead may prefer another value inside the plan's range. If it changes, change both constants together, and keep the desktop's under 300 s, or the fetch's own `headersTimeout` decides instead.
3. Q6 is still open. If review starts move to VectorScope's route, `timeoutMs` moves with the `startReview` entry.
4. The phone shows the 3 minutes in its message text. A future change to `REVIEW_START_MS` must update that text too.
5. remote-routes-combined.test.ts still passes. It checks the allowlist against openapi.json, and `timeoutMs` never reaches the engine.

**Safe by default.** No flag defaults changed. Remote and connected tools stay off unless the owner turns them on. With connect off, the engine reports `connections: false`, so the desktop refuses every review start with 403 `REMOTE_CONNECT_OFF` before the new window applies.
