import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { BrainRunProposals } from "../../src/brain/run-proposals"
import type { BrainExport } from "../../src/brain/export"

const draft: BrainExport.Item = {
  id: "e",
  kind: "lesson",
  scope: "repository",
  status: "proposed",
  pinned: true,
  text: "Run the focused parser regression after changing tokenization.",
  paths: [],
  evidence: [],
  createdAt: 20,
}
const skill: BrainExport.Item = {
  ...draft,
  id: "s",
  kind: "skill",
  skill: {
    name: "parser-check",
    description: "Check parser changes",
    procedure: "Run bun test",
    checks: ["bun test"],
    commands: [],
    version: 1,
  },
}
const memory: BrainExport.File = {
  format: "vector-memory",
  version: 1,
  scope: "all",
  exportedAt: 30,
  documents: [],
  entries: [
    draft,
    { ...draft, id: "old", createdAt: 1 },
    { ...draft, id: "active", status: "active" },
    { ...draft, id: "personal", scope: "personal" },
    { ...draft, id: "private", private: true },
    { ...draft, id: "file", file: "MEMORY.md" },
  ],
  skills: [skill],
}
const input = {
  memory,
  startedAt: 10,
  publicRepository: false,
  maxBytes: 512 * 1024,
  screen: async (parts: readonly string[]) => parts.map(() => true),
}

test("fresh proposed repository records return at a separate path without approval, pins, or old context", async () => {
  const packed = (await BrainRunProposals.pack(input))!
  expect(packed.path).toBe("brain/proposals.json")
  const file = BrainRunProposals.decode({ ...packed, publicRepository: false })
  expect(file.memory.entries.map((item) => item.id)).toEqual(["e"])
  expect(file.memory.skills?.map((item) => item.id)).toEqual(["s"])
  expect(file.memory.entries[0]).toMatchObject({ status: "proposed", pinned: false })
  expect(JSON.stringify(file)).not.toMatch(/approval|codiumUnits|costUsd|tokens/)
})
test("public runs omit procedures and the initial file consumes the shared total budget", async () => {
  const packed = (await BrainRunProposals.pack({ ...input, publicRepository: true }))!
  expect(BrainRunProposals.decode({ ...packed, publicRepository: true }).memory.skills).toEqual([])
  expect(await BrainRunProposals.pack({ ...input, maxBytes: packed.bytes.length - 1 })).toBeUndefined()
  expect(await BrainRunProposals.pack({ ...input, maxBytes: 0 })).toBeUndefined()
  expect(await BrainRunProposals.pack({ ...input, startedAt: 100 })).toBeUndefined()
})
test("one combined posting check covers every returned record and may drop drafts", async () => {
  const packed = (await BrainRunProposals.pack({
    ...input,
    screen: async (parts) => {
      expect(parts).toHaveLength(2)
      expect(parts[1]).toContain("Run bun test")
      return [true, false]
    },
  }))!
  expect(BrainRunProposals.decode({ ...packed, publicRepository: false }).memory.skills).toEqual([])
  await expect(BrainRunProposals.pack({ ...input, screen: async () => [] })).rejects.toThrow("every returned draft")
})
test("returned drafts cannot replace initial approval or import active/pinned/private entries", async () => {
  const packed = (await BrainRunProposals.pack(input))!
  expect(() => BrainRunProposals.decode({ ...packed, path: "brain/bundle.json", publicRepository: false })).toThrow(
    "manifest",
  )
  expect(() => BrainRunProposals.decode({ ...packed, publicRepository: true })).toThrow("Invalid")
  for (const patch of [{ status: "active" }, { pinned: true }, { private: true }, { scope: "personal" }]) {
    const file = JSON.parse(packed.bytes.toString())
    file.memory.entries[0] = { ...file.memory.entries[0], ...patch }
    const bytes = Buffer.from(JSON.stringify(file))
    expect(() =>
      BrainRunProposals.decode({
        path: packed.path,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        publicRepository: false,
      }),
    ).toThrow("Invalid")
  }
})
