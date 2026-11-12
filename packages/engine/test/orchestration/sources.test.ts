import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect, Result } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { RelativePath } from "@vectordevai/core/schema"
import { Entry } from "@vectordevai/schema/filesystem"
import { WorkflowSources } from "@/orchestration/sources"
import { Git } from "@/git"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, Git.node, Ripgrep.node])))
const output = (key: string, value: WorkflowSources.Output["value"], stage = "research") => ({ key, value, stage })

describe("workflow output sources", () => {
  test("streams projected elements with stable, distinct keys and source labels", () => {
    const source = { from: "research", path: "findings" }
    const first = output("one", { findings: ["same", "same"] })
    const initial = WorkflowSources.project(source, [first], { complete: false })
    expect(initial.map((item) => item.value)).toEqual(["same", "same"])
    expect(new Set(initial.map((item) => item.key)).size).toBe(2)
    expect(initial[0].source).toContain("research#one")
    const later = WorkflowSources.project(source, [first, output("two", { findings: ["next"] })], { complete: false })
    expect(later.slice(0, 2)).toEqual([...initial])
    expect(later[2].value).toBe("next")
    expect(
      WorkflowSources.project(source, [output("other", { findings: ["ignored"] }, "other")], { complete: true }),
    ).toEqual([])
  })

  test("projections can traverse arrays and never inspect prototype fields", () => {
    expect(
      WorkflowSources.project(
        { from: "research", path: "rows.names" },
        [output("one", { rows: [{ names: ["a", "b"] }, { names: ["c"] }] })],
        { complete: false },
      ).map((item) => item.value),
    ).toEqual(["a", "b", "c"])
    expect(
      WorkflowSources.project({ from: "research", path: "constructor" }, [output("one", {})], { complete: true }),
    ).toEqual([])
  })

  test("where and dedupe keep first settled matches, with missing fields distinct", () => {
    const source = { from: ["research", "more"], where: { path: "score", gt: 1 }, dedupe_by: "id" }
    const values = WorkflowSources.project(
      source,
      [
        output("one", [{ id: "a", score: 1 }, { id: "b", score: 2 }, { score: 3 }]),
        output("two", [{ id: "b", score: 4 }, { score: 5 }], "more"),
      ],
      { complete: false },
    ).map((item) => item.value)
    expect(values).toEqual([{ id: "b", score: 2 }, { score: 3 }, { score: 5 }])
  })

  test("wait-all and sorting hold emission until complete; sort precedes limit and batch", () => {
    const outputs = [output("one", [{ score: 2 }, { score: 11 }, { score: 1 }, {}])]
    expect(WorkflowSources.project({ from: "research", wait: "all" }, outputs, { complete: false })).toEqual([])
    const source = { from: "research", sort_by: "score", desc: true, limit: 3, batch: 2 }
    expect(WorkflowSources.project(source, outputs, { complete: false })).toEqual([])
    expect(WorkflowSources.project(source, outputs, { complete: true }).map((item) => item.value)).toEqual([
      [{ score: 11 }, { score: 2 }],
      [{ score: 1 }],
    ])
  })

  test("full batches stream; a final partial batch waits for all sources", () => {
    const source = { from: "research", batch: 2 }
    const outputs = [output("one", ["a", "b", "c"])]
    const partial = WorkflowSources.project(source, outputs, { complete: false })
    expect(partial.map((item) => item.value)).toEqual([["a", "b"]])
    const full = WorkflowSources.project(source, outputs, { complete: true })
    expect(full[0]).toEqual(partial[0])
    expect(full.map((item) => item.value)).toEqual([["a", "b"], ["c"]])
    const grown = WorkflowSources.project(source, [...outputs, output("two", "d")], { complete: false })
    expect(grown[0]).toEqual(partial[0])
    expect(grown[1].value).toEqual(["c", "d"])
  })

  test("no implicit projection limit silently discards source output", () => {
    const outputs = [
      output(
        "one",
        Array.from({ length: 1001 }, (_, i) => i),
      ),
    ]
    expect(WorkflowSources.project({ from: "research" }, outputs, { complete: true })).toHaveLength(1001)
    expect(WorkflowSources.project({ from: "research", limit: 4 }, outputs, { complete: true })).toHaveLength(4)
  })
})

describe("workflow local sources", () => {
  it.live("literal keys survive unrelated insertions, while duplicates remain separate", () =>
    Effect.gen(function* () {
      const git = yield* Git.Service
      const ripgrep = yield* Ripgrep.Service
      const cwd = yield* tmpdirScoped()
      const before = yield* WorkflowSources.initial({ items: ["a", "a", { z: 1, a: 2 }] }, { cwd, git, ripgrep })
      const after = yield* WorkflowSources.initial(
        { items: ["inserted", "a", "a", { a: 2, z: 1 }] },
        { cwd, git, ripgrep },
      )
      expect(after.slice(1).map((item) => item.key)).toEqual(before.map((item) => item.key))
      expect(before[0].key).not.toBe(before[1].key)
      expect(yield* WorkflowSources.initial(undefined, { cwd, git, ripgrep })).toHaveLength(1)
    }),
  )

  it.live("files skip hidden paths by default, apply exclusions before limit, and stay sorted", () =>
    Effect.gen(function* () {
      const git = yield* Git.Service
      const ripgrep = yield* Ripgrep.Service
      const cwd = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(cwd, ".hidden"))
        await fs.mkdir(path.join(cwd, "src"))
        await Promise.all(
          ["src/a.ts", "src/b.ts", "src/c.ts", ".hidden/d.ts", ".dot.ts"].map((name) =>
            fs.writeFile(path.join(cwd, name), name),
          ),
        )
      })
      const read = (source: Parameters<typeof WorkflowSources.initial>[0]) =>
        WorkflowSources.initial(source, { cwd, git, ripgrep })
      expect(
        (yield* read({ files: { glob: "**/*.ts", exclude: ["**/a.ts"], limit: 1 } })).map((item) => item.value),
      ).toEqual(["src/b.ts"])
      expect((yield* read({ files: { glob: "**/*.ts" } })).map((item) => item.value)).toEqual([
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
      ])
      expect((yield* read({ files: { glob: "**/*.ts", hidden: true } })).map((item) => item.value)).toEqual([
        ".dot.ts",
        ".hidden/d.ts",
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
      ])
    }),
  )

  it.live("changed files distinguish the working tree from a resolved base and omit deletions", () =>
    Effect.gen(function* () {
      const git = yield* Git.Service
      const ripgrep = yield* Ripgrep.Service
      const cwd = yield* tmpdirScoped({ git: true })
      const run = (args: string[]) =>
        git.run(args, { cwd }).pipe(Effect.tap((result) => Effect.sync(() => expect(result.exitCode).toBe(0))))
      yield* Effect.promise(() =>
        Promise.all(["changed.ts", "deleted.ts"].map((name) => fs.writeFile(path.join(cwd, name), "before"))),
      )
      yield* run(["add", "."])
      yield* run(["commit", "-m", "tracked files"])
      const base = (yield* run(["rev-parse", "HEAD"])).text().trim()
      yield* Effect.promise(() => fs.writeFile(path.join(cwd, "committed.ts"), "committed"))
      yield* run(["add", "."])
      yield* run(["commit", "-m", "later change"])
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(cwd, "changed.ts"), "after")
        await fs.rm(path.join(cwd, "deleted.ts"))
        await fs.writeFile(path.join(cwd, "untracked.ts"), "new")
      })
      const read = (source: Parameters<typeof WorkflowSources.initial>[0]) =>
        WorkflowSources.initial(source, { cwd, git, ripgrep })
      expect((yield* read({ changed_files: {} })).map((item) => item.value)).toEqual(["changed.ts", "untracked.ts"])
      expect((yield* read({ changed_files: { base } })).map((item) => item.value)).toEqual([
        "changed.ts",
        "committed.ts",
        "untracked.ts",
      ])
      expect(
        (yield* read({ changed_files: { include_deleted: true, include: ["deleted.*"] } })).map((item) => item.value),
      ).toEqual(["deleted.ts"])
      const invalid = yield* read({ changed_files: { base: "--output=/tmp/not-a-revision" } }).pipe(Effect.result)
      expect(Result.isFailure(invalid)).toBe(true)
      if (Result.isFailure(invalid)) expect(invalid.failure.code).toBe("git")
    }),
  )

  it.live("oversized enumerations fail visibly unless an explicit limit can select the result", () =>
    Effect.gen(function* () {
      const git = yield* Git.Service
      const cwd = yield* tmpdirScoped()
      // The adapter boundary tests its bounds without making ten thousand fixture files.
      const scan = (count: number): Pick<Ripgrep.Interface, "glob"> => ({
        glob: () =>
          Effect.succeed(
            Array.from({ length: count }, (_, i) =>
              Entry.make({ path: RelativePath.make(`file-${String(i).padStart(5, "0")}.ts`), type: "file" }),
            ),
          ),
      })
      const large = yield* WorkflowSources.initial({ files: { glob: "*.ts" } }, { cwd, git, ripgrep: scan(1001) }).pipe(
        Effect.result,
      )
      expect(Result.isFailure(large)).toBe(true)
      if (Result.isFailure(large)) expect(large.failure.message).toContain("explicit limit")
      const limited = yield* WorkflowSources.initial(
        { files: { glob: "*.ts", limit: 2 } },
        { cwd, git, ripgrep: scan(1001) },
      )
      expect(limited.map((item) => item.value)).toEqual(["file-00000.ts", "file-00001.ts"])
      const excessive = yield* WorkflowSources.initial(
        { files: { glob: "*.ts", limit: 1 } },
        { cwd, git, ripgrep: scan(10001) },
      ).pipe(Effect.result)
      expect(Result.isFailure(excessive)).toBe(true)
      if (Result.isFailure(excessive)) expect(excessive.failure.message).toContain("narrow its glob")
    }),
  )

  it.live("changed paths remain relative to a nested instance directory", () =>
    Effect.gen(function* () {
      const git = yield* Git.Service
      const ripgrep = yield* Ripgrep.Service
      const root = yield* tmpdirScoped({ git: true })
      const cwd = path.join(root, "nested")
      yield* Effect.promise(async () => {
        await fs.mkdir(cwd)
        await fs.writeFile(path.join(cwd, "inside.ts"), "inside")
        await fs.writeFile(path.join(root, "outside.ts"), "outside")
      })
      const found = yield* WorkflowSources.initial({ changed_files: {} }, { cwd, git, ripgrep })
      expect(found.map((item) => item.value)).toEqual(["inside.ts"])
    }),
  )
})
