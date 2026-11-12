import { describe, expect, test } from "bun:test"
import path from "path"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { buildWorkflowYaml, WORKFLOW_FILE } from "@vectordevai/core/review/workflow"

const COMMANDS = ["/vector", "/vs", "/vectorscope", "/vx"]
// Characters actions/upload-artifact refuses in an artifact name.
const ARTIFACT_FORBIDDEN = /[":<>|*?\\/\r\n]/

describe("the module", () => {
  // The hosted API loads it by relative path on Node, so it may reach no other file. scanImports reports the required
  // namespace self-export but leaves out type-only imports and re-exports, so the code is also read without comments.
  test("imports nothing; its only from clause is its own namespace export", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../src/github-agents.ts")).text()
    expect(new Bun.Transpiler({ loader: "ts" }).scanImports(source)).toEqual([
      { kind: "import-statement", path: "./github-agents.js" },
    ])
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    expect(code.match(/\bimport\b|\brequire\s*\(/g)).toBeNull()
    expect(Array.from(code.matchAll(/\bfrom\s*["']([^"']*)["']/g), (match) => match[1])).toEqual(["./github-agents.js"])
  })
})

describe("mentions", () => {
  test("the App handle goes first when the slug is valid", () => {
    expect(GithubAgents.mentions()).toEqual(COMMANDS)
    expect(GithubAgents.mentions("vector-fixture")).toEqual(["@vector-fixture", ...COMMANDS])
    const longest = `a${"-".repeat(98)}b`
    expect(GithubAgents.mentions(longest)).toEqual([`@${longest}`, ...COMMANDS])
  })

  // An "@name" notifies whichever GitHub account holds the name, so anything GitHub would not issue as an App slug is
  // never mentioned.
  test("an invalid slug is ignored", () => {
    const invalid = ["", "a", "-x", "x-", "Vector", "vec tor", "a@b", "vector[bot]", "x\n", `a${"b".repeat(100)}`]
    expect(invalid.map((slug) => GithubAgents.mentions(slug))).toEqual(invalid.map(() => COMMANDS))
  })

  test("every call returns a list of its own", () => {
    const first = GithubAgents.mentions("vector-fixture")
    first.push("@someone")
    first[1] = "/changed"
    expect(GithubAgents.mentions("vector-fixture")).toEqual(["@vector-fixture", ...COMMANDS])
    expect(GithubAgents.mentions()).toEqual(COMMANDS)
    expect(GithubAgents.COMMAND_MENTIONS).toEqual(["/vector", "/vs"])
    expect(GithubAgents.LEGACY_MENTIONS).toEqual(["/vectorscope", "/vx"])
  })
})

describe("slugFromInstallUrl", () => {
  const url = "https://github.com/apps/vector-fixture/installations/new"

  test("reads the slug of GitHub's install page, which mentions then puts first", () => {
    expect(GithubAgents.slugFromInstallUrl(url)).toBe("vector-fixture")
    expect(GithubAgents.mentions(GithubAgents.slugFromInstallUrl(url))[0]).toBe("@vector-fixture")
  })

  test("refuses every other address", () => {
    const hostile = [
      url.replace("https:", "http:"),
      url.replace("github.com", "github.com.evil.test"),
      url.replace("github.com", "evil.test/github.com"),
      `https://evil.test/?next=${url}`,
      url.replace("https://", "https://user@"),
      url.replace("github.com", "github.com:443"),
      url.replace("github.com", "GITHUB.com"),
      url.replace("vector-fixture", "Vector-Fixture"),
      url.replace("vector-fixture", "x"),
      url.replace("vector-fixture", "vector%2Dfixture"),
      url.replace("vector-fixture", "vector-fixture%2Fextra"),
      url.replace("/apps/", "/apps/../apps/"),
      url.replace("/installations/", "/extra/installations/"),
      `${url}?state=x`,
      `${url}#x`,
      `${url}/`,
      ` ${url}`,
      `${url}\n`,
      "",
      undefined,
    ]
    expect(hostile.map((entry) => GithubAgents.slugFromInstallUrl(entry))).toEqual(hostile.map(() => undefined))
  })
})

describe("the Actions guard", () => {
  test("only GITHUB_ACTIONS=true is an Actions runner", () => {
    expect(GithubAgents.onActionsRunner({ GITHUB_ACTIONS: "true" })).toBe(true)
    const others = [{ GITHUB_ACTIONS: "false" }, { GITHUB_ACTIONS: "1" }, { GITHUB_ACTIONS: "TRUE" }, {}]
    expect(others.map((env) => GithubAgents.onActionsRunner(env))).toEqual(others.map(() => false))
  })

  // The ids are the ones the engine's tools are defined with (tool/browser.ts, vector-cloud.ts, research-browser.ts),
  // which the registry filters on, and the registry's keys, which the contract names.
  test("bridged and computer tools are withheld, close names are not", () => {
    const withheld = [
      "browser",
      "vector_cloud",
      "research_browser",
      "vectorcloud",
      "researchbrowser",
      "computer",
      "computer-x",
      "Computer_use",
      "COMPUTER",
      "computer_click",
    ]
    const offered = [
      "computers",
      "computer.x",
      "mycomputer",
      "use_computer",
      "research_read",
      "researchread",
      "research",
      "browser_x",
      "shell",
    ]
    expect(withheld.filter((id) => !GithubAgents.withheldOnActions(id))).toEqual([])
    expect(offered.filter((id) => GithubAgents.withheldOnActions(id))).toEqual([])
  })

  // What the engine asks of an MCP server's or tool's own name: the pattern alone, so a `browser` server is not withheld.
  test("computer use by name is the pattern alone, without the bridged tool ids", () => {
    const computer = ["computer", "computer-x", "Computer_use", "COMPUTER", "computer_click"]
    const other = ["browser", "vector_cloud", "research_browser", "computers", "computer.x", "use_computer", "desktop"]
    expect(computer.filter((name) => !GithubAgents.computerUse(name))).toEqual([])
    expect(other.filter((name) => GithubAgents.computerUse(name))).toEqual([])
  })
})

describe("run ids", () => {
  test("the largest GitHub ids still give a run id in Codium's grammar", () => {
    const largest = "9".repeat(20)
    const id = GithubAgents.runId(largest, largest, largest, largest)
    expect(id).toBe(`gh-${largest}-${largest}-${largest}-${largest}`)
    expect(id.length).toBe(86)
    expect(id).toMatch(GithubAgents.RUN_ID_PATTERN)
    const safe = Number.MAX_SAFE_INTEGER
    expect(GithubAgents.runId(safe, safe, 1, "1")).toBe(`gh-${safe}-${safe}-1-1`)
    expect(GithubAgents.runId(1, 2, 3, 4)).toBe("gh-1-2-3-4")
  })

  test("anything but a positive decimal id throws, in every position", () => {
    const invalid = [
      ...["0", "01", "-1", "+1", "1.5", "1e3", "0x1f", " 1", "1\n", "1:2", "", "1".repeat(21)],
      ...[0, -1, 1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY],
    ]
    invalid.forEach((bad) =>
      [0, 1, 2, 3].forEach((position) => {
        const ids = ["1", "1", "1", "1"].map((id, index): string | number => (index === position ? bad : id))
        expect(() => GithubAgents.runId(ids[0], ids[1], ids[2], ids[3])).toThrow(RangeError)
      }),
    )
  })

  test("the pattern is Codium's grammar, which refuses a lone dash", () => {
    const valid = ["gh-1-1-1-1", "a", "-x", "--", "A.b_c-9", "x".repeat(128)]
    const invalid = ["-", "", "x".repeat(129), "gh:1", "gh 1", "gh/1", "gh-1\n", "gh-é"]
    expect(valid.filter((id) => !GithubAgents.RUN_ID_PATTERN.test(id))).toEqual([])
    expect(invalid.filter((id) => GithubAgents.RUN_ID_PATTERN.test(id))).toEqual([])
  })
})

describe("threads and artifacts", () => {
  const valid = [
    "1",
    "9".repeat(10),
    "dispatch-1",
    `dispatch-${"9".repeat(20)}`,
    "schedule-deadbeef",
    "schedule-0a1b2c3d",
  ]

  test("a thread is an issue or pull request number, a dispatch or a schedule", () => {
    const invalid = [
      "0",
      "01",
      "1".repeat(11),
      "dispatch-0",
      "dispatch-01",
      `dispatch-${"1".repeat(21)}`,
      "schedule-DEADBEEF",
      "schedule-deadbee",
      "schedule-deadbeef0",
      "1|dispatch-1",
      "|",
      "1\n",
      " 1",
      "pr-1",
      "",
    ]
    expect(valid.filter((thread) => !GithubAgents.THREAD_PATTERN.test(thread))).toEqual([])
    expect(invalid.filter((thread) => GithubAgents.THREAD_PATTERN.test(thread))).toEqual([])
  })

  test("artifact names built from valid threads and run ids are names actions/upload-artifact accepts", () => {
    const names = [
      ...valid.map((thread) => GithubAgents.sessionArtifact(thread)),
      GithubAgents.bundleArtifact("99999999999", "2"),
      GithubAgents.bundleArtifact(123, 1),
    ]
    expect(names.filter((name) => ARTIFACT_FORBIDDEN.test(name))).toEqual([])
    expect(GithubAgents.sessionArtifact("12")).toBe("vector-session-12")
    expect(GithubAgents.bundleArtifact(123, 1)).toBe("vector-run-123-1")
    expect(GithubAgents.BUNDLE_FILES).toEqual(["patch.diff", "summary.json"])
  })
})

describe("credentials", () => {
  test("secret-shaped names match by suffix", () => {
    const secrets = [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "AWS_SESSION_TOKEN",
      "HF_TOKEN",
      "ACTIONS_RUNTIME_TOKEN",
      "DEEPSEEK_KEY",
      "OPENROUTER_API_KEY",
      "CLIENT_SECRET",
      "DB_PASSWORD",
    ]
    const others = ["TOKEN", "MONKEY", "PATH", "KEYS", "VECTOR_SECRET_CHANNEL", "GITHUB_TOKEN_URL", "X_TOKEN|"]
    expect(secrets.filter((name) => !GithubAgents.SECRET_NAME_PATTERN.test(name))).toEqual([])
    expect(others.filter((name) => GithubAgents.SECRET_NAME_PATTERN.test(name))).toEqual([])
    // Case-sensitive, so callers that treat names case-insensitively match the upper-cased name.
    expect(GithubAgents.SECRET_NAME_PATTERN.test("my_token")).toBe(false)
    expect(GithubAgents.SECRET_NAME_PATTERN.test("my_token".toUpperCase())).toBe(true)
  })

  // INV-S5: the engine in the sandbox starts with these names only, so none may carry a credential or reach the
  // runner's file commands.
  test("the sandbox allowlist is exactly the contract's and carries no credential", () => {
    const allow: readonly string[] = GithubAgents.SANDBOX_ENV_ALLOW
    expect([...allow].sort()).toEqual(
      [
        "PATH",
        "LANG",
        "LC_ALL",
        "TZ",
        "CI",
        "GITHUB_ACTIONS",
        "GITHUB_REPOSITORY",
        "GITHUB_REPOSITORY_ID",
        "GITHUB_REPOSITORY_OWNER",
        "GITHUB_EVENT_NAME",
        "GITHUB_EVENT_PATH",
        "GITHUB_RUN_ID",
        "GITHUB_RUN_ATTEMPT",
        "GITHUB_SHA",
        "GITHUB_REF",
        "GITHUB_SERVER_URL",
        "GITHUB_API_URL",
        "GITHUB_WORKSPACE",
        "RUNNER_OS",
        "MENTIONS",
        "MODEL",
        "SHARE",
        "VECTOR_SHARE_CONSENT",
        "VECTOR_MODE",
        "VECTOR_THREAD",
        "VECTOR_PROMPT",
        "VECTOR_SCHEDULE_PROMPTS",
        "VECTOR_WORKFLOW_VERSION",
        "VECTOR_DISABLE_USAGE",
        "VECTOR_PURE",
        "VECTOR_DISABLE_PROJECT_CONFIG",
        "VECTOR_RUN_DEADLINE",
        "VECTOR_RUN_ID",
        "VECTOR_BUNDLE_DIR",
        "VECTOR_SECRET_CHANNEL",
        "HOME",
        "RUNNER_TEMP",
      ].sort(),
    )
    expect(new Set(allow).size).toBe(allow.length)
    const credentials = [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "VECTOR_CLI_TOKEN",
      "VECTOR_BIND_CODE",
      "VECTOR_TICKET",
      "VECTOR_RUN_TOKEN",
      "VECTOR_SECRET_ENV_NAMES",
      "GITHUB_ENV",
      "GITHUB_PATH",
      "GITHUB_OUTPUT",
      "GITHUB_STATE",
    ]
    expect(
      allow.filter(
        (name) =>
          credentials.includes(name) || name.startsWith("ACTIONS_") || GithubAgents.SECRET_NAME_PATTERN.test(name),
      ),
    ).toEqual([])
  })
})

describe("shared names", () => {
  test("the review workflow and installed App workflows use the same file and job names", () => {
    expect(WORKFLOW_FILE).toBe(GithubAgents.WORKFLOW_FILE)
    expect(GithubAgents.WORKFLOW_FILE).toBe(".github/workflows/vector.yml")
    // api/_lib/github-app.ts picks an App token's permissions by these job names.
    const workflow = Bun.YAML.parse(
      buildWorkflowYaml({
        provider: "openai",
        model: "gpt-4.1",
        keys: ["OPENAI_API_KEY"],
        autoReview: false,
        auth: "app",
        version: "1.17.14",
      }),
    ) as { jobs: Record<string, { name?: string }> }
    expect(workflow.jobs.vector_app?.name).toBe(GithubAgents.JOB.legacyTask)
    expect(workflow.jobs.review_app?.name).toBe(GithubAgents.JOB.review)
    expect(GithubAgents.JOB).toEqual({
      agent: "Vector agent",
      publish: "Vector publish",
      review: "Vector review",
      bind: "Vector bind",
      legacyTask: "Vector task",
    })
  })

  test("workflow versions compare as numbers", () => {
    expect(GithubAgents.WORKFLOW_VERSION).toMatch(/^[1-9]\d*$/)
    expect(GithubAgents.MIN_CODIUM_WORKFLOW_VERSION).toBe(3)
    expect(Number(GithubAgents.WORKFLOW_VERSION)).toBeGreaterThanOrEqual(GithubAgents.MIN_CODIUM_WORKFLOW_VERSION)
  })

  test("every endpoint is /api/cloud-agents/<kebab-case name>, and each audience is its endpoint's address", () => {
    const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    expect(Object.keys(GithubAgents.ENDPOINT).sort()).toEqual(
      ["bindCode", "bind", "bindings", "unbind", "mint", "heartbeat", "settle", "runs", "artifactKey"].sort(),
    )
    expect(
      Object.entries(GithubAgents.ENDPOINT).filter(([name, route]) => route !== `/api/cloud-agents/${kebab(name)}`),
    ).toEqual([])
    expect(GithubAgents.AUDIENCE).toEqual({
      mint: `https://vectordev.ai${GithubAgents.ENDPOINT.mint}`,
      bind: `https://vectordev.ai${GithubAgents.ENDPOINT.bind}`,
    })
  })
})

describe("numbers", () => {
  // Sections 1.3 and 1.4, decisions O8 and O12, INV-S8 and INV-C7.
  test("match the contract", () => {
    expect({
      HEARTBEAT_SECONDS: GithubAgents.HEARTBEAT_SECONDS,
      IDLE_SECONDS: GithubAgents.IDLE_SECONDS,
      MIN_LEFT_SECONDS: GithubAgents.MIN_LEFT_SECONDS,
      STOP_MARGIN_SECONDS: GithubAgents.STOP_MARGIN_SECONDS,
      SETTLE_GRACE_SECONDS: GithubAgents.SETTLE_GRACE_SECONDS,
      CONCURRENCY_RETRY_MS: GithubAgents.CONCURRENCY_RETRY_MS,
      AT_ONCE_WAIT_MS: GithubAgents.AT_ONCE_WAIT_MS,
      AT_ONCE_POLL_MS: GithubAgents.AT_ONCE_POLL_MS,
      BIND_CODE_SECONDS: GithubAgents.BIND_CODE_SECONDS,
      TICKET_SECONDS: GithubAgents.TICKET_SECONDS,
      TIMEOUT_MIN: GithubAgents.TIMEOUT_MIN,
      PATCH_LIMITS: GithubAgents.PATCH_LIMITS,
      RUN_LOGIN_DAYS: GithubAgents.RUN_LOGIN_DAYS,
      RUNS_KEPT: GithubAgents.RUNS_KEPT,
      SESSION_DAYS: GithubAgents.SESSION_DAYS,
      BUNDLE_DAYS: GithubAgents.BUNDLE_DAYS,
    }).toEqual({
      HEARTBEAT_SECONDS: 60,
      IDLE_SECONDS: 600,
      MIN_LEFT_SECONDS: 300,
      STOP_MARGIN_SECONDS: 180,
      SETTLE_GRACE_SECONDS: 15 * 60,
      CONCURRENCY_RETRY_MS: 15 * 60_000,
      AT_ONCE_WAIT_MS: 10 * 60_000,
      AT_ONCE_POLL_MS: 30_000,
      BIND_CODE_SECONDS: 10 * 60,
      TICKET_SECONDS: 15 * 60,
      TIMEOUT_MIN: { codiumAgent: 135, ownKeyAgent: 60, publish: 15, bind: 5, route: 3, review: 20 },
      PATCH_LIMITS: {
        bytes: 8_000_000,
        files: 2_000,
        fileBytes: 10_000_000,
        summaryBytes: 262_144,
        sessionBytes: 20_000_000,
      },
      RUN_LOGIN_DAYS: 90,
      RUNS_KEPT: 200,
      SESSION_DAYS: 7,
      BUNDLE_DAYS: 1,
    })
  })

  test("fit together", () => {
    // Ultra's longest run (120 minutes, section 1.1) still fits in the Codium agent job after the full at-once wait.
    expect(GithubAgents.TIMEOUT_MIN.codiumAgent * 60_000).toBeGreaterThanOrEqual(
      120 * 60_000 + GithubAgents.AT_ONCE_WAIT_MS,
    )
    // The shortest run a mint allows still runs after the engine's early stop.
    expect(GithubAgents.STOP_MARGIN_SECONDS).toBeLessThan(GithubAgents.MIN_LEFT_SECONDS)
    // One late heartbeat never settles a live run as idle.
    expect(GithubAgents.IDLE_SECONDS).toBeGreaterThanOrEqual(2 * GithubAgents.HEARTBEAT_SECONDS)
    expect(GithubAgents.AT_ONCE_WAIT_MS % GithubAgents.AT_ONCE_POLL_MS).toBe(0)
  })
})

describe("statuses, outcomes and stop codes", () => {
  test("mint statuses are the section 2.9.1 column", () => {
    const statuses: GithubAgents.MintStatus[] = [
      "ok",
      "not-bound",
      "suspended",
      "update-required",
      "binding-unavailable",
      "not-in-plan",
      "service-off",
      "source-unavailable",
      "runner",
      "hours",
      "at-once",
      "scheduled",
      "denied",
      "needs-app",
      "unavailable",
    ]
    expect([...GithubAgents.MINT_STATUS]).toEqual(statuses)
    expect(new Set(GithubAgents.MINT_STATUS).size).toBe(15)
  })

  test("outcomes", () => {
    const outcomes: GithubAgents.Outcome[] = ["changes", "no-changes", "draft", "failed", "refused", "cancelled"]
    expect([...GithubAgents.OUTCOME]).toEqual(outcomes)
  })

  // The section 2.9.2 codes that end in a draft, the waits included. "deadline" is the engine's own stop.
  test("stop codes are the section 2.9.2 codes", () => {
    const codes: GithubAgents.StopCode[] = [
      "MODEL_PLAN_RUN_EXPIRED",
      "MODEL_PLAN_RUN_LIMIT",
      "MODEL_PLAN_DAILY_LIMIT",
      "MODEL_PLAN_EXHAUSTED",
      "MODEL_PLAN_PAYMENT_REQUIRED",
      "MODEL_PLAN_REQUIRED",
      "MODEL_PLAN_CAPACITY",
      "MODEL_PLAN_BLOCKED",
      "CODIUM_PERK_REQUIRED",
      "MODEL_PLAN_CONCURRENCY",
      "MODEL_PLAN_BUSY",
      "MODEL_PLAN_RENEWING",
      "MODEL_PLAN_UPGRADE_REQUIRED",
      "CODIUM_UPDATE_REQUIRED",
      "MODEL_PLANS_DISABLED",
      "MODEL_PLAN_MODEL_UNAVAILABLE",
    ]
    expect([...GithubAgents.STOP_CODES]).toEqual(codes)
    expect(new Set(GithubAgents.STOP_CODES).size).toBe(16)
    expect((GithubAgents.STOP_CODES as readonly string[]).includes("deadline")).toBe(false)
  })
})
