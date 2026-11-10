import { Billing } from "@vectordevai/schema/billing"
import { CodiumUsage } from "@vectordevai/core/codium-usage"
import type { Session } from "@vectordevai/sdk/v2"
export function titlecase(str: string) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function time(input: number): string {
  const date = new Date(input)
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

export function datetime(input: number): string {
  const date = new Date(input)
  const localTime = time(input)
  const localDate = date.toLocaleDateString()
  return `${localTime} · ${localDate}`
}

export function todayTimeOrDateTime(input: number): string {
  const date = new Date(input)
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()

  if (isToday) {
    return time(input)
  } else {
    return datetime(input)
  }
}

export function number(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}

export function duration(input: number) {
  if (input < 1000) {
    return `${input}ms`
  }
  if (input < 60000) {
    return `${(input / 1000).toFixed(1)}s`
  }
  if (input < 3600000) {
    const minutes = Math.floor(input / 60000)
    const seconds = Math.floor((input % 60000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  if (input < 86400000) {
    const hours = Math.floor(input / 3600000)
    const minutes = Math.floor((input % 3600000) / 60000)
    return `${hours}h ${minutes}m`
  }
  const days = Math.floor(input / 86400000)
  const hours = Math.floor((input % 86400000) / 3600000)
  return `${days}d ${hours}h`
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str
  return str.slice(0, len - 1) + "…"
}

export function truncateLeft(str: string, len: number): string {
  if (str.length <= len) return str
  return "…" + str.slice(-(len - 1))
}

export function truncateMiddle(str: string, maxLength: number = 35): string {
  if (str.length <= maxLength) return str

  const ellipsis = "…"
  const keepStart = Math.ceil((maxLength - ellipsis.length) / 2)
  const keepEnd = Math.floor((maxLength - ellipsis.length) / 2)

  return str.slice(0, keepStart) + ellipsis + str.slice(-keepEnd)
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

// A session's recorded cost, said honestly. A step on a model that lists no price adds nothing to the cost, so a total
// with such steps is only a lower bound, and one made of nothing else is unknown rather than $0.00.
export function spend(cost: number | undefined, unpricedSteps: number | undefined, codiumSteps = 0) {
  const unknown = CodiumUsage.ownUnpricedSteps(unpricedSteps, codiumSteps)
  const own = unknown
    ? cost
      ? `${usd.format(cost)} + unpriced`
      : "cost unknown"
    : codiumSteps && !cost
      ? undefined
      : usd.format(cost ?? 0)
  return CodiumUsage.withCodium(own, codiumSteps)
}

type Spend = Pick<
  Session,
  | "cost"
  | "unpricedSteps"
  | "codiumSteps"
  | "subagentCost"
  | "subagentUnpricedSteps"
  | "subagentCodiumSteps"
  | "model"
  | "tokensOwnOnly"
  | "subagentTokensOwnOnly"
>
type BillingMessage = {
  role?: string
  billing?: string
  unpriced?: boolean
  providerID?: string
  model?: { providerID?: string }
}

// Old engines cannot partition mixed totals. Keep their own dollars, but never expose inseparable Codium tokens.
export function legacyCodium(
  session: Spend | undefined,
  messages: readonly BillingMessage[] = [],
  children: readonly Spend[] = [],
): boolean {
  return (
    CodiumUsage.hasCodium(session, messages, children) &&
    (session?.tokensOwnOnly !== true || session?.subagentTokensOwnOnly !== true)
  )
}

// What a session's work cost: its own steps plus everything its subagents spent, which the backend keeps apart.
export function sessionSpend(
  session: Spend | undefined,
  messages: readonly BillingMessage[] = [],
  children: readonly Spend[] = [],
): { cost: number; unpriced: number; codium: number } {
  const legacy = legacyCodium(session, messages, children)
  const knownOwn = legacy
    ? Math.max(
        messages.filter((message) => message.role === "assistant" && message.unpriced && !Billing.of(message)).length,
        session?.tokensOwnOnly !== true ? 0 : CodiumUsage.ownUnpricedSteps(session.unpricedSteps, session.codiumSteps),
      ) +
      Math.max(
        session?.subagentTokensOwnOnly !== true
          ? 0
          : CodiumUsage.ownUnpricedSteps(session.subagentUnpricedSteps, session.subagentCodiumSteps),
        children.reduce((sum, child) => {
          const spend = sessionSpend(child)
          return sum + CodiumUsage.ownUnpricedSteps(spend.unpriced, spend.codium)
        }, 0),
      )
    : 0
  return {
    cost: (session?.cost ?? 0) + (session?.subagentCost ?? 0),
    unpriced: legacy
      ? Math.max(1, (session?.codiumSteps ?? 0) + (session?.subagentCodiumSteps ?? 0)) + knownOwn
      : (session?.unpricedSteps ?? 0) + (session?.subagentUnpricedSteps ?? 0),
    codium: legacy
      ? Math.max(1, (session?.codiumSteps ?? 0) + (session?.subagentCodiumSteps ?? 0))
      : (session?.codiumSteps ?? 0) + (session?.subagentCodiumSteps ?? 0),
  }
}

export function pluralize(count: number, singular: string, plural: string): string {
  const template = count === 1 ? singular : plural
  return template.replace("{}", count.toString())
}

export * as Locale from "./locale"

/** Raw context quantities require an identified own provider; Codium shows only its percentage. */
export function context(tokens: number, limit: number | undefined, message: Parameters<typeof Billing.of>[0]) {
  const percent = limit ? `${Math.round((tokens / limit) * 100)}%` : undefined
  if (!Billing.hasOwnIdentity(message)) return Billing.of(message) && percent ? `${percent} of context` : undefined
  return percent ? `${number(tokens)} (${percent})` : number(tokens)
}
