import { describe, expect, test } from "bun:test"
import { decideSkip, type SkipInput, type SkipReason } from "@vectordevai/core/review/skip"
import {
  DEFAULT_REVIEW_CONFIG,
  type Finding,
  type PlacedFinding,
  type PriorFinding,
  type ReviewOutcome,
  type ReviewState,
  type Selection,
  type Severity,
  type SkippedFile,
} from "@vectordevai/core/review/types"
import {
  REVIEW_VERDICTS,
  reviewVerdict,
  type ReviewVerdict,
  type VerdictInput,
  type VerdictOutcome,
  type VerdictResult,
  type VerdictSkip,
} from "@vectordevai/core/review/verdict"

// VS-32a (addendum A, Now window): the pure verdict over synthetic outcomes. Nothing calls reviewVerdict yet, so these
// pin its mapping; the GitHub job's own exit paths are tested when it is wired, after vector-at-mention.

const HEAD = "d4e5f6a" + "0".repeat(33)
const OLDER = "a1b2c3d" + "0".repeat(33)
const SEVERITY_LISTS = ["inline", "overflow", "outsideDiff", "elsewhere", "nits", "stillOpen"] as const
const PASSING: readonly ReviewVerdict[] = ["policy-skip", "findings", "clean-complete"]
const FAILING: readonly ReviewVerdict[] = ["not-reviewed", "incomplete", "blocking"]

function finding(severity: Severity): Finding {
  return {
    id: "3f9a1c07be21",
    path: "src/auth/refresh.ts",
    line: 52,
    side: "RIGHT",
    severity,
    category: "bug",
    title: "Refresh can restore a session after logout",
    body: "",
    confidence: 0.86,
    source: "review",
  }
}

function placed(severity: Severity): PlacedFinding {
  return {
    ...finding(severity),
    anchor: { path: "src/auth/refresh.ts", side: "RIGHT", line: 52, hunk: 0 },
    suggestionAllowed: false,
  }
}

function prior(severity: Severity): PriorFinding {
  return {
    id: "8be0a2d4c917",
    where: "inline",
    path: "src/auth/refresh.ts",
    line: 40,
    side: "RIGHT",
    severity,
    category: "bug",
    title: "An earlier finding",
    sha: "a1b2c3d",
    status: "open",
  }
}

// One finding of the given severity in the named list, typed as that list holds it.
function listed(list: (typeof SEVERITY_LISTS)[number], severity: Severity): Partial<Selection> {
  if (list === "inline") return { inline: [placed(severity)] }
  if (list === "outsideDiff") return { outsideDiff: [{ ...finding(severity), reason: "line-outside-diff" }] }
  if (list === "stillOpen") return { stillOpen: [prior(severity)] }
  if (list === "overflow") return { overflow: [finding(severity)] }
  if (list === "elsewhere") return { elsewhere: [finding(severity)] }
  return { nits: [finding(severity)] }
}

function selection(overrides: Partial<Selection> = {}): Selection {
  return {
    inline: [],
    outsideDiff: [],
    elsewhere: [],
    nits: [],
    overflow: [],
    stillOpen: [],
    fixed: [],
    dismissed: [],
    reappeared: [],
    raised: [],
    dropped: [],
    risk: "low",
    ...overrides,
  }
}

// A full ReviewOutcome: passing it to reviewVerdict as it is shows ReviewOutcome is assignable to VerdictOutcome.
function outcome(overrides: Partial<ReviewOutcome> = {}): ReviewOutcome {
  return {
    report: { summary: "", risk: "low", files: [], findings: [] },
    selection: selection(),
    skipped: [],
    durationMs: 1_000,
    base: OLDER,
    head: HEAD,
    mode: "full",
    unreviewed: [],
    specialists: [{ name: "review", status: "ok", steps: 4 }],
    sessions: ["ses_1"],
    stats: { files: 2, additions: 10, deletions: 2 },
    notes: [],
    ...overrides,
  }
}

const judge = (value: VerdictOutcome) => reviewVerdict({ kind: "outcome", outcome: value })
const verdict = (value: ReviewVerdict, causes: VerdictResult["causes"] = [], notes: VerdictResult["notes"] = []) => ({
  verdict: value,
  causes,
  notes,
})

describe("reviewVerdict over outcomes", () => {
  test("the verdicts, in the order they are tested", () => {
    expect(REVIEW_VERDICTS).toEqual([
      "not-reviewed",
      "policy-skip",
      "incomplete",
      "blocking",
      "findings",
      "clean-complete",
    ])
  })

  test("a complete run with nothing listed is clean-complete", () => {
    expect(judge(outcome())).toEqual(verdict("clean-complete"))
    // Fixed, dismissed and dropped findings are not listed.
    expect(
      judge(
        outcome({
          selection: selection({
            fixed: [prior("blocking")],
            dismissed: [prior("blocking")],
            dropped: [{ reason: "low-confidence", count: 3 }],
          }),
        }),
      ),
    ).toEqual(verdict("clean-complete"))
  })

  test("a concern or a nit in any listed selection is findings", () => {
    for (const list of SEVERITY_LISTS)
      for (const severity of ["concern", "nit"] as const)
        expect(judge(outcome({ selection: selection(listed(list, severity)) }))).toEqual(
          verdict("findings", ["findings"]),
        )
  })

  test("a blocking finding in any listed selection is blocking, an earlier open one included", () => {
    // nits never holds a blocking finding (select.ts), but the verdict reads it as the others are read.
    for (const list of SEVERITY_LISTS)
      expect(judge(outcome({ selection: selection(listed(list, "blocking")) }))).toEqual(
        verdict("blocking", ["blocking"]),
      )
    expect(
      judge(
        outcome({
          selection: selection({
            inline: [placed("concern"), placed("blocking")],
            nits: [finding("nit")],
            stillOpen: [prior("concern")],
          }),
        }),
      ),
    ).toEqual(verdict("blocking", ["blocking"]))
  })

  test("every partial value", () => {
    const expected: Record<NonNullable<VerdictOutcome["partial"]>, ReviewVerdict> = {
      budget: "incomplete",
      steps: "incomplete",
      timeout: "incomplete",
      "model-error": "incomplete",
      privacy: "not-reviewed",
      "budget-estimate": "not-reviewed",
    }
    const partials: NonNullable<VerdictOutcome["partial"]>[] = [
      "budget",
      "steps",
      "timeout",
      "model-error",
      "privacy",
      "budget-estimate",
    ]
    expect(Object.keys(expected).toSorted()).toEqual(partials.toSorted())
    for (const partial of partials)
      expect(judge({ ...outcome(), partial })).toEqual(verdict(expected[partial], [partial]))
    // The two zero-attempt stops read as not reviewed whatever else the outcome holds.
    for (const partial of ["privacy", "budget-estimate"] as const)
      expect(
        judge({
          ...outcome({
            unreviewed: ["src/a.ts", "src/b.ts"],
            specialists: [{ name: "review", status: "failed", steps: 0 }],
            selection: selection({ stillOpen: [prior("blocking")] }),
          }),
          partial,
        }),
      ).toEqual(verdict("not-reviewed", [partial]))
  })

  test("precedence: a stop over unfinished, unfinished over blocking, blocking over findings", () => {
    expect(
      judge({
        ...outcome({ unreviewed: ["src/a.ts"], specialists: [{ name: "security", status: "failed", steps: 1 }] }),
        partial: "privacy",
      }),
    ).toEqual(verdict("not-reviewed", ["privacy"]))
    expect(judge(outcome({ partial: "timeout", selection: selection({ inline: [placed("blocking")] }) }))).toEqual(
      verdict("incomplete", ["timeout"]),
    )
    expect(
      judge(outcome({ selection: selection({ inline: [placed("blocking")], elsewhere: [finding("concern")] }) })),
    ).toEqual(verdict("blocking", ["blocking"]))
  })

  test("unreviewed files leave the review incomplete", () => {
    expect(judge(outcome({ unreviewed: ["src/a.ts"] }))).toEqual(verdict("incomplete", ["unreviewed"]))
    expect(judge(outcome({ unreviewed: [] }))).toEqual(verdict("clean-complete"))
  })

  test("every skipped-file reason", () => {
    const expected: Record<SkippedFile["reason"], VerdictResult> = {
      ignored: verdict("clean-complete"),
      lockfile: verdict("clean-complete"),
      generated: verdict("clean-complete"),
      vendored: verdict("clean-complete"),
      "build-output": verdict("clean-complete"),
      binary: verdict("clean-complete"),
      deleted: verdict("clean-complete"),
      "size-limit": verdict("incomplete", ["size-limit"]),
    }
    const reasons: SkippedFile["reason"][] = [
      "ignored",
      "lockfile",
      "generated",
      "vendored",
      "build-output",
      "binary",
      "deleted",
      "size-limit",
    ]
    expect(Object.keys(expected).toSorted()).toEqual(reasons.toSorted())
    for (const reason of reasons) expect(judge(outcome({ skipped: [{ path: "x", reason }] }))).toEqual(expected[reason])
    // One cause however many files share the reason.
    expect(
      judge(
        outcome({
          skipped: [
            { path: "a", reason: "size-limit" },
            { path: "b", reason: "lockfile" },
            { path: "c", reason: "size-limit" },
          ],
        }),
      ),
    ).toEqual(verdict("incomplete", ["size-limit"]))
  })

  test("held-back files: a held change is incomplete, a held deletion only adds a note", () => {
    for (const status of ["added", "modified", "renamed"] as const)
      expect(judge({ ...outcome(), held: [{ status }] })).toEqual(verdict("incomplete", ["held-back"]))
    expect(judge({ ...outcome(), held: [{ status: "deleted" }] })).toEqual(
      verdict("clean-complete", [], ["held-back-deletion"]),
    )
    expect(judge({ ...outcome(), held: [{ status: "deleted" }, { status: "modified" }] })).toEqual(
      verdict("incomplete", ["held-back"], ["held-back-deletion"]),
    )
    expect(
      judge({
        ...outcome({ selection: selection({ inline: [placed("blocking")] }) }),
        held: [{ status: "deleted" }],
      }),
    ).toEqual(verdict("blocking", ["blocking"], ["held-back-deletion"]))
    // The note stays on every tier.
    expect(judge({ ...outcome(), partial: "privacy", held: [{ status: "deleted" }] })).toEqual(
      verdict("not-reviewed", ["privacy"], ["held-back-deletion"]),
    )
    expect(judge({ ...outcome(), held: [] })).toEqual(verdict("clean-complete"))
  })

  test("a strict result that is not complete leaves the review incomplete", () => {
    expect(judge({ ...outcome(), strict: { complete: false } })).toEqual(verdict("incomplete", ["strict-incomplete"]))
    expect(judge({ ...outcome(), strict: { complete: true } })).toEqual(verdict("clean-complete"))
    expect(judge(outcome())).toEqual(verdict("clean-complete"))
  })

  test("a specialist that did not finish leaves the review incomplete, verify included", () => {
    for (const status of ["failed", "timeout", "stopped", "skipped"] as const) {
      expect(judge(outcome({ specialists: [{ name: "review", status, steps: 2 }] }))).toEqual(
        verdict("incomplete", ["specialist"]),
      )
      for (const name of ["security", "verify"] as const)
        expect(
          judge(
            outcome({
              specialists: [
                { name: "review", status: "ok", steps: 4 },
                { name, status, steps: 2 },
              ],
            }),
          ),
        ).toEqual(verdict("incomplete", ["specialist"]))
    }
    // Review.run builds `partial` from the reviewer passes only, so a verify pass stopped or skipped for time posts
    // findings with no partial value; only its status shows the review did not finish.
    for (const status of ["stopped", "skipped"] as const)
      expect(
        judge(
          outcome({
            specialists: [
              { name: "review", status: "ok", steps: 4 },
              { name: "verify", status, steps: 1 },
            ],
            selection: selection({ inline: [placed("concern")] }),
          }),
        ),
      ).toEqual(verdict("incomplete", ["specialist"]))
  })

  test("an outcome with no review or security pass leaves the review incomplete", () => {
    expect(judge(outcome({ specialists: [{ name: "verify", status: "ok", steps: 1 }] }))).toEqual(
      verdict("incomplete", ["no-reviewer"]),
    )
    expect(judge(outcome({ specialists: [{ name: "verify", status: "failed", steps: 1 }] }))).toEqual(
      verdict("incomplete", ["specialist", "no-reviewer"]),
    )
    expect(judge(outcome({ specialists: [] }))).toEqual(verdict("incomplete", ["no-reviewer"]))
    expect(judge(outcome({ specialists: [{ name: "security", status: "ok", steps: 3 }] }))).toEqual(
      verdict("clean-complete"),
    )
    // Passes later packages add (lens, repro, codium's judge) never stand in for a reviewer, and one that does not
    // finish leaves the review incomplete until its package decides otherwise.
    for (const name of ["lens", "repro", "judge"] as const) {
      expect(judge({ ...outcome(), specialists: [{ name, status: "ok" }] })).toEqual(
        verdict("incomplete", ["no-reviewer"]),
      )
      expect(
        judge({
          ...outcome(),
          specialists: [
            { name: "verify", status: "ok" },
            { name, status: "ok" },
          ],
        }),
      ).toEqual(verdict("incomplete", ["no-reviewer"]))
      expect(
        judge({
          ...outcome(),
          specialists: [
            { name: "review", status: "ok" },
            { name, status: "skipped" },
          ],
        }),
      ).toEqual(verdict("incomplete", ["specialist"]))
    }
  })

  test("every unfinished cause at once, in a fixed order", () => {
    expect(
      judge({
        ...outcome({
          partial: "timeout",
          unreviewed: ["src/a.ts"],
          skipped: [{ path: "big.ts", reason: "size-limit" }],
          specialists: [{ name: "verify", status: "timeout", steps: 9 }],
          selection: selection({ inline: [placed("blocking")] }),
        }),
        held: [{ status: "modified" }],
        strict: { complete: false },
      }),
    ).toEqual(
      verdict("incomplete", [
        "timeout",
        "unreviewed",
        "size-limit",
        "held-back",
        "strict-incomplete",
        "specialist",
        "no-reviewer",
      ]),
    )
  })

  test("VS-24's trivial outcome is a policy skip, and only when it attempted nothing", () => {
    const trivial: VerdictOutcome = { ...outcome({ specialists: [] }), trivial: true }
    expect(judge(trivial)).toEqual(verdict("policy-skip", ["trivial"]))
    expect(judge({ ...trivial, held: [{ status: "deleted" }] })).toEqual(
      verdict("policy-skip", ["trivial"], ["held-back-deletion"]),
    )
    // Without the marker, a run that attempted nothing has no reviewer.
    expect(judge(outcome({ specialists: [] }))).toEqual(verdict("incomplete", ["no-reviewer"]))
    // The zero-attempt stops come first.
    expect(judge({ ...trivial, partial: "privacy" })).toEqual(verdict("not-reviewed", ["privacy"]))
    expect(judge({ ...trivial, partial: "budget-estimate" })).toEqual(verdict("not-reviewed", ["budget-estimate"]))
    // A marker beside anything else unfinished does not describe the outcome, and the outcome is read instead.
    expect(judge({ ...trivial, partial: "timeout" })).toEqual(verdict("incomplete", ["timeout", "no-reviewer"]))
    expect(judge({ ...trivial, unreviewed: ["src/a.ts"] })).toEqual(
      verdict("incomplete", ["unreviewed", "no-reviewer"]),
    )
    expect(judge({ ...trivial, held: [{ status: "added" }] })).toEqual(
      verdict("incomplete", ["held-back", "no-reviewer"]),
    )
    expect(judge({ ...trivial, strict: { complete: false } })).toEqual(
      verdict("incomplete", ["strict-incomplete", "no-reviewer"]),
    )
    // So is a marker on a run whose passes ran.
    expect(judge({ ...outcome({ selection: selection({ inline: [placed("blocking")] }) }), trivial: true })).toEqual(
      verdict("blocking", ["blocking"]),
    )
    expect(judge({ ...outcome({ specialists: [{ name: "verify", status: "ok", steps: 1 }] }), trivial: true })).toEqual(
      verdict("incomplete", ["no-reviewer"]),
    )
    // What a trivial outcome lists is read as on any outcome: a trivial commit on a pull request with an earlier
    // blocking finding still open stays blocking, as failOn "blocking" reads the same list.
    expect(judge({ ...trivial, selection: selection({ stillOpen: [prior("blocking")] }) })).toEqual(
      verdict("blocking", ["blocking"]),
    )
    expect(judge({ ...trivial, selection: selection({ stillOpen: [prior("concern")] }) })).toEqual(
      verdict("findings", ["findings"]),
    )
    expect(
      judge({ ...trivial, selection: selection({ stillOpen: [prior("blocking")] }), held: [{ status: "deleted" }] }),
    ).toEqual(verdict("blocking", ["blocking"], ["held-back-deletion"]))
    // Contradictory markers still read the outcome first.
    expect(judge({ ...trivial, partial: "steps", selection: selection({ stillOpen: [prior("blocking")] }) })).toEqual(
      verdict("incomplete", ["steps", "no-reviewer"]),
    )
  })
})

describe("reviewVerdict over skips and failures", () => {
  test("every skip reason", () => {
    const expected: Record<VerdictSkip, ReviewVerdict | "stored"> = {
      "month-budget": "not-reviewed",
      "pr-budget": "not-reviewed",
      "too-large": "not-reviewed",
      "spend-unreadable": "not-reviewed",
      label: "policy-skip",
      draft: "policy-skip",
      author: "policy-skip",
      branch: "policy-skip",
      fork: "policy-skip",
      "nothing-to-review": "policy-skip",
      trivial: "policy-skip",
      "already-reviewed": "stored",
      carry: "stored",
    }
    const reasons: VerdictSkip[] = [
      "month-budget",
      "pr-budget",
      "too-large",
      "spend-unreadable",
      "label",
      "draft",
      "author",
      "branch",
      "fork",
      "nothing-to-review",
      "trivial",
      "already-reviewed",
      "carry",
    ]
    expect(Object.keys(expected).toSorted()).toEqual(reasons.toSorted())
    for (const reason of reasons) {
      const value = expected[reason]
      if (value === "stored") {
        expect(["already-reviewed", "carry"]).toContain(reason)
        continue
      }
      expect(reviewVerdict({ kind: "skip", reason })).toEqual(verdict(value, [reason]))
    }
  })

  test("each reason decideSkip gives maps through the table", () => {
    const cases: { reason: SkipReason; input: SkipInput; verdict: ReviewVerdict }[] = [
      {
        reason: "month-budget",
        input: skipInput({ config: { ...DEFAULT_REVIEW_CONFIG, maxCostUsdPerMonth: 20 }, monthCostUsd: 20 }),
        verdict: "not-reviewed",
      },
      { reason: "label", input: skipInput({}, { labels: ["vector:skip"] }), verdict: "policy-skip" },
      { reason: "draft", input: skipInput({}, { draft: true }), verdict: "policy-skip" },
      { reason: "author", input: skipInput({}, { author: "renovate[bot]" }), verdict: "policy-skip" },
      {
        reason: "branch",
        input: skipInput(
          { config: { ...DEFAULT_REVIEW_CONFIG, skipBranches: ["release/*"] } },
          { headBranch: "release/2" },
        ),
        verdict: "policy-skip",
      },
      { reason: "fork", input: skipInput({}, { fork: true }), verdict: "policy-skip" },
      { reason: "pr-budget", input: skipInput({ state: state({ costUsd: 10 }) }), verdict: "not-reviewed" },
      {
        reason: "nothing-to-review",
        input: skipInput({ size: { files: 0, changedLines: 0 } }),
        verdict: "policy-skip",
      },
      { reason: "too-large", input: skipInput({ size: { files: 301, changedLines: 400 } }), verdict: "not-reviewed" },
    ]
    for (const item of cases)
      for (const noted of [false, true]) {
        // Whether the job notes the skip in the summary (once per commit) does not change the verdict.
        const input = noted
          ? { ...item.input, state: { ...(item.input.state ?? state()), notedHead: HEAD } }
          : item.input
        const decision = decideSkip(input)
        expect(decision).toMatchObject({ skip: true, reason: item.reason })
        if (!decision.skip) throw new Error(`expected ${item.reason}`)
        expect(reviewVerdict({ kind: "skip", reason: decision.reason })).toEqual(verdict(item.verdict, [item.reason]))
      }
    const reviewed = decideSkip(skipInput({ state: state({ head: HEAD }) }))
    if (!reviewed.skip || reviewed.reason !== "already-reviewed") throw new Error("expected already-reviewed")
    expect(reviewVerdict({ kind: "skip", reason: reviewed.reason, stored: "findings" })).toEqual(
      verdict("findings", ["already-reviewed"]),
    )
    // The ten reasons decideSkip has, each covered.
    expect(new Set([...cases.map((item) => item.reason), "already-reviewed"]).size).toBe(10)
  })

  test("already-reviewed carries the verdict stored for the same head", () => {
    // decideSkip keeps skipping the head, so a stored verdict that leaves it unfinished asks for a full review.
    const notes: Record<ReviewVerdict, VerdictResult["notes"]> = {
      "not-reviewed": ["review-full"],
      "policy-skip": [],
      incomplete: ["review-full"],
      blocking: [],
      findings: [],
      "clean-complete": [],
    }
    expect(Object.keys(notes).toSorted()).toEqual([...REVIEW_VERDICTS].toSorted())
    for (const stored of REVIEW_VERDICTS)
      expect(reviewVerdict({ kind: "skip", reason: "already-reviewed", stored })).toEqual(
        verdict(stored, ["already-reviewed"], notes[stored]),
      )
    // A verify pass stopped for time leaves the head incomplete, and every later push to it says how to finish it.
    const stopped = judge(
      outcome({
        specialists: [
          { name: "review", status: "ok", steps: 4 },
          { name: "verify", status: "stopped", steps: 1 },
        ],
      }),
    )
    expect(reviewVerdict({ kind: "skip", reason: "already-reviewed", stored: stopped.verdict })).toEqual(
      verdict("incomplete", ["already-reviewed"], ["review-full"]),
    )
    expect(reviewVerdict({ kind: "skip", reason: "already-reviewed" })).toEqual(
      verdict("not-reviewed", ["already-reviewed", "no-stored-verdict"], ["review-full"]),
    )
  })

  test("a carry hands on a failing verdict, never a passing one from the old head", () => {
    expect(reviewVerdict({ kind: "skip", reason: "carry", stored: "not-reviewed" })).toEqual(
      verdict("not-reviewed", ["carry"], ["review-full"]),
    )
    expect(reviewVerdict({ kind: "skip", reason: "carry", stored: "incomplete" })).toEqual(
      verdict("incomplete", ["carry"], ["review-full"]),
    )
    // A blocking review needs a fix, not another review.
    expect(reviewVerdict({ kind: "skip", reason: "carry", stored: "blocking" })).toEqual(verdict("blocking", ["carry"]))
    for (const stored of PASSING)
      expect(reviewVerdict({ kind: "skip", reason: "carry", stored })).toEqual(
        verdict("not-reviewed", ["carry"], ["review-full"]),
      )
    expect([...FAILING, ...PASSING].toSorted()).toEqual([...REVIEW_VERDICTS].toSorted())
    expect(reviewVerdict({ kind: "skip", reason: "carry" })).toEqual(
      verdict("not-reviewed", ["carry", "no-stored-verdict"], ["review-full"]),
    )
  })

  test("failures", () => {
    expect(reviewVerdict({ kind: "failure", stage: "config" })).toEqual(verdict("not-reviewed", ["config-error"]))
    expect(reviewVerdict({ kind: "failure", stage: "start" })).toEqual(verdict("not-reviewed", ["start-error"]))
    expect(reviewVerdict({ kind: "failure", stage: "review" })).toEqual(verdict("incomplete", ["review-error"]))
  })

  test("only the skips that keep an earlier review take a stored verdict", () => {
    const inputs: VerdictInput[] = [
      // @ts-expect-error A label skip has no stored verdict to carry.
      { kind: "skip", reason: "label", stored: "clean-complete" },
      // @ts-expect-error Not a review of the head: whether such a run emits a verdict is the job wiring's decision.
      { kind: "skip", reason: "other-command" },
      // @ts-expect-error As above, for a commenter without write access.
      { kind: "skip", reason: "no-write-access" },
    ]
    expect(inputs).toHaveLength(3)
  })
})

// The VT1 exit paths of today's GitHub job, each fed to the pure function as the job would describe it. This is a
// mapping table only: the job's own exit-path test, catch blocks included, and its D3 parity test land with the wiring.
describe("VT1 path mapping table (pure; the job's exit-path test is deferred)", () => {
  const failedReviewers: VerdictInput = {
    kind: "outcome",
    outcome: outcome({
      partial: "model-error",
      unreviewed: ["src/a.ts", "src/b.ts"],
      specialists: [
        { name: "review", status: "failed", steps: 0 },
        { name: "security", status: "failed", steps: 0 },
      ],
    }),
  }
  const rows: { path: string; input: VerdictInput; expected: ReviewVerdict }[] = [
    // Exit 0 today.
    {
      path: "a skip decideSkip notes nothing for (draft)",
      input: { kind: "skip", reason: "draft" },
      expected: "policy-skip",
    },
    {
      path: "a skip decideSkip notes in the summary (month budget)",
      input: { kind: "skip", reason: "month-budget" },
      expected: "not-reviewed",
    },
    {
      path: "the month's spend could not be read while a month cap is set",
      input: { kind: "skip", reason: "spend-unreadable" },
      expected: "not-reviewed",
    },
    {
      path: "a rebase carry of a clean review",
      input: { kind: "skip", reason: "carry", stored: "clean-complete" },
      expected: "not-reviewed",
    },
    {
      path: "a rebase carry of a blocking review",
      input: { kind: "skip", reason: "carry", stored: "blocking" },
      expected: "blocking",
    },
    {
      path: "a rebase carry with no stored verdict",
      input: { kind: "skip", reason: "carry" },
      expected: "not-reviewed",
    },
    // Reached when every changed file is ignored, generated, vendored, binary or deleted without a patch.
    {
      path: "nothing left after classification",
      input: { kind: "skip", reason: "nothing-to-review" },
      expected: "policy-skip",
    },
    { path: "every reviewer failed without throwing", input: failedReviewers, expected: "incomplete" },
    {
      path: "a completed partial run",
      input: { kind: "outcome", outcome: outcome({ partial: "steps", unreviewed: ["src/b.ts"] }) },
      expected: "incomplete",
    },
    {
      path: "a completed run with concerns",
      input: { kind: "outcome", outcome: outcome({ selection: selection({ inline: [placed("concern")] }) }) },
      expected: "findings",
    },
    { path: "a completed clean run", input: { kind: "outcome", outcome: outcome() }, expected: "clean-complete" },
    {
      path: "a model or tool failure caught inside the job",
      input: { kind: "failure", stage: "review" },
      expected: "incomplete",
    },
    {
      path: "GitHub or git failed before the review started",
      input: { kind: "failure", stage: "start" },
      expected: "not-reviewed",
    },
    // Exit 1 today.
    {
      path: "a model or triage model that cannot start, GitHub 401, 403 or 404, a checkout mismatch, a command-level failure",
      input: { kind: "failure", stage: "config" },
      expected: "not-reviewed",
    },
    {
      path: 'failOn "blocking" with open blocking findings',
      input: { kind: "outcome", outcome: outcome({ selection: selection({ stillOpen: [prior("blocking")] }) }) },
      expected: "blocking",
    },
  ]
  for (const row of rows) test(row.path, () => expect(reviewVerdict(row.input).verdict).toBe(row.expected))

  test("every reviewer failed without throwing names each cause", () => {
    expect(reviewVerdict(failedReviewers)).toEqual(verdict("incomplete", ["model-error", "unreviewed", "specialist"]))
  })
})

describe("an unfinished review never reads as a pass", () => {
  test("over every combination", () => {
    const specialists: VerdictOutcome["specialists"][] = [
      [],
      [{ name: "verify", status: "ok" }],
      ...(["ok", "failed", "timeout", "stopped", "skipped"] as const).map((status) => [
        { name: "review" as const, status },
      ]),
    ]
    const combinations = (
      [undefined, "budget", "steps", "timeout", "model-error", "privacy", "budget-estimate"] as const
    )
      .flatMap((partial) => [[], ["src/a.ts"]].map((unreviewed) => ({ partial, unreviewed })))
      .flatMap((item) => ([undefined, "modified", "deleted"] as const).map((held) => ({ ...item, held })))
      .flatMap((item) => [undefined, true, false].map((strict) => ({ ...item, strict })))
      .flatMap((item) => specialists.map((passes) => ({ ...item, passes })))
      .flatMap((item) =>
        ([undefined, "nit", "concern", "blocking"] as const).map((severity) => ({ ...item, severity })),
      )
      .flatMap((item) => ([undefined, true] as const).map((trivial) => ({ ...item, trivial })))
    expect(combinations).toHaveLength(7 * 2 * 3 * 3 * 7 * 4 * 2)
    for (const item of combinations) {
      const result = judge({
        ...outcome({ selection: selection(item.severity ? { stillOpen: [prior(item.severity)] } : {}) }),
        ...(item.partial ? { partial: item.partial } : {}),
        unreviewed: item.unreviewed,
        ...(item.held ? { held: [{ status: item.held }] } : {}),
        ...(item.strict === undefined ? {} : { strict: { complete: item.strict } }),
        specialists: item.passes,
        ...(item.trivial ? { trivial: item.trivial } : {}),
      })
      // The invariant only; the tables above pin which failing or passing tier each input gets.
      expect(REVIEW_VERDICTS).toContain(result.verdict)
      if (item.severity === "blocking") expect(PASSING).not.toContain(result.verdict)
      const finishedButReviewer =
        item.partial === undefined &&
        !item.unreviewed.length &&
        item.held !== "modified" &&
        item.strict !== false &&
        item.passes.every((entry) => entry.status === "ok")
      if (finishedButReviewer && item.passes.some((entry) => entry.name === "review")) continue
      if (!PASSING.includes(result.verdict)) continue
      // The one pass without a finished run is a trivial outcome: it attempted nothing, and its marker stands in for
      // the missing reviewer only.
      expect({ finishedButReviewer, trivial: item.trivial, passes: item.passes.length }).toEqual({
        finishedButReviewer: true,
        trivial: true,
        passes: 0,
      })
    }
  })
})

// Each input is decoded from JSON, as a replay artifact or an adapter hands one over, so it can carry a value the types
// do not name without a type assertion. The keys every object inherits are among the values, so a lookup that reads
// the prototype fails these tests.
const decodeInput = (value: unknown): VerdictInput => JSON.parse(JSON.stringify(value))
const decodeResult = (value: unknown): VerdictResult => JSON.parse(JSON.stringify(value))
const INHERITED = ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]

describe("values the types do not name fail closed at runtime", () => {
  test("a skipped-file reason it does not name leaves the review incomplete", () => {
    for (const reason of ["held-back", "", ...INHERITED])
      expect(
        reviewVerdict(decodeInput({ kind: "outcome", outcome: { ...outcome(), skipped: [{ path: "x", reason }] } })),
      ).toEqual(verdict("incomplete", ["skipped-unknown"]))
    // Once, after the known causes, whatever order the files come in.
    for (const skipped of [
      [
        { path: "a", reason: "held-back" },
        { path: "b", reason: "size-limit" },
      ],
      [
        { path: "b", reason: "size-limit" },
        { path: "c", reason: "lockfile" },
        { path: "a", reason: "held-back" },
        { path: "d", reason: "toString" },
      ],
    ])
      expect(reviewVerdict(decodeInput({ kind: "outcome", outcome: { ...outcome(), skipped } }))).toEqual(
        verdict("incomplete", ["size-limit", "skipped-unknown"]),
      )
  })

  test("a skip reason it does not name leaves the head not reviewed", () => {
    for (const reason of ["other-command", "no-write-access", "", ...INHERITED])
      expect(reviewVerdict(decodeInput({ kind: "skip", reason }))).toEqual(verdict("not-reviewed", ["skip-unknown"]))
  })

  test("a failure stage it does not name leaves the head not reviewed", () => {
    for (const stage of ["deploy", "", ...INHERITED])
      expect(reviewVerdict(decodeInput({ kind: "failure", stage }))).toEqual(
        verdict("not-reviewed", ["failure-unknown"]),
      )
  })

  test("a stored verdict it does not name reads as a missing one", () => {
    for (const reason of ["already-reviewed", "carry"] as const)
      for (const stored of ["pass", "CLEAN-COMPLETE", "", null, 0, ...INHERITED])
        expect(reviewVerdict(decodeInput({ kind: "skip", reason, stored }))).toEqual(
          verdict("not-reviewed", [reason, "no-stored-verdict"], ["review-full"]),
        )
  })

  test("a severity it does not name reads as blocking", () => {
    for (const list of SEVERITY_LISTS)
      expect(
        reviewVerdict(
          decodeInput({
            kind: "outcome",
            outcome: {
              ...outcome(),
              selection: { ...selection(), [list]: [{ ...finding("concern"), severity: "major" }] },
            },
          }),
        ),
      ).toEqual(verdict("blocking", ["blocking"]))
    // On a trivial outcome too.
    expect(
      reviewVerdict(
        decodeInput({
          kind: "outcome",
          outcome: {
            ...outcome({ specialists: [] }),
            selection: { ...selection(), stillOpen: [{ ...prior("nit"), severity: "" }] },
            trivial: true,
          },
        }),
      ),
    ).toEqual(verdict("blocking", ["blocking"]))
  })

  test("a partial value, status or flag it does not name leaves the review incomplete", () => {
    const judgeDecoded = (value: object) => reviewVerdict(decodeInput({ kind: "outcome", outcome: value }))
    expect(judgeDecoded({ ...outcome(), partial: "rate-limit" })).toEqual(
      decodeResult({ verdict: "incomplete", causes: ["rate-limit"], notes: [] }),
    )
    expect(judgeDecoded({ ...outcome(), specialists: [{ name: "review", status: "cancelled" }] })).toEqual(
      verdict("incomplete", ["specialist"]),
    )
    // A reviewer is named exactly.
    expect(judgeDecoded({ ...outcome(), specialists: [{ name: "Review", status: "ok" }] })).toEqual(
      verdict("incomplete", ["no-reviewer"]),
    )
    expect(judgeDecoded({ ...outcome(), held: [{ status: "copied" }] })).toEqual(verdict("incomplete", ["held-back"]))
    for (const complete of ["true", 1, null])
      expect(judgeDecoded({ ...outcome(), strict: { complete } })).toEqual(verdict("incomplete", ["strict-incomplete"]))
    expect(judgeDecoded({ ...outcome(), strict: {} })).toEqual(verdict("incomplete", ["strict-incomplete"]))
    // Only a marker that is exactly true makes the outcome trivial.
    for (const trivial of ["true", 1, {}])
      expect(judgeDecoded({ ...outcome({ specialists: [] }), trivial })).toEqual(verdict("incomplete", ["no-reviewer"]))
  })
})

describe("reviewVerdict is pure", () => {
  test("it reads a frozen input and leaves it as it was", () => {
    const input: VerdictInput = {
      kind: "outcome",
      outcome: {
        ...outcome({
          partial: "timeout",
          unreviewed: ["src/a.ts"],
          skipped: [{ path: "big.ts", reason: "size-limit" }],
          selection: selection({ inline: [placed("blocking")], stillOpen: [prior("concern")] }),
        }),
        held: [{ status: "deleted" }, { status: "modified" }],
        strict: { complete: false },
      },
    }
    const before = structuredClone(input)
    const result = reviewVerdict(deepFreeze(input))
    expect(input).toEqual(before)
    // Every call returns new arrays, so a caller that changes one never changes the next result.
    result.causes.push("findings")
    result.notes.push("review-full")
    expect(reviewVerdict(input)).toEqual(
      verdict(
        "incomplete",
        ["timeout", "unreviewed", "size-limit", "held-back", "strict-incomplete"],
        ["held-back-deletion"],
      ),
    )
    for (const stage of ["config", "start", "review"] as const)
      reviewVerdict({ kind: "failure", stage }).causes.push("findings")
    expect(reviewVerdict({ kind: "failure", stage: "config" })).toEqual(verdict("not-reviewed", ["config-error"]))
  })
})

function state(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    v: 1,
    head: OLDER,
    reviews: 1,
    costUsd: 0.2,
    tokens: [1_000, 100],
    unreviewed: [],
    inlinePosted: 0,
    findings: [],
    ...overrides,
  }
}

function skipInput(overrides: Partial<SkipInput> = {}, pr: Partial<SkipInput["pr"]> = {}): SkipInput {
  return {
    trigger: "auto",
    config: DEFAULT_REVIEW_CONFIG,
    head: HEAD,
    state: state(),
    size: { files: 3, changedLines: 120 },
    ...overrides,
    pr: { draft: false, author: "alice", labels: [], headBranch: "feature/x", fork: false, ...pr },
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}
