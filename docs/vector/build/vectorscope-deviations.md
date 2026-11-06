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
