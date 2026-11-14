import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Instruction } from "@/session/instruction"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionBrainHelper } from "@/session/brain-helper"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const own = ProviderTest.model()
const floor = ProviderTest.model({ providerID: ProviderV2.ID.make("vector-plan"), id: ModelV2.ID.make("vendor/floor") })
const defaults: Brain.LearnSettings = {
  learning: true,
  facets: { format: true, workflow: true, vocabulary: true, tooling: true, sources: true, style: true },
  modelLearner: "local-only",
  skills: "review",
  skillDrafter: "local-only",
  codiumHelpers: "ask",
  workflow: "apply",
  workflowExplore: false,
}

it.effect(
  "the dispatch privacy check reads current taint, guest marking and trust after deferred model selection",
  () => {
    const sessionID = SessionID.make("ses_brain_privacy")
    const state = { agent: "build", held: false, guest: false }
    return Effect.gen(function* () {
      expect(yield* SessionBrainHelper.privateInput(sessionID)).toBe(true)
      state.agent = "research"
      expect(yield* SessionBrainHelper.privateInput(sessionID)).toBe(false)
      state.agent = "build"
      state.guest = true
      expect(yield* SessionBrainHelper.privateInput(sessionID)).toBe(false)
      state.guest = false
      state.held = true
      expect(yield* SessionBrainHelper.privateInput(sessionID)).toBe(false)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(FreeModelGuests.Service, { marked: () => Effect.succeed(state.guest) }),
          Layer.mock(Instruction.Service, {
            place: () => Effect.succeed({ repository: "repo", root: "/repo", sources: [], held: state.held }),
          }),
          Layer.mock(Session.Service, {
            messages: () =>
              Effect.succeed([
                {
                  info: {
                    id: MessageID.make("msg_brain_privacy"),
                    sessionID,
                    role: "user",
                    time: { created: 1 },
                    agent: state.agent,
                    model: { providerID: own.providerID, modelID: own.id },
                  },
                  parts: [],
                },
              ]),
          }),
        ),
      ),
    )
  },
)

it.effect("an opted-in helper uses only the floor, skips its absence, and rechecks revocation before sending", () => {
  const state = { settings: defaults, floor: floor as typeof floor | undefined }
  return Effect.gen(function* () {
    expect(yield* SessionBrainHelper.choose({ primary: floor, setting: "skillDrafter" })).toBeUndefined()
    state.settings = { ...defaults, codiumHelpers: "on" }
    expect(yield* SessionBrainHelper.choose({ primary: own, setting: "skillDrafter" })).toBe(floor)
    expect(yield* SessionBrainHelper.permitted(floor, "skillDrafter")).toBe(true)
    state.floor = undefined
    expect(yield* SessionBrainHelper.choose({ primary: own, setting: "skillDrafter" })).toBeUndefined()
    expect(yield* SessionBrainHelper.permitted(floor, "skillDrafter")).toBe(false)
    state.floor = floor
    state.settings = { ...defaults, codiumHelpers: "off", skillDrafter: "always" }
    expect(yield* SessionBrainHelper.permitted(floor, "skillDrafter")).toBe(false)
    expect(yield* SessionBrainHelper.choose({ primary: floor, setting: "skillDrafter" })).toBeUndefined()
    state.settings = { ...defaults, codiumHelpers: "on", learning: false }
    expect(yield* SessionBrainHelper.choose({ primary: own, setting: "skillDrafter" })).toBeUndefined()
    expect(yield* SessionBrainHelper.permitted(floor, "skillDrafter")).toBe(false)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(Brain.Service, {
          files: () => ({ memory: "", rules: "" }),
          learnSettings: () => Effect.succeed(state.settings),
        }),
        ProviderTest.fake({ getBrainModel: () => Effect.succeed(state.floor) }).layer,
      ),
    ),
  )
})

it.effect(
  "an own helper override cannot grant Codium consent and trainable primary data never reaches the floor",
  () => {
    const state = { settings: { ...defaults, modelLearner: "always" as const } }
    return Effect.gen(function* () {
      expect(yield* SessionBrainHelper.choose({ primary: own, setting: "modelLearner" })).toBeUndefined()
      state.settings = { ...state.settings, codiumHelpers: "on" }
      expect(
        yield* SessionBrainHelper.choose({
          primary: ProviderTest.model({ freeModel: { source: "openrouter", dataPolicy: "may-train" } }),
          setting: "modelLearner",
        }),
      ).toBeUndefined()
      state.settings = { ...state.settings, learning: false }
      expect(yield* SessionBrainHelper.permitted(own, "modelLearner")).toBe(false)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Brain.Service, {
            files: () => ({ memory: "", rules: "" }),
            learnSettings: () => Effect.succeed(state.settings),
          }),
          ProviderTest.fake({ getSmallModel: () => Effect.succeed(floor), getBrainModel: () => Effect.succeed(floor) })
            .layer,
        ),
      ),
    )
  },
)
