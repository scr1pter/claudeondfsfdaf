// The agent phase's run bundle (contract 2.12) and its stop-code table (2.9.2). writeBundle records what the agent
// changed against the run's base commit as vector-out/patch.diff and vector-out/summary.json, with local git only: the
// changes are staged in a private index read from the base, no hook, fsmonitor, external diff, textconv or transport
// runs, and git starts with an exact environment that holds no credential. stopReason maps a session's final error to what the run does next. Nothing here posts, pushes or sends a
// network request; the agent phase (V18b) wires it in, and publish (V21) reads the bundle back with parseRunSummary.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { z } from "zod"
import { Option, Schema } from "effect"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { escapeVectorMarkers } from "@vectordevai/core/review/state"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { BODY_MAX_CHARS } from "./github.evidence"

// The reason lines of 2.9.2, exactly. Publish's refusal table (V21) words its comments from these through describeStop.
export const STOP_REASON = {
  expired: "the run reached its time limit",
  ceiling: "this run reached its share of the month",
  usedUp: "agent time for this binding is used up",
  daily: "Codium's daily limit was reached",
  binding: "Codium is unavailable for this binding",
  busy: "Codium was busy",
  model: "the chosen model isn't included",
  update: "Vector needs updating",
  unavailable: "Codium is unavailable right now",
  early: "Vector stopped early",
} as const

// The update sentence of 2.11.4.
export const UPDATE_ADVICE =
  "Update Vector: merge the workflow update from the Vector app, or run `vector github install` again."

// summary.json is a run artifact anyone who can read a public repository can download, so the six codes that say why
// Codium is unavailable for a binding are all recorded as this one, as the mint's BINDING_UNAVAILABLE does (INV-P1).
export const UNAVAILABLE_STOP = "MODEL_PLAN_BLOCKED" satisfies GithubAgents.StopCode

type Row = { behaviour: "draft" | "wait"; stop: GithubAgents.StopCode; reason: keyof typeof STOP_REASON }

// Every STOP_CODES member has a row, which the compiler checks. "wait" is MODEL_PLAN_CONCURRENCY only: the caller
// retries for up to CONCURRENCY_RETRY_MS, then drafts with the same stop and reason. MODEL_PLAN_BUSY and
// MODEL_PLAN_RENEWING are retried by the session's own client before they become the final error, so they draft.
const STOP_TABLE = {
  MODEL_PLAN_RUN_EXPIRED: { behaviour: "draft", stop: "MODEL_PLAN_RUN_EXPIRED", reason: "expired" },
  // "ceiling" when the gateway's limit says so (describeStop); hours, at-once or no limit are "used up".
  MODEL_PLAN_RUN_LIMIT: { behaviour: "draft", stop: "MODEL_PLAN_RUN_LIMIT", reason: "usedUp" },
  MODEL_PLAN_DAILY_LIMIT: { behaviour: "draft", stop: "MODEL_PLAN_DAILY_LIMIT", reason: "daily" },
  MODEL_PLAN_EXHAUSTED: { behaviour: "draft", stop: UNAVAILABLE_STOP, reason: "binding" },
  MODEL_PLAN_PAYMENT_REQUIRED: { behaviour: "draft", stop: UNAVAILABLE_STOP, reason: "binding" },
  MODEL_PLAN_REQUIRED: { behaviour: "draft", stop: UNAVAILABLE_STOP, reason: "binding" },
  MODEL_PLAN_CAPACITY: { behaviour: "draft", stop: UNAVAILABLE_STOP, reason: "binding" },
  MODEL_PLAN_BLOCKED: { behaviour: "draft", stop: UNAVAILABLE_STOP, reason: "binding" },
  CODIUM_PERK_REQUIRED: { behaviour: "draft", stop: UNAVAILABLE_STOP, reason: "binding" },
  MODEL_PLAN_CONCURRENCY: { behaviour: "wait", stop: "MODEL_PLAN_CONCURRENCY", reason: "busy" },
  MODEL_PLAN_BUSY: { behaviour: "draft", stop: "MODEL_PLAN_BUSY", reason: "busy" },
  MODEL_PLAN_RENEWING: { behaviour: "draft", stop: "MODEL_PLAN_RENEWING", reason: "busy" },
  MODEL_PLAN_UPGRADE_REQUIRED: { behaviour: "draft", stop: "MODEL_PLAN_UPGRADE_REQUIRED", reason: "model" },
  CODIUM_UPDATE_REQUIRED: { behaviour: "draft", stop: "CODIUM_UPDATE_REQUIRED", reason: "update" },
  MODEL_PLANS_DISABLED: { behaviour: "draft", stop: "MODEL_PLANS_DISABLED", reason: "unavailable" },
  MODEL_PLAN_MODEL_UNAVAILABLE: { behaviour: "draft", stop: "MODEL_PLAN_MODEL_UNAVAILABLE", reason: "unavailable" },
} as const satisfies Record<GithubAgents.StopCode, Row>

/** What a bundle can record as its stop: a table row's stop, or "deadline" (the heartbeat's stop or the local deadline). */
export type RecordedStop = (typeof STOP_TABLE)[GithubAgents.StopCode]["stop"] | "deadline"
export const RUN_LIMITS = ["ceiling", "hours", "at-once"] as const
export type RunLimit = (typeof RUN_LIMITS)[number]
// Which patch limit refused the changes, checked in this order. Publish words the comment (V21).
export const REFUSALS = ["files", "fileBytes", "bytes"] as const
export type Refusal = (typeof REFUSALS)[number]
// writeBundle writes only these; "refused" and "cancelled" are settle outcomes with no bundle.
export const BUNDLE_OUTCOMES = [
  "changes",
  "no-changes",
  "draft",
  "failed",
] as const satisfies readonly GithubAgents.Outcome[]

/** How a run ended early. The default row has no stop: any other code, any 5xx, any other error. */
export type Stop = {
  behaviour: "draft" | "wait"
  stop?: RecordedStop
  limit?: RunLimit
  reason: string
  advice?: string
}

/** The heartbeat's `stop: true`, or the local deadline (VECTOR_RUN_DEADLINE minus STOP_MARGIN_SECONDS). */
export const DEADLINE: Stop = { behaviour: "draft", stop: "deadline", reason: STOP_REASON.expired }

/**
 * What the run does after the session's final error (2.9.2). `codium` is true only when the failed request went to the
 * Codium gateway (the model plans provider) in a Codium run: any other provider's body can carry the same words, and an
 * own-key run has nothing to do with Codium (INV-K1), so its errors always take the default row. Never throws.
 */
export function stopReason(error: unknown, options: { codium: boolean }): Stop {
  const found = options.codium ? gatewayCode(error) : undefined
  if (!found) return { behaviour: "draft", ...describeStop() }
  const row = STOP_TABLE[found.code]
  const limit = row.stop === "MODEL_PLAN_RUN_LIMIT" ? found.limit : undefined
  return { behaviour: row.behaviour, stop: row.stop, ...(limit ? { limit } : {}), ...describeStop(row.stop, limit) }
}

/** The reason line, and for CODIUM_UPDATE_REQUIRED the update advice, for a recorded stop; no stop is the default row. */
export function describeStop(stop?: RecordedStop, limit?: RunLimit): { reason: string; advice?: string } {
  if (stop === undefined) return { reason: STOP_REASON.early }
  if (stop === "deadline") return { reason: STOP_REASON.expired }
  if (stop === "MODEL_PLAN_RUN_LIMIT" && limit === "ceiling") return { reason: STOP_REASON.ceiling }
  const reason = STOP_REASON[STOP_TABLE[stop].reason]
  return stop === "CODIUM_UPDATE_REQUIRED" ? { reason, advice: UPDATE_ADVICE } : { reason }
}

// The gateway writes {error: {code, message, limit?}} (api/_lib/cloud-agents-api.ts safe(), Codium's gateway). Only
// the code and the limit are read, and only a table code counts.
const GatewayBody = z.object({ error: z.object({ code: z.string(), limit: z.unknown().optional() }) })
const RunLimitValue = z.enum(RUN_LIMITS)
const GATEWAY_BODY_CHARS = 65_536

function gatewayCode(error: unknown) {
  if (!SessionV1.APIError.isInstance(error)) return undefined
  // The name alone makes it an APIError, so its data is read as if anything could be in it.
  const data: unknown = error.data
  if (typeof data !== "object" || data === null) return undefined
  const text =
    "responseBody" in data && typeof data.responseBody === "string" && data.responseBody.length <= GATEWAY_BODY_CHARS
      ? data.responseBody
      : undefined
  const body = GatewayBody.safeParse(
    text === undefined
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)),
  )
  const metadata =
    "metadata" in data && typeof data.metadata === "object" && data.metadata !== null ? data.metadata : {}
  const code = [body.success ? body.data.error.code : undefined, "code" in metadata ? metadata.code : undefined].find(
    isStopCode,
  )
  if (!code) return undefined
  const limit = RunLimitValue.safeParse(body.success ? body.data.error.limit : undefined)
  return { code, limit: limit.success ? limit.data : undefined }
}

function isStopCode(value: unknown): value is GithubAgents.StopCode {
  return typeof value === "string" && Object.hasOwn(STOP_TABLE, value)
}

// ---------------------------------------------------------------------------------------------------------------------
// summary.json

export const TITLE_MAX_CHARS = 256
// What writeBundle appends where it shortens text that cannot fit. It starts with a parenthesis, so no marker can form
// across the cut (escapeVectorMarkers matches `<!--` followed by optional space and "vector").
export const SHORTENED = "\n\n(Vector shortened this text.)"
const PATH_MAX_CHARS = 4096
// Each path list stays under this many bytes of JSON, or is written empty: publish recomputes heldBack from the patch.
const LIST_BYTES = 32_768

const RECORDED = new Set<string>(["deadline", ...Object.values(STOP_TABLE).map((row) => row.stop)])
const Recorded = z.custom<RecordedStop>((value) => typeof value === "string" && RECORDED.has(value))
const escaped = (text: string) => escapeVectorMarkers(text) === text
const Id = z.number().int().positive().max(9_999_999_999)
// A path is a file name the agent chose, so a list never holds one that would open a Vector marker (fitList leaves
// such a name out). Publish still writes any path it echoes after escapeVectorMarkers, inside a code span.
const PathList = z
  .array(z.string().min(1).max(PATH_MAX_CHARS).refine(escaped))
  .max(GithubAgents.PATCH_LIMITS.files)
  .refine((paths) => new Set(paths).size === paths.length)

export const RunSummary = z
  .object({
    v: z.literal(1),
    mode: z.enum(["codium", "own-key"]),
    outcome: z.enum(BUNDLE_OUTCOMES),
    stop: Recorded.optional(),
    limit: RunLimitValue.optional(),
    refused: z.enum(REFUSALS).optional(),
    // Echoes only: publish computes each from trusted sources and refuses the bundle when one differs (INV-S17).
    kind: z.enum(["issue", "pr", "dispatch", "schedule"]),
    thread: z.string().regex(GithubAgents.THREAD_PATTERN),
    baseSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    headRef: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\x00-\x20\x7f~^:?*[\\]+$/)
      .optional(),
    pr: Id.optional(),
    issue: Id.optional(),
    scheduleId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
    title: z
      .string()
      .max(TITLE_MAX_CHARS)
      .regex(/^[^\r\n\u2028\u2029]*$/)
      .refine(escaped),
    body: z.string().max(BODY_MAX_CHARS).refine(escaped),
    comment: z.string().max(BODY_MAX_CHARS).refine(escaped),
    draft: z.boolean(),
    // Paths of the patch under .github/, which publish holds back.
    heldBack: PathList.refine((paths) => paths.every((name) => /^\.github\//i.test(name))),
    // Paths writeBundle left out of the patch: repositories of their own, gitlinks, links that leave the tree, names git
    // refuses, and whatever resetting one of those to the base took back with it.
    dropped: PathList,
  })
  .strict()
  .superRefine((summary, ctx) => {
    const problems = [
      !routeAgrees(summary) && "the kind, thread and ids disagree",
      (summary.outcome === "draft") !== summary.draft && "draft is set exactly for the draft outcome",
      summary.stop !== undefined &&
        summary.outcome !== "draft" &&
        summary.outcome !== "failed" &&
        "only a stopped run records a stop",
      summary.limit !== undefined &&
        summary.stop !== "MODEL_PLAN_RUN_LIMIT" &&
        "a limit belongs to MODEL_PLAN_RUN_LIMIT",
      summary.refused !== undefined && summary.outcome !== "failed" && "a refused patch fails the run",
      summary.heldBack.some((name) => summary.dropped.includes(name)) && "a path is both held back and dropped",
    ].filter((problem): problem is string => typeof problem === "string")
    problems.forEach((message) => ctx.addIssue({ code: "custom", message }))
  })
export type RunSummary = z.infer<typeof RunSummary>
export type BundleRoute = Pick<RunSummary, "mode" | "kind" | "thread" | "headRef" | "pr" | "issue" | "scheduleId">

function routeAgrees(summary: Omit<BundleRoute, "mode">) {
  const none = (...values: unknown[]) => values.every((value) => value === undefined)
  if (summary.kind === "issue")
    return (
      summary.issue !== undefined &&
      summary.thread === String(summary.issue) &&
      none(summary.pr, summary.scheduleId, summary.headRef)
    )
  if (summary.kind === "pr")
    return summary.pr !== undefined && summary.thread === String(summary.pr) && none(summary.issue, summary.scheduleId)
  if (summary.kind === "dispatch")
    return (
      summary.thread.startsWith("dispatch-") && none(summary.pr, summary.issue, summary.scheduleId, summary.headRef)
    )
  return (
    summary.scheduleId !== undefined &&
    summary.thread.startsWith("schedule-") &&
    none(summary.pr, summary.issue, summary.headRef)
  )
}

/** summary.json as publish reads it: undefined when it is over PATCH_LIMITS.summaryBytes, not JSON, or not a RunSummary. */
export function parseRunSummary(text: string) {
  if (Buffer.byteLength(text) > GithubAgents.PATCH_LIMITS.summaryBytes) return undefined
  const parsed = RunSummary.safeParse(
    Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)),
  )
  return parsed.success ? parsed.data : undefined
}

/**
 * Whether a symlink at `link` (a repository path) pointing at `target` leaves the tree, which publish refuses (INV-S12):
 * an empty or absolute target, a NUL, one that climbs above the root, or one that reaches into a `.git` directory. The
 * check is textual, as `git apply` writes the link; publish's validator (V21) has the last word.
 */
export function linkLeavesTree(link: string, target: string) {
  if (target === "" || target.includes("\0") || target.startsWith("/")) return true
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(link), target))
  return (
    resolved === ".." || resolved.startsWith("../") || resolved.split("/").some((part) => part.toLowerCase() === ".git")
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// writeBundle

const FAILED = "Vector could not record the run's changes."
const GIT_TIMEOUT_MS = 120_000
const GITLINK = "160000"
const SYMLINK = "120000"
const BLOB_MODES = new Set(["100644", "100755", SYMLINK])
// A listing of PATCH_LIMITS.files entries of at most 4,096-byte paths stays under this. A longer one is read no
// further and counts as the "files" refusal.
const RAW_LIMIT = 16_000_000
const EXCLUDE = `:(exclude)${GithubAgents.BUNDLE_DIR}`
// The repository's own config is the agent's to write. Hooks, fsmonitor, transports and the settings that would make
// `git add` refuse the tree or the patch unparseable or unapplicable are pinned, here or by a flag below; external diff
// and textconv are off by flag. Clean and process filters that the agent's attributes name still run during `git add`,
// as the agent user with git's exact environment (deviation V18a item 5).
const CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  // With core.autocrlf, safecrlf=true makes `git add` die on a mixed-line-ending file.
  "core.safecrlf=false",
  // A sparse-checkout definition makes `git add` refuse every new path outside it.
  "core.sparseCheckout=false",
  // The private index stays one file: no shared index in .git/, no untracked cache.
  "core.splitIndex=false",
  "core.untrackedCache=false",
  "diff.noprefix=false",
  "diff.mnemonicPrefix=false",
  "protocol.allow=never",
].flatMap((setting) => ["-c", setting])
const ENVIRONMENT = {
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  // Names no transport, so every transport is refused whatever the repository's protocol.<name>.allow says, a promisor
  // remote's lazy fetch included. GIT_NO_LAZY_FETCH stops lazy fetches on its own in the git releases that carry the
  // 2.45.1 security fixes (backported down to 2.39.4); either one blocks the test's partial-clone fetch alone.
  GIT_ALLOW_PROTOCOL: "none",
  GIT_NO_LAZY_FETCH: "1",
  // A refs/replace entry could swap the base commit's tree for another.
  GIT_NO_REPLACE_OBJECTS: "1",
}
// --src-prefix, --dst-prefix and --no-relative override diff.noprefix, diff.mnemonicPrefix, diff.srcPrefix,
// diff.dstPrefix and diff.relative on every git version; -U3 overrides diff.context, -O/dev/null diff.orderFile.
const LISTING = ["--no-color", "--no-renames", "--no-relative", "--ignore-submodules=none", "-O/dev/null"]
const PATCH = [
  ...LISTING,
  "--binary",
  "--full-index",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--submodule=short",
  "-U3",
]

// `key` is the path's bytes as latin1, exactly as git wrote it; `name` is its UTF-8 reading, for the summary.
type Entry = { key: string; name: string; oldMode: string; newMode: string; newSha: string }
// Where git runs, and the private index it stages into.
type Repo = { cwd: string; signal: AbortSignal; index?: string }
// What stage leaves in the private index; `files` is undefined only for a listing too long to read.
type Staged = { entries: Entry[]; dropped: string[]; files?: number; refused?: "files" }

/**
 * Stage everything the agent changed outside vector-out/ and record it against `baseSha` as vector-out/patch.diff and
 * vector-out/summary.json. Run it from the repository's top level. The changes are staged in a private index read from
 * the base, so nothing the agent wrote into `.git/index` reaches the patch, and that index is left as it was. The
 * outcome comes from the patch: changes on a finished session are "changes", on a stopped one (`end`) a "draft"; no
 * changes are "no-changes", or "failed" after a stop. A patch over a PATCH_LIMITS limit is never truncated: the bundle
 * then holds an empty patch and a "failed" summary that names the limit. Untrusted text is escaped and, where it cannot
 * fit, shortened with SHORTENED. Only a wrong input, a wrong directory, a git failure or an unsafe vector-out/ throws,
 * before anything is written. Repositories of their own, gitlinks, links that leave the tree and names git refuses are
 * left out of the patch and listed in `dropped`. `files` is how many paths the patch holds; for the "files" refusal,
 * how many new paths the add would stage or how many changes the listing held before any reset, or undefined when
 * either listing was too long to read.
 */
export async function writeBundle(input: {
  cwd: string
  baseSha: string
  route: BundleRoute
  title: string
  body: string
  comment: string
  /** Absent when the session finished; otherwise how it stopped: stopReason's answer, or DEADLINE. */
  end?: Stop
  /**
   * writeBundle's own bound on its git commands. It takes no signal: the abort that ends a session at its deadline must
   * not also stop the bundle that saves its work.
   */
  timeoutMs?: number
}) {
  // A wrong route, base or stop is the caller's error, refused before git runs.
  summaryFor(input, { changed: false, heldBack: [], dropped: [] })
  const signal = AbortSignal.timeout(input.timeoutMs ?? GIT_TIMEOUT_MS)
  await requireTopLevel({ cwd: input.cwd, signal })
  // The agent writes .git/index: an entry it plants there (a `.git/` path, or one marked assume-valid or
  // skip-worktree) could put into the patch what the tree does not hold, or hide what it does.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "vector-index-"))
  const relative = path.relative(await fs.realpath(input.cwd), await fs.realpath(scratch))
  try {
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      throw new Error(`${FAILED} Its temporary directory is inside the repository.`)
    return await record(input, { cwd: input.cwd, signal, index: path.join(scratch, "index") })
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

async function record(input: Parameters<typeof writeBundle>[0], repo: Repo) {
  const staged = await stage(repo, input.baseSha)
  const sized = staged.refused ?? (await sizeRefusal(repo, staged.entries))
  const patch = sized || staged.entries.length === 0 ? undefined : await patchOf(repo, input.baseSha)
  const refused = sized ?? (patch?.overflow ? "bytes" : undefined)
  const bytes = refused || !patch ? Buffer.alloc(0) : patch.output
  const summary = summaryFor(input, {
    changed: staged.entries.length > 0,
    refused,
    heldBack: refused
      ? []
      : staged.entries
          .map((entry) => entry.name)
          .filter((name) => /^\.github\//i.test(name))
          .sort(),
    dropped: staged.dropped,
  })
  const text = JSON.stringify(summary)
  if (Buffer.byteLength(text) > GithubAgents.PATCH_LIMITS.summaryBytes) throw new Error(FAILED)
  await writeFiles(input.cwd, bytes, text)
  return { summary, files: staged.files, bytes: bytes.length, refused }
}

function summaryFor(
  input: Parameters<typeof writeBundle>[0],
  result: { changed: boolean; refused?: Refusal; heldBack: string[]; dropped: string[] },
) {
  const outcome = outcomeOf(result.changed, result.refused !== undefined, input.end !== undefined)
  const base = {
    v: 1,
    mode: input.route.mode,
    outcome,
    ...(input.end?.stop ? { stop: input.end.stop } : {}),
    ...(input.end?.limit ? { limit: input.end.limit } : {}),
    ...(result.refused ? { refused: result.refused } : {}),
    kind: input.route.kind,
    thread: input.route.thread,
    baseSha: input.baseSha,
    ...(input.route.headRef === undefined ? {} : { headRef: input.route.headRef }),
    ...(input.route.pr === undefined ? {} : { pr: input.route.pr }),
    ...(input.route.issue === undefined ? {} : { issue: input.route.issue }),
    ...(input.route.scheduleId === undefined ? {} : { scheduleId: input.route.scheduleId }),
    title: fitTitle(input.title),
    body: "",
    comment: "",
    draft: outcome === "draft",
    heldBack: fitList(result.heldBack),
    dropped: fitList(result.dropped),
  }
  const texts = fitTexts(
    Buffer.byteLength(JSON.stringify(base)),
    fit(escapeVectorMarkers(input.body), BODY_MAX_CHARS, Infinity),
    fit(escapeVectorMarkers(input.comment), BODY_MAX_CHARS, Infinity),
  )
  const parsed = RunSummary.safeParse({ ...base, body: texts.body, comment: texts.comment })
  if (!parsed.success) throw new Error(`${FAILED} Its summary is invalid.`)
  return parsed.data
}

// Publish may only make a result more conservative (2.12), so the pair it reads must agree with the patch.
function outcomeOf(changed: boolean, refused: boolean, stopped: boolean) {
  if (refused) return "failed"
  if (changed) return stopped ? "draft" : "changes"
  return stopped ? "failed" : "no-changes"
}

// One line of at most TITLE_MAX_CHARS characters.
function fitTitle(title: string) {
  const line = escapeVectorMarkers(title)
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .trim()
  return line.length <= TITLE_MAX_CHARS ? line : prefix(line, TITLE_MAX_CHARS - 1, Infinity) + "\u2026"
}

// A name over PATH_MAX_CHARS or one that would open a Vector marker is left out, and a list over LIST_BYTES of JSON is
// written empty: publish recomputes heldBack from the patch, and dropped is informational. Two paths that are not
// UTF-8 can read as one name, which is kept once.
function fitList(paths: string[]) {
  const kept = [...new Set(paths.filter((name) => name.length <= PATH_MAX_CHARS && escaped(name)))]
  return Buffer.byteLength(JSON.stringify(kept)) <= LIST_BYTES ? kept : []
}

// Body and comment share what summaryBytes leaves after the rest. Each keeps all of its text when it needs no more than
// half; otherwise it gets half, or what the other leaves.
function fitTexts(fixed: number, body: string, comment: string) {
  const budget = GithubAgents.PATCH_LIMITS.summaryBytes - fixed
  const sizes = { body: jsonBytes(body), comment: jsonBytes(comment) }
  if (sizes.body + sizes.comment <= budget) return { body, comment }
  const half = Math.floor(budget / 2)
  const bodyBytes = sizes.comment <= half ? budget - sizes.comment : Math.min(sizes.body, half)
  return { body: fit(body, BODY_MAX_CHARS, bodyBytes), comment: fit(comment, BODY_MAX_CHARS, budget - bodyBytes) }
}

function fit(text: string, chars: number, bytes: number) {
  if (text.length <= chars && jsonBytes(text) <= bytes) return text
  return prefix(text, chars - SHORTENED.length, bytes - jsonBytes(SHORTENED)) + SHORTENED
}

// The longest prefix of whole code points within `chars` UTF-16 units and `bytes` bytes of JSON string.
function prefix(text: string, chars: number, bytes: number) {
  const kept = { chars: 0, bytes: 0, points: [] as string[] }
  for (const point of text) {
    const size = jsonBytes(point)
    if (kept.chars + point.length > chars || kept.bytes + size > bytes) break
    kept.chars += point.length
    kept.bytes += size
    kept.points.push(point)
  }
  return kept.points.join("")
}

// The UTF-8 size of `text` inside a JSON string, escapes included.
function jsonBytes(text: string) {
  return Buffer.byteLength(JSON.stringify(text)) - 2
}

async function requireTopLevel(repo: Repo) {
  const top = await must(repo, ["rev-parse", "--show-toplevel"])
  const [here, root] = await Promise.all([fs.realpath(repo.cwd), fs.realpath(top.toString("utf8").replace(/\n$/, ""))])
  if (here !== root) throw new Error(`${FAILED} Run it from the repository's top level.`)
}

// The base read into the private index, `git add -A` outside vector-out/, then what changed against the base.
// Untracked repositories of their own and names git refuses are kept out of the add, since either one makes the whole
// add fail; listed entries publish refuses are reset to the base. Everything left out is listed. More than
// PATCH_LIMITS.files new paths for the add, or listed changes before the reset, is the "files" refusal.
async function stage(repo: Repo, base: string): Promise<Staged> {
  await must(repo, ["read-tree", base])
  const untracked = await listUntracked(repo)
  if (!untracked || untracked.added > GithubAgents.PATCH_LIMITS.files) return filesRefusal(untracked?.added)
  await must(
    repo,
    ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
    nul([".", EXCLUDE, ...untracked.left.map((key) => `:(exclude,literal)${key}`)]),
  )
  const left = untracked.left.map((key) => Buffer.from(key, "latin1").toString("utf8"))
  const listed = await listChanges(repo, base)
  if (!listed || listed.length > GithubAgents.PATCH_LIMITS.files) return filesRefusal(listed?.length)
  const refused = await refusedEntries(repo, listed)
  if (refused.length === 0) return { entries: listed, dropped: left.sort(), files: listed.length }
  await must(
    repo,
    ["--literal-pathspecs", "reset", "-q", base, "--pathspec-from-file=-", "--pathspec-file-nul"],
    nul(refused.map((entry) => entry.key)),
  )
  const after = await listChanges(repo, base)
  const kept = new Set(after?.map((entry) => entry.key))
  if (!after || refused.some((entry) => kept.has(entry.key))) throw new Error(FAILED)
  // A literal pathspec also resets everything under the path, so each listed entry the reset took back is named too:
  // a directory replaced by a link that leaves the tree comes back whole, its files' changes with it.
  const reset = listed.filter((entry) => !kept.has(entry.key)).map((entry) => entry.name)
  return { entries: after, dropped: [...left, ...reset].sort(), files: after.length }
}

function filesRefusal(files: number | undefined): Staged {
  return { entries: [], dropped: [], refused: "files", files }
}

// What the add would stage that is not in the base, and what it must not try. Without --directory, `git ls-files
// --others` names a directory (with a trailing slash) only when it is a repository of its own: the add cannot stage
// one without a commit and stages one with a commit as a gitlink, which publish refuses.
async function listUntracked(repo: Repo) {
  const listed = await git(repo, ["ls-files", "-z", "--others", "--exclude-standard", "--", ".", EXCLUDE], {
    limit: RAW_LIMIT,
  })
  if (listed.overflow) return undefined
  const keys = listed.output.toString("latin1").split("\0").slice(0, -1)
  const left = keys.filter((key) => key.endsWith("/") || unsafePath(key))
  return { left: left.map((key) => key.replace(/\/$/, "")), added: keys.length - left.length }
}

/**
 * A path git's verify_path refuses, so that `git add` dies on it, or that publish must never write: an absolute path,
 * an empty, `.` or `..` component, or a component that is `.git` in any case or that NTFS reads as `.git` (trailing
 * dots or spaces, a stream suffix after a colon, or the `git~1` short name). Like git, it splits at backslashes too.
 */
function unsafePath(key: string) {
  return (
    key.startsWith("/") ||
    key.split("/").some((part) => part === "" || part === "." || part === "..") ||
    key.split(/[/\\]/).some((part) => /^(?:\.git|git~1)[. ]*(?::|$)/i.test(part))
  )
}

async function listChanges(repo: Repo, base: string) {
  const listed = await git(
    repo,
    ["diff", "--cached", "--raw", "-z", "--no-abbrev", ...LISTING, base, "--", ".", EXCLUDE],
    { limit: RAW_LIMIT },
  )
  if (listed.overflow) return undefined
  // latin1 keeps each byte as one character, so a path that is not UTF-8 survives the split exactly.
  const fields = listed.output.toString("latin1").split("\0").slice(0, -1)
  if (fields.length % 2 !== 0) throw new Error(FAILED)
  return Array.from({ length: fields.length / 2 }, (_, index) =>
    entry(fields[index * 2] ?? "", fields[index * 2 + 1] ?? ""),
  )
}

// ":<old mode> <new mode> <old sha> <new sha> <status>" and the path.
function entry(meta: string, key: string): Entry {
  const match = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40,64} ([0-9a-f]{40,64}) [A-Z]$/.exec(meta)
  if (!match || key === "") throw new Error(FAILED)
  return {
    key,
    name: Buffer.from(key, "latin1").toString("utf8"),
    oldMode: match[1] ?? "",
    newMode: match[2] ?? "",
    newSha: match[3] ?? "",
  }
}

// Gitlinks either way, links that leave the tree, and, though neither the base nor the add can produce one, any path
// publish must never write.
async function refusedEntries(repo: Repo, entries: Entry[]) {
  const links = entries.filter((entry) => entry.newMode === SYMLINK)
  const targets = await linkTargets(
    repo,
    links.map((entry) => entry.newSha),
  )
  const leaving = new Set(
    links
      .filter((entry, index) => {
        const target = targets[index]
        return target === undefined || linkLeavesTree(entry.key, target)
      })
      .map((entry) => entry.key),
  )
  return entries.filter(
    (entry) =>
      entry.oldMode === GITLINK || entry.newMode === GITLINK || unsafePath(entry.key) || leaving.has(entry.key),
  )
}

// Each link's target, or undefined for one over PATH_MAX_CHARS bytes, which counts as leaving the tree. No link read
// from the tree is that long, but with core.symlinks=false the add stores a plain file's content as the target.
async function linkTargets(repo: Repo, shas: string[]) {
  const sizes = await blobSizes(repo, shas)
  const short = shas.filter((_, index) => (sizes[index] ?? Infinity) <= PATH_MAX_CHARS)
  const blobs = await readBlobs(repo, short)
  const read = new Map(short.map((sha, index) => [sha, blobs[index]?.toString("latin1")]))
  return shas.map((sha) => read.get(sha))
}

// `git cat-file --batch` answers "<sha> blob <size>\n<content>\n" for each object, in order. Every blob asked for is
// at most PATH_MAX_CHARS bytes.
async function readBlobs(repo: Repo, shas: string[]) {
  if (shas.length === 0) return []
  const read = await git(repo, ["cat-file", "--batch"], {
    limit: shas.length * (PATH_MAX_CHARS + 160),
    input: shas.map((sha) => `${sha}\n`).join(""),
  })
  if (read.overflow) throw new Error(FAILED)
  return shas.reduce<{ at: number; blobs: Buffer[] }>(
    (state, sha) => {
      const end = read.output.indexOf(10, state.at)
      const header = read.output.subarray(state.at, end).toString("latin1").split(" ")
      const size = Number(header[2])
      if (end < 0 || header[0] !== sha || header[1] !== "blob" || !Number.isSafeInteger(size)) throw new Error(FAILED)
      return { at: end + 1 + size + 1, blobs: [...state.blobs, read.output.subarray(end + 1, end + 1 + size)] }
    },
    { at: 0, blobs: [] },
  ).blobs
}

async function blobSizes(repo: Repo, shas: string[]) {
  if (shas.length === 0) return []
  const checked = await git(repo, ["cat-file", "--batch-check=%(objectsize)"], {
    limit: shas.length * 160,
    input: shas.map((sha) => `${sha}\n`).join(""),
  })
  const sizes = checked.output.toString("latin1").split("\n").slice(0, -1)
  if (checked.overflow || sizes.length !== shas.length || sizes.some((size) => !/^\d+$/.test(size)))
    throw new Error(FAILED)
  return sizes.map(Number)
}

// The size of every new blob; one over PATCH_LIMITS.fileBytes is the "fileBytes" refusal.
async function sizeRefusal(repo: Repo, entries: Entry[]): Promise<Refusal | undefined> {
  const sizes = await blobSizes(
    repo,
    entries.filter((entry) => BLOB_MODES.has(entry.newMode) && !/^0+$/.test(entry.newSha)).map((entry) => entry.newSha),
  )
  return sizes.some((size) => size > GithubAgents.PATCH_LIMITS.fileBytes) ? "fileBytes" : undefined
}

// The patch, read only up to PATCH_LIMITS.bytes: past that git is stopped and the result is `overflow`.
function patchOf(repo: Repo, base: string) {
  return git(repo, ["diff", "--cached", ...PATCH, base, "--", ".", EXCLUDE], {
    limit: GithubAgents.PATCH_LIMITS.bytes,
  })
}

// Never through a link: vector-out/ must be a real directory, and each bundle file is removed and created anew with
// O_EXCL, so a planted link at either name is refused instead of followed. Other files there (V27's session file) stay.
async function writeFiles(cwd: string, patch: Uint8Array, summary: string) {
  const dir = path.join(cwd, GithubAgents.BUNDLE_DIR)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  if (!(await fs.lstat(dir)).isDirectory()) throw new Error(`${FAILED} ${GithubAgents.BUNDLE_DIR} is not a directory.`)
  const [patchFile, summaryFile] = GithubAgents.BUNDLE_FILES
  await fs.rm(path.join(dir, patchFile), { force: true })
  await fs.writeFile(path.join(dir, patchFile), patch, { flag: "wx", mode: 0o600 })
  await fs.rm(path.join(dir, summaryFile), { force: true })
  await fs.writeFile(path.join(dir, summaryFile), summary, { flag: "wx", mode: 0o600 })
}

// NUL-separated, for --pathspec-from-file; latin1 writes each path's bytes back exactly.
function nul(keys: string[]) {
  return Buffer.from(keys.map((key) => `${key}\0`).join(""), "latin1")
}

async function must(repo: Repo, args: string[], input?: Uint8Array) {
  const result = await git(repo, args, { limit: 1_000_000, input })
  if (result.overflow) throw new Error(FAILED)
  return result.output
}

// git with the pinned config, the exact environment and the private index. stderr is ignored, so no path or text
// reaches the log, and stdout is kept up to `limit` bytes: past that git is killed and the result is marked `overflow`.
function git(
  repo: Repo,
  args: string[],
  options: { limit: number; input?: string | Uint8Array },
): Promise<{ output: Buffer; overflow: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...CONFIG, ...args], {
      cwd: repo.cwd,
      env: { ...environment(), ...(repo.index === undefined ? {} : { GIT_INDEX_FILE: repo.index }) },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      signal: repo.signal,
      windowsHide: true,
    })
    const state = { size: 0, overflow: false, chunks: [] as Buffer[] }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (state.overflow) return
      if (state.size + chunk.length > options.limit) {
        state.overflow = true
        child.kill("SIGKILL")
        return
      }
      state.size += chunk.length
      state.chunks.push(chunk)
    })
    child.on("error", (error) => reject(new Error(FAILED, { cause: error })))
    child.on("close", (code) => {
      if (state.overflow) return resolve({ output: Buffer.concat(state.chunks), overflow: true })
      if (code !== 0) return reject(new Error(FAILED))
      resolve({ output: Buffer.concat(state.chunks), overflow: false })
    })
    // git may exit before reading all of its input; the exit code says what happened.
    child.stdin?.on("error", () => undefined)
    child.stdin?.end(options.input)
  })
}

// Only what git needs to start, and nothing inherited from GIT_*: no credential reaches git or a filter it runs.
function environment() {
  const kept = ["PATH", "HOME", "SYSTEMROOT"].flatMap((name) => {
    const value = process.env[name]
    return value === undefined ? [] : [[name, value] as const]
  })
  return { ...Object.fromEntries(kept), ...ENVIRONMENT }
}

export * as GithubBundle from "./github.bundle"
