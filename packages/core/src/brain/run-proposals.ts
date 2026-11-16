export * as BrainRunProposals from "./run-proposals"

import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type { Brain } from "./brain"
import { BrainExport } from "./export"
import type { BrainSkill } from "./skill"

import { File, PATH, MAX_BYTES, LIMIT, RunProposalsCodec } from "./run-proposals-codec"

export { File, PATH, MAX_BYTES, LIMIT } from "./run-proposals-codec"
const kinds = RunProposalsCodec.ENTRY_KINDS
const parts = (items: readonly BrainExport.Item[]) =>
  items.map((item) =>
    [
      item.text,
      ...item.paths,
      ...item.evidence.flatMap((evidence) => [evidence.path ?? "", evidence.quote ?? "", evidence.command ?? ""]),
      ...(item.skill
        ? [item.skill.name, item.skill.description, item.skill.procedure, ...item.skill.checks, ...item.skill.commands]
        : []),
    ].join("\n"),
  )

/** Only proposed records created during this run, without docs, private material, file mirrors, pins, or live stats. */
export function select(input: { memory: BrainExport.File; startedAt: number; publicRepository: boolean }) {
  const eligible = (item: BrainExport.Item) =>
    item.scope === "repository" &&
    item.status === "proposed" &&
    item.createdAt >= input.startedAt &&
    !item.private &&
    !item.file
  const entries = input.memory.entries
    .filter((item) => eligible(item) && kinds.has(item.kind) && !item.skill)
    .slice(0, LIMIT.entries)
  const skills = input.publicRepository
    ? []
    : (input.memory.skills ?? [])
        .filter((item) => eligible(item) && item.kind === "skill" && item.skill)
        .slice(0, LIMIT.skills)
  return { entries, skills, parts: parts([...entries, ...skills]) }
}

/** The authenticated artifact adapter supplies remaining budget after the immutable initial attachment. */
export async function pack(input: {
  memory: BrainExport.File
  startedAt: number
  publicRepository: boolean
  maxBytes: number
  screen: (parts: readonly string[]) => Promise<readonly boolean[]>
}) {
  if (
    !Number.isSafeInteger(input.startedAt) ||
    input.startedAt <= 0 ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 0 ||
    input.maxBytes > MAX_BYTES
  )
    throw new Error("Invalid returned Brain proposal budget or run start.")
  if (input.maxBytes === 0) return undefined
  const selected = select(input)
  if (!selected.entries.length && !selected.skills.length) return undefined
  const allowed = await input.screen(selected.parts)
  if (allowed.length !== selected.parts.length)
    throw new Error("The Brain posting check did not cover every returned draft.")
  const memory: BrainExport.File = {
    format: "vector-memory",
    version: 1,
    scope: "repository",
    exportedAt: input.memory.exportedAt,
    documents: [],
    entries: selected.entries.filter((_, index) => allowed[index] === true).map((item) => ({ ...item, pinned: false })),
    skills: selected.skills
      .filter((_, index) => allowed[selected.entries.length + index] === true)
      .map((item) => ({ ...item, pinned: false })),
  }
  if (!memory.entries.length && !memory.skills?.length) return undefined
  const file = Schema.encodeSync(File)({ format: "vector-brain-proposals", version: 1, memory })
  const bytes = Buffer.from(JSON.stringify(file))
  if (bytes.byteLength > input.maxBytes) return undefined
  return {
    path: PATH,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    entries: memory.entries.length,
    skills: memory.skills?.length ?? 0,
  }
}

/** Call after archive authentication, total budget, repository/thread/run provenance and current visibility checks. */
export function decode(input: { path: string; bytes: Uint8Array; sha256: string; publicRepository: boolean }): File {
  if (
    input.path !== PATH ||
    input.bytes.byteLength > MAX_BYTES ||
    !/^[0-9a-f]{64}$/.test(input.sha256) ||
    createHash("sha256").update(input.bytes).digest("hex") !== input.sha256
  )
    throw new Error("Returned Brain drafts do not match their manifest.")
  return RunProposalsCodec.parse(input)
}

/** Incoming model-written drafts pass through the existing proposal/secret/hold gates, with no approval or stats. */
export const stage = Effect.fn("BrainRunProposals.stage")(function* (input: {
  brain: Brain.Interface
  skills: BrainSkill.Interface
  place: Brain.Place
  file: File
}) {
  return yield* BrainExport.importText({ ...input, text: JSON.stringify(input.file.memory) })
})
