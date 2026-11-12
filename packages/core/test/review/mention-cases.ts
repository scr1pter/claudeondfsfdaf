// The mention table both parsers run: core's parseReviewCommand (command.test.ts) and the route script the generated
// workflow embeds (packages/engine/test/cli/github.route-script.test.ts). Each body is read with
// GithubAgents.mentions(slug). Not a test file itself, so importing it registers no tests twice.

import type { ReviewCommandKind } from "@vectordevai/core/review/command"

export type MentionCase = [body: string, kind: ReviewCommandKind, slug?: string]

export const MENTION_CASES: MentionCase[] = [
  // Verbs, as the review commands defined them.
  ["/vector review", "review"],
  ["/vector review full", "review-full"],
  ["/vector pause", "pause"],
  ["/vector resume", "resume"],
  ["/vector dismiss", "dismiss"],
  ["/vector review the auth code and fix it", "task"],
  ["/vector reviewer", "task"],
  ["LGTM\n/vector review", "review"],
  ["/vector review full please", "task"],
  ["no mention here", "none"],
  ["/VX Review Full", "review-full"],
  ["/vx review", "review"],
  ["> /vector review\nthanks", "none"],
  ["> /vector review\n/vector review full", "review-full"],
  ["```\n/vector review\n```", "none"],
  ["```sh\n/vector review\n```\n/vector pause", "pause"],
  ["~~~\n/vector review\n~~~", "none"],
  ["````\n```\n/vector review\n```\n````", "none"],
  ["/vector dismiss not an issue here", "dismiss"],
  ["/vector dismissal", "task"],
  ["please /vector fix the typo", "task"],
  ["/vector", "task"],
  ["/vector fix the failing test", "task"],
  // A glued suffix is another word now (section 2.2); before word boundaries this was a task.
  ["/vectorx review", "none"],
  ["see a/vector for details", "none"],
  // Whitespace and line endings.
  ["   /vector review   ", "review"],
  ["/vector\treview", "review"],
  ["/vector   review    full", "review-full"],
  ["LGTM\r\n/vector review\r\n", "review"],
  ["/vector review\n/vector pause", "review"],
  ["", "none"],
  // Trailing punctuation, invisible characters and HTML comments.
  ["/vector review.", "review"],
  ["/vector review full!", "review-full"],
  ["/vector pause.", "pause"],
  ["/vector review\u200b", "review"],
  ["/vector review <!-- sent from mobile -->", "review"],
  ["<!-- /vector review -->", "none"],
  ["/vector review the auth code.", "task"],
  ["/vector\u200b", "task"],
  ["/vector\u200bx", "none"],
  ["/vector <!-- hidden\nlines --> review", "review"],
  // The aliases installed workflows bake in.
  ["/vectorscope review", "review"],
  ["/vectorscope review full", "review-full"],
  ["/vectorscope pause", "pause"],
  ["/vectorscope resume", "resume"],
  ["/vectorscope fix the flaky auth test", "task"],
  ["/vs review", "review"],
  ["/vs review full", "review-full"],

  // Section 2.2: refused.
  ["/vscode", "none"],
  ["src/vs/x", "none"],
  ["/vectorize", "none"],
  ["@vector-io", "none", "vector"],
  ["a@vector.dev", "none", "vector"],
  ["@vector.dev", "none", "vector"],
  // Section 2.2: accepted.
  ["/vector, fix this", "task"],
  ["(/vector fix)", "task"],
  ["/VECTOR Fix", "task"],
  // Boundaries before and after.
  ["[/vector fix]", "task"],
  ["'/vs fix'", "task"],
  ['"/vector"', "task"],
  ["/vector.", "task"],
  ["see /vector.", "task"],
  ["x\t/vector fix", "task"],
  ["/vector.x", "none"],
  ["/vector-bot fix", "none"],
  ["/vs/x", "none"],
  ["/vector... fix", "none"],
  ["**/vector fix**", "none"],
  ["/vectorize this\n/vector review", "review"],

  // Inline code: a span hides a mention, and text glued to a span is no boundary.
  ["`/vector review`", "none"],
  ["Run `/vector review` to retry", "none"],
  ["``/vector `x` review``", "none"],
  ["`x`/vector fix", "none"],
  ["/vector`x` fix", "none"],
  ["`a\n/vector fix`", "none"],
  ["`/vector dismiss`", "none"],
  // An unmatched backtick is literal text, and no boundary either.
  ["`/vector fix", "none"],
  ["/vector fix `src/a.ts`", "task"],
  ["`x` /vector fix", "task"],
  ["`x`\n/vector review", "review"],
  // A blank line ends the paragraph, so the backtick before it has no partner. Only spaces and tabs make a line blank:
  // a line of other invisible characters continues the paragraph, and its span.
  ["`a\n\n/vector fix`", "task"],
  ["`a\n \t\n/vector fix`", "task"],
  ["`a\n\u00a0\n/vector fix`", "none"],
  ["`a\n\u200b\n/vector fix`", "none"],
  // Any line may start a block of its own (a list item, a heading), so a stray backtick on an earlier line does not
  // stop a later span from hiding a mention.
  ["1. run `npm test\n2. type `please /vector fix the build` in a comment", "none"],
  ["# Setup `x\nType `please /vector fix` to start", "none"],
  // A pairing from a later line can sit inside a span from an earlier one, which still hides the mention.
  ["`a\n``x`` /vector fix\nb`", "none"],
  // The cost (deviation V02-2): the line after a span that wraps could start a block, so its closing backtick is tried
  // as an opener too. GitHub shows this mention.
  ["`foo\nbar` /vector fix `x`", "none"],
  // A backslash escapes the first backtick of the run after it, as in Markdown; inside a span it is code.
  ["\\`/vector fix\\`", "none"],
  ["\\`` /vector fix`", "none"],
  ["\\`a` /vector fix `b`", "none"],
  ["`a\\` /vector fix `b`", "task"],

  // Quoted lines and fences never count. A quote that starts after other text ends its paragraph, but the lines after a
  // quote can continue the quote's paragraph, and its span, and so can a later quoted line.
  ["> /vector review\n/vector pause", "pause"],
  ["`a\n> b\n/vector fix`", "task"],
  ["> `a\n/vector fix`", "none"],
  ["> `a\nb\n> c\nplease /vector fix`", "none"],
  ["- > x `y /vector fix\n  > z`", "none"],
  // A list item's text starts after its markers, so a fence or a quote can open there. Such a fence also ends with the
  // item, at a line indented less than the item's text, and that line may open a fence of its own.
  ["- ```sh\n  /vector review\n  ```", "none"],
  ["1. ```\n   /vector fix the build\n   ```\n2. then this", "none"],
  ["* ~~~\n  /vector pause\n  ~~~", "none"],
  ["- ```\n  npm test\n  ```\n/vector review", "review"],
  ["- ```\n  /vector review\n```\n/vector fix", "none"],
  // A tab indents a line by at least the item's text, so the line stays in the fence.
  ["- ```\n\t/vector review\n  ```", "none"],
  ["- > /vector review", "none"],
  ["1. > /vector review\n/vector pause", "pause"],

  // HTML comments (deviation V02-7). A comment that starts a line is an HTML block, which runs across blank lines and
  // fences to its "-->", or to the end of the body.
  ["<!-- template\n\n/vector review\n-->\n/vector fix", "task"],
  ["<!-- Use ``` for logs -->\n/vector review", "review"],
  ["<!-- unclosed\n/vector review", "none"],
  // Inside a paragraph, a span that opens first holds a "<!--" as code, and a "<!--" that opens first holds the
  // backticks before its "-->". A line holding only a comment does not end the paragraph.
  ["Type `<!--` then --> and ` /vector fix `", "none"],
  ["x `a <!--` b -->` /vector fix`", "none"],
  ["`<!--` and `-->` then `` /vector fix ``", "none"],
  ["`<!--`-->` /vector fix `", "none"],
  ["`a\n    <!-- c -->\n/vector fix`", "none"],
  ["x <!-- ` --> `/vector fix`", "none"],
  ["/vector review <!-- ` -->", "review"],
  // A comment can start on a quoted line and end on a line that continues the quote.
  ["> a <!-- b\n`` --> `` /vector fix ``", "none"],
  // A "<!--" may be literal text too: Markdown flavours differ on "--" inside a comment, and in one reading these
  // backticks pair.
  ["x <!-- a -- `` --> /vector fix ``", "none"],

  // Not modelled (deviation V02-2): GitHub shows each of these mentions only as code, because an autolink, a link title
  // or an extended autolink takes the first backtick, or because a table cell pairs on its own. The parser reads a task.
  ["<https://x.dev/`> `please /vector fix`", "task"],
  ['[x](u "`") `please /vector fix`', "task"],
  ["www.x.dev/` `please /vector fix`", "task"],
  ["| a | b |\n| - | - |\n| `x | `please /vector fix` |", "task"],
  // Nor where GitHub's fences differ: a list item's end closes a fence opened on a line of its own inside it, and an
  // ordered marker other than 1. cannot interrupt a paragraph, so it opens no fence. In each, the parser's fence closes
  // where GitHub's opens.
  ["- a\n\n  ```\n  x\nb\n```\n/vector fix", "task"],
  ["a\n2. ```\n   ```\n/vector fix", "task"],

  // The App handle, with slug vector-fixture.
  ["@vector-fixture review", "review", "vector-fixture"],
  ["@vector-fixture review full", "review-full", "vector-fixture"],
  ["@vector-fixture pause", "pause", "vector-fixture"],
  ["@vector-fixture resume", "resume", "vector-fixture"],
  ["@vector-fixture dismiss", "dismiss", "vector-fixture"],
  ["@Vector-Fixture fix it", "task", "vector-fixture"],
  ["hey @vector-fixture, fix", "task", "vector-fixture"],
  ["@vector-fixture-bot review", "none", "vector-fixture"],
  ["a@vector-fixture", "none", "vector-fixture"],
  ["@vector review", "none", "vector-fixture"],
  ["/vector review", "review", "vector-fixture"],
  // Decision O1: @vector counts only when the registered slug is vector.
  ["@vector review", "none"],
  ["@vector review", "review", "vector"],
  ["@vector, fix this", "task", "vector"],
  ["see @vector.", "task", "vector"],
]
