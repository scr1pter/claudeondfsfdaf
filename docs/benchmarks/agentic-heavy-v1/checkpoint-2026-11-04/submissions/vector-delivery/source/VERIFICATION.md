# Foundry verification

All verification uses synthetic local records and `example.invalid` emails. No cloud services, email, payments, telemetry, independent evaluator, or unrelated applications are used.

## Evidence to complete

- [x] `bun run typecheck` checks actual frontend and backend sources.
- [x] `bun run build` builds the actual frontend (37 modules).
- [x] `bun tests/integration.ts`: 277 public-API assertions passed.
- [x] Full server stop/start followed by `bun tests/integration.ts --restart`: 13 assertions passed.
- [x] `bun test server/core/core.test.ts`: 1 test, 137 assertions, zero failures.
- [x] `bun server/tests/api.ts`: 225 checks passed, including isolated restart durability.
- [x] Fixed-team QA checks and same-identity final recheck after material repairs.
- [x] Fixed-team judge review of implementation and final QA evidence: APPROVED.
- [x] Parent's final API and common-client browser verification, after final judge completion.
- [x] Desktop 1440px and mobile 390px screenshots captured and personally visually reviewed.
- [x] Verification servers stopped; TCP checks confirm ports 4123 and 4124 are not listening.

The HTTP integration suite covers authentication/cookies/logout, case-insensitive uniqueness, tenant isolation, protected fields, stock bounds, snapshot/cents correctness, failed multi-line fulfillment rollback, retryable keys, concurrent competing-order and same-key fulfillment, invoice transitions, task filtering/date validation, comments/permissions, RFC4180 CSV and atomic import, CSV formula safety, owned attachments/bytes/rejection/cascades, invites/roles/revocation, isolated revisions, persisted activity, real summary values, salted password hashes, malformed JSON, and direct SPA navigation.

## Final results

The same required six native identities completed implementation, QA and review, with the API/data leaves nested under the backend coordinator. All material findings were repaired, independently rechecked by the same QA specialist, and approved by the same judge. Repairs cover authorization after stalled-body role/membership/session revocation, exact accessible names, unique canonical Open actions, and focus return when refreshed filtered results remove a dialog trigger.

- Final parent rerun: typecheck/build, **277 API assertions**, **5/5 stalled-revocation cases**, then full stop/start and **13 restart assertions**, all passed.
- Parent personally used only the supplied common browser client to create **Parent Studio**, create **FINAL-REVIEW** at **$19.99**, receive **5** units with a real history entry, inspect the paid immutable **$26.66** two-line invoice, open the project/task, add a real comment, inspect overview/activity values, operate mobile navigation, and verify Escape focus return.
- Independent HTTP correlation of these actual browser writes and saved browser observations: **26 assertions passed**.
- Same-QA final recheck: **251 API**, **73 edge**, **72 stalled-revocation**, and **44 browser/evidence assertions** passed. Live changes in the original QA pass appeared in **323–1553 ms**. Same-judge final checks: **5/5 revocation**, **88/88 evidence audit**, strict TypeScript, exact-name actions, and settled keyboard focus passed.
- No unexpected server error output appeared in the parent's final server terminal. No application source URL/import requires an external asset/service. Runtime data is under the supplied external `DATA_DIR`.

Detailed independent evidence and limitations: `qa/REPORT.md` and `review/VERDICT.md`. Their historical failing baseline sections are preserved and explicitly superseded by final passing reviews.

Parent screenshots, all under `DATA_DIR/qa-evidence/`:

- `parent-final-desktop.png` — 1440×1000 overview.
- `parent-final-mobile.png` — 390×844 overview.
- `parent-mobile-table-shot.png` — 390×844 customer table with contained scrolling.

Parent action observations use `parent-*.json`; correlated API results are `parent-final-api-evidence.json`. Driver-managed original captures were copied under `DATA_DIR` because the common client controls its own original capture directory.

## Limitations (not passes)

- The permitted browser action set does not expose file-picker selection or native confirmation acceptance. Browser file selection/upload rejection alerts/download-byte checks and every confirmation branch were not automated; actual CSV/file bytes, safety, atomicity, deletion and state transitions were extensively exercised through HTTP.
- No second browser context, clock-advanced invite-expiry test, crash/fault injection, exhaustive security/assistive-technology audit, measured contrast audit or DOM scroll-width evaluation was performed. Horizontal fit was visually reviewed at the required widths.
- Cumulative browser console history includes deliberate 401/409 resource failures and undated 502 resource entries across review/restart periods. Those 502 entries could not be precisely attributed; no current 502 was reproduced in the successful final flows and no JavaScript exception was observed. They are not silently counted as explained/passing checks.
- Parent harness attempts initially encountered PowerShell argument quoting and a wrong textbox role for the native numeric Quantity change spinbutton. Corrected stdin JSON and the actual spinbutton role succeeded; those harness errors are not product failures or passing browser actions.
- This remains a functional local prototype, not a production-readiness claim. No deployment or external integration was performed. Protected specification, lockfile and pinned dependencies were preserved.
