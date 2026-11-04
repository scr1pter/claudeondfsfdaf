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

| Input             | Meaning                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `mode`            | `dry-run` (default) or `paid`                                                            |
| `models`          | `model=input:output` entries, USD per million tokens: `anthropic/claude-sonnet-4.5=3:15` |
| `budget_usd`      | Total for the whole run, every model and retry included (needed for `paid`)              |
| `case_budget_usd` | Bound for one fixture reviewed once by one model (needed for `paid`)                     |
| `max_tokens`      | Output token limit for each request (default 16000)                                      |
| `repeat`          | Runs per fixture, 1–5                                                                    |
| `fixtures`        | Comma-separated fixture names, or empty for all                                          |

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
- A case's `kind` is `bug`, `control` or `adversarial`. An adversarial case
  carries prompt-injection text and records it in `labels.injection`; it is a
  separate trust test, split on its own and never counted toward recall or
  false alarms per clean pull request.
- `annotation-guide.md` says how cases are found, checked, labelled, split and
  frozen.

The dry run never makes a network request. It validates the manifest,
recomputes every case's split and compares it with the recorded one, checks
the held-out freeze, and lists exclusions. With `--mirrors` it also checks with
git that each commit exists, that the base is an ancestor of the head and the
head an ancestor of the fix, that the candidate head does not already hold the
fix (post-fix leakage), and that commit dates, change sizes and labelled
locations match the repository. A case without a mirror keeps its recorded
check.

A bug case's fix and labels are hidden ground truth. A reviewer is given only
`caseView(case)`: the repository and the candidate's base and head. The
production replay below plans runs from that view alone, the budget ledger
admits what a paid replay may spend, and the causal judging at the end scores
the saved runs against the hidden labels.

`fixtures.test.ts` covers the dataset with local fixture repositories (missing
objects, wrong ancestry, post-fix leakage, a reverse diff, split grouping and
the freeze) and needs no network.

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
- The attempt record comes from `Review.run`'s optional `observe` hook. It is
  off unless a caller sets it, and a test shows the same review sends the same
  requests and returns the same outcome with it off, on, or throwing.
- The eval sets the review's limits, never the dataset: `replay()` refuses to
  run without the eval's own positive `config.maxCostUsd`, and takes
  `maxCostUsd`, `maxSteps` and `timeoutMinutes` only from the eval's config (the
  defaults where it leaves the last two out), so a base `review.json` cannot
  lift them.
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

Nothing here sends a model request. A replay that spends money is admitted by
the eval budget ledger: `admitReplay` reserves the case's whole bound before
the replay starts and passes it to `Review.run` as the review's cap, so each
provider attempt the review admits, retries and the finalizer included, is
covered by money the ledger set aside. Afterwards the case settles at its
artifact's reported costs, with unsettled or incomplete attempts kept at their
estimates, and a model without a price is refused. `replay.ts --budget-usd
<usd> --case-budget-usd <usd>` shows how many cases a budget could admit. No
engine entry point can start a paid replay yet, and it would run only in the
protected `vectorscope-eval` environment (D5, D7), so the driver stops at the
plan. `--adapter desktop` plans the same cases for `desktopReplay`; a paid
desktop replay needs an engine server and the ledger's admission as well, and
is not wired either.

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

  Failed, unsent and missing runs stay in the denominators: replay artifacts
  plan every case of their split, so a lost artifact shows as missing. A rate
  with nothing to count is n/a, never 1. Adversarial (prompt-injection) cases
  are reported on their own and left out of every rate; a trust check one of
  them broke still fails the gate. `--empty-control` adds the empty-finding
  baseline: a completed, free review of every planned case that reports
  nothing, whose precision is n/a with its counts, end-to-end recall 0 and
  false alarms 0. Runs that shared one ledger journal are counted once in the
  report's ledger line, and `--ledger` gives that journal directly.
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
