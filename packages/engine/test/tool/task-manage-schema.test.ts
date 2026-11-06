import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { JsonSchema, LLM } from "@vectordevai/llm"
import { AnthropicMessages } from "@vectordevai/llm/protocols/anthropic-messages"
import { OpenAIChat } from "@vectordevai/llm/protocols/openai-chat"
import { OpenAIResponses } from "@vectordevai/llm/protocols/openai-responses"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID, SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(disposeAllInstances)

const it = testEffect(
  LayerNode.compile(ToolRegistry.node, [
    [Config.node, TestConfig.layer()],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

describe("task_manage provider schema", () => {
  it.instance("advertises every registered action through all three provider wire lowerers", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tool = (yield* registry.all()).find((item) => item.id === "task_manage")
      if (!tool) throw new Error("task_manage was not registered")
      const tools = [
        {
          name: tool.id,
          description: tool.description,
          inputSchema: Schema.decodeUnknownSync(JsonSchema)(ToolJsonSchema.fromTool(tool)),
        },
      ]
      const chat = yield* OpenAIChat.protocol.body.from(
        LLM.request({ model: OpenAIChat.route.model({ id: "fixture" }), prompt: "Inspect task status", tools }),
      )
      const responses = yield* OpenAIResponses.protocol.body.from(
        LLM.request({ model: OpenAIResponses.route.model({ id: "fixture" }), prompt: "Inspect task status", tools }),
      )
      const anthropic = yield* AnthropicMessages.protocol.body.from(
        LLM.request({ model: AnthropicMessages.route.model({ id: "fixture" }), prompt: "Inspect task status", tools }),
      )
      for (const parameters of [
        chat.tools?.[0]?.function.parameters,
        responses.tools?.[0]?.parameters,
        anthropic.tools?.[0]?.input_schema,
      ]) {
        expect(parameters).toMatchObject({
          type: "object",
          properties: {
            action: { enum: ["list", "inspect", "message", "stop", "wait", "resume", "report", "merge", "discard"] },
            task_id: { type: "string" },
            task_ids: { type: "array", minItems: 1, maxItems: 200 },
            text: { type: "string" },
            delivery: { enum: ["steer", "queue"] },
            all: { type: "boolean" },
            mode: { enum: ["any", "all"] },
            timeout: { type: "number", minimum: 0, maximum: 60000 },
            siblings: { type: "boolean" },
            wake: { type: "boolean" },
            diff: { type: "boolean" },
            files: { type: "array", minItems: 1, maxItems: 500 },
          },
          required: ["action"],
        })
        expect(parameters?.anyOf).toBeUndefined()
      }
    }),
  )

  // I22: the description is fixed text, the same on every request, so a provider's prompt cache keeps it.
  it.instance("the description is stable and names the isolation actions", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tool = (yield* registry.all()).find((item) => item.id === "task_manage")
      if (!tool) throw new Error("task_manage was not registered")
      expect(tool.description).toContain("merge: bring a direct child's reviewed isolated changes")
      expect(tool.description).toContain("discard:")
      expect(tool.description).toMatchSnapshot()
    }),
  )

  it.instance("validates action-specific requirements before invoking task controls", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tool = (yield* registry.all()).find((item) => item.id === "task_manage")
      if (!tool) throw new Error("task_manage was not registered")
      const context: Tool.Context = {
        sessionID: SessionID.make("ses_schema_fixture"),
        messageID: MessageID.make("msg_schema_fixture"),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      for (const input of [
        { action: "unknown" },
        { action: "inspect" },
        { action: "message", task_id: "ses_child" },
        { action: "message", task_id: "ses_child", text: "Correct the parser", delivery: "immediate" },
        { action: "stop", task_ids: [] },
        { action: "wait" },
        { action: "wait", task_ids: [] },
        { action: "wait", task_ids: ["ses_child"], timeout: -1 },
        { action: "wait", task_ids: ["ses_child"], timeout: 60001 },
        { action: "resume" },
        { action: "resume", task_ids: [] },
        { action: "resume", task_ids: Array.from({ length: 9 }, (_, index) => `ses_child_${index}`) },
        { action: "report" },
        { action: "report", text: "Blocked on the schema", wake: "yes" },
        { action: "merge" },
        { action: "merge", task_id: "ses_child", files: [] },
        { action: "merge", task_id: "ses_child", files: Array.from({ length: 501 }, (_, index) => `f${index}.ts`) },
        // Only the authenticated owner may force a merge or include unmerged dependencies.
        { action: "merge", task_id: "ses_child", force: true },
        { action: "merge", task_id: "ses_child", includeStacked: true },
        { action: "discard" },
        { action: "discard", task_id: "ses_child", reason: "x".repeat(1001) },
        { action: "inspect", task_id: "ses_child", diff: "yes" },
      ]) {
        const exit = yield* tool.execute(input, context).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) throw new Error("Invalid control input was accepted")
        const error = exit.cause.reasons.find(Cause.isDieReason)?.defect
        expect(error).toBeInstanceOf(Tool.InvalidArgumentsError)
      }
      for (const input of [
        { action: "list", descendants: true },
        { action: "inspect", task_id: "ses_child" },
        { action: "message", task_id: "ses_child", text: "Correct the parser", delivery: "steer" },
        { action: "stop", task_ids: ["ses_child"], reason: "Assignment changed" },
        { action: "wait", task_ids: ["ses_child"], mode: "all", timeout: 60000 },
        { action: "resume", task_ids: ["ses_child"] },
        { action: "resume", task_ids: ["ses_child"], text: "Also check the parser" },
        { action: "list", siblings: true },
        { action: "report", text: "Blocked on the schema", wake: true },
        { action: "inspect", task_id: "ses_child", diff: true },
        { action: "merge", task_id: "ses_child" },
        { action: "merge", task_id: "ses_child", files: ["src/a.ts"] },
        { action: "discard", task_id: "ses_child" },
        { action: "discard", task_id: "ses_child", reason: "Superseded by the parser fix" },
      ]) {
        expect(Schema.decodeUnknownSync(tool.parameters)(input)).toEqual(input)
      }
    }),
  )
})
