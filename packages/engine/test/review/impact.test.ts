import { $ } from "bun"
import { describe, expect } from "bun:test"
import { constants } from "fs"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Effect } from "effect"
import { BrainCode } from "@vectordevai/core/brain/code"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { fnv1a64 } from "@vectordevai/core/review/fingerprint"
import { IMPACT_LIMITS, IMPACT_TIERS, type ImpactSlice } from "@vectordevai/core/review/impact"
import { IMPACT_TIER_CAPS, impactBlock } from "@vectordevai/core/review/prompt"
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

// The portable algorithm fixtures also simulate historic Git versions, partial clones and stalled reads.
// Production entry points always acquire the native immutable snapshot; its end-to-end cases live alongside these.
const fixtureBuild = (input: ReviewImpact.BuildInput) =>
  Git.Service.pipe(Effect.flatMap((reader) => ReviewImpact.algorithm.build(reader, input)))
const fixtureImports = (input: Parameters<typeof ReviewImpact.importLines>[0]) =>
  Git.Service.pipe(Effect.flatMap((reader) => ReviewImpact.algorithm.importLines(reader, input)))
const fixtureParse = (input: Parameters<typeof ReviewImpact.parseChanged>[0]) =>
  Git.Service.pipe(Effect.flatMap((reader) => ReviewImpact.algorithm.parseChanged(reader, input)))

const build = (input: Omit<ReviewImpact.BuildInput, "context"> & { context?: number }) =>
  fixtureBuild({ context: 200_000, budgetMs: GENEROUS, ...input })

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

// A digest of a slice with its timings and git's version zeroed, and of the block it renders. VS-37c changed tier b
// for Go only, so the slices of these tests, which change no Go file or pack no tiers, stay byte-identical: each
// digest was printed at 0ee486e3, before VS-37c's edit, beside the structural assertions that say what moved.
const golden = (slice: ImpactSlice) =>
  fnv1a64(
    JSON.stringify({ block: impactBlock(slice), slice: { ...slice, ms: 0, grepMs: 0, parseMs: 0, gitVersion: "" } }),
  )

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

describe("SF-18 private impact builder", () => {
  const native = process.platform === "linux" ? it.live : it.live.skip

  native(
    "a base checkout supplies the head graph, with denied, generated and credential paths excluded",
    () =>
      Effect.gen(function* () {
        const dir = (yield* scopedTmpdir({ git: true })).path
        const secret = "ghp_" + "c1A3".repeat(9)
        const caller = (word: string) =>
          'import { computeTotal } from "./util"\nexport const result = computeTotal([1]) // ' + word + "\n"
        const base = yield* commit(dir, "trusted base", {
          "src/util.ts": UTIL_BASE,
          "src/a.ts": caller("BASE_ONLY"),
          "src/.gitattributes": "generated.ts linguist-generated\n",
          "src/generated.ts": caller("GENERATED_CONTENT"),
          "src/denied.ts": caller("DENIED_CONTENT"),
          "src/ignored[policy].ts": caller("GLOB_EXCLUDED_CONTENT"),
          "src/.env.ts": caller("HELD_CONTENT"),
        })
        const head = yield* commit(dir, "fork head", {
          "src/util.ts": UTIL_HEAD,
          "src/a.ts": caller(secret),
          "src/.gitattributes": "",
        })
        const diff = yield* ReviewSource.prDiff({ directory: dir, mergeBase: base, head })
        const files = diff.filter((file) => file.path === "src/util.ts")
        yield* git(dir, "checkout", "-q", base)
        yield* write(dir, { "src/a.ts": caller("WORKTREE_ONLY"), "src/untracked.ts": caller("UNTRACKED_CONTENT") })
        const result = yield* ReviewImpact.build({
          directory: dir,
          base,
          head,
          files,
          context: 200_000,
          holdback: "secrets",
          // The classifier treats these brackets literally. A raw Git exclusion carrying backslashes is refused.
          ignore: [String.raw`src/ignored\[policy\].ts`],
          ignored: (file) => file === "src/denied.ts",
        }).pipe(
          Effect.provideService(Git.Service, {
            ...(yield* Git.Service),
            run: () => Effect.die("production impact read escaped to the live Git service"),
          }),
        )
        expect(result.slice.incomplete).toBeUndefined()
        expect(result.slice.tiers).toBeDefined()
        expect(result.slice.dependents.map((dependent) => dependent.path)).toEqual(["src/a.ts"])
        expect(result.slice.dependents[0]!.window).toContain("[redacted]")
        expect(result.slice.locations).toContain("src/a.ts:2")
        expect(result.changedRanks?.get("src/util.ts")).toBeGreaterThan(0)
        expect(result.changed.text("src/util.ts", "RIGHT")).toBe(UTIL_HEAD)
        const artifact = JSON.stringify(result.slice)
        for (const hidden of [
          secret,
          "BASE_ONLY",
          "WORKTREE_ONLY",
          "UNTRACKED_CONTENT",
          "DENIED_CONTENT",
          "GLOB_EXCLUDED_CONTENT",
          "src/ignored[policy].ts",
          "GENERATED_CONTENT",
          "HELD_CONTENT",
          "src/.env.ts",
          "src/denied.ts",
          "src/generated.ts",
        ])
          expect(artifact).not.toContain(hidden)
      }),
    60_000,
  )

  it.live("an import match with a huge sparse line number is omitted before reconstructing its text", () =>
    Effect.gen(function* () {
      const head = "1".repeat(40)
      const file = "src/late-import.ts"
      const read = (args: string[]) => {
        const content = args[0] === "grep" ? head + ":" + file + "\0" + "900000000" + "\0import x from './x'\n" : ""
        return Effect.succeed({
          exitCode: args[0] === "config" ? 1 : 0,
          stdout: Buffer.from(content),
          stderr: Buffer.alloc(0),
          truncated: false,
          text: () => content,
        })
      }
      const found = yield* ReviewImpact.algorithm.importLines(
        { run: read },
        { directory: "/fixture", head, paths: [file] },
      )
      expect(found.has(file)).toBe(false)
    }),
  )

  const unsupportedHost = process.platform === "linux" ? it.live.skip : it.live
  unsupportedHost(
    "an unsupported host cannot fall back to the live repository",
    () =>
      Effect.gen(function* () {
        const directory = (yield* scopedTmpdir({ git: true })).path
        const { base, head, files } = yield* fixture(directory)
        const built = yield* ReviewImpact.build({ directory, base, head, files, context: 100_000 })
        expect(built.slice.incomplete).toEqual(["error"])
        expect(built.slice.locations).toEqual([])
      }),
    30_000,
  )

  it.live("an unsupported revision or expired deadline supplies only incomplete context", () =>
    Effect.gen(function* () {
      const directory = (yield* scopedTmpdir()).path
      const input = { directory, base: "1".repeat(40), head: "2".repeat(40), files: [], context: 100_000 }
      for (const [options, reason] of [
        [{ head: "HEAD" }, "error"],
        [{ budgetMs: 0 }, "time"],
      ] as const) {
        const built = yield* ReviewImpact.build({ ...input, ...options })
        expect(built.slice.incomplete).toEqual([reason])
        expect(built.slice.locations).toEqual([])
        expect(built.changed.text("no.ts", "RIGHT")).toBeUndefined()
        invariants(built.slice)
      }
    }),
  )
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
      expect(golden(slice)).toBe("31afa5449acfe50d")
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
      const service = yield* Git.Service
      // Collect actual Git answers once. Replaying this immutable tree lets the test stall a named read without
      // relying on a native process to start within 1, 20 or 150 ms on a particular runner.
      const answers = new Map<string, Git.Result>()
      const complete = yield* build({ directory: dir, base, head, files }).pipe(
        Effect.provideService(Git.Service, {
          ...service,
          run: (args, options) =>
            service
              .run(args, options)
              .pipe(Effect.tap((result) => Effect.sync(() => answers.set(args.join("\0"), result)))),
        }),
      )
      expect(complete.slice.incomplete).toBeUndefined()
      const empty = yield* build({ directory: dir, base, head, files, budgetMs: 0 }).pipe(
        Effect.provideService(Git.Service, { ...service, run: () => Effect.die("zero-budget build started Git") }),
      )
      expect(empty.slice).toMatchObject({ incomplete: ["time"], gitVersion: "", stages: { candidates: 0 } })
      invariants(empty.slice)

      for (const stop of [
        (args: string[]) => args[0] === "version",
        (args: string[]) => args[0] === "show" && args.at(-1) === `${head}:src/util.ts`,
        (args: string[]) => args[0] === "grep" && args.includes("-l"),
        (args: string[]) => args[0] === "show" && args.at(-1) === `${head}:src/a.ts`,
      ]) {
        let interrupted = 0
        const { slice } = yield* build({ directory: dir, base, head, files, budgetMs: 500 }).pipe(
          Effect.provideService(Git.Service, {
            ...service,
            run: (args) => {
              if (stop(args))
                return Effect.never.pipe(
                  Effect.onInterrupt(() =>
                    Effect.sync(() => {
                      interrupted++
                    }),
                  ),
                )
              const answer = answers.get(args.join("\0"))
              if (!answer) return Effect.die(`unexpected Git read: ${args.join(" ")}`)
              return Effect.succeed(answer)
            },
          }),
        )
        expect(interrupted).toBe(1)
        expect(slice.incomplete).toContain("time")
        invariants(slice)
      }
    }),
  )

  it.live("a complete build confirms at most 200 of 304 gated paths", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* fixture(dir)
      // This is a path cap. Stage 300 paths with one importer blob directly in the index, so a cold Windows
      // disk need not create, hash and remove 300 worktree files.
      const importer = Buffer.from(`import { computeTotal } from "${"../".repeat(9)}src/util"\ncomputeTotal([1])\n`)
      const blob = (yield* Effect.promise(() =>
        $`git hash-object -w --stdin < ${importer}`.cwd(dir).quiet().text(),
      )).trim()
      const paths = Array.from(
        { length: 300 },
        (_, at) => `users/${"segment/".repeat(8)}user${String(at).padStart(3, "0")}.ts`,
      )
      const entries = Buffer.from(paths.map((file) => `100644 ${blob}\t${file}\n`).join(""))
      yield* Effect.promise(() => $`git update-index --index-info < ${entries}`.cwd(dir).quiet())
      yield* git(dir, "commit", "-q", "-m", "users")
      const later = yield* git(dir, "rev-parse", "HEAD")
      // Verify every synthetic path, mode and object in the committed tree before reusing one real Git answer for
      // exactly those reads. Scan, diff, grep and the four different importers below still run real Git.
      const tree = yield* git(dir, "ls-tree", "-rz", later, "--", "users")
      expect(tree.split("\0").slice(0, -1)).toEqual(paths.map((file) => `100644 blob ${blob}\t${file}`))
      const service = yield* Git.Service
      const copies = new Set(paths.map((file) => `${later}:${file}`))
      const mixed = ["dist/bundle.js", "src/a.ts", "src/b.ts", "src/util.test.ts"].map((file) => `${later}:${file}`)
      const changed = [`${base}:src/util.ts`, `${later}:src/util.ts`]
      const answer = yield* service.run(["show", "--no-textconv", `${later}:${paths[0]}`], {
        cwd: dir,
        env: { GIT_NO_LAZY_FETCH: "1" },
      })
      expect(answer.exitCode).toBe(0)
      expect(answer.truncated).toBe(false)
      expect(answer.stdout).toEqual(importer)
      const {
        result: { slice },
        shown,
      } = yield* recorded(build({ directory: dir, base, head: later, files })).pipe(
        Effect.provideService(Git.Service, {
          ...service,
          run: (args, options) => {
            if (args[0] !== "show") return service.run(args, options)
            const spec = args[2]!
            expect(args).toEqual(["show", "--no-textconv", spec])
            if (!copies.has(spec)) {
              expect([...changed, ...mixed]).toContain(spec)
              return service.run(args, options)
            }
            expect(options.cwd).toBe(dir)
            expect(options.env).toEqual({ GIT_NO_LAZY_FETCH: "1" })
            expect(options.stdin).toBeUndefined()
            expect(options.maxOutputBytes).toBeGreaterThanOrEqual(importer.byteLength)
            return Effect.succeed(answer)
          },
        }),
      )
      // All 304 import the same module and tie on rank. Lexical path order puts the four mixed files first, then
      // user000 through user195. Equality on the whole list also detects duplicate reads and reads past the cap.
      expect(shown.toSorted()).toEqual(
        [...changed, ...mixed, ...paths.slice(0, 196).map((file) => `${later}:${file}`)].toSorted(),
      )
      expect(slice.stages.gated).toBe(304)
      expect(slice.dropped.cap).toHaveLength(104)
      expect(slice.dropped.cap).toEqual(paths.slice(196))
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
      const { slice } = yield* fixtureBuild({
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
      expect(golden(slice)).toBe("39f8cb80ed7fa76d")
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
      expect(golden(slice)).toBe("cdb1f993d3b60353")
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
      expect(golden(slice)).toBe("527a2f7d547fee08")
      expect(golden(called.slice)).toBe("527a2f7d547fee08")
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
      expect(golden(open.slice)).toBe("af2be5135922b11e")
      expect(golden(slice)).toBe("02f4aebe08f76411")
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
      expect(golden(slice)).toBe("e4540592fa4558b4")
      invariants(slice)
    }),
  )

  it.live("tier b reads start after confirmation, so a time box never drops more call sites with tiers on", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* tieredFixture(dir)
      for (const budgetMs of [0, 1, 20, 150]) {
        const { slice } = yield* fixtureBuild({
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

// VS-37c: tier b also looks the names an added Go line uses up in the other Go files of its folder, which no import
// names. No sibling file mentions the changed name (Provision), so no other stage reads one: every read of a sibling
// below is tier b's.
const handlerGo = (body: string) =>
  [
    "package proxy",
    "",
    'import "fmt"',
    "",
    "// Handler proxies requests to its upstreams.",
    "type Handler struct {",
    "\tUpstreams []*Upstream",
    "}",
    "",
    "func (h *Handler) Provision() error {",
    "\tfor _, upstream := range h.Upstreams {",
    body,
    "\t}",
    "\treturn nil",
    "}",
    "",
  ].join("\n")
const dialing = (condition: string) =>
  handlerGo([`\t\tif ${condition} {`, '\t\t\treturn fmt.Errorf("no dial address")', "\t\t}"].join("\n"))
const HOSTS_GO =
  "package proxy\n\n// Upstream is one backend.\ntype Upstream struct {\n\tDial      string\n\tLookupSRV string\n}\n"
const goStruct = (pkg: string, name: string, field: string) =>
  `package ${pkg}\n\ntype ${name} struct {\n\t${field}\n}\n`
const goRepo = (dir: string, base: Record<string, string>, head: Record<string, string>) =>
  Effect.gen(function* () {
    const from = yield* commit(dir, "base", { "go.mod": "module example.com/app\n", ...base })
    const to = yield* commit(dir, "head", head)
    const files = yield* ReviewSource.prDiff({ directory: dir, mergeBase: from, head: to })
    return { base: from, head: to, files }
  })
// A change to Provision whose added line reads `upstream.Dial`, a field of Upstream in hosts.go. The test file, the
// subfolder, the other folder and the Markdown file each declare or mention a Dial of their own.
const goFixture = (dir: string, extra: Record<string, string> = {}, head: Record<string, string> = {}) =>
  goRepo(
    dir,
    {
      "proxy/handler.go": handlerGo("\t\t_ = upstream"),
      "proxy/hosts.go": HOSTS_GO,
      "proxy/hosts_test.go": goStruct("proxy", "fakeUpstream", "Dial string"),
      "proxy/sub/deep.go": goStruct("sub", "Deep", "Dial string"),
      "other/x.go": goStruct("other", "X", "Dial string"),
      "proxy/notes.md": "Dial notes\n",
      ...extra,
    },
    { "proxy/handler.go": dialing('upstream.Dial == ""'), ...head },
  )
const DIAL = {
  path: "proxy/hosts.go",
  name: "Upstream.Dial",
  kind: "field",
  start: 5,
  end: 5,
  signature: "Dial string",
  usedIn: "proxy/handler.go:12",
}

describe("ReviewImpact.build in tiers: same-package Go (VS-37c)", () => {
  it.live("a field of a type declared in another file of the package is packed from the head tree-ish", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* goFixture(dir)
      // A later commit and the working tree (a fork review's merge-base checkout) hold more of the package.
      yield* commit(dir, "later", { "proxy/later.go": goStruct("proxy", "Later", "Dial string") })
      yield* git(dir, "checkout", "-q", base)
      yield* write(dir, { "proxy/local.go": goStruct("proxy", "Local", "Dial string") })
      const tiered = yield* recorded(build({ directory: dir, base, head, files, packing: {} }))
      const slice = tiered.result.slice
      // At 0ee486e3, before VS-37c, this build read only the changed file and packed nothing in tier b: outbound [],
      // tiers.shown.b [], no read of proxy/hosts.go.
      expect(slice.outbound).toEqual([DIAL])
      expect(slice.tiers?.shown.b).toEqual(["proxy/hosts.go:5-5"])
      expect(slice.locations).toContain("proxy/hosts.go:5")
      expect(slice.tiers?.dropped.targets).toEqual([])
      expect(slice.fallback).toEqual([])
      expect(impactBlock(slice)).toContain(
        '<untrusted_outbound_signature path="proxy/hosts.go" line="5" kind="field" symbol="Upstream.Dial" used_in="proxy/handler.go:12">\nDial string\n</untrusted_outbound_signature>',
      )
      // The sibling is read once, at head; nothing outside the folder's own Go files of the head tree is read.
      expect(tiered.shown.toSorted()).toEqual(
        [`${base}:proxy/handler.go`, `${head}:proxy/handler.go`, `${head}:proxy/hosts.go`].toSorted(),
      )
      const tree = new Set((yield* git(dir, "ls-tree", "-r", "--name-only", head)).split("\n"))
      for (const entry of tiered.shown)
        expect(
          entry === `${base}:proxy/handler.go` ||
            (entry.startsWith(`${head}:`) && tree.has(entry.slice(head.length + 1))),
        ).toBe(true)
      invariants(slice)
    }),
  )

  it.live("packing unset, or tiers without b, reads no sibling", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* goFixture(dir)
      const plain = yield* recorded(build({ directory: dir, base, head, files }))
      for (const key of ["scopes", "outbound", "fallback", "tiers"])
        expect(Object.hasOwn(plain.result.slice, key)).toBe(false)
      expect(plain.shown.toSorted()).toEqual([`${base}:proxy/handler.go`, `${head}:proxy/handler.go`].toSorted())
      const off = yield* recorded(build({ directory: dir, base, head, files, packing: { tiers: ["a", "c"] } }))
      expect(off.result.slice.outbound).toEqual([])
      expect(off.shown).not.toContain(`${head}:proxy/hosts.go`)
      invariants(off.result.slice)
    }),
  )

  it.live("a changed test file also looks in the package's test files, never in an external test package", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* goFixture(
        dir,
        { "proxy/ext_test.go": goStruct("proxy_test", "extOnly", "Dial string") },
        {
          "proxy/handler_test.go":
            "package proxy\n\nfunc matches(u *Upstream, f *fakeUpstream) bool {\n\treturn f.Dial == u.LookupSRV\n}\n",
        },
      )
      const tiered = yield* recorded(build({ directory: dir, base, head, files, packing: {} }))
      const slice = tiered.result.slice
      expect(slice.outbound?.map((item) => `${item.path}:${item.start}:${item.name}:${item.usedIn}`)).toEqual([
        "proxy/hosts.go:5:Upstream.Dial:proxy/handler.go:12",
        "proxy/hosts.go:4:Upstream:proxy/handler_test.go:3",
        "proxy/hosts_test.go:3:fakeUpstream:proxy/handler_test.go:3",
        "proxy/hosts_test.go:4:fakeUpstream.Dial:proxy/handler_test.go:4",
        "proxy/hosts.go:6:Upstream.LookupSRV:proxy/handler_test.go:4",
      ])
      // The external test package was read (it is in the folder) but declares nothing package proxy can use.
      expect(tiered.shown).toContain(`${head}:proxy/ext_test.go`)
      invariants(slice)
    }),
  )

  it.live("an ignored or generated sibling is never shown, and an ignored one is never read", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* goFixture(dir, {
        "proxy/skip.go": goStruct("proxy", "skipped", "Dial string"),
        "proxy/gen.go": `// Code generated by stringer; DO NOT EDIT.\n\n${goStruct("proxy", "generated", "Dial string")}`,
      })
      const tiered = yield* recorded(
        build({ directory: dir, base, head, files, packing: {}, ignore: ["proxy/skip.go"] }),
      )
      const slice = tiered.result.slice
      expect(slice.outbound).toEqual([DIAL])
      expect(slice.tiers?.dropped.targets).toEqual(["generated:proxy/gen.go", "ignored:proxy/skip.go"])
      // Neither is a fallback the model is told about.
      expect(slice.fallback).toEqual([])
      // The generated file was read, to find its header, and is never shown to the model; the ignored one is not read.
      expect(tiered.shown).toContain(`${head}:proxy/gen.go`)
      expect(tiered.shown).not.toContain(`${head}:proxy/skip.go`)
      expect(slice.locations.some((item) => item.startsWith("proxy/gen.go"))).toBe(false)
      expect(impactBlock(slice)).not.toContain("proxy/gen.go")
      expect(impactBlock(slice)).not.toContain("proxy/skip.go")
      invariants(slice)
    }),
  )

  const sum = (expression: string) => `package proxy\n\nfunc sum(v *All) int {\n\treturn ${expression}\n}\n`
  const indexes = (count: number) => Array.from({ length: count }, (_, at) => String(at).padStart(2, "0"))

  it.live(
    "reads stop at the read cap and signatures at the outbound cap; a sibling past the read cap is cap:, no fallback",
    () =>
      Effect.gen(function* () {
        const dir = (yield* scopedTmpdir({ git: true })).path
        const { base, head, files } = yield* goRepo(
          dir,
          {
            "proxy/sum.go": sum("0"),
            ...Object.fromEntries(
              indexes(25).map((at) => [`proxy/t${at}.go`, goStruct("proxy", `T${at}`, `F${at} int`)]),
            ),
          },
          {
            "proxy/sum.go": sum(
              indexes(25)
                .map((at) => `v.F${at}`)
                .join(" + "),
            ),
          },
        )
        // Tier b may spend the whole budget, so only the caps can stop it.
        const packing = { shares: { a: 0, b: 1, c: 0 } }
        const tiered = yield* recorded(build({ directory: dir, base, head, files, packing }))
        const slice = tiered.result.slice
        expect(tiered.shown.filter((entry) => /proxy\/t\d+\.go$/.test(entry))).toHaveLength(IMPACT_TIERS.targets)
        expect(slice.tiers?.dropped.targets).toEqual(
          indexes(25)
            .slice(20)
            .map((at) => `cap:proxy/t${at}.go`),
        )
        // A sibling is looked up on speculation, so one left unread is named for the eval record, never to the model.
        expect(slice.fallback).toEqual([])
        expect(impactBlock(slice)).not.toContain("Context fell back")
        expect(slice.outbound?.map((item) => `${item.path}:${item.start}:${item.name}`)).toEqual(
          indexes(IMPACT_TIER_CAPS.outbound).map((at) => `proxy/t${at}.go:4:T${at}.F${at}`),
        )
        expect(slice.tiers?.dropped.outbound).toEqual(
          indexes(20)
            .slice(10)
            .map((at) => `proxy/t${at}.go:4`),
        )
        // Ten signatures spend a fraction of the budget tier b had, so the eleventh was left out by the count cap.
        expect(slice.tiers?.tokens.b ?? Infinity).toBeLessThan(IMPACT_LIMITS.tokens / 4)
        invariants(slice)
      }),
  )

  it.live("with bare names alone, sibling reads stop once each is bound, and the rest are never named", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* goRepo(
        dir,
        {
          "proxy/sum.go": sum("0"),
          "proxy/a.go": "package proxy\n\nfunc newPool() int {\n\treturn 1\n}\n",
          "proxy/b.go": "package proxy\n\nconst defaultSize = 4\n",
          ...Object.fromEntries(
            indexes(25).map((at) => [`proxy/c${at}.go`, goStruct("proxy", `C${at}`, `F${at} int`)]),
          ),
        },
        { "proxy/sum.go": sum("newPool() + defaultSize") },
      )
      const tiered = yield* recorded(build({ directory: dir, base, head, files, packing: {} }))
      const slice = tiered.result.slice
      expect(slice.outbound?.map((item) => `${item.path}:${item.start}:${item.name}:${item.kind}`)).toEqual([
        "proxy/b.go:3:defaultSize:variable",
        "proxy/a.go:3:newPool:function",
      ])
      expect(
        tiered.shown.filter((entry) => entry.startsWith(`${head}:proxy/`) && !entry.endsWith("sum.go")).toSorted(),
      ).toEqual([`${head}:proxy/a.go`, `${head}:proxy/b.go`])
      // Nothing was left to look up, so no sibling counts as unread.
      expect(slice.tiers?.dropped.targets).toEqual([])
      expect(slice.fallback).toEqual([])
      invariants(slice)
    }),
  )

  it.live("a member of a long doc-commented struct shows its own line; the struct's signature is cut at 240", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const note = (topic: string) =>
        `\t// This paragraph documents ${topic} at a length that a real struct field may have.`
      const hosts = [
        "package proxy",
        "",
        "// Upstream is one backend, with every setting a request to it needs.",
        "type Upstream struct {",
        ...Array.from({ length: 8 }, (_, at) => note(`the dial address, part ${at + 1}`)),
        '\tDial string `json:"dial,omitempty"`',
        "",
        note("service discovery"),
        '\tLookupSRV string `json:"lookup_srv,omitempty"`',
        "}",
        "",
      ].join("\n")
      const { base, head, files } = yield* goFixture(
        dir,
        { "proxy/hosts.go": hosts },
        { "proxy/handler.go": dialing('upstream.Dial == "" || upstream == (Upstream{})') },
      )
      const { slice } = yield* build({ directory: dir, base, head, files, packing: {} })
      const [field, holder] = slice.outbound ?? []
      // The field the line reads is nine lines below its struct's first line, and its own line is what is shown.
      expect(field).toMatchObject({
        name: "Upstream.Dial",
        kind: "field",
        start: 13,
        signature: 'Dial string `json:"dial,omitempty"`',
      })
      // The bare use of the type shows the parser's signature of the whole spec, which ends inside the comments.
      expect(holder).toMatchObject({ name: "Upstream", kind: "struct", start: 4 })
      expect(holder?.signature).toHaveLength(240)
      expect(holder?.signature).not.toContain("Dial string")
      invariants(slice)
    }),
  )

  it.live("tier b's share closes the account: the signatures that do not fit are dropped in order", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      // Each field line collapses to about 230 characters, near the 240 a signature may hold.
      const field = (at: string) => `G${at} string \`json:"g${at}" note:"${"x".repeat(200)}"\``
      const { base, head, files } = yield* goRepo(
        dir,
        {
          "proxy/sum.go": sum("0"),
          ...Object.fromEntries(indexes(12).map((at) => [`proxy/g${at}.go`, goStruct("proxy", `G${at}`, field(at))])),
        },
        {
          "proxy/sum.go": sum(
            indexes(12)
              .map((at) => `len(v.G${at})`)
              .join(" + "),
          ),
        },
      )
      const packing = { tiers: ["b"], shares: { a: 0, b: 0.05, c: 0 } }
      const { slice } = yield* build({ directory: dir, base, head, files, packing })
      const packed = slice.outbound ?? []
      expect(packed.length).toBeGreaterThan(0)
      expect(packed.length).toBeLessThan(IMPACT_TIER_CAPS.outbound)
      expect(packed.every((item) => item.signature === field(item.name.slice(-2)))).toBe(true)
      expect([...packed.map((item) => `${item.path}:${item.start}`), ...(slice.tiers?.dropped.outbound ?? [])]).toEqual(
        indexes(12).map((at) => `proxy/g${at}.go:4`),
      )
      expect(slice.tiers?.tokens.b ?? Infinity).toBeLessThanOrEqual(0.05 * IMPACT_LIMITS.tokens)
      invariants(slice)
    }),
  )

  it.live("a declaration the diff shows or tier a packs is not repeated, and a changed sibling is read once", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const fields = Array.from({ length: 6 }, (_, at) => `\tF${at + 1}        int`)
      const hosts = (more: string[]) =>
        [
          "package proxy",
          "",
          "// Upstream is one backend.",
          "type Upstream struct {",
          "\tDial      string",
          "\tLookupSRV string",
          ...fields,
          ...more,
          "}",
          "type Pool struct {",
          "\tSize int",
          "}",
          ...Array.from({ length: 10 }, (_, at) => `// filler ${at}`),
          "type Far struct {",
          "\tName string",
          "}",
          "",
        ].join("\n")
      const { base, head, files } = yield* goFixture(
        dir,
        { "proxy/hosts.go": hosts([]) },
        {
          "proxy/hosts.go": hosts(["\tWeight    int"]),
          "proxy/handler.go": dialing('upstream.Dial == "" || pool.Size == 0 || far.Name == ""'),
        },
      )
      const tiered = yield* recorded(build({ directory: dir, base, head, files, packing: {} }))
      const slice = tiered.result.slice
      // Dial is inside Upstream's scope (tier a), and Size's line is in the diff's context: only Far's Name is new.
      expect(slice.scopes?.map((scope) => `${scope.path}:${scope.name}:${scope.start}-${scope.end}`)).toContain(
        "proxy/hosts.go:Upstream:4-14",
      )
      expect(slice.outbound).toEqual([
        {
          path: "proxy/hosts.go",
          name: "Far.Name",
          kind: "field",
          start: 29,
          end: 29,
          signature: "Name string",
          usedIn: "proxy/handler.go:12",
        },
      ])
      // The changed sibling is read by the changed files' parse alone, never again by tier b.
      expect(tiered.shown.filter((entry) => entry === `${head}:proxy/hosts.go`)).toHaveLength(1)
      invariants(slice)
    }),
  )

  it.live("imports go first: three imported packages of eight files fill the read cap, and the sibling is cap:", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const packages = ["a", "b", "c"]
      const run = (expression: string) =>
        [
          "package svc",
          "",
          "import (",
          ...packages.map((name) => `\t"example.com/app/pkg/${name}"`),
          ")",
          "",
          "func Run(s *Server) int {",
          `\treturn ${expression}`,
          "}",
          "",
        ].join("\n")
      const { base, head, files } = yield* goRepo(
        dir,
        {
          "svc/run.go": run("0"),
          "svc/server.go": goStruct("svc", "Server", "Port int"),
          ...Object.fromEntries(
            packages.flatMap((name) =>
              Array.from({ length: 8 }, (_, at) => [
                `pkg/${name}/${name}${at}.go`,
                `package ${name}\n\nfunc ${name.toUpperCase()}${at}() int {\n\treturn ${at}\n}\n`,
              ]),
            ),
          ),
        },
        { "svc/run.go": run("a.A0() + b.B0() + c.C0() + s.Port") },
      )
      const { slice } = yield* build({ directory: dir, base, head, files, packing: {} })
      expect(slice.tiers?.dropped.targets).toEqual([
        "cap:pkg/c/c4.go",
        "cap:pkg/c/c5.go",
        "cap:pkg/c/c6.go",
        "cap:pkg/c/c7.go",
        "cap:svc/server.go",
      ])
      // The four import targets past the cap are a fallback the model is told; the sibling is not.
      expect(slice.fallback).toEqual([{ kind: "b:over-cap", count: 4 }])
      expect(slice.outbound?.map((item) => `${item.path}:${item.name}`)).toEqual([
        "pkg/a/a0.go:A0",
        "pkg/b/b0.go:B0",
        "pkg/c/c0.go:C0",
      ])
      invariants(slice)
    }),
  )

  it.live("an interface method is a member of its interface; a qualified embedded type declares no member", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const store = [
        "package proxy",
        "",
        'import "io"',
        "",
        "// Store loads upstreams.",
        "type Store interface {",
        "\tio.Reader",
        "\tLoad(key string) error",
        "}",
        "",
      ].join("\n")
      const { base, head, files } = yield* goFixture(
        dir,
        { "proxy/store.go": store },
        { "proxy/handler.go": dialing("store.Load(key) != nil || store.Reader == nil || store.io == nil") },
      )
      const { slice } = yield* build({ directory: dir, base, head, files, packing: {} })
      // The real Go grammar reports Load inside Store's body; io and Reader qualify each other, so neither is one.
      expect(slice.outbound).toEqual([
        {
          path: "proxy/store.go",
          name: "Store.Load",
          kind: "method",
          start: 8,
          end: 8,
          signature: "Load(key string) error",
          usedIn: "proxy/handler.go:12",
        },
      ])
      invariants(slice)
    }),
  )

  it.live("a time box that ends at any step leaves a sibling out, and never as a fallback", () =>
    Effect.gen(function* () {
      const dir = (yield* scopedTmpdir({ git: true })).path
      const { base, head, files } = yield* goFixture(dir)
      for (const budgetMs of [0, 1, 20, 150]) {
        const { slice } = yield* fixtureBuild({
          directory: dir,
          base,
          head,
          files,
          context: 200_000,
          budgetMs,
          packing: {},
        })
        invariants(slice)
        // hosts.go is tier b's only target: read and bound in time, or left out as time:, whichever step the box ends.
        expect(slice.outbound).toBeDefined()
        expect([[], [DIAL]]).toContainEqual(slice.outbound ?? [])
        expect(slice.tiers?.dropped.targets.every((entry) => entry === "time:proxy/hosts.go")).toBe(true)
        expect(slice.fallback?.filter((item) => item.kind.startsWith("b:"))).toEqual([])
      }
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
      const lines = yield* fixtureImports({
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
  const source = (dir: string, filesPerFolder = 350) =>
    Effect.gen(function* () {
      yield* git(dir, "config", "uploadpack.allowfilter", "true")
      yield* git(dir, "config", "uploadpack.allowanysha1inwant", "true")
      const big = Object.fromEntries(
        ["big1", "big2"].flatMap((top) =>
          Array.from({ length: filesPerFolder }, (_, at) => [
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
  const missingObjects = (dir: string, rev: string, ...extra: string[]) =>
    git(dir, "rev-list", "--objects", "--no-walk", "--missing=print", ...extra, rev).pipe(
      Effect.map((text) =>
        text
          .split(/\r?\n/)
          .filter((line) => line.startsWith("?"))
          .map((line) => line.slice(1))
          .toSorted(),
      ),
    )
  const missing = (dir: string, rev: string, ...extra: string[]) =>
    missingObjects(dir, rev, ...extra).pipe(Effect.map((objects) => objects.length))
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
        // The sparse case needs 700 missing blobs to overflow a command line. Here every blob is missing, even
        // the changed file and its importer; three head blobs exercise the search and lazy-fetch refusals.
        const { base, head } = yield* source(root, 0)
        const dir = path.join(root, "..", `${path.basename(root)}-blobless`)
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })))
        yield* clone(root, dir, "--filter=blob:none", "--no-checkout")
        const files = yield* ReviewSource.prDiff({ directory: root, mergeBase: base, head })
        const before = yield* missing(dir, head)
        expect(before).toBe(3)
        const missingBase = yield* missing(dir, base)
        expect(missingBase).toBe(3)
        const { slice, changed } = yield* build({ directory: dir, base, head, files })
        expect(slice.incomplete).toEqual(["partial-clone"])
        expect(slice.unsearched).toBe(before)
        expect(slice.stages.candidates).toBe(0)
        expect(changed.missing).toEqual(["base:src/util.ts", "src/util.ts"])
        expect(yield* missing(dir, head)).toBe(before)
        expect(yield* missing(dir, base)).toBe(missingBase)
        // parseChanged and importLines list what the clone lacks first, and never read it.
        const parsed = yield* fixtureParse({ directory: dir, base, head, files })
        expect(parsed.missing).toEqual(["base:src/util.ts", "src/util.ts"])
        expect((yield* fixtureImports({ directory: dir, head, paths: ["src/a.ts"] })).has("src/a.ts")).toBe(false)
        expect(yield* missing(dir, head)).toBe(before)
        expect(yield* missing(dir, base)).toBe(missingBase)
        // The backstop: told nothing is missing and asked to read a missing blob, git refuses rather than fetch it.
        const direct = yield* fixtureParse({ directory: dir, base, head, files, missing: () => false })
        expect(direct.text("src/util.ts", "LEFT")).toBeUndefined()
        expect(direct.text("src/util.ts", "RIGHT")).toBeUndefined()
        expect(direct.missing).toEqual([])
        expect(yield* missing(dir, head)).toBe(before)
        expect(yield* missing(dir, base)).toBe(missingBase)
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
      expect(golden(slice)).toBe("5bdd419e45ebd1aa")
      invariants(slice)
    }),
  )

  it.live("a sibling a partial clone lacks is missing: and no fallback, never read, and nothing is fetched", () =>
    Effect.gen(function* () {
      const root = (yield* scopedTmpdir({ git: true })).path
      yield* git(root, "config", "uploadpack.allowfilter", "true")
      yield* git(root, "config", "uploadpack.allowanysha1inwant", "true")
      const { base, head, files } = yield* goFixture(root)
      const dir = path.join(root, "..", `${path.basename(root)}-go-sibling`)
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })))
      yield* clone(root, dir, "--filter=blob:none", "--no-checkout")
      // A path checkout in a blobless clone does not reliably fetch the path on Git for Windows. Copy only the
      // head handler's actual blob from the local fixture; it must be the sole change to either missing-object set.
      const handler = `${head}:proxy/handler.go`
      const [wanted, sibling, previous] = (yield* git(
        root,
        "rev-parse",
        handler,
        `${head}:proxy/hosts.go`,
        `${base}:proxy/handler.go`,
      )).split(/\r?\n/)
      const headMissing = yield* missingObjects(dir, head)
      const baseMissing = yield* missingObjects(dir, base)
      expect(headMissing).toContain(wanted)
      expect(headMissing).toContain(sibling)
      expect(baseMissing).toContain(previous)
      const bytes = (yield* Effect.promise(() => $`git show --no-textconv ${handler}`.cwd(root).quiet())).stdout
      const copied = yield* Effect.promise(() => $`git hash-object -w --stdin < ${bytes}`.cwd(dir).quiet().text())
      expect(copied.trim()).toBe(wanted)
      yield* git(dir, "checkout", head, "--", "proxy/handler.go")
      expect(yield* Effect.promise(() => fs.readdir(path.join(dir, "proxy")))).toEqual(["handler.go"])
      const before = yield* missingObjects(dir, head)
      expect(before).toEqual(headMissing.filter((oid) => oid !== wanted))
      expect(yield* missingObjects(dir, base)).toEqual(baseMissing)
      const { slice } = yield* build({ directory: dir, base, head, files, packing: {} })
      expect(slice.tiers?.dropped.targets).toEqual(["missing:proxy/hosts.go"])
      // The changed file's base is tier a's fallback; the sibling, looked up on speculation, is none.
      expect(slice.fallback).toEqual([{ kind: "a:missing", count: 1 }])
      expect(slice.outbound).toEqual([])
      expect(yield* missingObjects(dir, head)).toEqual(before)
      expect(yield* missingObjects(dir, base)).toEqual(baseMissing)
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
