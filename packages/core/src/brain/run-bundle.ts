export * as BrainRunBundle from "./run-bundle"

import { createHash } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import type { Brain } from "./brain"
import { BrainExport } from "./export"
import type { BrainSkill } from "./skill"
import { BrainTransfer } from "./transfer"

export const PATH = "brain/bundle.json"
export const MAX_BYTES = 512 * 1024
export const LIMIT = { entries: 200, skills: 20 } as const
const Bundle = Schema.Struct({
  format: Schema.Literal("vector-brain-run"),
  version: Schema.Literal(1),
  memory: BrainExport.File,
  insights: BrainTransfer.Insights,
})
export type Bundle = typeof Bundle.Type
const memoryKinds = new Set(["decision", "lesson", "fact", "term", "failure"])

export function select(input: {
  readonly publicRepository: boolean; readonly memory: BrainExport.File;
  readonly shareableSkills: readonly BrainExport.Item[]; readonly insights: BrainTransfer.Insights
}) {
  const entries = input.memory.entries.filter((entry) => entry.scope === "repository" && entry.status === "active" &&
    !entry.private && !entry.file && memoryKinds.has(entry.kind)).slice(0, LIMIT.entries)
  const skills = input.publicRepository ? [] : input.shareableSkills.filter((entry) => entry.kind === "skill" &&
    entry.scope === "repository" && entry.status === "active" && !entry.private && !!entry.skill).slice(0, LIMIT.skills)
  const items = [...entries, ...skills]
  const parts = [...items.map((item) => [item.text, ...item.paths,
    ...item.evidence.flatMap((evidence) => [evidence.quote ?? "", evidence.path ?? "", evidence.command ?? ""]),
    ...(item.skill ? [item.skill.name, item.skill.description, item.skill.procedure, ...item.skill.checks, ...item.skill.commands] : []),
  ].join("\n")), ...input.insights.rows.map((row) => `${row.tier}\n${row.model}\n${row.effort}\n${row.split}`)]
  return { entries, skills, parts }
}

/**
 * The owner previews this exact digest before dispatch. `screen` is the engine's posting check, applied to every
 * outgoing memory/skill together so splitting private words across records cannot evade it. No transport happens here.
 */
export async function pack(input: {
  readonly ownerStartedDesktop: boolean
  readonly includeBrain: boolean
  readonly publicRepository: boolean
  readonly memory: BrainExport.File
  readonly shareableSkills: readonly BrainExport.Item[]
  readonly insights: BrainTransfer.Insights
  readonly screen: (parts: readonly string[]) => Promise<readonly boolean[]>
}) {
  if (!input.ownerStartedDesktop || !input.includeBrain) throw new Error("Brain attachment needs the owner's explicit desktop request.")
  const { entries, skills, parts } = select(input)
  const items = [...entries, ...skills]
  const allowed = await input.screen(parts)
  if (allowed.length !== parts.length) throw new Error("The Brain posting check did not cover every record.")
  const memory: BrainExport.File = {
    format: "vector-memory", version: 1, scope: "repository", exportedAt: input.memory.exportedAt,
    entries: entries.filter((_, index) => allowed[index] === true), documents: [],
    skills: skills.filter((_, index) => allowed[entries.length + index] === true),
  }
  // Re-encode through the schema so an export cannot smuggle unrelated sections into the attachment.
  const insights = { ...input.insights, rows: input.insights.rows.filter((_, index) => allowed[items.length + index] === true) }
  const bundle = Schema.encodeSync(Bundle)({ format: "vector-brain-run", version: 1, memory, insights })
  const bytes = Buffer.from(JSON.stringify(bundle))
  if (bytes.byteLength > MAX_BYTES) throw new Error("The selected Brain attachment exceeds 512 KiB.")
  return { path: PATH, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), entries: memory.entries.length, skills: memory.skills?.length ?? 0 }
}

/** Call only after authenticated archive decryption and manifest approval verification; this repeats digest/size checks. */
export function decode(input: { readonly path: string; readonly bytes: Uint8Array; readonly sha256: string }) {
  if (input.path !== PATH || input.bytes.byteLength > MAX_BYTES ||
    !/^[a-f0-9]{64}$/.test(input.sha256) || createHash("sha256").update(input.bytes).digest("hex") !== input.sha256)
    throw new Error("The Brain attachment does not match its approved manifest.")
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Bundle))(Buffer.from(input.bytes).toString("utf8")))
  if (!decoded || decoded.memory.scope !== "repository" || decoded.memory.entries.length > LIMIT.entries ||
    (decoded.memory.skills?.length ?? 0) > LIMIT.skills || decoded.memory.documents.length ||
    decoded.memory.entries.some((entry) => entry.scope !== "repository" || !memoryKinds.has(entry.kind)) ||
    decoded.memory.skills?.some((entry) => entry.scope !== "repository" || entry.kind !== "skill"))
    throw new Error("The Brain attachment is invalid.")
  return decoded
}

/** Returned cloud content remains proposals, including insights; no approval, pin or learner statistics are imported. */
export const stage = Effect.fn("BrainRunBundle.stage")(function* (input: {
  readonly brain: Brain.Interface
  readonly skills: BrainSkill.Interface
  readonly place: Brain.Place
  readonly bundle: Bundle
}) {
  const memory = yield* BrainExport.importText({ ...input, text: JSON.stringify(input.bundle.memory) })
  const insights = yield* BrainExport.importText({ ...input, text: JSON.stringify(BrainTransfer.insightMemory(input.bundle.insights)) })
  return { memory, insights }
})
