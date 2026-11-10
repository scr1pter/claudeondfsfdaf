export * as ResearchPlan from "./plan"

import { Option, Schema } from "effect"
import type { Permission } from "@vectordevai/schema/permission"
import { Research } from "@vectordevai/schema/research"
import type { RunBudget } from "@vectordevai/schema/run-budget"
import type { Config } from "../config"
import { Egress } from "../local-mode/egress"
import type { ConfigResearchV1 } from "../v1/config/research"

// What a Deep research run is planned and capped by, for both runners (sections 5.2, 5.4 and 11.2): the plan card's
// answers, the default caps, and the run's own messages. The V1 engine's research tools and the V2 core research tools
// read the same rules from here, so a run behaves and stores the same on either.

/** Caps for one run: its spend and steps, the pages and searches the store counts, and its researchers. */
export type Limits = {
  readonly usd: number
  readonly steps: number
  readonly pages: number
  readonly searches: number
  readonly researchers: number
}

/** Default caps when the user has none. Dollar caps exclude Codium; step limits still apply. */
export const LIMITS: Readonly<Record<Research.Depth, Limits>> = {
  focused: { usd: 1, steps: 80, pages: 15, searches: 8, researchers: 2 },
  deep: { usd: 3, steps: 240, pages: 40, searches: 24, researchers: 4 },
}

/** The user's own research settings, merged, and the sites a repository adds to avoid, which is all it may set. */
export type Settings = { readonly own: ConfigResearchV1.Info; readonly avoid: readonly string[] }

/**
 * Research's settings from a location's config entries, lowest priority first. Its caps, preferred sites and
 * robots.txt are the user's own: a checked-in repository config could otherwise raise the caps or choose what research
 * reads. A repository's block only adds sites to avoid, which narrows what research reads.
 */
export function settings(
  entries: readonly Config.Entry[],
  scope: ((entry: Config.Entry) => Config.Scope) | undefined,
): Settings {
  const documents = entries.filter((entry): entry is Config.Document => entry.type === "document")
  return {
    own: documents
      .filter((document) => (scope?.(document) ?? "global") === "global")
      .flatMap((document) => (document.info.research ? [document.info.research] : []))
      .reduce<ConfigResearchV1.Info>(merge, {}),
    avoid: documents
      .filter((document) => scope?.(document) === "project")
      .flatMap((document) => document.info.research?.domains?.avoid ?? []),
  }
}

/** A run's caps for a depth: the defaults, with the user's own limits for it laid over them. */
export function limits(chosen: Settings, depth: Research.Depth): Limits {
  return { ...LIMITS[depth], ...chosen.own.limits?.[depth] }
}

/** The spend and step part of a run's caps, as the spend guard holds a run to it. */
export function budget(caps: Limits): RunBudget.Info {
  return { usd: caps.usd, steps: caps.steps }
}

export const NO_PLAN =
  "Plan the research with research_plan first: nothing is searched or read before the plan is approved."
export const STOPPED = "This research was stopped. Plan a new run with research_plan only if the user asks for one."
export const READ_APPROVAL =
  "Read public pages for this research? Vector reads only pages from search results, links on pages it read, and addresses you typed. This approval lasts for this research only."
export const OFFLINE =
  "Vector Local's Web access is None, so this research uses this repository's brain and files only: it searches and reads nothing on the web."

/**
 * Whether Vector Local is on with Web access None, as it also is while the policy is still being resolved. Research
 * then uses the brain and the repository's files only (section 5.9): its plan's scope is the brain whatever was
 * proposed, and it searches and reads nothing on the web.
 */
export function offline() {
  const policy = Egress.policy()
  return policy.enabled && policy.web === "none"
}

/** The research tools that reach the web, which research is not offered while Vector Local's Web access is None. */
export const NETWORK_TOOLS = ["research_search", "research_read", "research_browser"] as const

/** The rules that keep research's network tools from every agent while Web access is None, and none otherwise. */
export function withheld(): Permission.Ruleset {
  return offline() ? NETWORK_TOOLS.map((action) => ({ action, resource: "*", effect: "deny" as const })) : []
}

/** The plan card's buttons. */
export const START = "Start"
export const START_DEEP = "Start deep"
export const CANCEL = "Cancel"
/** The plan card's own answer: `vector-plan:{json}` with the fields the user edited. */
export const PREFIX = "vector-plan:"

// A bare approval typed on the card ("ok", "yes", "go ahead") starts the plan as it is (section 5.2).
const APPROVAL =
  /^(?:please[\s,]+)?(?:ok(?:ay)?|yes|yeah|yep|yup|sure|start(?: it)?|go(?: ahead)?|go for it|do it|sounds good|looks good|lgtm|approved?)(?:[\s,]+(?:please|thanks|thank you))?[\s.!]*$/i
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Research.PlanAnswer))

/** What the user's answer on the plan card means: start (with what they edited), cancel, or a steer. */
export type Decision =
  | {
      readonly type: "start"
      readonly answer: "start" | "start-deep"
      readonly plan: Research.Plan
      readonly always: readonly ("prefer_domains" | "avoid_domains" | "format")[]
    }
  | { readonly type: "cancel" }
  | { readonly type: "steer" }

/**
 * What the user's answer on the plan card means. `vector-plan:{json}` is the card's own answer, with any fields the
 * user edited and those they asked Vector to remember; any other text is a steer. A plan goes no deeper than
 * `ceiling`, and with Web access None an edited scope stays the brain.
 */
export function decide(reply: string, plan: Research.Plan, ceiling: Research.Depth, offline: boolean): Decision {
  if (reply === START) return { type: "start", answer: "start", plan, always: [] }
  if (reply === START_DEEP)
    return { type: "start", answer: "start-deep", plan: { ...plan, depth: deeper("deep", ceiling) }, always: [] }
  if (reply === CANCEL) return { type: "cancel" }
  if (APPROVAL.test(reply)) return { type: "start", answer: "start", plan, always: [] }
  if (!reply.startsWith(PREFIX)) return { type: "steer" }
  const decoded = decodeAnswer(reply.slice(PREFIX.length))
  if (Option.isNone(decoded)) return { type: "steer" }
  const answer = decoded.value
  if (answer.action === "cancel") return { type: "cancel" }
  return {
    type: "start",
    answer: answer.action,
    plan: {
      ...plan,
      ...answer.plan,
      ...(offline ? { scope: "brain" as const } : {}),
      depth: answer.action === "start-deep" ? deeper("deep", ceiling) : plan.depth,
    },
    always: [...(answer.always ?? [])],
  }
}

/** A depth no deeper than `ceiling`. */
export function deeper(depth: Research.Depth, ceiling: Research.Depth): Research.Depth {
  return depth === "deep" && ceiling === "deep" ? "deep" : "focused"
}

/** The same question and sub-questions: what a call that only changes their status sends. */
export function same(left: Research.Plan, right: Research.Plan) {
  return (
    left.question === right.question &&
    left.subquestions.length === right.subquestions.length &&
    left.subquestions.every((item, index) => item === right.subquestions[index])
  )
}

/** The plan's sites with the user's own, each once. */
export function domains(
  key: "prefer_domains" | "avoid_domains",
  proposed?: readonly string[],
  own?: readonly string[],
) {
  const all = sites(proposed, own)
  return all.length ? { [key]: all } : {}
}

/** Sites as a plan keeps them: trimmed, lowercased, each once, at most 50. */
export function sites(...lists: (readonly string[] | undefined)[]) {
  return [
    ...new Set(
      lists
        .flatMap((list) => list ?? [])
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, 50)
}

/** What the plan card calls a scope. */
export function scopeLabel(scope: Research.Scope) {
  if (scope === "web") return "the web"
  if (scope === "brain") return "this repository's brain and files"
  return "the web and this repository's brain"
}

/** A site as the user's lists compare it: lower case, without "www." or a leading wildcard. */
export const normal = (domain: string) =>
  domain
    .trim()
    .toLowerCase()
    .replace(/^\*?\.|\.$/g, "")
    .replace(/^www\./, "")

// One research block over another, as the V1 config merges them: a later block's settings win, its limits merge into
// the earlier ones, and the sites it prefers or avoids join theirs.
function merge(base: ConfigResearchV1.Info, next: ConfigResearchV1.Info): ConfigResearchV1.Info {
  const union = (left?: readonly string[], right?: readonly string[]) =>
    left || right ? [...new Set([...(left ?? []), ...(right ?? [])])] : undefined
  const prefer = union(base.domains?.prefer, next.domains?.prefer)
  const avoid = union(base.domains?.avoid, next.domains?.avoid)
  const focused =
    base.limits?.focused || next.limits?.focused ? { ...base.limits?.focused, ...next.limits?.focused } : undefined
  const deep = base.limits?.deep || next.limits?.deep ? { ...base.limits?.deep, ...next.limits?.deep } : undefined
  return {
    ...base,
    ...next,
    ...(focused || deep ? { limits: { ...(focused ? { focused } : {}), ...(deep ? { deep } : {}) } } : {}),
    ...(prefer || avoid ? { domains: { ...(prefer ? { prefer } : {}), ...(avoid ? { avoid } : {}) } } : {}),
  }
}
