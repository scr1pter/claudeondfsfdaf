import { describe, expect, test } from "bun:test"
import { fnv1a64 } from "@vectordevai/core/review/fingerprint"
import {
  CHECK_COMMANDS,
  COVERAGE_COMMANDS,
  ENV_FILES,
  isCoverageCommand,
  reviewPermissionRules,
  SECRET_FILES,
} from "@vectordevai/core/review/permission"
import { Wildcard } from "@vectordevai/core/util/wildcard"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"

type Rule = PermissionV1.Rule

// The engine's semantics: session rules come after the agent's, and the last matching rule wins
// (Permission.evaluate); a tool is removed when the last rule for it is a "*" deny (Permission.disabled).
function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]) {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))
      ?.action ?? "ask"
  )
}

const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]

// The permission a tool asks with, as Permission.disabled maps it.
function permissionOf(tool: string) {
  if (["edit", "write", "apply_patch"].includes(tool)) return "edit"
  return MCP_RESOURCE_TOOLS.includes(tool) ? "read" : tool
}

function disabled(tool: string, rules: Rule[]) {
  const permission = permissionOf(tool)
  const rule = rules.findLast((item) => Wildcard.match(permission, item.permission))
  return rule?.pattern === "*" && rule.action === "deny"
}

// Shaped like the review agent's own rules, which allow reads and deny StructuredOutput until a session re-allows it.
const agent: Rule[] = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "bash", pattern: "git diff*", action: "allow" },
  { permission: "question", pattern: "*", action: "ask" },
]
const truncateGlob = "/home/user/.local/share/vector/tool-output/*"
const plain = reviewPermissionRules({ truncateGlob })
const checks = reviewPermissionRules({ checks: true, truncateGlob })
const all = (rules: Rule[]) => [...agent, ...rules]

describe("reviewPermissionRules", () => {
  test("keeps requester read denials after every reviewer allow", () => {
    const restricted = reviewPermissionRules({ readDenies: ["private/*", "*.env.example"] })
    expect(evaluate("read", "private/key.ts", agent, restricted)).toBe("deny")
    expect(evaluate("read", ".env.example", agent, restricted)).toBe("deny")
    expect(evaluate("read", "src/index.ts", agent, restricted)).toBe("allow")
    expect(evaluate("StructuredOutput", "*", agent, restricted)).toBe("allow")
    expect(reviewPermissionRules({ readDenies: [] })).toEqual(reviewPermissionRules({}))
  })
  test("re-allows StructuredOutput after the agent's deny", () => {
    expect(evaluate("StructuredOutput", "*", agent)).toBe("deny")
    expect(evaluate("StructuredOutput", "*", agent, plain)).toBe("allow")
    expect(disabled("StructuredOutput", all(plain))).toBe(false)
  })

  test("removes the shell unless checks is set, and then allows only test and typecheck commands without flags", () => {
    expect(evaluate("bash", "git diff main", agent, plain)).toBe("deny")
    expect(evaluate("bash", "bun test", agent, plain)).toBe("deny")
    expect(disabled("bash", all(plain))).toBe(true)
    for (const command of [
      "bun test",
      "bun test test/review",
      "bun run typecheck",
      "pytest tests/test_auth.py",
      "go test ./...",
      "tsc --noEmit",
    ])
      expect([command, evaluate("bash", command, agent, checks)]).toEqual([command, "allow"])
    for (const command of [
      "curl x",
      "git diff main",
      "rm -rf /",
      "npx something",
      "bun testx",
      // Flags that run another program.
      "go test -exec sh ./...",
      "npm test --script-shell=sh",
      "cargo test --config target.x.runner=sh",
      "pytest -p evil",
      "bun test --preload ./x.ts",
      "bun test -r ./x.ts",
      "tsc --noEmit -p .",
    ])
      expect([command, evaluate("bash", command, agent, checks)]).toEqual([command, "deny"])
    expect(disabled("bash", all(checks))).toBe(false)
  })

  test("allows the read-only tools", () => {
    for (const tool of ["read", "grep", "glob", "list"]) {
      expect(evaluate(tool, "src/index.ts", agent, plain)).toBe("allow")
      expect(disabled(tool, all(plain))).toBe(false)
    }
  })

  test("denies reading secret files, at the root and nested", () => {
    for (const file of [
      ".env",
      "config/.env",
      ".env.local",
      "apps/web/.env.production",
      ".git/config",
      "sub/.git/HEAD",
      ".ssh/id_rsa",
      "../../.ssh/id_rsa",
      ".aws/credentials",
      "home/.aws/config",
      "keys/server.pem",
      "cert.key",
      "store.p12",
      ".npmrc",
      "packages/a/.npmrc",
    ])
      expect([file, evaluate("read", file, agent, plain)]).toEqual([file, "deny"])
  })

  test("allows .env.example and ordinary files", () => {
    for (const file of [
      ".env.example",
      "config/.env.example",
      "src/index.ts",
      ".github/workflows/ci.yml",
      ".gitignore",
    ])
      expect([file, evaluate("read", file, agent, plain)]).toEqual([file, "allow"])
  })

  test("denies every other tool, including ones added later", () => {
    for (const tool of [
      "webfetch",
      "websearch",
      "task",
      "edit",
      "write",
      "apply_patch",
      "question",
      "skill",
      "lsp",
      "todowrite",
      "doom_loop",
      "browser_interact",
      "computer_observe",
      "a_future_tool",
    ]) {
      expect([tool, evaluate(tool, "*", agent, plain)]).toEqual([tool, "deny"])
      expect([tool, disabled(tool, all(plain))]).toEqual([tool, true])
    }
  })

  // The engine gives list_mcp_resources, list_mcp_resource_templates and read_mcp_resource the read permission, with
  // `mcp:<server>:<uri>` patterns, so the read allow must not reach the user's MCP servers. The tools stay listed,
  // because the last read rule is not a "*" deny, but every ask they make is denied.
  test("denies reading MCP resources", () => {
    for (const tool of MCP_RESOURCE_TOOLS)
      for (const pattern of [
        "mcp:notes:*",
        "mcp:db:postgres://prod/users",
        "mcp:fs:file:///home/user/.config/x.env.example",
      ])
        for (const rules of [plain, checks])
          expect([tool, pattern, evaluate(permissionOf(tool), pattern, agent, rules)]).toEqual([tool, pattern, "deny"])
    expect(evaluate("read", "src/mcp.ts", agent, plain)).toBe("allow")
  })

  test("allows Truncate.GLOB and allowDirs outside the project, and no other directory", () => {
    expect(evaluate("external_directory", truncateGlob, agent, plain)).toBe("allow")
    expect(evaluate("external_directory", "/etc/*", agent, plain)).toBe("deny")
    expect(evaluate("external_directory", "/home/user/other/*", agent, plain)).toBe("deny")
    const dirs = reviewPermissionRules({ allowDirs: ["/tmp/review-head/", "C:\\work\\files", "/opt/cache/*"] })
    expect(evaluate("external_directory", "/tmp/review-head/*", dirs)).toBe("allow")
    expect(evaluate("external_directory", "C:\\work\\files\\*", dirs)).toBe("allow")
    expect(evaluate("external_directory", "/opt/cache/*", dirs)).toBe("allow")
    expect(evaluate("external_directory", truncateGlob, dirs)).toBe("deny")
  })

  // holdback.ts reuses both lists (VS-34a). The deny list is written out here, not built from them, so a change to
  // either fails this test.
  test("exports ENV_FILES and SECRET_FILES, and the read rules they make are unchanged", () => {
    const secretFiles = [
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
    ]
    const envFiles: readonly string[] = ENV_FILES
    const listed: readonly string[] = SECRET_FILES
    expect(envFiles).toEqual(["*.env", "*.env.*"])
    expect(listed).toEqual(secretFiles)
    const read = (pattern: string, action: Rule["action"]): Rule => ({ permission: "read", pattern, action })
    expect(plain.filter((rule) => rule.permission === "read")).toEqual([
      read("*", "allow"),
      read("*.env", "deny"),
      read("*.env.*", "deny"),
      read("*.env.example", "allow"),
      ...secretFiles.map((pattern) => read(pattern, "deny")),
      read("mcp:*", "deny"),
    ])
  })

  test("starts with the deny and ends with StructuredOutput, so nothing can ask", () => {
    expect(plain[0]).toEqual({ permission: "*", pattern: "*", action: "deny" })
    expect(plain.at(-1)).toEqual({ permission: "StructuredOutput", pattern: "*", action: "allow" })
    expect(plain.some((rule) => rule.action === "ask")).toBe(false)
    expect(plain.some((rule) => rule.permission === "bash")).toBe(false)
    expect(reviewPermissionRules({})).toHaveLength(plain.length - 1)
  })

  // VS-30c exports CHECK_COMMANDS for the executor and adds COVERAGE_COMMANDS beside it. Neither changes a rule: these
  // digests were printed from reviewPermissionRules at 213aabe9, before the edit.
  test("the rules are byte-identical to before VS-30c", () => {
    const digest = (input: Parameters<typeof reviewPermissionRules>[0]) =>
      fnv1a64(JSON.stringify(reviewPermissionRules(input)))
    expect(digest({ truncateGlob })).toBe("03ee3c8b157dfcba")
    expect(digest({ checks: true, truncateGlob })).toBe("907b31028ef0edd2")
    expect(digest({ allowDirs: ["/tmp/review-head/", "C:\\work\\files"], checks: true, truncateGlob })).toBe(
      "93945324ead2fea5",
    )
    expect(digest({})).toBe("10537fa7f8acdd1d")
  })
})

describe("the executor's command lists (VS-30)", () => {
  test("exports CHECK_COMMANDS frozen, with the twelve commands --checks allows", () => {
    expect(Object.isFrozen(CHECK_COMMANDS)).toBe(true)
    expect([...CHECK_COMMANDS]).toEqual([
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
    ])
    // Each one is allowed bare and with arguments under --checks, and nowhere else.
    for (const command of CHECK_COMMANDS) {
      expect([command, evaluate("bash", command, agent, checks)]).toEqual([command, "allow"])
      expect([command, evaluate("bash", `${command} src`, agent, checks)]).toEqual([command, "allow"])
      expect([command, evaluate("bash", command, agent, plain)]).toEqual([command, "deny"])
    }
  })

  test("COVERAGE_COMMANDS holds Bun's exact coverage command, which the model's shell can never run", () => {
    expect(COVERAGE_COMMANDS).toEqual({
      bun: { command: "bun test --coverage --coverage-reporter=lcov", report: "coverage/lcov.info" },
    })
    expect(Object.isFrozen(COVERAGE_COMMANDS)).toBe(true)
    for (const entry of Object.values(COVERAGE_COMMANDS)) {
      expect(Object.isFrozen(entry)).toBe(true)
      // A test command with the flags coverage needs, so it extends --checks rather than adding a second path.
      expect(CHECK_COMMANDS.some((command) => entry.command.startsWith(`${command} -`))).toBe(true)
      // The flags are exactly what `* -*` denies the model, with --checks or without, and with directories allowed.
      for (const rules of [plain, checks, reviewPermissionRules({ allowDirs: ["/tmp/x"], checks: true, truncateGlob })])
        expect([entry.command, evaluate("bash", entry.command, agent, rules)]).toEqual([entry.command, "deny"])
    }
    for (const rules of [plain, checks]) expect(rules.some((rule) => rule.pattern.includes("--coverage"))).toBe(false)
  })

  // A coverage run's exit status is no pass or fail, so it must read as a coverage run however the executor extends it.
  test("isCoverageCommand matches a coverage command bare or with arguments, and nothing else", () => {
    for (const entry of Object.values(COVERAGE_COMMANDS)) {
      expect(isCoverageCommand(entry.command)).toBe(true)
      expect(isCoverageCommand(`${entry.command} test/x.test.ts`)).toBe(true)
      expect(isCoverageCommand(`${entry.command} -t "a name"`)).toBe(true)
      // A longer flag that only starts the same way is another command.
      expect(isCoverageCommand(`${entry.command}x`)).toBe(false)
      expect(isCoverageCommand(` ${entry.command}`)).toBe(false)
    }
    for (const command of [...CHECK_COMMANDS, "bun test test/x.test.ts", "bun test --coverage", ""])
      expect([command, isCoverageCommand(command)]).toEqual([command, false])
  })
})
