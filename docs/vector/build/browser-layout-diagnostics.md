# Read-only browser layout diagnostics

Status: native and common browser diagnostics validated locally on 2026-11-02. Runtime source is frozen at `968307223f40318673361f5d09602c607a1af919`, based on the validated `661d3b36c34c68181d3b9c9b551862f8f40517ff` candidate. The paid Codex heavy arm had closed before the exclusive Bun/browser validation lease was granted. Nothing in the frozen baseline, canonical live runner, original task or corrected navigation evaluation was changed.

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

## Validation ledger, 2026-11-02

Runtime source under test: `968307223f40318673361f5d09602c607a1af919`. Windows; Bun 1.3.14; Node 24.22.0; Chrome 156.0.8078.79; Playwright 1.59.1. Existing pinned dependencies were reused, with workspace junctions retargeted to this candidate; no package install or dependency version change was needed. No provider credentials were read, no paid model calls were made and no cloud action was performed. The engine tests use only their local scripted provider fixtures.

All checks below passed with exit 0:

| Check | Command and working directory | Result |
| --- | --- | --- |
| Syntax and whitespace | Node `--check` on all 11 changed/new TS/CJS files; `git diff --check` | 11 parses passed; whitespace clean. Parsing alone was not treated as runtime validation. |
| Engine browser behavior | From `packages/engine`: `bun test test/tool/browser-format.test.ts test/tool/browser-actions.test.ts --timeout 90000` | 20 pass, 0 fail, 146 assertions; 54.54 s. Covers actual model-visible observe output, geometry/fence/unknown guards, credential redaction, handoff, research provenance and image capability. |
| Desktop page reader | From `packages/desktop`: `bun test src/main/browser-page.test.ts --timeout 30000` | 29 pass, 0 fail, 123 assertions; 0.842 s. Includes unknown geometry in happy-dom, credential guards, frame/shadow-root behavior and preserved focus. |
| Fixed numeric reader | From repo root: `node --test scripts/benchmarks/browser-driver/layout.test.cjs` | 2 pass, 0 fail. Runs the actual serialized implementation on bounded/invalid numeric inputs; not substituted for real browser evidence. |
| Real native/common geometry | `node scripts/benchmarks/browser-driver/layout-smoke.cjs --playwright-module <pinned package> --chrome <pinned binary>` | Both controls passed. At viewport 390x844, a 548-pixel uncontained table reports document width 548 and overflow 158; containing the same table reports document width 390 and overflow 0. Native/common readers agree; DOM, focus, scroll and viewport remain unchanged. |
| Full common browser driver | `node scripts/benchmarks/browser-driver/smoke.cjs --playwright-module <pinned package> --chrome <pinned binary> --out <new owned directory>` | 17 controls passed, 0 failed, 0 requests reached the denied server. Includes both geometry outcomes through actual action snapshots, untrusted marker preservation, origin/proxy restrictions, password masking, keyboard focus, refs and PNG output. |
| Engine types | From `packages/engine`: `bun run typecheck` | Exit 0. |
| Desktop types | From `packages/desktop`: `bun run typecheck` | Exit 0, including referenced package checks. |

An independent static reviewer found the separate native observe-output path and a synthetic fixture margin-collapse assumption before source freeze. Both were fixed in `9683072`. The integration regression now asserts that the geometry reaches actual BrowserTool observe output, not only its generic formatter; the synthetic heading margin is reset. Review found no remaining actionable code issue. No runtime source fix was needed after source freeze.

Sanitized machine-readable results are in `docs/benchmarks/browser-layout-v1/validation.json`. All fixtures are synthetic; none changes the paid task app. This validation establishes diagnostic behavior and preserved controls. It does not establish generated-app quality, lower bills, or a successful new paid study.
