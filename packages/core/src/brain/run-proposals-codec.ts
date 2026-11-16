export * as RunProposalsCodec from "./run-proposals-codec"

import { Option, Schema } from "effect"
import { MemoryFileCodec } from "./memory-file-codec"

/** Data-only decoding. The caller authenticates the archive/manifest and verifies its digest before using this DTO. */
export const PATH = "brain/proposals.json"
export const MAX_BYTES = 512 * 1024
export const LIMIT = { entries: 200, skills: 20 } as const
export const File = Schema.Struct({
  format: Schema.Literal("vector-brain-proposals"),
  version: Schema.Literal(1),
  memory: MemoryFileCodec.File,
})
export type File = typeof File.Type
export const ENTRY_KINDS: ReadonlySet<string> = new Set(["decision", "lesson", "fact", "term", "failure"])

export function parse(input: { path: string; bytes: Uint8Array; publicRepository: boolean }): File {
  if (input.path !== PATH || input.bytes.byteLength > MAX_BYTES)
    throw new Error("Returned Brain drafts do not match their manifest.")
  // Match Buffer's UTF-8 decoding, including preserving a leading BOM, without importing a Node runtime.
  const value = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(File))(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(input.bytes),
    ),
  )
  if (
    !value ||
    value.memory.scope !== "repository" ||
    value.memory.documents.length ||
    value.memory.entries.length > LIMIT.entries ||
    (value.memory.skills?.length ?? 0) > LIMIT.skills ||
    (input.publicRepository && value.memory.skills?.length) ||
    [...value.memory.entries, ...(value.memory.skills ?? [])].some(
      (item) => item.scope !== "repository" || item.status !== "proposed" || item.pinned || item.private || item.file,
    ) ||
    value.memory.entries.some((item) => !ENTRY_KINDS.has(item.kind) || item.skill) ||
    value.memory.skills?.some((item) => item.kind !== "skill" || !item.skill)
  )
    throw new Error("Invalid returned repository Brain drafts.")
  return value
}
