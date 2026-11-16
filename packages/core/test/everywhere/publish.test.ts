import { describe, expect, test } from "bun:test"
import { BRANCH_PATTERN, createJobId } from "@vectordevai/schema/everywhere"
import { WITHHELD } from "@vectordevai/schema/everywhere-policy"
import {
  branchFor,
  commitMessage,
  heldBack,
  isHeldBack,
  jobMarker,
  prTemplate,
  prTitle,
  stripClosingKeywords,
  wrapMentions,
} from "../../src/everywhere/publish"

const time = Date.UTC(2026, 10, 11, 12)
const jid = createJobId(time)

describe("branchFor", () => {
  test("names the branch after the jid's random tail", () => {
    const branch = branchFor(jid)
    expect(branch).toBe(`vector/ve-${jid.slice(-12)}`)
    expect(BRANCH_PATTERN.test(branch)).toBe(true)
    // Two jobs in the same millisecond still get different branches.
    expect(branchFor(createJobId(time))).not.toBe(branchFor(createJobId(time)))
  })

  test("carries the issue key: lowercase for Linear, as written for Jira", () => {
    expect(branchFor(jid, { key: "ENG-123", platform: "linear" })).toBe(`vector/ve-eng-123-${jid.slice(-8)}`)
    expect(branchFor(jid, { key: "PROJ-123", platform: "jira" })).toBe(`vector/ve-PROJ-123-${jid.slice(-8)}`)
    for (const branch of [
      branchFor(jid, { key: "ENG-123", platform: "linear" }),
      branchFor(jid, { key: "PROJ-123", platform: "jira" }),
    ])
      expect(BRANCH_PATTERN.test(branch)).toBe(true)
  })

  test("refuses anything that would not be a Vector everywhere branch", () => {
    expect(() => branchFor("vej_short")).toThrow()
    expect(() => branchFor(jid, { key: "ENG-123", platform: "slack" })).toThrow()
    expect(() => branchFor(jid, { key: "ENG-123; rm -rf /", platform: "linear" })).toThrow()
    expect(() => branchFor(jid, { key: "../main-1", platform: "jira" })).toThrow()
  })
})

describe("heldBack", () => {
  test("each held-back path is held back, however it is spelled", () => {
    const held = [
      ".github/workflows/ci.yml",
      ".github/CODEOWNERS",
      ".husky/pre-commit",
      ".husky/_/husky.sh",
      ".githooks/pre-push",
      ".gitattributes",
      ".gitmodules",
      "src/.gitattributes",
      "vendor/lib/.gitmodules",
      "./.github/workflows/release.yml",
      "/.husky/pre-push",
      ".GitHub/workflows/ci.yml",
      ".HUSKY/pre-commit",
      ".GitAttributes",
      ".github./workflows/ci.yml",
      ".github /workflows/ci.yml",
      ".githooks\\pre-commit",
      ".github",
    ]
    for (const path of held) expect(isHeldBack(path)).toBe(true)
    expect(heldBack(held)).toEqual(held)
  })

  test("ordinary paths are committed", () => {
    const kept = [
      "src/index.ts",
      "github/workflows/ci.yml",
      "docs/.github-notes.md",
      ".github-templates/x.md",
      ".huskyrc.json",
      "packages/app/.github/workflows/ci.yml",
      "src/gitattributes.ts",
      "README.md",
      "",
    ]
    for (const path of kept) expect(isHeldBack(path)).toBe(false)
    expect(heldBack([...kept, ".gitmodules"])).toEqual([".gitmodules"])
  })
})

describe("stripClosingKeywords", () => {
  const options = { repository: "acme/widgets", issueKey: "ENG-123" }

  test("closing references to other repositories' issues become code, so they neither close nor link", () => {
    expect(stripClosingKeywords("Fixes other/repo#12", options)).toBe("Fixes `other/repo#12`")
    expect(stripClosingKeywords("This closes https://github.com/other/repo/issues/3.", options)).toBe(
      "This closes `other/repo#3`.",
    )
    expect(stripClosingKeywords("RESOLVED: Other/Repo#4 today", options)).toBe("RESOLVED: `Other/Repo#4` today")
    expect(stripClosingKeywords("fixed other/repo#5, closes other/repo#6", options)).toBe(
      "fixed `other/repo#5`, closes `other/repo#6`",
    )
  })

  test("other issue keys become code, and the job's own line stays", () => {
    expect(stripClosingKeywords("Fixes ENG-9", options)).toBe("Fixes `ENG-9`")
    expect(stripClosingKeywords("Completes PROJ-77", options)).toBe("Completes `PROJ-77`")
    expect(stripClosingKeywords("closes eng-9", options)).toBe("closes `eng-9`")
    expect(stripClosingKeywords("Fixes ENG-123", options)).toBe("Fixes ENG-123")
    expect(stripClosingKeywords("fixes eng-123", options)).toBe("fixes eng-123")
    expect(stripClosingKeywords("PROJ-123", { repository: "acme/widgets", issueKey: "PROJ-123" })).toBe("PROJ-123")
  })

  test("same-repository references, words without a reference and code are left alone", () => {
    expect(stripClosingKeywords("Fixes #12 and closes acme/widgets#13", options)).toBe(
      "Fixes #12 and closes acme/widgets#13",
    )
    expect(stripClosingKeywords("fix: a typo in the fixed header", options)).toBe("fix: a typo in the fixed header")
    expect(stripClosingKeywords("Run `fixes other/repo#1` to see", options)).toBe("Run `fixes other/repo#1` to see")
  })

  test("ordinary hyphenated terms after a closing word keep every word of the sentence", () => {
    for (const [text, out] of [
      ["Fixed utf-8 decoding in the parser.", "Fixed `utf-8` decoding in the parser."],
      ["Resolved sha-256 mismatch on upload.", "Resolved `sha-256` mismatch on upload."],
      ["Completed step-2 of the migration.", "Completed `step-2` of the migration."],
    ] as const) {
      const stripped = stripClosingKeywords(text, options)
      expect(stripped).toBe(out)
      expect(stripped.replace(/`/g, "")).toBe(text)
    }
  })
})

describe("wrapMentions", () => {
  test("wraps GitHub mentions and team mentions in code", () => {
    expect(wrapMentions("Thanks @octocat and @acme/maintainers.")).toBe("Thanks `@octocat` and `@acme/maintainers`.")
    expect(wrapMentions("Mail ops@example.com")).toBe("Mail ops@example.com")
  })

  test("wraps mentions after any punctuation GitHub reads as a boundary", () => {
    expect(wrapMentions("Thanks -@octocat and /@acme/team and .@someone and +@bob")).toBe(
      "Thanks -`@octocat` and /`@acme/team` and .`@someone` and +`@bob`",
    )
    expect(wrapMentions("Mail x-@example.com or first.last+tag@example.com")).toBe(
      "Mail x-@example.com or first.last+tag@example.com",
    )
  })
})

describe("commit message and title", () => {
  test("ends with [skip ci] and starts with the issue key for Linear and Jira", () => {
    const linear = commitMessage({ jid, task: "Fix the login race", issueKey: "ENG-123" })
    expect(linear.split("\n")[0]).toBe("ENG-123 Vector: Fix the login race")
    expect(linear.endsWith("[skip ci]")).toBe(true)
    expect(linear).toContain(jid)
    const slack = commitMessage({ jid, task: "Fix the login race" })
    expect(slack.split("\n")[0]).toBe("Vector: Fix the login race")
    expect(slack.endsWith("[skip ci]")).toBe(true)
  })

  test("the title carries no mention, reference, link or closing reference", () => {
    const title = prTitle({ task: "Fixes other/repo#12 for @bob, see https://evil.example now" })
    expect(title).not.toMatch(/[@#]|evil|other\/repo/)
    expect(title).toStartWith("Vector: ")
    expect(prTitle({ task: "" })).toBe("Vector: requested changes")
    expect(prTitle({ task: "x", issueKey: "not a key" })).toBe("Vector: x")
  })
})

describe("prTemplate", () => {
  const base = {
    jid,
    platform: "linear" as const,
    repository: "acme/widgets",
    task: "Make the login retry with backoff for @carol",
    issueKey: "ENG-123",
    summary:
      "Added backoff to the login retry. ![x](https://evil.example/p.png) Thanks @dave. Fixes other/repo#9 and ENG-9." +
      ` <!-- vector:job ${createJobId(time)} -->`,
    held: 2,
  }

  test("is the fixed template, with the summary checked again", () => {
    const { title, body } = prTemplate(base)
    expect(title).toBe("ENG-123 Vector: Make the login retry with backoff for carol")
    expect(body).toContain("Added backoff to the login retry.")
    expect(body).not.toContain("evil.example")
    expect(body).toContain("`@dave`")
    expect(body).toContain("`other/repo#9`")
    expect(body).not.toMatch(/Fixes other\/repo/)
    expect(body).toContain("Held back: 2 files under .github/")
    expect(body).toContain("Checks have not run: the commit carries [skip ci]")
    expect(body).toContain("\nFixes ENG-123\n")
    expect(body).toContain("a request on Linear.")
    expect(body.endsWith(jobMarker(jid))).toBe(true)
    expect(body.match(/<!--/g)).toHaveLength(1)
  })

  test("no model or platform text but the checked summary goes into the body", () => {
    const { body } = prTemplate({ ...base, summary: undefined })
    expect(body).not.toContain("backoff")
    expect(body).not.toContain("carol")
    expect(body).toStartWith("No summary was sent.")
  })

  test("writes the issue line each platform links on", () => {
    expect(prTemplate({ ...base, platform: "jira", issueKey: "PROJ-123" }).body).toContain("\nPROJ-123\n")
    expect(prTemplate({ ...base, platform: "jira", issueKey: "PROJ-123" }).title).toStartWith("PROJ-123 Vector: ")
    const github = prTemplate({
      ...base,
      platform: "github",
      issueKey: undefined,
      github: { kind: "issue", number: 12 },
    })
    expect(github.body).toContain("\nRefs #12\n")
    expect(github.title).toStartWith("Vector: ")
    const slack = prTemplate({ ...base, platform: "slack", issueKey: "ENG-123" })
    expect(slack.title).toStartWith("Vector: ")
    expect(slack.body).not.toContain("Fixes ENG-123")
  })

  test("mentions after punctuation are wrapped in the body, which the user's own login opens", () => {
    const { body } = prTemplate({
      ...base,
      summary: "Thanks -@octocat, /@acme/team, .@someone and +@bob. Also \\@carol and x``@dave`.",
    })
    for (const name of ["@octocat", "@acme/team", "@someone", "@bob", "@carol", "@dave"])
      expect(body).toContain(`\`${name}\``)
    expect(body.replace(/`[^`\n]+`/g, "").replace(jobMarker(jid), "")).not.toContain("@")
  })

  test("no image, definition or outside address reaches the body", () => {
    for (const summary of [
      "Done.\n\n![a]\n\n> [a]: //evil.example/p.png?d=x",
      "Done. <[](a)img src=//evil.example/a.png>",
      "Done. See //evil.example/x, https:/evil.example/y and http:evil.example/z.",
      "Done.\n\n![b][]\n\n- [b]: https://evil.example/p.png",
    ]) {
      const { body } = prTemplate({ ...base, summary })
      expect(body).not.toContain("evil.example")
      expect(body).not.toContain("<img")
      expect(body).not.toContain("![")
      expect(body.replace(jobMarker(jid), "")).not.toContain("//")
      expect(body).toStartWith("Done.")
    }
  })

  test("a summary with a token split by markup is withheld", () => {
    const token = "gh" + "p_" + Array.from(crypto.getRandomValues(new Uint8Array(36)), (b) => "abc123"[b % 6]).join("")
    const { body } = prTemplate({ ...base, summary: `Token ${token.slice(0, 2)}<b></b>${token.slice(2)}` })
    expect(body).toStartWith(WITHHELD.secret)
    expect(body).not.toContain(token.slice(2))
  })

  test("a summary with code or a secret is withheld with the fixed text", () => {
    expect(prTemplate({ ...base, summary: "Done.\n```\ncode\n```" }).body).toStartWith(WITHHELD.code)
    const token = "gh" + "p_" + Array.from(crypto.getRandomValues(new Uint8Array(36)), (b) => "abc123"[b % 6]).join("")
    const { body } = prTemplate({ ...base, summary: `Token ${token}` })
    expect(body).toStartWith(WITHHELD.secret)
    expect(body).not.toContain(token)
  })

  test("refuses inputs that are not a job", () => {
    expect(() => prTemplate({ ...base, jid: "vej_x" })).toThrow()
    expect(() => prTemplate({ ...base, repository: "acme/widgets\nmore" })).toThrow()
    expect(() => prTemplate({ ...base, platform: "gitlab" as never })).toThrow()
  })
})
