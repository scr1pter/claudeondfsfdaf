import { Billing } from "@vectordevai/schema/billing"
import { Effect, Stream } from "effect"
import { EventV2 } from "../../event"
import { Integration } from "../../integration"
import { FreeModels } from "../../free-models"
import { ModelPlans } from "../../model-plans"
import { define } from "../internal"

/** Vector Codium: the signed-in account's managed coding models, listed from vectordev.ai and never from configuration. */
export const VectorPlanPlugin = define({
  id: Billing.CODIUM_PROVIDER_ID,
  effect: Effect.fn(function* (ctx) {
    const plans = yield* ModelPlans.Service
    const credentials = yield* FreeModels.CredentialsService
    const events = yield* EventV2.Service
    // What the catalog last listed; undefined until the first listing, which then reads the answer itself.
    const listed: { enabled?: boolean } = {}
    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const token = yield* credentials.get("vector")
        const current = yield* plans.catalog(token)
        listed.enabled = current.enabled
        // Account entitlements, prices and destinations cannot come from repository configuration.
        catalog.provider.remove(ModelPlans.PROVIDER_ID)
        if (!current.enabled) return
        catalog.provider.update(ModelPlans.PROVIDER_ID, (provider) => {
          provider.name = ModelPlans.PROVIDER_NAME
          provider.disabled = false
          provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: ModelPlans.API_URL }
        })
        // Every entry, with what its listing says: Codium Auto (sent to its default model at prepare), models the plan
        // does not include and manual-only lanes. Nothing automatic picks those (the V2 default skips Codium).
        for (const model of current.models)
          catalog.model.update(ModelPlans.PROVIDER_ID, model.id, (draft) => {
            draft.name = model.name
            draft.api = { id: model.id, type: "aisdk", package: "@ai-sdk/openai-compatible", url: ModelPlans.API_URL }
            draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
            // No dollar price: a Codium step spends credits, so it is recorded unpriced and left out of dollar totals.
            draft.cost = []
            draft.limit = { context: model.contextLength, output: model.maxOutputTokens }
            draft.codium = ModelPlans.listing(model)
            draft.enabled = true
          })
      }),
    )
    // Listing answers within a short deadline, so a first read slower than that lists no Codium. Wait for
    // vectordev.ai's answer once and list Codium as soon as it arrives instead of a minute later.
    yield* Effect.gen(function* () {
      const token = yield* credentials.get("vector")
      const current = yield* plans.catalog(token, { wait: true })
      if (current.enabled && listed.enabled === false) yield* ctx.catalog.reload()
    }).pipe(Effect.forkScoped({ startImmediately: true }))
    yield* events.subscribe(Integration.Event.Updated).pipe(
      Stream.runForEach(() => ctx.catalog.reload()),
      Effect.forkScoped({ startImmediately: true }),
    )
    // A plan bought or cancelled in the browser shows up without restarting Vector.
    yield* Effect.forever(Effect.sleep("1 minute").pipe(Effect.andThen(ctx.catalog.reload()))).pipe(Effect.forkScoped())
  }),
})
