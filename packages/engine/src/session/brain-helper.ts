export * as SessionBrainHelper from "./brain-helper"

import { Effect, Option } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import type { BrainSchema } from "@vectordevai/core/brain/schema"
import { freeModelMayTrain } from "@vectordevai/core/free-model-choice"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Billing } from "@vectordevai/schema/billing"
import { Provider } from "@/provider/provider"
import { Instruction } from "./instruction"
import { SessionMemory } from "./memory"
import type { SessionID } from "./schema"
import { Session } from "./session"

type Setting = "skillDrafter" | "modelLearner"

/** Explicit helper-off and Vector Local win over the separate Codium opt-in. */
export function allowed(input: {
  readonly setting: BrainSchema.SkillDrafter
  readonly local: boolean
  readonly codium?: boolean
  readonly consent?: BrainSchema.CodiumHelpers
}) {
  if (input.setting === "off") return false
  if (input.codium) return !input.local && input.consent === "on"
  return input.setting === "always" || input.local
}

/** Select only after reading the personal setting; catalog absence never authorizes a paid fallback. */
export const choose = Effect.fn("SessionBrainHelper.choose")(function* (input: {
  readonly setting: Setting
  readonly primary: Provider.Model
}) {
  const brain = yield* Brain.Service
  const provider = yield* Provider.Service
  const settings = yield* brain.learnSettings()
  if (!settings.learning || settings[input.setting] === "off" || freeModelMayTrain(input.primary)) return undefined
  const local = Egress.policy().enabled
  if (!local && settings.codiumHelpers === "on") {
    const model = yield* provider.getBrainModel()
    return model && !freeModelMayTrain(model) ? model : undefined
  }
  if (Billing.isCodium(input.primary.providerID)) return undefined
  if (!allowed({ setting: settings[input.setting], local })) return undefined
  const model = (yield* provider.getSmallModel(input.primary.providerID, input.primary.id)) ?? input.primary
  // A small_model config cannot grant Codium consent or bypass the floor-only rule.
  return Billing.isCodium(model.providerID) || freeModelMayTrain(model) ? undefined : model
})

/** Recheck a deferred helper immediately before sending content, including revocation and Local mode changes. */
export const permitted = Effect.fn("SessionBrainHelper.permitted")(function* (model: Provider.Model, setting: Setting) {
  const brain = yield* Brain.Service
  const provider = yield* Provider.Service
  const codium = Billing.isCodium(model.providerID)
  const floor = codium ? yield* provider.getBrainModel() : undefined
  const settings = yield* brain.learnSettings()
  if (!settings.learning || freeModelMayTrain(model)) return false
  if (!allowed({ setting: settings[setting], local: Egress.policy().enabled, codium, consent: settings.codiumHelpers }))
    return false
  if (!codium) return true
  return floor?.providerID === model.providerID && floor.id === model.id
})

/** Read current privacy state after catalog waits; captured request taint cannot authorize a deferred dispatch. */
export const privateInput = Effect.fn("SessionBrainHelper.privateInput")(function* (sessionID: SessionID) {
  const guests = yield* FreeModelGuests.Service
  const instruction = yield* Instruction.Service
  const sessions = yield* Session.Service
  if (yield* guests.marked(sessionID)) return false
  if ((yield* instruction.place()).held) return false
  const messages = yield* sessions.messages({ sessionID }).pipe(Effect.option)
  return Option.isSome(messages) && SessionMemory.taint(messages.value) === undefined
})

/** Bind the owning services once so a deferred helper does not carry unresolved runtime requirements. */
export function bind(input: {
  readonly brain: Brain.Interface
  readonly provider: Provider.Interface
  readonly guests: FreeModelGuests.Interface
  readonly instruction: Instruction.Interface
  readonly sessions: Session.Interface
}) {
  const models = <A, E>(effect: Effect.Effect<A, E, Brain.Service | Provider.Service>) =>
    effect.pipe(
      Effect.provideService(Brain.Service, input.brain),
      Effect.provideService(Provider.Service, input.provider),
    )
  return {
    choose: (input: Parameters<typeof choose>[0]) => models(choose(input)),
    permitted: (model: Provider.Model, setting: Setting) => models(permitted(model, setting)),
    privateInput: (sessionID: SessionID) =>
      privateInput(sessionID).pipe(
        Effect.provideService(FreeModelGuests.Service, input.guests),
        Effect.provideService(Instruction.Service, input.instruction),
        Effect.provideService(Session.Service, input.sessions),
      ),
  }
}
