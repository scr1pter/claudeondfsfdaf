import { describe, expect, test } from "bun:test"
import { strFromU8, unzipSync } from "fflate"
import { ResearchExport } from "../../src/research/export"
import { ResearchReport } from "../../src/research/report"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()
const report = `# Biology α and evidence

## Findings

The measured concentration was 5 µg/L, with a 25% change. [S1 p.2]

- Compare the methods.
- Review uncertainty.

| Year | Concentration |
| --- | --- |
| 2026 | 5 µg/L |

## Sources

S1. Example study. https://example.org/paper?a=1&b=2

## Method

Two sources were read; the findings require expert review.
`

describe("local research report exports", () => {
  test("Word is an OOXML document with headings, a table, citations and Unicode", async () => {
    const output = await ResearchExport.render(report, "docx")
    expect(output.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    const archive = unzipSync(output.bytes)
    expect(Object.keys(archive)).toContain("[Content_Types].xml")
    expect(Object.keys(archive)).toContain("word/styles.xml")
    const document = strFromU8(archive["word/document.xml"])
    expect(document).toContain('w:pStyle w:val="Heading1"')
    expect(document).toContain("<w:tbl>")
    expect(document).toContain("<w:tblHeader/>")
    expect(document).toContain("Biology α")
    expect(document).toContain("5 µg/L")
    expect(document).toContain("[S1 p.2]")
    expect(document).toContain("a=1&amp;b=2")
    expect(document).toContain("Two sources were read")
  })

  test("Word keeps markup inert and never creates external image or link relationships", async () => {
    const output = await ResearchExport.render(
      '# Saved evidence\n\n![private](https://outside.invalid/leak?secret=123)\n\n<script>alert("run")</script>\n\n[Open](javascript:alert(1))',
      "docx",
    )
    const archive = unzipSync(output.bytes)
    const document = strFromU8(archive["word/document.xml"])
    expect(document).toContain("[Image: private]")
    expect(document).not.toContain("outside.invalid")
    expect(document).toContain("&lt;script&gt;")
    expect(document).not.toContain("<script>")
    expect(document).not.toContain("javascript:")
    expect(strFromU8(archive["word/_rels/document.xml.rels"])).not.toContain("External")
    expect(guard.attempts()).toEqual([])
  })

  test("PDF has an embedded font and its extracted text preserves scientific Unicode and citations", async () => {
    const { getDocumentProxy, extractText } = await import("unpdf")
    const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = await import("pdf-lib")
    const { data } = await import("../../src/research/assets/inter")
    const output = await ResearchExport.render(report, "pdf")
    expect(output.type).toBe("application/pdf")
    expect(new TextDecoder().decode(output.bytes.slice(0, 5))).toBe("%PDF-")
    const document = await getDocumentProxy(output.bytes.slice())
    const extracted = await extractText(document, { mergePages: true })
    expect(extracted.text).toContain("Biology α")
    // Fonts may map the MICRO SIGN to the identical Greek mu glyph in ToUnicode.
    expect(extracted.text.normalize("NFKC")).toContain("5 μg/L")
    expect(extracted.text).toContain("[S1 p.2]")
    expect(extracted.text).toContain("Sources")
    expect(extracted.text).toContain("Two sources were read")
    // A variable-font subset once extracted correctly while rendering most glyphs blank. The PDF must carry the
    // complete licensed outlines; text extraction alone does not verify visible glyphs.
    const pdf = await PDFDocument.load(output.bytes)
    const fonts = pdf.getPage(0).node.Resources()!.lookup(PDFName.of("Font"), PDFDict)
    const dictionary = fonts.lookup(fonts.keys()[0]!, PDFDict)
    const descendant = dictionary.lookup(PDFName.of("DescendantFonts"), PDFArray).lookup(0, PDFDict)
    const descriptor = descendant.lookup(PDFName.of("FontDescriptor"), PDFDict)
    const file = descriptor.lookup(PDFName.of("FontFile2"))
    if (!(file instanceof PDFRawStream)) throw new Error("PDF must embed its original font outlines")
    expect(Buffer.from(decodePDFRawStream(file).decode()).equals(Buffer.from(data, "base64"))).toBe(true)
    expect(guard.attempts()).toEqual([])
  })

  test("both formats retain the renderer's checked N# footnotes and their source mapping", async () => {
    const { getDocumentProxy, extractText } = await import("unpdf")
    const rendered = ResearchReport.render(
      { title: "Observed result", answer: "The observed rate was 25 percent [N1].", sections: [], open_questions: [] },
      {
        notes: [
          {
            id: "N1",
            source: "S1",
            subquestion: "What rate was observed?",
            claim: "The observed rate was 25 percent",
            quote: "The observed rate was 25 percent in the trial.",
            page: 12,
            stance: "supports",
            support: true,
            created_at: 0,
          },
        ],
        sources: [
          {
            id: "S1",
            url: "https://study.example/25",
            canonical_url: "https://study.example/25",
            site: "study.example",
            title: "Trial findings",
            status: "read",
          },
        ],
        judged: false,
        method: { searches: 1, pages: 1 },
      },
    ).markdown
    expect(rendered).toContain("[^N1]:")
    const docx = await ResearchExport.render(rendered, "docx")
    const xml = strFromU8(unzipSync(docx.bytes)["word/document.xml"])
    expect(xml).toContain("Evidence N1:")
    expect(xml).toContain("The observed rate was 25 percent in the trial.")
    expect(xml).toContain("S1 p.12")
    expect(xml).toContain("Trial findings")
    const pdf = await ResearchExport.render(rendered, "pdf")
    const extracted = await extractText(await getDocumentProxy(pdf.bytes), { mergePages: true })
    expect(extracted.text).toContain("Evidence N1:")
    expect(extracted.text).toContain("The observed rate was 25 percent in the trial.")
    expect(extracted.text).toContain("S1 p.12")
    expect(extracted.text).toContain("Trial findings")
  })

  test("PDF wraps long values and paginates a long table without dropping its final row", async () => {
    const { getDocumentProxy, extractText } = await import("unpdf")
    const rows = Array.from({ length: 130 }, (_, index) => `| Row ${index} | ${"longvalue".repeat(8)} |`).join("\n")
    const output = await ResearchExport.render(
      `# Large report\n\n| Row | Result |\n| --- | --- |\n${rows}\n\nLast finding [S4 p.9].`,
      "pdf",
    )
    const document = await getDocumentProxy(output.bytes)
    expect(document.numPages).toBeGreaterThan(1)
    const extracted = await extractText(document, { mergePages: true })
    expect(extracted.text).toContain("Row 129")
    expect(extracted.text).toContain("Last finding [S4 p.9]")
  })

  test("PDF refuses missing glyphs explicitly instead of silently losing text", async () => {
    await expect(ResearchExport.render("# Study\n\nGenetics 🧬", "pdf")).rejects.toThrow("U+1F9EC")
    const word = await ResearchExport.render("# Study\n\nGenetics 🧬", "docx")
    expect(strFromU8(unzipSync(word.bytes)["word/document.xml"])).toContain("🧬")
  })

  test("caps conversion work and refuses overly wide tables", () => {
    expect(() => ResearchExport.blocks("a".repeat(4 * 1024 * 1024 + 1))).toThrow("too large")
    const cells = Array.from({ length: 21 }, () => "cell").join(" | ")
    const separators = Array.from({ length: 21 }, () => "---").join(" | ")
    expect(() => ResearchExport.blocks(`| ${cells} |\n| ${separators} |`)).toThrow("too many columns")
  })
})
