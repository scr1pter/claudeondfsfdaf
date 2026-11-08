export * as SubagentModel from "./subagent-model"

import { Effect, Schema } from "effect"
import { freeModelMayTrain } from "@vectordevai/core/free-model-choice"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { TaskSize } from "@vectordevai/core/task-size"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SessionWorkflow } from "@/session/workflow"
import { RESEARCH, RESEARCH_JUDGE, RESEARCHER, type Info as AgentInfo } from "./agent"
import { GENERAL_SUBAGENT, type SubagentEffort, type SubagentModelSource, type SubagentRecord } from "./subagent-kind"

// Which model and effort a subagent runs with (multi-agent contract 5.E.1). The first rule that matches decides the
// model: a fork, a research agent, an agent that pins a model, the free route, a model the brief names, then the
// routing the task tool always had. Effort comes after: the brief's, a warm resume's, or Thorough's high passed down.

type Ref = { providerID: ProviderV2.ID; modelID: ModelV2.ID }
type Level = "off" | "low" | "medium" | "high"

export type Parent = {
  model: Ref
  /** The user's variant on the parent's step. */
  variant?: string
  /** The parent's own sized effort (ctx.extra.effort): a fork's effort and a brief's ceiling. */
  sized?: TaskSize.Effort
  /**
   * The effort the parent's request size gives (ctx.extra.passdown), which only Thorough makes high; defaults to `sized`.
   * On a caching provider `sized` stays high while the cache of an earlier Thorough request is warm, which a child,
   * starting a cache of its own, has no reason to share.
   */
  passdown?: TaskSize.Effort
  /** The parent runs on a free model, whose route its children keep. */
  free: boolean
  /** The request's learned default moves general subagents to the small model. */
  learnedSmall: boolean
  guest: boolean
}

export type Ask = {
  model?: string
  effort?: SubagentEffort
  fork: boolean
  resume?: { record: SubagentRecord; warm: boolean }
}

export type Choice = {
  model: Ref
  /** The variant the child's prompt carries. */
  variant?: string
  effort?: SubagentEffort
  /** The variant the record names: the child's, or the one its pinned model applies at session start. */
  recorded?: string
  source: SubagentModelSource
}

export class Refused extends Schema.TaggedErrorClass<Refused>()("SubagentModel.Refused", {
  message: Schema.String,
}) {}

export const FORK = "A fork runs on your model and effort so it can share your prompt cache; write a brief instead."
const RESEARCH_AGENTS = new Set([RESEARCH, RESEARCHER, RESEARCH_JUDGE])
const HIGH_VARIANTS = ["high", "xhigh", "max"]
const RANK: Record<Level, number> = { off: 0, low: 1, medium: 2, high: 3 }
const LISTED = 12

/**
 * The most a brief may ask for: the user's variant when one is set (high, xhigh and max give high), else high under
 * Thorough's sized effort, else the model's default ("default", which `level` maps through the model).
 */
export function ceiling(p: { variant?: string; sized?: TaskSize.Effort }): SubagentEffort {
  const picked = p.variant && p.variant !== "default" ? ProviderTransform.level(p.variant) : undefined
  if (picked) return picked === "off" ? "low" : picked
  if (p.sized === "high") return "high"
  return "default"
}

/** An effort as a level on `model`: "default" is the level the model runs at when nothing picks one. */
export function level(effort: SubagentEffort, model: Provider.Model | undefined): Level {
  if (effort !== "default") return effort
  return model ? ProviderTransform.defaultEffort(model) : "medium"
}

/** Whether a resumed child's cache is still warm: its last run ended within its model's cache lifetime. */
export function warm(record: SubagentRecord, model: Provider.Model | undefined, now = Date.now()) {
  const ended = record.completedAt ?? record.interruption?.at
  if (ended === undefined) return true
  if (!model) return false
  return now - ended < ProviderTransform.cacheLifetime(model)
}

/**
 * Whether a brief may move a child from `parent` to `candidate`: never a model that may train on prompts; with a guest
 * in the tree only a strictly cheaper one; under Vector Local only the parent's provider; otherwise the parent's
 * provider at no higher price per input and output token, or an exact `sizing.subagents.models` entry. "provider/*" and
 * "*" entries widen only which providers count. An unknown price is never cheaper.
 */
export function allowed(
  candidate: Provider.Model,
  parent: Provider.Model,
  o: { allow?: readonly string[]; guest: boolean; local: boolean },
): { ok: true } | { ok: false; reason: string } {
  const ref = `${candidate.providerID}/${candidate.id}`
  if (freeModelMayTrain(candidate)) return { ok: false, reason: `${ref} may train on prompts` }
  if (candidate.providerID === parent.providerID && candidate.id === parent.id) return { ok: true }
  if (o.local && candidate.providerID !== parent.providerID)
    return { ok: false, reason: `Vector Local keeps subagents on your provider (${parent.providerID})` }
  if (o.guest && !SessionWorkflow.cheaper(candidate, parent))
    return { ok: false, reason: `a guest is in this conversation, so a subagent may only use a cheaper model` }
  const allow = o.allow ?? []
  const exact = allow.includes(ref)
  if (exact && !o.guest) return { ok: true }
  if (
    !exact &&
    candidate.providerID !== parent.providerID &&
    !allow.includes(`${candidate.providerID}/*`) &&
    !allow.includes("*")
  )
    return { ok: false, reason: `${ref} is not on your provider and the user has not allowed it` }
  if (o.guest) return { ok: true }
  if (candidate.cost.unpriced || parent.cost.unpriced)
    return { ok: false, reason: `${ref} has no known price to compare with yours` }
  if (candidate.cost.input > parent.cost.input || candidate.cost.output > parent.cost.output)
    return { ok: false, reason: `${ref} costs more than your model` }
  return { ok: true }
}

export const choose = Effect.fn("SubagentModel.choose")(function* (i: {
  parent: Parent
  next: AgentInfo
  ask: Ask
  allow?: readonly string[]
  local: boolean
}) {
  const provider = yield* Provider.Service
  const { parent, next, ask } = i
  const variant = parent.variant && parent.variant !== "default" ? parent.variant : undefined
  const lookup = (ref: Ref) =>
    provider
      .getModel(ref.providerID, ref.modelID)
      .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
  const names = (text: string) => {
    const value = text.trim()
    return value === parent.model.modelID || value === `${parent.model.providerID}/${parent.model.modelID}`
  }

  // The model a brief names: whole as a model ID on the parent's provider, else "provider/model", or "small".
  const named = Effect.fnUntraced(function* (text: string) {
    const providers = yield* provider.list()
    const parentModel = yield* lookup(parent.model)
    const refuse = (reason: string) =>
      Effect.gen(function* () {
        const listed = parentModel
          ? Object.values(providers)
              .flatMap((item) => Object.values(item.models))
              .filter(
                (item) =>
                  item.capabilities.toolcall &&
                  allowed(item, parentModel, { allow: i.allow, guest: parent.guest, local: i.local }).ok,
              )
              .map((item) => `${item.providerID}/${item.id}`)
              .toSorted((a, b) =>
                a.startsWith(`${parent.model.providerID}/`) === b.startsWith(`${parent.model.providerID}/`)
                  ? a.localeCompare(b)
                  : a.startsWith(`${parent.model.providerID}/`)
                    ? -1
                    : 1,
              )
          : []
        const more = listed.length > LISTED ? `, and ${listed.length - LISTED} more` : ""
        return yield* new Refused({
          message:
            listed.length > 0
              ? `${reason}. Allowed models: ${listed.slice(0, LISTED).join(", ")}${more}.`
              : `${reason}. Leave model out.`,
        })
      })
    const slash = text.indexOf("/")
    const found =
      text === "small"
        ? yield* provider.getSmallModel(parent.model.providerID, parent.model.modelID)
        : (providers[parent.model.providerID]?.models[text] ??
          (slash > 0 ? providers[ProviderV2.ID.make(text.slice(0, slash))]?.models[text.slice(slash + 1)] : undefined))
    const candidate = found && providers[found.providerID]?.models[found.id]
    if (!candidate)
      return yield* refuse(text === "small" ? "Your provider has no small model" : `Unknown model ${text}`)
    if (!candidate.capabilities.toolcall)
      return yield* refuse(`${candidate.providerID}/${candidate.id} cannot call tools`)
    if (!parentModel)
      return yield* refuse("Your model is not in the catalog, so no other model can be checked against it")
    const verdict = allowed(candidate, parentModel, { allow: i.allow, guest: parent.guest, local: i.local })
    if (!verdict.ok) return yield* refuse(verdict.reason)
    // The provider's small model runs at its default effort, however the brief named it.
    const smallest =
      text === "small" ? found : yield* provider.getSmallModel(parent.model.providerID, parent.model.modelID)
    return {
      model: candidate,
      small: smallest?.providerID === candidate.providerID && smallest.id === candidate.id,
    }
  })

  // 1. A fork shares the parent's prompt cache, so it runs exactly as the parent does.
  if (ask.fork) {
    const sized = parent.sized === "default" || parent.sized === "high" ? parent.sized : undefined
    if ((ask.model !== undefined && !names(ask.model)) || (ask.effort !== undefined && ask.effort !== sized))
      return yield* new Refused({ message: FORK })
    return {
      model: parent.model,
      ...(parent.variant ? { variant: parent.variant, recorded: parent.variant } : {}),
      ...(sized ? { effort: sized } : {}),
      source: "fork",
    } satisfies Choice
  }
  // 2. The research run owns its agents' caps and routes.
  const research = RESEARCH_AGENTS.has(next.name)
  if (research && (ask.model !== undefined || ask.effort !== undefined))
    return yield* new Refused({
      message: `The ${next.name} agent runs on the model and effort its research run sets; leave model and effort out.`,
    })
  // 3. An agent that pins a model.
  if (next.model && ask.model !== undefined)
    return yield* new Refused({ message: `The ${next.name} agent sets its own model.` })
  // 4. The free route: children stay on the parent's free model.
  if (parent.free && ask.model !== undefined && !names(ask.model))
    return yield* new Refused({
      message: "You run on a free model, and your subagents stay on it. Leave model out.",
    })

  // 5. A model the brief names, or 6. the routing the task tool always had. A resume keeps the model its brief named
  // while that model is still allowed, as task_manage resume does, so its history stays with the model that wrote it.
  const again = ask.resume?.record.modelSource === "call" && !next.model ? ask.resume.record.model : undefined
  const call =
    parent.free || research
      ? undefined
      : ask.model !== undefined
        ? yield* named(ask.model.trim())
        : again
          ? yield* named(`${again.providerID}/${again.modelID}`).pipe(
              Effect.catchTag("SubagentModel.Refused", () => Effect.succeed(undefined)),
            )
          : undefined
  const free = parent.free
  const inherit = !next.model || free
  // Explore, and general under the learned default, go to the provider's small model only when it is known to cost
  // less; a free parent and an agent with its own model stay where they are.
  const learned = !call && next.name === GENERAL_SUBAGENT && !next.variant && parent.learnedSmall
  const small =
    !call && (next.name === "explore" || learned) && !next.model && !free
      ? yield* provider.getSmallModel(parent.model.providerID, parent.model.modelID)
      : undefined
  const parentInfo =
    small && small.capabilities.toolcall && small.id !== parent.model.modelID ? yield* lookup(parent.model) : undefined
  const cheap = SessionWorkflow.cheaper(small, parentInfo) ? small : undefined
  const model: Ref = call
    ? { providerID: call.model.providerID, modelID: call.model.id }
    : cheap
      ? { providerID: cheap.providerID, modelID: cheap.id }
      : !inherit && next.model
        ? next.model
        : parent.model
  const source: SubagentModelSource = call
    ? "call"
    : cheap
      ? learned
        ? "learned"
        : "small"
      : !inherit && next.model
        ? "agent"
        : "parent"
  const onSmall = Boolean(cheap) || call?.small === true
  // The small model runs at its default effort; a pinned model's variant applies when its session starts. A variant
  // configured for an agent without a model of its own applies on whichever model it runs. Explore on a high-effort
  // parent stops at medium, or the lowest effort the model has: a search gains little from a high reasoning budget.
  const configured = next.model ? undefined : next.variant
  const explore = next.name === "explore" && !configured && !onSmall && inherit && HIGH_VARIANTS.includes(variant ?? "")
  const info = call?.model ?? (explore || ask.effort !== undefined ? yield* lookup(model) : undefined)
  const capped = explore ? ["medium", "low", "minimal"].find((item) => info?.variants?.[item]) : undefined
  const base =
    !inherit && !onSmall ? undefined : (configured ?? (onSmall ? undefined : explore ? capped : parent.variant))
  const pinned = !inherit ? next.variant : undefined
  const chosen = (effort: SubagentEffort | undefined, child: string | undefined): Choice => ({
    model,
    ...(child ? { variant: child } : {}),
    ...(effort ? { effort } : {}),
    ...((child ?? pinned) ? { recorded: child ?? pinned } : {}),
    source,
  })

  // The brief's own effort: never above the parent's, and one the child's model has.
  if (ask.effort !== undefined) {
    const top = ceiling({ variant, sized: parent.sized })
    const parentModel = top === "default" ? yield* lookup(parent.model) : undefined
    const limit = top === "default" ? level("default", parentModel) : top
    const efforts = (["low", "medium", "high"] as const).filter((item) => info?.variants?.[item])
    const fits = (effort: SubagentEffort) => RANK[level(effort, info)] <= RANK[limit]
    const offered = (["default", ...efforts] as SubagentEffort[]).filter(fits)
    const usable = offered.length > 0 ? `Use ${offered.join(", ")}, or leave effort out.` : "Leave effort out."
    if (ask.effort !== "default" && !efforts.includes(ask.effort))
      return yield* new Refused({
        message: `${model.providerID}/${model.modelID} has no ${ask.effort} effort. ${usable}`,
      })
    if (!fits(ask.effort))
      return yield* new Refused({ message: `Effort ${ask.effort} is above your own (${limit}). ${usable}` })
    return chosen(ask.effort, ask.effort === "default" ? undefined : ask.effort)
  }
  // A warm resume keeps the effort its child ran at, so its cache holds.
  const kept = ask.resume?.warm ? ask.resume.record.effort : undefined
  if (kept && !research)
    return chosen(kept, kept === "default" ? undefined : ask.resume?.record.model.variant === kept ? kept : base)
  // Thorough's high effort, through the sized path, for a child nothing else sets an effort for.
  const passdown =
    (parent.passdown ?? parent.sized) === "high" &&
    !research &&
    !onSmall &&
    next.name !== "explore" &&
    source !== "learned" &&
    !base &&
    !next.variant &&
    !SessionWorkflow.sets(next.options)
  return chosen(passdown ? "high" : undefined, base)
})
