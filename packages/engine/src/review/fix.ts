import path from "node:path"
import os from "node:os"
import { isUtf8 } from "node:buffer"
import { constants } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, realpath, rm, rmdir, stat, unlink } from "node:fs/promises"
import { Cause, Context, Deferred, Duration, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { KeyedMutex } from "@vectordevai/core/effect/keyed-mutex"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { refusal } from "@vectordevai/core/git"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { Global } from "@vectordevai/core/global"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import {
  FIX_LIMITS,
  prepareFixProposal,
  type createFixConsentPolicy,
  type FixConsent,
  type FixProposal,
} from "@vectordevai/core/review/fix-proposal"
import { CHECK_COMMANDS } from "@vectordevai/core/review/permission"
import { which } from "@vectordevai/core/util/which"
import { Git } from "@/git"
import { TaskIsolation } from "@/task/isolation"
import { FileLock } from "@/tool/file-lock"
import { FileState } from "@/tool/file-state"
import { assertWritable } from "@/tool/owned-path"
import { Sandbox } from "@/tool/shell/sandbox"
import { makeDiagnosticAdapters, type ScopedCommand } from "./diagnostic-adapter"

// VS-12 (SF-07, SF-08): the consented local fix executor, proposal -> preview -> apply -> checks, commit -> push.
// Its trusted adapters are the CLI's apply step (cli/cmd/review.fix.ts, SF-09) and the owner fix API
// (review/fix-owner.ts, SF-10a); each calls `policy.approve` only after showing the exact step. No key or permission
// reaches this module, and it calls no model.
//
// Consent is the core contract's (review/fix-proposal.ts). A trusted adapter shows the Preview (and, for each later
// step, the exact operation), authenticates the actor and calls `policy.approve`; each step spends its own handle with
// `policy.consume` before its first effect, so applying, checking, committing and pushing are separate permissions,
// each single-use and bound to the proposal (its head and patch digest) and to that operation (the commands, the
// message, the remote and commit). Proof that a person approved rests on that adapter, as fix-proposal.ts:1-4 says:
// anyone who can call a step with a policy of their own can also approve with it, so the adapter must be its only
// caller. Every refusal before a consume leaves the consent unspent; a check's result never authorizes anything.
//
// The fix checkout is a TaskIsolation fix placement (`reserveFix`): Git's detached worktree at the proposal's exact
// head, under the data folder, never the user's checkout. Writes take FileLock, compare FileState stamps (the
// compare-and-write preimage), pass the owned-path guard keyed by the fix ID, and land through TaskIsolation.place (a
// new name, then a rename). Git runs here without hooks, fsmonitor or optional locks.
//
// Checks run only CHECK_COMMANDS argv, each in the fix checkout under the shell sandbox's offline mode with writes to
// the checkout alone (Sandbox.offline, `writes: "workspace"`), in an environment built from nothing, through the
// process spawner, whose scope release is the one signaller of the process group (one SIGKILL). A check can still read
// the host's files outside the sandbox's masks (the user's home among them), so its output is untrusted data that must
// be redacted before it reaches a model or a post. A commit is built with Git's plumbing in a private index from the
// verified postimages and lands on the destination branch only if that branch does not exist; the checkout stays
// detached at the head. A push sends that commit only to the approved remote, only as a new destination branch, and
// makes no GitHub call. A repository on this computer receives it with its hooks off, but with its own configuration,
// as in a manual push. Linux only: elsewhere every method refuses as unavailable before any effect.

export const REFUSALS = [
  "unavailable",
  "proposal",
  "operation",
  "actor",
  "clock",
  "expiry",
  "capacity",
  "unknown",
  "revoked",
  "used",
  "mismatch",
  "scope",
  "state",
  "head",
  "digest",
  "worktree",
  "path",
  "symlink",
  "binary",
  "limit",
  "preimage",
  "postimage",
  "patch",
  "context",
  "sandbox",
  "dependencies",
  "destination",
  "remote",
  "push",
] as const
export type Reason = (typeof REFUSALS)[number]

export class Refused extends Schema.TaggedErrorClass<Refused>()("ReviewFix.Refused", {
  reason: Schema.Literals(REFUSALS),
  message: Schema.String,
  file: Schema.optional(Schema.String),
}) {}

export type Policy = ReturnType<typeof createFixConsentPolicy>
/**
 * A fix's state while this process holds it. A fix whose placement is removed is forgotten, so `cancelled` and
 * `failed` describe a placement that was kept (retained) and is still on disk.
 */
export type State = "proposal" | "preview" | "applied" | "committed" | "pushed" | "cancelled" | "failed"
/** `writing` runs inside a write step, which nothing interrupts; `wrote` runs after it, where a cancel may land. */
export type Event = { type: "writing"; file: string } | { type: "wrote"; file: string }
export type Change = { path: string; status: "added" | "modified" | "deleted"; additions: number; deletions: number }
export type Placement = { fixID: string; worktree: string; repository: string; head: string }
export type Preview = Placement & {
  base: string
  sourceBranch: string
  destinationBranch: string
  digest: string
  patchDigest: string
  patch: string
  files: readonly Change[]
}
export type Applied = {
  fixID: string
  worktree: string
  head: string
  digest: string
  patchDigest: string
  actor: string
  consumedAt: number
  files: readonly Change[]
}
export type Cleanup = { fixID: string; removed: true } | { fixID: string; removed: false; reason: string }
/** The commit author and committer, supplied by the trusted adapter (Vector's own identity), never by a proposal. */
export type Identity = { name: string; email: string }
/** One check command's run. `output` is the first `outputBytes` of its stdout and stderr: untrusted data, never kept. */
export type CheckResult = {
  argv: readonly string[]
  cwd: string
  exitCode: number | null
  timedOut: boolean
  output: string
  truncated: boolean
  durationMs: number
}
/** `probe` comes before the sandbox's own test run, still before the consent is spent. */
export type CheckEvent =
  | { type: "probe" }
  | { type: "started"; index: number }
  | { type: "finished"; index: number; result: CheckResult }
export type Checked = {
  fixID: string
  head: string
  digest: string
  /** sha256 of the consented checks operation as the consent binds it. */
  operation: string
  actor: string
  consumedAt: number
  results: readonly CheckResult[]
  /** The checkout stopped holding exactly the approved patch at the reviewed head between two commands. */
  aborted?: "head" | "worktree"
  /**
   * Paths Git reports changed or untracked (not ignored) beyond the approved patch after the run, at most 32: files a
   * check left. While any is there, every later step refuses "worktree"; cancel the fix and apply it again.
   */
  leftovers?: readonly string[]
  /** Informational only: a result authorizes no change, commit or push. */
  passed: boolean
}
export type Committed = {
  fixID: string
  head: string
  digest: string
  commit: string
  tree: string
  branch: string
  author: Identity
  actor: string
  consumedAt: number
}
export type Pushed = {
  fixID: string
  commit: string
  remote: string
  ref: string
  mode: "branch" | "draft-pr"
  actor: string
  consumedAt: number
}

/** The platform the checks' sandbox is chosen for. Tests set it to reach the Windows and no-sandbox refusals. */
export const SandboxPlatform = Context.Reference<NodeJS.Platform>("ReviewFix.SandboxPlatform", {
  defaultValue: () => process.platform,
})
/**
 * Why checks may not run in this process, or undefined. Read at each call, since isolation can be required later in a
 * process's life. Tests replace it: CI sets CI=true on every runner.
 */
export const RunnerContext = Context.Reference<() => string | undefined>("ReviewFix.RunnerContext", {
  defaultValue: () => () => runnerContext(process.env),
})
// Runners that do not all set CI themselves.
const RUNNERS = [
  "GITLAB_CI",
  "BUILDKITE",
  "JENKINS_URL",
  "TF_BUILD",
  "CIRCLECI",
  "TEAMCITY_VERSION",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
]
/**
 * Checks never run in a hosted GitHub run (process isolation required), on GitHub Actions, or in any other CI job (CI
 * set to anything but empty, 0 or false, or a runner's own variable), where the job may hold secrets or write tokens,
 * on disk as well as in its environment (I-6: project code never runs for CI).
 */
export function runnerContext(env: NodeJS.ProcessEnv) {
  const ci = env.CI?.trim().toLowerCase()
  if (
    ProcessIsolation.required() ||
    GithubAgents.onActionsRunner(env) ||
    (ci !== undefined && !["", "0", "false"].includes(ci)) ||
    RUNNERS.some((name) => env[name])
  )
    return "Checks not run: checks never run in a CI job or a GitHub run, which may hold secrets or write tokens."
  return undefined
}

// The executor keeps every preimage and postimage in memory for its rollback, so their sum is bounded, and checked
// before each file is read. Per file, the effective bound is FileState's 16 MiB hash limit (a larger file has no sha256
// to compare) under TaskIsolation.Limits.fileBytes; 64 MiB is four such files.
const TOTAL_BYTES = 64 * 1024 * 1024
// A byte order mark stays in the text, so the bytes written back are exactly the bytes read.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
const encoder = new TextEncoder()
// One fix's preview, apply and cancel never overlap in this process.
const mutex = KeyedMutex.makeUnsafe<string>()

const refuse = (reason: Reason, message: string, file?: string) =>
  new Refused({ reason, message, ...(file ? { file } : {}) })
const linux = Effect.suspend(() =>
  process.platform === "linux"
    ? Effect.void
    : Effect.fail(refuse("unavailable", "Applying a review fix is available on Linux only. Nothing was changed.")),
)
const io = <A>(body: () => Promise<A>) =>
  Effect.tryPromise({
    try: body,
    catch: (cause) => refuse("worktree", cause instanceof Error ? cause.message : String(cause)),
  })
const optional = <A>(body: () => Promise<A>) =>
  io(() =>
    body().catch((cause) => {
      if (cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "ENOTDIR"))
        return undefined
      throw cause
    }),
  )
const isolated = (reason: Reason) => (cause: Error) => {
  if (cause instanceof Refused) return cause
  if (cause instanceof TaskIsolation.IsolationError && (cause.code === "head" || cause.code === "unavailable"))
    return refuse(cause.code, cause.message)
  return refuse(reason, cause.message)
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
// Git's object ID of a blob with exactly these bytes, in the repository's hash.
const blobID = (bytes: Uint8Array, length: number) =>
  createHash(length === 64 ? "sha256" : "sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex")
const totalLimit = () => refuse("limit", "The files this fix changes are over the total size limit.")

type Entry = {
  state: State
  placement: Placement
  digest?: string
  patchDigest?: string
  commit?: { sha: string; branch: string }
}
type Held = { path: string; bytes?: Uint8Array }
type Command = { argv: readonly string[]; cwd: string }
export type ChecksOperation = {
  kind: "checks"
  commands: readonly Command[]
  network: "off"
  timeoutMs: number
  outputBytes: number
}
// What a step spends a consent with: the adapter's policy, its handle and the authenticated actor.
type Spend = { consent: FixConsent; policy: Policy; actor: string }
type TreeEntry = { mode: string; type: string; oid: string }
type Plan = Change & {
  target: string
  before?: { bytes: Uint8Array; mode: number; stamp: FileState.Stamp }
  after?: Uint8Array
  mode: number
  /** Folders this file's write creates, shallowest first; each folder belongs to the first file that needs it. */
  missing: readonly string[]
}
type Step = { plan: Plan; created: string[] }

export const make = Effect.gen(function* () {
  const isolation = yield * TaskIsolation.Service
  const git = yield * Git.Service
  const spawner = yield * ChildProcessSpawner
  // Only fixes whose placement exists: an entry goes when its placement is removed.
  const states = new Map<string, Entry>()
  // The running checks and pushes of each fix, which `cancel` stops before it waits for the fix's lock; and the fixes
  // a cancel is stopping, so a step that starts meanwhile stops at once.
  const stops = new Map<string, Set<Deferred.Deferred<void>>>()
  const cancelling = new Set<string>()
  const run = (cwd: string, args: string[], extra: { env?: Record<string, string>; stdin?: Uint8Array } = {}) =>
    git.run(["-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", ...args], {
      cwd,
      env: { GIT_LFS_SKIP_SMUDGE: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...extra.env },
      ...(extra.stdin ? { stdin: Stream.make(extra.stdin) } : {}),
    })
  const output = Effect.fnUntraced(function* (
    cwd: string,
    args: string[],
    reason: Reason,
    extra: { env?: Record<string, string>; stdin?: Uint8Array } = {},
  ) {
    const result = yield* run(cwd, args, extra)
    if (result.exitCode !== 0 || result.truncated)
      return yield* refuse(reason, result.stderr.toString("utf8").trim() || "A Git command in the fix checkout failed.")
    return result.text()
  })
  const resolve = Effect.fnUntraced(function* (cwd: string, revision: string) {
    const result = yield* run(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`])
    return result.exitCode === 0 ? result.text().trim() : undefined
  })
  const entry = (fixID: string, allowed: readonly State[]) => {
    const found = states.get(fixID)
    if (found && allowed.includes(found.state)) return Effect.succeed(found)
    return Effect.fail(refuse("state", "This fix is not waiting for that step. Nothing was changed."))
  }
  const prepare = (proposal: unknown) =>
    Effect.tryPromise({
      try: () => prepareFixProposal(proposal),
      catch: () => refuse("proposal", "The fix proposal could not be read."),
    }).pipe(
      Effect.flatMap((prepared) =>
        prepared.ok
          ? Effect.succeed(prepared)
          : Effect.fail(refuse("proposal", "The fix proposal is not a bounded text patch Vector can apply.")),
      ),
    )

  /** The source branch still points at the reviewed head, the base is a commit, and the checkout is at the head. */
  const checkHead = Effect.fnUntraced(function* (record: TaskIsolation.FixRecord, proposal: FixProposal) {
    // A linked worktree shares the repository's refs, so these read the user's branches without touching its checkout.
    const source = yield* resolve(record.directory, `refs/heads/${proposal.scope.sourceBranch}`)
    const base = yield* resolve(record.directory, proposal.base)
    const head = yield* resolve(record.directory, "HEAD")
    const problem =
      source !== proposal.head
        ? "The reviewed branch moved since the review. Nothing was changed."
        : base !== proposal.base
          ? "The proposal's base is not a commit in this repository."
          : head !== proposal.head
            ? "The fix checkout is no longer at the reviewed head. Nothing was changed."
            : undefined
    if (problem) return yield* refuse("head", problem)
    return record
  })

  /** Every path Git reports changed or untracked in the checkout (ignored files are not listed). */
  const changed = Effect.fnUntraced(function* (directory: string) {
    const entries = (yield* output(
      directory,
      [
        "-c",
        "core.untrackedCache=false",
        "status",
        "--porcelain=v2",
        "-z",
        "--no-renames",
        "--untracked-files=all",
        "--ignored=no",
      ],
      "worktree",
    ))
      .split("\0")
      .filter(Boolean)
    if (entries.some((item) => !item.startsWith("1 ") && !item.startsWith("? ")))
      return yield* refuse("worktree", "The fix checkout has unmerged or unexpected Git state.")
    return entries.map((item) => (item.startsWith("? ") ? item.slice(2) : item.split(" ").slice(8).join(" ")))
  })

  /**
   * The head's tree entry for each path, with every ancestor a tree. Each tree is listed by its own ID from its parent's
   * listing, so a name is a folder only where Git says so; a gitlink or a symbolic link is never descended into.
   */
  const headEntries = Effect.fnUntraced(function* (record: TaskIsolation.FixRecord, files: readonly string[]) {
    const listings = new Map<string, Map<string, TreeEntry>>()
    const list = Effect.fnUntraced(function* (tree: string) {
      const known = listings.get(tree)
      if (known) return known
      const parsed = new Map(
        (yield* output(record.directory, ["ls-tree", "-z", "--end-of-options", tree], "worktree"))
          .split("\0")
          .filter(Boolean)
          .map((line): [string, TreeEntry] => {
            const tab = line.indexOf("\t")
            const meta = line.slice(0, tab).split(" ")
            return [line.slice(tab + 1), { mode: meta[0], type: meta[1], oid: meta[2] }]
          }),
      )
      listings.set(tree, parsed)
      return parsed
    })
    // The tree `names` lead to from `tree`, or undefined once a name is absent; a link or a non-folder on the way refuses.
    const descend = (
      file: string,
      tree: string | undefined,
      names: readonly string[],
    ): Effect.Effect<string | undefined, Refused> =>
      !tree || !names.length
        ? Effect.succeed(tree)
        : list(tree).pipe(
            Effect.flatMap((listing) => {
              const item = listing.get(names[0])
              if (item?.mode === "120000")
                return Effect.fail(refuse("symlink", "A folder in this path is a symbolic link.", file))
              if (item && item.mode !== "040000")
                return Effect.fail(refuse("path", "A folder in this path is not a folder.", file))
              return descend(file, item?.oid, names.slice(1))
            }),
          )
    const root = (yield* output(
      record.directory,
      ["rev-parse", "--verify", "--end-of-options", `${record.head}^{tree}`],
      "head",
    )).trim()
    const found = yield* Effect.forEach(files, (file) =>
      Effect.gen(function* () {
        const parts = file.split("/")
        const tree = yield* descend(file, root, parts.slice(0, -1))
        return [file, tree ? (yield* list(tree)).get(parts[parts.length - 1]) : undefined] as const
      }),
    )
    return new Map(found)
  })

  const planFile = Effect.fnUntraced(function* (input: {
    record: TaskIsolation.FixRecord
    file: FixProposal["files"][number]
    entry: TreeEntry | undefined
    section: Section | undefined
    fileBytes: number
    /** What the earlier files' plans hold; this file's bytes are added once read. */
    held: { bytes: number }
  }) {
    const file = input.file
    const root = input.record.directory
    const target = path.join(root, file.path)
    const status: Change["status"] = file.preimage === null ? "added" : file.postimage === null ? "deleted" : "modified"
    // On disk: every ancestor a real folder, never a link, and the target a single-link regular file or absent. The walk
    // stops at the first link or non-folder, so nothing is looked up through one.
    const parts = file.path.split("/")
    const missing = (yield* Effect.forEach(parts.slice(0, -1).keys(), (index) =>
      Effect.gen(function* () {
        const directory = path.join(root, ...parts.slice(0, index + 1))
        const info = yield* optional(() => lstat(directory))
        if (!info) return [directory]
        if (info.isSymbolicLink())
          return yield* refuse("symlink", "A folder in this path is a symbolic link.", file.path)
        if (!info.isDirectory()) return yield* refuse("path", "A folder in this path is not a folder.", file.path)
        return []
      }),
    )).flat()
    const info = yield* optional(() => lstat(target))
    if (info?.isSymbolicLink()) return yield* refuse("symlink", "This file is a symbolic link.", file.path)
    if (
      (info && (!info.isFile() || !FSUtil.writableInside(root, target))) ||
      !FSUtil.contains(FSUtil.realpath(root), FSUtil.realpath(target))
    )
      return yield* refuse("path", "This path is not a single-link file inside the fix checkout.", file.path)
    if (status === "added" && (info || input.entry))
      return yield* refuse("path", "A file the proposal adds already exists.", file.path)
    // Git would not list an ignored added file, so the apply's changed-path check would refuse it after the consent is
    // spent, and SF-08 could not commit it. It is refused here instead, before any consent.
    const ignored =
      status === "added" ? (yield* run(root, ["check-ignore", "-q", "--no-index", "--", file.path])).exitCode : 1
    if (ignored === 0) return yield* refuse("path", "The proposal adds a file Git ignores.", file.path)
    if (ignored !== 1)
      return yield* refuse("worktree", "Git could not tell whether an added file is ignored.", file.path)
    if (status !== "added" && (!info || !input.entry))
      return yield* refuse("preimage", "A file the proposal changes is not in the reviewed head.", file.path)
    if (input.entry?.mode === "120000") return yield* refuse("symlink", "This file is a symbolic link.", file.path)
    if (
      input.entry &&
      (input.entry.type !== "blob" ||
        !["100644", "100755"].includes(input.entry.mode) ||
        (status === "deleted" && input.entry.mode !== "100644"))
    )
      return yield* refuse("path", "Only regular text files are changed.", file.path)
    if (info && info.size > input.fileBytes)
      return yield* refuse("limit", "This file is over the size limit.", file.path)
    if (info && input.held.bytes + info.size > TOTAL_BYTES) return yield* totalLimit()
    const observed =
      status === "added" ? undefined : yield* FileState.observe(target).pipe(Effect.mapError(isolated("worktree")))
    if (status !== "added" && !observed)
      return yield* refuse("preimage", "A file the proposal changes is gone.", file.path)
    if (observed && !observed.stamp.sha256)
      return yield* refuse("limit", "This file is too large to compare.", file.path)
    if (observed && `sha256:${observed.stamp.sha256}` !== file.preimage)
      return yield* refuse("preimage", "This file differs from the approved preimage.", file.path)
    // The checkout's bytes must be the committed blob's: an eol or filter conversion on checkout fails closed.
    if (observed && blobID(observed.bytes, input.record.head.length) !== input.entry?.oid)
      return yield* refuse("preimage", "The checkout's bytes differ from the committed file.", file.path)
    const before = observed ? decode(observed.bytes) : ""
    if (before === undefined) return yield* refuse("binary", "Only UTF-8 text files are changed.", file.path)
    const section = input.section
    if (!section) return yield* refuse("patch", "The patch has no section for this file.", file.path)
    if (
      section.index &&
      ((status === "added" ? !/^0+$/.test(section.index.before) : !input.entry?.oid.startsWith(section.index.before)) ||
        (section.index.mode !== undefined && section.index.mode !== input.entry?.mode))
    )
      return yield* refuse("patch", "The patch's index line names another blob or mode.", file.path)
    const result = applyHunks(before, section.hunks)
    if (result === undefined || (status === "deleted" && result !== ""))
      return yield* refuse("patch", "The patch does not apply exactly to this file.", file.path)
    const after = status === "deleted" ? undefined : encoder.encode(result)
    if (after && after.length > input.fileBytes)
      return yield* refuse("limit", "The changed file is over the size limit.", file.path)
    input.held.bytes += (observed?.bytes.length ?? 0) + (after?.length ?? 0)
    if (input.held.bytes > TOTAL_BYTES) return yield* totalLimit()
    if (after && `sha256:${sha256(after)}` !== file.postimage)
      return yield* refuse("postimage", "The patched file differs from the approved postimage.", file.path)
    if (
      section.index &&
      (after
        ? !blobID(after, input.record.head.length).startsWith(section.index.after)
        : !/^0+$/.test(section.index.after))
    )
      return yield* refuse("patch", "The patch's index line names another result.", file.path)
    const lines = section.hunks.flatMap((hunk) => hunk.lines)
    return {
      path: file.path,
      status,
      additions: lines.filter((line) => line.kind === "+").length,
      deletions: lines.filter((line) => line.kind === "-").length,
      target,
      ...(observed && info
        ? { before: { bytes: observed.bytes, mode: info.mode & 0o777, stamp: observed.stamp } }
        : {}),
      ...(after ? { after } : {}),
      mode: info ? info.mode & 0o777 : 0o644,
      missing,
    } satisfies Plan
  })

  /** What each file becomes, checked against the head, the disk, the approved digests and the patch, in path order. */
  const plan = Effect.fnUntraced(function* (record: TaskIsolation.FixRecord, proposal: FixProposal) {
    const limits = yield* TaskIsolation.Limits
    const entries = yield* headEntries(
      record,
      proposal.files.map((file) => file.path),
    )
    const patch = sections(proposal.patch)
    const held = { bytes: 0 }
    const planned = yield* Effect.forEach(proposal.files, (file) =>
      planFile({
        record,
        file,
        entry: entries.get(file.path),
        section: patch.get(file.path),
        fileBytes: limits.fileBytes,
        held,
      }),
    )
    // Each file's missing folders were found before anything is written, so two files in one new folder both list it.
    // The first file in path order creates it, and its rollback, the last to run, removes it.
    const plans = planned.map((item, index) => ({
      ...item,
      missing: item.missing.filter(
        (directory) => !planned.slice(0, index).some((earlier) => earlier.missing.includes(directory)),
      ),
    }))
    if (plans.some((item) => planned.some((other) => other.missing.includes(item.target))))
      return yield* refuse("path", "The proposal adds a file where it also adds a folder.")
    yield* guard(
      record.fixID,
      plans.map((item) => item.target),
    )
    return plans
  })
  // The owned-path guard every file tool runs, keyed by the fix ID: the fix's own checkout is writable; other tasks'
  // trees, every registry and checkout `.git`, and the launching checkout are not.
  const guard = (fixID: string, files: readonly string[]) =>
    assertWritable({ sessionID: fixID }, { files }).pipe(
      Effect.catchDefect((cause) =>
        Effect.fail(refuse("path", cause instanceof Error ? cause.message : "This path is protected.")),
      ),
    )

  /** Checks a placement before a write: its binding, the heads, a clean checkout, then every file. */
  const ready = Effect.fnUntraced(function* (fixID: string, proposal: FixProposal) {
    const record = yield* isolation.verifyFix(fixID).pipe(Effect.mapError(isolated("worktree")))
    yield* checkHead(record, proposal)
    if ((yield* changed(record.directory)).length)
      return yield* refuse("worktree", "The fix checkout has changes of its own. Nothing was changed.")
    return { record, plans: yield* plan(record, proposal) }
  })

  const reserve = Effect.fn("ReviewFix.reserve")(function* (request: { head: string }) {
    yield* linux
    const fixID = `fix_${randomUUID()}`
    const record = yield* isolation
      .reserveFix({ fixID, head: request.head })
      .pipe(Effect.mapError(isolated("worktree")))
    const placement: Placement = {
      fixID,
      worktree: record.directory,
      repository: FSUtil.realpath(record.parentDirectory),
      head: record.head,
    }
    states.set(fixID, { state: "proposal", placement })
    return placement
  })

  const preview = Effect.fn("ReviewFix.preview")(function* (request: { fixID: string; proposal: unknown }) {
    yield* linux
    return yield* mutex.withLock(request.fixID)(
      Effect.gen(function* () {
        const current = yield* entry(request.fixID, ["proposal", "preview"])
        const prepared = yield* prepare(request.proposal)
        const proposal = prepared.proposal
        const problem = scopeProblem(current.placement, proposal)
        if (problem) return yield* refuse("scope", problem)
        if (proposal.head !== current.placement.head)
          return yield* refuse("head", "The proposal is for another head than this fix checkout.")
        yield* isolation.startFix(request.fixID).pipe(Effect.mapError(isolated("worktree")))
        const checked = yield* ready(request.fixID, proposal)
        states.set(request.fixID, {
          ...current,
          state: "preview",
          digest: prepared.digest,
          patchDigest: prepared.patchDigest,
        })
        return {
          ...current.placement,
          base: proposal.base,
          sourceBranch: proposal.scope.sourceBranch,
          destinationBranch: proposal.scope.destinationBranch,
          digest: prepared.digest,
          patchDigest: prepared.patchDigest,
          patch: proposal.patch,
          files: checked.plans.map(change),
        } satisfies Preview
      }),
    )
  })

  const apply = Effect.fn("ReviewFix.apply")(function* (request: {
    fixID: string
    proposal: unknown
    consent: FixConsent
    policy: Policy
    actor: string
    observe?: (event: Event) => Effect.Effect<void>
  }) {
    yield* linux
    const observe = request.observe ?? (() => Effect.void)
    return yield* mutex.withLock(request.fixID)(
      Effect.gen(function* () {
        const current = yield* entry(request.fixID, ["preview"])
        const prepared = yield* prepare(request.proposal)
        if (prepared.digest !== current.digest || prepared.patchDigest !== current.patchDigest)
          return yield* refuse("digest", "This is not the proposal that was previewed. Nothing was changed.")
        const proposal = prepared.proposal
        const problem = scopeProblem(current.placement, proposal)
        if (problem) return yield* refuse("scope", problem)
        const plans = (yield* ready(request.fixID, proposal)).plans
        const targets = plans.map((item) => item.target)
        const journal: Step[] = []
        // The files' locks are taken before the consent is spent, so waiting for them spends nothing. Spending it and
        // attaching `undo` are one uninterruptible step: every refusal or interrupt before it leaves the consent unspent
        // and the fix in preview, and every failure or interrupt after it goes through `undo`, still under the locks.
        return yield* FileLock.withFiles(targets)(
          Effect.gen(function* () {
            // Again inside the files' locks, as every file tool repeats it.
            yield* guard(request.fixID, targets)
            return yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const receipt = yield* Effect.promise(() =>
                  request.policy.consume(request.consent, proposal, { kind: "apply" }, request.actor),
                )
                if (!receipt.ok) return yield* refuse(receipt.reason, `The consent was refused (${receipt.reason}).`)
                return yield* restore(
                  finish({ fixID: request.fixID, current, prepared, plans, journal, observe, receipt }),
                ).pipe(
                  Effect.onExit((exit) =>
                    Exit.isSuccess(exit) ? Effect.void : undo(request.fixID, current, journal, exit.cause),
                  ),
                )
              }),
            )
          }),
        )
      }),
    )
  })

  /** After the consent is spent: the writes, the checkout holding exactly the patch, then the applied record. */
  const finish = Effect.fnUntraced(function* (input: {
    fixID: string
    current: Entry
    prepared: { digest: string; patchDigest: string; proposal: FixProposal }
    plans: readonly Plan[]
    journal: Step[]
    observe: (event: Event) => Effect.Effect<void>
    receipt: { proposalDigest: string; actor: string; consumedAt: number }
  }) {
    const proposal = input.prepared.proposal
    if (input.receipt.proposalDigest !== input.prepared.digest)
      return yield* refuse("digest", "The consent is for another proposal.")
    yield* write(input.plans, input.journal, input.observe)
    const bound = yield* isolation.verifyFix(input.fixID).pipe(Effect.mapError(isolated("worktree")))
    const paths = new Set(yield* changed(bound.directory))
    if (
      (yield* resolve(bound.directory, "HEAD")) !== proposal.head ||
      paths.size !== proposal.files.length ||
      proposal.files.some((file) => !paths.has(file.path))
    )
      return yield* refuse("worktree", "The fix checkout holds other changes than the approved patch.")
    const record = yield* isolation
      .markFixApplied(input.fixID, {
        digest: input.prepared.digest,
        patchDigest: input.prepared.patchDigest,
        at: input.receipt.consumedAt,
      })
      .pipe(Effect.mapError(isolated("worktree")))
    states.set(input.fixID, { ...input.current, state: "applied" })
    return {
      fixID: input.fixID,
      worktree: record.directory,
      head: record.head,
      digest: input.prepared.digest,
      patchDigest: input.prepared.patchDigest,
      actor: input.receipt.actor,
      consumedAt: input.receipt.consumedAt,
      files: input.plans.map(change),
    } satisfies Applied
  })

  /**
   * Writes every plan in order, journalling each step before its write, then checks every result is its postimage.
   * Each step is uninterruptible from its intent to its write, so a cancel never lands while a write is in flight; only
   * the `wrote` hook between steps is interruptible.
   */
  const write = Effect.fnUntraced(function* (
    plans: readonly Plan[],
    journal: Step[],
    observe: (event: Event) => Effect.Effect<void>,
  ) {
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.forEach(
        plans,
        (item) =>
          Effect.gen(function* () {
            const now = yield* FileState.stamp(item.target).pipe(Effect.mapError(isolated("worktree")))
            if (!FileState.same(now, item.before?.stamp))
              return yield* refuse("preimage", "This file changed since the preview.", item.path)
            const step: Step = { plan: item, created: [] }
            journal.push(step)
            yield* observe({ type: "writing", file: item.path })
            yield* Effect.forEach(
              item.missing,
              (directory) =>
                io(() => mkdir(directory, { mode: 0o755 })).pipe(
                  Effect.tap(() => Effect.sync(() => step.created.push(directory))),
                ),
              { discard: true },
            )
            const after = item.after
            yield* io(() =>
              after
                ? TaskIsolation.place(item.target, { bytes: Buffer.from(after), mode: item.mode })
                : unlink(item.target),
            )
            return yield* restore(observe({ type: "wrote", file: item.path }))
          }),
        { discard: true },
      ),
    )
    const stamps = yield* Effect.forEach(plans, (item) =>
      FileState.stamp(item.target).pipe(Effect.mapError(isolated("worktree"))),
    )
    yield* plans.some((item, index) => (item.after ? stamps[index]?.sha256 !== sha256(item.after) : stamps[index]))
      ? refuse("postimage", "A written file is not the approved postimage.")
      : Effect.void
  })

  /**
   * After a spent consent fails or is cancelled: every written file goes back, then the placement is removed and the fix
   * forgotten, or kept and reported when the rollback or the removal is uncertain. The consent stays spent.
   */
  const undo = (fixID: string, current: Entry, journal: readonly Step[], cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      states.set(fixID, { ...current, state: Cause.hasInterrupts(cause) ? "cancelled" : "failed" })
      const problems = yield* rollback(journal)
      if (problems.length)
        return yield* isolation
          .retainFix(fixID, `The rollback was uncertain, so the checkout was kept: ${problems.join(" ")}`)
          .pipe(Effect.asVoid)
      const removed = yield* isolation.removeFix(fixID)
      return yield* removed.removed
        ? Effect.sync(() => {
            states.delete(fixID)
          })
        : Effect.logWarning("a fix checkout was kept after its rollback", { fixID, reason: removed.reason })
    }).pipe(
      Effect.catchCause((failure) => Effect.logWarning("a fix rollback needs attention", { fixID, cause: failure })),
    )

  /**
   * Undoes the journal newest first, and each step's folders deepest first. A file is put back only when it holds this
   * fix's bytes or was removed by it.
   */
  const rollback = Effect.fnUntraced(function* (journal: readonly Step[]) {
    const problems = yield* Effect.forEach(journal.toReversed(), (step) =>
      Effect.gen(function* () {
        const item = step.plan
        const before = item.before
        const restored = yield* Effect.gen(function* () {
          const now = yield* FileState.observe(item.target)
          const holds = (bytes: Uint8Array | undefined) =>
            bytes === undefined
              ? now === undefined
              : now !== undefined && Buffer.from(now.bytes).equals(Buffer.from(bytes))
          if (holds(before?.bytes)) return true
          if (!holds(item.after)) return false
          yield* io(() =>
            before
              ? TaskIsolation.place(item.target, { bytes: Buffer.from(before.bytes), mode: before.mode })
              : unlink(item.target),
          )
          return FileState.same(yield* FileState.stamp(item.target), before?.stamp)
        }).pipe(Effect.catch(() => Effect.succeed(false)))
        const folders = yield* Effect.forEach(step.created.toReversed(), (directory) =>
          io(() => rmdir(directory)).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          ),
        )
        return [
          ...(restored ? [] : [`${item.path} could not be put back.`]),
          ...folders.flatMap((removed) => (removed ? [] : [`A folder created for ${item.path} was not removed.`])),
        ]
      }),
    )
    return problems.flat()
  })

  /** The applied proposal again: the same digests as its preview, and still exactly this placement's scope. */
  const applied = Effect.fnUntraced(function* (current: Entry, input: unknown) {
    const prepared = yield* prepare(input)
    if (prepared.digest !== current.digest || prepared.patchDigest !== current.patchDigest)
      return yield* refuse("digest", "This is not the proposal that was applied. Nothing was run or changed.")
    const problem = scopeProblem(current.placement, prepared.proposal)
    if (problem) return yield* refuse("scope", problem)
    return prepared
  })

  /**
   * The checkout holds exactly the approved patch at the reviewed head: its binding, the heads, Git's changed paths
   * equal to the proposal's, and every file its postimage (or gone), read without following a link or opening anything
   * but a regular file. Checks had write access to the checkout, so nothing on disk is trusted before this.
   */
  const holds = Effect.fnUntraced(function* (fixID: string, proposal: FixProposal) {
    const record = yield* isolation.verifyFix(fixID).pipe(Effect.mapError(isolated("worktree")))
    yield* checkHead(record, proposal)
    const paths = new Set(yield* changed(record.directory))
    if (paths.size !== proposal.files.length || proposal.files.some((file) => !paths.has(file.path)))
      return yield* refuse(
        "worktree",
        "The fix checkout holds other changes than the approved patch, such as files a check left. Cancel the fix and apply it again.",
      )
    const limits = yield* TaskIsolation.Limits
    const total = { bytes: 0 }
    const files = yield* Effect.forEach(proposal.files, (file) =>
      held(record.directory, file, limits.fileBytes).pipe(
        Effect.tap((item) =>
          Effect.suspend(() => {
            total.bytes += item.bytes?.length ?? 0
            return total.bytes > TOTAL_BYTES ? Effect.fail(totalLimit()) : Effect.void
          }),
        ),
      ),
    )
    return { record, files }
  })

  /** Runs `effect` so that `cancel` can stop it before waiting for the fix's lock (checks and pushes are long). */
  const cancellable = <A, E, R>(fixID: string, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const stop = yield* Effect.sync(() => {
        const made = Deferred.makeUnsafe<void>()
        stops.set(fixID, (stops.get(fixID) ?? new Set()).add(made))
        if (cancelling.has(fixID)) Deferred.doneUnsafe(made, Exit.void)
        return made
      })
      return yield* effect.pipe(
        Effect.raceFirst(Deferred.await(stop).pipe(Effect.andThen(Effect.interrupt))),
        Effect.ensuring(
          Effect.sync(() => {
            const held = stops.get(fixID)
            held?.delete(stop)
            if (held && !held.size) stops.delete(fixID)
          }),
        ),
      )
    })

  /** Spends a step's consent in one uninterruptible step: its outcome is always known. */
  const spend = (request: Spend, proposal: FixProposal, operation: unknown, digest: string) =>
    Effect.promise(() => request.policy.consume(request.consent, proposal, operation, request.actor)).pipe(
      Effect.flatMap((receipt) =>
        !receipt.ok
          ? Effect.fail(refuse(receipt.reason, `The consent was refused (${receipt.reason}).`))
          : receipt.proposalDigest !== digest
            ? Effect.fail(refuse("digest", "The consent is for another proposal."))
            : Effect.succeed(receipt),
      ),
      Effect.uninterruptible,
    )

  // SF-08 remains the sole process owner for offline checks and sealed diagnostic adapters.
  const runScoped = Effect.fnUntraced(function* (input: ScopedCommand) {
    const collected = { chunks: [] as Uint8Array[], bytes: 0, truncated: false }
    const started = Date.now()
    const code = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(input.command, input.args, {
              shell: false,
              cwd: input.cwd,
              env: input.env,
              extendEnv: false,
              stdin: "ignore",
              detached: true,
              // The scope release's one signal, to the process group. bwrap's namespace init stays in that group (no
              // --new-session) and has no SIGTERM handler, so a SIGTERM during bwrap's setup, before the init has tied
              // its life to the outer bwrap's (PR_SET_PDEATHSIG), would leave it running; SIGKILL reaches it from
              // outside its PID namespace at any point, and its death ends every process in the namespace.
              killSignal: "SIGKILL",
            }),
          )
          .pipe(Effect.mapError(() => refuse("sandbox", "Checks not run: the sandbox could not start the command.")))
        const drain = Stream.runForEach(handle.all, (chunk) =>
          Effect.sync(() => {
            const room = input.outputBytes - collected.bytes
            if (room > 0) collected.chunks.push(room >= chunk.length ? chunk : chunk.slice(0, room))
            collected.bytes += chunk.length
            collected.truncated = collected.truncated || collected.bytes > input.outputBytes
          }),
        ).pipe(Effect.ignore)
        const exited = handle.exitCode.pipe(
          Effect.map((exit): number | null => exit),
          Effect.catch(() => Effect.succeed(null)),
        )
        return yield* Effect.all([drain, exited], { concurrency: "unbounded" }).pipe(
          Effect.map((both) => both[1]),
          Effect.timeoutOption(Duration.millis(input.timeoutMs)),
        )
      }),
    )
    return {
      exitCode: Option.getOrNull(code),
      timedOut: Option.isNone(code),
      output: Buffer.concat(collected.chunks).toString("utf8"),
      truncated: collected.truncated,
      durationMs: Date.now() - started,
    }
  })

  /** One command in the checks sandbox, through the spawner: its scope release is the only signaller of its group. */
  const execute = Effect.fnUntraced(function* (input: {
    root: string
    cwd: string
    command: string
    env: Record<string, string>
    platform: NodeJS.Platform
    timeoutMs: number
    outputBytes: number
  }) {
    const offline = Sandbox.offline({
      shell: "/bin/sh",
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      workspaceRoot: input.root,
      writes: "workspace",
      platform: input.platform,
    })
    if (offline.type === "unfiltered")
      return yield* refuse("sandbox", "Checks not run: this platform has no sandbox to run them without network.")
    if (offline.type === "refused")
      return yield* refuse(
        "sandbox",
        `Checks not run: Vector's sandbox without network is not available here (${(offline.reason ?? "the sandbox could not be applied").replace(/\.$/, "")}).`,
      )
    const wrapped = offline.wrapped
    return yield* runScoped({
      command: wrapped.command,
      args: wrapped.args,
      env: wrapped.env,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      outputBytes: input.outputBytes,
    })
  })

  const checks = Effect.fn("ReviewFix.checks")(function* (
    request: Spend & {
      fixID: string
      proposal: unknown
      operation: unknown
      observe?: (event: CheckEvent) => Effect.Effect<void>
    },
  ) {
    yield* linux
    const observe = request.observe ?? (() => Effect.void)
    return yield* cancellable(
      request.fixID,
      mutex.withLock(request.fixID)(
        Effect.gen(function* () {
          const current = yield* entry(request.fixID, ["applied", "committed"])
          const prepared = yield* applied(current, request.proposal)
          const proposal = prepared.proposal
          const context = (yield* RunnerContext)()
          if (context) return yield* refuse("context", context)
          const operation = yield* checksOperation(request.operation)
          const record = (yield* holds(request.fixID, proposal)).record
          const root = record.directory
          const env = environment(root)
          const commands = yield* Effect.forEach(operation.commands, (command) =>
            Effect.gen(function* () {
              const cwd = yield* folder(root, command.cwd)
              const binary = yield* dependencies(root, cwd, command.argv, env)
              const line = `exec ${[binary, ...command.argv.slice(1)].map(quote).join(" ")}`
              return { ...command, directory: cwd, line }
            }),
          )
          const platform = yield* SandboxPlatform
          yield* observe({ type: "probe" })
          const probe = yield* execute({
            root,
            cwd: root,
            command: "exit 0",
            env,
            platform,
            timeoutMs: 10_000,
            outputBytes: 4096,
          })
          if (probe.exitCode !== 0)
            return yield* refuse(
              "sandbox",
              `Checks not run: Vector's sandbox could not run a command here (${probe.output.trim().split("\n")[0] || (probe.timedOut ? "it timed out" : `exit ${probe.exitCode}`)}).`,
            )
          const receipt = yield* spend(request, proposal, operation, prepared.digest)
          const binding = operationDigest(operation)
          const results: CheckResult[] = []
          const outcome: { aborted?: "head" | "worktree" } = {}
          const loop = (index: number): Effect.Effect<void, Refused> =>
            Effect.gen(function* () {
              const command = commands[index]
              if (!command) return
              if (index > 0) {
                const problem = yield* holds(request.fixID, proposal).pipe(
                  Effect.as(undefined),
                  Effect.catch((cause) =>
                    Effect.succeed<"head" | "worktree">(cause.reason === "head" ? "head" : "worktree"),
                  ),
                )
                if (problem) {
                  outcome.aborted = problem
                  return
                }
              }
              yield* observe({ type: "started", index })
              const ran = yield* execute({
                root,
                cwd: command.directory,
                command: command.line,
                env,
                platform,
                timeoutMs: operation.timeoutMs,
                outputBytes: operation.outputBytes,
              })
              const result: CheckResult = { argv: command.argv, cwd: command.cwd, ...ran }
              results.push(result)
              yield* observe({ type: "finished", index, result })
              yield* loop(index + 1)
            })
          yield* loop(0).pipe(
            Effect.onExit((exit) =>
              isolation
                .recordFixChecks(request.fixID, {
                  operation: binding,
                  at: receipt.consumedAt,
                  results: results.map((item) => ({
                    argv: [...item.argv],
                    cwd: item.cwd,
                    exitCode: item.exitCode,
                    timedOut: item.timedOut,
                    truncated: item.truncated,
                    durationMs: item.durationMs,
                  })),
                  ...(outcome.aborted
                    ? { aborted: outcome.aborted }
                    : Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
                      ? { aborted: "cancelled" as const }
                      : {}),
                })
                .pipe(
                  Effect.asVoid,
                  Effect.catchCause((cause) =>
                    Effect.logWarning("a fix check run was not recorded", { fixID: request.fixID, cause }),
                  ),
                ),
            ),
          )
          const listed = new Set(proposal.files.map((file) => file.path))
          const leftovers = yield* changed(root).pipe(
            Effect.map((paths) => paths.filter((item) => !listed.has(item)).slice(0, 32)),
            Effect.catch(() => Effect.succeed<string[]>([])),
          )
          return {
            fixID: request.fixID,
            head: proposal.head,
            digest: prepared.digest,
            operation: binding,
            actor: receipt.actor,
            consumedAt: receipt.consumedAt,
            results,
            ...(outcome.aborted ? { aborted: outcome.aborted } : {}),
            ...(leftovers.length ? { leftovers } : {}),
            passed:
              !outcome.aborted &&
              results.length === commands.length &&
              results.every((item) => item.exitCode === 0 && !item.timedOut),
          } satisfies Checked
        }),
      ),
    )
  })

  const commit = Effect.fn("ReviewFix.commit")(function* (
    request: Spend & { fixID: string; proposal: unknown; operation: unknown; identity: Identity },
  ) {
    yield* linux
    return yield* mutex.withLock(request.fixID)(
      Effect.gen(function* () {
        const current = yield* entry(request.fixID, ["applied"])
        const prepared = yield* applied(current, request.proposal)
        const proposal = prepared.proposal
        const operation = yield* commitOperation(request.operation)
        if (!person(request.identity))
          return yield* refuse("operation", "The commit identity is not a plain name and email address.")
        const identity = { name: request.identity.name, email: request.identity.email }
        const record = (yield* holds(request.fixID, proposal)).record
        const branch = proposal.scope.destinationBranch
        const ref = `refs/heads/${branch}`
        if ((yield* run(record.directory, ["check-ref-format", ref])).exitCode !== 0)
          return yield* refuse("destination", "The destination branch is not a valid branch name.")
        if (yield* resolve(record.directory, ref))
          return yield* refuse("destination", "The destination branch already exists. Nothing was committed.")
        const targets = proposal.files.map((file) => path.join(record.directory, file.path))
        // As in apply: the locks are taken before the consent is spent, and the bytes committed are the ones read and
        // checked against the approved postimages inside them, never read again.
        return yield* FileLock.withFiles(targets)(
          Effect.gen(function* () {
            const files = (yield* holds(request.fixID, proposal)).files
            return yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const receipt = yield* spend(request, proposal, operation, prepared.digest)
                const built = yield* restore(
                  build({ record, proposal, files, message: operation.message, identity, at: receipt.consumedAt }),
                )
                yield* FileLock.forTree(record.gitCommonDirectory)(
                  output(
                    record.directory,
                    ["update-ref", "-m", `vector fix ${request.fixID}`, ref, built.sha, "0".repeat(record.head.length)],
                    "destination",
                  ),
                )
                yield* isolation
                  .markFixCommitted(request.fixID, { sha: built.sha, branch, tree: built.tree, at: receipt.consumedAt })
                  .pipe(
                    Effect.mapError(isolated("worktree")),
                    Effect.tapError(() => unref(request.fixID, current, record, ref, built.sha)),
                  )
                states.set(request.fixID, { ...current, state: "committed", commit: { sha: built.sha, branch } })
                return {
                  fixID: request.fixID,
                  head: proposal.head,
                  digest: prepared.digest,
                  commit: built.sha,
                  tree: built.tree,
                  branch,
                  author: identity,
                  actor: receipt.actor,
                  consumedAt: receipt.consumedAt,
                } satisfies Committed
              }),
            )
          }),
        )
      }),
    )
  })

  /**
   * The commit's tree, from the head's tree and the verified postimages, in a private index; then the commit, checked
   * to be exactly that tree on the head with exactly the proposal's paths changed. Only inert objects exist until the
   * caller creates the branch. No hook runs: commit-tree runs none, and Git's hooks path is the null device.
   */
  const build = Effect.fnUntraced(function* (input: {
    record: TaskIsolation.FixRecord
    proposal: FixProposal
    files: readonly Held[]
    message: string
    identity: Identity
    at: number
  }) {
    const record = input.record
    const index = TaskIsolation.fixCommitIndex(record)
    const env = { GIT_INDEX_FILE: index }
    return yield* Effect.gen(function* () {
      const entries = yield* headEntries(
        record,
        input.proposal.files.map((file) => file.path),
      )
      const lines = yield* Effect.forEach(input.files, (file) =>
        Effect.gen(function* () {
          if (!file.bytes) return `0 ${"0".repeat(record.head.length)}\t${file.path}\0`
          const oid = (yield* output(record.directory, ["hash-object", "-w", "--no-filters", "--stdin"], "worktree", {
            stdin: file.bytes,
          })).trim()
          if (oid !== blobID(file.bytes, record.head.length))
            return yield* refuse("postimage", "Git stored other bytes than the approved postimage.", file.path)
          return `${entries.get(file.path)?.mode ?? "100644"} ${oid}\t${file.path}\0`
        }),
      )
      yield* output(record.directory, ["read-tree", "--end-of-options", record.head], "worktree", { env })
      yield* output(record.directory, ["update-index", "-z", "--index-info"], "worktree", {
        env,
        stdin: encoder.encode(lines.join("")),
      })
      const tree = (yield* output(record.directory, ["write-tree"], "worktree", { env })).trim()
      const date = `@${Math.floor(input.at / 1000)} +0000`
      const sha = (yield* output(
        record.directory,
        ["-c", "commit.gpgSign=false", "-c", "i18n.commitEncoding=UTF-8", "commit-tree", "--no-gpg-sign"].concat([
          tree,
          "-p",
          record.head,
          "-F",
          "-",
        ]),
        "worktree",
        {
          env: {
            GIT_AUTHOR_NAME: input.identity.name,
            GIT_AUTHOR_EMAIL: input.identity.email,
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_NAME: input.identity.name,
            GIT_COMMITTER_EMAIL: input.identity.email,
            GIT_COMMITTER_DATE: date,
          },
          stdin: encoder.encode(input.message),
        },
      )).trim()
      const shape = (yield* output(record.directory, ["show", "-s", "--format=%T %P", sha], "worktree")).trim()
      const expected = new Map(
        input.proposal.files.map((file) => [
          file.path,
          file.preimage === null ? "A" : file.postimage === null ? "D" : "M",
        ]),
      )
      const listed = (yield* output(
        record.directory,
        ["diff-tree", "-r", "-z", "--no-renames", "--name-status", "--end-of-options", record.head, sha],
        "worktree",
      ))
        .split("\0")
        .filter(Boolean)
      const pairs = listed.flatMap((item, at) => (at % 2 === 0 ? [[item, listed[at + 1]] as const] : []))
      if (
        shape !== `${tree} ${record.head}` ||
        pairs.length !== expected.size ||
        pairs.some((pair) => expected.get(pair[1]) !== pair[0])
      )
        return yield* refuse("worktree", "The commit Git built is not exactly the approved patch on the head.")
      return { sha, tree }
    }).pipe(Effect.ensuring(io(() => rm(index, { force: true })).pipe(Effect.ignore)))
  })

  /** After a branch was created but not recorded: deleted again only if it still names the commit, else kept. */
  const unref = (fixID: string, current: Entry, record: TaskIsolation.FixRecord, ref: string, sha: string) =>
    FileLock.forTree(record.gitCommonDirectory ?? record.parentDirectory)(
      run(record.directory, ["update-ref", "-d", ref, sha]),
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.gen(function* () {
              states.set(fixID, { ...current, state: "failed" })
              yield* isolation.retainFix(
                fixID,
                `The commit ${sha} was made on ${ref}, but could not be recorded or removed; the checkout was kept.`,
              )
            }),
      ),
      Effect.catchCause((cause) => Effect.logWarning("a fix commit needs attention", { fixID, ref, sha, cause })),
    )

  const push = Effect.fn("ReviewFix.push")(function* (
    request: Spend & { fixID: string; proposal: unknown; operation: unknown },
  ) {
    yield* linux
    return yield* cancellable(
      request.fixID,
      mutex.withLock(request.fixID)(
        Effect.gen(function* () {
          const current = yield* entry(request.fixID, ["committed"])
          const made = current.commit
          if (!made) return yield* refuse("state", "This fix has no commit to push.")
          const prepared = yield* applied(current, request.proposal)
          const proposal = prepared.proposal
          const operation = yield* pushOperation(request.operation, made.sha)
          const record = yield* isolation.verifyFix(request.fixID).pipe(Effect.mapError(isolated("worktree")))
          yield* checkHead(record, proposal)
          const ref = `refs/heads/${made.branch}`
          if ((yield* resolve(record.directory, ref)) !== made.sha)
            return yield* refuse("destination", "The destination branch no longer names the fix's commit.")
          const refspec = `${made.sha}:${ref}`
          yield* remoteProblem(record, operation.remote, made.branch, made.sha)
          const receipt = yield* spend(request, proposal, operation, prepared.digest)
          const result = yield* run(
            record.directory,
            [
              "-c",
              "push.followTags=false",
              "-c",
              "push.gpgSign=false",
              "-c",
              "push.recurseSubmodules=no",
              "-c",
              "push.negotiate=false",
              "-c",
              "push.pushOption=",
              "-c",
              "protocol.allow=never",
              "-c",
              `protocol.${operation.remote.startsWith("file:") ? "file" : "https"}.allow=always`,
              "push",
              // A repository on this computer runs its own receive hooks (pre-receive, update, post-receive,
              // reference-transaction) with this process's environment; `-c` here does not reach receive-pack over the
              // local transport, so its command line carries the null hooks path itself.
              ...(operation.remote.startsWith("file:")
                ? [`--receive-pack=git -c core.hooksPath=${os.devNull} receive-pack`]
                : []),
              "--porcelain",
              "--no-verify",
              "--no-signed",
              "--no-follow-tags",
              "--atomic",
              "--recurse-submodules=no",
              // A create-only lease: the push lands only where the remote has no such branch, never forced over one.
              `--force-with-lease=${ref}:`,
              "--",
              operation.remote,
              refspec,
            ],
            { env: { GIT_TERMINAL_PROMPT: "0" } },
          ).pipe(Effect.timeoutOption(Duration.millis(FIX_LIMITS.commandMs)))
          const landed =
            Option.isSome(result) &&
            result.value.exitCode === 0 &&
            result.value
              .text()
              .split("\n")
              .some((line) => {
                const fields = line.split("\t")
                return (fields[0] === "*" || fields[0] === "=") && fields[1] === refspec
              })
          if (!landed)
            return yield* refuse(
              "push",
              "The push did not complete, so the remote may or may not hold the branch. The consent was spent: pushing again needs a new approval.",
            )
          yield* isolation
            .markFixPushed(request.fixID, {
              remote: operation.remote,
              commit: made.sha,
              ref,
              mode: operation.mode,
              at: receipt.consumedAt,
            })
            .pipe(Effect.mapError(isolated("worktree")))
          states.set(request.fixID, { ...current, state: "pushed" })
          return {
            fixID: request.fixID,
            commit: made.sha,
            remote: operation.remote,
            ref,
            mode: operation.mode,
            actor: receipt.actor,
            consumedAt: receipt.consumedAt,
          } satisfies Pushed
        }),
      ),
    )
  })

  /**
   * Why the approved remote may not be pushed to, checked without connecting to it: Git must use exactly that address
   * (no insteadOf or pushInsteadOf rewrite, and no configured remote named like it, whose url or pushurl Git would use
   * instead), Vector Local must allow it, and a remote on this computer must be a bare repository apart from this one,
   * its checkout and Vector's data, whose default branch is not the destination and which has no destination branch at
   * another commit. An https remote's branches are not read before the consent is spent (that would connect); its
   * create-only lease refuses an existing branch instead.
   */
  const remoteProblem = Effect.fnUntraced(function* (
    record: TaskIsolation.FixRecord,
    remote: string,
    branch: string,
    sha: string,
  ) {
    const url = (yield* run(record.directory, ["ls-remote", "--get-url", "--", remote])).text().trim()
    if (url !== remote)
      yield* refuse("remote", "Git would push to another address than the approved remote (a url rewrite).")
    // `-z` gives each entry as its key, a newline and its value, so a key with a space in it (a url subsection) parses.
    const entries = (pattern: string) =>
      run(record.directory, ["config", "-z", "--get-regexp", pattern]).pipe(
        Effect.map((result) =>
          result
            .text()
            .split("\0")
            .filter(Boolean)
            .map((item) => {
              const at = item.indexOf("\n")
              return at < 0 ? { key: item, value: "" } : { key: item.slice(0, at), value: item.slice(at + 1) }
            }),
        ),
      )
    if ((yield* entries("^url\\..*\\.pushinsteadof$")).some((item) => item.value && remote.startsWith(item.value)))
      yield* refuse("remote", "Git would push to another address than the approved remote (a push rewrite).")
    // A remote's name is the subsection between `remote.` and the last dot, kept as configured.
    if (
      (yield* entries("^remote\\..*\\.(url|pushurl)$")).some(
        (item) => item.key.slice("remote.".length, item.key.lastIndexOf(".")) === remote,
      )
    )
      yield* refuse(
        "remote",
        "A Git remote of this repository is named like the approved address, so Git could push elsewhere.",
      )
    const blocked = yield* refusal(["push", "--", remote, `${sha}:refs/heads/${branch}`], (args) =>
      run(record.directory, args).pipe(Effect.map((result) => (result.exitCode === 0 ? result.text() : ""))),
    )
    if (blocked) yield* refuse("remote", blocked)
    if (remote.startsWith("file:")) yield* localRemoteProblem(record, remote, branch, sha)
  })

  /** For a repository on this computer, read from its own files (it opens no transport); its real path when it may. */
  const localRemoteProblem = Effect.fnUntraced(function* (
    record: TaskIsolation.FixRecord,
    remote: string,
    branch: string,
    sha: string,
  ) {
    const target = yield* optional(() => realpath(remote.slice("file://".length)))
    if (!target) return yield* refuse("remote", "The approved remote repository does not exist.")
    const own = [record.parentDirectory, record.gitCommonDirectory ?? record.parentDirectory, Global.Path.data]
    if (own.some((item) => FSUtil.overlaps(FSUtil.realpath(item), target)))
      return yield* refuse("remote", "The approved remote is this repository, its fix checkout or Vector's data.")
    const bare = (yield* run(record.directory, [`--git-dir=${target}`, "rev-parse", "--is-bare-repository"])).text()
    if (bare.trim() !== "true") return yield* refuse("remote", "The approved remote is not a bare Git repository.")
    const head = (yield* run(record.directory, [`--git-dir=${target}`, "symbolic-ref", "-q", "HEAD"])).text().trim()
    if (head === `refs/heads/${branch}`)
      return yield* refuse("destination", "The destination is the remote's default branch. Nothing was pushed.")
    const there = yield* run(record.directory, [
      `--git-dir=${target}`,
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `refs/heads/${branch}^{commit}`,
    ])
    if (there.exitCode === 0 && there.text().trim() !== sha)
      return yield* refuse(
        "destination",
        "The remote has the destination branch at another commit. Nothing was pushed.",
      )
    return target
  })

  // Stops a running check or push first (the spawner's scope release ends its process group), then removes the
  // placement under the fix's lock. A commit made on the destination branch, and a pushed branch, are kept.
  const cancel = Effect.fn("ReviewFix.cancel")(function* (fixID: string) {
    yield* linux
    yield* Effect.sync(() => {
      cancelling.add(fixID)
      stops.get(fixID)?.forEach((stop) => Deferred.doneUnsafe(stop, Exit.void))
    })
    return yield* mutex
      .withLock(fixID)(
        Effect.gen(function* () {
          const result = yield* isolation.removeFix(fixID).pipe(Effect.mapError(isolated("worktree")))
          const current = states.get(fixID)
          if (result.removed) states.delete(fixID)
          if (!result.removed && current) states.set(fixID, { ...current, state: "cancelled" })
          return { fixID, ...result } satisfies Cleanup
        }),
      )
      .pipe(Effect.ensuring(Effect.sync(() => cancelling.delete(fixID))))
  })

  const state = Effect.fn("ReviewFix.state")(function* (fixID: string) {
    yield* linux
    return states.get(fixID)?.state
  })

  /** This project's fix placements, kept ones included, each protected again. */
  const placements = Effect.fn("ReviewFix.placements")(function* () {
    yield* linux
    return yield* isolation.fixes().pipe(Effect.mapError(isolated("worktree")))
  })

  const diagnostics = makeDiagnosticAdapters(runScoped, SandboxPlatform)
  return { reserve, preview, apply, checks, commit, push, cancel, state, placements, diagnostics }
})

/** Why the proposal's scope is not exactly this local placement and its repository, which may not overlap. */
function scopeProblem(placement: Placement, proposal: FixProposal) {
  const scope = proposal.scope
  if (scope.kind !== "local") return "Only a local fix is applied here; a pull request fix goes through @vector."
  const worktree = FSUtil.realpath(placement.worktree)
  if (
    scope.worktree !== placement.worktree ||
    scope.repository !== placement.repository ||
    FSUtil.contains(placement.repository, worktree) ||
    FSUtil.contains(worktree, placement.repository)
  )
    return "The proposal names another repository or fix checkout."
  return undefined
}

// The exact operations the executor runs, checked before any consent is spent, from one copy that is also what the
// consent is spent with. Core's contract (fix-proposal.ts operationValue) checks them again at consume.
const operationCopy = (input: unknown) =>
  Effect.try({
    try: () => structuredClone(input),
    catch: () => refuse("operation", "The operation is not plain data."),
  })
const SAFE_PATH = /^[A-Za-z0-9_@+.,/-]+$/
const relativePath = (value: string) =>
  value.length <= FIX_LIMITS.pathBytes &&
  SAFE_PATH.test(value) &&
  !value.startsWith("-") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
const bounded = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max
const PREFIXES = CHECK_COMMANDS.map((command) => command.split(" "))

/**
 * A checks operation: 1 to 16 commands, each a CHECK_COMMANDS argv followed only by paths and test names (never a
 * flag, so VS-30's coverage commands are refused while its runtime key stays unapplied) in the checkout's root or a
 * folder under it, the network off, and time and output within FIX_LIMITS.
 */
export const checksOperation = (input: unknown) =>
  operationCopy(input).pipe(
    Effect.flatMap((copy) => {
      const refused = Effect.fail(
        refuse("operation", "Only the project's test and typecheck commands, without flags, run as checks."),
      )
      if (
        !exact(copy, ["kind", "commands", "network", "timeoutMs", "outputBytes"]) ||
        copy.kind !== "checks" ||
        copy.network !== "off" ||
        !bounded(copy.timeoutMs, FIX_LIMITS.commandMs) ||
        !bounded(copy.outputBytes, FIX_LIMITS.outputBytes) ||
        !Array.isArray(copy.commands) ||
        !copy.commands.length ||
        copy.commands.length > FIX_LIMITS.commands
      )
        return refused
      const items: readonly unknown[] = copy.commands
      const commands = items.flatMap((item): Command[] => {
        if (!exact(item, ["argv", "cwd"]) || typeof item.cwd !== "string" || !Array.isArray(item.argv)) return []
        const cwd = item.cwd
        const words: readonly unknown[] = item.argv
        const argv = words.filter(
          (word): word is string =>
            typeof word === "string" && word.length > 0 && word.length <= 1_024 && word.isWellFormed(),
        )
        if (
          argv.length !== words.length ||
          !argv.length ||
          argv.length > FIX_LIMITS.arguments ||
          encoder.encode(JSON.stringify(argv)).length > FIX_LIMITS.commandBytes ||
          !(cwd === "." || relativePath(cwd))
        )
          return []
        const prefix = PREFIXES.find((words) => words.every((word, index) => argv[index] === word))
        if (
          !prefix ||
          !argv.slice(prefix.length).every((word) => word === "." || word === "./..." || relativePath(word))
        )
          return []
        return [Object.freeze({ argv: Object.freeze(argv), cwd })]
      })
      if (commands.length !== items.length) return refused
      return Effect.succeed(
        Object.freeze({
          kind: "checks",
          commands: Object.freeze(commands),
          network: "off",
          timeoutMs: copy.timeoutMs,
          outputBytes: copy.outputBytes,
        } satisfies ChecksOperation),
      )
    }),
  )

/** The checks binding core's consent compares (fix-proposal.ts operationValue), as a digest. */
const operationDigest = (operation: ChecksOperation) =>
  `sha256:${sha256(
    encoder.encode(
      JSON.stringify([
        "checks",
        operation.commands.map((command) => [command.cwd, [...command.argv]]),
        operation.network,
        operation.timeoutMs,
        operation.outputBytes,
      ]),
    ),
  )}`

export const commitOperation = (input: unknown) =>
  operationCopy(input).pipe(
    Effect.flatMap((copy) =>
      exact(copy, ["kind", "message"]) &&
      copy.kind === "commit" &&
      typeof copy.message === "string" &&
      copy.message.length > 0 &&
      copy.message.isWellFormed() &&
      !copy.message.includes("\0") &&
      encoder.encode(copy.message).length <= FIX_LIMITS.messageBytes
        ? Effect.succeed(Object.freeze({ kind: "commit" as const, message: copy.message }))
        : Effect.fail(refuse("operation", "The commit message is not plain text within its limit.")),
    ),
  )

/** A push of exactly the fix's commit, to an https remote or a repository on this computer named by absolute path. */
export const pushOperation = (input: unknown, sha: string) =>
  operationCopy(input).pipe(
    Effect.flatMap((copy) => {
      if (
        !exact(copy, ["kind", "remote", "commit", "mode"]) ||
        copy.kind !== "push" ||
        copy.commit !== sha ||
        (copy.mode !== "branch" && copy.mode !== "draft-pr") ||
        typeof copy.remote !== "string" ||
        copy.remote.length > 2_048
      )
        return Effect.fail(refuse("operation", "The push is not of this fix's commit, or names no remote."))
      const remote = copy.remote
      const local = remote.startsWith("file:///") ? remote.slice("file://".length) : undefined
      if (
        local === undefined
          ? !/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+$/.test(remote)
          : !/^\/[A-Za-z0-9_./-]+$/.test(local) || path.posix.normalize(local) !== local || local.endsWith("/")
      )
        return Effect.fail(refuse("operation", "The remote is not an https address or an absolute file:/// path."))
      return Effect.succeed(Object.freeze({ kind: "push" as const, remote, commit: sha, mode: copy.mode }))
    }),
  )

function exact(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.getPrototypeOf(input) === Object.prototype &&
    Object.keys(input).length === keys.length &&
    keys.every((key) => Object.hasOwn(input, key))
  )
}

/** A plain name and email address, as Git writes them into a commit: no angle bracket, line break or NUL. */
export function person(input: unknown): input is Identity {
  const plain = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    encoder.encode(value).length <= 256 &&
    value.isWellFormed() &&
    value.trim() === value &&
    !/[<>\0\r\n]/.test(value)
  return (
    exact(input, ["name", "email"]) && plain(input.name) && plain(input.email) && /^[^\s@]+@[^\s@]+$/.test(input.email)
  )
}

/**
 * The checks' environment, built from nothing: absolute PATH folders outside the checkout, a home and caches in the
 * sandbox's private /tmp (so no dotfile or tool login of the user's is read), CI=1 and the toolchains' offline
 * settings. No variable of Vector's or the user's is passed, so no provider key or token reaches a check.
 */
function environment(root: string): Record<string, string> {
  const real = FSUtil.realpath(root)
  const search = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(
      (entry) =>
        path.isAbsolute(entry) && !FSUtil.contains(root, entry) && !FSUtil.contains(real, FSUtil.realpath(entry)),
    )
  return {
    PATH: Array.from(new Set(search)).join(path.delimiter),
    HOME: "/tmp",
    TMPDIR: "/tmp",
    XDG_CACHE_HOME: "/tmp/.cache",
    XDG_CONFIG_HOME: "/tmp/.config",
    XDG_DATA_HOME: "/tmp/.local/share",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    TERM: "dumb",
    CI: "1",
    NO_COLOR: "1",
    CARGO_NET_OFFLINE: "true",
    GOPROXY: "off",
    GOTOOLCHAIN: "local",
    npm_config_offline: "true",
    PIP_NO_INDEX: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  }
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** A check's folder: `.` or a real folder of the checkout, reached through no link. */
const folder = (root: string, cwd: string) =>
  Effect.gen(function* () {
    const parts = cwd === "." ? [] : cwd.split("/")
    yield* Effect.forEach(
      parts.keys(),
      (index) =>
        Effect.gen(function* () {
          const info = yield* optional(() => lstat(path.join(root, ...parts.slice(0, index + 1))))
          if (info?.isSymbolicLink())
            yield* refuse("symlink", "A check's folder is a symbolic link or inside one.", cwd)
          if (!info?.isDirectory()) yield* refuse("path", "A check's folder is not a folder in the checkout.", cwd)
        }),
      { discard: true },
    )
    const directory = path.join(root, ...parts)
    if (!FSUtil.contains(FSUtil.realpath(root), FSUtil.realpath(directory)))
      return yield* refuse("path", "A check's folder is outside the fix checkout.", cwd)
    return directory
  })

const unavailable = (detail: string) => refuse("dependencies", `Checks not run: dependencies unavailable (${detail}).`)
const JAVASCRIPT = new Set(["bun", "npm", "pnpm", "yarn"])
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const MANIFEST_BYTES = 1024 * 1024

/**
 * The program a check runs, resolved on the check's PATH, and whether what it builds from is in the checkout. Nothing
 * is installed or fetched, and the check's home is the sandbox's empty /tmp, so the user's package caches and toolchain
 * managers are not visible. A JavaScript runner needs the installed dependencies its nearest package.json declares (a
 * node_modules folder or Yarn's .pnp.cjs there or at the checkout's root; a fresh fix checkout has none). Cargo needs a
 * toolchain that is not rustup's proxy, and registry or git packages vendored; go needs every required module
 * vendored. pytest is checked for its program only.
 */
const dependencies = (root: string, cwd: string, argv: readonly string[], env: Record<string, string>) =>
  Effect.gen(function* () {
    const program = argv[0] ?? ""
    const binary = which(program, { PATH: env.PATH })
    if (!binary || !path.isAbsolute(binary) || FSUtil.contains(FSUtil.realpath(root), FSUtil.realpath(binary)))
      return yield* unavailable(`${program} is not installed`)
    const missing = JAVASCRIPT.has(program)
      ? yield* javascriptMissing(root, cwd)
      : program === "cargo"
        ? yield* cargoMissing(root, cwd, binary)
        : program === "go"
          ? yield* goMissing(root, cwd)
          : undefined
    if (missing) return yield* unavailable(missing)
    return binary
  })

const javascriptMissing = (root: string, cwd: string) =>
  Effect.gen(function* () {
    const manifest = yield* nearest(root, cwd, "package.json")
    if (!manifest) return undefined
    const parsed = decodeJson(manifest.text)
    if (Option.isNone(parsed) || !exactObject(parsed.value)) return `${manifest.relative} could not be read`
    const value = parsed.value
    const declared = DEPENDENCY_FIELDS.some((field) => {
      const item = value[field]
      return exactObject(item) && Object.keys(item).length > 0
    })
    if (!declared) return undefined
    const installed = yield* Effect.forEach([manifest.directory, root], (directory) =>
      Effect.all([
        optional(() => lstat(path.join(directory, "node_modules"))),
        optional(() => lstat(path.join(directory, ".pnp.cjs"))),
      ]).pipe(Effect.map((both) => both[0]?.isDirectory() === true || both[1]?.isFile() === true)),
    )
    if (installed.some(Boolean)) return undefined
    return `${manifest.relative} declares dependencies, and none are installed in the fix checkout`
  })

// A Cargo.lock package from a registry or Git has a `source` line; a path package has none.
const LOCK_SOURCE = /^source = "/m

const cargoMissing = (root: string, cwd: string, binary: string) =>
  Effect.gen(function* () {
    if (yield* rustupProxy(binary))
      return "cargo here is rustup's proxy, and the toolchains rustup keeps in your home folder are not visible to checks"
    const lock = yield* nearest(root, cwd, "Cargo.lock")
    const manifest = lock ? undefined : yield* nearest(root, cwd, "Cargo.toml")
    const named = lock
      ? { file: lock, external: LOCK_SOURCE.test(lock.text) }
      : manifest
        ? { file: manifest, external: cargoExternal(manifest.text) }
        : undefined
    if (!named?.external) return undefined
    // A vendor folder beside the lockfile or manifest, or a Cargo config in the checkout that replaces a source: cargo
    // itself decides whether that covers every package.
    const vendor = yield* optional(() => lstat(path.join(named.file.directory, "vendor")))
    if (vendor?.isDirectory()) return undefined
    const configs = yield* Effect.forEach([".cargo/config.toml", ".cargo/config"], (name) => nearest(root, cwd, name))
    if (configs.some((item) => item !== undefined && /^\s*replace-with\s*=/m.test(item.text))) return undefined
    return `${named.file.relative} names registry or git packages, and the checkout does not vendor them`
  })

/** Whether `binary` is one of rustup's proxies: rustup itself under another name, through a link or a hard link. */
const rustupProxy = (binary: string) =>
  Effect.gen(function* () {
    if (["rustup", "rustup-init"].includes(path.basename(FSUtil.realpath(binary)))) return true
    const both = yield* Effect.all([
      optional(() => stat(binary)),
      optional(() => stat(path.join(path.dirname(binary), "rustup"))),
    ])
    return both[0] !== undefined && both[1] !== undefined && both[0].dev === both[1].dev && both[0].ino === both[1].ino
  })

const DEPENDENCY_TABLE = /^(?:workspace\.|target\..+\.)?(?:dev-|build-)?dependencies$/
const DEPENDENCY_ITEM_TABLE = /^(?:target\..+\.)?(?:dev-|build-)?dependencies\.[^.]+$/

/**
 * Whether a Cargo.toml, read line by line rather than as TOML, declares a package from a registry or Git: an entry of
 * a dependency table that names no `path` (or `workspace = true`, which the workspace's lockfile decides), or a
 * dependency's own `[dependencies.<name>]` table.
 */
function cargoExternal(text: string) {
  const state = { table: false }
  return text.split("\n").some((raw) => {
    const line = raw.replace(/#.*$/, "").trim()
    // `[[bin]]` and the like are headers too, so an entry after one is not read as a dependency.
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line)
    if (header) {
      const name = header[1].replaceAll(/\s+/g, "")
      state.table = DEPENDENCY_TABLE.test(name)
      return DEPENDENCY_ITEM_TABLE.test(name)
    }
    return (
      state.table &&
      /^[A-Za-z0-9_.-]+\s*=/.test(line) &&
      !/\bpath\s*=/.test(line) &&
      !/\bworkspace\s*=\s*true\b/.test(line)
    )
  })
}

const goMissing = (root: string, cwd: string) =>
  Effect.gen(function* () {
    const manifest = yield* nearest(root, cwd, "go.mod")
    if (!manifest || !goRequires(manifest.text)) return undefined
    const vendored = yield* optional(() => lstat(path.join(manifest.directory, "vendor", "modules.txt")))
    if (vendored?.isFile()) return undefined
    return `${manifest.relative} requires modules, and the checkout does not vendor them`
  })

/** Whether a go.mod requires a module, in a `require` line or a `require (...)` block with an entry. */
function goRequires(text: string) {
  const lines = text.split("\n").map((line) => line.replace(/\/\/.*$/, "").trim())
  return lines.some((line, index) => {
    if (/^require\s+[^\s(]/.test(line)) return true
    if (!/^require\s*\($/.test(line)) return false
    const end = lines.indexOf(")", index + 1)
    return lines.slice(index + 1, end < 0 ? undefined : end).some(Boolean)
  })
}

/**
 * The nearest regular file `name` from the check's folder up to the checkout's root, as text, or undefined if there
 * is none; one that is not a regular file within 1 MiB refuses.
 */
const nearest = (root: string, cwd: string, name: string) =>
  Effect.gen(function* () {
    const folders = path
      .relative(root, cwd)
      .split(path.sep)
      .filter(Boolean)
      .map((_, index, parts) => path.join(root, ...parts.slice(0, parts.length - index)))
      .concat([root])
    const found = (yield* Effect.forEach(folders, (directory) =>
      optional(() => lstat(path.join(directory, name))).pipe(
        Effect.map((info) => (info ? { directory, info } : undefined)),
      ),
    )).find((item) => item !== undefined)
    if (!found) return undefined
    const file = path.join(found.directory, name)
    const relative = path.relative(root, file)
    if (!found.info.isFile() || found.info.size > MANIFEST_BYTES)
      return yield* unavailable(`${relative} is not a regular file Vector reads`)
    return { directory: found.directory, relative, text: decoder.decode(yield* readRegular(file, MANIFEST_BYTES)) }
  })

function exactObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * A fixed file as a check left it: every folder on its way a real folder, the file a single-link regular file within
 * `max` whose bytes are its approved postimage, or absent for a deletion. Nothing is followed or opened but a regular
 * file, so a link, a FIFO or a device a check put there refuses at once.
 */
const held = (root: string, file: FixProposal["files"][number], max: number) =>
  Effect.gen(function* () {
    const parts = file.path.split("/")
    const ancestors = yield* Effect.forEach(parts.slice(0, -1).keys(), (index) =>
      Effect.gen(function* () {
        const info = yield* optional(() => lstat(path.join(root, ...parts.slice(0, index + 1))))
        if (info?.isSymbolicLink())
          return yield* refuse("symlink", "A folder in this path is a symbolic link.", file.path)
        if (info && !info.isDirectory())
          return yield* refuse("path", "A folder in this path is not a folder.", file.path)
        return info !== undefined
      }),
    )
    const target = path.join(root, file.path)
    const info = ancestors.every(Boolean) ? yield* optional(() => lstat(target)) : undefined
    if (!info) {
      if (file.postimage === null) return { path: file.path } satisfies Held
      return yield* refuse("postimage", "A file the fix changes is gone.", file.path)
    }
    if (info.isSymbolicLink()) return yield* refuse("symlink", "This file is a symbolic link.", file.path)
    if (!info.isFile() || info.nlink > 1)
      return yield* refuse("path", "This path is not a single-link regular file.", file.path)
    if (file.postimage === null) return yield* refuse("postimage", "A file the fix deletes is back.", file.path)
    if (info.size > max) return yield* refuse("limit", "This file is over the size limit.", file.path)
    const bytes = yield* readRegular(target, max)
    if (`sha256:${sha256(bytes)}` !== file.postimage)
      return yield* refuse("postimage", "This file is not the approved postimage.", file.path)
    return { path: file.path, bytes } satisfies Held
  })

/** Reads a regular file without following a link at it and without blocking on a FIFO. */
const readRegular = (file: string, max: number) =>
  io(() =>
    open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).then((handle) =>
      handle
        .stat()
        .then(async (info) => {
          if (!info.isFile() || info.nlink > 1 || info.size > max)
            throw new Error("This path is not a regular file within the size limit.")
          return new Uint8Array(await handle.readFile())
        })
        .finally(() => handle.close()),
    ),
  )

const change = (item: Plan): Change => ({
  path: item.path,
  status: item.status,
  additions: item.additions,
  deletions: item.deletions,
})

const decode = (bytes: Uint8Array) => (bytes.includes(0) || !isUtf8(bytes) ? undefined : decoder.decode(bytes))

type Line = { kind: " " | "+" | "-"; text: string; newline: boolean }
const lineKind = (value: string): value is Line["kind"] => value === " " || value === "+" || value === "-"
type Hunk = { oldStart: number; oldCount: number; lines: Line[] }
type Section = { index?: { before: string; after: string; mode?: string }; hunks: Hunk[] }

/**
 * Each file's part of a patch that already passed the core contract's grammar (fix-proposal.ts `patchMatches`). A
 * line-by-line state machine, so it stays one loop.
 */
function sections(patch: string) {
  const result = new Map<string, Section>()
  const state: { section?: Section; hunk?: Hunk } = {}
  for (const line of patch.split("\n").slice(0, -1)) {
    const header = /^diff --git a\/(\S+) b\/\S+$/.exec(line)
    if (header) {
      state.section = { hunks: [] }
      state.hunk = undefined
      result.set(header[1], state.section)
      continue
    }
    const section = state.section
    if (!section) continue
    const index = state.hunk ? undefined : /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/.exec(line)
    if (index) {
      section.index = { before: index[1], after: index[2], ...(index[3] ? { mode: index[3] } : {}) }
      continue
    }
    const range = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line)
    if (range) {
      state.hunk = { oldStart: Number(range[1]), oldCount: range[2] === undefined ? 1 : Number(range[2]), lines: [] }
      section.hunks.push(state.hunk)
      continue
    }
    const hunk = state.hunk
    if (!hunk) continue
    if (line === "\\ No newline at end of file") {
      hunk.lines[hunk.lines.length - 1].newline = false
      continue
    }
    const kind = line[0]
    if (lineKind(kind)) hunk.lines.push({ kind, text: line.slice(1), newline: true })
  }
  return result
}

/**
 * Applies hunks exactly: each at its stated line, no fuzz, every context and removed line equal to the file's line
 * including its newline. A line without a newline may only end the result.
 */
function applyHunks(before: string, hunks: readonly Hunk[]) {
  const records = before.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const record = (line: Line) => line.text + (line.newline ? "\n" : "")
  // The result is kept as slices and joined once: spreading a long file's lines into one call overflows the stack.
  const applied = hunks.reduce<{ cursor: number; parts: string[][] } | undefined>(
    (state, hunk) => {
      if (!state) return undefined
      const at = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1
      if (at < state.cursor || at + hunk.oldCount > records.length) return undefined
      const old = hunk.lines.filter((line) => line.kind !== "+").map(record)
      if (old.length !== hunk.oldCount || old.some((value, offset) => value !== records[at + offset])) return undefined
      state.parts.push(records.slice(state.cursor, at), hunk.lines.filter((line) => line.kind !== "-").map(record))
      return { cursor: at + hunk.oldCount, parts: state.parts }
    },
    { cursor: 0, parts: [] },
  )
  if (!applied) return undefined
  const result = [...applied.parts, records.slice(applied.cursor)].flat()
  if (result.slice(0, -1).some((value) => !value.endsWith("\n"))) return undefined
  return result.join("")
}

export type Interface = Effect.Success<typeof make>
export class Service extends Context.Service<Service, Interface>()("@vector/ReviewFix") {}
export const layer = Layer.effect(Service, make)
export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [TaskIsolation.node, Git.node, CrossSpawnSpawner.node],
})

export * as ReviewFix from "./fix"
