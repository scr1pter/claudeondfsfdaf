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
