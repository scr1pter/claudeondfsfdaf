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
