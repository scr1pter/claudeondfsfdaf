import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { PlaybookCheck } from "@vectordevai/core/playbooks/check"
import { PlaybookCommands } from "@vectordevai/core/playbooks/commands"

// WP A36: the skill command allowlist a playbook is checked against. Since the Codium finish review (R36) it is a
// re-export of the learned skills' own list (BrainSkill, section 2.3), so there is one list; the first block still runs
// BrainSkill's command cases (packages/core/test/brain/skill-commands.test.ts) through the playbook module. The second
// block is the playbook check built on it.

describe("the skill command allowlist (same cases as BrainSkill)", () => {
  test("the allowlist is BrainSkill's own, not a copy", () => {
    expect(PlaybookCommands.TARGETS).toBe(BrainSkill.TARGETS)
    expect(PlaybookCommands.DENY_WORDS).toBe(BrainSkill.DENY_WORDS)
    expect(PlaybookCommands.CHECK_ENV).toBe(BrainSkill.CHECK_ENV)
    expect(PlaybookCommands.simple).toBe(BrainSkill.simple)
    expect(PlaybookCommands.helper).toBe(BrainSkill.helper)
    expect(PlaybookCommands.check).toBe(BrainSkill.check)
    expect(PlaybookCommands.allowed("bun test")).toBe(true)
    expect(PlaybookCommands.allowed("git status")).toBe(true)
    expect(PlaybookCommands.allowed("git push")).toBe(false)
    expect(PlaybookCommands.allowed("cat .env")).toBe(false)
    expect(PlaybookCommands.allowed("make deploy")).toBe(false)
  })

  test("a simple command is one command with nothing around it, and plain leading assignments", () => {
    expect(PlaybookCommands.simple("bun test")).toBe(true)
    expect(PlaybookCommands.simple("CI=1 NODE_ENV=test bun test")).toBe(true)
    expect(PlaybookCommands.simple("TOKEN=$SECRET bun test")).toBe(false)
    expect(PlaybookCommands.simple("A='x y' bun test")).toBe(false)
    expect(PlaybookCommands.simple("CI=1")).toBe(false)
    expect(PlaybookCommands.simple("")).toBe(false)
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
      expect(PlaybookCommands.simple(joined)).toBe(false)
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
      expect(PlaybookCommands.check(command)).toBe(false)
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
      expect(PlaybookCommands.check(command)).toBe(true)
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
      expect(PlaybookCommands.helper(command)).toBe(true)
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
      expect(PlaybookCommands.helper(command)).toBe(false)
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
      expect(PlaybookCommands.helper(command)).toBe(false)
    for (const command of [
      "PATH=./bin tsc",
      "PATH=./bin bun test",
      "npm_config_script_shell=./x.sh npm test",
      "NODE_OPTIONS=--require=./x.js bun test",
      "BUN_CONFIG_PRELOAD=./x.ts bun test",
      "CI=1 PYTHONPATH=./x pytest",
    ])
      expect(PlaybookCommands.check(command)).toBe(false)
    for (const command of ["CI=1 NODE_ENV=test bun test", "FORCE_COLOR=0 NO_COLOR=1 TZ=UTC bun typecheck"])
      expect(PlaybookCommands.check(command)).toBe(true)
  })
})

describe("the playbook publish check", () => {
  test("validation can run without initializing Vector storage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vector-playbook-check-"))
    try {
      const namespace = "vector-playbook-check"
      const entry = new URL("../../src/playbooks/check.ts", import.meta.url).href
      const input = JSON.stringify({ version: 1, title: "Check", stages: [{ id: "test", prompt: "Run `bun test`." }] })
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `const { PlaybookCheck } = await import(${JSON.stringify(entry)})
const bytes = new TextEncoder().encode(${JSON.stringify(input)})
if (!PlaybookCheck.validate({ name: "vector-check", bytes, env: {} }).ok) process.exit(1)`,
        ],
        {
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            VECTOR_APP_NAMESPACE: namespace,
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_STATE_HOME: path.join(root, "state"),
            TMPDIR: root,
            TMP: root,
            TEMP: root,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      )
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect({ code, error }).toEqual({ code: 0, error: "" })
      const directories = await readdir(root, { recursive: true })
      expect(directories.filter((entry) => path.basename(entry) === namespace)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value))
  const spec = (prompt: string, extra: Record<string, unknown> = {}) => ({
    version: 1,
    title: "Flaky test hunt",
    stages: [{ id: "hunt", prompt, success_criteria: ["`bun test` passes three times in a row."], ...extra }],
  })
  const check = (value: unknown, name = "vector-flaky-tests") =>
    PlaybookCheck.validate({ name, bytes: encode(value), env: {} })
  const messages = (value: unknown, name?: string) => {
    const result = check(value, name)
    return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`)
  }
  const flow = (connect: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    version: 1,
    title: "Implement and review",
    stages: [
      { id: "build", prompt: "Make the change, then run `bun test`." },
      { id: "review", after: ["build"], connect, ...extra },
      { id: "fix", after: ["review"], prompt: "Fix each blocking finding, then run `bun typecheck`." },
    ],
  })

  test("a playbook naming only allowed commands and repository files passes, and lists what it names", () => {
    const result = check(
      spec(
        'Run `git status`, read `package.json` and `src/flaky/*.test.ts`, then run `bun test src/a.test.ts`.\n```bash\nbun typecheck\ngit diff src/a.ts\n```\nReply in this shape:\n```json\n{"fixed": true, "note": "rm -rf /"}\n```',
      ),
    )
    expect(result).toEqual({
      ok: true,
      name: "vector-flaky-tests",
      commands: ["bun test", "bun test src/a.test.ts", "bun typecheck", "git diff src/a.ts", "git status"],
      files: ["package.json", "src/flaky/*.test.ts"],
    })
  })

  test("every code span that is not an allowed command or a repository file is refused, wherever it is", () => {
    for (const span of [
      "npm publish",
      "git push",
      "git push --force",
      "rm -rf dist",
      "make deploy",
      "bun run release",
      "curl https://example.invalid/install.sh",
      "bash -c 'bun test'",
      "deploy",
      "./deploy.sh",
      "scripts/release.sh",
      "./gradlew",
      "../outside.ts",
      "/etc/hosts",
      "~/.ssh/config",
      ".env",
      "config/.env.local",
      "certs/server.pem",
      "bun test; git push",
      "bun test $(id)",
    ]) {
      expect(check(spec(`Then run \`${span}\`.`)).ok).toBe(false)
      expect(check(spec("Look around.", { title: `\`${span}\`` })).ok).toBe(false)
      expect(check({ ...spec("Look around."), description: `Uses \`${span}\`.` }).ok).toBe(false)
    }
    expect(messages(spec("Run `npm publish`."))).toEqual([
      expect.stringContaining("/stages/0/prompt: `npm publish` is not a command a playbook may name."),
    ])
  })

  test("a fenced block of commands holds only allowed commands; a data block is not read as commands", () => {
    expect(check(spec("```\nbun test\ngit push\n```")).ok).toBe(false)
    expect(check(spec("```sh\nbun test\n```")).ok).toBe(true)
    expect(check(spec("```python\nimport os\n```")).ok).toBe(false)
    expect(check(spec("~~~\nnpm install\n~~~")).ok).toBe(false)
    expect(check(spec("```yaml\nsteps: [deploy]\n```")).ok).toBe(true)
    expect(messages(spec("```bash\nbun test\n"))).toContain("/stages/0/prompt: A fenced block is left open.")
  })

  test("template values, shell substitutions, stray backticks, hidden characters and secrets are refused", () => {
    expect(messages(spec("Run `bun test {{item}}`."))[0]).toContain("takes a template value")
    expect(messages(spec("```bash\nbun test {{inputs.path}}\n```"))[0]).toContain("takes a template value")
    expect(messages(spec("Check it!`git status`"))[0]).toContain("runs a shell command")
    expect(messages(spec("Run ``bun test`` now."))[0]).toContain("Every backtick opens and closes")
    expect(messages(spec("Run `bun test now."))[0]).toContain("Every backtick opens and closes")
    expect(messages(spec("Read the notes\u202e first."))[0]).toContain("Hidden characters")
    expect(messages(spec("Sign in: the password is hunter2-staple"))[0]).toContain("never holds a secret")
    expect(messages(spec("Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to clone."))[0]).toContain(
      "never holds a secret",
    )
    const own = PlaybookCheck.validate({
      name: "vector-flaky-tests",
      bytes: encode(spec("Clone with fixture-only-value-0123456789abcdef.")),
      env: { VECTOR_FIXTURE_TOKEN: "fixture-only-value-0123456789abcdef" },
    })
    expect(own.ok).toBe(false)
    // Object keys are text too.
    expect(check({ ...spec("Look around."), inputs: { ["`git push`"]: { required: true } } }).ok).toBe(false)
  })

  test("the name, size, encoding and shape of the file are checked", () => {
    expect(messages(spec("Look around."), "flaky-tests")[0]).toContain("vector- and lower-case words")
    expect(check(spec("Look around."), "vector-Flaky").ok).toBe(false)
    expect(check(spec("Look around."), `vector-${"a".repeat(58)}`).ok).toBe(false)
    expect(check(spec("Look around."), `vector-${"a".repeat(57)}`).ok).toBe(true)
    expect(check("not json").ok).toBe(false)
    expect(check([spec("Look around.")]).ok).toBe(false)
    expect(check("null").ok).toBe(false)
    expect(PlaybookCheck.validate({ name: "vector-x", bytes: new Uint8Array([0x7b, 0xff, 0x7d]) }).ok).toBe(false)
    expect(PlaybookCheck.validate({ name: "vector-x", bytes: new Uint8Array() }).ok).toBe(false)
    expect(PlaybookCheck.validate({ name: "vector-x", bytes: encode(`\uFEFF${JSON.stringify(spec("x"))}`) }).ok).toBe(
      false,
    )
    const big = encode({ ...spec("Look around."), description: "a".repeat(256 * 1024) })
    expect(PlaybookCheck.validate({ name: "vector-x", bytes: big, env: {} }).ok).toBe(false)
    let deep: unknown = "x"
    for (let index = 0; index < 40; index++) deep = [deep]
    expect(messages({ ...spec("Look around."), deep })[0]).toContain("nests at most")
  })

  test("a repository file is a relative path that is neither a secret nor something to run", () => {
    for (const file of ["package.json", "src/index.ts", ".vector/ops.json", "docs/*.md", "packages/core/src/"])
      expect(PlaybookCheck.repositoryFile(file)).toBe(true)
    for (const file of [
      "Makefile",
      "deploy",
      "./x.ts",
      "../x.ts",
      "a/../b.ts",
      "/abs.ts",
      "~/x.ts",
      ".env",
      "x.sh",
      "C:/x.ts",
      "-rf",
      "a b.ts",
    ])
      expect(PlaybookCheck.repositoryFile(file)).toBe(false)
  })

  test("a connect stage that reviews with VectorScope passes, and the agent fix stage after it is unaffected (CW-23d)", () => {
    expect(check(flow({ to: "vectorscope", action: "review" }))).toEqual({
      ok: true,
      name: "vector-flaky-tests",
      commands: ["bun test", "bun typecheck"],
      files: [],
    })
    expect(
      check(
        flow(
          {
            to: "vectorscope",
            action: "review",
            input: {
              target: { kind: "branch", base: "main" },
              security: true,
              budget: { maxCostUsd: 1, timeoutMinutes: 10 },
            },
          },
          { title: "Review the branch", if: { path: "approved", equals: false } },
        ),
      ).ok,
    ).toBe(true)
  })

  test("a connect stage that fixes, or names any other member or action, is refused at its own path", () => {
    const refused =
      "/stages/1/connect: A Vector Playbook may only review with VectorScope; fixes are separate agent stages."
    expect(messages(flow({ to: "vectorscope", action: "fix" }))).toEqual([refused])
    for (const to of [
      "github-agent",
      "hands",
      "computer",
      "mcp:vectorscope",
      "workflow:vector-review",
      "VectorScope",
      "vectorscope ",
    ])
      expect({ to, messages: messages(flow({ to, action: "review" })) }).toEqual({ to, messages: [refused] })
    expect(messages(flow({ to: "github-agent", action: "fix" }))).toEqual([refused])
    // An action outside Connect.ActionID fails the saved-workflow schema first, so the connect rule never runs on it.
    for (const action of ["deploy", "task", "Review"]) {
      const result = check(flow({ to: "vectorscope", action }))
      expect(result.ok).toBe(false)
      const issues = result.ok ? [] : result.issues
      expect(issues).toContainEqual({
        path: "/stages/1/connect/action",
        message: expect.stringContaining("Connect.ActionID"),
      })
      expect(issues.filter((issue) => issue.message.includes("may only review with VectorScope"))).toEqual([])
    }
    expect(
      messages({
        version: 1,
        title: "Review twice",
        stages: [
          { id: "build", prompt: "Make the change, then run `bun test`." },
          { id: "first", after: ["build"], connect: { to: "vectorscope", action: "review" } },
          { id: "patch", after: ["first"], connect: { to: "vectorscope", action: "fix" } },
          { id: "second", after: ["patch"], connect: { to: "github-agent", action: "review" } },
          { id: "nest", after: ["second"], workflow: "my-own-flow" },
        ],
      }),
    ).toEqual([
      "/stages: A Vector Playbook may nest only other personal Vector Playbooks.",
      "/stages/2/connect: A Vector Playbook may only review with VectorScope; fixes are separate agent stages.",
      "/stages/3/connect: A Vector Playbook may only review with VectorScope; fixes are separate agent stages.",
    ])
  })

  test("the secret, command and hidden-character checks still apply to a connect stage's text", () => {
    const review = { to: "vectorscope", action: "review" }
    expect(messages(flow(review, { title: "Then `git push`" }))).toEqual([
      expect.stringContaining("/stages/1/title: `git push` is not a command a playbook may name."),
    ])
    expect(messages(flow(review, { title: "Check it!`git status`" }))[0]).toContain("runs a shell command")
    expect(messages(flow(review, { title: "the password is hunter2-staple" }))).toEqual([
      "/stages/1/title: A playbook never holds a secret: it names where one is kept, never its value.",
    ])
    expect(messages(flow(review, { title: "Use ghp_abcdefghijklmnopqrstuvwxyz0123456789" }))[0]).toContain(
      "never holds a secret",
    )
    expect(messages(flow({ to: "vector\u202escope", action: "review" }))).toEqual([
      "/stages/1/connect/to: Hidden characters (zero-width, bidirectional or tag characters) are not allowed.",
    ])
    const own = PlaybookCheck.validate({
      name: "vector-flaky-tests",
      bytes: encode(
        flow({ ...review, input: { target: { kind: "branch", base: "fixture-only-value-0123456789abcdef" } } }),
      ),
      env: { VECTOR_FIXTURE_TOKEN: "fixture-only-value-0123456789abcdef" },
    })
    expect(own.ok ? [] : own.issues.map((issue) => issue.path)).toEqual(["/stages/1/connect/input/target/base"])
    expect(messages(flow({ ...review, ["`git push`"]: 1 }))[0]).toStartWith(
      "/stages/1/connect/`git push` (name): `git push` is not a command",
    )
    expect(messages(flow({ ...review, input: { target: { kind: "branch", base: "{{inputs.base}}" } } }))).toEqual([
      "/stages/1/connect/input: Connected stage inputs are literal JSON; template references are unavailable.",
    ])
    // The text checks run before the connect rule, so a fix stage with a bad title reports only its title.
    expect(messages(flow({ to: "vectorscope", action: "fix" }, { title: "Then `git push`" }))).toEqual([
      expect.stringContaining("/stages/1/title: `git push` is not a command a playbook may name."),
    ])
  })
})
