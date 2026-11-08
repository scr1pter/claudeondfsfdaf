import { afterAll, afterEach, expect } from "bun:test"
import { Effect, Exit, Layer, Stream } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { codiumGateway, codiumModel } from "../../../core/test/fixture/codium-gateway"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(disposeAllInstances)

const token = "vct_synthetic-private-account.token"
const gateway = codiumGateway(token)
afterAll(() => gateway.stop())

// Codium Auto with a distinct model in each role, so the request shows which one Auto picked.
const floor = { ...codiumModel, id: "vendor/floor", name: "Floor" }
const ceiling = { ...codiumModel, id: "vendor/ceiling", name: "Ceiling" }
const auto = {
  ...codiumModel,
  id: ModelPlans.AUTO_ID,
  name: "Codium Auto",
  auto: { floor: floor.id, default: codiumModel.id, ceiling: ceiling.id },
}
const withAuto: ModelPlans.Catalog = { enabled: true, models: [floor, codiumModel, ceiling, auto] }
const planCatalog = { current: withAuto }

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [
      [
        FreeModels.node,
        Layer.succeed(FreeModels.Service, {
          catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
          forKey: () => Effect.succeed([]),
          trainingConsent: () => Effect.succeed(false),
          setTrainingConsent: (accepted) => Effect.succeed(accepted),
          changes: Stream.empty,
        }),
      ],
      [
        FreeModels.credentialsNode,
        Layer.succeed(FreeModels.CredentialsService, {
          get: (provider) => Effect.succeed(provider === "vector" ? token : undefined),
        }),
      ],
      [
        ModelPlans.node,
        Layer.succeed(ModelPlans.Service, {
          catalog: (value) => Effect.succeed(value === token ? planCatalog.current : { enabled: false, models: [] }),
          request: gateway.forward,
        }),
      ],
    ],
  ),
)

const codiumAuto = {
  providerID: ProviderV2.ID.make(ModelPlans.PROVIDER_ID),
  modelID: ModelV2.ID.make(ModelPlans.AUTO_ID),
}
const chats = (from: number) => gateway.seen.slice(from).filter((item) => item.path === "/api/model-plans/chat")

it.instance("an agent generated on Codium Auto runs on the model Auto picks, read as the stream Codium sends", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    planCatalog.current = withAuto
    gateway.state.mode = "object"
    const before = gateway.seen.length
    const generated = yield* agents.generate({ description: "Check database migrations", model: codiumAuto })
    gateway.state.mode = "ok"
    expect(generated).toEqual({
      identifier: "migration-checker",
      whenToUse: "Checks database migrations before they run.",
      systemPrompt: "You check database migrations.",
    })
    // One request, on Auto's model for standard work: never Codium Auto itself, which the gateway does not serve.
    expect(chats(before).map((item) => (item.body as { model?: string }).model)).toEqual([codiumModel.id])
  }),
)

it.instance(
  "an agent generated on Codium Auto fails with Auto's notice, sending nothing, when the plan offers none",
  () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      // An older gateway's catalog names no Auto.
      planCatalog.current = { enabled: true, models: [codiumModel] }
      const before = gateway.seen.length
      const exit = yield* agents
        .generate({ description: "Check database migrations", model: codiumAuto })
        .pipe(Effect.exit)
      planCatalog.current = withAuto
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(String(exit.cause)).toContain("Codium Auto is not available on your plan right now")
      expect(chats(before)).toEqual([])
    }),
)
