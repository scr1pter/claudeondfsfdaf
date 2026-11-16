import { expect, test } from "bun:test"
import path from "path"
import { runtimeModuleIdForSpecifier } from "@opentui/core/runtime-plugin"
import { tmpdir } from "../fixture/fixture"

// Importing the TUI runtime registers the process-global OpenTUI runtime plugin, as it does for every
// later test file in the same Bun process.
await import("../../src/plugin/tui/runtime")

test("leaves Vector source text alone once the TUI runtime plugin is registered", async () => {
  const mod = await import("../fixture/tui-runtime-scope")
  expect(mod.marker).toBe('from "@opentui/keymap/solid"')
  expect(mod.pattern.source).toBe(String.raw`from "ai"|from "@ai-sdk\/provider"`)
  expect(mod.pattern.test('import { generateText } from "ai"')).toBe(true)
})

test("still rewrites runtime specifiers in plugin files outside the Vector sources", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "external-plugin.ts")
  await Bun.write(file, `export const marker = 'from "@opentui/keymap/solid"'\n`)
  const mod = await import(file)
  expect(mod.marker).toBe(`from "${runtimeModuleIdForSpecifier("@opentui/keymap/solid")}"`)
})
