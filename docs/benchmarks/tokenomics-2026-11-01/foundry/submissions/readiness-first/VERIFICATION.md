# Verification Results

Verified locally with the supplied Bun runtime, `NODE_EXE`, Playwright module, Chrome executable, `PORT` and absolute `DATA_DIR`. No deployment or external services were used. Chrome ran headlessly with isolated contexts, never an existing browser profile.

## Passing Checks

- `bun run typecheck`: real frontend/backend TypeScript passes.
- `bun run build`: actual Vite production bundle builds and is served by Bun from the API origin.
- `bun run test`: 12 Bun scenarios, 426 assertions, zero failures. Tests use their own unique database and attachment directory inside the verification data directory.
- Real HTTP API verification: 120 assertions before restart and 27 after restart.
- Two competing order fulfillments returned exactly one `200` and one `409`, with no negative inventory.
- Twelve simultaneous same-key fulfillments returned one applied result and eleven replays, with exactly one stock movement per line.
- Insufficient multi-line inventory left all products, order state, movements, revision and idempotency availability unchanged. Retrying the same key after restocking succeeded.
- Concurrent order and invoice creation produced unique sequential workspace numbers.
- Tenant isolation, ownership overrides, role enforcement, original-owner protections, invitation email binding/single use, membership revocation and server-side logout were checked.
- Customer/product validation, immutable order/invoice snapshots, exact integer totals, task filter composition and atomic invalid patches were checked.
- Quoted CSV commas, quotes and newlines, all-or-nothing imports, duplicate handling and formula-safe exports were checked.
- Original attachment bytes, owned storage, cross-tenant download denial, unsupported/oversized files, traversal names, CR/LF injection, deletion and project cascade cleanup were checked.
- A full server stop/restart preserved sessions, selected workspace, memberships, records, analytics, revisions, activity, idempotency results and exact attachment bytes. An invitation created before restart was accepted afterward.
- Independent SQLite inspection found salted Argon2id password hashes, synthetic email addresses and `PRAGMA integrity_check = ok`.

## Browser And Visual Checks

- Actual signup, customer CRUD/search/import/export, product creation and stock history, multi-line fulfillment, invoice creation/sent/paid, projects/tasks/comments and attachment upload/download were exercised through the interface.
- Local invite creation and acceptance used two isolated browser contexts. A second-client customer appeared on the open owner page in 874 ms, including the time spent entering/submitting the form. A live role downgrade removed forbidden controls within 3 seconds, and the server rejected the write.
- Workspace creation/switching showed isolated data immediately.
- Native confirmation deletion, Escape close, focus return and keyboard Tab operation passed.
- Visible errors explained rejected files. Comment HTML was rendered as text, not executed.
- Direct frontend navigation and a new browser context after the server restart preserved the signed-in experience and task comments/files.
- Desktop 1440 px and mobile 390 px screenshots were captured and visually inspected, including overview, customers, inventory, invoice details, project board, mobile navigation and mobile form. Mobile document width did not exceed the viewport; tables/boards use contained scrolling.
- Main browser workflow: zero page errors and zero page requests to external origins. Final persistence/visual/sign-out workflow: zero page errors.

Artifacts are under `DATA_DIR/browser-verification`, outside application source. Verification-only state files contain local session/invite tokens and must not be published. The final visual check intentionally revoked its browser session on sign-out.

All verification servers and headless browsers were stopped. A final connection-refused check confirmed no listener remained on `127.0.0.1:33217`.

## Fixes Found During Verification

- Explicit accessible labels preserve exact form/select names independently of required markers and option text.
- Navigation count badges are hidden from accessible link names.
- Original multipart headers are validated before Bun can truncate CR/LF-injected filenames.
- Screenshots disable finite transitions to avoid capturing mobile navigation mid-animation.

## Limits

This is a functional prototype. Payments are local invoice-status decisions, invitations are locally copied tokens, and no SMTP, payment service, malware scanner, password recovery, telemetry or production deployment is included. Live updates use one-second revision polling. Lists cap at 10,000 records; activity shows the newest 50 by default. Testing covered local Chrome and representative keyboard/mobile layouts, not every browser, screen reader, high-volume workload, or production security scenario. Filesystem/database consistency under abrupt power loss was not fault-injected.
