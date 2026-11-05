export * as VaultMemory from "./vault-memory"

import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainExport } from "@vectordevai/core/brain/export"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { Project as ProjectV2 } from "@vectordevai/core/project"
import { Project } from "@/project/project"
import { Instruction } from "@/session/instruction"

// Brain Vault's memory (contracts A43 and A45): what a backup holds and how a restore puts it back, shared by
// `vector vault` and the desktop's backup, which reads and restores through the owner-only routes GET /memory/backup
// and POST /memory/restore. A backup holds the person's own memory and each repository's that has learned entries,
// each as the `vector-memory` export JSON. A restore goes through the brain's own writes (BrainExport.restore), never
// a copy of brain.db, and brings back as in use and pinned what the backup had in use and pinned.

/** One memory file of a backup. `repository` is "" for the person's own memory. */
export type File = {
  readonly path: string
  readonly section: "memory"
  readonly text: string
  readonly repository: string
  readonly worktree?: string
}

/** The services a backup and a restore read and write through, as the CLI and the server's handlers hold them. */
export type Services = {
  readonly instruction: Instruction.Interface
  readonly brain: Brain.Interface
  readonly knowledge: BrainKnowledge.Interface
  readonly projects: Project.Interface
}

/** The services from the context, for a caller that does not hold them already (the CLI). */
export const services = Effect.fnUntraced(function* () {
  return {
    instruction: yield* Instruction.Service,
    brain: yield* Brain.Service,
    knowledge: yield* BrainKnowledge.Service,
    projects: yield* Project.Service,
  } satisfies Services
})

/** This computer's memory as backup files: the person's own, then each repository Vector knows that has any. */
export const files = Effect.fnUntraced(function* (input: Services) {
  const { instruction, brain, knowledge, projects } = input
  const here = yield* instruction.place()
  const json = (file: BrainExport.File) => JSON.stringify(Schema.encodeSync(BrainExport.File)(file))
  const out: File[] = []
  const personal = yield* BrainExport.collect({ brain, knowledge, place: here, scope: "personal" })
  if (personal.entries.length)
    out.push({ path: "memory/personal.json", section: "memory", text: json(personal), repository: "" })
  const places: Brain.Place[] = [
    here,
    ...(yield* projects.list())
      .filter((project) => project.id !== ProjectV2.ID.global && project.id !== here.repository)
      .map((project) => ({ repository: project.id, root: project.worktree, sources: [], held: false })),
  ]
  for (const place of places) {
    const file = yield* BrainExport.collect({ brain, knowledge, place, scope: "repository" })
    if (!file.entries.some((entry) => !entry.file)) continue
    out.push({
      path: `memory/repository-${createHash("sha256").update(place.repository).digest("hex").slice(0, 24)}.json`,
      section: "memory",
      text: json(file),
      repository: place.repository,
      worktree: place.root,
    })
  }
  return { files: out, here }
})

/** What restoring one memory file did; `unreadable` when it is not a memory file this version of Vector reads. */
export type Restored =
  | (BrainExport.Restored & { readonly unreadable: false; readonly documents: number })
  | { readonly unreadable: true }

/**
 * Restores one memory file of the person's own vault. Their own memory and this repository's land here; another
 * repository's under its own id, which is where Vector finds it once that repository is opened on this computer.
 */
export const restore = Effect.fnUntraced(function* (
  services: Pick<Services, "instruction" | "brain">,
  input: { readonly text: string; readonly repository?: string; readonly worktree?: string },
) {
  const memory = BrainExport.decodeBackup(input.text)
  if (!memory || input.repository === undefined) return { unreadable: true } satisfies Restored
  const { instruction, brain } = services
  const here = yield* instruction.place()
  const place: Brain.Place =
    input.repository === "" || input.repository === here.repository
      ? here
      : { repository: input.repository, root: input.worktree ?? here.root, sources: [], held: false }
  const done = yield* BrainExport.restore({ brain, place, file: memory, trust: "vault" })
  return { ...done, unreadable: false, documents: memory.documents.length } satisfies Restored
})
