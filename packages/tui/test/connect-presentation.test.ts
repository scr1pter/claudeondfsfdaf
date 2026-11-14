import { describe, expect, test } from "bun:test"
import { connectedMemberLine, connectedRunLine, connectedConsent } from "../src/routes/session/connect-presentation"

describe("connected tool presentation", () => {
  test("shows execution and model destinations independently", () => {
    expect(connectedMemberLine({ state: "ready", place: "local", sendsTo: "provider:chosen", reach: "connect" })).toBe(
      "ready; runs local; sends to provider:chosen; reach: connect",
    )
  })
  test("shows Codium as plan usage without dollar or token counts", () => {
    expect(
      connectedRunLine({
        status: "done",
        result: { summary: "Review done", sendsTo: "vector-codium", cost: { kind: "plan", usd: 20 } },
      }),
    ).toBe("Review done; sent to vector-codium; plan usage")
  })
  test("only identifies connect consent carrying an engine run", () => {
    expect(
      connectedConsent("connect_model", { runID: "cr_123", description: "Use the chosen model, up to $0.50." }),
    ).toBe("Use the chosen model, up to $0.50.")
    expect(connectedConsent("bash", { runID: "cr_123", description: "ignored" })).toBeUndefined()
  })
})
