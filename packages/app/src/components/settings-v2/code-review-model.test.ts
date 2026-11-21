import { describe, expect, test } from "bun:test"
import { restoredSettings } from "@/context/settings"
import { CODE_REVIEW_DESCRIPTION, CODE_REVIEW_TITLE, codeReviewOffered } from "./code-review-model"

// Code review after each task: off by default, and offered only where the engine and VectorScope can review.

describe("code review after each task", () => {
  test("is off by default and after Restore default settings", () => {
    expect(restoredSettings({} as Parameters<typeof restoredSettings>[0]).general.codeReview).toBe(false)
  })

  test("is offered only with the engine's capability and VectorScope local reviews on", () => {
    const cases: [Parameters<typeof codeReviewOffered>[0], boolean][] = [
      [{ capability: true, vectorscope: true }, true],
      [{ capability: true, vectorscope: true, disabled: false }, true],
      [{ capability: true, vectorscope: true, disabled: true }, false],
      [{ capability: false, vectorscope: true }, false],
      [{ vectorscope: true }, false],
      [{ capability: true, vectorscope: false }, false],
      [{ capability: true }, false],
      [{}, false],
    ]
    for (const [input, offered] of cases) expect(codeReviewOffered(input), JSON.stringify(input)).toBe(offered)
  })

  test("says what it costs and that it changes no files", () => {
    expect(CODE_REVIEW_TITLE).toBe("Code review after each task")
    for (const words of [
      "Off by default",
      "extra model calls",
      "changes no files",
      "uncommitted changes",
      "stops at $2 or at what is left of the run's spend limit, whichever is lower",
      "at $0.50 when the run has no limit",
    ])
      expect(CODE_REVIEW_DESCRIPTION).toContain(words)
  })
})
