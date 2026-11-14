# VectorScope judging rubric: proposed importance axis

**Status: a proposal, not the current rubric.** VS-45 (addendum A, §2) asks
for a rubric revision with an importance axis. Whether to adopt it is owner
question Q29, and the addendum's packages wait for Q18. Until the owner
decides, `judging-rubric.md` is the rubric, `RUBRIC_VERSION` stays 1, and this
file is used only when a coordinator asks for it with `--proposal importance`.

The proposal's identity is `vs45-importance-1` (`IMPORTANCE_PROPOSAL` in
`packages/core/src/review/eval.ts`). It is a name, never a rubric version, and
it changes whenever this file changes. Every pass, adjudication, worksheet and
judgement file made under it records that name beside rubric 1, whose verdict
rules it follows. So:

- a pass made under the proposal never counts under the current rubric, and a
  pass made under the current rubric never counts under the proposal;
- a pass made under an earlier revision of the proposal is stale under the
  current one;
- adopting the axis (VS-45b, on Q29 "yes") sets a new `RUBRIC_VERSION`, under
  which every proposal pass is stale whatever number it carries. Adopting it
  means judging again under the adopted rubric, before the held-out freeze
  (I-13).

## What a judge adds

Every verdict is given exactly as in `judging-rubric.md`. Each `match` and
each `extra` also gets an **importance**, judged from the code. A
`false-alarm` has none.

| Importance    | When                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `would-block` | A careful reviewer should stop the merge for it: a crash, a security hole, data loss, a main path broken. This is the annotation guide's `blocking` wording. |
| `should-fix`  | It is wrong and should be fixed, but the change could ship. The guide's `concern` wording.                                                                   |
| `minor`       | It is real, but fixing it is optional: low impact, or only a rare path.                                                                                      |

- **No severity is shown.** Under the proposal a task leaves out both the
  severity each finding was posted with and the severity of each labelled
  defect, so neither the reviewer's claim nor the label anchors the
  importance. A match is rated on what the defect does, like an extra. Words in
  a finding's title or body that state a severity cannot be hidden.
- **Disagreeing with a label.** If a match's importance differs from what its
  label's severity says, record the importance you judge, and tell the
  annotators. Labels change only through their own passes.
- **Nits.** D2's gate does not count nits, so nit findings are not judged and
  the nit share stays empty. Rating the importance of minor findings needs
  `--nits` and a gate that counts them, which is never a release decision.
- **Contamination.** The same humans judging the same findings under both
  rubrics see each finding's severity in their current-rubric worksheets. Use
  different judges for the proposal where possible, or judge the proposal
  before the current rubric.

## Settlement

- The **verdict** settles exactly as in `judging-rubric.md`: two counted
  passes with a human among them that agree, or a human adjudication.
- The **importance** settles apart from it: the adjudication's, or the one
  every counted pass gives. An agreed verdict whose passes give different
  importances is an **importance dispute**: its verdict counts for recall and
  precision, its importance stays unsettled, and `judge.ts disputes` lists it
  with each pass's importance for the owner to adjudicate. An adjudication
  under the proposal must give an importance on a match or an extra.
- **What it costs.** The proposal cannot reuse the current rubric's passes, so
  adopting or trying it repeats the whole judging: two passes per finding, and
  both verdict and importance disputes adjudicated. Keeping importance apart
  from the verdict only keeps the adjudication within the proposal to the
  findings that are disputed.

## Metrics

Added to the report under `--proposal importance`, at both stages:

| Metric                                    | Definition                                                                                                                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Important precision                       | Real findings with a settled importance of `would-block` or `should-fix`, over the judged findings (duplicates and false alarms in the denominator), leaving out real findings whose importance is not settled, which are counted. |
| Precision@blocking (real and would-block) | Real and `would-block` findings posted as blocking, over every judged finding posted as blocking; a real one whose importance is not settled counts as not `would-block`. This is the addendum's precision@blocking.               |
| Precision@blocking, unsettled left out    | The same with real findings whose importance is not settled left out of the denominator: the gradient's blocking step. While an importance dispute is open it reads higher than the row above.                                     |
| Would-block share by posted severity      | The same share for each posted severity, with the gradient below.                                                                                                                                                                  |
| Importance agreement                      | Fleiss' kappa over each finding's first two counted real verdicts, over every finding and over matches and extras apart.                                                                                                           |

**The gradient** (`severityGradient`, shared with VS-46). Each step runs from
one posted severity to the next lower one that has findings. A step **falls**
when its interval (Newcombe's hybrid score interval for two independent
proportions) is above 0, is **inverted** when it is below 0, is **flat** when
the interval rules out a fall of 10 points or more, and is **inconclusive**
otherwise, so a small sample reads as no evidence rather than as
miscalibration. The gradient is inverted if any step is, else flat, else
inconclusive, else falling. It is **flagged** when flat or inverted.

**Agreement and the kill rule.** Per finding, the passes that count (this
proposal's, not stale, not the reviewer's own model) are taken once per judge
at its latest pass, in the order the judges first judged it, and the first two
that give a match or an extra are its ratings. A finding is in the match part
when both are matches, and in the extra part otherwise. Fleiss' form is used,
not Cohen's, because the two judges differ from finding to finding and their
order is arbitrary. The kill rule is VS-45's, over every double-judged
finding, and is also applied to each part with its own minimum:

- **drop** when every finding together, or either part, has at least 100
  double-judged findings and a kappa below 0.4. The report then leaves the
  importance rows out and keeps precision@blocking on real findings only;
- **too-few** while any of the three has fewer than 100, and **undefined**
  when one's ratings all have one value;
- **keep** only when both parts have at least 100 and all three have a kappa
  of at least 0.4.

Only the findings the importance metrics count are in it: a finding of an
adversarial case is not, and a re-selected copy (`--reselect strict`) carries
its original's judgements, so each judgement counts once.

Until the decision is keep, every importance row is labelled unvalidated with
how many double-judged matches and extras it has. The precision@blocking
monitor against `engine:shared-verify` uses the would-block basis only once the
decision is keep, and real findings otherwise; either way its denominator is
every judged blocking finding, as for precision@blocking.

## Never a release decision

A report judged under the proposal lists "judged under a proposed rubric" as a
reason it is not a release decision, whatever the gate outcome, so
`certify.ts` can never certify from it. D2's thresholds and `DEFAULT_GATE` are
unchanged.

## Workflow

The proposal needs a judgement file of its own. Every command takes
`--proposal importance`, and a file, worksheet or report under the other
rubric is refused.

```
bun script/vectorscope-eval/judge.ts tasks --outputs <dir> --judgements <importance-file> --judge human:<name> --worksheet <sheet> --proposal importance
bun script/vectorscope-eval/judge.ts import --outputs <dir> --judgements <importance-file> --judge human:<name> --worksheet <sheet> --proposal importance
bun script/vectorscope-eval/judge.ts disputes --outputs <dir> --judgements <importance-file> --worksheet <sheet> --proposal importance
bun script/vectorscope-eval/judge.ts adjudicate --outputs <dir> --judgements <importance-file> --worksheet <sheet> --by human:owner --date <YYYY-MM-DD> --proposal importance
bun script/vectorscope-eval/report.ts --outputs <dir> --judgements <importance-file> --proposal importance
```

No model judge is wired to a provider (D5, D12), so there is no model prompt
for importance.
