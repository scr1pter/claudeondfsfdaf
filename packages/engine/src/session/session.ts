import { ShareNext } from "@/share/share-next"
import { PublicShareRemovalError, publicShareWarning } from "@vectordevai/schema/public-share"
import { PublicSession } from "@vectordevai/schema/public-session"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Slug } from "@vectordevai/core/util/slug"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import path from "path"
import { BackgroundJob } from "@/background/job"
import { Decimal } from "decimal.js"
import type { ProviderMetadata, Usage } from "@vectordevai/llm"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { Database } from "@vectordevai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@vectordevai/core/event"
import { EventTable } from "@vectordevai/core/event/sql"
import { SessionV2 } from "@vectordevai/core/session"
import * as SessionExecutionLocal from "@vectordevai/core/session/execution/local"
import { locationServiceMapLayer } from "@vectordevai/core/location-services"

import { NotFoundError } from "@/storage/storage"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"
import { gte } from "drizzle-orm"
import { isNull } from "drizzle-orm"
import { isNotNull } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { like } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@vectordevai/core/session/sql"
import { subagentTokens } from "@vectordevai/core/session/info"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { MessageV2 } from "./message-v2"
import type { InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { ProjectV2 } from "@vectordevai/core/project"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import { SessionID, MessageID, PartID } from "./schema"

import type { Provider } from "@/provider/provider"
import { Global } from "@vectordevai/core/global"
import { Effect, Layer, Option, Context, Schema, Types, DateTime } from "effect"
import { NonNegativeInt, optional } from "@vectordevai/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { SessionMessage } from "@vectordevai/schema/session-message"
import { SessionEvent } from "@vectordevai/schema/session-event"
import { Billing } from "@vectordevai/schema/billing"

const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}

type SessionRow = typeof SessionTable.$inferSelect

export function fromRow(row: SessionRow): Info {
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
        }
      : undefined
  const share = row.share_info ?? (row.share_url ? { url: row.share_url } : undefined)
  const revert = row.revert
    ? {
        messageID: MessageID.make(row.revert.messageID),
        partID: row.revert.partID ? PartID.make(row.revert.partID) : undefined,
        snapshot: row.revert.snapshot,
        diff: row.revert.diff,
      }
    : undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    path: row.path ?? undefined,
    parentID: row.parent_id ?? undefined,
    internal: row.internal ?? undefined,
    title: row.title,
    agent: row.agent ?? undefined,
    model: row.model
      ? {
          id: ModelV2.ID.make(row.model.id),
          providerID: ProviderV2.ID.make(row.model.providerID),
          variant: row.model.variant,
        }
      : undefined,
    version: row.version,
    summary,
    cost: row.cost,
    unpricedSteps: row.unpriced_steps || undefined,
    codiumSteps: row.codium_steps || undefined,
    subagentCost: row.subagent_cost || undefined,
    subagentUnpricedSteps: row.subagent_unpriced_steps || undefined,
    subagentCodiumSteps: row.subagent_codium_steps || undefined,
    subagentTokens: subagentTokens(row),
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    share,
    metadata: row.metadata ?? undefined,
    revert,
    permission: row.permission ? [...row.permission] : undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  }
}

export function toRow(info: Info) {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID,
    parent_id: info.parentID,
    internal: info.internal,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: Schema.is(PublicSession.Info)(info.share) ? undefined : info.share?.url,
    share_info: Schema.is(PublicSession.Info)(info.share) ? info.share : null,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    unpriced_steps: info.unpricedSteps ?? 0,
    codium_steps: info.codiumSteps ?? 0,
    subagent_cost: info.subagentCost ?? 0,
    subagent_unpriced_steps: info.subagentUnpricedSteps ?? 0,
    subagent_codium_steps: info.subagentCodiumSteps ?? 0,
    subagent_tokens_input: info.subagentTokens?.input ?? 0,
    subagent_tokens_output: info.subagentTokens?.output ?? 0,
    subagent_tokens_reasoning: info.subagentTokens?.reasoning ?? 0,
    subagent_tokens_cache_read: info.subagentTokens?.cache.read ?? 0,
    subagent_tokens_cache_write: info.subagentTokens?.cache.write ?? 0,
    tokens_input: (info.tokens ?? EmptyTokens).input,
    tokens_output: (info.tokens ?? EmptyTokens).output,
    tokens_reasoning: (info.tokens ?? EmptyTokens).reasoning,
    tokens_cache_read: (info.tokens ?? EmptyTokens).cache.read,
    tokens_cache_write: (info.tokens ?? EmptyTokens).cache.write,
    revert: info.revert
      ? {
          messageID: SessionMessage.ID.make(info.revert.messageID),
          partID: info.revert.partID,
          snapshot: info.revert.snapshot,
          diff: info.revert.diff,
        }
      : null,
    permission: info.permission,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function getForkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) {
    const base = match[1]
    const num = parseInt(match[2], 10)
    return `${base} (fork #${num + 1})`
  }
  return `${title} (fork #1)`
}

function sessionPath(worktree: string, cwd: string) {
  return path.relative(path.resolve(worktree), cwd).replaceAll("\\", "/")
}

const Summary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: optional(Schema.Array(Snapshot.FileDiff)),
})

const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

const EmptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const Share = Schema.Struct({
  url: Schema.String,
})

// Legacy HTTP accepted negative values here. Keep archive timestamps permissive
// while excluding non-finite values that cannot round-trip through JSON.
export const ArchivedTimestamp = Schema.Finite

const Time = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  compacting: optional(NonNegativeInt),
  archived: optional(ArchivedTimestamp),
})

const Revert = Schema.Struct({
  messageID: MessageID,
  partID: optional(PartID),
  snapshot: optional(Schema.String),
  diff: optional(Schema.String),
})

const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  variant: optional(Schema.String),
})

export const Metadata = Schema.Record(Schema.String, Schema.Any)

export const Info = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: ProjectV2.ID,
  workspaceID: optional(WorkspaceV2.ID),
  directory: Schema.String,
  path: optional(Schema.String),
  parentID: optional(SessionID),
  // Names the Vector helper that ran this session, such as a Vectorscope review or autocomplete. Helper sessions stay
  // out of session lists; their spend counts towards parentID, the session that launched them, when there is one.
  internal: optional(Schema.String),
  summary: optional(Summary),
  cost: optional(Schema.Finite),
  // Steps that ran on a model with no listed price; cost leaves them out, so a session with any is not fully priced.
  unpricedSteps: optional(NonNegativeInt),
  // How many of those unpriced steps ran on Vector Codium; own unpriced steps are unpricedSteps − codiumSteps.
  codiumSteps: optional(NonNegativeInt),
  // What the subagent sessions below this one spent, which cost leaves out, and how many of their steps were unpriced.
  subagentCost: optional(Schema.Finite),
  subagentUnpricedSteps: optional(NonNegativeInt),
  // How many of the subagent unpriced steps ran on Vector Codium.
  subagentCodiumSteps: optional(NonNegativeInt),
  // The tokens those sessions used, which tokens leaves out.
  subagentTokens: optional(Tokens),
  tokens: optional(Tokens),
  share: optional(Share),
  title: Schema.String,
  agent: optional(Schema.String),
  model: optional(Model),
  version: Schema.String,
  metadata: optional(Metadata),
  time: Time,
  permission: optional(PermissionV1.Ruleset),
  revert: optional(Revert),
}).annotate({ identifier: "Session" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const ProjectInfo = Schema.Struct({
  id: ProjectV2.ID,
  name: optional(Schema.String),
  worktree: Schema.String,
}).annotate({ identifier: "ProjectSummary" })
export type ProjectInfo = Types.DeepMutable<Schema.Schema.Type<typeof ProjectInfo>>

export const GlobalInfo = Schema.Struct({
  ...Info.fields,
  project: Schema.NullOr(ProjectInfo),
}).annotate({ identifier: "GlobalSession" })
export type GlobalInfo = Types.DeepMutable<Schema.Schema.Type<typeof GlobalInfo>>

export const UsageDay = Schema.Struct({
  date: Schema.String,
  tokens: NonNegativeInt,
  // Known recorded spend, including ancillary model work; task activity remains transcript-only.
  cost: Schema.Finite,
  tasks: NonNegativeInt,
  // Vector Codium responses that day: an activity count, never tokens. A day that counts them leaves their tokens out.
  codium: optional(NonNegativeInt),
}).annotate({ identifier: "SessionUsageDay" })
export type UsageDay = Types.DeepMutable<Schema.Schema.Type<typeof UsageDay>>

export const UsageModel = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  tokens: NonNegativeInt,
  responses: NonNegativeInt,
  percentage: Schema.Finite,
}).annotate({ identifier: "SessionUsageModel" })
export type UsageModel = Types.DeepMutable<Schema.Schema.Type<typeof UsageModel>>

export const UsageEffort = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  tokens: NonNegativeInt,
  responses: NonNegativeInt,
  percentage: Schema.Finite,
}).annotate({ identifier: "SessionUsageEffort" })
export type UsageEffort = Types.DeepMutable<Schema.Schema.Type<typeof UsageEffort>>

// What one kind of Vector helper (a Vectorscope review, autocomplete) spent across its sessions. Helper spend is part of
// every total above; this only says how much of it the helpers account for.
export const UsageHelper = Schema.Struct({
  id: Schema.String,
  sessions: NonNegativeInt,
  responses: NonNegativeInt,
  tokens: NonNegativeInt,
  cost: Schema.Finite,
  // The helper's steps on Vector Codium: an activity count, never tokens. A helper that counts them leaves their tokens
  // out.
  codiumSteps: optional(NonNegativeInt),
}).annotate({ identifier: "SessionUsageHelper" })
export type UsageHelper = Types.DeepMutable<Schema.Schema.Type<typeof UsageHelper>>

export const UsageSummary = Schema.Struct({
  lifetimeTokens: NonNegativeInt,
  lifetimeCost: Schema.Finite,
  // Model work with unknown price or incomplete usage, including ancillary attempts.
  // lifetimeCost is the known subtotal; this count is independent of transcript modelResponses.
  unpricedResponses: optional(NonNegativeInt),
  // How many of those unpriced responses ran on Vector Codium: an activity count, never tokens. A summary that counts
  // them leaves their tokens out of every token total.
  codiumResponses: optional(NonNegativeInt),
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  cachedTokens: NonNegativeInt,
  peakTokens: NonNegativeInt,
  longestTaskMs: NonNegativeInt,
  longestTaskTokens: NonNegativeInt,
  averageTaskMs: NonNegativeInt,
  currentStreak: NonNegativeInt,
  longestStreak: NonNegativeInt,
  completedChats: NonNegativeInt,
  conversations: NonNegativeInt,
  activeDays: NonNegativeInt,
  averageTokensPerChat: NonNegativeInt,
  modelResponses: NonNegativeInt,
  favoriteModels: Schema.Array(UsageModel),
  effortLevels: Schema.Array(UsageEffort),
  days: Schema.Array(UsageDay),
  helpers: optional(Schema.Array(UsageHelper)),
}).annotate({ identifier: "SessionUsageSummary" })
export type UsageSummary = Types.DeepMutable<Schema.Schema.Type<typeof UsageSummary>>

export const CreateInput = Schema.optional(
  Schema.Struct({
    parentID: Schema.optional(SessionID),
    internal: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    model: Schema.optional(Model),
    metadata: Schema.optional(Metadata),
    permission: Schema.optional(PermissionV1.Ruleset),
    workspaceID: Schema.optional(WorkspaceV2.ID),
  }),
)
export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const ForkInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export const GetInput = SessionID
export const ChildrenInput = SessionID
export const RemoveInput = SessionID
export const SetTitleInput = Schema.Struct({ sessionID: SessionID, title: Schema.String })
export const SetArchivedInput = Schema.Struct({
  sessionID: SessionID,
  time: Schema.optional(ArchivedTimestamp),
})
export const SetMetadataInput = Schema.Struct({
  sessionID: SessionID,
  metadata: Metadata,
})
export const SetPermissionInput = Schema.Struct({
  sessionID: SessionID,
  permission: PermissionV1.Ruleset,
})
export const SetRevertInput = Schema.Struct({
  sessionID: SessionID,
  revert: Schema.optional(Revert),
  summary: Schema.optional(Summary),
})
export const MessagesInput = Schema.Struct({
  sessionID: SessionID,
  limit: Schema.optional(NonNegativeInt),
})
export type ListInput = {
  directory?: string
  scope?: "project"
  path?: string
  workspaceID?: WorkspaceV2.ID
  roots?: boolean
  // Also list Vector's helper sessions, which are left out by default.
  internal?: boolean
  start?: number
  search?: string
  limit?: number
}

export type GlobalListInput = {
  directory?: string
  roots?: boolean
  // Also list Vector's helper sessions, which are left out by default.
  internal?: boolean
  start?: number
  cursor?: number
  search?: string
  limit?: number
  archived?: boolean
}

export const Event = {
  Created: SessionV1.Event.Created,
  Updated: SessionV1.Event.Updated,
  Deleted: SessionV1.Event.Deleted,
  Diff: SessionV1.Event.Diff,
  Error: SessionV1.Event.Error,
}

export function plan(input: { slug: string; time: { created: number } }, instance: InstanceContext) {
  const base = instance.project.vcs
    ? path.join(instance.worktree, ".vector", "plans")
    : path.join(Global.Path.data, "plans")
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}

// The rates a request carrying `contextTokens` of context is billed at: the highest long-context tier it passes, else
// the base rates.
export const costAt = (cost: Provider.Model["cost"] | undefined, contextTokens: number) =>
  cost?.tiers
    ?.filter((item) => item.tier.type === "context" && contextTokens > item.tier.size)
    .sort((a, b) => b.tier.size - a.tier.size)[0] ??
  // experimentalOver200K is models.dev's 200K stand-in for the exact tiers, so it applies only without them.
  (cost?.experimentalOver200K && !cost.tiers?.length && contextTokens > 200_000 ? cost.experimentalOver200K : cost)

export const getUsage = (input: { model: Provider.Model; usage: Usage; metadata?: ProviderMetadata }) => {
  const safe = (value: number) => {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, value)
  }
  const inputTokens = safe(input.usage.inputTokens ?? 0)
  const outputTokens = safe(input.usage.outputTokens ?? 0)
  const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

  const cacheReadInputTokens = safe(input.usage.cacheReadInputTokens ?? 0)
  const cacheWriteInputTokens = safe(
    Number(
      input.usage.cacheWriteInputTokens ??
        input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
        // google-vertex-anthropic returns metadata under "vertex" key
        // (AnthropicMessagesLanguageModel custom provider key from 'vertex.anthropic.messages')
        input.metadata?.["vertex"]?.["cacheCreationInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
        0,
    ),
  )

  // AI SDK v6 normalized inputTokens to include cached tokens across all providers
  // (including Anthropic/Bedrock which previously excluded them). Always subtract cache
  // tokens to get the non-cached input count for separate cost calculation.
  const adjustedInputTokens = safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)

  const total = input.usage.totalTokens

  const tokens = {
    total,
    input: adjustedInputTokens,
    output: safe(outputTokens - reasoningTokens),
    reasoning: reasoningTokens,
    cache: {
      write: cacheWriteInputTokens,
      read: cacheReadInputTokens,
    },
  }

  // A Vector Codium step is billed to the account's plan on vectordev.ai, so it is never priced from what the provider
  // metadata reports, and every step is unpriced and marked Codium: totals leave its tokens out and show "Codium".
  if (Billing.isCodium(input.model.providerID)) return { unpriced: true, billing: "codium" as const, cost: 0, tokens }

  const costInfo = costAt(input.model.cost, inputTokens)
  const totalNanoAiu = input.metadata?.["copilot"]?.["totalNanoAiu"]
  // OpenRouter reports what it billed for each step. A model the catalog lists no price for, as an OpenRouter model
  // added by hand often is, takes that amount instead of reading as unpriced.
  // @ts-expect-error provider metadata is untyped JSON
  const reported: unknown = input.metadata?.["openrouter"]?.["usage"]?.["cost"]
  const reportedCost =
    input.model.cost?.unpriced === true && typeof reported === "number" && Number.isFinite(reported) && reported >= 0
      ? reported
      : undefined
  const billed =
    (typeof totalNanoAiu === "number" && Number.isFinite(totalNanoAiu) && totalNanoAiu >= 0) ||
    reportedCost !== undefined
  return {
    // The model lists no price and the provider reported no charge, so the cost below is 0 for want of a price.
    // A step that used no tokens owes nothing either way.
    unpriced:
      !billed &&
      input.model.cost?.unpriced === true &&
      tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write > 0,
    cost:
      reportedCost !== undefined
        ? reportedCost
        : billed
          ? // Copilot bills in nano AI units: 1 AI credit is 1e9 nano-AIU and costs $0.01, so USD = nano-AIU / 1e11.
            new Decimal(Number(totalNanoAiu)).div(100_000_000_000).toNumber()
          : safe(
              new Decimal(0)
                .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
                .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
                .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
                .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
                // TODO: extend the catalog pricing model, for now:
                // charge reasoning tokens at the same rate as output tokens
                .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
                .toNumber(),
            ),
    tokens,
  }
}

export class BusyError extends Schema.TaggedErrorClass<BusyError>()("SessionBusyError", {
  sessionID: SessionID,
}) {}

export type NotFound = NotFoundError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<Info[]>
  readonly listGlobal: (input?: GlobalListInput) => Effect.Effect<GlobalInfo[]>
  /** Usage across every project, or only sessions in `directory`. */
  readonly usage: (input?: { directory?: string }) => Effect.Effect<UsageSummary>
  readonly create: (input?: {
    parentID?: SessionID
    internal?: string
    title?: string
    agent?: string
    model?: Schema.Schema.Type<typeof Model>
    metadata?: typeof Metadata.Type
    permission?: PermissionV1.Ruleset
    workspaceID?: WorkspaceV2.ID
  }) => Effect.Effect<Info>
  readonly fork: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Info, NotFound>
  readonly touch: (sessionID: SessionID) => Effect.Effect<void>
  readonly get: (id: SessionID) => Effect.Effect<Info, NotFound>
  readonly setTitle: (input: { sessionID: SessionID; title: string }) => Effect.Effect<void>
  readonly setArchived: (input: { sessionID: SessionID; time?: number }) => Effect.Effect<void>
  readonly setMetadata: (input: typeof SetMetadataInput.Type) => Effect.Effect<void>
  readonly setAgentModel: (input: {
    sessionID: SessionID
    agent: string
    model: NonNullable<Info["model"]>
    time: number
  }) => Effect.Effect<void>
  readonly setPermission: (input: { sessionID: SessionID; permission: PermissionV1.Ruleset }) => Effect.Effect<void>
  readonly setRevert: (input: {
    sessionID: SessionID
    revert: Info["revert"]
    summary: Info["summary"]
  }) => Effect.Effect<void>
  readonly clearRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly setSummary: (input: { sessionID: SessionID; summary: Info["summary"] }) => Effect.Effect<void>
  readonly setShare: (input: { sessionID: SessionID; share: Info["share"] }) => Effect.Effect<void>
  readonly setWorkspace: (input: { sessionID: SessionID; workspaceID: Info["workspaceID"] }) => Effect.Effect<void>
  readonly diff: (sessionID: SessionID) => Effect.Effect<Snapshot.FileDiff[]>
  readonly messages: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<SessionV1.WithParts[], NotFound>
  readonly children: (parentID: SessionID) => Effect.Effect<Info[]>
  readonly remove: (
    sessionID: SessionID,
    options?: { acknowledgePublicShares?: boolean },
  ) => Effect.Effect<void, NotFound | PublicShareRemovalError | PublicSession.Error>
  readonly updateMessage: <T extends SessionV1.Info>(msg: T) => Effect.Effect<T>
  readonly removeMessage: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MessageID>
  readonly removePart: (input: { sessionID: SessionID; messageID: MessageID; partID: PartID }) => Effect.Effect<PartID>
  readonly getPart: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
  }) => Effect.Effect<SessionV1.Part | undefined>
  readonly updatePart: <T extends SessionV1.Part>(part: T) => Effect.Effect<T>
  readonly updatePartDelta: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    field: string
    delta: string
  }) => Effect.Effect<void>
  /** Finds the first message matching the predicate, searching newest-first. */
  readonly findMessage: (
    sessionID: SessionID,
    predicate: (msg: SessionV1.WithParts) => boolean,
  ) => Effect.Effect<Option.Option<SessionV1.WithParts>, NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Session") {}

export const use = serviceUse(Service)

export type Patch = Omit<Partial<Info>, "time" | "share" | "summary" | "revert" | "permission"> & {
  time?: Partial<Info["time"]>
  share?: Partial<NonNullable<Info["share"]>> | null
  summary?: Info["summary"] | null
  revert?: Info["revert"] | null
  permission?: Info["permission"] | null
}

const layer: Layer.Layer<
  Service,
  never,
  BackgroundJob.Service | RuntimeFlags.Service | Database.Service | EventV2Bridge.Service | ShareNext.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sharing = yield* ShareNext.Service
    const { db } = yield* Database.Service
    const database = yield* Database.Service
    const background = yield* BackgroundJob.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const createNext = Effect.fn("Session.createNext")(function* (input: {
      id?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      parentID?: SessionID
      internal?: string
      workspaceID?: WorkspaceV2.ID
      directory: string
      path?: string
      metadata?: typeof Metadata.Type
      permission?: PermissionV1.Ruleset
    }) {
      const ctx = yield* InstanceState.context
      const result: Info = {
        id: SessionID.descending(input.id),
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: ctx.project.id,
        directory: input.directory,
        path: input.path,
        workspaceID: input.workspaceID,
        parentID: input.parentID,
        internal: input.internal,
        title: input.title ?? (input.parentID ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString(),
        agent: input.agent,
        model: input.model,
        metadata: input.metadata,
        permission: input.permission ? [...input.permission] : undefined,
        cost: 0,
        tokens: EmptyTokens,
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
      yield* Effect.logInfo("created", result)

      yield* events.publish(SessionV1.Event.Created, { sessionID: result.id, info: result })

      return result
    })

    const get = Effect.fn("Session.get")(function* (id: SessionID) {
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${id}` }))
      return fromRow(row)
    })

    const list = Effect.fn("Session.list")(function* (input?: ListInput) {
      const ctx = yield* InstanceState.context
      return yield* listByProject(db, {
        projectID: ctx.project.id,
        experimentalWorkspaces: flags.experimentalWorkspaces,
        ...input,
      })
    })

    const listGlobal = Effect.fn("Session.listGlobal")(function* (input?: GlobalListInput) {
      const conditions: SQL[] = []
      if (input?.directory) conditions.push(eq(SessionTable.directory, input.directory))
      if (input?.roots) conditions.push(isNull(SessionTable.parent_id))
      if (!input?.internal) conditions.push(isNull(SessionTable.internal))
      if (input?.start) conditions.push(gte(SessionTable.time_updated, input.start))
      if (input?.cursor) conditions.push(lt(SessionTable.time_updated, input.cursor))
      if (input?.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
      if (!input?.archived) conditions.push(isNull(SessionTable.time_archived))

      const query =
        conditions.length > 0
          ? db
              .select()
              .from(SessionTable)
              .where(and(...conditions))
          : db.select().from(SessionTable)
      const rows = yield* query
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .limit(input?.limit ?? 100)
        .all()
        .pipe(Effect.orDie)
      const ids = [...new Set(rows.map((row) => row.project_id))]
      const projects = new Map<string, ProjectInfo>()
      if (ids.length > 0) {
        const items = yield* db
          .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
          .from(ProjectTable)
          .where(inArray(ProjectTable.id, ids))
          .all()
          .pipe(Effect.orDie)
        for (const item of items) {
          projects.set(item.id, {
            id: item.id,
            name: item.name ?? undefined,
            worktree: item.worktree,
          })
        }
      }
      return rows.map((row) => ({ ...fromRow(row), project: projects.get(row.project_id) ?? null }))
    })

    const usage = Effect.fn("Session.usage")(function* (input?: { directory?: string }) {
      const inDirectory = input?.directory ? eq(SessionTable.directory, input.directory) : undefined
      // Without a directory nothing is filtered, so a message whose session row is gone still counts, as before.
      const sessionIn = (column: typeof MessageTable.session_id | typeof SessionMessageTable.session_id) =>
        inDirectory && inArray(column, db.select({ id: SessionTable.id }).from(SessionTable).where(inDirectory))
      const rows = yield* db
        .select({ id: MessageTable.id, sessionID: MessageTable.session_id, data: MessageTable.data })
        .from(MessageTable)
        .where(sessionIn(MessageTable.session_id))
        .orderBy(MessageTable.time_created)
        .all()
        .pipe(Effect.orDie)
      const decode = Schema.decodeUnknownOption(SessionV1.Info)
      const ancillary = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .innerJoin(SessionTable, eq(EventTable.aggregate_id, SessionTable.id))
        .where(and(inArray(EventTable.type, SessionEvent.AncillaryUsageStored), inDirectory))
        .all()
        .pipe(Effect.orDie)
      const helpers = yield* db
        .select({ id: SessionTable.id, internal: SessionTable.internal })
        .from(SessionTable)
        .where(and(isNotNull(SessionTable.internal), inDirectory))
        .all()
        .pipe(Effect.orDie)
      // Sessions prompted through the V2 path (parallel agents, automations, the swarm planner) keep their steps as
      // session messages. Only the fields usage needs are read, not each step's content.
      const steps = yield* db
        .select({
          id: SessionMessageTable.id,
          sessionID: SessionMessageTable.session_id,
          type: SessionMessageTable.type,
          created: SessionMessageTable.time_created,
          completed: sql<number | null>`json_extract(${SessionMessageTable.data}, '$.time.completed')`,
          agent: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.agent')`,
          model: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.model')`,
          cost: sql<number | null>`json_extract(${SessionMessageTable.data}, '$.cost')`,
          unpriced: sql<number | null>`json_extract(${SessionMessageTable.data}, '$.unpriced')`,
          billing: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.billing')`,
          tokens: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.tokens')`,
          finish: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.finish')`,
          error: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.error')`,
        })
        .from(SessionMessageTable)
        .where(
          and(
            inArray(SessionMessageTable.type, ["user", "assistant", "compaction"]),
            sessionIn(SessionMessageTable.session_id),
          ),
        )
        .orderBy(SessionMessageTable.session_id, SessionMessageTable.seq)
        .all()
        .pipe(Effect.orDie)
      return summarizeUsage(
        [
          ...rows.flatMap((row) =>
            // `data` holds only the message body; `id`/`sessionID` live in columns but are
            // required by the schema, so merge them back before decoding — otherwise every
            // row fails to decode and usage collapses to zero. Mirrors MessageV2's `info(row)`.
            Option.match(decode({ ...row.data, id: row.id, sessionID: row.sessionID }), {
              onNone: () => [],
              onSome: (message) => [message],
            }),
          ),
          ...stepUsage(steps),
        ],
        ancillary.map((event) => Schema.decodeUnknownSync(SessionEvent.AncillaryUsage.data)(event.data)),
        new Map(helpers.flatMap((row) => (row.internal ? [[row.id, row.internal] as const] : []))),
      )
    })

    const children = Effect.fn("Session.children")(function* (parentID: SessionID) {
      const rows = yield* db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.parent_id, parentID)))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const remove: Interface["remove"] = Effect.fnUntraced(function* (sessionID: SessionID, options) {
      const session = yield* get(sessionID)
      if (!options?.acknowledgePublicShares) {
        const links = yield* sharing.publicLinks(sessionID)
        if (links.length) return yield* publicShareWarning(links)
      }
      yield* sharing.removeTree(sessionID)
      try {
        // `remove` needs to work in all cases, such as broken sessions that
        // run cleanup without instance state.
        const hasInstance = yield* InstanceState.directory.pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        )

        if (hasInstance) yield* cancelBackgroundJobs(background, sessionID)
        const kids = yield* children(sessionID)
        for (const child of kids) {
          yield* remove(child.id, options)
        }

        yield* events.publish(SessionV1.Event.Deleted, { sessionID, info: session })
        yield* events.remove(sessionID)
      } catch (error) {
        yield* Effect.logError("failed to remove session", { sessionID, error })
      }
    })

    const updateMessage = <T extends SessionV1.Info>(msg: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        // Every V1 assistant message, compaction included, is published here, so this is where a Vector Codium
        // message gets its flag. The published copy carries it; the caller's object is left as it was.
        const info =
          msg.role === "assistant" && Billing.isCodium(msg.providerID) ? { ...msg, billing: "codium" as const } : msg
        yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: info.sessionID, info })
        return info
      }).pipe(Effect.withSpan("Session.updateMessage"))

    const updatePart = <T extends SessionV1.Part>(part: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID: part.sessionID,
          part: structuredClone(part),
          time: Date.now(),
        })
        return part
      }).pipe(Effect.withSpan("Session.updatePart"))

    const getPart: Interface["getPart"] = Effect.fn("Session.getPart")(function* (input) {
      const row = yield* db
        .select()
        .from(PartTable)
        .where(
          and(
            eq(PartTable.session_id, input.sessionID),
            eq(PartTable.message_id, input.messageID),
            eq(PartTable.id, input.partID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return {
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      } as SessionV1.Part
    })

    const create = Effect.fn("Session.create")(function* (input?: {
      parentID?: SessionID
      internal?: string
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      metadata?: typeof Metadata.Type
      permission?: PermissionV1.Ruleset
      workspaceID?: WorkspaceV2.ID
    }) {
      const ctx = yield* InstanceState.context
      const workspace = yield* InstanceState.workspaceID
      return yield* createNext({
        parentID: input?.parentID,
        internal: input?.internal,
        directory: ctx.directory,
        path: sessionPath(ctx.worktree, ctx.directory),
        title: input?.title,
        agent: input?.agent,
        model: input?.model,
        metadata: input?.metadata,
        permission: input?.permission,
        workspaceID: input?.workspaceID ?? workspace,
      })
    })

    const fork = Effect.fn("Session.fork")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const ctx = yield* InstanceState.context
      const original = yield* get(input.sessionID)
      const title = getForkedTitle(original.title)
      const session = yield* createNext({
        directory: ctx.directory,
        path: sessionPath(ctx.worktree, ctx.directory),
        workspaceID: original.workspaceID,
        title,
        metadata: structuredClone(original.metadata),
      })
      const msgs = yield* messages({ sessionID: input.sessionID })
      const idMap = new Map<string, MessageID>()

      for (const msg of msgs) {
        if (input.messageID && msg.info.id >= input.messageID) break
        const newID = MessageID.ascending()
        idMap.set(msg.info.id, newID)

        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        // Copied history was paid for in the original session, so the copy carries no spend of its own.
        const info: SessionV1.Info =
          msg.info.role === "assistant" ? { ...msg.info, cost: 0, unpriced: undefined, forked: true } : msg.info
        const cloned = yield* updateMessage({
          ...info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })

        for (const part of msg.parts) {
          const p: SessionV1.Part = {
            ...(part.type === "step-finish"
              ? {
                  ...part,
                  cost: 0,
                  unpriced: undefined,
                  billing: undefined,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                }
              : part),
            id: PartID.ascending(),
            messageID: cloned.id,
            sessionID: session.id,
          }
          if (p.type === "compaction" && p.tail_start_id) {
            p.tail_start_id = idMap.get(p.tail_start_id)
          }
          yield* updatePart(p)
        }
      }
      return session
    })

    const patch = (sessionID: SessionID, info: Patch) =>
      Effect.gen(function* () {
        const current = yield* get(sessionID)
        const next = {
          ...current,
          ...info,
          time: info.time ? { ...current.time, ...info.time } : current.time,
          share: info.share === null ? undefined : info.share ? { ...current.share, ...info.share } : current.share,
          summary: info.summary === null ? undefined : (info.summary ?? current.summary),
          revert: info.revert === null ? undefined : (info.revert ?? current.revert),
          permission: info.permission === null ? undefined : (info.permission ?? current.permission),
        } as Info
        yield* events.publish(SessionV1.Event.Updated, { sessionID, info: next })
      })

    const touch = Effect.fn("Session.touch")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setTitle = Effect.fn("Session.setTitle")(function* (input: { sessionID: SessionID; title: string }) {
      yield* patch(input.sessionID, { title: input.title }).pipe(Effect.orDie)
    })

    const setArchived = Effect.fn("Session.setArchived")(function* (input: { sessionID: SessionID; time?: number }) {
      yield* patch(input.sessionID, { time: { archived: input.time } }).pipe(Effect.orDie)
    })

    const setMetadata = Effect.fn("Session.setMetadata")(function* (input: typeof SetMetadataInput.Type) {
      yield* patch(input.sessionID, { metadata: input.metadata, time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setAgentModel = Effect.fn("Session.setAgentModel")(function* (input: {
      sessionID: SessionID
      agent: string
      model: NonNullable<Info["model"]>
      time: number
    }) {
      yield* patch(input.sessionID, {
        agent: input.agent,
        model: input.model,
        time: { updated: input.time },
      }).pipe(Effect.orDie)
    })

    const setPermission = Effect.fn("Session.setPermission")(function* (input: {
      sessionID: SessionID
      permission: PermissionV1.Ruleset
    }) {
      yield* patch(input.sessionID, { permission: [...input.permission], time: { updated: Date.now() } }).pipe(
        Effect.orDie,
      )
    })

    const setRevert = Effect.fn("Session.setRevert")(function* (input: {
      sessionID: SessionID
      revert: Info["revert"]
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, {
        summary: input.summary,
        time: { updated: Date.now() },
        revert: input.revert,
      }).pipe(Effect.orDie)
    })

    const clearRevert = Effect.fn("Session.clearRevert")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() }, revert: null }).pipe(Effect.orDie)
    })

    const setSummary = Effect.fn("Session.setSummary")(function* (input: {
      sessionID: SessionID
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { time: { updated: Date.now() }, summary: input.summary }).pipe(Effect.orDie)
    })

    const setShare = Effect.fn("Session.setShare")(function* (input: { sessionID: SessionID; share: Info["share"] }) {
      yield* patch(input.sessionID, { share: input.share ?? null, time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setWorkspace = Effect.fn("Session.setWorkspace")(function* (input: {
      sessionID: SessionID
      workspaceID: Info["workspaceID"]
    }) {
      yield* patch(input.sessionID, { workspaceID: input.workspaceID, time: { updated: Date.now() } }).pipe(
        Effect.orDie,
      )
    })

    const diff = Effect.fn("Session.diff")(function* (sessionID: SessionID) {
      void sessionID
      return [] as Snapshot.FileDiff[]
    })

    const messages: Interface["messages"] = Effect.fn("Session.messages")(function* (input) {
      if (input.limit) {
        return (yield* MessageV2.page({ sessionID: input.sessionID, limit: input.limit }).pipe(
          Effect.provideService(Database.Service, database),
        )).items
      }

      const size = 50
      const result = [] as SessionV1.WithParts[]
      let before: string | undefined
      while (true) {
        const page = yield* MessageV2.page({ sessionID: input.sessionID, limit: size, before }).pipe(
          Effect.provideService(Database.Service, database),
        )
        if (page.items.length === 0) break
        for (let i = page.items.length - 1; i >= 0; i--) {
          const item = page.items[i]
          if (item) result.push(item)
        }
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
      return result.reverse()
    })

    const removeMessage = Effect.fn("Session.removeMessage")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* events.publish(SessionV1.Event.MessageRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    })

    const removePart = Effect.fn("Session.removePart")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
    }) {
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    })

    const updatePartDelta = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
      field: string
      delta: string
    }) {
      yield* events.publish(MessageV2.Event.PartDelta, input)
    })

    /** Finds the first message matching the predicate, searching newest-first. */
    const findMessage: Interface["findMessage"] = Effect.fn("Session.findMessage")(function* (sessionID, predicate) {
      const size = 50
      let before: string | undefined
      while (true) {
        const page = yield* MessageV2.page({ sessionID, limit: size, before }).pipe(
          Effect.provideService(Database.Service, database),
        )
        if (page.items.length === 0) break
        for (let i = page.items.length - 1; i >= 0; i--) {
          const item = page.items[i]
          if (item && predicate(item)) return Option.some(item)
        }
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
      return Option.none<SessionV1.WithParts>()
    })

    return Service.of({
      list,
      listGlobal,
      usage,
      create,
      fork,
      touch,
      get,
      setTitle,
      setArchived,
      setMetadata,
      setAgentModel,
      setPermission,
      setRevert,
      clearRevert,
      setSummary,
      setShare,
      setWorkspace,
      diff,
      messages,
      children,
      remove,
      updateMessage,
      removeMessage,
      removePart,
      updatePart,
      getPart,
      updatePartDelta,
      findMessage,
    })
  }),
)

const cancelBackgroundJobs = Effect.fn("Session.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  yield* Effect.forEach(
    jobs.filter((job) => {
      if (job.status !== "running") return false
      if (job.id === sessionID) return true
      if (job.metadata?.sessionId === sessionID) return true
      return job.metadata?.parentSessionId === sessionID
    }),
    (job) => background.cancel(job.id),
    { concurrency: "unbounded", discard: true },
  )
})

const decodeStepTokens = Schema.decodeUnknownOption(Schema.fromJsonString(Tokens))
const decodeStepModel = Schema.decodeUnknownOption(Schema.fromJsonString(Model))

// V2 steps in the shape usage summarizes, rows ordered by session and sequence. A step is attributed to the prompt
// before it, as a v1 response is to its user message; a compaction summary, which names no model, to the model of the
// step before it, and is marked as a summary as v1 marks its compactions.
export function stepUsage(
  rows: ReadonlyArray<{
    id: string
    sessionID: SessionID
    type: string
    created: number
    completed: number | null
    agent: string | null
    model: string | null
    cost: number | null
    unpriced: number | null
    billing?: string | null
    tokens: string | null
    finish: string | null
    error: string | null
  }>,
) {
  const prompt = new Map<string, MessageID>()
  const model = new Map<string, typeof Model.Type>()
  return rows.flatMap((row): (typeof SessionV1.Assistant.Type)[] => {
    if (row.type === "user") {
      prompt.set(row.sessionID, MessageID.make(row.id))
      return []
    }
    const stepModel = Option.getOrUndefined(decodeStepModel(row.model)) ?? model.get(row.sessionID)
    if (stepModel) model.set(row.sessionID, stepModel)
    const tokens = Option.getOrUndefined(decodeStepTokens(row.tokens))
    if (!stepModel || !tokens || row.cost === null) return []
    return [
      {
        id: MessageID.make(row.id),
        sessionID: row.sessionID,
        role: "assistant",
        parentID: prompt.get(row.sessionID) ?? MessageID.make(row.id),
        time: { created: row.created, ...(row.completed === null ? {} : { completed: row.completed }) },
        modelID: stepModel.id,
        providerID: stepModel.providerID,
        ...(stepModel.variant ? { variant: stepModel.variant } : {}),
        mode: row.agent ?? "",
        agent: row.agent ?? "",
        path: { cwd: "", root: "" },
        cost: row.cost,
        tokens,
        ...(row.unpriced ? { unpriced: true } : {}),
        ...(row.billing === "codium" ? { billing: "codium" as const } : {}),
        ...(row.type === "compaction" ? { summary: true } : {}),
        ...(row.finish ? { finish: row.finish } : {}),
        // Only whether the step failed matters to usage; the error itself stays in the session.
        ...(row.error ? { error: { name: "UnknownError", data: { message: "The step failed." } } } : {}),
      },
    ]
  })
}

// helpers maps each helper session to the helper that ran it. Their tokens and cost count like any other; they are not
// conversations or tasks of the user's, so they are left out of those counts and reported per helper instead.
export function summarizeUsage(
  messages: ReadonlyArray<typeof SessionV1.Info.Type>,
  ancillary: ReadonlyArray<typeof SessionEvent.AncillaryUsage.data.Type> = [],
  helpers: ReadonlyMap<string, string> = new Map(),
): UsageSummary {
  const assistant = messages.filter((message) => message.role === "assistant").filter((message) => !message.forked)
  const own = assistant.filter((message) => !helpers.has(message.sessionID))
  const metered = assistant.filter((message) => !Billing.of(message))
  const days = assistant.reduce((result, message) => {
    const tokens = usageTokens(message)
    const date = localDateKey(message.time.created)
    const current = result.get(date) ?? { date, tokens: 0, cost: 0, codium: 0, tasks: new Set<string>() }
    if (!helpers.has(message.sessionID)) current.tasks.add(`${message.sessionID}:${message.parentID}`)
    result.set(date, {
      date,
      tokens: current.tokens + tokens,
      cost: current.cost + (Billing.of(message) ? 0 : Math.max(0, message.cost)),
      codium: current.codium + (Billing.of(message) ? 1 : 0),
      tasks: current.tasks,
    })
    return result
  }, new Map<string, { date: string; tokens: number; cost: number; codium: number; tasks: Set<string> }>())
  // Archive imports remap sessions and event IDs, but preserve the identity of the paid attempt.
  const attempts = new Map<string, typeof SessionEvent.AncillaryUsage.data.Type | undefined>()
  const same = Schema.toEquivalence(SessionEvent.AncillaryUsage.data)
  ancillary.forEach((usage) => {
    if (!attempts.has(usage.usageID)) {
      attempts.set(usage.usageID, usage)
      return
    }
    const previous = attempts.get(usage.usageID)
    if (previous && !same(previous, { ...usage, sessionID: previous.sessionID })) attempts.set(usage.usageID, undefined)
  })
  attempts.forEach((usage) => {
    // Conflicting copies have no trustworthy amount or date; count one unknown attempt below.
    if (!usage) return
    const date = localDateKey(DateTime.toEpochMillis(usage.timestamp))
    const current = days.get(date) ?? { date, tokens: 0, cost: 0, codium: 0, tasks: new Set<string>() }
    days.set(date, {
      ...current,
      cost: current.cost + (Billing.of(usage) ? 0 : Math.max(0, usage.cost ?? 0)),
      tokens: current.tokens + usageTokens({ ...usage, tokens: usage.tokens ?? EmptyTokens }),
      codium: current.codium + (Billing.of(usage) ? 1 : 0),
    })
  })
  const activity = [...days.values()]
    .map(
      (day): UsageDay => ({
        date: day.date,
        tokens: day.tokens,
        cost: day.cost,
        tasks: day.tasks.size,
        ...(day.codium ? { codium: day.codium } : {}),
      }),
    )
    .sort((a, b) => a.date.localeCompare(b.date))
  const active = new Set(activity.filter((day) => day.tasks > 0).map((day) => day.date))
  const currentStreak = streakEndingAt(
    active,
    active.has(localDateKey(Date.now())) ? new Date() : previousDate(new Date()),
  )
  const longestStreak = activity.reduce(
    (result, day) => {
      if (day.tasks <= 0) return result
      const consecutive = result.previous && localDateKey(nextDate(result.previous)) === day.date
      const current = consecutive ? result.current + 1 : 1
      return { current, longest: Math.max(result.longest, current), previous: dateFromKey(day.date) }
    },
    { current: 0, longest: 0, previous: undefined as Date | undefined },
  ).longest

  const lifetimeTokens = activity.reduce((total, day) => total + day.tokens, 0)
  const completed = new Set(
    own
      .filter(
        (message) => !message.summary && !message.error && (message.time.completed !== undefined || message.finish),
      )
      .map((message) => `${message.sessionID}:${message.parentID}`),
  )
  const modelGroups = metered.reduce((result, message) => {
    const modelID = message.modelID.endsWith("-fast") ? message.modelID.slice(0, -5) : message.modelID
    const key = `${message.providerID}\n${modelID}`
    const current = result.get(key) ?? { providerID: message.providerID, modelID, tokens: 0, responses: 0 }
    result.set(key, {
      ...current,
      tokens: current.tokens + usageTokens(message),
      responses: current.responses + 1,
    })
    return result
  }, new Map<string, Omit<UsageModel, "percentage">>())
  const effortGroups = metered.reduce((result, message) => {
    const effort = usageEffort(message.variant)
    const current = result.get(effort.id) ?? { ...effort, tokens: 0, responses: 0 }
    result.set(effort.id, {
      ...current,
      tokens: current.tokens + usageTokens(message),
      responses: current.responses + 1,
    })
    return result
  }, new Map<string, Omit<UsageEffort, "percentage">>())
  const transcriptTokens = metered.reduce((total, message) => total + usageTokens(message), 0)
  const percentage = (tokens: number, responses: number) => {
    const totalResponses = metered.length
    const share = transcriptTokens > 0 ? tokens / transcriptTokens : totalResponses > 0 ? responses / totalResponses : 0
    return Math.round(share * 1_000) / 10
  }
  // Task timing describes the user's own replies; an autocomplete or review pass is not a task, as in the counts above.
  const durations = own
    .filter((message) => message.time.completed !== undefined)
    .map((message) => ({
      ms: Math.max(0, (message.time.completed ?? message.time.created) - message.time.created),
      tokens: usageTokens(message),
    }))
  const longest = durations.reduce((a, b) => (b.ms > a.ms ? b : a), { ms: 0, tokens: 0 })
  const unpricedResponses =
    assistant.filter((message) => message.unpriced || Billing.of(message)).length +
    [...attempts.values()].filter(
      (usage) =>
        !usage ||
        Billing.of(usage) ||
        usage.unpriced ||
        usage.incomplete ||
        usage.cost === undefined ||
        usage.tokens === undefined,
    ).length
  const codiumResponses =
    assistant.length - metered.length + [...attempts.values()].filter((usage) => usage && Billing.of(usage)).length
  const helperGroups = [
    ...assistant.map((message) => ({
      sessionID: message.sessionID,
      responses: 1,
      tokens: usageTokens(message),
      cost: Billing.of(message) ? 0 : Math.max(0, message.cost),
      codiumSteps: Billing.of(message) ? 1 : 0,
    })),
    ...[...attempts.values()].flatMap((usage) =>
      usage
        ? [
            {
              sessionID: usage.sessionID,
              responses: 0,
              tokens: usageTokens({ ...usage, tokens: usage.tokens ?? EmptyTokens }),
              cost: Billing.of(usage) ? 0 : Math.max(0, usage.cost ?? 0),
              codiumSteps: Billing.of(usage) ? 1 : 0,
            },
          ]
        : [],
    ),
  ].reduce((result, item) => {
    const id = helpers.get(item.sessionID)
    if (!id) return result
    const current = result.get(id) ?? { id, sessions: new Set<string>(), responses: 0, tokens: 0, cost: 0 }
    current.sessions.add(item.sessionID)
    result.set(id, {
      ...current,
      responses: current.responses + item.responses,
      tokens: current.tokens + item.tokens,
      cost: current.cost + item.cost,
      ...((current.codiumSteps ?? 0) + item.codiumSteps
        ? { codiumSteps: (current.codiumSteps ?? 0) + item.codiumSteps }
        : {}),
    })
    return result
  }, new Map<string, Omit<UsageHelper, "sessions"> & { sessions: Set<string> }>())
  const helperUsage = [...helperGroups.values()]
    .map((helper): UsageHelper => ({ ...helper, sessions: helper.sessions.size }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.id.localeCompare(b.id))

  const tokens = [
    ...metered.map((message) => message.tokens),
    ...[...attempts.values()].flatMap((usage) => (usage?.tokens && !Billing.of(usage) ? [usage.tokens] : [])),
  ]
  return {
    lifetimeTokens,
    lifetimeCost: activity.reduce((total, day) => total + day.cost, 0),
    ...(unpricedResponses ? { unpricedResponses } : {}),
    ...(codiumResponses ? { codiumResponses } : {}),
    inputTokens: tokens.reduce((total, tokens) => total + Math.max(0, Math.round(tokens.input)), 0),
    outputTokens: tokens.reduce((total, tokens) => total + Math.max(0, Math.round(tokens.output)), 0),
    reasoningTokens: tokens.reduce((total, tokens) => total + Math.max(0, Math.round(tokens.reasoning)), 0),
    cachedTokens: tokens.reduce(
      (total, tokens) => total + Math.max(0, Math.round(tokens.cache.read + tokens.cache.write)),
      0,
    ),
    peakTokens: activity.reduce((peak, day) => Math.max(peak, day.tokens), 0),
    longestTaskMs: longest.ms,
    longestTaskTokens: longest.tokens,
    averageTaskMs: durations.length
      ? Math.round(durations.reduce((sum, item) => sum + item.ms, 0) / durations.length)
      : 0,
    currentStreak,
    longestStreak,
    completedChats: completed.size,
    conversations: new Set(own.map((message) => message.sessionID)).size,
    activeDays: active.size,
    averageTokensPerChat: completed.size > 0 ? Math.round(lifetimeTokens / completed.size) : 0,
    modelResponses: assistant.length,
    favoriteModels: [...modelGroups.values()]
      .map((model): UsageModel => ({ ...model, percentage: percentage(model.tokens, model.responses) }))
      .sort((a, b) => b.tokens - a.tokens || b.responses - a.responses || a.modelID.localeCompare(b.modelID))
      .slice(0, 5),
    effortLevels: [...effortGroups.values()]
      .map((effort): UsageEffort => ({ ...effort, percentage: percentage(effort.tokens, effort.responses) }))
      .sort((a, b) => b.tokens - a.tokens || b.responses - a.responses || a.label.localeCompare(b.label)),
    days: activity,
    ...(helperUsage.length ? { helpers: helperUsage } : {}),
  }
}

function usageTokens(
  message: Pick<typeof SessionV1.Assistant.Type, "tokens"> & {
    billing?: string
    providerID?: string
    model?: { providerID?: string }
  },
) {
  if (Billing.of(message)) return 0
  const components =
    message.tokens.input +
    message.tokens.output +
    message.tokens.reasoning +
    message.tokens.cache.read +
    message.tokens.cache.write
  return Math.max(0, Math.round(Math.max(message.tokens.total ?? 0, components)))
}

function usageEffort(input: string | undefined) {
  const effort = input?.toLowerCase() ?? "default"
  if (effort === "none" || effort === "default") return { id: "default", label: "Default" }
  if (effort === "minimal" || effort === "low") return { id: "light", label: "Light" }
  if (effort === "medium") return { id: "balanced", label: "Balanced" }
  if (effort === "high") return { id: "extra", label: "Extra" }
  if (effort === "xhigh" || effort === "max" || effort === "ultra") return { id: "max", label: "Max" }
  return {
    id: effort,
    label: effort.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
  }
}

function streakEndingAt(active: Set<string>, date: Date) {
  let streak = 0
  let cursor = date
  while (active.has(localDateKey(cursor))) {
    streak += 1
    cursor = previousDate(cursor)
  }
  return streak
}

function localDateKey(input: number | Date) {
  const date = typeof input === "number" ? new Date(input) : input
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-")
}

function dateFromKey(input: string) {
  const [year = 0, month = 1, day = 1] = input.split("-").map(Number)
  return new Date(year, month - 1, day)
}

function nextDate(input: Date) {
  const date = new Date(input)
  date.setDate(date.getDate() + 1)
  return date
}

function previousDate(input: Date) {
  const date = new Date(input)
  date.setDate(date.getDate() - 1)
  return date
}

function listByProject(
  db: Database.Interface["db"],
  input: ListInput & {
    projectID: ProjectV2.ID
    experimentalWorkspaces: boolean
  },
) {
  const conditions = [eq(SessionTable.project_id, input.projectID)]

  if (input.workspaceID) {
    conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
  }
  if (input.path !== undefined) {
    if (input.path) {
      const conds = [
        eq(SessionTable.path, input.path),
        like(SessionTable.path, sql.param(`${input.path}/%`, SessionTable.path)),
      ]

      conditions.push(
        input.directory
          ? or(...conds, and(isNull(SessionTable.path), eq(SessionTable.directory, input.directory))!)!
          : or(...conds)!,
      )
    }
  } else if (input.scope !== "project") {
    if (input.directory) {
      conditions.push(eq(SessionTable.directory, input.directory))
    }
  }
  if (input.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  // Vector's helper sessions are reached through the session or surface that launched them, never listed.
  if (!input.internal) {
    conditions.push(isNull(SessionTable.internal))
  }
  if (input.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }

  const limit = input.limit ?? 100

  return db
    .select()
    .from(SessionTable)
    .where(and(...conditions))
    .orderBy(desc(SessionTable.time_updated))
    .limit(limit)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(fromRow)),
    )
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [BackgroundJob.node, RuntimeFlags.node, Database.node, EventV2Bridge.node, ShareNext.node],
})

export * as Session from "./session"
