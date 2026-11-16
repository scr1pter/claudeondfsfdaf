import { describe, expect, test } from "bun:test"
import { postingPlan, type ReviewVerdict } from "../../src/review/verdict"

describe("review posting plan", () => {
  test("zero-attempt and policy skips never create a review even with inline candidates", () => {
    for (const failOn of ["never", "blocking", "blocking-or-incomplete"] as const)
      for (const verdict of ["not-reviewed", "policy-skip"] as const)
        for (const count of [0, 1]) expect(postingPlan(verdict, count, { failOn })).toEqual({ createReview: false })
  })

  test("completed verdicts create reviews only for inline findings, without an incomplete marker", () => {
    for (const failOn of ["never", "blocking", "blocking-or-incomplete"] as const)
      for (const verdict of ["blocking", "findings", "clean-complete"] as const) {
        expect(postingPlan(verdict, 0, { failOn })).toEqual({ createReview: false })
        expect(postingPlan(verdict, 1, { failOn })).toEqual({ createReview: true })
      }
  })

  test("only the incomplete gate marks a review whose coverage did not finish", () => {
    for (const failOn of ["never", "blocking", "blocking-or-incomplete"] as const)
      expect(postingPlan("incomplete", 0, { failOn })).toEqual({ createReview: false })
    expect(postingPlan("incomplete", 1, { failOn: "never" })).toEqual({ createReview: true })
    expect(postingPlan("incomplete", 1, { failOn: "blocking" })).toEqual({ createReview: true })
    expect(postingPlan("incomplete", 1, { failOn: "blocking-or-incomplete" })).toEqual({
      createReview: true,
      marker: "<!-- vectorscope-verdict: incomplete -->",
    })
  })

  test("malformed metadata never creates a review", () => {
    for (const count of [-1, NaN, Infinity, 1.5])
      expect(postingPlan("findings", count, { failOn: "never" })).toEqual({ createReview: false })
    expect(postingPlan("unknown" as ReviewVerdict, 1, { failOn: "never" })).toEqual({ createReview: false })
  })
})
