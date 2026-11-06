// `.vector/review.json` with its environment overrides, and the plain-English rules in `.vector/review.md`. Parsing
// is lenient: bad input falls back to the defaults and becomes a warning for the run log, never an error on the pull
// request. Pure and browser-safe.

import { minimatch } from "minimatch"
import { NOT_A_NAME, readZdrAttestation } from "./privacy"
import {
  DEFAULT_REVIEW_CONFIG,
  OPTIONAL_REVIEW_DEFAULT_OF,
  SEVERITIES,
  SHARED_VERIFY_DEFAULT,
  UNAPPLIED_REVIEW_KEYS,
  type ReviewConfig,
  type Trigger,
  type ZdrAttestedEntry,
} from "./types"

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

// How privacy.ts reads the entries for one route, as the notes on a shared ID state it.
const STRICTEST = "the strictest of every entry that attests a route applies, whatever its ID"

// Provider IDs and model server hosts (privacy.ts reads them), as text or as VS-33's attestation objects, in one pass
// that keeps their order. Text with a scheme, path, user or space, such as a URL, names neither, so it is dropped: a
// server is written as its host alone, for every port, or with one port. An object privacy.ts's readZdrAttestation
// cannot read is dropped with its reason, naming the entry by its `id`, or by its place when that is unreadable, and
// never echoing the rest of it (a `project` can be an account ID in a public run log). A list of text alone gives
// exactly the value and notes it gave before VS-33.
const attestations: Field = {
  parse: (value) => {
    if (!Array.isArray(value)) return undefined
    const read = value.map((item, index) => attestedEntry(item, index))
    const kept = read.flatMap((item) => (item.entry === undefined ? [] : [item.entry]))
    const named = read.flatMap((item) => item.named ?? [])
    const idOf = (entry: ZdrAttestedEntry) => (typeof entry === "string" ? entry : entry.id)
    // privacy.ts applies the strictest of every entry that attests a route, whatever its ID, so an object beside text
    // accepts no more. Without a model this cannot tell which entries attest the same route, so it notes only an ID an
    // object shares (an `openai` object beside the text "api.openai.com" gets none), and the note states the wider rule.
    const shared = [...new Set(kept.flatMap((entry) => (typeof entry === "string" ? [] : [entry.id])))].filter(
      (id) => kept.filter((entry) => idOf(entry) === id).length > 1,
    )
    const notes = [
      read.some((item) => item.notText) ? "entries that are not text were dropped" : undefined,
      named.length
        ? `${named.map((item) => JSON.stringify(item)).join(", ")} ${named.length === 1 ? "names" : "name"} neither a provider ID nor a host, so ${named.length === 1 ? "it was" : "they were"} dropped; write a server as its host, such as "gpu-box:8080"`
        : undefined,
      ...read.flatMap((item) => item.problem ?? []),
      ...shared.map((id) =>
        kept.includes(id)
          ? `${JSON.stringify(id)} is also listed as text, which accepts no "extendedCache", and ${STRICTEST}`
          : `${JSON.stringify(id)} is listed more than once, and ${STRICTEST}`,
      ),
    ].filter((note) => note !== undefined)
    return { value: kept, note: notes.length ? notes.join("; ") : undefined }
  },
  expected: "a list of provider IDs and model server hosts",
}

// One item of `zdrAttested`: text, kept trimmed unless it names neither a provider ID nor a host; an attestation
// object, kept as readZdrAttestation reads it; or anything else, which is not text.
function attestedEntry(
  item: unknown,
  index: number,
): { entry?: ZdrAttestedEntry; notText?: true; named?: string; problem?: string } {
  if (typeof item === "string") {
    const text = item.trim()
    if (!text) return { notText: true }
    return NOT_A_NAME.test(text) ? { named: text } : { entry: text }
  }
  if (typeof item !== "object" || item === null || Array.isArray(item)) return { notText: true }
  const read = readZdrAttestation(item)
  if ("attestation" in read) return { entry: read.attestation }
  const subject = read.id === undefined ? `entry ${index + 1}` : `the entry for ${JSON.stringify(read.id)}`
  return { problem: `${subject} ${read.problem}, so it was dropped` }
}

// Keys whose sources are tagged (contract §1.1, invariant I-2). parseReviewConfig reads none of them: review.json's
// copy is an unknown key and the environment's is not read, so no surface takes "zdr" before it enforces it.
// mergeReviewConfig is their only reader.
// - Raise-only: each level is stricter than the one before. Any source may raise the key and none may lower it, and a
//   value that is not a level reads as the strictest.
const RAISE_ONLY = {
  privacy: { levels: ["standard", "zdr"], env: "REVIEW_PRIVACY" },
} as const satisfies Partial<Record<keyof ReviewConfig, { levels: readonly string[]; env: string }>>
// - Trusted-only: read from the surface's trusted source alone, never from the working tree or the environment. This
//   holds for `zdrAttested`'s attestation objects (VS-33) as for its text entries.
const TRUSTED_ONLY = { zdrAttested: attestations } satisfies Partial<Record<keyof ReviewConfig, Field>>

export type SourcedReviewKey = keyof typeof RAISE_ONLY | keyof typeof TRUSTED_ONLY
export const SOURCED_REVIEW_KEYS = Object.keys({ ...RAISE_ONLY, ...TRUSTED_ONLY }) as readonly SourcedReviewKey[]
type PlainKey = Exclude<keyof ReviewConfig, SourcedReviewKey>

const FIELDS: Record<PlainKey, Field> = {
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
  modelEvidence: oneOf(["off", "warn"]),
  trivial: oneOf(["review", "skip"]),
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
  maxInputTokens: number({ min: 0, integer: true }),
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

const ENV: { name: string; key: PlainKey; kind: "number" | "text" }[] = [
  { name: "REVIEW_MIN_SEVERITY", key: "minSeverity", kind: "text" },
  { name: "REVIEW_MIN_CONFIDENCE", key: "minConfidence", kind: "number" },
  { name: "REVIEW_MAX_COMMENTS", key: "maxComments", kind: "number" },
  { name: "REVIEW_SECURITY", key: "security", kind: "text" },
  { name: "REVIEW_VERIFY", key: "verify", kind: "text" },
  { name: "REVIEW_VERIFY_POLICY", key: "verifyPolicy", kind: "text" },
  { name: "REVIEW_MODEL_EVIDENCE", key: "modelEvidence", kind: "text" },
  { name: "REVIEW_TRIVIAL", key: "trivial", kind: "text" },
  { name: "REVIEW_FAIL_ON", key: "failOn", kind: "text" },
  { name: "REVIEW_MAX_COST_USD", key: "maxCostUsd", kind: "number" },
  { name: "REVIEW_MAX_COST_USD_PER_PR", key: "maxCostUsdPerPr", kind: "number" },
  { name: "REVIEW_MAX_COST_USD_PER_MONTH", key: "maxCostUsdPerMonth", kind: "number" },
  { name: "REVIEW_MAX_INPUT_TOKENS", key: "maxInputTokens", kind: "number" },
  { name: "REVIEW_TIMEOUT_MINUTES", key: "timeoutMinutes", kind: "number" },
]

// Keys parsed before any runner applies them (UNAPPLIED_REVIEW_KEYS), so a value that would change a review says it
// does not yet. Keyed by that list, so a key cannot join or leave it without its warning.
const UNAPPLIED: Record<
  (typeof UNAPPLIED_REVIEW_KEYS)[number],
  { applies: (config: ReviewConfig) => boolean; warning: string }
> = {
  trivial: {
    applies: (config) => config.trivial === "skip",
    warning: '"trivial": "skip" is not applied yet: every change is still reviewed.',
  },
  maxInputTokens: {
    applies: (config) => (config.maxInputTokens ?? 0) > 0,
    warning: '"maxInputTokens" is not applied yet: no input-token cap is enforced.',
  },
}

function assign(config: ReviewConfig, key: PlainKey, value: unknown, label: string, warnings: string[]) {
  const parsed = FIELDS[key].parse(value)
  if (!parsed) {
    warnings.push(
      `${label} must be ${FIELDS[key].expected}; using ${JSON.stringify(config[key] ?? OPTIONAL_REVIEW_DEFAULT_OF[key])}.`,
    )
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
  const config = settle(readJson(input.json, warnings), input.env ?? {}, input.trigger, warnings)
  return { config, warnings }
}

/**
 * Review settings from sources tagged with where each comes from (contract §1.1). Nothing calls this yet: the surfaces
 * switch to it when the route rules are enforced (VS-23b to VS-23d), and until then they read parseReviewConfig, which
 * ignores the keys below.
 * - `surface`: "local" for the CLI, the desktop and the eval's replay entry point, whose global config is the
 *   operator's (the eval passes its own settings as `global`); "github" for the CI job.
 * - `global`: the global config's `review` block (VS-23d adds it to the config schema).
 * - `json`: the one review.json the surface reads, at the base commit or in the working tree. `privacyOnly` is the
 *   desktop's base blob when a pull request changes review.json: it may raise `privacy`, and every other key keeps
 *   today's defaults there.
 *
 * Every key outside RAISE_ONLY and TRUSTED_ONLY is read exactly as parseReviewConfig reads it. `privacy` is the
 * strictest of the global config, review.json and REVIEW_PRIVACY, and a review.json that cannot be read but mentions it
 * counts as "zdr". `zdrAttested` comes from the trusted source alone: the global config on "local" (your own branch can
 * hold other people's commits), review.json at the base on "github" (a pull request can edit the workflow and its
 * environment). It has no environment variable, and a value from any other source is ignored with a warning. Its
 * entries are text or VS-33's attestation objects (`{ id, operator, project?, region?, extendedCache?, verify? }`,
 * read by privacy.ts's readZdrAttestation); an entry that is neither, or an object that cannot be read, is dropped with
 * a warning. Neither key is set when it has its default, so with both unset the result is parseReviewConfig's.
 */
export function mergeReviewConfig(input: {
  surface: "local" | "github"
  global?: Partial<Record<SourcedReviewKey, unknown>>
  json?: { at: "base" | "working-tree"; text: string | undefined; privacyOnly?: boolean }
  env?: Record<string, string | undefined>
  trigger?: Trigger
}): { config: ReviewConfig; warnings: string[] } {
  const warnings: string[] = []
  const env = input.env ?? {}
  const text = input.json?.text
  const source = readJson(text, warnings)
  const config = settle(
    input.json?.privacyOnly || !source
      ? undefined
      : Object.fromEntries(Object.entries(source).filter(([key]) => !SOURCED_REVIEW_KEYS.some((item) => item === key))),
    env,
    input.trigger,
    warnings,
  )
  const sources: { values: Record<string, unknown> | undefined; trusted: boolean; label: (key: string) => string }[] = [
    { values: input.global, trusted: input.surface === "local", label: (key) => `review.${key} in the global config` },
    {
      values: source,
      // The desktop's base blob may raise `privacy` and nothing else, so it is never the trusted source.
      trusted: input.surface === "github" && input.json?.at === "base" && !input.json.privacyOnly,
      label: (key) => `${REVIEW_CONFIG_PATH}: "${key}"`,
    },
  ]
  const given = (values: Record<string, unknown> | undefined, key: string) =>
    !!values && Object.hasOwn(values, key) && values[key] !== undefined

  for (const [key, rule] of Object.entries(RAISE_ONLY)) {
    const levels: readonly string[] = rule.levels
    const strictest = levels.length - 1
    const using = `using "${levels[strictest]}", the stricter setting.`
    const readings = [
      ...sources.flatMap((item) =>
        given(item.values, key) ? [{ label: item.label(key), value: item.values?.[key] }] : [],
      ),
      ...(env[rule.env]?.trim() ? [{ label: rule.env, value: env[rule.env] }] : []),
    ]
    const read = readings.map((reading) => {
      const level = typeof reading.value === "string" ? levels.indexOf(reading.value.trim().toLowerCase()) : -1
      if (level >= 0) return level
      warnings.push(`${reading.label} must be ${levels.map((item) => `"${item}"`).join(" or ")}; ${using}`)
      return strictest
    })
    // A review.json that cannot be read may have meant the stricter setting, so one that mentions the key fails closed.
    const unreadable = text !== undefined && !source && text.toLowerCase().includes(key.toLowerCase())
    if (unreadable) warnings.push(`${REVIEW_CONFIG_PATH} could not be read and mentions "${key}"; ${using}`)
    const level = Math.max(0, ...read, unreadable ? strictest : 0)
    if (level > 0) Object.assign(config, { [key]: levels[level] })
  }

  const trusted = input.surface === "local" ? "the global config" : `${REVIEW_CONFIG_PATH} on the base branch`
  for (const [key, field] of Object.entries(TRUSTED_ONLY))
    for (const item of sources.filter((entry) => given(entry.values, key))) {
      const label = item.label(key)
      if (!item.trusted) {
        warnings.push(`${label} is ignored: "${key}" is read only from ${trusted}.`)
        continue
      }
      const parsed = field.parse(item.values?.[key])
      if (!parsed) {
        warnings.push(`${label} must be ${field.expected}; it is ignored.`)
        continue
      }
      if (parsed.note) warnings.push(`${label}: ${parsed.note}.`)
      // An empty list is the default, and is left out like one.
      if (!Array.isArray(parsed.value) || parsed.value.length) Object.assign(config, { [key]: parsed.value })
    }
  return { config, warnings }
}

// Every key but the sourced ones, from one review.json record and one environment, over the defaults.
function settle(
  source: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
  trigger: Trigger | undefined,
  warnings: string[],
): ReviewConfig {
  // New arrays, so a caller that mutates its config never changes the shared defaults.
  const config: ReviewConfig = {
    ...DEFAULT_REVIEW_CONFIG,
    ignore: [...DEFAULT_REVIEW_CONFIG.ignore],
    skipAuthors: [...DEFAULT_REVIEW_CONFIG.skipAuthors],
    skipLabels: [...DEFAULT_REVIEW_CONFIG.skipLabels],
    skipBranches: [...DEFAULT_REVIEW_CONFIG.skipBranches],
    paths: [...DEFAULT_REVIEW_CONFIG.paths],
  }
  // The verify policy is settled first, so that under "shared" a config that does not set "verify" starts from
  // SHARED_VERIFY_DEFAULT, and a "verify" in review.json or REVIEW_VERIFY still wins. The passes below read the
  // policy again and give its warnings.
  if (verifyPolicyOf(source, env) === "shared") config.verify = SHARED_VERIFY_DEFAULT
  for (const [key, value] of Object.entries(source ?? {})) {
    if (Object.hasOwn(RETIRED, key)) warnings.push(`${REVIEW_CONFIG_PATH}: ${RETIRED[key]}`)
    else if (!Object.hasOwn(FIELDS, key)) warnings.push(`${REVIEW_CONFIG_PATH}: unknown key "${key}" is ignored.`)
    else assign(config, key as PlainKey, value, `${REVIEW_CONFIG_PATH}: "${key}"`, warnings)
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
  if (auto && trigger === "auto") assign(config, "model", auto, "REVIEW_AUTO_MODEL", warnings)
  // A cheaper first pass is only posted once the review model confirmed it, so its double-check cannot be off.
  if (config.triageModel && config.verify === "off") {
    warnings.push(
      '"verify": "off" is ignored while "triageModel" is set: every finding of the cheaper first pass is double-checked on the review model.',
    )
    config.verify = "all"
  }
  warnings.push(
    ...UNAPPLIED_REVIEW_KEYS.filter((key) => UNAPPLIED[key].applies(config)).map((key) => UNAPPLIED[key].warning),
  )
  return config
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
