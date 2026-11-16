import path from "node:path"
import os from "node:os"
import { isUtf8 } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, rmdir, unlink } from "node:fs/promises"
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { KeyedMutex } from "@vectordevai/core/effect/keyed-mutex"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import {
  prepareFixProposal,
  type createFixConsentPolicy,
  type FixConsent,
  type FixProposal,
} from "@vectordevai/core/review/fix-proposal"
import { Git } from "@/git"
import { TaskIsolation } from "@/task/isolation"
import { FileLock } from "@/tool/file-lock"
import { FileState } from "@/tool/file-state"
import { assertWritable } from "@/tool/owned-path"

// VS-12a (SF-07): the consented local fix executor's first states, proposal -> preview -> apply. Checks, commit and
// push are SF-08. Nothing is wired here: no route, CLI, app, key or permission reaches this module, and it calls no
// model.
//
// Consent is the core contract's (review/fix-proposal.ts). A trusted adapter shows the Preview, authenticates the actor
// and calls `policy.approve`; `apply` spends that handle with `policy.consume` before its first write. Proof that a
// person approved rests on that adapter, as fix-proposal.ts:1-4 says: anyone who can call `apply` with a policy of
// their own can also approve with it, so the adapter must be its only caller.
//
// The fix checkout is a TaskIsolation fix placement (`reserveFix`): Git's detached worktree at the proposal's exact
// head, under the data folder, never the user's checkout. Writes take FileLock, compare FileState stamps (the
// compare-and-write preimage), pass the owned-path guard keyed by the fix ID, and land through TaskIsolation.place (a
// new name, then a rename). Git runs here only read-only, without hooks, fsmonitor or optional locks. Linux only:
// elsewhere every method refuses as unavailable before any effect.

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
export type State = "proposal" | "preview" | "applied" | "cancelled" | "failed"
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

type Entry = { state: State; placement: Placement; digest?: string; patchDigest?: string }
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
  const isolation = yield* TaskIsolation.Service
  const git = yield* Git.Service
  // Only fixes whose placement exists: an entry goes when its placement is removed.
  const states = new Map<string, Entry>()
  const run = (cwd: string, args: string[]) =>
    git.run(["-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", ...args], {
      cwd,
      env: { GIT_LFS_SKIP_SMUDGE: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    })
  const output = Effect.fnUntraced(function* (cwd: string, args: string[], reason: Reason) {
    const result = yield* run(cwd, args)
    if (result.exitCode !== 0 || result.truncated)
      return yield* refuse(reason, result.stderr.toString("utf8").trim() || "A Git read in the fix checkout failed.")
    return result.text()
  })
  const commit = Effect.fnUntraced(function* (cwd: string, revision: string) {
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
    const source = yield* commit(record.directory, `refs/heads/${proposal.scope.sourceBranch}`)
    const base = yield* commit(record.directory, proposal.base)
    const head = yield* commit(record.directory, "HEAD")
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
      (yield* commit(bound.directory, "HEAD")) !== proposal.head ||
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

  const cancel = Effect.fn("ReviewFix.cancel")(function* (fixID: string) {
    yield* linux
    return yield* mutex.withLock(fixID)(
      Effect.gen(function* () {
        const result = yield* isolation.removeFix(fixID).pipe(Effect.mapError(isolated("worktree")))
        const current = states.get(fixID)
        if (result.removed) states.delete(fixID)
        if (!result.removed && current) states.set(fixID, { ...current, state: "cancelled" })
        return { fixID, ...result } satisfies Cleanup
      }),
    )
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

  return { reserve, preview, apply, cancel, state, placements }
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
export const node = LayerNode.make({ service: Service, layer, deps: [TaskIsolation.node, Git.node] })

export * as ReviewFix from "./fix"
