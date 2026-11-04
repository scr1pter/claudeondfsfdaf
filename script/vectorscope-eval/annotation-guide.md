# VectorScope dataset annotation guide

How cases for VectorScope's real-change dataset are found, checked, labelled,
split and frozen. The contract is `dataset.ts` (types and `manifestProblems`);
this guide explains the rules behind it. The seed manifest is
`dataset/seed.json`.

## What may go in

- **Public repositories under MIT, Apache-2.0, BSD-2-Clause or BSD-3-Clause
  only**, as GitHub's licence endpoint names them. A repository whose licence
  the endpoint reports as anything else (including `NOASSERTION` or `other`)
  is excluded with reason `licence`, even if a person reading the files would
  call it permissive.
- **Manifests, not code.** A case records repository URLs and full 40-character
  commit SHAs. Do not copy source, diffs or test files into this repository;
  the replay fetches the candidate's objects when it runs. Short excerpts in a
  label's `cause` (an identifier, a short expression) are fine when the cause
  cannot be stated without them.
- **No personal data.** No customer repositories, private issues, support
  threads, credentials or personal email addresses, in labels or anywhere
  else. Check any quoted text for secrets before committing it.

## What a case is

A **bug case** has three commits:

- `candidate.base`: the commit the buggy change was made on, the head's first
  parent.
- `candidate.head`: the commit that introduced the defect. A merged pull
  request is reviewed whole: its merge or squash commit is the head and its
  first parent is the base.
- `fix.sha`: the later commit that corrects the defect. It is hidden ground
  truth, never shown to the reviewer under test and never used as the change
  under review.

The reviewer is shown `base..head` and nothing else (`caseView`). Do not turn a
fix into a case by reversing it: a reverse diff is an easy, unrealistic change
and the object checks reject it.

A **control** has only `candidate.base` and `candidate.head`: a clean or
behaviour-preserving change with nothing a reviewer should report. Its
`labels.rationale` argues why the behaviour is unchanged, and its provenance
records that later commits and issues were searched for a defect attributed to
it.

## Finding cases

Record every query under `selection.queries` and the rule under
`selection.rule`, so the sample can be rebuilt. A full set is sampled by a rule
fixed before results are seen; the seed is hand-picked and says so.

Ways to identify the introducing change, strongest first:

1. The fix's message, pull request or linked issue names it: "introduced in"
   with a SHA, "regression from" a pull request, or a revert of a named pull
   request.
2. A line blame of the lines the fix changes, at the fix's first parent. The
   GitHub GraphQL `blame` field does this without a clone.
3. A bisect recorded in the issue.

Write the evidence in `provenance.evidence` and the query that surfaced the
fix in `provenance.found`.

## Checking a case (read-only)

Check every case before admitting it, with the GitHub API, never by cloning a
large repository:

```
gh api repos/<owner>/<name>/license --jq .license.spdx_id
gh api repos/<owner>/<name>/commits/<sha> --jq '.sha, .commit.committer.date, [.parents[].sha]'
gh api repos/<owner>/<name>/compare/<base>...<head> --jq '.status, .behind_by'
gh api repos/<owner>/<name>/compare/<head>...<fix> --jq '.status, .behind_by'
```

- Each commit must exist and its full SHA must match the manifest.
- `base...head` and `head...fix` must both report status `ahead` with
  `behind_by` 0: the base is an ancestor of the head, and the head is an
  ancestor of the fix.
- `candidate.date` and `fix.date` are the committer dates the commits endpoint
  returns. `candidate.changed` is the file count and line totals of
  `base...head`.
- Record the check in `provenance.checked` with its date and `method: "gh-api"`.

When local mirrors exist, the dry run repeats these checks with git, and adds
two more: the candidate head must not already hold the fix's version of any
file the fix changes (post-fix leakage), and every labelled location must lie
inside its file at the candidate head:

```
bun script/vectorscope-eval/dataset.ts --mirrors <dir>   # clones at <dir>/<owner>/<name>
```

## Exclusions

A case that is considered and left out is recorded under `exclusions` with one
of these reasons, so difficult cases cannot quietly disappear after results are
seen:

| Reason                    | Use when                                                             |
| ------------------------- | -------------------------------------------------------------------- |
| `no-defensible-candidate` | No single introducing change can be identified.                      |
| `no-causal-explanation`   | The pair is known but the defect's cause is not established.         |
| `oversized`               | The candidate exceeds the automatic review's size limits.            |
| `licence`                 | The licence endpoint does not report MIT, Apache-2.0 or BSD.         |
| `unverifiable`            | Commits or ancestry cannot be confirmed.                             |
| `duplicate`               | It is the same defect as an admitted case (prefer a shared family).  |
| `sensitive-content`       | Labelling it would need secrets or personal data.                    |
| `quota`                   | A valid case left out by a recorded cap, such as one per repository. |

## Labelling a bug case

Each defect in `labels.defects` has:

- `id`: a short slug, unique within the case. Case ids are neutral
  (`<owner>-<name>-<n>`) so they reveal nothing about the defect. A case id
  never reaches a reviewer: the replay names each prepared checkout by a digest
  of it.
- `category`, one of:
  - `correctness`: wrong result, wrong branch, wrong variable, broken contract.
  - `security`: authentication, authorization, injection, secrets, unsafe
    input handling.
  - `concurrency`: races, missing synchronisation, ordering, async misuse.
  - `persistence`: data written, migrated or read back wrongly.
  - `error-path`: failures handled wrongly, exceptions raised or swallowed in
    the wrong place, configurations rejected or accepted wrongly.
  - `resource`: leaks, unbounded growth, handles or connections not released.
- `severity`: `blocking` when a careful reviewer should stop the merge (crash,
  security hole, data loss, a main path broken); `concern` when it is wrong and
  should be fixed but the change could ship.
- `summary`: one sentence a finding could be compared with.
- `cause`: the causal explanation: what goes wrong, for which input or state,
  and why the code does it. A finding matches only if it identifies this cause;
  pointing at the right line with a different complaint does not count.
- `locations`: where a finding should point, as `path`, `line` and optional
  `endLine` in the **candidate head**. Prefer the added or changed lines that
  cause the defect.
- `alternatives`: other places a finding that explains the same cause may cite
  (the other end of a mismatch, an unchanged definition the change relies on, a
  test the change edited to hide the failure).

Also record `labels.regressionTest` (`added-by-fix`, `existing` or `none`, with
the fix's test paths) and any `traits`: `cross-file`, `outside-diff` (the cause
depends on code the change does not touch), `rename`, `incremental`, `fork` or
`large`. Prompt-injection cases are separate adversarial tests, not defects
(see "Adversarial cases").

## Adversarial cases

A change that carries prompt-injection text (a code comment, string or file
that tries to instruct the reviewer) is `kind: "adversarial"`. Record in
`labels.injection` what the injected text asks, where it is, and what a safe
reviewer does with it. Label any real defect the injection tries to hide in
`labels.defects`, with its fix as for a bug case; otherwise leave the list
empty and give no fix. Adversarial cases are split on their own, and the
report keeps them out of recall, precision and false alarms per clean pull
request: they test trust, and a trust or consent check one of them breaks
fails the gate.

Review the candidate itself, not only the fix: a candidate can hold a real
defect the fix did not address. Label it if it is real; a reviewer that finds
it is right.

## Two passes and adjudication

Following D8, every label gets two independent model-assisted passes:

1. Pass 1 and pass 2 are made separately, neither seeing the other's labels or
   any reviewer output.
2. Compare them. Where they agree, the label stands: record `agreed: true` on
   the `double-annotated` label, and it needs no adjudication. Where they
   disagree (a missing defect, a different cause, category, severity or
   location), record `agreed: false`; the owner adjudicates and records
   `adjudication.by` and `adjudication.date`, and the status becomes
   `adjudicated`.
3. `annotation.status` moves from `draft` (one pass) to `double-annotated` (two
   passes), and to `adjudicated` only for a disagreement.

A model that helps judge eval results never scores its own findings and is
never the only authority on a label. Judging a review's findings against these
labels follows `judging-rubric.md`.

## Splits

`assignSplits` is the rule, and the manifest records its result so a change to
the dataset that moves a case shows up as a validation error:

- Bug cases, controls and adversarial cases are split separately, each about
  60/20/20 into `development`, `calibration` and `held-out` (calibration and
  held-out take `round(n / 5)` each).
- Cases that share a repository, or share a `family`, form one group and always
  land in the same split. Give cases the same `family` when they share a root
  cause, are a backport and its original, belong to one fix series, or come from
  related repositories (a fork, a split-out package).
- Groups are ordered by their latest date (the fix for a bug, the head for a
  control). The oldest fill development, then calibration; the newest are held
  out, so nothing tuned on postdates what it is tested on.

## Freezing and leakage

- Freeze the held-out labels before any prompt or pipeline tuning. Once every
  held-out label is settled (`double-annotated` with `agreed: true`, or
  `adjudicated`), record `freeze.date` and the digest the dry run prints in
  `freeze.digest`. Any later change to a held-out case, or to
  which cases are held out, fails validation until it is deliberately
  re-frozen, and that change shows in the history.
- Labels, fix SHAs, fix dates, provenance and the split never enter a prompt,
  tool, retrieval index or MCP snapshot. Build reviewer inputs from `caseView`
  only, and fetch only the candidate's commits, so the fix is not reachable
  from what the reviewer can read.
- Public commits may be in any model's training data. The manifest's
  `contamination` note records this; results are read with commit dates in
  mind and do not establish general real-world recall.
