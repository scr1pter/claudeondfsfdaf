// Session permission rules for review sessions (section 3.6). Session rules come after the agent's own and the last
// matching rule wins, so the leading "*" deny removes every tool and every question, and the rules after it allow
// back only what a reviewer needs. Browser-safe: the import is type-only.

import type { PermissionV1 } from "@vectordevai/core/v1/permission"

const READ_ONLY_TOOLS = ["read", "grep", "glob", "list"]

// The read tool asks with a path relative to the worktree, and Wildcard's `*` crosses `/`, so each directory has a
// root form (`.git/*`) and a nested one (`*/.git/*`). holdback.ts reads these lists to keep the same files out of the
// model payload (VS-34); they are readonly so no importer can change what the read tool denies.
export const ENV_FILES = ["*.env", "*.env.*"] as const

export const SECRET_FILES = [
  "*.pem",
  "*.key",
  "*.p12",
  ".ssh/*",
  "*/.ssh/*",
  ".aws/*",
  "*/.aws/*",
  ".git/*",
  "*/.git/*",
  "*.npmrc",
] as const

// Only for the opt-in local `--checks`: the project's test and typecheck commands, bare or with paths and test names,
// but never with a flag, because flags such as `go test -exec`, `npm test --script-shell`, `cargo test --config`,
// `pytest -p` and `bun test --preload` run any program. Every other command stays denied by the first rule. Exported
// and frozen for VS-30's executor, which will run only these and COVERAGE_COMMANDS; no runner code reads it but
// reviewPermissionRules yet.
export const CHECK_COMMANDS = Object.freeze([
  "bun test",
  "bun run test",
  "bun typecheck",
  "bun run typecheck",
  "npm test",
  "npm run test",
  "pnpm test",
  "pnpm run test",
  "yarn test",
  "pytest",
  "cargo test",
  "go test",
] as const)

// VS-30's coverage runs (contract §4 VS-30 item 2): one exact command per test runner, with the flags coverage needs,
// for the trusted executor alone and never for the model's shell. reviewPermissionRules does not read it, and under
// `--checks` its `* -*` rule still denies every one of them to the model. Nothing runs them yet: the executor lands
// after `self-evolving`, VS-12 and VS-18.
// - `report` is where Bun writes the report by default (probed with Bun 1.3.14). The project's bunfig.toml can move it
//   (`coverageDir`), change the reporters (`coverageReporter`) and add preloads, and the code under review controls
//   that file. So a missing or unreadable report means no coverage, never 0%, and the executor reads it only from
//   inside the worktree, with a byte cap.
// - The run's exit code is no pass or fail: with only the lcov reporter, Bun's coverage threshold check exits 0
//   whatever the threshold [evidence §5.2]. Coverage runs never feed runtimeVerdict (runtime.ts).
// - Another runner gets an entry only once its exact flags are verified: pytest needs a plugin for coverage, and
//   `go test`'s cover profile is not lcov.
export const COVERAGE_COMMANDS = Object.freeze({
  bun: Object.freeze({ command: "bun test --coverage --coverage-reporter=lcov", report: "coverage/lcov.info" }),
})
export type CoverageRunner = keyof typeof COVERAGE_COMMANDS

// Whether a command is one of COVERAGE_COMMANDS, bare or with the paths and test names the executor may add, so a
// coverage run never reads as a check result (runtime.ts runtimeVerdict, prompt.ts runtimeEvidenceBlock).
export function isCoverageCommand(command: string) {
  return Object.values(COVERAGE_COMMANDS).some(
    (entry) => command === entry.command || command.startsWith(`${entry.command} `),
  )
}

// A directory becomes the `<dir>/*` pattern external_directory asks with; a pattern that already ends in `*` is
// kept as it is.
function directoryPattern(dir: string) {
  const clean = dir.replaceAll("\\", "/").replace(/\/+$/, "")
  return clean.endsWith("*") ? clean : `${clean}/*`
}

// `truncateGlob` is the engine's Truncate.GLOB, where long tool output is saved for the reviewer to read back. Core
// cannot import it, so the engine passes it in.
export function reviewPermissionRules(input: {
  allowDirs?: string[]
  checks?: boolean
  truncateGlob?: string
}): PermissionV1.Rule[] {
  const rule = (permission: string, pattern: string, action: PermissionV1.Rule["action"]): PermissionV1.Rule => ({
    permission,
    pattern,
    action,
  })
  const outside = [input.truncateGlob, ...(input.allowDirs ?? [])]
    .filter((dir): dir is string => !!dir)
    .map(directoryPattern)
  return [
    rule("*", "*", "deny"),
    ...READ_ONLY_TOOLS.map((tool) => rule(tool, "*", "allow")),
    ...ENV_FILES.map((pattern) => rule("read", pattern, "deny")),
    rule("read", "*.env.example", "allow"),
    ...SECRET_FILES.map((pattern) => rule("read", pattern, "deny")),
    // The MCP resource tools ask for read with `mcp:<server>:<uri>`, so the read allow would reach the user's MCP
    // servers. This comes after the .env.example allow so no such pattern can be let back in.
    rule("read", "mcp:*", "deny"),
    ...outside.map((pattern) => rule("external_directory", pattern, "allow")),
    ...(input.checks
      ? [
          ...CHECK_COMMANDS.flatMap((command) => [
            rule("bash", command, "allow"),
            rule("bash", `${command} *`, "allow"),
          ]),
          rule("bash", "* -*", "deny"),
          rule("bash", "tsc --noEmit", "allow"),
        ]
      : []),
    rule("StructuredOutput", "*", "allow"),
  ]
}
