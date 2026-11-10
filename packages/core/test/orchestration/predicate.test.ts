import { expect, test } from "bun:test"
import { WorkflowPredicate } from "../../src/orchestration/predicate"

test("fixed comparisons preserve JSON value semantics", () => {
  expect(WorkflowPredicate.evaluate({ equals: { "a b": 1 } }, { "a b": 2 })).toBe(false)
  expect(WorkflowPredicate.evaluate({ equals: { a: 1, b: [2] } }, { b: [2], a: 1 })).toBe(true)
  expect(WorkflowPredicate.evaluate({ path: "n", gt: 3 }, { n: "4" })).toBe(false)
  expect(WorkflowPredicate.evaluate({ path: "n", gte: 3 }, { n: 3 })).toBe(true)
  expect(WorkflowPredicate.evaluate({ path: "n", lt: 4 }, { n: 3 })).toBe(true)
  expect(WorkflowPredicate.evaluate({ path: "n", lte: 3 }, { n: 3 })).toBe(true)
  expect(WorkflowPredicate.evaluate({ path: "n", in: [1, 3] }, { n: 3 })).toBe(true)
  expect(WorkflowPredicate.evaluate({ contains: { n: 1 } }, [{ n: 1 }])).toBe(true)
  expect(WorkflowPredicate.evaluate({ contains: "hello" }, "well hello")).toBe(true)
})

test("logical predicates and absent values have explicit semantics", () => {
  expect(
    WorkflowPredicate.evaluate(
      {
        all: [
          { path: "a", exists: true },
          { path: "a", not_equals: 0 },
        ],
      },
      { a: 1 },
    ),
  ).toBe(true)
  expect(
    WorkflowPredicate.evaluate(
      {
        any: [
          { path: "a", equals: 0 },
          { path: "b", exists: false },
        ],
      },
      { a: 1 },
    ),
  ).toBe(true)
  expect(WorkflowPredicate.evaluate({ not: { path: "a", equals: 0 } }, { a: 1 })).toBe(true)
  expect(WorkflowPredicate.evaluate({ path: "missing", not_equals: 0 }, {})).toBe(false)
  expect(WorkflowPredicate.evaluate({ path: "constructor", exists: true }, {})).toBe(false)
})
