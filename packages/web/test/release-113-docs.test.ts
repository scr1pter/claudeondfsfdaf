import { expect, test } from "bun:test"
import path from "node:path"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { docsNav } from "../src/data/docs-nav"
import { publishedDesktopVersion, release113, release113Copy, release113Version } from "../src/data/vector-releases"

// The docs for what desktop 1.99.113 brings (learned skills and workflow insights) say what this tree does: the numbers
// are the engine's, the privacy statements are the app's own words, and every paragraph about them says the release
// is coming until the download page offers it.
const repo = path.join(import.meta.dir, "../../..")
const read = async (file: string) => (await Bun.file(path.join(repo, file)).text()).replace(/\s+/g, " ")
const text = (page: string) => page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
const pages = Object.fromEntries(
  await Promise.all(
    ["brain", "skills-and-commands", "tokenomics", "local", "models", "terminal-agent"].map(
      async (name) => [name, await read(`packages/web/src/pages/docs/${name}.astro`)] as const,
    ),
  ),
)
const notes = await read("docs/vector/owner-actions/release-199113.md")
const skills = await read("packages/app/src/components/settings-v2/memory-skills-model.ts")
const workflow = await read("packages/app/src/components/settings-v2/memory-workflow-model.ts")

// A string constant's value as its source file writes it, whitespace folded as the pages are read.
const constant = (source: string, name: string) => {
  const found = source.match(new RegExp(`\\b${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
  if (!found) throw new Error(`${name} is not a string in its file`)
  return String(JSON.parse(`"${found[1]}"`)).replace(/\s+/g, " ")
}

// Each paragraph or row of a page, as its source writes it.
const blocks = (page: string) => [...page.matchAll(/<(p|dd)\b[^>]*>(.*?)<\/\1>/g)].map((match) => match[2]!.trim())

const FEATURE = /learned skill|workflow insights|learned default|skill drafter|learned_skill/i

test("the release label follows the version the download page offers", () => {
  expect(release113Version).toBe("1.99.113")
  expect(release113Copy("1.99.111")).toMatchObject({ since: "Coming in desktop 1.99.113:", shipped: false })
  // 1.99.112 ships before these features.
  expect(release113Copy("1.99.112").shipped).toBe(false)
  expect(release113Copy("1.99.113")).toMatchObject({ since: "From desktop 1.99.113:", shipped: true })
  expect(release113Copy("1.100.0").shipped).toBe(true)
  expect(release113.shipped).toBe(Bun.semver.order(publishedDesktopVersion, release113Version) >= 0)
})

test("every paragraph about learned skills and workflow insights starts with the release label", () => {
  const about = Object.entries(pages).flatMap(([name, page]) =>
    blocks(page)
      .filter((block) => FEATURE.test(text(block)))
      .map((block) => [name, block.startsWith("{release113.since}")] as const),
  )
  expect(about.length).toBeGreaterThan(10)
  expect(about.filter(([, labelled]) => !labelled)).toEqual([])
  for (const page of Object.values(pages))
    expect(page).toMatch(/import \{[^}]*\brelease113\b[^}]*\} from "\.\.\/\.\.\/data\/vector-releases"/)
  const links = docsNav.flatMap((group) => group.links)
  for (const id of ["brain", "tokenomics"])
    expect(links.find((link) => link.id === id)?.blurb).toContain(release113.since)
})

test("the brain page keeps rules the owner's and says a learned skill is never one", () => {
  const brain = text(pages.brain!)
  expect(brain).toContain("Only you write rules; Vector never adds one on its own.")
  expect(brain).toContain("A learned skill is guidance the agent may load, never a rule.")
  expect(text(pages["skills-and-commands"]!)).toContain("A learned skill is guidance the agent may load, never a rule.")
  // The allowed commands are the brain's.
  expect(BrainSkill.TARGETS).toEqual(["test", "lint", "typecheck", "build", "check", "verify"])
  expect(BrainSkill.DENY_WORDS).toEqual(["deploy", "publish", "release", "push", "upload", "install", "migrate", "db"])
  expect(brain).toContain(
    "one check (a test, lint, typecheck, build, check or verify command, never one that deploys, publishes, releases, pushes, uploads, installs or migrates)",
  )
  expect(brain).toContain(`a draft you leave is dropped after ${BrainSkill.LIMIT.pendingDays} days`)
})

test("the pages carry the privacy statements in the app's own words", () => {
  const brain = text(pages.brain!)
  // A statement may follow the release label, which lowers its first letter.
  for (const name of ["privacy", "draft", "guests", "shares", "team"]) {
    const statement = constant(skills, name)
    const lowered = `${statement[0]!.toLowerCase()}${statement.slice(1)}`
    expect([name, brain.includes(statement) || brain.includes(lowered)]).toEqual([name, true])
  }
  expect(brain).toContain(constant(workflow, "privacy"))
  expect(brain).toContain(
    "Erasing memory, a session's memory or one skill in Vector 1.99.113 or later erases its skills, skill versions, skill uses and workflow records, and rolls back skill text that session taught. An erase of all or of a repository's memory from an older Vector build is finished the next time this version opens that memory; erasing one session from an older build does not reach skills.",
  )
  expect(text(pages["terminal-agent"]!)).toContain(
    "usage check-ins are unchanged and never include skills or workflow data.",
  )
  expect(text(pages["terminal-agent"]!)).toContain("the effort levels you picked")
  expect(text(pages.local!)).toContain("by default it runs only with Vector Local on")
})

test("tokenomics keeps recommendations and learned defaults apart, with their own thresholds", async () => {
  const tokenomics = text(pages.tokenomics!)
  expect(tokenomics).toContain("A model gets none until it has at least three recorded runs for that kind of task")
  expect(BrainWorkflow.MIN_RUNS).toBe(6)
  expect(tokenomics).toContain(`at least ${BrainWorkflow.MIN_RUNS} checked runs`)
  expect(tokenomics).toContain(`for at least ${Math.round((1 - BrainWorkflow.CHEAPER) * 100)}% less`)
  expect(tokenomics).toContain(constant(workflow, "own"))
  expect(tokenomics).toContain("sizing.learn")
  expect(tokenomics).toContain("--pure")
  expect(tokenomics).toContain("unknown cost stays unknown")
  // The recommender's own minimum is the one the page names.
  expect(await read("packages/app/src/features/economics/economics-recommender.ts")).toContain("minSamples = 3,")
})

test("the models page says a learned default may drop Thorough's extra effort", () => {
  expect(text(pages.models!)).toContain(
    "{release113.since} when you leave effort on Default, the request's size sets it, and a learned default may drop Thorough's extra effort (Settings → Memory → Workflow insights).",
  )
})

test("the 1.99.113 notes are a draft that names what blocks the publish", () => {
  expect(notes).toContain("# Desktop 1.99.113: release notes and owner steps (draft)")
  for (const name of ["WP1", "WP2", "WP3", "WP5"]) expect(notes).toContain(`**${name},`)
  expect(notes).toContain("packages/web/test/release-113-docs.test.ts")
  expect(notes).not.toMatch(/\bTODO\b|\bTBD\b|\bFIXME\b|PLACEHOLDER/)
})

test("the new copy keeps to the copy rules and promises nothing the guard cannot keep", () => {
  for (const page of [...Object.values(pages), notes].map(text))
    for (const banned of [
      /(?<![\w\-./:#@$[{=])projects?(?![\w\-/\]=}(])(?!\.\w)(?!:\S)/i,
      /\bexactly\b/i,
      /cannot change its prompts/i,
      /absolute privacy/i,
      /\bguarantee/i,
    ])
      expect(page).not.toMatch(banned)
})
