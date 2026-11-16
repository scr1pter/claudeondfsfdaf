import { describe, expect, test } from "bun:test"
import {
  decideSkip,
  PAUSED_LABEL,
  type SkipDecision,
  type SkipInput,
  type SkipReason,
} from "@vectordevai/core/review/skip"
import { DEFAULT_REVIEW_CONFIG, type ReviewState } from "@vectordevai/core/review/types"

const head = "d4e5f6a" + "0".repeat(33)
const older = "a1b2c3d" + "0".repeat(33)

function state(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    v: 1,
    head: older,
    reviews: 1,
    costUsd: 0.2,
    tokens: [1_000, 100],
    unreviewed: [],
    inlinePosted: 0,
    findings: [],
    ...overrides,
  }
}

function input(overrides: Partial<SkipInput> = {}, pr: Partial<SkipInput["pr"]> = {}): SkipInput {
  return {
    trigger: "auto",
    config: DEFAULT_REVIEW_CONFIG,
    head,
    state: state(),
    size: { files: 3, changedLines: 120 },
    ...overrides,
    pr: { draft: false, author: "alice", labels: [], headBranch: "feature/x", fork: false, ...pr },
  }
}

const command = { trigger: "command" as const }
const run: SkipDecision = { skip: false, trust: "trusted" }

describe("decideSkip", () => {
  test("runs a normal pull request", () => {
    expect(decideSkip(input())).toEqual(run)
    expect(decideSkip(input({ state: undefined }))).toEqual(run)
  })

  test("1. stops every run at the month budget", () => {
    const month = { config: { ...DEFAULT_REVIEW_CONFIG, maxCostUsdPerMonth: 50 }, monthCostUsd: 50 }
    expect(decideSkip(input(month))).toEqual({ skip: true, reason: "month-budget", notify: "summary" })
    expect(decideSkip(input({ ...month, ...command }))).toEqual({
      skip: true,
      reason: "month-budget",
      notify: "summary",
    })
    expect(decideSkip(input({ ...month, state: state({ notedHead: head }) }))).toEqual({
      skip: true,
      reason: "month-budget",
      notify: "none",
    })
    expect(decideSkip(input({ ...month, monthCostUsd: 49.99 }))).toEqual(run)
    expect(decideSkip(input({ monthCostUsd: 10_000 }))).toEqual(run)
  })

  test("2. skips paused and skip-labelled pull requests", () => {
    expect(decideSkip(input({}, { labels: [PAUSED_LABEL] }))).toEqual({ skip: true, reason: "label", notify: "none" })
    expect(decideSkip(input({}, { labels: ["No-Review"] }))).toMatchObject({ reason: "label" })
    const custom = { config: { ...DEFAULT_REVIEW_CONFIG, skipLabels: [] } }
    expect(decideSkip(input(custom, { labels: ["vector:paused"] }))).toMatchObject({ reason: "label" })
    expect(decideSkip(input(custom, { labels: ["vector:skip"] }))).toEqual(run)
  })

  test("3-5. skips drafts, skip authors and skip branches", () => {
    expect(decideSkip(input({}, { draft: true }))).toMatchObject({ reason: "draft" })
    expect(decideSkip(input({}, { author: "Renovate[bot]" }))).toMatchObject({ reason: "author" })
    const branches = { config: { ...DEFAULT_REVIEW_CONFIG, skipBranches: ["release/*"] } }
    expect(decideSkip(input(branches, { headBranch: "release/1.2" }))).toMatchObject({ reason: "branch" })
    expect(decideSkip(input(branches, { headBranch: "release/1.2/hotfix" }))).toEqual(run)
  })

  test("6. never reviews a fork automatically, and reviews one on command untrusted", () => {
    expect(decideSkip(input({}, { fork: true }))).toMatchObject({ reason: "fork" })
    expect(decideSkip(input(command, { fork: true }))).toEqual({ skip: false, trust: "untrusted" })
  })

  test("7. skips a commit that is already reviewed, unless a run was partial or failed", () => {
    const done = { state: state({ head }) }
    expect(decideSkip(input(done))).toEqual({ skip: true, reason: "already-reviewed", notify: "none" })
    expect(decideSkip(input({ ...done, ...command }))).toEqual({
      skip: true,
      reason: "already-reviewed",
      notify: "reply",
    })
    expect(decideSkip(input({ ...done, ...command, full: true }))).toEqual(run)
    expect(decideSkip(input({ state: state({ head, unreviewed: ["a.ts"] }) }))).toEqual(run)
    expect(decideSkip(input({ state: state({ head, failed: true }) }))).toEqual(run)
  })

  test("8. stops automatic runs at the pull request budget, noting it once per commit", () => {
    const spent = { state: state({ costUsd: 10.24 }) }
    expect(decideSkip(input(spent))).toEqual({ skip: true, reason: "pr-budget", notify: "summary" })
    expect(decideSkip(input({ state: state({ costUsd: 10.24, notedHead: head }) }))).toMatchObject({ notify: "none" })
    expect(decideSkip(input({ ...spent, ...command }))).toEqual(run)
    expect(decideSkip(input({ ...spent, config: { ...DEFAULT_REVIEW_CONFIG, maxCostUsdPerPr: 0 } }))).toEqual(run)
  })

  test("9. has nothing to review when every file is ignored", () => {
    const empty = { size: { files: 0, changedLines: 0 } }
    expect(decideSkip(input(empty))).toEqual({ skip: true, reason: "nothing-to-review", notify: "summary" })
    expect(decideSkip(input({ ...empty, ...command }))).toEqual({
      skip: true,
      reason: "nothing-to-review",
      notify: "summary",
    })
  })

  test("10. skips a pull request over the size limits unless a command asks", () => {
    expect(decideSkip(input({ size: { files: 301, changedLines: 10 } }))).toMatchObject({ reason: "too-large" })
    expect(decideSkip(input({ size: { files: 3, changedLines: 5_001 } }))).toMatchObject({ reason: "too-large" })
    expect(decideSkip(input({ size: { files: 300, changedLines: 5_000 } }))).toEqual(run)
    expect(decideSkip(input({ size: { files: 412, changedLines: 18_230 }, ...command }))).toEqual(run)
  })

  test("applies the rules in order", () => {
    const month = { config: { ...DEFAULT_REVIEW_CONFIG, maxCostUsdPerMonth: 1 }, monthCostUsd: 2 }
    expect(decideSkip(input(month, { labels: [PAUSED_LABEL] }))).toMatchObject({ reason: "month-budget" })
    expect(decideSkip(input({}, { labels: [PAUSED_LABEL], draft: true }))).toMatchObject({ reason: "label" })
    expect(decideSkip(input({ state: state({ head, costUsd: 99 }) }))).toMatchObject({ reason: "already-reviewed" })
    expect(decideSkip(input({ state: state({ costUsd: 99 }), size: { files: 0, changedLines: 0 } }))).toMatchObject({
      reason: "pr-budget",
    })
  })

  test("a command overrides rules 2-5, 8 and 10 together", () => {
    const everything = input(
      {
        ...command,
        config: { ...DEFAULT_REVIEW_CONFIG, skipBranches: ["wip/*"] },
        state: state({ costUsd: 50 }),
        size: { files: 999, changedLines: 99_999 },
      },
      { labels: [PAUSED_LABEL, "vector:skip"], draft: true, author: "dependabot[bot]", headBranch: "wip/x" },
    )
    expect(decideSkip(everything)).toEqual(run)
  })
})

// VS-24c: "trivial" is a SkipReason as a type only. decideSkip never gives it, whatever the config says: the GitHub
// job's trivial skip goes through decideSkip state only after the @vector merge.
describe("the trivial reason", () => {
  test("is a SkipReason that decideSkip never returns", () => {
    // Types only: the name VS-32 maps to policy-skip is exactly "trivial".
    const reason: SkipReason = "trivial"
    // @ts-expect-error a misspelled reason is not a SkipReason
    const misspelled: SkipReason = "trivial-skip"
    void [reason, misspelled]
    const trivial = { ...DEFAULT_REVIEW_CONFIG, trivial: "skip" as const }
    for (const trigger of ["auto", "command"] as const) {
      for (const size of [
        { files: 1, changedLines: 1 },
        { files: 3, changedLines: 120 },
      ]) {
        const decision = decideSkip(input({ trigger, config: trivial, size }))
        expect(decision).toEqual({ skip: false, trust: "trusted" })
        expect(decideSkip(input({ trigger, size }))).toEqual(decision)
      }
    }
  })
})
