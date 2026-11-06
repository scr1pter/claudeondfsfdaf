import { ModelPlanStatus } from "../../src/model-plan-status"
import type { ModelPlans } from "../../src/model-plans"

export const codiumModel = {
  id: "vendor/coder",
  name: "Coder",
  contextLength: 32_000,
  maxOutputTokens: 4096,
}

/** A text reply that calls one tool, then the usage chunk, which the gateway forwards without the provider's charge. */
export const toolCallStream = [
  { id: "gen-1", choices: [{ index: 0, delta: { role: "assistant", content: "Reading the file." } }] },
  {
    id: "gen-1",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } }],
        },
      },
    ],
  },
  {
    id: "gen-1",
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"src/a.ts"}' } }] } }],
  },
  { id: "gen-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  {
    id: "gen-1",
    choices: [],
    usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 },
  },
]

/** A plain text reply, such as a session title. */
export const textStream = [
  { id: "gen-2", choices: [{ index: 0, delta: { role: "assistant", content: "Fix the login redirect" } }] },
  { id: "gen-2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { id: "gen-2", choices: [], usage: { prompt_tokens: 200, completion_tokens: 6, total_tokens: 206 } },
]

/** A structured answer streamed as JSON text, such as a generated agent. */
export const objectStream = [
  {
    id: "gen-3",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: JSON.stringify({
            identifier: "migration-checker",
            whenToUse: "Checks database migrations before they run.",
            systemPrompt: "You check database migrations.",
          }),
        },
      },
    ],
  },
  { id: "gen-3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { id: "gen-3", choices: [], usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 } },
]

/** The v2 `/models` answer (§4.12) for a current client: the one model, Codium Auto naming it in every role, no locks. */
export const codiumCatalogV2: ModelPlans.Catalog = {
  enabled: true,
  plan: "vector-50",
  limits: { inFlight: 4 },
  models: [
    { ...codiumModel, lab: "deepseek", weight: 1, role: "default" },
    {
      id: ModelPlanStatus.AUTO_ID,
      name: "Codium Auto",
      contextLength: codiumModel.contextLength,
      maxOutputTokens: codiumModel.maxOutputTokens,
      lab: "deepseek",
      weight: 1,
      auto: { floor: codiumModel.id, default: codiumModel.id, ceiling: codiumModel.id },
    },
  ],
  review: { triage: codiumModel.id },
}

/**
 * A local stand-in for vectordev.ai/api/model-plans: catalog, status and chat, answering like the hosted gateway.
 * forward() sends a request meant for vectordev.ai here instead, so the real client code runs unchanged. A client that
 * sends `X-Vector-Catalog: 2` gets the v2 catalog; any other gets the four-field list older releases decode.
 */
export function codiumGateway(token: string) {
  const state = {
    mode: "ok" as "ok" | "text" | "object" | "credits" | "disabled" | "context" | "capacity",
    // Set to answer every chat request with this status, code and headers instead of a reply.
    // `dispatched` marks an answer given after the gateway sent the request to the provider, as the gateway does.
    answer: undefined as
      | { status: number; code: string; message?: string; headers?: Record<string, string>; dispatched?: boolean }
      | undefined,
    // What the server answers (§4.11): shares, flags and timestamps, never an amount.
    status: {
      enabled: true,
      active: true,
      customer: true,
      access: true,
      plan: {
        id: "vector-50",
        name: "Pro",
        left: 0.06,
        renewsAt: 1_790_000_000_000,
        cancelAtPeriodEnd: false,
        state: "active",
        today: { used: 0.42, resetsAt: 1_789_000_000_000, reached: false },
      },
      listed: [],
      purchased: { bought: false },
      empty: false,
      low: true,
    } as Record<string, unknown>,
  }
  const seen: {
    path: string
    authorization: string | null
    client: string | null
    catalog: string | null
    purpose: string | null
    body?: unknown
  }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const authorization = request.headers.get("authorization")
      seen.push({
        path: url.pathname,
        authorization,
        client: request.headers.get("x-vector-client"),
        catalog: request.headers.get("x-vector-catalog"),
        purpose: request.headers.get("x-vector-purpose"),
        body: request.method === "POST" ? await request.json() : undefined,
      })
      if (authorization !== `Bearer ${token}`)
        return Response.json(
          { error: { code: "CLI_TOKEN_INVALID", message: "Sign in to Vector again to continue." } },
          { status: 401 },
        )
      if (url.pathname === "/api/model-plans/models")
        return Response.json(
          state.mode === "disabled"
            ? { enabled: false, models: [] }
            : request.headers.get("x-vector-catalog") === "2"
              ? codiumCatalogV2
              : { enabled: true, models: [codiumModel] },
        )
      if (url.pathname === "/api/model-plans/status") return Response.json(state.status)
      if (url.pathname !== "/api/model-plans/chat") return new Response("not found", { status: 404 })
      if (state.answer)
        return Response.json(
          {
            error: {
              code: state.answer.code,
              message: state.answer.message ?? "Gateway answer.",
              ...(state.answer.dispatched ? { dispatched: true } : {}),
            },
          },
          { status: state.answer.status, headers: state.answer.headers },
        )
      if (state.mode === "disabled")
        return Response.json(
          { error: { code: "MODEL_PLANS_DISABLED", message: "Vector Codium is not available yet." } },
          { status: 503 },
        )
      if (state.mode === "credits")
        return Response.json(
          {
            error: {
              code: "MODEL_PLAN_EXHAUSTED",
              message:
                "Your monthly Codium credits cannot cover this model's largest request right now. Wait for running requests to finish, choose a model that uses fewer credits, or add a top-up. Monthly credits renew each billing period.",
            },
          },
          { status: 402 },
        )
      if (state.mode === "capacity")
        return Response.json(
          {
            error: {
              code: "MODEL_PLAN_CAPACITY",
              message:
                "Your Codium credits or provider capacity are currently unavailable. Check your balance or retry later.",
            },
          },
          { status: 402 },
        )
      if (state.mode === "context")
        return Response.json(
          {
            error: {
              code: "MODEL_PLAN_CONTEXT",
              message:
                "This request may exceed the model context limit. Shorten the conversation or requested response.",
            },
          },
          { status: 400 },
        )
      return new Response(
        [
          ...(state.mode === "text" ? textStream : state.mode === "object" ? objectStream : toolCallStream).map(
            (chunk) => `data: ${JSON.stringify(chunk)}\n\n`,
          ),
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const forward = (url: string, init?: RequestInit) => {
    if (!url.startsWith(`${ModelPlanStatus.SITE}/`)) throw new Error(`Codium requests must go to vectordev.ai: ${url}`)
    return fetch(`${server.url.origin}${url.slice(ModelPlanStatus.SITE.length)}`, init)
  }
  return { server, state, seen, forward, stop: () => server.stop(true) }
}
