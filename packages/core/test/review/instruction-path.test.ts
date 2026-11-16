import { describe, expect, test } from "bun:test"
import { instructionPathExcluded } from "@vectordevai/core/review/config"
import {
  countInstructionPaths,
  instructionInventoryPath,
  INSTRUCTION_PATH_SEGMENTS,
  MAX_INSTRUCTION_COUNT_FILES,
} from "@vectordevai/core/review/instruction-path"

describe("the uncalled candidate instruction directory list", () => {
  test("keeps a fixed list covering test, sample, generated and dependency directories", () => {
    expect(INSTRUCTION_PATH_SEGMENTS).toEqual([
      "test",
      "tests",
      "__tests__",
      "testdata",
      "fixture",
      "fixtures",
      "__fixtures__",
      "golden",
      "goldens",
      "corpus",
      "corpora",
      "snapshot",
      "snapshots",
      "__snapshots__",
      "example",
      "examples",
      "sample",
      "samples",
      "demo",
      "demos",
      "generated",
      "__generated__",
      "vendor",
      "vendors",
      "node_modules",
      "third_party",
      "third-party",
      "thirdparty",
      "site-packages",
      "deps",
      "contrib",
    ])
    expect(Object.isFrozen(INSTRUCTION_PATH_SEGMENTS)).toBe(true)
  })

  test("matches complete directory segments case-insensitively at every depth, including nested vendor", () => {
    for (const segment of INSTRUCTION_PATH_SEGMENTS) {
      expect(instructionPathExcluded(`${segment}/AGENTS.md`)).toBe(true)
      expect(instructionPathExcluded(`src/pkg/${segment.toUpperCase()}/CLAUDE.md`)).toBe(true)
      expect(instructionPathExcluded(`src\\${segment}\\rules.instructions.md`)).toBe(true)
      expect(instructionPathExcluded(`src/${segment}`)).toBe(false)
      expect(instructionPathExcluded(`src/${segment}.md`)).toBe(false)
    }
    for (const path of [
      "AGENTS.md",
      "src/AGENTS.md",
      "myvendor/AGENTS.md",
      "examples-old/CLAUDE.md",
      "testimony/AGENTS.md",
      "regenerated/AGENTS.md",
    ])
      expect(instructionPathExcluded(path)).toBe(false)
  })
})

describe("bounded metadata-only nested instruction counts", () => {
  test("counts each file once per matched segment and preserves explicit ownership instead of guessing from names", () => {
    const result = countInstructionPaths([
      { path: "AGENTS.md" },
      { path: "CLAUDE.md" },
      { path: "root.instructions.md" },
      { path: "src/agents.md" },
      { path: "src/.vector/RULES.md" },
      { path: "src/AGENTS.md" },
      { path: "tests/AGENTS.md", origin: "project" },
      { path: "examples/CLAUDE.md", origin: "project" },
      { path: "vendor/tests/AGENTS.md", origin: "vendored" },
      { path: "vendor/vendor/CLAUDE.md", origin: "vendored" },
      { path: "deps/demo/security.instructions.md" },
      { path: "node_modules/a/AGENTS.md" },
      { path: "fixtures/probe.ts", origin: "project" },
    ])
    expect(result.complete).toBe(true)
    if (!result.complete) throw new Error("The valid inventory did not count")
    expect(result).toMatchObject({ scannedFiles: 13, nestedFiles: 7, excludedFiles: 6 })
    const segment = (name: string) => result.segments.find((entry) => entry.segment === name)
    expect(segment("tests")).toEqual({
      segment: "tests",
      category: "test",
      files: 2,
      project: 1,
      vendored: 1,
      unknown: 0,
    })
    expect(segment("examples")).toMatchObject({ files: 1, project: 1, vendored: 0, unknown: 0 })
    expect(segment("vendor")).toMatchObject({ files: 2, project: 0, vendored: 2, unknown: 0 })
    expect(segment("deps")).toMatchObject({ files: 1, project: 0, vendored: 0, unknown: 1 })
    expect(segment("fixtures")).toMatchObject({ files: 0 })
    for (const count of result.segments) expect(count.project + count.vendored + count.unknown).toBe(count.files)
  })

  test("uses repository-relative paths and refuses traversal, roots, control characters and unsupported bounds", () => {
    expect(instructionInventoryPath("src\\tests\\AGENTS.md")).toBe("src/tests/AGENTS.md")
    for (const path of [
      "",
      "/tmp/AGENTS.md",
      "../AGENTS.md",
      "src/../AGENTS.md",
      "./AGENTS.md",
      "src//AGENTS.md",
      "src/",
      "C:\\repo\\AGENTS.md",
      "https://repo/AGENTS.md",
      "src/\u0000AGENTS.md",
      "src/\nAGENTS.md",
      "tests/\uD800/AGENTS.md",
      "tests/\uDC00/AGENTS.md",
      "x".repeat(4097),
    ]) {
      expect(instructionInventoryPath(path)).toBeUndefined()
      expect(countInstructionPaths([{ path }])).toEqual({ complete: false, reason: "invalid-path" })
    }
    expect(countInstructionPaths([{ path: "a/AGENTS.md" }, { path: "b/AGENTS.md" }], { files: 1 })).toEqual({
      complete: false,
      reason: "file-limit",
    })
    expect(countInstructionPaths([{ path: "a/AGENTS.md" }], { bytes: 1 })).toEqual({
      complete: false,
      reason: "byte-limit",
    })
    expect(countInstructionPaths([], { files: MAX_INSTRUCTION_COUNT_FILES + 1 })).toEqual({
      complete: false,
      reason: "invalid-limit",
    })
    expect(countInstructionPaths([], { bytes: NaN })).toEqual({ complete: false, reason: "invalid-limit" })
    expect(instructionInventoryPath("tests/\uFFFD/AGENTS.md")).toBe("tests/\uFFFD/AGENTS.md")
    expect(countInstructionPaths([{ path: "tests/\uFFFD/AGENTS.md" }])).toMatchObject({
      complete: true,
      nestedFiles: 1,
    })
  })

  test("duplicate separator aliases cannot inflate a count or produce a partial decision", () => {
    expect(countInstructionPaths([{ path: "tests/AGENTS.md" }, { path: "tests\\AGENTS.md" }])).toEqual({
      complete: false,
      reason: "duplicate-path",
    })
    const result = countInstructionPaths([])
    expect(result.complete).toBe(true)
    if (!result.complete) throw new Error("The empty inventory did not count")
    expect(result.nestedFiles).toBe(0)
    expect(result.segments.every((entry) => entry.files === 0)).toBe(true)
  })
})
