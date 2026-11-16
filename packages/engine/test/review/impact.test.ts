import { $ } from "bun"
import { describe, expect } from "bun:test"
import { constants } from "fs"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Effect } from "effect"
import { BrainCode } from "@vectordevai/core/brain/code"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import type { ImpactSlice } from "@vectordevai/core/review/impact"
import { impactBlock } from "@vectordevai/core/review/prompt"
import { Git } from "../../src/git"
import { ReviewImpact } from "../../src/review/impact"
import { ReviewSource } from "../../src/review/source"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// VS-25b's slice builder over real repositories: it reads the head tree-ish only (a fork review's working tree is the
// merge-base), gates before the cap, never fetches in a partial clone, and records every stage. Tests that are not
// about time pass a generous time box, so a slow runner never turns them into timeouts.

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))
const GENEROUS = 60_000
// The partial clone tests that build a 700-file repository take about 8 s on a Windows runner. When a runner's disk
// slows partway through a shard they take three or four times that (run 42398611869: 22 s for one, past 30 s for
// another), so they get a limit of their own. A hang still fails.
const LARGE_REPOSITORY = 120_000
const posix = process.platform === "win32" ? it.live.skip : it.live

const scopedTmpdir = (options?: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const git = (cwd: string, ...args: string[]) =>
  Effect.promise(() => $`git ${args}`.cwd(cwd).quiet().text()).pipe(Effect.map((text) => text.trim()))

const write = (cwd: string, files: Record<string, string>) =>
  Effect.promise(async () => {
    for (const [file, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true })
      await Bun.write(path.join(cwd, file), text)
    }
  })

const commit = (cwd: string, message: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    yield* write(cwd, files)
    yield* git(cwd, "add", "-A")
    yield* git(cwd, "commit", "-q", "-m", message)
    return yield* git(cwd, "rev-parse", "HEAD")
  })

const build = (input: Omit<ReviewImpact.BuildInput, "context"> & { context?: number }) =>
  ReviewImpact.build({ context: 200_000, budgetMs: GENEROUS, ...input })

// The stage arithmetic every slice keeps, whatever stopped it.
function invariants(slice: ImpactSlice) {
  expect(slice.stages.candidates).toBe(
    slice.dropped.ignored.length + slice.dropped.unchecked.length + slice.dropped.gate.length + slice.stages.gated,
  )
  expect(slice.stages.gated).toBeGreaterThanOrEqual(slice.dropped.cap.length + slice.dropped.time.length)
  // A slice packed in tiers (VS-37a) also leaves the call sites past top-k out.
  expect(slice.stages.confirmed).toBe(
    slice.stages.packed + slice.dropped.budget.length + (slice.tiers?.dropped.rank.length ?? 0),
  )
  expect(slice.stages.packed).toBe(slice.dependents.length)
  for (const dependent of slice.dependents) expect(slice.locations).toContain(`${dependent.path}:${dependent.line}`)
  // The tokens are what the block costs as the prompt renders it, with its note: 0 when it renders nothing.
  expect(slice.tokens).toBe(Math.ceil(impactBlock(slice).length / 3.5))
  // Impact incompleteness is context, never coverage (VS-38 item 7).
  for (const key of ["complete", "coverage", "unreviewed", "reviewed"]) expect(Object.hasOwn(slice, key)).toBe(false)
}

// The real Git service, with every command it runs recorded: what a build read, never what it would have read.
const recorded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const service = yield* Git.Service
    const calls: string[][] = []
    const result = yield* effect.pipe(
      Effect.provideService(Git.Service, {
        ...service,
        run: (args, options) => {
          calls.push(args)
          return service.run(args, options)
        },
      }),
    )
    return { result, shown: calls.filter((args) => args[0] === "show").map((args) => args.at(-1) ?? "") }
  })

const UTIL_BASE =
  "export function computeTotal(items: number[]) {\n  return items.length\n}\nexport const placeholder = 1\n"
const UTIL_HEAD =
  "export function computeTotal(items: number[]) {\n  const count = items.length\n  return count\n}\nexport const placeholder = 1\n"

// A change to computeTotal with two importers, a test, a file that only shares the name, and an ignored bundle.
const fixture = (dir: string) =>
  Effect.gen(function* () {
    const base = yield* commit(dir, "base", {
      "src/util.ts": UTIL_BASE,
      "src/a.ts": 'import { computeTotal } from "./util"\n\nexport function a() {\n  return computeTotal([1])\n}\n',
      "src/collide.ts": "export function computeTotal() {\n  return 0\n}\nexport const z = computeTotal()\n",
      "src/util.test.ts": 'import { computeTotal } from "./util"\ntest("x", () => computeTotal([]))\n',
      "dist/bundle.js": 'import { computeTotal } from "../src/util"\ncomputeTotal([3])\n',
      "src/b.ts": 'import { computeTotal } from "./util"\nexport const b = computeTotal([2])\n',
    })
    const head = yield* commit(dir, "head", { "src/util.ts": UTIL_HEAD })
    const files = yield* ReviewSource.prDiff({ directory: dir, mergeBase: base, head })
    return { base, head, files }
  })

describe("ReviewImpact.build", () => {
  it.live("reads the head tree-ish, gates by import, and records every stage", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* fixture(dir)
      // A fork review's working tree is the merge-base: what sits only there is never read.
      yield* git(dir, "checkout", "-q", base)
      yield* write(dir, {
        "src/decoy.ts": 'import { computeTotal } from "./util"\ncomputeTotal([9])\n',
        "src/a.ts": "export const gone = 1\n",
      })

      const { slice, changed } = yield* build({
        directory: dir,
        base,
        head,
        files,
        ignore: ["**/dist/**"],
        ignored: (file) => file.startsWith("dist/"),
      })

      expect(slice.changed.map((item) => `${item.side}:${item.path}:${item.name}:${item.start}-${item.end}`)).toEqual([
        "RIGHT:src/util.ts:computeTotal:1-4",
      ])
      expect(slice.dependents.map((item) => `${item.path}:${item.line}:${item.name}`)).toEqual([
        "src/a.ts:4:computeTotal",
        "src/b.ts:2:computeTotal",
        "src/util.test.ts:2:computeTotal",
      ])
      expect(slice.dependents[0]).toMatchObject({ enclosing: "a", importsChanged: true })
      expect(slice.dependents[0]?.window).toBe(
        '1: import { computeTotal } from "./util"\n2: \n3: export function a() {\n4:   return computeTotal([1])\n5: }',
      )
      expect(slice.locations).toEqual(["src/util.ts:1", "src/a.ts:4", "src/b.ts:2", "src/util.test.ts:2"])
      expect(slice.tests).toEqual(["src/util.test.ts"])
      expect(slice.stages).toEqual({ candidates: 4, gated: 3, confirmed: 3, packed: 3 })
      expect(slice.dropped).toEqual({
        ignored: [],
        unchecked: [],
        gate: ["src/collide.ts"],
        cap: [],
        time: [],
        budget: [],
        definitions: [],
      })
      expect(slice).toMatchObject({ plan: "tree-ish", clone: { partial: false, sparse: false }, unsupported: [] })
      expect(slice.gitVersion).toMatch(/^\d+\.\d+/)
      expect(slice.incomplete).toBeUndefined()
      expect(slice.unsearched).toBeUndefined()
      expect(slice.tokens).toBeGreaterThan(0)
      invariants(slice)
      expect(impactBlock(slice)).not.toContain("untrusted_impact_note")
      // The changed files' ranges, keyed as TrivialInput's callbacks take them.
      expect(changed.definitions("src/util.ts", "LEFT")?.map((item) => item.name)).toEqual([
        "computeTotal",
        "placeholder",
      ])
      expect(changed.text("src/util.ts", "RIGHT")).toBe(UTIL_HEAD)
      expect(changed.comments("src/util.ts", "RIGHT")).toEqual([])
      expect(changed.strings("src/util.ts", "LEFT")).toEqual([])
      expect(changed.definitions("src/a.ts", "RIGHT")).toBeUndefined()
    }),
  )

  it.live(
    "finds the same files from a subdirectory, and with colour and column settings that change git's output",
    () =>
      Effect.gen(function* () {
        const dir = (yield* scopedTmpdir({ git: true })).path
        const { base, head, files } = yield* fixture(dir)
        const plain = yield* build({ directory: dir, base, head, files })
        const sub = yield* build({ directory: path.join(dir, "src"), base, head, files })
        for (const [key, value] of [
          ["color.ui", "always"],
          ["color.grep", "always"],
          ["grep.column", "true"],
          ["grep.lineNumber", "true"],
          ["grep.fullName", "false"],
        ])
          yield* git(dir, "config", key, value)
        const coloured = yield* build({ directory: dir, base, head, files })
        const keep = (built: { slice: ImpactSlice }) => ({
          dependents: built.slice.dependents,
          dropped: built.slice.dropped,
          stages: built.slice.stages,
        })
        // Nothing is ignored here, so the bundle is a dependent too.
        expect(keep(plain).stages).toEqual({ candidates: 5, gated: 4, confirmed: 4, packed: 4 })
        expect(keep(sub)).toEqual(keep(plain))
        expect(keep(coloured)).toEqual(keep(plain))
        expect(coloured.slice.incomplete).toBeUndefined()
      }),
  )

  it.live("one grep of every name finds the files the per-name greps find", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const base = yield* commit(dir, "base", {
        "src/names.ts": "export const keep = 1\n",
        "x/one.ts": "alphaName()\n",
        "x/two.ts": "const v = new BetaName()\n",
        "x/three.ts": "let g: GammaName\n",
        "x/both.ts": "alphaName(); BetaName\n",
        "x/dollar.ts": "$alphaName\n",
        "x/under.ts": "alphaName_x\n",
        "x/longer.ts": "alphaNames\n",
        "x/none.ts": "nothing\n",
      })
      const head = yield* commit(dir, "head", {
        "src/names.ts":
          "export const keep = 1\nexport function alphaName() {}\nexport class BetaName {}\nexport type GammaName = 1\n",
      })
      const files = yield* ReviewSource.prDiff({ directory: dir, mergeBase: base, head })
      const { slice } = yield* build({ directory: dir, base, head, files })
      const each = yield* Effect.forEach(["alphaName", "BetaName", "GammaName"], (name) =>
        Effect.promise(() => $`git grep -l -w -F -e ${name} ${head} -- .`.cwd(dir).quiet().nothrow().text()),
      )
      const expected = [
        ...new Set(
          each.flatMap((text) =>
            text
              .split("\n")
              .filter(Boolean)
              .map((line) => line.slice(head.length + 1)),
          ),
        ),
      ]
        .filter((file) => file !== "src/names.ts")
        .toSorted()
      expect(expected).toEqual(["x/both.ts", "x/dollar.ts", "x/one.ts", "x/three.ts", "x/two.ts"])
      // None imports the change, so every candidate is in dropped.gate.
      expect(slice.dropped.gate).toEqual(expected)
      expect(slice.stages.candidates).toBe(expected.length)
    }),
  )

  it.live("a pure rename finds the importers that still name the old path", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const base = yield* commit(dir, "base", {
        "src/old.ts": "export function loadThing() {\n  return 1\n}\n",
        "src/use.ts": 'import { loadThing } from "./old"\n\nloadThing()\n',
      })
      yield* git(dir, "mv", "src/old.ts", "src/new.ts")
      yield* git(dir, "commit", "-q", "-m", "rename")
      const head = yield* git(dir, "rev-parse", "HEAD")
      const files = yield* ReviewSource.prDiff({ directory: dir, mergeBase: base, head })
      expect(files.map((file) => [file.status, file.oldPath, file.path])).toEqual([
        ["renamed", "src/old.ts", "src/new.ts"],
      ])
      const { slice } = yield* build({ directory: dir, base, head, files })
      expect(slice.changed).toEqual([])
      expect(slice.dependents.map((item) => `${item.path}:${item.line}`)).toEqual(["src/use.ts:3"])
      invariants(slice)
    }),
  )

  it.live("Go: an importer of the package, a same-package test, a generated file set aside; Ruby by word", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const base = yield* commit(dir, "base", {
        "go.mod": "module example.com/app\n",
        "pkg/store/store.go": "package store\n\nfunc SaveOrder() error {\n\treturn nil\n}\n",
        "pkg/store/zz_generated.deepcopy.go":
          "// Code generated by deepcopy-gen. DO NOT EDIT.\n\npackage store\n\nfunc copy() { SaveOrder() }\n",
        "pkg/store/store_test.go": "package store\n\nfunc TestSave() { SaveOrder() }\n",
        "cmd/main.go":
          'package main\n\nimport (\n\t"example.com/app/pkg/store"\n)\n\nfunc main() { store.SaveOrder() }\n',
        "other/main.go": "package other\n\nfunc SaveOrder() {}\n",
        "lib/parser.rb": "class DocumentParser\nend\n",
        "lib/runner.rb": 'require_relative "parser"\n\nparse_line("x")\n',
      })
      const head = yield* commit(dir, "head", {
        "pkg/store/store.go": "package store\n\nfunc SaveOrder() error {\n\tvalidate()\n\treturn nil\n}\n",
        "lib/parser.rb": "class DocumentParser\nend\n\ndef parse_line(line)\n  line.strip\nend\n",
      })
      const files = yield* ReviewSource.prDiff({ directory: dir, mergeBase: base, head })
      const { slice } = yield* build({ directory: dir, base, head, files })
      expect(slice.dependents.map((item) => `${item.path}:${item.line}:${item.importsChanged}`).toSorted()).toEqual([
        "cmd/main.go:7:true",
        "lib/runner.rb:3:true",
        "pkg/store/store_test.go:3:false",
      ])
      expect(slice.dropped.ignored).toEqual(["pkg/store/zz_generated.deepcopy.go"])
      expect(slice.dropped.gate).toEqual(["other/main.go"])
      expect(slice.tests).toEqual(["pkg/store/store_test.go"])
      // Ruby has no grammar: its names come from BrainCode.symbols and its call sites from a whole-word match.
      expect(slice.unsupported).toEqual(["lib/parser.rb", "lib/runner.rb"])
      invariants(slice)
    }),
  )

  it.live("a git error makes the slice incomplete instead of empty-looking", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* fixture(dir)
      const blob = yield* git(dir, "rev-parse", `${head}:src/b.ts`)
      const object = path.join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2))
      yield* Effect.promise(async () => {
        await fs.chmod(object, 0o644)
        await fs.writeFile(object, "not a zlib stream")
      })
      const { slice } = yield* build({ directory: dir, base, head, files })
      expect(slice.incomplete).toContain("error")
      invariants(slice)
      const refused = yield* build({ directory: dir, base: "--output=x", head, files })
      expect(refused.slice).toMatchObject({ incomplete: ["error"], dependents: [], stages: { candidates: 0 } })
    }),
  )

  it.live("a change that touches no definition gives an empty slice, which costs nothing", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const base = yield* commit(dir, "base", { "README.md": "# x\n", "src/a.ts": "export const a = 1\n" })
      const head = yield* commit(dir, "head", { "README.md": "# y\n" })
      const files = yield* ReviewSource.prDiff({ directory: dir, mergeBase: base, head })
      const { slice } = yield* build({ directory: dir, base, head, files })
      expect(slice).toMatchObject({ changed: [], dependents: [], tokens: 0, stages: { candidates: 0 } })
      expect(slice.incomplete).toBeUndefined()
      expect(impactBlock(slice)).toBe("")
      invariants(slice)
    }),
  )

  it.live("a file's call sites are of the names its changed modules give, not of every changed name", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const base = yield* commit(dir, "base", {
        "src/a.ts": "export function alphaThing() {\n  return 1\n}\n",
        "src/b.ts": "export function betaThing() {\n  return 2\n}\n",
        "src/use.ts": [
          'import { alphaThing } from "./a"',
          "",
          "const betaThing = 3",
          "",
          "",
          "",
          "",
          "",
          "export const total = betaThing + 1",
          "",
          "",
          "",
          "",
          "",
          "export const sum = alphaThing()",
          "",
        ].join("\n"),
      })
      const head = yield* commit(dir, "head", {
        "src/a.ts": "export function alphaThing() {\n  return 10\n}\n",
        "src/b.ts": "export function betaThing() {\n  return 20\n}\n",
      })
      const files = yield* ReviewSource.prDiff({ directory: dir, mergeBase: base, head })
      const { slice } = yield* build({ directory: dir, base, head, files })
      expect(slice.changed.map((item) => item.name)).toEqual(["alphaThing", "betaThing"])
      // use.ts mentions betaThing, its own local, but imports only a.ts.
      expect(slice.dependents.map((item) => `${item.path}:${item.line}:${item.name}`)).toEqual([
        "src/use.ts:15:alphaThing",
      ])
      invariants(slice)
    }),
  )

  it.live("C: a caller including the changed source's header is confirmed by word, without its include line", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const base = yield* commit(dir, "base", {
        "src/compute.h": "int compute(int x);\n",
        "src/compute.c": '#include "compute.h"\n\nint helper(int x) {\n  return x;\n}\n',
        "src/main.c": '#include "compute.h"\n\n\n\n\n\n\n\nint main(void) {\n  return compute(1);\n}\n',
        "src/other.c": '#include "other.h"\n\nint compute_other(void) { return 0; }\nint x = compute;\n',
        "src/other.h": "int compute_other(void);\n",
      })
      const head = yield* commit(dir, "head", {
        "src/compute.c":
          '#include "compute.h"\n\nint helper(int x) {\n  return x;\n}\n\nint compute(int x) {\n  return helper(x) + 1;\n}\n',
      })
      const files = yield* ReviewSource.prDiff({ directory: dir, mergeBase: base, head })
      const { slice } = yield* build({ directory: dir, base, head, files })
      // The include on line 1 names `compute` as a word too; only the call is a call site.
      expect(slice.dependents.map((item) => `${item.path}:${item.line}:${item.importsChanged}`)).toEqual([
        "src/main.c:10:true",
      ])
      expect(slice.dropped.gate).toEqual(["src/compute.h", "src/other.c"])
      expect(slice.unsupported).toEqual(["src/compute.c", "src/main.c"])
      invariants(slice)
    }),
  )

  it.live("the time box stops at any step and keeps the stages consistent", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* fixture(dir)
      const many = Object.fromEntries(
        Array.from({ length: 300 }, (_, at) => [
          `deep/${"segment/".repeat(8)}user${String(at).padStart(3, "0")}.ts`,
          `import { computeTotal } from "${"../".repeat(9)}src/util"\ncomputeTotal([${at}])\n`,
        ]),
      )
      const later = yield* commit(dir, "users", many)
      for (const budgetMs of [0, 1, 20, 150]) {
        const { slice } = yield* ReviewImpact.build({
          directory: dir,
          base,
          head: later,
          files,
          context: 200_000,
          budgetMs,
        })
        invariants(slice)
        if (budgetMs === 0)
          expect(slice).toMatchObject({ incomplete: ["time"], gitVersion: "", stages: { candidates: 0 } })
      }
      const { slice } = yield* build({ directory: dir, base, head: later, files })
      // 300 users, a.ts, b.ts, the test and the bundle, which nothing ignores here.
      expect(slice.stages.gated).toBe(304)
      expect(slice.dropped.cap).toHaveLength(104)
      expect(slice.incomplete).toBeUndefined()
      invariants(slice)
      expect(head).not.toBe(later)
    }),
  )

  posix("an expired time box kills the git process it was waiting for", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* fixture(dir)
      const fifo = path.join(dir, ".git", "blocking-config")
      yield* Effect.promise(() => $`mkfifo ${fifo}`.quiet())
      const config = path.join(dir, ".git", "config")
      const original = yield* Effect.promise(() => fs.readFile(config, "utf8"))
      // Reading the config opens the FIFO, which blocks until a writer opens it: no writer ever does.
      yield* Effect.promise(() => fs.writeFile(config, `${original}[include]\n\tpath = ${fifo}\n`))
      const started = performance.now()
      const { slice } = yield* ReviewImpact.build({
        directory: dir,
        base,
        head,
        files,
        context: 200_000,
        budgetMs: 1_500,
      }).pipe(Effect.ensuring(Effect.promise(() => fs.writeFile(config, original))))
      const elapsed = performance.now() - started
      expect(slice.incomplete).toContain("time")
      expect(elapsed).toBeGreaterThanOrEqual(1_400)
      expect(elapsed).toBeLessThan(15_000)
      yield* Effect.sleep(300)
      // With no git left reading it, opening the FIFO to write without blocking fails with ENXIO.
      const open = yield* Effect.promise(() =>
        fs.open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).then(
          async (handle) => {
            await handle.close()
            return "open"
          },
          (error: NodeJS.ErrnoException) => error.code ?? "error",
        ),
      )
      expect(open).toBe("ENXIO")
    }),
  )
})

// VS-37a: the slice packed in tiers, only when the eval-only `packing` is passed.
describe("ReviewImpact.build in tiers", () => {
  const body = (count: number) => Array.from({ length: count }, (_, at) => `  const step${at} = ${at}`).join("\n")
  const TIERED_BASE = [
    'import { scale } from "./math"',
    'import { other } from "./other"',
    "",
    "export function computeTotal(items: number[]) {",
    body(4),
    "  return items.length",
    body(4),
    "}",
    "",
  ].join("\n")
  const TIERED_HEAD = [
    'import { scale } from "./math"',
    'import { other } from "./other"',
    "",
    "export function computeTotal(items: number[]) {",
    body(4),
    "  return scale(items.length)",
    body(4),
    "}",
    "",
  ].join("\n")
  const tieredFixture = (dir: string, extra: Record<string, string> = {}, head: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const base = yield* commit(dir, "base", {
        "src/util.ts": TIERED_BASE,
        "src/math.ts": "export function scale(value: number): number {\n  return value * 2\n}\n",
        "src/other.ts": "export const other = 1\n",
        "src/a.ts":
          'import { computeTotal } from "./util"\n\nexport function a() {\n  const total = computeTotal(\n    [1],\n  )\n  return total\n}\n',
        ...extra,
      })
      const next = yield* commit(dir, "head", { "src/util.ts": TIERED_HEAD, ...head })
      const files = yield* ReviewSource.prDiff({ directory: dir, mergeBase: base, head: next })
      return { base, head: next, files }
    })

  it.live("packing unset builds VS-25b's slice: no tier fields, no statements, no file read beyond VS-25b's", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* tieredFixture(dir)
      const plain = yield* recorded(build({ directory: dir, base, head, files }))
      const slice = plain.result.slice
      for (const key of ["scopes", "outbound", "fallback", "tiers"]) expect(Object.hasOwn(slice, key)).toBe(false)
      expect(slice.dependents.some((item) => "statement" in item)).toBe(false)
      expect(slice.dependents.map((item) => item.window)).toEqual([
        '1: import { computeTotal } from "./util"\n2: \n3: export function a() {\n4:   const total = computeTotal(\n5:     [1],\n6:   )\n7:   return total',
      ])
      // The changed file at each side and the confirmed dependent: tier b's target is never read.
      expect(plain.shown.toSorted()).toEqual(
        [`${base}:src/util.ts`, `${head}:src/a.ts`, `${head}:src/util.ts`].toSorted(),
      )
      expect(impactBlock(slice)).not.toContain("untrusted_enclosing_scope")
      invariants(slice)
      // The same build twice is the same slice, timings aside.
      const again = (yield* build({ directory: dir, base, head, files })).slice
      const steady = (item: ImpactSlice) => ({ ...item, ms: 0, grepMs: 0, parseMs: 0 })
      expect(steady(again)).toEqual(steady(slice))
    }),
  )

  it.live("packs the changed definition whole, the signature it calls, and the call site's statement", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* tieredFixture(dir)
      const tiered = yield* recorded(build({ directory: dir, base, head, files, packing: {} }))
      const slice = tiered.result.slice
      expect(slice.scopes?.map((scope) => `${scope.path}:${scope.name}:${scope.start}-${scope.end}`)).toEqual([
        "src/util.ts:computeTotal:4-14",
      ])
      expect(slice.scopes?.[0]?.excerpt.split("\n").slice(0, 4)).toEqual([
        '1: import { scale } from "./math"',
        "⋯",
        "4: export function computeTotal(items: number[]) {",
        "5:   const step0 = 0",
      ])
      expect(slice.outbound).toEqual([
        {
          path: "src/math.ts",
          name: "scale",
          kind: "function",
          start: 1,
          end: 3,
          signature: expect.stringContaining("scale(value: number): number"),
          usedIn: "src/util.ts:9",
        },
      ])
      expect(slice.dependents.map((item) => [item.line, item.statement, item.window])).toEqual([
        [4, { start: 4, end: 6 }, "4:   const total = computeTotal(\n5:     [1],\n6:   )"],
      ])
      expect(slice.changed).toEqual([])
      expect(slice.fallback).toEqual([])
      expect(slice.tiers).toMatchObject({
        packing: { tiers: ["a", "b", "c"], shares: { a: 0.4, b: 0.15, c: 0.45 } },
        view: { inline: [], diffHidden: [] },
        shown: { a: ["src/util.ts:1-1", "src/util.ts:4-14"], b: ["src/math.ts:1-1"], c: ["src/a.ts:4-6"] },
        external: 0,
      })
      expect(slice.locations).toEqual(["src/util.ts:4", "src/math.ts:1", "src/a.ts:4"])
      // The target was read once, from the head tree-ish; `other` is imported but unused, so its file is not.
      expect(tiered.shown).toContain(`${head}:src/math.ts`)
      expect(tiered.shown).not.toContain(`${head}:src/other.ts`)
      expect(impactBlock(slice)).toContain("<untrusted_outbound_signature ")
      invariants(slice)
    }),
  )

  it.live("an ignored, excluded or generated target is never shown, and the first two are never read", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const head = [
        'import { scale } from "./math"',
        'import { skip } from "./skip"',
        'import { gen } from "./gen"',
        'import { vend } from "../vendor/vend"',
        "",
        "export function computeTotal(items: number[]) {",
        body(4),
        "  return skip(gen(vend(items.length)))",
        body(4),
        "}",
        "",
      ].join("\n")
      const {
        base,
        head: next,
        files,
      } = yield* tieredFixture(
        dir,
        {
          "src/skip.ts": "export function skip(value: number) {\n  return value\n}\n",
          "src/gen.ts": "// @generated by a tool\nexport function gen(value: number) {\n  return value\n}\n",
          "vendor/vend.ts": "export function vend(value: number) {\n  return value\n}\n",
        },
        { "src/util.ts": head },
      )
      const tiered = yield* recorded(
        build({ directory: dir, base, head: next, files, packing: {}, ignore: ["**/skip.ts"] }),
      )
      const slice = tiered.result.slice
      expect(slice.outbound).toEqual([])
      // In sorted order, whichever read finished first.
      expect(slice.tiers?.dropped.targets).toEqual([
        "excluded:vendor/vend.ts",
        "generated:src/gen.ts",
        "ignored:src/skip.ts",
      ])
      expect(tiered.shown).not.toContain(`${next}:src/skip.ts`)
      expect(tiered.shown).not.toContain(`${next}:vendor/vend.ts`)
      // None of these is a fallback the model is told about.
      expect(slice.fallback).toEqual([])
      // An `ignored` callback sets a target aside as the ignore globs do.
      const called = yield* build({
        directory: dir,
        base,
        head: next,
        files,
        packing: {},
        ignored: (file) => file === "src/skip.ts",
      })
      expect(called.slice.tiers?.dropped.targets).toContain("ignored:src/skip.ts")
      invariants(slice)
    }),
  )

  it.live("a changed target the ignore rules cover is set aside before its changed parse is used", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      // `scale` is unchanged and outside the diff's context, so only the ignore rules keep it out of tier b.
      const math = (value: number) =>
        [
          "export function scale(value: number): number {",
          "  return value * 2",
          "}",
          ...Array.from({ length: 10 }, (_, at) => `// filler ${at}`),
          "export function other2() {",
          `  return ${value}`,
          "}",
          "",
        ].join("\n")
      const { base, head, files } = yield* tieredFixture(dir, { "src/math.ts": math(1) }, { "src/math.ts": math(2) })
      const open = yield* build({ directory: dir, base, head, files, packing: {} })
      expect(open.slice.outbound?.map((item) => `${item.path}:${item.name}`)).toEqual(["src/math.ts:scale"])
      const { slice } = yield* build({ directory: dir, base, head, files, packing: {}, ignore: ["src/math.ts"] })
      expect(slice.outbound).toEqual([])
      expect(slice.tiers?.dropped.targets).toEqual(["ignored:src/math.ts"])
      invariants(slice)
    }),
  )

  it.live("changed files the parser cannot read are named in the fallback note", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const large = "export const filler = 1\n".repeat(50_000)
      const { base, head, files } = yield* tieredFixture(
        dir,
        { "lib/tool.rb": "def tool\n  1\nend\n", "src/big.ts": large },
        { "lib/tool.rb": "def tool\n  2\nend\n", "src/big.ts": `${large}export const more = 2\n` },
      )
      const { slice, changed } = yield* build({ directory: dir, base, head, files, packing: {} })
      expect(changed.large).toEqual(["base:src/big.ts", "src/big.ts"])
      expect(slice.fallback).toEqual([
        { kind: "a:unsupported", count: 1 },
        { kind: "a:over-cap", count: 1 },
      ])
      expect(impactBlock(slice)).toContain(
        "Context fell back (1 changed file in a language Vector does not parse: no enclosing scope; 1 changed file or definition over the size limit: no enclosing scope). Open the files yourself.",
      )
      invariants(slice)
    }),
  )

  it.live("tier b reads start after confirmation, so a time box never drops more call sites with tiers on", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* tieredFixture(dir)
      for (const budgetMs of [0, 1, 20, 150]) {
        const { slice } = yield* ReviewImpact.build({
          directory: dir,
          base,
          head,
          files,
          context: 200_000,
          budgetMs,
          packing: {},
        })
        invariants(slice)
        // Every tiered slice reads as tiered, even one that stopped before packing.
        expect(slice.scopes).toBeDefined()
        expect(slice.tiers?.packing.tiers).toEqual(["a", "b", "c"])
        // A call site left unread by the box means the box ran out before any target was read.
        if (slice.dropped.time.length) {
          expect(slice.outbound).toEqual([])
          expect(slice.tiers?.dropped.targets.every((entry) => entry.startsWith("time:"))).toBe(true)
        }
        if (budgetMs === 0) expect(slice).toMatchObject({ incomplete: ["time"], stages: { candidates: 0 } })
      }
      // Target reads never mark the slice incomplete: with a generous box the tiered slice is complete.
      const { slice } = yield* build({ directory: dir, base, head, files, packing: {} })
      expect(slice.incomplete).toBeUndefined()
    }),
  )
})

describe("ReviewImpact.importLines", () => {
  it.live("rebuilds every line BrainCode.imports reads, wrapped imports and Python lists included", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const sources: Record<string, string> = {
        "a.ts": [
          'import {\n  x,\n  y,\n} from "./lib/xy"',
          'const m = await import(\n  "./lib/m"\n)',
          "const r = require(\n  './lib/r'\n)",
          'export * from "./lib/all"',
          'import "./lib/side"',
          "const value = compute()",
        ].join("\n"),
        "b.go": 'package b\n\nimport (\n\t"fmt"\n\tstore "example.com/app/store"\n\t_ "embed"\n)\n\nfunc f() {}\n',
        "single.go": 'package b\n\nimport "example.com/app/one"\n',
        "c.py": "from pkg import (\n    one,\n    two as t,\n)\nimport os.path\nfrom . import three\nvalue = 1\n",
        "d.rs": "mod parser;\nuse crate::{\n    a::b,\n};\nfn main() {}\n",
        "e.vue": '<template><img src="./logo.png"></template>\n<script src="./x.js"></script>\n',
        "f.java": "import static com.x.Y.z;\nimport com.x.W;\nclass F {}\n",
        "g.rb": 'require_relative "parser"\nrequire "json"\n',
        "h.php": "<?php\nuse App\\Domain\\X;\nrequire_once 'y.php';\n",
        "i.c": '#include "util.h"\n#include <stdio.h>\nint main() {}\n',
        "j.css": '@import url("x.css");\n.a {}\n',
        "gen.ts": "/* header */\n// @generated by tool\nexport const g = 1\n",
      }
      const head = yield* commit(dir, "sources", sources)
      const lines = yield* ReviewImpact.importLines({
        directory: dir,
        head,
        paths: [...Object.keys(sources), "absent.ts"],
      })
      for (const [file, text] of Object.entries(sources)) {
        const language = BrainCode.language(file)!
        const rebuilt = lines.get(file)
        expect(rebuilt).toBeDefined()
        expect(BrainCode.imports(rebuilt!, language).toSorted()).toEqual(BrainCode.imports(text, language).toSorted())
        // Lines keep their numbers.
        rebuilt!.split("\n").forEach((line, at) => line && expect(text.split("\n")[at]).toBe(line))
      }
      expect(lines.get("c.py")).toContain("    one,\n    two as t,\n)")
      expect(lines.get("gen.ts")?.split("\n")[1]).toBe("// @generated by tool")
      expect(lines.get("a.ts")).not.toContain("compute()")
      // A path the tree-ish does not have is read as having no import lines.
      expect(lines.get("absent.ts")).toBe("")
    }),
  )
})

describe("partial clones", () => {
  const source = (dir: string) =>
    Effect.gen(function* () {
      yield* git(dir, "config", "uploadpack.allowfilter", "true")
      yield* git(dir, "config", "uploadpack.allowanysha1inwant", "true")
      const big = Object.fromEntries(
        ["big1", "big2"].flatMap((top) =>
          Array.from({ length: 350 }, (_, at) => [
            `${top}/some/deeper/folder/for/files/file-number-${String(at).padStart(3, "0")}.ts`,
            `export const ${top}v${at} = ${at}\n`,
          ]),
        ),
      )
      const base = yield* commit(dir, "base", {
        ...big,
        "package.json": JSON.stringify({ name: "root" }),
        "src/util.ts": UTIL_BASE,
        "src/a.ts": 'import { computeTotal } from "./util"\ncomputeTotal([1])\n',
      })
      const head = yield* commit(dir, "head", { "src/util.ts": UTIL_HEAD })
      return { base, head }
    })
  const missing = (dir: string, rev: string, ...extra: string[]) =>
    git(dir, "rev-list", "--objects", "--no-walk", "--missing=print", ...extra, rev).pipe(
      Effect.map((text) => text.split("\n").filter((line) => line.startsWith("?")).length),
    )
  const clone = (from: string, to: string, ...args: string[]) =>
    Effect.promise(() => $`git clone -q --no-local ${args} ${pathToFileURL(from).href} ${to}`.quiet())

  it.live(
    "a blobless sparse clone searches what it has, excludes the cone's missing folders, and fetches nothing",
    () =>
      Effect.gen(function* () {
        const root = (yield* scopedTmpdir({ git: true })).path
        const { base, head } = yield* source(root)
        const dir = path.join(root, "..", `${path.basename(root)}-sparse`)
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })))
        yield* clone(root, dir, "--filter=blob:none", "--sparse")
        yield* git(dir, "sparse-checkout", "set", "src")
        const files = yield* ReviewSource.prDiff({ directory: root, mergeBase: base, head })
        const before = yield* missing(dir, head)
        const missingBase = yield* missing(dir, base)
        expect(before).toBe(700)
        // The clone checked out the head, so the base's version of the changed file is the one more blob it lacks.
        expect(missingBase).toBe(701)
        // One exclude per missing file would not fit a command line; one per missing folder does.
        const one = ":(top,exclude,literal)big1/some/deeper/folder/for/files/file-number-000.ts".length + 1
        expect(700 * one).toBeGreaterThan(ReviewImpact.ARG_CHARS)
        const { slice, changed } = yield* build({ directory: dir, base, head, files })
        expect(slice.clone).toEqual({ partial: true, sparse: true })
        expect(slice.incomplete).toEqual(["partial-clone"])
        expect(slice.unsearched).toBe(700)
        expect(slice.dependents.map((item) => `${item.path}:${item.line}`)).toEqual(["src/a.ts:2"])
        expect(impactBlock(slice)).toContain("700 files not searched, missing from a partial clone")
        invariants(slice)
        expect(yield* missing(dir, head)).toBe(before)
        expect(yield* missing(dir, base)).toBe(missingBase)
        // The base side of the change was never fetched, so it was not read.
        expect(changed.missing).toEqual(["base:src/util.ts"])
      }),
    LARGE_REPOSITORY,
  )

  it.live(
    "a blobless clone with nothing checked out reads nothing it lacks; lazy fetching stays off",
    () =>
      Effect.gen(function* () {
        const root = (yield* scopedTmpdir({ git: true })).path
        const { base, head } = yield* source(root)
        const dir = path.join(root, "..", `${path.basename(root)}-blobless`)
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })))
        yield* clone(root, dir, "--filter=blob:none", "--no-checkout")
        const files = yield* ReviewSource.prDiff({ directory: root, mergeBase: base, head })
        const before = yield* missing(dir, head)
        const { slice, changed } = yield* build({ directory: dir, base, head, files })
        expect(slice.incomplete).toEqual(["partial-clone"])
        expect(slice.unsearched).toBe(before)
        expect(slice.stages.candidates).toBe(0)
        expect(changed.missing).toEqual(["base:src/util.ts", "src/util.ts"])
        expect(yield* missing(dir, head)).toBe(before)
        // parseChanged and importLines list what the clone lacks first, and never read it.
        const parsed = yield* ReviewImpact.parseChanged({ directory: dir, base, head, files })
        expect(parsed.missing).toEqual(["base:src/util.ts", "src/util.ts"])
        expect((yield* ReviewImpact.importLines({ directory: dir, head, paths: ["src/a.ts"] })).has("src/a.ts")).toBe(
          false,
        )
        expect(yield* missing(dir, head)).toBe(before)
        // The backstop: told nothing is missing and asked to read a missing blob, git refuses rather than fetch it.
        const direct = yield* ReviewImpact.parseChanged({ directory: dir, base, head, files, missing: () => false })
        expect(direct.text("src/util.ts", "RIGHT")).toBeUndefined()
        expect(direct.missing).toEqual([])
        expect(yield* missing(dir, head)).toBe(before)
      }),
    LARGE_REPOSITORY,
  )

  it.live("files with the same content are each searched: presence is by object, not by the path git lists first", () =>
    Effect.gen(function* () {
      const root = (yield* scopedTmpdir({ git: true })).path
      yield* git(root, "config", "uploadpack.allowfilter", "true")
      yield* git(root, "config", "uploadpack.allowanysha1inwant", "true")
      const user = 'import { computeTotal } from "../src/util"\ncomputeTotal([1])\n'
      const base = yield* commit(root, "base", {
        "src/util.ts": UTIL_BASE,
        "a/x.ts": user,
        "b/y.ts": user,
        "a/__init__.py": "",
        "b/__init__.py": "",
        "b/z.py": "from . import thing\n",
      })
      const head = yield* commit(root, "head", { "src/util.ts": UTIL_HEAD })
      const dir = path.join(root, "..", `${path.basename(root)}-duplicates`)
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })))
      yield* clone(root, dir, "--filter=blob:none")
      // Checking out the base and then the head fetches every blob either side holds.
      yield* git(dir, "checkout", "-q", base)
      yield* git(dir, "checkout", "-q", head)
      expect(yield* missing(dir, head)).toBe(0)
      expect(yield* missing(dir, base)).toBe(0)
      // rev-list lists each object once: the second path of a shared blob is never printed.
      const listed = yield* git(dir, "rev-list", "--objects", "--no-walk", head)
      expect(listed).not.toContain(" b/y.ts")
      const files = yield* ReviewSource.prDiff({ directory: root, mergeBase: base, head })
      const { slice, changed } = yield* build({ directory: dir, base, head, files })
      expect(slice.clone.partial).toBe(true)
      expect(slice.incomplete).toBeUndefined()
      expect(slice.unsearched).toBeUndefined()
      expect(changed.missing).toEqual([])
      expect(slice.dependents.map((item) => `${item.path}:${item.line}`)).toEqual(["a/x.ts:2", "b/y.ts:2"])
      invariants(slice)
    }),
  )

  it.live("tier b never reads a target a partial clone lacks: it is b:missing, and nothing is fetched", () =>
    Effect.gen(function* () {
      const root = (yield* scopedTmpdir({ git: true })).path
      yield* git(root, "config", "uploadpack.allowfilter", "true")
      yield* git(root, "config", "uploadpack.allowanysha1inwant", "true")
      const util = (call: string) =>
        `import { helper } from "../lib/helper"\n\nexport function computeTotal(items: number[]) {\n${call}\n}\n`
      const base = yield* commit(root, "base", {
        "src/util.ts": util("  return items.length"),
        "lib/helper.ts": "export function helper(value: number) {\n  return value\n}\n",
      })
      const head = yield* commit(root, "head", { "src/util.ts": util("  return helper(items.length)") })
      const dir = path.join(root, "..", `${path.basename(root)}-tier-b`)
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })))
      yield* clone(root, dir, "--filter=blob:none", "--sparse")
      yield* git(dir, "sparse-checkout", "set", "src")
      const files = yield* ReviewSource.prDiff({ directory: root, mergeBase: base, head })
      const before = yield* missing(dir, head)
      const { slice } = yield* build({ directory: dir, base, head, files, packing: {} })
      expect(slice.tiers?.dropped.targets).toEqual(["missing:lib/helper.ts"])
      expect(slice.fallback).toContainEqual({ kind: "b:missing", count: 1 })
      expect(slice.outbound).toEqual([])
      expect(yield* missing(dir, head)).toBe(before)
      invariants(slice)
    }),
  )

  it.live(
    "a treeless clone is not read at all",
    () =>
      Effect.gen(function* () {
        const root = (yield* scopedTmpdir({ git: true })).path
        const { base, head } = yield* source(root)
        const dir = path.join(root, "..", `${path.basename(root)}-treeless`)
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })))
        yield* clone(root, dir, "--filter=tree:0", "--no-checkout")
        const files = yield* ReviewSource.prDiff({ directory: root, mergeBase: base, head })
        const trees = yield* missing(dir, head, "--filter=blob:none")
        expect(trees).toBeGreaterThan(0)
        const { slice } = yield* build({ directory: dir, base, head, files })
        expect(slice).toMatchObject({
          incomplete: ["partial-clone"],
          clone: { partial: true },
          changed: [],
          dependents: [],
        })
        expect(yield* missing(dir, head, "--filter=blob:none")).toBe(trees)
      }),
    LARGE_REPOSITORY,
  )
})
