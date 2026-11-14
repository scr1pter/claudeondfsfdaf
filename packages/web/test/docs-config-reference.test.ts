import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { Exit, Schema } from "effect"
import { ConfigMarkdown } from "@vectordevai/core/config/markdown"
import { ConfigAgentV1 } from "@vectordevai/core/v1/config/agent"
import { ConfigCommandV1 } from "@vectordevai/core/v1/config/command"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { docsMoved, docsNav } from "../src/data/docs-nav"

const docs = new URL("../src/pages/docs/", import.meta.url)
const page = (name: string) => Bun.file(new URL(`${name}.astro`, docs)).text()
const pages = (await readdir(docs)).filter((file) => file.endsWith(".astro")).map((file) => file.slice(0, -6))

// The samples a page shows as <pre><code>{`…`}</code></pre>, as readers see them: the template literal's escapes undone.
function samples(text: string) {
  return [...text.matchAll(/<pre><code>\{`([\s\S]*?)`\}<\/code><\/pre>/g)].map((match) =>
    match[1]!.replace(/\\([\\`$])/g, "$1"),
  )
}

// A section as readers see it: from its heading to the next heading of the same level, without markup.
async function section(name: string, id: string) {
  const text = await page(name)
  const start = text.indexOf(`<h2 id="${id}">`)
  expect(start).toBeGreaterThan(-1)
  const end = text.indexOf("<h2", start + 1)
  return text
    .slice(start, end === -1 ? undefined : end)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
}

const strict = { errors: "all", onExcessProperty: "error" } as const

test("every vector.json sample in the docs is one Vector reads, without a key it does not know", async () => {
  const failures: string[] = []
  let count = 0
  for (const name of pages) {
    for (const sample of samples(await page(name))) {
      if (!sample.trimStart().startsWith("{")) continue
      count++
      const exit = Schema.decodeUnknownExit(ConfigV1.Info)(JSON.parse(sample), strict)
      if (Exit.isFailure(exit)) failures.push(`${name}: ${sample.slice(0, 80)}`)
    }
  }
  // The pages for providers, models, MCP, agents, commands, instructions, formatters, LSP and compaction show them.
  expect(count).toBeGreaterThanOrEqual(12)
  expect(failures).toEqual([])
})

test("the agent and command file samples are files Vector loads", async () => {
  const agents = samples(await page("subagents")).filter((sample) => sample.startsWith("---"))
  const commands = samples(await page("skills-and-commands")).filter((sample) => sample.startsWith("---"))
  expect(agents.length).toBeGreaterThan(0)
  expect(commands.length).toBeGreaterThan(0)
  // As ConfigAgent.load and ConfigCommand.load build them from a Markdown file.
  for (const sample of agents) {
    const md = ConfigMarkdown.parse(sample)
    const exit = Schema.decodeUnknownExit(ConfigAgentV1.Info)({ name: "sample", ...md.data, prompt: md.content.trim() })
    expect(Exit.isSuccess(exit)).toBe(true)
  }
  for (const sample of commands) {
    const md = ConfigMarkdown.parse(sample)
    const exit = Schema.decodeUnknownExit(ConfigCommandV1.Info)({ name: "sample", ...md.data, template: md.content.trim() })
    expect(Exit.isSuccess(exit)).toBe(true)
  }
})

test("the config schema's help links land on the sections that list agent fields and command templates", async () => {
  const schema = await Bun.file(new URL("../public/config.json", import.meta.url)).text()
  const vercel = (await Bun.file(new URL("../../../vercel.json", import.meta.url)).json()) as {
    redirects: { source: string; destination: string }[]
  }
  for (const [link, target] of [
    ["custom-agents", "subagents#custom-agents"],
    ["commands", "skills-and-commands#commands"],
  ] as const) {
    expect(schema).toContain(`see https://vectordev.ai/docs/${link}"`)
    expect(docsMoved[link]).toBe(target)
    expect(vercel.redirects.find((redirect) => redirect.source === `/docs/${link}`)?.destination).toBe(`/docs/${target}`)
  }
  const agents = await section("subagents", "custom-agents")
  for (const field of ["description", "mode", "model", "variant", "prompt", "steps", "permission", "hidden", "disable"])
    expect(agents).toContain(field)
  expect(agents).toContain("default_agent")
  const commands = await section("skills-and-commands", "commands")
  for (const syntax of ["$ARGUMENTS", "$1", "!`command`", "@path", "description", "agent", "subtask", "model"])
    expect(commands).toContain(syntax)
})

test("the configuration page is a Reference page, and the docs' links to a section land on a heading", async () => {
  const reference = docsNav.find((group) => group.label === "Reference")?.links ?? []
  expect(reference.map((link) => link.id)).toContain("configuration")
  const broken: string[] = []
  for (const name of pages) {
    for (const match of (await page(name)).matchAll(/href="\/docs\/([a-z0-9-]+)(?:#([a-z0-9-]+))?"/g)) {
      const [, target, anchor] = match
      // An old page id resolves through docsMoved and the redirects in vercel.json.
      if (!anchor && Object.hasOwn(docsMoved, target!)) continue
      if (!pages.includes(target!)) {
        broken.push(`${name} -> ${target}${anchor ? `#${anchor}` : ""}`)
        continue
      }
      if (anchor && !(await page(target!)).includes(`id="${anchor}"`)) broken.push(`${name} -> ${target}#${anchor}`)
    }
  }
  expect(broken).toEqual([])
})
