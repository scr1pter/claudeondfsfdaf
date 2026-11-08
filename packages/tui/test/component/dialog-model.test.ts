import { describe, expect, test } from "bun:test"
import { FREE_MODEL_TRAINING_OWNER_ONLY } from "@vectordevai/core/free-model-choice"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import {
  confirmCodiumChoice,
  confirmFreeModelChoice,
  modelDescription,
  sortModelOptions,
} from "../../src/component/dialog-model"

describe("choosing a free model that may train in the TUI", () => {
  const mayTrain = { freeModel: { source: "openrouter" as const, dataPolicy: "may-train" as const } }
  const run = (input: {
    model?: Parameters<typeof confirmFreeModelChoice>[0]["model"]
    consent?: boolean
    answer?: boolean
    recorded?: { training: boolean } | undefined
    status?: number
  }) => {
    const calls: string[] = []
    const asked: string[] = []
    const notices: string[] = []
    const result = confirmFreeModelChoice({
      model: input.model ?? mayTrain,
      freeModels: {
        consent: async () => {
          calls.push("consent")
          return { data: { training: input.consent ?? false } }
        },
        setConsent: async (body: { freeModelConsent: { training: boolean } }) => {
          calls.push(`setConsent:${body.freeModelConsent.training}`)
          return { data: input.recorded, response: new Response(null, { status: input.status ?? 200 }) }
        },
      } as never,
      ask: async (title, message) => {
        calls.push("ask")
        asked.push(`${title}: ${message}`)
        return input.answer ?? false
      },
      notify: (message) => void notices.push(message),
    })
    return result.then((allowed) => ({ allowed, calls, asked, notices }))
  }

  test("no-training and paid models are chosen without a question", async () => {
    for (const model of [{ freeModel: { source: "openrouter" as const, dataPolicy: "no-training" as const } }, {}])
      expect(await run({ model })).toEqual({ allowed: true, calls: [], asked: [], notices: [] })
  })

  test("an earlier acceptance lets the model be chosen at once", async () => {
    expect(await run({ consent: true })).toMatchObject({ allowed: true, calls: ["consent"] })
  })

  test("the user is asked with the label, the disclaimer and what the acceptance covers, and only a recorded yes chooses it", async () => {
    const accepted = await run({ answer: true, recorded: { training: true } })
    expect(accepted).toMatchObject({ allowed: true, calls: ["consent", "ask", "setConsent:true"], notices: [] })
    expect(accepted.asked[0]).toStartWith("May train on your prompts: ")
    expect(accepted.asked[0]).toContain("Vector itself never trains on your prompts")
    expect(accepted.asked[0]).toContain('Accepting covers every free model labelled "May train on your prompts"')
    // Declining keeps the current model and records nothing.
    expect(await run({ answer: false })).toMatchObject({ allowed: false, calls: ["consent", "ask"] })
    // An unreviewed model is asked about the same way.
    const unreviewed = await run({ model: { freeModel: { source: "openrouter", dataPolicy: "unreviewed" } } })
    expect(unreviewed.asked[0]).toContain("has not reviewed")
  })

  test("an invited guest, whose acceptance the engine refuses, is told only the owner can use these models", async () => {
    const guest = await run({ answer: true, recorded: undefined, status: 403 })
    expect(guest).toMatchObject({ allowed: false, notices: [FREE_MODEL_TRAINING_OWNER_ONLY] })
    const failed = await run({ answer: true, recorded: undefined, status: 500 })
    expect(failed.notices[0]).toContain("Try again")
  })
})

describe("Vector Codium in the TUI model list", () => {
  test("Codium Auto leads Vector Codium, which otherwise keeps its catalog's order", () => {
    const option = (title: string, auto = false) => ({ title, releaseDate: "", auto })
    const listed = [option("DeepSeek V4.1 Flash"), option("Codium Auto", true), option("Claude Haiku 5.5")]
    expect(sortModelOptions(listed, false, ModelPlanStatus.PROVIDER_ID).map((item) => item.title)).toEqual([
      "Codium Auto",
      "DeepSeek V4.1 Flash",
      "Claude Haiku 5.5",
    ])
    // Another provider sorts by date and title, as before.
    expect(sortModelOptions(listed, false, "openrouter").map((item) => item.title)).toEqual([
      "Claude Haiku 5.5",
      "Codium Auto",
      "DeepSeek V4.1 Flash",
    ])
  })

  test("a locked or preview Codium entry shows its badge in Favorites and Recent, and over (Favorite)", () => {
    const locked = { locked: { plan: "vector-100", name: "Max" } }
    const preview = { locked: { plan: "vector-200", name: "Ultra", previewUntil: 1_800_000_000_000 } }
    // A Favorites or Recent row names its provider; a locked one names the plan it needs instead.
    expect(modelDescription(ModelPlanStatus.PROVIDER_ID, locked, "Vector Codium")).toBe("Codium · Max")
    expect(modelDescription(ModelPlanStatus.PROVIDER_ID, preview, "Vector Codium")).toBe("Preview · Ultra")
    expect(
      modelDescription(ModelPlanStatus.PROVIDER_ID, { preview: { until: 1_800_000_000_000 } }, "Vector Codium"),
    ).toBe("Preview")
    expect(modelDescription(ModelPlanStatus.PROVIDER_ID, locked, "(Favorite)")).toBe("Codium · Max")
    // A model the plan includes keeps the provider's name or (Favorite), and has no line of its own otherwise.
    expect(modelDescription(ModelPlanStatus.PROVIDER_ID, {}, "Vector Codium")).toBe("Vector Codium")
    expect(modelDescription(ModelPlanStatus.PROVIDER_ID, { manualOnly: true }, "(Favorite)")).toBe("(Favorite)")
    expect(modelDescription(ModelPlanStatus.PROVIDER_ID, undefined)).toBeUndefined()
    // Only Vector Codium's listing is read as Codium's.
    expect(modelDescription("openrouter", locked, "OpenRouter")).toBe("OpenRouter")
  })

  test("choosing a Codium model the plan does not include asks to change plan and never chooses it", async () => {
    const run = async (input: { providerID?: string; codium?: ModelPlanStatus.Listing; answer: boolean }) => {
      const asked: string[] = []
      const opened: string[] = []
      const allowed = await confirmCodiumChoice({
        providerID: input.providerID ?? ModelPlanStatus.PROVIDER_ID,
        model: { id: "anthropic/claude-sonnet-5.5", codium: input.codium },
        ask: async (title, message) => {
          asked.push(`${title}: ${message}`)
          return input.answer
        },
        open: (url) => void opened.push(url),
      })
      return { allowed, asked, opened }
    }
    const locked = { locked: { plan: "vector-100", name: "Max" } }
    expect(await run({ codium: locked, answer: true })).toEqual({
      allowed: false,
      asked: ["Codium · Max: Included in Max and above. Change plan?"],
      opened: [ModelPlanStatus.MANAGE_URL],
    })
    expect(await run({ codium: locked, answer: false })).toMatchObject({ allowed: false, opened: [] })
    // Usable, manual-only and Auto entries are chosen without a question, and so is another provider's model.
    for (const codium of [undefined, { manualOnly: true }, { auto: { floor: "a", default: "b", ceiling: "c" } }])
      expect(await run({ codium, answer: false })).toEqual({ allowed: true, asked: [], opened: [] })
    expect(await run({ providerID: "anthropic", codium: locked, answer: false })).toMatchObject({ allowed: true })
  })
})
