// VS-25b's Tier 1 impact slice: the definitions a change touches and the call sites of their names in files that import
// the changed modules, ranked and packed into a bounded share of the context (contract §1.2 and §4 VS-25b; addendum A
// VS-36 items 1, 2, 4 and 5 and VS-38 items 6 and 7). Nothing calls it yet: engine review/impact.ts builds a slice with
// it, and no runner calls that before VS-25b wiring.
//
// Deterministic and free of I/O, but Node-only: BrainCode reads paths with node:path (and, through BrainAnchor and
// BrainDrift, imports node:crypto). prompt.ts and model-evidence.ts take only its types, so no renderer bundle gains a
// Node built-in. So the desktop half (VS-10, addendum A §1a) calls the slice through the engine, unless BrainCode's
// path handling first becomes plain posix string helpers that a renderer can import. Every stage records what it
// dropped, so a miss in an artifact can be traced to its stage. Impact incompleteness is context, never coverage:
// nothing here touches what a review counts as reviewed (VS-38 item 7, I-7).

import { minimatch } from "minimatch"
import { BrainCode } from "../brain/code"
import { BrainGraph } from "../brain/graph"
import type { DiffFile } from "./diff"
import { hasGeneratedHeader } from "./ignore"
import { IMPACT_CAPS, IMPACT_INSTRUCTION, impactBlock, impactCallSite, impactDefinition } from "./prompt"
import { TEST_PATHS } from "./trivial"
import type { Side } from "./types"

export const IMPACT_LIMITS = Object.freeze({
  confirm: 200, // gated files parse-confirmed, at most; the rest go to dropped.cap in rank order (VS-36 item 2)
  share: 0.15, // of the model's context, at most
  tokens: 6_000, // and never more than this
  charsPerToken: 3.5, // the runner's budget rule (plan.ts, run.ts), not Token.estimate's 4
  window: 3, // lines either side of a call site
  lineChars: 200,
  reexportDepth: 2, // barrel hops followed, and the folders above a changed module searched for barrels
  fallbackNames: 40, // names from changedSymbols, BrainCode.symbols or a moved file's exports
  timeBoxMs: 4_000, // the builder's whole budget (VS-38 item 4)
})

// Why a slice is incomplete, in this order: the time box fired, a partial clone left blobs out of the search, git's
// output passed its limit, or git failed in a way that is not "no match".
export const IMPACT_INCOMPLETE = Object.freeze(["time", "partial-clone", "output", "error"] as const)
export type ImpactIncomplete = (typeof IMPACT_INCOMPLETE)[number]

// A definition on one side of the change. Lines are 1-based and inclusive; LEFT is the base, read at the old path.
export interface Definition {
  path: string
  side: Side
  name: string
  kind: string
  start: number
  end: number
  exported: boolean
  signature: string
  container?: string
  aliases?: string[] // other names importers use: "default", an export clause's `as` name
}

export interface Reference {
  path: string
  line: number
  name: string
  enclosing?: string
  importsChanged: boolean // false for a same-package file (Go, Java, Kotlin) that reaches the change without an import
}

export interface Dependent extends Reference {
  rank: number
  window: string
}

export interface ImpactSlice {
  changed: Definition[] // packed, in order
  dependents: Dependent[] // packed, in rank order
  tests: string[] // gated dependents that are tests
  unsupported: string[] // changed or confirm-stage files the parser did not read
  // What the <untrusted_impact> block as rendered costs (impactTokens), 0 when it renders nothing. The trusted sentence
  // that comes with the block (IMPACT_INSTRUCTION) is charged to the budget but not counted here.
  tokens: number
  ms: number
  // "path:line" of every block the prompt shows, so slice recall can be computed from artifacts. LEFT definitions are
  // shown but carry none: a base line cannot be joined with head-line labels.
  locations: string[]
  // Files for candidates and gated, call sites for confirmed and packed. candidates = dropped.ignored + unchecked +
  // gate + gated; gated = files read for confirmation + cap + time; confirmed = packed + dropped.budget.
  stages: { candidates: number; gated: number; confirmed: number; packed: number }
  dropped: {
    ignored: string[] // ignore rules or a generated header
    unchecked: string[] // never gate-checked: the time box or git's output limit
    gate: string[] // imports nothing the change touches
    cap: string[] // gated past IMPACT_LIMITS.confirm, in rank order
    time: string[] // gated within the cap, left unread by the time box
    budget: string[] // "path:line" of confirmed call sites that did not fit
    definitions: string[] // changed definitions that did not fit: "path:start", or "base:path:start" for LEFT
  }
  plan: "tree-ish"
  gitVersion: string
  clone: { partial: boolean; sparse: boolean }
  grepMs: number
  parseMs: number
  incomplete?: ImpactIncomplete[] // distinct, in IMPACT_INCOMPLETE order
  unsearched?: number // head files whose blob a partial clone does not have, left out of every search
}

// What the prompt renders, and what the artifact records (its `tier1`, contract §1.2 and VS-38 item 6).
export type ImpactPrompt = Pick<ImpactSlice, "changed" | "dependents" | "tests" | "incomplete" | "unsearched">
export type ImpactRecord = Omit<ImpactSlice, "changed" | "dependents" | "locations">

const SAME_PACKAGE: Record<string, string> = { go: "go", java: "jvm", kt: "jvm", kts: "jvm" }
const C_SOURCES = new Set(["c", "cc", "cpp", "cxx", "m", "mm"])
const C_HEADERS = new Set(["h", "hh", "hpp", "hxx"])

/**
 * The definitions a change touches: for each added line the innermost head definition around it, for each removed
 * line the innermost base definition (at the old path), and, when that one is not exported, the nearest exported
 * definition around it too, so an edit inside a local helper still names the exported function that holds it. A base
 * definition whose head twin survives at the new path is replaced by that twin, so a removal inside a function that
 * still exists carries a head location; one with no twin, removed or renamed, stays. The twin has the same name, kind
 * and container and the same place among those by start, so a removal inside the second overload names the second
 * overload; when the two sides have different numbers of them, it is the first. Deduplicated; sorted by path, RIGHT
 * before LEFT, start, then name. The cost is about the changed lines plus the definitions, not their product.
 */
export function changedDefinitions(
  files: readonly DiffFile[],
  definitionsOf: (path: string, side: Side) => readonly Definition[] | undefined,
): Definition[] {
  const found = new Map<string, Definition>()
  const add = (definition: Definition) => {
    const key = `${definition.side}\0${definition.path}\0${definition.name}\0${definition.start}`
    if (!found.has(key)) found.set(key, definition)
  }
  for (const file of files) {
    if (file.binary) continue
    const head = definitionsOf(file.path, "RIGHT") ?? []
    const base = definitionsOf(file.oldPath ?? file.path, "LEFT") ?? []
    const lines = file.hunks.flatMap((hunk) => hunk.lines)
    const added = lines.flatMap((line) => (line.kind === "add" && line.newLine !== undefined ? [line.newLine] : []))
    const removed = lines.flatMap((line) => (line.kind === "del" && line.oldLine !== undefined ? [line.oldLine] : []))
    const heads = around(head, added)
    const bases = around(base, removed)
    const twin = twins(head, base)
    added.forEach((line) => heads(line).forEach(add))
    removed.forEach((line) => bases(line).forEach((definition) => add(twin.get(definition) ?? definition)))
  }
  return [...found.values()].toSorted(
    (a, b) =>
      compare(a.path, b.path) ||
      Number(a.side === "LEFT") - Number(b.side === "LEFT") ||
      a.start - b.start ||
      compare(a.name, b.name),
  )
}

/**
 * The exported names of a renamed or deleted file at its old path, with their aliases, at most
 * IMPACT_LIMITS.fallbackNames: importers of the old path are what a move breaks, even when no definition changed.
 */
export function movedNames(
  files: readonly DiffFile[],
  definitionsOf: (path: string, side: Side) => readonly Definition[] | undefined,
): string[] {
  const moved = files.filter(
    (file) => !file.binary && (file.status === "deleted" || (file.status === "renamed" && file.oldPath !== file.path)),
  )
  return [
    ...new Set(
      moved.flatMap((file) =>
        (definitionsOf(file.oldPath ?? file.path, "LEFT") ?? [])
          .filter((definition) => definition.exported)
          .flatMap((definition) => [definition.name, ...(definition.aliases ?? [])]),
      ),
    ),
  ]
    .filter(isName)
    .slice(0, IMPACT_LIMITS.fallbackNames)
}

/**
 * The names to grep for: every exported definition's name and aliases (never "default"), plus the fallback names.
 * Unique, sorted, and each a run of letters, digits, "_" and "$" (isName). A renamed definition gives its old and new
 * names; overloads give one.
 */
export function impactNames(definitions: readonly Definition[], fallback: readonly string[] = []): string[] {
  return [
    ...new Set([
      ...definitions
        .filter((definition) => definition.exported)
        .flatMap((definition) => [definition.name, ...(definition.aliases ?? [])]),
      ...fallback,
    ]),
  ]
    .filter(isName)
    .toSorted(compare)
}

/**
 * The index files (BrainCode.INDEX_FILES) that may re-export a changed module: in its own folder and in up to
 * IMPACT_LIMITS.reexportDepth folders above it. Re-exports from any other file are not followed. Sorted; changed
 * paths left out.
 */
export function barrels(changed: readonly string[], lookup: BrainCode.Lookup): string[] {
  const own = new Set(changed)
  const folders = changed.flatMap((file) =>
    Array.from({ length: IMPACT_LIMITS.reexportDepth + 1 }, (_, up) => ancestor(file, up + 1)).filter(
      (folder): folder is string => folder !== undefined,
    ),
  )
  return [
    ...new Set(
      folders.flatMap((folder) =>
        BrainCode.INDEX_FILES.map((name) => (folder ? `${folder}/${name}` : name)).filter(
          (file) => lookup.paths.has(file) && !own.has(file),
        ),
      ),
    ),
  ].toSorted(compare)
}

export interface Selection {
  // `reaches`: the changed modules the file reaches, directly, through a barrel or a header, or as their package
  // neighbour; its call sites are matched against their names only.
  confirm: { path: string; rank: number; importsChanged: boolean; reaches: string[] }[]
  cap: string[]
  gate: string[]
  ignored: string[]
  unchecked: string[]
  tests: string[]
}

/**
 * The import gate, before any cap (VS-36 item 2), then the rank. `imports(path)` is a file's import lines (the rest
 * blank), "" when it has none, or undefined when it was never read: such a candidate is unchecked, never gated. A
 * candidate passes when what it imports reaches a changed module or, through up to IMPACT_LIMITS.reexportDepth hops,
 * an index file that imports one; a Go import reaches a changed module when it resolves into that module's folder (Go
 * imports name a package folder, and BrainCode resolves a folder to at most 8 of its files); a C or C++ include
 * reaches a changed source file through a header of the same name (C_HEADERS, beside it or under an `include` folder
 * of its folder or an ancestor), since callers include the header, never the source; and a Go, Java or Kotlin file
 * passes without an import when it sits in a changed module's folder (one package). Files matching `ignored` or with a
 * generated header go to `ignored` before the gate. Gated files are ranked by BrainGraph.rank over the import edges
 * from the changed modules, each (file, target) pair once, rank descending then path; the first IMPACT_LIMITS.confirm
 * are to be confirmed and the rest are `cap`. No candidate is ever added that the gate did not pass.
 */
export function selectDependents(input: {
  files: readonly DiffFile[]
  candidates: readonly string[]
  imports: (path: string) => string | undefined
  lookup: BrainCode.Lookup
  workspace?: BrainCode.Workspace
  ignored?: (path: string) => boolean
}): Selection {
  const changed = changedPaths(input.files)
  const changedSet = new Set(changed)
  const goFolders = new Set(changed.filter((file) => extension(file) === "go").map(folderOf))
  const resolved = new Map<string, string[]>()
  const dependenciesOf = (file: string) => {
    const cached = resolved.get(file)
    if (cached) return cached
    const language = BrainCode.language(file)
    const text = input.imports(file)
    const found =
      language && text
        ? BrainCode.dependencies(
            file,
            [...BrainCode.imports(text, language), ...(language === "python" ? pythonSubmodules(text) : [])],
            language,
            input.lookup,
            input.workspace,
          )
        : []
    resolved.set(file, found)
    return found
  }
  // Which reached modules a file's imports land on: a reached file itself, or a changed Go module in the folder a Go
  // import resolves into.
  const reachedBy = (file: string, reach: ReadonlySet<string>) =>
    [
      ...new Set(
        dependenciesOf(file).flatMap((dependency) =>
          reach.has(dependency)
            ? [dependency]
            : extension(file) === "go" && goFolders.has(folderOf(dependency))
              ? changed.filter((item) => extension(item) === "go" && folderOf(item) === folderOf(dependency))
              : [],
        ),
      ),
    ].toSorted(compare)

  const headers = changed
    .flatMap((source) => headersOf(source, input.lookup).map((header) => [header, source] as const))
    .filter(([header]) => !changedSet.has(header))
    .reduce(
      (map, [header, source]) => map.set(header, [...(map.get(header) ?? []), source]),
      new Map<string, string[]>(),
    )
  const reach = new Set([...changed, ...headers.keys()])
  const reached = barrels(changed, input.lookup).filter((barrel) => input.imports(barrel) !== undefined)
  Array.from({ length: IMPACT_LIMITS.reexportDepth }).forEach(() =>
    reached
      .filter((barrel) => !reach.has(barrel) && reachedBy(barrel, reach).length)
      .forEach((barrel) => reach.add(barrel)),
  )
  // What each reached file that is not itself changed stands for: a header its sources, a barrel what it re-exports.
  const through = new Map([
    ...headers,
    ...[...reach]
      .filter((file) => !changedSet.has(file) && !headers.has(file))
      .map((barrel) => [barrel, reachedBy(barrel, reach)] as const),
  ])
  const modulesOf = (file: string, seen: ReadonlySet<string>): string[] => {
    if (changedSet.has(file)) return [file]
    if (seen.has(file)) return []
    return (through.get(file) ?? []).flatMap((target) => modulesOf(target, new Set([...seen, file])))
  }

  const sorted = [...new Set(input.candidates)].filter((file) => !changedSet.has(file)).toSorted(compare)
  const ignored = sorted.filter((file) => {
    if (input.ignored?.(file)) return true
    const text = input.imports(file)
    return text !== undefined && hasGeneratedHeader(text)
  })
  const ignoredSet = new Set(ignored)
  const unchecked = sorted.filter((file) => !ignoredSet.has(file) && input.imports(file) === undefined)
  const checked = sorted.filter((file) => !ignoredSet.has(file) && input.imports(file) !== undefined)
  const gated = checked.flatMap((file) => {
    const landed = reachedBy(file, reach)
    const neighbours = samePackage(file, changed)
    if (!landed.length && !neighbours.length) return []
    return [{ file, landed, neighbours }]
  })
  const gatedSet = new Set(gated.map((entry) => entry.file))

  // A barrel that is also a gated candidate has its edge listed twice, and BrainGraph.build would combine the two.
  const links = [
    ...gated.flatMap((entry) => [...entry.landed, ...entry.neighbours].map((target) => [entry.file, target] as const)),
    ...[...through].flatMap(([file, targets]) => targets.map((target) => [file, target] as const)),
  ]
  const edges = [...new Map(links.map((link) => [`${link[0]}\0${link[1]}`, link] as const)).values()].flatMap(
    ([source, target]) => [
      { source, target, weight: BrainGraph.WEIGHT.imports },
      { source: target, target: source, weight: BrainGraph.WEIGHT.imported },
    ],
  )
  const mass = BrainGraph.rank(BrainGraph.build(edges), new Map(changed.map((file) => [file, 1])))
  const ranked = gated
    .map((entry) => ({
      path: entry.file,
      rank: mass.get(entry.file) ?? 0,
      importsChanged: entry.landed.length > 0,
      reaches: [
        ...new Set([...entry.landed, ...entry.neighbours].flatMap((target) => modulesOf(target, new Set()))),
      ].toSorted(compare),
    }))
    .toSorted((a, b) => b.rank - a.rank || compare(a.path, b.path))
  return {
    confirm: ranked.slice(0, IMPACT_LIMITS.confirm),
    cap: ranked.slice(IMPACT_LIMITS.confirm).map((entry) => entry.path),
    gate: checked.filter((file) => !gatedSet.has(file)),
    ignored,
    unchecked,
    tests: ranked
      .map((entry) => entry.path)
      .filter((file) => TEST_PATHS.some((glob) => minimatch(file, glob, { dot: true, nocase: true })))
      .toSorted(compare),
  }
}

/**
 * Where `names` occur as whole words, as `git grep -w -F` matches them: between characters other than [A-Za-z0-9_] or
 * the line's ends, so `$foo` holds `foo` and `foo_bar` does not. The fallback for files the parser does not read.
 * Sorted by line, then name.
 */
export function wordHits(text: string, names: ReadonlySet<string>): { line: number; name: string }[] {
  const patterns = [...names]
    .filter(Boolean)
    .toSorted(compare)
    .map((name) => {
      const literal = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      return { name, pattern: new RegExp(`(?<![A-Za-z0-9_])${literal}(?![A-Za-z0-9_])`) }
    })
  return text
    .split("\n")
    .flatMap((line, index) =>
      patterns.filter((item) => item.pattern.test(line)).map((item) => ({ line: index + 1, name: item.name })),
    )
}

/**
 * The slice as the prompt shows it. The budget is min(IMPACT_LIMITS.tokens, share × context) tokens at
 * IMPACT_LIMITS.charsPerToken, charged at each block's rendered size (prompt.ts), after reserving the frame, the tests,
 * the longest note the block can carry and the trusted sentence that comes with it (IMPACT_INSTRUCTION, and the line
 * break before it), so what the slice adds to the prompt never exceeds it. The reservation is for that check only:
 * `tokens` is what the packed block costs as rendered, without a note (impactTokens), and the builder recounts it
 * with its note. Changed definitions are packed
 * first, in their order, then call sites deduplicated by path and line (the first name in sort order kept) in rank
 * order, each with up to IMPACT_LIMITS.window lines either side that no earlier window of its file shows ("N: text",
 * at most IMPACT_LIMITS.lineChars characters; empty when every line is already shown). The first block that does not
 * fit stops packing: it and every later one are dropped, in order. Blocks past prompt.ts's caps for their kind are
 * dropped too, and the other kind still packs.
 */
export function packSlice(input: {
  changed: readonly Definition[]
  references: readonly Reference[]
  ranks: ReadonlyMap<string, number>
  text: (path: string) => string | undefined
  context: number
  tests?: readonly string[]
}) {
  const budget = Math.floor(
    Math.min(IMPACT_LIMITS.tokens, Math.floor(IMPACT_LIMITS.share * Math.max(0, input.context))) *
      IMPACT_LIMITS.charsPerToken,
  )
  const frame =
    impactBlock({
      changed: [],
      dependents: [],
      tests: (input.tests ?? []).slice(),
      incomplete: [...IMPACT_INCOMPLETE],
      unsearched: Number.MAX_SAFE_INTEGER,
    }).length +
    IMPACT_INSTRUCTION.length +
    1
  const state = { used: frame, open: frame <= budget }
  // A cap ends only its own kind of block; the budget ends packing.
  const fits = (block: string, index: number, cap: number) => {
    if (!state.open || index >= cap) return false
    if (state.used + block.length + 1 > budget) {
      state.open = false
      return false
    }
    state.used += block.length + 1
    return true
  }

  const changed = input.changed.filter((definition, index) =>
    fits(impactDefinition(definition), index, IMPACT_CAPS.definitions),
  )
  const kept = new Set(changed)
  const sites = [
    ...new Map(
      input.references
        .toSorted((a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.name, b.name))
        .map((reference) => [`${reference.path}:${reference.line}`, reference] as const)
        .toReversed(),
    ).values(),
  ]
    .map((reference) => ({ ...reference, rank: input.ranks.get(reference.path) ?? 0 }))
    .toSorted((a, b) => b.rank - a.rank || compare(a.path, b.path) || a.line - b.line || compare(a.name, b.name))
  const shown = new Map<string, Set<number>>()
  const lines = new Map<string, string[]>()
  const dependents: Dependent[] = []
  const budgeted: string[] = []
  for (const site of sites) {
    if (!state.open) {
      budgeted.push(`${site.path}:${site.line}`)
      continue
    }
    const text = lines.get(site.path) ?? (input.text(site.path) ?? "").split("\n")
    lines.set(site.path, text)
    const seen = shown.get(site.path) ?? new Set<number>()
    // A final newline ends the last line; it does not start another.
    const count = text.length > 1 && text.at(-1) === "" ? text.length - 1 : text.length
    const from = Math.max(1, site.line - IMPACT_LIMITS.window)
    const to = Math.min(count, site.line + IMPACT_LIMITS.window)
    const fresh = Array.from({ length: Math.max(0, to - from + 1) }, (_, at) => from + at).filter(
      (line) => !seen.has(line),
    )
    const dependent = {
      ...site,
      window: fresh
        .map((line) => `${line}: ${text[line - 1].replace(/\r$/, "").slice(0, IMPACT_LIMITS.lineChars)}`)
        .join("\n"),
    }
    if (!fits(impactCallSite(dependent), dependents.length, IMPACT_CAPS.sites)) {
      budgeted.push(`${site.path}:${site.line}`)
      continue
    }
    fresh.forEach((line) => seen.add(line))
    shown.set(site.path, seen)
    dependents.push(dependent)
  }
  return {
    changed,
    dependents,
    tokens: impactTokens({ changed, dependents, tests: (input.tests ?? []).slice() }),
    locations: [
      ...new Set([
        ...changed
          .filter((definition) => definition.side === "RIGHT")
          .map((definition) => `${definition.path}:${definition.start}`),
        ...dependents.map((dependent) => `${dependent.path}:${dependent.line}`),
      ]),
    ],
    confirmed: sites.length,
    budget: budgeted,
    definitions: input.changed
      .filter((definition) => !kept.has(definition))
      .map((definition) =>
        definition.side === "RIGHT"
          ? `${definition.path}:${definition.start}`
          : `base:${definition.path}:${definition.start}`,
      ),
  }
}

/** What the <untrusted_impact> block costs as rendered, at IMPACT_LIMITS.charsPerToken: 0 when it renders nothing. */
export function impactTokens(slice: ImpactPrompt) {
  return Math.ceil(impactBlock(slice).length / IMPACT_LIMITS.charsPerToken)
}

/** The changed modules: the new paths of files that still exist, and the old paths of renamed and deleted files. */
export function changedPaths(files: readonly DiffFile[]): string[] {
  return [
    ...new Set(
      files.flatMap((file) => [
        ...(file.status === "deleted" ? [] : [file.path]),
        ...(file.status === "renamed" || file.status === "deleted" ? [file.oldPath ?? file.path] : []),
      ]),
    ),
  ].toSorted(compare)
}

// The definitions around each of `lines`: the innermost (smallest span, then the later start) and, when that one is not
// exported, the innermost exported one too.
function around(definitions: readonly Definition[], lines: readonly number[]) {
  const inner = innermost(definitions, lines)
  const outer = innermost(
    definitions.filter((definition) => definition.exported),
    lines,
  )
  return (line: number): Definition[] => {
    const found = inner.get(line)
    if (!found) return []
    if (found.exported) return [found]
    const exported = outer.get(line)
    return exported ? [found, exported] : [found]
  }
}

// Each line's innermost holding definition, found by handing every line to the first definition in innermost order
// that holds it. A union-find over the sorted lines skips the lines already handed out, so the cost is about the lines
// plus the definitions, where testing every definition at every line cost seconds on a large generated file.
function innermost(definitions: readonly Definition[], lines: readonly number[]) {
  const sorted = [...new Set(lines)].toSorted((a, b) => a - b)
  const next = Array.from({ length: sorted.length + 1 }, (_, index) => index)
  const find = (start: number) => {
    const at = { index: start }
    while (next[at.index] !== at.index) {
      next[at.index] = next[next[at.index]]
      at.index = next[at.index]
    }
    return at.index
  }
  const owner = new Map<number, Definition>()
  definitions
    .toSorted((a, b) => a.end - a.start - (b.end - b.start) || b.start - a.start)
    .forEach((definition) => {
      const at = { index: find(lowerBound(sorted, definition.start)) }
      while (at.index < sorted.length && sorted[at.index] <= definition.end) {
        owner.set(sorted[at.index], definition)
        next[at.index] = at.index + 1
        at.index = find(at.index + 1)
      }
    })
  return owner
}

// The first index of `sorted` whose value is at least `value`.
function lowerBound(sorted: readonly number[], value: number) {
  const range = { low: 0, high: sorted.length }
  while (range.low < range.high) {
    const middle = (range.low + range.high) >> 1
    if (sorted[middle] < value) {
      range.low = middle + 1
      continue
    }
    range.high = middle
  }
  return range.low
}

// Each base definition's head twin: the head definition with its name, kind and container at its own place among
// those by start, or the first of them when the sides have different numbers of them.
function twins(head: readonly Definition[], base: readonly Definition[]) {
  const group = (definitions: readonly Definition[]) =>
    definitions
      .toSorted((a, b) => a.start - b.start)
      .reduce((groups, definition) => {
        const same = groups.get(twinKey(definition))
        if (same) same.push(definition)
        if (!same) groups.set(twinKey(definition), [definition])
        return groups
      }, new Map<string, Definition[]>())
  const heads = group(head)
  return new Map(
    [...group(base)].flatMap(([key, same]) => {
      const twin = heads.get(key)
      if (!twin) return []
      return same.map((definition, index) => [definition, same.length === twin.length ? twin[index] : twin[0]] as const)
    }),
  )
}

function twinKey(definition: Definition) {
  return JSON.stringify([definition.name, definition.kind, definition.container ?? null])
}

// A name `git grep -f` can take as one fixed pattern: letters, marks, digits, "_" and "$", and never "default". A
// string export name such as `"a\n\nb"` (ES2022) would otherwise become several patterns, one of them empty, which
// matches every line.
function isName(name: string) {
  return name !== "default" && /^[\p{L}\p{M}\p{N}_$]+$/u.test(name)
}

// The headers of a changed C or C++ source file that callers include instead: the same file name with a header
// extension, beside it or under an `include` folder of its folder or of an ancestor.
function headersOf(source: string, lookup: BrainCode.Lookup) {
  if (!C_SOURCES.has(extension(source))) return []
  const stem = (file: string) => {
    const name = file.slice(file.lastIndexOf("/") + 1)
    return name.slice(0, name.lastIndexOf("."))
  }
  const folder = folderOf(source)
  const under = (root: string) => root === "" || folder === root || folder.startsWith(`${root}/`)
  return (lookup.byStem.get(stem(source).toLowerCase()) ?? [])
    .filter((file) => C_HEADERS.has(extension(file)) && stem(file) === stem(source))
    .filter((file) => {
      const parts = folderOf(file).split("/")
      return (
        folderOf(file) === folder || parts.some((part, at) => part === "include" && under(parts.slice(0, at).join("/")))
      )
    })
    .toSorted(compare)
}

// Python's `from X import Y`, which BrainCode.imports reads as X alone: each Y may be a submodule (X/Y.py), so it is
// also resolved as X.Y (`.Y` for `from . import Y`). A Y that is not a module resolves to nothing more.
function pythonSubmodules(text: string) {
  return [...text.matchAll(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n#;]+)/gm)].flatMap((match) => {
    const from = match[1]
    return match[2]
      .replace(/[()\\]/g, " ")
      .split(",")
      .map((item) => item.trim().split(/\s+/)[0] ?? "")
      .filter((name) => /^[A-Za-z_]\w*$/.test(name))
      .map((name) => (from.endsWith(".") ? `${from}${name}` : `${from}.${name}`))
  })
}

// The changed modules in a file's folder that share its package: Go with Go, Java and Kotlin with either. C# is not
// one: its namespaces are not bound to folders.
function samePackage(file: string, changed: readonly string[]) {
  const family = SAME_PACKAGE[extension(file)]
  if (!family) return []
  return changed.filter((item) => SAME_PACKAGE[extension(item)] === family && folderOf(item) === folderOf(file))
}

function ancestor(file: string, levels: number) {
  const parts = file.split("/")
  if (levels > parts.length) return undefined
  return parts.slice(0, parts.length - levels).join("/")
}

function folderOf(file: string) {
  return file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""
}

function extension(file: string) {
  const name = file.slice(file.lastIndexOf("/") + 1)
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : ""
}

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}
