import { readFileSync } from "node:fs"
import { Option, Schema } from "effect"
import { parse, type ParseError } from "jsonc-parser"
import { ConfigManaged } from "@vectordevai/core/config/managed"
import { ConfigComputerV1 } from "@vectordevai/core/v1/config/computer"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"

const CACHE_MS = 5 * 60 * 1000
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/
const decode = Schema.decodeUnknownOption(ConfigComputerV1.Info, { onExcessProperty: "error" })

/** No company policy grants the user's consent; the default merely permits the ordinary per-app ask. */
export function defaultPolicy(): Computer.ComputerPolicy {
  return {
    managed: false,
    enabled: true,
    defaultAccess: "ask",
    allowAlways: true,
    background: true,
    keepAwake: true,
    apps: new Map(),
    ignored: [],
  }
}

/** Reads only ConfigManaged's authenticated sources, once at startup and at most once per five-minute window. */
export function createComputerPolicy(
  options: {
    read?: () => ConfigManaged.Read
    readFile?: (file: string) => string
    now?: () => number
  } = {},
) {
  const read = options.read ?? ConfigManaged.refresh
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, "utf8"))
  const now = options.now ?? Date.now
  const state = { at: now(), policy: readPolicy(read, readFile) }
  const refresh = () => {
    state.policy = readPolicy(read, readFile)
    state.at = now()
    return snapshot(state.policy)
  }
  return {
    get() {
      const at = now()
      // A clock that moves backward must not keep stale policy indefinitely.
      return at < state.at || at - state.at >= CACHE_MS ? refresh() : snapshot(state.policy)
    },
    refresh,
  }
}

/** Exact identity rules only. The access resolver separately applies enabled/defaultAccess and the never floor. */
export function policyAccess(
  identity: Computer.AppIdentity,
  policy: Computer.ComputerPolicy,
): "allow" | "deny" | undefined {
  if (!policy.managed || identity.platform === "remote" || !identity.verified) return
  const key = Computer.appKey(identity)
  const keys =
    identity.platform === "macos"
      ? [...(identity.apple ? [key] : []), ...(identity.teamId ? [`${key}@${identity.teamId.toLowerCase()}`] : [])]
      : identity.kind === "aumid"
        ? [key]
        : identity.publisher.trim()
          ? [key, Computer.appKey({ ...identity, binary: "*" })]
          : []
  const matches = keys.map((key) => policy.apps.get(key))
  if (matches.includes("deny")) return "deny"
  if (matches.includes("allow")) return "allow"
  return
}

function snapshot(policy: Computer.ComputerPolicy): Computer.ComputerPolicy {
  return { ...policy, apps: new Map(policy.apps), ignored: [...policy.ignored] }
}

function readPolicy(read: () => ConfigManaged.Read, readFile: (file: string) => string): Computer.ComputerPolicy {
  const policy = defaultPolicy()
  const apps = new Map<string, "allow" | "deny">()
  const state = { failed: false }
  const ignore = (rule: string) => policy.ignored.push(Computer.clean(rule, 512))
  const fail = (source: string) => {
    state.failed = true
    policy.managed = true
    ignore(`${source}: the managed ${Hands.NAME} policy could not be read.`)
  }
  const add = (key: string, access: "allow" | "deny") => apps.set(key, apps.get(key) === "deny" ? "deny" : access)
  const apply = (source: string, text: string) => {
    const errors: ParseError[] = []
    const value: unknown = parse(text, errors, { allowTrailingComma: true })
    if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) return fail(source)
    if (!("computer" in value)) return
    const computer = decode(value.computer)
    if (Option.isNone(computer)) return fail(source)
    const config = computer.value
    policy.managed = true
    if (config.enabled !== undefined) policy.enabled = config.enabled
    if (config.default_app_access !== undefined) policy.defaultAccess = config.default_app_access
    if (config.allow_always !== undefined) policy.allowAlways = config.allow_always
    if (config.background !== undefined) policy.background = config.background
    if (config.keep_awake !== undefined) policy.keepAwake = config.keep_awake
    if (config.away_minutes !== undefined) policy.awayMinutesMax = config.away_minutes
    if (config.screenshot_retention_days !== undefined) policy.maxRetentionDays = config.screenshot_retention_days
    for (const [rule, access] of Object.entries(config.apps?.macos ?? {})) {
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,254})(?:@([A-Z0-9]{10}))?$/.exec(rule)
      if (!match || (!match[2] && !match[1]!.toLowerCase().startsWith("com.apple."))) {
        ignore(`${rule}: a third-party macOS rule requires a bundle ID and Team ID.`)
        continue
      }
      const key = `app:macos:${match[1]}${match[2] ? `@${match[2]}` : ""}`.toLowerCase()
      add(key, access)
    }
    for (const rule of config.apps?.windows ?? []) {
      if ("aumid" in rule) {
        if (!valid(rule.aumid, 512)) {
          ignore("A Windows packaged-app rule has an invalid identity.")
          continue
        }
        add(
          Computer.appKey({
            platform: "windows",
            kind: "aumid",
            aumid: rule.aumid,
            verified: true,
            system: false,
            name: "Company app",
          }),
          rule.access,
        )
        continue
      }
      if (
        !valid(rule.publisher, 256) ||
        typeof rule.product !== "string" ||
        rule.product.length > 256 ||
        UNSAFE.test(rule.product) ||
        (rule.binary !== undefined && (!valid(rule.binary, 260) || rule.binary === "*"))
      ) {
        ignore("A Windows signed-app rule has an invalid identity.")
        continue
      }
      // A missing binary is the only family wildcard. Escaping is exactly the shared app-key encoding.
      add(
        Computer.appKey({
          platform: "windows",
          kind: "exe",
          publisher: rule.publisher,
          product: rule.product,
          binary: rule.binary ?? "*",
          exe: "C:\\policy\\app.exe",
          verified: true,
          system: false,
          name: "Company app",
        }),
        rule.access,
      )
    }
  }
  try {
    const sources = read()
    for (const ignored of sources.ignored) {
      if (ignored.kind === "unreadable") fail(ignored.source)
      if (ignored.kind === "untrusted") ignore(`${ignored.source}: an untrusted managed source was ignored.`)
    }
    for (const file of sources.files) {
      try {
        apply(file, readFile(file))
      } catch {
        fail(file)
      }
    }
    for (const source of sources.policies) apply(source.source, source.text)
  } catch {
    fail("Company sources")
  }
  policy.apps = apps
  if (state.failed) {
    // An unreadable trusted source may contain a deny. A later readable allow cannot erase that uncertainty.
    policy.enabled = false
    policy.defaultAccess = "deny"
    policy.allowAlways = false
    policy.background = false
    policy.keepAwake = false
  }
  return policy
}

function valid(value: string, maximum: number) {
  return value.length > 0 && value.length <= maximum && value.trim().length > 0 && !UNSAFE.test(value)
}
