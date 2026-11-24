import { createPrivateKey, type KeyObject } from "node:crypto"
import { ACCOUNT_ID_PATTERN, OFFER_KEY_ID_PATTERN, PLATFORMS, type PlatformId } from "../../../packages/schema/src/everywhere.js"
import { DATA_KEY_BYTES, dataKey, type DataKey } from "./crypto.js"
import { secretUsable } from "./signature.js"

/*
 * Vector everywhere's server configuration (contract 3.13), read from environment variables only. Missing or invalid
 * required settings turn their piece off. The feature needs a usable data key, laptop offers need an Ed25519 signing
 * key, and each platform needs its own settings. `problems` records variable names and omits their values.
 */

export const ENV_NAMES = {
  enabled: "VECTOR_EVERYWHERE_ENABLED",
  platforms: "VECTOR_EVERYWHERE_PLATFORMS",
  pausedPlatforms: "VECTOR_EVERYWHERE_PAUSED_PLATFORMS",
  allowAccounts: "VECTOR_EVERYWHERE_ALLOW_ACCOUNTS",
  dataKey: "VECTOR_EVERYWHERE_DATA_KEY",
  offerSigningKey: "VECTOR_EVERYWHERE_OFFER_SIGNING_KEY",
  offerKeyId: "VECTOR_EVERYWHERE_OFFER_KEY_ID",
  slackAppId: "VECTOR_SLACK_APP_ID",
  slackClientId: "VECTOR_SLACK_CLIENT_ID",
  slackClientSecret: "VECTOR_SLACK_CLIENT_SECRET",
  slackSigningSecret: "VECTOR_SLACK_SIGNING_SECRET",
  linearClientId: "VECTOR_LINEAR_CLIENT_ID",
  linearClientSecret: "VECTOR_LINEAR_CLIENT_SECRET",
  linearWebhookSecret: "VECTOR_LINEAR_WEBHOOK_SECRET",
  jiraForgeAppId: "VECTOR_JIRA_FORGE_APP_ID",
  cronSecret: "CRON_SECRET",
} as const

export type Env = Readonly<Record<string, string | undefined>>

export type SlackConfig = {
  readonly appId: string
  readonly clientId: string
  readonly clientSecret: string
  readonly signingSecret: string
}
export type LinearConfig = { readonly clientId: string; readonly clientSecret: string; readonly webhookSecret: string }
export type JiraConfig = { readonly forgeAppId: string }
export type OfferKey = { readonly kid: string; readonly key: KeyObject }

export type EverywhereConfig = {
  /** VECTOR_EVERYWHERE_ENABLED is exactly "true" and the data key is usable. */
  readonly enabled: boolean
  /** Platforms listed in VECTOR_EVERYWHERE_PLATFORMS whose own settings are present; empty while the feature is off. */
  readonly platforms: ReadonlySet<PlatformId>
  /** Configured platforms on this list keep serving existing jobs and controls while new admissions are paused. */
  readonly pausedPlatforms: ReadonlySet<PlatformId>
  /**
   * Vector accounts the router admits as sponsors (3.4 step 3); empty means nobody. Lowercase. The only sponsor check
   * until the plan joins it: the relay adapter's plan check (adapters/remote.ts, EV-09) grants `everywhere` beside this
   * list only once the laptop route is wired and the owner lists the perk.
   */
  readonly allowAccounts: ReadonlySet<string>
  /** The data key ring, current key first; empty while the feature is off. */
  readonly dataKeys: readonly DataKey[]
  /** The offer signing key; absent means no laptop offers. */
  readonly offer?: OfferKey
  readonly slack?: SlackConfig
  readonly linear?: LinearConfig
  readonly jira?: JiraConfig
  /** Vercel's CRON_SECRET, which the sweep checks. */
  readonly cronSecret?: string
  /** The names of variables that are set but unusable, or needed and missing. Never their values. */
  readonly problems: readonly string[]
}

/** An id-like setting: present, printable, no spaces, at most 200 characters. */
function idValue(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed && /^[\x21-\x7e]{1,200}$/.test(trimmed) ? trimmed : undefined
}

function secretValue(value: string | undefined) {
  const trimmed = value?.trim()
  return secretUsable(trimmed) ? trimmed : undefined
}

/**
 * The data key: 32 bytes as base64 (standard or URL-safe, padded or not). A shorter, longer or malformed value is
 * refused, and so is a placeholder whose bytes barely vary (all zeros, a repeated letter).
 */
export function parseDataKey(value: string | undefined): DataKey | undefined {
  const text = value?.trim()
  if (!text) return undefined
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(text) && !/^[A-Za-z0-9_-]{43}$/.test(text)) return undefined
  const raw = Buffer.from(text.replace(/=$/, ""), text.includes("+") || text.includes("/") ? "base64" : "base64url")
  if (raw.length !== DATA_KEY_BYTES) return undefined
  if (new Set(raw).size < 8) return undefined
  return dataKey(raw)
}

let lastOffer: { readonly pem: string; readonly key: KeyObject | undefined } | undefined

/** The Ed25519 private key from a PKCS#8 PEM; env values may carry `\n` escapes for line breaks. */
export function parseOfferSigningKey(value: string | undefined): KeyObject | undefined {
  const pem = value?.trim().replace(/\\n/g, "\n")
  if (!pem || !pem.startsWith("-----BEGIN PRIVATE KEY-----")) return undefined
  if (lastOffer?.pem === pem) return lastOffer.key
  let key: KeyObject | undefined
  try {
    const parsed = createPrivateKey({ key: pem, format: "pem" })
    key = parsed.type === "private" && parsed.asymmetricKeyType === "ed25519" ? parsed : undefined
  } catch {
    key = undefined
  }
  lastOffer = { pem, key }
  return key
}

function list(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function platformList(env: Env, name: string, problems: string[]) {
  const platforms = new Set<PlatformId>()
  for (const value of list(env[name])) {
    const platform = PLATFORMS.find((candidate) => candidate === value)
    if (platform) platforms.add(platform)
    else problems.push(name)
  }
  return platforms
}

/** Reads the configuration. Pass `env` in tests; the server reads `process.env` on every call. */
export function readConfig(env: Env = process.env): EverywhereConfig {
  const problems: string[] = []
  const flag = env[ENV_NAMES.enabled]?.trim()
  const switchedOn = flag === "true"
  if (flag && !switchedOn && flag !== "false") problems.push(ENV_NAMES.enabled)

  const key = parseDataKey(env[ENV_NAMES.dataKey])
  if (!key && (switchedOn || env[ENV_NAMES.dataKey]?.trim())) problems.push(ENV_NAMES.dataKey)
  const enabled = switchedOn && key !== undefined

  const kid = idValue(env[ENV_NAMES.offerKeyId])
  const signing = parseOfferSigningKey(env[ENV_NAMES.offerSigningKey])
  if (env[ENV_NAMES.offerKeyId]?.trim() && (!kid || !OFFER_KEY_ID_PATTERN.test(kid))) problems.push(ENV_NAMES.offerKeyId)
  if (env[ENV_NAMES.offerSigningKey]?.trim() && !signing) problems.push(ENV_NAMES.offerSigningKey)
  const offer = kid && OFFER_KEY_ID_PATTERN.test(kid) && signing ? Object.freeze({ kid, key: signing }) : undefined

  const slackSettings = {
    appId: idValue(env[ENV_NAMES.slackAppId]),
    clientId: idValue(env[ENV_NAMES.slackClientId]),
    clientSecret: secretValue(env[ENV_NAMES.slackClientSecret]),
    signingSecret: secretValue(env[ENV_NAMES.slackSigningSecret]),
  }
  const linearSettings = {
    clientId: idValue(env[ENV_NAMES.linearClientId]),
    clientSecret: secretValue(env[ENV_NAMES.linearClientSecret]),
    webhookSecret: secretValue(env[ENV_NAMES.linearWebhookSecret]),
  }
  const jiraSettings = { forgeAppId: idValue(env[ENV_NAMES.jiraForgeAppId]) }

  const slack = complete(slackSettings)
  const linear = complete(linearSettings)
  const jira = complete(jiraSettings)

  const listed = platformList(env, ENV_NAMES.platforms, problems)
  const pausedPlatforms = platformList(env, ENV_NAMES.pausedPlatforms, problems)
  const ready: Record<PlatformId, boolean> = {
    github: true,
    slack: slack !== undefined,
    linear: linear !== undefined,
    jira: jira !== undefined,
  }
  const platforms = new Set<PlatformId>()
  for (const platform of listed) {
    if (ready[platform]) {
      if (enabled) platforms.add(platform)
      continue
    }
    const missing = {
      github: [],
      slack: settingProblems(slackSettings, {
        appId: ENV_NAMES.slackAppId,
        clientId: ENV_NAMES.slackClientId,
        clientSecret: ENV_NAMES.slackClientSecret,
        signingSecret: ENV_NAMES.slackSigningSecret,
      }),
      linear: settingProblems(linearSettings, {
        clientId: ENV_NAMES.linearClientId,
        clientSecret: ENV_NAMES.linearClientSecret,
        webhookSecret: ENV_NAMES.linearWebhookSecret,
      }),
      jira: settingProblems(jiraSettings, { forgeAppId: ENV_NAMES.jiraForgeAppId }),
    }[platform]
    problems.push(...missing)
  }

  const allowAccounts = new Set<string>()
  for (const account of list(env[ENV_NAMES.allowAccounts])) {
    if (ACCOUNT_ID_PATTERN.test(account)) allowAccounts.add(account.toLowerCase())
    else problems.push(ENV_NAMES.allowAccounts)
  }

  const cronSecret = secretValue(env[ENV_NAMES.cronSecret])

  return Object.freeze({
    enabled,
    platforms,
    pausedPlatforms,
    allowAccounts,
    dataKeys: Object.freeze(enabled && key ? [key] : []),
    ...(offer ? { offer } : {}),
    ...(slack ? { slack } : {}),
    ...(linear ? { linear } : {}),
    ...(jira ? { jira } : {}),
    ...(cronSecret ? { cronSecret } : {}),
    problems: Object.freeze([...new Set(problems)]),
  })
}

function complete<T extends Record<string, string | undefined>>(settings: T) {
  return Object.values(settings).every((value) => value !== undefined)
    ? (Object.freeze({ ...settings }) as { readonly [K in keyof T]: string })
    : undefined
}

function settingProblems<T extends Record<string, string | undefined>>(
  settings: T,
  names: { readonly [K in keyof T]: string },
) {
  return (Object.keys(settings) as (keyof T)[]).filter((field) => settings[field] === undefined).map((field) => names[field])
}

/**
 * Whether a platform's routes are open: the feature is on and the platform is listed and configured (3.2 step 3).
 * Routes answer 404 before any store read when it is not.
 */
export function platformOn(config: EverywhereConfig, platform: PlatformId): boolean {
  return config.enabled && config.platforms.has(platform)
}

/**
 * Whether a sponsor is listed in VECTOR_EVERYWHERE_ALLOW_ACCOUNTS: the router's only sponsor check (3.4 step 3) until
 * the relay adapter's plan check joins it (adapters/remote.ts, EV-09), once the laptop route is wired and the owner
 * lists Codium's `everywhere` perk.
 */
export function sponsorListed(config: EverywhereConfig, account: string): boolean {
  return ACCOUNT_ID_PATTERN.test(account) && config.allowAccounts.has(account.toLowerCase())
}

/**
 * Whether production can run a paying customer's job. VE-20 and the plan check are built (EV-09): with the flag and the
 * offer key set, productionPorts (runtime.ts) uses the relay adapter (adapters/remote.ts), whose plan check joins the
 * allowlist only while this is true. 2026-11-16 (EV-17): the desktop now decodes and verifies offers (VE-21), but it
 * stays false while no customer job can finish on a laptop: `OFFER_KEYS` (desktop everywhere-offer.ts) is empty until
 * the owner's key handoff, so every offer is refused. *2026-11-21:* EV-18's safe worktree adapter has landed
 * (`cf9195d0`), so a claimed job is no longer held for want of a worktree; what still keeps this false is the empty
 * `OFFER_KEYS`, and that a macOS or Windows shell runs no checks for an unattended job (EV-16). The package that pins
 * the key sets it true. It lives here, not in runtime.ts, because Codium's listing imports this module and runtime.ts
 * builds the platform routes when it loads.
 */
export const LAPTOP_ROUTE_WIRED: boolean = false

/**
 * Codium's listing readiness for the `everywhere` perk (codium-perks.ts; EV-08). Display only: the intake gates above
 * are unchanged. Ready once a customer could start a job and see it end: the route is wired, offers can be signed, the
 * sweep can run, and Slack, Linear or Jira is open. GitHub alone does not count, because its handoff answers
 * handled:false until @vector's laptop-first option exists (Q13, R-A6). `wired` is checked before the configuration is
 * read, so a listing read with `everywhere` as a candidate parses no environment (or offer key) while it is false.
 */
export function everywhereReady(config?: EverywhereConfig, wired = LAPTOP_ROUTE_WIRED) {
  if (!wired) return false
  const settings = config ?? readConfig()
  return (
    settings.offer !== undefined &&
    settings.cronSecret !== undefined &&
    (["slack", "linear", "jira"] as const).some((platform) => platformOn(settings, platform))
  )
}
