import { timingSafeEqual } from "node:crypto"
import { Option, Schema } from "effect"
import { GithubAgents } from "../../packages/core/src/github-agents.js"
import { bindingKey, generationKey } from "./cloud-agents-binding.js"
import { cloudAgentRevokedBefore, type RunSource } from "./cloud-agents-entitlement.js"
import {
  liveKey,
  runRecordKey,
  METER_EPOCH_PATTERN,
  type LedgerPurpose,
  type LedgerSource,
} from "./cloud-agents-ledger.js"
import { ApiError, type ApiRequest } from "./http.js"
import { persistentStore } from "./persistent-store.js"
import { signRunTokenPayload } from "./cloud-agents-run-crypto.js"

/*
 * Run tokens and the verifier seam for @vector (vector-at-mention-spec 2.4, V07). V12's mint signs a token with
 * mintRunToken from what reserveRun answered; its heartbeat and settle routes accept it with requireRunToken until
 * `exp`, and V27's artifact-key route only until the deadline; Codium's gateway accepts it until the deadline through
 * cloudAgentsRunVerifier, which A59 registers with registerRunVerifier.
 *
 * A token is `vrt_<base64url(JSON claims)>.<base64url(HMAC-SHA256(key, "vector-run-v1." + payload))>`, under its own
 * key and HMAC domain, so it passes for no CLI token, desktop token or deletion grant, and none of them passes for it.
 * The signature proves only that Vector minted it. Everything else is one read-only EVAL: the account is not revoked,
 * the repository's binding still names the token's account and generation (a rebind, an unbind, a takeover and a
 * suspension all move the generation), and the run's live record still holds the token's jti (a settle removes it, a
 * later mint of the same check run replaces it). Beside it, in parallel, runs one cloudAgentRevokedBefore call.
 *
 * Everything fails closed: a store or seam failure, or stored data this module does not recognise, answers 503
 * PERSISTENT_STORE_UNAVAILABLE, grants nothing, and logs one line with its cause and the run id. Every refusal of a well-signed token is the same 401, and every
 * malformed or forged token the same other 401, so no response says why a run was stopped (INV-P1).
 */

const PREFIX = "vrt_"
const LONGEST = 1024
const GRACE_MS = GithubAgents.SETTLE_GRACE_SECONDS * 1000
const TOKEN = /^vrt_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/
// "gh-<repositoryId>-<runId>-<runAttempt>-<checkRunId>" (GithubAgents.runId), whose repository is the token's `repo`.
const RID = /^gh-([1-9]\d{0,19})-[1-9]\d{0,19}-[1-9]\d{0,19}-[1-9]\d{0,19}$/
// Codium's registry account rule (model-plan-caller.ts), lowercase as the binding and the ledger store accounts.
const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const Decimal = Schema.String.check(
  Schema.makeFilter((value: string) => /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))),
)
const Time = Schema.Number.check(Schema.makeFilter((value: number) => Number.isSafeInteger(value) && value > 0))
const Claims = Schema.Struct({
  v: Schema.Literal(1),
  sub: Schema.String.check(Schema.isPattern(ACCOUNT)),
  rid: Schema.String.check(Schema.isPattern(GithubAgents.RUN_ID_PATTERN)),
  repo: Decimal,
  thr: Schema.String.check(Schema.isPattern(GithubAgents.THREAD_PATTERN)),
  gen: Schema.Number.check(Schema.makeFilter((value: number) => Number.isSafeInteger(value) && value >= 1)),
  src: Schema.Literals(["github-comment", "github-dispatch", "github-schedule"]),
  pur: Schema.Literals(["task", "review", "scheduled"]),
  epoch: Schema.String.check(Schema.isPattern(METER_EPOCH_PATTERN)),
  dl: Time,
  exp: Time,
  iat: Time,
  // 16 random bytes in base64url, the live record's jti (2.6).
  jti: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/)),
  cs: Schema.optional(
    Schema.Number.check(Schema.makeFilter((value: number) => Number.isFinite(value) && value > 0 && value <= 1)),
  ),
}).check(
  Schema.makeFilter(
    (claims: { rid: string; repo: string; src: string; pur: string; dl: number; exp: number; iat: number }) =>
      RID.exec(claims.rid)?.[1] === claims.repo &&
      // Only a GitHub schedule event is a scheduled run, as the ledger requires.
      (claims.src === "github-schedule") === (claims.pur === "scheduled") &&
      claims.iat < claims.dl &&
      claims.exp === claims.dl + GRACE_MS,
  ),
)
const decodeClaims = Schema.decodeUnknownOption(Claims, { onExcessProperty: "error" })
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(Claims), { onExcessProperty: "error" })

export type RunTokenClaims = {
  v: 1
  /** The binder's Vector account id. */
  sub: string
  /** GithubAgents.runId(...): the check run, and Codium's run id. */
  rid: string
  /** The repository id, decimal. */
  repo: string
  /** The thread, fixed at mint: the live record's. */
  thr: string
  /** The binding generation at mint. */
  gen: number
  src: LedgerSource
  pur: LedgerPurpose
  /** The live record's meter epoch. */
  epoch: string
  /** The deadline, in milliseconds since the epoch. */
  dl: number
  /** dl + SETTLE_GRACE_SECONDS × 1000. */
  exp: number
  /** When it was minted, in milliseconds since the epoch. */
  iat: number
  jti: string
  /** One run's ceiling share of the month, in (0, 1]. */
  cs?: number
}

/** What Codium's registry receives: structurally a `ModelPlanCaller` (`api/_lib/model-plan-caller.ts`). */
export type RunCaller = {
  account: { id: string }
  kind: "run"
  purpose: "cloud-agents"
  run: { id: string; source: RunSource; deadline: number; ceilingShare?: number; service: "cloud-agents" }
}

/** For V12's createCloudAgentsApi deps. The registry calls cloudAgentsRunVerifier.verify, which uses the defaults. */
export type RunTokenDeps = {
  now?: number
  store?: typeof persistentStore
  revokedBefore?: typeof cloudAgentRevokedBefore
}

/**
 * Signs `claims` with `v` 1 and `exp` = `dl` + 15 minutes. Every claim must pass the reader's own rules (400
 * INVALID_REQUEST otherwise), so nothing is signed that readRunToken would refuse.
 */
export function mintRunToken(claims: Omit<RunTokenClaims, "v" | "exp">) {
  const decoded = Option.getOrUndefined(decodeClaims({ ...claims, v: 1, exp: claims.dl + GRACE_MS }))
  if (!decoded) throw invalidRequest()
  const payload = Buffer.from(JSON.stringify(ordered(decoded)), "utf8").toString("base64url")
  return { token: `${PREFIX}${payload}.${signRunTokenPayload(payload)}`, deadline: decoded.dl, expiresAt: decoded.exp }
}

/** The format, signature and claims, and `now < exp`. No store call. */
export function readRunToken(token: string, now: number): RunTokenClaims {
  const parts = typeof token === "string" && token.length <= LONGEST ? TOKEN.exec(token) : null
  const payload = parts?.[1]
  const signature = parts?.[2]
  if (!payload || !signature) throw invalidToken()
  const expected = Buffer.from(signRunTokenPayload(payload))
  const provided = Buffer.from(signature)
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw invalidToken()
  const claims = Option.getOrUndefined(decodePayload(Buffer.from(payload, "base64url").toString("utf8")))
  if (!claims) throw invalidToken()
  // Written as `now < exp` so that a clock that is not a number refuses.
  if (!(now < claims.exp)) throw runExpired()
  return ordered(claims)
}

/** The gateway path: the token until its deadline, then the store and the seam. */
export async function verifyRunToken(token: string, deps: RunTokenDeps = {}): Promise<RunCaller> {
  const now = deps.now ?? Date.now()
  const claims = readRunToken(token, now)
  if (!(now < claims.dl)) throw runExpired()
  await requireLive(claims, deps)
  return {
    account: { id: claims.sub },
    kind: "run",
    purpose: "cloud-agents",
    run: {
      id: claims.rid,
      source: claims.src,
      deadline: claims.dl,
      ...(claims.cs === undefined ? {} : { ceilingShare: claims.cs }),
      service: "cloud-agents",
    },
  }
}

/**
 * Our service endpoints' path, for a `Bearer vrt_…` header: heartbeat and settle allow the token after its deadline,
 * until `exp`, so a run can still report and settle; the artifact key does not.
 */
export async function requireRunToken(
  request: Pick<ApiRequest, "headers">,
  options: { allowAfterDeadline: boolean },
  deps: RunTokenDeps = {},
) {
  const authorization = request.headers.authorization
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) throw invalidToken()
  const now = deps.now ?? Date.now()
  const claims = readRunToken(authorization.slice("Bearer ".length), now)
  if (options.allowAfterDeadline !== true && !(now < claims.dl)) throw runExpired()
  await requireLive(claims, deps)
  return claims
}

/** Only the settlement handler uses this path; an ended receipt never grants model, heartbeat or artifact access. */
export async function requireSettlementToken(request: Pick<ApiRequest, "headers">, deps: RunTokenDeps = {}) {
  const authorization = request.headers.authorization
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) throw invalidToken()
  const claims = readRunToken(authorization.slice("Bearer ".length), deps.now ?? Date.now())
  await requireLive(claims, deps, true)
  return claims
}

/** Public service adapter. Codium statically registers the hoisted verifier function to avoid cyclic const reads. */
export const cloudAgentsRunVerifier = {
  prefix: "vrt_" as const,
  verify: (token: string) => verifyRunToken(token),
}

// The EVAL and the seam start together. When both refuse or fail, the EVAL's answer is the one reported.
async function requireLive(claims: RunTokenClaims, deps: RunTokenDeps, settlement = false) {
  const store = deps.store ?? persistentStore
  const revokedBefore = deps.revokedBefore ?? cloudAgentRevokedBefore
  // Each through a promise, so a store or a seam that throws instead of rejecting fails closed too.
  const settled = await Promise.allSettled([
    Promise.resolve().then(() =>
      store([
        "EVAL",
        CHECK,
        settlement ? "5" : "4",
        bindingKey(claims.repo),
        generationKey(claims.repo),
        liveKey(claims.sub),
        revokedKey(claims.sub),
        ...(settlement ? [runRecordKey(claims.rid)] : []),
        claims.sub,
        String(claims.gen),
        claims.rid,
        claims.jti,
      ]),
    ),
    Promise.resolve(claims.sub).then(revokedBefore),
  ])
  const checked = settled[0]
  const before = settled[1]
  if (checked.status === "rejected") throw failClosed(claims.rid, "store")
  if (checked.value === "corrupt") throw failClosed(claims.rid, "corrupt")
  if (!ANSWERS.has(checked.value)) throw failClosed(claims.rid, "unknown answer")
  if (checked.value !== "ok") throw runExpired()
  if (before.status === "rejected") throw failClosed(claims.rid, "seam rejected")
  if (before.value === undefined) return
  // Milliseconds since the epoch, compared with iat (V04 deviation 5); Codium refuses a token issued before it.
  if (!Number.isSafeInteger(before.value) || before.value < 0) throw failClosed(claims.rid, "seam value")
  if (before.value > claims.iat) throw runExpired()
}

const ANSWERS = new Set<unknown>(["ok", "revoked", "unbound", "moved", "settled", "replaced"])

// Every failure answers the same 503 (INV-P1), so one server log line per failure tells corrupt data, which never
// mends by itself, from an outage. It names the cause and the run only: never the account (INV-P4), and never the
// rejection itself, which can carry an upstream request's headers. The rid is the schema's, so it matches the grammar.
function failClosed(runId: string, cause: "store" | "corrupt" | "unknown answer" | "seam rejected" | "seam value") {
  console.warn("Vector cloud-agents run token check failed", { cause, runId })
  return storeUnavailable()
}

// KEYS: the binding, its generation counter, the account's live runs, the account's revocation mark. ARGV: the
// token's account, generation, rid and jti. Read-only. The binding's account and generation and the counter are read
// with the binding module's rules, and while a binding exists its generation equals the counter (2.7), so anything else
// is corrupt. A suspension moves the generation (V05 deviation 6), so it needs no check of its own. The live record is
// read for its jti alone: its other fields are the ledger's to judge.
const CHECK = `
local function decimal(value)
  return type(value) == 'string' and #value <= 16 and string.match(value, '^[1-9]%d*$') ~= nil
    and tonumber(value) <= 9007199254740991
end
local hex = '[0-9a-f]'
local uuid = '^' .. string.rep(hex, 8) .. '%-' .. string.rep(hex, 4) .. '%-' .. string.rep(hex, 4) .. '%-'
  .. string.rep(hex, 4) .. '%-' .. string.rep(hex, 12) .. '$'
for i, expected in ipairs({ 'hash', 'string', 'hash', 'string' }) do
  local found = redis.call('TYPE', KEYS[i]).ok
  if found ~= expected and found ~= 'none' then return 'corrupt' end
end
if redis.call('EXISTS', KEYS[4]) == 1 then return 'revoked' end
if redis.call('EXISTS', KEYS[1]) == 0 then return 'unbound' end
local binding = redis.call('HMGET', KEYS[1], 'account', 'generation')
local account, generation = binding[1], binding[2]
if type(account) ~= 'string' or not string.match(account, uuid) or not decimal(generation) then return 'corrupt' end
if redis.call('GET', KEYS[2]) ~= generation then return 'corrupt' end
if account ~= ARGV[1] or generation ~= ARGV[2] then return 'moved' end
local raw = redis.call('HGET', KEYS[3], ARGV[3])
if not raw then
  if not KEYS[5] then return 'settled' end
  local found = redis.call('TYPE', KEYS[5]).ok
  if found ~= 'hash' and found ~= 'none' then return 'corrupt' end
  local record = redis.call('HMGET', KEYS[5], 'account', 'generation', 'jti', 'startedAt', 'endedAt', 'outcome', 'verdict')
  if record[1] ~= ARGV[1] or record[2] ~= ARGV[2] or record[3] ~= ARGV[4] or not record[5] then return 'settled' end
  local outcomes = {changes = 'pass', ['no-changes'] = 'none', draft = 'fail', failed = 'fail', refused = 'none', cancelled = 'none'}
  if not decimal(record[4]) or not decimal(record[5]) or tonumber(record[5]) < tonumber(record[4])
    or not outcomes[record[6]] or outcomes[record[6]] ~= record[7] then return 'corrupt' end
  return 'ok'
end
local decoded, run = pcall(cjson.decode, raw)
if not decoded or type(run) ~= 'table' or type(run.jti) ~= 'string' then return 'corrupt' end
if run.jti ~= ARGV[4] then return 'replaced' end
return 'ok'
`

// One key order, so a token's payload never depends on how the caller built its claims.
function ordered(claims: typeof Claims.Type): RunTokenClaims {
  return {
    v: 1,
    sub: claims.sub,
    rid: claims.rid,
    repo: claims.repo,
    thr: claims.thr,
    gen: claims.gen,
    src: claims.src,
    pur: claims.pur,
    epoch: claims.epoch,
    dl: claims.dl,
    exp: claims.exp,
    iat: claims.iat,
    jti: claims.jti,
    ...(claims.cs === undefined ? {} : { cs: claims.cs }),
  }
}

// revocation.ts's key, which that module keeps private; Codium's lane edits around it, so a builder exported there
// would only add a merge conflict for A59. The test revokes through revokeAccountTokens and checks that
// requireUnrevokedAccount agrees, so the two layouts cannot drift apart unseen.
function revokedKey(account: string) {
  return `vector:cli-revoked:${account}`
}

function invalidRequest() {
  return new ApiError(400, "INVALID_REQUEST", "Send only the supported run token claims.")
}

function invalidToken() {
  return new ApiError(401, "RUN_TOKEN_INVALID", "This run token is not valid.")
}

function runExpired() {
  return new ApiError(
    401,
    "MODEL_PLAN_RUN_EXPIRED",
    "This run is no longer authorized. Save your work and finish the run.",
  )
}

function storeUnavailable() {
  return new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Protected GitHub services are temporarily unavailable.")
}
