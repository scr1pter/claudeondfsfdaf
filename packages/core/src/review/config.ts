// `.vector/review.json` with its environment overrides, and the plain-English rules in `.vector/review.md`. Parsing
// is lenient: bad input falls back to the defaults and becomes a warning for the run log, never an error on the pull
// request. Pure and browser-safe.

import { minimatch } from "minimatch"
import { DEFAULT_REVIEW_CONFIG, SEVERITIES, SHARED_VERIFY_DEFAULT, type ReviewConfig, type Trigger } from "./types"

export const REVIEW_CONFIG_PATH = ".vector/review.json"
export const REVIEW_RULES_PATHS = [".vector/review.md", ".vector/REVIEW.md"] as const
export const MAX_RULES_BYTES = 16 * 1024

type Parsed = { value: unknown; note?: string } | undefined
type Field = { parse: (value: unknown) => Parsed; expected: string }

const bool: Field = {
  parse: (value) => (typeof value === "boolean" ? { value } : undefined),
  expected: "true or false",
}

function oneOf(values: readonly string[]): Field {
  return {
    parse: (value) => (typeof value === "string" && values.includes(value) ? { value } : undefined),
    expected: values.map((item) => `"${item}"`).join(", "),
  }
}

function number(opts: { min: number; max?: number; integer?: boolean }): Field {
  const max = opts.max ?? Infinity
  return {
    parse: (value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined
      const rounded = opts.integer ? Math.round(value) : value
      const clamped = Math.min(max, Math.max(opts.min, rounded))
      return { value: clamped, note: clamped === value ? undefined : `${value} is out of range; using ${clamped}` }
    },
    expected: max === Infinity ? `a number of at least ${opts.min}` : `a number from ${opts.min} to ${max}`,
  }
}

const strings: Field = {
  parse: (value) => {
    if (!Array.isArray(value)) return undefined
    const kept = value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    return {
      value: kept.map((item) => item.trim()),
      note: kept.length === value.length ? undefined : "entries that are not text were dropped",
    }
  },
  expected: "a list of strings",
}

const model: Field = {
  parse: (value) =>
    typeof value === "string" && /^[^/\s]+\/\S+$/.test(value.trim()) ? { value: value.trim() } : undefined,
  expected: 'a "provider/model" string',
}

const paths: Field = {
  parse: (value) => {
    if (!Array.isArray(value)) return undefined
    const kept = value.filter(
      (item): item is { path: string; instructions: string } =>
        !!item &&
        typeof item === "object" &&
        typeof item.path === "string" &&
        item.path.trim() !== "" &&
        typeof item.instructions === "string",
    )
    return {
      value: kept.map((item) => ({ path: item.path.trim(), instructions: item.instructions })),
      note: kept.length === value.length ? undefined : 'entries without a "path" and "instructions" were dropped',
    }
  },
  expected: 'a list of { "path", "instructions" } objects',
}

const FIELDS: Record<keyof ReviewConfig, Field> = {
  incremental: bool,
  minSeverity: oneOf(SEVERITIES),
  minConfidence: number({ min: 0, max: 1 }),
  maxComments: number({ min: 0, max: 50, integer: true }),
  maxCommentsPerPr: number({ min: 0, integer: true }),
  suggestions: bool,
  replyOnFix: bool,
  security: oneOf(["auto", "always", "off"]),
  verify: oneOf(["blocking", "all", "off"]),
  verifyPolicy: oneOf(["legacy", "shared"]),
  failOn: oneOf(["never", "blocking"]),
  ignore: strings,
  ignoreDefaults: bool,
  skipAuthors: strings,
  skipLabels: strings,
  skipBranches: strings,
  maxFiles: number({ min: 1, integer: true }),
  maxChangedLines: number({ min: 1, integer: true }),
  // diffBudgetChars never goes below 8,000 characters, so a lower cap would do nothing.
  maxDiffChars: number({ min: 8_000, integer: true }),
  maxSteps: number({ min: 1, max: 200, integer: true }),
  maxCostUsd: number({ min: 0 }),
  maxCostUsdPerPr: number({ min: 0 }),
  maxCostUsdPerMonth: number({ min: 0 }),
  timeoutMinutes: number({ min: 1, max: 120 }),
  model,
  triageModel: model,
  nits: bool,
  paths,
}

// Settings the workflow now owns. They get their own warning instead of "unknown key".
const RETIRED: Record<string, string> = {
  auto: '"auto" is no longer read: whether reviews run on every pull request is set in .github/workflows/vector.yml. Run `vector github install` again to change it.',
  drafts:
    '"drafts" is no longer read: to review drafts, delete the `draft == false` line in .github/workflows/vector.yml.',
}

const ENV: { name: string; key: keyof ReviewConfig; kind: "number" | "text" }[] = [
  { name: "REVIEW_MIN_SEVERITY", key: "minSeverity", kind: "text" },
  { name: "REVIEW_MIN_CONFIDENCE", key: "minConfidence", kind: "number" },
  { name: "REVIEW_MAX_COMMENTS", key: "maxComments", kind: "number" },
  { name: "REVIEW_SECURITY", key: "security", kind: "text" },
  { name: "REVIEW_VERIFY", key: "verify", kind: "text" },
  { name: "REVIEW_VERIFY_POLICY", key: "verifyPolicy", kind: "text" },
  { name: "REVIEW_FAIL_ON", key: "failOn", kind: "text" },
  { name: "REVIEW_MAX_COST_USD", key: "maxCostUsd", kind: "number" },
  { name: "REVIEW_MAX_COST_USD_PER_PR", key: "maxCostUsdPerPr", kind: "number" },
  { name: "REVIEW_MAX_COST_USD_PER_MONTH", key: "maxCostUsdPerMonth", kind: "number" },
  { name: "REVIEW_TIMEOUT_MINUTES", key: "timeoutMinutes", kind: "number" },
]

function assign(config: ReviewConfig, key: keyof ReviewConfig, value: unknown, label: string, warnings: string[]) {
  const parsed = FIELDS[key].parse(value)
  if (!parsed) {
    warnings.push(`${label} must be ${FIELDS[key].expected}; using ${JSON.stringify(config[key])}.`)
    return
  }
  if (parsed.note) warnings.push(`${label}: ${parsed.note}.`)
  Object.assign(config, { [key]: parsed.value })
}

// The verify policy the passes in parseReviewConfig will settle on: a valid REVIEW_VERIFY_POLICY, then a valid
// "verifyPolicy" in review.json, then the default.
function verifyPolicyOf(
  source: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
): ReviewConfig["verifyPolicy"] {
  const parse = (value: unknown) => FIELDS.verifyPolicy.parse(value)?.value as ReviewConfig["verifyPolicy"] | undefined
  const raw = env.REVIEW_VERIFY_POLICY?.trim()
  return (
    (raw ? parse(raw.toLowerCase()) : undefined) ??
    (source && Object.hasOwn(source, "verifyPolicy") ? parse(source.verifyPolicy) : undefined) ??
    DEFAULT_REVIEW_CONFIG.verifyPolicy
  )
}

function readJson(text: string | undefined, warnings: string[]): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warnings.push(`${REVIEW_CONFIG_PATH} is not valid JSON (${reason}); using the defaults.`)
    return undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`${REVIEW_CONFIG_PATH} must hold a JSON object; using the defaults.`)
    return undefined
  }
  return value as Record<string, unknown>
}

// Precedence: environment variables, then review.json, then DEFAULT_REVIEW_CONFIG. `json` is the file's text, or
// undefined when there is none. REVIEW_AUTO_MODEL applies to automatic runs only, so pass the trigger.
export function parseReviewConfig(
  input: { json?: string; env?: Record<string, string | undefined>; trigger?: Trigger } = {},
): { config: ReviewConfig; warnings: string[] } {
  const warnings: string[] = []
  // New arrays, so a caller that mutates its config never changes the shared defaults.
  const config: ReviewConfig = {
    ...DEFAULT_REVIEW_CONFIG,
    ignore: [...DEFAULT_REVIEW_CONFIG.ignore],
    skipAuthors: [...DEFAULT_REVIEW_CONFIG.skipAuthors],
    skipLabels: [...DEFAULT_REVIEW_CONFIG.skipLabels],
    skipBranches: [...DEFAULT_REVIEW_CONFIG.skipBranches],
    paths: [...DEFAULT_REVIEW_CONFIG.paths],
  }
  const source = readJson(input.json, warnings)
  const env = input.env ?? {}
  // The verify policy is settled first, so that under "shared" a config that does not set "verify" starts from
  // SHARED_VERIFY_DEFAULT, and a "verify" in review.json or REVIEW_VERIFY still wins. The passes below read the
  // policy again and give its warnings.
  if (verifyPolicyOf(source, env) === "shared") config.verify = SHARED_VERIFY_DEFAULT
  for (const [key, value] of Object.entries(source ?? {})) {
    if (Object.hasOwn(RETIRED, key)) warnings.push(`${REVIEW_CONFIG_PATH}: ${RETIRED[key]}`)
    else if (!Object.hasOwn(FIELDS, key)) warnings.push(`${REVIEW_CONFIG_PATH}: unknown key "${key}" is ignored.`)
    else assign(config, key as keyof ReviewConfig, value, `${REVIEW_CONFIG_PATH}: "${key}"`, warnings)
  }

  for (const item of ENV) {
    const raw = env[item.name]?.trim()
    if (!raw) continue
    const parsed = Number(raw)
    const value = item.kind === "text" ? raw.toLowerCase() : Number.isFinite(parsed) ? parsed : raw
    assign(config, item.key, value, item.name, warnings)
  }
  const ignore = env.REVIEW_IGNORE?.split(",")
    .map((glob) => glob.trim())
    .filter(Boolean)
  if (ignore?.length) config.ignore = [...config.ignore, ...ignore]
  const auto = env.REVIEW_AUTO_MODEL?.trim()
  if (auto && input.trigger === "auto") assign(config, "model", auto, "REVIEW_AUTO_MODEL", warnings)
  // A cheaper first pass is only posted once the review model confirmed it, so its double-check cannot be off.
  if (config.triageModel && config.verify === "off") {
    warnings.push(
      '"verify": "off" is ignored while "triageModel" is set: every finding of the cheaper first pass is double-checked on the review model.',
    )
    config.verify = "all"
  }
  return { config, warnings }
}

export interface ReviewRules {
  global: string // text before the first `## path:` heading, and after any other `## ` heading
  sections: { globs: string[]; text: string }[]
  truncated: boolean // the file was over 16 KB; log a warning
}

function capBytes(text: string, limit: number) {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= limit) return { text, truncated: false }
  // A cut through a multi-byte character decodes to U+FFFD; drop it.
  const cut = new TextDecoder().decode(bytes.slice(0, limit)).replace(/\uFFFD$/, "")
  const newline = cut.lastIndexOf("\n")
  return { text: newline > 0 ? cut.slice(0, newline) : cut, truncated: true }
}

// Parses `.vector/review.md`. Each `## path: <glob>[, <glob>]` section runs until the next `## ` heading.
export function parseReviewRules(text: string): ReviewRules {
  const capped = capBytes(text.replace(/\r\n/g, "\n"), MAX_RULES_BYTES)
  const global: string[] = []
  const sections: { globs: string[]; lines: string[] }[] = []
  let current: { globs: string[]; lines: string[] } | undefined
  let fenced = false
  for (const line of capped.text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const heading = fenced ? undefined : /^##\s+path:\s*(.*)$/i.exec(line)
    if (heading) {
      current = {
        globs: heading[1]
          .split(",")
          .map((glob) => glob.trim().replace(/^[`"']+|[`"']+$/g, ""))
          .filter(Boolean),
        lines: [],
      }
      sections.push(current)
      continue
    }
    if (!fenced && line.startsWith("## ")) current = undefined
    ;(current ? current.lines : global).push(line)
  }
  return {
    global: global.join("\n").trim(),
    sections: sections.map((section) => ({ globs: section.globs, text: section.lines.join("\n").trim() })),
    truncated: capped.truncated,
  }
}

// The rules for a change: the global section, every section whose globs match a changed file, and matching
// `paths` entries from review.json. A glob without a slash matches the file name at any depth.
export function rulesForPaths(rules: ReviewRules, changedPaths: string[], extra: ReviewConfig["paths"] = []): string {
  const matches = (glob: string) => changedPaths.some((path) => minimatch(path, glob, { dot: true, matchBase: true }))
  const parts: string[] = []
  if (rules.global) parts.push(rules.global)
  for (const section of rules.sections)
    if (section.text && section.globs.some(matches)) parts.push(`## path: ${section.globs.join(", ")}\n${section.text}`)
  for (const item of extra)
    if (item.instructions.trim() && matches(item.path)) parts.push(`## path: ${item.path}\n${item.instructions.trim()}`)
  return parts.join("\n\n")
}
