# Unpaid validation record

This file records local instrument validation only. It contains no model output,
paid result, provider data, or product-candidate assessment.

**Draft publication status:** authoring is complete, but the latest seed has not
completed its final runtime rerun or browser gate. This draft is not admitted to
the study. Publishing its source does not freeze its external source hashes.

* Pure Python syntax compilation and Node syntax checks passed during authoring.
* Pure positive/negative controls passed initially: 21 Python tests, 4 Node tests.
* Seed typecheck, protected smoke (2 tests), and build passed in an isolated copy
  using the preinstalled pinned dependencies. No package content or lock changed.
  The initial whole-directory dependency junction did allow Vite's default config
  loader to touch the existing `.vite-temp` directory transiently; no files remain
  there. This was identified from its timestamp and reported. The unnecessary
  Vite configuration file was removed so later seed builds use Vite's defaults
  without this config-loader write. The shared directory was not removed.
* Baseline gate attempt 01: **instrument_failure**, source unchanged; 1 API group
  passed, 17 failed for missing v2 behavior, and 8 browser checks did not run.
  The common proxy crashed under Chrome startup with an uncaught socket
  `ECONNRESET`. Its original failing output and logs are retained privately.
  No browser correctness result is claimed. The exclusive Bun slot was released
  immediately afterward; no owned Chrome process remained.
* Independent unpaid source review found and corrected two browser observation
  races (legacy import completion and restart-page content), malformed-response
  classification, and response-body reset/timeout classification. Controls were
  added for malformed JSON shapes and UTF-8 empty-range/token boundaries.
* Revised pure controls pass: 24 Python tests and 5 Node tests. No Bun, browser,
  provider, or application reference implementation is used by these controls.
* The draft v1 lexical layer was refined to persist a SQLite token index and run
  lexical AND matching in SQL. It still has no v2 upgrade implementation. Its
  typecheck, smoke, and build need the same final isolated-copy rerun.
* The common-proxy correction was subsequently reported by its owner, with its
  separate pure controls and headless smoke passing. This holdout has not rerun
  its browser gate against that correction.
* Full baseline browser gate: pending a new exclusive runtime slot. The latest
  seed's typecheck, protected smoke, and build also await their final rerun after
  source edits. The unmodified seed should produce product failures for the
  requested upgrade, while compiling, starting, and preserving its v1 features.
* External task-source hashes: draft; freeze only after production-candidate freeze.
* All raw gate artifacts, logs, databases, and browser profiles remain outside
  the published task tree. Ignore rules also guard against accidentally staging
  such outputs or Python caches here.

There is no full positive v2 reference implementation in this task. Pure positive
controls validate instrument assertions and report behavior; they do not establish
that a complete correct v2 app passes every acceptance check. The full unchanged-v1
gate is a negative control and must be assessed together with that limitation.

Retain all failing gate directories and append every instrument fault and
corrective rerun here. Attempt 01 must remain an instrument failure.
