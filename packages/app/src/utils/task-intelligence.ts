import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { freeModelMayTrain, type FreeModelChoice } from "@vectordevai/core/free-model-choice"
import { isFreeModelRef } from "@vectordevai/schema/free-model"
import { TaskSize } from "@vectordevai/core/task-size"

export type TaskDifficulty = "trivial" | "simple" | "standard" | "complex"

export type AgentTaskPreparation = {
  difficulty: TaskDifficulty
  useQuickAgent: boolean
  recommendedVariant: "light" | "balanced" | "max"
  retryLimit: number
  instruction?: string
}

type RoutableModel = {
  id: string
  name: string
  family?: string
  status?: string
  provider: { id: string }
  freeModel?: FreeModelChoice["freeModel"]
  capabilities?: {
    reasoning?: boolean
    toolcall?: boolean
    input?: Partial<Record<"text" | "image" | "audio" | "video" | "pdf", boolean>>
  }
  modalities?: { input?: string[] }
  limit?: { context?: number; output?: number }
  variants?: Record<string, unknown>
  /** What Vector Codium's list says about the entry: Auto, locked or manual-only entries are never routed to. */
  codium?: ModelPlanStatus.Listing
}

export function supportsImageInput(model: RoutableModel) {
  if (model.capabilities?.input?.image === true) return true
  return model.modalities?.input?.includes("image") === true
}

export function isFreeModelSelection(model: RoutableModel) {
  return (
    model.provider.id === "vector" ||
    !!model.freeModel ||
    isFreeModelRef({ providerID: model.provider.id, modelID: model.id })
  )
}

// One classifier for the engine, the app and desktop: TaskSize. The app's names for the sizes predate it. Only a sender
// picks Light, so a message the app classifies is trivial (a social message), standard or, when the user asks for it,
// complex.
const DIFFICULTY = {
  chat: "trivial",
  light: "simple",
  standard: "standard",
  thorough: "complex",
} as const satisfies Record<TaskSize.Tier, TaskDifficulty>

// Only a social message is trivial, and only when no work is waiting on the user (`open`): then even a "thanks" answers
// or follows up that work, so it goes to the engine with the history rather than to the quick lane. A bare "ok" is
// social too, unless a plan from Plan mode waits on it (`plan`): then it carries the plan out. A message with files,
// images or a named subagent is never trivial, as the engine sizes it: "help" with a screenshot of an error needs the
// tools.
export function classifyTaskDifficulty(
  task: string,
  input: { open?: boolean; plan?: boolean; files?: number; images?: number; agents?: readonly string[] } = {},
): TaskDifficulty {
  if (!task.trim() && !input.files && !input.images && !input.agents?.length) return "trivial"
  return DIFFICULTY[TaskSize.classify({ text: task, ...input }).tier]
}

type HistoryMessage = {
  id: string
  role: string
  agent?: string
  size?: string
  error?: unknown
  finish?: string
  time: { created: number; completed?: number }
}
type HistoryPart = { type: string; text?: string; synthetic?: boolean; tool?: string; state?: { status?: string } }

/**
 * Whether a session's work is waiting on the user, as the engine reads it: the agent's last reply asked or offered
 * something, it asked through the question tool and the user dismissed it, or its run did not finish (it failed, was
 * stopped, or is still going). A greeting's reply is never open: its "How about you?" waits on nothing.
 */
export function workOpen(
  messages: readonly HistoryMessage[],
  parts: (messageID: string) => readonly HistoryPart[] | undefined,
) {
  const last = messages.findLast((message) => message.role === "assistant")
  if (!last) return false
  if (last.size === "chat" || last.agent === "quick") return false
  if (last.error || !last.time.completed || UNFINISHED.has(last.finish ?? "")) return true
  if (
    (parts(last.id) ?? []).some(
      (part) => part.type === "tool" && part.tool === "question" && part.state?.status !== "completed",
    )
  )
    return true
  // The agent's closing words, not a later card without text such as the judge's.
  const text = messages
    .filter((message) => message.role === "assistant")
    .map((message) =>
      (parts(message.id) ?? [])
        .flatMap((part) => (part.type === "text" && !part.synthetic && part.text?.trim() ? [part.text] : []))
        .join("\n"),
    )
    .findLast((item) => item.length > 0)
  return TaskSize.asks(text ?? "")
}

/**
 * Whether the work before the next message is a plan from Plan mode that nobody has carried out yet, as the engine reads
 * it: the last reply that was not a greeting's came from the plan agent. Then "ok" approves the plan.
 */
export function planPending(messages: readonly HistoryMessage[]) {
  return (
    messages.findLast((message) => message.role === "assistant" && message.size !== "chat" && message.agent !== "quick")
      ?.agent === "plan"
  )
}

// Finish reasons of a run that stopped before its answer was done, as the engine reads them.
const UNFINISHED = new Set(["length", "tool-calls", "unknown", "error", "content-filter"])

function qualityScore(model: RoutableModel) {
  const label = `${model.id} ${model.name} ${model.family ?? ""}`.toLowerCase()
  const context = Math.max(1, model.limit?.context ?? 1)
  const frontier =
    /(?:opus|gpt[- ]?5[.-]?[5-9]|o[3-9](?:\b|-)|gemini.*pro|sonnet.*4|kimi.*k[23]|qwen.*coder.*(?:max|plus)|codestral)/.test(
      label,
    )
  const lightweight = /(?:nano|mini|flash|haiku|lite|small|free|\b[1-9]b\b)/.test(label)
  return (
    (model.capabilities?.reasoning ? 26 : 0) +
    (model.capabilities?.toolcall ? 18 : -40) +
    Math.min(30, Math.log2(context) * 1.35) +
    (frontier ? 34 : 0) -
    (lightweight ? 28 : 0) +
    (model.status === "active" ? 4 : 0) -
    (model.status === "deprecated" ? 80 : 0)
  )
}

export function routeModelForTask<T extends RoutableModel>(input: {
  difficulty: TaskDifficulty
  current: T
  available: T[]
}) {
  if (input.difficulty !== "complex") return { model: input.current, routed: false }
  // Codium Auto already picks a model for each message's size.
  if (input.current.provider.id === ModelPlanStatus.PROVIDER_ID && ModelPlanStatus.isAuto(input.current))
    return { model: input.current, routed: false }
  const candidates = input.available
    .filter((model) => model.provider.id === input.current.provider.id)
    // Never onto Codium Auto, a model the plan does not include, or one the person only chooses by name (§4.12).
    .filter((model) => model.id === input.current.id || codiumTarget(model))
    .filter((model) => !isFreeModelSelection(input.current) || model.freeModel)
    // Routing never moves a prompt onto a free model whose provider may train on it; the person picks one themselves.
    .filter((model) => model.id === input.current.id || !freeModelMayTrain(model))
    .filter((model) => model.status !== "deprecated" && model.capabilities?.toolcall !== false)
    .toSorted((left, right) => qualityScore(right) - qualityScore(left))
  const strongest = candidates[0]
  if (!strongest || qualityScore(strongest) < qualityScore(input.current) + 12) {
    return { model: input.current, routed: false }
  }
  return { model: strongest, routed: strongest.id !== input.current.id }
}

export function routeModelForImages<T extends RoutableModel>(input: {
  current: T
  available: T[]
}): { model: T | undefined; routed: boolean } {
  // The guarded free route accepts text only; an image must never silently switch to paid inference.
  if (isFreeModelSelection(input.current)) return { model: undefined, routed: false }
  if (supportsImageInput(input.current)) return { model: input.current, routed: false }
  // Codium spends the account's credits, so an image never moves a prompt onto it; the person picks it themselves.
  const codium = input.current.provider.id === ModelPlanStatus.PROVIDER_ID
  const candidates = input.available
    .filter((model) => supportsImageInput(model))
    .filter((model) => codium || model.provider.id !== ModelPlanStatus.PROVIDER_ID)
    .filter(codiumTarget)
    .filter((model) => model.status !== "deprecated" && model.capabilities?.toolcall !== false)
    .toSorted((left, right) => {
      const leftProvider = left.provider.id === input.current.provider.id ? 1 : 0
      const rightProvider = right.provider.id === input.current.provider.id ? 1 : 0
      return rightProvider - leftProvider || qualityScore(right) - qualityScore(left)
    })
  const selected = candidates[0]
  return { model: selected, routed: !!selected }
}

// A Codium entry routing may move a prompt onto: never Auto, a locked or a manual-only one. Other providers' models
// carry no Codium listing.
function codiumTarget(model: RoutableModel) {
  return model.provider.id !== ModelPlanStatus.PROVIDER_ID || ModelPlanStatus.automatic(model)
}

export function routeVariantForTask(input: { difficulty: TaskDifficulty; selected?: string; variants: string[] }) {
  if (input.selected && input.selected !== "default" && input.variants.includes(input.selected)) return input.selected
  const byName = (names: string[]) => names.find((name) => input.variants.includes(name))
  if (input.difficulty === "complex") return byName(["max", "ultra", "xhigh", "extra", "high"]) ?? input.selected
  if (input.difficulty === "standard") return byName(["balanced", "medium"]) ?? input.selected
  if (input.difficulty === "trivial") return byName(["light", "low"]) ?? input.selected
  return input.selected
}
