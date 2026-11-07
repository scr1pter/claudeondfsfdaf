# VectorScope build deviations

Notes on where the code had to differ from `vectorscope-plan.md`. Each entry is
dated, names its work package, and is committed with the work it explains.
Entries are written before the package's commit step, so "Nothing is committed"
in an entry describes that moment; `git log` has the commit that carries it.

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

## 2026-11-04 · Phase 0 review

The review's findings were each checked against the code; all were confirmed,
three were duplicates of others, and all are fixed. Where a fix changes an
earlier entry above, it says which. No reviewer behaviour changed: every edit
is in the eval tooling (`script/vectorscope-eval`, core `review/eval*.ts`, the
engine's eval adapter `review/eval.ts`) or CI, none of which the reviewer
imports, so D3's opt-in does not apply. No generator input changed.

- **A model is never the sole authority (VS-04; replaces "Two distinct judges
  agreeing settle a verdict, whether human or model" above).** `settle()` now
  settles an agreement only when at least one agreeing pass is `human:`;
  agreeing models alone get the new status `needs-human`, which scores as
  unjudged, so the gate sends the rules it touches to review. Settled verdicts
  always carry `human: true`, and the report counts model-only agreements
  instead of agreements with a human. The rubric version is unchanged: the
  verdict rules are the same, only settlement is stricter, and it is computed
  from the saved passes.
- **Model identity (VS-04).** The "a model never judges its own findings"
  check compares ids with `sameModel`: path segments, lower-cased, with a route
  suffix (`:free`, `@preset`) and a trailing date dropped and dots read as
  hyphens, matching when one id's segments end the other's. It errs towards
  "same", which only ever refuses a judge.
- **Judges see where the code is (VS-04; amends "Blinding" above).** A task
  carries a code reference: the repository and candidate commits for a dataset
  case, and for a synthetic fixture the change itself as a diff rather than its
  path, since the fixture's directory name is its descriptive case id. Nothing
  in it names the pipeline, model or repetition.
- **Weakened gates (VS-04).** A `--gate` file with a looser threshold, a lower
  confidence or another decision split gets a release reason, and so does a
  changed copy that still calls itself D2. The existing "stricter gate" test
  in `report.test.ts` in fact lowered `minCoverage`, so it now also checks that
  the weaker gate makes no release decision.
- **Empty-finding control (VS-02/VS-04).** `report.ts --empty-control` adds the
  Phase 0 baseline as the variant `empty` with model `none`: a completed,
  admitted, free review of every planned case and repetition with no finding.
  It runs no model.
- **Shared ledger journals (VS-04).** A report no longer adds up the budget
  summaries the run.ts reports embed. Reports charged to one journal (every
  model of a CI run) are merged entry by entry and summarised once; `--ledger`
  replaces them with that journal's own summary. Separate journals still add.
- **Paid sends only from the protected environment (VS-03; amends "`run.ts` is
  a dry run by default" above).** `run.ts` reads its key from
  `VECTORSCOPE_EVAL_API_KEY` unless `--api-key-env` names another variable, so
  `OPENROUTER_API_KEY` alone sends nothing. A budgeted send to a hosted endpoint
  needs `GITHUB_ACTIONS=true` and `VECTORSCOPE_EVAL_ENVIRONMENT=vectorscope-eval`,
  which only `ci.ts paid` sets, and only when the workflow step names that
  environment; locally a run sends only to a loopback endpoint. The review
  suggested allowing zero-price endpoints too; with a budget both prices must
  now be above zero everywhere, because a zero price lets every estimate
  through, and a free local server can be given any small price.
- **The repository is public, so paid results are sealed (VS-03; replaces the
  printed model output and the 30-day artifact above).** Verified with
  `gh repo view`: the repository is public, so its Actions logs, step
  summaries and artifacts are world-readable. `ci.ts paid` no longer prints
  run.ts's output; each model's stdout and stderr go to a log beside its
  report, and the job log and step summary get only the ledger's spend and
  counts. A new `ci.ts seal` step encrypts every output file to the owner's
  RSA public key (a fresh AES-256-GCM key wrapped with RSA-OAEP over SHA-256),
  and only the sealed file is uploaded, for 7 days. Paid mode refuses to start
  without the public key, which is the environment variable (not a secret)
  `VECTORSCOPE_EVAL_PUBLIC_KEY`; the owner creates it with the environment
  (README, "Owner setup"). `ci.ts unseal` opens the file on the owner's machine.
  `::stop-commands::` is no longer needed, since no model text reaches the log.
- **Journal resume after a crash (VS-03).** `Ledger.open` drops a cut-off last
  line before it appends, so the journal stays readable. A cut-off admission
  sent nothing (admissions are written before sending), and a cut-off `sent` or
  `settle` leaves the attempt open, which is then kept as uncertain spend.
- **Outside the repository (VS-03/VS-04).** One helper, `paths.ts
  outsideRepository`, now used by run.ts, ci.ts, report.ts and judge.ts, treats
  `<repo>/..reports` as inside.
- **Replay limits come from the eval (VS-02).** `ReviewEval.replay` refuses
  without a positive `config.maxCostUsd` from its caller and takes
  `maxCostUsd`, `maxSteps` and `timeoutMinutes` only from the caller's config
  (the defaults where it leaves the last two out), never from the dataset's
  base `review.json`. Every engine test now passes its cap.
- **Replay isolation (VS-02).** An untrusted case replays only with
  `VECTOR_PURE` and `VECTOR_DISABLE_PROJECT_CONFIG` set, as the GitHub review
  job runs; the "or the workspace is untrusted" alternative was not taken,
  since the flags are the job's own settings. `runtime.isolation` records the
  flags, the workspace trust and whether language servers, formatters and
  snapshots could run. The untrusted test supplies its fake provider through
  `VECTOR_CONFIG_CONTENT`, as the CLI end-to-end test does. Under
  `VECTOR_PURE`, `Config.trust()` still reports a stored trust; the isolation
  record shows it as reported.
- **Git on dataset content (VS-01/VS-02).** `prepareCheckout`, the mirror
  checks in `dataset.ts` and the desktop driver's diff run git with
  `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL` set to the null device,
  `GIT_LFS_SKIP_SMUDGE`, no prompt, `core.hooksPath` at the null device,
  `core.fsmonitor` off and only the local file transport allowed. A test shows
  a user's global hook and smudge filter no longer run on a dataset that asks
  for git-lfs.
- **Case ids never reach the reviewer (VS-01/VS-02).** Prepared checkouts are
  named by a digest of the case id (`checkoutDirectory`). The review also
  offered checking that ids are `<owner>-<name>-<n>`; that was not done,
  because the directory was the only path by which an id reached a reviewer
  and every synthetic manifest in the tests uses other ids. The annotation
  guide keeps the convention.
- **The desktop baseline is built (VS-02; replaces "The desktop replay is a
  documented stub" above).** `script/vectorscope-eval/desktop.ts`
  (`desktopReplay`) runs `runReview` from the app's `ai-review.ts` through a
  recording client, as an untrusted fork pull request with a neutral title,
  and writes an artifact with the engine replay's placed findings, attempts by
  pass and prompt digest, sessions with permission digests, and what Post
  would send. It needs neither Electron nor a server; its test uses a fake
  client on a prepared checkout. A paid desktop replay is not wired: it needs
  an engine server and the ledger's admission, like the engine's paid replay.
  The app's file is imported, not edited.
- **Agreed labels freeze (VS-01; amends "The seed is not frozen" above).** D8
  has the owner adjudicate only disagreements, so a `double-annotated` label
  records `agreed: true` when its passes agreed, and such a label may be frozen
  without an adjudication. `agreed: false` waits for the owner.
- **Adversarial cases (VS-01).** A case's `kind` may be `adversarial`, with
  `labels.injection` describing the injected text and a safe reviewer's
  response. It is split on its own. Core `summarize` keeps adversarial cases
  out of every quality rate (recall, precision, false alarms per clean pull
  request, paired recall, category recall) and reports them apart; their spend,
  wall time and trust violations still count, so a broken check still fails
  the gate.
- **The full dataset is still open (VS-01).** VS-01 delivered the contract and
  a ten-case seed of single draft labels. The Phase 0 set (about 100 sampled bug
  cases, at least 25 controls, rename, cross-file, incremental, fork and
  adversarial cases, two annotation passes and held-out controls) is owned by
  no work package in the plan. Next action: sample candidates by the recorded
  selection rule into the manifest, run the two model-assisted passes, have the
  owner adjudicate the disagreements, and freeze the held-out split before any
  prompt tuning.
- **The eval tests and scripts run in CI (supersedes "not in CI yet" in each
  entry above).** `test.yml` runs every `script/vectorscope-eval/*.test.ts`
  file in its own Bun process from `packages/script`, as the footprint step
  does, and `typecheck.yml` checks the scripts with the new
  `script/vectorscope-eval/tsconfig.json`. It extends the engine's config; its
  `@/` path tries the engine's source and then the app's, since the scripts
  reach both through the replay adapters.

## 2026-11-04 · VS-06 Verification parity

- **The opt-in is a review setting.** D3 needs an off-by-default opt-in, and
  the plan names none. It is `verifyPolicy` in `ReviewConfig`: `"legacy"` (the
  default) or `"shared"`, read from `.vector/review.json` and from
  `REVIEW_VERIFY_POLICY`. Every surface already parses that config (the CLI,
  the GitHub job and the desktop panel), so the opt-in reaches all three
  without editing `github.review.ts`, which @vector owns, and without new CLI
  flags or desktop controls. Nothing in the product sets it, and the public
  docs page does not mention it (D14); VS-20's rollout flags can set it later.
- **Where the proposed default `all` applies.** Under `"shared"` the config
  parser starts `verify` from `SHARED_VERIFY_DEFAULT` (`"all"`), and an
  explicit `verify` in review.json or `REVIEW_VERIFY` still wins. The policy is
  settled before the other keys, so a bad `verify` falls back to the policy's
  default and its warning says so. `DEFAULT_REVIEW_CONFIG.verify` stays
  `"blocking"`: a config built in code keeps the `verify` it sets.
- **One function holds both rules.** `verifyCandidates` in core `plan.ts`
  documents the shared policy and carries each surface's legacy rule as its
  legacy branch, copied unchanged from engine `review/run.ts` and the app's
  `ai-review.ts`. The D3 proof is in core `test/review/plan.test.ts`, which
  compares both legacy branches with the old code, copied into the test, over
  every combination of verify, trust, triage, severity, confidence, suggestion
  and shared ids, and compares the triage drops too. The existing engine and
  desktop tests pass unchanged, and new tests there pin the legacy behaviour
  the shared policy changes.
- **Policy choices the plan leaves open.**
  - In an untrusted review every finding with a suggestion is a candidate,
    whatever its severity or confidence, as both surfaces did for "blocking".
    The shared policy also applies it under "all" and after a triage pass,
    which the engine did not.
  - After a triage pass verify is read as "all", even when it is "off", and
    only candidates above a nit must be confirmed to be reported, as both
    surfaces did.
  - An explicit "off" turns the pass off outside a triage pass, untrusted
    suggestions included, as both surfaces did; such a suggestion is still
    never posted as a committable suggestion, which selection allows in an
    untrusted review only for a verified finding.
  - Each id is one candidate on both surfaces, as the engine sent them; the
    desktop used to send findings that share an id more than once.
  - Under "shared" an explicit "blocking" on the desktop checks only blocking
    findings and untrusted suggestions; the desktop used to read it as "all".
- **Incomplete verify.** Under "shared" the engine notes any verify pass that
  did not finish (skipped before it started, denied by the budget, stopped,
  timed out or failed) with the number of candidates left unverified and why,
  through the new core note `noteVerifyUnfinished` in `format.ts`, a file the
  row does not list. The legacy engine notes only a skipped pass, as before, so
  a denied or failed pass still says nothing there; the new engine tests show
  both. The desktop's notes are unchanged, since it already noted every pass
  that did not finish. On both surfaces a finished pass that leaves out a
  verdict leaves that finding unverified without a note, as before.
- **The eval can measure it (VS-02 adapter).** `ReviewEval.replay` now reads a
  variant's `verifyPolicy` as a repository that opted in would be, so the
  variant `{ verifyPolicy: "shared" }` gets `all` unless the case's base sets
  `verify`. Its test is in engine `test/review/eval.test.ts`, and the eval
  README says how the comparison is made. This file is outside the row's list.
- **Not measured, so no default changed.** The row asks for precision, recall
  and added spend before a default changes. That needs paid replays, which wait
  for the D7 environment and key and a paid replay entry point (D5, D12), so
  `"legacy"` stays the default everywhere.
- **Left for later variants.** The plan mentions, for VS-06, retries for
  `vectorscope.*` passes, a verify pass that forks the review session to share
  its prompt cache, and whether review passes are exempt from the multi-agent
  task limits. All three depend on `self-evolving`, which is not on this
  branch, and each is a measured variant, so none is built here.

## 2026-11-04 · VS-06 Verification parity, completed

The second pass on VS-06. Each change is behind the same opt-in,
`"verifyPolicy": "shared"`; with it off both surfaces behave as before, and new
tests pin the legacy notes word for word. Where an entry above changes, it says
which.

- **No candidate is left without a verdict in silence (amends "Incomplete
  verify" above).** The row's tests cover "incomplete verify", and a verify
  pass that finishes without a verdict for some candidates is one. Under
  "shared" both surfaces now account for every candidate left without a
  verdict, whether the pass finished or not. Outside a triage pass the review
  says how many it posts unverified and why (`noteVerifyUnfinished`, with a new
  reason, `"unanswered"`, for a pass that finished). After a triage pass it
  says how many it left out (`noteTriageUnchecked`, with a new optional reason,
  `"unanswered"`). In an untrusted review it also counts the nits' suggestions
  the pass left without a verdict, which are posted unverified
  (`verifyUnanswered` in core `plan.ts` now takes `triaged`). The legacy rule is
  unchanged on both surfaces: the engine notes only a skipped pass, or after a
  triage pass one that did not finish, and the desktop gives its one general
  note for a pass that did not finish. Neither says anything about a finished
  pass that left out verdicts.
- **The desktop uses the engine's notes under "shared" (amends "The desktop's
  notes are unchanged" in "Incomplete verify" above).** With "shared" on, the
  panel gives the same
  core notes, with the count and the reason, as the engine. A double-check cut
  off by the review's time limit gives `"time"`, and any other stop or failure
  gives `"unfinished"`. The desktop cannot tell a run-guard budget stop from
  other failures, so it never gives `"budget"`.
- **The desktop eval driver takes the variant (VS-02 adapter; the first pass
  left it without one).** `desktopReplay` takes
  `config: { verifyPolicy }`, as `ReviewEval.replay` does. The desktop runner
  reads no environment, so the variant reaches it as the case's own
  `.vector/review.json` would carry it. That is the base's file with
  `verifyPolicy` set and its other keys kept, so the base's `verify` still wins,
  as in the engine replay. The runner never reads a `review.json` that the
  change edits, so the artifact's `variant.applied` records whether the variant
  reached it. No app file changed for this; the driver wraps the client's file
  read. Its tests are in `script/vectorscope-eval/replay.test.ts`, and the eval
  README describes it.
- **Still not measured, so no default changed.** "Evaluate precision, recall
  and added spend before changing defaults" still needs paid replays of
  `legacy` against `{ verifyPolicy: "shared" }` on both adapters. They wait for
  three things outside this branch's code: the owner's protected
  `vectorscope-eval` environment and its new key (D7), the pilot budget that
  follows from them (D5), and a paid replay entry point. That entry point
  (VS-02/VS-03's open note above) can only be exercised after D7, and for the
  desktop it also needs an engine server. `"legacy"` stays the default on every
  surface.

## 2026-11-04 · VS-07 Model evidence

- **The opt-in is a review setting.** D3 needs an off-by-default opt-in. It is
  `modelEvidence` in `ReviewConfig`: `"off"` (the default) or `"warn"`, read
  from `.vector/review.json` and `REVIEW_MODEL_EVIDENCE`, as VS-06's
  `verifyPolicy` is. The CLI, the GitHub job (through `Review.run`'s notes,
  which it already posts, so `github.review.ts` is not edited) and the desktop
  panel all parse it. There is no value that refuses or replaces a model: the
  row says to warn without switching. With it off, both runners send the same
  requests and give the same outcome, and the tests in engine
  `test/review/run.test.ts`, `test/cli/review.test.ts`,
  `test/review/model.test.ts` and app `ai-review.test.ts` show it.
- **Where certificates live.** A certificate is a record in `MODEL_EVIDENCE`,
  a constant in the new core `review/model-evidence.ts`, as VS-04's gate is
  `DEFAULT_GATE`. It names one exact "provider/model", the report file's
  sha256, the frozen manifest's freeze digest, the held-out split, the gate
  decision and digest, the collection day, the runners replayed, the owner's
  approval day and an expiry. `MODEL_EVIDENCE` is empty, because no model has
  passed a held-out run (D5, D12). `certificateProblems` refuses a malformed
  record, a router or preset, a split other than held-out and an approval
  other than the owner's.
- **Choices the plan leaves open.**
  - A certificate expires at most 90 days after its approval
    (`MAX_CERTIFICATE_DAYS`). The plan asks for an expiry and sets none.
  - It applies only in the scope its runs were replayed in: the runner, the
    pipeline revision, a digest of the core prompts and output schemas, a
    digest of the settings that change what is found or posted
    (`EVIDENCE_POLICY_KEYS`: security, verify, verifyPolicy, minSeverity,
    minConfidence, nits, suggestions, maxComments, maxSteps, maxDiffChars),
    the triage model and the variant. Budgets, time limits, ignores and skips
    are not part of it. A change to either runner's code is caught only by
    bumping `REVIEW_PIPELINE_REVISION`, since a digest of the runners' source
    cannot be built in the browser. A prompt or schema change is caught
    without a bump.
  - The statuses are certified, unvetted, expired, stale (with what
    changed), retired and rerouted. Rerouted covers a router or preset
    (`openRouterModelRouting`'s rule), a certificate of the same model through
    another route (VS-04's `sameModel` from core `eval.ts`, reused rather than
    copied), and replies from a model the review did not choose.
  - A triage model is covered by its pipeline's certificate, which records it.
    It gets a note only when it is retired, a router, or labelled "May train on
    your prompts".
  - A certified model gets no note, so no note ever claims review quality.
- **Private-code policy has one rule.** Whether a free model may train comes
  from `freeModelMayTrain`, as everywhere else. The plan's
  `subagent-model.ts` (`self-evolving`) is not on this branch, so it is not
  used; VS-09 resolves the review and triage models with it after that merge.
  A note says a free model "does not train on prompts" only when Vector's
  record says no-training. The unattended free fallback is unchanged and its
  note says which rule chose it.
- **Retired models.** The engine drops a retired model when it loads a
  provider, so a resolved model is never retired. Under the opt-in, `vector
  review` names a retired local model as retired, from the catalog, where it
  said only that the model was not available. It refused that model before as
  well, and a workflow already named it as retired. That is the new
  `ResolveInput.evidence` in engine `review/model.ts`. The desktop's catalog of
  connected models normally leaves retired ones out, so the panel says
  "retired" only for a model the catalog lists with that status. A
  review.json model that is not connected, retired or not, is reported as not
  connected.
- **No silent switch.** The engine never falls back from a chosen model. The
  desktop has always run on the agent's model when review.json names a model
  that is not connected. That is unchanged, and under the opt-in the review
  now says so. On the desktop the note says "No model is set in
  .vector/review.json" rather than "No review model is set", because the
  agent's model may be one the person chose (`choice.unset` in
  `ModelSubject`).
- **The resolver describes its choice.** `ResolvedModel.subject` records which
  setting chose the model, or which default it fell back to, and the catalog's
  facts about it. It is always set but read only under the opt-in. The eval's
  `modelRecord` does not copy it, so replay artifacts are unchanged apart from
  `scope`.
- **Workflow setup.** The automatic-review setup card in `pull-requests.tsx`
  shows warnings about the model it writes to `MODEL`. They are computed from
  the open project's local review.json, which `layout-new.tsx` reads while the
  Pull Requests panel is open, and are about the engine runner, which runs
  the job. When review.json names a model, the job runs that model instead of
  `MODEL`, and the card says so. With the opt-in off the card is unchanged,
  apart from that one file read. Core `review/workflow.ts` and desktop
  `github-pr.ts` are not edited. They need no change for this package,
  because the job reads `modelEvidence` from the base branch's review.json.
  Nothing is left for VS-05 from VS-07.
- **Eval artifacts (VS-02 adapters) and a new script.** Engine and desktop
  replay artifacts record `scope`. The desktop driver parses the review.json
  the runner read, or the defaults when it read none. The new
  `script/vectorscope-eval/certify.ts`, which the row does not list, turns a
  passing held-out report and the candidate's artifacts into a certificate
  through core `certify`. It prints the certificate and certifies nothing: a
  certificate applies only once it is committed to `MODEL_EVIDENCE` with the
  owner's approval. `report.ts` still does not load desktop artifacts (Phase 0
  review), so for now only engine runs can be certified.
- **Files outside the row.** Core `format.ts` now exports its existing
  `codeSpan`, which the notes use for model names. Core `config.ts` and
  `types.ts` carry the setting. Engine `review/eval.ts`, `cli/cmd/review.ts`
  and the eval driver `desktop.ts` are listed above.
- **Not user-facing in 1.99.113 (D14).** Nothing in the product sets the
  opt-in, the public docs page does not mention it, and no model is
  certified. VS-20's rollout flags and local model status can show it later.

## 2026-11-04 · Phase 1 review

The review's nine findings were each checked against the code. All were
confirmed; two (the certificate's variant and manifest) were the same finding
twice. All are fixed. Where a fix changes an earlier entry above, it says which.
Every reviewer change is behind the existing opt-ins (`"verifyPolicy":
"shared"`, `"modelEvidence": "warn"`), apart from the setup card's file read,
which now happens less. With both off, both runners send the same requests and
give the same outcome as before; the existing D3 tests still show it. No
generator input changed.

- **A variant has an identity in the eval (VS-06; amends "The eval can measure
  it" and "Still not measured" above).** The engine replay artifact records
  the variant the eval asked for (`variant`, engine `review/eval.ts`), and
  `report.ts` names its runs with `replayVariant`: `engine` for the frozen
  pipeline and `engine:shared-verify` for the shared verify policy, so one
  model's two pipelines are two groups that pair under `--candidate` and
  `--baseline`. The review suggested `engine:verify=shared`; the name has no
  `=` because `--candidate <variant>=<model>` splits on the first one. The
  eval ledger's case for a replay (`replayCaseKey`) now starts with that name,
  in `admitReplay`, in the report's admission lookup and in the judge's
  charges (`ledgerCase`), so each variant of a case is admitted against its
  own bound. `admitReplay` also returns the variant in the replay's config, so
  the artifact names the variant it was admitted for. The engine comparison
  can now be run once paid replays exist; nothing has been run (D5, D12). The
  desktop's cannot yet: `report.ts` still does not load desktop artifacts, so
  the earlier claim that a desktop case with `applied: false` "is left out of
  the comparison" described no code. The README now says such a case must be
  left out once the report reads desktop artifacts, and `certify.ts` refuses
  a variant's desktop run that was not applied.
- **The desktop driver touches only the settings read (VS-06; amends "The
  desktop eval driver takes the variant" above).** `desktopReplay` decides from
  the diff, by the runner's own rule, whether the change touches
  `.vector/review.json`. If it does, the client is not wrapped, the scope is
  the defaults' and `variant.applied` is `false`. Otherwise only the first read
  of the file, the runner's settings read, gets the variant, and later reads
  (a finding that names the file) get the file as it is. The scope is built
  from that first read only. Before this, every read of the file was answered,
  so a case that edited it reviewed a corrupted file and said the variant had
  applied.
- **The prompts digest renders every section, and the pipeline's sources are
  pinned (VS-07; replaces "A change to either runner's code is caught only by
  bumping `REVIEW_PIPELINE_REVISION` ... A prompt or schema change is caught
  without a bump" above).** `promptsDigest` now hashes `canonicalPrompts()`:
  each pass's prompt bare and with every optional input set (full and
  incremental, nits on and off, a commit and uncommitted changes), the verify
  prompt with fixed claims and annotated files, and the owner's memory block.
  A test checks that every conditional section is in it. It still cannot see
  a runner filling those inputs differently, or a change to the prompts'
  length limits. So `REVIEW_PIPELINE_SOURCES` in `model-evidence.ts` holds a
  digest of ten files, which core `test/review/model-evidence.test.ts` pins:
  both runners, core `plan.ts`, `pack.ts`, `select.ts`, `diff.ts`,
  `fingerprint.ts` and `prompt.ts`, and the engine's `review.txt` and
  `security.txt` agent prompts. Any edit to one of them, a merge from `main`
  included, fails that test until someone decides whether
  `REVIEW_PIPELINE_REVISION` goes up and updates the pin; the failure says how.
  That is the plan's "certification expires when the ... pipeline changes",
  enforced by CI rather than by memory.
- **The certificate's variant and manifest come from the evidence (VS-07;
  amends "Eval artifacts (VS-02 adapters) and a new script" above).**
  `certify.ts` takes the model variant from the candidate's artifacts
  (`models.review.variant`), refuses runs with different variants, and keeps
  `--variant` only as a check that must agree. It hashes the `--manifest` file
  and refuses unless the sha256 matches the one the report records in
  `sources.manifest`. It picks the candidate's runs by model and pipeline
  variant.
- **The setup card says whose settings it read, and reads them later (VS-07;
  amends "Workflow setup" above).** The warnings now start by saying they use
  this checkout's `.vector/review.json` and that automatic reviews read the
  copy committed on the pull request's base branch. A model named locally is
  described as that, holding only when the base branch's copy names it too.
  `layout-new.tsx` reads the file only once the set-up card asks for its
  model, and again each time the panel opens, so opening the Pull Requests
  panel no longer sends that request.
- **The setup card's warnings move to V25's card after the @vector merge
  (VS-07 and VS-20; amends "Nothing is left for VS-05 from VS-07" above).**
  Nothing is left for VS-05. The plan's VS-20 route says V25's "Set up @vector"
  card replaces the auto-review setup in `pull-requests.tsx` and that
  VectorScope's status joins it through props agreed with the @vector owner,
  not a second card. So after the merge, the model evidence warnings
  (`WorkflowModel.warnings`) must move into V25's card through such props, as
  part of VS-20's GitHub half. Until then they stay in today's card behind the
  opt-in.
- **A posted note names a model in a code span (VS-07).** The desktop note for
  a review.json model that is not connected now wraps that name, and the model
  the review ran on, in `codeSpan`, which escapes Vector's markers, since
  desktop notes reach what the Post button sends.
- **Desktop tests pin the notes (VS-06).** The test of a double-check the run
  guard stopped, or that was stopped, now expects the shared policy's exact
  note (`noteVerifyUnfinished(2, "unfinished")`) and the legacy note word for
  word, for both cases, where it only looked for "not re-checked".

## 2026-11-06 · P0 Merge of main

Contract §0.1 of `vectorscope-upgrade.md`, done before any VS-21 to VS-31
package. P0 adds no key, type, function, export or behaviour. Its only code
edit is the `REVIEW_PIPELINE_SOURCES` pin; the rest is the contract's
citations and this entry.

- **The merge.** `02c23b4c` merges `origin/main` at `4299d743` (246 commits)
  into `dbcfbe8f` (`origin/vectorscope`) on the lane branch
  `vectorscope-engine`; §0.1's `vectorscope-upgrade` was only an example
  name. A read-only `git ls-remote origin` on 2026-11-06 still shows `main`
  at `4299d743` and `vectorscope` at `dbcfbe8f`. The merge commit's tree
  (`94638e25`) is exactly the one `git merge-tree --write-tree dbcfbe8f
  4299d743` produces, so no hunk was resolved by hand: `run.ts`,
  `run.test.ts` and `bun.lock` combined both sides automatically. The
  merged dependencies (`pdf-lib` 1.17.1, `@pdf-lib/*`, `pako` 1.0.11) were
  already installed, so no `bun install` ran.
- **The pin, and no revision bump.** Of the ten `REVIEW_PIPELINE_FILES`,
  only engine `review/run.ts` changed, through `3ae59867 fix(review):
  reserve using actual context price tiers` (+7/-2); the other nine are
  byte-identical to `dbcfbe8f`. `REVIEW_PIPELINE_SOURCES` goes from
  `cebdc594212560b1` to `fa1d31befd5a4f77`. `REVIEW_PIPELINE_REVISION`
  stays 1, as §0.1 asks:
  - `3ae59867` changes only the price a reservation uses. `nextCost` now
    prices the next step through `Session.costAt(track.cost, context +
    NEXT_STEP_SLACK)` and `SpendGuard.priceOf` on the invocation model's
    cost table (`run.ts:163,270-274,449`), so once a session's context
    crosses a provider's context price tier it reserves at that tier's
    rate. Its tests cover 272,000, 272,001 and 300,000 tokens
    (`run.test.ts:427`). It changes no prompt, schema, selection,
    anchoring or settled spend.
  - Below a tier, the reservation price is unchanged as long as the
    invocation model's base rates equal the price resolved for the review
    (`review/model.ts:178`), which holds when both come from the same
    catalog entry. The first reservation, at session creation
    (`run.ts:386`), passes no cost table, so it still uses the resolved
    price and ignores tiers.
  - Scope caveat: under a tight `maxCostUsd`, a pass past that boundary
    now reserves at the higher rate and may be refused (partial
    `"budget"`) where it used to be admitted.
  - `MODEL_EVIDENCE` is empty, so no certificate is affected. Only VS-31
    bumps the revision (I-12).
- **Outside the pin: settlement and transport.** The merge also changes V1
  session code that every review session runs through. None of these files
  is in `REVIEW_PIPELINE_FILES`, so by the pin's definition none moves the
  digest, and none touches review prompts, selection or anchoring. They can
  still change what a review reports and, under a cap, whether a pass runs.
  This replaces the plan draft's "none changes review prompts, selection or
  posting", which its review showed was too broad.
  - Engine `session/session.ts` `getUsage`: a valid OpenRouter-reported
    cost now wins over the catalog price for priced models too, a zero
    charge included (`a369199d`). Absent or malformed counters make the
    step incomplete and unpriced instead of reading as zero, and a
    malformed total is dropped (`36a0e921`, `bd537fd2`).
  - Engine `session/processor.ts`: completed-step spend is kept through
    cancellation and publication defects, and interrupted turns keep their
    uncertainty (`89525f44`, `94c27c67`, `9fbc670f`, `36a0e921`), helped
    by the new `accepted` stream hook in engine `session/llm.ts`
    (`9fbc670f`).
  - Core `spend-guard.ts`: ancillary spend is bound to its launching scope
    and attempt receipts are deduplicated (`e6ebdfc1`), and loop history
    resets on promoted user input (`dae48615`). Reviews meet it through the
    run guard under `budget.run` (`run.ts:543-545`).
  - So, for the same provider responses, a review's settled and uncertain
    spend (`settle`, `run.ts:476-499`), its cost kind (an unpriced message
    makes it `"unknown"`, `run.ts:316-318,333-342`) and, under
    `maxCostUsd`, a partial `"budget"` outcome and its posted note can
    differ from `dbcfbe8f`, independently of `3ae59867`. OpenRouter reviews
    are the most exposed.
  - Engine `session/llm/request.ts` is where the default-on prompt-cache
    marker comes from (`c96f83a1`, `70613cc4`); `provider.ts` only consumes
    it (`promptCacheBreakpointBody` against `requestInput`,
    `provider.ts:2505-2525`). It is on by default only for openai
    `gpt-6.1-sol` with an API key at `api.openai.com`. It keeps the text
    but changes the wire body, so a review on that model sends different
    bytes.
  - Also merged: core `session/runner/model.ts` gains V2 billed costs and
    loop signatures (`fc26fbb7`, `fbe2b85d`, `9fbc670f`), and review
    sessions are V1. Core `brain/knowledge.ts` invalidates forgotten and
    re-scoped documents durably (`d7360894`). The review's requirement
    cards read that store (`ReviewContext.requirements`), so at most a card
    for a document forgotten or made private during extraction drops out,
    as intended.
  - Why this still needs no bump: §0.1 says not to; these change what a
    review costs, how its spend is counted and whether a capped pass is
    admitted, the same category as the `3ae59867` caveat; budgets bound a
    review but are not part of what a certificate evaluates
    (`model-evidence.ts:48-49`); and no certificate exists. From now on
    each D3 parity test compares a runner with its own post-merge
    behaviour, not with `dbcfbe8f`.
- **Green.** Each file ran alone through `vector-serial` with
  `--timeout 30000` from its package folder, with `TMPDIR` set to a fresh
  `mktemp -d` folder under `/tmp/vector-vectorscope/`, fresh XDG roots and
  `GITHUB_ACTIONS=false`. The engine's `test/preload.ts` derives its XDG
  roots from `os.tmpdir()` and overrides the ones passed in, so `TMPDIR` is
  what keeps engine test data out of loose `/tmp`; core's preload leaves
  XDG alone. Counts on the re-pinned tree, all with 0 fail:
  - core `test/review/`: 22 files, 423 pass. Before the re-pin the only
    failure was the pin test, which printed `fa1d31befd5a4f77`.
  - engine `test/review/`: 7 files, 97 pass (`run.test.ts` 41).
  - engine `test/cli/` files that drive `Review.run`, beyond §0.1's ask and
    read-only: `review` 24, `review.render` 10, `github.review` 40,
    `github.review-api` 3.
  - app `ai-review.test.ts`: 107 pass.
  - eval scripts from `script/vectorscope-eval`: budget 21, certify 5, ci
    18, judge 6, replay 18, report 21, run 14; `fixtures.test.ts` from
    `packages/script`: 50.
  - `bun typecheck` in core, engine and app, and `bun tsgo -p
    ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`
    (as `typecheck.yml` runs it): all exit 0.
  - No other merge fallout, so no code fix.
- **Re-cited.** Every `path:line` in `vectorscope-upgrade.md` was checked on
  `02c23b4c`, and its Citations bullet now names that commit. Four cited
  files moved: engine `review/run.ts` (old lines 163-270 +1, 271-444 +4,
  445 on +5), `provider/provider.ts` (2486-2495 +9, 2496-2501 +17, 2502 on
  +24), engine `session/llm.ts` (+2 after old line 70) and core
  `session/runner/model.ts` (+14 for every line after old line 245). No
  citation was lost, so none is marked as gone.
  - Ranges were checked, not only shifted. Core `model.ts:295-315` becomes
    `308-330`, the whole `withoutUnconsentedTraining` block (the old range
    missed its first comment line and its close). `session/llm.ts:320-356`
    becomes `322-377`, the whole `if (flags.experimentalNativeLlm)` block:
    the old range stopped inside the `native.type === "supported"` branch
    (322-361), where the native stream is returned, and VS-23c also needs
    the ai-sdk fallback that follows it (362-376, which logs
    `native.reason`), because a `zdr` gate on the outer condition skips
    both and a gate on the inner one would log a false reason.
    VS-23c's "(post-P0 code)" placeholder becomes
    `provider.ts:2505-2525`, and the provider row gains the same range. The
    plan's review suggested `2509-2525`; the range starts at 2505 because
    `requestInput` and the cache body are built from the headers and the
    marker read at 2505-2508.
  - `main:` is gone. `packages/schema/src/session-message.ts:179-200` and
    `packages/desktop/src/main/parallel-workspaces.ts:136-168` are
    byte-identical to `origin/main` on the merged commit, so their lines
    hold, and the Citations bullet no longer lists the prefix.
  - Checked and unchanged although their files changed in the merge:
    `knowledge.ts:616-631`, `types.gen.ts:2416` (`export type Config`) and
    `run.ts:1-5,90-131`. Every other citation is into a file the merge did
    not change, and P0's own edits move none.
  - One pre-existing range fixed, not merge fallout. `provider.ts:2329-2340`
    (VS-23c step 3 and §10's `x-session-id` bullet) was off by one at both
    ends on `dbcfbe8f` already: 2329 is a blank line, the `guestRequest`
    comment starts at 2330 and the function closes at 2341. It becomes
    `2330-2341`, and the provider row's `2329-2420` starts at 2330 too, as
    the other ranges above were tightened.
  - Two accuracy fixes. First, `ai-review.ts:1766` (`outcome.pr ===
    undefined || finding.verified === true`) is itself a `=== true` check,
    so it moves into the `=== true` lists of §1.2 and §10, together with
    `script/vectorscope-eval/desktop.ts:179` (`verified: finding.verified
    === true`), which neither named; a grep of non-test sources finds no
    other. The other consumers gain `github.review.ts:737`, which passes
    `verified` to `suggestionAllowed` (@vector's file, cited, not edited),
    and `run.ts:747`, the engine's counterpart of `ai-review.ts:980`.
    Second, `brain/code.ts:397-506` becomes `473-500`: the row is about
    `resolve`, which runs 473-500; 397 starts `imports`, and 501-506 are
    `coChange`'s doc comment.
  - The research notes are not re-cited. Their citations are evidence as
    gathered on `dbcfbe8f` (for example `vectorscope-today.md:52` quotes
    the old pin), and the Citations bullet says so.
- **Off by default, nothing user-facing.** P0 touches none of the runners
  (`run.ts`, `ai-review.ts`, `provider.ts`, `session/llm.ts`,
  `posting.ts`) and none of the files @vector owns. The pin is read only by
  its test; it is not part of `EvidenceScope` or of a certificate.
  `EvidenceScope.pipeline` stays 1, and `promptsDigest` and `policyDigest`
  are unchanged, so the frozen `engine` baseline stays comparable and I-1
  holds. No owner question (Q1-Q17) is decided, and no user-visible string
  changes (D14).
- **Nothing deferred.** P0 adds no test of its own: main's suites test the
  merged settlement and transport changes, and the review suites above
  pass on them. VS-21 starts from this tree.

## 2026-11-06 · VS-21a Variant registry and artifact fields

Contract §4 VS-21a of `vectorscope-upgrade.md`, in the "Now" window: eval
work only. It touches no runner, no `ReviewConfig` key and no file @vector
owns. It implements the VS-21a plan as corrected by its critique; where a
critique point was taken differently or left out, the bullets below say why.

- **What landed.**
  - **The registry**, `VARIANTS` in `script/vectorscope-eval/replay.ts`. It
    has the contract's ten suffixes (`shared-verify`, `privacy-zdr`,
    `trivial-skip`, `impact-graph`, `cards-brain`, `guardrail-strict`,
    `depth-auto`, `lenses-high`, `cross-family`, `precise`). Each entry has a
    `planned` text, `keys` once a half is built, an optional `models`
    requirement, and an `engine` and a `desktop` half. Each half is either
    `{ from }` (built) or `{ pending }`.
  - **Resolution**:
    - `resolveVariant` gives a built variant's keys, or refuses the name as
      `malformed`, `unknown` (prototype names included, through
      `Object.hasOwn`) or `pending`, naming the package it waits for;
    - `variantNames` lists the names;
    - `replayVariant` reads both record shapes;
    - `variantProblems` checks an artifact's record against the registry.
  - **`admitReplay`** takes a registry name (`variant: "engine:shared-verify"`),
    not `{ verifyPolicy }`. It returns `config: { maxCostUsd }` and the
    variant's record as `variant`.
  - **Core `review/eval.ts`** gains `VARIANT_NAME` (the name grammar) and
    `VARIANT_KEYS` (`engine` and `desktop`: `["verifyPolicy"]`), shared by the
    engine replay, the registry's tests and `desktop.ts`. The script may
    import only types from the engine, but it may import core values.
  - **Engine `review/eval.ts`**:
    - `ReplayInput.variant` (`Omit<VariantRecord, "applied">`);
    - the types `VariantRecord { name; keys; models?; applied? }`,
      `ReplayVariant` (that record, or VS-06's `{ verifyPolicy }`) and
      `ShrinkStep`;
    - artifact fields: `variant`, `context.locations`, `tier1?`, `shrink?`,
      and `passes[].startMs`, `ms`, `cacheRead` and `cacheWrite`;
    - step 0b, the refusals below.
  - **`desktop.ts`** takes `variant: { name, keys }` and records
    `{ name, keys, applied }`.
  - **`report.ts`** resolves the variants named in `--candidate` and
    `--baseline`, and lists each artifact's `variantProblems`.
  - **`certify.ts`** lists the `variantProblems` of the candidate's runs.
  - **The engine test helper** `test/lib/llm-server.ts`: `Usage.cached`.
    Without it every caller sends the same bytes.
  - **The README**: a "Pipeline variants" subsection and the new artifact
    fields.
- **Pending variants are refused, and where.**
  - **By name.**
    - `resolveVariant` refuses every pending name: today, all except
      `engine:shared-verify` and `desktop:shared-verify`.
    - `admitReplay` refuses it before `ledger.admit`, so no ledger entry is
      written.
    - `report.ts --candidate` and `--baseline` exit 2 with the detail. Only
      `single-prompt` and `empty` pass unresolved, so a mistyped runner
      (`Engine:shared-verify`, `engine :x`) is refused as malformed too.
    - An artifact carrying a pending name is a `report.ts` problem, which
      keeps the report from a release decision (`eval-report.ts:94,462`),
      and `certify.ts` refuses it.
  - **In the engine.** `ReviewEval.replay` cannot see the registry, so it
    refuses what would run the frozen pipeline, or something else, under a
    variant's name:
    - `config` that sets a key in `VARIANT_KEYS.engine` (a variant now
      arrives only as `variant`, so no run is unnamed). The type of
      `ReplayInput.config` leaves those keys out
      (`Omit<ReviewConfig, (typeof VARIANT_KEYS.engine)[number]>`), so the
      compiler refuses one from a typed caller, and this check is the
      backstop for an untyped one;
    - a name that is not `engine:<suffix>` under `VARIANT_NAME`;
    - a key outside `VARIANT_KEYS.engine`, the eval's limits included, or a
      key with no value (spreading `{ verifyPolicy: undefined }` would erase
      the parsed value);
    - no key and no model requirement;
    - a `triage-pair` variant without a triage model other than the review
      model.

    The engine cannot catch a registered name that carries another built
    variant's keys (say `engine:trivial-skip` with `verifyPolicy: "shared"`),
    so `variantProblems` does, in `report.ts` and `certify.ts`. A
    `report.test.ts` case shows it listed as pending:
    `{ name: "engine:privacy-zdr", keys: { verifyPolicy: "shared" } }`.
  - **Pending labels name the package that wires the key into the runner**,
    not the one that adds its type: `VS-23c`, `VS-24 wiring`,
    `VS-25b wiring`, `VS-26`, `VS-27c`, `VS-28 wiring` (`depth-auto` and
    `lenses-high`), `VS-29a` and `VS-31`. The desktop halves wait for
    `VS-23d`, `VS-24 wiring`, `VS-27c`, `VS-29a` and `VS-31`, or for "after
    VS-10" (`impact-graph`, `cards-brain`, `depth-auto`, `lenses-high`). The
    README's flip rule: a half turns built only in the package that makes its
    keys change what that runner does, with its D3 parity test, and that
    package adds the keys to that runner's `VARIANT_KEYS`. Landing a
    `ReviewConfig` key or a core module (VS-24's `trivial` and `dispatch`,
    VS-25b's core slice, VS-28's `risk.ts`) never flips one.
- **The critique, point by point.**
  1. *Engine-side refusal* (major): taken. The rule is "a non-empty subset of
     `VARIANT_KEYS.engine`, each with a value, or a model requirement", with
     tests (`{ name: "engine:trivial-skip", keys: {} }` and
     `{ name: "engine:shared-verify", keys: { verify: "all" } }` among them,
     0 LLM hits). It differs from the critique in two ways:
     - `VARIANT_KEYS` lives in core rather than in engine `eval.ts`, so the
       registry test checks every built half against the list its runner
       really uses;
     - the plan's separate `LIMIT_KEYS` check is gone, because `VARIANT_KEYS`
       is typed to exclude `maxCostUsd`, `maxSteps` and `timeoutMinutes`, so a
       limit can never become a variant key.
  2. *Per-runner readiness* (major): taken. Entries have `engine` and
     `desktop` halves, so today only `desktop:shared-verify` resolves on the
     desktop. In `desktop.ts`, `applied` holds only when the runner read its
     settings and the keys are a non-empty subset of `VARIANT_KEYS.desktop`,
     each with a value. A variant the desktop cannot apply in full is not
     handed to the runner at all, so the run is cleanly the frozen pipeline's,
     not a mix. Tested with `{ verifyPolicy: "shared", nits: true }`, `{}` and
     `{ verifyPolicy: undefined }`: each `applied: false`, with the frozen
     run's scope and verification.
  3. *`cross-family` as a model requirement* (major): taken, as
     `models?: "triage-pair"` on `VariantEntry` and `VariantRecord`.
     `variantProblems` compares it, and the engine refuses it without a
     distinct triage model; the entry stays pending for VS-29a. No family or
     lab check was built (codium's `labOf`/`checkedLabs`, §0.5, I-10). Two
     choices:
     - The engine accepts a `triage-pair` variant that has a distinct triage
       model, so VS-29a can flip the entry in the script alone, as the
       contract's VS-29a file list says (script only, no runtime code).
     - `admitReplay`'s check that it got two distinct models is **not**
       built. No built entry has a model requirement, so that branch could
       not be reached or tested through the real registry. VS-29a adds it
       with its flip. Until then the engine's refusal is the backstop.
  4. *Wall-time flake*: taken. The reply waits on a thenable that starts its
     150 ms timer only when the server awaits it, at request time, and the
     test asserts a lower bound only.
  5. *Aliases and labels*: taken. `legacy-verify` is dropped, because no code
     ever produced it. There is no alias table: every older name (`engine`,
     `engine:shared-verify`, `desktop`, `desktop:shared-verify`) is
     canonical, VS-06's records still name their runs, and tests prove both.
     The labels read "VS-24 wiring", "VS-25b wiring" and "VS-28 wiring".
  6. *The grammar defined twice*: taken differently. Instead of a copied
     literal there is one `VARIANT_NAME` in core, used by the engine and the
     registry. The registry test asserts every name matches it and has no
     `=`. The README says only the registry keeps model ids out.
  7. *Match passes by name*: taken, in the test and in the doc comments.
  8. *A union type for old artifacts*: taken. `ReplayArtifact.variant` is
     `ReplayVariant`, exported from engine `eval.ts`. `report.ts` and
     `certify.ts` read it through `replayVariant` and `variantProblems`. The
     "old artifacts still load" tests stay, and a VS-21a record now pairs
     under the same case key as VS-06's.
  9. *`ShrinkStep` and locations*: taken. `ShrinkStep` is
     `{ step: string; estimate: { lowTokens; lowUsd? } }`, and VS-24 owns it
     and aligns it with `DispatchEstimate`. `context.locations` leaves out
     the changed files (already in `files.reviewed`), instructions and
     history on purpose: they carry no line.
  10. *Regression coverage and fan-out*: taken.
      - `test/session/prompt.test.ts`, whose `@ai-sdk/openai` case drives
        the helper's responses path, ran as well as `run.test.ts`.
      - `passes[].startMs` (each pass's first message after the first
        message of any pass) was added beside `ms`, so the parallel-start
        stagger behind VS-24 step 5 and `REPORT.md:372` shows offline.
- **Where this departs from the contract text.**
  - **Files.** The contract names `replay.ts`, `report.ts`, the README and
    engine `eval.ts`. The record shape `{ name, keys, applied? }` is shared
    by both adapters, so `desktop.ts` and `certify.ts` change too, along with
    core `review/eval.ts` (the shared constants), the engine test helper and
    the tests.
  - **Cache figures** come from each pass's own session through
    `measureCost`, the function `ReviewPass` uses, not from
    `ReviewPass.cacheRead`. `ReviewPass` has no `cacheWrite`, and adding one
    would change `ReviewOutcome`, a runner output (I-1). `cacheRead` equals
    the outcome's pass of the same name by construction, and the test checks
    it (400 cached tokens from the fake server, which also shows that the
    chat protocol's `prompt_tokens_details.cached_tokens` reaches
    `tokens.cache.read`).
  - **Wall time** comes from session message timestamps (first created to
    last completed). It adds no observation event to `run.ts`.
  - **`ReplayInput.config` now refuses `verifyPolicy`.** This changes the eval
    harness, not a runner, and nothing outside the tests calls
    `ReviewEval.replay` yet.
  - **`lenses-high`** is `depth: "auto"` plus `lenses: "high"`, because lenses
    run only on the high band under depth `auto` (VS-28 step 2). Its ablation
    baseline is therefore `engine:depth-auto`. VS-28 may revise this before
    it flips.
  - **`context.locations`** holds today's related-code call sites, in prompt
    order. `quotedLocations` (engine `eval.ts`) selects them as `buildPrompt`
    does: entries with hits, the first 10, 15 hits each (`prompt.ts:99-100`,
    copied as named constants because `prompt.ts` is in the pipeline pin and
    exports neither). So the list does not depend on ReviewContext's caps
    (`context.ts:15-16`) staying equal to the prompt's. A test renders a
    prompt past both caps (12 symbols, 16 hits each) and checks the list
    against the prompt's own lines. `tier1` and `shrink` are typed only.
  - **Per-pass usage** combines every session of a pass name, so a retry,
    finalizer or lens in a new session would still be counted. Today
    `run.ts` has one session per pass. VS-28's lenses, several pass events
    of one name, must also match by lens.
  - **The desktop artifact** gets no per-pass timing until `report.ts` loads
    desktop artifacts (VS-21c). This is a documented difference.
- **Off by default (I-1).**
  - No runner is touched: not `run.ts`, `ai-review.ts`, `provider.ts`,
    `session/llm.ts` or `posting.ts`. No @vector file, no generated code, no
    `ReviewConfig` or `config.ts` change, and no `EVIDENCE_POLICY_KEYS` or
    `EvidenceScope` change.
  - With no variant, the frozen replay is unchanged: the environment passed
    to `parseReviewConfig`, `config.value`, scope, rules, prompts, attempts,
    tools and posts. The artifact only gains optional fields.
  - `REVIEW_PIPELINE_SOURCES` stays `fa1d31befd5a4f77` (the pin test was
    re-run) and `REVIEW_PIPELINE_REVISION` stays 1.
  - No dependency was added, so no `bun install` ran. No user-visible string
    changed (D14).
- **Owner questions.** None of Q1-Q17 is decided. Q13 stays open: nothing is
  wired into a runner. Q15 stays open: registering a name approves no
  package. Q9's ablation budgets are untouched.
- **Evidence.** Each file was run alone through the lock with
  `--timeout 30000`, `GITHUB_ACTIONS=false`, and `TMPDIR` and XDG roots
  under a fresh `/tmp/vector-vectorscope/vs21a-*`. All have 0 fail:

  | Where | File | Pass |
  |---|---|---|
  | engine | `test/review/eval.test.ts` | 16 (12 before) |
  | engine | `test/review/run.test.ts` | 41 |
  | engine | `test/session/prompt.test.ts` | 144 (1 skip, the pre-existing `.skip` at line 1905) |
  | core | `test/review/model-evidence.test.ts` | 16 (pin unchanged) |
  | core | `test/review/eval.test.ts` | 42 |
  | eval scripts | `replay` | 25 (18 before) |
  | eval scripts | `report` | 22 (21 before) |
  | eval scripts | `certify` | 6 (5 before) |
  | eval scripts | `judge` | 6 |
  | eval scripts | `ci` | 18 |
  | `packages/script` | `fixtures.test.ts` | 50 |

  `bun typecheck` in core and engine, and `bun tsgo -p
  ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`, all
  exit 0. Nothing is committed or pushed, so the full turbo typecheck that
  the lane rules require before a push has not run yet.
- **Deferred.**
  - VS-21b: the `RunInput` projection hook and the projection driver.
  - VS-21c:
    - `VARIANTS`/`PIPELINE` validation in `ci.ts`, which will use
      `resolveVariant`;
    - the report metrics on the new fields (wall time per pass, cache
      shares);
    - loading desktop artifacts in `report.ts`, and then their per-pass
      timing.
  - VS-29a: `admitReplay`'s two-model check, with its flip.
  - VS-28: per-lens pass matching.
  - A registry digest that `admitReplay` hands out and `ReviewEval.replay`
    echoes (the review's optional suggestion). Not built: nothing would read
    it before VS-21c's `ci.ts` validation, and `variantProblems` already
    flags a mismatched record downstream.
  - VS-25b: filling `tier1` and appending the slice's locations.
  - VS-24: filling `shrink`.
- **Review fixes (same day).** All eight review findings were taken, none
  blocking:
  1. `replayVariant` and `variantProblems` guard a record that is not an
     object, or a name that is not a string, before the `in` check. A
     primitive record names the frozen pipeline (VS-06's reader did the same)
     and is listed as `its variant record is not an object`, so `report.ts`
     blocks the release decision and `certify.ts` refuses. This is tested in
     `replay`, `report` and `certify`.
  2. `ReplayInput.config` leaves `VARIANT_KEYS.engine` out of its type. A
     `@ts-expect-error` line in the engine test pins that, and the runtime
     refusal still covers an untyped caller.
  3. A new engine test runs review and verify, each in its own session. It
     checks that verify's `startMs` is at least 150 ms and that each pass's
     `cacheRead` (400 and 1,500) equals the outcome's same-named entry. Under
     a $0.20 cap, verify is planned, skipped for budget, and has none of the
     four fields.
  4. and 6. `report.ts` `group()` passes only `single-prompt` and `empty`
     as given and resolves every other name, so a capitalised or
     space-padded runner is refused as malformed and an unrelated word as
     naming no runner.
  5. `context.locations` applies the prompt's own selection (above), with a
     test past both caps.
  7. Taken as a test, in `report.test.ts` and `replay.test.ts`. The optional
     registry digest is deferred (see Deferred, above).
  8. Combined, as above. No per-pass `sessions` count was added: with every
     session counted, it would show nothing more.

  Re-run after the fixes, each alone through the lock as above: engine
  `test/review/eval.test.ts` 16, `replay` 25, `report` 22, `certify` 6 and
  core `test/review/model-evidence.test.ts` 16 (pin unchanged), all with
  0 fail. `bun typecheck` in the engine and the scripts' `tsgo` both exit 0,
  and `prettier --check` passes on the changed files. `run.test.ts`,
  `prompt.test.ts` and the core suites were not re-run: this round touched
  no runner, no core file and no test helper.

## 2026-11-06 · VS-21b Projection

Contract §4 VS-21b of `vectorscope-upgrade.md`, in the "Now" window: eval work
plus one `RunInput` hook that changes nothing when unset. It adds no
`ReviewConfig` key, no `types.ts` or `config.ts` change, no
`EVIDENCE_POLICY_KEYS` or `EvidenceScope` change and nothing to `VARIANT_KEYS`,
and flips no `VARIANTS` half. It touches none of `ai-review.ts`,
`provider.ts`, `session/llm.ts` or `posting.ts`, and no file @vector owns. It
implements the VS-21b plan as corrected by its critique; the critique bullets
below say where a point was taken differently.

- **What landed.**
  - **`packages/engine/src/review/run.ts`, the hook.**
    - `RunInput.projection?: Projection`, with
      `Projection { overCap(decision: OverCap): boolean }` and
      `OverCap { pass; phase; site: "pass" | "attempt" | "finalizer" | "verify"; estimateUsd; sessionID? }`.
    - A private `lift(decision)` is false when the hook is unset, and false
      when it throws (the same try/catch as `observe`), so the cap holds.
    - `reserve(name, turn, finalize, at)` asks `lift` only when the cap would
      refuse: before a pass's session (`pass`), at a provider attempt
      (`attempt`, with the session), and at the finalizer's reservation
      (`finalizer`, with the session).
    - Verify's pre-check asks it only when verify would otherwise run, so a
      verify skipped for time is never asked about.
    - The `pass` Observation gains `maxSteps` (the pass's step cap).
    - Nothing else in `run.ts` changed. Its two `/ 3.5` literals stay.
  - **`packages/engine/src/review/eval.ts`**, `ReviewEval.project`, which
    nothing calls yet:
    - `replay` is now `replayWith(input, false)` and returns the same
      artifact. `replayWith(input, true)` is the only place that sets the
      hook, and `ReplayInput` has no field for it, so the paid path (VS-21c)
      cannot lift its cap;
    - types `WireRequest`, `ProjectionInput` (a replay's input without
      `posting`, `check` and `secrets`, plus `server`, `received` and
      `egress`),
      `ProjectedOverCap`, `ProjectedRequest`, `ProjectedPass` and
      `ProjectionRecord` (`kind: "projection"`);
    - `projectionRefusal` and `routeRefusal` (below);
    - `CHARS_PER_TOKEN` (3.5).
  - **`packages/engine/test/lib/llm-server.ts`**, additive:
    - `Hit` is exported and gains `text` (the raw body) and `session` (the
      `X-Session-Id` header);
    - the body is parsed with `Schema.UnknownFromJsonString` from that text,
      `{}` on failure as before;
    - `respond(answer)` answers what nothing queued matches until `reset`.
  - **`packages/engine/test/fixture/projection.ts`**, the canned model. It
    has `projectionFindings`, `projectionReplies`, `projectionVerdicts`,
    `received` and `firstUserText`. It is test code: VS-21c's entry point does
    not import it from the test tree (see the review fixes, item 10).
  - **`script/vectorscope-eval/replay.ts`**: `projectionProblems(record)`,
    which reads the record as untrusted JSON through field names typed against
    `ProjectionRecord`.
  - **The README**: a "Projection (VS-21b)" subsection under Production
    replay.
  - **Core `model-evidence.ts`**: the pin.
- **The precondition, in three stages.**
  1. **Before anything touches `Provider.Service`, git or the instance.**
     `projectionRefusal` refuses:
     - `VECTOR_DISABLE_MODELS_FETCH` unset (it is read when `flag.ts` loads,
       so it must be in the environment before any engine module loads);
     - no strict egress guard installed (`EgressGuard.strictInstalled()`,
       added to core `local-mode/guard.ts` in the review fixes);
     - a fake server (`ProjectionInput.server`) that is not a loopback
       http(s) URL;
     - a model on `vector` or `ModelPlans.PROVIDER_ID`;
     - a model that is not `priced`, or has no price.
  2. **Then `getProvider` and `getModel` for each model.** `routeRefusal`
     follows where `getLanguage` would send (`provider.ts` `resolveSDK`,
     mirroring the private `offInLocal`/`requestOrigins`, as its comment
     says). It refuses:
     - a model that is missing;
     - a `freeModel`;
     - a function in the provider's `options.fetch`;
     - anything `sendsToOpenRouter` (reused from core `free-model-catalog.ts`);
     - an SDK other than `@ai-sdk/openai-compatible` and `@ai-sdk/openai`;
     - no base URL where the SDK sends (`resolveBaseURL`: the configured
       base URL, else the catalog's);
     - an `options.baseURL`, catalog `api.url` or `preconnect` that is not a
       loopback http(s) URL with no `${VAR}` left;
     - a destination or `preconnect` whose origin is not the fake server's;
     - a price snapshot that is not `SpendGuard.priceOf(model.cost)`.
  3. **After the replay.** It fails when the fake server received requests
     and the egress log saw none of them.
- **The record.**
  - `ProjectionRecord` copies the replay's runtime (isolation included),
    source, trust, trigger, config digest, variant, scope, rules and context
    digests, models and files.
  - Each pass, from the `pass` events in order, has:
    - its requests, from the projection's `received` log. Each session's k-th
      admitted attempt (seq order) is paired with the k-th request carrying
      that session header (arrival order);
    - per request: `seq`, `phase`, `estimateUsd`, `lifted?`, `digest`,
      `chars`, `tokens = ceil(chars / 3.5)`, and
      `stepUsd = nextStepCostUsd(tokens, price)`;
    - `promptTokens`, and `usd = estimateCostUsd({ promptTokens, maxSteps, price })`;
    - `lifted` (its first lifted decision), and `unsent`/`unadmitted`.
  - `unattributed` counts requests naming no session an attempt names.
  - `cap: { maxCostUsd, over }`.
  - `egress: { attempts, outside }`, where `outside` is
    `!allowed || !LocalPolicy.loopback(host)` over the strict guard's attempts
    made from the start of `project`, providers booting included.
- **Cap semantics** (corrected from the plan, whose two claims were wrong).
  - A capped paid run's refusal stops only that pass: it runs its finalizer,
    and verify gets fewer candidates. Reservations are released when a pass
    ends and replaced at each settlement, so a later, smaller decision can fit
    again.
  - Once one decision is lifted, its spend and reservation count against
    every other pass. So from `cap.over[0]` on, a record describes an
    uncapped run: the upper side of the cost estimate, not a projection of
    the capped paid run.
  - `cap.over[0]` is not "where a paid run would have stopped".
  - A request admitted through a lift at admission is `lifted: true`.
    `ProjectedOverCap.attempt` is the seq of the attempt it admitted, for
    `site: "attempt"`, since admission observes that attempt synchronously
    right after the decision.
- **Where this departs from the contract.**
  1. **The hook decides only dollar-cap refusals.** It does not replace the
     admission policy: step and time stops, retries and the reservation
     bookkeeping stay the review's. It cannot refuse what the cap admits, so
     a declining hook behaves exactly like none. Every attempt is still
     admitted and reserved (I-5).
  2. **The projection lives in engine `eval.ts`** (private `replayWith`), not
     in a new file or in `replay.ts`. That keeps the cap lift out of
     `ReplayInput`. `replay.ts` holds the validator.
  3. **`TestLLMServer` is reused** with additive raw-body, session-header and
     responder changes. The canned model is in `test/fixture`.
  4. **"Zero outbound requests on a recording fetch"** is checked on the
     strict egress guard's own attempt log (`NetworkGuard.use()`), which sees
     fetch, sockets, node:http and WebSocket. It does not use a replaced
     `globalThis.fetch` (AGENTS.md: no mocks of globals).
  5. **The `pass` Observation gains `maxSteps`.** `CHARS_PER_TOKEN` is defined
     in engine `eval.ts`, citing `run.ts`'s two literals, not exported from
     `run.ts`.
  6. **The lens, guardrail and repro passes do not exist yet.** The record is
     per pass name, so they appear when VS-27, VS-28 and VS-30 add them.
- **Departures from the plan.**
  - `reserve(name, turn, finalize, at)` instead of
    `reserve(name, phase, turn, finalize)`.
  - `OverCap` gains `site` and `sessionID`. `site` was not asked for, but
    without it the finalizer's reservation and the finalizer's admission look
    the same (both a session and phase `finalize`).
  - `replayWith` takes a boolean, not a `Projection`.
  - `routeRefusal` is new.
  - `ProjectionInput` gains `egress`.
  - The record gains `trust`, `trigger`, `runtime`, `rules`, `context`,
    `egress`, request `seq` and `lifted`, and pass `chars` and `lifted`.
  - The fixture also exports `projectionVerdicts` and `firstUserText`.
- **The critique, point by point.** All twelve were taken; two differently.
  1. *Precondition order* (major): taken, as the two stages above. A test runs
     `project` with a `Provider.Service` whose every method dies, on a case
     directory that does not exist. The Vector-route and unpriced refusals
     come back with 0 server hits, so no provider booted and no git ran. The
     flag and guard branches are tested through `projectionRefusal`'s input
     only, since the flag is fixed when the engine loads.
  2. *Destination check* (major): taken, as `routeRefusal`, with a unit case
     for each refusal (17 refused routes and 3 accepted ones). A real
     stage-two refusal also runs through `project`: a provider with base URL
     `https://api.example.com/v1` is refused with 0 server hits.
     - **Taken differently:** OpenRouter is refused through core's
       `sendsToOpenRouter` (provider ID, npm or URL), rather than by an
       npm-name check of its own. That is stricter, and reuses main's check
       (I-10).
  3. *Egress* (major): taken. Stage one refuses without a guard, the record
     carries `egress`, and `projectionProblems` flags `outside > 0` or a
     missing egress record.
     - **Limit, closed in the review fixes (item 1):** `EgressGuard.installed()`
       is also true for the CLI's Vector Local backstop, which logs nothing
       while Vector Local is off. Stage one now requires
       `EgressGuard.strictInstalled()`, `project` fails when the log saw none
       of the fake server's requests, and `projectionProblems` flags such a
       record.
  4. *Cap semantics* (major): taken, as above. Both claims were dropped from
     this entry and the README.
  5. *Circular assertions*: taken. The engine test checks things that do not
     come from the same hits:
     - the digest of a text part of each pass's first user message (decoded
       from the wire) equals the pass digest `Review.run` observed;
     - the finalizer request's last user text is `buildFinalizePrompt()`;
     - the review body lacks the security prompt's opening, and the reverse;
     - verify's decoded prompt names exactly the candidate ids, computed
       separately with `normalizeFindings`;
     - the same canned model through `ReviewEval.replay` leaves verify `ok`
       with no `rejected-by-verify` or `unconfirmed` drops, and every placed
       finding verified.

     The formula checks stay, as wiring checks.
  6. *Parity tied to HEAD*: taken.
     - **The HEAD comparison.** Before `run.ts` was edited, a scratch test
       (outside the worktree, under `/tmp/vector-vectorscope/`) ran three
       dollar-cap scenarios with no hook: refused before the session; a
       second attempt and the finalizer refused; verify's pre-check refused.
       It recorded SHA-256 prefixes of each request body (instance directory
       normalised) and of each outcome (without `durationMs` and `sessions`).
       After the change the same test printed identical digests:

       | Scenario | Requests | Body | Outcome |
       |---|---|---|---|
       | `pass` | 0 | none | `0f7f1481373662fb` |
       | `attempt` | 1 | `62bae14a1870cfda` | `0cb333061c68c382` |
       | `verify` | 1 | `62bae14a1870cfda` | `50571dfdb7d0fcef` |

     - **Taken differently:** the digests are recorded here, not pinned in a
       test. The bodies hold the engine's whole system prompt and tool
       definitions, so a pinned digest would break on any unrelated prompt or
       tool change, the next merge of main included.
     - **In the file.** `run.test.ts` has the permanent D3 test: the same three
       scenarios, unset, declining and throwing, with identical bodies and
       outcomes, and the declining hook asked at exactly
       `[pass]`, `[attempt, finalizer]` and `[verify]`.
     - Test counts below are from the runs. `run.test.ts` reports 41 tests at
       HEAD: 37 declarations, two of them inside loops of three (the
       "retains incomplete" usage cases and the context-tier finalizer
       cases), so 35 + 3 + 3.
  7. *`CHARS_PER_TOKEN`*: taken. It is in engine `eval.ts`, and `run.ts`'s
     literals are untouched.
  8. *Late verify*: taken. `late` is computed first, and `lift` is asked only
     when `verifyText !== "" && !late`. A test with `timeoutMinutes: 1` shows
     no decision asked, and verify skipped for budget as before.
  9. *Validator gaps*: taken. `projectionProblems` reports:
     - a pass that is not `ok`;
     - no pass while files were reviewed;
     - a missing egress record, or connections outside;
     - plus the plan's checks (no request, an empty body, `chars` mismatch, no
       `usd`, unsent/unadmitted/unattributed, `variantProblems`).

     `replay.test.ts` has a case for each.
  10. *Verify responder*: taken. `projectionVerdicts` reads the decoded first
      user message. The test also shows the raw JSON body yields no id.
  11. *Record fields and handling*: taken. Runtime with isolation, and the
      context and rules digests, are copied. The README says records are
      sealed eval outputs, never committed (I-13), uploaded only as sealed
      artifacts in VS-21c.
  12. *Test and setup details*: taken. The test computes
      `LocalPolicy.loopback(attempt.host)`. The README and the VS-21c
      deferral say the flag must be set before any engine module loads.
- **Fidelity limits** (also in the README).
  - Transforms keyed on the destination do not run at loopback:
    `isOpenRouterURL`'s `denyDataCollection`, and the `api.openai.com`
    prompt-cache marker.
  - Only the chat completions and responses protocols are covered (no
    Anthropic messages).
  - Each canned pass takes one step, so growth over several steps shows only
    in `usd`'s range.
  - Tokens are characters over 3.5 of the JSON body, whose escaping inflates
    them. There is no tokenizer and no `count_tokens` (C-12).
- **Off by default (I-1).**
  - Only `ReviewEval.project` sets `RunInput.projection`. `review.ts` and
    `github.review.ts` never set it and are not edited.
  - Unset, every `lift()` is false, so all four decisions, the requests and
    the outcomes are byte-identical. The HEAD digests and the D3 test above
    show it, along with the existing 41 `run.test.ts` and 16 `eval.test.ts`
    cases, which pass unchanged.
  - `ReviewEval.replay`'s artifact is unchanged.
  - No key was added, so `policyDigest`, `promptsDigest` and `EvidenceScope`
    do not move.
  - **Desktop:** `ai-review.ts` has no projection hook. This is an intentional
    difference (`vectorscope-plan.md:320`) until VS-10.
- **Pin.** `REVIEW_PIPELINE_SOURCES` moved from `fa1d31befd5a4f77` to
  `228a42cb975134ce` (`run.ts` is in the pinned files). No revision bump:
  - nothing changes with the hook unset;
  - projection records never feed a certificate (`kind: "projection"`, and
    `certify.ts` reads replays only).

  `REVIEW_PIPELINE_FILES` is unchanged, and `REVIEW_PIPELINE_REVISION` stays 1.
- **Owner questions.** None of Q1-Q17 is decided. Q13 is not needed: the hook
  is off by default, as the lane notes allow. Q15 stays open.
- **Evidence.** Each file was run alone through the lock with
  `--timeout 30000`, `GITHUB_ACTIONS=false`, and `TMPDIR` and XDG roots under a
  fresh `/tmp/vector-vectorscope/vs21b-*`:

  | Where | File | Pass |
  |---|---|---|
  | engine | `test/review/run.test.ts` | 44 (41 before) |
  | engine | `test/review/eval.test.ts` | 23 (16 before) |
  | engine | `test/session/prompt.test.ts` | 144, 1 skip (the pre-existing `.skip`) |
  | engine | `test/session/memory-every-agent.test.ts` | 14 |
  | engine | `test/cli/review.test.ts` | 24 |
  | engine | `test/cli/review.render.test.ts` | 10 |
  | engine | `test/cli/github.review.test.ts` | 40 |
  | engine | `test/cli/github.review-api.test.ts` | 3 |
  | engine | `test/local-mode/local-run.test.ts` | 30, 1 fail (pre-existing, below) |
  | core | `test/review/model-evidence.test.ts` | 16 (pin updated) |
  | eval scripts | `replay` | 27 (25 before) |
  | eval scripts | `report` | 22 |
  | eval scripts | `certify` | 6 |
  | eval scripts | `ci` | 18 |

  - **The one failure is pre-existing and comes from the environment.**
    `local-run.test.ts` "changes nothing with Vector Local off" lists an
    `amazon-bedrock` provider in this container. The same case fails the same
    way on HEAD's engine, extracted with `git archive` into scratch (no
    worktree was added, since the git directory is the owner's checkout).
    It only lists providers, which this package does not touch.
  - **Typecheck.** `bun typecheck` in core and engine, and
    `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json` from
    `packages/engine`, all exit 0.
  - **Formatting.** `prettier --check` passes on every changed file except
    `run.ts`, whose two pre-existing unformatted lines (the `context` type at
    line 105 and the `claims` ternary at 690 on HEAD) were left alone, to keep
    `run.ts`'s diff to the hook.
  - Nothing is committed or pushed, so the full turbo typecheck the lane
    rules require before a push has not run.
  - No dependency was added, so no `bun install` ran. No user-visible string
    changed (D14).
- **Deferred to VS-21c.**
  - The entry point, `packages/engine/script/vectorscope-replay.ts`:
    `EgressGuard.installStrict` as its first import, whose `attempts` it
    passes as `egress`; `VECTOR_DISABLE_MODELS_FETCH`,
    `VECTOR_DISABLE_PROJECT_CONFIG`, `VECTOR_PURE`,
    `VECTOR_DISABLE_AUTOUPDATE` and `VECTOR_BRAIN_EMBED=off` set in the
    environment before any engine module loads; a dummy key in its provider
    config; the fake server's base URL as `server`; serving the canned model,
    after moving it and the server's record-and-respond surface out of the
    test tree (or recording here that it imports test fixtures on purpose).
  - `ci.ts PIPELINE=replay`, projecting seed cases ×
    {`engine`, `engine:shared-verify`} and failing on any
    `projectionProblems`.
  - A variant-record resolver for projections. There is no ledger: a
    projection spends nothing.
  - The estimate-error metric (projection versus paid).
  - Rendering projections in the report.
- **Deferred to later.**
  - Desktop projection, after VS-10.
  - Anthropic's messages protocol in the fake server.
  - Canned sessions of several steps.
- **Review fixes (same day).** Eleven findings, one blocking. All were taken;
  three were taken in part, and the bullets say why. Nothing is committed.
  1. *The egress precondition failed open* (blocking): taken, all three
     parts.
     - Core `local-mode/guard.ts` (not @vector's, and no runner) gains
       `strictInstalled()`, true only while `installStrict`'s guard is in
       place. It is named beside `installed()`, not `strict()`, which names
       NetworkGuard's installer in tests. `guard.test.ts` checks it true and
       then false around the strict guard's uninstall, and false under
       Vector Local's guard while `installed()` is true.
     - `projectionRefusal` takes `strictGuard` in place of `guarded`, and
       `project` passes `EgressGuard.strictInstalled()`. The refusal no longer
       claims that nothing can leave this computer; it says the strict guard
       refuses connections off it and logs every attempt the record counts.
     - After the replay, `project` fails with a `ReviewEvalError` when the
       fake server received requests and the egress log saw none of them. An
       engine test passes `egress: () => []` under the file's strict guard
       and gets that error.
     - `projectionProblems` reports a record whose `egress.attempts` is 0
       while its passes sent requests (see item 4).
  2. *The dollar cap lifted for any loopback destination*: taken.
     `ProjectionInput.server` is the fake server's base URL. Stage one refuses
     one that is not a loopback http(s) URL. `routeRefusal` requires the
     origin of where the SDK sends, and of any `preconnect`, to be
     `LocalPolicy.origin(server)`. Unit cases refuse another port, another
     name for this computer (`localhost` against `127.0.0.1`), `https`
     against `http`, a stray `preconnect`, and a server that is not a URL.
     - **Taken differently.** The finding asked for every named URL to match.
       The engine's test provider has the catalog `api.url`
       `http://127.0.0.1:1234/v1` (LM Studio's default port), which its
       configured base URL replaces; the first run of the engine tests
       refused every projection for it. So the origin rule follows
       `provider.ts` `resolveBaseURL`: the configured base URL, else the
       catalog's. A catalog URL that a base URL replaces must still be on
       this computer, as before, but it is not sent to.
     - **Also fixed.** A provider with only a `preconnect` passed the "names
       no base URL" check, and its SDK would have chosen where to send. It is
       now refused, with a unit case.
  3. *The egress window opened after providers booted*: taken. `earlier` is
     the first statement of `project`, so the record counts connections made
     in step 2. The `received` snapshot stays before the replay.
  4. *An empty egress log read as clean*: taken. `projectionProblems` reports
     "it has no egress record" when `attempts` or `outside` is not a number,
     and "its egress log saw none of its N requests, so no strict guard
     recorded the run" when `attempts` is 0 while the passes sent N. Both are
     cases in `replay.test.ts`, with a record that sent nothing and logged
     nothing passing.
     - **Taken in part.** The check is `attempts === 0`, as asked, not
       `attempts < N`. The guard keeps only its last 2,000 attempts, so a
       count would fail a long run for a reason that is not egress. The
       engine tests do assert that the strict guard logged at least one
       attempt per request, in the main projection and the retry case.
  5. *Files and `unattributed`*: taken. "its files are not a record" comes
     first when `files.reviewed` is not a list, so a record with no passes
     and no files is no longer clean. A missing `unattributed` reads "it has
     no unattributed count". Each has a `replay.test.ts` case.
  6. *Retries were not covered*: taken. A new engine test queues
     `httpError(500)` for review, then the canned model. The review pass has
     two `turn` requests with increasing seqs. The server's review hits are
     exactly the two recorded bodies, in order, the failed one first.
     `unsent`, `unadmitted` and `unattributed` are 0.
     - **Taken in part.** The test does not call `projectionProblems`. It
       lives in `script/vectorscope-eval/replay.ts`, and imports run from the
       scripts to the engine only. The test asserts each field
       `projectionProblems` reads instead, and `replay.test.ts` covers the
       function.
  7. *No lifted finalizer*: taken. In "runs what the cap refuses", the
     `attempt` scenario runs with the lifting hook: a read, a lifted second
     turn that answers in prose, then the finalizer's reservation and its
     admission, both lifted. The finalizer request reaches the server, review
     is `ok`, and the hook was asked `[attempt, turn]`,
     `[finalizer, finalize]` and `[attempt, finalize]`, all for review's
     session.
  8. *`CHARS_PER_TOKEN` could drift from admission*: taken, as an
     `eval.test.ts` assertion. Under the tight cap, verify's pre-check
     `estimateUsd` equals the low side of
     `estimateCostUsd({ promptTokens: ceil(verify.chars / CHARS_PER_TOKEN), maxSteps, price })`.
     Verify's pre-check is the site that divides the prompt alone. The
     `pass` site adds the schema and `NEXT_STEP_SLACK`. `run.ts` is
     untouched, so the pin does not move.
  9. *The record comment understated what it holds*: taken. The
     `ProjectionRecord` comment and the README's "Records are sealed"
     bullet now say that a replay artifact names prompts by digest and holds
     redacted posts, while a projection record holds every raw request body,
     unredacted, and is handled at least as strictly as a checkout.
     - **Optional part not taken.** Redacting the stored body with `secrets`
       is not done. The contract asks for each pass's real wire body. A
       redacted copy beside a raw `chars` and `digest` would fail
       `projectionProblems`' check that `chars` is the body's length, or need
       a second count. A replay's `secrets` redact posts, and a projection
       has none. Sealing the records is the control.
  10. *The fixture invited a runtime import of test code*: taken as a
      comment. `test/fixture/projection.ts`, the README and VS-21c's deferral
      say the entry point moves the canned model and the server's
      record-and-respond surface out of the test tree first, or records here
      that it imports them on purpose.
  11. *An explicit annotation*: taken. `const info` is inferred, with a
      comment that `getProvider` indexes the booted providers, so an unknown
      ID is undefined at runtime whatever its type says. The guard stays.

  Re-run after the fixes, each file alone through the lock with
  `--timeout 30000`, `GITHUB_ACTIONS=false`, and `TMPDIR` and XDG roots under
  a fresh `/tmp/vector-vectorscope/vs21b-fix-*`:

  | Where | File | Pass |
  |---|---|---|
  | engine | `test/review/eval.test.ts` | 25 (23 before) |
  | engine | `test/review/run.test.ts` | 44 (one test extended) |
  | core | `test/local-mode/guard.test.ts` | 45, 2 fail (pre-existing, below) |
  | core | `test/review/model-evidence.test.ts` | 16 (pin unchanged) |
  | eval scripts | `replay` | 27 (two tests extended) |

  - **The two `guard.test.ts` failures are pre-existing.** They fail the same
    way with HEAD's `guard.test.ts`, which was copied in for one run and then
    replaced with this round's copy: "sends what it allows to this computer
    around the proxy environment" lists `127.0.0.1` twice in `destinations`,
    and "reads NO_PROXY the way Bun's fetch does" has a child process that
    cannot listen on `::1` (`EADDRINUSE`). Both come from this container's
    network setup. The new `strictInstalled()` assertions sit in two other
    tests, which pass.
  - **Typecheck.** `bun typecheck` in core and engine, and
    `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json` from
    `packages/engine`, all exit 0.
  - **Formatting.** `prettier --check` passes on every code file changed in
    this round and on the README. This log fails it at HEAD too (its italics
    and wrapped code spans), so it keeps its own style.
  - The other engine suites in the table above were not re-run. This round
    touched no runner (`run.ts`'s pin is unchanged), no test helper and no
    CLI.

## 2026-11-06 · VS-21c Paid entry point and CI

Contract §4 VS-21c of `vectorscope-upgrade.md`, in the "Now" window: a new
engine file that nothing in the product calls, eval-script work, and pure core
report code. It adds no `ReviewConfig` key, no `types.ts` or `config.ts`
change, no `EVIDENCE_POLICY_KEYS` or `EvidenceScope` change and nothing to
`VARIANT_KEYS`, and flips no `VARIANTS` half. Nothing under
`packages/engine/src` changed, so no runner, provider, LLM or posting file and
no file @vector owns was touched. It implements the VS-21c plan as corrected
by its critique; the critique bullets below say where a point was taken
differently. The branch moved during the work from `765ef4ec` to `13b9db02`
(another lane's test-only commit, touching five test files, none of these);
the citations and evidence below are on `13b9db02`. Nothing is committed.

- **What landed.**
  - **`packages/engine/script/vectorscope-replay.ts`**, the entry point. It
    runs from `packages/engine` (its bunfig and `@/` paths) and is typechecked
    by the engine's `bun typecheck`. Exports, all pure except `main` and
    `projectionModel`:
    - `PROJECTION_PROVIDER` (`vectorscope-projection`), `PAID_PROVIDER`
      (`openrouter`), `CATALOG` (the committed
      `packages/web/public/models/api.json`), `USAGE`;
    - `parseReplayArgs(argv)`: `--model <id>=<in>:<out>`, `--manifest`,
      `--mirrors`, `--work` (absolute, outside the repository), `--split`
      (development by default, or calibration, held-out, all), `--variant`
      (repeatable, default `engine`; each through `variantRecord`),
      `--repeat` 1-5, `--budget-usd` with `--case-budget-usd`, `--ledger` and
      `--out` (outside the repository), `--dry-run`;
    - `replayMode(flags, env)`: dry without a budget or with `--dry-run`;
      otherwise paid only when every send rule holds, else refused (below);
    - `catalogModel(catalog, id, price)`: the committed catalog's OpenRouter
      entry, read as untrusted JSON with `Object.hasOwn`, refused when missing,
      tool-less, unpriced or priced other than the price given;
    - `providerKeys(catalog)`: every provider `env` name the catalog lists,
      the eval key aside;
    - `engineEnvironment(root)`: XDG roots and `HOME` under `root`,
      `VECTOR_DISABLE_MODELS_FETCH=1`, `VECTOR_MODELS_PATH` the committed
      catalog, `VECTOR_PURE=1`, `VECTOR_DISABLE_PROJECT_CONFIG=1`,
      `VECTOR_DISABLE_AUTOUPDATE=1`, `VECTOR_DISABLE_USAGE=1`,
      `VECTOR_BRAIN_EMBED=off`, `VECTOR_AGENT_DB=:memory:`. No key;
    - `engineConfig(input)`: `VECTOR_CONFIG_CONTENT` with `lsp`, `formatter`
      and `snapshot` off and `enabled_providers` naming one provider. Dry: the
      catalog entry under `vectorscope-projection` at the fake server with a
      dummy key (its `cost` with `cache_read`, `cache_write` and
      `context_over_200k`). Paid: OpenRouter with `apiKey` the literal
      `{env:VECTORSCOPE_EVAL_API_KEY}`;
    - `projectionModel(id)`: the dry `ResolvedModel` from the booted model,
      priced with `SpendGuard.priceOf(loaded.cost)`;
    - `main(argv, io)`.
  - **The dry branch** (`projectDry`). It installs `EgressGuard.installStrict()`
    before the first engine module loads, runs under `TestLLMServer.loopback`,
    sets the dry config before the first instance loads, and for each planned
    case and variant (repetition 1) prepares a fresh checkout, checks it clean
    at its base, loads an instance on it, answers with `projectionReplies`, runs
    `ReviewEval.project` with the strict guard's `attempts` as `egress`, and
    disposes the instance and removes the checkout. A failure is a line naming
    the case, never a throw. Each record goes through `projectionProblems`;
    with `--out` it is written as
    `<model>--<case>--<variant>--r1.projection.json`. It prints a line per
    case and variant, `renderProjections`, and
    `Dry run: nothing was sent. The strict egress guard logged N connection attempts, M off this computer.`
    It exits 0 only when every case and variant was projected with no problem
    and M is 0.
  - **The paid branch** (`replayPaid`, run by no test). It imports the
    backstop first, sets the paid config, opens the ledger with its journal,
    and wires SIGINT and SIGTERM to `ledger.cancel` and an `AbortController`
    passed to `AppRuntime.runPromiseExit`. For each development case, variant
    and repetition, until the ledger halts or is cancelled: a fresh checkout;
    `resolveReviewModel({ trigger: "command", env: { MODEL } })`, refused
    unless priced at the given input and output price; `admitReplay`, which
    stops the loop when it refuses; `ReviewEval.replay` with
    `recordingPosting()`, the CLI's headless posting check through
    `EffectBridge`, and the key as a secret to redact; `Effect.onExit` settling
    from the artifact, or at the whole bound when the replay failed; and the
    artifact written straight into `--out` as
    `<model>--<case>--<variant>--r<n>.json`. It exits 1 on any refusal or
    failure, or when the ledger halted or was cancelled.
  - **`script/vectorscope-eval/ci.ts`.**
    - `PIPELINES` (`smoke`, `replay`), `DEFAULT_VARIANTS`
      (`engine`, `engine:shared-verify`), `ENGINE_DIR`, `REPLAY_ENTRY`,
      `MIRROR_GIT`; `Inputs.pipeline` and `Inputs.variants`.
    - `parseInputs`: `EVAL_PIPELINE` (empty is smoke), `EVAL_VARIANTS` (smoke
      must leave it empty; replay checks each name, refuses repeats, refuses
      `EVAL_FIXTURES`, and for a paid replay applies `pilotProblems`).
    - `replayArgs(inputs, index, dirs, target?)`: the plan's dry run of every
      split; a `{ send: false }` target, the eval job's projection of the
      development cases into `--out`; a `{ send: true }` target, the paid
      replay with `--ledger` and `--out`. `runArgs` is unchanged.
    - `mirrorPlan(manifest)` and the `mirrors` command; the `project` command;
      `plan` and `paid` under replay; `Deps.spawn` takes a `cwd` and
      `Deps.git` runs the mirror fetch.
  - **`script/vectorscope-eval/replay.ts`**: `variantRecord`, `PILOT` and
    `pilotProblems`, `projectedRun`, and the header. `admitReplay` now builds
    its variant record with the same private `recordOf`; its output and every
    message are unchanged.
  - **`script/vectorscope-eval/report.ts`**: desktop artifacts
    (`fromDesktopArtifact`), projection records, the new run fields in
    `fromArtifact` (`attempts`, `stop`, `passes`, cache tokens), and
    `manifestCase` mapping the `cross-file` trait.
  - **`script/vectorscope-eval/desktop.ts`**: `recordingClient(inner, now)`
    times each prompt call (`startMs`, `ms`), and `passes` carry the same
    fields; `desktopReplay` passes `input.now`. No app file changed.
  - **Core `review/eval.ts`**: `LabelledDefect.failureClass?`,
    `EvalCase.crossFile?` and `trivialKind?`, `EvalRun.attempts?`, `stop?`,
    `passes?` and `tokens.cacheRead?`/`cacheWrite?`, `isTrivialControl`, and
    `summarize` counting behaviour-preserving controls only in
    `falseAlarmsPerCleanPr`.
  - **Core `review/eval-report.ts`**: `Spread` (type-7 quantiles),
    `Operations`, `ProjectedRun`, `ProjectionGroup`, `spread`,
    `projectionGroups`, `renderProjections`; per group
    `breakdowns.classScoped`, `breakdowns.crossFile`, `trivial` and
    `operations`; `Report.projections`; `ReportInput.projected`;
    `evaluateGate`'s unjudged clean findings leave trivial controls out; and
    the rendering.
  - **`.github/workflows/vectorscope-eval.yml`**: the `pipeline` (choice,
    default `smoke`) and `variants` (default empty) inputs; in both jobs,
    under `if: inputs.pipeline == 'replay'`, "Install ripgrep" and "Fetch the
    dataset mirrors" (no secret); in the eval job, "Project the paid cases,
    sending nothing" (no secret, before the paid step); the replay env on the
    plan and paid steps; timeouts by expression.
  - **`packages/engine/test/lib/llm-server.ts`**: the layer is
    `TestLLMServer.serve(options)`; `layer` is `serve({ port: 0 })`, as before,
    and the new `loopback` is `serve({ port: 0, host: "127.0.0.1" })`. The
    diff without whitespace is those lines.
  - **`packages/engine/test/fixture/projection.ts`**: the header only.
  - **The README**: "The replay pipeline (VS-21c)" under Budgeted CI runs, a
    "Paid entry point (VS-21c)" subsection under Production replay, the
    report's new metrics and outputs, and the stale "no entry point" and
    "report.ts does not load desktop artifacts" text replaced.
- **The send rules, and dry by default.** A run sends only with a budget, input
  and output prices above zero, `GITHUB_ACTIONS=true`,
  `VECTORSCOPE_EVAL_ENVIRONMENT=vectorscope-eval`, `VECTORSCOPE_EVAL_API_KEY`,
  `--ledger` and `--out`, and the D5 pilot's limits. Each rule is its own
  refusal with a test, and `replayMode` reads those three variables and no
  other (a test reads the environment through a recording proxy). A refusal
  comes before anything is created or any engine module loads: a test shows
  `--work`, `--ledger` and `--out` do not exist afterwards. The paid branch's
  decision is tested only as `replayMode`'s answer; nothing runs it.
- **The critique, point by point.** All twelve were taken; two in part or
  differently.
  1. *The dry price* (blocker): taken. `projectionModel` reads the booted
     model and prices it with `SpendGuard.priceOf(loaded.cost)`, which carries
     the cache rates. `catalogModel` and the paid check compare input and
     output only. The dry config also carries `cache_read`, `cache_write` and
     `context_over_200k`, so the dry snapshot is the one the paid branch's
     `resolveReviewModel` gives (3, 15, 0.3, 3.75 for the seed model). An
     engine test in `eval.test.ts` boots that config, checks the price, passes
     `routeRefusal` with it, and shows a price built from the flat fields
     alone is refused with "price snapshot is not its provider's price".
  2. *No projections beside the paid artifacts* (major): taken. `ci.ts
     project` runs the dry entry point with `--out` on the development cases,
     variants and models being paid for, with no key, in a new eval-job step
     before the paid step. The plan job still writes and uploads nothing. A
     `ci.test.ts` assertion checks the step holds no secret and runs before
     the paid step.
  3. *D5 in part*: taken as "enforce all of D5": `PILOT` and `pilotProblems`
     in `replay.ts` refuse a paid replay over $50 in total, over $0.75 a case,
     with more than one repetition, or off the development split, each with
     its own message and test. The entry point applies them in `replayMode`,
     and `ci.ts` in `parseInputs` for a paid replay, so the dry run fails
     before the owner is asked to approve. Q9's case and variant counts are
     not decided: the limits bound the pilot, they do not choose it.
  4. *Shared checkouts*: taken. Each case, variant and repetition gets
     `checkoutDirectory(cases, "<id>#<variant>#<rep>")`, removed after its
     run; the clean-tree and base check stays as an assertion.
  5. *Mirror git and reachability*: taken. The mirror command's git goes
     through `Deps.git`, and a test asserts the exact argv on a fake. Each
     commit is fetched into `refs/vectorscope/<sha>`. The README says heads
     come with full history and how long the seed set took.
  6. *Record names*: taken: `<model>--<case>--<variant>--r1.projection.json`.
  7. *Quoting*: taken as "check `VARIANT_NAME` first and print a fixed
     message": a malformed entry is quoted with `JSON.stringify`; a
     well-formed one holds only `[a-z0-9:-]`, and `resolveVariant`'s detail
     adds registry text only. A test feeds newlines followed by `::warning::`,
     `::add-mask::` and `::set-env` and checks no problem line has a newline
     or starts with `::`. The mirror command quotes git's stderr too.
  8. *Label names*: taken: `failureClass` and `trivialKind`, as VS-22a names
     them, which VS-22a may reshape (for example as a separate case kind).
     `crossFile` is mapped now from the existing `cross-file` trait, with a
     test; no seed case has it, so the figure reads n/a.
  9. *Paid isolation*: taken, the key part differently. `VECTOR_DISABLE_USAGE=1`
     is set; the backstop is the paid branch's first import; the OpenRouter
     allowlist is listed below as a precondition for D7. **Taken
     differently:** provider keys are deleted, not refused: every `env` name
     the catalog lists (216 today) is removed before the engine loads, and a
     dry run removes the eval key too. In CI the child's environment already
     holds only `PATH`, `HOME`, `TMPDIR`, the two marks and the key (ci.ts
     `childEnv`), so a refusal would never fire there, and locally deleting
     lets a dry run proceed on a machine that has keys set, which is the safer
     of the two since nothing then reaches the engine.
  10. *Held-out*: taken. Cases are planned after `replayMode`, and a paid run
      plans `development` alone whatever `--split` says. The rule departed
      from is `replay.ts main`'s "held-out cases replay only from a frozen
      manifest", for the dry branch only, beside D5. Tests refuse
      `--split held-out` and `all` with budget flags in the protected
      environment.
  11. *The timeout*: taken. The README and the workflow comment say the eval
      job (360 minutes for replay, GitHub's maximum) and its paid step (300)
      bound how much of a pilot one dispatch covers: 54 sequential case-runs
      at up to 12 minutes each could need 10.8 hours, so a larger pilot needs
      more dispatches. Those dispatches share D5's $50 (corrected in review,
      below: this first said "each with its own budget"). An attempt cut off
      keeps its whole reservation in the ledger journal. Parallel paid
      replays stay deferred, as the remedy.
  12. *Smaller gaps*: taken. A subprocess test runs the dry branch inside a
      complete protected environment (`GITHUB_ACTIONS=true`, the mark and a
      dummy key, no budget) and checks the dummy key is nowhere in the
      records or the output, nothing went off this computer, and `--work` is
      empty afterwards. The estimate error leaves out projections with
      `cap.over` entries and counts them as `capped`. `admitReplay`'s
      message is unchanged; `variantRecord` has its own wording.
- **Where this departs from the contract or the plan.**
  1. **Test-tree imports, on purpose.** The dry branch imports
     `TestLLMServer` and the canned model from `packages/engine/test`:
     - its safety rests on the strict guard, `ReviewEval.project`'s refusals
       and the egress count, never on them;
     - the paid branch never loads them;
     - moving the 836-line server would churn the 32 test files that use it.
     Precedent: `script/httpapi-exercise.ts` imports `../test`. It adds
     `TestLLMServer.loopback`.
  2. **Dry projects every split**, held-out included, so the Done check covers
     all ten seed cases. A projection reads no label and scores nothing, the
     labels are committed in `seed.json` anyway, and nothing is uploaded from
     the plan job. A paid replay runs development only (D5).
  3. **Dry projects repetition 1 only**, since the canned model answers the
     same way each time, and the estimate join ignores repetition.
  4. **The price given must equal the committed catalog's**, which the engine
     reserves with; both branches boot with `VECTOR_MODELS_PATH` set to it.
  5. **The projection model** is the catalog entry under a loopback provider;
     `context_over_200k` is carried, the exact `tiers` are not (the config
     has no field for them). It goes through `@ai-sdk/openai-compatible`, so
     its bodies are that SDK's where OpenRouter's would send its own.
  6. **The estimate join** is by variant, case and the model id after its
     provider (`vectorscope-projection/...` against `openrouter/...`).
  7. **The `mirrors` command and step** are anonymous https fetches of the
     committed manifest's URLs only; **the `project` command and step** are
     new, from the critique.
  8. **Timeouts** grow for replay only, by expression (45, 360, 300, and 30
     for the projection step; 15, 75 and 60 for smoke), so one key-holding
     step remains.
  9. **Desktop runs with `applied: false`** are left out and listed; their
     group and cases stay planned, so they show as missing. A desktop
     artifact's usage is missing when an attempt was unpriced or answered
     without tokens, and its paid attempts read as unaccounted.
  10. **Class-scoped recall, cross-file recall and trivial controls** are
      computed now; `failureClass` and `trivialKind` come with VS-22a, so
      until then the first and last read n/a, and cross-file reads n/a while
      no seed case has the trait.
  11. **Route refusals** count `stop: "privacy"`, VS-23's, so 0 until VS-23.
  12. **The paid branch has no egress allowlist** for OpenRouter alone. This
      is a precondition for D7, not an optional later item.
  13. **`enabled_providers`** narrows each branch to its one provider, and
      **`VECTOR_AGENT_DB=:memory:`** keeps no session database on disk; the
      plan named neither.
  14. **`PILOT.caseUsd`** in `replay.ts` is the dry cap's default, in place of
      the plan's `PILOT_CASE_USD`, so one constant serves both.
  15. **The two subprocess tests run on Linux and macOS only**, as
      `test/server/httpapi-pty.test.ts` does for its own: the child gets a
      POSIX environment alone, on Windows a process needs more to start and
      `HOME` does not move the home directory, and the entry point runs on the
      eval workflow's Linux runners.
  16. **Nothing under `packages/engine/src` changed.**
- **Off by default (I-1).**
  - No runner, provider, LLM, posting or @vector file is touched, and nothing
    under `packages/engine/src` changes. No CLI command is added (D14).
  - With every input at its default the workflow is the old one: `pipeline`
    defaults to `smoke`; `parseInputs` gives the old inputs plus
    `pipeline: "smoke"` and `variants: []` (the updated `ci.test.ts`
    assertion); `runArgs` is unchanged; every new step runs only under
    `if: inputs.pipeline == 'replay'`; the timeouts evaluate to 15, 75 and 60.
  - The entry point is dry unless budget flags are given, and refuses to send
    outside every rule above, before anything loads.
  - `TestLLMServer.layer` behaves as before: 32 test files use it, and the
    suites run here (below) pass unchanged.
  - Report figures are unchanged for outputs without the new fields: the
    existing 14 `eval-report`, 22 `report` and 42 core `eval` tests pass
    unchanged, and a test shows marking no case trivial moves nothing.
- **Pin.** No pinned file changed: `REVIEW_PIPELINE_SOURCES` stays
  `228a42cb975134ce` and `REVIEW_PIPELINE_REVISION` stays 1. The pin test was
  re-run (16 pass).
- **Owner questions.** None of Q1-Q17 is decided. Q9 (the pilot's size), Q7
  and Q15 stay open. Q13 is not needed: nothing is wired into a runner.
- **Evidence.** Each file was run alone through the lock with
  `--timeout 30000`, `GITHUB_ACTIONS=false`, and `TMPDIR` and XDG roots under
  a fresh `/tmp/vector-vectorscope/vs21c-*`:

  | Where | File | Pass |
  |---|---|---|
  | engine | `test/review/vectorscope-replay.test.ts` | 11 (new) |
  | engine | `test/review/eval.test.ts` | 26 (25 before) |
  | engine | `test/review/run.test.ts` | 44 |
  | engine | `test/session/prompt.test.ts` | 144, 1 skip (the pre-existing `.skip`) |
  | engine | `test/cli/review.test.ts` | 24 |
  | engine | `test/compliance/egress-inventory.test.ts` | 5 |
  | core | `test/review/eval-report.test.ts` | 19 (14 before) |
  | core | `test/review/eval.test.ts` | 42 |
  | core | `test/review/eval-judge.test.ts` | 11 |
  | core | `test/review/model-evidence.test.ts` | 16 (pin unchanged) |
  | eval scripts | `ci` | 29 (18 before) |
  | eval scripts | `report` | 27 (22 before) |
  | eval scripts | `replay` | 31 (27 before) |
  | eval scripts | `certify`, `judge`, `run`, `budget` | 6, 6, 14, 21 |
  | `packages/script` | `fixtures.test.ts` | 50 |

  - **Typecheck.** `bun typecheck` in core and engine (the engine's covers the
    entry point and, through its imports, the eval modules it loads), and
    `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json` from
    `packages/engine`, all exit 0.
  - **Formatting.** `prettier --check` passes on every changed code file, the
    workflow and the README. This log keeps its own style, as before.
  - Nothing is committed or pushed, so the full turbo typecheck the lane
    rules require before a push has not run. No dependency was added, so no
    `bun install` ran. No user-visible string changed (D14).
- **The Done check, on the real seed set.** Anonymous read-only clones of
  public GitHub repositories work in this container (the lane lead checked
  `git ls-remote`), so the check ran on the ten seed repositories, with
  nothing spent and no model called. Mirrors and outputs stayed under
  `/tmp/vector-vectorscope/` and nothing of them is committed.
  - `EVAL_MIRRORS_DIR=<fresh dir> bun script/vectorscope-eval/ci.ts mirrors`
    fetched the ten repositories' heads and bases with full history from
    `https://github.com` in 9.8 s, 71 MB in all, exit 0 (844 to 6,161 commits
    each, none shallow).
  - `EVAL_MODE=dry-run EVAL_PIPELINE=replay EVAL_MODELS=anthropic/claude-sonnet-4.5=3:15 EVAL_MAX_TOKENS=16000 EVAL_REPEAT=1`
    with those mirrors and a work directory, `bun script/vectorscope-eval/ci.ts plan`,
    in a clean environment (`env -i` with `PATH`, `HOME` and `TMPDIR`), took
    1 min 50 s and exited 0. Every seed case, all ten across the three
    splits, was projected for `engine` and `engine:shared-verify`: 20
    records, 0 problems, 42 requests (review and verify for each, and a
    security pass too for `honojs-hono-1`, whose `src/utils/jwt/jwt.ts` is a
    sensitive path, checked by projecting it alone), and
    "The strict egress guard logged 42 connection attempts, 0 off this
    computer." The projected low estimate per case was $0.27 mean, $0.25
    median and $0.35 p90 at the seed model's catalog price; estimates, not
    spend.
  - `ci.ts project` with a $50 budget and $0.75 cap projected the six
    development cases for both variants into an output directory (12
    records, 24 connection attempts, 0 off this computer, 50 s), and
    `report.ts --outputs` over those records rendered the projections table.
- **Deferred.**
  - VS-22a's `failureClass` and `trivialKind` mapping in `manifestCase`.
  - A split input for calibration and held-out paid runs, after an owner
    budget.
  - Parallel paid replays (the remedy for the job timeout).
  - An egress allowlist for `openrouter.ai` alone in the paid branch, a
    precondition for D7.
  - Desktop projection and a paid desktop replay (after VS-10).
  - Anthropic's messages protocol in the fake server.
  - Per-lens matching of passes (VS-28).
  - A calibrated estimate (VS-24).

### 2026-11-06 · VS-21c review fixes

Twelve review findings, two of them blocking. Every one was fixed; four were
fixed another way than the finding suggested, and each says why. Nothing
under `packages/engine/src` changed, no pinned file changed, and nothing is
committed.

- **Blocking: a switch with a value** (`vectorscope-replay.ts`
  `parseReplayArgs`). `parseArgs` runs unstrict, and unstrict it reads
  `--dry-run=true` as the string `"true"`, which `dryRun` read as unset: with
  budget flags, `--ledger` and `--out` in the protected environment that was
  `{ mode: "paid" }`. Every boolean option in `OPTIONS` whose value is not
  exactly `true` is now refused ("--dry-run takes no value"), next to the
  missing-value check, so `--help=x` is refused too. Tests: `--dry-run=true`,
  `=1`, `=false` and `=` are refused by `parseReplayArgs`, and `main` returns 2
  for `--dry-run=true` and `=1` with every send rule holding, before the send
  decision, creating nothing; `--no-dry-run` stays an unknown option.
- **Blocking: one pilot, several dispatches** (D5, I-5, I-13). The workflow
  header and the README said a larger pilot needs more dispatches "each with
  its own budget", which would let each dispatch spend $50. Both now say the
  dispatches share D5's $50, that each dispatch's `budget_usd` is at most $50
  less what the earlier dispatches' sealed ledgers settled (uncertain
  reservations included), and that the dispatches split the pilot by the
  `variants` and `models` inputs, never repeating a case, variant and model,
  since each restarts at the first development case. The finding's "better
  still" was built too:
  - a new `pilot_spent_usd` workflow input (default empty), passed as
    `EVAL_PILOT_SPENT_USD` to the plan, project and paid steps (the three
    that call `parseInputs`), never into a shell command;
  - `parseInputs` checks it with `AMOUNT` (quoted when refused), refuses it
    for the smoke pipeline, keeps it as `Inputs.pilotSpentUsd` (absent when
    empty, so the default inputs are unchanged) and passes it to
    `pilotProblems` for a paid replay;
  - `replay.ts` `pilotRemaining(spent)` and an optional `spentUsd` on
    `pilotProblems`: the budget must be at most what is left, with its own
    message; with nothing spent the message and result are as before;
  - the replay `plan` prints what is left of the pilot.
  **Taken differently:** the entry point gets no such flag. It holds each
  dispatch to the whole $50, as before. The earlier spend is an amount the
  owner reads from sealed ledgers, and `ci.ts` already refuses a budget above
  what is left in the dry run, before approval, and again in the paid step.
  The same amount handed to the entry point would add no check. Tests:
  `replay.test.ts` (the remaining amount, rounding and the refusal at
  $20.01 spent), `ci.test.ts` (parsing, refusals, the plan line, and the
  workflow input with its env on all three steps).
- **A load failure in the dry branch** (`projectDry`). The instance loads
  inside the exit now, with `Effect.acquireUseRelease(store.load(...), use,
  store.dispose)`, so a case whose instance cannot load is a `not projected`
  line, not a thrown run.
- **An empty projection passed.** `main` now fails with exit 1 and "No case
  of <manifest> was planned for --split <name>." when nothing is planned.
  **Placed differently:** in `main`, after planning and before anything is
  created or any engine module loads, not in `projectDry`, so it covers both
  branches and boots nothing. Variants are never empty, so planned cases are
  the only empty case. Test: an in-process `main` with a manifest whose one
  case is outside `--split calibration` returns 1 and leaves `--work`
  uncreated.
- **The projection's output in the paid job** (D12). `ci.ts project` now
  writes each child's stderr and stdout to
  `<outDir>/<run>-projection.log`, sealed with the rest, and prints only
  "<model>: the projection exited with <code>. Its log is in the sealed
  artifact." The plan job still prints its projections publicly, as before:
  they are estimates from a canned model. Test: `ci.test.ts`.
- **Desktop pass wall time** (`report.ts fromDesktopArtifact`). Per pass, from
  the earliest `startMs` to the latest `startMs + ms` over the attempts that
  have both, so overlapping calls count once. An attempt with no `ms` (still
  in flight) is not timed. Test: three overlapping attempts read 3000 ms, not
  their 5000 ms sum.
- **Style** (`eval.test.ts`): the env restore uses an early return in place
  of `else`.
- **A malformed `--manifest`** now exits 2 with "Invalid manifest <path>: not
  JSON." It parses with `Schema.decodeUnknownOption(Schema.UnknownFromJsonString)`
  (effect is already a static import, so the load order is unchanged). Test:
  an in-process `main` on `{ not json`.
- **Estimate error and cost per review** (core `eval-report.ts`, I-5). A run
  has known spend when its usage is not missing and nothing is kept at its
  bound (`uncertainUsd` 0).
  - The estimate error joins only runs with known spend above $0. The rest
    are counted in a new `estimate.uncertain` and named in the rendered line.
  - `Operations.costUsd` is the spread over runs with known spend, and the
    rest are counted in a new `Operations.unsettled`. The row is now "Cost
    per review (known spend)", followed by a line giving that count.
  This also settles the desktop finding below, since it is one rule in the
  report. Tests: the core operations test now has a run with missing usage
  and one with a kept bound, both left out. The join test gains a failed
  replay with its bound kept, counted as uncertain. `report.test.ts`'s
  end-to-end join shows the default artifact (an unsettled verify attempt)
  reads n/a and is counted, and a fully settled one reads a 20.0% error.
- **Desktop spend never read as zero** (I-5). **Fixed another way:** in the
  core rule above, not in `fromDesktopArtifact`. A desktop run with
  `usageMissing` is left out of `costUsd` and counted in `unsettled`, as an
  engine run is. `fromDesktopArtifact` still reports `uncertainUsd: 0`,
  because a desktop replay reserves nothing, and its run-level spend line is
  unchanged.
- **Git's stderr on the public log** (`checkout`). A checkout failure is now
  `checkout failed: <JSON string>` on one line, as the mirror command quotes
  git. **Not cut to 300 characters**, unlike `failure()`, so git's own
  message stays readable after the long command it echoes; the stderr of a
  local fetch is short. Test: a subprocess run against a mirror that is not
  a repository prints the case's line quoted, and no line of the output
  starts with git's `fatal`, `error` or `Please`.
- **An invalid seed in `planReplay`.** The seed manifest is loaded and
  checked with `manifestProblems` before any child starts, and the plan
  returns 1 with the problems listed, as `mirrors` does. There is no test of
  the invalid case, since `SEED_MANIFEST` is a constant: a test would have to
  change the committed seed.
- **Evidence.** Each file was run alone through the lock with
  `--timeout 30000`, `GITHUB_ACTIONS=false`, and `TMPDIR` and XDG roots under
  `/tmp/vector-vectorscope/vs21c-fix`:

  | Where | File | Pass |
  |---|---|---|
  | engine | `test/review/vectorscope-replay.test.ts` | 13 (11 before) |
  | engine | `test/review/eval.test.ts` | 26 |
  | core | `test/review/eval-report.test.ts` | 19 (two tests extended) |
  | core | `test/review/eval.test.ts` | 42 |
  | core | `test/review/model-evidence.test.ts` | 16 (pin unchanged) |
  | eval scripts | `ci` | 30 (29 before) |
  | eval scripts | `replay` | 32 (31 before) |
  | eval scripts | `report` | 27 (two tests extended) |

  - `bun typecheck` in core and engine, and
    `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json` from
    `packages/engine`, exit 0. `prettier --check` passes on every changed code
    file, the workflow and the README.
  - **The Done check again.** With the mirrors from the first check, in a
    clean environment (`env -i` with `PATH`, `HOME` and `TMPDIR`),
    `EVAL_MODE=dry-run EVAL_PIPELINE=replay bun script/vectorscope-eval/ci.ts plan`
    took 1 min 54 s and exited 0. Every seed case was projected for `engine`
    and `engine:shared-verify`: 20 lines, 42 connection attempts, 0 off this
    computer. It printed "The D5 pilot's $50.00 is shared by all its
    dispatches: $0.00 settled by earlier ones (pilot_spent_usd), so $50.00 is
    left for this one."
  - Nothing was sent and no paid path ran. The workflow was not dispatched.
    No dependency was added and no user-visible string changed (D14).

## 2026-11-06 · VS-22a Dataset schema and label tests

Contract §4 VS-22a of `vectorscope-upgrade.md`, in the "Now" window: eval
scripts, their docs and the seed manifest, plus comments in core `eval.ts` and
the blinded judge task in core `eval-judge.ts` (a review fix, below). It
adds no `ReviewConfig` key, no `types.ts` or `config.ts` change, nothing to
`EVIDENCE_POLICY_KEYS`, `EvidenceScope` or `VARIANT_KEYS`, and no replay
variant. Nothing under `packages/engine/src` or `packages/app/src` changed, so
no runner, provider, LLM or posting file and no file @vector owns was touched.
Branch `vectorscope-engine` at `0f772e6e`. It implements the VS-22a plan as
corrected by its critique; the critique bullets below say where a point was
taken differently. Nothing is committed.

- **What landed.**
  - **`script/vectorscope-eval/dataset.ts`.** `SCHEMA` is now
    `vectorscope-dataset/2`. New exports: `FAILURE_CLASSES` (the contract's
    five), `DEFECT_CLASSES` (those and `other`), `MECHANISMS` (§1.2's
    `FailureInfo.mechanism`), `PENDING_Q4` (`data-exposure`,
    `concurrency-wrong-result`), `TRIVIAL_KINDS` (§1.2's `TrivialKind`),
    `CI_RESULTS` (`passed`, `failed`, `none`), `AUTHORING_SOURCES`
    (`commit-trailer`, `bot-account`, `synthetic`) and `TARGETS` (VS-22b's
    numbers). `KINDS` gains `trivial`; `TRAITS` loses `cross-file` and gains
    `trivial-looking` and `dependency-bump`; `EXCLUSION_REASONS` gains
    `not-trivial` and `mixed-trivial`.
    - Types: `Defect` gains `failureClass?`, `mechanism?`, `pendingQ4?`;
      `Case.labels` gains `crossFile?`, `runnable?` (`status`, `check?`,
      `evidence`, `date`, `note?`), `authoring?` (`lab`, `source`,
      `evidence`) and `trivialKind?`; each `Annotation.passes` entry gains
      `labels?` (`defects` by the case's ids with `failureClass`, `mechanism`
      and `pendingQ4`, and `crossFile`). Absent always means not yet labelled.
    - Validator: a `trivial` kind (`trivialProblems`: the control rules plus
      one `trivialKind`); `labelProblems` on every kind (`trivialKind` only on
      a trivial control; `crossFile` a boolean, only with labelled defects,
      and `true` only when one defect's locations and alternatives name two
      files other than tests; the `runnable` and `authoring` shapes, with
      `runnable.evidence` reading the case's own base commit;
      `trivial-looking` only on a bug case); a cross-case check that a
      repository's cases are of one kind and at most `PER_REPOSITORY` (2); `classProblems` on every defect and every pass record
      (`pendingQ4` only on `other`, and `concurrency-wrong-result` only with
      mechanism `concurrency`); `passLabelProblems` and `agrees` for each
      pass's own labels; and the freeze check below.
    - `dryRunReport`: with no trivial case, the header and split table are as
      before; otherwise the header names the trivial controls and the table
      gains a TRIVIAL column. New lines for failure classes (with the
      production-breaking count), mechanisms, Q4 markers, cross-file,
      runnable, authoring, trivial kinds when present, and the targets.
    - `assignSplits`, `heldOutDigest`, `caseView` and `objectProblems`: no
      code change. The case view is still repository, base and head only.
  - **`dataset/seed.json`**: schema 2, the labels below, a 2026-11-06 pass-1
    entry on each bug case recording its own labels and saying "runnable and
    authoring not examined", and one more sentence in the description. No
    split, selection or exclusion changed.
  - **`report.ts` `manifestCase`**: a trivial case maps to
    `{ kind: "control", trivialKind }`; `crossFile` comes from
    `labels.crossFile` (in place of the trait) and each defect's
    `failureClass` is passed on for class-scoped recall. Mechanism and the Q4
    marker stay in the dataset, since nothing reads them yet. `report.ts` and
    `report.test.ts` are outside the contract's VS-22a file list (`dataset.ts`,
    the guide, the rubric, `fixtures.test.ts`). They changed because retiring
    the `cross-file` trait and adding the `trivial` kind would otherwise break
    VS-21c's `crossFile` and `trivialKind` mapping, and the change stays within
    the Now window's eval-script work.
  - **Core `review/eval-judge.ts`** (review fix): `blind()` maps each defect
    to a `TaskDefect` (id, category, severity, summary, cause, locations,
    alternatives), so judges never see the annotators' `failureClass` and a
    task is byte-identical to the one for the unlabelled case (tested in
    `eval-judge.test.ts`). Not a pinned file.
  - **Core `review/eval.ts`**: comments only, on `failureClass`, `crossFile`
    and `trivialKind`. Not a pinned file.
  - **Docs.** `annotation-guide.md`: the trivial control; the two exclusion
    reasons; the new traits; "Labels added in VS-22a" (definitions, the
    mechanism order, how to read `runnable` and map every conclusion,
    authoring's limits); "Trivial controls" (VS-24 items 1-2 copied with a
    pointer, one kind per case, what happens to a candidate that fails);
    per-pass labels in the two-pass procedure; splits and freezing; and the
    dated sampling rule. `judging-rubric.md`: "Failure classes and
    production-breaking" with the leak scope pending Q4, and metrics rows for
    class-scoped recall, cross-file recall and trivial controls, which
    document VS-21c's computations. `README.md`: kinds, schema 2, the seed's
    label state, the tests and the report bullet.
- **Decisions.**
  - **D-a. Trivial is a dataset kind** (`kind: "trivial"`, with
    `labels.trivialKind`), as the contract's "a new control kind" says.
    `assignSplits` already splits each kind on its own, so trivial controls
    split separately with no change to the split code and move no other case
    (tested). Core keeps `EvalCase.kind` as bug, control or adversarial;
    `manifestCase` maps the kind to a control with its `trivialKind`, which
    VS-21c's `isTrivialControl` and `summarize` already keep apart.
  - **D-b. `labels.crossFile` replaces the `cross-file` trait**, with three
    states (true, false, unlabelled). No committed manifest had the trait.
  - **D-c. Class, mechanism and the Q4 marker are per defect**, as core's
    `LabelledDefect.failureClass` already is. Mechanisms take the first that
    applies of concurrency, access, resource, logic, regression.
  - **D-d. Q4 stays open through `pendingQ4`.** Labels follow the narrow
    reading (`leak` is a resource leak); a defect that a wider answer would
    move into a class is `other` with a marker, so either answer can be
    computed without relabelling, even after a freeze.
  - **D-e. `runnable` comes only from recorded public CI**, never by running
    anything (I-13). Every status needs the API link read and its date;
    `passed` and `failed` name the test check; `none` needs a note. The guide
    maps every check-run conclusion and status state. VS-22b's "15 runnable"
    target counts `passed` only, because runtime confirmation (VS-30) needs a
    suite that passes at the base; the dry run shows every status, so the
    contract's wider "tests ran" reading (passed or failed) stays computable.
  - **D-f. `authoring` is optional, self-declared and for stratifying
    only**: from commit trailers or bot accounts, never PR title, body or
    branch text, and never VS-29b's trusted authorship or any invocation field
    (I-2). The field is `lab` (not the contract's "family"), because
    `Case.family` already means related cases; its values are codium `labOf`
    lab ids, checked against that list when codium merges. No mapping or lab
    list is written here (I-10). `synthetic` is accepted, but no synthetic
    case is admitted before Q12.
  - **D-g. Absent means unlabelled**, never a null sentinel. It is made
    explicit by the guide, the dry run's unlabelled counts, the freeze check,
    a seed test that pins which labels are unset, and the seed's own pass
    method ("runnable and authoring not examined").
  - **D-h. The freeze needs VS-22a's labels.** A frozen held-out bug case must
    have `failureClass` and `mechanism` on every defect, `crossFile`,
    `runnable`, and two passes' own labels: none can be added after a freeze
    without re-freezing, and class-scoped recall (Q3/D16) and kappa need
    them. The pass-label item is reported only for a settled label, since an
    unsettled one is already refused for its missing pass or agreement.
  - **D-i. The sampling rule is recorded up front**, dated 2026-11-06, in the
    guide, before any VS-22b candidate or result.
  - **Schema version 2.** Retiring the trait makes `manifestProblems` refuse
    a value version 1 accepted, and version 2 adds a kind an old reader would
    refuse, so the schema is bumped rather than keeping the trait as an
    alias. A version-1 manifest is refused (tested); the seed was the only
    one.
  - **Class definitions** (`judging-rubric.md`), chosen so the seed labels
    follow them:
    - `crash` is abnormal termination: an exception or panic the code does not
      handle (a framework's top-level handler turning it into a 500 or an exit
      status still counts), a fatal error or signal, or a process that exits
      at startup. An error returned on purpose, such as a rejected
      configuration, is `other` unless the evidence shows the process exits.
    - `data-corruption` is data stored, or passed on for another system to
      store. A wrong value only computed, shown or returned is `other`, and so
      is diagnostic output (logs, traces, metrics, telemetry).
    - Two readings beyond the owner's wording are recorded as this build's
      decisions, not settled vocabulary, and the rubric says so: a deadlock
      or a request that never completes counts as `runaway-loop`, and an
      injection that lets a caller run commands or queries beyond its rights
      counts as `auth-bypass`. No seed defect depends on either; if the owner
      narrows them, only defects of those kinds are relabelled.
  - **Sampling-rule decisions** (the guide's last section):
    - VS-22b writes a new manifest, `dataset/upgrade.json`, because a
      manifest has one `selection` and the seed's says "hand-picked". It
      carries the seed's ten cases and exclusions over with their ids, so one
      split covers the whole set; splits are then recomputed and click and
      hono may leave held-out, which is allowed since nothing is frozen.
      `seed.json` stays the replay default until the new manifest is frozen.
    - At most two cases per repository, counting the seed, where the seed's
      own rule was one: about 125 cases at one per repository would need as
      many repositories, and two keeps the set diverse while a repository's
      cases always share a split.
    - The cases one repository supplies are of one kind, because
      `assignSplits` groups by repository within a kind only, so a bug case
      and a control from one repository could otherwise sit in different
      splits. `family` does not help here: it also groups within a kind.
    - The licences are spelled as `LICENCES` names them.
  - **Trivial controls take one kind.** A trivial candidate that mixes kinds
    is excluded as `mixed-trivial`, so it can be admitted if the label later
    becomes a list (VS-24's `classifyTrivial` returns a list of kinds).
  - **A candidate that fails the trivial rules** is first considered for the
    behaviour-preserving control or trivial-looking bug stratum, and is
    excluded as `not-trivial` only when it fits neither. A dependency bump
    that preserves behaviour is admitted as a `control` with the
    `dependency-bump` trait, so Q11 can reclassify it without finding it
    again.
- **Seed labels** (pass 1, 2026-11-06, only from each case's recorded cause,
  locations and evidence):

  | Case | Defect | Class | Mechanism | crossFile |
  |---|---|---|---|---|
  | pallets-werkzeug-1 | server-name-none | crash (AttributeError on every plain-HTTP request) | logic | false |
  | pallets-werkzeug-1 | port-appended-to-host | other (wrong server name) | logic | |
  | fastify-fastify-1 | response-time-unset | other (diagnostic output) | logic | false |
  | nats-io-nats-server-1 | lds-data-race | other, `pendingQ4: concurrency-wrong-result` | concurrency | false |
  | caddyserver-caddy-1 | srv-upstream-rejected | other (a configuration rejected at load; the case files do not show the process exiting) | regression | **true**: `reverseproxy.go:207-213` with the `hosts.go:83` alternative, outside the one-file change |
  | vitejs-vite-1 | legacy-marker-in-ssr | crash (ReferenceError in the SSR bundle) | regression | false |
  | tokio-rs-tracing-1 | scoped-default-clobbers-global | other (events dropped: diagnostic output) | logic | false |
  | pallets-click-1 | eof-on-iteration | crash (EOFError aborts the command), at concern | regression | false (its test-file alternative is a test the change edited) |
  | honojs-hono-1 | jwt-time-truncation | auth-bypass (expired tokens accepted) | access | false |

  Production-breaking (blocking, in the five classes): 3 of 9 defects
  (werkzeug's crash, vite, hono). `runnable` and `authoring` are unset on all
  ten cases: the case files hold no CI status and no authoring evidence.
  Controls carry no new label. Status stays `draft`.
  **Disputes pass 2 may raise:** caddy (crash, if issue 3753 shows startup
  exiting with such a config); tracing (data-corruption, under a reading that
  counts lost telemetry, and logic against regression); hono (severity, since
  it triggers only after 2038, and its mechanism: `access` by the order,
  though the cause is an integer truncation); nats (Q4, and a torn Go string
  read can crash, which the case files do not show); click (a crash at
  concern severity, so not production-breaking). The `cross-file`
  confirmation for caddy was read with read-only git on the VS-21c mirror:
  `hosts.go:83` is `LookupSRV`, and the change touches only
  `reverseproxy.go`.
- **Critique of the plan, point by point.**
  1. *Per-pass labels* (major): taken. `annotation.passes[].labels` records
     each pass's own labels by defect id; ids must exist, may not repeat, and
     each pass records them once. Once any pass of a double-annotated or
     adjudicated case records them, two must; `agreed: true` needs passes
     whose labels are the case's. The seed's 2026-11-06 entry carries them,
     and the freeze needs them on held-out bug cases (D-h). A pass record
     names only defects the final labels keep; a defect a pass proposed that
     adjudication dropped goes in the adjudication note.
  2. *Definitions against labels* (major): taken, by narrowing. Tracing stays
     `other` because `data-corruption` now excludes telemetry by definition;
     caddy is relabelled `other` because `crash` is abnormal termination
     only. The deadlock and injection readings are recorded decisions (above).
     Caddy, tracing and hono are listed as disputes.
  3. *VS-24's rules paraphrased wrongly* (major): taken. The guide copies
     VS-24 items 1-2 verbatim with a pointer, so the conditional rename rule,
     the docs exclusions, doctests, licence headers and shebang and encoding
     lines are as the contract has them, and adds VS-24's `.mdx`,
     `requirements.txt` and case-only-rename fixtures to the trivial-looking
     examples.
  4. *`not-trivial` throws candidates away*: taken (above).
  5. *`runnable`*: taken. Evidence and date for every status, every
     conclusion mapped, `none` with a note, and "target counts passed"
     recorded (D-e).
  6. *`authoring`*: taken, including the rename to `lab` (D-f).
  7. *Explicitly unlabelled*: taken, in the seed's pass method and its pass
     record.
  8. *Sampling-rule gaps*: taken (above).
  9. *Retiring the trait without a schema bump*: taken as a bump to version 2.
  10. *Mechanism order and hono*: taken. Hono's mechanism is a listed dispute,
      and VS-27's strict prompt stating the same definitions and order is
      deferred (below).
  11. *`trivialKind` takes one value*: taken as "one kind per case", with
      `mixed-trivial` exclusions. **Not taken:** a `trivialKinds` list beside
      it; the contract names one `trivialKind`, and the exclusions keep the
      mixed candidates findable.
- **Off by default (I-1).** No key, no runner and no request changed, so no
  parity test applies. The only output changes are the eval tooling's: the
  dry run's new lines and its schema name, class-scoped and cross-file recall
  now computable on the seed, and `manifestProblems` refusing a version-1
  manifest, the retired trait, runnable evidence from another commit or
  repository, and a repository whose cases span kinds or exceed two. Judges'
  blinded tasks are unchanged: they leave the class out.
- **Pin, revision and rubric.** No file in `REVIEW_PIPELINE_FILES` changed:
  `REVIEW_PIPELINE_SOURCES` stays `228a42cb975134ce` and
  `REVIEW_PIPELINE_REVISION` stays 1 (`model-evidence.test.ts`, 16 pass).
  `RUBRIC_VERSION` stays 1: the classes are label vocabulary, and no verdict,
  settlement or gate rule changed. The metrics rows describe what VS-21c
  already computes.
- **Owner questions: none decided.** Q3 stays open (class-scoped recall is
  computable and the freeze keeps classes on held-out cases); Q4 through
  `pendingQ4`; Q11 through the `dependency-bump` trait, with no dependency
  `trivialKind`; Q12 through no synthetic case; Q14 through the
  contract's own targets; Q15 open.
- **Held-out digest.** The seed is not frozen. Its held-out digest moves from
  `sha256:56c3cb497c5097bde7eed81bb11adb8ceaaef3678e38ad5ca9994baa56b57ac3`
  to `sha256:dc56133cf9d417526f0d534ae89aaebfcdaa414b6f1aa0c085a09897f4a6e98d`,
  because click and hono gained labels.
- **Evidence.** Each file was run alone through the lock with
  `--timeout 30000`, `GITHUB_ACTIONS=false`, and `TMPDIR` and XDG roots under
  `/tmp/vector-vectorscope/vs22a-*`:

  | Where | File | Pass |
  |---|---|---|
  | `packages/script` | `../../script/vectorscope-eval/fixtures.test.ts` | 65 (50 before) |
  | eval scripts | `report` | 27 (one test replaced) |
  | eval scripts | `replay`, `ci`, `judge`, `certify`, `run`, `budget` | 32, 30, 6, 6, 14, 21 |
  | engine | `test/review/vectorscope-replay.test.ts` (reads the seed) | 13 |
  | core | `test/review/eval.test.ts`, `eval-judge.test.ts`, `eval-report.test.ts`, `model-evidence.test.ts` | 42, 12 (11 before), 19, 16 |

  - In `fixtures.test.ts`, three existing tests' setup changed and no
    expectation did. "A control has no fix and no defects" removes the
    synthetic bug's VS-22a labels with its defects, since they describe the
    defect. "Rejects a licence outside MIT, Apache-2.0 and BSD" builds its
    case with the GPL repository rather than overwriting it, and "rejects
    repeated ids and repeated candidates" gives the copy the first case's
    labels, so their `runnable` evidence reads the repository and base they
    name. The synthetic helpers carry the new labels, and the synthetic
    `runnable` evidence is built from the case's own repository URL, so the
    freeze tests' expectations are unchanged.
  - `bun typecheck` in core and engine, and
    `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json` from
    `packages/engine`, exit 0.
  - `prettier --check` passes on every changed code file, the seed, the guide
    and the README. `judging-rubric.md` was not prettier-clean before (its
    tables are compact), so its additions keep its style and its existing
    tables are untouched.
  - `bun dataset.ts` exits 0 and prints the new lines. `--mirrors` on the
    VS-21c mirrors exits 1 only because those mirrors hold no fix commits by
    design (`mirrorPlan` fetches heads and bases), so the location checks did
    not run there; no label location changed.
  - Nothing was sent, no paid path ran, no workflow was dispatched, no
    dependency was added, and no user-visible product string changed (D14).
- **Review fixes** (same day, before any VS-22b candidate was examined).
  Every finding was taken; none was left with a recorded disagreement.
  - *`runnable.evidence` accepted any https link.* It must now be
    `https://api.github.com/repos/<owner>/<name>/commits/<base>/check-runs`
    or `.../status`, built from the case's `repository.url` and
    `candidate.base`, with any query and the owner and name in any case
    (GitHub matches them so). A link to the head's or the fix's checks,
    another repository, the web page or a fragment is refused with its own
    message, which names the two links expected. The check runs only once the
    repository URL and base are well formed, so a malformed one is reported
    once. Tested, with the head SHA among the refused links.
  - *One kind, and the cap, per repository, were unvalidated.* Both are now
    enforced in `manifestProblems` after the shape checks, grouping by
    `repositoryKey` (so URL case does not split a repository): cases of more
    than one kind from one repository are refused, since `assignSplits`
    groups by repository within a kind only; so are more than
    `PER_REPOSITORY` (2) cases from one. The cap is enforced, not
    reported-only like `TARGETS`, because it is a fixed rule of the sampling
    and a case past it already has an exclusion reason (`quota`); `TARGETS`
    are minimums a growing set only approaches. The guide's "Splits" and
    sampling rule item 3 say so; the rule itself is unchanged. A `family`
    spanning kinds is still not checked; nothing in the seed has one.
  - *`crossFile: true` counted a test alternative.* The two files are now
    counted without the fix's `regressionTest.paths` and test-looking paths
    (`TEST_PATH`: a `test`, `tests`, `__tests__` or `spec` directory,
    `test_<name>`, or `.test`, `_test`, `.spec`, `_spec` before the
    extension), as the guide states. Caddy keeps its two source files; a
    test-file alternative alone, or a regression test path, is refused
    (tested), and `src/click/testing.py` still counts. The heuristic can
    miss a test file named otherwise (`testing/`, `it/`), which only lets a
    wrong `true` through as before; it cannot refuse a defect whose second
    file is source unless that file is named like a test.
  - *Judges saw `failureClass`.* Fixed in `blind()` (above) rather than by
    documenting it, since no verdict rule reads the class.
  - *Single-use `traits`.* Inlined; likewise the cross-file check's
    regression paths.
  - *Unlisted files.* `report.ts` and `report.test.ts` are recorded above as
    outside the contract's VS-22a file list; `eval-judge.ts`, its test and
    the README's test list changed for the review fixes.
- **Deferred.**
  - VS-22b: curation, pass 2 (blind, with its own labels), the owner's
    adjudication, kappa on `failureClass`, `runnable` labels from public CI
    (read-only, rate-limited when anonymous), and the held-out freeze.
  - When VS-27a and VS-24 land: a test that `FAILURE_CLASSES`, `MECHANISMS`
    and `TRIVIAL_KINDS` equal core's, or `dataset.ts` importing them.
  - VS-27's strict prompt states the same class definitions and mechanism
    order, so a strict finding's `FailureInfo` can be compared with its label.
  - When codium merges: checking `authoring.lab` against its `LABS`.
  - The report counting unlabelled defects, and offering the wide Q4 reading
    from the markers.
  - Replays of trivial controls with trigger `auto` (VS-24 wiring).
  - Adversarial cases with PR text need PR text in `ReplayCase`; the case view
    has none today.

## 2026-11-06 · VS-23a Pure route rules and source-tagged config

Contract §1.1, §1.2 (`privacy.ts`) and §4 VS-23a of `vectorscope-upgrade.md`,
in the "Now" window: one new pure core module, two optional `ReviewConfig`
keys, a merge function, an `EvidenceScope` field and a note, none of which
any runner calls. No runner, provider, LLM or posting file and no file @vector
owns changed (`run.ts`, `ai-review.ts`, `provider.ts`, `session/llm.ts`,
`posting.ts`, `workflow.ts`, `command.ts`, `github.*`, `github-*.ts` are
untouched). Branch `vectorscope-engine` at `7cadfcb8`. It implements the
VS-23a plan as corrected by its critique; the critique bullets below say where
a point was taken differently. Nothing is committed.

- **What landed.**
  - **New core `review/privacy.ts`**, pure and browser-safe, importing only
    what exists (I-10): `denyDataCollection`, `isOpenRouterFreeModel`,
    `isOpenRouterURL`, `openRouterModelRouting`, `sendsToOpenRouter` and
    `sendsToOpenRouterFree` from `free-model-catalog.ts` (unchanged),
    `LocalPolicy.host`, `hostClass` and `origin`, and
    `ModelPlanStatus.PROVIDER_ID` and `SITE`. Exports: `ReviewPrivacy`,
    `ROUTE_REFUSALS` (exactly §1.2's thirteen names) and `RouteRefusal`,
    `RouteKind`, `RouteDecision`, `RouteModel`, `decideRoute`,
    `zdrBodyRefusal` and `zdrRequestBody`. Its header says nothing calls it
    yet, that `zdrRequestBody` applies only to bodies on an
    `openrouter-attested` route (every other allowed kind sends its body
    unchanged, since `provider` is OpenRouter's field), and that ZDR reduces
    retention but cannot rule it out (I-3).
  - **Core `types.ts`**: `ReviewConfig` gains optional `privacy?: "standard"
    | "zdr"` and `zdrAttested?: string[]`, absent meaning `standard` and none.
    `DEFAULT_REVIEW_CONFIG` is unchanged. The file stays import-free.
  - **Core `config.ts`**: `RAISE_ONLY` (`privacy`, with `REVIEW_PRIVACY`) and
    `TRUSTED_ONLY` (`zdrAttested`) tables, `SourcedReviewKey` and
    `SOURCED_REVIEW_KEYS`; `FIELDS`, `ENV` and `assign` exclude the sourced
    keys; `parseReviewConfig`'s body moved unchanged into a private `settle`;
    new `mergeReviewConfig({ surface, global?, json?, env?, trigger? })`.
    `config.ts` does not import `privacy.ts`.
  - **Core `model-evidence.ts`**: `EvidenceScope.route?: "zdr"`,
    `evidenceScope({ route })`, `ModelCertificate.route?`, `ScopeChange`
    `"route"` with `CHANGE_WORDS.route` "another privacy setting",
    `certificateProblems` (`route must be "zdr" when set`), `certify`'s own
    mismatch message and copy of the route, `changes()` comparing routes; the
    revision comment names the route rules; the pin.
  - **Core `format.ts`**: `notePrivacyRefused({ model, refusal, attempts })`
    with a reason per refusal, importing `RouteRefusal` as a type only.
  - **Engine `review/eval.ts`** (critique, below): `ReplayInput.config` omits
    `SourcedReviewKey`, and step 0b refuses `privacy` or `zdrAttested` from an
    untyped caller. Not a pinned file and not a runner the window holds back;
    it changes nothing for any input a caller sends today.
  - **`script/vectorscope-eval/certify.ts`**: comment only (the scope list
    gains "route").
- **Signature deviations from §1.2.**
  - `decideRoute`'s `npm?` and `baseURL?` become `destinations: readonly
    unknown[]`, as `sendsToOpenRouterFree` takes: the model's and provider's
    base URLs, the SDK package, and the origins requests are actually sent to
    (`provider.ts` `requestOrigins`: the base URL with variables filled in,
    else `SDK_ORIGINS`, and a `preconnect` origin). Every URL must pass, the
    first refusal in order wins, and with no URL at all the route is
    `unknown-destination`, so the caller passes the SDK's default origin
    (OpenRouter's SDK package alone is refused this way). A destination that
    is neither an http(s) URL nor an SDK package name (`ftp:`, `file:`,
    `localhost:11434`, an unfilled `${VAR}`) is `unknown-destination`.
  - The input also gains `apiID?` (configuration can name one model and send
    another), `defaultOrigins?` (below), `price?` (below) and `forwards?`
    (below).
  - `RouteDecision` kinds: `standard` is added, since `standard` decides
    nothing, and `attested` is split into `attested-provider` and
    `attested-host`, so VS-23b's notes and audit can say which attestation
    allowed a route.
  - New exports `ROUTE_REFUSALS`, `RouteKind`, `RouteModel` and
    `zdrBodyRefusal`, which gives VS-23c a typed reason.
  - `zdrRequestBody` also returns undefined for a body that is not a JSON
    object, a body `model` that is free, routed, `:online` or
    retention-required, any `plugins` key (the web plugin, an empty list and
    `enabled: false` included) and a `web_search_options` key.
  - `ReviewPrivacy` is `NonNullable<ReviewConfig["privacy"]>`, so the union
    lives in import-free `types.ts`.
- **Rule decisions** (`decideRoute`, in order).
  1. Under `standard`, `{ allowed: true, kind: "standard" }`. Any other value
     is treated as `zdr` (fail closed).
  2. The model's own refusals come before any destination, so no attestation
     overrides them: `vector-plan` is `codium-unaccepted`; the catalog's free
     flag, provider `vector`, and `sendsToOpenRouterFree` with the listed
     price (a zero price on an OpenRouter route, exactly resolveSDK's
     free-route condition) are `free-model`; then, on `modelID` and `apiID`,
     `:free` (also stacked or versioned), `openrouter/free` and `stealth/` are
     `free-model`, `openrouter/*` and `@preset/` (LiteLLM-style
     `openrouter/...` names on this computer included) are
     `router-or-preset`, an `:online` variant anywhere in the chain is
     `plugins`, and a Fable or Mythos token is `retention-required-model`.
     The token match `(?:^|[^a-z0-9])(?:fable|mythos)(?![a-z])` is dated
     2026-11-05 [enablers §1.6], so `fable5` matches and `fabled-coder` does
     not; a local model named `fable` is refused too.
  3. `forwards` (the caller's `holds.passesOn`, such as an Ollama cloud
     model) is `unknown-destination` on any destination, attested or not:
     privacy.ts cannot import `ollama.ts` (Node-only Egress), and the name
     rule is not copied (I-10).
  4. A model whose requests go to OpenRouter (`sendsToOpenRouter`: provider
     `openrouter`, the `@openrouter` SDK, or any OpenRouter URL) needs its
     provider ID attested as the account (`openrouter` for the standard
     provider; a custom provider at openrouter.ai holds its own key, so its
     own ID). OpenRouter itself and a stand-in on this computer pass requests
     on to that account; every other hop must pass as a server in its own
     right (vectordev.ai refused, a LAN or internet hop only by host). A host
     attestation never attests an account (`openrouter.ai` attests nothing).
     Only this kind gets the ZDR body.
  5. Otherwise, per destination: `vectordev.ai` and its subdomains are
     `codium-unaccepted` even when attested; this computer is `loopback`
     (LocalPolicy's rule: 127/8, `::1`, `localhost`, `0.0.0.0` and `::`;
     `*.localhost` is the internet); an attested host is `attested-host`; a
     LAN host (LocalPolicy's `your-network`: private ranges, link-local,
     ULA, single-label names, `.local`, `.lan`, `.internal`, `.home.arpa`,
     `*.ts.net`) is otherwise `unattested-network-server`, and a provider-ID
     attestation never covers it; an internet host is `attested-provider`
     only when the provider ID is attested and the origin is one of
     `defaultOrigins`, else `unattested-provider`. CGNAT 100.64/10 is the
     internet. A company server on a public name is a host on the internet.
  6. With every destination allowed, the kind is the first attested one, else
     `loopback`.
  - **Attestation entries** are read both ways: exactly (trimmed) as a
    provider ID, and as a host normalised through `LocalPolicy.host`, with or
    without a port and in any case (`GPU-Box:9999`, `[fd00::1]:1`). A
    single-label entry such as `gpu-box` therefore attests both a host and a
    provider of that ID; both are the owner's own statement and each covers
    only its own rule, so this collision is accepted and documented. A URL
    entry attests no host.
- **Config decisions.**
  - `parseReviewConfig` is deliberately unchanged for both keys: review.json's
    `privacy` and `zdrAttested` are still "unknown key ... is ignored" and
    `REVIEW_PRIVACY` is not read, so no surface takes `zdr` before it enforces
    it. `mergeReviewConfig` is their only reader, and nothing calls it.
  - Every other key goes through `settle`, so with neither key set
    `mergeReviewConfig` equals `parseReviewConfig` (config and warnings) for
    the GitHub, CLI own-branch, CLI `--pr` and desktop shapes, bad JSON, a
    BOM, retired and unknown keys and `__proto__`.
  - `privacy` is the strictest of `global.privacy`, review.json's `privacy`
    and `REVIEW_PRIVACY` (blank is unset), read trimmed and without case. Any
    other value (garbage, `null`, `true`, a number, `""`) is `zdr` with a
    warning. It is set on the config only when raised.
  - **An unreadable review.json** (not JSON, or not an object) whose text
    mentions `privacy` counts as `zdr`, with a warning; one that does not
    mention it keeps today's defaults. Failing closed on every unreadable
    file would, once wired, raise privacy and stop reviews for every
    repository with a broken review.json that never set the key, breaking
    I-1 for them; a broken file that mentions the key may have meant `zdr`.
  - `zdrAttested` follows the surface: `local` (the CLI, the desktop and the
    eval's replay entry point, whose global config is the operator's; the
    eval passes its own settings as `global`) trusts `global` only; `github`
    trusts review.json `at: "base"` only. A value from any other source,
    including a working tree or the desktop's base blob locally, is ignored
    with a warning naming the trusted source. No environment variable is
    read for it. It is parsed by an `attestations` field (`strings`, plus
    entries with a scheme, path, user or space dropped with a warning naming
    them); an empty list is left out like the default.
  - `json.privacyOnly` is the desktop's base blob when a PR changes
    review.json (VS-23d): it may raise `privacy`, and every other key keeps
    today's defaults (I-1).
- **Scope.** `EvidenceScope.route` is set only by an explicit `evidenceScope`
  caller, never from the config; every existing caller (`run.ts`,
  `ai-review.ts`, engine `eval.ts`, `script/vectorscope-eval/desktop.ts`) is
  untouched, so every scope stays byte-identical. A route mismatch makes a
  certificate stale with `["route"]`; `certify` refuses mixed routes with its
  own message ("the candidate's runs were replayed under different privacy
  routes"), leaving the existing message as it was. `EVIDENCE_POLICY_KEYS`
  is unchanged, so `policyDigest` and `promptsDigest` are default-stable
  (tested with `privacy` and `zdrAttested` set). `privacy.ts` joins
  `REVIEW_PIPELINE_FILES`: `REVIEW_PIPELINE_SOURCES` moves from
  `228a42cb975134ce` to `3c100812158a4ab5`. `REVIEW_PIPELINE_REVISION` stays
  1: no runner reads the new file, so nothing a review finds or posts
  changed.
- **Off by default (I-1).** Nothing calls `decideRoute`, `zdrBodyRefusal`,
  `zdrRequestBody`, `mergeReviewConfig` or `notePrivacyRefused`, and no
  caller passes `route`. `DEFAULT_REVIEW_CONFIG`, every `parseReviewConfig`
  result, every scope and every replay artifact's `config.value` and
  `config.digest` are byte-identical (the optional keys are what make the
  artifacts identical; the plan's required keys would have changed both).
  The only behaviour change is the replay's step 0b refusing a `config` that
  sets a route key, which no caller sends. No `VARIANT_KEYS` change;
  `engine:privacy-zdr` stays pending until VS-23c. The engine D3 parity suite
  (`run.test.ts`) and the desktop's (`ai-review.test.ts`) pass unchanged.
- **Owner questions: none decided.** Q1: the default stays `standard`
  (absent). Q2: the attestation mechanism exists, the list is empty
  everywhere and nothing reads it. Q7: no eval key setup. Q13: no wiring.
  Q16: the global setting is VS-23d; `mergeReviewConfig`'s `global` input has
  no reader yet.
- **Critique of the plan, point by point.**
  1. *OpenRouter attested whatever the base URL* (blocker): taken, and
     stricter than proposed. A non-OpenRouter hop must pass as a server
     (vectordev.ai refused; LAN and internet hops need their host attested)
     **and** the account must be attested. **Not taken:** treating an
     OpenRouter provider pointed at this computer as plain `loopback`. Such a
     provider is a local proxy or a test stand-in that passes requests on to
     the OpenRouter account, so it needs the account attested and gets the
     ZDR body (`openrouter-attested`); as plain loopback its body would leave
     the machine without `zdr`, and VS-23c's fake-server test would not run
     on the real path. Fixtures for an internet proxy, a LAN hop and
     vectordev.ai.
  2. *One `baseURL`* (major): taken as `destinations` (above), every URL
     required to pass; tested where the catalog URL and the provider base URL
     disagree. **Taken differently:** no implicit SDK default; the caller
     passes it, and a route with no URL is refused.
  3. *Price ignored* (major): taken through `sendsToOpenRouterFree` with
     `price`, so the check matches resolveSDK's free-route condition; a zero
     price on this computer is not free (tested).
  4. *`:online` and `web_search_options`* (major): taken; both refused as
     `plugins`. Neither could be read in OpenRouter's docs here (host
     blocked); VS-23c's fake server checks the wire.
  5. *Provider-ID attestation covers any host* (major): taken now, not
     deferred. It covers only `defaultOrigins`, which the caller fills from
     `SDK_ORIGINS` or the catalog URL as shipped; without them it covers
     nothing. Attested `anthropic` at `https://other.example` is refused
     (tested). Recorded under Q2 as a rule decision.
  6. *Forwarding loopback* (major): taken as `forwards` (above), with tests.
  7. *"Nothing was sent" always* (major): taken. `attempts` is required;
     with 0 the note says "Nothing was sent.", otherwise "Nothing was sent to
     `<model>`, but this review had already sent N request(s) on routes
     Vector may use." Both forms tested.
  8. *Eval config lowering privacy* (major): taken both ways: the doc says
     the eval passes its settings as `global` on `local`, and
     `ReplayInput.config` omits the sourced keys, with step 0b refusing them
     from an untyped caller (tested in engine `eval.test.ts`), so no artifact
     can record a route setting nothing enforced.
  9. *Required keys change every artifact* (minor): taken; the keys are
     optional (above).
  10. *Unreadable review.json fails open* (minor): taken differently, as the
      "mentions privacy" rule (above), with tests both ways.
  11. *certify's message* (minor): taken as its own message, tested.
  12. *Regex and the D14 claim* (minor): taken; the regex lets a digit follow
      (`fable5` tested). The note uses the existing "Vector" wording and does
      not name VectorScope (tested); it changes no existing string.
  13. *Flat attestation list* (minor): taken as the split kinds, the
      `attestations` warning, and the documented both-ways reading (above).
  14. *`zdrRequestBody` only for OpenRouter* (minor): taken, in the header
      and here.
  15. *Source table* (minor): taken as `RAISE_ONLY` and `TRUSTED_ONLY`, so
      VS-29b's `alternateModel` and `inversion` and VS-30's `runtime` are one
      table entry each.
  16. *Browser bundle* (minor): taken; `browser-bundle.test.ts` passes.
      `format.ts`'s import of `privacy.ts` is type-only and erased.
- **Plan steps taken differently, besides the critique.** The plan's
  `settle` default copy of `zdrAttested`, and its pushing onto `zdrAttested`
  in the "new arrays" test, fall away with the optional keys (that test
  asserts instead that neither key is in the defaults or the result).
  `zdrAttested` is parsed by `attestations`, not plain `strings`.
- **Deferred, for VS-23b to VS-23d and later.**
  - VS-23b: `ReviewOutcome.partial` and `run.ts`'s `Stop` gain `"privacy"`;
    the note for a review that ran under ZDR, with I-3's caveats; model
    resolution passing `destinations` (`api.url`, `api.npm`, the provider
    `baseURL`, and `requestOrigins` with `SDK_ORIGINS`), `defaultOrigins`
    (from `SDK_ORIGINS` and the shipped catalog only, never a URL project
    config set), `price` (`model.cost` unless unpriced), `freeModel` and
    `forwards`; the surfaces switching to `mergeReviewConfig`; the eval entry
    point passing its settings as `global` and lifting step 0b's refusal.
  - VS-23c: `zdrRequestBody` on `openrouter-attested` routes only; `batch`
    and `unattributed-request`; `:online`, `web_search_options` and the
    `zdr: true` wire behaviour checked on the fake server, since OpenRouter's
    prose docs are unread.
  - Subscription (OAuth plan) credentials, which ZDR does not cover even for
    an attested provider ID.
  - Account-default plugins, which the client cannot see, belong in the
    attestation's owner setup (README, Q7).
  - Adding `privacy.ts` to the browser-bundle module list once the app
    imports it as a value (VS-23b/d).
  - Later changes to Anthropic's Covered Models list.
- **Evidence.** Each file was run alone through the lock with
  `--timeout 30000`, `GITHUB_ACTIONS=false`, and `TMPDIR` and XDG roots under
  `/tmp/vector-vectorscope/vs23a-*`:

  | Where | File | Pass |
  |---|---|---|
  | core | `test/review/privacy.test.ts` (new) | 21 |
  | core | `test/review/config.test.ts` | 31 (20 before) |
  | core | `test/review/model-evidence.test.ts` | 17 (16 before) |
  | core | `test/review/format.test.ts` | 46 (45 before) |
  | core | `pipeline`, `skip`, `ignore`, `plan`, `eval`, `eval-report`, `github-payload` | 2, 11, 13, 18, 42, 19, 8 |
  | engine | `test/review/eval.test.ts` (assertions added) | 26 |
  | engine | `test/review/model.test.ts`, `vectorscope-replay.test.ts`, `run.test.ts` | 16, 13, 44 |
  | app | `src/features/pull-requests/ai-review.test.ts`, `src/browser-bundle.test.ts` | 107, 4 |
  | eval scripts | `certify`, `replay` | 6, 32 |

  - `bun typecheck` in core, engine, app and desktop, and
    `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json` from
    `packages/engine`, exit 0.
  - `prettier --check` passes on every changed and new TypeScript file.
  - The pin was set after `privacy.ts` was final, and the pin test re-run.
  - **One unexplained failure.** Engine `eval.test.ts` was run ten times after
    its change: nine passed (26 of 26), and one, run straight after the
    typechecks while the first run of the series had taken 57 s against the
    usual 34 s, reported 25 pass and 1 fail. Its output was not captured, so
    the failing test is not known. It made 311 `expect()` calls, as every
    passing run does, so the failure was a test's last assertion, not an
    earlier one; the likeliest is the hung-model replay's wall-clock bound
    (`Date.now() - started` under 20 s, with a 1.2 s review deadline), which
    is timing-bound under load. This package's change there (step 0b) runs
    before any instance or git work, and its one new assertion is
    deterministic. Not fixed and not loosened: recorded for the next agent
    who sees it to capture the output.
  - The full root typecheck (`bun turbo typecheck --concurrency=1`) was not
    run: nothing is pushed.
  - Nothing was sent, no paid path ran, no workflow was dispatched, no
    dependency was added, and no existing user-visible string changed (D14).

### 2026-11-06 · VS-23a review fixes

Ten review findings, one of them blocking. Every one was fixed; none was
declined. Where a finding offered two ways, the bullet says which was taken.
Only core `review/privacy.ts`, `config.ts`, `format.ts` and
`model-evidence.ts` (the pin) and their tests changed; no runner, provider,
LLM or posting file and no file @vector owns. Nothing is committed. The
points below supersede the entry above where they differ.

- **Blocking: a direct provider's attestation attested an OpenRouter
  account** (I-3; I-2 when the base URL comes from the working tree). Taken
  as suggested. On a model whose requests go to OpenRouter, the provider-ID
  attestation now covers the account only when the provider is `openrouter`,
  or has no `defaultOrigins` (absent or an empty list: a provider defined in
  configuration, such as `my-or`), or its `defaultOrigins` include an
  OpenRouter origin. `decideRoute` computes this and hands it to
  `openRouterRoute` as `attested.provider`. "Absent or empty" is read on the
  raw list, so a list of blank or unreadable entries fails closed. This
  narrows rule 4 above ("a custom provider at openrouter.ai holds its own
  key, so its own ID"). Tests: attested `anthropic` with its base URL moved
  to OpenRouter is `unattested-openrouter`, also with `openrouter.ai`
  attested as a host, through OpenRouter's SDK on a loopback stand-in, and
  with a blank `defaultOrigins` entry. `my-or` (with no and with empty
  `defaultOrigins`), `acme` with OpenRouter's SDK on this computer, and
  `acme` whose `defaultOrigins` are `https://openrouter.ai` stay
  `openrouter-attested`.
- **`json.privacyOnly` trusted on `github`.** Taken the first way:
  review.json is the trusted source only when the surface is `github`, the
  file is at the base, and it was not read for privacy alone. Test: in "the
  desktop's base blob raises privacy, and changes nothing else", a `github`
  base blob read with `privacyOnly` that sets `zdrAttested` leaves it unset
  and warns. The warning names review.json on the base branch as the trusted
  source, which reads oddly when the blob is that base. That is left as it
  is: no caller passes `privacyOnly` on `github`.
- **A bare word among the destinations was read as an SDK package.** Taken
  the first way, as §1.2's signature has it: `RouteModel` gains
  `npm?: string`, and every text in `destinations` is read as a URL, so a
  bare word (`gpu-box`, `localhost`, and a package name placed there) is
  `unknown-destination`. The `PACKAGE` pattern is gone.
  `sendsToOpenRouter` and `sendsToOpenRouterFree` read
  `[npm, ...destinations]` through a small `destinations(model)` helper,
  which both calls use. Of the signature deviations above, `npm?` now matches §1.2;
  `baseURL?` is still `destinations`, a list of URLs only. Tests: every
  fixture passes its package as `npm`, and `["gpu-box"]`, `["localhost"]`
  and the probe `["https://api.anthropic.com/v1", "gpu-box"]` are
  `unknown-destination` with everything attested.
- **OpenRouter over plain http was the account's route.** Taken the first
  way: `openRouterRoute` passes only an `https://` OpenRouter origin on to
  the account. An `http://` one is a hop like any other and goes through
  `serverVerdict`, so it is `unattested-provider` unless its host is attested
  as a host. Tests: `openrouter` and `acme` at `http://openrouter.ai` and
  `http://eu.openrouter.ai`, with their IDs attested, are
  `unattested-provider`, and so is a plain http copy beside the https URL.
  Unchanged and noted for VS-23b's review: any other plain-http host on the
  internet whose host is attested is still `attested-host`. Transport
  security for an attested host is the owner's statement there, as before.
- **The test name overstated the body check.** Taken the first way: renamed
  "refuses routing, plugins, a refused body model and anything it cannot
  read". The body's `model` is not bound to `modelID`. The body carries the
  ID sent (`api.id`), which may differ from the catalog's `modelID` on its
  own, so binding would refuse configured models unless the caller passed the
  sent ID. And under `zdr: true` a mismatch keeps no data.
- **The unexplained engine `eval.test.ts` failure.** Rerun eight times
  through the lock from `packages/engine` with `--timeout 30000`, the full
  output of each kept under `/tmp/vector-vectorscope/vs23a-fix/` (scratch,
  not committed). All eight passed (26 of 26, 311 `expect()` calls, 33 to
  35 s, load average about 1). The failure did not reproduce, so the failing
  test is still unknown. No follow-up was opened: nothing beyond the earlier
  guess points at the hung-model bound. No load was added to force it, since
  the lock allows one Bun workload at a time and a CPU hog would slow the
  other lanes' runs. Not loosened and not skipped. Whoever sees it fail
  again captures the output and records the test and its assertion here.
- **A host attestation dropped its port.** Taken the first way: an entry
  with a port (`gpu-box:8080`, `[fd00::1]:8080`) attests that port alone,
  matched against the origin's port (80 or 443 when the origin names none).
  A host alone still covers every port, and a bare IPv6 address names no
  port (brackets give it one). `gpu-box:80` reads as port 80, although the
  URL parser drops http's own port. This replaces "with or without a port"
  and the `GPU-Box:9999` and `[fd00::1]:1` examples above. Tests: those two
  no longer attest `:8080`; `gpu-box:8080` does not attest `:4000`;
  `gpu-box:80` attests `http://gpu-box`, `gpu-box:443` does not, and attests
  `https://gpu-box`. `config.ts`'s comment says a port limits the entry. Its
  warning's example `"gpu-box:8080"` is now accurate as written.
- **Two reasons in `notePrivacyRefused` made product claims.** Taken with
  neutral wording about Vector's rule. `codium-unaccepted` is now "Vector
  does not yet accept Vector Codium or the free models Vector provides as
  zero data retention routes." `batch` is now "Vector does not send batch
  requests on zero data retention routes." The suggested "while privacy is
  zdr" would repeat the note's own opening clause. Both strings are new in
  this package, so no existing string changed (D14). `format.test.ts`'s full
  Codium note is updated.
- **A non-string attestation entry threw.** Taken: `decideRoute` keeps only
  the entries that are text before either reading, so a bad entry attests
  nothing. Test: `[42, null, { id: "anthropic" }, ["anthropic"]]` attests
  neither the provider nor a host and does not throw; with `"anthropic"`
  added, the provider is attested.
- **A body's `preset` was refused as `fallback-models`.** Taken:
  `zdrBodyRefusal` maps `preset` to `router-or-preset` first, and keeps
  `fallback-models` for `models` and `route`. Tests: the `preset` case now
  expects `router-or-preset`, and a body with both `models` and `preset` is
  `router-or-preset`.
- **Pin.** `privacy.ts` changed, so `REVIEW_PIPELINE_SOURCES` moves from
  `3c100812158a4ab5` to `54fbad71b62bdbda`. It was set after `privacy.ts` was
  final, and the pin test was re-run. `REVIEW_PIPELINE_REVISION` stays 1,
  since no runner reads the file. Off by default as before (I-1): nothing
  calls the changed functions, and `parseReviewConfig` is unchanged.
- **Evidence.** Each file was run alone through the lock with
  `--timeout 30000`, `GITHUB_ACTIONS=false`, and `TMPDIR` and XDG roots under
  `/tmp/vector-vectorscope/vs23a-fix/`:

  | Where | File | Pass |
  |---|---|---|
  | core | `test/review/privacy.test.ts` | 24 (21 before) |
  | core | `test/review/config.test.ts` | 31 (one case added to an existing test) |
  | core | `test/review/format.test.ts` | 46 |
  | core | `test/review/model-evidence.test.ts` | 17 |
  | engine | `test/review/eval.test.ts`, eight runs | 26 each |
  | app | `src/browser-bundle.test.ts` | 4 |

  - `bun typecheck` in core exits 0. No other package imports the changed
    code: `format.ts` imports `privacy.ts` as a type only, and `format.ts`'s
    change is two strings.
  - `prettier --check` passes on the six changed TypeScript files.
  - Nothing was sent, no paid path ran, no workflow was dispatched, and no
    dependency was added.

## 2026-11-06 · VS-21d Round-two research scripts

Addendum A §3, VS-21 "Reproducibility", in the "Now" window: eval-script work
only. It adds no `ReviewConfig` key, no `types.ts` or `config.ts` change,
nothing to `EVIDENCE_POLICY_KEYS`, `EvidenceScope` or `VARIANT_KEYS`, no
replay variant and no TypeScript. Nothing under `packages/*/src` changed, so
no runner, provider, LLM or posting file and no file @vector owns was
touched. The contract's §0.3 items 1 to 5 (key, parity test, evidence scope,
replay variant, desktop half) do not apply, since nothing changes behaviour;
item 6 is this entry. Branch `vectorscope-engine` at `ab5e92e8`. It
implements the VS-21d plan as corrected by its critique; every critique point
was taken, and the bullets below say how. Nothing is committed. Addendum A is
pending Q18 and VS-21 pending Q15; this decides neither, nor any of Q1 to
Q34.

- **What landed.**
  - **`script/vectorscope-eval/research/`** (27 new files, mode 644):
    - from the session's `scripts/`: `jitlib.py`, `jit.py`, `jit2.py`,
      `jit3.py`, `pts.py`, `hist.py`, `hist2.py`, `hist_rev.py`,
      `hist_eval.py`, `hist_eval2.py`;
    - from `rpverify/`: `pp.py`, `selffix.py`, `sens.py` (its `jitlib.py` is
      byte-identical to the one above, so one copy);
    - from `g1/scripts/`: `deepnest.mjs`, `grepbench.sh`, `parsebench.mjs`,
      `slicebench.mjs`, `slicebench_wt.mjs`, `slicebench_gate.mjs`;
    - from `g2/bin/`: `aacr.py`, `aacr2.sh`, `stats.py`, and `feat.py` with
      only `feats`;
    - new: `aacr_jobs.py` (the AACR job list) and `outguard.py` (the
      repository check for `--out`);
    - `README.md` (inputs by URL and pinned commit, the finding IDs each
      script backs, runtime, run commands, the gated and no-script lists, the
      checks) and `.gitignore` (results and inputs: `*.csv`, `*.tsv`,
      `*.json`, `*.jsonl`, `*.log`, `*.txt`, `*.out`, `*.err`, `*.numstat*`,
      `*.git/`, `node_modules/`, `__pycache__/`).
  - **`script/vectorscope-eval/README.md`**: a closing section, "Round-two
    research scripts", pointing to `research/README.md`. No other line
    changed, and no test reads the file.
  - **`.prettierignore`** gains `script/vectorscope-eval/research/` (the
    precedent is `script/vectorscope-eval/fixtures/`), and
    **`.oxlintrc.json`** gains `script/vectorscope-eval/research/**` in
    `ignorePatterns`, with the array now one entry per line and a comment.
    `script/format.ts` runs `prettier --write .`, which would otherwise
    restyle the `.mjs` copies and the README away from the session originals.
    Neither file feeds a pipeline file, a test or CI.
- **Selection rule.** A script is committed when the datasets it reads by
  design are D8-clean today: ApacheJIT and the Apache repositories,
  Kubernetes, vscode, Keycloak and the AACR permissive subset. The timing
  scripts (`grepbench.sh`, `parsebench.mjs`, `slicebench*.mjs`) take any
  repository path. They are committed with only their D8-clean round-two
  inputs named, as the addendum's clean list anticipates. Their round-two
  rows on Linux, Grafana, Sentry and Discourse (G1-7's Linux, Grafana and
  Sentry grep rows; G1-8's Sentry, Discourse and Linux parse rows; G1-9's
  Sentry and Linux slice rows, the Linux working-tree row included) are the
  first row of the README's "Gated" table, gated on Q10 and Q26: the scripts
  are committed but must not be run on those repositories, and their "Backs"
  cells say the other rows are gated. The slice scripts' language table keeps `py` and
  `c`, which round two ran only on Sentry and Linux; removing them would
  change the copy, so the README marks them and says their grammars are not
  needed for the clean rows.
- **Not committed** (all listed in `research/README.md`, "Gated"):
  - ReviewBench corpus repositories, gated on VS-22's per-repository licence
    check: `fc.sh`, `rb_fc.py`, `sizes.py`, `rb_strat.py`, `producers.py`,
    `grep_presence.py` (G1-1, G1-3, G1-4, GU7), and `gold.py` (G2-1 to G2-3
    ReviewBench rows; also Q27 for cutpoint seeding);
  - Martian goldens, gated on Q10 and Q26 (addendum A §3 gates every script
    whose inputs include Linux, Grafana, Sentry, Discourse or Martian's
    goldens on both): `martian_repo.py` (G1-6), `mart.py`
    (G2-1 to G2-4 Martian rows), `depth.py` (G2-6), and the root-level
    `agg.py`, `ana.py`, `boot.py`, `break.py`, `ctx.py`, `chk_gu4.py`,
    `chk_gu4b.py` (GU3 to GU5);
  - mixed job lists, gated on Q10 and Q26 and VS-22: `numstat.sh`, `jobs.py`
    and `feat.py`'s main block. `numstat.sh` was the first numstat pass over Martian merge refs, the
    ReviewBench mirrors and all 196 AACR pairs (with base and head swapped
    and no merge base); `aacr2.sh` superseded it for AACR. The plan's "only
    Martian merge refs and the ReviewBench mirrors" was wrong;
  - the AACR all-positives figures, which include non-permissive
    repositories, gated on the per-PR licence check (VS-22) and Q31: gap-2
    §1.2's all-positives validation counts, the session `aacr.py`'s "all"
    section, and gap-2 §2.1's all-positives median PR size (no script prints
    that one). The README names them by section, not by value (D12);
  - `lic.py` and `lic_fetch.sh`, VOI13's licence fetchers, which belong with
    VS-22's per-PR check;
  - `h2t.py`, an HTML-to-text helper that backs no finding.
- **No surviving script** (ad hoc commands or arithmetic): G1-11, G1-12,
  G1-7's Linux `--threads` and pathspec rows and its "old commit" figure,
  G2-1's changed-line shares per band, G2-5, G2-7 and G2-13's recall
  comparison, G3-1 and G3-2 and gap-3 §1.2's `change_line_count`
  distribution, and RP6's hadoop count (`jit.py` and `jit2.py` drop hadoop
  before printing).
- **Changes from the session copies**, each I/O, a usage guard, a pin or a
  failure mode; each file's header names its origin and lists them. The code
  is not restyled and not brought to the TypeScript style guide.
  - Python: `argparse` everywhere (so `--help`, and exit 2 on a missing
    argument), and `runpy.run_path(<this folder>/jitlib.py)` in place of
    `exec(open("jitlib.py").read())`, which depended on the working directory.
    The history scripts load `jitlib.py` for `APACHE_REVS` only (they never
    called `auc`).
  - `hist.py`, `hist2.py`, `hist_rev.py`, `selffix.py`, `sens.py` walk
    `APACHE_REVS[name]` (the round-two clone heads) instead of `HEAD`, with
    `check=True`, so a clone without the pinned commit fails loudly instead of
    matching 0 commits. Their git stderr is no longer captured
    (`stdout=subprocess.PIPE`), so git's message shows; stdout is unchanged.
  - The three history scripts write `--out` (required) instead of a fixed
    file in the working directory; `hist_eval.py` and `hist_eval2.py` take
    that CSV as an argument.
  - `grepbench.sh`: `SCRATCH_DIR` argument; the loose `/tmp/gb.out` became a
    `mktemp` file there, created before the `cd` and removed on exit; `-e`
    before each name in the per-name loop (the combined row already had it),
    so a name starting with `-` is a pattern, not an option such as
    `-O<cmd>`.
  - `aacr2.sh`: `OUT_DIR` argument in place of the scratchpad path, made
    absolute (`realpath -m`) before any `cd`; `numstat/` and `git/` created
    (the session relied on pre-made `out3/` and `git3/`); `cd "$G"` quoted;
    `KEY` must be `aacr_` and 10 hex digits, the only form `aacr_jobs.py`
    writes, since it names a folder that is removed (so a mistaken `OUT_DIR`
    cannot turn it into `~/git/<project>`); `URL` must be
    `https://github.com/OWNER/REPO`, `BASE` and `HEAD` 40-hex SHAs and
    `SINCE` `YYYY-MM-DD`, each exiting 2 otherwise, since all four reach git
    and git reads an option after a positional (`--upload-pack=<cmd>` on
    fetch, `--output=<path>` on diff); `--end-of-options` before the
    repository and revisions of `git fetch`, `git merge-base` and `git diff`
    (all three accept it on git 2.43); exactly six arguments, and `--help`
    exits 0.
  - `aacr.py`: `runpy` for `stats.py` and `feat.py` (was an `exec` with string
    surgery on `feat.py`); reads only the PRs `aacr_jobs.py` listed; the
    unused per-PR licence-text parse (`lic` was never read) and the "all"
    section removed, so it never reads a non-permissive numstat. Its
    validation and comment-key lines now cover the permissive PRs (131 in
    round two); its permissive section prints as before.
  - `feat.py`: the `G = sys.argv[1]` line and the main block dropped.
  - `aacr_jobs.py` (new) rebuilds the session's ad hoc AACR job list: base
    `source_commit`, head `target_commit` (gap-2 §1.2), `--shallow-since` 120
    days before `created_at`, key `aacr_` plus 10 hex of md5 of the PR URL,
    and only repositories outside `NONPERM`, which moved here from
    `aacr.py`. It exits 1 naming the sample when a `githubPrUrl` is not
    exactly `https://github.com/OWNER/REPO/pull/N` (`re.fullmatch`, stricter
    than a `^…$` pattern, whose `$` lets a trailing newline through) or a
    permissive sample's `source_commit` or `target_commit` is not a 40-hex
    SHA, so no field can shift a column of the TSV or reach `aacr2.sh` as an
    option; all 196 dataset samples pass. Its argument parsing and output sit under
    `if __name__ == "__main__"`; `aacr.py` does not load it, since filtering
    by the job list already restricts it to the permissive subset.
  - Node: an argument guard before `createRequire` or any `require`
    (`--help` exits 0, wrong arity exits 2). The slice scripts' language
    table moved above `createRequire`, so `LANG` is checked with
    `Object.hasOwn` (and must be `go` in `slicebench_gate.mjs`, which builds
    `k8s.io` import paths); `MODE` must be `commits` or `synthetic` (anything
    else used to mean synthetic); counts must be positive integers. Beyond
    the plan: `NODE_MODULES` is resolved to an absolute path, since
    `createRequire` refuses a relative one, and `parsebench.mjs` checks
    `MAX_FILES`. The usage comments of `slicebench_wt.mjs` and
    `slicebench_gate.mjs` now name their own file.
  - I-13 guard (critique): `--out` (through `outguard.py`), `OUT_DIR` and
    `SCRATCH_DIR` are refused inside the repository that holds the scripts
    (`git rev-parse --show-toplevel`), with exit 2, as `ci.ts` refuses
    `EVAL_OUT_DIR`. Outside a git checkout nothing is refused.
- **Corrections recorded, not edited** (the report and notes are dated
  evidence):
  - `notes/risk-prediction.md` §0 calls the four Apache clones "treeless";
    the session clones are `--filter=blob:none` (blobless). The README's
    "never `--filter=tree:0`" rule is scoped to those history clones;
    `aacr2.sh`'s `--filter=tree:0 --shallow-since` fetch is deliberate.
  - RP19's AUC is `hist_eval.py`'s `fixlast5` row on `hist_rev.py`'s CSV;
    the `fixd90` row differs in the third decimal.
  - The plan counted 41 session files; the four folders hold 40 (37 scripts
    and 3 CSVs). Of the 37, 23 are copied (one in part), the duplicate
    `jitlib.py` is not, and 13 are gated or back nothing.
- **Open items for the owner** (raised, not decided):
  - **ApacheJIT's licence.** D8 allows permissive licences only, and
    `hosseinkshvrz/apachejit` has no LICENSE file at `ddfd547`, and its
    readme states no licence. zenodo.org was refused in round two
    (verify-open-items §0), and the GitHub REST API refuses repositories not
    attached to the session (gap-1 §0), so no other licence statement could
    be read. The addendum classes ApacheJIT as D8-clean;
    that is the addendum's call, which this package follows, but the owner
    or VS-22's licence check should confirm it.
  - `aacr_jobs.NONPERM` is VOI13's outcome. VOI13's fetchers are not
    committed, so the permissive subset cannot be re-derived from committed
    code until VS-22's per-PR check. The per-PR licences stay pending (Q31).
  - The README names the AACR repositories only through the pinned dataset
    and `aacr_jobs.py`'s output, because the 40 permissive repositories
    include open-source coding-agent CLIs (Q34). The gated table's
    descriptions leave out the judge and model IDs that the Martian scripts
    contain.
- **Off by default and invariants.** I-1 holds by construction: nothing in
  any runner or package imports or reads `research/`, and there is no key to
  unset. I-12: no new key and no pipeline file changed, so
  `REVIEW_PIPELINE_SOURCES` stays `54fbad71b62bdbda` and
  `REVIEW_PIPELINE_REVISION` stays 1. I-13: no data or result is committed;
  `.gitignore` and the path checks guard against it. I-10 and §0.5: these are
  offline research simulations under `script/`, imported by nothing in the
  engine or core, so they are not a third code reader beside `brain/code.ts`
  and `review/symbols.ts`. D12 and D14: no user-visible string changed.
- **Reproducibility.** The report's "not reproducible from the repository
  today" label now applies only to the gated and no-script numbers (G1-11
  and G1-12 among the latter are D8-clean, but were ad hoc commands); the
  findings the README's script table lists trace to a committed script. The
  report is not edited.
- **Deferred.** Nothing in VS-21d belongs to the runner-wiring or a later
  window. The gated scripts wait for Q10, Q26, VS-22's licence check, and
  Q27 or Q31 where noted. VS-21's other §3 items (metric and β per external
  comparison, repetition, stratification, the ablation) are not part of this
  package. Verification deferred: the timing scripts against their reported
  figures (not rerun: benchmarks and large clones, and Q26-neutral); whether
  the npm tarballs ship the `.wasm` files under `--ignore-scripts`;
  ApacheJIT's licence; the AACR per-PR licences (VS-22); the 140 AACR
  fetches (not rerun; the copies were checked on the session's numstats).
- **Review round.** Ten non-blocking findings, all taken; none was declined.
  The bullets above already describe the result. This one lists what changed
  and why:
  - The README's "Gated" table gains a first row: the gated rows of
    `grepbench.sh`, `parsebench.mjs`, `slicebench.mjs` and
    `slicebench_wt.mjs`. They are G1-7 to G1-9 as measured on Linux,
    Grafana, Sentry and Discourse, gated on Q10 and Q26. The scripts are
    committed but must not be run on those repositories. The heading drops
    "not committed", and the intro says which rows are committed. The
    "Selection rule" bullet above now matches the table; it used to claim
    rows the README did not have.
  - The Martian rows, the root-level Martian re-analyses and the mixed
    `numstat.sh`, `jobs.py` and `feat.py` main-block rows are now gated on
    Q10 and Q26, not on Q10 alone. This follows addendum A §3, and the
    README intro says why both are named.
  - `aacr2.sh` and `aacr_jobs.py` validate every field that reaches git or
    the TSV. The checks are described under "Changes from the session
    copies". Two findings asked for the same URL check with different
    patterns (`[^/]+` and `[A-Za-z0-9_.-]+`), and the stricter one was used.
    `--end-of-options` is redundant once the formats are checked, but costs
    nothing on git 2.43, so it was added as asked. `grepbench.sh` passes
    `-e` in its per-name loop.
  - The README's run block now starts with `set -euo pipefail` and an
    `R=… W=…` line, and the reader is told to run it as a file. Pasted into
    an interactive shell, `set -e` would close the shell, so chaining every
    line with `&&` was the other option, and it was not taken because it is
    unwieldy across about 40 lines.
    - The depth-1 fetch and checkout are split onto two lines. Under
      `set -e`, a failure on the left of `&&` inside a `for` loop lets the
      loop run on (checked).
    - One `python3 -I -c` command, run right after `npm install`, compares
      `$W/ts/package-lock.json`'s integrity for the four packages the
      scripts load against the table and exits 1 naming any mismatch. It
      was checked against the session lock (exit 0) and against a copy with
      one integrity changed (exit 1, naming `tree-sitter-go`).
    - The transitive `node-addon-api` and `node-gyp-build` are left out of
      that check. Their caret ranges may resolve to newer versions, and
      nothing loads them under `--ignore-scripts`. The finding's alternative,
      `npm ci` from a lock quoted in the README, was not taken: the check
      above covers the loaded packages without a long lock in the README.
    - The `aacr2.sh` loop skips exit 1, a PR whose SHAs GitHub no longer
      serves (9 in round two), and stops on exit 2, a malformed row, through
      `|| [ $? -eq 1 ]`. This was checked under `set -e`.
  - The bare-clone `grepbench.sh` call has its own line in the run block,
    with the note "only treeish_ms is meaningful; ignore worktree_ms". The
    script is unchanged, so it stays close to the original. The session
    original prints the same meaningless worktree figure, and gap-1 shows
    "—" for it.
  - D12: the README's AACR all-positives row, and this entry, now cite
    gap-2 §1.2 and §2.1 instead of quoting the non-permissive figures.
  - Re-checked from `/tmp/vector-vectorscope/vs21d-fix`:
    - Parse checks: `py_compile` on 18 `.py`, `node --check` on 5 `.mjs`,
      and `bash -n` on 2 `.sh` and on the README's run block.
    - The argument, end-to-end and `aacr_jobs.py` checks listed under
      "Evidence".
    - The upstream-name rule on the 31 new and modified files (`git status`,
      this log included): no hit.
    - The other scripts were not touched, so their checks were not rerun.
    - No package source changed, so no Bun typecheck applies. core
      `test/review/model-evidence.test.ts` still passes 17 tests, and the
      `REVIEW_PIPELINE_SOURCES` pin is unchanged.
    - prettier reports no change inside this entry. The log's earlier
      entries already differ from prettier at `HEAD`.
- **Evidence.** Python and node checks ran from `/tmp/vector-vectorscope/vs21d`
  (outside the repository, so no script depends on the working directory).
  Bun ran through the lock with `--timeout 30000`, `GITHUB_ACTIONS=false`,
  and `TMPDIR` and XDG roots under `/tmp/vector-vectorscope/vs21d/`.
  - **Parse.** `python3 -I -X pycache_prefix=… -m py_compile` on 18 `.py`,
    `node --check` on 5 `.mjs` and `bash -n` on 2 `.sh` all pass, and no
    `__pycache__` is left in the folder.
  - **Arguments.** The 14 runnable Python scripts, 5 `.mjs` and 2 `.sh`:
    `--help` exits 0, no arguments exits 2; a bad `LANG` (including
    `__proto__`), `MODE`, `CASES`, `FILES_PER_CASE`, `MAX_FILES`, `KEY`, or
    `ts` for the gate, exits 2. `aacr2.sh` also exits 2, before creating
    anything, on a `KEY` not of the `aacr_` form (`abc`, 9 hex digits,
    `../aacr_…`), a `file://`, `--upload-pack=…`, multi-line or deeper
    `URL`, a `BASE` or `HEAD` that is short, upper-case or `--upload-pack=…`
    or `--output=…`, and a `SINCE` of `2025-1-1` or `--upload-pack=x`; no
    command ran. `aacr_jobs.py` exits 1 naming the sample, and writes no TSV,
    on a URL with `/files`, a trailing newline or a tab, and on a permissive
    sample's commit that is `--upload-pack=x`, upper-case or ends in a tab; a
    bad commit in a `NONPERM` sample leaves the list unchanged.
  - **Paths inside the worktree.** Refused with exit 2 and nothing created:
    `aacr2.sh` `OUT_DIR` inside and equal to the worktree, `grepbench.sh`
    `SCRATCH_DIR`, `hist.py --out`, and `aacr_jobs.py --out` given as a
    relative path into the worktree.
  - **Helpers.** `runpy.run_path` of `jitlib.py`, `stats.py`, `feat.py`,
    `outguard.py` and `aacr_jobs.py` (with a foreign `sys.argv`) exposes their
    names and runs no main block.
  - **stdout, copy against the session original (run in its own folder).**
    Identical: `jit.py` (68 lines), `jit2.py` (79), `jit3.py` (16), `pts.py`
    (39), `pp.py` (6), `selffix.py` (11), `sens.py` (9), `hist_eval.py` on
    `hist_features.csv` (29) and on `hist_revert.csv` (26; the original run in
    a temporary folder holding that CSV as `hist_features.csv`),
    `hist_eval2.py` (17).
  - **History CSVs.** The copies of `hist.py`, `hist2.py` and `hist_rev.py`
    write CSVs byte-identical (`cmp`) to the session's; every dataset commit
    of the four projects matched. The originals were not run, since they would
    overwrite those CSVs.
  - **`aacr_jobs.py`.** 140 rows in 40 repositories, equal row for row and in
    order to the session job list's rows for those keys, before and after the
    review fixes (`cmp`).
  - **`aacr.py`.** On the session numstats, with and without `--defect`, its
    output equals byte for byte the original's, run on a temporary scratchpad
    whose numstat folder holds only the 131 permissive numstats (symlinks) and
    an empty licence file, once the original's "all" section is removed; there
    that section equals its permissive section. The figures match gap-2 §2.2's
    AACR table. The original was never run on the full session folder.
  - **Pinned-commit failure.** `hist.py` and `selffix.py` on a bare clone
    without the pinned commit exit 1 with a `CalledProcessError` naming it.
  - **End to end, offline, under `vs21d/e2e`** (rerun after the review fixes
    under `vs21d-fix/e2e`). `aacr2.sh` with a relative `OUT_DIR` against a
    two-commit local bare repository, reached as
    `https://github.com/test/repo` through `url.file://….insteadOf` in
    `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`, since the
    script now accepts only GitHub URLs: the numstat (2 files) and merge base
    are right, `git/` is empty afterwards, a rerun exits 0, an unknown SHA
    exits 1 with "not our ref" in `.err` and its clone removed.
    `grepbench.sh` with a relative `SCRATCH_DIR`, two names on the checkout
    and one on a bare clone: exit 0, temporary file removed, repository
    unchanged; after the fix, the names `--open-files-in-pager=touch <file>`
    and `-O` are grepped as patterns (0 files) and the file is not created. With the session's `node_modules` through a relative symlink:
    `parsebench.mjs` (both Go grammars), `slicebench.mjs` (`go synthetic 1`;
    `go commits 2`), `slicebench_wt.mjs` (`go synthetic 1 3`) and
    `slicebench_gate.mjs` (`go commits 2`) exit 0; `deepnest.mjs` exits 0 and
    again drops one capture at depth 200,000 (G1-15).
  - **core `test/review/model-evidence.test.ts`.** 17 pass; the pin is
    unchanged.
  - **Eval scripts typecheck.** `typecheck.yml`'s command, from
    `packages/engine`:
    `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json` exits 0, and
    with `--listFilesOnly` it lists 19 eval files and none under `research/`.
  - **Formatting and lint.** `prettier --check` passes on `.oxlintrc.json` and
    the eval README; prettier skips `research/` (with
    `--ignore-path /dev/null` it would flag the `.mjs` and README); `oxlint`
    finds no files to lint under `research/`.
  - **Name checks.** The upstream-name rule of `upstream-free.test.ts`,
    replicated on the 30 new and modified files (the test reads
    `git ls-files`, so it cannot see untracked files): no hit. No open-source
    coding-agent CLI, judge or model ID appears under `research/`.

  - No package's source changed, so no package `bun typecheck` applies; the
    eval scripts' own typecheck above is the one this folder sits under.
  - Nothing was sent, no paid path ran, no workflow was dispatched, no
    dependency was added and the lockfile is unchanged. No result or data
    file was written inside the worktree.

## 2026-11-06 · VS-33a ZDR refusal list v2 and structured attestations

Addendum A §2 VS-33, items 1, 3 and 4, in the Now window (§4): the new
`RouteRefusal` values and their pure checks in core `review/privacy.ts`, and
the attestation-object parser over the trusted inputs `mergeReviewConfig`
already takes (base `review.json` on `github`; the untyped `global` input on
`local`, which no engine schema fills before VS-23d). Built on VS-23a's
`privacy.ts`, `decideRoute` and `RouteRefusal` at `2bc90691`. VS-33 is a
proposal pending Q18, so everything is off by default and nothing calls it.
No runner, provider, LLM or posting file and no file @vector owns changed:
`run.ts`, `ai-review.ts`, `provider.ts`, `session/llm.ts`, `posting.ts`,
`workflow.ts`, `command.ts`, `github.*`, `github-*.ts`, `vectorscope.astro`,
`packages/engine/src/config/*`, the generated SDK and client, and
`script/vectorscope-eval/*` are untouched. It implements the VS-33a plan as
corrected by its critique; every critique point was taken, two of them
differently (below). Nothing is committed.

- **What landed.**
  - **Core `types.ts`** (still import-free): `ZdrAttestation`
    (`{ id, operator, project?, region?: "eu" | "us", extendedCache?,
    verify?: "attest" | "api" }`) and `ZdrAttestedEntry = string |
    ZdrAttestation`; `ReviewConfig.zdrAttested?: ZdrAttestedEntry[]`. Its
    comment says text is the legacy form with today's meaning, and that
    VS-23b's admission must refuse a listed `verify: "api"` attestation until
    a verifier exists, and an OpenAI one unless Q20 approves an admin
    credential. `DEFAULT_REVIEW_CONFIG` is unchanged.
  - **Core `privacy.ts`** (pinned):
    - `ROUTE_REFUSALS` gains, in this order after the thirteen, which keep
      theirs: `server-tool`, `provider-options`, `extended-cache-unattested`,
      `grounding-tool`, `durable-cache`, `anthropic-non-zdr-feature`. The
      comment names each value's producer.
    - `RouteDecision`'s allowed arm gains `attestations?: readonly
      ZdrAttestation[]`.
    - `decideRoute`'s `policy.attested` takes `readonly ZdrAttestedEntry[]`.
    - New exports `readZdrAttestation`, `extendedCacheOnly`,
      `zdrFeatureRefusal`, `ZdrRequestFormat` and `NOT_A_NAME`.
    - `zdrBodyRefusal` gains `server-tool`, `provider-options` and
      `anthropic-non-zdr-feature`;
      `zdrRequestBody`'s code is unchanged and its doc says an empty
      `options` is kept.
    - The header names VS-33's parts, says they have no caller, and states
      the admission's duty for `verify: "api"` and that only its Vertex
      metadata call can give `durable-cache`.
  - **Core `config.ts`**: imports `readZdrAttestation` and `NOT_A_NAME` as
    values. The
    private `attestations` field is one ordered pass over the list (text,
    attestation objects, anything else). `expected`, `parseReviewConfig`,
    `RAISE_ONLY`, `TRUSTED_ONLY`, `SOURCED_REVIEW_KEYS` and every source
    rule are unchanged (I-2). Comments on the field, `TRUSTED_ONLY` and
    `mergeReviewConfig` mention attestation objects.
  - **Core `format.ts`**: six new `PRIVACY_REFUSAL` reasons. No existing
    string changed (D14), and none names VectorScope (the existing test
    checks every refusal's note).
  - **Core `model-evidence.ts`**: the pin only.
- **Rule decisions.**
  - **Entries.** Text is read exactly as VS-23a reads it (trimmed ID, and
    `attestedHost`), with `extendedCache` false. An attestation object reads
    its `id` the same way. An entry `readZdrAttestation` cannot read, and any
    value that is neither, attests nothing. Under `standard` every entry is
    ignored, as before.
  - **Region.** A `region` pins only an OpenRouter account: such an entry
    attests no host and no provider on any other route, and no OpenRouter
    hop's host. On an OpenRouter route whose account entries name a region,
    at least one https OpenRouter destination must exist and every one must
    be `<region>.openrouter.ai` for every region named, compared on
    `hostOf(origin)` with trailing dots stripped (`eu.openrouter.ai.`
    passes). Two regions never hold, and text beside a pin keeps the pin
    (strictest). A loopback stand-in alone cannot show the region, so it is
    refused under a pin and passes beside the regional host. A mismatch
    reuses `unattested-openrouter`, which keeps the vocabulary to the
    addendum's list; its note ("the OpenRouter account it uses is not listed
    in `zdrAttested`") reads wrong for a listed account on the wrong host,
    and rewording it is a VS-23b item. Requirement on VS-23b's caller,
    stated in `decideRoute`'s doc: a URL the configuration replaces (the
    catalog's shipped URL under a provider base URL) goes in
    `defaultOrigins`, not `destinations`, or every region-pinned account is
    refused.
  - **Extended caching.** After a route passes, it is refused as
    `extended-cache-unattested` when `extendedCacheOnly([modelID, apiID])`
    holds and any entry that attests one of its destinations lacks
    `extendedCache: true`. That is the strictest reading: text, or an object
    without the flag, beside a flagged object still refuses. An entry that
    attests none of the destinations does not count, and a route on this
    computer alone has no entries, so it is exempt. This is the one rule
    change visible to text-only lists: a gpt-5.5-or-later route attested by
    text alone is now refused. That is the design's own refusal, and it is
    unreachable until wiring.
  - **`attestations`.** Every attestation object that attests one of the
    route's destinations, whichever entry decided the route. For a
    destination these are the matching host entries plus the provider's
    entries when the origin is one of `defaultOrigins` (never on your
    network). On an OpenRouter route they are the account's entries, then
    each hop's host entries. They are listed in destination order,
    de-duplicated by position in `policy.attested`, and left out when there
    are none, so text-only decisions are byte-identical (tested with
    `toStrictEqual`).
  - **Version table** (`extendedCacheOnly`, the one place; VS-23c reuses
    it). `gpt`, then a `-`, a `_` or nothing, then the major version, is
    matched anywhere in the lowercased ID, every occurrence (so
    `chatgpt-5.5`, `gpt5.5` and `gpt_5.5` match). The minor version follows
    a dot, or a `-` or `_` as one or two digits that no digit follows
    (`gpt-5-5` is 5.5; a dated `gpt-5-2025-08-07` and `gpt-4-0613` read as
    5.0 and 4.0). A two-digit run without a minor is major and minor, as
    `transform.ts` `gpt5OrNewer` reads it (core cannot import engine):
    `gpt-55` is 5.5, `gpt-35-turbo` 3.5, Venice's `openai-gpt-54-pro` 5.4.
    The exception is a run from 10 to 29, which no OpenAI model has been:
    it is the major version, so a future `gpt-10` is 10 and refused. It is
    true for 5.5 and later. Accepted cost of leaning to refusal: an open
    model such as Cerebras-GPT-13B (`cerebras-gpt-13b`) reads as 13, so on an
    attested host it needs `extendedCache: true`. The comment says to update
    the table when OpenAI names later models otherwise.
  - **`readZdrAttestation`.** The first problem wins, as a phrase that
    follows "the entry", in this order: not an object; any set key outside
    the six (`__proto__` included, as `JSON.parse` makes it an own key);
    no `id`; an `id` that is a URL, has a space, user, query, fragment or
    backslash (`NOT_A_NAME`, one exported const that `attestedHost` and
    `config.ts`'s text entries share) or a control
    character; `operator` missing or blank; `operator` not text;
    `project` not text; `region` not exactly `eu` or `us`; `extendedCache`
    not a boolean; `verify` not exactly `attest` or `api`. A key set to
    undefined is unset. The result is a new, trimmed object with only the
    keys set.
  - **`zdrBodyRefusal`** (OpenRouter bodies), after the plugins check:
    - a `tools` value that is not absent, null or a list of objects is
      `unreadable-body`, and so is message content nested more than 16
      lists deep;
    - a `tool_choice` that is not absent or null is `server-tool` unless it
      is one of the strings none, auto, required or any, or an object
      whose `type` is one of those or function or tool; any other value is
      `unreadable-body`;
    - `server-tool`: any tool outside the allow list (critique 1), a
      `deferred_tools` field (OpenRouter's deferred-tool protocol is its
      tool-search server tool in another shape), or a stored-file
      reference in `messages` or a Responses `input`, through nested
      `content` and `output` lists and a custom-content document's
      `source.content`. A stored-file reference is a non-blank `file_id`,
      `file.file_id` or `source.file_id`, a `source.type` of `file`, or a
      `container_upload` block. Inline files, data URLs and text that
      mentions a file pass;
    - `anthropic-non-zdr-feature`, after `server-tool`: an own
      `mcp_servers`, `container` or `thread` set to anything, or a tool whose
      `allowed_callers` is set to anything but a non-empty all-"direct" list.
      OpenRouter serves Anthropic's Messages API (`/api/v1/messages`), and
      this is that route's only body check, so it refuses what
      `zdrFeatureRefusal` refuses in an Anthropic body, with the same
      field list and the same callers check (`codeCallable`);
    - `provider-options`: `provider.options` other than absent, undefined or
      an empty plain object (`null`, lists and scalars are refused). Fail
      closed throughout.
  - **`zdrFeatureRefusal`** (`{ format: "anthropic" | "google", body,
    path? }`) is an allow list on both halves (critique 2). It never changes
    its input; deciding a request's format is VS-23c's.
    - **Google:** every tool must be function calling. That is an object
      whose set keys are only `functionDeclarations` or
      `function_declarations`, each a list, or a `type: "function"` tool
      with only OpenAI function-tool keys. Anything else is
      `grounding-tool`: Search, Search retrieval, Maps, URL context,
      enterprise, Parallel and Exa search, retrieval, code execution,
      computer use, `{}`, and a function tool with a grounding key beside
      it.
    - **Anthropic paths:** `path` (a URL or path) must end in
      `/v1/messages` or `/v1/messages/count_tokens` after trailing slashes,
      so a base-URL prefix still matches (OpenRouter's `/api/v1/messages`),
      or be Claude's endpoint on Vertex (`.../publishers/anthropic/models/
      <model>:rawPredict` or `:streamRawPredict`) or on Bedrock
      (`/model/<model>/invoke` or `/invoke-with-response-stream`), as the
      pinned `@ai-sdk/google-vertex/anthropic` and
      `@ai-sdk/amazon-bedrock/anthropic` build them (read from their
      `dist`). Batch returns `batch`: `/v1/messages/batches` and below,
      Vertex's `batchPredictionJobs` and Bedrock's `model-invocation-job(s)`.
      That is the existing name, returned here so the check is not
      fail-open for a caller that runs only it. The doc says the transport
      must pass `path` for an Anthropic request; without it only the body is
      checked. Every other path, including Files, Skills, Tunnels,
      Managed Agents, `vaults` and `user_profiles`, is
      `anthropic-non-zdr-feature`. This supersedes the plan's "user_profiles
      is not refused (no prompts or outputs)": an allow list refuses what a
      review never calls.
    - **Anthropic body:** an own `mcp_servers`, `container` or `thread` set
      to anything (null and empty lists included) is refused. So is a stored
      file anywhere in `messages`, with the same check as above, a
      custom-content document's `source.content` included.
    - **Anthropic tools:** allowed are no type or `custom`; the client
      tools `bash_`, `text_editor_`, `memory_`, `computer_`,
      `computer_toolset_` and `browser_toolset_` with a date; `advisor_`
      with a date; `tool_search_tool_regex` and `tool_search_tool_bm25`,
      dated or not; `web_search_20250305` and `web_fetch_20250910`. A dated
      `web_search_` or `web_fetch_` from 20260209 on is allowed only with
      `allowed_callers` exactly `["direct"]`. Any tool whose
      `allowed_callers` is set to anything but a non-empty all-"direct"
      list is refused (programmatic tool calling). Every other type is
      refused: `mcp_toolset`, `code_execution_*`, `foo_20270101`, an
      unlisted `web_search_20251001`, bare `bash`. Basic web search and
      fetch stay allowed because Anthropic marks them ZDR-eligible.
  - **`durable-cache`** is in the vocabulary with no producer: only VS-23b's
    Vertex `getCacheConfig` admission can tell.
  - **Unchanged and pinned by tests:** `eu.openrouter.ai` and
    `us.openrouter.ai` are OpenRouter through `isOpenRouterURL`.
    `RETENTION_REQUIRED` matches Bedrock IDs, cross-region and global
    profiles, a system-defined inference-profile ARN, and Vertex `@`
    versions.
- **Config decisions.**
  - One ordered pass: text is trimmed; blank text, numbers, null and lists
    are "not text"; text matching `NOT_A_NAME` is dropped with today's exact
    note. A plain object goes through `readZdrAttestation`, and a problem
    drops it with `<subject> <problem>, so it was dropped`. The subject is
    `the entry for "<id>"` when the ID is readable, else `entry <n>` (its
    1-based place in the list). No other field is ever echoed (critique 11:
    a `project` can be an account ID in a public CI log; tested).
  - Notes, joined by "; ": "entries that are not text were dropped"; the
    named-text note; one note per object problem; then one note per ID that
    an object shares with another kept entry. Text beside an object gives
    `"<id>" is also listed as text, which accepts no "extendedCache", and
    the strictest of every entry that attests a route applies, whatever
    its ID`. Objects alone give `"<id>" is listed more than once, and the
    strictest of every entry that attests a route applies, whatever its
    ID` (critique 7, generalised). Known limit: without a model the config
    cannot tell which entries of other IDs attest the same route, so text
    `api.openai.com` beside an `openai` object gets no note (tested), while
    `decideRoute` still applies the strictest reading; the note's wording
    states that wider rule. Text-only repeats get no note, so a list of
    text alone yields exactly today's value and warnings (the existing
    tests pass unchanged).
  - `readZdrAttestation`'s problem result carries the readable `id`, a small
    deviation from the plan's `{ problem }`, so `config.ts` can name the
    entry without reading the object a second way.
  - `config.ts` now imports `privacy.ts` as a value. This supersedes VS-23a's
    "`config.ts` does not import `privacy.ts`". It keeps one reader of the
    shape in the pinned file. The import is bundle-safe:
    `browser-bundle.test.ts` now expects `packages/core/src/review/privacy.ts`
    among the walked modules (VS-23a's deferred item) and still finds no Node
    or Bun module.
  - `expected` is kept ("a list of provider IDs and model server hosts").
  - An attestation list whose every entry is dropped is left out like the
    default (tested).
- **Tests changed in place** (both tighten the rule; none was loosened):
  - The refusal-vocabulary test lists nineteen values.
  - "an attestation entry that is not text attests nothing, and does not
    throw" is renamed "an attestation entry the rules cannot read attests
    nothing, and does not throw". It keeps its four cases and adds seven
    unreadable objects, `__proto__` included.
  - `zdrRequestBody`'s kept preferences now carry `options: {}`. The former
    `options: { anthropic: { cache: true } }` moves into the new
    `provider-options` refusal test.
- **Critique of the plan, point by point.**
  1. *Server-tool deny list* (major): taken as an allow list. Function
     tools (`type: "function"`), custom tools (`custom` or no type) and
     Anthropic's `bash_<date>` are allowed. OpenRouter returns that bash
     tool to the client (bash.mdx:217-227); it is allowed only with no
     `parameters` or `engine` key, since the sandbox is chosen by
     `engine: "openrouter"`. Every other type is refused, including
     `text_editor_*`, which OpenRouter's docs do not say runs client-side.
     The `tool_choice` allow list is as above, and `allowed_tools` is
     refused (Vector does not send it). `deferred_tools` is refused too.
     Tested: `web_search`, `web_search_preview`, `web_search_20250305`,
     `web_fetch_20250910`, `tool_search`, `tool_search_tool_regex_20251119`,
     `code_interpreter`, `file_search`, `mcp`, `image_generation`,
     `computer_use_preview`, `shell`, `local_shell`, `apply_patch`, nine
     `openrouter:` names and odd spellings. Evidence, OpenRouterTeam/docs at
     `f1ededbc`: `openapi/openapi.yaml` `ServerTool.aliases` (:32523, "Every
     spelling accepted in `tools[].type`", example `web_search_20250305` at
     :32731); `ChatServerToolChoice` (:8590, `web_search`,
     `web_search_preview`); `Legacy_WebSearchServerTool` (:17838,
     `type: 'web_search'`); `tool-search.mdx`:150 (hosted tools passed
     through) and :185-194 (aliases, BM25 400).
  2. *Anthropic deny list* (major): taken as allow lists for paths and tool
     types, as above, with tests that `foo_20270101` and `/v1/vaults` are
     refused. Taken differently in one respect: `/v1/messages/batches`
     returns `batch` here rather than being left only to VS-23c (fail
     closed).
  3. *`verify: "api"` bypass* (major): taken. `attestations` lists every
     attestation object that attests a destination, whichever entry won.
     Tested: a host text entry beside a `verify: "api"` provider object
     still lists the object. The admission's duty is stated in the header,
     in `types.ts` and here. Taken differently: "entries that name the
     providerID" is read as entries that attest a destination. A provider
     object covers only its `defaultOrigins`, so it is not listed when the
     base URL moved elsewhere (tested), and a region object is not listed
     off OpenRouter, since neither attests anything there. Not taken:
     refusing `verify: "api"` inside `decideRoute`. That would decide Q20
     and need a refusal outside the addendum's list; it stays the
     admission's, in the runner-wiring window.
  4. *Region reuse of `unattested-openrouter`* (minor): taken, pinned by a
     test; the note wording is a VS-23b item.
  5. *Re-check line on regional hosts* (minor): taken; corrected below.
  6. *extended-cache note wording* (minor): taken as suggested, pinned
     exactly in `format.test.ts`.
  7. *Text beside an object* (minor): taken, generalised to any ID an object
     shares (above), appended after the existing notes, tested.
  8. *IDs that hide the model* (minor): taken. The test uses a
     system-defined profile ARN with the model name (refused), and an
     opaque application-inference-profile ARN and an Azure-style deployment
     `prod` are recorded as not caught. Both are deferred below.
  9. *Region normalisation* (minor): taken (above); the `defaultOrigins`
     requirement is in the doc and here.
  10. *Local base without `privacyOnly`* (minor): taken; the structured
      list from `{ surface: "local", json: { at: "base" } }` is ignored with
      today's exact warning.
  11. *Warnings echo the object* (minor): taken (above).
  12. *De-duplication* (minor): taken: by position in `policy.attested`,
      over the union across verdicts in destination order. Tested with two
      origins attested by one object, and with an OpenRouter account plus a
      hop.
- **Review of the build, point by point** (eleven findings, two of them
  blocking; each is fixed or answered here; nothing is committed).
  1. *Stored file in a custom-content document* (blocking): fixed.
     `contentBlocks` also walks a block's `source.content`, so a
     file-sourced image inside `{ type: "document", source: { type:
     "content", content: [...] } }` (the beta Files API types) is a stored
     file: `anthropic-non-zdr-feature` from `zdrFeatureRefusal` and
     `server-tool` from `zdrBodyRefusal`. Both stored-file tests gained that
     fixture, and an inline-text custom-content document that still passes.
  2. *Vertex and Bedrock paths* (non-blocking): fixed by the allow list
     rather than the doc, so the transport can pass `path` on every
     Anthropic-format route. Added: Vertex `<model>:rawPredict` and
     `:streamRawPredict` under `/publishers/anthropic/models/`, and Bedrock
     `/model/<model>/invoke` and `/invoke-with-response-stream`; Batch
     on them is `batch` (Vertex `batchPredictionJobs`, Bedrock
     `model-invocation-job(s)`). Evidence, the pinned SDKs' `dist`:
     `@ai-sdk/google-vertex` `dist/anthropic/index.mjs`:124 builds
     `${baseURL}/${modelId}:rawPredict` or `:streamRawPredict`;
     `@ai-sdk/amazon-bedrock` 4.0.112 `dist/anthropic/index.mjs`:348 builds
     `/model/${encodeURIComponent(modelId)}/invoke` or
     `/invoke-with-response-stream`, while its default provider sends
     Converse bodies to `/converse` and `/converse-stream`
     (`dist/index.mjs`:1081, :1203). The two Batch paths are recalled from
     the vendors' API references, not fetched in this round; a wrong one
     only changes which refusal a Batch request gets, since every unlisted
     path is refused. Tests pin each shape, and refuse `:predict`, a Google
     publisher, `/converse` and an unencoded ARN. The VS-23c record is under
     Deferred.
  3. *Shared-ID note* (non-blocking): fixed. The notes now say the strictest
     of every entry that attests a route applies, whatever its ID, and the
     field comment, this entry and a test record the limit: without a model
     the config cannot tell that text `api.openai.com` and an `openai`
     object attest the same route, so that pair gets no note.
  4. *Separators in the version table* (non-blocking): fixed. `gpt[-_]?`,
     and a minor after `-` or `_` as well as a dot (with 9).
  5. *Gemini `fileData.fileUri`* (non-blocking): recorded under Deferred
     beside `cachedContent`, and stated in `zdrFeatureRefusal`'s doc.
  6. *`NOT_A_NAME` copy* (non-blocking): fixed. `privacy.ts` exports
     `NOT_A_NAME` and `config.ts` uses it; behaviour is unchanged, and the
     existing text-only config tests still pin it.
  7. *Anthropic features in an OpenRouter body* (blocking): fixed.
     `zdrBodyRefusal` refuses `mcp_servers`, `container`, `thread` and a
     code-callable tool, after `server-tool`. It returns
     `anthropic-non-zdr-feature`, not `server-tool`: the addendum names these
     features under that refusal, its note already describes them, and
     `server-tool` stays OpenRouter's own tools and files. The field list
     (`ANTHROPIC_NON_ZDR_FIELDS`) and the callers check (`codeCallable`) are
     shared with `zdrFeatureRefusal`. The header, the `ROUTE_REFUSALS`
     comment and the `ZdrRequestFormat` comment now agree with this log:
     `zdrBodyRefusal` alone checks a body sent to OpenRouter, and the
     transport need not run `zdrFeatureRefusal` there. A new test covers
     each key (null and an empty list included) and five `allowed_callers`
     shapes; the pin was updated.
  8. *`verify: "api"` allowed by default* (non-blocking): the second option.
     The duty is recorded in VS-23b's plan (Deferred, Admission), and the
     core test that pins such a decision says so. Not taken: an exported
     helper. With no caller, a core test could only show that the helper
     returns the object, which does not pin the wiring's duty, and refusing
     inside `decideRoute` would decide Q20 (critique 3).
  9. *Version-table defaults* (non-blocking): fixed, with one disagreement.
     A dotless run from 10 to 29 is the major version, so `gpt-10` is 10
     and refused, and `gpt-5-5` and `gpt5.5` are caught (with 4). The
     finding's rule as written ("major plus minor only when the first digit
     is below 5") would still read `gpt-10` as 1.0, against its own example,
     and would read a 5x run as 50 to 59. That part is not taken: Venice's
     `openai-gpt-54-pro` is GPT-5.4 Pro (the `gpt5OrNewer` comment in
     `transform.ts`), so reading it as 54 would refuse a real pre-5.5 model,
     and a 6x to 9x run is true either way. Accepted cost: Cerebras-GPT-13B
     reads as 13 (above). Tests cover each spelling.
  10. *`path` optional* (non-blocking): the doc now says the transport must
      pass it for an Anthropic request, and that without it only the body
      is checked. It also says that Google's path, `cachedContent` and
      `fileData` file references are left to VS-23b and VS-23c. `path` is
      not made required: with 2 the transport can pass it on every route,
      and a required type would not stop a caller from passing the wrong
      path.
  11. *`NOT_A_NAME` copy, again* (non-blocking): the same as 6.
- **Plan steps taken differently, besides the critique.** The problem
  strings are predicate phrases (`has an "operator" that is not text`
  rather than `"operator" must be text`), so a note reads "the entry for
  "x" has ...". `extendedCacheOnly` checks every `gpt` occurrence, not the
  first. The file walk uses the same stored-file check for both formats
  (strictest).
- **Scope and pin.** `privacy.ts` changed, so `REVIEW_PIPELINE_SOURCES`
  moves from `54fbad71b62bdbda` to `ff321bd841f716ee` (`b411f7f92e654981`
  before the review fixes below). It was set after `privacy.ts` was final
  (prettier included), and the pin test was re-run.
  `REVIEW_PIPELINE_REVISION` stays 1: no runner reads the file.
  `EVIDENCE_POLICY_KEYS` and `EvidenceScope` are unchanged, since
  `zdrAttested` is a route key: a new `model-evidence.test.ts` case shows an
  attestation-object list leaves `policyDigest` default-stable.
- **Off by default (I-1).** No new `ReviewConfig` key; `zdrAttested` stays
  optional and absent; `DEFAULT_REVIEW_CONFIG`, `parseReviewConfig` (a
  structured `zdrAttested` in review.json is still "unknown key", tested),
  `policyDigest`, `promptsDigest`, `EvidenceScope`, `VARIANT_KEYS` and every
  artifact are byte-identical. `decideRoute`, `zdrBodyRefusal`,
  `zdrRequestBody`, `zdrFeatureRefusal`, `readZdrAttestation`,
  `extendedCacheOnly`, `mergeReviewConfig` and `notePrivacyRefused` have no
  runner caller. `engine:privacy-zdr` stays pending VS-23c. The engine
  (`run.test.ts`) and desktop (`ai-review.test.ts`) D3 parity suites pass
  unchanged. The desktop half follows VS-23d through the same `privacy.ts`
  (§1a); until then it is a documented difference.
- **Owner questions: none decided.** Q1 and the proposed D15: the default
  stays `standard`. Q2: attestation is still the mechanism, now with
  objects. Q7: no eval key setup. Q13: nothing wired. Q16: no global config
  schema. Q18: VS-33 stays a proposal; this is its off-by-default Now part.
  Q20: `verify: "api"` is parsed and surfaced in `attestations`, and nothing
  checks it; refusing it, for OpenAI or until a verifier exists, is the
  admission's. Q21: the refusal plus the `extendedCache` flag. If the answer
  is "refuse gpt-5.5 and later under zdr", the flag is ignored, a
  one-condition change in `decided`.
- **Lane-note re-checks** (vendor pages re-read 2026-11-06):
  - **G4-6** confirmed. `input-output-logging.mdx`:62-64: I/O logging does
    not apply on `eu.openrouter.ai` or `us.openrouter.ai`.
    `in-region-routing.mdx`:24: regional routing is on the Business and
    Enterprise plans.
  - **Corrected** (critique 5), from `server-tools.mdx`:121-136. Global
    only: Files, sandboxed Bash, Shell, Fusion, Image Generation and Web
    Fetch. Web Search runs on US with Exa only. Apply Patch, client-side
    Bash, Advisor, Subagent, Datetime, Tool Search and Search Models run on
    US and EU. The Files API returns 403 on regional hosts
    (`files-api.mdx`:35-37). Advisor and Subagent inner generations receive
    the request's `provider` preferences, `zdr` included (:129-130), while
    Fusion's do not (:131, G4-4 confirmed). Refusing every server tool is
    the addendum's conservative choice, even though Advisor and Subagent
    inherit `zdr`.
  - **G5-7** confirmed on Anthropic's page: structured outputs cache only
    the JSON schema, for up to 24 hours since last use. It is for VS-47 and
    not built here.
  - **VOI7** is not used.
- **Deferred** (runner-wiring window or later):
  - **Transport normalisation (VS-23c):** `X-OpenRouter-Cache: false` and
    refusing `true`; `store: false` on OpenAI-family requests, Azure and
    Mantle included; `prompt_cache_retention: "in_memory"` with `ttl`
    stripped before gpt-5.5, with the SDK pin test; `@ai-sdk/google`
    `store: false`; re-asserting `provider.zdr` and `data_collection` after
    merges [VOI1].
  - **Admission (VS-23b, Q20):** the `verify: "api"` metadata calls
    (Bedrock `GetAccountDataRetention`, Vertex `getCacheConfig` and
    `fetchPublisherModelConfig`), the OpenAI `verify: "api"` refusal, and
    `durable-cache`'s producer. `decideRoute` allows a route that only a
    `verify: "api"` object attests and lists it in `attestations`, so one
    forgotten check at wiring would make that entry attest-only. VS-23b's
    plan must therefore include an admission test with a route covered only
    by a `verify: "api"` entry (core's Bedrock case in "the decision lists
    every attestation...", whose comment says so), and that test must expect
    a refusal until a verifier exists.
  - **Schema (VS-23d):** the engine global config schema, the SDK build and
    `bun run generate`.
  - **Transport format choice (VS-23c):** choosing the request format,
    and Google request paths (`cachedContents`, files, batch), which
    `zdrFeatureRefusal` does not check. OpenRouter's `/api/v1/messages`
    needs no `zdrFeatureRefusal` call any more: `zdrBodyRefusal`, that
    route's only body check, now refuses the same Anthropic fields. The
    transport must pass `path` for every Anthropic-format request, Vertex's
    and Bedrock's included, which the allow list now takes (review fix 2);
    Bedrock's own Converse format (`/converse`, the default
    `@ai-sdk/amazon-bedrock` provider) is not an Anthropic body, and its
    check is VS-23c's to choose.
  - Re-checking the body's `model` against the extended-cache attestation.
  - The settings-level `models` case [VOI1].
  - Notes naming the operator, the region-mismatch note wording, and
    `EvidenceScope` route qualifiers (I-12), with VS-23b.
  - G4-8: 404 or 503 text chooses only note wording.
  - Bedrock and Google-managed Claude needing a cloud-account attestation
    (VS-23 §3): not enforced, because text entries must keep working.
  - Model IDs that hide the model: an opaque Bedrock application inference
    profile (no Covered Model check) and an Azure deployment name (no
    extended-cache check). Both need admission metadata (VS-23b and VS-23c,
    Q20).
  - Gemini explicit `cachedContent` as a possible `durable-cache` producer,
    considered and not built. Beside it, a Gemini body that refers to a
    stored Files API upload (`contents[].parts[].fileData.fileUri` on
    `generativelanguage.googleapis.com/.../files/...`, kept 48 hours) passes
    `zdrFeatureRefusal`, which checks only Google tools. VS-23c, or a later
    refusal update, decides both explicitly; the function's doc says so.
  - The `smallOptions` `store: false` engine fix, outside this contract.
  - The Codium gateway (later).
- **Deferred verification.** Wire-level checks, and Done-when's count of 0
  bodies under `engine:privacy-zdr`, run on VS-21b's fake server after
  VS-23c. Vendor field shapes come from docs only; no live API call was
  made.
- **Evidence.** Vendor sources re-read, each in its own empty folder under
  `/tmp/vector-vectorscope/vs33a-vendor/`:
  - OpenRouterTeam/docs cloned at `f1ededbc` (`.source-commit` `c793667a`),
    the same commit planning used;
  - openai/openai-openapi at `9752a7f1`: `prompt_cache_retention` says "For
    `gpt-5.5`, `gpt-5.5-pro`, and future models, only `24h` is supported";
  - platform.claude.com "API and data retention" (the feature eligibility
    table), the server tools page ("ZDR and allowed_callers") and the tool
    reference (every tool type), all fetched 2026-11-06.

  Each test file was run alone through the lock with `--timeout 30000`,
  `GITHUB_ACTIONS=false`, and `TMPDIR` and XDG roots under
  `/tmp/vector-vectorscope/vs33a/`:

  | Where | File | Pass |
  |---|---|---|
  | core | `test/review/privacy.test.ts` | 48 (24 before; 47 before the review fixes) |
  | core | `test/review/config.test.ts` | 34 (31 before; one case extended in the review fixes) |
  | core | `test/review/format.test.ts` | 46 (one assertion added) |
  | core | `test/review/model-evidence.test.ts` | 17 (one case added; pin re-run) |
  | engine | `test/review/eval.test.ts`, `test/review/run.test.ts` | 26, 44 |
  | app | `src/browser-bundle.test.ts`, `src/features/pull-requests/ai-review.test.ts` | 4, 107 |
  | eval scripts | `replay.test.ts` | 32 |

  - `bun typecheck` in core, engine, app and desktop, and
    `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json` from
    `packages/engine`, exit 0.
  - `prettier --check` passes on the ten changed TypeScript files. `oxlint`
    on the changed core files reports only warnings the code had before
    (the `record` cast, `config.ts`'s assertions, two `format.ts` lines not
    touched, the test's existing `as unknown as` cast).
  - A mutation check, in one run, disabled the region pin and the
    extended-cache rule and moved the 20260209 date, then restored the file
    byte for byte. Exactly the three matching tests failed. In the review
    round, a second check removed the `source.content` walk and
    `zdrBodyRefusal`'s Anthropic-fields check: exactly the three matching
    tests failed, and the file was restored byte for byte.
  - Review fixes re-run, each file alone through the lock, with `TMPDIR`
    and XDG roots under `/tmp/vector-vectorscope/vs33a-fix/`: core
    `privacy.test.ts` 48, `config.test.ts` 34, `format.test.ts` 46,
    `model-evidence.test.ts` 17 (pin re-run), app `browser-bundle.test.ts`
    4; `bun typecheck` in core, app, engine and desktop; `prettier --check`
    on the changed files; `oxlint` on `privacy.ts` and `config.ts` shows
    only the earlier warnings.
  - The full root typecheck was not run: nothing is pushed.
  - Nothing was sent to a model, no paid path ran, no workflow was
    dispatched, no dependency was added, and no existing user-visible
    string changed (D14).

## 2026-11-06 · VS-34a Pure secret holdback

Addendum A §2 VS-34, the Now part of §4: a pure core
`review/holdback.ts` (`holdbackFiles` with its own result type), one
additive `BrainScan` reading, two exported permission lists, the pipeline
pin, tests and this entry. Built at `9be2e8b3`. VS-34 is a proposal pending
Q18, so everything is off by default and nothing calls it. No `ReviewConfig`
key, config, prompt, runner or eval-script change. `run.ts`, `ai-review.ts`,
`provider.ts`, `session/llm.ts`, `posting.ts`, `workflow.ts`, `command.ts`,
`github.*`, `github-*.ts` and `vectorscope.astro` are untouched. It implements
the VS-34a plan as corrected by its critique. Every critique point was
taken, three in a different form (below). A review round followed; its
fixes are folded in below and listed under **Review round**. Nothing is
committed.

- **What landed.**
  - **New core `review/holdback.ts`** (pinned). `holdbackFiles(files,
    { headFiles?, ignored, env?, reading? })` returns `{ files, headFiles?, held,
    redactions, ignoredCommitted }`, with `HeldFile { path, oldPath?,
    status, reason }` and `HoldbackRedaction { path, diff, head }`.
    `reason` is `secret-file`, `env-file` or `credential-file`.
    - The header says it is pure (`env` defaults to `{}`, no git call),
      browser-safe in its imports, and uncalled.
    - It also says that only prompt rendering may use its output (critique
      9).
  - **Core `brain/scan.ts`**:
    - adds `Reading.shapes`, with its doc;
    - adds `KEY_LAST`, `AWS_IDS` and `byLine`;
    - adds four branches in `scrub` and one in `secrets`, each under
      `reading.shapes` (below).

    With `shapes` unset every existing reading is unchanged (tested).
  - **Core `review/permission.ts`**:
    - `SECRET_FILES` is exported, its literal unchanged;
    - the read tool's two env patterns become the exported `ENV_FILES`
      (`["*.env", "*.env.*"]`), which `reviewPermissionRules` spreads in
      their old place;
    - both lists are `as const`, so no importer can change them.

    The rules it returns are byte-identical, pinned by a literal copy.
  - **Core `model-evidence.ts`**: the pin only.
- **Rule decisions (hold back by path).**
  - **Order:**
    1. `SECRET_FILES` (`secret-file`), so `.aws/credentials` is a secret
       file;
    2. then the env rule (`env-file`);
    3. then the credential list (`credential-file`).

    The new path is judged, then `oldPath`. That covers deletions, renames
    away from a sensitive name and renames to one. A copy has no `oldPath`,
    so it is judged on its new path, and value redaction still applies to
    it (tested with a copy of `id_rsa`).
  - **Matching** is the read tool's `Wildcard.match` on the lowercased
    path, because every pattern is lowercase (critique 8):
    - the result is the same on every platform, and stricter than the
      read tool, which is case-sensitive on Linux and macOS;
    - `.ENV`, `ID_RSA`, `Server.PEM` and `Credentials` are held (tested).
  - **Env files** (critique 2):
    - the read tool's `ENV_FILES`, so `prod.env`, `deploy/app.env` and
      `config/production.env.local` are held;
    - except templates by final suffix (`.example`, `.sample`,
      `.template`, `.dist`, `.defaults`): `.env.local.example` is sent,
      `.env.example.bak` is held;
    - and except a `*.env.*` whose final extension is a source extension
      (`ignore.ts` `isCodePath`, reused), unless it is a dotfile `.env.*`
      or a shell or SQL script (`sh`, `bash`, `zsh`, `ps1`, `sql`, which
      `CODE_EXTENSIONS` counts as source but which set values). So
      `src/config.env.ts` and `src/vite.env.d.ts` are sent, while
      `.env.ts`, `docker/app.env.json`, `deploy/prod.env.sh`,
      `secrets.env.ps1`, `staging.env.bash`, `scripts/dev.env.zsh` and
      `db/seed.env.sql` are held.
    - A head file whose own path would be held is dropped too, whether or
      not a changed file has it (`Review.run` builds head files from the
      changed files today, so this is defensive).
  - **Credential list:**
    - the addendum's basenames, each in a root and a `*/` form, plus
      `*.ppk`, `*.pfx`, `*.jks` and `*.keystore`;
    - plus `id_ecdsa_sk` and `id_ed25519_sk`, OpenSSH's default private
      key names for security keys. That is the one widening, recorded here
      (critique 11).
    - `id_*` is not taken. It would hold every `id_`-prefixed source file
      and the public keys `id_rsa.pub`.
  - **`ignoredCommitted`**:
    - non-deleted changed paths found exactly in `ignored`, in file order;
    - held files are included, deletions excluded, and nothing is dropped.
  - **Naming and counts:**
    - the addendum's `headText` is `headFiles`, as in `RunInput` and
      `PromptInput`;
    - `env` is optional, defaults to `{}`, and is never `process.env`;
    - `reading` is optional and defaults to `{ shapes: true }`. Nothing
      passes it and no key sets it. It exists only so that the
      measurement window can run the generic reading (`{ code: true }`)
      through the same function. A test shows the generic reading
      redacting `DB_PASSWORD=S3cretPassw0rdXY`, which the shapes tier
      sends;
    - `redactions` counts the placeholders added per path, split into
      `diff` (hunk headers and line texts) and `head`. The patch is not
      counted, so no value is counted twice;
    - `HeldFile.status` is added (critique 11) so that VS-32 and VS-27
      need no rejoin.
- **Value redaction (in place).**
  - **One text per path** (critique 3, in a stronger form).
    - **Exact head file.** When the head file is exact, not annotated, and
      the diff's post-image (`matchPostImage`), the text read is its lines
      with the diff's removed lines put back where they were (as
      `renderAnnotated` places them), then the hunk headers' sections.
      - A removed or added line of a key's body is then read inside its
        block.
      - A line the diff and the head file share is redacted once. They
        still match, so `packChanges` still annotates the head file
        (`pack.ts:63`; asserted with `matchPostImage` after holdback).
    - **Otherwise** the text is:
      - the hunks;
      - then a hunks-only head file's own hunks (parsed);
      - or the head file's lines, when it is annotated or does not match.
    - One `BrainScan.named(text, env, { shapes: true })` pass covers the
      whole text. No value list is substituted. Substituting through
      `redactSecrets` skips values under 12 characters (short passwords, a
      key's short last line), and a per-line pass cannot see a key's
      header (critique 1).
  - **`patch`, and a hunks-only head file's text** (critique 5, the
    "better still" form). Each line a hunk accounts for is written from
    the redacted hunk line at the same position:
    - the line is checked against the original, and its prefix and any
      `\r` are kept;
    - `\ No newline at end of file` passes;
    - a line no hunk counts (a file header) is read on its own.

    A re-parse equals the redacted hunks, and a hunks-only head file equals
    `renderPatch` of the redacted file (both tested).
  - **The `shapes` reading** reads only what a value's shape gives away:
    - a private key's body;
    - an address's password;
    - redact.ts's `TOKEN_SHAPES` (through `redactSecrets`, so they are
      reused, not copied) and `SECRET_SHAPES`;
    - the environment's values;
    - AWS key IDs and the secret beside them.

    It does not apply the generic rules that read names or words around a
    value, `credential`, or OPAQUE (the kill criterion, below). Only the
    value is replaced:
    - **address**: the password only. `postgres://app:[redacted]@db:5432/app",
      x = 1` keeps its quote and the code after it, for a long and a short
      password. That fixes critique 1's `hide(match)` destruction. A second
      reading changes nothing (tested), so the critique's `[redacted]`
      exemption is not needed.
    - **key**: every body line, its markers kept. `KEY_LAST` also takes
      the short last line before END (critique 7), but not the `+` that
      joins lines in code.
    - **AWS**: a 40-character run of pure hex beside a key ID is skipped,
      as `opaque` does. A bare `ASIA` ID is redacted (critique 6).
      `TOKEN_SHAPES` is unchanged, so posted-text redaction is too.
    - **line breaks**: a value that spans one (a multi-line env value) is
      replaced a line at a time (`byLine`), so line counts never change.
    - **Bearer/Basic across a line break**: found while building. The
      existing `\s+` lets a "// Basic" comment take a long identifier on
      the next line, so under `shapes` a shape match that spans a line
      break is kept.

    The default reading of all of these is unchanged and asserted.
  - **Speed.** A draft `KEY_LAST` was quadratic under V8: Node 22 took
    40 s on 40 KB of spaces, while Bun stayed linear. The final form uses
    an unambiguous run and atomic marks, as `PRIVATE_KEY` does, and takes
    1 to 6 ms on 48 KB cases in a Node bundle of the real `scan.ts`. The
    existing performance test now also runs the `shapes` reading.
- **Value-redaction tier: the kill criterion applied at the start.**
  - **What was measured.** A local proxy survey on this repository's own
    2009 non-test, non-generated files under
    `packages/{core,engine,app,web,desktop,sdk}`. It is not an eval: no
    model, no dataset, and no VS-22 case.
  - **The addendum's literal reading.** `BrainScan.secrets` values (read as
    code) through `redactSecrets`, re-run here:
    - it changed 146 files (7.3%);
    - with a per-line `BrainScan.named` added, 223 (11.1%);
    - the plan measured 99 (4.9%) without OPAQUE (not re-run).

    It also rewrites code the security pass must read
    (`if (password === confirm)`, `const token = await getToken()`,
    checksums, UUIDs, SRI hashes, public keys). That breaks the addendum's
    2% rule, so only the shape tier was built.
  - **The built module** (`/tmp/vector-vectorscope/vs34a/survey.ts`, not
    committed): each file is sent as a new file with its exact head file.
    - It changed 9 files (0.45%), held none, and changed no line count.
    - All 9 are secret-shaped placeholders: synthetic `vct_` tokens, a
      `postgresql://user:pass@` placeholder and an address in a comment.
    - Bun took 3.2 s; a Node bundle took 1.4 s, and its slowest file, a
      one-line 5 MB JSON, took 125 ms.
  - **What stays open.** The generic reading stays measurable through
    `holdbackFiles` itself (the `reading` input), because `BrainScan`
    without `shapes` is unchanged. The contract's stated measurement for
    the kill criterion has not run: this proxy is not it.
    - Before runner-wiring adopts a tier, the measurement window must
      compare the generic tier with the shapes tier on VS-22 cases and
      apply the 2% threshold there.
    - Choosing the tier from this proxy decides no owner question. It is
      raised for owner visibility next to Q23, because requiring
      `holdback: secrets` under zdr would make the tier's residual (the
      plaintext passwords below) a zdr property.
- **Known gaps** (kept so that I-1 holds, or out of the Now window):
  - **Plaintext assigned passwords** in files on no list
    (`docker-compose.yml` `POSTGRES_PASSWORD: hunter2`, `config.yml`)
    reach the model. The shape tier gives a plaintext password away only
    inside an address (critique 10).
  - **No exact post-image head file.** This covers no head files, the
    engine's hunks-only head file for files over 40 KB, and a stale head.
    In those cases:
    - an AWS secret whose key ID is in neither the hunks nor the head file
      is kept;
    - so are key body lines whose header lies outside the hunk context,
      because OPAQUE is dropped.

    Pinned by a test. With an exact head file both are redacted (tested).
  - **Key body.** A short body line that is not the last (no PEM encoder
    writes one) and the last line of a key without an END line are kept
    unless they have 16 or more characters.
  - **Addresses.** Of two addresses joined without a space
    (`a://u:p@h,b://v:q@k`), only the first password is redacted:
    `CREDENTIALED`'s rest takes `\S+` (unchanged rule).
  - **Bearer/Basic.** A token on the line after "Bearer" or "Basic" is not
    redacted under `shapes` (the trade above).
  - **Backups and other `id_` names.** `id_rsa.bak`, `id_rsa.old`,
    `id_xmss` and other `id_*` names are sent (pinned by a test).
  - **Binary key files.** `.p12`, `.pfx`, `.jks` and `.keystore` are
    classified binary and skipped before `RunInput.files` today
    (`ignore.ts:65-72,208`). The holdback rule is a backstop.
  - **Differences from the read tool.** It denies `src/config.env.ts` and
    `.env.local.example`; holdback sends them value-redacted. Shell and
    SQL `*.env.*` scripts are held, as the read tool denies them.
  - **AWS secret beside a key ID: a known false positive** (pinned by a
    test). In a path whose text holds an `AKIA` or `ASIA` ID anywhere,
    every 40-character run of `[A-Za-z0-9/+]` that is not pure hex is
    replaced, so `name=thisIsAVeryLongIdentifierNameForTesting1` becomes
    `name=[redacted]` twenty lines away. Left as it is (the review's
    alternative), for three reasons:
    - the proximity rule would fail open: when the head file is stale,
      annotated or hunks only, the hunks and the head file are read one
      after the other, so a hunk's secret line is far from the head
      file's key ID in the joined text and would be sent;
    - the content rule (a digit and both letter cases, or a `/`) does not
      exclude the pinned identifier, which has all three;
    - the kill metric counts files with at least one redaction that holds
      no real secret. A file with a key ID already carries one (the ID),
      so the extra placeholders do not move it; they cost only the
      readability of such files.

    The measurement window can revisit it on VS-22.
  - **Desktop renderer.** `Wildcard.match` reads `process.platform` at call
    time, which a sandboxed renderer lacks. With lowercasing the result no
    longer depends on the platform, but the read remains, so the desktop
    half must provide it or record a difference.
- **Critique of the plan, point by point.**
  1. *Per-line `named` destroys addresses* (major): taken differently.
     There is no per-line pass. The single positional pass replaces only
     the password whether or not `found` is passed, and exact-text
     assertions cover the long and short forms in both test files.
  2. *Env files the read tool denies* (major): taken, as above, with the
     narrow `*.env.*` form and the decision recorded.
  3. *One value set per path* (major): taken as one text per path (above),
     which also keeps `matchPostImage` true. Fixtures cover a hunk that
     changes only the AWS secret line with the key ID only in the head
     file, and a middle-body PEM edit whose header is only in the head
     file; the no-head gap is pinned.
  4. *Test C pins nothing* (major): taken. A literal ten-pattern list
     inside the full read deny list, plus deep-equality of both exports.
  5. *Patch redaction* (minor): taken in the "better still" form, with a
     `\ No newline` fixture and the re-parse assertion.
  6. *AWS hex and ASIA* (minor): taken both, with a holdback fixture (key
     ID, commit, `ASIA`) and scan regressions without `shapes`.
  7. *Short PEM last line* (minor): taken (`KEY_LAST`). Fixtures use a
     realistic short last line (`QmF6PQ==`, `AAAAEw==`).
  8. *Case* (minor): taken (lowercase, case fixtures).
  9. *Where the redacted copy may flow* (minor): taken (header comment,
     Deferred).
  10. *State the tier's basis and the plaintext residual* (minor): taken
      (above).
  11. *`id_*` and `status`* (minor): `status` taken. The two `_sk` names
      are added with the reason above. Taken differently: `id_*` is not
      taken; the gap is logged and pinned.
- **Plan steps taken differently, besides the critique:**
  - `holdback.ts` imports `REDACTED` only from `redact.ts` (for counts);
    the token shapes reach it through `BrainScan`;
  - `permission.ts` also exports `ENV_FILES`;
  - `isCodePath` comes from `ignore.ts`;
  - the plan's private `ENV_FILES` and `SHAPES`-plus-values redactor are
    replaced as above.
- **Scope and pin.**
  - `holdback.ts` joins `REVIEW_PIPELINE_FILES` after `privacy.ts`, with
    the comment extended. `REVIEW_PIPELINE_SOURCES` moves from
    `ff321bd841f716ee` to `7addfcd0033ba579` (`552618178a9627b2` before
    the review round). It was set after
    `holdback.ts` was final (prettier included), and the pin test was
    re-run.
  - `scan.ts`, `redact.ts` and `permission.ts` are not pinned, as before.
  - `REVIEW_PIPELINE_REVISION` stays 1: nothing calls the file.
  - There is no new key, so `EVIDENCE_POLICY_KEYS`, `EvidenceScope`,
    `policyDigest` and `promptsDigest` are unchanged.
- **Off by default (I-1).**
  - `holdbackFiles` has no caller. `reviewPermissionRules`' output is
    byte-identical, and every `BrainScan` reading without `shapes` is
    unchanged.
  - The engine grep and structured-output review tests and the desktop
    D3 parity suite (`ai-review.test.ts`) pass unchanged.
- **Owner questions: none decided.** Q1, Q13, Q16, Q18 and Q23 stay open.
  The tier choice above is a Now-window build decision. The measurement
  window can revisit it on VS-22.
- **Deferred to runner-wiring (Q13) or later** (citations at `9be2e8b3`):
  - **The `holdback: off | secrets` key:**
    - `ReviewConfig`;
    - the raise-only `config.ts` merge and `REVIEW_HOLDBACK`;
    - the hidden global engine config field, with SDK and client
      regeneration;
    - the `EVIDENCE_POLICY_KEYS` entry with a default-stable digest.
  - **The call.** The `Review.run` call goes before prompt building
    (`run.ts:655-686`, `packChanges` at 655). Only prompt rendering
    (`packChanges` inputs, so the inline diff and the head files) may use
    the output. Skips, review state and fingerprints, anchors
    (`buildAnchorIndex`, `anchorText`), `suggestionAllowed`, `applyPatch`,
    `patchIdOf` and `RunInput.anchors` keep the unredacted files.
  - **Value redaction of the other untrusted blocks:** `context.related`,
    history, human comments, PR title and body, and the impact slice.
  - **Tool rules.** Read deny rules for the credential list (export it
    then). The grep-output backstop works by path. There is no path rule
    for grep, because its permission pattern is the search regex
    (`grep.ts:42-43`); its per-file read check is at `grep.ts:94-109`.
  - **The ignored list:** `git check-ignore --no-index`.
  - **The `held-back` reason.**
    - It is a new `SkippedFile` reason (`types.ts:157`), with labels in
      `format.ts:62`, `review.render.ts:44` and `ai-review.ts:147`.
    - It stays out of `state.unreviewed` (`types.ts:147`; `skip.ts:66-67`).
    - The zero-token note is part of this item.
  - **The input-redaction prompt sentence** goes beside `prompt.ts:125`,
    entering `promptsDigest` only under the key.
  - **Variant and parity:**
    - the `engine:holdback-secrets` variant;
    - projection wire-body fixtures (read and grep on a held path, and a
      token in a non-listed file);
    - D3 parity tests;
    - the desktop half (`ai-review.ts`, and the `process.platform` read)
      or a documented difference.
  - **Measurement:** the false-positive measurement on VS-22 cases (2%
    threshold) and the defect-location check. It must compare the generic
    tier with the shapes tier (both through `holdbackFiles`, by its
    `reading` input) before runner-wiring adopts either; raised for owner
    visibility next to Q23.
- **Deferred verification:**
  - Windows path handling: none expected after lowercasing;
  - the renderer's runtime behaviour of `Wildcard`;
  - wire-body assertions through VS-21b;
  - false positives on VS-22 and on repositories with real committed
    secrets;
  - whether any VS-22 bug case loses its defect location.
- **Evidence.** Each file ran alone through the lock with `--timeout 30000`,
  `GITHUB_ACTIONS=false`, and `TMPDIR` and XDG roots under
  `/tmp/vector-vectorscope/vs34a/`:

  | Where | File | Pass |
  |---|---|---|
  | core | `test/review/holdback.test.ts` | 16 (new) |
  | core | `test/brain/scan.test.ts` | 20 (one added, one extended) |
  | core | `test/review/permission.test.ts` | 10 (one added) |
  | core | `test/review/model-evidence.test.ts` | 17 (pin re-run) |
  | core | `test/review/redact.test.ts`, `test/brain/knowledge-scan.test.ts`, `test/brain/document-security.test.ts` | 6, 6, 10 |
  | engine | `test/tool/grep.test.ts`, `test/review/structured-output-review.test.ts` | 19, 3 |
  | app | `src/features/pull-requests/ai-review.test.ts` | 107 |

  - `bun typecheck` passes in core, engine, app and desktop, and prettier
    passes on the changed files.
  - `oxlint` adds no warning to `holdback.ts` or `scan.ts`. Its new test
    warnings are the deliberate runtime assembly of token-like literals
    (`no-useless-concat`, `no-unnecessary-template-expression`), as the
    existing scan tests do.
  - **Mutation check.** Fourteen mutations each broke at least one test,
    and each file was restored byte for byte:
    - the address rest, `KEY_LAST` and its letter rule, the hex skip and
      `ASIA`;
    - the splice, lowercasing, the dotfile and source-file env rules and
      the old-path check;
    - the line-break rule, `byLine`, the patch rewrite and a
      `SECRET_FILES` edit.

    One more (the `*.env` term of a draft env rule) broke nothing; the
    term was redundant and was removed. The review round added four, each
    of which broke a test and was restored byte for byte: the per-line
    list copy in `removedBefore` (the speed test took 20.5 s), the shell
    and SQL env term, the head file's own-path filter, and `.` in
    `byLine`.
  - The full root typecheck was not run: nothing is pushed.
- **Review round** (eleven findings, one blocking, two pairs
  overlapping; all fixed but one, left with the reason above):
  1. *Quadratic `removedBefore`* (blocking): fixed. Each list grows in
     place. 80 000 removed lines beside an exact one-line head file took
     12.3 s and take 135 ms (124 ms without the head file). A new test
     runs 100 000 removed lines and asserts under 1 s, as `scan.test.ts`
     does.
  2. *Shell and SQL `*.env.*` scripts sent* (two findings): fixed by
     `ENV_SCRIPTS` (above). The five names are held cases in the test.
  3. *A head file held by its own path*: fixed (above), with a test.
  4. *Item 3's measurement has not run*: recorded under **What stays
     open** and **Deferred**, and raised next to Q23.
  5. *AWS secret over-redaction*: not changed; logged as a known false
     positive with its reasons and pinned by a test (above).
  6. *Missing fixtures* (two findings): added `infra/.aws/config`,
     `home/.aws/credentials`, `vendor/x/.git/config`,
     `vendor/lib/.git/config` and `certs/tls.key` to the held cases, and
     `gho_`, `ghu_`, `ghs_` and `ghr_` lines to the token-shape fixture.
  7. *Style*: `removedBefore` is a reduce over hunks; `pieces` and
     `redactions` are inlined; the redactor is passed as one `read`
     function instead of `env`; `rewriteDiff` keeps its cursor, with a
     comment saying why (one walk, each line compared only with the next
     one the hunks expect).
  8. *`byLine` and lone line separators* (`scan.ts`): fixed. It matches
     `[^\n]*` in place of `.`, so a lone `\r`, U+2028 or U+2029 inside an
     environment value no longer leaves the value's tail. The shapes test
     in `scan.test.ts` covers all three. Only the `shapes` reading uses
     `byLine`.
  9. *The tier fixed in code*: fixed by the optional `reading` input
     (above), with a test.
  - Nothing was sent to a model, no paid path ran, no workflow was
    dispatched, no dependency was added, and no user-visible string
    changed (D14).

## 2026-11-06 · VS-32a Fail-closed review verdict (pure)

Addendum A §2 VS-32, the Now part of §4: `reviewVerdict` only, with its
result type, tests and this entry. Built at `376a52ad`. VS-32 is a proposal
pending Q18, so nothing calls it and no key exists for it: `failOn` stays
`"never" | "blocking"`. No `ReviewConfig`, config parse, prompt, state,
format, runner or eval-script change. `run.ts`, `ai-review.ts`,
`provider.ts`, `session/llm.ts`, `posting.ts`, `state.ts`, `types.ts`,
`workflow.ts`, `command.ts`, `github.*`, `github-*.ts` and
`vectorscope.astro` are untouched. It implements the VS-32a plan as
corrected by its critique. All nine critique points were taken, two of
them (2 and 4) in a different form (below), and so were the six review
findings that followed, one of them in a different form (Review
findings, below). Nothing is committed.

- **What landed.**
  - **New core `review/verdict.ts`** (not pinned; see Evidence scope).
    Its imports are types only (`HeldFile`, `SkipReason`, `ReviewOutcome`,
    `Severity`, `SkippedFile`), so it is browser-safe and loads nothing at
    runtime.
    - `REVIEW_VERDICTS` (`not-reviewed`, `policy-skip`, `incomplete`,
      `blocking`, `findings`, `clean-complete`, in the order they are
      tested) and `ReviewVerdict`.
    - `reviewVerdict(input: VerdictInput): VerdictResult`, where
      `VerdictInput` is a `kind`-tagged union: `outcome`, `skip` or
      `failure`. The result is `{ verdict, causes, notes }`, with fresh
      arrays on every call.
    - `VerdictOutcome`: the parts of a `ReviewOutcome` it reads. A
      `ReviewOutcome` is assignable as it is (the test passes full
      outcomes).
    - `VerdictSkip`, `StoredSkip`, `VerdictFailure`, `VerdictCause`,
      `VerdictNote` and `VerdictList`.
  - **New core `test/review/verdict.test.ts`**, and one new test in
    `test/review/config.test.ts`.
- **The rules, first match wins.**
  1. **Failures.** `config` (a model or triage model that cannot start,
     GitHub 401, 403 or 404, both checkout-mismatch `configError` exits,
     the command-level setup failures) and `start` (GitHub or git failed
     before the review started) give `not-reviewed`. `review` (a model or
     tool failure caught inside the job) gives `incomplete`, as the
     addendum's "a thrown review error" says. A stage the module does not
     name gives `not-reviewed` with cause `failure-unknown`.
  2. **Skips.** An exhaustive private table, so a new `SkipReason` fails
     typecheck in `verdict.ts` until it is classified:
     - `not-reviewed`: month-budget, pr-budget, too-large, and
       spend-unreadable (the month spend could not be read while a month
       cap is set);
     - `policy-skip`: label, draft, author, branch, fork,
       nothing-to-review, and VS-24's `trivial` (addendum §3);
     - a reason the table does not name gives `not-reviewed` with cause
       `skip-unknown`.
  3. **Stored skips.**
     - `already-reviewed` carries the stored verdict for the same head
       (decideSkip only gives it when `state.head` is the head).
     - When either stored skip hands on `not-reviewed` or `incomplete`,
       it adds the `review-full` note: decideSkip keeps skipping that
       head, so without the note a verify pass stopped for time would
       leave the check red on every later push with nothing saying how to
       finish it. A handed-on `blocking` needs a fix, not another review,
       so it has no note.
     - A `carry` hands on a stored failing verdict (`not-reviewed`,
       `incomplete`, `blocking`), so a carried `incomplete` stays
       `incomplete`. It never hands on a passing one, which belongs to the
       pre-rebase head: that gives `not-reviewed` with the `review-full`
       note.
     - With no stored verdict, or a stored value outside
       `REVIEW_VERDICTS`, either gives `not-reviewed`, with causes
       `[reason, "no-stored-verdict"]` and the `review-full` note.
  4. **Outcomes.**
     - **Note.** `held-back-deletion` when a held file's status is
       `deleted`, kept on every tier.
     - **The zero-attempt stops.** A `privacy` or `budget-estimate`
       partial gives `not-reviewed`, whatever else the outcome holds.
     - **Unfinished**, every cause in this fixed order: any other
       `partial`; `unreviewed`; a skipped file whose reason leaves the
       review unfinished (`size-limit`); `skipped-unknown`, once, for any
       skipped-file reason the table does not name; `held-back` (a held
       file not deleted); `strict-incomplete` (`complete` anything but
       exactly `true`); `specialist` (any status other than `ok`);
       `no-reviewer` (no `review` or `security` entry).
     - **VS-24's trivial outcome.** With `trivial` exactly `true`, no
       specialist entry and no unfinished cause but `no-reviewer`, the
       marker stands in for the missing reviewer and nothing else. With
       nothing listed the verdict is `policy-skip` with cause `trivial`.
       What it lists (an earlier finding still open) is read as on any
       other outcome, so a still-open blocking finding gives `blocking`
       and a still-open concern gives `findings`.
     - Otherwise any unfinished cause gives `incomplete` with all of
       them. Then a blocking finding in inline, overflow, outsideDiff,
       elsewhere, nits or stillOpen gives `blocking` (so does a severity
       other than `concern` or `nit`), any listed finding gives
       `findings`, and nothing gives `clean-complete`.
- **Critique points.**
  1. *Skipped-file reasons fail open* (major): taken. `verdict.ts` holds
     an exhaustive `Record<SkippedFile["reason"], VerdictCause | null>`,
     so VS-34 wiring's `held-back` reason fails typecheck there until it
     is classified. The test keeps its own typed table, and a mutation
     mapping size-limit to complete breaks it.
  2. *VS-24's trivial outcome would read as incomplete* (major): taken in
     a stricter form. `VerdictOutcome.trivial?: true` is reserved beside
     `strict` and `held`. It is read after the privacy and budget-estimate
     stops and before the unfinished tier, as the critique asks, but it
     excuses only the missing reviewer, and only on an outcome with no
     specialist entry. A marker beside a partial value, unreviewed files,
     a held change or an incomplete strict result, or on a run whose
     passes ran, does not describe the outcome, so the outcome is read
     instead. Corrected in review (finding 5, below): this entry first
     said that kept the marker from hiding a blocking run, but the first
     version returned `policy-skip` before reading the lists, so a
     trivial outcome with a still-open blocking finding passed. The lists
     are now read as on any outcome. Tested: trivial alone is
     `policy-skip`; trivial with privacy is `not-reviewed`; no marker
     with no specialists is `incomplete`; trivial with a still-open
     blocking finding is `blocking` and with a still-open concern
     `findings`; and each contradictory case.
  3. *`other-command` and `no-write-access` as passing values* (major):
     taken. Both are removed from `VerdictSkip`. Neither run reviews the
     head: the job leaves at `github.review.ts:253-261` before reading the
     change, and a passing head-bound verdict from an untrusted commenter
     would fail open. A test pins with `@ts-expect-error` that neither
     reason is accepted, so adding one is a reviewed decision.
  4. *Carry across a rebase* (minor): taken (above), combining the two
     forms the critique offers: a failing verdict carries with cause
     `carry`, and a passing one gives `not-reviewed` with `review-full`.
     It is the conservative choice, not a settled one. Whether a passing
     verdict may carry across a rebase is open for the wiring and the
     owner (Q18). Tested, including a carried `incomplete`.
     - **Expected effect on dogfood red rates.** The addendum says
       nothing about carries. The job carries only when history was
       rewritten and every file's patch is unchanged (`source.ts:226-235`,
       taken at `github.review.ts:511-515`); a rebase that changes a
       patch is reviewed incrementally instead. Under the gate, every such
       carry of a PR whose stored verdict passes (`clean-complete`,
       `findings`, `policy-skip`) turns its check red with cause `carry`
       until `/vector review full` runs, although nothing it reviewed
       changed. So `carry` should appear in red PRs by cause roughly as
       often as passing PRs are rebased onto a moved base without
       conflicts, and on a team that rebases to update it can feed the
       red-PR kill criterion by itself. The dogfood report must count
       `carry` reds separately so the owner sees that cost apart from
       real unfinished reviews.
     - **What a Q18 answer changes.** The rule is one branch in
       `storedVerdict` (`reason === "carry" && !FAILING[stored]`). An
       answer that a passing verdict may carry when the patch is
       unchanged flips that branch alone, before the wiring, together
       with the carry test's PASSING loop and the VT1 row "a rebase carry
       of a clean review". The failing half (a carried `blocking` or
       `incomplete` stays red) does not depend on the answer.
  5. *`stored` accepted on every skip* (minor): taken. The union is split,
     so only `already-reviewed` and `carry` take `stored`. A
     `@ts-expect-error` test pins it, and a mutation that widens the type
     breaks typecheck.
  6. *Test 17's title overclaims* (minor): taken. It is "VT1 path mapping
     table (pure; the job's exit-path test is deferred)", and its header
     says the job's own exit-path test, catch blocks included, and the D3
     parity test land with the wiring.
     - The "nothing left after classification" path
       (`github.review.ts:548-559`) uses `nothing-to-review`. It is also
       reached by a PR whose only files are binary, or deleted without a
       patch (`ignore.ts:224-229`), so such a PR reads `policy-skip` by
       the addendum's mapping. Recorded for Q18.
  7. *Desktop outcomes do not fit* (minor): recorded, nothing changed.
     The desktop's `ReviewOutcomeLite` (`ai-review.ts:220-250`) has no
     `partial` and no `unreviewed`. Its `specialists` are review and
     security only, with no `skipped` status (`ai-review.ts:213-218`), and
     verify is `verification.status` (`ok`, `skipped` or `failed`,
     `ai-review.ts:244`). The deferred desktop artifact field needs an
     adapter that folds `verification.status` into a verify entry and
     supplies `unreviewed`, or a documented difference with
     `variant.applied: false`.
  8. *Future specialist names* (minor): taken. `specialists[].name` also
     takes the contract's `lens` and `repro` and codium's `judge`
     (contract §1.2). `no-reviewer` means no `review` or `security`
     entry, so an unknown pass never stands in for a reviewer (tested for
     all three). Any of them that does not finish reads `incomplete`.
     The packages that add those names must decide their verdict effect.
  9. *types.ts carries the same merge exposure* (minor): taken in the
     first form. `REVIEW_VERDICTS` and `ReviewVerdict` live in
     `verdict.ts`, and `types.ts` is unchanged. Contract §0.2 lists
     `types.ts` beside `state.ts` among codium's rewrites, and nothing
     reads the type before `ReviewState.verdict`. Both move to `types.ts`
     (which must stay import-free) with that field.
- **Review findings** (same day, on the uncommitted change):
  1. *Lookup misses fail open* (non-blocking, merged with 6): taken. An
     outcome decoded from JSON (a §1a replay artifact, the desktop
     adapter) can carry values the types do not name, and a lookup miss
     read as complete, gave `verdict: undefined`, threw, or handed a
     stored value back as it was. Now:
     - an unnamed skipped-file reason (VS-34's later `held-back`, an
       older or newer artifact) gives cause `skipped-unknown`, once,
       after the table's causes so the order stays fixed. It is a
       dedicated cause rather than a reused `size-limit`, so red PRs by
       cause tell an unclassified reason apart from a size limit;
     - an unnamed skip reason (`other-command`, for example) gives
       `not-reviewed` with `skip-unknown`;
     - an unnamed failure stage gives `not-reviewed` with
       `failure-unknown` (it threw before);
     - an unnamed stored verdict (`"pass"`, `""`, `null`, an inherited
       key) reads as a missing one: `not-reviewed` with
       `no-stored-verdict` and `review-full`.

     The same principle covers three values the findings did not list,
     each a one-line change: a severity other than `concern` or `nit`
     reads as `blocking`; `strict.complete` must be exactly `true` (a
     decoded `"true"` or `1` read as complete before); and `trivial` must
     be exactly `true`. The strict comparison carries one
     `oxlint-disable-next-line no-unnecessary-boolean-literal-compare`
     with its reason, since the rule assumes the declared type. The new
     tests decode every input from JSON, so none needs a type assertion,
     and include inherited keys (`toString`, `constructor`,
     `__proto__`, `hasOwnProperty`, `valueOf`) so a lookup that reads the
     prototype fails them.
  2. *A stored failing verdict gives no hint* (non-blocking): taken
     (rule 3 above), for both `already-reviewed` and `carry`. The
     already-reviewed test now covers every stored value with its note,
     and feeds one stored verdict from a judged outcome whose verify
     pass was stopped.
  3. *The carry rule is fixed in code* (non-blocking): the conservative
     default stays. Its expected effect on dogfood red rates, and the one
     branch a Q18 answer would flip, are recorded under critique 4.
  4. *Test style* (non-blocking): taken. The combinations are built with
     `flatMap` into a `const` array whose length is asserted (7,056), and
     the oracle is reduced to the invariant: a listed blocking finding
     never passes, and the one pass without a finished run is a trivial
     outcome with no pass entry and everything but the reviewer
     finished. Exact tiers are left to the table tests. The listed
     finding moved from `elsewhere` to `stillOpen`, the list a trivial
     outcome carries.
  5. *The trivial marker excused listed findings* (blocking): taken, in
     a different form from both options offered. Both read the outcome
     normally once anything (or anything blocking) is listed, which
     gives a trivial outcome with a still-open blocking finding
     `incomplete` with `no-reviewer`. With the `!listed.length` option, a
     still-open concern goes red the same way, so a whitespace commit on
     a PR with an earlier concern would turn a passing check red. Here
     the marker stands in for the missing reviewer only, and the lists
     are then read as on any outcome:
     - a still-open blocking finding gives `blocking`. That is exit 1
       under the gate, as under failOn "blocking", and red PRs by cause
       name the open finding rather than a missing reviewer;
     - a still-open concern gives `findings`, which passes, as it did
       before the trivial commit.

     The property test asserts the invariant for every severity, and
     the trivial test covers blocking, concern, a held deletion beside a
     blocking finding, and a contradictory partial value. Critique 2's
     claim is corrected.
  6. *Exhaustiveness rests on the type system* (non-blocking): taken
     with 1 (above).
- **Other decisions.**
  - **Placement.** The addendum puts the function in `state.ts` next to
    `nextState`. It is in its own `verdict.ts` because:
    - `state.ts` imports `command.ts` (@vector-owned), `diff`, `prompt`
      and `select` at runtime, while `verdict.ts` imports types only;
    - codium rewrites `state.ts` (contract §0.2);
    - the package's test is `verdict.test.ts`.

    `ReviewState.verdict` and the `nextState` write still go into
    `types.ts` and `state.ts` at wiring.
  - **Fail-closed widenings**, each beyond the addendum's list:
    - any status other than `ok` is unfinished, not only failed or
      skipped. `run.ts:842-844` builds `partial` from the reviewer passes
      only, so a verify pass that is stopped or times out sets no
      `partial`, and only its status shows it (tested with findings
      posted);
    - an outcome with no review or security pass is `incomplete`;
    - a `size-limit` skipped file (reusing `SkippedFile.reason`) is
      `incomplete`;
    - any partial value other than the two stops is `incomplete`;
    - at runtime, values the types do not name fail closed (review
      findings 1 and 6, above): every table lookup checks
      `Object.hasOwn`, so an inherited key such as `toString` never
      reads the prototype.
  - **Lists.** `blocking` reads the job's `failOn: "blocking"` lists
    (`github.review.ts:877-883`) plus nits, which never hold a blocking
    finding (`select.ts:297`). `findings` counts nits and still-open
    findings too. Fixed, dismissed and dropped findings are not listed
    (tested).
  - **Causes and notes are codes, not text** (D14). `format.ts` words
    them at wiring. The causes feed the kill criteria: red PRs by cause,
    and held-back as the only cause.
  - **Policy skips never read earlier findings**, as with every
    `decideSkip` skip today. Whether a skip should carry an earlier
    blocking verdict is a wiring question (Q18).
  - **Types that have not landed are read structurally.**
    `ReviewOutcome.partial`, `SkipReason`, `SkippedFile` and `ReviewOutcome`
    are not widened: VS-23b, VS-24, VS-27a and VS-34 own those changes.
    `trivial` is in `VerdictSkip` for the GitHub-side trivial skip, which
    waits for the @vector merge (contract VS-24).
  - **A malformed input throws.** An input whose shape is wrong (a
    missing list, an unknown `kind`) throws instead of returning a value.
    The deferred decoder rejects such input first, and the wiring's catch
    path must read a throw as the `review` failure (`incomplete`), never
    as exit 0.
  - **VS-34's two fields.** `held` (with its status) and the later
    `held-back` `SkippedFile` reason must not double-count or contradict
    each other. A held deletion must not read `incomplete` through the
    skipped-file table while `held` exempts it. VS-34 wiring must
    classify `held-back` in `verdict.ts` with that in mind.
- **§0.3 items:**
  1. key: none in Now;
  2. parity: nothing calls it, and the existing suites pass unchanged;
  3. evidence: no new key, so `EVIDENCE_POLICY_KEYS`, `EvidenceScope`,
     `policyDigest` and `promptsDigest` are unchanged. `failOn` is "not a
     policy key" (addendum §1);
  4. variant: not applicable (§1a);
  5. desktop: a documented difference, since the desktop has no CI exit
     code (`variant.applied: false` once the artifact field exists; see
     critique 7);
  6. this entry.
- **Evidence scope and pin.** `verdict.ts` is not in
  `REVIEW_PIPELINE_FILES`. It changes neither what a review finds nor
  what a model sees: it is a gate over the outcome, like its unpinned
  peers `state.ts` and `format.ts`. No pinned file changed, so
  `REVIEW_PIPELINE_SOURCES` stays `7addfcd0033ba579` (re-run) and
  `REVIEW_PIPELINE_REVISION` stays 1, as with VS-22a.
- **Owner questions: none decided.** Q13, Q18 and Q19 stay open. Q19
  (retry or exit at once) changes exit timing, not the value: a model
  error reads `incomplete` either way. The carry rule, the binary-only
  `nothing-to-review` reading, and whether the comment-command and
  write-access exits emit any verdict are raised under Q18.
- **Deferred to after `vector-at-mention`** (citations at `376a52ad`):
  - **The `blocking-or-incomplete` value**, read from base `review.json`
    only, through VS-23a's source-tagged merge. Today `oneOf` is at
    `config.ts:28-33` and `:170`, `REVIEW_FAIL_ON` at `:206`, and the
    readers at `:255-257` (`parseReviewConfig`) and `:285`
    (`mergeReviewConfig`). Until then the new config test pins today's
    behaviour: the value warns and resolves to `never` from review.json,
    `REVIEW_FAIL_ON` and the GitHub merge.
  - **Exit codes**, catch paths included (`github.review.ts:200-221,
    244-276, 385-430, 511-515, 548-559, 702-716, 959-978, 1108-1121,
    1213-1229`).
  - **`ReviewState.verdict`**, the `nextState` write (`types.ts:138-153`,
    `state.ts:366`) and the stored-value decoder, with `REVIEW_VERDICTS`
    and `ReviewVerdict` moved to `types.ts`.
  - **Outputs.** `$GITHUB_OUTPUT` `vectorscope-verdict` and
    `vectorscope-head`, and the summary marker.
  - **Whether and what** the comment-command and write-access exits emit
    (`github.review.ts:253-261`).
  - **Tests.** The addendum's exit-path test (every exit path, catch
    blocks included, existing exit-1 paths unchanged) and the D3 parity
    test on the `github.review` tests.
  - **The request** to the @vector owner for an always-running gate step.
- **Deferred to eval or wiring follow-ups:**
  - the recorded artifact field (§1a) in engine `eval.ts` and the desktop
    adapter (critique 7);
  - the check that 0 partial outcomes over saved replay artifacts give
    `clean-complete`, and the injected-stop seed cases;
  - VS-34 wiring's `held-back` classification (above);
  - VS-24 wiring setting the `trivial` marker on its zero-attempt outcome;
  - VS-24's GitHub-side trivial skip goes through `decideSkip` as
    `{ kind: "skip", reason: "trivial" }`, which carries no outcome and
    reads no still-open finding. So a trivial commit on a PR whose stored
    verdict is `blocking` would read `policy-skip`. Like the other policy
    skips (Q18), the wiring must decide whether it hands on a stored
    failing verdict, as `already-reviewed` does;
  - VS-27a's `strict`, and whether strict findings count;
  - the dogfood measurement and the kill criteria.
- **Deferred verification:**
  - no saved replay artifacts exist in the repository (I-13);
  - exit-code behaviour cannot be checked before the wiring.
- **Evidence.** Each file ran alone through the lock with `--timeout 30000`,
  `GITHUB_ACTIONS=false`, and `TMPDIR` and XDG roots under
  `/tmp/vector-vectorscope/vs32a/`:

  | Where | File | Pass |
  |---|---|---|
  | core | `test/review/verdict.test.ts` | 44 (new; 38 before the review findings) |
  | core | `test/review/config.test.ts` | 35 (one added) |
  | core | `test/review/skip.test.ts`, `state.test.ts`, `format.test.ts`, `holdback.test.ts` | 11, 42, 46, 16 |
  | core | `test/review/model-evidence.test.ts` | 17 (pin re-run after the review fixes, unchanged) |
  | engine | `test/cli/github.review.test.ts` | 40 (unchanged, I-1) |
  | app | `src/features/pull-requests/ai-review.test.ts` | 107 (unchanged) |

  - `verdict.test.ts` covers: every partial value; unreviewed present and
    absent; every skipped-file reason; held changes and deletions;
    strict complete, incomplete and absent; every specialist status on
    each pass; the reviewer rule with future names; every skip reason;
    every `decideSkip` reason, fed from `decideSkip` itself, with and
    without its summary note; both stored skips over every stored value;
    the three failures; the trivial marker, with still-open findings;
    the VT1 mapping table; values the types do not name, decoded from
    JSON; and purity on a deep-frozen input. A property test over 7,056
    combinations (partial, unreviewed, held, strict, specialists, listed
    severity, trivial) asserts that an unfinished review is never a pass
    and a listed blocking finding never passes.
  - After the review fixes, only `verdict.ts` and its test changed, and
    nothing else imports `verdict.ts`. So `verdict.test.ts` and
    `model-evidence.test.ts` were re-run, and so was core's `bun
    typecheck`. The other rows above are from the first round, and no
    file they load changed.
  - `bun typecheck` passes in core, engine, app and desktop, and so does
    the eval scripts' `tsgo -p ../../script/vectorscope-eval/tsconfig.json`.
  - prettier passes on the three files, and oxlint reports no warning on
    them. The test's tables avoid type assertions: each key list is
    checked against its exhaustive record.
  - **Mutation check.** Seventeen mutations each broke at least one test,
    and the file was restored byte for byte after each (`cmp`):
    - privacy read as incomplete; the deletion exemption dropped;
      `!== "ok"` narrowed to `=== "failed"`; `no-reviewer` removed;
      `no-reviewer` counting any non-verify pass;
    - stillOpen not listed; pr-budget as a policy skip; `stored` ignored;
      a carry handing on a passing verdict; size-limit read as complete;
      the cause order swapped;
    - trivial excusing a run whose passes ran; trivial excusing any
      unfinished cause; a review error read as not-reviewed; the note
      dropped on a stop;
    - at typecheck: `other-command` added as a policy skip, and `stored`
      accepted on every skip;
    - after the review fixes, ten more, each breaking at least one test,
      with the file restored byte for byte (`cmp`): trivial passing
      whatever is listed; the skipped-file lookup reading the prototype;
      `skipped-unknown` dropped; the skip-reason, failure-stage and
      stored-value checks each dropped; `review-full` dropped on a
      stored `incomplete`; an unnamed severity read as non-blocking;
      `strict.complete` and `trivial` read as truthy.
  - The full root typecheck was not run: nothing is pushed.
  - Nothing was sent to a model, no paid path ran, no workflow was
    dispatched, no dependency was added, and no user-visible string
    changed (D14).

## 2026-11-06 · VS-24c Trivial classifier and pre-dispatch estimate (core)

Contract §1.2 `trivial.ts` and `dispatch.ts`, §4 VS-24 items 1, 2 and the
core half of item 4; addendum A VS-40 items 1 and 2 and §3 VS-24
"Estimator"; the Now window of contract §5 and addendum §4. Built at
`8f38f824`. VS-24 is a proposal pending Q15, and VS-40 one pending Q18, so
nothing calls the new code: no runner reads either new key, and
`classifyTrivial`, `estimateDispatch`, `decideDispatch`, `shrinkStepCap`,
`cacheReadShare` and `remainingUsd` have no caller. `run.ts`,
`ai-review.ts`, `provider.ts`, `session/llm.ts`, `posting.ts`, `format.ts`,
`prompt.ts`, `schema.ts`, `select.ts`, `state.ts`, `verdict.ts`,
`workflow.ts`, `command.ts`, `cli/cmd/github.*`, `cli/cmd/review.ts`,
`github-*.ts`, `vectorscope.astro` and `script/vectorscope-eval/*` are
untouched. No dependency was added (minimatch is already a core
dependency), so there was no `bun install`, generator run or SDK
regeneration (no protocol or global-config change). It implements the
VS-24c plan as corrected by its critique: all fourteen critique points were
taken, three of them in a different or stronger form (below). Nothing is
committed.

- **What landed.**
  - **`packages/core/src/review/plan.ts`** (pinned).
    - `OUTPUT_PER_STEP` is exported (contract §3), still 600.
    - New `EstimateBand`, `estimateBands(maxSteps)` (today's band rule:
      low S = min(5, cap) at R 2,000, high S = cap at R 4,000) and
      `passInputTokens(P, band)` = S·P + R·S(S−1)/2.
    - `estimateCostUsd` gains VS-40's optional `cacheReadShare`,
      `writePrice` and `outputPerStep`. With none of them the result is
      bit-identical to `8f38f824`: the legacy low band keeps its (S−1)·P
      cache-read rule, the legacy high band keeps no cache-read term at all
      (so its floating-point sum is the same), and `price.input` and 600
      stay the defaults. A share applies only when the price lists a cache
      read; a share that is not a number reads as 0. `nextStepCostUsd`,
      `diffBudgetChars` and the verify policy are unchanged.
  - **New `packages/core/src/review/dispatch.ts`** (pinned; imports `./plan`
    and a type from `./types`).
    - `PassPlan` (`pass`, `model`, `promptTokens`, `maxSteps`, `price?`,
      `cached?`), `PassEstimate`, `DispatchEstimate`, `Range`,
      `DispatchLimit`, `DispatchDecision`, `Shrink`, `SHRINK_ORDER`
      (lenses, cards, steps:verify, steps:security, steps:review,
      dependents, diff), `STEP_CAP_FRACTION` (0.5),
      `CALIBRATED_OUTPUT_PER_STEP` (`{ tokens: 1_800, fitted: "2026-09-14",
      cases: 1 }`).
    - `estimateDispatch(passes)`: per pass, input tokens per band, output
      tokens (S·600), the legacy `usd` from `estimateCostUsd`, the first
      turn's admission figure `firstStepUsd` = `nextStepCostUsd(P +
      NEXT_STEP_SLACK)` (what `run.ts`'s `ask` reserves), and `v2`: h(S)
      per band, output at S·1,800, and dollars from the same
      `estimateCostUsd` with VS-40's inputs (I-10). Sums: first-turn
      tokens over every pass (free, plan and local included), dollars over
      priced passes only, `unpriced` naming the rest.
    - `decideDispatch(estimate, { maxInputTokens, remainingUsd?,
      available? })`: over `input-tokens` when the cap is above 0 (or NaN)
      and first-turn tokens are not at or under it; over `usd` when a
      remainder is given, a pass is priced, and the legacy LOW estimate is
      not at or under it. It never reads the high band or v2. When over, it
      names the first available lever in `SHRINK_ORDER` that can lower a
      limit that is over, and lists the levers it passed over as
      `ineffective`; with none left it stops with `budget-estimate`.
    - `shrinkStepCap(passes, pass, fraction?)`: Math.floor(cap · fraction),
      at least 1, never above the current cap; a fraction that is not a
      positive number, or above 1, leaves the cap; input not mutated.
    - `cacheReadShare(P, band)` = 1 − (P + (S−1)R) / (S·P + R·S(S−1)/2)
      [G3-6], 0 for one step or a non-positive or non-finite input.
    - `remainingUsd(config, spent?)` (VS-40 item 3, pure), `spent` being
      `{ trigger, prUsd?, monthUsd? }`: the smallest of `maxCostUsd`, the
      per-PR cap less `spent.prUsd` (automatic reviews only, as in
      `decideSkip`), and the month cap less `spent.monthUsd` (every
      trigger); caps of 0 (none) and spends not passed are left out, so
      without `spent` it is `maxCostUsd`; a spend that is not a number of
      at least 0 leaves nothing of its cap; undefined when no cap applies.
  - **New `packages/core/src/review/trivial.ts`** (pinned; imports
    minimatch, `./diff`'s types, `./ignore`'s
    `classifyPath`, `hasGeneratedHeader`, `isBinaryPath`,
    `isSensitivePath` and `LOCKFILES`).
    - `TRIVIAL_KINDS`, `TRIVIAL_REFUSALS` (46 codes), `SourceRange`,
      `CommentRange`, `TrivialDecision`, `TrivialInput`, and
      `classifyTrivial(files, input)`.
    - Rules, files in input order, first refusal wins: per path (new and
      old) hidden or control characters, then sensitive
      (`isSensitivePath`, which always applies, or the caller's
      `sensitive`), any dot segment, CI, container, infrastructure,
      dependencies (Q11), build, config, SQL, migration, binary, no
      extension; then per file the patch must hold every counted line, no
      hunk line, context included, may be longer than 2,000 characters
      (`long-line`, before any pattern reads a line), no changed line may
      hold a hidden or control character, and no hunk line may be a
      submodule pointer or a generated-code marker; then
      docs (`.md`, `.rst`, `.adoc` only), other doc-like extensions
      (refused), added or deleted code (refused), renames, a modified file
      with no hunk (refused), and the whitespace and comment rules hunk by
      hunk. A hunk whose two sides hold the same lines once trailing
      spaces and tabs are stripped and blank lines dropped (leading
      whitespace kept, context lines included) is a whitespace hunk; any
      other is read as a comment hunk.
  - **`packages/core/src/review/types.ts`**: `ReviewConfig.trivial?:
    "review" | "skip"` (`:255`) and `maxInputTokens?: number` (`:281`),
    both left out of `DEFAULT_REVIEW_CONFIG`; new
    `OPTIONAL_REVIEW_DEFAULTS = { trivial: "review", maxInputTokens: 0 }`
    (`:324`), its widened view `OPTIONAL_REVIEW_DEFAULT_OF` (`:330`) that
    `config.ts` and `model-evidence.ts` share, and `UNAPPLIED_REVIEW_KEYS =
    ["trivial", "maxInputTokens"]` (`:336`), the parsed keys no runner
    applies yet, typed as a subset of the optional keys. The file stays
    import-free.
  - **`packages/core/src/review/config.ts`**: `FIELDS` gains `trivial`
    (`:171`) and `maxInputTokens` (`:186`, an integer of at least 0);
    `ENV` gains `REVIEW_TRIVIAL` and `REVIEW_MAX_INPUT_TOKENS`; a bad value's
    warning names the default for an absent optional key (`using
    "review"`, `using 0`), and every existing warning keeps its text
    (`model` still reads `using undefined`); `settle` adds the
    "not applied" warnings (critique 8, below) from a record keyed by
    `UNAPPLIED_REVIEW_KEYS`, so a key cannot join or leave that list
    without its warning. Neither is a sourced key.
  - **`packages/core/src/review/skip.ts`**: `SkipReason` gains `"trivial"`
    (`:24`), types only. `decideSkip` never returns it; `skipNote`
    (`github.review.ts:433-468`) is non-exhaustive and `verdict.ts`
    already classifies it as `policy-skip`.
  - **`packages/core/src/review/model-evidence.ts`**: `trivial` joins
    `EVIDENCE_POLICY_KEYS` (`:70`); `policyDigest` (`:274`) is
    default-stable: a key with an `OPTIONAL_REVIEW_DEFAULTS` entry counts
    only when set to another value, and every other key counts as before.
    A key in `UNAPPLIED_REVIEW_KEYS` reads as absent whatever its value,
    so before VS-24 wiring `trivial` never moves the digest.
    `REVIEW_PIPELINE_SOURCES` `7addfcd0033ba579` → `a3cb5477a0a829b7`.
  - **`packages/engine/src/review/eval.ts`** (eval code, not a held-back
    runner).
    - `ShrinkStep` (`:199`) is `{ step: Shrink; estimate: DispatchEstimate
      }`, so each step records both estimates per pass. New
      `ReplayArtifact.dispatch?: DispatchEstimate` (`:265`), the first
      estimate before any shrink. Nothing writes either before VS-24
      wiring.
    - Core's `UNAPPLIED_REVIEW_KEYS`: `ReplayInput.config`'s type leaves
      out `trivial` and `maxInputTokens`, and `variantProblem` refuses
      either from an untyped caller (`:1157`). A base review.json that sets
      either is replayed and recorded without it: each listed key is
      deleted from a copy of the parsed config (`:607`).
    - `ProjectedPass.v2?` (`:342`, filled at `:1059`): VS-40's v2 of each
      pass's first request beside the legacy `usd` (critique 13).
  - **Tests**: new core `test/review/trivial.test.ts` and
    `test/review/dispatch.test.ts`; additions to core `plan.test.ts`,
    `config.test.ts`, `skip.test.ts`, `model-evidence.test.ts` and engine
    `test/review/eval.test.ts`.
- **Critique points.**
  1. *Docs that code loads* (blocker): taken. `CONTEXT.md`, `BRAIN.md`,
     `MEMORY.md` and `RULES.md` join the agent-instruction basenames (the
     engine's instruction loader reads the first three). Every docs path,
     not only renamed and deleted ones, needs the new
     `referencedByCode(path)` callback: absent gives
     `references-unchecked`, true gives `referenced-by-code`. Renamed and
     deleted docs also need `referencesOldPath`. Fixtures:
     `packages/core/src/plugin/skill/customize-vector.md` (imported as a
     skill prompt by `skill.ts:9`) and a README that `include_str!` loads.
     Wiring must pass the engine config's `instructions` globs through
     `sensitive` (deferred list).
  2. *Line terminators* (blocker): taken in a stronger form. A new
     `control-characters` refusal covers every control character but the
     tab (a lone `\r`, `\v`, `\f`, ESC, DEL, the C1 range with NEL) and
     U+2028 and U+2029, in changed lines and in paths, for every file,
     not only code files. The invisible set gains U+061C, U+00AD, U+180E,
     U+3164, U+FFA0, U+115F and U+1160 as asked, plus U+034F, U+17B4,
     U+17B5, the variation selectors and Unicode tags (U+E0000-E007F,
     U+E0100-E01EF), which carry invisible prompt text. It is a code-point
     range table rather than a regex class, since the class needed
     combining characters (oxlint `no-misleading-character-class`). Fixtures
     for each terminator in a `.ts` and a `.java` comment; a CRLF line
     ending (the trailing `\r` the parser drops) still reads as a comment
     change.
  3. *Generated-code markers* (major): taken. `ignore.ts`'s
     `hasGeneratedHeader` is called on each hunk line (refusal
     `generated-marker`, every file kind) and on each line of every comment
     range a changed line touches (`directive`), so `GENERATED_HEADER`
     stays private and no pattern is copied. Go's `//export`, `//extern`,
     `//sys` and `//sysnb` join the Go extras. Fixtures add and remove `//
     @generated` and `// Code generated by gen. DO NOT EDIT.` in a `.ts`
     and a `.go` file.
  4. *Docusaurus reads `.md` as MDX* (major): taken. In `.md` a hunk line
     with an `import`/`export` statement, a capitalised JSX tag, or a brace
     outside inline code is `doc-code`, and the whole-file state (5)
     treats an ESM, expression or component line as a run to the next
     blank line. Fixture: `docs/intro.md` with an import and `<Button
     onClick>`, and a `{props.name}` expression.
  5. *State outside the hunk* (major): taken, not deferred. New
     `docText(path, side)` callback; without it, or when it returns
     undefined, a doc with changed lines is `doc-code-unchecked`. Every hunk
     line must equal the text's own line (`doc-text-mismatch` otherwise),
     and no changed line may fall inside front matter, a fenced or
     delimited block, an indented block (4 spaces or a tab in Markdown, any
     indentation in reStructuredText and AsciiDoc), a doctest run (from
     `>>>` or `iex>` to the next blank line), an MDX run, an HTML comment
     or a raw `script`/`style`/`iframe`/`object`/`embed`/`form`/`svg`/
     `math`/`template` block, or reStructuredText and AsciiDoc directives,
     fields, block attributes, macros and line comments. One fixture per
     case: a fence, long front matter, an indented block, doctest output 5
     lines below its prompt, a multi-line HTML comment, an rst literal
     block, an AsciiDoc listing block and an MDX expression, each with its
     opening line outside the hunk.
  6. *Patch completeness* (major): taken for every kind. When the hunks'
     added and deleted lines do not equal `file.additions` and
     `file.deletions`, the file is `patch-incomplete`, before any kind
     rule. Fixture: a patchless README with 40 additions. A GitHub rename
     whose patch was omitted now reads `patch-incomplete`; the plan had
     `rename-with-changes` for it, which a rename with a patch still gets.
  7. *Go and Rust comment-borne tests* (major): taken. On the whitespace
     path `.go` and `.rs` need comment ranges too. A hunk line, context
     included, inside a Rust doc-comment range (`///`, `//!`, `/**`,
     `/*!`) is `directive`, and so is a hunk line inside any comment range
     of a Go `_test.go` file. On the comment path every comment change in
     a Go `_test.go` file is `directive`. Fixtures: a trailing space 5 lines
     below `// Output:`, outside its hunk, and a `///` doctest string.
  8. *Parsing before enforcing* (major): taken in the first form; the
     precedent's fallback (no parsing) is not used, since the brief asks
     for the keys parsed.
     - When a value would change a review, `settle` adds `"trivial":
       "skip" is not applied yet: every change is still reviewed.` or
       `"maxInputTokens" is not applied yet: no input-token cap is
       enforced.` Their defaults written out, or the keys unset, warn about
       nothing (tested), so with nothing set the parse is byte-identical.
     - The replay records a base review.json's keys as unapplied: both are
       left out of the run's config, so `config.value`, `config.digest` and
       `scope.policy` carry neither, and the parser's warnings stay in
       `config.warnings` (tested). `input.config` refuses them as planned.
     - No runner's scope moves for `trivial: "skip"` before wiring:
       `policyDigest` reads every key in `UNAPPLIED_REVIEW_KEYS` as absent,
       so the engine, desktop and GitHub scopes claim the full review they
       ran, and `modelEvidence: "warn"` gives no spurious no-certificate
       note. (The first version let the digest move and accepted it as
       fail-to-match only; review finding 11 changed that, below.) The
       warning says the key is not applied.
  9. *Levers that cannot act* (major): taken. `decideDispatch` names a
     lever only when it can lower a limit that is over: a step cap never
     lowers first-turn tokens, and lowers the low dollars only when
     `estimateDispatch(shrinkStepCap(...))` gives a lower low estimate,
     which needs a cap below 10 (S_low = min(5, cap)). Lenses, cards,
     dependents and diff trim shorten prompts, so they count whenever the
     caller lists them. Passed-over levers come back as `ineffective`, for
     the notes. The walk tests show the default caps skipping all three
     step-cap levers, and caps of 8 using each in VS-40's order.
     **Contract tension for the owner (not decided):** VS-40 puts step caps
     before dependents and diff trim, but at the default caps no step-cap
     shrink can change the gate's decision, so with lenses, cards and
     dependents unwired at VS-24 wiring, diff trim is the only lever that
     can act until a calibrated S replaces the fixed 5. The step-cap shrink
     still lowers the high estimate and the real step ceiling; whether it
     should fire anyway (for the ceiling) is the wiring package's and the
     owner's call, under VS-40's kill criterion on lost verified findings.
  10. *`remainingUsd` semantics* (minor): taken. `dispatch.ts`'s header
      states that undefined means no dollar check and that a ReviewConfig
      cap of 0 means none, and the pure `remainingUsd(config, spent?)`
      drops those zero caps, with VS-40's tests (prior spend included,
      `maxCostUsd` without `spent`, 0 means none, an uncapped review goes).
      `RunInput.spent` stays deferred.
  11. *Range semantics* (minor): taken. A string range runs from the line
      its literal opens on to the line its closing delimiter is on, and a
      changed line n is inside when start ≤ n < end, so a one-line string
      covers no line. A comment range is inclusive and carries its text one
      line per source line. Both are in the type comments; malformed ranges
      (not whole positive lines, an end before the start, or comment text
      with the wrong line count) read as missing. Boundary fixtures cover a
      literal's opening line (refused), its closing line (allowed), a
      one-line string (allowed), and the last line of a block comment
      (inside).
  12. *Submodules, symlinks, routing directories* (minor): taken. A hunk
      line starting `Subproject commit ` is `submodule`. The routing globs
      gain `netlify`, `functions`, `plugins`, `middleware`, `server`,
      `commands` (Django `management/commands`, oclif) and, beyond the
      critique, `locales` and `i18n`. Symlinks are a residual (below), and
      `TrivialInput.sensitive`'s comment says wiring passes symlink,
      submodule and executable modes through it.
  13. *v2 in projections* (minor): taken. `ProjectedPass.v2` holds
      `estimateDispatch`'s v2 for the pass's first request. The projection
      cannot see whether a route caches, so it takes the legacy low band's
      own assumption: a price that lists a cache read is a caching route.
      The engine projection test pins it against `estimateDispatch`. The
      report summary of v2 waits for the VS-21c report fields (VS-40 item
      5), since `script/vectorscope-eval` is untouched.
  14. *Prompt injection through skipped text* (minor): recorded, not
      decided (residuals, below).
- **Signature deviations from contract §1.2.**
  - `TrivialDecision.because` is the `TrivialRefusal` union, not `string`,
    and a refusal carries `path`, the first refusing file (absent only for
    `empty`).
  - `TrivialInput` gains `strings` (the contract's "outside string
    literals (by parser tokens)" needs them, and no signature carried
    them), `docText` (critique 5) and `referencedByCode` (critique 1).
    `sensitive` only adds to `isSensitivePath`.
  - `PassPlan` gains `cached`. `DispatchEstimate.outputTokens` is a `Range`
    (the low dollars use min(5, cap) steps of output), and it gains
    `passes`, `unpriced`, `firstStepUsd` and `v2`.
  - `DispatchDecision`'s `shrink: true` is the `Shrink` to apply, and both
    refusals carry `over` and `ineffective`. `decideDispatch`'s limits gain
    `available`.
  - New exports: `estimateBands`, `passInputTokens`, `EstimateBand`,
    `cacheReadShare`, `shrinkStepCap`, `remainingUsd`, `SHRINK_ORDER`,
    `STEP_CAP_FRACTION`, `CALIBRATED_OUTPUT_PER_STEP`, `TRIVIAL_KINDS`,
    `TRIVIAL_REFUSALS`, `OPTIONAL_REVIEW_DEFAULTS`.
- **Rules stricter than contract VS-24 item 1, with their reasons.**
  - Every dot segment, not only `.github/**` and `.vector/**`: `.gitlab-ci.yml`,
    `.husky`, `.devcontainer`, `.env*`, `.npmrc`, `.gitattributes`,
    `.gitmodules`, `.editorconfig` and tool rc files change behaviour.
  - Extensionless files (`Jenkinsfile`, `LICENSE`, scripts) are refused.
  - Renames: docs, and in-place pure renames of TS/JS/Python files outside
    test, routing and conventional names only. The contract's "a non-code
    file" would pass `Makefile`, `BUILD`, `.gitignore` and assets served by
    URL; Java public classes, Go packages, Rust's module tree, PHP PSR-4
    and Rails autoloading tie a name to behaviour; Next.js, SvelteKit,
    Remix and serverless functions route by file. A rename into a default
    ignored path (`dist/`, `vendor/`, `*.generated.*`) is
    `rename-into-ignored`, since every later change to the file would be
    skipped unreviewed.
  - The reference checks are required: an absent callback refuses.
  - Docs: `doc-code` on hunk lines and over the whole text (4, 5), HTML
    comments (hidden text and tool markers such as `prettier-ignore`),
    `javascript:` links and `on*=` attributes, template tags.
  - Whitespace only in VS-25a's grammar set minus Python (TS/JS family, Go,
    Rust, Java); comments in that set plus Python. Shell, PHP, Ruby, CSS,
    Vue and the rest are never whitespace- or comment-trivial.
  - Every hunk needs an unchanged line before and after its change, except
    at the ends of the file, for every language (the plan had a trailing
    rule for Go only); a `-U0` diff is refused.
  - A comment-only line must hold nothing but comment text, column for
    column: the comment pieces that cover it must account for every
    non-blank character (the plan's containment test). A blank changed line
    passes only inside a comment.
  - `comment-structure` compares, for every unchanged line of the file, the
    comment text on it on both sides, which also catches a block closed
    early in the middle of an unchanged line (the plan compared line
    coverage only).
  - The whitespace test compares the whole hunk side, context included, so
    a line moved past an unchanged one is not whitespace.
  - The directive list, plus language extras: Rust doc comments, JSDoc
    types in JavaScript, Java unicode escapes, cgo markers and `import
    "C"`, Go Example output and linker/syscall directives, licence and
    copyright lines, bundler hints, lint and coverage suppressions,
    encodings and shebangs.
- **Estimate decisions.**
  - The gate decides on the legacy low estimate and first-turn tokens;
    first-turn tokens are summed over the planned passes (the contract
    says neither sum nor max; `PassEstimate.promptTokens` keeps each pass's
    value so wiring can change it).
  - v2 is recorded and never decides (tested: an uncached v2 low of $0.789
    is over the pilot's $0.75 while the legacy low of $0.372 goes). It
    prices a cache-read share only for passes the caller marks `cached`
    whose price lists a cache read, and the rest at the catalog's
    `cacheWrite` (else input) on a caching route.
  - At the default caps (review 30, security 20, verify 10) on a small
    review (5,300, 5,300 and 3,000 prompt tokens, Sonnet-like prices) the
    legacy range is $0.372 to $9.465 and the input tokens 128,000 to
    2,975,000 (growth alone 2,680,000): a high-estimate gate would fire at
    both the $2 default and the pilot's $0.75, and the low one fires at
    neither (tested).
  - `CALIBRATED_OUTPUT_PER_STEP` is 1,800, fitted 2026-09-14 on one case.
- **Config and evidence.**
  - Parsed through `FIELDS` and `ENV` per the brief, which differs from the
    VS-23a and VS-32a precedent of leaving new keys unparsed until
    enforced. Critique 8's warnings and replay handling make that honest.
  - `trivial` is a policy key with a default-stable digest:
    `policyDigest(DEFAULT_REVIEW_CONFIG)` stays `70512122f41ec160`
    (printed at `8f38f824`, pinned in a test). Until a runner applies it,
    no value of it moves the digest (`"skip"`, `"review"` or absent), nor
    does any `maxInputTokens`; once VS-24 wiring takes it off
    `UNAPPLIED_REVIEW_KEYS`, `"skip"` moves it and `"review"` and absent do
    not. `maxInputTokens` is a budget, not a policy key (contract §1.1).
    `promptsDigest` and `EvidenceScope` are unchanged.
  - `trivial.ts` and `dispatch.ts` join `REVIEW_PIPELINE_FILES`, and
    `REVIEW_PIPELINE_SOURCES` moves `7addfcd0033ba579` → `a3cb5477a0a829b7`.
    `REVIEW_PIPELINE_REVISION` stays 1: no runner reads either new module,
    and `plan.ts`'s defaults are bit-identical (pinned), so no review finds
    or posts anything different (only VS-31 bumps it).
- **§0.3 items.**
  1. keys: `trivial` and `maxInputTokens`, off by default, parsed, applied
     by no runner;
  2. parity: with both unset, `parseReviewConfig()` returns the same config
     and no warning (tested), `estimateCostUsd` returns bit-identical
     numbers (so `run.ts:749-751`, `ai-review.ts`, `github.review.ts:459`
     and the projection compute the same), and the runner suites pass
     unchanged;
  3. evidence: above;
  4. variant: `engine:trivial-skip` stays pending "VS-24 wiring" and
     `VARIANT_KEYS` is unchanged; the replay refuses a variant setting
     `trivial` (tested). VS-40 has no variant (addendum §1a);
  5. desktop: a documented difference until wiring. `classifyTrivial` and
     the token estimate arrive with VS-24 wiring in `ai-review.ts`; the
     desktop has no dollar cap (`ai-review.ts:110`), so `remainingUsd` does
     not apply there until VS-10 and Q32; its eval adapter writes
     `variant.applied: false`;
  6. this entry.
- **Owner questions: none decided.** Q11 (manifests and lockfiles stay
  never-trivial, the stricter answer [GU22]), Q13 (no wiring), Q15 and Q18
  (proposals; only uncalled code), Q32 (no desktop cap), Q9 (other step-cap
  fractions only in projections or the funded ablation); Q3 is unaffected.
  The step-cap ordering tension (critique 9) and the prompt-injection
  residual are raised for the owner.
- **Deferred to the runner-wiring window or later.**
  - `Review.run`'s trivial skip, its zero-attempt outcome, note and the
    `trivial` outcome marker `verdict.ts` reads; `RunInput.forceFull`;
    `ReviewOutcome.partial` and `Stop` gaining `budget-estimate`;
    `format.ts` notes and "Not reviewed"; CLI `review.ts`; the `ai-review.ts`
    half; the GitHub trivial skip through `decideSkip` after the @vector
    merge.
  - The pre-dispatch check before the specialists fan out
    (`run.ts:689-695`), the shrink loop and its levers (diff trim now;
    lenses, cards and dependents with VS-28, VS-26 and VS-25), the verify
    `PassPlan` bounded at max(4, 2 · maxComments), first-prompt token
    counts (chars / 3.5, or the serving provider's count on an allowed
    route, C-12), and writing `artifact.dispatch` and `artifact.shrink`.
  - The callbacks' providers: `referencesOldPath` and `referencedByCode`
    (`git grep` of the head tree-ish), `docText` (`ReviewSource.show` at
    base and head), `comments` and `strings` (VS-25a), and `sensitive`
    fed with the engine config's `instructions` globs, the repository's
    ignore globs and linguist attributes, and symlink, submodule and
    executable modes, none of which `DiffFile` carries.
  - Flipping `engine:trivial-skip` and `VARIANT_KEYS`; replaying trivial
    controls with trigger `auto`; VS-24 item 5 (static-prefix pin, cache
    shares, the fan-out variant).
  - Addendum §3 VS-24 payload rules (byte cap, commit-message thinning,
    1,024-character subject truncation, "not included" warnings).
  - `RunInput.spent` and the GitHub prior-spend wiring (VS-40 item 3, after
    `vector-at-mention`), the 5 s fan-out hold (item 4), the VS-21c report
    fields including v2 in the report summary (item 5), re-review
    budgeting (VS-41), the desktop cap (Q32), and making v2 the gate, only
    if the pilot shows a median error at least 5 points lower.
  - Recalibrating `estimateCostUsd` on replay data before the check leaves
    opt-in.
  - `script/vectorscope-eval/dataset.ts:64` keeps its own copy of
    `TRIVIAL_KINDS` (identical); importing core's waits for an eval-script
    package.
- **Deferred verification.** Phase A (0 bug cases trivial, at least 80% of
  trivial controls skipped at 0 tokens) needs wiring and a replay of the
  curated controls (VS-22b); estimate error against settled cost needs the
  D7 pilot. Parser-dependent rules are tested on a fixture lexer's ranges
  only. The strict rules (reference checks on every doc, indented blocks,
  any indentation in rst and adoc, every dot path) will lower the skip
  rate; Phase A measures by how much.
- **Residuals** (not caught today; none decided):
  - symlinks: `DiffFile` carries no mode, so a `.md` symlink retargeted at
    another file reads as a docs change (wiring passes modes through
    `sensitive`); likewise a rename that also changes the mode;
  - computed module or doc paths a `git grep` cannot see (dynamic imports
    by template, `require` of a built name, a doc read by a joined path);
  - added or removed comment and blank lines shift line numbers seen by
    line-sensitive tests and stack traces;
  - **prompt injection through skipped text:** a comment-only or docs-only
    skip lets text that later reviews read as context (comments, README,
    docs) reach the base unreviewed, including text aimed at later
    reviews. The contract allows these skips; the HTML-comment, hidden and
    tag-character refusals narrow it, but plain visible prose is not
    checked. For Q11- and Q18-adjacent owner review.
- **Review fixes (2026-11-06, round one).** Thirteen findings, three of
  them blocking; all taken, four in a different form (below). Nothing is
  committed.
  1. *A comment line after a backslash continuation* (blocking): taken.
     `commentRefusal` refuses `line-continuation` when any hunk line ends
     in a backslash once trailing spaces and tabs are dropped, right after
     `hasContext`, as the whitespace path already did. Fixture: the
     review's Python probe (a `# two` line inserted after `x = 1 + \`),
     which `ast.parse` rejects, now gives `line-continuation`.
  2. *Comment changes that alter the build* (minor): taken, more widely.
     `@deprecated` is in the global `DIRECTIVES`, not only Java's extras,
     since TypeScript's `no-deprecated` lint rules fail on it too, and Go
     gains `Deprecated:` (staticcheck SA1019). The cgo residual is closed
     by the structural rule the review offered, not by a `hasCgo` fact: in
     Go the line after each comment run that holds a changed line, or that
     a changed blank line borders, must be in the hunk (where `directive`
     sees an `import "C"`), else `hunk-context`. Run ends come from the
     whole file's comment ranges. Fixtures: a plain-C preamble edited four
     lines above `import "C"`, a blank line that splits a preamble, and the
     cost case below.
  3. *A self-default `maxSteps`* (minor): taken; `maxSteps: 31` now must
     move the digest.
  4. *A tautological runtime expect* (minor): taken; the `SkipReason` test
     keeps the assignment and adds an `@ts-expect-error` for a misspelled
     reason, so it tests only types.
  5. *A coverage check fed by earlier tests* (minor): taken in the table
     form. `EXAMPLES: Record<TrivialRefusal, () => TrivialDecision>` holds
     one self-contained example per code, so a new code without one is a
     type error, and the test runs alone (checked with
     `--test-name-pattern`). The module-level `seen` set is gone.
  6. *Style* (minor): taken. `docCodeLines` is a reduce over `{ close, run,
     code }`; `mapBack` and its non-null assertion are gone (item 10's
     mapper replaces it and `mapLine`); `types.ts` exports one widened view,
     `OPTIONAL_REVIEW_DEFAULT_OF`, for `config.ts` and `model-evidence.ts`.
  7. *The rename-to-drop destructure* (minor): taken in a different form.
     `applied` is derived from the list by deleting each
     `UNAPPLIED_REVIEW_KEYS` key from a copy of the parsed config, which
     stays typed without a cast (`Object.fromEntries` would need one), and
     the list moved to core so the engine, the parser and the digest share
     it.
  8. *Unbounded pattern work* (blocking): taken. New refusal `long-line`
     (`MAX_LINE_CHARS` 2,000) for any hunk line, context included, checked
     in `linesRefusal` before any pattern reads a line; `trimEnd` walks
     back over spaces and tabs only (no other whitespace, as before)
     instead of `/[ \t]+$/`; the tag rule is `/<\s*(?:\/\s*)?(script|...)\b/i`.
     Beyond the finding, the event-handler rule reads each tag once
     (`<letter` to its `>`, then `\son[a-z]+\s*=` inside it), since
     `/<[a-z][^>]*\son.../` rescans the rest of the line from every `<`.
     Lines outside the hunks (a doc's whole text, a comment range's other
     lines) are not capped: every pattern that reads them is linear. Probe
     on the new code (`/tmp/vector-vectorscope/vs24c-fix/bench/`, not
     committed): a 1 MB line of spaces then `x` in a `.ts` hunk is refused
     in 19 ms; a `.md` whose text outside the hunk holds 1 MB lines of
     `<a` and `< ` classifies in 62 ms. Fixtures: the 2,000-character
     boundary both ways, a 100,000-space changed line, a 50,000-space
     context line and a 100,000-character `<a` doc line.
  9. *A lane-rule violation in a fixture* (blocking): taken. The
     free-model fixture is `vector/free-model`; a case-insensitive grep of
     the diff and the new files for the forbidden name finds nothing.
  10. *Quadratic comment structure* (minor): taken. Each side's comment
      ranges are indexed once by line (`indexComments`: the pieces on each
      line in source order, and each comment run's last line), and
      `commentOnly`, the touched-range directive check (now deduplicated),
      the Rust and Go test checks and `sameStructure` read the index.
      `otherSide` maps lines in either direction by bisecting the hunks'
      spans and reading their lines from a map, and string ranges are a
      sorted list with running maximum ends, read by bisection. A `.ts`
      file of 120,000 lines with 60,000 one-line comments and 3,000 comment
      hunks classifies in 257 ms. The optional range-count cap is not
      taken: with the index the work is linear in the comment text the
      provider returns, which VS-25a bounds by the file.
  11. *A scope that claims an unapplied policy* (minor): taken.
      `policyDigest` reads every `UNAPPLIED_REVIEW_KEYS` key as absent, so
      no value of `trivial` moves any runner's scope before wiring (critique
      8's third bullet is rewritten above). Its default-stable branch is
      still exercised: the unapplied key reaches it as absent, and dropping
      the absent case breaks the pinned `70512122f41ec160`.
  12. *Per-PR spend on a command review* (minor): taken. `spent` carries
      the trigger, and the per-PR term applies only to `auto`, as in
      `decideSkip`; the month cap applies to every trigger. Tests: a
      `command`, `local` or `desktop` review past the per-PR cap keeps
      `maxCostUsd` and goes, and an automatic one stops with
      `budget-estimate`.
  13. *Denylist gaps* (minor): taken, each with a fixture:
      `//lint:ignore` and `//lint:file-ignore`, `pytype:`, `rome-ignore`;
      `AGENTS.*.md` (`AGENTS.override.md`), `WARP.md`, `QWEN.md`.
  - **What the fixes cost the skip rate** (for Phase A to measure, none
    decided): a Markdown paragraph written on one line longer than 2,000
    characters is refused; a Go comment change more than the diff's
    context above the end of its comment run is refused (tested: the first
    line of a five-line doc comment), whether or not the file uses cgo; a
    backslash at the end of any hunk line refuses a comment hunk, near the
    change or not; `@deprecated` refuses a comment hunk in every language.
  - Mutation check of the fixes: 22 mutations, each restored byte for byte
    (`cmp`); 21 broke at least one test: the comment-path continuation
    guard, the long-line check, the Go preamble check on each path, its
    run lookup and its blank-neighbour lookup, `@deprecated`, Go
    `Deprecated:`, `lint:ignore`, `pytype:`, `rome-ignore`, `WARP.md`, the
    event-handler rule, the mapper's offset after a hunk, its in-hunk
    lookup, a string range's end read as inclusive, a doc line marked one
    off, a doc block that never closes and a doctest run a blank line does
    not end (these two survived at first and broke once new positive
    fixtures were added: prose after a closed fence, after a closed HTML
    comment and after a doctest's blank line), the unapplied key counted
    in the digest (two tests) and an absent optional key counted. One
    survives by design: counting an optional key set to its own default,
    which no applied policy key can show until VS-24 wiring takes
    `trivial` off `UNAPPLIED_REVIEW_KEYS`; the wiring package's digest test
    (`"review"` equal to absent) covers it then.
- **Evidence.** Each file ran alone through the lock with `--timeout
  30000`, `GITHUB_ACTIONS=false`, and `TMPDIR` and XDG roots under
  `/tmp/vector-vectorscope/vs24c/`:
  (the review fixes under `/tmp/vector-vectorscope/vs24c-fix/`; counts are
  after them)

  | Where | File | Pass |
  |---|---|---|
  | core | `test/review/trivial.test.ts` | 44 (new; 275 expects) |
  | core | `test/review/dispatch.test.ts` | 22 (new) |
  | core | `test/review/plan.test.ts` | 21 (3 added) |
  | core | `test/review/config.test.ts` | 41 (6 added) |
  | core | `test/review/skip.test.ts` | 12 (1 added) |
  | core | `test/review/model-evidence.test.ts` | 18 (1 added; pin updated) |
  | core | `verdict`, `pipeline`, `ignore`, `diff`, `format`, `state`, `eval` | 44, 2, 13, 45, 46, 42, 42 (unchanged) |
  | engine | `test/review/eval.test.ts` | 27 (1 added, 3 extended) |
  | engine | `test/review/run.test.ts`, `test/cli/github.review.test.ts`, `test/review/vectorscope-replay.test.ts` | 44, 40, 13 (unchanged, I-1) |
  | app | `src/features/pull-requests/ai-review.test.ts` (`--preload ./happydom.ts`) | 107 (unchanged) |
  | eval scripts | `script/vectorscope-eval/replay.test.ts` | 32 (unchanged) |

  - `trivial.test.ts` builds each fixture from base and head texts through
    a small LCS diff helper read back by `parseUnifiedDiff`, plus
    `fromGitHubFiles` for GitHub shapes, with comment and string ranges
    from a fixture lexer. Every contract fixture (a directive comment, a
    Python indentation change, an `.mdx` component, a `requirements.txt`
    bump, an import-breaking rename, a case-only rename) is non-trivial
    with the most generous callbacks. The last test runs `EXAMPLES`, one
    self-contained example per code in `TRIVIAL_REFUSALS`, typed so none
    can be missing, and checks each gives exactly its code. Invisible and
    control characters are built with `String.fromCodePoint`, never
    written into a source file.
  - `bun typecheck` passes in core, engine, app and desktop, and so does
    `tsgo -p ../../script/vectorscope-eval/tsconfig.json`.
  - prettier passes on all fifteen changed files. oxlint reports no warning
    on `trivial.ts`, `dispatch.ts` and their tests; the warnings left in the
    other changed files are on lines this package did not change.
  - **Mutation check.** 39 mutations each broke at least one test, and the
    file was restored byte for byte after each (`cmp`):
    - `trivial.ts` (24): `isSensitivePath` dropped; the dot-path rule
      dropped; `.mdx` allowlisted; the directive list dropped; the
      comment-structure check skipped; leading whitespace compared loosely;
      case-only renames allowed; hidden characters in lines, control
      characters, generated markers, the whole-doc check,
      `referencedByCode`, the patch-completeness check, the Rust doc
      extra, the code rename's reference check, the agent-file rule, the
      whitespace language gate and the dependency rule each dropped; a
      string range's end read as inclusive; hunk context always accepted;
      Go test-file comments allowed; rename-into-ignored dropped for code;
      the MDX rules dropped; a line with code beside its comment read as a
      comment;
    - `dispatch.ts` (7): deciding on the high estimate; deciding on v2; a
      step cap above the current cap; step-cap levers always acting;
      `remainingUsd` keeping caps of 0; the token cap ignoring unpriced
      passes; v2 ignoring the `cached` flag;
    - `plan.ts` (3): the legacy write price taking `cacheWrite`; the legacy
      output per step drifting to 1,800; a share applying without a
      cache-read price;
    - `model-evidence.ts` (1): the default-stable digest broken
      (`trivial: "review"` counted; superseded by the review fixes'
      digest mutations above);
    - `config.ts` (2): the "not applied" warnings dropped; the warning
      naming no default;
    - engine `eval.ts` (2): the base config's VS-24 keys kept; the
      `input.config` refusal dropped.
  - The full root typecheck was not run: nothing is pushed.
  - Nothing was sent to a model, no paid path ran, no workflow was
    dispatched, no dependency was added, and no user-visible string
    changed (D14); the two new warnings appear only when a new key is set
    to a value that would change a review.

## 2026-11-06 · VS-25a Pinned tree-sitter parser and grammars

Contract §4 VS-25a items 1 to 5 and its extractor decision; addendum A VS-38
item 5 (parser safety) and §3 VS-25 "No whole-repository parse"; the Now
window of contract §5 and addendum §4. Built at `5a16dfaf`. VS-25 is a
proposal pending Q15 (and "VS-25 supersedes VS-17" is pending sign-off),
VS-38 one pending Q18, so nothing calls the new parser: no runner, CLI, app
or desktop file imports `review/parse.ts`, no `ReviewConfig` key was added,
and `run.ts`, `ai-review.ts`, `provider.ts`, `session/llm.ts`, `posting.ts`,
`prompt.ts`, `types.ts`, `config.ts`, `trivial.ts`, `symbols.ts`,
`brain/code.ts`, `workflow.ts`, `command.ts`, `cli/cmd/github.*`,
`cli/cmd/review.ts`, `github-*.ts`, `vectorscope.astro` and
`script/vectorscope-eval/*` are untouched. It implements the VS-25a plan as
corrected by its critique: all sixteen critique points were taken, three of
them (2, 3 and 8) in a different or stronger form (below). Nothing is committed (the lane brief
overrides the plan's commit step).

- **What landed.**
  - **New `packages/engine/src/util/tree-sitter.ts`**: `resolveWasm` and the
    lazy `runtime` (one `Parser.init` per process), moved verbatim from
    `tool/shell.ts`, plus the process-wide poisoned flag (`poison()`,
    `poisoned()`; review round, below). In web-tree-sitter 0.25.10 `Parser.init` replaces the
    library's one global wasm binding (`tree-sitter.js:3776-3781`), so a
    second init would strand every parser and language loaded before it:
    the shell tool and the review parser must share one. Behaviour-neutral:
    the Node bundle is one file with no splitting, so `import.meta.url`
    resolves relative assets the same from either module (proved below by
    the Node-bundled bench loading every grammar).
  - **`packages/engine/src/tool/shell.ts`**: imports `TreeSitter` and calls
    `TreeSitter.runtime()` and `TreeSitter.resolveWasm(asset)` in `grammar`;
    the local copies and the now unused `fileURLToPath` import are gone.
    Its `parse` also treats a poisoned runtime as a command it cannot parse
    (review round, below); nothing poisons the runtime until VS-25b wiring,
    so the shell behaves as before. Nothing else changed.
  - **New `packages/engine/src/review/parse.ts`** (`ReviewParse`, pinned):
    - `PARSE_LANGUAGES` (typescript, tsx, javascript, python, go, rust,
      java), `PARSE_EXTENSIONS` (exactly VS-24c's sets: ts tsx mts cts js
      jsx mjs cjs go rs java py pyi), `REPORTED_LANGUAGES` and
      `REPORTED_EXTENSIONS` (c, cpp, csharp, php: refused with a `reported`
      field so VS-38 can count them separately, VOI13), `languageOf` and
      `reportedOf` (trivial.ts's extension rule, `Object.hasOwn` so
      `x.constructor` is no language).
    - `GRAMMARS` (package, exact version, wasm file, ABI), `QUERY_VERSION`
      (1), `RULES` per language, `ROLES`, `querySource`.
    - `PARSE_LIMITS` = `{ inputBytes: 1_048_576, grammarBytes: 4_194_304,
      parseMs: 1_000, extractMs: 2_000, depth: 16_384 }`.
    - `DEFINITION_KINDS`, `REFERENCE_KINDS`, `PARSE_REFUSALS` (language,
      binary, too-large, grammar, timeout, nesting, capture-count,
      parser-error) and the records `ParsedDefinition` (name, kind, 1-based
      inclusive lines, exported, signature, container?, aliases?),
      `ParsedReference` (name, line, UTF-16 column, kind, enclosing?),
      `ParseInput` (path label, text, names?, deadline?), `ParsedFile`
      (hasError, error lines, definitions, references, VS-24c's
      `CommentRange[]` and `SourceRange[]`, depth, parseMs, walkMs,
      extractMs) and `UnparsedFile` (the VS-38 unsupported-file record:
      because, detail of at most 200 characters, never source text).
    - `grammar(language)` (path, bytes, ABI; for tests and the bench) and
      `parse(input, limits?)`, an `Effect<ParseResult, never>`.
  - **`packages/engine/package.json`**: exact runtime pins
    `tree-sitter-go` 0.25.0, `tree-sitter-java` 0.23.5,
    `tree-sitter-javascript` 0.23.1, `tree-sitter-python` 0.25.0,
    `tree-sitter-rust` 0.24.0, `tree-sitter-typescript` 0.23.2;
    `web-tree-sitter` stays 0.25.10.
  - **`bun.lock`**: re-resolved through the local ghserve. The diff is the
    six workspace entries, the six packages and six nested
    `node-addon-api@8.8.0` entries; nothing else moved, and
    `bun install --frozen-lockfile` then passes. Each tarball's sha512
    equals the one fetched for the plan probe. All six were published
    between 2024-11 and 2025-09, well past `minimumReleaseAge`.
  - **`DEPENDENCY_NOTICES.md`**: regenerated with `bun
    script/dependency-notices.ts` (1,108 packages); the diff is the six MIT
    sections only. `licenses/dependencies/` and `platform-notices.json` are
    unchanged (below).
  - **New `packages/engine/script/vectorscope-parse-bench.ts`**: the
    throughput bench (git ls-files, the round-two parsebench seed-7
    shuffle, `--limits default|generous`, `--min-bytes`, `--names`; one
    JSON line, no file written; Node-API only, so it also runs bundled for
    Node). Nothing calls it.
  - **Core pin**: `REVIEW_PIPELINE_FILES` gains
    `packages/engine/src/review/parse.ts`, and its comment now names the
    parser and says why `util/tree-sitter.ts` and `shell.ts` stay out (the
    runtime init decides nothing a review finds). `REVIEW_PIPELINE_SOURCES`
    `a3cb5477a0a829b7` → `244e9c3d52f44f83` (`dc0ce0af6fd47a55` before the
    review round). `REVIEW_PIPELINE_REVISION`
    stays 1: no runner reads the parser.
  - **New `packages/engine/test/review/parse.test.ts`** (53 tests, below).
- **Grammar choice.**
  - The per-language upstream packages, not `@vscode/tree-sitter-wasm`
    0.3.1: each grammar version is explicit (the future fact cache keys on
    blob, grammar version and query version), they follow the shell's
    pattern, and the contract names them. Six of the seven `.wasm` files
    are byte-identical (sha256) to @vscode's; @vscode's Rust build differs
    and states no grammar commit.
  - `tree-sitter-javascript` 0.23.1, not 0.25.0: `tree-sitter-typescript`
    0.23.2 depends on `^0.23.1`, so one copy is installed and the two
    grammars share their 0.23 node names.
  - ABIs under 0.25.10 (which reads 13 to 15), checked at load and pinned
    in `GRAMMARS`: TypeScript 14, TSX 14, JavaScript 14, Python 15, Go 15,
    Rust 14, Java 14. Every grammar loads under Bun and under the Node
    bundle (Node 22.23.4).
  - Not added to the root `trustedDependencies`: their `install:
    node-gyp-build` builds only a native binding this code never loads, so
    bun's blocked-postinstall notice is expected. The prebuilds sit unused
    in `node_modules`, as `tree-sitter-bash`'s do. Never `tree-sitter-wasms`
    (a test asserts it is absent).
  - Licence entries: all six packages ship a LICENSE, so their entries are
    the regenerated `DEPENDENCY_NOTICES.md` sections.
    `licenses/dependencies/*.txt` holds overrides only for packages that
    ship no licence text, and `script/dependency-notices.ts:389-395` fails
    on an unused override, so adding one would have broken generation.
- **How the parser works, and why it differs from the plan's shape.**
  - **One query per language of bare one-node patterns**, `(type) @role`,
    one per node type (13 roles: definition, comment, string, reference,
    call, import, wrapper, scope, container, decorator, assignment, default,
    error),
    instead of the plan's three structured queries. A bare pattern
    completes on the node it starts on, so the query holds no match in
    progress (probed: `matchLimit: 1` returns every capture), and every
    capture can be counted against the tree.
  - **The capture-count check** (critique 3, stronger form). The iterative
    depth walk, which always runs (critique 9: no `DEPTH_SLACK` shortcut),
    also counts the nodes of every queried type through a per-language
    `Uint8Array` of type ids. A query that returns any other number of
    captures is refused as `capture-count`, so a silent drop, whatever its
    cause, can never yield a short record. On about 21,000 real files in
    seven languages (below) it never fired.
  - **No parent or sibling calls.** tree-sitter finds a node's parent by
    walking down from the root, which is quadratic over a wide file, so
    one sweep over the captures in document order keeps a stack of the
    definitions, wrappers, scopes, imports and containers around each
    capture. Module scope, containers, export wrappers, import regions and
    enclosing definitions come from that stack; callees from bare call
    anchors whose callee field ends where the identifier does; decorator
    and attribute runs from adjacency with only whitespace and comments
    between. A pre-pass gathers what only the whole file says (export
    clauses, `module.exports`, `__all__`, Rust trait visibility).
  - **Separate parse and extraction boxes** (critique 6): `parseMs` 1,000
    (G1-8: no parse over 290 ms in about 30,000 files) and `extractMs`
    2,000, about ten times the slowest real file at or above 256 KiB
    (202 ms, vscode, Bun), which still lets a 1 MiB numeric array (1.4 s)
    through. A caller's `deadline` bounds both. Every test not about time
    passes generous boxes.
  - **0.25.10's `captures()` never calls its progress callback** (new
    finding). Probed on G1-15's chain: 0 calls in `captures()` against
    1,552 in `matches()`, and the query ran 38.4 s. `timeoutMicros`, which
    0.25.10 honours, stopped the same query at 533 ms, so the extraction
    box goes in as `timeoutMicros` (clamped to at least 1, since 0 means no
    limit), with the callback kept for versions that call it. The parse's
    progress callback does work (a 70,000-line file refused within 2 s at
    `parseMs: 1`).
  - **Signatures never hold a value** (critique 4; corrected in the review
    round): variables, consts, statics and fields end before their
    initialiser (name, type annotation and modifier keywords; Java
    annotations are left out, since their arguments are literals);
    functions and methods run to their body, and every parameter default in
    a TS, JS or Python head reads `…`: TS/JS `assignment_pattern.right` and
    `object_assignment_pattern.right` (destructured defaults included), the
    `value` of TS `required_parameter` and `optional_parameter`
    (constructor parameter properties included), and Python
    `default_parameter.value` and `typed_default_parameter.value`. A Python
    head stops at its own colon, so a comment after it stays out.
    Whitespace collapsed; 240 UTF-16 units, never cut inside a surrogate
    pair. The first version said "a token-shaped literal ... never appears
    in any signature", but its fixtures held tokens only in variables and
    fields: a default parameter value (`connect(key = "<token>")`, a TS
    constructor parameter property, an arrow's default, Python
    `def f(token="<token>")`) was copied verbatim. Now token-shaped
    defaults sit in the TS, JS and Python fixtures and no signature holds
    one. Still verbatim, since none is a value a variable or parameter
    holds: decorator and annotation arguments inside a parameter list
    (`@Inject("x") k`, Java `@Named("x") String k`), Python class keyword
    arguments (`class A(B, key="x")`), TS literal types and Go struct tags.
    VS-34's in-place redaction still applies at wiring.
- **Export rules** (critique 5, all taken; what VS-25b greps).
  - TS/JS: a direct `export` wrapper; or, at module scope, a name in an
    export clause, `export default name`, `export = name` or, in
    JavaScript, `module.exports = name | { a, b: c }`; `exports.x =` and
    `module.exports.x =` are exported definitions, and so is
    `module.exports = class Foo {}` or `= function named() {}` (named after
    its value, alias "default"; "default" when it has no name). An export
    clause's `as` name, and "default", go into `aliases`. Anonymous default
    exports are a definition named "default". Only the members directly in
    a class or interface body are recorded (not an object literal's or a
    type literal's methods); a member is exported when its class or
    interface is exported and it is neither `private` nor `#private`
    (protected counts), and an anonymous class's members are in no
    container. Members of a namespace follow the namespace, and every
    declaration in a `declare module "name"` is exported.
  - Python: no leading underscore, dunders public; class members follow
    their class; definitions inside functions are local; a module-level
    `__all__` list or tuple of strings decides module exports.
  - Go: an upper-case first rune, at top level (local types are not).
  - Rust: any `pub` but `pub(self)` and `pub(in self)`; a trait's methods
    follow the trait; methods of `impl Trait for T` follow `Trait` when it
    is declared in the file, and are exported otherwise (an outside trait,
    such as `Display`). Private items that child modules reach through
    `super::` are not marked exported.
  - Java: not `private`, not local, and a container that is exported
    (package-private is visible to the package's other files).
- **Additions beyond the contract text, and smaller decisions.**
  1. The shared runtime and the `shell.ts` edit, forced by the single init;
     the contract's Files list does not name them.
  2. String ranges and `errors`: VS-24c's `strings` callback needs them.
     TS `template_literal_type` counts as a string (a whitespace edit inside
     one changes the type, so refusing is safer); so do Python f-strings and
     implicit concatenations, Rust byte, raw and C strings, Go raw strings,
     Java text blocks and JSX attribute strings; char and rune literals and
     regular expressions do not. A comment inside a template substitution is
     a comment. A comment's text keeps any `\r`, which trivial.ts strips.
  3. `names`, `deadline`, `container`, `aliases`, reference `kind` and
     `reported`, shaped for VS-25b and VS-38. `names` is a filter on the
     output only: on vscode it changed total throughput from 3.13 to
     3.11 MB/s, and on a 1 MiB identifier-dense file it saved 14% of
     extraction, because `captures()` converts every capture first.
  4. The depth limit, 16,384, four times under the 65,536 levels past which
     0.25.10's query cursor drops captures. Reproduced here: a 70,000-deep
     array with the limit lifted is refused as `capture-count`, while a
     flat file of 70,000 identifiers returns all 70,000 references (no
     capture-count cap in a wide, shallow file; critique 3). Bumping
     web-tree-sitter past PR #6038 stays a separate decision.
  5. `match-limit` dropped from the refusals (critique 2, second form):
     no pattern can hold a match in progress, so the limit cannot be
     reached; the capture count covers any drop.
  6. A wasm trap or abort (`WebAssembly.RuntimeError`) poisons the shared
     runtime for the process (`TreeSitter.poison()`): every later file is
     `parser-error`, detail `runtime-disabled` (critique 7), and the shell
     tool's `parse` refuses every later command (review round). The runtime
     is shared with the shell tool's command parser, which feeds its
     permission scan, so before the round a trap would have left that scan
     on a runtime that may misread a command without failing. The chosen
     interim option is the shared flag: the shell then throws "Failed to
     parse command", its existing path for a command with no tree, so the
     tool call fails closed (stricter than the finding's "ask for
     permission", which would need a scan with no tree). A synchronous
     parse of up to 1 s per file still blocks the event loop; whether to
     parse in-process or in a Worker (which would also isolate the shell's
     runtime) stays for the runner-wiring window, not decided here.
  7. Other throws (a non-string input, a throwing `names`) become
     `parser-error` with the error's name as the detail, never its
     message; the parser is reset before every parse, so a cancelled or
     failed parse never resumes into the next file.
  8. Grammars: the `.wasm` path and size are cached once found, and a
     failed import, stat or read resets its lazy, so a transient error is
     retried on the next file; an ABI mismatch or query compile error stays
     cached (deterministic). The grammar cap is checked from `stat` outside
     the lazy, with the file's read length when `stat` fails (review
     round), and the read is checked against that size (critique 10). A
     load failure's message (at most 200 characters, never source text) is
     the refusal's detail.
  9. Resources (critique 11): a timed-out parse returns no tree and is
     handled before extraction; the release deletes the tree when there is
     one; the cursor has its own nested `acquireUseRelease`. The comment
     states the real invariant (each `parse()` and query call is
     synchronous, and a finished tree no longer depends on its parser).
  10. Recorded as definitions, beyond the plan's list: TS/JS class fields
      (as Java fields are), anonymous default exports and CommonJS
      exports. Not recorded: destructured declarations, chained Python
      assignments past the first target, module-level Python assignments
      inside `if` blocks, and object or type literal methods. Rust doc
      comments do not open a definition's span; attributes do.
      `container` names only what a definition is directly declared in:
      nothing for a definition in a function body (TS, Python, Rust), an
      anonymous class's members (TS, Java) or a Java local class.
  11. Plan deviation: the plan's commit step (§6 step 10) was not done; the
      lane brief says not to commit.
- **Critique points**: 1 (catch the whole per-file body, including the
  grammar load and every helper, as one `Effect.catchDefect` boundary;
  tests for a non-string input and a throw inside extraction after a real
  parse, each asserting a Success exit); 2 (second form, item 5); 3
  (stronger form: the runtime capture count plus both fixtures); 4; 5; 6;
  7; 8 (the 16,000-deep fixture, a query-box test, and the `timeoutMicros`
  finding); 9; 10; 11; 12 (the RSS test uses a large numeric array,
  `Bun.gc(true)` before each sample and generous boxes; the poisoned-repo
  checks run in one fresh subprocess); 13 (the extension-family test, the
  pinned disagreement table, `fallback` renamed `reported` with its
  meaning documented); 14 (a CRLF trivial-contract test and the string
  variants); 15 (the pin comment); 16 (binary size measured, below). None
  was rejected.
- **BrainCode cross-check** (critique 13). Every parsed extension is the
  same family in `BrainCode.language`. On the fixtures, the two readers'
  exported names differ only as pinned in the test:
  - TypeScript: the parser alone exports `Internal` (export clause),
    `Open` and `value` (namespace), `ambient` and `declared` (ambient
    module), and the members `area`, `label`, `onClick`, `run` and `shown`
    (BrainCode never exports a method);
  - JavaScript: the parser alone exports the CommonJS exports `VERSION`,
    `read`, `write`, `hidden`, `shown` and `Cache` (from
    `module.exports = class Cache`), and `Cache`'s member `put`;
  - Python: the parser alone exports `__init__`, `label` (members) and
    `_forced` (`__all__`); BrainCode alone exports `API_KEY`, `unlisted`,
    `connect` and `Holder`, which `__all__` leaves out;
  - Go: none;
  - Rust: the parser alone exports `call` (trait method), `deep` (`pub` in
    a module) and `fmt` (`impl Display`); BrainCode alone exports
    `pub(self) fn private_fn`;
  - Java: the parser alone exports the package-private and member
    definitions (`Api`, `LIMIT`, `Mode`, `Nested`, `PackagePrivate`,
    `Spawner`, `block`, `call`, `count`, `m`, `shown`, `spawn`).
  - These are BrainCode's regex limits, not a third reader: the import
    graph stays BrainCode's (extractor decision), and VS-25b decides where
    the parser's answer replaces `symbols.ts`.
- **Throughput, Bun 1.3.14** (this machine: 4 vCPU, warm cache; 4,000-file
  seed-7 samples, or the whole set when smaller; default limits; parse and
  extraction together; trees deleted after each file). Inputs, cloned
  `--depth 1` (blobless, sparse where noted) into scratch, not committed:
  kubernetes `671745e4` (Apache-2.0, `pkg cmd staging`), keycloak
  `30cf6834` (Apache-2.0, `*.java`), rust-lang/cargo `111443f3`
  (MIT/Apache-2.0), django `d9d05f10` (BSD-3, `django tests`),
  nodejs/node `9d8a9adf` (MIT, `lib`), vscode `50bea175` (MIT, `src`), and
  this repository at `5a16dfaf`. No GPL repository was used (Q26).

  | Repository, files | Parsed | MB | Parse MB/s | Total MB/s | p95 / p99 / max ms | Walk share | Error trees | Peak RSS |
  |---|---|---|---|---|---|---|---|---|
  | kubernetes, .go | 3,999 (+1 too-large) | 35.8 | 7.07 | 3.34 | 9.7 / 32.6 / 121 | 14% | 1% | 276 MB |
  | keycloak, .java | 4,000 | 23.5 | 7.68 | 3.49 | 6.1 / 15.1 / 51 | 12% | 0% | 270 MB |
  | cargo, .rs | 1,379 | 10.3 | 5.62 | 2.92 | 11.7 / 33.2 / 70 | 12% | 38% | 259 MB |
  | django, .py | 2,922 | 18.5 | 6.34 | 2.96 | 8.5 / 25.6 / 125 | 13% | 0% | 272 MB |
  | node lib, .js | 434 | 5.7 | 6.53 | 2.94 | 15.1 / 27.8 / 51 | 13% | 0% | 337 MB |
  | vscode, .ts | 3,999 (+1 too-large) | 58.9 | 6.63 | 3.02 | 16.0 / 45.4 / 339 | 14% | 0% | 353 MB |
  | this repo, .ts | 3,953 (+1 too-large) | 35.2 | 5.80 | 2.66 | 12.0 / 23.9 / 127 | 14% | 0% | 306 MB |
  | this repo, .tsx | 601 | 6.5 | 5.42 | 2.41 | 14.2 / 35.8 / 99 | 15% | 1% | 257 MB |
  | this repo, JS family | 178 | 1.6 | 4.64 | 1.92 | 13.5 / 39.9 / 57 | 16% | 0% | 266 MB |
  | this repo, .py | 225 | 2.9 | 4.55 | 2.09 | 25.2 / 37.7 / 69 | 15% | 0% | 255 MB |

  No timeout, nesting or capture-count refusal in any run; the only
  refusals are files over 1 MiB. Grammar load: 31 to 62 ms each. RSS with
  every tree deleted stays at 255 to 353 MB, against round one's 770 MB
  with all trees held. The cargo error trees are almost all one grammar
  quirk: `str![...]`, a macro named like the primitive type `str` (cargo's
  snapshot macro; the first error line of at least 465 of the 525 files),
  plus cargo-script frontmatter (`---` blocks and `#![feature(frontmatter)]`);
  error recovery still yields their definitions.
- **Throughput, Node 22.23.4** (the bench bundled with `bun build
  --target=node`; the seven grammars and the runtime emitted as assets and
  found through `resolveWasm`'s relative path):

  | Repository | Parse MB/s | Total MB/s | p99 / max ms | Walk share | Peak RSS |
  |---|---|---|---|---|---|
  | kubernetes .go | 5.80 | 2.28 | 42.6 / 162 | 25% | 210 MB |
  | keycloak .java | 6.35 | 2.40 | 21.5 / 56 | 22% | 181 MB |
  | cargo .rs | 4.89 | 2.18 | 40.5 / 86 | 22% | 168 MB |
  | django .py | 5.42 | 2.18 | 35.8 / 158 | 23% | 196 MB |
  | node lib .js | 5.65 | 2.21 | 43.5 / 61 | 26% | 158 MB |
  | vscode .ts | 5.58 | 2.15 | 61.0 / 505 | 25% | 293 MB |
  | this repo .ts | 4.82 | 1.86 | 34.3 / 218 | 25% | 200 MB |
  | this repo .tsx | 4.98 | 1.90 | 49.7 / 139 | 28% | 175 MB |

  Parse-only throughput (4.8 to 7.7 MB/s on both runtimes) is in line with
  G1-8's 4 to 10 MB/s (Node, parse only). Round one's 4.75 to 4.83 s
  (0.27.1, TypeScript only, parse only) was for 2,735 files of this
  repository; its 3,953 TypeScript files now take about 6.1 s of parse time
  under Bun (35.2 MB at 5.8 MB/s), so 0.25.10 is no slower. Extraction
  roughly halves end-to-end throughput; the depth walk is 12 to 16% of a
  file's time under Bun and 22 to 28% under Node.
- **Near 1 MiB** (generous boxes, Bun): real files of 256 KiB or more
  (kubernetes 21, vscode 31, django 2, this repository 4) parse in at most
  155 ms and extract in at most 202 ms. Synthetic worst cases at 1 MiB:
  `[a,a,...]` (524,279 references) parses in 1.6 s and extracts in 2.0 s,
  so the default boxes refuse it as `timeout`; a numeric array parses in
  0.8 s and extracts in 1.3 to 1.4 s (accepted); 36,923 one-line
  declarations, 0.16 s and 0.52 s.
- **Binary and install size.**
  - Now: 0 bytes. Nothing imports `parse.ts`: no importer in any
    `packages/*/src` or `script` file, and the Node bundle's module graph
    (`bun build src/node.ts --target=node --metafile`, 4,511 inputs)
    holds `util/tree-sitter.ts` and `shell.ts` but not `review/parse.ts`,
    and emits only the runtime, bash and PowerShell wasm. (The static
    tracer `script/trace-imports.ts` was not used: it reads `./shell` as
    the `tool/shell/` folder. The CLI entry's graph was not built here: it
    needs the platform packages only `build.ts` supplies.)
  - Projected at wiring, per platform binary and per Node bundle: the seven
    grammars are 5,410,649 bytes (TS 1,413,849; TSX 1,445,638; JS 358,909;
    Python 457,883; Go 217,182; Rust 1,102,547; Java 414,641), the bundle
    emits them uncompressed, and the largest is 2.9 times under the 4 MiB
    cap. Measured on this host (linux-x64): a compiled binary of an entry
    that imports `parse.ts` is 5,455,872 bytes larger than one that
    imports only the shared runtime, Effect and web-tree-sitter. The
    desktop sidecar's Node bundle grows by the same grammars.
  - Install: 77,196,511 bytes unpacked for the six packages, mostly C
    sources and native prebuilds that are never loaded.
- **§0.3 items.**
  1. Key: none. The `impact` key belongs to VS-25b; no `EVIDENCE_POLICY_KEYS`
     or `EvidenceScope` change, so `policyDigest` and `promptsDigest` do not
     move.
  2. Parity: no runner changed; the engine runner, GitHub runner, replay,
     desktop runner and shell suites pass unchanged (evidence below).
  3. Evidence: the pin moves; the revision stays 1.
  4. Variant: none yet; `engine:impact-graph` stays pending VS-25b wiring,
     and `VARIANT_KEYS` is unchanged.
  5. Desktop: a documented difference until VS-10 (the renderer never
     imports the engine runtime, I-11); the desktop adapter keeps writing
     `variant.applied: false`.
  6. This entry.
- **Owner questions: none decided.** Q13 (runner wiring), Q15 (VS-25 and
  "supersedes VS-17"), Q18 (VS-38), Q26 (permissive repositories only were
  used). A C grammar (69% error trees on kernel-style C, G1-8) is a
  separate owner decision; C, C++, C# and PHP stay on the regex fallback.
- **Deferred to the runner-wiring window or later.**
  - VS-25b: the slice, the `impact` key, core `impact.ts`, BrainCode
    workspace and alias resolution, `<untrusted_impact>`, and replacing
    `symbols.ts` where a grammar exists.
  - VS-24 wiring: the comment and string providers into `classifyTrivial`
    (the contract test below proves the shapes fit).
  - VS-36 to VS-38: the scan plan, partial clones, the review time box
    (`deadline` is ready), `ImpactSlice` records and the separate counts of
    C, C++, C# and PHP files in the artifact.
  - The in-process or Worker decision (item 6).
  - Later: the conditional fact cache and the Actions cache.
  - Not verified here: the full `build.ts` compiled binaries (a smoke
    binary from `bun build --compile` was, in the review round), grammar
    loads on macOS and Windows (Linux x64 only), and the desktop sidecar.
- **Evidence.** Each file ran alone through the lock with `--timeout 30000`,
  `GITHUB_ACTIONS=false` and TMPDIR and XDG roots under scratch:

  | Package | File | Tests |
  |---|---|---|
  | engine | `test/review/parse.test.ts` | 53 (new; 46 before the review round) |
  | engine | `test/tool/shell.test.ts`, `test/tool/shell-sandbox-local.test.ts`, `test/tool/parameters.test.ts` | 62, 6 (+5 skipped), 60 (unchanged) |
  | engine | `test/review/run.test.ts`, `test/cli/github.review.test.ts`, `test/review/vectorscope-replay.test.ts`, `test/review/context.test.ts` | 44, 40, 13, 6 (unchanged, I-1) |
  | engine | `test/local-mode/local-run.test.ts` | 30, 1 fail (pre-existing, below) |
  | engine | `test/util/lazy.test.ts` | 3 |
  | engine | `test/compliance/generated-artifacts`, `dependency-notices`, `platform-notices`, `runtime-notices`, `node-bundle-guard`, `egress-inventory` | 2, 7, 8, 3, 3, 5 |
  | core | `test/review/model-evidence.test.ts` | 18 (pin updated) |
  | app | `src/features/pull-requests/ai-review.test.ts` (`--preload ./happydom.ts`) | 107 (unchanged) |

  - `parse.test.ts` covers: every grammar loading from the engine's own
    dependencies at its pinned ABI and version; bare patterns only; literal
    module specifiers; the grammar cap; extensions and BrainCode families;
    a fixture per language (definitions, spans, exports, containers,
    aliases, signatures, references and their kinds, comments, strings);
    no value in any signature; the 240-unit cap; UTF-16 columns; the names
    filter; CRLF comment text; syntax errors; interleaved fibers giving the
    same records; binary input; the exact 1 MiB input cap (UTF-8 bytes);
    parse, extraction, caller-deadline and query time boxes; nesting past
    the limit and G1-15's chain; a 16,000-deep fixture within the default
    boxes; G1-15's dropped capture caught by the count; 70,000 references
    in a flat file; twenty large trees leaving memory bounded; non-string
    input and a throw during extraction as records with a Success exit;
    a genuine wasm trap (a one-function `unreachable` module) disabling
    the parser and setting the shell's poisoned flag in a fresh process;
    and, from the review round: frozen tables, parameter defaults read as
    `…` (nested ones too), `module.exports = class` and `= function`,
    member containers, the Rust turbofish, `parseMs` without the grammar
    load, the 16,000-deep fixture complete under generous boxes, 48,000
    decorators or attributes within 3 s, and one stalled item turning the
    file into a timeout; grammar files planted in the working
    directory, `node_modules` and `NODE_PATH` of a fresh process never
    loaded; `classifyTrivial` over parsed ranges of a CRLF file (comment
    edit trivial, whitespace inside a template string `string-literal`,
    whitespace outside it trivial); and the BrainCode table.
  - **The one failure is pre-existing and comes from the environment**:
    `local-run.test.ts` "changes nothing with Vector Local off" lists an
    `amazon-bedrock` provider in this container, as recorded in the VS-21b
    entry; it still fails with an isolated HOME and only lists providers.
  - `bun typecheck` passes in engine (which covers `script/` and `test/`)
    and core. App and desktop are untouched.
  - prettier passes on every changed source and test file. oxlint reports
    no warning on `parse.ts`, `util/tree-sitter.ts` and the bench; three on
    `parse.test.ts`, each a deliberate cast that feeds invalid input (a
    number as text, no path, a throwing `names`; the review round's
    stalling `names` is a `Set` subclass, so it needs no cast); the warnings in
    `shell.ts` and `model-evidence.test.ts` are on lines this package did
    not change.
  - **Mutation check.** 22 mutations of `parse.ts`, each applied to the
    final file and run against its targeted tests, each broke at least one
    test, and the file was restored byte for byte after each (`cmp`): the
    per-file catch boundary dropped; the capture-count check, the depth
    limit, the query's `timeoutMicros`, `tree.delete`, the parse progress
    callback, `parser.reset` before each parse, the binary check, the
    grammar cap, the names filter, the callee record and the export-clause
    aliases each dropped; TS members not inheriting their class's export;
    a variable's value in its signature; the runtime left enabled after a
    trap; the input cap off by one; prototype keys read as extensions; Rust
    trait methods on their own visibility; `pub(self)` read as public; a
    doc comment keeping its newline; Python's `__all__` ignored; and a
    grammar loaded from the working directory. The RSS threshold (150 MB)
    sits between 2 MB of growth with deletion and 1,726 MB without.
    Not mutation-tested: the lazies' reset after an I/O error (no fault
    injection without mocks) and `cursor.delete` (its memory is too small
    to measure). The review round added 13 more, each caught and restored
    the same way: `parseMs` timed from the top of `parse`; the turbofish
    callee; the member-body check; the member owner taken from any
    container; Java's direct-container rule; the default cuts; the
    post-sweep clock check; `module.exports = class` (caught by its own
    test and by the JS fixture); Python's and Rust's local containers;
    Python's colon stop; the trap's poison; and the old quadratic
    adjacency (the 48,000-decorator test fails). Not mutation-tested: the shell's
    poisoned check (testing it needs the shell tool booted in a fresh
    process, since the flag is process-wide) and the grammar `stat`
    fallback (no fault injection without mocks).
  - The full root typecheck was not run: nothing is pushed.
  - Nothing was sent to a model, no paid path ran, no workflow was
    dispatched, nothing was published, and no user-visible string changed
    (D14).

- **Review round (2026-11-06).** Thirteen findings on the uncommitted
  package, two of them blocking. All are fixed in the code and none was
  rejected; where a fix differs from the suggestion, it says so below.
  Built on the same `5a16dfaf`; nothing is committed.
  1. **Blocking: a run of decorators or attributes could bypass the
     extraction box.** `adjacent` filtered every collected comment for
     every decorator and spread-copied the run at each step, so a run of D
     decorators with comments between them cost O(D²), and the sweep
     checked the clock only between items. Fix: one backward pass over the
     run with a moving comment index (both lists are in document order),
     reading each gap's text once; `adjacent` returns only the run's first
     decorator, which is all `definition` uses. `extract` now also checks
     the clock after the sweep, so a single item that overruns makes the
     file a `timeout` (detail `sweep`), never a late success. Measured
     with the default limits under Bun: `class A {` + `@a /**/ ` × 48,000 +
     `m() {} }` (384 KB) took 28,440 ms before (the reviewer's figure) and
     408 ms now (parse 132, extraction 268); the Rust form `#[a] /**/ ` ×
     48,000 + `fn f() {}` (480 KB) 405 ms; the one-per-line forms 299 and
     406 ms; near 1 MiB (130,000 decorators, 104,000 attributes) 779 and
     765 ms. All four parsed.
  2. **Blocking: signatures held default parameter values.** Fixed and
     tested as described under "Signatures never hold a value" above. A new
     `default` role (`RULES[language].defaults`: the node type and the
     field of its default) captures each default-bearing parameter or
     pattern; the sweep records each default value's range, and heads are
     read after the sweep, since a default sits after the head that holds
     it. Each outermost default reads `…`, with one binary search per cut,
     so a cut default's nested defaults cost nothing more. The deviation
     sentence that claimed no signature holds a literal is corrected above.
  3. `parseMs` is timed around `parser.parse` alone, not from the top of
     `parse()` (which also covered the binary check, the byte count, the
     grammar `stat` and the 31 to 62 ms first-file grammar load). The bench
     loads every grammar before it measures, so its tables stand.
  4. `module.exports = class Foo { bar() {} }` and `= function named() {}`
     now yield an exported definition named after the value (alias
     "default"), or "default" when it has no name, and `bar` is an exported
     method of `Foo`. A JS fixture line and a separate test (named,
     anonymous class, arrow, and a plain value that yields nothing) pin it.
  5. `container` now names only what a definition is directly declared
     in. TS/JS members are recorded only directly in a `class_body` or
     `interface_body` (both captured; `object_type` is now captured as a
     scope, so a type literal's members are skipped), and their container
     is the class or interface whose body it is (each class or interface
     definition records its body's start, and the frame of that body knows
     it). Java members take a container only when the nearest frame is a
     class, interface or enum declaration. Beyond the finding, the same
     defect is fixed where it had the same root: a TS declaration in a
     function body, a Python definition in a function body and a Rust item
     in a function body had taken the class or module around that function.
     Java's local class `Local` is now in no container (the fixture moved
     from "in Main"). Fixture lines in TS, Python, Rust and Java pin each.
  6. A Rust turbofish (`parse::<u8>()`, `items.collect::<Vec<u8>>()`) is a
     `call`: for a `generic_function` callee, the end of its `function`
     field is recorded. A Rust fixture line pins both forms.
  7. A sibling of the 16,000-deep test runs under generous boxes and
     asserts a complete record (`depth > 16,000`, references `a` and `b`,
     both definitions); the default-box test stays for the timing.
  8. Every exported table (`PARSE_LANGUAGES`, `REPORTED_LANGUAGES`,
     `PARSE_EXTENSIONS`, `REPORTED_EXTENSIONS`, `GRAMMARS`,
     `PARSE_LIMITS`, `DEFINITION_KINDS`, `REFERENCE_KINDS`,
     `PARSE_REFUSALS`, `ROLES`, `RULES`) is frozen all the way down, and
     the `ParseLimits`, `Rules` and `Grammar` fields are `readonly`. A test
     walks every table and checks that a write throws.
  9. The grammar cap falls back to the file's read length when `stat`
     fails. A compiled-binary smoke check (`bun build --compile`, Bun
     1.3.14, linux-x64, of an entry that imports `parse.ts`): all seven
     grammars resolved to `/$bunfs/root/...`, `stat` returned their sizes,
     each loaded at its pinned ABI and parsed a sample (with defaults read
     as `…`). The full `build.ts` binaries are still not verified.
  10. `child()` in `parse.test.ts` uses the engine's `tmpdir` fixture
      (`test/fixture/fixture.ts`) instead of its own `mkdtemp`.
  11. The poisoned flag moved to `util/tree-sitter.ts` (item 6 above):
      `TreeSitter.poison()` on a trap, `TreeSitter.poisoned()` read by the
      review parser and by the shell tool's `parse`, which then refuses the
      command as unparseable. This is the chosen interim option; the Worker
      decision stays deferred. The trap test asserts the flag before and
      after; the shell's check itself has no test (above).
  12. The bench uses `lstatSync`, so a symbolic link (or anything else that
      is not a regular file) is left out and never read or followed.
  - `QUERY_VERSION` stays 1 although `RULES` changed: no version-1 output
    ever left this worktree (nothing is committed or cached).
  - Throughput re-run with the pinned packages after the round (this
    repository's `.ts`, 3,954 files, default limits, Bun 1.3.14): parse
    6.00 MB/s, total 2.59 MB/s, p95 / p99 / max 12.4 / 26.4 / 138 ms, peak
    RSS 313 MB, against 5.80, 2.66, 12.0 / 23.9 / 127 and 306 MB before:
    within run-to-run noise with the extra default captures. No refusal
    but the one file over 1 MiB.
  - Pin: `REVIEW_PIPELINE_SOURCES` `dc0ce0af6fd47a55` → `244e9c3d52f44f83`
    (only `parse.ts` changed among the pinned files);
    `REVIEW_PIPELINE_REVISION` stays 1, since no runner reads the parser.
  - Evidence, each file alone through the lock with `--timeout 30000`,
    `GITHUB_ACTIONS=false` and TMPDIR and XDG roots under scratch: engine
    `test/review/parse.test.ts` 53 pass; `test/tool/shell.test.ts` 62,
    `test/tool/shell-sandbox-local.test.ts` 6 (+5 skipped),
    `test/tool/parameters.test.ts` 60 and `test/review/run.test.ts` 44, all
    unchanged; core `test/review/model-evidence.test.ts` 18.
    `bun typecheck` passes in engine and core; prettier passes on every
    changed source and test file; oxlint reports only the three deliberate
    casts in
    `parse.test.ts` and the unchanged `shell.ts` lines.
  - Nothing was sent to a model, no paid path ran, no workflow was
    dispatched, nothing was published, and no user-visible string changed
    (D14).

## 2026-11-06 · VS-25b Tier 1 impact slice (core and uncalled engine builder)

Contract §1.2 (`impact.ts`) and §4 VS-25b; addendum A VS-36 items 1, 2, 4 and 5,
VS-38 items 1, 3, 4, 6 and 7, and §3 VS-25; the Now window of contract §5 and
addendum §4. Built at `6e2f1d04`. VS-25 (and "VS-25 supersedes VS-17") waits on
Q15 and VS-36 to VS-38 on Q18, so everything sits behind the new `impact` key,
which defaults to `grep`, and nothing reads it: no runner, CLI, app or desktop
file imports either `impact.ts`. `run.ts`, `ai-review.ts`, `provider.ts`,
`session/llm.ts`, `posting.ts`, engine `review/context.ts` and `review/parse.ts`,
`cli/cmd/review.ts`, `workflow.ts`, `command.ts`, `cli/cmd/github.*`,
`github-*.ts`, `vectorscope.astro`, core `review/symbols.ts` and `brain/graph.ts`,
desktop `repo-index.ts`, `brain/knowledge.ts` and `script/vectorscope-eval/replay.ts`
(its `VARIANTS`) are untouched. It implements the VS-25b plan as corrected by its
critique: every critique point was taken, three of them in part or in another
form (items 4, 9 and 16 under "Critique points", with reasons). Nothing is committed (the lane brief
overrides the plan's commit step).

- **What landed.**
  - **Core `review/types.ts`**: `ReviewConfig.impact?: "grep" | "graph"`;
    `OPTIONAL_REVIEW_DEFAULTS.impact = "grep"`; `"impact"` joins
    `UNAPPLIED_REVIEW_KEYS`. `DEFAULT_REVIEW_CONFIG` is unchanged.
  - **Core `review/config.ts`**: a plain key (`FIELDS.impact`, env
    `REVIEW_IMPACT` after `REVIEW_TRIVIAL`), with the warning
    `"impact": "graph" is not applied yet: related code still comes from git grep.`
    Not raise-only, not trusted-only: `mergeReviewConfig` reads it exactly as
    `parseReviewConfig` does.
  - **Core `brain/code.ts`**: `INDEX_FILES` exported (same value); new
    `WorkspacePackage`, `PathAliases`, `Workspace` and `workspace(manifests)`;
    `resolve` and `dependencies` take an optional fifth argument. Only with it,
    and only for `typescript` and `markup` specifiers that neither the relative
    attempt nor a sibling resolved, the tsconfig or jsconfig path aliases of the
    nearest folder are tried (an exact pattern, else the `*` pattern with the
    longest prefix, each target in order, then `baseUrl`), then the workspace
    package with the longest matching name (an exact `exports` key, else the `*`
    key with the longest prefix; without `exports`, `main`, then `module`, then
    the folder's index file, and any subpath as a file under the folder).
    Whatever that leaves unresolved falls through to the suffix match unchanged.
  - **Core `review/trivial.ts`**: `TEST_PATHS` exported (same value).
  - **New core `review/impact.ts`** (pure, Node-only through BrainCode):
    `IMPACT_LIMITS`, `IMPACT_INCOMPLETE` (`time`, `partial-clone`, `output`,
    `error`), the `Definition`, `Reference`, `Dependent`, `ImpactSlice`,
    `ImpactPrompt` and `ImpactRecord` types, and `changedDefinitions`,
    `movedNames`, `impactNames`, `barrels`, `selectDependents`, `wordHits`,
    `packSlice` and `changedPaths`.
  - **Core `review/prompt.ts`**: `PromptInput.impact?: ImpactPrompt` (a type-only
    import), `IMPACT_CAPS` (40 definitions, 60 call sites, 2,000 window
    characters, 20 tests), and the exported renderers `impactBlock`,
    `impactDefinition` and `impactCallSite`. The `<untrusted_impact>` block
    follows `</related_code>`, with one trusted sentence in "## The change", and
    renders only when the slice has a changed definition, a call site or an
    incomplete reason. The cacheable "## How to work" prefix is untouched.
  - **Core `review/model-evidence.ts`**: `"impact"` joins `EVIDENCE_POLICY_KEYS`
    after `"trivial"`; `CANONICAL_IMPACT`; `canonicalPrompts(keys)` and
    `promptsDigest(keys)` (memoised per key set) add the review and security
    prompts with the slice, for both trusts, only under `impact: "graph"`;
    `evidenceScope` asks for that digest only once a runner applies the key
    (it leaves `UNAPPLIED_REVIEW_KEYS`). `REVIEW_PIPELINE_SOURCES`
    `244e9c3d52f44f83` → `0d1995975936c407`; `REVIEW_PIPELINE_REVISION` stays 1.
  - **New engine `review/impact.ts`** (`ReviewImpact`, uncalled): `ARG_CHARS`,
    `IMPORT_LINE`, `ChangedFiles` (each side's text, definitions, comments and
    strings keyed as VS-24c's `TrivialInput` takes them, plus `unsupported`,
    `missing` and `parseMs`), `BuildInput`, `parseChanged`, `importLines` and
    `build`. Node APIs only; no `fetch(` text and no address, so the
    egress-inventory lint passes.
  - **Engine `review/eval.ts`**: `ReplayArtifact.tier1` is now `ImpactRecord`
    (absent until wiring); the unwired-key refusal names each key's wiring
    package (`(VS-24 wiring)` stays byte-identical when only VS-24 keys are set;
    with both, `(VS-24 wiring for trivial; VS-25b wiring for impact)`); the
    `ReplayInput.config` comment names `impact`.
  - **`script/vectorscope-eval/README.md`**: `tier1`'s fields.
  - **New tests**: core `test/review/impact.test.ts` (28),
    `test/brain/code-workspace.test.ts` (8); engine `test/review/impact.test.ts`
    (12). **Extended**: core `prompt.test.ts` (+4), `config.test.ts` (+4, and
    `OPTIONAL_REVIEW_DEFAULTS` gains `impact`), `model-evidence.test.ts` (+2, the
    pin, the pinned `promptsDigest()` literal); engine `eval.test.ts` (+1 replay,
    +2 refusals).
- **How the slice is built** (`ReviewImpact.build`, about a 4 s box,
  `IMPACT_LIMITS.timeBoxMs`; every git call through `Git.Service` with
  `GIT_NO_LAZY_FETCH=1` and `Effect.timeoutOption(remaining)`):
  1. Refuse a base or head that starts with `-` (incomplete `error`).
  2. Scan, tree-ish plan only (VS-38 item 1): `git version`, and `git config
     --get-regexp` for `extensions.partialclone`, `remote.*.promisor` and
     `core.sparsecheckout` (`clone.partial`, `clone.sparse`).
  3. In a partial clone only: `rev-list --objects --no-walk --missing=print
     --filter=blob:none <head>` (a missing tree means nothing can be read safely:
     incomplete `partial-clone`, nothing read), then the same without the filter
     for head and base, whose listed paths are what the clone has.
  4. Concurrently: `ls-tree -r -z --full-tree <head>` (64 MiB cap; `-l` for sizes
     only when the clone is not partial), and each changed file's head and base
     side through `git show --no-textconv <rev>:<path>` (1 MiB + 1 cap; a side
     the clone lacks is never shown and goes to `ChangedFiles.missing`), parsed
     with VS-25a's parser.
  5. The missing head blobs (`unsearched`) become `:(top,exclude,literal)`
     excludes, collapsed to the highest folders whose every blob is missing;
     when they cannot fit `ARG_CHARS`, no search runs.
  6. Names: `impactNames` over `changedDefinitions` plus a fallback of
     `movedNames`, `changedSymbols` for refused grammar-language files and
     `BrainCode.symbols` at added lines for files without a grammar (at most 40).
  7. Concurrently: the manifests (`git grep -n -z -I -e ""` of `package.json`,
     `tsconfig.json`, `jsconfig.json` and the root `pnpm-workspace.yaml`,
     node_modules excluded) into `BrainCode.workspace`; and the candidates, one
     uncapped `git grep -l -z -w -F -I --no-color --no-column --full-name -f -
     <head> -- :/ <excludes>` with the names on stdin (VS-36 item 1).
  8. The gate: the import lines of code candidates and barrels, then
     `selectDependents` (VS-36 item 2), the 200-file cap applying only to
     confirmation.
  9. Confirm in rank order (concurrency 4) until the deadline: `git show`, parse
     with the names (import-kind references left out), or `wordHits` where the
     parser refuses; then `packSlice`.
  The slice never touches coverage or completeness (VS-38 item 7): it has no such
  field, and a test says so.
- **Decisions and deviations.**
  1. **Gate first** (VS-36 items 1, 2, 4 and 5), replacing the brief's cap
     before the gate. The names go through `-f -` on stdin, so argv stays
     bounded; a test shows the one grep finds the files the per-name greps find.
     No 5,000-candidate prefilter, so no `dropped.prefilter` or
     `stages.prefiltered`. An empty slice is valid and renders nothing.
  2. **Gate reads** use one tree-ish `git grep` of import lines per chunk of at
     most 24,000 pathspec characters (git grep has no `--pathspec-from-file`,
     probed on 2.43, and Windows caps a command line at 32,767), with chunk
     concurrency 2. `cat-file --batch` waits for Q18 and the I-8 amendment; blobs
     are read with `git show --no-textconv`. The metadata reads (`ls-tree`,
     `rev-list --missing=print`, `git config`, `git version`) read no file
     content.
  3. **Finding: several `-e` patterns are pathological on git 2.43.** The six
     import-line patterns as six `-e` took over 30 s on 100 candidate files of
     this repository (bun.lock and DEPENDENCY_NOTICES.md among them; 17 s with
     only two patterns), against 89 ms for the same six as one alternation in one
     `-e`, which gives the same lines (371,959 bytes either way on 100 code
     files: 217 ms against 17 ms). So `IMPORT_LINE` is sent as one alternation.
     And only code is read at the gate (`BrainCode.language` neither undefined
     nor `text`): any other candidate is checked by its path (no import, so
     `dropped.gate`), and a code file over the parser's 1 MiB cap is left
     unchecked (`dropped.unchecked`), since it could not be confirmed.
  4. **Finding: lazy fetching off makes a tree-ish `git grep` fail, not skip.**
     On git 2.43.0 here (which honours `GIT_NO_LAZY_FETCH` and prints "lazy
     fetching disabled"), a grep of a partial clone's head exits 128 at the first
     missing blob, so VS-38 item 3's "searches only blobs present locally" does
     not hold. Instead `rev-list --objects --no-walk --missing=print`, which
     never fetches on any version that has `--missing`, lists what is missing
     (probed: the counts are the same before and after), and the builder never
     names a missing object: missing paths are excluded from every grep, never
     candidates and never shown. So nothing is ever fetched, stricter than
     "fetch only gated candidates", and independent of the git version (the
     critique's point; VS-38's 2.44 version gate is not needed). Also found:
     `ls-tree -l` needs each blob's size, so in a partial clone it fetches (or,
     with lazy fetching off, fails); `-l` is used only when the clone is not
     partial. `GIT_NO_LAZY_FETCH=1` stays on every call as a backstop, and a
     test shows it holds (`parseChanged` asked to show a missing blob gets
     nothing, and nothing is fetched). On 2.43 a partial clone sets
     `remote.origin.promisor` and `partialclonefilter`, not
     `extensions.partialclone`; both are read.
  5. **Additions to the contract shapes**, each because a stage or count needs
     it: `incomplete` is a list with `output` and `error` reasons; `dropped` has
     `ignored` (ignore rules, generated headers), `unchecked` (never
     gate-checked: time, git's limit, or over the parser cap), `time` (gated,
     left unread) and `definitions` (changed definitions that did not fit:
     `path:start`, or `base:path:start` for LEFT); `Definition` has `side`,
     `container` and `aliases`; the record has `clone` and `unsearched`. Stage
     arithmetic: `candidates = ignored + unchecked + gate + gated`, `gated ≥ cap
     + time`, `confirmed = packed + budget`, every dependent in `locations`.
  6. **Changed definitions** (critique 1 and 2): the innermost definition of each
     changed line, plus the nearest exported one around it when it is local, so
     an edit inside a helper of an exported function still names that function;
     a base definition with a head twin (same name, kind and container) becomes
     the twin, so a removal-only hunk keeps a head location. Overloads: only the
     signatures a hunk touches are listed, under one grepped name. A pure rename
     or a deletion greps the old path's exported names (`movedNames`, critique
     3), and the old path is in the gate's reach.
  7. **The gate** (`selectDependents`): `BrainCode.dependencies` (with the
     workspace) of the import lines; index-file re-exports followed two hops, in
     the changed module's folder and two folders above (other re-exporters are a
     limitation); a Go import reaches a changed module when it resolves into its
     folder (critique 4: BrainCode resolves a Go package folder to its first 8
     files, so a 12-file package whose changed file sorts last would be dropped;
     `resolve` itself is unchanged); Python `from X import Y` also resolves `X.Y`
     and `from . import Y` resolves `.Y` (critique 5, option a; BrainCode
     resolves `.` to `__init__.py` and `pkg` to the folder's first 8 files);
     Go, Java and Kotlin files in a changed module's folder pass without an
     import (`importsChanged: false`), by extension, so C# (which BrainCode reads
     as `java`) does not (critique 17). Generated headers (`hasGeneratedHeader`,
     the first five lines, with the markers added to the import-line patterns)
     and `ignored` paths are set aside before the gate and cap (critique 14); a
     licence header longer than five lines hides a marker, as it does for the
     review's own ignore rule (Kubernetes puts it after about 15 lines).
  8. **Rank**: `BrainGraph.rank` alone, over import edges (`WEIGHT.imports` and
     `WEIGHT.imported`) from gated files and reached barrels to the changed
     modules they reach, seeded on every changed module; rank descending, then
     path. The path tie-break is redundant with the path pre-sort of the
     candidates (each alone survives its mutation; both removed are caught).
  9. **Packing** (critique 12): the budget is min(6,000, floor(15% of the
     context)) tokens at 3.5 characters a token (the runner's rule), charged at
     each block's rendered size through prompt.ts's own renderers after
     reserving the frame, the first 20 tests and the longest note, so the
     rendered block never exceeds it and every recorded location is a block the
     model is shown (tested at 8,000, 20,000 and 1,000,000 tokens). Definitions
     first (at most 40), then call sites (at most 60) with ±3-line windows of
     lines no earlier window of the file showed, `N: text` cut at 200
     characters, `\r` stripped. The first block over the budget stops packing,
     in strict rank order; a kind's cap ends only that kind (found in the
     timing run below: with 40 definitions, the cap had ended all packing, so
     nothing but definitions was packed).
  10. **Errors** (critique 8): an exit other than 0, or 1 with an empty stderr
      where "no match" is allowed, adds `error` (Git.Service turns a spawn
      failure into exit 1 with a message), so a failed search never reads as
      "nothing imports this". Git's output limit adds `output`.
  11. **Git output** (critique 7 and 15): every grep passes `--no-color
      --no-column --full-name`; every pathspec carries `top` (`:/`,
      `:(top,literal)`, `:(top,exclude,…)`), so a subdirectory as `directory`
      gives the same slice (tested with `color.ui`, `color.grep`, `grep.column`,
      `grep.lineNumber` and `grep.fullName` set).
  12. **Workspace resolution** (critique 13): members are the root and the
      folders the root `package.json` `workspaces` (a list or `{packages}`) or
      `pnpm-workspace.yaml` `packages` globs match, negations included, or every
      manifest when neither declares any; a name two members claim resolves
      nothing (`ambiguous`), so it falls through to the suffix match, as do
      manifests outside the workspace. Each package keeps its dependency names
      (for VS-38 item 2). TS and JS only: `extends` is not followed, `go.mod`,
      Cargo and Python package roots are not read, and the manifests are the
      head's. `pnpm-workspace.yaml` is read for its `packages` list by a small
      line reader rather than the `yaml` package, which `brain/code.ts` (loaded
      by the desktop's file ranking) would otherwise import. The manifests steer
      context only, never an invocation field (I-2).
  13. **The fallback** and a contract finding: `changedSymbols` reads exactly the
      grammar languages, so files without a grammar (C, C++, C#, PHP, Ruby) take
      `BrainCode.symbols` declarations at added lines, an existing reader (no
      third reader); `wordHits` mirrors `git grep -w -F` on text already read.
      C callers include a header, not the changed `.c` file, so the gate drops
      them: a limitation of the file-level import graph, outside the grammar
      set. C, C++, C# and PHP are counted offline from `unsupported` by VS-25a's
      `REPORTED_EXTENSIONS` (VOI13).
  14. **Placement**: core `impact.ts` is pure but Node-only (BrainCode's
      `node:path`, and `node:crypto` through BrainAnchor); `prompt.ts`,
      `model-evidence.ts` and engine `eval.ts` take only its types, and the
      shared caps and renderers live in `prompt.ts`, so the renderer bundle gains
      nothing. The Node bundle (`bun build src/node.ts --target=node
      --metafile`, 4,512 inputs) holds neither `impact.ts`; `brain/code.ts` was
      already in it and now imports `jsonc-parser` and `minimatch`, both already
      bundled.
  15. **The pin** (critique 20, choice recorded): `REVIEW_PIPELINE_FILES` gains
      core and engine `review/impact.ts` only. `brain/code.ts`, `brain/graph.ts`
      and `review/symbols.ts` join at VS-25b wiring, when a runner reaches them
      through the slice: today the slice decides nothing, and pinning them would
      tie the desktop's file ranking and Brain changes to the review pin, as the
      comment says (the reason `util/tree-sitter.ts` stays out).
  16. **Default-stable digests**: `promptsDigest(keys)` is the mechanism for
      key-gated prompt sections. `promptsDigest()` is `5d59e9ee06077c23`, printed
      at `6e2f1d04` and pinned as a literal; `promptsDigest({ impact: "graph" })`
      is `9998c006759a7781`; `policyDigest(DEFAULT_REVIEW_CONFIG)` stays
      `70512122f41ec160`.
  17. Only the head and base tree-ishes are read: uncommitted and staged local
      reviews need a working-tree reader at wiring (VS-38's working-tree plan).
- **Critique points**: all 21 taken, these three in part or in another form. 4:
  the folder rule is
  Go's only; a Java import names a class file, which BrainCode resolves to that
  file, a wildcard `import a.b.*;` is not read by `BrainCode.imports` at all, and
  same-folder Java and Kotlin pass by the same-package rule. 9: unread
  candidates go to `dropped.unchecked` and the chunks run two at a time, but the
  box cannot be placed between two chunks deterministically without a fault
  hook, so the test runs the box at 0, 1, 20 and 150 ms (each stops at another
  step) and checks the stage arithmetic every time, and a core test sends unread
  candidates to `unchecked`. 16: `ls-tree` is
  bounded (overrun: `output`, changed definitions only), sizes skip files over
  the parser cap before reading when the clone is not partial, and `rev-list`
  runs only in a partial clone; reading the confirm set through one chunked
  `git grep -e ""` is deferred (the confirm stage stayed within the box in the
  timing run below; Windows spawn cost is unmeasured, and Q18's `cat-file
  --batch` is the planned batch read).
- **§0.3 items.**
  1. Key: `impact`, parsed, unapplied (`UNAPPLIED_REVIEW_KEYS`), warned on
     `graph`.
  2. Parity: no runner reads it; the runner, replay and desktop suites pass
     unchanged.
  3. Evidence: a policy key, read as absent while unapplied; the impact block
     enters `promptsDigest` only under `graph`; the pin moves; revision 1.
  4. Variant: `engine:impact-graph` stays pending at "VS-25b wiring";
     `VARIANT_KEYS` is unchanged; the replay drops `impact` from a base
     `review.json` and keeps its warning (tested).
  5. Desktop: a documented difference until VS-10 (`variant.applied: false`).
  6. This entry.
- **Owner questions: none decided.** Q13, Q15, Q18 (with the I-8 amendment) and
  Q26 stay open; only this repository was used for timing.
- **Deferred to the runner-wiring window or later.**
  - VS-36 item 3: the lexical and co-change rankers, RRF and its determinism
    test (graph rank alone first; the kill criterion compares them); the
    5,000-candidate prefilter.
  - VS-37: tiers a and b and call-site windows widened to the enclosing
    statement.
  - VS-38: the working-tree plan, pathspec and workspace scoping (skipped if the
    tree-ish p95 holds), and their byte-identity test.
  - The 2k to 8k budget sweep, the conditional fact cache, VS-49 utilisation, and
    the desktop half after VS-10.
  - Runner wiring: the `Review.run` call and the block in runner prompts; the
    diff ordered by impact rank before `budgetDiff`, with files over the budget
    listed as not reviewed; artifact `tier1` and `context.locations`; the
    `format.ts` "context considered" review note; the dispatch `dependents`
    shrink; comment ranges into `classifyTrivial` (`ChangedFiles` is shaped for
    it); whether `graph` replaces `related_code`, and `symbols.ts` replaced
    where a grammar exists; the in-process or Worker parse decision; the Brain
    files and `symbols.ts` in the pin.
  - VS-27b: the test that impact incompleteness never changes
    `StrictResult.complete`.
  - Later: the Actions cache, and the `cat-file --batch` reads with their I-8
    parse test (Q18).
  - Deferred verification: macOS and Windows git (pathspec magic, argv length;
    the FIFO interruption test is POSIX-only and skips on Windows), git without
    `GIT_NO_LAZY_FETCH` (the design never asks for a missing object, but only
    2.43 was run), the 50k-file-or-more and blobless-sparse latency bands, and
    the optional `vectorscope-impact-bench.ts` over Kubernetes, Keycloak and
    vscode, which was not written (a Kubernetes run would need a
    `--shallow-since=2025-11-01` blobless clone, since VS-25a's is `--depth 1`).
- **Timing** (a scratch script, not committed, not the bench): `build` over nine
  commits of this repository (`6e2f1d04` back to `7cadfcb8`, each against its
  parent; 1 to 16 files changed; Bun 1.3.14, git 2.43.0, 4 vCPU): total 94 to
  2,497 ms, grep 30 to 650 ms, parse 9 to 1,145 ms, up to 1,772 candidates, 61
  gated, 245 confirmed and 31 packed call sites, 5,909 tokens; no time-box hit
  and no cap. Before the two fixes above (one alternation, code-only gate
  reads), four of the nine hit the 4 s box in the gate with grep near 3.6 s.
- **Evidence.** Each file ran alone through the lock with `--timeout 30000`,
  `GITHUB_ACTIONS=false` and TMPDIR and XDG roots under scratch:

  | Package | File | Tests |
  |---|---|---|
  | core | `test/review/impact.test.ts` | 28 (new) |
  | core | `test/brain/code-workspace.test.ts` | 8 (new; the golden table) |
  | core | `test/review/prompt.test.ts`, `config.test.ts`, `model-evidence.test.ts` | 30, 45, 20 |
  | engine | `test/review/impact.test.ts` | 12 (new; real git, partial clones from `file://` with `uploadpack.allowfilter`) |
  | engine | `test/review/eval.test.ts` | 28 |
  | core | `test/review/trivial`, `symbols`, `pipeline`, `plan`, `select`, `eval`; `test/brain/code-index`, `graph` | 44, 5, 2, 21, 43, 42, 8, 7 (unchanged) |
  | engine | `test/review/parse`, `context`, `run`, `vectorscope-replay`, `source`; `test/cli/github.review` | 53, 6, 44, 13, 16, 40 (unchanged, I-1) |
  | engine | `test/compliance/egress-inventory`, `node-bundle-guard`, `upstream-free` | 5, 3, 11 + 1 fail (pre-existing, below) |
  | app | `src/features/pull-requests/ai-review.test.ts` (`--preload ./happydom.ts`) | 107 (unchanged) |
  | desktop | `src/main/repo-index.test.ts` (`bun --no-env-file test`) | 16 (unchanged) |

  - The golden table: `BrainCode.resolve` over 32 rows (relative TS
    specifiers, aliases, `@/review/eval` ambiguous between two folders,
    workspace packages and subpaths, duplicate and excluded names, npm names,
    a Go and a Python file under a TS package, and the code-index fixture's
    Python, Go, Rust, Java, C, Ruby and PHP rows) and `dependencies` of every
    fixture file, printed at `6e2f1d04` from the HEAD copy of `code.ts` before
    the change; without a workspace every result is identical, and with one only
    the eight TS and markup rows listed in the test change.
  - The engine tests cover: a fork review whose working tree is the merge-base,
    with an untracked decoy and a working-tree edit, never read; the stages,
    windows, locations, tests and `ChangedFiles` callbacks; a subdirectory and
    colour or column settings; the one grep against per-name greps; a pure
    rename; Go (package import, same-package test, a generated file set aside)
    and Ruby by word; a corrupt object (`error`); the time box at 0, 1, 20 and
    150 ms keeping the stage arithmetic, and the 200-file cap; the box killing a
    git blocked on a FIFO config include (the FIFO then has no reader: ENXIO);
    import lines (wrapped `import(` and `require(`, Go blocks, Python lists,
    Rust, markup, Java, Ruby, PHP, C, CSS) giving the same `BrainCode.imports` as
    whole files; a blobless sparse clone missing 700 blobs in two folders
    (searched through two folder excludes, where 700 file excludes would not fit
    `ARG_CHARS`; nothing fetched, the missing base side never read); a blobless
    clone with nothing checked out; and a treeless clone (nothing read or
    fetched).
  - **The one failure is pre-existing and comes from the environment**:
    `upstream-free.test.ts` "a GitHub token does not take the default model from
    an OpenAI key" gets `amazon-bedrock` as the default provider in this
    container, the same cause as the `local-run.test.ts` failure recorded in the
    VS-21b and VS-25a entries; nothing here touches providers.
  - `bun typecheck` passes in core, engine, app and desktop, and `bun tsgo -p
    ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`.
  - prettier passes on every new file, and on the added lines of `prompt.ts`,
    `brain/code.ts` and `prompt.test.ts` (each was not prettier-clean at HEAD, so
    their untouched lines keep their formatting). oxlint reports no warning on
    the new files or on any added line of a changed file.
  - **Mutation check.** 41 mutations, each applied to the final file and run
    against its test file, each restored byte for byte (`cmp`). 39 caught: cap
    before gate; barrel following removed; re-export depth one hop; the
    same-package rule removed; C# in the same-package rule; the Go folder reach
    removed; the Python submodule rule removed; the generated-header filter
    dropped; the rank tie-break and the path pre-sort removed together; the 15%
    share removed; window radius 2; overlapping windows repeated;
    skip-and-continue packing; a kind's cap ending all packing; the bare window
    charged instead of the rendered block; the site cap not applied; the
    nearest exported container not taken; the LEFT twin not taken; the first
    alias instead of the longest prefix; the workspace applied to every
    language; ambiguous names resolved to the first; the workspace globs
    ignored; the missing-path excludes dropped; one exclude per missing file;
    `GIT_NO_LAZY_FETCH` dropped (the backstop test then fetches); a
    working-tree candidate grep; import-kind references kept; `--no-color` and
    `--no-column` dropped; the time box removed (the FIFO test hangs); the
    treeless check removed; the error reason removed; moved names not grepped;
    `ls-tree -l` in a partial clone; missing base blobs read anyway; an empty
    slice rendered as a frame; impact prompts in the default digest; `impact`
    counted while unapplied; `grep` warned as not applied; `impact` named as
    VS-24 wiring. Survived, as expected: the tie-break alone (redundant with
    the pre-sort) and six `-e` patterns instead of the alternation (the same
    lines; the choice is a measured speed-up, decision 3).
  - The full root typecheck was not run: nothing is pushed.
  - Nothing was sent to a model, no paid run, no workflow dispatched, nothing
    published, and no user-visible string changed (D14).

### 2026-11-06 · VS-25b review fixes

Seventeen review findings, four of them blocking (two pairs overlap: the two
on `parseChanged`, and the two on the prompt sentence). Every one was fixed;
none was declined. Where a finding offered two ways, the bullet says which
was taken. Core `review/impact.ts`, `brain/code.ts`, `review/prompt.ts` and
`model-evidence.ts` (the pin), engine `review/impact.ts`, their tests, Q18
in addendum A and `tier1.tokens` in `script/vectorscope-eval/README.md`
changed; no runner, provider, LLM or posting file and no
file @vector owns. Nothing is committed. The points below supersede the entry
above where they differ.

- **Blocking: `tokens` counted the reserved frame.** Taken as suggested. The
  reservation (frame, tests, the longest note, and now the trusted sentence)
  is used for the budget check only. The new core `impactTokens(slice)` is
  `ceil(impactBlock(slice).length / 3.5)`: `packSlice` reports it for what it
  packed (no note), and the builder's `finish` recounts it once `incomplete`
  and `unsearched` are known, so every path (`packOnly`, an early stop, a
  full build) reports the block as rendered with its note, and 0 when it
  renders nothing. Tests: core "an empty slice renders nothing and costs
  nothing" (also with tests set), "tokens count the block as rendered, never
  the space reserved for a note" (with and without a note, and a note
  alone); engine `invariants` now asserts `tokens = ceil(rendered / 3.5)` for
  every slice built (with the partial-clone and error notes among them), and
  "a change that touches no definition gives an empty slice, which costs
  nothing".
- **Blocking: a removal in a later overload took the first overload as its
  twin.** Taken as suggested: the twin is the head definition at the same
  index among the same (name, kind, container) definitions sorted by start,
  and the first only when the two sides hold different numbers of them. Test:
  head and base `f@1`, `f@2`, `f@3-5`; removing line 4 gives `f@3-5` with its
  signature and the location `src/a.ts:3`, removing line 2 gives `f@2`, and
  with two head overloads against three base ones the first is taken.
- **Blocking: `workspace()` was unbounded on the head's manifests.** Taken,
  and taken further, because a probe found that one short glob is enough:
  minimatch's patterns backtrack, so `*a*a*c` took 28 s against a folder name
  of 1,000 characters, `*a*c` 6.9 s against 4,000, and an extglob of 20
  groups 2.1 s against 40 characters. Now (`BrainCode.WORKSPACE_LIMIT`):
  - a glob longer than 256 characters, or with more than one `*` in a
    segment other than `**`, is dropped; at most 64 globs are kept, each
    compiled once (`new Minimatch`) with `noext: true` and at most 16 brace
    expansions. Extglob syntax is read as text and `packages/*-*`-style
    globs are dropped, both rare in workspace declarations;
  - a folder whose path is over 1,024 characters or has a name over 255 is
    not a member; at most 5,000 package.json files outside the root are
    matched, 2,000 member manifests and 2,000 tsconfig or jsconfig files are
    read, and a tsconfig's `paths` and a package's `exports` keep 256 entries;
  - `workspace(manifests, { deadline })` stops reading past the deadline;
    `Workspace.truncated` records a cap or the deadline;
  - `resolvePackage` and `resolveAlias` look packages up by name and aliases
    by folder (a WeakMap index per workspace), so a resolution costs the
    specifier's segments and one entry's patterns;
  - `pnpmPackages` cut comments and quotes with string searches: its
    patterns `\s+#.*$` and `(.+?)\s*(?:#.*)?$` were quadratic on a long run
    of spaces. A differential run over 200,000 generated inputs found no
    membership difference from the old reader (a lone carriage return inside
    a line is the one input they could read differently);
  - the builder calls `BrainCode.workspace` only before the deadline, with
    the deadline, inside `Effect.try`: a throw leaves the workspace out and
    adds `error`, and a deadline passed after it adds `time`.
  The adversarial cases measured after the change: 64 one-star globs of 240
  characters against 5,000 folders of 255-character names took 119 ms, the
  same with character classes 199 ms, and globstars 290 ms. Tests (core
  `code-workspace.test.ts`, "bounds on what a manifest can make it do"): a
  70 KB glob is dropped rather than thrown; `*a*a*a*a*c` and an 11-group
  extglob against a 250-character name finish under 2 s with the safe glob
  still applied; 3,000 globs by 3,000 manifests finish under 2 s (33.6 s
  before) keeping the first 64 in path order; an expired deadline reads
  nothing and sets `truncated`; a 300,000-space pnpm line reads in under 1 s.
  The golden table and every earlier workspace test pass unchanged.
- **Blocking: presence was keyed by the path rev-list prints first.** Taken
  as suggested. `presence` first checks the head's (and base's) trees with
  `rev-list --filter=blob:none --missing=print`, then reads
  `ls-tree -r -z --full-tree` of each (trees only, no `-l`), and collects the
  missing object IDs from the `?<oid>` lines of one `rev-list --objects
  --no-walk --missing=print <head> <base>`. A path is missing exactly when its
  entry's object ID is in that set; a base whose trees are missing leaves
  every base side unread; a submodule entry counts as lacking, since its
  commit is never in the clone. In a partial clone the head listing is the
  tree the build uses, so no second `ls-tree` runs. Test: "files with the
  same content are each searched: presence is by object, not by the path git
  lists first" (a blobless clone with every blob present, two identical
  importers in two folders and an empty `__init__.py` in each; the test shows
  rev-list never prints `b/y.ts`): both are dependents, `unsearched` and
  `incomplete` are absent and nothing is missing. The two earlier
  partial-clone tests pass unchanged (700 unsearched, the note now asserted).
- **Confirmation matched every changed name.** Taken as suggested.
  `Selection.confirm[].reaches` lists the changed modules each file reaches:
  directly, through a barrel (and the barrels it reaches), through a header
  (below), or as a same-package neighbour. The builder keeps only references
  to the names those modules give (their changed exported definitions with
  aliases, and their fallback names: moved exports, `changedSymbols`, and
  `BrainCode.symbols`; a moved file under both paths), and passes the same set
  to the parser. The fallback names are kept per file for this, with the same
  40-name limit and order. Test (engine): two changed modules sharing no
  names, where the importer of one also uses its own local of the other's
  name: only the imported name's call site is packed. Measured on `561fd593`
  (VS-25a, 11 files): confirmed call sites fall from 245 to 11, and the 31
  packed sites that go are all `parse` and `runtime` hits in files that do
  not import `parse.ts`.
- **The word-match fallback kept import lines.** Taken the second way: the
  new `BrainCode.importLines(text, language)`, beside `imports`, gives the
  lines its own patterns match, from the statement's last `import` or
  `export` keyword (a TypeScript `import … from` match can run on from an
  earlier quote-free `export` line), with Go's import blocks and Python's
  parenthesised lists. The builder drops word hits on those lines. The gate's
  import-line text was not used: its keyword pattern also matches lines such
  as `export const z = computeTotal()`, which are call sites. Tests: core
  `importLines` (TypeScript, Python, Go, C, PHP); engine "C: a caller
  including the changed source's header is confirmed by word, without its
  include line".
- **C and C++ callers never passed the gate.** Taken the first way: a changed
  C or C++ source (`c`, `cc`, `cpp`, `cxx`, `m`, `mm`) and its headers of the
  same file name (`h`, `hh`, `hpp`, `hxx`), beside it or under an `include`
  folder of its folder or an ancestor, are one module for the gate's reach;
  an include of the header reaches the source with `importsChanged: true`.
  Also found: BrainCode's suffix match already reaches `compute.c` from
  `#include "compute.h"` when the relative attempt fails, so the cases that
  failed were a caller beside the header and an include path with folders
  (`<x/foo.h>`). Tests: core "C and C++: an include of a changed source's
  header reaches the source" (both cases, and an unrelated include gated
  out) and the engine C test above.
- **`parseChanged` and `importLines` read without the presence check (two
  findings).** Taken the first way: both run the clone scan and `presence`
  before any read (`lacking`), default to a deadline of
  `IMPACT_LIMITS.timeBoxMs` from the call, and refuse a revision that could
  pass for an option. A `parseChanged` caller that passes `missing` takes the
  check on itself, which the header now says; the backstop test does exactly
  that (`missing: () => false`), and a new assertion shows the default call
  lists `base:src/util.ts` and `src/util.ts` as missing and `importLines`
  leaves the missing path out, with nothing fetched.
- **An unreadable config failed open.** Taken the second way: when `git
  config` gives no result or an exit other than 0 or a quiet 1, the clone is
  `guarded` and takes the partial path (the presence check, no `ls-tree -l`).
  `clone.partial` stays false, since it is not known, and `partial-clone` is
  added only when the clone is known to be partial (so a time-box stop does
  not report it). Not covered by a test: every git command fails on a config
  that `git config --get-regexp` cannot read.
- **A barrel that was also a candidate was linked twice.** Taken as
  suggested: the (source, target) pairs are deduplicated before the edges
  are built. Test: a barrel candidate ranks exactly as a plain importer of
  the same module.
- **The trusted sentence (two findings).** Reworded now ("in files that
  import them or share their package") and exported as `IMPACT_INSTRUCTION`;
  `packSlice` reserves its length and the line break before it, and
  `ImpactSlice.tokens` is documented as the data block only. Only the
  `graph` prompts change: `promptsDigest()` stays `5d59e9ee06077c23`, and
  `promptsDigest({ impact: "graph" })` moves from `9998c006759a7781` to
  `fd944d83f8d705ad`. The wording may change again before the held-out
  freeze. Test: the budget test now checks block plus sentence; the prompt
  test uses the constant.
- **Names with whitespace reached `git grep -f -`.** Taken: `impactNames`
  and `movedNames` keep only names matching `/^[\p{L}\p{M}\p{N}_$]+$/u`
  (never `default`). Test: aliases `"a\n\nb"`, `"x y"` and `""` are dropped,
  `$ok` and `café_1` kept.
- **`changedDefinitions` was O(changed lines × definitions).** Taken the first
  way: the innermost definition of each line is found by a union-find sweep
  over the sorted changed lines (definitions in innermost order, each line
  handed out once), and twins are indexed by key. 4,000 definitions against
  40,000 changed lines on each side went from 1,532 ms to 112 ms. Test:
  8,000 definitions against 40,000 lines each side under 1 s (about 3 s
  before). Every earlier `changedDefinitions` test passes unchanged.
- **Style.** `readImports`' `else` is an early return; the re-export passes
  are an `Array.from(...).forEach`, `wordHits` is one boundary regex per name
  (escaped) with no `let`, and `parseChanged` returns `yield*` directly.
- **I-8 and the desktop half.** The metadata reading of I-8 (`ls-tree`,
  `rev-list --missing=print`, `config`, `version`) is now put to the owner
  as a third item of Q18 in addendum A §5, beside the `cat-file --batch`
  amendment, rather than left in this log. Not decided here. For VS-10, core
  `impact.ts`'s header says the desktop half calls the slice through the
  engine, unless BrainCode's path handling first becomes posix string helpers
  a renderer can import.
- **Pin.** `REVIEW_PIPELINE_SOURCES` `0d1995975936c407` →
  `5e30549464914097`, set after the last source edit and re-run;
  `REVIEW_PIPELINE_REVISION` stays 1 (nothing calls the slice);
  `policyDigest(DEFAULT_REVIEW_CONFIG)` stays `70512122f41ec160`. With
  `impact` unset nothing any runner does changes (I-1).
- **Timing** (the same scratch script and nine commits as above): 98 to
  2,538 ms in all, grep 34 to 649 ms, parse 9 to 1,221 ms, up to 1,772
  candidates and 61 gated, at most 56 confirmed and 23 packed call sites,
  at most 5,792 tokens; no time-box hit, no cap. Two commits now give 0 and
  70 tokens (one touches no definition; the other has changed definitions
  and no candidate), where the reserved frame was counted before.
- **Mutation check.** Fourteen mutations, each applied to the final file,
  run against its test file and restored byte for byte (`cmp`); all were
  caught: the first overload as twin; tokens from the reserved frame; edges
  not deduplicated; no header rule; the old name filter; the sentence not
  reserved; every glob kept; no glob cap; the deadline ignored; every changed
  name wanted; import lines kept; presence by path in `lacks`; presence by
  the listed paths in the search; tokens not recounted with the note.
- **Evidence.** Each file ran alone through the lock with `--timeout 30000`,
  `GITHUB_ACTIONS=false` and TMPDIR and XDG roots under
  `/tmp/vector-vectorscope/vs25b-fix/`:

  | Package | File | Tests |
  |---|---|---|
  | core | `test/review/impact.test.ts` | 35 (28 before) |
  | core | `test/brain/code-workspace.test.ts` | 14 (8 before) |
  | core | `test/review/prompt.test.ts`, `model-evidence.test.ts`, `config.test.ts` | 30, 20, 45 |
  | core | `test/brain/code-index`, `graph`; `test/review/trivial`, `symbols` | 8, 7, 44, 5 (unchanged) |
  | engine | `test/review/impact.test.ts` | 16 (12 before) |
  | engine | `test/review/eval`, `run`, `context`, `vectorscope-replay` | 28, 44, 6, 13 (unchanged, I-1) |
  | engine | `test/compliance/egress-inventory`, `node-bundle-guard` | 5, 3 |
  | app | `src/features/pull-requests/ai-review.test.ts` (`--preload ./happydom.ts`) | 107 (unchanged) |
  | desktop | `src/main/repo-index.test.ts` (`bun --no-env-file test`) | 16 (unchanged) |

  - `bun typecheck` passes in core, engine, app and desktop, and `bun tsgo -p
    ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`.
  - prettier passes on every new file and on the added lines of `code.ts`
    and `prompt.ts`; oxlint reports nothing on any added line.
  - The full root typecheck was not run: nothing is pushed.
  - Nothing was sent to a model, no paid run, no workflow dispatched, nothing
    published, and no user-visible string changed (D14).

## 2026-11-07 · VS-37a Three-tier slice packing (core and uncalled engine builder)

Addendum A VS-37 ("amends VS-25b step 5"), its §1 eval-only parameters, its §1a
row (as VS-36), its §3 VS-25 "Adopt VS-37" and its §4 Now window ("VS-36, VS-37,
VS-38 (core and uncalled engine impact files)"); round-two REPORT §4.2 (context
levels and forward context [LCI2, LCI8, RR5, RR6, RR7]) and §4.4 item 4. Built
at `6356a8c0`. VS-37 waits on Q18, so the tiers are reached only through
`ReviewImpact.build` with an eval-only `packing` argument, which nothing passes:
no key, no config or env parse, no runner. `run.ts`, `ai-review.ts`,
`provider.ts`, `session/llm.ts`, `posting.ts`, `cli/cmd/review.ts`, engine
`review/eval.ts` (code), `script/vectorscope-eval/replay.ts` (`VARIANTS`),
`review/types.ts`, `review/config.ts` and every @vector file (`workflow.ts`,
`command.ts`, `cli/cmd/github.*`, `github-*.ts`, `vectorscope.astro`) are
untouched. It implements the VS-37a plan as corrected by its critique: every
critique point was taken, two in another form and one by keeping the plan's
choice with the reason stated (items 5, 10 and 15 under "Critique points").
Nothing is committed (the lane brief).

- **What landed.**
  - **Core `review/impact.ts`** (pure, Node-only as before; `packSlice` and
    every VS-25b export unchanged, `changedDefinitions` gains an optional
    `{ ancestors?: boolean }` whose default is the old behaviour):
    `IMPACT_TIERS` (shares a 0.4, b 0.15, c 0.45; 3 signatures per target file,
    20 target reads, 8-line statement windows, 8 import lines per scope),
    `IMPACT_TIER_NAMES`, `IMPACT_FALLBACK_KINDS` (`a:unsupported`, `a:over-cap`,
    `a:missing`, `b:unsupported`, `b:over-cap`, `b:missing`, `c:no-statement`),
    `DEFAULT_PACKING`, the `ImpactPacking`, `ImpactPackingInput`,
    `SourceReference`, `TierSource`, `EnclosingScope`, `OutboundSignature`,
    `OutboundUse`, `ImpactFallback` and `ImpactTiers` types, and
    `impactPacking`, `outboundUses`, `outboundSpecifier`, `reexportTargets` and
    `packTiers`. `Reference` gains `statement?`; `ImpactSlice` gains `scopes?`,
    `outbound?`, `fallback?` and `tiers?`, set only by a tiered build, so a
    VS-25b slice is unchanged. `ImpactPrompt` picks the three new prompt fields;
    `ImpactRecord` also leaves out `scopes` and `outbound` (code text), so the
    artifact gains `fallback` and `tiers` only.
  - **Core `brain/code.ts`**: two additive exports.
    `importStatements(text, language)` gives each statement `imports` reads with
    its lines, its specifier line and its specifier (a Go block per entry, a
    Python `from` list to its `)`, a Rust `use` to its `;`, each within 4,000
    characters, and a Python list also before the next `from` or `import`
    line), from the same
    `IMPORT_PATTERNS`; `resolveWorkspace(file, specifier, files, workspace)` is
    `resolve`'s alias and package steps alone. `resolve` and `dependencies` are
    untouched, so `selectDependents` resolves exactly as before. Not a third
    code reader (I-10): it is `brain/code.ts`.
  - **Core `review/prompt.ts`**: `IMPACT_TIER_CAPS` (20 scopes, 6,000 characters
    a scope, 10 outbound signatures), `IMPACT_TIERS_INSTRUCTION`, and the
    renderers `impactScope` (`<untrusted_enclosing_scope … container="…">`) and
    `impactOutbound` (`<untrusted_outbound_signature … used_in="…">`).
    `impactBlock` renders scopes, changed definitions, outbound signatures, call
    sites, tests, the incomplete note, then the fallback note
    (`<untrusted_impact_fallback>`, one line). The trusted sentence is
    `IMPACT_TIERS_INSTRUCTION` when `impact.scopes` is set (a tiered slice
    always sets it, an empty list at least), else `IMPACT_INSTRUCTION`. The
    import from `impact.ts` stays type-only and the fallback wording is written
    out in `prompt.ts`; a new test reads both files' import statements.
  - **Core `review/model-evidence.ts`**: `CANONICAL_IMPACT_TIERS` (literal,
    every part the tiered block can show);
    `canonicalPrompts({ impact: "graph" })` appends the review and security
    prompts of the tiered slice for both trusts after VS-25b's four: 8 instead
    of 4. `REVIEW_PIPELINE_SOURCES` `5e30549464914097` → `491223f3c097098f`;
    `REVIEW_PIPELINE_REVISION` stays 1; `REVIEW_PIPELINE_FILES` needs no new
    file (`impact.ts`, `prompt.ts` and engine `parse.ts` are already pinned;
    `brain/code.ts` stays out, as the VS-25b entry explains).
  - **Engine `review/parse.ts`** (uncalled: only `review/impact.ts` and the
    VS-25a bench script import it): `ParseInput.statements?` and
    `ParsedReference.statement?`, and the frozen `STATEMENTS` table. Asked for
    statements, the depth walk records each statement node from the cursor alone
    (no `node.parent`, which tree-sitter answers by walking down from the root,
    the quadratic cost the extractor avoids) and the sweep keeps a stack of open
    statements, one pass however many references. Without the flag nothing
    changes: no query or `RULES` change, so the capture count is the same, and
    `QUERY_VERSION` stays 1 (a future fact cache keys on the flag too).
  - **Engine `review/impact.ts`** (still uncalled): `BuildInput.packing?`
    (eval-only), `inline?` and `diffShown?`; `ChangedFiles.references?` (the
    parser's references on each side's changed lines, filled by `readChanged`
    from the parse it already ran) and `large?` (sides over the parser's cap,
    which `readChanged` already detected); the definition mapping moved into a
    shared `definitionOf` and the unsupported list into `unsupportedOf`, both
    byte-identical in effect.
  - **`script/vectorscope-eval/README.md`**: `tier1`'s `fallback` and `tiers`.
- **How a tiered slice is packed** (`packTiers`). The budget is packSlice's
  (min(6,000, 15% of the context) tokens at 3.5 characters). The frame reserved
  first is the block with the tests, every incomplete reason with
  `MAX_SAFE_INTEGER` unsearched, every fallback kind at `MAX_SAFE_INTEGER`, and
  `IMPACT_TIERS_INSTRUCTION` with its line break. Three accounts share what is
  left, in order a, b, c: each may spend floor(share × what is left) plus what
  earlier accounts left unused, so a disabled or empty tier's share carries on;
  each block is charged its rendered length plus a line break.
  - **Tier a.** The changed definitions innermost to a changed line
    (`changedDefinitions` with `ancestors: false`), outer ones first, each
    packed whole: the import lines its changed lines use (each statement's lines
    that name one of its references, plus the statement's specifier line, at
    most 8, in line order, with a `⋯` line at each gap), then its own lines,
    with the signature of the innermost class, interface, struct, trait, enum or
    module around it (named as its container when it has one) as `container`. A
    definition is skipped, keeping its signature anchor, when tier a is off, its
    file is shown whole (`inline`, head side only), or the diff shows every line
    of it (`diffShown`). One inside a packed scope is covered. An exported
    ancestor that `changedDefinitions` names only because a changed local one
    sits inside it is never the scope: it is the header, or keeps VS-25b's
    signature anchor when it is no container (a function around a local helper).
    Past 20 scopes, or past tier a's share, a definition keeps its anchor with
    no excerpt built: the count is checked first, then the share against the
    scope's frame and then the frame plus its own lines (both are part of any
    block it could render). Only a scope whose own lines or excerpt are over
    6,000 characters counts as `a:over-cap`. Each changed side's lines,
    containers, references and import statements are read once, however many
    definitions it has.
    Then every other changed definition gets VS-25b's anchor, in
    `changedDefinitions`' order; the first anchor that does not fit closes the
    account (packSlice's rule).
  - **Tier b.** `outboundUses` ties each name on an added line to the import
    statement that brings it in: the name is written on the statement's lines
    (strings left out), or the line names it through a module the statement
    binds (`ns.f()` after `import * as ns`, a default import or a `require`; any
    name of a Python, Go, Rust or Java statement, with Go's package name from
    the specifier). A TypeScript named import is a value, so `db.save()` after
    `import { db }` binds `db` only; a name the file defines itself is never an
    import's; `{ format as fmt }` looks `format` up, never `fmt`, and
    `{ default as x }` is a default import. Specifiers resolve strictly
    (`outboundSpecifier`, below). For each use in order, the exported
    definitions of its targets (and of what their barrels re-export) with that
    name or alias (`default` only for a default import) are taken by start,
    skipping one already taken, a changed definition, one inside a packed scope,
    one in a file shown whole, and one whose first line the diff shows. At most
    3 per target file (a `.d.ts` or `.pyi` included) and 10 in all; the first
    that does not fit closes the account. Removed code gets no tier b.
  - **Tier c.** packSlice's call sites in packSlice's order. Top-k keeps the
    sites of the first k dependent files (tier c off is top-k 0); the rest go to
    `tiers.dropped.rank`, so confirmed = packed + `dropped.budget` +
    `tiers.dropped.rank`. A site's window is its statement clipped to the file;
    past 8 lines it is the 8 lines from min(max(line − 3, start), end − 7). With
    no statement it is ±3 lines, and each file with such a packed site counts
    once as `c:no-statement`. Windows never repeat a line, at most 60 sites, and
    the first that does not fit closes the account.
  - **Records.** `locations` as VS-25b (head-side scopes and anchors as
    `path:start`, outbound as `path:start`, sites as `path:line`); `fallback`
    (the builder's kinds merged with `a:over-cap` and `c:no-statement`, summed,
    zeros dropped, in kind order); `tiers.packing` (normalised), `tiers.view`
    (the changed paths treated as shown whole or without their diff: empty under
    the defaults), `tiers.tokens` per account, `tiers.shown` (ranges per tier:
    scope ranges and their import-line runs, anchors and outbound signatures as
    one line, call-site window runs; `base:` for base-side ranges),
    `tiers.external`, and `tiers.dropped` (`inline`, `shown`, `covered`,
    `scope`, `outbound`, `targets`, `rank`). Every list is sorted before use
    (`tiers.dropped.targets` too, which the builder fills as its concurrent
    reads finish), so
    input order never matters (tested by reversing every input).
- **How the builder reads tier b** (`readTargets`, only when `packing` names
  tier b). After step 7's confirmation, never alongside it, so tier b never
  takes time from confirmation: at most `TARGET_CONCURRENCY` (2) `git show`
  processes run while it does, and none run while confirmation's 4 do. The
  targets of the uses, in use order, at most 20 reads, then up to two more
  rounds for what their index files re-export. First, changed or not, a target
  is set aside, as `reason:path` in `tiers.dropped.targets`, when
  `input.ignored` or an ignore glob matches it (`ignored`; the globs through
  `classifyPath` itself, with `ignoreDefaults: false`, so a glob matches as in
  the review's file list, with core's minimatch) or `BrainCode.excluded` covers
  it (`excluded`). Then a changed target is read from the changed files' parse.
  Before any other read, a target is set aside when the head tree has no such
  blob (`absent`), a partial clone lacks it (`missing`, `b:missing`, never
  fetched: I-8), it is over the parser's cap (`large`, `b:over-cap`), no
  grammar reads it (`unsupported`, `b:unsupported`), or the read cap is
  reached (`cap`, `b:over-cap`). After a
  read, a generated header sets it aside (`generated`); a timeout is `time`
  (`b:over-cap`); a failed read is `error`. `ignored`, `excluded`, `generated`,
  `absent`, `binary` and `error` are never named to the model. Target reads run
  through a runner with its own incomplete set, so they never mark the slice
  incomplete. Reads are `git show --no-textconv <head>:<path>` only.
- **Builder fallbacks.** `a:unsupported` counts changed code files with no
  grammar (not binary files, failed reads, other refusals or large files);
  `a:over-cap` counts changed files over the parser's cap (`ChangedFiles.large`)
  plus, from `packTiers`, scopes over 6,000 characters; `a:missing` counts
  changed paths a partial clone lacks. A scope that only misses its share or
  the 20-scope cap is recorded in `tiers.dropped.scope` and told to nobody: its
  signature anchor still marks it. `packTiers` keeps an `a:` kind only when
  tier a packs, a `b:` kind only when tier b does and `c:no-statement` only
  when tier c does, so an arm never names a tier it left off.
- **Deviation from the lane brief: the parameters are not in `EvidenceScope`.**
  The brief says to record tier shares and top-k in `EvidenceScope`. Addendum A
  §1 says "`EvidenceScope` keeps key-driven fields only" and puts eval-only
  parameters in the artifact's variant record through a VS-21a follow-up
  (`VariantEntry.params`, `VariantRecord.params`, `VARIANT_PARAMS.engine`, an
  eval-only `RunInput` field), which has not landed. So they are a builder
  argument, never parsed from config or env, recorded in `tiers.packing` (and so
  in the artifact's `tier1` once VS-25b wiring fills it), and swept only in
  offline projections until the follow-up lands. `EvidenceScope`,
  `EVIDENCE_POLICY_KEYS`, `policyDigest` and `types.ts` are unchanged.
- **Correction to the VS-25b entry** (append-only; past entries are not edited).
  Its "Deferred" list put "VS-37: tiers a and b and call-site windows widened to
  the enclosing statement" in the runner-wiring window or later. Addendum §4
  puts VS-37's core and uncalled engine files in the Now window; this package
  builds them, and only VS-37's wiring stays deferred.
- **Scope of the engine half.** The brief allows "its uncalled engine side if
  the addendum lists one"; addendum §4 lists the uncalled engine impact files.
  Engine `review/parse.ts` is not named there, but it is runner-unreachable
  (imported only by `review/impact.ts` and `script/vectorscope-parse-bench.ts`)
  and its flag is the statement source tier c needs without a third reader, so
  it sits in the Now window with the builder. As a subagent this package could
  not ask the orchestrator first (critique item 16); a core-only split would
  move the parse.ts and builder changes to a VS-37b with the core API unchanged.
- **Interpretations.**
  - Top-k counts dependent files, not call sites. Only an unset top-k keeps
    every file; a set one that is negative or not a finite number is 0.
  - Statement windows replace ±3 lines, at most 8 lines; a compound statement
    (an `if`, a loop head, a `case`) gives its first line through the call's
    line.
  - VS-25b's signature anchors are kept and charged to tier a, also when tier a
    is off (so "c-only" is anchors plus call sites, VS-25b's content, and no
    `a:` or `b:` fallback note). Under the
    default shares the anchors are capped at tier a's share.
  - Shares are caps with carry-forward. The defaults are untuned: swept in
    offline projections, frozen before the held-out split (I-13).
  - `packSlice` stays the VS-25b arm. With tier c alone, whole shares and no
    statements, `packTiers` packs exactly packSlice's blocks (tested), and its
    `tiers.shown` gives their ranges; so the offline projection can measure
    every arm, VS-25b's included, on `tiers.shown`, or derive the untiered arm's
    ranges from its anchors and windows.
  - The fallback note renders alone, as the incomplete note does: a change
    Vector could not read still says so in one line (LCI18). With no fallback,
    an empty change still renders nothing.
  - Removed code gets no tier b (its uses no longer run).
  - Defaults when the builder gets no view: no file inline, every diff shown
    (the runner sends each file's diff unless it lists the file as not inlined);
    recorded in `tiers.view` so arms stay comparable.
  - Tier b covers names bound to an import; same-package Go and Java callees (no
    import) and globals are not resolved.
- **`outboundSpecifier`** (critique item 1). Stricter than `BrainCode.resolve`,
  which falls through to a sibling attempt and a suffix match for any bare
  specifier (`path`, `react`, `json` land on `src/path.ts`,
  `src/react/index.ts`, `json.py`): a relative TypeScript, JavaScript or Python
  specifier resolves through `resolve`; a bare TypeScript or JavaScript one only
  through the workspace (`resolveWorkspace`); a Python, Go, Rust or Java module
  path only when at least two of its segments match the target's path (one after
  Rust's `crate::`, `self::`, `super::` or in a `mod` declaration); a target in
  another language is dropped. Bound pairs that resolve to nothing are counted
  in `tiers.external`. `selectDependents` keeps `resolve` as it is.
- **Limitations.**
  - Rust `impl` blocks give no header (the parser has no `impl` definition), and
    Rust `if`/`match` in statement position sit inside an expression statement,
    so a call in their head gets that statement clipped to 8 lines; Rust tail
    expressions have no statement (`c:no-statement`).
  - Statement types are a per-language allowlist (`STATEMENTS`), not inferred.
  - A Go package import resolves to at most 8 of the folder's files
    (`matchSuffix`), so a callee in a ninth file is missed.
  - A Python `from pkg import f` with `f` defined in `pkg/__init__.py` gives
    nothing: `pkg` is one bare segment, never resolved under the strict rule.
  - Barrels are followed only for TypeScript and JavaScript index files and
    Python `__init__.py` relative imports, up to two more read rounds, within
    the 20-read cap.
  - A qualifier is matched as the single name before `.`, `?.` or `::`.
- **Critique points**: all 16 taken; three in another form or kept with reasons.
  1. Strict resolution: taken (`outboundSpecifier`, `resolveWorkspace`, the
     same-language filter, `tiers.external`); the fixture test has
     `src/path.ts`, `src/react/index.ts`, `json.py`, `os/path.py`,
     `fmt/print.go`, `serde.rs` and `java/List.java`.
  2. Binding names to imports: taken (`importStatements`, qualifiers, renames,
     the file's own definitions skipped), with tests for a local helper an
     import also exports, a method on a local object, a member of a named
     import, and `import * as ns` with `ns.fn()`.
  3. Innermost scope with its container as header: taken; an edit in a private
     method of an exported 200-line class packs the method under `container`.
  4. Target filters: taken (`ignored`, ignore globs, `excluded`, generated
     header), each as `reason:path`, never a model-visible fallback; the engine
     test shows the ignored and excluded targets are never `git show`n.
  5. Time box: taken in another form. Target reads run after confirmation, so
     they cannot push gated files into `dropped.time`, and through a runner that
     marks nothing incomplete. Comparing `dropped.time` between two timed runs
     is not deterministic, so the sweep (0, 1, 20, 150 ms) asserts the
     structural guarantee instead: whenever confirmation lost a file to the box,
     no target was read (every unread target is `time:`).
  6. Fallback kinds: taken (`large` exposed; `a:unsupported` for no-grammar code
     files only; a share overflow is `tiers.dropped.scope` only; the over-cap
     wording covers files and definitions).
  7. The fallback note alone: taken; it renders alone (tested).
  8. Type-only imports: taken, with a test over `prompt.ts` and
     `model-evidence.ts`.
  9. Resolution gaps: barrels followed (`reexportTargets`, read rounds),
     Python's submodule expansion reused (same module), Go's 8 files listed.
  10. Statements: taken in another form. A per-language allowlist of simple
      statements and of compound ones (header through the call's line), read in
      the depth walk instead of `node.parent` (the extractor never asks for a
      parent); Rust tail expressions have none; the instruction now says "with
      its statement or nearby lines".
  11. The Git layer: taken; a thin wrapper around the real `Git.Service` records
      commands (`recorded`), no behaviour mocked; `invariants()` adds
      `tiers.dropped.rank` only when `tiers` is present.
  12. View defaults: taken (inline none, every diff shown, `tiers.view`).
  13. Recall units: taken (`tiers.shown`, and the c-only equivalence test).
  14. The VS-25b entry: corrected above.
  15. The graph digest: kept. `promptsDigest` must render every section a prompt
      can have under a key, and under `graph` a runner may render either block;
      which packing a run used belongs to the eval's variant parameters, not
      this digest. It is harmless now: `impact` is in `UNAPPLIED_REVIEW_KEYS`,
      `MODEL_EVIDENCE` is empty, and VS-25b wiring recomputes the graph digest
      when it picks a packing.
  16. Scope of `parse.ts`: recorded above.
- **Digests.** `promptsDigest()` stays `5d59e9ee06077c23`;
  `promptsDigest({ impact: "grep" })` equals it;
  `policyDigest(DEFAULT_REVIEW_CONFIG)` stays `70512122f41ec160`;
  `promptsDigest({ impact: "graph" })` moved from `fd944d83f8d705ad` to
  `74a2111826c226b1` (pinned in the test); the pipeline pin moved as above;
  revision 1.
- **§0.3 items.**
  1. Key: none (addendum §1: "No new key for VS-36 to VS-39").
  2. Parity: no runner reads it; with `packing` unset the builder takes the
     VS-25b path (no statements asked, no target read, packSlice), tested with
     the recorded Git commands; the runner, replay and desktop suites pass
     unchanged.
  3. Evidence: no policy key; only the graph prompts digest moves; revision 1.
  4. Variant: none; `engine:impact-graph` stays pending VS-25b wiring, and the
     arms are computed offline from `tiers.shown`, `tiers.dropped` and `stages`.
  5. Desktop: a documented difference, `variant.applied: false`, until the VS-25
     desktop half or VS-10.
  6. This entry.
- **Owner questions: none decided.** Q13, Q15 and Q18 stay open, and so do Q9
  (the funded ablation) and Q26.
- **Deferred to the runner-wiring window or later.**
  - Which packing VS-25b wiring uses under `graph`, and the runner's `inline`
    and `diffShown` inputs (head files shown whole, files not inlined).
    Precondition for that wiring, written into `BuildInput`: `files` must be
    the set left after the secret holdback (VS-34) and the privacy rules, and
    `diffShown` or `inline` never stand in for a refusal (a file with no diff
    shown gets more of it in tier a, not less). `ignored` must carry
    `classifyPath`'s whole rule (default ignores, `.gitattributes`), as it does
    for `selectDependents`.
  - The VS-21a params follow-up and its eval-only `RunInput` field.
  - The Done-when projection: slice recall per context level needs the VS-22a
    follow-up's context-level label.
  - The kill-criteria arms (c, a+c, a+b+c; top-k 1, 3, 5) at equal packed
    tokens, with p50 and p90 tokens used; the separate C, C++, C# and PHP
    report; the Q9 funded ablation; the 2k to 8k budget sweep.
  - VS-36 item 3's RRF in tier c's order (tier c uses `selectDependents`' graph
    rank as it stands).
  - Deferred verification: macOS and Windows git, model behaviour, and latency
    on large repositories (the 50k-file band, VS-38).
- **Timing** (a scratch script, not committed): `build` with and without
  `packing: {}` over ten commits of this repository (`6356a8c0`, then `6e2f1d04`
  back to `7cadfcb8`, each against its parent; 1 to 19 files; Bun 1.3.14, git
  2.43.0, 4 vCPU, the default 4 s box). Untiered 82 to 3,932 ms, tiered 86 to
  3,605 ms; per commit the tiered build took −327 to +148 ms against the
  untiered one (the first untiered run also loads the grammars). No time-box hit
  or `dropped.time` either way, no incomplete reason. Tiered: up to 8 scopes, 34
  anchors, 10 outbound signatures, tier tokens up to 2,207 (a), 750 (b) and
  2,984 (c), `external` up to 19, no unread target; fallbacks seen: `a:over-cap`
  (a scope over 6,000 characters) and `c:no-statement`.
- **Evidence.** Each file ran alone through the lock with `--timeout 30000`,
  `GITHUB_ACTIONS=false` and TMPDIR and XDG roots under scratch:

  | Package | File                                                                                                                                               | Tests                                              |
  | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
  | core    | `test/review/impact.test.ts`                                                                                                                       | 59 (35 + 24 new)                                   |
  | core    | `test/review/prompt.test.ts`                                                                                                                       | 36 (30 + 6 new)                                    |
  | core    | `test/review/model-evidence.test.ts`                                                                                                               | 20 (one extended; the pin)                         |
  | engine  | `test/review/parse.test.ts`                                                                                                                        | 59 (53 + 6 new; `STATEMENTS` frozen)               |
  | engine  | `test/review/impact.test.ts`                                                                                                                       | 23 (16 + 7 new; real git, a blobless sparse clone) |
  | core    | `test/review/config`, `trivial`, `symbols`, `plan`, `select`, `eval`, `pipeline`; `test/brain/code-workspace`, `code-index`, `migration-knowledge` | 45, 44, 5, 21, 43, 42, 2, 14, 8, 3 (unchanged)     |
  | engine  | `test/review/eval`, `run`, `context`, `vectorscope-replay`; `test/cli/github.review`; `test/compliance/egress-inventory`, `node-bundle-guard`      | 28, 44, 6, 13, 40, 5, 3 (unchanged, I-1)           |
  | app     | `src/features/pull-requests/ai-review.test.ts` (`--preload ./happydom.ts`)                                                                         | 107 (unchanged)                                    |
  - `bun typecheck` passes in core, engine and app (tests included), and
    `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json` from
    `packages/engine`.
  - prettier passes on the new and changed lines (`brain/code.ts`, `prompt.ts`
    and `prompt.test.ts` were not prettier-clean at HEAD, so their untouched
    lines keep their formatting); oxlint reports no warning on any added line.
  - **Mutation check.** 20 mutations, each applied alone, run against its test
    file and restored byte for byte; all 20 caught: shares ignored; carry
    dropped; inline not skipped; nested scope not covered; a scope overflow
    closing tier a; the outer ancestor packed as the scope; tier b not
    deduplicated against the diff; tier b's per-file cap removed; tier b names
    not tied to an import; tier b qualifiers ignored; the statement not clipped
    to 8 lines; ±3 lines despite a statement; top-k counted by sites; the
    fallback reservation removed; the fallback note never rendered alone;
    `packTiers` used with `packing` unset; statements asked for with `packing`
    unset; a partial clone's missing target read; an ignored target read; a
    compound statement read as simple.
  - The full root typecheck was not run: nothing is pushed.
  - Nothing was sent to a model, no paid run, no workflow dispatched, nothing
    published, and no user-visible string changed (D14).

- **Review findings, round one** (ten findings, three blocking; fixed before
  any commit, so the text above already describes the fixed code).
  1. Blocking: `tiers.dropped.targets` came in the order concurrent target
     reads finished. Fixed in core: `packTiers` sorts `unread`, for any
     caller. The determinism test passes `unread` and its reverse; the engine
     test compares the list without sorting it first.
  2. Blocking: Python `from x import (` with no `)` of its own ran to the next
     `)` anywhere in the file (`pythonEnd` was unbounded, unlike the Rust
     4,000-character bound), so `importsOf` and `outboundUses` worked over
     whole-file bodies: 8.6 s for one 1 MB file, outside the time box. Fixed in
     `brain/code.ts`: the `)` counts only within 4,000 characters
     (`STATEMENT_CHARS`, shared with the Rust bound) and before the next line
     that starts with `from` or `import`, else the statement is its line. A
     core test checks the statement spans of a 1 MB file, a list closing past
     the bound and one closing before it (spans, not wall time).
  3. Blocking: tier a built an excerpt (re-splitting the file and re-running
     `importsOf`) for every innermost changed definition before checking the
     scope cap or the share, and `holder` scanned every changed definition for
     each one: 4.1 s for 1,000 changed functions in 350 KB, 26.2 s for 3,000
     in 1 MB, for 13 packed scopes. Fixed: each changed side is read once
     (`input.source` memoised; one scope view per side holds its lines,
     containers, references by line and the import lines each word is on);
     the scope cap and the share are checked against the scope's frame, then
     the frame plus its own lines, before any excerpt is built; `holder` is a
     binary search over each side's innermost changed definitions with a
     suffix minimum of their ends. The reviewer's scratch benches now take
     32 ms (1,000 functions) and 59 ms (3,000), and the Python one 146 ms for
     1 MB. A core test changes 3,000 functions and checks that the side is
     read exactly as often as with 5 (once from `source`) and that the 2,980
     past the cap fall back quietly. One ordering change: a definition over
     6,000 characters only through its import lines, when tier a has no room
     for its frame and own lines, is now a quiet share miss rather than
     `a:over-cap`; one over the cap through its own lines still counts.
  4. The 20-scope cap counted `a:over-cap` ("over the size limit") for every
     definition past it. Fixed with item 3: the count cap is a quiet
     `tiers.dropped.scope` entry, never a fallback; tested there.
  5. A renamed import also matched the local alias against the target's
     exports. Fixed: tier b looks a use up by `original ?? name` only, and
     `{ default as x }` counts as a default import. Tested with targets that
     also export the alias.
  6. `readChanged` built every side's references for every caller. Fixed:
     each side's are picked out on its first ask (`changedReferences`, cached
     per side), so an untiered build and a `parseChanged` caller that never
     asks do no extra work.
  7. Builder fallbacks were counted whichever tiers were on, so the c-only arm
     carried `a:unsupported`. Fixed in `packTiers`: an `a:` kind counts only
     with tier a, `b:` with tier b, `c:` with tier c. Tested with tiers
     `["c"]`, `["a", "c"]`, `["b"]` and all three.
  8. Tier b's ignore check had its own `minimatch` call (engine pins 10.0.3,
     core 10.2.5). Fixed: the globs go through `classifyPath` with
     `ignoreDefaults: false`, and the engine file no longer imports
     `minimatch`. Taken in part: the default ignores and `.gitattributes` stay
     with the caller's `ignored` callback, as for `selectDependents`, because
     the builder takes globs, not a `ReviewConfig`, and `ignoreDefaults` is a
     config key wiring owns; `BuildInput` now says so. The binary-path check
     comes with `classifyPath` but never fires (a target must be in the
     changed file's language).
  9. Holdback and privacy: taken as a written precondition (`BuildInput` doc
     and the deferred list above), and the optional reorder taken: `ignored`
     and `excluded` run before the changed-target shortcut, so an ignored
     changed file is never read from the changed parse either. An engine test
     shows an ignored changed target's unchanged export packed without the
     rule and set aside with it.
  10. A negative or non-finite top-k meant every dependent file. Fixed: a set
      top-k is floored and clamped at 0, a non-finite one is 0, and only
      `undefined` keeps every file (documented on `impactPacking`; tested).
  - Pin: `REVIEW_PIPELINE_SOURCES` is `491223f3c097098f` (core and engine
    `impact.ts` changed); `REVIEW_PIPELINE_REVISION` stays 1; `promptsDigest`
    values are unchanged (no prompt text moved).
  - Re-run after the fixes, each alone through the lock: core
    `test/review/impact.test.ts` (59), `prompt.test.ts` (36),
    `model-evidence.test.ts` (20), `ignore.test.ts` (13),
    `test/brain/code-index.test.ts` (8), `code-workspace.test.ts` (14); engine
    `test/review/impact.test.ts` (23). `bun typecheck` passes in core and
    engine. No runner-reached file changed (`ignore.ts` is untouched, and the
    `brain/code.ts` change is inside `importStatements`, which only VS-37a
    calls), so the runner, replay and app suites were not re-run.
  - Mutation check of the fixes: ten mutations, each applied alone and
    restored byte for byte, all caught: `unread` left unsorted; `pythonEnd`
    unbounded again; the local alias matched; fallbacks unfiltered by tier;
    `a:over-cap` counted at the scope cap; `input.source` not memoised; the
    scope view not memoised; `holder` never true; a negative top-k unset; the
    changed-target shortcut before the ignore check.
  - prettier is clean on core and engine `impact.ts` and both `impact.test.ts`
    files, and on the changed lines of `brain/code.ts`; oxlint reports
    nothing on a changed line.

## 2026-11-07 · VS-27a Strict schema and import-free failure types

Contract §1.2 (the `types.ts` block and "Types that change") and §4 VS-27a;
addendum A §3 VS-27 and the round-two amendments in the lane brief (strict
schemas as key-conditional builders; §1.2's `Quote` as the one quote type).
Evidence: REPORT §4.4 item 3 (the guardrail fails closed), [landscape §4
item 5] (deterministic validators on model output), round-two REPORT §2.2
[GP3] (Greptile's output schema, severity defaulting to its lowest level).
Built at `f7e1f8df`. VS-27 waits on Q15, so this is the Now window only: types,
schemas, a strict decoder path and an off-by-default key that no runner reads.
`run.ts`, `provider.ts`, `session/llm.ts`, `posting.ts`, `cli/cmd/review.ts`,
`prompt.ts`, `select.ts`, `format.ts`, `diff.ts`, `replay.ts` (`VARIANTS`:
`engine:guardrail-strict` stays pending VS-27c) and every @vector file
(`workflow.ts`, `command.ts`, `cli/cmd/github.*`, `github-*.ts`,
`vectorscope.astro`) are untouched. `ai-review.ts` and `review.render.ts` gain
only label entries the widened pass-name union forces. It implements the VS-27a
plan as corrected by its critique: every critique point was taken; where it
offered two forms, the one taken is named (items 8, 11, 13 and 14 under
"Critique points"). Nothing is committed (the lane brief).

- **What landed.**
  - **Core `review/types.ts`** (still import-free): `FAILURE_CLASSES` and
    `FailureClass`, `FAILURE_MECHANISMS` and `FailureMechanism`, `FailureInfo`,
    `Quote {path, line, side, code}` (the one quote type; VS-44's trace reuses
    it), `VERIFIED_BY` and `VerifiedBy`, `STRICT_FIX_KINDS`, `STRICT_DROPS`
    (the contract's ten, S1 to S8 order) and `StrictDrop`, `StrictFinding` and
    `StrictResult`, in one block after `Finding`. `ModelFinding` gains
    `failure?`, `quotes?` and `patch?`; `Finding` gains `verifiedBy?`
    (`verified` stays a boolean). `ReviewOutcome.partial` gains `"privacy"` and
    `"budget-estimate"`; `ReviewOutcome.specialists[].name` and
    `ReviewPass.name` widen once to `"review" | "security" | "verify" | "judge"
    | "lens" | "repro"` (codium's four first, in codium's order), each with
    `lens?: string` on the next line; `ReviewOutcome` gains `strict?:
    StrictResult` as its last field. `ReviewConfig` gains `guardrail?: "off" |
    "strict"` after `impact?`; `OPTIONAL_REVIEW_DEFAULTS.guardrail` is `"off"`
    and `UNAPPLIED_REVIEW_KEYS` gains `"guardrail"`.
  - **Core `review/schema.ts`**: `MAX_FAILURE_TEXT_CHARS` (400, S5),
    `MAX_FINDING_QUOTES` (6), `MAX_QUOTE_LINES` (20), `MAX_QUOTE_CHARS`
    (2,000); `StrictSchemaKeys` (`Partial<Pick<ReviewConfig, "guardrail">>`,
    which VS-42, VS-43 and VS-44 widen); `strictReportJsonSchema(keys)` and
    `strictResultJsonSchema(keys)`, each `undefined` unless `keys.guardrail ===
    "strict"`; `decodeReport(input, keys = {})`, whose strict path reads
    `failure`, `quotes` and `patch` through private `decodeFailure`,
    `decodeQuote` and `cleanCode`; the fence regex is now a private `FENCED`
    shared by `cleanSuggestion` (behaviour unchanged) and `cleanCode`.
    - The strict report schema is `REVIEW_REPORT_JSON_SCHEMA` deep-copied with
      `structuredClone`, then rebuilt by spreads over the copy (never over the
      constant), with a finding's properties gaining, in order, `failure`
      (`class` and `mechanism` enums, `trigger` and `impact` at maxLength 400,
      all four required inside it), `quotes` (an array of quote objects, all
      four fields required, `line` an integer of at least 1, `side`
      RIGHT/LEFT, `code` at maxLength 2,000) and `patch` (maxLength 8,000). The
      finding's `required` list is the legacy one. The return type is inferred
      exactly, and nothing returned shares an object with the constant or with
      another call (tested by mutating one).
    - The result schema has every `StrictResult` and `StrictFinding` field,
      enums from the constants above, `quotes` at minItems 1 and maxItems 6,
      `dropped[].count` at minimum 1 and `fixUnchecked` at minimum 0; every
      field is required except `incomplete` and `endLine`.
    - Strict decoding: a failure needs a record whose class and mechanism name
      an enum value after lowercasing, trimming and turning spaces and
      underscores into hyphens; `trigger` and `impact` are `oneLine`d and kept
      whole, even empty, for S5. A quote needs a record; a line that is a safe
      integer of 1 or more, or text matching `/^\s*L?\d+\s*$/i` (anything
      else, such as `"-5"`, `"line -5"`, `"line 12"`, 15.4 or 0.6, drops the
      quote; finding lines keep their lenient reading); a path, `cleanPath`ed
      or the finding's when empty, with no `..` segment, backslash or drive
      prefix; and non-empty code within 20 lines and 2,000 characters after
      `cleanCode` (CRLF to LF, one enclosing fence removed unless the path is
      a Markdown file, empty lines at the start and end stripped, every other
      space kept). Its line moves down by the empty lines stripped from the
      start, so it stays the code's first line. LEFT only when it says
      "left". The first 6 quotes that decode among the first 24 entries
      (`MAX_QUOTES_READ`) are kept. A patch goes through `cleanCode` with the
      8,000-character cap and no line cap. Over a cap, code and patches are
      dropped, never cut, and a text over its cap plus 64 characters is
      dropped before the fence regex runs.
  - **Core `review/model-evidence.ts`**: `EVIDENCE_POLICY_KEYS` gains
    `"guardrail"` (counted from VS-27c on, and then only as `"strict"`).
    `promptsDigest(keys)` takes `Partial<Pick<ReviewConfig, "impact" |
    "guardrail">>`; its memo key joins `impact:graph` and `guardrail:strict`
    (the default key stays `""`), and the strict schemas are appended after
    `VERIFY_JSON_SCHEMA` only when defined. `evidenceScope` passes
    `{ guardrail: "strict" }` only when the config says so and the key has left
    `UNAPPLIED_REVIEW_KEYS`, as for `impact`. `canonicalPrompts` is unchanged
    in signature and output; its comment says VS-27c adds the strict task text
    there. `REVIEW_PIPELINE_SOURCES` `491223f3c097098f` → `511f0bffc7b5d314`
    (only `ai-review.ts`'s `PASS_LABEL` moved among the pinned files);
    `REVIEW_PIPELINE_REVISION` stays 1, because no runner produces the new
    pass names and nothing found or posted changes.
  - **Core `review/config.ts`**: `FIELDS.guardrail` (`oneOf(["off",
    "strict"])`), `REVIEW_GUARDRAIL` in `ENV`, and an `UNAPPLIED.guardrail`
    warning for `"strict"`: `"guardrail": "strict" is not applied yet: findings
    are still selected and posted as before.` A plain key (contract §1.1:
    existing sources), not source-tagged.
  - **Core `review/verdict.ts`**: comment only. It now says the `partial` and
    name values exist in `ReviewOutcome` since VS-27a and that its repeated
    unions are redundant and harmless (decision i).
  - **Engine `review/eval.ts`**: `WIRING.guardrail = "VS-27c"` (the `Record`
    over `UNAPPLIED_REVIEW_KEYS` forces it) and the `ReplayInput.config`
    comment.
  - **Engine `cli/cmd/review.render.ts`** `passesLine` name map and **app
    `ai-review.ts`** `PASS_LABEL`: `judge` ("panel judge" / "Panel judge",
    codium's exact text), `lens` ("lens" / "Lens") and `repro` ("reproducer" /
    "Reproducer"). Typecheck forced them; no runner produces these names.
  - **`script/vectorscope-eval/dataset.ts`**: imports `FAILURE_CLASSES` and
    `FAILURE_MECHANISMS` from core `review/types.ts` (import-free), re-exports
    `FAILURE_CLASSES` and sets `MECHANISMS = FAILURE_MECHANISMS`. Values are
    unchanged, so the schema stays `vectorscope-dataset/2`. `TRIVIAL_KINDS`
    keeps its copy (core `trivial.ts` has runtime imports), now checked equal
    to core's.
  - **Tests**: core `schema.test.ts` (+21), `model-evidence.test.ts` (+2),
    `config.test.ts` (+4 and the `OPTIONAL_REVIEW_DEFAULTS` equality); engine
    `test/review/eval.test.ts` (+1, and a refusal case);
    `script/vectorscope-eval/fixtures.test.ts` (+1).
- **Off by default (I-1, I-12).**
  - `guardrail` is optional and absent from `DEFAULT_REVIEW_CONFIG`; it is in
    `UNAPPLIED_REVIEW_KEYS`, so `policyDigest` and `evidenceScope` read it as
    absent; the engine replay drops it from the base `review.json` (keeping
    the warning) and refuses it in `ReplayInput.config` ("(VS-27c)"); the
    parser warns on `"strict"`.
  - The strict schemas exist only for `keys.guardrail === "strict"`, and no
    caller passes that. Every `decodeReport` call site (`run.ts:698`,
    `ai-review.ts:1576`, `script/vectorscope-eval/run.ts:361`) still passes one
    argument, so failure, quotes and patch are ignored exactly as before
    (tested with and without `{}` and `{ guardrail: "off" }`, on objects and
    text).
  - Digests: `promptsDigest()` stays `5d59e9ee06077c23`; `{ impact: "graph" }`
    stays `74a2111826c226b1`; `policyDigest(DEFAULT_REVIEW_CONFIG)` stays
    `70512122f41ec160`. New, pinned as VS-27a's schema-only strict digests:
    `{ guardrail: "strict" }` is `f04c185c5b415aaf` and `{ impact: "graph",
    guardrail: "strict" }` is `9c87880d813f1e69`. VS-27c moves both on purpose
    when the strict task text joins `canonicalPrompts`; VS-42, VS-43 and VS-44
    must each leave them at whatever value is current when they land, with
    their own keys off.
  - The new union members and fields (`privacy`, `budget-estimate`, `judge`,
    `lens`, `repro`, `lens?`, `strict`, `verifiedBy`, `failure`, `quotes`,
    `patch`) are produced nowhere. The engine replay test with a base
    `review.json` under `"strict"` checks that the request carries the legacy
    schema (no `"failure"`, `"quotes"` or `"patch"` key) and that the placed
    findings carry none of the strict fields and the outcome no `strict`.
  - §0.3 item 4: the variant stays pending VS-27c. Item 5: no desktop half in
    this package (types, schema and parse only); the desktop parses the key and
    never reads it.
- **Decisions.**
  - (a) **The Strict types moved to `types.ts`** (a lane deviation from §1.2,
    which puts `StrictFinding`, `StrictDrop` and `StrictResult` in
    `guardrail.ts`): `ReviewOutcome.strict` needs them and `types.ts` stays
    import-free. VS-27b's `guardrail.ts` imports them and adds `StrictInput` and
    `strictSelect`. The enums are exported constants (`FAILURE_MECHANISMS`,
    `VERIFIED_BY`, `STRICT_FIX_KINDS`, `STRICT_DROPS`) so the schemas and tests
    derive from one list.
  - (b) **Key-conditional builders.** The round-two amendment asks for the
    strict report schema (and VS-44's certificate schema) as builders. It does
    not name the result schema: `strictResultJsonSchema(keys)` replacing §4
    VS-27a's `STRICT_RESULT_JSON_SCHEMA` constant is this lane's own deviation,
    from §4 VS-27a and from VS-27c's Done line. Reason: VS-42 adds the
    `pre-existing` drop and VS-44 `certificate-mismatch` and `verdict-unsure`,
    and addendum §3 adds `StrictResult` fields; as a constant, each would move
    the `guardrail: "strict"` digest with its own key off. Both builders return
    `undefined` when off. **VS-27c's Done check becomes: the JSON validates
    against `strictResultJsonSchema(keys)` for the run's keys.**
  - (c) **`decodeReport` takes keys** (default `{}`), so the legacy path is
    byte-identical and call sites keep one argument. Caps and the
    drop-not-cut rule as above. A quote is a claim S4 checks at its exact
    line, so its line is read strictly (the critique's second option, made
    whole by review finding 2): only a safe integer of at least 1, or text
    that is only one after an optional `L`. `"-5"`, `"L-5"` and `"line -5"`
    read as 5, or 15.4 and 0.6 rounded to 15 and 1, would point it at another
    line; they drop the quote. `"line 12"` is refused too, as the cost of one
    plain rule (the schema asks for an integer). Finding lines keep their
    lenient reading (tested).
  - (d) **Severity.** GP3's rule (an unparseable severity is dropped, never
    defaulted to the lowest level) is addendum §3's rule for precise mode
    (VS-31), not for strict. Strict decoding keeps the legacy reading, so an
    unreadable severity is `"concern"`: never read as blocking (tested), and
    S2 will count it as `not-blocking`, the same drop as a model that chose
    `concern`. That merges two causes kill-criteria analysis may want apart.
    **Hand-off to VS-27b**: decide, before `STRICT_DROPS` is relied on, whether
    strict decoding marks an unreadable severity (for example a decoder-side
    flag) and whether it gets its own drop; a new drop moves the strict
    digest.
  - (e) `lens?` sits on both the specialists entry and `ReviewPass`, directly
    after `name`, so each branch's edit stays in one hunk. Judge labels copy
    codium's text. The new labels are unreachable until VS-28 or VS-30 wiring,
    which may reword them (D14: no existing user-visible string changed; the
    labels and the parser warning are new strings that appear only for a new
    key or a pass that does not run yet).
  - (f) `run.ts`'s `Name` and `Stop` are left to VS-23b, VS-24 wiring, VS-28
    and VS-30: they are narrower than the outcome types and still assign.
  - (g) **Latent wording gap**, unreachable until wiring: `notePartial`
    (`format.ts:478-505`) would word `privacy` and `budget-estimate` as the
    time-limit stop; the CLI `partialLine` (`review.render.ts:156-172`) as "a
    reviewer could not finish"; and the GitHub job (`github.review.ts:913-917`,
    @vector-owned) passes `outcome.partial` to `notePartial` and picks its
    wording, which waits for the @vector merge. VS-23b and VS-24 wiring must add
    their wording before a runner produces either value. No compile error
    forces it: narrowing `notePartial`'s `reason` to exclude both values was
    tried (review finding 5) and breaks `github.review.ts(917)`, which passes
    `ReviewOutcome["partial"]` unnarrowed and is @vector's (and engine
    `eval.ts(870)`), so `format.ts` stays untouched and this entry is the
    gate. **Test items for VS-23b and VS-24 wiring**, before their runner
    produces the value: a `format.test.ts` case that `notePartial({ reason:
    "privacy" })` and `notePartial({ reason: "budget-estimate" })` say "Not
    reviewed" (I-7) and never "time limit"; a `review.render.test.ts` case for
    `partialLine` with each; and, once @vector has merged, a
    `github.review.test.ts` case for the banner.
  - (h) **Pass-name filters that would mishandle lens and repro**, hand-offs to
    VS-28 and VS-30: `name !== "verify"` filters would count them as reviewers
    (`github.review.ts:702`, @vector; `review.ts:450`; engine `eval.ts:830`;
    `script/vectorscope-eval/report.ts:389`); `review.render.ts:159`'s
    `partialLine` would name a failed lens "the lens reviewer" (codium already
    adds `&& entry.name !== "judge"` there, which the merge resolution must
    keep); `ai-review.ts:1101` (`run.name === "verify" ? model : first`) would
    label a lens or repro pass with the triage model, though the contract runs
    lenses on the review model.
  - (i) `verdict.ts`'s structural unions are now redundant but harmless; its
    comment says so, and VS-32 wiring may simplify them.
  - (j) `schema.ts` stays outside `REVIEW_PIPELINE_FILES`, as VS-07 chose; its
    default decoding is unchanged and tested. Suggest that VS-27c add it when
    strict decoding reaches a runner.
  - (k) `dataset.ts` imports the classes and mechanisms. This closes VS-22a's
    deferred item (the VS-22a entry's "When VS-27a and VS-24 land") for all
    three lists: the classes and mechanisms are core's own objects (`toBe`),
    and `TRIVIAL_KINDS` is checked equal to core `trivial.ts`'s in
    `fixtures.test.ts` (which runs from `packages/script` and imports it).
  - (l) The strict report schema keeps the quote cap in its description, not
    in `maxItems`, so it sends providers only keywords the legacy schema
    already sends (a test pins the keyword set); the decoder enforces the cap.
    The result schema, never sent to a model, keeps `minItems` and `maxItems`.
- **Critique points** (all taken).
  1. Merge prediction against `origin/self-evolving` as well as
     `origin/codium`: taken (below).
  2. The keyword test walks schema positions only (property names are not
     keywords), allows `maximum`, and the legacy denylist test is unchanged.
  3. The builder replacing `STRICT_RESULT_JSON_SCHEMA` is logged as this lane's
     deviation, in the code comment and in (b).
  4. The pin names VS-27a's schema-only strict digest, says VS-27c moves it,
     and states the invariant for VS-42 to VS-44.
  5. Clone once, then spreads over the clone: taken; the type is exact.
  6. Stop rule for @vector files: no type error arose in any @vector file;
     `github.review.ts:913-917` is in (g).
  7. `review.render.ts:159` and `ai-review.ts:1101` are in (h), with codium's
     judge exclusion noted.
  8. `TRIVIAL_KINDS`: the equality assertion was added (first option).
  9. Severity: (d) records that the rule is VS-31's and hands the decision to
     VS-27b.
  10. The import-free test uses an anchored statement regex plus `require(`
      and dynamic `import(` checks, and asserts the prose "copied out of a
      file" is present so the anchor is exercised.
  11. `verdict.ts`'s comment was updated (first option) and (i) says so.
  12. Path and patch hand-offs and the desktop identity check are in the
      deferred list below.
  13. Negative quote lines are refused (second option), and tested (c).
  14. `maxItems`: taken in the second form, the cap moved into the
      description (l); the per-provider check stays in deferred verification.
- **Predicted merge conflicts** (read-only: `git merge-tree --write-tree
  --name-only` at HEAD, then a three-way `git merge-file` per touched file
  with each branch's merge base, HEAD or the working tree, and the branch tip;
  the per-file method reproduces merge-tree's HEAD result exactly).
  - At HEAD: `ai-review.ts` only, 5 hunks with `origin/codium` and 2 with
    `origin/self-evolving`.
  - With VS-27a, `origin/codium`: `types.ts` 2 hunks (the specialists `name`
    line plus `lens?`, against codium's judge-only line; `ReviewPass.name` plus
    `lens?`, against codium's `usageMissing?`, `costKind?` and judge line);
    `ai-review.ts` 6 hunks (the new one holds only the `lens` and `repro`
    `PASS_LABEL` lines; codium's identical `judge` line merges cleanly);
    `review.render.ts` 1 hunk (the name map, next to the `priced` line both
    branches rewrite). `schema.ts`, `model-evidence.ts`, `config.ts`, engine
    `eval.ts`, `dataset.ts`, `verdict.ts` and the tests: none.
  - With VS-27a, `origin/self-evolving` (which merges first, as the
    runner-wiring gate): `types.ts` 1 hunk (`ReviewPass.name` plus `lens?`,
    against its `usageMissing?` and `costKind?`); `ai-review.ts` still 2;
    `review.render.ts` 1 (the name map and the `priced` line). Nothing else.
  - Every resolution is to keep both sides' lines; this lane resolves none of
    them (the branch owners do, §0.2).
- **Owner questions, kept neutral.** Q3 and Q4: the class names are the
  contract's; their definitions wait for VS-27c's prompt, and the
  `PENDING_Q4` markers stay. Q17: `"unchecked"` is only a fix kind here;
  whether such a fix is posted is VS-27b's and VS-27c's. Q13 and Q15: nothing
  reaches a runner. Q18 to Q34: no addendum package is built here.
- **Deferred.**
  - From addendum §3 VS-27, the Greptile-derived `StrictResult` fields:
    `linkedRule` (only after VS-43 fixes the structured rule shape),
    `clarificationQuestion`, `securityIssue`, before and after snippets,
    per-file notes; and `checked[]` (VS-47).
  - VS-42's `scope` field (only under `scopeGate`) and its `pre-existing` drop;
    VS-44's verify-certificate schema builder and its `certificate-mismatch`
    and `verdict-unsure` drops.
  - VS-27b: `guardrail.ts` (`StrictInput`, `strictSelect`, S1 to S8), the
    `sameFinding` export, the `diff.ts` patch applier, format wording, and the
    S1 to S8 tests, including the severity case (d) and the
    impact-incompleteness test. Its S4 check and patch applier must still keep
    every quote path inside the head or base tree-ish (the decoder now drops a
    quote path with a `..` segment, a backslash or a drive prefix, but a
    structural check is not containment: a symlink in the tree, for one) and
    must ignore, or check against the finding's path, the model-written file
    headers of a patch (I-8). S4 compares a quote's code with the file from
    its `line` on, which the decoder keeps paired; it needs no line fix-up of
    its own.
  - Legacy `cleanSuggestion` (runner-reached, unchanged here) runs `FENCED` and
    `/\s+$/` over the whole suggestion before its cap, and both backtrack
    quadratically on a long run of backticks or line breaks (under bun,
    `FENCED` took 57 ms on 8,064 backticks and 1,417 ms on 40,000). A
    pre-check like `cleanCode`'s would drop a suggestion whose fence and
    padding exceed the allowance, which is no longer byte-identical (I-1), so
    it is left for a package allowed to move legacy output, or for a
    semantics-preserving rewrite with a golden test.
  - VS-27c: runner wiring; the strict task text in `canonicalPrompts` under
    the key; the `--json` outcome; the variant flip; the desktop half;
    artifact candidates; `report --reselect strict`; validation with
    self-evolving's `json-schema-check.ts`; memoising the strict schema, or
    changing `script/vectorscope-eval/desktop.ts:299`'s identity check
    (`=== REVIEW_REPORT_JSON_SCHEMA`), because the builder returns a new object
    on every call.
  - The strict prompt's class definitions matching the rubric (VS-22a's item).
- **Deferred verification.**
  - The branch has no JSON Schema validator, so conformance is checked with a
    small structural validator in `schema.test.ts` over the keywords these
    schemas use.
  - Whether providers accept the strict report schema in forced tool calls
    (a nested `failure` object and `quotes` objects inside each finding item;
    `maxLength` on new fields; no `maxItems` or `minItems`), and how models
    answer it, needs VS-27c's fake-provider tests per provider family (the
    OpenAI sanitizer, `sanitizeOpenAISchema` in engine
    `provider/transform.ts:1553-1626`, rebuilds each schema from a subset of
    keywords; Gemini, Moonshot and Anthropic tool input receive it as written)
    and then a paid run (D7, Q9).
  - The merge conflicts are only predicted.
- **Evidence.** Each file alone through the lock, `--timeout 30000`, from its
  package directory; counts at HEAD → with VS-27a.

  | File | HEAD | VS-27a |
  |---|---|---|
  | core `test/review/schema.test.ts` | 24 | 45 (42 before the review findings) |
  | core `test/review/model-evidence.test.ts` | 20 | 22 |
  | core `test/review/config.test.ts` | 45 | 49 |
  | core `test/review/verdict.test.ts` | 44 | 44 |
  | core `test/review/select.test.ts` | | 43 |
  | engine `test/review/run.test.ts` | 44 | 44 |
  | engine `test/cli/github.review.test.ts` | 40 | 40 |
  | engine `test/cli/review.render.test.ts` | 10 | 10 |
  | engine `test/review/vectorscope-replay.test.ts` | 13 | 13 |
  | engine `test/review/eval.test.ts` | 28 | 29 |
  | engine `test/review/structured-output-review.test.ts` | | 3 |
  | app `ai-review.test.ts` (`--preload ./happydom.ts`) | 107 | 107 |
  | eval `replay.test.ts` (from `script/vectorscope-eval`) | 32 | 32 |
  | eval `fixtures.test.ts` (from `packages/script`) | 65 | 66 |

  - `bun typecheck` passes in core and engine; the eval scripts pass `bun tsgo
    -p ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`.
    App and desktop pass `bun typecheck --force`. Without `--force`, their
    `tsgo -b` reported "up to date" after a core-only change (it compares only
    the project's own inputs with its build info), so the app's missing
    `PASS_LABEL` entries surfaced only when forced: a hint for every lane that
    changes core types.
  - prettier is clean on every changed file; oxlint reports no warning on any
    added line (68 earlier warnings in these files are unchanged).
  - **Mutation check.** 11 mutations, each applied alone, run against the
    named test file and restored byte for byte; all caught: the report builder
    returning a schema for `"off"` (schema test; the evidence test cannot see
    it, since `{ guardrail: "off" }` shares the default memo key by design);
    `"guardrail"` removed from `UNAPPLIED_REVIEW_KEYS` (config and evidence
    tests); quotes read without strict (schema test, and the engine replay
    test); an over-cap quote or patch cut instead of dropped; a `STRICT_DROPS`
    entry removed; the memo key ignoring `guardrail`; `evidenceScope` applying
    `guardrail` while unapplied; the negative-line rule removed; the legacy
    schema used without a copy; `MECHANISMS` as a local copy (fixtures test).
  - The full root typecheck was not run: nothing is pushed.
  - Nothing was sent to a model, no paid run, no workflow dispatched, nothing
    published, and no existing user-visible string changed (D14).

- **Review findings, round one** (five findings, none blocking; four fixed
  and one kept as a gate, all before any commit, so the text above already
  describes the fixed code). Every fix is in `schema.ts`'s strict path,
  which no runner reaches; the legacy decoder, `cleanSuggestion`, `FENCED`
  and both schema builders are unchanged, so every digest stays as pinned
  above.
  1. A quote's line no longer pairs with its code after cleaning (`{line: 10,
     code: "\n\tone"}` decoded to line 10 with code that is on line 11).
     Fixed: `cleanCode` returns `{ value, skipped }`, `skipped` counting the
     empty lines stripped from the start, and `decodeQuote` adds it to the
     line. The fence part taken as suggested: a quote whose path is a
     Markdown file (`md`, `mdx`, `markdown`, `mdown`, `mkd`, `mkdn`, `mdc`,
     `qmd`, `rmd`, any case; the Markdown names in `trivial.ts`'s lists) keeps
     its fence as file text, and elsewhere the fence is presentation, so the
     line is the first line inside it. In a Markdown file, a quote the model
     wrapped in a fence of its own now fails S4, where before a quote of a
     real fenced block did; either way it fails closed, as a dropped quote.
     Tested with `"\n\n\tone"` (line and code), CRLF,
     a fence with an empty first line, `a.md.ts` and five Markdown paths.
  2. The negative-line rule checked only a leading minus, so `"L-5"` and
     `"line -5"` read as 5 and 15.4 and 0.6 rounded to 15 and 1. Fixed as
     suggested: only a safe integer of at least 1, or text matching
     `/^\s*L?\d+\s*$/i`; finding lines keep `integer()`. The bad-line loop
     gains `"L-5"`, `"line -5"`, `"line 12"`, `"12.5"`, `"1e3"`, 0.6, 15.4, a
     20-digit string and infinity; 15.4 is now refused, and two cases pin
     that a finding still reads `"line -5"` as 5 and 15.4 as 15. Decision (c)
     records the rule.
  3. `FENCED` backtracks quadratically on a long run of backticks or tildes,
     and the strict path ran it on every quote and patch, with every quote
     entry decoded before the slice. Fixed: `cleanCode` drops a text longer
     than its cap plus 64 characters (`FENCE_ALLOWANCE`) before the regex
     runs, and `decodeFinding` reads only the first `MAX_QUOTES_READ` (24)
     quote entries. The trailing `\n+$` strip, which backtracks the same way
     on a long run of line breaks, became a split with `findIndex` and
     `findLastIndex`. A quote whose fence and padding pass 64 characters is
     now dropped even if its body fits. Measured with a scratch bench
     (removed): a 200,000-backtick quote and patch decode in 0.4 ms; the
     bounded worst case left is 150 ms for one finding of 59,054 characters
     (a patch and 24 quotes of backticks at cap plus 64) and 1,218 ms for
     eight of them (472,236 characters, about a whole model output), linear
     in report size. Tests: the 200,000-character runs (backticks, tildes
     and line breaks, in a code file and in Markdown) are dropped within
     1 second, a fenced quote at its cap still loses its fence, and only the
     first 24 entries are read. Taken in part: the optional `cleanSuggestion`
     pre-check is not applied, because it would change which legacy
     suggestions survive (I-1); it is a deferred item above.
  4. `Quote.path` kept `../` segments and Windows forms. Fixed as suggested:
     `decodeQuote` drops a quote whose path, after `cleanPath` and the
     fallback to the finding's path, matches `/(^|\/)\.\.(\/|$)|\\|^[A-Za-z]:/`.
     Tested with `../etc/passwd`, `a/../../b`, `..`, `src/..`, `/../x.ts`,
     `./../x.ts`, a backslash, two drive forms and a finding path of
     `../x.ts`, while `src/a..b.ts`, `..x/y.ts` and `src/.../z.ts` are kept.
     A path such as `a:b.txt`, legal in git, is dropped too (fail closed).
     The VS-27b containment check stays in the deferred list.
  5. The widened `partial` union removed the compile error that would force
     "Not reviewed" wording. Not narrowed, as the finding allows: narrowing
     `notePartial`'s `reason` was tried and breaks `github.review.ts(917)`
     (@vector-owned) and engine `eval.ts(870)`; `format.ts` was restored byte
     for byte. Decision (g) stays the gate and now names the VS-23b and VS-24
     test items.
  - Re-run after the fixes, each alone through the lock: core
    `test/review/schema.test.ts` (45) and `test/review/model-evidence.test.ts`
    (22, digests unchanged). `bun typecheck` passes in core and engine.
    prettier is clean on `schema.ts` and `schema.test.ts`, and oxlint reports
    no warning in either. No other file changed, so the other suites were not
    re-run.
  - Mutation check of the fixes: six mutations, each applied alone against
    `schema.test.ts` and restored byte for byte (checked by hash), all
    caught: no line shift; the old lenient line rule; no path check; the
    fence always stripped; no raw quote cap; no pre-check.

## 2026-11-07 · VS-27b Strict guardrail strictSelect (pure)

Contract §1.2 (`guardrail.ts`) and §4 VS-27b; addendum A's opening rules, §1,
§1a, §3 VS-27 and §4 windows, and the round-two amendments in the lane brief
(export S4's matcher as a pure function over supplied text; take blob text as
input so I-8 reads stay in the engine; drop an unparseable severity under
strict with its own counted reason). Evidence: REPORT §4.4 item 3 (the
guardrail fails closed), round-two REPORT §2.2 [GP3] (severity defaulting to
its lowest level), Kodus issue #1937 (unreadable verdicts kept by default),
contract C-14 (cross-file fixes). Built at `12950f7c`. Now window only: pure
core code that no runner calls, export keywords, a format branch nothing sets,
and eval-script work. `run.ts`, `ai-review.ts`, `provider.ts`,
`session/llm.ts`, `posting.ts`, `cli/cmd/review.ts`, `prompt.ts`, `config.ts`,
`replay.ts` (`engine:guardrail-strict` stays pending VS-27c) and every @vector
file are untouched. It implements the VS-27b plan as corrected by its
critique; every critique point was taken, two in a form the critique did not
name exactly (points 6 and 7 under "Critique points"). Nothing is committed
(the lane brief).

- **What landed.**
  - **New core `review/guardrail.ts`** (pure, browser-safe, no I/O):
    `MAX_FIX_HUNKS` (3); `StrictIncomplete` (verdict.ts's unfinished causes
    except `strict-incomplete`, then `verdict-unreadable` and
    `blob-unreadable`); `StrictBlob` (`string | null | { absent: true }`) and
    `StrictBlobs` (head and base maps); `StrictInput` (`head`, `anchors`,
    `blobs`, `config: {maxComments, suggestions}`, `trust`, `verifier`,
    `unanswered` (required), `coverage: VerdictCoverage`, optional
    `parses(path, text)`); `strictBlobRequests(findings, anchors)` (the exact
    head and base keys strictSelect reads); `quoteMatches(quote, {head,
    base})` (S4's matcher); `strictSelect(findings, input): StrictResult`;
    and the shared rule pass, `StrictCandidate`, `StrictPass`,
    `strictRules(candidates, {maxComments, unanswered})` and
    `strictIncomplete(coverage, unreadable)`, which report.ts's offline
    re-selection reuses. It imports schema.ts's `ESCAPING_PATH`.
  - **Core `review/diff.ts`**: `FixPatchFailure` and `applyFixPatch(headText,
    patch, {path, maxHunks})`, with private `FIX_PREAMBLE`, `pairedHeader` and
    `wellCounted`. Checks, in order: one non-binary file with a hunk (more
    than one is `several-files`); before the first hunk only git header lines
    (`diff --git`, `index`, paired `---`/`+++`, new or deleted file mode,
    similarity or dissimilarity index, rename and copy lines), every line from
    the first hunk on part of a hunk (trailing blank lines allowed), and each
    hunk filling its header's counts with its new start equal to its old start
    plus the earlier hunks' offset, else `malformed`; bare hunks or headers
    naming `options.path` as a file modified in place, else `other-file`;
    at most `maxHunks` hunks, else `hunks`; `applyPatch` at exact positions,
    else `context`; a change, else `unchanged`. No runner calls it.
  - **Core `review/types.ts`** (still import-free): `ModelFinding` gains
    `severityUnreadable?: boolean`; `STRICT_DROPS` gains
    `severity-unreadable` and checks S2's severity half first: `unverified`,
    `verdict-unreadable`, `severity-unreadable`, `not-blocking`,
    `out-of-scope`, `anchor`, `quote-mismatch`, `no-impact`, `no-fix`,
    `duplicate`, `cap`; comments on both and on `StrictResult.incomplete`.
  - **Core `review/schema.ts`**: under `guardrail: "strict"` only,
    `decodeFinding` marks a severity that names none of `SEVERITIES`
    `severityUnreadable: true` (it still reads `"concern"`); the legacy path
    is byte-identical (the severity is computed once and placed in the same
    key position). `decodeQuote`'s path check became the exported
    `ESCAPING_PATH` (same regex), which guardrail.ts reuses (I-10).
  - **Core `review/verdict.ts`**: `VerdictCoverage` (`VerdictOutcome` without
    `selection`, `trivial` and `strict`), `UnfinishedCause` (the union
    `unfinishedCauses` returns, now named inside `VerdictCause`), and
    `unfinishedCauses` exported, typed over `VerdictCoverage &
    Pick<VerdictOutcome, "strict">`; header and comments updated. Behaviour
    unchanged.
  - **Core `review/select.ts`**: `NEAR`, `MAX_INLINE`, `sameFinding` and `gap`
    exported with comments. Behaviour unchanged.
  - **Core `review/format.ts`**: `SummaryInput.strict?: Pick<StrictResult,
    "complete" | "findings" | "dropped">` after `selection?`;
    `countLine(selection, strict?)` hands a present strict result to a new
    `strictCountLine`. Without it the text is byte-identical.
  - **Core `review/model-evidence.ts`**: `REVIEW_PIPELINE_SOURCES`
    `511f0bffc7b5d314` → `bb8972b4baf9cd62` (`a2d105ab6c0f59f5` before the
    review fixes). No logic change.
  - **`script/vectorscope-eval/report.ts`**: `RESELECT_SUFFIX`
    (`"+reselect-strict"`), `StrictReselection`, `reselectRun(artifact,
    run)`, `loadOutputs({ reselect: "strict" })` (copies, plan entries,
    `reselected` and a `sources.reselect` line), `--reselect strict` in
    `main` and `USAGE`, `group()` refusing a re-selected name; a private
    `postedParts` now shared by `fromArtifact` (same output) and
    `reselectRun`. **README**: the command and an "Offline strict
    re-selection (VS-27b)" paragraph.
  - **Tests**: new core `test/review/guardrail.test.ts` (30) and
    `test/review/fixtures/json-schema.ts` (the structural validator moved out
    of `schema.test.ts`, now counting `maxLength` in code points as JSON
    Schema does); core `diff.test.ts` (+5), `select.test.ts` (+2),
    `format.test.ts` (+5, in a new describe block after "the desktop form
    with line comments", away from `capBody`), `schema.test.ts` (+1, the
    severity cases and the drop order), `verdict.test.ts` (+1),
    `model-evidence.test.ts` (pins); eval `report.test.ts` (+6). The
    review fixes added three guardrail tests and cases to existing ones.
- **Off by default (I-1, I-12).**
  - No new key. `guardrail` stays in `UNAPPLIED_REVIEW_KEYS` and in
    `EVIDENCE_POLICY_KEYS`; no runner imports `guardrail.ts` or
    `applyFixPatch`; `select.ts` and `verdict.ts` gained export keywords and
    types only; the legacy decoder never marks a severity (tested with
    `undefined`, `{}` and `{ guardrail: "off" }`); `buildSummaryBody` without
    `strict` is byte-identical (the goldens, and a `strict: undefined` case);
    `report.ts` without `--reselect` returns no `reselected` and no
    `sources.reselect` (tested), and `fromArtifact` is unchanged (its tests
    pass as before).
  - Digests: `promptsDigest()` stays `5d59e9ee06077c23`, `{ impact: "graph" }`
    `74a2111826c226b1`, `policyDigest(DEFAULT_REVIEW_CONFIG)`
    `70512122f41ec160`. The schema-only strict pins move, because the result
    schema's drop enum follows `STRICT_DROPS` (the VS-27a hand-off d):
    `{ guardrail: "strict" }` `f04c185c5b415aaf` → `b98afb0e878dfe26`, and
    `{ impact: "graph", guardrail: "strict" }` `9c87880d813f1e69` →
    `3ba21b5bc883cd70`. No evidence scope can carry either while the key is
    unapplied.
  - `REVIEW_PIPELINE_FILES` gains `guardrail.ts`; `REVIEW_PIPELINE_REVISION`
    stays 1, because nothing a runner finds or posts changes. The pin comment
    says why `guardrail.ts` is pinned before any runner calls it (it decides
    what a strict review posts, and its rule pass is the one the offline
    re-selection applies) and why `verdict.ts` and `format.ts` stay out
    (completeness decides wording and the verdict, not what is found or
    posted).
  - §0.3 item 4: `engine:guardrail-strict` stays pending VS-27c. Item 5: no
    desktop half in a pure package; desktop artifacts are not re-selected.
- **Decisions.**
  - (a) **Severity.** The round-two amendment drops an unparseable severity
    under strict with its own count: the decoder marks it
    (`severityUnreadable`, strict only) and S2 drops it as
    `severity-unreadable`. S2's severity half is checked before its class
    half (the critique's major point 1): the strict prompt asks for a failure
    block only on blocking findings and `decodeFailure` returns none unless
    class and mechanism both decode, so in the contract's order every
    ordinary concern would read `out-of-scope`. This reorders the contract's
    §1.2 `StrictDrop` list, a lane deviation; the strict digests move in this
    package anyway. **Known mislabel**: a failure block with a valid class and
    an unrecognised mechanism decodes as none and reads `out-of-scope`;
    counting it apart needs a decoder marker and another drop value, left to
    a package that measures how often it happens (tested as is).
  - (b) **Completeness** reuses verdict.ts's `unfinishedCauses` through the
    new export (I-10), so strict completeness and VS-32's verdict read the
    same coverage; `StrictIncomplete` is narrowed to what it can return
    (`UnfinishedCause` without `strict-incomplete`, which this result is).
  - (c) **Blobs fail closed** (critique point 4). A key the engine left out
    reads as null, unreadable; "not in that tree" must be said explicitly as
    `{ absent: true }`; `strictBlobRequests` names every key strictSelect
    reads (tested by recording every map read). `blob-unreadable` is a lane
    code: an unreadable file that leaves a finding without a matching quote
    marks the result incomplete (I-7). An unreadable file another quote makes
    up for, or on a finding an earlier rule dropped, changes nothing. An
    unreadable head file for a patch leaves the fix unchecked and the result
    complete: the finding is kept, so nothing is lost. `unanswered` is
    required (`[]` for none), so leaving it out cannot turn unreadable
    verdicts into plain `unverified` ones, and any id in it that no finding
    in the list confirms marks the result incomplete, whether or not its
    finding was handed in (review fix 1).
  - (d) **S3** refuses a line resolveAnchor snapped onto a nearby hunk (the
    anchor must lie in the model's own `line..endLine`) and a RIGHT anchor
    whose lines are only context: some line must be added or sit next to a
    deletion (`touched` with no radius). A LEFT anchor is on removed code by
    construction (the left map holds only removed lines). `changedSpans`
    stays private for VS-42.
  - (e) **S4** first leaves out whitespace-only lines at the quote's start
    and end, its line moving past those at the start, then compares its n
    remaining lines with the file's lines from that line on, which must lie
    inside the file, with all whitespace removed from every line on both
    sides (as `patchIdOf` compares lines) and blank lines dropped, so CRLF,
    indentation and spacing on one side only never matter (review fixes 2
    and 3). A quote with no letter or digit (`}`, `);`) matches nothing
    (review fix 4). A RIGHT quote reads head, a LEFT quote base; a diff path
    reads its own path at head and a renamed file's old path at base; a
    path outside the diff is read as written (a cross-file quote counts),
    and a path `ESCAPING_PATH` matches is read as a file the tree lacks,
    without a map read (review fix 5). Kept quotes are the matching ones,
    each with the path it was read at.
  - (f) **Patches** apply at exact positions, with no offset or fuzz; model
    headers never choose the file (I-8); each hunk must fill its header's
    counts and its new start must follow from its old start (critique point
    3), so text labelled `patch` is one `git apply` reads as checked. A patch
    naming another file is kept as an unchecked fix (C-14). **Known limit**:
    a hunk whose last line is an empty context line the decoder's
    `cleanCode` stripped is under-filled, so `malformed`, so unchecked (fail
    closed); a mode change is malformed. Checking a cross-file patch against
    the other file waits for VS-27c, once the engine reads that blob.
  - (g) **The parse check** rejects a patch only when `parses(path, head)` is
    true and `parses(path, patched)` is false; head is parsed once per path.
    A language that is not parseable (undefined) or a head that already fails
    is not checked. A callback that throws on either text leaves that one
    patch unchecked; the rest of the selection, and completeness, are as
    they were (review fix 6).
  - (h) **Strength order**: a runtime confirmation, then confidence, then
    path, line, id, title and the finding's JSON, a total order, so the
    result never depends on input order (critique point 11; tested on
    reversed and rotated inputs). S7 compares a candidate only with findings
    already kept, so a stronger finding a later rule dropped never hides a
    weaker one. **Known difference**: a same-id finding far away is dropped
    as a duplicate without the `also` location `selectFindings` folds in;
    VS-27c composes the two.
  - (i) `NEAR`, `MAX_INLINE` and `gap` are exported beside `sameFinding`, a
    small widening of the contract's "export sameFinding", so S7's three
    lines and S8's clamp measure as selection does.
  - (j) **Wording** (critique point 9), only when a strict result is
    present, keyed on the strict result alone: empty and complete with no
    `cap` drop is "**No verified production-breaking issues** on the changed
    lines."; empty and complete with a `cap` drop is "**No findings posted**
    on the changed lines: the comment limit left out N verified findings."
    (`maxComments: 0` is complete, so it does not read as incomplete);
    empty and incomplete is "**Review incomplete**: a stage did not finish,
    coverage is partial or a verdict could not be read." It never says clean
    and does not reuse VS-34's `held-back`. The ` · N nits below` suffix
    replaces the final full stop, as on the legacy line. A non-empty result
    is counted from the selection, or as N blocking when the selection has
    nothing on lines. New strings under the key only (D14, as VS-27a). The
    "**No findings posted**" line is a third empty-result wording beyond the
    contract's two; it is **not decided here** and waits for the owner's
    sign-off before VS-27c wires it (Owner questions below).
  - (k) **Offline re-selection** (contract VS-27c's measurable goal, built
    here as eval work; the contract's literal rule set is "S1 and S3–S8").
    It keeps S2's blocking half, because severity is readable in legacy
    output, so the re-selected set is what strict would post. It leaves out
    S2's class half and S5 (no failure block) and S4's quotes. S3 and S4 are
    the recorded anchors (inline, overflow, elsewhere and nits anchored,
    outside-diff not); a context-line anchor passes offline, a stated limit.
    S6 comes from the recorded `suggestionAllowed`, so an overflow suggestion
    reads unchecked. S7 is by id or `sameFinding` with no anchored code and no
    class clause; S8 at the artifact's `maxComments` (config keys the artifact
    lacks read as `DEFAULT_REVIEW_CONFIG`). Only what the original posted is
    a candidate (critique point 7): inline when the review write went out,
    the rest when the summary did, none when every reviewer failed, so every
    re-selected finding carries the original's judgement; the rest are
    counted as `unposted`. A refused artifact is not emptied wholesale (the
    plan's rule): its writes already show what got through. Unreadable
    verdicts (critique point 5) are worked out from the recorded verify rule,
    plan.ts's `verifyCandidates` and `verifyUnanswered` over the selection
    with its verified findings as the confirmed verdicts and its findings
    recorded as `verified: false` as rejected ones (a recorded false is a
    verdict that was read; review fix 7), when a verify pass ran; that is
    exact for a run whose verify pass finished. Completeness reads the rule
    pass's own `unreadable`, as strictSelect does, so both paths agree. A triage pass
    leaves unconfirmed findings out of the artifact, so a nonzero
    `unconfirmed` drop marks the run incomplete as `verdicts-unrecorded`, a
    re-selection-only code. A copy keeps the original's status, detail,
    stop, proposed findings and violations, and carries no spend, tokens,
    attempts or timing (critique point 13): it is admitted and costs $0, so
    the unaccounted count sees the original once (tested with an unadmitted
    paid artifact); the group's tokens line counts copies as having reported
    none. The gate never decides on or compares with a copy (critique point
    6): `--candidate` and `--baseline` both refuse a `+reselect-strict` name,
    with or without `--reselect`. The critique asked to keep `--baseline`
    usable; the flag stays usable for every real group, but a re-selection
    as the baseline would hand the candidate's recall criterion a
    lower-recall comparison it did not earn, so it is refused too; the two
    groups sit side by side in the group tables. With `--reselect` and no
    `--candidate` there are two groups, so the gate is not evaluated (tested).
    Judgements are copied from the original run key to the copy's; no judge
    call is duplicated.
  - (l) A runtime confirmation's `verifier` is `"runtime"` until VS-30 widens
    the input; `verifiedBy` defaults to `"model"`.
  - (m) A fix's text is the suggestion when the existing rules make it
    committable (`suggestionAllowed` with `verified: true`, since S1 kept
    only verified findings, so an untrusted verified suggestion stays a
    suggestion), else the patch when it applies, else `patch ?? suggestion`
    unchecked. A fix that is empty or over `MAX_SUGGESTION_CHARS` is no fix,
    so the result always validates against `strictResultJsonSchema`.
- **Critique points** (all taken).
  1. S2 precedence: (a); tests for a concern without a failure block and
     `"critical"` without one, through the strict decoder too.
  2. S6 untrusted: an untrusted verified finding keeps its suggestion; the
     unchecked cases are suggestions off, LEFT, a moved range and repeated
     neighbours.
  3. Recount and new start: (f); tests for an under-filled hunk, a wrong new
     start and an offset second hunk.
  4. Fail-open defaults: (c), both forms combined (a request helper and an
     explicit absent value).
  5. Offline unreadable verdicts: (k), with tests.
  6. The gate: (k), refused in both flags (the reason is in (k)).
  7. Posted sets: (k), with blocked-summary and blocked-review tests.
  8. Preamble: git extended header lines reach `other-file`; mode changes,
     a lone `---`, `diff --vector` and prose are `malformed`; the `/dev/null`
     and mode-line forms are both tested.
  9. Wording: (j).
  10. The validator moved to `test/review/fixtures/json-schema.ts`.
  11. The impact test passes an outcome-like object with Tier 1 and impact
      incompleteness as `coverage` and keeps `complete` true, with a
      `@ts-expect-error` that `VerdictCoverage` has no impact field; the
      total tiebreak is (h); the property test also asserts that every drop
      reason, every fix kind and an incomplete result occur over its 400
      seeds, so it cannot pass by keeping nothing.
  12. Only the shared rule pass is in `guardrail.ts`; the record adapter
      (`reselectRun`, `StrictReselection`) is in `report.ts`; the pin comment
      says the rule pass is pinned on purpose.
  13. Spend: (k).
  14. Merge prediction covers `format.test.ts` and every other touched file
      (below).
  15. (a) S7 measures with select.ts's `gap`; (b) `StrictIncomplete`
      narrowed; (c) the verdict.ts header updated; (d) the `also` difference
      is in (h).
  16. Hand-offs: added below.
  17. prettier and oxlint ran through the lock. The first prettier run was
      from the worktree root on five core files, later runs from the package
      directories. prettier reformatted lines this package did not touch in
      `select.test.ts`, which was not prettier-clean at HEAD, so that file
      was restored and only the new block re-added, checked clean on its own.
- **Hand-offs to VS-27c.**
  - Call strictSelect after placement in `Review.run`, with `coverage` from
    the outcome and `unanswered` from plan.ts's `verifyUnanswered` (I-10),
    not a new computation. Pass every unanswered id, even for findings the
    composition with `selectFindings` leaves out: strictSelect reads such an
    id as an unread verdict (I-7).
  - strictSelect ignores `minConfidence` and the posting cap per PR; decide
    how it composes with `selectFindings` (which runs first, which ids and
    `also` places survive).
  - `INJECTION_TITLE` warnings are dropped under strict (out of scope or not
    blocking), so VS-27c must still surface them.
  - Read the blobs `strictBlobRequests` names through the head and base
    tree-ish, with the symlink containment test, and pass `{ absent: true }`
    for a path the tree lacks.
  - The parse callback: pre-compute with `applyFixPatch` and the engine
    parser (VS-25a); the desktop has no parse check until VS-10. It should
    return undefined on a time limit or grammar failure rather than throw; a
    throw is caught and leaves that patch unchecked.
  - Owner sign-off before wiring: the third empty-result wording ("**No
    findings posted** ... the comment limit left out N verified findings",
    decision (j)) and the reordered `STRICT_DROPS` (decision (a)). If the
    owner keeps the contract's two wordings only, the cap-emptied case
    becomes incomplete with a `cap` reason and reuses "Review incomplete".
  - Render an unchecked fix (model text: a patch or a suggestion) through
    `sanitizeModelMarkdown` and `fenceFor`'s escaping, as a plain diff block
    (I-2).
  - VS-42 needs `quoteMatches` positionally: map a head line to base with
    `mapLine` first, then pass a LEFT quote (the doc comment says so).
  - Artifacts record the candidates and blobs seen before the guardrail, so
    a later re-selection can run the full rule set; the CLI `--json` outcome;
    the variant flip.
- **Owner questions, kept neutral.** Q3 and Q4: class names only, no
  definitions. Q17: an unchecked fix is kept and marked (`fix.kind`,
  `fixUnchecked`), so a later posting filter can serve either answer. Q13 and
  Q15: nothing is wired. Q18 to Q34: no addendum package is built here.
  **For the owner's sign-off with Q13 and Q17** (new, not decided by this
  lane):
  - The wording "**No findings posted** on the changed lines: the comment
    limit left out N verified findings." is a third empty-result string the
    contract does not list (D14). It exists so a `maxComments: 0` or capped
    run never claims "No verified production-breaking issues". Nothing sets
    `strict` before VS-27c, so nothing shows it.
  - `STRICT_DROPS` order differs from contract §1.2's `StrictDrop` list:
    `severity-unreadable` was added (the round-two amendment), and
    `not-blocking` now comes before `out-of-scope` (decision (a)). The
    contract text was not edited; VS-27c, VS-42 and VS-44 should build on
    the order in `types.ts`, or the owner restores the contract's order
    (the strict-only digests move either way; no evidence scope carries
    them while the key is unapplied).
  - S4's "apart from whitespace" is read as git's `-w`: whitespace present
    on one side only is ignored too (review fix 3). The stricter reading
    (inner runs as one space) is a one-line change if the owner prefers it.
- **Predicted merge conflicts** (read-only: `git merge-tree --write-tree
  --name-only` at HEAD, then a three-way `git merge-file` of each touched file
  either branch changes, the working tree against each branch's merge base
  and tip).
  - Of the touched files, only `format.ts`, `types.ts` and `format.test.ts`
    change on `origin/codium` (`5a079cbd`) or `origin/self-evolving`
    (`f062bcce`).
  - `format.ts` and `format.test.ts`: no conflict with either, as at HEAD.
  - `types.ts`: 2 conflict hunks with codium and 1 with self-evolving, the
    same VS-27a hunks as at HEAD (the pass-name lines); none holds a VS-27b
    line.
- **Deferred.**
  - VS-42: S9, `preExistingSuspect`, the `pre-existing` drop, the
    `changedSpans` export and the `scope` field.
  - VS-44: `certified()`, the certificate schema, the `certificate-mismatch`
    and `verdict-unsure` drops.
  - VS-43: `ruleCited` and `linkedRule`. VS-47: `checked[]`.
  - The evidence-attachment fields (VS-44, VS-30).
  - The addendum §3 Greptile fields: `clarificationQuestion`,
    `securityIssue`, before and after snippets, per-file notes.
  - Counting a failure block with an unrecognised mechanism apart from
    `out-of-scope` (a).
  - Desktop artifact re-selection; offset- or fuzz-tolerant patch
    application; checking a cross-file patch against its own file.
- **Deferred verification.**
  - No saved replay artifacts exist (I-13), so the precision change is
    unmeasured until settled artifacts exist.
  - The parse check runs only against a fake callback.
  - The merge conflicts are only predicted.
  - No provider sees anything; nothing reaches a runner.
- **Evidence.** Each file alone through the lock, `--timeout 30000`, from its
  package directory; counts at HEAD → with VS-27b.

  | File | HEAD | VS-27b |
  |---|---|---|
  | core `test/review/guardrail.test.ts` | | 30 (27 before the review fixes) |
  | core `test/review/diff.test.ts` | 45 | 50 |
  | core `test/review/select.test.ts` | 43 | 45 |
  | core `test/review/format.test.ts` | 46 | 51 |
  | core `test/review/schema.test.ts` | 45 | 46 |
  | core `test/review/verdict.test.ts` | 44 | 45 |
  | core `test/review/model-evidence.test.ts` | 22 | 22 |
  | core `test/review/config.test.ts` | 49 | 49 |
  | engine `test/review/run.test.ts` | 44 | 44 |
  | engine `test/review/eval.test.ts` | 29 | 29 |
  | engine `test/cli/github.review.test.ts` | 40 | 40 |
  | app `ai-review.test.ts` (`--preload ./happydom.ts`) | 107 | 107 |
  | eval `report.test.ts` (from `script/vectorscope-eval`) | 27 | 33 |
  | eval `replay.test.ts` (from `script/vectorscope-eval`) | 32 | 32 |

  - `bun typecheck` passes in core and engine; app and desktop pass `bun
    typecheck --force`; the eval scripts pass `bun tsgo -p
    ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`.
  - prettier is clean on every changed source and test file and on the eval
    README. `select.test.ts` and this log were not prettier-clean at HEAD, so
    in `select.test.ts` only the new block was checked (clean), and this entry
    keeps the earlier entries' layout. oxlint reports no warning on any added
    or changed line; 53 warnings remain in these files, all on lines this
    package did not touch.
  - **Mutation check.** 29 mutations, each applied alone, run against the
    named test file and restored byte for byte (checked by hash); all caught.
    guardrail.ts: S1 keeping an unanswered finding; `severityUnreadable`
    ignored; S2's class half before its severity half; S3 accepting snapped
    anchors; S3 accepting context anchors (radius 5); `quoteMatches` ignoring
    the side; S4's span not exact; S5's bound off by one; S5 counting UTF-16
    units; `MAX_FIX_HUNKS` 4; the parse check inverted; S7's class clause
    removed; S8's clamp removed; `unanswered` ignored in completeness; a
    missing blob key read as absent; strength order ignoring a runtime
    confirmation. diff.ts: `applyFixPatch` ignoring the header path, ignoring
    leftover lines, skipping the recount, taking a lone `---` header.
    format.ts: the wordings swapped; the cap wording dropped. schema.ts: the
    legacy decoder marking a severity. report.ts: the copy reusing the
    original run key; unposted findings as candidates; the copy keeping the
    spend; `unanswered` ignored; `verdicts-unrecorded` dropped; `group()`
    taking a re-selected name. After the review fixes, 14 more, the same
    way, all caught: completeness ignoring an unanswered id outside the
    list; S4 keeping whitespace-only edge lines; leading ones not moving the
    line; the span not bounded by the file; a punctuation-only quote
    matching; one-sided whitespace counting; `strictBlobRequests` keeping
    escaping paths, and asking for a patch head outside the diff;
    strictSelect reading an escaping path; a parse throw propagating; a
    throw on head, and on the patched file, passing the patch; report.ts
    reading `verified: false` as unread, and ignoring `unanswered`.
  - The full root typecheck was not run: nothing is pushed.
  - Nothing was sent to a model, no paid run, no workflow dispatched, nothing
    published, and no existing user-visible string changed (D14).
- **Review findings, round one** (twelve findings, two blocking, the two
  blocking ones the same defect; one non-blocking pair, the wording,
  overlaps too). All were
  taken or flagged; none is declined. Fixed before any commit, so the text
  above already describes the fixed code. Everything stays strict-only or
  eval-only: no runner imports `guardrail.ts`; `ESCAPING_PATH` is the same
  regex `decodeQuote` ran inline, so the legacy and strict decoders are
  byte-identical and every digest except `REVIEW_PIPELINE_SOURCES` stays as
  pinned above.
  1. (Blocking, twice.) Completeness counted an unread verdict only when the
     unanswered id's finding was in `findings`, so `strictSelect([],
     {unanswered: ["ghost"]})` read complete and worded "No verified
     production-breaking issues" (I-7). Fixed in the shared rule pass, so
     strictSelect and the offline re-selection agree: `strictRules`'
     `unreadable.verdict` also holds when an unanswered id has no candidate
     that confirms it. report.ts now reads `pass.unreadable` instead of its
     own `unanswered.length > 0` (the same value there). Tests: `[]` and a
     list with another verified finding, both `["verdict-unreadable"]`, the
     body worded "Review incomplete", and a confirmed finding still winning
     over the list.
  2. A quote ending in `\n` or a whitespace-only line never matched (its
     span counted a line `normalizeCode` drops). Fixed as suggested:
     whitespace-only lines at both ends are left out, the line moving past
     those at the start. Tests: trailing `\n`, `\n  `, `\n  \n\t`, a
     leading whitespace line, and a leading one that moves the quote onto
     the wrong line.
  3. "Apart from whitespace" read stricter than the contract (`if(a){`
     failed against `if (a) {`). Fixed: all whitespace removed per line, as
     `patchIdOf` does; the test that pinned the stricter reading now pins
     the match. Listed for the owner (Owner questions).
  4. A punctuation-only quote (`}`, `);`) matched almost anywhere. Fixed: a
     quote needs a letter or digit (Unicode `\p{L}\p{N}`, a superset of
     `diff.ts`'s ASCII test, so a quote of non-ASCII identifiers still
     counts). VS-42 and VS-44 inherit the rule through `quoteMatches`.
  5. `strictBlobRequests` asked for a patch's head outside the diff and
     passed model paths unchecked. Fixed: a patch head only for a diff file
     (S3 drops any other first), and no key `ESCAPING_PATH` matches, now
     exported from `schema.ts` and reused by `decodeQuote` (I-10).
     strictSelect reads such a path as `{ absent: true }` without touching
     the map, as the decoder drops such a quote: a plain mismatch, never
     incomplete. Containment against the tree-ish stays the engine's (I-8).
  6. A throwing `parses` failed the whole selection. Fixed: a throw on head
     or on the patched text leaves that patch unchecked; the doc comment and
     the hand-off say the callback should return, not throw. Test: both
     throw sites, with a second finding's suggestion kept as before.
  7. Offline S1 read a `verified: false` finding as unanswered. Fixed: a
     recorded false is a rejected verdict in the map `verifyUnanswered`
     reads; README and comment updated. Test: a rejected-but-kept finding
     drops as `unverified` and the run stays complete.
  8. `strictRules`' `for` loop pushing into two arrays. Rewritten as
     `toSorted(stronger).reduce(...)` returning `{ accepted, drops }`; S7
     reads the accepted list so far from the accumulator.
  9. The third empty-result wording ("No findings posted ..."). Kept, as
     both findings allow, and flagged for the owner's sign-off with Q13 and
     Q17 (decision (j), Owner questions, Hand-offs). The alternative (a
     `cap` incompleteness reusing "Review incomplete") is named there.
  10. The `STRICT_DROPS` reorder. No code change; flagged for the owner and
      VS-27c, VS-42 and VS-44 (Owner questions). The contract's §1.2 list is
      not edited by this lane.
  - Re-run after the fixes, each file alone through the lock with
    `--timeout 30000` from its package directory: core `guardrail.test.ts`
    30, `schema.test.ts` 46, `select.test.ts` 45, `format.test.ts` 51,
    `diff.test.ts` 50, `verdict.test.ts` 45, `model-evidence.test.ts` 22;
    eval `report.test.ts` 33 (from `script/vectorscope-eval`). `bun
    typecheck` passes in core and engine, and the eval scripts pass `bun
    tsgo -p ../../script/vectorscope-eval/tsconfig.json` from
    `packages/engine`. prettier is clean on every file changed in this
    round; oxlint reports no warning on a changed line. Neither
    `origin/codium` nor `origin/self-evolving` touches a file this round
    changed beyond those listed under the predicted conflicts.

## 2026-11-07 · VS-42a Introduced-by-change check (pure)

Addendum A §2 VS-42 (its Now part only), with the §1 `scopeGate` row, §1a's
VS-42 row, §3 VS-27 ("S9 joins only after its gate"; the `scope` field enters
the strict schema only under the key) and §4's windows. Evidence: round-two
REPORT [G6-13] (ReviewBench labels 173 of 2,623 true positives `pre-existing`
and 59 `exacerbated-by-pr`, and still counts them as true) and [CF10] (a
rubric that forbids flagging pre-existing bugs); `judging-rubric.md:39`
(unchanged) scores "not a defect in this change" as a false alarm. Built at
`d268025c`. Now window only: pure core code that no runner calls, an
off-by-default key that config.ts parses and no runner reads, and eval-script
work. `run.ts`, `ai-review.ts`, `provider.ts`, `session/llm.ts`, `posting.ts`,
`prompt.ts`, `cli/cmd/review.ts`, `diff.ts`, `select.ts`, `format.ts`,
`verdict.ts`, `replay.ts` and every @vector file are untouched. It implements
the VS-42a plan as corrected by its critique. Every critique point was
taken; for point 5 the critique's named alternative was taken, with the reason
given in (h). Nothing is committed (the lane brief).

- **What landed.**
  - **Core `review/types.ts`** (still import-free):
    - `FINDING_SCOPES` (`introduced`, `exacerbated`, `pre-existing`) and
      `FindingScope`, after `VERIFIED_BY`, with their mapping onto
      ReviewBench's scope axis;
    - `ModelFinding.scope?: FindingScope`, a type only: no decoder sets it;
    - `STRICT_DROPS` gains `pre-existing` between `no-impact` and `no-fix`.
      The comment says S9 is checked after S5 and before S6, is produced
      only under `guardrail: "strict"` with `scopeGate: "introduced"`, and
      joins the result schema only under that key;
    - `ReviewConfig.scopeGate?: "off" | "introduced"` after `guardrail`;
    - `OPTIONAL_REVIEW_DEFAULTS.scopeGate: "off"`, and `scopeGate` in
      `UNAPPLIED_REVIEW_KEYS` after `guardrail`.
  - **Core `review/config.ts`**:
    - `FIELDS.scopeGate = oneOf(["off", "introduced"])`, with no `ENV`
      entry;
    - `UNAPPLIED.scopeGate`, which applies only to `"introduced"` under
      `guardrail: "strict"`: `"scopeGate": "introduced" is not applied yet:
      defects that already existed at the base are not dropped.`;
    - in `settle`, after the triageModel rule and before the not-applied
      warnings, a permanent note for `"introduced"` without strict:
      `"scopeGate": "introduced" is ignored without "guardrail": "strict":
      the introduced-by-change check runs only inside the strict
      guardrail.` The value is not mutated, and the two warnings never
      appear together.
  - **Core `review/trivial.ts`**: `otherSide(file, from)` is exported, with
    one comment line saying guardrail.ts's S9 reuses it (I-10). Its
    behaviour is unchanged.
  - **Core `review/guardrail.ts`**:
    - the header lists S9 between S5 and S6 and says it relies on the quotes
      alone (decision (n));
    - `scopeGateApplies(config)`;
    - `preExistingSuspect(finding, head, base, files)`, the addendum's
      signature;
    - `StrictInput.config` widens to `Pick<ReviewConfig, "maxComments" |
      "suggestions" | "guardrail" | "scopeGate">`, the last two optional;
    - `strictBlobRequests(findings, anchors, config)`, whose config is now
      required. Under the gate it names each head quote's base key, except
      for files the change added or deleted. Without the gate its output is
      identical;
    - `StrictCandidate.preExisting?: () => boolean`, read by the rule pass
      after S5. `strictSelect` sets it only under the gate;
    - `judge`'s S9 line, `if (candidate.preExisting?.() === true) return {
      drop: "pre-existing" }`, sits between `no-impact` and the fix;
    - private `suspect`, `addedIn`, `unchangedSinceBase` and `textOf` (a
      blob's text, null for an escaping path, as strictSelect reads it), and
      `trimQuote`, S4's trimming rule, which `matchAt` now calls. The
      comparison stays in `matchAt`; behaviour is unchanged, and every
      existing `quoteMatches` and S4 test passes unchanged;
    - `onChangedLine` takes `Pick<Finding, "line" | "endLine">`, a type-only
      change;
    - comment fixes: the `StrictBlob` comment is qualified (decision (i)),
      the `StrictInput.config` and `strictBlobRequests` comments say VS-27c
      passes the whole ReviewConfig to both, and the `quoteMatches` comment
      now says to map a head line to base with `trivial.ts otherSide`, not
      `diff.ts mapLine` (mapLine maps base to head).
  - **Core `review/schema.ts`**:
    - `StrictSchemaKeys` is `Partial<Pick<ReviewConfig, "guardrail" |
      "scopeGate">>`;
    - the result schema's drop enum is `STRICT_DROPS` without
      `pre-existing`, unless `scopeGate` is `"introduced"`. The builders
      already return undefined without strict;
    - `strictReportJsonSchema` and `decodeReport` are unchanged. Their
      comments say the `scope` field waits for VS-42 wiring.
  - **Core `review/model-evidence.ts`**:
    - `EVIDENCE_POLICY_KEYS` gains `scopeGate` after `guardrail`;
    - `promptsDigest`'s keys widen to include `scopeGate`, and its memo key
      gains `scopeGate:introduced` only under strict. A local was renamed
      from `strict` to `schemas`, since `strict` is now the boolean;
    - `evidenceScope` passes `scopeGate: "introduced"` only when both keys
      are set and neither is in `UNAPPLIED_REVIEW_KEYS`;
    - `REVIEW_PIPELINE_SOURCES` moves from `bb8972b4baf9cd62` to
      `8e2a3d79e36f8607`, because `guardrail.ts` and `trivial.ts` changed.
      `REVIEW_PIPELINE_REVISION` stays 1.
  - **Engine `review/eval.ts`** (the eval replay, not a runner):
    `WIRING.scopeGate = "VS-42 wiring"`, and the `ReplayInput.config`
    comment names VS-42's scopeGate. The `UNAPPLIED` drop in the replay and
    step 0b's refusal are generic.
  - **`script/vectorscope-eval/report.ts`**: the `--reselect strict`
    sources line and header comment list S9 as left out ("no base blobs are
    recorded"). The README's re-selection paragraph says the same.
  - **Tests**:
    - core `guardrail.test.ts`, 30 → 44: an S9 describe block with 12
      tests, a gated `strictBlobRequests` test, and an agreement test. The
      property test gains a gate dimension; its draws are taken last, so the
      ungated cases are the same as at HEAD. Under the gate, `satisfies`
      also checks S9 and the result is validated against the schema built
      for its keys;
    - core `schema.test.ts`, 46 → 47;
    - core `config.test.ts`, 49 → 53;
    - core `model-evidence.test.ts`, 22 → 24;
    - engine `eval.test.ts`, 29 → 30 (the replay test, and two refusals
      added to the existing refusal test);
    - eval `report.test.ts`: the sources-line expectation changed on
      purpose, with the count unchanged at 33;
    - four existing `strictBlobRequests` calls now pass `{}`, a mechanical
      change of signature; no assertion changed.
- **Off by default (I-1, I-12).**
  - **Key.**
    - `scopeGate` is optional, absent from `DEFAULT_REVIEW_CONFIG` and in
      `UNAPPLIED_REVIEW_KEYS`, and no environment variable reads it;
    - the parser warns that it is not applied with strict, and that it is
      ignored without strict;
    - the replay drops it from the base `review.json` and refuses it in
      `ReplayInput.config` (both tested);
    - strictSelect runs S9 only under both keys;
    - no decoder sets `scope`.
  - **Parity.**
    - No runner imports `guardrail.ts`.
    - The runner suites pass with unchanged counts: engine `run.test.ts` 44,
      `cli/github.review.test.ts` 40, and app `ai-review.test.ts` 107.
    - Every existing guardrail, schema and report test passes unchanged,
      except the deliberate `STRICT_DROPS` list, the enum assertion, the
      sources line and the `strictBlobRequests` call signature.
  - **Digests** (printed before and after):
    - held: `promptsDigest()` `5d59e9ee06077c23`, `{ impact: "graph" }`
      `74a2111826c226b1`, `{ guardrail: "strict" }` `b98afb0e878dfe26`,
      `{ impact: "graph", guardrail: "strict" }` `3ba21b5bc883cd70`;
    - `{ scopeGate: "introduced" }` alone and `{ guardrail: "strict",
      scopeGate: "off" }` give the digests above;
    - new, schema-only and pinned: `{ guardrail: "strict", scopeGate:
      "introduced" }` `4aa712221043a3a7`, and with `impact: "graph"`
      `8335adf9de513ee5`. VS-42 wiring moves them on purpose;
    - `policyDigest(DEFAULT_REVIEW_CONFIG)` stays `70512122f41ec160`, with
      `scopeGate` set or not, with or without strict;
    - no evidence scope can carry the new digests while either key is
      unapplied.
  - **§0.3 item 4.** `engine:scope-introduced` is deferred to VS-42 wiring,
    as VS-34a deferred its variant: no registry, README or `replay.test.ts`
    change.
  - **§0.3 item 5.** A documented difference: S9 is pure core and reaches
    the desktop with VS-27's desktop guardrail; until then the desktop half
    records `variant.applied: false`.
- **Decisions.**
  - (a) **The key is parsed now.**
    - Allowances: the lane brief allows "ReviewConfig type and config
      parsing additions that are off by default"; VS-42's own tests ask that
      "the key set without `guardrail: strict` has no effect, and emits the
      note"; and §1 says "a test asserts that". VS-27a's `guardrail` is the
      precedent.
    - §4 lists "config parse" in the runner-wiring window for VS-35 and
      VS-43, but not for VS-42, whose Now entry is "`preExistingSuspect` and
      the strict drop". So parsing it now is a deliberate reading, not an
      oversight.
    - It is a plain key with no environment variable (§1's Env column says
      "none").
    - The ignored note is permanent: it survives wiring and excludes the
      not-applied warning. The value is not mutated, so the replay and
      `policyDigest` see what was written.
  - (b) **One gate predicate.** `scopeGateApplies` gates `strictSelect` and
    `strictBlobRequests`. The schema enum and `promptsDigest` apply the same
    two-key rule inline: schema.ts cannot import guardrail.ts, which imports
    it, and model-evidence.ts keeps its prompt keys inline beside the
    others.
  - (c) **S9 after S5 and before S6.** This is critique point 3, taken; the
    plan had put S9 after S6. The addendum names no position.
    - S5, S9 and S6 each filter one candidate at a time, so the kept set is
      the same wherever S9 sits between S5 and S7. The kill criterion,
      measured as the difference in kept sets with the gate on and off, does
      not depend on the position.
    - Before S6, a suspect never has its patch applied or parsed, which can
      be the slowest check (tested with a parse spy).
    - Before S7, a dropped suspect never hides an introduced duplicate, and
      is never counted as a duplicate itself (tested both ways).
    - The cost of this order: a suspect with no fix counts as
      `pre-existing`, not `no-fix`.
  - (d) **Only matched quotes count (I-2).** An unmatched quote on a changed
    line never saves a finding, and an unmatched base quote never exempts
    one (both tested).
  - (e) **Deletion defects are exempt**, following S3's anchor kinds:
    - a LEFT anchor;
    - a RIGHT anchor whose range holds no added line, which S3 accepts only
      because it sits next to a deletion;
    - a finding with a matched LEFT quote, since that is removed code.

    A modified line counts as added. The model's `pre-existing` label still
    drops an exempt finding (I-2: labels only drop).
  - (f) **`touched` with radius 0** stands in for exporting `changedSpans`
    (the addendum's named alternative), and it gives the same ranges. So
    `diff.ts` is untouched.
  - (g) **"Unchanged in the base after `normalizeCode`"** is read
    positionally:
    - The trimmed quote's first line maps to base through `otherSide(file,
      "RIGHT")`; the line is the same for a file outside the diff. The base
      is read at `blobKey(..., "LEFT")`, the old path for a rename.
    - The comparison is `quoteMatches` itself, called with a LEFT quote at
      that line (critique point 4, taken). S4 inside `strictSelect` still
      uses the cached-lines `matchAt`, which is `quoteMatches`'s body. The
      shared trimming moved into `trimQuote` rather than splitting
      `matchAt`.
    - S4's form drops all whitespace (VS-27b's `git -w` reading), so it is
      a little more forgiving than `normalizeCode`, which collapses inner
      runs to one space. S9 may therefore call a quote unchanged that
      `normalizeCode` would call changed, such as one whose string literal
      differs only in inner spacing. The owner's answer to VS-27b's
      whitespace question applies to both.
    - Cost: `quoteMatches` splits the base file on each call. That is
      bounded, because S9 runs only under the gate, only on candidates that
      passed S1 to S5, and only on untouched head quotes.
  - (h) **`otherSide` stays in `trivial.ts`** (critique point 5's named
    alternative, taken).
    - Its bisection helper `lastAtOrBelow` is shared with trivial.ts's
      `stringCover`. A move into `diff.ts` beside `mapLine` would either
      duplicate the search or make `diff.ts` export a generic helper back to
      `trivial.ts`.
    - Either way, two pinned functions would be rewritten with no change in
      behaviour, and `diff.ts`, which no branch in the merge prediction
      touches, would move.
    - It is still a single mapper (I-10). Moving it beside `mapLine` is a
      clean-up for a package that has to touch `diff.ts` anyway.
  - (i) **An unreadable base never demotes a finding.** A base that is
    null, `{ absent: true }` or missing from the map, or a head line the
    change added, never makes a finding a suspect. It never marks the result
    incomplete either: S9 only ever drops, so a finding it cannot check is
    kept and nothing is lost (I-7 holds). The `StrictBlob` comment now says
    S9's base reads are the exception to "a read the engine forgot fails
    closed".
  - (j) **`ModelFinding.scope` is typed now and decoded by nothing.** So the
    model half of S9 is reachable only from callers that build findings
    themselves (tests and eval scripts). The alternative, leaving out the
    label branch until the decoder exists, would make the wiring add both
    halves at once; the label branch is one tested line.
  - (k) **The result schema's enum is keyed on `scopeGate`.** The report
    schema and the decoder are unchanged under the key (tested), and the
    `scope` field joins with VS-42 wiring. This follows VS-27a decision (b).
  - (l) **Fail-open at the wiring boundary** (critique major point 2, option
    (a)).
    - The `strictBlobRequests` config is a required parameter. TypeScript
      cannot also require the two keys inside it, because they are optional
      in `ReviewConfig`.
    - Both doc comments say VS-27c passes the review's whole ReviewConfig to
      both calls.
    - A gated test records every map read and checks that each base S9 reads
      is named only under the gate.
    - Base keys are skipped for added and deleted files: `touched` holds on
      every line of them, so they are never suspects (critique point 10).
  - (m) **`StrictCandidate.preExisting`** (true drops the finding) replaces
    the plan's `introduced?: boolean`, whose name claimed more than it
    meant: it was true for exacerbated and unlabelled findings (critique
    point 10). It is lazy, as `fix` is, because it may read base files.
    report.ts's `reselectRun` does not set it, so its output is
    byte-identical.
  - (n) **S9's main false-drop class, accepted by design** (critique major
    point 1).
    - S9 relies on the quotes alone; the anchor's added line is not
      evidence.
    - So a finding anchored on an added line whose matched quotes are all
      unchanged code is dropped as `pre-existing` even when the defect is
      introduced. The unchanged code may be context in the same file, or an
      unchanged file outside the diff. Examples: a new `store.flush()` that
      misuses the old `store.reset()`, or a new call site broken by an
      unchanged callee in `store.ts`.
    - This fits the addendum's literal rule: every RIGHT quote unchanged,
      and none touching a change.
    - The fixture is named for it ("a finding on an added line that quotes
      only unchanged code is a suspect, even when the new line is the
      defect"), and the header comment says so.
    - Introduced findings are 2,391 of ReviewBench's 2,623 true positives
      (91.2%, [G6-13]), so this class is where the 2% kill threshold is most
      at risk.
      The hand-off and the deferred verification below are widened to match.
  - (o) **The report names what it skips.** The `--reselect strict` sources
    line lists S9 as left out (critique point 7, taken). It is an eval
    script, not a runner, and the expectation changed on purpose.
  - (p) **The variant is deferred** (§0.3 item 4 above).
  - (q) **A runtime confirmation is not exempt from S9**, because whether a
    runtime check can tell an old defect from a new one is VS-30's question.
  - (r) **The "not in this change" annotation tag is deferred.** It changes
    the settled-verdict vocabulary (core `eval.ts` `Verdict`, `judge.ts`,
    the rubric) and may need `RUBRIC_VERSION` 2 (VS-45, Q29). So it belongs
    with the VS-22a follow-up's scope label.
  - (s) **New strings only** (D14). The two warnings are new strings for a
    new key. A `review.json` that already set `scopeGate` now gets them
    instead of "unknown key".
- **Critique points.**
  1. (Major) False drops: decision (n), the widened hand-off, the deferred
     verification split, and the renamed fixture.
  2. (Major) Fail-open: (l) and (i). The parity test and a count of findings
     S9 could not check are handed off below.
  3. S9's position: moved before S6, per (c). The mutation tests cover "S9
     after S6", "S9 after S7" and "S9 before S5".
  4. `quoteMatches`: (g).
  5. `otherSide`'s home: (h). The correction to VS-27b's hand-off is below.
  6. Engine replay coverage: a replay of a base `review.json` with `{
     guardrail: "strict", scopeGate: "introduced" }` and with `{ scopeGate:
     "introduced" }` alone. It asserts that neither key is in
     `artifact.config.value`, that the warnings are `[guardrail not
     applied, scopeGate not applied]` and `[scopeGate ignored]`, that
     `scope.policy` and `scope.prompts` are the defaults, and that the
     selection is the legacy one.
  7. The report's sources line: (o).
  8. Schema cases: `{ scopeGate: "introduced" }` and `{ guardrail: "off",
     scopeGate: "introduced" }` joined the loop that expects undefined.
  9. The window reading: (a).
  10. Accuracy:
      - the candidate fact is named `preExisting`, per (m);
      - added files get no base keys, per (l);
      - one scratch path, `/tmp/vector-vectorscope/vs42a/`;
      - the agreement test is worded "preExistingSuspect agrees with
        strictSelect's pre-existing drops on unlabelled findings". Over 150
        generated seeds, a lone unlabelled finding drops as `pre-existing`
        exactly when it is a suspect and S1 to S5 kept it. Every other
        finding has the fate it has with the gate off.
- **Correction to the VS-27b entry** (this log is append-only). Two
  statements there are wrong:
  - Its hand-off "VS-42 needs `quoteMatches` positionally: map a head line
    to base with `mapLine` first" names the wrong mapper. `diff.ts mapLine`
    maps base to head; head to base is `trivial.ts otherSide(file,
    "RIGHT")`. The `quoteMatches` doc comment is corrected in this package.
  - Its "Deferred" list names a `changedSpans` export for VS-42. None was
    needed, per (f).
- **Hand-offs to VS-42 wiring, with VS-27c.**
  - **The report schema's `scope` field**, required on blocking findings,
    with its decoder over `FINDING_SCOPES`. It enters `promptsDigest` only
    under the key.
  - **The prompt clause** under the key:
    - "do not report bugs that exist at the merge-base unless this change
      makes them reachable or worse";
    - every blocking finding, introduced ones included, must quote at least
      one changed line, or S9 drops it (decision (n));
    - an exacerbated finding must quote the changed line that makes the old
      defect reachable or worse.
  - **Notes, not the summary.** The `pre-existing` count goes in
    `ReviewOutcome.notes` and is not moved into the summary: the rubric
    counts summary listings as posted. The count of findings S9 could not
    check, because their base was unreadable, goes there too, so the
    measurement is honest (I-7).
  - **Owner sign-off** on the empty-result wording when S9 empties a
    complete result, beside VS-27b's wording question.
  - **`policyDigest`** must count `scopeGate` only under strict. Today it
    reads an unapplied key as absent; once the key leaves the list, a plain
    non-default value would count even without strict.
  - **Blob reads.** Pass the review's whole ReviewConfig to both
    `strictBlobRequests` and `strictSelect`. The engine reads the base keys
    `strictBlobRequests` names through the base tree-ish, with containment
    (I-8). A VS-27c parity test must show that, under both keys, S9 reads
    every base key it named and the engine supplied each one.
  - **D3 parity tests**, the variant `engine:scope-introduced` (baseline
    `engine:guardrail-strict`) and the desktop half.
  - **Artifacts** that record the candidates and the blobs seen, base
    included, so `report.ts` can re-select with S9 (the sources line then
    moves S9 from "left out" to "applied") and the zero-spend pre-check can
    run on the first settled artifacts.
  - **VS-44's trace quotes** join conditions (c) to (e) of
    `preExistingSuspect`.
  - **VS-30's question**: whether a runtime confirmation can separate an
    old defect from a new one (decision (q)).
  - **VS-21's external comparisons** must state that S9 drops findings
    ReviewBench counts as true.
  - **The "not in this change" annotation tag**, with the VS-22a follow-up's
    scope label (decision (r)).
- **Owner questions, kept neutral.** None new. Q18 (whether VS-42 is
  approved), Q13, Q3, Q4, Q17 and Q29 stay open. Where `pre-existing` sits
  in `STRICT_DROPS`, between `no-impact` and `no-fix`, is the lane's reading
  (decision (c)); it sits beside VS-27b's reorder question for the owner.
- **Predicted merge conflicts.** This was read-only: `git merge-tree
  --write-tree --name-only` at HEAD, then a three-way `git merge-file` of
  each touched file that either branch changes, comparing the working tree
  with each branch's merge base and tip.
  - Of the touched files, only `config.ts` (on `origin/codium`, `5a079cbd`)
    and `types.ts` (on both codium and `origin/self-evolving`, `f062bcce`)
    change on those branches.
  - `config.ts`: no conflict, as at HEAD.
  - `types.ts`: 2 conflict hunks with codium and 1 with self-evolving. They
    are identical to the hunks at HEAD (the VS-27a pass-name lines), and
    none holds a VS-42a line.
- **Deferred.**
  - The `scope` report-schema field and its decoder; the prompt clause; the
    notes counts; the variant and its parity tests; the engine's base reads;
    the desktop half. All wait for VS-42 wiring, with VS-27c (runner-wiring
    window, Q13).
  - The "not in this change" annotation tag, per (r).
  - Moving `otherSide` beside `mapLine`, per (h).
  - Re-selecting artifacts with S9.
- **Deferred verification.**
  - **The kill criterion is unmeasured.** No settled artifacts exist, so the
    criterion (drop at most 2% of settled true positives, and remove at
    least 20% of the false alarms annotators tagged "not in this change")
    cannot be measured. When the zero-spend pre-check runs, it must report
    S9's drops of settled true positives split into same-file context and
    `crossFile` (VS-22a's label), because decision (n)'s class is where the
    2% threshold is most at risk.
  - No model emits `scope`.
  - The engine's base reads are untested, because nothing reads them yet.
  - The desktop is not covered.
  - The merge conflicts are only predicted.
  - The `scopeGate` branch of `evidenceScope` cannot be observed until both
    keys leave `UNAPPLIED_REVIEW_KEYS` (see the mutation check).
- **Evidence.** Each file was run alone through the lock with `--timeout
  30000`, from its package directory. Counts are at HEAD → with VS-42a.

  | File | HEAD | VS-42a |
  |---|---|---|
  | core `test/review/guardrail.test.ts` | 30 | 44 |
  | core `test/review/schema.test.ts` | 46 | 47 |
  | core `test/review/config.test.ts` | 49 | 53 |
  | core `test/review/model-evidence.test.ts` | 22 | 24 |
  | core `test/review/trivial.test.ts` | 44 | 44 |
  | core `test/review/diff.test.ts` | 50 | 50 |
  | core `test/review/select.test.ts` | 45 | 45 |
  | core `test/review/format.test.ts` | 51 | 51 |
  | core `test/review/verdict.test.ts` | 45 | 45 |
  | engine `test/review/eval.test.ts` | 29 | 30 |
  | engine `test/review/run.test.ts` | 44 | 44 |
  | engine `test/cli/github.review.test.ts` | 40 | 40 |
  | app `ai-review.test.ts` (`--preload ./happydom.ts`) | 107 | 107 |
  | eval `report.test.ts` (from `script/vectorscope-eval`) | 33 | 33 |
  | eval `replay.test.ts` (from `script/vectorscope-eval`) | 32 | 32 |

  - **Run notes.** The engine suites ran with fresh XDG roots under the
    scratch folder. HEAD counts for guardrail, schema, config,
    model-evidence, trivial, report and replay were run at `d268025c` before
    any edit. Those for diff, select, format, verdict and the runner suites
    are the VS-27b column of the VS-27b entry, whose change is the HEAD
    commit `d268025c`; VS-42a's runs give the same counts.
  - **Typecheck.** `bun typecheck` passes in core and engine; app and
    desktop pass `bun typecheck --force`; the eval scripts pass `bun tsgo -p
    ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`.
  - **Lint.** prettier is clean on every changed source and test file, on
    the eval README and on `report.ts` and its test. oxlint reports no
    warning on an added or changed line. One unnecessary non-null assertion
    in a new schema test was removed; the 57 warnings that remain in these
    files are all on lines this package did not touch.
  - **Mutation check.** 23 mutations, each applied alone, were run against
    the named test file, and each file was restored byte for byte (checked
    by hash). 22 were caught:
    - in `guardrail.ts`: `scopeGateApplies` ignoring guardrail; the label
      ignored; all quotes instead of the matched ones; `touched` radius 1;
      identity base mapping; the base read at the head path for a rename;
      an unreadable base demoting; the LEFT-quote exemption removed;
      `addedIn` removed; S9 after S6; S9 after S7; S9 before S5; no RIGHT
      base keys in the requests; base keys asked for added files;
      `trimQuote` losing the leading-line move;
    - in `schema.ts`: the enum always including `pre-existing`, caught by
      both the schema and the guardrail tests;
    - in `config.ts`: the ignored note missing; the note inverted; the
      not-applied warning without strict;
    - in `model-evidence.ts`: the memo key missing `scopeGate`;
    - in `report.ts`: the sources line dropping S9;
    - in engine `eval.ts`: `WIRING` naming the wrong package.

    One survived, and it is equivalent by construction. It made
    `evidenceScope` pass `scopeGate` while the key is unapplied. While
    `guardrail` is unapplied, `evidenceScope` never passes strict, and
    `promptsDigest` ignores `scopeGate` without strict, so no output can
    change.
  - **Not run.** The full root typecheck was not run, since nothing is
    pushed.
  - **Not done.** Nothing was sent to a model; there was no paid run, no
    workflow dispatched and nothing published; and no existing user-visible
    string changed (D14).

### 2026-11-07 · VS-42a review fixes

Six review findings, none blocking. Five were fixed. The sixth
(`report.ts`) needed no change, as the finding itself allows, and the reason
is given below. Core `review/guardrail.ts`, `review/types.ts` (a comment
only), `review/model-evidence.ts` (the pin) and `test/review/guardrail.test.ts`
changed. No runner, provider, LLM or posting file and no file @vector owns
changed. Nothing is committed. Where these points differ from the entry
above, they supersede it.

- **Comment width.** The `STRICT_DROPS` comment in `types.ts` is reflowed to
  120 columns, with the wording unchanged. Two other added comment lines were
  over 120 and are reflowed the same way: the second condition in
  `preExistingSuspect`'s comment, and the S9 fixture comment in
  `guardrail.test.ts`. The test names that remain over 120 are strings,
  which prettier leaves alone, as at HEAD.
- **`addedIn` without non-null assertions.** Taken as suggested: `line.kind
  === "add" && line.newLine !== undefined && line.newLine >= start &&
  line.newLine <= anchor.line`.
- **`strictBlobRequests` looks a quote's file up once.** Taken as the first
  option. The file status is now read only under the gate and only for a
  RIGHT quote; any other quote returns its own key first. The keys named are
  unchanged.
- **S9 reads the cached base lines.** Taken, with one shared cache.
  - strictSelect's per-run split cache (its `read` closure) is now the
    module function `lineReader(blobs)`, with the same results: lines,
    `"absent"`, or `"unreadable"`.
  - `strictCandidates` (below) uses it for S4's quotes and S9's bases, so a
    base file is split once per run. `preExistingSuspect` builds its own
    per-call reader, so it reads exactly as strictSelect does.
  - `unchangedSinceBase` calls `matchAt` on the cached lines.
  - `textOf` is removed. `quoteMatches` stays exported for VS-44 and the
    tests, but nothing in `guardrail.ts` calls it now.
  - This supersedes the "Cost" bullet of decision (g) and the `textOf`
    mention under "What landed".
- **A count of findings S9 could not check (I-7).** Taken now, though the
  finding marks it optional until wiring.
  - **Count.** `StrictPass.preExistingUnchecked` counts the kept findings
    that S9 could not check because a base it needed was null or missing
    from the map. It is counted among the kept, after S8, as `fixUnchecked`
    is, and it is 0 when no candidate carries S9's fact (S9 off, or
    `report.ts`).
  - **The fact is three-valued.** `StrictCandidate.preExisting` returns
    `true` (drop), `false` (keep), or `"unchecked"` (keep and count).
    `suspect` returns `"unchecked"` only when every other condition holds
    and no matched quote is known to differ from its base. A quote on a
    changed line, or one that differs from a base S9 did read, decides the
    finding whatever the other quotes' bases are. A base the tree lacks
    (`{ absent: true }`) counts as checked: it holds no old code. So
    `suspect` now checks every matched quote (a `map`) rather than stopping
    at the first that fails; every base it reads is still one that
    `strictBlobRequests` named.
  - **Where the count can be read.** The count is not in `StrictResult` or
    its schema; it joins them with VS-42 wiring. For a caller to read it
    without a result field, strictSelect's candidate building is now the
    exported `strictCandidates(findings, input)`, and strictSelect is
    `strictRules(strictCandidates(...))` followed by the same result
    assembly. Its output is unchanged.
  - **`preExistingSuspect` still returns a boolean.** It is true only for a
    suspect, so a caller can never read `"unchecked"` as truthy.
  - **Tests.**
    - The I-7 test now asserts the count for each kind of base. A null or
      missing base gives 1 and an absent one gives 0; S9 off gives 0.
    - A quote on a changed line, or one that differs from a read base,
      gives 0 beside an unreadable one.
    - A drop gives 0, whether by the suspect check or by the label.
    - Two unchecked findings give 2, and 1 under `maxComments: 1`.
  - **The parity test.** The 400-case property test now runs the pass a
    second time over recording maps. It asserts that every head and base key
    read was named by `strictBlobRequests` under the same config, gated or
    not.
  - **The count oracle.** In the same test, the count equals the kept
    findings that a supplied store.ts base would have made suspects.
  - **Generator change.** The generator gains one draw, taken last, so the
    ungated cases are unchanged. In half the gated cases store.ts's base is
    missing and every finding also quotes that file. The property's `seen`
    list gains `pre-existing-unchecked`, which 4 kept findings reach over
    the 400 cases.
  - **Still a hand-off.** The VS-27c engine test, that S9 reads every base
    key it named and the engine supplied each one, stays with VS-42 wiring,
    as does carrying the count into `ReviewOutcome.notes`. VS-27c either
    adds it to `StrictResult` under the key, or calls `strictCandidates`
    and `strictRules` once and assembles the result. Either way the rules
    run only once.
- **`report.ts`'s S9 clause: no change** (decision (o) stands).
  - The clause states a fact about the re-selection itself: no base blobs
    are recorded, so S9 cannot run offline. That holds for every artifact,
    whatever its config.
  - Emitting it only when a replay's config or variant names `scopeGate`
    would test for something that cannot happen before wiring. The replay
    drops the key from the base `review.json` and refuses it in
    `ReplayInput.config`, and no variant names it. So the clause would never
    appear, and the report would stop saying what it leaves out.
  - The report is an eval script, not a runner, so I-1 does not apply to
    it, and the changed expectation in `report.test.ts` is deliberate.
- **Off by default (I-1).** With the keys unset, nothing changes.
  - strictSelect's output is the same: every existing guardrail test passes
    with its assertions unchanged, apart from the extended I-7 and property
    tests.
  - The ungated generated cases are the same as before.
  - No runner imports `guardrail.ts`.
- **Pin (I-12).** `REVIEW_PIPELINE_SOURCES` moves from `8e2a3d79e36f8607` to
  `38231815cfde9eed`, because `guardrail.ts` changed.
  `REVIEW_PIPELINE_REVISION` stays 1.
- **Evidence.** Each file was run alone through the lock with `--timeout
  30000`, from its package directory.
  - **Counts, all unchanged by this round:**
    - core `guardrail.test.ts` 44;
    - `schema.test.ts` 47;
    - `config.test.ts` 53;
    - `trivial.test.ts` 44;
    - `model-evidence.test.ts` 24;
    - eval `report.test.ts` 33 (from `script/vectorscope-eval`).
  - **Typecheck.** `bun typecheck` passes in core. The eval scripts pass
    `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json`, run from
    `packages/engine`.
  - **Lint.** prettier is clean on the three changed source and test files.
    oxlint reports 0 warnings on them.
  - **Mutations.** Six mutations were each applied alone and run against
    `guardrail.test.ts`, and the file was restored byte for byte (checked
    by hash). All six were caught:
    - an unreadable base not counted;
    - an absent base counted;
    - a decided quote ignored;
    - the count taken before the cap;
    - "unchecked" dropping the finding;
    - `judge` losing the flag.
  - **Not run.** The engine and app runner suites were not re-run: nothing
    they import changed beyond a comment in `types.ts` and the pin, which
    only core's `model-evidence` test reads. The full root typecheck was not
    run, since nothing is pushed.

## 2026-11-07 · VS-43a Rule citation checker (pure)

Addendum A §2 VS-43 (its Now part only), with the §1 `ruleCheck` row, §1a's
VS-43 row, §3 VS-27 (`linkedRule`, "checked by VS-43") and §4's windows.
Evidence: round-two REPORT [CF10] (a rubric that asks a finding to cite the
smallest supporting rule range and never to raise a finding because a rule
file exists), [GP6] (structured rules with id, glob scope and severity),
[VT3] (path-scoped trusted rules exist; locally the engine's own loader, not
VectorScope, reads AGENTS.md) and the report's final check, which corrected
how `rulesForPaths` merges: one text for the whole change, a section
included when any changed file matches it. Built at `977e3667`. The
addendum's line citations at `7cadfcb8` were re-located on HEAD: the `rule`
decode is at `schema.ts:453-454` (the schema field at `:89`), the render at
`format.ts:319-323` (it always says "rule from .vector/review.md"),
`MAX_TRUSTED_CHARS` at `prompt.ts:105` and `trusted()` at `:584-597`,
`rulesForPaths` at `config.ts:504-515`; `review.ts:434-438` and `:448`,
`run.ts:680-682`, `ai-review.ts:837-843`, `github.review.ts:677-695` and
`context.ts:247-248` are unchanged. Now window only: pure core code that
nothing calls. No key is parsed, and `run.ts`, `ai-review.ts`,
`provider.ts`, `session/llm.ts`, `posting.ts`, `cli/cmd/review.ts`,
`eval.ts`, `replay.ts`, `report.ts`, `format.ts`, `select.ts` and every
@vector file are untouched. It implements the VS-43a plan as corrected by
its critique: every point was taken except point 7's optional alternative
input, declined in (c) with the reason. Nothing is committed (the lane
brief).

- **What landed.**
  - **Core `review/types.ts`** (still import-free): `RuleSource`
    (`repository_instructions`, `review_rules`, `paths` with a 0-based
    `index`, `scoped` with a `path`) and `RuleCitation` (`source`, `quote`,
    `lines?`), after the `FINDING_SCOPES` block. The comment says `lines` is
    carried and never checked, only `decodeRuleCitation` builds one, and
    `ModelFinding` gains no field, so `rule` stays the quoted text.
  - **Core `review/schema.ts`**: `MAX_RULE_QUOTE_CHARS` (1,000),
    `RuleCitationProblem` (`not-structured`, `source`, `quote`) and
    `decodeRuleCitation(input)`, returning `{ citation } | { problem }`, the
    shape of `readZdrAttestation`. Private `ruleSource` and `ruleLines`.
    `decodeFinding`, `decodeReport` and every schema are unchanged.
  - **Core `review/config.ts`**: `RulePart` (`global`; `section` with its
    globs; `paths` with its `index` in the parsed list and its `glob`),
    `ruleGlobMatches(path, glob)` (minimatch with `dot` and `matchBase`, as
    before) and `rulePartsForPaths(rules, changedPaths, extra)`, built with
    `flatMap`. `rulesForPaths` is now its parts' texts joined by blank lines,
    with the same signature and output.
  - **Core `review/prompt.ts`**: `MAX_TRUSTED_CHARS` is exported, with a
    comment naming citation.ts. `trusted()` and all output are unchanged
    (the addendum's named alternative).
  - **Core `review/diff.ts` and `review/guardrail.ts`**: `onChangedLine` (S3)
    and `endLineOf` moved from guardrail.ts into diff.ts, exported, with the
    bodies unchanged; the comment names both callers. guardrail.ts imports
    them and deletes its copies; no other line changed.
  - **New core `review/citation.ts`**: `RulesSource`, `RULE_MISMATCHES`
    (`source`, `clipped`, `head-added`, `misquote`, `scope`,
    `scope-unknown`, `anchor`), `RuleCheck`, `TrustedLine`, `TrustedText`,
    `TrustedPart`, `TrustedBlock`, `TrustedRules`, `trustedRules(input)` and
    `ruleCited(finding, trusted)`. Pure and browser-safe; it imports
    config.ts, diff.ts, prompt.ts and types, and never guardrail.ts or
    select.ts.
  - **Core `review/model-evidence.ts`**: `REVIEW_PIPELINE_SOURCES` moves from
    `38231815cfde9eed` to `9d2557d711675fbd`, because citation.ts joined the
    pinned files and `diff.ts`, `guardrail.ts` and `prompt.ts` changed.
    `REVIEW_PIPELINE_REVISION` stays 1, and `EVIDENCE_POLICY_KEYS` is
    unchanged: there is no key.
  - **Tests**:
    - new core `citation.test.ts`, 26 tests;
    - core `schema.test.ts`, 47 → 54 (a `decodeRuleCitation` block);
    - core `config.test.ts`, 53 → 55 (`rulePartsForPaths`,
      `ruleGlobMatches`);
    - core `diff.test.ts`, 50 → 52 (`onChangedLine` and `endLineOf`);
    - core `model-evidence.test.ts`, 24 → 24: `REVIEW_PIPELINE_FILES` gains
      citation.ts after guardrail.ts, and the comment says it is pinned from
      the day it lands, as guardrail.ts is, because it will decide what a
      review drops or strips.
- **How `ruleCited` checks**, in order; the first failure is the reason:
  1. **Source.** `repository_instructions` needs the instructions block;
     `review_rules` the rules block, all of its parts; `paths[i]` the part
     from `paths` entry `i` (or the block's one part when its parts are
     unknown); `scoped:` always fails until VS-48. In a base-branch run, a
     non-scoped source failure whose quote the change added is
     `head-added`.
  2. **Quote.** It must hold a letter or a digit, and cover one or more
     whole trusted lines of one part it may cite, at least one of them a
     rule line, in the text trusted() sent. Lines are compared after
     trimming, collapsing whitespace and stripping heading marks, blockquote
     marks and list markers, the same way on both sides. A heading, a fence,
     a line inside a fenced example and a line with no letter or digit are
     not rule lines. Otherwise: `clipped` when the quote is whole only past
     the clip, or runs into a line the clip cut; then `head-added` in a
     base-branch run when an added run of the diff holds it; then
     `misquote`, which includes a quote across two parts.
  3. **Scope.** A holding part whose scope is unknown gives `scope-unknown`
     (fail closed). Otherwise one holding part must be unscoped (global,
     instructions) or have a glob that `ruleGlobMatches` the finding's head
     path (`lookupFile(...)?.file.path`), or the result is `scope`.
  4. **Anchor.** `resolveAnchor` must succeed and `onChangedLine` hold (S3).
  5. Otherwise `{ cited: true, rulesSource }`.
- **Off by default (I-1, I-12).**
  - **Nothing calls it.** No key exists. A grep over `packages/engine`,
    `packages/app`, `packages/desktop` and `script` finds no import of
    citation.ts, `decodeRuleCitation`, `rulePartsForPaths` or
    `ruleGlobMatches`; `onChangedLine` and `endLineOf` appear only in core
    diff.ts and guardrail.ts; `MAX_TRUSTED_CHARS` only in prompt.ts,
    citation.ts and the test.
  - **Unchanged behaviour.** `decodeReport` and the schemas are unchanged (a
    test shows a structured `rule` object is still dropped by the legacy
    decoder, and the quoted text still kept, with and without strict).
    `rulesForPaths` is byte-identical: the existing test passes unchanged, a
    new test checks the joined parts on several path sets, and a scratch
    property check compared it with HEAD's body over 5,000 random rules,
    paths and `paths` lists. `trusted()` is untouched, and the S3 move
    changes no line of either body.
  - **Digests** (printed before and after, all held): `promptsDigest()`
    `5d59e9ee06077c23`; `{ impact: "graph" }` `74a2111826c226b1`;
    `{ guardrail: "strict" }` `b98afb0e878dfe26`; with `impact: "graph"`
    `3ba21b5bc883cd70`; `{ guardrail: "strict", scopeGate: "introduced" }`
    `4aa712221043a3a7`; with `impact: "graph"` `8335adf9de513ee5`;
    `policyDigest(DEFAULT_REVIEW_CONFIG)` `70512122f41ec160`.
  - **Runner suites** pass with unchanged counts (table below).
  - **§0.3 items 4 and 5.** The variant `engine:rule-strict` and the desktop
    half wait for VS-43 wiring: no registry, README, `replay.test.ts` or
    `ai-review.ts` change.
- **Decisions.**
  - (a) **No key and no `ModelFinding` field.** §4 puts VS-43's config parse
    in the runner-wiring window (unlike VS-42a's decision (a), where §4 did
    not), so `ruleCheck` is neither typed nor parsed, and no
    `UNAPPLIED_REVIEW_KEYS` entry is added.
  - (b) **The check runs against PromptInput's own texts**, clipped by the
    exported constant, so it reads exactly what trusted() sent. Two tests
    pin the cut against `buildReviewPrompt`: one in the instructions block,
    one in a rules block whose untrimmed global text moves the cut. The
    "…(truncated)" marker is not trusted text and is never matched.
  - (c) **Scope comes from parts**, because the block is one text for the
    whole change. Parts are used only when their texts, joined by blank
    lines and trimmed, are the rules text trimmed (critique point 2, option
    (a)); offsets are read inside the trimmed text, less what the trim
    removed at the front. Otherwise the block is one part of unknown scope,
    and every citation of it fails closed as `scope-unknown`. Critique point
    7's optional alternative input (`{ rules: ReviewRules, changedPaths,
    extra }`) was declined: the join check already refuses parts that do
    not reproduce the text, and the alternative cannot help CI, where only
    the rules string reaches `Review.run`.
  - (d) **The reason order** is source, quote, scope, anchor. Scope comes
    before the anchor so a wrong-scope citation on an unchanged line is
    counted as a scope error, the rule claim being the subject. Within the
    quote, `clipped` comes before `head-added`, since a quote that is in the
    trusted text is not a head addition.
  - (e) **`head-added`** applies only when the cited block's source is "base
    branch", counts any run of consecutive added lines in the diff (matched
    with the same whole-line rule), and only names why a citation failed.
    It refines a not-found quote and, per critique point 5, a source
    failure too: in the realistic attack the base has no AGENTS.md or
    `.vector/review.md` and the PR adds them, which would otherwise read as
    `source`. So both blocks always carry the source trusted() would render
    for them, `"base branch"` when none is given, even when not sent; this
    replaces the plan's optional blocks. `scoped:` stays `source` with no
    refinement and records no source, since no block carries scoped files
    yet.
  - (f) **Quote matching is strict, a setting I-13 will measure** (critique
    major point 1, taken). A quote must cover whole trusted lines, one of
    them a rule line; it forgives whitespace and list or heading markers
    only, and matches case and punctuation exactly. So a single word, a
    fragment that flips a rule ("log access tokens" from "Never log access
    tokens."), half of a line (one sentence of a two-sentence bullet), a
    heading alone (`## path: src/billing/**`) and a fenced example line
    alone (a "Bad:" example) are all `misquote`. This matches the prompt
    clause the addendum plans ("its smallest supporting line range"). The
    cost: a model that quotes one sentence of a longer line fails; a
    sentence-level relaxation, Markdown emphasis and smart-quote forgiveness
    wait for Phase A figures, and the strictness enters the kill criterion's
    format-mismatch count. Matching uses `startsWith` at each line's start,
    with no regular expression, so no character in a quote is special and
    nothing can throw (critique point 4, its second option); a later
    occurrence is found when the first is mid-line. A line the clip cut
    through is not whole, so a quote ending on a half-cut word is `clipped`
    (critique point 3). The plan's letter guard is kept: it decides the
    reason only for a quote with no letter or digit that runs into the clip
    (`misquote`, not `clipped`), and a test pins that.
  - (g) **S3 moved to diff.ts.** guardrail.ts imports select.ts, and the
    `rule-unverified` drop goes in select.ts, so citation.ts importing
    guardrail.ts would make the cycle select → citation → guardrail →
    select at wiring. `resolveAnchor` is untouched.
  - (h) **The decoder lives in schema.ts**, beside the other decoders, so
    schema.ts never imports citation.ts. It drops, never cuts: an empty
    quote, one with no letter or digit, or one over 1,000 code points (as
    JSON Schema's `maxLength` counts) is a `quote` problem. Source spelling
    is lenient for the two block names (case, the tag's brackets and slash,
    spaces or hyphens) and for `paths[i]` and `scoped:` (case, spacing).
    File names (`AGENTS.md`, `.vector/review.md`, `review.json`) are
    refused, though the posted label says "rule from .vector/review.md"
    (critique point 8): the prompt clause added at wiring must name the
    exact source tokens, and file-name aliases wait until measured (I-13).
    The three problem kinds are already separate, so the kill criterion's
    count can be split by kind. `paths[i]` is 0-based into the parsed
    `ReviewConfig.paths`, a safe integer. A scoped path is trimmed before
    `cleanPath`, keeps its case, and is refused when empty, holding a
    control character (`\p{Cc}`, which covers line breaks and tabs), or
    matching `ESCAPING_PATH` (critique point 6). `lines` is unchecked and
    optional: a whole number, text such as `L3-L7` or `3–7`, or a
    `{ start, end }` object (`RuleCitation`'s own shape for `lines`; the
    plan named only the first two), with 1 ≤ start ≤ end, else silently
    dropped.
    Extra keys are ignored.
  - (i) **`scoped:` fails `source` until VS-48** sends scoped files, which
    then join as parts with their own globs.
  - (j) **citation.ts is pinned** from the day it lands, as guardrail.ts
    was. config.ts stays unpinned, as at HEAD; its change here is
    byte-identical in output.
  - (k) **No user-visible string** (D14): the reasons are codes, and nothing
    renders them.
  - (l) **Severity is out** [GP6]: no trusted rule carries a severity today,
    and the check never raises or weights a finding.
  - (m) **Shapes beyond the plan.** `TrustedPart.sent` and `full` are
    `TrustedText` (normalised lines with offsets, rule and whole flags), not
    plain normalised strings, because the whole-line rule needs line
    boundaries. `RuleCheck.rulesSource` is recorded for every non-scoped
    citation, the block's rendered source, even when the block was not
    sent.
- **Hand-offs to VS-43 wiring (runner-wiring window, Q13).**
  - **Key and digests.** The `ruleCheck: off | strict` parse (no env), its
    `OPTIONAL_REVIEW_DEFAULTS` and `UNAPPLIED` entries; `EVIDENCE_POLICY_KEYS`
    counts it only as `"strict"`, once applied. The strict schema's `rule`
    object and the prompt clauses enter `promptsDigest` only under the key.
  - **Decoding.** `ModelFinding.citation`, set from `decodeRuleCitation`
    under the key, with the problems counted by kind.
  - **Drops.** `rule-unverified` in select.ts, and strip-and-count when the
    rule was not the finding's only basis ("only basis" being style,
    maintainability or docs). The counts go in `ReviewOutcome.notes`.
  - **CI parts.** `github.review.ts` builds the rules string and hands
    `Review.run` only that, and it is @vector-owned. Until parts reach
    `Review.run`, strict `ruleCheck` in CI rejects every `review_rules` and
    `paths[i]` citation as `scope-unknown`, global rules included. That
    would likely trip the kill criterion ("format mismatches drop more than
    2% of settled true positives") on the first ablation, so it bears on
    Q13 and Q18: either CI waits for the @vector merge, `Review.run` gains
    the parsed rules (`ReviewRules`, changed paths and `config.paths`), or
    wiring derives parts from the block's own `## path:` headings when
    re-rendering them reproduces the text exactly. The last is not built: a
    `paths` entry's instructions may hold `## ` lines, so it needs its own
    fail-closed test.
  - **Local CLI.** It sends no `<repository_instructions>` block (VT3), so
    `repository_instructions` citations fail `source` until wiring passes
    the loader's text. The wiring should also pass `instructionsSource:
    "working tree"` for a trusted local run even when it sends no
    instructions, or a quote from a working-tree AGENTS.md the change added
    reads as `head-added` (the default source is "base branch").
  - **`paths[i]`.** The rules block shows no index, only `## path: <glob>`
    headings: the prompt must render each entry's index, or the form is
    dropped from the schema.
  - **Owner (D14).** The posted label "rule from .vector/review.md"
    (`format.ts:319-323`) misnames AGENTS.md and review.json rules.
  - **`StrictResult.linkedRule`** (§3 VS-27) and its `ruleCited` check are
    deferred to the VS-27 follow-up and VS-43 wiring; this package builds no
    `StrictResult` field.
  - **Remaining wiring.** The desktop half (`ai-review.ts:837-843`) with D3
    parity tests in `run.test.ts` and `ai-review.test.ts`; the variant
    `engine:rule-strict`; the VS-22a follow-up's head-added rule case; the
    Phase A figures; VS-48's reuse of the checker for scoped files.
- **Deferred verification.**
  - The kill criterion and the three Phase A figures (share of findings with
    a rule, share failing, settled precision of rule-cited findings) are
    unmeasured: no model emits structured citations yet.
  - The CI and desktop paths are not covered; the CI consequence above is
    reasoned from the code, not run.
  - The merge conflicts are only predicted.
- **Owner questions.** None new. Q18 (whether VS-43 is approved) and Q13
  stay open, and this package is neutral on them: nothing calls it.
- **Predicted merge conflicts.** Read-only: `git merge-tree --write-tree
  --name-only` at HEAD, then a three-way `git merge-file` of each touched
  file that either branch changes, comparing the working tree with each
  branch's merge base and tip.
  - Of the touched files, `config.ts`, `prompt.ts` and `types.ts` change on
    `origin/codium` (`5a079cbd`), and `types.ts` on `origin/self-evolving`
    (`f062bcce`).
  - `config.ts` and `prompt.ts`: no conflict with codium, at HEAD or with
    VS-43a (its hunks are `FIELDS` and the judge prompt, far from `:105`
    and `:504-515`).
  - `types.ts`: 2 conflict hunks with codium and 1 with self-evolving, at
    HEAD and with VS-43a alike, and identical (the VS-27a pass-name lines).
    No new conflict hunk.
- **Evidence.** Each file was run alone through the lock with `--timeout
  30000`, from its package directory. Counts are at HEAD → with VS-43a.

  | File | HEAD | VS-43a |
  |---|---|---|
  | core `test/review/citation.test.ts` | (new) | 26 |
  | core `test/review/schema.test.ts` | 47 | 54 |
  | core `test/review/config.test.ts` | 53 | 55 |
  | core `test/review/diff.test.ts` | 50 | 52 |
  | core `test/review/guardrail.test.ts` | 44 | 44 |
  | core `test/review/model-evidence.test.ts` | 24 | 24 |
  | core `test/review/prompt.test.ts` | 36 | 36 |
  | core `test/review/select.test.ts` | 45 | 45 |
  | core `test/review/trivial.test.ts` | 44 | 44 |
  | core `test/review/format.test.ts` | 51 | 51 |
  | core `test/review/pipeline.test.ts` | not run | 2 |
  | engine `test/review/run.test.ts` | 44 | 44 |
  | engine `test/cli/github.review.test.ts` | 40 | 40 |
  | engine `test/review/eval.test.ts` | 30 | 30 |
  | app `ai-review.test.ts` (`--preload ./happydom.ts`) | 107 | 107 |
  | eval `report.test.ts` (from `script/vectorscope-eval`) | 33 | 33 |
  | eval `replay.test.ts` (from `script/vectorscope-eval`) | 32 | 32 |

  - **Run notes.** HEAD counts for citation's neighbours (schema, config,
    diff, guardrail, model-evidence, prompt, select) and for the runner and
    report suites were run at `977e3667` before any edit, the engine ones
    with fresh XDG roots under `/tmp/vector-vectorscope/vs43a/xdg/`. Those
    for trivial, format and replay are the VS-42a column of the VS-42a
    entry, whose change is the HEAD commit.
  - **Typecheck.** `bun typecheck` passes in core and engine; app and
    desktop pass `bun typecheck --force`; the eval scripts pass `bun tsgo -p
    ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`.
  - **Lint.** prettier is clean on every changed source and test file except
    `prompt.ts`, whose one prettier difference (the `requirements` line, 449
    at HEAD) predates this package and was left alone. oxlint reports 25 warnings in these files,
    none on an added or changed line.
  - **Mutation check.** 33 mutations, each applied alone and run against the
    named test file (one of them against two files), with each file restored
    byte for byte (checked by hash). All are caught; one survived the first
    pass and is caught after a test was added:
    - in `citation.ts`: the quote compared raw; no line-end boundary; no
      line-start boundary; the full text used for the sent text; head-added
      in a working-tree run; head-added removed; the source-failure
      refinement removed; `scoped:` refined as head-added; scope ignoring
      globs; the `paths` index off by one; unknown parts read as global; the
      anchor check removed; the anchor checked before scope; the letter
      guard removed; the default source "working tree"; the clip at
      `MAX_TRUSTED_CHARS - 1`; the parts compared untrimmed; a cut line
      read as whole; the `clipped` reason for a cut removed; fenced example
      lines read as rules; headings read as rules; `scoped:` recording a
      block source; and the trim lead ignored. The last survived at first:
      line offsets come from each part's own slice, so the clip stayed
      right, and only each later part's first two characters (its heading's
      `##`) moved to the separator. The boundary test now also asserts that
      the section's heading alone is a `misquote`;
    - in `schema.ts`: a negative `paths` index; `..` accepted for `scoped:`;
      control characters accepted; the scoped path not trimmed; a long quote
      kept; start > end kept; the source read case-sensitively;
    - in `config.ts`: a part missing its heading; the `paths` index shifted;
    - in `diff.ts`: `onChangedLine` accepting a snapped line, caught by both
      the diff and the citation tests.
  - **Not run.** The full root typecheck was not run, since nothing is
    pushed.
  - **Not done.** Nothing was sent to a model; there was no paid run, no
    workflow dispatched, nothing published and nothing committed; no
    existing user-visible string changed (D14).
  - **Commit (when the orchestrator asks).** `feat(review): VS-43a rule
    citation checker`, staging the explicit paths, with the lane identity
    and trailers.

### 2026-11-07 · VS-43a review fixes

Six review findings, two of them blocking. All six were fixed, two of them
by the finding's own second option (noted below). Only core
`review/citation.ts`, `test/review/citation.test.ts` and
`review/model-evidence.ts` (the pin) changed, with this log. No runner,
provider, LLM or posting file and no file @vector owns changed. Nothing is
committed. Where these points differ from the entry above, they supersede it.

- **Hard-wrapped lines are one line (blocking).** Taken. The probe's two
  cases, "log access tokens." out of "- Never\n  log access tokens." and
  "skip tests." out of "- Do not\n  skip tests.", are now `misquote`.
  - **Folding.** `normalizedLines` is now `logicalLines`, which folds
    physical lines into logical ones before any `TrustedText` is built. It
    is used for the sent text, the full text, the added runs and the quote.
  - **What continues a line.** A line continues the one before it when it is
    not blank, outside a fence, and follows a paragraph or list item line. A
    line that starts a block never continues. The finding names four such
    starts: a list item, a heading, a fence and a deeper blockquote. Three
    more are added, because Markdown starts a block there too and folding
    them would fail rule lines closed:
    - a thematic break or setext underline (`---`, `***`, `===`);
    - a table row (a line starting with `|`);
    - for numbered items, CommonMark's rule. `1.` always starts an item. Any
      other number starts one only left of the text of the line it follows,
      as a sibling (`2.` after `1. a`, or after its nested bullet). So
      "- Keep retries at most\n  3. Never retry forever." stays one line,
      and "Never retry forever." alone is a `misquote`.
  - **Blockquotes.** A line at the same or a lower depth continues a
    blockquote, the lower one being Markdown's lazy continuation.
  - **Text.** Pieces are joined with single spaces. A continuation has only
    its blockquote marks stripped, since it starts no list item or heading.
  - **Flags.** A logical line is a rule line when its joined text holds a
    letter or a digit, and is whole only when every physical line in it was
    sent whole. A wrapped bullet whose later lines lie past the clip is not
    whole.
  - **The quote** is folded the same way, so a model may copy the wrap.
  - **Tests.**
    - The wrapped bullet is cited when quoted wrapped, on one line or with an
      unindented continuation. Its continuation alone, and its first line
      alone, are misquotes. The same holds for a wrapped paragraph and a
      wrapped blockquote.
    - A numbered continuation, and a line whose first physical line holds no
      letter, are covered.
    - A second test pins each block start: siblings, a nested bullet, a
      nested `1.`, a lazy continuation, a heading, `***`, table rows and a
      deeper blockquote.
    - A wrapped bullet the clip cuts mid-item is `clipped`, whether the cut
      is inside its second line or exactly where that line starts. Both cuts
      are pinned against `buildReviewPrompt`.
  - **One existing test changed.** The no-letter clip case now puts `----
    more` after a blank line. Otherwise it would fold into the bullet above
    it, and the test would no longer reach the letter guard at the clip.
- **head-added only from files that can carry rules.** Taken as the first
  option: `trusted.added` holds only the added runs of `RULE_FILES`. Those
  are:
  - `AGENTS.md` and `CLAUDE.md` at any depth, for VS-48's scoped files;
  - `.vector/RULES.md`, which `baseInstructions` also reads into the
    instructions block (the finding's list left it out);
  - `REVIEW_RULES_PATHS` (`.vector/review.md`, `.vector/REVIEW.md`);
  - `REVIEW_CONFIG_PATH` (`.vector/review.json`).

  VS-48 adds its scoped paths when it lands. A quote of the change's own code
  (`return eval(input)`, or README's `More words.`) is now `misquote`.
  Tests cover a nested `CLAUDE.md`, `.vector/RULES.md`, `.vector/REVIEW.md`,
  `docs/rules.md`, `NOTAGENTS.md`, and a wrapped rule added to `AGENTS.md`,
  which is head-added only when quoted whole.
- **Single-use helpers.** `inScope` is inlined at its one call site.
  `normalizedQuote` is inlined too: the quote is now read by `logicalLines`,
  with a comment. `candidatesOf` and `rulesParts` stay, as the finding
  allows.
- **Linear time (blocking).** Taken, and made stronger than the finding asks.
  - **Why stronger.** The finding's bounded end search still costs one
    comparison of up to 1,000 characters per line when every line holds the
    quote but no span qualifies, such as headings or lines in a fence.
  - **What `coverage` does now.** It builds, once per call, maps from line
    start and line end to line index, and prefix counts of rule and example
    lines. It finds occurrences with Knuth-Morris-Pratt (`occurs`), which is
    linear in the text and the quote. Each occurrence is checked in constant
    time, and the scan stops at the first that qualifies. `cut` is read from
    the text's end, since only the last line sent can be cut. The
    `trusted.added` `.some` already stopped at the first `whole`.
  - **Measured** through the lock (`/tmp/vector-vectorscope/vs43a-fix/
    bench.ts`, the review's case moved to `AGENTS.md`, since `x.md` is no
    longer read). One check takes:

    | Added lines | `- x`, quote `x` | `# x`, quote `x` | `# x`, a 997-character quote |
    |---|---|---|---|
    | 20,000 | 8.6 ms | 7.2 ms | 8.2 ms |
    | 200,000 | 89 ms | 101 ms | 101 ms |

    The review measured 451 ms at 20,000 lines and extrapolated about 45 s
    at 200,000.
  - **Tests.** A `cost` block parses 50,000 identical added lines in
    `AGENTS.md` and wraps each added run's `lines` in a Proxy that counts
    index reads. It throws past 8 reads a line, so a regression fails at
    once instead of at the timeout. The test runs one-word quote `x` on rule
    lines (stops at the first match, `head-added`) and on headings (every
    occurrence tried, `misquote`). A new overlap case ("Retry. Retry."
    across two lines, then whole on the second) pins the KMP border logic.
- **review.json rules added by the change (hand-off).** Taken as the first
  option, recorded here, and pinned by a test. Added lines are read as
  Markdown, so a rule a change adds as a review.json `paths` string reads as
  `misquote`, not `head-added`. The citation still fails, so I-2 holds. But
  Phase A's head-added count misses JSON-sourced rules unless VS-43 wiring
  also compares against the head review.json's parsed `paths` instructions
  when review.json is in the diff.
- **A quote may not run into a fenced example.** Taken as the first option,
  with a test change.
  - **The rule.** `TrustedLine` gains `example` (a fence, or a line in a
    fenced block), and a span is whole only when it holds no example line.
    "Prefer early returns.\n```ts\n// Bad", which the old test expected to
    be cited, is now `misquote`. So are the rule plus its opening fence, and
    an example's last line running out into the next bullet.
  - **Still cited.** A heading with the line under it.
  - **Hand-off.** A cited span is trusted rule lines only, equal to the
    quote apart from whitespace and list, heading and blockquote markers. So
    wiring may render either the quote or the span's trusted text; the
    latter keeps the markers.
- **Residual Markdown differences**, each failing closed or unchanged from
  the entry above:
  - a setext heading's text still counts as a rule line;
  - indented code and a blockquoted fence are not examples;
  - a table's later row without a leading `|` stands alone;
  - a block that `logicalLines` folds but Markdown splits (an HTML block, say)
    needs the whole folded line quoted.
- **Off by default (I-1).** Nothing calls `citation.ts`. The only importers
  are core's `citation.test.ts` and `model-evidence.test.ts` (the pin). The
  prompt and policy digests read no file this round changed.
- **Pin (I-12).** `REVIEW_PIPELINE_SOURCES` moves from `9d2557d711675fbd` to
  `c8568097f8a427b4`, because `citation.ts` changed.
  `REVIEW_PIPELINE_REVISION` stays 1.
- **Evidence.** Each file was run alone through the lock with `--timeout
  30000`, from `packages/core`.
  - **Counts.** core `citation.test.ts` 26 → 33; `model-evidence.test.ts`
    24 → 24.
  - **Typecheck.** `bun typecheck` passes in core.
  - **Lint.** prettier is clean on both changed files, and oxlint reports 0
    warnings. Three test lines over 120 columns remain, two string literals
    and a test name that prettier leaves alone; all three predate this round.
  - **Mutations.** 22 mutations were each applied alone to `citation.ts` and
    run against `citation.test.ts`, and the file was restored byte for byte
    (checked by hash). All 22 were caught:
    - folding off;
    - bullets continuing a line;
    - `1.` continuing;
    - a sibling number continuing;
    - every number starting a block;
    - no depth check;
    - table rows continuing;
    - thematic breaks continuing;
    - the rule flag not recomputed;
    - continuations stripped as first lines;
    - sent lines always whole;
    - examples allowed in a span;
    - no rule line required;
    - `cut` never reported;
    - KMP resetting after a match;
    - a zero border table;
    - added runs from every file;
    - rule file names matched only at the root;
    - rule paths not matched;
    - the quote not folded;
    - the old quadratic end search (caught by the Proxy bound);
    - scope ignoring globs.
  - **Not run.** The engine and app runner suites were not re-run: nothing
    they import changed. The full root typecheck was not run, since nothing
    is pushed.

## 2026-11-07 · VS-44a Verification certificate schema and checker (pure)

Addendum A §2 VS-44 (its Now part only: "the schema and `certified()`"),
with the §1 `verifyEvidence` row ("policy key; effective only with
`guardrail: strict`", "existing"), §1's rule that a key effective only
under strict is ignored with a note and a test, §1a's VS-44 row
(`engine:verify-cert`, "As VS-42"), §3 VS-27 (certificate evidence attached
to the matching finding, never a separate comment; the S1 certificate joins
only after its gate) and VS-31 (VS-44 joins `precise` only after its gate),
and §4's windows. Evidence: round-two REPORT [GP3] (Greptile merges its
verified evidence into the review comment at the same location, as
`verifiedEvidence`) and [GU8] (Archer reports only findings with a proof of
concept; §3 VS-29 asks a cross-family verifier to show its work through
VS-44). Built at `cd0903b5` (VS-43a). The addendum's citations at
`7cadfcb8` were re-located on HEAD: `VERIFY_JSON_SCHEMA` is at
`schema.ts:115-132` (addendum: `:92`) and `decodeVerify` at `:400-429`; the
verifier reads the body and suggestion through `prompt.ts` `candidate()`
`:610-622` and `buildVerifyPrompt` `:246-271` (addendum: `:465-477`); the
runners decode verify at `run.ts:772-782` (`schema: VERIFY_JSON_SCHEMA`,
`decode: decodeVerify`) and `ai-review.ts:128` (`VERIFY_FORMAT`) and
`:1567`. Now window only: pure core code and a parsed, unapplied key, which
nothing calls or reads. `run.ts`, `ai-review.ts`, `provider.ts`,
`session/llm.ts`, `posting.ts`, `prompt.ts`, `select.ts`, `plan.ts`,
`replay.ts`, `report.ts` and every @vector file are untouched. It implements
the VS-44a plan as corrected by its critique: all eight critique points were
taken, two of them by their stated alternative (noted at (d) and (f)).
Nothing is committed (the lane brief). An earlier run of this step was
stopped by a container restart before it wrote this entry; its working-tree
edits were kept, read against the plan and critique, corrected where needed
(two test typings, below) and every check was run again on the finished
tree.

- **What landed.**
  - **Core `review/types.ts`** (still import-free): after the `RuleCitation`
    block, `CERTIFICATE_VERDICTS` (`confirmed`, `rejected`, `unsure`) and
    `CertificateVerdict`; `CERTIFICATE_REACH` (`caller-shown`,
    `entry-point`, `assumed`) and `CertificateReach`; `VerifyCertificate`
    (`id`, `verdict`, `reason`, `trace?`, `traceUnreadable?: true`,
    `guards`, `noGuards?`, `reach?`); and `CertificateEvidence` (`trace`,
    `guards`, `reach` other than `assumed`), what wiring attaches to a
    `StrictFinding` [GP3]. `ReviewConfig.verifyEvidence?: "off" |
    "certificate"`, after `scopeGate`; `OPTIONAL_REVIEW_DEFAULTS.verifyEvidence
    = "off"`; `UNAPPLIED_REVIEW_KEYS` gains `verifyEvidence` after
    `scopeGate`. Comments only on `Quote` (the trace and guards reuse it)
    and `STRICT_DROPS` (VS-44's two drops join with wiring).
  - **Core `review/config.ts`**: `FIELDS.verifyEvidence =
    oneOf(["off", "certificate"])`, no `ENV` entry. Under strict the
    `UNAPPLIED` warning reads `"verifyEvidence": "certificate" is not
    applied yet: verify verdicts are still read without a certificate.`;
    without strict, `settle` adds `"verifyEvidence": "certificate" is
    ignored without "guardrail": "strict": certificate-backed verification
    runs only inside the strict guardrail.` and keeps the value as written.
    A plain key, not source-tagged (§1: "existing").
  - **Core `review/schema.ts`**: `StrictSchemaKeys` gains `verifyEvidence`;
    `MAX_TRACE_QUOTES = MAX_FINDING_QUOTES` (6); `verifyCertJsonSchema(keys)`,
    undefined unless `guardrail: "strict"` and `verifyEvidence:
    "certificate"`, built from `structuredClone(VERIFY_JSON_SCHEMA)` with
    spreads (the VS-27a pattern): the result's `verdict` enum becomes the
    three verdicts, and `trace`, `guards`, `noGuards` and `reach` are added
    in that order. And `decodeVerifyCertificates(input)`, uncalled, in
    `decodeVerify`'s shape (it drops into `decode:` at `run.ts:782`), with a
    private `decodeTrace`. `decodeVerify`, `decodeReport`,
    `strictReportJsonSchema` and `strictResultJsonSchema` are unchanged; the
    last one's comment says VS-44's drops and certificate field join with
    wiring.
  - **Core `review/guardrail.ts`** (pinned, pure): `certified(finding,
    certificate, { anchors, blobs })`, `CERTIFICATE_MISMATCHES` (`id`,
    `no-trace`, `trace-unreadable`, `trace`, `unanchored`, `reach`) and
    `CertificateMismatch`, `CertificateDrop` (`verdict-unsure`,
    `certificate-mismatch`, typed only), `CertificateCheck`, and
    `certificateBlobRequests(findings, certificates, anchors)`. The body is
    a private `certify(finding, certificate, context)` over a
    `CertificateContext` (`index`, `anchors`, `read`), with private
    `usableTrace`, `certificateQuotes`, `readQuote` and `anchored`. It
    reuses `blobKey`, `lineReader`, `matchAt`, `trimQuote`, `lookupFile`,
    `resolveAnchor` and diff.ts `touched` (I-10). The header and the
    `quoteMatches` comment name it. strictSelect, strictCandidates,
    strictRules, strictBlobRequests and every existing export are unchanged.
  - **Core `review/model-evidence.ts`**: `EVIDENCE_POLICY_KEYS` gains
    `verifyEvidence` after `scopeGate`, with a comment (counted from VS-44
    wiring on, and then only as `certificate` under strict).
    `promptsDigest` takes `verifyEvidence`, joins
    `verifyEvidence:certificate` to the memo key only under strict, and
    appends `verifyCertJsonSchema(keys)` after the two strict schemas.
    `evidenceScope` passes `verifyEvidence: "certificate"` only when strict
    and the key are both set and neither is in `UNAPPLIED_REVIEW_KEYS`.
    `canonicalPrompts` is unchanged. `REVIEW_PIPELINE_SOURCES` moves from
    `c8568097f8a427b4` to `53dfe88102cb2a49` (guardrail.ts changed);
    `REVIEW_PIPELINE_REVISION` stays 1, since nothing a runner finds or
    posts changes.
  - **Engine `review/eval.ts`** (the eval replay, not a runner):
    `WIRING.verifyEvidence = "VS-44 wiring"` (the `Record` over
    `UNAPPLIED_REVIEW_KEYS` requires it) and the `ReplayInput.config`
    comment. The replay's drop of unapplied keys and step 0b's refusal are
    generic, so nothing else changed.
  - **Tests**: core `schema.test.ts` 54 → 64 (the schema's existence,
    shape, independence, keyword set and conformance; the decoder's
    verdicts, containers, trace, pathless quotes, guards, `noGuards` and
    `reach`); core `guardrail.test.ts` 44 → 59 (13 `certified` cases, a
    `certificateBlobRequests` parity case and a 400-case property test);
    core `config.test.ts` 55 → 59; core `model-evidence.test.ts` 24 → 26;
    engine `eval.test.ts` 30 → 31 (a replay of a base review.json that sets
    the key, with and without strict, plus refusal cases in the existing
    test). Changed on purpose: config.test.ts's `OPTIONAL_REVIEW_DEFAULTS`
    equality gains `verifyEvidence: "off"`; model-evidence.test.ts's "no
    others" policy list gains three cases; the pin. No existing assertion
    was loosened.
- **How `certified()` decides**, in order:
  1. **Id.** A certificate for another id is `certificate-mismatch` with
     `["id"]` alone, and reads no file.
  2. **Verdict.** `rejected` is `unverified` and `unsure` is
     `verdict-unsure`; neither reads a file. Only `confirmed` goes on.
  3. **Trace.** Usable when it holds 1 to `MAX_TRACE_QUOTES` quotes;
     otherwise `no-trace`, or `trace-unreadable` when the decoder marked it,
     and no trace or guard file is read. Each usable quote is read at its
     `blobKey` (a diff path at head, a renamed file's old path at base, a
     path outside the diff as written; path `""` is the finding's file)
     through a per-call `lineReader`, and matched with `matchAt` (S4's
     body: whitespace and CRLF forgiven, a quote with no letter or digit
     matching nothing, LEFT against base). One unmatched quote gives
     `trace`.
  4. **Anchoring.** Some trace quote that matched, or whose file could not
     be read, spans (after `trimQuote`) a RIGHT line that `touched(anchors,
     path, line, 0)` holds for, a LEFT line the change removed, or a line on
     the finding's anchor as `resolveAnchor` places it: the same side, the
     same diff file, between `startLine ?? line` and `line`. Otherwise
     `unanchored`.
  5. **Reach.** `caller-shown` or `entry-point`; `assumed` or absent gives
     `reach`.
  6. **Result.** With no reason: `{ certified: true, trace, guards, reach }`,
     the trace whole at its read paths and the guards that matched among the
     first `MAX_FINDING_QUOTES`, in input order. Otherwise
     `certificate-mismatch` with every failing reason, in
     `CERTIFICATE_MISMATCHES` order, and `blobUnreadable`, which holds only
     when the reasons are exactly `["trace"]` and every unmatched trace
     quote's file is null or missing from the map.
- **Off by default (I-1, I-12).**
  - **The key.** Optional, absent from `DEFAULT_REVIEW_CONFIG`, in
    `UNAPPLIED_REVIEW_KEYS`, read from no environment variable (a test
    sets `REVIEW_VERIFY_EVIDENCE` and `REVIEW_VERIFYEVIDENCE` and sees no
    change). The parser only warns. `policyDigest` reads it as absent, with
    or without strict, and `evidenceScope` never passes it.
  - **Nothing calls the new code.** A grep over `packages/engine/src`,
    `packages/app/src`, `packages/desktop/src`, `packages/web/src` and
    `script` finds none of `certified(`, `certificateBlobRequests`,
    `decodeVerifyCertificates`, `verifyCertJsonSchema`, the new constants or
    types, or `verifyEvidence`, except eval.ts's `WIRING` entry and its
    comment.
  - **Digests** (printed at HEAD and on the finished tree, all held):
    `promptsDigest()` `5d59e9ee06077c23`; `{ impact: "graph" }`
    `74a2111826c226b1`; `{ guardrail: "strict" }` `b98afb0e878dfe26`; with
    `impact: "graph"` `3ba21b5bc883cd70`; `{ guardrail: "strict",
    scopeGate: "introduced" }` `4aa712221043a3a7`; with `impact: "graph"`
    `8335adf9de513ee5`; `{ verifyEvidence: "certificate" }` and
    `{ guardrail: "strict", verifyEvidence: "off" }` equal `{}` and strict;
    `policyDigest(DEFAULT_REVIEW_CONFIG)` `70512122f41ec160`, also with
    strict and the key. Three new schema-only digests are pinned in
    model-evidence.test.ts, each moving only under both keys: `{ guardrail:
    "strict", verifyEvidence: "certificate" }` `d209592d08bb1e0c`; with
    `impact: "graph"` `468fcac8cde18fe2`; with `scopeGate: "introduced"`
    `0f3ff2dd0f7c1d7d`. VS-44 wiring moves them on purpose (the blind
    candidate, the prompt and the result schema's drops, under the key).
  - **The replay.** A base review.json that sets the key, with or without
    strict, is replayed and recorded without it (and without the
    guardrail), keeping the parser's warnings; the verify request carries
    the legacy schema (no `trace`, `guards`, `noGuards`, `reach` or
    `unsure`), a certificate sent anyway changes nothing, and the scope
    claims neither the policy nor the certificate schema. `ReplayInput.config`
    refuses the key, alone and beside the guardrail and `scopeGate`.
  - **Runner suites** pass with unchanged counts (table below).
  - **§0.3 items 4 and 5.** The variant `engine:verify-cert` and the desktop
    half wait for VS-44 wiring: no registry, README, `replay.test.ts` or
    `ai-review.ts` change.
- **Decisions.**
  - (a) **The key is typed and parsed now.** §4's Now entry names no config
    parse for VS-44 and puts no parse in the runner-wiring window either
    (unlike VS-43, whose parse §4 places in runner-wiring, VS-43a decision
    (a)), as for VS-42 (VS-42a decision (a)); §1's ignored-with-a-note test
    needs a parsed key, and the lane brief allows config additions that are
    off by default. It is unapplied, so either answer to Q18 stays open.
  - (b) **Builder form.** The addendum names a constant,
    `VERIFY_CERT_JSON_SCHEMA`; the round-two amendment and the lane brief
    ask for VS-27a's key-conditional builders, so the schema enters
    `promptsDigest` only under both keys. It is a deep copy, so no object is
    shared with the legacy schema or another call (tested by mutating one).
  - (c) **A separate decoder.** `decodeVerify` stays byte-identical (I-1):
    it still drops `unsure`, which leaves the id unanswered and so
    `verdict-unreadable` (tested on one answer through both decoders).
    `decodeVerifyCertificates` reads verdicts by prefix (`confirm`,
    `reject`, `unsure`); any other verdict drops the result, so its id stays
    unanswered and still fails closed. Results sharing an id are all kept;
    what conflicting ones mean is wiring's to decide.
  - (d) **The trace is whole or absent** (critique point 2, taken). The
    decoder keeps a trace only when it is 1 to 6 entries that all decode
    through `decodeQuote`; it never cuts one, since part of a trace is not a
    path from the trigger to the failure. A non-empty array it cannot keep
    (a bad line, an escaping path, empty or over-cap code, a string entry,
    more than 6 entries) sets `traceUnreadable`, and `certified()` reports
    it as `trace-unreadable`, between `no-trace` and `trace`. So the kill
    criterion's `certificate-mismatch` count can separate format failures
    from missing evidence, as `severityUnreadable` (VS-27a hand-off (d),
    built in VS-27b) does for severity. `certified()` also enforces the
    length cap, for certificates
    built without the decoder, and reads no file for an unusable trace
    (critique point 4).
  - (e) **Guards never veto, and are capped.** Only the first
    `MAX_FINDING_QUOTES` are read (the decoder keeps at most that many of
    its first `MAX_QUOTES_READ` entries), and only when the trace is usable;
    unmatched, unreadable or escaping guards are left out of the evidence.
    `certified`, `drop`, `because` and `blobUnreadable` never depend on the
    guards, their order or whether there are any; the returned guards are
    the matched ones in input order (critique point 5, the property now says
    exactly that). `noGuards` and `reason` are decoded and never attached.
  - (f) **"Lies in a changed hunk or on the anchor"** is read as touching a
    change, or inside the resolved anchor (critique major point, taken). A
    RIGHT line touches a change when `touched` holds with radius 0 (an added
    line, or one next to a deletion; a whole added or deleted file), a LEFT
    line when the change removed it. So the reading does not depend on the
    diff's context width; the alternative, any line inside a hunk's range,
    would count context lines and widen with `-U`. "On the anchor" uses
    `resolveAnchor`'s anchor, never the model's own `line..endLine`: a range
    across hunks anchors on its end line only, and a snapped RIGHT anchor is
    the line it snapped to. So a finding at 10..200 where only line 200
    changed gives `unanchored` for a trace of unchanged line 50 (tests: a
    cross-hunk range, a single-hunk range whose context lines count, a
    snapped anchor, side and file mismatches; the property asserts every
    certified trace has a quote that touches a change or lies in the
    resolved anchor's span). Two further readings, named so the owner can
    reverse them (critique point 6, taken by its alternative): **guards
    never anchor** a trace, only trace quotes do; and `unanchored` is worked
    out over the trace quotes that matched or whose file could not be read,
    so an invented quote on a changed line shows both `trace` and
    `unanchored` and cannot hide that the rest of the trace is unchanged
    code.
  - (g) **Unreadable files fail closed (I-7).** `blobUnreadable` (the plan
    called it `unreadable`; renamed to say which drop wiring maps it to)
    holds only when a read the engine could not make is all that stands
    between the certificate and verified: the reasons are exactly
    `["trace"]`, and every unmatched trace quote is on a file that is null
    or missing from the map. An unreadable quote still counts for
    anchoring, so a quote on an added line whose file was not read leaves
    only `trace`. A file the tree lacks, or a path that could leave the
    repository (read as absent, never requested), is a plain mismatch.
  - (h) **No `STRICT_DROPS` change and no strictSelect integration.**
    §4's Now entry for VS-44 names "schema and checker" only (VS-42's names
    "the strict drop"); how an `unsure` verdict flows depends on how the
    runner builds its verdict maps (plan.ts `Verdicts` holds only confirmed
    and rejected, and legacy selection drops rejected findings before
    strictSelect sees them), a VS-27c/VS-44-wiring decision; and the
    strictSelect property test requires every `STRICT_DROPS` value to
    occur, so the drops can join only together with strictSelect producing
    them. `CertificateDrop` names them, typed only. The integration is pure
    core, so it could land before wiring as a VS-44b if the orchestrator
    asks.
  - (i) **Reach is an unchecked label that can only veto** (critique point
    7, recorded). `assumed`, or a reach the decoder could not read (read
    leniently: case, spaces or underscores for hyphens), blocks
    certification; `caller-shown` and `entry-point` only permit it. The
    schema's description says `caller-shown` means "the trace quotes a
    caller that reaches it", and nothing checks that. A structural check (a
    trace quote outside the anchor's file or function) is handed to wiring
    as an option after the I-13 freeze; the description stays untuned
    text.
  - (j) **The id check.** `certified()` takes the pair separately, so a
    certificate for another finding is a mismatch on `id` alone, ending the
    check before any read.
  - (k) **The `required` list stays legacy** (`id`, `verdict`, `reason`):
    fixed claims are answered in the same results, and a rejected verdict
    needs no trace. The caps are in the descriptions, with no `minItems` or
    `maxItems` (VS-27a decision (l)): a test asserts the schema sends no
    keyword the legacy verify and report schemas do not already send.
    `noGuards` has `maxLength` 400, which the report schema already sends.
  - (l) **Schema text is untuned** model-facing text; tuning waits for the
    held-out freeze (I-13).
  - (m) **A quote with no path is the finding's file** (critique point 3,
    its first option). The decoder keeps `decodeQuote(entry, "")`'s path
    `""`, as `decodeReport`'s strict path treats a pathless quote as the
    finding's file; `certified()` and `certificateBlobRequests` put
    `finding.path` in its place before `blobKey`, so the requests take the
    findings and pair each certificate with each finding of its id. The
    cost: the decoder does not know the file, so a pathless quote of a
    Markdown file loses a fence around it (`decodeQuote`'s `keepFence`
    reads the path), and such a quote then fails as `trace`.
  - (n) **A shared-context body** (critique point 8, taken). `certified()`
    builds its own index and reader, as `preExistingSuspect` does; its body
    `certify()` takes a `CertificateContext`, so wiring can check every
    certificate of a run through strictCandidates' one cached reader
    without splitting a file again per certificate.
  - (o) **Reads equal requests.** `certificateBlobRequests` names exactly
    what `certified()` reads for each finding paired with a certificate of
    its id: nothing for a non-confirmed verdict or an unusable trace;
    otherwise each trace quote and the first `MAX_FINDING_QUOTES` guards, on
    their own sides, escaping paths excluded, unique and sorted. A recording
    blob map checks equality in a parity test and in each of the 400
    generated cases, so over-requesting fails as well as under-requesting.
    Containment against the tree-ish stays the engine's (I-8).
  - (p) **Not checked**, by design at this stage: the trace's order
    ("from the trigger to the failure" is model-facing only) and repeated
    trace quotes.
- **Corrections to the interrupted run's edits.** Two schema-test typings
  failed `bun typecheck` in core: a test pushed `"maybe"` into the copied
  verdict enum (now `"unsure"`, which the legacy enum never holds, so a
  shared array would still show), and the reach table lacked `as const`.
  Neither changed what is tested. Everything else matched the plan as
  corrected by the critique and was kept.
- **Hand-offs to VS-44 wiring (runner-wiring window, with VS-27c; Q13,
  Q18).**
  - **Blind candidate and prompt.** The verifier sees id, path, line, side,
    severity, the strict `failure` fields and the evidence path:line list,
    without body or suggestion; the certificate clauses. Both enter
    `canonicalPrompts` and `promptsDigest` only under both keys.
  - **S1 under both keys.** `verdict-unsure` and `certificate-mismatch`
    join `STRICT_DROPS` after `verdict-unreadable`, and the result schema's
    enum only under the key; `StrictInput.certificates`; `blobUnreadable`
    mapped to `blob-unreadable` (incomplete); `strictBlobRequests` merging
    `certificateBlobRequests`; `certify()` called through strictCandidates'
    reader; the strictSelect property test gains the dimension.
  - **Attachment [GP3].** `StrictFinding.certificate?: CertificateEvidence`
    in the result schema under the key, never posted as a separate comment.
  - **Verdict maps.** Mapping certificate verdicts onto `verifyUnanswered`
    and the runner's verdict map: `unsure` is read, not unanswered;
    `rejected` is `unverified`; conflicting results for one id fail closed;
    fixed claims keep the legacy reading. Counting `trace-unreadable` and
    the other reasons by kind for the kill criterion.
  - **Composition.** VS-42's S9 reading certified trace quotes beside
    S4's (`preExistingSuspect` (c) to (e)); VS-29a; VS-40's estimate of
    the extra output tokens (I-5).
  - **Variant and desktop.** `engine:verify-cert` and its D3 parity tests;
    the desktop half "As VS-42" (a documented difference,
    `variant.applied: false`) until VS-27's desktop guardrail.
  - **Digests and reports.** `policyDigest` counting the key only as
    `certificate` under strict, once applied; report.ts's `--reselect`
    sources line naming the certificate check as left out (an artifact
    records no certificates), with its README and test.
  - **Reads.** The engine's `cat-file --batch` read with containment (the
    I-8 amendment, VS-36, Q18); the optional structural reach check in (i).
- **Deferred verification.**
  - Provider acceptance of the certificate schema in forced tool calls:
    the OpenAI sanitizer path, then fake-provider tests at wiring, then a
    paid run under D7 and Q9. None was run.
  - The fork read of a trace quote through `cat-file --batch` within the
    head tree-ish (an addendum test) needs the engine read, at wiring.
  - The kill pre-check (verify-confirmed false alarms under 15% of settled
    false alarms) and the Q9 funded ablation need settled artifacts, which
    do not exist yet. No model emits certificates.
  - The merge conflicts are only predicted.
- **Owner questions.** None new. Q18 (whether VS-44 is approved, with the
  I-8 amendment), Q13 (runner wiring before `self-evolving`), Q9 (the
  ablation budget) and Q3/Q4 (class-scoped recall and its classes, which
  the kill criterion's recall terms read) stay open; this package is
  neutral on them, since nothing calls it. Lane readings the owner may
  reverse with small, local changes: (e) guards capped and never vetoing,
  (f) the anchoring readings (radius-0 change or resolved anchor; guards
  never anchor; `unanchored` over matched and unreadable quotes), (i) an
  unreadable reach read as `assumed`, and (m) a pathless quote as the
  finding's file.
- **Predicted merge conflicts.** Read-only: `git merge-tree --write-tree
  --name-only` at HEAD, then a three-way `git merge-file` of each touched
  file that either branch changes, comparing the working tree with HEAD
  against each branch's merge base and tip, with fixed marker labels.
  - Of the touched files, `config.ts` and `types.ts` change on
    `origin/codium` (`5a079cbd`), and `types.ts` on `origin/self-evolving`
    (`f062bcce`). `schema.ts`, `guardrail.ts`, `model-evidence.ts`, engine
    `eval.ts` and the tests are untouched by both.
  - `config.ts`: no conflict with codium, at HEAD or with VS-44a.
  - `types.ts`: 2 conflict hunks with codium and 1 with self-evolving,
    byte-identical at HEAD and with VS-44a (the VS-27a pass-name lines). No
    new conflict hunk.
- **Evidence.** Each file was run alone through the lock with `--timeout
  30000`, from its package directory; the engine ones with fresh XDG roots
  under `/tmp/vector-vectorscope/vs44a/xdg/`. Counts are at HEAD → with
  VS-44a.

  | File | HEAD | VS-44a |
  |---|---|---|
  | core `test/review/schema.test.ts` | 54 | 64 |
  | core `test/review/guardrail.test.ts` | 44 | 59 |
  | core `test/review/config.test.ts` | 55 | 59 |
  | core `test/review/model-evidence.test.ts` | 24 | 26 |
  | core `test/review/select.test.ts` | 45 | 45 |
  | core `test/review/diff.test.ts` | 52 | 52 |
  | core `test/review/format.test.ts` | 51 | 51 |
  | core `test/review/verdict.test.ts` | 45 | 45 |
  | core `test/review/prompt.test.ts` | 36 | 36 |
  | core `test/review/trivial.test.ts` | 44 | 44 |
  | core `test/review/citation.test.ts` | 33 | 33 |
  | engine `test/review/eval.test.ts` | 30 | 31 |
  | engine `test/review/run.test.ts` | 44 | 44 |
  | engine `test/cli/github.review.test.ts` | 40 | 40 |
  | app `ai-review.test.ts` (`--preload ./happydom.ts`) | 107 | 107 |
  | eval `report.test.ts` (from `script/vectorscope-eval`) | 33 | 33 |
  | eval `replay.test.ts` (from `script/vectorscope-eval`) | 32 | 32 |

  - **Run notes.** The HEAD column was run at `cd0903b5` before any edit.
  - **Typecheck.** `bun typecheck` passes in core and engine; app and
    desktop pass `bun typecheck --force`; the eval scripts pass `bun tsgo -p
    ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`.
  - **Lint.** prettier is clean on all eleven changed files. oxlint reports
    30 warnings in them, none on an added or changed line.
  - **Mutation check.** 45 mutations, each applied alone and run against
    the named test file (the engine one with `-t` on its refusal test),
    each file restored byte for byte (checked by hash, and every changed
    file's hash compared after the run). 44 are caught; the survivor is the
    expected equivalent one.
    - In `guardrail.ts`, against `guardrail.test.ts` (26): the id check
      skipped; a rejected verdict reading its trace; the trace length cap
      skipped; the usable trace ignoring the verdict (requests name rejected
      quotes); the anchor ignoring side; ignoring file; the anchor taken
      from the model's own range; `unanchored` skipped; `unanchored` over
      unmatched quotes too; guards anchoring a trace; `assumed` accepted; an
      absent reach accepted; `blobUnreadable` with another reason; with an
      absent file; guards vetoing; the guard cap removed in `certified()`;
      and in the requests; unmatched guards kept; path `""` not the
      finding's file in `certified()`; and in the requests;
      `trace-unreadable` folded into `no-trace`; an unusable trace read;
      `touched` with radius 5; removed lines not a change; the matcher
      skipped; a quote read at its path as written (no rename).
    - In `schema.ts`, against `schema.test.ts` (9): the builder ignoring
      strict; ignoring its key; sharing the legacy verdict object; the
      decoder keeping a partial trace; cutting a long one; never marking one
      unreadable; accepting an unknown verdict; cutting a long `noGuards`;
      the guard cap removed.
    - In `model-evidence.ts`, against `model-evidence.test.ts` (5): the
      memo key without `verifyEvidence`; the certificate schema left out of
      the digest; placed before the strict schemas; `verifyEvidence` not a
      policy key. Survived, as expected: `evidenceScope` passing the key
      while it is unapplied. It is equivalent by construction, as in
      VS-42a: the guardrail is unapplied too, so the scope never passes
      strict, and `promptsDigest` ignores the key without it.
    - In `config.ts` and `types.ts`, against `config.test.ts` (4): the
      ignored note missing; the not-applied warning without strict; the
      default `certificate`; the key left off `UNAPPLIED_REVIEW_KEYS`.
    - In engine `eval.ts`, against `eval.test.ts` (1): `WIRING` naming
      VS-42 wiring.
  - **Not run.** The full root typecheck was not run, since nothing is
    pushed.
  - **Not done.** Nothing was sent to a model; there was no paid run, no
    workflow dispatched, nothing published and nothing committed; no
    user-visible string changed (D14).
  - **Commit (when the orchestrator asks).** `feat(review): VS-44a
    verification certificate schema and checker`, staging the explicit
    paths, with the lane identity and trailers.

### 2026-11-07 · VS-44a review fixes

Eight review findings, none blocking. Five were fixed in code, one of them
a little wider than the finding asks (below). The other three asked for no
change now; they are recorded here as hand-offs to VS-44 wiring. Only core
`review/guardrail.ts`, `review/schema.ts`, `review/types.ts` (one comment),
`review/model-evidence.ts` (the pin), `test/review/guardrail.test.ts` and
`test/review/schema.test.ts` changed, with this log. No runner, provider,
LLM or posting file, no prompt and no file @vector owns changed. Nothing is
committed. Where these points differ from the entry above, they supersede it.

- **`blobUnreadable` only when the read is all that is missing.** Taken.
  - **The bug.** A trace quote that could never match, such as a lone `}`
    (no letter or digit, which the matcher always rejects), on a file that
    was null or missing from the map set `blobUnreadable`. Wiring maps that
    to `blob-unreadable`, so a model could turn a plain mismatch into an
    incomplete review by quoting punctuation in a file the engine did not
    read.
  - **The fix.** A new private `matchable(quote)` holds the matcher's own
    preconditions: `trimQuote` leaves a line, the line is a whole number
    from 1, and the code has a letter or digit (`/[\p{L}\p{N}]/u`). `matchAt`
    now calls it, so the matcher and the new check cannot drift apart.
    `matchAt` behaves as before: whitespace is never a letter or digit, so
    testing the trimmed code is the same as testing its bare form, and the
    earlier length check also returned false. An unmatched step now counts
    as "only the read is missing" (`pending`) only when its file is
    unreadable and `matchable` holds. `blobUnreadable` needs every unmatched
    step to be pending.
  - **Wider than the finding.** Anchoring uses the same test. A quote whose
    file could not be read used to anchor a trace whatever it held. It now
    anchors only when it is pending. Decision (f) let an unreadable quote
    anchor because it might have matched if read, and a quote that can match
    nothing never could. So a lone `}` on token.ts's added line, with
    token.ts unreadable, now gives `["trace", "unanchored"]`, not
    `["trace"]`. Both are `certificate-mismatch` with `blobUnreadable`
    false; the kill criterion just counts it by its real kind. The owner may
    reverse this alone, with a one-line change.
  - **Tests.** In `guardrail.test.ts`, the `blobUnreadable` test gains a `}`
    quote, a whitespace-only quote and a line-0 quote on a null `store.ts`,
    each a plain mismatch. The anchoring test gains the `}` on token.ts's
    added line. The property pool gains a `}` on `store.ts` (outside the
    diff) and one on token.ts head line 1 (changed); both files can be null.
- **A trace that is not a list is a format failure.** Taken.
  `decodeTrace` returns no trace only for undefined, null, an empty list or
  a blank text. Any other value that is not a list sets `traceUnreadable`:
  one quote object, a non-blank text such as `"src/a.ts:3"` or `"none"`, a
  number or a boolean. So decision (d)'s split between format failures and
  missing traces now holds for these too. The schema test that pinned the
  old reading now pins this one. The decoder's comment and the
  `VerifyCertificate.traceUnreadable` comment say so.
- **One envelope reader for both verify decoders.** Taken. A private
  `verifyEntries(input, verdicts)` holds the shared envelope handling: the
  `extractJson` predicate, unwrapping a list or `{ results }`, and the
  id/verdict prefix test. `decodeVerify` passes `/^(confirm|reject)/` and
  `decodeVerifyCertificates` passes `/^(confirm|reject|unsure)/`. Neither
  pattern has the g flag, so `test` keeps no state between calls.
  `decodeVerify` behaves exactly as before (I-1). Its existing tests pass
  unchanged, and so do the engine and app runner suites that decode verify
  through it. A new assertion pins the only difference between the two:
  text whose only results are `unsure` is no answer to `decodeVerify`
  (`undefined`) and one result to the certificate decoder. Decision (c)'s
  "`decodeVerify` stays byte-identical" now means its behaviour; its code
  calls the shared reader.
- **Reads equal requests by construction.** Taken as the first option.
  `certify()` reads `certificateQuotes(certificate)`, the same list
  `certificateBlobRequests` names. It splits the list by the usable trace's
  length: the first part is the trace steps, the rest the guards. The
  separate `slice(0, MAX_FINDING_QUOTES)` in `certify()` is gone, and
  `certificateQuotes` now has two callers. The parity test and the
  property's parity check still pass. A mutation that moved the split point
  by one was caught by five tests.
  - **Helpers kept, with reasons.** `anchored` and `decodeTrace` stay single
    use. Each names a concept the contract states: "lies in a changed hunk
    or on the anchor", and a trace kept "whole or not at all". Each keeps
    the main function on its happy path, which AGENTS.md's Complex Logic
    section asks for. Inlining `anchored` would put ten lines of side, file
    and span tests inside the `because` filter.
- **The property test's oracle no longer copies the checker.** Taken as the
  table option.
  - **Where a quote is read.** `keyOf`, which copied `blobKey` through
    `lookupFile`, is replaced by `read`. It is written from the fixture by
    hand: a quote with no path is the finding's file, a leading `./` is
    dropped, and token.ts on the base side is read at `old-token.ts`.
  - **Anchoring.** The block that copied `anchored()` (`touched` with radius
    0, `entry.left`, the anchor span) is replaced by two hand-written
    tables. Each place carries the positions its anchor covers
    (`RIGHT src/auth/session.ts 6` to `8` for the 6..8 range, line 8 only
    for 1..8 and for the snapped line 10, none for `store.ts`). `CHANGED`
    lists the touched positions: session.ts head 2, 3 and 8, base 3; token.ts
    head 1; old-token.ts base 1. Both tables were checked once against
    `resolveAnchor` and `touched` with a scratch script
    (`/tmp/vector-vectorscope/vs44a-fix/spans.ts`), not from the test.
  - **One-line quotes.** The test asserts every pool quote is one line, so a
    quote's position is its line and no `split("\n")` or trimming is
    needed.
  - **Stronger checks.** The property was one-directional: a certified trace
    anchors. It now also checks, both ways, `unanchored` and
    `blobUnreadable` against the tables. Its `seen` set must also include
    `unmatchable-unread`, so the generator really reaches the new case.
    Read/request parity and guard independence are kept as they were: they
    compare against independent observations.
  - **What the new oracle catches alone** (each mutation run against the
    property test alone, then restored by hash): `touched` with radius 5;
    an anchor that ignores side; reading at the path as written, with no
    rename; removed lines not counted as a change; `blobUnreadable` that
    ignores `matchable`; anchoring that ignores `matchable`.
- **Context lines inside the anchor's span (reading (f)).** Kept as
  recorded, as the finding says. Hand-off to VS-44 wiring: add (f)'s reading
  to Q18's list of readings for the owner to choose. If the owner wants the
  stricter form, the anchor branch of `anchored()` should hold only when the
  anchor's span also contains a line that `touched(anchors, path, line, 0)`
  holds for. Then unchanged context inside a wide range in one hunk cannot
  anchor a trace on its own. The unit test's 6..8 range (head line 8 was
  added) would still certify a trace of lines 6 and 7; a range in one hunk
  over unchanged lines only would no longer anchor one.
- **Conflicting certificates for one id (hand-off).** No change now, as the
  finding says; the decoder still keeps every result. At VS-44 wiring:
  - several certificates for one id that disagree fail closed, as
    `certificate-mismatch` or `verdict-unreadable` (wiring decides which,
    and pins it);
  - the results are bounded to the ids sent to verify, so a long answer
    cannot grow the work;
  - a test sends two conflicting certificates for one id.

  The existing hand-off line "conflicting results for one id fail closed"
  now includes the bound and the test.
- **Reach is a label (decision (i), hand-off).** Kept as recorded. Before
  VS-44 joins `precise` (VS-31), consider decision (i)'s structural reach
  check. For `caller-shown`, it would require a matched trace quote outside
  the anchor's file, or outside its function (through `BrainCode` or
  `review/symbols.ts`, I-10, never a third reader). It needs the I-13
  freeze, as the schema text does.
- **Off by default (I-1, I-12).**
  - Nothing outside core's tests calls `certified`, `certificateBlobRequests`
    or `decodeVerifyCertificates`.
  - `matchAt` and `decodeVerify` behave as before. Their suites (select,
    citation, pipeline, guardrail's strictSelect properties, run, app
    ai-review, structured-output-review, eval report and replay) pass with
    unchanged counts.
  - The prompt and policy digests are unchanged: `model-evidence.test.ts`
    pins all of them, the three schema-only digests included, and passes.
- **Pin (I-12).** `REVIEW_PIPELINE_SOURCES` moves from `53dfe88102cb2a49` to
  `e8054845bd8f2858`, because `guardrail.ts` changed.
  `REVIEW_PIPELINE_REVISION` stays 1. `schema.ts` and `types.ts` are not
  pinned files.
- **Evidence.** Each file was run alone through the lock with `--timeout
  30000`, from its package directory; the engine ones with fresh XDG roots
  under `/tmp/vector-vectorscope/vs44a-fix/xdg/`. No test was added or
  removed. The new checks are assertions in existing tests, so the counts
  match the entry above.

  | File | Count |
  |---|---|
  | core `test/review/guardrail.test.ts` | 59 |
  | core `test/review/schema.test.ts` | 64 |
  | core `test/review/model-evidence.test.ts` | 26 |
  | core `test/review/config.test.ts` | 59 |
  | core `test/review/citation.test.ts` | 33 |
  | core `test/review/pipeline.test.ts` | 2 |
  | core `test/review/select.test.ts` | 45 |
  | core `test/review/diff.test.ts` | 52 |
  | engine `test/review/structured-output-review.test.ts` | 3 |
  | engine `test/review/run.test.ts` | 44 |
  | engine `test/review/eval.test.ts` | 31 |
  | engine `test/cli/github.review.test.ts` | 40 |
  | app `ai-review.test.ts` (`--preload ./happydom.ts`) | 107 |
  | eval `report.test.ts` (from `script/vectorscope-eval`) | 33 |
  | eval `replay.test.ts` (from `script/vectorscope-eval`) | 32 |

  - **Typecheck.** `bun typecheck` passes in core, engine and app. The eval
    scripts pass `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json`
    from `packages/engine`.
  - **Lint.** prettier is clean on the six changed source and test files.
    oxlint reports 0 warnings on `guardrail.ts`, `schema.ts` and both
    tests.
  - **Mutations.** Each was applied alone and the file restored byte for
    byte (checked by hash). All were caught.
    - Against `guardrail.test.ts`: `blobUnreadable` ignoring `matchable` (2
      tests fail); anchoring ignoring it (1); the trace/guard split moved by
      one (5); `matchable` without the letter test (5).
    - Against the property alone: the six mutations listed above.
    - Against `schema.test.ts`: `decodeVerify` accepting `unsure` in text; a
      non-list trace read as no trace; a blank text marked unreadable.
  - **Not run.** The full root typecheck was not run, since nothing is
    pushed.
  - **Not done.** Nothing was sent to a model; there was no paid run, no
    workflow dispatched, nothing published and nothing committed; no
    user-visible string changed (D14).

## 2026-11-07 · VS-28c Change-risk features and bands (core)

Contract §1.2 (`risk.ts`) and §4 VS-28 item 1 with its depth table, core
halves only, as amended by addendum A VS-39 items 1 to 3, 7 and 8 (the
round-two amendments override the brief's additive points), with §1's "no
new key for VS-36 to VS-39", §1a's VS-39 row (changes `engine:depth-auto`;
desktop follows VS-28's half), §3 VS-28 (adopt VS-39; effective depth
recorded) and §4's windows. Evidence: round-two REPORT §5 [G2-1, G2-2,
G2-7, G2-9, RP4, RP6, RP7, RP8, RP12, RP13], risk note §1, §2 and §8,
gap-2 and gap-6 §2 (G6-2: an explicit depth that cannot run fails loudly,
and the output carries the effective depth). Built at `0e4c5d1d` (VS-44a).
Now window only: a new pure core module, additive uncalled code in pinned
core files, two parsed and unapplied keys, an eval-replay `WIRING` entry
and an eval research script. Nothing calls the new code and no runner
reads the keys. It implements the VS-28c plan as corrected by its
critique: all thirteen critique points were taken, three by their stated
alternative (decisions (f), (m) and (n)); none was declined. Nothing is
committed (the lane brief).

- **Scope beyond the Now entries (critique point 2).** Contract §5 defines
  Now as "new files, `types.ts`/`config.ts` additions and eval scripts",
  and addendum §4 lists VS-39 in Now as `risk.ts` only. The brief also
  directs a pure depth planner in `plan.ts` and `buildLensPrompt` in
  `prompt.ts`, so the package extends both entries to additive, uncalled
  edits in those two pinned files (VS-25b and VS-43a set the precedent for
  `prompt.ts`). `planSpecialists` is byte-identical, and so are the review
  and security prompts: every pinned `promptsDigest` holds (below).
- **Citations re-located at `0e4c5d1d`.** `ReviewConfig` is `types.ts:381`
  (contract: `:211-283`), `OPTIONAL_REVIEW_DEFAULTS` `:502` and
  `UNAPPLIED_REVIEW_KEYS` `:518`; `config.ts` FIELDS `:160-197`, ENV
  `:206-223`, UNAPPLIED `:227-258`, `settle` `:409-468` (contract:
  `:77-222`); `plan.ts` `planSpecialists` `:53-64`; `prompt.ts`
  `PromptInput` `:52`, `SECURITY_TASK` `:165`, the builders `:238-244` and
  `build()` `:276` (contract: `:50-78,231-305`); `model-evidence.ts`
  `EVIDENCE_POLICY_KEYS` `:70-86`, `canonicalPrompts` `:363-391`,
  `promptsDigest` `:404-424`, `policyDigest` `:432-443`, `evidenceScope`
  `:446-478` (contract: `:32-74,224-258`); `select.ts` `computeRisk` `:127`
  and `selection.risk =` `:359` (contract: `:122-141`); `format.ts` "Risk:"
  `:708` (contract: `:663`). Unchanged: engine `context.ts:82-144` (5
  commits per file at `:110`) and `workflow.ts:211` (`fetch-depth: 1`).
  `model-evidence.test.ts` `REVIEW_PIPELINE_FILES` was `:42-62`; engine
  `eval.ts` `WIRING` `:1151-1158` and `ReplayInput.config` `:136-149`.
- **Untouched:** `run.ts`, `ai-review.ts`, `provider.ts`, `session/llm.ts`,
  `posting.ts`, `select.ts`, `format.ts`, `trivial.ts`, `impact.ts`,
  `dispatch.ts`, `ignore.ts`, `diff.ts`, engine `context.ts`,
  `script/vectorscope-eval/replay.ts` and `desktop.ts`, and every @vector
  file (`workflow.ts`, `command.ts`, `github.*`, `github-*.ts`, the
  GitHub sections of `vectorscope.astro`).

- **What landed.**
  - **New core `review/risk.ts`** (pure, browser-safe; imports
    `minimatch`, `isCodePath` and `isSensitivePath` from `ignore.ts`,
    `TEST_PATHS` from `trivial.ts`, and the `DiffFile` type; I-10 reuse):
    - Constants, each `Object.freeze`d with nested objects frozen too
      (critique point 12): `RISK_BANDS` (`low`, `medium`, `high`; its own
      `RiskBand` type, not `types.ts` `Risk`, which is `Selection.risk`'s),
      `REACH_BANDS` (`narrow`, `moderate`, `wide`), `REACH_THRESHOLDS`
      `{ narrow: 3, moderate: 25 }`, `RISK_IMPACT_FLAGS` (`sensitive`,
      `deletion-heavy`), `DELETION_HEAVY` `{ minLines: 20 }`,
      `RISK_TIE_BREAKERS` `{ dirs: { weight: 0.25, cap: 7 }, entropy:
      { weight: 0.25, cap: 3 } }`, `RISK_CUTPOINTS` `{ medium: 6.88, high:
      9.11 }` (provenance in its comment and below), `RISK_OPTIONAL_FEATURES`
      (`churn`, `fixCommits`, `reverts`, `dependents`), `FIX_SUBJECT` and
      `REVERT_SUBJECT`.
    - Types: `RiskHistory`, `RiskFeatures` (the contract's shape plus
      `codeAdded`, `codeDeleted`, `testOnly` and `reverts`) and
      `RiskAssessment` (`band`, `likelihood { score, band }`, `reach?`,
      `impact`, `testOnly`, `reasons`, `missing`).
    - `riskFeatures(files, { history?, dependents?, changed? })`,
      `countHistory(subjects)` and `riskOf(features, cutpoints =
      RISK_CUTPOINTS)`. `changed` is the change's whole file list, before
      `classifyFiles` (review fix, below).
  - **Core `review/types.ts`** (still import-free): after
    `ZdrAttestedEntry`, `REVIEW_LENSES` (`concurrency`, `resource`,
    `access`, `data-integrity`) with `ReviewLens`, and `LENS_LIMITS`
    `{ steps: 5, findings: 4, parallel: 3 }` (contract VS-28 item 3).
    `ReviewConfig.depth?: "fixed" | "auto"` and `lenses?: "off" | "high"`
    after `verifyEvidence`, commented in the existing style;
    `OPTIONAL_REVIEW_DEFAULTS` gains `depth: "fixed"` and `lenses: "off"`;
    `UNAPPLIED_REVIEW_KEYS` gains both, and its comment names VS-28
    wiring. `DEFAULT_REVIEW_CONFIG` is unchanged.
  - **Core `review/config.ts`:** `FIELDS.depth = oneOf(["fixed", "auto"])`
    and `FIELDS.lenses = oneOf(["off", "high"])`; `ENV` gains
    `REVIEW_DEPTH` and `REVIEW_LENSES` after `REVIEW_GUARDRAIL` (§1.1).
    `UNAPPLIED`: `depth` under `"auto"` warns `"depth": "auto" is not
    applied yet: every review still runs its usual passes.`; `lenses`
    under `"high"` with `"auto"` warns `"lenses": "high" is not applied
    yet: no lens passes run.` `settle` adds two notes after
    `verifyEvidence`'s, keeping every value as written: `"lenses": "high"
    is ignored without "depth": "auto": lens passes run only on the high
    band of an automatic depth.`, and under `"auto"` with `security:
    "off"`, `"depth": "auto" keeps "security": "off": no band adds the
    security pass.` (with `or the access lens` when `lenses` is `"high"`).
  - **Core `review/plan.ts`:** `MAX_REVIEW_SESSIONS = 8`, `DepthLimit`
    (`"security-off"`), `DepthPlan` (`requested`, `effective`,
    `specialists`, `lenses`, `sessions`, `limited`), `DepthInput` (a union
    on `depth`: `"auto"` requires `risk`) and `planDepth(input)`. Imports
    only types from `risk.ts`. `planSpecialists` and every other export
    are unchanged.
  - **Core `review/prompt.ts`:** `LENS_TASKS` (four single-class task texts
    in `SECURITY_TASK`'s shape, untuned, I-13), a private `PromptKind`,
    `TASKS` and `OTHER_CLASSES` lookups (the security entry byte-identical
    to the old `skip.push`), `build(input, kind: PromptKind)` reading them,
    and the limit `LENS_LIMITS.findings` for a lens while review and
    security keep `Math.max(4, 2 * maxComments)`.
    `buildLensPrompt(input, lens)` sits after `buildSecurityPrompt`, away
    from codium's `buildJudgePrompt`. One pre-existing long line that
    prettier would reflow was kept as it was, to add no unrelated hunk (the
    file was already off-format at HEAD).
  - **Core `review/model-evidence.ts`:** `EVIDENCE_POLICY_KEYS` gains
    `depth` and `lenses` at the end, with a comment.
    `canonicalPrompts(keys)` takes `depth` and `lenses` and, under `depth:
    "auto"` with `lenses: "high"` only, appends the lens prompts after the
    impact ones: each lens over the review prompts' six inputs for both
    trusts (48), and under `impact: "graph"` also with each slice for both
    trusts (16 more). The six inputs sit in a private
    `canonicalInputs(trust)` that the review prompts read too, so their
    output is unchanged (review fix, below).
    `promptsDigest` takes both keys and joins `lenses:high` to the memo key
    only under the pair. A private `POLICY_ONLY_WITH` makes `policyDigest`
    read `lenses` as absent unless `depth` is `"auto"` (decision (n)).
    `evidenceScope` passes the pair only when both are set and neither is
    unapplied, which is never now. `REVIEW_PIPELINE_SOURCES` moves from
    `e8054845bd8f2858` to `5cd3fb178c514179` (plan.ts and prompt.ts
    changed, risk.ts joined; `e169148d060d546b` before the review fixes); `REVIEW_PIPELINE_REVISION` stays 1, since
    nothing a runner finds or posts changes and only VS-31 bumps it.
  - **Engine `review/eval.ts`** (the eval replay, not a runner):
    `WIRING.depth` and `WIRING.lenses` are `"VS-28 wiring"` (the `Record`
    over `UNAPPLIED_REVIEW_KEYS` requires them), and the `ReplayInput.config`
    comment names them.
  - **Pin:** `REVIEW_PIPELINE_FILES` gains `packages/core/src/review/risk.ts`
    after `dispatch.ts`, and its header says why (once wired it decides
    which passes run).
  - **Eval research script** `script/vectorscope-eval/research/risk_seed.py`
    (new, mode 644, `python3 -I` with numpy; addendum §3 VS-21
    "Reproducibility"): takes `aacr_jobs.py`'s TSV and `aacr2.sh`'s
    numstat folder, reads only the listed keys, computes risk.ts's score
    (the header says to keep them in step), and prints the job counts, the
    exact and rounded cutpoints with band shares of PRs and of changed
    lines for the raw numstats, the same for the filtered numstats (a
    mirror of ignore.ts's default ignores) at the raw cutpoints and at
    their own, and two `example` scores that `risk.test.ts` pins (critique
    points 3 and 11). It writes nothing. `research/README.md` gains its
    script-table row, the "Used by" cell of the AACR permissive inputs
    row, and a run line after `aacr.py`. `research/.gitignore` already
    covers any output; no result is committed.
  - **Tests.** New core `test/review/risk.test.ts` (46; 44 before the
    review fixes). Added: core
    `plan.test.ts` +5 (planDepth), `prompt.test.ts` +3
    (buildLensPrompt), `config.test.ts` +6, `model-evidence.test.ts` +2,
    engine `eval.test.ts` +1 (a replay of a base review.json that sets the
    keys, recorded without them, plus refusal lines in the existing
    test). Changed on purpose: config.test.ts's `OPTIONAL_REVIEW_DEFAULTS`
    equality gains the two defaults; model-evidence.test.ts's "no others"
    policy list gains four cases; the pin. No existing assertion was
    loosened.

- **How `riskOf` decides.**
  1. **Score** = log2(1 + added + deleted) + 0.25 · min(max(dirs − 1, 0),
     7) / 7 + 0.25 · min(entropy, 3) / 3. The tie-breakers together add at
     most 0.5, half a doubling of the changed lines. A negative or
     non-finite count reads as 0.
  2. **Likelihood band:** high above `cutpoints.high`, medium above
     `cutpoints.medium`, otherwise low; a score exactly at a cutpoint takes
     the lower band.
  3. **Reach** from `dependents` through `REACH_THRESHOLDS` (≤ 3 narrow,
     ≤ 25 moderate, above wide; inference [RP8]); absent, and `dependents`
     listed in `missing`, when the slice is off.
  4. **Impact flags:** `sensitive` when a path or old path is sensitive
     (as `planSpecialists` reads it); `deletion-heavy` when the code files
     outside the test paths delete more lines than they add, and at least
     20.
  5. **Floors, raise-only:** either flag gives at least medium; sensitive
     with wide reach gives high. There is no floor for reach alone
     (decision (d)).
  6. **Test-only** (at least one file, and every path and set old path in
     `TEST_PATHS`, over the reviewed files and, when `changed` is given,
     every file the change touched) makes the band low whatever the size
     or flags: the only way the band is lowered. `testDelta` never moves
     it.
  7. **History** has zero weight: churn, fix commits and reverts go into
     one reason only. Absent fields are listed in `missing`, in
     `RISK_OPTIONAL_FEATURES` order.
  8. **Reasons** are counts and fixed text in a fixed order: size and
     spread with the likelihood band; reach; each floor (or, for a
     test-only change, `Only test files changed, so the band is low.`);
     the test delta with "tests never lower the band"; history "which does
     not change the band". None carries a path, branch name or commit
     subject (I-2), and none uses a forecast word (C-8). Untuned (I-13).
- **How `planDepth` decides.**
  - `depth: "fixed"` is exactly `planSpecialists(files, config)`, no lens,
    `effective: "fixed"`, no limit (D3).
  - `depth: "auto"` takes the band: low runs what `planSpecialists` runs
    under `security: "auto"` (security only on a sensitive path), medium
    adds security, high adds security and, under `lenses: "high"`, the
    four lenses. `security: "always"` adds security on every band.
    `security: "off"` wins over every band and also drops the access lens;
    `limited` gets `"security-off"` wherever the band would have added
    either. `effective` is the band.
  - `sessions` = specialists + lenses + one verify, at most 7, leaving one
    of `MAX_REVIEW_SESSIONS` for VS-30's repro.

- **The seed.**
  - **Numbers** (`risk_seed.py` on the inputs below): jobs 140, with a
    numstat 131, skipped 9. Raw: p50 6.8783, p85 9.1100, rounded to 6.88
    and 9.11; at those, low 66 PRs (50.4%, 11.4% of changed lines),
    medium 45 (34.4%, 39.8%), high 20 (15.3%, 48.8%). Filtered: p50
    6.8612, p85 9.1100; at the raw cutpoints the counts are unchanged (66,
    45, 20; 11.5%, 39.9%, 48.6% of lines), and at its own (6.86, 9.11) 65,
    46 and 20. Both meet Phase A's bounds (high ≤ 20% of PRs and ≤ 50% of
    lines). p80 would give 19.8% of PRs but 58.5% of lines (the plan's
    sweep), so p85 was chosen (decision (b)). The `example` lines print
    6.91067 and 10.50000, the values risk.test.ts pins.
  - **After the floors** (a scratch check, never committed, critique
    point 3: DiffFile stubs from each numstat through `classifyFiles` with
    the default config, `riskFeatures` and `riskOf`): its likelihood bands
    equal the Python filtered variant exactly (66/45/20; 11.5/39.9/48.6%
    of lines), so the mirror holds on this population. After floors: low
    58 (44.3%, 14.7% of lines), medium 55 (42.0%, 42.0%), high 18 (13.7%,
    43.4%); 19 PRs sensitive, 16 deletion-heavy, 4 test-only; 10 raised by
    a floor and 2 (both high by likelihood) lowered by test-only. No
    dependents exist offline, so reach plays no part. Re-run after the
    review fixes with `changed` set to each PR's whole numstat list: the
    same numbers, since none of the 4 test-only PRs touches a skipped
    non-test file.
  - **Provenance** (critique point 11): `positive_samples.json` from
    `alibaba/aacr-bench` at `ee9d7fe` (sha256 `02c8561f…2097`, the
    README's pin); the job list rebuilt by the committed `aacr_jobs.py`
    (140 rows, `cmp`-equal to the plan's list); the numstats are round
    two's (session scratchpad `g2/out3`, read through VS-21d's folder of
    the 131 permissive numstats), written by the session's `aacr2.sh`,
    whose fetch and `git diff --no-renames --numstat` from the merge base
    the committed `aacr2.sh` keeps (VS-21d's equivalence check). Not
    re-fetched. Percentiles are numpy's default linear interpolation; the
    shares were computed with the rounded cutpoints.
  - **Method differences:**
    - `--no-renames`: a renamed file counts as a deletion plus an addition
      in the seed, and as its own edits in `riskFeatures` when the surface
      detects the rename. risk.test.ts pins the size of this: a 200-line
      file renamed with 3 edits scores 2.0 (low) as a rename and 8.73
      (medium) as a deletion plus an addition.
    - The raw seed counts lockfiles and binaries; `riskFeatures` sees the
      reviewed files after `classifyFiles`. The filtered variant measures
      this directly (it replaces the plan's citation of gap-2, whose "same
      to two decimals" was about the points bands, not this score).
    - The 9 positives GitHub no longer serves are excluded (REPORT §5.2).
    - VS-22's `seed.json` is not in the seed: its 10 cases are single
      commits, not PRs, and 2 are held out (I-13).
    - Unsupervised: no label was read.

- **Off by default (I-1, I-12).**
  - **The keys.** Optional, absent from `DEFAULT_REVIEW_CONFIG`, in
    `UNAPPLIED_REVIEW_KEYS`; the parser only warns or notes. `policyDigest`
    reads both as absent whatever their values, and `evidenceScope` never
    passes them.
  - **Nothing calls the new code.** A grep over `packages/engine/src`,
    `packages/app/src`, `packages/desktop/src`, `packages/web/src` and
    `script` (research folder aside) finds none of `riskOf`,
    `riskFeatures`, `countHistory`, `planDepth`, `buildLensPrompt`,
    `MAX_REVIEW_SESSIONS`, `REVIEW_LENSES`, `LENS_LIMITS`,
    `RISK_CUTPOINTS`, `DepthPlan`, `review/risk`, `config.depth`,
    `config.lenses`, `REVIEW_DEPTH` or `REVIEW_LENSES`, except eval.ts's two
    `WIRING` entries.
  - **Digests** (printed at HEAD and on the finished tree, all held):
    `promptsDigest()` `5d59e9ee06077c23`; graph `74a2111826c226b1`; strict
    `b98afb0e878dfe26`; strict with graph `3ba21b5bc883cd70`; strict with
    scopeGate `4aa712221043a3a7`, with graph `8335adf9de513ee5`;
    certificate `d209592d08bb1e0c`, with graph `468fcac8cde18fe2`, with
    scopeGate `0f3ff2dd0f7c1d7d`; `policyDigest(DEFAULT_REVIEW_CONFIG)`
    `70512122f41ec160`, also with both keys; `{ depth: "auto" }` and
    `{ lenses: "high" }` alone equal the default. Three new key-gated
    digests are pinned, each moving only under the pair: `{ depth:
    "auto", lenses: "high" }` `dd09332295a99649`; with graph
    `31c1a0612c0f9541`; with strict `0ebaacbe7aca1b58` (`6a0bc9f036acb7c3`,
    `8109d0c66af6e371` and `225fa4c9b7acd746` before the review fixes
    widened the lens inputs). VS-28 wiring moves them on purpose when the
    lens agent prompt joins under the pair.
  - **The replay.** A base review.json that sets the pair, or `lenses`
    alone, is replayed and recorded without them, keeping the parser's
    warnings; only the review pass runs (no security pass, no lens
    request) and the scope claims neither the policy nor the lens
    prompts. `ReplayInput.config` refuses either key, alone and beside the
    guardrail.
  - **Runner suites** pass with unchanged counts (table below).
  - **§0.3 items 4 and 5.** `engine:depth-auto` and `engine:lenses-high`
    stay pending "VS-28 wiring" in `replay.ts`, untouched; the desktop half
    is a documented difference until VS-10 (`variant.applied: false`).

- **Decisions.**
  - (a) **Tie-breakers are a bounded additive term** (at most half a size
    doubling), not exact-equality ordering, which would almost never fire
    on integer line counts.
  - (b) **p50 and p85**, not p80, so the seed population meets both of
    Phase A's bounds (≤ 20% of PRs and ≤ 50% of lines high).
  - (c) **Deletion-heavy over code files outside the test paths**
    (critique point 4, taken with a narrower reading than "outside
    tests"): `isCodePath` and `TEST_PATHS`, both reused, so test, doc,
    config and data deletions never raise the band. That follows the risk
    note's "deletion-heavy code change"; deletions in workflows,
    Dockerfiles or Terraform still raise it through the sensitive flag. On
    the seed (filtered files) the rules flag 17 PRs over the whole PR, 18
    over every file outside the tests, and 16 over code outside the tests.
    The rule and its 20-line minimum are inference [RP6].
  - (d) **No floor for wide reach alone** (critique major point, taken).
    VS-39 item 1 names exactly two impact flags and one combined rule; the
    risk note's wide-only floor was superseded, and PR-Agent bands
    projects, not files, so in a monorepo it would push many small PRs to
    medium with cost Phase A never measured. It is a candidate for Phase
    A's reach fit. Sensitive with wide reach still gives high. A
    truth-table row and a mutation pin its absence.
  - (e) **Test-only overrides the floors**, and the flags that hold are
    still listed. Under `security: "auto"` the low band still adds
    security on a sensitive path through `planDepth`, so a test-only
    change to `test/auth.test.ts` gets the security pass as it does today.
  - (f) **An explicit `security: "off"` wins under auto**, said at parse
    time and in `DepthPlan.limited`, and also drops the access lens
    (critique point 6, its second option): that lens looks for
    authentication and authorization defects, the security pass's
    ground. A plan test pins it; the owner may reverse it with a one-line
    change.
  - (g) **The word list.** `FIX_SUBJECT` matches fix, fixes, fixed,
    fixing (critique point 9), bug, bugs, bugfix(es, ed, ing), bug-fix and
    hotfix(es, ed, ing), word-anchored; prefix, debug, fixture, fixup,
    suffix, postfix, affixed and Bugzilla do not match. A revert, even of
    a fix, counts as a revert only. A subject that only mentions a bug
    ("Add a bug report template") counts as a fix; history has zero
    weight, so this affects only the printed count.
  - (h) **Plain keys** with `REVIEW_DEPTH` and `REVIEW_LENSES`, per §1.1;
    not source-tagged. `depthRules` (VS-48) is the trusted-only one, and
    is deferred.
  - (i) **Where the types live.** Risk types in `risk.ts`; the lens
    constants in import-free `types.ts`, so `plan.ts` and `prompt.ts`
    share them without a value import between them. `plan.ts` takes only
    types from `risk.ts`.
  - (j) **Runner-only limits kept** (critique point 12): `LENS_LIMITS.steps`,
    `LENS_LIMITS.parallel` and `MAX_REVIEW_SESSIONS` are read only by tests
    before wiring, and say so; the contract names them, and wiring reads
    them from here.
  - (k) **Auto never plans fewer passes than fixed** with the same
    security setting (I-2), tested over every band, security setting and
    lens value.
  - (l) **No variant flip and no replay.ts change** (§0.3 item 4 waits for
    wiring); the desktop half is a documented difference (item 5).
  - (m) **`DepthInput` is a union** (critique point 5, its first option):
    `depth: "auto"` requires `risk`, so there is no `risk-missing` limit.
    `riskOf` needs only the files; a missing feature is in `missing`, not a
    missing band. A test pins it with `@ts-expect-error` on a `DepthInput`
    value. `planDepth` has no runtime guard, so there is no runtime
    assertion (review fix, below).
  - (n) **`lenses` counts in `policyDigest` only under `depth: "auto"`**
    (critique point 7, its alternative: the condition is in now). It is
    dormant while both keys are unapplied, so no test or mutation can
    reach it yet; VS-28 wiring's test must show `depth: "fixed"` with
    `lenses: "high"` equals the default policy digest. The same latent gap
    exists for `scopeGate` and `verifyEvidence`, whose comments say they
    count only under strict but whose digest has no such condition; VS-42
    and VS-44 wiring can add them to `POLICY_ONLY_WITH`.
  - (o) **The seed is raw** (round two's convention and the plan); the
    filtered variant differs by 0.017 at p50 and not at p85, and gives the
    same band counts at the shipped cutpoints.
  - (p) **The lens prompts share `build()`** and its "Untrusted text"
    section, so a lens is also told to report instructions aimed at AI
    reviewers as a security finding. The lens classes follow the
    contract's mechanisms (concurrency, resource, access) and the
    data-corruption class; the text is untuned (I-13), and Q3 and Q4 bear
    on it. Nothing yet says which category a lens finding takes; both are
    hand-offs to VS-28 wiring (below).
  - (q) **Entropy is summed from +0**, so a one-file change has entropy 0,
    never −0.

- **Deferred (record).**
  - **From the brief, to later windows:** the per-repository refit after
    200 PRs (VS-39 item 2; `riskOf`'s `cutpoints` parameter is the hook);
    `order(files)` in `budgetDiff` and VS-19 batching (item 5); the
    focus-hunk band under `rereview: focused` (VS-41, item 4); Phase A's
    cost projections (item 6); the band in `--json` (Q28; notes only
    until then); `depthRules` (VS-48); history risk areas (VS-46); §3
    VS-28's validator lens and taxonomy mapping; the equal-token control
    arm (the funded Q9 ablation).
  - **Hand-offs to VS-28 wiring** (runner-wiring window; Q13, Q15, Q18):
    - `riskFeatures` from `RunInput.files` after `classifyFiles` on the
      whole PR, with `changed` set to the whole file list before
      `classifyFiles` (so test-only follows VS-39 item 1: no non-test file
      changed, ignored ones included) and `dependents` from the slice's
      gated count (`ImpactSlice.stages.gated`), a lower bound when the
      slice is incomplete, said in the notes;
    - the history gatherer's bounded 90-day window, one subject per
      distinct commit, into `countHistory`; history `missing` in CI unless
      the CLI fetches the window;
    - `planDepth` in place of `planSpecialists` under `depth: "auto"`
      (the fixed path keeps today's call, with D3 parity tests);
    - every `DepthPlan.limited` entry, the effective depth, the band and
      its reasons as run notes (G6-2), tested; never the "Risk:" header and
      never `Selection.risk`;
    - the lens agent prompt file and its pin entry;
    - the category a lens finding takes (for example one Category per
      lens, or `bug` for all four), and what a lens does with instructions
      aimed at AI reviewers: drop `build()`'s injection-reporting clause for
      lens kinds, or route such findings to the security pass so they are
      not reported twice (decision (p)); pinned in `prompt.test.ts` and by
      the lens digests when wiring moves them;
    - lens passes at ≤ 5 steps, ≤ 4 findings and ≤ 3 in parallel on the
      review model, as `ReviewOutcome.specialists` `name: "lens"` with
      `lens`, their findings unioned, deduped and verified, then the
      guardrail;
    - the budget shrink dropping lenses first (dispatch.ts's lever);
    - `posting.ts` failing closed on cut lineage (I-4) before any lens;
    - the session bound (`MAX_REVIEW_SESSIONS`) and lineage bound tests in
      run.test.ts;
    - `VARIANT_KEYS.engine` gaining both keys and `engine:depth-auto` and
      `engine:lenses-high` flipping, with D3 parity tests;
    - both keys leaving `UNAPPLIED_REVIEW_KEYS` and `WIRING`, which makes
      `POLICY_ONLY_WITH` live (decision (n)) and moves the three lens
      digests on purpose;
    - revisiting (f), the access lens under `security: "off"`, with the
      owner's answer (owner questions, below).
  - **The codium merge:** its panel judge would be a 9th session, so the
    bound must be re-decided with the codium owner before both land.
  - **One test-path matcher (I-10).** `risk.ts` `isTestFile`, `trivial.ts`'s
    private `matches(path, TEST_PATHS)` and `impact.ts`'s inline filter
    each call `minimatch` over `TEST_PATHS` with `{ dot: true, nocase:
    true }`, and `risk.ts` copies `trivial.ts`'s private `dirname`. When
    `trivial.ts` is next touched (it is pinned, so with its own pin
    update), export one `isTestPath(path)` from it and use it in
    `risk.ts` and `impact.ts`. Until then a `risk.test.ts` case pins that
    `risk.ts` and `trivial.ts` agree on a list of paths (review fix,
    below).
- **Deferred verification.**
  - Phase A band shares on Martian (Q10) and ReviewBench (Q27); the reach
    fit, which needs VS-25b wiring artifacts; recall by band; CI and local
    agreement on real artifacts. For equal inputs they agree by
    construction; the known source of disagreement is rename and copy
    detection (GitHub's similarity and its `copied` status, which has no
    old path, against local `diff.renames` and `renameLimit`; the seed
    used `--no-renames`), sized by the rename test above (critique point
    8).
  - The lens prompts were never sent to any model.
  - The Python and TypeScript cross-check is manual: risk.test.ts pins the
    two `example` values the script prints, and the scratch check matched
    the filtered bands, but no test runs Python.
- **Owner questions.** None new. Q9, Q10, Q13, Q15, Q18, Q27, Q28 and Q31
  stay open; this package is neutral on them, since nothing calls it. If
  Q31 is answered no, re-seed the two cutpoints from VS-22b's PR cases. Q3
  and Q4 bear on the lens classes. Lane readings the owner may reverse
  with local changes: (c) code files only, (d) no wide-only floor, (f) an
  explicit `security: "off"` under `depth: "auto"`, (g) the word list.
  (f) decides policy for an owner-facing key pair the contract's depth
  table is silent on, in two halves the owner may reverse apart: `off`
  winning over every band (no security pass on medium or high), and the
  access lens dropped with it. The neutral alternative to the second half
  keeps all four lenses under `off` and records only `security-off` in
  `limited`; either is a one-line change in `planDepth` and one plan test.
- **Predicted merge conflicts.** Read-only: a three-way `git merge-file`
  of each touched file that either branch changes, comparing HEAD and the
  working tree against each branch's merge base and tip.
  - `origin/codium` (`5a079cbd`) changes `config.ts`, `prompt.ts`,
    `types.ts` and `plan.test.ts`; `origin/self-evolving` (`f062bcce`)
    changes `types.ts` and `plan.test.ts`. `risk.ts`, `plan.ts`,
    `model-evidence.ts`, engine `eval.ts`, the other tests and the
    research files are untouched by both.
  - `config.ts`, `prompt.ts` and `plan.test.ts`: no conflict, at HEAD or
    with VS-28c. In the merged `prompt.ts`, codium's `buildJudgePrompt`
    sits after `buildVerifyPrompt` and does not call `build()`, whose only
    callers stay the review, security and lens builders.
  - `types.ts`: 2 conflict hunks with codium and 1 with self-evolving,
    byte-identical at HEAD and with VS-28c (the VS-27a pass-name lines).
    No new conflict hunk.
- **Evidence.** Each file was run alone through the lock with `--timeout
  30000`, from its package directory; the engine ones with fresh XDG roots
  under `/tmp/vector-vectorscope/vs28c/xdg/`. Counts are at HEAD → with
  VS-28c.

  | File | HEAD | VS-28c |
  |---|---|---|
  | core `test/review/risk.test.ts` | — | 46 (44 before the review fixes) |
  | core `test/review/plan.test.ts` | 21 | 26 |
  | core `test/review/prompt.test.ts` | 36 | 39 |
  | core `test/review/config.test.ts` | 59 | 65 |
  | core `test/review/model-evidence.test.ts` | 26 | 28 |
  | core `test/review/select.test.ts` | 45 | 45 |
  | core `test/review/format.test.ts` | 51 | 51 |
  | core `test/review/trivial.test.ts` | 44 | 44 |
  | core `test/review/impact.test.ts` | 59 | 59 |
  | core `test/review/dispatch.test.ts` | 22 | 22 |
  | core `test/review/pipeline.test.ts` | 2 | 2 |
  | engine `test/review/eval.test.ts` | 31 | 32 |
  | engine `test/review/run.test.ts` | 44 | 44 |
  | engine `test/cli/github.review.test.ts` | 40 | 40 |
  | app `ai-review.test.ts` (`--preload ./happydom.ts`) | 107 | 107 |
  | eval `replay.test.ts` (from `script/vectorscope-eval`) | 32 | 32 |
  | eval `report.test.ts` (from `script/vectorscope-eval`) | 33 | 33 |
  | eval `certify.test.ts` (from `script/vectorscope-eval`, critique point 10) | 6 | 6 |

  - **Typecheck.** `bun typecheck` passes in core, engine and app. The eval
    scripts pass `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json`
    from `packages/engine`.
  - **Lint.** prettier is clean on every changed TypeScript file except
    `prompt.ts`, whose one off-format line predates this package (above).
    oxlint reports 0 warnings on `risk.ts` and `risk.test.ts`, and no new
    warning on the other changed files.
  - **The seed script.** `py_compile` passes; `--help` exits 0; no
    arguments or `--medium 0.9 --high 0.5` exit 2; a malformed key or a
    folder with no numstat exits 1; the full run printed the numbers above.
  - **Mutations.** Each was applied alone, its test file run, and the file
    restored byte for byte (checked by hash). All 41 were caught:
    - risk.ts (19): each cap dropped (2); `>` as `≥` at the cutpoints; the
      test-only override dropped; `testDelta` lowering the band; the
      deletion minimum dropped; `>` as `≥` in the deletion rule; deletions
      over every file; each reach boundary moved by one (2); sensitive
      with wide reach giving medium; a wide-alone floor added; history in
      the score; the fix regex unanchored; `fixing` dropped from it; a
      revert counted as a fix; old paths ignored for sensitive and for
      test files (2); a missing feature not listed.
    - plan.ts (7): security `off` ignored; lenses on medium; lenses under
      fixed; security always in low; fixed differing from
      `planSpecialists`; the access lens kept under `off`; no limit
      recorded.
    - prompt.ts (3): the lens given the review limit; a lens skip line
      dropped; the security skip line changed.
    - model-evidence.ts (4): `lenses:high` dropped from the memo key; lens
      prompts under `lenses` alone; the pair passed in `evidenceScope`
      while unapplied; `depth` dropped from the policy keys.
    - config.ts and types.ts (7): the ignored note, the security-off note
      and the depth warning each dropped; the lenses warning without auto;
      each environment entry dropped (2); the depth default changed.
    - engine eval.ts (1): `WIRING.depth` naming another package.
    - Not reachable: `POLICY_ONLY_WITH` (decision (n)).
  - **Not run.** The full root typecheck was not run, since nothing is
    pushed.
  - **Not done.** Nothing was sent to a model; there was no paid run, no
    workflow dispatched, nothing published and nothing committed; no
    user-visible string changed (D14).

### 2026-11-07 · VS-28c review fixes

Nine review findings, none blocking. Six were fixed in code, one in a wider
form than its finding asks (the lens inputs, which also takes a second
finding's deferred half now). Three asked for no code change now; they are
recorded in the entry above, as owner readings or hand-offs. Only core
`review/risk.ts`, `review/model-evidence.ts` (the lens inputs and the
pin), `test/review/risk.test.ts`, `test/review/plan.test.ts` and
`test/review/model-evidence.test.ts` changed, with this log. No runner,
provider, LLM or posting file, no prompt text and no file @vector owns
changed. The entry above is updated in place where its facts changed (the
`riskFeatures` signature, test-only, the lens prompts, the pin, three
digests, decision (m), the hand-offs, the owner questions and the risk test
count). Nothing is committed.

- **The lens prompts over the review prompts' inputs** (findings on
  `model-evidence.ts:381`, both). Taken now, as the first option of the
  first finding and with the second finding's deferred part, because the
  three lens digests are new in this package and uncommitted, so widening
  their inputs moves no recorded digest.
  - `canonicalPrompts` renders each lens over the six inputs per trust that
    the review and security prompts use (bare with the untrusted head file,
    incremental, and populated with and without nits, full and
    incremental, a commit and uncommitted): 48 prompts, up from 8. Under
    `impact: "graph"` with the pair, each lens also renders with both
    slices for both trusts (16 more), so the graph lens digest covers the
    lens-plus-impact prompt a wired run sends.
  - The six inputs moved from the per-trust closure into a private
    `canonicalInputs(trust)`, read by the review prompts and the lenses.
    The review prompts' output is unchanged: every earlier digest still
    matches its pin (`promptsDigest()` `5d59e9ee06077c23`, graph
    `74a2111826c226b1`, strict `b98afb0e878dfe26`, and the rest printed by
    the scratch script, identical to the finished tree's but for the pair).
  - The comment also says what the first finding's second option asks: a
    lens prompt differs from the review prompt only in `TASKS`,
    `OTHER_CLASSES` and its cap, so a lens-only branch added to `build()`
    must add the inputs that reach it.
  - The lens digests move to `dd09332295a99649`, graph
    `31c1a0612c0f9541`, strict `0ebaacbe7aca1b58`. The test now checks 48
    and 64 lens prompts, the nits, incremental and uncommitted lines in
    the lens text, no impact block without graph, and four lens-plus-impact
    prompts per lens with it.
- **Test-only over every changed file** (finding on `risk.ts:127`). Taken
  as the first option. `riskFeatures` takes an optional `changed`: every
  file the change touched, the ones `classifyFiles` leaves out included.
  Test-only reads it beside `files`, so a non-test file the review skips
  (ignored by default or by `ignore`, generated, vendored, binary, or a
  deletion with no patch) keeps the change from being test-only, as VS-39
  item 1 defines it. A skipped file in a test path, such as a binary
  fixture or a `.snap` under a `*.test.*` name, does not. Without
  `changed`, test-only reads `files` alone, as before, so no default
  changes. Every other feature still comes from `files`. The VS-28 wiring
  hand-off now says to pass the whole list. A new `risk.test.ts` case runs
  real `classifyFiles` over a test file with `dist/` and `vendor/` files:
  test-only without `changed`, not with it, every other feature equal; a
  900-line test change with one ignored `dist/` line is low without
  `changed` and high with it. On the seed population the result is the
  same with `changed` set (entry above).
- **`security: "off"` under auto, decision (f)** (finding on
  `plan.ts:281`). Behaviour kept, as the finding's first option says. The
  owner-questions paragraph now names (f) explicitly, in both halves the
  owner may reverse apart, with the neutral alternative (all four lenses,
  `security-off` in `limited` only).
- **The `toThrow()` assertion** (finding on `plan.test.ts:113`). Dropped,
  as the finding's first option says. The `@ts-expect-error` now sits on a
  `DepthInput` value (`const unbanded: DepthInput = { depth: "auto", ... }`,
  then `void unbanded`, as `skip.test.ts` does), so nothing runs and the
  type is the guarantee. `bun typecheck` passing shows the directive is
  still used. No named runtime error was added: `DepthInput` already
  rules the case out, and a guard nobody can reach adds nothing.
- **Redundant annotations** (finding on `risk.ts:150`). Taken: `likely` and
  `floor` lose `: RiskBand`; both infer the literal union, and `band` still
  type-checks against `RiskAssessment`.
- **Import order** (finding on `plan.test.ts:11`). Taken:
  `MAX_REVIEW_SESSIONS` moves before `MIN_CONTEXT`.
- **Lens categories and the injection clause** (finding on
  `prompt.ts:327`). No code change, as the finding says. A new VS-28 wiring
  hand-off: decide the category a lens finding takes, and either drop
  `build()`'s injection-reporting clause for lens kinds or route such
  findings to the security pass, with `prompt.test.ts` and the lens digest
  pins covering it. Decision (p) points to it.
- **One test-path matcher** (finding on `risk.ts:239`). No change to
  `trivial.ts` or `impact.ts` now, as the finding says; the single
  `isTestPath` export is a deferred I-10 item in the entry above. The
  finding asks to keep a case that checks agreement, and none existed, so
  one was added. `risk.test.ts` now checks 18 paths (test and non-test
  names, test directories, mixed case, near misses such as `testing/`,
  `contest.py`, `latest.ts` and `attest/`). For each, `riskFeatures`
  calls a one-file change test-only exactly when `classifyTrivial`
  refuses a pure, in-place rename from that path to `zz.ts` in the same
  directory as `test-path`. Trivial's earlier refusals limit the check to
  paths that are not sensitive and have no dot segment: a first draft with
  `e2e/cypress/login.ts` failed because `login` is sensitive. So the check
  covers `nocase` but not `dot`.
- **Off by default (I-1, I-12).** Unchanged from the entry above. With
  every new key unset, every digest and every runner path is as before:
  `promptsDigest` with no key and with every earlier set of keys, the
  policy digest and the scope all match their pins. `riskFeatures` without
  `changed` returns what it did. Nothing outside core's tests calls the new
  code.
- **Pin (I-12).** `REVIEW_PIPELINE_SOURCES` moves from `e169148d060d546b`
  to `5cd3fb178c514179` because `risk.ts` changed.
  `REVIEW_PIPELINE_REVISION` stays 1. `model-evidence.ts` is not a pinned
  file.
- **Evidence.** Each file was run alone through the lock with `--timeout
  30000`, from its package directory; the engine one with fresh XDG roots
  under `/tmp/vector-vectorscope/vs28c/xdg/fix/`.

  | File | Count |
  |---|---|
  | core `test/review/risk.test.ts` | 46 (2 new) |
  | core `test/review/plan.test.ts` | 26 |
  | core `test/review/model-evidence.test.ts` | 28 |
  | core `test/review/prompt.test.ts` | 39 |
  | engine `test/review/eval.test.ts` | 32 |

  - **Typecheck.** `bun typecheck` passes in core, engine and app.
  - **Lint.** prettier is clean on the five changed TypeScript files.
    oxlint reports 0 warnings on `risk.ts` and `risk.test.ts`, and no new
    warning on the others (the remaining ones are on lines this package
    does not touch).
  - **Mutations.** Each was applied alone, its test file run, and the file
    restored byte for byte (checked by hash). All four were caught (one
    test failed each):
    - risk.ts against `risk.test.ts`: test-only read from `files` alone,
      ignoring `changed`; `isTestFile` without `nocase`.
    - model-evidence.ts against `model-evidence.test.ts`: the lenses over
      `POPULATED_INPUT` alone; the lenses without the impact slices under
      graph.
  - **Not run.** The full root typecheck was not run, since nothing is
    pushed.
  - **Not done.** Nothing was sent to a model; there was no paid run, no
    workflow dispatched, nothing published and nothing committed; no
    user-visible string changed (D14).

## 2026-11-07 · VS-30c Runtime evidence contract (core)

Contract §1.1 (`runtime`: `off` / `ask`, a policy key, trusted sources
only), §1.2 (`runtime.ts`), §2 I-2, I-4, I-6 and I-12, §3's rows for
`permission.ts` and `prompt.ts`, and §4 VS-30 items 1 to 6 with its Tests
line, the core contract only. Addendum A §3 VS-30 ("checks not run"
reasons from Greptile's blocker taxonomy [GP17]; simulation first, no
network or secrets, and fix validation are executor work) and §3 VS-27
(evidence attaches to its finding [GP3]), with the round-two amendment that
adds a typed "checks not run" reason union. Evidence: research REPORT §4.6,
`evidence.md` §5.1 (the oracle problem: only a base and head differential
counts) and §5.2 (Bun's lcov flags; with only the lcov reporter the
threshold check exits 0), round-two `notes/greptile-primary.md` §7 and
§11 (the TREX blockers). Built at `213aabe9` (VS-28c). Now window only: a
new pure core module, additive uncalled code in pinned core files, a
trusted-only key that is parsed and applied by nothing, a frozen coverage
allowlist that nothing runs, a prompt-block builder no runner calls, and
one eval-replay `WIRING` entry. It implements the VS-30c plan as corrected
by its critique: all thirteen critique points were taken, two by the
first of their stated options (the failure location, (c); the verdict
bound to its finding, (k)); none was declined. Nothing is committed (the
lane brief).

- **Citations re-located at `213aabe9`** (the contract cites `02c23b4c`).
  `permission.ts` `CHECK_COMMANDS` `:30-43` (contract `:24-40`), the
  `--checks` rules `:77-86` (contract `:75-84`), `reviewPermissionRules`
  `:54-89`; `types.ts` `Finding.verifiedBy` `:66`, `VERIFIED_BY` `:93`,
  `ReviewConfig` `:390-489` (contract `:211-283`), `zdrAttested` `:462`,
  `OPTIONAL_REVIEW_DEFAULTS` `:523-532`, `UNAPPLIED_REVIEW_KEYS`
  `:541-550`; `config.ts` `TRUSTED_ONLY` `:154`, `SOURCED_REVIEW_KEYS`
  `:156-157`, `UNAPPLIED` `:231-271`, `mergeReviewConfig` `:347-419` (its
  trusted loop `:401-417`), `settle` `:422-493`; `model-evidence.ts`
  `REVIEW_PIPELINE_SOURCES` `:59`, `EVIDENCE_POLICY_KEYS` `:75-93`,
  `canonicalPrompts` `:374-408`, `promptsDigest` `:434-457`,
  `policyDigest` `:473-486`, `evidenceScope` `:490-529`; `prompt.ts`
  `MAX_CHECK_CHARS` `:117`, `STRUCTURE_TAG` `:209` (already escapes every
  `untrusted_\w*` tag), `wrapUntrusted` `:259`, `impactBlock` `:539`,
  `trusted()` `:629`, `clipEnd` `:704`; `model-evidence.test.ts`
  `REVIEW_PIPELINE_FILES` `:43-64`; engine `eval.ts` `ReplayInput.config`
  `:136-149`, `WIRING` `:1151-1160`, `variantProblem` `:1165-1194`, the
  untrusted-replay note `:13` (contract `eval.ts:75`); engine `run.ts`
  verify verdicts `:784-798` (contract `:736`); `sandbox.ts` `offline()`
  `:252-270` (contract `:211-254`); `cli/cmd/review.ts` `--checks`
  `:349-359` and `:750-751`.
- **Untouched:** `run.ts`, `ai-review.ts`, `provider.ts`, `session/llm.ts`,
  `posting.ts`, `cli/cmd/review.ts`, `sandbox.ts`, `select.ts`,
  `format.ts`, `trivial.ts`, `ignore.ts`, `diff.ts`, the eval scripts, and
  every @vector file (`workflow.ts`, `command.ts`, `github.*`,
  `github-*.ts`, the GitHub sections of `vectorscope.astro`).
  `REVIEW_PIPELINE_REVISION` stays 1.

- **What landed.**
  - **New core `review/runtime.ts`** (pure, browser-safe; imports
    `minimatch`, `isCodePath` from `ignore.ts`, `COVERAGE_COMMANDS` from
    `permission.ts`, `TEST_PATHS` from `trivial.ts`, and the `DiffFile` and
    `Finding` types; I-10 reuse). Its header says nothing calls it before
    the VS-30 executor, that test and coverage output is untrusted (I-2),
    that only the executor's exit codes decide, and that only "confirmed"
    changes a finding.
    - Frozen constants: `RUNTIME_VERDICTS` (`confirmed`, `inconclusive`,
      `contradicted`); `RUNTIME_STOPS` (`timeout`, `output-limit`: runs the
      executor stopped); `RUNTIME_FAILURES` (`assertion`, `error`);
      `RUNTIME_LIMITS` `{ commandMs: 120_000, outputBytes: 81_920,
      reproducers: 3, runs: 2 }` (contract VS-30 items 2 and 4; only `runs`
      is read here); `SIGNAL_EXIT` 128; `LCOV_LIMITS` `{ chars: 32 MiB,
      files: 20_000, lines: 1_000_000, lineChars: 4_096, lineNumber:
      10_000_000 }`; `MAX_UNCOVERED_LINES` 200; and `CHECKS_NOT_RUN`
      (decision (j)) with its `ChecksNotRun` type.
    - Types: `ChangedCoverage` (`path`, `changed`, `covered`,
      `uncovered`, `unmeasured?`), `RuntimeEvidence` (`command`, `side`,
      `commit`, `exit`, `ms`, `runs`, `failure?`, `stopped?`,
      `coverage?`, `reproducerFor?`, `output?`), `RuntimeTie` (`finding`,
      `assertion: "tied" | "untied" | "unchecked"`), `RuntimeResult`
      (`finding`, `verdict`), `LcovFile` and `LcovReport` (`files`,
      `malformed`, `tooLarge?`).
    - `parseLcov(text, { cwd?, root?, paths? })`: reads `SF:` and `DA:`
      only; skips the other record types (`TN`, `FN`, `FNDA`, `FNF`,
      `FNH`, `FNL`, `FNA`, `BRDA`, `BRF`, `BRH`, `LF`, `LH`, `VER`);
      counts as malformed a bad `DA:` line (`/^DA:(\d{1,10}),(\d{1,20})(?:,.*)?$/`,
      line 1 to `lineNumber`), a `DA:` outside a record, an empty `SF:`,
      a line over `lineChars` (never copied out of the text), an `SF:`
      before the previous `end_of_record` (which closes that record, also
      when the `SF:` is over `lineChars` and so opens nothing), and
      any other line; keeps a record open at the end; merges a file listed
      twice by its highest hits per line, in first-seen order, in a `Map`.
      Over `chars` it returns `tooLarge` without scanning; over `files`
      kept files or `lines` kept line entries it refuses the whole report.
      Path rules: decision (e).
    - `changedLineCoverage(lcov, files, { cwd?, root? })`: maps each diff
      file that is not deleted or binary, is code (`isCodePath`), lies
      outside `TEST_PATHS` and adds a line, by its head path, parsing with
      `paths` set to those files so memory follows the change. A file the
      report omits is `unmeasured`; `undefined` when the report is too
      large.
    - `runtimeVerdict(head, base, tie, commits)` and
      `applyRuntimeVerdict(finding, result)`: decisions (a) to (d) and (k).
  - **Core `review/permission.ts`:** `CHECK_COMMANDS` is exported and
    `Object.freeze`d (`as const`), the same twelve commands; its comment
    says VS-30's executor will read it. `COVERAGE_COMMANDS` (frozen,
    nested too) holds `bun: { command: "bun test --coverage
    --coverage-reporter=lcov", report: "coverage/lcov.info" }`, with
    `CoverageRunner`. Its comment (critique point 8): for the trusted
    executor only, never the model's shell, which `* -*` still denies;
    nothing runs it; `report` is Bun's default as probed, and the
    project's bunfig.toml can move it (`coverageDir`), change the reporters
    and add preloads, so a missing report is no coverage, never 0%; the
    coverage run's exit code is no pass or fail (Bun's threshold check
    exits 0 with only the lcov reporter) and never feeds `runtimeVerdict`;
    other runners wait for verified flags. `isCoverageCommand(command)`
    says whether a command is a `COVERAGE_COMMANDS` command, bare or
    followed by a space and arguments; `runtime.ts` and `prompt.ts` share
    it. `reviewPermissionRules` is unchanged and its output byte-identical
    (golden test below).
  - **Core `review/types.ts`** (still import-free):
    `ReviewConfig.runtime?: "off" | "ask"` after `zdrAttested`, commented
    as proposed with Q8 open (critique point 12): under "ask" a trusted
    local review would ask, per operation through `--checks`, before
    running tests, coverage and reproducers in isolation; trusted sources
    only; absent means "off". `OPTIONAL_REVIEW_DEFAULTS` gains `runtime:
    "off"`; `UNAPPLIED_REVIEW_KEYS` gains `runtime`, and its comment names
    the VS-30 executor. `DEFAULT_REVIEW_CONFIG` is unchanged.
  - **Core `review/config.ts`:** `TRUSTED_ONLY` gains `runtime:
    oneOf(["off", "ask"])`, so `SOURCED_REVIEW_KEYS` gains it:
    `parseReviewConfig` never reads it (review.json's copy stays
    `unknown key "runtime" is ignored.`, as at HEAD) and there is no `ENV`
    entry. `UNAPPLIED.runtime` warns `"runtime": "ask" is not applied yet:
    no runtime checks run, and --checks works as before.` In
    `mergeReviewConfig`'s trusted loop a default is left out (decision
    (h)), and after the loop the sourced keys' not-applied warnings are
    pushed, since `settle` never sees a sourced key. The docstring names
    `runtime` beside `zdrAttested`.
  - **Core `review/prompt.ts`:** a type-only import from `runtime.ts`,
    `isCoverageCommand` from `permission.ts` (browser-safe, type-only
    imports of its own) and `redactSecrets` beside `REDACTED`;
    caps `MAX_RUNTIME_RECORDS` 20, `MAX_COVERAGE_FILES` 30,
    `MAX_UNCOVERED_RANGES` 20 (output reuses `MAX_CHECK_CHARS` through
    `clipEnd`); `RUNTIME_EVIDENCE_INSTRUCTION`, the trusted sentence; and
    `runtimeEvidenceBlock(evidence, secrets)` with private `coverageLine`,
    `notShown` and `lineRanges`, placed after the impact helpers and before
    `trusted()`, away from codium's hunks. Decision (g).
  - **Core `review/model-evidence.ts`:** `EVIDENCE_POLICY_KEYS` gains
    `runtime` at the end, with a comment. A literal `CANONICAL_RUNTIME`
    (a reproducer's head runs failing at an assertion with output, its base
    runs passing, a stopped run, and a head coverage run with a measured
    file whose uncovered lines compress, a file whose changed lines the
    report does not list, and an unmeasured file). `canonicalPrompts` takes
    `runtime` and, under "ask" only, appends `RUNTIME_EVIDENCE_INSTRUCTION`
    and the block last. `promptsDigest` takes `runtime` and adds
    `runtime:ask` to the memo key. `evidenceScope` gets a dormant clause
    that passes `runtime: "ask"` only once the key leaves
    `UNAPPLIED_REVIEW_KEYS`, with a comment that wiring decides whether the
    scope then records "ask" or the evidence that ran (critique point 12).
    `policyDigest` needs no change. `REVIEW_PIPELINE_SOURCES` moves from
    `5cd3fb178c514179` to `dd477fd3a04e6efb` (`prompt.ts` changed,
    `runtime.ts` joined).
  - **Engine `review/eval.ts`** (the eval replay, not a runner):
    `WIRING.runtime = "the VS-30 executor"`; `variantProblem`'s sourced
    check leaves out keys that are also unapplied (decision (i)); the
    `ReplayInput.config` comment names VS-30's runtime. The type already
    excluded the key (it is both sourced and unapplied).
  - **Pin:** `REVIEW_PIPELINE_FILES` gains
    `packages/core/src/review/runtime.ts` after `citation.ts`, and its
    header says why (critique point 11: once the executor runs it,
    `runtimeVerdict` decides which findings are verified at runtime).
  - **Tests.** New core `test/review/runtime.test.ts` (37). Added: core
    `permission.test.ts` +4, `config.test.ts` +7, `prompt.test.ts` +8
    (and the type-import test now covers `./runtime`),
    `model-evidence.test.ts` +2; engine `eval.test.ts`'s refusal test gains
    a typed `@ts-expect-error` case and three refusal lines. Changed on purpose: `config.test.ts`'s
    `OPTIONAL_REVIEW_DEFAULTS` equality gains `runtime: "off"`;
    `model-evidence.test.ts`'s "no others" policy list gains `{ runtime:
    "off" }` and `{ runtime: "ask" }`; the pin. No existing assertion was
    loosened.

- **The lcov probe** (scratch under `/tmp/vector-vectorscope/lcov-probe/`
  and `lcov-probe2/`, never committed). Bun 1.3.14's `bun test --coverage
  --coverage-reporter=lcov` writes `coverage/lcov.info` with `TN:`, `SF:`
  relative to the directory the tests ran in, `FNF`/`FNH`, `DA:<line>,<hits>`
  for executable lines (0 included; not every line, e.g. a `return` after
  a `const` was not listed), `LF`/`LH` and `end_of_record`; no `BRDA`; the
  test file is left out. Run from a sibling package (`pkg-b`) whose test
  imports `../../pkg-a/src/lib`, it writes `SF:../pkg-a/src/lib.ts` and
  `SF:local.ts` (critique point 1). Both reports are inlined in
  `runtime.test.ts`, the sibling one shortened. The coverage run exited 0.

- **Decisions and deviations from the contract.**
  - (a) **`runtimeVerdict(head, base, tie, commits): RuntimeResult`**, not
    the contract's `(head, base) → verdict`. The two-argument form cannot
    say that the failing assertion is the finding's (`tie`), which commits
    the runs were of (`commits`, critique point 3), or which finding the
    verdict is for (the result's `finding`, critique point 9). Only records
    whose `reproducerFor` is the tie's finding count, and never a run of a
    `COVERAGE_COMMANDS` command, bare or with arguments
    (`isCoverageCommand`; critique point 8), so the project's
    suites, coverage runs and other findings' reproducers never decide.
    An empty finding ID decides nothing.
  - (b) **One record per distinct outcome** (critique point 6): `runs`
    runs of one command on one side with the same exit, failure location
    and stop, `ms` their total. The same command, exit and failure twice on
    a side is refused (inconclusive), so a run cannot be counted in both a
    run-length and a per-run record. The plan's claim that both forms give
    the same verdict is dropped. `commit`, `failure?`, `stopped?` and
    `output?` are additions to the contract's interface (`output` must be
    carried to be wrapped as untrusted).
  - (c) **"The failing assertion" needs a location the executor sets, and
    signals decide nothing** (critique point 2, its first option). Exit
    codes alone cannot tell a failed assertion from an import or compile
    error: a reproducer that imports a symbol the change renamed fails on
    head and passes on base, which would "confirm" the change's intended
    behaviour. So `RuntimeEvidence.failure` (`assertion` or `error`) is
    set by the executor from its own runs' exit codes, never from the
    run's output (for example a control run of the reproducer without its
    assertions, which must pass on both sides; the mechanism is executor
    work), and "confirmed" needs `failure: "assertion"` on every failing
    head record. A failure without a location never confirms. A status of
    128 or more (`SIGNAL_EXIT`: a signal, 128 + n, or a Windows NTSTATUS)
    is inconclusive on either side, since a kill for memory or time can
    differ between head and base; the plan's 139 case now expects
    inconclusive, and an import-error case was added. This is stricter
    than the contract's "every head run fails", and it is how this package
    reads "the failing assertion is tied to the finding".
  - (d) **The truth table** (assertion "tied", two runs each): only head
    fails at an assertion with base passing is "confirmed"; head passes
    gives "contradicted" whatever base did, unless a base run was stopped;
    every other cell, fails/fails included (a pre-existing defect or a
    broken test), is "inconclusive". "untied" and "unchecked" make every
    cell inconclusive. It is also inconclusive when a side has no run, a
    run is of another side or commit, a run is stopped or signalled, a
    count or status is not a whole number, a failure location sits on a
    passing run, a command ran on one side only or fewer than
    `RUNTIME_LIMITS.runs` times on a side, an outcome is recorded twice, or
    an expected commit is empty. So "contradicted" also needs a tie and
    complete, bound runs on both sides.
  - (e) **Coverage** adds `uncovered` (ascending, capped at 200;
    `changed` and `covered` stay exact) and `unmeasured`, so an unloaded
    file never reads as 0% or 100%; docs and test paths are not mapped.
    **Paths** (critique point 1): `cwd` is the directory the coverage
    command ran in, repository-relative (or absolute under `root`); a
    relative `SF:` path is joined onto it and normalised (`.`, empty
    segments and `..` applied); `root` strips only absolute paths, which
    are skipped without it; only a path that still leaves the repository
    is rejected, silently. Backslashes read as `/`. The unmeasured wording
    is "the coverage report has no record of this file". Other lcov lines
    that are not a known record type count as malformed (the plan ignored
    them silently).
  - (f) **`CHECK_COMMANDS` exported frozen; `COVERAGE_COMMANDS` is Bun
    only, with its report path.** pytest (needs a plugin), `go test` (its
    cover profile is not lcov), cargo and the npm-family runners wait for
    verified exact flags.
  - (g) **The block is a standalone builder plus a trusted instruction
    constant**, with no `PromptInput` field: its consumer (the repro pass
    prompt or the verify prompt) is executor work. It renders each record
    (at most 20) as `<untrusted_runtime_run>` with `command`, `kind`
    (`coverage` on a coverage run only), `side`, `commit` (short), `exit`,
    `runs`, `ms`, `finding`, `failure` and `stopped`, and the end of its
    output; after a head record with coverage,
    `<untrusted_runtime_coverage>` (at most 30 files, at most 20 ranges, an
    ellipsis when cut). Past the record or file cap a line says how many
    are not shown (`(N more run records not shown)`, `(N more changed files
    not shown)`), so a cut list never reads as complete (I-7). Coverage on
    a base record is not shown (critique point 7: it maps head lines only).
    The caller redacts `output` first, as CI log excerpts are redacted
    upstream (critique point 13, I-4); the block redacts it again with the
    `secrets` it is given and `redactSecrets`' token shapes, before it keeps
    the end and escapes it. The instruction adds that a `kind="coverage"`
    run's exit status is not a check result. Its digest entry is gated on
    `runtime: "ask"`.
  - (h) **The `runtime` key is trusted-only and unapplied.**
    `mergeReviewConfig` leaves out a default, generalising "an empty list
    is left out" to `Array.isArray(v) ? v.length > 0 : v !==
    OPTIONAL_REVIEW_DEFAULT_OF[key]` (read through `Object.entries`, with
    no cast), so an explicit "off" changes nothing and `zdrAttested`
    behaves as before. The not-applied warning comes from
    `mergeReviewConfig`. On github it is read from the base review.json,
    per §1.1, while the refusal in CI stays the executor's reason `ci`, so
    either answer to Q8 stays possible.
  - (i) **The engine eval's sourced check** leaves sourced keys that are
    also unapplied to the unwired message, so `runtime` reads `config sets
    runtime, which no runner applies yet (the VS-30 executor), so the
    artifact would record a setting the run did not have.`; the
    route-setting message for `privacy` and `zdrAttested` is unchanged.
  - (j) **`CHECKS_NOT_RUN`** (22, in order): `no-consent`, `pr`, `fork`,
    `untrusted`, `ci`, `surface-unsupported`, `uncommitted`,
    `network-unfiltered`, `isolation-unavailable`, `base-unavailable`,
    `no-command`, `dependencies-unavailable`, `services-unavailable`,
    `config-unavailable`, `fixtures-unavailable`, `no-reproducer`,
    `route-refused`, `reproducer-refused`, `timeout`, `output-limit`,
    `budget`, `head-moved`. Beyond the amendment's list: `fork` and
    `no-command` (the plan), and, from critique point 5, `uncommitted`
    (worktrees for uncommitted changes are deferred), `base-unavailable`
    (no base commit or merge base in a shallow clone), `output-limit` (it
    is a stop, as `timeout` is), `reproducer-refused` (a write outside the
    test paths, traversal or a symlink), `no-reproducer` (the repro pass
    returned none or failed), `route-refused` (I-3 refused the repro
    model call), `budget` (the runtime budget; the p90 goal is 6 minutes)
    and `surface-unsupported` (the desktop before VS-10, GitHub before its
    job). `network-unfiltered` also covers reachable loopback. Their note
    text waits for wiring (D14).
  - (k) **`applyRuntimeVerdict(finding, result)`** is the testable form of
    "only confirmed changes anything": a confirmation whose `finding` is
    this finding's ID returns a copy with `verified: true` and `verifiedBy:
    "runtime"`; anything else returns the same object.
  - (l) **`RuntimeTie`** (critique point 4): "tied" comes only from a
    trusted check independent of the reproducer's author (deterministic,
    or a separate pass that did not write the reproducer), never from the
    reproducer, its output or PR text; without one the tie is
    "unchecked". It is a necessary condition, never a sufficient one, so
    model output never acts as a verdict (I-2). Which check is executor
    work, so either design stays possible.
  - (m) **§0.3 item 4: no replay variant.** VS-30 refuses on the untrusted
    CI checkouts eval replays use (`eval.ts:13`), and its measurable goal
    needs a local-only trusted harness, so the variant comes with the
    executor.
  - (n) **§0.3 item 5: the desktop is a documented difference** until VS-10
    and VS-12 (`variant.applied: false` once a variant exists).
  - (o) **VS-42's open question (q).** A confirmation needs every base run
    to pass, so a runtime-confirmed defect is one its reproducer does not
    show at the base. Whether that exempts the finding from S9 stays VS-42
    wiring's decision.

- **Deferred.**
  - **To the VS-30 executor** (after `self-evolving`, VS-12 and VS-18):
    head and base worktrees through a trusted `self-evolving` API; the
    `offline()` refusal and loopback denial; a clean environment with
    `CI=1` and no keys, writes only inside the worktree; the 120 s and
    80 KB limits; the dependency check; aborting when the head moves;
    reading `coverage/lcov.info` only inside the worktree with a byte cap
    before parsing (`LCOV_LIMITS.chars` is checked on a string already in
    memory; critique point 8); the repro pass (at most 3 files,
    StructuredOutput, no write tools) and its prompt; the trusted tie
    check (decision (l)) and the failure location (decision (c)); redacting
    output before any prompt, with the environment's secret values passed
    to `runtimeEvidenceBlock` as well, and an end-to-end test that a secret
    a reproducer prints never reaches the prompt; worktrees for uncommitted
    local changes;
    simulation-first runs on past PRs, posting nothing [GP17]; fix
    validation by re-running the deterministic check that raised a
    finding [CF12]; and the no-network and no-secrets enforcement (already
    I-6).
  - **To VS-12:** the `--checks` consent integration, single-use and bound
    to the head SHA and the command digest (D10).
  - **To the next package that touches `trivial.ts`:** one exported
    `isTestPath(path)` there, used by `runtime.ts`, `impact.ts` and
    `risk.ts`, which each hold the same `TEST_PATHS` minimatch predicate
    today (review fixes below).
  - **To wiring:** the "checks not run: <reason>" notes and their text
    (D14); the `ReviewOutcome` field (the types move to `types.ts` then,
    as VS-27a's did); attaching evidence to its finding and
    `StrictFinding.verifier` (addendum §3 VS-27); whether the evidence
    scope records "ask" or the runtime evidence that ran, since consent is
    per run (critique point 12); `runtime` leaving `UNAPPLIED_REVIEW_KEYS`
    and `WIRING`, which moves the runtime digests on purpose.
  - **To the @vector merge:** the GitHub unprivileged job (V16).
  - **To after VS-10:** the desktop half.
  - **Never, until measured:** OpenTelemetry. **Never:** eBPF (§9).
- **Deferred verification.** Real lcov from runners other than Bun; macOS
  and Windows path forms are tested only as strings; a Windows drive
  letter's case is not normalised (VS-30 refuses on Windows anyway); the
  full root typecheck before any push.
- **Off by default (I-1, I-12).**
  - `parseReviewConfig`, which every surface reads today, is unchanged for
    every input: `runtime` is a sourced key, so review.json's copy was
    and stays an unknown key, and there is no environment variable.
  - `mergeReviewConfig` has no caller; its output is unchanged for every
    input without `runtime`, and an explicit "off" is left out.
  - `reviewPermissionRules` is byte-identical: four golden digests printed
    at `213aabe9` before the edit (`03ee3c8b157dfcba`, `907b31028ef0edd2`,
    `93945324ead2fea5`, `10537fa7f8acdd1d`) still hold.
  - No prompt builder changed. The block enters `canonicalPrompts` and
    `promptsDigest` only under `runtime: "ask"`, and `evidenceScope` passes
    it only once applied, so every pinned digest holds: `5d59e9ee06077c23`,
    `74a2111826c226b1`, `b98afb0e878dfe26`, `3ba21b5bc883cd70`,
    `4aa712221043a3a7`, `8335adf9de513ee5`, `d209592d08bb1e0c`,
    `468fcac8cde18fe2`, `0f3ff2dd0f7c1d7d`, `dd09332295a99649`,
    `31c1a0612c0f9541`, `0ebaacbe7aca1b58`. New, pinned: runtime
    `7d9147298f5cdbaf`, with graph `3bf0c1afc17e08d9`, with strict
    `8c5154b47a05f952`, with the lens pair `bcb1c5c5258319f1`.
  - `policyDigest` of the default stays `70512122f41ec160` for `runtime`
    "ask", "off" and absent.
  - No runner, CLI, desktop or GitHub file changed, so each runner's
    requests and outcomes are identical; the parity suites below are
    green with their HEAD counts.
- **Owner questions.** None new. Q8, Q13, Q15 and Q18 stay open, and this
  package is neutral on them: nothing runs, the key is read only from
  trusted sources on both surfaces, and the reasons cover either answer.
  Q1 to Q17 and Q19 to Q34 are untouched.
- **Predicted merge conflicts.** Read-only: a three-way `git merge-file`
  of each touched file that either branch changes, at HEAD and with
  VS-30c, against each branch's merge base and tip, into
  `/tmp/vector-vectorscope/vs30c/merge/`. `origin/codium` (`5a079cbd`)
  changes `config.ts`, `prompt.ts` and `types.ts`; `origin/self-evolving`
  (`f062bcce`) changes `types.ts`. Neither touches `permission.ts`,
  `model-evidence.ts`, engine `eval.ts` or the tests, and neither has
  runtime code. `config.ts` and `prompt.ts`: no conflict, at HEAD or with
  VS-30c. `types.ts`: 2 conflict hunks with codium and 1 with
  self-evolving, the same hunks at HEAD and with VS-30c (VS-27a's
  pass-name lines); VS-30c's three hunks merge cleanly.
- **Evidence.** Each file was run alone through the lock with `--timeout
  30000`, from its package directory, with `TMPDIR` and fresh XDG roots
  under `/tmp/vector-vectorscope/vs30c/`. Counts are at HEAD → with VS-30c.

  | File | HEAD | VS-30c |
  |---|---|---|
  | core `test/review/runtime.test.ts` | — | 37 |
  | core `test/review/permission.test.ts` | 10 | 14 |
  | core `test/review/config.test.ts` | 65 | 72 |
  | core `test/review/prompt.test.ts` | 39 | 47 |
  | core `test/review/model-evidence.test.ts` | 28 | 30 |
  | core `test/review/diff.test.ts` | 52 | 52 |
  | core `test/review/select.test.ts` | 45 | 45 |
  | core `test/review/format.test.ts` | 51 | 51 |
  | core `test/review/guardrail.test.ts` | 59 | 59 |
  | core `test/review/schema.test.ts` | 64 | 64 |
  | core `test/review/pipeline.test.ts` | 2 | 2 |
  | core `test/review/plan.test.ts` | 26 | 26 |
  | core `test/review/holdback.test.ts` | 16 | 16 |
  | core `test/review/privacy.test.ts` | 48 | 48 |
  | core `test/review/verdict.test.ts` | 45 | 45 |
  | core `test/review/risk.test.ts` | 46 | 46 |
  | engine `test/review/eval.test.ts` | 32 | 32 |
  | engine `test/review/run.test.ts` | 44 | 44 |
  | engine `test/cli/github.review.test.ts` | 40 | 40 |
  | engine `test/cli/review.test.ts` (critique point 10) | 24 | 24 |
  | engine `test/review/structured-output-review.test.ts` (critique point 10) | 3 | 3 |
  | app `ai-review.test.ts` (`--preload ./happydom.ts`) | 107 | 107 |
  | app `src/browser-bundle.test.ts` | 4 | 4 |
  | eval `replay.test.ts` (from `script/vectorscope-eval`) | 32 | 32 |
  | eval `report.test.ts` (from `script/vectorscope-eval`) | 33 | 33 |

  - **Typecheck.** `bun typecheck` passes in core, engine and app (exit 0;
    core was clean at HEAD too). The eval scripts pass `bun tsgo -p
    ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`.
  - **Lint.** prettier is clean on every changed TypeScript file except
    `prompt.ts`, whose one off-format line (`input.requirements`) predates
    this package; VS-30c's hunks there are prettier-clean. oxlint reports
    0 warnings on `runtime.ts` and `runtime.test.ts`, and none of the
    warnings on the other changed files falls in a VS-30c hunk (checked
    line by line against `git diff -U0`).
  - **Mutations.** Each was applied alone, its test file run, and the file
    restored byte for byte (checked by hash, copies under
    `/tmp/vector-vectorscope/vs30c/mut/`; no `git stash` or reset). All 57
    were caught; one ("a deleted file mapped") first survived, because the
    deleted case had no added lines, and is caught since a deleted file
    whose hunks claim added lines joined the test.
    - `runtimeVerdict` (16): the tie check dropped; a stopped run allowed;
      the run minimum dropped; a mixed base allowed; "contradicted" before
      the tie check; "confirmed" with one failing head run; the
      `reproducerFor` filter dropped; the command-set check dropped; a side
      mismatch accepted; the commit binding dropped; signal exits allowed;
      the failure location dropped; duplicate outcomes allowed; coverage
      runs counted; a failure location on a passing run accepted; an empty
      expected commit accepted.
    - `applyRuntimeVerdict` (2): un-verifying on "contradicted"; the
      finding ID check dropped.
    - `parseLcov` (12): the character, file, line and line-length caps
      dropped (4); line 0 accepted; a `DA:` outside a record accepted;
      last-wins merging; the root not stripped; an escape past the root
      accepted; `cwd` ignored; an `SF:` before `end_of_record` not counted;
      every skipped record type counted malformed.
    - `changedLineCoverage` (5): deleted files mapped; test files mapped;
      the uncovered cap dropped; an unmeasured file read as 0%; the `paths`
      filter dropped.
    - `prompt.ts` (8): the output not escaped; an empty list rendering;
      clipping from the start; base coverage shown; the record cap dropped;
      the range cap dropped; the ellipsis for an upstream cap dropped; an
      unmeasured file worded as measured.
    - `model-evidence.ts` (4): `runtime:ask` dropped from the memo key; the
      block rendered without the key; `evidenceScope` passing `runtime`
      while unapplied; `runtime` dropped from `EVIDENCE_POLICY_KEYS`.
    - `config.ts` (5): the working tree trusted; the environment read as a
      trusted source; an explicit "off" assigned; the not-applied warning
      dropped; the global config trusted on github.
    - `permission.ts` (3): the coverage command allowed to the model;
      `CHECK_COMMANDS` not frozen; the coverage command loosened.
    - engine `eval.ts` (2): `WIRING.runtime` naming another package; the
      sourced filter dropped.
  - **Not run.** The full root typecheck was not run, since nothing is
    pushed.
  - **Not done.** Nothing was sent to a model; there was no paid run, no
    workflow dispatched, nothing published and nothing committed; no MCP
    access changed and no user-visible string changed (D14).

### 2026-11-07 · VS-30c review fixes

Eight review findings, one of them blocking; two of the non-blocking ones
are the same finding (the cap markers). Six were fixed in code, the
redaction one both in code and as an executor test requirement. One
(`isTestPath`) asked for no change now and is handed off in the entry
above. Only core `review/runtime.ts`, `review/permission.ts`,
`review/prompt.ts`, `review/model-evidence.ts` (one call, one comment and
the pin) and their tests changed, with this log. No runner, provider, LLM
or posting file, no prompt builder and no file @vector owns changed. The
entry above is updated in place where its facts changed (`parseLcov`'s
SF rule, `isCoverageCommand`, the block's signature, attributes, markers
and redaction, decision (a), decision (g), the pin, the four runtime
digests, the hand-offs and two test counts). Nothing is committed.

- **An over-cap `SF:` left the open record open** (blocking,
  `runtime.ts:232`). Confirmed: `SF:src/a.ts`, `DA:1,1`, an `SF:` over
  `lineChars`, `DA:7,0`, `end_of_record` gave `src/a.ts` the lines
  `[[1,1],[7,0]]`, so a hostile or broken report could make another
  file's changed line read as covered once hits merge. Fixed as suggested:
  a line over the cap that starts with `SF:` counts one more malformed when
  a record is open and closes it (`open = false`, `lines = undefined`), so
  its `DA:` lines fall outside any record and count as malformed. The
  over-cap branch now runs before the line is sliced, so the text is still
  never copied. The docstring says the rule holds for an over-cap `SF:`.
  Tests: the unterminated `src/a.ts` before an over-cap `SF:` with two `DA:`
  lines keeps only its own line (malformed 4: the long line, the record it
  closed, and its two `DA:` lines), with LF and CRLF, under a `paths`
  filter, and after an earlier `src/a.ts` record whose line 7 has 0 hits
  (it stays 0, not 5); an over-cap line that is not an `SF:` (a long `FN:`)
  leaves the record open.
- **Coverage runs were excluded only by an exact command match**
  (`runtime.ts:306`). Fixed, in one place rather than two: core
  `permission.ts` gains `isCoverageCommand(command)`, true for a
  `COVERAGE_COMMANDS` command bare or followed by a space and arguments,
  and `runtime.ts`'s `decides()` uses it (the `COVERAGE_RUNS` set is gone).
  `prompt.ts` uses the same predicate for the next fix but one. Tests: a
  coverage command with a test path, and one with `-t race`, tagged with
  the finding, decide nothing; `permission.test.ts` gains a case for the
  predicate (bare, a path, a test name; not a longer flag, a leading
  space, any `CHECK_COMMANDS` entry, `bun test --coverage` or the empty
  string).
- **The block cut runs and coverage files without saying so**
  (`prompt.ts:651` and `:667`, two findings). Fixed: past
  `MAX_RUNTIME_RECORDS` a line `(N more run records not shown)` comes after
  the last run, inside `<untrusted_runtime_evidence>`; past
  `MAX_COVERAGE_FILES` a line `(N more changed files not shown)` ends the
  coverage body (singular for 1), from a private `notShown`. "Run records"
  rather than "runs", since each record's `runs` attribute already counts
  runs. Both render only past a cap, and `CANONICAL_RUNTIME` is under every
  cap, so these lines move no digest; its comment says so. Tests: the caps
  test asserts each marker at 21 and 25 records and at 31 and 35 files, and
  none at exactly 20 records or 30 files; `model-evidence.test.ts` asserts
  the canonical block has none.
- **Style in `parseLcov` and `normalised()`** (`runtime.ts:223`, `:370`).
  `parseLcov` keeps its `let` bindings and index loop, with a comment that
  the scan is imperative on purpose so a report up to `LCOV_LIMITS.chars`
  is never split into an array of lines. `normalised()` is now a `reduce`
  over `path.split("/")` that returns undefined on an escape. It changes
  its accumulator in place (`push`, `pop`), as `lineRanges` in `prompt.ts`
  does, because a copying reduce is quadratic in segments and one `SF:`
  line under `lineChars` can hold about 2,000 of them; the comment says so.
- **Redaction was left to the caller alone** (`prompt.ts:647`). Both
  options taken. `runtimeEvidenceBlock(evidence, secrets)` takes a
  required `secrets` list and runs `redactSecrets` on each output before
  `clipEnd`, so a secret across the cut is never half shown, and the
  token shapes are redacted even when the list is empty. The caller still
  redacts first (I-4), and redacting twice is harmless. Required rather
  than optional, so a future caller has to name the secrets.
  `canonicalPrompts` passes `[]`; "Example." holds no token shape, so no
  digest moved for this. The entry's executor hand-off now names an
  end-to-end test that a secret a reproducer prints never reaches the
  prompt. Tests: a given secret and a `ghp_` token are replaced with
  `[redacted]`; a token is replaced with no secrets passed; a secret at
  the start of an output cut to its end leaves no tail.
- **A third copy of the test-path predicate** (`runtime.ts:392`). Not
  changed now, as the finding suggests: one `isTestPath` exported from
  `trivial.ts` would touch `trivial.ts`, `impact.ts` and `risk.ts`, all
  pinned. Handed off in the entry above to the next package that touches
  `trivial.ts`.
- **A coverage run's exit read like a check result** (`prompt.ts:636`).
  Fixed by the attribute option: a run whose command `isCoverageCommand`
  matches carries `kind="coverage"` after `command`, and
  `RUNTIME_EVIDENCE_INSTRUCTION` ends with `A run marked kind="coverage"
  only measured which lines ran: its exit status is not a check result.`
  `exit` stays on coverage runs: a signal or a crash still says whether
  the coverage it measured can be whole, and the attribute and the
  sentence already say it is no pass or fail. `prompt.ts` now imports
  `isCoverageCommand` from `permission.ts`, which is browser-safe (one
  type-only import); the app's browser-bundle test still passes. Both
  changes are in the canonical block under `runtime: "ask"`, so only the
  four runtime digests moved, re-pinned: runtime `0e1733163ed4d01f` →
  `7d9147298f5cdbaf`, with graph `158cac2848b3d329` → `3bf0c1afc17e08d9`,
  with strict `c7e148dbe32420c2` → `8c5154b47a05f952`, with the lens pair
  `471a3d77a34ad531` → `bcb1c5c5258319f1`. The twelve earlier digests and
  `policyDigest`'s `70512122f41ec160` hold. Tests: a coverage run, bare and
  with a path, is marked; a reproducer, `bun test` and `bun test
  --coverage` are not; an output that writes the attribute stays escaped;
  the instruction test asserts the sentence; `model-evidence.test.ts`
  asserts the marked coverage run in the canonical block.

- **Pin.** `REVIEW_PIPELINE_SOURCES` `f0821f198d7efda6` →
  `dd477fd3a04e6efb` (`runtime.ts` and `prompt.ts` changed;
  `permission.ts` and `model-evidence.ts` are not pipeline files).
  `REVIEW_PIPELINE_REVISION` stays 1.
- **Off by default (I-1).** No runner, CLI, desktop, GitHub or prompt
  builder file changed, and nothing calls `runtimeEvidenceBlock`,
  `runtimeVerdict`, `parseLcov` or `isCoverageCommand` outside tests and
  `canonicalPrompts` (under `runtime: "ask"` only). `reviewPermissionRules`'
  four golden digests still hold.
- **Evidence.** Each file alone through the lock with `--timeout 30000`,
  from its package directory, with `TMPDIR` and fresh XDG roots under
  `/tmp/vector-vectorscope/vs30c-fix/`: core `runtime.test.ts` 37 pass
  (cases extended, no new tests), `permission.test.ts` 14 (13 before),
  `prompt.test.ts` 47 (45 before), `model-evidence.test.ts` 30; app
  `src/browser-bundle.test.ts` 4. `bun typecheck` passes in core, engine
  and app. prettier is clean on every file changed here except
  `prompt.ts`'s one older `input.requirements` line, left as it was;
  oxlint reports nothing in these hunks. Sixteen mutations, each applied
  alone, its test file run and the file restored by hash (scripts under
  `/tmp/vector-vectorscope/vs30c-fix/mut/`), all caught: the over-cap
  `SF:` close dropped, and not counted; the exact-match coverage guard;
  `isCoverageCommand` without arguments, and without the space; the run
  marker dropped, the file marker dropped, and a marker at zero; no
  redaction, the secrets ignored, and redaction after the cut; `kind`
  dropped (in `prompt.test.ts` and in `model-evidence.test.ts`) and on
  every run; `normalised()` accepting an escape, and keeping `.`.
- **Not run.** The full root typecheck, since nothing is pushed.
- **Not done.** Nothing was sent to a model; there was no paid run, no
  workflow dispatched, nothing published and nothing committed; no MCP
  access changed and no user-visible string changed (D14).

## 2026-11-07 · VS-29a Cross-family replay variant (measurement only)

Contract §4 VS-29a of `vectorscope-upgrade.md` (29a, now: measurement only,
no new key), §1.1 ("There is no new verifier key"), §1.3 (the cross-family
verifier "works today" on every surface) and §7 C-3 (no claims; measure
the existing `triageModel`/`model` pair at equal tier; A/B). Addendum A
§3 VS-29 and the round-two amendment, which changes nothing in the
variant, its `models: "triage-pair"` flip or `admitReplay`'s two-model
check, and drops the brief's provider-prefix stopgap. Evidence: research
`REPORT.md` finding 4 and §4.5, `evidence.md` §2.2 and its sources
(`:100`, `:118`, `:538`), and round-two `REPORT.md` finding 11 [VOI15].
Built at `3281d09e` (VS-30c). Now window only: eval scripts, the eval
entry point (VS-21c), the eval workflow and tests; no `ReviewConfig` key,
no core module and no runtime code. It implements the VS-29a plan as
corrected by its critique: eight critique points were taken, and two were
taken in part, with the reasons below. Nothing is committed (the lane
brief).

- **Citations re-located at `3281d09e`** (the contract cites `02c23b4c`),
  each re-checked at build time. Core `types.ts` `model`/`triageModel`
  `:490-493` (contract `:247-249`); engine `run.ts` `triage`/`triaged`
  `:251-252` (contract `:226-227`), the specialists asked on `triage`
  `:689-701` (`model: triage` at `:694`), verify after a triage pass
  `:712-724`, only confirmed findings reported `:785-797` (contract
  `:668-681`); `model-evidence.ts` `EvidenceScope` `:106-115`, `triage`
  `:111` (contract `:66-74`), `REVIEW_PIPELINE_SOURCES` `:62`; engine
  `eval.ts` `ReplayInput.triage` `:139`, `VariantRecord.models` `:185-193`,
  the projection's `triaged` `:664-668`, `scope`/`models` `:702-704`,
  `variantProblem`'s pair refusal `:1198-1200`; app `ai-review.ts` reads
  `triageModel` at `:772-773`; `desktop.ts` writes `scope.triage` at `:166`
  and `appliable()` is `:247-251`.
- **Untouched:** `run.ts`, `eval.ts`, `ai-review.ts`, `provider.ts`,
  `session/llm.ts`, `posting.ts`, `desktop.ts`, every core file, every
  engine `src/` file, and every @vector file
  (`workflow.ts`, `command.ts`, `github.*`, `github-*.ts`, the GitHub
  sections of `vectorscope.astro`). `REVIEW_PIPELINE_REVISION` stays 1.

- **What landed.**
  - **`script/vectorscope-eval/replay.ts`.**
    - `VARIANTS["cross-family"].engine` is `{ from: "VS-29a" }`. Its
      desktop half is relabelled `{ pending: "VS-29a's desktop half, after
      VS-10" }` (the §0.3 item 5 difference, below). `planned`, `models:
      "triage-pair"` and the absence of `keys` are unchanged. The entry's
      comment says the pair comes from the eval config, that nothing checks
      its labs or tier, and that the name does not prove the labs differ.
    - The registry doc gains the flip rule for a half made by its models:
      it flips in the package that supplies the models, since the runner
      already runs the pair and nothing about the runner changes.
    - New `triagePairProblem(variant, models)`: undefined only for exactly
      two models with distinct ids, the review model first; otherwise
      `<variant> is made by its models: it needs the review model, then a
      triage model other than it, not <a + b | no model>.` It compares ids
      only. It is the one rule for `admitReplay`, `ci.ts` and the entry
      point, and where `labOf` slots in.
    - `admitReplay`: VS-21a's deferred two-model check (that entry, choice
      two). A `triage-pair` variant whose models fail `triagePairProblem`
      is refused with reason `variant` before `ledger.admit`, so the ledger
      writes nothing. Every other variant, the frozen pipeline with a
      triage model included, is unchanged. Its doc says so. The case key
      and model for the pair are `engine:cross-family <review> + <triage>
      <case>#n` and `<review> + <triage>` (the existing `replayCaseKey`).
  - **`packages/engine/script/vectorscope-replay.ts`** (the eval entry
    point, VS-21c; not runtime code).
    - `--triage-model <id>=<in>:<out>`, parsed with the `--model` grammar
      and `parsePrice` into `ReplayFlags.triage`. Refusals, in the code's
      order: a missing value (the existing valueless check, first); a
      malformed value; the flag with no variant made by its models; a pair
      variant without the flag (`triagePairProblem` plus ` Give
      --triage-model.`); and a triage id equal to `--model`. The last two
      apply to a run that stays dry only (the review fixes below).
    - `replayMode`: a run that would send with a triage model, or naming a
      variant made by its models, is refused whatever its models: `A paid
      cross-family replay is not wired: engine:cross-family and
      --triage-model run dry only, until the owner chooses the pair (Q5)
      and funds its ablation (Q9).` `--dry-run`, or no budget, stays dry.
    - `main` checks the triage model with `catalogModel` (in the committed
      catalog, calls tools, priced above zero, at that price) and exits 2
      before anything is created.
    - `engineConfig`'s dry input takes `triage`, and the one dry provider
      lists both models, each from its catalog entry (`dryModel`, shared by
      both), with the same dummy key. Without it the text is byte-identical
      to `3281d09e`'s (checked for three catalog models and the paid
      config, `/tmp/vector-vectorscope/vs29a-exp/check.ts`).
    - `projectDry`: only a variant whose record has `models:
      "triage-pair"` gets the triage model (`projectionModel`) as
      `ReviewEval.project`'s `triage`. Its file names both models, and the
      summary line names the triage model as the first pass of those
      variants and says the pair's labs are unchecked until codium's
      `labOf` merges.
    - `outputName(models, ...)` joins each model's slug with `+`, which the
      slug never writes, so one pair's name is never another's. The paid
      branch passes `[--model]`, so its names are unchanged. `ci.ts seal`
      reads every top-level file, and `report.ts` and `certify.ts` every
      `.json`, so `+` is read as before.
    - The paid branch is unchanged and unreachable with a triage model.
  - **`script/vectorscope-eval/ci.ts`.** `Inputs.triageModel` from
    `EVAL_TRIAGE_MODEL`, trimmed, with the `models` grammar. Problems: a
    malformed value (quoted as JSON, one line); the input on the smoke
    pipeline; the input with no variant made by its models among the
    named (or default) variants; in a dry run, a named pair variant without
    the input (`triagePairProblem` plus ` Set triage_model.`, once per
    model) and a triage model equal to a `models` entry
    (`triagePairProblem` per model); and, with `mode: paid`, a pair variant
    or the input, refused once as dry only whatever the models (the review
    fixes below). `replayArgs` inserts `--triage-model` right after the
    `--model` pair, only when set. The plan text gains one line, only when
    set, naming the pair variants and saying that nothing checks the pair's
    labs or tier until codium's `labOf` merges and the owner chooses the
    pair (Q5). A small `pairedVariants` helper is shared by `parseInputs`
    and `planReplay`.
  - **`.github/workflows/vectorscope-eval.yml`** (edited, never
    dispatched). A new optional `triage_model` input (`default: ""`,
    `type: string`), `EVAL_TRIAGE_MODEL: ${{ inputs.triage_model }}` in
    the plan, project and paid steps, and one header sentence. That makes
    11 inputs. GitHub raised the `workflow_dispatch` input limit from 10 to
    25 on 2025-12-04
    (https://github.blog/changelog/2025-12-04-actions-workflow-dispatch-workflows-now-support-25-inputs/);
    the lane cannot dispatch to check it, so `ci.test.ts` pins the count
    at 11, and at most 25, and a later addition fails loudly. The limit
    itself is not verified (the review fixes below): confirm it before
    this is pushed or merged.
  - **`script/vectorscope-eval/README.md`.** The `triage_model` row in
    "Budgeted CI runs", a replay-pipeline bullet, the registry row (engine
    built (VS-29a), desktop pending, after VS-10), the made-by-its-models
    flip rule, the `--triage-model` usage, bullet and file names in "Paid
    entry point", and a new "Cross-family pair (VS-29a)" section: what it
    runs, how the pair is supplied, what is recorded, the refusals, the
    baseline, what is not checked, paid replays, the desktop half and the
    claim.
  - **Tests** (below), with no existing assertion loosened: the
    pending-refusal row for `engine:cross-family` became
    `desktop:cross-family`'s, the built list gained `engine:cross-family`,
    and the pending count became `2 * entries.length - 3`.

- **The stopgap not built, and why.** The brief's "small eval-script-only
  provider-prefix check" would be a second cross-lab checker, which
  contract §0.5 forbids beside codium's `labOf`/`checkedLabs`
  (`codium:packages/core/src/model-lab.ts:94`,
  `codium:packages/core/src/review/second-lab.ts:31`), and the VS-21a
  entry recorded "No family or lab check was built". `origin/codium` is
  not merged into this branch (checked: `git merge-base --is-ancestor`
  fails, and no `labOf` exists here). So the same-lab refusal stays
  pending codium's `labOf`, as the round-two amendment says, and the README
  and this entry say so. A replay-test line keeps a same-vendor pair
  (`vendor-a/x`, `vendor-a/y`) passing `triagePairProblem` as a named
  tripwire, commented as the pending refusal, not wanted behaviour: it
  changes when `labOf` lands. Until then the variant's name does not prove
  the labs differ, and a same-lab pair projected under it would be
  mislabelled data; `models.review` and `models.triage` are in every
  artifact and projection, so a later lab check can re-check them offline.
- **Departures from the contract's file list.** The list says "script
  variant; no runtime code", and VS-21a expected the flip "in the script
  alone". This package also edits the entry point, `ci.ts` and the
  workflow, and two engine test files. None is runtime code. The reason:
  once the entry is built, `ci.ts`'s `variantRecord` accepts
  `engine:cross-family` in `EVAL_VARIANTS`, and without a triage model the
  entry point would then exit 2 on every plan job that names it; and "Done:
  the variant runs in Phase A projections" needs the pair from the eval
  config. If `ci.ts` and the workflow were ever cut from the package,
  `ci.ts` must still refuse a pair variant without a triage model.
- **Design choices.**
  - The triage model applies only to the variants made by their models, so
    a dispatch's frozen and key-only variants run exactly as without it
    (tested, I-1 below).
  - Paid is refused rather than wired, which keeps an untested money path
    out of the code until Q5 and Q9. A paid pair would resolve the triage
    model with `resolveReviewModel` and admit both models; deferred.
  - No tier check: a price is not a capability, and equal tier is the
    owner's choice of pair (Q5).
  - **The baseline** (critique, major). Under a triage model every finding
    of concern or above is double-checked, `verify: off` is ignored and
    only confirmed findings are reported, so `report.ts --candidate
    engine:cross-family --baseline engine` would credit that triage-mode
    effect to cross-family checking. The README says the frozen `engine`
    and `engine:shared-verify` are not this variant's baseline, and
    `report.ts` now refuses the comparison (the review fixes below). The
    comparison arm is the same pipeline with an equal-tier pair from one
    lab. It has no registry name and cannot run, not even dry, until the
    owner decides the pairs (Q5) and funds the ablation (Q9); it was not
    built.
  - The desktop half is relabelled "after VS-10". The desktop runner reads
    `triageModel` and runs the pair today (contract §1.3;
    `ai-review.ts:772-773`), and `desktop.ts` already writes `scope.triage`
    when the runner reports one (`:166`). The gap is in the eval adapter:
    `desktop.ts` takes one model, records no triage model in its `models`,
    and `appliable()` refuses a keyless variant; and no desktop replay is
    paid or projected before VS-10 (VS-21c's deferral).

- **Critique points.**
  1. *The `+` slug* (major): taken, by the first option. The model part is
     `${slug(model)}+${slug(triage)}` outside the slug; `outputName` takes
     the models, and the paid branch passes `[--model]`. The plan's "the
     slug keeps `+`" was wrong and is corrected here. A mutation that
     slugs the joined string turns the subprocess test red.
  2. *The measurement baseline* (major): taken, in the README and above.
  3. *I-1 evidence* (major): taken. The existing subprocess test is
     unchanged. A new posix test runs `engine` and `engine:shared-verify`
     without the flag, then `engine`, `engine:shared-verify` and
     `engine:cross-family` with `--triage-model`, and compares the two runs'
     frozen and key-only records whole: every pass's model, prompt digest,
     chars and request bodies, plus `scope` and `models`. Only the run's
     own temporary directory, which the prompts name, is normalised, and so
     the digests of those bodies are left out; the two work directories'
     names have one length, so every count matches. The records have no
     time fields; `source` and `runtime` matched as well and are compared.
     Its timeout is 240 s, not the 120 s the critique named: it runs two
     subprocesses (about 5 s each here) where the single-run tests have
     120 s. That is a bound, not a loosening.
  4. *The refusal order* (minor): taken. The entry describes the code's
     order (the missing value first), and each refusal test has one fault.
  5. *Off-by-one citations* (minor): taken in part. Every citation was
     re-checked at build time. The critique's corrections were themselves
     off: at `3281d09e` `triage`/`triaged` are at `run.ts:251-252` (as the
     plan had), the specialists at `:689-701`, verify at `:712-724` and the
     confirmed-only filter at `:785-797`.
  6. *The 11th input* (minor): taken: the changelog URL above and the
     count assertion.
  7. *The same-vendor test* (minor): taken: kept only as a named tripwire,
     and the README and this entry say the name does not prove the labs
     differ.
  8. *Missing mutations* (minor): taken, with more (below).
  9. *The claim's wording and the desktop difference* (minor): taken in
     part. The README attributes the claim to the research report (C-3,
     finding 4, §4.5) and says what is VectorScope's own: nothing. "Capability
     matters more than family" is the report's verdict, and its evidence
     is shown with its marker: Kim et al. is "(recalled)" in
     `evidence.md:100`, while the BIG-Bench Mistake table was read from the
     dataset's repository (`evidence.md:118`), so it is not marked
     recalled. The desktop wording is as corrected above.
  10. *The reason for touching `ci.ts` and the workflow* (minor): taken, in
      "Departures".

- **§0.3 items.** (1) No key. (2) No runner change, so no D3 parity test;
  the engine replay test pins the runner's existing pair behaviour. (3) No
  new key, no `EvidenceScope` or `EVIDENCE_POLICY_KEYS` change; no pinned
  file changed, so `REVIEW_PIPELINE_SOURCES` stays `dd477fd3a04e6efb` (the
  pin test re-run, 30 pass), and `REVIEW_PIPELINE_REVISION` stays 1. (4)
  The variant flipped for the engine. (5) The desktop difference above.
  (6) This entry.
- **Off by default (I-1).** With `triage_model` and `--triage-model` unset,
  every argument array, config text, projection and artifact is unchanged:
  the existing exact-array tests pass untouched, a new test checks that the
  arrays without the triage model hold no `--triage-model`, `engineConfig`
  is byte-identical to `3281d09e`'s, and the subprocess test shows the
  frozen and key-only records unchanged with the flag given. No runner,
  generated code, dependency or user-visible string changed (D14).
- **Owner questions.** None of Q1 to Q34 is decided. Q5 and Q9 stay open:
  no pair was chosen (the tests' `openai/gpt-5` and
  `google/gemini-2.5-pro` are fixture pairs from the committed catalog,
  not recommendations), and paid is refused. Q6, Q13, Q15 and Q18 are
  untouched.

- **Evidence.** Each file alone through the lock with `--timeout 30000`,
  from its own directory, with `TMPDIR` and fresh XDG roots under
  `/tmp/vector-vectorscope/vs29a-*`:
  - `script/vectorscope-eval/replay.test.ts` 37 pass (32 at `3281d09e`;
    36 before the review fixes);
  - `script/vectorscope-eval/ci.test.ts` 33 (30);
  - engine `test/review/vectorscope-replay.test.ts` 18 (13), the new
    subprocess test included;
  - engine `test/review/eval.test.ts` 33 (32): a new `ReviewEval.replay`
    test with `lmstudio/triage-model`, a copy of `test-model` registered by
    the checkout helper's new `triage` option. The artifact's variant is
    the pair record, `models.triage` is the triage model, `scope` is
    `evidenceScope` with `triage`, the review pass and its attempts ran on
    the triage model and verify's on the review model, the rejected
    finding is dropped, the confirmed one is placed and verified, and
    `config.value` is the default (no `triageModel`);
  - `report.test.ts` 34 (33) and `certify.test.ts` 7 (6), each with one
    test from the review fixes; `judge.test.ts` 6 after them;
  - regressions: core
    `test/review/model-evidence.test.ts` 30, core `test/review/eval.test.ts`
    42.
  - `bun typecheck` passes in `packages/engine`, and the eval scripts pass
    `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json` from
    `packages/engine` (as `typecheck.yml` runs it).
  - prettier is clean on every changed code file and on the README. This
    log was already not prettier-clean at `3281d09e` and is left as it is.
    oxlint reports nothing new in the added lines except two `toSorted()`
    calls without a compare in `eval.test.ts`, which follow that file's
    existing pattern.
  - A dry projection of the synthetic case with `--variant engine
    --variant engine:shared-verify --variant engine:cross-family
    --triage-model openai/gpt-5=1.25:10` projected all three, sent nothing
    and logged no connection off this computer. The pair's record has
    `scope.triage` and `models.triage`, its review pass on the triage model
    and verify on the review model.
  - Sixteen mutation runs (fifteen mutations), each applied alone, its test
    file run through the lock and the file restored by hash (scripts under
    `/tmp/vector-vectorscope/vs29a-mut/`), all caught: `admitReplay`'s pair
    check dropped; the triage model on every variant in `projectDry`
    (caught only by the new I-1 subprocess test); `replayMode`'s paid
    refusal dropped; `ci.ts`'s pair-variant-without-`triage_model` problem
    dropped; the desktop half flipped to built; `triagePairProblem`
    accepting equal ids (caught in `replay.test.ts` and in `ci.test.ts`);
    `ci.ts`'s no-pair-variant problem dropped; the smoke-pipeline refusal
    dropped; the paid refusal in `ci.ts` dropped; `--triage-model` never
    passed by `replayArgs`; `engineConfig` listing the review model only;
    the pair's file name slugged whole; the flag accepted without a pair
    variant; the triage model's catalog check skipped; and the paid step
    of the workflow without `EVAL_TRIAGE_MODEL`.

- **Deferred.**
  - **The same-lab refusal**, after codium's `labOf` merges (or the owner's
    Q6 exception): refuse equal or unknown labs in `triagePairProblem`,
    with tests in `replay.test.ts` (the tripwire line changes then), built
    on codium's `reviewModels`, `checkedLabs` and `judgeModel` rather than
    a new mechanism (§0.5, contract §5's codium row). Wiring the paid
    cross-family replay must wait for this refusal, or come in the same
    change: until then the name `engine:cross-family` admits any two
    distinct ids, so a paid run could write measured data under a
    cross-family name for a same-lab pair. Only dry projections run today,
    so no measured data can be mislabelled yet.
  - **The paid cross-family replay**: resolve the triage model with
    `resolveReviewModel` as the review model is, check its price, and admit
    both through `admitReplay`. After Q5 and Q9.
  - **The A/B design** (Q9): the same-family arm has no registry name, and
    the report groups `variant · model` by the review model only (core
    `eval-report.ts:474` and `:804`, from `model: artifact.models.review.id`
    at `report.ts:654`; the pair's `models` list is carried beside it), so
    the pair's two models are not yet a report dimension.
  - **Addendum §3 VS-29**: the AACR A/B stratified by golden
    `source_model`, or scored on the 274 human goldens of the permissive
    subset [VOI15].
  - **Addendum §3 VS-21**: ReviewBench results stratified by the `ccr`
    producer's models [GU7].
  - **VS-44 composition**: a cross-family verifier that shows its work
    through VS-44 [GU8].
  - **The desktop half**, after VS-10.
  - All of the A/B work needs the funded ablation (Q9).
- **Not verified.** No paid run, so the uplift is unmeasured, as intended
  (D12). The subprocess dry-run tests are posix-only, as before. The full
  root typecheck was not run, since nothing is pushed.
- **Not done.** Nothing was sent to a model; there was no paid run, no
  workflow dispatched, nothing published and nothing committed; no MCP
  access changed and no user-visible string changed (D14).

### 2026-11-07 · VS-29a review fixes

Seven review findings, none blocking. Six were fixed in code, one of them
(the baseline comparison) though it was marked optional, and one (the
workflow's eleventh input) could not be verified from this session and is
recorded below as a condition on pushing or merging. Only the eval scripts
(`ci.ts`, `replay.ts`, `report.ts`, `certify.ts`), the eval entry point
(`packages/engine/script/vectorscope-replay.ts`), their tests, the eval
README and this log changed. No runner, core file, engine `src/` file,
workflow line or file @vector owns changed, and no key, pin or revision
moved. The entry above is updated in place where its facts changed (the
untouched list, the entry point's refusals and `replayMode`, the dry
summary line, `ci.ts`'s problems, the workflow input, the baseline, the
same-lab deferral and the test counts). Nothing is committed.

- **Two refusals in a row for a paid cross-family run** (`ci.ts:246`,
  `vectorscope-replay.ts:230`). Fixed as suggested. `ci.ts`: with `mode:
  paid`, a named variant made by its models, or `triage_model`, gets one
  problem, `<variant, or triage_model> runs in dry runs only: a paid
  cross-family replay is not wired until the owner chooses the pair (Q5)
  and funds its ablation (Q9)`, whatever the models, and the per-model
  `Set triage_model.` and equal-model problems apply to a dry dispatch
  only. A malformed `triage_model` in a paid dispatch now gets both its
  own problem and this one at once. The entry point: `parseReplayArgs`
  asks for `--triage-model` (or refuses one equal to `--model`) only when
  the run stays dry (no budget, or `--dry-run`, the same rule as
  `replayMode`'s first line), and `replayMode` refuses a run that would
  send when it names a variant made by its models or has a triage model,
  with `A paid cross-family replay is not wired: engine:cross-family and
  --triage-model run dry only, ...` beside any other refusal, so every
  reason shows at once. Tests: `ci.test.ts` asserts the one problem for a
  paid dispatch naming the variant without `triage_model`, with one, and
  with one equal to a `models` entry, and the two problems for a paid
  `triage_model` with no pair variant; `vectorscope-replay.test.ts`
  asserts the refusal for a sending run naming the variant without
  `--triage-model` and with one equal to `--model`, and that a dry run is
  still asked for it.
- **`escapeRegExp`, a single-use helper** (`vectorscope-replay.test.ts`).
  Inlined in the posix test's `read` helper as one local `escaped`; the
  function is gone.
- **Rename-destructuring to drop a field** (`ci.test.ts:543`). Now
  `const unpaired = { ...paired, triageModel: undefined }`, since
  `replayArgs` reads `inputs.triageModel` for truthiness only (the eval
  tsconfig has no `exactOptionalPropertyTypes`).
- **The same-vendor tripwire** (`replay.test.ts:507`). The line is kept as
  it is. The same-lab deferral above now says that wiring the paid
  cross-family replay must wait for the `labOf` refusal, or come in the
  same change. The dry projection's summary line now says `(the pair's
  labs unchecked until codium's labOf merges)`, as `ci.ts`'s plan line
  already did, and the subprocess test asserts it; the README's labs
  bullet says both.
- **Read-back records were not checked for the pair** (`replay.ts:256`).
  Fixed. New `pairProblems(record)` in `replay.ts`: for a record whose
  `variant.models` is `"triage-pair"`, it lists a missing triage model
  (`it records no triage model`), a triage id equal to the review id, and
  a `scope.triage` other than the triage id (or none); ids from the record
  are quoted as JSON. It compares ids only, as `triagePairProblem` does,
  and so checks no lab. It is untrusted-input safe (anything that is not
  an object has none). It runs beside `variantProblems` in
  `projectionProblems`, in `report.ts` for engine and desktop artifacts,
  and in `certify.ts` for the candidate's runs, so such a record keeps
  the report from a release decision and is never certified.
  `variantProblems`'s signature is unchanged. Tests: `replay.test.ts`
  (one case: a whole pair record, each of the three faults, a replay
  artifact shape, other variants and non-objects), and one case each in
  `report.test.ts` (a pair artifact with no scope triage listed) and
  `certify.test.ts` (a pair certified when whole, refused when one run
  records no triage model).
- **`report.ts` accepted a pair compared with a variant that is not**
  (README, optional). Taken: it is cheap and makes the tooling enforce
  what the README already said, and it decides neither Q5 nor Q9. `report.ts
  main` refuses, as a usage error, a `--candidate` and `--baseline` of
  which only one resolves to a variant made by its models, either way
  round, since the triage pass (every finding of concern or above
  double-checked, only confirmed findings reported) would otherwise be
  credited to, or charged against, the pair. A pair alone, or two pairs
  (another model, or a future registered same-lab arm with `models:
  "triage-pair"`), still passes. The `--baseline` usage line says so, and
  so does the README's baseline bullet. A refusal rather than a warning: a
  report problem line already blocks the release decision, but a
  comparison that the README calls invalid should not be produced at all.
  Test: `report.test.ts`, three refused pairings and two accepted ones.
- **The eleventh `workflow_dispatch` input** (`vectorscope-eval.yml:87`).
  Not verified, and the workflow is unchanged. The lane may not dispatch
  `vectorscope-eval.yml`, and reading GitHub's workflow-syntax docs from
  this session failed: `docs.github.com` is outside the session's allowed
  network. The only evidence remains the changelog of 2025-12-04 cited
  above. So, before this branch is pushed or merged, one of these must
  happen: someone allowed to dispatch runs a dry dispatch of the workflow
  on a non-main branch with `triage_model` empty, and it starts; or the
  owner signs off on the 25-input limit. If neither happens, fold
  `triage_model` into an existing free-form input instead (`models` or
  `variants`), which changes that input's grammar and needs its own I-1
  check. Not folded now: either fold puts a model id where the input's
  grammar has none (the registry keeps model ids out of variant names),
  and the documented limit is the likelier answer. `ci.test.ts`'s count
  pin still catches a later addition.
- **Evidence.** Each file alone through the lock with `--timeout 30000`,
  from its own directory, with `TMPDIR` and fresh XDG roots under
  `/tmp/vector-vectorscope/vs29a-fix/`: `ci.test.ts` 33 pass,
  `replay.test.ts` 37, `report.test.ts` 34, `certify.test.ts` 7,
  `judge.test.ts` 6, engine `test/review/vectorscope-replay.test.ts` 18
  (its posix subprocess tests included). `bun typecheck` passes in
  `packages/engine`, and `bun tsgo -p
  ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`.
  prettier is clean on every changed code file and the README; oxlint
  reports nothing new on the changed lines (the warnings it lists there
  are type assertions that were already in those expressions). Twelve
  mutations, each applied alone, its test file run through the lock and
  the file restored by hash (`/tmp/vector-vectorscope/vs29a-fix/mut/`),
  all caught: `ci.ts`'s paid guard on the per-model problems dropped;
  `ci.ts`'s paid refusal dropped; the entry point's `sends` guard dropped;
  `replayMode`'s variant check dropped; `pairProblems` returning nothing
  (caught in `replay.test.ts`, `report.test.ts` and `certify.test.ts`);
  its scope check dropped; it not called in `report.ts`; not called in
  `certify.ts`; the baseline refusal dropped; and the baseline refusal one
  way only.
- **Not verified.** The workflow's input limit (above). The full root
  typecheck was not run, since nothing is pushed.
- **Not done.** Nothing was sent to a model; there was no paid run, no
  workflow dispatched, nothing published and nothing committed; no MCP
  access changed and no user-visible string changed (D14).

## 2026-11-07 · VS-35a Guarded team memory helpers (pure)

Addendum A §2 VS-35, the Now part of §4: pure core helpers that
`prompt.ts` and `select.ts` do not call, with pure tests on synthetic
markers. Built at `7a1634e2`. VS-35 is a proposal pending Q18 and Q24, so
nothing calls the new code and no key exists for it. `run.ts`,
`ai-review.ts`, `provider.ts`, `session/llm.ts`, `posting.ts`, `prompt.ts`,
`select.ts`, `types.ts`, `config.ts`, `format.ts`, `workflow.ts`,
`command.ts`, `github.*`, `github-*.ts` and `vectorscope.astro` are
untouched. It implements the VS-35a plan as corrected by its critique:
all eleven critique points were taken, one of them (the regression list)
in a corrected form (below). Nothing is committed.

- **What landed.**
  - **New core `review/team.ts`** (pinned; see Evidence scope). Its one
    runtime import is `fingerprint.ts` (`normalizeTitle`,
    `titleSimilarity`); its type imports are `TeamPattern` from
    `prompt.ts` and `Finding` and `ReviewConfig` from `types.ts`. Pure and
    browser-safe. Exports:
    - constants, each pinned by a test: `TEAM_SIMILARITY` 0.5,
      `TEAM_WRITERS` 2, `TEAM_WINDOW_DAYS` 90, `TEAM_MIN_WINDOW_DAYS` 1,
      `TEAM_MAX_WINDOW_DAYS` 365, `TEAM_CLOCK_SKEW_MS` 300 000,
      `BULK_RESOLVE_THREADS` 5, `BULK_RESOLVE_MS` 60 000, `BOT_PUSH_MS`
      120 000;
    - `DISMISSAL_BY` (`w`, `a`), `DISMISSAL_WHY` (`fp`, `wontfix`,
      `thumbs`, `resolved`, `cmd`), their types, and `DismissalMarker
      { by, why, hash }`. The tokens are the addendum's, kept as they are
      so the later writer needs no mapping;
    - `TEAM_EXCLUSIONS` (`unmarked`, `author`, `own`, `undated`,
      `outside-window`, `bot-push`, `bulk-resolve`, `security`), whose
      order is the precedence, and `TeamExclusion`;
    - `TeamDismissal { pattern, marker?, pr, at?, replied?, codeChanged? }`
      and `GuardedTeamInput { now, windowDays?, botPushes?, own?, max? }`;
    - `GuardedTeamMemory { patterns, excluded }`, carrying an unexported
      symbol key that only `guardedMemory` sets (critique 2, below);
    - `guardedMemory(dismissals, input)`, `teamDir(path)`,
      `sameTeamPattern(a, b)`, `isDismissalMarker(value)`,
      `neverSuppress(finding, config)` and
      `teamDemotion(finding, memory, config)`.
  - **An additive block in core `review/state.ts`**, after `teamPatterns`
    and before "The next state" divider, plus one import after the
    `./select` line:
    - `parseDismissalMarker(body)`: the last `vector-dismissal` marker
      that starts after the comment's own (last) finding marker;
    - `GuardedComment { path, body, pr, at?, replied?, codeChanged? }`;
    - `guardedTeamPatterns(comments, input)`: the body-level analogue of
      `teamPatterns` under guarded rules. As there, a comment without a
      dismissed finding marker or without title words is skipped. Every
      other one becomes a `TeamDismissal`, marked or not, so the
      exclusion counts see it.

    No existing line of `state.ts` changed (`git diff --numstat`: 64
    added, 0 removed). `FINDING_MARKER`, `parseFindingMarker`,
    `setFindingStatus` and `teamPatterns` are byte-identical.
  - **New core `test/review/team.test.ts`** (44 tests), one new test in
    `test/review/config.test.ts`, and the pin in
    `test/review/model-evidence.test.ts`.
- **Placement.** `state.ts` imports `select.ts` at runtime (`namedLines`),
  and at wiring `select.ts` will import the demotion rule. So the rules
  cannot live in a module that imports `state.ts`, or the wiring would
  close the cycle select → team → state → select. Every rule and
  threshold is in `team.ts`, which `select.ts` and `prompt.ts` can import
  at wiring. `state.ts` holds only the body reader, beside the markers it
  reads. `teamPatterns` is not refactored onto `teamDir`: it is the legacy
  reader (I-1), and codium and vector-at-mention edit `state.ts`. So
  `teamDir` repeats its two lines, and a test holds the two equal.
- **Read side only.**
  - The parser fixes the addendum's grammar exactly:
    `<!-- vector-dismissal by=w|a why=fp|wontfix|thumbs|resolved|cmd h=<hash> -->`,
    with no `v1` token, exactly those three fields in that order, single
    spaces, and a hash of 12 to 64 lowercase hex characters.
  - Only the text after the comment's own (last) finding marker is read.
    In it, the last `<!--`, optional whitespace and `vector-dismissal` (in
    any case) starts the candidate, and its first `-->` ends it; the
    candidate must then match the strict grammar. A malformed candidate
    (other spacing or case, a `>` inside, no `-->`, a field more or less)
    reads as none and never falls back to an earlier marker, so the
    dismissal counts as `unmarked`. The parse is linear in the body's
    length. Model text sits before the finding marker and is escaped, so
    the position rule is defence in depth.
  - The field split is in `state.ts`, but the role, reason and hash rules
    are in `team.ts`'s `isDismissalMarker`, which `guardedMemory` also
    applies to records built directly (from JSON in a later dataset case),
    so the grammar is pinned and fails closed on both paths. This differs
    from the plan, which put the hex rule in the `state.ts` regex.
  - Nothing writes a marker. No writer, HMAC or salt exists. The later
    writer must append the marker after the finding marker;
    `setFindingStatus` keeps a marker there (tested), and legacy readers
    (`parseFindingMarker`, `teamPatterns`) ignore it (tested).
  - **Grammar changes are deliberate** (critique 7). Any later field, such
    as a time the writer adds, changes `parseDismissalMarker` and is made
    together with the writer. Readers from before that change read such
    markers as unmarked, which is safe but drops them from team memory.
- **Rule decisions.**
  - **Exclusion precedence and counts.** Each dismissal is counted once,
    under the first reason in `TEAM_EXCLUSIONS` order, and `excluded`
    lists every reason with a non-zero count, kept for shadow mode
    (feedback note §7.4). The counts are taken over every input
    dismissal before the pattern walk, so `max` never shortens them
    (critique 8; tested with 40 author dismissals and `max: 1`).
  - **Writer support.** A pattern is kept when dismissals like it come
    from at least 2 distinct writer hashes (`by=w`), where "like it" is
    the same category, the exact same directory and title similarity of
    at least 0.5. The exact directory is the narrowest reading of "same
    directory or package". Support counts every counted dismissal, also
    those past `max`. Each key (`category dir words`) is kept once, as in
    `teamPatterns`, newest first, at most `max` (30), and a NaN `max`
    keeps no pattern.
  - **`at` is the dismissing action's own time** (critique 1): the
    reaction's createdAt, the dismissing reply's createdAt, or the thread's
    resolve event. It is never the comment's created_at or updated_at.
    Vector rewrites the marker of every dismissal it finds in one run
    within seconds (`github.review.ts:843-861`), and that run usually
    follows a push, so with updated_at an ordinary writer's day of
    dismissals would look like a bulk resolve, and every dismissal written
    after a bot-triggered run would fall inside the bot-push window. The
    plan's "comment updated_at" option is dropped. The later job must
    supply event times, or the writer must write them into the marker (a
    grammar change, above). The doc comments on `TeamDismissal.at` and
    `GuardedComment.at` say so, and so does the test header.
  - **The window** (critique 5). A dismissal counts when `now − window ≤
    at ≤ now + 5 min`, both ends inclusive. A window that is not a number
    from 1 to 365 days (NaN, ±Infinity, 0, 0.5, negative, 366) counts
    nothing, and so does a `now` that is not finite. 1 to 365 covers
    Copilot's 7 to 180. A future `at` is allowed only within a 5-minute
    clock skew (the job's clock against GitHub's event times); beyond it,
    the dismissal is `outside-window`. Without the bound, a far-future
    time, which a forged marker time field could carry once one exists,
    would stay in the window forever. A missing or non-finite `at` is
    `undated`. The window is swept only as a function parameter; the
    eval-only parameter path is the VS-21a follow-up (§1).
  - **Bot pushes.** Symmetric at ±2 minutes on the same pull request, the
    stricter reading of "within 2 minutes of a push". A bot push whose
    time is not a number excludes every dismissal on its pull request
    (fail closed).
  - **Bulk resolves** (critique 6). At least 5 `why=resolved` dismissals by
    one hash within a span of at most 60 s, among those with no reply
    from someone else and no code change. Unknown `replied` or
    `codeChanged` reads as none. The scan runs over every dated record
    with a `resolved` marker, whatever else excludes it, grouped by hash
    only, across pull requests and roles, and every member of a batch is
    marked. So a batch that straddles the 90-day edge marks its in-window
    members `bulk-resolve` (tested), and an author's resolves still make
    a writer's resolves in the same burst a batch (tested). `replied`
    means a reply by someone other than the dismissing actor: an agent
    that posts "Done" on each thread before resolving it does not escape
    the rule (FL9, G6-16). Thumbs-downs and commands are never batched,
    as the addendum names threads resolved.
  - **Security dismissals are excluded.** A pattern in category security
    can match only security findings, and if it sat in the review pass's
    `<team_dismissed>` block the prompt could demote one. Excluding it
    makes "category security skips the prompt rule" structural, a
    stricter reading than the addendum's.
  - **Fail closed on JSON-built records.** A marker whose role, reason or
    hash the grammar does not allow (including a numeric hash) reads as
    `unmarked`.
  - **neverSuppress** returns true for any of:
    - category security, or source security (the security pass gets an
      empty block at wiring, so its findings are exempt too);
    - a severity other than concern or nit (blocking, or a value outside
      `SEVERITIES` from a hand-built or JSON-cast finding);
    - `severityUnreadable === true` (critique 4): `decodeReport` turns an
      unknown severity into "concern" and, under strict, sets
      `severityUnreadable` (`schema.ts:419-423, 653`), so a decoded
      finding never carries the unknown string itself;
    - `guardrail: "strict"` with `failure` present (any `FailureClass`);
    - a `crash` or `data-corruption` failure under any guardrail. The
      decoder keeps `failure` only under strict (`schema.ts`), so outside
      strict this holds only for a hand-built finding; it only over-keeps,
      and it does not touch the leak scope Q4 asks about;
    - crash or data-loss wording in the title or the body.
  - **The wording list** (critique 3), case-insensitive, on word
    boundaries, a decision Q24 may revise: crash(es, ed, ing);
    panic(s, ked, king); segfault(s); segmentation fault(s); data loss,
    data-loss; lose, loses, losing, lost, drop, drops, dropped, dropping,
    delete, deletes, deleted, deleting, discard, discards, discarded,
    discarding, wipe, wipes, wiped, wiping, erase, erases, erased or
    erasing, then up to two words, then data, write(s), record(s), row(s),
    update(s), change(s), database(s) or settings (so "lost update" and
    "Discards unsaved changes" match); data, then an optional is, are,
    was, were, gets, got, will be, can be, may be, might be, could be or
    would be, then lost, wiped, erased, destroyed, corrupted, overwritten,
    truncated, dropped, deleted or discarded; corrupt(s, ed, ing, ion); truncate(s, d),
    truncating, truncation; overwrite(s), overwrote, overwritten,
    overwriting; uncaught or unhandled (promise) exception(s),
    rejection(s) or error(s); null or nil pointer(s) or dereference(s);
    dereference(s, d), dereferencing a null or nil; out of memory (with
    spaces or hyphens); OOM; stack overflow(s). The plan's near-miss "lost
    update" is now a positive case, since a lost update is the textbook
    concurrent data-loss defect. Pinned near misses: crashpad, panicle,
    lossless, "Dropdown rows", "CSS overflow", zoom, "lost focus",
    "Delete the unused import", "Deleted file is still imported", "Discard
    the return value explicitly", "Wipe the mock between tests", "Erase the
    debug border", "Delete this comment". Over-matching only keeps a
    finding visible; it also means a nit such as "Drop the unrelated
    changes" can no longer be demoted by team memory.
  - **Demotion on one guarded pattern.** `teamDemotion` returns the first
    pattern that matches a finding (same category, the finding's own
    directory, similarity at least 0.5), or none when `neverSuppress`
    holds. One pattern is enough, because the writer gate is in
    `guardedMemory`; legacy `teamPenalty` needs two.
  - **The title asymmetry is kept on purpose** (critique 11).
    `normalizeTitle` keeps up to 8 tokens (`TITLE_TOKENS`) and a pattern
    keeps at most 6 marker words (`MARKER_WORDS`), so an identical 8-token
    title scores 0.75, not 1, and is still demoted. This matches
    `teamPenalty`, and a test pins both.
  - **Only guarded memory demotes** (critique 2). `teamDemotion` takes a
    `GuardedTeamMemory`, not a `TeamPattern[]`. The memory carries a key
    under an unexported symbol, so a legacy `TeamPattern[]` (the
    unfiltered, author-made patterns the job passes as
    `context.teamDismissed` today) or a look-alike object fails to
    typecheck (`@ts-expect-error` tests). At runtime a copy decoded from
    JSON loses the key and demotes nothing (tested). Without this, guarded
    mode at wiring could apply the one-pattern demotion to legacy patterns
    before the job can switch to `guardedTeamPatterns`, which is weaker
    than legacy's two-pattern gate and the reverse of VS-35's intent
    (FL1).
- **Deferred to their consumers:**
  - the model-only `fixed` exclusion. Its consumers are the positive
    labels (Brain proposals after VS-11, VS-46's ledger), and `st=f`
    carries no provenance yet;
  - "Vector's own comments", read as Vector's own actions (for example its
    own thread resolution, which counts today when the bot login is a
    writer). The rule is `GuardedTeamInput.own`; its hashes come from the
    job with the salt, later.
- **§0.3 items:**
  1. key: none in Now;
  2. parity: nothing calls the new code, and the existing suites pass
     unchanged;
  3. evidence: no key, so `EVIDENCE_POLICY_KEYS`, `EvidenceScope`,
     `policyDigest` and `promptsDigest` are unchanged; the pin moved for
     `team.ts`;
  4. variant: `engine:team-guarded` is deferred to wiring, as VS-34a and
     VS-42a did, with no registry change;
  5. desktop: a documented difference. Team memory is GitHub-only, and
     `ai-review.ts` has no `teamDismissed`, so `variant.applied: false`;
  6. this entry.
- **Evidence scope and pin.** `team.ts` joins `REVIEW_PIPELINE_FILES`,
  pinned from the day it lands, as `guardrail.ts`, `citation.ts`,
  `risk.ts` and `runtime.ts` were: once wired it decides which findings
  `select.ts` demotes and which dismissals become team memory.
  `REVIEW_PIPELINE_SOURCES` moves from `dd477fd3a04e6efb` to
  `124e47864a16fea4` (`f30b8850fdc69552` before the review fixes), and
  `REVIEW_PIPELINE_REVISION` stays 1.
  - **Why the reader stays unpinned** (critique 10). `parseDismissalMarker`
    and `guardedTeamPatterns` do decide which dismissals count as marked,
    and the mutation check treats them as load-bearing. They stay
    unpinned because pinning `state.ts` would tie codium's and
    vector-at-mention's edits to this pin, not because they only parse.
    The reader (or `state.ts`) joins `REVIEW_PIPELINE_FILES` when the job
    first calls `guardedTeamPatterns`, following the BrainCode precedent
    (VS-25b wiring). The pin comment says so.
- **Owner questions: none decided.** Q13, Q18 and Q24 stay open. Q3 and Q4
  do not matter here: strict reads only whether `failure` is present.
- **Deferred to runner-wiring:**
  - the `teamMemory: legacy | guarded` key and its parse, with no env.
    Until then the new config test pins that `teamMemory` warns as an
    unknown key on every surface and that no `REVIEW_TEAM_MEMORY`
    variable is read;
  - an `EVIDENCE_POLICY_KEYS` entry that enters `policyDigest` only under
    "guarded", and a `promptsDigest` entry only under the key;
  - **until the job calls `guardedTeamPatterns`, guarded mode sends an
    empty team block and runs no demotion**, never legacy patterns
    (critique 2). The GitHub job cannot switch before vector-at-mention,
    since `github.review.ts` belongs to @vector;
  - the `prompt.ts` guarded line ("report a matching finding at most as a
    concern and name the pattern"), which must carry the never-suppress
    set, or "at most as a concern" would demote blocking findings;
  - the empty security block, and whether the lens passes (concurrency,
    resource, access, data-integrity), which share `build()` and so get
    the block today (`prompt.ts:520-530`), get it under guarded; access is
    recommended empty;
  - the `select.ts` demotion replacing `teamPenalty` (`select.ts:115-122,
    224-233`) under guarded, with `TEAM_SIMILARITY` imported from
    `team.ts`;
  - `DropReason` `team-dismissed` in `types.ts` and `DROP_ORDER`, recorded
    for drops and demotions; the count in `--json` and in replay
    artifacts;
  - D3 parity tests in `run.test.ts` and `ai-review.test.ts`;
  - the variant.
- **Deferred to after vector-at-mention, with the salt secret:**
  - the marker writer, and HMAC(login) keyed by the repository secret, at
    least 12 hex;
  - role passing (`by=w` for a writer who is not the PR author) from
    `classifyPrior` and `github.review.ts`;
  - `TeamPattern` writer hashes;
  - **checking every marker hash against the repository's real writers.**
    `guardedMemory` trusts `h=` as written, and anyone who can edit
    Vector's review comments (on GitHub, any collaborator with write
    access) can add well-formed markers with invented 12-hex hashes, so
    one person would count as two or more writers. Before it calls
    `guardedTeamPatterns`, the job must compare every marker hash with
    HMAC(login) for the repository's actual writers and drop a hash that
    matches none, counting that dismissal as `unmarked`. At wiring, a
    `GuardedTeamInput.writers` hash allow-list that `guardedMemory`
    requires would make the check structural;
  - the job supplying `pr`, `at` (the dismissing action's event time, as
    above, or a marker field the writer adds), `replied` (by someone other
    than the actor), `codeChanged`, bot pushes and own hashes;
  - switching `github.review.ts:316-327` (and `:674`) to
    `guardedTeamPatterns`;
  - the marker round-trip and collision tests, the byte-identical body
    parity test, and the 10-case criterion.
- **Deferred to after VS-11:** Brain proposals (at least 3 writer
  dismissals from at least 2 people, owner-activated).
- **Deferred to the VS-22a follow-up:** fixtures (a) to (c) as dataset
  cases (schema `vectorscope-dataset/3`, `ReplayCase` comments and
  threads). The dataset is still at `/2`. The pure versions of (a) to (c)
  are in `team.test.ts`.
- **Deferred verification:**
  - no real marker exists, so guarded memory is empty on today's comments
    (tested), and the done criterion and the kill criteria cannot be
    measured;
  - no replay artifacts exist (I-13);
  - the job's metadata (event times, replies, code changes, bot pushes)
    cannot be checked before the later window.
- **Merge prediction** (read-only: `git merge-tree --write-tree
  --name-only` at HEAD, then a three-way `git merge-file` of the working
  tree's `state.ts` against each branch's merge base and tip):
  - of the touched files only `state.ts` changes on any branch. It changes
    on `origin/codium` (`5a079cbd`), on `origin/self-evolving`
    (`f062bcce`, which carries the same `state.ts` hunks as codium; the
    plan named only codium and vector-at-mention) and on
    `origin/vector-at-mention` (`0b68e8f6`);
  - codium and self-evolving insert an import after the `./command` line
    and edit from `NextStateInput` on; vector-at-mention edits
    `ClassifyContext`, `classifyPrior` and `dismissReply`, all above
    `teamPatterns`. The new import has 3 unchanged lines above it, and the
    block sits between those hunks;
  - `git merge-file`: 0 conflicts for each branch, at HEAD and with
    VS-35a. `merge-tree` at HEAD lists 21 conflicting files for codium,
    10 for self-evolving and 0 for vector-at-mention, none of them a
    touched file. No new conflict hunk;
  - `model-evidence.ts`, `config.test.ts` and `model-evidence.test.ts` are
    untouched by all three branches, and none has `team.ts` or
    `team.test.ts`.
- **Critique point 9, the regression list, taken in a corrected form.**
  The critique named `github.route.test.ts` as the suite covering
  `github.handler.ts`, but that file does not import it;
  `test/cli/github.run-routing.test.ts` does. That suite ran, and so did
  `test/cli/github.review-api.test.ts` (`parseReviewMarker`) and
  `test/cli/review.test.ts` (`cmd/review.ts` imports `state.ts` too).
- **Evidence.** Each file ran alone through the lock with `--timeout
  30000`, from its package directory, with `GITHUB_ACTIONS=false` and
  `TMPDIR` and XDG roots under `/tmp/vector-vectorscope/vs35a/`. Counts are
  at HEAD → with VS-35a, the final row after the last edit:

  | Where | File | HEAD | VS-35a |
  |---|---|---|---|
  | core | `test/review/team.test.ts` | (new) | 44 |
  | core | `test/review/config.test.ts` | 72 | 73 |
  | core | `test/review/model-evidence.test.ts` | 30 | 30 (pin moved) |
  | core | `test/review/state.test.ts` | 42 | 42 |
  | core | `test/review/select.test.ts` | 45 | 45 |
  | core | `test/review/prompt.test.ts` | 47 | 47 |
  | core | `test/review/format.test.ts` | 51 | 51 |
  | core | `test/review/github-payload.test.ts` | 8 | 8 |
  | core | `test/review/pipeline.test.ts` | 2 | 2 |
  | engine | `test/cli/github.review.test.ts` | 40 | 40 |
  | engine | `test/cli/github.review-api.test.ts` | 3 | 3 |
  | engine | `test/cli/github.run-routing.test.ts` | 17 | 17 |
  | engine | `test/cli/review.test.ts` | 24 | 24 |
  | engine | `test/review/eval.test.ts` | 33 | 33 |
  | engine | `test/review/run.test.ts` | 44 | 44 |
  | app | `src/features/pull-requests/ai-review.test.ts` (bunfig preloads happydom) | 107 | 107 |

  - **Digests.** `promptsDigest` `5d59e9ee06077c23` and `policyDigest`
    `70512122f41ec160` for the default config, on the engine and desktop
    scopes, are the same at HEAD and with VS-35a. Only
    `REVIEW_PIPELINE_SOURCES` moved.
  - **Typecheck.** `bun typecheck` passes in core, engine, app and
    desktop, and so does the eval scripts' `bun tsgo -p
    ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`.
  - **Lint.** prettier passes on every changed file except one line of
    `state.ts` that is unchanged from HEAD (the `followLines` ternary,
    which prettier would reflow at HEAD too) and is left byte-identical.
    The new block is prettier-clean. oxlint with
    `--report-unused-disable-directives` reports nothing on `team.ts`,
    `team.test.ts`, `state.ts` and `config.test.ts`. `team.ts` has no
    disable comment: the runtime key check reads `!memory[GUARDED]`. The
    18 warnings oxlint lists in
    `model-evidence.ts` and its test are on lines this package did not
    change.
  - **Mutation check.** Forty-seven mutations, each applied alone, with
    `team.test.ts` run through the lock and the file restored byte for
    byte (`cmp`) after each (`/tmp/vector-vectorscope/vs35a/mut/`). All
    were caught:
    - provenance: `by=a` counted; markers counted instead of distinct
      hashes; `TEAM_WRITERS` 1; `own` ignored; the grammar check skipped in
      `guardedMemory`; the `typeof hash` check dropped;
    - scope: the directory ignored in `sameTeamPattern`;
      `TEAM_SIMILARITY` 0.4 (the drift test against `teamPenalty`);
    - window: `>=` to `>` at the edge; the 1-to-365 bounds dropped; the
      future skew unbounded;
    - bulk: threshold 6; the span's `<=` to `<`; replied threads batched;
      changed threads batched; thumbs batched as resolves; batches grouped
      across hashes; the scan limited to in-window records (the straddle
      test);
    - bot push: one-sided; a NaN push time failing open; any pull request;
    - security and never-suppress: the security exclusion dropped; the
      source-security clause dropped; the strict clause ignoring
      `guardrail`; the strict clause dropped; the crash token removed;
      "update" dropped from the lose rule; the word boundary dropped on
      panic; the body not checked; an unknown severity read as concern;
      the `severityUnreadable` clause dropped;
    - output: `teamDemotion` needing 2 patterns; `teamDemotion` skipping
      `neverSuppress`; the runtime key check dropped; the precedence of
      author and undated swapped; output aliasing the input pattern; a
      NaN `max` uncapped; `excluded` counted only up to `max`; zero counts
      kept; the key dedupe dropped;
    - parser: the first dismissal marker taken instead of the last; the
      position rule dropped; a malformed last marker falling back to an
      earlier well-shaped one; 11-hex hashes accepted; uppercase hex
      accepted; extra fields accepted; the first finding marker taken as
      the comment's own;
    - at typecheck: making the memory's key optional leaves the
      look-alike `@ts-expect-error` unused (TS2578), so a structural
      `{ patterns, excluded }` would be accepted.

    The first round found one equivalent mutant: an explicit
    `Number.isFinite(now)` clause in the window check, which the
    inclusive comparisons already make redundant for any finite `at`
    (NaN fails both ends, +Infinity the first, −Infinity the second). It
    was removed; the non-finite `now` test still pins the behaviour.
    After the review fixes (below), "the strict clause ignoring
    `guardrail`" is no longer caught, on purpose: the assertion that
    caught it locked in a state the decoder never produces.
  - The full root typecheck was not run: nothing is pushed.
  - Nothing was sent to a model, no paid path ran, no workflow was
    dispatched, no dependency was added, and no user-visible string
    changed (D14).

### 2026-11-07 · VS-35a review fixes

Seven review findings, none blocking. All seven were fixed, one of them
(the failure classes) with its optional part too. Only `team.ts`,
`state.ts`'s new block, `team.test.ts`, the pin in `model-evidence.ts` and
this log changed; `state.ts` still changes no existing line. No runner,
prompt, select, config or type file and no file @vector owns changed, and
no key or revision moved. The entry above is updated in place where its
facts changed (the numstat, the test counts, the parser rule, the
never-suppress list, the wording list and its near misses, the pin, the
deferred list, the lint note and the mutation note). Nothing is
committed.

- **Data-loss verbs missing from the wording list** (`team.ts:185`).
  Fixed. The active-verb rule now also takes delete, deletes, deleted,
  deleting, discard(s, ed, ing), wipe(s, d), wiping, erase(s, d) and
  erasing, and the passive `data … ` rule also takes deleted and
  discarded. Three of the finding's own phrases have none of the old
  objects ("Discards unsaved changes", "Wipes the database on retry",
  "erases the user's settings"), so the object list also gained
  change(s), database(s) and settings. It is shared with lose and drop,
  so "loses unsaved changes" matches too; the price is that a nit such as
  "Drop the unrelated changes" is now never demoted, which the
  over-matching rule accepts. The wording test gained ten phrases, the
  finding's five among them, and the near-miss test six ("Delete the
  unused import", "Deleted file is still imported", "Discard the return
  value explicitly", "Wipe the mock between tests", "Erase the debug
  border", "Delete this comment"), so each new verb needs a data object
  after it.
- **The parser's comment promised more than its regex did**
  (`state.ts:357`). Fixed in code, not by narrowing the comment. The parse
  now reads only the text after the finding marker, takes the last
  `<!--\s*vector-dismissal\b` there (case-insensitive, as
  `escapeVectorMarkers` is) as the candidate's start and its first `-->`
  as its end, and matches the candidate against the strict anchored
  grammar. So a last candidate with no space before `-->`, a `>` inside,
  no space after `<!--`, another case, or no `-->` at all reads as none
  instead of falling back to an earlier valid marker. The malformed-marker
  test gained those six shapes, each alone and after a valid marker, and a
  new test pins that only the text after the finding marker is read and
  that a candidate's first `-->` ends it.
- **Nothing checked that `pr`, `replied` and `codeChanged` reach
  `guardedMemory`** (`team.test.ts:627`). Fixed. The test helper now
  passes `codeChanged`. A new `guardedTeamPatterns` test (1) puts a bot
  push on pull request 1 and expects a `bot-push` exclusion for exactly
  its two comments, with pull request 2's two writers still making the
  pattern, and (2) runs six resolves by one hash within 10 s, which are a
  batch of six, and the same six with one replied and one changed thread,
  which are no batch. Six, not the suggested five: with five, one replied
  and another changed thread leave three candidates, and dropping either
  field alone leaves four, still under the threshold, so neither
  mutation would be caught. With six, dropping either makes five.
- **The oxlint disable comment** (`team.ts:172`). Fixed:
  `if (!memory[GUARDED]) return undefined`, and the disable comment is
  gone. The loops in `guardedMemory` (its early break on `max`) and
  `bulkMembers` stay.
- **A test asserted that a crash failure is demoted outside strict**
  (`team.test.ts:543`). Fixed, with the optional part. The assertion is
  gone, and `neverSuppress` now returns true for a `crash` or
  `data-corruption` failure under any guardrail; it only over-keeps, and
  the leak scope (Q4) is untouched. The `teamDemotion` test now asserts a
  `leak` failure is kept under strict and a `crash` failure under off. The
  `neverSuppress` test's two assertions that a `leak` failure is demotable
  under off and with no guardrail were removed for the same reason; that
  test now checks every `FAILURE_CLASSES` entry under strict, and a new
  test checks crash and data-corruption under off and with no guardrail,
  with a comment that the decoder keeps `failure` only under strict.
- **Invented hashes would count as writers** (deviation log, the later
  window). Recorded: the "Deferred to after vector-at-mention" list now
  says the job must check every marker hash against HMAC(login) for the
  repository's actual writers, and count a hash that matches none as
  `unmarked`, before it calls `guardedTeamPatterns`, with the
  `GuardedTeamInput.writers` allow-list as the structural form at wiring.
  Nothing is built for it now: no writer list or salt exists in the Now
  window.
- **Quadratic marker scan** (`state.ts:357`). Fixed by the same rewrite:
  only the text after the finding marker is scanned, the start pattern
  begins with a literal, the end is an `indexOf`, and the strict match is
  anchored, so the parse is linear. The suggested bounded pattern
  (`[^>]{0,160}?`) was not taken: it would skip an over-long last
  candidate and read an earlier marker, which the previous finding rules
  out. Measured with `/tmp/vector-vectorscope/vs35a/bench/parse.ts`
  (mean of 10 runs, through the lock): on a body with 64 KiB of
  `<!-- vector-dismissal ` after the finding marker, the old regex took
  55.46 ms and the new parser 0.81 ms; with the run before the finding
  marker, 0.07 ms and 0.12 ms. The new test pins the result on such a
  run, with no timing assertion.
- **Evidence.** Each file ran alone through the lock with `--timeout
  30000`, from its package directory, with `GITHUB_ACTIONS=false` and
  `TMPDIR` and XDG roots under `/tmp/vector-vectorscope/vs35a/`:
  core `team.test.ts` 44 (was 41), `model-evidence.test.ts` 30 (pin
  moved to `124e47864a16fea4`), `state.test.ts` 42, `select.test.ts` 45,
  `prompt.test.ts` 47, `config.test.ts` 73; engine
  `test/cli/github.review.test.ts` 40, `github.review-api.test.ts` 3,
  `github.run-routing.test.ts` 17, `test/cli/review.test.ts` 24. All
  pass.
  - **Typecheck.** `bun typecheck` passes in core and engine. App and
    desktop were not rerun: no exported name or type changed.
  - **Lint.** prettier passes on `team.ts` and `team.test.ts`; on
    `state.ts` it flags only the unchanged `followLines` line, as before.
    oxlint with `--report-unused-disable-directives` reports nothing on
    `team.ts`, `team.test.ts` and `state.ts`.
  - **Mutation check.** Twelve mutations, each applied alone, with
    `team.test.ts` run through the lock and the file restored and compared
    byte for byte after each (`/tmp/vector-vectorscope/vs35a/mut2/`). All
    were caught: `replied`, `codeChanged` or `pr` dropped from
    `guardedTeamPatterns`; the new verbs dropped; the new objects
    dropped; the passive deleted and discarded dropped; the object list
    widened to any word; the failure-class clause dropped; the start
    pattern case-sensitive; the start needing exactly one space; the first
    candidate taken instead of the last; the whole body read instead of
    the text after the finding marker.
  - Nothing was sent to a model, no paid path ran, no workflow was
    dispatched, no dependency was added, and no user-visible string
    changed (D14).

## 2026-11-07 · VS-22c Round-two dataset labels

Addendum A §3, VS-22, the "VS-22a follow-up" bullet, in the Now window of
§4 ("the VS-22a follow-up labels (before the held-out freeze)"). Built at
`fb18395b` on `vectorscope-engine`. Addendum A's packages are proposals
pending Q18, so everything here is eval tooling and dataset labels, off by
default, and nothing calls it from a runner. `run.ts`, `ai-review.ts`,
`provider.ts`, `session/llm.ts`, `posting.ts`, every core and engine source
file, `workflow.ts`, `command.ts`, `github.*`, `github-*.ts`,
`vectorscope.astro`, `judging-rubric.md`, `report.ts` and the engine entry
point `packages/engine/script/vectorscope-replay.ts` are untouched. No new
external case was curated and nothing was imported from AACR (Q31). It
implements the VS-22c plan as corrected by its critique: every critique point
was taken, points 2, 10 and 11 in one of the forms the critique offered and
point 6 in a corrected form (below). Nothing is committed.

- **What landed.**
  - **`script/vectorscope-eval/dataset.ts`:**
    - schema `vectorscope-dataset/3`;
    - constants `CONTEXT_LEVELS` (hunk, file, repo), `IN_CHANGE_SCOPES`
      (introduced-by-pr, exacerbated-by-pr), `NOT_IN_CHANGE_SCOPES`
      (pre-existing, unrelated), `DEFECT_SCOPES`, `FINDING_SCOPE_AXIS`,
      `TEST_GAPS` (weakened, none), `FEEDBACK_ATTACKS` (addendum A's
      forged-author, brigading, bulk-resolve and security-thumbs, then the
      known-gap invented-writers), `FEEDBACK_SOURCES` (synthetic) and
      `ROUND_TWO_TARGETS`;
    - on `Defect`: `contextLevel`, `scope`, `testGap`, `introducedAt`,
      `interaction`, each optional; a `NotInChangeDefect` type;
      `FeedbackComment` and `Feedback` types;
    - on `Case`: `candidate.commits`, `feedback`, and in `labels`
      `notInChange`, `headRule` and `feedback` (attack, defect, finding);
      pass labels gain `contextLevel`, `scope` and `testGap`;
    - `caseView` passes a sequence's push SHAs and the review feedback
      (without `source`), each only when present, and rebuilds each
      comment, bot push and `own` list from its schema fields alone;
    - validator: `classProblems` checks the three new defect labels;
      `inChangeProblems` (scope placement, testGap evidence),
      `notInChangeProblems`, `headRuleProblems`, `feedbackProblems` with
      `commentProblems`, and `sequenceProblems`; per-label once per pass,
      merged agreement (`repeatedLabels`, `mergedPass`); the freeze needs
      `contextLevel` and `scope`;
    - object checks: the pushes join the commits that must exist; the
      reviewed diff (the engine's `DIFF` flags, `--find-renames
      --unified=3`, through core's `parseUnifiedDiff`) is parsed once
      (`changeOf`); `changeProblems` (context-level floor and note,
      exacerbated, notInChange, testGap weakened, headRule) and
      `pushProblems` (ancestry chain, commit times, files at the introducing
      push, interaction); `notInChange` and `headRule` join the "in the
      candidate head" location checks; `ObjectCheck` gains an optional
      `notes`, present only when non-empty, which the dry run prints;
    - dry run: seven new lines (`roundTwoLines`); every existing line is
      unchanged.
  - **`dataset/seed.json`:** schema 3, one description sentence, VS-22c
    labels on all nine bug defects, and a second pass-1 entry per bug case
    dated 2026-11-07. No case added; splits, selection and exclusions
    unchanged.
  - **`replay.ts`:** `unreplayable`, `unreplayableCases`; `replayPlan`
    throws on a split holding such a case; `main` returns 1 with the
    reasons first.
  - **`ci.ts`:** `mirrorPlan` adds a sequence's pushes, de-duplicated,
    after the head and base.
  - **Tests:** `fixtures.test.ts` (37 new tests, 4 of them from the review
    fixes below, a second local repository pushed twice, five feedback
    attack cases), `replay.test.ts` (1 new), `ci.test.ts` (1 new).
  - **Docs:** `annotation-guide.md` ("What a case is", "Checking a case",
    the traits, a new "Labels added in VS-22c", a new "Multi-commit
    sequences", "Adversarial cases", "Two passes", "Freezing", and a dated
    amendment to the sampling rule); `README.md` (schema 3, the seed's label
    state, the object checks, the fixtures' coverage).
- **Decisions.**
  - **(a) Schema 3.** A `/2` manifest is refused, as `/1` was by VS-22a.
    The seed is the only `/2` manifest, and it moves here.
  - **(b) contextLevel is the annotator's judgement of the context needed**
    (critique point 1, taken). Defined in AACR-Bench's terms [LCI2]: the
    change's diff with its default three lines of context, every hunk of
    every changed file (hunk); the whole of a changed file (file); code in a
    file the change does not touch (repo). The git check is one-directional:
    a label narrower than the `locations` alone show is refused (a location
    outside every hunk needs at least file, one in an untouched file repo);
    when the alternatives (tests left out, as `sourceFilesOf` leaves them
    out) reach wider than the label, the dry run prints a note, never a
    refusal. VS-37's per-level slice recall therefore reads context need,
    which is what its tiers supply: tier a (the enclosing definition) for
    file, tiers b and c (outbound signatures, call sites) for repo. The plan
    had defined the level as the widest cited place and refused any other
    label; that would have forced hono to file although its cause is on line
    77, and it is withdrawn.
  - **(c) The scope split.** `labels.defects` carries only in-change scopes;
    pre-existing and unrelated defects go in `labels.notInChange`, which
    judging never reads (`manifestCase` passes `labels.defects` only), so
    under rubric version 1 a finding on one stays a false alarm ("not a
    defect in this change") and S9 leaves it out of scope. This is neutral
    on Q29. The "not in this change" judging tag (VS-42a decision (r)) stays
    deferred to Q29 and `RUBRIC_VERSION` 2. `labels.notInChange` is allowed
    on any kind, so VS-42's "pre-existing bug beside a benign edit" is a
    control; the guide's control and adversarial wording was rewritten so it
    no longer contradicts this (critique point 9, taken).
  - **(d) `FINDING_SCOPE_AXIS`** maps core's `FindingScope` onto the axis
    and `satisfies Record<FindingScope, ...>`, so a fourth model value fails
    typecheck; unrelated has no model value.
  - **(e) testGap is GU5's stratum, on the defect** (critique point 2,
    taken in its first form). GU5's "Test gaps: 0 of 4" is a golden
    category, review findings whose issue is a test. Values: `weakened` (the
    change weakens or removes a test that would catch this defect, and the
    defect cites it at its place in the head; with mirrors, the cited test
    is an existing file the change edits) and `none`. The plan's case-level
    "missing" is dropped: a fix that adds the missing test is already
    `regressionTest: added-by-fix`, and on the seed it separated nothing.
    testGap is **not a freeze requirement**; requiring it is a choice open to
    the owner. The Python and security strata are read from `language` and
    `category`, with no new label and no minimum.
  - **(f) headRule** sits on adversarial cases only. Its pure check asks
    core's `trustedRules` whether a one-line addition at that path comes back
    as head-added rule text, so the rule-carrying set stays citation.ts's
    `RULE_FILES` and nothing is copied or newly exported (critique point 8,
    taken). With mirrors, every line from `line` to `endLine` must be one the
    change adds to that file, and `trustedRules` must read the file's added
    runs.
  - **(g) Feedback is input on adversarial cases** (critique points 4 to 6).
    `Case.feedback` is what the reviewer's team memory reads (it reaches the
    reviewer through `caseView`, without `source`); `labels.feedback` says
    what it attacks: the attack, the labelled defect it tries to hide (which
    needs its fix, as for any adversarial case with a defect), and the
    finding a reviewer would post for it, by core category and title.
    - **Reach (point 6, taken in a corrected form).** At least one comment
      must match that finding as guarded memory matches patterns
      (`sameTeamPattern`: the finding's core category, the directory of one
      of the defect's locations, marker words at least `TEAM_SIMILARITY`
      like the title). The critique asked for the marker category to equal
      the defect's category, but the dataset's defect categories
      (correctness, security, concurrency, ...) are not core's finding
      categories (bug, security, reliability, ...), so the comparison is with
      the finding's recorded core category, which must itself be one of
      core's finding categories (its own refusal, before the reach is
      checked). `own` entries are checked with core's `isDismissalMarker`
      hash rule.
    - **forged-author (point 4, taken).** It is the research case: the PR
      author's dismissals or ones with no writer marker. A fifth attack,
      `invented-writers` (one actor writing two well-formed `by=w` markers
      with made-up hashes), is labelled as what HEAD really does: guarded
      memory keeps the pattern and demotes the finding, and the test asserts
      that. The fix (checking each hash against the repository's writers, as
      a `GuardedTeamInput.writers` allow-list) stays where VS-35a put it,
      after vector-at-mention with the salt secret. It is no addendum
      target, so the dry run's round-two targets list only addendum A's four
      attacks; its tally line still counts every attack.
    - **Two patterns (point 5, taken).** Each attack fixture builds two
      distinct dismissed patterns at least 0.5 like the title, so legacy
      `teamPenalty` (two matches) applies; the tests say legacy "penalises"
      (a 0.15 cut), not "suppresses".
    - A leak guard refuses a body or path that quotes, in any letter case,
      a defect's id, summary or cause (in or outside the change),
      `labels.injection`, `labels.rationale`, the finding title, the case id
      or the fix's first 7 characters. `caseView` rebuilds the feedback from
      its schema fields, so no other key of a comment reaches the reviewer.
    - Feedback cases are real commits with synthetic history only, so they
      are not Q12's synthetic agent-authored cases; `source: "synthetic"`
      keeps them separable, and "recorded" waits for VS-35's marker window.
  - **(h) Sequences.** `candidate.commits` lists at least two pushes, each a
    full SHA and its ISO time, without repeats or the base, ending at the
    head and its date, never including the fix. The `incremental` trait was
    listed in `TRAITS`, the guide and the README but never defined; VS-22c
    defines it as a multi-commit sequence and requires it exactly on cases
    with `candidate.commits` (critique point 7, taken; the plan's "never
    defined" is reworded so). Every labelled defect of a sequence needs
    `introducedAt` (one of the pushes); outside a sequence `introducedAt` and
    `interaction` are refused. `interaction: true` needs a push after the
    first, and with mirrors a cited file that base..introducedAt changed and
    the introducing push did not (VS-41's "unfocused file"); `false` is never
    refused, as for context levels. The head must still be an ancestor of
    the fix, so a sequence comes from a pull request merged with a merge
    commit; a force-pushed one is a single case.
  - **(i) Each label once per pass.** A pass may record its labels over
    several entries (the seed's pass 1 has a VS-22a entry and a VS-22c
    entry); a label given twice for one pass is refused with one message
    naming each repeat (`defect.failureClass`, ..., `crossFile`). Agreement
    is checked on each pass's merged entries.
  - **(j) The freeze** needs `contextLevel` and `scope` on every held-out bug
    defect, after `runnable` in the message. `labels.notInChange` is outside
    the pass records and the freeze in this package (critique point 13,
    taken; recorded as deferred).
  - **(k) Round-two targets are reported only** (critique point 3, taken).
    `ROUND_TWO_TARGETS` (VS-41's 15 sequences, 5 cases with an interaction
    defect, 5 clean later pushes; one exacerbated defect, one pre-existing
    defect, one head-added rule case and one case per addendum attack, the
    addendum's "a case" at its minimum) appears in the dry run; item 2 of
    the sampling rule is
    unchanged, and item 5's quota does not apply to them until Q18. The
    guide's dated amendment changes only item 6 and "What a case is" for
    sequences (base the merge-base, head the last pushed head, pending Q18)
    and places review feedback cases outside the query-ordered sampling.
    No VS-22b candidate has been examined (no `dataset/upgrade.json`, no
    VS-22b entry), so the amendment applies to every future candidate.
  - **(l) A case the replay cannot feed blocks its split** (critique point
    11, taken in its first form). `replayPlan` throws with every such case
    of the split and its reason; `replay.ts main` returns 1 with the same
    text first. The engine entry point is untouched, so on such a split it
    stops with that error and replays nothing. This is fail-closed on
    purpose: a sequence or feedback case is never replayed as a plain
    base..head review and scored as one. No such case exists, and the seed's
    plans are unchanged (tested).
  - **(m) `caseView` and `mirrorPlan`** grow only for cases with the new
    fields: a view of a case without them, and the seed's mirror plan, are
    byte-identical (tested).
  - **(n) `manifestCase` is unchanged**, so judge tasks and scores are
    byte-identical for every case, and a case's `notInChange` changes no
    judged input (tested).
  - **(o) dataset.ts now imports runtime core modules** (critique point 7,
    taken). Until now it imported only the import-free `types.ts`, and
    `TRIVIAL_KINDS` was a copy "because trivial.ts has runtime imports". It
    now also imports `citation.ts` (which loads `config.ts`, `privacy.ts`
    with effect and minimatch, and `prompt.ts`), `state.ts` (which loads
    `command.ts`, imported and never edited, `select.ts`, `prompt.ts` and
    `team.ts`), `diff.ts`, `fingerprint.ts` and `team.ts`. This is I-10
    reuse: no second marker parser, rule-file list, diff parser or pattern
    matcher. It is safe: every job that runs the scripts installs
    dependencies with setup-bun, `ci.ts` already loads `fixture.ts` (core
    `diff.ts` and `pack.ts`), the eval tsconfig and the engine typecheck
    cover the imports, and the dry run still makes no network request
    (tested). `TRIVIAL_KINDS` stays a copy held equal by its test; switching
    it to core's is left to a package that touches the trivial kinds.
  - **(p) No crossFile implication** (critique point 13, taken). The plan's
    "crossFile false refused for a repo defect citing two source files" is
    dropped: crossFile stays the annotator's judgement.
  - **(q) Feedback holds the post-classification view only** (critique
    point 10, taken in its second form). Each comment carries its finding and
    dismissal markers with `replied` and `codeChanged`, as core's
    `GuardedComment` takes them; raw reply text, reactions and resolve events
    are not in schema 3. The deferred engine half therefore cannot feed
    `PromptInput.humanComments` or exercise `classifyPrior`, where brigading
    and bulk resolves happen in production, without a schema follow-up that
    adds those raw thread fields.
- **Seed labels** (pass 1, 2026-11-07, from the case files and read-only
  `git diff --find-renames --unified=3 base head` on local mirrors):

  | Case | Defect | contextLevel | scope | testGap |
  | --- | --- | --- | --- | --- |
  | pallets-werkzeug-1 | server-name-none | hunk | introduced-by-pr | none |
  | pallets-werkzeug-1 | port-appended-to-host | hunk | introduced-by-pr | none |
  | fastify-fastify-1 | response-time-unset | hunk | introduced-by-pr | none |
  | nats-io-nats-server-1 | lds-data-race | hunk | introduced-by-pr | unlabelled |
  | caddyserver-caddy-1 | srv-upstream-rejected | repo | introduced-by-pr | none |
  | vitejs-vite-1 | legacy-marker-in-ssr | file | introduced-by-pr | none |
  | tokio-rs-tracing-1 | scoped-default-clobbers-global | hunk | introduced-by-pr | none |
  | pallets-click-1 | eof-on-iteration | hunk | introduced-by-pr | weakened |
  | honojs-hono-1 | jwt-time-truncation | hunk | introduced-by-pr | none |

  - caddy is repo because its cause needs `Upstream.LookupSRV` in
    `hosts.go`, outside the change; vite is file because the legacy-env
    define at `index.js:454-459` lies outside every hunk of the changed file.
  - hono is hunk under (b): the 32-bit truncation is on line 77, inside the
    hunk; its alternative `78-86` runs past the hunk, which the mirror dry
    run reports as its one note.
  - testGap: click's change edits `tests/test_chain.py:166-167` to expect the
    abort, an existing test, so weakened. werkzeug, fastify, caddy, vite and
    hono edit no test, and tracing only adds a new test file, so none. nats
    edits three existing test files that were not read for the race, so its
    testGap is unlabelled and its entry says "testGap not examined".
  - Disputes for pass 2: nats file against hunk (the `c.mu.Lock()` lies
    above the hunk, although the added `c.mu.Unlock()` shows the lock);
    tracing file against hunk (the guard's stored prior is read outside the
    hunks); hono file against hunk; nats testGap.
- **Off by default (I-1).** No `ReviewConfig` key; no change to
  `EVIDENCE_POLICY_KEYS`, `EvidenceScope` or `VARIANT_KEYS`; no replay
  variant, so §0.3 item 4 does not apply; no desktop change. No file in
  `REVIEW_PIPELINE_FILES` changed, so `REVIEW_PIPELINE_SOURCES` stays
  `124e47864a16fea4` (`model-evidence.test.ts` passes unchanged),
  `REVIEW_PIPELINE_REVISION` stays 1 and `RUBRIC_VERSION` stays 1. No core
  or engine source changed, so `promptsDigest` and `policyDigest` cannot
  move, and no runner, request or posted body changes, so no D3 parity test
  applies. The only output changes are in eval tooling: schema 3, the new
  dry-run lines, refusals of malformed new fields, and the replay refusing
  case kinds that no manifest holds yet.
- **Owner questions: none decided.** Q3, Q4, Q12, Q13, Q18, Q24, Q29 and Q31
  stay open; everything built here reads the same under either answer.
- **Held-out digest:** the seed is not frozen. Its held-out digest moves
  from `sha256:dc56133cf9d417526f0d534ae89aaebfcdaa414b6f1aa0c085a09897f4a6e98d`
  to `sha256:372a8d7d3f291fae9250d5fa7676698110ba03d098afba3bf88b08d8f2bfa8e2`,
  because click and hono, its held-out cases, gain labels.
- **Existing tests whose setup or expectation changed** (all in
  `fixtures.test.ts`):
  - "the targets are VS-22b's, and a manifest of an earlier schema is
    refused" (renamed from "of the first schema"): expects schema 3 and
    refuses `/1` and `/2`;
  - "each pass may record its own labels...": two pass-1 entries with the
    same labels now get the per-label message, "pass 1 records the same
    label in more than one entry (defect.failureClass, defect.mechanism,
    crossFile)", instead of "a pass records its own labels in more than one
    entry";
  - "a held-out bug case is frozen only with its VS-22a labels...": the
    missing list adds `contextLevel, scope`;
  - the seed's "labels failure class, mechanism and cross-file..." test: each
    bug case now has two dated pass-1 entries with labels, 2026-11-06 and
    2026-11-07; the 2026-11-06 entry's checks are unchanged;
  - setup: `synthetic()`'s defect gains `contextLevel: "hunk"` and `scope:
    "introduced-by-pr"`, so the frozen synthetic manifests of the freeze
    tests stay valid under (j);
  - setup: `buildRepository` now uses a shared `localRepository` helper
    that the new sequence repository also uses; the commits, contents and
    dates are the same;
  - the seed's dry-run test only gains lines.
- **Evidence.** Each test file ran alone through the lock with `--timeout
  30000` and `GITHUB_ACTIONS=false`, with `TMPDIR` and the XDG roots under
  `/tmp/vector-vectorscope/vs22c/`; every eval test ran from
  `packages/script`, as `test.yml` runs them.

  | File | HEAD | After |
  | --- | --- | --- |
  | `fixtures.test.ts` | 66 | 103 (99 before the review fixes) |
  | `replay.test.ts` | 37 | 38 |
  | `ci.test.ts` | 33 | 34 |
  | `report.test.ts`, `judge.test.ts`, `certify.test.ts`, `run.test.ts`, `budget.test.ts` | 34, 6, 7, 14, 21 | 34, 6, 7, 14, 21 |
  | engine `vectorscope-replay.test.ts`, `eval.test.ts` | 18, 33 | 18, 33 |
  | core `model-evidence.test.ts` (pin unchanged), `eval.test.ts`, `eval-judge.test.ts`, `eval-report.test.ts` | 30, 42, 12, 19 | 30, 42, 12, 19 |

  All pass.
  - **Typecheck.** `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json`
    from `packages/engine` (as `typecheck.yml` runs it), and `bun typecheck`
    in `packages/engine` (its entry point imports `dataset.ts`),
    `packages/core` and `packages/script`: all pass.
  - **Format.** prettier passes on every changed file except this log,
    which was not prettier-clean at HEAD and is only appended to.
  - **Dry runs.** `bun dataset.ts` exits 0 with the seven new lines.
    Critique point 12 was taken before any edit: the fix SHAs were fetched
    read-only into a scratch copy of the VS-21c mirrors
    (`/tmp/vector-vectorscope/vs22c/mirrors`), and `bun dataset.ts --mirrors`
    at HEAD then exited 0 with all 10 cases checked and no problem, the
    first run of the git checks on the seed with its fixes. After the change
    it exits 0 again, 10 cases checked, with one note (hono, above). The
    mirrors are scratch and never committed.
  - **Mutation check.** Thirteen mutations, each applied alone with the
    named test file run through the lock and the file restored after each
    (`git diff --stat` compared before and after): the context-level floor
    dropped; pre-existing scope allowed in `labels.defects`; the
    one-entry-per-pass rule restored (the seed's "is valid" fails); feedback
    allowed on a bug case; the attack leaked into `caseView`; the replay
    refusal stopped; the pushes dropped from `mirrorPlan`; scope dropped from
    the freeze list; the reach check dropped; the head-rule file check
    dropped; the interaction object check dropped; the testGap object check
    dropped; the incremental-trait coupling dropped. All were caught. The
    review fixes (below) added ten more, all caught.
  - Nothing was sent to a model, no paid path ran, no workflow was
    dispatched, no dependency was added, and no user-visible string changed
    (D14).
- **Merge prediction** (read-only `git merge-tree --write-tree --name-only`
  at HEAD, and `git diff --name-only` from each branch's merge base): no file
  this package touches changes on `origin/codium` (`5a079cbd`),
  `origin/self-evolving` (`f062bcce`) or `origin/vector-at-mention`
  (`0b68e8f6`), so it adds no conflict. The conflicts merge-tree lists at
  HEAD against codium and self-evolving are in other packages' files
  (`types.ts`, `ai-review.ts`, `run.ts`, `test.yml` and others) and predate
  this package. The new imports read `state.ts`, which all three branches
  change, but only `parseFindingMarker`, which they keep.
- **Deferred to a later eval package** (it needs no runner change, so it
  can come before runner-wiring, but it is beyond this package's labels):
  - the engine half of the addendum's "Where": `ReplayCase` comments and
    threads, and a `ReviewEval.replay` sequence mode (a full review of the
    first push, then incremental with `since`, prior findings and state).
    `RunInput` already has `since`, `mode`, `prior` and
    `context.teamDismissed`/`humanComments`. Until VS-35 wiring it can feed
    only legacy `teamPatterns`, and it needs the raw-thread schema follow-up
    in (q). When it lands, the refusal in (l) is lifted for what it feeds;
  - the report's use of the labels: slice recall per context level (VS-37,
    VS-36), an S9-scope and ReviewBench-parity count with `notInChange`,
    recall by stratum (VS-21), and per-push recall and false alarms on clean
    later pushes (VS-41);
  - `labels.notInChange` in the pass records and the freeze.
- **Deferred to their windows or owners:**
  - the "not in this change" judging tag: Q29, `RUBRIC_VERSION` 2;
  - real cases of each new kind and stratum: VS-22b curation, the AACR
    subset (Q31) and per-PR licence checks;
  - real `vector-dismissal` markers and `source: "recorded"`: VS-35's later
    window with the salt secret, which also brings the writer-hash check
    that would make `invented-writers` fail to teach a pattern;
  - nats's testGap and every label's pass 2;
  - stripping third-party bot blocks from PR bodies: the dataset holds no PR
    text yet;
  - the large-repository slice (VS-38);
  - `TRIVIAL_KINDS` importing core's (o).
- **Deferred verification:**
  - no real sequence, feedback, head-added rule or out-of-change case
    exists, so their git checks have run only on the local fixture
    repository;
  - kappa on the new labels needs pass 2;
  - the legacy and guarded comparison runs as pure functions (`teamPatterns`
    with `teamPenalty`, `guardedTeamPatterns` with `teamDemotion`), not
    replays; legacy's prompt rule, which suppresses on one pattern, is not
    exercised;
  - the engine entry point's stop on a refused split is not run in the
    engine suite; `replayPlan`'s throw is tested in `replay.test.ts`.

### 2026-11-07 · VS-22c review fixes

Nine review findings, one of them blocking; two pairs overlap (the two on
`caseView`, and the two on `lineRange`), so there are seven distinct fixes.
All nine were fixed, none by narrowing a comment. Only `dataset.ts`,
`fixtures.test.ts`, `annotation-guide.md`, `README.md` and this log changed;
`seed.json`, `replay.ts`, `ci.ts` and every core and engine file are as the
entry above left them, so the seed's held-out digest, `manifestCase`, the
mirror plan and `REVIEW_PIPELINE_SOURCES` cannot move. The entry above is
updated in place where its facts changed (the constants, `caseView`, the test
count, (g)'s reach, invented-writers and leak guard, (k)'s targets, the test
table and the mutation note). Nothing is committed.

- **`caseView` passed the manifest's feedback objects by reference**
  (blocking, `dataset.ts:325`, and the non-blocking one at `:315`). Fixed as
  the findings asked. Each comment is rebuilt as `{ pr, path, body }` plus
  `at`, `replied` and `codeChanged` when present, each bot push as
  `{ pr, at }`, and `own` is a copy, so a key the validator lets through
  never reaches the view. The `CaseView` comment now says the case's own
  dates stay out and the feedback's own times are input. A new test puts a
  `note` holding the hidden defect's summary on the feedback, on every
  comment and on every bot push: the manifest stays valid (the validator
  refuses no unknown key), the view equals the clean case's view and holds
  no note, and the view's `own` is not the manifest's array. The existing
  view test passes unchanged. The optional part, making `commentProblems`
  refuse unknown keys, was not taken: no other part of the schema refuses
  unknown keys, the view is now the boundary and fails closed on its own,
  and the guide now tells annotators to keep notes in `labels` anyway. It
  stays open to a later schema package.
- **The line checks built a list of every cited line** (`dataset.ts:1418`
  and `:1583`). Fixed by interval arithmetic, so `lineRange` is gone.
  `levelOf` asks whether `[line, endLine]` lies inside one hunk; this is
  the old "every line in some hunk" exactly, because git joins hunks whose
  context would meet, so two hunks' new-side ranges never touch (a comment
  says so). `addedWithin` counts the added lines that fall inside the range,
  walking the added set, which the diff bounds; "cites an added line" is a
  count above zero, "cites an unchanged line" a count below the range's
  span, and a head-added rule needs a count equal to the span. So a typo
  such as `endLine: 1000000000` is reported "past the end of the file" at
  once. A new test cites that endLine on a defect's alternative, a
  `notInChange` location and a head-added rule, and gets only the past-end
  messages (and the rule's own refusal). Two range cases now pin the
  arithmetic: a location running one line out of lib.py's hunk (17-21, and
  18-22 past the end) needs file, and a `notInChange` range whose only added
  line is its last (19-21) is refused. The finding's alternative, running
  the label checks only on locations that passed the past-end check, was
  not needed once nothing is materialised.
- **The interaction target counted defects, VS-41 counts cases**
  (`dataset.ts:1778`). Fixed. The round-two targets line now reads
  "interaction cases N/5", counting cases with at least one interaction
  defect; the "Sequences" line keeps its interaction-defect count, so both
  are reported. `ROUND_TWO_TARGETS.interactions` stays 5, and its comment,
  the guide's amendment and (k) above now say cases. A new dry-run test has
  one sequence case with two interaction defects: "2 interaction defect(s)"
  on the Sequences line, "interaction cases 1/5" on the targets line.
- **The pre-existing "is new in the change" check could never fire alone**
  (`dataset.ts:1552`). Removed, as the finding said: every line of a file
  the change adds is an added line, so such a location already gets "a line
  the change added", and the check only repeated it. `changeProblems`'
  comment now says a defect outside the change cites no added line, "so no
  line of a file the change adds". No separate message was wanted, so no
  new test; the existing added-line test stands.
- **`labels.feedback.finding.category` was cast without a check**
  (`dataset.ts:775`). Fixed. A category core does not read gets its own
  refusal, "labels.feedback.finding.category <value> must be one of core's
  finding categories (review/types.ts CATEGORIES), not a dataset defect
  category", and the probe (so the reach check) is built only once it
  passes, so the curator is no longer pointed at the comments. A non-string
  category keeps the old "needs the core category and the title" message.
  `dataset.ts` exports its own `CATEGORIES` (the defect categories) and
  AGENTS.md forbids aliased and star imports, so core's list is not
  imported by name: `isFindingCategory` asks core's `findingMarker` and
  `parseFindingMarker` (the parser the finding names) whether the value
  round-trips, as `carriesRules` asks `trustedRules`, so nothing is copied.
  A new test refuses "correctness" and "Bug" with that message alone, keeps
  the old message for a number, accepts every core category (the test
  imports core's `CATEGORIES`, which it can name), and shows a valid
  category the feedback does not dismiss failing only the reach.
- **invented-writers was reported as a round-two target**
  (`dataset.ts:132`). Fixed as the finding offered first: the value stays a
  labelled known-gap fixture, and the targets line lists only addendum A's
  four attacks. `FEEDBACK_ATTACKS` is now built from a module-private
  `ADDENDUM_ATTACKS` plus `invented-writers`, so its value and order are
  unchanged (its test passes as it was); the "Review feedback" tally still
  counts every attack. The new dry-run test checks an invented-writers case
  appears in the tally and not in the targets line; the two existing
  targets lines lost ", invented-writers 0/1". The guide says the first
  four attacks are the addendum's.
- **The leak guard's quoted list was narrow and case-sensitive**
  (`dataset.ts:759`). Fixed. It now also holds `labels.injection`,
  `labels.rationale` and the id of each defect and `notInChange` entry, and
  compares in lower case on both sides. The leak test gained the defect id,
  the injection text, an upper-cased summary and a lower-cased injection, and
  a case with a rationale and a `notInChange` entry (valid on its own) whose
  rationale, id, summary and cause are each refused. The price is that a
  short defect id is refused wherever a body happens to contain it; the
  curator renames the id or rewords the body, which is the fail-closed
  direction. `own` hashes are still not compared with the fix's short SHA:
  no finding asked, and they are validated as 12 to 64 hex characters.
- **Evidence.** Each run went through the lock with `--timeout 30000` and
  `GITHUB_ACTIONS=false`, with `TMPDIR` and the XDG roots under
  `/tmp/vector-vectorscope/vs22c-fix/`, one file at a time from
  `packages/script` (eval) or `packages/engine`:
  - `fixtures.test.ts` 103 pass (99 before; four new tests, and new
    expectations in five: the leak test, the context-level and
    `notInChange` object tests, and the two targets lines);
    `replay.test.ts` 38, `run.test.ts` 14,
    `report.test.ts` 34 and engine `test/review/vectorscope-replay.test.ts`
    18, all as before;
  - typecheck: `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json`
    from `packages/engine`, and `bun typecheck` in `packages/engine` and
    `packages/script`, pass;
  - prettier: clean on `dataset.ts`, `fixtures.test.ts`, the guide and the
    README;
  - dry runs: `bun dataset.ts` exits 0, and its only changed line is the
    round-two targets line ("interaction cases 0/5", no invented-writers),
    diffed against the same run with the two targets edits reverted on a
    restored scratch copy;
    `--mirrors /tmp/vector-vectorscope/vs22c/mirrors` exits 0 with 10 cases
    checked and the same one note (hono);
  - mutation check, ten mutations each applied alone to a scratch copy of
    `dataset.ts`, `fixtures.test.ts` run through the lock, and the file
    restored and compared after (`git diff --stat` and `cmp`): comments,
    bot pushes or `own` passed by reference; the case-sensitive compare;
    `labels.injection` dropped from the quoted list; any string accepted as
    a finding category; the targets line counting defects; the targets line
    listing every attack; `levelOf` reading only the first line; the added
    count reading only the first line. All ten were caught;
  - the full root typecheck was not run: nothing is pushed.
- Off by default as before: no `ReviewConfig` key, no change to
  `EVIDENCE_POLICY_KEYS`, `EvidenceScope` or `VARIANT_KEYS`, no runner or
  core change, no user-visible string (D14), no owner question decided, and
  nothing sent to a model.

## 2026-11-07 · VS-45a Severity-calibration judging (eval)

Addendum A §2, VS-45, in the Now window of §4 ("VS-45"). Built at `5abbc36c`
on `vectorscope-engine`. Addendum A's packages are proposals pending Q18, and
Q29 (a rubric revision with an importance axis) is open, so this is eval and
report work only: no runtime key (§1, "VS-45 and VS-46 are eval and report
work with no runtime key"), no §1a row, zero review tokens, and nothing calls
it from a runner. `run.ts`, `ai-review.ts`, `provider.ts`, `session/llm.ts`,
`posting.ts`, core `types.ts`, `config.ts`, `model-evidence.ts`, engine
`review/eval.ts`, `desktop.ts`, `replay.ts`, `ci.ts`, `certify.ts`,
`dataset.ts`, `annotation-guide.md`, `workflow.ts`, `command.ts`, `github.*`,
`github-*.ts`, `vectorscope.astro` and `.github/workflows/*` are untouched. It
implements the VS-45a plan as corrected by its critique: every critique point
was taken, point 6 in a corrected form and point 3 in both of its forms
(below). Nothing is committed.

- **What landed.**
  - **Core `eval.ts`:**
    - `IMPORTANCE_PROPOSAL` (`"vs45-importance-1"`), `IMPORTANCE`
      (would-block, should-fix, minor) and `Importance`,
      `IMPORTANCE_MIN_FINDINGS` (100), `IMPORTANCE_MIN_KAPPA` (0.4) and
      `GRADIENT_MARGIN` (0.1). `RUBRIC_VERSION` stays 1;
    - `JudgePass` and `Adjudication` gain `proposal?` and `importance?`, beside
      the verdict and never in it; `Settled`'s settled members gain
      `importance?`. `Verdict`, `sameVerdict` and `namespaced` are unchanged;
    - `settle` takes `proposal?`. A pass or adjudication counts only under
      the rubric and the proposal it was made under; the importance settles
      apart from the verdict (the adjudication's, or one every counted pass
      gives, as for a suggestion);
    - `importanceProblem` (used by `verdictProblem` and eval-judge's
      `answerProblem`), `rubricName` and `staleAgainst`;
    - `RunScore.bySeverity` (`SeverityTally`: judged, real, wouldBlock,
      important, unsettled), built from the judged findings by posted
      severity; `severityTallies` sums them, SEVERITIES first;
    - `Metrics.severityPrecision` (real of judged by posted severity, a table
      of proportions) and, under the proposal only, `Metrics.importance`
      (`ImportanceMetrics`: important precision, precision@blocking as VS-45
      defines it, the would-block `SeverityGradient`, unsettled);
    - `independentDifference` (Newcombe's method 10 for two independent
      proportions, beside `pairedDifference`) and `severityGradient`, defined
      once for VS-45 and VS-46;
    - `importanceAgreement` with `KappaPart` and `ImportanceAgreement` (`all`,
      `match`, `extra`, `decision`).
  - **Core `eval-judge.ts`:** `TaskFinding.severity` and `TaskDefect.severity`
    optional; `blind`, `judgeRuns`, `disputeTasks` and `judgingStatus` take
    `proposal?`; under the proposal a task shows no severity, a pass records
    the proposal and the importance, an answer whose importance does not fit
    is dropped, an agreed real verdict with no one importance is a dispute
    listed with each pass's importance, and the status counts
    `importanceDisagreed`. `judgeRuns` refuses an unknown proposal.
  - **Core `eval-report.ts`:** `ReportInput.proposal?`; `Report.proposal?`,
    `Report.importance?` (proposal only) and `Report.blockingDrops`;
    `breakdowns.highSeverity`; `BLOCKING_REFERENCE`, `MAX_BLOCKING_DROP` and
    `MIN_BLOCKING_FINDINGS` (50); a release reason under any proposal; the
    rendering below.
  - **`judge.ts` and `report.ts`:** `--proposal importance` (off by default).
    `JudgementFile.proposal?` and `Worksheet.proposal?`, written only under
    the proposal; `proposalOption` and `proposalMismatch` in `report.ts`,
    shared by both CLIs; `readJudgements` refuses a proposal that is not a
    name; `instructions(proposal)` for both worksheet kinds;
    `WorksheetFinding.verdicts` carries `importance`; adjudications copy the
    proposal and the importance.
  - **Docs:** `judging-rubric.md` (a pointer to the proposal, the
    summary-plus-inline rule with its S7 sentence, five metric rows, a release
    note; no rule changed, so no version bump, as VS-22a added metric rows);
    new `judging-rubric-importance.md`; `README.md` (two bullets).
  - **Tests:** core `eval.test.ts` (13 new), `eval-judge.test.ts` (3),
    `eval-report.test.ts` (9); `judge.test.ts` (2), `report.test.ts` (4). No
    test that existed at HEAD changed; only import lists grew.
- **Decisions.**
  - **(a) Neutral on Q29.** `RUBRIC_VERSION` stays 1 and the current rubric
    is the default everywhere. The importance axis is used only with
    `--proposal importance`, and a report judged under it is never a release
    decision (a release reason, so `certify.ts`, which needs
    `release.eligible`, can never certify from it). If Q29 is "no", nothing
    uses the option; if "yes", VS-45b adopts the axis as a new
    `RUBRIC_VERSION` before the held-out freeze (I-13).
  - **(b) A proposal is a name, never a rubric version** (critique point 1,
    taken in its first form). The plan numbered the proposal 2, the number
    VS-45b would give `RUBRIC_VERSION`; earlier entries (VS-42a (r), VS-22c
    (c)) also tie the "not in this change" tag to version 2. Under the plan,
    passes made today under this text would have counted once version 2 was
    adopted, whatever it then held. Instead every proposal pass,
    adjudication, worksheet and judgement file records `proposal:
    "vs45-importance-1"` beside rubric 1, and `settle` compares both, so a
    proposal pass is stale under every adopted rubric (tested with `rubric:
    2`, with passes carrying rubric 1 or 2), a current pass is stale under
    the proposal, and a pass under an earlier revision of the proposal is
    stale under the current one. The name changes whenever
    `judging-rubric-importance.md` changes. So the CLI option is `--proposal
    importance` rather than the plan's `--rubric 2`, the file is
    `judging-rubric-importance.md` rather than `judging-rubric-2.md`, and the
    plan's `RUBRICS` list is not needed.
  - **(c) Importance sits beside the verdict and settles apart from it.**
    The verdict, recall and precision settle exactly as under the current
    rubric; an importance disagreement goes to disputes. Corrected (critique
    point 5, taken): the proposal cannot reuse the current rubric's passes, so
    trying or adopting it repeats the whole judging, two passes per finding
    with both verdict and importance disputes adjudicated. Keeping importance
    apart only keeps adjudication within the proposal to the disputed
    findings. `judging-rubric-importance.md` says so for the owner's Q29.
  - **(d) Never pooled at three levels:** the pass (`settle`), the judgement
    file (`proposal`, absent meaning the current rubric) and the worksheet and
    report (each CLI refuses a file or worksheet under the other rubric, with
    "verdicts under two rubrics are never pooled").
  - **(e) No trend from the current rubric** (critique point 2, taken).
    Precision by posted severity, whose blocking row is precision@blocking (the
    kill rule's fallback), is a table with intervals and no trend or flag:
    under the current rubric a real concern is as real as a real blocking
    finding, so a flat real share says nothing about calibration. The gradient
    and its flag are computed only from the would-block share, under the
    proposal. Duplicates count in the denominator, as for actionable
    precision.
  - **(f) The gradient's step rule** (critique point 6, taken in a corrected
    form). Four states: falling (the Newcombe interval is above 0), inverted
    (below 0), flat (it rules out a fall of `GRADIENT_MARGIN`, 10 points, or
    more) and inconclusive (otherwise, not flagged); the gradient is flagged
    when flat or inverted. The critique offered "inverted on a point estimate
    below zero"; that was not taken, because at pilot sizes a point estimate
    below zero is noise as often as not, and it would bring back the
    asymmetry the point was about. The margin is this build's choice for a
    monitor that decides nothing; VS-45 names none. VS-46 inherits the rule
    through `severityGradient`, with its own `order`.
  - **(g) Severity hidden under the proposal, labels' included** (critique
    point 3, taken in both forms). A proposal task leaves out each finding's
    posted severity and each labelled defect's severity, and the proposal
    drops the plan's "a match normally takes the label's severity mapping"
    instruction, so two judges' importances on a match are not both read off
    the label. And agreement is reported over every pair (`all`, VS-45's
    rule as written) and for matches (both passes match) and extras (every
    other pair) apart. The kill rule is applied to all three, each with its
    own minimum of 100: drop if the whole or either part drops (at least 100
    double-judged findings and kappa below 0.4), else too-few or undefined if
    any of the three is, and keep only when all three keep. So the build is
    never looser than VS-45 and is stricter where a part alone is
    inconsistent. Amended in review: the first build applied the rule only
    per part and computed no pooled kappa, so 100 double-judged findings split
    60 matches and 40 extras with kappa 0.1 read too-few, not drop, and kept
    the unvalidated importance rows that VS-45 drops; the pooled part closes
    that case (tested: 60 disagreeing match pairs and 40 disagreeing extra
    pairs give drop and no importance rows). A test also has judges agreeing
    on every match while the extras alone give kappa 0.1667, and the decision
    is drop. The sample is the findings the importance metrics count: a
    finding of an adversarial case is left out (as `summarize`, `recallOf` and
    the monitor leave it out), and so is a `<variant>+reselect-strict` copy,
    which carries its original's judgements, so each judgement counts once
    (the first build counted a re-selected engine replay's findings twice
    under `--reselect strict --proposal importance`, which halved the real
    sample the minimum of 100 needs). Severity words inside a title or body
    cannot be hidden (stated in the proposal).
  - **(h) Kappa over two ratings per finding** (critique point 7, taken in
    its second form). Fleiss' kappa for two raters per finding, because the
    raters change from finding to finding and their order is arbitrary
    (Cohen's would read each judge's marginals). The two are the first two
    counted real verdicts in the order the judges first judged the finding,
    not the first two by name, so the result does not depend on judges'
    names. Fleiss over every judge needs an adjustment for a varying number
    of raters and the kill rule counts double-judged findings, so two per
    finding is kept. Until the decision is keep, every importance row is
    labelled "unvalidated: matches N and extras M of 100 double-judged".
  - **(i) The precision@blocking monitor** (critique point 4, taken). Each
    `engine:<name>` variant against `engine:shared-verify` on the same model,
    on the cases and repetitions both reviewed (as `pairedRecall` pairs), at
    the gate's stage, with both counts shown; "too-few" under 50 judged
    blocking findings on either side (VS-46's floor for showing a rate);
    flagged when the point estimates fall by more than 5 points. The
    would-block basis is used only when the kill rule keeps the axis, real
    findings otherwise; either way the denominator is every judged blocking
    finding, so an unsettled importance counts as not would-block, as VS-45
    defines precision@blocking (decision (o)). The frozen pipeline, the
    single-prompt harness, the empty control and `+reselect-strict` groups are
    not packages and are not compared. `desktop:<name>` groups are not
    compared either, though §1a gives packages desktop halves: `admitReplay`
    admits engine replays only, so no desktop group, and no
    `desktop:shared-verify` reference on the same runner, can exist to compare
    with, and comparing a desktop half with the engine reference would mix
    runners. A desktop comparison waits for a desktop replay (VS-10). It is a
    monitor, never a gate rule.
  - **(j) Nits** (critique point 10, taken). D2 does not count nits, so they
    are never judged; the render reads "nit excluded (the gate does not count
    nits)" instead of an empty row, and the proposal says that rating minor
    findings needs `--nits` and a gate that counts them, which is never a
    release decision.
  - **(k) The summary-plus-inline rule is written down and tested, with no
    change to scoring** [GU3] (critique points 9 and 11, taken). The posted
    list is the line comments, then the summary's lists; selection puts each
    finding in one of them; prose restating a finding is not one; a finding
    inline and another in the summary on one defect are a match and a
    duplicate; an inline and a summary finding with the same place and title
    share a key, so one judgement and a duplicate. `judging-rubric.md` adds
    that a pair S7 keeps apart but the judges match to one defect is still a
    match and a duplicate, so the eval is at least as strict as S7. The
    replay test records both writes, as the existing artifact does.
  - **(l) Contamination** (critique point 11). The proposal recommends
    different judges for it, or judging it before the current rubric.
  - **(m) D2 and `DEFAULT_GATE` are unchanged.** Its digest is still
    `8a4fa86e5ea88c1d` (now pinned in a test); `gateLoosening` reasons appear
    under the proposal too; the rules' outcomes, values and intervals are
    equal under both rubrics for equivalent verdicts.
  - **(n) The annotation guide is unchanged.** Importance is a verdict field,
    not a label; any guide revision waits for Q29.
  - **(o) Precision@blocking as VS-45 defines it, beside the share the
    gradient needs** (added in review). VS-45 defines precision@blocking as
    "posted blocking findings that are real and would-block, over all posted
    blocking findings". The first build reported only the would-block share
    with real findings whose importance is not settled left out of the
    denominator (the gradient's basis), and used it for the monitor, which
    reads higher than VS-45's form while an importance dispute is open. Now
    `ImportanceMetrics.blocking` and the report's "Precision@blocking (real
    and would-block)" row are VS-45's form, every judged blocking finding in
    the denominator and an unsettled one counted as not would-block; the next
    row, "unsettled left out", is the gradient's blocking step, and the
    monitor's would-block basis uses VS-45's form.
- **Off by default (I-1, I-12, §0.3).** No runner, key, request, prompt,
  schema or `ReviewConfig` field changed, so §0.3 items 1 to 5 do not apply
  (no key, no runner, no evidence-scope change, no variant, no desktop half);
  item 6 is this entry. Under the current rubric `settle` and scoring are
  byte-identical for every pass a tool wrote before VS-45, and so are the
  stale-pass, stale-adjudication and worksheet refusals ("judged under rubric
  0, not 1: the pass is stale", "used rubric 0, not 1", "was written for
  rubric 2, not 1."): `staleAgainst` names the rubric in full only when a
  proposal is on either side (tested; the first build had changed them to
  "not rubric 1"). The one new
  refusal is a current-rubric pass or adjudication that carries an
  importance, which no earlier tool wrote, and it is listed as a problem
  rather than silently counted. Blinded tasks, worksheets and new judgement
  files are byte-identical (tested: no `proposal` key, the same instructions,
  severity shown). The default report only gains rows, lines and JSON fields
  (`severityPrecision` in each stage's metrics, `breakdowns.highSeverity`,
  `blockingDrops`; `RunScore.bySeverity` is internal); existing numbers do not
  move and no existing test changed.
- **Pin, revision and rubric.** No file in `REVIEW_PIPELINE_FILES` changed:
  `REVIEW_PIPELINE_SOURCES` stays `124e47864a16fea4` (`model-evidence.test.ts`
  passes unchanged), `REVIEW_PIPELINE_REVISION` stays 1, `RUBRIC_VERSION`
  stays 1, and `EVIDENCE_POLICY_KEYS` and `VARIANT_KEYS` are unchanged.
- **Owner questions: none decided.** Q29, Q3, Q18 and Q30 stay open; every
  part reads the same under either answer.
- **Deferred.**
  - Adopting the axis as a new `RUBRIC_VERSION`, any revision of the current
    rubric's text and of the annotation guide: VS-45b, on Q29 "yes", before
    the held-out freeze (I-13). Adoption judges again; no proposal pass
    carries over.
  - The "not in this change" judging tag (VS-42a (r), VS-22c (c)) stays
    deferred: the proposal is the importance axis only, and a scope verdict
    would widen Q29.
  - High-severity recall by risk band [G2-5]: artifacts record no band until
    VS-28 or VS-39 wiring.
  - "Done when": the metrics on the D5 pilot's judged findings, after D7; no
    paid run here.
  - The kill rule needs at least 100 double-judged findings under the
    proposal to drop the axis, and 100 matches and 100 extras to keep it, so
    it needs Q29 and human time.
  - The monitor needs real replays of `engine:shared-verify` and each package
    variant on the same model.
  - VS-46's use of `severityGradient` lands with VS-46.
  - A model-judge prompt for importance: no model judge is wired (D5, D12).
  - Importance on nits: needs `--nits` and a gate that counts them.
- **Evidence.** Each test file ran alone through the lock with `--timeout
  30000` and `GITHUB_ACTIONS=false`, with `TMPDIR` and the XDG roots under
  `/tmp/vector-vectorscope/vs45a/`. Core tests ran from `packages/core`; the
  eval script tests ran from `script/vectorscope-eval` (as its README runs
  them, critique point 8), and again from `packages/script` as `test.yml`
  runs them, with the same counts.

  | File | HEAD | After |
  | --- | --- | --- |
  | core `eval.test.ts` | 42 | 55 |
  | core `eval-judge.test.ts` | 12 | 15 |
  | core `eval-report.test.ts` | 19 | 28 |
  | core `model-evidence.test.ts` (pin unchanged) | 30 | 30 |
  | `judge.test.ts` | 6 | 8 |
  | `report.test.ts` | 34 | 38 |
  | `certify.test.ts` | 7 | 7 |
  | regressions: `fixtures.test.ts`, `replay.test.ts`, engine `test/review/eval.test.ts` | 103, 38, 33 | 103, 38, 33 |

  All pass.
  - **Typecheck.** `bun typecheck` in `packages/core`, `packages/engine` and
    `packages/script`, and `bun tsgo -p
    ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`: all
    pass. The full root typecheck was not run: nothing is pushed.
  - **Format.** prettier passes on every changed TypeScript file, the README
    and the new proposal. `judging-rubric.md` was not prettier-clean at HEAD
    (its tables), so only the new lines were added and the file was not
    reformatted; this log is append-only, as before.
  - **Mutation check.** Twenty-five mutations, each applied alone, the named
    test file run through the lock, and the file restored and compared
    (`cmp`, and `git diff --stat` before and after the batch): `RUBRIC_VERSION`
    set to 2; an importance accepted under the current rubric; agreement
    requiring one importance; proposal passes counted under an adopted rubric;
    duplicates counted as real by severity; a step falling on a positive
    point difference alone; a step inverted on a negative point difference
    alone; Newcombe's bounds swapped; false-alarm passes in the kappa; Cohen's
    kappa for Fleiss'; the kill rule ignoring extras; severity shown under the
    proposal; importance disputes not disputed; `judgeRuns` dropping the
    importance; the proposal's release reason removed; the drop check at `>=`;
    the drop check unpaired; the would-block basis before keep; the frozen
    pipeline compared; the unvalidated label removed; high-severity recall
    counting every defect; `report.ts` and `judge.ts` skipping the file check;
    `judge.ts` skipping the worksheet check; adjudications dropping the
    importance. All were caught. Two boundary tests were added for them (a
    6/10 against 4/10 step is inconclusive; exactly five points down is not
    flagged).
  - **Merge prediction.** `git diff --name-only HEAD...origin/<branch>` over
    every file this package touches is empty for `origin/self-evolving`
    (`f062bcce`), `origin/codium` (`5a079cbd`), `origin/vector-at-mention`
    (`0b68e8f6`) and `origin/main` (`4299d743`), so it adds no conflict.
  - Nothing was sent to a model, no paid path ran, no workflow was
    dispatched, no dependency was added, and no user-visible string changed
    (D14).
- **Review fixes (round one).** Ten findings, two of them the same defect
  reported twice; all taken, none disputed. Nothing is committed.
  - **Blocking: re-selected copies counted twice in agreement.**
    `agreementOf` now leaves out runs whose variant has a `+` (outside
    `VARIANT_NAME`; report.ts's `<variant>+reselect-strict` copies, scored on
    their original's judgements), so each judgement counts once. A variant
    check rather than `passes` identity, because it does not depend on how
    report.ts copies a judgement. Tested in core (copies under a `+` variant
    leave `importance` equal) and end to end in `report.test.ts` (`--reselect
    strict --proposal importance` gives the same match and extra counts as
    without `--reselect`).
  - **Blocking: no pooled kappa.** `ImportanceAgreement.all` and the decision
    in decision (g), as amended; `renderAgreement` shows the pooled part and
    the kill rule "over all and per part"; the report's note and
    `judging-rubric-importance.md` say the same. Tested in core
    (`importanceAgreement`, and a report whose 60 match and 40 extra pairs
    all disagree gives drop and no importance rows).
  - **Precision@blocking's denominator:** decision (o). The contract's form
    is now the "Precision@blocking (real and would-block)" row and the
    monitor's would-block basis; the share with unsettled findings left out
    is its own row.
  - **Desktop groups in the monitor:** decision (i) gives the reason.
  - **Adversarial findings in agreement:** left out, as the importance
    metrics leave them out (the case is looked up by `run.case`; a run on an
    unlabelled case is left out too, as scoring leaves it out).
  - **Stale wording under the default rubric:** restored by `staleAgainst`
    (off-by-default paragraph above); tested for a pass, an adjudication and
    a worksheet.
  - **`severityTallies` and inherited keys:** `Object.hasOwn`, so a severity
    such as `constructor` or `__proto__` in a hand-edited artifact reads only
    a score's own tally (tested with both).
  - **Style:** `(f) =>` renamed, the single-use `runner` inlined into the
    `startsWith` check, and `proposalOption`'s explicit return type dropped
    (inference gives `"vs45-importance-1" | null | undefined`).
  - **Evidence.** Each file alone through the lock with `--timeout 30000`,
    `GITHUB_ACTIONS=false` and `TMPDIR` and the XDG roots under
    `/tmp/vector-vectorscope/vs45a/`: core `eval.test.ts` 55,
    `eval-judge.test.ts` 15, `eval-report.test.ts` 28, `model-evidence.test.ts`
    30 (pin unchanged); from `script/vectorscope-eval`, `judge.test.ts` 8,
    `report.test.ts` 38, `certify.test.ts` 7, `replay.test.ts` 38; from
    `packages/script`, `judge.test.ts` 8, `report.test.ts` 38,
    `fixtures.test.ts` 103; engine `test/review/eval.test.ts` 33. All pass.
    `bun typecheck` in `packages/core`, `packages/engine` and
    `packages/script`, and `bun tsgo -p
    ../../script/vectorscope-eval/tsconfig.json` from `packages/engine`, all
    pass; prettier passes on every changed TypeScript file, the README and the
    proposal. Nine mutations, each applied alone, its test files run through
    the lock, and the file restored and compared (`cmp`, and `git diff
    --stat` before and after): the pooled part ignored in the decision; the
    own-key check removed; the stale pass, adjudication and worksheet
    wording each named in full; precision@blocking with unsettled findings
    left out; the monitor with them left out; adversarial cases in agreement;
    re-selected copies in agreement. All were caught.

## 2026-11-07 · VS-46a Outcome ledger script (eval)

Addendum A §2, VS-46, in the Now window of §4 ("VS-46 (script)"). Built at
`766553f1` on `vectorscope-engine`. Addendum A's packages are proposals
pending Q18, and Q30 (reading the owner's production markers and merged PRs,
and assigning depth per PR) is open, so this is a script and its tests only:
no runtime key (§1, "VS-45 and VS-46 are eval and report work with no runtime
key"), no §1a row, zero review tokens, and nothing calls it from a runner. It
has never been run against the owner's or any real repository, it read no
production marker or merged PR, and no ledger data exists or is committed
(I-13). Nothing under `packages/` changed: `run.ts`, `ai-review.ts`,
`provider.ts`, `session/llm.ts`, `posting.ts`, core `types.ts`, `config.ts`,
`model-evidence.ts`, `state.ts`, `team.ts`, `risk.ts`, `eval.ts`,
`eval-report.ts`, `workflow.ts`, `command.ts`, `github.*`, `github-*.ts`,
`vectorscope.astro` and `.github/workflows/*` are untouched. It implements
the VS-46a plan as corrected by its critique: every one of the nineteen
critique points was taken, point 4 in its second form (below). Nothing is
committed.

- **What landed.**
  - **New `script/vectorscope-eval/seal.ts`** (critique point 5): `seal`,
    `unseal`, `publicKey` (now exported), `Sealed`, `SEALED_SCHEMA`,
    `PUBLIC_KEY_ENV` and `MIN_KEY_BITS`, moved out of `ci.ts` unchanged, plus
    `OUTCOME_LEDGER_FILE` (`"outcomes-ledger.json"`). It imports
    `node:crypto` only.
  - **`ci.ts`:** imports and re-exports the moved names (its exported surface
    is the same: `PUBLIC_KEY_ENV`, `SEALED_SCHEMA`, `seal`, `unseal`,
    `Sealed`), and `unseal` refuses a bundle that holds
    `OUTCOME_LEDGER_FILE`, writing nothing (the ledger's expiry is checked
    only by `outcomes.ts open`). The plan's three `ci.ts` edits became this:
    `publicKey` is exported from `seal.ts`, and the constant lives there, so
    `outcomes.ts` never loads `ci.ts`.
  - **New `script/vectorscope-eval/outcomes.ts`:** VS-46 design items 1, 2,
    3 and 5. `findingOutcome`, `bulkResolved`, `agentStratum`,
    `revertTargets`, `fixKind`, `matured`, `hashLogin`, `ghArgs`, `ghReader`,
    `localGit`, `collect`, `ledgerProblem`, `outcomeReport`, `renderOutcomes`
    and `main` (`collect` and `open`), with the ledger and report types and
    constants (`LEDGER_DAYS` 180, `MATURITY_DAYS` 90, `LABEL_WINDOWS` 30 and
    90, `MIN_SETTLED` 50, `MIN_PULLS` 50, `MIN_VOLUME` 200, `MIN_MATURED`
    200, `CLOCK_SKEW_MS` five minutes, `MAX_API_CALLS` 4,000, `FIX_LABEL`,
    `NOT_FIX_LABEL`, `WRITER_PERMISSIONS`, `READ_ONLY_GIT`, `THREADS_QUERY`,
    `THREAD_COMMENTS_QUERY`). It reuses core `state.ts` (`findSticky`,
    `readState`, `priorFromComment`, `priorFromState`, `mergePrior`,
    `classifyPrior`, `parseDismissalMarker`, `encodeState`), `diff.ts`
    (`fromGitHubFiles`, `parseUnifiedDiff`), `ignore.ts` (`classifyFiles`),
    `risk.ts` (`riskFeatures`, `riskOf`, `FIX_SUBJECT`, `REVERT_SUBJECT`),
    `team.ts` (`BULK_RESOLVE_THREADS`), `eval.ts` (`DEFAULT_SLACK`,
    `proportion`, `severityGradient`), `eval-report.ts` (`spread`), and
    `dataset.ts`'s `UNTRUSTED_GIT` and `untrustedGitEnv` (I-10): no second
    store, isolation layer or code reader.
  - **New `outcomes.test.ts`** (40 tests, 33 before the review round) and
    one new `ci.test.ts` test.
  - **`README.md`:** an "Outcome ledger (VS-46a)" section.
  - CI needs no change: `test.yml` already runs every
    `script/vectorscope-eval/*.test.ts` from `packages/script`, and
    `typecheck.yml` checks the eval tsconfig, whose `*.ts` includes the new
    files.
- **Decisions.**
  - **(a) Neutral on Q30.** The script is built and never run. It refuses to
    start in GitHub Actions, has no default repository, and checks the
    sealing key, the output directory and the agent record before its first
    read (tested with a recording GitHub client and a recording git: 0 calls
    for each of fifteen refusals). If Q30 is "no", nothing runs it; if
    "yes", the owner runs `collect` on a nominated repository.
  - **(b) Nine outcomes.** VS-46's seven, plus `dismissed-unattributed` (a
    dismissed marker whose writer or author can no longer be found among its
    signals; never counted as either) and `fixed-self-resolved` (decision
    (c)). The first matching rule decides: outdated, fixed, dismissed, then
    open (acknowledged by a reply the job would not read as a dismissal or a
    positive reaction, compared case-insensitively because GraphQL spells
    reactions as uppercase enums; open at merge otherwise).
  - **(c) A confirmed fix needs a resolver who is neither a bot nor the PR
    author** (critique point 1, taken). The job resolves the thread itself
    when it marks a finding fixed (`github.review.ts`), so a bot resolver is
    `fixed-model-only`; an author's resolve, which agent loops and self-only
    engagement produce [FL9, G6-16, FL10], is `fixed-self-resolved` and is
    never in the confirmed numerator. `LedgerFinding.resolver` records the
    role (author, writer, other, bot). A User-type agent account that is not
    the PR author and resolves threads still reads as a person: only the
    trusted agent record catches it, so its PRs fall in the agent stratum
    when the owner lists them.
  - **(d) Attribution reuses the job's rules:** `parseDismissalMarker` when a
    well-formed `vector-dismissal` marker exists (none is written before
    VS-35's later window), else `classifyPrior` on the thread as it is now
    with no `changes`, so only its dismissal rule can apply and a bot is
    never a writer. Permission lookups mirror the job: the dismissal-signal
    logins and resolvers only, cached, and any lookup error reads as not a
    writer. Roles are read at collection time, not at dismissal time, so a
    writer who has since left reads as `dismissed-unattributed` or `other`
    (role drift, a known limit).
  - **(e) Settled set and rates.** Settled: confirmed fix, acknowledged,
    writer and author dismissals. The gradient is VS-45's `severityGradient`
    over the confirmed-fix share of settled human-stratum findings, with its
    flat-or-inverted flag as the flat-rate check [FL10, CF15]; a sensitivity
    gradient counts every fix (self-resolved and model-only included) over
    settled findings plus those (critique point 12). An acknowledgement may
    be the author's own reply or reaction; `humanEngaged` separates it.
  - **(f) Bulk is count-based** (GitHub's review-thread API gives no resolve
    time, so `BULK_RESOLVE_MS` cannot apply): at least
    `BULK_RESOLVE_THREADS` inline threads one non-bot actor resolved, with no
    non-bot reply and no fix. Bulk findings are split out, never relabelled.
  - **(g) Agent authorship comes only from the owner's trusted record**
    (`--agent-prs`, `{repository, pulls}` for this repository, outside the
    clone and this checkout). A Bot-type or `[bot]` author, commit author or
    co-author trailer only moves a PR to `agent-signal`; no agent or product
    is named. Precedence per finding: agent, then bulk, then the PR's
    stratum. Findings are rebuilt only from the configured `--bot` logins'
    comments (critique point 14): each `--bot` is normalised to its `[bot]`
    form and compared exactly, case-insensitively, after `graphLogin`, so
    another bot's thread, and a User account whose login equals the App's
    slug, is never a finding or the sticky state (round one, finding 12).
    The `[bot]` test is used for resolvers, engagement and strata. A deleted
    ("ghost") account, which GraphQL names with an empty login, is nobody: it
    neither engages nor acknowledges, and is never looked up.
  - **(h) Label sources.** First-parent history of the base branch read
    with read-only git; a fix's deleted lines blamed with `--first-parent`
    at the fix's first parent, so each blamed commit is a base merge,
    squash or rebased commit (critique point 10; the fixture's PR #3 is a
    real `--no-ff` merge, and blame without `--first-parent` misses it);
    commit-to-PR through the merged-PR listing's `merge_commit_sha`, with
    `commits/{sha}/pulls` only for a first-parent commit in the window the
    listing cannot match. A fix label (`FIX_LABEL`, which accepts bugfix and
    bug-fix, unless `NOT_FIX_LABEL` matches: not a bug, invalid, won't fix,
    duplicate, or a question mark), else `FIX_SUBJECT` on the fix PR's title
    (or the commit subject without a PR). A revert is never a fix: its
    subject or its PR's title matching `REVERT_SUBJECT` (for a merge commit
    with a mapped PR, the PR's title only, because GitHub's merge subject
    names the source branch), or a revert target found by `revertsOf`.
    `revertsOf` reads the commit's own message and, for a first-parent
    merge, the messages of the commits it brought in
    (`git log --format=%H%x1f%B%x1e <sha>^1..<sha>`), so a `--no-ff` merge of a revert
    PR, whose revert sits on the second parent under "Merge pull request #N
    from ...", still reverts the PR it names; a brought-in revert of a commit
    on the same branch reverts nothing on the base. Known undercounts: a fix
    whose own subject or PR title mentions reverting ("fix: do not revert
    the cache"), a merge commit with no mapped PR whose branch name does
    (only its subject is there to read), a fix that only adds lines (no
    deleted line to blame, as in SZZ), a brought-in revert of a commit that
    is not on the first-parent history (no PR is mapped to it), and
    whitespace or comment lines are not filtered.
  - **(i) Windows.** 30 and 90 days for both labels. Matured means merged at
    least 90 days before the clone's history ends
    (`mergedAt <= observedUntil - 90 days`). `observedUntil`, recorded in the ledger, is
    the newest committer time on the clone's first-parent history, capped
    at `collectedAt`: a commit reaches the branch no earlier than its
    committer time, so the clone holds everything that reached the branch
    before then, and a clone fetched weeks before the run never reads a PR
    whose window it has not seen as clean. In a quiet repository this is
    conservative (PRs merged in the 90 days before its last commit are not
    matured). Collection also refuses a clone whose base branch lacks the
    merge commit of any PR GitHub lists as merged since `--since`, inside
    the window or not, before any PR is read (round one, finding 2). A
    PR reverted within 90 days is neither positive nor clean for the fix
    label and gets no line counts or later-fixed flags [G2-9, RP1]; the
    revert rate's denominator is every matured PR. Days are a first-parent
    commit's committer time against GitHub's `merged_at`.
  - **(j) Escapes.** Each fix-edited line of a matured, not-reverted,
    reviewed PR is skipped (a path the default skip rules leave out, through
    `classifyFiles`), unreviewed (`state.unreviewed`), flagged (a RIGHT-side
    finding on its file within `DEFAULT_SLACK` lines of its anchor or of a
    line its `also` names as the same defect) or escaped; `laterFixed` uses
    the same lines. Blame names a file unquoted where git can
    (`core.quotePath=false`), and a name git still quotes (a quote, a
    backslash or a control character) is C-unquoted as `diff.ts`
    `readQuoted` does, so a fix-edited line in a file with a non-ASCII name
    is compared with the finding's GitHub path. Limits: an inline finding's
    `also` lines are read from its comment and are lines of the commit it
    was raised on, not of the merged head; a summary finding's are at the
    last reviewed head.
    `state.unreviewed` lists only the files the last partial run missed; the
    repository's own ignore globs and `.gitattributes` are not read, so
    escapes are overstated; blamed line numbers are in the blamed commit's
    file, exact for squash merges and approximate where the base moved under
    a merge; an inline finding's line is its thread's current line, or its
    original line when GitHub marks it outdated.
  - **(k) Logins** (critique point 4, taken in its second form). HMAC-SHA256
    of the lowercased login under a random per-run key that is never stored,
    first 16 hex characters. The ledger stores no login, title, body, path
    or code, but it keeps the repository, PR numbers and finding ids, so
    hashing hides logins in the file only: anyone with access to the
    repository can recover the people from a PR number, and two ledgers can
    be joined on PR numbers. The README says so; no claim that ledgers
    cannot be joined is made. The first form (per-run ordinals, finding ids
    dropped) was not taken: the merge and creation times the maturity,
    windows and cycle time need, and the change sizes, would still identify
    each PR through the API, so ordinals would hide nothing, and PR numbers
    let the owner audit a label.
  - **(l) Sealing and expiry** (critique point 8, taken). `collect` writes
    only `<out>/vectorscope-outcomes.sealed.json`, sealed with `seal()`
    under `PUBLIC_KEY_ENV`, with `collectedAt` and `expires` inside the
    authenticated payload. `ledgerProblem` refuses another schema, a missing
    date, a collection more than five minutes after now, an expiry at or
    before collection, an expiry more than 180 days after collection, and
    `now >= expires`, and then decodes every entry with an Effect Schema
    (`LedgerEntries`: outcomes, strata, severities, categories, resolvers and
    bands from their lists, finite non-negative numbers, parseable dates,
    string repository and branch, a `merged` window) before `open` creates
    anything. `open` reads its files and JSON through
    `Schema.UnknownFromJsonString`, and an unreadable file, invalid JSON or
    a key that does not open the bundle is a refusal with a message, never
    an exception. `open` writes only `outcomes-report.md` unless
    `--ledger` is given, prints the expiry and says to delete the files by
    then; `ci.ts unseal` refuses a ledger. Directories are created 0700
    and every file `collect` and `open` write is 0600, since the ledger and
    the report keep PR numbers. Sealing gives confidentiality,
    not authenticity: anyone with the public key can seal a payload, so the
    bounds cap an edited payload's life but are a guard against keeping a
    ledger too long, not a security control.
  - **(m) Outputs and trusted input stay out of every work tree** (critique
    point 3, taken). `--out` and `open`'s directory must be outside this
    checkout and outside every git work tree (a directory at or above them
    holding `.git`); `--out` must also be outside `--repo-dir` (the only
    check that covers a bare clone, tested). `--agent-prs` must be outside
    the clone and this checkout, whose files PR authors control (I-2). Every
    one of these paths, and the checkout and clone it is compared with, has
    the symbolic links in its existing part resolved first, so a link cannot
    carry an output or the record into a work tree.
  - **(n) Read-only access.** GitHub through `gh api` only: every REST call
    is a GET (`--method GET`), under `/repos/<owner/name>` compared
    case-insensitively, with no `..`, `.`, empty segment, `%2e`, whitespace,
    `#`, backslash or gh placeholder (`{owner}`), and a query string of safe
    characters (critique point 16). GraphQL: a document starting with
    `query` and naming no mutation or subscription; strings go through `-f`,
    safe integers through `-F` (which reads `@file` values). The thread
    query copies the engine's shape (`reactors { nodes { __typename ... on
    Actor { login } } }`, `pageInfo` on both connections, `fullDatabaseId`
    only, with no Enterprise Server `databaseId` fallback), and a thread's
    further comments use the engine's second query (critique point 6; the
    fixtures use GraphQL's response shape and uppercase reaction enums).
    Git through `localGit`: `rev-parse`, `config --get-regexp`, `log`,
    `diff` and `blame` only, under `UNTRUSTED_GIT` and `untrustedGitEnv()`
    with `GIT_NO_LAZY_FETCH=1`, `diff` with the engine's reviewed-diff
    options (`--no-color --no-ext-diff --no-textconv --no-relative
    --src-prefix=a/ --dst-prefix=b/`), `log` with `--no-show-signature
    --no-ext-diff --no-textconv --no-color`, `blame` with `--no-textconv`
    and `-c blame.ignoreRevsFile= -c core.quotePath=false`, and `--output`,
    `--ext-diff`, `--textconv` and `--show-signature` refused before `--`
    only, so a path a PR author named `-o` cannot stop a run (critique
    point 2: a probe
    here showed plain `git blame` and `git diff` both run a clone-local
    textconv driver, and the sentinel test proves the control runs it and
    `localGit` does not). A shallow clone and a partial clone (the impact
    builder's `config --get-regexp` pattern) are refused before GitHub is
    read (critique point 19).
  - **(o) Caps and failures** (critique points 14 and 15, the paging part).
    `per_page=100` everywhere; the merged-PR listing stops at 30 pages (a
    problem), comments, reviews and files at 30 pages (files at 3,000),
    commits at 250, threads at 20 pages and further thread comments at 50
    pages per PR; each cut-short read marks the PR truncated with a problem.
    At most 4,000 GitHub requests per run (below `gh`'s hourly REST limit),
    enforced by the client itself, which refuses any read past the cap: a PR
    is read only with at least 200 left (a cap refusal while reading it
    truncates it), the listing stops at the cap with a problem, and
    permission lookups or commit lookups the cap stops are problems too. A truncated PR is left
    out of every rate. Any read error aborts, so no partial ledger is ever
    written. Rate-limit waits are not implemented: a limit error aborts the
    run.
  - **(p) Per-PR fields** (critique points 7 and 9, taken). `rereviews` is
    `max(state.reviews - 1, 0)` (the state counts completed reviews with a
    cost; a carry run does not count), by count only: the state keeps a PR's
    total spend, so the re-review share of spend is "not recorded".
    `statePruned` flags a state at the 60-finding cap or within 512
    characters of the 16,000-character limit, where `pruneState` may have
    dropped summary findings, so their counts are a lower bound. The band
    is `riskOf(riskFeatures(review, { changed }))` on the PR's files mapped
    by `fromGitHubFiles` and split by `classifyFiles` with the default
    config (no `.gitattributes`, no dependents, no history), and it is left
    out when the file listing was cut short. PRs without a sticky state are
    kept (`reviewed: false`) for bands and post-merge rates.
  - **(q) Report rules** (critique point 13, taken). The volume population
    is one, in the code, the README and the rendering: settled human-stratum
    findings on non-truncated PRs merged in the 90 days before collection;
    below 200 only the gradient, its sensitivity row, the split and the
    counts are reported. A cell over settled findings needs `MIN_SETTLED`
    (50), and a cell over PRs or reviews (escapes, bands, re-reviews) its
    own `MIN_PULLS` (50); below it the value is null and the count and
    Wilson interval stay, gradient shares included (the steps keep their own
    intervals). The band check needs 200 matured PRs with a band; "overlap"
    when the low and high bands' intervals for reverted-or-fixed within 90
    days overlap, with the note that `riskOf` is then a size, reach and
    sensitivity heuristic for that repository and history risk areas are
    never enabled there. Every rate carries cycle time p50 and p90
    (`spread`, type 7) over its own PRs: each gradient row (per severity,
    over the PRs of the findings it counts), each resolution and band row,
    and the human-presence, writer-dismissal, escape, later-fixed and
    re-review lines; the split and the totals carry the overall line. The
    rendering opens with "Internal measurement: no accuracy or
    comparative claim (D12). Sealed; expires <date>."
  - **(r) Labels come from writer-merged history only.** Commit messages,
    fix PRs' labels and titles; PR-side text (bodies, comments) never sets a
    label.
  - **(s) A thread resolved after the job's last run stays as the marker
    says.** An open marker whose thread a person resolved later reads as
    `open-at-merge` with its resolver role recorded: the ledger never
    re-applies the fix rule, which needs the code at the PR's final head
    (often not in a squash-merged clone), so fixes made after the last run
    are undercounted.
- **Off by default (I-1, I-12, §0.3).** No runner, key, request, prompt,
  schema or `ReviewConfig` field changed, so §0.3 items 1 to 5 do not apply;
  item 6 is this entry. The script runs only when the owner invokes it, never
  in CI. The only behaviour change to existing code is `ci.ts unseal`
  refusing a bundle that holds `outcomes-ledger.json`, which nothing produces
  today (the paid job seals `EVAL_OUT_DIR`'s reports, logs and
  `ledger.jsonl`); `ci.test.ts`'s 34 existing tests pass unchanged.
- **Pin, revision and rubric.** No `REVIEW_PIPELINE_FILES` file changed:
  `REVIEW_PIPELINE_SOURCES` stays `124e47864a16fea4` (`model-evidence.test.ts`
  passes unchanged, 30), `REVIEW_PIPELINE_REVISION` stays 1, and
  `EVIDENCE_POLICY_KEYS`, `VARIANT_KEYS` and `RUBRIC_VERSION` are unchanged.
- **Owner questions: none decided.** Q30, Q18, Q29 and Q3 stay open; every
  part reads the same under either answer.
- **Deferred.**
  - **Item 4, proxy validation**, to VS-46b in the Now window: eval-harness
    work over `report.ts`'s outputs and judged replays, which needs the fix
    diffs from the mirrors; its Spearman of at least 0.5 over 6 cells and
    4-of-5 ordering rule need D7 replays.
  - **Item 6, history risk areas**: needs at least 200 matured PRs, a
    separation-improvement statistic, and a change to `riskOf` for a
    repository, which belongs to VS-39 wiring (runner-wiring window).
  - **Item 7, depth assignment**, and its `EvidenceScope` record: runner
    wiring and Q30. Only the static "no runner draws depth at random" test
    landed (it reads `run.ts`, `plan.ts`, `risk.ts`, `config.ts` and
    `ai-review.ts` as text).
  - **The re-review share of spend**: VS-41 or VS-47 (per-review spend).
  - **"Done when"**, a run on one owner repository producing the sealed
    report: Q30.
  - **Not verifiable here:** the real shapes of `gh` output
    (`originalLine`, `reactionGroups`, `commits/{sha}/pulls` for squash and
    rebase merges, permission responses), rate limits, performance
    on long histories, and pooling several repositories (one ledger per
    repository; pooling is not built).
- **Evidence.** Each test file ran alone through the lock with `--timeout
  30000` and `GITHUB_ACTIONS=false`, with `TMPDIR` and the XDG roots under
  `/tmp/vector-vectorscope/vs46a/`. The eval tests ran from
  `script/vectorscope-eval` (as its README runs them) and again from
  `packages/script` (as `test.yml` runs them), with the same counts.

  | File | HEAD | After |
  | --- | --- | --- |
  | `outcomes.test.ts` | new | 40 (33 before the review round) |
  | `ci.test.ts` | 34 | 35 |
  | `report.test.ts`, `replay.test.ts`, `certify.test.ts` | 38, 38, 7 | 38, 38, 7 |
  | `fixtures.test.ts` | 103 | 103 |
  | core `model-evidence.test.ts` (pin unchanged) | 30 | 30 |

  All pass.
  - **Typecheck.** `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json`
    from `packages/engine` and `bun typecheck` in `packages/script`: both
    pass. No package changed, so no package typecheck beyond these applies.
    The full root typecheck was not run: nothing is pushed.
  - **Format.** prettier `--check` passes on `outcomes.ts`,
    `outcomes.test.ts`, `seal.ts`, `ci.ts`, `ci.test.ts` and the README.
    This log is append-only, as before.
  - **Import graph** (critique point 5). The test follows every relative
    import transitively with Bun's transpiler: 30 files, all under
    `packages/core/src/`, `packages/schema/src/` or the four eval files
    `outcomes.ts`, `seal.ts`, `dataset.ts` and `paths.ts`. `run.ts`,
    `replay.ts`, `ci.ts`, `budget.ts`, `fixture.ts`, `desktop.ts`,
    `judge.ts` and `report.ts` are unreachable; no reached file is a
    provider, session, tool, MCP, Brain or LLM module or calls `fetch`; only
    `outcomes.ts` (gh and git) and `dataset.ts` (git) start a process; bare
    imports are `node:*`, `minimatch`, `effect` and `@vectordevai/schema/*`.
    `dataset.ts` brings in core `config.ts`, whose `privacy.ts` loads the
    free-model catalog and the local-mode policy; none of them sends
    anything.
  - **Mutation check.** Fifty-one mutations, each applied alone, its test
    file run through the lock, and the file restored and compared (`cmp`,
    and `git diff --stat` before and after the batch): a bot resolver read
    as a person; the dismissal marker ignored; an author dismissal read as a
    writer's; a dismissal-phrase reply read as acknowledged; the author
    counted in `humanEngaged`; the bulk threshold at 4; an untrusted signal
    promoted to agent; the trusted record overridden; maturity at 89 days;
    maturity at `<`; reverted PRs counted clean in the report and in the
    ledger's line counts; a revert subject accepted as a fix; blame on the
    fix itself; blame without `--first-parent`; slack 0 for escapes and for
    later fixes; `MIN_SETTLED` off by one in cells and in gradient shares;
    the volume rule ignoring the 90-day window; the band rule at 199; a
    case-sensitive `hashLogin`; `>` for `>=` in the expiry; the 180-day
    bound unchecked; a future collection accepted; an unsealed ledger
    written by `collect`; `--method GET` dropped; a mutation accepted;
    `fetch` allowed in `localGit`; the `ci.ts` unseal guard removed; the key
    checked after the reads; an author resolver counted as confirmed;
    `--no-textconv` dropped from diff and from blame; `--out` allowed inside
    the clone or inside a work tree; `--agent-prs` allowed inside the clone;
    findings rebuilt from any `[bot]`; reactions compared case-sensitively;
    bugfix labels missed; not-a-bug labels counted; a partial clone
    accepted; thread-comment paging ignored; the call cap ignored; a merge
    commit off the base accepted; `open` skipping the expiry check; `open`
    writing the ledger by default; Actions not refused. All were caught.
    `--out` inside the clone first survived, because the clone's own `.git`
    trips the work-tree check too; a bare-clone case, which only the clone
    check refuses, was added and catches it. Two mutations were first
    written against unformatted text and were applied again to the
    formatted file.
  - **Merge prediction.** `git diff --name-only HEAD...origin/<branch>` over
    `script/vectorscope-eval/` and this log is empty for
    `origin/self-evolving` (`f062bcce`), `origin/codium` (`5a079cbd`),
    `origin/vector-at-mention` (`0b68e8f6`) and `origin/main` (`4299d743`),
    so it adds no conflict.
  - Nothing was sent to a model, no `gh` was spawned (tests inject the
    runner), no paid path ran, no workflow was dispatched, no dependency was
    added, and no user-visible string changed (D14).

- **Review findings, round one** (fifteen findings, three blocking; all
  fixed, none declined). Fixed before any commit, so the text above already
  describes the fixed code. Nothing under `packages/` changed in this round
  either, so `REVIEW_PIPELINE_SOURCES` stays `124e47864a16fea4`.
  1. (Blocking.) A revert merged from a branch was missed: the first-parent
     merge's message names no target. Fixed with `revertsOf` (decision (h)),
     used by both the revert labels and the fix skip, and `baseHistory`
     reads each merge's brought-in messages with the read-only log. Test: a
     fixture variant whose revert of #2 sits on a branch merged with
     `--no-ff` under "Merge pull request #5 from acme/revert-2-add-auth",
     PR #5 labelled bug and titled as no revert: #2 reads `revertedDays: 10`,
     `fixes: []`, no lines and no `laterFixed`. A unit test covers an
     in-branch revert, which reverts nothing on the base.
  2. (Blocking.) A stale clone read later PRs as clean. Both remedies were
     taken: `requireFetched` refuses, before any PR is read, a clone whose
     base branch lacks a listed PR's merge commit (any PR merged since
     `--since`, so the per-PR "merge commit not on the first-parent
     history" truncation is gone: no window PR can reach it), and maturity
     is measured to `observedUntil` (decision (i)), which also covers direct
     pushes made after the fetch, which no listing shows. The reachability
     check reads the full first-parent hash list, so a merge whose committer
     time is before `--since` is still found. The fixture gained a README
     edit five days ago so its history ends near collection. Tests: a
     listed fix merged after `--until` and a window PR, both off the base,
     refused after 2 GitHub calls; and a run 60 days after the history ends
     keeps #6 unmatured.
  3. Cycle time on every rate: implemented rather than reworded (decision
     (q)). Test: per-severity, human-presence, escape and later-fixed cycles
     over their own PRs, the gradient table's cycle column, and every
     bullet line carrying "cycle p50 / p90".
  4. A ghost login engaged and acknowledged. Fixed in `findingOutcome`
     (resolver, replies and reactions) and in the permission lookups.
     Tests: a unit case for each, and a ghost reply in the fixture that
     leaves its finding `open-at-merge` and unengaged.
  5. A merged fix PR whose branch name says "revert" was dropped. Fixed in
     `fixKind` (decision (h)); the merge-commit-without-a-PR case stays a
     listed undercount. Tests: the branch-name subject with the PR's title
     and label, and a squash commit's own subject still counting.
  6. `also` lines were ignored. Fixed (decision (j)); `Place` keeps the
     anchor and its `also` lines. Test: a summary finding at line 1 naming
     line 9, which #4 fixes, reads flagged and `laterFixed`.
  7. Malformed inputs threw. Fixed (decision (l)); each case is a CLI test
     with nothing written: invalid sealed JSON, a missing sealed file, a
     missing key file, another owner's key, a file that is no key, invalid
     ledger JSON, an entry with an unknown outcome and a ledger without
     `merged`.
  8. (Blocking.) Blame's C-quoted file names never matched. Fixed with
     `core.quotePath=false` and `unquotedPath` (decision (j)). Test: #3
     adds `src/café.ts` and `src/say "hi".ts` and #4 fixes a line next to a
     finding in each: both read flagged, and `laterFixed` is set. The
     mutation check shows the two defences overlap: with
     `core.quotePath=true` the café line still matches, because
     `unquotedPath` decodes git's octal quoting too; dropping the unquoting
     is caught. Both are kept, as the finding asked.
  9. Symbolic links past the output guards. Fixed with `realPath` (decision
     (m)). Tests: `--out` through a link into a work tree and into the
     clone, `--agent-prs` through a link into the clone, and `open` through
     a link into a work tree, each refused with nothing written.
  10. Default file modes. Fixed (decision (l)), the sealed file included.
      Test: 0700 directories and 0600 files after `collect`, `open` and
      `open --ledger`.
  11. A planted file name after `--` stopped a run. Fixed (decision (n)).
      Test: blame of files named `-o` and `--output=x` runs, and `-o`
      before `--` is still refused.
  12. A User account named like the App counted as the bot. Fixed
      (decision (g)); `sameLogin` and the bare sticky candidate are gone.
      Test: a User `vector-app` thread with a finding marker at the line #4
      fixes stays out of the findings and line counts, with
      `--bot vector-app` normalised in the CLI test.
  13. Unvalidated entries. Fixed with `LedgerEntries` (decision (l)). Test:
      thirteen malformed ledgers and a history ending after collection, all
      refused.
  14. The call cap depended on callers. Fixed (decision (o)): the client
      refuses past the cap with `CallCapReached`, and a PR that meets it
      while being read is truncated. Test: seven caps from 1 to 250, each
      run sending at most its cap, the 1-call run reporting the listing
      problem and the 205-call run reading only #1.
  15. `--agent-prs` JSON threw. Fixed (decision (l)): "--agent-prs is not
      valid JSON." and "names no readable file", both in the 0-call refusal
      test.
  - Re-run after the fixes, each file alone through the lock with
    `--timeout 30000` and the scratch roots under
    `/tmp/vector-vectorscope/vs46a-fix/`: `outcomes.test.ts` 40 (from
    `script/vectorscope-eval` and from `packages/script`), `ci.test.ts` 35.
    `bun tsgo -p ../../script/vectorscope-eval/tsconfig.json` from
    `packages/engine` and `bun typecheck` in `packages/script` pass.
    prettier `--check` is clean on `outcomes.ts`, `outcomes.test.ts` and the
    README; oxlint adds no new kind of warning (the casts it flags are the
    file's existing `as Sealed` and `as OutcomeLedger` after validation).
  - **Mutation check, round one.** Twenty-six mutations, each applied alone
    to `outcomes.ts`, its test file run through the lock, and the file
    restored (`cmp`): brought-in revert shas ignored; an in-branch revert
    counted; the fix skip on the commit's own message only; the merge rule
    in `fixKind` off; the stale-clone refusal off; maturity against `now`;
    `core.quotePath` on; no unquoting; `also` lines ignored; a ghost as a
    person, as an acknowledging reply, and looked up; the forbidden-option
    check past `--`; `--bot` not normalised; `[bot]` stripped before the
    comparison; the entry schema replaced by the old array check; a
    history ending after collection accepted; default modes for `open`'s
    directory, `--out` and files; lexical paths for `--out`, `open` and
    `--agent-prs`; the listing ignoring the cap; one gradient cycle for
    every severity; and the escape cycle over every reviewed PR. 25 were
    caught; `core.quotePath` on survived, for the reason in item 8.

## 2026-11-07 · VS-49a Slice-utilisation artifact fields (eval)

Addendum A §2, VS-49, in the Now window of §4 ("VS-49 (artifact fields)").
Built at `0a125a0b` on `vectorscope-engine`. Addendum A's packages are
proposals pending Q18, so this is the Now part only: the replay artifact's
`utilisation` field, its shape in core, the replay validation that checks a
record against the rest of its artifact, and the report reader that carries a
valid record onto the run. Nothing writes the field: the run observer and the
`explore` variant are the runner-wiring part (§4, "VS-49 (observer,
variant)"). No key, prompt text, registry entry, digest input or runner
changed. `run.ts`, `ai-review.ts`, `provider.ts`, `session/llm.ts`,
`posting.ts`, core `types.ts`, `config.ts`, `model-evidence.ts`,
`eval-report.ts`, `impact.ts`, `desktop.ts`, `certify.ts`, `ci.ts`, every
`REVIEW_PIPELINE_FILES` file, and the @vector-owned `workflow.ts`,
`command.ts`, `github.*`, `github-*.ts` and `vectorscope.astro` are
untouched. It implements the VS-49a plan as corrected by its critique: both
major points and every minor point were taken, one sub-point of point 5 in a
different form (decision (e)). Nothing is committed.

- **What landed.**
  - **Core `eval.ts`:** `UTILISATION_PLACES` (`diff`, `slice`, `read`) and
    `UtilisationPlace`; `SliceUtilisation` (`slice`, the slice's own
    `ImpactSlice.locations`, and `passes`) and `PassUtilisation` (`pass`,
    typed as `ReviewOutcome["specialists"][number]["name"]`, `lens?`,
    `tools`, `reads.inside` and `reads.outside`, `sliceGreps`, `findings`
    with `key`, `places` and `approximate`, and a lens's `received?` and
    `cited?`); `EvalRun.utilisation?`. The only runtime addition is the
    constant. The file imports `ReviewOutcome` as a type from `./types`.
  - **Engine `review/eval.ts`, types only:** `ReplayArtifact.utilisation?:
    SliceUtilisation` after `shrink`, with its comment. No runtime line
    changed, so every artifact is byte-identical.
  - **`replay.ts`:** `utilisationProblems(record: unknown)`, with private
    helpers `entryUtilisationProblems`, `placementProblems`,
    `passUseProblems`, `recordedToolUse`, `toolCounts`, `tally`,
    `countsText`, `byPass`, `passKey`, `keyedFinding`, `entryName`,
    `shown`, `checkoutPath`, `locationPath`, `isStrings`, `isList` and
    `listOf`. It reads the record as untrusted JSON through `field<T>`,
    never throws, returns `[]` when the artifact has no `utilisation`, and
    otherwise lists every problem, each starting "its slice utilisation"
    (or "its outcome's", for a proposed finding that has no key). Values
    the record supplies appear in a problem as `shown` spells them (JSON,
    cut to 200 characters), and are compared in full. What it checks:
    - each entry names a pass `outcome.specialists` ran, matched by `name`
      and `lens`; a `lens` pass has a non-empty lens and no other pass has
      one; no (pass, lens) appears twice;
    - `tools` are positive whole numbers by name. Summed over a pass's
      entries, they equal that pass's `artifact.tools` records by tool name,
      whatever their status, so a pass with recorded calls has an entry.
      Records without a pass belong to no pass;
    - `reads.inside` and `reads.outside` are string lists, each read once and
      never in both. Over a pass's entries they hold the `filePath` of every
      completed read-tool call it made, a lower bound;
    - `slice` lists distinct locations, each in `context.locations`, and is
      empty unless `tier1` is an object. An inside read is a path that a `slice`
      location names. A `slice` place, or `sliceGreps` above 0, needs a
      non-empty `slice`. `sliceGreps` is a whole number from 0 up to the
      entry's total tool calls;
    - every proposed finding (`outcome.report.findings`) has a
      `findingKey`, and by it appears in some entry. A key appears at most once per entry and must
      be a proposed one. Only `review`, `security` and `lens` entries place
      findings. Places are distinct and in `UTILISATION_PLACES` order. A
      `read` place needs a read, and `approximate: true` needs a proposed
      finding of that key with a non-empty legacy `evidence` list;
    - `received` and `cited` appear only on lens entries, as distinct
      strings. What a lens received is in `context.locations`, and it cites
      only when it places a finding.
  - **`report.ts`:** `loadOutputs` lists each engine artifact's
    `utilisationProblems` beside its variant and pair problems.
    `fromArtifact` carries `utilisation` onto the run only when the record
    has no problem. Otherwise the run is kept unchanged without it, and the
    listed problem keeps the report from a release decision (decision (f)).
    The `reselectRun` comment now says the copy carries no utilisation.
  - **Docs:** the `utilisation` bullet in the README's artifact list, and a
    sentence in its report section.
  - **Tests:**
    - `replay.test.ts`: 9 new tests in "slice utilisation records (VS-49)";
    - `report.test.ts`: 3 new tests in "slice utilisation (VS-49)";
    - engine `eval.test.ts`: 1 new test over the scripted fixture replay.

    No existing test changed. In engine `eval.test.ts`, an existing comment
    said `replay.ts` is something "engine tests do not import". It now reads
    "which this test does not call", because the file imports
    `utilisationProblems`, as `vectorscope-replay.test.ts` already imports
    `projectionProblems`.
- **Critique points.**
  1. **Inside the slice needs the slice's own list (major), taken.** The
     record carries `slice`, the `ImpactSlice.locations` it was measured
     against. `ImpactRecord` (`tier1`) leaves `locations` out, and
     `context.locations` puts the related-code call sites first, so neither
     can tell a slice read from a related-code read. `slice` must be a
     subset of `context.locations` and is empty without `tier1`. An inside
     path must be named by `slice`; a test reads a quoted related-code site
     as inside and is refused. A `slice` place and slice greps need a
     non-empty `slice`, so an abstaining slice (tier1 present, slice empty)
     allows neither. `tier1.tiers.shown` is no longer consulted: its ranges
     and `base:` definitions are not the location vocabulary.
  2. **The eval-report summary (major), taken.** Core `eval-report.ts` is
     untouched: there is no `Utilisation` type, `utilisationOf`,
     `renderUtilisation`, proportion or interval. Every choice the summary
     would make waits for VS-49 wiring and the D7 pilot to define the
     metric: proposed or matched findings, `gate.countNits`, the
     slice-present denominator, and `crossFile` as a case flag. A test shows
     that the same replay with and without a valid record gives
     byte-identical report JSON and text.
  3. **Path spelling, taken.** `checkoutPath` is `posix.normalize` after
     turning `\` into `/`, applied on both sides of the read-set comparison,
     to the duplicate check and to the inside-path lookup. A path that
     climbs out of the checkout keeps its leading `..`, and an absolute path
     stays absolute. Tests cover `./src/list.ts` on either side,
     `src\list.ts` and `src/slice/../slice/dep.ts`, and refuse the same file
     listed twice under two spellings. The observer may record paths as
     typed or normalised; both pass.
  4. **Lens and pass identity, taken.** Each (pass, lens) is matched against
     `outcome.specialists[].name` and `.lens`. A made-up lens or a `repro`
     entry is refused. `verify` (and `judge`, `repro`) may not place
     findings, and `received` must be in `context.locations`.
  5. **Observer rules the validator should not pin, taken (one sub-point in
     another form):**
     - `cited ⊆ received` is dropped; a test cites a location found by
       reading;
     - reads are a lower bound, not an equality, so reads through allowed
       `git show` bash calls can be added;
     - `sliceGreps` is bounded by the entry's total tool calls, not
       `tools.grep`, so bash greps can count;
     - `approximate` is checked one way only (decision (d)).

     The `/^.+:\d+$/` pattern is gone, but ranges in `received` are still
     refused, because `received` must be in `context.locations` (point 4),
     which holds `path:line` only. Accepting ranges would need
     `context.locations` to carry them, which is VS-25b and VS-37 wiring's
     call (decision (e)).
  6. **Untrusted tool names, taken.** Both sides count in a `Map` (`tally`).
     A test counts tools named `constructor` and `__proto__`, the latter an
     own key through `JSON.parse`, and a mutation that counts into a plain
     object is caught.
  7. **The engine test, taken.** It first asserts the replay's real tool
     records: review `read` (`src/list.ts`) and `StructuredOutput`,
     security `StructuredOutput`, verify `StructuredOutput`. It then names
     all three keys explicitly (`findingKey(listBug)`, `listFalse`,
     `authBug`) against the outcome's findings, and only then writes the
     record. Verify gets an entry with its one call and no findings.
  8. **Wording, taken.** The places are named `UTILISATION_PLACES`, not to
     be confused with `EVIDENCE_POLICY_KEYS`. `approximate` is defined per
     key over every proposed finding with that key, so `mergeReports`
     duplicates are covered and tested. The reselection is described as a
     choice: the copy is its own `+reselect-strict` group with the same
     proposed findings, and it carries no record because the record
     describes passes the copy did not run again. The engine test is called
     the scripted fixture replay. "Done when" is listed as unmet below.
- **Decisions.**
  - **(a) Now part only.** Deferred to wiring: the observer, the `explore`
    key, the nudge sentence and `engine:explore-slice`. No registry entry is
    added, as in VS-34a, VS-42a and VS-35a.
  - **(b) The shape lives in core `eval.ts`** (I-11: core cannot import the
    engine). `pass` is typed with core's own `ReviewOutcome` specialist
    name, which is the engine's `Pass`. The plan's engine-side `& { pass:
    Pass }` narrowing is therefore not needed, and both sides share one
    type.
  - **(c) Replay validation over `projectionProblems`.** The projection's
    canned model reads nothing, and `ProjectionRecord` has no tool records
    or outcome to check against. `ProjectionRecord.utilisation`, copied in
    `projectionOf` and checked by `projectionProblems`, waits for wiring.
  - **(d) Pinned now, because they follow from the artifact:**
    - every tool part counts, whatever its status;
    - completed read calls are a lower bound on reads;
    - every proposed finding is placed, by key, on a pass that proposes;
    - slice fields are empty without a slice, and a slice needs `tier1`;
    - an inside path is a path the record's own slice names;
    - `approximate` needs a finding of that key with legacy evidence
      strings, so a finding with no evidence at all is never approximate.

    **Left to the observer, provisional until it lands:**
    - the evidence-placement rule (diff lines, slice windows, how legacy
      strings are parsed);
    - whether a finding with both quotes and strings is approximate;
    - which greps name slice names;
    - which non-read-tool reads count;
    - line-range precision for inside reads (read offset and limit are
      already recorded);
    - whether a lens must record `received` and `cited`.
  - **(e) Locations stay `path:line`.** `slice`, `received` and the
    lookups use `context.locations`' vocabulary, so a record joins with the
    artifact and the labels offline. Range-precise utilisation, against
    VS-37's `tiers.shown`, would extend both `context.locations` and this
    check at wiring.
  - **(f) An invalid record is listed and left out of its run; the run is
    kept.** The field is measurement only, so status, findings, spend and
    the plan do not change, unlike a desktop variant that never reached its
    runner, which is left out entirely. Being listed, it keeps the report
    from a release decision, as every loading problem does (core
    `eval-report.ts` `ReportInput.problems`). That is fail-closed on purpose:
    a record that contradicts its own artifact's tool records or findings
    means the artifact was edited or the observer is wrong, and neither
    should carry a release. A test shows the release reason. Nothing writes
    the field today, so no report changes.
  - **(g) `PROPOSING` is `review`, `security`, `lens`.** codium's `judge`
    and VS-30's `repro` propose no findings today. If codium's judge
    proposes findings when it merges, the list changes with it.
  - **(h) No digest entry.** "Out of digests unless the variant is on" is
    for wiring: `explore` enters `policyDigest` only when non-default, and
    the nudge enters `promptsDigest` only under that key. Nothing enters
    `EVIDENCE_POLICY_KEYS` or `EvidenceScope` now.
  - **(i) `certify.ts` is unchanged.** It re-checks each candidate
    artifact's variant and pair, which decide what a certificate covers. It
    does not re-check `utilisation`, because a record never changes that
    coverage. A report that listed an invalid record is already not
    release-eligible (decision (f)), and `certify.ts` needs
    `release.eligible`.
  - **(j) Desktop: a documented difference** (§1a, `variant.applied:
    false`). `DesktopArtifact` has no `utilisation`, and `desktop.ts` and
    `fromDesktopArtifact` are unchanged.
- **§0.3 items.**
  1. Key: none in Now.
  2. Parity: no runner changed, and the 34 engine replay tests pass with
     the artifact unchanged.
  3. Evidence: no key and no pinned file. `REVIEW_PIPELINE_SOURCES` stays
     `124e47864a16fea4`, `REVIEW_PIPELINE_REVISION` stays 1, and
     `policyDigest(DEFAULT_REVIEW_CONFIG)` stays `70512122f41ec160`;
     `model-evidence.test.ts` passes unchanged.
  4. The variant is deferred.
  5. Desktop: a documented difference.
  6. This entry.
- **Owner questions: none decided.** Q18, Q13, Q3 and Q9 stay open, and
  every part reads the same under either answer: nothing writes the field,
  and nothing reads it beyond validation.
- **Deferred.**
  - **Runner-wiring:**
    - the observer in `ReviewEval.replay` step 8 (engine `eval.ts`, the tool
      recording at about 925-1000), built from session tool parts, the
      `ImpactSlice` (its `locations` as `slice`) and findings' evidence and
      quotes. It may hoist `recordedToolUse` and `checkoutPath` to core so
      that the observer and the validator share one rule;
    - lens `received` and `cited`, after VS-28 wiring;
    - `ProjectionRecord.utilisation`, copied in `projectionOf` and checked
      by `projectionProblems`;
    - the report summary from critique point 2, counted only over runs whose
      record shows a non-empty slice, respecting `gate.countNits`, with no
      proportion or interval until the D7 pilot defines the metric;
    - the `explore` key: its config parse, `EVIDENCE_POLICY_KEYS` and
      `UNAPPLIED_REVIEW_KEYS` entries, the nudge, the variant, D3 parity,
      and the digest-stability test with the variant off.
  - **Measured or later:**
    - both kill rules (the D7 pilot, VS-36's stages, Q3);
    - prompt tuning, after the held-out freeze (I-13);
    - the symbol-tool reconsideration.
  - **"Done when" is unmet:** no projection or pilot artifact carries the
    fields until the observer and `ProjectionRecord.utilisation` land.
  - **Not verified here:**
    - No real slice-built artifact exists, since `tier1` is absent until
      VS-25b wiring. The validator ran on synthetic artifacts and on the
      scripted fixture replay's real tool records and findings.
    - On Windows, beyond `\` separators: drive letters, case-insensitive
      paths, and absolute paths outside the checkout.
    - Nothing was sent to a model, no paid run started, no workflow was
      dispatched, and no dependency changed.
- **Evidence.** Each test file ran alone through the lock with `--timeout
  30000` and `GITHUB_ACTIONS=false`, with `TMPDIR` and the XDG roots under
  `/tmp/vector-vectorscope/vs49a/`. The changed eval tests ran from
  `script/vectorscope-eval` and again from `packages/script` (as `test.yml`
  runs them), with the same counts.

  | File | HEAD | After |
  | --- | --- | --- |
  | `replay.test.ts` | 38 | 47 |
  | `report.test.ts` | 38 | 41 |
  | `certify.test.ts`, `ci.test.ts` | 7, 35 | 7, 35 |
  | `judge.test.ts` (not run at HEAD; `judge.ts` reads outputs through `report.ts`) | - | 8 |
  | engine `test/review/eval.test.ts` | 33 | 34 |
  | engine `test/review/vectorscope-replay.test.ts` | 18 | 18 |
  | core `eval.test.ts`, `eval-report.test.ts` | 55, 28 | 55, 28 |
  | core `model-evidence.test.ts` (pin unchanged) | 30 | 30 |

  All pass.
  - **Typecheck.** `bun typecheck` passes in `packages/core`,
    `packages/engine` and `packages/script`, and `bun tsgo -p
    ../../script/vectorscope-eval/tsconfig.json` passes from
    `packages/engine`. The full root typecheck was not run, because nothing
    is pushed.
  - **Format and lint.** prettier `--check` passes on the seven code files
    and the README. oxlint reports 0 errors and 62 warnings on the seven
    files. Only one warning falls on a line this package touched: the
    existing `(entry.value as ReplayArtifact).variant` cast in `loadOutputs`,
    which the formatter moved into the new list. This log is append-only
    and, like its earlier entries, is not run through prettier.
  - **Mutation check.** Nineteen mutations, each applied alone, its test
    file run through the lock, and the file restored and compared with
    `cmp`. All were caught:
    - in `replay.ts`, against `replay.test.ts`:
      - the tool-count compare dropped;
      - errored reads counted;
      - the read-set compare dropped;
      - the tier1 requirement for a slice dropped;
      - the inside-path slice check dropped;
      - the slice-grep and slice-place needs-a-slice rules each dropped;
      - the slice-in-context check dropped;
      - the approximate rule dropped;
      - the every-proposed-finding rule dropped;
      - findings allowed on verify;
      - the (pass, lens) match dropped;
      - an unquoted received location accepted;
      - tools counted as an object's keys;
      - raw recorded paths compared;
    - in `report.ts`, against `report.test.ts`:
      - `fromArtifact` keeping an invalid record;
      - `loadOutputs` leaving the record's problems out;
      - `reselectRun` copying `utilisation`;
    - in engine `eval.ts`, against the engine VS-49 test: the replay
      writing a record.
  - **Merge prediction.** From each merge base, no touched file (the seven
    code files, the README and this log) changes on `origin/codium`
    (`5a079cbd`), `origin/self-evolving` (`f062bcce`),
    `origin/vector-at-mention` (`0b68e8f6`) or `origin/main` (`4299d743`).
    `git merge-tree --write-tree --name-only HEAD <branch>` lists no
    touched file for any of them. `vector-at-mention` merges clean, and the
    conflicts it reports for `codium` and `self-evolving` already exist at
    HEAD.
- **Review findings, round one** (six findings, none blocking; all fixed,
  none declined). They were fixed before any commit, so the text above
  describes the fixed code. Nothing under `packages/` changed in this round
  apart from three expected messages in the engine test, so
  `REVIEW_PIPELINE_SOURCES` stays `124e47864a16fea4`.
  1. The release check did not prove that the record blocks the release.
     The test filtered the problems to its directory, and the invalid
     record's case label, `unborne`, added two plan problems of its own
     ("reviews unborne, which no case labels" and "is not in the plan").
     Either of those also produces the "problem(s) are listed" reason. The
     invalid record is now the labelled case's second repetition, which the
     plan allows, so `loaded.problems` and the saved report's `problems`
     are exactly the two utilisation problems. The plain directory's saved
     report lists no problem, and its release reasons lack "problem(s) are
     listed". Both remedies the finding offered were taken.
  2. `Array.isArray` narrowed `unknown` to `any[]`. A new `isList` guard
     narrows to `unknown[]`. `listOf` uses it, the `passes` shape check
     uses it, and the outcome's specialists and findings and the
     artifact's tool records are read through `listOf`. The `isList`
     guard does the job of the finding's suggested `listOf(entries)`
     without a second variable for the same list.
  3. `tier1: null` counted as a slice. A slice now needs `tier1` to be a
     non-null, non-list object. The slice test refuses `undefined`,
     `null`, `[]`, `"x"` and `1`.
  4. A proposed finding that has no key was skipped silently. While a
     record is present, `keyedFinding` returns `undefined` for such a
     finding (no string path and title, no numeric line, or a non-numeric
     endLine), and each one is listed as "its outcome's proposed finding N
     has no path, title and line (or a non-numeric endLine) to key it by,
     so its slice utilisation cannot place it". The finding wrote one
     generic message; this one names the finding's position. Tests: an
     outcome with a string `endLine` and a finding with no path, and the
     hand-edited outcome's two findings.
  5. Quadratic checks. Every check is now linear apart from sorting tool
     names for display:
     - repeated entries are found with `Map.groupBy` over `passKey` (pass
       and lens as JSON);
     - repeated placements with `tally`;
     - `context.proposed` is a Map from each key to whether any finding of
       that key has legacy strings;
     - the outcome's specialists are a Set of `passKey`;
     - entries and tool records are grouped by pass once (`byPass`), so
       `passUseProblems` and `recordedToolUse` no longer filter per pass.

     On a synthetic artifact with n entries, n tool records and n findings
     (scratch script, one run each), the check took:

     | n | before | after |
     | --- | --- | --- |
     | 2,000 | 1,779 ms | 66 ms |
     | 8,000 | 27,796 ms | 171 ms |
     | 32,000 | - | 709 ms |

     `Map.groupBy` replaced a `reduce` into a Map, which needed explicit
     type arguments that oxlint flags as unnecessary.
  6. Raw record strings in problem text. A new `shown` helper prints them:
     `JSON.stringify`, cut to 200 characters with "...", and `String()`
     only for what JSON cannot spell. It covers slice and received
     locations, inside and missing read paths, placement keys and places,
     pass and lens names, tool names and the slice-grep value. Entries are
     now named `entry "review"` or `entry "lens" ("auth")`. Per-pass
     messages read "the tool calls of pass "review"", and the unplaced
     keys are quoted too. Values are still compared in full. The tool
     counts are compared as Maps, not as their shown text, and repeated
     entries by `passKey`, not by shown name, so two values cut to the same
     text stay two. A test covers a forged newline, a 500-character
     location, two 301-character pass names, and two tool names that
     differ after the cut.
     - The same change fixes a fail-open the finding did not name. A
       hand-edited value with an own `toString` that is not a function made
       `String()` throw: as a recorded tool name, as an entry's pass in the
       proposing check, or as `sliceGreps` in a problem. That broke "listed,
       never thrown on" and would have stopped `report.ts` loading. These
       values now go through `typeof` checks or `shown`, and a test covers
       all three.
     - Not fixed, because it is outside VS-49a: `passProblems` in the same
       file (`projectionProblems`, from an earlier package) still calls
       `String()` on a projection's pass, status and counts, and prints
       them unquoted.
  - Re-run after the fixes, each file alone through the lock with
    `--timeout 30000`, `GITHUB_ACTIONS=false`, and `TMPDIR` and the XDG
    roots under `/tmp/vector-vectorscope/vs49a-fix/`:
    - from `script/vectorscope-eval`: `replay.test.ts` 47,
      `report.test.ts` 41, `judge.test.ts` 8, `certify.test.ts` 7,
      `ci.test.ts` 35;
    - from `packages/script`: `replay.test.ts` 47 and `report.test.ts` 41;
    - engine: `test/review/eval.test.ts` 34 and
      `test/review/vectorscope-replay.test.ts` 18.

    All pass. `bun typecheck` passes in `packages/engine` and
    `packages/script`, and `bun tsgo -p
    ../../script/vectorscope-eval/tsconfig.json` passes from
    `packages/engine`. prettier `--check` is clean on the four changed code
    files. oxlint shows no warning in the utilisation block of `replay.ts`;
    the file's 12 warnings are the existing casts and the `field<T>` type
    parameter.
  - **Mutation check, round one.** Twenty-one mutations, each applied alone,
    its test file run through the lock, and the file restored and compared
    with `cmp`. All were caught.
    - New rules, against `replay.test.ts`:
      - tier1 checked only for `undefined`;
      - keyless proposed findings not listed;
      - record strings shown raw;
      - shown values not cut;
      - tool counts compared as shown text;
      - repeated entries keyed by shown name;
      - repeated entries not listed;
      - entries without a pass grouped as one pass;
      - `String()` for a recorded tool name, the proposing check and the
        slice-grep value, one mutation each.
    - Earlier rules, rechecked after the rewrite:
      - the (pass, lens) match dropped;
      - the every-proposed-finding rule dropped;
      - the approximate rule dropped;
      - findings allowed on verify;
      - the tool-count compare dropped;
      - an unproposed placement accepted;
      - a repeated placement accepted;
      - recorded tools ignored;
      - the first legacy flag of a key winning over a later one.
    - Against `report.test.ts`: `loadOutputs` leaving the record's problems
      out.
