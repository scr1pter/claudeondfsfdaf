import { expect, test } from "bun:test"
import { runSessionAncestry } from "@/cli/cmd/run/ancestry"

test("discovers nested activity before its first completed step or permission request", async () => {
  const known = new Set(["root"])
  const calls: string[] = []
  const inRun = runSessionAncestry(known, async (id) => {
    calls.push(id)
    return { parentID: id === "leaf" ? "coordinator" : "root" }
  })
  // The CLI applies this ownership check to all activity, outside its JSON,
  // research-progress and permission-rendering branches.
  expect(await inRun("leaf")).toBe(true)
  expect(calls).toEqual(["leaf", "coordinator"])
  expect(known.has("leaf")).toBe(true)
  expect(await inRun("leaf")).toBe(true)
  expect(calls).toHaveLength(2)
})

test("unrelated session activity never joins the run or refreshes its scope", async () => {
  const known = new Set(["root"])
  const calls: string[] = []
  const inRun = runSessionAncestry(known, async (id) => {
    calls.push(id)
    return id === "unrelated-child" ? { parentID: "unrelated-root" } : {}
  })
  expect(await inRun("unrelated-child")).toBe(false)
  expect(await inRun("unrelated-child")).toBe(false)
  expect(calls).toEqual(["unrelated-child", "unrelated-root"])
  expect([...known]).toEqual(["root"])
})

test("a row not yet available can be discovered on a later event", async () => {
  let available = false
  const inRun = runSessionAncestry(new Set(["root"]), async () => (available ? { parentID: "root" } : undefined))
  expect(await inRun("new-child")).toBe(false)
  available = true
  expect(await inRun("new-child")).toBe(true)
})

test("cyclic unknown ancestry stops within the existing lookup bound", async () => {
  const calls: string[] = []
  const inRun = runSessionAncestry(new Set(["root"]), async (id) => {
    calls.push(id)
    return { parentID: id === "cycle-a" ? "cycle-b" : "cycle-a" }
  })
  expect(await inRun("cycle-a")).toBe(false)
  expect(calls).toEqual(["cycle-a", "cycle-b"])
  expect(await inRun(undefined)).toBe(false)
})

test("unknown ancestry beyond the existing traversal bound is not accepted", async () => {
  const calls: string[] = []
  const inRun = runSessionAncestry(new Set(["root"]), async (id) => {
    calls.push(id)
    return { parentID: id === "chain-5" ? "root" : "chain-" + (Number(id.slice(6)) + 1) }
  })
  expect(await inRun("chain-0")).toBe(false)
  expect(calls).toEqual(["chain-0", "chain-1", "chain-2", "chain-3", "chain-4"])
})

test("unrelated parent-link caching stays bounded", async () => {
  const calls: string[] = []
  const inRun = runSessionAncestry(new Set(["root"]), async (id) => {
    calls.push(id)
    return {}
  })
  for (const id of Array.from({ length: 257 }, (_, index) => "unrelated-" + index)) expect(await inRun(id)).toBe(false)
  expect(await inRun("unrelated-0")).toBe(false)
  expect(calls).toHaveLength(258)
})
