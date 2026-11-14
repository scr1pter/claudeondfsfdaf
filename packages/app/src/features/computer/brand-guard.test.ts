import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Hands } from "@vectordevai/schema/hands"

// D1 naming guard: the feature's name is written once, in packages/schema/src/hands.ts. Every other source file
// reads Hands.NAME (or an i18n key that injects it), so a rename touches one file. This test fails when the name is
// written into a source file of the renderer, desktop or session UI packages, outside hands.ts, the i18n files and
// test files.

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url))

/** Source roots the guard reads, relative to the repository root. */
const ROOTS = ["packages/app/src", "packages/desktop/src", "packages/session-ui/src", "packages/ui/src"]

/** Text files that can carry user-visible copy. Images, audio and fonts are skipped. */
const TEXT = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".html",
  ".css",
  ".json",
  ".svg",
  ".md",
  ".txt",
])

const BRAND_FILE = "packages/schema/src/hands.ts"
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
const TEST_DIRS = new Set(["test", "tests", "__tests__", "e2e"])

/** The words of Hands.NAME, case-sensitive, with any whitespace or a written no-break space between them. */
const pattern = () =>
  new RegExp(
    Hands.NAME.split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(String.raw`(?:\s|&nbsp;|&#160;|&#xa0;|\\u00a0|\\xa0)+`),
    "g",
  )

/** Lines (1-based) where the name is written in `text`. */
function leaks(text: string): number[] {
  return [...text.matchAll(pattern())].map((match) => text.slice(0, match.index).split("\n").length)
}

/** Whether a file, by its path relative to the repository root, may write the name. */
function exempt(relative: string): boolean {
  const posix = relative.split(path.sep).join("/")
  if (posix === BRAND_FILE) return true
  const parts = posix.split("/")
  if (parts.slice(0, -1).includes("i18n")) return true
  if (parts.slice(0, -1).some((part) => TEST_DIRS.has(part))) return true
  return TEST_FILE.test(parts[parts.length - 1] ?? "")
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && TEXT.has(path.extname(entry.name).toLowerCase())) out.push(full)
  }
  return out
}

describe("brand guard", () => {
  test("the matcher finds the name however it is spaced, and only the name", () => {
    expect(leaks(`label: "${Hands.NAME}"`)).toEqual([1])
    const [first, ...rest] = Hands.NAME.split(" ")
    const second = rest.join(" ")
    expect(leaks(`x\n${first}\n      ${second} is on`)).toEqual([2])
    expect(leaks(`<p>${first}&nbsp;${second}</p>`)).toEqual([1])
    expect(leaks(`${first} ${second}`)).toEqual([1])
    expect(leaks(`"${first}\\u00a0${second}"`)).toEqual([1])
    expect(leaks(`a\nb\n${Hands.NAME} and ${Hands.NAME}`)).toEqual([3, 3])
    // "Vector hands the request to an agent" is a verb, not the name.
    expect(leaks(`${first} ${second.toLowerCase()} the request to an agent`)).toEqual([])
    expect(leaks(`${first}${second}Icon`)).toEqual([])
  })

  test("only hands.ts, i18n files and test files are exempt", () => {
    expect(exempt(BRAND_FILE)).toBe(true)
    expect(exempt("packages/app/src/i18n/en.ts")).toBe(true)
    expect(exempt("packages/ui/src/i18n/de.ts")).toBe(true)
    expect(exempt("packages/app/src/features/computer/main-copy.test.ts")).toBe(true)
    expect(exempt("packages/app/src/features/computer/dock.spec.tsx")).toBe(true)
    expect(exempt("packages/desktop/src/main/__tests__/x.ts")).toBe(true)
    expect(exempt("packages/app/src/features/computer/hands.ts")).toBe(false)
    expect(exempt("packages/app/src/features/computer/main-copy.ts")).toBe(false)
    expect(exempt("packages/app/src/i18n-names.ts")).toBe(false)
    expect(exempt("packages/app/src/features/computer/test-helpers.ts")).toBe(false)
    expect(exempt("packages/desktop/src/main/computer-tray.ts")).toBe(false)
  })

  test("hands.ts writes the name exactly once", () => {
    expect(leaks(readFileSync(path.join(REPO, BRAND_FILE), "utf8"))).toHaveLength(1)
  })

  test("every root exists and has source files", () => {
    for (const root of ROOTS) expect(walk(path.join(REPO, root)).length).toBeGreaterThan(0)
  })

  test("no source file outside hands.ts, i18n and tests writes the name", () => {
    const found: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(path.join(REPO, root))) {
        const relative = path.relative(REPO, file)
        if (exempt(relative)) continue
        for (const line of leaks(readFileSync(file, "utf8")))
          found.push(`${relative.split(path.sep).join("/")}:${line}`)
      }
    }
    // Read Hands.NAME from @vectordevai/schema/hands, or use an i18n key that injects {{name}}.
    expect(found).toEqual([])
  })
})
