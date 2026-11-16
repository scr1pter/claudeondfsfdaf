// VS-25b's Tier 1 impact slice: the definitions a change touches and the call sites of their names in files that import
// the changed modules, ranked and packed into a bounded share of the context (contract §1.2 and §4 VS-25b; addendum A
// VS-36 items 1, 2, 4 and 5 and VS-38 items 6 and 7). Nothing calls it yet: engine review/impact.ts builds a slice with
// it, and no runner calls that before VS-25b wiring. VS-37a adds the three-tier packing (packTiers and its helpers),
// reached only when the builder is given eval-only packing parameters; packSlice stays the VS-25b arm.
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
import {
  IMPACT_CAPS,
  IMPACT_INSTRUCTION,
  IMPACT_TIER_CAPS,
  IMPACT_TIERS_INSTRUCTION,
  impactBlock,
  impactCallSite,
  impactDefinition,
  impactOutbound,
  impactScope,
} from "./prompt"
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
  // VS-37a: the statement around it, from a parse asked for statements; a compound statement (an `if`, a loop) gives its
  // header through this line. packTiers widens the call site's window to it.
  statement?: { start: number; end: number }
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
  // VS-37a, set only on a slice packed in tiers (packTiers), so a VS-25b slice is unchanged: `scopes` is then always a
  // list, possibly empty, which is how the prompt knows the slice is tiered. Under tiers, confirmed = packed +
  // dropped.budget + tiers.dropped.rank.
  scopes?: EnclosingScope[]
  outbound?: OutboundSignature[]
  fallback?: ImpactFallback[] // in IMPACT_FALLBACK_KINDS order, counts above 0 only
  tiers?: ImpactTiers
}

// What the prompt renders, and what the artifact records (its `tier1`, contract §1.2 and VS-38 item 6). The record
// holds no code text: scopes and outbound signatures are left out with the definitions and call sites.
export type ImpactPrompt = Pick<
  ImpactSlice,
  "changed" | "dependents" | "tests" | "incomplete" | "unsearched" | "scopes" | "outbound" | "fallback"
>
export type ImpactRecord = Omit<ImpactSlice, "changed" | "dependents" | "locations" | "scopes" | "outbound">

// VS-37a's three packing tiers inside the slice's budget (addendum A VS-37): (a) each changed definition whole, with
// its container's signature and the import lines its changed lines use, or its signature alone (VS-25b's anchor);
// (b) the signatures of definitions in other files that the added lines use, tied to the import that brings them in;
// (c) VS-25b's ranked call sites, each widened to its statement. Each tier's share is a cap on the budget left after
// the frame, and what a tier leaves unused carries on to the next. Shares and top-k are eval-only parameters: never a
// user key, untuned, swept in offline projections and frozen before the held-out split (I-13).
export const IMPACT_TIERS = Object.freeze({
  shares: Object.freeze({ a: 0.4, b: 0.15, c: 0.45 }),
  outboundPerFile: 3, // tier b signatures from one target file, a .d.ts or .pyi included
  targets: 20, // files the builder reads for tier b, at most
  statementLines: 8, // a tier c window, at most
  importLines: 8, // import lines one scope shows, at most
})

export const IMPACT_TIER_NAMES = Object.freeze(["a", "b", "c"] as const)
export type ImpactTier = (typeof IMPACT_TIER_NAMES)[number]

// Why a tier fell back, which the prompt names in one line. "a" kinds count changed files (or, for over-cap, also
// definitions whose scope is over IMPACT_TIER_CAPS.scopeChars), "b" kinds count dependency files tier b could not
// read, and "c:no-statement" counts files whose packed call sites had no statement around them. A kind counts only
// when its tier packs.
export const IMPACT_FALLBACK_KINDS = Object.freeze([
  "a:unsupported",
  "a:over-cap",
  "a:missing",
  "b:unsupported",
  "b:over-cap",
  "b:missing",
  "c:no-statement",
] as const)
export type ImpactFallbackKind = (typeof IMPACT_FALLBACK_KINDS)[number]

export interface ImpactFallback {
  kind: ImpactFallbackKind
  count: number
}

// Which tiers pack, each tier's share of the budget, and how many dependent files tier c keeps (all when unset).
export interface ImpactPacking {
  tiers: ImpactTier[]
  shares: Record<ImpactTier, number>
  topK?: number
}

// What a caller may pass (an eval projection's parameters): any of the fields, unknown tier names ignored.
export interface ImpactPackingInput {
  tiers?: readonly string[]
  shares?: Partial<Record<ImpactTier, number>>
  topK?: number
}

export const DEFAULT_PACKING: Readonly<{
  tiers: readonly ImpactTier[]
  shares: Readonly<Record<ImpactTier, number>>
}> = Object.freeze({ tiers: IMPACT_TIER_NAMES, shares: IMPACT_TIERS.shares })

// A reference the parser found on a changed line of one side, with its 0-based column (UTF-16 units).
export interface SourceReference {
  name: string
  line: number
  column: number
  kind: "call" | "type" | "import" | "value"
}

// One side of a changed file as tiers a and b read it: its text, its definitions, and the references on its changed
// lines (added lines for RIGHT, removed lines for LEFT).
export interface TierSource {
  text: string
  definitions: readonly Definition[]
  references: readonly SourceReference[]
}

// Tier a: a changed definition whole. `excerpt` is "N: text" lines, the import lines first, a "⋯" line between lines
// that are not adjacent; `header` is the signature of the container it sits in.
export interface EnclosingScope {
  path: string
  side: Side
  name: string
  kind: string
  start: number
  end: number
  header?: string
  excerpt: string
}

// Tier b: a definition in another file that an added line uses ("path:line" in `usedIn`).
export interface OutboundSignature {
  path: string
  name: string
  kind: string
  start: number
  end: number
  signature: string
  usedIn: string
}

// Tier b's input: a name an added line uses, the specifier of the import that brings it in, whether the line names it
// through that import's module (`ns.name`, `pkg.name`, `mod::name`), whether it is that import's default binding, the
// name it is exported as when the import renames it (`{ format as fmt }`), and the repository files the specifier
// names.
export interface OutboundUse {
  path: string
  line: number
  name: string
  specifier: string
  qualified: boolean
  default: boolean
  original?: string
  targets: string[]
}

// What packTiers did, for offline projections of the arms (addendum A §1a): the packing it used; which changed paths it
// treated as shown whole or as having no diff in the prompt (both empty under the defaults: no file inline, every
// diff shown); the tokens each account spent; the ranges each tier's blocks show ("path:start-end", "base:" for LEFT);
// how many used imports name no repository file under tier b's rules; and what each tier left out.
export interface ImpactTiers {
  packing: ImpactPacking
  view: { inline: string[]; diffHidden: string[] }
  tokens: Record<ImpactTier, number>
  shown: Record<ImpactTier, string[]>
  external: number
  dropped: {
    inline: string[] // changed definitions of a file shown whole: a signature instead of a scope
    shown: string[] // changed definitions the diff already shows every line of: a signature instead of a scope
    covered: string[] // inside a packed scope, or the container a packed scope names as its header
    scope: string[] // scopes over a cap or past tier a's share: a signature instead
    outbound: string[] // "path:start" of signatures past a cap or tier b's share
    targets: string[] // "reason:path" of tier b targets the builder did not read
    rank: string[] // "path:line" of call sites past top-k
  }
}

const SAME_PACKAGE: Record<string, string> = { go: "go", java: "jvm", kt: "jvm", kts: "jvm" }
const C_SOURCES = new Set(["c", "cc", "cpp", "cxx", "m", "mm"])
const C_HEADERS = new Set(["h", "hh", "hpp", "hxx"])
// The definition kinds a VS-37a scope names as its header.
const CONTAINERS = new Set(["class", "interface", "struct", "trait", "enum", "module"])

/**
 * The definitions a change touches: for each added line the innermost head definition around it, for each removed
 * line the innermost base definition (at the old path), and, when that one is not exported, the nearest exported
 * definition around it too, so an edit inside a local helper still names the exported function that holds it. A base
 * definition whose head twin survives at the new path is replaced by that twin, so a removal inside a function that
 * still exists carries a head location; one with no twin, removed or renamed, stays. The twin has the same name, kind
 * and container and the same place among those by start, so a removal inside the second overload names the second
 * overload; when the two sides have different numbers of them, it is the first. Deduplicated; sorted by path, RIGHT
 * before LEFT, start, then name. The cost is about the changed lines plus the definitions, not their product. With
 * `ancestors: false` (VS-37a's tier a) the exported definitions around a local one are left out.
 */
export function changedDefinitions(
  files: readonly DiffFile[],
  definitionsOf: (path: string, side: Side) => readonly Definition[] | undefined,
  options: { ancestors?: boolean } = {},
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
    const heads = around(head, added, options.ancestors ?? true)
    const bases = around(base, removed, options.ancestors ?? true)
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

/**
 * VS-37a's packing parameters, normalised: known tiers only, once each, in a-b-c order; each share clamped to [0, 1] (a
 * value that is not a finite number becomes 0, a missing one takes IMPACT_TIERS.shares'); a top-k that is set floored
 * and clamped at 0, one that is not a finite number becoming 0, so a bad parameter keeps fewer dependent files, never
 * more. Only an unset top-k keeps every dependent file. Eval-only: nothing parses it from config or env.
 */
export function impactPacking(params: ImpactPackingInput = {}): ImpactPacking {
  const wanted = new Set(params.tiers ?? DEFAULT_PACKING.tiers)
  const share = (tier: ImpactTier) => {
    const value = params.shares?.[tier] ?? IMPACT_TIERS.shares[tier]
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  }
  const topK = params.topK
  return {
    tiers: IMPACT_TIER_NAMES.filter((tier) => wanted.has(tier)),
    shares: { a: share("a"), b: share("b"), c: share("c") },
    ...(topK === undefined ? {} : { topK: Number.isFinite(topK) ? Math.max(0, Math.floor(topK)) : 0 }),
  }
}

/**
 * Tier b's uses (VS-37a): each name an added line of a changed file calls, names as a type or reads, tied to the import
 * that brings it in. A name binds to an import statement (BrainCode.importStatements) when it is written on that
 * statement's lines, strings left out (`import { load }`, `from x import load`, `use a::{Load}`, `import a.Load`), or
 * when the line names it through a module the statement binds (`ns.load()` after `import * as ns`, a default import
 * or `require`; `mod.load()` after Python's `import mod`; `util.Load()` after Go's `import "x/util"`; `mod::load()`
 * after `use a::mod`). A TypeScript named import is a value, not a module, so `db.save()` after `import { db }` binds
 * `db` only. A bare name the file defines itself is never an import's, and a member of anything else (`obj.save()`)
 * binds to nothing. Each statement's specifier is resolved strictly
 * (outboundSpecifier), so a standard-library or npm name never lands on a repository file that shares it; `external`
 * counts the bound (file, specifier) pairs that name no repository file. Unique by path, name and specifier, at the
 * first line; sorted by path, line, name and specifier. Removed code gets no uses.
 */
export function outboundUses(input: {
  files: readonly DiffFile[]
  source: (path: string, side: Side) => TierSource | undefined
  lookup: BrainCode.Lookup
  workspace?: BrainCode.Workspace
}): { uses: OutboundUse[]; external: number } {
  const external = new Set<string>()
  const found = new Map<string, OutboundUse>()
  input.files
    .filter((file) => !file.binary && file.status !== "deleted")
    .map((file) => file.path)
    .toSorted(compare)
    .forEach((file) => {
      const source = input.source(file, "RIGHT")
      const language = BrainCode.language(file)
      if (!source || !language || language === "text") return
      const lines = source.text.split("\n")
      const statements = importsOf(source.text, language).map((statement) => ({
        ...statement,
        targets: outboundSpecifier(file, statement.specifier, language, input.lookup, {
          workspace: input.workspace,
          local: language === "rust" && /^[ \t]*(?:pub\s+)?mod\s/.test(lines[statement.start - 1] ?? ""),
        }),
      }))
      const onImports = new Set(statements.flatMap((statement) => span(statement.start, statement.end)))
      const defined = new Set(source.definitions.map((definition) => definition.name))
      source.references
        .filter((reference) => reference.kind !== "import" && !onImports.has(reference.line))
        .toSorted((x, y) => x.line - y.line || x.column - y.column || compare(x.name, y.name))
        .forEach((reference) => {
          const before = (lines[reference.line - 1] ?? "").slice(0, reference.column)
          const qualifier = before.match(/([A-Za-z_$][\w$]*)\s*(?:\?\.|\.|::)\s*$/)?.[1]
          if (!qualifier && defined.has(reference.name)) return
          statements
            .filter((statement) =>
              qualifier ? statement.qualifiers.has(qualifier) : statement.names.has(reference.name),
            )
            .forEach((statement) => {
              if (!statement.targets.length) {
                external.add(`${file}\0${statement.specifier}`)
                return
              }
              const key = `${file}\0${reference.name}\0${statement.specifier}`
              if (found.has(key)) return
              found.set(key, {
                path: file,
                line: reference.line,
                name: reference.name,
                specifier: statement.specifier,
                qualified: qualifier !== undefined,
                default: qualifier === undefined && statement.default === reference.name,
                ...(qualifier === undefined && statement.renames.has(reference.name)
                  ? { original: statement.renames.get(reference.name) }
                  : {}),
                targets: statement.targets,
              })
            })
        })
    })
  return {
    uses: [...found.values()].toSorted(
      (x, y) =>
        compare(x.path, y.path) || x.line - y.line || compare(x.name, y.name) || compare(x.specifier, y.specifier),
    ),
    external: external.size,
  }
}

/**
 * The repository files one import specifier names for tier b (VS-37a), stricter than BrainCode.resolve, which
 * selectDependents keeps using as it is: a relative TypeScript, JavaScript or Python specifier through resolve; a bare
 * TypeScript or JavaScript one through the workspace's path aliases and packages only (BrainCode.resolveWorkspace),
 * never a sibling or a suffix match; and a module path (Python, Go, Rust, Java) only when at least two of its segments
 * match the target's path, or one after Rust's `crate::`, `self::` or `super::` or in a `mod` declaration (`local`),
 * so `json`, `fmt` or `serde` never lands on a file named like it. Targets in another language are left out.
 */
export function outboundSpecifier(
  file: string,
  specifier: string,
  language: BrainCode.Language,
  lookup: BrainCode.Lookup,
  options: { workspace?: BrainCode.Workspace; local?: boolean } = {},
): string[] {
  const same = (targets: readonly string[]) =>
    targets.filter((target) => target !== file && BrainCode.language(target) === language)
  if (language === "typescript") {
    if (specifier.startsWith(".")) return same(BrainCode.resolve(file, specifier, language, lookup))
    return options.workspace ? same(BrainCode.resolveWorkspace(file, specifier, lookup, options.workspace)) : []
  }
  if (language !== "python" && language !== "go" && language !== "rust" && language !== "java") return []
  if (language === "python" && specifier.startsWith("."))
    return same(BrainCode.resolve(file, specifier, language, lookup))
  const segments = (
    language === "rust"
      ? specifier.replace(/^(?:crate|self|super)::/, "").split("::")
      : specifier.split(language === "go" ? "/" : ".")
  )
    .filter(Boolean)
    .map((segment) => segment.toLowerCase())
  const local = options.local === true || (language === "rust" && /^(?:crate|self|super)::/.test(specifier))
  // resolve tries the whole path, then drops trailing items (Go keeps the trailing folders instead), and matches a
  // suffix of each attempt, so the run of segments a target matched ends at one of these.
  const ends = language === "go" ? [segments.length] : [segments.length, segments.length - 1, segments.length - 2]
  const matched = (target: string) => {
    const stem = target.toLowerCase().replace(/(?:\.d)?\.[^./]+$/, "")
    const paths = [stem, folderOf(stem)]
    return Math.max(
      0,
      ...ends.flatMap((end) =>
        span(1, end).filter((size) => {
          const tail = segments.slice(end - size, end).join("/")
          return paths.some((item) => item === tail || item.endsWith(`/${tail}`))
        }),
      ),
    )
  }
  return same(BrainCode.resolve(file, specifier, language, lookup)).filter(
    (target) => matched(target) >= (local ? 1 : 2),
  )
}

/**
 * What an index file re-exports for tier b (VS-37a): the targets of a TypeScript or JavaScript index file's `export …
 * from` statements, or of a Python `__init__.py`'s relative imports, resolved as outboundSpecifier resolves them, so a
 * name imported through a barrel is found where it is defined. The builder follows them up to
 * IMPACT_LIMITS.reexportDepth hops. Empty for any other file.
 */
export function reexportTargets(input: {
  path: string
  text: string
  lookup: BrainCode.Lookup
  workspace?: BrainCode.Workspace
}): string[] {
  const name = input.path.slice(input.path.lastIndexOf("/") + 1)
  const language = BrainCode.language(input.path)
  if (!BrainCode.INDEX_FILES.includes(name) || (language !== "typescript" && language !== "python")) return []
  const lines = input.text.split("\n")
  return [
    ...new Set(
      BrainCode.importStatements(input.text, language)
        .filter((statement) =>
          language === "python"
            ? statement.specifier.startsWith(".")
            : /^[ \t]*export\b/.test(lines[statement.start - 1] ?? ""),
        )
        .flatMap((statement) =>
          outboundSpecifier(input.path, statement.specifier, language, input.lookup, { workspace: input.workspace }),
        ),
    ),
  ]
}

/**
 * VS-37a's three-tier packing of the slice (addendum A VS-37). Only a caller that passes `packing` reaches it (behind
 * `impact: "graph"`); packSlice stays the VS-25b arm. The budget is packSlice's, min(IMPACT_LIMITS.tokens, share ×
 * context) tokens at IMPACT_LIMITS.charsPerToken, after reserving the frame, the tests, the longest incomplete and
 * fallback notes and IMPACT_TIERS_INSTRUCTION with its line break. Three accounts share what is left, in order a, b,
 * c: each may spend floor(share × what is left) plus what earlier accounts left unused, and each block is charged its
 * rendered size plus a line break, so the block as rendered never exceeds the budget.
 *
 * - **a.** Each changed definition that is innermost to a changed line, outer ones first (path, RIGHT before LEFT,
 *   start, end descending, name), is packed whole as a scope, with the import lines its changed lines use and its
 *   container's signature as the header, unless tier a is off, its file is shown whole (`inline`, RIGHT only, by
 *   default no file), the diff already shows every line of it (`diffShown`, by default every file's diff), or an
 *   earlier scope holds it (covered). One past IMPACT_TIER_CAPS.scopes or past tier a's share is dropped quietly,
 *   with no excerpt built for it: the count is checked first, then the share against the scope's frame, then against
 *   the frame and its own lines, which every excerpt holds. One whose own lines or excerpt are over
 *   IMPACT_TIER_CAPS.scopeChars counts as "a:over-cap". Either way it falls back to its signature. Each changed side
 *   is read once (its lines, containers, references and import statements), however many definitions it has. Then
 *   every other changed definition, in its own order, gets VS-25b's signature anchor, except one inside a packed
 *   scope or the container a packed scope names as its header, in changedDefinitions' order (path, RIGHT before LEFT,
 *   start, name). The first anchor that does not fit closes the account.
 * - **b.** For each use (outboundUses), in order, the exported definitions of its targets, and of what their barrels
 *   re-export, with the name it is exported as (the used name, or the original of a renamed import) as their name or
 *   alias, never "default" unless the use is a default import (`import x from`, `{ default as x }`), sorted by start.
 *   One already taken, changed, inside a packed scope, in a file shown whole or whose first line the diff shows is
 *   skipped. At most IMPACT_TIERS.outboundPerFile per target file and IMPACT_TIER_CAPS.outbound in all; the first that
 *   does not fit closes the account.
 * - **c.** packSlice's call sites in packSlice's order. Top-k keeps the sites of the first k files (tier c off keeps
 *   none), and the rest go to tiers.dropped.rank. A site's window is its statement, clipped to the file and, past
 *   IMPACT_TIERS.statementLines, to that many lines from up to IMPACT_LIMITS.window lines before the site; with no
 *   statement it is IMPACT_LIMITS.window lines either side, and each file with such a packed site counts once as
 *   "c:no-statement". No window repeats a line of its file that an earlier one showed; the first that does not fit
 *   closes the account.
 *
 * The builder's fallbacks count only for the tiers that pack: an "a:" kind needs tier a, a "b:" kind tier b and a
 * "c:" kind tier c, so an arm never names a tier it left off. Deterministic: every list is sorted before use,
 * `unread` included, so input order never matters. No padding: an empty change packs nothing, and with no fallback
 * the block renders nothing. `tokens` counts the block as rendered with its fallback note and without the incomplete
 * one; the builder recounts it.
 */
export function packTiers(input: {
  files: readonly DiffFile[]
  changed: readonly Definition[]
  source: (path: string, side: Side) => TierSource | undefined
  outbound?: {
    uses: readonly OutboundUse[]
    definitionsOf: (path: string) => readonly Definition[] | undefined
    reexports?: (path: string) => readonly string[] | undefined
  }
  references: readonly Reference[]
  ranks: ReadonlyMap<string, number>
  text: (path: string) => string | undefined
  context: number
  tests?: readonly string[]
  inline?: (path: string) => boolean
  diffShown?: (path: string) => boolean
  fallback?: readonly ImpactFallback[]
  unread?: readonly string[] // "reason:path" of tier b targets the builder did not read
  external?: number
  packing?: ImpactPackingInput
}) {
  const packing = impactPacking(input.packing)
  const on = new Set<ImpactTier>(packing.tiers)
  const inline = input.inline ?? (() => false)
  const diffShown = input.diffShown ?? (() => true)
  const tests = (input.tests ?? []).slice()
  const budget = Math.floor(
    Math.min(IMPACT_LIMITS.tokens, Math.floor(IMPACT_LIMITS.share * Math.max(0, input.context))) *
      IMPACT_LIMITS.charsPerToken,
  )
  const frame =
    impactBlock({
      changed: [],
      dependents: [],
      scopes: [],
      outbound: [],
      tests,
      incomplete: [...IMPACT_INCOMPLETE],
      unsearched: Number.MAX_SAFE_INTEGER,
      fallback: IMPACT_FALLBACK_KINDS.map((kind) => ({ kind, count: Number.MAX_SAFE_INTEGER })),
    }).length +
    IMPACT_TIERS_INSTRUCTION.length +
    1
  const avail = frame <= budget ? budget - frame : 0
  const ledger = { used: 0, carry: 0 }
  const spent: Record<ImpactTier, number> = { a: 0, b: 0, c: 0 }
  const open = (tier: ImpactTier) => ({
    tier,
    limit: Math.max(0, Math.min(avail - ledger.used, Math.floor(packing.shares[tier] * avail) + ledger.carry)),
    spent: 0,
    closed: false,
  })
  type Account = ReturnType<typeof open>
  // Whether a block of `chars` characters, with its line break, still fits the account.
  const room = (account: Account, chars: number) => !account.closed && account.spent + chars + 1 <= account.limit
  const fits = (account: Account, block: string) => {
    if (!room(account, block.length)) return false
    account.spent += block.length + 1
    ledger.used += block.length + 1
    return true
  }
  const settle = (account: Account) => {
    ledger.carry = account.limit - account.spent
    spent[account.tier] = account.spent
  }
  const dropped: ImpactTiers["dropped"] = {
    inline: [],
    shown: [],
    covered: [],
    scope: [],
    outbound: [],
    // The builder reads targets concurrently, so its list comes in the order the reads finish.
    targets: (input.unread ?? []).toSorted(compare),
    rank: [],
  }
  const counts = new Map<ImpactFallbackKind, number>()
  const count = (kind: ImpactFallbackKind, by = 1) => counts.set(kind, (counts.get(kind) ?? 0) + by)
  ;(input.fallback ?? [])
    .filter((item) => IMPACT_TIER_NAMES.some((tier) => on.has(tier) && item.kind.startsWith(`${tier}:`)))
    .forEach((item) => count(item.kind, item.count))

  // The lines each side of each changed file's diff shows (added and context lines at head, removed and context lines
  // at base), for the files whose diff the prompt carries.
  const visible = new Map(
    input.files
      .filter((file) => !file.binary && diffShown(file.path))
      .flatMap((file) => {
        const lines = file.hunks.flatMap((hunk) => hunk.lines)
        return [
          [
            sideKey("RIGHT", file.path),
            new Set(lines.flatMap((line) => (line.kind !== "del" && line.newLine ? [line.newLine] : []))),
          ] as const,
          [
            sideKey("LEFT", file.oldPath ?? file.path),
            new Set(lines.flatMap((line) => (line.kind !== "add" && line.oldLine ? [line.oldLine] : []))),
          ] as const,
        ]
      }),
  )
  const shows = (side: Side, path: string, line: number) => visible.get(sideKey(side, path))?.has(line) ?? false
  const inlined = new Set(
    input.files
      .filter((file) => !file.binary && file.status !== "deleted" && inline(file.path))
      .map((file) => file.path),
  )

  // Tier a: a scope for each definition innermost to a changed line, then signature anchors. Each changed side is read
  // once and its scope view built once, however many of its definitions a mass edit changes.
  const a = open("a")
  const sources = new Map<string, TierSource | undefined>()
  const sourceOf = (path: string, side: Side) => {
    const key = sideKey(side, path)
    if (!sources.has(key)) sources.set(key, input.source(path, side))
    return sources.get(key)
  }
  const views = new Map<string, ScopeView | undefined>()
  const viewOf = (path: string, side: Side) => {
    const key = sideKey(side, path)
    if (!views.has(key)) views.set(key, scopeView(path, sourceOf(path, side)))
    return views.get(key)
  }
  const inner = new Set(
    changedDefinitions(input.files, (path, side) => sourceOf(path, side)?.definitions, { ancestors: false }).map(
      definitionKey,
    ),
  )
  // The innermost changed definitions of each side, in start order, with the least end from each one on: whether one
  // starts at or after a definition's start and ends by its end is then one binary search.
  const nested = new Map(
    [
      ...input.changed
        .filter((definition) => inner.has(definitionKey(definition)))
        .toSorted((x, y) => x.start - y.start)
        .reduce((groups, definition) => {
          const key = sideKey(definition.side, definition.path)
          const group = groups.get(key)
          if (group) group.push(definition)
          if (!group) groups.set(key, [definition])
          return groups
        }, new Map<string, Definition[]>()),
    ].map(([key, group]) => [
      key,
      {
        starts: group.map((item) => item.start),
        least: group
          .map((item) => item.end)
          .reduceRight<number[]>((all, end) => {
            all.push(Math.min(end, all.at(-1) ?? end))
            return all
          }, [])
          .toReversed(),
      },
    ]),
  )
  // An exported definition changedDefinitions names only because a changed local one sits inside it.
  const holder = (definition: Definition) => {
    if (inner.has(definitionKey(definition))) return false
    const group = nested.get(sideKey(definition.side, definition.path))
    if (!group) return false
    return (group.least[lowerBound(group.starts, definition.start)] ?? Infinity) <= definition.end
  }
  const scopes: EnclosingScope[] = []
  const scopeImports: number[][] = []
  const scoped = new Set<string>()
  const headers = new Set<string>()
  const within = (item: { path: string; side: Side; start: number; end: number }) =>
    scopes.some(
      (scope) =>
        scope.path === item.path && scope.side === item.side && scope.start <= item.start && item.end <= scope.end,
    )
  input.changed
    .filter((definition) => !holder(definition))
    .toSorted(
      (x, y) =>
        compare(x.path, y.path) ||
        Number(x.side === "LEFT") - Number(y.side === "LEFT") ||
        x.start - y.start ||
        y.end - x.end ||
        compare(x.name, y.name),
    )
    .forEach((definition) => {
      const at = definitionLocation(definition)
      if (within(definition)) {
        dropped.covered.push(at)
        scoped.add(definitionKey(definition))
        return
      }
      if (!on.has("a")) return
      if (definition.side === "RIGHT" && inlined.has(definition.path)) {
        dropped.inline.push(at)
        return
      }
      if (span(definition.start, definition.end).every((line) => shows(definition.side, definition.path, line))) {
        dropped.shown.push(at)
        return
      }
      // Nothing is built for a scope past the count cap or the share. The block's frame (the block with an empty
      // excerpt) and its own lines are both part of the block, so a scope that fails either check would fail `fits`.
      const bare = {
        path: definition.path,
        side: definition.side,
        name: definition.name,
        kind: definition.kind,
        start: definition.start,
        end: definition.end,
      }
      if (!sourceOf(definition.path, definition.side)) return
      if (scopes.length >= IMPACT_TIER_CAPS.scopes || !room(a, impactScope({ ...bare, excerpt: "" }).length)) {
        dropped.scope.push(at)
        return
      }
      const view = viewOf(definition.path, definition.side)
      if (!view) return
      const own = ownLines(definition, view)
      if (own.chars > IMPACT_TIER_CAPS.scopeChars) {
        count("a:over-cap")
        dropped.scope.push(at)
        return
      }
      const header = headerOf(definition, view.containers)
      const framed = { ...bare, ...(header ? { header: header.signature } : {}) }
      if (!room(a, impactScope({ ...framed, excerpt: "" }).length + own.chars)) {
        dropped.scope.push(at)
        return
      }
      const excerpt = scopeExcerpt(definition, view, own.numbers)
      if (excerpt.text.length > IMPACT_TIER_CAPS.scopeChars) {
        count("a:over-cap")
        dropped.scope.push(at)
        return
      }
      const scope: EnclosingScope = { ...framed, excerpt: excerpt.text }
      if (!fits(a, impactScope(scope))) {
        dropped.scope.push(at)
        return
      }
      scopes.push(scope)
      scopeImports.push(excerpt.imports)
      scoped.add(definitionKey(definition))
      if (header) headers.add(definitionKey(header))
    })
  const changed: Definition[] = []
  const unpacked: string[] = []
  input.changed
    .toSorted(
      (x, y) =>
        compare(x.path, y.path) ||
        Number(x.side === "LEFT") - Number(y.side === "LEFT") ||
        x.start - y.start ||
        compare(x.name, y.name),
    )
    .forEach((definition) => {
      if (scoped.has(definitionKey(definition))) return
      if (headers.has(definitionKey(definition)) || within(definition)) {
        dropped.covered.push(definitionLocation(definition))
        return
      }
      if (!a.closed && changed.length < IMPACT_CAPS.definitions) {
        if (fits(a, impactDefinition(definition))) {
          changed.push(definition)
          return
        }
        a.closed = true
      }
      unpacked.push(definitionLocation(definition))
    })
  settle(a)

  // Tier b: the signatures of what the added lines use in other files.
  const b = open("b")
  const outbound: OutboundSignature[] = []
  const given = input.outbound
  if (on.has("b") && given) {
    const anchored = new Set(
      input.changed.filter((item) => item.side === "RIGHT").map((item) => `${item.path}:${item.start}`),
    )
    const taken = new Set<string>()
    const expand = (targets: readonly string[]) =>
      Array.from({ length: IMPACT_LIMITS.reexportDepth }).reduce(
        (all: string[]) => [...new Set([...all, ...all.flatMap((target) => given.reexports?.(target) ?? [])])],
        [...targets],
      )
    const found = given.uses
      .toSorted(
        (x, y) =>
          compare(x.path, y.path) ||
          x.line - y.line ||
          compare(x.name, y.name) ||
          compare(x.specifier, y.specifier) ||
          compare(x.targets.join("\0"), y.targets.join("\0")),
      )
      .flatMap((use) => {
        // A renamed import (`{ format as fmt }`) is looked up by the name it is exported as, never by its local name.
        const exported = use.original ?? use.name
        const byDefault = use.default || use.original === "default"
        return expand(use.targets).flatMap((target) =>
          (given.definitionsOf(target) ?? [])
            .filter(
              (item) =>
                item.exported &&
                (item.name === exported ||
                  (item.aliases ?? []).some((alias) => alias !== "default" && alias === exported) ||
                  (byDefault && (item.aliases ?? []).includes("default"))),
            )
            .toSorted((x, y) => x.start - y.start || compare(x.name, y.name))
            .flatMap((item) => {
              const at = `${target}:${item.start}`
              if (taken.has(at)) return []
              taken.add(at)
              const duplicate =
                anchored.has(at) ||
                inlined.has(target) ||
                within({ path: target, side: "RIGHT", start: item.start, end: item.end }) ||
                shows("RIGHT", target, item.start)
              return duplicate ? [] : [{ target, item, use }]
            }),
        )
      })
    const perFile = new Map<string, number>()
    found.forEach((entry) => {
      const at = `${entry.target}:${entry.item.start}`
      const full =
        outbound.length >= IMPACT_TIER_CAPS.outbound || (perFile.get(entry.target) ?? 0) >= IMPACT_TIERS.outboundPerFile
      if (b.closed || full) {
        dropped.outbound.push(at)
        return
      }
      const signature: OutboundSignature = {
        path: entry.target,
        name: entry.item.name,
        kind: entry.item.kind,
        start: entry.item.start,
        end: entry.item.end,
        signature: entry.item.signature,
        usedIn: `${entry.use.path}:${entry.use.line}`,
      }
      if (!fits(b, impactOutbound(signature))) {
        b.closed = true
        dropped.outbound.push(at)
        return
      }
      outbound.push(signature)
      perFile.set(entry.target, (perFile.get(entry.target) ?? 0) + 1)
    })
  }
  settle(b)

  // Tier c: VS-25b's call sites, each widened to its statement.
  const c = open("c")
  const sites = [
    ...new Map(
      input.references
        .toSorted((x, y) => compare(x.path, y.path) || x.line - y.line || compare(x.name, y.name))
        .map((reference) => [`${reference.path}:${reference.line}`, reference] as const)
        .toReversed(),
    ).values(),
  ]
    .map((reference) => ({ ...reference, rank: input.ranks.get(reference.path) ?? 0 }))
    .toSorted((x, y) => y.rank - x.rank || compare(x.path, y.path) || x.line - y.line || compare(x.name, y.name))
  const topK = on.has("c") ? packing.topK : 0
  const kept = topK === undefined ? undefined : new Set([...new Set(sites.map((site) => site.path))].slice(0, topK))
  const ranked = kept ? sites.filter((site) => kept.has(site.path)) : sites
  dropped.rank.push(
    ...(kept ? sites.filter((site) => !kept.has(site.path)).map((site) => `${site.path}:${site.line}`) : []),
  )
  const seen = new Map<string, Set<number>>()
  const texts = new Map<string, string[]>()
  const dependents: Dependent[] = []
  const budgeted: string[] = []
  const loose = new Set<string>()
  const windows: string[] = []
  ranked.forEach((site) => {
    if (c.closed) {
      budgeted.push(`${site.path}:${site.line}`)
      return
    }
    const text = texts.get(site.path) ?? (input.text(site.path) ?? "").split("\n")
    texts.set(site.path, text)
    const shown = seen.get(site.path) ?? new Set<number>()
    // A final newline ends the last line; it does not start another.
    const lines = text.length > 1 && text.at(-1) === "" ? text.length - 1 : text.length
    const statement =
      site.statement && site.statement.start <= site.line && site.line <= site.statement.end
        ? site.statement
        : undefined
    const range = statement
      ? statementWindow(site.line, statement, lines)
      : {
          from: Math.max(1, site.line - IMPACT_LIMITS.window),
          to: Math.min(lines, site.line + IMPACT_LIMITS.window),
        }
    const fresh = span(range.from, range.to).filter((line) => !shown.has(line))
    const dependent: Dependent = {
      ...site,
      window: fresh
        .map((line) => `${line}: ${text[line - 1].replace(/\r$/, "").slice(0, IMPACT_LIMITS.lineChars)}`)
        .join("\n"),
    }
    // A cap ends only its own kind of block; the share ends the account.
    if (dependents.length >= IMPACT_CAPS.sites) {
      budgeted.push(`${site.path}:${site.line}`)
      return
    }
    if (!fits(c, impactCallSite(dependent))) {
      c.closed = true
      budgeted.push(`${site.path}:${site.line}`)
      return
    }
    fresh.forEach((line) => shown.add(line))
    seen.set(site.path, shown)
    dependents.push(dependent)
    windows.push(...runs(fresh).map((run) => `${site.path}:${run}`))
    if (!statement) loose.add(site.path)
  })
  settle(c)
  if (loose.size) count("c:no-statement", loose.size)

  const fallback = IMPACT_FALLBACK_KINDS.flatMap((kind) => {
    const total = counts.get(kind) ?? 0
    return total > 0 ? [{ kind, count: total }] : []
  })
  const prefix = (side: Side) => (side === "LEFT" ? "base:" : "")
  const tiers: ImpactTiers = {
    packing,
    view: {
      inline: [...inlined].toSorted(compare),
      diffHidden: input.files
        .filter((file) => !file.binary && !diffShown(file.path))
        .map((file) => file.path)
        .toSorted(compare),
    },
    tokens: {
      a: Math.ceil(spent.a / IMPACT_LIMITS.charsPerToken),
      b: Math.ceil(spent.b / IMPACT_LIMITS.charsPerToken),
      c: Math.ceil(spent.c / IMPACT_LIMITS.charsPerToken),
    },
    shown: {
      a: [
        ...scopes.flatMap((scope, index) =>
          [...runs(scopeImports[index] ?? []), `${scope.start}-${scope.end}`].map(
            (run) => `${prefix(scope.side)}${scope.path}:${run}`,
          ),
        ),
        ...changed.map((item) => `${prefix(item.side)}${item.path}:${item.start}-${item.start}`),
      ],
      b: outbound.map((item) => `${item.path}:${item.start}-${item.start}`),
      c: windows,
    },
    external: input.external ?? 0,
    dropped,
  }
  return {
    changed,
    scopes,
    outbound,
    dependents,
    fallback,
    tokens: impactTokens({ changed, dependents, scopes, outbound, tests, fallback }),
    locations: [
      ...new Set([
        ...scopes.filter((scope) => scope.side === "RIGHT").map((scope) => `${scope.path}:${scope.start}`),
        ...changed.filter((item) => item.side === "RIGHT").map((item) => `${item.path}:${item.start}`),
        ...outbound.map((item) => `${item.path}:${item.start}`),
        ...dependents.map((item) => `${item.path}:${item.line}`),
      ]),
    ],
    confirmed: sites.length,
    budget: budgeted,
    definitions: unpacked,
    tiers,
  }
}

// One changed side as tier a's scopes read it, built once per side: its lines and how many there are (a final newline
// ends the last line; it does not start another), its containers, the names its changed lines reference by line, and,
// for each word on an import statement's lines, those lines and the statement's specifier line.
function scopeView(path: string, source: TierSource | undefined) {
  if (!source) return undefined
  const text = source.text.split("\n")
  const language = BrainCode.language(path)
  const statements = language && language !== "text" ? importsOf(source.text, language) : []
  // Each statement line's words, read once even when many statements share a line (a minified file).
  const wordsOn = new Map(
    [...new Set(statements.flatMap((statement) => span(statement.start, statement.end)))].map(
      (line) => [line, new Set(words(text[line - 1] ?? ""))] as const,
    ),
  )
  const imports = new Map<string, number[]>()
  statements.forEach((statement) =>
    span(statement.start, statement.end).forEach((line) =>
      (wordsOn.get(line) ?? new Set<string>()).forEach((word) => {
        const found = imports.get(word)
        if (found) found.push(line, statement.line)
        if (!found) imports.set(word, [line, statement.line])
      }),
    ),
  )
  const named = new Map<number, string[]>()
  source.references
    .filter((reference) => reference.kind !== "import")
    .forEach((reference) => {
      const found = named.get(reference.line)
      if (found) found.push(reference.name)
      if (!found) named.set(reference.line, [reference.name])
    })
  return {
    text,
    lines: text.length > 1 && text.at(-1) === "" ? text.length - 1 : text.length,
    containers: source.definitions.filter((other) => CONTAINERS.has(other.kind)),
    named,
    imports,
  }
}

type ScopeView = NonNullable<ReturnType<typeof scopeView>>

// A definition's own lines, clipped to its file, and how many characters scopeExcerpt renders them in: every excerpt
// of the definition holds them, so it is never shorter.
function ownLines(definition: Definition, view: ScopeView) {
  const numbers = span(Math.max(1, definition.start), Math.min(view.lines, definition.end))
  return {
    numbers,
    chars: numbers.reduce((sum, line) => sum + excerptLine(line, view).length + 1, 0) - (numbers.length ? 1 : 0),
  }
}

// A scope's excerpt: the import lines its changed lines use (each import statement's lines that name one of them, and
// the line its specifier is on, outside the definition, at most IMPACT_TIERS.importLines in line order), then the
// definition's own lines (`own`), numbered, with a "⋯" line between two lines that are not adjacent.
function scopeExcerpt(definition: Definition, view: ScopeView, own: readonly number[]) {
  const used = new Set(
    span(Math.max(1, definition.start), Math.min(view.text.length, definition.end)).flatMap(
      (line) => view.named.get(line) ?? [],
    ),
  )
  const imports = [...new Set([...used].flatMap((name) => view.imports.get(name) ?? []))]
    .filter((line) => line < definition.start || line > definition.end)
    .toSorted((x, y) => x - y)
    .slice(0, IMPACT_TIERS.importLines)
  const numbered = [...imports, ...own]
  return {
    imports,
    text: numbered
      .flatMap((line, index) => [
        ...(index > 0 && line !== numbered[index - 1] + 1 ? ["⋯"] : []),
        excerptLine(line, view),
      ])
      .join("\n"),
  }
}

function excerptLine(line: number, view: ScopeView) {
  return `${line}: ${(view.text[line - 1] ?? "").replace(/\r$/, "").slice(0, IMPACT_LIMITS.lineChars)}`
}

// A file's import statements, each with the names it binds (the words on its lines, strings left out, plus a Go
// import's package name: its last segment, without a major-version segment or suffix), the names a line may qualify a
// member with (TypeScript: the `* as` name, the default import and a `require`'s name; any other language: all of
// them), its default binding (`import Name from`) and its renames (`a as b`, local name to exported one). Python's
// `from X import Y` also gives X.Y, as selectDependents reads it, for a Y that is a submodule.
function importsOf(text: string, language: BrainCode.Language) {
  const lines = text.split("\n")
  const statements = BrainCode.importStatements(text, language).flatMap((statement) => {
    const body = span(statement.start, statement.end)
      .map((line) => lines[line - 1] ?? "")
      .join("\n")
    const names = new Set(words(body))
    const parts = statement.specifier.split("/").filter(Boolean)
    const last = parts.at(-1) ?? ""
    if (language === "go") names.add((/^v\d+$/.test(last) ? (parts.at(-2) ?? last) : last).replace(/\.v\d+$/, ""))
    const stripped = body.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, " ")
    const named = stripped.match(/^[ \t]*import\s+([A-Za-z_$][\w$]*)\s*(?:,|from\b)/)?.[1]
    const binding = named && named !== "type" ? named : undefined
    const qualifiers =
      language === "typescript"
        ? new Set(
            [
              binding,
              stripped.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/)?.[1],
              stripped.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(/)?.[1],
            ].filter((name): name is string => name !== undefined),
          )
        : names
    const renames = new Map(
      [...stripped.matchAll(/([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)].map(
        (match) => [match[2] ?? "", match[1] ?? ""] as const,
      ),
    )
    const own = { ...statement, names, qualifiers, renames, ...(binding ? { default: binding } : {}) }
    if (language !== "python") return [own]
    return [own, ...pythonSubmodules(body).map((specifier) => ({ ...own, specifier }))]
  })
  return [
    ...new Map(
      statements.map((statement) => [`${statement.start}\0${statement.specifier}`, statement] as const),
    ).values(),
  ]
}

// The identifiers on a line, quoted strings left out.
function words(text: string) {
  return text.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, " ").match(/[A-Za-z_$][\w$]*/g) ?? []
}

// The innermost class, interface, struct, trait, enum or module on the definition's side that holds it, and whose
// name is its container when it names one: the header its scope shows.
function headerOf(definition: Definition, definitions: readonly Definition[]) {
  return definitions
    .filter(
      (other) =>
        CONTAINERS.has(other.kind) &&
        other.side === definition.side &&
        other.start <= definition.start &&
        definition.end <= other.end &&
        definitionKey(other) !== definitionKey(definition) &&
        (!definition.container || other.name === definition.container),
    )
    .toSorted((x, y) => x.end - x.start - (y.end - y.start) || y.start - x.start)[0]
}

// A statement window: the statement clipped to the file and, past IMPACT_TIERS.statementLines lines, that many lines
// from up to IMPACT_LIMITS.window lines before the site, kept inside the statement.
function statementWindow(line: number, statement: { start: number; end: number }, lines: number) {
  const start = Math.max(1, statement.start)
  const end = Math.min(lines, statement.end)
  const size = IMPACT_TIERS.statementLines
  if (end - start + 1 <= size) return { from: start, to: end }
  const from = Math.min(Math.max(line - IMPACT_LIMITS.window, start), end - size + 1)
  return { from, to: from + size - 1 }
}

// "start-end" of each run of consecutive lines.
function runs(lines: readonly number[]) {
  return lines
    .toSorted((x, y) => x - y)
    .reduce<[number, number][]>((all, line) => {
      const last = all.at(-1)
      if (last && line <= last[1] + 1) {
        last[1] = Math.max(last[1], line)
        return all
      }
      all.push([line, line])
      return all
    }, [])
    .map(([from, to]) => `${from}-${to}`)
}

function span(from: number, to: number) {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, at) => from + at)
}

function definitionKey(definition: Definition) {
  return `${definition.side}\0${definition.path}\0${definition.name}\0${definition.start}`
}

function definitionLocation(definition: Definition) {
  return definition.side === "RIGHT"
    ? `${definition.path}:${definition.start}`
    : `base:${definition.path}:${definition.start}`
}

function sideKey(side: Side, path: string) {
  return `${side}\0${path}`
}

// The definitions around each of `lines`: the innermost (smallest span, then the later start) and, when that one is not
// exported and `ancestors` holds, the innermost exported one too.
function around(definitions: readonly Definition[], lines: readonly number[], ancestors: boolean) {
  const inner = innermost(definitions, lines)
  const outer = innermost(
    definitions.filter((definition) => definition.exported),
    lines,
  )
  return (line: number): Definition[] => {
    const found = inner.get(line)
    if (!found) return []
    if (found.exported || !ancestors) return [found]
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
