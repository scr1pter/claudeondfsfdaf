export * as CloudBrain from "./run-bundle"

import { Effect, Schema } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainExport } from "@vectordevai/core/brain/export"
import { BrainRunBundle } from "@vectordevai/core/brain/run-bundle"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { BrainTransfer } from "@vectordevai/core/brain/transfer"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { Instruction } from "@/session/instruction"
import { SessionMemory } from "@/session/memory"
import { SessionPosting } from "@/session/posting"

export class Refused extends Schema.TaggedErrorClass<Refused>()("CloudBrain.Refused", { message: Schema.String }) {}

/** The dispatch owner supplies the repository visibility from GitHub, never from a repository file or model input. */
export const preview = Effect.fn("CloudBrain.preview")(function* (input: {
  readonly ownerStartedDesktop: boolean
  readonly includeBrain: boolean
  readonly publicRepository: boolean
}) {
  if (SessionMemory.agentStarted() || !input.ownerStartedDesktop || !input.includeBrain)
    return yield* new Refused({ message: "Attach Brain explicitly from your desktop before starting this GitHub run." })
  const instruction = yield* Instruction.Service
  const brain = yield* Brain.Service
  const skills = yield* BrainSkill.Service
  const workflow = yield* BrainWorkflow.Service
  const place = yield* instruction.place()
  if (place.held) return yield* new Refused({ message: "Trust this repository before attaching its Brain context." })
  const entries = (yield* brain.list(place, { scope: "repository", filter: "active" })).slice(0, BrainRunBundle.LIMIT.entries)
  const memory: BrainExport.File = { format: "vector-memory", version: 1, scope: "repository", exportedAt: Date.now(), documents: [],
    entries: entries.map((entry) => ({ id: entry.id, scope: entry.scope, kind: entry.kind, status: entry.status,
      text: entry.text, paths: entry.paths, pinned: entry.pinned, evidence: [], createdAt: entry.createdAt,
      ...(entry.private ? { private: true } : {}), ...(entry.source ? { file: entry.source.file } : {}),
    })),
  }
  const shareable: BrainExport.Item[] = []
  if (!input.publicRepository) for (const entry of (yield* skills.list(place, "active")).slice(0, BrainRunBundle.LIMIT.skills)) {
    const checked = yield* skills.shareable(place, entry.id)
    if ("refused" in checked || !checked.entry.skill) continue
    shareable.push({ id: entry.id, scope: "repository", kind: "skill", status: "active", text: entry.text,
      paths: entry.paths, pinned: false, evidence: [], createdAt: entry.createdAt,
      skill: { name: checked.entry.skill.name, description: checked.entry.skill.description,
        procedure: checked.entry.skill.procedure, checks: checked.entry.skill.checks,
        commands: checked.entry.skill.commands, version: checked.entry.skill.version },
    })
  }
  const insights = BrainTransfer.insights(yield* workflow.insights(place))
  // The checker sees one combined post, so private words cannot be split between records.
  const parts = BrainRunBundle.select({ ...input, memory, shareableSkills: shareable, insights }).parts
  const checked = yield* SessionPosting.check({ parts, typed: false })
  const dropped = new Set(checked.dropped.map((item) => item.part))
  const allowed = parts.map((part, index) => !dropped.has(index) && checked.parts[index] === part)
  return yield* Effect.tryPromise({
    try: () => BrainRunBundle.pack({ ...input, memory, shareableSkills: shareable, insights,
      screen: async () => allowed,
    }),
    catch: (error) => new Refused({ message: error instanceof Error ? error.message : "Cannot prepare Brain context." }),
  })
})

/** Only an authenticated archive adapter calls this after checking repository, thread, run and digest approval. */
export const returned = Effect.fn("CloudBrain.returned")(function* (file: {
  readonly path: string; readonly bytes: Uint8Array; readonly sha256: string
}) {
  if (SessionMemory.agentStarted()) return yield* new Refused({ message: "Review returned Brain proposals from your desktop." })
  const instruction = yield* Instruction.Service
  const brain = yield* Brain.Service
  const skills = yield* BrainSkill.Service
  const bundle = yield* Effect.try({ try: () => BrainRunBundle.decode(file), catch: () => new Refused({ message: "This Brain attachment does not match its approved archive." }) })
  return yield* BrainRunBundle.stage({ brain, skills, place: yield* instruction.place(), bundle })
})
