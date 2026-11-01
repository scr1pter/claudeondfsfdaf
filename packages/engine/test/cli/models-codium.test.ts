// The `vector models` line for Vector Codium, from the listing the engine provider builds (A20). Pure: no process.
import { expect, test } from "bun:test"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { codiumLines } from "../../src/cli/cmd/models"
import { fromModelPlans } from "../../src/provider/provider"

test("vector models names Codium Auto and the models a higher plan includes, never a price or credits", () => {
  const listed = fromModelPlans([
    {
      id: "deepseek/deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      contextLength: 131_072,
      maxOutputTokens: 8_192,
      lab: "deepseek",
      role: "default",
      weight: 1,
    },
    {
      id: ModelPlans.AUTO_ID,
      name: "Codium Auto",
      contextLength: 131_072,
      maxOutputTokens: 8_192,
      auto: { floor: "openai/gpt-6-luna", default: "deepseek/deepseek-v4.1-flash", ceiling: "openai/gpt-6-sol" },
    },
    {
      id: "openai/gpt-6-luna",
      name: "GPT-6 Luna",
      contextLength: 262_144,
      maxOutputTokens: 8_192,
      lab: "openai",
      role: "floor",
    },
    {
      id: "deepseek/deepseek-v4.1-flash:long",
      name: "DeepSeek Long",
      contextLength: 524_288,
      maxOutputTokens: 8_192,
      manualOnly: true,
    },
    {
      id: "anthropic/claude-sonnet-5.5",
      name: "Claude Sonnet 5.5",
      contextLength: 200_000,
      maxOutputTokens: 16_384,
      locked: { plan: "vector-100", name: "Max" },
    },
    {
      id: "anthropic/claude-opus-5.5",
      name: "Claude Opus 5.5",
      contextLength: 200_000,
      maxOutputTokens: 32_768,
      locked: { plan: "vector-200", name: "Ultra" },
    },
  ])
  const lines = codiumLines(Object.values(listed.models))
  // Included: DeepSeek, Luna and the manual-only lane; Auto and the locked models are named on their own lines.
  expect(lines).toEqual([
    'Vector Codium: 3 models included in your plan (vector-plan/…). Run "vector codium" for your plan and usage.',
    "  Codium Auto picks a model for each message (vector-plan/vector/codium-auto)",
    "  Locked: Claude Sonnet 5.5 (Max), Claude Opus 5.5 (Ultra). Change plan to use them: https://vectordev.ai/account",
  ])
  expect(lines.join("\n")).not.toMatch(/credit|\$|weight|price/i)
  // A plan without Auto or locked models gets the count alone.
  expect(codiumLines([{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }])).toEqual([
    'Vector Codium: 1 model included in your plan (vector-plan/…). Run "vector codium" for your plan and usage.',
  ])
})
