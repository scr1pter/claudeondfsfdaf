import { Database } from "@vectordevai/core/database/database"
import { SessionAccountingOutput } from "@vectordevai/core/session/accounting-output"
// Vector publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@vectordevai/core/event"
import { Location } from "@vectordevai/core/location"
import { Project } from "@vectordevai/core/project"
import { AbsolutePath } from "@vectordevai/core/schema"
import { Context, Effect, Layer } from "effect"

export class Service extends Context.Service<Service, EventV2.Interface>()("@vector/EventV2Bridge") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const database = yield* Database.Service

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      Effect.gen(function* () {
        if (options?.location) return yield* events.publish(definition, data, options)
        const ctx = yield* InstanceRef
        if (!ctx) return yield* events.publish(definition, data, options)
        const workspaceID = yield* WorkspaceRef
        return yield* events.publish(definition, data, {
          ...options,
          location: new Location.Info({
            directory: AbsolutePath.make(ctx.directory),
            ...(workspaceID ? { workspaceID } : {}),
            project: { id: Project.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
          }),
        })
      })

    const unsubscribe = yield* events.listen((raw) =>
      Effect.gen(function* () {
        const event = yield* SessionAccountingOutput.project(database.db, raw)
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: { id: event.id, type: event.type, properties: event.data },
        })
        if (raw.durable === undefined) return
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: {
            type: "sync",
            syncEvent: {
              id: raw.id,
              type: EventV2.versionedType(raw.type, raw.durable.version),
              seq: raw.durable.seq,
              aggregateID: raw.durable.aggregateID,
              data: raw.data,
            },
          },
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({ ...events, publish })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2.node, Database.node] })

export * as EventV2Bridge from "./event-v2-bridge"
