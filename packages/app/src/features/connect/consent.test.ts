import { describe, expect, test } from "bun:test"
import { connectConsentDetails, MAX_DETAILS } from "./consent"

const description =
  "Review your changes with VectorScope on openai/gpt-test. Why this asks: it is priced. Where the diff goes: openai/gpt-test sends it to the provider openai. The review stops at $2.00."

describe("connectConsentDetails", () => {
  test("shows the hub's sentence for connect_model: the model, where the diff goes and the cap", () => {
    const details = connectConsentDetails({
      permission: "connect_model",
      metadata: { description, runID: "cr_01", model: "openai/gpt-test", sendsTo: "provider:openai", maxCostUsd: 2 },
    })
    expect(details).toBe(description)
    expect(details).toContain("openai/gpt-test")
    expect(details).toContain("the provider openai")
    expect(details).toContain("$2.00")
  })

  test("shows it for connect and connect_write too", () => {
    for (const permission of ["connect", "connect_write"])
      expect(
        connectConsentDetails({ permission, metadata: { description: "Review your changes.", runID: "cr_2" } }),
      ).toBe("Review your changes.")
  })

  test("shows nothing for other questions, or for one that is not the hub's", () => {
    expect(connectConsentDetails({ permission: "bash", metadata: { description, runID: "cr_1" } })).toBeUndefined()
    expect(
      connectConsentDetails({ permission: "connector_x", metadata: { description, runID: "cr_1" } }),
    ).toBeUndefined()
    expect(connectConsentDetails({ permission: "connect_model", metadata: { description } })).toBeUndefined()
    expect(
      connectConsentDetails({ permission: "connect_model", metadata: { description, runID: "run_1" } }),
    ).toBeUndefined()
    expect(
      connectConsentDetails({ permission: "connect_model", metadata: { description: 3, runID: "cr_1" } }),
    ).toBeUndefined()
    expect(
      connectConsentDetails({ permission: "connect_model", metadata: { description: "  ", runID: "cr_1" } }),
    ).toBeUndefined()
  })

  test("keeps a long sentence to the dock's limit", () => {
    const details = connectConsentDetails({
      permission: "connect_model",
      metadata: { description: "x".repeat(MAX_DETAILS + 50), runID: "cr_1" },
    })
    expect(details).toHaveLength(MAX_DETAILS)
    expect(details?.endsWith("…")).toBe(true)
  })
})
