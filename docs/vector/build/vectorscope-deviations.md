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

## 2026-11-03 · VS-03 Budgeted manual CI

- **A new entry point, `ci.ts`.** The row lists the eval driver, the workflow
  and `budget.ts`. Validating the dispatch inputs without a shell needs a
  script for the workflow to call, so `script/vectorscope-eval/ci.ts` (`plan`,
  `paid`, `report`) reads the inputs from environment variables, validates
  them and starts `run.ts` with an argument array. No input chooses the
  endpoint the key goes to, and the child process gets only the eval key and a
  path.
- **`run.ts` is a dry run by default.** Phase 0 asks for a no-network dry run
  by default, and `run.ts` used to send whenever `--model` was given. It now
  sends only with `--budget-usd` and `--case-budget-usd`, which also need
  `--price` and `--max-tokens`, and each request (the retry without a JSON
  schema included) is admitted by the ledger first. `--dry-run` output with no
  price is byte-identical to before, and a test pins the request bodies to the
  ones sent before. No reviewer behaviour changed, so D3's opt-in does not
  apply.
- **Prices are owner input.** No price catalog is committed and a dry run
  cannot fetch one, so each model is given with its price (`model=input:output`
  in the workflow, `--price` locally), which is recorded in the report as the
  pricing snapshot. A price set too low is caught at the first settlement above
  its reservation, which stops the ledger. A paid workflow run refuses a price
  of zero, since a zero estimate bounds nothing.
- **Choices the plan leaves open.** Input is estimated at two characters per
  token over the whole request body and output at `max_tokens`. A tenth of the
  total is held in reserve. A case is one fixture or dataset case reviewed once
  by one model, with its retry and its judge calls. Missing usage keeps the
  whole reservation as uncertain spend. Unreadable usage, an overshoot, an
  unpriced model or a cancellation stops new work, and a journal that was
  stopped or cancelled stays that way for later processes.
- **Replay admission is per case.** `Review.run` already admits each provider
  attempt, retries and the finalizer included, against `maxCostUsd` when its
  models are priced. Rather than add a second gate inside the engine runner,
  `admitReplay` (`replay.ts`) reserves the case's whole bound in the eval
  ledger and hands it to the review as its cap, then settles the case from the
  artifact's attempts. Unpriced models are refused. No engine file changed.
  There is still no engine entry point that runs a paid replay; VS-02's note on
  that stays open.
- **The judge is not built.** The ledger has a `judge` attempt kind charged to
  the case it judges; VS-04's judge must admit its calls through it.
- **The environment is referenced, not checked.** GitHub creates a missing
  environment unprotected the first time a job names it. The key is documented
  as an environment secret only, so such a run has no key and stops before it
  sends anything. The workflow does not query the environment's protection
  rules through the API.
- **Additions the row does not name.** Model output printed by the paid step is
  wrapped in `::stop-commands::`, and step summaries are HTML-escaped inside
  `<pre>`, so model text cannot issue workflow commands or add links. A
  `report` step summarises the journal after a failed, timed-out or cancelled
  run.
- **`replay.ts` type fix.** Type-checking the eval scripts found an existing
  optional-chaining error (`repository?.url.replace`), fixed as
  `repository?.url?.replace` with no change in behaviour.
- **How the scripts were type-checked.** `script/` is outside every package's
  tsconfig, so the eval scripts were checked with a temporary config that
  extends the engine's and includes the engine's own declaration files. It
  reports no errors. No package's code changed, so no package typecheck or
  generator was needed.
- **The new tests are not in CI yet.** `budget.test.ts`, `run.test.ts` and
  `ci.test.ts`, like the earlier eval tests, are not run by any workflow.
  Adding the step is left to the gate or the owner.

## 2026-11-03 · VS-04 Causal judging and gate

- **Where the modules are.** The causal scoring is in core `review/eval.ts`:
  verdicts, settlement, per-run scoring, metrics and intervals. Two new core
  modules hold the rest. `review/eval-judge.ts` has blinding, the `Matcher`
  interface, judge orchestration and disputes. `review/eval-report.ts` has the
  report, the gate and its rendering. All three are pure and run under Node.
  The command-line tools are `script/vectorscope-eval/judge.ts` (worksheets)
  and `report.ts` (offline re-scoring), with the rubric in `judging-rubric.md`.
- **The gate config is one constant.** D2 is encoded as `DEFAULT_GATE` in
  `eval-report.ts`, with its approval (owner, 2026-11-03). There is no separate
  JSON file to drift from it. `report.ts --print-gate` writes it as JSON, and
  `--gate <file>` takes an owner-edited copy, which `gateProblems` validates.
- **The legacy scorer is unchanged.** `scoreReview` and `totalScores` keep
  their line matching and their convention that an empty denominator is 1,
  because `run.ts` still uses them as the smoke test's quick check. Their tests
  pass unchanged, and `run.ts` output is unchanged. The causal metrics never
  use them: an empty denominator is null and is shown with its counts.
- **No reviewer behaviour changed, so D3's opt-in does not apply.** No engine
  file changed. Core `review/eval.ts` is imported only by the eval scripts and
  tests, never by the reviewer.
- **Settlement rules the plan leaves open.**
  - Two distinct judges agreeing settle a verdict, whether human or model. The
    report counts how many agreements had a human pass.
  - A human adjudication settles any verdict. A single pass settles nothing,
    and a model never adjudicates.
  - Agreement means the same verdict kind, and the same defect for a match.
  - A model's pass on a run whose findings that model helped produce (the review
    or triage model) is refused. `judgeRuns` refuses a model judge that reviewed
    any run in the batch, since a blinded judge cannot tell whose findings it
    sees.
  - Passes under another `RUBRIC_VERSION` are stale.
- **Scoring choices.**
  - Duplicates are derived, not judged: within a run, the first finding on a
    defect or extra issue counts and later ones are duplicates. Duplicates stay
    in the precision denominator, which is stricter than leaving them out.
  - An extra issue's name is prefixed with the judge it came from, so names
    from different judges are never merged.
  - Nits are left out of judging and precision unless the gate counts them.
  - A finding is keyed by path, lines and title, not body, because selection
    appends an "also at" sentence to a posted finding's body.
- **Blinding.** A task is one run's findings beside its case's labels. Opaque
  ids come from a seed kept only in the coordinator's judgement file, and tasks
  and findings are ordered by those ids. Tasks are per run, so a judge call is
  charged to the run's own ledger case, as VS-03 defined a case.
- **Intervals.** Proportions use Wilson score intervals, per-PR rates exact
  Poisson intervals, and the paired recall difference Newcombe's method 10.
  Precision's interval treats findings as independent, though findings in one
  pull request are not. The report says so, and a human decides any rule its
  interval cannot settle.
- **How the gate reads D2.** It counts posted findings, at 95% confidence,
  without nits, for one named candidate against one named frozen pipeline.
  - Trust, accounting and coverage are decided on the observed value. The
    statistical rules pass or fail only when the whole interval is on one side,
    and otherwise go to human review, as they do while their findings are
    unjudged.
  - "No trust/consent regressions" is read as no failed check in the
    candidate's runs, which is stricter than comparing with the baseline.
  - "No unaccounted paid attempts" counts runs that sent paid attempts the eval
    ledger did not admit, unplanned runs included, plus paid judge calls it did
    not admit and attempts left open in it.
  - Paired recall pairs each labelled defect by case and repetition, end to
    end.
  - A release decision needs all of: a held-out run, a frozen manifest, results
    collected on or after the gate's approval date, and no input or judging
    problems.
- **What saved outputs can show about trust.** A replay artifact is checked
  for three things: it was reviewed untrusted, it reviewed the case's own
  candidate commits, and the fix commit does not appear in what would be
  posted. Adversarial trust and consent suites (MCP, fixes) belong to later
  packages and are not inputs yet.
- **How replay artifacts map to runs.**
  - An artifact that reviewed nothing (every file skipped) is partial, as is
    one whose verify pass failed or timed out.
  - Posted findings are the line comments when the review write went through,
    and the summary's lists when the summary went through.
  - A replay's paid attempts count as accounted for only when a ledger journal
    (`--ledger`) holds `admitReplay`'s admission.
  - Artifacts record no start time, so a held-out replay is never a release
    decision until the paid replay driver records when it ran.
- **`budget.ts` now exports `readJournal`**, so the report can see which runs
  the ledger admitted. Its behaviour is unchanged.
- **No model judge is connected to a provider.** Worksheets record people only,
  and `import` refuses a `model:` judge. A model judge runs only through
  `judgeRuns` with `ledgerAdmission`, which admits each call as a `judge`
  attempt. Tests use fakes and a real ledger, and nothing sends a request (D5,
  D12). The plan names `task-structured.ts` from `self-evolving` for judge
  helpers. It is not on this branch, so a model matcher built after that merge
  should use it for schema-checked answers.
- **Which new tests run in CI.** The three core test files (`eval.test.ts`,
  `eval-judge.test.ts`, `eval-report.test.ts`) run with the core suite, since
  `test.yml` runs `turbo test` for every package but the engine.
  `judge.test.ts` and `report.test.ts`, like the earlier eval script tests, are
  run by no workflow yet.
