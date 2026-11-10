import { expect, test } from "bun:test"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"

// The prompt guard and learned-skill asks on the Permissions page, as readers see them (section 8): what asks, what is
// held, what is not covered, and how the owner approves. The guard is an ask and a hold, so the page never says the
// agent cannot change its prompts, and every paragraph about it carries the 1.99.113 release label.
const page = await Bun.file(new URL("../src/pages/docs/permissions.astro", import.meta.url)).text()

// The section from its heading to the next one, as written.
function source(id: string) {
  const start = page.indexOf(`<h2 id="${id}">`)
  expect(start).toBeGreaterThan(-1)
  const end = page.indexOf("<h2", start + 1)
  return page.slice(start, end === -1 ? undefined : end)
}

// The same, without markup.
function section(id: string) {
  return source(id)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
}

test("every paragraph about the prompt guard or learned skills starts with the release label", () => {
  const paragraphs = ["prompt-files", "learned-skills"].flatMap((id) =>
    [...source(id).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((match) => match[1]!.trim()),
  )
  expect(paragraphs).toHaveLength(4)
  for (const text of paragraphs) expect(text.startsWith("{release113.since}")).toBe(true)
  expect(page).toMatch(/import \{ release113 \} from "\.\.\/\.\.\/data\/vector-releases"/)
})

test("the prompt guard says what asks, what is held, how to approve, and what it does not see", () => {
  const text = section("prompt-files")
  expect(text).toContain(PermissionPolicy.PROMPT_SOURCE)
  expect(text).toContain("every time")
  for (const command of ["cp", "mv", "install", "ln", "tee", "sed -i", "dd"]) expect(text).toContain(` ${command} `)
  expect(text).toContain("A repository's own AGENTS.md is not one")
  expect(text).toContain("such as a test fixture, is edited like any other file")
  expect(text).toContain("vector trust prompts approve")
  expect(text).toContain("refuse to run from an agent's shell or from Vector's own terminal")
  for (const unseen of ["node -e", "python -c", "bash -c", "git apply", "the V2 bash tool", "an MCP filesystem server"])
    expect(text).toContain(unseen)
  expect(text).toContain("this is an ask and a hold, not a guarantee")
  expect(text).not.toMatch(/cannot (change|edit|modify) (its|their) (own )?prompts/i)
})

test("learned skills ask learned_skill only when Vector approved them", () => {
  const text = section("learned-skills")
  expect(text).toContain("learned_skill")
  expect(text).toContain("a skill you approved does not")
  expect(text).toContain("Every command in a learned skill still goes through your permission rules.")
})
