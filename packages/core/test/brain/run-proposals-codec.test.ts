import { expect, test } from "bun:test"
import { RunProposalsCodec } from "../../src/brain/run-proposals-codec"

const memory = () => ({
  format: "vector-memory",
  version: 1,
  scope: "repository",
  exportedAt: 30,
  documents: [],
  entries: [
    {
      id: "proposal",
      scope: "repository",
      kind: "lesson",
      status: "proposed",
      text: "Keep the focused test",
      paths: [],
      pinned: false,
      evidence: [],
      createdAt: 20,
    },
  ],
  skills: [],
})
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const decode = (value: unknown) =>
  RunProposalsCodec.parse({ path: RunProposalsCodec.PATH, bytes: bytes(value), publicRepository: false })

test("the standalone data codec preserves proposed-only records without loading Brain services", () => {
  const result = decode({ format: "vector-brain-proposals", version: 1, memory: memory() })
  expect(result.memory.entries[0]?.status).toBe("proposed")
  expect(result.memory.entries[0]?.pinned).toBe(false)
})
test("personal, active, pinned, private and mirrored proposals cannot enter an owner preview", () => {
  for (const change of [
    { scope: "personal" },
    { status: "active" },
    { pinned: true },
    { private: true },
    { file: "MEMORY.md" },
  ]) {
    const value = memory()
    Object.assign(value.entries[0]!, change)
    expect(() => decode({ format: "vector-brain-proposals", version: 1, memory: value })).toThrow("Invalid")
  }
})
test("the standalone codec refuses non-proposal paths, oversize input and a leading BOM like the original Node decoder", () => {
  const good = bytes({ format: "vector-brain-proposals", version: 1, memory: memory() })
  expect(() => RunProposalsCodec.parse({ path: "brain/bundle.json", bytes: good, publicRepository: false })).toThrow(
    "manifest",
  )
  expect(() =>
    RunProposalsCodec.parse({
      path: RunProposalsCodec.PATH,
      bytes: new Uint8Array(RunProposalsCodec.MAX_BYTES + 1),
      publicRepository: false,
    }),
  ).toThrow("manifest")
  expect(() =>
    RunProposalsCodec.parse({
      path: RunProposalsCodec.PATH,
      bytes: Uint8Array.from([239, 187, 191, ...good]),
      publicRepository: false,
    }),
  ).toThrow("Invalid")
})
