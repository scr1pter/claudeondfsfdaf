export * as CloudBrain from "./run-bundle"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainExport } from "@vectordevai/core/brain/export"
import { BrainRunBundle } from "@vectordevai/core/brain/run-bundle"
import { BrainRunProposals } from "@vectordevai/core/brain/run-proposals"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { BrainTransfer } from "@vectordevai/core/brain/transfer"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { Instruction } from "@/session/instruction"
import { SessionMemory } from "@/session/memory"
import { SessionPosting } from "@/session/posting"
import { Session } from "@/session/session"
import { Git } from "@/git"

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

/** The GitHub artifact writer supplies original source/run start from its authenticated live-run record. */
export const proposals = Effect.fn("CloudBrain.proposals")(function* (input: {
  readonly originalSource: "desktop"; readonly startedAt: number; readonly publicRepository: boolean; readonly maxBytes: number
}) {
  if (input.originalSource !== "desktop") return yield* new Refused({ message: "This run was not started with desktop Brain sharing." })
  const instruction = yield* Instruction.Service
  const brain = yield* Brain.Service
  const skills = yield* BrainSkill.Service
  const place = yield* instruction.place()
  if (place.held) return undefined
  const items: BrainExport.Item[] = []
  for (const entry of (yield* brain.list(place, { scope: "repository", filter: "review" })).filter((entry) =>
    entry.status === "proposed" && entry.createdAt >= input.startedAt && !entry.private && !entry.source).slice(0, BrainRunProposals.LIMIT.entries)) {
    const detail = yield* brain.get(place, entry.id, { personal: false })
    items.push({ id: entry.id, scope: entry.scope, kind: entry.kind, status: entry.status, text: entry.text,
      paths: entry.paths, pinned: false, evidence: detail?.evidence ?? [], createdAt: entry.createdAt,
      ...(entry.private ? { private: true } : {}), ...(entry.source ? { file: entry.source.file } : {}) })
  }
  const drafts: BrainExport.Item[] = []
  if (!input.publicRepository) for (const entry of (yield* skills.list(place, "review")).filter((entry) =>
    entry.status === "proposed" && entry.scope === "repository" && entry.createdAt >= input.startedAt && !entry.private && !entry.source).slice(0, BrainRunProposals.LIMIT.skills)) {
    if (!entry.skill) continue
    const detail = yield* skills.get(place, entry.id)
    drafts.push({ id: entry.id, scope: entry.scope, kind: "skill", status: entry.status, text: entry.text,
      paths: entry.paths, pinned: false, evidence: detail?.evidence ?? [], createdAt: entry.createdAt,
      ...(entry.private ? { private: true } : {}),
      skill: { name: entry.skill.name, description: entry.skill.description, procedure: entry.skill.procedure,
        checks: entry.skill.checks, commands: entry.skill.commands, version: entry.skill.version } })
  }
  const memory: BrainExport.File = { format: "vector-memory", version: 1, scope: "repository", exportedAt: Date.now(),
    entries: items, skills: drafts, documents: [] }
  const selected = BrainRunProposals.select({ ...input, memory })
  const checked = yield* SessionPosting.check({ parts: selected.parts, typed: false })
  const dropped = new Set(checked.dropped.map((item) => item.part))
  const allowed = selected.parts.map((part, index) => !dropped.has(index) && checked.parts[index] === part)
  return yield* Effect.tryPromise({ try: () => BrainRunProposals.pack({ ...input, memory, screen: async () => allowed }),
    catch: () => new Refused({ message: "Could not prepare this run's returned Brain drafts." }) })
})

/** The desktop's authenticated artifact adapter calls this only after explicit owner import and local decryption. */
export const importProposals = Effect.fn("CloudBrain.importProposals")(function* (file: {
  readonly path: string; readonly bytes: Uint8Array; readonly sha256: string; readonly publicRepository: boolean
}) {
  if (SessionMemory.agentStarted()) return yield* new Refused({ message: "Review returned Brain proposals from your desktop." })
  const instruction = yield* Instruction.Service
  const brain = yield* Brain.Service
  const skills = yield* BrainSkill.Service
  const decoded = yield* Effect.try({ try: () => BrainRunProposals.decode(file),
    catch: () => new Refused({ message: "Returned Brain drafts do not match this run's authenticated artifact." }) })
  return yield* BrainRunProposals.stage({ brain, skills, place: yield* instruction.place(), file: decoded })
})

/** Only an authenticated archive adapter calls this after checking repository, thread, run and digest approval. */
export const returned = Effect.fn("CloudBrain.returned")(function* (file: {
  readonly path: string; readonly bytes: Uint8Array; readonly sha256: string; readonly publicRepository?: boolean
}) {
  if (SessionMemory.agentStarted()) return yield* new Refused({ message: "Review returned Brain proposals from your desktop." })
  const instruction = yield* Instruction.Service
  const brain = yield* Brain.Service
  const skills = yield* BrainSkill.Service
  if (file.path === BrainRunProposals.PATH) {
    if (typeof file.publicRepository !== "boolean") return yield* new Refused({ message: "Check this repository's current visibility before importing returned drafts." })
    return yield* importProposals({ ...file, publicRepository: file.publicRepository })
  }
  const bundle = yield* Effect.try({ try: () => BrainRunBundle.decode(file), catch: () => new Refused({ message: "This Brain attachment does not match its approved archive." }) })
  return yield* BrainRunBundle.stage({ brain, skills, place: yield* instruction.place(), bundle })
})

export interface Interface {
  readonly preview: (input: Parameters<typeof preview>[0]) => Effect.Effect<
    Effect.Success<ReturnType<typeof preview>>, Effect.Error<ReturnType<typeof preview>>>
  readonly returned: (input: Parameters<typeof returned>[0]) => Effect.Effect<
    Effect.Success<ReturnType<typeof returned>>, Effect.Error<ReturnType<typeof returned>>>
  readonly proposals: (input: Parameters<typeof proposals>[0]) => Effect.Effect<
    Effect.Success<ReturnType<typeof proposals>>, Effect.Error<ReturnType<typeof proposals>>>
  readonly importProposals: (input: Parameters<typeof importProposals>[0]) => Effect.Effect<
    Effect.Success<ReturnType<typeof importProposals>>, Effect.Error<ReturnType<typeof importProposals>>>
}
export class Service extends Context.Service<Service, Interface>()("@vector/CloudBrain") {}
const layer = Layer.effect(Service, Effect.gen(function* () {
  // Capture only stable services once. Request-derived instance/principal references stay in the caller's context.
  const services = Context.make(Instruction.Service, yield* Instruction.Service).pipe(
    Context.add(Brain.Service, yield* Brain.Service),
    Context.add(BrainSkill.Service, yield* BrainSkill.Service),
    Context.add(BrainWorkflow.Service, yield* BrainWorkflow.Service),
    Context.add(BrainKnowledge.Service, yield* BrainKnowledge.Service),
    Context.add(Session.Service, yield* Session.Service),
    Context.add(Git.Service, yield* Git.Service),
  )
  return Service.of({
    preview: (input) => preview(input).pipe(Effect.provideContext(services)),
    returned: (input) => returned(input).pipe(Effect.provideContext(services)),
    proposals: (input) => proposals(input).pipe(Effect.provideContext(services)),
    importProposals: (input) => importProposals(input).pipe(Effect.provideContext(services)),
  })
}))
export const node = LayerNode.make({ service: Service, layer,
  deps: [Instruction.node, Brain.node, BrainSkill.node, BrainWorkflow.node, BrainKnowledge.node, Session.node, Git.node] })
