import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@vectordevai/core/global"
import { Config } from "@/config/config"
import { PromptTrust } from "@/config/prompt-trust"

/** An explicit owner selection in the isolated test home's real global file, restored byte-for-byte on scope exit. */
export const ownerReviewModel = (model = "lmstudio/test-model") =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const file = path.join(Global.Path.config, "vector.json")
    const original = yield* Effect.promise(() =>
      fs.readFile(file).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
        throw error
      }),
    )
    yield* Effect.acquireRelease(
      Effect.promise(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, JSON.stringify({ agent: { vectorscope: { model } } }))
      }).pipe(Effect.andThen(PromptTrust.accept([file])), Effect.andThen(config.invalidate())),
      () =>
        Effect.promise(async () => {
          if (original === undefined) await fs.rm(file, { force: true })
          else await fs.writeFile(file, original)
        }).pipe(Effect.andThen(PromptTrust.accept([file])), Effect.andThen(config.invalidate())),
    )
    expect((yield* config.getGlobal()).agent?.vectorscope?.model).toBe(model)
  })
