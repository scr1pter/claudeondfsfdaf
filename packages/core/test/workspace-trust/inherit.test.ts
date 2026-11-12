import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { tmpdir } from "../fixture/tmpdir"

async function settings(directory: string) {
  await fs.mkdir(path.join(directory, ".vector", "commands"), { recursive: true })
  await fs.mkdir(path.join(directory, "runtime"), { recursive: true })
  await fs.writeFile(
    path.join(directory, "vector.json"),
    JSON.stringify({ formatter: { fixture: { command: ["./tool"], cwd: "runtime" } } }),
  )
  await fs.writeFile(path.join(directory, "tui.json"), JSON.stringify({ theme: "dark" }))
  await fs.writeFile(path.join(directory, ".vector", "commands", "fixture.md"), "Approved command")
  await fs.writeFile(path.join(directory, "runtime", "tool"), "Approved executable")
}

describe("workspace trust inheritance", () => {
  test("content keys rebase captured files and execution directories while approval fingerprints remain path-bound", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const copy = path.join(root.path, "copy")
    await settings(source)
    await fs.cp(source, copy, { recursive: true })
    const parent = await WorkspaceTrust.snapshot(source, [])
    const child = await WorkspaceTrust.snapshot(copy, [])

    expect(parent.fingerprint).not.toBe(child.fingerprint)
    expect(WorkspaceTrust.contentKey(parent)).toBe(WorkspaceTrust.contentKey(child))
    expect((await WorkspaceTrust.status(path.join(root.path, "state"), parent)).trusted).toBe(false)
  })

  test("only the parent's currently approved fingerprint can approve the child's original snapshot", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const copy = path.join(root.path, "copy")
    const state = path.join(root.path, "state")
    await settings(source)
    await fs.cp(source, copy, { recursive: true })
    const parent = await WorkspaceTrust.snapshot(source, [])
    const child = await WorkspaceTrust.snapshot(copy, [])

    expect(await WorkspaceTrust.inherit(state, parent, child)).toBe(false)
    await WorkspaceTrust.approve(state, parent)
    expect(await WorkspaceTrust.inherit(state, parent, child)).toBe(true)
    expect(await WorkspaceTrust.status(state, child)).toEqual({
      workspace: child.workspace,
      fingerprint: child.fingerprint,
      trusted: true,
    })
    expect((await WorkspaceTrust.status(state, parent)).trusted).toBe(true)

    await fs.writeFile(path.join(source, "tui.json"), JSON.stringify({ theme: "light" }))
    await fs.writeFile(path.join(copy, "tui.json"), JSON.stringify({ theme: "light" }))
    const changedParent = await WorkspaceTrust.snapshot(source, [])
    const changedChild = await WorkspaceTrust.snapshot(copy, [])
    expect(WorkspaceTrust.contentKey(changedParent)).toBe(WorkspaceTrust.contentKey(changedChild))
    expect(await WorkspaceTrust.inherit(state, changedParent, changedChild)).toBe(false)
    await WorkspaceTrust.approve(state, changedParent)
    expect(await WorkspaceTrust.inherit(state, parent, child)).toBe(false)
  })

  test("changed .vector and TUI settings refuse inheritance", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const copy = path.join(root.path, "copy")
    const state = path.join(root.path, "state")
    await settings(source)
    await fs.cp(source, copy, { recursive: true })
    const parent = await WorkspaceTrust.snapshot(source, [])
    await WorkspaceTrust.approve(state, parent)

    for (const file of [path.join(".vector", "commands", "fixture.md"), "tui.json"]) {
      const original = await fs.readFile(path.join(copy, file))
      await fs.writeFile(path.join(copy, file), "Changed settings")
      const child = await WorkspaceTrust.snapshot(copy, [])
      expect(WorkspaceTrust.contentKey(parent)).not.toBe(WorkspaceTrust.contentKey(child))
      expect(await WorkspaceTrust.inherit(state, parent, child)).toBe(false)
      expect((await WorkspaceTrust.status(state, child)).trusted).toBe(false)
      await fs.writeFile(path.join(copy, file), original)
    }
  })

  test.skipIf(process.platform === "win32")("captured file modes are part of the content key", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const copy = path.join(root.path, "copy")
    await settings(source)
    await fs.cp(source, copy, { recursive: true })
    await fs.chmod(path.join(source, "runtime", "tool"), 0o644)
    await fs.chmod(path.join(copy, "runtime", "tool"), 0o755)
    expect(WorkspaceTrust.contentKey(await WorkspaceTrust.snapshot(source, []))).not.toBe(
      WorkspaceTrust.contentKey(await WorkspaceTrust.snapshot(copy, [])),
    )
  })

  test("external captured files keep their absolute identity even with equal bytes", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const copy = path.join(root.path, "copy")
    await settings(source)
    await fs.cp(source, copy, { recursive: true })
    const first = path.join(root.path, "first-input")
    const second = path.join(root.path, "second-input")
    await fs.writeFile(first, "External fixture")
    await fs.writeFile(second, "External fixture")
    const parent = await WorkspaceTrust.snapshot(source, [first])
    expect(WorkspaceTrust.contentKey(parent)).toBe(
      WorkspaceTrust.contentKey(await WorkspaceTrust.snapshot(copy, [first])),
    )
    expect(WorkspaceTrust.contentKey(parent)).not.toBe(
      WorkspaceTrust.contentKey(await WorkspaceTrust.snapshot(copy, [second])),
    )
  })

  test("external execution directories keep their absolute identity", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source", "project")
    const copy = path.join(root.path, "copy", "project")
    await settings(source)
    await fs.writeFile(
      path.join(source, "vector.json"),
      JSON.stringify({ formatter: { fixture: { command: ["node"], cwd: "../runtime" } } }),
    )
    await fs.cp(source, copy, { recursive: true })
    await fs.mkdir(path.join(root.path, "source", "runtime"))
    await fs.mkdir(path.join(root.path, "copy", "runtime"))
    expect(WorkspaceTrust.contentKey(await WorkspaceTrust.snapshot(source, []))).not.toBe(
      WorkspaceTrust.contentKey(await WorkspaceTrust.snapshot(copy, [])),
    )
  })

  test("unavailable snapshots cannot grant or receive inherited approval", async () => {
    await using root = await tmpdir()
    const source = await WorkspaceTrust.snapshot(root.path, [])
    const missing = await WorkspaceTrust.unavailableSnapshot(root.path, new Error("fixture capture failed"))
    const state = path.join(root.path, "state")
    await WorkspaceTrust.approve(state, source)
    expect(() => WorkspaceTrust.contentKey(missing)).toThrow("snapshot unavailable")
    expect(await WorkspaceTrust.inherit(state, source, missing)).toBe(false)
    expect(await WorkspaceTrust.inherit(state, missing, source)).toBe(false)
    const emptyReason = await WorkspaceTrust.unavailableSnapshot(root.path, new Error(""))
    expect(() => WorkspaceTrust.contentKey(emptyReason)).toThrow("snapshot unavailable")
    expect(await WorkspaceTrust.inherit(state, source, emptyReason)).toBe(false)
    await expect(WorkspaceTrust.approve(state, emptyReason)).rejects.toThrow("snapshot unavailable")
    await expect(WorkspaceTrust.materialize(state, emptyReason)).rejects.toThrow("snapshot unavailable")
    expect((await WorkspaceTrust.status(state, emptyReason)).trusted).toBe(false)
  })

  test("forget revokes only the canonical workspace and prevents inheritance from a cached snapshot", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const copy = path.join(root.path, "copy")
    const state = path.join(root.path, "state")
    await settings(source)
    await fs.cp(source, copy, { recursive: true })
    const parent = await WorkspaceTrust.snapshot(source, [])
    const child = await WorkspaceTrust.snapshot(copy, [])
    await WorkspaceTrust.approve(state, parent)
    expect(await WorkspaceTrust.inherit(state, parent, child)).toBe(true)
    const alias = path.join(root.path, "copy-alias")
    await fs.symlink(copy, alias, process.platform === "win32" ? "junction" : "dir")
    await WorkspaceTrust.forget(state, alias)
    expect((await WorkspaceTrust.status(state, child)).trusted).toBe(false)
    expect((await WorkspaceTrust.status(state, parent)).trusted).toBe(true)
    await WorkspaceTrust.forget(state, source)
    expect(await WorkspaceTrust.inherit(state, parent, child)).toBe(false)
  })

  // A task checkout is forgotten after it is removed, under the data folder's spelling, which may pass through a link
  // (macOS /var, a Windows 8.3 short temp path). Its removal may take its parent folder with it.
  test("forget revokes a removed workspace through the link its path names, however much of it is gone", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const state = path.join(root.path, "state")
    const data = path.join(root.path, "data")
    const link = path.join(root.path, "data-link")
    const leaf = path.join(link, "copy")
    const nested = path.join(link, "project", "copy")
    await settings(source)
    await fs.mkdir(data)
    await fs.symlink(data, link, process.platform === "win32" ? "junction" : "dir")
    try {
      await fs.cp(source, leaf, { recursive: true })
      await fs.cp(source, nested, { recursive: true })
      const parent = await WorkspaceTrust.snapshot(source, [])
      const first = await WorkspaceTrust.snapshot(leaf, [])
      const second = await WorkspaceTrust.snapshot(nested, [])
      await WorkspaceTrust.approve(state, parent)
      expect(await WorkspaceTrust.inherit(state, parent, first)).toBe(true)
      expect(await WorkspaceTrust.inherit(state, parent, second)).toBe(true)

      await fs.rm(path.join(data, "copy"), { recursive: true })
      await WorkspaceTrust.forget(state, leaf)
      expect((await WorkspaceTrust.status(state, first)).trusted).toBe(false)
      expect((await WorkspaceTrust.status(state, second)).trusted).toBe(true)

      await fs.rm(path.join(data, "project"), { recursive: true })
      await WorkspaceTrust.forget(state, nested)
      expect((await WorkspaceTrust.status(state, second)).trusted).toBe(false)
      expect((await WorkspaceTrust.status(state, parent)).trusted).toBe(true)
    } finally {
      // Bun's rm of a link to a folder fails on Windows, so the link goes before the folder is disposed.
      await fs.unlink(link)
    }
  })

  test("forget never follows an unvalidated stored fingerprint to delete cache files", async () => {
    await using root = await tmpdir()
    const state = path.join(root.path, "state")
    const source = path.join(root.path, "source")
    await fs.mkdir(source)
    const parent = await WorkspaceTrust.snapshot(source, [])
    await WorkspaceTrust.approve(state, parent)
    const sentinel = path.join(state, "keep")
    await fs.writeFile(sentinel, "Keep this file")
    const store = JSON.parse(await fs.readFile(path.join(state, "workspace-trust.json"), "utf8")) as {
      workspaces: Record<string, { path: string; fingerprint: string }>
    }
    for (const entry of Object.values(store.workspaces)) entry.fingerprint = "../keep"
    await fs.writeFile(path.join(state, "workspace-trust.json"), JSON.stringify(store))
    await WorkspaceTrust.forget(state, source)
    expect(await fs.readFile(sentinel, "utf8")).toBe("Keep this file")
    expect((await WorkspaceTrust.status(state, parent)).trusted).toBe(false)
  })

  test("concurrent child approvals preserve each other and the parent approval", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    const first = path.join(root.path, "first")
    const second = path.join(root.path, "second")
    const state = path.join(root.path, "state")
    await settings(source)
    await fs.cp(source, first, { recursive: true })
    await fs.cp(source, second, { recursive: true })
    const parent = await WorkspaceTrust.snapshot(source, [])
    const children = await Promise.all([WorkspaceTrust.snapshot(first, []), WorkspaceTrust.snapshot(second, [])])
    await WorkspaceTrust.approve(state, parent)
    expect(await Promise.all(children.map((child) => WorkspaceTrust.inherit(state, parent, child)))).toEqual([
      true,
      true,
    ])
    expect((await WorkspaceTrust.status(state, parent)).trusted).toBe(true)
    for (const child of children) expect((await WorkspaceTrust.status(state, child)).trusted).toBe(true)
  })
})
