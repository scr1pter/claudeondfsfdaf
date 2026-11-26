// Local-only card retrieval. The model/route policy is checked again before each actual private
// dispatch. The runner owns the session audience and records usage for the posting boundary.
import { Cause, Effect, Option } from "effect"
import type { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { freeModelMayTrain } from "@vectordevai/core/free-model-choice"
import type { ReviewConfig } from "@vectordevai/core/review/types"
import { Provider } from "@/provider/provider"
import { ReviewRoutes } from "./route"
import { ReviewContext } from "./context"
import type { ResolvedModel } from "./model"

type CardGrant = ReviewContext.CardGrant
const minted = new WeakMap<CardGrant, { pathKey: string; publicOnly: boolean }>()
// The normal policy path below is the only issuer. Calling the source reader or copying a payload cannot
// grant permission to send private text to a different model or to a shared review.
function grantCards(input: CardGrant): CardGrant | undefined {
  const binding = ReviewContext.consumeSources(input)
  if (!binding) return
  const grant = Object.freeze({
    ...input,
    items: Object.freeze(input.items.map((row) => Object.freeze({ ...row }))),
    models: Object.freeze([...input.models]),
  })
  minted.set(grant, { pathKey: binding.pathKey, publicOnly: binding.publicOnly })
  return grant
}
export function publicCardGrant(
  grant: CardGrant | undefined,
  input: { directory: string; base: string; head: string; files: ReviewContext.CardsInput["files"] },
) {
  const bound = grant && minted.get(grant)
  return !!(
    grant &&
    bound?.publicOnly &&
    grant.directory === input.directory &&
    grant.base === input.base &&
    grant.head === input.head &&
    bound.pathKey === ReviewContext.changeKey(input.files) &&
    !grant.items.some((row) => row.personal)
  )
}

export function takeCards(
  grant: CardGrant | undefined,
  input: { directory: string; base: string; head: string; files: ReviewContext.CardsInput["files"] },
) {
  if (!grant) return
  const key = minted.get(grant)
  minted.delete(grant)
  if (
    key !== undefined &&
    grant.directory === input.directory &&
    grant.base === input.base &&
    grant.head === input.head &&
    key.pathKey === ReviewContext.changeKey(input.files)
  )
    return grant
}

export type Request = Omit<ReviewContext.CardsInput, "place" | "personal"> & {
  models: ResolvedModel[]
  config: ReviewConfig
  mayUsePrivate: boolean
  onPrivateUnavailable?: () => void
}

// A no-training catalogue entry alone cannot hold the next retry. The free transport refreshes
// its catalogue and reads account consent immediately before sending. Only a destination the
// existing session and transport checks can hold on every turn may receive a personal card.
export const privateRoutes = Effect.fn("ReviewCardAccess.privateRoutes")(function* (
  provider: Provider.Interface,
  models: readonly ResolvedModel[],
  config: ReviewConfig,
) {
  if (!models.length) return
  const rule: ReviewRoutes.Policy = {
    privacy: "zdr",
    attested: structuredClone(config.privacy === "zdr" ? ReviewRoutes.policyOf(config).attested : []),
  }
  const key = (policy: ReviewRoutes.Policy, route: ReviewRoutes.Decided) =>
    JSON.stringify([policy, route.key, route.decidedOn, route.decision])
  const approved = new Map<string, string>()
  for (const model of models) {
    const found = yield* provider.getModel(model.providerID, model.modelID).pipe(Effect.option)
    if (Option.isNone(found) || freeModelMayTrain(found.value)) return
    const route = yield* ReviewRoutes.decide(provider, { ...model, found: found.value }, rule)
    if (
      !route.decision.allowed ||
      !route.key ||
      !route.decidedOn ||
      route.decision.kind === "standard" ||
      (config.privacy !== "zdr" && route.decision.kind !== "loopback")
    )
      return
    approved.set(model.providerID + "/" + model.modelID, key(rule, route))
  }
  return (name: string, policy: ReviewRoutes.Policy, route?: ReviewRoutes.Decided) =>
    !!route && approved.get(name) === key(policy, route)
})

export const collect = Effect.fn("ReviewCardAccess.collect")(function* (
  input: Request,
  place: Brain.Place,
  privateStorage: boolean,
) {
  const knowledge = yield* BrainKnowledge.Service
  const provider = yield* Provider.Service
  const canUsePersonal = input.trust === "trusted" && !input.shared && input.mayUsePrivate
  const allowsRoute = canUsePersonal && privateStorage
    ? Option.getOrUndefined(
        yield* privateRoutes(provider, input.models, input.config).pipe(
          Effect.timeoutOption(Math.max(0, input.deadline - performance.now())),
        ),
      )
    : undefined
  if (canUsePersonal && !allowsRoute) input.onPrivateUnavailable?.()
  const personal = !!allowsRoute
  const items = yield* ReviewContext.cards({ ...input, place, personal })
  if (!items.length) return
  return grantCards({
    items,
    base: input.base,
    head: input.head,
    directory: input.directory,
    models: input.models.map((model) => model.providerID + "/" + model.modelID),
    ...(allowsRoute ? { allowsRoute } : {}),
    ...(privateStorage && items.some((item) => item.personal)
      ? {
          eligible: (ids: readonly string[]) =>
            Effect.gen(function* () {
              // A held, forgotten, replaced or reclassified private source cannot be admitted from a
              // previously gathered snapshot. The posting guard can now resolve each recorded card id.
              const current = yield* knowledge.cards(place, ids, { personal: true })
              const sources = (yield* knowledge.sources(place, ids)).documents
              const docs = new Set(
                sources
                  .filter(
                    (row) =>
                      row.visibility === "private" &&
                      !row.hold &&
                      ["ready", "searchable", "embedding", "partial"].includes(row.status),
                  )
                  .map((row) => row.id),
              )
              if (
                ids.some((id) => {
                  const row = current.find((card) => card.id === id)
                  const shown = items.find((card) => card.id === id)?.text.replace(/^\[(drifted|missing)\] /, "")
                  return (
                    !row || !docs.has(row.document) || !shown || !row.text.replace(/\s+/g, " ").trim().startsWith(shown)
                  )
                })
              )
                return false
              return true
            }).pipe(
              Effect.timeoutOption(2_000),
              Effect.map((result) => Option.getOrElse(result, () => false)),
              Effect.catch(() => Effect.succeed(false)),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterrupts(cause),
                () => Effect.succeed(false),
              ),
            ),
        }
      : {}),
  })
})

export * as ReviewCardAccess from "./card-access"
