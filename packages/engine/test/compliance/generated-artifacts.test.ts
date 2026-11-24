import { expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { tmpdir } from "../fixture/fixture"

test("published schemas and dependency notices match their generators", async () => {
  await using tmp = await tmpdir()
  const root = path.resolve(import.meta.dir, "../../../..")
  for (const [cwd, command, outputs] of [
    [
      root,
      ["script/dependency-notices.ts", path.join(tmp.path, "notices.md")],
      [["DEPENDENCY_NOTICES.md", "notices.md"]],
    ],
    [
      path.join(root, "packages/engine"),
      ["script/schema.ts", path.join(tmp.path, "config.json"), path.join(tmp.path, "tui.json")],
      [
        ["packages/web/public/config.json", "config.json"],
        ["packages/web/public/tui.json", "tui.json"],
      ],
    ],
  ] as const) {
    const child = Bun.spawn([process.execPath, ...command], { cwd, stdout: "pipe", stderr: "pipe" })
    const [code, error] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    expect(code, error).toBe(0)
    for (const [committed, generated] of outputs) {
      const expected = Buffer.from(await Bun.file(path.join(root, committed)).arrayBuffer())
      const actual = Buffer.from(await Bun.file(path.join(tmp.path, generated)).arrayBuffer())
      const matches = expected.equals(actual)
      expect(matches, matches ? committed : difference(committed, expected, actual)).toBe(true)
    }
  }
}, 60_000)

// Vector loads an earlier version's research.search and research.browser_search and drops them, so the published
// schema lists them, marked deprecated, while still refusing any other key an editor would underline.
test("the published config schema accepts an earlier version's research search keys, marked deprecated", async () => {
  const root = path.resolve(import.meta.dir, "../../../..")
  const schema = await Bun.file(path.join(root, "packages/web/public/config.json")).json()
  const research = schema.$defs.ResearchConfig
  expect(research.additionalProperties).toBe(false)
  for (const key of ["search", "browser_search"])
    expect(research.properties[key].description).toStartWith("@deprecated")
  expect(Object.keys(research.properties)).toContain("retain_days")
})

// VS-23d (SF-15): the user config's review block ships hidden (I-14, owner Q16). Vector decodes it, and the published
// schema, which refuses any key it does not list, leaves it out with its definition.
test("the published config schema leaves out the hidden review block that Vector decodes", async () => {
  const root = path.resolve(import.meta.dir, "../../../..")
  const schema = await Bun.file(path.join(root, "packages/web/public/config.json")).json()
  expect(schema.$defs.Config.additionalProperties).toBe(false)
  expect(Object.keys(schema.$defs.Config.properties)).not.toContain("review")
  expect(Object.keys(schema.$defs)).not.toContain("GlobalReviewConfig")
  expect(JSON.stringify(schema)).not.toContain("zdrAttested")
  const review = { privacy: "zdr", holdback: "secrets", zdrAttested: ["acme"] }
  expect(
    Schema.decodeUnknownSync(ConfigV1.Info)({ review }, { errors: "all", onExcessProperty: "error" }).review,
  ).toEqual(review)
})

function difference(file: string, expected: Buffer, actual: Buffer) {
  const before = expected.toString("utf8").split("\n")
  const after = actual.toString("utf8").split("\n")
  const mismatch = before.findIndex((line, index) => line !== after[index])
  const index = mismatch < 0 ? before.length : mismatch
  const context = (lines: string[], bytes: number) => ({
    bytes,
    heading: lines
      .slice(0, index + 1)
      .findLast((line) => /^##\s/.test(line))
      ?.slice(0, 300),
    // Preserve CR and other control characters in the diagnostic; equality remains byte-exact.
    line: lines[index]?.slice(0, 400) ?? "<end of file>",
  })
  return `${file}: first different line ${index + 1}\n${JSON.stringify(
    { committed: context(before, expected.length), generated: context(after, actual.length) },
    null,
    2,
  )}`
}
