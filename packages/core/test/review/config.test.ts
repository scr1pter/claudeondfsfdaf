import { describe, expect, test } from "bun:test"
import {
  MAX_RULES_BYTES,
  mergeReviewConfig,
  parseReviewConfig,
  parseReviewRules,
  REVIEW_CONFIG_PATH,
  ruleGlobMatches,
  rulePartsForPaths,
  rulesForPaths,
  SOURCED_REVIEW_KEYS,
} from "@vectordevai/core/review/config"
import { DEFAULT_REVIEW_CONFIG, OPTIONAL_REVIEW_DEFAULTS, UNAPPLIED_REVIEW_KEYS } from "@vectordevai/core/review/types"

describe("parseReviewConfig", () => {
  test("returns the defaults in new arrays", () => {
    const { config, warnings } = parseReviewConfig()
    expect(config).toEqual(DEFAULT_REVIEW_CONFIG)
    expect(warnings).toEqual([])
    config.skipLabels.push("mutated")
    config.ignore.push("mutated")
    expect(DEFAULT_REVIEW_CONFIG.skipLabels).toEqual(["vector:skip", "no-review"])
    expect(DEFAULT_REVIEW_CONFIG.ignore).toEqual([])
    // The route settings (VS-23a) have no default entry, so the defaults and every digest of them stay as they were.
    for (const key of SOURCED_REVIEW_KEYS) {
      expect(Object.hasOwn(DEFAULT_REVIEW_CONFIG, key)).toBe(false)
      expect(Object.hasOwn(config, key)).toBe(false)
    }
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

  test("model evidence is off unless review.json or REVIEW_MODEL_EVIDENCE opts into its warnings (VS-07)", () => {
    expect(DEFAULT_REVIEW_CONFIG.modelEvidence).toBe("off")
    expect(parseReviewConfig().config.modelEvidence).toBe("off")
    expect(parseReviewConfig({ json: JSON.stringify({ modelEvidence: "warn" }) })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, modelEvidence: "warn" },
      warnings: [],
    })
    expect(parseReviewConfig({ env: { REVIEW_MODEL_EVIDENCE: " Warn " } }).config.modelEvidence).toBe("warn")
    expect(
      parseReviewConfig({ json: JSON.stringify({ modelEvidence: "warn" }), env: { REVIEW_MODEL_EVIDENCE: "off" } })
        .config.modelEvidence,
    ).toBe("off")
    // There is nothing to enforce: a value that would refuse or switch models is not a choice.
    const bad = parseReviewConfig({ json: JSON.stringify({ modelEvidence: "require" }) })
    expect(bad.config).toEqual(DEFAULT_REVIEW_CONFIG)
    expect(bad.warnings).toEqual(['.vector/review.json: "modelEvidence" must be "off", "warn"; using "off".'])
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

  // VS-32a: the value lands with the GitHub job's wiring, after vector-at-mention. Until then it is an unknown value,
  // so it warns and keeps what the other sources say, exactly as today, and exit codes cannot change.
  test("VS-32: blocking-or-incomplete is not a failOn value before the wiring", () => {
    const json = '{"failOn":"blocking-or-incomplete"}'
    const fromJson = parseReviewConfig({ json })
    expect(fromJson.config.failOn).toBe("never")
    expect(fromJson.config).toEqual(DEFAULT_REVIEW_CONFIG)
    expect(fromJson.warnings).toEqual(['.vector/review.json: "failOn" must be "never", "blocking"; using "never".'])
    expect(parseReviewConfig({ env: { REVIEW_FAIL_ON: "blocking-or-incomplete" } })).toEqual({
      config: DEFAULT_REVIEW_CONFIG,
      warnings: ['REVIEW_FAIL_ON must be "never", "blocking"; using "never".'],
    })
    const kept = parseReviewConfig({
      json: '{"failOn":"blocking"}',
      env: { REVIEW_FAIL_ON: "blocking-or-incomplete" },
    })
    expect(kept.config.failOn).toBe("blocking")
    expect(kept.warnings).toEqual(['REVIEW_FAIL_ON must be "never", "blocking"; using "blocking".'])
    expect(mergeReviewConfig({ surface: "github", json: { at: "base", text: json } })).toEqual(fromJson)
  })

  // VS-35a: guarded team memory's rules land uncalled (team.ts); the key and its parse wait for runner-wiring. Until
  // then it is an unknown key on every surface, it has no environment variable, and no config or digest changes.
  test("VS-35: teamMemory is not a key before the wiring", () => {
    const json = '{"teamMemory":"guarded"}'
    const env = { REVIEW_TEAM_MEMORY: "guarded", REVIEW_TEAMMEMORY: "guarded" }
    const parsed = parseReviewConfig({ json, env })
    expect(parsed).toEqual({
      config: DEFAULT_REVIEW_CONFIG,
      warnings: [`${REVIEW_CONFIG_PATH}: unknown key "teamMemory" is ignored.`],
    })
    expect(Object.hasOwn(parsed.config, "teamMemory")).toBe(false)
    expect(parseReviewConfig({ env })).toEqual({ config: DEFAULT_REVIEW_CONFIG, warnings: [] })
    for (const surface of ["local", "github"] as const)
      expect(mergeReviewConfig({ surface, json: { at: "base", text: json }, env })).toEqual(parsed)
  })
})

describe("mergeReviewConfig", () => {
  const JSON_TEXT = JSON.stringify({ maxComments: 4, minSeverity: "nit", ignore: ["gen/**"], bogus: 1, auto: true })
  const ENV = {
    REVIEW_MAX_COMMENTS: "3",
    REVIEW_AUTO_MODEL: "anthropic/claude-haiku-4-5",
    REVIEW_VERIFY: "sometimes",
    REVIEW_IGNORE: "docs/**",
  }
  const zdrWarning = (label: string) => `${label} must be "standard" or "zdr"; using "zdr", the stricter setting.`

  test("with neither route setting it is parseReviewConfig, on every surface", () => {
    const texts = [
      JSON_TEXT,
      undefined,
      "{",
      "[1, 2]",
      "null",
      '"text"',
      "",
      '\uFEFF{"maxComments": 4}',
      '{"auto": false, "drafts": true, "bogus": 1, "__proto__": {"maxComments": 1}, "constructor": 2}',
    ]
    for (const text of texts) {
      // The GitHub job: the base's review.json and the workflow's environment, on an automatic run.
      expect(mergeReviewConfig({ surface: "github", json: { at: "base", text }, env: ENV, trigger: "auto" })).toEqual(
        parseReviewConfig({ json: text, env: ENV, trigger: "auto" }),
      )
      // The CLI on your own branch, and with --pr.
      for (const at of ["working-tree", "base"] as const)
        expect(
          mergeReviewConfig({ surface: "local", global: {}, json: { at, text }, env: ENV, trigger: "local" }),
        ).toEqual(parseReviewConfig({ json: text, env: ENV, trigger: "local" }))
      // The desktop: no environment.
      expect(mergeReviewConfig({ surface: "local", json: { at: "working-tree", text }, trigger: "desktop" })).toEqual(
        parseReviewConfig({ json: text, trigger: "desktop" }),
      )
    }
    // The desktop's base blob, when a pull request changes review.json, keeps today's defaults.
    expect(
      mergeReviewConfig({
        surface: "local",
        json: { at: "base", text: JSON_TEXT, privacyOnly: true },
        trigger: "desktop",
      }).config,
    ).toEqual(parseReviewConfig({ trigger: "desktop" }).config)
  })

  test("parseReviewConfig itself still ignores both, so no surface takes zdr before it enforces it", () => {
    const { config, warnings } = parseReviewConfig({
      json: JSON.stringify({ privacy: "zdr", zdrAttested: ["openrouter"] }),
      env: { REVIEW_PRIVACY: "zdr", REVIEW_ZDR_ATTESTED: "openrouter" },
    })
    expect(config).toEqual(DEFAULT_REVIEW_CONFIG)
    expect(Object.hasOwn(config, "privacy")).toBe(false)
    expect(warnings).toEqual([
      `${REVIEW_CONFIG_PATH}: unknown key "privacy" is ignored.`,
      `${REVIEW_CONFIG_PATH}: unknown key "zdrAttested" is ignored.`,
    ])
    // VS-33's attestation objects too.
    const structured = parseReviewConfig({
      json: JSON.stringify({ zdrAttested: [{ id: "openrouter", operator: "openrouter", region: "eu" }] }),
    })
    expect(structured.config).toEqual(DEFAULT_REVIEW_CONFIG)
    expect(structured.warnings).toEqual([`${REVIEW_CONFIG_PATH}: unknown key "zdrAttested" is ignored.`])
  })

  test("privacy is raised by any source and lowered by none", () => {
    const values = [undefined, "standard", "zdr"] as const
    for (const surface of ["local", "github"] as const)
      for (const global of values)
        for (const json of values)
          for (const env of values) {
            const result = mergeReviewConfig({
              surface,
              ...(global === undefined ? {} : { global: { privacy: global } }),
              json: { at: "base", text: json === undefined ? undefined : JSON.stringify({ privacy: json }) },
              env: env === undefined ? {} : { REVIEW_PRIVACY: env },
            })
            expect(result.config.privacy).toBe([global, json, env].includes("zdr") ? "zdr" : undefined)
            expect(result.warnings).toEqual([])
          }
  })

  test("privacy is read without case or surrounding space", () => {
    for (const input of [
      { global: { privacy: " ZDR " } },
      { json: { at: "working-tree" as const, text: '{"privacy": "Zdr"}' } },
      { env: { REVIEW_PRIVACY: " zdr\n" } },
    ]) {
      const result = mergeReviewConfig({ surface: "local", ...input })
      expect(result.config.privacy).toBe("zdr")
      expect(result.warnings).toEqual([])
    }
    const standard = mergeReviewConfig({ surface: "local", env: { REVIEW_PRIVACY: "Standard" } })
    expect(Object.hasOwn(standard.config, "privacy")).toBe(false)
    expect(standard.warnings).toEqual([])
  })

  test("a privacy value that cannot be read fails closed to zdr, with a warning", () => {
    for (const value of ["zero", true, null, 1, ""]) {
      const result = mergeReviewConfig({
        surface: "local",
        json: { at: "base", text: JSON.stringify({ privacy: value }) },
      })
      expect(result.config.privacy).toBe("zdr")
      expect(result.warnings).toEqual([zdrWarning(`${REVIEW_CONFIG_PATH}: "privacy"`)])
    }
    const env = mergeReviewConfig({ surface: "github", env: { REVIEW_PRIVACY: "maybe" } })
    expect(env.config.privacy).toBe("zdr")
    expect(env.warnings).toEqual([zdrWarning("REVIEW_PRIVACY")])
    const global = mergeReviewConfig({ surface: "local", global: { privacy: 3 } })
    expect(global.config.privacy).toBe("zdr")
    expect(global.warnings).toEqual([zdrWarning("review.privacy in the global config")])
    // A blank environment value is unset, as for every other variable.
    const blank = mergeReviewConfig({ surface: "local", env: { REVIEW_PRIVACY: "  " } })
    expect(blank).toEqual(parseReviewConfig({ env: { REVIEW_PRIVACY: "  " } }))
  })

  test("a review.json that cannot be read fails closed only when it mentions privacy", () => {
    for (const text of ['{"privacy": "zdr",}', '["privacy"]', "privacy: zdr"]) {
      const result = mergeReviewConfig({ surface: "github", json: { at: "base", text } })
      expect(result.config).toEqual({ ...DEFAULT_REVIEW_CONFIG, privacy: "zdr" })
      expect(result.warnings).toHaveLength(2)
      expect(result.warnings[1]).toBe(
        `${REVIEW_CONFIG_PATH} could not be read and mentions "privacy"; using "zdr", the stricter setting.`,
      )
    }
    const text = '{"maxComments": 4,}'
    expect(mergeReviewConfig({ surface: "github", json: { at: "base", text } })).toEqual(
      parseReviewConfig({ json: text }),
    )
  })

  test("locally, zdrAttested comes only from the global config", () => {
    const global = mergeReviewConfig({ surface: "local", global: { zdrAttested: ["openrouter", " gpu-box:8080 "] } })
    expect(global.config.zdrAttested).toEqual(["openrouter", "gpu-box:8080"])
    expect(global.warnings).toEqual([])
    const ignored = `${REVIEW_CONFIG_PATH}: "zdrAttested" is ignored: "zdrAttested" is read only from the global config.`
    // Your working tree, even beside the global config's own list, and the base a pull request is reviewed against.
    const tree = mergeReviewConfig({
      surface: "local",
      global: { zdrAttested: ["openrouter"] },
      json: { at: "working-tree", text: '{"zdrAttested": ["acme"]}' },
    })
    expect(tree.config.zdrAttested).toEqual(["openrouter"])
    expect(tree.warnings).toEqual([ignored])
    for (const json of [
      { at: "base" as const, text: '{"zdrAttested": ["acme"]}' },
      { at: "base" as const, text: '{"zdrAttested": ["acme"]}', privacyOnly: true },
    ]) {
      const result = mergeReviewConfig({ surface: "local", json, trigger: "desktop" })
      expect(Object.hasOwn(result.config, "zdrAttested")).toBe(false)
      expect(result.warnings).toEqual([ignored])
    }
    // No environment variable is read for it.
    const env = mergeReviewConfig({
      surface: "local",
      env: { REVIEW_ZDR_ATTESTED: "openrouter", ZDR_ATTESTED: "openrouter", REVIEW_ATTESTED: "openrouter" },
    })
    expect(Object.hasOwn(env.config, "zdrAttested")).toBe(false)
    expect(env.warnings).toEqual([])
  })

  test("in CI, zdrAttested comes only from the base branch's review.json", () => {
    const base = mergeReviewConfig({ surface: "github", json: { at: "base", text: '{"zdrAttested": ["openrouter"]}' } })
    expect(base.config.zdrAttested).toEqual(["openrouter"])
    expect(base.warnings).toEqual([])
    const only = `"zdrAttested" is read only from ${REVIEW_CONFIG_PATH} on the base branch.`
    const global = mergeReviewConfig({ surface: "github", global: { zdrAttested: ["openrouter"] } })
    expect(Object.hasOwn(global.config, "zdrAttested")).toBe(false)
    expect(global.warnings).toEqual([`review.zdrAttested in the global config is ignored: ${only}`])
    const tree = mergeReviewConfig({
      surface: "github",
      json: { at: "working-tree", text: '{"zdrAttested": ["openrouter"]}' },
    })
    expect(Object.hasOwn(tree.config, "zdrAttested")).toBe(false)
    expect(tree.warnings).toEqual([`${REVIEW_CONFIG_PATH}: "zdrAttested" is ignored: ${only}`])
    const env = mergeReviewConfig({ surface: "github", env: { REVIEW_ZDR_ATTESTED: "openrouter" } })
    expect(Object.hasOwn(env.config, "zdrAttested")).toBe(false)
  })

  test("a zdrAttested that is not a list of names attests nothing it cannot read", () => {
    const label = "review.zdrAttested in the global config"
    const text = mergeReviewConfig({ surface: "local", global: { zdrAttested: "openrouter" } })
    expect(Object.hasOwn(text.config, "zdrAttested")).toBe(false)
    expect(text.warnings).toEqual([`${label} must be a list of provider IDs and model server hosts; it is ignored.`])
    const mixed = mergeReviewConfig({ surface: "local", global: { zdrAttested: [1, " openrouter ", " ", null] } })
    expect(mixed.config.zdrAttested).toEqual(["openrouter"])
    expect(mixed.warnings).toEqual([`${label}: entries that are not text were dropped.`])
    const urls = mergeReviewConfig({
      surface: "local",
      global: { zdrAttested: ["https://gpu-box:8080", "gpu-box", "gpu box", "user@host"] },
    })
    expect(urls.config.zdrAttested).toEqual(["gpu-box"])
    expect(urls.warnings).toEqual([
      `${label}: "https://gpu-box:8080", "gpu box", "user@host" name neither a provider ID nor a host, so they were dropped; write a server as its host, such as "gpu-box:8080".`,
    ])
    const empty = mergeReviewConfig({ surface: "local", global: { zdrAttested: [] } })
    expect(empty).toEqual(parseReviewConfig())
  })

  test("zdrAttested takes attestation objects from the trusted sources alone (VS-33)", () => {
    const entry = { id: "amazon-bedrock", operator: "aws", project: "123456789012", verify: "api" as const }
    const local = mergeReviewConfig({ surface: "local", global: { zdrAttested: ["openrouter", entry] } })
    expect(local.config.zdrAttested).toEqual(["openrouter", entry])
    expect(local.warnings).toEqual([])
    const text = JSON.stringify({ zdrAttested: [entry, "openrouter"] })
    const base = mergeReviewConfig({ surface: "github", json: { at: "base", text } })
    expect(base.config.zdrAttested).toEqual([entry, "openrouter"])
    expect(base.warnings).toEqual([])
    // Every other source is ignored with today's warning: a working tree, the CLI's base with --pr and the desktop's
    // base blob locally, and the global config, a working tree or a base blob read for privacy alone in CI.
    const onlyGlobal = `"zdrAttested" is read only from the global config.`
    const onlyBase = `"zdrAttested" is read only from ${REVIEW_CONFIG_PATH} on the base branch.`
    const ignored: [Parameters<typeof mergeReviewConfig>[0], string][] = [
      [
        { surface: "local", json: { at: "working-tree", text } },
        `${REVIEW_CONFIG_PATH}: "zdrAttested" is ignored: ${onlyGlobal}`,
      ],
      [
        { surface: "local", json: { at: "base", text } },
        `${REVIEW_CONFIG_PATH}: "zdrAttested" is ignored: ${onlyGlobal}`,
      ],
      [
        { surface: "local", json: { at: "base", text, privacyOnly: true } },
        `${REVIEW_CONFIG_PATH}: "zdrAttested" is ignored: ${onlyGlobal}`,
      ],
      [
        { surface: "github", json: { at: "working-tree", text } },
        `${REVIEW_CONFIG_PATH}: "zdrAttested" is ignored: ${onlyBase}`,
      ],
      [
        { surface: "github", json: { at: "base", text, privacyOnly: true } },
        `${REVIEW_CONFIG_PATH}: "zdrAttested" is ignored: ${onlyBase}`,
      ],
      [
        { surface: "github", global: { zdrAttested: [entry] } },
        `review.zdrAttested in the global config is ignored: ${onlyBase}`,
      ],
    ]
    for (const [input, warning] of ignored) {
      const result = mergeReviewConfig(input)
      expect(Object.hasOwn(result.config, "zdrAttested")).toBe(false)
      expect(result.warnings).toEqual([warning])
    }
    // No environment variable is read for it, in any shape.
    const env = mergeReviewConfig({ surface: "github", env: { REVIEW_ZDR_ATTESTED: JSON.stringify([entry]) } })
    expect(Object.hasOwn(env.config, "zdrAttested")).toBe(false)
    expect(env.warnings).toEqual([])
  })

  test("an attestation object the rules cannot read is dropped with its reason, never with its other fields", () => {
    const label = "review.zdrAttested in the global config"
    const result = mergeReviewConfig({
      surface: "local",
      global: {
        zdrAttested: [
          { id: "amazon-bedrock", project: "123456789012" },
          "openrouter",
          { id: "https://api.openai.com", operator: "openai", project: "proj_secret" },
          { id: "openai", operator: "openai", regoin: "eu", project: "proj_secret" },
          { id: "vertex", operator: "google", project: 42 },
          { operator: "aws", project: "123456789012" },
        ],
      },
    })
    expect(result.config.zdrAttested).toEqual(["openrouter"])
    expect(result.warnings).toEqual([
      `${label}: the entry for "amazon-bedrock" has no "operator", the platform operator that processes the data, so it was dropped; entry 3 has an "id" that names neither a provider ID nor a host, so it was dropped; the entry for "openai" has the unknown key "regoin", so it was dropped; the entry for "vertex" has a "project" that is not text, so it was dropped; entry 6 has no "id", so it was dropped.`,
    ])
    // A project can be an account ID, and a run log can be public.
    for (const value of ["123456789012", "proj_secret", "42"]) expect(result.warnings.join("\n")).not.toContain(value)
    // An attestation list whose every entry was dropped is left out like the default.
    const none = mergeReviewConfig({ surface: "github", json: { at: "base", text: '{"zdrAttested": [{"id": "x"}]}' } })
    expect(Object.hasOwn(none.config, "zdrAttested")).toBe(false)
    expect(none.warnings).toEqual([
      `${REVIEW_CONFIG_PATH}: "zdrAttested": the entry for "x" has no "operator", the platform operator that processes the data, so it was dropped.`,
    ])
  })

  test("zdrAttested's notes keep their order, and name an ID that text and an object share", () => {
    const label = "review.zdrAttested in the global config"
    const flagged = { id: "openai", operator: "openai", extendedCache: true }
    const eu = { id: "openrouter", operator: "openrouter", region: "eu" as const }
    const result = mergeReviewConfig({
      surface: "local",
      global: {
        zdrAttested: [
          flagged,
          "openai",
          1,
          "gpu box",
          { id: "openai" },
          eu,
          { id: "openrouter", operator: "openrouter" },
          ["x"],
        ],
      },
    })
    expect(result.config.zdrAttested).toEqual([flagged, "openai", eu, { id: "openrouter", operator: "openrouter" }])
    expect(result.warnings).toEqual([
      `${label}: entries that are not text were dropped; "gpu box" names neither a provider ID nor a host, so it was dropped; write a server as its host, such as "gpu-box:8080"; the entry for "openai" has no "operator", the platform operator that processes the data, so it was dropped; "openai" is also listed as text, which accepts no "extendedCache", and the strictest of every entry that attests a route applies, whatever its ID; "openrouter" is listed more than once, and the strictest of every entry that attests a route applies, whatever its ID.`,
    ])
    // Without a model the config cannot tell that entries of other IDs attest the same route, so they get no note;
    // the notes above state the wider rule, and decideRoute applies it.
    const hosts = mergeReviewConfig({ surface: "local", global: { zdrAttested: [flagged, "api.openai.com"] } })
    expect(hosts.config.zdrAttested).toEqual([flagged, "api.openai.com"])
    expect(hosts.warnings).toEqual([])
    // Text alone keeps today's notes: a repeated name is not one.
    const repeated = mergeReviewConfig({ surface: "local", global: { zdrAttested: ["openai", " openai "] } })
    expect(repeated.config.zdrAttested).toEqual(["openai", "openai"])
    expect(repeated.warnings).toEqual([])
  })

  test("the desktop's base blob raises privacy, and changes nothing else", () => {
    const blob = mergeReviewConfig({
      surface: "local",
      json: { at: "base", text: '{"privacy": "zdr", "maxComments": 1, "zdrAttested": ["acme"]}', privacyOnly: true },
      trigger: "desktop",
    })
    expect(blob.config).toEqual({ ...parseReviewConfig({ trigger: "desktop" }).config, privacy: "zdr" })
    expect(blob.warnings).toEqual([
      `${REVIEW_CONFIG_PATH}: "zdrAttested" is ignored: "zdrAttested" is read only from the global config.`,
    ])
    // On any surface: a base blob read for privacy alone is never the trusted source of zdrAttested.
    const github = mergeReviewConfig({
      surface: "github",
      json: { at: "base", text: '{"zdrAttested":["openrouter"]}', privacyOnly: true },
    })
    expect(github.config).toEqual(parseReviewConfig({}).config)
    expect(github.config.zdrAttested).toBeUndefined()
    expect(github.warnings).toEqual([
      `${REVIEW_CONFIG_PATH}: "zdrAttested" is ignored: "zdrAttested" is read only from ${REVIEW_CONFIG_PATH} on the base branch.`,
    ])
    // With no review.json read at all, today's fallback, the global setting still applies.
    const fallback = mergeReviewConfig({ surface: "local", global: { privacy: "zdr" }, trigger: "desktop" })
    expect(fallback.config).toEqual({ ...DEFAULT_REVIEW_CONFIG, privacy: "zdr" })
    // A pull request's own review.json can never lower the base's or the global setting.
    for (const input of [{ global: { privacy: "zdr" } }, { env: { REVIEW_PRIVACY: "zdr" } }])
      expect(
        mergeReviewConfig({
          surface: "local",
          ...input,
          json: { at: "working-tree", text: '{"privacy": "standard"}' },
        }).config.privacy,
      ).toBe("zdr")
  })

  test("returns new arrays", () => {
    const global = { zdrAttested: ["openrouter"] }
    const result = mergeReviewConfig({ surface: "local", global })
    result.config.zdrAttested?.push("mutated")
    result.config.skipLabels.push("mutated")
    expect(global.zdrAttested).toEqual(["openrouter"])
    // And new attestation objects (VS-33).
    const entry = { id: "openrouter", operator: "openrouter" }
    const structured = mergeReviewConfig({ surface: "local", global: { zdrAttested: [entry] } })
    expect(structured.config.zdrAttested?.[0]).toEqual(entry)
    expect(structured.config.zdrAttested?.[0]).not.toBe(entry)
    expect(DEFAULT_REVIEW_CONFIG.skipLabels).toEqual(["vector:skip", "no-review"])
    expect(Object.hasOwn(DEFAULT_REVIEW_CONFIG, "zdrAttested")).toBe(false)
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

  // VS-43a: the same block as parts, each with where it came from, so citation.ts can read a rule's own scope.
  test("rulePartsForPaths gives the parts rulesForPaths joins, with their globs and review.json index", () => {
    const extra = [
      { path: "docs/**", instructions: "Docs only." },
      { path: "src/api/**", instructions: "  " },
      { path: "src/**", instructions: " Validate input. " },
    ]
    const changed = ["src/billing/charge.ts", "src/a.spec.ts", "README.md"]
    const parts = rulePartsForPaths(rules, changed, extra)
    expect(parts).toEqual([
      { from: "global", text: global },
      {
        from: "section",
        globs: ["src/billing/**"],
        text: "## path: src/billing/**\n- Money is integer cents. A float in this folder is blocking.",
      },
      {
        from: "section",
        globs: ["**/*.test.ts", "**/*.spec.ts"],
        text: "## path: **/*.test.ts, **/*.spec.ts\n- Don't ask for assertion messages.\n\n```md\n## path: fenced/**\n- This heading is an example, not a section.\n```",
      },
      // Entry 0 matches no changed file and entry 1 has no instructions; the index is the entry's own position.
      { from: "paths", index: 2, glob: "src/**", text: "## path: src/**\nValidate input." },
    ])
    expect(parts.map((part) => part.text).join("\n\n")).toBe(rulesForPaths(rules, changed, extra))
    expect(rulePartsForPaths(parseReviewRules(""), ["a.ts"])).toEqual([])
    for (const paths of [["README.md"], ["db/queries/q.sql"], [], ["src/billing/x.ts", "q.sql"]])
      expect(
        rulePartsForPaths(rules, paths, extra)
          .map((part) => part.text)
          .join("\n\n"),
      ).toBe(rulesForPaths(rules, paths, extra))
  })

  test("ruleGlobMatches reads a glob as rulesForPaths does", () => {
    expect(ruleGlobMatches("db/queries/q.sql", "*.sql")).toBe(true)
    expect(ruleGlobMatches("src/billing/charge.ts", "src/billing/**")).toBe(true)
    expect(ruleGlobMatches("src/.hidden/x.ts", "src/**")).toBe(true)
    expect(ruleGlobMatches("README.md", "src/**")).toBe(false)
    expect(ruleGlobMatches("lib/src/x.ts", "src/**")).toBe(false)
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

// VS-24c: `trivial` and `maxInputTokens` are parsed, and no runner reads them before VS-24 wiring. With neither set,
// nothing changes (I-1); with a value that would change a review, the parser says it is not applied yet.
describe("VS-24's keys", () => {
  const SKIP = '"trivial": "skip" is not applied yet: every change is still reviewed.'
  const CAP = '"maxInputTokens" is not applied yet: no input-token cap is enforced.'

  test("neither has a default entry, so the defaults and their digests stay as they were", () => {
    const { config, warnings } = parseReviewConfig()
    for (const key of ["trivial", "maxInputTokens"] as const) {
      expect(Object.hasOwn(DEFAULT_REVIEW_CONFIG, key)).toBe(false)
      expect(Object.hasOwn(config, key)).toBe(false)
    }
    expect(warnings).toEqual([])
    expect(OPTIONAL_REVIEW_DEFAULTS).toEqual({
      trivial: "review",
      maxInputTokens: 0,
      impact: "grep",
      guardrail: "off",
      scopeGate: "off",
      verifyEvidence: "off",
      depth: "fixed",
      lenses: "off",
      runtime: "off",
    })
  })

  test("review.json sets them, and a value that would change a review says it is not applied", () => {
    const set = parseReviewConfig({ json: JSON.stringify({ trivial: "skip", maxInputTokens: 200_000 }) })
    expect(set.config).toEqual({ ...DEFAULT_REVIEW_CONFIG, trivial: "skip", maxInputTokens: 200_000 })
    expect(set.warnings).toEqual([SKIP, CAP])
    // Their defaults, written out, change nothing a runner would do, so they warn about nothing.
    const defaults = parseReviewConfig({ json: JSON.stringify({ trivial: "review", maxInputTokens: 0 }) })
    expect(defaults.config).toEqual({ ...DEFAULT_REVIEW_CONFIG, trivial: "review", maxInputTokens: 0 })
    expect(defaults.warnings).toEqual([])
  })

  test("the environment overrides review.json, read without case or surrounding space", () => {
    const { config, warnings } = parseReviewConfig({
      json: JSON.stringify({ trivial: "review", maxInputTokens: 5 }),
      env: { REVIEW_TRIVIAL: " Skip ", REVIEW_MAX_INPUT_TOKENS: "1e5" },
    })
    expect(config.trivial).toBe("skip")
    expect(config.maxInputTokens).toBe(100_000)
    expect(warnings).toEqual([SKIP, CAP])
  })

  test("a bad value warns naming the value in use, which for an unset key is its default", () => {
    expect(parseReviewConfig({ json: JSON.stringify({ trivial: "sometimes", maxInputTokens: "lots" }) })).toEqual({
      config: DEFAULT_REVIEW_CONFIG,
      warnings: [
        `${REVIEW_CONFIG_PATH}: "trivial" must be "review", "skip"; using "review".`,
        `${REVIEW_CONFIG_PATH}: "maxInputTokens" must be a number of at least 0; using 0.`,
      ],
    })
    expect(parseReviewConfig({ env: { REVIEW_TRIVIAL: "always", REVIEW_MAX_INPUT_TOKENS: "abc" } })).toEqual({
      config: DEFAULT_REVIEW_CONFIG,
      warnings: [
        'REVIEW_TRIVIAL must be "review", "skip"; using "review".',
        "REVIEW_MAX_INPUT_TOKENS must be a number of at least 0; using 0.",
      ],
    })
    // A set value is the one named.
    expect(
      parseReviewConfig({ json: JSON.stringify({ trivial: "skip" }), env: { REVIEW_TRIVIAL: "x" } }).warnings,
    ).toEqual(['REVIEW_TRIVIAL must be "review", "skip"; using "skip".', SKIP])
    // A key with no default keeps today's text, which names nothing.
    expect(parseReviewConfig({ json: JSON.stringify({ model: "nope" }) }).warnings).toEqual([
      `${REVIEW_CONFIG_PATH}: "model" must be a "provider/model" string; using undefined.`,
    ])
  })

  test("a negative or fractional cap is clamped to a whole number of at least 0", () => {
    expect(parseReviewConfig({ env: { REVIEW_MAX_INPUT_TOKENS: "-5" } })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, maxInputTokens: 0 },
      warnings: ["REVIEW_MAX_INPUT_TOKENS: -5 is out of range; using 0."],
    })
    expect(parseReviewConfig({ json: JSON.stringify({ maxInputTokens: 1_000.6 }) })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, maxInputTokens: 1_001 },
      warnings: [`${REVIEW_CONFIG_PATH}: "maxInputTokens": 1000.6 is out of range; using 1001.`, CAP],
    })
  })

  test("mergeReviewConfig reads them as parseReviewConfig does, on every surface", () => {
    const text = JSON.stringify({ trivial: "skip", maxInputTokens: 50_000 })
    const env = { REVIEW_MAX_INPUT_TOKENS: "60000" }
    expect(mergeReviewConfig({ surface: "github", json: { at: "base", text }, env, trigger: "auto" })).toEqual(
      parseReviewConfig({ json: text, env, trigger: "auto" }),
    )
    expect(mergeReviewConfig({ surface: "local", json: { at: "working-tree", text }, trigger: "desktop" })).toEqual(
      parseReviewConfig({ json: text, trigger: "desktop" }),
    )
  })
})

// VS-25b: `impact` is parsed, and no runner reads it before VS-25b wiring. Unset, nothing changes (I-1); "graph" says it
// is not applied yet. A plain key: every surface reads it from review.json and REVIEW_IMPACT, as parseReviewConfig does.
describe("VS-25b's impact key", () => {
  const GRAPH = '"impact": "graph" is not applied yet: related code still comes from git grep.'

  test("has no default entry, so the defaults and their digests stay as they were", () => {
    const { config, warnings } = parseReviewConfig()
    expect(Object.hasOwn(DEFAULT_REVIEW_CONFIG, "impact")).toBe(false)
    expect(Object.hasOwn(config, "impact")).toBe(false)
    expect(warnings).toEqual([])
    expect(OPTIONAL_REVIEW_DEFAULTS.impact).toBe("grep")
  })

  test("review.json and REVIEW_IMPACT set it; graph says it is not applied, grep says nothing", () => {
    expect(parseReviewConfig({ json: JSON.stringify({ impact: "graph" }) })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, impact: "graph" },
      warnings: [GRAPH],
    })
    expect(parseReviewConfig({ json: JSON.stringify({ impact: "grep" }) })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, impact: "grep" },
      warnings: [],
    })
    const env = parseReviewConfig({ json: JSON.stringify({ impact: "grep" }), env: { REVIEW_IMPACT: " Graph " } })
    expect(env.config.impact).toBe("graph")
    expect(env.warnings).toEqual([GRAPH])
  })

  test("a bad value warns naming the value in use", () => {
    expect(parseReviewConfig({ json: JSON.stringify({ impact: "tree" }) })).toEqual({
      config: DEFAULT_REVIEW_CONFIG,
      warnings: [`${REVIEW_CONFIG_PATH}: "impact" must be "grep", "graph"; using "grep".`],
    })
    expect(
      parseReviewConfig({ json: JSON.stringify({ impact: "graph" }), env: { REVIEW_IMPACT: "x" } }).warnings,
    ).toEqual(['REVIEW_IMPACT must be "grep", "graph"; using "graph".', GRAPH])
  })

  test("mergeReviewConfig reads it as parseReviewConfig does, on every surface", () => {
    const text = JSON.stringify({ impact: "graph" })
    const env = { REVIEW_IMPACT: "grep" }
    expect(mergeReviewConfig({ surface: "github", json: { at: "base", text }, env, trigger: "auto" })).toEqual(
      parseReviewConfig({ json: text, env, trigger: "auto" }),
    )
    expect(mergeReviewConfig({ surface: "local", json: { at: "working-tree", text }, trigger: "desktop" })).toEqual(
      parseReviewConfig({ json: text, trigger: "desktop" }),
    )
  })
})

// VS-27a: `guardrail` is parsed, and no runner reads it before VS-27c. Unset, nothing changes (I-1); "strict" says it is
// not applied yet. A plain key: every surface reads it from review.json and REVIEW_GUARDRAIL, as parseReviewConfig does.
describe("VS-27's guardrail key", () => {
  const STRICT = '"guardrail": "strict" is not applied yet: findings are still selected and posted as before.'

  test("has no default entry, so the defaults and their digests stay as they were", () => {
    const { config, warnings } = parseReviewConfig()
    expect(Object.hasOwn(DEFAULT_REVIEW_CONFIG, "guardrail")).toBe(false)
    expect(Object.hasOwn(config, "guardrail")).toBe(false)
    expect(warnings).toEqual([])
    expect(OPTIONAL_REVIEW_DEFAULTS.guardrail).toBe("off")
    expect(UNAPPLIED_REVIEW_KEYS).toContain("guardrail")
    expect(SOURCED_REVIEW_KEYS).not.toContain("guardrail")
  })

  test("review.json and REVIEW_GUARDRAIL set it; strict says it is not applied, off says nothing", () => {
    expect(parseReviewConfig({ json: JSON.stringify({ guardrail: "strict" }) })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, guardrail: "strict" },
      warnings: [STRICT],
    })
    expect(parseReviewConfig({ json: JSON.stringify({ guardrail: "off" }) })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, guardrail: "off" },
      warnings: [],
    })
    const env = parseReviewConfig({ json: JSON.stringify({ guardrail: "off" }), env: { REVIEW_GUARDRAIL: " Strict " } })
    expect(env.config.guardrail).toBe("strict")
    expect(env.warnings).toEqual([STRICT])
    const lowered = parseReviewConfig({
      json: JSON.stringify({ guardrail: "strict" }),
      env: { REVIEW_GUARDRAIL: "off" },
    })
    expect(lowered).toEqual({ config: { ...DEFAULT_REVIEW_CONFIG, guardrail: "off" }, warnings: [] })
  })

  test("a bad value warns naming the value in use", () => {
    expect(parseReviewConfig({ json: JSON.stringify({ guardrail: "precise" }) })).toEqual({
      config: DEFAULT_REVIEW_CONFIG,
      warnings: [`${REVIEW_CONFIG_PATH}: "guardrail" must be "off", "strict"; using "off".`],
    })
    expect(parseReviewConfig({ json: JSON.stringify({ guardrail: true }) }).warnings).toEqual([
      `${REVIEW_CONFIG_PATH}: "guardrail" must be "off", "strict"; using "off".`,
    ])
    expect(
      parseReviewConfig({ json: JSON.stringify({ guardrail: "strict" }), env: { REVIEW_GUARDRAIL: "x" } }).warnings,
    ).toEqual(['REVIEW_GUARDRAIL must be "off", "strict"; using "strict".', STRICT])
  })

  test("mergeReviewConfig reads it as parseReviewConfig does, on every surface", () => {
    const text = JSON.stringify({ guardrail: "strict" })
    const env = { REVIEW_GUARDRAIL: "off" }
    expect(mergeReviewConfig({ surface: "github", json: { at: "base", text }, env, trigger: "auto" })).toEqual(
      parseReviewConfig({ json: text, env, trigger: "auto" }),
    )
    expect(mergeReviewConfig({ surface: "local", json: { at: "working-tree", text }, trigger: "desktop" })).toEqual(
      parseReviewConfig({ json: text, trigger: "desktop" }),
    )
  })
})

// VS-42a: `scopeGate` is parsed, and no runner reads it before VS-42 wiring. It acts inside the strict guardrail, so it
// is effective only with `guardrail: "strict"`: with it, the value says it is not applied yet; without it, it is ignored
// with a note, and the two warnings never appear together. A plain key with no environment variable.
describe("VS-42's scopeGate key", () => {
  const STRICT = '"guardrail": "strict" is not applied yet: findings are still selected and posted as before.'
  const UNAPPLIED =
    '"scopeGate": "introduced" is not applied yet: defects that already existed at the base are not dropped.'
  const IGNORED =
    '"scopeGate": "introduced" is ignored without "guardrail": "strict": the introduced-by-change check runs only inside the strict guardrail.'

  test("has no default entry, so the defaults and their digests stay as they were", () => {
    const { config, warnings } = parseReviewConfig()
    expect(Object.hasOwn(DEFAULT_REVIEW_CONFIG, "scopeGate")).toBe(false)
    expect(Object.hasOwn(config, "scopeGate")).toBe(false)
    expect(warnings).toEqual([])
    expect(OPTIONAL_REVIEW_DEFAULTS.scopeGate).toBe("off")
    expect(UNAPPLIED_REVIEW_KEYS).toContain("scopeGate")
    expect(SOURCED_REVIEW_KEYS).not.toContain("scopeGate")
  })

  test("under strict it says it is not applied; without strict it is ignored with a note, its value kept", () => {
    const json = (value: Record<string, unknown>) => parseReviewConfig({ json: JSON.stringify(value) })
    expect(json({ guardrail: "strict", scopeGate: "introduced" })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, guardrail: "strict", scopeGate: "introduced" },
      warnings: [STRICT, UNAPPLIED],
    })
    for (const value of [{ scopeGate: "introduced" }, { guardrail: "off", scopeGate: "introduced" }] as const)
      expect(json(value)).toEqual({ config: { ...DEFAULT_REVIEW_CONFIG, ...value }, warnings: [IGNORED] })
    expect(json({ scopeGate: "off" })).toEqual({ config: { ...DEFAULT_REVIEW_CONFIG, scopeGate: "off" }, warnings: [] })
    expect(json({ guardrail: "strict", scopeGate: "off" }).warnings).toEqual([STRICT])
    // REVIEW_GUARDRAIL decides which warning a review.json scopeGate gets.
    expect(
      parseReviewConfig({ json: JSON.stringify({ scopeGate: "introduced" }), env: { REVIEW_GUARDRAIL: "strict" } })
        .warnings,
    ).toEqual([STRICT, UNAPPLIED])
    expect(
      parseReviewConfig({
        json: JSON.stringify({ guardrail: "strict", scopeGate: "introduced" }),
        env: { REVIEW_GUARDRAIL: "off" },
      }).warnings,
    ).toEqual([IGNORED])
  })

  test("no environment variable sets it, and a bad value warns naming the value in use", () => {
    expect(parseReviewConfig({ env: { REVIEW_SCOPE_GATE: "introduced", REVIEW_SCOPEGATE: "introduced" } })).toEqual({
      config: DEFAULT_REVIEW_CONFIG,
      warnings: [],
    })
    expect(parseReviewConfig({ json: JSON.stringify({ guardrail: "strict", scopeGate: "on" }) })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, guardrail: "strict" },
      warnings: [`${REVIEW_CONFIG_PATH}: "scopeGate" must be "off", "introduced"; using "off".`, STRICT],
    })
  })

  test("mergeReviewConfig reads it as parseReviewConfig does, on every surface", () => {
    for (const text of [
      JSON.stringify({ scopeGate: "introduced" }),
      JSON.stringify({ guardrail: "strict", scopeGate: "introduced" }),
    ]) {
      expect(mergeReviewConfig({ surface: "github", json: { at: "base", text }, trigger: "auto" })).toEqual(
        parseReviewConfig({ json: text, trigger: "auto" }),
      )
      expect(mergeReviewConfig({ surface: "local", json: { at: "working-tree", text }, trigger: "desktop" })).toEqual(
        parseReviewConfig({ json: text, trigger: "desktop" }),
      )
    }
  })
})

// VS-44a: `verifyEvidence` is parsed as scopeGate is, and no runner reads it before VS-44 wiring. It acts inside the
// strict guardrail (S1's certificate check), so it is effective only with `guardrail: "strict"`: with it, the value says
// it is not applied yet; without it, it is ignored with a note. A plain key with no environment variable.
describe("VS-44's verifyEvidence key", () => {
  const STRICT = '"guardrail": "strict" is not applied yet: findings are still selected and posted as before.'
  const UNAPPLIED =
    '"verifyEvidence": "certificate" is not applied yet: verify verdicts are still read without a certificate.'
  const IGNORED =
    '"verifyEvidence": "certificate" is ignored without "guardrail": "strict": certificate-backed verification runs only inside the strict guardrail.'
  const GATE_UNAPPLIED =
    '"scopeGate": "introduced" is not applied yet: defects that already existed at the base are not dropped.'
  const GATE_IGNORED =
    '"scopeGate": "introduced" is ignored without "guardrail": "strict": the introduced-by-change check runs only inside the strict guardrail.'

  test("has no default entry, so the defaults and their digests stay as they were", () => {
    const { config, warnings } = parseReviewConfig()
    expect(Object.hasOwn(DEFAULT_REVIEW_CONFIG, "verifyEvidence")).toBe(false)
    expect(Object.hasOwn(config, "verifyEvidence")).toBe(false)
    expect(warnings).toEqual([])
    expect(OPTIONAL_REVIEW_DEFAULTS.verifyEvidence).toBe("off")
    expect(UNAPPLIED_REVIEW_KEYS).toContain("verifyEvidence")
    expect(SOURCED_REVIEW_KEYS).not.toContain("verifyEvidence")
  })

  test("under strict it says it is not applied; without strict it is ignored with a note, its value kept", () => {
    const json = (value: Record<string, unknown>) => parseReviewConfig({ json: JSON.stringify(value) })
    expect(json({ guardrail: "strict", verifyEvidence: "certificate" })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, guardrail: "strict", verifyEvidence: "certificate" },
      warnings: [STRICT, UNAPPLIED],
    })
    for (const value of [
      { verifyEvidence: "certificate" },
      { guardrail: "off", verifyEvidence: "certificate" },
    ] as const)
      expect(json(value)).toEqual({ config: { ...DEFAULT_REVIEW_CONFIG, ...value }, warnings: [IGNORED] })
    expect(json({ verifyEvidence: "off" })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, verifyEvidence: "off" },
      warnings: [],
    })
    expect(json({ guardrail: "strict", verifyEvidence: "off" }).warnings).toEqual([STRICT])
    // REVIEW_GUARDRAIL decides which warning a review.json verifyEvidence gets.
    expect(
      parseReviewConfig({
        json: JSON.stringify({ verifyEvidence: "certificate" }),
        env: { REVIEW_GUARDRAIL: "strict" },
      }).warnings,
    ).toEqual([STRICT, UNAPPLIED])
    expect(
      parseReviewConfig({
        json: JSON.stringify({ guardrail: "strict", verifyEvidence: "certificate" }),
        env: { REVIEW_GUARDRAIL: "off" },
      }).warnings,
    ).toEqual([IGNORED])
    // Beside VS-42's key, each gets its own warning, in the keys' order.
    expect(json({ guardrail: "strict", scopeGate: "introduced", verifyEvidence: "certificate" }).warnings).toEqual([
      STRICT,
      GATE_UNAPPLIED,
      UNAPPLIED,
    ])
    expect(json({ scopeGate: "introduced", verifyEvidence: "certificate" }).warnings).toEqual([GATE_IGNORED, IGNORED])
  })

  test("no environment variable sets it, and a bad value warns naming the value in use", () => {
    expect(
      parseReviewConfig({ env: { REVIEW_VERIFY_EVIDENCE: "certificate", REVIEW_VERIFYEVIDENCE: "certificate" } }),
    ).toEqual({ config: DEFAULT_REVIEW_CONFIG, warnings: [] })
    expect(parseReviewConfig({ json: JSON.stringify({ guardrail: "strict", verifyEvidence: "cert" }) })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, guardrail: "strict" },
      warnings: [`${REVIEW_CONFIG_PATH}: "verifyEvidence" must be "off", "certificate"; using "off".`, STRICT],
    })
  })

  test("mergeReviewConfig reads it as parseReviewConfig does, on every surface", () => {
    for (const text of [
      JSON.stringify({ verifyEvidence: "certificate" }),
      JSON.stringify({ guardrail: "strict", verifyEvidence: "certificate" }),
    ]) {
      expect(mergeReviewConfig({ surface: "github", json: { at: "base", text }, trigger: "auto" })).toEqual(
        parseReviewConfig({ json: text, trigger: "auto" }),
      )
      expect(mergeReviewConfig({ surface: "local", json: { at: "working-tree", text }, trigger: "desktop" })).toEqual(
        parseReviewConfig({ json: text, trigger: "desktop" }),
      )
    }
  })
})

// VS-28c: `depth` and `lenses` are parsed, and no runner reads them before VS-28 wiring. `lenses` acts only under
// `depth: "auto"`, so without it the key is ignored with a note; under "auto", an explicit `security: "off"` is said,
// since no band then adds the security pass (gap-6 G6-2: a depth that cannot run in full says so).
describe("VS-28's depth and lenses keys", () => {
  const DEPTH = '"depth": "auto" is not applied yet: every review still runs its usual passes.'
  const LENSES = '"lenses": "high" is not applied yet: no lens passes run.'
  const IGNORED =
    '"lenses": "high" is ignored without "depth": "auto": lens passes run only on the high band of an automatic depth.'
  const OFF = '"depth": "auto" keeps "security": "off": no band adds the security pass.'
  const OFF_LENSES = '"depth": "auto" keeps "security": "off": no band adds the security pass or the access lens.'
  const json = (value: Record<string, unknown>, env?: Record<string, string>) =>
    parseReviewConfig({ json: JSON.stringify(value), env })

  test("neither has a default entry, so the defaults and their digests stay as they were", () => {
    const { config, warnings } = parseReviewConfig()
    for (const key of ["depth", "lenses"] as const) {
      expect(Object.hasOwn(DEFAULT_REVIEW_CONFIG, key)).toBe(false)
      expect(Object.hasOwn(config, key)).toBe(false)
      expect(UNAPPLIED_REVIEW_KEYS).toContain(key)
      expect(SOURCED_REVIEW_KEYS).not.toContain(key)
    }
    expect(warnings).toEqual([])
    expect(OPTIONAL_REVIEW_DEFAULTS.depth).toBe("fixed")
    expect(OPTIONAL_REVIEW_DEFAULTS.lenses).toBe("off")
  })

  test("under auto each says it is not applied; lenses without auto is ignored with a note, its value kept", () => {
    expect(json({ depth: "auto" })).toEqual({ config: { ...DEFAULT_REVIEW_CONFIG, depth: "auto" }, warnings: [DEPTH] })
    expect(json({ depth: "auto", lenses: "high" })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, depth: "auto", lenses: "high" },
      warnings: [DEPTH, LENSES],
    })
    for (const value of [{ lenses: "high" }, { depth: "fixed", lenses: "high" }] as const)
      expect(json(value)).toEqual({ config: { ...DEFAULT_REVIEW_CONFIG, ...value }, warnings: [IGNORED] })
    // Their defaults, written out, change nothing a runner would do, so they warn about nothing.
    expect(json({ depth: "fixed", lenses: "off" })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, depth: "fixed", lenses: "off" },
      warnings: [],
    })
    expect(json({ depth: "auto", lenses: "off" }).warnings).toEqual([DEPTH])
  })

  test("REVIEW_DEPTH and REVIEW_LENSES override review.json, read without case or surrounding space", () => {
    expect(json({ lenses: "high" }, { REVIEW_DEPTH: " Auto " })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, depth: "auto", lenses: "high" },
      warnings: [DEPTH, LENSES],
    })
    expect(json({ depth: "auto", lenses: "high" }, { REVIEW_DEPTH: "fixed" }).warnings).toEqual([IGNORED])
    expect(json({ depth: "auto" }, { REVIEW_LENSES: "HIGH" }).config.lenses).toBe("high")
    expect(json({ depth: "auto", lenses: "high" }, { REVIEW_LENSES: "off" }).warnings).toEqual([DEPTH])
  })

  test("an explicit security off under auto is said, never silently less", () => {
    expect(json({ depth: "auto", security: "off" })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, depth: "auto", security: "off" },
      warnings: [OFF, DEPTH],
    })
    expect(json({ depth: "auto", lenses: "high", security: "off" }).warnings).toEqual([OFF_LENSES, DEPTH, LENSES])
    expect(json({ depth: "auto" }, { REVIEW_SECURITY: "off" }).warnings).toEqual([OFF, DEPTH])
    // Without auto, or with security on, there is nothing to say.
    for (const value of [
      { security: "off" },
      { depth: "fixed", security: "off" },
      { depth: "auto", security: "always" },
    ])
      expect(json(value).warnings).not.toContain(OFF)
  })

  test("a bad value warns naming the value in use", () => {
    expect(json({ depth: "deep", lenses: "on" })).toEqual({
      config: DEFAULT_REVIEW_CONFIG,
      warnings: [
        `${REVIEW_CONFIG_PATH}: "depth" must be "fixed", "auto"; using "fixed".`,
        `${REVIEW_CONFIG_PATH}: "lenses" must be "off", "high"; using "off".`,
      ],
    })
    expect(parseReviewConfig({ env: { REVIEW_DEPTH: "risk" } }).warnings).toEqual([
      'REVIEW_DEPTH must be "fixed", "auto"; using "fixed".',
    ])
  })

  test("mergeReviewConfig reads them as parseReviewConfig does, on every surface", () => {
    for (const text of [
      JSON.stringify({ depth: "auto" }),
      JSON.stringify({ lenses: "high" }),
      JSON.stringify({ depth: "auto", lenses: "high", security: "off" }),
    ]) {
      expect(mergeReviewConfig({ surface: "github", json: { at: "base", text }, trigger: "auto" })).toEqual(
        parseReviewConfig({ json: text, trigger: "auto" }),
      )
      expect(mergeReviewConfig({ surface: "local", json: { at: "working-tree", text }, trigger: "desktop" })).toEqual(
        parseReviewConfig({ json: text, trigger: "desktop" }),
      )
    }
  })
})

// VS-30c: `runtime` is trusted-only (contract §1.1, invariant I-2), so parseReviewConfig never reads it and
// mergeReviewConfig takes it from the surface's trusted source alone. No runner applies it before the VS-30 executor,
// and whether a review may run checks at all (consent, --pr, CI) stays the executor's decision (Q8).
describe("VS-30's runtime key", () => {
  const ASK = '"runtime": "ask" is not applied yet: no runtime checks run, and --checks works as before.'
  const ONLY_GLOBAL = '"runtime" is read only from the global config.'
  const ONLY_BASE = `"runtime" is read only from ${REVIEW_CONFIG_PATH} on the base branch.`
  const ASK_JSON = '{"runtime": "ask"}'

  test("is sourced and unapplied, with no default entry", () => {
    expect(SOURCED_REVIEW_KEYS).toContain("runtime")
    expect(UNAPPLIED_REVIEW_KEYS).toContain("runtime")
    expect(OPTIONAL_REVIEW_DEFAULTS.runtime).toBe("off")
    expect(Object.hasOwn(DEFAULT_REVIEW_CONFIG, "runtime")).toBe(false)
    expect(Object.hasOwn(parseReviewConfig().config, "runtime")).toBe(false)
  })

  test("parseReviewConfig ignores it in review.json, as before, and reads no environment variable", () => {
    expect(parseReviewConfig({ json: ASK_JSON })).toEqual({
      config: DEFAULT_REVIEW_CONFIG,
      warnings: [`${REVIEW_CONFIG_PATH}: unknown key "runtime" is ignored.`],
    })
    expect(parseReviewConfig({ env: { REVIEW_RUNTIME: "ask", REVIEW_CHECKS: "ask" } })).toEqual({
      config: DEFAULT_REVIEW_CONFIG,
      warnings: [],
    })
  })

  test("locally, it comes only from the global config, and says it is not applied", () => {
    expect(mergeReviewConfig({ surface: "local", global: { runtime: "ask" } })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, runtime: "ask" },
      warnings: [ASK],
    })
    // Your working tree, the base a pull request is reviewed against, and the desktop's base blob.
    for (const json of [
      { at: "working-tree" as const, text: ASK_JSON },
      { at: "base" as const, text: ASK_JSON },
      { at: "base" as const, text: ASK_JSON, privacyOnly: true },
    ]) {
      const result = mergeReviewConfig({ surface: "local", json, trigger: "desktop" })
      expect(Object.hasOwn(result.config, "runtime")).toBe(false)
      expect(result.warnings).toEqual([`${REVIEW_CONFIG_PATH}: "runtime" is ignored: ${ONLY_GLOBAL}`])
    }
    // The working tree can neither raise nor lower the global setting.
    const lowered = mergeReviewConfig({
      surface: "local",
      global: { runtime: "ask" },
      json: { at: "working-tree", text: '{"runtime": "off"}' },
    })
    expect(lowered.config.runtime).toBe("ask")
    expect(lowered.warnings).toEqual([`${REVIEW_CONFIG_PATH}: "runtime" is ignored: ${ONLY_GLOBAL}`, ASK])
    // No environment variable is read for it.
    const env = mergeReviewConfig({ surface: "local", env: { REVIEW_RUNTIME: "ask", RUNTIME: "ask" } })
    expect(env).toEqual(parseReviewConfig())
  })

  test("in CI, it comes only from the base branch's review.json", () => {
    expect(mergeReviewConfig({ surface: "github", json: { at: "base", text: ASK_JSON }, trigger: "auto" })).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, runtime: "ask" },
      warnings: [ASK],
    })
    const global = mergeReviewConfig({ surface: "github", global: { runtime: "ask" } })
    expect(Object.hasOwn(global.config, "runtime")).toBe(false)
    expect(global.warnings).toEqual([`review.runtime in the global config is ignored: ${ONLY_BASE}`])
    for (const json of [
      { at: "working-tree" as const, text: ASK_JSON },
      { at: "base" as const, text: ASK_JSON, privacyOnly: true },
    ]) {
      const result = mergeReviewConfig({ surface: "github", json })
      expect(Object.hasOwn(result.config, "runtime")).toBe(false)
      expect(result.warnings).toEqual([`${REVIEW_CONFIG_PATH}: "runtime" is ignored: ${ONLY_BASE}`])
    }
    const env = mergeReviewConfig({ surface: "github", env: { REVIEW_RUNTIME: "ask" } })
    expect(env).toEqual(parseReviewConfig())
  })

  test("a value that is not off or ask is ignored", () => {
    const label = "review.runtime in the global config"
    for (const runtime of ["yes", "ASK", true, 1, ["ask"], null])
      expect(mergeReviewConfig({ surface: "local", global: { runtime } })).toEqual({
        config: DEFAULT_REVIEW_CONFIG,
        warnings: [`${label} must be "off", "ask"; it is ignored.`],
      })
    expect(mergeReviewConfig({ surface: "github", json: { at: "base", text: '{"runtime": "on"}' } })).toEqual({
      config: DEFAULT_REVIEW_CONFIG,
      warnings: [`${REVIEW_CONFIG_PATH}: "runtime" must be "off", "ask"; it is ignored.`],
    })
  })

  test("an explicit off is left out, like its default, so the result is parseReviewConfig's", () => {
    expect(mergeReviewConfig({ surface: "local", global: { runtime: "off" } })).toEqual(parseReviewConfig())
    expect(mergeReviewConfig({ surface: "github", json: { at: "base", text: '{"runtime": "off"}' } })).toEqual(
      parseReviewConfig({ json: "{}" }),
    )
    // Beside the other sourced keys, each keeps its own rule.
    expect(
      mergeReviewConfig({ surface: "local", global: { runtime: "ask", zdrAttested: ["openrouter"], privacy: "zdr" } }),
    ).toEqual({
      config: { ...DEFAULT_REVIEW_CONFIG, privacy: "zdr", zdrAttested: ["openrouter"], runtime: "ask" },
      warnings: [ASK],
    })
    expect(mergeReviewConfig({ surface: "local", global: { runtime: "off", zdrAttested: [] } })).toEqual(
      parseReviewConfig(),
    )
  })

  test("a base review.json that cannot be read leaves it unset, even when it mentions it", () => {
    const result = mergeReviewConfig({ surface: "github", json: { at: "base", text: '{"runtime": "ask",' } })
    expect(Object.hasOwn(result.config, "runtime")).toBe(false)
    expect(result.config).toEqual(DEFAULT_REVIEW_CONFIG)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toStartWith(`${REVIEW_CONFIG_PATH} is not valid JSON`)
  })
})
