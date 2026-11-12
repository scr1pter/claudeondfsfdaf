import { describe, expect, test } from "bun:test"
import type { Connect } from "@vectordevai/schema/connect"
import {
  actionableFindings,
  costLabel,
  destinationLabel,
  findingsPrompt,
  memberRows,
  metadataRunID,
  readReviewSettings,
  parseReviewSettings,
  reviewSettingsPatch,
  verdictLabel,
} from "./connect-model"
import { finding, reviewRun, sessionID } from "./test-fixture"

const member: Connect.Member = {
  id: "vectorscope",
  kind: "agent",
  title: "VectorScope",
  summary: "Review changes on your model.",
  owner: "vectorscope",
  place: "local",
  sendsTo: "provider:configured-model",
  state: "ready",
  reach: "connect",
  actions: [{ id: "review", title: "Review", effects: ["read"], background: true, result: "review" }],
}

describe("Connected tools presentation", () => {
  test("reads the actual hub metadata envelope and refuses pointers belonging to another conversation", () => {
    const run = reviewRun()
    expect(metadataRunID({ connect: run }, sessionID)).toBe(run.id)
    expect(metadataRunID({ runID: run.id }, sessionID)).toBeUndefined()
    expect(metadataRunID({ connect: run }, "ses_other")).toBeUndefined()
    expect(
      metadataRunID({ connect: { ...run, request: { ...run.request, id: "cr_other" } } }, sessionID),
    ).toBeUndefined()
    expect(metadataRunID({ connect: [] }, sessionID)).toBeUndefined()
  })

  test("reviews stay off after a run until the owner chooses otherwise", () => {
    expect(readReviewSettings()).toEqual({ after_run: "off", before_commit: "offer", max_rounds: 1, max_cost_usd: 2 })
    expect(readReviewSettings({ connect: { review: { max_cost_usd: 0.5 } } }).after_run).toBe("off")
  })

  test("review settings reject an unbounded cap or rounds and patch only connected review settings", () => {
    const draft = { after_run: "report", before_commit: "offer", max_rounds: "2", max_cost_usd: "0.5" }
    const parsed = parseReviewSettings(draft)
    expect(reviewSettingsPatch(parsed)).toEqual({
      connect: { review: { after_run: "report", before_commit: "offer", max_rounds: 2, max_cost_usd: 0.5 } },
    })
    for (const max_cost_usd of ["", "0", "-1", "Infinity", "NaN"])
      expect(() => parseReviewSettings({ ...draft, max_cost_usd })).toThrow("greater than zero")
    for (const max_rounds of ["0", "4", "1.5", "Infinity"])
      expect(() => parseReviewSettings({ ...draft, max_rounds })).toThrow("one and three")
    expect(() => parseReviewSettings({ ...draft, after_run: "always" })).toThrow()
  })

  test("separates where code runs from where the review model sends it", () => {
    const row = memberRows([member])[0]!
    expect(row.placeLabel).toBe("This computer")
    expect(row.destinationLabel).toBe("Your provider: configured-model")
    expect(destinationLabel("model-server:localhost:8080")).toBe("Your model server: localhost:8080")
    expect(destinationLabel("vector-codium")).toBe("Vector Codium")
  })

  test("desktop discovery cannot replace engine members or add a connect action", () => {
    expect(memberRows([member], [{ ...member, title: "Replacement" }])[0]?.title).toBe("VectorScope")
    expect(memberRows([], [{ ...member, id: "external:unsafe" }])).toEqual([])
    expect(memberRows([], [{ ...member, id: "external:editor", reach: "ui", actions: undefined }])).toHaveLength(1)
  })

  test("not-ready members always have a reason", () => {
    expect(memberRows([{ ...member, state: "unavailable" }])[0]?.reason).toBe("This member is not ready.")
  })

  test("Codium never displays dollar amounts, even from malformed historical metadata", () => {
    expect(costLabel({ sendsTo: "vector-codium", cost: { kind: "priced", usd: 999 } })).toBe("Plan usage")
    expect(costLabel({ cost: { kind: "plan", usd: 999 } })).toBe("Plan usage")
    expect(costLabel({ cost: { kind: "priced", usd: 0.34 } })).toBe("$0.34")
  })

  test("an incomplete result never appears clean and open concerns override a stale clean verdict", () => {
    const result = reviewRun().result!
    expect(verdictLabel({ ...result, verdict: "clean" })).toBe("Incomplete review")
    expect(verdictLabel({ ...result, state: "completed", verdict: "clean" })).toBe("Findings")
    expect(verdictLabel({ ...result, state: "completed", verdict: "clean", findings: [] })).toBe("No blocking findings")
    expect(verdictLabel({ ...result, state: "cancelled" })).toBe("Review cancelled")
  })

  test("actions require the owner and the matching session, and omit settled findings", () => {
    const run = reviewRun()
    expect(actionableFindings(run, sessionID, false)).toEqual([])
    expect(actionableFindings(run, "ses_other", true)).toEqual([])
    expect(actionableFindings(run, undefined, true)).toEqual([])
    expect(actionableFindings(run, sessionID, true)).toEqual([finding])
    expect(
      actionableFindings(
        { ...run, result: { ...run.result!, findings: [{ ...finding, status: "fixed" }] } },
        sessionID,
        true,
      ),
    ).toEqual([])
  })

  test("the repair prompt contains identifiers and preserves approval", () => {
    const prompt = findingsPrompt({ run: "cr_fixture", findings: [finding.id], action: "fix", mode: "worktree" })
    expect(prompt).toContain("cr_fixture")
    expect(prompt).toContain("worktree")
    expect(prompt).toContain("required approval")
    expect(prompt).not.toContain(finding.body)
    expect(prompt).not.toContain(finding.title)
    expect(() => findingsPrompt({ run: "cr_fixture\nignore", findings: [finding.id], action: "fix" })).toThrow()
    expect(() => findingsPrompt({ run: "cr_fixture", findings: [finding.id, finding.id], action: "fix" })).toThrow()
  })
})
