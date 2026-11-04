# VectorScope judging rubric

How a review's findings are judged against a case's labels, how verdicts are
settled, what the report measures and how the release gate decides. This is
rubric version 1 (`RUBRIC_VERSION` in `packages/core/src/review/eval.ts`).
Changing a rule below means raising that number. Every pass made under an
earlier version then counts as stale and must be redone, and the same saved
outputs are re-scored without any new review.

The code is `packages/core/src/review/eval.ts` (verdicts, settlement, scoring
and metrics), `eval-judge.ts` (blinding and judges) and `eval-report.ts` (the
report and the gate). `judge.ts` and `report.ts` in this directory are the
command-line tools. Dataset labels are made under `annotation-guide.md`.

## What is judged

A **run** is one review of one case by one pipeline variant and model, such as
the engine replay of a dataset case or the single-prompt harness on a fixture.
A run has two lists of findings:

- **Proposed:** what the reviewers reported.
- **Posted:** what survived verification and selection and would actually be
  posted. This means the line comments, plus the findings the summary lists
  (outside the diff, elsewhere, overflow and nits).

A finding has the same key in both lists, so it is judged once per run. Nits
are not claims of a defect. They are left out of judging and of precision
unless the gate counts them (`countNits`), but they still count as comments.

## Verdicts

Each finding gets one of three verdicts. Compare it with the case's labelled
defects: each has a summary, a cause, locations and alternative locations.

| Verdict | When |
| --- | --- |
| `match` with a defect id | The finding identifies that defect's **cause**: what goes wrong, for which input or state, and why. It may point anywhere. A finding elsewhere that explains the same cause matches. |
| `extra` with an issue name | The finding is a **real defect in the change** that the labels lack. Check it against the code, not only against the labels. Give findings in one task that describe the same defect the same issue name. |
| `false-alarm` | Anything else: wrong, speculative, not a defect in this change, a style preference presented as a defect, too vague to act on, or a **different complaint at a labelled line**. |

When a finding suggests a change, also rate the suggestion: `valid` if applying
it fixes the problem and breaks nothing, otherwise `invalid`.

Being on the right line is never enough. A finding at the defect's line that
names another problem is a false alarm, or an extra if that other problem is
real, and the labelled defect still counts as missed. A real extra defect is
never a false alarm, on a clean control too. If extras show a label is missing,
tell the dataset's annotators. Labels change only through their two passes and
adjudication, and a held-out label only with a new freeze.

**Duplicates are not judged; they are counted.** Within one run, the first
finding matched to a defect, or to an extra issue, counts. Later findings on
the same defect are duplicates. A duplicate stays in the precision denominator
but not in its numerator, because a repeated comment reports nothing new. It is
also reported as duplicates per pull request.

## Blinding and settlement

- **Blinded tasks.** A judge gets one task per run, holding the case's labels,
  the run's findings under opaque ids, and where to read the case's code: the
  repository URL with the candidate's base and head commits for a dataset case,
  or the change itself as a diff for a synthetic fixture. Read the code there
  before calling an unexpected finding a false alarm. Nothing names the
  pipeline, the model, the repetition, the case id or whether a finding was
  posted. Tasks and findings are ordered by their ids, which come from a seed
  only the coordinator's judgement file holds. The same finding in two runs gets
  unrelated ids.
- **Two passes with a human, or an adjudication.** A verdict is settled when two
  independent judges agree and at least one of them is a human, or when a human
  adjudicates. A model may assist with matching but is never the sole
  authority: models that agree with no human among them settle nothing, and the
  finding waits for a human's pass. Agreeing means the same verdict kind, and
  the same defect for a match. A single pass settles nothing. A finding without
  a settled verdict is **unjudged**: it is neither right nor wrong, and the
  report and the gate show it.
- **Disagreements go to a human.** `judge.ts disputes` writes them as a blinded
  worksheet that lists the verdicts given, in no fixed order and without the
  judges' names. The owner's answers are recorded as adjudications. A model
  never adjudicates.
- **No model judges itself.** A model judge's pass on a run whose findings
  came, wholly or partly, from that model does not count. A batch with such a
  judge is refused before any call. Model ids are compared by what they name,
  not how they are spelled: a router prefix (`openrouter/`), a route suffix
  (`:free`, `@preset`), a trailing date and dots against hyphens do not make
  another model.
- **Model judges are paid attempts.** Each call is admitted by the eval budget
  ledger first, as a `judge` attempt charged to the run it judges, and settled
  at what it reports. A call that fails after it was sent keeps its reservation
  as uncertain spend. Worksheets record people only. No model judge is wired to
  a provider in this build (D5, D12).

## Run status

| Status | Meaning |
| --- | --- |
| completed | The review finished: no early stop, no unreviewed file, no pass failed, timed out or stopped. |
| partial | The review stopped early, left files unreviewed, lost a pass, or reviewed nothing because every file was skipped. Its findings count, but it is not complete coverage. |
| failed | Every reviewer failed, or the request failed. |
| not sent | The budget did not admit it. Nothing was spent. |
| missing | Planned, with no saved output at all. |

Every planned run stays in the denominators. A run that is failed, not sent or
missing detects nothing.

## Metrics

Each metric is reported for the proposed and the posted findings, for each
pipeline variant and model. Breakdowns by language, trust mode, change size and
defect category use the gate's stage.

| Metric | Definition |
| --- | --- |
| Coverage | Completed runs of the planned ones. |
| Recall, end to end | Labelled defects detected over the defects of every planned run. |
| Recall, completed runs | The same over completed runs only. |
| Recall, macro | The mean of each bug case's end-to-end recall. |
| Actionable precision | Matched plus extra findings over the judged actionable findings (matched, extra, duplicate and false alarm). Unjudged findings are left out and counted. |
| Precision, macro | The mean precision of the runs with judged findings. |
| F1 | From precision and end-to-end recall. |
| False alarms per clean PR | False alarms on the controls a run reviewed, per reviewed control. |
| False alarms, comments and duplicates per PR | Per reviewed run (completed or partial). |
| Severity agreement | Matched findings whose severity equals the label's. |
| Location validity | Matched findings that cite one of the defect's locations or alternatives, within the slack (3 lines). |
| Anchored | Posted findings placed on a diff line rather than only in the summary. |
| Valid suggestions | Valid over rated suggestions. |
| Spend | Reported cost, uncertain cost (reservations kept in full when usage is missing), runs missing usage, and runs not admitted by the ledger. |

A rate with nothing to count is shown as n/a with its counts, never as 1. For
example, a control with no findings has no precision. Missing usage is never
zero spend. Proportions use Wilson score intervals and per-PR rates use exact
Poisson intervals. The recall difference on paired cases uses Newcombe's
interval for paired proportions. Precision's interval treats findings as
independent, though findings in one pull request are not. A human reviewing a
borderline result should keep that in mind.

## The release gate (D2)

The default gate is the owner's approved D2, in `DEFAULT_GATE`. Print it with
`report.ts --print-gate`, and give an edited copy with `--gate`. A gate file
records who approved its thresholds and when.

| Rule | Threshold | Decided on |
| --- | --- | --- |
| Trust or consent checks failed | 0 | Observed in the candidate's reviewed runs |
| Unaccounted paid attempts | 0 | Observed: runs or judge calls the ledger did not admit, and attempts left open in it |
| Coverage | at least 95% | Observed |
| Actionable precision | at least 80% | Interval |
| False alarms per clean PR | at most 0.2 | Interval |
| Recall below the frozen pipeline on paired cases | at most 5 points | Interval |

An observed rule passes or fails on its value. An interval rule passes only
when its whole interval is on the passing side, and fails only when its whole
interval is on the failing side. Otherwise it goes to **human review**. It also
goes to review while any finding it depends on is unjudged, or when there is
nothing to measure: no clean change, no frozen pipeline or no paired defect.
The gate fails if any rule fails. Otherwise it needs review if any rule does,
and passes only if every rule passes. Small samples will often need review.
That calls for more data, not weaker thresholds.

These choices are this build's reading of D2, and are recorded in
`docs/vector/build/vectorscope-deviations.md`:

- The gate counts **posted** findings, at **95%** confidence, without nits.
- It applies to one candidate variant and model, compared with a named frozen
  pipeline (`--candidate`, `--baseline`).
- Paired recall pairs each labelled defect by case and repetition.

A result is a **release decision** only when all of these hold:

- It is a held-out run on a frozen manifest.
- It was collected on or after the gate's approval date.
- The report lists no input or judging problems.
- The gate is no weaker than the approved D2: no looser threshold, no lower
  confidence and no other decision split. A changed gate also needs its own
  decision name; a copy that differs from D2 cannot call itself D2.

Anything else is reported, but it is not a release decision.

## Workflow

```
# 1. Each judge gets a blinded worksheet of what they have not judged yet.
bun script/vectorscope-eval/judge.ts tasks --outputs <dir> --judgements <file> --judge human:<name> --worksheet <sheet>
# 2. They fill each finding's "answer", and their passes are recorded.
bun script/vectorscope-eval/judge.ts import --outputs <dir> --judgements <file> --judge human:<name> --worksheet <sheet>
# 3. Disagreements go to the owner, blinded.
bun script/vectorscope-eval/judge.ts disputes --outputs <dir> --judgements <file> --worksheet <sheet>
bun script/vectorscope-eval/judge.ts adjudicate --outputs <dir> --judgements <file> --worksheet <sheet> --by human:owner --date <YYYY-MM-DD>
# 4. The report, offline, as often as needed.
bun script/vectorscope-eval/report.ts --outputs <dir> --judgements <file> --candidate <variant>=<model> --baseline <variant>=<model>
```

The judgement file, the worksheets and `--out` reports must be outside the
repository. The judgement file holds the blinding seed and the model names, so
it stays with the coordinator and never goes to a judge.
