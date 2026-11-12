import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { ReviewMemoryControl } from "../src/index"

const scope = `vrs1_${"a".repeat(64)}`
const citation: ReviewMemoryControl.Citation = {
  path: "src/parser.ts",
  line: 7,
  head: "b".repeat(40),
  quote: 'return "quoted value"\n',
}
const draft = {
  text: "Prefer explicit early returns.",
  paths: ["src/*"],
  citations: [citation],
  reason: "Keep the reviewed condition visible.",
  visibility: "repository" as const,
}
const record: ReviewMemoryControl.Record = { ...draft, action: "record", expected: 4, kind: "check" }
const proposed: ReviewMemoryControl.ProposedEntry = {
  ...draft,
  id: "vr_proposed",
  kind: "outcome",
  origin: "review",
  status: "proposed",
  source: { parentID: "ses_parent", reviewID: "ses_review", head: citation.head },
  createdAt: 1,
  updatedAt: 2,
}
const owner: ReviewMemoryControl.OwnerEntry = {
  ...draft,
  id: "vr_owner",
  kind: "preference",
  origin: "owner",
  status: "active",
  approvedBy: "http-owner:actor",
  approvedAt: 3,
  createdAt: 1,
  updatedAt: 3,
}
const approved: ReviewMemoryControl.ApprovedEntry = {
  ...proposed,
  status: "active",
  approvedBy: "http-owner:actor",
  approvedAt: 3,
}
const common = {
  previewId: "01234567-89ab-4cde-8fab-0123456789ab",
  sha256: "c".repeat(64),
  expiresAt: 120_001,
  repository: "repository_1",
  scope,
  expected: 4,
}
const previews: ReviewMemoryControl.Preview[] = [
  { ...common, operation: "configure", payload: { expected: 4, enabled: true } },
  { ...common, operation: "record", payload: { ...draft, expected: 4, kind: "check" } },
  { ...common, operation: "approve", payload: { expected: 4, id: proposed.id, entry: proposed } },
  { ...common, operation: "forget", payload: { expected: 4, id: owner.id } },
  { ...common, operation: "erase", payload: { expected: 4 } },
]

describe("review-memory public wire contracts", () => {
  test("the root namespace exports the canonical schemas", async () => {
    const direct = await import("../src/review-memory")
    expect(ReviewMemoryControl.Prepare).toBe(direct.Prepare)
    expect(ReviewMemoryControl.Preview).toBe(direct.Preview)
  })

  test("prepare requires the displayed scope and rejects extra authority at every request depth", () => {
    const decode = Schema.decodeUnknownOption(ReviewMemoryControl.Prepare)
    const valid = { expectedScope: scope, command: record }
    expect(Option.isSome(decode(valid))).toBe(true)
    expect(Option.isNone(decode({ command: record }))).toBe(true)
    for (const field of ["root", "repository", "scope", "owner", "approved", "source", "readDenies", "model"])
      expect(Option.isNone(decode({ ...valid, [field]: "forged" }))).toBe(true)
    for (const field of ["root", "source", "approvedBy", "approvedAt", "owner", "scope", "operation"])
      expect(Option.isNone(decode({ ...valid, command: { ...record, [field]: "forged" } }))).toBe(true)
    expect(
      Option.isNone(
        decode({ ...valid, command: { ...record, citations: [{ ...citation, directory: "/unrelated" }] } }),
      ),
    ).toBe(true)
    expect(Option.isNone(decode({ ...valid, command: { ...record, kind: "outcome" } }))).toBe(true)
    expect(Option.isNone(decode({ ...valid, command: { action: "erase-review", expected: 4 } }))).toBe(true)
    expect(Option.isNone(decode({ ...valid, command: { action: "inspect", expected: 4 } }))).toBe(true)
    expect(Option.isNone(decode({ ...valid, command: { ...record, visibility: "public" } }))).toBe(true)
  })

  test("typed operation previews round-trip complete quoted drafts and source provenance without opaque payloads", () => {
    const wire = Schema.fromJsonString(ReviewMemoryControl.Preview)
    for (const preview of previews) {
      const json = Schema.encodeSync(wire)(preview)
      expect(Schema.decodeUnknownSync(wire)(json)).toEqual(preview)
      expect(
        Option.isNone(Schema.decodeUnknownOption(ReviewMemoryControl.Preview)({ ...preview, root: "/private" })),
      ).toBe(true)
      expect(
        Option.isNone(
          Schema.decodeUnknownOption(ReviewMemoryControl.Preview)({
            ...preview,
            payload: { ...preview.payload, owner: true },
          }),
        ),
      ).toBe(true)
    }
    const decode = Schema.decodeUnknownOption(ReviewMemoryControl.Preview)
    expect(Option.isNone(decode({ ...common, operation: "record", payload: { expected: 4, enabled: true } }))).toBe(
      true,
    )
    expect(
      Option.isNone(
        decode({
          ...common,
          operation: "approve",
          payload: { expected: 4, id: proposed.id, entry: { ...proposed, source: { ...proposed.source, root: "/x" } } },
        }),
      ),
    ).toBe(true)
    expect(
      Option.isNone(
        decode({ ...common, operation: "erase", payload: { expected: 4 }, sha256: "sha256:" + common.sha256 }),
      ),
    ).toBe(true)
  })

  test("entries distinguish owner records, pending outcomes and approved outcomes", () => {
    const decode = Schema.decodeUnknownOption(ReviewMemoryControl.Entry)
    for (const value of [owner, proposed, approved]) expect(Option.isSome(decode(value))).toBe(true)
    for (const value of [
      { ...owner, source: proposed.source },
      { ...owner, kind: "outcome" },
      { ...owner, status: "proposed" },
      { ...proposed, approvedBy: "forged" },
      { ...proposed, approvedAt: 3 },
      { ...proposed, status: "active" },
      { ...approved, source: undefined },
      { ...approved, approvedAt: Infinity },
      { ...proposed, source: { ...proposed.source, approved: true } },
      { ...proposed, citations: [{ ...citation, source: proposed.source }] },
    ])
      expect(Option.isNone(decode(value))).toBe(true)
    const result = Schema.decodeUnknownOption(ReviewMemoryControl.ConfirmationResult)
    expect(Option.isSome(result({ enabled: false, generation: 4 }))).toBe(true)
    expect(Option.isSome(result(approved))).toBe(true)
    expect(Option.isNone(result({ enabled: false, generation: 4, owner: true }))).toBe(true)
  })

  test("confirmation accepts only the opaque preview handle and displayed digest", () => {
    const decode = Schema.decodeUnknownOption(ReviewMemoryControl.Confirmation)
    const value = { previewId: common.previewId, approvedSha256: common.sha256 }
    expect(Option.isSome(decode(value))).toBe(true)
    for (const field of ["expectedScope", "command", "payload", "approved", "root", "owner", "scope"])
      expect(Option.isNone(decode({ ...value, [field]: true }))).toBe(true)
    expect(Option.isNone(decode({ ...value, previewId: "-".repeat(36) }))).toBe(true)
    expect(Option.isNone(decode({ ...value, approvedSha256: "c".repeat(63) }))).toBe(true)
  })

  test("generations, page bounds and root-free inspection fail closed on malformed numbers or nested fields", () => {
    const number = Schema.decodeUnknownOption(ReviewMemoryControl.Generation)
    expect(Option.isSome(number(Number.MAX_SAFE_INTEGER - 1))).toBe(true)
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER, NaN, Infinity])
      expect(Option.isNone(number(value))).toBe(true)
    const input = Schema.decodeUnknownOption(ReviewMemoryControl.InspectInput)
    expect(Option.isSome(input({ offset: 200, limit: 50 }))).toBe(true)
    for (const value of [{ offset: -1 }, { offset: 201 }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { root: "/x" }])
      expect(Option.isNone(input(value))).toBe(true)
    const page = { repository: common.repository, scope, state: { enabled: true, generation: 4, entries: [owner] } }
    const output = Schema.decodeUnknownOption(ReviewMemoryControl.Inspect)
    expect(Option.isSome(output(page))).toBe(true)
    expect(Option.isSome(output({ ...page, state: { ...page.state, entries: Array(50).fill(owner) } }))).toBe(true)
    for (const value of [
      { ...page, root: "/x" },
      { ...page, state: { ...page.state, root: "/x" } },
      { ...page, state: { ...page.state, entries: [{ ...owner, root: "/x" }] } },
      { ...page, state: { ...page.state, entries: Array(51).fill(owner) } },
      { ...page, next: 201 },
    ])
      expect(Option.isNone(output(value))).toBe(true)
  })

  test("optional properties omit undefined while text, paths, citations and identifiers retain finite bounds", () => {
    expect(Schema.encodeSync(ReviewMemoryControl.InspectInput)({ offset: undefined, limit: undefined })).toEqual({})
    const page: ReviewMemoryControl.Inspect = {
      repository: common.repository,
      scope,
      state: { enabled: false, generation: 0, entries: [] },
      next: undefined,
    }
    expect(Schema.encodeSync(ReviewMemoryControl.Inspect)(page)).not.toHaveProperty("next")
    const decode = Schema.decodeUnknownOption(ReviewMemoryControl.Command)
    for (const value of [
      { ...record, text: "x".repeat(1_001) },
      { ...record, reason: "x".repeat(501) },
      { ...record, paths: [] },
      { ...record, paths: Array(17).fill("src/a.ts") },
      { ...record, citations: Array(9).fill(citation) },
      { ...record, citations: [{ ...citation, quote: "x".repeat(501) }] },
      { ...record, citations: [{ ...citation, line: 10_000_001 }] },
      { action: "approve", expected: 0, id: "x".repeat(257) },
      { action: "forget", expected: 0, id: "with spaces" },
    ])
      expect(Option.isNone(decode(value))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(ReviewMemoryControl.Scope)("vrs1_" + "a".repeat(63)))).toBe(true)
    // Shape validation deliberately does not replace Core's path/business checks.
    expect(Option.isSome(decode({ ...record, paths: ["../not-authorized-by-this-schema"] }))).toBe(true)
  })
})
