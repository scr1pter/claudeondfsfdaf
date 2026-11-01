import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { runUnitTests, unitFiles } from "./test-unit.mjs"

async function fixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-app-unit-launcher-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, "src"))
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), "// Synthetic discovery fixture; never executed.\n")
  }
  return root
}

test("discovery includes every pinned Bun filename form, skips ignored directories and keeps stable order", async (t) => {
  const expected = [".test", "_test", ".spec", "_spec"].flatMap((suffix) =>
    ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"].map((extension) => `src/nested/check${suffix}.${extension}`),
  )
  expected.push("src/UPPER.TEST.TS", "src/.visible-to-bun.test.ts", "src/nested dir/space $ argument.test.ts")
  const root = await fixture(t, [
    ...expected,
    "src/normal.ts",
    "src/check.test.json",
    "src/test.ts",
    "src/.hidden/ignored.test.ts",
    "src/node_modules/ignored.test.ts",
    "src/NODE_MODULES/ignored.test.ts",
    "test-browser/elsewhere.test.ts",
    "scripts/test-unit.test.mjs",
  ])
  assert.deepEqual(await unitFiles(root), expected.map((file) => `./${file}`).sort())
})

test("directory links cannot turn discovery into a cycle", async (t) => {
  const root = await fixture(t, ["src/nested/check.test.ts"])
  // A directory junction works without symlink privileges on Windows; Node uses a normal link on POSIX.
  await symlink(path.join(root, "src"), path.join(root, "src/nested/loop"), "junction")
  assert.deepEqual(await unitFiles(root), ["./src/nested/check.test.ts"])
})

test("Windows runs each file once and serially, retains argv and continues after failures, crashes and spawn errors", async (t) => {
  const root = await fixture(t, ["src/z.test.ts", "src/b.test.ts", "src/a.test.ts", "src/c.test.ts", "src/d.test.ts"])
  const calls = []
  const output = []
  let active = 0
  const result = await runUnitTests({
    platform: "win32",
    root,
    log: (line) => output.push(line),
    run: async (command, args, options) => {
      assert.equal(active, 0)
      active++
      await Promise.resolve()
      calls.push({ command, args, options })
      active--
      if (args.at(-1) === "./src/a.test.ts") return { code: 1 }
      if (args.at(-1) === "./src/b.test.ts") return { code: 3 }
      if (args.at(-1) === "./src/c.test.ts") return { code: null, signal: "SIGABRT" }
      if (args.at(-1) === "./src/d.test.ts") throw new Error("Synthetic process start failure")
      return { code: 0 }
    },
  })
  assert.equal(result.code, 1)
  assert.deepEqual(result.failed, ["./src/a.test.ts", "./src/b.test.ts", "./src/c.test.ts", "./src/d.test.ts"])
  assert.deepEqual(
    calls.map((call) => call.args.at(-1)),
    await unitFiles(root),
  )
  for (const call of calls) {
    assert.equal(call.command, "bun")
    assert.deepEqual(call.args.slice(0, -1), ["test", "--isolate", "--only-failures", "--preload", "./happydom.ts"])
    assert.deepEqual(call.options, { cwd: root })
    assert.ok(output.includes(`App unit test: ${call.args.at(-1)}`))
  }
  assert.ok(output.includes("App unit tests: 1/5 files passed"))
})

test("all Windows files passing produces success without a retry", async (t) => {
  const root = await fixture(t, ["src/b.test.ts", "src/a.test.ts"])
  const calls = []
  const result = await runUnitTests({
    platform: "win32",
    root,
    log: () => {},
    run: async (_command, args) => {
      calls.push(args.at(-1))
      return { code: 0 }
    },
  })
  assert.equal(result.code, 0)
  assert.deepEqual(result.failed, [])
  assert.deepEqual(calls, ["./src/a.test.ts", "./src/b.test.ts"])
})

test("an empty Windows inventory fails before invoking any process", async (t) => {
  const root = await fixture(t, [])
  const calls = []
  await assert.rejects(
    runUnitTests({
      platform: "win32",
      root,
      log: () => {},
      run: async (...args) => {
        calls.push(args)
        return { code: 0 }
      },
    }),
    /No app unit test files found/,
  )
  assert.deepEqual(calls, [])
})

test("Linux preserves the one whole-source invocation and reports its failure", async (t) => {
  const root = await fixture(t, ["src/a.test.ts", "src/b.test.ts"])
  const calls = []
  const result = await runUnitTests({
    platform: "linux",
    root,
    log: () => {},
    run: async (...args) => {
      calls.push(args)
      return { code: 3 }
    },
  })
  assert.deepEqual(calls, [
    ["bun", ["test", "--isolate", "--only-failures", "--preload", "./happydom.ts", "./src"], { cwd: root }],
  ])
  assert.equal(result.code, 1)
  assert.deepEqual(result.failed, ["./src"])
})
