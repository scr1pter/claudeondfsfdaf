export * as SessionArchive from "./archive"

import path from "node:path"
import { and, asc, eq, inArray } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { PublicSession } from "@vectordevai/schema/public-session"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { optional } from "@vectordevai/schema/schema"
import { SessionV1 } from "../v1/session"
import { SessionSchema } from "../session/schema"
import { SessionMessage } from "../session/message"
import { SessionEvent } from "../session/event"
import { SessionProjector } from "../session/projector"
import { SessionTable, SessionMessageTable, MessageTable, PartTable } from "../session/sql"
import { fromRow, subagentTokens } from "../session/info"
import { Location } from "../location"
import { ProjectV2 } from "../project"
import { ProjectTable } from "../project/sql"
import { Slug } from "../util/slug"
import { InstallationVersion } from "../installation/version"
import { ModelV2 } from "../model"
import { encodedBody } from "./transport"
import { BrainSchema } from "../brain/schema"
import { BrainSkill } from "../brain/skill"
import { SessionAudience } from "../session/audience"

const AncillaryUsage = Schema.Array(SessionEvent.AncillaryUsage.data).pipe(optional)
// A portable local archive can only tighten its audience, including after importing into another database.
const Privacy = Schema.optional(Schema.Literal("owner-only"))
const GuestInput = Schema.optional(Schema.Literal(true))
export const Legacy = Schema.Struct({
  privacy: Privacy,
  guestInput: GuestInput,
  info: SessionV1.SessionInfo,
  messages: Schema.Array(SessionV1.WithParts),
  ancillaryUsage: AncillaryUsage,
})
export type Legacy = typeof Legacy.Type
export const Native = Schema.Struct({
  privacy: Privacy,
  guestInput: GuestInput,
  format: Schema.Literal("vector-session"),
  version: Schema.Literal(1),
  engine: Schema.Literal("v2"),
  info: SessionSchema.Info,
  messages: Schema.Array(SessionMessage.Message),
  ancillaryUsage: AncillaryUsage,
})
export type Native = typeof Native.Type
export type Local = Legacy | Native
export type Selection = { sessionID: SessionSchema.ID; engine?: "v1" | "v2" }

export interface Interface {
  readonly export: (input: Selection) => Effect.Effect<Local, PublicSession.Error>
  readonly preview: (input: Selection) => Effect.Effect<PublicSession.Archive, PublicSession.Error>
  readonly import: (input: {
    archive: unknown
    location: Location.Ref
    targetEngine?: "v1" | "v2"
  }) => Effect.Effect<{ sessionID: SessionSchema.ID; engine: "v1" | "v2" }, PublicSession.Error>
}
export class Service extends Context.Service<Service, Interface>()("@vector/SessionArchive") {}

const invalid = () =>
  new PublicSession.Error({
    code: "INVALID",
    message: "This file does not contain a supported Vector session archive.",
  })
const safeName = (value: string | undefined) => path.basename((value ?? "Attachment").replaceAll("\\", "/"))
const json = (value: unknown) => JSON.stringify(value) ?? ""
const partText = (part: PublicSession.Part) =>
  part.type === "tool"
    ? `${part.name} (${part.status})\nInput:\n${part.input}\nOutput:\n${part.output}`
    : part.type === "attachment"
      ? `[Attachment: ${part.name} (${part.mediaType}); content is not included]`
      : part.text
// A learned skill's steps never leave this computer in a public archive: its transcript keeps only the placeholder, and
// whatever a part's output says, the archive carries that placeholder too.
const learnedSkill = (tool: string, metadata: Record<string, unknown>) =>
  tool === "skill" && typeof metadata.learned === "string"
    ? BrainSkill.placeholder(
        typeof metadata.name === "string" ? metadata.name : "learned skill",
        typeof metadata.version === "number" ? metadata.version : 0,
      )
    : undefined
const importedModel = Schema.decodeUnknownSync(ModelV2.Ref)({
  providerID: "vector",
  id: "imported",
  variant: "default",
})

export function publicArchive(local: Local): PublicSession.Archive {
  const messages: PublicSession.Message[] =
    "engine" in local
      ? local.messages.flatMap((message): PublicSession.Message[] => {
          if (message.type === "system" || message.type === "synthetic") return []
          const parts: PublicSession.Part[] =
            message.type === "user"
              ? [
                  { type: "text", text: message.text },
                  ...(message.files ?? []).map((file) => ({
                    type: "attachment" as const,
                    name: safeName(file.name),
                    mediaType: file.mime,
                  })),
                ]
              : message.type === "assistant"
                ? message.content.map((part): PublicSession.Part => {
                    if (part.type !== "tool") return { type: part.type, text: part.text }
                    return {
                      type: "tool",
                      name: part.name,
                      callID: part.id,
                      status:
                        part.state.status === "pending" || part.state.status === "running"
                          ? "interrupted"
                          : part.state.status,
                      input: typeof part.state.input === "string" ? part.state.input : json(part.state.input),
                      output:
                        "content" in part.state
                          ? part.state.content
                              .map((item) => (item.type === "text" ? item.text : "[Tool attachment omitted]"))
                              .join("\n") + ("error" in part.state ? `\n${part.state.error.message}` : "")
                          : "",
                    }
                  })
                : [
                    {
                      type: "text",
                      text:
                        message.type === "shell"
                          ? `$ ${message.command}\n${message.output}`
                          : message.type === "compaction"
                            ? message.summary
                            : message.type === "agent-switched"
                              ? `Agent changed to ${message.agent}`
                              : `Model changed to ${message.model.providerID}/${message.model.id}`,
                    },
                  ]
          return [
            {
              id: message.id,
              role:
                message.type === "user" || message.type === "assistant" || message.type === "shell"
                  ? message.type
                  : "notice",
              createdAt: DateTime.toEpochMillis(message.time.created),
              parts,
            },
          ]
        })
      : local.messages.map((message) => ({
          id: message.info.id,
          role: message.info.role,
          createdAt: message.info.time.created,
          parts: message.parts.flatMap((part): PublicSession.Part[] => {
            if (part.type === "text" && (part.synthetic || part.ignored)) return []
            if (part.type === "text" || part.type === "reasoning") return [{ type: part.type, text: part.text }]
            if (part.type === "tool")
              return [
                {
                  type: "tool",
                  name: part.tool,
                  callID: part.callID,
                  status:
                    part.state.status === "pending" || part.state.status === "running"
                      ? "interrupted"
                      : part.state.status,
                  input: json(part.state.input),
                  output:
                    part.state.status === "completed"
                      ? (learnedSkill(part.tool, part.state.metadata) ?? part.state.output)
                      : part.state.status === "error"
                        ? part.state.error
                        : "",
                },
              ]
            if (part.type === "file")
              return [{ type: "attachment", name: safeName(part.filename), mediaType: part.mime }]
            if (part.type === "subtask") return [{ type: "text", text: `${part.description}\n${part.prompt}` }]
            return []
          }),
        }))
  return Schema.decodeUnknownSync(PublicSession.Archive)({
    version: 1,
    engine: "engine" in local ? "v2" : "v1",
    title: local.info.title,
    messages,
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const audience = SessionAudience.make({ db })
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const exportArchive = Effect.fn("SessionArchive.export")(function* (input: Selection) {
      // One read transaction gives the audience flags and the rows one snapshot. A fence only adds rows, so content
      // written after it is not in this snapshot either. Encoding and decoding the history, the slow part, run after the
      // snapshot is released, and a read takes no write lock, so an export never holds back another engine's writes.
      const read = yield* db
        .transaction(() =>
          Effect.gen(function* () {
            const row = yield* db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, input.sessionID))
              .get()
              .pipe(Effect.orDie)
            if (!row) return undefined
            const privacy = (yield* audience.isPrivate(input.sessionID)) ? ("owner-only" as const) : undefined
            const guestInput = (yield* audience.hasGuestInput(input.sessionID)) ? (true as const) : undefined
            const usage = yield* db
              .select({ data: EventTable.data })
              .from(EventTable)
              .where(
                and(
                  eq(EventTable.aggregate_id, input.sessionID),
                  inArray(EventTable.type, SessionEvent.AncillaryUsageStored),
                ),
              )
              .orderBy(asc(EventTable.seq))
              .all()
              .pipe(Effect.orDie)
            const native = yield* db
              .select()
              .from(SessionMessageTable)
              .where(eq(SessionMessageTable.session_id, input.sessionID))
              .orderBy(asc(SessionMessageTable.seq))
              .all()
              .pipe(Effect.orDie)
            if (input.engine === "v2" || native.length)
              return { row, privacy, guestInput, usage, native, messages: [], parts: [] }
            const messages = yield* db
              .select()
              .from(MessageTable)
              .where(eq(MessageTable.session_id, input.sessionID))
              .orderBy(asc(MessageTable.id))
              .all()
              .pipe(Effect.orDie)
            const parts = yield* db
              .select()
              .from(PartTable)
              .where(eq(PartTable.session_id, input.sessionID))
              .orderBy(asc(PartTable.id))
              .all()
              .pipe(Effect.orDie)
            return { row, privacy, guestInput, usage, native, messages, parts }
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))
      if (!read) return yield* new PublicSession.Error({ code: "NOT_FOUND", message: "Session not found." })
      const ancillaryUsage = read.usage.length
        ? read.usage.map((event) => Schema.decodeUnknownSync(SessionEvent.AncillaryUsage.data)(event.data))
        : undefined
      if (input.engine === "v2" || read.native.length)
        return Native.make({
          privacy: read.privacy,
          guestInput: read.guestInput,
          format: "vector-session",
          version: 1,
          engine: "v2",
          info: fromRow(read.row),
          messages: read.native.map((message) =>
            Schema.decodeUnknownSync(SessionMessage.Message)({ ...message.data, id: message.id, type: message.type }),
          ),
          ancillaryUsage,
        })
      const row = read.row
      return Schema.decodeUnknownSync(Schema.fromJsonString(Legacy))(
        JSON.stringify({
          privacy: read.privacy,
          guestInput: read.guestInput,
          ancillaryUsage: ancillaryUsage?.map((usage) => Schema.encodeSync(SessionEvent.AncillaryUsage.data)(usage)),
          info: {
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
            model: row.model ?? undefined,
            version: row.version,
            cost: row.cost,
            unpricedSteps: row.unpriced_steps || undefined,
            codiumSteps: row.codium_steps || undefined,
            tokensOwnOnly: row.tokens_own_only,
            subagentTokensOwnOnly: row.subagent_tokens_own_only,
            subagentCost: row.subagent_cost || undefined,
            subagentUnpricedSteps: row.subagent_unpriced_steps || undefined,
            subagentCodiumSteps: row.subagent_codium_steps || undefined,
            subagentTokens: subagentTokens(row),
            tokens: {
              input: row.tokens_input,
              output: row.tokens_output,
              reasoning: row.tokens_reasoning,
              cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
            },
            share: row.share_url ? { url: row.share_url } : undefined,
            metadata: row.metadata ?? undefined,
            permission: row.permission ?? undefined,
            revert: row.revert ?? undefined,
            summary:
              row.summary_files !== null
                ? {
                    additions: row.summary_additions ?? 0,
                    deletions: row.summary_deletions ?? 0,
                    files: row.summary_files,
                    diffs: row.summary_diffs ?? undefined,
                  }
                : undefined,
            time: {
              created: row.time_created,
              updated: row.time_updated,
              archived: row.time_archived ?? undefined,
              compacting: row.time_compacting ?? undefined,
            },
          },
          messages: read.messages.map((message) => ({
            info: { ...message.data, id: message.id, sessionID: input.sessionID },
            parts: read.parts
              .filter((part) => part.message_id === message.id)
              .map((part) => ({ ...part.data, id: part.id, messageID: message.id, sessionID: input.sessionID })),
          })),
        }),
      )
    })

    const importArchive = Effect.fn("SessionArchive.import")(function* (input: {
      archive: unknown
      location: Location.Ref
      targetEngine?: "v1" | "v2"
    }) {
      const archive = Option.getOrUndefined(
        Schema.decodeUnknownOption(PublicSession.Archive, { onExcessProperty: "error" })(input.archive),
      )
      const local = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Union([Native, Legacy]))(input.archive))
      if (!archive && !local) return yield* invalid()
      if (
        local?.ancillaryUsage &&
        new Set(local.ancillaryUsage.map((usage) => usage.usageID)).size !== local.ancillaryUsage.length
      )
        return yield* invalid()
      if (input.targetEngine && !archive)
        return yield* new PublicSession.Error({
          code: "INVALID",
          message:
            "Only portable public transcripts can be imported into a different engine. Full local archives retain their engine.",
        })
      const identities = archive
        ? archive.messages.map((message) => message.id)
        : local && "engine" in local
          ? local.messages.map((message) => message.id)
          : local!.messages.map((message) => message.info.id)
      if (new Set(identities).size !== identities.length) return yield* invalid()
      if (
        archive?.messages.some(
          (message) => !Number.isSafeInteger(message.createdAt) || message.createdAt > 8_640_000_000_000_000,
        )
      )
        return yield* invalid()
      if (archive)
        yield* Effect.try({
          try: () => encodedBody(archive),
          catch: () =>
            new PublicSession.Error({
              code: "TOO_LARGE",
              message: "The public session exceeds Vector's import size limit.",
            }),
        })
      const source = archive
        ? { ...archive, engine: input.targetEngine ?? archive.engine }
        : { title: local!.info.title, engine: "engine" in local! ? ("v2" as const) : ("v1" as const), messages: [] }
      const sessionID = SessionSchema.ID.create()
      const project = yield* projects.resolve(input.location.directory)
      yield* db
        .insert(ProjectTable)
        .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const info = SessionV1.SessionInfo.make({
        id: sessionID,
        slug: Slug.create(),
        projectID: project.id,
        directory: input.location.directory,
        ...(input.location.workspaceID ? { workspaceID: input.location.workspaceID } : {}),
        title: source.title,
        // Local read provenance never crosses an archive boundary, including an empty or tampered archive.
        tokensOwnOnly: false,
        subagentTokensOwnOnly: false,
        version: InstallationVersion,
        time: { created: Date.now(), updated: Date.now() },
      })
      const sequence: EventV2.SerializedEvent[] = []
      const append = <D extends EventV2.Definition>(definition: D, data: EventV2.Data<D>) =>
        sequence.push({
          id: EventV2.ID.create(),
          type: EventV2.versionedType(definition.type, definition.durable!.version),
          seq: sequence.length,
          aggregateID: sessionID,
          data: Schema.encodeUnknownSync(definition.data)(data) as Record<string, unknown>,
        })
      append(SessionV1.Event.Created, { sessionID, info })
      if (local && "engine" in local) {
        for (const message of local.messages) {
          const id = SessionMessage.ID.create()
          const value: SessionMessage.Message =
            message.type === "assistant"
              ? {
                  ...message,
                  id,
                  snapshot: undefined,
                  finish: "stop",
                  time: { ...message.time, completed: message.time.completed ?? message.time.created },
                  error: message.error ? { type: "unknown", message: message.error.message } : undefined,
                  content: message.content.map((part) =>
                    part.type !== "tool"
                      ? { ...part, id: crypto.randomUUID() }
                      : {
                          ...part,
                          id: crypto.randomUUID(),
                          time: { ...part.time, completed: part.time.completed ?? message.time.created },
                          state:
                            part.state.status === "pending" || part.state.status === "running"
                              ? {
                                  status: "error",
                                  input: part.state.status === "running" ? part.state.input : {},
                                  structured: {},
                                  content: [],
                                  error: {
                                    type: "unknown",
                                    message: "This operation was not executed when the session was imported.",
                                  },
                                }
                              : part.state,
                        },
                  ),
                }
              : message.type === "synthetic"
                ? { ...message, id, sessionID }
                : message.type === "shell"
                  ? {
                      ...message,
                      id,
                      callID: crypto.randomUUID(),
                      time: { ...message.time, completed: message.time.completed ?? message.time.created },
                    }
                  : { ...message, id }
          append(SessionEvent.MessageImported, { sessionID, timestamp: message.time.created, message: value })
        }
      }
      if (local && !("engine" in local)) {
        const ids = new Map(local.messages.map((message) => [message.info.id, SessionV1.MessageID.ascending()]))
        if (ids.size !== local.messages.length) return yield* invalid()
        for (const message of local.messages) {
          const id = ids.get(message.info.id)!
          const value = Schema.decodeUnknownSync(SessionV1.Info)(
            message.info.role === "user"
              ? { ...message.info, id, sessionID }
              : {
                  ...message.info,
                  id,
                  sessionID,
                  parentID: ids.get(message.info.parentID) ?? SessionV1.MessageID.ascending(),
                  path: { cwd: input.location.directory, root: project.directory },
                  finish: "stop",
                  error:
                    message.info.error?.name === "FreeModelsLimitError"
                      ? { name: "UnknownError", data: { message: message.info.error.data.message } }
                      : message.info.error,
                  time: { ...message.info.time, completed: message.info.time.completed ?? message.info.time.created },
                },
          )
          append(SessionV1.Event.MessageUpdated, { sessionID, info: value })
          for (const part of message.parts) {
            const base = { id: SessionV1.PartID.ascending(), sessionID, messageID: id }
            // Pending work is transcript data after import, never a task to replay. Imported text is the archive's, not
            // words the user typed in this session, so it vouches for no memory.
            const value = Schema.decodeUnknownSync(SessionV1.Part)(
              part.type === "subtask" || part.type === "compaction"
                ? {
                    ...base,
                    type: "text",
                    text:
                      part.type === "subtask" ? `${part.description}\n${part.prompt}` : "[Imported compaction marker]",
                    metadata: { [BrainSchema.OUTSIDE]: "import" },
                  }
                : part.type === "tool"
                  ? {
                      ...part,
                      ...base,
                      callID: crypto.randomUUID(),
                      state:
                        part.state.status === "pending" || part.state.status === "running"
                          ? {
                              status: "error",
                              input: part.state.input,
                              error: "This operation was not executed when the session was imported.",
                              time: { start: message.info.time.created, end: message.info.time.created },
                            }
                          : part.state.status === "completed" && part.state.attachments
                            ? {
                                ...part.state,
                                attachments: part.state.attachments.map((attachment) => ({
                                  ...attachment,
                                  id: SessionV1.PartID.ascending(),
                                  sessionID,
                                  messageID: id,
                                })),
                              }
                            : part.state,
                    }
                  : part.type === "text"
                    ? { ...part, ...base, metadata: { ...part.metadata, [BrainSchema.OUTSIDE]: "import" } }
                    : { ...part, ...base },
            )
            append(SessionV1.Event.PartUpdated, { sessionID, time: message.info.time.created, part: value })
          }
        }
      }
      if (!local && source.engine === "v2") {
        for (const message of source.messages) {
          const created = DateTime.makeUnsafe(message.createdAt)
          const text = message.parts.map(partText).join("\n\n")
          const value: SessionMessage.Message =
            message.role === "user"
              ? SessionMessage.User.make({ id: SessionMessage.ID.create(), type: "user", text, time: { created } })
              : SessionMessage.Assistant.make({
                  id: SessionMessage.ID.create(),
                  type: "assistant",
                  agent: "build",
                  model: importedModel,
                  content: [{ id: crypto.randomUUID(), type: "text", text }],
                  finish: "stop",
                  time: { created, completed: created },
                })
          append(SessionEvent.MessageImported, { sessionID, timestamp: created, message: value })
        }
      }
      if (!local && source.engine === "v1") {
        const ids = new Map(source.messages.map((message) => [message.id, SessionV1.MessageID.ascending()]))
        const lastUser = { id: SessionV1.MessageID.ascending() }
        for (const message of source.messages) {
          const id = ids.get(message.id)!
          const base = { id, sessionID, time: { created: message.createdAt } }
          const user = message.role === "user"
          const value = user
            ? SessionV1.User.make({
                ...base,
                role: "user",
                agent: "build",
                model: { providerID: importedModel.providerID, modelID: importedModel.id },
              })
            : SessionV1.Assistant.make({
                ...base,
                time: { ...base.time, completed: message.createdAt },
                role: "assistant",
                parentID: lastUser.id,
                agent: "build",
                mode: "build",
                modelID: importedModel.id,
                providerID: importedModel.providerID,
                path: { cwd: input.location.directory, root: project.directory },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                finish: "stop",
              })
          if (user) lastUser.id = id
          append(SessionV1.Event.MessageUpdated, { sessionID, info: value })
          for (const part of message.parts)
            append(SessionV1.Event.PartUpdated, {
              sessionID,
              time: message.createdAt,
              part: SessionV1.TextPart.make({
                id: SessionV1.PartID.ascending(),
                messageID: id,
                sessionID,
                type: "text",
                text: partText(part),
                // A public transcript's "user" is whoever published it, never the user continuing it here.
                metadata: { [BrainSchema.OUTSIDE]: "import" },
              }),
            })
        }
      }
      // Local archives preserve historical spend; public transcripts and forks carry no ancillary billing records.
      for (const usage of local?.ancillaryUsage ?? []) append(SessionEvent.AncillaryUsage, { ...usage, sessionID })
      // Local source identity is restriction-only provenance; never an imported filesystem location.
      const forkOf = local && (yield* audience.knows(local.info.id)) ? local.info.id : undefined
      const provenance = Effect.gen(function* () {
        // Public transcripts have no authenticated local provenance. Importing them must never erase guest history.
        yield* audience.register({ sessionID, forkOf, actor: archive || local?.guestInput ? "guest" : "owner" })
        if (local?.privacy === "owner-only") yield* audience.fenceIsolation({ sessionID, actor: "owner" })
      }).pipe(
        Effect.catchTag("SessionAudience.Denied", () =>
          Effect.fail(
            new PublicSession.Error({
              code: "INVALID",
              message: "This archive cannot enter the current conversation audience.",
            }),
          ),
        ),
      )
      yield* provenance
      yield* events.importAll(sequence)
      return { sessionID, engine: source.engine }
    })
    return Service.of({
      export: exportArchive,
      preview: (input) =>
        exportArchive(input).pipe(
          Effect.flatMap((value) => Effect.try({ try: () => publicArchive(value), catch: invalid })),
        ),
      import: importArchive,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionProjector.node, ProjectV2.node],
})
