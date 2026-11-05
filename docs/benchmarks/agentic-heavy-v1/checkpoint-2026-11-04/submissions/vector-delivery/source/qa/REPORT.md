# Foundry — independent QA report

**Current QA verdict: R1–R4 PASS on the repaired connected app; no unresolved material issue found in final recheck. See FINAL RECHECK below. Historical findings are retained, not current failures.**

## Initial verdict (superseded by FINAL RECHECK)

**Changes requested for two accessibility-contract defects below.** No financial-integrity, tenant-isolation, attachment-safety, persistence, or authorization defect was found in the exercised cases. This is not an unconditional acceptance pass; untested cases and tooling limits remain explicit.

Inspected the complete public `BUILD_SPEC.md` and the actual frontend, HTTP integration, identity/storage core, and business routes. Testing began after implementation completion. No implementation or protected source was edited, and no independent evaluator was inspected.

## Reproducible findings requiring parent-owned changes

### QA-1 · P2 · Helper text changes required accessible field names

- Reproduce: Inventory → New product; target the textbox with exact accessible name **SKU**.
- Authorized client action `{"action":"click","role":"textbox","name":"SKU"}` fails: “Exact role/name target is missing, hidden or ambiguous.” The fresh snapshot contains one SKU input, named `SKUA unique stock keeping code. Stored in uppercase.` It remains operable using its snapshot ref.
- Evidence: `sku-exact-label-check.json` (generation 190), `inventory-new-label-check.json` (189), and `product-modal.json`.
- Cause: `src/ui.tsx:39` places both the visible label and helper text inside the wrapping label. This same construction produces observed helper-bearing names for Quantity change, Attachment, Invite token, and signup Password. Only SKU's exact role/name failure was separately reproduced; password inputs also lack an implicit textbox role, so the earlier password role-target failure is **not** independently treated as a product defect.
- Required parent change: preserve the specified accessible names, associating helper text as a description rather than part of the label. Recheck label-based interaction on all hinted fields. QA did not modify product code.

### QA-2 · P2 · Saving a filtered task can lose keyboard focus

- Reproduce: open Studio launch; search `NEEDLE`; select High and In progress; edit Prepare launch kit; change Status to Done; Save changes.
- Actual: save succeeds and the task correctly disappears from the filtered board, but focus becomes the document body instead of a stable board control. `task-edit-save.json` and `task-edit-check.json` (generations 95–96) both record `activeKind: body`, `tag: body`, `tabIndex: -1`.
- Expected: after closing the dialog, return focus to the initiating control or, when that filtered-out control no longer exists, a sensible stable fallback such as Search tasks/New task.
- Cause: `src/ui.tsx:35` restores focus only when the old element is still connected; there is no disconnected-trigger fallback. Ordinary Escape/focus return **did pass** for customer, import, history, and task-details dialogs.
- Required parent change: implement a stable focus fallback and recheck this exact filtered-edit workflow. This is a keyboard acceptance gap, not lost task data.

### Nonblocking observations

- Customer, order, invoice, project, and task records often expose two same-name Open buttons. They perform the same action, but exact role/name targeting is ambiguous; fresh refs were used. Consider removing redundant accessible controls or distinguishing names.
- Activity renders role changes as `QA Browser role_changed member`; this is real persisted activity, but less human-readable than the rest of the timeline.
- Some desktop helper/status text is very small and low-emphasis. The overall hierarchy, forms, whitespace, charts, invoice paper, and responsive layout are coherent; screenshots were visually inspected, not merely generated.

## Independently executed checks

| Check | Result / concrete coverage |
| --- | --- |
| `bun run typecheck` | PASS; real frontend/backend TypeScript |
| `bun run build` | PASS; actual Vite frontend |
| `bun qa/api.ts` on parent `127.0.0.1:4123` | PASS **251 assertions**, including a final rerun |
| Same HTTP suite on QA-owned `127.0.0.1:4124` | PASS **251 assertions** with separate synthetic users/data |
| Stop/restart QA-owned server, then `QA_URL=http://127.0.0.1:4124 bun qa/api.ts --restart` | PASS **21 assertions**: existing cookie/session, selected workspace, membership, order, immutable invoice, comments, exact file bytes, analytics, revision, and persisted idempotency/no replay revision |
| `bun qa/edges.ts` on parent | PASS **73 assertions** |
| Final server checks | Parent 4123 health **200 `{ok:true}`**; QA 4124 **not listening** |

HTTP coverage includes signup validation/case-insensitive uniqueness and login; random session length/cookie flags; server-side logout; member/manager/read-only restrictions; owner immutability; email-bound single-use invites and token-free listings/audit; immediate membership revocation; outsider 404 and unauthenticated 401 including downloads/sync/activity; cross-tenant references and revision isolation; protected stock/state fields; integer/enumeration/date validation; atomic invalid task edits; exact multiline order/invoice cents; catalog/customer snapshots; stock rollback with retryable same idempotency key; concurrent same-key fulfillment and competing-order stock; one fulfillment movement per line; invoice uniqueness/transitions; composed task filters; comment authorship; all export types; RFC4180 multiline/quotes; duplicate/invalid/201-row/over-1MiB CSV rollback; successful 200-row import with all rows listed; formula neutralization without altering stored data; raw multipart CR/LF rejection; traversal filename reject/normalization and opaque storage; exact binary downloads; unsupported/over-2MiB/foreign-entity upload failures; file deletion and project cascade including physical file removal; stock upper bound and no failed-write activity/revision.

Read-only SQLite inspection was limited to QA-created users and files: `users.email`/`password_hash` exist, real Argon2id hashes verify, identical synthetic passwords have different salted hashes, and the opaque owned attachment file has the original bytes.

Parent additionally reported core **137 assertions**, API **225 checks**, and integration **277 + 13 restart assertions**. Those are supplemental parent evidence, not claimed as independently rerun by QA.

## Browser, keyboard, live data, and visual evidence

All browser interaction used only `NODE_EXE BROWSER_DRIVER_CLIENT --endpoint BROWSER_DRIVER_ENDPOINT` with action JSON on stdin. No browser libraries, browser launch, direct connection, profile attachment, page evaluation, or custom browser script was used. `qa/browser.mjs` is only a wrapper around that client, recording returned observations. `qa/connected.ts` uses independent same-origin HTTP clients for real mutations and the same authorized client for observations.

- Browser signup/signin/signout, owner invite creation with visible local token, invitee `/join`, Team native role select + Save role, New workspace, native Workspace switching, and selected-workspace persistence on direct route reload all exercised.
- Browser-created UI Avery and UI-KIT at **$12.34**; stock received through Adjust stock, actual history inspected. Negative stock displayed a visible server error and could be corrected.
- Browser-created two-line order: `2 × $12.34 + 3 × $0.66 = $26.66`; fulfilled; invoice created, marked sent, then paid. API independently confirmed `2666` cents and snapshots. Subsequent API edits to live customer/catalog appeared behind the open invoice, while its bill-to/items/prices stayed unchanged.
- Browser project/task creation, assignment, status/priority, composed case-insensitive description search, empty and restored filter results, task details, real author/comment, and editing to Done exercised. HTML/script-like customer notes and comments stayed visible literal text.
- Customer details showed an API-uploaded attachment and its download/delete actions. Browser CSV dialog and required file controls inspected. Destructive confirmation and referenced-customer 409 error exercised visibly.
- Keyboard Enter reopened New customer after Escape restored focus; Tab traversed attachment controls; Escape/focus return checked across several dialogs. The filtered-edit focus exception is QA-2.
- Paid revenue card/chart both displayed **$26.66**, unpaid **$0.00**, fulfilled count **1**, task chart **100% / 1 done**, and actual customer counts. Empty second workspace displayed zero rather than borrowed/invented values.
- Independent API writer → already-open Customers page: new customer appeared in **1553 ms**, without reload (`live-customer.json`).
- Owner API changes → open invitee browser: member→read-only **323 ms**, including removal of an already-open customer form; read-only→member **1264 ms**; membership removal/tenant disappearance **1529 ms**. All below 3 seconds. Evidence: `role-readonly.json`, `role-member.json`, `revoke.json`.
- Desktop **1440×1000** and mobile **390×844** layouts visually reviewed. Overview/cards, customer table/details, navigation, and kanban fit the viewport; tables/kanban have contained overflow. No whole-page horizontal overflow was observed visually; DOM scroll-width was not measured because arbitrary page evaluation was prohibited.
- Final console contained only expected resource errors from initial unauthenticated `/me` and the two deliberately induced 409 UI failures; no observed React/runtime exception. Browser left signed in as QA Browser (owner), QA Browser workspace, `/overview`, 1440×1000, no dialog open.

### Exact evidence locations

Evidence root: **`C:\Users\krish\Documents\Codex\vector-research-tools\paid-cycle\heavy-foundry-02\vector\support-data\qa-evidence`** (under supplied `DATA_DIR`).

Screenshots at that root, opened and visually inspected:

- `overview-desktop.png` — 1440×1000, actual paid chart/cards.
- `invoice-desktop.png` — 1440×1000, paid immutable two-line invoice.
- `project-board-desktop.png` — 1440×1000, assigned In progress task.
- `overview-mobile.png` — 390×844, cards/chart.
- `mobile-customers-shot.png` — 390×844, contained customer table.
- `customer-mobile-details.png` — 390×844, safe text/files/dialog.
- `project-board-mobile.png` — 390×844, responsive filters/contained horizontal board.
- Additional captures: `customer-details-desktop.png`, `mobile-nav-shot.png` (the latter was captured during the menu transition; do not judge its transient left-edge position as settled layout).

Structured evidence: `browser.ndjson`, named action JSON files, `api-results.json`, `isolated-api-results.json`, `restart-results.json`, `edge-results.json`, `ui-api-results.json`, the live/role JSON files above, and `console-final.json`. The driver controls its original capture directory and ignored the requested screenshot path; returned captures were copied under `DATA_DIR` for retained QA evidence.

## Limits and handoff

- Browser file-picker selection is not exposed by the allowed action set. End-to-end browser CSV selection/upload, rejected-file browser alerts, and browser download bytes were **not** claimed as passed. Real file bytes/safety/import/export were tested through HTTP; browser controls/listing and local validation implementation were inspected.
- Native confirmation accept/dismiss automation was unavailable in the permitted action set. Browser cancellation/void confirmation branches were not driven; relevant API state conflicts/transitions were tested, but not every UI confirmation branch.
- No second browser context was created. Cross-client evidence uses a separately authenticated HTTP writer and the live open browser, not two browser tabs.
- Invite expiry was checked by returned expiry within 7 days, not by advancing time. This is prototype verification, not exhaustive security/accessibility auditing or every possible race/payload.
- Driver observations contained blocked Google/autofill/password-manager requests. No external service was used for the application checks; source scan found no external URLs/imports in `src`.
- All authored files are in `qa/`; runtime state, synthetic data, logs, and retained captures are under `DATA_DIR`. No deployment, company documents, cloud accounts, unrelated app files, evaluator access, or implementation edits. Only QA-owned restart servers were stopped; parent server was never stopped/replaced.
- Remaining parent work: fix QA-1 and QA-2 across the product boundary, then resume this same QA identity for a focused final recheck. No requirement is waived.

Authored QA files: `qa/api.ts`, `qa/edges.ts`, `qa/connected.ts`, `qa/browser.mjs`, `qa/REPORT.md`.

## FINAL RECHECK — same independent QA identity

**Verdict: R1–R4 independently rechecked and PASS. No unresolved material issue found in the final repaired state within the tested scope.** This supersedes the initial change request and resolves QA-1/QA-2. The judge correctly elevated duplicate Open names to required repair R3; the initial “nonblocking” classification is superseded as well. Final judge approval remains the judge's decision.

Read the public `review/VERDICT.md` R1–R4 and inspected the repaired authorization wrapper and Field/Modal implementation. Rechecked the rebuilt, restarted parent app through its real `127.0.0.1:4123` origin; no implementation edits or judge/evaluator test imports were made.

### R1 — stalled-body authorization: PASS, all five cases

Added independent `qa/revocation.mjs`, using Node's ordinary local HTTP client, not the judge's test. Each synthetic writer sends headers and half the body, holds the request for at least 650 ms, then an independent owner completes revocation (or the writer logs out), and only afterward sends the remaining body. Owner-visible records, post-revocation revision/activity, and owned blob filenames are checked after the response.

| Held request / intervening change | Final status | Business/metadata commit | Revision delta | Activity delta | New/orphan blobs |
| --- | --- | --- | --- | --- | --- |
| Manager product create → member demotion | **403** | None | **0** | **0** | None |
| Member customer create → read_only | **403** | None | **0** | **0** | None |
| Member customer create → membership removal | **404** | None | **0** | **0** | None |
| Member customer create → session logout | **401** | None | **0** | **0** | None |
| Member multipart upload → membership removal | **404** | None | **0** | **0** | None |

Result: **72 assertions PASS**, including setup/status checks and the five no-write/no-orphan expectations for each case. Evidence: `DATA_DIR/qa-evidence/final-revocation-results.json`. Source inspection confirms the wrapper refreshes session/membership/current role inside the synchronous transaction before the mutation callback, including fresh context for author/manager checks. This focused test covers the five required held-request cases, not every possible endpoint/race.

Affected regression suites independently rerun on the repaired server: `bun qa/api.ts` **251 PASS**, `bun qa/edges.ts` **73 PASS**, and `bun run typecheck` **PASS**. These retain real role/tenant enforcement, exact cents/snapshots, fulfillment concurrency/rollback/idempotency, CSV, file-byte/safety, cascade, revision and activity coverage. Current `api-results.json`/`edge-results.json` are the repaired-state results. A second full restart was not performed by QA in this follow-up; the baseline isolated restart evidence remains accurately scoped to that run.

### R2 — exact names and descriptions: PASS

- Exact authorized role/name actions now succeed for **Overview**, **SKU**, **Quantity change**, and **Invite token**; no ref disambiguation was used for these repaired targets.
- The native Attachment file input is observed with exact name **Attachment**, and signup password with exact name **Password**, without appended hints. Password ref focus was tested without assuming an implicit textbox role. File-picker interaction remains unexecuted rather than inferred from the snapshot.
- Helper text is still visible. Inspected Field code uses the visible label span through `aria-labelledby` and a separately identified hint through `aria-describedby`; selects and textareas retain their named controls, as also exercised by task filtering/editing.
- Evidence: `final-r2-overview-exact.json` (224), `final-r2-sku-exact.json` (227), `final-r2-quantity-exact.json` (230), `final-r2-customer-loaded.json` (234), `final-r2-invite-token-exact.json` (266), `final-r2-signup-labels.json` (270), `final-r2-password-ref.json` (271).
- Driver snapshot text still concatenates the decorative Overview shortcut in its heuristic name field; the actual exact role/name action **Overview** succeeds. That snapshot heuristic is not treated as a failing accessible locator.

### R3 — unique canonical Open actions: PASS for owner and read_only

Successfully used exact canonical button names, without fresh-ref workarounds, for all five domains: **Open customer UI Avery revised**, **Open order ORD-000001**, **Open invoice INV-000001**, **Open project Studio launch**, and **Open task Prepare launch kit**. Each reaches the required details/board. Repeated all five after signing in as the synthetic read_only collaborator; mutation controls remained hidden while records, immutable invoice details, comments and downloads remained readable.

The retained title control has a distinct **View …** name; snapshots contain exactly one canonical Open button for each tested customer/order/invoice/task. Successful exact project actions independently require an unambiguous role/name target. Evidence: `final-r3-*-exact.json`, `final-r3-*-loaded.json`, `final-readonly-customer.json`, `final-readonly-order.json`, `final-readonly-invoice.json`, `final-readonly-project.json`, and `final-readonly-task-loaded.json`.

### R4 — settled focus, keyboard continuation and nested dialogs: PASS

Reset the existing task to In progress/High through the public API; reran the original workflow exactly: Studio launch → `NEEDLE` → High + In progress → Edit Prepare launch kit → Done → Save changes. The task leaves the retained filter correctly. Focus is **Search tasks** both immediately after refresh and after an additional **1800 ms** settling interval (generations **257–258**, `final-r4-after-save.json`, `final-r4-settled.json`), not the body. Tab then moves to **Status filter** (`final-r4-tab-continuation.json`, 259). The same task is subsequently visible as Done to the read_only client.

Nested regression: Customer details → Delete attachment opens an accessible nested confirmation. Escape closes only the confirmation and restores **Delete attachment qa-ui-note.txt** (236); a second Escape closes Customer details and restores **Open customer UI Avery revised** (237). The attachment is retained. Ordinary product/stock/task/invoice Escape return also passed. Evidence: `final-r4-nested-delete.json`, `final-r4-nested-escape.json`, `final-r4-outer-escape.json` and named final dialog Escape artifacts.

`NODE_EXE qa/recheck-evidence.mjs` independently validates saved action success, exact names, canonical counts, read_only controls, settled focus/keyboard/nested returns and passing HTTP reports: **44 assertions PASS**, saved as `final-browser-assertions.json`.

### Final visual evidence, limits and handoff

New captures, opened and visually inspected, all retained under **`C:\Users\krish\Documents\Codex\vector-research-tools\paid-cycle\heavy-foundry-02\vector\support-data\qa-evidence`**:

- **`final-filtered-focus-desktop.png`**, 1440×1000: settled filtered board with visible keyboard focus on Status filter after Tab continuation.
- **`final-overview-desktop.png`**, 1440×1000: real $26.66 paid chart/card, two customers, one completed task.
- **`final-overview-mobile.png`**, 390×844: responsive cards/chart with no visually observed page-level overflow.

No new material visual regression observed; tiny helper/status typography remains a nonblocking polish concern, not a measured contrast/zoom certification. Activity now says “changed the role of a member.”

Retained baseline file-picker/download-byte/native-confirmation, second-browser-context, clock-advanced expiry, crash-consistency and DOM-overflow-measurement limits remain. Final console is cumulative across the prior review/restart: expected negative-test/auth resource errors plus one undated **502** remain in its history; they cannot be precisely attributed from that output. No observed JavaScript exception or reproduced current 502 occurred in this recheck, and final API health is **200 `{ok:true}`**. A first read_only login attempt was interrupted by navigating before its async completion; it was retried with a settled authenticated observation. That tool-sequencing failure is not counted as a product defect or a passing flow.

All browser access remained exclusively through the approved client with `NODE_EXE`, `--endpoint BROWSER_DRIVER_ENDPOINT` and JSON stdin. No browser import/evaluation/launch/direct connection/profile, external service, deployment, unrelated file/evaluator access, product edit or delegation. Runtime data/evidence remain under supplied `DATA_DIR`; screenshot originals are driver-owned as previously documented. No server was started or stopped by QA in this follow-up. Parent listener remains running for the judge.

Browser left at `/overview`, **QA Browser / owner**, QA Browser workspace, **1440×1000**, no dialog. Collaborator restored to its prior Manager role; task remains Done. Only synthetic QA records changed through public API/UI.

Follow-up authored files: **`qa/revocation.mjs`**, **`qa/recheck-fixtures.ts`**, **`qa/recheck-evidence.mjs`**, **`qa/REPORT.md`**. Remaining work: same judge's final review and parent's eventual verification-server shutdown; no unresolved R1–R4 repair is being handed back.
