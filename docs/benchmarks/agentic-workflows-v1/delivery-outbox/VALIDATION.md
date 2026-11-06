# Delivery outbox v1 â€” qualification and freeze record

Status: **runtime-qualified on both the old-focus and actual envelope browser profiles**. Runtime qualification alone is not admission for a paid Task 3 arm. The independently reviewed `FREEZE-v1.json` is the authoritative final manifest; a paid arm requires that manifest committed and physical/Git bytes verified.

Production candidate `a35c03d6a9bb16f16ec0187ad69c6c6420d10f19` was frozen before final qualification/review. The author did not inspect candidate source or paid coding outputs/reports. All app/provider data are synthetic; no model/cloud calls, accounts, real recipients or provider credentials were used. No production code was changed.

Exact qualified runtime projection: `fef0795777b1f0872e6d1fdf6204a4b47b6cca0e670d43be602ebfc1f931a780`. This binds the public task, descriptor, inventory, seed, evaluator and line-ending attributes. Private reference source: `8d5b30a010beefa5b87b594240014420ccdac3956d88508ab55ae2fae1300e34`. Reviewed private index `qualification-record-v1.json`: SHA-256 `321c40a864657777c65e04c9fe906b66f8d2d0f79b9f1339b1e161c641f06d62`, under evidence directory `outbox-qualification-20261102T024945Z`.

Executed results on that runtime projection:

| Control | Result |
| --- | --- |
| Unchanged v1 seed | Typecheck, build and public smoke pass; smoke has 1 real-process test and 7 assertions. |
| Complete v1 negative | 4 passed / 22 expected upgrade failures; all 26 rows executed; product failure, no instrument error; app/instrument unchanged. |
| Private reference | Typecheck, build and public smoke pass; full gate 26/26 on each exact raw helper profile; app/instrument unchanged. |
| Protected provider | 10/10 controls including failure/cancel barriers, idempotency, durable receipts, Unicode code-point limits and verbatim body text; source unchanged. |
| Pure Python | 63/63 executed and passed, including final freeze-check and mocked Git-byte controls. Actual Git-byte comparison remains coordinated with final freeze/staging. |
| Browser transport | 10/10 Node controls; seed and reference JavaScript syntax pass. |
| Narrow evidence | Queued/delivered 390px screenshots inspected; status, controls and details reachable. Desktop has semantic interaction evidence; no pixel-style score is claimed. |

Five separate private copies each received one real semantic fault. Every run retained all 26 rows, was product failure, had no instrument error, and left app/instrument unchanged:

| Fault | Passed / failed | Intended detection |
| --- | --- | --- |
| Rotate provider key on retry | 23 / 3 | Stable-envelope retry and lost accepted-response replay. |
| Claim cancellation after acceptance | 24 / 2 | Accepted receipt wins cancellation, including visible outcome. |
| Forget queued work on restart | 24 / 2 | Durable admission and narrow restart workflow. |
| Claim delivered after unconfirmed failure | 20 / 6 | Receipt-backed truthfulness on failure/lost-response paths. |
| Under-count replay attempts | 21 / 5 | Actual provider-wire attempts and crash/retry history. |

Earlier free attempts remain intact and are classified in `FREE-VALIDATION-DRAFT.md`. They were never treated as paid results or used to select a winner. The v1 seed retains direct send; the private reference was not copied into seed/protected fixtures.

The actual planned envelope driver received its own complete reference gate: **26/26, exit 0**, no instrument error, app/instrument unchanged, runtime projection unchanged. Report SHA-256: `4af3c633ee1d195ae7cc9eabd847c421fc5fcea1ebbd39013826eeaefa5cfaec`; separate exact-profile evidence `envelope-profile-qualification-v1.json`: `edefbd512832f46970ec319ef85f1eeccee694b0b3aea6cb4ceaa392a9ca038f`. Its raw helper map exactly matched the preregistered planned map and is recorded in `QUALIFICATION-v1.json`. The earlier old-focus profile differs physically only in `README.md`, `server.cjs` and `smoke.cjs`; every helper file is exactly equal after CRLF-to-LF normalization, and all remaining files are raw-byte identical. The two profiles are not physically identical. Unchanged semantic mutants were retained without repetition for this line-ending-only variant.

Cleanup verifies 64 owned browser directories removed after owned process shutdown, plus four exact owned leftovers from a superseded attempt. Port 4123 was free at slot release. No unrelated paths/processes were touched. Only seven native Windows path variables reach the browser; fresh short temporary parents are atomically owned. Existing user browser profiles are never opened.

Limits: driver observations are bounded semantic evidence, not a complete DOM or pixel oracle. Attempt-count UI presence uses bounded text; API attempts are independently compared with real fixture wire logs. Proxy-only denied traffic is unattributed and never a product-failure signal. This finite workload has one Bun app/provider process and local synthetic effects, with no clustered-worker or real-cloud claim.

Finalization: independently review final metadata, then freeze the pinned candidate/current runtime projection. `python -B tools/freeze_v1.py --check` verifies manifest, LF and bytes Git would store; after coordinated staging add `--git-mode index`, and after commit `--git-mode head` to verify actual blobs. Previews never freeze, stage, commit, publish or authorize paid work. All authored physical UTF-8 LF source must equal its corresponding Git blob bytes.
