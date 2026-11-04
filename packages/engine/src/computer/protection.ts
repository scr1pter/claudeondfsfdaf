import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Instruction } from "@/session/instruction"

const PATHS_MAX = 4096
const PATH_MAX = 16384
const METADATA_MAX = 1024 * 1024
const Path = Schema.String.check(Schema.isMaxLength(PATH_MAX))
const Paths = Schema.Array(Path).check(Schema.isMaxLength(PATHS_MAX))

/** Trusted engine metadata only. Instruction contents never cross the desktop bridge. */
export const Result = Schema.Struct({ paths: Paths, directories: Paths }).annotate({
  identifier: "ComputerProtection.Result",
})
export type Result = typeof Result.Type

export class Error extends Schema.TaggedErrorClass<Error>()("ComputerProtectionError", {}) {}

export interface Interface {
  readonly read: () => Effect.Effect<Result, Error>
}
export class Service extends Context.Service<Service, Interface>()("@vector/ComputerProtection") {}

/** Keep both spellings: a linked directory and a file not created yet protect the same destination. */
export function resolveProtection(input: {
  directory: string
  home: string
  paths: Iterable<string>
  instructions: readonly string[]
  directories: readonly string[]
}): Result {
  let bytes = Buffer.byteLength(JSON.stringify({ paths: [], directories: [] }))
  const values = (items: Iterable<string>) => {
    const result = new Set<string>()
    for (const item of items) {
      if (!item || item.length > PATH_MAX || item.includes("\0")) throw new Error()
      const absolute = path.resolve(
        input.directory,
        item.startsWith("~/") ? path.join(input.home, item.slice(2)) : item,
      )
      for (const spelling of [absolute, FSUtil.realpath(absolute)]) {
        if (spelling.length > PATH_MAX) throw new Error()
        if (result.has(spelling)) continue
        // Account for UTF-8, JSON escaping and commas across both arrays before retaining more metadata.
        bytes += Buffer.byteLength(JSON.stringify(spelling)) + (result.size > 0 ? 1 : 0)
        if (bytes > METADATA_MAX) throw new Error()
        result.add(spelling)
        if (result.size > PATHS_MAX) throw new Error()
      }
    }
    return [...result]
  }
  return {
    paths: values([
      ...input.paths,
      // systemPaths expands globs; explicit paths remain protected before they exist as well.
      ...input.instructions.filter((file) => !/^https?:/i.test(file) && !/[?*\[\]{}]/.test(file)),
    ]),
    directories: values(input.directories),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const instructions = yield* Instruction.Service
    const config = yield* Config.Service
    const brain = yield* Brain.Service
    const global = yield* Global.Service
    return Service.of({
      read: Effect.fn("ComputerProtection.read")(function* () {
        const current = yield* config.get()
        const system = yield* instructions.systemPaths().pipe(Effect.mapError(() => new Error()))
        const instance = yield* InstanceState.context
        return yield* Effect.try({
          try: () =>
            resolveProtection({
              directory: instance.directory,
              home: global.home,
              paths: [...system, ...Object.values(brain.files())],
              instructions: current.instructions ?? [],
              directories: [global.config, global.data, global.state],
            }),
          catch: () => new Error(),
        })
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Instruction.node, Config.node, Brain.node, Global.node],
})

export * as ComputerProtection from "./protection"
