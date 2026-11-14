import { expect, test } from "bun:test"
import type { ReviewOutcome } from "@vectordevai/core/review/types"
import { reviewForOutput } from "../../src/cli/cmd/review-output"

test("an explicit Codium aggregate wins over stale own-looking model identity in JSON", () => {
  const own = {
    name: "security" as const,
    model: "own/coder",
    costKind: "priced" as const,
    costUsd: 0.12,
    input: 100,
    output: 20,
    cacheRead: 0,
  }
  const result = reviewForOutput({
    cost: {
      kind: "codium",
      model: "anthropic/sonnet",
      costUsd: 99,
      input: 987654,
      output: 1234,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    passes: [own],
  } as ReviewOutcome)
  expect(result.cost).toEqual({ kind: "codium", model: "anthropic/sonnet" })
  expect(result.passes).toEqual([own])
  expect(JSON.stringify(result)).not.toContain("987654")
  expect(JSON.stringify(result)).not.toContain('"costUsd":99')
})

test("an own pass with a receipt but no usage omits numeric token fields in JSON", () => {
  const result = reviewForOutput({
    cost: {
      kind: "unknown",
      codium: true,
      model: "Multiple models",
      costUsd: 0.12,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    passes: [
      {
        name: "security",
        model: "own/coder",
        costKind: "unknown",
        usageMissing: true,
        costUsd: 0.12,
        input: 0,
        output: 0,
        cacheRead: 0,
      },
    ],
  } as ReviewOutcome)
  const printed = JSON.parse(JSON.stringify(result))
  expect(printed.cost).toMatchObject({ costUsd: 0.12, billing: "codium", kind: "unknown" })
  expect(printed.passes[0]).toMatchObject({ costUsd: 0.12, usageMissing: true })
  expect(printed.passes[0]).not.toHaveProperty("input")
})
