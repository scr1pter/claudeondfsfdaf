import { describe, expect, test } from "bun:test"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"

import {
  classifyTaskDifficulty,
  routeModelForImages,
  routeModelForTask,
  routeVariantForTask,
  planPending,
  supportsImageInput,
  workOpen,
} from "./task-intelligence"

type TestModel = {
  id: string
  name: string
  family: string
  status: string
  provider: { id: string }
  freeModel?: { source: "shared" | "openrouter"; dataPolicy?: "no-training" | "may-train" | "unreviewed" }
  capabilities: {
    reasoning: boolean
    toolcall: boolean
    input?: { image?: boolean }
  }
  limit: { context: number; output: number }
  variants: Record<string, unknown>
  codium?: { manualOnly?: boolean; locked?: { plan: string; name: string }; auto?: unknown }
}

const model = (id: string, input: Partial<TestModel> = {}): TestModel => ({
  id,
  name: id,
  family: id,
  status: "active",
  provider: { id: "test" },
  capabilities: { reasoning: true, toolcall: true },
  limit: { context: 128_000, output: 16_000 },
  variants: {},
  ...input,
})

describe("task intelligence", () => {
  test("automatic routing cannot upgrade a guarded free choice to a paid model", () => {
    const current = model("acme/mini:free", { provider: { id: "openrouter" }, freeModel: { source: "openrouter" } })
    const paid = model("gpt-5.6", {
      provider: { id: "openrouter" },
      capabilities: { reasoning: true, toolcall: true, input: { image: true } },
    })
    const unverified = model("gpt-5.6:free", { provider: { id: "openrouter" } })
    expect(routeModelForTask({ difficulty: "complex", current, available: [current, paid, unverified] })).toEqual({
      model: current,
      routed: false,
    })
    expect(routeModelForImages({ current, available: [current, paid] })).toEqual({ model: undefined, routed: false })
    expect(
      routeModelForImages({ current: { ...current, freeModel: { source: "shared" } }, available: [paid] }),
    ).toEqual({ model: undefined, routed: false })
  })

  test("automatic routing never moves a prompt onto a free model whose provider may train on it", () => {
    const current = model("cohere/mini:free", {
      provider: { id: "openrouter" },
      freeModel: { source: "openrouter", dataPolicy: "no-training" },
    })
    // A much stronger free model that may train is not a routing target; the person has to pick it.
    const trainer = model("acme/opus-max:free", {
      provider: { id: "openrouter" },
      limit: { context: 1_000_000, output: 64_000 },
      freeModel: { source: "openrouter", dataPolicy: "may-train" },
    })
    expect(routeModelForTask({ difficulty: "complex", current, available: [current, trainer] })).toEqual({
      model: current,
      routed: false,
    })
  })

  for (const id of ["maker/mini:free", "maker/mini:FREE"])
    test(`an unverified configured ${id} cannot auto-route to paid task or image models`, () => {
      const current = model(id, {
        provider: { id: "openrouter" },
        capabilities: { reasoning: false, toolcall: true },
      })
      const paid = model("gpt-5.6", {
        provider: { id: "openrouter" },
        capabilities: { reasoning: true, toolcall: true, input: { image: true } },
      })
      expect(routeModelForTask({ difficulty: "complex", current, available: [current, paid] })).toEqual({
        model: current,
        routed: false,
      })
      expect(routeModelForImages({ current, available: [current, paid] })).toEqual({ model: undefined, routed: false })
    })

  test("keeps social messages in the quick lane unless work waits on the user", () => {
    expect(classifyTaskDifficulty("hello!")).toBe("trivial")
    expect(classifyTaskDifficulty("fix login.ts")).toBe("standard")
    for (const text of [
      "thanks!",
      "thanks, that works",
      "bye",
      "great",
      "what can you do?",
      "thanks for the help",
      "what is vector?",
      "hello again",
    ]) {
      expect(classifyTaskDifficulty(text), text).toBe("trivial")
      // While the agent waits on an answer, even a thanks answers that work.
      expect(classifyTaskDifficulty(text, { open: true }), text).toBe("standard")
    }
    // An image, a file or a named subagent makes it work, as the engine sizes it: "help" with a screenshot of an error.
    for (const text of ["hi", "thanks", "help", ""]) {
      expect(classifyTaskDifficulty(text, { images: 1 }), text).toBe("standard")
      expect(classifyTaskDifficulty(text, { files: 1 }), text).toBe("standard")
      expect(classifyTaskDifficulty(text, { agents: ["explore"] }), text).toBe("standard")
    }
  })

  test("a reply that continues the work, or anything that is not social, is never trivial and routes no variant", () => {
    // "continue" or "yes" goes to the agent the user picked, which sizes it against the work it continues; the quick
    // lane would answer it with no tools and no history.
    for (const text of [
      "continue",
      "yes",
      "go ahead",
      "try again",
      "do it",
      "sure",
      "no thanks",
      "sounds good",
      "lgtm",
      "ship to vercel",
      "switch the codebase to Go",
      "keep it simple",
      // A thanks with a request after it, with no comma between them.
      "thanks for the update ship it to vercel",
      "thanks for the fix what about tests?",
    ]) {
      const difficulty = classifyTaskDifficulty(text)
      expect(difficulty, text).toBe("standard")
      expect(routeVariantForTask({ difficulty, variants: ["low", "high"] }), text).toBeUndefined()
    }
    // Only the user's own ask makes work complex.
    expect(classifyTaskDifficulty("be thorough: migrate the app to the new router")).toBe("complex")
    expect(classifyTaskDifficulty("migrate the app to the new router across 40 files")).toBe("standard")
  })

  test("a bare acknowledgement is social unless a plan from Plan mode or the agent's question waits on it", () => {
    for (const text of ["ok", "okay", "got it"]) {
      expect(classifyTaskDifficulty(text), text).toBe("trivial")
      // After a plan nobody has carried out, "ok" approves it; while the agent waits on an answer, it is that answer.
      expect(classifyTaskDifficulty(text, { plan: true }), text).toBe("standard")
      expect(classifyTaskDifficulty(text, { open: true }), text).toBe("standard")
    }
    // An acknowledgement with an ask is the ask.
    expect(classifyTaskDifficulty("ok, now add tests")).toBe("standard")
  })

  test("a plan waits on the user until a reply that is not a greeting's comes from another agent", () => {
    const reply = (id: string, extra: object) => ({
      id,
      role: "assistant",
      time: { created: 1, completed: 2 },
      ...extra,
    })
    const user = { id: "u", role: "user", time: { created: 0 } }
    expect(planPending([user, reply("p", { agent: "plan" })])).toBe(true)
    // A thanks and its quick reply in between are not the work.
    expect(planPending([user, reply("p", { agent: "plan" }), user, reply("q", { agent: "quick" })])).toBe(true)
    expect(planPending([user, reply("p", { agent: "plan" }), user, reply("c", { agent: "build", size: "chat" })])).toBe(
      true,
    )
    // Once another agent carried it out, it is done.
    expect(planPending([user, reply("p", { agent: "plan" }), user, reply("b", { agent: "build" })])).toBe(false)
    expect(planPending([user, reply("b", { agent: "build" })])).toBe(false)
    expect(planPending([])).toBe(false)
  })

  test("work is open when the agent's last reply asked something or its run did not finish", () => {
    const reply = (text: string, extra: object = {}) => {
      const message = { id: "m", role: "assistant", time: { created: 1, completed: 2 }, finish: "stop", ...extra }
      return workOpen([{ id: "u", role: "user", time: { created: 0 } }, message], (id) =>
        id === "m" ? [{ type: "text", text }] : [],
      )
    }
    expect(reply("Fixed the typo.")).toBe(false)
    expect(reply("Fixed the typo. Anything else?")).toBe(false)
    expect(reply("Deployed. Do you want me to keep the preview URL?")).toBe(true)
    // An offer or a closing line without a question mark waits on nothing, as the engine reads it.
    expect(reply("Deployed. Let me know if this works for you.")).toBe(false)
    expect(reply("Deployed. I can also add a preview alias if you want.")).toBe(false)
    // A question before a summary list still waits.
    expect(reply("Should I keep the preview URL?\n\n**Summary:**\n- vercel.json")).toBe(true)
    expect(reply("Migrating the routes", { error: { name: "MessageAbortedError" } })).toBe(true)
    expect(reply("Migrated 12 of", { finish: "length" })).toBe(true)
    expect(reply("Still going", { time: { created: 1 } })).toBe(true)
    expect(workOpen([], () => [])).toBe(false)
    // A greeting's reply waits on nothing, even when its small talk asks back.
    expect(reply("I'm doing great, thanks for asking! How about you?", { agent: "quick" })).toBe(false)
    expect(reply("Hey! How's your day going?", { agent: "build", size: "chat" })).toBe(false)
    // The agent asked through the question tool and the user dismissed it.
    const asked = (status: string) =>
      workOpen([{ id: "m", role: "assistant", time: { created: 1, completed: 2 }, finish: "stop" }], () => [
        { type: "text", text: "I need one decision before I go on." },
        { type: "tool", tool: "question", state: { status } },
      ])
    expect(asked("error")).toBe(true)
    expect(asked("completed")).toBe(false)
  })

  test("routes complex work to a meaningfully stronger model in the same provider", () => {
    const current = model("coder-mini", { capabilities: { reasoning: false, toolcall: true } })
    const strongest = model("gpt-5.6")
    expect(routeModelForTask({ difficulty: "complex", current, available: [current, strongest] })).toEqual({
      model: strongest,
      routed: true,
    })
    expect(routeModelForTask({ difficulty: "simple", current, available: [current, strongest] }).model).toBe(current)
  })

  test("raises default effort for complex work without overriding an explicit choice", () => {
    expect(routeVariantForTask({ difficulty: "complex", variants: ["light", "balanced", "max"] })).toBe("max")
    expect(
      routeVariantForTask({ difficulty: "complex", selected: "light", variants: ["light", "balanced", "max"] }),
    ).toBe("light")
    expect(routeVariantForTask({ difficulty: "complex", selected: "unsupported", variants: ["balanced", "max"] })).toBe(
      "max",
    )
  })

  test("keeps a selected model that understands images", () => {
    const vision = model("vision", { capabilities: { reasoning: true, toolcall: true, input: { image: true } } })
    expect(supportsImageInput(vision)).toBe(true)
    expect(routeModelForImages({ current: vision, available: [vision] })).toEqual({ model: vision, routed: false })
  })

  test("routes image prompts to a connected vision model and reports when none exists", () => {
    const text = model("text-only")
    const sameProvider = model("vision", {
      capabilities: { reasoning: true, toolcall: true, input: { image: true } },
    })
    expect(routeModelForImages({ current: text, available: [text, sameProvider] })).toEqual({
      model: sameProvider,
      routed: true,
    })
    expect(routeModelForImages({ current: text, available: [text] })).toEqual({ model: undefined, routed: false })
  })

  test("complex work on Codium never routes onto Auto, a locked model or a manual-only lane", () => {
    const codium = { provider: { id: "vector-plan" } }
    const current = model("deepseek/deepseek-v4.1-flash", {
      ...codium,
      capabilities: { reasoning: false, toolcall: true },
    })
    // Each is far stronger than the current model by name and window, so only the Codium listing keeps it out.
    const locked = model("anthropic/claude-opus-5.5", {
      ...codium,
      codium: { locked: { plan: "vector-200", name: "Ultra" } },
    })
    const long = model("moonshotai/kimi-k3:long", { ...codium, codium: { manualOnly: true } })
    const fast = model("google/gemini-3.5-pro:fast", { ...codium, codium: { manualOnly: true } })
    const auto = model(ModelPlanStatus.AUTO_ID, {
      ...codium,
      codium: { auto: { floor: "a", default: "b", ceiling: "c" } },
    })
    const bareAuto = model(ModelPlanStatus.AUTO_ID, codium)
    expect(
      routeModelForTask({ difficulty: "complex", current, available: [current, locked, long, fast, auto, bareAuto] }),
    ).toEqual({ model: current, routed: false })
    // A usable stronger Codium model is still a target.
    const sonnet = model("anthropic/claude-sonnet-4.9", codium)
    expect(
      routeModelForTask({ difficulty: "complex", current, available: [current, locked, long, fast, auto, sonnet] }),
    ).toEqual({ model: sonnet, routed: true })
    // Auto itself stays put: it picks a model for each message's size.
    expect(routeModelForTask({ difficulty: "complex", current: auto, available: [auto, sonnet] })).toEqual({
      model: auto,
      routed: false,
    })
    // A manual-only model the person chose stays chosen for work that is not complex.
    expect(routeModelForTask({ difficulty: "simple", current: long, available: [long, sonnet] }).model).toBe(long)
  })

  test("an image on Codium never lands on Auto, a locked model or a manual-only lane", () => {
    const vision = { reasoning: true, toolcall: true, input: { image: true } }
    const codium = { provider: { id: "vector-plan" }, capabilities: vision }
    const text = model("deepseek/deepseek-v4.1-flash", { provider: { id: "vector-plan" } })
    const locked = model("anthropic/claude-opus-5.5", {
      ...codium,
      codium: { locked: { plan: "vector-200", name: "Ultra" } },
    })
    const fast = model("google/gemini-3.5-pro:fast", { ...codium, codium: { manualOnly: true } })
    const auto = model(ModelPlanStatus.AUTO_ID, {
      ...codium,
      codium: { auto: { floor: "a", default: "b", ceiling: "c" } },
    })
    expect(routeModelForImages({ current: text, available: [text, locked, fast, auto] })).toEqual({
      model: undefined,
      routed: false,
    })
    const usable = model("google/gemini-3.5-pro", codium)
    expect(routeModelForImages({ current: text, available: [text, locked, fast, auto, usable] })).toEqual({
      model: usable,
      routed: true,
    })
  })

  test("an image never moves a prompt onto Vector Codium", () => {
    const vision = { capabilities: { reasoning: true, toolcall: true, input: { image: true } } }
    const text = model("maker/text", { provider: { id: "anthropic" } })
    const codium = model("codium/vision", { ...vision, provider: { id: "vector-plan" } })
    const other = model("vision", { ...vision, provider: { id: "openai" } })
    expect(routeModelForImages({ current: text, available: [text, codium] })).toEqual({
      model: undefined,
      routed: false,
    })
    expect(routeModelForImages({ current: text, available: [text, codium, other] })).toEqual({
      model: other,
      routed: true,
    })
    const codiumText = model("codium/text", { provider: { id: "vector-plan" } })
    expect(routeModelForImages({ current: codiumText, available: [codiumText, codium, other] })).toEqual({
      model: codium,
      routed: true,
    })
  })
})
