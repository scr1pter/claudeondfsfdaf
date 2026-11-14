import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { ReviewRun } from "../src/review-run"

const start = { requestID: "request_contract_1", target: { kind: "working-tree", head: "a".repeat(40) } }

describe("local review public contracts", () => {
  test("rejects extra authority with the schema's default decoder before an HTTP layer can strip it", () => {
    const decode = Schema.decodeUnknownOption(ReviewRun.Start)
    expect(Option.isSome(decode(start))).toBe(true)
    for (const field of [
      "directory",
      "parentID",
      "settingsRef",
      "readRoot",
      "readDenies",
      "model",
      "config",
      "options",
      "trust",
      "checks",
      "post",
      "consent",
    ])
      expect(Option.isNone(decode({ ...start, [field]: "forged" }))).toBe(true)
    for (const field of ["base", "diff", "instructions", "readDenies"])
      expect(Option.isNone(decode({ ...start, target: { ...start.target, [field]: "forged" } }))).toBe(true)
  })

  test("bounds discovery and never accepts a result body in a summary", () => {
    const decode = Schema.decodeUnknownOption(ReviewRun.ListInput)
    expect(Option.isSome(decode({ limit: 50 }))).toBe(true)
    for (const input of [{ limit: 0 }, { limit: 51 }, { limit: Infinity }, { directory: "/elsewhere" }, { post: true }])
      expect(Option.isNone(decode(input))).toBe(true)
    const summary = {
      runID: "ses_contract_run",
      parentID: "ses_contract_parent",
      request: start,
      status: "completed",
      canStop: false,
      startedAt: 1,
      completedAt: 2,
      hasResult: true,
    }
    expect(Option.isSome(Schema.decodeUnknownOption(ReviewRun.Summary)(summary))).toBe(true)
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(ReviewRun.Summary)({ ...summary, artifact: { json: "private result" } }),
      ),
    ).toBe(true)
  })
})
