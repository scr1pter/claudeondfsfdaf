import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@vectordevai/sdk/v2/client"
import { budgetStopCopy, budgetStopNotice } from "./budget-stop-copy"

const assistant = (error: AssistantMessage["error"]) =>
  ({
    id: "msg_assistant",
    sessionID: "ses_1",
    role: "assistant",
    parentID: "msg_user",
    providerID: "anthropic",
    modelID: "claude-sonnet",
    agent: "build",
    mode: "build",
    time: { created: 2 },
    error,
  }) as AssistantMessage

describe("budgetStopNotice", () => {
  test("a budget stop carries the model and agent a continuation runs with", () => {
    const data = { reason: "cap" as const, message: "Spend cap reached", spentUsd: 5.02, capUsd: 5 }
    expect(budgetStopNotice(assistant({ name: "BudgetStopError", data }))).toEqual({
      messageID: "msg_assistant",
      providerID: "anthropic",
      modelID: "claude-sonnet",
      agent: "build",
      error: data,
    })
  })

  test("other errors and no message give no notice", () => {
    expect(budgetStopNotice(assistant({ name: "UnknownError", data: { message: "boom" } }))).toBeUndefined()
    expect(budgetStopNotice(undefined)).toBeUndefined()
  })
})

describe("budgetStopCopy", () => {
  test("cap stops offer a fresh cap of the same size", () => {
    const copy = budgetStopCopy({
      reason: "cap",
      message:
        "Spend cap reached: $5.02 spent against a $5.00 cap for this run. Vector stopped after the step that crossed it.",
      spentUsd: 5.02,
      capUsd: 5,
    })
    expect(copy.title).toBe("Budget stop")
    expect(copy.body).toBe(
      "Spend cap reached: $5.02 spent against a $5.00 cap for this run. Vector stopped after the step that crossed it.",
    )
    expect(copy.spent).toBe("$5.02 of $5.00 spent")
    expect(copy.continueLabel).toBe("Continue with a new $5.00 cap")
    expect(copy.capUsd).toBe(5)
    expect(copy.footnote).toBe("Continuing starts a new run with its own cap.")
  })

  test("a predicted stop prints its estimate as a range with an en dash", () => {
    const copy = budgetStopCopy({
      reason: "predicted",
      message: "Stopped before the next step",
      spentUsd: 4.62,
      capUsd: 5,
      estimate: { lowUsd: 0.41, highUsd: 0.97 },
    })
    expect(copy.title).toBe("Budget stop")
    expect(copy.estimate).toBe("Next step estimated at $0.41–$0.97")
    expect(copy.spent).toBe("$4.62 of $5.00 spent")
    expect(copy.continueLabel).toBe("Continue with a new $5.00 cap")
    expect(copy.capUsd).toBe(5)
  })

  test("an estimate whose ends agree still prints as a range", () => {
    const copy = budgetStopCopy({
      reason: "predicted",
      message: "Stopped",
      capUsd: 5,
      estimate: { lowUsd: 0.5, highUsd: 0.5 },
    })
    expect(copy.estimate).toBe("Next step estimated at $0.50–$0.50")
  })

  test("an unpriced stop renews the cap it ran under", () => {
    const copy = budgetStopCopy({ reason: "unpriced", message: "m", capUsd: 5, unpricedSteps: 40 })
    expect(copy.title).toBe("Budget stop")
    expect(copy.continueLabel).toBe("Continue with a new $5.00 cap")
    expect(copy.capUsd).toBe(5)
  })

  test("a step stop under a cap renews that cap", () => {
    const copy = budgetStopCopy({ reason: "steps", message: "m", spentUsd: 1.2, capUsd: 5 })
    expect(copy.title).toBe("Budget stop")
    expect(copy.continueLabel).toBe("Continue with a new $5.00 cap")
    expect(copy.capUsd).toBe(5)
  })

  test("a step stop without a cap renews the step limit", () => {
    const copy = budgetStopCopy({ reason: "steps", message: "Step limit reached: 60 of 60 steps used for this run." })
    expect(copy.continueLabel).toBe("Continue with a new step limit")
    expect(copy.capUsd).toBeUndefined()
    expect(copy.spent).toBeUndefined()
    expect(copy.estimate).toBeUndefined()
  })

  test("a loop pauses and continues anyway", () => {
    const copy = budgetStopCopy({
      reason: "loop",
      message: "Paused a repeating loop: `bash` failed with the same error 3 times in a row.",
    })
    expect(copy.title).toBe("Loop paused")
    expect(copy.continueLabel).toBe("Continue anyway")
    expect(copy.capUsd).toBeUndefined()
  })

  test("a loop under a cap still continues anyway, and the new run keeps a cap of the same size", () => {
    const copy = budgetStopCopy({ reason: "loop", message: "Paused a repeating loop", spentUsd: 1.1, capUsd: 5 })
    expect(copy.title).toBe("Loop paused")
    expect(copy.continueLabel).toBe("Continue anyway")
    expect(copy.capUsd).toBe(5)
    expect(copy.spent).toBe("$1.10 of $5.00 spent")
  })

  test("a subagent's stop offers no Continue and points to its main session", () => {
    // Its steps count against the main session's stopped run, so a Continue sent to it would stop at once.
    const stops = [
      { reason: "cap" as const, message: "Spend cap reached", spentUsd: 5.02, capUsd: 5 },
      { reason: "loop" as const, message: "Paused a repeating loop" },
      { reason: "steps" as const, message: "Step limit reached: 60 of 60 steps used for this run." },
    ]
    expect(stops.map((stop) => budgetStopCopy(stop, { subagent: true }))).toMatchObject([
      { title: "Budget stop", body: "Spend cap reached", spent: "$5.02 of $5.00 spent", continueLabel: undefined },
      { title: "Loop paused", continueLabel: undefined },
      { title: "Budget stop", continueLabel: undefined },
    ])
    expect(budgetStopCopy(stops[0], { subagent: true }).footnote).toBe(
      "A subagent spends under its main session's run, so it continues from there: a new message or Continue in the main session starts a new run under its own limits.",
    )
  })
})

test("Codium-only step stops expose no dollar cap, while mixed stops retain own-key dollars", () => {
  const copy = budgetStopCopy({
    reason: "steps",
    message: "Step limit reached",
    spentUsd: 0,
    capUsd: 5,
    codiumSteps: 3,
  })
  expect(copy.spent).toBeUndefined()
  expect(copy.continueLabel).toBe("Continue with a new step limit")
  const mixed = budgetStopCopy({
    reason: "cap",
    message: "Spend cap reached",
    spentUsd: 5.02,
    capUsd: 5,
    codiumSteps: 3,
  })
  expect(mixed.spent).toBe("$5.02 of $5.00 spent · Codium steps not counted")
})
