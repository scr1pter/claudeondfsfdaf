import { describe, expect, test } from "bun:test"
import { BrainSkill } from "@vectordevai/core/brain/skill"

// The commands a learned skill may name (section 2.3): one simple command each, read-only helpers from a short list,
// and one check that never deploys, publishes or migrates. Anything else would run unasked under the shell's defaults.

describe("BrainSkill commands", () => {
  test("a simple command is one command with nothing around it, and plain leading assignments", () => {
    expect(BrainSkill.simple("bun test")).toBe(true)
    expect(BrainSkill.simple("CI=1 NODE_ENV=test bun test")).toBe(true)
    expect(BrainSkill.simple("TOKEN=$SECRET bun test")).toBe(false)
    expect(BrainSkill.simple("A='x y' bun test")).toBe(false)
    expect(BrainSkill.simple("CI=1")).toBe(false)
    expect(BrainSkill.simple("")).toBe(false)
    for (const joined of [
      "bun test; rm -rf x",
      "bun test && git push",
      "bun test | tee out",
      "bun test > out",
      "bun test < in",
      "echo `id`",
      "echo $(id)",
      "cat a\\ b",
      "bun test\nrm -rf x",
      "!`x`",
    ])
      expect(BrainSkill.simple(joined)).toBe(false)
  })

  test("checks: deploy-like goals, compound commands and other programs are refused", () => {
    for (const command of [
      "make deploy",
      "mvn deploy",
      "npm run release",
      "bun run build && git push",
      "make test-db",
      "rm -fr x",
      "find . -delete",
      "bash -c 'bun test'",
      "node -e 'process.exit(0)'",
      "git diff --output=x",
      "rg --pre cat foo",
      "cat /etc/passwd",
      "cat .env",
      "!`x`",
      "$ARGUMENTS",
      "bun test $1",
      "npm run publish:docs",
      "cargo build --release",
      "make",
      "npm run dev",
      "DB_URL=x bun test",
    ])
      expect(BrainSkill.check(command)).toBe(false)
  })

  test("checks: scripts, bare checkers and task runners whose goals are all checks", () => {
    for (const command of [
      "bun typecheck",
      "bun run test:unit",
      "bun test src/brain/skill.test.ts",
      "npm test",
      "pnpm run lint",
      "yarn verify",
      "deno test",
      "cargo clippy",
      "cargo test",
      "./gradlew check",
      "gradle build",
      "xcodebuild test",
      "xcodebuild test -scheme App",
      "go test ./...",
      "go vet ./...",
      "CI=1 bun test",
      "bunx tsc --noEmit",
      "npx vitest run",
      "pnpm exec eslint .",
      "pytest -q",
      "tsgo --noEmit",
    ])
      expect(BrainSkill.check(command)).toBe(true)
  })

  test("helpers: read-only programs on files inside the repository, without flags that write or run", () => {
    for (const command of [
      "git diff src/x.ts",
      "git status",
      "git log -5 --oneline",
      "git show HEAD",
      "rg foo src",
      "grep -rn foo src",
      "cat src/index.ts",
      "head -40 README.md",
      "ls packages/core",
      "wc -l src/a.ts",
    ])
      expect(BrainSkill.helper(command)).toBe(true)
    for (const command of [
      "git diff --output=x",
      "git diff --no-index .env README.md",
      "git diff --ext-diff",
      "git difftool",
      "git push",
      "git checkout -- .",
      "git -C .. diff",
      "rg --pre cat foo",
      "rg --pre=cat foo",
      "rg --hostname-bin x foo",
      "grep -o foo src",
      "cat /etc/passwd",
      "cat ../outside.txt",
      "cat ~/.ssh/id_rsa",
      "cat .env",
      "cat config/.env.local",
      "head src/server.pem",
      "rm -fr x",
      "find . -delete",
      "bun test",
      "cat a; rm b",
      "C:/Users/me/x",
    ])
      expect(BrainSkill.helper(command)).toBe(false)
  })

  test("helpers never take a leading assignment, and checks only inert ones: the environment can pick the program", () => {
    for (const command of [
      "GIT_EXTERNAL_DIFF=./x.sh git diff",
      "GIT_CONFIG_GLOBAL=./c git diff",
      "GIT_PAGER=./x git log",
      "RIPGREP_CONFIG_PATH=./rgrc rg foo",
      "PATH=./bin ls",
      "CI=1 git status",
    ])
      expect(BrainSkill.helper(command)).toBe(false)
    for (const command of [
      "PATH=./bin tsc",
      "PATH=./bin bun test",
      "npm_config_script_shell=./x.sh npm test",
      "NODE_OPTIONS=--require=./x.js bun test",
      "BUN_CONFIG_PRELOAD=./x.ts bun test",
      "CI=1 PYTHONPATH=./x pytest",
    ])
      expect(BrainSkill.check(command)).toBe(false)
    for (const command of ["CI=1 NODE_ENV=test bun test", "FORCE_COLOR=0 NO_COLOR=1 TZ=UTC bun typecheck"])
      expect(BrainSkill.check(command)).toBe(true)
  })

  test("a check's target is the command without its flags or quotes", () => {
    expect(BrainSkill.target("bun test --isolate 'a.test.ts'")).toBe("bun test a.test.ts")
    expect(BrainSkill.target("  BUN   Typecheck ")).toBe("bun typecheck")
  })
})
