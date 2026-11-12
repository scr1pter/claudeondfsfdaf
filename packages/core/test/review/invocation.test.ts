import { describe, expect, test } from "bun:test"
import { invocationProblems, type ReviewInvocation } from "../../src/review/invocation"

const invocation: ReviewInvocation = {
  version: 1,
  mode: "review",
  directory: "/repo",
  target: { kind: "working-tree", head: "a".repeat(40) },
  settingsRef: "b".repeat(40),
}

describe("review invocation", () => {
  test("accepts a local request with no GitHub identity or network prerequisite", () => {
    expect(invocationProblems(invocation)).toEqual([])
    expect(invocationProblems({ ...invocation, readRoot: "/original-checkout" })).toEqual([])
    expect(invocationProblems({ ...invocation, readDenies: ["private/*", "*.env"], maxCost: 0.5 })).toEqual([])
    expect(
      invocationProblems({ ...invocation, target: { kind: "branch", head: "a".repeat(64), base: "b".repeat(64) } }),
    ).toEqual([])
  })

  test("refuses moving refs, unknown execution modes and caller-supplied execution authority", () => {
    for (const target of [
      { kind: "branch", head: "a".repeat(40) },
      { kind: "working-tree", head: "HEAD" },
      { kind: "working-tree", head: "a".repeat(40), base: "main" },
      { kind: "pull-request", head: "a".repeat(40) },
    ])
      expect(invocationProblems({ ...invocation, target } as ReviewInvocation).length).toBeGreaterThan(0)
    for (const field of ["checks", "post", "trust", "config", "consent"])
      expect(invocationProblems({ ...invocation, [field]: true })).toContain(`field:${field}`)
    expect(invocationProblems({ ...invocation, mode: "fix" } as unknown as ReviewInvocation)).toContain("mode")
    expect(invocationProblems({ ...invocation, settingsRef: "HEAD" })).toContain("settingsRef")
  })

  test("rejects malformed budgets and read-denial lists instead of dropping them", () => {
    for (const maxCost of [0, -1, NaN, Infinity])
      expect(invocationProblems({ ...invocation, maxCost })).toContain("maxCost")
    for (const readDenies of [[""], ["bad\0path"], ["a".repeat(4_097)], Array(1_001).fill("*")])
      expect(invocationProblems({ ...invocation, readDenies })).toContain("readDenies")
    for (const readRoot of ["", "relative/root", "bad\0root"])
      expect(invocationProblems({ ...invocation, readRoot })).toContain("readRoot")
    expect(
      invocationProblems({ ...invocation, target: { ...invocation.target, config: {} } } as ReviewInvocation),
    ).toContain("target.field:config")
    expect(invocationProblems(undefined as unknown as ReviewInvocation)).toEqual(["invocation"])
  })
})
