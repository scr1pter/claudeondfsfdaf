# Foundry — independent whole-product verdict

## FINAL REVIEW — APPROVED, repaired prototype

**Same independent judge, after formal repair and same-QA final recheck: R1–R4 are resolved. No remaining material issue was found in the reviewed repaired state.** This approval supersedes the historical change request below. It is a local functional-prototype assessment, not a production security/accessibility certification or a claim that the parent's forthcoming delivery checks already ran.

### Final repair assessment

| Finding / rubric area | Final result and concrete basis |
| --- | --- |
| **R1 — role/session/member protection and atomicity** | **PASS.** Inspected `server/routes/index.ts:215–231`: the transaction wrapper is per request, refreshes session and URL-workspace membership within the immediate synchronous transaction, enforces the previously configured operation role against current membership, refreshes the shared context, then invokes the write callback. It fails closed when mutation roles are unconfigured. All business write branches use this wrapper, including uploads before file creation; author/manager checks see refreshed context. Judge reran `review/revocation.mjs`: **5/5 PASS**, expected **403/403/404/401/404**, no business/attachment commit and revision delta **0** in every case. |
| **R2 — exact accessible names** | **PASS.** `Field` now labels the control from a dedicated span and associates the separate hint with `aria-describedby`; the Overview shortcut is `aria-hidden`. Judge's real exact **Overview** and **SKU** actions succeeded, and Attachment is exactly named in loaded customer details. Audited QA's actual successful Quantity change/Invite token actions and exact Attachment/Password snapshots. Visible helper text remains. |
| **R3 — canonical Open contract** | **PASS.** Title controls now use distinct **View …** names while canonical **Open …** actions remain. Judge successfully used exact canonical Open actions across **all five domains** on the real owner session, with one canonical button per tested customer/order/invoice/task; project action opens its board unambiguously. Independently audited QA's corresponding owner and read_only artifacts, including hidden forbidden actions. The baseline duplicate-name issue was material and has been repaired, not waived. |
| **R4 — focus, settled refresh and keyboard continuation** | **PASS.** Inspected microtask restoration, disconnected-trigger fallback, asynchronous trigger-removal observer, user-focus-movement cancellation and bounded observer cleanup in `src/ui.tsx:26–60`. Judge reran the original NEEDLE + High + In progress task workflow and saved Done. After an explicit additional **1800 ms** settling interval, focus was **Search tasks** (generation **331**) and the task was absent from the retained filter. Tab moved to **Status filter** (332); selecting Done restored the actual saved task. Nested attachment confirmation Escape returned focus to Delete attachment (321), then outer Escape returned to canonical Open customer (322); the file was retained. |
| **Regression, completeness, durability and visuals** | **PASS within stated scope.** Current QA evidence retains **251 HTTP**, **73 edge**, **72 independent revocation** and **44 browser/evidence assertions**. Judge's separate evidence audit passed **88 assertions** against concrete artifacts, not just report prose. Judge typecheck passed again. No financial/data integration regression found; loaded order and paid invoice still show immutable two-line **$26.66** snapshots. Reviewed final 1440px filtered-focus desktop and 390px overview captures: no new material visual regression. Baseline normal-restart evidence remains scoped to that earlier run. |

### Evidence and independence

- Read `qa/REPORT.md:98–158`, the independent QA revocation and evidence-check implementations, the repaired code, and actual final results/snapshots. QA revocation evidence independently verifies **no activity delta and no new/orphan owned blobs**, as well as correct denials/no commits/no revisions. Judge's focused HTTP rerun separately verifies the original five cases without importing QA/product tests.
- Judge's `review/final-audit.mjs` reads the bounded QA/judge JSON artifact set and validates statuses, no-write/orphan evidence, exact names, owner/read_only canonical controls, settled focus, Tab and nested returns. Result: **88/88**, saved to `DATA_DIR/review-evidence/final-evidence-audit.json`.
- Current judge HTTP result: `DATA_DIR/review-evidence/revocation-results.json`, timestamp **2026-11-03T03:55:42.740Z**, synthetic workspace `a061fa78cfea64f89661c3515eba914d`. This current passing file supersedes the baseline failing result at the same path; the original failure details are preserved in the historical baseline text below.
- Current judge browser evidence under `DATA_DIR/review-evidence/`: `final-overview-exact.json`, `final-sku-exact.json`, `final-customer-loaded.json`, `final-{customer,project,task,order,invoice}-exact.json`, `final-{order,invoice,task}-loaded.json`, `final-focus-settled.json`, `final-focus-tab.json`, `final-nested-escape.json`, `final-customer-escape.json`, and `final-overview-settled.json`.
- Actual QA artifacts audited under `DATA_DIR/qa-evidence/`: `final-revocation-results.json`, current `api-results.json`/`edge-results.json`, `final-browser-assertions.json`, named `final-r2-*`, `final-r3-*`, `final-readonly-*`, `final-r4-*` snapshots; visual review of `final-filtered-focus-desktop.png` and `final-overview-mobile.png`.
- All judge browser interaction used only the supplied common client with `NODE_EXE`, endpoint argument and JSON stdin. No browser libraries/evaluation/direct connection, external service, evaluator, implementation edit or delegation. Only synthetic local records were used. The existing QA fixture reset was public-API preparation; independent judgment came from the resulting real browser save and observations.

### Remaining limitations and parent delivery work

- No unresolved material repair remains. Baseline limits on browser file-picker/upload errors/download-byte verification, native confirmation automation, second browser context, clock-advanced invite expiry, exhaustive security/contrast/zoom/DOM-overflow measurement and crash/fault injection remain honest limits; none is relabelled a pass.
- Judge did not repeat the broad backend/core/integration suites or another full restart in this follow-up; current QA suites and earlier real restart evidence retain their actual scope. Parent-reported rebuilt/restarted state and additional test counts are supplemental, not judge-executed build/restart results.
- QA reports one undated 502 in cumulative browser console history; no current reproduced 502 or JavaScript exception was found in this review's successful interactions. That historical entry remains unattributed, not silently declared explained.
- Tiny helper/status typography remains nonblocking polish. Approval does not claim an exhaustive assistive-technology or contrast audit.
- Parent must still run its promised final personal API/browser/restart/screenshot checks, reconcile `VERIFICATION.md` with actual outcomes, and stop its own verification server. Judge started no server and intentionally left parent **4123** untouched.
- Browser returned to **QA Browser / owner**, `/overview`, **1440px**, no dialog; task is again Done and the attachment is retained. Runtime evidence is outside source under supplied `DATA_DIR`. Follow-up authored changes are only `review/VERDICT.md` and `review/final-audit.mjs`.

## Historical baseline review — CHANGES REQUIRED (superseded)

Baseline review completed after implementation and QA finished. **Do not approve this state.** One newly reproduced authorization defect and three accessibility-contract repair groups remain material. No implementation repairs have yet been reviewed. The same QA and judge must recheck the repaired, rebuilt, connected state before approval.

Review covered `BUILD_SPEC.md`, `qa/REPORT.md`, actual QA test/evidence artifacts, root package/TypeScript/Vite configuration, `VERIFICATION.md`, `tests/integration.ts`, frontend components/data integration/styles, HTTP integration, identity/storage core and all business routes. Only `review/**` was authored. No protected product/evaluator files were changed; no evaluator was read or run.

## Rubric

| Area | Assessment of baseline |
| --- | --- |
| Completeness and coherent integration | Substantial real implementation across every required domain; connected browser shows actual API-backed records and analytics. No static-screen substitution found. Accessible interaction contract is incomplete below. |
| Cents, inventory, snapshots, atomicity | Strong implementation and concrete QA coverage: integer cents, snapshot preservation, immediate synchronous SQLite transactions, failed-stock rollback, competing/same-key fulfillment and persisted replay results. No additional financial-integrity defect found in reviewed evidence. |
| Tenant, role and session security | Workspace-scoped entity reads and ordinary post-revocation requests are protected. **FAIL at asynchronous request-body/write boundary:** stale authorization permits writes after rights/session revocation (R1). |
| Durability and owned files | Persisted sessions, memberships, entities, revisions, counters and idempotency; salted Argon2id; opaque owned attachment paths. QA's real restart and file-byte evidence support normal restart durability. Not a crash/fault-injection certification. |
| Accessibility and responsive quality | Coherent visual hierarchy, useful empty/error states, native dialogs/selects, real alerts and contained mobile board. **FAIL** exact names, duplicate Open controls and filtered-modal focus return (R2–R4). |
| Verification quality | Broad, meaningful public-HTTP QA plus real browser workflows and explicit limits. Counts alone are not acceptance: stalled-body revocation was missing, and ref-based browser interaction concealed contractual name ambiguity. Root verification checklist is not yet final. |

## Prioritized required corrections

### R1 · P1 · Writes retain authorization after membership/role/session revocation

**Location:** `server/routes/index.ts:215` captures `ctx` before asynchronous body reads; e.g. customers `225–231`, products `267–274`, upload `583–607`. Subsequent transactions reuse that context without rechecking current session/membership/role. This affects the general body-reading mutation pattern, not merely one endpoint. Identity member mutation already demonstrates reauthorization inside a transaction (`server/core/index.ts:465–467`).

**Actual connected reproduction:** run `NODE_EXE review/revocation.mjs` against the local app on `PORT`, with supplied external `DATA_DIR`. It creates its own synthetic owner/workspace/writers; sends headers and an incomplete request body; waits 600 ms; completes an owner role change/removal or writer logout; only then finishes the original body.

| Case | Required denial | Actual baseline |
| --- | --- | --- |
| Manager product create, then demote to member | 403 | **201**, product committed |
| Member customer create, then change to read_only | 403 | **201**, customer committed |
| Member customer create, then remove membership | 404 | **201**, customer committed |
| Member customer create, then revoke session through logout | 401 | **201**, customer committed |
| Member multipart attachment upload, then remove membership | 404 | **201**, attachment metadata committed |

Every case also advanced the workspace revision by **1 after revocation**. These are not speculative races or requests submitted only after removal: the client deliberately holds body completion while revocation is committed. Baseline focused regression exits 1 because all five protection expectations fail.

**Repair:** revalidate authentication, actual URL-workspace membership and the operation's required current role after asynchronous input/upload work, inside the synchronous write transaction immediately before any business/file/activity/revision write. Audit all business mutation branches, including fulfillment, invoice transitions, comments, CSV and attachments; do not fix only customers. Recheck author/manager delete permissions from fresh context wherever applicable. Never rely on a context obtained before an `await`.

**Acceptance:** all five focused cases deny with the documented statuses, no business/file metadata commit, no new mutation activity/revision; attachment failure leaves no owned blob. Add durable regression coverage and retain the ordinary tenant/role/atomicity suites.

**Evidence:** `review/revocation.mjs`; `DATA_DIR/review-evidence/revocation-results.json` (all five actual 201 responses and owner-visible commits; workspace `1f7f1de5d3cd3a26612baffecb609056`).

### R2 · P2 · Required exact accessible names are contaminated

**Confirmed QA-1:** `src/ui.tsx:39` wraps label, input and helper text in the same label. Inventory → New product → exact textbox **SKU** fails through the authorized client. Snapshot names it `SKUA unique stock keeping code. Stored in uppercase.` Judge independently reproduced this on the connected product (generation 213).

Other affected hinted fields identified by QA/source: **Quantity change**, **Attachment**, **Invite token**, signup **Password**. Preserve their specified names and associate helper text using descriptions, not label text; ensure generated IDs/associations work for inputs, file fields, selects and textareas. Password inputs must be tested by label/ref rather than assuming an implicit textbox role.

**Additional confirmed navigation case:** `src/App.tsx:74` includes the decorative shortcut in Overview's name. Exact `{"action":"click","role":"link","name":"Overview"}` fails; snapshot name is `Overview⌘ 1` (generation 215). Hide the decorative shortcut from the accessible name or explicitly label the link **Overview**. This is the same exact-name contract repair group, not a requirement waiver based on visible text.

**Acceptance:** exact required field labels work across hinted forms, helper text remains available as a description, and exact **Overview** navigation succeeds without a ref workaround. Recheck other named navigation/actions for accidental text contamination.

**Evidence:** `DATA_DIR/review-evidence/product-dialog.json`, `sku-exact.json`, `overview-exact.json`; QA's `sku-exact-label-check.json` and `inventory-new-label-check.json` under its evidence root.

### R3 · P2 · Duplicate same-name Open controls are material contract issues

**Judge decision: required repair, not merely a nonblocking observation.** For one unique record the product creates two buttons with the same required exact name: a clickable record title and a separate row/card action. Both target the same entity, but the mandated name cannot identify one control. Exact role/name interaction fails and keyboard users encounter redundant same-purpose tab stops.

**Locations:** `src/Customers.tsx:10`; `src/Sales.tsx:10,28`; `src/Projects.tsx:17,20` (customers, orders, invoices, projects and tasks).

**Reproduce:** Customers with synthetic **UI Avery revised** → exact button **Open customer UI Avery revised**. Judge's action fails as ambiguous (generation 210); snapshot has two distinct matching buttons. Projects similarly exposes two **Open project Studio launch** buttons; task board exposes two **Open task Prepare launch kit** controls. Source and QA evidence establish the same construction for orders/invoices.

**Repair:** expose one canonical, keyboard-operable button with each required `Open <entity> <record>` name per record; remove redundant interactive duplicates or give the genuinely retained alternate action a distinct, meaningful name. Do not solve this by abandoning the required canonical name or hiding a still-focusable duplicate from assistive technology.

**Acceptance:** one unique canonical control per unique test record; exact Open interaction reaches Customer details, Order details, Invoice details, the project board, and Task details without fresh-ref disambiguation. Recheck normal and read-only UI.

**Evidence:** `DATA_DIR/review-evidence/customers.json`, `duplicate-open-customer.json`, `projects-settled.json`, `status-exact.json`; actual source constructions above. QA's ref workaround is evidence of the gap, not proof that this contract passes.

### R4 · P2 · Filtered task edit loses keyboard focus on close

**Confirmed QA-2:** `src/ui.tsx:35` only restores the old element when connected, with no stable fallback. On Studio launch, compose search **NEEDLE**, High, In progress; edit **Prepare launch kit**, change Status to Done and save. Task correctly leaves the filtered board, but focus becomes document body.

Judge inspected QA's actual `task-edit-save.json`/`task-edit-check.json`: generations **95–96** both record `activeKind: body`, `tag: body`, `tabIndex: -1`. Source confirms no disconnected-trigger fallback. Judge did not complete an additional edited-task save; the finding relies on inspected QA browser evidence plus source, not a claimed independent second reproduction.

**Repair:** restore the initiating control when it remains usable; otherwise move focus to a stable relevant control such as Search tasks/New task. Account for a trigger that disappears during the subsequent resource refresh, not only one already disconnected at dialog cleanup. Preserve Escape handling, nested confirmation focus and normal focus return.

**Acceptance:** rerun the exact QA workflow and observe focus after the filtered results have settled; not body/hidden/disconnected content. Verify keyboard continuation and ordinary Escape close/return.

## Evidence reviewed and checks actually performed

Runtime evidence roots (outside source):

- `DATA_DIR` = `C:\Users\krish\Documents\Codex\vector-research-tools\paid-cycle\heavy-foundry-02\vector\support-data`
- QA evidence: `DATA_DIR/qa-evidence/`; judge evidence: `DATA_DIR/review-evidence/`.

**Judge executed:** real `bun run typecheck` passed; connected common-client navigation/observations and exact SKU, Overview and customer Open failures above; five stalled-body HTTP authorization reproductions failed protection expectations. All browser access was through `NODE_EXE BROWSER_DRIVER_CLIENT --endpoint BROWSER_DRIVER_ENDPOINT`, with action JSON on stdin. `review/browser.mjs` only records that client; no browser libraries, page evaluation, browser launch or direct browser connection were used.

**Actual QA evidence, not just aggregate claims:** read `qa/api.ts` and `qa/edges.ts` and inspected result payloads in `api-results.json` (**251**), `edge-results.json` (**73**) and `restart-results.json` (**21**, isolated port 4124). These substantiate tenant/error checks, cents/snapshot assertions, concurrency/rollback, CSV/file safety and persisted replay/session/membership/file bytes. Reviewed connected-browser wrapper/writer code and actual QA defect artifacts. The broad suites were not rerun by the judge; the parent's 137 core, 225 backend, 277 integration + 13 restart counts remain supplemental reported evidence rather than judge-executed passes.

**Visual:** judge opened QA's actual `overview-desktop.png` (1440×1000) and `project-board-mobile.png` (390×844). Dashboard shows meaningful $26.66 paid revenue/chart, genuine counts and task completion; mobile board uses contained overflow and coherent stacked filters. Typography is attractive but helper/status text is sometimes unnecessarily tiny/low-emphasis. Other screenshot/keyboard/live-role results remain QA evidence, not screenshots independently captured or every branch rerun by this judge.

**Scope discipline:** synthetic local accounts only, all judge runtime evidence under supplied `DATA_DIR`, no external services/deployment/company files/evaluator access. No verification server was started by the judge. Parent `127.0.0.1:4123` was intentionally left running and was not stopped or replaced; final parent shutdown remains required.

## Limitations and final recheck gate

- QA's documented browser file-picker, rejected-file browser alert/download-byte and native confirmation automation limits remain open limitations. HTTP checks and source inspection do not turn those unexecuted browser branches into passes.
- No judge full server restart, second browser context, clock-advanced invite expiry, crash consistency/fault injection, exhaustive payload/security audit, measured DOM horizontal overflow or measured contrast audit was performed. QA's isolated real restart supports its stated normal-durability coverage.
- The allowed driver reported some platform autofill requests blocked; application source has no reviewed dependency on external services. These blocked browser-platform requests are not application integration passes or application telemetry findings.
- Interim judge select/type attempts included action-shape/role-target errors. They are not counted as new product failures or passing keyboard flows. Raw named evidence preserves them; successful actions and material findings above are separately identified.
- `VERIFICATION.md` still marks QA/judge/browser/screenshots/shutdown pending. Parent must reconcile it with actual final evidence, preserving limitations rather than checking boxes from summaries alone.

**Required parent handoff:** fix R1 first, then all R2–R4; rebuild/restart only parent-owned verification infrastructure; resume the same QA for focused regression plus affected suites; resume this same judge to review the final repaired connected state and evidence. Final review must see the five revocation cases denied with no writes, exact-name browser actions working across affected domains, and settled filtered-task focus return. This baseline verdict is complete; final approval is explicitly withheld.
