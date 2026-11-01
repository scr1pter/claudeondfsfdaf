# A25: desktop, terminal and machine output

A25 implements label-plan C8–C10. A24's final scoped acceptance is recorded in [its notes](codium-a24-app-usage-notes.md): the complete 10-job run at `975b523b` passed before A25 publication. The clock-only repair is also present on canonical `codium` as `d505d566`.

## Accounting and desktop records

Desktop spend events, folded days and windows carry an optional Codium marker for mixed activity. Only own dollars and own tokens enter those totals. Codium-only runs append no dollar-ledger event; later Codium activity can annotate an existing mixed event without adding a second charge. The run projection compares before/after counters and the current guard, so a recurring session's previous Codium activity does not label a later own-key run.

Known positive guard spend is retained even when the same run has unknown own work or its session total was reverted, unavailable or lower: measured own cost is the larger available subtotal. Unknown own work remains `costKind: unknown`, independently of `billing: codium`. This separation flows through optional `Task.Info.billing`, desktop IPC/preload and Agent Desk. The task bridge carries known cost and unknown status without inventing token usage.

Initial and old desktop cards can project Codium from their existing pinned Vector provider. In particular, an old pinned Codium `$0.00` card renders Codium. A same-zero own-provider record is not relabelled. This read projection does not persist provider inference as measured activity. A23's admission gates remain intact: resumed scheduled agents inspect the actual session model; parallel workspaces use the provider pinned to the new session they create.

Independent C8 review found and closed the positive-guard-subtotal, direct-card unknown-status and legacy zero-price projection cases. Regressions preserve the own subtotal and unknown/free/plan wording alongside Codium.

## Terminal and command output

The TUI prompt, subagent footer, Context sidebar and delegated breakdown use Codium labels. A current Codium context reading can show only the context percentage. Loaded legacy evidence masks inseparable delegated token totals and retains known own dollars; no new eager reads or polling were added. Dollar-cap text is absent for zero own spend. Task presentation shares one narrow Core formatter between CLI and TUI, preserving modern own counts and masking inseparable legacy totals.

`vector stats` filters V1 assistant and V2 assistant/compaction records by billing identity before summing or printing. It keeps Codium activity and helper attribution, own figures and own model rows. Legacy all-time aggregates with more observed Codium messages than recorded Codium steps are reconstructed from own messages. Codium-only statistics and model rows show labels and point to `vector codium`, without zero dollar prices or token figures. Mixed token averages exclude Codium-only sessions.

Interactive run output sums own spend and adds Codium. Switching from own-key context to a Codium model with an unavailable context limit clears the previous raw token reading. `--max-cost` explains that Codium steps are excluded. Verbose model output uses the billing marker instead of zero catalog rates.

## Structured boundaries

- `run --format json` projects root and subagent step-finish parts with `billing: codium`, `cost: 0`, `unpriced: true` and no tokens. The internal part is unchanged.
- Task list/inspect/wait JSON projects legacy attributed usage without inseparable token fields. Modern own usage and the raw API result are unchanged.
- New, cached and failed review JSON outcomes omit Codium numeric cost/token fields. Mixed aggregates retain known own dollars; explicit own passes retain their own figures. A legacy aggregate that cannot partition tokens omits those aggregate token categories. A26 still owns human review footers and durable per-pass cost-kind state.
- ACP sums only own steps for per-response usage, including aborted responses, and sends no `usage_update` while the latest step is Codium, even if it has zero output and an older own response supplied the last context sample. Existing cost omission when any step is unpriced/Codium remains in force.
- Codium document-distill estimates, results and History omit token/cost figures. Internal estimates remain available for context checks. Old stored History is also projected on read using explicit billing/cost kind or the recorded Codium provider prefix; document and record history preserve own receipts and leave stored bytes unchanged. Public HttpApi/SDK fields are optional for that reason. CLI human and JSON distill output preserve the distinction; own responses retain their measurements.
- Legacy `export --sanitize` removes Codium assistant/step tokens and unsafe legacy session totals, including an explicit Codium step under an older own-provider assistant and migrated zero counters. Partitioned own totals and own parts remain; the raw backup object is not mutated. Native sanitized export already uses the public preview and is unchanged.

## Generation and validation

The legacy SDK generator and `packages/client` generator ran sequentially through the global lock. Legacy SDK changes are limited to optional distill figures and `Task.Info.billing`; the new Client generator produced no diff. Initial legacy-generator attempts stopped on read-only default XDG data/state paths before successful generation; the successful run supplied all four XDG directories beneath `/tmp/vector-codium-a25`. No home directory or credential settings were changed.

All local tests run one named file at a time in their owning package with a 30-second per-test timeout and `/workspace/.tools/vector-serial`. An initial engine test failed before any cases because the sandbox prevented the strict network guard's localhost proxy; localhost-capable reruns use the same network guard and no live model request. The desktop scheduler's unrelated DST subprocess cases need the absent Electron binary; focused billing cases are used locally, with full platform checks reserved for GitHub. No dependency install or local Electron/Playwright/build suite was launched for these checks.

The C8–C10 checkpoint has **347 passing focused cases across 24 files**: Desktop 92 (five files), App 98 (four), TUI 22 (four), Engine 118 (ten), and Core 17 (one). App, Core, Desktop, Engine and TUI typechecks pass. Initial type checks identified fixture literal/readonly narrowing and optional result fields; those were corrected without weakening assertions. Core History and the TUI sidebar import the global service before their fixtures and therefore also required scoped XDG directories for successful runs.

Independent review closed six additional output-boundary findings: explicit own unknown status in legacy task/TUI/app projections, zero-output latest-Codium ACP suppression, persisted History read projection, and task JSON redaction. The same review identified the separate aggregate-provenance amendment below. This checkpoint is reviewable and tested, but **A25 is not complete**. Pushed-head scoped CI and the final production navigation benchmark must cover the completed amendment, not merely this checkpoint.


## Compatibility amendment still required

Independent review identified an A22/A24 accounting provenance gap: A22 deliberately retained old flagless Codium tokens in session aggregates. Resuming such a session adds positive modern Codium counters without removing those old quantities. A positive counter alone therefore does not prove an aggregate contains only own tokens. Existing task/TUI heuristics cannot safely label all such mixed historical aggregates. A25 remains open until a durable provenance/read-projection amendment prevents this leak while retaining proven own figures and stored history; the final review and benchmark gates must cover that amendment. This limitation is not dismissed as an accepted legacy behavior.
