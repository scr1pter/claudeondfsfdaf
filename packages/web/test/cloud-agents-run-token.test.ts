import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { RedisClient } from "bun"
import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto"
import { GithubAgents } from "@vectordevai/core/github-agents"
import {
  bindingFor,
  bindingKey,
  createBindCode,
  generationKey,
  redeemAndBind,
  revokeBinding,
  suspendBinding,
  type BindIdentity,
  type RedeemInput,
  type RepoBinding,
} from "../../../api/_lib/cloud-agents-binding"
import { ENABLED_SOURCES, type CloudAgentAllowance, type RunSource } from "../../../api/_lib/cloud-agents-entitlement"
import { liveKey, reportRun, reserveRun, settleRun, type ReserveInput } from "../../../api/_lib/cloud-agents-ledger"
import {
  cloudAgentsRunVerifier,
  mintRunToken,
  readRunToken,
  requireRunToken,
  verifyRunToken,
  type RunCaller,
  type RunTokenClaims,
  type RunTokenDeps,
} from "../../../api/_lib/cloud-agents-run-token"
import { mintCliToken, mintDeletionGrant, verifyCliToken, verifyDesktopToken } from "../../../api/_lib/cli-token"
import type { ApiRequest } from "../../../api/_lib/http"
import { requireModelPlanUser } from "../../../api/_lib/model-plan-chat"
import { persistentStore } from "../../../api/_lib/persistent-store"
import { requireUnrevokedAccount, revokeAccountTokens } from "../../../api/_lib/revocation"

// Run tokens and the verifier seam (vector-at-mention-spec 2.4, V07). The format, key and domain tests are pure; the
// rest run against a real Redis or Valkey behind an in-process fake of the store's REST endpoint, through the real
// binding and ledger modules. CI runs this file in one Bun process with the other web GitHub tests against one Valkey,
// so it never flushes: every test uses fresh accounts and repositories, afterAll deletes every key the file touched,
// and the secrets and store variables it changes are restored.

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
// The settle grace: exp is the deadline plus 15 minutes.
const GRACE = 15 * MINUTE
// 2026-10-26T08:53:20Z. Every `now` is the module's own clock; the store's expiries are durations from it.
const T = 1_793_000_000_000
const EPOCH = `p${T - 12 * DAY}`
const TOKEN = "cloud-agents-run-token-fixture"
const RUN_SECRET = "run-token-fixture-secret-".repeat(2)
const CLI_SECRET = "cli-token-fixture-secret-".repeat(2)
const LICENSE = "license-fixture-secret-".repeat(2)
const SECRETS = ["VECTOR_RUN_TOKEN_SECRET", "VECTOR_LICENSE_SECRET", "VECTOR_CLI_TOKEN_SECRET"] as const
const NAMES = ["v", "sub", "rid", "repo", "thr", "gen", "src", "pur", "epoch", "dl", "exp", "iat", "jti", "cs"]

const ACCEPTED = "accepted"
const EXPIRED = "401 MODEL_PLAN_RUN_EXPIRED"
const INVALID = "401 RUN_TOKEN_INVALID"
const BAD_REQUEST = "400 INVALID_REQUEST"
const CLI_INVALID = "401 CLI_TOKEN_INVALID"
const UNAVAILABLE = "503 PERSISTENT_STORE_UNAVAILABLE"
const UNCONFIGURED = "503 RUN_TOKENS_UNAVAILABLE"

type Secrets = Partial<Record<(typeof SECRETS)[number], string>>
type Granted = Extract<CloudAgentAllowance, { active: true }>
type Thrown = { statusCode?: number; code?: string; message?: string }
type Mintable = Omit<RunTokenClaims, "v" | "exp">

// Codium's shapes at origin/codium 99fcf1c0 and cb8e7dfb (api/_lib/model-plan-caller.ts and codium-pool.ts), which A59
// registers the verifier against.
type PoolPurpose =
  | "chat"
  | "title"
  | "brain"
  | "review"
  | "judge"
  | "race"
  | "playbook"
  | "task"
  | "cloud-agents"
  | "hosted"
type ModelPlanCaller = {
  account: { id: string }
  kind: "desktop" | "cli" | "run"
  purpose: PoolPurpose
  run?: {
    id: string
    source: RunSource
    deadline: number
    ceilingShare?: number
    service: "cloud-agents" | "hosted"
    sessionId?: string
  }
}
type RunPrefix = "vrt_" | "vht_"
type RunVerifier = (token: string) => Promise<ModelPlanCaller>
const POOL_PURPOSES = [
  "chat",
  "title",
  "brain",
  "review",
  "judge",
  "race",
  "playbook",
  "task",
  "cloud-agents",
  "hosted",
]
const CODIUM_ACCOUNT = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

const previousSecrets = Object.fromEntries(SECRETS.map((name) => [name, process.env[name]]))

function secrets(values: Secrets) {
  SECRETS.forEach((name) => {
    const value = values[name]
    return value === undefined ? delete process.env[name] : (process.env[name] = value)
  })
}

beforeEach(() => secrets({ VECTOR_RUN_TOKEN_SECRET: RUN_SECRET, VECTOR_CLI_TOKEN_SECRET: CLI_SECRET }))
afterAll(() => secrets(previousSecrets))

function jti() {
  return randomBytes(16).toString("base64url")
}

function hmac(key: string, text: string) {
  return createHmac("sha256", key).update(text).digest("base64url")
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

function payloadOf(token: string) {
  return Buffer.from(token.slice(4).split(".")[0] ?? "", "base64url").toString("utf8")
}

// A token built as the contract writes the format, independently of the module: any payload (JSON, or a raw body),
// any key, any domain, any prefix.
function forge(payload: unknown, options: { key?: string; domain?: string; prefix?: string; raw?: boolean } = {}) {
  const body = options.raw ? Buffer.from(String(payload), "utf8").toString("base64url") : encode(payload)
  const signature = hmac(options.key ?? RUN_SECRET, `${options.domain ?? "vector-run-v1"}.${body}`)
  return `${options.prefix ?? "vrt_"}${body}.${signature}`
}

// A valid claim set for a fresh account and check run, as V12 signs it.
function claims(overrides: Partial<RunTokenClaims> = {}): RunTokenClaims {
  const repo = String(randomInt(100_000_000, 1_000_000_000))
  const dl = overrides.dl ?? T + 45 * MINUTE
  return {
    v: 1,
    sub: randomUUID(),
    rid: GithubAgents.runId(repo, randomInt(1, 2 ** 40), 1, randomInt(1, 2 ** 40)),
    repo,
    thr: "42",
    gen: 1,
    src: "github-comment",
    pur: "task",
    epoch: EPOCH,
    dl,
    exp: dl + GRACE,
    iat: T,
    jti: jti(),
    cs: 0.1,
    ...overrides,
  }
}

// What mintRunToken takes: the claims without `v` and `exp`, which it sets itself.
function minting(full: RunTokenClaims): Mintable {
  const { v, exp, ...rest } = full
  return rest
}

function bearer(token: string): Pick<ApiRequest, "headers"> {
  return { headers: { authorization: `Bearer ${token}` } }
}

function described(error: unknown) {
  const thrown = error as Thrown
  return `${thrown.statusCode} ${thrown.code}`
}

async function outcome(promise: Promise<unknown>) {
  return promise.then(() => ACCEPTED, described)
}

// A synchronous call's outcome, through a promise so that a throw becomes a rejection.
function attempt(call: () => unknown) {
  return outcome(Promise.resolve().then(call))
}

// The thrown error's status, code and message, to show that different causes look exactly the same.
async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: Thrown) => [error.statusCode, error.code, error.message],
  )
}

// A store and a seam that only count, for paths that must reach neither.
function counters() {
  const commands: (readonly (string | number)[])[] = []
  const seam: string[] = []
  const deps: RunTokenDeps = {
    now: T + MINUTE,
    store: async (command) => {
      commands.push(command)
      throw new Error("no store command was expected")
    },
    revokedBefore: async (account) => {
      seam.push(account)
      throw new Error("no seam call was expected")
    },
  }
  return { commands, seam, deps }
}

// Invalid claims, each refused by mintRunToken (400) and, signed with the real key, by readRunToken (401). `read` only:
// v and exp are the mint's own.
function invalidClaims(base: RunTokenClaims): [string, Record<string, unknown>, "read"?][] {
  const otherRepo = String(Number(base.repo) + 1)
  return [
    ["an upper-case account", { sub: base.sub.toUpperCase() }],
    ["an account outside UUID versions 1 to 8", { sub: `${base.sub.slice(0, 14)}0${base.sub.slice(15)}` }],
    ["an account with another variant", { sub: `${base.sub.slice(0, 19)}c${base.sub.slice(20)}` }],
    ["an account that is no UUID", { sub: "not-an-account" }],
    ["a rid with a colon", { rid: `gh-${base.repo}:1-1-1` }],
    ["a rid of another repository", { rid: GithubAgents.runId(otherRepo, 1, 1, 1) }],
    ["a rid outside the gh- grammar", { rid: "run-1" }],
    ["a rid of one hyphen", { rid: "-" }],
    ["a rid with a leading zero", { rid: `gh-${base.repo}-01-1-1` }],
    ["a rid with a 21-digit check run id", { rid: `gh-${base.repo}-1-1-${"9".repeat(21)}` }],
    ["a repository id with a leading zero", { repo: `0${base.repo}`, rid: `gh-0${base.repo}-1-1-1` }],
    ["a repository id past 2^53", { repo: "9007199254740993", rid: "gh-9007199254740993-1-1-1" }],
    ["a numeric repository id", { repo: Number(base.repo) }],
    ["a thread of 0", { thr: "0" }],
    ["a dispatch thread of 0", { thr: "dispatch-0" }],
    ["an upper-case schedule thread", { thr: "schedule-0A1B2C3D" }],
    ["a generation of 0", { gen: 0 }],
    ["a fractional generation", { gen: 1.5 }],
    ["a generation as a string", { gen: "1" }],
    ["an unsafe generation", { gen: 2 ** 53 }],
    ["a source outside GitHub", { src: "desktop" }],
    ["a reserved source", { src: "slack" }],
    ["a scheduled purpose from a comment", { pur: "scheduled" }],
    ["a task from a schedule", { src: "github-schedule" }],
    ["an empty epoch", { epoch: "" }],
    ["an epoch starting with a hyphen", { epoch: "-p1" }],
    ["an epoch of 129 characters", { epoch: `p${"1".repeat(128)}` }],
    ["a deadline of 0", { dl: 0, exp: GRACE }],
    ["a fractional deadline", { dl: T + 0.5, exp: T + 0.5 + GRACE }],
    ["a deadline as a string", { dl: String(T + HOUR) }],
    ["a deadline at the minting time", { dl: base.iat, exp: base.iat + GRACE }],
    ["a mint after the deadline", { iat: base.dl + 1 }],
    ["a minting time of 0", { iat: 0 }],
    ["exp a millisecond late", { exp: base.dl + GRACE + 1 }, "read"],
    ["exp at the deadline", { exp: base.dl }, "read"],
    ["version 2", { v: 2 }, "read"],
    ["a jti of 21 characters", { jti: base.jti.slice(1) }],
    ["a jti of 23 characters", { jti: `${base.jti}A` }],
    ["a jti outside base64url", { jti: `${base.jti.slice(1)}+` }],
    ["a ceiling share of 0", { cs: 0 }],
    ["a negative ceiling share", { cs: -0.1 }],
    ["a ceiling share over 1", { cs: 1.0000001 }],
    ["a ceiling share of null", { cs: null }],
    ["a ceiling share as a string", { cs: "0.1" }],
  ]
}

describe("format and signature", () => {
  test("run tokens are signed as the contract writes them, and the reader needs nothing else", async () => {
    const full = claims()
    const minted = mintRunToken(minting(full))
    expect(minted).toStrictEqual({ token: minted.token, deadline: full.dl, expiresAt: full.dl + GRACE })
    const parts = minted.token.slice(4).split(".")
    expect(minted.token.startsWith("vrt_")).toBe(true)
    expect(parts).toHaveLength(2)
    // The known answer: HMAC-SHA256(key, "vector-run-v1." + payload), base64url.
    expect(parts[1]).toBe(hmac(RUN_SECRET, `vector-run-v1.${parts[0]}`))
    expect(JSON.parse(payloadOf(minted.token))).toStrictEqual(full)
    expect(readRunToken(minted.token, T)).toStrictEqual(full)
    // A payload in another key order, signed by hand, reads as the same claims.
    expect(readRunToken(forge(Object.fromEntries(Object.entries(full).reverse())), T)).toStrictEqual(full)
    // The same payload under any other domain, or none, is refused.
    const body = encode(full)
    const domains = ["vector-run-v2", "vector-cli-v1", "vector-delete-v1", "vector-run-v1.", "vector-run-v1-", ""]
    const read = await Promise.all(
      domains.map((domain) =>
        attempt(() => readRunToken(`vrt_${body}.${hmac(RUN_SECRET, domain ? `${domain}.${body}` : body)}`, T)),
      ),
    )
    expect(read).toEqual(domains.map(() => INVALID))
  })

  test("malformed, tampered and oversized tokens are refused before any claim is read", async () => {
    const token = mintRunToken(minting(claims())).token
    const body = token.slice(4).split(".")[0] ?? ""
    const signature = token.slice(4).split(".")[1] ?? ""
    const flipped = (text: string, at: number) =>
      `${text.slice(0, at)}${text[at] === "A" ? "B" : "A"}${text.slice(at + 1)}`
    const malformed = [
      "",
      "vrt_",
      "vrt_.",
      `vrt_${body}`,
      `vrt_${body}.`,
      `vrt_.${signature}`,
      `vrt_${body}.${signature}.${signature}`,
      `vrt_${body}..${signature}`,
      `vrt_${body}==.${signature}`,
      `vrt_${body}.${signature}=`,
      `vrt_${body.slice(0, 5)}+${body.slice(6)}.${signature}`,
      `vrt_${body}/.${signature}`,
      ` ${token}`,
      `${token}\n`,
      `VRT_${body}.${signature}`,
      `vct_${body}.${signature}`,
      `vrt_${flipped(body, 10)}.${signature}`,
      `vrt_${body}.${flipped(signature, 20)}`,
      `vrt_${body}.${signature.slice(1)}`,
      `vrt_${body}.${signature}A`,
    ]
    expect(await Promise.all(malformed.map((bad) => attempt(() => readRunToken(bad, T))))).toEqual(
      malformed.map(() => INVALID),
    )
    expect(await attempt(() => readRunToken(17 as unknown as string, T))).toBe(INVALID)
    // Without a key, a well-formed token of 1024 characters needs one, and one of 1025 is refused before any HMAC.
    secrets({})
    const longest = `vrt_${"A".repeat(976)}.${"A".repeat(43)}`
    expect(longest).toHaveLength(1024)
    expect(await attempt(() => readRunToken(longest, T))).toBe(UNCONFIGURED)
    expect(await attempt(() => readRunToken(`${longest}A`, T))).toBe(INVALID)
  })

  test("an unknown, missing or malformed claim is refused by the reader and by the mint", async () => {
    const base = claims()
    const forged = (payload: unknown, raw = false) => attempt(() => readRunToken(forge(payload, { raw }), T))
    expect(await forged(base)).toBe(ACCEPTED)
    expect(await forged({ ...base, email: "binder@example.com" })).toBe(INVALID)
    expect(await forged({ ...base, plan: "vector-100" })).toBe(INVALID)
    expect(await forged({ ...base, x: 1 })).toBe(INVALID)
    const required = NAMES.filter((name) => name !== "cs")
    expect(await Promise.all(required.map((name) => forged({ ...base, [name]: undefined })))).toEqual(
      required.map(() => INVALID),
    )
    expect(await forged({ ...base, cs: undefined })).toBe(ACCEPTED)
    expect(await forged([base])).toBe(INVALID)
    expect(await forged("{", true)).toBe(INVALID)
    expect(await forged(`${JSON.stringify(base)} x`, true)).toBe(INVALID)
    const cases = invalidClaims(base)
    expect(await Promise.all(cases.map(async (entry) => [entry[0], await forged({ ...base, ...entry[1] })]))).toEqual(
      cases.map((entry) => [entry[0], INVALID]),
    )
    const minted = cases.filter((entry) => entry[2] !== "read")
    expect(
      await Promise.all(
        minted.map(async (entry) => [
          entry[0],
          await attempt(() => mintRunToken({ ...minting(base), ...entry[1] } as Mintable)),
        ]),
      ),
    ).toEqual(minted.map((entry) => [entry[0], BAD_REQUEST]))
    // A schedule is a scheduled run; a ceiling share of 1 is allowed; a run without a ceiling share is valid.
    const schedule = { ...minting(base), src: "github-schedule", pur: "scheduled", thr: "schedule-0a1b2c3d" } as const
    expect(await attempt(() => mintRunToken(schedule))).toBe(ACCEPTED)
    expect(await attempt(() => mintRunToken({ ...minting(base), cs: 1 }))).toBe(ACCEPTED)
    const shareless = minting(base)
    delete shareless.cs
    expect(Object.keys(JSON.parse(payloadOf(mintRunToken(shareless).token)))).toEqual(required)
    expect(Object.keys(JSON.parse(payloadOf(mintRunToken({ ...shareless, cs: undefined }).token)))).toEqual(required)
  })

  test("the longest valid claims make a token of at most 1024 characters", () => {
    const longest = claims({
      repo: "9007199254740991",
      rid: GithubAgents.runId("9007199254740991", "9".repeat(20), "9".repeat(20), "9".repeat(20)),
      thr: `dispatch-${"9".repeat(20)}`,
      gen: Number.MAX_SAFE_INTEGER,
      src: "github-schedule",
      pur: "scheduled",
      epoch: `p${"9".repeat(127)}`,
      dl: Number.MAX_SAFE_INTEGER - GRACE,
      exp: Number.MAX_SAFE_INTEGER,
      iat: Number.MAX_SAFE_INTEGER - GRACE - 1,
      cs: 2.2250738585072014e-308,
    })
    const token = mintRunToken(minting(longest)).token
    expect(token.length).toBeLessThanOrEqual(1024)
    expect(readRunToken(token, T)).toStrictEqual(longest)
  })

  test("payload has no email", async () => {
    const full = claims()
    const payload = payloadOf(mintRunToken(minting(full)).token)
    // Exactly 2.4's claims, in one order: the account id, never an email, a plan, limits or model authority.
    expect(Object.keys(JSON.parse(payload))).toEqual(NAMES)
    expect(payload).not.toContain("@")
    expect(JSON.parse(payload).sub).toBe(full.sub)
    // @ts-expect-error: a run token carries the account id only (INV-P4)
    const withEmail: Mintable = { ...minting(full), email: "binder@example.com" }
    expect(await attempt(() => mintRunToken(withEmail))).toBe(BAD_REQUEST)
    const extras = [{ plan: "vector-100" }, { limits: { atOnce: 2 } }, { model: "fixture" }, { premiumModels: true }]
    expect(
      await Promise.all(extras.map((extra) => attempt(() => mintRunToken({ ...minting(full), ...extra } as Mintable)))),
    ).toEqual(extras.map(() => BAD_REQUEST))
  })
})

describe("keys", () => {
  test("the key: a dedicated secret of at least 32 characters, else one derived from a license secret of 32", async () => {
    const derived = hmac(LICENSE, "vector-run-token-key-v1")
    const read = (token: string) => attempt(() => readRunToken(token, T))
    // Only the license secret: tokens round-trip under the derived key.
    secrets({ VECTOR_LICENSE_SECRET: LICENSE })
    const fromLicense = mintRunToken(minting(claims())).token
    expect(await read(fromLicense)).toBe(ACCEPTED)
    // The derivation is HMAC-SHA256(license, "vector-run-token-key-v1") as base64url: set as the dedicated secret,
    // with no license secret at all, it keeps the token valid.
    secrets({ VECTOR_RUN_TOKEN_SECRET: derived })
    expect(await read(fromLicense)).toBe(ACCEPTED)
    // Neither the raw license secret nor the CLI token key derived from it signs a run token.
    secrets({ VECTOR_LICENSE_SECRET: LICENSE })
    const full = claims()
    expect(await read(forge(full, { key: derived }))).toBe(ACCEPTED)
    expect(await read(forge(full, { key: LICENSE }))).toBe(INVALID)
    expect(await read(forge(full, { key: hmac(LICENSE, "vector-cli-token-key-v1") }))).toBe(INVALID)
    // A dedicated secret of 31 characters is ignored for the license secret's key.
    secrets({ VECTOR_RUN_TOKEN_SECRET: "s".repeat(31), VECTOR_LICENSE_SECRET: LICENSE })
    const short = mintRunToken(minting(claims())).token
    secrets({ VECTOR_LICENSE_SECRET: LICENSE })
    expect(await read(short)).toBe(ACCEPTED)
    // One of exactly 32 is the key itself.
    const exact = "e".repeat(32)
    secrets({ VECTOR_RUN_TOKEN_SECRET: exact, VECTOR_LICENSE_SECRET: LICENSE })
    const dedicated = mintRunToken(minting(claims())).token
    expect(dedicated.split(".")[1]).toBe(hmac(exact, `vector-run-v1.${dedicated.slice(4).split(".")[0]}`))
    secrets({ VECTOR_LICENSE_SECRET: LICENSE })
    expect(await read(dedicated)).toBe(INVALID)
    // A license secret of 32 characters is enough.
    secrets({ VECTOR_LICENSE_SECRET: "l".repeat(32) })
    expect(await read(mintRunToken(minting(claims())).token)).toBe(ACCEPTED)
  })

  test("without a usable secret, nothing is minted or read and no store or seam is asked", async () => {
    const token = mintRunToken(minting(claims())).token
    const unusable: Secrets[] = [
      {},
      { VECTOR_LICENSE_SECRET: "l".repeat(31) },
      { VECTOR_RUN_TOKEN_SECRET: "s".repeat(31) },
      { VECTOR_RUN_TOKEN_SECRET: "s".repeat(31), VECTOR_LICENSE_SECRET: "l".repeat(31) },
      { VECTOR_CLI_TOKEN_SECRET: CLI_SECRET },
    ]
    for (const configured of unusable) {
      secrets(configured)
      const counted = counters()
      expect({
        configured,
        outcomes: [
          await attempt(() => mintRunToken(minting(claims()))),
          await attempt(() => readRunToken(token, T)),
          await outcome(verifyRunToken(token, counted.deps)),
          await outcome(requireRunToken(bearer(token), { allowAfterDeadline: true }, counted.deps)),
        ],
      }).toEqual({ configured, outcomes: [UNCONFIGURED, UNCONFIGURED, UNCONFIGURED, UNCONFIGURED] })
      expect([counted.commands, counted.seam]).toEqual([[], []])
      // Malformed claims are still a bad request, and a malformed token still an invalid one.
      expect(await attempt(() => mintRunToken({ ...minting(claims()), gen: 0 }))).toBe(BAD_REQUEST)
      expect(await attempt(() => readRunToken("vrt_x", T))).toBe(INVALID)
    }
  })
})

test("domain separation both ways", async () => {
  // The same raw secret for both kinds of token: only the HMAC domain tells them apart.
  const shared = "shared-fixture-secret-".repeat(2)
  secrets({ VECTOR_RUN_TOKEN_SECRET: shared, VECTOR_CLI_TOKEN_SECRET: shared })
  const now = Date.now()
  const user = { id: randomUUID(), email: "binder@example.com" }
  const full = claims({ sub: user.id, dl: now + HOUR, iat: now })
  const run = mintRunToken(minting(full)).token
  const requests: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    requests.push(String(input))
    return Response.json({ result: null })
  }) as typeof fetch
  // A run token is never a CLI or desktop token, nor a Codium account caller, and costs those checks no store call.
  expect(await attempt(() => verifyCliToken(run))).toBe(CLI_INVALID)
  expect(await attempt(() => verifyDesktopToken(run))).toBe(CLI_INVALID)
  expect(await attempt(() => verifyCliToken(`vct_${run.slice(4)}`))).toBe(CLI_INVALID)
  expect(await outcome(requireModelPlanUser(bearer(run) as ApiRequest, fetcher))).toBe(CLI_INVALID)
  expect(requests).toEqual([])
  // None of the account's other tokens is a run token, whatever its prefix.
  const cli = mintCliToken(user).token
  const desktop = mintCliToken(user, now, "desktop").token
  const grant = mintDeletionGrant(user).grant
  expect(verifyCliToken(cli)).toEqual(user)
  const others = [cli, desktop, grant, `vrt_${cli.slice(4)}`, `vrt_${desktop.slice(4)}`, `vrt_${grant.slice(4)}`]
  expect(await Promise.all(others.map((other) => attempt(() => readRunToken(other, now))))).toEqual(
    others.map(() => INVALID),
  )
  // A run payload under the CLI domain is refused; under its own domain, with the same key, it is accepted.
  expect(await attempt(() => readRunToken(forge(full, { key: shared, domain: "vector-cli-v1" }), now))).toBe(INVALID)
  expect(await attempt(() => readRunToken(forge(full, { key: shared }), now))).toBe(ACCEPTED)
  // A CLI-shaped payload under the run domain is refused as a CLI token; under the CLI domain it is accepted.
  const cliPayload = { v: 1, sub: user.id, email: user.email, exp: now + HOUR }
  expect(await attempt(() => verifyCliToken(forge(cliPayload, { key: shared, prefix: "vct_" })))).toBe(CLI_INVALID)
  expect(verifyCliToken(forge(cliPayload, { key: shared, domain: "vector-cli-v1", prefix: "vct_" }))).toEqual(user)
})

integrationTests()

function integrationTests() {
  const configured = process.env.VECTOR_TEST_REDIS_URL
  // V07's done-criterion is this file passing against a loopback Redis, so a missing one fails instead of skipping.
  if (!configured) {
    test("run token tests need VECTOR_TEST_REDIS_URL, a disposable loopback Redis or Valkey", () => {
      throw new Error("Set VECTOR_TEST_REDIS_URL=redis://127.0.0.1:<port> (contract 0.3).")
    })
    return
  }
  const url = new URL(configured)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Run token tests require loopback Redis")
  const redis = new RedisClient(url.href, { connectionTimeout: 1000, enableOfflineQueue: false })
  const state = { down: false, corrupt: false }
  const commands: string[][] = []
  const keys = new Set<string>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 })
      const path = new URL(request.url).pathname.split("/")
      // revokeAccountTokens' path-style write: POST /set/<key>/<value>?ex=<seconds>.
      const command =
        path[1] === "set"
          ? [
              "SET",
              decodeURIComponent(path[2] ?? ""),
              path[3] ?? "",
              "EX",
              new URL(request.url).searchParams.get("ex") ?? "",
            ]
          : ((await request.json()) as unknown[]).map(String)
      commands.push(command)
      if (state.down) return new Response(null, { status: 503 })
      if (state.corrupt) return Response.json({ result: { unexpected: true } })
      for (const key of command[0] === "EVAL" ? command.slice(3, 3 + Number(command[2])) : [command[1] ?? ""])
        keys.add(key)
      // Recognize the verifier by its binding/generation/live/revocation key layout: other writers also fence
      // revocation. EVAL_RO still proves that verification never writes on any path.
      const check = command[0] === "EVAL" && ["4", "5"].includes(command[2] ?? "")
        && command[3]?.startsWith("vector:cloud-agents:binding:")
        && command[4]?.startsWith("vector:cloud-agents:gen:")
        && command[5]?.startsWith("vector:cloud-agents:live:")
        && command[6]?.startsWith("vector:cli-revoked:")
      return redis.send(check ? "EVAL_RO" : (command[0] ?? ""), command.slice(1)).then(
        (result) => Response.json({ result }),
        (error: unknown) => Response.json({ error: String(error) }, { status: 400 }),
      )
    },
  })
  const environment = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]
  const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]))

  beforeAll(async () => {
    await redis.connect()
    expect(await redis.send("PING", [])).toBe("PONG")
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    Object.assign(process.env, { KV_REST_API_URL: upstream.url.origin, KV_REST_API_TOKEN: TOKEN })
  })
  beforeEach(() => {
    state.down = false
    state.corrupt = false
    commands.length = 0
  })
  afterAll(async () => {
    if (keys.size) await redis.send("DEL", [...keys])
    redis.close()
    upstream.stop(true)
    environment.forEach((key) =>
      previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key]),
    )
  })

  function repository(): BindIdentity {
    const repositoryId = String(randomInt(100_000_000, 1_000_000_000))
    return {
      repository: `octo-${repositoryId}/app`,
      repositoryId,
      ownerId: String(randomInt(1_000_000, 10_000_000)),
      actor: "octocat",
      actorId: "583231",
      ref: "refs/heads/main",
    }
  }

  // Binds the way V10 will: the binder V10 judged O6 against is the one bindingFor reads just before.
  async function bind(account: string, who: BindIdentity, now: number, input: Partial<RedeemInput> = {}) {
    const issued = await createBindCode({
      account,
      repository: who.repository,
      repositoryId: who.repositoryId,
      githubUserId: who.actorId,
      now: now - 1_000,
    })
    const current = (await bindingFor(who.repositoryId))?.account
    return redeemAndBind({
      code: issued.code,
      account,
      ...(current === undefined ? {} : { current }),
      identity: who,
      workflowVersion: "3",
      takeover: { adminVerified: false, allowanceInactive: false },
      now,
      ...input,
    })
  }

  // Max's row of contract 1.1, typed in as a literal: this file never reads the entitlement module's table.
  function allowance(): Granted {
    return {
      active: true,
      plan: "vector-100",
      limits: { atOnce: 2, hours: 40, longestRunMin: 45, scheduledPerDay: 5, runCeilingShare: 0.1 },
      allowanceSeconds: 40 * 3600,
      meterEpoch: EPOCH,
      periodEnd: T + 18 * DAY,
      premiumModels: true,
    }
  }

  async function reserve(input: ReserveInput) {
    const result = await reserveRun(input)
    if (!result.ok) throw new Error(`The reservation was refused: ${JSON.stringify(result)}`)
    return result
  }

  type Reserved = Awaited<ReturnType<typeof reserve>>
  type Fixture = { account: string; who: BindIdentity; binding: RepoBinding; input: ReserveInput }

  // What V12 signs after a reservation: the record's values from the answer, the binding's account and generation, and
  // the reservation's jti.
  function sign(fixture: Fixture, reserved: Reserved, input: { jti: string; now: number }) {
    return mintRunToken({
      sub: fixture.account,
      rid: fixture.input.rid,
      repo: fixture.who.repositoryId,
      thr: reserved.thread,
      gen: fixture.binding.generation,
      src: reserved.source,
      pur: reserved.purpose,
      epoch: reserved.epoch,
      dl: reserved.deadline,
      iat: input.now,
      jti: input.jti,
      cs: 0.1,
    }).token
  }

  // A bound repository, a reserved run and its token, as V10 and V12 make them.
  async function run(now = T) {
    const account = randomUUID()
    const who = repository()
    const binding = await bind(account, who, now - MINUTE)
    const input: ReserveInput = {
      account,
      rid: GithubAgents.runId(who.repositoryId, randomInt(1, 2 ** 40), 1, randomInt(1, 2 ** 40)),
      repositoryId: who.repositoryId,
      thread: String(randomInt(1, 100_000)),
      generation: binding.generation,
      jti: jti(),
      source: "github-comment",
      purpose: "task",
      allowance: allowance(),
      now,
    }
    const fixture = { account, who, binding, input }
    const reserved = await reserve(input)
    const token = sign(fixture, reserved, input)
    commands.length = 0
    return { ...fixture, reserved, token, claims: readRunToken(token, now) }
  }

  // The token through the gateway path and both service paths, at one time.
  async function everywhere(token: string, deps: RunTokenDeps = {}) {
    const at = { now: T + MINUTE, ...deps }
    return Promise.all([
      outcome(verifyRunToken(token, at)),
      outcome(requireRunToken(bearer(token), { allowAfterDeadline: true }, at)),
      outcome(requireRunToken(bearer(token), { allowAfterDeadline: false }, at)),
    ])
  }

  // console.warn's lines while `body` runs, silenced, as the ledger test reads its miss lines.
  async function logged(body: () => Promise<void>) {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await body()
      return [...warn.mock.calls]
    } finally {
      warn.mockRestore()
    }
  }

  // `count` copies of the one line a failure logs: its cause and the run id, nothing else.
  function failed(count: number, cause: string, runId: string) {
    return Array.from({ length: count }, () => ["Vector cloud-agents run token check failed", { cause, runId }])
  }

  const accepted: [string, string, string] = [ACCEPTED, ACCEPTED, ACCEPTED]
  const expired: [string, string, string] = [EXPIRED, EXPIRED, EXPIRED]
  const unavailable: [string, string, string] = [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]

  // Writes made by the test itself, outside the fake store.
  async function write(command: string, key: string, args: string[]) {
    keys.add(key)
    await redis.send(command, [key, ...args])
  }

  // Everything the check reads, to show a call changed nothing.
  async function contents(fixture: Fixture) {
    const read = async (key: string) => {
      const type = await redis.send("TYPE", [key])
      if (type === "hash") return [type, await redis.send("HGETALL", [key])]
      if (type === "set") return [type, [...((await redis.send("SMEMBERS", [key])) as string[])].sort()]
      if (type === "string") return [type, await redis.send("GET", [key])]
      return [type]
    }
    return Promise.all(
      [
        bindingKey(fixture.who.repositoryId),
        generationKey(fixture.who.repositoryId),
        liveKey(fixture.account),
        `vector:cli-revoked:${fixture.account}`,
      ].map(read),
    )
  }

  test("rebind, unbind, settle, replacement, revocation and revokedBefore each invalidate", async () => {
    // A rebind by the same account, and a takeover by another, move the generation.
    const rebound = await run()
    expect(await everywhere(rebound.token)).toEqual(accepted)
    const rebind = await bind(rebound.account, rebound.who, T + 2 * MINUTE)
    expect(rebind.generation).toBe(rebound.binding.generation + 1)
    expect(await everywhere(rebound.token)).toEqual(expired)
    const taken = await run()
    expect(await everywhere(taken.token)).toEqual(accepted)
    await bind(randomUUID(), taken.who, T + 2 * MINUTE, { takeover: { adminVerified: true, allowanceInactive: false } })
    expect(await everywhere(taken.token)).toEqual(expired)
    // An unbind removes the binding; a suspension moves the generation once.
    const unbound = await run()
    expect(await everywhere(unbound.token)).toEqual(accepted)
    expect(await revokeBinding(unbound.who.repositoryId, unbound.account)).toBe(true)
    expect(await everywhere(unbound.token)).toEqual(expired)
    const suspended = await run()
    expect(await everywhere(suspended.token)).toEqual(accepted)
    await suspendBinding(suspended.binding, "transferred")
    expect(await everywhere(suspended.token)).toEqual(expired)
    // A settle removes the live record.
    const settled = await run()
    expect(await everywhere(settled.token)).toEqual(accepted)
    expect(await settleRun(settled.account, settled.input.rid, settled.claims)).toMatchObject({ settled: true })
    expect(await everywhere(settled.token)).toEqual(expired)
    // A later mint of the same check run replaces the record's jti.
    const replaced = await run()
    const renewal = { jti: jti(), now: T + 2 * MINUTE }
    const renewed = await reserve({ ...replaced.input, ...renewal })
    expect(renewed.renewed).toBe(true)
    expect(await everywhere(replaced.token)).toEqual(expired)
    expect(await everywhere(sign(replaced, renewed, renewal))).toEqual(accepted)
    // A revoked account, through the revocation list's own writer, under the key its own reader checks.
    const revoked = await run()
    expect(await everywhere(revoked.token)).toEqual(accepted)
    const check = commands.find((command) => command[0] === "EVAL")
    expect(await revokeAccountTokens(revoked.account)).toBe(true)
    expect(await outcome(requireUnrevokedAccount(revoked.account))).toBe("401 CLI_TOKEN_INVALID")
    const mark = commands.find((command) => command[0] === "SET")
    expect(mark?.[1]).toBe(check?.[6])
    expect(await everywhere(revoked.token)).toEqual(expired)
    // revokedBefore: a mark after the token's iat refuses it; one at iat, earlier or none does not.
    const marked = await run()
    const before = (value: number | undefined) => ({ revokedBefore: async () => value })
    expect(await everywhere(marked.token, before(marked.claims.iat + 1))).toEqual(expired)
    expect(await everywhere(marked.token, before(marked.claims.iat))).toEqual(accepted)
    expect(await everywhere(marked.token, before(0))).toEqual(accepted)
    expect(await everywhere(marked.token, before(undefined))).toEqual(accepted)
  })

  test("a binding that names another account at its generation refuses the token", async () => {
    const fixture = await run()
    expect(await everywhere(fixture.token)).toEqual(accepted)
    await write("HSET", bindingKey(fixture.who.repositoryId), ["account", randomUUID()])
    expect(await everywhere(fixture.token)).toEqual(expired)
    await write("HSET", bindingKey(fixture.who.repositoryId), ["account", fixture.account])
    expect(await everywhere(fixture.token)).toEqual(accepted)
  })

  test("the replaced token is refused", async () => {
    const first = await run()
    const renewal = { jti: jti(), now: T + 2 * MINUTE }
    const renewed = await reserve({ ...first.input, ...renewal })
    expect(renewed).toMatchObject({ renewed: true, startedAt: T, deadline: first.reserved.deadline })
    const second = sign(first, renewed, renewal)
    expect(await everywhere(first.token, { now: T + 3 * MINUTE })).toEqual(expired)
    expect(await everywhere(second, { now: T + 3 * MINUTE })).toEqual(accepted)
    // At or after the deadline a re-mint is refused and leaves the token that still settles the run alone: it works on
    // the service paths until exp, and nowhere after the deadline at the gateway.
    const dl = renewed.deadline
    expect(await reportRun(first.account, first.input.rid, renewal, dl - MINUTE)).toEqual({ live: true, deadline: dl })
    expect(await reserveRun({ ...first.input, jti: jti(), now: dl })).toEqual({ ok: false, limit: "at-once" })
    const service = (now: number) => outcome(requireRunToken(bearer(second), { allowAfterDeadline: true }, { now }))
    expect([await service(dl), await service(dl + GRACE - 1), await service(dl + GRACE)]).toEqual([
      ACCEPTED,
      ACCEPTED,
      EXPIRED,
    ])
    expect(await outcome(verifyRunToken(second, { now: dl }))).toBe(EXPIRED)
    expect(await outcome(verifyRunToken(first.token, { now: dl - 1 }))).toBe(EXPIRED)
    expect(await settleRun(first.account, first.input.rid, readRunToken(second, dl))).toMatchObject({ settled: true })
    expect(await service(dl + 1)).toBe(EXPIRED)
  })

  test("deadline versus exp on the two paths", async () => {
    const fixture = await run()
    const dl = fixture.claims.dl
    const exp = fixture.claims.exp
    expect(exp).toBe(dl + GRACE)
    const gateway = (now: number) => outcome(verifyRunToken(fixture.token, { now }))
    const service = (now: number, allowAfterDeadline: boolean) =>
      outcome(requireRunToken(bearer(fixture.token), { allowAfterDeadline }, { now }))
    expect([await gateway(dl - 1), await gateway(dl)]).toEqual([ACCEPTED, EXPIRED])
    expect([await service(dl, true), await service(exp - 1, true), await service(exp, true)]).toEqual([
      ACCEPTED,
      ACCEPTED,
      EXPIRED,
    ])
    expect([await service(dl - 1, false), await service(dl, false)]).toEqual([ACCEPTED, EXPIRED])
    expect([
      await attempt(() => readRunToken(fixture.token, exp - 1)),
      await attempt(() => readRunToken(fixture.token, exp)),
    ]).toEqual([ACCEPTED, EXPIRED])
    // A clock that is not a number refuses rather than accepts.
    expect(await gateway(Number.NaN)).toBe(EXPIRED)
    expect(await service(Number.NaN, true)).toBe(EXPIRED)
    // Only a true allowAfterDeadline allows a token past its deadline.
    const loose = { allowAfterDeadline: "yes" } as unknown as { allowAfterDeadline: boolean }
    expect(await outcome(requireRunToken(bearer(fixture.token), loose, { now: dl }))).toBe(EXPIRED)
  })

  test("every refusal is the same 401, and every invalid token the same other 401", async () => {
    const refusals = [
      // revoked
      await run().then(async (fixture) => {
        await revokeAccountTokens(fixture.account)
        return failure(verifyRunToken(fixture.token, { now: T + MINUTE }))
      }),
      // unbound
      await run().then(async (fixture) => {
        await revokeBinding(fixture.who.repositoryId, fixture.account)
        return failure(verifyRunToken(fixture.token, { now: T + MINUTE }))
      }),
      // the generation moved
      await run().then(async (fixture) => {
        await bind(fixture.account, fixture.who, T + MINUTE)
        return failure(verifyRunToken(fixture.token, { now: T + MINUTE }))
      }),
      // settled
      await run().then(async (fixture) => {
        await settleRun(fixture.account, fixture.input.rid, fixture.claims)
        return failure(requireRunToken(bearer(fixture.token), { allowAfterDeadline: true }, { now: T + MINUTE }))
      }),
      // replaced
      await run().then(async (fixture) => {
        await reserve({ ...fixture.input, jti: jti(), now: T + MINUTE })
        return failure(verifyRunToken(fixture.token, { now: T + MINUTE }))
      }),
      // revokedBefore
      await run().then((fixture) =>
        failure(verifyRunToken(fixture.token, { now: T + MINUTE, revokedBefore: async () => T + 1 })),
      ),
      // the deadline, and exp
      await run().then((fixture) => failure(verifyRunToken(fixture.token, { now: fixture.claims.dl }))),
      await run().then((fixture) =>
        failure(Promise.resolve().then(() => readRunToken(fixture.token, fixture.claims.exp))),
      ),
    ]
    expect(refusals[0]?.[1]).toBe("MODEL_PLAN_RUN_EXPIRED")
    expect(refusals).toEqual(refusals.map(() => refusals[0]))
    const token = mintRunToken(minting(claims())).token
    const invalid = [
      await failure(verifyRunToken(`${token}A`)),
      await failure(verifyRunToken(forge({ ...claims(), x: 1 }))),
      await failure(verifyRunToken(forge(claims(), { domain: "vector-cli-v1" }))),
      await failure(verifyRunToken(`vrt_${"A".repeat(1100)}.A`)),
      await failure(verifyRunToken(mintCliToken({ id: randomUUID(), email: "binder@example.com" }).token)),
      await failure(requireRunToken({ headers: {} }, { allowAfterDeadline: true })),
    ]
    expect(invalid[0]?.[1]).toBe("RUN_TOKEN_INVALID")
    expect(invalid).toEqual(invalid.map(() => invalid[0]))
    // No message names a cause, a plan or a billing state (INV-P1).
    expect(
      refusals
        .concat(invalid)
        .map((error) => String(error?.[2]))
        .filter((message) =>
          /plan|share|billing|payment|dispute|fraud|revoked|settled|bound|generation/i.test(message),
        ),
    ).toEqual([])
  })

  test("only an exact Bearer header is read", async () => {
    const fixture = await run()
    const headers = [
      {},
      { authorization: fixture.token },
      { authorization: `bearer ${fixture.token}` },
      { authorization: `Bearer  ${fixture.token}` },
      { authorization: `Bearer ${fixture.token} ` },
      { authorization: `Basic ${fixture.token}` },
      { authorization: `Bearer ${fixture.token.replace("vrt_", "vct_")}` },
    ]
    const results = await Promise.all(
      headers.map((value) => outcome(requireRunToken({ headers: value }, { allowAfterDeadline: true }, { now: T }))),
    )
    expect(results).toEqual(headers.map(() => INVALID))
    expect(commands).toEqual([])
    expect(await outcome(requireRunToken(bearer(fixture.token), { allowAfterDeadline: true }, { now: T }))).toBe(
      ACCEPTED,
    )
  })

  test("one EVAL with the four keys and one seam call per verification; refused tokens cost none", async () => {
    const fixture = await run()
    const seam: string[] = []
    const revokedBefore = async (account: string) => {
      seam.push(account)
      return undefined
    }
    const caller = await verifyRunToken(fixture.token, { now: T + MINUTE, revokedBefore })
    expect(caller.run.id).toBe(fixture.input.rid)
    expect(commands).toHaveLength(1)
    expect(commands[0]?.[0]).toBe("EVAL")
    expect(commands[0]?.slice(2, 7)).toEqual([
      "4",
      bindingKey(fixture.who.repositoryId),
      generationKey(fixture.who.repositoryId),
      liveKey(fixture.account),
      `vector:cli-revoked:${fixture.account}`,
    ])
    expect(commands[0]?.slice(7)).toEqual([
      fixture.account,
      String(fixture.binding.generation),
      fixture.input.rid,
      fixture.input.jti,
    ])
    expect(seam).toEqual([fixture.account])
    commands.length = 0
    seam.length = 0
    await requireRunToken(bearer(fixture.token), { allowAfterDeadline: true }, { now: T + MINUTE, revokedBefore })
    expect([commands.length, seam]).toEqual([1, [fixture.account]])
    // A token readRunToken refuses, or one past its deadline at the gateway, reaches neither.
    commands.length = 0
    seam.length = 0
    const refused = [
      verifyRunToken(`${fixture.token}A`, { now: T + MINUTE, revokedBefore }),
      verifyRunToken(fixture.token, { now: fixture.claims.dl, revokedBefore }),
      verifyRunToken(fixture.token, { now: fixture.claims.exp, revokedBefore }),
      requireRunToken(bearer(fixture.token), { allowAfterDeadline: false }, { now: fixture.claims.dl, revokedBefore }),
      requireRunToken(bearer(fixture.token), { allowAfterDeadline: true }, { now: fixture.claims.exp, revokedBefore }),
    ]
    expect(await Promise.all(refused.map(outcome))).toEqual([INVALID, EXPIRED, EXPIRED, EXPIRED, EXPIRED])
    expect([commands, seam]).toEqual([[], []])
  })

  test("the EVAL and the seam call run in parallel", async () => {
    const fixture = await run()
    // Each waits for the other to start, so either order run one after the other would time out here.
    const evalStarted = Promise.withResolvers<void>()
    const seamStarted = Promise.withResolvers<void>()
    const within = (promise: Promise<void>, what: string) => {
      const timer = Promise.withResolvers<void>()
      const handle = setTimeout(() => timer.reject(new Error(`${what} did not start in parallel`)), 2_000)
      return Promise.race([promise, timer.promise]).finally(() => clearTimeout(handle))
    }
    const deps: RunTokenDeps = {
      now: T + MINUTE,
      store: async (command) => {
        evalStarted.resolve()
        await within(seamStarted.promise, "the seam call")
        return persistentStore(command)
      },
      revokedBefore: async () => {
        seamStarted.resolve()
        await within(evalStarted.promise, "the EVAL")
        return undefined
      },
    }
    expect(await outcome(verifyRunToken(fixture.token, deps))).toBe(ACCEPTED)
  })

  test("store outage fails closed", async () => {
    const fixture = await run()
    const before = await contents(fixture)
    const answers = ["OK", "ok ", 1, null, ["ok"], { ok: true }]
    const lines = await logged(async () => {
      state.down = true
      expect(await everywhere(fixture.token)).toEqual(unavailable)
      state.down = false
      state.corrupt = true
      expect(await everywhere(fixture.token)).toEqual(unavailable)
      state.corrupt = false
      // An answer the module does not know, and a store that fails in any other way, are the same 503.
      for (const answer of answers)
        expect({ answer, outcome: await everywhere(fixture.token, { store: async () => answer }) }).toEqual({
          answer,
          outcome: unavailable,
        })
      expect(await everywhere(fixture.token, { store: async () => Promise.reject(new TypeError("fixture")) })).toEqual(
        unavailable,
      )
      // A store that throws instead of rejecting, as a wrapper V12 passes in may.
      const throwing = () => {
        throw new TypeError("fixture")
      }
      expect(await everywhere(fixture.token, { store: throwing })).toEqual(unavailable)
      expect(await contents(fixture)).toEqual(before)
      expect(await everywhere(fixture.token)).toEqual(accepted)
    })
    // One line per failed call, with its cause and the run id: no account, and no upstream error text.
    expect(lines).toEqual([
      ...failed(3, "store", fixture.input.rid),
      ...failed(3 + 3 * answers.length, "unknown answer", fixture.input.rid),
      ...failed(6, "store", fixture.input.rid),
    ])
    expect(JSON.stringify(lines)).not.toContain(fixture.account)
    expect(JSON.stringify(lines)).not.toContain("fixture")
  })

  test("corrupt or foreign stored data fails closed and changes nothing", async () => {
    const record = (fixture: Fixture) => redis.send("HGET", [liveKey(fixture.account), fixture.input.rid])
    const corruptions: [string, (fixture: Fixture) => Promise<void>][] = [
      [
        "the binding's account is no account id",
        (f) => write("HSET", bindingKey(f.who.repositoryId), ["account", "x"]),
      ],
      [
        "the binding's account is upper case",
        (f) => write("HSET", bindingKey(f.who.repositoryId), ["account", f.account.toUpperCase()]),
      ],
      ["the binding has no account", (f) => write("HDEL", bindingKey(f.who.repositoryId), ["account"])],
      [
        "the binding's generation has a leading zero",
        (f) => write("HSET", bindingKey(f.who.repositoryId), ["generation", `0${f.binding.generation}`]),
      ],
      ["the binding has no generation", (f) => write("HDEL", bindingKey(f.who.repositoryId), ["generation"])],
      [
        "the counter differs from the binding's generation",
        (f) => write("SET", generationKey(f.who.repositoryId), [String(f.binding.generation + 1)]),
      ],
      ["the counter is gone while the binding exists", (f) => write("DEL", generationKey(f.who.repositoryId), [])],
      ["the live record is not JSON", (f) => write("HSET", liveKey(f.account), [f.input.rid, "{"])],
      ["the live record is a JSON string", (f) => write("HSET", liveKey(f.account), [f.input.rid, '"run"'])],
      [
        "the live record's jti is not a string",
        async (f) =>
          write("HSET", liveKey(f.account), [
            f.input.rid,
            JSON.stringify({ ...JSON.parse(String(await record(f))), jti: 5 }),
          ]),
      ],
      [
        "the binding is a string",
        async (f) => {
          await write("DEL", bindingKey(f.who.repositoryId), [])
          await write("SET", bindingKey(f.who.repositoryId), ["x"])
        },
      ],
      [
        "the counter is a hash",
        async (f) => {
          await write("DEL", generationKey(f.who.repositoryId), [])
          await write("HSET", generationKey(f.who.repositoryId), ["generation", String(f.binding.generation)])
        },
      ],
      [
        "the live runs are a string",
        async (f) => {
          await write("DEL", liveKey(f.account), [])
          await write("SET", liveKey(f.account), ["x"])
        },
      ],
      ["the revocation mark is a set", (f) => write("SADD", `vector:cli-revoked:${f.account}`, ["1"])],
    ]
    for (const corruption of corruptions) {
      const fixture = await run()
      expect(await everywhere(fixture.token)).toEqual(accepted)
      await corruption[1](fixture)
      const before = await contents(fixture)
      // Logged as corrupt data, not as an outage, so the bad key can be found from the run.
      const lines = await logged(async () =>
        expect({ name: corruption[0], outcome: await everywhere(fixture.token) }).toEqual({
          name: corruption[0],
          outcome: unavailable,
        }),
      )
      expect({ name: corruption[0], lines }).toEqual({
        name: corruption[0],
        lines: failed(3, "corrupt", fixture.input.rid),
      })
      expect({ name: corruption[0], contents: await contents(fixture) }).toEqual({
        name: corruption[0],
        contents: before,
      })
    }
  })

  test("a seam failure fails closed", async () => {
    const fixture = await run()
    const seams: [string, () => Promise<number | undefined>][] = [
      ["a rejection", () => Promise.reject(new Error("fixture: the revocation mark could not be read"))],
      [
        "a throw",
        () => {
          throw new Error("fixture")
        },
      ],
      ["NaN", async () => Number.NaN],
      ["a fraction", async () => T + 0.5],
      ["a negative time", async () => -1],
      ["Infinity", async () => Number.POSITIVE_INFINITY],
      ["an unsafe time", async () => 2 ** 53],
      ["a string", async () => String(T) as unknown as number],
      ["null", async () => null as unknown as number],
    ]
    const lines = await logged(async () => {
      for (const seam of seams)
        expect({ name: seam[0], outcome: await everywhere(fixture.token, { revokedBefore: seam[1] }) }).toEqual({
          name: seam[0],
          outcome: unavailable,
        })
    })
    expect(lines).toEqual([
      ...failed(6, "seam rejected", fixture.input.rid),
      ...failed(3 * (seams.length - 2), "seam value", fixture.input.rid),
    ])
    expect(await everywhere(fixture.token)).toEqual(accepted)
  })

  test("the EVAL's answer is reported before the seam's", async () => {
    const fixture = await run()
    const rejecting = { revokedBefore: () => Promise.reject(new Error("fixture")) }
    const refusing = { revokedBefore: async () => fixture.claims.iat + 1 }
    // The EVAL refuses and the seam fails: the refusal. The store fails and the seam refuses: the failure.
    const live = await run()
    const lines = await logged(async () => {
      state.down = true
      expect(await everywhere(fixture.token, refusing)).toEqual(unavailable)
      state.down = false
      await settleRun(fixture.account, fixture.input.rid, fixture.claims)
      expect(await everywhere(fixture.token, rejecting)).toEqual(expired)
      expect(await everywhere(live.token, rejecting)).toEqual(unavailable)
    })
    // Only an answered failure is logged, with the cause that was reported; a refusal logs nothing.
    expect(lines).toEqual([...failed(3, "store", fixture.input.rid), ...failed(3, "seam rejected", live.input.rid)])
  })

  test("caller satisfies the registry contract", async () => {
    const now = Date.now()
    const fixture = await run(now)
    // The registry calls verify(token) alone: the default clock, store and revokedBefore seam.
    const caller = (await cloudAgentsRunVerifier.verify(fixture.token)) satisfies ModelPlanCaller
    const prefix: RunPrefix = cloudAgentsRunVerifier.prefix
    const verify: RunVerifier = cloudAgentsRunVerifier.verify
    expect(prefix).toBe("vrt_")
    expect(typeof verify).toBe("function")
    expect(caller).toStrictEqual({
      account: { id: fixture.account },
      kind: "run",
      purpose: "cloud-agents",
      run: {
        id: fixture.input.rid,
        source: "github-comment",
        deadline: fixture.reserved.deadline,
        ceilingShare: 0.1,
        service: "cloud-agents",
      },
    })
    // Codium's registry rules (model-plan-caller.ts, codium-pool.ts, codium-deviations.md "One run-id grammar").
    expect(caller.run.id).toBe(fixture.claims.rid)
    expect(caller.run.id).toMatch(/^[A-Za-z0-9_.-]{1,128}$/)
    expect(caller.run.id).not.toBe("-")
    expect(caller.run.id).toStartWith(`gh-${fixture.who.repositoryId}-`)
    expect(caller.account.id).toMatch(CODIUM_ACCOUNT)
    expect(caller.kind).toBe("run")
    expect(POOL_PURPOSES).toContain(caller.purpose)
    expect(ENABLED_SOURCES.has(caller.run.source)).toBe(true)
    expect(Number.isSafeInteger(caller.run.deadline) && caller.run.deadline > Date.now()).toBe(true)
    expect(caller.run.service).toBe("cloud-agents")
    expect(caller.run.ceilingShare !== undefined && caller.run.ceilingShare > 0 && caller.run.ceilingShare <= 1).toBe(
      true,
    )
    // Without a ceiling share the field is absent, not undefined.
    const shareless = mintRunToken({ ...minting(fixture.claims), cs: undefined })
    expect(Object.keys((await cloudAgentsRunVerifier.verify(shareless.token)).run)).toEqual([
      "id",
      "source",
      "deadline",
      "service",
    ])
  })

  // 2.4's shapes: bun test does not check types; packages/web's typecheck checks this file.
  test("the run token has 2.4's shapes", () => {
    type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
    type Section24Claims = {
      v: 1
      sub: string
      rid: string
      repo: string
      thr: string
      gen: number
      src: "github-comment" | "github-dispatch" | "github-schedule"
      pur: "task" | "review" | "scheduled"
      epoch: string
      dl: number
      exp: number
      iat: number
      jti: string
      cs?: number
    }
    type Section24Caller = {
      account: { id: string }
      kind: "run"
      purpose: "cloud-agents"
      run: { id: string; source: RunSource; deadline: number; ceilingShare?: number; service: "cloud-agents" }
    }
    const claimsShape: Equal<RunTokenClaims, Section24Claims> = true
    const callerShape: Equal<RunCaller, Section24Caller> = true
    const caller: Equal<Awaited<ReturnType<typeof verifyRunToken>>, RunCaller> = true
    const required: Equal<Awaited<ReturnType<typeof requireRunToken>>, RunTokenClaims> = true
    const fits: RunCaller extends ModelPlanCaller ? true : false = true
    expect([claimsShape, callerShape, caller, required, fits]).toEqual([true, true, true, true, true])
  })
}
