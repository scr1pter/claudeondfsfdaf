# Verification Results

Verified locally on 2026-10-30 using Bun 1.3.14 and the supplied Node/Playwright/Chrome tooling. The application listened only on `127.0.0.1`, supplied `PORT=33217`, with all verification records and files in the supplied absolute `DATA_DIR`, outside application source.

## Passing Checks

| Check | Result |
| --- | --- |
| `bun run typecheck` | Passed, actual React and Bun backend TypeScript |
| `bun run build` | Passed, production frontend served by the Bun server |
| `bun test server` | 3 tests, 6 assertions passed |
| `bun run verify:api` | 185 checked HTTP responses, 418 assertions passed |
| Supplied `NODE_EXE` running `tests/browser.mjs` | 45 workflow/layout checks; zero captured page errors or external requests |
| Full process stop/start, then `bun run verify:restart` | 18 assertions passed |
| Supplied `NODE_EXE` running `tests/browser-restart.mjs` | Existing browser session, selected workspace, revenue, board and exact file bytes passed |
| Shutdown | All verification terminals closed; health endpoint no longer reachable |

## Exercised Behavior

- Signup, case-insensitive account matching, real Argon2id hashes in SQLite, session cookie attributes, login, logout and session revocation.
- Separate tenants, workspace selection, invitation email binding and single use, roles, original-owner protection and immediate server-side revocation.
- Browser-visible role changes while a create dialog is open, and membership removal reflected in another open browser within three seconds.
- Customer create/edit/search/delete, CSV import/export, quoted newlines/commas/quotes, formula-safe export and failed-batch rollback.
- Inventory catalog, stock history, bounded integer validation, forbidden direct stock changes and exact integer prices.
- Multi-line order fulfillment, insufficient-stock rollback and same-key retry after stock receipt. Competing orders yielded one success and one conflict, without overselling. Eight simultaneous same-key requests applied once.
- Idempotent replay without new activity or revision changes, draft editing/deletion, cancellation, and referenced-resource deletion conflicts.
- Cents-exact invoices, immutable order/customer snapshots, duplicate protection, permitted transitions and recorded local payment.
- Projects, composed task filters, assignees, date validation, atomic task patches, comments rendered as text and cascading deletion.
- Exact attachment downloads, unsupported/oversized rejection, traversal rejection, tenant/author authorization, metadata/file deletion and entity cleanup.
- Persisted activity, tenant-specific summaries/revisions and real live browser updates.
- Native labelled controls, modal keyboard operation, Escape/focus return, native delete confirmation, errors and responsive navigation.
- Every main page at 390px without page-level horizontal overflow. Kanban/table overflow remains contained.

Desktop (1440px) and mobile (390px) overview, board, invoice, inventory and task-form screenshots were captured. Representative screenshots were visually inspected. Seven screenshots and private test-session fixtures remain under `DATA_DIR/verification`; no verification data was written into source.

## Limitations

- Browser verification used local headless Chrome only, not Firefox, Safari or a physical device.
- Keyboard and accessible-name checks were exercised; no screen-reader audit or automated WCAG certification was performed.
- Concurrency tests cover the specified single-server races, not a multi-process deployment or sustained load.
- Restart durability was tested, not simulated disk corruption, power failure or production backup recovery.
- This is a local functional prototype. No external integrations, email delivery, payment processing, deployment, antivirus scanning or production-hardening claim is included.
