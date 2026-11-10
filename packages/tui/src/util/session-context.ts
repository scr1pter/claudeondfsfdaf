import type { Message } from "@vectordevai/sdk/v2"

// Context is the latest measured turn, not lifetime billable usage. Hidden reasoning is not automatically retained;
// use it only through an authoritative total, matching the frontend context gauge.
export function getSessionContext(messages: readonly Message[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    const components =
      message.tokens.input + message.tokens.output + message.tokens.cache.read + message.tokens.cache.write
    const reported = message.tokens.total
    const tokens =
      typeof reported === "number" && Number.isFinite(reported) ? Math.max(reported, components) : components
    if (tokens <= 0) continue
    return { message, tokens }
  }
}
