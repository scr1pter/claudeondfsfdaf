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
// `pytest -p` and `bun test --preload` run any program. Every other command stays denied by the first rule.
const CHECK_COMMANDS = [
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
]

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
