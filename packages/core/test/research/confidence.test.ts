import { describe, expect, test } from "bun:test"
import type { Research } from "@vectordevai/schema/research"
import { ResearchConfidence } from "../../src/research/confidence"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()

const note = (id: string, fields: Partial<Research.Note> = {}): Research.Note => ({
  id,
  subquestion: "1",
  claim: "Heat pumps cut delivered heating energy by 61 percent",
  source: "S1",
  quote: "used 61 percent less delivered energy for heating",
  stance: "supports",
  support: true,
  created_at: 0,
  ...fields,
})
const cited = (
  id: string,
  site: string,
  primary: boolean,
  fields: Partial<Research.Note> = {},
): ResearchConfidence.Cited => ({
  note: note(id, fields),
  site,
  primary,
})
const level = (items: readonly ResearchConfidence.Cited[], judged = false) =>
  ResearchConfidence.section(items, { judged })

describe("ResearchConfidence.section", () => {
  test("is High with stated quotes from 2 independent sites, one primary, and nothing against", () => {
    expect(level([cited("N1", "nature.com", true), cited("N2", "bbc.co.uk", false)])).toEqual({
      level: "high",
      disagree: false,
      removed: [],
    })
  })

  test("is not High from two notes on one site", () => {
    expect(level([cited("N1", "nature.com", true), cited("N2", "nature.com", true)]).level).toBe("medium")
  })

  test("does not count the same publication mirrored on multiple sites twice", () => {
    const items = [
      { ...cited("N1", "journal.example", true), lineage: ["doi:10.1000/study"] },
      { ...cited("N2", "news.example", true), lineage: ["doi:10.1000/study"] },
    ]
    expect(level(items).level).toBe("medium")
    expect(level([...items, { ...cited("N3", "other.example", true), lineage: ["doi:10.1000/another"] }]).level).toBe(
      "high",
    )
  })

  test("is not High when no site is primary", () => {
    expect(level([cited("N1", "bbc.co.uk", false), cited("N2", "theguardian.com", false)]).level).toBe("medium")
  })

  test("is not High on a paraphrase, which counts toward Medium only", () => {
    expect(level([cited("N1", "nature.com", true), cited("N2", "bbc.co.uk", false, { support: false })]).level).toBe(
      "medium",
    )
    expect(level([cited("N1", "nature.com", true, { support: false })]).level).toBe("medium")
  })

  test("is not High when the judge ran and did not support every cited note", () => {
    const items = [
      cited("N1", "nature.com", true, { verdict: "supported" }),
      cited("N2", "bbc.co.uk", false, { verdict: "partial" }),
    ]
    expect(level(items, true).level).toBe("medium")
    expect(
      level(
        [
          cited("N1", "nature.com", true, { verdict: "supported" }),
          cited("N2", "bbc.co.uk", false, { verdict: "supported" }),
        ],
        true,
      ).level,
    ).toBe("high")
    // A note the judge did not answer for is not supported.
    expect(level([cited("N1", "nature.com", true), cited("N2", "bbc.co.uk", false)], true).level).toBe("medium")
  })

  test("is Medium on one primary source, or two independent secondary ones", () => {
    expect(level([cited("N1", "nature.com", true)]).level).toBe("medium")
    expect(level([cited("N1", "bbc.co.uk", false), cited("N2", "theguardian.com", false)]).level).toBe("medium")
  })

  test("is Low on one secondary source, on context notes alone, or with nothing cited", () => {
    expect(level([cited("N1", "bbc.co.uk", false)]).level).toBe("low")
    expect(level([cited("N1", "nature.com", true, { stance: "context" })]).level).toBe("low")
    expect(level([]).level).toBe("low")
  })

  test("is Low and shows that sources disagree when a cited note contradicts", () => {
    const items = [
      cited("N1", "nature.com", true),
      cited("N2", "bbc.co.uk", false),
      cited("N3", "example.com", false, { stance: "contradicts" }),
    ]
    expect(level(items)).toEqual({ level: "low", disagree: true, removed: [] })
    expect(level([cited("N1", "nature.com", true, { verdict: "contradicted" })])).toMatchObject({ disagree: true })
  })

  test("leaves notes the judge found unsupported out, and lists them as removed", () => {
    const items = [
      cited("N1", "nature.com", true, { verdict: "supported" }),
      cited("N2", "bbc.co.uk", false, { verdict: "supported" }),
      cited("N3", "example.com", false, { verdict: "unsupported" }),
    ]
    expect(level(items, true)).toEqual({ level: "high", disagree: false, removed: ["N3"] })
  })

  test("words the levels and the hover rule as Vector's estimate", () => {
    expect(ResearchConfidence.LABEL).toEqual({ high: "High", medium: "Medium", low: "Low" })
    expect(ResearchConfidence.HOVER.startsWith("Vector's estimate.")).toBe(true)
  })

  test("made no connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})
