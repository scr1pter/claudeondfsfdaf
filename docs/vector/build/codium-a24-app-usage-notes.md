# A24: app usage surfaces and Settings → Usage

Implements label plan C6/C7 after A23. This is feature-branch implementation, with no production deployment, model acceptance, account changes or release authorization. The required production baseline ran before app edits on `ad187830`; its complete metrics and raw artifact digest are recorded in [the benchmark notes](codium-a24-benchmark-notes.md).

## Behavior

- Session pills, tooltips, Context, working status, task cards, agents, research caps, document-distillation labels and live review progress use `Codium` instead of Codium token or dollar quantities. Mixed work preserves own-key dollars and tokens with `+ Codium`. Unknown own-key prices stay unknown. Operational step limits and context occupancy percentages remain visible; a latest Codium model's numeric context limit and raw context-token quantities do not.
- Codium never enters model cost recommendations. Previously saved Codium outcomes are excluded from recommendation selection and their financial figures are masked in the Context comparison. Raw per-message context remains available internally for occupancy and compaction.
- Settings → Usage shows rounded used/left shares whose sum is 100, with `aria-valuenow` representing the share left. Daily and perk meters appear only when the server lists them; unavailable listed balances are explicit. The page includes plan/renewal, payment and empty/low notices, Velocity's coming message, forecast, freshness, Refresh and billing actions. Purchased-credit/top-up rows are absent.
- Refresh occurs on open, account changes, explicit Refresh, focus at most once a minute, and the shared Codium notifier. Existing session events detect a Codium turn ending once; while Usage is open, the card waits 15 seconds before notifying all Codium screens. Closing Usage cancels that delayed read. No background polling or additional eager child/transcript reads were added.
- The optional 80% alert defaults off. It evaluates successful status reads while Usage is open, and is de-duplicated by account, plan and renewal for the app lifetime. It does not promise a closed-page notification or durable cross-restart deduplication; the contract specifies neither.
- Home, summaries, day activity and helpers keep Codium activity labels. The API exposes no favorite Codium model attribution, so the fallback row says `Vector Codium` without inventing a model. Own average tokens divide by completed chats that actually had own model tokens; Codium-only chats no longer dilute that average.

## Compatibility and review

Modern separated aggregates retain own figures. Older engines cannot partition mixed tokens. Known legacy Codium in the session model, loaded messages or already-loaded children masks inseparable token totals while preserving recorded own dollars. The usage summary recognizes legacy Codium rankings, preserves activity and own dollar totals, hides inseparable aggregate/day/helper tokens, and explains the older-server limitation. It does not invent daily/helper Codium attribution or backfill storage. Unknown private children remain undiscovered until the existing lazy breakdown read; no new eager fetch was added merely for legacy metadata.

Independent static review found and closed three concrete leaks: failed-review progress could overwrite the safe live tracker with raw usage; a legacy task observation could overwrite an already-filtered card; and legacy helper tokens could reappear in the delegated remainder/main total. Regressions now cover all three. The review consumer preserves the Codium marker, actual per-message billing overrides a session's fallback classification, and actual per-pass catalog kinds preserve priced/free figures without treating subscription-equivalent prices as billed dollars. `ReviewPass.costKind` is optional; A26 owns durable review state and remaining footer/export behavior.

## Validation

Final focused runs: **527 passing cases across 23 files**, one file at a time, with the global serial lock and a 30-second per-test timeout. The 17 app surface/model files contribute 483 cases; the four Settings/summary/account/preference files contribute 27; core Codium helpers add one; engine usage summaries add 16. App source and E2E types, Core types and Engine types passed. Four browser cases were added (two session-label cases and two Settings cases); they run in GitHub, not locally.

One engine test attempt failed before tests because the filesystem sandbox disallowed the existing strict network guard's localhost proxy. Re-running that single file with network permission allowed the local proxy and all 16 tests passed; no provider request was made. During preparation an accidental repo-root typecheck started Turbo's parallel checks despite holding the global lock; its identified process tree was stopped after approximately 12 seconds. Its partial results are not validation. All reported package checks used explicit package working directories afterwards.

The normal pre-push hook, scoped browser checks and production benchmark comparison have passed as recorded below. The scoped test/exerciser/generated-client job is still running. A25–A26 still own desktop/CLI/TUI/ACP and remaining review-state/export surfaces.

### First GitHub validation

Source `b4c05481fcd493e602b49d4b07f78688f2d4650f` passed all 23 normal pre-push package typechecks in 2m36.501s and all eight scoped GitHub typechecks. Scoped workflow `41259157398` passed 24 of 25 browser cases, including Codium-only labels and both new Settings cases. The new mixed-session fixture omitted the catalog's required cache rates, so the existing pricing reader threw before the session rendered. The fixture is corrected to supply zero cache rates and chronological message IDs; no production app source changes are needed for this failure. The browser check must rerun. Production comparison workflow `41259171922` measures the same production source, unaffected by that fixture-only correction.

### Corrected fixture and native checks

`44c35f1c530d76558c93f308576d342a5629d9ec` passed the normal 23-package hook in 1m23.151s. Its scoped workflow `41259683061` passed all eight typechecks and the browser job `124710252023`, including the corrected mixed-session case. The production benchmark passed 9/9 and the same scenarios show no observed regression; complete sample evidence and source equivalence are in [the benchmark notes](codium-a24-benchmark-notes.md).

Native CI found two test expectations left behind by A23/A24. Four exact HttpApi spend snapshots now include `codiumSteps: 0`, preserving all own dollar, state, reason and stopping assertions. The Host locally policy test still forbids account, credits, pricing and plan access throughout the agents feature; it permits only the dashboard's exact usage-label import, optional marker declarations and existing formatter references. The dashboard does not read an account or gate launching. Independent review approved these narrow test-only repairs. Focused reruns passed 17 Host locally cases and all 26 session HttpApi cases, each in its owning package under the serial lock.

The Windows native Local API case also returned 400 instead of its expected 409 when probing a local fixture server. That case passes on Linux and none of its production or fixture inputs changed in A24; separate diagnosis is tracking it without weakening the assertion.
