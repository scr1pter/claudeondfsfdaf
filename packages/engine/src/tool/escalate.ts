import { Effect, Schema } from "effect"
import type { TaskSize } from "@vectordevai/core/task-size"
import { Tool } from "./tool"
import DESCRIPTION from "./escalate.txt"

export const Parameters = Schema.Struct({
  reason: Schema.String.annotate({ description: "One line on what the request needs" }),
})

/**
 * What escalate says on the quick lane, where it is the only tool: it hands a message that asks for work to the full
 * agent. Short, because a greeting sends it too.
 */
export const QUICK_DESCRIPTION =
  "Hand this message to the full agent, with tools and the conversation, when it asks you to do, check or change anything."

type Metadata = {
  from?: TaskSize.Tier
  to?: TaskSize.Tier
}

/**
 * The request's size as the session runtime sized it this step; whether the user said "no subagents" (`capped`), and
 * whether they kept it at Work ("no subagents" or "don't be thorough", `held`). The model cannot supply any of them.
 */
export type TaskSizeContext = { readonly tier: TaskSize.Tier; readonly capped?: boolean; readonly held?: boolean }

export const EscalateTool = Tool.define<typeof Parameters, Metadata, never>(
  "escalate",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.sync(() => {
        const current = ctx.extra?.taskSize as TaskSizeContext | undefined
        if (!current)
          return { title: "Not raised", output: "Task sizing does not apply to this session.", metadata: {} }
        // On the quick lane a message the rules took for social asks for work: it goes on as Work, never further.
        if (current.tier === "chat")
          return {
            title: "Work task",
            output:
              "This request is now Work: the repository's tools and the whole conversation are offered from your next step. Do what the user asked.",
            metadata: { from: "chat", to: "standard" },
          }
        if (current.capped || current.held)
          return {
            title: "Not raised",
            output: current.capped
              ? "The user asked not to use subagents or go thorough for this request. Do the work yourself with the tools you have."
              : "The user asked not to go thorough for this request. Carry on with the tools you have.",
            metadata: {},
          }
        if (current.tier === "thorough")
          return {
            title: "Not raised",
            output: "This request is already Thorough. Carry on with the tools you have.",
            metadata: {},
          }
        // Work and Thorough are the only sizes the agent works at, so a raise from Work goes to Thorough. The completed
        // call is the durable record: every later step recomputes the size from the history, so the raise survives a
        // restart, and a reply that continues the work keeps it Thorough.
        return {
          title: "Thorough task",
          // The request's size note was written for its old size and stays as it was, so the prompt cache keeps it; this
          // result is what tells the model the size changed.
          output: `This request is now Thorough from your next step: high reasoning effort for you and the subagents you launch. This replaces the size note on the request. Reason noted: ${params.reason.slice(0, 200)}`,
          metadata: { from: current.tier, to: "thorough" },
        }
      }),
  } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>),
)
