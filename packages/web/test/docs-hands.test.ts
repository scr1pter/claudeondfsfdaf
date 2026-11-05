import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Hands } from "@vectordevai/schema/hands"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { docsNav } from "../src/data/docs-nav"
import { release112 } from "../src/data/vector-releases"

const page = await Bun.file(new URL("../src/pages/docs/vector-hands.astro", import.meta.url)).text()

test("the feature's stable docs route uses the shared brand and release stage", () => {
  const links = docsNav.flatMap((group) => group.links).filter((link) => link.id === Hands.DOCS)
  expect(links).toHaveLength(1)
  expect(links[0]?.title).toBe(Hands.NAME)
  expect(links[0]?.blurb).toStartWith(release112.since)
  expect(page).toContain('<DocsPage id="vector-hands">')
  expect(page).toContain("{Hands.NAME}")
  expect(page).toContain("{Hands.MENTION}")
  expect(page).not.toContain("Computer Use")
})

test("setup names separate helper grants and user-owned OS prompts", () => {
  for (const text of ["Screen Recording", "Accessibility", "separately", "Preview", "ask for access again"])
    expect(page).toContain(text)
  expect(page).toContain("Privacy_ScreenCapture")
  expect(page).toContain("Privacy_Accessibility")
  expect(page).toContain("ms-settings:privacy")
  expect(page).toContain("Grant access yourself")
  expect(page).toContain("administrator")
})

test("control and consent copy preserves Stop, takeover and independent safety floors", () => {
  expect(page).toContain("{Hands.BANNER}")
  for (const text of [
    "Take over",
    "Stop",
    "Esc",
    "one",
    "Always allow",
    "Browsers",
    "file managers",
    "finance apps",
    "developer apps",
    "Terminals",
    "scripting tools",
    "password managers",
    "remote-control viewers",
    "security and permission",
    "Vector's own controls",
    "credential fields",
    "cannot be removed",
  ])
    expect(page).toContain(text)
})

test("data controls state actual storage, provider, deletion and sharing boundaries", () => {
  for (const text of [
    "on this computer",
    "model you selected",
    "screen-reader",
    "Delete all screenshots",
    "cannot retract",
    "Include screenshots",
    "leave screenshots out",
    "company's maximum",
  ])
    expect(page).toContain(text)
})

test("the managed-only sample decodes and cannot be mistaken for personal configuration", () => {
  const text = page.match(/<pre><code>\{`([\s\S]*?)`\}<\/code><\/pre>/)?.[1]
  expect(text).toBeDefined()
  const config = Schema.decodeUnknownSync(ConfigV1.Info)(JSON.parse(text!), { onExcessProperty: "error" })
  expect(config.computer).toMatchObject({
    enabled: true,
    allow_always: false,
    native_tools: "off",
    screenshot_retention_days: 7,
  })
  for (const sentence of ["Vector 1.99.112 or later", "company-managed", "Do not add", "user's consent"])
    expect(page).toContain(sentence)
  for (const limit of [
    "macOS 14",
    "build 19041",
    "Linux, WSL and remote engines",
    "Locked-session operation is not included",
  ])
    expect(page).toContain(limit)
})
