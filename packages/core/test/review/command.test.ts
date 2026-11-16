import { describe, expect, test } from "bun:test"
import path from "path"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { DEFAULT_MENTIONS, parseReviewCommand } from "@vectordevai/core/review/command"
import { MENTION_CASES } from "./mention-cases"

// GitHub's limit for an issue, pull request or comment body.
const BODY_LIMIT = 65_536

describe("parseReviewCommand", () => {
  test("reads every body in the shared mention table", () => {
    for (const [body, kind, slug] of MENTION_CASES)
      expect({ body, slug, kind: parseReviewCommand(body, GithubAgents.mentions(slug)).kind }).toEqual({
        body,
        slug,
        kind,
      })
  })

  // command.ts keeps a literal copy, because it must stay import-free.
  test("DEFAULT_MENTIONS is GithubAgents.mentions()", () => {
    expect(DEFAULT_MENTIONS).toEqual(GithubAgents.mentions())
  })

  // Decision O1: an "@name" notifies whichever GitHub account holds the name, so without the App's slug no handle counts.
  test("no handle counts without the App's slug", () => {
    for (const body of ["@vector review", "@vector fix this", "hey @vector, fix", "@vector-fixture review"])
      expect({ body, kind: parseReviewCommand(body, DEFAULT_MENTIONS).kind }).toEqual({ body, kind: "none" })
  })

  test("uses custom mentions", () => {
    const mentions = ["@vector-bot", "/Review-Bot", "/v+x"]
    expect(parseReviewCommand("@vector-bot review", mentions)).toEqual({ kind: "review" })
    expect(parseReviewCommand("/review-bot PAUSE", mentions)).toEqual({ kind: "pause" })
    expect(parseReviewCommand("/v+x review full", mentions)).toEqual({ kind: "review-full" })
    expect(parseReviewCommand("(/v+x) fix", mentions)).toEqual({ kind: "task" })
    expect(parseReviewCommand("/v+xy fix", mentions)).toEqual({ kind: "none" })
    expect(parseReviewCommand("/vector review", mentions)).toEqual({ kind: "none" })
    expect(parseReviewCommand("/vector review", [])).toEqual({ kind: "none" })
    expect(parseReviewCommand("/vector review", [" ", ""])).toEqual({ kind: "none" })
  })

  test("is self-contained, so the route script can embed its source", () => {
    const source = parseReviewCommand.toString()
    expect(source).not.toMatch(/\bimport\b|\brequire\(/)
    expect(source).not.toContain("${{")
    // The workflow file holds this text, so no invisible character may reach it (a byte order mark inside a YAML
    // document is invalid).
    expect(source).toMatch(/^[\x20-\x7e\n]*$/)
    const embedded = new Function(`return (${source})`)() as typeof parseReviewCommand
    for (const [body, kind, slug] of MENTION_CASES)
      expect({ body, slug, kind: embedded(body, GithubAgents.mentions(slug)).kind }).toEqual({ body, slug, kind })
  })

  // The hosted API loads command.ts by its relative .js path (contract V09), so it may reach no other file. scanImports
  // leaves out type-only imports and re-exports, so the code is also read without its comments.
  test("the module imports nothing", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../src/review/command.ts")).text()
    expect(new Bun.Transpiler({ loader: "ts" }).scanImports(source)).toEqual([])
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    expect(code.match(/\bimport\b|\brequire\s*\(|\bfrom\s*["']/g)).toBeNull()
  })

  // The invisible characters the parser trims are written as escapes, so a reviewer sees every character it matches. A
  // Windows checkout ends the file's lines with CRLF.
  test("the source is printable ASCII", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../src/review/command.ts")).text()
    expect(source.replace(/\r\n/g, "\n")).toMatch(/^[\x20-\x7e\n]*$/)
  })

  // The route job parses any comment that passes its contains() filter, before the writer check, and the hosted API
  // will parse comment bodies too. Every pass is linear: each of these takes under 50 ms with Bun 1.3.14, where the
  // earlier lazy comment regex took about 500 ms on the "<!--" bodies and the earlier end-anchored trims about 8 s.
  test("parses hostile bodies at GitHub's size limit quickly", () => {
    const fill = (text: string) => text.repeat(Math.ceil(BODY_LIMIT / text.length)).slice(0, BODY_LIMIT)
    const hostile = [
      fill("`"),
      fill("`a``b"),
      "/vector " + fill("``x").slice(8),
      fill("<!--"),
      "/vector " + fill("<!--").slice(8),
      fill("```\n"),
      fill("> /vector review\n"),
      ("/vector " + fill(".")).slice(0, BODY_LIMIT - 1) + "x",
      ("/vector " + fill(" .")).slice(0, BODY_LIMIT - 1) + "x",
      ("/vector " + fill("\u200b")).slice(0, BODY_LIMIT - 1) + "x",
      fill("\u200b") + "\n/vector",
      fill("/vector"),
      fill("a/vector "),
      fill(" "),
      fill("`\n"),
      fill("``\n`\n"),
      fill("\\`"),
      fill("> `\n"),
      fill("a <!-- ` -->"),
      "x " + fill("<!--`").slice(5) + "-->",
      fill("<!--\n-->\n"),
      fill("- ```\n x\n"),
      " ".repeat(BODY_LIMIT - 3) + "- x",
    ]
    const embedded = new Function(`return (${parseReviewCommand.toString()})`)() as typeof parseReviewCommand
    for (const parse of [parseReviewCommand, embedded])
      for (const body of hostile) {
        const started = performance.now()
        parse(body, GithubAgents.mentions("vector-fixture"))
        expect({ body: body.slice(0, 24), slow: performance.now() - started > 250 }).toEqual({
          body: body.slice(0, 24),
          slow: false,
        })
      }
  })
})
