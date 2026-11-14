import { describe, expect, test } from "bun:test"
import { HostedResult } from "../src/hosted-result"

const id = `jb_${"a".repeat(26)}`
const parent = "ses_parent"
const body = () => ({ job: { id, state: "reported", createdAt: 1790000000000, endedAt: 1790000600000,
  prompt: "DO NOT COPY this remote prompt", pages: ["private page"],
  report: { summary: "Created a proposed fix.", links: [{ title: "Change", url: "https://github.com/a/b/pull/1" }],
    results: [{ criterion: "Tests pass", pass: true, note: "Reported by the agent" }], judged: true,
  },
} })

describe("hosted result receipts", () => {
  test("one bounded outside-content report with stable per-conversation identity", () => {
    const view = HostedResult.decode(body(), id)!
    expect(HostedResult.final(view)).toBe(true)
    expect(HostedResult.receipt(parent, view)).toEqual(HostedResult.receipt(parent, { ...view }))
    expect(HostedResult.receipt("ses_other", view)).not.toEqual(HostedResult.receipt(parent, view))
    const note = HostedResult.note(view)
    expect(note).toContain("Agent-reported success criteria")
    expect(note).toContain("outside content")
    expect(note).toContain("starts no model turn")
    expect(note).not.toContain("DO NOT COPY")
    expect(note).not.toContain("private page")
    expect(note).not.toContain("verified")
  })
  test("rejects mismatched identity, malformed reports, and unsafe links", () => {
    expect(HostedResult.decode(body(), `jb_${"b".repeat(26)}`)).toBeUndefined()
    const unsafe = body()
    unsafe.job.report.links[0]!.url = "javascript:alert(1)"
    expect(HostedResult.decode(unsafe, id)).toBeUndefined()
    const large = body()
    large.job.report.summary = "x".repeat(8001)
    expect(HostedResult.decode(large, id)).toBeUndefined()
  })
  test("running jobs cannot produce a completion receipt", () => {
    const running = HostedResult.decode({ job: { id, state: "running", createdAt: 1790000000000 } }, id)!
    expect(HostedResult.final(running)).toBe(false)
    expect(() => HostedResult.receipt(parent, running)).toThrow()
    expect(() => HostedResult.note(running)).toThrow()
  })
  test("cancelled and missed jobs report their final state without claiming success", () => {
    for (const state of ["cancelled", "missed"] as const) {
      const view = HostedResult.decode({ job: { id, state, createdAt: 1790000000000 } }, id)!
      expect(HostedResult.note(view)).toContain(state)
      expect(HostedResult.note(view)).toContain("No finished report")
    }
  })
})
