// VS-25b's Tier 1 impact slice builder (contract §4 VS-25b; addendum A VS-36 items 1, 2, 4 and 5 and VS-38 items 1, 3,
// 4, 6 and 7). Nothing calls it yet: VS-25b wiring calls `build` from Review.run under `impact: "graph"`.
//
// It reads the head and base tree-ishes only, never the working tree (I-8), because a fork review in CI runs on a
// merge-base checkout. File content is read with `git show --no-textconv` and searched with `git grep` of the head
// tree-ish; `git ls-tree`, `git rev-list --missing=print`, `git config` and `git version` read only trees and object
// metadata (whether I-8's words cover those is put to the owner with Q18). Every exported call (`build`, `parseChanged`,
// `importLines`) runs each git command with lazy fetching off and inside a time box, and first lists, without
// fetching, what a partial clone lacks, which it then leaves out of every read, so nothing is ever fetched, whatever
// git's version. A caller of `parseChanged` that passes `missing` takes that check on itself. `build` never fails: an
// error becomes an empty or incomplete slice, and the slice never touches what a review counts as reviewed.

import { Effect, Option, Stream } from "effect"
import { Git } from "@/git"
import { BrainCode } from "@vectordevai/core/brain/code"
import type { DiffFile } from "@vectordevai/core/review/diff"
import {
  IMPACT_INCOMPLETE,
  IMPACT_LIMITS,
  barrels,
  changedDefinitions,
  changedPaths,
  impactNames,
  impactTokens,
  movedNames,
  packSlice,
  selectDependents,
  wordHits,
  type Definition,
  type ImpactIncomplete,
  type ImpactSlice,
  type Reference,
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
export const IMPORT_LINE: readonly string[] = Object.freeze([
  "(^|[^[:alnum:]_$])(import|export|from|require|require_relative|require_once|include|include_once|use|mod)([^[:alnum:]_$]|$)",
  "(src|href)[[:space:]]*=",
  "^[[:space:]]*([[:alnum:]_.]+[[:space:]]+)?[\"'`]",
  "^[[:space:]]*\\)",
  "^[[:space:]]+[[:alnum:]_]+([[:space:]]+as[[:space:]]+[[:alnum:]_]+)?[[:space:]]*,?[[:space:]]*$",
  "@generated|DO NOT EDIT",
])

// What VS-24 wiring and Review.run need from the changed files' parse: each side's text, definitions, comments and
// strings, keyed by the path on that side (the old path for LEFT), as TrivialInput's callbacks take them.
export interface ChangedFiles {
  text: (path: string, side: Side) => string | undefined
  definitions: (path: string, side: Side) => readonly Definition[] | undefined
  comments: (path: string, side: Side) => readonly CommentRange[] | undefined
  strings: (path: string, side: Side) => readonly SourceRange[] | undefined
  unsupported: string[] // paths the parser did not read
  missing: string[] // "path" (head) or "base:path" a partial clone does not have, never read
  parseMs: number
}

export interface BuildInput {
  directory: string
  base: string
  head: string
  files: readonly DiffFile[]
  ignore?: readonly string[] // globs left out of the search, as relatedCode takes them
  ignored?: (path: string) => boolean
  context: number // the review model's context window, in tokens
  budgetMs?: number // the time box, IMPACT_LIMITS.timeBoxMs by default
  changed?: ChangedFiles
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
export const parseChanged = Effect.fn("ReviewImpact.parseChanged")(function* (input: {
  directory: string
  base: string
  head: string
  files: readonly DiffFile[]
  deadline?: number
  missing?: (path: string, side: Side) => boolean
}) {
  const git = yield* Git.Service
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
export const importLines = Effect.fn("ReviewImpact.importLines")(function* (input: {
  directory: string
  head: string
  paths: readonly string[]
  deadline?: number
}) {
  const git = yield* Git.Service
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
export const build = Effect.fn("ReviewImpact.build")(function* (input: BuildInput) {
  const git = yield* Git.Service
  const started = performance.now()
  const deadline = started + (input.budgetMs ?? IMPACT_LIMITS.timeBoxMs)
  const incomplete = new Set<ImpactIncomplete>()
  const timing = { grepMs: 0, parseMs: 0 }
  const run = runner(git, input.directory, deadline, incomplete)
  const scan = { gitVersion: "", clone: { partial: false, sparse: false }, unsearched: 0 }
  // The tokens are counted here, from the block as rendered with its note, once `incomplete` and `unsearched` are known.
  const finish = (
    slice: Partial<ImpactSlice>,
    changed: ChangedFiles,
  ): { slice: ImpactSlice; changed: ChangedFiles } => {
    const done = {
      ...emptySlice(),
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
    return { slice: { ...done, tokens: impactTokens(done) }, changed }
  }
  const given = input.changed ?? noFiles()
  const packOnly = (changed: ChangedFiles) => {
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
      present
        ? Effect.succeed(undefined)
        : run(["ls-tree", "-r", "-z", "-l", "--full-tree", input.head], { maxOutputBytes: TREE_BYTES }),
      input.changed ? Effect.succeed(input.changed) : readChanged(run, { ...input, deadline, missing: present?.lacks }),
    ],
    { concurrency: "unbounded" },
  )
  if (changed.missing.length) incomplete.add("partial-clone")
  const entries = present
    ? present.head
    : tree && tree.exitCode === 0 && !tree.truncated
      ? treeEntries(tree.text())
      : undefined
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
    ...collapse(missing, [...blobs.keys()]).map((file) => `:(top,exclude,literal)${file}`),
  ]
  // When every blob is missing there is nothing to search; when the excludes do not fit one command line, a search
  // could reach a missing blob (or an ignored path), so none runs.
  const fits = chars(excludes) <= ARG_CHARS
  const searchable = missing.length < blobs.size && fits
  if (!fits && !missing.length) incomplete.add("error")

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
  const attempted = manifests !== undefined && performance.now() < deadline
  const read = attempted
    ? yield* Effect.option(
        Effect.try({
          try: () =>
            BrainCode.workspace(
              [...lines(manifests, input.head)].map(([file, text]) => ({ path: file, text })),
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
  const imported = yield* readImports(run, input.head, reads)
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
        const parsed = yield* ReviewParse.parse({ path: entry.path, text, names: wanted, deadline })
        if (parsed.parsed) {
          timing.parseMs += parsed.parseMs + parsed.extractMs
          const references = parsed.references
            .filter((item) => item.kind !== "import" && wanted.has(item.name))
            .map((item) => reference(item.line, item.name, item.enclosing))
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

  // 8. Pack.
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
      unsupported: [
        ...new Set([
          ...changed.unsupported,
          ...confirmed.flatMap((item) =>
            item.kind === "unsupported" || (item.kind === "read" && !item.parsed) ? [item.path] : [],
          ),
        ]),
      ].toSorted(),
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
  )
})

// git, through Git.Service, with lazy fetching off and inside the time box. Undefined when the box ran out first
// (interrupting git, which AppProcess's scope then kills). An exit other than 0, or 1 with nothing on stderr where
// "no match" is allowed, marks the slice incomplete as an error.
function runner(git: Git.Interface, cwd: string, deadline: number, incomplete: Set<ImpactIncomplete>): Run {
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
              parsed.definitions.map(
                (definition): Definition => ({
                  path: item.path,
                  side: item.side,
                  name: definition.name,
                  kind: definition.kind,
                  start: definition.start,
                  end: definition.end,
                  exported: definition.exported,
                  signature: definition.signature,
                  ...(definition.container ? { container: definition.container } : {}),
                  ...(definition.aliases ? { aliases: definition.aliases } : {}),
                }),
              ),
            ] as const,
          ]
        : []
    }),
  )
  return {
    text: (path, side) => {
      const item = byKey.get(key(path, side))
      return item && "text" in item ? item.text : undefined
    },
    definitions: (path, side) => definitions.get(key(path, side)),
    comments: (path, side) => parsedOf(path, side)?.comments,
    strings: (path, side) => parsedOf(path, side)?.strings,
    unsupported: [
      ...new Set(
        read.filter((item) => !("missing" in item) && !parsedOf(item.path, item.side)).map((item) => item.path),
      ),
    ].toSorted(),
    missing: read
      .filter((item) => "missing" in item)
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
const readImports = Effect.fnUntraced(function* (run: Run, head: string, paths: readonly string[]) {
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
          const found = lines(result, head)
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
function lines(result: Git.Result | undefined, head: string) {
  const files = new Map<string, Map<number, string>>()
  if (!result || result.exitCode !== 0) return new Map<string, string>()
  for (const line of result.text().split("\n")) {
    const name = line.indexOf("\0")
    const number = line.indexOf("\0", name + 1)
    if (name < 0 || number < 0 || !line.startsWith(`${head}:`)) continue
    const file = line.slice(head.length + 1, name)
    const at = Number(line.slice(name + 1, number))
    if (!Number.isInteger(at) || at < 1) continue
    const found = files.get(file) ?? new Map<number, string>()
    found.set(at, line.slice(number + 1))
    files.set(file, found)
  }
  return new Map(
    [...files].map(([file, found]) => [
      file,
      Array.from(
        { length: [...found.keys()].reduce((top, at) => Math.max(top, at), 0) },
        (_, index) => found.get(index + 1) ?? "",
      ).join("\n"),
    ]),
  )
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
    unsupported: [],
    missing: [],
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
