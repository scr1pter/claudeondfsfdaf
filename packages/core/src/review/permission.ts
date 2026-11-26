// Session permission rules for review sessions (section 3.6). Session rules come after the agent's own and the last
// matching rule wins, so the leading "*" deny removes every tool and every question, and the rules after it allow
// back only what a reviewer needs. Browser-safe: the imports are type-only.

import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import type { ReviewConfig } from "./types"

const READ_ONLY_TOOLS = ["read", "grep", "glob", "list"]

// The read tool asks with a path relative to the worktree, and Wildcard's `*` crosses `/`, so each directory has a
// root form (`.git/*`) and a nested one (`*/.git/*`). holdback.ts reads these lists, and CREDENTIAL_FILES below, to
// keep the same files out of the model payload (VS-34), and reviewPermissionRules denies them to the read tool; they
// are readonly so no importer can change what either does.
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

// VS-34's payload-only list: credential files the read tool allows unless holdback is "secrets", each basename in a
// root and a nested form as SECRET_FILES writes them, then four key-store suffixes. `id_ecdsa_sk` and `id_ed25519_sk`
// are OpenSSH's names for security-key private keys, beside the addendum's. holdback.ts holds a changed file on it back
// from the prompt; reviewPermissionRules denies it to the read tool under holdback "secrets" only (SF-14), so with the
// key unset the rules are what they were. grep reads each file through the same rules.
export const CREDENTIAL_FILES = Object.freeze([
  ...[
    ".envrc",
    ".netrc",
    ".pypirc",
    ".pgpass",
    ".htpasswd",
    "credentials",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ecdsa_sk",
    "id_ed25519",
    "id_ed25519_sk",
  ].flatMap((name) => [name, `*/${name}`]),
  "*.ppk",
  "*.pfx",
  "*.jks",
  "*.keystore",
])

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
// Under VS-34's holdback "secrets" (SF-14), and only then, the read tool is also denied CREDENTIAL_FILES and `held`:
// the paths Review.run held back from the prompt (a held file's path and old path, so a credential file renamed to
// `notes.txt` stays held), each as written, in NFC and as holdbackSpelling folds it. A held path is named by the
// change, so it becomes a pattern only with each `*` turned into `?`: Wildcard compiles `*` to `.*`, and a committed
// name such as `a*a*a*a*a*a*a*a*a*a*a*a*a*/.envrc` would then backtrack for seconds on every read the rule is checked
// against (I-2: the change cannot choose a pattern). `?` is one character, so it still matches the `*` in the real
// name, only widens the deny to names of the same length, and cannot backtrack; it also leaves no trailing " *" form.
// grep reads each file through these rules, and no rule is keyed on grep's pattern, so a search for `process.env`
// stays allowed. With the key unset or "off" the rules are what they were.
export function reviewPermissionRules(input: {
  allowDirs?: string[]
  checks?: boolean
  truncateGlob?: string
  readDenies?: readonly string[]
  holdback?: ReviewConfig["holdback"]
  held?: readonly string[]
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
    ...(input.holdback === "secrets"
      ? [
          ...new Set([
            ...CREDENTIAL_FILES,
            ...(input.held ?? [])
              .flatMap((file) => [file, file.normalize("NFC"), holdbackSpelling(file)])
              .map((file) => file.replaceAll("*", "?")),
          ]),
        ].map((pattern) => rule("read", pattern, "deny"))
      : []),
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
    ...(input.readDenies ?? []).map((pattern) => rule("read", pattern, "deny")),
  ]
}

// How holdback's rules and the read and grep tools' second check spell a path: forward slashes, NFC, lowercased. The
// credential lists are lowercase ASCII, and the held paths' folded forms are among the rules, so a tool that checks a
// path folded this way is refused it in any case and either Unicode normal form the platform's file system may hand
// back (macOS volumes ignore case, and HFS+ stores names in NFD).
export function holdbackSpelling(file: string) {
  return file.replaceAll("\\", "/").normalize("NFC").toLowerCase()
}

// Whether a session's rules are reviewPermissionRules' under holdback "secrets": they deny the read tool every
// CREDENTIAL_FILES pattern. The engine's session tools (session/tools.ts) read this rather than the review config, so
// the read, grep and glob tools redact what they return in exactly the review sessions Review.run gave these rules: a
// session's stored rules survive an engine restart and a compaction, which can fold the prompt's SCOPE metadata away,
// and another runner (the desktop's, SF-15) gets the tool half by passing the same rules.
export function holdsBack(rules: readonly PermissionV1.Rule[] | undefined) {
  return (
    rules !== undefined &&
    CREDENTIAL_FILES.every((pattern) =>
      rules.some((rule) => rule.permission === "read" && rule.pattern === pattern && rule.action === "deny"),
    )
  )
}
