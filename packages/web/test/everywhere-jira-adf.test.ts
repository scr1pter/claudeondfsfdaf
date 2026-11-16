import { expect, test } from "bun:test"
import { adfText } from "../../../api/_lib/everywhere/jira/adf"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"

installFetchGuard()
test("ADF becomes text and line breaks without formatting, links, image metadata or JSON markup", () => {
  const value = { type: "doc", version: 1, content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "A title", marks: [{ type: "strong" }] }] },
    { type: "paragraph", content: [{ type: "text", text: "Read this", marks: [{ type: "link", attrs: { href: "https://untrusted.invalid/private" } }] },
      { type: "hardBreak" }, { type: "text", text: "Then continue" }] },
    { type: "mediaSingle", content: [{ type: "media", attrs: { url: "https://untrusted.invalid/image", alt: "hidden attachment" } }] },
  ] }
  expect(adfText(value)).toBe("A title\nRead this\nThen continue")
  expect(adfText(value)).not.toContain("untrusted")
  expect(adfText(value)).not.toContain("attrs")
})
test("plain native strings and malformed or deeply nested ADF stay bounded", () => {
  expect(adfText("  Original plain text  ")).toBe("Original plain text")
  expect(adfText(null)).toBe("")
  expect(adfText({ type: "doc", content: [{ type: "text", text: "x".repeat(9000) }] }, 100)).toHaveLength(100)
  const cycle: { type: string; content: unknown[] } = { type: "doc", content: [] }
  cycle.content.push(cycle)
  expect(adfText(cycle)).toBe("")
})
