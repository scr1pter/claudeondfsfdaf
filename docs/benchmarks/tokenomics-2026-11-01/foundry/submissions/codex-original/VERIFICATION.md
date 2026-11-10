# Verification record

Verified locally with Bun 1.3.14 and the supplied Node/Playwright/Chrome tooling. Only one agent was used. No external services, deployment, existing browser profiles, or user applications were used. Browser contexts were isolated and headless.

## Passing checks

- `bun run typecheck`: frontend and backend TypeScript passed.
- `bun run build`: Vite production frontend built successfully and was served by the Bun application on the API origin.
- `bun test server/validation.test.ts`: 3 tests, 18 assertions. Quoted CSV, embedded newlines/quotes, formula neutralization, strict integers and calendar dates.
- `bun verification/api.ts`: 282 checks. Signup/login/logout, case-insensitive uniqueness, real Argon2id storage, workspace membership, role permissions and immediate revocation, foreign-reference isolation, protected fields, CRUD, stock history, exact totals, immutable order/invoice snapshots, invoice transitions, invitations, search/filter composition, comments, files, CSV, summary and activity.
- Concurrency: two competing orders yielded one success and one 409 without negative stock. Eight simultaneous same-key fulfillment calls applied once, with one movement for the line. Failed multi-line fulfillment rolled back stock, order state and revision; its original key succeeded after restocking.
- `verification/browser.cjs`, executed using `NODE_EXE`: 81 checks. Real signup; customer/product/stock/order/invoice/project/task forms; payment status; visible stock and upload errors; comment text escaping; exact attachment bytes; CSV import/export; project/task deletion; search/filter composition; workspace creation/switching; local invitation/join; live role changes; keyboard focus, Tab containment, Escape and focus return. No page errors or external requests were observed.
- Live behavior: a second client’s customer creation and a member’s role downgrade appeared in the open relevant pages within three seconds.
- `bun verification/restart.ts`: 37 checks after terminating and restarting the server with the same data directory. Durable sessions, workspace selection, membership, records, invoice status, summary, revision, idempotency replay, unchanged replay activity/stock and exact file bytes. Also checked project cascade cleanup and whitespace-preserving, formula-safe CSV.
- `verification/restart-browser.cjs`, executed using `NODE_EXE`: saved browser session and workspace survived server restart; direct routes, orders and revenue loaded correctly; sign out/sign in succeeded.
- `bun verification/files.ts`: 6 additional checks. Multipart bodies above 3 MiB and an 8 MiB upload returned structured JSON 413 errors. Traversal filenames were rejected or normalized safely; raw CR/LF filename injection returned 400.

## Visual review

Inspected actual screenshots at 1440px desktop and 390px mobile. Overview, customer details and project boards were reviewed. Page-level horizontal overflow was checked in the browser; wide tables and boards scroll inside their own regions. Screenshots are in `verification/artifacts/`:

- `overview-desktop.png`, `overview-mobile.png`
- `customers-desktop.png`, `customer-mobile.png`
- `projects-desktop.png`, `projects-mobile.png`

Verification used the supplied `PORT` and absolute `DATA_DIR`. SQLite, owned files and restart/session fixtures stayed under `DATA_DIR`, separate from application source. Verification servers were stopped at completion.

## Limits

This is a local functional prototype. Browser verification covered the installed Chromium at desktop/mobile viewport sizes, not Safari, Firefox, physical touch devices, or a full assistive-technology audit. Business read lists are capped at 1,000 matching rows with no pagination; analytics and CSV exports include all rows. The HTTP server has a 64 MiB request-body ceiling; the enforced attachment-file limit is 2 MiB. Very large workspaces, load/performance soak testing, disk-failure recovery and requests beyond that HTTP ceiling were not tested. No SMTP, payments, external APIs, telemetry or deployment are included, as required by the spec.
