import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto"
import {
  ENV_NAMES,
  everywhereReady,
  parseDataKey,
  platformOn,
  readConfig,
  sponsorListed,
  type Env,
} from "../../../api/_lib/everywhere/config"
import { dataKeyId } from "../../../api/_lib/everywhere/crypto"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"

installFetchGuard()

/*
 * VE-03: environment reading. Every variable missing, malformed or short turns its piece off, and nothing reports a
 * value. Every secret here is generated in the test.
 */

const secret = () => randomBytes(24).toString("hex")
const goodKey = () => randomBytes(32).toString("base64")
const ed25519Pem = () =>
  generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString()

function slackEnv(): Env {
  return {
    [ENV_NAMES.slackAppId]: "A0123456789",
    [ENV_NAMES.slackClientId]: "1234567890.0987654321",
    [ENV_NAMES.slackClientSecret]: secret(),
    [ENV_NAMES.slackSigningSecret]: secret(),
  }
}

function linearEnv(): Env {
  return {
    [ENV_NAMES.linearClientId]: randomBytes(16).toString("hex"),
    [ENV_NAMES.linearClientSecret]: secret(),
    [ENV_NAMES.linearWebhookSecret]: `lin_wh_${secret()}`,
  }
}

function on(extra: Env = {}): Env {
  return { [ENV_NAMES.enabled]: "true", [ENV_NAMES.dataKey]: goodKey(), ...extra }
}

/** No value of `env` appears anywhere in what the config says about its problems. */
function expectNoValuesIn(problems: readonly string[], env: Env) {
  const text = JSON.stringify(problems)
  for (const value of Object.values(env)) if (value && value.length > 6) expect(text).not.toContain(value)
}

describe("the feature switch and the data key", () => {
  test("nothing set means everything is off", () => {
    const config = readConfig({})
    expect(config.enabled).toBe(false)
    expect([...config.platforms]).toEqual([])
    expect([...config.pausedPlatforms]).toEqual([])
    expect(config.dataKeys).toEqual([])
    expect(config.offer).toBeUndefined()
    expect(config.slack).toBeUndefined()
    expect(config.linear).toBeUndefined()
    expect(config.jira).toBeUndefined()
    expect(config.cronSecret).toBeUndefined()
    expect(config.problems).toEqual([])
  })

  test("only the exact word true switches it on", () => {
    for (const value of ["TRUE", "1", "yes", "on", "truee"]) {
      const env = on({ [ENV_NAMES.enabled]: value })
      const config = readConfig(env)
      expect(config.enabled).toBe(false)
      expect(config.problems).toContain(ENV_NAMES.enabled)
    }
    const switchedOff = readConfig(on({ [ENV_NAMES.enabled]: "false" }))
    expect(switchedOff.enabled).toBe(false)
    expect(switchedOff.problems).toEqual([])
    expect(readConfig(on({ [ENV_NAMES.enabled]: " true\n" })).enabled).toBe(true)
  })

  test("a missing data key keeps the feature off", () => {
    const config = readConfig({ [ENV_NAMES.enabled]: "true" })
    expect(config.enabled).toBe(false)
    expect(config.dataKeys).toEqual([])
    expect(config.problems).toContain(ENV_NAMES.dataKey)
  })

  test("a short, long, malformed or placeholder data key keeps the feature off", () => {
    const bad = [
      randomBytes(16).toString("base64"),
      randomBytes(31).toString("base64"),
      randomBytes(33).toString("base64"),
      randomBytes(64).toString("base64"),
      "not a key at all",
      `${randomBytes(32).toString("base64").slice(0, 40)}!!!=`,
      Buffer.alloc(32).toString("base64"),
      Buffer.alloc(32, 0x41).toString("base64"),
      randomBytes(32).toString("hex"),
    ]
    for (const value of bad) {
      expect(parseDataKey(value)).toBeUndefined()
      const env = on({ [ENV_NAMES.dataKey]: value })
      const config = readConfig(env)
      expect(config.enabled).toBe(false)
      expect(config.dataKeys).toEqual([])
      expect(config.problems).toContain(ENV_NAMES.dataKey)
      expectNoValuesIn(config.problems, env)
    }
  })

  test("a 32-byte key in standard or URL-safe base64, padded or not, switches it on", () => {
    const raw = randomBytes(32)
    for (const text of [
      raw.toString("base64"),
      raw.toString("base64").replace(/=$/, ""),
      raw.toString("base64url"),
      ` ${raw.toString("base64")}\n`,
    ]) {
      const config = readConfig(on({ [ENV_NAMES.dataKey]: text }))
      expect(config.enabled).toBe(true)
      expect(config.dataKeys).toHaveLength(1)
      expect(config.dataKeys[0]!.key.equals(raw)).toBe(true)
      expect(config.dataKeys[0]!.id).toBe(dataKeyId(raw))
      expect(config.problems).toEqual([])
    }
  })

  test("the key id names the key without revealing it", () => {
    const raw = randomBytes(32)
    const id = dataKeyId(raw)
    expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/)
    expect(raw.toString("base64url")).not.toContain(id)
    expect(dataKeyId(randomBytes(32))).not.toBe(id)
  })

  test("the configuration cannot be changed after it is read", () => {
    const config = readConfig(on())
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.dataKeys)).toBe(true)
  })
})

test("a pause list uses exact platform names and leaves each configured platform open", () => {
  const config = readConfig(on({
    ...slackEnv(),
    ...linearEnv(),
    [ENV_NAMES.jiraForgeAppId]: "ari:cloud:ecosystem::app/test",
    [ENV_NAMES.platforms]: "github,slack,linear,jira",
    [ENV_NAMES.pausedPlatforms]: " jira,slack,github,jira,,Slack,misspelled-platform ",
  }))
  expect([...config.pausedPlatforms]).toEqual(["jira", "slack", "github"])
  for (const platform of ["github", "slack", "linear", "jira"] as const) expect(platformOn(config, platform)).toBe(true)
  expect(config.problems).toEqual([ENV_NAMES.pausedPlatforms])
})

describe("platforms", () => {
  test("a platform is on only when the feature is on, it is listed and its own settings are complete", () => {
    const env = on({ [ENV_NAMES.platforms]: "slack, linear,github", ...slackEnv() })
    const config = readConfig(env)
    expect([...config.platforms].sort()).toEqual(["github", "slack"])
    expect(platformOn(config, "slack")).toBe(true)
    expect(platformOn(config, "github")).toBe(true)
    expect(platformOn(config, "linear")).toBe(false)
    expect(platformOn(config, "jira")).toBe(false)
    expect(config.problems).toEqual(
      expect.arrayContaining([
        ENV_NAMES.linearClientId,
        ENV_NAMES.linearClientSecret,
        ENV_NAMES.linearWebhookSecret,
      ]),
    )
    expectNoValuesIn(config.problems, env)
  })

  test("listed platforms stay closed while the feature is off", () => {
    const env = { [ENV_NAMES.platforms]: "slack,linear,jira,github", ...slackEnv(), ...linearEnv(), [ENV_NAMES.jiraForgeAppId]: `ari:cloud:ecosystem::app/${randomUUID()}` }
    const config = readConfig(env)
    expect([...config.platforms]).toEqual([])
    for (const platform of ["github", "slack", "linear", "jira"] as const) expect(platformOn(config, platform)).toBe(false)
    // The settings are still read, so the owner can see they are complete before switching on.
    expect(config.slack).toBeDefined()
    expect(config.linear).toBeDefined()
    expect(config.jira).toBeDefined()
  })

  test("a platform that is configured but not listed stays closed", () => {
    const config = readConfig(on({ [ENV_NAMES.platforms]: "linear", ...slackEnv(), ...linearEnv() }))
    expect(platformOn(config, "slack")).toBe(false)
    expect(platformOn(config, "linear")).toBe(true)
  })

  test("a short signing or client secret turns its platform off", () => {
    for (const name of [ENV_NAMES.slackSigningSecret, ENV_NAMES.slackClientSecret]) {
      const env = on({ [ENV_NAMES.platforms]: "slack", ...slackEnv(), [name]: "short-secret" })
      const config = readConfig(env)
      expect(config.slack).toBeUndefined()
      expect(platformOn(config, "slack")).toBe(false)
      expect(config.problems).toContain(name)
      expectNoValuesIn(config.problems, env)
    }
    const env = on({ [ENV_NAMES.platforms]: "linear", ...linearEnv(), [ENV_NAMES.linearWebhookSecret]: "x".repeat(15) })
    expect(platformOn(readConfig(env), "linear")).toBe(false)
  })

  test("a secret with spaces inside is refused", () => {
    const env = on({ [ENV_NAMES.platforms]: "slack", ...slackEnv(), [ENV_NAMES.slackSigningSecret]: `${secret()} ${secret()}` })
    expect(platformOn(readConfig(env), "slack")).toBe(false)
  })

  test("Jira needs its Forge app id", () => {
    expect(platformOn(readConfig(on({ [ENV_NAMES.platforms]: "jira" })), "jira")).toBe(false)
    const config = readConfig(on({ [ENV_NAMES.platforms]: "jira", [ENV_NAMES.jiraForgeAppId]: `ari:cloud:ecosystem::app/${randomUUID()}` }))
    expect(platformOn(config, "jira")).toBe(true)
  })

  test("unknown platform names are ignored and reported by variable name", () => {
    const config = readConfig(on({ [ENV_NAMES.platforms]: "slack,teams,Slack" }))
    expect([...config.platforms]).toEqual([])
    expect(config.problems).toContain(ENV_NAMES.platforms)
  })
})

describe("the offer signing key", () => {
  test("an Ed25519 PKCS#8 key with a key id turns offers on", () => {
    const config = readConfig(on({ [ENV_NAMES.offerSigningKey]: ed25519Pem(), [ENV_NAMES.offerKeyId]: "offer-2026-11" }))
    expect(config.offer?.kid).toBe("offer-2026-11")
    expect(config.offer?.key.asymmetricKeyType).toBe("ed25519")
    expect(config.offer?.key.type).toBe("private")
  })

  test("a PEM written with \\n escapes, as env editors store it, is read", () => {
    const escaped = ed25519Pem().trim().replace(/\n/g, "\\n")
    const config = readConfig(on({ [ENV_NAMES.offerSigningKey]: escaped, [ENV_NAMES.offerKeyId]: "k1" }))
    expect(config.offer?.key.asymmetricKeyType).toBe("ed25519")
  })

  test("a missing key or key id, another kind of key, or a bad key id means no offers", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    const cases: Env[] = [
      { [ENV_NAMES.offerSigningKey]: ed25519Pem() },
      { [ENV_NAMES.offerKeyId]: "k1" },
      { [ENV_NAMES.offerSigningKey]: rsa, [ENV_NAMES.offerKeyId]: "k1" },
      { [ENV_NAMES.offerSigningKey]: "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----", [ENV_NAMES.offerKeyId]: "k1" },
      { [ENV_NAMES.offerSigningKey]: ed25519Pem(), [ENV_NAMES.offerKeyId]: "bad key id!" },
      { [ENV_NAMES.offerSigningKey]: ed25519Pem(), [ENV_NAMES.offerKeyId]: "k".repeat(65) },
    ]
    for (const extra of cases) {
      const env = on(extra)
      const config = readConfig(env)
      expect(config.offer).toBeUndefined()
      expectNoValuesIn(config.problems, env)
    }
  })

  test("the offer key does not depend on the feature being on, but offers are a separate piece", () => {
    const config = readConfig({ [ENV_NAMES.offerSigningKey]: ed25519Pem(), [ENV_NAMES.offerKeyId]: "k1" })
    expect(config.enabled).toBe(false)
    expect(config.offer).toBeDefined()
  })
})

describe("allowed accounts and the cron secret", () => {
  test("an empty allow list means nobody", () => {
    const config = readConfig(on())
    expect(config.allowAccounts.size).toBe(0)
    expect(sponsorListed(config, randomUUID())).toBe(false)
  })

  test("account ids are read case-insensitively; anything else is dropped and reported", () => {
    const first = randomUUID()
    const second = randomUUID()
    const env = on({ [ENV_NAMES.allowAccounts]: ` ${first.toUpperCase()} ,${second},someone@example.com,,` })
    const config = readConfig(env)
    expect([...config.allowAccounts].sort()).toEqual([first, second].sort())
    expect(sponsorListed(config, first)).toBe(true)
    expect(sponsorListed(config, second.toUpperCase())).toBe(true)
    expect(sponsorListed(config, randomUUID())).toBe(false)
    expect(sponsorListed(config, "")).toBe(false)
    expect(config.problems).toContain(ENV_NAMES.allowAccounts)
    expect(JSON.stringify(config.problems)).not.toContain("example.com")
  })

  test("a short cron secret is not used", () => {
    expect(readConfig({ [ENV_NAMES.cronSecret]: "short" }).cronSecret).toBeUndefined()
    const value = secret()
    expect(readConfig({ [ENV_NAMES.cronSecret]: value }).cronSecret).toBe(value)
  })
})

describe("the Codium perk's readiness (EV-08)", () => {
  // Everything everywhereReady reads, with Slack as the open platform.
  const ready = (extra: Env = {}): Env =>
    on({
      [ENV_NAMES.offerSigningKey]: ed25519Pem(),
      [ENV_NAMES.offerKeyId]: "offer-2026-11",
      [ENV_NAMES.platforms]: "slack",
      [ENV_NAMES.cronSecret]: secret(),
      ...slackEnv(),
      ...extra,
    })
  const without = (name: string, env = ready()) =>
    Object.fromEntries(Object.entries(env).filter(([key]) => key !== name))

  test("false today, even fully configured: the laptop route and the plan check are not wired", () => {
    expect(everywhereReady(readConfig(ready()))).toBe(false)
    expect(everywhereReady(readConfig({}))).toBe(false)
    expect(everywhereReady()).toBe(false)
  })

  test("once wired: the flag and its data key, signed offers, the cron secret and Slack, Linear or Jira open", () => {
    expect(everywhereReady(readConfig(ready()), true)).toBe(true)
    expect(everywhereReady(readConfig(ready({ [ENV_NAMES.platforms]: "linear", ...linearEnv() })), true)).toBe(true)
    const jira = ready({ [ENV_NAMES.platforms]: "jira", [ENV_NAMES.jiraForgeAppId]: "ari-app" })
    expect(everywhereReady(readConfig(jira), true)).toBe(true)
    expect(everywhereReady(readConfig(ready({ [ENV_NAMES.platforms]: "github,slack" })), true)).toBe(true)
    expect(everywhereReady(readConfig({}), true)).toBe(false)
    for (const name of [
      ENV_NAMES.enabled,
      ENV_NAMES.dataKey,
      ENV_NAMES.offerSigningKey,
      ENV_NAMES.offerKeyId,
      ENV_NAMES.platforms,
      ENV_NAMES.cronSecret,
      ENV_NAMES.slackSigningSecret,
    ])
      expect([name, everywhereReady(readConfig(without(name)), true)]).toEqual([name, false])
  })

  test("GitHub alone, a flag that is not exactly true and a short cron secret are not ready", () => {
    expect(everywhereReady(readConfig(ready({ [ENV_NAMES.platforms]: "github" })), true)).toBe(false)
    // Slack listed beside GitHub but without its settings leaves only GitHub open.
    const unconfigured = without(ENV_NAMES.slackClientSecret, ready({ [ENV_NAMES.platforms]: "github,slack" }))
    expect(readConfig(unconfigured).platforms).toEqual(new Set(["github"]))
    expect(everywhereReady(readConfig(unconfigured), true)).toBe(false)
    expect(everywhereReady(readConfig(ready({ [ENV_NAMES.enabled]: "TRUE" })), true)).toBe(false)
    expect(everywhereReady(readConfig(ready({ [ENV_NAMES.cronSecret]: "short" })), true)).toBe(false)
  })
})
