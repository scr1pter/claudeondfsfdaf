import { describe, expect, test } from "bun:test"
import { fnv1a64 } from "@vectordevai/core/review/fingerprint"
import {
  CHECK_COMMANDS,
  COVERAGE_COMMANDS,
  CREDENTIAL_FILES,
  ENV_FILES,
  holdbackSpelling,
  holdsBack,
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

// VS-34's tool half (SF-14): under holdback "secrets", and only then, the read tool is denied the payload-only
// credential list and the paths Review.run held back. grep reads each file through the same rules and has no rule of
// its own keyed on a path, so a search for process.env stays allowed.
describe("holdback's read rules (VS-34, SF-14)", () => {
  const read = (pattern: string): Rule => ({ permission: "read", pattern, action: "deny" })
  const secrets = reviewPermissionRules({ truncateGlob, holdback: "secrets" })

  test("unset or off, the rules are byte-identical to before, held paths or not", () => {
    const digest = (input: Parameters<typeof reviewPermissionRules>[0]) =>
      fnv1a64(JSON.stringify(reviewPermissionRules(input)))
    // The goldens printed at 213aabe9 (VS-30c's test above), with holdback off and with held paths it ignores.
    expect(digest({ truncateGlob, holdback: "off" })).toBe("03ee3c8b157dfcba")
    expect(digest({ truncateGlob, holdback: "off", held: ["notes.txt"] })).toBe("03ee3c8b157dfcba")
    expect(digest({ truncateGlob, held: ["notes.txt"] })).toBe("03ee3c8b157dfcba")
    expect(digest({ checks: true, truncateGlob, holdback: "off" })).toBe("907b31028ef0edd2")
    expect(digest({ holdback: "off" })).toBe("10537fa7f8acdd1d")
  })

  test("secrets adds exactly the credential denies, after the secret files and before the MCP deny", () => {
    const at = plain.findIndex((rule) => rule.permission === "read" && rule.pattern === "mcp:*")
    expect(secrets).toEqual([...plain.slice(0, at), ...CREDENTIAL_FILES.map(read), ...plain.slice(at)])
    expect(secrets.length - plain.length).toBe(CREDENTIAL_FILES.length)
    // With checks, directories and requester denials too: only the added denies differ, and the requester's stay last.
    const input = { allowDirs: ["/tmp/review-head"], checks: true, truncateGlob, readDenies: ["private/*"] }
    const unset = reviewPermissionRules(input)
    const set = reviewPermissionRules({ ...input, holdback: "secrets" })
    expect(set.filter((rule) => !CREDENTIAL_FILES.map(read).some((added) => Bun.deepEquals(added, rule)))).toEqual(
      unset,
    )
    expect(set.at(-1)).toEqual(read("private/*"))
  })

  test("exports the payload-only list frozen, each basename in a root and a nested form", () => {
    expect(Object.isFrozen(CREDENTIAL_FILES)).toBe(true)
    const names = [".envrc", ".netrc", ".pypirc", ".pgpass", ".htpasswd", "credentials"]
    const keys = ["id_rsa", "id_dsa", "id_ecdsa", "id_ecdsa_sk", "id_ed25519", "id_ed25519_sk"]
    expect([...CREDENTIAL_FILES]).toEqual([
      ...[...names, ...keys].flatMap((name) => [name, `*/${name}`]),
      "*.ppk",
      "*.pfx",
      "*.jks",
      "*.keystore",
    ])
    // None was already denied: SECRET_FILES is unchanged, and the lists share no pattern.
    expect(CREDENTIAL_FILES.some((pattern) => (SECRET_FILES as readonly string[]).includes(pattern))).toBe(false)
  })

  test("denies the credential files at the root and nested under secrets, and only then", () => {
    for (const file of [
      ".envrc",
      "config/prod/.envrc",
      "config/.envrc",
      ".netrc",
      "deploy/.netrc",
      "home/user/.pypirc",
      ".pgpass",
      "web/.htpasswd",
      "credentials",
      "gcloud/credentials",
      "id_rsa",
      "keys/id_ed25519_sk",
      "putty.ppk",
      "certs/app.pfx",
      "android/release.jks",
      "release.keystore",
    ]) {
      expect([file, evaluate("read", file, agent, secrets)]).toEqual([file, "deny"])
      expect([file, evaluate("read", file, agent, plain)]).toEqual([file, "allow"])
    }
    // Look-alikes stay readable, and so does the .env.example exemption.
    for (const file of ["src/envrc.ts", "credentials.ts", "docs/credentials.md", "id_rsa.pub", ".env.example"])
      expect([file, evaluate("read", file, agent, secrets)]).toEqual([file, "allow"])
  })

  test("grep keeps its own allow, so a search for process.env stays allowed", () => {
    for (const pattern of ["process.env", "process\\.env\\.[A-Z_]+", ".envrc", "id_rsa"])
      expect([pattern, evaluate("grep", pattern, agent, secrets)]).toEqual([pattern, "allow"])
    expect(secrets.filter((rule) => rule.permission === "grep")).toEqual(
      plain.filter((rule) => rule.permission === "grep"),
    )
  })

  test("denies every held path, as written and folded, after the .env.example allow", () => {
    const held = reviewPermissionRules({
      truncateGlob,
      holdback: "secrets",
      held: ["notes.txt", "Docs/Keys.TXT", "config/x.env.example", ".envrc"],
    })
    for (const file of ["notes.txt", "Docs/Keys.TXT", "docs/keys.txt", "config/x.env.example"])
      expect([file, evaluate("read", file, agent, held)]).toEqual([file, "deny"])
    expect(evaluate("read", "src/notes.txt", agent, held)).toBe("allow")
    // A held path already on the list adds no second rule, and the rest add one per spelling.
    expect(held.length - secrets.length).toBe(4)
    // A held path's `*` becomes `?`: the real name is denied, and the deny widens only to names of its length.
    const starred = reviewPermissionRules({ holdback: "secrets", held: ["data/*.txt", "Data/* *"] })
    expect(evaluate("read", "data/*.txt", agent, starred)).toBe("deny")
    expect(evaluate("read", "data/x.txt", agent, starred)).toBe("deny")
    expect(evaluate("read", "data/other.txt", agent, starred)).toBe("allow")
    expect(evaluate("read", "Data/* *", agent, starred)).toBe("deny")
    // No trailing " *" form is left, which Wildcard would read as "this, or this and any arguments".
    expect(evaluate("read", "Data/*", agent, starred)).toBe("allow")
    expect(starred.filter((rule) => rule.pattern.includes("*") && !CREDENTIAL_FILES.includes(rule.pattern))).toEqual(
      reviewPermissionRules({ holdback: "secrets" }).filter(
        (rule) => rule.pattern.includes("*") && !CREDENTIAL_FILES.includes(rule.pattern),
      ),
    )
  })

  // A held path is named by the change. With `*` as Wildcard's `.*`, a committed name such as this one compiled to a
  // pattern that backtracked for 1.6 s on one 40-character read and 50 s on a 48-character one; as `?` it cannot.
  test("a starred held path cannot make a read deny backtrack", () => {
    const name = "a*a*a*a*a*a*a*a*a*a*a*a*a*/.envrc"
    const starred = reviewPermissionRules({ holdback: "secrets", held: [name] })
    const start = performance.now()
    for (const input of ["a".repeat(64), `${"a".repeat(58)}/.envr`, "a/".repeat(32)])
      expect([input, evaluate("read", input, agent, starred)]).toEqual([input, "allow"])
    expect(performance.now() - start).toBeLessThan(50)
    expect(evaluate("read", name, agent, starred)).toBe("deny")
  })

  // The tools check a path again folded as holdbackSpelling folds it, so a held non-ASCII name is refused in either
  // Unicode normal form (macOS HFS+ hands back NFD, a model may type either) and in any case.
  test("denies a held non-ASCII path in either normal form, as the tools fold it", () => {
    const nfc = "Docs/\u00c9-Notes.txt"
    const nfd = "Docs/E\u0301-Notes.txt"
    expect(nfc).not.toBe(nfd)
    for (const held of [nfc, nfd]) {
      const rules = reviewPermissionRules({ holdback: "secrets", held: [held] })
      // As written and in NFC, for the ask; folded, for the tools' second check.
      for (const spelled of [held, nfc])
        expect([held, spelled, evaluate("read", spelled, agent, rules)]).toEqual([held, spelled, "deny"])
      for (const spelled of [nfc, nfd, nfc.toLowerCase(), nfd.toUpperCase(), "DOCS\\\u00c9-NOTES.TXT"])
        expect([held, spelled, evaluate("read", holdbackSpelling(spelled), agent, rules)]).toEqual([
          held,
          spelled,
          "deny",
        ])
      expect(evaluate("read", holdbackSpelling("Docs/E-Notes.txt"), agent, rules)).toBe("allow")
    }
    expect(holdbackSpelling("Config\\.ENVRC")).toBe("config/.envrc")
  })

  test("holdsBack tells holdback's rules from every other set, the finalizer's included", () => {
    expect(holdsBack(secrets)).toBe(true)
    expect(holdsBack(reviewPermissionRules({ holdback: "secrets", held: ["notes.txt"], checks: true }))).toBe(true)
    // The finalizer appends a deny-all and the StructuredOutput allow (run.ts), which keep the denies.
    expect(
      holdsBack([
        ...secrets,
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "StructuredOutput", pattern: "*", action: "allow" },
      ]),
    ).toBe(true)
    for (const rules of [plain, checks, reviewPermissionRules({ holdback: "off" }), [], undefined])
      expect(holdsBack(rules)).toBe(false)
    // Every pattern counts: one missing, or allowed instead, and the rules do not hold back.
    expect(holdsBack(secrets.filter((rule) => rule.pattern !== "*/id_rsa"))).toBe(false)
    expect(
      holdsBack(secrets.map((rule) => (rule.pattern === "*.keystore" ? { ...rule, action: "allow" as const } : rule))),
    ).toBe(false)
    expect(holdsBack(secrets.map((rule) => (rule.pattern === ".envrc" ? { ...rule, permission: "edit" } : rule)))).toBe(
      false,
    )
  })
})
