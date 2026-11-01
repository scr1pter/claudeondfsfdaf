import { describe, expect, test } from "bun:test"
import type { Message, AssistantMessage } from "@vectordevai/sdk/v2/client"
import { getSessionContext } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
) => {
  return {
    id,
    role: "assistant",
    providerID,
    modelID,
    cost,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  } as unknown as Message
}

const user = (id: string) => {
  return {
    id,
    role: "user",
    cost: 0,
    time: { created: 1 },
  } as unknown as Message
}

describe("getSessionContext", () => {
  test("computes usage from latest assistant with tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000 },
          },
        },
      },
    ]

    const ctx = getSessionContext(messages, providers)

    expect(ctx?.message.id).toBe("a2")
    // Hidden reasoning is billed, but it is not necessarily retained in the
    // next prompt, so the context ring follows the runtime overflow count.
    expect(ctx?.usage).toBe(45)
    expect(ctx?.tokens).toBe(450)
    expect(ctx?.providerLabel).toBe("OpenAI")
    expect(ctx?.modelLabel).toBe("GPT-4.1")
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages = [assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1")]
    const providers = [{ id: "p-1", models: {} }]

    const ctx = getSessionContext(messages, providers)

    expect(ctx?.providerLabel).toBe("p-1")
    expect(ctx?.modelLabel).toBe("m-1")
    expect(ctx?.limit).toBeUndefined()
    expect(ctx?.usage).toBeNull()
  })

  test("prefers the provider-reported total when it exceeds reconstructed context", () => {
    const message = assistant("a1", { input: 100, output: 20, reasoning: 500, read: 30, write: 10 }, 0.1)
    if (message.role === "assistant") message.tokens.total = 175
    const providers = [{ id: "openai", models: { "gpt-4.1": { name: "GPT-4.1", limit: { context: 1_000 } } } }]

    expect(getSessionContext([message], providers)).toMatchObject({ tokens: 175, usage: 18 })
  })

  test("recomputes when message array is mutated in place", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25)]
    const providers = [{ id: "openai", models: {} }]

    const one = getSessionContext(messages, providers)
    messages.push(assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContext(messages, providers)

    expect(one?.message.id).toBe("a1")
    expect(two?.message.id).toBe("a2")
  })

  test("returns undefined when inputs are undefined", () => {
    const ctx = getSessionContext(undefined, undefined)

    expect(ctx).toBeUndefined()
  })
})

test("Codium keeps the internal context percentage with an explicit display classification", () => {
  const message = assistant(
    "codium",
    { input: 90000, output: 10000, reasoning: 0, read: 0, write: 0 },
    0,
    "vector-plan",
    "vector-flash",
  )
  const providers = [
    {
      id: "vector-plan",
      name: "Vector Codium",
      models: { "vector-flash": { name: "Flash", limit: { context: 200000 } } },
    },
  ]
  expect(getSessionContext([message], providers)).toMatchObject({ codium: true, usage: 50, tokens: 100000 })
})

test("missing or noncanonical provider identity cannot expose raw context figures", () => {
  for (const providerID of ["", "  ", " vector-plan "]) {
    const message = {
      role: "assistant",
      providerID,
      modelID: "test",
      tokens: { input: 987654, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } as AssistantMessage
    expect(getSessionContext([message], [])).toBeUndefined()
  }
})
