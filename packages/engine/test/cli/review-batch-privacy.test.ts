import { $ } from "bun"
import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { decodeState } from "@vectordevai/core/review/state"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { executeLocalReview } from "@/cli/cmd/review"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Review } from "@/review/run"
import { Instruction } from "@/session/instruction"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { TestInstance, trustWorkspace } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer, reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Git.node,
      Brain.node,
      Instruction.node,
      SessionPrompt.node,
      Session.node,
      SpendGuard.node,
      Permission.node,
      Provider.node,
      EventV2Bridge.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.loopback, deps: [] }),
    ]),
  ),
)

it.instance(
  "a funded batch that privacy refused before its first attempt settles the journal and allows a later capped retry",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const model = yield* TestLLMServer
      const leaf = path.join(directory, ".git", "vector", "review", "feature.json")
      const readReceipt = () =>
        Effect.promise(async () => {
          const row = JSON.parse(await fs.readFile(leaf, "utf8"))
          const state = decodeState(row.state)
          if (!state) throw new Error("The CLI did not write a valid review receipt.")
          return { state, metadata: row.batch }
        })
      yield* Effect.promise(async () => {
        const config = testProviderConfig(model.url)
        config.provider.lmstudio.models["test-model"].cost = { input: 1, output: 2 }
        await fs.writeFile(path.join(directory, "vector.json"), JSON.stringify(config))
        await $`git branch -M main`.cwd(directory).quiet()
        await fs.mkdir(path.join(directory, ".vector"), { recursive: true })
        await fs.writeFile(
          path.join(directory, ".vector", "review.json"),
          JSON.stringify({ largeChanges: "batch", maxFiles: 1, security: "off", verify: "off" }),
        )
        await $`git add .vector/review.json`.cwd(directory).quiet()
        await $`git commit -qm settings`.cwd(directory).quiet()
        await $`git checkout -qb feature`.cwd(directory).quiet()
        for (const name of ["a.ts", "b.ts"]) await fs.writeFile(path.join(directory, name), "export const n = 1\n")
        await $`git add a.ts b.ts`.cwd(directory).quiet()
        await $`git commit -qm change`.cwd(directory).quiet()
        await trustWorkspace(directory)
      })
      const journals: string[] = []
      const provider = yield* Provider.Service
      const info = yield* provider.getProvider(ProviderV2.ID.make("lmstudio"))
      const forwarded = info.options.forwards
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (forwarded === undefined) delete info.options.forwards
          else info.options.forwards = forwarded
        }),
      )
      let refuseAfterBegin = true
      const invoke = () =>
        executeLocalReview(
          { directory, base: "main", json: true, env: { REVIEW_PRIVACY: "zdr", REVIEW_MAX_COST_USD: "2" } },
          {
            resolveModel: () =>
              Effect.succeed({
                providerID: ProviderV2.ID.make("lmstudio"),
                modelID: ModelV2.ID.make("test-model"),
                context: 128000,
                costKind: "priced" as const,
                price: { input: 1, output: 2 },
              }),
            runReview: (input) => {
              const store = input.batchStore
              const begin = store?.begin
              if (!store || !begin) return Review.run(input)
              return Review.run({
                ...input,
                batchStore: {
                  ...store,
                  begin: (plan, cursor) =>
                    begin(plan, cursor).pipe(
                      Effect.tap(() =>
                        readReceipt().pipe(
                          Effect.map(({ state }) => {
                            journals.push(state.inflight?.run ?? "")
                            if (refuseAfterBegin) info.options.forwards = true
                          }),
                        ),
                      ),
                    ),
                },
              })
            },
            stdout: async () => {},
            stderr: () => {},
            posting: async () => {
              throw new Error("A local batch cannot post")
            },
            confirm: async () => false,
          },
        )
      // The same in-memory loopback model becomes ineligible after the charged journal is durable.
      // The second invocation keeps the identical model, plan, cap and commit.
      const withheld = yield* invoke()
      expect(withheld.exitCode).toBe(2)
      expect(yield* model.calls).toBe(0)
      if (process.platform !== "linux") {
        expect(withheld.outcome?.notes.join(" ")).toContain("trusted review-state store")
        expect(journals).toEqual([])
        return
      }
      expect(withheld.outcome?.partial).toBe("privacy")
      expect(journals).toHaveLength(1)
      expect(journals[0]).toMatch(/^batch:/)
      const stopped = yield* readReceipt()
      expect(stopped.state.inflight).toBeUndefined()
      expect(stopped.state.costUsd).toBe(0)
      expect(stopped.state.reviews).toBe(0)
      expect(stopped.state.batch?.completed).toBe(0)
      expect(stopped.state.head).toBeUndefined()
      expect(stopped.metadata.usageMissing).toBeUndefined()
      expect(stopped.metadata.uncertainMonth).toBeUndefined()
      yield* model.push(
        reply()
          .tool("StructuredOutput", { summary: "Checked the file.", risk: "low", files: [], findings: [] })
          .usage({ input: 50, output: 10 }),
      )
      refuseAfterBegin = false
      if (forwarded === undefined) delete info.options.forwards
      else info.options.forwards = forwarded
      const retry = yield* invoke()
      expect(retry.outcome?.notes.join(" "), retry.error).toContain("1 of 2 batches complete")
      expect(yield* model.calls).toBe(1)
      expect(journals).toHaveLength(2)
      const settled = yield* readReceipt()
      expect(settled.state.inflight).toBeUndefined()
      expect(settled.state.batch?.completed).toBe(1)
      expect(settled.state.costUsd).toBeGreaterThan(0)
      expect(settled.state.reviews).toBe(1)
    }),
  { git: true },
  90_000,
)
