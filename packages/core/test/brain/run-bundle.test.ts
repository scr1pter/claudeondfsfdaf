import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { BrainRunBundle } from "../../src/brain/run-bundle"
import type { BrainExport } from "../../src/brain/export"
import { BrainTransfer } from "../../src/brain/transfer"

const entry: BrainExport.Item = { id: "e1", kind: "lesson", scope: "repository", status: "active", text: "Use the repository test script.", paths: [], pinned: true, evidence: [], createdAt: 1 }
const skill: BrainExport.Item = { ...entry, id: "s1", kind: "skill", skill: {
  name: "learned-check", description: "Check changes", procedure: "Run bun test", checks: ["bun test"], commands: [], version: 1,
} }
const memory: BrainExport.File = { format: "vector-memory", version: 1, scope: "all", exportedAt: 1, entries: [entry,
  { ...entry, id: "personal", scope: "personal" }, { ...entry, id: "private", private: true },
  { ...entry, id: "unapproved", status: "proposed" }, { ...entry, id: "file", file: "MEMORY.md" },
], documents: [] }
const input = { ownerStartedDesktop: true, includeBrain: true, publicRepository: false, memory,
  shareableSkills: [skill], insights: { format: "vector-workflow-insights", version: 1, rows: [] } as const,
  screen: async (parts: readonly string[]) => parts.map(() => true),
}

test("an explicit preview contains only eligible repository memory and approved shareable procedures", async () => {
  const packed = await BrainRunBundle.pack(input)
  expect(packed.path).toBe("brain/bundle.json")
  expect(packed.entries).toBe(1)
  expect(packed.skills).toBe(1)
  const decoded = BrainRunBundle.decode(packed)
  expect(decoded.memory.entries.map((item) => item.id)).toEqual(["e1"])
  expect(decoded.memory.documents).toEqual([])
  expect(decoded.memory.skills?.[0]?.skill?.procedure).toBe("Run bun test")
  const publicRun = await BrainRunBundle.pack({ ...input, publicRepository: true })
  expect(BrainRunBundle.decode(publicRun).memory.skills).toEqual([])
  expect(publicRun.bytes.toString()).not.toContain("Run bun test")
})

test("posting decisions cover all records and public attachment never happens implicitly", async () => {
  const packed = await BrainRunBundle.pack({ ...input, screen: async (parts) => {
    expect(parts).toHaveLength(2)
    return [false, true]
  } })
  expect(BrainRunBundle.decode(packed).memory.entries).toEqual([])
  await expect(BrainRunBundle.pack({ ...input, includeBrain: false })).rejects.toThrow("explicit")
  await expect(BrainRunBundle.pack({ ...input, ownerStartedDesktop: false })).rejects.toThrow("desktop")
  await expect(BrainRunBundle.pack({ ...input, screen: async () => [] })).rejects.toThrow("every record")
})

test("authenticated imports still reject changed bytes, paths and personal-scope injection", async () => {
  const packed = await BrainRunBundle.pack(input)
  expect(() => BrainRunBundle.decode({ ...packed, bytes: Buffer.from("changed") })).toThrow("manifest")
  expect(() => BrainRunBundle.decode({ ...packed, path: "../../memory.json" })).toThrow("manifest")
  const changed = BrainRunBundle.decode(packed)
  const bytes = Buffer.from(JSON.stringify({ ...changed, memory: { ...changed.memory, entries: [{ ...entry, scope: "personal" }] } }))
  expect(() => BrainRunBundle.decode({ path: BrainRunBundle.PATH, bytes, sha256: createHash("sha256").update(bytes).digest("hex") })).toThrow("invalid")
})

test("workflow transfer removes all prices, token counts and private relative measurements", () => {
  const insights = BrainTransfer.insights({ mode: "apply", explore: false, tiers: [{ tier: "standard", excluded: 0, arms: [{
    arm: { effortTier: "standard", effort: "default", split: "solo", providerID: "vector-plan", modelID: "floor" },
    rows: 10, weight: 10, signal: 10, passRate: 1, checkedShare: 1, pricedWeight: 0, lastAt: 1,
    tokens: 12345, costUsd: 42, codiumUnits: 555, codiumWeight: 10,
  }] }] })
  const text = JSON.stringify(insights)
  expect(text).not.toMatch(/tokens|costUsd|codiumUnits|codiumWeight|12345|555/)
  expect(BrainTransfer.decodeInsights(text)).toEqual(insights)
  expect(BrainTransfer.insightMemory(insights).entries[0]).toMatchObject({ status: "proposed", scope: "repository", kind: "lesson", pinned: false })
})
