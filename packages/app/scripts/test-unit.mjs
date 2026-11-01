import { spawn } from "node:child_process"
import { readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const directory = fileURLToPath(new URL("..", import.meta.url))
const argumentsBeforePath = ["test", "--isolate", "--only-failures", "--preload", "./happydom.ts"]

/** Mirrors Bun 1.3.14's Scanner.test_name_suffixes and default JavaScript-like loaders. */
export async function unitFiles(root = directory) {
  const seen = new Set()
  const files = []
  async function walk(folder) {
    const canonical = await realpath(folder)
    if (seen.has(canonical)) return
    seen.add(canonical)
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, entry.name)
      const kind = entry.isSymbolicLink() ? await stat(absolute) : entry
      if (kind.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name.toLowerCase() === "node_modules") continue
        await walk(absolute)
        continue
      }
      if (!kind.isFile() || !/(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i.test(entry.name))
        continue
      files.push(`./${path.relative(root, absolute).split(path.sep).join("/")}`)
    }
  }
  await walk(path.join(root, "src"))
  return files.sort()
}

export function runProcess(command, args, options, runtime = { spawn, setTimeout, clearTimeout }) {
  return new Promise((resolve) => {
    const { timeout, ...spawnOptions } = options
    const child = runtime.spawn(command, args, { ...spawnOptions, stdio: "inherit" })
    const state = { settled: false, timedOut: false }
    const finish = (result) => {
      if (state.settled) return
      state.settled = true
      if (timer !== undefined) runtime.clearTimeout(timer)
      resolve(result)
    }
    const timer =
      timeout === undefined
        ? undefined
        : runtime.setTimeout(() => {
            if (state.settled) return
            state.timedOut = true
            child.kill("SIGKILL")
            // Await close before the launcher admits the next child; a timed-out file can never report success.
          }, timeout)
    child.once("error", (error) => finish({ code: 1, error: error.message }))
    child.once("close", (code, signal) =>
      finish(state.timedOut ? { code: 1, signal, error: `Timed out after ${timeout} ms` } : { code, signal }),
    )
  })
}

/** Fresh Bun processes on Windows contain the observed isolate-runner crash without retries or omitted files. */
export async function runUnitTests({
  platform = process.platform,
  root = directory,
  run = runProcess,
  log = console.log,
} = {}) {
  const files = platform === "win32" ? await unitFiles(root) : ["./src"]
  if (!files.length) throw new Error("No app unit test files found under ./src")
  const failed = []
  for (const file of files) {
    log(`App unit test: ${file}`)
    const result = await Promise.resolve()
      // A passing Vite fixture retained its Windows Bun process for 49 minutes. Bound the child lifecycle,
      // without changing Bun's per-test deadlines, retrying files or truncating the Linux aggregate suite.
      .then(() =>
        run("bun", [...argumentsBeforePath, file], {
          cwd: root,
          ...(platform === "win32" ? { timeout: 120_000 } : {}),
        }),
      )
      .catch((error) => ({
        code: 1,
        error: error instanceof Error ? error.message : "The test process could not start.",
      }))
    if (result.code === 0 && !result.signal) continue
    failed.push(file)
    log(`App unit test failed: ${file} (${result.error ?? result.signal ?? `exit ${result.code}`})`)
  }
  if (platform === "win32") log(`App unit tests: ${files.length - failed.length}/${files.length} files passed`)
  if (failed.length) log(`Failed app unit paths:\n${failed.join("\n")}`)
  return { code: failed.length ? 1 : 0, files, failed }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = (await runUnitTests()).code
  } catch (error) {
    console.error(error instanceof Error ? error.message : "The app unit test launcher failed.")
    process.exitCode = 1
  }
}
