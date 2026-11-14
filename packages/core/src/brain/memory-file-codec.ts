export * as MemoryFileCodec from "./memory-file-codec"

import { Schema } from "effect"
import { BrainSchema } from "./schema"

/** One entry as an export carries it. */
export const Item = Schema.Struct({
  id: Schema.String,
  scope: BrainSchema.Scope,
  kind: BrainSchema.Kind,
  status: BrainSchema.Status,
  text: Schema.String,
  facet: Schema.optional(BrainSchema.Facet),
  paths: Schema.Array(Schema.String),
  pinned: Schema.Boolean,
  private: Schema.optional(Schema.Boolean),
  /** The file the entry mirrors, for rules and MEMORY.md, which an import leaves alone. */
  file: Schema.optional(Schema.String),
  evidence: Schema.Array(BrainSchema.Evidence),
  createdAt: Schema.Finite,
  /** A learned skill's text, never what failed last time. */
  skill: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      procedure: Schema.String,
      checks: Schema.Array(Schema.String),
      commands: Schema.Array(Schema.String),
      version: Schema.Finite,
    }),
  ),
}).annotate({ identifier: "MemoryExportItem" })
export type Item = typeof Item.Type

/** A document and the records Vector read from it; never its file, which is the user's own to keep. */
export const Document = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  format: BrainSchema.Format,
  origin: BrainSchema.DocumentOrigin,
  visibility: BrainSchema.Visibility,
  status: BrainSchema.DocumentStatus,
  version: Schema.Finite,
  pages: Schema.optional(Schema.Finite),
  records: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: BrainSchema.RecordKind,
      card: Schema.String,
      page: Schema.optional(Schema.Finite),
    }),
  ),
}).annotate({ identifier: "MemoryExportDocument" })
export type Document = typeof Document.Type

export const File = Schema.Struct({
  format: Schema.Literal("vector-memory"),
  version: Schema.Literal(1),
  scope: Schema.Literals(["personal", "repository", "all"]),
  exportedAt: Schema.Finite,
  entries: Schema.Array(Item),
  documents: Schema.Array(Document),
  /**
   * Learned skills, apart from `entries`: 1.99.111 and older decode the whole file with their own kinds and evidence
   * types, which have no "skill" and no "run", and import nothing from a file they cannot decode. They ignore a key
   * they do not know, so their entries still come in. Files this branch wrote with skills in `entries` still import.
   */
  skills: Schema.optional(Schema.Array(Item)),
}).annotate({ identifier: "MemoryExportFile" })
export type File = typeof File.Type
