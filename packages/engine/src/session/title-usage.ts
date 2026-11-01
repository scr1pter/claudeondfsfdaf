import { EventV2 } from "@vectordevai/core/event"
import { SessionEvent } from "@vectordevai/schema/session-event"
import { LLMEvent, Usage, type UsageInput } from "@vectordevai/llm"
import { DateTime, Effect } from "effect"
import type { Provider } from "@/provider/provider"
import { Session } from "./session"

export function create(input: {
  sessionID: Session.Info["id"]
  model: Provider.Model
  publish: EventV2.Interface["publish"]
  /** What the request was for: a title unless said otherwise. */
  purpose?: "title" | "memory"
}) {
  const pending: { id: EventV2.ID; usage?: Usage }[] = []
  const state = { current: undefined as (typeof pending)[number] | undefined }
  const settle = Effect.fn("TitleUsage.settle")(function* (id: EventV2.ID, reported: Usage, incomplete: boolean) {
    const measured = Object.values(reported).some((value) => typeof value === "number" && Number.isFinite(value))
    const usage = Session.getUsage({ model: input.model, usage: reported, metadata: reported.providerMetadata })
    yield* input.publish(
      SessionEvent.AncillaryUsage,
      {
        sessionID: input.sessionID,
        timestamp: yield* DateTime.now,
        usageID: id,
        purpose: input.purpose ?? "title",
        model: { providerID: input.model.providerID, id: input.model.id },
        // Billing metadata can report a charge without counters; keep that subtotal without inventing usage.
        ...(measured || usage.cost > 0 ? { cost: usage.cost } : {}),
        ...(measured ? { tokens: usage.tokens } : {}),
        ...(usage.unpriced || incomplete || !measured ? { unpriced: true } : {}),
        ...(usage.billing ? { billing: usage.billing } : {}),
        ...(incomplete ? { incomplete: true } : {}),
      },
      { id },
    )
  }, Effect.uninterruptible)
  return {
    started(reported: UsageInput) {
      // Keep each started response: a retry can start another billed attempt before the first emits a finish.
      state.current = { id: EventV2.ID.create(), usage: Usage.from(reported) }
      pending.push(state.current)
    },
    record: Effect.fn("TitleUsage.record")(function* (event: LLMEvent) {
      if ((LLMEvent.is.textDelta(event) || LLMEvent.is.reasoningDelta(event)) && !state.current) {
        // Generation began even if this provider reports usage only at completion.
        state.current = { id: EventV2.ID.create() }
        pending.push(state.current)
      }
      if (!LLMEvent.is.stepFinish(event)) return
      const started = state.current
      const reported = new Usage({
        ...started?.usage,
        ...Object.fromEntries(Object.entries(event.usage ?? {}).filter(([, value]) => value !== undefined)),
        providerMetadata: event.providerMetadata ?? event.usage?.providerMetadata ?? started?.usage?.providerMetadata,
      })
      yield* settle(
        started?.id ?? EventV2.ID.create(),
        reported,
        !Number.isFinite(reported.inputTokens) || !Number.isFinite(event.usage?.outputTokens),
      )
      if (started) pending.pop()
      state.current = undefined
    }, Effect.uninterruptible),
    finish: Effect.fn("TitleUsage.finish")(function* () {
      for (const started of pending) yield* settle(started.id, started.usage ?? new Usage({}), true)
      pending.length = 0
      state.current = undefined
    }, Effect.uninterruptible),
  }
}

export * as TitleUsage from "./title-usage"
