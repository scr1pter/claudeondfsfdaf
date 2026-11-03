# Read-only browser layout diagnostics

Status: source and tests prepared; syntax checks passed. Runtime tests and package typechecks are **not run** while the paid Codex heavy arm owns the Bun/browser lease. This branch is based on the validated `661d3b36c34c68181d3b9c9b551862f8f40517ff` candidate. Nothing in the frozen baseline, canonical live runner, original task or corrected navigation evaluation was changed.

## Why this change exists

The unchanged Vector heavy-task delivery had document widths of 548, 499 and 503 CSS pixels on Customers, Inventory and Orders at a 390-pixel viewport. Those are observed product-output defects, retained in the study. QA and judge completion did not demonstrate that the mobile document-fit requirement was met. A viewport screenshot can make clipped or horizontally overflowing content difficult to diagnose, while a contained scrolling table is a valid alternative.

Inspection found no top-level viewport/document/scroll geometry in the native engine `BrowserReport.observed` or its desktop `observePage` producer. The desktop host's separate window bounds were not exposed as page layout evidence in that model report. The common benchmark browser also lacked these diagnostics.

## Native product change

`observe` now includes optional `observed.layout`, containing six finite numeric CSS-pixel fields:

- `viewportWidth`, `viewportHeight`: the page's top-level window dimensions.
- `documentWidth`, `documentHeight`: maximum root/body scroll dimensions.
- `scrollX`, `scrollY`: current top-level scroll position.

The formatter derives `horizontal overflow = max(0, documentWidth - viewportWidth)` and places the dimensions and overflow inside the existing untrusted web-page fence. It rejects invalid types, non-finite values, non-positive dimensions, or magnitudes above 100,000,000; absent or invalid geometry is explicitly unknown. It does not infer that a page is usable merely because overflow is zero.

The reader does not resize, scroll, focus, change page styles, request network data or execute caller-supplied JavaScript. It reads only the top document. A wide child inside an independent scroll wrapper does not necessarily enlarge that document. No new browser action, arbitrary scripting endpoint, permission bypass, Protocol/HttpApi or persisted schema was added. Desktop preload uses the existing `Observed` type; no generated SDK source is edited or requires regeneration.

## Common instrument change

Only this isolated branch's common driver is changed. Every future successful action/error snapshot obtains the same six fields under `layout`, retains `untrustedPageData: true`, and reports invalid/unavailable geometry as `null`. Both future benchmark arms must use the same pinned driver and client. Current paid arms and historical source/result manifests remain immutable.

This common-driver improvement is a methodology change, not a demonstrated product cost saving. Native diagnostics may make a real defect easier to identify, but add observation bytes and do not force the model to fix it. No claim of cost reduction, completion or quality improvement is supported until a new frozen study measures those outcomes.

## Validation ledger

Completed without starting services or browsers:

- `git diff --check`: exit 0.
- Node 24 `--check` on the modified native page observer, native report formatter, their test files, common server/client/smoke, fixed layout reader and two layout test scripts: exit 0. These are parsing checks only, not executed tests.

Not run, pending the exclusive runtime lease:

1. From `packages/engine`, `bun test test/tool/browser-format.test.ts test/tool/browser-actions.test.ts`. Covers bounded layout, missing/invalid geometry, zero overflow, and page-fence injection rejection alongside existing fence checks. The actual BrowserTool observe execution test also asserts layout reaches its separately constructed fenced output (not only the generic report formatter).
2. From `packages/desktop`, `bun test src/main/browser-page.test.ts`. Existing real DOM tests use happy-dom, which has no layout engine; the new control requires unknown geometry there.
3. Node `--test scripts/benchmarks/browser-driver/layout.test.cjs`. Exercises the actual serialized fixed reader, finite bounds and unknown values using controlled numeric inputs, without pretending that this supplies browser layout evidence.
4. Node `scripts/benchmarks/browser-driver/layout-smoke.cjs --playwright-module <pinned package> --chrome <pinned binary>`. Runs both actual native and common readers in real Chromium at viewport 390x844: an uncontained 548-pixel table must report 158 pixels of overflow; an independently contained table must keep document width 390. The readers must agree and leave DOM, focus, scroll position and viewport unchanged.
5. Node `scripts/benchmarks/browser-driver/smoke.cjs --playwright-module <pinned package> --chrome <pinned binary> --out <new owned directory>`. Extends the existing transport-fenced smoke with both real fixture outcomes and verifies the untrusted snapshot marker remains true. Prior origin, keyboard, credential and screenshot controls remain present.
6. Package `bun run typecheck` in engine and desktop, with package dependency prerequisites if needed. No direct `tsc` invocation.

All fixtures are synthetic. None changes the paid task app. Runtime checks not run above must not be represented as passed.
