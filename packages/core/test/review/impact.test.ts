import { describe, expect, test } from "bun:test"
import { BrainCode } from "@vectordevai/core/brain/code"
import type { DiffFile, DiffLine } from "@vectordevai/core/review/diff"
import {
  DEFAULT_PACKING,
  IMPACT_FALLBACK_KINDS,
  IMPACT_INCOMPLETE,
  IMPACT_LIMITS,
  IMPACT_TIER_NAMES,
  IMPACT_TIERS,
  barrels,
  capImpactSlice,
  changedDefinitions,
  changedPaths,
  impactNames,
  impactPacking,
  impactRecord,
  impactTokens,
  movedNames,
  orderImpactFiles,
  outboundSpecifier,
  outboundUses,
  packSlice,
  packTiers,
  reexportTargets,
  samePackageLookups,
  samePackageUses,
  selectDependents,
  shrinkImpactDependents,
  wordHits,
  type Definition,
  type ImpactSlice,
  type ImpactTier,
  type OutboundUse,
  type Reference,
  type SamePackageFile,
  type SamePackageLookup,
  type SourceReference,
  type TierSource,
} from "@vectordevai/core/review/impact"
import {
  IMPACT_CAPS,
  IMPACT_INSTRUCTION,
  IMPACT_TIER_CAPS,
  IMPACT_TIERS_INSTRUCTION,
  buildReviewPrompt,
  impactBlock,
} from "@vectordevai/core/review/prompt"
import type { Side } from "@vectordevai/core/review/types"

// VS-25b's slice core: which definitions a change touches, which names are grepped, the import gate before the cap
// (VS-36), the rank, and the packing that the prompt renders. All pure, over hand-written definitions and import
// lines; the engine builder's own tests run it over real git.

function diff(
  path: string,
  options: {
    status?: DiffFile["status"]
    oldPath?: string
    added?: number[]
    removed?: number[]
    binary?: boolean
  } = {},
): DiffFile {
  const lines: DiffLine[] = [
    ...(options.removed ?? []).map((line): DiffLine => ({ kind: "del", oldLine: line, text: "-" })),
    ...(options.added ?? []).map((line): DiffLine => ({ kind: "add", newLine: line, text: "+" })),
  ]
  return {
    path,
    ...(options.oldPath ? { oldPath: options.oldPath } : {}),
    status: options.status ?? "modified",
    binary: options.binary ?? false,
    hunks: lines.length ? [{ header: "@@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }] : [],
    additions: options.added?.length ?? 0,
    deletions: options.removed?.length ?? 0,
    patch: "",
  }
}

function definition(
  path: string,
  name: string,
  start: number,
  end: number,
  extra: Partial<Definition> = {},
): Definition {
  return {
    path,
    side: "RIGHT",
    name,
    kind: "function",
    start,
    end,
    exported: true,
    signature: `export function ${name}()`,
    ...extra,
  }
}

const sides =
  (head: Record<string, Definition[]>, base: Record<string, Definition[]> = {}) =>
  (path: string, side: Side) =>
    side === "RIGHT" ? head[path] : base[path]

describe("changedDefinitions", () => {
  test("takes the innermost definition of each changed line, and the nearest exported one around a local one", () => {
    const outer = definition("src/a.ts", "load", 1, 20)
    const inner = definition("src/a.ts", "parse", 3, 6, { exported: false, kind: "variable", signature: "const parse" })
    const local = definition("src/a.ts", "Cache", 8, 12, { exported: false, kind: "class", signature: "class Cache" })
    const member = definition("src/a.ts", "get", 9, 11, {
      exported: false,
      kind: "method",
      signature: "get()",
      container: "Cache",
    })
    const other = definition("src/a.ts", "save", 22, 25)
    const found = changedDefinitions(
      [diff("src/a.ts", { added: [4, 10, 23] })],
      sides({ "src/a.ts": [outer, inner, local, member, other] }),
    )
    // An edit inside a local helper or a local class's method also names the exported function that holds it.
    expect(found.map((item) => item.name)).toEqual(["load", "parse", "get", "save"])
    expect(impactNames(found)).toEqual(["load", "save"])
  })

  test("a removal inside a function that survives carries the head twin, with its location", () => {
    const head = definition("src/a.ts", "check", 5, 9)
    const base = definition("src/a.ts", "check", 5, 11, { side: "LEFT" })
    const found = changedDefinitions(
      [diff("src/a.ts", { removed: [7, 8] })],
      sides({ "src/a.ts": [head] }, { "src/a.ts": [base] }),
    )
    expect(found).toEqual([head])
    expect(
      packSlice({ changed: found, references: [], ranks: new Map(), text: () => undefined, context: 200_000 })
        .locations,
    ).toEqual(["src/a.ts:5"])
  })

  test("a definition removed or renamed stays LEFT, so the old and new names are both grepped", () => {
    const renamed = definition("src/a.ts", "fetchUser", 1, 4)
    const old = definition("src/a.ts", "getUser", 1, 4, { side: "LEFT" })
    const gone = definition("src/a.ts", "legacy", 6, 8, { side: "LEFT" })
    const found = changedDefinitions(
      [diff("src/a.ts", { removed: [1, 7], added: [1] })],
      sides({ "src/a.ts": [renamed] }, { "src/a.ts": [old, gone] }),
    )
    expect(found.map((item) => `${item.side}:${item.name}`)).toEqual(["RIGHT:fetchUser", "LEFT:getUser", "LEFT:legacy"])
    expect(impactNames(found)).toEqual(["fetchUser", "getUser", "legacy"])
  })

  test("a twin must match name, kind and container; a renamed file's base is read at its old path", () => {
    const base = definition("src/old.ts", "run", 1, 3, { side: "LEFT", container: "A", kind: "method" })
    const head = definition("src/new.ts", "run", 1, 3, { container: "B", kind: "method" })
    const found = changedDefinitions(
      [diff("src/new.ts", { status: "renamed", oldPath: "src/old.ts", removed: [2] })],
      sides({ "src/new.ts": [head] }, { "src/old.ts": [base] }),
    )
    expect(found).toEqual([base])
  })

  test("overloads: only the signatures the change touches are listed, under one grepped name", () => {
    const one = definition("src/a.ts", "pick", 1, 1, { signature: "export function pick(a: string): string" })
    const two = definition("src/a.ts", "pick", 2, 2, { signature: "export function pick(a: number): number" })
    const body = definition("src/a.ts", "pick", 3, 6, { signature: "export function pick(a: unknown)" })
    const found = changedDefinitions([diff("src/a.ts", { added: [2, 4] })], sides({ "src/a.ts": [one, two, body] }))
    expect(found).toEqual([two, body])
    expect(impactNames(found)).toEqual(["pick"])
  })

  test("overloads: a removal inside the implementation or a later overload names that overload, by its place", () => {
    const overloads = (side: Side) => [
      definition("src/a.ts", "f", 1, 1, { side, signature: "export function f(a: string): string" }),
      definition("src/a.ts", "f", 2, 2, { side, signature: "export function f(a: number): number" }),
      definition("src/a.ts", "f", 3, 5, { side, signature: "export function f(a: unknown)" }),
    ]
    const head = overloads("RIGHT")
    const base = overloads("LEFT")
    const removed = (line: number) =>
      changedDefinitions([diff("src/a.ts", { removed: [line] })], sides({ "src/a.ts": head }, { "src/a.ts": base }))
    expect(removed(4)).toEqual([head[2]])
    expect(removed(2)).toEqual([head[1]])
    expect(
      packSlice({ changed: removed(4), references: [], ranks: new Map(), text: () => undefined, context: 200_000 })
        .locations,
    ).toEqual(["src/a.ts:3"])
    // When the sides hold different numbers of them, the place says nothing, and the first is taken.
    const fewer = changedDefinitions(
      [diff("src/a.ts", { removed: [4] })],
      sides({ "src/a.ts": [head[0], head[2]] }, { "src/a.ts": base }),
    )
    expect(fewer).toEqual([head[0]])
  })

  test("costs about the changed lines plus the definitions, not their product", () => {
    const lines = Array.from({ length: 40_000 }, (_, at) => at + 1)
    const many = (side: Side) =>
      Array.from({ length: 8_000 }, (_, at) => definition("gen.ts", `f${at}`, at * 5 + 1, at * 5 + 4, { side }))
    const head = many("RIGHT")
    const base = many("LEFT")
    const started = performance.now()
    const found = changedDefinitions(
      [diff("gen.ts", { added: lines, removed: lines })],
      sides({ "gen.ts": head }, { "gen.ts": base }),
    )
    // Testing every definition at every line took about three seconds here.
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(found).toHaveLength(8_000)
    expect(found[0]).toBe(head[0])
  })

  test("skips binary files, dedupes and sorts by path, RIGHT before LEFT, start and name", () => {
    const head = {
      "b.ts": [definition("b.ts", "b", 1, 9)],
      "a.ts": [definition("a.ts", "a", 1, 9)],
      "bin.ts": [definition("bin.ts", "x", 1, 9)],
    }
    const base = { "a.ts": [definition("a.ts", "z", 1, 9, { side: "LEFT" })] }
    const found = changedDefinitions(
      [
        diff("b.ts", { added: [1, 2, 3] }),
        diff("bin.ts", { added: [1], binary: true }),
        diff("a.ts", { added: [2], removed: [3] }),
      ],
      sides(head, base),
    )
    expect(found.map((item) => `${item.path}:${item.side}:${item.name}`)).toEqual([
      "a.ts:RIGHT:a",
      "a.ts:LEFT:z",
      "b.ts:RIGHT:b",
    ])
  })
})

describe("names", () => {
  test("impactNames: exported names and aliases, never default, plus the fallback, unique and sorted", () => {
    const found = [
      definition("a.ts", "zeta", 1, 2, { aliases: ["default", "Z"] }),
      definition("a.ts", "hidden", 3, 4, { exported: false }),
      definition("a.ts", "alpha", 5, 6),
    ]
    expect(impactNames(found, ["alpha", "beta", ""])).toEqual(["Z", "alpha", "beta", "zeta"])
    expect(impactNames([])).toEqual([])
  })

  test("a string export name that is not one word is never grepped: one name is one fixed pattern", () => {
    const found = [definition("a.ts", "load", 1, 2, { aliases: ["a\n\nb", "x y", "", "$ok", "café_1"] })]
    expect(impactNames(found, ["line\nbreak", "fine"])).toEqual(["$ok", "café_1", "fine", "load"])
    const base = { "a.ts": [definition("a.ts", "gone", 1, 2, { side: "LEFT", aliases: ["two\nlines"] })] }
    expect(movedNames([diff("b.ts", { status: "renamed", oldPath: "a.ts" })], sides({}, base))).toEqual(["gone"])
  })

  test("movedNames: a pure rename or a deletion names the old path's exports, even with no hunk", () => {
    const base = {
      "src/a.ts": [
        definition("src/a.ts", "load", 1, 3, { side: "LEFT", aliases: ["default", "loadAll"] }),
        definition("src/a.ts", "inner", 4, 5, { side: "LEFT", exported: false }),
      ],
      "src/gone.ts": [definition("src/gone.ts", "gone", 1, 2, { side: "LEFT" })],
      "src/same.ts": [definition("src/same.ts", "kept", 1, 2, { side: "LEFT" })],
    }
    const files = [
      diff("src/b.ts", { status: "renamed", oldPath: "src/a.ts" }),
      diff("src/gone.ts", { status: "deleted", removed: [1, 2] }),
      diff("src/same.ts", { added: [1] }),
    ]
    expect(movedNames(files, sides({}, base))).toEqual(["load", "loadAll", "gone"])
    expect(changedDefinitions([files[0]], sides({}, base))).toEqual([])
    expect(changedPaths(files)).toEqual(["src/a.ts", "src/b.ts", "src/gone.ts", "src/same.ts"])
    const many = {
      "x.ts": Array.from({ length: 50 }, (_, at) => definition("x.ts", `n${at}`, at + 1, at + 1, { side: "LEFT" })),
    }
    expect(movedNames([diff("y.ts", { status: "renamed", oldPath: "x.ts" })], sides({}, many))).toHaveLength(
      IMPACT_LIMITS.fallbackNames,
    )
  })

  test("wordHits matches as git grep -w -F does", () => {
    const text = "foo()\nfoo_bar(); foobar\n$foo + x.foo\r\nbar foo"
    expect(wordHits(text, new Set(["foo", "bar"]))).toEqual([
      { line: 1, name: "foo" },
      { line: 3, name: "foo" },
      { line: 4, name: "bar" },
      { line: 4, name: "foo" },
    ])
    expect(wordHits("a", new Set([""]))).toEqual([])
  })
})

describe("barrels", () => {
  test("index files in the changed module's folder and up to two folders above, never a changed file", () => {
    const lookup = BrainCode.lookup([
      "index.ts",
      "pkg/index.ts",
      "pkg/src/index.ts",
      "pkg/src/review/index.ts",
      "pkg/src/review/a.ts",
      "pkg/src/review/deep/b.ts",
      "py/__init__.py",
      "py/mod.py",
      "other/index.ts",
    ])
    expect(barrels(["pkg/src/review/a.ts"], lookup)).toEqual([
      "pkg/index.ts",
      "pkg/src/index.ts",
      "pkg/src/review/index.ts",
    ])
    expect(barrels(["pkg/src/review/deep/b.ts"], lookup)).toEqual(["pkg/src/index.ts", "pkg/src/review/index.ts"])
    expect(barrels(["pkg/src/review/index.ts"], lookup)).toEqual(["pkg/index.ts", "pkg/src/index.ts"])
    expect(barrels(["py/mod.py"], lookup)).toEqual(["index.ts", "py/__init__.py"])
  })
})

describe("selectDependents", () => {
  const select = (
    files: DiffFile[],
    texts: Record<string, string>,
    candidates = Object.keys(texts),
    extra: { workspace?: BrainCode.Workspace; ignored?: (path: string) => boolean; paths?: string[] } = {},
  ) =>
    selectDependents({
      files,
      candidates,
      imports: (path) => texts[path],
      // The changed files last, as a tree listing in path order puts a module that sorts last.
      lookup: BrainCode.lookup([
        ...new Set([...Object.keys(texts), ...(extra.paths ?? []), ...files.map((file) => file.path)]),
      ]),
      ...(extra.workspace ? { workspace: extra.workspace } : {}),
      ...(extra.ignored ? { ignored: extra.ignored } : {}),
    })

  test("the changed diff follows import graph rank and keeps tie order, rename anchors and line objects", () => {
    const a = diff("a.ts", { added: [3] })
    const b = diff("b.ts", { added: [9] })
    const moved = diff("new.ts", { oldPath: "old.ts", status: "renamed", added: [5] })
    const files = [b, a, moved]
    const scanned = select(files, { "caller.ts": 'import "./old"' }, ["caller.ts"], { paths: ["old.ts"] })
    expect(scanned.changedRanks.get("old.ts")).toBeGreaterThan(0)
    expect(scanned.changedRanks.has("caller.ts")).toBe(false)
    expect(scanned.changedRanks.get("b.ts")).toBe(0)
    const ordered = orderImpactFiles(files, scanned.changedRanks)
    expect(ordered).toEqual([moved, b, a])
    expect(ordered[0]).toBe(moved)
    expect(ordered[0]!.hunks[0]!.lines[0]!.newLine).toBe(5)
    expect(files).toEqual([b, a, moved])
    expect(orderImpactFiles(files, new Map())).toEqual(files)
  })

  test("gates before the cap: importers sorted after 230 files that only share the name are all confirmed", () => {
    const texts: Record<string, string> = {}
    for (let at = 0; at < 230; at++) texts[`a/noise${String(at).padStart(3, "0")}.ts`] = ""
    for (let at = 0; at < 30; at++) texts[`z/user${String(at).padStart(2, "0")}.ts`] = 'import { load } from "../src/a"'
    const selection = select([diff("src/a.ts", { added: [1] })], texts)
    expect(selection.confirm.map((entry) => entry.path).toSorted()).toEqual(
      Object.keys(texts).filter((path) => path.startsWith("z/")),
    )
    expect(selection.gate).toHaveLength(230)
    expect(selection.cap).toEqual([])
  })

  test("caps the gated files at 200 in rank order, and never pads", () => {
    const texts: Record<string, string> = { "src/hub.ts": 'export * from "./a"' }
    for (let at = 0; at < 210; at++) texts[`u/f${String(at).padStart(3, "0")}.ts`] = 'import { load } from "../src/a"'
    const selection = select([diff("src/a.ts", { added: [1] })], texts)
    expect(selection.confirm).toHaveLength(IMPACT_LIMITS.confirm)
    expect(selection.cap).toHaveLength(11)
    expect([...selection.confirm.map((entry) => entry.path), ...selection.cap].toSorted()).toEqual(
      Object.keys(texts).toSorted(),
    )
    expect(select([diff("src/a.ts", { added: [1] })], {}).confirm).toEqual([])
    expect(select([diff("src/a.ts", { added: [1] })], { "x.ts": 'import "./y"' })).toMatchObject({
      confirm: [],
      gate: ["x.ts"],
    })
  })

  test("a name collision without an import is dropped at the gate", () => {
    const selection = select([diff("src/a.ts", { added: [1] })], {
      "src/b.ts": 'import { load } from "./a"',
      "src/c.ts": 'import { load } from "./other"',
      "src/other.ts": "",
    })
    expect(selection.confirm.map((entry) => entry.path)).toEqual(["src/b.ts"])
    expect(selection.gate).toEqual(["src/c.ts", "src/other.ts"])
  })

  test("follows re-exports through index files up to two hops", () => {
    const texts = {
      "lib/index.ts": 'export * from "./a"',
      "index.ts": 'export * from "./lib"',
      "app/two.ts": 'import { load } from "../index"',
      "app/one.ts": 'import { load } from "../lib"',
      "deep/lib/index.ts": 'export * from "./a"',
      "deep/index.ts": 'export * from "./lib"',
      "app/three.ts": 'import { far } from "../index"',
    }
    const two = select([diff("lib/a.ts", { added: [1] })], texts, [
      "app/one.ts",
      "app/two.ts",
      "index.ts",
      "lib/index.ts",
    ])
    expect(two.confirm.map((entry) => entry.path).toSorted()).toEqual([
      "app/one.ts",
      "app/two.ts",
      "index.ts",
      "lib/index.ts",
    ])
    // deep/lib/a.ts reaches the root index only through three barrels, one hop more than followed.
    const three = select([diff("deep/lib/a.ts", { added: [1] })], texts, [
      "app/three.ts",
      "deep/index.ts",
      "deep/lib/index.ts",
    ])
    expect(three.confirm.map((entry) => entry.path).toSorted()).toEqual(["deep/index.ts", "deep/lib/index.ts"])
    expect(three.gate).toEqual(["app/three.ts"])
  })

  test("workspace packages and path aliases reach a module the suffix match does not", () => {
    const manifests = {
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": "./src/index.ts" } }),
      "packages/app/tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "~config": ["./src/config.ts"] } } }),
    }
    const workspace = BrainCode.workspace(Object.entries(manifests).map(([path, text]) => ({ path, text })))
    const texts = {
      "packages/core/src/index.ts": 'export * from "./review/types"',
      "packages/app/src/feature.ts": 'import { Side } from "@acme/core"',
      "packages/app/src/settings.ts": 'import { config } from "~config"',
    }
    const files = [
      diff("packages/core/src/review/types.ts", { added: [1] }),
      diff("packages/app/src/config.ts", { added: [1] }),
    ]
    const paths = Object.keys(manifests)
    const with_ = select(files, texts, undefined, { workspace, paths })
    expect(with_.confirm.map((entry) => entry.path).toSorted()).toEqual([
      "packages/app/src/feature.ts",
      "packages/app/src/settings.ts",
      "packages/core/src/index.ts",
    ])
    const without = select(files, texts, undefined, { paths })
    expect(without.gate).toEqual(["packages/app/src/feature.ts", "packages/app/src/settings.ts"])
  })

  test("a Go import of a package of twelve files reaches the changed file even when it sorts last", () => {
    const pkg = Array.from({ length: 12 }, (_, at) => `pkg/store/f${String(at).padStart(2, "0")}.go`)
    const texts = {
      "cmd/main.go": 'package main\n\nimport (\n\t"example.com/app/pkg/store"\n)\n',
      "cmd/other.go": 'package main\n\nimport "example.com/app/pkg/cache"\n',
      "pkg/cache/c.go": "package cache\n",
    }
    const selection = select([diff("pkg/store/f11.go", { added: [1] })], texts, undefined, { paths: pkg })
    expect(selection.confirm.map((entry) => entry.path)).toEqual(["cmd/main.go"])
    expect(selection.confirm[0]?.importsChanged).toBe(true)
    expect(selection.gate).toEqual(["cmd/other.go", "pkg/cache/c.go"])
  })

  test("Go, Java and Kotlin files in a changed module's folder pass without an import; C# files do not", () => {
    const selection = select(
      [
        diff("pkg/store/a.go", { added: [1] }),
        diff("app/Order.java", { added: [1] }),
        diff("cs/Order.cs", { added: [1] }),
      ],
      {
        "pkg/store/b.go": "package store\n",
        "pkg/store/b_test.go": "package store\n",
        "app/Service.kt": "package app\n",
        "cs/Service.cs": "namespace App;\n",
        "pkg/store/x.py": "",
      },
    )
    expect(selection.confirm.map((entry) => `${entry.path}:${entry.importsChanged}`).toSorted()).toEqual([
      "app/Service.kt:false",
      "pkg/store/b.go:false",
      "pkg/store/b_test.go:false",
    ])
    expect(selection.gate).toEqual(["cs/Service.cs", "pkg/store/x.py"])
    expect(selection.tests).toEqual(["pkg/store/b_test.go"])
  })

  // BrainCode resolves `pkg` to the folder's first 8 files and `.` to pkg/__init__.py, so without the submodule rule a
  // package of more than 8 modules, or any relative `from . import`, would drop the importer at the gate.
  test("Python: `from pkg import module` and `from . import module` reach the module", () => {
    const modules = Array.from({ length: 10 }, (_, at) => `pkg/m${at}.py`)
    const selection = select(
      [diff("pkg/models.py", { added: [1] })],
      {
        ...Object.fromEntries(modules.map((module) => [module, ""])),
        "app/one.py": "from pkg import models\n",
        "pkg/two.py": "from . import models as m, other\n",
        "app/three.py": "from pkg import (\n    utils,\n    models,\n)\n",
        "app/four.py": "from pkg import utils\n",
        "pkg/__init__.py": "",
        "pkg/utils.py": "",
      },
      ["app/one.py", "pkg/two.py", "app/three.py", "app/four.py"],
    )
    expect(selection.confirm.map((entry) => entry.path).toSorted()).toEqual([
      "app/one.py",
      "app/three.py",
      "pkg/two.py",
    ])
    expect(selection.gate).toEqual(["app/four.py"])
  })

  test("generated, ignored and unread candidates are set aside before the gate, and the stages add up", () => {
    const texts: Record<string, string | undefined> = {
      "src/gen.ts": '// Code generated by tool. DO NOT EDIT.\nimport { load } from "./a"',
      "src/late.ts": '\n\n\n\n\n// @generated\nimport { load } from "./a"',
      "src/user.ts": 'import { load } from "./a"',
      "vendor/x.ts": 'import { load } from "../src/a"',
      "src/unread.ts": undefined,
      "src/none.ts": "",
    }
    const candidates = [...Object.keys(texts), "src/a.ts", "src/user.ts"]
    const selection = selectDependents({
      files: [diff("src/a.ts", { added: [1] })],
      candidates,
      imports: (path) => texts[path],
      lookup: BrainCode.lookup([...Object.keys(texts), "src/a.ts"]),
      ignored: (path) => path.startsWith("vendor/"),
    })
    expect(selection.ignored).toEqual(["src/gen.ts", "vendor/x.ts"])
    expect(selection.unchecked).toEqual(["src/unread.ts"])
    expect(selection.gate).toEqual(["src/none.ts"])
    // The generated header is read in the first five lines only, as the review's own ignore rule reads it.
    expect(selection.confirm.map((entry) => entry.path)).toEqual(["src/late.ts", "src/user.ts"])
    const unique = new Set(candidates.filter((path) => path !== "src/a.ts")).size
    expect(
      selection.ignored.length +
        selection.unchecked.length +
        selection.gate.length +
        selection.confirm.length +
        selection.cap.length,
    ).toBe(unique)
  })

  test("each confirmed file names the changed modules it reaches, through barrels too", () => {
    const selection = select([diff("src/a.ts", { added: [1] }), diff("src/b.ts", { added: [1] })], {
      "src/index.ts": 'export * from "./b"',
      "src/one.ts": 'import { a } from "./a"',
      "src/both.ts": 'import { a } from "./a"\nimport { b } from "./index"',
      "app/far.ts": 'import { b } from "../src"',
    })
    expect(Object.fromEntries(selection.confirm.map((entry) => [entry.path, entry.reaches]))).toEqual({
      "app/far.ts": ["src/b.ts"],
      "src/both.ts": ["src/a.ts", "src/b.ts"],
      "src/index.ts": ["src/b.ts"],
      "src/one.ts": ["src/a.ts"],
    })
  })

  test("a barrel that is also a candidate is linked once, so it ranks as a plain importer does", () => {
    const selection = select([diff("src/a.ts", { added: [1] })], {
      "src/index.ts": 'export * from "./a"',
      "src/user.ts": 'import { load } from "./a"',
    })
    const rank = (path: string) => selection.confirm.find((entry) => entry.path === path)?.rank
    expect(rank("src/index.ts")).toBeGreaterThan(0)
    expect(rank("src/index.ts")).toBe(rank("src/user.ts"))
  })

  test("C and C++: an include of a changed source's header reaches the source", () => {
    const selection = select(
      [diff("src/compute.c", { added: [1] }), diff("lib/x/src/foo.cpp", { added: [1] })],
      {
        // Beside the header, the relative attempt finds the header alone.
        "src/main.c": '#include "compute.h"\n',
        "app/use.cc": "#include <x/foo.h>\n",
        "app/other.c": '#include "other.h"\n',
        "src/compute.h": "",
        "lib/x/include/x/foo.h": "",
      },
      ["src/main.c", "app/use.cc", "app/other.c"],
      { paths: ["src/other.h", "app/other.h"] },
    )
    expect(Object.fromEntries(selection.confirm.map((entry) => [entry.path, entry.reaches]))).toEqual({
      "app/use.cc": ["lib/x/src/foo.cpp"],
      "src/main.c": ["src/compute.c"],
    })
    expect(selection.confirm.every((entry) => entry.importsChanged)).toBe(true)
    expect(selection.gate).toEqual(["app/other.c"])
    // Without the header rule the include lands on the header only.
    expect(
      BrainCode.dependencies(
        "src/main.c",
        ["compute.h"],
        "c",
        BrainCode.lookup(["src/main.c", "src/compute.h", "src/compute.c"]),
      ),
    ).toEqual(["src/compute.h"])
  })

  test("ranks by graph mass, then path, whatever order the candidates come in", () => {
    const texts = {
      "src/hub.ts": 'export * from "./a"\nexport * from "./b"',
      "src/both.ts": 'import { a } from "./a"\nimport { b } from "./b"',
      "src/one.ts": 'import { a } from "./a"',
      "src/also.ts": 'import { a } from "./a"',
      "src/index.ts": 'export * from "./a"',
      "src/far.ts": 'import { x } from "./index"',
    }
    const files = [diff("src/a.ts", { added: [1] }), diff("src/b.ts", { added: [1] })]
    const first = select(files, texts)
    const order = first.confirm.map((entry) => entry.path)
    expect(order[0]).toBe("src/both.ts")
    // Equal mass falls back to the path.
    expect(order.indexOf("src/also.ts")).toBeLessThan(order.indexOf("src/one.ts"))
    expect(first.confirm.find((entry) => entry.path === "src/one.ts")?.rank).toBe(
      first.confirm.find((entry) => entry.path === "src/also.ts")?.rank,
    )
    for (let at = 0; at < first.confirm.length - 1; at++)
      expect(first.confirm[at].rank).toBeGreaterThanOrEqual(first.confirm[at + 1].rank)
    expect(select(files, texts, Object.keys(texts).toReversed())).toEqual(first)
  })
})

describe("packSlice", () => {
  const text = Array.from({ length: 40 }, (_, at) => `line ${at + 1}`).join("\n") + "\n"
  const reference = (path: string, line: number, name = "load"): Reference => ({
    path,
    line,
    name,
    importsChanged: true,
  })
  const pack = (
    references: Reference[],
    options: { context?: number; changed?: Definition[]; ranks?: Record<string, number>; tests?: string[] } = {},
  ) =>
    packSlice({
      changed: options.changed ?? [],
      references,
      ranks: new Map(Object.entries(options.ranks ?? {})),
      text: () => text,
      context: options.context ?? 200_000,
      ...(options.tests ? { tests: options.tests } : {}),
    })
  const rendered = (packed: ReturnType<typeof pack>, tests: string[] = []) =>
    impactBlock({
      changed: packed.changed,
      dependents: packed.dependents,
      tests,
      incomplete: [...IMPACT_INCOMPLETE],
      unsearched: 123_456,
    })

  test("windows are three lines either side, clipped to the file, and never repeat a line an earlier window showed", () => {
    const packed = pack([
      reference("a.ts", 10),
      reference("a.ts", 12),
      reference("a.ts", 11),
      reference("a.ts", 1),
      reference("a.ts", 40),
      reference("a.ts", 39),
    ])
    expect(
      packed.dependents.map((item) => [
        item.line,
        item.window ? item.window.split("\n").map((line) => Number(line.split(":")[0])) : [],
      ]),
    ).toEqual([
      [1, [1, 2, 3, 4]],
      [10, [7, 8, 9, 10, 11, 12, 13]],
      [11, [14]],
      [12, [15]],
      [39, [36, 37, 38, 39, 40]],
      // Every line of its window is already shown.
      [40, []],
    ])
    expect(packed.dependents[1]?.window.split("\n")[0]).toBe("7: line 7")
  })

  test("orders by rank, path, line and name, keeping the first name at a line", () => {
    const packed = pack(
      [reference("b.ts", 5, "zed"), reference("b.ts", 5, "alpha"), reference("a.ts", 30), reference("c.ts", 2)],
      {
        ranks: { "c.ts": 0.5, "a.ts": 0.1, "b.ts": 0.1 },
      },
    )
    expect(packed.dependents.map((item) => `${item.path}:${item.line}:${item.name}:${item.rank}`)).toEqual([
      "c.ts:2:load:0.5",
      "a.ts:30:load:0.1",
      "b.ts:5:alpha:0.1",
    ])
    expect(packed.confirmed).toBe(3)
    expect(packed.locations).toEqual(["c.ts:2", "a.ts:30", "b.ts:5"])
  })

  test("cuts a line at 200 characters and strips a carriage return", () => {
    const packed = packSlice({
      changed: [],
      references: [reference("a.ts", 1)],
      ranks: new Map(),
      text: () => `${"x".repeat(300)}\r\nnext\r\n`,
      context: 200_000,
    })
    expect(packed.dependents[0]?.window).toBe(`1: ${"x".repeat(200)}\n2: next`)
  })

  test("the budget is at most 15% of the context and at most 6,000 tokens, at 3.5 characters a token, rendered", () => {
    const many = Array.from({ length: 400 }, (_, at) => reference(`f${String(at).padStart(3, "0")}.ts`, 20))
    for (const context of [8_000, 20_000, 1_000_000]) {
      const packed = pack(many, { context, tests: ["t.test.ts"] })
      const budget = Math.floor(Math.min(6_000, Math.floor(0.15 * context)) * 3.5)
      const block = rendered(packed, ["t.test.ts"])
      // The trusted sentence comes with the block, after a line break.
      expect(block.length + IMPACT_INSTRUCTION.length + 1).toBeLessThanOrEqual(budget)
      expect(packed.tokens).toBeLessThanOrEqual(budget / 3.5)
      for (const location of packed.locations) {
        const [path, line] = location.split(":")
        expect(block).toContain(`path="${path}" line="${line}"`)
      }
      expect(packed.dependents.length + packed.budget.length).toBe(packed.confirmed)
    }
    // A share of an 8,000-token context (1,200 tokens) packs fewer sites than the 6,000-token ceiling.
    expect(pack(many, { context: 8_000 }).dependents.length).toBeLessThan(
      pack(many, { context: 1_000_000 }).dependents.length,
    )
    // The prompt's site cap applies: what is packed is what is shown.
    expect(pack(many, { context: 1_000_000 }).dependents).toHaveLength(IMPACT_CAPS.sites)
  })

  test("the first block that does not fit stops packing, and every later one is dropped in order", () => {
    const wide = packSlice({
      changed: [],
      references: [reference("a.ts", 2), reference("big.ts", 2), reference("c.ts", 2)],
      ranks: new Map([
        ["a.ts", 3],
        ["big.ts", 2],
        ["c.ts", 1],
      ]),
      text: (path) => (path === "big.ts" ? Array.from({ length: 7 }, () => "y".repeat(200)).join("\n") : "a\nb\nc"),
      context: 2_000,
    })
    expect(wide.dependents.map((item) => item.path)).toEqual(["a.ts"])
    expect(wide.budget).toEqual(["big.ts:2", "c.ts:2"])
  })

  test("changed definitions go first; LEFT ones are shown without a location; those that do not fit are listed", () => {
    const right = definition("src/a.ts", "load", 3, 9)
    const left = definition("src/a.ts", "old", 4, 6, { side: "LEFT" })
    const packed = pack([reference("u.ts", 5)], { changed: [right, left] })
    expect(packed.changed).toEqual([right, left])
    expect(packed.locations).toEqual(["src/a.ts:3", "u.ts:5"])
    const tight = pack([reference("u.ts", 5)], { changed: [right, left], context: 2_400 })
    expect(tight.definitions.length + tight.changed.length).toBe(2)
    const none = pack([], { changed: [right, left], context: 0 })
    expect(none).toMatchObject({
      changed: [],
      definitions: ["src/a.ts:3", "base:src/a.ts:4"],
      dependents: [],
      locations: [],
    })
    const lots = Array.from({ length: 50 }, (_, at) => definition("d.ts", `d${at}`, at + 1, at + 1, { signature: "s" }))
    const capped = pack([reference("u.ts", 5)], { changed: lots })
    expect(capped.changed).toHaveLength(IMPACT_CAPS.definitions)
    expect(capped.definitions).toHaveLength(10)
    // The definitions' cap ends definitions only: the call site still packs.
    expect(capped.locations.at(-1)).toBe("u.ts:5")
  })

  test("an empty slice renders nothing and costs nothing", () => {
    const empty = pack([])
    expect(empty).toMatchObject({ changed: [], dependents: [], locations: [], confirmed: 0, budget: [], tokens: 0 })
    expect(pack([], { tests: ["t.test.ts"] }).tokens).toBe(0)
    expect(impactBlock({ changed: [], dependents: [], tests: ["t.test.ts"] })).toBe("")
  })

  test("tokens count the block as rendered, never the space reserved for a note", () => {
    const packed = pack([reference("u.ts", 5)], {
      changed: [definition("src/a.ts", "load", 3, 9)],
      tests: ["t.test.ts"],
    })
    const plain = { changed: packed.changed, dependents: packed.dependents, tests: ["t.test.ts"] }
    expect(packed.tokens).toBe(Math.ceil(impactBlock(plain).length / 3.5))
    expect(packed.tokens).toBe(impactTokens(plain))
    const noted = { ...plain, incomplete: ["time" as const, "partial-clone" as const], unsearched: 3 }
    expect(impactTokens(noted)).toBe(Math.ceil(impactBlock(noted).length / 3.5))
    expect(impactTokens(noted)).toBeGreaterThan(packed.tokens)
    // A note alone renders, and costs what it renders.
    const note = { changed: [], dependents: [], tests: [], incomplete: ["error" as const] }
    expect(impactTokens(note)).toBe(Math.ceil(impactBlock(note).length / 3.5))
  })
})

// VS-37a: the three-tier packing, over hand-written sources. The builder's tests run it over real git.
describe("packTiers", () => {
  const numbered = (count: number, label = "line") =>
    Array.from({ length: count }, (_, at) => `${label} ${at + 1}`).join("\n") + "\n"
  // A reference as the parser reports it: at the column where its name starts on its line.
  const use = (text: string, line: number, name: string, kind: SourceReference["kind"], nth = 0): SourceReference => {
    const row = text.split("\n")[line - 1] ?? ""
    const columns = [...row.matchAll(new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`, "g"))].map(
      (match) => match.index ?? 0,
    )
    return { name, line, column: columns[nth] ?? -1, kind }
  }
  const sourceOf =
    (
      sources: Record<string, { text: string; definitions?: Definition[]; references?: SourceReference[] }>,
      base: Record<string, { text: string; definitions?: Definition[]; references?: SourceReference[] }> = {},
    ) =>
    (path: string, side: Side): TierSource | undefined => {
      const found = side === "RIGHT" ? sources[path] : base[path]
      return found
        ? { text: found.text, definitions: found.definitions ?? [], references: found.references ?? [] }
        : undefined
    }
  const reference = (path: string, line: number, extra: Partial<Reference> = {}): Reference => ({
    path,
    line,
    name: "load",
    importsChanged: true,
    ...extra,
  })
  type Input = Parameters<typeof packTiers>[0]
  const tiers = (input: Partial<Input> & Pick<Input, "files" | "source">) =>
    packTiers({
      changed: changedDefinitions(input.files, (path, side) => input.source(path, side)?.definitions),
      references: [],
      ranks: new Map(),
      text: () => undefined,
      context: 200_000,
      ...input,
    })

  function dispatchSlice(): ImpactSlice {
    const tests = ["z.test.ts"]
    const packed = tiers({
      files: [],
      source: () => undefined,
      text: () => "fixture source line\n".repeat(30),
      references: [
        reference("a.ts", 6, { statement: { start: 6, end: 7 } }),
        reference("z.test.ts", 8),
        reference("z.test.ts", 14),
      ],
      ranks: new Map([
        ["a.ts", 2],
        ["z.test.ts", 1],
      ]),
      tests,
    })
    return {
      ...packed,
      tests,
      unsupported: [],
      ms: 4,
      stages: { candidates: 2, gated: 2, confirmed: 3, packed: 3 },
      dropped: { ignored: [], unchecked: [], gate: [], cap: [], time: [], budget: [], definitions: [] },
      clone: { partial: false, sparse: false },
      plan: "tree-ish",
      gitVersion: "2",
      grepMs: 1,
      parseMs: 2,
    }
  }

  test("the final cap charges the escaped wire block and its instruction, with exact recall on both sides of the boundary", () => {
    const slice = dispatchSlice()
    const guarded = {
      ...slice,
      incomplete: ["error"] as ImpactSlice["incomplete"],
      tests: ["</untrusted_tests>.test.ts"],
    }
    const wire = impactBlock(guarded)
    expect(wire).toContain("&lt;/untrusted_tests>")
    const prompt = { mode: "full", trust: "trusted", base: "b", head: "h", diff: "", maxComments: 5 } as const
    const baseline = buildReviewPrompt(prompt)
    const added = buildReviewPrompt({ ...prompt, impact: guarded }).length - baseline.length
    expect(added).toBe(wire.length + IMPACT_TIERS_INSTRUCTION.length + 3)
    const charged = Math.ceil(added / IMPACT_LIMITS.charsPerToken)
    const fits = Math.ceil(charged / IMPACT_LIMITS.share)
    expect(capImpactSlice(guarded, fits)).toBe(guarded)
    const suppressed = capImpactSlice(guarded, Math.floor((charged - 1) / IMPACT_LIMITS.share))
    expect(impactBlock(suppressed)).toBe("")
    expect(buildReviewPrompt({ ...prompt, impact: suppressed })).toBe(baseline)
    expect(suppressed.locations).toEqual([])
    expect(suppressed.dropped.budget).toEqual(["a.ts:6", "z.test.ts:8", "z.test.ts:14"])
    expect(suppressed.tiers?.shown).toEqual({ a: [], b: [], c: [] })
    expect(impactRecord(suppressed)).toMatchObject({
      tokens: 0,
      promptOmitted: "budget",
      stages: { confirmed: 3, packed: 0 },
      incomplete: ["error"],
      ms: 4,
    })
    expect(capImpactSlice(suppressed, 0)).toBe(suppressed)
    expect(slice.locations).toHaveLength(3)
  })

  test("long test paths cannot exceed 6,000 tokens and an error note alone cannot exceed a tiny model's share", () => {
    const slice = dispatchSlice()
    const { scopes: _scopes, outbound: _outbound, tiers: _tiers, fallback: _fallback, ...plain } = slice
    const note: ImpactSlice = {
      ...plain,
      changed: [],
      dependents: [],
      tests: [],
      locations: [],
      incomplete: ["time"],
      stages: { ...slice.stages, confirmed: 0, packed: 0 },
    }
    const huge = {
      ...note,
      tests: Array.from(
        { length: IMPACT_CAPS.tests },
        (_, index) => `${("p".repeat(200) + "/").repeat(19)}file-${index}.test.ts`,
      ),
    }
    expect(impactTokens(huge)).toBeGreaterThan(IMPACT_LIMITS.tokens)
    expect(capImpactSlice(huge, 1_000_000).promptOmitted).toBe("budget")
    const tiny = capImpactSlice(note, 1)
    expect(impactBlock(tiny)).toBe("")
    expect(tiny.incomplete).toEqual(["time"])
    expect(capImpactSlice(note, 100_000)).toBe(note)
  })

  test("a dispatch shrink removes the lowest ranked file and recounts the exact code-free stage record", () => {
    const slice = dispatchSlice()
    const tests = slice.tests
    const next = shrinkImpactDependents(slice)!
    expect(next.locations).toEqual(["a.ts:6"])
    expect(next.tiers?.shown.c).toEqual(["a.ts:6-7"])
    expect(next.tiers!.tokens.c).toBeLessThan(slice.tiers!.tokens.c)
    expect(next.tests).toEqual([])
    expect(next.stages).toEqual({ candidates: 2, gated: 2, confirmed: 3, packed: 1 })
    expect(next.dropped.budget).toEqual(["z.test.ts:8", "z.test.ts:14"])
    expect(next.tokens).toBe(impactTokens(next))
    expect(next.tokens).toBeLessThan(slice.tokens)
    expect(next.fallback).toEqual([])
    const fullTests = [tests[0]!, ...Array.from({ length: IMPACT_CAPS.tests }, (_, n) => `file-${n}.test.ts`)]
    const hidden = fullTests.at(-1)!
    const crowded = { ...slice, tests: fullTests }
    expect(impactBlock(crowded)).not.toContain(hidden)
    expect(impactBlock(shrinkImpactDependents(crowded)!)).not.toContain(hidden)
    const record = impactRecord(next)
    expect(record.stages).toEqual(next.stages)
    expect(record.ms).toBe(4)
    expect(JSON.stringify(record)).not.toContain("fixture source line")
    for (const key of ["changed", "dependents", "scopes", "outbound", "locations", "budget", "confirmed"])
      expect(Object.hasOwn(record, key)).toBe(false)
    const empty = shrinkImpactDependents(next)!
    expect(empty.locations).toEqual([])
    expect(empty.tokens).toBe(0)
    expect(shrinkImpactDependents(empty)).toBeUndefined()
    expect(slice.locations).toEqual(["a.ts:6", "z.test.ts:8", "z.test.ts:14"])
    expect(slice.stages.packed).toBe(3)
  })

  test("tier a packs the innermost changed definition with its container's header, never the whole class", () => {
    const text = numbered(200)
    const store = definition("src/store.ts", "Store", 1, 200, { kind: "class", signature: "export class Store" })
    const save = definition("src/store.ts", "save", 50, 60, {
      kind: "method",
      exported: false,
      container: "Store",
      signature: "private save()",
    })
    const files = [diff("src/store.ts", { added: [55] })]
    const source = sourceOf({ "src/store.ts": { text, definitions: [store, save] } })
    expect(changedDefinitions(files, (path, side) => source(path, side)?.definitions)).toEqual([store, save])
    const packed = tiers({ files, source })
    expect(packed.scopes).toHaveLength(1)
    expect(packed.scopes[0]).toMatchObject({ name: "save", start: 50, end: 60, header: "export class Store" })
    expect(packed.scopes[0]?.excerpt.split("\n")).toEqual(
      Array.from({ length: 11 }, (_, at) => `${50 + at}: line ${50 + at}`),
    )
    // The class is the scope's header, so it gets no block of its own.
    expect(packed.changed).toEqual([])
    expect(packed.tiers.dropped.covered).toEqual(["src/store.ts:1"])
    expect(packed.locations).toEqual(["src/store.ts:50"])
    expect(packed.tiers.shown.a).toEqual(["src/store.ts:50-60"])
    expect(packed.tokens).toBe(impactTokens({ ...packed, tests: [] }))
  })

  test("a changed definition inside a packed scope is covered, never shown twice; an outer exported function keeps its signature", () => {
    const text = numbered(30)
    const load = definition("src/a.ts", "load", 1, 20)
    const parse = definition("src/a.ts", "parse", 5, 8, { exported: false, signature: "function parse()" })
    const run = definition("src/b.ts", "run", 1, 10)
    const step = definition("src/b.ts", "step", 3, 5, { exported: false, signature: "function step()" })
    const files = [diff("src/a.ts", { added: [3, 6] }), diff("src/b.ts", { added: [4] })]
    const packed = tiers({
      files,
      source: sourceOf({
        "src/a.ts": { text, definitions: [load, parse] },
        "src/b.ts": { text: numbered(30, "row"), definitions: [run, step] },
      }),
    })
    // load holds a changed line of its own, so it is the scope and parse is inside it. In b.ts only step holds one:
    // run is named because step is local, and a function is no container, so run keeps its signature.
    expect(packed.scopes.map((scope) => `${scope.path}:${scope.name}`)).toEqual(["src/a.ts:load", "src/b.ts:step"])
    expect(packed.scopes[1]?.header).toBeUndefined()
    expect(packed.tiers.dropped.covered).toEqual(["src/a.ts:5"])
    expect(packed.changed).toEqual([run])
    const block = impactBlock({ ...packed, tests: [] })
    expect(block.split("5: line 5").length - 1).toBe(1)
  })

  test("tier a is skipped for a file shown whole or a definition the diff shows in full; each keeps its signature", () => {
    const text = numbered(20)
    const whole = definition("src/whole.ts", "whole", 2, 9)
    const shown = definition("src/shown.ts", "shown", 3, 4)
    const gone = definition("src/whole.ts", "gone", 1, 3, { side: "LEFT", signature: "export function gone()" })
    const files = [diff("src/whole.ts", { added: [5], removed: [2] }), diff("src/shown.ts", { added: [3, 4] })]
    const source = sourceOf(
      { "src/whole.ts": { text, definitions: [whole] }, "src/shown.ts": { text, definitions: [shown] } },
      { "src/whole.ts": { text, definitions: [gone] } },
    )
    const packed = tiers({ files, source, inline: (path) => path === "src/whole.ts" })
    expect(packed.tiers.dropped.inline).toEqual(["src/whole.ts:2"])
    expect(packed.tiers.dropped.shown).toEqual(["src/shown.ts:3"])
    // A file shown whole shows its head: the removed function still gets a base scope.
    expect(packed.scopes.map((scope) => `${scope.side}:${scope.name}`)).toEqual(["LEFT:gone"])
    expect(packed.changed.map((item) => item.name)).toEqual(["shown", "whole"])
    expect(packed.tiers.view).toEqual({ inline: ["src/whole.ts"], diffHidden: [] })
    expect(packed.tiers.shown.a).toEqual(["base:src/whole.ts:1-3", "src/shown.ts:3-3", "src/whole.ts:2-2"])
    // A LEFT scope is shown without a location: a base line cannot be joined with head-line labels.
    expect(packed.locations).toEqual(["src/shown.ts:3", "src/whole.ts:2"])
    // With the diff left out of the prompt, the definition it showed gets its scope.
    const hidden = tiers({ files, source, diffShown: (path) => path !== "src/shown.ts" })
    expect(hidden.scopes.map((scope) => scope.name)).toContain("shown")
    expect(hidden.tiers.view.diffHidden).toEqual(["src/shown.ts"])
  })

  test("a scope over the size cap counts as a:over-cap; one past tier a's share does not; neither closes tier a", () => {
    const long = Array.from({ length: 300 }, () => "x".repeat(30)).join("\n") + "\n"
    const big = definition("src/a.ts", "big", 1, 300)
    const small = definition("src/b.ts", "small", 1, 3)
    const files = [diff("src/a.ts", { added: [10] }), diff("src/b.ts", { added: [2] })]
    const source = sourceOf({
      "src/a.ts": { text: long, definitions: [big] },
      "src/b.ts": { text: numbered(5), definitions: [small] },
    })
    const packed = tiers({ files, source })
    expect(packed.scopes.map((scope) => scope.name)).toEqual(["small"])
    expect(packed.changed.map((item) => item.name)).toEqual(["big"])
    expect(packed.fallback).toEqual([{ kind: "a:over-cap", count: 1 }])
    expect(packed.tiers.dropped.scope).toEqual(["src/a.ts:1"])
    // 60 lines of 30 characters fit the size cap but not 5% of a 20,000-token context's budget.
    const medium = Array.from({ length: 60 }, () => "y".repeat(30)).join("\n") + "\n"
    const tight = tiers({
      files,
      source: sourceOf({
        "src/a.ts": { text: medium, definitions: [definition("src/a.ts", "big", 1, 60)] },
        "src/b.ts": { text: numbered(5), definitions: [small] },
      }),
      context: 20_000,
      packing: { shares: { a: 0.05 } },
    })
    expect(tight.scopes.map((scope) => scope.name)).toEqual(["small"])
    expect(tight.changed.map((item) => item.name)).toEqual(["big"])
    expect(tight.fallback).toEqual([])
    expect(tight.tiers.dropped.scope).toEqual(["src/a.ts:1"])
  })

  test("a mass edit reads each changed side once, and past the scope cap builds nothing and names no fallback", () => {
    // Every function of a file changed: past IMPACT_TIER_CAPS.scopes, a definition falls back to its signature
    // quietly (the count cap is no size limit), and nothing is read again for it.
    const run = (count: number) => {
      const text =
        'import { h } from "./h"\n' +
        Array.from({ length: count }, (_, at) => `export function f${at}() {\n  return h(${at})\n}`).join("\n") +
        "\n"
      const definitions = Array.from({ length: count }, (_, at) =>
        definition("src/big.ts", `f${at}`, at * 3 + 2, at * 3 + 4),
      )
      const references = definitions.map((item) => ({
        name: "h",
        line: item.start + 1,
        column: 9,
        kind: "call" as const,
      }))
      const files = [diff("src/big.ts", { added: definitions.map((item) => item.start + 1) })]
      const reads = { source: 0, text: 0, definitions: 0, references: 0 }
      const source = (path: string, side: Side): TierSource | undefined => {
        if (path !== "src/big.ts" || side !== "RIGHT") return undefined
        reads.source++
        return {
          get text() {
            reads.text++
            return text
          },
          get definitions() {
            reads.definitions++
            return definitions
          },
          get references() {
            reads.references++
            return references
          },
        }
      }
      const changed = changedDefinitions(files, (path, side) => (side === "RIGHT" ? definitions : undefined))
      const packed = packTiers({
        files,
        changed,
        source,
        references: [],
        ranks: new Map(),
        text: () => undefined,
        context: 200_000,
      })
      return { packed, reads, definitions }
    }
    const small = run(5)
    const large = run(3_000)
    expect(large.packed.scopes).toHaveLength(IMPACT_TIER_CAPS.scopes)
    expect(large.packed.scopes[0]?.excerpt.split("\n").slice(0, 3)).toEqual([
      '1: import { h } from "./h"',
      "2: export function f0() {",
      "3:   return h(0)",
    ])
    expect(large.packed.tiers.dropped.scope).toEqual(
      large.definitions.slice(IMPACT_TIER_CAPS.scopes).map((item) => `src/big.ts:${item.start}`),
    )
    expect(large.packed.fallback).toEqual([])
    // The side is read once, however many definitions: no excerpt past the cap re-reads the file or its imports.
    expect(large.reads).toEqual(small.reads)
    expect(large.reads.source).toBe(1)
  })

  test("the builder's fallbacks count only for the tiers that pack", () => {
    const fallback = [
      { kind: "a:unsupported", count: 1 },
      { kind: "a:over-cap", count: 2 },
      { kind: "b:missing", count: 3 },
    ] as const
    const kept = (packing: { tiers: string[] }) =>
      tiers({ files: [], source: () => undefined, fallback, packing }).fallback.map((item) => item.kind)
    // The c-only arm is VS-25b's content, so it tells the model of no scope it never tried to pack.
    expect(kept({ tiers: ["c"] })).toEqual([])
    expect(
      impactBlock({ ...tiers({ files: [], source: () => undefined, fallback, packing: { tiers: ["c"] } }), tests: [] }),
    ).toBe("")
    expect(kept({ tiers: ["a", "c"] })).toEqual(["a:unsupported", "a:over-cap"])
    expect(kept({ tiers: ["b"] })).toEqual(["b:missing"])
    expect(kept({ tiers: ["a", "b", "c"] })).toEqual(["a:unsupported", "a:over-cap", "b:missing"])
  })

  test("a scope shows the import lines its changed lines use, with each statement's specifier line, before a gap", () => {
    const text = [
      'import { readFile } from "node:fs/promises"',
      "import {",
      "  alpha,",
      "  beta,",
      '} from "./letters"',
      'import gamma from "./gamma"',
      "",
      "export function load() {",
      "  return beta(readFile)",
      "}",
      "",
    ].join("\n")
    const load = definition("src/a.ts", "load", 8, 10)
    const packed = tiers({
      files: [diff("src/a.ts", { added: [9] })],
      source: sourceOf({
        "src/a.ts": {
          text,
          definitions: [load],
          references: [use(text, 9, "beta", "call"), use(text, 9, "readFile", "value")],
        },
      }),
    })
    expect(packed.scopes[0]?.excerpt).toBe(
      [
        '1: import { readFile } from "node:fs/promises"',
        "⋯",
        "4:   beta,",
        '5: } from "./letters"',
        "⋯",
        "8: export function load() {",
        "9:   return beta(readFile)",
        "10: }",
      ].join("\n"),
    )
    expect(packed.tiers.shown.a).toEqual(["src/a.ts:1-1", "src/a.ts:4-5", "src/a.ts:8-10"])
  })

  describe("tier b", () => {
    const APP = [
      'import * as ns from "./ns"',
      'import { format as fmt, other } from "./util"',
      'import { db } from "./db"',
      "",
      "function helper() {",
      "  return 1",
      "}",
      "export function run(obj: Thing) {",
      "  ns.fn()",
      "  obj.save()",
      "  helper()",
      "  fmt(db.save())",
      "}",
      "",
    ].join("\n")
    const appDefinitions = [
      definition("src/app.ts", "helper", 5, 7, { exported: false, signature: "function helper()" }),
      definition("src/app.ts", "run", 8, 13),
    ]
    const appReferences = [
      use(APP, 9, "ns", "value"),
      use(APP, 9, "fn", "call"),
      use(APP, 10, "obj", "value"),
      use(APP, 10, "save", "call"),
      use(APP, 11, "helper", "call"),
      use(APP, 12, "fmt", "call"),
      use(APP, 12, "db", "value"),
      use(APP, 12, "save", "call"),
    ]
    const targets: Record<string, Definition[]> = {
      "src/ns.ts": [definition("src/ns.ts", "fn", 1, 3)],
      "src/util.ts": [
        definition("src/util.ts", "helper", 1, 1),
        definition("src/util.ts", "format", 3, 5, { signature: "export function format(value: string)" }),
        definition("src/util.ts", "other", 7, 7),
      ],
      "src/db.ts": [
        definition("src/db.ts", "db", 1, 1, { kind: "variable", signature: "export const db" }),
        definition("src/db.ts", "save", 3, 5),
      ],
    }
    const lookup = BrainCode.lookup(["src/app.ts", ...Object.keys(targets)])
    const files = [diff("src/app.ts", { added: [9, 10, 11, 12] })]
    const source = sourceOf({ "src/app.ts": { text: APP, definitions: appDefinitions, references: appReferences } })

    test("ties each name to the import that brings it in: a namespace member, a renamed import, a named value", () => {
      const found = outboundUses({ files, source, lookup })
      expect(found.uses.map((item) => `${item.line}:${item.name}:${item.specifier}:${item.original ?? ""}`)).toEqual([
        "9:fn:./ns:",
        "9:ns:./ns:",
        "12:db:./db:",
        "12:fmt:./util:format",
      ])
      expect(found.uses[0]).toMatchObject({ qualified: true, targets: ["src/ns.ts"] })
      expect(found.external).toBe(0)
      const packed = tiers({ files, source, outbound: { uses: found.uses, definitionsOf: (path) => targets[path] } })
      // A local helper that an imported module also exports, a method on a local object, and a member of a named
      // import are none of the imports' names.
      expect(packed.outbound.map((item) => `${item.path}:${item.name}:${item.usedIn}`)).toEqual([
        "src/ns.ts:fn:src/app.ts:9",
        "src/db.ts:db:src/app.ts:12",
        "src/util.ts:format:src/app.ts:12",
      ])
      expect(packed.locations).toContain("src/util.ts:3")
      expect(packed.tiers.shown.b).toEqual(["src/ns.ts:1-1", "src/db.ts:1-1", "src/util.ts:3-3"])
      expect(impactBlock({ ...packed, tests: [] })).toContain(
        '<untrusted_outbound_signature path="src/util.ts" line="3" kind="function" symbol="format" used_in="src/app.ts:12">\nexport function format(value: string)\n</untrusted_outbound_signature>',
      )
      // Tier b off packs none, and its share carries on.
      expect(
        tiers({
          files,
          source,
          outbound: { uses: found.uses, definitionsOf: (path) => targets[path] },
          packing: { tiers: ["a", "c"] },
        }).outbound,
      ).toEqual([])
    })

    test("standard-library and npm names resolve to nothing, even beside files that share them", () => {
      const paths = [
        "src/a.ts",
        "src/path.ts",
        "src/react/index.ts",
        "src/util.ts",
        "json.py",
        "app/main.py",
        "pkg/__init__.py",
        "pkg/mod.py",
        "os/path.py",
        "cmd/main.go",
        "internal/util/a.go",
        "fmt/print.go",
        "src/lib.rs",
        "src/foo.rs",
        "src/foo/bar.rs",
        "serde.rs",
        "src/main/java/com/acme/App.java",
        "src/main/java/com/acme/Bar.java",
        "java/List.java",
        "src/utils/helpers.ts",
      ]
      const files = BrainCode.lookup(paths)
      const strict = (file: string, specifier: string, language: BrainCode.Language) =>
        outboundSpecifier(file, specifier, language, files)
      // BrainCode.resolve's sibling and suffix matches land on these; selectDependents keeps relying on that.
      expect(BrainCode.resolve("src/a.ts", "path", "typescript", files)).toEqual(["src/path.ts"])
      expect(BrainCode.resolve("src/a.ts", "react", "typescript", files)).toEqual(["src/react/index.ts"])
      expect(BrainCode.resolve("app/main.py", "json", "python", files)).toEqual(["json.py"])
      expect(strict("src/a.ts", "path", "typescript")).toEqual([])
      expect(strict("src/a.ts", "react", "typescript")).toEqual([])
      expect(strict("src/a.ts", "./path", "typescript")).toEqual(["src/path.ts"])
      expect(strict("app/main.py", "json", "python")).toEqual([])
      expect(strict("app/main.py", "pkg", "python")).toEqual([])
      expect(strict("app/main.py", "pkg.mod", "python")).toEqual(["pkg/mod.py"])
      expect(strict("app/main.py", "utils.helpers", "python")).toEqual([])
      expect(strict("cmd/main.go", "github.com/acme/repo/internal/util", "go")).toEqual(["internal/util/a.go"])
      expect(strict("cmd/main.go", "fmt", "go")).toEqual([])
      expect(strict("src/lib.rs", "crate::foo::bar", "rust")).toEqual(["src/foo/bar.rs"])
      expect(strict("src/lib.rs", "crate::foo", "rust")).toEqual(["src/foo.rs"])
      expect(strict("src/lib.rs", "serde::Deserialize", "rust")).toEqual([])
      expect(strict("src/lib.rs", "foo", "rust")).toEqual([])
      expect(outboundSpecifier("src/lib.rs", "foo", "rust", files, { local: true })).toEqual(["src/foo.rs"])
      expect(strict("src/main/java/com/acme/App.java", "com.acme.Bar", "java")).toEqual([
        "src/main/java/com/acme/Bar.java",
      ])
      expect(strict("src/main/java/com/acme/App.java", "java.util.List", "java")).toEqual([])
      // A bare specifier reaches a repository file only through the workspace's aliases or packages.
      const workspace = BrainCode.workspace([
        { path: "tsconfig.json", text: JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }) },
      ])
      expect(outboundSpecifier("src/a.ts", "@/util", "typescript", files, { workspace })).toEqual(["src/util.ts"])
      expect(outboundSpecifier("src/a.ts", "react", "typescript", files, { workspace })).toEqual([])
      // The uses of a name bound to an external import are counted, not resolved.
      const text = 'import { join } from "path"\nexport const x = join("a")\n'
      const found = outboundUses({
        files: [diff("src/a.ts", { added: [2] })],
        source: sourceOf({ "src/a.ts": { text, references: [use(text, 2, "join", "call")] } }),
        lookup: files,
      })
      expect(found).toEqual({ uses: [], external: 1 })
    })

    test("Python: a submodule imported from its package, then a member of it", () => {
      const text = "from pkg import mod\n\ndef run():\n    return mod.f()\n"
      const found = outboundUses({
        files: [diff("app/main.py", { added: [4] })],
        source: sourceOf({
          "app/main.py": { text, references: [use(text, 4, "mod", "value"), use(text, 4, "f", "call")] },
        }),
        lookup: BrainCode.lookup(["app/main.py", "pkg/__init__.py", "pkg/mod.py"]),
      })
      expect(found.uses.map((item) => `${item.name}:${item.specifier}:${item.targets.join(",")}`)).toEqual([
        "f:pkg.mod:pkg/mod.py",
        "mod:pkg.mod:pkg/mod.py",
      ])
      // `pkg` alone is one bare segment, which tier b never resolves.
      expect(found.external).toBe(1)
    })

    test("Go and Rust: a member through the package or module the import names", () => {
      const go =
        'package main\n\nimport (\n\t"fmt"\n\t"github.com/acme/repo/internal/util"\n)\n\nfunc main() {\n\tfmt.Println(util.Load())\n}\n'
      const rust = "use crate::store::{self, Cache};\n\nfn run() {\n    store::load(Cache::new());\n}\n"
      const found = outboundUses({
        files: [diff("cmd/main.go", { added: [9] }), diff("src/run.rs", { added: [4] })],
        source: sourceOf({
          "cmd/main.go": {
            text: go,
            references: [
              use(go, 9, "fmt", "value"),
              use(go, 9, "Println", "call"),
              use(go, 9, "util", "value"),
              use(go, 9, "Load", "call"),
            ],
          },
          "src/run.rs": {
            text: rust,
            references: [
              use(rust, 4, "store", "value"),
              use(rust, 4, "load", "call"),
              use(rust, 4, "Cache", "type"),
              use(rust, 4, "new", "call"),
            ],
          },
        }),
        lookup: BrainCode.lookup(["cmd/main.go", "internal/util/load.go", "src/run.rs", "src/store.rs"]),
      })
      expect(found.uses.map((item) => `${item.path}:${item.name}:${item.targets.join(",")}`)).toEqual([
        "cmd/main.go:Load:internal/util/load.go",
        "cmd/main.go:util:internal/util/load.go",
        "src/run.rs:Cache:src/store.rs",
        "src/run.rs:load:src/store.rs",
        "src/run.rs:new:src/store.rs",
        "src/run.rs:store:src/store.rs",
      ])
      expect(found.external).toBe(1)
    })

    test("deduplicated against changed definitions, tier a's scopes and the diff; bounded per file and in all", () => {
      const lines = Array.from({ length: 13 }, (_, at) => `f${at}()`)
      const text = [
        'import { f0, f1, f2, f3, f4 } from "./types"',
        ...Array.from({ length: 12 }, (_, at) => `import { g${at} } from "./m${String(at).padStart(2, "0")}"`),
        'import { shown, scoped, changed } from "./util"',
        "export function run() {",
        ...lines.slice(0, 5),
        ...Array.from({ length: 12 }, (_, at) => `g${at}()`),
        "shown()",
        "scoped()",
        "changed()",
        "}",
        "",
      ].join("\n")
      const rows = text.split("\n")
      const added = rows.flatMap((row, at) => (/^[fg]\d+\(\)|^(shown|scoped|changed)\(\)/.test(row) ? [at + 1] : []))
      const run = definition("src/run.ts", "run", 15, rows.length - 1)
      const references = added.map((line) => use(text, line, rows[line - 1].replace("()", ""), "call"))
      const definitions: Record<string, Definition[]> = {
        "src/types.d.ts": Array.from({ length: 5 }, (_, at) =>
          definition("src/types.d.ts", `f${at}`, at * 2 + 1, at * 2 + 1),
        ),
        ...Object.fromEntries(
          Array.from({ length: 12 }, (_, at) => {
            const file = `src/m${String(at).padStart(2, "0")}.ts`
            return [file, [definition(file, `g${at}`, 1, 1)]]
          }),
        ),
        "src/util.ts": [
          definition("src/util.ts", "shown", 1, 1),
          definition("src/util.ts", "scoped", 3, 6),
          definition("src/util.ts", "changed", 8, 9),
        ],
      }
      const lookup = BrainCode.lookup(["src/run.ts", ...Object.keys(definitions)])
      // util.ts is changed too: its first line is in the diff, `changed` is a changed definition and `scoped` a scope.
      const files = [diff("src/run.ts", { added }), diff("src/util.ts", { added: [1, 4, 9] })]
      const source = sourceOf({
        "src/run.ts": { text, definitions: [run], references },
        "src/util.ts": { text: numbered(10), definitions: definitions["src/util.ts"] },
      })
      const found = outboundUses({ files, source, lookup })
      const packed = tiers({
        files,
        source,
        outbound: { uses: found.uses, definitionsOf: (path) => definitions[path] },
      })
      expect(packed.scopes.map((scope) => `${scope.path}:${scope.name}`)).toContain("src/util.ts:scoped")
      // A declaration file gives at most three, and ten in all.
      expect(packed.outbound.map((item) => `${item.path}:${item.name}`)).toEqual([
        "src/types.d.ts:f0",
        "src/types.d.ts:f1",
        "src/types.d.ts:f2",
        ...Array.from({ length: 7 }, (_, at) => `src/m${String(at).padStart(2, "0")}.ts:g${at}`),
      ])
      expect(packed.tiers.dropped.outbound).toEqual([
        "src/types.d.ts:7",
        "src/types.d.ts:9",
        ...Array.from({ length: 5 }, (_, at) => `src/m${String(at + 7).padStart(2, "0")}.ts:1`),
      ])
      expect(packed.outbound.some((item) => item.path === "src/util.ts")).toBe(false)
    })

    test("a signature whose first line the diff shows is left out, unless that diff is not in the prompt", () => {
      const text = 'import { shown } from "./util"\nexport const x = shown()\n'
      const files = [diff("src/a.ts", { added: [2] }), diff("src/util.ts", { added: [1] })]
      // util.ts changed, but its parse gave no definitions, so only the diff can tell that `shown` is already in view.
      const source = sourceOf({
        "src/a.ts": { text, references: [use(text, 2, "shown", "call")] },
        "src/util.ts": { text: "export function shown() {}\n" },
      })
      const lookup = BrainCode.lookup(["src/a.ts", "src/util.ts"])
      const found = outboundUses({ files, source, lookup })
      const outbound = { uses: found.uses, definitionsOf: () => [definition("src/util.ts", "shown", 1, 1)] }
      expect(tiers({ files, source, outbound }).outbound).toEqual([])
      expect(
        tiers({ files, source, outbound, diffShown: (path) => path !== "src/util.ts" }).outbound.map(
          (item) => `${item.path}:${item.start}`,
        ),
      ).toEqual(["src/util.ts:1"])
    })

    test("a renamed import is looked up by the name it is exported as, never by its local name", () => {
      const text =
        'import { format as fmt } from "./util"\nimport { default as main } from "./main"\nexport const x = fmt(main())\n'
      const files = [diff("src/a.ts", { added: [3] })]
      const source = sourceOf({
        "src/a.ts": { text, references: [use(text, 3, "fmt", "call"), use(text, 3, "main", "call")] },
      })
      const found = outboundUses({
        files,
        source,
        lookup: BrainCode.lookup(["src/a.ts", "src/util.ts", "src/main.ts"]),
      })
      expect(found.uses.map((item) => `${item.name}:${item.original ?? ""}`)).toEqual(["fmt:format", "main:default"])
      // Each target also exports something named like the local alias, which is not what the line uses.
      const definitions: Record<string, Definition[]> = {
        "src/util.ts": [definition("src/util.ts", "fmt", 1, 1), definition("src/util.ts", "format", 3, 5)],
        "src/main.ts": [
          definition("src/main.ts", "main", 1, 1),
          definition("src/main.ts", "start", 3, 5, { aliases: ["default"] }),
        ],
      }
      const packed = tiers({
        files,
        source,
        outbound: { uses: found.uses, definitionsOf: (path) => definitions[path] },
      })
      expect(packed.outbound.map((item) => `${item.path}:${item.name}`)).toEqual([
        "src/util.ts:format",
        "src/main.ts:start",
      ])
    })

    test("a name imported through a barrel is found where the barrel re-exports it from", () => {
      const text = 'import { load } from "./lib"\nexport const x = load()\n'
      const lookup = BrainCode.lookup([
        "src/a.ts",
        "src/lib/index.ts",
        "src/lib/impl.ts",
        "src/lib/more.ts",
        "src/lib/private.ts",
      ])
      const barrel = 'export { load } from "./impl"\nexport * from "./more"\nimport { hidden } from "./private"\n'
      expect(reexportTargets({ path: "src/lib/index.ts", text: barrel, lookup })).toEqual([
        "src/lib/impl.ts",
        "src/lib/more.ts",
      ])
      expect(reexportTargets({ path: "src/lib/impl.ts", text: barrel, lookup })).toEqual([])
      const files = [diff("src/a.ts", { added: [2] })]
      const source = sourceOf({ "src/a.ts": { text, references: [use(text, 2, "load", "call")] } })
      const found = outboundUses({ files, source, lookup })
      expect(found.uses.map((item) => item.targets)).toEqual([["src/lib/index.ts"]])
      const packed = tiers({
        files,
        source,
        outbound: {
          uses: found.uses,
          definitionsOf: (path) => (path === "src/lib/impl.ts" ? [definition(path, "load", 4, 6)] : []),
          reexports: (path) =>
            path === "src/lib/index.ts" ? reexportTargets({ path, text: barrel, lookup }) : undefined,
        },
      })
      expect(packed.outbound.map((item) => `${item.path}:${item.start}`)).toEqual(["src/lib/impl.ts:4"])
    })

    // VS-37c: a Go file reaches the other files of its package without an import.
    describe("same-package Go (VS-37c)", () => {
      const HANDLER = [
        "package proxy",
        "",
        'import "fmt"',
        "",
        "type Handler struct {",
        "\tUpstreams []*Upstream",
        "\tPool",
        "\tRetries   int",
        "}",
        "",
        "func helper() int { return 1 }",
        "",
        "func (h *Handler) Provision() error {",
        '\tif upstream.Dial == "" || get().LookupSRV == "" {',
        '\t\treturn fmt.Errorf("x %v", newPool(Size, helper(), len(h.Upstreams), nil))',
        "\t}",
        "\treturn nil",
        "}",
        "",
      ].join("\n")
      const handlerSource = {
        text: HANDLER,
        definitions: [
          definition("proxy/handler.go", "Handler", 5, 9, { kind: "struct", signature: "type Handler struct {" }),
          definition("proxy/handler.go", "helper", 11, 11, { exported: false, signature: "func helper() int" }),
          definition("proxy/handler.go", "Provision", 13, 18, { kind: "method", container: "Handler" }),
        ],
        references: [
          { name: "fmt", line: 3, column: 8, kind: "import" as const },
          use(HANDLER, 7, "Pool", "type"),
          use(HANDLER, 8, "Retries", "value"),
          use(HANDLER, 8, "int", "type"),
          use(HANDLER, 14, "upstream", "value"),
          use(HANDLER, 14, "Dial", "value"),
          use(HANDLER, 14, "get", "call"),
          use(HANDLER, 14, "LookupSRV", "value"),
          use(HANDLER, 15, "fmt", "value"),
          use(HANDLER, 15, "Errorf", "call"),
          use(HANDLER, 15, "newPool", "call"),
          use(HANDLER, 15, "Size", "value"),
          use(HANDLER, 15, "helper", "call"),
          use(HANDLER, 15, "len", "call"),
          use(HANDLER, 15, "h", "value"),
          use(HANDLER, 15, "Upstreams", "value"),
          use(HANDLER, 15, "nil", "value"),
        ],
      }
      const PATHS = [
        "go.mod",
        "other/x.go",
        "proxy/README",
        "proxy/b.go",
        "proxy/handler.go",
        "proxy/hosts.go",
        "proxy/hosts_test.go",
        "proxy/notes.md",
        "proxy/sub/deep.go",
      ]
      // An iterable that may be walked once only, as a Map's keys are.
      const once = (paths: readonly string[]) => new Map(paths.map((path) => [path, true])).keys()

      test("lookups: the added lines' names no import binds, and the other Go files of the folder", () => {
        const files = [diff("proxy/handler.go", { added: [3, 7, 8, 14, 15] })]
        const found = samePackageLookups({
          files,
          source: sourceOf({ "proxy/handler.go": handlerSource }),
          paths: once(PATHS),
        })
        // An import line, an import's name and its members (fmt, fmt.Errorf), a name the file defines (helper),
        // a predeclared one (len, nil, int) and a field the file's own struct declares (Retries) are left out; an
        // embedded type (Pool) is a use. A member after a call (get().LookupSRV) is a member.
        expect(found).toEqual([
          {
            path: "proxy/handler.go",
            package: "proxy",
            uses: [
              { line: 7, name: "Pool", member: false },
              { line: 14, name: "upstream", member: false },
              { line: 14, name: "Dial", member: true },
              { line: 14, name: "get", member: false },
              { line: 14, name: "LookupSRV", member: true },
              { line: 15, name: "newPool", member: false },
              { line: 15, name: "Size", member: false },
              { line: 15, name: "h", member: false },
              { line: 15, name: "Upstreams", member: true },
            ],
            siblings: ["proxy/b.go", "proxy/hosts.go"],
          },
        ])
        // A changed test file also looks in the folder's test files.
        const test = samePackageLookups({
          files: [diff("proxy/handler_test.go", { status: "added", added: [14] })],
          source: sourceOf({ "proxy/handler_test.go": handlerSource }),
          paths: [...PATHS, "proxy/handler_test.go"],
        })
        expect(test.map((item) => item.siblings)).toEqual([
          ["proxy/b.go", "proxy/handler.go", "proxy/hosts.go", "proxy/hosts_test.go"],
        ])
      })

      test("lookups: two folders from one walk of the tree; none for a file alone, removed, binary or not Go", () => {
        const main = "package main\n\nfunc main() {\n\trun()\n}\n"
        const found = samePackageLookups({
          files: [diff("proxy/handler.go", { added: [14] }), diff("cmd/main.go", { added: [4] })],
          source: sourceOf({
            "proxy/handler.go": handlerSource,
            "cmd/main.go": { text: main, references: [use(main, 4, "run", "call")] },
          }),
          paths: once([...PATHS, "cmd/main.go", "cmd/run.go"]),
        })
        expect(found.map((item) => `${item.path}:${item.package}:${item.siblings.join(",")}`)).toEqual([
          "cmd/main.go:main:cmd/run.go",
          "proxy/handler.go:proxy:proxy/b.go,proxy/hosts.go",
        ])
        const none = (files: DiffFile[], text = main) =>
          samePackageLookups({
            files,
            source: () => ({ text, definitions: [], references: [use(text, 4, "run", "call")] }),
            paths: [...PATHS, "cmd/main.go", "cmd/run.go", "solo/main.go", "solo/sub/x.go"],
          })
        expect(none([diff("solo/main.go", { added: [4] })])).toEqual([])
        expect(none([diff("cmd/main.go", { status: "deleted", removed: [4] })])).toEqual([])
        expect(none([diff("cmd/main.go", { binary: true })])).toEqual([])
        // A file whose package clause cannot be read (here, none at all) looks nothing up.
        expect(none([diff("cmd/main.go", { added: [4] })], "func main() {\n\n\n\trun()\n}\n")).toEqual([])
        // A change with no Go file never walks the tree.
        const untouchable: Iterable<string> = {
          [Symbol.iterator]: () => {
            throw new Error("walked")
          },
        }
        for (const path of ["src/a.ts", "app/main.py", "src/lib.rs", "src/main/java/App.java"])
          expect(
            samePackageLookups({
              files: [diff(path, { added: [4] })],
              source: () => ({ text: main, definitions: [], references: [use(main, 4, "run", "call")] }),
              paths: untouchable,
            }),
          ).toEqual([])
      })

      const HOSTS = [
        "package proxy",
        "",
        "// Upstream is one backend.",
        "type Upstream struct {",
        '\tHost `json:"-"`',
        "\tDial      string // the address",
        "\tLookupSRV string",
        "\tBuf       [Size]byte",
        "\tFn        func(ctx int) error",
        "\tA, B      int",
        "}",
        "",
        "const Size = 4",
        "",
        "type Store interface {",
        "\tLoad(key string) error",
        "}",
        "",
        "type point struct{ x, y int }",
        "",
        "func (u Upstream) String() string {",
        "\tDial := u.Dial",
        "\treturn Dial",
        "}",
        "",
        "var cfg = Upstream{",
        '\tDial: "x",',
        "}",
        "",
        "func newPool() int {",
        "\ttype local struct{ Dial int }",
        "\treturn 0",
        "}",
        "",
        "type Host struct{}",
        "",
      ].join("\n")
      const at = (name: string, start: number, end: number, extra: Partial<Definition> = {}) =>
        definition("proxy/hosts.go", name, start, end, extra)
      // The definitions and the references to the member names, as the parser reports them for this file.
      const hosts = {
        text: HOSTS,
        definitions: [
          at("Upstream", 4, 11, { kind: "struct", signature: 'type Upstream struct { Host `json:"-"` …' }),
          at("Size", 13, 13, { kind: "variable", signature: "const Size" }),
          at("Store", 15, 17, { kind: "interface", signature: "type Store interface { Load(key string) error }" }),
          at("point", 19, 19, { kind: "struct", exported: false, signature: "type point struct{ x, y int }" }),
          at("String", 21, 24, {
            kind: "method",
            container: "Upstream",
            signature: "func (u Upstream) String() string",
          }),
          at("cfg", 26, 28, { kind: "variable", exported: false, signature: "var cfg" }),
          at("newPool", 30, 33, { exported: false, signature: "func newPool() int" }),
          at("local", 31, 31, { kind: "struct", exported: false, signature: "type local struct{ Dial int }" }),
          at("Host", 35, 35, { kind: "struct", signature: "type Host struct{}" }),
        ],
        references: [
          use(HOSTS, 5, "Host", "type"),
          use(HOSTS, 6, "Dial", "value"),
          use(HOSTS, 7, "LookupSRV", "value"),
          use(HOSTS, 8, "Size", "value"),
          use(HOSTS, 9, "ctx", "value"),
          use(HOSTS, 10, "B", "value"),
          use(HOSTS, 16, "Load", "value"),
          use(HOSTS, 16, "key", "value"),
          use(HOSTS, 19, "x", "value"),
          use(HOSTS, 22, "Dial", "value"),
          use(HOSTS, 22, "Dial", "value", 1),
          use(HOSTS, 23, "Dial", "value"),
          use(HOSTS, 27, "Dial", "value"),
          use(HOSTS, 31, "Dial", "value"),
        ],
      }
      const EXTERNAL = "package proxy_test\n\ntype Ext struct {\n\tDial string\n}\n"
      const external = {
        text: EXTERNAL,
        definitions: [definition("proxy/ext_test.go", "Ext", 3, 5, { kind: "struct" })],
        references: [use(EXTERNAL, 4, "Dial", "value")],
      }
      const lookup = (
        uses: SamePackageLookup["uses"],
        siblings = ["proxy/ext_test.go", "proxy/gone.go", "proxy/hosts.go"],
      ) => [{ path: "proxy/handler_test.go", package: "proxy", uses, siblings }]
      const fileOf = (path: string) =>
        path === "proxy/hosts.go" ? hosts : path === "proxy/ext_test.go" ? external : undefined

      test("uses: bare names bind to top-level declarations, members to fields, interface methods and methods", () => {
        const bare = (line: number, name: string) => ({ line, name, member: false })
        const member = (line: number, name: string) => ({ line, name, member: true })
        const found = samePackageUses({
          lookups: lookup([
            bare(20, "newPool"),
            bare(20, "Size"),
            bare(21, "Upstream"),
            bare(21, "local"),
            bare(21, "String"),
            member(22, "Dial"),
            member(22, "Load"),
            member(23, "String"),
            member(23, "Size"),
            member(23, "ctx"),
            member(23, "key"),
            member(24, "x"),
            member(24, "Host"),
            member(24, "B"),
            bare(25, "cfg"),
          ]),
          file: fileOf,
        })
        // Never a function-local type, a method by a bare name, an array length, a func-type or interface method
        // parameter, a method body, a composite literal's key or another package's declaration (proxy_test).
        expect(
          found.map(
            (item) =>
              `${item.line}:${item.name}:${item.qualified ? "member" : "bare"}:${item.targets.join(",")}:${item.declaration?.name}:${item.declaration?.kind}:${item.declaration?.start}`,
          ),
        ).toEqual([
          "20:Size:bare:proxy/hosts.go:Size:variable:13",
          "20:newPool:bare:proxy/hosts.go:newPool:function:30",
          "21:Upstream:bare:proxy/hosts.go:Upstream:struct:4",
          "22:Dial:member:proxy/hosts.go:Upstream.Dial:field:6",
          "22:Load:member:proxy/hosts.go:Store.Load:method:16",
          "23:String:member:proxy/hosts.go:String:method:21",
          "24:B:member:proxy/hosts.go:Upstream.B:field:10",
          "24:Host:member:proxy/hosts.go:Upstream.Host:field:5",
          "24:x:member:proxy/hosts.go:point:struct:19",
          "25:cfg:bare:proxy/hosts.go:cfg:variable:26",
        ])
        // A field is its own line, so a long doc-commented struct still shows it; nothing is the use's own text.
        expect(found[3]).toEqual({
          path: "proxy/handler_test.go",
          line: 22,
          name: "Dial",
          specifier: "",
          qualified: true,
          default: false,
          targets: ["proxy/hosts.go"],
          declaration: {
            path: "proxy/hosts.go",
            side: "RIGHT",
            name: "Upstream.Dial",
            kind: "field",
            start: 6,
            end: 6,
            exported: true,
            signature: "Dial string // the address",
            container: "Upstream",
          },
        })
        // The lookup's package must match: proxy_test's Ext is never bound, even alone.
        expect(samePackageUses({ lookups: lookup([member(1, "Dial")], ["proxy/ext_test.go"]), file: fileOf })).toEqual(
          [],
        )
        expect(
          samePackageUses({
            lookups: [
              {
                path: "proxy_test/a_test.go",
                package: "proxy_test",
                uses: [member(1, "Dial")],
                siblings: ["proxy/ext_test.go"],
              },
            ],
            file: fileOf,
          }).map((item) => item.declaration?.name),
        ).toEqual(["Ext.Dial"])
      })

      // A use pinned to a declaration, as samePackageUses gives it.
      const pinned = (line: number, name: string, declaration: Definition): OutboundUse => ({
        path: "proxy/handler.go",
        line,
        name,
        specifier: "",
        qualified: true,
        default: false,
        targets: [declaration.path],
        declaration,
      })
      const field = (path: string, holder: string, name: string, line: number): Definition =>
        definition(path, `${holder}.${name}`, line, line, {
          kind: "field",
          signature: `${name} string`,
          container: holder,
        })
      const handlerFiles = [diff("proxy/handler.go", { added: [14] })]
      const handlerOnly = sourceOf({ "proxy/handler.go": { text: HANDLER } })

      test("packTiers packs a pinned declaration exactly, exported or not, and each member on its own line", () => {
        const newPool = at("newPool", 30, 33, { exported: false, signature: "func newPool() int" })
        const packed = tiers({
          files: handlerFiles,
          source: handlerOnly,
          outbound: {
            uses: [
              pinned(14, "newPool", newPool),
              pinned(14, "Dial", field("proxy/hosts.go", "Upstream", "Dial", 6)),
              pinned(14, "LookupSRV", field("proxy/hosts.go", "Upstream", "LookupSRV", 7)),
            ],
            // A same-named exported definition elsewhere in the file is not what the pin names.
            definitionsOf: () => [at("newPool", 2, 2), at("Dial", 40, 40)],
          },
        })
        expect(
          packed.outbound.map((item) => `${item.path}:${item.start}:${item.kind}:${item.name}:${item.signature}`),
        ).toEqual([
          "proxy/hosts.go:6:field:Upstream.Dial:Dial string",
          "proxy/hosts.go:7:field:Upstream.LookupSRV:LookupSRV string",
          "proxy/hosts.go:30:function:newPool:func newPool() int",
        ])
        expect(packed.tiers.shown.b).toEqual(["proxy/hosts.go:6-6", "proxy/hosts.go:7-7", "proxy/hosts.go:30-30"])
        expect(packed.locations).toEqual(["proxy/hosts.go:6", "proxy/hosts.go:7", "proxy/hosts.go:30"])
      })

      test("packTiers skips a pinned declaration the diff shows or a scope holds, and keeps three a file", () => {
        const text = numbered(40)
        const upstream = at("Upstream", 4, 11, { kind: "struct", signature: "type Upstream struct {" })
        // hosts.go changed at lines 6 and 9: Dial's line is in the diff, and Upstream is packed whole as a scope.
        const files = [...handlerFiles, diff("proxy/hosts.go", { added: [6, 9] })]
        const source = sourceOf({
          "proxy/handler.go": { text: HANDLER },
          "proxy/hosts.go": { text, definitions: [upstream] },
        })
        const holders = ["A", "B", "C", "D"].map((name, index) =>
          at(name, 20 + index * 4, 22 + index * 4, { kind: "struct", signature: `type ${name} struct {` }),
        )
        const packed = tiers({
          files,
          source,
          outbound: {
            uses: [
              pinned(14, "Dial", field("proxy/hosts.go", "Upstream", "Dial", 6)),
              pinned(14, "LookupSRV", field("proxy/hosts.go", "Upstream", "LookupSRV", 7)),
              ...holders.map((holder) => pinned(15, holder.name, holder)),
            ],
            definitionsOf: () => [],
          },
        })
        expect(packed.scopes.map((scope) => `${scope.path}:${scope.name}`)).toContain("proxy/hosts.go:Upstream")
        expect(packed.outbound.map((item) => `${item.path}:${item.start}`)).toEqual([
          "proxy/hosts.go:20",
          "proxy/hosts.go:24",
          "proxy/hosts.go:28",
        ])
        expect(packed.tiers.dropped.outbound).toEqual(["proxy/hosts.go:32"])
      })

      test("pinned and import uses sort the same whatever order they come in", () => {
        // Two holders of one member in one sibling: the same path, line, name, specifier and target.
        const uses = [
          pinned(14, "Dial", field("proxy/hosts.go", "A", "Dial", 9)),
          pinned(14, "Dial", field("proxy/hosts.go", "B", "Dial", 4)),
          pinned(14, "Dial", field("proxy/hosts.go", "C", "Dial", 13)),
          pinned(14, "Dial", field("proxy/hosts.go", "D", "Dial", 17)),
          {
            path: "proxy/handler.go",
            line: 14,
            name: "Dial",
            specifier: "example.com/app/dial",
            qualified: true,
            default: false,
            targets: ["dial/dial.go"],
          },
        ]
        const definitionsOf = (path: string) => (path === "dial/dial.go" ? [definition(path, "Dial", 1, 3)] : [])
        const one = tiers({ files: handlerFiles, source: handlerOnly, outbound: { uses, definitionsOf } })
        const two = tiers({
          files: handlerFiles,
          source: handlerOnly,
          outbound: { uses: uses.toReversed(), definitionsOf },
        })
        expect(JSON.stringify(two)).toBe(JSON.stringify(one))
        // By declaration start, three from hosts.go, then the import's.
        expect(one.outbound.map((item) => `${item.path}:${item.start}`)).toEqual([
          "proxy/hosts.go:4",
          "proxy/hosts.go:9",
          "proxy/hosts.go:13",
          "dial/dial.go:1",
        ])
        expect(one.tiers.dropped.outbound).toEqual(["proxy/hosts.go:17"])
      })

      test("no type inference: a common method name binds to every sibling method of that name, in line order", () => {
        const text = [
          "package proxy",
          "",
          "func run(upstream *Upstream) error {",
          "\tif err := check(); err != nil {",
          "\t\treturn errors.New(err.Error())",
          "\t}",
          '\treturn upstream.Dial == ""',
          "}",
          "",
        ].join("\n")
        const errs =
          'package proxy\n\ntype proxyError struct{}\n\nfunc (e *proxyError) Error() string {\n\treturn ""\n}\n'
        const lookups = samePackageLookups({
          files: [diff("proxy/run.go", { added: [4, 5, 7] })],
          source: sourceOf({
            "proxy/run.go": {
              text,
              definitions: [definition("proxy/run.go", "run", 3, 8, { exported: false })],
              references: [
                use(text, 4, "err", "value"),
                use(text, 4, "check", "call"),
                use(text, 4, "err", "value", 1),
                use(text, 4, "nil", "value"),
                use(text, 5, "errors", "value"),
                use(text, 5, "New", "call"),
                use(text, 5, "err", "value"),
                use(text, 5, "Error", "call"),
                use(text, 7, "upstream", "value"),
                use(text, 7, "Dial", "value"),
              ],
            },
          }),
          paths: ["proxy/errors.go", "proxy/hosts.go", "proxy/run.go"],
        })
        const files: Record<string, SamePackageFile> = {
          "proxy/errors.go": {
            text: errs,
            definitions: [
              definition("proxy/errors.go", "proxyError", 3, 3, { kind: "struct", exported: false }),
              definition("proxy/errors.go", "Error", 5, 7, { kind: "method", container: "proxyError" }),
            ],
            references: [],
          },
          "proxy/hosts.go": hosts,
        }
        const uses = samePackageUses({ lookups, file: (path) => files[path] })
        // `errors` is not imported here, so errors.New is looked up too; nothing declares New, so it binds nothing.
        expect(
          uses.map((item) => `${item.line}:${item.name}:${item.declaration?.path}:${item.declaration?.name}`),
        ).toEqual(["5:Error:proxy/errors.go:Error", "7:Dial:proxy/hosts.go:Upstream.Dial"])
        const packed = tiers({
          files: [diff("proxy/run.go", { added: [4, 5, 7] })],
          source: sourceOf({ "proxy/run.go": { text } }),
          outbound: { uses, definitionsOf: () => [] },
        })
        // The method a type the change never names declares is packed first, ahead of the field the change reads.
        expect(packed.outbound.map((item) => `${item.path}:${item.name}`)).toEqual([
          "proxy/errors.go:Error",
          "proxy/hosts.go:Upstream.Dial",
        ])
      })

      test("a crafted sibling or changed line costs near-linear time", () => {
        // Each file is under the parser's 1 MiB cap. Before the bounds, the declaration check over each whole prefix of
        // the wide line, the body containment check over every pair of functions, the per-name insertion sort of the
        // methods and the qualifier check over every prefix of the changed line each took seconds to minutes here.
        const fields = `\t${Array.from({ length: 100_000 }, () => "Dial").join(", ")} int`
        const wide: SamePackageFile = {
          text: ["package proxy", "type Wide struct {", fields, "}", "type Late struct {", "\tDial int", "}", ""].join(
            "\n",
          ),
          definitions: [
            definition("proxy/wide.go", "Wide", 2, 4, { kind: "struct" }),
            definition("proxy/wide.go", "Late", 5, 7, { kind: "struct" }),
          ],
          references: [
            ...Array.from({ length: 100_000 }, (_, at) => ({
              name: "Dial",
              line: 3,
              column: 1 + at * 6,
              kind: "value" as const,
            })),
            { name: "Dial", line: 6, column: 1, kind: "value" as const },
          ],
        }
        // 30,000 one-line functions, then 25,000 one-line methods of one name.
        const functions = Array.from({ length: 30_000 }, (_, at) => `func f${at}() {}`)
        const methods = Array.from({ length: 25_000 }, () => "func (T) Close() {}")
        const many: SamePackageFile = {
          text: ["package proxy", ...functions, ...methods, ""].join("\n"),
          definitions: [
            ...functions.map((_, at) => definition("proxy/many.go", `f${at}`, at + 2, at + 2)),
            ...methods.map((_, at) =>
              definition("proxy/many.go", "Close", at + 30_002, at + 30_002, { kind: "method", container: "T" }),
            ),
          ],
          references: [],
        }
        // And a changed line of 15,000 different members, each after a 40-letter name.
        const line = `\treturn ${Array.from({ length: 15_000 }, (_, at) => `${"q".repeat(40)}.N${at}`).join(" + ")}`
        const text = ["package proxy", "", "func run() int {", line, "}", ""].join("\n")
        const references = [...line.matchAll(/(q{40})\.(N\d+)/g)].flatMap((match): SourceReference[] => [
          { name: match[1], line: 4, column: match.index, kind: "value" },
          { name: match[2], line: 4, column: match.index + 41, kind: "value" },
        ])
        for (const item of [wide.text, many.text, text]) expect(item.length).toBeLessThan(1_048_576)
        const started = performance.now()
        const lookups = samePackageLookups({
          files: [diff("proxy/run.go", { added: [4] })],
          source: sourceOf({
            "proxy/run.go": { text, definitions: [definition("proxy/run.go", "run", 3, 5)], references },
          }),
          paths: ["proxy/many.go", "proxy/run.go", "proxy/wide.go"],
        })
        const uses = samePackageUses({
          lookups: lookups.map((lookup) => ({
            ...lookup,
            uses: [
              ...lookup.uses,
              { line: 4, name: "Close", member: true },
              { line: 4, name: "Dial", member: true },
              { line: 4, name: "f29999", member: false },
            ],
          })),
          file: (path) => (path === "proxy/wide.go" ? wide : path === "proxy/many.go" ? many : undefined),
        })
        const ms = performance.now() - started
        expect(lookups.map((lookup) => lookup.uses.length)).toEqual([15_001])
        // Every method of the name, one field line however many names it lists, and the one function of that name.
        // Late's Dial is the price of the bound: it comes after the first MEMBER_REFERENCES, so it is never seen.
        expect(uses.slice(0, 25_000).map((item) => item.declaration?.start)).toEqual(
          Array.from({ length: 25_000 }, (_, at) => at + 30_002),
        )
        expect(
          uses.slice(25_000).map((item) => `${item.targets[0]}:${item.declaration?.name}:${item.declaration?.start}`),
        ).toEqual(["proxy/wide.go:Wide.Dial:3", "proxy/many.go:f29999:30001"])
        expect(uses[25_000]?.declaration?.signature).toHaveLength(240)
        expect(ms).toBeLessThan(3_000)
      })
    })
  })

  test("tier c widens each window to its statement, at most eight lines; with none, three lines either side", () => {
    const text = numbered(40)
    const packed = tiers({
      files: [],
      source: () => undefined,
      references: [
        reference("a.ts", 10, { statement: { start: 9, end: 11 } }),
        reference("a.ts", 20, { statement: { start: 15, end: 30 } }),
        reference("a.ts", 39, { statement: { start: 38, end: 45 } }),
        // A statement that does not hold the site is ignored.
        reference("b.ts", 33, { statement: { start: 1, end: 2 } }),
        reference("b.ts", 5),
      ],
      ranks: new Map([
        ["a.ts", 2],
        ["b.ts", 1],
      ]),
      text: () => text,
    })
    const lines = (window: string) => window.split("\n").map((line) => Number(line.split(":")[0]))
    expect(packed.dependents.map((item) => [item.path, item.line, lines(item.window)])).toEqual([
      ["a.ts", 10, [9, 10, 11]],
      ["a.ts", 20, [17, 18, 19, 20, 21, 22, 23, 24]],
      ["a.ts", 39, [38, 39, 40]],
      ["b.ts", 5, [2, 3, 4, 5, 6, 7, 8]],
      ["b.ts", 33, [30, 31, 32, 33, 34, 35, 36]],
    ])
    // Two loose sites in one file count once.
    expect(packed.fallback).toEqual([{ kind: "c:no-statement", count: 1 }])
    expect(packed.tiers.shown.c).toEqual(["a.ts:9-11", "a.ts:17-24", "a.ts:38-40", "b.ts:2-8", "b.ts:30-36"])
  })

  test("top-k keeps the call sites of the first k dependent files; tier c off keeps none", () => {
    const text = numbered(40)
    const references = [
      reference("f1.ts", 5),
      reference("f1.ts", 20),
      reference("f2.ts", 5),
      reference("f3.ts", 5),
      reference("f3.ts", 15),
      reference("f3.ts", 25),
    ]
    const ranks = new Map([
      ["f1.ts", 3],
      ["f2.ts", 2],
      ["f3.ts", 1],
    ])
    const top = tiers({ files: [], source: () => undefined, references, ranks, text: () => text, packing: { topK: 2 } })
    expect(top.dependents.map((item) => `${item.path}:${item.line}`)).toEqual(["f1.ts:5", "f1.ts:20", "f2.ts:5"])
    expect(top.tiers.dropped.rank).toEqual(["f3.ts:5", "f3.ts:15", "f3.ts:25"])
    expect(top.confirmed).toBe(top.dependents.length + top.budget.length + top.tiers.dropped.rank.length)
    expect(top.tiers.packing).toEqual({ tiers: ["a", "b", "c"], shares: IMPACT_TIERS.shares, topK: 2 })
    const off = tiers({
      files: [],
      source: () => undefined,
      references,
      ranks,
      text: () => text,
      packing: { tiers: ["a", "b"] },
    })
    expect(off.dependents).toEqual([])
    expect(off.tiers.dropped.rank).toHaveLength(6)
    expect(tiers({ files: [], source: () => undefined, references, ranks, text: () => text }).dependents).toHaveLength(
      6,
    )
  })

  test("shares cap each tier, and what a tier leaves unused carries on to the next", () => {
    const text = numbered(400, "x".repeat(150))
    const references = Array.from({ length: 60 }, (_, at) => reference(`f${String(at).padStart(2, "0")}.ts`, 20))
    const pack = (shares: Partial<Record<ImpactTier, number>>, packing: { tiers?: string[] } = {}) =>
      tiers({
        files: [],
        source: () => undefined,
        references,
        text: () => text,
        context: 40_000,
        packing: { ...packing, shares },
      })
    const full = pack({ a: 0.4, b: 0.15, c: 0.45 })
    const alone = pack({ a: 0, b: 0, c: 0.45 })
    // Tiers a and b have nothing to pack, so tier c spends their shares too.
    expect(full.dependents.length).toBeGreaterThan(alone.dependents.length)
    // 15% of 40,000 tokens is the 6,000-token ceiling: 21,000 characters, of which tier c alone may spend 45% at most.
    expect(alone.tiers.tokens.c * 3.5).toBeLessThanOrEqual(0.45 * 21_000 + 3.5)
    expect(full.tiers.tokens.a).toBe(0)
    expect(full.tiers.tokens.c).toBeGreaterThan(alone.tiers.tokens.c)
    // A disabled tier's share flows on as well.
    expect(pack({ a: 0, b: 0.5, c: 0.45 }, { tiers: ["a", "c"] }).dependents.length).toBeGreaterThan(
      alone.dependents.length,
    )
  })

  test("the block, its notes and the trusted sentence never exceed the budget, whatever packs", () => {
    const text = numbered(400, "y".repeat(120))
    const many = Array.from({ length: 60 }, (_, at) => `src/d${String(at).padStart(2, "0")}.ts`)
    const definitions = many.map((file) => definition(file, "load", 1, 30))
    const files = many.map((file) => diff(file, { added: [5] }))
    const source = sourceOf(
      Object.fromEntries(many.map((file, at) => [file, { text, definitions: [definitions[at]] }])),
    )
    const fallback = IMPACT_FALLBACK_KINDS.map((kind) => ({ kind, count: 999_999 }))
    const references = many.map((file) => reference(`u/${file}`, 50, { statement: { start: 45, end: 60 } }))
    const outbound = {
      uses: many.map((file, at) => ({
        path: file,
        line: 5,
        name: "dep",
        specifier: "./dep",
        qualified: false,
        default: false,
        targets: [`src/dep${at}.ts`],
      })),
      definitionsOf: (path: string) => [
        definition(path, "dep", 1, 2, { signature: `export function dep(${"z".repeat(150)})` }),
      ],
    }
    for (const context of [4_000, 8_000, 20_000, 1_000_000]) {
      const packed = tiers({
        files,
        source,
        references,
        outbound,
        text: () => text,
        context,
        fallback,
        tests: ["t.test.ts"],
      })
      const budget = Math.floor(Math.min(6_000, Math.floor(0.15 * context)) * 3.5)
      const block = impactBlock({
        ...packed,
        tests: ["t.test.ts"],
        incomplete: [...IMPACT_INCOMPLETE],
        unsearched: 123_456,
      })
      expect(block.length + IMPACT_TIERS_INSTRUCTION.length + 1).toBeLessThanOrEqual(budget)
      expect(packed.tiers.tokens.a + packed.tiers.tokens.b + packed.tiers.tokens.c).toBeLessThanOrEqual(
        Math.ceil(budget / 3.5) + 3,
      )
      // What is packed is what is shown.
      for (const location of packed.locations) {
        const [path, line] = location.split(":")
        expect(block).toContain(`path="${path}" line="${line}"`)
      }
      expect(packed.confirmed).toBe(packed.dependents.length + packed.budget.length + packed.tiers.dropped.rank.length)
      if (context === 1_000_000) {
        expect(packed.scopes.length).toBeGreaterThan(0)
        expect(packed.outbound.length).toBeGreaterThan(0)
        expect(packed.dependents.length).toBeGreaterThan(0)
      }
    }
    // A context too small for the frame packs nothing, and the fallback still reaches the prompt.
    const none = tiers({ files, source, references, outbound, text: () => text, context: 100, fallback })
    expect(none).toMatchObject({ scopes: [], changed: [], outbound: [], dependents: [] })
    expect(none.definitions).toHaveLength(60)
    expect(none.fallback.map((item) => item.kind)).toEqual([...IMPACT_FALLBACK_KINDS])
  })

  test("with tier c alone, whole shares and no statements, it packs exactly what packSlice packs", () => {
    const text = numbered(40)
    const definitions = [definition("src/a.ts", "load", 3, 9), definition("src/b.ts", "save", 1, 4)]
    const references = [reference("u.ts", 10), reference("u.ts", 12), reference("v.ts", 30), reference("w.ts", 1)]
    const ranks = new Map([
      ["u.ts", 0.3],
      ["v.ts", 0.2],
      ["w.ts", 0.1],
    ])
    const files = [diff("src/a.ts", { added: [5] }), diff("src/b.ts", { added: [2] })]
    const source = sourceOf({
      "src/a.ts": { text, definitions: [definitions[0]] },
      "src/b.ts": { text, definitions: [definitions[1]] },
    })
    const plain = packSlice({ changed: definitions, references, ranks, text: () => text, context: 200_000 })
    const tiered = tiers({
      files,
      source,
      references,
      ranks,
      text: () => text,
      packing: { tiers: ["c"], shares: { a: 1, b: 0, c: 1 } },
    })
    expect(tiered.changed).toEqual(plain.changed)
    expect(tiered.dependents).toEqual(plain.dependents)
    expect(tiered.locations).toEqual(plain.locations)
    expect([tiered.confirmed, tiered.budget, tiered.definitions]).toEqual([
      plain.confirmed,
      plain.budget,
      plain.definitions,
    ])
    expect(tiered.scopes).toEqual([])
    // tiers.shown gives the same blocks as ranges, so every arm is measured on tiers.shown.
    expect(tiered.tiers.shown.a).toEqual(["src/a.ts:3-3", "src/b.ts:1-1"])
    expect(tiered.tiers.shown.c).toEqual(["u.ts:7-13", "u.ts:14-15", "v.ts:27-33", "w.ts:1-4"])
  })

  test("deterministic: the order of every input leaves the output unchanged; an empty change packs nothing", () => {
    const text = 'import { dep } from "./dep"\n' + numbered(40)
    const definitions = [definition("src/a.ts", "load", 3, 9), definition("src/b.ts", "save", 1, 4)]
    const references = [reference("u.ts", 10), reference("u.ts", 12, { name: "save" }), reference("v.ts", 30)]
    const ranks = new Map([
      ["u.ts", 0.3],
      ["v.ts", 0.3],
    ])
    const files = [diff("src/a.ts", { added: [5] }), diff("src/b.ts", { added: [2] })]
    const source = sourceOf({
      "src/a.ts": { text, definitions: [definitions[0]] },
      "src/b.ts": { text, definitions: [definitions[1]] },
    })
    const uses = [
      {
        path: "src/b.ts",
        line: 2,
        name: "dep",
        specifier: "./dep",
        qualified: false,
        default: false,
        targets: ["src/dep.ts"],
      },
      {
        path: "src/a.ts",
        line: 5,
        name: "dep",
        specifier: "./dep",
        qualified: false,
        default: false,
        targets: ["src/dep.ts"],
      },
    ]
    const outbound = { uses, definitionsOf: () => [definition("src/dep.ts", "dep", 1, 2)] }
    // The builder's unread targets come in the order its concurrent reads finish.
    const unread = ["time:src/z.ts", "error:src/b.ts", "large:src/a.ts", "generated:src/c.ts"]
    const one = tiers({ files, source, references, ranks, text: () => text, outbound, unread })
    const two = tiers({
      files: files.toReversed(),
      changed: changedDefinitions(files, (path, side) => source(path, side)?.definitions).toReversed(),
      source,
      references: references.toReversed(),
      ranks,
      text: () => text,
      outbound: { ...outbound, uses: uses.toReversed() },
      unread: unread.toReversed(),
    })
    expect(JSON.stringify(two)).toBe(JSON.stringify(one))
    expect(one.tiers.dropped.targets).toEqual([
      "error:src/b.ts",
      "generated:src/c.ts",
      "large:src/a.ts",
      "time:src/z.ts",
    ])
    const empty = tiers({ files: [], source: () => undefined, tests: ["t.test.ts"] })
    expect(empty).toMatchObject({ scopes: [], changed: [], outbound: [], dependents: [], fallback: [], tokens: 0 })
    expect(impactBlock({ ...empty, tests: ["t.test.ts"] })).toBe("")
  })

  test("impactPacking keeps known tiers in order, clamps shares and floors top-k; the tables are frozen", () => {
    expect(impactPacking()).toEqual({ tiers: ["a", "b", "c"], shares: { a: 0.4, b: 0.15, c: 0.45 } })
    expect(impactPacking({ tiers: ["c", "x", "a", "c"], shares: { a: 2, b: Number.NaN, c: -1 }, topK: 3.7 })).toEqual({
      tiers: ["a", "c"],
      shares: { a: 1, b: 0, c: 0 },
      topK: 3,
    })
    // A top-k that is set but bad keeps no file rather than every one: only an unset top-k means all of them.
    expect(impactPacking({ topK: -1 }).topK).toBe(0)
    expect(impactPacking({ topK: Number.POSITIVE_INFINITY }).topK).toBe(0)
    expect(impactPacking({ topK: Number.NaN }).topK).toBe(0)
    expect(impactPacking({ topK: 0 }).topK).toBe(0)
    expect("topK" in impactPacking({})).toBe(false)
    for (const table of [IMPACT_TIERS, IMPACT_TIERS.shares, IMPACT_TIER_NAMES, IMPACT_FALLBACK_KINDS, DEFAULT_PACKING])
      expect(Object.isFrozen(table)).toBe(true)
  })
})

describe("BrainCode.importStatements", () => {
  test("gives each statement its lines, its specifier and the line the specifier is on", () => {
    const ts = 'import { a } from "./a"\nimport {\n  b,\n} from "./b"\nconst c = require("./c")\nexport * from "./d"\n'
    expect(BrainCode.importStatements(ts, "typescript")).toEqual([
      { start: 1, end: 1, line: 1, specifier: "./a" },
      { start: 2, end: 4, line: 4, specifier: "./b" },
      { start: 5, end: 5, line: 5, specifier: "./c" },
      { start: 6, end: 6, line: 6, specifier: "./d" },
    ])
    const py = "from pkg import (\n    a,\n    b,\n)\nimport os.path\nfrom . import c\n"
    expect(BrainCode.importStatements(py, "python")).toEqual([
      { start: 1, end: 4, line: 1, specifier: "pkg" },
      { start: 5, end: 5, line: 5, specifier: "os.path" },
      { start: 6, end: 6, line: 6, specifier: "." },
    ])
    const rust = "use crate::a::{\n    B,\n    C,\n};\nmod d;\n"
    expect(BrainCode.importStatements(rust, "rust")).toEqual([
      { start: 1, end: 4, line: 1, specifier: "crate::a::" },
      { start: 5, end: 5, line: 5, specifier: "d" },
    ])
    const go = 'package main\n\nimport (\n\t"fmt"\n\tu "github.com/acme/util"\n)\nimport "os"\n'
    expect(BrainCode.importStatements(go, "go")).toEqual([
      { start: 4, end: 4, line: 4, specifier: "fmt" },
      { start: 5, end: 5, line: 5, specifier: "github.com/acme/util" },
      { start: 7, end: 7, line: 7, specifier: "os" },
    ])
  })
})

describe("BrainCode.importStatements bounds", () => {
  test("a Python list with no ')' near enough ends on its line, so no statement runs on to a far ')'", () => {
    // A megabyte of `from m import (` lines and one ")" at the end: each statement is its own line, not the rest of
    // the file, so tier b's reading of a file the author writes stays linear.
    const text = Array.from({ length: 60_000 }, (_, at) => `from m${at % 50} import (`).join("\n") + "\nx = load()\n)\n"
    expect(text.length).toBeGreaterThan(1_000_000)
    const statements = BrainCode.importStatements(text, "python")
    expect(statements).toHaveLength(BrainCode.LIMIT.imports)
    expect(statements.every((item) => item.end === item.start)).toBe(true)
    // A list that closes past 4,000 characters ends on its line too; one that closes before them is read to its ")".
    const far = "from pkg import (\n" + "    # filler\n".repeat(400) + "    a,\n)\n"
    expect(BrainCode.importStatements(far, "python")).toEqual([{ start: 1, end: 1, line: 1, specifier: "pkg" }])
    const near = "from pkg import (\n" + "    # filler\n".repeat(100) + "    a,\n)\n"
    expect(BrainCode.importStatements(near, "python")).toEqual([{ start: 1, end: 103, line: 1, specifier: "pkg" }])
    const found = outboundUses({
      files: [diff("pkg/a.py", { added: [60_001] })],
      source: () => ({ text, definitions: [], references: [{ name: "load", line: 60_001, column: 4, kind: "call" }] }),
      lookup: BrainCode.lookup(["pkg/a.py", "m1/x.py"]),
    })
    expect(found).toEqual({ uses: [], external: 0 })
  })
})

describe("limits", () => {
  test("are frozen", () => {
    expect(Object.isFrozen(IMPACT_LIMITS)).toBe(true)
    expect(Object.isFrozen(IMPACT_INCOMPLETE)).toBe(true)
    expect(IMPACT_LIMITS).toMatchObject({
      confirm: 200,
      share: 0.15,
      tokens: 6_000,
      window: 3,
      reexportDepth: 2,
      timeBoxMs: 4_000,
    })
  })
})
