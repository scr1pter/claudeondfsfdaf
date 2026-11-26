# phone-review-hold takeover: detached phone reviews stay manually approved (#110)

Branch `phone-review-hold` (PR #110), finished on the local branch `cx-phone-review-hold`. The draft had been idle for more than a day, so this v2 run took it over to finish and merge it as part of the v2 P0 list. No flag changes: Remote, `VECTOR_EXPERIMENTAL_CONNECT` and every other v2 switch stay off. No public claims.

Fold into `connected-workspace-deviations.md` later. This closes the CN-17 Known limit "Asks after detach are not held (for CN-18)" and the open item that repeats it in the CN-18 notes ("The hold for a detached run's later questions").

## 2026-11-25, a phone-started review's later asks could be auto-accepted after it detached

**Bug.** When a phone started a background VectorScope review, the desktop held the conversation only until its next idle. `owner.ts` sets the conversation idle right after a background start returns. The run's later `connect` and `connect_model` asks go to the requester's session, and after that idle they were treated as asks from a review started at the desktop, so the app's auto-accept could answer them without a person.

**Fix (Codex's commits on the branch, kept as written).**

- Desktop `remote-routes.ts`. `createRemoteTurns` takes the engine request function. `startReview` registers the start (sessionID and directory) before it asks the engine. When the engine answers with a background `vectorscope` review run for the same session, directory and target, the hold moves to that exact run (runID, sessionID, directory), and the start's temporary session mark is released. If the engine never names a run (refused, failed or lost answer), the old session hold stays until the next idle. A hold ends on terminal evidence only: a `connect.run.updated` with `status: "done"` for the same run, session and directory; a scoped `GET /experimental/connect/runs/:runID` that answers done, or 400 `not_found`; or a successful scoped cancel from the phone. The scoped read runs right after the start, after `server.connected` (an engine stream reconnect) and after the session's deletion. A generic failure keeps the hold. At most 64 starts and runs are held; past that a new phone start gets 429 `REMOTE_REVIEW_BUSY`.
- Desktop `remote-link.ts`, `ipc.ts` and preload. `isPhoneTurn(sessionIDs, review?)` passes the ask's review identity through. `turns.size` counts review holds, so the event stream stays open while one is held. `stop()` clears them, as a stopped link already answers false for every phone turn.
- App `permission.tsx` and `platform.tsx`. Before auto-accept answers a `connect` or `connect_model` ask that carries `metadata.runID` (the hub always sets it), the app sends `{ runID, sessionID, directory }` with the phone-turn check.

**Added in the takeover.** The app side had no test. The identity is now built by `phoneReviewAsk` in `permission-auto-respond.ts`, which `permission.tsx` calls, and is covered by two cases.

**Lead ruling.** None was needed. The design keeps the safe side for every unknown: an unidentified start keeps the session hold, a generic read failure keeps the run hold, and `connect_write` and `connect_cloud` still always ask (`CONNECT_ALWAYS`).

**Tests.**

- desktop `src/main/remote-phone-app.test.ts`, "a detached phone review keeps only its own asks held until completion / cancellation / reconnect (CW-23c)". Over the real signed Remote path, it checks that ordinary asks on the session are free once the start is answered and the session goes idle, while the review's own ask stays held. Asks from another directory, run or session are not held, and malformed or foreign `connect.run.updated` events release nothing. Each of the three endings releases the hold.
- app `src/context/permission-auto-respond.test.ts`, "detached phone review asks": `phoneReviewAsk` names the run, session and directory for `connect` and `connect_model` and nothing for other asks, a missing directory or a missing or non-string runID. The provider sends that identity with its phone-turn check.
- app `e2e/regression/remote-phone.spec.ts`, "a paired phone starts and cancels a connected branch review": the run is held after the start and released by the phone's cancel. It runs in CI (`e2e (linux)` and `e2e (windows)`), and both passed on the draft's last commit.

**Red before.** With `remote-routes.ts` and `remote-link.ts` reverted to origin/main, all three desktop cases fail (0 pass, 3 fail). With `permission.tsx` and `permission-auto-respond.ts` reverted, the app file fails to load. With only `permission.tsx` reverted, the provider case fails (22 pass, 1 fail). Restored, all pass.

**Mutation check.** With the release condition in the scoped read loosened to any 200 answer for the run (the `status === "done"` check dropped), the three desktop cases fail. Restored, they pass.

**Runs (one file at a time).** desktop `remote-phone-app.test.ts` 25 pass, `remote-routes.test.ts` 34, `remote-routes-combined.test.ts` 13, `remote-link.test.ts` 33. app `permission-auto-respond.test.ts` 23, `remote-turn-alerts.test.ts` 6. `bun typecheck` passes in app and desktop.

**CI on the draft's last commit.** Three jobs failed, none in code this PR touches. `engine (windows, shard 2/18)` timed out in `task isolation saves` (engine task isolation). `computer-helper / windows-build` and `computer-helper / mac-build` failed in the native helper build (the mac job ran for more than 5 hours). Everything else passed, including both e2e lanes and the unit lanes.
