import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@vectordevai/core/global"
import { InstanceState } from "@/effect/instance-state"
import { disposeInstance } from "@/effect/instance-registry"
import { SessionID } from "@/session/schema"

/** A real test directory with the same authoritative registry boundary as an isolated task. */
export const taskDirectory = Effect.fn("TaskDirectoryFixture")(function* (
  mode: "worktree" | "copy" = "worktree",
  registered = true,
) {
  const home = yield* InstanceState.context
  const id = SessionID.descending()
  const directory = path.join(Global.Path.data, "task-worktree", home.project.id, id)
  const registry = path.join(Global.Path.data, "task-isolation", home.project.id, id)
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await disposeInstance(directory)
      await fs.rm(directory, { recursive: true, force: true })
      await fs.rm(registry, { recursive: true, force: true })
    }),
  )
  yield* Effect.promise(async () => {
    await fs.mkdir(directory, { recursive: true })
    if (mode === "worktree")
      await fs.cp(path.join(home.directory, ".git"), path.join(directory, ".git"), { recursive: true })
    if (!registered) return
    await fs.mkdir(registry, { recursive: true })
    await fs.writeFile(
      path.join(registry, "record.json"),
      JSON.stringify({ directory, mode, ...(mode === "worktree" ? { branch: `vector/subagent/${id}` } : {}) }),
      { mode: 0o600 },
    )
  })
  return {
    directory,
    registry,
    context: { ...home, directory, worktree: directory },
  }
})
