# Unpaid validation record

This file records local instrument validation only. It contains no model output,
paid result, provider data, or product-candidate assessment.

**Freeze status:** the final local checks and unchanged-v1 negative gate completed
after production candidate `893b9629224dc4249f08c0e18712511437a35a22` was frozen.
External task hashes are now frozen. No paid holdout run was admitted or performed
at this freeze. The earlier draft publication had correctly marked runtime and
browser validation pending.

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
* The v1 lexical layer was refined to persist a SQLite token index and run lexical
  AND matching in SQL. It still has no v2 upgrade implementation. Its final
  isolated-copy typecheck, protected smoke (2 passed), and build all passed.
* The common-proxy correction was subsequently reported by its owner, with its
  separate pure controls and headless smoke passing. This holdout has not rerun
  its browser gate against that correction.
* Baseline gate attempt 02 used the corrected proxy and a private full copy of the
  preinstalled pinned dependencies. It completed as **product_failure**, exit 1,
  with all 26 rows executed: **3 passed, 23 failed, 0 not_run**. Source was
  unchanged and there were **0 instrument errors**. The v1 seed compiles, starts,
  imports, searches, and displays documents; missing v2 features produce the
  expected product failures. The original report, logs, source manifests, and
  final screenshot are retained privately. The exclusive Bun slot was released
  immediately afterward. No shared dependency junction or install was used.
* Final portable-loader review found a redundant `TASK.md` entry in the
  descriptor's seed-relative `protectedFiles`. The runner separately copies and
  protects the prompt. That redundant entry was removed while the evaluator's
  explicit public-prompt protection was retained independently. Effective source
  protection and acceptance checks are unchanged. Two pure regression controls
  were added; all **26 Python controls and 5 Node controls** pass, and the actual
  portable task loader accepts the descriptor. No Bun or browser rerun followed
  this metadata correction.
* Final source-freeze review corrected Windows newline translation in generated
  JSON: freeze metadata is written with explicit LF so Git normalization cannot
  alter its frozen bytes. The new CLI freeze/verify control passes. Final pure
  totals are **27 Python controls and 5 Node controls**, all passing.
  The copied lock also had CRLF working-tree bytes despite its existing committed
  LF blob. Its working-tree newlines were normalized to those already-published
  bytes; locked package content and versions did not change. This newline-only
  normalization followed the negative gate, with no further runtime rerun.
* External task-source hashes were frozen only after the production-candidate
  freeze and the local validation above. The manifest excludes only itself and
  standard dependency/cache/version-control directories. The portable runner
  additionally hashes the complete task, including the manifest.
* All raw gate artifacts, logs, databases, and browser profiles remain outside
  the published task tree. Ignore rules also guard against accidentally staging
  such outputs or Python caches here.

There is no full positive v2 reference implementation in this task. Pure positive
controls validate instrument assertions and report behavior; they do not establish
that a complete correct v2 app passes every acceptance check. The full unchanged-v1
gate is a negative control and must be assessed together with that limitation.

Retain all failing gate directories and append every instrument fault and
corrective rerun here. Attempt 01 must remain an instrument failure.
