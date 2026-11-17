import path from "node:path"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { Global } from "@vectordevai/core/global"
import { Connect } from "@vectordevai/schema/connect"
import { ConnectDirectoryRequest } from "@/connect/directory-request"
import { SessionID } from "@/session/schema"

// One real ledger process. It reserves, then optionally prepares an anchor, refuses with a reason, or holds its token
// and answers one `bind <runID>` line on stdin. Each step prints one JSON line.
const value: {
  data: string
  scope: ConnectDirectoryRequest.Scope
  input: Connect.DirectoryReviewInput
  prepare?: string
  writer?: ConnectDirectoryRequest.Writer
  refuse?: ConnectDirectoryRequest.Reason
  hold?: boolean
} = JSON.parse(process.argv[2] ?? "null")
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
const print = (line: object) => process.stdout.write(JSON.stringify(line) + "\n")
const answer = (step: string, effect: Effect.Effect<void, ConnectDirectoryRequest.Error>) =>
  effect.pipe(
    Effect.match({
      onSuccess: () => ({ step, kind: "ok" }),
      onFailure: (error) => ({ step, kind: "refused", code: error.code }),
    }),
    Effect.map(print),
  )
const line = () =>
  new Promise<string>((resolve) =>
    process.stdin.once("data", (chunk) => {
      process.stdin.destroy()
      resolve(String(chunk))
    }),
  )
await Effect.runPromise(
  Effect.gen(function* () {
    const requests = yield* ConnectDirectoryRequest.Service
    const start = yield* requests.reserve(value.scope, value.input).pipe(Effect.result)
    if (start._tag === "Failure") return print({ kind: "refused", code: start.failure.code })
    print({ kind: start.success.kind })
    if (start.success.kind !== "reserved") return
    const token = start.success.token
    const anchorID = value.prepare ? Schema.decodeUnknownSync(SessionID)(value.prepare) : undefined
    if (anchorID) yield* answer("prepare", requests.prepare(token, anchorID))
    if (value.refuse)
      yield* answer("refuse", requests.refuse(token, { reason: value.refuse, ...(anchorID ? { anchorID } : {}) }))
    if (!value.hold || !anchorID) return
    print({ step: "hold", kind: "ok" })
    const [command, runID] = (yield* Effect.promise(line)).trim().split(" ")
    if (command !== "bind") return
    yield* answer("bind", requests.bind(token, { anchorID, runID: Schema.decodeUnknownSync(Connect.RunID)(runID) }))
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(ConnectDirectoryRequest.Options, {
      graceMs: ConnectDirectoryRequest.GRACE_MS,
      writer: value.writer ?? { pid: process.pid, start: Math.floor(performance.timeOrigin) },
    }),
  ),
)
