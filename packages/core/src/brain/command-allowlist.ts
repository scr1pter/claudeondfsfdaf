import { SECRET_FILE } from "./document/secret-file"

/** The goals a check may run: a script whose first segment is one of these, or a task runner's goals. */
export const TARGETS: readonly string[] = ["test", "lint", "typecheck", "build", "check", "verify"]

/** No word or word segment of a check may be one of these: `make deploy`, `npm run release`, `make test-db`. */
export const DENY_WORDS: readonly string[] = [
  "deploy",
  "publish",
  "release",
  "push",
  "upload",
  "install",
  "migrate",
  "db",
]

/**
 * One command and nothing around it: no `;`, `&`, `|`, `$`, backtick, `<`, `>`, `\`, newline or `!`, so no second
 * command, substitution, redirect or `$ARGUMENTS` can ride along. Leading `NAME=value` assignments may set plain values.
 */
export function simple(command: string) {
  if (/[;&|$`<>\\\n\r!]/.test(command)) return false
  const split = parts(command)
  return split.words.length > 0 && split.env.every((word) => /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.:/-]*$/.test(word))
}

/**
 * A read-only helper: `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg` or `git diff|status|log|show`, with no flag that
 * writes a file, runs another program or reads outside the repository's tree, and no argument that is absolute, climbs
 * out with `..` or `~`, or names a secrets file. Never with a leading `NAME=value`: the environment can name a program
 * to run or a file to load as well as a flag can (`GIT_EXTERNAL_DIFF`, `GIT_CONFIG_GLOBAL`, `RIPGREP_CONFIG_PATH`,
 * `PATH=./bin`), and a read-only helper needs none.
 */
export function helper(command: string) {
  if (!simple(command)) return false
  const split = parts(command)
  if (split.env.length > 0) return false
  const words = split.words.map(unquote)
  const program = words[0]!
  if (!HELPERS.has(program) && !(program === "git" && GIT.has(words[1] ?? ""))) return false
  const text = ` ${words.join(" ")}`
  if (WRITES.some((flag) => text.includes(flag))) return false
  return words
    .slice(1)
    .every(
      (word) =>
        !RUNS.some((flag) => word === flag || word.startsWith(`${flag}=`)) &&
        [word, word.slice(word.indexOf("=") + 1)].every(
          (value) =>
            !value.startsWith("/") &&
            !/^[A-Za-z]:/.test(value) &&
            !value.includes("..") &&
            !value.includes("~") &&
            !SECRET_FILE.test(value),
        ),
    )
}

/**
 * A check: a package-manager script whose first segment is a target (`bun typecheck`, `bun run test:unit`), a bare
 * checker (`tsc`, `pytest`, through `bunx` or `npx` too), or a task runner whose every goal is a target or the runner's
 * own check verb (`cargo clippy`, `./gradlew check`). Never one with a deploy-like word anywhere in it, and leading
 * assignments only of the inert names in `CHECK_ENV`: `PATH`, `NODE_OPTIONS` or `npm_config_*` would change what runs.
 */
export function check(command: string) {
  if (!simple(command)) return false
  const split = parts(command)
  if (!split.env.every((word) => CHECK_ENV.has(word.slice(0, word.indexOf("="))))) return false
  const words = split.words.map(unquote)
  const segments = [...split.env, ...words].flatMap((word) => word.toLowerCase().split(/[^a-z0-9]+/))
  if (segments.some((segment) => DENY_WORDS.includes(segment))) return false
  return script(words) || checker(words) || task(words)
}

/** The environment names a check may set: none of them names a program, a path or code to load. */
export const CHECK_ENV: ReadonlySet<string> = new Set([
  "CI",
  "NODE_ENV",
  "FORCE_COLOR",
  "NO_COLOR",
  "TZ",
  "LANG",
  "LC_ALL",
  "TERM",
])

const HELPERS: ReadonlySet<string> = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg"])
const GIT: ReadonlySet<string> = new Set(["diff", "status", "log", "show"])
// The read-only verification commands' denied flags (agent.ts readonlyBashDenies): they write a chosen file, run
// another program or read any file.
const WRITES = [
  "--output",
  "--no-index",
  "--ext-diff",
  "--extcmd",
  "--basetemp",
  "--junit",
  "outfile",
  " -o",
  "git difftool",
]
// rg flags that run a program on every file it reads.
const RUNS = ["--pre", "--pre-glob", "--hostname-bin"]
const SCRIPTS: ReadonlySet<string> = new Set(["bun", "npm", "pnpm", "yarn", "deno"])
const CHECKERS: ReadonlySet<string> = new Set([
  "tsc",
  "tsgo",
  "vitest",
  "jest",
  "pytest",
  "mypy",
  "pyright",
  "ruff",
  "eslint",
  "biome",
  "oxlint",
  "rspec",
  "phpunit",
])
const RUNNERS: Readonly<Record<string, readonly string[]>> = {
  make: [],
  mvn: [],
  gradle: [],
  "./gradlew": [],
  xcodebuild: ["build-for-testing", "test-without-building"],
  cargo: ["clippy", "nextest"],
  go: ["vet"],
  dotnet: [],
  swift: [],
  mix: [],
}

function parts(command: string) {
  const words = command.trim().split(/\s+/).filter(Boolean)
  const start = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  return { env: start < 0 ? words : words.slice(0, start), words: start < 0 ? [] : words.slice(start) }
}

function unquote(word: string) {
  return word.replace(/["']/g, "")
}

function script(words: readonly string[]) {
  if (!SCRIPTS.has(words[0]!)) return false
  const name = words[1] === "run" ? words[2] : words[1]
  return name !== undefined && TARGETS.includes(name.split(/[:\-_.]/)[0]!)
}

function checker(words: readonly string[]) {
  const via =
    words[0] === "bunx" || words[0] === "npx"
      ? 1
      : (words[0] === "pnpm" || words[0] === "yarn") && words[1] === "exec"
        ? 2
        : 0
  return CHECKERS.has(words[via] ?? "")
}

// Every goal of a task runner must be a target: a word that is a flag, a path (`./...`) or, for xcodebuild, a flag's
// value (`-scheme App`) is not a goal.
function task(words: readonly string[]) {
  const verbs = RUNNERS[words[0]!]
  if (!verbs) return false
  const goals = words
    .slice(1)
    .filter(
      (word, index, rest) =>
        !word.startsWith("-") &&
        !word.includes("/") &&
        !word.startsWith(".") &&
        !(words[0] === "xcodebuild" && rest[index - 1]?.startsWith("-")),
    )
  return goals.length > 0 && goals.every((goal) => TARGETS.includes(goal) || verbs.includes(goal))
}
