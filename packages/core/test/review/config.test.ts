import { describe, expect, test } from "bun:test"
import {
  MAX_RULES_BYTES,
  parseReviewConfig,
  parseReviewRules,
  REVIEW_CONFIG_PATH,
  rulesForPaths,
} from "@vectordevai/core/review/config"
import { DEFAULT_REVIEW_CONFIG } from "@vectordevai/core/review/types"

describe("parseReviewConfig", () => {
  test("returns the defaults in new arrays", () => {
    const { config, warnings } = parseReviewConfig()
    expect(config).toEqual(DEFAULT_REVIEW_CONFIG)
    expect(warnings).toEqual([])
    config.skipLabels.push("mutated")
    config.ignore.push("mutated")
    expect(DEFAULT_REVIEW_CONFIG.skipLabels).toEqual(["vector:skip", "no-review"])
    expect(DEFAULT_REVIEW_CONFIG.ignore).toEqual([])
  })

  test("falls back to the defaults on bad JSON", () => {
    for (const json of ["{", "[1, 2]", "null", '"text"', ""]) {
      const { config, warnings } = parseReviewConfig({ json })
      expect(config).toEqual(DEFAULT_REVIEW_CONFIG)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toStartWith(REVIEW_CONFIG_PATH)
    }
  })

  test("reads a file with a byte order mark", () => {
    expect(parseReviewConfig({ json: '\uFEFF{"maxComments": 4}' }).config.maxComments).toBe(4)
  })

  test("keeps the default for each key with the wrong type", () => {
    const { config, warnings } = parseReviewConfig({
      json: JSON.stringify({
        maxComments: "ten",
        suggestions: "yes",
        minSeverity: "critical",
        ignore: "dist/**",
        model: "gpt",
        paths: {},
        security: true,
      }),
    })
    expect(config).toEqual(DEFAULT_REVIEW_CONFIG)
    expect(warnings).toHaveLength(7)
    expect(warnings[0]).toBe('.vector/review.json: "maxComments" must be a number from 0 to 50; using 10.')
  })

  test("clamps numbers into range, with a warning", () => {
    const { config, warnings } = parseReviewConfig({
      json: JSON.stringify({
        maxComments: 80,
        minConfidence: 1.4,
        maxSteps: 0,
        maxDiffChars: 100,
        maxCostUsd: -1,
        maxCommentsPerPr: 3.6,
        timeoutMinutes: 500,
      }),
    })
    expect([
      config.maxComments,
      config.minConfidence,
      config.maxSteps,
      config.maxDiffChars,
      config.maxCostUsd,
      config.maxCommentsPerPr,
      config.timeoutMinutes,
    ]).toEqual([50, 1, 1, 8_000, 0, 4, 120])
    expect(warnings).toContain('.vector/review.json: "maxComments": 80 is out of range; using 50.')
    expect(warnings).toHaveLength(7)
  })

  test("applies valid values and drops bad list entries", () => {
    const { config, warnings } = parseReviewConfig({
      json: JSON.stringify({
        incremental: false,
        minSeverity: "nit",
        verify: "all",
        failOn: "blocking",
        skipAuthors: ["bot[bot]", 3, ""],
        paths: [{ path: "src/api/**", instructions: "Validate input." }, { path: 1 }],
        model: "anthropic/claude-sonnet-4-5",
        maxCostUsdPerMonth: 25,
      }),
    })
    expect(config).toMatchObject({
      incremental: false,
      minSeverity: "nit",
      verify: "all",
      failOn: "blocking",
      skipAuthors: ["bot[bot]"],
      paths: [{ path: "src/api/**", instructions: "Validate input." }],
      model: "anthropic/claude-sonnet-4-5",
      maxCostUsdPerMonth: 25,
    })
    expect(warnings).toEqual([
      '.vector/review.json: "skipAuthors": entries that are not text were dropped.',
      '.vector/review.json: "paths": entries without a "path" and "instructions" were dropped.',
    ])
  })

  test("reads nits and a triage model, and refuses a triage model that is not provider/model", () => {
    const { config, warnings } = parseReviewConfig({
      json: JSON.stringify({ nits: true, triageModel: " openrouter/cheap-model ", model: "anthropic/strong" }),
    })
    expect(config).toMatchObject({ nits: true, triageModel: "openrouter/cheap-model", model: "anthropic/strong" })
    expect(warnings).toEqual([])
    const bad = parseReviewConfig({ json: JSON.stringify({ triageModel: "cheap", nits: "yes" }) })
    expect(bad.config.triageModel).toBeUndefined()
    expect(bad.config.nits).toBe(false)
    expect(bad.warnings).toHaveLength(2)
  })

  test("keeps the double-check on whenever a triage model is set", () => {
    const warning =
      '"verify": "off" is ignored while "triageModel" is set: every finding of the cheaper first pass is double-checked on the review model.'
    const json = parseReviewConfig({ json: JSON.stringify({ triageModel: "openrouter/cheap", verify: "off" }) })
    expect(json.config.verify).toBe("all")
    expect(json.warnings).toEqual([warning])
    const env = parseReviewConfig({
      json: JSON.stringify({ triageModel: "openrouter/cheap" }),
      env: { REVIEW_VERIFY: "off" },
    })
    expect(env.config.verify).toBe("all")
    expect(env.warnings).toEqual([warning])
    expect(parseReviewConfig({ json: JSON.stringify({ verify: "off" }) }).config.verify).toBe("off")
  })

  test("keeps today's verify default unless the shared verify policy is opted into", () => {
    expect(parseReviewConfig().config).toMatchObject({ verify: "blocking", verifyPolicy: "legacy" })
    expect(parseReviewConfig({ json: JSON.stringify({ verifyPolicy: "legacy" }) }).config.verify).toBe("blocking")
    const shared = parseReviewConfig({ json: JSON.stringify({ verifyPolicy: "shared" }) })
    expect(shared.config).toMatchObject({ verify: "all", verifyPolicy: "shared" })
    expect(shared.warnings).toEqual([])
    // An explicit setting wins over the policy's default, in review.json or in REVIEW_VERIFY.
    for (const verify of ["blocking", "off", "all"] as const)
      expect(parseReviewConfig({ json: JSON.stringify({ verifyPolicy: "shared", verify }) }).config.verify).toBe(verify)
    expect(
      parseReviewConfig({ json: JSON.stringify({ verifyPolicy: "shared" }), env: { REVIEW_VERIFY: "blocking" } }).config
        .verify,
    ).toBe("blocking")
    // The environment opts in, or out, over review.json, as every other variable does.
    expect(parseReviewConfig({ env: { REVIEW_VERIFY_POLICY: " Shared " } }).config).toMatchObject({
      verify: "all",
      verifyPolicy: "shared",
    })
    expect(
      parseReviewConfig({ json: JSON.stringify({ verifyPolicy: "shared" }), env: { REVIEW_VERIFY_POLICY: "legacy" } })
        .config,
    ).toMatchObject({ verify: "blocking", verifyPolicy: "legacy" })
  })

  test("a bad verify policy is a warning and changes nothing", () => {
    const bad = parseReviewConfig({ json: JSON.stringify({ verifyPolicy: "always" }) })
    expect(bad.config).toEqual(DEFAULT_REVIEW_CONFIG)
    expect(bad.warnings).toEqual(['.vector/review.json: "verifyPolicy" must be "legacy", "shared"; using "legacy".'])
    // A bad variable leaves the file's valid choice, and a bad verify falls back to that policy's default.
    const env = parseReviewConfig({
      json: JSON.stringify({ verifyPolicy: "shared" }),
      env: { REVIEW_VERIFY_POLICY: "maybe", REVIEW_VERIFY: "sometimes" },
    })
    expect(env.config).toMatchObject({ verify: "all", verifyPolicy: "shared" })
    expect(env.warnings).toEqual([
      'REVIEW_VERIFY must be "blocking", "all", "off"; using "all".',
      'REVIEW_VERIFY_POLICY must be "legacy", "shared"; using "shared".',
    ])
  })

  test("under the shared verify policy a triage model still keeps the double-check on", () => {
    const { config, warnings } = parseReviewConfig({
      json: JSON.stringify({ verifyPolicy: "shared", triageModel: "openrouter/cheap", verify: "off" }),
    })
    expect(config.verify).toBe("all")
    expect(warnings).toEqual([
      '"verify": "off" is ignored while "triageModel" is set: every finding of the cheaper first pass is double-checked on the review model.',
    ])
  })

  test("warns about auto, drafts and unknown keys, and ignores them", () => {
    const { config, warnings } = parseReviewConfig({
      json: '{"auto": false, "drafts": true, "bogus": 1, "__proto__": {"maxComments": 1}, "constructor": 2}',
    })
    expect(config).toEqual(DEFAULT_REVIEW_CONFIG)
    expect(warnings).toHaveLength(5)
    expect(warnings[0]).toContain('"auto" is no longer read')
    expect(warnings[1]).toContain('"drafts" is no longer read')
    expect(warnings[2]).toBe('.vector/review.json: unknown key "bogus" is ignored.')
  })

  test("lets every environment variable override review.json", () => {
    const json = JSON.stringify({
      ignore: ["gen/**"],
      model: "anthropic/claude-sonnet-4-5",
      minSeverity: "nit",
      maxComments: 5,
    })
    const env = {
      REVIEW_MIN_SEVERITY: "blocking",
      REVIEW_MIN_CONFIDENCE: "0.9",
      REVIEW_MAX_COMMENTS: "3",
      REVIEW_SECURITY: "Always",
      REVIEW_VERIFY: "all",
      REVIEW_FAIL_ON: "blocking",
      REVIEW_IGNORE: "docs/**, *.md,",
      REVIEW_MAX_COST_USD: "1.5",
      REVIEW_MAX_COST_USD_PER_PR: "4",
      REVIEW_MAX_COST_USD_PER_MONTH: "50",
      REVIEW_TIMEOUT_MINUTES: "8",
      REVIEW_AUTO_MODEL: "anthropic/claude-haiku-4-5",
    }
    const { config, warnings } = parseReviewConfig({ json, env, trigger: "auto" })
    expect(warnings).toEqual([])
    expect(config).toMatchObject({
      minSeverity: "blocking",
      minConfidence: 0.9,
      maxComments: 3,
      security: "always",
      verify: "all",
      failOn: "blocking",
      ignore: ["gen/**", "docs/**", "*.md"],
      maxCostUsd: 1.5,
      maxCostUsdPerPr: 4,
      maxCostUsdPerMonth: 50,
      timeoutMinutes: 8,
      model: "anthropic/claude-haiku-4-5",
    })
  })

  test("applies REVIEW_AUTO_MODEL to automatic runs only", () => {
    const json = JSON.stringify({ model: "anthropic/claude-sonnet-4-5" })
    const env = { REVIEW_AUTO_MODEL: "anthropic/claude-haiku-4-5" }
    expect(parseReviewConfig({ json, env, trigger: "command" }).config.model).toBe("anthropic/claude-sonnet-4-5")
    expect(parseReviewConfig({ json, env }).config.model).toBe("anthropic/claude-sonnet-4-5")
    expect(parseReviewConfig({ env, trigger: "auto" }).config.model).toBe("anthropic/claude-haiku-4-5")
  })

  test("reads environment numbers in any decimal form", () => {
    const { config, warnings } = parseReviewConfig({
      env: { REVIEW_MIN_CONFIDENCE: ".8", REVIEW_MAX_COST_USD: "2.50", REVIEW_MAX_COMMENTS: " 7 " },
    })
    expect([config.minConfidence, config.maxCostUsd, config.maxComments]).toEqual([0.8, 2.5, 7])
    expect(warnings).toEqual([])
  })

  test("ignores empty environment values and warns about bad ones", () => {
    const json = JSON.stringify({ maxCostUsd: 3 })
    const { config, warnings } = parseReviewConfig({
      json,
      env: { REVIEW_MAX_COMMENTS: "", REVIEW_MAX_COST_USD: "lots", REVIEW_VERIFY: "sometimes" },
    })
    expect([config.maxComments, config.maxCostUsd, config.verify]).toEqual([10, 3, "blocking"])
    expect(warnings).toEqual([
      'REVIEW_VERIFY must be "blocking", "all", "off"; using "blocking".',
      "REVIEW_MAX_COST_USD must be a number of at least 0; using 3.",
    ])
  })
})

const RULES = `# Review rules
Apply to every pull request.
- Unparameterized SQL is blocking.

## path: src/billing/**
- Money is integer cents. A float in this folder is blocking.

## path: **/*.test.ts, \`**/*.spec.ts\`
- Don't ask for assertion messages.

\`\`\`md
## path: fenced/**
- This heading is an example, not a section.
\`\`\`

## Style
- Prefer early returns.

## path: *.sql
- Name every column.
`

describe("review.md rules", () => {
  const rules = parseReviewRules(RULES)
  const global =
    "# Review rules\nApply to every pull request.\n- Unparameterized SQL is blocking.\n\n## Style\n- Prefer early returns."

  test("splits the global text from the path sections", () => {
    expect(rules.global).toBe(global)
    expect(rules.sections).toEqual([
      { globs: ["src/billing/**"], text: "- Money is integer cents. A float in this folder is blocking." },
      {
        globs: ["**/*.test.ts", "**/*.spec.ts"],
        text: "- Don't ask for assertion messages.\n\n```md\n## path: fenced/**\n- This heading is an example, not a section.\n```",
      },
      { globs: ["*.sql"], text: "- Name every column." },
    ])
    expect(rules.truncated).toBe(false)
  })

  test("rulesForPaths passes the global text and the sections that match a changed file", () => {
    expect(rulesForPaths(rules, ["README.md"])).toBe(global)
    expect(rulesForPaths(rules, ["src/billing/charge.ts", "README.md"])).toBe(
      global + "\n\n## path: src/billing/**\n- Money is integer cents. A float in this folder is blocking.",
    )
    expect(rulesForPaths(rules, ["src/a.spec.ts"])).toContain("## path: **/*.test.ts, **/*.spec.ts")
    expect(rulesForPaths(rules, ["db/queries/q.sql"])).toContain("- Name every column.")
    expect(rulesForPaths(rules, ["src/api/x.ts"], [{ path: "src/api/**", instructions: " Validate input. " }])).toBe(
      global + "\n\n## path: src/api/**\nValidate input.",
    )
    expect(rulesForPaths(parseReviewRules(""), ["a.ts"])).toBe("")
  })

  test("caps the file at 16 KB", () => {
    const long = parseReviewRules("- rule\n".repeat(4_000))
    expect(long.truncated).toBe(true)
    expect(new TextEncoder().encode(long.global).length).toBeLessThanOrEqual(MAX_RULES_BYTES)
    expect(long.global.endsWith("- rule")).toBe(true)
    const wide = parseReviewRules("é".repeat(9_000))
    expect(wide.truncated).toBe(true)
    expect(wide.global).not.toContain("\uFFFD")
    expect(new TextEncoder().encode(wide.global).length).toBeLessThanOrEqual(MAX_RULES_BYTES)
  })
})
