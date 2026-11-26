import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { GithubAgents } from "@vectordevai/core/github-agents"
import release from "../../../desktop/package.json"
import { githubShareConsent, prepareGithubEnvironment } from "../../src/cli/cmd/github.environment"
import { GithubSecrets } from "../../src/cli/cmd/github.secrets"
import { runTokenFile } from "../../src/cli/cmd/ship"
import { describe, expect, test } from "bun:test"
import {
  buildAgentsWorkflow,
  readWorkflowOptions,
  type AgentsWorkflowOptions,
  buildRouteScript,
  buildWorkflowYaml,
  cliVersionSpec,
} from "@vectordevai/core/review/workflow"

// The route script is the embedded parser and is covered by github.route-script.test.ts.
function withoutScript(yaml: string) {
  const open = "          script: |\n"
  const start = yaml.indexOf(open) + open.length
  const end = yaml.indexOf("\n\n  review:")
  return yaml.slice(0, start) + "            <route script>" + yaml.slice(end)
}

interface Step {
  uses?: string
  name?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}

interface Job {
  if?: string
  permissions: Record<string, string>
  concurrency?: { group: string; "cancel-in-progress": boolean }
  steps: Step[]
}

interface Workflow {
  on: Record<string, unknown>
  jobs: { route: Job; review: Job; vector: Job }
}

function parse(yaml: string): Workflow {
  const parsed = Bun.YAML.parse(yaml) as Record<string, unknown>
  // YAML 1.1 parsers read the `on` key as true.
  return { ...(parsed as object), on: (parsed["on"] ?? parsed["true"]) as Record<string, unknown> } as Workflow
}

const OPENAI = {
  provider: "openai",
  model: "gpt-4.1",
  keys: ["OPENAI_API_KEY"],
  autoReview: true,
  version: "1.17.14",
}

const ANTHROPIC = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  keys: ["ANTHROPIC_API_KEY"],
  autoReview: false,
  monthlyUsd: 50,
  version: "1.99.1",
}

const OPENAI_AUTO = `name: vector

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number to review
        required: true

jobs:
  # Decides who gets a runner. No checkout, and no share of the review queue.
  route:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      ((github.event_name == 'issue_comment' || github.event_name == 'pull_request_review_comment') &&
        github.event.comment.user.type != 'Bot' &&
        (contains(github.event.comment.body, '/vector') || contains(github.event.comment.body, '/vs') || contains(github.event.comment.body, '/vectorscope') || contains(github.event.comment.body, '/vx')))
    runs-on: ubuntu-latest
    timeout-minutes: 3
    permissions:
      contents: read
      pull-requests: write
      issues: write
    outputs:
      kind: \${{ steps.route.outputs.kind }}
      pr: \${{ steps.route.outputs.pr }}
      ref: \${{ steps.route.outputs.ref }}
    steps:
      - id: route
        uses: actions/github-script@v7
        with:
          script: |
            <route script>

  review:
    needs: route
    if: >-
      !cancelled() && (
        (github.event_name == 'pull_request' &&
          github.event.pull_request.head.repo.full_name == github.repository &&
          github.event.pull_request.draft == false &&
          !contains(github.event.pull_request.labels.*.name, 'vector:skip') &&
          !contains(github.event.pull_request.labels.*.name, 'vector:paused') &&
          github.event.pull_request.user.login != 'dependabot[bot]' &&
          github.event.pull_request.user.login != 'renovate[bot]') ||
        needs.route.outputs.kind == 'review' || needs.route.outputs.kind == 'review-full')
    runs-on: ubuntu-latest
    timeout-minutes: 20
    concurrency:
      group: vector-review-\${{ github.event.pull_request.number || needs.route.outputs.pr }}
      cancel-in-progress: false # queue, never cancel; a newer push replaces a queued run
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          # The route job's ref wins: on a fork it is the merge-base, never the fork's head.
          ref: \${{ needs.route.outputs.ref || github.event.pull_request.head.sha }}
          fetch-depth: 1 # the CLI fetches exactly the commits it needs, only if a review runs
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: actions/cache@v4
        with:
          path: ~/.npm
          key: vector-cli-1.17.14-\${{ runner.os }}
      - name: Install Vector
        run: npm install -g @vectordevai/cli@1.17.14 --prefer-offline --no-audit --no-fund
      - name: Review
        run: vector github review
        env:
          VECTOR_WORKFLOW_VERSION: "2"
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          VECTOR_CLI_TOKEN: \${{ secrets.VECTOR_CLI_TOKEN }}
          VECTOR_DISABLE_USAGE: "1" # CI jobs are not a person using Vector
          VECTOR_REVIEW_PR: \${{ github.event.pull_request.number || needs.route.outputs.pr }}
          VECTOR_REVIEW_REF: \${{ needs.route.outputs.ref || github.event.pull_request.head.sha }}
          MODEL: openai/gpt-4.1
          # REVIEW_AUTO_MODEL: provider/cheaper-model # automatic reviews only
          VECTOR_PURE: "1"
          VECTOR_DISABLE_PROJECT_CONFIG: "1"
          VECTOR_CONFIG_CONTENT: '{"lsp":false,"formatter":false,"snapshot":false}'
          # Add the selected provider's credentials as repository secrets.
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          # ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}

  vector:
    needs: route
    if: needs.route.outputs.kind == 'task'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    concurrency:
      # One group per comment: GitHub keeps one queued run per group, so a shared group would drop tasks.
      group: vector-\${{ needs.route.outputs.pr }}-\${{ github.event.comment.id || github.run_id }}
      cancel-in-progress: false
    permissions:
      contents: write
      pull-requests: write
      issues: write
      actions: write # dispatches reviews of pull requests Vector opens
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - uses: actions/cache@v4
        with:
          path: ~/.npm
          key: vector-cli-1.17.14-\${{ runner.os }}
      - name: Install Vector
        run: npm install -g @vectordevai/cli@1.17.14 --prefer-offline --no-audit --no-fund

      - name: Run Vector
        run: vector github run
        env:
          VECTOR_WORKFLOW_VERSION: "2"
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          VECTOR_CLI_TOKEN: \${{ secrets.VECTOR_CLI_TOKEN }}
          VECTOR_DISABLE_USAGE: "1" # CI jobs are not a person using Vector
          USE_GITHUB_TOKEN: "true"
          # Public sharing includes conversation text, code, and tool output, including future updates.
          SHARE: "false"
          MODEL: openai/gpt-4.1
          VECTOR_REVIEW_AUTO: "1"
          # Add the selected provider's credentials as repository secrets.
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          # ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`

const ANTHROPIC_COMMANDS_ONLY = `name: vector

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number to review
        required: true

jobs:
  # Decides who gets a runner. No checkout, and no share of the review queue.
  route:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      ((github.event_name == 'issue_comment' || github.event_name == 'pull_request_review_comment') &&
        github.event.comment.user.type != 'Bot' &&
        (contains(github.event.comment.body, '/vector') || contains(github.event.comment.body, '/vs') || contains(github.event.comment.body, '/vectorscope') || contains(github.event.comment.body, '/vx')))
    runs-on: ubuntu-latest
    timeout-minutes: 3
    permissions:
      contents: read
      pull-requests: write
      issues: write
    outputs:
      kind: \${{ steps.route.outputs.kind }}
      pr: \${{ steps.route.outputs.pr }}
      ref: \${{ steps.route.outputs.ref }}
    steps:
      - id: route
        uses: actions/github-script@v7
        with:
          script: |
            <route script>

  review:
    needs: route
    if: >-
      !cancelled() && (
        needs.route.outputs.kind == 'review' || needs.route.outputs.kind == 'review-full')
    runs-on: ubuntu-latest
    timeout-minutes: 20
    concurrency:
      group: vector-review-\${{ github.event.pull_request.number || needs.route.outputs.pr }}
      cancel-in-progress: false # queue, never cancel; a newer push replaces a queued run
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          # The route job's ref wins: on a fork it is the merge-base, never the fork's head.
          ref: \${{ needs.route.outputs.ref || github.event.pull_request.head.sha }}
          fetch-depth: 1 # the CLI fetches exactly the commits it needs, only if a review runs
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: actions/cache@v4
        with:
          path: ~/.npm
          key: vector-cli-1.99.1-\${{ runner.os }}
      - name: Install Vector
        run: npm install -g @vectordevai/cli@1.99.1 --prefer-offline --no-audit --no-fund
      - name: Review
        run: vector github review
        env:
          VECTOR_WORKFLOW_VERSION: "2"
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          VECTOR_CLI_TOKEN: \${{ secrets.VECTOR_CLI_TOKEN }}
          VECTOR_DISABLE_USAGE: "1" # CI jobs are not a person using Vector
          VECTOR_REVIEW_PR: \${{ github.event.pull_request.number || needs.route.outputs.pr }}
          VECTOR_REVIEW_REF: \${{ needs.route.outputs.ref || github.event.pull_request.head.sha }}
          MODEL: anthropic/claude-sonnet-4-5
          REVIEW_MAX_COST_USD_PER_MONTH: "50" # "0" means no limit
          VECTOR_PURE: "1"
          VECTOR_DISABLE_PROJECT_CONFIG: "1"
          VECTOR_CONFIG_CONTENT: '{"lsp":false,"formatter":false,"snapshot":false}'
          # Add the selected provider's credentials as repository secrets.
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          # OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}

  vector:
    needs: route
    if: needs.route.outputs.kind == 'task'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    concurrency:
      # One group per comment: GitHub keeps one queued run per group, so a shared group would drop tasks.
      group: vector-\${{ needs.route.outputs.pr }}-\${{ github.event.comment.id || github.run_id }}
      cancel-in-progress: false
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - uses: actions/cache@v4
        with:
          path: ~/.npm
          key: vector-cli-1.99.1-\${{ runner.os }}
      - name: Install Vector
        run: npm install -g @vectordevai/cli@1.99.1 --prefer-offline --no-audit --no-fund

      - name: Run Vector
        run: vector github run
        env:
          VECTOR_WORKFLOW_VERSION: "2"
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          VECTOR_CLI_TOKEN: \${{ secrets.VECTOR_CLI_TOKEN }}
          VECTOR_DISABLE_USAGE: "1" # CI jobs are not a person using Vector
          USE_GITHUB_TOKEN: "true"
          # Public sharing includes conversation text, code, and tool output, including future updates.
          SHARE: "false"
          MODEL: anthropic/claude-sonnet-4-5
          # Add the selected provider's credentials as repository secrets.
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          # OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
`

const COMBOS = [
  { name: "vector, automatic review", options: OPENAI },
  { name: "vector, commands only", options: { ...OPENAI, autoReview: false } },
  { name: "anthropic, automatic review", options: { ...ANTHROPIC, autoReview: true } },
  { name: "anthropic, commands only", options: ANTHROPIC },
]

describe("buildWorkflowYaml", () => {
  test("golden: openai with automatic review", () => {
    expect(withoutScript(buildWorkflowYaml(OPENAI))).toBe(OPENAI_AUTO)
  })

  test("golden: anthropic with commands only", () => {
    expect(withoutScript(buildWorkflowYaml(ANTHROPIC))).toBe(ANTHROPIC_COMMANDS_ONLY)
  })

  for (const combo of COMBOS)
    test(`${combo.name}: parses, and every job has exactly its permissions`, () => {
      const yaml = buildWorkflowYaml(combo.options)
      const workflow = parse(yaml)
      const auto = combo.options.autoReview
      expect(Object.keys(workflow.on).sort()).toEqual(
        [...(auto ? ["pull_request"] : []), "issue_comment", "pull_request_review_comment", "workflow_dispatch"].sort(),
      )
      expect(workflow.jobs.route.permissions).toEqual({ contents: "read", "pull-requests": "write", issues: "write" })
      expect(workflow.jobs.review.permissions).toEqual({ contents: "read", "pull-requests": "write" })
      expect(workflow.jobs.vector.permissions).toEqual({
        contents: "write",
        "pull-requests": "write",
        issues: "write",
        ...(auto ? { actions: "write" } : {}),
      })
      expect(yaml).not.toContain("id-token")
      // The route job checks nothing out.
      expect(workflow.jobs.route.steps.map((step) => step.uses)).toEqual(["actions/github-script@v7"])
    })

  for (const combo of COMBOS)
    test(`${combo.name}: the review job checks out only what the route resolved, and never cancels`, () => {
      const workflow = parse(buildWorkflowYaml(combo.options))
      const review = workflow.jobs.review
      const checkout = review.steps.find((step) => step.uses === "actions/checkout@v4")
      expect(checkout?.with).toEqual({
        ref: "${{ needs.route.outputs.ref || github.event.pull_request.head.sha }}",
        "fetch-depth": 1,
        "persist-credentials": false,
      })
      expect(review.concurrency).toEqual({
        group: "vector-review-${{ github.event.pull_request.number || needs.route.outputs.pr }}",
        "cancel-in-progress": false,
      })
      expect(workflow.jobs.vector.concurrency?.["cancel-in-progress"]).toBe(false)
      const env = review.steps.find((step) => step.run === "vector github review")?.env ?? {}
      expect(env["VECTOR_PURE"]).toBe("1")
      expect(env["VECTOR_DISABLE_PROJECT_CONFIG"]).toBe("1")
      expect(JSON.parse(env["VECTOR_CONFIG_CONTENT"] ?? "{}")).toEqual({
        lsp: false,
        formatter: false,
        snapshot: false,
      })
      expect(env["VECTOR_REVIEW_REF"]).toBe("${{ needs.route.outputs.ref || github.event.pull_request.head.sha }}")
      const task = workflow.jobs.vector.steps.find((step) => step.run === "vector github run")?.env ?? {}
      expect(task["VECTOR_REVIEW_AUTO"] ?? "unset").toBe(combo.options.autoReview ? "1" : "unset")
      for (const key of combo.options.keys) {
        expect(env[key]).toBe(`\${{ secrets.${key} }}`)
        expect(task[key]).toBe(`\${{ secrets.${key} }}`)
      }
    })

  test("the automatic branch filters forks, drafts, the skip and pause labels, and dependency bots", () => {
    const auto = parse(buildWorkflowYaml(OPENAI)).jobs.review.if ?? ""
    for (const condition of [
      "github.event_name == 'pull_request'",
      "github.event.pull_request.head.repo.full_name == github.repository",
      "github.event.pull_request.draft == false",
      "!contains(github.event.pull_request.labels.*.name, 'vector:skip')",
      "!contains(github.event.pull_request.labels.*.name, 'vector:paused')",
      "github.event.pull_request.user.login != 'dependabot[bot]'",
      "github.event.pull_request.user.login != 'renovate[bot]'",
      "needs.route.outputs.kind == 'review' || needs.route.outputs.kind == 'review-full'",
    ])
      expect(auto).toContain(condition)
    expect(auto.startsWith("!cancelled() && (")).toBe(true)
    const off = parse(buildWorkflowYaml({ ...OPENAI, autoReview: false })).jobs.review.if ?? ""
    expect(off).not.toContain("pull_request.draft")
    expect(off).not.toContain("github.event_name == 'pull_request'")
    expect(off).toContain("needs.route.outputs.kind == 'review'")
  })

  test("the route job ignores bots and runs only for the mentions it was built with", () => {
    const route = parse(buildWorkflowYaml({ ...OPENAI, mentions: ["/bot"] })).jobs.route
    expect(route.if).toContain("github.event.comment.user.type != 'Bot'")
    expect(route.if).toContain("contains(github.event.comment.body, '/bot')")
    expect(route.if).not.toContain("'/vector'")
    expect(String(route.steps[0]?.with?.["script"])).toContain('const mentions = ["/bot"]')
  })

  test("the monthly limit is written only when one is given, and 0 means none", () => {
    const env = (yaml: string) =>
      parse(yaml).jobs.review.steps.find((step) => step.run === "vector github review")?.env ?? {}
    expect(env(buildWorkflowYaml(OPENAI))["REVIEW_MAX_COST_USD_PER_MONTH"]).toBeUndefined()
    expect(env(buildWorkflowYaml(ANTHROPIC))["REVIEW_MAX_COST_USD_PER_MONTH"]).toBe("50")
    expect(env(buildWorkflowYaml({ ...ANTHROPIC, monthlyUsd: 0 }))["REVIEW_MAX_COST_USD_PER_MONTH"]).toBe("0")
    expect(env(buildWorkflowYaml({ ...ANTHROPIC, monthlyUsd: 12.5 }))["REVIEW_MAX_COST_USD_PER_MONTH"]).toBe("12.5")
  })

  test("both jobs pin the CLI, including workflows created by development builds", () => {
    expect(cliVersionSpec("1.17.14")).toEqual({ spec: "1.17.14", pinned: true })
    expect(cliVersionSpec("1.18.0-beta.2")).toEqual({ spec: "1.18.0-beta.2", pinned: true })
    expect(cliVersionSpec("local")).toEqual({ spec: release.vectorRequiredCliVersion, pinned: true })
    expect(cliVersionSpec("0.0.0-dev-202609141200")).toEqual({ spec: release.vectorRequiredCliVersion, pinned: true })
    const install = (version: string) =>
      parse(buildWorkflowYaml({ ...OPENAI, version })).jobs.review.steps.find((step) => step.name === "Install Vector")
    expect(install("1.17.14")?.run).toBe(
      "npm install -g @vectordevai/cli@1.17.14 --prefer-offline --no-audit --no-fund",
    )
    expect(install("local")?.run).toBe(
      `npm install -g @vectordevai/cli@${release.vectorRequiredCliVersion} --prefer-offline --no-audit --no-fund`,
    )
    for (const version of ["1.17.14", "local"]) {
      const jobs = parse(buildWorkflowYaml({ ...OPENAI, version })).jobs
      expect(jobs.vector.steps.find((step) => step.name === "Install Vector")?.run).toBe(install(version)?.run)
      expect(jobs.vector.steps.find((step) => step.uses === "actions/cache@v4")?.with).toEqual(
        jobs.review.steps.find((step) => step.uses === "actions/cache@v4")?.with,
      )
    }
  })

  test("the route script never contains an Actions expression", () => {
    expect(buildRouteScript()).not.toContain("${{")
  })
})

describe("GitHub workflow compatibility", () => {
  test("stale CI review gets guidance and safe defaults before config loads", () => {
    const env: Record<string, string | undefined> = { GITHUB_ACTIONS: "true", VECTOR_WORKFLOW_VERSION: "1" }
    expect(prepareGithubEnvironment(env, true)).toContain("vector github install")
    expect(env.VECTOR_PURE).toBe("1")
    expect(env.VECTOR_DISABLE_PROJECT_CONFIG).toBe("1")
    expect(JSON.parse(env.VECTOR_CONFIG_CONTENT!)).toEqual({ lsp: false, formatter: false, snapshot: false })
  })
  test("current workflow preserves explicit config and task mode", () => {
    const env = {
      GITHUB_ACTIONS: "true",
      VECTOR_WORKFLOW_VERSION: GithubAgents.WORKFLOW_VERSION,
      VECTOR_CONFIG_CONTENT: '{"snapshot":true}',
    }
    expect(prepareGithubEnvironment(env, true)).toBeUndefined()
    expect(env.VECTOR_CONFIG_CONTENT).toBe('{"snapshot":true}')
    const task: Record<string, string | undefined> = { GITHUB_ACTIONS: "true" }
    expect(prepareGithubEnvironment(task, false)).toContain("vector github install")
    expect(task.VECTOR_PURE).toBeUndefined()
    expect(task.VECTOR_CONFIG_CONTENT).toBeUndefined()
    expect(prepareGithubEnvironment({}, true)).toBeUndefined()
  })
  // Both installers write v3 (V24). Each env passes its own configuration, so only the "2" can make it stale.
  for (const [name, review, extra, pure] of [
    ["review", true, {}, "1"],
    ["task", false, {}, undefined],
    ["App task", false, { VECTOR_GITHUB_AUTH: "auto" }, "1"],
  ] as const)
    test(`a v2 ${name} job is stale on its version alone now that both installers write v3`, () => {
      const env: Record<string, string | undefined> = {
        GITHUB_ACTIONS: "true",
        VECTOR_WORKFLOW_VERSION: "2",
        VECTOR_CONFIG_CONTENT: '{"snapshot":true}',
        ...extra,
      }
      expect(prepareGithubEnvironment(env, review)).toContain("vector github install")
      expect(env.VECTOR_CONFIG_CONTENT).toBe('{"snapshot":true}')
      expect(env.VECTOR_PURE).toBe(pure)
      expect(env.VECTOR_DISABLE_PROJECT_CONFIG).toBe(pure)
      expect(prepareGithubEnvironment({ ...env, GITHUB_ACTIONS: undefined }, review)).toBeUndefined()
    })
  test("a v2 review without its configuration still gets the safe defaults", () => {
    const env: Record<string, string | undefined> = { GITHUB_ACTIONS: "true", VECTOR_WORKFLOW_VERSION: "2" }
    expect(prepareGithubEnvironment(env, true)).toContain("vector github install")
    expect(env.VECTOR_PURE).toBe("1")
    expect(env.VECTOR_DISABLE_PROJECT_CONFIG).toBe("1")
    expect(JSON.parse(env.VECTOR_CONFIG_CONTENT!)).toEqual({ lsp: false, formatter: false, snapshot: false })
  })
})

test("shared free-model workflows only need the Vector account token", () => {
  const yaml = buildWorkflowYaml({ ...OPENAI, provider: "vector", model: "acme/coder:free", keys: [] })
  expect(yaml).toContain("VECTOR_CLI_TOKEN: ${{ secrets.VECTOR_CLI_TOKEN }}")
  expect(yaml).not.toContain("OPENAI_API_KEY")
  expect(yaml).not.toContain("ANTHROPIC_API_KEY")
  expect(yaml).toContain("MODEL: vector/acme/coder:free")
})

describe("GitHub public sharing consent", () => {
  test("generated workflows do not publish without an explicit install choice", () => {
    const workflow = parse(buildWorkflowYaml(OPENAI))
    const env = workflow.jobs.vector.steps.find((step) => step.name === "Run Vector")?.env
    expect(env?.SHARE).toBe("false")
    expect(env?.VECTOR_SHARE_CONSENT).toBeUndefined()
    expect(workflow.jobs.review.steps.find((step) => step.name === "Review")?.env?.SHARE).toBeUndefined()
  })

  test("an explicit install choice records current consent and the required token secret", () => {
    const yaml = buildWorkflowYaml({ ...OPENAI, share: true })
    const env = parse(yaml).jobs.vector.steps.find((step) => step.name === "Run Vector")?.env
    expect(env?.SHARE).toBe("true")
    expect(env?.VECTOR_SHARE_CONSENT).toBe("1")
    expect(env?.VECTOR_CLI_TOKEN).toBe("${{ secrets.VECTOR_CLI_TOKEN }}")
    expect(yaml).toContain("conversation text, code, and tool output, including future updates")
    expect(githubShareConsent({ ...env, VECTOR_CLI_TOKEN: "vct_synthetic" })).toEqual({
      version: 1,
      public: true,
      updates: true,
    })
  })

  test("inherited flags, project configuration, and old acknowledgments never authorize sharing", () => {
    for (const env of [
      {},
      { SHARE: "true" },
      { SHARE: "1", VECTOR_SHARE_CONSENT: "1" },
      { SHARE: "true", VECTOR_SHARE_CONSENT: "0" },
      { SHARE: "false", VECTOR_SHARE_CONSENT: "1" },
      { VECTOR_CONFIG_CONTENT: '{"share":"auto","autoshare":true}', VECTOR_AUTO_SHARE: "true" },
    ])
      expect(githubShareConsent({ ...env, VECTOR_CLI_TOKEN: "vct_synthetic" })).toBeUndefined()
  })

  test("publication consent still requires a Vector account token", () => {
    for (const token of [undefined, "", "provider-key"])
      expect(() => githubShareConsent({ SHARE: "true", VECTOR_SHARE_CONSENT: "1", VECTOR_CLI_TOKEN: token })).toThrow(
        "repository secret VECTOR_CLI_TOKEN",
      )
  })
})

test("App opt-in grants OIDC only to separate eligible jobs and never persists their checkout credential", () => {
  const jobs = (
    Bun.YAML.parse(buildWorkflowYaml({ ...OPENAI, auth: "auto" })) as {
      jobs: Record<string, Job & { name?: string }>
    }
  ).jobs
  expect(jobs.review_app.name).toBe("Vector review")
  expect(jobs.vector_app.name).toBe("Vector task")
  expect(jobs.review_app.permissions["id-token"]).toBe("write")
  expect(jobs.vector_app.permissions["id-token"]).toBe("write")
  for (const name of ["route", "review", "vector"]) expect(jobs[name].permissions["id-token"]).toBeUndefined()
  expect(jobs.review.if).toContain("needs.route.outputs.app != 'true'")
  expect(jobs.review_app.if).toContain("needs.route.outputs.app == 'true'")
  expect(jobs.review_app.if).not.toContain("github.event_name == 'pull_request'")
  expect(jobs.vector_app.if).toContain("github.event_name == 'issue_comment'")
  expect(jobs.vector.if).toContain("github.event_name != 'issue_comment'")
  for (const name of ["review_app", "vector_app"]) {
    expect(
      jobs[name].steps.find((step) => step.uses?.startsWith("actions/checkout"))?.with?.["persist-credentials"],
    ).toBe(false)
    expect(jobs[name].steps.at(-1)?.env?.VECTOR_GITHUB_AUTH).toBe("auto")
    expect(jobs[name].steps.at(-1)?.env?.USE_GITHUB_TOKEN).toBeUndefined()
  }
})

test("App task mode excludes repository plugins and configuration before Instance loads", () => {
  const env: Record<string, string | undefined> = { VECTOR_GITHUB_AUTH: "auto" }
  prepareGithubEnvironment(env, false)
  expect(env.VECTOR_PURE).toBe("1")
  expect(env.VECTOR_DISABLE_PROJECT_CONFIG).toBe("1")
})

const CODIUM: AgentsWorkflowOptions = {
  mode: "codium",
  provider: "vector",
  model: "vector-plan",
  keys: [],
  autoReview: false,
  version: GithubAgents.MIN_AGENTS_CLI,
}
const OWN_KEY: AgentsWorkflowOptions = {
  ...CODIUM,
  mode: "own-key",
  provider: "openai",
  model: "gpt-4.1",
  keys: ["OPENAI_API_KEY"],
  autoReview: true,
}
const SCHEDULED: AgentsWorkflowOptions = {
  ...OWN_KEY,
  autoReview: false,
  publishAuth: "app",
  handle: "vector-dev",
  schedules: [
    {
      id: "daily",
      cron: "17 9 * * 1-5",
      prompt: 'Fix "bugs": ${' + "{ secrets.GITHUB_TOKEN }}\n$HOME\nquote' and \\u0024",
    },
  ],
}
type AgentsStep = Step & {
  id?: string
  if?: string
  shell?: string
  "working-directory"?: string
  "continue-on-error"?: boolean
  "timeout-minutes"?: number
}
type AgentsJob = Omit<Job, "steps"> & {
  name?: string
  needs?: string | string[]
  "runs-on": string
  "timeout-minutes": number
  env: Record<string, string>
  outputs?: Record<string, string>
  steps: AgentsStep[]
}
function agents(options = CODIUM) {
  return Bun.YAML.parse(buildAgentsWorkflow(options)) as {
    permissions: Record<string, string>
    on: Record<string, unknown>
    jobs: Record<string, AgentsJob>
  }
}

describe("workflow v3", () => {
  test("the task and review mint steps own separate environment objects", async () => {
    // The YAML writer already prints separate mappings, so parsing its output cannot catch an earlier shared mutation.
    const source = await Bun.file(new URL("../../../core/src/review/workflow.ts", import.meta.url)).text()
    const lines = source.split("\n")
    for (const purpose of ["task", "review"]) {
      const mint = lines.find((line) => line.includes(`run: "vector github mint --purpose ${purpose}"`))
      expect(mint).toContain("env: { ...mintEnv }")
    }
  })

  for (const [name, options] of [
    ["Codium", CODIUM],
    ["own key auto-review", OWN_KEY],
    ["scheduled App publishing", SCHEDULED],
  ] as const) {
    test(`${name} golden, header, and explicit permissions`, () => {
      const workflow = agents(options)
      expect(workflow.permissions).toEqual({})
      expect(readWorkflowOptions(buildAgentsWorkflow(options))).toEqual({
        ...options,
        publishAuth: options.publishAuth ?? "github",
      })
      expect(Object.keys(workflow.jobs)).toEqual(
        options.mode === "codium"
          ? ["route", "agent", "publish", "capture", "bind", "review"]
          : ["route", "agent", "publish", "bind", "review"],
      )
      for (const job of Object.values(workflow.jobs)) {
        expect(job.env.VECTOR_WORKFLOW_VERSION).toBe("3")
        expect(job["runs-on"]).toBe("ubuntu-latest")
        expect(job.permissions).toBeDefined()
        for (const step of job.steps) {
          expect(step.env?.VECTOR_RUN_TOKEN).toBeUndefined()
          if (step.uses?.startsWith("actions/checkout")) expect(step.with?.["persist-credentials"]).toBe(false)
          if (step.run?.startsWith("npm install"))
            expect(step.run).toBe(
              `npm install -g @vectordevai/cli@${GithubAgents.MIN_AGENTS_CLI} --prefer-offline --no-audit --no-fund`,
            )
        }
      }
      workflow.jobs.route.steps[0]!.with!.script = "<route script: exercised separately>"
      expect(workflow).toMatchSnapshot()
    })
  }

  test("agent credentials, sandbox, and upload order are fixed, and Codium's jobs restore no npm cache", () => {
    for (const options of [CODIUM, OWN_KEY]) {
      const job = agents(options).jobs.agent
      const steps = job.steps
      const codium = options.mode === "codium"
      expect(job.permissions).toEqual({
        contents: "read",
        issues: "read",
        "pull-requests": "read",
        actions: "read",
        ...(codium ? { "id-token": "write" } : {}),
      })
      expect(job["timeout-minutes"]).toBe(codium ? 135 : 60)
      // Own key keeps its restore-only cache (its review job saves the key). No Codium job saves one, so a Codium restore
      // could only hit an entry planted in the run's cache scope, which Ship Desk's capture job can write (BT12 item 5).
      expect(steps.slice(0, codium ? 2 : 3).map((step) => step.uses ?? step.name)).toEqual([
        "actions/setup-node@v4",
        ...(codium ? [] : ["actions/cache/restore@v4"]),
        "Install Vector",
      ])
      expect(steps.some((step) => step.uses === "actions/cache@v4" || step.uses === "actions/cache/save@v4")).toBe(
        false,
      )
      if (codium)
        for (const [name, other] of Object.entries(agents(options).jobs))
          expect([name, other.steps.filter((step) => step.uses?.startsWith("actions/cache")).length]).toEqual([name, 0])
      const checkout = steps.findIndex((step) => step.uses === "actions/checkout@v4")
      const mint = steps.findIndex((step) => step.id === "mint")
      if (codium) expect(mint).toBeLessThan(checkout)
      else expect(steps.find((step) => step.id === "mint")).toBeUndefined()
      // Ship Desk's ticket: right after the mint, before any repository file is on disk (V31).
      if (codium) expect([steps.findIndex((step) => step.id === "capture"), checkout]).toEqual([mint + 1, mint + 2])
      else expect(steps.find((step) => step.id === "capture")).toBeUndefined()
      const sandbox = steps.findIndex((step) => step.id === "sandbox")
      const isolation = steps.findIndex((step) => step.name === "Install tool process isolation")
      const agent = steps.findIndex((step) => step.id === "agent")
      const finish = steps.findIndex((step) => step.run === "vector github sandbox finish")
      expect(checkout).toBeLessThan(sandbox)
      expect(isolation).toBeGreaterThan(checkout)
      expect(isolation).toBeLessThan(sandbox)
      expect(steps[isolation]!.if).toBe(steps[sandbox]!.if)
      expect(steps[isolation]!.env).toBeUndefined()
      expect(steps[isolation]!.run).toContain("--no-install-recommends bubblewrap")
      expect(sandbox).toBeLessThan(agent)
      expect(agent).toBeLessThan(finish)
      expect(steps[sandbox]!.if).toContain("runner.environment == 'github-hosted'")
      expect(steps[agent]!.shell).toBe(
        "env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN bash --noprofile --norc -eo pipefail {0}",
      )
      expect(steps[agent]!.run).toBe("vector github sandbox run -- vector github run --phase agent")
      expect(steps[finish]!.if).toBe("always()")
      expect(steps[finish]!.id).toBe("sandbox_finish")
      for (const [index, step] of steps.entries())
        if (step.uses === "actions/upload-artifact@v4") {
          expect(index).toBeGreaterThan(finish)
          expect(step.with!.path).toMatch(/^\$\{\{ runner.temp \}\}\/vector-(out|session)\/$/)
          expect(step.if).toBe(
            "always() && steps.agent.outcome != 'skipped' && steps.sandbox_finish.outcome == 'success'",
          )
        }
      expect(steps.filter((step) => step.uses === "actions/upload-artifact@v4")).toHaveLength(codium ? 2 : 1)
      expect(steps[agent]!.env!.VECTOR_PROMPT).toBe("${{ inputs.prompt }}")
      if (codium) expect(steps[agent]!.env!.VECTOR_CLI_TOKEN).toBeUndefined()
      if (!codium) expect(steps[agent]!.env!.VECTOR_CLI_TOKEN).toBe("${{ secrets.VECTOR_CLI_TOKEN }}")
      expect(steps[agent]!.env!.VECTOR_AGENT_SUDO).toBeUndefined()
      if (codium) {
        expect(steps[agent]!.env!.SHARE).toBe("false")
        expect(steps[agent]!.env!.VECTOR_SHARE_CONSENT).toBeUndefined()
        expect(steps[sandbox]!.env!.VECTOR_AGENT_SUDO).toBeUndefined()
        expect(steps[checkout]!.if).toBe("steps.mint.outputs.status == 'ok'")
      }
    }
  })

  test("own-key review lists every credential for untrusted child filtering", () => {
    const keys = ["AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK"]
    const workflow = agents({ ...OWN_KEY, keys })
    for (const job of [workflow.jobs.review, workflow.jobs.agent]) {
      const env = job.steps.find((step) => step.env?.VECTOR_SECRET_ENV_NAMES)?.env
      expect(env?.VECTOR_SECRET_ENV_NAMES).toBe(keys.join(","))
      const child = untrustedChildEnvironment({
        ...env,
        GITHUB_ACTIONS: "true",
        AWS_ACCESS_KEY_ID: "fixture-id",
        AWS_BEARER_TOKEN_BEDROCK: "fixture-token",
      })
      for (const key of [...keys, "GITHUB_TOKEN", "VECTOR_CLI_TOKEN"]) expect(child[key]).toBeUndefined()
    }
  })

  test("Codium review authenticates before checkout without account or provider secrets", () => {
    const job = agents().jobs.review
    expect(job.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
      issues: "write",
      "id-token": "write",
    })
    expect(job.steps.map((step) => step.uses ?? step.run)).toEqual([
      "actions/setup-node@v4",
      `npm install -g @vectordevai/cli@${GithubAgents.MIN_AGENTS_CLI} --prefer-offline --no-audit --no-fund`,
      "vector github mint --purpose review",
      "actions/checkout@v4",
      "vector github review",
    ])
    const review = job.steps.at(-1)!
    expect(review.shell).toBe(agents().jobs.agent.steps.find((step) => step.id === "agent")!.shell)
    expect(review.env!.VECTOR_CONFIG_CONTENT).toBe('{"lsp":false,"formatter":false,"snapshot":false}')
    expect(review.env!.VECTOR_CLI_TOKEN).toBeUndefined()
    expect(review.env!.OPENAI_API_KEY).toBeUndefined()
    expect(review.env!.REVIEW_MAX_COST_USD_PER_MONTH).toBeUndefined()
    expect(agents().on.pull_request).toBeUndefined()
  })

  test("publish takes trusted routing and a runner-owned bundle with isolated authority", () => {
    for (const options of [CODIUM, OWN_KEY, SCHEDULED]) {
      const job = agents(options).jobs.publish
      if (options.publishAuth === "app") expect(job.permissions["id-token"]).toBe("write")
      if (options.publishAuth !== "app") expect(job.permissions["id-token"]).toBeUndefined()
      if (options.autoReview) expect(job.permissions.actions).toBe("write")
      if (!options.autoReview) expect(job.permissions.actions).toBeUndefined()
      expect(job.steps.some((step) => step.uses?.includes("cache"))).toBe(false)
      const download = job.steps.find((step) => step.uses === "actions/download-artifact@v4")!
      expect(download.with!.path).toBe("${{ runner.temp }}/vector-bundle")
      expect(download["continue-on-error"]).toBe(true)
      const publish = job.steps.at(-1)!
      expect(publish["working-directory"]).toBe("${{ runner.temp }}")
      for (const name of ["KIND", "PR", "REF"])
        expect(publish.env![`VECTOR_ROUTE_${name}`]).toBe(`\${{ needs.route.outputs.${name.toLowerCase()} }}`)
      expect(publish.env!.VECTOR_GITHUB_AUTH).toBe(options.publishAuth ?? "github")
      // The publisher re-derives a dispatch's route, which needs its prompt (deviations BT08b item 1).
      expect(publish.env!.VECTOR_PROMPT).toBe("${{ inputs.prompt }}")
      expect(publish.env!.VECTOR_AGENT_STATUS).toBe(
        options.mode === "codium" ? "${{ needs.agent.outputs.status }}" : "ok",
      )
      expect(publish.env!.VECTOR_CLI_TOKEN).toBeUndefined()
      expect(publish.env!.OPENAI_API_KEY).toBeUndefined()
    }
    const bind = agents().jobs.bind
    expect(bind.permissions).toEqual({ "id-token": "write" })
    expect(bind.steps.some((step) => step.uses?.includes("checkout"))).toBe(false)
    expect(bind.steps.at(-1)!.env!.VECTOR_BIND_CODE).toBe("${{ inputs.code }}")
    expect(agents().jobs.route.steps.some((step) => step.uses?.includes("checkout"))).toBe(false)
  })

  test("publish downloads only the artifact ID emitted by this agent's trusted bundle upload", () => {
    for (const options of [CODIUM, OWN_KEY, SCHEDULED]) {
      const workflow = agents(options)
      const upload = workflow.jobs.agent.steps.find((step) => step.with?.path === "${{ runner.temp }}/vector-out/")!
      expect(upload.uses).toBe("actions/upload-artifact@v4")
      expect(upload.id).toBe("bundle")
      expect(workflow.jobs.agent.steps.filter((step) => step.id === "bundle")).toHaveLength(1)
      expect(workflow.jobs.agent.outputs!.bundle).toBe("${{ steps.bundle.outputs.artifact-id }}")
      const download = workflow.jobs.publish.steps.find((step) => step.uses === "actions/download-artifact@v4")!
      // Empty ID means skipped/failed upload. Without this guard the action would download every artifact by default.
      expect(download.if).toBe("needs.agent.outputs.bundle != ''")
      expect(download.with).toEqual({
        "artifact-ids": "${{ needs.agent.outputs.bundle }}",
        "merge-multiple": true,
        path: "${{ runner.temp }}/vector-bundle",
      })
      // A missing or failed download still reaches the publisher's existing fail-closed missing-bundle report.
      expect(download["continue-on-error"]).toBe(true)
    }
  })

  test("hostile schedule prompts survive JSON and YAML without becoming expressions", () => {
    const workflow = agents(SCHEDULED)
    const value = workflow.jobs.agent.steps.find((step) => step.id === "agent")!.env!.VECTOR_SCHEDULE_PROMPTS
    expect(value).not.toContain("${{")
    expect(value).toContain("\\u0024")
    expect(JSON.parse(value)).toEqual({
      [SCHEDULED.schedules![0]!.cron]: { id: "daily", prompt: SCHEDULED.schedules![0]!.prompt },
    })
    expect(workflow.jobs.publish.steps.at(-1)!.env!.VECTOR_SCHEDULE_PROMPTS).toBe(value)
    expect(buildAgentsWorkflow(SCHEDULED).split("\n")[0]).not.toContain("${{")
  })

  // The App's owner-started desktop dispatch sends brain_upload; GitHub refuses an undeclared input with 422.
  test("only the Codium agent step receives the desktop Brain upload input", () => {
    const occurrences = (text: string, name: string) => text.split(name).length - 1
    for (const options of [CODIUM, { ...CODIUM, handle: "vector-dev", schedules: SCHEDULED.schedules }]) {
      const workflow = agents(options)
      const inputs = (workflow.on.workflow_dispatch as { inputs: Record<string, unknown> }).inputs
      expect(Object.keys(inputs)).toEqual(["mode", "prompt", "pr", "code", "ticket", "brain_upload"])
      expect(inputs.brain_upload).toEqual({ type: "string", required: false })
      // The input key and the agent step's one expression: never the header, the route script or a run line. The split
      // count is case-sensitive, so lowercase brain_upload never matches inside VECTOR_BRAIN_UPLOAD; the carriers check
      // below is the structural guarantee.
      const yaml = buildAgentsWorkflow(options)
      expect(occurrences(yaml, "brain_upload")).toBe(2)
      expect(occurrences(yaml, "VECTOR_BRAIN_UPLOAD")).toBe(1)
      const carriers = Object.entries(workflow.jobs).flatMap(([job, value]) => [
        ...Object.entries(value.env).flatMap(([name, text]) =>
          text.includes("brain_upload") ? [`${job}:${name}`] : [],
        ),
        ...value.steps.flatMap((step) => [
          ...Object.entries(step.env ?? {}).flatMap(([name, text]) =>
            text.includes("inputs.brain_upload") ? [`${job}/${step.id ?? step.uses ?? step.run}:${name}`] : [],
          ),
          ...(step.run?.includes("brain_upload") ? [`${job}/${step.run}:run`] : []),
          ...(JSON.stringify(step.with ?? {}).includes("brain_upload") ? [`${job}/${step.uses}:with`] : []),
        ]),
      ])
      expect(carriers).toEqual(["agent/agent:VECTOR_BRAIN_UPLOAD"])
      expect(workflow.jobs.agent.steps.find((step) => step.id === "agent")!.env!.VECTOR_BRAIN_UPLOAD).toBe(
        "${{ inputs.brain_upload }}",
      )
    }
    for (const options of [OWN_KEY, SCHEDULED]) {
      const inputs = (agents(options).on.workflow_dispatch as { inputs: Record<string, unknown> }).inputs
      expect(Object.keys(inputs)).toEqual(["mode", "prompt", "pr", "code", "ticket"])
      const yaml = buildAgentsWorkflow(options)
      expect(yaml).not.toContain("brain_upload")
      expect(yaml).not.toContain("VECTOR_BRAIN_UPLOAD")
    }
    // The sandbox launcher keeps it; the run token that gives it meaning stays in the secret channel.
    expect(GithubAgents.SANDBOX_ENV_ALLOW).toContain("VECTOR_BRAIN_UPLOAD")
  })

  // Ship Desk (A49, V31): the ticket is asked for with the run token before checkout, and the job that runs the pull
  // request's own code holds that ticket and nothing else (deviations 2026-11-16 BT12).
  test("Ship Desk's ticket step and capture job are Codium-only, hold only the ticket and follow publish's pull request", () => {
    const occurrences = (text: string, name: string) => text.split(name).length - 1
    for (const options of [CODIUM, { ...CODIUM, handle: "vector-dev", schedules: SCHEDULED.schedules }]) {
      const workflow = agents(options)
      const agent = workflow.jobs.agent!
      // No env: the runner gives RUNNER_TEMP and GITHUB_OUTPUT, and the ticket comes from vectordev.ai. The agent step's
      // shell keeps the OIDC request pair out of it; its lines are discarded (INV-P1) and any failure never stops the run.
      expect(agent.steps.find((step) => step.id === "capture")).toEqual({
        id: "capture",
        if: "steps.mint.outputs.status == 'ok' && vars.VECTOR_SHIP_DESK == '1'",
        run: "vector ship ticket >/dev/null 2>&1",
        shell: agent.steps.find((step) => step.id === "agent")!.shell!,
        "continue-on-error": true,
        "timeout-minutes": 2,
      })
      // It reads the file the mint step writes the run token to.
      expect(runTokenFile({ RUNNER_TEMP: "/runner/temp" })).toBe(
        GithubSecrets.runTokenPath({ RUNNER_TEMP: "/runner/temp" }),
      )
      expect(agent.outputs).toEqual({
        status: "${{ steps.mint.outputs.status }}",
        rid: "${{ steps.mint.outputs.rid }}",
        capture: "${{ steps.capture.outputs.capture }}",
        bundle: "${{ steps.bundle.outputs.artifact-id }}",
      })
      const publish = workflow.jobs.publish!
      expect(publish.outputs).toEqual({ pr: "${{ steps.publish.outputs.pr }}" })
      expect(publish.steps.filter((step) => step.id === "publish").map((step) => step.run)).toEqual([
        "vector github publish",
      ])
      const capture = workflow.jobs.capture!
      expect(capture).toEqual({
        name: GithubAgents.JOB.capture,
        needs: ["route", "agent", "publish"],
        if: "!cancelled() && vars.VECTOR_SHIP_DESK == '1' && needs.agent.outputs.capture != '' && needs.publish.outputs.pr != ''",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": GithubAgents.TIMEOUT_MIN.capture,
        env: { VECTOR_WORKFLOW_VERSION: GithubAgents.WORKFLOW_VERSION },
        permissions: { contents: "read" },
        steps: [
          { uses: "actions/setup-node@v4", with: { "node-version": 20 } },
          {
            name: "Install Vector",
            run: `npm install -g @vectordevai/cli@${GithubAgents.MIN_AGENTS_CLI} --prefer-offline --no-audit --no-fund`,
          },
          {
            uses: "actions/checkout@v4",
            with: {
              ref: "refs/pull/${{ needs.publish.outputs.pr }}/head",
              "fetch-depth": 0,
              "persist-credentials": false,
            },
          },
          {
            run: 'vector ship capture --pr "$VECTOR_CAPTURE_PR"',
            env: {
              VECTOR_WORKFLOW_VERSION: GithubAgents.WORKFLOW_VERSION,
              VECTOR_CAPTURE_PR: "${{ needs.publish.outputs.pr }}",
              VECTOR_CAPTURE_TICKET: "${{ needs.agent.outputs.capture }}",
            },
          },
        ],
      })
      const text = JSON.stringify(capture)
      for (const absent of [
        "secrets.",
        "id-token",
        "VECTOR_CLI_TOKEN",
        "GITHUB_TOKEN",
        "vector-secrets",
        "github mint",
        "actions/cache",
      ])
        expect([absent, text.includes(absent)]).toEqual([absent, false])
      // The pull request's number reaches the run line through env only (INV-S15).
      expect(capture.steps.flatMap((step) => step.run ?? []).filter((run) => run.includes("${{"))).toEqual([])
      // The ticket step's condition and the capture job's, nowhere else.
      expect(occurrences(buildAgentsWorkflow(options), "VECTOR_SHIP_DESK")).toBe(2)
    }
    for (const options of [OWN_KEY, SCHEDULED]) {
      const workflow = agents(options)
      expect(workflow.jobs.capture).toBeUndefined()
      expect(workflow.jobs.publish!.outputs).toBeUndefined()
      expect(
        Object.values(workflow.jobs).flatMap((job) =>
          job.steps.filter((step) => step.id === "capture" || step.id === "publish"),
        ),
      ).toEqual([])
      const yaml = buildAgentsWorkflow(options)
      for (const absent of ["vector ship", "VECTOR_SHIP_DESK", "VECTOR_CAPTURE", "steps.publish", "steps.capture"])
        expect([absent, yaml.includes(absent)]).toEqual([absent, false])
    }
  })

  test("every emitted Actions expression is explicitly allowlisted", () => {
    const allowed = new Set([
      "runner.os",
      "needs.route.outputs.kind",
      "needs.route.outputs.pr",
      "needs.route.outputs.ref",
      "needs.route.outputs.thread",
      "needs.route.outputs.app",
      "inputs.ticket",
      "inputs.prompt",
      "inputs.code",
      "inputs.brain_upload",
      "github.event.comment.id",
      "secrets.GITHUB_TOKEN",
      "secrets.VECTOR_CLI_TOKEN",
      "secrets.OPENAI_API_KEY",
      "vars.VECTOR_MODEL || 'vector-plan'",
      "vars.VECTOR_AGENT_SUDO",
      "runner.temp",
      "github.run_id",
      "github.run_attempt",
      "github.workspace",
      "steps.route.outputs.kind",
      "steps.route.outputs.pr",
      "steps.route.outputs.ref",
      "steps.route.outputs.thread",
      "steps.route.outputs.app",
      "steps.mint.outputs.status",
      "steps.mint.outputs.rid",
      "needs.agent.outputs.status",
      "needs.agent.outputs.rid",
      "steps.bundle.outputs.artifact-id",
      "needs.agent.outputs.bundle",
      // Ship Desk (V31): the ticket step's output and the pull request publish names.
      "steps.capture.outputs.capture",
      "needs.agent.outputs.capture",
      "steps.publish.outputs.pr",
      "needs.publish.outputs.pr",
      "github.event.pull_request.number || needs.route.outputs.pr",
      "needs.route.outputs.ref || github.event.pull_request.head.sha",
      `contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association || github.event.issue.author_association) && github.run_id || (github.event.comment.user.id || github.event.issue.user.id || github.run_id)`,
      "github.event_name == 'schedule' && format('vector-schedule-{0}', needs.route.outputs.thread) || format('vector-{0}-{1}', needs.route.outputs.thread, github.event.comment.id || github.run_id)",
    ])
    // Inspect decoded YAML too: escaping must not merely hide an expression from a raw-file scan.
    for (const options of [CODIUM, OWN_KEY, SCHEDULED])
      for (const match of buildAgentsWorkflow(options).matchAll(/\$\{\{(.*?)\}\}/gs))
        expect(allowed.has(match[1]!.trim().replace(/''/g, "'"))).toBe(true)
    const check = (value: unknown): void => {
      if (typeof value === "string")
        for (const match of value.matchAll(/\$\{\{(.*?)\}\}/gs)) expect(allowed.has(match[1]!.trim())).toBe(true)
      if (Array.isArray(value)) value.forEach(check)
      else if (value && typeof value === "object") Object.values(value).forEach(check)
    }
    for (const options of [CODIUM, OWN_KEY, SCHEDULED]) check(agents(options))
  })

  test("options reject executable names, secret/control collisions and unsupported Codium modes", () => {
    for (const cron of ["60 8 * * *", "0 24 * * *", "*/0 8 * * *", "20-10 8 * * *", "0 8 * 13 *"])
      expect(() =>
        buildAgentsWorkflow({ ...CODIUM, schedules: [{ id: "daily", cron, prompt: "Maintain the repository" }] }),
      ).toThrow("Invalid workflow schedules")
    expect(() =>
      buildAgentsWorkflow({
        ...CODIUM,
        schedules: [
          { id: "first", cron: "0 8 * * *", prompt: "a".repeat(70_000) },
          { id: "second", cron: "1 8 * * *", prompt: "b".repeat(70_000) },
        ],
      }),
    ).toThrow("safe environment size limit")
    for (const key of [
      "BAD-KEY",
      "x",
      "A\nB",
      "OPENAI_API_KEY\n",
      "GITHUB_TOKEN",
      "VECTOR_MODE",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "BASH_ENV",
      "NODE_OPTIONS",
      "BUN_OPTIONS",
      "SHELLOPTS",
      "PS4",
      "GIT_CONFIG_COUNT",
      "REVIEW_AUTO_MODEL",
      "REVIEW_VERIFY",
      "PATH",
    ])
      expect(() => buildAgentsWorkflow({ ...OWN_KEY, keys: [key] })).toThrow()
    for (const name of ["", "a b", "openai\n", "x\nrun: danger", "${{secrets.X}}", "x'", "x;echo"])
      for (const field of ["provider", "model"] as const)
        expect(() => buildAgentsWorkflow({ ...OWN_KEY, [field]: name })).toThrow()
    for (const change of [{ share: true }, { autoReview: true }, { keys: ["OPENAI_API_KEY"] }])
      expect(() => buildAgentsWorkflow({ ...CODIUM, ...change })).toThrow()
    for (const version of ["1.99.112", "1.99.113-beta.1", "local", "$(echo bad)"])
      expect(() => buildAgentsWorkflow({ ...CODIUM, version })).toThrow()
    // The desktop and its bundled engine pin their own product version, which no published CLI carries yet, so setup
    // stays refused for it until the owner publishes a CLI at MIN_AGENTS_CLI.
    expect(() => buildAgentsWorkflow({ ...CODIUM, version: release.version })).toThrow(
      `GitHub agents require CLI ${GithubAgents.MIN_AGENTS_CLI} or newer`,
    )
    expect(() => buildAgentsWorkflow({ ...CODIUM, version: "10.0.0" })).not.toThrow()
    expect(() => buildAgentsWorkflow({ ...OWN_KEY, share: true })).not.toThrow()
    expect(readWorkflowOptions("# vector-workflow: {broken}")).toBeUndefined()
    expect(
      readWorkflowOptions("# vector-workflow: " + JSON.stringify({ ...OWN_KEY, password: "secret" })),
    ).toBeUndefined()
    expect(readWorkflowOptions(buildWorkflowYaml(OPENAI))).toBeUndefined()
    // Old headers remain readable so the setup flow can offer an update.
    expect(
      readWorkflowOptions("# vector-workflow: " + JSON.stringify({ ...CODIUM, version: "1.99.112" }))?.version,
    ).toBe("1.99.112")
  })

  test("future workflow versions do not trigger a false downgrade warning", () => {
    for (const version of ["3", "10"])
      expect(
        prepareGithubEnvironment(
          { GITHUB_ACTIONS: "true", VECTOR_WORKFLOW_VERSION: version, VECTOR_CONFIG_CONTENT: "{}" },
          true,
        ),
      ).toBeUndefined()
    for (const version of ["1", "", "NaN", "2oops"])
      expect(
        prepareGithubEnvironment(
          { GITHUB_ACTIONS: "true", VECTOR_WORKFLOW_VERSION: version, VECTOR_CONFIG_CONTENT: "{}" },
          true,
        ),
      ).toContain("vector github install")
  })

  test("what the v3 builder writes is current for the CLI, and the legacy builder's stamp is stale", () => {
    for (const options of [CODIUM, OWN_KEY, SCHEDULED]) {
      const jobs = Object.values(agents(options).jobs)
      const versions = jobs.flatMap((job) => [
        job.env.VECTOR_WORKFLOW_VERSION,
        ...job.steps.flatMap((step) => step.env?.VECTOR_WORKFLOW_VERSION ?? []),
      ])
      expect(new Set(versions)).toEqual(new Set([GithubAgents.WORKFLOW_VERSION]))
      // The agent phase returns before prepareGithubEnvironment, so the review step is the only v3 step that reaches it.
      for (const step of jobs.flatMap((job) => job.steps))
        if (step.run?.includes("vector github run")) expect(step.run).toContain("--phase agent")
      const reviews = jobs.flatMap((job) =>
        job.steps
          .filter((step) => step.run === "vector github review")
          .map((step) => ({ ...job.env, ...step.env, GITHUB_ACTIONS: "true" })),
      )
      expect(reviews).toHaveLength(1)
      for (const env of reviews) expect(prepareGithubEnvironment(env, true)).toBeUndefined()
    }
    // With App mode the legacy file adds a second review job and a second task job.
    for (const [legacy, jobs] of [
      [OPENAI, 2],
      [{ ...OPENAI, auth: "auto" }, 4],
    ] as const) {
      const steps = Object.values(parse(buildWorkflowYaml(legacy)).jobs).flatMap((job) => job.steps)
      expect(new Set(steps.flatMap((step) => step.env?.VECTOR_WORKFLOW_VERSION ?? []))).toEqual(new Set(["2"]))
      const runs = steps.filter((step) => step.run === "vector github review" || step.run === "vector github run")
      expect(runs).toHaveLength(jobs)
      for (const step of runs)
        expect(
          prepareGithubEnvironment({ ...step.env, GITHUB_ACTIONS: "true" }, step.run === "vector github review"),
        ).toContain("vector github install")
    }
  })
})
