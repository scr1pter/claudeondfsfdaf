export * as PromptTrust from "./prompt-trust"

import { createHash, randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import fs from "node:fs/promises"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { omit } from "remeda"
import { Global } from "@vectordevai/core/global"
import { Glob } from "@vectordevai/core/util/glob"
import { Flock } from "@vectordevai/core/util/flock"
import { InstanceState } from "@/effect/instance-state"
import { PromptSource } from "@/session/prompt-source"
import { isRecord } from "@/util/record"
import type { Config } from "./config"
import { ConfigPaths } from "./paths"

// Prompt sources outside the trusted workspace that changed since the owner last approved them wait for the owner
// (section 8.3): a held skill, command, agent, plugin or instruction file is not loaded, and a global config file's
// prompt-bearing keys are dropped, for as long as the instance runs. Sources inside the workspace are workspace trust's,
// which fingerprints them already. The baseline is the hash of each source as last approved, by the root it was
// recorded under. The first baseline (the first start after an upgrade) records every root as it is and holds nothing.
// After that, a root that only changed its globs records its new files as they are, so a new kind of prompt file is not
// held at the first start that counts it; a folder or file never seen before is recorded with nothing approved, so what
// appears there (~/.vector made by an agent, say) waits for the owner. This is a hold, not a guarantee: anything that
// can write the state folder can change the baseline too.

const FILE = "prompt-trust.json"
// A config file's prompt-bearing keys (PromptSource.KEYS) are what is held of it. A whole file is never held: that
// would cut off its providers and sign-ins.

const Root = Schema.Struct({ path: Schema.String, globs: Schema.Array(Schema.String) })
type Root = typeof Root.Type
const Baseline = Schema.Struct({
  version: Schema.Literal(1),
  roots: Schema.Array(Root),
  files: Schema.Record(Schema.String, Schema.String),
})
type Baseline = typeof Baseline.Type
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Baseline))

// The baseline as last read, kept until the file changes: loaders ask about every prompt file they load.
const cache: { key?: string; baseline?: Baseline } = {}

/**
 * Whether a prompt file may be loaded: it is not under a recorded root, or it is as the owner last approved it. Each
 * loader asks at its one load site; a file inside the workspace is never under a root.
 */
export function allowed(file: string) {
  return allowedBy(read(), path.resolve(file))
}

function allowedBy(baseline: Baseline | undefined, target: string) {
  if (!baseline) return true
  if (!baseline.roots.some((root) => covers(root, target))) return true
  return baseline.files[target] === fingerprint(target)
}

/** The prompt sources the hold covers: those outside the workspace, with what Vector loads from each. */
export function scope(sources: PromptSource.Sources, ctx: { directory: string; worktree: string }) {
  return sources.filter(
    (source) =>
      !ConfigPaths.projectContains(source.path, ctx) && (source.kind !== "directory" || source.load.length > 0),
  )
}

/** The hold's scope for this instance, from what Config loaded. */
export const current = Effect.fn("PromptTrust.current")(function* (config: Config.Interface) {
  const ctx = yield* InstanceState.context
  const global = Option.getOrElse(yield* Effect.serviceOption(Global.Service), () => Global.make())
  return scope(yield* PromptSource.sources({ config, global, directory: ctx.directory, worktree: ctx.worktree }), ctx)
})

/**
 * Records the roots of `sources` seen for the first time. Runs at each instance start. The first baseline takes their
 * files as they are; a later one does so only for a root it knew under other globs, and records a root it never saw
 * with nothing approved, so its files wait for the owner.
 */
export const record = Effect.fn("PromptTrust.record")(function* (sources: PromptSource.Sources) {
  const known = read()?.roots ?? []
  const fresh = sources.filter((source) => !known.some((root) => same(root, rootOf(source))))
  if (fresh.length === 0) return
  const found = yield* files(fresh)
  yield* write((baseline) => {
    const first = baseline.roots.length === 0
    const seen = (file: string) =>
      fresh.some(
        (source) => covers(rootOf(source), file) && baseline.roots.some((root) => root.path === rootOf(source).path),
      )
    return {
      version: 1,
      roots: [
        ...baseline.roots,
        ...fresh.map(rootOf).filter((root) => !baseline.roots.some((item) => same(item, root))),
      ],
      // A file an older root covers keeps what the owner last approved, so a new root never approves a held change.
      files: {
        ...hashes(found.filter((file) => (first || seen(file)) && !baseline.roots.some((root) => covers(root, file)))),
        ...baseline.files,
      },
    }
  })
})

/** A held file and its fingerprint when the owner was shown it: none for a file that is gone. */
export type Held = { readonly path: string; readonly fingerprint?: string }

/** The files in `sources` that are held: changed or new under a recorded root. */
export const held = Effect.fn("PromptTrust.held")(function* (sources: PromptSource.Sources) {
  return (yield* status(sources)).map((file) => file.path)
})

/** The held files with their fingerprints, which an approval names back so it approves only what was shown. */
export const status = Effect.fn("PromptTrust.status")(function* (sources: PromptSource.Sources) {
  return heldIn(read(), yield* files(sources))
})

/**
 * Approves the files in `sources` as they are now, so the next instance loads them, and drops the global config the
 * process keeps loaded, whose held keys were left out. With `shown`, the held files the owner was shown, nothing is
 * approved unless the files held now are exactly those, unchanged since: a file held or changed after the list was
 * shown is never approved unseen. Returns the files it approved, or the files held now when it refused.
 */
export const approve = Effect.fn("PromptTrust.approve")(function* (input: {
  config: Config.Interface
  sources: PromptSource.Sources
  shown?: readonly Held[]
}) {
  const found = yield* files(input.sources)
  const roots = input.sources.map(rootOf)
  const outcome: { approved: string[]; held?: Held[] } = { approved: [] }
  yield* write((baseline) => {
    const now = heldIn(baseline, found)
    if (input.shown && !sameHeld(now, input.shown)) {
      outcome.held = now
      return baseline
    }
    outcome.approved = now.map((file) => file.path)
    // A root not recorded yet is recorded as `record` does, so its files are approved only once they were listed.
    const first = baseline.roots.length === 0
    const listed = (file: string) =>
      first ||
      baseline.roots.some((root) => covers(root, file)) ||
      roots.some((root) => covers(root, file) && baseline.roots.some((item) => item.path === root.path))
    return {
      version: 1,
      roots: [...baseline.roots, ...roots.filter((root) => !baseline.roots.some((item) => same(item, root)))],
      // A file that is gone is forgotten, so it counts as new if it comes back.
      files: {
        ...Object.fromEntries(
          Object.entries(baseline.files).filter(([file]) => !roots.some((root) => covers(root, file))),
        ),
        ...hashes(found.filter(listed)),
      },
    }
  })
  if (outcome.held) return { refused: true as const, held: outcome.held }
  yield* input.config.invalidate()
  return { refused: false as const, approved: outcome.approved }
})

/**
 * Takes the owner's approved edits into the baseline: a tool call whose prompt_source ask they approved changed these
 * files, so they are not held at the next start. Before the first start has recorded anything there is nothing to do.
 */
export const accept = Effect.fn("PromptTrust.accept")(function* (changed: readonly string[]) {
  const baseline = read()
  const targets = changed.map((file) => path.resolve(file))
  if (!baseline || !targets.some((file) => baseline.roots.some((root) => covers(root, file)))) return
  yield* write((current) => {
    const covered = targets.filter((file) => current.roots.some((root) => covers(root, file)))
    return {
      ...current,
      files: {
        ...Object.fromEntries(Object.entries(current.files).filter(([file]) => !covered.includes(file))),
        ...hashes(covered),
      },
    }
  })
})

/** A config without its prompt-bearing keys, for a global config file whose keys are held. */
export function strip<T extends object>(config: T): T {
  return Object.fromEntries(
    Object.entries(config).flatMap(([key, value]) => {
      if (PromptSource.KEYS.includes(key)) return []
      if (!PromptSource.PROMPTED.includes(key) || !isRecord(value)) return [[key, value]]
      return [
        [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, item]) => [name, isRecord(item) ? omit(item, ["prompt"]) : item]),
          ),
        ],
      ]
    }),
  ) as T
}

/** The one line the terminal shows when prompt files are held. */
export function notice(count: number) {
  return `${count} prompt ${count === 1 ? "file" : "files"} outside this repository changed since you last approved ${count === 1 ? "it" : "them"}; run \`vector trust prompts\` in a terminal outside Vector`
}

/**
 * What the baseline keeps of a file: a hash of its bytes, or for a config file of its prompt-bearing keys as canonical
 * JSON. Nothing for a file that is missing, or a config file without those keys.
 */
export function fingerprint(file: string) {
  const text = PromptSource.readText(file)
  if (text === undefined) return
  // A saved workflow is executable prompt content, not a vector.json configuration object.
  if (file.endsWith(".json") && ["workflow", "workflows"].includes(path.basename(path.dirname(file))))
    return digest(text)
  if (!/\.jsonc?$/.test(file)) return digest(text)
  const keys = PromptSource.promptKeys(text, file)
  return keys && digest(canonical(keys))
}

function read() {
  const file = path.join(Global.Path.state, FILE)
  const info = statSync(file, { throwIfNoEntry: false })
  if (!info) return
  // Each write renames a new file into place, so the inode changes with every save.
  const key = `${info.ino}:${info.mtimeMs}:${info.size}`
  if (cache.key === key) return cache.baseline
  cache.key = key
  cache.baseline = Option.getOrUndefined(decode(PromptSource.readText(file) ?? ""))
  return cache.baseline
}

// Each change re-reads the baseline under a lock, so two processes recording or approving at once keep both changes.
const write = Effect.fnUntraced(function* (update: (baseline: Baseline) => Baseline) {
  const target = path.join(Global.Path.state, FILE)
  yield* Effect.tryPromise(() =>
    Flock.withLock(
      target,
      async () => {
        const next = update(read() ?? { version: 1, roots: [], files: {} })
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
        await fs.mkdir(Global.Path.state, { recursive: true })
        await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
        await fs.rename(temporary, target)
      },
      { dir: path.join(Global.Path.state, "locks") },
    ),
  ).pipe(
    Effect.catch((error) => Effect.logWarning("could not save the prompt trust baseline", { error: String(error) })),
  )
})

// The files under each source that Vector loads into a prompt, spelled as the loaders spell them.
const files = Effect.fnUntraced(function* (sources: PromptSource.Sources) {
  const found = yield* Effect.forEach(
    sources,
    (source) =>
      source.kind === "directory"
        ? Effect.tryPromise(() =>
            Promise.all(
              source.load.map((glob) =>
                Glob.scan(glob, { cwd: source.path, absolute: true, dot: true, symlink: true }),
              ),
            ),
          ).pipe(
            Effect.map((lists) => lists.flat()),
            Effect.orElseSucceed(() => [] as string[]),
          )
        : Effect.succeed([path.resolve(source.path)]),
    { concurrency: 4 },
  )
  return [...new Set(found.flat())]
})

function rootOf(source: PromptSource.Source): Root {
  return { path: path.resolve(source.path), globs: source.kind === "directory" ? [...source.load] : [] }
}

function same(a: Root, b: Root) {
  return a.path === b.path && a.globs.join("\0") === b.globs.join("\0")
}

function covers(root: Root, file: string) {
  return root.globs.length === 0 ? root.path === file : PromptSource.matches(root.path, root.globs, file)
}

// The files of `found` the baseline holds, with their fingerprints now.
function heldIn(baseline: Baseline | undefined, found: readonly string[]): Held[] {
  return found
    .filter((file) => !allowedBy(baseline, file))
    .toSorted()
    .map((file) => {
      const hash = fingerprint(file)
      return hash ? { path: file, fingerprint: hash } : { path: file }
    })
}

function sameHeld(a: readonly Held[], b: readonly Held[]) {
  const key = (list: readonly Held[]) =>
    list
      .map((file) => `${path.resolve(file.path)}\0${file.fingerprint ?? ""}`)
      .toSorted()
      .join("\n")
  return key(a) === key(b)
}

function hashes(list: readonly string[]) {
  return Object.fromEntries(
    list.flatMap((file) => {
      const hash = fingerprint(file)
      return hash ? [[file, hash]] : []
    }),
  )
}

// Key order and spacing do not change what a prompt says.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

function digest(text: string) {
  return createHash("sha256").update(text).digest("hex")
}
