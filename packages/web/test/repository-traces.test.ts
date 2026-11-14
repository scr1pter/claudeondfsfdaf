import { expect, test } from "bun:test"
import path from "node:path"
import * as content from "../src/data/docs-content"
import * as nav from "../src/data/docs-nav"
import * as releases from "../src/data/vector-releases"

// The site is read by people who cannot open Vector's source repository, which is private. Its copy says what Vector
// does without commit hashes, the repository's own folders, or the folder on the owner's computer that Vector is built
// in; the pictures of the app work in a sample repository. Code comments may still point into the tree.
const web = path.join(import.meta.dir, "..")

const hash = /\b(?:commit|revision) [0-9a-f]{7,40}\b|\(commit [0-9a-f]+\)/i
const ownerFolder = /~\/Vectordev|\/Users\/[A-Za-z]|\/home\/[a-z]+\/|\.codex\/worktrees|\.cache\/vector-release/
const repository = /docs\/benchmarks\/|\bscr1pter\b|Vector's (?:source|repository)\b|release requirements/
// The session picture's sample repository has packages of its own; the docs never name Vector's.
const packages = /\bpackages\/[a-z]/

// What an .astro file renders: its frontmatter, scripts, styles and comments are left out.
const markup = (text: string) =>
  text
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")

const pages = await Promise.all(
  (await Array.fromAsync(new Bun.Glob("src/{pages,components}/**/*.astro").scan({ cwd: web }))).map(async (file) => ({
    file,
    text: markup(await Bun.file(path.join(web, file)).text()),
  })),
)

// Every string the data modules hand to the pages. knowledgeEval.report is where test/brain-docs.test.ts finds the
// eval's report; no page renders it.
const strings = (value: unknown, at: string): { file: string; text: string }[] => {
  if (typeof value === "string") return [{ file: at, text: value }]
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${at}[${index}]`))
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) =>
      at === "docs-content.knowledgeEval" && key === "report" ? [] : strings(item, `${at}.${key}`),
    )
  return []
}
const data = [
  ...Object.entries(content).flatMap(([name, value]) => strings(value, `docs-content.${name}`)),
  ...Object.entries(nav).flatMap(([name, value]) => strings(value, `docs-nav.${name}`)),
  ...Object.entries(releases).flatMap(([name, value]) => strings(value, `vector-releases.${name}`)),
]
const changelog = strings(await Bun.file(path.join(web, "public/changelog.json")).json(), "changelog.json")

const offending = (sources: { file: string; text: string }[], pattern: RegExp) =>
  sources.flatMap((source) =>
    source.text
      .split("\n")
      .filter((line) => pattern.test(line))
      .map((line) => `${source.file}: ${line.trim().slice(0, 140)}`),
  )

test("the scan covers the site's pages and the release notes", () => {
  expect(pages.length).toBeGreaterThan(50)
  expect(pages.some((page) => page.file === "src/pages/investors.astro")).toBe(true)
  expect(data.length).toBeGreaterThan(200)
  expect(changelog.length).toBeGreaterThan(50)
})

test("no page, docs table or release note shows a commit hash", () => {
  expect(offending([...pages, ...data, ...changelog], hash)).toEqual([])
})

test("no page or example shows the folder on the owner's computer", () => {
  expect(offending([...pages, ...data, ...changelog], ownerFolder)).toEqual([])
})

test("the docs and the release notes do not point into Vector's source repository", () => {
  expect(offending([...pages, ...data, ...changelog], repository)).toEqual([])
  const docs = pages.filter((page) => page.file.startsWith("src/pages/docs/"))
  expect(docs.length).toBeGreaterThan(20)
  expect(offending([...docs, ...data], packages)).toEqual([])
})

test("the site's config carries no contact address and no link to the source repository", async () => {
  const config = await Bun.file(path.join(web, "config.mjs")).text()
  expect(config).not.toMatch(/@[A-Za-z0-9-]+\.[A-Za-z]{2,}/)
  expect(config).not.toMatch(/github\.com/)
})
