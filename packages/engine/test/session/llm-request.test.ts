import { describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { jsonSchema, streamText, tool, type ModelMessage } from "ai"
import { convertToLanguageModelPrompt, standardizePrompt } from "ai/internal"
import { Effect } from "effect"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { LLMRequestPrep } from "@/session/llm/request"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "@/session/system"

type Input = Parameters<typeof LLMRequestPrep.prepare>[0]

const model = (id: string, npm: string, providerID: string, reasoning = true) =>
  ({
    id: `${providerID}/${id}`,
    providerID,
    api: { id, url: "https://example.invalid", npm },
    name: id,
    capabilities: {
      temperature: false,
      reasoning,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 400_000, output: 128_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-04-23",
  }) as unknown as Input["model"]

const gpt = model("gpt-5.5", "@ai-sdk/openai", "openai")
const claude = model("claude-sonnet-4-5", "@ai-sdk/anthropic", "anthropic")
const STABLE = "<subagent_policy>Do the work yourself by default.</subagent_policy>"
const session = (directory: string) => [
  `<env>\n  Working directory: ${directory}\n  Today's date: Sat Oct 10 2026\n</env>`,
  "Instructions from: AGENTS.md\nRun tests from package directories.",
]

function input(options: { model: Input["model"]; directory: string; oauth?: boolean; stable?: boolean }): Input {
  return {
    user: {
      id: "msg_test",
      sessionID: "ses_test",
      role: "user",
      time: { created: 1 },
      agent: "build",
      system: "Answer in British English.",
      model: { providerID: ProviderV2.ID.make(options.model.providerID), modelID: ModelV2.ID.make(options.model.id) },
    } as Input["user"],
    sessionID: `ses_${options.directory.replaceAll("/", "")}`,
    model: options.model,
    agent: { name: "build", mode: "primary", options: {}, permission: [] },
    ...(options.stable === false ? {} : { stableSystem: [STABLE] }),
    system: session(options.directory),
    messages: [{ role: "user", content: "Fix the failing test." }],
    tools: {
      read: tool({ description: "Read a file", inputSchema: jsonSchema({ type: "object", properties: {} }) }),
    },
    provider: {
      id: ProviderV2.ID.make(options.model.providerID),
      name: options.model.providerID,
      source: "config",
      env: [],
      options: {},
      models: {},
    },
    auth: options.oauth ? { type: "oauth", access: "placeholder", refresh: "placeholder", expires: 0 } : undefined,
    plugin: {
      trigger: (_name, _input, output) => Effect.succeed(output),
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    },
    flags: { outputTokenMax: 32_000, client: "test" } as Input["flags"],
    isWorkflow: false,
  }
}

const prepare = (value: Input) => Effect.runPromise(LLMRequestPrep.prepare(value))
const systemMessages = (prepared: LLMRequestPrep.Prepared) =>
  prepared.messages.flatMap((message) => (message.role === "system" ? [message.content] : []))

describe("internal stable-prefix marker", () => {
  const selected = {
    ...model("gpt-6.1-sol", "@ai-sdk/openai", "openai"),
    api: { id: "gpt-6.1-sol", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
  }
  const marked = () => {
    const value = input({ model: selected, directory: "/work/cache" })
    return { ...value, provider: { ...value.provider, options: { promptCacheBreakpoints: true, apiKey: "test-key" } } }
  }

  test("marks only the exact unchanged stable prefix and does not change model-facing text", async () => {
    const value = marked()
    const prepared = await prepare(value)
    const baseline = await prepare({ ...value, provider: { ...value.provider, options: { apiKey: "test-key" } } })
    const prefix = [...SystemPrompt.provider(selected), STABLE].join("\n")
    expect(prepared.headers[ProviderTransform.PROMPT_CACHE_PREFIX_HEADER]).toBe(
      ProviderTransform.promptCachePrefix(prefix),
    )
    expect(prepared.messages).toEqual(baseline.messages)
    expect(prepared.params).toEqual(baseline.params)
  })

  test.each([
    { setting: undefined, url: "https://api.openai.com/v1", expected: true },
    { setting: false, url: "https://api.openai.com/v1", expected: false },
    { setting: undefined, url: "https://proxy.example/v1", expected: false },
    { setting: undefined, url: "http://127.0.0.1:1234/v1", expected: false },
    { setting: true, url: "http://127.0.0.1:1234/v1", expected: true },
  ])("resolves cache marker default for $url with setting $setting", async ({ setting, url, expected }) => {
    const value = marked()
    const prepared = await prepare({
      ...value,
      provider: {
        ...value.provider,
        options: {
          apiKey: "test-key",
          baseURL: url,
          ...(setting !== undefined ? { promptCacheBreakpoints: setting } : {}),
        },
      },
    })
    expect(prepared.headers[ProviderTransform.PROMPT_CACHE_PREFIX_HEADER] !== undefined).toBe(expected)
  })

  test("default eligibility accepts stored or provider API keys but never an OAuth credential", async () => {
    const value = marked()
    for (const selected of [
      { auth: { type: "api", key: "test-key" }, providerKey: undefined, expected: true },
      { auth: undefined, providerKey: "test-key", expected: true },
      { auth: undefined, providerKey: undefined, expected: false },
      {
        auth: { type: "oauth", access: "test", refresh: "test", expires: 0 },
        providerKey: "test-key",
        expected: false,
      },
    ] as const) {
      const prepared = await prepare({
        ...value,
        auth: selected.auth,
        provider: { ...value.provider, key: selected.providerKey, options: {} },
      })
      expect(prepared.headers[ProviderTransform.PROMPT_CACHE_PREFIX_HEADER] !== undefined).toBe(selected.expected)
    }
  })

  test("default breakpoints preserve separate session cache keys", async () => {
    const value = marked()
    const prepared = await Promise.all(
      ["ses_alpha", "ses_beta"].map((sessionID) =>
        prepare({ ...value, sessionID, provider: { ...value.provider, options: { apiKey: "test-key" } } }),
      ),
    )
    expect(prepared.map((item) => item.params.options.promptCacheKey)).toEqual(["ses_alpha", "ses_beta"])
    expect(prepared.every((item) => item.headers[ProviderTransform.PROMPT_CACHE_PREFIX_HEADER] !== undefined)).toBe(
      true,
    )
  })

  test.each([
    { setCacheKey: true, expected: "session" },
    { setCacheKey: false, expected: undefined },
    { setCacheKey: undefined, modelKey: "model-cache", expected: "model-cache" },
    { setCacheKey: undefined, modelKey: "model-cache", agentKey: "agent-cache", expected: "agent-cache" },
  ])("preserves explicit key controls with default breakpoints: $expected", async (selected) => {
    const value = marked()
    const prepared = await prepare({
      ...value,
      model: { ...value.model, options: { ...(selected.modelKey ? { promptCacheKey: selected.modelKey } : {}) } },
      agent: { ...value.agent, options: { ...(selected.agentKey ? { promptCacheKey: selected.agentKey } : {}) } },
      provider: {
        ...value.provider,
        options: {
          apiKey: "test-key",
          ...(selected.setCacheKey !== undefined ? { setCacheKey: selected.setCacheKey } : {}),
        },
      },
    })
    expect(prepared.params.options.promptCacheKey).toBe(
      selected.expected === "session" ? value.sessionID : selected.expected,
    )
    expect(prepared.headers[ProviderTransform.PROMPT_CACHE_PREFIX_HEADER]).toBeDefined()
  })

  test("does not mark OAuth, native, helpers, unsupported models, or plugin-rewritten prefixes", async () => {
    const base = marked()
    const plugin: Input["plugin"] = {
      ...base.plugin,
      trigger: (name, _input, output) => {
        if (name === "experimental.chat.system.transform") {
          const changed = output as { system: string[] }
          changed.system[0] = "Rewritten by plugin"
        }
        return Effect.succeed(output)
      },
    }
    const variants: Input[] = [
      { ...base, auth: { type: "oauth", access: "test", refresh: "test", expires: 0 } },
      { ...base, flags: { ...base.flags, experimentalNativeLlm: true } },
      { ...base, small: true },
      { ...base, isWorkflow: true },
      { ...base, model: gpt },
      { ...base, plugin },
    ]
    for (const value of variants) {
      const prepared = await prepare({
        ...value,
        model: { ...value.model, headers: { [ProviderTransform.PROMPT_CACHE_PREFIX_HEADER]: "forged" } },
      })
      expect(prepared.headers[ProviderTransform.PROMPT_CACHE_PREFIX_HEADER]).toBeUndefined()
    }
  })
})

describe("system prompt layout across sessions", () => {
  test("a ChatGPT sign-in keeps instructions the same from session to session and sends the session after them", async () => {
    const first = await prepare(input({ model: gpt, directory: "/work/a", oauth: true }))
    const second = await prepare(input({ model: gpt, directory: "/work/b", oauth: true }))
    const instructions = first.params.options.instructions as string

    expect(instructions).toBe(second.params.options.instructions)
    expect(instructions.startsWith(SystemPrompt.provider(gpt)[0])).toBe(true)
    expect(instructions).toContain(STABLE)
    expect(instructions).not.toContain("Working directory")
    expect(instructions).not.toContain("AGENTS.md")
    expect(instructions).not.toContain("British English")
    // Nothing is dropped: the per-session block follows as one system (developer) message, then the conversation.
    expect(systemMessages(first)).toEqual([[...session("/work/a"), "Answer in British English."].join("\n")])
    expect(first.messages.at(-1)).toEqual({ role: "user", content: "Fix the failing test." })
  })

  // gpt-6.1-sol is a model the SDK does not know as a reasoning model, and codex-mini-latest without reasoning would get
  // a system item from the SDK on its own: the per-session block still goes as a developer item, as the Codex CLI sends
  // its environment.
  test.each([
    gpt,
    model("gpt-6.1-sol", "@ai-sdk/openai", "openai"),
    model("codex-mini-latest", "@ai-sdk/openai", "openai", false),
  ])(
    "the real SDK sends $api.id as instructions, then a developer item, with the session as cache key",
    async (selected) => {
      const requests: Array<Record<string, unknown>> = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requests.push((await request.json()) as Record<string, unknown>)
          const events = [
            { type: "response.created", response: { id: "resp_1", created_at: 1, model: selected.api.id } },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ]
          return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      const value = input({ model: selected, directory: "/work/a", oauth: true })
      const prepared = await prepare(value)
      const sdk = createOpenAI({ apiKey: "local-test-only", baseURL: `${server.url.origin}/v1` })
      await streamText({
        model: sdk.responses(selected.api.id),
        messages: prepared.messages,
        tools: prepared.tools,
        providerOptions: ProviderTransform.providerOptions(selected, prepared.params.options),
      }).consumeStream()
      server.stop(true)

      const body = requests[0] ?? {}
      expect(body.instructions).toBe(prepared.params.options.instructions)
      expect(body.input).toEqual([
        { role: "developer", content: systemMessages(prepared)[0] },
        { role: "user", content: [{ type: "input_text", text: "Fix the failing test." }] },
      ])
      expect(body.prompt_cache_key).toBe(value.sessionID)
    },
  )

  test("without stable parts a ChatGPT sign-in sends everything as instructions, as before", async () => {
    const prepared = await prepare(input({ model: gpt, directory: "/work/a", oauth: true, stable: false }))
    expect(prepared.params.options.instructions).toContain("Working directory: /work/a")
    expect(systemMessages(prepared)).toEqual([])
  })

  test("an API key keeps one system block with the stable parts ahead of the session", async () => {
    const prepared = await prepare(input({ model: gpt, directory: "/work/a" }))
    const [block] = systemMessages(prepared)
    expect(prepared.params.options.instructions).toBeUndefined()
    expect(systemMessages(prepared)).toHaveLength(1)
    expect(block?.indexOf(STABLE)).toBeLessThan(block?.indexOf("Working directory") ?? -1)
  })

  test("a model that takes cache breakpoints gets the stable block first and the session block after it", async () => {
    const first = await prepare(input({ model: claude, directory: "/work/a" }))
    const second = await prepare(input({ model: claude, directory: "/work/b" }))
    expect(systemMessages(first)).toHaveLength(2)
    expect(systemMessages(first)[0]).toBe(systemMessages(second)[0])
    expect(systemMessages(first)[0]).not.toContain("Working directory")
    expect(systemMessages(first)[1]).toContain("Working directory: /work/a")
    expect(systemMessages(first)[1]).toContain("British English")
    // The stable block carries its own breakpoint, so tools plus the stable block are cached for every session.
    const [stable] = ProviderTransform.message(first.messages, claude, {})
    expect(stable?.providerOptions?.anthropic).toEqual({ cacheControl: { type: "ephemeral" } })
  })

  test.each([claude, gpt])(
    "siblings preserve the stable prefix, their distinct brief and their permission cohort on $api.id",
    async (selected) => {
      const base = input({ model: selected, directory: "/work/shared", oauth: selected.providerID === "openai" })
      const prepared = await Promise.all(
        ["alpha", "beta"].map((name) =>
          prepare({
            ...base,
            sessionID: `ses_${name}`,
            parentSessionID: "ses_parent",
            agent: { ...base.agent, name: "explore", mode: "subagent", prompt: "Inspect and report; do not edit." },
            permission: [{ permission: "edit", pattern: "*", action: "deny" }],
            tools: {
              ...base.tools,
              edit: tool({ description: "Edit a file", inputSchema: jsonSchema({ type: "object", properties: {} }) }),
            },
            messages: [
              {
                role: "user",
                content: `Inspect ${name}. Context pack: established finding for ${name}; verify success criteria.`,
              },
            ],
          }),
        ),
      )
      expect(prepared[0]?.system[0]).toBe(prepared[1]?.system[0])
      expect(prepared[0]?.system[0]).not.toContain("alpha")
      expect(prepared[1]?.system[0]).not.toContain("beta")
      expect(Object.keys(prepared[0]?.tools ?? {})).toEqual(["read"])
      expect(Object.keys(prepared[1]?.tools ?? {})).toEqual(["read"])
      expect(prepared[0]?.messages.at(-1)?.content).toContain("established finding for alpha")
      expect(prepared[1]?.messages.at(-1)?.content).toContain("established finding for beta")
      expect(prepared.map((item) => item.headers["x-parent-session-id"])).toEqual(["ses_parent", "ses_parent"])
      if (selected.providerID === "openai")
        expect(prepared.map((item) => item.params.options.promptCacheKey)).toEqual(["ses_alpha", "ses_beta"])
    },
  )

  test("a text-only helper's wildcard deny removes every tool, including patches and questions", async () => {
    const value = input({ model: gpt, directory: "/work/helper" })
    const schema = jsonSchema({ type: "object", properties: {} })
    const prepared = await prepare({
      ...value,
      // The browser planner and inline editor provide the observation/file content themselves. Their prompt's
      // tools: { "*": false } becomes this session rule, overriding even a permissive user-configured agent.
      agent: { ...value.agent, permission: [{ permission: "*", pattern: "*", action: "allow" }] },
      permission: [{ permission: "*", pattern: "*", action: "deny" }],
      tools: Object.fromEntries(
        ["apply_patch", "bash", "edit", "read", "question", "mcp_workspace_write", "future_tool"].map((name) => [
          name,
          tool({ description: name, inputSchema: schema }),
        ]),
      ),
    })
    expect(prepared.tools).toEqual({})
    expect(value.agent.permission).toEqual([])
  })

  test("the session header keeps the session's own ID whatever configuration or plugins add", async () => {
    // The free-model fetch applies the guest rule to the session this header names, so another value, or a second one
    // joined to it, would let a request for a session a guest worked in pass as the owner's.
    const value = input({
      model: { ...gpt, headers: { "x-session-id": "ses_from_config" } } as Input["model"],
      directory: "/work/guest",
    })
    const prepared = await prepare({
      ...value,
      plugin: {
        ...value.plugin,
        trigger: (name, _input, output) =>
          Effect.succeed(
            name === "chat.headers" ? { ...output, headers: { "X-SESSION-ID": "ses_from_plugin" } } : output,
          ),
      } as Input["plugin"],
    })
    expect(new Headers(prepared.headers).get("x-session-id")).toBe(value.sessionID)
  })

  test("a Codium request's purpose is set last, cannot be overridden and reaches Codium only", async () => {
    const codium = model("vendor/coder", "@ai-sdk/openai-compatible", "vector-plan", false)
    const plugin = (headers: Record<string, string>) =>
      ({
        ...input({ model: codium, directory: "/work/a" }).plugin,
        trigger: (name: string, _input: unknown, output: { headers: Record<string, string> }) =>
          Effect.succeed(name === "chat.headers" ? { ...output, headers } : output),
      }) as Input["plugin"]
    const purpose = async (value: Partial<Input>) =>
      new Headers((await prepare({ ...input({ model: codium, directory: "/work/a" }), ...value })).headers).get(
        "x-vector-purpose",
      )
    expect(await purpose({})).toBe("chat")
    expect(await purpose({ purpose: "title" })).toBe("title")
    expect(
      await purpose({ agent: { name: "judge", mode: "subagent", options: {}, permission: [] } as Input["agent"] }),
    ).toBe("judge")
    // Neither model configuration nor a plugin can claim another purpose.
    expect(
      await purpose({
        purpose: "brain",
        model: { ...codium, headers: { "X-Vector-Purpose": "review" } } as Input["model"],
        plugin: plugin({ "x-vector-purpose": "race" }),
      }),
    ).toBe("brain")
    // Any other provider never sees the header, even when a plugin adds it.
    const other = await prepare({
      ...input({ model: gpt, directory: "/work/a" }),
      purpose: "title",
      plugin: plugin({ "X-Vector-Purpose": "title" }),
    })
    expect(new Headers(other.headers).has("x-vector-purpose")).toBe(false)
  })

  test("tools go out in name order whatever order they were offered in", async () => {
    const value = input({ model: gpt, directory: "/work/a" })
    const schema = jsonSchema({ type: "object", properties: {} })
    const prepared = await prepare({
      ...value,
      tools: {
        todowrite: tool({ description: "Track work", inputSchema: schema }),
        bash: tool({ description: "Run a command", inputSchema: schema }),
        read: tool({ description: "Read a file", inputSchema: schema }),
      },
    })
    expect(Object.keys(prepared.tools)).toEqual(["bash", "read", "todowrite"])
  })
})

// A learned workflow default sends Thorough work at the model's default effort, which adds no reasoning options of its
// own (section 6.3). So reasoning the user configured for the model is sent as configured, where the size's high effort
// would have replaced it, and a variant the user picked still wins over both.
describe("a learned default effort", () => {
  const thinking = {
    ...claude,
    options: { thinking: { type: "enabled", budgetTokens: 2048 } },
    variants: {
      high: { thinking: { type: "enabled", budgetTokens: 32_000 } },
      max: { thinking: { type: "enabled", budgetTokens: 64_000 } },
    },
  } as unknown as Input["model"]

  test("keeps the model's own reasoning options", async () => {
    const value = input({ model: thinking, directory: "/work/a" })
    const learned = await prepare({ ...value, effort: "default" })
    const sized = await prepare({ ...value, effort: "high" })
    expect(learned.params.options.thinking).toEqual({ type: "enabled", budgetTokens: 2048 })
    expect(sized.params.options.thinking).toEqual({ type: "enabled", budgetTokens: 32_000 })
  })

  test("never beats the variant the user picked", async () => {
    const value = input({ model: thinking, directory: "/work/a" })
    const picked = await prepare({
      ...value,
      user: { ...value.user, model: { ...value.user.model, variant: "max" } } as Input["user"],
      effort: "default",
    })
    expect(picked.params.options.thinking).toEqual({ type: "enabled", budgetTokens: 64_000 })
  })
})

// A fork's first request of a run names its root's prompt cache key (5.E.3). Only that key changes: the headers still
// carry the fork's own session IDs.
describe("a fork's cache key", () => {
  const openrouter = model("anthropic/claude-sonnet-4.5", "@openrouter/ai-sdk-provider", "openrouter")
  const strip = (prepared: LLMRequestPrep.Prepared) => ({ ...prepared, tools: Object.keys(prepared.tools) })

  test.each([
    [gpt, "promptCacheKey"],
    [openrouter, "prompt_cache_key"],
  ] as const)("changes only %s's key", async (target, key) => {
    const value = { ...input({ model: target, directory: "/work/child" }), parentSessionID: "ses_root" }
    const own = await prepare(value)
    const keyed = await prepare({ ...value, cacheKey: "ses_root" })
    expect(own.params.options[key]).toBe(value.sessionID)
    expect(keyed.params.options[key]).toBe("ses_root")
    expect(strip(keyed)).toEqual(
      strip({
        ...own,
        params: { ...own.params, options: { ...own.params.options, [key]: "ses_root" } },
        messageTransformOptions: { ...own.messageTransformOptions, [key]: "ses_root" },
      }),
    )
    const headers = new Headers(keyed.headers)
    expect(headers.get("x-session-affinity")).toBe(value.sessionID)
    expect(headers.get("x-session-id")).toBe(value.sessionID)
    expect(headers.get("x-parent-session-id")).toBe("ses_root")
  })

  test("adds no key where the provider takes none", async () => {
    const value = input({ model: claude, directory: "/work/child" })
    const own = await prepare(value)
    const keyed = await prepare({ ...value, cacheKey: "ses_root" })
    expect(strip(keyed)).toEqual(strip(own))
    expect(JSON.stringify(keyed.params.options)).not.toContain("ses_root")
  })

  // The root's key only routes the fork to the cache that holds the parent's prefix. The explicit stable-prefix cache
  // boundary stays on the same static prefix, so the two compose instead of replacing each other.
  test("keeps the stable-prefix cache boundary while it names the root's key", async () => {
    const sol = {
      ...model("gpt-6.1-sol", "@ai-sdk/openai", "openai"),
      api: { id: "gpt-6.1-sol", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
    }
    const value = input({ model: sol, directory: "/work/root" })
    const base = { ...value, provider: { ...value.provider, options: { apiKey: "test-key" } } }
    const root = await prepare({ ...base, sessionID: "ses_root" })
    const fork = { ...base, sessionID: "ses_child", parentSessionID: "ses_root" }
    const own = await prepare(fork)
    const keyed = await prepare({ ...fork, cacheKey: "ses_root" })
    const marker = ProviderTransform.promptCachePrefix([...SystemPrompt.provider(sol), STABLE].join("\n"))
    expect(root.headers[ProviderTransform.PROMPT_CACHE_PREFIX_HEADER]).toBe(marker)
    expect(own.headers[ProviderTransform.PROMPT_CACHE_PREFIX_HEADER]).toBe(marker)
    expect(keyed.headers[ProviderTransform.PROMPT_CACHE_PREFIX_HEADER]).toBe(marker)
    expect(root.params.options.promptCacheKey).toBe("ses_root")
    expect(own.params.options.promptCacheKey).toBe("ses_child")
    expect(keyed.params.options.promptCacheKey).toBe("ses_root")
    expect(keyed.messages).toEqual(root.messages)
    expect(new Headers(keyed.headers).get("x-session-id")).toBe("ses_child")
  })
})

// A fork's cache breakpoint is placed by the index of its last inherited message in the request's messages, which must
// name the same message in the prompt the AI SDK builds from them.
describe("LLMRequestPrep.promptIndex", () => {
  const result = (id: string) => ({
    role: "tool" as const,
    content: [
      { type: "tool-result" as const, toolCallId: id, toolName: "read", output: { type: "text" as const, value: id } },
    ],
  })
  const call = (...ids: string[]) => ({
    role: "assistant" as const,
    content: ids.map((id) => ({ type: "tool-call" as const, toolCallId: id, toolName: "read", input: {} })),
  })
  const messages: ModelMessage[] = [
    { role: "system", content: "Stable block" },
    { role: "system", content: "Session block" },
    { role: "user", content: "Look around." },
    call("a", "b"),
    result("a"),
    result("b"),
    { role: "user", content: "<fork_assignment>Fix it.</fork_assignment>" },
    call("c"),
    result("c"),
  ]

  test("names the same message in the prompt the AI SDK builds", async () => {
    const prompt = await convertToLanguageModelPrompt({
      prompt: await standardizePrompt({ messages }),
      supportedUrls: {},
      download: undefined,
    })
    expect(prompt).toHaveLength(8)
    for (const [index, expected] of [
      [2, "user"],
      [3, "assistant"],
      [4, "tool"],
      [5, "tool"],
      [6, "user"],
      [8, "tool"],
    ] as const) {
      const at = LLMRequestPrep.promptIndex(messages, index)
      expect(prompt[at]?.role).toBe(expected)
    }
    // Both tool messages land in one, after the system blocks and the two messages before them.
    expect(LLMRequestPrep.promptIndex(messages, 4)).toBe(4)
    expect(LLMRequestPrep.promptIndex(messages, 5)).toBe(4)
    expect(LLMRequestPrep.promptIndex(messages, 6)).toBe(5)
    expect(JSON.stringify(prompt[LLMRequestPrep.promptIndex(messages, 5)])).toContain('"toolCallId":"b"')
  })
})

describe("automatic title output budget", () => {
  test.each([
    { fast: false, allowance: undefined, output: 128_000, context: 400_000, expected: 512 },
    { fast: true, allowance: 32_000, output: 128_000, context: 400_000, expected: 512 },
    { fast: true, allowance: 96, output: 128_000, context: 400_000, expected: 96 },
    { fast: false, allowance: 32_000, output: 128, context: 400_000, expected: 128 },
    { fast: false, allowance: 32_000, output: 0, context: 1_024, expected: 256 },
  ])("a title keeps its $expected-token allowance with fast=$fast", async (selected) => {
    const value = input({ model: gpt, directory: "/work/title" })
    const prepared = await prepare({
      ...value,
      agent: { ...value.agent, name: "title" },
      small: true,
      user: selected.fast ? { ...value.user, executionMode: "fast" } : value.user,
      flags: { ...value.flags, outputTokenMax: selected.allowance },
      model: { ...gpt, limit: { output: selected.output, context: selected.context } },
    })
    expect(prepared.params.maxOutputTokens).toBe(selected.expected)
  })

  test.each([
    { name: "build", small: false, fast: false, expected: 32_000 },
    { name: "build", small: false, fast: true, expected: 48_000 },
    { name: "brain.learn", small: true, fast: false, expected: 32_000 },
    { name: "summary", small: true, fast: false, expected: 32_000 },
    { name: "compaction", small: false, fast: false, expected: 32_000 },
    { name: "title", small: false, fast: false, expected: 32_000 },
  ])("leaves $name small=$small fast=$fast at $expected tokens", async (selected) => {
    const value = input({ model: gpt, directory: "/work/task" })
    const prepared = await prepare({
      ...value,
      agent: { ...value.agent, name: selected.name },
      small: selected.small,
      user: selected.fast ? { ...value.user, executionMode: "fast" } : value.user,
    })
    expect(prepared.params.maxOutputTokens).toBe(selected.expected)
  })

  test("the real SDK sends the automatic title cap to the provider", async () => {
    const requests: Array<Record<string, unknown>> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push((await request.json()) as Record<string, unknown>)
        const events = [
          { type: "response.created", response: { id: "resp_title", created_at: 1, model: gpt.api.id } },
          { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
        ]
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    try {
      const value = input({ model: gpt, directory: "/work/title" })
      const prepared = await prepare({
        ...value,
        agent: { ...value.agent, name: "title", prompt: "Output only a short title." },
        user: { ...value.user, executionMode: "fast" },
        small: true,
        tools: {},
      })
      const sdk = createOpenAI({ apiKey: "local-test-only", baseURL: `${server.url.origin}/v1` })
      await streamText({
        model: sdk.responses(gpt.api.id),
        messages: prepared.messages,
        maxOutputTokens: prepared.params.maxOutputTokens,
        providerOptions: ProviderTransform.providerOptions(gpt, prepared.params.options),
      }).consumeStream()

      expect(requests).toHaveLength(1)
      expect(requests[0]?.max_output_tokens).toBe(512)
    } finally {
      server.stop(true)
    }
  })
})
