# Delivery outbox calibration reference

`source/` is the exact complete-product control constructed from the public v1 task and seed for evaluator calibration. It is **not a paid coding-arm deliverable**, a production candidate, or a runtime-winner claim. The coordinator confirmed both Task 3 paid arms completed and settled before authorizing this publication. The reference remained private throughout those arms.

All **15 source files** match the original frozen private snapshot byte for byte. Their aggregate SHA-256 is `8d5b30a010beefa5b87b594240014420ccdac3956d88508ab55ae2fae1300e34`. `SOURCE-MANIFEST-v1.json` preserves the original manifest bytes and maps names relative to `source/`. The aggregate is SHA-256 of the map serialized as UTF-8 JSON with sorted keys and separators `,` and `:`. `source/** -text` in `.gitattributes` preserves raw bytes in Git. No redaction or code repair was needed. The historical `source/REFERENCE-NOTES.md` retains its original private-authoring description.

The curator performed inventory, byte-copy and sanitization work only. No Bun command, app, browser, provider request, test, qualification rerun or network call was executed for this publication. Databases, dependency directories, logs, profiles and paid outputs are outside this artifact. All application/provider records are synthetic.

## Previously executed calibration

These results were executed during qualification before final Task 3 freeze, rather than by the publication curator. The frozen [validation record](../../delivery-outbox/VALIDATION.md) and [qualification metadata](../../delivery-outbox/QUALIFICATION-v1.json) were committed in `770dbe484ab2479f8ff41edc9b22a9f98c2a911f`. `PROVENANCE-v1.json` supplies sanitized report hashes, original source provenance, versions, all eight exact actual-envelope helper file hashes, and retained earlier-attempt counts.

| Existing control | Observed result |
| --- | --- |
| Seed and reference package checks | Typecheck, build and public smoke passed for each; each smoke run had 1 test and 7 assertions. |
| Complete reference, actual envelope helper | 26 passed, 0 failed, 0 not run; exit 0; source and instrument unchanged; no instrument error. |
| Complete reference, earlier old-focus helper | 26 passed, 0 failed; source and instrument unchanged. |
| Unchanged v1 negative | 4 passed, 22 expected upgrade failures, all 26 rows executed; product failure; source and instrument unchanged. |
| Protected local provider | 10 of 10 controls passed; source unchanged. |
| Pure Python controls | 63 passed, 0 failures/errors. |
| Browser transport controls | 10 Node controls passed; seed and reference JavaScript syntax checks passed. |

Five separate copies received one semantic fault each. All five gates executed 26 rows, classified product failure without an instrument error, and preserved app/instrument bytes.

| Injected fault | Passed / failed |
| --- | --- |
| Rotate the provider key on retry | 23 / 3 |
| Claim cancellation after acceptance | 24 / 2 |
| Forget queued work on restart | 24 / 2 |
| Claim delivery after unconfirmed failure | 20 / 6 |
| Under-count replay attempts | 21 / 5 |

Earlier free attempts remain part of the history. Seed negatives 1 and 2 exposed instrumentation attribution/cleanup-classification defects and were superseded after repair. Seed negative 3 explicitly reported instrumentation failure, with eight browser rows not run. Seed negative 4 and reference positives 1/2 passed their own earlier projections and were retained, not relabelled as final-byte evidence. The old-focus and actual-envelope helper profiles differ in raw line endings for three files; all eight files are equal after CRLF-to-LF normalization. Each exact raw profile received a full positive gate. No semantic-mutant rerun was claimed for that line-ending-only variant.

## Byte verification and reproduction

Before installing dependencies or producing generated files, run `python -B verify.py`. It checks the exact fifteen-file source inventory and original aggregate without executing the application. After coordinated staging, `python -B verify.py --git-mode index` compares every publication file directly with its actual staged Git blob. After commit, `--git-mode head` compares committed blobs. These commands never stage, commit or contact a remote.

For runtime reproduction, copy `source/` into a separate owned app directory. Use its pinned Bun 1.3.14, Node 24.22.0 and dependency lockfile, and use the frozen [task descriptor](../../delivery-outbox/task.json), evaluator and [common browser driver](../../../../../scripts/benchmarks/browser-driver/README.md). Follow the common driver configuration for installed Chrome/Playwright paths; the exact qualified versions and helper hashes are in `PROVENANCE-v1.json`. Keep `DATA_DIR` and evaluation output outside application source, use loopback `PORT=4123`, and keep the independent evaluator outside the app workspace. Dependency installation and runtime reproduction are separate work, not publication-time results.

The reference addresses this finite synthetic task: one Bun application/provider process and local durable SQLite effects. Browser checks provide bounded semantic observations, not a complete DOM or pixel oracle. API attempt counts are compared with actual fixture wire logs. This publication does not claim clustered-worker, real-provider or real-cloud behavior. The frozen `delivery-outbox/` task is unchanged by this separate reference directory.
