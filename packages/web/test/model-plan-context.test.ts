import { expect, test } from "bun:test"
import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import path from "node:path"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { Token } from "@vectordevai/core/util/token"
import { CODIUM_MODELS } from "../../../api/_lib/codium-catalog"
import { ApiError } from "../../../api/_lib/http"
import { modelPlanRequest, requireModelPlanContext, streamModelPlanResponse } from "../../../api/_lib/model-plan-chat"

// A coding turn as Vector sends it: the engine's real system prompt and tool descriptions, then 50 KB file reads,
// serialized by the Codium client and normalized by the gateway exactly as a chat request is.
const engine = path.join(import.meta.dir, "../../engine/src")
const model = CODIUM_MODELS[0]
const system = await Bun.file(path.join(engine, "session/prompt/default.txt")).text()
// The engine has no websearch tool since search moved to its own browser (23 October 2026): the browser tool's
// description says how to search, so it stands where websearch did.
const tools = await Promise.all(
  ["read", "edit", "write", "grep", "glob", "task", "todowrite", "webfetch", "browser", "apply_patch", "lsp"].map(
    async (name) => ({
      type: "function",
      function: {
        name,
        description: await Bun.file(path.join(engine, `tool/${name}.txt`)).text(),
        parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
      },
    }),
  ),
)
const source = (await Bun.file(path.join(engine, "provider/provider.ts")).text()).slice(0, 50_000)

const turn = (reads: number, target: (typeof CODIUM_MODELS)[number] = model) => {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: "Fix the provider fallback bug and add a test." },
    ...Array.from({ length: reads }, (_, index) => [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${index}`,
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ filePath: `src/file-${index}.ts` }) },
          },
        ],
      },
      { role: "tool", tool_call_id: `call_${index}`, content: source },
    ]).flat(),
  ]
  return {
    body: modelPlanRequest(
      JSON.parse(ModelPlans.serializeRequest({ messages, tools, max_tokens: target.maxOutputTokens }, target)),
      [target],
    ),
    // What Vector itself estimates for the same conversation, four characters per token.
    estimate: Token.estimate(
      [system, ...tools.map((tool) => tool.function.description), ...messages.map((item) => item.content ?? "")].join(
        "",
      ),
    ),
  }
}

test("the conversation that used to be refused at about 30k tokens now fits the advertised window", () => {
  const current = turn(2)
  // Over 120 KB of request: counting bytes as tokens refused this.
  expect(Buffer.byteLength(JSON.stringify(current.body))).toBeGreaterThan(120_000)
  expect(requireModelPlanContext(current.body, model) + model.maxOutputTokens).toBeLessThanOrEqual(model.contextLength)
})

test("the gateway counts about what Vector counts for the same conversation", () => {
  for (const reads of [2, 4, 8]) {
    const current = turn(reads)
    const counted = requireModelPlanContext(current.body, model)
    expect(counted / current.estimate).toBeGreaterThan(0.9)
    expect(counted / current.estimate).toBeLessThan(1.1)
  }
})

test("a conversation the engine has not yet compacted is accepted, and one past the window is refused", () => {
  // The engine compacts once a step reaches the window less the reply, 119,808 tokens for this model.
  const long = turn(8)
  expect(long.estimate).toBeGreaterThan(100_000)
  expect(long.estimate).toBeLessThan(model.contextLength - model.maxOutputTokens)
  expect(() => requireModelPlanContext(long.body, model)).not.toThrow()
  const over = turn(24)
  expect(over.estimate).toBeGreaterThan(model.contextLength)
  expect(() => requireModelPlanContext(over.body, model)).toThrow(
    expect.objectContaining({ statusCode: 400, code: "MODEL_PLAN_CONTEXT" }),
  )
})

test("Haiku takes a conversation until Vector compacts it, and its prompt bound refuses nothing sooner", () => {
  const haiku = CODIUM_MODELS.find((item) => item.id === "anthropic/claude-haiku-5.5")!
  // The engine compacts once a step reaches the window less the reply (pinned by the engine's Codium tests).
  const compactsAt = haiku.contextLength - haiku.maxOutputTokens
  // Three 50 KB reads after the system prompt and tools: over 180 KB of request, which a byte ceiling refused.
  const long = turn(3, haiku)
  expect(Buffer.byteLength(JSON.stringify(long.body))).toBeGreaterThan(180_000)
  expect(long.estimate).toBeGreaterThan(45_000)
  expect(long.estimate).toBeLessThan(compactsAt)
  expect(() => requireModelPlanContext(long.body, haiku)).not.toThrow()
  // The largest ASCII request the window check takes with a full reply still clears the prompt bound, so a
  // conversation Vector has not compacted yet is never refused for the bound alone.
  const request = (size: number) =>
    modelPlanRequest(
      { model: haiku.id, messages: [{ role: "user", content: "x".repeat(size) }], max_tokens: haiku.maxOutputTokens },
      [haiku],
    )
  const largest = 4 * compactsAt - (JSON.stringify(request(1)).length - 1)
  expect(() => requireModelPlanContext(request(largest), haiku)).not.toThrow()
  expect(() => requireModelPlanContext(request(largest + 4), { ...haiku, promptTokenLimit: undefined })).toThrow(
    expect.objectContaining({ code: "MODEL_PLAN_CONTEXT" }),
  )
  // A short reply does not let a longer prompt within reach of 100,000 tokens, where Haiku bills the whole request
  // at five times the price.
  const over = { ...turn(4, haiku).body, max_tokens: 1_000 }
  expect(() => requireModelPlanContext(over, { ...haiku, promptTokenLimit: undefined })).not.toThrow()
  expect(() => requireModelPlanContext(over, haiku)).toThrow(
    expect.objectContaining({ statusCode: 400, code: "MODEL_PLAN_CONTEXT" }),
  )
  // The other models are not held to Haiku's prompt bound.
  expect(() => requireModelPlanContext(turn(5).body, model)).not.toThrow()
})

test("a JSON escape counts as the one character it stands for, so backslashes cannot slip past the bound", () => {
  const counted = (content: string) =>
    requireModelPlanContext(
      modelPlanRequest({ model: model.id, messages: [{ role: "user", content }], max_tokens: 1 }, [model]),
      model,
    )
  for (const text of ["\\", "\n", '"', "\u0001", "/"])
    expect(counted(text.repeat(40_000))).toBe(counted("x".repeat(40_000)))
  const haiku = CODIUM_MODELS.find((item) => item.id === "anthropic/claude-haiku-5.5")!
  const backslashes = modelPlanRequest(
    { model: haiku.id, messages: [{ role: "user", content: "\\".repeat(300_000) }], max_tokens: 1 },
    [haiku],
  )
  expect(() => requireModelPlanContext(backslashes, haiku)).toThrow(
    expect.objectContaining({ code: "MODEL_PLAN_CONTEXT" }),
  )
})

test("a provider refusing the context gets the gateway's own context answer, so Vector compacts instead of retrying", async () => {
  const refusals = [
    Response.json(
      {
        error: {
          code: 400,
          message:
            "This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens.",
        },
      },
      { status: 400 },
    ),
    Response.json({ error: { code: "context_length_exceeded", message: "Input too long" } }, { status: 400 }),
    new Response("Request Entity Too Large", { status: 413 }),
  ]
  const failures = await Promise.all(
    refusals.map((upstream) =>
      streamModelPlanResponse(upstream, new ServerResponse(new IncomingMessage(new Socket()))).catch(
        (error: unknown) => error,
      ),
    ),
  )
  expect(failures.every((failure) => failure instanceof ApiError)).toBe(true)
  expect(failures).toEqual(refusals.map(() => expect.objectContaining({ statusCode: 400, code: "MODEL_PLAN_CONTEXT" })))
  expect(failures.filter((failure) => failure instanceof ApiError && failure.message.includes("131072"))).toEqual([])
  // The engine and the Core V2 runner read this answer as a context overflow.
  expect(
    failures
      .filter((failure) => failure instanceof ApiError)
      .map((failure) =>
        ModelPlans.contextFailure(JSON.stringify({ error: { code: failure.code, message: failure.message } })),
      ),
  ).toEqual([true, true, true])
  // Any other refusal stays a temporary failure, and the provider's wording never reaches Vector.
  await expect(
    streamModelPlanResponse(
      Response.json({ error: { message: "private upstream detail" } }, { status: 400 }),
      new ServerResponse(new IncomingMessage(new Socket())),
    ),
  ).rejects.toMatchObject({
    statusCode: 503,
    code: "MODEL_PLAN_UPSTREAM",
    message: "This model is temporarily unavailable.",
  })
})
