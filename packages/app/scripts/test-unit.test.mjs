import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { runProcess, runUnitTests, unitFiles } from "./test-unit.mjs"

function processes() {
  const children = []
  const timers = new Map()
  const state = { now: 0 }
  const runtime = {
    spawn(command, args, options) {
      assert.ok(
        children.every((child) => child.closed),
        "the previous child must close before another starts",
      )
      const child = new EventEmitter()
      child.closed = false
      child.kills = []
      child.command = command
      child.args = args
      child.options = options
      child.kill = (signal) => {
        child.kills.push(signal)
        return true
      }
      child.once("close", () => {
        child.closed = true
      })
      child.once("error", () => {
        child.closed = true
      })
      children.push(child)
      return child
    },
    setTimeout(callback, ms) {
      const timer = { at: state.now + ms, callback }
      timers.set(timer, timer)
      return timer
    },
    clearTimeout(timer) {
      timers.delete(timer)
    },
  }
  function advance(ms) {
    state.now += ms
    for (const timer of [...timers.values()]) {
      if (timer.at > state.now) continue
      timers.delete(timer)
      timer.callback()
    }
  }
  return { runtime, children, timers, advance }
}

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
    assert.deepEqual(call.options, { cwd: root, timeout: 120_000 })
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

test("Linux runs the complete inventory once in serial order and reports every failure without retry", async (t) => {
  const root = await fixture(t, [
    "src/z.test.ts",
    "src/b.test.ts",
    "src/a.test.ts",
    "src/c.test.ts",
    "src/d.test.ts",
    "src/e.test.ts",
  ])
  const calls = []
  const output = []
  let active = 0
  const result = await runUnitTests({
    platform: "linux",
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
      if (args.at(-1) === "./src/e.test.ts") return { code: 0, signal: "SIGILL" }
      return { code: 0 }
    },
  })
  const expected = [
    "./src/a.test.ts",
    "./src/b.test.ts",
    "./src/c.test.ts",
    "./src/d.test.ts",
    "./src/e.test.ts",
    "./src/z.test.ts",
  ]
  assert.deepEqual(
    calls.map((call) => call.args.at(-1)),
    expected,
  )
  assert.deepEqual(result.files, expected)
  assert.equal(new Set(calls.map((call) => call.args.at(-1))).size, expected.length)
  assert.equal(result.code, 1)
  assert.deepEqual(result.failed, expected.slice(0, -1))
  for (const call of calls) {
    assert.equal(call.command, "bun")
    assert.deepEqual(call.args.slice(0, -1), ["test", "--isolate", "--only-failures", "--preload", "./happydom.ts"])
    assert.deepEqual(call.options, { cwd: root })
  }
  assert.ok(output.includes("App unit test failed: ./src/e.test.ts (SIGILL)"))
  assert.ok(output.includes("App unit tests: 1/6 files passed"))
})

test("all Linux files passing produces success after each file runs once", async (t) => {
  const root = await fixture(t, ["src/b.test.ts", "src/a.test.ts"])
  const calls = []
  const result = await runUnitTests({
    platform: "linux",
    root,
    log: () => {},
    run: async (_command, args, options) => {
      assert.deepEqual(options, { cwd: root })
      calls.push(args.at(-1))
      return { code: 0 }
    },
  })
  assert.equal(result.code, 0)
  assert.deepEqual(result.failed, [])
  assert.deepEqual(calls, ["./src/a.test.ts", "./src/b.test.ts"])
})

test("macOS preserves the one whole-source invocation and reports its failure", async (t) => {
  const root = await fixture(t, ["src/a.test.ts", "src/b.test.ts"])
  const calls = []
  const result = await runUnitTests({
    platform: "darwin",
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

test("the child deadline waits for close and cannot turn a raced zero exit into success", async () => {
  const fake = processes()
  const result = runProcess(
    "bun",
    ["test", "./src/example.test.ts"],
    { cwd: "/virtual", timeout: 120_000 },
    fake.runtime,
  )
  let settled = false
  void result.then(() => {
    settled = true
  })
  fake.advance(119_999)
  assert.deepEqual(fake.children[0].kills, [])
  fake.advance(1)
  assert.deepEqual(fake.children[0].kills, ["SIGKILL"])
  await Promise.resolve()
  assert.equal(settled, false)
  fake.children[0].emit("close", 0, null)
  assert.deepEqual(await result, { code: 1, signal: null, error: "Timed out after 120000 ms" })
  assert.equal(fake.timers.size, 0)
})

test("normal completion cancels the watchdog and its stale callback cannot kill a later process", async () => {
  const fake = processes()
  const result = runProcess("bun", ["test"], { cwd: "/virtual", timeout: 120_000 }, fake.runtime)
  const timer = [...fake.timers.values()][0]
  fake.children[0].emit("close", 0, null)
  assert.deepEqual(await result, { code: 0, signal: null })
  assert.equal(fake.timers.size, 0)
  timer.callback()
  fake.advance(120_000)
  assert.deepEqual(fake.children[0].kills, [])
})

test("a spawn error clears the child deadline", async () => {
  const fake = processes()
  const result = runProcess("bun", ["test"], { cwd: "/virtual", timeout: 120_000 }, fake.runtime)
  fake.children[0].emit("error", new Error("Synthetic spawn failure"))
  assert.deepEqual(await result, { code: 1, error: "Synthetic spawn failure" })
  fake.advance(120_000)
  assert.equal(fake.timers.size, 0)
  assert.deepEqual(fake.children[0].kills, [])
})

test("Windows reports a timed-out file as failed then runs the next file once", async (t) => {
  const root = await fixture(t, ["src/a.test.ts", "src/z.test.ts"])
  const fake = processes()
  const output = []
  const result = await runUnitTests({
    platform: "win32",
    root,
    log: (line) => output.push(line),
    run(command, args, options) {
      const pending = runProcess(command, args, options, fake.runtime)
      const child = fake.children.at(-1)
      queueMicrotask(() => {
        if (args.at(-1) === "./src/a.test.ts") {
          fake.advance(120_000)
          assert.equal(fake.children.length, 1)
          assert.deepEqual(child.kills, ["SIGKILL"])
          child.emit("close", null, "SIGKILL")
          return
        }
        child.emit("close", 0, null)
      })
      return pending
    },
  })
  assert.equal(result.code, 1)
  assert.deepEqual(result.failed, ["./src/a.test.ts"])
  assert.deepEqual(
    fake.children.map((child) => child.args.at(-1)),
    ["./src/a.test.ts", "./src/z.test.ts"],
  )
  assert.ok(output.includes("App unit test failed: ./src/a.test.ts (Timed out after 120000 ms)"))
  assert.ok(output.includes("App unit tests: 1/2 files passed"))
})

test("an unbounded aggregate process receives no child watchdog", async () => {
  const fake = processes()
  const result = runProcess("bun", ["test", "./src"], { cwd: "/virtual" }, fake.runtime)
  assert.equal(fake.timers.size, 0)
  fake.advance(120_000)
  assert.deepEqual(fake.children[0].kills, [])
  fake.children[0].emit("close", 0, null)
  assert.deepEqual(await result, { code: 0, signal: null })
})
