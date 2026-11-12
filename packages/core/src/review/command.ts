// Vector commands in comments (docs/vector/build/vector-at-mention-spec.md section 2.2). /vector and /vs are the
// commands and @<App slug> is the handle (GithubAgents.mentions); /vectorscope and /vx still route, because workflows
// people already installed bake them in. The route script embeds `parseReviewCommand.toString()`, and the hosted API
// loads this file by its relative .js path, so the module has no imports and uses nothing newer than ES2023, and the
// function is self-contained: no module-level values and no helpers outside its own body.

export type ReviewCommandKind = "review" | "review-full" | "pause" | "resume" | "dismiss" | "task" | "none"

// A literal copy of GithubAgents.mentions() (../github-agents.ts), which the tests compare it with.
export const DEFAULT_MENTIONS = ["/vector", "/vs", "/vectorscope", "/vx"]

export function parseReviewCommand(body: string, mentions: string[]): { kind: ReviewCommandKind } {
  const names = mentions
    .map((mention) => String(mention).trim().toLowerCase())
    .filter((mention) => mention.length > 0)
    .sort((a, b) => b.length - a.length)
  if (names.length === 0) return { kind: "none" }
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  // A mention is a word of its own: it follows the start of the line, whitespace, ( [ " or ', and it precedes the end of
  // the line, whitespace, one of )]}"',:;!? or a "." that ends the line or precedes whitespace. So /vectorize,
  // src/vs/x, a@vector.dev and @vector-io (for @vector) never count. The lines are lowercased first.
  const after = "(?=$|[\\s)\\]}\"',:;!?]|\\.(?:$|\\s))"
  const leading = new RegExp("^(?:" + alternatives + ")" + after)
  const anywhere = new RegExp("(?:^|[\\s(\\[\"'])(?:" + alternatives + ")" + after)
  // Counted from the end, because a regex anchored only at the end backtracks quadratically on a long hostile run.
  const trimTrailing = (text: string, trailing: RegExp) => {
    let end = text.length
    while (end > 0 && trailing.test(text[end - 1]!)) end--
    return text.slice(0, end)
  }

  // HTML comments, quoted lines, fenced blocks and inline code never count, so hiding, quoting or showing a command
  // does not run it. Every "<!--" up to the next "-->" is masked first: all but whitespace, backticks, backslashes and
  // the characters of comment, quote, list and fence markers become "#". So no mention inside one counts, while the
  // passes below still see the Markdown around it, which can make the "<!--" code instead. Comments are found by
  // searching, since a lazy regex is quadratic on many unclosed "<!--".
  const source = String(body ?? "")
  let visible = ""
  let at = 0
  for (let open = source.indexOf("<!--"); open >= 0; open = source.indexOf("<!--", at)) {
    const close = source.indexOf("-->", open + 4)
    if (close < 0) break
    visible += source.slice(at, open) + source.slice(open, close + 3).replace(/[^\s`\\~<>!*+.)0-9-]/g, "#")
    at = close + 3
  }
  visible += source.slice(at)

  // Lines group into paragraphs, which end only where Markdown surely ends one: at a blank line (empty but for spaces
  // and tabs, so a line of other invisible characters does not end one), at a fence, at a comment that starts a line,
  // and where a quote starts in a paragraph with no ">" so far. Once a ">" has appeared, a quote may be open (one can
  // also start after a list marker), and a later quoted line may continue it. A quoted line stays in its paragraph with
  // all but its backticks, backslashes and comment markers masked, so no mention on it counts but its code and
  // comments still pair, because the lines after a quote can continue the quote's paragraph.
  const paragraphs: string[][] = [[]]
  let fence = ""
  let indent = 0
  let comment = false
  let quoted = false
  for (const raw of visible.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim()
    // A fence opened on a list item's first line ends with the item, at a line indented less than the item's text.
    if (fence && !/^[ \t]*$/.test(raw) && raw.replace(/\t/g, "    ").search(/[^ ]/) < indent) fence = ""
    if (fence) {
      const marker = /^(`{3,}|~{3,})/.exec(line)
      const closes =
        !!marker &&
        marker[1]![0] === fence[0] &&
        marker[1]!.length >= fence.length &&
        line.slice(marker[1]!.length).trim() === ""
      if (closes) fence = ""
      continue
    }
    // A comment that starts a line is an HTML block, which runs to the line holding "-->" (or to the end of the body),
    // across blank lines and fences. The rest of that line is raw HTML, not Markdown, and the next line starts a block.
    if (comment || /^ {0,3}<!--/.test(raw)) {
      const close = raw.indexOf("-->", comment ? 0 : raw.indexOf("<!--") + 2)
      comment = close < 0
      quoted = false
      if (!comment) paragraphs.push([raw.slice(close + 3)], [])
      continue
    }
    // A list item's text starts after its markers, so "- ```" opens a fence and "1. > x" is quoted.
    const listed = /^[ \t]*(?:(?:[-+*]|\d{1,9}[.)]) {1,4})+/.exec(raw)
    const item = listed ? raw.slice(listed[0].length) : line
    const marker = /^(`{3,}|~{3,})/.exec(item)
    if (marker || /^[ \t]*$/.test(raw)) {
      fence = marker ? marker[1]! : ""
      indent = listed ? listed[0].replace(/\t/g, "    ").length : 0
      quoted = false
      paragraphs.push([])
      continue
    }
    const quote = item.startsWith(">")
    if (quote && !quoted && /^ {0,3}>/.test(raw)) paragraphs.push([])
    quoted = quoted || line.includes(">")
    paragraphs[paragraphs.length - 1]!.push(quote ? line.replace(/[^`\\<!>-]/g, "#") : line)
  }

  // Inline code and comments, read as Markdown reads them: whichever of a backtick run and a "<!--" comes first takes
  // the text after it. A run of n backticks opens a span that the next run of exactly n closes, a run with no partner is
  // literal text, and a backslash escapes the first backtick of the run after it (inside a span a backslash is code). A
  // "<!--" opens a comment that the next "-->" closes, but it may be literal text too (escaped, or a comment that a
  // Markdown flavour refuses), so both readings are followed. The reading also depends on where a block's text starts,
  // and any line of a paragraph may start a block (a list item, a heading, a table row), so the pass reads from the
  // start of every line to the end of the paragraph, and text that any of these readings makes code counts as code.
  // Where blocks start inside a paragraph can then only hide a mention that GitHub shows, never show one that GitHub
  // shows only as code. Code becomes "#", which is neither whitespace nor a boundary, so a mention glued to code does
  // not count either, and a comment that no reading makes code is removed. Every reading follows the same partners,
  // found in advance, and each run and comment is visited once, so the pass stays linear.
  const lines = paragraphs.flatMap((rows) => {
    const paragraph = rows.join("\n")
    const tokens = Array.from(paragraph.matchAll(/`+|<!--/g), (match) => {
      let slashes = 0
      while (paragraph[match.index - slashes - 1] === "\\") slashes++
      const length = match[0].length
      return {
        index: match.index,
        length,
        opens: length - (slashes % 2),
        comment: match[0] === "<!--",
        end: -1,
        next: -1,
      }
    })
    // A span ends after its partner, found from the end, and its reading goes on at the token after the partner.
    const nextOfLength = new Map<number, number>()
    for (let i = tokens.length - 1; i >= 0; i--) {
      const token = tokens[i]!
      if (token.comment) continue
      const partner = token.opens > 0 ? (nextOfLength.get(token.opens) ?? -1) : -1
      if (partner >= 0) {
        token.end = tokens[partner]!.index + tokens[partner]!.length
        token.next = partner + 1
      }
      nextOfLength.set(token.length, i)
    }
    // A comment ends at the first "-->" after its "<!--", which a later "<!--" never finds earlier, so one forward
    // search serves them all.
    let close = -1
    let next = 0
    for (const [i, token] of tokens.entries()) {
      if (!token.comment) continue
      if (close < token.index + 4) close = paragraph.indexOf("-->", token.index + 4)
      if (close < 0) break
      next = Math.max(next, i + 1)
      while (next < tokens.length && tokens[next]!.index < close) next++
      token.end = close + 3
      token.next = next
    }
    // A reading from a line starts at the line's first token.
    const reached: boolean[] = []
    let offset = 0
    let lead = 0
    for (const row of rows) {
      while (lead < tokens.length && tokens[lead]!.index < offset) lead++
      reached[lead] = true
      offset += row.length + 1
    }
    // A reached span or comment sends its reading on after its end, and a run with no partner, or a "<!--" read as
    // text, sends it on to the next token. Spans and comments from different readings can overlap, so they merge, and
    // the merged text is code if any of them is.
    let text = ""
    let from = 0
    let code = false
    for (const [i, token] of tokens.entries()) {
      if (!reached[i]) continue
      if (token.comment || token.end < 0) reached[i + 1] = true
      if (token.end < 0) continue
      reached[token.next] = true
      // An escaped backtick stays literal text.
      const start = token.comment ? token.index : token.index + token.length - token.opens
      if (start >= from) {
        text += (code ? "#" : "") + paragraph.slice(from, start)
        code = false
      }
      code = code || !token.comment
      from = Math.max(from, token.end)
    }
    // Clients append invisible characters, which must not keep a mention from ending its line.
    return (text + (code ? "#" : "") + paragraph.slice(from))
      .split("\n")
      .map((line) => trimTrailing(line.trimStart(), /[\s\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/).toLowerCase())
  })

  // The first line that starts with a mention gives the verb.
  const first = lines.find((line) => leading.test(line))
  if (first !== undefined) {
    // Trailing punctuation or invisible characters after a verb do not make it a task: "/vector review." reviews.
    const line = trimTrailing(first, /[\s.!?,;:\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/)
    const verb = (rest: string) => new RegExp("^(?:" + alternatives + ")" + rest).test(line)
    if (verb("\\s+review\\s*$")) return { kind: "review" }
    if (verb("\\s+review\\s+full\\s*$")) return { kind: "review-full" }
    if (verb("\\s+pause\\s*$")) return { kind: "pause" }
    if (verb("\\s+resume\\s*$")) return { kind: "resume" }
    if (verb("\\s+dismiss\\b")) return { kind: "dismiss" }
    return { kind: "task" }
  }
  // A mention anywhere else on a line that counts is a task.
  return { kind: lines.some((line) => anywhere.test(line)) ? "task" : "none" }
}
