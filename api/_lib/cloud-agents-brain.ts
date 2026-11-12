import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

// Explicit desktop ingress only. Stored values contain ciphertext and a separately wrapped content key, never the
// repository Brain's plaintext. The first run must prove the exact dispatch ticket through its live-run record.
export const BRAIN_UPLOAD_MAX = 512 * 1024
export const BRAIN_UPLOAD_TTL = 2 * 60 * 60 * 1000
const PREFIX = "vector:cloud-agents:brain:"
const ID = /^vbu_[A-Za-z0-9_-]{32}$/
const HASH = /^[0-9a-f]{64}$/
const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/
type Identity = { account: string; repositoryId: string; generation: number }
type Envelope = { nonce: string; ciphertext: string }
type Stored = Identity & {
  v: 1
  uploadId: string
  sha256: string
  bytes: number
  publicRepository: boolean
  expiresAt: number
  wrapped: Envelope
  approvedAt?: number
  envelope?: Envelope
  ticketHash?: string
}
type Deps = { store?: typeof persistentStore; now?: () => number; env?: Readonly<Record<string, string | undefined>> }
export type BrainApproval = { uploadId: string; sha256: string; bytes: number; approvedAt: number }
const key = (id: string) => `${PREFIX}${id}`
const index = (account: string) => `${PREFIX}account:${account}`
const identity = (value: Identity) =>
  ACCOUNT.test(value.account) &&
  /^[1-9]\d{0,15}$/.test(value.repositoryId) &&
  Number.isSafeInteger(Number(value.repositoryId)) &&
  Number.isSafeInteger(value.generation) &&
  value.generation > 0
const aad = (value: Identity & { uploadId: string }) =>
  `vector-brain-upload-v1|${value.account}|${value.repositoryId}|${value.generation}|${value.uploadId}`
const guardKeys = (value: Identity) => [
  `vector:cli-revoked:${value.account}`,
  `vector:cloud-agents:binding:${value.repositoryId}`,
  `vector:cloud-agents:gen:${value.repositoryId}`,
]
function secret(env: Deps["env"] = process.env) {
  const dedicated = env?.VECTOR_RUN_ARTIFACT_SECRET?.trim()
  const fallback = env?.VECTOR_LICENSE_SECRET?.trim()
  const source = dedicated && dedicated.length >= 32 ? dedicated : fallback
  if (!source || source.length < 32) throw unavailable()
  return createHmac("sha256", source).update("vector-brain-upload-wrap-v1").digest()
}
function base64(value: string, size?: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid()
  const bytes = Buffer.from(value, "base64url")
  if (bytes.toString("base64url") !== value || (size !== undefined && bytes.length !== size)) throw invalid()
  return bytes
}
function encrypt(bytes: Uint8Array, contentKey: Uint8Array, associated: string): Envelope {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", contentKey, nonce)
  cipher.setAAD(Buffer.from(associated))
  return {
    nonce: nonce.toString("base64url"),
    ciphertext: Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString("base64url"),
  }
}
function unwrapKey(envelope: Envelope, contentKey: Uint8Array, associated: string) {
  const ciphertext = base64(envelope.ciphertext, 48)
  const decipher = createDecipheriv("aes-256-gcm", contentKey, base64(envelope.nonce, 12))
  decipher.setAAD(Buffer.from(associated))
  decipher.setAuthTag(ciphertext.subarray(-16))
  try {
    return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()])
  } catch {
    throw invalid()
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value))

async function command(args: readonly (string | number)[], deps: Deps) {
  try {
    return await (deps.store ?? persistentStore)(args)
  } catch {
    throw unavailable()
  }
}
async function indexedKeys(account: string, deps: Deps) {
  const members = await command(["SMEMBERS", index(account)], deps)
  if (
    !Array.isArray(members) ||
    members.length > 8 ||
    new Set(members).size !== members.length ||
    !members.every(
      (item): item is string =>
        typeof item === "string" && item.startsWith(PREFIX) && ID.test(item.slice(PREFIX.length)),
    )
  )
    throw unavailable()
  return members
}
function stored(raw: unknown, id: string): Stored {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : undefined
    if (
      !object(value) ||
      value.v !== 1 ||
      value.uploadId !== id ||
      !identity(value as Stored) ||
      typeof value.sha256 !== "string" ||
      !HASH.test(value.sha256) ||
      !Number.isSafeInteger(value.bytes) ||
      Number(value.bytes) < 1 ||
      Number(value.bytes) > BRAIN_UPLOAD_MAX ||
      typeof value.publicRepository !== "boolean" ||
      !Number.isSafeInteger(value.expiresAt) ||
      !object(value.wrapped) ||
      typeof value.wrapped.nonce !== "string" ||
      typeof value.wrapped.ciphertext !== "string" ||
      (value.ticketHash !== undefined && (typeof value.ticketHash !== "string" || !HASH.test(value.ticketHash)))
    )
      throw invalid()
    if (
      Object.keys(value).some(
        (field) =>
          ![
            "v",
            "uploadId",
            "account",
            "repositoryId",
            "generation",
            "sha256",
            "bytes",
            "publicRepository",
            "expiresAt",
            "wrapped",
            "approvedAt",
            "envelope",
            "ticketHash",
          ].includes(field),
      ) ||
      Object.keys(value.wrapped).some((field) => !["nonce", "ciphertext"].includes(field))
    )
      throw invalid()
    base64(value.wrapped.nonce, 12)
    base64(value.wrapped.ciphertext, 48)
    if (value.envelope !== undefined) {
      if (
        !object(value.envelope) ||
        typeof value.envelope.nonce !== "string" ||
        typeof value.envelope.ciphertext !== "string" ||
        Object.keys(value.envelope).some((field) => !["nonce", "ciphertext"].includes(field)) ||
        !Number.isSafeInteger(value.approvedAt) ||
        Number(value.approvedAt) <= 0
      )
        throw invalid()
      base64(value.envelope.nonce, 12)
      if (base64(value.envelope.ciphertext).length !== Number(value.bytes) + 16) throw invalid()
    } else if (value.approvedAt !== undefined || value.ticketHash !== undefined) throw invalid()
    return value as Stored
  } catch {
    throw invalid()
  }
}
async function read(account: string, uploadId: string, deps: Deps) {
  if (!ACCOUNT.test(account) || !ID.test(uploadId)) throw invalid()
  const raw = await command(["GET", key(uploadId)], deps)
  const value = stored(raw, uploadId)
  if (value.account !== account || value.expiresAt <= (deps.now ?? Date.now)()) throw invalid()
  return { value, raw: String(raw) }
}
async function update(previous: string, value: Stored, deps: Deps) {
  const reply = await command(
    [
      "EVAL",
      UPDATE,
      4,
      key(value.uploadId),
      ...guardKeys(value),
      previous,
      JSON.stringify(value),
      value.account,
      value.generation,
      (deps.now ?? Date.now)(),
    ],
    deps,
  )
  if (reply !== "OK") throw reply === "stale" || reply === "race" ? invalid() : unavailable()
}

/** Call after positive desktop authentication and a trusted current repository visibility/binding lookup. */
export async function prepareBrainUpload(
  input: Identity & { sha256: string; bytes: number; source: "desktop"; includeBrain: true; publicRepository: boolean },
  deps: Deps = {},
) {
  if (
    !identity(input) ||
    input.source !== "desktop" ||
    input.includeBrain !== true ||
    !HASH.test(input.sha256) ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > BRAIN_UPLOAD_MAX ||
    typeof input.publicRepository !== "boolean"
  )
    throw invalid()
  const uploadId = `vbu_${randomBytes(24).toString("base64url")}`
  const contentKey = randomBytes(32)
  const associated = aad({ ...input, uploadId })
  const expiresAt = (deps.now ?? Date.now)() + BRAIN_UPLOAD_TTL
  const value: Stored = {
    v: 1,
    uploadId,
    account: input.account,
    repositoryId: input.repositoryId,
    generation: input.generation,
    sha256: input.sha256,
    bytes: input.bytes,
    publicRepository: input.publicRepository,
    expiresAt,
    wrapped: encrypt(contentKey, secret(deps.env), `${associated}|key`),
  }
  const members = await indexedKeys(input.account, deps)
  const reply = await command(
    [
      "EVAL",
      PREPARE,
      5 + members.length,
      key(uploadId),
      index(input.account),
      ...guardKeys(input),
      ...members,
      JSON.stringify(value),
      input.account,
      input.generation,
      BRAIN_UPLOAD_TTL,
    ],
    deps,
  )
  if (reply !== "OK") throw reply === "stale" || reply === "limit" ? invalid() : unavailable()
  return {
    uploadId,
    key: contentKey.toString("base64url"),
    aad: associated,
    expiresAt,
    publicRepository: input.publicRepository,
  }
}

/** Store opaque ciphertext only. The authenticated run client verifies its plaintext digest after decryption. */
export async function commitBrainUpload(
  input: { account: string; uploadId: string; nonce: string; ciphertext: string },
  deps: Deps = {},
): Promise<BrainApproval> {
  if (
    typeof input.ciphertext !== "string" ||
    input.ciphertext.length > Math.ceil(((BRAIN_UPLOAD_MAX + 16) * 4) / 3) + 4 ||
    typeof input.nonce !== "string"
  )
    throw invalid()
  const { value, raw } = await read(input.account, input.uploadId, deps)
  if (value.ticketHash) throw invalid()
  const envelope = { nonce: input.nonce, ciphertext: input.ciphertext }
  base64(envelope.nonce, 12)
  if (base64(envelope.ciphertext).length !== value.bytes + 16) throw invalid()
  // No plaintext payload decryption, parsing, logging, or storage occurs on Vector servers. Approval is authenticated owner
  // metadata; its exact plaintext hash and repository-only/public policy are checked locally and by the run reader.
  const approvedAt = value.approvedAt ?? (deps.now ?? Date.now)()
  await update(raw, { ...value, envelope, approvedAt }, deps)
  return { uploadId: value.uploadId, sha256: value.sha256, bytes: value.bytes, approvedAt }
}

/** Bind before dispatch. An upload belongs to one exact prepared ticket; a retry of that same binding is harmless. */
export async function bindBrainUpload(
  input: Identity & { uploadId: string; ticketHash: string; sha256: string },
  deps: Deps = {},
): Promise<BrainApproval> {
  if (!identity(input) || !HASH.test(input.ticketHash) || !HASH.test(input.sha256)) throw invalid()
  const { value, raw } = await read(input.account, input.uploadId, deps)
  if (
    !value.envelope ||
    !value.approvedAt ||
    value.repositoryId !== input.repositoryId ||
    value.generation !== input.generation ||
    value.sha256 !== input.sha256 ||
    (value.ticketHash && value.ticketHash !== input.ticketHash)
  )
    throw invalid()
  await update(raw, { ...value, ticketHash: input.ticketHash }, deps)
  return { uploadId: value.uploadId, sha256: value.sha256, bytes: value.bytes, approvedAt: value.approvedAt }
}

/** The caller's source/ticket/deadline are from the authenticated live run record, never from JSON/query parameters. */
export async function readBrainUpload(
  input: Identity & { uploadId: string; ticketHash: string; originalSource: "desktop"; deadline: number },
  deps: Deps = {},
) {
  if (
    !identity(input) ||
    input.originalSource !== "desktop" ||
    !HASH.test(input.ticketHash) ||
    !Number.isSafeInteger(input.deadline) ||
    input.deadline <= (deps.now ?? Date.now)()
  )
    throw invalid()
  const { value, raw } = await read(input.account, input.uploadId, deps)
  if (
    !value.envelope ||
    !value.approvedAt ||
    value.ticketHash !== input.ticketHash ||
    value.repositoryId !== input.repositoryId ||
    value.generation !== input.generation
  )
    throw invalid()
  // Read authorization also checks account revocation and the binding atomically, after the live token check.
  await update(raw, value, deps)
  const contentKey = unwrapKey(value.wrapped, secret(deps.env), `${aad(value)}|key`)
  return {
    uploadId: value.uploadId,
    key: contentKey.toString("base64url"),
    aad: aad(value),
    ...value.envelope,
    sha256: value.sha256,
    bytes: value.bytes,
    approvedAt: value.approvedAt,
    publicRepository: value.publicRepository,
  }
}

/** Account deletion revokes first; the bounded index and every ciphertext/key wrap are then erased atomically. */
export async function eraseBrainUploads(account: string, store: typeof persistentStore = persistentStore) {
  if (!ACCOUNT.test(account)) throw invalid()
  const members = await indexedKeys(account, { store })
  const reply = await command(
    ["EVAL", ERASE, 2 + members.length, index(account), `vector:cli-revoked:${account}`, ...members, account],
    { store },
  )
  if (reply !== "OK") throw reply === "stale" ? invalid() : unavailable()
}

const GUARD = `
for i, expected in ipairs({'string','string','hash','string'}) do
 local kind = redis.call('TYPE', KEYS[i]).ok
 if kind ~= 'none' and kind ~= expected then return 'corrupt' end
end
if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('HGET', KEYS[3], 'account') ~= ARGV[3]
 or redis.call('HGET', KEYS[3], 'generation') ~= ARGV[4] or redis.call('GET', KEYS[4]) ~= ARGV[4]
 or redis.call('HEXISTS', KEYS[3], 'suspended') == 1 then return 'stale' end
`
const UPDATE = `${GUARD}
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'race' end
local ok, value = pcall(cjson.decode, ARGV[2])
if not ok or type(value) ~= 'table' or type(value.expiresAt) ~= 'number' then return 'corrupt' end
local ttl = value.expiresAt - tonumber(ARGV[5])
if ttl <= 0 then return 'stale' end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
return 'OK'
`
const PREPARE = `
for i, expected in ipairs({'string','set','string','hash','string'}) do
 local kind = redis.call('TYPE', KEYS[i]).ok
 if kind ~= 'none' and kind ~= expected then return 'corrupt' end
end
if redis.call('EXISTS', KEYS[3]) == 1 or redis.call('HGET', KEYS[4], 'account') ~= ARGV[2]
 or redis.call('HGET', KEYS[4], 'generation') ~= ARGV[3] or redis.call('GET', KEYS[5]) ~= ARGV[3]
 or redis.call('HEXISTS', KEYS[4], 'suspended') == 1 then return 'stale' end
local members = redis.call('SMEMBERS', KEYS[2])
if #members > 8 then return 'corrupt' end
if #members ~= #KEYS - 5 then return 'race' end
local declared, stale, active = {}, {}, 0
for i = 6, #KEYS do
 declared[KEYS[i]] = true
 local kind = redis.call('TYPE', KEYS[i]).ok
 if kind ~= 'none' and kind ~= 'string' then return 'corrupt' end
 local raw = redis.call('GET', KEYS[i])
 if raw then
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= 'table' or value.account ~= ARGV[2] then return 'corrupt' end
  active = active + 1
 else stale[#stale + 1] = KEYS[i] end
end
for _, item in ipairs(members) do if not declared[item] then return 'race' end end
if active >= 8 then return 'limit' end
for _, item in ipairs(stale) do redis.call('SREM', KEYS[2], item) end
local added = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[4])
if not added then return 'corrupt' end
redis.call('SADD', KEYS[2], KEYS[1])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return 'OK'
`
const ERASE = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind ~= 'none' and kind ~= 'set' then return 'corrupt' end
if redis.call('EXISTS', KEYS[2]) ~= 1 then return 'stale' end
local members = redis.call('SMEMBERS', KEYS[1])
if #members > 8 then return 'corrupt' end
if #members ~= #KEYS - 2 then return 'corrupt' end
local declared = {}
for i = 3, #KEYS do
 declared[KEYS[i]] = true
 local kind = redis.call('TYPE', KEYS[i]).ok
 if kind ~= 'none' and kind ~= 'string' then return 'corrupt' end
 local raw = redis.call('GET', KEYS[i])
 if raw then local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= 'table' or value.account ~= ARGV[1] then return 'corrupt' end
 end
end
for _, item in ipairs(members) do if not declared[item] then return 'corrupt' end end
for i = 3, #KEYS do redis.call('DEL', KEYS[i]) end
redis.call('DEL', KEYS[1])
return 'OK'
`
function invalid() {
  return new ApiError(400, "BRAIN_UPLOAD_INVALID", "Prepare and approve this Brain attachment again from your desktop.")
}
function unavailable() {
  return new ApiError(503, "BRAIN_UPLOAD_UNAVAILABLE", "Brain attachments are temporarily unavailable.")
}
