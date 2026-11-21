import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { formatPatch, structuredPatch } from "diff"
import { InstanceState } from "@/effect/instance-state"
import { Watcher } from "@vectordevai/core/filesystem/watcher"
import { Git } from "@/git"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@vectordevai/core/event"
import { VcsEvent } from "@vectordevai/schema/vcs-event"

const PATCH_CONTEXT_LINES = 2_147_483_647
const MAX_PATCH_BYTES = 10_000_000
const MAX_TOTAL_PATCH_BYTES = 10_000_000
type DiffOptions = {
  readonly context?: number
}

const emptyPatch = (file: string) => formatPatch(structuredPatch(file, file, "", "", "", "", { context: 0 }))

const nums = (list: Git.Stat[]) =>
  new Map(list.map((item) => [item.file, { additions: item.additions, deletions: item.deletions }] as const))

const merge = (...lists: Git.Item[][]) => {
  const out = new Map<string, Git.Item>()
  lists.flat().forEach((item) => {
    if (!out.has(item.file)) out.set(item.file, item)
  })
  return [...out.values()]
}

const emptyBatch = () => ({ patches: new Map<string, string>(), capped: false })

const parseQuotedPath = (value: string) => {
  let out = ""
  for (let idx = 1; idx < value.length; idx++) {
    const char = value[idx]
    if (char === '"') return { value: out, end: idx + 1 }
    if (char !== "\\") {
      out += char
      continue
    }

    const next = value[++idx]
    if (next === "t") out += "\t"
    else if (next === "n") out += "\n"
    else if (next === "r") out += "\r"
    else if (next === '"' || next === "\\") out += next
    else out += next ?? ""
  }
}

const parsePathToken = (value: string) => {
  if (!value.startsWith('"')) return value.split("\t")[0]
  return parseQuotedPath(value)?.value ?? value
}

const fileFromDiffPath = (value: string | undefined) => {
  if (!value || value === "/dev/null") return
  const file = parsePathToken(value)
  if (file.startsWith("a/") || file.startsWith("b/")) return file.slice(2)
  return file
}

const fileFromGitHeader = (header: string) => {
  if (header.startsWith('"')) {
    const first = parseQuotedPath(header)
    const second = first ? header.slice(first.end).trimStart() : undefined
    if (!second) return
    if (!second.startsWith('"')) return fileFromDiffPath(second)
    return fileFromDiffPath(parseQuotedPath(second)?.value)
  }

  const separator = header.indexOf(" b/")
  if (separator === -1) return
  return fileFromDiffPath(header.slice(separator + 1))
}

const fileFromPatchChunk = (chunk: string) => {
  const next = /^\+\+\+ (.+)$/m.exec(chunk)?.[1]
  const before = /^--- (.+)$/m.exec(chunk)?.[1]
  const file = fileFromDiffPath(next) ?? fileFromDiffPath(before)
  if (file) return file

  const header = /^diff --git (.+)$/m.exec(chunk)?.[1]
  return fileFromGitHeader(header ?? "")
}

const splitGitPatch = (patch: Git.Patch) => {
  const starts = [...patch.text.matchAll(/(?:^|\n)diff --git /g)].map((match) =>
    match[0].startsWith("\n") ? match.index + 1 : match.index,
  )
  const chunks = starts.map((start, index) => patch.text.slice(start, starts[index + 1] ?? patch.text.length))
  if (!patch.truncated) return chunks
  return chunks.slice(0, -1)
}

const batchPatches = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  list: Git.Item[],
  options?: DiffOptions,
) {
  if (list.length === 0) return { patches: new Map<string, string>(), capped: false }

  const result = yield* git.patchAll(cwd, ref, {
    context: options?.context ?? PATCH_CONTEXT_LINES,
    maxOutputBytes: MAX_TOTAL_PATCH_BYTES,
  })

  return {
    patches: splitGitPatch(result).reduce((acc, patch, index) => {
      const file = fileFromPatchChunk(patch) ?? list[index]?.file
      if (!file) return acc
      acc.set(file, (acc.get(file) ?? "") + patch)
      return acc
    }, new Map<string, string>()),
    capped: result.truncated,
  }
})

const nativePatch = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  options?: DiffOptions,
) {
  const result =
    item.code === "??" || !ref
      ? yield* git.patchUntracked(cwd, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
      : yield* git.patch(cwd, ref, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
  if (!result.truncated && result.text) return result.text

  return emptyPatch(item.file)
})

const totalPatch = (file: string, patch: string, total: number) => {
  if (total + Buffer.byteLength(patch) <= MAX_TOTAL_PATCH_BYTES) return { patch, capped: false }
  return { patch: emptyPatch(file), capped: true }
}

const patchForItem = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  batch: { patches: Map<string, string>; capped: boolean },
  capped: boolean,
  options?: DiffOptions,
) {
  if (capped) return emptyPatch(item.file)

  const batched = batch.patches.get(item.file)
  if (batched !== undefined) return batched
  if (item.code !== "??" && batch.capped) return emptyPatch(item.file)
  return yield* nativePatch(git, cwd, ref, item, options)
})

const files = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  list: Git.Item[],
  map: Map<string, { additions: number; deletions: number }>,
  batch: { patches: Map<string, string>; capped: boolean },
  options?: DiffOptions,
) {
  const next: FileDiff[] = []
  let total = 0
  let capped = false

  for (const item of list.toSorted((a, b) => a.file.localeCompare(b.file))) {
    const stat = map.get(item.file) ?? (item.status === "added" ? yield* git.statUntracked(cwd, item.file) : undefined)
    const patch = yield* patchForItem(git, cwd, ref, item, batch, capped, options)
    const result: { patch: string; capped: boolean } = capped
      ? { patch, capped: true }
      : totalPatch(item.file, patch, total)
    capped = capped || result.capped
    if (!capped) {
      total += Buffer.byteLength(result.patch)
      capped = total >= MAX_TOTAL_PATCH_BYTES
    }
    next.push({
      file: item.file,
      patch: result.patch,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      status: item.status,
    })
  }

  return next
})

const diffAgainstRef = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  options?: DiffOptions,
) {
  const [list, stats, extra] = yield* Effect.all([git.diff(cwd, ref), git.stats(cwd, ref), git.status(cwd)], {
    concurrency: 3,
  })
  return yield* files(
    git,
    cwd,
    ref,
    merge(
      list,
      extra.filter((item) => item.code === "??"),
    ),
    nums(stats),
    yield* batchPatches(git, cwd, ref, list, options),
    options,
  )
})

const track = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  options?: DiffOptions,
) {
  if (!ref) return yield* files(git, cwd, ref, yield* git.status(cwd), new Map(), emptyBatch(), options)
  return yield* diffAgainstRef(git, cwd, ref, options)
})

// `symbolic-ref --short` disambiguates a branch that shares its name with a tag ("heads/v1"), so
// read the full ref and strip the prefix. A detached HEAD has no symbolic ref.
const currentBranch = Effect.fnUntraced(function* (git: Git.Interface, cwd: string) {
  const result = yield* git.run(["symbolic-ref", "--quiet", "HEAD"], { cwd })
  const ref = result.exitCode === 0 ? result.text().trim() : ""
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined
})

// One row per local branch: "*" when it is HEAD in this worktree, the full ref name, and the path
// of the worktree that has it checked out (empty when none), separated by NUL bytes.
const branchRows = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.split("\0"))
    .filter((row) => row[1]?.startsWith("refs/heads/"))
    .map((row) => ({ head: row[0] === "*", name: row[1].slice("refs/heads/".length), worktree: row[2] ?? "" }))

const branchFormat = "--format=%(HEAD)%00%(refname)%00%(worktreepath)"

// Desktop parallel workspaces run agents on `vector-parallel/...` branches and review or merge
// them by diffing against the workspace's recorded base commit. Switching such a checkout to an
// unrelated existing branch would make that merge offer the other branch's whole divergence.
const managedBranchPrefix = "vector-parallel/"

// Git reports a failed switch over several lines: "error:"/"fatal:" prefixes, a tab-indented
// file list, hints and a trailing "Aborting". Collapse that into one sentence a toast can show.
const readableGitError = (stderr: string, fallback: string) => {
  const lines = stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("hint:") && line.trim() !== "Aborting")
  const files = lines.filter((line) => line.startsWith("\t")).map((line) => line.trim())
  const listed = files.length > 5 ? [...files.slice(0, 5), `and ${files.length - 5} more`] : files
  const text = lines
    .filter((line) => !line.startsWith("\t"))
    .map((line) => line.replace(/^(error|fatal):\s*/, "").trim())
  if (text.length === 0) return fallback
  if (listed.length === 0) return text.join(" ")
  return [text[0], `${listed.join(", ")}.`, ...text.slice(1)].join(" ")
}

// Commits reachable from a detached HEAD but from no branch, tag or remote: switching away leaves
// them reachable only through the reflog.
const unreachableCommits = Effect.fnUntraced(function* (git: Git.Interface, cwd: string) {
  const result = yield* git.run(["rev-list", "--count", "HEAD", "--not", "--branches", "--tags", "--remotes"], { cwd })
  return result.exitCode === 0 ? Number(result.text().trim()) || 0 : 0
})

const validBranchName = Effect.fnUntraced(function* (git: Git.Interface, cwd: string, name: string) {
  if (!name || name === "HEAD" || name.startsWith("-")) return false
  const result = yield* git.run(["check-ref-format", "--branch", name], { cwd })
  // check-ref-format expands shorthands such as "@{-1}"; only accept names it echoes back unchanged.
  return result.exitCode === 0 && result.text().trim() === name
})

export const Mode = Schema.Literals(["git", "branch"])
export type Mode = Schema.Schema.Type<typeof Mode>

export const Event = VcsEvent

export const Info = Schema.Struct({
  branch: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const FileDiff = Schema.Struct({
  file: Schema.String,
  // Mirrors Snapshot.FileDiff (see #26574). The current producer always
  // populates patch, but loosening matches the sibling schema so a
  // future code path that omits it can't crash /instance/vcs/diff.
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "VcsFileDiff" })
export type FileDiff = Schema.Schema.Type<typeof FileDiff>

export const FileStatus = Schema.Struct({
  file: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "VcsFileStatus" })
export type FileStatus = Schema.Schema.Type<typeof FileStatus>

export const ApplyInput = Schema.Struct({
  patch: Schema.String,
})
export type ApplyInput = Schema.Schema.Type<typeof ApplyInput>

export const ApplyResult = Schema.Struct({
  applied: Schema.Boolean,
})
export type ApplyResult = Schema.Schema.Type<typeof ApplyResult>

export const CommitInput = Schema.Struct({
  message: Schema.String,
})
export type CommitInput = Schema.Schema.Type<typeof CommitInput>

export const CommitResult = Schema.Struct({
  committed: Schema.Boolean,
  sha: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsCommitResult" })
export type CommitResult = Schema.Schema.Type<typeof CommitResult>

export const Branch = Schema.Struct({
  name: Schema.String,
  current: Schema.Boolean,
  // Path of the other worktree that has this branch checked out. Git refuses to switch to it here.
  checkedOutElsewhere: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsBranch" })
export type Branch = Schema.Schema.Type<typeof Branch>

export const BranchList = Schema.Struct({
  current: Schema.optional(Schema.String),
  branches: Schema.Array(Branch),
}).annotate({ identifier: "VcsBranchList" })
export type BranchList = Schema.Schema.Type<typeof BranchList>

export const SwitchInput = Schema.Struct({
  branch: Schema.String,
  create: Schema.optional(Schema.Boolean),
})
export type SwitchInput = Schema.Schema.Type<typeof SwitchInput>

export const SwitchReason = Schema.Literals([
  "non-git",
  "invalid-name",
  "not-found",
  "exists",
  "checked-out-elsewhere",
  "dirty",
  "busy",
  "detached",
  "managed",
  "switch-failed",
])

export class SwitchError extends Schema.TaggedErrorClass<SwitchError>()("VcsSwitchError", {
  message: Schema.String,
  reason: SwitchReason,
}) {}

export class PatchApplyError extends Schema.TaggedErrorClass<PatchApplyError>()("VcsPatchApplyError", {
  message: Schema.String,
  reason: Schema.Literals(["non-git", "not-clean"]),
}) {}

export class CommitError extends Schema.TaggedErrorClass<CommitError>()("VcsCommitError", {
  message: Schema.String,
  reason: Schema.Literals(["non-git", "commit-failed"]),
}) {}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly branch: () => Effect.Effect<string | undefined>
  readonly defaultBranch: () => Effect.Effect<string | undefined>
  readonly status: () => Effect.Effect<FileStatus[]>
  readonly diff: (mode: Mode, options?: DiffOptions) => Effect.Effect<FileDiff[]>
  readonly diffRaw: () => Effect.Effect<string>
  readonly apply: (input: ApplyInput) => Effect.Effect<ApplyResult, PatchApplyError>
  readonly commit: (input: CommitInput) => Effect.Effect<CommitResult, CommitError>
  readonly branches: () => Effect.Effect<BranchList>
  readonly switchBranch: (input: SwitchInput) => Effect.Effect<Info, SwitchError>
}

interface State {
  current: string | undefined
  root: Git.Base | undefined
}

export class Service extends Context.Service<Service, Interface>()("@vector/Vcs") {}

const layer: Layer.Layer<Service, never, Git.Service | EventV2Bridge.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Vcs.state")(function* (ctx) {
        if (ctx.project.vcs !== "git") {
          return { current: undefined, root: undefined }
        }

        const get = Effect.fnUntraced(function* () {
          return yield* currentBranch(git, ctx.directory)
        })
        const [current, root] = yield* Effect.all([get(), git.defaultBranch(ctx.directory)], {
          concurrency: 2,
        })
        const value = { current, root }

        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== Watcher.Event.Updated.type || event.location?.directory !== ctx.directory)
            return Effect.void
          const data = event.data as EventV2.Data<typeof Watcher.Event.Updated>
          if (!data.file.endsWith("HEAD")) return Effect.void
          return Effect.gen(function* () {
            const next = yield* get()
            if (next !== value.current) {
              value.current = next
              yield* events.publish(Event.BranchUpdated, { branch: next })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        return value
      }),
    )

    return Service.of({
      init: Effect.fn("Vcs.init")(function* () {
        yield* InstanceState.get(state)
      }),
      branch: Effect.fn("Vcs.branch")(function* () {
        return yield* InstanceState.use(state, (x) => x.current)
      }),
      defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
        return yield* InstanceState.use(state, (x) => x.root?.name)
      }),
      status: Effect.fn("Vcs.status")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        const ref = (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined
        const [list, stats] = yield* Effect.all(
          [git.status(ctx.directory), ref ? git.stats(ctx.directory, ref) : Effect.succeed([])],
          { concurrency: 2 },
        )
        const map = nums(stats)
        return yield* Effect.forEach(
          list.toSorted((a, b) => a.file.localeCompare(b.file)),
          (item) =>
            Effect.gen(function* () {
              const stat =
                map.get(item.file) ??
                (item.status === "added" ? yield* git.statUntracked(ctx.worktree, item.file) : undefined)
              return {
                file: item.file,
                additions: stat?.additions ?? 0,
                deletions: stat?.deletions ?? 0,
                status: item.status,
              } satisfies FileStatus
            }),
        )
      }),
      diff: Effect.fn("Vcs.diff")(function* (mode: Mode, options?: DiffOptions) {
        const value = yield* InstanceState.get(state)
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        if (mode === "git") {
          return yield* track(git, ctx.directory, (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined, options)
        }

        if (!value.root) return []
        if (value.current && value.current === value.root.name) return []
        const ref = yield* git.mergeBase(ctx.directory, value.root.ref)
        if (!ref) return []
        return yield* diffAgainstRef(git, ctx.directory, ref, options)
      }),
      diffRaw: Effect.fn("Vcs.diffRaw")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return ""
        const [hasHead, status] = yield* Effect.all([git.hasHead(ctx.directory), git.status(ctx.directory)], {
          concurrency: 2,
        })
        const tracked = hasHead ? (yield* git.patchAll(ctx.directory, "HEAD")).text : ""
        // Before the first commit there is nothing to diff against, so staged files are new files too. Status paths
        // are relative to the repository root, which is not the project directory when a subfolder is open.
        const untracked = yield* Effect.forEach(
          status.filter((item) => item.code === "??" || !hasHead),
          (item) => git.patchUntracked(ctx.worktree, item.file).pipe(Effect.map((patch) => patch.text)),
        )
        return [tracked, ...untracked].filter(Boolean).join("\n")
      }),
      apply: Effect.fn("Vcs.apply")(function* (input: ApplyInput) {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") {
          return yield* new PatchApplyError({
            message: "Patch can't be applied because the folder is not a Git repository",
            reason: "non-git",
          })
        }
        const applied = yield* git.applyPatch(ctx.directory, input.patch)
        if (applied.exitCode !== 0) {
          return yield* new PatchApplyError({
            message: "Patch can't be applied",
            reason: "not-clean",
          })
        }
        return { applied: true }
      }),
      commit: Effect.fn("Vcs.commit")(function* (input: CommitInput) {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") {
          return yield* new CommitError({
            message: "Changes can't be committed because the folder is not a Git repository",
            reason: "non-git",
          })
        }
        const cwd = ctx.directory
        const message = input.message.trim() || "Update"

        // Never commit a clean tree — report a no-op instead of creating an empty commit.
        const changed = yield* git.status(cwd)
        if (changed.length === 0) return { committed: false }

        // Capture a restore point BEFORE committing. A lightweight tag at the current
        // HEAD gives a named anchor to reset back to; the commit itself is reversible
        // with `git reset --soft HEAD~1`. Skip when there is no commit yet (empty repo).
        const hasHead = yield* git.hasHead(cwd)
        if (hasHead) {
          yield* git.run(["tag", "-f", `vector/pre-commit-${Date.now()}`, "HEAD"], { cwd })
        }

        const staged = yield* git.run(["add", "-A", "--", "."], { cwd })
        if (staged.exitCode !== 0) {
          return yield* new CommitError({
            message: staged.stderr.toString("utf8").trim() || "Failed to stage changes for commit",
            reason: "commit-failed",
          })
        }

        // Identity-safe commit: fall back to a Vector identity when git has none
        // configured, mirroring the desktop github.ts buildCommitArgs behaviour.
        const email = yield* git.run(["config", "user.email"], { cwd })
        const hasEmail = email.exitCode === 0 && email.text().trim().length > 0
        const identity = hasEmail ? [] : ["-c", "user.name=Vector", "-c", "user.email=noreply@vectordev.ai"]

        const committed = yield* git.run([...identity, "commit", "-m", message, "--", "."], { cwd })
        if (committed.exitCode !== 0) {
          return yield* new CommitError({
            message: committed.stderr.toString("utf8").trim() || "Failed to commit changes",
            reason: "commit-failed",
          })
        }

        const head = yield* git.run(["rev-parse", "HEAD"], { cwd })
        const sha = head.exitCode === 0 ? head.text().trim() || undefined : undefined
        return { committed: true, sha }
      }),
      branches: Effect.fn("Vcs.branches")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return { branches: [] }
        const cwd = ctx.directory
        const [current, refs] = yield* Effect.all(
          [
            currentBranch(git, cwd),
            git.run(["for-each-ref", "--sort=-committerdate", branchFormat, "refs/heads"], { cwd }),
          ],
          { concurrency: 2 },
        )
        // Leave absent fields out: the HTTP encoder would otherwise send them as null.
        return {
          ...(current ? { current } : {}),
          branches: branchRows(refs.text()).map((row) => ({
            name: row.name,
            current: row.head,
            // The row that is HEAD here is checked out in this worktree, not elsewhere.
            ...(row.worktree && !row.head ? { checkedOutElsewhere: row.worktree } : {}),
          })),
        }
      }),
      // Only ever a plain `git switch`: never forced, never stashed and never over ignored files, so
      // uncommitted work is either carried over by git or the switch is refused with git's own
      // explanation. Refused while any session in this instance is running.
      switchBranch: Effect.fn("Vcs.switchBranch")(function* (input: SwitchInput) {
        const value = yield* InstanceState.get(state)
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") {
          return yield* new SwitchError({
            message: "Branches can't be switched because the folder is not a Git repository",
            reason: "non-git",
          })
        }
        const cwd = ctx.directory
        const name = input.branch.trim()
        if (!(yield* validBranchName(git, cwd, name))) {
          return yield* new SwitchError({ message: `"${name}" is not a valid branch name`, reason: "invalid-name" })
        }

        const [current, refs] = yield* Effect.all(
          [currentBranch(git, cwd), git.run(["for-each-ref", branchFormat, `refs/heads/${name}`], { cwd })],
          { concurrency: 2 },
        )
        if (!input.create && name === current) return { branch: current, default_branch: value.root?.name }
        if (!input.create && current?.startsWith(managedBranchPrefix)) {
          return yield* new SwitchError({
            message:
              "This agent workspace is managed by Vector. Create a new branch here instead of switching to an existing one.",
            reason: "managed",
          })
        }
        // A `refs/heads/<name>` pattern also matches branches below it, so look for the exact ref.
        const target = branchRows(refs.text()).find((row) => row.name === name)
        if (input.create && target) {
          return yield* new SwitchError({ message: `A branch named "${name}" already exists`, reason: "exists" })
        }
        if (!input.create && !target) {
          return yield* new SwitchError({ message: `There is no local branch named "${name}"`, reason: "not-found" })
        }
        if (!input.create && target?.worktree) {
          return yield* new SwitchError({
            message: `"${name}" is already checked out in another worktree at ${target.worktree}`,
            reason: "checked-out-elsewhere",
          })
        }
        const behind = !input.create && !current ? yield* unreachableCommits(git, cwd) : 0
        if (behind > 0) {
          return yield* new SwitchError({
            message: `HEAD is detached with ${behind} commit${behind === 1 ? "" : "s"} that no branch contains. Create a branch here first so that work isn't left behind.`,
            reason: "detached",
          })
        }

        const switched = yield* git.run(
          input.create ? ["switch", "-c", name] : ["switch", "--no-overwrite-ignore", "--no-guess", name],
          { cwd },
        )
        if (switched.exitCode !== 0) {
          const stderr = switched.stderr.toString("utf8")
          return yield* new SwitchError({
            message: readableGitError(stderr, `Couldn't switch to "${name}"`),
            // Covers both local changes to tracked files and untracked or ignored files (such as a
            // local .env) that the target branch tracks.
            reason: stderr.includes("overwritten") ? "dirty" : "switch-failed",
          })
        }

        // The HEAD watcher may also see this switch; whichever runs first updates the cached
        // branch, so the event is published once either way.
        const next = yield* currentBranch(git, cwd)
        if (next !== value.current) {
          value.current = next
          yield* events.publish(Event.BranchUpdated, { branch: next })
        }
        return { branch: next, default_branch: value.root?.name }
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Git.node, EventV2Bridge.node],
})

export * as Vcs from "./vcs"
