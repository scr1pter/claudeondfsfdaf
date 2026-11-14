import { expect, test } from "bun:test"

// The Permissions and Skills docs describe what the engine does: the last matching permission rule decides (not deny
// first), and the skill scanner reads only SKILL.md files.
const read = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url)).text()
const plain = (text: string) =>
  text
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")

test("the Permissions docs say the last matching rule decides, as the engine evaluates it", async () => {
  const engine = await read("../engine/src/permission/index.ts")
  expect(engine).toContain(".findLast((rule) => Wildcard.match(permission, rule.permission)")

  const text = plain(await read("src/pages/docs/permissions.astro"))
  expect(text).toContain("The last rule in the list whose permission and pattern both match decides")
  expect(text).toContain("so a later allow overrides an earlier deny. When no rule matches, Vector asks.")
  expect(text).toContain("To make the deny win, write it after the broader rule it should override")
  expect(text).toContain("A remembered answer only turns an ask into an allow, and never overrides a deny.")
  // The old claims described a deny-first merge and answers saved for the repository, which the engine does not do.
  expect(text).not.toContain("deny wins")
  expect(text).not.toContain("Saved answers are per repository")
  expect(text).not.toContain("denied everything rather than trusted")
})

test("the Skills docs name only SKILL.md, the one file name the scanner reads", async () => {
  const engine = await read("../engine/src/skill/index.ts")
  const patterns = [...engine.matchAll(/^const \w+_PATTERN = "([^"]+)"$/gm)].map((match) => match[1])
  expect(patterns.length).toBeGreaterThan(0)
  for (const pattern of patterns) expect(pattern.endsWith("/SKILL.md")).toBe(true)

  const text = plain(await read("src/pages/docs/skills-and-commands.astro"))
  expect(text).toContain("Vector reads no other file name, so a skill saved as <name>.md is not found")
  expect(text).not.toContain("(or <name>.md)")
  for (const place of [".claude/skills/", ".agents/skills/", "skills.paths", "skills.urls"]) expect(text).toContain(place)
})
