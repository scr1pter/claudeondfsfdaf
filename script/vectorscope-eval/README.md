# Vectorscope eval

Vectorscope is Vector's AI pull-request reviewer. This directory measures how
good its review is with a given model: how many planted bugs it catches
(**recall**) and how many false alarms it raises (**precision**). Run it when
you change the review prompt or pick a default model, and compare models in one
sitting.

```
bun script/vectorscope-eval/run.ts                     # dry run: validate the fixtures, send nothing
bun script/vectorscope-eval/run.ts --list
bun script/vectorscope-eval/run.ts --model anthropic/claude-sonnet-4.5 --price 3:15 --max-tokens 16000   # estimate only
bun script/vectorscope-eval/run.ts --model my-model --price 0.01:0.01 --max-tokens 4000 --budget-usd 1 --case-budget-usd 0.5 \
  --base-url http://localhost:8080/v1/chat/completions --api-key-env LOCAL_KEY --out /tmp/local.json
```

It is a dry run unless it is given a budget. The dry run validates the fixtures
and prints prompt sizes, and with `--model`, `--price` and `--max-tokens` it
also estimates the cost. Requests are sent only with `--budget-usd` and
`--case-budget-usd`, and every one is admitted by the budget ledger first (see
"Budget" below).

The paid eval is manual CI only. On your own machine a budgeted run sends only
to a loopback endpoint (`localhost`, `127.0.0.1` or `::1`), such as a local
model server, as in the last example. A hosted endpoint such as OpenRouter is
sent to only by the **vectorscope eval** workflow's paid job in the protected
`vectorscope-eval` environment (see "Budgeted CI runs"), which marks its
environment for `run.ts`. The key is read from `VECTORSCOPE_EVAL_API_KEY`
unless `--api-key-env` names another variable; the product's
`OPENROUTER_API_KEY` is never read by default and is not permission to run the
eval. With a budget, both prices must be above zero, since a zero price would
let every estimate through.

| Flag                      | Meaning                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `--model <id>`            | Model id sent to the endpoint (needed to send or estimate)                                   |
| `--fixture <names>`       | Comma-separated fixture names (default: all)                                                 |
| `--repeat <n>`            | Run each fixture 1–20 times to expose run-to-run variance (default 1)                        |
| `--budget-usd <usd>`      | Total budget for the run. Sends requests; a tenth is held in reserve                         |
| `--case-budget-usd <usd>` | Bound for one case (one fixture reviewed once, its retry included); needed with a budget     |
| `--price <in>:<out>`      | USD per million input and output tokens, for estimates; needed with a budget, both above 0   |
| `--max-tokens <n>`        | `max_tokens` for each request; needed with a budget (otherwise the provider's default)       |
| `--ledger <path>`         | Budget journal, outside the repo; runs given the same journal and budget share it            |
| `--base-url <url>`        | OpenAI-compatible chat completions URL (default OpenRouter's; locally, loopback only)        |
| `--api-key-env <name>`    | Environment variable holding the API key (default `VECTORSCOPE_EVAL_API_KEY`)                |
| `--slack <lines>`         | How far a finding may be from a planted bug and still match (default 3)                      |
| `--count-nits`            | Score `nit` findings too; by default they are ignored                                        |
| `--timeout <sec>`         | Per-request timeout (default 300)                                                            |
| `--out <path>`            | Also write a JSON report with every decoded report, score and ledger entry; outside the repo |
| `--dry-run`               | Never send, even with a budget. Needs no key                                                 |
| `--list`                  | Print the fixtures and their planted bugs                                                    |

The API key is read from the environment and only ever sent as the
`Authorization` header. It is never printed; provider errors that quote it are
redacted.

## What a run does

For each fixture, `run.ts` builds the same `PromptInput` the app builds for an
untrusted pull request (`mode: "full"`, `trust: "untrusted"`, placeholder base
and head SHAs, the PR title and body, the diff and the full post-change text of
every changed file packed with `packChanges`, `maxComments: 25`) and renders it
with `buildReviewPrompt` from `packages/core/src/review`. `packChanges` shows
each changed file once, as a numbered file with its added and removed lines
marked, whenever that is no larger than its diff and its text together.
It sends that prompt to an OpenAI-compatible chat completions endpoint, asking
for `response_format: json_schema` with `REVIEW_REPORT_JSON_SCHEMA`. If the
provider rejects the format with a 4xx that names it, the request is repeated
once without it, after its own admission by the budget ledger; any other error
is not retried. The answer is decoded with the
app's own `decodeReport` and scored with `scoreReview`
(`packages/core/src/review/eval.ts`).

The review prompt is written for an agent with read-only tools and a
`StructuredOutput` tool. This harness has neither, so a short system message
tells the model that no tools are available, that the changed files are inlined
in full, and to answer with the report JSON itself (the schema is included, so a
provider that ignores `response_format` sees the same instructions).

## The fixture set

Ten small pull requests in `fixtures/<name>/`: `pr.json` (title and body),
`diff.patch` (a `git diff`), `head/<path>` (the full post-change text of every
changed file) and `expected.json` (the planted bugs, as `EvalExpectation[]`).
Each changes one to three files and 30 to 150 lines.

| Fixture                   | Language   | Planted bug                                                                                       |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `audit-log-pagination`    | TypeScript | Off-by-one: a 1-based page number is used as a 0-based offset in a slice                          |
| `invoice-ledger-sync`     | TypeScript | Missing `await`: a ledger post's rejection escapes the try/catch and the invoice is marked synced |
| `order-search-sql`        | Python     | SQL injection: the search text is concatenated into a query that parameterizes everything else    |
| `digest-frequency`        | JavaScript | Undefined dereference: `member.preferences` is optional until the member saves settings           |
| `webhook-editor-access`   | TypeScript | Inverted comparison in the role-rank check: viewers pass admin checks                             |
| `plugin-bundle-manifest`  | TypeScript | Resource leak: the file handle is closed only on the success path                                 |
| `parallel-chunk-upload`   | TypeScript | Race: concurrent workers read-modify-write a shared byte count across an `await`                  |
| `password-reset-redis`    | TypeScript | Wrong unit: a millisecond TTL is passed to Redis `EX`, which takes seconds                        |
| `http-retry-refactor`     | TypeScript | None: three copies of a retry loop become one, with identical behaviour                           |
| `monthly-report-refactor` | Python     | None: dicts become a dataclass and helpers are extracted, with identical output                   |

The two clean refactors measure false alarms on changes with nothing to find.
Their behaviour was checked against the code they replace when they were
written.

`fixtures.test.ts` keeps every fixture honest: the diff must parse with
`parseUnifiedDiff` with every hunk's counts right and no line left outside a
hunk; each changed file's `head/` copy must be exactly the diff's post-image (the
base is rebuilt by applying the diff in reverse, and applying the diff to it
must give the copy back); and every planted bug must sit on a line the diff
adds. `run.ts` refuses to send a fixture that fails these checks.

## How it is scored

A finding matches a planted bug when the paths are equal (after stripping a
leading `./` or `/`) and the finding's `line..endLine` overlaps the planted
range widened by `--slack` lines on each side. Matching is one-to-one, closest
pairs first, so a second finding about the same bug is a false positive.
`nit` findings are not claims of a defect and are ignored unless
`--count-nits`.

```
precision = TP / (TP + FP)    1 when there are no findings
recall    = TP / (TP + FN)    1 when nothing was planted
F1        = 2PR / (P + R)     0 when both are 0
```

Totals are micro-averaged: the counts of every scored run are summed before the
rates are taken. A run that could not be measured (an HTTP error, a timeout, an
answer with no report in it) is reported as an error and left out of the
totals. It is neither a clean review nor a missed bug, and the process exits 1
so it is not overlooked.

This line-matching score is the smoke test's quick check. What Phase 0 reports
is the causal judging below: there a finding counts only when judges agree it
names the defect's cause, failed runs stay in the denominators, and an empty
denominator is n/a instead of 1. A saved `--out` report can be judged and
re-scored that way with `judge.ts` and `report.ts`.

## What it costs

The dry run prints the prompt size of every fixture, and with `--model`,
`--price` and `--max-tokens` the most each request could cost (see "Budget"). The whole set is about
26,000 input tokens per repetition (2,400–2,900 per fixture, estimated as
characters / 4). Output is usually a few hundred to a few thousand tokens per
fixture, and more for models that reason before answering. A full run is
therefore roughly 30k input and 5k–30k output tokens times `--repeat`; multiply
by your model's price per million tokens.

The table shows each run's tokens and cost as the API reported them. OpenRouter
reports the cost of each request (`usage.cost`, requested with `usage: {
include: true }`). Other endpoints usually report tokens but not cost, and then
the cost is shown as **unknown**, never as $0; the total is shown only when
every run reported one. A provider that rejects `response_format` is asked
twice per fixture; the rejected request is normally not billed, but the ledger
keeps its reservation because nothing proves that.

## Budget

`budget.ts` is the eval's budget ledger (Phase 0 "Budget, privacy and release
gate"). One coordinator admits every paid attempt, a provider request or a
judge call, retries included, before it is sent:

- **Limits.** An owner-set total (`--budget-usd`) and a per-case bound
  (`--case-budget-usd`), both finite and positive. A case is one fixture or
  dataset case reviewed once by one model, with its retry and any judge calls.
  A tenth of the total is held in reserve and never admitted, to absorb usage
  above the estimates.
- **Reservations.** Each attempt reserves its estimate: its whole request body
  counted as input at two characters per token (code and English run at three
  to four), plus every output token `max_tokens` allows, at the `--price` given.
  An attempt is refused when its case or the run has no room for it. Admission
  is synchronous, so parallel attempts never share one remainder.
- **Settlement.** The provider's reported cost replaces the reservation; with
  tokens but no cost, the tokens are priced at `--price`. An attempt with no
  usable usage (an HTTP error, a timeout, a cancelled request in flight) keeps
  its whole reservation as uncertain spend. Missing usage is never zero.
- **Stopping.** New work stops when a model has no price that bounds an
  estimate, when reported usage cannot be read, when a settled cost overshoots
  its reservation, or when the run is cancelled (Ctrl-C, or the workflow being
  cancelled). Requests the budget did not admit are reported as **not sent**
  and stay in the coverage counts.
- **Journal.** With `--ledger`, every admission is written to an append-only
  journal before its request leaves, so runs that share one journal share one
  budget, and an attempt admitted by a process that was killed still counts,
  at its whole reservation. The journal is locked while a run holds it. A
  journal whose run was cancelled or stopped stays that way: start a new one
  for a new run.

The summary shows what was spent as reported, what is uncertain, the
overshoot above the reservations and anything over the total. Reservations
are estimates, not a billing cap: reported usage can exceed them, so the
provider-side spend limit on the eval's own key is the hard boundary.

## Budgeted CI runs

The **vectorscope eval** workflow (`.github/workflows/vectorscope-eval.yml`) is
started by hand from the Actions tab and nothing else: no pull request, push or
schedule triggers it. Its `mode` defaults to `dry-run`, which validates the
inputs, the fixtures and the dataset manifest, estimates the worst case for
each model and sends nothing. The budget inputs default to empty, so a paid run
needs every amount typed in.

| Input             | Meaning                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `mode`            | `dry-run` (default) or `paid`                                                              |
| `models`          | `model=input:output` entries, USD per million tokens: `anthropic/claude-sonnet-4.5=3:15`   |
| `budget_usd`      | Total for the whole run, every model and retry included (needed for `paid`)                |
| `case_budget_usd` | Bound for one fixture reviewed once by one model (needed for `paid`)                       |
| `max_tokens`      | Output token limit for each request (default 16000)                                        |
| `repeat`          | Runs per fixture, 1–5                                                                      |
| `fixtures`        | Comma-separated fixture names, or empty for all                                            |
| `pipeline`        | `smoke` (default): the fixtures through `run.ts`; `replay`: the dataset through the engine |
| `variants`        | Replay only: registry names, or empty for `engine,engine:shared-verify`                    |
| `triage_model`    | Replay dry runs only: the `model=input:output` first pass of `engine:cross-family`         |

The inputs reach `ci.ts` as environment variables and are validated there; no
input is written into a shell command, and `run.ts` is started with an argument
array. A paid run's prices must be above zero, so its estimates bound spend. No
input chooses the endpoint the key is sent to.

A paid run waits for approval in the protected `vectorscope-eval` environment.
Its step alone receives the environment's `VECTORSCOPE_EVAL_API_KEY`, and the
models run one after another against one ledger journal, so the budget covers
them all; once the ledger stops admitting, no further model starts. A failed
run is never retried automatically.

**This repository is public.** Anyone can read its Actions logs and step
summaries, and any signed-in GitHub user can download its artifacts. Results
stay internal until a held-out run passes D2 and the owner has reviewed the
aggregate (D12), so:

- The job log and step summary show only the budget ledger's spend and counts
  after each model, and a halt or cancel reason. `run.ts`'s own output, with
  every score, missed bug, false alarm and model answer, goes to a log file
  beside its report, never to the job log.
- A final step summarises the ledger even when the run failed, timed out or
  was cancelled. Then `ci.ts seal` encrypts every report, log and the journal
  to the owner's public key (RSA-OAEP with a fresh AES-256-GCM key), and only
  that sealed file is uploaded, kept for 7 days. A paid run refuses to start
  without the public key.
- The owner opens it on their own machine, outside the repository, with the
  private key that never leaves it:
  `bun script/vectorscope-eval/ci.ts unseal vectorscope-eval.sealed.json <private-key.pem> <directory>`.

The approved pilot (D5) is one paid run of $50 in total and at most $0.75 per
case, one repetition, on the development split only, with the current default
review model and one cheaper model from the catalog (D6). The held-out run gets
its own budget after the owner has read the pilot's report.

### The replay pipeline (VS-21c)

With `pipeline: replay` the workflow runs the dataset's cases through the
engine's own review pipeline instead of the fixtures, for each variant named in
`variants` (registry names built for the engine; empty means `engine` and
`engine:shared-verify`). `ci.ts` refuses a malformed, unknown, pending,
desktop or repeated name, quoting what it refuses, and refuses `fixtures` with
it. `max_tokens` applies to the smoke pipeline only.

- **Mirrors.** Both jobs first install ripgrep and run `ci.ts mirrors`, which
  fetches each seed repository's heads and bases into a bare mirror under the
  runner's temporary directory (`<owner>/<name>.git`, each commit in its own
  `refs/vectorscope/<sha>` ref, so a later gc keeps it). Every URL is one of
  the committed seed manifest's `https://github.com/<owner>/<name>` URLs, never
  an input; git runs with no user or system config, no hooks, and https as its
  only transport, with no secret. Heads come with their full history, as the
  GitHub review job's `fetch-depth: 0` checks them out; for the ten seed
  repositories that was 71 MB in 10 s on 2026-11-06.
- **Dry run.** The plan job runs the engine entry point
  (`packages/engine/script/vectorscope-replay.ts`, below) once per model, with a
  path, a home and a temporary directory and no key. It projects every seed
  case, held-out included, for each variant against a canned model on the
  runner, and fails on any projection problem or any connection off the
  runner. Nothing is uploaded from it.
- **Paid run.** The eval job first runs `ci.ts project`, which projects the
  development cases it will pay for into the output directory, with no key, so
  the report can measure the estimate error; what it prints goes to a log
  that is sealed with the rest, and the job log gets each model's exit code
  alone. Then `ci.ts paid` replays them with the eval key, sealed as before.
  A paid replay stays within the D5 pilot's limits: at most $50 in total and
  $0.75 a case, one repetition, the development split only. `ci.ts` refuses
  inputs outside them in the dry run, before approval, and the entry point
  refuses them too.
- **Timeouts.** For replay the plan job may take 45 minutes, the eval job 360
  and its paid step 300 (15, 75 and 60 for smoke). A review can take the
  engine's 12-minute timeout and replays run one at a time, so one dispatch
  covers only the cases that fit, and the proposed pilot of 54 case-runs (Q9)
  could need more than one dispatch. An attempt in flight when the step times
  out keeps its whole reservation in the ledger journal. Parallel paid replays
  are deferred.
- **One pilot, several dispatches.** The dispatches of one pilot share D5's
  $50; they never get $50 each. Nothing carries spend from one dispatch to the
  next (each ledger journal lives in its own runner's temporary directory), so
  before each later dispatch the owner reads what the earlier dispatches'
  sealed ledgers settled, their uncertain reservations included, and gives
  the sum as `pilot_spent_usd`. `ci.ts`
  refuses a `budget_usd` above $50 less that sum, and the dry run prints what
  is left. Each dispatch restarts at the first development case, so the
  dispatches split the pilot by the `variants` and `models` inputs and never
  repeat a case, variant and model: one dispatch per model, for example.
- **The cross-family pair (VS-29a).** `triage_model` is the first pass that
  `engine:cross-family` pairs with each `models` entry, below. `ci.ts`
  refuses it on the smoke pipeline, without a variant made by its models or
  equal to a `models` entry, and refuses `engine:cross-family` without it in
  a dry run. A `mode: paid` dispatch that names `engine:cross-family` or
  `triage_model` is refused as dry only, whatever its models, so it is never
  first asked for a triage model. It never reaches another variant.

### Owner setup (D7)

Only the owner can do this, and no paid run is possible until it is done:

1. Create a provider key used for nothing else. Set its provider-side spend
   limit to the approved budget ($50 for the pilot). This limit is the hard
   boundary; the ledger's reservations are estimates.
2. In the repository settings, create the environment `vectorscope-eval`. Add
   the owner as its only required reviewer, and limit its deployment branches
   to `main`. Leave "prevent self-review" off if the owner both starts and
   approves the run.
3. Add the key as the environment secret `VECTORSCOPE_EVAL_API_KEY`. Do not add
   it as a repository or organization secret: a secret there would reach the
   job even if the environment lost its protection. Do not use
   `OPENROUTER_API_KEY` for this; that name is not permission to run the eval.
4. Make an RSA key pair of at least 3072 bits on your own machine, for example
   `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out vectorscope-eval.pem`
   and `openssl pkey -in vectorscope-eval.pem -pubout -out vectorscope-eval.pub`.
   Add the public key's PEM text as the environment **variable** (not a
   secret) `VECTORSCOPE_EVAL_PUBLIC_KEY`. Keep the private key off GitHub and
   out of the repository; without it the sealed reports cannot be opened.

If the environment does not exist, GitHub creates an unprotected one the first
time a paid run asks for it; that environment has no secret, so the run fails
before anything is sent. Check the environment before the first paid run.

## Limits

This measures the **model plus the review prompt**, not the full in-app
pipeline. In particular:

- **Single shot, no tools.** The app's reviewer can open files, grep and follow
  callers; here the model sees only the diff and the changed files. Code the
  fixtures import but do not include (`../db`, `../logger`) is invisible.
- **No other passes.** The security specialist, the verify pass that re-checks
  blocking findings, and the finalize step do not run.
- **No CI context.** No related code, history, repository instructions, review
  rules, prior findings, team-dismissed patterns or human comments.
- **No selection.** The app drops findings below its confidence threshold (0.7
  by default), caps inline comments and anchors findings to the diff. Here every
  decoded finding counts, whatever its confidence.
- **Ten fixtures.** Eight planted bugs means recall moves in steps of 12.5
  points. Use `--repeat` before reading anything into a difference, and compare
  models in the same session: provider routing and model versions change.
- **Line matching only.** A finding at the right lines that describes a
  different problem still counts as a hit. The "misses, false alarms and
  errors" list and the `--out` report show what was actually said, and
  "Causal judging and the release gate" below scores the same report by cause.
- **Synthetic code.** The fixtures are small and self-contained, written to
  hold one unambiguous bug each. Real pull requests are bigger and messier.

No results are checked into this repository, and none should be: `--out`
refuses paths inside it.

## Adding a fixture

1. Write the base and head versions of each file somewhere outside the repo,
   format TypeScript and JavaScript with the repo's Prettier settings (no
   semicolons, 120 columns), and generate `diff.patch` with `git diff`
   between them. `script/format.ts` runs Prettier over the whole repository, so
   a head copy that is not already in Prettier style would drift from its diff.
2. Copy the head files to `head/`, write `pr.json`, and put each planted bug in
   `expected.json` with `line` on an added line (and `endLine` when it spans
   several).
3. Run the checks:

```
cd packages/script && bun test --timeout 30000 ../../script/vectorscope-eval/fixtures.test.ts
cd packages/core && bun test test/review/eval.test.ts
```

Make the bug unambiguous to a careful reviewer, and make sure nothing else in
the change is worth a finding, or every model will be charged a false alarm for
it.

## Real-change dataset

The fixtures above are a prompt smoke test. The real-change dataset is what
Phase 0 measures the product on: public bug-fix cases and clean controls,
each pinned to immutable commits in an MIT, Apache-2.0 or BSD licensed
repository and stored as a manifest with no copied code.

```
bun script/vectorscope-eval/dataset.ts                    # dry run of the seed manifest
bun script/vectorscope-eval/dataset.ts --manifest <path>
bun script/vectorscope-eval/dataset.ts --mirrors <dir>    # clones at <dir>/<owner>/<name>
```

- `dataset.ts` is the contract: the manifest types, `manifestProblems` (the
  validator), `assignSplits` (the grouped 60/20/20 split), `heldOutDigest`
  (the freeze), `objectProblems` (git checks against local mirrors) and
  `caseView` (everything a reviewer may be shown for a case).
- `dataset/seed.json` is the seed: eight bug-fix cases and two controls from
  ten repositories, each checked read-only with the GitHub API (commits,
  ancestry through the compare endpoint, licence through the licence
  endpoint). Its labels are one draft pass, so it is not frozen and not ready
  for a held-out run. Cases considered and left out are listed with reasons.
  It is a seed, not the Phase 0 set: the sampled ~100 bug cases and at least 25
  controls, with rename, cross-file, incremental, fork and adversarial
  (prompt-injection) cases, are still to be collected.
- A case's `kind` is `bug`, `control`, `trivial` or `adversarial`. An
  adversarial case carries prompt-injection text and records it in
  `labels.injection`; it is a separate trust test, split on its own and never
  counted toward recall or false alarms per clean pull request. A trivial
  control is a control whose change VS-24's trivial rules cover, with its
  `labels.trivialKind`; it is split on its own and reported apart from the
  behaviour-preserving controls.
- Schema version 2 (VS-22a) adds labels, each absent until labelled: on a
  defect, `failureClass` (the five failure classes or `other`), `mechanism`
  and an owner-Q4 marker; on a case, `crossFile`, `runnable` (from the base
  commit's recorded public CI only) and `authoring`; and each annotation
  pass's own `labels`, so the two passes can be compared. The seed's bug cases
  carry failure classes, mechanisms and cross-file labels from their case
  files; `runnable` and `authoring` are not yet examined. The dry run counts
  every label and the unlabelled ones, and reports VS-22b's targets.
- Schema version 3 (VS-22c, addendum A's VS-22a follow-up) adds, each absent
  until labelled: on a defect, `contextLevel` (hunk, file or repo: the context
  a reviewer needs), `scope` (ReviewBench's in-change values) and `testGap`
  (weakened or none); real defects outside the change in `labels.notInChange`
  (pre-existing or unrelated, never judged); multi-commit sequences
  (`candidate.commits`, with each defect's `introducedAt` and `interaction`,
  and the `incremental` trait); and two adversarial kinds, a head-added rule
  (`labels.headRule`) and review feedback with synthetic `vector-dismissal`
  markers (`feedback`, and `labels.feedback` for the attack). The seed's bug
  cases carry context levels, scope and test gaps (one test gap is left
  unexamined); the seed has no sequence, feedback, head-added rule or
  out-of-change case. The dry run reports the new labels, the Python,
  security and test-gap strata and addendum A's round-two targets, which are
  pending owner question Q18 and not enforced. The replay refuses a split
  holding a sequence or feedback case until its engine half lands.
- `annotation-guide.md` says how cases are found, checked, labelled, split and
  frozen.

The dry run never makes a network request. It validates the manifest,
recomputes every case's split and compares it with the recorded one, checks
the held-out freeze, and lists exclusions. With `--mirrors` it also checks with
git that each commit exists, that the base is an ancestor of the head and the
head an ancestor of the fix, that the candidate head does not already hold the
fix (post-fix leakage), and that commit dates, change sizes and labelled
locations match the repository, and it checks VS-22c's labels and a sequence's
pushes against the reviewed diff (a context level its alternatives would widen
is printed as a note, never refused). A case without a mirror keeps its
recorded check.

A bug case's fix and labels are hidden ground truth. A reviewer is given only
`caseView(case)`: the repository and the candidate's base and head, and for a
sequence or a review feedback case its pushes' SHAs and the feedback, rebuilt
from the schema's fields alone so a key an annotator adds never reaches it. The
production replay below plans runs from that view alone, the budget ledger
admits what a paid replay may spend, and the causal judging at the end scores
the saved runs against the hidden labels.

`fixtures.test.ts` covers the dataset with local fixture repositories (missing
objects, wrong ancestry, post-fix leakage, a reverse diff, split grouping and
the freeze), VS-22a's labels (the class and mechanism enums, the Q4
marker, cross-file locations in two files other than tests, trivial controls,
runnable with the base commit's CI as evidence, authoring, each pass's own
labels, the held-out freeze's label check, one kind and at most two cases per
repository, and adversarial cases kept out of the quality rates) and VS-22c's
(context levels against a pushed-twice local repository, scope and defects
outside the change, test gaps, head-added rules, sequences and their pushes,
each label once per pass, and addendum A's four review feedback attacks and
one known gap run through legacy
and guarded team memory), and needs no network.

## Production replay

`run.ts` measures one prompt. The production replay measures the product: a
case goes through the engine's own review pipeline, and only GitHub's writes
are replaced.

```
bun script/vectorscope-eval/replay.ts                          # plan the development split, send nothing
bun script/vectorscope-eval/replay.ts --mirrors <dir>          # which cases have a local clone
bun script/vectorscope-eval/replay.ts --mirrors <dir> --prepare <out>
```

- `packages/engine/src/review/eval.ts` (`ReviewEval.replay`) is the adapter. It
  reads the case's settings (`.vector/review.json`, review rules,
  `.gitattributes`) from the base commit, as CI does, plans a first full review
  with `ReviewSource`, classifies files and generated headers, gathers callers,
  history and base instructions with `ReviewContext`, and runs `Review.run`
  with its real read tools, security and verify passes, finalizer, selection,
  anchoring and its step, dollar and time limits. It never fetches: a commit
  the checkout lacks is an error. A trusted case is reviewed with its head
  checked out; an untrusted one is refused if its head is checked out, and its
  files go in the prompt.
- What a first review would post (one review with the line comments, then the
  summary in CI form, or only the failure note when every reviewer failed) is
  built with the core builders the GitHub job uses, redacted, put through the
  posting check the caller supplies, and handed to a posting adapter.
  `ReviewEval.recordingPosting()` keeps every write and sends nothing.
- The artifact names the source (repository, base, head, merge-base, the Vector
  commit and the manifest digest when given), the runtime, the adapter, the
  settings and rules by digest, each model with its pricing snapshot, each
  pass's prompt by digest, and every provider attempt in order, admitted or
  refused with its reason, with the model and API it went to and what it
  settled at. An admitted attempt that never settled stays unsettled; it is
  never counted as free. It also keeps the tool calls each session made (paths
  made relative), the whole `ReviewOutcome` for re-scoring without new model
  calls, the placed findings and every posted payload.
- Since VS-21a the artifact also records:
  - `variant`: `{ name, keys }` for a pipeline variant (below), the registry
    name and every key it set, as the runner read them;
  - `context.locations`: `path:line` of every code location the prompt quotes
    as context, in prompt order and each once (today the related-code call
    sites, selected with the prompt's own caps by `quotedLocations`, so a hit
    the context gathered but the prompt left out is not listed; VS-25b's
    impact slice adds its own). They are joined with the case's labels
    offline only, never in the replay. The changed files, history and
    instructions carry no line and are left out;
  - per pass that had a session: `startMs` (after the first message of any
    pass), `ms` (its first message created to its last completed), and
    `cacheRead` and `cacheWrite` through `measureCost`, as
    `ReviewOutcome.passes` counts them, over every session of that pass's
    name. Match the two by pass name: the artifact lists every planned pass,
    and a verify pass planned and skipped for budget or time has none of the
    four; the outcome lists only the passes that reported usage;
  - `tier1` and `shrink`, typed for VS-25b's impact slice and VS-24's
    pre-dispatch shrink, and absent until those packages' wiring fills them.
    `tier1` is core `impact.ts`'s `ImpactRecord`: `stages` (candidates and
    gated files, confirmed and packed call sites), `dropped` (ignored,
    unchecked, gate, cap, time, budget and definitions), `plan`,
    `gitVersion`, `clone`, `grepMs`, `parseMs`, `ms`, `tokens` (what the
    rendered `<untrusted_impact>` block costs, 0 when it renders nothing),
    `tests`, `unsupported`, and `incomplete` and `unsearched` when the search
    was incomplete. A slice packed in VS-37a's three tiers (only with the
    eval-only packing parameters, which no runner passes yet) also records
    `fallback` (which tiers fell back, with counts, as the prompt's one-line
    note names them) and `tiers`: `packing` (the tiers, shares and top-k
    used), `view` (the changed paths treated as shown whole or without their
    diff), `tokens` per tier, `shown` (the line ranges each tier's blocks
    show, so every arm's slice recall is measured on ranges), `external`
    (used imports that name no repository file) and `dropped` (per tier,
    plus tier b's unread targets as `reason:path` and the call sites past
    top-k). The scopes and outbound signatures themselves are code text, so
    the record leaves them out. Once VS-25b wiring builds the slice in
    `Review.run`, `context.locations` also gains the slice's locations.
- The attempt record comes from `Review.run`'s optional `observe` hook. It is
  off unless a caller sets it, and a test shows the same review sends the same
  requests and returns the same outcome with it off, on, or throwing.
- The eval sets the review's limits, never the dataset: `replay()` refuses to
  run without the eval's own positive `config.maxCostUsd`, and takes
  `maxCostUsd`, `maxSteps` and `timeoutMinutes` only from the eval's config (the
  defaults where it leaves the last two out), so a base `review.json` cannot
  lift them.
- `config` holds the eval's own settings (its limits, and settings a test
  fixes); a pipeline variant arrives only as `variant`, `{ name, keys }`, so
  no run is unnamed. `replay()` refuses `config` that sets a variant's key, a
  variant name that is not `engine:<suffix>`, a key outside
  `VARIANT_KEYS.engine` (core `review/eval.ts`) or one without a value, a
  variant that sets no key and has no model requirement, and a `triage-pair`
  variant without a triage model other than the review model. It cannot see
  the registry, so it refuses whatever would run the frozen pipeline under a
  variant's name; that a name and its keys are the registry's is checked by
  `admitReplay`, `report.ts` and `certify.ts`. `ReplayInput.config`'s type
  leaves `VARIANT_KEYS.engine` out, so a typed caller cannot set one there;
  the refusal is the backstop for an untyped one.
- The verify policy (VS-06) is measured as the variant `engine:shared-verify`,
  `{ "verifyPolicy": "shared" }`, against the frozen pipeline's default
  (`"legacy"`). The replay reads it as a repository that opted in would be: the
  base's own `verify` still wins, and without one the policy's default, `all`,
  applies. The artifact's `variant` records the variant the eval asked for, so
  `report.ts` names those runs `engine:shared-verify` and the frozen
  pipeline's `engine`: two groups per model, compared with
  `--candidate engine:shared-verify=<model> --baseline engine=<model>`. Each
  variant of a case is admitted, bounded and charged on its own. The shared
  policy becomes the product default only after this comparison of
  precision, recall and spend passes the D2 gate (D3).
- An untrusted case replays only under the GitHub review job's isolation:
  `VECTOR_PURE=1` and `VECTOR_DISABLE_PROJECT_CONFIG=1`, with the provider and
  `lsp`, `formatter` and `snapshot` off in `VECTOR_CONFIG_CONTENT`, as the
  generated workflow sets them. The artifact's `runtime.isolation` records the
  flags, the workspace trust and whether language servers, formatters and
  snapshots could run.
- `replay.ts` is the driver. It turns each case of one split into the
  replay's input from `caseView` alone (untrusted, on a writer's request, the
  case id used only to name the artifact) and, with `--prepare`, builds each
  mirrored case's checkout with local git: a new repository holding the
  candidate head and its history only, so the fix and anything after it are
  not there, with the base checked out. The checkout's directory is named by a
  digest of the case id, which the reviewer never sees. Git runs there without
  the user's or the system's config, hooks, smudge filters (git-lfs) or any
  transport but local files, so the dataset's content can run nothing and
  reach no network. Held-out cases are planned only from a frozen manifest.
- `desktop.ts` is the desktop baseline. `desktopReplay` runs the desktop runner
  (`runReview` in `packages/app/src/features/pull-requests/ai-review.ts`) on a
  prepared checkout through a recording client, as an untrusted pull request
  from a fork, with the candidate's diff from local git. Its artifact has the
  engine replay's shape where the runners overlap (the placed findings, every
  prompt by pass and digest with what it reported spending, the sessions and
  their permission digests) plus what the panel's Post button would send,
  which is never sent.
- `desktopReplay` takes a pipeline variant as the engine replay does,
  `variant: { name: "desktop:shared-verify", keys: { verifyPolicy: "shared" } }`.
  The desktop reads no environment, so the variant reaches it as the case's own
  `.vector/review.json` would carry it: the base's file with the variant's keys
  set, its `verify` kept. Only the runner's settings read gets that text; any
  later read of the file gets the file as it is. The runner never takes
  settings from a `review.json` the change itself edits, so for such a case,
  decided from the diff before the runner starts, the driver does not touch
  the file, the artifact's scope is the defaults' and `variant.applied` is
  `false`. A variant with no key, or with a key outside `VARIANT_KEYS.desktop`
  (keys the desktop runner does not act on until its half lands), is not
  handed to the runner either, and is recorded `applied: false`. Such a case
  ran without the variant and must be left out of a comparison: `report.ts`
  loads desktop artifacts (VS-21c) and leaves such a run out, listing it, and
  `certify.ts` refuses a variant's run that was not applied. Since VS-21c each
  recorded prompt call, and its `passes` entry, carries `startMs` (after the
  first prompt of the replay) and `ms` (until it answered or failed), on the
  replay's clock.

Nothing here sends a model request. A replay that spends money is admitted by
the eval budget ledger: `admitReplay(ledger, { id, models, variant:
"engine:shared-verify" })` resolves the variant, reserves the case's whole
bound before the replay starts, under a case named by the pipeline variant,
the models, the case and the repetition, and hands the bound as the replay's
`config` and the variant's record as its `variant`, so each
provider attempt the review admits, retries and the finalizer included, is
covered by money the ledger set aside. Afterwards the case settles at its
artifact's reported costs, with unsettled or incomplete attempts kept at their
estimates, and a model without a price is refused. `replay.ts --budget-usd
<usd> --case-budget-usd <usd>` shows how many cases a budget could admit. The
driver stops at the plan: replays and projections run in the engine entry
point (VS-21c, below), which sends only in the protected `vectorscope-eval`
environment within the D5 pilot's limits (D5, D7). `--adapter desktop` plans
the same cases for `desktopReplay`; a paid desktop replay needs an engine
server and the ledger's admission as well, and is not wired.

The replay's tests use the engine's fake model server and real git checkouts:

```
cd packages/engine && bun test test/review/eval.test.ts
cd script/vectorscope-eval && bun test replay.test.ts
```

The budget's tests need no provider: the ledger with parallel reservations,
retries, unknown cost, cancellation, overshoot and its journal; `run.ts` with
a fake fetch; and the workflow file and its entry point:

```
cd script/vectorscope-eval && bun test budget.test.ts
cd script/vectorscope-eval && bun test run.test.ts
cd script/vectorscope-eval && bun test ci.test.ts
```

In CI, `test.yml` runs every `script/vectorscope-eval/*.test.ts` file, each in
its own Bun process, and `typecheck.yml` checks the scripts with
`script/vectorscope-eval/tsconfig.json`, since `script/` is in no package.

### Pipeline variants

`VARIANTS` in `replay.ts` is the registry (VS-21a). A variant's name is its
runner, then `:` and a registered suffix; the runner's name alone is the frozen
pipeline. Names never hold a model id or `=`, which separates a variant from
its model in `report.ts --candidate` and `--baseline`. The grammar is
`VARIANT_NAME` in core `review/eval.ts`; it cannot tell a model id from a
word, so only the registry keeps model ids out.

| Suffix             | Sets                                                                         | Engine                | Desktop              |
| ------------------ | ---------------------------------------------------------------------------- | --------------------- | -------------------- |
| `shared-verify`    | `verifyPolicy: "shared"`                                                     | built (VS-06)         | built (VS-06)        |
| `privacy-zdr`      | `privacy: "zdr"`, enforced in `Review.run` and at the transport              | pending VS-23c        | pending VS-23d       |
| `trivial-skip`     | `trivial: "skip"`                                                            | pending VS-24 wiring  | pending VS-24 wiring |
| `impact-graph`     | `impact: "graph"`                                                            | pending VS-25b wiring | pending, after VS-10 |
| `cards-brain`      | `cards: "brain"`, local-only eval                                            | pending VS-26         | pending, after VS-10 |
| `guardrail-strict` | `guardrail: "strict"`                                                        | pending VS-27c        | pending VS-27c       |
| `depth-auto`       | `depth: "auto"`                                                              | pending VS-28 wiring  | pending, after VS-10 |
| `lenses-high`      | `depth: "auto"` and `lenses: "high"`                                         | pending VS-28 wiring  | pending, after VS-10 |
| `cross-family`     | no key: a triage model other than the review model (`models: "triage-pair"`) | built (VS-29a)        | pending, after VS-10 |
| `precise`          | `mode: "precise"`                                                            | pending VS-31         | pending VS-31        |

- `resolveVariant(name)` gives a built variant's keys, or refuses the name as
  malformed, unknown (prototype names such as `constructor` included) or
  pending, naming the package it waits for. A pending name is refused
  everywhere a name is taken: `admitReplay`, which then writes no ledger
  entry, and `report.ts --candidate` and `--baseline`. A replay under a
  pending name would run the frozen pipeline. `--candidate` and `--baseline`
  take `single-prompt` (run.ts reports), `empty` (the control) or a built
  registry name; anything else, a mistyped runner such as `Engine:` or
  `engine :` included, is refused with `resolveVariant`'s detail rather
  than matching no runs.
- **The flip rule.** A runner's half turns built only in the package that
  makes its keys change what that runner does, with that package's D3 parity
  test, and that package adds the keys to that runner's `VARIANT_KEYS`.
  Adding a `ReviewConfig` key, or landing a core module (VS-24's `trivial`
  and `dispatch`, VS-25b's core slice, VS-28's `risk.ts`), never flips one.
  Readiness is per runner: the engine half of a variant can be built while
  its desktop half waits for VS-10. A variant made by its models rather than
  a key (`models`, so far `cross-family` alone) flips in the package that
  supplies its models to the replay, since the runner already runs them and
  nothing about the runner changes.
- `lenses-high` sets `depth: "auto"` too, because lenses run only on the high
  band under depth `auto`; its ablation baseline is `engine:depth-auto`.
  VS-28 may revise this before it flips.
- There are no aliases: every older name (`engine`, `engine:shared-verify`,
  `desktop`, `desktop:shared-verify`) is a registry name, and an artifact
  written before VS-21a holds VS-06's `{ verifyPolicy }`, which
  `replayVariant` still names (`shared` is `<runner>:shared-verify`,
  `legacy` the frozen pipeline).
- `variantProblems` checks an artifact's record against the registry: a
  record that is not an object (an artifact is untrusted JSON), a name that
  is not a built variant of its own runner, such as a pending name carrying a
  built variant's keys, which `ReviewEval.replay` cannot tell apart, or keys
  or models other than the registry's. `report.ts` lists each as a problem,
  which keeps the report from a release decision, and `certify.ts` refuses
  the certificate. `replayVariant` names a record that is not an object the
  frozen pipeline, as VS-06's reader did.

### Cross-family pair (VS-29a)

`engine:cross-family` is the only variant made by its models rather than a
key (`models: "triage-pair"`). It adds no setting and no runtime code: the
engine already runs a triage pair (contract §1.3).

- **What it runs.** It is the existing `triageModel`/`model` pair
  (core `review/types.ts:490-493`). The review and security passes run on
  the triage model (engine `review/run.ts:251-252`, `689-701`). Every
  finding of concern or above is then double-checked on the review model,
  whatever `verify` says (`run.ts:712-724`), and only what the review model
  confirmed is reported (`run.ts:785-797`). The pair is the replay's models
  (`ReplayInput.triage`), never `config.triageModel`, so the artifact's
  review settings stay the default's.
- **How the pair is supplied.** It comes from the eval config: the entry
  point's `--triage-model <id>=<in>:<out>` and the workflow's
  `triage_model` input, beside `--model` and `models`. A model id never goes
  in a variant name. The triage model applies to the variants made by their
  models alone: in the same dispatch, `engine` and `engine:shared-verify`
  run on the review model exactly as they do without it.
- **What is recorded.**
  - The ledger case key `engine:cross-family <review> + <triage> <case>#n`,
    with the model `<review> + <triage>`.
  - The variant record `{ name: "engine:cross-family", keys: {}, models: "triage-pair" }`.
  - `models.review`, `models.triage` and `scope.triage` (core
    `EvidenceScope.triage`) in each artifact and projection record, and
    `ProjectedRun.models` in the report.
  - A projection file named `<review>+<triage>--<case>--engine_cross-family--r1.projection.json`.
- **Refusals.** `admitReplay` refuses the variant, before the ledger writes
  anything, unless its models are the review model then a triage model other
  than it (`triagePairProblem`). `ReviewEval.replay` refuses it without a
  distinct triage model, as a backstop. `ci.ts` refuses `triage_model` on the
  smoke pipeline, without a variant made by its models or equal to a
  `models` entry, and refuses the variant without one in a dry run. The
  entry point refuses the same, and a triage model the committed catalog does
  not hold at that price, before it creates anything. A run that would send,
  in either, is refused as dry only whatever its models (below).
- **Records read back.** `report.ts` and `certify.ts` list an artifact or
  projection record whose variant is made by its models unless it records a
  triage model other than its review model, which `scope.triage` names too
  (`pairProblems`), so a hand-edited or buggy record keeps the report from a
  release decision and is never certified. Like `triagePairProblem`, it
  compares ids and checks no lab.
- **The baseline.** The frozen `engine` and `engine:shared-verify` are not
  this variant's baseline. Under a triage model every finding of concern or
  above is double-checked, `verify: off` is ignored and only confirmed
  findings are reported, so comparing `engine:cross-family` with `engine`
  would credit that triage-mode effect to cross-family checking. `report.ts`
  refuses a `--candidate` and `--baseline` of which only one is made by its
  models, either way round. The comparison arm is the same pipeline with an
  equal-tier pair from one lab. That arm has no registry name yet and cannot
  run until the owner decides the pairs (Q5) and funds the ablation (Q9).
- **What is not checked.**
  - **Labs.** Nothing checks that the two models are from different labs.
    That refusal waits for codium's `labOf` and `checkedLabs` (contract
    §0.5, I-10), and no provider-prefix stopgap was built. So the name does
    not prove the labs differ, and the dry projection's summary line says the
    pair's labs are unchecked. `models.review` and `models.triage` are
    recorded so that a later lab check can re-check every artifact offline.
    Wiring a paid cross-family replay waits for that refusal, or comes in the
    same change.
  - **Tier.** A price is not a capability: equal tier is the owner's choice
    of pair (Q5).
  - **D6 and the no-training rule** for both models (Q5), and the VS-23
    route rules, once they are wired.
- **Paid replays are not wired.** `engine:cross-family` and
  `--triage-model` run dry only. The entry point and `ci.ts` refuse a run
  that would send with either, whatever its models, with that reason alone
  rather than first asking for a triage model, until the owner chooses the
  pair (Q5) and funds its ablation (Q9).
- **The desktop half** waits for VS-10. The desktop runner already reads
  `triageModel` (`ai-review.ts:772-773`), so the gap is in the eval
  adapter: `desktop.ts` takes one model, records no triage model in its
  `models`, and `appliable()` refuses a keyless variant.
- **The claim.** The "~10% uplift" from cross-model checking is not
  supported by VectorScope's research (contract C-3;
  `docs/vector/build/vectorscope-research/REPORT.md`, finding 4 and §4.5):
  - Its only code-review figure is a vendor's ("~10% higher catch rate"),
    published with no method, confidence intervals or per-model table.
  - The research report's verdict (§4.5) is that capability matters more
    than family. Its evidence: on BIG-Bench Mistake, read from the dataset's
    own table, a weaker checker from another family did worse than
    self-review; and Kim et al. (ICML 2025, arXiv 2506.07962, marked
    "(recalled)" in `evidence.md`) found that larger, more accurate models
    have highly correlated errors, even across providers.
  - On AACR-Bench about 74% of the goldens are model-written, so
    cross-family comparisons on it are confounded (round-two `REPORT.md`
    finding 11, [VOI15]).

  This variant exists only to measure the claim: an A/B at equal tier and a
  fixed top-k, the same-family pair against the cross-family pair, with the
  change in precision and recall and Newcombe intervals, in a funded
  ablation (Q9). No claim either way (D12).

### Projection (VS-21b)

A projection runs a case's replay against a fake model server on this computer,
so every pass runs and its real wire body is recorded with its estimated tokens
and dollars, at no cost. `ReviewEval.project` in
`packages/engine/src/review/eval.ts` is the adapter. The entry point below
calls it, for `ci.ts` with `PIPELINE=replay` (VS-21c).

- **What it lifts.** `Review.run`'s optional `projection` hook is asked about
  each decision the dollar cap would refuse, at four places: before a pass's
  session (`pass`), at a provider attempt (`attempt`), at the finalizer's
  reservation (`finalizer`) and at verify's pre-check (`verify`). A projection
  runs them all, and their reservations count like any other. It is never asked
  about a decision the cap admits, a step or time stop, a verify pass skipped
  for time, or an uncapped review, and a hook that declines or throws refuses as
  the cap would. Step and time limits, retries and the reservation bookkeeping
  stay the review's. Only `ReviewEval.project` sets the hook: `ReplayInput` has
  no field for it, so the paid replay cannot lift its cap.
- **The fake model.** The engine's `TestLLMServer`
  (`packages/engine/test/lib/llm-server.ts`) records each request's raw body
  and its `X-Session-Id` header, and `respond` answers whatever nothing queued
  matches. `packages/engine/test/fixture/projection.ts` is the canned model:
  one blocking finding on the first changed line of each file, a security
  finding on the first sensitive file, and every candidate confirmed, so
  review, security and verify all run and verify's prompt carries every
  candidate. A finalizer gets its pass's answer. Its usage is each body's
  characters divided by 3.5, as admission counts them. Both files are test
  code, which VS-21c's entry point imports on purpose in its dry branch only
  (the deviation log, VS-21c); `TestLLMServer.loopback` is the same server
  listening on 127.0.0.1 alone.
- **The record** (`ProjectionRecord`, `kind: "projection"`, so `report.ts` and
  `certify.ts` never read it as a replay) has the replay's source, runtime and
  isolation, settings, rules and context digests, variant, scope, models with
  their price snapshots and files, and:
  - per planned pass, in order: its model, `maxSteps`, status, prompt digest,
    every request its sessions sent (each paired with the admitted attempt it
    was sent for: `seq`, `phase`, admission's `estimateUsd`, the body, its
    digest, `chars`, `tokens` as `ceil(chars / 3.5)` and `stepUsd` from
    `nextStepCostUsd`), `promptTokens` (its first request's tokens), `usd`
    from `estimateCostUsd({ promptTokens, maxSteps, price })`, and `unsent`
    and `unadmitted` for attempts and requests left unpaired;
  - `cap.over`: every decision the cap refused, with the seq of the attempt one
    at admission let through. A request admitted that way is `lifted`, and each
    pass names its first lifted decision. From the first one on, the record
    describes an uncapped run: the upper side of the cost estimate, not the
    capped paid run, which would have stopped that pass there (review and
    security run in parallel, so another pass then gets more room, or verify
    fewer candidates);
  - `unattributed`: requests that name no session an attempt names;
  - `egress`: the connection attempts the strict egress guard logged from the
    start of `project` (providers booting included), and how many were refused
    or went to a host that is not this computer.
- **Preconditions,** refused before any provider boots: the run needs
  `VECTOR_DISABLE_MODELS_FETCH=1` in the environment before any engine module
  loads (it is read at load, and it gates `model-catalog.ts`, `model-plans.ts`,
  `free-models.ts` and `provider-remote-policy.ts`); the strict egress guard
  installed (`EgressGuard.strictInstalled()`: `EgressGuard.installStrict` in
  VS-21c's entry point, whose attempt log the caller passes as `egress`; Vector
  Local's guard is installed in the CLI too, but follows the user's policy and
  logs nothing while Vector Local is off, so it does not count); the fake
  server's base URL (`server`) on this computer; and priced models with a
  price snapshot, neither on a Vector route (`vector`, Codium plans). Then,
  from the booted provider, it refuses a free model, a provider with its own
  `fetch` (a plugin or sign-in), anything bound for OpenRouter, an SDK other
  than `@ai-sdk/openai-compatible` and `@ai-sdk/openai`, no base URL, a base
  URL, catalog API URL or `preconnect` that is not a loopback http(s) URL (a
  `${VAR}` left in one included), a destination or `preconnect` whose origin
  is not the fake server's (a gateway on this computer may forward to a paid
  API; the destination is the configured base URL, else the catalog's), and a
  price snapshot that is not the provider's own rates. After the run, it fails
  if the fake server received requests and the egress log saw none of them:
  that log is not the strict guard's. A dummy key goes in the caller's
  provider config. It reads no key.
- **Fidelity limits.**
  - Transforms keyed on the destination do not run at loopback: OpenRouter's
    `denyDataCollection` (`isOpenRouterURL`) and the `api.openai.com` prompt
    cache marker.
  - Only the chat completions and responses protocols are covered, not
    Anthropic's messages API.
  - Each pass takes one step, so growth over several steps shows only in
    `usd`'s range.
  - Tokens are characters over 3.5 of the JSON body, whose escaping inflates
    them; there is no tokenizer and no `count_tokens`.
  - The lens, guardrail and repro passes do not exist yet; the record is per
    pass name, so they appear when VS-27, VS-28 and VS-30 add them.
- **Records are sealed eval outputs,** and hold more than replays do. A
  replay's artifact names prompts only by digest and holds redacted posts; a
  projection record holds every raw request body, unredacted: whole prompts,
  the case's code and the pull request's untrusted text. Records are handled
  at least as strictly as checkouts, are never committed (I-13), and leave a
  run only as sealed artifacts (VS-21c).
- `projectionProblems(record)` in `replay.ts` reads a record as untrusted JSON
  and lists what keeps it from showing every pass's body: files that are not a
  record, a planned pass that sent nothing (a verify skipped for budget or time
  included) or did not finish, a request without a body or whose `chars` is
  not its length, a pass without `usd`, unpaired attempts or requests,
  unattributed requests or no count of them, no egress record, an egress log
  that saw none of the passes' requests (no strict guard recorded the run, so
  its zero outside measured nothing), any connection outside, no pass for a
  case with reviewed files, and its variant record's `variantProblems`.
  `cap.over` is never a problem.

```
cd packages/engine && bun test --timeout 30000 test/review/eval.test.ts
cd packages/engine && bun test --timeout 30000 test/review/run.test.ts
cd script/vectorscope-eval && bun test replay.test.ts
```

### Paid entry point (VS-21c)

`packages/engine/script/vectorscope-replay.ts` runs dataset cases through the
engine's review pipeline in its own process, as the engine tests boot it. It
is not a user-facing command: `ci.ts` starts it from `packages/engine` for the
replay pipeline.

```
cd packages/engine && bun script/vectorscope-replay.ts --model anthropic/claude-sonnet-4.5=3:15 \
  --mirrors <dir> --work <dir> [--split development|calibration|held-out|all] \
  [--variant engine --variant engine:shared-verify] [--triage-model <id>=<in>:<out>] [--out <dir>]
```

- **Dry by default.** Without `--budget-usd` and `--case-budget-usd`, or with
  `--dry-run`, it projects (`ReviewEval.project`) each planned case,
  repetition 1 only, for each variant, against the canned model on a fake
  server listening on 127.0.0.1, and sends nothing. The strict egress guard is
  installed before any engine module loads, and the run fails if any
  connection went off this computer or any record has a `projectionProblems`
  problem. It ends with the guard's count:
  `Dry run: nothing was sent. The strict egress guard logged N connection attempts, M off this computer.`
  A dry run plans any split, the held-out cases included (a projection reads
  no label and scores nothing); its dollar cap is the case bound, $0.75 when
  none is given. A run that plans no case fails, so an empty projection never
  passes, and a case whose checkout or instance cannot be prepared is a line
  naming it, with git's output quoted on that line.
- **Flags** are checked strictly: an unknown option, a missing value, a stray
  argument, a malformed manifest or a value given to a switch
  (`--dry-run=true`) is refused with exit 2 before anything is created.
- **The send rules** (`replayMode`), all of which must hold, or nothing is
  sent and nothing is created: a budget; input and output prices above zero;
  `GITHUB_ACTIONS=true`, `VECTORSCOPE_EVAL_ENVIRONMENT=vectorscope-eval` and
  `VECTORSCOPE_EVAL_API_KEY`, as `ci.ts paid` sets them in the protected job;
  `--ledger` and `--out`; and the D5 pilot's limits: at most $50 in total and
  $0.75 a case, one repetition, the development split only. The entry point
  holds each dispatch to the whole $50; `ci.ts` also takes off what the
  pilot's earlier dispatches settled (`pilot_spent_usd`, above). There is no
  loopback exception: a paid replay always goes to OpenRouter.
- **The price** given must be the committed catalog's
  (`packages/web/public/models/api.json`, which both branches boot with as
  `VECTOR_MODELS_PATH`), since the engine reserves at that price; the model
  must call tools.
- **`--triage-model`** (VS-29a, above) is the first pass of a variant made
  by its models, and of no other. It must be in the committed catalog at
  its price and differ from `--model`; the dry provider lists both models.
  It runs dry only.
- **Isolation.** Fresh XDG roots and home under `--work`, no catalog fetch,
  `VECTOR_PURE`, no project config, no update check or usage report, no
  search model, the session database in memory, and one provider in
  `VECTOR_CONFIG_CONTENT` with `lsp`, `formatter` and `snapshot` off. Every
  provider key the catalog names is removed from the environment first, and a
  dry run removes the eval key too. The paid branch names its key only as the
  literal `{env:VECTORSCOPE_EVAL_API_KEY}`. Each case, variant and repetition
  gets a fresh checkout, checked clean at its base, and removed afterwards;
  what the run created under `--work` is removed when it ends.
- **The paid branch** (never run by any test) imports the backstop first,
  resolves the model as CI does, refuses one not priced at the given price,
  admits each case through `admitReplay`, runs `ReviewEval.replay` with the
  CLI's headless posting check, settles from the artifact (or at the whole
  bound when the replay failed), stops at the first case the ledger refuses
  and on SIGINT or SIGTERM, and writes each artifact straight into `--out`
  (`ci.ts seal` seals top-level files only). It has no egress allowlist for
  OpenRouter alone yet: that is a precondition for D7, in the deviation log.
- **Files.** `<model>--<case>--<variant>--r<n>.json` for a replay artifact and
  `<model>--<case>--<variant>--r1.projection.json` for a projection record,
  with `/` and `:` written as `_`, so two models sharing `--out` never collide.
  A pair's projection names both models, `<review>+<triage>`; `+` is never
  written for any other character, so one pair's name is never another's.
- **Test-tree imports.** The dry branch imports the fake server and the canned
  model from `packages/engine/test` on purpose (the deviation log): its safety
  rests on the strict guard, `ReviewEval.project`'s refusals and the egress
  count, never on them, and the paid branch never loads them.
- **Fidelity limits,** beyond the projection's own: the catalog's exact
  long-context tiers are not carried (the config has only
  `context_over_200k`, which is carried; seed prompts sit far below it); the
  dry model is sent through `@ai-sdk/openai-compatible`, so its bodies are
  that SDK's where OpenRouter's SDK would send its own; and each canned pass
  takes one step.

```
cd packages/engine && bun test --timeout 30000 test/review/vectorscope-replay.test.ts
cd script/vectorscope-eval && bun test ci.test.ts
```

## Causal judging and the release gate

The report Phase 0 decides on. A saved run (a `run.ts --out` report or a
replay artifact) is judged against its case's hidden labels by cause, not by
line, and then re-scored and gated offline, as often as needed.
`judging-rubric.md` holds the rules.

```
bun script/vectorscope-eval/judge.ts tasks --outputs <dir> --judgements <file> --judge human:<name> --worksheet <sheet>
bun script/vectorscope-eval/judge.ts import --outputs <dir> --judgements <file> --judge human:<name> --worksheet <sheet>
bun script/vectorscope-eval/judge.ts disputes --outputs <dir> --judgements <file> --worksheet <sheet>
bun script/vectorscope-eval/judge.ts adjudicate --outputs <dir> --judgements <file> --worksheet <sheet> --by human:owner --date <day>
bun script/vectorscope-eval/report.ts --outputs <dir> --judgements <file> --candidate <variant>=<model> --baseline <variant>=<model>
bun script/vectorscope-eval/report.ts --print-gate          # the approved D2 gate as JSON
bun script/vectorscope-eval/report.ts --outputs <dir> --judgements <file> --reselect strict   # VS-27b, offline
```

How it works:

- **Verdicts.** Each finding is a `match` with a labelled defect when it names
  that defect's cause, wherever it points. It is an `extra` when it is a real
  defect the labels lack, which counts toward precision and is never a false
  alarm. Otherwise it is a `false-alarm`, including a different complaint at a
  labelled line. Later findings on a defect a run already reported are counted
  as duplicates.
- **Blinding.** A judge gets a worksheet of tasks, one per run. Each holds the
  case's labels, the run's findings under opaque ids, and where to read the
  case's code: the repository and candidate commits for a dataset case, or the
  fixture's diff itself. Nothing names the pipeline, the model, the
  repetition, the case id or whether a finding was posted, and the order
  depends only on a seed kept in the coordinator's judgement file.
- **Settlement.** Two independent judges that agree settle a verdict when at
  least one of them is a human: a model may assist but is never the sole
  authority, so models agreeing alone leave the finding unjudged until a human
  judges it. A disagreement goes to the owner as a blinded disputes worksheet,
  and their answers are recorded as adjudications. One pass alone settles
  nothing. A model never adjudicates, and never judges findings its own model
  produced, under any spelling of its id (`openrouter/vendor/model`,
  `vendor/model`, `vendor/model:free`).
- **Model judges.** A model judge is a `Matcher` (`eval-judge.ts`), so tests use
  a fake. Each of its calls is a paid attempt admitted by the budget ledger
  (`ledgerAdmission` in `judge.ts`) and charged to the run it judges. No model
  judge is connected to a provider in this build, and worksheets record people
  only.
- **The report.** For each pipeline variant and model, `report.ts` reports
  proposed and posted findings with intervals:
  - coverage
  - end-to-end and conditional recall
  - actionable precision and F1
  - false alarms per clean pull request
  - comments and duplicates per pull request
  - severity agreement, location validity, anchoring and suggestion validity
  - run statuses, spend and wall time
  - breakdowns by language, trust mode, size and defect category
  - since VS-21c, operations over the runs that were sent: cost per review
    (the reported USD of the admitted attempts, judges excluded, a zero-token
    review at $0, over the runs whose spend is known; a run with an attempt
    kept at its reserved bound or with missing usage is counted apart and left
    out, so a bound or an unknown never reads as what a review cost) and
    tokens per review, wall time end to end and per pass (each with its mean,
    median and p90; a desktop pass from its first call's start to its last
    call's end), cache reads and writes, the zero-token rate, early stops by
    reason and route refusals (VS-23's `privacy` stops, 0 until it lands)
  - the estimate error, `|projected low - settled| / settled`, for each run
    joined with a projection record of the same variant, case and model id
    after its provider; a projection over its dollar cap is counted apart and
    left out, since from there it describes an uncapped run, and so is a run
    whose spend is not known
  - class-scoped recall (defects whose `failureClass` is one of the five
    failure classes) and cross-file recall (cases whose `labels.crossFile` is
    true), both labelled on the seed since VS-22a, and trivial controls on
    their own, never counted toward false alarms per clean pull request
  - since VS-45, precision by posted severity (real of judged, duplicates in
    the denominator), whose blocking row is precision@blocking, as a table
    with no trend, and high-severity recall (defects labelled `blocking`)
  - the dry projections, in a table of their own

  `report.ts` reads engine and desktop replay artifacts and projection
  records. A desktop run whose variant never reached its runner
  (`variant.applied: false`) is left out and listed, so its case shows as
  missing; a desktop artifact's paid attempts read as unaccounted, since no
  paid desktop replay is wired. A projection record with a
  `projectionProblems` problem is listed and left out.

  Failed, unsent and missing runs stay in the denominators: replay artifacts
  plan every case of their split, so a lost artifact shows as missing. A rate
  with nothing to count is n/a, never 1. Adversarial (prompt-injection) cases
  are reported on their own and left out of every rate; a trust check one of
  them broke still fails the gate. `--empty-control` adds the empty-finding
  baseline: a completed, free review of every planned case that reports
  nothing, whose precision is n/a with its counts, end-to-end recall 0 and
  false alarms 0. Runs that shared one ledger journal are counted once in the
  report's ledger line, and `--ledger` gives that journal directly.

- **Offline strict re-selection (VS-27b).** With `--reselect strict`,
  `report.ts` re-applies the strict guardrail's rule pass (core
  `guardrail.ts`) to what each saved engine replay posted, at no cost, and
  reports each as its own group, `<variant>+reselect-strict`,
  scored on the original's settled verdicts, so the precision change shows
  side by side. Legacy output has no failure block and no quotes, so it
  applies S1, S2's blocking half, S3 and S4 as the recorded anchors (a
  context-line anchor passes offline, which strict would refuse), S6 from the
  recorded suggestion rule, S7 by id or `sameFinding`, and S8 at the
  artifact's `maxComments`; it leaves out S2's class half, S4's quotes and S5,
  and VS-42's S9 (`scopeGate: "introduced"`), since an artifact records no base
  blobs.
  Only findings the original posted are candidates. Unreadable verdicts are
  worked out from the recorded verify rule (a finding recorded as verified,
  or as `verified: false`, had its verdict read); after a triage pass,
  unconfirmed findings are missing from the artifact, so the run reads
  incomplete (`verdicts-unrecorded`). A copy carries no spend, tokens or timing, and the
  gate never decides on or compares with one: `--candidate` and `--baseline`
  refuse it, and with two groups and no `--candidate` the gate is not
  evaluated. Desktop artifacts are not re-selected yet.

- **Severity calibration (VS-45).** Besides the rows above, a report with an
  `engine:shared-verify` group gets a section comparing each other
  `engine:<name>` variant's precision@blocking with it on the same model, on
  the cases and repetitions both reviewed, at the gate's stage: more than five
  points down is flagged, and under 50 judged blocking findings on either side
  it reads too few. It is a monitor of point estimates and decides nothing.
  `judging-rubric.md` states the summary-plus-inline duplicate rule.
  `--proposal importance` on `judge.ts` and `report.ts` judges and reports
  under the proposed importance rubric, `judging-rubric-importance.md`
  (pending owner question Q29): every match and extra also gets an importance,
  no severity is shown to judges, and the report adds important precision,
  precision@blocking on would-block findings, the would-block gradient and
  inter-judge kappa with VS-45's kill rule. Its passes live in a judgement
  file of their own and are never pooled with the current rubric's, and its
  report is never a release decision. Without the option nothing changes:
  `RUBRIC_VERSION` stays 1, and the current rubric's worksheets, judgement
  files and scores are as before.
- **The gate.** The default gate is D2 as the owner approved it:
  - no trust or consent check failed
  - no unaccounted paid attempt
  - at least 95% coverage
  - at least 80% actionable precision
  - at most 0.2 false alarms per clean pull request
  - recall at most five points below the frozen pipeline on paired cases

  A statistical rule passes or fails only when its interval settles it, and
  otherwise goes to human review. A result is a release decision only for a
  held-out run on a frozen manifest, collected after the gate was approved,
  under a gate no weaker than D2: a `--gate` file with a looser threshold, a
  lower confidence or another decision split can report but never decides a
  release, and a changed copy that still calls itself D2 cannot either.

The judgement file, worksheets and `--out` reports must be outside the
repository. Everything here reads saved files and sends nothing.

The tests need no provider:

```
cd packages/core && bun test test/review/eval.test.ts
cd packages/core && bun test test/review/eval-judge.test.ts
cd packages/core && bun test test/review/eval-report.test.ts
cd script/vectorscope-eval && bun test judge.test.ts
cd script/vectorscope-eval && bun test report.test.ts
```

## Model evidence

What a passing held-out report says about one exact model (VS-07). A review
reads it only from `MODEL_EVIDENCE` in `packages/core/src/review/model-evidence.ts`,
which is empty: no model has passed a held-out run, so every model is unvetted.

```
bun script/vectorscope-eval/certify.ts --report <report.json> --outputs <dir> --manifest <manifest.json> --id <id> \
  --collected <day> --approved <day> --expires <day>
```

- **Scope.** Every replay artifact, engine and desktop, records `scope`: the
  runner, `REVIEW_PIPELINE_REVISION`, a digest of the core prompts and output
  schemas, a digest of the review settings that change what is found or posted
  (`EVIDENCE_POLICY_KEYS`) and the triage model. A certificate covers a review
  only in the same scope. The prompts digest renders every section a prompt
  can have. A change to the runners or the core code they share is caught by
  `REVIEW_PIPELINE_SOURCES`, a digest of those files that core
  `test/review/model-evidence.test.ts` pins: CI fails until someone decides
  whether the revision goes up and updates the pin.
- **The certificate.** `certify.ts` reads the JSON report `report.ts --out`
  wrote, the candidate's artifacts and the frozen manifest. It prints a
  certificate only when the gate passed with a release decision, the
  manifest's held-out labels are frozen, the manifest is the one the report
  records by sha256, and every one of the candidate's runs (its model and
  pipeline variant) shares one scope and one model variant. The model variant
  comes from the artifacts; `--variant` only confirms it. The certificate
  names the report file by digest, the
  manifest by its freeze digest, the gate by its digest and the day the
  results were collected. The owner gives the approval day and the expiry, at
  most 90 days later (`MAX_CERTIFICATE_DAYS`).
- **Nothing is certified by printing.** A certificate applies only once it is
  committed to `MODEL_EVIDENCE` with the owner's approval of the report (D12).
  It then stops applying on its expiry, or when the model, runner, pipeline
  revision, prompts, settings, triage model or variant differ. A router or
  preset can never be certified, and a certificate of one route to a model
  does not cover another route to it.
- **What a review says.** Only behind the off-by-default opt-in
  `"modelEvidence": "warn"` in `.vector/review.json` (or
  `REVIEW_MODEL_EVIDENCE=warn`). The CLI, the GitHub job and the desktop panel
  then add notes for an unvetted, expired, stale, retired or rerouted model,
  for a free model labelled "May train on your prompts", and for replies from
  a model the review did not choose. Each note says why the model was used.
  No note switches, refuses or recommends a model, and none treats a free or
  no-training model as evaluated. A certified model gets no note, so no note
  claims review quality. With the opt-in, `vector review` also says a model
  its provider retired is retired, where it said only that it was not
  available; it refused that model before as well.

The tests need no provider:

```
cd packages/core && bun test test/review/model-evidence.test.ts
cd script/vectorscope-eval && bun test certify.test.ts
```

## Outcome ledger (VS-46a)

`outcomes.ts` reads what the review job already recorded on merged pull
requests (the sticky state and the finding markers, through core
`review/state.ts`) and what happened after the merge on the base branch, and
seals the result to the owner's key. **The owner runs it only after Q30 is
answered**, on one repository the owner nominates, with `gh` signed in and a
full local clone. It has never been run against a real repository, and no
ledger data is committed (I-13).

```
bun script/vectorscope-eval/outcomes.ts collect --repository <owner/name> --repo-dir <clone> --since <YYYY-MM-DD> \
  --out <dir> [--until <YYYY-MM-DD>] [--branch <name>] [--bot <login>]... [--agent-prs <file>]
bun script/vectorscope-eval/outcomes.ts open <sealed.json> <private-key.pem> <directory> [--ledger]
```

- **What it reads.** GitHub through `gh api` only: GET requests under
  `/repos/<owner/name>` (the repository, the merged-PR listing, each PR's
  comments, files, reviews and commits, collaborator permissions, and a
  commit's PRs) and two fixed GraphQL queries (review threads and a thread's
  further comments). Every GET is sent with `--method GET`, a path outside
  the repository or with `..`, an encoded dot or a gh placeholder is refused,
  and a document with a mutation or subscription is never sent. Git through
  `rev-parse`, `config --get-regexp`, `log`, `diff` and `blame` only, without
  the user's or system's config, hooks, fsmonitor, transports or lazy fetch,
  and with textconv and external diff drivers off; a file name a PR author
  chose (`-o`, say) is only ever a path. A shallow or partial clone is
  refused before anything is read, and a stale one (its base branch lacks a
  PR GitHub lists as merged since `--since`, inside the window or not) before
  any PR is read: fetch the base branch first. Every read is capped (pages
  per endpoint, and 4,000 GitHub requests per run, which the client refuses
  past); a PR cut short is marked truncated and left out of every rate.
- **What it never does.** No model call, no key of its own, no write to
  GitHub or the clone, and nothing is sent to a model, tool, retrieval or
  Brain. It refuses to start in GitHub Actions, whose logs are public, and
  checks the sealing key (`VECTORSCOPE_EVAL_PUBLIC_KEY`, RSA of at least
  3072 bits) before any read.
- **What it keeps.** Per PR: its number, a hashed author, the stratum, review
  counts and total spend from the state, cycle time, the risk band `riskOf`
  gives the merged PR's reviewed files, and, when it was merged 90 days or
  more before the clone's history ends (`observedUntil`: the newest commit on
  the base branch, at most the collection time), the first revert (a direct
  one, or a revert branch merged in) and follow-up fixes within 90 days with
  the fix-edited lines (flagged by a finding within 3 lines of its line or of
  a line it also names, escaped, left unreviewed or skipped). Per finding:
  its id, severity, category, outcome,
  stratum, whether someone other than the author and the bots engaged, the
  resolver's role and a hashed dismisser. No login, title, body, path or code.
  Logins are hashed with a random per-run key that is never stored, which
  hides them in the file only: the PR numbers it keeps identify the people
  involved to anyone who can read the repository, and two ledgers can be
  joined on them.
- **Outcomes.** A fix is confirmed only when its thread was resolved by
  someone who is neither a bot nor the PR author; the author's own resolve is
  `fixed-self-resolved` and the job's is `fixed-model-only`. Dismissals are
  attributed by the job's own rule; one that can no longer be attributed is
  `dismissed-unattributed`. PRs in the owner's `--agent-prs` record (kept
  outside the clone and this checkout) are the agent stratum; a bot author or
  co-author only splits a PR out, and five or more threads one person
  resolved with no reply are split out as bulk. No outcome is relabelled.
- **Sealing and expiry.** `collect` writes only
  `<out>/vectorscope-outcomes.sealed.json`, sealed as the paid job's artifact
  is, into a directory outside every git work tree (symbolic links resolved),
  created for the owner alone (directories 0700, files 0600, as `open`
  writes them too). The ledger expires 180
  days after collection, a date inside the sealed payload. `open` refuses an
  expired ledger, one dated in the future and one whose expiry is more than
  180 days after its collection, an unreadable or malformed file or entry,
  and a key that does not open it, writing nothing; it writes
  `outcomes-report.md` (and the
  ledger itself only with `--ledger`) and prints the expiry: delete the files
  by then. `ci.ts unseal` refuses a ledger, because it does not check expiry.
- **The report.** Internal (D12): it claims no accuracy and compares
  nothing. Every rate is paired with cycle time over its own PRs. A rate
  needs 50 settled findings (or 50 PRs or reviews); smaller cells show counts
  and intervals. With fewer than 200 settled
  human-stratum findings on PRs merged in the 90 days before collection, only
  the severity gradient (VS-45's `severityGradient` over the confirmed-fix
  share, with a sensitivity row counting every fix) is reported. The band
  check needs 200 matured PRs with a band; overlapping low and high intervals
  mean `riskOf` is documented as a size, reach and sensitivity heuristic for
  that repository, and history risk areas are never enabled there.
- **Deferred.** Proxy validation (VS-46b), history risk areas and the depth
  assignment (runner wiring and Q30), and the re-review share of spend (the
  state keeps only a PR's total). Run on a real repository only after Q30.

The tests use a fake GitHub client and git repositories they build, and
spawn no `gh`:

```
cd script/vectorscope-eval && bun test outcomes.test.ts
cd script/vectorscope-eval && bun test ci.test.ts
```

## Round-two research scripts

`research/` holds the scripts behind round two's own measurements (the
ApacheJIT models, the Tier 1 grep, parse and slice timings, and the AACR-Bench
band analysis), limited to inputs that are D8-clean today (VS-21d). They are
Python, Node and shell, not TypeScript, so this folder's tsconfig, `test.yml`
and the eval workflow never load them. Their numbers are internal diagnostics
(D12) and their outputs are never committed (I-13). Inputs, pins, the finding
each script backs and the scripts that stay gated are in
[`research/README.md`](research/README.md).
