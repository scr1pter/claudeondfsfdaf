import { describe, expect, test } from "bun:test"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionID } from "@vectordevai/schema/session-id"
import { hash } from "../../src/util/encode"
import { decodeLocalResult, decodeLocalRun, type LocalResult } from "../../src/review/local-result"
import { reviewVerdict } from "../../src/review/verdict"
import type { ReviewOutcome } from "../../src/review/types"

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

describe("retained local review result decoding", () => {
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
      dropped: [],
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
