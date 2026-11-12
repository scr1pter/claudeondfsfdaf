import { ACCOUNT_ID_PATTERN } from "../../../../packages/schema/src/everywhere.js"
import { ApiError } from "../../http.js"
import { open, seal, type DataKey } from "../crypto.js"
import { everywhereKeys, USER_ID_PATTERNS } from "../keys.js"
import { getValue, runScript, storeInteger, storeUnavailable, type Store } from "../store.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const JIRA_TASK_STATES = ["SUBMITTED", "WORKING", "INPUT_REQUIRED", "AUTH_REQUIRED", "COMPLETED", "FAILED", "CANCELED", "REJECTED"] as const
export type JiraTaskState = typeof JIRA_TASK_STATES[number]
export const JIRA_TERMINAL = new Set<JiraTaskState>(["COMPLETED", "FAILED", "CANCELED", "REJECTED"])
export type JiraTaskRecord = {
  readonly id: string
  readonly contextId: string
  readonly messageId: string
  readonly inputHash: string
  readonly installation: string
  readonly forgeInstallationId: string
  readonly userId: string
  readonly authority: string
  readonly account?: string
  readonly createdAt: number
  readonly state: JiraTaskState
  readonly code?: "connect" | "link" | "origin" | "repository" | "unsupported" | "busy" | "held"
  readonly jid?: string
  readonly issueId?: string
  readonly issueKey?: string
  readonly agentAccountId?: string
  readonly privateDelivered?: boolean
  readonly resultEnc?: string
}
export type JiraTaskSnapshot = { readonly record: JiraTaskRecord; readonly raw: string }
type TaskEnvelope = Pick<JiraTaskRecord, "id" | "contextId" | "messageId" | "installation" | "forgeInstallationId" | "userId" | "authority" | "account">
export type JiraTaskContext = { readonly store: Store; readonly keys: readonly DataKey[]; readonly now: number }

/** Task and native context admission, optional short draft, and indexes are fenced by current install/link authority. */
export const WRITE_JIRA_TASK_SCRIPT = [
  "local install = redis.call('GET', KEYS[2]) or '' if install ~= ARGV[2] then return -1 end",
  "local task = redis.call('GET', KEYS[1]) or '' if task ~= ARGV[1] then return -2 end",
  "if KEYS[8] and (redis.call('GET', KEYS[8]) or '') ~= ARGV[13] then return -1 end",
  "if ARGV[8] == 'create' then",
  "if redis.call('EXISTS', KEYS[6]) == 1 then return -3 end",
  "if (redis.call('GET', KEYS[3]) or '') ~= ARGV[9] then return -4 end",
  "end",
  "redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', ARGV[7])",
  "if ARGV[8] == 'create' and redis.call('ZCARD', KEYS[4]) >= 2000 then return -5 end",
  "if KEYS[7] then redis.call('ZREMRANGEBYSCORE', KEYS[7], '-inf', ARGV[7]) if not redis.call('ZSCORE', KEYS[7], ARGV[5]) and redis.call('ZCARD', KEYS[7]) >= 2000 then return -5 end end",
  "redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])",
  "if ARGV[8] == 'create' then redis.call('SET', KEYS[3], ARGV[5], 'PX', ARGV[4]) redis.call('SET', KEYS[6], ARGV[5], 'PX', ARGV[4]) end",
  "redis.call('ZADD', KEYS[4], ARGV[6], ARGV[5]) redis.call('PEXPIRE', KEYS[4], 172800000)",
  "if KEYS[7] then redis.call('ZREMRANGEBYSCORE', KEYS[7], '-inf', ARGV[7]) redis.call('ZADD', KEYS[7], ARGV[6], ARGV[5]) redis.call('PEXPIRE', KEYS[7], 172800000) end",
  "if ARGV[10] == 'write' then redis.call('SET', KEYS[5], ARGV[11], 'PX', ARGV[12]) end",
  "if ARGV[10] == 'delete' then redis.call('DEL', KEYS[5]) end return 1",
].join(" ")

/** Exact task CAS cleanup cannot delete a newer revision's task or a context that already advanced. */
export const ERASE_JIRA_TASK_SCRIPT = [
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
  "redis.call('DEL', KEYS[1], KEYS[2])",
  "if redis.call('GET', KEYS[3]) == ARGV[2] then redis.call('DEL', KEYS[3]) end",
  "if redis.call('GET', KEYS[5]) == ARGV[2] then redis.call('DEL', KEYS[5]) end",
  "redis.call('ZREM', KEYS[4], ARGV[2]) if KEYS[6] then redis.call('ZREM', KEYS[6], ARGV[2]) end return 1",
].join(" ")

function decodeEnvelope(value: unknown): value is TaskEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as TaskEnvelope
  return UUID.test(record.id) && UUID.test(record.contextId) && UUID.test(record.messageId) && /^jira:[0-9a-f-]{36}$/i.test(record.installation) &&
    typeof record.forgeInstallationId === "string" && record.forgeInstallationId.length <= 256 && USER_ID_PATTERNS.jira.test(record.userId) &&
    typeof record.authority === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(record.authority) &&
    (record.account === undefined || ACCOUNT_ID_PATTERN.test(record.account))
}
function decodeTask(value: unknown): value is JiraTaskRecord {
  if (!decodeEnvelope(value)) return false
  const record = value as JiraTaskRecord
  return typeof record.inputHash === "string" && /^[A-Za-z0-9_-]{12}:[0-9a-f]{64}$/.test(record.inputHash) &&
    Number.isSafeInteger(record.createdAt) && record.createdAt > 0 && JIRA_TASK_STATES.includes(record.state) &&
    (record.resultEnc === undefined || typeof record.resultEnc === "string" && record.resultEnc.length <= 12_000)
}

export async function readJiraTask(store: Store, id: string): Promise<JiraTaskSnapshot | undefined> {
  if (!UUID.test(id)) throw new RangeError("Invalid Jira task id")
  const raw = await getValue(store, everywhereKeys.jiraTask(id))
  if (raw === undefined) return undefined
  try {
    if (raw.length > 16_000) throw storeUnavailable()
    const record: unknown = JSON.parse(raw)
    if (!decodeTask(record) || record.id !== id) throw storeUnavailable()
    return { record, raw }
  } catch { throw storeUnavailable() }
}

export async function writeJiraTask(ctx: JiraTaskContext, record: JiraTaskRecord, input: {
  readonly expected?: JiraTaskSnapshot
  readonly installationRaw?: string
  readonly contextExpected?: string
  readonly linkRaw?: string
  readonly draft?: unknown
  readonly clearDraft?: boolean
}): Promise<"written" | "authority-changed" | "changed" | "duplicate" | "busy" | "limit"> {
  if (!decodeTask(record) || input.expected && (input.expected.record.id !== record.id || input.expected.record.authority !== record.authority) ||
    record.account && !input.linkRaw) throw new RangeError("Invalid Jira task write")
  const ttl = record.createdAt + 2 * 86_400_000 - ctx.now
  if (ttl <= 0 || ttl > 2 * 86_400_000) throw new ApiError(409, "JIRA_TASK_EXPIRED", "The Jira task has expired.")
  const draftTtl = Math.min(2 * 60 * 60_000, record.createdAt + 50 * 60_000 - ctx.now)
  if (input.draft !== undefined && draftTtl <= 0) throw new ApiError(409, "JIRA_TASK_EXPIRED", "The Jira task has expired.")
  const result = storeInteger(await runScript(ctx.store, WRITE_JIRA_TASK_SCRIPT, [
    everywhereKeys.jiraTask(record.id), everywhereKeys.install(record.installation), everywhereKeys.jiraContext(record.installation, record.userId, record.contextId),
    everywhereKeys.jiraTasks(record.installation), everywhereKeys.jiraTaskDraft(record.id), everywhereKeys.jiraMessage(record.installation, record.userId, record.messageId),
    ...(record.account ? [everywhereKeys.jiraAccountTasks(record.account), everywhereKeys.link(record.installation, record.userId)] : []),
  ], [input.expected?.raw ?? "", input.installationRaw ?? "", JSON.stringify(record), ttl, record.id, record.createdAt, ctx.now - 2 * 86_400_000,
    input.expected ? "update" : "create", input.contextExpected ?? "", input.draft !== undefined ? "write" : input.clearDraft ? "delete" : "keep",
    input.draft === undefined ? "" : seal(ctx.keys, JSON.stringify(input.draft), everywhereKeys.jiraTaskDraft(record.id)), Math.max(1, draftTtl), input.linkRaw ?? ""]))
  const verdicts: Readonly<Record<number, "written" | "authority-changed" | "changed" | "duplicate" | "busy" | "limit">> = {
    1: "written", [-1]: "authority-changed", [-2]: "changed", [-3]: "duplicate", [-4]: "busy", [-5]: "limit",
  }
  if (!verdicts[result]) throw storeUnavailable()
  return verdicts[result]
}

export async function readJiraDraft(ctx: JiraTaskContext, record: JiraTaskRecord): Promise<unknown> {
  if (ctx.now >= record.createdAt + 50 * 60_000) return undefined
  const raw = await getValue(ctx.store, everywhereKeys.jiraTaskDraft(record.id))
  if (!raw) return undefined
  const value = open(ctx.keys, raw, everywhereKeys.jiraTaskDraft(record.id))
  if (!value.ok) throw storeUnavailable()
  try { return JSON.parse(value.value) as unknown } catch { throw storeUnavailable() }
}

async function eraseTask(store: Store, snapshot: { readonly record: TaskEnvelope; readonly raw: string }) {
  const record = snapshot.record
  await runScript(store, ERASE_JIRA_TASK_SCRIPT, [everywhereKeys.jiraTask(record.id), everywhereKeys.jiraTaskDraft(record.id),
    everywhereKeys.jiraContext(record.installation, record.userId, record.contextId), everywhereKeys.jiraTasks(record.installation),
    everywhereKeys.jiraMessage(record.installation, record.userId, record.messageId), ...(record.account ? [everywhereKeys.jiraAccountTasks(record.account)] : []),
  ], [snapshot.raw, record.id])
}

/** Erasure depends on the stable ownership envelope, not an older deployment's list of business states. */
async function eraseSnapshot(store: Store, id: string) {
  const raw = await getValue(store, everywhereKeys.jiraTask(id))
  if (!raw) return undefined
  try {
    const record: unknown = raw.length <= 16_000 ? JSON.parse(raw) : undefined
    if (decodeEnvelope(record) && record.id === id) return { record, raw }
  } catch { /* Corrupt ownership cannot authorize erasing another revision's record. */ }
  console.error("Vector everywhere: native task ownership was unreadable", { task: id, code: "jira-task-envelope-invalid" })
  return undefined
}

/** Static leaf used by all erasure entrypoints, including those whose bundle never imported a native route. */
export async function eraseJiraTaskInstallation(store: Store, installation: string, authority: string) {
  const members = await store(["ZRANGE", everywhereKeys.jiraTasks(installation), 0, 1999])
  for (const id of Array.isArray(members) ? members : []) {
    if (typeof id !== "string" || !UUID.test(id)) continue
    const snapshot = await eraseSnapshot(store, id)
    if (snapshot?.record.installation === installation && snapshot.record.authority === authority) await eraseTask(store, snapshot)
  }
}
export async function eraseJiraTaskAccount(store: Store, account: string) {
  const members = await store(["ZRANGE", everywhereKeys.jiraAccountTasks(account), 0, 1999])
  for (const id of Array.isArray(members) ? members : []) {
    if (typeof id !== "string" || !UUID.test(id)) continue
    const snapshot = await eraseSnapshot(store, id)
    if (snapshot?.record.account === account) await eraseTask(store, snapshot)
  }
}
