import { describe, expect, test } from "bun:test"
import { BrainCode } from "@vectordevai/core/brain/code"
import type { DiffFile, DiffLine } from "@vectordevai/core/review/diff"
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
  type Reference,
} from "@vectordevai/core/review/impact"
import { IMPACT_CAPS, IMPACT_INSTRUCTION, impactBlock } from "@vectordevai/core/review/prompt"
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
