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

A **trivial control** (`kind: "trivial"`) is a control whose change VS-24's
trivial rules cover: whitespace, docs, a rename or comments only (see "Trivial
controls"). Like a control it has no fix and no defects and needs a rationale,
and it names its one kind in `labels.trivialKind`. It is split and reported
apart from the behaviour-preserving controls, and never counts toward false
alarms per clean pull request.

## Finding cases

Record every query under `selection.queries` and the rule under
`selection.rule`, so the sample can be rebuilt. A full set is sampled by a rule
fixed before results are seen; the seed is hand-picked and says so. The
upgrade set's rule is the last section of this guide.

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
| `not-trivial`             | A trivial candidate fails the rules and fits no other stratum.       |
| `mixed-trivial`           | A trivial candidate mixes kinds; `trivialKind` takes one.            |

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
the fix's test paths), the labels below, and any `traits`: `outside-diff` (the
cause depends on code the change does not touch), `rename`, `incremental`,
`fork`, `large`, `trivial-looking` (a bug case whose change looks trivial; see
the sampling rule) or `dependency-bump` (the change only bumps dependency
versions). The `cross-file` trait of schema version 1 is retired for
`labels.crossFile`. Prompt-injection cases are separate adversarial tests, not
defects (see "Adversarial cases").

## Labels added in VS-22a

Schema version 2 adds these labels. Each is optional, and **absent means not
yet labelled**: never read an absent label as `other`, `false` or `none`. The
dry run counts unlabelled fields, and a held-out bug case cannot be frozen
without them (see "Freezing and leakage"). Labels come only from the case's own
evidence: the fix, its pull request and issues, and the code at the candidate
head, never from a reviewer's output.

On each defect:

- `failureClass`: one of `crash`, `data-corruption`, `leak`, `runaway-loop` or
  `auth-bypass`, defined in `judging-rubric.md` ("Failure classes and
  production-breaking"), or `other`. Where the evidence does not establish a
  class's condition (for example that the process exits), the defect is
  `other`.
- `pendingQ4`: only on an `other` defect that an answer to owner question Q4
  would move into a class: `data-exposure` (a secret or private data reaches
  someone it should not, without a bypassed check) or
  `concurrency-wrong-result` (a concurrency defect whose only effect is a
  wrong or stale result; it needs mechanism `concurrency`). The class stays
  `other` until the owner answers, so either answer can be computed from the
  marker without relabelling.
- `mechanism`: how the defect comes about. Take the first that applies, in
  this order:
  1. `concurrency`: it needs an interleaving of threads, tasks or processes.
  2. `access`: the faulty code is part of an authentication, authorization or
     trust check, or of what such a check reads.
  3. `resource`: memory, handles, connections or other use that is not
     released or not bounded.
  4. `logic`: the change's own code does not do what it set out to do.
  5. `regression`: the change does what it intended, but breaks what unchanged
     code, callers, configurations or users rely on.

  `category` is the area of code; `mechanism` is how the defect arises. A
  strict finding's `FailureInfo.mechanism` (VS-27) is compared with this label,
  so VS-27's prompt must state the same definitions and order.

On the case:

- `crossFile`: `true` when explaining a labelled defect's cause needs code in a
  second file, so its locations and alternatives name at least two files other
  than tests (the validator checks this); otherwise `false`. A test the change
  edited to hide the failure is an alternative location, but it does not make
  the defect cross-file, so the validator does not count the fix's
  `regressionTest.paths` or a test-looking path: one under a `test`, `tests`,
  `__tests__` or `spec` directory, `test_<name>`, or a name ending `.test`,
  `_test`, `.spec` or `_spec` before its extension. Only a case with labelled
  defects carries it.
- `runnable`: whether the repository's tests ran at the base commit, read only
  from the base commit's recorded public CI. Never clone and run anything to
  set it (I-13); VS-30's sandbox may confirm it later. Read it with:

  ```
  gh api repos/<owner>/<name>/commits/<base>/check-runs --jq '.check_runs[] | [.name, .status, .conclusion]'
  gh api repos/<owner>/<name>/commits/<base>/status --jq '.statuses[] | [.context, .state]'
  ```

  Take the check or status that runs the test suite, not lint, a build alone
  or a deploy. Map its result:
  - `passed`: conclusion `success`, or state `success`;
  - `failed`: conclusion `failure` or `timed_out`, or state `failure`;
  - `none`: conclusion `cancelled`, `skipped`, `neutral`, `action_required`,
    `stale` or `startup_failure`; state `error` or `pending`; or no test check
    at all.

  Record the test check's name in `check` (required for `passed` and
  `failed`), the API URL you read in `evidence`, the day you read it in
  `date`, and for `none` a `note` saying why no test run counts ("no test
  check is recorded", "the test check was cancelled"). The validator requires
  `evidence` to be
  `https://api.github.com/repos/<owner>/<name>/commits/<base>/check-runs` or
  `.../status` for the case's own repository and `candidate.base`, with any
  query, so the head's or the fix's CI is refused. An old status that
  links to a host that is gone is still a recorded result. VS-22b's
  "runnable" target counts `passed` only, since a defect can be confirmed at
  runtime only against a suite that passes at the base; the dry run shows
  every status.

- `authoring`: the model lab that wrote the change, when a commit trailer or a
  bot account declares one: `lab` (a lab id as codium's `labOf` names them,
  such as `anthropic` or `openai`; checked against that list once codium
  merges, with no mapping written here), `source` (`commit-trailer`,
  `bot-account` or `synthetic`) and the `evidence`. It is self-declared
  evidence, used only to stratify the dataset: never PR title, body or branch
  text, and never VS-29b's trusted authorship or any invocation field (I-2).
  No synthetic case is admitted until owner question Q12 is answered. Absent
  means no authorship was recorded, never "human".

When labels are added to an existing pass, add a pass entry with the same pass
number and its own method and date, and record the labels it gave in that
entry's `labels` (see "Two passes and adjudication"). Say in the method what
it did not examine.

## Trivial controls

A trivial control's change is trivial under VS-24's rules, which the contract
states in `docs/vector/build/vectorscope-upgrade.md` §4 VS-24, Implementation
items 1 and 2. They are copied here; where the two differ, the contract wins.

> A change is trivial only if every file is one of:
>
> - **whitespace-only:** trailing whitespace, line endings or blank lines only,
>   outside string literals (by parser tokens), and never in an
>   indentation-sensitive file (Python, Makefile, YAML, CoffeeScript, Haskell
>   and similar);
> - **docs-only:** an allowlist of `.md`, `.rst` and `.adoc`, excluding
>   agent-instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, Copilot
>   instructions), `.vector/**` and `.github/**`. Never `.txt` or `.mdx`, which
>   `DOC_EXTENSIONS` includes (`ignore.ts:109`); `isSensitivePath` returns false
>   for every doc extension (`ignore.ts:133`), so it does not protect
>   `requirements.txt`, `CMakeLists.txt` or executable MDX;
> - **rename-only:** a non-code file, or a code file whose old path a `git grep`
>   of the head tree-ish no longer finds and whose rename leaves test globs and
>   migration order unaffected; never a case-only rename;
> - **comment-only:** only with VS-25's parser comment ranges, minus a denylist
>   of directives and doctests: `@ts-ignore`, `@ts-expect-error`, `@ts-check`,
>   `@ts-nocheck`, `eslint-disable*`, `prettier-ignore`, `//go:build`,
>   `// +build`, `//go:generate`, `//go:embed`, `# type: ignore`, `# noqa`,
>   `# pragma`, Rust `///` and `//!` doctests, Python doctests, shebang and
>   encoding lines, and licence headers.
>
> **Never trivial:**
>
> - anything `isSensitivePath` matches (`ignore.ts:84-142`);
> - CI and workflow files; Dockerfiles; infrastructure-as-code;
> - dependency manifests and lockfiles (Q11);
> - JSON, YAML, TOML and INI config;
> - SQL and migrations.

For a dataset case:

- **One kind per case.** `trivialKind` takes one value, so every file of the
  change must be of that one kind. A trivial candidate that mixes kinds is
  recorded as an exclusion with reason `mixed-trivial`, so it can be admitted
  if the label later takes a list.
- **The rename check is read-only:** `git grep` of the old path in the head
  tree-ish of a local mirror (never a checkout), and the test globs and
  migration order read from the repository's config. Record what was checked
  in the rationale.
- **The rationale** says which rule each file meets.
- **A candidate that fails the rules** is first considered for the
  behaviour-preserving control stratum, or for the trivial-looking bug stratum
  if a later fix attributes a defect to it. Only when it fits neither is it
  excluded as `not-trivial` (or `quota` when that stratum is full).
- **Dependency bumps** are never trivial while Q11 is open. One that preserves
  behaviour is admitted as a `control` with a rationale and the
  `dependency-bump` trait, so it can be reclassified, not found again, if the
  owner puts bumps in the trivial skip.

## Adversarial cases

A change that carries prompt-injection text (a code comment, string or file
that tries to instruct the reviewer) is `kind: "adversarial"`. Record in
`labels.injection` what the injected text asks, where it is, and what a safe
reviewer does with it. Label any real defect the injection tries to hide in
`labels.defects`, with its fix as for a bug case, and give it the VS-22a
labels like a bug case's; otherwise leave the list empty and give no fix.
Adversarial cases are split on their own, and the report keeps them out of
recall, precision and false alarms per clean pull request: they test trust,
and a trust or consent check one of them breaks fails the gate.

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
4. Each pass records the VS-22a labels it gave in its own entry's `labels`:
   `defects` (each by the case's defect id, with the `failureClass`,
   `mechanism` and any `pendingQ4` it gave; a defect the pass did not label is
   left out; one it proposed that the case's labels do not keep is described
   in the adjudication note) and `crossFile`. A pass entry records them at
   most once. Once any pass of a `double-annotated` or `adjudicated` case
   records them, two passes must, so the passes can be compared and Cohen's
   kappa on `failureClass` reported (VS-22b). A label with `agreed: true` must
   have passes whose own labels are the case's.

A model that helps judge eval results never scores its own findings and is
never the only authority on a label. Judging a review's findings against these
labels follows `judging-rubric.md`.

## Splits

`assignSplits` is the rule, and the manifest records its result so a change to
the dataset that moves a case shows up as a validation error:

- Bug cases, controls, trivial controls and adversarial cases are split
  separately, each about 60/20/20 into `development`, `calibration` and
  `held-out` (calibration and held-out take `round(n / 5)` each).
- Cases of one kind that share a repository, or share a `family`, form one
  group and always land in the same split. Grouping is within a kind, so a
  repository's cases must all be of one kind: the validator refuses a
  repository whose cases span kinds, and one that supplies more than two
  (`PER_REPOSITORY`, the sampling rule's cap). Give cases the same
  `family` when they share a root cause, are a backport and its original,
  belong to one fix series, or come from related repositories (a fork, a
  split-out package).
- Groups are ordered by their latest date (the fix for a bug, the head for a
  control). The oldest fill development, then calibration; the newest are held
  out, so nothing tuned on postdates what it is tested on.

## Freezing and leakage

- Freeze the held-out labels before any prompt or pipeline tuning. Once every
  held-out label is settled (`double-annotated` with `agreed: true`, or
  `adjudicated`), record `freeze.date` and the digest the dry run prints in
  `freeze.digest`. A held-out bug case also needs every VS-22a label that
  cannot be added later without a new freeze: `failureClass` and `mechanism`
  on every defect, `crossFile`, `runnable`, and two passes' own labels. Any
  later change to a held-out case, or to which cases are held out, fails
  validation until it is deliberately re-frozen, and that change shows in the
  history.
- Labels, fix SHAs, fix dates, provenance and the split never enter a prompt,
  tool, retrieval index or MCP snapshot. Build reviewer inputs from `caseView`
  only, and fetch only the candidate's commits, so the fix is not reachable
  from what the reviewer can read.
- Public commits may be in any model's training data. The manifest's
  `contamination` note records this; results are read with commit dates in
  mind and do not establish general real-world recall.

## Sampling rule for the upgrade set (VS-22b), fixed 2026-11-06

Fixed before any VS-22b candidate was examined and before any result. A change
to it is a dated entry in `docs/vector/build/vectorscope-deviations.md` and
applies only to candidates not yet examined.

1. **The manifest.** VS-22b writes a new manifest, `dataset/upgrade.json`. It
   starts from the seed's ten cases and five exclusions, carried over with
   their ids, so one split runs over the whole set and no repository has
   cases in two manifests. Its `selection.rule` holds this rule verbatim, and
   `selection.queries` and `selection.date` are filled before the first
   candidate is examined. Its `selection.method` says the first ten cases
   were hand-picked. `seed.json` stays as it is, the replay's default, until
   the new manifest is frozen. Splits are recomputed over the whole set, so a
   seed case may change split; none is frozen.
2. **Strata and targets** (`TARGETS` in `dataset.ts`, reported by the dry run
   and not enforced): at least 100 bug cases, with at least 12 in each failure
   class, at least 30 cross-file and at least 15 `runnable` (passed); at least
   25 behaviour-preserving controls; at least 20 trivial controls; at least 10
   adversarial cases, including PR text that claims an authoring model or asks
   for a reviewer; and trivial-looking bug cases, at least one each of a
   comment directive, a Python indentation change and a rename that breaks an
   import, plus, when found, an `.mdx` component, a `requirements.txt` bump
   and a case-only rename (VS-24's fixtures). Trivial-looking bug cases carry
   the `trivial-looking` trait.
3. **Population.** Public GitHub repositories whose licence endpoint reports
   MIT, Apache-2.0, BSD-2-Clause or BSD-3-Clause. At most two cases per
   repository, counting the seed (the seed's own rule was one), and the cases
   one repository supplies are of one kind, since splits group by repository
   within a kind only. `manifestProblems` enforces both (`PER_REPOSITORY`); a
   case past the cap is excluded as `quota`. At least five languages.
4. **Order.** Each stratum's queries are recorded verbatim in
   `selection.queries` with the day they ran. Candidates are examined in the
   order the search returns them, newest committer date first.
5. **Every examined candidate** is admitted or recorded as an exclusion with
   its reason. Once a stratum reaches its target its queries stop, and a later
   candidate that would only add to a full stratum is excluded as `quota`.
6. **Admission** follows the seed's rule (the candidate head is an ancestor of
   the fix, the cause is established, the base is the head's first parent),
   the size limit (`oversized`) and, for trivial controls, the trivial rules
   above: a candidate that fails them goes to another stratum it fits before
   it is excluded as `not-trivial`, and one that mixes trivial kinds is
   excluded as `mixed-trivial`.
7. **Labels** come only from the fix, its pull request and issues, and the code
   at the candidate head, never from reviewer output. Pass 2 is made blind to
   pass 1, both record their own labels, and Cohen's kappa between them on
   `failureClass` is reported.
8. **Order of work:** the rule, candidates, labels, both passes, the owner's
   adjudication, the split, the held-out freeze with its digest, and only then
   any VS-24 to VS-30 prompt tuning. A held-out case is never replaced.
