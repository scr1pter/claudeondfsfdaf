import { expect, test } from "bun:test"
import { trustedRules } from "@vectordevai/core/review/citation"
import { safeRulePrompt } from "@vectordevai/core/review/holdback"
import {
  mergeReviewConfig,
  parseReviewConfig,
  parseReviewRules,
  rulePromptInput,
} from "@vectordevai/core/review/config"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { evidenceScope } from "@vectordevai/core/review/model-evidence"
import { MAX_TRUSTED_CHARS } from "@vectordevai/core/review/prompt"
import {
  decodeReport,
  REVIEW_REPORT_JSON_SCHEMA,
  strictReportJsonSchema,
  strictResultJsonSchema,
} from "@vectordevai/core/review/schema"
import { checkedRuleFindings, selectFindings, ruleCheckNotes } from "@vectordevai/core/review/select"
import { DEFAULT_REVIEW_CONFIG, type Finding } from "@vectordevai/core/review/types"

const config = {
  ...DEFAULT_REVIEW_CONFIG,
  ruleCheck: "strict" as const,
  paths: [
    { path: "docs/**", instructions: "Use complete sentences." },
    { path: "src/**", instructions: "Preserve call order." },
  ],
}
const anchors = parseUnifiedDiff(
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
)
const model = {
  path: "src/a.ts",
  line: 1,
  severity: "blocking",
  category: "docs",
  title: "Order",
  body: "Preserve order",
  confidence: 1,
}
const report = (rule: unknown, category = "docs") => ({
  summary: "",
  risk: "low",
  files: [],
  findings: [{ ...model, category, rule }],
})
const text = { source: "paths[1]", quote: "Preserve call order." }
const blocks = rulePromptInput(parseReviewRules(""), ["src/a.ts", "docs/a.md"], config)
const trusted = trustedRules({ ...blocks, parts: blocks.ruleParts, anchors, rulesSource: "base branch" })

test("ruleCheck accepts only local owner settings or a proven base; no environment override", () => {
  const json = { at: "working-tree" as const, text: '{"ruleCheck":"strict"}' }
  const env = { REVIEW_RULE_CHECK: "strict", REVIEW_RULECHECK: "strict" }
  expect(mergeReviewConfig({ surface: "local", json, env }).config).toEqual(DEFAULT_REVIEW_CONFIG)
  expect(mergeReviewConfig({ surface: "local", global: { ruleCheck: "strict" }, json, env }).config.ruleCheck).toBe(
    "strict",
  )
  expect(
    mergeReviewConfig({ surface: "github", global: { ruleCheck: "strict" }, json, env }).config.ruleCheck,
  ).toBeUndefined()
  expect(mergeReviewConfig({ surface: "github", json: { ...json, at: "base" }, env }).config.ruleCheck).toBe("strict")
  expect(
    mergeReviewConfig({ surface: "github", json: { ...json, at: "base", privacyOnly: true }, env }).config.ruleCheck,
  ).toBeUndefined()
  const base = { at: "base" as const, text: '{"ruleCheck":"strict","runtime":"ask"}' }
  expect(mergeReviewConfig({ surface: "local", json: base }).config).toEqual({
    ...DEFAULT_REVIEW_CONFIG,
    ruleCheck: "strict",
  })
  for (const candidate of [
    { ...base, at: "snapshot" as const },
    { ...base, privacyOnly: true },
  ]) {
    expect(mergeReviewConfig({ surface: "local", json: candidate }).config).toEqual(DEFAULT_REVIEW_CONFIG)
  }
  expect(parseReviewConfig({ json: json.text, trigger: "auto", env }).config.ruleCheck).toBeUndefined()
  expect(mergeReviewConfig({ surface: "local", global: { ruleCheck: "incorrect" } }).warnings.join(" ")).toContain(
    "must be",
  )
  expect(mergeReviewConfig({ surface: "local", global: { ruleCheck: "off" }, env }).config).toEqual(
    DEFAULT_REVIEW_CONFIG,
  )
})

test("ruleCheck has an independent structured schema, stable defaults and a source-bound evidence digest", () => {
  expect(strictReportJsonSchema({ ruleCheck: "off" })).toBeUndefined()
  const properties = strictReportJsonSchema(config)!.properties.findings.items.properties
  expect(properties.rule.type).toBe("object")
  expect(properties).not.toHaveProperty("failure")
  expect(REVIEW_REPORT_JSON_SCHEMA.properties.findings.items.properties.rule.type).toBe("string")
  expect(strictResultJsonSchema(config)).toBeUndefined()
  expect(
    strictResultJsonSchema({ ...config, guardrail: "strict" })!.properties.findings.items.properties,
  ).toHaveProperty("linkedRule")
  expect(decodeReport(report(text))!.findings[0]).not.toHaveProperty("citation")
  expect(decodeReport(report("quoted"), { ruleCheck: "off" })!.findings[0]?.rule).toBe("quoted")
  for (const adapter of ["engine", "desktop"] as const) {
    const scope = (value: typeof DEFAULT_REVIEW_CONFIG) => evidenceScope({ adapter, config: value })
    const d3 = scope(DEFAULT_REVIEW_CONFIG)
    expect(scope({ ...DEFAULT_REVIEW_CONFIG, ruleCheck: "off" })).toEqual(d3)
    const active = scope({ ...DEFAULT_REVIEW_CONFIG, ruleCheck: "strict" })
    expect(active.prompts).not.toBe(d3.prompts)
    expect(active.policy).not.toBe(d3.policy)
  }
})

test("ruleCheck admits only an exact applicable line with provenance and never raises severity", () => {
  expect(blocks.rules).toContain("## paths[1]")
  const decoded = (rule: unknown, category?: string) => decodeReport(report(rule, category), config)!.findings[0]!
  const result = checkedRuleFindings(
    [
      decoded(text),
      decoded({ ...text, source: "paths[0]", quote: "Use complete sentences." }),
      decoded({ ...text, quote: "an invented directive" }, "bug"),
      decoded("unstructured", "docs"),
      decoded({ ...text, source: "scoped:src/AGENTS.md" }, "docs"),
    ],
    trusted,
  )
  expect(result).toMatchObject({
    dropped: 3,
    stripped: 1,
    problems: { scope: 1, misquote: 1, "not-structured": 1, source: 1 },
  })
  expect(result.findings).toHaveLength(2)
  expect(result.findings[0]).toMatchObject({
    rule: text.quote,
    citation: { source: { kind: "paths", index: 1 } },
    rulesSource: "base branch",
    severity: "concern",
  })
  expect(result.findings[1]).toMatchObject({ category: "bug", severity: "blocking" })
  expect(JSON.stringify(result.findings)).not.toContain("invented")
  expect(ruleCheckNotes([result]).join(" ")).toContain("not-structured 1")
  const findings: Finding[] = result.findings.map((finding, i) => ({
    ...finding,
    id: String(i),
    side: "RIGHT",
    source: "review",
  }))
  const selection = selectFindings({
    findings,
    anchors,
    head: "a",
    trust: "trusted",
    mode: "full",
    config,
    trustedRules: trusted,
    ruleCounts: [result],
  })
  expect(selection.dropped).toContainEqual({ reason: "rule-unverified", count: 3 })
  const clipped = trustedRules({ instructions: "a".repeat(MAX_TRUSTED_CHARS) + "\n\n" + text.quote, anchors })
  expect(checkedRuleFindings([decoded({ ...text, source: "repository_instructions" })], clipped).problems.clipped).toBe(
    1,
  )
})

test("ruleCheck holdback omits a sensitive trusted block before clipping or checking its quotes", () => {
  const marker = "ghp_" + "R".repeat(36)
  const unsafe = { ...blocks, rules: blocks.rules + "\n" + marker, instructions: "Independent owner rule." }
  const safe = safeRulePrompt(unsafe, { ...config, holdback: "secrets" })
  expect(safe).toEqual({ instructions: "Independent owner rule.", rules: "", ruleParts: [] })
  // scope-finish takeover (2026-11-23): without rule citations nothing refers to these blocks' offsets, so they keep
  // their text with the values redacted in place. They used to pass through raw, credential and all.
  const unchecked = safeRulePrompt(
    { ...unsafe, instructions: `Deploy with ${marker} only.` },
    { ruleCheck: "off", holdback: "secrets" },
  )
  expect(unchecked.rules).toBe(blocks.rules + "\n[redacted]")
  expect(unchecked.instructions).toBe("Deploy with [redacted] only.")
  expect(JSON.stringify(unchecked)).not.toContain(marker)
  expect(safeRulePrompt(unsafe, { ruleCheck: "off", holdback: "off" })).toBe(unsafe)
  expect(safeRulePrompt(unsafe, { ruleCheck: "strict", holdback: "off" })).toBe(unsafe)
})
