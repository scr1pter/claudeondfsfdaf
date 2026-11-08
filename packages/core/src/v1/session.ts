export * as SessionV1 from "./session"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"
import { NamedError } from "../util/error"
import { FreeModelLimitReason } from "@vectordevai/schema/free-model"
import { RunBudget } from "@vectordevai/schema/run-budget"

export {
  AgentPart,
  AgentPartInput,
  Assistant,
  CompactionPart,
  Event,
  FilePart,
  FilePartInput,
  FilePartSource,
  FileSource,
  Format,
  Info,
  MessageID,
  OutputFormatJsonSchema,
  OutputFormatText,
  Part,
  PartID,
  PatchPart,
  Range,
  ReasoningPart,
  ResourceSource,
  RetryPart,
  SessionInfo,
  SnapshotPart,
  StepFinishPart,
  StepStartPart,
  SubtaskPart,
  SubtaskPartInput,
  SymbolSource,
  TextPart,
  TextPartInput,
  ToolPart,
  ToolState,
  ToolStateCompleted,
  ToolStateError,
  ToolStatePending,
  ToolStateRunning,
  User,
  WithParts,
} from "@vectordevai/schema/session-v1"

export const OutputLengthError = NamedError.create("MessageOutputLengthError", {})
export const AuthError = NamedError.create("ProviderAuthError", { providerID: Schema.String, message: Schema.String })
export const AbortedError = NamedError.create("MessageAbortedError", { message: Schema.String })
export const StructuredOutputError = NamedError.create("StructuredOutputError", {
  message: Schema.String,
  retries: NonNegativeInt,
})
export const APIError = NamedError.create("APIError", {
  message: Schema.String,
  statusCode: Schema.optional(NonNegativeInt),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  responseBody: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type APIError = Schema.Schema.Type<typeof APIError.Schema>
export const FreeModelsLimitError = NamedError.create("FreeModelsLimitError", {
  code: Schema.Literal("VECTOR_FREE_MODELS_LIMIT"),
  reason: FreeModelLimitReason,
  resetAt: Schema.Finite,
  message: Schema.String,
})
export const ContextOverflowError = NamedError.create("ContextOverflowError", {
  message: Schema.String,
  responseBody: Schema.optional(Schema.String),
})
export const ContentFilterError = NamedError.create("ContentFilterError", { message: Schema.String })
export const BudgetStopError = NamedError.create("BudgetStopError", {
  reason: RunBudget.StopReason,
  message: Schema.String,
  spentUsd: Schema.optional(Schema.Finite),
  capUsd: Schema.optional(Schema.Finite),
  unpricedSteps: Schema.optional(NonNegativeInt),
  // The run's Vector Codium steps, which the guard counts apart from its unpriced (unknown) steps.
  codiumSteps: Schema.optional(NonNegativeInt),
  estimate: Schema.optional(Schema.Struct({ lowUsd: Schema.Finite, highUsd: Schema.Finite })),
})
