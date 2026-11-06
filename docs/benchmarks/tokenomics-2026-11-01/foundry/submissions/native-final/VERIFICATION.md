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
| `bun test tests/api.test.ts` | 9 tests, 487 assertions pass |
| Supplied Node running `tests/browser.mjs` | 11 end-to-end workflow groups pass |
| Full server stop/start, then `bun test tests/restart.test.ts` | 1 test, 34 assertions pass |
| Final local health probe after shutdown | Connection refused; verification server stopped |

Total Bun coverage: 13 tests and 544 assertions across the three suites.

## Regression fixes

The reported symptoms were reproduced locally before changes:

- A cancellation POST without a request body returned 400 `invalid_json` rather
  than 200. Only the cancellation endpoint now permits an empty body. Malformed
  JSON, protected fields and missing bodies on JSON-required endpoints still
  return 400. Regression assertions also check cancelled-order conflicts,
  unchanged stock/movements and revision increments.
- Exact accessible-name lookup found zero matches for both status filters,
  despite each native select being rendered. Both selects now use explicit
  `aria-labelledby` references to their required labels, independent of options.
  Browser regressions exercise every order status, invoice draft/sent/paid
  filtering and real downloaded CSV files.

The full local verification above was rerun after these changes, including
concurrency and a full stop/start persistence check. The independent evaluator
was not accessed or rerun; no benchmark tools or `BUILD_SPEC.md` were changed.

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
  in 551 ms. Open stock-history dialogs also refresh; role demotion closes an open
  editor and removes the now-forbidden action.
- Escape, focus return, native selects, keyboard tab flow, desktop 1440px and
  mobile 390px navigation with no page-level horizontal overflow.
- Restart preserves sessions, active workspace, records, comments, file bytes,
  summary, revision and idempotency without extra activity or stock decrement.

## Visual inspection

Representative overview, customer, inventory, invoice and project screenshots
were inspected, including refreshed order/invoice filter views and the mobile
overview after the regression fixes. Final desktop/mobile images are under
`DATA_DIR/screenshots`.
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
