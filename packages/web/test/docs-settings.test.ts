import { expect, test } from "bun:test"
import { docsMoved } from "../src/data/docs-nav"

const page = (name: string) => Bun.file(new URL(`../src/pages/docs/${name}.astro`, import.meta.url)).text()

// A section as readers see it: from its heading to the next one, without markup.
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

test("the desktop app docs describe today's Settings, not the removed pages", async () => {
  const text = await section("desktop-app", "settings")
  expect(text).toContain("Click your name at the bottom of the sidebar to open Settings at Account")
  expect(text).toContain("Settings in the Help menu, or Cmd+,")
  expect(text).toContain("an Update button takes the gear's place")
  expect(text).toContain("Home shows the same Update button too, just before its Settings button")
  expect(text).toContain(
    "Vector has one look, its own dark theme, and shows its interface in your computer's language.",
  )
  expect(text).toContain("Vector Tab")
  // Codium shows a share of the month, never amounts, credits or top-ups (A29).
  expect(text).toContain("your Vector Codium plan with how much of this month is left, as a percentage")
  expect(text).not.toMatch(/credits|top-?ups?|purchased/i)
  for (const removed of [
    "Appearance",
    "colour scheme",
    "Chat",
    "Personalization",
    "Voice",
    "Keybinds",
    "Project rules",
  ])
    expect(text).not.toContain(removed)
  expect(text).not.toMatch(/project/i)
})

test("the desktop app docs say where shortcuts and the terminal shell are changed", async () => {
  // Both were only in the old settings dialog, which the app no longer opens.
  expect(await section("desktop-app", "workspace-rail")).toContain(
    "Shortcuts are editable in Settings → Keyboard shortcuts, which can also reset them to their defaults.",
  )
  const text = await section("desktop-app", "settings")
  expect(text).toContain("Keyboard shortcuts")
  expect(text).toContain("Backspace or Delete clears it, Escape cancels")
  expect(text).toContain("Reset to defaults puts every shortcut back")
  expect(text).toContain("General also has a Terminal card with the Terminal Shell picker, Auto by default")
  expect(text).toContain("unless the picker marks it terminal only")
})

test("repository rules live in .vector/RULES.md, with no Project rules screen to open", async () => {
  const text = await section("vector-agent", "repository-rules")
  expect(text).toContain("Repository rules live in .vector/RULES.md")
  expect(text).toContain("Don't flag this again")
  // The file is where rules change now: a deleted line is a removed rule, for Vector's agents and the external CLIs.
  expect(text).toContain("delete a line to remove the rule, or edit it to change the rule")
  expect(text).toContain("Undo takes it out again")
  expect(text).toContain("as the file has them now")
  expect(text).not.toMatch(/workspace rail|home screen|Settings/)
  expect(text).not.toMatch(/project/i)
  expect(await page("external-agents")).toContain('href="/docs/vector-agent#repository-rules"')
})

test("the old settings-appearance and project-rules links still land on a heading that exists", async () => {
  const vercel = (await Bun.file(new URL("../../../vercel.json", import.meta.url)).json()) as {
    redirects: { source: string; destination: string }[]
  }
  for (const [id, target] of [
    ["settings-appearance", "desktop-app#settings"],
    ["project-rules", "vector-agent#repository-rules"],
  ]) {
    expect(docsMoved[id]).toBe(target)
    expect(vercel.redirects.find((redirect) => redirect.source === `/docs/${id}`)?.destination).toBe(`/docs/${target}`)
    const [name, anchor] = target.split("#")
    expect(await page(name)).toContain(`<h2 id="${anchor}">`)
  }
})

test("the desktop app docs describe Settings → General → While Vector works in the app's own words", async () => {
  const en = await Bun.file(new URL("../../app/src/i18n/en.ts", import.meta.url)).text()
  const string = (key: string) => {
    const found = en.match(new RegExp(`"${key.replaceAll(".", "\\.")}":\\s*"((?:[^"\\\\]|\\\\.)*)"`))
    if (!found) throw new Error(`${key} is not a string in en.ts`)
    return String(JSON.parse(`"${found[1]}"`))
  }
  const text = await section("desktop-app", "settings")
  // The card is new in 1.99.113, so its paragraph carries the release label.
  expect(text).toContain("{release113.since} General also has a While Vector works card")
  for (const key of [
    "settings.general.section.whileWorking.title",
    "settings.general.row.followup.title",
    "settings.general.row.followup.option.steer",
    "settings.general.row.followup.option.queue",
    "settings.general.row.stopScope.title",
    "settings.general.row.stopScope.option.turn",
    "settings.general.row.stopScope.option.all",
  ])
    expect([key, text.includes(string(key))]).toEqual([key, true])
  expect(string("settings.general.section.whileWorking.description")).toContain("These apply on this device only.")
  expect(text).toContain("applies on this device only")
  expect(string("settings.general.row.followup.description")).toContain(
    "Alt+Enter (Option+Enter on a Mac) does the other for one message; slash commands and shell input always queue.",
  )
  expect(text).toContain(
    "Alt+Enter (Option+Enter on a Mac) does the other for one message, and slash commands and shell input always queue.",
  )
  expect(text).toContain("chooses what Stop, Esc and Ctrl+G stop")
  expect(string("settings.general.row.stopScope.description")).toContain("What Stop, Esc and Ctrl+G stop.")
})
