import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { parseUnifiedDiff, type DiffFile } from "@vectordevai/core/review/diff"
import { COVERAGE_COMMANDS } from "@vectordevai/core/review/permission"
import {
  applyRuntimeVerdict,
  changedLineCoverage,
  CHECKS_NOT_RUN,
  LCOV_LIMITS,
  MAX_UNCOVERED_LINES,
  parseLcov,
  RUNTIME_FAILURES,
  RUNTIME_LIMITS,
  RUNTIME_STOPS,
  RUNTIME_VERDICTS,
  runtimeVerdict,
  SIGNAL_EXIT,
  type LcovReport,
  type RuntimeEvidence,
  type RuntimeTie,
  type RuntimeVerdict,
} from "@vectordevai/core/review/runtime"
import type { Finding } from "@vectordevai/core/review/types"

// What `bun test --coverage --coverage-reporter=lcov` wrote with Bun 1.3.14 for a lib.ts its test imports (the test
// file itself is left out): paths relative to the directory the tests ran in, every executable line with its hits
// (0 included), and no branch records.
const BUN_PROBE = [
  "TN:",
  "SF:lib.ts",
  "FNF:2",
  "FNH:1",
  "DA:1,15",
  "DA:2,10",
  "DA:3,0",
  "DA:4,2",
  "DA:5,13",
  "DA:8,0",
  "DA:9,0",
  "LF:7",
  "LH:4",
  "end_of_record",
  "",
].join("\n")

// The same probe run from a sibling package (pkg-b) whose test imports pkg-a: Bun writes `../pkg-a/src/lib.ts`.
const BUN_SIBLING = [
  "TN:",
  "SF:../pkg-a/src/lib.ts",
  "FNF:2",
  "FNH:1",
  "DA:1,15",
  "DA:3,0",
  "LF:2",
  "LH:1",
  "end_of_record",
  "TN:",
  "SF:local.ts",
  "FNF:1",
  "FNH:1",
  "DA:1,12",
  "DA:2,12",
  "LF:2",
  "LH:2",
  "end_of_record",
  "",
].join("\n")

// Each file's lines as [line, hits] pairs, in the report's order.
function table(report: LcovReport) {
  return report.files.map((file) => [file.path, [...file.lines]])
}

function lcov(...records: [string, ...string[]][]) {
  return records.map(([file, ...lines]) => [`SF:${file}`, ...lines, "end_of_record"].join("\n")).join("\n") + "\n"
}

describe("parseLcov", () => {
  test("reads Bun's own report", () => {
    expect(parseLcov(BUN_PROBE)).toEqual({
      files: [
        {
          path: "lib.ts",
          lines: new Map([
            [1, 15],
            [2, 10],
            [3, 0],
            [4, 2],
            [5, 13],
            [8, 0],
            [9, 0],
          ]),
        },
      ],
      malformed: 0,
    })
  })

  test("joins Bun's relative paths onto the directory the tests ran in, in a monorepo", () => {
    expect(table(parseLcov(BUN_SIBLING, { cwd: "packages/pkg-b" }))).toEqual([
      [
        "packages/pkg-a/src/lib.ts",
        [
          [1, 15],
          [3, 0],
        ],
      ],
      [
        "packages/pkg-b/local.ts",
        [
          [1, 12],
          [2, 12],
        ],
      ],
    ])
    // From the repository root, the sibling path leaves the repository and is skipped, silently.
    expect(parseLcov(BUN_SIBLING)).toEqual({
      files: [
        {
          path: "local.ts",
          lines: new Map([
            [1, 12],
            [2, 12],
          ]),
        },
      ],
      malformed: 0,
    })
    // `cwd` may be written with ./, a trailing slash or backslashes, or absolute under `root`.
    for (const input of [
      { cwd: "./packages/pkg-b/" },
      { cwd: "packages\\pkg-b" },
      { cwd: "/work/repo/packages/pkg-b", root: "/work/repo" },
    ])
      expect(table(parseLcov(BUN_SIBLING, input)).map(([file]) => file)).toEqual([
        "packages/pkg-a/src/lib.ts",
        "packages/pkg-b/local.ts",
      ])
    // A path that climbs past the root from the package is outside the repository.
    expect(table(parseLcov(lcov(["../../../x.ts", "DA:1,1"]), { cwd: "packages/pkg-b" }))).toEqual([])
    expect(parseLcov(lcov(["../../x.ts", "DA:1,1"]), { cwd: "packages/pkg-b" }).files.map((file) => file.path)).toEqual(
      ["x.ts"],
    )
    // A `cwd` outside the repository, or absolute without a `root`, keeps no relative path; absolute ones still map.
    for (const cwd of ["../elsewhere", "/work/repo/packages/pkg-b", "/tmp"])
      expect(table(parseLcov(lcov(["src/a.ts", "DA:1,1"]), { cwd }))).toEqual([])
    expect(
      table(parseLcov(lcov(["/work/repo/src/a.ts", "DA:1,1"]), { cwd: "../elsewhere", root: "/work/repo" })),
    ).toEqual([["src/a.ts", [[1, 1]]]])
  })

  test("skips the other record types without counting them as malformed", () => {
    const text = [
      "VER:2",
      "TN:suite",
      "SF:src/a.ts",
      "FN:1,f",
      "FNL:0,1,3",
      "FNA:0,1,f",
      "FNDA:1,f",
      "FNF:1",
      "FNH:1",
      "BRDA:2,0,0,1",
      "BRDA:2,0,1,-",
      "BRF:2",
      "BRH:1",
      "DA:1,1",
      "DA:2,0,f2a1c3",
      "LF:2",
      "LH:1",
      "end_of_record",
    ].join("\n")
    expect(parseLcov(text)).toEqual({
      files: [
        {
          path: "src/a.ts",
          lines: new Map([
            [1, 1],
            [2, 0],
          ]),
        },
      ],
      malformed: 0,
    })
  })

  test("reads CRLF line endings and a report without a final line break", () => {
    expect(parseLcov(BUN_PROBE.replaceAll("\n", "\r\n"))).toEqual(parseLcov(BUN_PROBE))
    expect(parseLcov(BUN_PROBE.trimEnd())).toEqual(parseLcov(BUN_PROBE))
  })

  test("keeps records in first-seen order, merges a file listed twice by its highest hits, and keeps an open record", () => {
    const text = [
      "SF:src/a.ts",
      "DA:1,0",
      "DA:2,3",
      "end_of_record",
      "SF:src/b.ts",
      "DA:1,1",
      "end_of_record",
      "SF:src/a.ts",
      "DA:1,2",
      "DA:2,1",
      "DA:4,0",
      "end_of_record",
      // Unterminated at the end of the report.
      "SF:src/c.ts",
      "DA:7,5",
    ].join("\n")
    expect(parseLcov(text)).toEqual({
      files: [
        {
          path: "src/a.ts",
          lines: new Map([
            [1, 2],
            [2, 3],
            [4, 0],
          ]),
        },
        { path: "src/b.ts", lines: new Map([[1, 1]]) },
        { path: "src/c.ts", lines: new Map([[7, 5]]) },
      ],
      malformed: 0,
    })
  })

  test("an SF before the previous record's end_of_record closes that record and counts as malformed", () => {
    const text = ["SF:src/a.ts", "DA:1,1", "SF:src/b.ts", "DA:2,0", "end_of_record"].join("\n")
    expect(parseLcov(text)).toEqual({
      files: [
        { path: "src/a.ts", lines: new Map([[1, 1]]) },
        { path: "src/b.ts", lines: new Map([[2, 0]]) },
      ],
      malformed: 1,
    })
  })

  test("counts and skips each malformed line, and keeps the valid ones", () => {
    const bad = [
      "DA:abc,1",
      "DA:0,1",
      "DA:-1,1",
      "DA:3",
      "DA:1e3,1",
      "DA:4,-1",
      "DA:5,1.5",
      `DA:${LCOV_LIMITS.lineNumber + 1},1`,
      "DA: 6,1",
      "something else",
      "DAX:1,1",
    ]
    const text = ["DA:9,9", "SF:src/a.ts", "DA:1,1", ...bad, `DA:${LCOV_LIMITS.lineNumber},2`, "end_of_record"].join(
      "\n",
    )
    expect(parseLcov(text)).toEqual({
      files: [
        {
          path: "src/a.ts",
          lines: new Map([
            [1, 1],
            [LCOV_LIMITS.lineNumber, 2],
          ]),
        },
      ],
      // The DA line before any SF, and each bad line.
      malformed: 1 + bad.length,
    })
    // A DA line after end_of_record is outside a record too.
    expect(parseLcov("SF:src/a.ts\nend_of_record\nDA:1,1\n")).toEqual({
      files: [{ path: "src/a.ts", lines: new Map() }],
      malformed: 1,
    })
  })

  test("an empty SF opens no record, and a line over lineChars is malformed without stopping the scan", () => {
    expect(parseLcov("SF:\nDA:1,1\nend_of_record\nSF:src/a.ts\nDA:2,2\nend_of_record\n")).toEqual({
      files: [{ path: "src/a.ts", lines: new Map([[2, 2]]) }],
      malformed: 2,
    })
    const long = `SF:src/${"a".repeat(LCOV_LIMITS.lineChars)}.ts`
    expect(parseLcov(`${long}\nDA:1,1\nend_of_record\nSF:src/b.ts\nDA:3,1\nend_of_record\n`)).toEqual({
      files: [{ path: "src/b.ts", lines: new Map([[3, 1]]) }],
      // The long line, and its DA line, which has no open record.
      malformed: 2,
    })
    // An over-cap SF still closes an unterminated record, so its DA lines never land in the previous file, whose
    // changed line 7 would otherwise read as covered when hits merge.
    const unterminated = ["SF:src/a.ts", "DA:1,1", long, "DA:7,5", "DA:8,0", "end_of_record", "SF:src/b.ts", "DA:3,1"]
    const own = {
      files: [
        { path: "src/a.ts", lines: new Map([[1, 1]]) },
        { path: "src/b.ts", lines: new Map([[3, 1]]) },
      ],
      // The long line, the record it closed, and its two DA lines, which have no open record.
      malformed: 4,
    }
    expect(parseLcov(unterminated.join("\n"))).toEqual(own)
    expect(parseLcov(`${unterminated.join("\r\n")}\r\n`)).toEqual(own)
    expect(parseLcov(unterminated.join("\n"), { paths: new Set(["src/a.ts"]) })).toEqual({
      files: [own.files[0]],
      malformed: 4,
    })
    expect(parseLcov(["SF:src/a.ts", "DA:7,0", "end_of_record", ...unterminated].join("\n")).files[0]).toEqual({
      path: "src/a.ts",
      lines: new Map([
        [7, 0],
        [1, 1],
      ]),
    })
    // A long line that is not an SF leaves the record open.
    expect(parseLcov(["SF:src/a.ts", `FN:1,${"f".repeat(LCOV_LIMITS.lineChars)}`, "DA:2,1"].join("\n"))).toEqual({
      files: [{ path: "src/a.ts", lines: new Map([[2, 1]]) }],
      malformed: 1,
    })
    // A line exactly at the cap is read.
    const atCap = `SF:${"a".repeat(LCOV_LIMITS.lineChars - 6)}.ts`
    expect(atCap).toHaveLength(LCOV_LIMITS.lineChars)
    expect(parseLcov(`${atCap}\nDA:1,1\n`).files).toHaveLength(1)
  })

  test("normalises paths, maps absolute ones under the root, and skips any outside the repository", () => {
    const text = lcov(
      ["./src/a.ts", "DA:1,1"],
      ["/work/repo/src/b.ts", "DA:1,1"],
      ["src//c/./d.ts", "DA:1,1"],
      ["src/x/../e.ts", "DA:1,1"],
      ["/etc/passwd", "DA:1,1"],
      ["/work/repository/f.ts", "DA:1,1"],
      ["../outside.ts", "DA:1,1"],
      ["/work/repo/../repo2/g.ts", "DA:1,1"],
      ["/work/repo", "DA:1,1"],
      ["__proto__", "DA:1,1"],
    )
    const paths = (report: LcovReport) => report.files.map((file) => file.path)
    const rooted = parseLcov(text, { root: "/work/repo/" })
    expect(paths(rooted)).toEqual(["src/a.ts", "src/b.ts", "src/c/d.ts", "src/e.ts", "__proto__"])
    expect(rooted.malformed).toBe(0)
    // A file named __proto__ is a file like any other, and nothing else gains a property.
    expect(rooted.files.find((file) => file.path === "__proto__")?.lines).toEqual(new Map([[1, 1]]))
    expect(Object.hasOwn(Object.prototype, "lines")).toBe(false)
    // Without a root, absolute paths are outside.
    expect(paths(parseLcov(text))).toEqual(["src/a.ts", "src/c/d.ts", "src/e.ts", "__proto__"])
    // Windows paths, with a backslash root.
    const windows = lcov(
      ["C:\\work\\repo\\src\\w.ts", "DA:1,1"],
      ["src\\v.ts", "DA:1,1"],
      ["D:\\other\\x.ts", "DA:1,1"],
    )
    expect(paths(parseLcov(windows, { root: "C:\\work\\repo" }))).toEqual(["src/w.ts", "src/v.ts"])
    // The filesystem root as the repository.
    expect(paths(parseLcov(lcov(["/src/a.ts", "DA:1,1"]), { root: "/" }))).toEqual(["src/a.ts"])
  })

  test("keeps only the wanted paths when given", () => {
    const text = lcov(["src/a.ts", "DA:1,1"], ["src/b.ts", "DA:1,0", "DA:x"], ["./src/c.ts", "DA:2,1"])
    expect(parseLcov(text, { paths: new Set(["src/c.ts", "src/missing.ts"]) })).toEqual({
      files: [{ path: "src/c.ts", lines: new Map([[2, 1]]) }],
      // A malformed line still counts in a skipped record.
      malformed: 1,
    })
    expect(parseLcov(text, { paths: new Set() }).files).toEqual([])
  })
})

describe("parseLcov on huge input", () => {
  test("refuses text over the character cap without reading it", () => {
    expect(parseLcov("x".repeat(LCOV_LIMITS.chars + 1))).toEqual({ files: [], malformed: 0, tooLarge: true })
    expect(parseLcov(`SF:a.ts\nDA:1,1\n${" ".repeat(LCOV_LIMITS.chars)}`).tooLarge).toBe(true)
  })

  test("refuses the whole report over the file or line cap, and a paths filter keeps it under", () => {
    const many = Array.from({ length: LCOV_LIMITS.files + 1 }, (_, index) => `SF:f${index}.ts\nDA:1,1\nend_of_record`)
    const files = `${many.join("\n")}\nSF:wanted.ts\nDA:2,1\nend_of_record\n`
    expect(parseLcov(files)).toEqual({ files: [], malformed: 0, tooLarge: true })
    expect(parseLcov(files, { paths: new Set(["wanted.ts", "f3.ts"]) })).toEqual({
      files: [
        { path: "f3.ts", lines: new Map([[1, 1]]) },
        { path: "wanted.ts", lines: new Map([[2, 1]]) },
      ],
      malformed: 0,
    })
    const big = Array.from({ length: LCOV_LIMITS.lines + 1 }, (_, index) => `DA:${index + 1},1`)
    const lines = `SF:big.ts\n${big.join("\n")}\nend_of_record\nSF:small.ts\nDA:1,1\nend_of_record\n`
    expect(parseLcov(lines)).toEqual({ files: [], malformed: 0, tooLarge: true })
    expect(parseLcov(lines, { paths: new Set(["small.ts"]) })).toEqual({
      files: [{ path: "small.ts", lines: new Map([[1, 1]]) }],
      malformed: 0,
    })
    // Exactly at the line cap, across files, is read: the cap counts distinct lines kept.
    const atCap = `SF:big.ts\n${big.slice(0, -1).join("\n")}\n${big.slice(0, 10).join("\n")}\nend_of_record\n`
    expect(parseLcov(atCap).files[0].lines.size).toBe(LCOV_LIMITS.lines)
  })

  test("one multi-megabyte line is malformed and the rest is read", () => {
    const text = `SF:src/a.ts\nDA:1,1\n${"DA:".padEnd(4 * 1024 * 1024, "9")}\nDA:2,0\nend_of_record\n`
    expect(parseLcov(text)).toEqual({
      files: [
        {
          path: "src/a.ts",
          lines: new Map([
            [1, 1],
            [2, 0],
          ]),
        },
      ],
      malformed: 1,
    })
  })
})

// A changed file whose hunk adds `added` (new line numbers), with a context and a deleted line beside them.
function changed(file: string, added: number[], overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: file,
    status: "modified",
    binary: false,
    additions: added.length,
    deletions: 1,
    patch: "",
    hunks: [
      {
        header: "@@ -1,1 +1,1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: "context", oldLine: 1, newLine: 100, text: "kept" },
          { kind: "del", oldLine: 2, text: "gone" },
          ...added.map((line) => ({ kind: "add" as const, newLine: line, text: "new" })),
        ],
      },
    ],
    ...overrides,
  }
}

describe("changedLineCoverage", () => {
  test("maps a report to the added lines it lists, covered or not, and leaves non-executable lines out", () => {
    const report = lcov(
      ["src/mod.ts", "DA:1,1", "DA:2,0", "DA:3,4", "DA:5,1", "DA:100,0"],
      ["src/new.ts", "DA:1,2", "DA:2,1", "DA:3,1"],
    )
    expect(
      changedLineCoverage(report, [
        changed("src/mod.ts", [3, 1, 2, 6, 7]),
        changed("src/new.ts", [1, 2, 3], { status: "added" }),
        changed("src/absent.ts", [1]),
      ]),
    ).toEqual([
      // Lines 6 and 7 are not executable; line 5 and the context line 100 are not added.
      { path: "src/mod.ts", changed: 3, covered: 2, uncovered: [2] },
      { path: "src/new.ts", changed: 3, covered: 3, uncovered: [] },
      { path: "src/absent.ts", changed: 0, covered: 0, uncovered: [], unmeasured: true },
    ])
  })

  test("a measured file whose added lines the report does not list is measured, not unmeasured", () => {
    expect(changedLineCoverage(lcov(["src/types.ts", "DA:9,1"]), [changed("src/types.ts", [1, 2])])).toEqual([
      { path: "src/types.ts", changed: 0, covered: 0, uncovered: [] },
    ])
  })

  test("maps only code files outside the test paths that are not deleted or binary and add a line", () => {
    const report = lcov(
      ...[
        "src/gone.ts",
        "src/gone-with-adds.ts",
        "src/image.ts",
        "README.md",
        "src/a.test.ts",
        "test/helper.ts",
        "src/only-deletes.ts",
      ].map((file): [string, string] => [file, "DA:1,1"]),
    )
    expect(
      changedLineCoverage(report, [
        changed("src/gone.ts", [], { status: "deleted" }),
        // A deleted file is never mapped, even one whose hunks claim added lines.
        changed("src/gone-with-adds.ts", [1], { status: "deleted" }),
        changed("src/image.ts", [1], { binary: true }),
        changed("README.md", [1]),
        changed("src/a.test.ts", [1]),
        changed("test/helper.ts", [1]),
        changed("src/only-deletes.ts", []),
      ]),
    ).toEqual([])
  })

  test("a rename is mapped by its head path, from a real diff", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/old.ts b/src/renamed.ts",
        "similarity index 80%",
        "rename from src/old.ts",
        "rename to src/renamed.ts",
        "--- a/src/old.ts",
        "+++ b/src/renamed.ts",
        "@@ -1,2 +1,3 @@",
        " export function f() {",
        "+  check()",
        "   return 1",
        "",
      ].join("\n"),
    )
    expect(files[0]).toMatchObject({ path: "src/renamed.ts", oldPath: "src/old.ts", status: "renamed" })
    expect(changedLineCoverage(lcov(["src/renamed.ts", "DA:2,0"]), files)).toEqual([
      { path: "src/renamed.ts", changed: 1, covered: 0, uncovered: [2] },
    ])
    expect(changedLineCoverage(lcov(["src/old.ts", "DA:2,1"]), files)).toEqual([
      { path: "src/renamed.ts", changed: 0, covered: 0, uncovered: [], unmeasured: true },
    ])
  })

  test("passes the directory the tests ran in and the repository root through", () => {
    const files = [changed("packages/core/src/x.ts", [1, 2]), changed("packages/app/src/y.ts", [4])]
    expect(
      changedLineCoverage(lcov(["src/x.ts", "DA:1,1", "DA:2,0"], ["../app/src/y.ts", "DA:4,3"]), files, {
        cwd: "packages/core",
      }),
    ).toEqual([
      { path: "packages/core/src/x.ts", changed: 2, covered: 1, uncovered: [2] },
      { path: "packages/app/src/y.ts", changed: 1, covered: 1, uncovered: [] },
    ])
    expect(
      changedLineCoverage(lcov(["/work/repo/packages/app/src/y.ts", "DA:4,0"]), files, { root: "/work/repo" }),
    ).toEqual([
      { path: "packages/core/src/x.ts", changed: 0, covered: 0, uncovered: [], unmeasured: true },
      { path: "packages/app/src/y.ts", changed: 1, covered: 0, uncovered: [4] },
    ])
  })

  test("caps the uncovered list and keeps the counts exact", () => {
    const added = Array.from({ length: 250 }, (_, index) => 250 - index)
    const report = lcov(["src/big.ts", ...added.map((line) => `DA:${line},${line === 7 ? 1 : 0}`)])
    const [file] = changedLineCoverage(report, [changed("src/big.ts", added)]) ?? []
    expect(file.changed).toBe(250)
    expect(file.covered).toBe(1)
    expect(file.uncovered).toHaveLength(MAX_UNCOVERED_LINES)
    expect(file.uncovered.slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 8, 9])
    expect(file.uncovered.at(-1)).toBe(201)
  })

  test("a report too large to read gives no coverage at all, and unrelated files never make it too large", () => {
    expect(changedLineCoverage("x".repeat(LCOV_LIMITS.chars + 1), [changed("src/a.ts", [1])])).toBeUndefined()
    const many = Array.from({ length: LCOV_LIMITS.files + 1 }, (_, index) => `SF:f${index}.ts\nDA:1,1\nend_of_record`)
    expect(changedLineCoverage(`${many.join("\n")}\nSF:src/a.ts\nDA:1,0\n`, [changed("src/a.ts", [1])])).toEqual([
      { path: "src/a.ts", changed: 1, covered: 0, uncovered: [1] },
    ])
  })
})

const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)
const COMMITS = { head: HEAD, base: BASE }
const FINDING = "f00000000001"
const REPRO = "bun test test/vectorscope-repro/race.test.ts"
const TIED: RuntimeTie = { finding: FINDING, assertion: "tied" }

function run(side: RuntimeEvidence["side"], overrides: Partial<RuntimeEvidence> = {}): RuntimeEvidence {
  return {
    command: REPRO,
    side,
    commit: side === "head" ? HEAD : BASE,
    exit: 0,
    ms: 100,
    runs: RUNTIME_LIMITS.runs,
    reproducerFor: FINDING,
    ...overrides,
  }
}

// Two runs each. A stopped run is otherwise a head failure at an assertion or a base pass, so only its stop keeps it
// from deciding.
const OUTCOME_NAMES = ["fails", "passes", "flaky", "stopped"] as const
type Outcome = (typeof OUTCOME_NAMES)[number]
const OUTCOMES: Record<Outcome, (side: RuntimeEvidence["side"]) => RuntimeEvidence[]> = {
  fails: (side: RuntimeEvidence["side"]) => [run(side, { exit: 1, failure: "assertion" })],
  passes: (side: RuntimeEvidence["side"]) => [run(side)],
  flaky: (side: RuntimeEvidence["side"]) => [
    run(side, { exit: 1, failure: "assertion", runs: 1 }),
    run(side, { runs: 1 }),
  ],
  stopped: (side: RuntimeEvidence["side"]) => [
    run(side, side === "head" ? { exit: 1, failure: "assertion", stopped: "timeout" } : { stopped: "output-limit" }),
  ],
}

// Head (rows) by base (columns), with a tied assertion: only failing on head and passing on base confirms, and a
// reproducer that passes on head contradicts whatever base did, unless base was stopped.
const TRUTH_TABLE: Record<Outcome, Record<Outcome, RuntimeVerdict>> = {
  fails: { fails: "inconclusive", passes: "confirmed", flaky: "inconclusive", stopped: "inconclusive" },
  passes: { fails: "contradicted", passes: "contradicted", flaky: "contradicted", stopped: "inconclusive" },
  flaky: { fails: "inconclusive", passes: "inconclusive", flaky: "inconclusive", stopped: "inconclusive" },
  stopped: { fails: "inconclusive", passes: "inconclusive", flaky: "inconclusive", stopped: "inconclusive" },
}

function verdict(head: RuntimeEvidence[], base: RuntimeEvidence[], tie = TIED, commits = COMMITS) {
  return runtimeVerdict(head, base, tie, commits).verdict
}

describe("runtimeVerdict", () => {
  test("the full truth table, for a tied assertion", () => {
    const grid = Object.fromEntries(
      OUTCOME_NAMES.map((head) => [
        head,
        Object.fromEntries(
          OUTCOME_NAMES.map((base) => [base, verdict(OUTCOMES[head]("head"), OUTCOMES[base]("base"))]),
        ),
      ]),
    )
    expect(grid).toEqual(TRUTH_TABLE)
  })

  test("an untied or unchecked assertion decides nothing, in every cell", () => {
    for (const assertion of ["untied", "unchecked"] as const)
      for (const head of OUTCOME_NAMES)
        for (const base of OUTCOME_NAMES)
          expect([
            assertion,
            head,
            base,
            verdict(OUTCOMES[head]("head"), OUTCOMES[base]("base"), { ...TIED, assertion }),
          ]).toEqual([assertion, head, base, "inconclusive"])
  })

  // A reproducer that fails on head and passes on base also "confirms" a behaviour the change means to introduce
  // (contract §4 VS-30 item 4), so the same runs confirm only when the assertion is tied to the finding.
  test("the intended-behaviour-change case: head fails and base passes, but the assertion is not the finding's", () => {
    const head = OUTCOMES.fails("head")
    const base = OUTCOMES.passes("base")
    expect(verdict(head, base, { finding: FINDING, assertion: "untied" })).toBe("inconclusive")
    expect(verdict(head, base, { finding: FINDING, assertion: "unchecked" })).toBe("inconclusive")
    expect(verdict(head, base)).toBe("confirmed")
  })

  test("flaky runs never confirm, in either encoding", () => {
    const base = OUTCOMES.passes("base")
    // Run-length: two failures and a pass on head.
    expect(verdict([run("head", { exit: 1, failure: "assertion" }), run("head", { runs: 1 })], base)).toBe(
      "inconclusive",
    )
    // One record per run.
    expect(verdict(OUTCOMES.flaky("head"), base)).toBe("inconclusive")
    // A failure at an assertion beside an error.
    expect(
      verdict(
        [run("head", { exit: 1, failure: "assertion", runs: 1 }), run("head", { exit: 1, failure: "error", runs: 1 })],
        base,
      ),
    ).toBe("inconclusive")
    // Two reproducer files for one finding, one failing and one passing on head.
    const other = "bun test test/vectorscope-repro/race-2.test.ts"
    expect(
      verdict(
        [run("head", { exit: 1, failure: "assertion" }), run("head", { command: other })],
        [run("base"), run("base", { command: other })],
      ),
    ).toBe("inconclusive")
    // A flaky base under a failing head.
    expect(
      verdict(OUTCOMES.fails("head"), [
        run("base", { runs: 1 }),
        run("base", { exit: 2, failure: "assertion", runs: 1 }),
      ]),
    ).toBe("inconclusive")
  })

  test("an outcome recorded twice is refused, so one run cannot count in two forms", () => {
    const base = OUTCOMES.passes("base")
    const once = run("head", { exit: 1, failure: "assertion", runs: 1 })
    expect(verdict([once, once], base)).toBe("inconclusive")
    expect(verdict([run("head", { exit: 1, failure: "assertion" }), once], base)).toBe("inconclusive")
    expect(verdict(OUTCOMES.fails("head"), [run("base", { runs: 1 }), run("base", { runs: 1 })])).toBe("inconclusive")
    // Every reproducer of a finding confirming, each recorded once, confirms.
    const other = "bun test test/vectorscope-repro/race-2.test.ts"
    expect(
      verdict(
        [
          run("head", { exit: 1, failure: "assertion" }),
          run("head", { command: other, exit: 1, failure: "assertion" }),
        ],
        [run("base"), run("base", { command: other })],
      ),
    ).toBe("confirmed")
  })

  test("a failure that is not at an assertion, or not located, never confirms", () => {
    const base = OUTCOMES.passes("base")
    // An import of a symbol the change renamed fails on head and passes on base: an error, not the finding.
    expect(verdict([run("head", { exit: 1, failure: "error" })], base)).toBe("inconclusive")
    expect(verdict([run("head", { exit: 1 })], base)).toBe("inconclusive")
    // A location on a passing run is not the executor's.
    expect(verdict(OUTCOMES.fails("head"), [run("base", { failure: "assertion" })])).toBe("inconclusive")
    // Any ordinary failing status confirms when located at the assertion.
    for (const exit of [1, 2, 101, SIGNAL_EXIT - 1])
      expect([exit, verdict([run("head", { exit, failure: "assertion" })], base)]).toEqual([exit, "confirmed"])
  })

  test("a signal or out-of-range status decides nothing, on either side", () => {
    const base = OUTCOMES.passes("base")
    for (const exit of [SIGNAL_EXIT, 137, 139, 143, 255, 3_221_225_477]) {
      expect([exit, verdict([run("head", { exit, failure: "assertion" })], base)]).toEqual([exit, "inconclusive"])
      expect([exit, verdict([run("head", { exit })], base)]).toEqual([exit, "inconclusive"])
      expect([exit, verdict(OUTCOMES.fails("head"), [run("base", { exit })])]).toEqual([exit, "inconclusive"])
      expect([exit, verdict(OUTCOMES.passes("head"), [run("base", { exit })])]).toEqual([exit, "inconclusive"])
    }
  })

  test("needs every command at least RUNTIME_LIMITS.runs times on both sides, and the same commands", () => {
    const fails = run("head", { exit: 1, failure: "assertion" })
    expect(RUNTIME_LIMITS.runs).toBe(2)
    expect(verdict([{ ...fails, runs: 1 }], OUTCOMES.passes("base"))).toBe("inconclusive")
    expect(verdict([fails], [run("base", { runs: 1 })])).toBe("inconclusive")
    expect(verdict([{ ...fails, runs: 3 }], [run("base", { runs: 5 })])).toBe("confirmed")
    expect(verdict(OUTCOMES.passes("head"), [run("base", { runs: 1 })])).toBe("inconclusive")
    // A command on one side only, or another command on each side.
    const other = "bun test test/vectorscope-repro/race-2.test.ts"
    expect(verdict([fails, { ...fails, command: other }], OUTCOMES.passes("base"))).toBe("inconclusive")
    expect(verdict([fails], [run("base"), run("base", { command: other })])).toBe("inconclusive")
    expect(verdict([{ ...fails, command: other }], OUTCOMES.passes("base"))).toBe("inconclusive")
  })

  test("refuses records of another side, another commit, or with counts and statuses that are not whole", () => {
    const fails = OUTCOMES.fails("head")
    const passes = OUTCOMES.passes("base")
    // A base record among the head runs, and the other way round.
    expect(verdict([...fails, run("base", { command: "x" })], passes)).toBe("inconclusive")
    expect(verdict([{ ...fails[0], side: "base" }], passes)).toBe("inconclusive")
    expect(verdict(fails, [{ ...passes[0], side: "head" }])).toBe("inconclusive")
    // A stale record from an earlier head, or runs on another base.
    expect(verdict([{ ...fails[0], commit: "c".repeat(40) }], passes)).toBe("inconclusive")
    expect(verdict(fails, [{ ...passes[0], commit: "c".repeat(40) }])).toBe("inconclusive")
    expect(verdict(fails, passes, TIED, { head: BASE, base: BASE })).toBe("inconclusive")
    expect(verdict(fails, passes, TIED, { head: HEAD, base: HEAD })).toBe("inconclusive")
    // No commit expected matches no record, even one without a commit.
    expect(verdict([{ ...fails[0], commit: "" }], [{ ...passes[0], commit: "" }], TIED, { head: "", base: "" })).toBe(
      "inconclusive",
    )
    for (const runs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect([runs, verdict([{ ...fails[0], runs }], passes)]).toEqual([runs, "inconclusive"])
    for (const exit of [-1, 1.5, Number.NaN])
      expect([exit, verdict([{ ...fails[0], exit }], passes)]).toEqual([exit, "inconclusive"])
    expect(verdict(fails, [{ ...passes[0], exit: Number.NaN }])).toBe("inconclusive")
  })

  test("only this finding's reproducer runs decide; suites, coverage runs and other findings never do", () => {
    const fails = OUTCOMES.fails("head")
    const passes = OUTCOMES.passes("base")
    // Another finding's confirming runs.
    expect(
      verdict(
        fails.map((item) => ({ ...item, reproducerFor: "f00000000002" })),
        passes,
      ),
    ).toBe("inconclusive")
    expect(verdict(fails, passes, { ...TIED, finding: "f00000000002" })).toBe("inconclusive")
    // The project's own suite failing on head and passing on base.
    const suite = { reproducerFor: undefined, command: "bun test" }
    expect(verdict([{ ...fails[0], ...suite }], [{ ...passes[0], ...suite }])).toBe("inconclusive")
    // A coverage run, even one marked with the finding, and even beside a confirmation: its status is no pass or fail.
    const coverage = { command: COVERAGE_COMMANDS.bun.command }
    expect(verdict([{ ...fails[0], ...coverage }], [{ ...passes[0], ...coverage }])).toBe("inconclusive")
    // Also with the path or test name the executor may add to it.
    for (const command of [`${coverage.command} ${REPRO.split(" ").at(-1)}`, `${coverage.command} -t race`])
      expect([command, verdict([{ ...fails[0], command }], [{ ...passes[0], command }])]).toEqual([
        command,
        "inconclusive",
      ])
    expect(verdict([...fails, run("head", { ...coverage })], [...passes, run("base", { ...coverage, exit: 1 })])).toBe(
      "confirmed",
    )
    expect(verdict([...fails, run("head", { ...coverage, reproducerFor: undefined, exit: 1 })], passes)).toBe(
      "confirmed",
    )
    // Records of other findings and suites beside this finding's change nothing.
    const noise = [run("head", { reproducerFor: "f00000000002" }), run("head", { ...suite, exit: 1 })]
    expect(verdict([...noise, ...fails], [...passes, run("base", { reproducerFor: "f00000000002", exit: 1 })])).toBe(
      "confirmed",
    )
    // An empty finding id names no reproducer.
    expect(
      verdict(
        fails.map((item) => ({ ...item, reproducerFor: "" })),
        passes.map((item) => ({ ...item, reproducerFor: "" })),
        { ...TIED, finding: "" },
      ),
    ).toBe("inconclusive")
  })

  test("with no runs on a side there is no verdict, and the result names the finding it is for", () => {
    expect(verdict([], [])).toBe("inconclusive")
    expect(verdict(OUTCOMES.fails("head"), [])).toBe("inconclusive")
    expect(verdict([], OUTCOMES.passes("base"))).toBe("inconclusive")
    expect(runtimeVerdict(OUTCOMES.fails("head"), OUTCOMES.passes("base"), TIED, COMMITS)).toEqual({
      finding: FINDING,
      verdict: "confirmed",
    })
  })
})

const FOUND: Finding = {
  id: FINDING,
  path: "src/race.ts",
  line: 3,
  side: "RIGHT",
  source: "review",
  severity: "blocking",
  category: "bug",
  title: "Two writers race",
  body: "Example.",
  confidence: 0.9,
}

describe("applyRuntimeVerdict", () => {
  test("a confirmation for this finding verifies it at runtime, whether or not the model had", () => {
    for (const finding of [
      FOUND,
      { ...FOUND, verified: false },
      { ...FOUND, verified: true, verifiedBy: "model" as const },
    ]) {
      const applied = applyRuntimeVerdict(finding, { finding: FINDING, verdict: "confirmed" })
      expect(applied).toEqual({ ...finding, verified: true, verifiedBy: "runtime" })
      expect(applied).not.toBe(finding)
    }
    expect(FOUND.verified).toBeUndefined()
  })

  test("contradicted, inconclusive and another finding's confirmation change nothing", () => {
    for (const finding of [FOUND, { ...FOUND, verified: true, verifiedBy: "model" as const }])
      for (const result of [
        { finding: FINDING, verdict: "contradicted" as const },
        { finding: FINDING, verdict: "inconclusive" as const },
        { finding: "f00000000002", verdict: "confirmed" as const },
      ]) {
        const applied = applyRuntimeVerdict(finding, result)
        expect(applied).toBe(finding)
        expect([applied.severity, applied.verified, applied.verifiedBy]).toEqual([
          finding.severity,
          finding.verified,
          finding.verifiedBy,
        ])
      }
  })

  test("applies runtimeVerdict's result end to end", () => {
    const confirmed = runtimeVerdict(OUTCOMES.fails("head"), OUTCOMES.passes("base"), TIED, COMMITS)
    expect(applyRuntimeVerdict(FOUND, confirmed).verifiedBy).toBe("runtime")
    expect(applyRuntimeVerdict({ ...FOUND, id: "f00000000002" }, confirmed).verified).toBeUndefined()
    const contradicted = runtimeVerdict(OUTCOMES.passes("head"), OUTCOMES.passes("base"), TIED, COMMITS)
    expect(contradicted.verdict).toBe("contradicted")
    const verified = { ...FOUND, verified: true, verifiedBy: "model" as const }
    expect(applyRuntimeVerdict(verified, contradicted)).toBe(verified)
  })
})

describe("the runtime contract's constants", () => {
  test("lists the verdicts, stops, failure locations and limits", () => {
    expect(RUNTIME_VERDICTS).toEqual(["confirmed", "inconclusive", "contradicted"])
    expect(RUNTIME_STOPS).toEqual(["timeout", "output-limit"])
    expect(RUNTIME_FAILURES).toEqual(["assertion", "error"])
    expect(RUNTIME_LIMITS).toEqual({ commandMs: 120_000, outputBytes: 81_920, reproducers: 3, runs: 2 })
    expect(SIGNAL_EXIT).toBe(128)
    expect(MAX_UNCOVERED_LINES).toBe(200)
    expect(LCOV_LIMITS).toEqual({
      chars: 33_554_432,
      files: 20_000,
      lines: 1_000_000,
      lineChars: 4_096,
      lineNumber: 10_000_000,
    })
    for (const value of [
      RUNTIME_VERDICTS,
      RUNTIME_STOPS,
      RUNTIME_FAILURES,
      RUNTIME_LIMITS,
      LCOV_LIMITS,
      CHECKS_NOT_RUN,
    ])
      expect(Object.isFrozen(value)).toBe(true)
  })

  test("names every reason checks may not run, so the executor never invents one", () => {
    expect(CHECKS_NOT_RUN).toEqual([
      "no-consent",
      "pr",
      "fork",
      "untrusted",
      "ci",
      "surface-unsupported",
      "uncommitted",
      "network-unfiltered",
      "isolation-unavailable",
      "base-unavailable",
      "no-command",
      "dependencies-unavailable",
      "services-unavailable",
      "config-unavailable",
      "fixtures-unavailable",
      "no-reproducer",
      "route-refused",
      "reproducer-refused",
      "timeout",
      "output-limit",
      "budget",
      "head-moved",
    ])
    const reasons: readonly string[] = CHECKS_NOT_RUN
    // I-6 and contract §4 VS-30: refusals, isolation and network, dependencies, timeouts and a moving head; addendum
    // A §3 VS-30's blockers (services, configuration, fixtures); and the cases the executor will meet that the brief
    // left out (uncommitted changes, a missing base, the reproducer pass, the output cap, the budget, a surface
    // without an executor).
    for (const reason of [
      "no-consent",
      "pr",
      "untrusted",
      "ci",
      "network-unfiltered",
      "isolation-unavailable",
      "dependencies-unavailable",
      "timeout",
      "head-moved",
      "services-unavailable",
      "config-unavailable",
      "fixtures-unavailable",
      "uncommitted",
      "base-unavailable",
      "no-reproducer",
      "route-refused",
      "reproducer-refused",
      "output-limit",
      "budget",
      "surface-unsupported",
    ])
      expect(reasons).toContain(reason)
    expect(new Set(reasons).size).toBe(reasons.length)
    // Every stop the executor records is also a reason.
    for (const stop of RUNTIME_STOPS) expect(reasons).toContain(stop)
  })

  // The desktop renderer may reach this file through core, and the engine runs under Node in the desktop sidecar.
  test("runtime.ts imports no Node or Bun module", () => {
    const text = readFileSync(path.join(import.meta.dir, "..", "..", "src", "review", "runtime.ts"), "utf8")
    const sources = [...text.matchAll(/^import\b[^"]*"([^"]+)"/gm)].map((match) => match[1])
    expect(sources).toEqual(["minimatch", "./diff", "./ignore", "./permission", "./trivial", "./types"])
  })
})
