import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

// The Codium CI lane (.github/workflows/vector-codium.yml) picks its test files here, so no work package has a list
// to keep. It runs:
// - the hosted API suite in test/, where most of Codium is built;
// - every test whose path names Codium (Codium, model plans, model top-ups);
// - every test file the branch added or changed since it left main.
// Each file runs in its own Bun process from the package that owns it: a crash names its file, and one file's module
// mocks cannot reach the next. Browser specs (Playwright, packages/app/e2e) are picked by the same rule. The Stripe
// test-mode checks in packages/web/e2e/codium run only in vector-codium-e2e.yml.

export const CODIUM_PATH = /codium|model[-_]?plans?|model[-_]?topups?/i

const UNIT_TEST = /^(?:test|packages)\/.+\.test\.tsx?$/
// End-to-end checks, fixtures and build output are not unit tests, even when they end in .test.ts.
const NOT_UNIT = new Set(["node_modules", "e2e", "fixture", "fixtures", "dist"])
const BROWSER_SPEC = /^packages\/app\/e2e\/.+\.spec\.tsx?$/
// The same files packages/app/playwright.config.ts ignores: they need their own configs.
const BROWSER_IGNORED = [/^packages\/app\/e2e\/performance\//, /\/public-share-viewer\.spec\.tsx?$/]

const BROWSER_DIRECTORY = "packages/app"

export function selectUnitTests(tracked: readonly string[], changed: readonly string[]) {
  const touched = new Set(changed)
  return tracked
    .filter((file) => UNIT_TEST.test(file) && !file.split("/").some((part) => NOT_UNIT.has(part)))
    .filter((file) => file.startsWith("test/") || CODIUM_PATH.test(file) || touched.has(file))
    .sort()
}

export function selectBrowserSpecs(tracked: readonly string[], changed: readonly string[]) {
  const touched = new Set(changed)
  return tracked
    .filter((file) => BROWSER_SPEC.test(file) && !BROWSER_IGNORED.some((pattern) => pattern.test(file)))
    .filter((file) => CODIUM_PATH.test(file) || touched.has(file))
    .sort()
}

/** The nearest directory with a package.json or bunfig.toml: its test preloads and settings apply to the file. */
export function owningDirectory(file: string, exists: (relative: string) => boolean) {
  let directory = path.posix.dirname(file)
  while (directory !== ".") {
    if (exists(`${directory}/package.json`) || exists(`${directory}/bunfig.toml`)) return directory
    directory = path.posix.dirname(directory)
  }
  throw new Error(`No package owns ${file}`)
}

/** Bun arguments that run one test file from its owning directory, as that package's own test script would. */
export function unitCommand(file: string, directory: string) {
  const target = `./${path.posix.relative(directory, file)}`
  const options = ["--timeout", "30000"]
  // The app's unit and browser-condition suites each run isolated (packages/app/package.json test:unit, test:browser).
  if (directory === "packages/app") options.push("--isolate")
  if (directory === "packages/app" && target.startsWith("./test-browser/")) options.push("--conditions=browser")
  // Desktop tests never read a developer's .env files (packages/desktop/scripts/test.ts).
  if (directory === "packages/desktop") return ["--no-env-file", "test", ...options, target]
  return ["test", ...options, target]
}

/** Playwright arguments for the app's default config, which starts the app's own dev server against fixtures. */
export function browserCommand(specs: readonly string[]) {
  return ["run", "test:e2e", ...specs.map((spec) => path.posix.relative(BROWSER_DIRECTORY, spec))]
}

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`)
  return result.stdout
    .toString()
    .split(/[\0\n]/)
    .filter(Boolean)
}

async function run(command: string[], cwd: string, label: string) {
  const grouped = process.env.CI === "true"
  console.log(grouped ? `::group::${label}` : `\n${label}`)
  const status = await Bun.spawn(command, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited
  if (grouped) console.log("::endgroup::")
  if (status !== 0) console.log(grouped ? `::error title=Codium test failed::${label}` : `Failed: ${label}`)
  return status
}

async function main(argv: readonly string[]) {
  const root = path.resolve(import.meta.dir, "../../..")
  const exists = (relative: string) => existsSync(path.join(root, relative))
  const tracked = git(root, "ls-files", "-z")
  // CI checks the branch out with its whole history, so the fork point with main is known.
  const base = process.env.CODIUM_CI_BASE || "origin/main"
  const fork = git(root, "merge-base", base, "HEAD")[0]
  if (!fork) throw new Error(`No merge base between ${base} and HEAD; fetch ${base} first.`)
  const changed = git(root, "diff", "--name-only", "-z", fork, "HEAD")

  if (argv.includes("--browser")) {
    const specs = selectBrowserSpecs(tracked, changed)
    if (argv.includes("--list")) {
      for (const spec of specs) console.log(spec)
      return 0
    }
    if (!specs.length) {
      console.log("No Codium browser specs on this branch.")
      return 0
    }
    return run([process.execPath, ...browserCommand(specs)], path.join(root, BROWSER_DIRECTORY), "Playwright")
  }

  const files = selectUnitTests(tracked, changed)
  if (argv.includes("--list")) {
    for (const file of files) console.log(file)
    return 0
  }
  if (!files.length) throw new Error("No Codium test files found")
  const owners = new Map(files.map((file) => [file, owningDirectory(file, exists)]))

  // Desktop packaging fixtures need the locked Electron runtime, as packages/desktop/scripts/test.ts installs it.
  if ([...owners.values()].includes("packages/desktop")) {
    const desktop = path.join(root, "packages/desktop")
    const installer = createRequire(path.join(desktop, "package.json")).resolve("electron/install.js")
    const status = await run([process.execPath, "--no-env-file", installer], desktop, "Electron runtime")
    if (status !== 0) return status
  }

  const failed: string[] = []
  for (const [file, directory] of owners) {
    const status = await run([process.execPath, ...unitCommand(file, directory)], path.join(root, directory), file)
    if (status !== 0) failed.push(file)
  }
  console.log(`\nCodium: ${files.length - failed.length}/${files.length} test files passed`)
  if (failed.length) console.error(`Failed test files:\n${failed.join("\n")}`)
  return failed.length ? 1 : 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
