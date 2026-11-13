export * as ReviewMemoryControl from "./review-memory"

import { Schema, Struct } from "effect"
import { optional } from "./schema"

// Wire bounds never replace owner, filesystem, path or source validation.
export const LIMIT = Object.freeze({
  records: 200,
  body: 1_000,
  reason: 500,
  paths: 16,
  citations: 8,
  quote: 500,
  page: 50,
  ttl: 120_000,
})
const strict = { onExcessProperty: "error" } as const
const text = (maximum: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

export const Generation = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThan(Number.MAX_SAFE_INTEGER),
).annotate({ identifier: "ReviewMemoryControl.Generation" })
export type Generation = typeof Generation.Type

export const Scope = Schema.String.check(Schema.isPattern(/^vrs1_[0-9a-f]{64}$/)).annotate({
  identifier: "ReviewMemoryControl.Scope",
})
export type Scope = typeof Scope.Type

export const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9:_-]{1,256}$/)).annotate({
  identifier: "ReviewMemoryControl.ID",
})
export type ID = typeof ID.Type

export const Head = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)).annotate({
  identifier: "ReviewMemoryControl.Head",
})
export type Head = typeof Head.Type

export const PreviewID = Schema.String.check(Schema.isUUID()).annotate({ identifier: "ReviewMemoryControl.PreviewID" })
export type PreviewID = typeof PreviewID.Type

export const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).annotate({
  identifier: "ReviewMemoryControl.Sha256",
})
export type Sha256 = typeof Sha256.Type

export const Timestamp = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThan(Number.MAX_SAFE_INTEGER),
).annotate({ identifier: "ReviewMemoryControl.Timestamp" })
export type Timestamp = typeof Timestamp.Type

export const Citation = Schema.Struct({
  path: text(512),
  line: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10_000_000)),
  head: Head,
  quote: text(LIMIT.quote),
}).annotate({ identifier: "ReviewMemoryControl.Citation", parseOptions: strict })
export interface Citation extends Schema.Schema.Type<typeof Citation> {}

// The engine independently proves that these bounded provenance strings name
// a retained source. Decoding them never looks up sessions or grants access.
export const Source = Schema.Struct({ parentID: ID, reviewID: ID, head: Head }).annotate({
  identifier: "ReviewMemoryControl.Source",
  parseOptions: strict,
})
export interface Source extends Schema.Schema.Type<typeof Source> {}

const draft = {
  text: text(LIMIT.body),
  paths: Schema.Array(text(512)).check(Schema.isMinLength(1), Schema.isMaxLength(LIMIT.paths)),
  citations: Schema.Array(Citation).check(Schema.isMaxLength(LIMIT.citations)),
  reason: text(LIMIT.reason),
  visibility: Schema.Literals(["private", "repository"]),
}
const entry = { ...draft, id: ID, createdAt: Timestamp, updatedAt: Timestamp }
const approval = { approvedBy: ID, approvedAt: Timestamp.check(Schema.isGreaterThan(0)) }

export const OwnerEntry = Schema.Struct({
  ...entry,
  ...approval,
  kind: Schema.Literals(["preference", "check"]),
  origin: Schema.Literal("owner"),
  status: Schema.Literal("active"),
}).annotate({ identifier: "ReviewMemoryControl.OwnerEntry", parseOptions: strict })
export interface OwnerEntry extends Schema.Schema.Type<typeof OwnerEntry> {}

export const ProposedEntry = Schema.Struct({
  ...entry,
  kind: Schema.Literal("outcome"),
  origin: Schema.Literal("review"),
  status: Schema.Literal("proposed"),
  source: Source,
}).annotate({ identifier: "ReviewMemoryControl.ProposedEntry", parseOptions: strict })
export interface ProposedEntry extends Schema.Schema.Type<typeof ProposedEntry> {}

export const ApprovedEntry = Schema.Struct({
  ...entry,
  ...approval,
  kind: Schema.Literal("outcome"),
  origin: Schema.Literal("review"),
  status: Schema.Literal("active"),
  source: Source,
}).annotate({ identifier: "ReviewMemoryControl.ApprovedEntry", parseOptions: strict })
export interface ApprovedEntry extends Schema.Schema.Type<typeof ApprovedEntry> {}

export const Entry = Schema.Union([OwnerEntry, ProposedEntry, ApprovedEntry]).annotate({
  identifier: "ReviewMemoryControl.Entry",
})
export type Entry = typeof Entry.Type

export const State = Schema.Struct({ enabled: Schema.Boolean, generation: Generation }).annotate({
  identifier: "ReviewMemoryControl.State",
  parseOptions: strict,
})
export interface State extends Schema.Schema.Type<typeof State> {}

export const Configure = Schema.Struct({
  action: Schema.Literal("configure"),
  expected: Generation,
  enabled: Schema.Boolean,
}).annotate({ identifier: "ReviewMemoryControl.Configure", parseOptions: strict })
export interface Configure extends Schema.Schema.Type<typeof Configure> {}

export const Record = Schema.Struct({
  ...draft,
  action: Schema.Literal("record"),
  expected: Generation,
  kind: Schema.Literals(["preference", "check"]),
}).annotate({ identifier: "ReviewMemoryControl.Record", parseOptions: strict })
export interface Record extends Schema.Schema.Type<typeof Record> {}

export const Approve = Schema.Struct({ action: Schema.Literal("approve"), expected: Generation, id: ID }).annotate({
  identifier: "ReviewMemoryControl.Approve",
  parseOptions: strict,
})
export interface Approve extends Schema.Schema.Type<typeof Approve> {}

export const Reopen = Schema.Struct({
  action: Schema.Literal("reopen"),
  expected: Generation,
  id: ID,
  reason: text(LIMIT.reason).check(Schema.isPattern(/\S/)),
}).annotate({ identifier: "ReviewMemoryControl.Reopen", parseOptions: strict })
export interface Reopen extends Schema.Schema.Type<typeof Reopen> {}

export const Forget = Schema.Struct({ action: Schema.Literal("forget"), expected: Generation, id: ID }).annotate({
  identifier: "ReviewMemoryControl.Forget",
  parseOptions: strict,
})
export interface Forget extends Schema.Schema.Type<typeof Forget> {}

export const Erase = Schema.Struct({ action: Schema.Literal("erase"), expected: Generation }).annotate({
  identifier: "ReviewMemoryControl.Erase",
  parseOptions: strict,
})
export interface Erase extends Schema.Schema.Type<typeof Erase> {}

export const Command = Schema.Union([Configure, Record, Approve, Reopen, Forget, Erase]).annotate({
  identifier: "ReviewMemoryControl.Command",
})
export type Command = typeof Command.Type

/** An equality selector for the displayed scope; the server derives authority independently. */
export const Prepare = Schema.Struct({ expectedScope: Scope, command: Command }).annotate({
  identifier: "ReviewMemoryControl.Prepare",
  parseOptions: strict,
})
export interface Prepare extends Schema.Schema.Type<typeof Prepare> {}

export const Confirmation = Schema.Struct({ previewId: PreviewID, approvedSha256: Sha256 }).annotate({
  identifier: "ReviewMemoryControl.Confirmation",
  parseOptions: strict,
})
export interface Confirmation extends Schema.Schema.Type<typeof Confirmation> {}

const offset = Generation.check(Schema.isLessThanOrEqualTo(LIMIT.records))
export const InspectInput = Schema.Struct({
  offset: optional(offset),
  limit: optional(Generation.check(Schema.isBetween({ minimum: 1, maximum: LIMIT.page }))),
}).annotate({ identifier: "ReviewMemoryControl.InspectInput", parseOptions: strict })
export interface InspectInput extends Schema.Schema.Type<typeof InspectInput> {}

export const Inspect = Schema.Struct({
  repository: ID,
  scope: Scope,
  state: Schema.Struct({
    ...State.fields,
    entries: Schema.Array(Entry).check(Schema.isMaxLength(LIMIT.page)),
  }).annotate({ parseOptions: strict }),
  next: optional(offset),
}).annotate({ identifier: "ReviewMemoryControl.Inspect", parseOptions: strict })
export interface Inspect extends Schema.Schema.Type<typeof Inspect> {}

const preview = {
  previewId: PreviewID,
  sha256: Sha256,
  expiresAt: Timestamp,
  repository: ID,
  scope: Scope,
  expected: Generation,
}
export const ConfigurePreview = Schema.Struct({
  ...preview,
  operation: Schema.Literal("configure"),
  payload: Schema.Struct(Struct.omit(Configure.fields, ["action"])).annotate({ parseOptions: strict }),
}).annotate({ identifier: "ReviewMemoryControl.ConfigurePreview", parseOptions: strict })
export interface ConfigurePreview extends Schema.Schema.Type<typeof ConfigurePreview> {}

export const RecordPreview = Schema.Struct({
  ...preview,
  operation: Schema.Literal("record"),
  payload: Schema.Struct(Struct.omit(Record.fields, ["action"])).annotate({ parseOptions: strict }),
}).annotate({ identifier: "ReviewMemoryControl.RecordPreview", parseOptions: strict })
export interface RecordPreview extends Schema.Schema.Type<typeof RecordPreview> {}

export const ApprovePreview = Schema.Struct({
  ...preview,
  operation: Schema.Literal("approve"),
  payload: Schema.Struct({ expected: Generation, id: ID, entry: ProposedEntry }).annotate({ parseOptions: strict }),
}).annotate({ identifier: "ReviewMemoryControl.ApprovePreview", parseOptions: strict })
export interface ApprovePreview extends Schema.Schema.Type<typeof ApprovePreview> {}

export const ReopenPreview = Schema.Struct({
  ...preview,
  operation: Schema.Literal("reopen"),
  payload: Schema.Struct({
    ...Struct.omit(Reopen.fields, ["action"]),
    entry: ApprovedEntry,
  }).annotate({ parseOptions: strict }),
})
  // Effect attaches annotations after .check() to the last filter; keep the public identifier on the record AST.
  .annotate({ identifier: "ReviewMemoryControl.ReopenPreview", parseOptions: strict })
  .check(
    Schema.makeFilter(
      (value: { expected: Generation; payload: { expected: Generation; id: ID; entry: ApprovedEntry } }) =>
        value.expected === value.payload.expected && value.payload.id === value.payload.entry.id,
      { description: "The displayed generation and selected ID match the complete original approved outcome." },
    ),
  )
  .annotate({ parseOptions: strict })
export interface ReopenPreview extends Schema.Schema.Type<typeof ReopenPreview> {}

export const ForgetPreview = Schema.Struct({
  ...preview,
  operation: Schema.Literal("forget"),
  payload: Schema.Struct(Struct.omit(Forget.fields, ["action"])).annotate({ parseOptions: strict }),
}).annotate({ identifier: "ReviewMemoryControl.ForgetPreview", parseOptions: strict })
export interface ForgetPreview extends Schema.Schema.Type<typeof ForgetPreview> {}

export const ErasePreview = Schema.Struct({
  ...preview,
  operation: Schema.Literal("erase"),
  payload: Schema.Struct(Struct.omit(Erase.fields, ["action"])).annotate({ parseOptions: strict }),
}).annotate({ identifier: "ReviewMemoryControl.ErasePreview", parseOptions: strict })
export interface ErasePreview extends Schema.Schema.Type<typeof ErasePreview> {}

export const Preview = Schema.Union([
  ConfigurePreview,
  RecordPreview,
  ApprovePreview,
  ReopenPreview,
  ForgetPreview,
  ErasePreview,
]).annotate({ identifier: "ReviewMemoryControl.Preview" })
export type Preview = typeof Preview.Type

export const ConfirmationResult = Schema.Union([State, Entry]).annotate({
  identifier: "ReviewMemoryControl.ConfirmationResult",
})
export type ConfirmationResult = typeof ConfirmationResult.Type
