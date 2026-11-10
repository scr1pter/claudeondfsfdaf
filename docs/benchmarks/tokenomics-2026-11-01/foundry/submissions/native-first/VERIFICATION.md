# Verification

Completed locally using the supplied `PORT` and absolute `DATA_DIR`. Application
servers and tests ran with Bun; browser automation used the supplied `NODE_EXE`,
`PLAYWRIGHT_MODULE` and `CHROME_PATH`. No deployment or external integrations.

## Passing checks

| Check | Result |
| --- | --- |
| `bun run typecheck` | Frontend and backend TypeScript pass |
| `bun run build` | Actual production frontend builds |
| `bun test tests/store.test.ts` | 3 tests, 23 assertions pass |
| `bun test tests/api.test.ts` | 9 tests, 452 assertions pass |
| Supplied Node running `tests/browser.mjs` | 9 end-to-end workflow groups pass |
| Full server stop/start, then `bun test tests/restart.test.ts` | 1 test, 34 assertions pass |
| Final local health probe after shutdown | Connection refused; verification server stopped |

Total Bun coverage: 13 tests and 509 assertions across the three suites.

## Exercised behavior

- Signup, case-insensitive email uniqueness/login, Argon2id storage verification,
  durable server sessions, revoked logout sessions, workspace creation/selection.
- All business modules, cents-exact multiline order/invoice snapshots, draft
  edits, invoice transitions and analytics.
- Competing-stock fulfillment yields one success and one conflict. Concurrent
  same-key fulfillment applies once. Failed multiline fulfillment rolls back
  stock, order, movements, activity and revision; the same key works after restock.
- Tenant isolation, protected fields, malformed input, owner restrictions,
  invitations, role changes, immediate revocation and author permissions.
- Quoted/multiline CSV, atomic import rejection, safe formula export.
- Exact downloaded file bytes, owned storage, traversal normalization, raw CR/LF
  filename rejection, unsupported/oversized files and deletion cascades.
- Browser creation/editing, local invite acceptance, payment status, comments,
  attachments, searches and composed task filters.
- Real revision polling: the final measured cross-client customer update appeared
  in 444 ms. Open stock-history dialogs also refresh; role demotion closes an open
  editor and removes the now-forbidden action.
- Escape, focus return, native selects, keyboard tab flow, desktop 1440px and
  mobile 390px navigation with no page-level horizontal overflow.
- Restart preserves sessions, active workspace, records, comments, file bytes,
  summary, revision and idempotency without extra activity or stock decrement.

## Visual inspection

Representative overview, customer, inventory, invoice and project screenshots
were inspected. Final desktop/mobile images are under `DATA_DIR/screenshots`.
Verification records, browser results and screenshots are separate from source.
Headless browser contexts were isolated and closed. All verification servers
were stopped.

## Limitations

- This is a local functional prototype, not a production security, availability
  or large-data performance certification.
- Browser verification used installed Chromium, not Firefox or Safari.
- Live updates use one-second polling. Prototype record lists cap at 5,000 rows.
- Email delivery, actual payments, external services and deployment are
  intentionally absent. A paid invoice records a local business decision.
