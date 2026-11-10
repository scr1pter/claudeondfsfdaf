import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { TaskClaims } from "@/task/claims"
import { Deferred, Effect, Fiber } from "effect"
import { FileLock } from "@/tool/file-lock"

const roots: string[] = []
const temp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vector-claims-")))
  roots.push(dir)
  return dir
}
const reserve = (tree: string, taskID = "ses_child", paths = ["src"], parentSessionID = "ses_root") => {
  const entry = TaskClaims.reserve({ tree, directory: tree, taskID, paths, parentSessionID, title: taskID })
  TaskClaims.bind(entry, taskID)
  return entry
}
// A launch refusal's lines for a caller whose family holds exactly these launchers.
const lines = (input: Parameters<typeof TaskClaims.overlaps>[0], family: readonly string[] = []) =>
  Effect.runSync(TaskClaims.describe(TaskClaims.overlaps(input), (id) => Effect.succeed(family.includes(id))))

afterEach(() => {
  for (const entry of TaskClaims.claims) TaskClaims.release(entry)
  for (const protection of TaskClaims.protectedTrees()) TaskClaims.unprotect(protection.taskID)
  for (const dir of roots.splice(0)) {
    TaskClaims.dropDirectory(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("TaskClaims", () => {
  test("reserve, bind and release cover a launch before and after its job starts", () => {
    const tree = temp()
    const claim = TaskClaims.reserve({
      tree,
      directory: tree,
      parentSessionID: "ses_root",
      paths: ["src"],
      title: "Worker",
    })
    const input = { tree, directory: tree, parentSessionID: "ses_root", paths: ["src/file.ts"] }
    expect(lines(input, ["ses_root"])).toEqual(["Worker: src/file.ts overlaps src"])
    TaskClaims.bind(claim, "ses_child")
    expect(TaskClaims.pathsFor("ses_child")).toEqual(["src"])
    expect(claim.held).toBe(true)
    TaskClaims.release(claim)
    expect(TaskClaims.overlaps(input)).toEqual([])
    expect(TaskClaims.pathsFor("ses_child")).toEqual(["src"])
  })

  test("overlaps keeps dependency, resume and ancestor exceptions without prefix lookalikes", () => {
    const tree = temp()
    reserve(tree)
    const input = { tree, directory: tree, parentSessionID: "ses_root", paths: ["src/file.ts"] }
    expect(TaskClaims.overlaps(input)).toHaveLength(1)
    expect(TaskClaims.overlaps({ ...input, paths: ["src-other/file.ts"] })).toEqual([])
    expect(TaskClaims.overlaps({ ...input, except: new Set(["ses_child"]) })).toEqual([])
    expect(TaskClaims.overlaps({ ...input, taskID: "ses_child" })).toEqual([])
    expect(TaskClaims.overlaps({ ...input, parentSessionID: "ses_child" })).toEqual([])
    reserve(tree, "ses_other", ["lib"], "ses_different_root")
    expect(lines({ ...input, paths: ["lib/file.ts"] }, ["ses_different_root"])).toEqual([
      "ses_other: lib/file.ts overlaps lib",
    ])
    expect(lines({ ...input, paths: ["lib/file.ts"] })).toEqual([
      "lib/file.ts overlaps another conversation's running subagent",
    ])
  })

  test("a launch refusal names a claim, its paths and changed files only to its launcher's family", () => {
    const tree = temp()
    reserve(tree, "ses_keys", ["vault"], "ses_owner")
    reserve(tree, "ses_notes", [], "ses_owner")
    TaskClaims.touch("ses_notes", path.join(tree, "secrets", "notes.md"))
    reserve(tree, "ses_mine", ["src"], "ses_guest")
    const input = { tree, directory: tree, parentSessionID: "ses_guest", paths: ["."] }
    expect(TaskClaims.overlaps(input)).toHaveLength(3)
    // The owner's family is told which of its claims, paths and files overlap, as before.
    expect(lines(input, ["ses_owner", "ses_guest"])).toEqual([
      "ses_keys: . overlaps vault",
      `ses_notes: . overlaps ${path.join("secrets", "notes.md")}`,
      "ses_mine: . overlaps src",
    ])
    // Anyone else learns only which of its own paths overlaps another conversation's work, once, and the relation is
    // read once per launcher.
    const asked: string[] = []
    const guest = Effect.runSync(
      TaskClaims.describe(TaskClaims.overlaps(input), (id) =>
        Effect.sync(() => asked.push(id)).pipe(Effect.as(id === "ses_guest")),
      ),
    )
    expect(guest).toEqual([". overlaps another conversation's running subagent", "ses_mine: . overlaps src"])
    expect(asked.sort()).toEqual(["ses_guest", "ses_owner"])
    for (const hidden of ["ses_keys", "ses_notes", "ses_owner", "vault", "secrets"])
      expect(guest.join("\n")).not.toContain(hidden)
    // Without the relation no claim is named, not even the caller's own.
    expect(Effect.runSync(TaskClaims.describe(TaskClaims.overlaps(input), undefined))).toEqual([
      ". overlaps another conversation's running subagent",
    ])
  })

  test("conflicts spans root sessions but permits the owner's own sub-helper", () => {
    const tree = temp()
    reserve(tree)
    reserve(tree, "ses_grandchild", ["src/sub"], "ses_child")
    const file = path.join(tree, "src/sub/file.ts")
    expect(TaskClaims.conflicts({ tree, sessionID: "ses_root", file })).toHaveLength(2)
    expect(TaskClaims.conflicts({ tree, sessionID: "ses_other_root", file })).toHaveLength(2)
    expect(TaskClaims.conflicts({ tree, sessionID: "ses_grandchild", file })).toEqual([])
    expect(TaskClaims.conflicts({ tree: temp(), sessionID: "ses_other_root", file })).toEqual([])
  })

  test("unscoped writes stay claimed until settle and isolated writers do not claim the shared tree", () => {
    const tree = temp()
    const file = path.join(tree, "file.ts")
    const claim = reserve(tree, "ses_child", [])
    TaskClaims.touch("ses_child", file)
    const unscoped = { tree, directory: tree, parentSessionID: "ses_other_root", paths: ["file.ts"] }
    expect(lines(unscoped, ["ses_root"])).toEqual(["ses_child: file.ts overlaps file.ts"])
    expect(lines(unscoped)).toEqual(["file.ts overlaps another conversation's running subagent"])
    expect(TaskClaims.conflicts({ tree, sessionID: "ses_sibling", file })[0]).toMatchObject({
      entry: claim,
      owned: undefined,
    })
    TaskClaims.release(claim)
    expect(TaskClaims.conflicts({ tree, sessionID: "ses_sibling", file })).toEqual([])
    const isolated = TaskClaims.reserve({
      tree,
      directory: tree,
      parentSessionID: "ses_root",
      taskID: "ses_isolated",
      title: "Isolated",
      paths: ["."],
      isolated: true,
    })
    expect(TaskClaims.overlaps({ tree, directory: tree, parentSessionID: "ses_root", paths: ["."] })).toEqual([])
    TaskClaims.touch("ses_isolated", file)
    expect(isolated.files.size).toBe(0)
  })

  test("real paths share one tree, and dropDirectory removes only that instance's entries", () => {
    const tree = temp()
    fs.mkdirSync(path.join(tree, "nested"))
    const first = reserve(tree)
    const other = TaskClaims.reserve({
      tree,
      directory: path.join(tree, "nested"),
      parentSessionID: "ses_root",
      taskID: "ses_nested",
      paths: ["x"],
      title: "Nested",
    })
    TaskClaims.dropDirectory(tree)
    expect(first.active).toBe(false)
    expect(other.active).toBe(true)
    expect(TaskClaims.conflicts({ tree, sessionID: "ses_root", file: path.join(tree, "nested/x") })).toHaveLength(1)
  })

  test.skipIf(process.platform === "win32")("symlink spellings cannot bypass claims", () => {
    const tree = temp()
    const alias = path.join(temp(), "alias")
    fs.symlinkSync(tree, alias)
    reserve(tree)
    expect(
      TaskClaims.conflicts({ tree: alias, sessionID: "ses_other", file: path.join(alias, "src/new.ts") }),
    ).toHaveLength(1)
  })

  test.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
    "claim keys follow the volume's case folding",
    () => {
      const tree = temp()
      fs.mkdirSync(path.join(tree, "Source"))
      reserve(tree, "ses_child", ["Source"])
      const file = path.join(tree, "Source/file.ts")
      const folded = path.join(tree, "source/file.ts")
      expect(TaskClaims.conflicts({ tree, sessionID: "ses_other", file: folded }).length > 0).toBe(
        FileLock.key(file) === FileLock.key(folded),
      )
    },
  )

  test("protected task and registry folders admit only that task and its descendants", () => {
    const tree = temp()
    const work = path.join(temp(), "work")
    const registry = path.join(temp(), "record")
    reserve(work, "ses_isolated", [])
    reserve(work, "ses_nested", [], "ses_isolated")
    TaskClaims.protect({
      taskID: "ses_isolated",
      directories: [work, registry],
      parentDirectory: tree,
      workDirectory: work,
      privateDirectories: [registry],
      immutableFiles: [path.join(work, ".git")],
    })
    expect(TaskClaims.protectedConflict("ses_root", path.join(work, "file.ts"))?.taskID).toBe("ses_isolated")
    expect(TaskClaims.protectedConflict("ses_root", path.join(registry, "record.json"))?.taskID).toBe("ses_isolated")
    expect(TaskClaims.protectedConflict("ses_nested", path.join(work, "file.ts"))).toBeUndefined()
    expect(TaskClaims.protectedConflict("ses_isolated", path.join(registry, "record.json"))?.taskID).toBe(
      "ses_isolated",
    )
    expect(
      TaskClaims.protectedConflict("ses_nested", path.join(registry, "checkpoints", "manifest.json"))?.taskID,
    ).toBe("ses_isolated")
    expect(TaskClaims.protectedConflict("ses_isolated", path.join(work, ".git"))?.taskID).toBe("ses_isolated")
    expect(TaskClaims.parentTarget("ses_nested", path.join(tree, "src/file.ts"))).toBe(path.join(work, "src/file.ts"))
    expect(TaskClaims.parentTarget("ses_nested", path.dirname(tree), true)).toBe(work)
    expect(TaskClaims.protectedConflict("ses_nested", work, true)?.taskID).toBe("ses_isolated")
    expect(TaskClaims.protectedConflict("ses_root", path.dirname(registry), true)?.taskID).toBe("ses_isolated")
  })
})

test("interruption between reserve and job start releases ownership", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const tree = temp()
      const ready = yield* Deferred.make<void>()
      const preparing = yield* Effect.scoped(
        Effect.gen(function* () {
          const entry = yield* TaskClaims.scoped({
            tree,
            directory: tree,
            parentSessionID: "ses_root",
            taskID: "ses_child",
            title: "Preparing",
            paths: ["src"],
          })
          TaskClaims.bind(entry.claim, "ses_child")
          yield* Deferred.succeed(ready, undefined)
          yield* Effect.never
        }),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      expect(TaskClaims.forTask("ses_child")).toHaveLength(1)
      yield* Fiber.interrupt(preparing)
      expect(TaskClaims.forTask("ses_child")).toEqual([])
      expect(TaskClaims.overlaps({ tree, directory: tree, parentSessionID: "ses_other", paths: ["src"] })).toEqual([])
    }),
  ))

test("unknown trusted scope fails closed while an explicit empty assignment stays unrestricted", () => {
  const tree = temp()
  expect(() => TaskClaims.trustedPaths("ses_missing", true)).toThrow("trusted file assignment is unavailable")
  expect(TaskClaims.trustedPaths("ses_missing", false)).toBeUndefined()
  const unrestricted = reserve(tree, "ses_unrestricted", [])
  expect(TaskClaims.trustedPaths("ses_unrestricted", true)).toEqual([])
  TaskClaims.release(unrestricted)
  expect(TaskClaims.trustedPaths("ses_unrestricted", true)).toEqual([])
  TaskClaims.dropDirectory(tree)
  expect(() => TaskClaims.trustedPaths("ses_unrestricted", true)).toThrow("trusted file assignment is unavailable")
})
