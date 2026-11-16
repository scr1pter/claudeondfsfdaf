/** Native work-item rich text is data. Keep only bounded text and line breaks; never follow links or media. */
export function adfText(value: unknown, limit = 4000): string {
  const output: string[] = []
  let remaining = Math.min(24_000, Math.max(0, limit))
  let nodes = 0
  const add = (text: string) => {
    if (remaining <= 0) return
    const part = text.slice(0, remaining)
    output.push(part)
    remaining -= part.length
  }
  const visit = (node: unknown, depth: number) => {
    if (remaining <= 0 || ++nodes > 1000 || depth > 16) return
    if (typeof node === "string") { add(node); return }
    if (!node || typeof node !== "object" || Array.isArray(node)) return
    const item = node as { type?: unknown; text?: unknown; content?: unknown }
    if (item.type === "text" && typeof item.text === "string") add(item.text)
    if (item.type === "hardBreak") add("\n")
    if (Array.isArray(item.content)) for (const child of item.content.slice(0, 1000)) visit(child, depth + 1)
    if (["paragraph", "heading", "listItem", "codeBlock", "blockquote", "tableRow"].includes(String(item.type))) add("\n")
  }
  visit(value, 0)
  return output.join("").replace(/\n{3,}/g, "\n\n").trim()
}
