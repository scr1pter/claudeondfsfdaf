// VS-12/13, plan D10: browser-safe proposal and consent state policy, not an executor or an authentication port.
// A trusted adapter must show the complete proposal/operation, authenticate the actor's CURRENT authority, and
// obtain that person's approval before calling approve. JSON, PR text, model output and a successful match here
// cannot establish any of those facts. No existing review invocation acquires write/check/publish permission.
import { hash } from "../util/encode"
import { CHECK_COMMANDS, COVERAGE_COMMANDS } from "./permission"

export const FIX_LIMITS = Object.freeze({
  patchBytes: 256 * 1024,
  files: 64,
  lines: 5_000,
  pathBytes: 1_024,
  findings: 128,
  commands: 16,
  arguments: 64,
  commandBytes: 8_192,
  messageBytes: 8_192,
  commandMs: 120_000,
  outputBytes: 80 * 1024,
  consentMs: 15 * 60_000,
  pending: 128,
})

export type FixScope =
  | {
      kind: "local"
      repository: string // canonical absolute repository root, supplied by the trusted Git adapter
      worktree: string // separate isolated worktree; spelling alone cannot prove filesystem identity/isolation
      sourceBranch: string
      baseBranch: string
      destinationBranch: string
    }
  | {
      kind: "github"
      repositoryID: number // immutable native ID, not just owner/name
      owner: string
      repository: string
      pullRequest: number
      sourceBranch: string
      baseBranch: string
      destinationBranch: string // publish only through @vector V21, on a vector/… branch
    }

export interface FixProposal {
  version: 1
  scope: FixScope
  base: string
  head: string
  findings: readonly string[] // references only; the trusted adapter must select actual verified findings
  files: readonly { path: string; preimage: string | null; postimage: string | null }[]
  patch: string // exact UTF-8 Git text patch, including its line endings and final newline
}

export type FixOperation =
  | { kind: "apply" }
  | {
      kind: "checks"
      commands: readonly { argv: readonly string[]; cwd: string }[] // argv, never a shell command
      network: "off"
      timeoutMs: number
      outputBytes: number
    }
  | { kind: "commit"; message: string }
  | { kind: "push"; remote: string; commit: string; mode: "branch" | "draft-pr" }

export interface PreparedFixProposal {
  proposal: FixProposal
  patchDigest: string
  digest: string
}

export type FixRefusal =
  | "proposal"
  | "operation"
  | "actor"
  | "clock"
  | "expiry"
  | "capacity"
  | "unknown"
  | "revoked"
  | "used"
  | "mismatch"

type Refused = { ok: false; reason: FixRefusal }
const refused = (reason: FixRefusal): Refused => ({ ok: false, reason })
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const encoder = new TextEncoder()

/** Fixed field order, set ordering for files/finding IDs, and EXACT patch bytes; no diff whitespace normalization. */
export async function prepareFixProposal(input: unknown): Promise<({ ok: true } & PreparedFixProposal) | Refused> {
  const proposal = proposalValue(input)
  if (!proposal) return refused("proposal")
  const patchDigest = `sha256:${await hash(proposal.patch)}`
  const digest = `sha256:${await hash(
    JSON.stringify([
      "vector.fix-proposal.v1",
      scopeValue(proposal.scope),
      proposal.base,
      proposal.head,
      proposal.findings,
      proposal.files.map((file) => [file.path, file.preimage, file.postimage]),
      patchDigest,
    ]),
  )}`
  return { ok: true, proposal, patchDigest, digest }
}

// Opaque handles are recognized only by their issuing policy instance. Serializing/recreating one grants nothing.
declare const consentHandle: unique symbol
export type FixConsent = Readonly<{ [consentHandle]: true }>
interface ConsentRecord {
  actor: string
  proposal: string
  operation: string
  approvedAt: number
  expiresAt: number
  state: "pending" | "revoked" | "used" | "expired"
}

/**
 * In-process state policy only. A restart loses all grants. Multi-process/durable executors must own an atomic
 * persisted approval/consume transaction and recheck current owner authority before effects; this class supplies
 * neither durable one-use nor proof of human approval. consume spends permission BEFORE a possible effect: failure,
 * cancellation or uncertainty requires another concrete approval, never an automatic retry with the old handle.
 */
export function createFixConsentPolicy(clock: () => number) {
  const records = new WeakMap<FixConsent, ConsentRecord>()
  const pending = new Set<FixConsent>()
  let latest = -1
  const time = () => {
    const now = clock()
    if (!Number.isSafeInteger(now) || now < 0 || now < latest) return undefined
    latest = now
    return now
  }
  const expire = (now: number) => {
    for (const handle of pending) {
      const record = records.get(handle)!
      if (now < record.expiresAt) continue
      record.state = "expired"
      pending.delete(handle)
    }
  }
  return Object.freeze({
    // The actor argument is a trusted adapter's authenticated principal, NOT an actor field accepted from JSON.
    async approve(input: unknown, operation: unknown, actor: string, lifetimeMs: number) {
      if (!principal(actor)) return refused("actor")
      if (!integer(lifetimeMs, FIX_LIMITS.consentMs)) return refused("expiry")
      const binding = bindingValue(input, operation)
      if (!binding.ok) return binding
      const prepared = await prepareFixProposal(binding.proposal)
      if (!prepared.ok) return prepared
      const now = time()
      if (now === undefined) return refused("clock")
      if (!Number.isSafeInteger(now + lifetimeMs)) return refused("expiry")
      expire(now)
      if (pending.size >= FIX_LIMITS.pending) return refused("capacity")
      const handle = Object.freeze({}) as FixConsent
      records.set(handle, {
        actor,
        proposal: prepared.digest,
        operation: binding.operation,
        approvedAt: now,
        expiresAt: now + lifetimeMs,
        state: "pending",
      })
      pending.add(handle)
      return { ok: true as const, consent: handle, expiresAt: now + lifetimeMs }
    },
    revoke(handle: FixConsent) {
      const record = records.get(handle)
      if (!record) return refused("unknown")
      if (record.state !== "pending") return refused(record.state === "expired" ? "expiry" : record.state)
      record.state = "revoked"
      pending.delete(handle)
      return { ok: true as const }
    },
    async consume(handle: FixConsent, input: unknown, operation: unknown, actor: string) {
      const record = records.get(handle)
      if (!record) return refused("unknown")
      if (!principal(actor)) return refused("actor")
      // Snapshot and hash current bytes, never trust a supplied digest. Check state again AFTER this await so two
      // concurrent consumes or revoke-during-hash cannot each succeed. A mismatch does not spend another grant.
      const binding = bindingValue(input, operation)
      if (!binding.ok) return binding
      const prepared = await prepareFixProposal(binding.proposal)
      if (!prepared.ok) return prepared
      const now = time()
      if (now === undefined) return refused("clock")
      expire(now)
      if (record.state !== "pending") return refused(record.state === "expired" ? "expiry" : record.state)
      if (record.actor !== actor || record.proposal !== prepared.digest || record.operation !== binding.operation)
        return refused("mismatch")
      record.state = "used"
      pending.delete(handle)
      // This receipt describes a state transition, not authorization to call shell/Git/network APIs.
      return {
        ok: true as const,
        proposalDigest: prepared.digest,
        patchDigest: prepared.patchDigest,
        actor,
        approvedAt: record.approvedAt,
        consumedAt: now,
      }
    },
  })
}

function bindingValue(input: unknown, operation: unknown) {
  const proposal = proposalValue(input)
  if (!proposal) return refused("proposal")
  const action = operationValue(operation, proposal.scope)
  if (!action) return refused("operation")
  return { ok: true as const, proposal, operation: action }
}

function proposalValue(input: unknown): FixProposal | undefined {
  if (!fields(input, ["version", "scope", "base", "head", "findings", "files", "patch"])) return
  if (
    input.version !== 1 ||
    !commit(input.base) ||
    !commit(input.head) ||
    input.base.length !== input.head.length ||
    !scope(input.scope)
  )
    return
  if (!text(input.patch, FIX_LIMITS.patchBytes) || !input.patch.endsWith("\n")) return
  if (
    !Array.isArray(input.findings) ||
    !input.findings.length ||
    input.findings.length > FIX_LIMITS.findings ||
    input.findings.some((value) => !principal(value)) ||
    new Set(input.findings).size !== input.findings.length ||
    !Array.isArray(input.files) ||
    !input.files.length ||
    input.files.length > FIX_LIMITS.files
  )
    return
  const files = input.files.flatMap((file) => {
    if (
      !fields(file, ["path", "preimage", "postimage"]) ||
      !filePath(file.path) ||
      !(file.preimage === null || digest(file.preimage)) ||
      !(file.postimage === null || digest(file.postimage)) ||
      file.preimage === file.postimage
    )
      return []
    return [{ path: file.path, preimage: file.preimage, postimage: file.postimage }]
  })
  if (files.length !== input.files.length || new Set(files.map((file) => file.path)).size !== files.length) return
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (!patchMatches(input.patch, files)) return
  return Object.freeze({
    version: 1,
    scope: Object.freeze({ ...input.scope }),
    base: input.base,
    head: input.head,
    findings: Object.freeze([...input.findings].sort()),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    patch: input.patch,
  })
}

// Deliberately narrow text-patch subset: regular-file text edits, new/deleted 100644 files, no quoted paths or mode changes/renames,
// symlinks, gitlinks, binary payloads or ignored trailing records. The executor still verifies actual pre/postimage
// hashes, no symlinks, canonical Git/worktree identity, dirty state and exact current head before compare-and-write.
function patchMatches(patch: string, files: FixProposal["files"]) {
  const lines = patch.split("\n")
  lines.pop()
  const seen = new Set<string>()
  let cursor = 0
  let changed = 0
  while (cursor < lines.length) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[cursor++])
    if (!header || header[1] !== header[2] || seen.has(header[1])) return false
    const file = files.find((file) => file.path === header[1])
    if (!file) return false
    seen.add(file.path)
    if (lines[cursor] === "new file mode 100644") {
      if (file.preimage !== null) return false
      cursor++
    }
    if (lines[cursor] === "deleted file mode 100644") {
      if (file.postimage !== null) return false
      cursor++
    }
    if (/^index (?:[0-9a-f]{7,64})\.\.(?:[0-9a-f]{7,64})(?: 100(?:644|755))?$/.test(lines[cursor] ?? "")) cursor++
    if (lines[cursor++] !== `--- ${file.preimage === null ? "/dev/null" : `a/${file.path}`}`) return false
    if (lines[cursor++] !== `+++ ${file.postimage === null ? "/dev/null" : `b/${file.path}`}`) return false
    let hunks = 0
    let previousOld = -1
    let previousNew = -1
    while (cursor < lines.length && !lines[cursor].startsWith("diff --git ")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: [^\r\n]*)?$/.exec(lines[cursor++])
      if (!hunk) return false
      const oldStart = Number(hunk[1])
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2])
      const newStart = Number(hunk[3])
      const newCount = hunk[4] === undefined ? 1 : Number(hunk[4])
      if (
        [oldStart, oldCount, newStart, newCount].some((value) => !Number.isSafeInteger(value) || value < 0) ||
        !Number.isSafeInteger(oldStart + oldCount) ||
        !Number.isSafeInteger(newStart + newCount) ||
        oldStart < previousOld ||
        newStart < previousNew ||
        (file.preimage === null && (oldStart !== 0 || oldCount !== 0)) ||
        (file.postimage === null && (newStart !== 0 || newCount !== 0)) ||
        (oldCount > 0 && oldStart === 0) ||
        (newCount > 0 && newStart === 0)
      )
        return false
      previousOld = oldStart + oldCount
      previousNew = newStart + newCount
      let oldLines = 0
      let newLines = 0
      let edits = 0
      let newline = false
      while (cursor < lines.length && !lines[cursor].startsWith("@@ ") && !lines[cursor].startsWith("diff --git ")) {
        const line = lines[cursor++]
        if (line === "\\ No newline at end of file") {
          if (newline || oldLines + newLines === 0) return false
          newline = true
          continue
        }
        newline = false
        if (line[0] !== " " && line[0] !== "+" && line[0] !== "-") return false
        if (line[0] !== "+") oldLines++
        if (line[0] !== "-") newLines++
        if (line[0] !== " ") edits++
        if (oldLines > oldCount || newLines > newCount) return false
      }
      if (oldLines !== oldCount || newLines !== newCount || !edits) return false
      changed += edits
      if (changed > FIX_LIMITS.lines) return false
      hunks++
    }
    if (!hunks) return false
  }
  return seen.size === files.length
}

function operationValue(input: unknown, target: FixScope): string | undefined {
  if (fields(input, ["kind"]) && input.kind === "apply") return JSON.stringify(["apply"])
  if (fields(input, ["kind", "message"]) && input.kind === "commit" && text(input.message, FIX_LIMITS.messageBytes))
    return JSON.stringify(["commit", input.message])
  if (
    fields(input, ["kind", "remote", "commit", "mode"]) &&
    input.kind === "push" &&
    commit(input.commit) &&
    (input.mode === "branch" || input.mode === "draft-pr") &&
    typeof input.remote === "string" &&
    /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+$/.test(input.remote) &&
    input.remote.length <= 2_048 &&
    (target.kind !== "github" || input.remote === `https://github.com/${target.owner}/${target.repository}.git`)
  )
    return JSON.stringify(["push", input.remote, input.commit, input.mode])
  if (
    !fields(input, ["kind", "commands", "network", "timeoutMs", "outputBytes"]) ||
    input.kind !== "checks" ||
    input.network !== "off" ||
    !integer(input.timeoutMs, FIX_LIMITS.commandMs) ||
    !integer(input.outputBytes, FIX_LIMITS.outputBytes) ||
    !Array.isArray(input.commands) ||
    !input.commands.length ||
    input.commands.length > FIX_LIMITS.commands
  )
    return
  const commands = input.commands.flatMap((entry) => {
    if (!fields(entry, ["argv", "cwd"]) || !(entry.cwd === "." || filePath(entry.cwd)) || !Array.isArray(entry.argv))
      return []
    const argv: readonly unknown[] = entry.argv
    if (
      !argv.length ||
      argv.length > FIX_LIMITS.arguments ||
      !argv.every((arg): arg is string => text(arg, 1_024) && !/[\r\n]/.test(arg)) ||
      encoder.encode(JSON.stringify(argv)).length > FIX_LIMITS.commandBytes
    )
      return []
    const allowed = [...CHECK_COMMANDS, ...Object.values(COVERAGE_COMMANDS).map((value) => value.command)]
    if (
      !allowed.some((command) => {
        const prefix = command.split(" ")
        return (
          prefix.every((arg, i) => argv[i] === arg) &&
          argv
            .slice(prefix.length)
            .every((arg) => arg === "." || arg === "./..." || (filePath(arg) && !arg.startsWith("-")))
        )
      })
    )
      return []
    return [[entry.cwd, [...argv]]]
  })
  if (commands.length !== input.commands.length) return
  return JSON.stringify(["checks", commands, input.network, input.timeoutMs, input.outputBytes])
}

function scope(input: unknown): input is FixScope {
  if (
    !record(input) ||
    !branch(input.sourceBranch) ||
    !branch(input.baseBranch) ||
    !branch(input.destinationBranch) ||
    input.destinationBranch === input.baseBranch ||
    input.destinationBranch === input.sourceBranch
  )
    return false
  if (input.kind === "local")
    return (
      fields(input, ["kind", "repository", "worktree", "sourceBranch", "baseBranch", "destinationBranch"]) &&
      absolute(input.repository) &&
      absolute(input.worktree) &&
      input.repository !== input.worktree
    )
  return (
    fields(input, [
      "kind",
      "repositoryID",
      "owner",
      "repository",
      "pullRequest",
      "sourceBranch",
      "baseBranch",
      "destinationBranch",
    ]) &&
    input.kind === "github" &&
    integer(input.repositoryID, Number.MAX_SAFE_INTEGER) &&
    integer(input.pullRequest, Number.MAX_SAFE_INTEGER) &&
    typeof input.owner === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(input.owner) &&
    typeof input.repository === "string" &&
    /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(input.repository) &&
    input.destinationBranch.startsWith("vector/")
  )
}

function scopeValue(input: FixScope) {
  return input.kind === "local"
    ? [input.kind, input.repository, input.worktree, input.sourceBranch, input.baseBranch, input.destinationBranch]
    : [
        input.kind,
        input.repositoryID,
        input.owner,
        input.repository,
        input.pullRequest,
        input.sourceBranch,
        input.baseBranch,
        input.destinationBranch,
      ]
}

function record(input: unknown): input is Record<string, unknown> {
  return (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.getPrototypeOf(input) === Object.prototype &&
    Reflect.ownKeys(input).every(
      (key) =>
        typeof key === "string" &&
        Object.getOwnPropertyDescriptor(input, key)?.enumerable === true &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, "value"),
    )
  )
}

function fields(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
  return record(input) && Object.keys(input).length === keys.length && keys.every((key) => Object.hasOwn(input, key))
}

function text(input: unknown, limit: number): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= limit &&
    input.isWellFormed() &&
    !input.includes("\0") &&
    encoder.encode(input).length <= limit
  )
}

function principal(input: unknown): input is string {
  return text(input, 256) && !/[\u0000-\u0020\u007f]/.test(input)
}

function integer(input: unknown, max: number): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0 && input <= max
}

function commit(input: unknown): input is string {
  return typeof input === "string" && COMMIT.test(input)
}

function digest(input: unknown): input is string {
  return typeof input === "string" && DIGEST.test(input)
}

function filePath(input: unknown): input is string {
  return (
    text(input, FIX_LIMITS.pathBytes) &&
    /^[A-Za-z0-9_@+.,/-]+$/.test(input) &&
    input.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
  )
}

function absolute(input: unknown): input is string {
  return (
    text(input, 4_096) &&
    /^(?:\/|[A-Za-z]:\/)/.test(input) &&
    !/[\\\r\n]/.test(input) &&
    input
      .split("/")
      .slice(1)
      .every((part) => part !== "" && part !== "." && part !== "..")
  )
}

function branch(input: unknown): input is string {
  return (
    text(input, 256) &&
    /^[A-Za-z0-9_./-]+$/.test(input) &&
    !input.includes("..") &&
    !input.includes("//") &&
    input
      .split("/")
      .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"))
  )
}
