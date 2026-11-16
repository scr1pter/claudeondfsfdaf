import type { SessionV1 } from "@vectordevai/core/v1/session"
import { ComputerScreenshots } from "@vectordevai/core/util/computer-screenshots"
import type { Provider } from "@/provider/provider"
import type { ComputerScale } from "./scale"

/** A frame is for the chosen model, never a helper or a model whose training policy permits using it. */
export function replay(
  messages: readonly SessionV1.WithParts[],
  model: Pick<Provider.Model, "freeModel">,
  options?: { helper?: boolean },
): SessionV1.WithParts[] {
  return options?.helper || (model.freeModel && model.freeModel.dataPolicy !== "no-training")
    ? ComputerScreenshots.stripHistory(messages)
    : [...messages]
}

/** Return parts to prune without rewriting stored history. Batch boundaries keep a cached prefix stable between cuts. */
export function keep(
  messages: readonly SessionV1.WithParts[],
  plan: Pick<ComputerScale.Plan, "keep" | "batch">,
): ReadonlySet<string> {
  const parts = messages.flatMap((message) =>
    message.parts.filter(
      (part) =>
        part.type === "tool" &&
        part.tool === "computer" &&
        part.state.status === "completed" &&
        part.state.attachments?.some((attachment) => attachment.mime.startsWith("image/")),
    ),
  )
  const keep = Number.isSafeInteger(plan.keep) && plan.keep > 0 ? plan.keep : 3
  const batch = Number.isSafeInteger(plan.batch) && plan.batch > 0 ? plan.batch : 1
  const cutoff = Math.floor(Math.max(0, parts.length - keep) / batch) * batch
  return new Set(parts.slice(0, cutoff).map((part) => part.id))
}

export * as ComputerScreens from "./screens"
