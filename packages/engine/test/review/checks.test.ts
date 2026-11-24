import { expect, test } from "bun:test"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { offlineChecks } from "../../src/review/checks"

const marker = "ghp_" + "zX5p".repeat(9)
const diff = (file: string, lines: string[]) =>
  parseUnifiedDiff(
    [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1,3 +1,3 @@", ...lines].join("\n"),
  )
const manifest = diff("packages/a/package.json", [
  '   "dependencies": {',
  '-    "sample": "1.0.0"',
  '+    "sample": "1.1.0"',
  "   }",
])
const lock = diff("package-lock.json", ["   {", '-    "integrity": "sha512-ZmFrZQ=="', "   }"])

test("versioned offline evidence contains no source, secret values, package versions or repository controls", async () => {
  const files = [
    ...diff("src/fixtures.ts", ["-const credential = null", `+const credential = "${marker}"`]),
    ...diff(".vector/scanners.json", ['+{"rules":[],"plugins":["./unused-fixture.js"]}']),
    ...manifest,
  ]
  const result = await offlineChecks(files, files)
  expect(result.evidence.map((item) => item.rule)).toEqual(["secret-added", "manifest-without-lock"])
  expect(JSON.stringify(result)).not.toContain(marker)
  expect(JSON.stringify(result)).not.toContain("sample")
  expect(JSON.stringify(result)).not.toContain("unused-fixture")
  expect(JSON.stringify(result)).not.toContain("1.1.0")
  expect(
    (await offlineChecks([...manifest, ...lock], [...manifest, ...lock])).evidence.map((item) => item.rule),
  ).toEqual(["integrity-removed"])
  const rewritten = diff("package-lock.json", [
    '-    "integrity": "sha512-ZmFrZQ=="',
    '+    "integrity": "sha512-dGVzdA=="',
  ])
  expect((await offlineChecks(rewritten, rewritten)).evidence).toEqual([])
})

test("ignores existing, removed and held material, enforces bounds and honors a mid-scan cancellation", async () => {
  for (const files of [
    diff(".env", [`+VALUE=${marker}`]),
    diff("src/test.ts", [`-const synthetic = "${marker}"`]),
    diff("src/test.ts", [` const fixture = "${marker}"`]),
  ]) {
    expect((await offlineChecks(files, files)).evidence).toEqual([])
  }
  const large = diff("large.ts", ["+" + "x".repeat(70_000)])
  expect(await offlineChecks(large, large)).toEqual({ evidence: [], incomplete: "limit" })
  const repeated = Array.from({ length: 100 }, (_, index) => diff(`base/${index}.ts`, ["+const fixture = 1"])[0]!)
  const control = new AbortController()
  const task = offlineChecks(repeated, repeated, control.signal)
  control.abort()
  expect(await task).toEqual({ evidence: [], incomplete: "cancelled" })
  expect(await offlineChecks(repeated, repeated, control.signal)).toEqual({ evidence: [], incomplete: "cancelled" })
})
