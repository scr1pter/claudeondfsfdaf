import { describe, expect, test } from "bun:test"
import path from "path"
import {
  anchorText,
  applyFixPatch,
  applyPatch,
  budgetDiff,
  buildAnchorIndex,
  endLineOf,
  focusHunks,
  focusOfFiles,
  fromGitHubFiles,
  lookupFile,
  mapLine,
  matchPostImage,
  mergeFocus,
  onChangedLine,
  parseUnifiedDiff,
  patchIdOf,
  renderAnnotated,
  renderPatch,
  resolveAnchor,
  suggestionAllowed,
  touched,
} from "@vectordevai/core/review/diff"

// fixtures/sample.diff is real `git diff --find-renames` output from a throwaway repository.
const fixtures = path.join(import.meta.dir, "fixtures")
const sample = await Bun.file(path.join(fixtures, "sample.diff")).text()
const listBase = await Bun.file(path.join(fixtures, "list.base.txt")).text()
const listHead = await Bun.file(path.join(fixtures, "list.head.txt")).text()
const files = parseUnifiedDiff(sample)
const file = (name: string) => files.find((item) => item.path === name)!
const ix = buildAnchorIndex(files)

function diff(...lines: string[]) {
  return parseUnifiedDiff(lines.join("\n"))
}

describe("parseUnifiedDiff", () => {
  test("reads every file of a git diff with its status", () => {
    expect(files.map((item) => [item.path, item.status, item.oldPath ?? null, item.binary])).toEqual([
      ["assets/logo.png", "modified", null, true],
      ["docs/b.md", "renamed", "docs/a.md", false],
      ["src/added.ts", "added", null, false],
      ["src/café.ts", "modified", null, false],
      ["src/eof.ts", "modified", null, false],
      ["src/list.ts", "modified", null, false],
      ["src/new-name.ts", "renamed", "src/old-name.ts", false],
      ["src/one.txt", "modified", null, false],
      ["src/removed.ts", "deleted", null, false],
      ["src/with space.ts", "modified", null, false],
    ])
  })

  test("numbers the lines of several hunks", () => {
    const list = file("src/list.ts")
    expect(list.hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines])).toEqual([
      [3, 7, 3, 7],
      [16, 5, 16, 6],
    ])
    expect(list.hunks[0].lines.slice(2, 6)).toEqual([
      { kind: "context", oldLine: 5, newLine: 5, text: "export function last(items) {" },
      { kind: "del", oldLine: 6, text: "  return items[items.length]" },
      { kind: "add", newLine: 6, text: "  return items[items.length - 1]" },
      { kind: "context", oldLine: 7, newLine: 7, text: "}" },
    ])
    expect(list.hunks[1].header).toBe("@@ -16,5 +16,6 @@ export function last(items) {")
    expect([list.additions, list.deletions]).toEqual([2, 1])
  })

  test("reads new, deleted and binary files, and renames with and without changes", () => {
    expect(file("src/added.ts").hunks[0].lines.every((line) => line.kind === "add")).toBe(true)
    expect(file("src/added.ts").additions).toBe(3)
    expect(file("src/removed.ts").deletions).toBe(3)
    expect(file("assets/logo.png").hunks).toEqual([])
    expect(file("docs/b.md").hunks).toEqual([])
    expect(file("src/new-name.ts").hunks[0].lines[0]).toEqual({
      kind: "del",
      oldLine: 1,
      text: 'export const name = "old"',
    })
  })

  test("marks lines followed by 'No newline at end of file'", () => {
    expect(file("src/eof.ts").hunks[0].lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "export const value = 1" },
      { kind: "del", oldLine: 2, text: "export const other = 2", noNewline: true },
      { kind: "add", newLine: 2, text: "export const other = 3", noNewline: true },
    ])
  })

  test("reads quoted paths and paths that git ends with a tab", () => {
    expect(file("src/café.ts").hunks[0].lines.map((line) => line.text)).toEqual(["const x = 1", "const x = 2"])
    expect(file("src/with space.ts").additions).toBe(1)
    const [renamed] = diff(
      'diff --git "a/caf\\303\\251.ts" "b/th\\303\\251 \\"x\\".ts"',
      "similarity index 100%",
      'rename from "caf\\303\\251.ts"',
      'rename to "th\\303\\251 \\"x\\".ts"',
    )
    expect([renamed.path, renamed.oldPath, renamed.status]).toEqual(['thé "x".ts', "café.ts", "renamed"])
  })

  test("reads @@ headers without counts", () => {
    const one = file("src/one.txt")
    expect([one.hunks[0].oldLines, one.hunks[0].newLines]).toEqual([1, 1])
    expect(one.patch).toBe("@@ -1 +1 @@\n-a\n+b")
  })

  test("reads CRLF diffs", () => {
    const [crlf] = parseUnifiedDiff(
      "diff --git a/a.txt b/a.txt\r\n--- a/a.txt\r\n+++ b/a.txt\r\n@@ -1,2 +1,2 @@\r\n one\r\n-two\r\n+2\r\n",
    )
    expect(crlf.path).toBe("a.txt")
    expect(crlf.hunks[0].lines.map((line) => line.text)).toEqual(["one", "two", "2"])
  })

  test("keeps a removed line that looks like a file header inside its hunk", () => {
    const [sql] = diff(
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,2 +1 @@",
      "--- note",
      " select 1",
    )
    expect(sql.hunks[0].lines).toEqual([
      { kind: "del", oldLine: 1, text: "-- note" },
      { kind: "context", oldLine: 2, newLine: 1, text: "select 1" },
    ])
  })

  test("reads a context line whose leading space was trimmed", () => {
    const [trimmed] = diff("--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,3 @@", " a", "", "-b", "+c")
    expect(trimmed.hunks[0].lines.map((line) => line.kind)).toEqual(["context", "context", "del", "add"])
  })

  test("reads plain unified diffs and hunk-only patches", () => {
    const plain = diff(
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/y.ts",
      "+++ b/y.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d",
    )
    expect(plain.map((item) => item.path)).toEqual(["x.ts", "y.ts"])
    const [bare] = diff("@@ -4,2 +4,2 @@ fn()", " a", "-b", "+c")
    expect([bare.path, bare.hunks[0].newStart, bare.hunks.length]).toEqual(["", 4, 1])
  })
})

describe("fromGitHubFiles", () => {
  const gh = fromGitHubFiles([
    {
      filename: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -10,3 +10,3 @@ fn\n x\n-y\n+z\n w",
    },
    { filename: "src/big.ts", status: "modified", additions: 4000, deletions: 0 },
    { filename: "img/logo.png", status: "added", additions: 0, deletions: 0 },
    { filename: "src/new.ts", status: "renamed", previous_filename: "src/old.ts", additions: 0, deletions: 0 },
    { filename: "gone.ts", status: "removed", additions: 0, deletions: 2, patch: "@@ -1,2 +0,0 @@\n-a\n-b" },
  ])

  test("parses hunk-only patches", () => {
    expect(gh[0].hunks[0].lines.map((line) => [line.kind, line.oldLine ?? null, line.newLine ?? null])).toEqual([
      ["context", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
      ["context", 12, 12],
    ])
    expect(gh[4].status).toBe("deleted")
  })

  test("keeps a file with no patch, binary only by its extension", () => {
    expect([gh[1].hunks, gh[1].binary, gh[1].additions]).toEqual([[], false, 4000])
    expect(gh[2].binary).toBe(true)
    expect([gh[3].status, gh[3].oldPath]).toEqual(["renamed", "src/old.ts"])
    const index = buildAnchorIndex(gh)
    expect(resolveAnchor(index, { path: "src/big.ts", line: 3 })).toEqual({ ok: false, reason: "no-patch" })
    expect(resolveAnchor(index, { path: "src/a.ts", line: 11 })).toEqual({
      ok: true,
      anchor: { path: "src/a.ts", side: "RIGHT", line: 11, hunk: 0 },
    })
  })
})

describe("resolveAnchor", () => {
  const at = (line: number, extra: { endLine?: number; side?: "LEFT" | "RIGHT"; path?: string } = {}) =>
    resolveAnchor(ix, { path: extra.path ?? "src/list.ts", line, endLine: extra.endLine, side: extra.side })

  test("anchors added and context lines", () => {
    expect(at(6)).toEqual({ ok: true, anchor: { path: "src/list.ts", side: "RIGHT", line: 6, hunk: 0 } })
    expect(at(4)).toEqual({ ok: true, anchor: { path: "src/list.ts", side: "RIGHT", line: 4, hunk: 0 } })
    expect(at(19)).toEqual({ ok: true, anchor: { path: "src/list.ts", side: "RIGHT", line: 19, hunk: 1 } })
  })

  test("keeps a range inside one hunk and collapses one across hunks to its end line", () => {
    expect(at(5, { endLine: 7 })).toEqual({
      ok: true,
      anchor: { path: "src/list.ts", side: "RIGHT", line: 7, startLine: 5, hunk: 0 },
    })
    expect(at(6, { endLine: 19 })).toEqual({
      ok: true,
      anchor: { path: "src/list.ts", side: "RIGHT", line: 19, hunk: 1 },
    })
    expect(at(6, { endLine: 40 })).toEqual({
      ok: true,
      anchor: { path: "src/list.ts", side: "RIGHT", line: 6, hunk: 0 },
    })
  })

  test("anchors a LEFT deletion, and only a deletion", () => {
    expect(at(6, { side: "LEFT" })).toEqual({
      ok: true,
      anchor: { path: "src/list.ts", side: "LEFT", line: 6, hunk: 0 },
    })
    expect(at(5, { side: "LEFT" })).toEqual({ ok: false, reason: "line-outside-diff" })
  })

  test("snaps a line up to 3 lines outside a hunk to the nearest added line", () => {
    expect(at(12)).toEqual({ ok: true, anchor: { path: "src/list.ts", side: "RIGHT", line: 6, hunk: 0 } })
    expect(at(13)).toEqual({ ok: true, anchor: { path: "src/list.ts", side: "RIGHT", line: 19, hunk: 1 } })
    expect(at(30)).toEqual({ ok: false, reason: "line-outside-diff" })
    expect(at(0)).toEqual({ ok: false, reason: "line-outside-diff" })
  })

  test("reports files that are not in the diff or have no patch", () => {
    expect(at(1, { path: "src/nope.ts" })).toEqual({ ok: false, reason: "file-not-in-diff" })
    expect(at(1, { path: "assets/logo.png" })).toEqual({ ok: false, reason: "no-patch" })
    expect(at(1, { path: "docs/b.md" })).toEqual({ ok: false, reason: "no-patch" })
  })

  test("finds a file by the forms a model writes it in, and by a renamed file's old path", () => {
    for (const name of ["./src/list.ts", "b/src/list.ts", "/home/runner/work/r/r/src/list.ts"])
      expect(at(6, { path: name })).toEqual({
        ok: true,
        anchor: { path: "src/list.ts", side: "RIGHT", line: 6, hunk: 0 },
      })
    expect(at(1, { path: "src/old-name.ts" })).toEqual({
      ok: true,
      anchor: { path: "src/new-name.ts", side: "RIGHT", line: 1, hunk: 0 },
    })
  })

  test("prefers the longest path a full checkout path ends with", () => {
    const [root] = diff("--- a/list.ts", "+++ b/list.ts", "@@ -1 +1 @@", "-a", "+b")
    const both = buildAnchorIndex([root, file("src/list.ts")])
    expect(lookupFile(both, "/w/r/src/list.ts")?.file.path).toBe("src/list.ts")
    expect(lookupFile(both, "/w/r/list.ts")?.file.path).toBe("list.ts")
    expect(lookupFile(both, "/w/r/other.ts")).toBeUndefined()
  })

  test("anchorText returns the anchored code on its side", () => {
    expect(anchorText(ix, { path: "src/list.ts", side: "RIGHT", line: 7, startLine: 5, hunk: 0 })).toBe(
      "export function last(items) {\n  return items[items.length - 1]\n}",
    )
    expect(anchorText(ix, { path: "src/list.ts", side: "LEFT", line: 6, hunk: 0 })).toBe("  return items[items.length]")
  })
})

describe("suggestionAllowed", () => {
  const anchor = { path: "src/list.ts", side: "RIGHT" as const, line: 6, hunk: 0 }

  test("allows a changed replacement in the file's indentation", () => {
    expect(suggestionAllowed(ix, anchor, "  return items.at(-1)")).toBe(true)
    expect(suggestionAllowed(ix, anchor, "  return items.at(-1)\n")).toBe(true)
    expect(
      suggestionAllowed(
        ix,
        { ...anchor, line: 7, startLine: 5 },
        "export function last(items) {\n  return items.at(-1)\n}",
      ),
    ).toBe(true)
  })

  test("refuses the cases in section 3.3", () => {
    expect(suggestionAllowed(ix, { ...anchor, side: "LEFT" }, "  return items.at(-1)")).toBe(false)
    expect(suggestionAllowed(ix, anchor, "  return items[items.length - 1]")).toBe(false)
    expect(suggestionAllowed(ix, anchor, "  \n")).toBe(false)
    expect(suggestionAllowed(ix, anchor, "\treturn items.at(-1)")).toBe(false)
    expect(suggestionAllowed(ix, anchor, Array.from({ length: 41 }, () => "  x").join("\n"))).toBe(false)
    expect(suggestionAllowed(ix, { path: "src/removed.ts", side: "RIGHT", line: 1, hunk: 0 }, "x")).toBe(false)
    expect(suggestionAllowed(ix, { ...anchor, line: 19, startLine: 6, hunk: 1 }, "  x")).toBe(false)
  })

  test("needs a verified finding in untrusted mode", () => {
    expect(suggestionAllowed(ix, anchor, "  return items.at(-1)", { trust: "untrusted" })).toBe(false)
    expect(suggestionAllowed(ix, anchor, "  return items.at(-1)", { trust: "untrusted", verified: true })).toBe(true)
  })

  test("needs the anchor to be the fix's own lines: not a range collapsed across hunks, not a snapped line", () => {
    const collapsed = resolveAnchor(ix, { path: "src/list.ts", line: 6, endLine: 19 })
    expect(collapsed.ok && suggestionAllowed(ix, collapsed.anchor, "  x", { range: { line: 6, endLine: 19 } })).toBe(
      false,
    )
    const snapped = resolveAnchor(ix, { path: "src/list.ts", line: 12 })
    expect(snapped.ok && suggestionAllowed(ix, snapped.anchor, "  return items.at(-1)", { range: { line: 12 } })).toBe(
      false,
    )
    expect(suggestionAllowed(ix, anchor, "  return items.at(-1)", { range: { line: 6 } })).toBe(true)
  })

  test("refuses a fix that repeats the lines just around its range", () => {
    const [user] = diff(
      "diff --git a/src/user.ts b/src/user.ts",
      "--- a/src/user.ts",
      "+++ b/src/user.ts",
      "@@ -1,6 +1,6 @@",
      ' import { getUser } from "./db"',
      " ",
      " export async function displayName(id: string) {",
      "-  const user = await getUser(id)",
      "+  const user = getUser(id)",
      "   return user.name.trim()",
      " }",
    )
    const index = buildAnchorIndex([user!])
    const four = { path: "src/user.ts", side: "RIGHT" as const, line: 4, hunk: 0 }
    const fix = '  const user = await getUser(id)\n  if (!user) return "Unknown user"\n  return user.name.trim()'
    // Committed over line 4 alone, the last line would be there twice.
    expect(suggestionAllowed(index, four, fix)).toBe(false)
    expect(suggestionAllowed(index, { ...four, line: 5, startLine: 4 }, fix)).toBe(true)
    expect(
      suggestionAllowed(
        index,
        four,
        "export async function displayName(id: string) {\n  const user = await getUser(id)",
      ),
    ).toBe(false)
    // A closing brace after the range is not a repeat.
    expect(suggestionAllowed(index, { ...four, line: 5, startLine: 4 }, "  const user = await getUser(id)\n}")).toBe(
      true,
    )
  })
})

describe("mapLine and touched", () => {
  const changes = diff(
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -5,0 +6,2 @@",
    "+inserted one",
    "+inserted two",
    "@@ -20,2 +22 @@",
    "-removed",
    " kept",
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x",
    "diff --git a/old.ts b/new.ts",
    "similarity index 90%",
    "rename from old.ts",
    "rename to new.ts",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -1,0 +2 @@",
    "+header",
  )

  test("maps old lines through inserts and deletions", () => {
    expect([3, 5, 6, 20, 21, 30].map((line) => mapLine(changes, "a.ts", line))).toEqual([3, 5, 8, "deleted", 22, 31])
    expect(mapLine(changes, "untouched.ts", 12)).toBe(12)
    expect(mapLine(changes, "gone.ts", 1)).toBe("deleted")
    expect(mapLine(changes, "old.ts", 4)).toBe(5)
  })

  test("reports changes within the radius of a new line", () => {
    expect(touched(changes, "a.ts", 6)).toBe(true)
    expect(touched(changes, "a.ts", 12)).toBe(true)
    expect(touched(changes, "a.ts", 13)).toBe(false)
    expect(touched(changes, "a.ts", 16)).toBe(true)
    expect(touched(changes, "a.ts", 27)).toBe(true)
    expect(touched(changes, "a.ts", 28)).toBe(false)
    expect(touched(changes, "a.ts", 9, 1)).toBe(false)
    expect(touched(changes, "untouched.ts", 1)).toBe(false)
    expect(touched(changes, "gone.ts", 1)).toBe(true)
  })
})

describe("patchIdOf", () => {
  const one = (start: number, removed: string, added: string) =>
    diff(
      "--- a/x.ts",
      "+++ b/x.ts",
      `@@ -${start},3 +${start},3 @@`,
      " before",
      "-" + removed,
      "+" + added,
      " after",
    )[0]

  test("ignores line numbers, context and whitespace", () => {
    expect(patchIdOf(one(1, "b", "c"))).toBe(patchIdOf(one(40, "  b", "c  ")))
    expect(patchIdOf(one(1, "b", "c"))).toMatch(/^[0-9a-f]{16}$/)
  })

  test("changes when one changed line differs", () => {
    expect(patchIdOf(one(1, "b", "c"))).not.toBe(patchIdOf(one(1, "b", "cc")))
  })
})

describe("applyPatch", () => {
  test("rebuilds the head from the base", () => {
    expect(applyPatch(listBase, file("src/list.ts"))).toBe(listHead)
  })

  test("returns undefined when a context line differs", () => {
    expect(applyPatch(listBase.replace("// padding 8", "// padding eight"), file("src/list.ts"))).toBeUndefined()
    expect(applyPatch(listHead, file("src/list.ts"))).toBeUndefined()
  })

  test("keeps CRLF line endings", () => {
    const [crlf] = diff("--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " one", "-two", "+2", " three")
    expect(applyPatch("one\r\ntwo\r\nthree\r\n", crlf)).toBe("one\r\n2\r\nthree\r\n")
  })

  test("follows 'No newline at end of file'", () => {
    expect(applyPatch("export const value = 1\nexport const other = 2", file("src/eof.ts"))).toBe(
      "export const value = 1\nexport const other = 3",
    )
    const [adds] = diff("--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+b")
    expect(applyPatch("a\nb", adds)).toBe("a\nb\n")
  })

  test("builds new files, empties deleted ones and refuses binaries", () => {
    expect(applyPatch("", file("src/added.ts"))).toBe('export async function added() {\n  return "added"\n}\n')
    expect(applyPatch("something\n", file("src/added.ts"))).toBeUndefined()
    expect(applyPatch("export function gone() {\n  return 1\n}\n", file("src/removed.ts"))).toBe("")
    expect(applyPatch("x", file("assets/logo.png"))).toBeUndefined()
  })
})

describe("renderAnnotated", () => {
  test("numbers every head line, marks added lines and shows removed lines where they were", () => {
    const text = renderAnnotated(file("src/list.ts"), listHead)!
    expect(text.split("\n").slice(3, 8)).toEqual([
      " 4",
      " 5   export function last(items) {",
      // A removed line carries its base line number, which a LEFT-side finding anchors to.
      " 6 -   return items[items.length]",
      " 6 +   return items[items.length - 1]",
      " 7   }",
    ])
    expect(text).toContain("19 +   if (!items) return 0")
    // One block holds the whole change, so the diff and the head text need not both be sent.
    expect(text.length).toBeLessThan(renderPatch([file("src/list.ts")]).length + listHead.length)
  })

  test("folds long unchanged runs with their head and base lines, and keeps short ones", () => {
    const text = renderAnnotated(file("src/list.ts"), listHead, { foldAbove: 5, context: 1 })!
    expect(text).toContain("⋯ lines 8-17 unchanged (base lines 8-17)")
    expect(text).toContain(" 1   export function first(items) {")
    expect(text).toContain("21   }")
    const [moved] = diff(
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,4 @@",
      "+import a",
      "+import b",
      " one",
      " two",
      ...Array.from({ length: 10 }, (_, index) => ` same ${index + 1}`),
    )
    const head = ["import a", "import b", "one", "two", ...Array.from({ length: 10 }, (_, i) => `same ${i + 1}`)]
    expect(
      renderAnnotated(moved, head.join("\n") + "\n", { foldAbove: 5, context: 1 })!
        .split("\n")
        .at(-1),
    ).toBe("⋯ lines 4-14 unchanged (base lines 2-12)")
  })

  test("refuses a text that is not the head, a deleted file and a binary", () => {
    expect(renderAnnotated(file("src/list.ts"), listBase)).toBeUndefined()
    expect(renderAnnotated(file("src/removed.ts"), "")).toBeUndefined()
    expect(renderAnnotated(file("assets/logo.png"), "x")).toBeUndefined()
  })
})

describe("matchPostImage", () => {
  test("matches a checkout that already is the head", () => {
    expect(matchPostImage(listHead, file("src/list.ts"))).toBe(true)
    expect(matchPostImage(listBase, file("src/list.ts"))).toBe(false)
    expect(matchPostImage('export async function added() {\n  return "added"\n}\n', file("src/added.ts"))).toBe(true)
    expect(matchPostImage('export async function added() {\n  return "added"\n}\nextra\n', file("src/added.ts"))).toBe(
      false,
    )
  })
})

describe("focusHunks", () => {
  const pr = [file("src/list.ts")]

  test("excludes lines a merge brought in from the base branch", () => {
    const merged = diff(
      "--- a/src/list.ts",
      "+++ b/src/list.ts",
      "@@ -12 +12 @@",
      "-// padding 4 old",
      "+// padding 4",
      "--- a/src/other.ts",
      "+++ b/src/other.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    )
    expect(focusHunks(pr, merged)).toEqual([])
  })

  test("includes a pull request hunk that a resolved conflict changed", () => {
    const resolved = diff(
      "--- a/src/list.ts",
      "+++ b/src/list.ts",
      "@@ -6 +6 @@",
      "-  return items[items.length - 2]",
      "+  return items[items.length - 1]",
    )
    expect(focusHunks(pr, resolved)).toEqual([{ path: "src/list.ts", start: 1, end: 12 }])
  })

  test("counts a deletion inside a pull request hunk at its position", () => {
    const deleted = diff(
      "--- a/src/list.ts",
      "+++ b/src/list.ts",
      "@@ -19,3 +19,2 @@",
      "   if (!items) return 0",
      "-  // old comment",
      "   return items.length",
    )
    expect(focusHunks(pr, deleted)).toEqual([{ path: "src/list.ts", start: 13, end: 24 }])
  })

  test("focusOfFiles and mergeFocus", () => {
    expect(focusOfFiles(files, ["src/eof.ts", "src/removed.ts"])).toEqual([{ path: "src/eof.ts", start: 1, end: 5 }])
    expect(
      mergeFocus(
        [
          { path: "a", start: 1, end: 5 },
          { path: "b", start: 1, end: 2 },
        ],
        [
          { path: "a", start: 4, end: 9 },
          { path: "a", start: 20, end: 22 },
        ],
      ),
    ).toEqual([
      { path: "a", start: 1, end: 9 },
      { path: "a", start: 20, end: 22 },
      { path: "b", start: 1, end: 2 },
    ])
  })
})

describe("budgetDiff and renderPatch", () => {
  test("renders a unified diff that parses back to the same hunks", () => {
    expect(renderPatch([file("src/one.txt")])).toBe(
      "diff --git a/src/one.txt b/src/one.txt\n--- a/src/one.txt\n+++ b/src/one.txt\n@@ -1 +1 @@\n-a\n+b",
    )
    const again = parseUnifiedDiff(renderPatch([file("src/list.ts"), file("src/eof.ts"), file("src/new-name.ts")]))
    expect(again.map((item) => [item.path, item.oldPath ?? null])).toEqual([
      ["src/list.ts", null],
      ["src/eof.ts", null],
      ["src/new-name.ts", "src/old-name.ts"],
    ])
    expect(again.map((item) => item.hunks)).toEqual([
      file("src/list.ts").hunks,
      file("src/eof.ts").hunks,
      file("src/new-name.ts").hunks,
    ])
  })

  test("trims context and splits a hunk where it drops a run of context", () => {
    const trimmed = parseUnifiedDiff(renderPatch([file("src/list.ts")], 1))[0]
    expect(trimmed.hunks.map((hunk) => hunk.header)).toEqual([
      "@@ -5,3 +5,3 @@ export function first(items) {",
      "@@ -18,2 +18,3 @@ export function last(items) {",
    ])
    const [split] = diff("--- a/x", "+++ b/x", "@@ -1,6 +1,6 @@", "-a", "+A", " b", " c", " d", " e", "-f", "+F")
    expect(parseUnifiedDiff(renderPatch([split], 1))[0].hunks.map((hunk) => hunk.header)).toEqual([
      "@@ -1,2 +1,2 @@",
      "@@ -5,2 +5,2 @@",
    ])
  })

  test("fits whole files in order and lists the rest", () => {
    const size = (name: string) => renderPatch([file(name)]).length + 1
    const picked = budgetDiff(
      [file("src/list.ts"), file("src/added.ts"), file("src/one.txt")],
      size("src/list.ts") + size("src/one.txt"),
    )
    expect(picked.inline.map((item) => item.path)).toEqual(["src/list.ts", "src/one.txt"])
    expect(picked.notInlined.map((item) => item.path)).toEqual(["src/added.ts"])
  })
})

describe("applyFixPatch (VS-27b, S6)", () => {
  // src/load.ts at head: 8 lines and a final newline.
  const head = [
    "function load(user) {",
    "  const id = user.id",
    "  return fetch(id)",
    "}",
    "",
    "function save(user) {",
    "  write(user)",
    "}",
    "",
  ].join("\n")
  const at = (lines: string[]) => lines.join("\n")
  const hunk = ["@@ -2,2 +2,2 @@", "-  const id = user.id", "+  const id = user?.id", "   return fetch(id)"]
  const fixed = head.replace("  const id = user.id", "  const id = user?.id")
  const apply = (patch: string, maxHunks = 3) => applyFixPatch(head, patch, { path: "src/load.ts", maxHunks })
  const git = (...lines: string[]) => ["diff --git a/src/load.ts b/src/load.ts", ...lines]

  test("applies bare hunks, or hunks under headers naming the finding's file", () => {
    expect(apply(at(hunk))).toEqual({ ok: true, text: fixed, hunks: 1 })
    expect(
      apply(at([...git("index 1111111..2222222 100644", "--- a/src/load.ts", "+++ b/src/load.ts"), ...hunk])),
    ).toEqual({ ok: true, text: fixed, hunks: 1 })
    expect(apply(at(["--- src/load.ts", "+++ src/load.ts", ...hunk]))).toEqual({ ok: true, text: fixed, hunks: 1 })
    // Blank lines after the last hunk, and an empty context line whose leading space was trimmed, are fine.
    expect(apply(at([...hunk, "", ""]))).toEqual({ ok: true, text: fixed, hunks: 1 })
    expect(apply(at(["@@ -4,3 +4,3 @@", " }", "", "-function save(user) {", "+function save(user: User) {"]))).toEqual({
      ok: true,
      text: head.replace("function save(user) {", "function save(user: User) {"),
      hunks: 1,
    })
    // A CRLF file keeps its line endings.
    expect(applyFixPatch(head.replaceAll("\n", "\r\n"), at(hunk), { path: "src/load.ts", maxHunks: 3 })).toEqual({
      ok: true,
      text: fixed.replaceAll("\n", "\r\n"),
      hunks: 1,
    })
  })

  test("pure insertions and deletions, and later hunks offset by earlier ones", () => {
    expect(apply(at(["@@ -3,0 +4,1 @@", "+  log(id)"]))).toEqual({
      ok: true,
      text: head.replace("  return fetch(id)\n", "  return fetch(id)\n  log(id)\n"),
      hunks: 1,
    })
    expect(apply(at(["@@ -3,1 +2,0 @@", "-  return fetch(id)"]))).toEqual({
      ok: true,
      text: head.replace("  return fetch(id)\n", ""),
      hunks: 1,
    })
    const insert = ["@@ -2,1 +2,2 @@", "   const id = user.id", "+  check(id)"]
    const later = (start: string) => [start, "-  write(user)", "+  write(check(user))"]
    expect(apply(at([...insert, ...later("@@ -7,1 +8,1 @@")]))).toEqual({
      ok: true,
      text: head.replace("user.id\n", "user.id\n  check(id)\n").replace("  write(user)", "  write(check(user))"),
      hunks: 2,
    })
    // The second hunk's new start ignores the line the first one added.
    expect(apply(at([...insert, ...later("@@ -7,1 +7,1 @@")]))).toEqual({ ok: false, reason: "malformed" })
  })

  test("a patch is malformed unless every line belongs to a well-counted hunk", () => {
    for (const patch of [
      "",
      "no hunk here",
      at([...hunk, "garbage after the hunk"]),
      at([
        "@@ -2,1 +2,1 @@",
        "-  const id = user.id",
        "+  const id = user?.id",
        "junk",
        "@@ -7 +7 @@",
        "-  write(user)",
        "+  write(u)",
      ]),
      // A header that promises more lines than follow, and one whose new start does not follow from its old start.
      at(["@@ -2,3 +2,3 @@", "-  const id = user.id", "+  const id = user?.id", "   return fetch(id)"]),
      at(["@@ -2,2 +5,2 @@", ...hunk.slice(1)]),
      // A lone file header the parser never reads, a mode change, a header this applier does not take, a prose line.
      at(["--- a/src/other.ts", ...hunk]),
      at([...git("old mode 100644", "new mode 100755", "--- a/src/load.ts", "+++ b/src/load.ts"), ...hunk]),
      at(["diff --vector a/src/load.ts b/src/load.ts", ...hunk]),
      at(["Here is the fix:", ...hunk]),
      at(["Binary files a/src/load.ts and b/src/load.ts differ"]),
    ])
      expect(apply(patch)).toEqual({ ok: false, reason: "malformed" })
  })

  test("headers never choose the file: another path, a new, deleted or renamed file is other-file", () => {
    for (const preamble of [
      ["--- a/src/other.ts", "+++ b/src/other.ts"],
      ["diff --git a/src/other.ts b/src/other.ts"],
      ["--- /dev/null", "+++ b/src/load.ts"],
      ["--- a/src/load.ts", "+++ /dev/null"],
      git("new file mode 100644", "--- a/src/load.ts", "+++ b/src/load.ts"),
      git("deleted file mode 100644", "--- a/src/load.ts", "+++ b/src/load.ts"),
      [
        "diff --git a/src/old.ts b/src/load.ts",
        "similarity index 90%",
        "rename from src/old.ts",
        "rename to src/load.ts",
      ],
      ["--- a/src/old.ts", "+++ b/src/load.ts"],
    ])
      expect(apply(at([...preamble, ...hunk]))).toEqual({ ok: false, reason: "other-file" })
    expect(
      apply(
        at(["--- a/src/load.ts", "+++ b/src/load.ts", ...hunk, "--- a/src/other.ts", "+++ b/src/other.ts", ...hunk]),
      ),
    ).toEqual({
      ok: false,
      reason: "several-files",
    })
  })

  test("at most maxHunks hunks, at their exact positions, and a change", () => {
    const four = at(
      [1, 3, 6, 8].flatMap((line) => [
        `@@ -${line},1 +${line},1 @@`,
        `-${head.split("\n")[line - 1]}`,
        `+${head.split("\n")[line - 1]} // fixed`,
      ]),
    )
    expect(apply(four)).toEqual({ ok: false, reason: "hunks" })
    expect(apply(four, 4)).toMatchObject({ ok: true, hunks: 4 })
    // A context line that differs, or the right lines at another position: no offset, no fuzz.
    expect(
      apply(at(["@@ -2,2 +2,2 @@", "-  const id = user.id", "+  const id = user?.id", "   return fetch(user)"])),
    ).toEqual({
      ok: false,
      reason: "context",
    })
    expect(apply(at(["@@ -3,2 +3,2 @@", ...hunk.slice(1)]))).toEqual({ ok: false, reason: "context" })
    expect(apply(at(["@@ -40,1 +40,1 @@", "-  write(user)", "+  write(u)"]))).toEqual({ ok: false, reason: "context" })
    expect(apply(at(["@@ -7,1 +7,1 @@", "-  write(user)", "+  write(user)"]))).toEqual({
      ok: false,
      reason: "unchanged",
    })
  })
})

// S3, moved from guardrail.ts unchanged (VS-43a) so citation.ts can share it without importing the guardrail.
describe("onChangedLine and endLineOf (S3)", () => {
  const changes = parseUnifiedDiff(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,4 +1,5 @@\n one\n-two\n+TWO\n+three\n four\n five\n",
  )
  const index = buildAnchorIndex(changes)
  const at = (finding: { line: number; endLine?: number; side?: "RIGHT" | "LEFT" }) => {
    const resolved = resolveAnchor(index, { path: "a.ts", ...finding })
    return resolved.ok && onChangedLine(changes, finding, resolved.anchor)
  }

  test("an anchor on added code, next to a deletion or on removed code counts; context and a snapped line do not", () => {
    expect(at({ line: 2 })).toBe(true)
    expect(at({ line: 3 })).toBe(true)
    expect(at({ line: 2, endLine: 4 })).toBe(true)
    // Line 1 sits next to the deletion.
    expect(at({ line: 1 })).toBe(true)
    expect(at({ line: 2, side: "LEFT" })).toBe(true)
    expect(at({ line: 4 })).toBe(false)
    expect(at({ line: 5 })).toBe(false)
    // Line 7 is outside the hunk; resolveAnchor snaps it onto line 3, which is not the model's own line.
    expect(resolveAnchor(index, { path: "a.ts", line: 7 })).toMatchObject({ ok: true, anchor: { line: 3 } })
    expect(at({ line: 7 })).toBe(false)
  })

  test("endLineOf reads only a whole number after the first line", () => {
    expect(endLineOf({ line: 3, endLine: 5 })).toBe(5)
    for (const endLine of [undefined, 3, 2, 4.5, Number.NaN]) expect(endLineOf({ line: 3, endLine })).toBeUndefined()
  })
})
