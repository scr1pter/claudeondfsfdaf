import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect, FileSystem, Result } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { LayerNodePlatform } from "@vectordevai/core/effect/app-node-platform"
import { WorkflowLibrary } from "@/orchestration/library"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem])))
const spec = (title: string) =>
  JSON.stringify({
    version: 1,
    title,
    stages: [{ id: "review", prompt: "Review {{inputs.topic}}" }],
    inputs: { topic: { default: "changes", description: "Review subject" } },
  })

const fixture = Effect.fnUntraced(function* () {
  const root = yield* tmpdirScoped()
  const fs = yield* FileSystem.FileSystem
  const context = { directory: path.join(root, "project"), worktree: path.join(root, "project") }
  const user = path.join(root, "user")
  const project = path.join(context.directory, ".vector")
  const snapshot = path.join(root, "snapshot")
  const mappings = new Map<string, string>()
  const held = new Set<string>()
  const locks = new Set<string>()
  const directories = [user, project]
  const input: WorkflowLibrary.Loader = {
    fs,
    context,
    config: {
      get: () => Effect.succeed({}),
      loaded: () => Effect.succeed({ files: [], directories }),
      trustedPath: (file) => Effect.succeed(mappings.get(file)),
    },
    allowed: (file) => !held.has(file),
    locked: () => [...locks],
  }
  const write = (file: string, value: string) =>
    fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.andThen(fs.writeFileString(file, value)))
  const approve = (filename: string, value: string) =>
    Effect.gen(function* () {
      mappings.set(project, snapshot)
      mappings.set(path.join(project, filename), path.join(snapshot, filename))
      yield* write(path.join(snapshot, filename), value)
    })
  return { input, user, project, snapshot, mappings, held, locks, directories, write, approve }
})

describe("saved workflow library", () => {
  it.live("project exact names override user files and preserve input metadata", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.write(path.join(f.user, "workflow", "review.json"), spec("User review"))
      yield* f.approve("workflows/review.json", spec("Project review"))
      const entries = yield* WorkflowLibrary.load(f.input)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        name: "review",
        title: "Project review",
        source: "repository",
        inputs: [{ name: "topic", required: false, default: "changes", description: "Review subject" }],
      })
      expect((yield* WorkflowLibrary.select(entries, "review"))?.spec?.title).toBe("Project review")
      expect(yield* WorkflowLibrary.select(entries, "missing")).toBeUndefined()
      f.directories.reverse()
      expect((yield* WorkflowLibrary.load(f.input))[0].source).toBe("repository")
    }),
  )

  it.live("enumerates the approved snapshot and never falls back to edited project files", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.approve("workflow/review.json", spec("Approved"))
      yield* f.write(path.join(f.project, "workflow", "review.json"), spec("Unapproved edit"))
      yield* f.write(path.join(f.project, "workflow", "added.json"), spec("Unapproved new file"))
      expect((yield* WorkflowLibrary.load(f.input)).map((entry) => entry.title)).toEqual(["Approved"])
      f.mappings.delete(path.join(f.project, "workflow", "review.json"))
      expect(yield* WorkflowLibrary.load(f.input)).toEqual([])
      f.mappings.clear()
      expect(yield* WorkflowLibrary.load(f.input)).toEqual([])
    }),
  )

  it.live("outside prompt holds and company command locks prevent loading", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const file = path.join(f.user, "workflow", "review.json")
      yield* f.write(file, spec("Review"))
      f.held.add(file)
      expect(yield* WorkflowLibrary.load(f.input)).toEqual([])
      f.held.clear()
      expect(yield* WorkflowLibrary.load(f.input)).toHaveLength(1)
      f.locks.add("command")
      expect(yield* WorkflowLibrary.load(f.input)).toEqual([])
    }),
  )

  it.live("case collisions list both invalid entries and refuse either name", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.write(path.join(f.user, "workflow", "Review.json"), spec("User"))
      yield* f.approve("workflow/review.json", spec("Project"))
      const entries = yield* WorkflowLibrary.load(f.input)
      expect(entries).toHaveLength(2)
      for (const entry of entries) {
        expect(entry.spec).toBeUndefined()
        expect(entry.issues?.some((issue) => issue.message.includes("Case-colliding"))).toBe(true)
        expect(Result.isFailure(yield* WorkflowLibrary.select(entries, entry.name).pipe(Effect.result))).toBe(true)
      }
    }),
  )

  it.live("invalid JSON, unknown keys and oversized files remain listed with actionable issues", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.write(path.join(f.user, "workflows", "broken.json"), "{invalid")
      yield* f.write(path.join(f.user, "workflows", "unknown.json"), '{"version":1,"title":"Review","stagse":[]}')
      yield* f.write(path.join(f.user, "workflows", "large.json"), " ".repeat(256 * 1024 + 1))
      const entries = yield* WorkflowLibrary.load(f.input)
      expect(entries.map((entry) => entry.name)).toEqual(["broken", "large", "unknown"])
      expect(entries[0].issues?.[0].message).toContain("valid JSON")
      expect(entries[1].issues?.[0].message).toContain("256 KiB")
      expect(entries[2].issues?.some((issue) => issue.path === "/stagse")).toBe(true)
      expect(entries.every((entry) => !entry.spec)).toBe(true)
    }),
  )

  it.live("only immediate JSON files load; invalid names cannot run", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.write(path.join(f.user, "workflow", "valid.json"), spec("Valid"))
      yield* f.write(path.join(f.user, "workflow", "nested", "hidden.json"), spec("Nested"))
      yield* f.write(path.join(f.user, "workflow", "ignored.jsonc"), spec("JSONC"))
      yield* f.write(path.join(f.user, "workflow", "bad.name.json"), spec("Invalid name"))
      const entries = yield* WorkflowLibrary.load(f.input)
      expect(entries.map((entry) => entry.name)).toEqual(["bad.name", "valid"])
      expect(entries[0].issues?.[0].path).toBe("/name")
      expect(Result.isFailure(yield* WorkflowLibrary.select(entries, "bad.name").pipe(Effect.result))).toBe(true)
    }),
  )
})
