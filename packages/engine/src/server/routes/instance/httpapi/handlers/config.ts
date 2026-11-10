import { Config } from "@/config/config"
import { PromptTrust } from "@/config/prompt-trust"
import { Flag } from "@vectordevai/core/flag/flag"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Redaction } from "@vectordevai/core/redaction"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi } from "../api"
import { ConfigLockedError, PromptTrustApproval } from "../groups/config"
import { markInstanceForDisposal } from "../lifecycle"

/** The refusal for a change to keys a company lock keeps, in the words the app shows. */
export function configLocked(keys: readonly string[]) {
  return new ConfigLockedError({
    name: "ConfigLocked",
    data: {
      keys: [...keys],
      message: `Set by your company. Ask your administrator to change ${keys.length === 1 ? "it" : "them"}: ${keys.join(", ")}.`,
    },
  })
}

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    // Every client of the server reads config, including guests invited with
    // `vector invite`, so stored keys go out as Redaction.MARKER. Config.update
    // treats a MARKER sent back as "unchanged".
    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return { ...Redaction.redactConfig(yield* configSvc.get()), locked: Config.lockedKeys() }
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      // This writes the repository's vector.json, whose local block never applies.
      const locked = Config.lockedIn(ctx.payload, "repository")
      if (locked.length > 0) return yield* configLocked(locked)
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return Redaction.redactConfig(ctx.payload)
    })

    const trust = Effect.fn("ConfigHttpApi.trust")(function* () {
      const status = yield* configSvc.trust()
      const principal = yield* RequestPrincipal
      return {
        workspace: status.workspace,
        trusted: status.trusted,
        ignored: status.ignored,
        settings: status.settings,
        // The same rule that refuses a guest's approval below, so the two cannot drift apart.
        approvable: principal.kind === "owner" || !ServerAuth.isOwnerOnlyRoute("POST", "/config/trust"),
      }
    })

    // Approves what the config was loaded from, then reloads the instance so the trusted config takes effect.
    const approveTrust = Effect.fn("ConfigHttpApi.approveTrust")(function* () {
      if (Flag.VECTOR_PURE) return yield* new HttpApiError.BadRequest({})
      yield* configSvc.approve().pipe(Effect.catchDefect(() => Effect.fail(new HttpApiError.BadRequest({}))))
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return yield* trust()
    })

    // Held prompt files are the owner's own paths, and approving them loads what an agent may have written, so neither is
    // a guest's, whatever the server lets a guest read.
    const owner = Effect.fn("ConfigHttpApi.owner")(function* () {
      if ((yield* RequestPrincipal).kind !== "owner") return yield* new HttpApiError.Forbidden({})
    })

    const promptTrust = Effect.fn("ConfigHttpApi.promptTrust")(function* () {
      yield* owner()
      const files = yield* PromptTrust.status(yield* PromptTrust.current(configSvc))
      return { held: files.map((file) => file.path), files }
    })

    // Approves the held prompt files the owner was shown, unchanged, then reloads the instance so it loads them. A file
    // held or changed after the list was read is never approved unseen: the request fails and the owner reads again.
    const approvePromptTrust = Effect.fn("ConfigHttpApi.approvePromptTrust")(function* (ctx: {
      payload: typeof PromptTrustApproval.Type
    }) {
      yield* owner()
      const result = yield* PromptTrust.approve({
        config: configSvc,
        sources: yield* PromptTrust.current(configSvc),
        shown: ctx.payload.files,
      })
      if (result.refused) return yield* new HttpApiError.Conflict({})
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return { approved: result.approved.length }
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toClientInfo),
        default: Provider.defaultModelIDs(providers),
        unavailable: yield* providerSvc.unavailable(),
      }
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("trust", trust)
      .handle("approveTrust", approveTrust)
      .handle("promptTrust", promptTrust)
      .handle("approvePromptTrust", approvePromptTrust)
      .handle("providers", providers)
  }),
)
