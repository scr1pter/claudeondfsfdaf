// The impact slice is built from exact base and head commits in a scoped private Git snapshot.
// A fork may be checked out at the base. Missing objects, unsupported hosts and stale bindings
// leave the slice incomplete. No file or command is read through the live checkout or Git service.
//
// VS-37a: production uses three-tier packing with optional eval-only parameters (core packTiers): it asks the
// confirmation parse for statements and, after confirmation, reads the files the changed lines' imports name, so
// tier b's reads never take time from confirmation and never mark the slice incomplete. Without `packing` it builds
// VS-25b's original comparison arm in algorithm fixtures. VS-37c: tier b also reads, after those files and inside the same read cap, the other Go
// files of a changed Go file's folder, for the declarations its added lines use without an import.

import { Effect, Option, Stream } from "effect"
import type { Git } from "@/git"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { heldReason, holdbackFiles, holdbackLines, holdbackText } from "@vectordevai/core/review/holdback"
import { ReviewGit } from "./git"
import { ReviewSnapshot } from "./private-snapshot"
import { BrainCode } from "@vectordevai/core/brain/code"
import type { DiffFile } from "@vectordevai/core/review/diff"
import { classifyPath, hasGeneratedHeader, parseGitAttributes } from "@vectordevai/core/review/ignore"
import {
  IMPACT_INCOMPLETE,
  IMPACT_LIMITS,
  IMPACT_TIERS,
  barrels,
  capImpactSlice,
  changedDefinitions,
  changedPaths,
  impactNames,
  impactPacking,
  impactTokens,
  movedNames,
  outboundUses,
  packSlice,
  packTiers,
  reexportTargets,
  samePackageLookups,
  samePackageUses,
  selectDependents,
  wordHits,
  type Definition,
  type ImpactFallback,
  type ImpactIncomplete,
  type ImpactPackingInput,
  type ImpactSlice,
  type OutboundUse,
  type Reference,
  type SamePackageFile,
  type SourceReference,
  type TierSource,
} from "@vectordevai/core/review/impact"
import { changedSymbols } from "@vectordevai/core/review/symbols"
import type { CommentRange, SourceRange } from "@vectordevai/core/review/trivial"
import type { Side } from "@vectordevai/core/review/types"
import { ReviewParse } from "./parse"

// Pathspec characters per command: git grep has no --pathspec-from-file, and Windows caps a command line at 32,767.
export const ARG_CHARS = 24_000
const GREP_BYTES = 16 * 1024 * 1024
const MANIFEST_BYTES = 8 * 1024 * 1024
const TREE_BYTES = 64 * 1024 * 1024
const READ_CONCURRENCY = 4
const CHUNK_CONCURRENCY = 2
// Tier b's target reads run after confirmation, so at most this many git processes run while they do.
const TARGET_CONCURRENCY = 2
// A backstop on git versions that honour it: no command may fetch a missing object.
const ENV = { GIT_NO_LAZY_FETCH: "1" }
const MANIFESTS = [
  ":(top,glob)**/package.json",
  ":(top,glob)**/tsconfig.json",
  ":(top,glob)**/jsconfig.json",
  ":(top,literal)pnpm-workspace.yaml",
  ":(top,exclude,glob)**/node_modules/**",
]

// `git grep -E` patterns for every line BrainCode.imports can read: import keywords; markup sources; a line that opens
// with a string (Go import-block entries, a specifier wrapped onto its own line); a closing parenthesis (Go's block end,
// a wrapped `import(` or `require(`); an indented bare name (Python's parenthesised import lists); and the
// generated-file markers, so a generated header is seen before the cap. They are sent as one alternation in one -e:
// git 2.43 tests several -e patterns line by line, which took over 30 s on 100 files of this repository where the one
// alternation took 89 ms.
export const IMPORT_LINE = ReadOnlyGit.IMPACT_IMPORT_LINE

// What VS-24 wiring and Review.run need from the changed files' parse: each side's text, definitions, comments and
// strings, keyed by the path on that side (the old path for LEFT), as TrivialInput's callbacks take them.
export interface ChangedFiles {
  text: (path: string, side: Side) => string | undefined
  definitions: (path: string, side: Side) => readonly Definition[] | undefined
  comments: (path: string, side: Side) => readonly CommentRange[] | undefined
  strings: (path: string, side: Side) => readonly SourceRange[] | undefined
  // VS-37a: the parser's references on the changed lines of each side (added lines for RIGHT, removed for LEFT).
  references?: (path: string, side: Side) => readonly SourceReference[] | undefined
  unsupported: string[] // paths the parser did not read
  missing: string[] // "path" (head) or "base:path" a partial clone does not have, never read
  large?: string[] // VS-37a: "path" or "base:path" over the parser's cap, never parsed
  parseMs: number
}

export interface BuildInput {
  batchClusters?: true
  directory: string
  base: string
  head: string
  files: readonly DiffFile[]
  ignore?: readonly string[] // globs left out of the search, as relatedCode takes them
  ignored?: (path: string) => boolean
  holdback?: "secrets"
  context: number // the review model's context window, in tokens
  signal?: AbortSignal
  budgetMs?: number // the time box, IMPACT_LIMITS.timeBoxMs by default
  // Used only by the portable graph-comparison fixtures. The production builder always parses its private snapshot.
  changed?: ChangedFiles
  // Eval-only override (never parsed from config or env). Production uses the default three-tier proportions.
  // Tier a sends changed definitions whole and tier b signatures from files outside the
  // diff, so a tiered build needs `files` to be the set already left after the secret holdback (VS-34) and the
  // privacy rules: a file the prompt must not carry is left out of `files`, never passed with `diffShown` false or
  // `inline` false, which only say how much of it the prompt already shows (a file with no diff shown gets more of
  // it in tier a, not less). `ignored` is where classifyPath's whole rule goes, as selectDependents takes it.
  packing?: ImpactPackingInput
  inline?: (path: string) => boolean // a changed file the prompt shows whole; by default none
  diffShown?: (path: string) => boolean // a changed file whose diff the prompt carries; by default every one
  // Tier packing needs the exact diff layout calculated after ranking and before the prompts are built.
  promptView?: (
    ranks: ReadonlyMap<string, number>,
    dependents?: ReadonlyMap<string, number>,
  ) => {
    inline: (path: string) => boolean
    diffShown: (path: string) => boolean
  }
}

type Confirmed =
  | { kind: "time" | "unsupported" | "error"; path: string }
  | { kind: "read"; path: string; text: string; references: Reference[]; parsed: boolean }

type Run = (
  args: string[],
  options?: { maxOutputBytes?: number; stdin?: string; noMatch?: boolean },
) => Effect.Effect<Git.Result | undefined>

/**
 * Reads and parses each changed file on each side it has. Exported for VS-24 wiring, which needs the same ranges. It
 * runs inside `deadline` (IMPACT_LIMITS.timeBoxMs from now by default) and, unless the caller passes `missing`, lists
 * what a partial clone lacks first and never shows it.
 */
type Reader = Pick<Git.Interface, "run">
interface ParseInput {
  directory: string
  base: string
  head: string
  files: readonly DiffFile[]
  deadline?: number
  missing?: (path: string, side: Side) => boolean
}
const parseFrom = Effect.fnUntraced(function* (git: Reader, input: ParseInput) {
  const deadline = input.deadline ?? performance.now() + IMPACT_LIMITS.timeBoxMs
  const run = runner(git, input.directory, deadline, new Set())
  const missing = input.missing ?? (yield* lacking(run, input.head, input.base))
  return yield* readChanged(run, { ...input, deadline, missing })
})

/**
 * Each path's import lines at the head tree-ish (readImports), outside a build; for tests and the bench. It runs
 * inside `deadline` (IMPACT_LIMITS.timeBoxMs from now by default) and never reads a path whose blob a partial clone
 * lacks: such a path, like any unread one, is left out of the map.
 */
interface ImportInput {
  directory: string
  head: string
  paths: readonly string[]
  deadline?: number
}
const importsFrom = Effect.fnUntraced(function* (git: Reader, input: ImportInput) {
  const run = runner(git, input.directory, input.deadline ?? performance.now() + IMPACT_LIMITS.timeBoxMs, new Set())
  if (!revision(input.head)) return new Map<string, string>()
  const lacks = yield* lacking(run, input.head)
  return yield* readImports(
    run,
    input.head,
    input.paths.filter((file) => !lacks?.(file, "RIGHT")),
  )
})

/**
 * The Tier 1 slice for a change from `base` to `head`, in steps ordered so that an early stop still yields a usable
 * slice: scan the clone, list what a partial clone lacks, read the tree and the changed files, read the workspace
 * manifests, grep the changed exported names once, gate the candidates by their import lines, parse-confirm the
 * gated files in rank order, and pack.
 */
export interface BuildResult {
  slice: ImpactSlice
  changed: ChangedFiles
  changedRanks?: ReadonlyMap<string, number>
  batchClusters?: ReadonlyMap<string, string>
  dependentsByFile?: ReadonlyMap<string, number>
}

const buildFrom = Effect.fnUntraced(function* (
  git: Reader,
  input: BuildInput,
  denied: readonly string[] = [],
  inventory?: ReturnType<typeof treeEntries>,
) {
  const started = performance.now()
  const deadline = started + (input.budgetMs ?? IMPACT_LIMITS.timeBoxMs)
  const incomplete = new Set<ImpactIncomplete>()
  const timing = { grepMs: 0, parseMs: 0 }
  const run = runner(git, input.directory, deadline, incomplete)
  const scan = { gitVersion: "", clone: { partial: false, sparse: false }, unsearched: 0 }
  const tiered = input.packing ? impactPacking(input.packing) : undefined
  // The tokens are counted here, from the block as rendered with its note, once `incomplete` and `unsearched` are known.
  // A tiered slice that stopped before packing still carries its (empty) tiers, so it reads as tiered.
  let batchClusters: Map<string, string> | undefined
  let dependentsByFile: Map<string, number> | undefined
  const finish = (
    slice: Partial<ImpactSlice>,
    changed: ChangedFiles,
    changedRanks?: ReadonlyMap<string, number>,
  ): BuildResult => {
    const done = {
      ...emptySlice(),
      ...(tiered && slice.scopes === undefined
        ? tiersOf(
            packTiers({
              files: input.files,
              changed: [],
              source: () => undefined,
              references: [],
              ranks: new Map(),
              text: () => undefined,
              context: input.context,
              fallback: changedFallback(input.files, changed),
              packing: tiered,
              ...views(input),
            }),
          )
        : {}),
      ...slice,
      plan: "tree-ish" as const,
      gitVersion: scan.gitVersion,
      clone: scan.clone,
      grepMs: Math.round(timing.grepMs),
      parseMs: Math.round(timing.parseMs + changed.parseMs),
      ms: Math.round(performance.now() - started),
      ...(incomplete.size ? { incomplete: IMPACT_INCOMPLETE.filter((reason) => incomplete.has(reason)) } : {}),
      ...(scan.unsearched ? { unsearched: scan.unsearched } : {}),
    }
    return {
      slice: { ...done, tokens: impactTokens(done) },
      changed,
      ...(changedRanks ? { changedRanks } : {}),
      ...(batchClusters ? { batchClusters, dependentsByFile } : {}),
    }
  }
  const given = input.changed ?? noFiles()
  const packOnly = (changed: ChangedFiles) => {
    if (tiered) {
      const packed = packTiers({
        files: input.files,
        changed: changedDefinitions(input.files, changed.definitions),
        source: tierSource(changed),
        references: [],
        ranks: new Map(),
        text: () => undefined,
        context: input.context,
        fallback: changedFallback(input.files, changed),
        packing: tiered,
        ...views(input),
      })
      return finish(
        {
          changed: packed.changed,
          locations: packed.locations,
          unsupported: changed.unsupported.toSorted(),
          dropped: { ...emptySlice().dropped, definitions: packed.definitions },
          ...tiersOf(packed),
        },
        changed,
      )
    }
    const packed = packSlice({
      changed: changedDefinitions(input.files, changed.definitions),
      references: [],
      ranks: new Map(),
      text: () => undefined,
      context: input.context,
    })
    return finish(
      {
        changed: packed.changed,
        locations: packed.locations,
        unsupported: changed.unsupported.toSorted(),
        dropped: { ...emptySlice().dropped, definitions: packed.definitions },
      },
      changed,
    )
  }

  if (!revision(input.base) || !revision(input.head)) {
    incomplete.add("error")
    return finish({}, given)
  }

  // 1. The scan plan (VS-38 item 1, tree-ish only): git's version and the clone's mode, zero tokens.
  const scanned = yield* scanClone(run)
  scan.gitVersion = scanned.gitVersion
  scan.clone = scanned.clone

  // 2. A partial clone, or one whose config could not be read (VS-38 item 3): what it lacks, listed without fetching.
  // A missing head tree means the paths under it are unknown, so nothing is read; a missing blob is never read,
  // searched or made a candidate.
  const present = scanned.guarded ? yield* presence(run, input.head, input.base) : undefined
  if (present === null) {
    if (scan.clone.partial) incomplete.add("partial-clone")
    return input.changed ? packOnly(input.changed) : finish({}, given)
  }

  // 3. The head tree (already listed in a partial clone, where -l would read blob sizes) and the changed files.
  const [tree, changed] = yield* Effect.all(
    [
      present || inventory
        ? Effect.succeed(undefined)
        : run(["ls-tree", "-r", "-z", "-l", "--full-tree", input.head], { maxOutputBytes: TREE_BYTES }),
      input.changed ? Effect.succeed(input.changed) : readChanged(run, { ...input, deadline, missing: present?.lacks }),
    ],
    { concurrency: "unbounded" },
  )
  if (changed.missing.length) incomplete.add("partial-clone")
  const entries = present
    ? present.head
    : (inventory ?? (tree && tree.exitCode === 0 && !tree.truncated ? treeEntries(tree.text()) : undefined))
  if (!entries) return packOnly(changed)
  // Regular and executable files; links and submodules drop out.
  const blobs = new Map(
    [...entries].filter(([, entry]) => entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")),
  )
  const missing = present ? [...blobs].flatMap(([file, entry]) => (present.lacking.has(entry.oid) ? [file] : [])) : []
  scan.unsearched = missing.length
  if (missing.length) incomplete.add("partial-clone")
  const unread = new Set(missing)
  const excludes = [
    ...(input.ignore ?? []).map((glob) => `:(top,exclude,glob)${glob}`),
    ...collapse([...new Set([...missing, ...denied])], [...entries.keys()]).map(
      (file) => `:(top,exclude,literal)${file}`,
    ),
  ]
  // When every blob is missing there is nothing to search; when the excludes do not fit one command line, a search
  // could reach a missing blob (or an ignored path), so none runs.
  const fits = chars(excludes) <= ARG_CHARS
  const searchable = missing.length < blobs.size && fits
  if (!fits) incomplete.add("error")

  for (const file of denied) blobs.delete(file)

  // 4. The names: the changed exported definitions, a moved file's exports, and changedSymbols or BrainCode.symbols for
  // the files the parser did not read; and, for each changed module, the names it gives.
  const definitions = changedDefinitions(input.files, changed.definitions)
  const fallback = fallbackNames(input.files, changed)
  const names = impactNames(
    definitions,
    fallback.map((item) => item.name),
  )
  const namesOf = moduleNames(input.files, definitions, fallback)
  const own = new Set(changedPaths(input.files))
  const lookup = BrainCode.lookup([...new Set([...blobs.keys(), ...own])])

  // 5. The workspace manifests and the candidates: one uncapped grep of every name (VS-36 item 1), names on stdin.
  const grepStart = performance.now()
  const [manifests, listed] = yield* Effect.all(
    [
      searchable
        ? run(
            [
              "grep",
              "-n",
              "-z",
              "-I",
              "--no-color",
              "--no-column",
              "--full-name",
              "-e",
              "",
              input.head,
              "--",
              ...MANIFESTS,
              ...excludes,
            ],
            {
              maxOutputBytes: MANIFEST_BYTES,
              noMatch: true,
            },
          )
        : Effect.succeed(undefined),
      searchable && names.length
        ? run(
            [
              "grep",
              "-l",
              "-z",
              "-w",
              "-F",
              "-I",
              "--no-color",
              "--no-column",
              "--full-name",
              "-f",
              "-",
              input.head,
              "--",
              ":/",
              ...excludes,
            ],
            { maxOutputBytes: GREP_BYTES, stdin: names.join("\n"), noMatch: true },
          )
        : Effect.succeed(undefined),
    ],
    { concurrency: "unbounded" },
  )
  // The manifests are the head's, which a fork's author writes: BrainCode.workspace is bounded and gets the deadline,
  // and a throw leaves the workspace out and marks the slice an error.
  const materialized = lines(manifests, input.head)
  if (!materialized) incomplete.add("output")
  const attempted = manifests !== undefined && materialized !== undefined && performance.now() < deadline
  const read = attempted
    ? yield* Effect.option(
        Effect.try({
          try: () =>
            BrainCode.workspace(
              [...materialized!].map(([file, text]) => ({ path: file, text })),
              { deadline },
            ),
          catch: (cause) => cause,
        }),
      )
    : Option.none()
  if (attempted && Option.isNone(read)) incomplete.add("error")
  if (performance.now() >= deadline) incomplete.add("time")
  const workspace = Option.getOrUndefined(read)
  const candidates = [
    ...new Set(
      (listed?.exitCode === 0 ? listed.text() : "")
        .split("\0")
        .flatMap((entry) => (entry.startsWith(`${input.head}:`) ? [entry.slice(input.head.length + 1)] : [])),
    ),
  ].filter((file) => blobs.has(file) && !own.has(file) && !unread.has(file))

  // 6. The gate (VS-36 item 2): the import lines of every candidate and every barrel, then selectDependents.
  // Only code BrainCode reads imports from can pass the gate, so any other candidate is checked by its path alone, and a
  // file over the parser's cap is left unchecked: it could not be confirmed.
  const readable = (file: string) =>
    importable(file) && (blobs.get(file)?.size ?? 0) <= ReviewParse.PARSE_LIMITS.inputBytes && !unread.has(file)
  const reads = [
    ...new Set([...candidates, ...barrels([...own], lookup).filter((file) => blobs.has(file))].filter(readable)),
  ]
  const imported = yield* readImports(run, input.head, reads, () => incomplete.add("output"))
  const imports = new Map([
    ...candidates.flatMap((file) => (importable(file) ? [] : [[file, ""] as const])),
    ...imported,
  ])
  timing.grepMs += performance.now() - grepStart
  const selection = selectDependents({
    files: input.files,
    candidates,
    imports: (file) => imports.get(file),
    lookup,
    workspace,
    ignored: input.ignored,
  })
  if (input.batchClusters) {
    // A gated importer reaches these exact changed modules in the verified commit.
    // Connected components group files sharing an importer; raw graph labels never enter prompts/state.
    batchClusters = new Map()
    dependentsByFile = new Map()
    const parent = batchClusters
    const representative = (path: string) => {
      let root = path
      while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!
      while (path !== root && parent.has(path)) {
        const next = parent.get(path)!
        parent.set(path, root)
        path = next
      }
      return root
    }
    for (const candidate of selection.confirm) {
      for (const path of candidate.reaches) dependentsByFile.set(path, (dependentsByFile.get(path) ?? 0) + 1)
      const [first, ...rest] = candidate.reaches
      if (!first) continue
      for (const path of rest) {
        const left = representative(first),
          right = representative(path)
        if (left !== right) parent.set(left < right ? right : left, left < right ? left : right)
      }
    }
    for (const file of input.files) parent.set(file.path, representative(file.path))
  }

  // 7. Confirm in rank order, at most IMPACT_LIMITS.confirm files, before the deadline. A file's call sites are those
  // of the names the changed modules it reaches give, so a same-named local or a name from a module it does not import
  // is not one; its import statements are left out, since the gate already holds the import.
  const confirmed = yield* Effect.forEach(
    selection.confirm,
    (entry) =>
      Effect.gen(function* () {
        const left = (kind: "time" | "unsupported" | "error"): Confirmed => ({ kind, path: entry.path })
        if (performance.now() >= deadline) return left("time")
        const size = blobs.get(entry.path)?.size
        if (size !== undefined && size > ReviewParse.PARSE_LIMITS.inputBytes) return left("unsupported")
        const shown = yield* run(["show", "--no-textconv", `${input.head}:${entry.path}`], {
          maxOutputBytes: ReviewParse.PARSE_LIMITS.inputBytes + 1,
        })
        if (!shown) return left("time")
        if (shown.exitCode !== 0) return left("error")
        // A truncated read would give partial hits, so a file over the parser's cap is not read at all.
        if (shown.truncated || shown.stdout.includes(0)) return left("unsupported")
        const text = shown.text()
        const wanted = new Set(entry.reaches.flatMap((module) => [...(namesOf.get(module) ?? [])]))
        const reference = (line: number, name: string, enclosing?: string): Reference => ({
          path: entry.path,
          line,
          name,
          ...(enclosing ? { enclosing } : {}),
          importsChanged: entry.importsChanged,
        })
        const parsed = yield* ReviewParse.parse({
          path: entry.path,
          text,
          names: wanted,
          deadline,
          ...(tiered ? { statements: true } : {}),
        })
        if (parsed.parsed) {
          timing.parseMs += parsed.parseMs + parsed.extractMs
          const references = parsed.references
            .filter((item) => item.kind !== "import" && wanted.has(item.name))
            .map((item) => ({
              ...reference(item.line, item.name, item.enclosing),
              ...(item.statement ? { statement: item.statement } : {}),
            }))
          return { kind: "read", path: entry.path, text, references, parsed: true } satisfies Confirmed
        }
        if (parsed.because === "timeout" && performance.now() >= deadline) return left("time")
        const language = BrainCode.language(entry.path)
        const statements = language ? BrainCode.importLines(text, language) : new Set<number>()
        const references = wordHits(text, wanted)
          .filter((hit) => !statements.has(hit.line))
          .map((hit) => reference(hit.line, hit.name))
        return { kind: "read", path: entry.path, text, references, parsed: false } satisfies Confirmed
      }),
    { concurrency: READ_CONCURRENCY },
  )
  const time = confirmed.flatMap((item) => (item.kind === "time" ? [item.path] : []))
  if (time.length) incomplete.add("time")
  if (confirmed.some((item) => item.kind === "error")) incomplete.add("error")
  const texts = new Map(confirmed.flatMap((item) => (item.kind === "read" ? [[item.path, item.text] as const] : [])))

  // 8. Tiered only (VS-37a): tier b's targets, read after confirmation, inside what is left of the box.
  if (tiered) {
    const outbound = tiered.tiers.includes("b")
      ? yield* readTargets(runner(git, input.directory, deadline, new Set()), {
          head: input.head,
          files: input.files,
          changed,
          lookup,
          workspace,
          blobs,
          own,
          unread,
          ignore: input.ignore ?? [],
          ignored: input.ignored,
          deadline,
        })
      : undefined
    const packed = packTiers({
      files: input.files,
      changed: definitions,
      source: tierSource(changed),
      ...(outbound ? { outbound } : {}),
      references: confirmed.flatMap((item) => (item.kind === "read" ? item.references : [])),
      ranks: new Map(selection.confirm.map((entry) => [entry.path, entry.rank])),
      text: (file) => texts.get(file),
      context: input.context,
      tests: selection.tests,
      fallback: [...changedFallback(input.files, changed), ...(outbound?.fallback ?? [])],
      unread: outbound?.unread ?? [],
      external: outbound?.external ?? 0,
      packing: tiered,
      ...views(input, selection.changedRanks, dependentsByFile),
    })
    return finish(
      {
        changed: packed.changed,
        dependents: packed.dependents,
        tests: selection.tests,
        unsupported: unsupportedOf(changed, confirmed),
        locations: packed.locations,
        stages: {
          candidates: candidates.length,
          gated: selection.confirm.length + selection.cap.length,
          confirmed: packed.confirmed,
          packed: packed.dependents.length,
        },
        dropped: {
          ignored: selection.ignored,
          unchecked: selection.unchecked,
          gate: selection.gate,
          cap: selection.cap,
          time,
          budget: packed.budget,
          definitions: packed.definitions,
        },
        ...tiersOf(packed),
      },
      changed,
      selection.changedRanks,
    )
  }

  // 9. Pack.
  const packed = packSlice({
    changed: definitions,
    references: confirmed.flatMap((item) => (item.kind === "read" ? item.references : [])),
    ranks: new Map(selection.confirm.map((entry) => [entry.path, entry.rank])),
    text: (file) => texts.get(file),
    context: input.context,
    tests: selection.tests,
  })
  return finish(
    {
      changed: packed.changed,
      dependents: packed.dependents,
      tests: selection.tests,
      unsupported: unsupportedOf(changed, confirmed),
      locations: packed.locations,
      stages: {
        candidates: candidates.length,
        gated: selection.confirm.length + selection.cap.length,
        confirmed: packed.confirmed,
        packed: packed.dependents.length,
      },
      dropped: {
        ignored: selection.ignored,
        unchecked: selection.unchecked,
        gate: selection.gate,
        cap: selection.cap,
        time,
        budget: packed.budget,
        definitions: packed.definitions,
      },
    },
    changed,
    selection.changedRanks,
  )
})

// CPU and scheduling tests can exercise the graph algorithm with a controlled reader on hosts without the
// private port. None of the production entry points accept this reader or a cached caller-supplied parse.
export const algorithm = { build: buildFrom, parseChanged: parseFrom, importLines: importsFrom }

export const parseChanged = Effect.fn("ReviewImpact.parseChanged")(function* (input: ParseInput) {
  const deadline = input.deadline ?? performance.now() + IMPACT_LIMITS.timeBoxMs
  return yield* ReviewSnapshot.within(
    input,
    deadline,
    (view) =>
      parseFrom(ReviewGit.impactClient(view, input.directory, input.head, input.base), {
        ...input,
        deadline,
        missing: undefined,
      }),
    noFiles,
  )
})

export const importLines = Effect.fn("ReviewImpact.importLines")(function* (input: ImportInput) {
  const deadline = input.deadline ?? performance.now() + IMPACT_LIMITS.timeBoxMs
  return yield* ReviewSnapshot.within(
    input,
    deadline,
    (view) => importsFrom(ReviewGit.impactClient(view, input.directory, input.head), { ...input, deadline }),
    () => new Map<string, string>(),
  )
})

export const build = Effect.fn("ReviewImpact.build")(function* (input: BuildInput) {
  const start = performance.now()
  const deadline = start + Math.min(60_000, input.budgetMs ?? IMPACT_LIMITS.timeBoxMs)
  const unavailable = (reason: ImpactIncomplete): BuildResult => {
    const slice = { ...emptySlice(), incomplete: [reason], ms: Math.round(performance.now() - start) }
    slice.tokens = impactTokens(slice)
    return { slice, changed: noFiles() }
  }
  return yield* ReviewSnapshot.within(
    input,
    deadline,
    (view) =>
      Effect.gen(function* () {
        const git = ReviewGit.impactClient(view, input.directory, input.head, input.base)
        // Private info attributes/excludes, when present, could change what is eligible. They have no committed version.
        if (view.repository.hasInfoRules !== false) return unavailable("error")
        const run = runner(git, input.directory, deadline, new Set())
        // Reuse the head inventory in the graph. Only the base attribute policy needs a second (size-free) listing.
        const tree = (rev: string, sizes: boolean) =>
          run(["ls-tree", "-r", "-z", ...(sizes ? ["-l"] : []), "--full-tree", rev], {
            maxOutputBytes: 12 * 1024 * 1024,
          })
        const head = yield* tree(input.head, true)
        const base = input.base === input.head ? head : yield* tree(input.base, false)
        if (!base || !head) return unavailable("time")
        if (base.truncated || head.truncated) return unavailable("output")
        if (base.exitCode !== 0 || head.exitCode !== 0) return unavailable("error")
        const inventory = (read: Git.Result) => {
          let count = 0
          for (let index = read.stdout.indexOf(0); index >= 0; index = read.stdout.indexOf(0, index + 1)) {
            if (++count > 50_000) return
          }
          const source = read.stdout.toString("utf8")
          if (!Buffer.from(source).equals(read.stdout)) return
          const entries = treeEntries(source)
          if (
            entries.size !== count ||
            [...entries.keys()].some((file) => !ReadOnlyGit.repositoryPath(file) || file.split("/").length > 64)
          )
            return
          return entries
        }
        const heads = inventory(head)
        const bases = head === base ? heads : inventory(base)
        if (!heads || !bases) return unavailable("output")
        const held = input.holdback === "secrets"
        const config = { ignore: [...(input.ignore ?? [])], ignoreDefaults: false }
        const disallowed = (file: string) =>
          !ReadOnlyGit.repositoryPath(file) ||
          input.ignored?.(file) === true ||
          classifyPath(file, { config }) !== undefined ||
          (held && (heldReason(file) !== undefined || holdbackText(file) !== file))
        // Read only the trusted base's policy. A symbolic link or policy we cannot understand can't establish permission
        // to include that directory. Limit both the per-file and aggregate policy work before opening it.
        const rules = new Map<string, (file: string) => boolean>()
        let uncertainPolicy = false
        let ruleCount = 0
        const prohibitDirectory = (dir: string) => {
          uncertainPolicy = true
          rules.set(dir, () => true)
        }
        const policies = [...bases].filter(([file]) => file === ".gitattributes" || file.endsWith("/.gitattributes"))
        if (policies.length > 64) return unavailable("output")
        for (const [file, entry] of policies) {
          const dir = file.slice(0, -".gitattributes".length)
          if (disallowed(file) || !["100644", "100755"].includes(entry.mode)) {
            prohibitDirectory(dir)
            continue
          }
          const shown = yield* run(["show", "--no-textconv", input.base + ":" + file], { maxOutputBytes: 32 * 1024 })
          if (!shown) return unavailable("time")
          if (shown.exitCode !== 0 || shown.truncated || shown.stdout.includes(0)) {
            prohibitDirectory(dir)
            continue
          }
          const attrs = shown
            .text()
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"))
          ruleCount += attrs.length
          if (ruleCount > 1_024) return unavailable("output")
          if (attrs.some((line) => line.length > 1_024 || !/^\/?[\w.*?/-]+(?:[ \t]+[\w.!=-]+)+$/.test(line))) {
            prohibitDirectory(dir)
            continue
          }
          const policy = parseGitAttributes(attrs.join("\n"))
          const binary = parseGitAttributes(
            attrs
              .flatMap((line) => {
                const [pattern, ...tokens] = line.split(/\s+/)
                return tokens.some((token) => ["binary", "-text", "-diff"].includes(token))
                  ? [pattern + " linguist-generated"]
                  : []
              })
              .join("\n"),
          )
          rules.set(
            dir,
            (relative) => policy.vendored(relative) || policy.generated(relative) || binary.generated(relative),
          )
        }
        const cache = new Map<string, boolean>()
        const denied = (file: string) => {
          const previous = cache.get(file)
          if (previous !== undefined) return previous
          const deny =
            disallowed(file) || [...rules].some(([dir, check]) => file.startsWith(dir) && check(file.slice(dir.length)))
          cache.set(file, deny)
          return deny
        }
        const regular = (entry: { type: string; mode: string } | undefined) =>
          entry?.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")
        const blocked: string[] = []
        for (const [file, entry] of heads) {
          if (performance.now() >= deadline) return unavailable("time")
          if (!regular(entry) || denied(file)) blocked.push(file)
        }
        const eligible = input.files.filter((file) => {
          const old = file.oldPath ?? file.path
          return (
            !denied(file.path) &&
            !denied(old) &&
            (file.status === "deleted" || regular(heads.get(file.path))) &&
            (file.status === "added" || regular(bases.get(old)))
          )
        })
        if (performance.now() >= deadline) return unavailable("time")
        const files = held ? holdbackFiles(eligible, { ignored: [] }).files : eligible
        const reader: Reader = held
          ? {
              run: (args, options) =>
                git.run(args, options).pipe(
                  Effect.map((result) => {
                    if (args[0] !== "show" || result.exitCode !== 0 || result.truncated || result.stdout.includes(0))
                      return result
                    // Preserve line numbers and redact whole blobs before indexing. A window can start halfway through a key.
                    const text = holdbackLines(result.text().split("\n")).join("\n")
                    return { ...result, stdout: Buffer.from(text), text: () => text }
                  }),
                ),
            }
          : git
        const result = yield* buildFrom(
          reader,
          {
            ...input,
            files,
            packing: input.packing ?? {},
            changed: undefined,
            // The inventory evaluated the review classifier's globs. Forward only its literal exclusions to Git,
            // whose pathspec grammar differs (including escaped brackets and anchored patterns).
            ignore: [],
            ignored: denied,
            budgetMs: deadline - performance.now(),
          },
          blocked,
          heads,
        )
        result.slice.ms = Math.round(performance.now() - start)
        if (uncertainPolicy && !result.slice.incomplete?.includes("error")) {
          result.slice.incomplete = [...(result.slice.incomplete ?? []), "error"]
          result.slice.tokens = impactTokens(result.slice)
        }
        return result
      }),
    unavailable,
  ).pipe(Effect.map((result) => ({ ...result, slice: capImpactSlice(result.slice, input.context) })))
})

// Reads from the supplied immutable Git view, with lazy fetching off and inside the time box. Undefined when the box ran out first
// (interrupting git, which AppProcess's scope then kills). An exit other than 0, or 1 with nothing on stderr where
// "no match" is allowed, marks the slice incomplete as an error.
function runner(git: Reader, cwd: string, deadline: number, incomplete: Set<ImpactIncomplete>): Run {
  return (args, options = {}) =>
    Effect.gen(function* () {
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        incomplete.add("time")
        return undefined
      }
      const result = yield* git
        .run(args, {
          cwd,
          env: ENV,
          ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
          ...(options.stdin !== undefined ? { stdin: Stream.make(new TextEncoder().encode(options.stdin)) } : {}),
        })
        .pipe(Effect.timeoutOption(Number.isFinite(remaining) ? remaining : 2_147_483_647))
      if (Option.isNone(result)) {
        incomplete.add("time")
        return undefined
      }
      const value = result.value
      const nothing = options.noMatch && value.exitCode === 1 && value.stderr.length === 0
      // A `git show` past its limit is a file over the parser's cap, and one that fails is a file the revision does
      // not have; each caller decides what that means.
      if (args[0] === "show") return value
      if (value.exitCode !== 0 && !nothing) incomplete.add("error")
      if (value.truncated) incomplete.add("output")
      return value
    })
}

const readChanged = Effect.fnUntraced(function* (
  run: Run,
  input: {
    base: string
    head: string
    files: readonly DiffFile[]
    deadline?: number
    missing?: (path: string, side: Side) => boolean
  },
) {
  const sides = input.files.flatMap((file) =>
    file.binary
      ? []
      : [
          ...(file.status === "deleted" ? [] : [{ path: file.path, side: "RIGHT" as const, rev: input.head }]),
          ...(file.status === "added"
            ? []
            : [{ path: file.oldPath ?? file.path, side: "LEFT" as const, rev: input.base }]),
        ],
  )
  const read = yield* Effect.forEach(
    sides,
    (item) =>
      Effect.gen(function* () {
        if (input.base.startsWith("-") || input.head.startsWith("-")) return { ...item }
        if (input.missing?.(item.path, item.side)) return { ...item, missing: true }
        const shown = yield* run(["show", "--no-textconv", `${item.rev}:${item.path}`], {
          maxOutputBytes: ReviewParse.PARSE_LIMITS.inputBytes + 1,
        })
        // A blob the revision does not have, a binary one, or one over the parser's cap is not read.
        if (!shown || shown.exitCode !== 0 || shown.stdout.includes(0)) return { ...item }
        if (shown.truncated) return { ...item, large: true }
        const text = shown.text()
        const parsed = yield* ReviewParse.parse({
          path: item.path,
          text,
          ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
        })
        return { ...item, text, parsed }
      }),
    { concurrency: READ_CONCURRENCY },
  )
  const key = (path: string, side: Side) => `${side}\0${path}`
  const byKey = new Map(read.map((item) => [key(item.path, item.side), item]))
  const parsedOf = (path: string, side: Side) => {
    const item = byKey.get(key(path, side))
    return item && "parsed" in item && item.parsed?.parsed ? item.parsed : undefined
  }
  const definitions = new Map(
    read.flatMap((item) => {
      const parsed = parsedOf(item.path, item.side)
      return parsed
        ? [
            [
              key(item.path, item.side),
              parsed.definitions.map((definition) => definitionOf(item.path, item.side, definition)),
            ] as const,
          ]
        : []
    }),
  )
  // Only tiers a and b read the references on the changed lines, so each side's are picked out on its first ask: a
  // build without tiers, or a parseChanged caller that never asks, does no more than before.
  const references = new Map<string, readonly SourceReference[] | undefined>()
  return {
    text: (path, side) => {
      const item = byKey.get(key(path, side))
      return item && "text" in item ? item.text : undefined
    },
    definitions: (path, side) => definitions.get(key(path, side)),
    comments: (path, side) => parsedOf(path, side)?.comments,
    strings: (path, side) => parsedOf(path, side)?.strings,
    references: (path, side) => {
      const at = key(path, side)
      if (!references.has(at)) references.set(at, changedReferences(input.files, parsedOf(path, side), path, side))
      return references.get(at)
    },
    unsupported: [
      ...new Set(
        read.filter((item) => !("missing" in item) && !parsedOf(item.path, item.side)).map((item) => item.path),
      ),
    ].toSorted(),
    missing: read
      .filter((item) => "missing" in item)
      .map((item) => (item.side === "RIGHT" ? item.path : `base:${item.path}`))
      .toSorted(),
    large: read
      .filter((item) => "large" in item)
      .map((item) => (item.side === "RIGHT" ? item.path : `base:${item.path}`))
      .toSorted(),
    parseMs: read.reduce((sum, item) => {
      const parsed = "parsed" in item && item.parsed?.parsed ? item.parsed : undefined
      return sum + (parsed ? parsed.parseMs + parsed.extractMs : 0)
    }, 0),
  } satisfies ChangedFiles
})

/**
 * Each path's import lines from one tree-ish `git grep -E` per chunk of `:(top,literal)` pathspecs of at most ARG_CHARS
 * characters, rebuilt at full length with every other line blank. A path of a finished chunk with no such line maps
 * to "", so undefined means never read: its chunk ran out of time, failed or passed its output limit.
 */
const readImports = Effect.fnUntraced(function* (
  run: Run,
  head: string,
  paths: readonly string[],
  overLimit?: () => void,
) {
  const chunks = paths.reduce<string[][]>((all, file) => {
    const spec = `:(top,literal)${file}`
    const last = all.at(-1)
    if (last && chars(last) + spec.length + 1 <= ARG_CHARS) {
      last.push(spec)
      return all
    }
    all.push([spec])
    return all
  }, [])
  let retained = 0
  const done = yield* Effect.forEach(
    chunks,
    (chunk) =>
      run(
        [
          "grep",
          "-n",
          "-z",
          "-I",
          "--no-color",
          "--no-column",
          "--full-name",
          "-E",
          "-e",
          IMPORT_LINE.map((pattern) => `(${pattern})`).join("|"),
          head,
          "--",
          ...chunk,
        ],
        { maxOutputBytes: GREP_BYTES, noMatch: true },
      ).pipe(
        Effect.map((result) => {
          if (
            !result ||
            result.truncated ||
            (result.exitCode !== 0 && !(result.exitCode === 1 && !result.stderr.length))
          )
            return []
          const found = lines(result, head, GREP_BYTES - retained)
          if (!found) {
            overLimit?.()
            return []
          }
          for (const text of found.values()) retained += text.length
          return chunk.map((spec) => {
            const file = spec.slice(":(top,literal)".length)
            return [file, found.get(file) ?? ""] as const
          })
        }),
      ),
    { concurrency: CHUNK_CONCURRENCY },
  )
  return new Map(done.flat())
})

// `git grep -n -z` output of a tree-ish, rebuilt into each path's text: its matched lines at their numbers, never
// trimmed or clipped, and every other line blank.
function lines(result: Git.Result | undefined, head: string, limit = GREP_BYTES) {
  if (!result || result.exitCode !== 0) return new Map<string, string>()
  // Grep emits matches in source order. Sparse matches near the end of many files must not expand into
  // millions of array entries per file. Bound both the reconstructed file and the total before expanding.
  const files = new Map<string, { last: number; size: number; parts: string[] }>()
  let total = 0
  for (const line of result.text().split("\n")) {
    const name = line.indexOf("\0")
    const number = line.indexOf("\0", name + 1)
    if (name < 0 || number < 0 || !line.startsWith(head + ":")) continue
    const file = line.slice(head.length + 1, name)
    const at = Number(line.slice(name + 1, number))
    const value = line.slice(number + 1)
    const found = files.get(file) ?? { last: 0, size: 0, parts: [] }
    if (!Number.isSafeInteger(at) || at <= found.last) return
    const spacing = at - (found.last || 1)
    const chars = spacing + value.length
    total += chars
    found.size += chars
    if (total > limit || found.size > ReviewParse.PARSE_LIMITS.inputBytes) return
    found.parts.push("\n".repeat(spacing), value)
    found.last = at
    files.set(file, found)
  }
  return new Map([...files].map(([file, found]) => [file, found.parts.join("")]))
}

// The entries of `git ls-tree -r -z [-l]` by path: mode, type, object ID and, when -l gave it, size.
function treeEntries(text: string) {
  return new Map(
    text.split("\0").flatMap((entry) => {
      const tab = entry.indexOf("\t")
      if (tab < 0) return []
      const [mode, type, oid, size] = entry.slice(0, tab).split(/\s+/)
      if (!mode || !type || !oid) return []
      const bytes = size === undefined ? undefined : Number(size)
      return [
        [
          entry.slice(tab + 1),
          { mode, type, oid, size: bytes !== undefined && Number.isFinite(bytes) ? bytes : undefined },
        ] as const,
      ]
    }),
  )
}

// The clone's mode (VS-38 items 1 and 3), zero tokens. A config git could not read leaves `partial` unknown, so the
// clone is `guarded`: the presence check runs and nothing asks for a blob's size, as in a partial clone.
const scanClone = Effect.fnUntraced(function* (run: Run) {
  const version = yield* run(["version"])
  const config = yield* run(
    ["config", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.promisor|core\\.sparsecheckout)$"],
    { noMatch: true },
  )
  const known = config !== undefined && (config.exitCode === 0 || (config.exitCode === 1 && !config.stderr.length))
  const settings = (config?.exitCode === 0 ? config.text() : "")
    .split("\n")
    .map((line) => [line.slice(0, line.indexOf(" ")).toLowerCase(), line.slice(line.indexOf(" ") + 1).trim()] as const)
  const on = (value: string) => /^(true|yes|on|1)$/i.test(value)
  const clone = {
    partial: settings.some(([key, value]) =>
      key === "extensions.partialclone" ? value !== "" : key.endsWith(".promisor") && on(value),
    ),
    sparse: settings.some(([key, value]) => key === "core.sparsecheckout" && on(value)),
  }
  return {
    gitVersion:
      version?.exitCode === 0
        ? version
            .text()
            .trim()
            .replace(/^git version\s+/, "")
        : "",
    clone,
    guarded: clone.partial || !known,
  }
})

// What a partial clone lacks (VS-38 item 3), listed without fetching. `git rev-list --missing=print` never fetches,
// and lists a missing object once as "?<oid>", however many paths hold it (it lists a present one at the first path
// it reaches), so presence is read by object ID against each path's entry in `git ls-tree`, which reads trees only.
// Null when a head tree is missing or a listing failed or passed its limit, so no path can be trusted; a base whose
// trees are missing leaves every base side unread. A submodule's commit is never in the clone, so it counts as lacking.
const presence = Effect.fnUntraced(function* (run: Run, head: string, base?: string) {
  const whole = (result: Git.Result | undefined): result is Git.Result =>
    result !== undefined && result.exitCode === 0 && !result.truncated
  const trees = (rev: string) =>
    run(["rev-list", "--objects", "--no-walk", "--missing=print", "--filter=blob:none", rev], {
      maxOutputBytes: TREE_BYTES,
    })
  const [headTrees, baseTrees] = yield* Effect.all(
    [trees(head), base === undefined ? Effect.succeed(undefined) : trees(base)],
    { concurrency: "unbounded" },
  )
  if (!whole(headTrees) || /^\?/m.test(headTrees.text())) return null
  const readableBase = base !== undefined && whole(baseTrees) && !/^\?/m.test(baseTrees.text()) ? base : undefined
  const [objects, headTree, baseTree] = yield* Effect.all(
    [
      run(["rev-list", "--objects", "--no-walk", "--missing=print", head, ...(readableBase ? [readableBase] : [])], {
        maxOutputBytes: TREE_BYTES,
      }),
      run(["ls-tree", "-r", "-z", "--full-tree", head], { maxOutputBytes: TREE_BYTES }),
      readableBase
        ? run(["ls-tree", "-r", "-z", "--full-tree", readableBase], { maxOutputBytes: TREE_BYTES })
        : Effect.succeed(undefined),
    ],
    { concurrency: "unbounded" },
  )
  if (!whole(objects) || !whole(headTree)) return null
  const lackingIds = new Set(
    objects
      .text()
      .split("\n")
      .flatMap((line) => (line.startsWith("?") ? [line.slice(1).trim()] : [])),
  )
  const heads = treeEntries(headTree.text())
  const bases = whole(baseTree) ? treeEntries(baseTree.text()) : undefined
  return {
    head: heads,
    lacking: lackingIds,
    // A path a tree does not hold names no object, so showing it fails without a fetch.
    lacks: (file: string, side: Side) => {
      const entry = side === "RIGHT" ? heads.get(file) : bases?.get(file)
      if (side === "LEFT" && !bases) return true
      return entry !== undefined && (entry.type === "commit" || lackingIds.has(entry.oid))
    },
  }
})

// What `parseChanged` and `importLines` must not read: nothing in a full clone, everything when the presence check
// cannot be trusted or a revision could pass for an option.
const lacking = Effect.fnUntraced(function* (run: Run, head: string, base?: string) {
  if (!revision(head) || (base !== undefined && !revision(base))) return () => true
  const scanned = yield* scanClone(run)
  if (!scanned.guarded) return undefined
  const present = yield* presence(run, head, base)
  return present ? present.lacks : () => true
})

// A revision git cannot read as an option.
function revision(rev: string) {
  return rev !== "" && !rev.startsWith("-")
}

// The smallest set of excludes for the missing paths: each folder whose every blob is missing (sparse cones are
// folders), at its highest such level, then each missing path outside those folders.
function collapse(missing: readonly string[], all: readonly string[]) {
  if (!missing.length) return []
  const folders = (file: string) =>
    file
      .split("/")
      .slice(0, -1)
      .map((_, at, parts) => parts.slice(0, at + 1).join("/"))
  const count = (files: readonly string[]) =>
    files.reduce((map, file) => {
      folders(file).forEach((folder) => map.set(folder, (map.get(folder) ?? 0) + 1))
      return map
    }, new Map<string, number>())
  const total = count(all)
  const gone = count(missing)
  const full = new Set([...gone].filter(([folder, n]) => total.get(folder) === n).map(([folder]) => folder))
  const top = [...full].filter(
    (folder) =>
      !folders(`${folder}/x`)
        .slice(0, -1)
        .some((parent) => full.has(parent)),
  )
  const covered = (file: string) => folders(file).some((folder) => full.has(folder))
  return [...top.toSorted(), ...missing.filter((file) => !covered(file)).toSorted()]
}

// The fallback names, at most IMPACT_LIMITS.fallbackNames, each with the changed file it came from: a moved file's
// exports at its old path, then changedSymbols for refused files of a grammar language, then BrainCode.symbols at
// added lines for files without a grammar.
function fallbackNames(files: readonly DiffFile[], changed: ChangedFiles) {
  const refused = files.filter(
    (file) => !file.binary && file.status !== "deleted" && changed.unsupported.includes(file.path),
  )
  const declared = refused
    .filter((file) => !ReviewParse.languageOf(file.path))
    .flatMap((file) => {
      const language = BrainCode.language(file.path)
      const text = changed.text(file.path, "RIGHT")
      if (!language || !text) return []
      const added = new Set(
        file.hunks.flatMap((hunk) =>
          hunk.lines.flatMap((line) => (line.kind === "add" && line.newLine ? [line.newLine] : [])),
        ),
      )
      return BrainCode.symbols(text, language)
        .filter((symbol) => added.has(symbol.line))
        .map((symbol) => ({ path: file.path, name: symbol.name }))
    })
  const found = [
    ...files.flatMap((file) =>
      movedNames([file], changed.definitions).map((name) => ({ path: file.oldPath ?? file.path, name })),
    ),
    ...changedSymbols([...refused], IMPACT_LIMITS.fallbackNames).map((symbol) => ({
      path: symbol.path,
      name: symbol.name,
    })),
    ...declared,
  ]
  const kept = new Set([...new Set(found.map((item) => item.name))].slice(0, IMPACT_LIMITS.fallbackNames))
  return found.filter((item) => kept.has(item.name))
}

// The names each changed module gives, by both its paths when it moved: its changed exported definitions and its
// fallback names, filtered as impactNames filters them.
function moduleNames(
  files: readonly DiffFile[],
  definitions: readonly Definition[],
  fallback: readonly { path: string; name: string }[],
) {
  return new Map(
    files.flatMap((file) => {
      const paths = [...new Set([file.path, file.oldPath ?? file.path])]
      const names = new Set(
        impactNames(
          definitions.filter((definition) => paths.includes(definition.path)),
          fallback.filter((item) => paths.includes(item.path)).map((item) => item.name),
        ),
      )
      return paths.map((path) => [path, names] as const)
    }),
  )
}

// A parsed definition as the slice holds it, at its side's path.
function definitionOf(path: string, side: Side, definition: ReviewParse.ParsedDefinition): Definition {
  return {
    path,
    side,
    name: definition.name,
    kind: definition.kind,
    start: definition.start,
    end: definition.end,
    exported: definition.exported,
    signature: definition.signature,
    ...(definition.container ? { container: definition.container } : {}),
    ...(definition.aliases ? { aliases: definition.aliases } : {}),
  }
}

// What a slice records about the files it could not read: the changed files and the confirm-stage files the parser
// did not read, unique and sorted.
function unsupportedOf(changed: ChangedFiles, confirmed: readonly Confirmed[]) {
  return [
    ...new Set([
      ...changed.unsupported,
      ...confirmed.flatMap((item) =>
        item.kind === "unsupported" || (item.kind === "read" && !item.parsed) ? [item.path] : [],
      ),
    ]),
  ].toSorted()
}

// The parser's references on one side's changed lines: added lines for RIGHT, removed lines for LEFT (the old path).
function changedReferences(
  files: readonly DiffFile[],
  parsed: { references: readonly ReviewParse.ParsedReference[] } | undefined,
  path: string,
  side: Side,
): SourceReference[] | undefined {
  const file = files.findLast((item) => (side === "RIGHT" ? item.path : (item.oldPath ?? item.path)) === path)
  if (!parsed || !file) return undefined
  const lines = new Set(
    file.hunks
      .flatMap((hunk) => hunk.lines)
      .flatMap((line) =>
        side === "RIGHT"
          ? line.kind === "add" && line.newLine
            ? [line.newLine]
            : []
          : line.kind === "del" && line.oldLine
            ? [line.oldLine]
            : [],
      ),
  )
  return parsed.references
    .filter((reference) => lines.has(reference.line))
    .map((reference) => ({
      name: reference.name,
      line: reference.line,
      column: reference.column,
      kind: reference.kind,
    }))
}

// A parsed reference as tier b's lookups take it.
function sourceReference(reference: ReviewParse.ParsedReference): SourceReference {
  return { name: reference.name, line: reference.line, column: reference.column, kind: reference.kind }
}

// One side of a changed file as tiers a and b read it, from the changed files' parse.
function tierSource(changed: ChangedFiles) {
  return (path: string, side: Side): TierSource | undefined => {
    const text = changed.text(path, side)
    const definitions = changed.definitions(path, side)
    if (text === undefined || !definitions) return undefined
    return { text, definitions, references: changed.references?.(path, side) ?? [] }
  }
}

// Tier a's fallbacks, counted by changed path: a code file with no grammar ("a:unsupported"; a binary file, a failed
// read or another refusal is not one), a file over the parser's cap ("a:over-cap") and a file a partial clone lacks
// ("a:missing").
function changedFallback(files: readonly DiffFile[], changed: ChangedFiles): ImpactFallback[] {
  const bare = (entry: string) => (entry.startsWith("base:") ? entry.slice("base:".length) : entry)
  const large = new Set((changed.large ?? []).map(bare))
  const paths = new Set(files.filter((file) => !file.binary).flatMap((file) => [file.path, file.oldPath ?? file.path]))
  const unsupported = new Set(
    changed.unsupported.filter(
      (file) => paths.has(file) && !large.has(file) && importable(file) && !ReviewParse.languageOf(file),
    ),
  )
  const counted: [ImpactFallback["kind"], number][] = [
    ["a:unsupported", unsupported.size],
    ["a:over-cap", large.size],
    ["a:missing", new Set(changed.missing.map(bare)).size],
  ]
  return counted.flatMap(([kind, count]) => (count ? [{ kind, count }] : []))
}

// What the prompt shows of the changed files, for tier a: by default no file whole and every file's diff.
function views(
  input: Pick<BuildInput, "inline" | "diffShown" | "promptView">,
  ranks: ReadonlyMap<string, number> = new Map(),
  dependents?: ReadonlyMap<string, number>,
) {
  if (input.promptView) return input.promptView(ranks, dependents)
  return {
    ...(input.inline ? { inline: input.inline } : {}),
    ...(input.diffShown ? { diffShown: input.diffShown } : {}),
  }
}

// The fields only a slice packed in tiers carries.
function tiersOf(packed: ReturnType<typeof packTiers>): Partial<ImpactSlice> {
  return { scopes: packed.scopes, outbound: packed.outbound, fallback: packed.fallback, tiers: packed.tiers }
}

/**
 * Tier b's targets (VS-37a): the files the changed lines' imports name (core outboundUses), read from the head
 * tree-ish after confirmation, at most IMPACT_TIERS.targets of them, TARGET_CONCURRENCY at a time, with what their
 * barrels re-export followed for up to IMPACT_LIMITS.reexportDepth more rounds. First the ignore rules (`ignored`, and
 * the ignore globs through classifyPath) and BrainCode.excluded set a target aside, changed or not; then a changed
 * target is read from the changed files' parse. Before any other read, a target is set aside when the tree has no
 * such blob, a partial clone lacks it ("b:missing", never fetched), it is over the parser's cap ("b:over-cap") or no
 * grammar reads it ("b:unsupported"); past the read cap it is "b:over-cap" too. After a read, a generated header sets
 * it aside, and a timeout counts as "b:over-cap". Set-aside targets go to tiers.dropped.targets as "reason:path", which
 * packTiers sorts (the reads finish in any order); ignored, excluded and generated ones are never named to the model.
 * `run` marks nothing incomplete.
 *
 * VS-37c: then the other Go files of each changed Go file's folder (core samePackageLookups), sorted, through the same
 * checks and the same read (`git show --no-textconv` of the head tree-ish), counted against the same read cap after
 * every import target, with no re-export hop. They are read TARGET_CONCURRENCY at a time and stop once nothing is
 * left to look up (no member use, and every bare name bound), so a sibling never read for that reason is never named;
 * any member use keeps them going up to the read cap. A sibling is looked up on speculation, so one set aside goes to
 * tiers.dropped.targets as "reason:path" but never to a fallback the model is told. A read sibling's parse also keeps
 * its references to the lookups' member names. A changed sibling's definitions come from the changed files' parse; its
 * text is parsed again in memory for those member names only: a timeout there leaves it out ("time:"), and another
 * refusal leaves its members out ("unsupported:"). Each batch is bound (core samePackageUses) right after its reads,
 * and past the time box nothing more is: a batch read in time but bound after it is "time:" too. Nothing else is read.
 */
const readTargets = Effect.fnUntraced(function* (
  run: Run,
  input: {
    head: string
    files: readonly DiffFile[]
    changed: ChangedFiles
    lookup: BrainCode.Lookup
    workspace?: BrainCode.Workspace
    blobs: ReadonlyMap<string, { size?: number }>
    own: ReadonlySet<string>
    unread: ReadonlySet<string>
    ignore: readonly string[]
    ignored?: (path: string) => boolean
    deadline: number
  },
) {
  const found = outboundUses({
    files: input.files,
    source: tierSource(input.changed),
    lookup: input.lookup,
    workspace: input.workspace,
  })
  const lookups = samePackageLookups({
    files: input.files,
    source: tierSource(input.changed),
    paths: input.blobs.keys(),
  })
  const siblings = new Set(lookups.flatMap((lookup) => lookup.siblings))
  const members = new Set(lookups.flatMap((lookup) => lookup.uses.flatMap((use) => (use.member ? [use.name] : []))))
  const declared = new Map<string, SamePackageFile>()
  const definitions = new Map<string, readonly Definition[]>()
  const reexports = new Map<string, string[]>()
  const unread: string[] = []
  const fell = { "b:unsupported": new Set<string>(), "b:over-cap": new Set<string>(), "b:missing": new Set<string>() }
  const seen = new Set<string>()
  const reads = { count: 0 }
  // Set once the import targets are done: a same-package sibling is looked up on speculation (it may declare nothing
  // the change uses), so one set aside is named for the eval record but never counted as a fallback the model is told.
  const phase = { siblings: false }
  const leave = (reason: string, target: string, kind?: keyof typeof fell) => {
    unread.push(`${reason}:${target}`)
    if (kind && !phase.siblings) fell[kind].add(target)
    return "skip" as const
  }
  // The ignore globs go through classifyPath, the classifier's own matcher, so a glob means the same here as in the
  // review's file list; the default ignores and .gitattributes come through `ignored`, as the caller's config has them.
  const config = { ignore: [...input.ignore], ignoreDefaults: false }
  const ignored = (target: string) => input.ignored?.(target) === true || classifyPath(target, { config }) !== undefined
  // Synchronous, in order, so the read cap takes the first targets the uses name. Ignored and excluded files go first,
  // so a changed one is never read from the changed files' parse either.
  const plan = (target: string) => {
    if (ignored(target)) return leave("ignored", target)
    if (BrainCode.excluded(target)) return leave("excluded", target)
    if (input.own.has(target)) return "changed" as const
    const size = input.blobs.get(target)?.size
    if (!input.blobs.has(target)) return leave("absent", target)
    if (input.unread.has(target)) return leave("missing", target, "b:missing")
    if (size !== undefined && size > ReviewParse.PARSE_LIMITS.inputBytes) return leave("large", target, "b:over-cap")
    if (!ReviewParse.languageOf(target)) return leave("unsupported", target, "b:unsupported")
    if (reads.count >= IMPACT_TIERS.targets) return leave("cap", target, "b:over-cap")
    reads.count++
    return "read" as const
  }
  const read = (target: string) =>
    Effect.gen(function* () {
      if (performance.now() >= input.deadline) return leave("time", target, "b:over-cap")
      const shown = yield* run(["show", "--no-textconv", `${input.head}:${target}`], {
        maxOutputBytes: ReviewParse.PARSE_LIMITS.inputBytes + 1,
      })
      if (!shown) return leave("time", target, "b:over-cap")
      if (shown.exitCode !== 0) return leave("error", target)
      if (shown.truncated) return leave("large", target, "b:over-cap")
      if (shown.stdout.includes(0)) return leave("binary", target)
      const text = shown.text()
      if (hasGeneratedHeader(text)) return leave("generated", target)
      const parsed = yield* ReviewParse.parse({
        path: target,
        text,
        names: siblings.has(target) ? members : new Set(),
        deadline: input.deadline,
      })
      if (!parsed.parsed)
        return parsed.because === "timeout"
          ? leave("time", target, "b:over-cap")
          : leave("unsupported", target, "b:unsupported")
      definitions.set(
        target,
        parsed.definitions.map((definition) => definitionOf(target, "RIGHT", definition)),
      )
      if (siblings.has(target))
        declared.set(target, {
          text,
          definitions: definitions.get(target) ?? [],
          references: parsed.references.map(sourceReference),
        })
      reexports.set(target, reexportTargets({ path: target, text, lookup: input.lookup, workspace: input.workspace }))
      return "read" as const
    })
  const round = (targets: readonly string[], depth: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const fresh = [...new Set(targets)].filter((target) => !seen.has(target))
      fresh.forEach((target) => seen.add(target))
      const planned = fresh.map((target) => ({ target, plan: plan(target) }))
      planned
        .filter((item) => item.plan === "changed")
        .forEach((item) => {
          const own = input.changed.definitions(item.target, "RIGHT")
          const text = input.changed.text(item.target, "RIGHT")
          if (own) definitions.set(item.target, own)
          if (text !== undefined)
            reexports.set(
              item.target,
              reexportTargets({ path: item.target, text, lookup: input.lookup, workspace: input.workspace }),
            )
        })
      yield* Effect.forEach(
        planned.filter((item) => item.plan === "read").map((item) => item.target),
        read,
        { concurrency: TARGET_CONCURRENCY, discard: true },
      )
      const next = fresh.flatMap((target) => reexports.get(target) ?? [])
      if (depth < IMPACT_LIMITS.reexportDepth && next.length) yield* round(next, depth + 1)
    })
  yield* round(
    found.uses.flatMap((use) => use.targets),
    0,
  )
  const reparse = (target: string) =>
    Effect.gen(function* () {
      const text = input.changed.text(target, "RIGHT")
      const own = definitions.get(target)
      if (text === undefined || !own) return
      const parsed = members.size
        ? yield* ReviewParse.parse({ path: target, text, names: members, deadline: input.deadline })
        : undefined
      // Past the time box the sibling gives nothing, as a read past it would.
      if (parsed && !parsed.parsed && parsed.because === "timeout") {
        leave("time", target)
        return
      }
      if (parsed && !parsed.parsed) leave("unsupported", target)
      declared.set(target, {
        text,
        definitions: own,
        references: parsed?.parsed ? parsed.references.map(sourceReference) : [],
      })
    })
  // Each batch's siblings are bound once, after their reads: the uses they give, and the bare names they bind. Past the
  // time box nothing more is bound, as nothing more is read, so a sibling read in time is `time:` too.
  const same: OutboundUse[] = []
  const bound = new Set<string>()
  const bind = (batch: readonly string[]) => {
    const fresh = new Set(batch.filter((target) => declared.has(target)))
    if (!fresh.size) return
    if (performance.now() >= input.deadline) {
      fresh.forEach((target) => leave("time", target))
      return
    }
    samePackageUses({ lookups, file: (path) => (fresh.has(path) ? declared.get(path) : undefined) }).forEach((use) => {
      same.push(use)
      bound.add(`${use.path}\0${use.name}`)
    })
  }
  // A package declares a name once (build-tagged variants aside), so once every bare name is bound and no member is
  // looked up, the other siblings add nothing.
  const sought = lookups.some((lookup) => lookup.uses.some((use) => use.member))
  const open = () =>
    sought || lookups.some((lookup) => lookup.uses.some((use) => !bound.has(`${lookup.path}\0${use.name}`)))
  const look = (targets: readonly string[], from: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (from >= targets.length || !open()) return
      // Past the read cap nothing more is read, so the rest are set aside together.
      const batch = targets.slice(from, reads.count >= IMPACT_TIERS.targets ? undefined : from + TARGET_CONCURRENCY)
      yield* round(batch, IMPACT_LIMITS.reexportDepth)
      yield* Effect.forEach(
        batch.filter((target) => input.own.has(target) && !declared.has(target)),
        reparse,
        { discard: true },
      )
      bind(batch)
      yield* look(targets, from + batch.length)
    })
  phase.siblings = true
  yield* look([...siblings].toSorted(), 0)
  const fallback: ImpactFallback[] = (["b:unsupported", "b:over-cap", "b:missing"] as const).flatMap((kind) =>
    fell[kind].size ? [{ kind, count: fell[kind].size }] : [],
  )
  return {
    uses: [...found.uses, ...same],
    definitionsOf: (target: string) => definitions.get(target),
    reexports: (target: string) => reexports.get(target),
    unread,
    external: found.external,
    fallback,
  }
})

function importable(file: string) {
  const language = BrainCode.language(file)
  return language !== undefined && language !== "text"
}

function chars(specs: readonly string[]) {
  return specs.reduce((sum, spec) => sum + spec.length + 1, 0)
}

function noFiles(): ChangedFiles {
  return {
    text: () => undefined,
    definitions: () => undefined,
    comments: () => undefined,
    strings: () => undefined,
    references: () => undefined,
    unsupported: [],
    missing: [],
    large: [],
    parseMs: 0,
  }
}

function emptySlice(): ImpactSlice {
  return {
    changed: [],
    dependents: [],
    tests: [],
    unsupported: [],
    tokens: 0,
    ms: 0,
    locations: [],
    stages: { candidates: 0, gated: 0, confirmed: 0, packed: 0 },
    dropped: { ignored: [], unchecked: [], gate: [], cap: [], time: [], budget: [], definitions: [] },
    plan: "tree-ish",
    gitVersion: "",
    clone: { partial: false, sparse: false },
    grepMs: 0,
    parseMs: 0,
  }
}

export * as ReviewImpact from "./impact"
