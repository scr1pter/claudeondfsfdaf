import { GithubSecrets } from "@/cli/cmd/github.secrets"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { FreeModels } from "@vectordevai/core/free-models"
import { VectorAccount } from "@vectordevai/core/vector-account"
import { Effect, Layer } from "effect"
import { Auth } from "@/auth"
import { Teams } from "@vectordevai/core/teams"
import { VectorTeams } from "@/teams"
import { makeGlobalNode } from "@vectordevai/core/effect/app-node"
import { BrainWorker } from "@vectordevai/core/brain/worker/host"
import { BrainWorkerSource } from "@/brain/worker-source"

const bootstrapReplacement = [InstanceStore.bootstrapNode, InstanceBootstrap.node] as const

const freeModelCredentials = makeGlobalNode({
  service: FreeModels.CredentialsService,
  layer: Layer.effect(
    FreeModels.CredentialsService,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      return FreeModels.CredentialsService.of({
        get: Effect.fn("FreeModels.legacyCredential")(function* (provider) {
          // A pending run has no account/own-key fallback. Its credential appears only after the starting heartbeat.
          if (GithubSecrets.credentials.pendingRunToken())
            return provider === "vector" ? GithubSecrets.credentials.runToken() : undefined
          const channel =
            provider === "vector"
              ? GithubSecrets.credentials.cliToken()
              : GithubSecrets.credentials.providerKeys().OPENROUTER_API_KEY
          if (channel) return channel
          const environment = process.env[provider === "vector" ? "VECTOR_CLI_TOKEN" : "OPENROUTER_API_KEY"]
          if (environment) return environment
          const stored = yield* auth.get(provider).pipe(Effect.orDie)
          if (stored?.type === "api") return stored.key
          if (provider === "vector") return yield* Effect.promise(() => VectorAccount.readVectorToken())
          return undefined
        }),
      })
    }),
  ),
  deps: [Auth.node],
})

export function build<A, E>(root: LayerNode.Node<A, E, any>, replacements: LayerNode.Replacements = []) {
  return AppNodeBuilder.build(
    root,
    replacements.concat([
      bootstrapReplacement,
      [FreeModels.credentialsNode, freeModelCredentials],
      [Teams.node, VectorTeams.node],
      // The engine's builds carry the background reader's source.
      [BrainWorker.sourceNode, BrainWorkerSource.node],
    ]),
  )
}

export * as AppNodeBuilderV1 from "./app-node-builder-v1"
