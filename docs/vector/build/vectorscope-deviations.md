# VectorScope build deviations

Notes on where the code had to differ from `vectorscope-plan.md`. Each entry is
dated, names its work package, and is committed with the work it explains.

## 2026-11-03 · VS-01 Dataset contract

- **Schema form.** The plan's "manifest/schema" is the TypeScript types and the
  `manifestProblems` validator in `script/vectorscope-eval/dataset.ts`, with the
  field rules explained in `annotation-guide.md`. There is no separate JSON
  Schema file, so the manifest has one definition instead of two that could
  drift apart.
- **The seed is not frozen.** Freezing requires every held-out case to be
  adjudicated (D8: two model-assisted passes, the owner settles disagreements).
  The seed's labels are one draft model-assisted pass, so the dry run reports
  "not frozen" and prints the digest to record later. Freezing follows the full
  set's second pass and adjudication, which is the later dataset task.
- **Split rule details the plan leaves open.** Groups (shared repository or
  family) are ordered by their latest date, the fix date for bugs and the head
  date for controls; the oldest fill development and the newest are held out.
  Calibration and held-out each take round(n / 5) cases, so the seed's 8 bug
  cases split 4/2/2 and its 2 controls both land in development. Held-out has no
  controls until the full set's ~25 exist.
- **GitHub checks are recorded, not re-run.** The dry run makes no network
  request, so each case's read-only `gh api` check (commit existence, ancestry
  through the compare endpoint, licence through the licence endpoint) is
  recorded in `provenance.checked`. The dry run repeats the checks with git only
  against local mirrors (`--mirrors`); no repository was cloned for the seed.
- **`run.ts` changed although VS-01 does not list it.** `promptInput` moved
  from `run.ts` into `fixture.ts` and now takes a label-free `FixtureView`, so
  a test can show the synthetic fixtures' labels never reach the prompt. The
  prompts are unchanged: `run.ts --dry-run` output is byte-identical before and
  after, and a test pins the untrusted full-review input. No reviewer behaviour
  changed, so D3's opt-in does not apply.
- **The dataset tests are not in CI yet.** `script/vectorscope-eval/fixtures.test.ts`
  was not run by any workflow before this change and still is not; adding a
  step to `.github/workflows/test.yml` is left to the gate or the owner rather
  than edited by this package.

## 2026-11-03 · VS-02 Production replay

- **What the replay drives.** `ReviewEval.replay` (`packages/engine/src/review/eval.ts`)
  runs the engine's `Review.run`, which the CLI and the GitHub job share, over
  `ReviewSource` and `ReviewContext` as a first review of a pull request. It
  does not drive or edit the GitHub job (`github.review.ts`, which @vector
  owns). The job's first-review posting (one review with the line comments,
  then the summary with its state marker, or only the failure note, plus the
  generated-header and inline-cap notes) is rebuilt in `eval.ts` from the same
  core builders. Prior state and threads, the running summary and its
  checkpoints, reactions, re-anchoring after the head moves and the 422 split
  are not exercised, since the recording adapter accepts every write. Replaying
  the CLI, GitHub and desktop surfaces against each other is VS-10.
- **The automatic skips are not evaluated.** A replay runs on a writer's
  request (`trigger: "command"`), so `decideSkip`'s size, fork, author, label
  and budget rules do not apply, as they do not to a command. The
  nothing-to-review note is replayed.
- **The posting check is supplied by the caller**, as the CLI's `posting`
  dependency is. The tests pass a recording check that sends every part
  through, and one that refuses; they do not run the memory-backed
  `SessionPosting.headless`, which needs the brain services.
- **Models come from the harness.** A `triageModel` in the base's
  `review.json` is not resolved by the replay; the eval passes `triage`
  itself, because it chooses the candidate models (D6). Linked requirements
  from the user's own documents are never included: CI does not have them, and
  they must not reach an eval.
- **`context.ts` is unchanged.** `ReviewContext.gather` already takes a
  base-commit reader and keeps its limits; the replay records a digest and
  counts of what it gathered. `source.ts` gained two additive reads,
  `missingCommits` (no fetch) and `show`.
- **`run.ts` gained only an observer.** `RunInput.observe` sees each pass's
  prompt and every provider attempt (admitted or refused, with the model and
  API it went to) and each settlement. It is off unless set and is not a change
  to reviewer behaviour, so D3's opt-in is the hook itself. A new test shows the
  same review sends the same requests and returns the same outcome with the
  hook off, on, or throwing, and the existing `test/review/run.test.ts` passes
  unchanged.
- **The desktop replay is a documented stub.** The desktop runner reviews
  through an injected SDK client, which needs a running engine server, and
  nothing here may start Electron or a server. `replay.ts --adapter desktop`
  reports it unavailable and why. Its replay comes with VS-10.
- **The driver stops at the plan.** `script/vectorscope-eval/replay.ts` builds
  each case's replay input from `caseView` alone and can prepare checkouts with
  local git, but it has no path that runs a model: a paid replay needs VS-03's
  budget ledger and the D7 environment, and the engine has no script entry
  point for it. Adding one (a CLI command or a runtime bootstrap) is left to
  VS-03 with its admission, rather than shipping new CLI surface now (D14).
- **`script/vectorscope-eval/replay.test.ts` is new and, like VS-01's tests,
  not run by any workflow yet.**
