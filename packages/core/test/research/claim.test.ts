import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Research } from "@vectordevai/schema/research"
import { ResearchClaim } from "../../src/research/claim"

const measurement: Research.Measurement = {
  metric: "revenue",
  value: 1.2,
  unit: "USD",
  scale: "billion",
  currency: "USD",
  period: "2025",
  geography: "Europe",
}
const quote = "In 2025 Europe revenue was USD 1.2 billion."
const note = (id: string, value: Research.Measurement): Research.Note => ({
  id,
  source: id === "N1" ? "S1" : "S2",
  subquestion: "Revenue?",
  claim: quote,
  quote,
  support: true,
  stance: "supports",
  created_at: 0,
  measurement: value,
})
const source = (id: string, site: string, doi?: string): Research.Source => ({
  id,
  site,
  url: `https://${site}/${id}`,
  canonical_url: `https://${site}/${id}`,
  title: id,
  status: "read",
  signals: {
    kind: "other",
    primary: true,
    data: true,
    references: false,
    paywalled: false,
    addressed_to_ai: false,
    corroborated: 0,
    ...(doi ? { doi } : {}),
  },
})

describe("source-anchored quantitative claims", () => {
  test("accepts quoted fields and omits an absent optional annotation when encoded", () => {
    expect(ResearchClaim.check(measurement, quote)).toBeUndefined()
    const encoded = Schema.encodeSync(Research.Measurement)({ metric: "revenue", value: 1, unit: "USD" })
    expect(Object.hasOwn(encoded, "period")).toBe(false)
  })

  test("refuses invented values, scope, units, nonfinite values and a scale absent from the quote", () => {
    expect(ResearchClaim.check({ ...measurement, value: 7 }, quote)).toContain("value")
    expect(ResearchClaim.check({ ...measurement, geography: "Canada" }, quote)).toContain("geography")
    expect(ResearchClaim.check({ ...measurement, period: "2024" }, quote)).toContain("period")
    expect(ResearchClaim.check({ ...measurement, unit: "EUR" }, quote)).toContain("unit")
    expect(ResearchClaim.check({ ...measurement, scale: "million" }, quote)).toContain("scale")
    expect(ResearchClaim.check({ ...measurement, value: Infinity }, quote)).toContain("invalid")
  })

  test("compares reported scales without confusing millions and billions", () => {
    expect(ResearchClaim.compare(measurement, { ...measurement, value: 1200, scale: "million" })?.kind).toBe(
      "agreement",
    )
    expect(ResearchClaim.compare(measurement, { ...measurement, value: 1.2, scale: "million" })?.kind).toBe("conflict")
    expect(
      ResearchClaim.check(
        { ...measurement, value: 1200, scale: "million" },
        "In 2025 Europe revenue was USD 1,200 million.",
      ),
    ).toBeUndefined()
  })

  test("does not silently reinterpret decimal-comma quantities as a different number", () => {
    expect(ResearchClaim.check({ ...measurement, value: 1 }, "In 2025 Europe revenue was USD 1,2 billion.")).toContain(
      "value",
    )
    expect(ResearchClaim.check({ ...measurement, value: 2 }, "In 2025 Europe revenue was USD 1,2 billion.")).toContain(
      "value",
    )
  })

  test("flags different reported scopes and incompatible currencies instead of a contradiction", () => {
    expect(ResearchClaim.compare(measurement, { ...measurement, value: 9, period: "2024" })).toEqual({
      kind: "different-scope",
      fields: ["period"],
    })
    expect(ResearchClaim.compare(measurement, { ...measurement, value: 9, geography: "Canada" })?.kind).toBe(
      "different-scope",
    )
    expect(ResearchClaim.compare(measurement, { ...measurement, currency: "EUR" })?.fields).toContain("currency")
    expect(ResearchClaim.compare(measurement, { ...measurement, metric: "profit" })).toBeUndefined()
  })

  test("does not infer missing scope, including a missing methodology on one side", () => {
    expect(ResearchClaim.compare(measurement, { ...measurement, period: undefined })?.kind).toBe("insufficient-scope")
    expect(ResearchClaim.compare(measurement, { ...measurement, methodology: "survey" })?.kind).toBe(
      "insufficient-scope",
    )
    expect(
      ResearchClaim.compare({ metric: "revenue", value: 1, unit: "USD" }, { metric: "revenue", value: 9, unit: "USD" })
        ?.kind,
    ).toBe("insufficient-scope")
  })

  test("treats % and percent as the same unit and uses an explicit 2% review tolerance", () => {
    const a = { ...measurement, value: 50, unit: "%", scale: "one" as const }
    expect(ResearchClaim.compare(a, { ...a, value: 50.5, unit: "percent" })?.kind).toBe("agreement")
    expect(ResearchClaim.compare(a, { ...a, value: 55 })?.kind).toBe("conflict")
  })

  test("a shared DOI on different domains does not become independent corroboration", () => {
    const notes = [note("N1", measurement), note("N2", { ...measurement, value: 1.5 })]
    const sources = [
      source("S1", "journal.example", "10.1000/study"),
      source("S2", "news.example", "https://doi.org/10.1000/STUDY"),
    ]
    expect(ResearchClaim.comparisons(notes, sources)).toMatchObject([{ kind: "conflict", independent: false }])
    expect(
      ResearchClaim.comparisons(
        notes,
        sources.map((item) => ({ ...item, signals: undefined })),
      ),
    ).toMatchObject([{ independent: true }])
    expect(
      ResearchClaim.comparisons(
        notes.map((item) => ({ ...item, support: false })),
        sources,
      ),
    ).toEqual([])
  })

  test("follows duplicate chains without looping", () => {
    const sources = [source("S1", "a.example"), source("S2", "b.example")]
    const cycle = sources.map((item) => ({
      ...item,
      signals: { ...item.signals!, duplicate_of: item.id === "S1" ? "S2" : "S1" },
    }))
    expect(ResearchClaim.lineage(cycle[0]!, cycle)).toContain("source:S2")
    expect(ResearchClaim.comparisons([note("N1", measurement), note("N2", measurement)], cycle)[0]?.independent).toBe(
      false,
    )
  })
})
