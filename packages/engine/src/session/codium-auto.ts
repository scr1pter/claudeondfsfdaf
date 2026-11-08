export * as SessionCodiumAuto from "./codium-auto"

import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { NamedError } from "@vectordevai/core/util/error"
import type { Provider } from "@/provider/provider"
import { Token } from "@/util/token"

// Codium Auto is what a session keeps; each user message runs on the one model Auto picks for it, chosen once, so
// every step of the message keeps that model and its prompt cache.

/** Whether a model reference names Codium Auto. */
export function isAuto(model: { providerID: string; modelID: string } | undefined) {
  return model?.providerID === ModelPlanStatus.PROVIDER_ID && model.modelID === ModelPlanStatus.AUTO_ID
}

/**
 * The context, in tokens, a new user message adds to: what a request would send after the last compaction boundary
 * (`visible`, as MessageV2.filterCompacted reads it) plus the message's own parts. The newest finished request after
 * the boundary counts as the provider measured it, with what came after it estimated; a summary's measured size is
 * left out, since its input was the history it replaced. An estimate of the whole history is the floor, for a provider
 * that reports no usage.
 */
export function contextTokens(visible: readonly SessionV1.WithParts[], added: readonly SessionV1.Part[] = []) {
  const all = estimate(visible.flatMap((message) => message.parts))
  const boundary = visible.findLast((message) => message.info.role === "assistant" && message.info.summary)?.info.id
  const index = visible.findLastIndex(
    (message) =>
      message.info.role === "assistant" &&
      !message.info.summary &&
      !!message.info.finish &&
      (!boundary || message.info.id > boundary),
  )
  const last = visible[index]
  if (last?.info.role !== "assistant") return all + estimate(added)
  const tokens = last.info.tokens
  // The measured request did not include its own tool results, which the next request sends.
  const after = estimate([
    ...last.parts.filter((part) => part.type === "tool"),
    ...visible.slice(index + 1).flatMap((message) => message.parts),
  ])
  return Math.max(tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + after, all) + estimate(added)
}

/**
 * The session error for a model that cannot run, Codium Auto included. A Codium notice carries its action, so the app
 * can offer Sign in to Vector next to it.
 */
export function notice(err: Provider.ModelNotFoundError) {
  return err.codium
    ? new SessionV1.APIError({
        message: err.unavailable?.message ?? err.message,
        isRetryable: false,
        metadata: { codium: err.codium },
      }).toObject()
    : new NamedError.Unknown({ message: err.message }).toObject()
}

function estimate(parts: readonly SessionV1.Part[]) {
  return Token.estimate(
    parts
      .map((part) => {
        if (part.type === "text" || part.type === "reasoning") return part.text
        if (part.type === "tool" && part.state.status === "completed")
          return part.state.time.compacted ? "" : JSON.stringify(part.state.input) + part.state.output
        if (part.type === "tool") return JSON.stringify(part.state.input)
        if (part.type === "subtask") return part.prompt
        return ""
      })
      .join(""),
  )
}
