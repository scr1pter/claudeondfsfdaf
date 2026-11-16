import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { Global } from "@vectordevai/core/global"
import { Connect } from "@vectordevai/schema/connect"
import { ConnectDirectoryRequest } from "@/connect/directory-request"

const value: { data: string; scope: ConnectDirectoryRequest.Scope; input: Connect.DirectoryReviewInput } = JSON.parse(
  process.argv[2] ?? "null",
)
const global = Global.layerWith({
  home: path.join(value.data, "home"),
  data: value.data,
  cache: path.join(value.data, "cache"),
  config: path.join(value.data, "config"),
  state: path.join(value.data, "state"),
  bin: path.join(value.data, "bin"),
  log: path.join(value.data, "log"),
})
const layer = AppNodeBuilder.build(ConnectDirectoryRequest.node, [[Global.node, global]])
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const requests = yield* ConnectDirectoryRequest.Service
    return yield* requests.reserve(value.scope, value.input).pipe(
      Effect.match({
        onSuccess: (start) => ({ kind: start.kind }),
        onFailure: (error) => ({ kind: "refused", code: error.code }),
      }),
    )
  }).pipe(Effect.provide(layer)),
)
process.stdout.write(JSON.stringify(result) + "\n")
