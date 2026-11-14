export * as SessionV1 from "./session"

import { Effect, Schema, Types } from "effect"
import { Billing } from "../billing"
import { define, inventory } from "../event"
import { FileDiff } from "../file-diff"
import { Project } from "../project"
import { Provider } from "../provider"
import { Model } from "../model"
import { NonNegativeInt, optional, statics } from "../schema"
import { ascending } from "../identifier"
import { SessionID } from "../session-id"
import { WorkspaceID } from "../workspace-id"
import { PermissionV1 } from "./permission"
import { FreeModelLimitReason } from "../free-model"
import { PublicSession } from "../public-session"
import { RunBudget } from "../run-budget"
import { TaskSize } from "../task-size"

const Timestamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const MessageID = Schema.String.check(Schema.isStartsWith("msg")).pipe(
  Schema.brand("MessageID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "msg_" + ascending()) })),
)
export type MessageID = typeof MessageID.Type

export const PartID = Schema.String.check(Schema.isStartsWith("prt")).pipe(
  Schema.brand("PartID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "prt_" + ascending()) })),
)
export type PartID = typeof PartID.Type

const namedError = <Name extends string, Fields extends Schema.Struct.Fields>(name: Name, fields: Fields) => {
  const schema = Schema.Struct({ name: Schema.Literal(name), data: Schema.Struct(fields) }).annotate({
    identifier: name,
  })
  return { Schema: schema, EffectSchema: schema }
}

export const OutputLengthError = namedError("MessageOutputLengthError", {})

export const AuthError = namedError("ProviderAuthError", {
  providerID: Schema.String,
  message: Schema.String,
})

export const AbortedError = namedError("MessageAbortedError", { message: Schema.String })
export const StructuredOutputError = namedError("StructuredOutputError", {
  message: Schema.String,
  retries: NonNegativeInt,
})
export const APIError = namedError("APIError", {
  message: Schema.String,
  statusCode: Schema.optional(NonNegativeInt),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  responseBody: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type APIError = Schema.Schema.Type<typeof APIError.Schema>
export const FreeModelsLimitError = namedError("FreeModelsLimitError", {
  code: Schema.Literal("VECTOR_FREE_MODELS_LIMIT"),
  reason: FreeModelLimitReason,
  resetAt: Schema.Finite,
  message: Schema.String,
})
export const ContextOverflowError = namedError("ContextOverflowError", {
  message: Schema.String,
  responseBody: Schema.optional(Schema.String),
})
export const ContentFilterError = namedError("ContentFilterError", {
  message: Schema.String,
})
// A run stopped by the spend guard: a cap, a predicted overshoot, too many unpriced steps, the step limit or a loop.
export const BudgetStopError = namedError("BudgetStopError", {
  reason: RunBudget.StopReason,
  message: Schema.String,
  spentUsd: Schema.optional(Schema.Finite),
  capUsd: Schema.optional(Schema.Finite),
  unpricedSteps: Schema.optional(NonNegativeInt),
  // The run's Vector Codium steps, which the guard counts apart from its unpriced (unknown) steps.
  codiumSteps: Schema.optional(NonNegativeInt),
  estimate: Schema.optional(Schema.Struct({ lowUsd: Schema.Finite, highUsd: Schema.Finite })),
})

export class OutputFormatText extends Schema.Class<OutputFormatText>("OutputFormatText")({
  type: Schema.Literal("text"),
}) {}

export class OutputFormatJsonSchema extends Schema.Class<OutputFormatJsonSchema>("OutputFormatJsonSchema")({
  type: Schema.Literal("json_schema"),
  schema: Schema.Record(Schema.String, Schema.Any).annotate({ identifier: "JSONSchema" }),
  retryCount: NonNegativeInt.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(2))),
}) {}

export const Format = Schema.Union([OutputFormatText, OutputFormatJsonSchema]).annotate({
  discriminator: "type",
  identifier: "OutputFormat",
})
export type OutputFormat = Schema.Schema.Type<typeof Format>

const partBase = {
  id: PartID,
  sessionID: SessionID,
  messageID: MessageID,
}

export const SnapshotPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("snapshot"),
  snapshot: Schema.String,
}).annotate({ identifier: "SnapshotPart" })
export type SnapshotPart = Types.DeepMutable<Schema.Schema.Type<typeof SnapshotPart>>

export const PatchPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("patch"),
  hash: Schema.String,
  files: Schema.Array(Schema.String),
}).annotate({ identifier: "PatchPart" })
export type PatchPart = Types.DeepMutable<Schema.Schema.Type<typeof PatchPart>>

export const TextPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "TextPart" })
export type TextPart = Types.DeepMutable<Schema.Schema.Type<typeof TextPart>>

export const ReasoningPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: Schema.optional(NonNegativeInt),
  }),
}).annotate({ identifier: "ReasoningPart" })
export type ReasoningPart = Types.DeepMutable<Schema.Schema.Type<typeof ReasoningPart>>

const filePartSourceBase = {
  text: Schema.Struct({
    value: Schema.String,
    start: Schema.Finite,
    end: Schema.Finite,
  }).annotate({ identifier: "FilePartSourceText" }),
}

export const Range = Schema.Struct({
  start: Schema.Struct({ line: NonNegativeInt, character: NonNegativeInt }),
  end: Schema.Struct({ line: NonNegativeInt, character: NonNegativeInt }),
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const FileSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("file"),
  path: Schema.String,
}).annotate({ identifier: "FileSource" })

export const SymbolSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("symbol"),
  path: Schema.String,
  range: Range,
  name: Schema.String,
  kind: NonNegativeInt,
}).annotate({ identifier: "SymbolSource" })

export const ResourceSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("resource"),
  clientName: Schema.String,
  uri: Schema.String,
}).annotate({ identifier: "ResourceSource" })

export const FilePartSource = Schema.Union([FileSource, SymbolSource, ResourceSource]).annotate({
  discriminator: "type",
  identifier: "FilePartSource",
})

export const FilePart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(FilePartSource),
}).annotate({ identifier: "FilePart" })
export type FilePart = Types.DeepMutable<Schema.Schema.Type<typeof FilePart>>

export const AgentPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
}).annotate({ identifier: "AgentPart" })
export type AgentPart = Types.DeepMutable<Schema.Schema.Type<typeof AgentPart>>

export const CompactionPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("compaction"),
  auto: Schema.Boolean,
  overflow: Schema.optional(Schema.Boolean),
  tail_start_id: Schema.optional(MessageID),
}).annotate({ identifier: "CompactionPart" })
export type CompactionPart = Types.DeepMutable<Schema.Schema.Type<typeof CompactionPart>>

export const SubtaskPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: Provider.ID,
      modelID: Model.ID,
    }),
  ),
  command: Schema.optional(Schema.String),
}).annotate({ identifier: "SubtaskPart" })
export type SubtaskPart = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPart>>

export const RetryPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("retry"),
  attempt: NonNegativeInt,
  error: APIError.EffectSchema,
  time: Schema.Struct({
    created: NonNegativeInt,
  }),
}).annotate({ identifier: "RetryPart" })
export type RetryPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof RetryPart>>, "error"> & {
  error: APIError
}

export const StepStartPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-start"),
  snapshot: Schema.optional(Schema.String),
}).annotate({ identifier: "StepStartPart" })
export type StepStartPart = Types.DeepMutable<Schema.Schema.Type<typeof StepStartPart>>

export const StepFinishPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-finish"),
  reason: Schema.String,
  snapshot: Schema.optional(Schema.String),
  cost: Schema.Finite,
  // The model lists no price, so cost is 0 because nothing could be charged, not because the step was free.
  unpriced: Schema.optional(Schema.Boolean),
  // The step ran on Vector Codium: its usage shows as "Codium", never as tokens or dollars.
  billing: optional(Billing.Kind),
  tokens: Schema.Struct({
    total: Schema.optional(Schema.Finite),
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
}).annotate({ identifier: "StepFinishPart" })
export type StepFinishPart = Types.DeepMutable<Schema.Schema.Type<typeof StepFinishPart>>

export const ToolStatePending = Schema.Struct({
  status: Schema.Literal("pending"),
  input: Schema.Record(Schema.String, Schema.Any),
  raw: Schema.String,
}).annotate({ identifier: "ToolStatePending" })
export type ToolStatePending = Types.DeepMutable<Schema.Schema.Type<typeof ToolStatePending>>

export const ToolStateRunning = Schema.Struct({
  status: Schema.Literal("running"),
  input: Schema.Record(Schema.String, Schema.Any),
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
  }),
}).annotate({ identifier: "ToolStateRunning" })
export type ToolStateRunning = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateRunning>>

export const ToolStateCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  input: Schema.Record(Schema.String, Schema.Any),
  output: Schema.String,
  title: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Any),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
    compacted: Schema.optional(NonNegativeInt),
  }),
  attachments: Schema.optional(Schema.Array(FilePart)),
}).annotate({ identifier: "ToolStateCompleted" })
export type ToolStateCompleted = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateCompleted>>

export const ToolStateError = Schema.Struct({
  status: Schema.Literal("error"),
  input: Schema.Record(Schema.String, Schema.Any),
  error: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
  }),
}).annotate({ identifier: "ToolStateError" })
export type ToolStateError = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateError>>

export const ToolState = Schema.Union([
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
]).annotate({
  discriminator: "status",
  identifier: "ToolState",
})
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export const ToolPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("tool"),
  callID: Schema.String,
  tool: Schema.String,
  state: ToolState,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "ToolPart" })
export type ToolPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof ToolPart>>, "state"> & {
  state: ToolState
}

const messageBase = {
  id: MessageID,
  sessionID: partBase.sessionID,
}

export const User = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("user"),
  time: Schema.Struct({
    created: Timestamp,
  }),
  format: Schema.optional(Format),
  summary: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      diffs: Schema.Array(FileDiff.Info),
    }),
  ),
  agent: Schema.String,
  model: Schema.Struct({
    providerID: Provider.ID,
    modelID: Model.ID,
    variant: Schema.optional(Schema.String),
  }),
  // What the sender chose when it differs from `model`: Codium Auto, which ran this message on `model`. The session
  // stays on the choice, and a picker shows it.
  selected: Schema.optional(
    Schema.Struct({
      providerID: Provider.ID,
      modelID: Model.ID,
    }),
  ),
  system: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  executionMode: Schema.optional(Schema.Union([Schema.Literal("normal"), Schema.Literal("fast")])),
  // What the sender asked for; Vector sizes each request itself when this is absent or "auto".
  size: Schema.optional(TaskSize.Choice),
  // When Vector runs LLM-as-a-judge after the run this message starts.
  judge: Schema.optional(TaskSize.JudgeMode),
  // WP A35: the sender has Second opinion on, so the judge of Vector Codium work runs on the plan's judge from another
  // lab when one is listed for the worker's model and no judge model is configured.
  secondOpinion: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "UserMessage" })
export type User = Types.DeepMutable<Schema.Schema.Type<typeof User>>

export const Part = Schema.Union([
  TextPart,
  SubtaskPart,
  ReasoningPart,
  FilePart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  AgentPart,
  RetryPart,
  CompactionPart,
]).annotate({ discriminator: "type", identifier: "Part" })
export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart

const AssistantErrorSchema = Schema.Union([
  AuthError.EffectSchema,
  namedError("UnknownError", { message: Schema.String, ref: Schema.optional(Schema.String) }).EffectSchema,
  OutputLengthError.EffectSchema,
  AbortedError.EffectSchema,
  StructuredOutputError.EffectSchema,
  ContextOverflowError.EffectSchema,
  ContentFilterError.EffectSchema,
  BudgetStopError.EffectSchema,
  APIError.EffectSchema,
  FreeModelsLimitError.EffectSchema,
]).annotate({ discriminator: "name" })
type AssistantError = Schema.Schema.Type<typeof AssistantErrorSchema>

export const TextPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "TextPartInput" })
export type TextPartInput = Types.DeepMutable<Schema.Schema.Type<typeof TextPartInput>>

export const FilePartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(FilePartSource),
}).annotate({ identifier: "FilePartInput" })
export type FilePartInput = Types.DeepMutable<Schema.Schema.Type<typeof FilePartInput>>

export const AgentPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
}).annotate({ identifier: "AgentPartInput" })
export type AgentPartInput = Types.DeepMutable<Schema.Schema.Type<typeof AgentPartInput>>

export const SubtaskPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: Provider.ID,
      modelID: Model.ID,
    }),
  ),
  command: Schema.optional(Schema.String),
}).annotate({ identifier: "SubtaskPartInput" })
export type SubtaskPartInput = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPartInput>>

export const Assistant = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("assistant"),
  time: Schema.Struct({
    created: NonNegativeInt,
    completed: Schema.optional(NonNegativeInt),
  }),
  error: Schema.optional(AssistantErrorSchema),
  parentID: MessageID,
  modelID: Model.ID,
  providerID: Provider.ID,
  mode: Schema.String,
  agent: Schema.String,
  path: Schema.Struct({
    cwd: Schema.String,
    root: Schema.String,
  }),
  summary: Schema.optional(Schema.Boolean),
  cost: Schema.Finite,
  // At least one step of this message ran on a model that lists no price; cost leaves those steps out.
  unpriced: Schema.optional(Schema.Boolean),
  // The message ran on Vector Codium: its usage shows as "Codium", never as tokens or dollars.
  billing: optional(Billing.Kind),
  tokens: Schema.Struct({
    total: Schema.optional(Schema.Finite),
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  structured: Schema.optional(Schema.Any),
  variant: Schema.optional(Schema.String),
  // The size Vector gave the request this message answers, when it sized it.
  size: Schema.optional(TaskSize.Tier),
  // A learned workflow default this request ran with, and why. `variant` stays the user's own pick.
  workflow: Schema.optional(
    Schema.Struct({
      effort: Schema.optional(Schema.Literal("default")),
      split: Schema.optional(Schema.Literal("solo")),
      subagentModel: Schema.optional(Schema.Literal("small")),
      source: Schema.Literals(["learned", "explore"]),
      reason: Schema.String,
    }),
  ),
  finish: Schema.optional(Schema.String),
  // Copied into this session by a fork. Its spend was counted in the original session, so it carries no cost and
  // usage totals skip it; its tokens stay so the context in use is still shown.
  forked: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "AssistantMessage" })
export type Assistant = Omit<Types.DeepMutable<Schema.Schema.Type<typeof Assistant>>, "error"> & {
  error?: AssistantError
}

export const Info = Schema.Union([User, Assistant]).annotate({ discriminator: "role", identifier: "Message" })
export type Info = User | Assistant

export const WithParts = Schema.Struct({
  info: Info,
  parts: Schema.Array(Part),
})
export type WithParts = {
  info: Info
  parts: Part[]
}

const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const

const SessionSummary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: optional(Schema.Array(FileDiff.Info)),
})

const SessionTokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

const SessionShare = Schema.Union([
  PublicSession.Info,
  Schema.Struct({
    url: Schema.String,
  }),
])

const SessionRevert = Schema.Struct({
  messageID: MessageID,
  partID: optional(PartID),
  snapshot: optional(Schema.String),
  diff: optional(Schema.String),
})

const SessionModel = Schema.Struct({
  id: Model.ID,
  providerID: Provider.ID,
  variant: optional(Schema.String),
})

export const SessionInfo = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: Project.ID,
  workspaceID: optional(WorkspaceID),
  directory: Schema.String,
  path: optional(Schema.String),
  parentID: optional(SessionID),
  // Names the Vector helper that ran this session, such as a Vectorscope review or autocomplete. Helper sessions stay
  // out of session lists; their spend counts towards parentID, the session that launched them, when there is one.
  internal: optional(Schema.String),
  summary: optional(SessionSummary),
  cost: optional(Schema.Finite),
  // Steps that ran on a model with no listed price; cost leaves them out, so a session with any is not fully priced.
  unpricedSteps: optional(NonNegativeInt),
  // How many of those unpriced steps ran on Vector Codium; own unpriced steps are unpricedSteps − codiumSteps.
  codiumSteps: optional(NonNegativeInt),
  // True only when the accounting boundary proves the aggregate contains own-model tokens only.
  tokensOwnOnly: optional(Schema.Boolean),
  subagentTokensOwnOnly: optional(Schema.Boolean),
  // What the subagent sessions below this one spent, which cost leaves out, and how many of their steps were unpriced.
  subagentCost: optional(Schema.Finite),
  subagentUnpricedSteps: optional(NonNegativeInt),
  // How many of the subagent unpriced steps ran on Vector Codium.
  subagentCodiumSteps: optional(NonNegativeInt),
  // The tokens those sessions used, which tokens leaves out.
  subagentTokens: optional(SessionTokens),
  tokens: optional(SessionTokens),
  share: optional(SessionShare),
  title: Schema.String,
  agent: optional(Schema.String),
  model: optional(SessionModel),
  version: Schema.String,
  metadata: optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
    compacting: optional(NonNegativeInt),
    archived: optional(Schema.Finite),
  }),
  permission: optional(PermissionV1.Ruleset),
  revert: optional(SessionRevert),
}).annotate({ identifier: "Session" })
export type SessionInfo = typeof SessionInfo.Type

const events = {
  Created: define({
    type: "session.created",
    ...options,
    schema: {
      sessionID: SessionID,
      info: SessionInfo,
    },
  }),
  Updated: define({
    type: "session.updated",
    ...options,
    schema: {
      sessionID: SessionID,
      info: SessionInfo,
    },
  }),
  Deleted: define({
    type: "session.deleted",
    ...options,
    schema: {
      sessionID: SessionID,
      info: SessionInfo,
    },
  }),
  MessageUpdated: define({
    type: "message.updated",
    ...options,
    schema: {
      sessionID: SessionID,
      info: Info,
    },
  }),
  MessageRemoved: define({
    type: "message.removed",
    ...options,
    schema: {
      sessionID: SessionID,
      messageID: MessageID,
    },
  }),
  PartUpdated: define({
    type: "message.part.updated",
    ...options,
    schema: {
      sessionID: SessionID,
      part: Part,
      time: Schema.Finite,
    },
  }),
  PartRemoved: define({
    type: "message.part.removed",
    ...options,
    schema: {
      sessionID: SessionID,
      messageID: MessageID,
      partID: PartID,
    },
  }),
}

export const PartDelta = define({
  type: "message.part.delta",
  schema: {
    sessionID: SessionID,
    messageID: MessageID,
    partID: PartID,
    field: Schema.String,
    delta: Schema.String,
  },
})

export const Diff = define({
  type: "session.diff",
  schema: {
    sessionID: SessionID,
    diff: Schema.Array(FileDiff.Info),
  },
})

export const Error = define({
  type: "session.error",
  schema: {
    sessionID: Schema.optional(SessionID),
    error: Assistant.fields.error,
  },
})

export const Event = {
  ...events,
  PartDelta,
  Diff,
  Error,
  Definitions: inventory(
    events.Created,
    events.Updated,
    events.Deleted,
    events.MessageUpdated,
    events.MessageRemoved,
    events.PartUpdated,
    events.PartRemoved,
    PartDelta,
    Diff,
    Error,
  ),
}
