import type { AssistantMessage, Message } from "@vectordevai/sdk/v2/client"
import { brandProviderName } from "@/utils/provider-brand"
import { Billing } from "@vectordevai/schema/billing"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type Context = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  tokens: number
  usage: number | null
  codium: boolean
}

const tokenTotal = (msg: AssistantMessage) => {
  // Match the runtime overflow calculation. Reasoning is metered spend but is
  // not automatically retained in the next prompt; providers that include it
  // in their authoritative total still surface it through `tokens.total`.
  const components = msg.tokens.input + msg.tokens.output + msg.tokens.cache.read + msg.tokens.cache.write
  const reported = msg.tokens.total
  if (typeof reported !== "number" || !Number.isFinite(reported)) return components
  return Math.max(reported, components)
}

const providerDisplayName = (id: string, name?: string) => brandProviderName(id, name)

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (tokenTotal(msg) <= 0) continue
    return msg
  }
}

const build = (messages: Message[] = [], providers: Provider[] = []): Context | undefined => {
  const message = lastAssistantWithTokens(messages)
  if (!message) return undefined

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context
  const total = tokenTotal(message)

  return {
    message,
    provider,
    model,
    providerLabel: providerDisplayName(message.providerID, provider?.name),
    modelLabel: model?.name ?? message.modelID,
    limit,
    input: message.tokens.input,
    tokens: total,
    usage: limit ? Math.round((total / limit) * 100) : null,
    codium: Boolean(Billing.of(message)),
  }
}

export function getSessionContext(messages: Message[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}
