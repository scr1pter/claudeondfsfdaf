export * as ResearchEstimate from "./estimate"

import { nextStepCostUsd, type ReviewPrice } from "../review/plan"
import type { CostKind } from "../review/types"

// What a research plan is likely to cost, shown on the plan card and always called an estimate. Each agent takes
// about one step per search, per page and per three notes, plus 4 of its own (plan, report, revision, wrap-up; a
// researcher's are its start and its return). A step re-sends the agent's measured base prompt (system plus tools on
// this model) and the excerpts it has read so far, which grow from none to every page's chunk. Each step is priced the
// way Run Guard prices the next step (review/plan.ts nextStepCostUsd): the low figure takes what the step before sent
// as cache reads, the high one pays full price for all of it. With researchers, the lead's share is the plan, the
// launches and the synthesis of what they return, and the judge is one more call over the notes and their passages.

/** Steps an agent takes besides its searches, pages and notes. */
export const LEAD_OVERHEAD = 4
export const RESEARCHER_OVERHEAD = 2
/** Notes per page read, when the plan does not say. */
export const NOTES_PER_PAGE = 0.4
/** What a researcher returns to the lead: 1,500 characters at most. */
export const RETURN_TOKENS = 400
/** A note in the judge's brief: its claim and quote, and the passage around the quote. */
export const NOTE_TOKENS = 300
export const PASSAGE_TOKENS = 230
export const JUDGE_PROMPT = 2_000
/** Output tokens per step, as Run Guard's next-step check counts them (review/plan.ts). */
export const OUTPUT_PER_STEP = 600

export type Speed = {
  /** Generated tokens per second. */
  readonly outputPerSecond: number
  /** Prompt tokens read per second; leave out when not measured. */
  readonly promptPerSecond?: number
  readonly firstTokenSeconds?: number
}

export type Input = {
  readonly pages: number
  readonly searches: number
  readonly notes?: number
  /** Researchers the lead starts: up to 2 in Focused, up to 4 in Deep. */
  readonly researchers?: number
  readonly judge?: boolean
  /** The measured base prompt of the research agent on this model, in tokens. */
  readonly prompt: number
  /** The researcher's, when it runs on another model or prompt; the lead's otherwise. */
  readonly researcherPrompt?: number
  /** Tokens a page read adds: CHUNK_TOKENS, or COMPACT_TOKENS in compact reading. */
  readonly chunkTokens: number
  readonly kind: CostKind
  readonly price?: ReviewPrice
  readonly speed?: Speed
}

export type Agent = {
  readonly role: "lead" | "researcher" | "judge"
  readonly steps: number
  readonly input: number
  readonly uncached: number
}

export type Estimate = {
  /** Model calls across every agent. */
  readonly calls: number
  readonly input: number
  readonly output: number
  /** USD at list prices, when the model has one. */
  readonly usd?: { readonly low: number; readonly high: number }
  /** For a model on a server the user hosts, when its speed was measured. */
  readonly minutes?: number
  readonly agents: readonly Agent[]
}

export function estimate(input: Input): Estimate {
  const researchers = Math.max(0, Math.floor(input.researchers ?? 0))
  const notes = Math.max(0, Math.round(input.notes ?? input.pages * NOTES_PER_PAGE))
  const share = (total: number) => (researchers === 0 ? total : Math.ceil(total / researchers))
  const workers = Array.from({ length: researchers }, () =>
    agent("researcher", {
      steps: share(input.searches) + share(input.pages) + Math.ceil(share(notes) / 3) + RESEARCHER_OVERHEAD,
      prompt: input.researcherPrompt ?? input.prompt,
      grows: input.chunkTokens * share(input.pages),
    }),
  )
  const lead = agent(
    "lead",
    researchers === 0
      ? {
          steps: input.searches + input.pages + Math.ceil(notes / 3) + LEAD_OVERHEAD,
          prompt: input.prompt,
          grows: input.chunkTokens * input.pages,
        }
      : { steps: LEAD_OVERHEAD + researchers, prompt: input.prompt, grows: RETURN_TOKENS * researchers },
  )
  const judge = input.judge
    ? [agent("judge", { steps: 1, prompt: JUDGE_PROMPT + notes * (NOTE_TOKENS + PASSAGE_TOKENS), grows: 0 })]
    : []
  const all = [lead, ...workers, ...judge]
  const calls = all.reduce((sum, item) => sum + item.steps, 0)
  return {
    calls,
    input: all.reduce((sum, item) => sum + item.input, 0),
    output: calls * OUTPUT_PER_STEP,
    ...(input.price && input.kind === "priced"
      ? {
          usd: {
            low: all.reduce((sum, item) => sum + item.low(input.price!), 0),
            high: all.reduce((sum, item) => sum + item.high(input.price!), 0),
          },
        }
      : {}),
    ...(input.kind === "local" && input.speed ? { minutes: minutes(all, input.speed) } : {}),
    agents: all.map((item) => ({ role: item.role, steps: item.steps, input: item.input, uncached: item.uncached })),
  }
}

/** The plan card's line, in the copy deck's words. */
export function copy(input: {
  readonly pages: number
  readonly searches: number
  readonly estimate: Estimate
  readonly kind: CostKind
  readonly capUsd?: number
  readonly capSteps: number
}) {
  const scale = `About ${counted(input.pages, "page", "pages")} and ${counted(input.searches, "search", "searches")}`
  if (input.kind === "priced" && input.estimate.usd)
    return `${scale}. Estimated $${money(input.estimate.usd.low)}–$${money(input.estimate.usd.high)} at list prices.${input.capUsd === undefined ? ` Step cap ${input.capSteps}.` : ` Cap $${money(input.capUsd)}.`}`
  if (input.kind === "codium")
    return `${scale}. Uses your Vector Codium plan; Vector shows no cost estimate for Codium. Step cap ${input.capSteps}.`
  if (input.kind === "local")
    return `${scale}, about ${input.estimate.calls} calls to your local model. No per-token charge. Step cap ${input.capSteps}.${input.estimate.minutes === undefined ? "" : ` On this server that is about ${Math.max(1, Math.round(input.estimate.minutes))} minutes.`}`
  if (input.kind === "free")
    return `${scale}. No per-token charge on this free model, within its daily limits. Step cap ${input.capSteps}.`
  if (input.kind === "plan") return `${scale}. Counts toward your plan's usage limits. Step cap ${input.capSteps}.`
  return `${scale}. This model has no listed price, so Vector cannot estimate the cost. Step cap ${input.capSteps}.`
}

// One agent's steps: step i sends the base prompt and the share of `grows` read before it.
function agent(
  role: Agent["role"],
  input: { readonly steps: number; readonly prompt: number; readonly grows: number },
) {
  const steps = Math.max(1, input.steps)
  const contexts = Array.from(
    { length: steps },
    (_, index) => input.prompt + (steps === 1 ? 0 : Math.round((input.grows * index) / (steps - 1))),
  )
  const cached = contexts.map((_, index) => (index === 0 ? 0 : contexts[index - 1]!))
  return {
    role,
    steps,
    input: contexts.reduce((sum, value) => sum + value, 0),
    uncached: contexts.reduce((sum, value, index) => sum + value - cached[index]!, 0),
    contexts,
    low: (price: ReviewPrice) =>
      contexts.reduce((sum, context, index) => sum + nextStepCostUsd(context, price, cached[index]), 0),
    high: (price: ReviewPrice) => contexts.reduce((sum, context) => sum + nextStepCostUsd(context, price, 0), 0),
  }
}

// On a server the user hosts the agents take turns, so their times add up: per call, the first token, the prompt it
// has not seen yet and the step's output.
function minutes(agents: readonly ReturnType<typeof agent>[], speed: Speed) {
  const seconds = agents.reduce(
    (sum, item) =>
      sum +
      item.steps * ((speed.firstTokenSeconds ?? 0) + OUTPUT_PER_STEP / speed.outputPerSecond) +
      (speed.promptPerSecond ? item.uncached / speed.promptPerSecond : 0),
    0,
  )
  return seconds / 60
}

function counted(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

function money(value: number) {
  return value.toFixed(2)
}
