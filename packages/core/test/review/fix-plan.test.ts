import { describe, expect, test } from "bun:test"
import { isUtf8 } from "node:buffer"
import { fixCandidates, fixPath, planEdits, plainBranch, type FixCandidate } from "../../src/review/fix-plan"
import { FIX_LIMITS } from "../../src/review/fix-proposal"
import type { PlacedFinding, Selection, StrictFinding } from "../../src/review/types"

// VS-12c/VS-12d (SF-10b): the planner the CLI step and the desktop share. The CLI's own planner cases stay in engine
// test/cli/review-fix.test.ts, which now imports this module; these cover what moving it out of Node changed (the
// UTF-8 rule and byte counts without Buffer) and the desktop's {selection}-only outcome.

const fix = (id: string, file: string, start: number, text: string, overrides: Partial<FixCandidate> = {}) =>
  ({
    id,
    path: file,
    start,
    end: start,
    label: "concern",
    title: id,
    kind: "lines",
    text,
    ...overrides,
  }) as FixCandidate
const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...new TextEncoder().encode(part)] : part)))

function placed(id: string, overrides: Partial<PlacedFinding> = {}): PlacedFinding {
  return {
    id,
    path: "src/a.ts",
    line: 2,
    side: "RIGHT",
    source: "review",
    severity: "blocking",
    category: "bug",
    title: `Title ${id}`,
    body: "Body",
    confidence: 0.9,
    anchor: { path: "src/a.ts", side: "RIGHT", line: 2, hunk: 0 },
    suggestionAllowed: true,
    ...overrides,
  }
}

function selection(patch: Partial<Selection> = {}): Selection {
  return {
    inline: [],
    outsideDiff: [],
    elsewhere: [],
    nits: [],
    overflow: [],
    stillOpen: [],
    fixed: [],
    dismissed: [],
    reappeared: [],
    raised: [],
    dropped: [],
    risk: "low",
    ...patch,
  }
}

describe("the shared fix planner (core review/fix-plan.ts)", () => {
  test("a file is planned exactly when Node's isUtf8 accepts it and it has no NUL; a byte order mark is kept", () => {
    const table: [string, Uint8Array][] = [
      ["ascii", bytes("one\ntwo\n")],
      ["multibyte", bytes("é€😀\ntwo\n")],
      ["bom", bytes([0xef, 0xbb, 0xbf], "one\ntwo\n")],
      ["overlong", bytes([0xc0, 0xaf], "\ntwo\n")],
      ["surrogate", bytes([0xed, 0xa0, 0x80], "\ntwo\n")],
      ["truncated", bytes("one\ntwo\n", [0xe2, 0x82])],
      ["past-max", bytes([0xf4, 0x90, 0x80, 0x80], "\ntwo\n")],
      ["nul", bytes("one\0\ntwo\n")],
    ]
    const results = table.map(([name, head]) => {
      const plan = planEdits([fix(name, `${name}.txt`, 2, "TWO")], new Map([[`${name}.txt`, head]]))
      return { name, plan, planned: plan.files.length === 1, node: isUtf8(head) && !head.includes(0) }
    })
    expect(results.map((item) => [item.name, item.planned])).toEqual(results.map((item) => [item.name, item.node]))
    expect(results.filter((item) => item.planned).map((item) => item.name)).toEqual(["ascii", "multibyte", "bom"])
    const bom = results.find((item) => item.name === "bom")!.plan.files[0]!
    expect([...bom.after.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bom.after)).toBe("\uFEFFone\nTWO\n")
    expect(results.find((item) => item.name === "overlong")!.plan.skipped).toEqual([
      {
        id: "overlong",
        path: "overlong.txt",
        reason: "the file is not UTF-8 text Vector can read at the reviewed commit",
      },
    ])
  })

  test("the patch size limit counts UTF-8 bytes, not UTF-16 units", () => {
    // One line of 140,000 "é": about 140,000 UTF-16 units, under the limit, but about 280,000 bytes, over it.
    const wide = "é".repeat(140_000)
    expect(wide.length).toBeLessThan(FIX_LIMITS.patchBytes)
    expect(new TextEncoder().encode(wide).length).toBeGreaterThan(FIX_LIMITS.patchBytes)
    const planned = planEdits(
      [fix("wide", "w.txt", 1, wide), fix("small", "x.txt", 1, "y")],
      new Map([
        ["w.txt", bytes("x\n")],
        ["x.txt", bytes("x\n")],
      ]),
    )
    expect(planned.files.map((file) => file.path)).toEqual(["x.txt"])
    expect(planned.skipped).toEqual([{ id: "wide", path: "w.txt", reason: "over the proposal's size limit" }])
  })

  test("a {selection}-only outcome (the desktop's) offers only verified committable inline suggestions", () => {
    const head = "a".repeat(40)
    const found = fixCandidates(
      {
        selection: selection({
          inline: [
            placed("taken", { verified: true, suggestion: "fixed();" }),
            placed("sure-but-unverified", { confidence: 0.99, suggestion: "maybe();" }),
            placed("not-committable", { verified: true, suggestion: "x", suggestionAllowed: false }),
            placed("no-suggestion", { verified: true }),
            placed("earlier", {
              verified: true,
              suggestion: "first();",
              path: "src/a.ts",
              anchor: { path: "src/a.ts", side: "RIGHT", line: 1, hunk: 0 },
            }),
          ],
          overflow: [{ ...placed("overflow"), verified: true, suggestion: "o" }],
          nits: [{ ...placed("nit"), verified: true, suggestion: "n" }],
        }),
      },
      head,
    )
    expect(found.fixes.map((item) => [item.id, item.path, item.start, item.kind, item.text])).toEqual([
      ["earlier", "src/a.ts", 1, "lines", "first();"],
      ["taken", "src/a.ts", 2, "lines", "fixed();"],
    ])
    expect(found.left).toEqual({ unverified: 1, unfixable: 2, unlisted: 2, unchecked: 0 })
    const strict: StrictFinding = {
      id: "strict",
      class: "crash",
      mechanism: "logic",
      path: "src/a.ts",
      line: 2,
      side: "RIGHT",
      title: "Strict",
      trigger: "t",
      impact: "i",
      quotes: [],
      fix: { kind: "suggestion", text: "s" },
      verifiedBy: "model",
      verifier: "p/m",
    }
    const stale = fixCandidates(
      {
        selection: selection({ inline: [placed("taken", { verified: true, suggestion: "fixed();" })] }),
        strict: { version: 1, head: "b".repeat(40), complete: true, findings: [strict], dropped: [], fixUnchecked: 0 },
      },
      head,
    )
    expect(stale.fixes).toEqual([])
    expect(stale.none).toBe("the strict result is for another commit than the one reviewed.")
  })

  test("secret holdback rejects new placeholder lines even when the same fix removes an old placeholder", () => {
    const token = "ghp_" + "k4E5".repeat(9)
    const heads = new Map([
      ["src/a.ts", bytes(`const key = "${token}"\nreturn items[items.length]\n`)],
      ["src/b.ts", bytes(`log("[redacted]")\nreturn items[items.length]\n`)],
      ["src/c.ts", bytes(`log("[redacted]")\nsetup()\nconst key = "${token}"\n`)],
      ["src/d.ts", bytes(`log("[redacted]")\nsetup()\nconst key = "${token}"\n`)],
      ["src/e.ts", bytes(`[redacted]\n${token}\n`)],
      ["src/f.ts", bytes(`[redacted]\n${token}\n`)],
    ])
    const plan = planEdits(
      [
        fix("echo", "src/a.ts", 1, `const key = "[redacted]"\nreturn items[items.length - 1]`, { end: 2 }),
        fix("kept", "src/b.ts", 1, `log("[redacted]")\nreturn items[items.length - 1]`, { end: 2 }),
        fix("replace", "src/c.ts", 1, `log("ok")\nsetup()\nconst key = "[redacted]"`, { end: 3 }),
        fix(
          "patch",
          "src/d.ts",
          1,
          `@@ -1,3 +1,3 @@\n-log("[redacted]")\n+log("ok")\n setup()\n-const key = "${token}"\n+const key = "[redacted]"\n`,
          { kind: "patch" },
        ),
        fix("adjacent", "src/e.ts", 1, "new\n[redacted]", { end: 2 }),
        fix("adjacent-patch", "src/f.ts", 1, `@@ -1,2 +1,2 @@\n-[redacted]\n-${token}\n+new\n+[redacted]\n`, {
          kind: "patch",
        }),
      ],
      heads,
      { holdback: "secrets" },
    )
    expect(plan.used.map((item) => item.id)).toEqual(["kept"])
    expect(plan.skipped).toEqual([
      { id: "echo", path: "src/a.ts", reason: "its fix writes the [redacted] placeholder into the file" },
      { id: "replace", path: "src/c.ts", reason: "its fix writes the [redacted] placeholder into the file" },
      { id: "patch", path: "src/d.ts", reason: "its fix writes the [redacted] placeholder into the file" },
      { id: "adjacent", path: "src/e.ts", reason: "its fix writes the [redacted] placeholder into the file" },
      { id: "adjacent-patch", path: "src/f.ts", reason: "its fix writes the [redacted] placeholder into the file" },
    ])
    expect(plan.files.map((file) => file.path)).toEqual(["src/b.ts"])
    expect(new TextDecoder().decode(plan.files[0]!.after)).toBe(`log("[redacted]")\nreturn items[items.length - 1]\n`)
  })

  test("a review without secret holdback can intentionally write the literal [redacted]", () => {
    const fixes = [fix("label", "src/a.ts", 1, `const privacyLabel = "[redacted]"`)]
    const heads = new Map([["src/a.ts", bytes(`const privacyLabel = "hidden"\n`)]])
    for (const plan of [planEdits(fixes, heads), planEdits(fixes, heads, { holdback: "off" })]) {
      expect(plan.skipped).toEqual([])
      expect(new TextDecoder().decode(plan.files[0]!.after)).toBe(`const privacyLabel = "[redacted]"\n`)
    }
  })

  test("plainBranch and fixPath accept only what the proposal contract does, counted in bytes", () => {
    expect(["main", "feature/x-1", "release_2.0", "a/b/c", "abc123"].map(plainBranch), "plain names").toEqual([
      true,
      true,
      true,
      true,
      true,
    ])
    expect(
      ["", "a..b", "a//b", ".hidden", "a/.b", "b.", "x.lock", "a b", "é", "a~1", "x".repeat(257)].map(plainBranch),
    ).toEqual(Array(11).fill(false))
    expect(["src/a.ts", "@scope/pkg/index.js", "a+b,c.txt"].map(fixPath)).toEqual([true, true, true])
    expect(["", "/abs", "a//b", "./a", "a/../b", ".git/config", "x/.GIT/y", "a b", "é"].map(fixPath)).toEqual(
      Array(9).fill(false),
    )
    expect(fixPath("x".repeat(FIX_LIMITS.pathBytes))).toBe(true)
    expect(fixPath("x".repeat(FIX_LIMITS.pathBytes + 1))).toBe(false)
  })
})
