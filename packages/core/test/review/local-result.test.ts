import { describe, expect, test } from "bun:test"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionID } from "@vectordevai/schema/session-id"
import { hash } from "../../src/util/encode"
import { diagnosticCitation, OFFLINE_DIAGNOSTIC_RULES, withDiagnosticEvidence } from "../../src/review/diagnostic"
import { fromGitHubFiles, parseUnifiedDiff } from "../../src/review/diff"
import { classifyFiles, parseGitAttributes } from "../../src/review/ignore"
import {
  completeStrictReview,
  decodeLocalResult,
  decodeLocalRun,
  type LocalResult,
} from "../../src/review/local-result"
import { selectFindings } from "../../src/review/select"
import { MAX_FINDING_QUOTES, MAX_TRACE_QUOTES } from "../../src/review/schema"
import { DEFAULT_REVIEW_CONFIG, type Finding, type ReviewOutcome, type StrictFinding } from "../../src/review/types"
import { reviewVerdict } from "../../src/review/verdict"

const head = "a".repeat(40)
const base = "b".repeat(40)
const target = { kind: "working-tree" as const, head }
const outcome = (): ReviewOutcome => ({
  report: { summary: "Completed review", risk: "low", files: [], findings: [] },
  selection: {
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
  },
  skipped: [],
  cost: {
    costUsd: 0.02,
    input: 120,
    output: 30,
    reasoning: 2,
    cacheRead: 5,
    cacheWrite: 0,
    kind: "priced",
    model: "provider/reviewer",
    tokensOwnOnly: true,
  },
  durationMs: 10,
  base,
  head,
  mode: "full",
  unreviewed: [],
  specialists: [{ name: "review", status: "ok", steps: 1 }],
  sessions: ["ses_review_child"],
  stats: { files: 1, additions: 1, deletions: 1 },
  notes: [],
  passes: [
    {
      name: "review",
      model: "provider/reviewer",
      costUsd: 0.02,
      input: 120,
      output: 30,
      cacheRead: 5,
      costKind: "priced",
    },
  ],
})
const result = (value = outcome()): LocalResult => ({
  exitCode: 0,
  target: { kind: "uncommitted", label: "uncommitted changes", baseRef: "HEAD", mergeBase: base, head },
  outcome: value,
  verdict: reviewVerdict({ kind: "outcome", outcome: value }),
})
async function artifact(value: unknown): Promise<ReviewRun.Artifact> {
  const json = JSON.stringify(value)
  return { version: 1, json, bytes: new TextEncoder().encode(json).byteLength, sha256: await hash(json) }
}
const info = async (value = result(), status: ReviewRun.Status = "completed"): Promise<ReviewRun.Info> => ({
  runID: SessionID.make("ses_result_run"),
  parentID: SessionID.make("ses_result_parent"),
  request: { requestID: "request_result_1", target },
  status,
  canStop: status === "running",
  startedAt: 1,
  ...(status === "running" ? {} : { completedAt: 2 }),
  artifact: await artifact(value),
})

const expectedRun = { parentID: "ses_result_parent", request: { requestID: "request_result_1", target } }
const decode = (value: unknown) => decodeLocalRun(value, expectedRun)

const stoppedOutcome = (extra: Partial<ReviewOutcome> = {}): ReviewOutcome => ({
  ...outcome(),
  report: { summary: "", risk: "low", files: [], findings: [] },
  cost: undefined,
  sessions: [],
  specialists: [],
  passes: undefined,
  unreviewed: ["src/file.ts"],
  ...extra,
})
const failedResult = (value: ReviewOutcome, error: string): LocalResult => ({ ...result(value), exitCode: 2, error })
const decodeStop = (value: unknown) => decodeLocalResult(JSON.parse(JSON.stringify(value)), target)
async function retainedStop(value: LocalResult) {
  const stored: LocalResult = JSON.parse(JSON.stringify(value))
  const decoded = decodeLocalResult(stored, target)
  expect(decoded).toBeDefined()
  expect(decoded?.error).toBe(value.error)
  expect(decoded?.verdict).toEqual(value.verdict)
  expect(decoded?.verdict.verdict).not.toBe("clean-complete")
  expect(decoded?.verdict.verdict).not.toBe("policy-skip")
  for (const status of ["completed", "failed"] as const) {
    const run = await decode(await info(stored, status))
    expect(run?.result).toEqual(decoded)
    expect(run?.verdict.verdict).not.toBe("clean-complete")
  }
  return { stored, decoded }
}

describe("retained local review result decoding", () => {
  test("a pre-review privacy refusal round-trips its error and zero-attempt outcome", async () => {
    const value = stoppedOutcome({ partial: "privacy" })
    const { decoded } = await retainedStop(failedResult(value, "No approved zero data retention route is available."))
    expect(decoded?.outcome?.sessions).toEqual([])
    expect(decoded?.outcome?.specialists).toEqual([])
    expect(decoded?.verdict).toEqual({ verdict: "not-reviewed", causes: ["privacy"], notes: [] })
  })

  test("a privacy refusal preserves prior finding state without inventing new evidence", async () => {
    const prior: ReviewOutcome["selection"]["stillOpen"][number] = {
      id: "prior-open",
      where: "inline",
      path: "src/file.ts",
      line: 1,
      side: "RIGHT",
      severity: "blocking",
      category: "bug",
      title: "Existing issue",
      sha: base,
      status: "open",
    }
    const selection = {
      ...outcome().selection,
      stillOpen: [prior],
      fixed: [{ ...prior, id: "prior-fixed", status: "fixed" as const }],
      dismissed: [{ ...prior, id: "prior-dismissed", status: "dismissed" as const }],
    }
    const value = stoppedOutcome({ partial: "privacy", selection })
    const { decoded } = await retainedStop(failedResult(value, "No approved model route."))
    expect(decoded?.outcome?.selection).toEqual(selection)
  })

  test("a privacy stop after dispatch retains sessions and actual spend without fresh usage proof", async () => {
    const original = outcome()
    const value = stoppedOutcome({
      partial: "privacy",
      cost: { ...original.cost!, partial: true },
      sessions: ["ses_review_child", "ses_security_child"],
      specialists: [
        { name: "review", status: "ok", steps: 1 },
        { name: "security", status: "skipped", steps: 0, detail: "privacy" },
      ],
      passes: original.passes,
    })
    const { decoded } = await retainedStop(failedResult(value, "The remaining model route could not satisfy privacy."))
    expect(decoded?.outcome?.cost).toEqual({ ...value.cost!, tokensOwnOnly: false })
    expect(decoded?.outcome?.sessions).toEqual(value.sessions)
    expect(decoded?.outcome?.passes).toEqual(value.passes)
  })

  test("all held-back changes round-trip their zero-review outcome and held paths", async () => {
    const value = stoppedOutcome({
      unreviewed: [],
      skipped: [{ path: ".env", reason: "held-back" }],
      held: [{ path: ".env", status: "modified", reason: "env-file" }],
      cost: { ...outcome().cost!, costUsd: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    const { decoded } = await retainedStop(failedResult(value, "Every changed file was held back from the model."))
    expect(decoded?.outcome?.held).toEqual(value.held)
    expect(decoded?.verdict.verdict).toBe("incomplete")
    expect(decoded?.verdict.causes).toContain("held-back")
  })

  test("a stopped batch round-trips incomplete coverage without crediting the unreviewed paths", async () => {
    const value = stoppedOutcome({
      selection: { ...outcome().selection, diffIncomplete: true },
      notes: ["Partial batch coverage: 0 of 2 batches complete; 1 changed file remains unreviewed."],
    })
    const { decoded } = await retainedStop(failedResult(value, value.notes[0]))
    expect(decoded?.outcome?.unreviewed).toEqual(["src/file.ts"])
    expect(decoded?.outcome?.selection.diffIncomplete).toBe(true)
    expect(decoded?.verdict.verdict).toBe("incomplete")
  })

  test("every failed reviewer round-trips the failure and spend instead of losing its result", async () => {
    const value = stoppedOutcome({
      partial: "model-error",
      cost: { ...outcome().cost!, partial: true },
      sessions: ["ses_review_child", "ses_security_child"],
      specialists: [
        { name: "review", status: "failed", steps: 1, detail: "No report" },
        { name: "security", status: "failed", steps: 1, detail: "Invalid report" },
      ],
      passes: outcome().passes,
    })
    const { decoded } = await retainedStop(failedResult(value, "Vector could not finish this review: no report."))
    expect(decoded?.outcome?.specialists).toEqual(value.specialists)
    expect(decoded?.outcome?.cost?.costUsd).toBe(0.02)
    expect(decoded?.outcome?.cost?.tokensOwnOnly).toBe(false)
  })

  test("retained service stops reject invented success, mismatched identity and contradictory completeness", () => {
    const stopped = failedResult(stoppedOutcome({ partial: "privacy" }), "No approved model route.")
    const strict = { version: 1, head, complete: true, findings: [], dropped: [], fixUnchecked: 0 }
    for (const changed of [
      { error: "" },
      { error: " \n " },
      { exitCode: 0 },
      { exitCode: 1 },
      { target: undefined },
      { target: { ...stopped.target, mergeBase: head } },
      { verdict: result().verdict },
      { outcome: { ...stopped.outcome, strict } },
      { outcome: { ...stopped.outcome, trivial: true } },
      { outcome: { ...stopped.outcome, authorized: true } },
      {
        outcome: {
          ...stopped.outcome,
          report: { ...outcome().report, files: [{ path: "file.ts", note: "Reviewed" }] },
        },
      },
    ])
      expect(decodeLocalResult(JSON.parse(JSON.stringify({ ...stopped, ...changed })), target)).toBeUndefined()
    const staged = { ...stopped, target: { ...stopped.target!, kind: "staged" as const } }
    expect(decodeLocalResult(JSON.parse(JSON.stringify(staged)), { ...target, kind: "staged" })?.error).toBe(
      stopped.error,
    )
  })

  test("zero-review holdback and batch stops cannot hide model work or manufactured coverage", () => {
    const held = stoppedOutcome({
      skipped: [{ path: ".env", reason: "held-back" }],
      held: [{ path: ".env", status: "modified", reason: "env-file" }],
    })
    const batch = stoppedOutcome({ selection: { ...outcome().selection, diffIncomplete: true } })
    for (const value of [held, batch])
      for (const changed of [
        { cost: outcome().cost },
        { passes: outcome().passes },
        { sessions: ["ses_hidden_model_work"] },
        { specialists: [{ name: "review", status: "ok", steps: 1 }] },
      ]) {
        const altered = { ...value, ...changed } as ReviewOutcome
        expect(decodeStop(failedResult(altered, "Not reviewed."))).toBeUndefined()
      }
    expect(decodeStop(failedResult({ ...held, skipped: [] }, "Not reviewed."))).toBeUndefined()
    expect(decodeStop(failedResult({ ...held, held: [...held.held!, ...held.held!] }, "Not reviewed."))).toBeUndefined()
    expect(decodeStop(failedResult({ ...batch, unreviewed: [] }, "Not reviewed."))).toBeUndefined()
    expect(decodeStop(failedResult({ ...batch, selection: outcome().selection }, "Not reviewed."))).toBeUndefined()
  })

  test("failed-reviewer stops require actual failed reviewers rather than a successful or verifier-only pass", () => {
    for (const specialists of [
      [{ name: "verify", status: "failed", steps: 1 }],
      [{ name: "review", status: "skipped", steps: 0 }],
      [
        { name: "review", status: "failed", steps: 1 },
        { name: "security", status: "ok", steps: 1 },
      ],
    ] satisfies ReviewOutcome["specialists"][]) {
      const value = stoppedOutcome({ partial: "model-error", specialists })
      expect(decodeStop(failedResult(value, "Vector could not finish this review."))).toBeUndefined()
    }
  })

  test("an empty reviewer failure retains its zero-attempt result without pretending a reviewer ran", async () => {
    const value = stoppedOutcome({ unreviewed: [], notes: ["Completed all 2 review batches (1 files)."] })
    const { decoded } = await retainedStop(
      failedResult(value, "Vector could not finish this review: the model returned no report"),
    )
    expect(decoded?.verdict).toEqual({ verdict: "incomplete", causes: ["no-reviewer"], notes: [] })
  })

  // scope-finish takeover (2026-11-23): the engine marks every retained stop failed (local-run.ts), and decodeLocalRun
  // used to re-derive its verdict with a "model-error" default, a cause no held-back or empty-reviewer stop has.
  test("a failed run shows a retained stop's own verdict, never an invented model error", async () => {
    const held = stoppedOutcome({
      unreviewed: [],
      skipped: [{ path: ".env", reason: "held-back" }],
      held: [{ path: ".env", status: "modified", reason: "env-file" }],
    })
    const empty = stoppedOutcome({ unreviewed: [], notes: ["Completed all 2 review batches (1 files)."] })
    for (const value of [
      failedResult(held, "Every changed file was held back from the model."),
      failedResult(empty, "Vector could not finish this review: the model returned no report"),
    ]) {
      const stored: LocalResult = JSON.parse(JSON.stringify(value))
      const decoded = decodeLocalResult(stored, target)
      expect(decoded).toBeDefined()
      const run = await decode(await info(stored, "failed"))
      expect(run?.verdict).toEqual(decoded!.verdict)
      expect(run?.verdict.causes).not.toContain("model-error")
      expect(run?.verdict.verdict).toBe("incomplete")
    }
    // A run that is still going or was cancelled keeps the lifecycle's own cause.
    const running = await decode(await info(JSON.parse(JSON.stringify(failedResult(held, "Held."))), "running"))
    expect(running?.verdict.causes).toContain("timeout")
  })

  test("a completed cursor retains genuinely classified generated and vendored skips", async () => {
    const files = fromGitHubFiles(
      ["src/file.ts", "generated.ts", "vendor/lib.ts"].map((filename) => ({
        filename,
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old()\n+new()",
      })),
    )
    const classified = classifyFiles(files, {
      config: DEFAULT_REVIEW_CONFIG,
      attributes: parseGitAttributes("generated.ts linguist-generated\nvendor/** linguist-vendored"),
    })
    expect(classified.review.map((file) => file.path)).toEqual(["src/file.ts"])
    expect(classified.skipped).toEqual([
      { path: "generated.ts", reason: "generated" },
      { path: "vendor/lib.ts", reason: "vendored" },
    ])
    const value = stoppedOutcome({
      skipped: classified.skipped,
      unreviewed: [],
      notes: ["Completed all 2 review batches (1 files)."],
    })
    const { decoded } = await retainedStop(failedResult(value, "Vector could not finish this review: no report"))
    expect(decoded?.outcome?.skipped).toEqual(classified.skipped)
    expect(decoded?.verdict).toEqual({ verdict: "incomplete", causes: ["no-reviewer"], notes: [] })
    for (const reason of ["held-back", "size-limit"] as const)
      expect(
        decodeStop(
          failedResult(stoppedOutcome({ unreviewed: [], skipped: [{ path: "src/file.ts", reason }] }), "No report."),
        ),
      ).toBeUndefined()
  })

  test("empty-evidence stops cannot manufacture new selection or strict-drop bookkeeping", () => {
    const privacy = stoppedOutcome({ partial: "privacy" })
    for (const selection of [
      { ...privacy.selection, raised: [{ id: "invented", was: "concern" as const }] },
      { ...privacy.selection, reappeared: ["invented"] },
      { ...privacy.selection, dropped: [{ reason: "duplicate" as const, count: 1 }] },
    ])
      expect(decodeStop(failedResult({ ...privacy, selection }, "No approved model route."))).toBeUndefined()
    const strict = { version: 1 as const, head, complete: false, findings: [], dropped: [], fixUnchecked: 0 }
    for (const changed of [{ fixUnchecked: 1 }, { dropped: [{ reason: "cap" as const, count: 1 }] }])
      expect(
        decodeStop(failedResult({ ...privacy, strict: { ...strict, ...changed } }, "No approved model route.")),
      ).toBeUndefined()
  })

  test("only an exact completed strict outcome can supply a branch-cache verdict", () => {
    const original = outcome()
    const strict = { version: 1, head, complete: true, findings: [], dropped: [], fixUnchecked: 0 }
    const summary = { complete: true, findingCount: 0, dropped: [] }
    const selection = { ...original.selection, strict: summary }
    const cached = { ...original, strict, selection, cost: { ...original.cost, labs: 2 } }
    expect(completeStrictReview(cached, head)).toBe(true)
    expect(completeStrictReview(cached, base)).toBe(false)
    for (const value of [
      original,
      { ...cached, head: base },
      { ...cached, strict: { ...strict, head: base } },
      { ...cached, partial: "timeout" },
      { ...cached, specialists: [] },
      { ...cached, unreviewed: ["unseen.ts"] },
      { ...cached, strict: { ...strict, incomplete: ["blob-unreadable"] } },
      { ...cached, strict: { ...strict, fixUnchecked: 1 } },
      { ...cached, strict: { ...strict, version: 2 } },
      { ...cached, selection: { ...selection, diffIncomplete: true } },
      { ...cached, selection: { ...selection, strict: { ...summary, findingCount: 1 } } },
      { ...cached, selection: { ...selection, strict: { ...summary, dropped: [{ reason: "cap", count: 1 }] } } },
    ])
      expect(completeStrictReview(value, head)).toBe(false)
  })

  test("a strict selection can retain a prior comment ID only with the same verified evidence", () => {
    const kept: StrictFinding = {
      id: "new-fingerprint",
      path: "file.ts",
      line: 1,
      side: "RIGHT",
      title: "Empty input crashes",
      class: "crash",
      mechanism: "logic",
      trigger: "No input.",
      impact: "The request fails.",
      quotes: [{ path: "file.ts", line: 1, side: "RIGHT", code: "fail()" }],
      fix: { kind: "suggestion", text: "return" },
      verifiedBy: "model",
      verifier: "provider/reviewer",
    }
    const finding: Finding = {
      id: kept.id,
      path: kept.path,
      line: kept.line,
      side: kept.side,
      title: kept.title,
      category: "bug",
      severity: "blocking",
      confidence: 1,
      source: "review",
      verified: true,
      verifiedBy: kept.verifiedBy,
      quotes: kept.quotes,
      suggestion: kept.fix.text,
      failure: { class: kept.class, mechanism: kept.mechanism, trigger: kept.trigger, impact: kept.impact },
      body: `${kept.trigger}\n\n${kept.impact}`,
    }
    const anchors = parseUnifiedDiff(
      "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old()\n+fail()\n",
    )
    for (const status of ["fixed", "open"] as const) {
      const value = outcome()
      value.strict = { version: 1, head, complete: true, findings: [kept], dropped: [], fixUnchecked: 0 }
      value.report.findings = [finding]
      value.selection = selectFindings({
        head,
        trust: "trusted",
        mode: "full",
        config: DEFAULT_REVIEW_CONFIG,
        findings: [finding],
        anchors,
        prior: [
          {
            where: "inline",
            id: "prior-comment",
            sha: base,
            path: kept.path,
            line: kept.line,
            side: kept.side,
            category: "bug",
            severity: "concern",
            title: kept.title,
            status,
          },
        ],
      })
      value.selection.strict = { complete: true, findingCount: 1, dropped: [] }
      const [row] = value.selection.inline
      expect(row.id).toBe("prior-comment")
      expect(status === "fixed" ? value.selection.reappeared : value.selection.raised.map((entry) => entry.id)).toEqual(
        [row.id],
      )
      expect(completeStrictReview(value, head)).toBe(true)
      const check = (changed: Partial<typeof row>) =>
        completeStrictReview({ ...value, selection: { ...value.selection, inline: [{ ...row, ...changed }] } }, head)
      expect(completeStrictReview(value, head, "certificate")).toBe(false)
      const certificate = { trace: kept.quotes, guards: [], reach: "entry-point" as const }
      value.strict.findings[0] = { ...kept, certificate }
      expect(completeStrictReview(value, head, "certificate")).toBe(true)
      for (const invalid of [
        { trace: [] },
        { trace: Array(MAX_TRACE_QUOTES + 1).fill(kept.quotes[0]) },
        { guards: Array(MAX_FINDING_QUOTES + 1).fill(kept.quotes[0]) },
      ]) {
        value.strict.findings[0] = { ...kept, certificate: { ...certificate, ...invalid } }
        expect(completeStrictReview(value, head, "certificate")).toBe(false)
      }
      value.strict.findings[0] = kept
      expect(check({ id: kept.id })).toBe(true)
      expect(check({ id: "unrelated-comment" })).toBe(false)
      for (const changed of [
        { path: "other.ts" },
        { line: 2 },
        { endLine: 3 },
        { side: "LEFT" as const },
        { title: "Different" },
        { anchor: { ...row.anchor, path: "other.ts" } },
        { anchor: { ...row.anchor, line: 2 } },
        { body: "Unverified advice" },
        { verified: false },
        { severity: "nit" as const },
        { verifiedBy: "runtime" as const },
        { quotes: [{ ...kept.quotes[0], code: "invented" }] },
        { suggestion: "unverified fix" },
        { patch: "an unverified patch" },
        { failure: { ...finding.failure!, impact: "Different consequence" } },
      ]) {
        expect(check(changed)).toBe(false)
        expect(check({ ...changed, id: kept.id })).toBe(false)
      }
      const copied = { ...value.selection, inline: [], overflow: [finding, { ...finding, id: row.id }] }
      expect(completeStrictReview({ ...value, selection: copied }, head)).toBe(false)
      const quote = "Reject empty input at the boundary."
      const citation = { source: { kind: "paths" as const, index: 0 }, quote }
      const linkedRule = { source: "paths[0]", quote, rulesSource: "base branch" as const }
      value.strict.findings[0] = { ...kept, linkedRule }
      const checked = { rule: quote, citation, rulesSource: "base branch" as const }
      expect(check(checked)).toBe(true)
      expect(check({ ...checked, rule: "Other instruction" })).toBe(false)
      expect(check({ ...checked, rulesSource: "working tree" })).toBe(false)
      expect(check({ ...checked, citation: { source: { kind: "paths", index: 1 }, quote } })).toBe(false)
      expect(check({})).toBe(false)
      value.strict.findings[0] = kept
      expect(check(checked)).toBe(false)
      // The strict result retains both accepted occurrences when ordinary selection folds their display.
      value.strict.findings.push(
        { ...kept, id: "other-line", line: 12 },
        { ...kept, id: "other-file", path: "other.ts", line: 12 },
      )
      value.selection.strict.findingCount = value.strict.findings.length
      const also = { also: ["file.ts:12"], body: `${finding.body}\n\nThe same problem is also at line 12.` }
      expect(check(also)).toBe(true)
      expect(check({ ...also, also: ["other.ts:12"] })).toBe(false)
      expect(check({ ...also, body: `${finding.body}\n\nThe same problem is also at line 14.` })).toBe(false)
    }
  })

  test("the service's budget-stop error and zero-attempt outcome round-trip with no clean credit", async () => {
    const stopped: ReviewOutcome = {
      ...outcome(),
      report: { risk: "low", summary: "", files: [], findings: [] },
      partial: "budget-estimate",
      unreviewed: ["src/file.ts"],
      cost: undefined,
      sessions: [],
      specialists: [],
      passes: undefined,
    }
    const stored: LocalResult = JSON.parse(
      JSON.stringify({
        ...result(stopped),
        exitCode: 2,
        error: "Not reviewed. The estimated review exceeded the configured budget before any model request.",
      }),
    )
    expect(stored.verdict).toEqual({ verdict: "not-reviewed", causes: ["budget-estimate"], notes: [] })
    expect(decodeLocalResult(stored, target)).toEqual(stored)
    expect((await decode(await info(stored, "failed")))?.verdict).toEqual(stored.verdict)
    expect(decodeLocalResult({ ...stored, verdict: result().verdict }, target)).toBeUndefined()
    const strict = {
      version: 1,
      head,
      complete: false,
      incomplete: ["budget-estimate", "unreviewed", "no-reviewer"],
      findings: [],
      dropped: [],
      fixUnchecked: 0,
    }
    const strictStop = (value: unknown) =>
      decodeLocalResult({ ...stored, outcome: { ...stored.outcome, strict: value } }, target)
    expect(strictStop(strict)?.verdict).toEqual(stored.verdict)
    expect(strictStop({ ...strict, complete: true })).toBeUndefined()
    expect(strictStop({ ...strict, incomplete: ["no-reviewer"] })).toBeUndefined()
    // The live first-request check runs after a private helper exists. Its retained session explains
    // the refusal, while the specialist has zero steps and no usage or completed review.
    const changedRequest =
      "Not reviewed. The prepared model request could no longer be confirmed to fit the configured budget."
    const prepared = {
      ...stored.outcome!,
      sessions: ["ses_helper"],
      specialists: [{ name: "review", status: "skipped", detail: "first-request-changed", steps: 0 }] as const,
      notes: [changedRequest],
    }
    const retained = { ...stored, outcome: prepared, error: changedRequest }
    expect(decodeLocalResult(retained, target)?.verdict).toEqual(stored.verdict)
    for (const wrong of [
      { sessions: [] },
      { sessions: ["one", "two"] },
      { specialists: [{ ...prepared.specialists[0], steps: 1 }] },
      { specialists: [{ ...prepared.specialists[0], status: "ok" }] },
      { cost: outcome().cost },
    ])
      expect(decodeLocalResult({ ...retained, outcome: { ...prepared, ...wrong } }, target)).toBeUndefined()
    for (const changed of [
      { exitCode: 0 },
      { error: "" },
      { outcome: { ...stored.outcome, partial: "steps" } },
      { outcome: { ...stored.outcome, trivial: true } },
      { outcome: { ...stored.outcome, sessions: outcome().sessions } },
      { outcome: { ...stored.outcome, specialists: outcome().specialists } },
      { outcome: { ...stored.outcome, passes: outcome().passes } },
      { outcome: { ...stored.outcome, cost: outcome().cost } },
      { outcome: { ...stored.outcome, unreviewed: [] } },
      { outcome: { ...stored.outcome, unreviewed: ["src/file.ts", "src/file.ts"] } },
      { outcome: { ...stored.outcome, skipped: [{ path: "other.ts", reason: "size-limit" }] } },
    ])
      expect(decodeLocalResult({ ...stored, ...changed }, target)).toBeUndefined()
  })

  test("an exact zero-attempt policy skip round-trips while mixed provider work cannot claim a skip", () => {
    const value = outcome()
    const skipped: ReviewOutcome = {
      ...value,
      trivial: true,
      cost: undefined,
      specialists: [],
      sessions: [],
      passes: [],
    }
    const stored = result(skipped)
    expect(stored.verdict).toEqual({ verdict: "policy-skip", causes: ["trivial"], notes: [] })
    expect(decodeLocalResult(JSON.parse(JSON.stringify(stored)), target)?.outcome?.trivial).toBe(true)
    const strict = {
      version: 1 as const,
      head,
      complete: false,
      incomplete: ["no-reviewer"],
      findings: [],
      dropped: [],
      fixUnchecked: 0,
    }
    const read = (value: ReviewOutcome) => decodeLocalResult(JSON.parse(JSON.stringify(result(value))), target)
    expect(read({ ...skipped, strict })?.verdict).toEqual(stored.verdict)
    for (const mixed of [{ complete: true }, { incomplete: ["blob-unreadable"] }, { fixUnchecked: 1 }])
      expect(read({ ...skipped, strict: { ...strict, ...mixed } })).toBeUndefined()
    for (const mixed of [
      { cost: value.cost },
      { sessions: value.sessions },
      { specialists: value.specialists },
      { passes: value.passes },
      { unreviewed: ["unsafe.ts"] },
      { partial: "timeout" as const },
      { report: { ...value.report, files: [{ path: "unsafe.ts", note: "Reviewed" }] } },
    ]) {
      expect(decodeLocalResult(JSON.parse(JSON.stringify(result({ ...skipped, ...mixed }))), target)).toBeUndefined()
    }
    for (const trivial of [false, "true", null])
      expect(decodeLocalResult({ ...stored, outcome: { ...skipped, trivial } }, target)).toBeUndefined()
  })

  test("reopening a graph review preserves incomplete diff coverage and omitted files", async () => {
    const value = outcome()
    value.selection.diffIncomplete = true
    value.unreviewed = ["src/large.ts"]
    const decoded = await decode(await info(result(value)))
    expect(decoded?.verdict.verdict).toBe("incomplete")
    expect(decoded?.result?.outcome?.selection.diffIncomplete).toBe(true)
    expect(decoded?.result?.outcome?.unreviewed).toEqual(["src/large.ts"])
  })

  test("keeps placed findings, optional strict data and usage while withholding serialized own-usage proof", async () => {
    const value = outcome()
    const finding = {
      id: "finding_1",
      path: "src/file.ts",
      line: 1,
      side: "RIGHT" as const,
      source: "review" as const,
      severity: "blocking" as const,
      category: "bug" as const,
      title: "Defect",
      body: "Trigger and consequence.",
      confidence: 0.9,
      verified: true,
      verifiedBy: "model" as const,
      quotes: [{ path: "src/file.ts", line: 1, side: "RIGHT" as const, code: "throw Error()" }],
    }
    value.selection.strict = { complete: true, findingCount: 1, dropped: [{ reason: "not-blocking", count: 2 }] }
    value.report.findings.push(finding)
    value.selection.inline.push({
      ...finding,
      anchor: { path: finding.path, side: finding.side, line: 1, hunk: 0 },
      suggestionAllowed: false,
    })
    value.strict = {
      version: 1,
      head,
      complete: true,
      findings: [
        {
          id: finding.id,
          class: "crash",
          mechanism: "logic",
          path: finding.path,
          line: 1,
          side: "RIGHT",
          title: finding.title,
          trigger: "Input",
          impact: "Crash",
          quotes: finding.quotes,
          fix: { kind: "unchecked", text: "Handle input." },
          verifiedBy: "model",
          verifier: "provider/reviewer",
        },
      ],
      dropped: [{ reason: "not-blocking", count: 2 }],
      fixUnchecked: 1,
    }
    const original = result(value)
    const run = await info(original)
    const decoded = await decode(run)
    expect(decoded?.verdict.verdict).toBe("blocking")
    expect(decoded?.result?.outcome?.selection).toEqual(value.selection)
    expect(decoded?.result?.outcome?.strict).toEqual(value.strict)
    expect(decoded?.result?.outcome?.passes).toEqual(value.passes)
    const cost = value.cost
    if (!cost) throw new Error("The usage fixture must contain its measured cost.")
    expect(decoded?.result?.outcome?.cost).toEqual({ ...cost, tokensOwnOnly: false })
    expect(value.cost?.tokensOwnOnly).toBe(true)
    expect(run.artifact!.json).toContain('"tokensOwnOnly":true')
    for (const summary of [
      { ...value.selection.strict, complete: false },
      { ...value.selection.strict, findingCount: 0 },
      { ...value.selection.strict, dropped: [] },
    ]) {
      expect(
        decodeLocalResult(result({ ...value, selection: { ...value.selection, strict: summary } }), target),
      ).toBeUndefined()
    }
    const missing = { ...value }
    delete missing.strict
    expect(decodeLocalResult(result(missing), target)).toBeUndefined()
  })

  // scope-finish takeover (2026-11-23): under the hidden `review.diagnostics: "offline"` on Linux, Review.run keeps the
  // offline-diagnostic provenance withDiagnosticEvidence sets on a finding (Finding.diagnostics) through selection and,
  // with lenses on, in report.findings. The saved local review must read back, not as a corrupt outcome.
  test("findings that carry offline-diagnostic provenance round-trip in every selection list and the report", async () => {
    const anchors = parseUnifiedDiff(
      "diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1,2 @@\n-old\n+key()\n+tail()\n",
    )
    const shape = {
      side: "RIGHT" as const,
      source: "security" as const,
      category: "security" as const,
      body: "An added line carries a credential.",
      confidence: 0.9,
    }
    const cited = (finding: Omit<Finding, "evidence">) => ({
      ...finding,
      evidence: [`${finding.path}:${finding.line}`, diagnosticCitation("secret-added")],
    })
    const modelFindings: Finding[] = [
      cited({ ...shape, id: "inline_1", path: "src/file.ts", line: 1, severity: "blocking", title: "Hard-coded deploy token" }),
      cited({ ...shape, id: "nit_1", path: "src/file.ts", line: 2, severity: "nit", title: "Logged request header" }),
      cited({ ...shape, id: "outside_1", path: "src/other.ts", line: 4, severity: "concern", title: "Fixture key in another file" }),
    ]
    const findings = withDiagnosticEvidence(
      modelFindings,
      modelFindings.map((finding) => ({
        source: "offline-v1" as const,
        rule: "secret-added" as const,
        path: finding.path,
        line: finding.line,
        side: "RIGHT" as const,
      })),
    )
    expect(findings.map((finding) => finding.diagnostics)).toEqual(
      findings.map(() => [{ source: "offline-v1", rule: "secret-added" }]),
    )
    const value = outcome()
    value.selection = selectFindings({
      findings,
      anchors,
      head,
      trust: "trusted",
      mode: "full",
      config: { ...DEFAULT_REVIEW_CONFIG, nits: true },
      prior: [],
      knownPath: () => true,
    })
    // The lens path keeps the normalized findings as the report's ModelFinding list.
    value.report.findings = findings
    const placed = [
      ...value.selection.inline,
      ...value.selection.nits,
      ...value.selection.outsideDiff,
      ...value.selection.elsewhere,
      ...value.selection.overflow,
    ]
    expect(placed).toHaveLength(3)
    expect(placed.every((finding) => finding.diagnostics?.[0]?.rule === "secret-added")).toBe(true)
    const stored: LocalResult = JSON.parse(JSON.stringify(result(value)))
    const decoded = decodeLocalResult(stored, target)
    expect(decoded?.outcome?.selection).toEqual(value.selection)
    expect(decoded?.outcome?.report.findings).toEqual(findings)
    for (const status of ["completed", "failed"] as const)
      expect((await decode(await info(stored, status)))?.result?.outcome?.selection).toEqual(value.selection)
    // The rules are exactly the versioned offline ones, and an entry takes no other key.
    expect(Object.keys(OFFLINE_DIAGNOSTIC_RULES).toSorted()).toEqual(
      ["integrity-removed", "manifest-without-lock", "secret-added"].toSorted(),
    )
    for (const rule of Object.keys(OFFLINE_DIAGNOSTIC_RULES)) {
      const row = { ...value.selection.inline[0], diagnostics: [{ source: "offline-v1", rule }] }
      const other = { ...value, selection: { ...value.selection, inline: [row] } }
      expect(decodeLocalResult(JSON.parse(JSON.stringify(result(other as ReviewOutcome))), target)).toBeDefined()
    }
    for (const diagnostics of [
      [{ source: "offline-v1", rule: "unknown-rule" }],
      [{ source: "offline-v2", rule: "secret-added" }],
      [{ source: "offline-v1", rule: "secret-added", path: "src/file.ts" }],
      { source: "offline-v1", rule: "secret-added" },
    ]) {
      const inline = [{ ...value.selection.inline[0], diagnostics }]
      const report = { ...value.report, findings: [{ ...findings[0], diagnostics }] }
      for (const other of [
        { ...value, selection: { ...value.selection, inline } },
        { ...value, report },
      ])
        expect(decodeLocalResult(JSON.parse(JSON.stringify({ ...stored, outcome: other })), target)).toBeUndefined()
    }
  })

  test("rejects target/head mismatches, unknown coverage/status fields, malformed selection and contradictory verdicts", async () => {
    for (const value of [
      { ...result(), target: { ...result().target, head: base } },
      { ...result(), target: { ...result().target, kind: "pr" } },
      { ...result(), outcome: { ...outcome(), head: base } },
      { ...result(), outcome: { ...outcome(), partial: "unknown-stop" } },
      { ...result(), outcome: { ...outcome(), specialists: [{ name: "review", status: "unknown", steps: 0 }] } },
      { ...result(), outcome: { ...outcome(), skipped: [{ path: "src/file.ts", reason: "unknown" }] } },
      { ...result(), outcome: { ...outcome(), unreviewed: undefined } },
      { ...result(), outcome: { ...outcome(), selection: { ...outcome().selection, inline: [null] } } },
      { ...result(), outcome: { ...outcome(), injectedAuthority: "allow" } },
      { ...result(), verdict: { verdict: "clean-complete", causes: ["made-up"], notes: [] } },
      { ...result(), exitCode: 2 },
      { ...result(), error: "Cannot run" },
    ])
      expect(decodeLocalResult(value, target)).toBeUndefined()
    const partial = outcome()
    partial.unreviewed = ["src/file.ts"]
    expect(decodeLocalResult({ ...result(partial), verdict: result().verdict }, target)).toBeUndefined()
    expect(await decode({ ...(await info()), status: "future-status" })).toBeUndefined()
  })

  // VS-34 (SF-13a): the decoder takes every SkippedFile reason the types name, so a held-back row decodes, but only
  // beside the verdict reviewVerdict recomputes for it: a forged clean label is refused.
  test("decodes a held-back skip only beside its canonical incomplete verdict", () => {
    const held = outcome()
    held.skipped = [{ path: "config/prod/.envrc", reason: "held-back" }]
    const decoded = decodeLocalResult(result(held), target)
    expect(decoded?.outcome?.skipped).toEqual([{ path: "config/prod/.envrc", reason: "held-back" }])
    expect(decoded?.verdict).toEqual({ verdict: "incomplete", causes: ["held-back"], notes: [] })
    expect(decodeLocalResult({ ...result(held), verdict: result().verdict }, target)).toBeUndefined()
    expect(result().verdict.verdict).toBe("clean-complete")
  })

  // SF-13b: Review.run records each held file in `skipped` and its status in `held`, so a held deletion only reads
  // clean-complete with its note. The decoder takes `held`, so that retained result survives a round trip; without it
  // the recomputed verdict would be incomplete and the result dropped.
  test("round-trips a held deletion's clean result through `held`, and refuses a held entry it cannot read", async () => {
    const deletion = outcome()
    deletion.skipped = [{ path: ".env", reason: "held-back" }]
    deletion.held = [{ path: ".env", status: "deleted", reason: "env-file" }]
    const stored = result(deletion)
    expect(stored.verdict).toEqual({ verdict: "clean-complete", causes: [], notes: ["held-back-deletion"] })
    const decoded = await decode(await info(JSON.parse(JSON.stringify(stored))))
    expect(decoded?.result?.outcome?.held).toEqual([{ path: ".env", status: "deleted", reason: "env-file" }])
    expect(decoded?.verdict).toEqual(stored.verdict)
    const renamed = outcome()
    renamed.skipped = [{ path: "notes.txt", reason: "held-back" }]
    renamed.held = [{ path: "notes.txt", oldPath: "id_rsa", status: "renamed", reason: "credential-file" }]
    expect(decodeLocalResult(result(renamed), target)?.verdict).toEqual({
      verdict: "incomplete",
      causes: ["held-back"],
      notes: [],
    })
    // An unknown status or reason, or an excess field, is refused rather than read.
    for (const entry of [
      { path: ".env", status: "copied", reason: "env-file" },
      { path: ".env", status: "deleted", reason: "token-file" },
      { path: ".env", status: "deleted", reason: "env-file", sent: false },
      { status: "deleted", reason: "env-file" },
    ])
      expect(decodeLocalResult({ ...stored, outcome: { ...deletion, held: [entry] } }, target)).toBeUndefined()
    // A held-back skip with no `held` still decodes only as incomplete.
    const bare = outcome()
    bare.skipped = [{ path: ".env", reason: "held-back" }]
    expect(decodeLocalResult({ ...result(bare), verdict: stored.verdict }, target)).toBeUndefined()
    // And a skip for another file than the held deletion is incomplete by path.
    const other = outcome()
    other.skipped = [{ path: "id_rsa", reason: "held-back" }]
    other.held = [{ path: ".env", status: "deleted", reason: "env-file" }]
    expect(decodeLocalResult({ ...result(other), verdict: stored.verdict }, target)).toBeUndefined()
    expect(decodeLocalResult(result(other), target)?.verdict.verdict).toBe("incomplete")
  })

  test("binds a valid result to its expected parent, retry request and known run identity", async () => {
    const run = await info()
    for (const expected of [
      { ...expectedRun, parentID: "ses_other_parent" },
      { ...expectedRun, runID: "ses_other_run" },
      { ...expectedRun, request: { ...expectedRun.request, requestID: "request_other_1" } },
      { ...expectedRun, request: { ...expectedRun.request, maxCost: 0.1 } },
      { ...expectedRun, request: { ...expectedRun.request, target: { ...target, head: base } } },
    ])
      expect(await decodeLocalRun(run, expected)).toBeUndefined()
    expect(await decodeLocalRun(run, { ...expectedRun, runID: run.runID })).toBeDefined()
  })

  test("never displays clean from running, cancelled, failed, interrupted or uncertain lifecycle state", async () => {
    for (const state of ["running", "cancelled", "failed", "interrupted", "unknown"] as const) {
      const decoded = await decode(await info(result(), state))
      expect(decoded?.result?.outcome?.report.summary).toBe("Completed review")
      expect(decoded?.verdict.verdict).toBe("incomplete")
    }
    const complete = await decode(await info())
    expect(complete?.verdict.verdict).toBe("clean-complete")
    const { artifact: _artifact, ...empty } = await info()
    expect((await decode(empty))?.verdict.verdict).toBe("not-reviewed")
  })

  test("checks byte bounds, digest, version, JSON and complete stored-result shape before trusting a label", async () => {
    const run = await info()
    for (const invalid of [
      { ...run.artifact!, version: 2 },
      { ...run.artifact!, json: `${run.artifact!.json} ` },
      { ...run.artifact!, bytes: run.artifact!.bytes - 1 },
      { ...run.artifact!, bytes: ReviewRun.RESULT_BYTES + 1 },
      await artifact(null),
      await artifact({ verdict: { verdict: "clean-complete", causes: [], notes: [] } }),
    ])
      expect(await decode({ ...run, artifact: invalid })).toBeUndefined()
    const malformed = "not json"
    expect(
      await decode({
        ...run,
        artifact: { version: 1, json: malformed, bytes: malformed.length, sha256: await hash(malformed) },
      }),
    ).toBeUndefined()
    const unicode = result()
    unicode.outcome!.report.summary = "Review 🔍"
    expect(await decode(await info(unicode))).toBeDefined()
    expect(
      await decode({
        ...(await info(unicode)),
        artifact: { ...(await artifact(unicode)), bytes: JSON.stringify(unicode).length },
      }),
    ).toBeUndefined()
  })

  test("keeps failed/no-change results distinct from clean and accepts staged targets only for their matching request", async () => {
    const failure: LocalResult = {
      exitCode: 2,
      error: "Model unavailable",
      verdict: reviewVerdict({ kind: "failure", stage: "review" }),
    }
    expect(decodeLocalResult(failure, target)?.verdict).toEqual({
      verdict: "incomplete",
      causes: ["review-error"],
      notes: [],
    })
    const empty: LocalResult = {
      exitCode: 0,
      target: result().target,
      verdict: reviewVerdict({ kind: "failure", stage: "start" }),
    }
    expect(decodeLocalResult(empty, target)?.verdict.verdict).toBe("not-reviewed")
    const staged = { ...result(), target: { ...result().target!, kind: "staged" as const } }
    expect(decodeLocalResult(staged, { ...target, kind: "staged" })).toBeDefined()
    expect(decodeLocalResult(staged, target)).toBeUndefined()
  })

  test("retains exact non-clean pre-start/configuration failures and rejects a failure's forged clean label", async () => {
    for (const [stage, cause] of [
      ["config", "config-error"],
      ["start", "start-error"],
    ] as const) {
      const failure: LocalResult = {
        exitCode: 2,
        error: stage === "start" ? "The review was cancelled before it started." : "Invalid review invocation.",
        verdict: reviewVerdict({ kind: "failure", stage }),
      }
      expect(decodeLocalResult(failure, target)?.verdict).toEqual({
        verdict: "not-reviewed",
        causes: [cause],
        notes: [],
      })
      const decoded = await decode(await info(failure, stage === "start" ? "cancelled" : "failed"))
      expect(decoded?.verdict).toEqual({ verdict: "not-reviewed", causes: [cause], notes: [] })
      expect(decoded?.result?.error).toBe(failure.error)
      expect(decodeLocalResult({ ...failure, verdict: result().verdict }, target)).toBeUndefined()
      expect(
        decodeLocalResult(
          { ...failure, verdict: { verdict: "not-reviewed", causes: ["future-error"], notes: [] } },
          target,
        ),
      ).toBeUndefined()
    }
  })
})
