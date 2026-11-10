import { FileSystem } from "@vectordevai/core/filesystem"
import { AppProcess } from "@vectordevai/core/process"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { Location } from "@vectordevai/core/location"
import { RelativePath } from "@vectordevai/core/schema"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { RequestOwner } from "../request-owner"
import { FileAccess } from "../fs-access"
import path from "node:path"

export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    const audience = yield* SessionAudience.Service
    const process = yield* AppProcess.Service
    const access = FileAccess.make({ audience, process })
    return handlers
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          const location = yield* Location.Service
          const owner = yield* RequestOwner.owner
          const selected = RelativePath.make(
            decodeURIComponent(new URL(ctx.request.url, "http://localhost").pathname.slice(13)),
          )
          const target = path.resolve(location.directory, selected)
          yield* access(target, owner)
          const fs = yield* FileSystem.Service
          const file = yield* fs.read({ path: selected })
          yield* access(target, owner)
          return HttpServerResponse.uint8Array(file.content, { contentType: file.mime })
        }),
      )
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            const location = yield* Location.Service
            const owner = yield* RequestOwner.owner
            const target = path.resolve(location.directory, ctx.query.path ?? "")
            yield* access(target, owner, true)
            const entries = yield* fs.list(ctx.query)
            yield* access(target, owner, true)
            return entries
          }),
        ),
      )
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            const location = yield* Location.Service
            const owner = yield* RequestOwner.owner
            yield* access(location.directory, owner, true)
            const entries = yield* fs.find(ctx.query)
            yield* access(location.directory, owner, true)
            return entries
          }),
        ),
      )
  }),
)
