import { Effect, Option, Schema } from "effect"
import { Tool } from "./tool"
import { TaskManager } from "@/task/manager"
import type { TaskPromptOps } from "./task"
import { ToolJsonSchema } from "./json-schema"
import { ResearchRun } from "./research-run"
import { abortError, waitForAbort } from "@vectordevai/core/process"

const ids = Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(200))
// Provider adapters flatten root unions and can lose their action discriminators.
// Advertise one object, but validate each action against Parameters before execution.
export const PublicParameters = Schema.Struct({
  action: Schema.Literals(["list", "inspect", "message", "stop", "wait"]),
  task_id: Schema.optional(Schema.String).annotate({ description: "Required for inspect and message" }),
  task_ids: Schema.optional(ids).annotate({ description: "Required for wait; selects tasks for stop" }),
  text: Schema.optional(Schema.String).annotate({ description: "Required for message: instructions or a correction" }),
  descendants: Schema.optional(Schema.Boolean).annotate({ description: "Include descendants in list" }),
  delivery: Schema.optional(Schema.Literals(["steer", "queue"])),
  all: Schema.optional(Schema.Boolean).annotate({ description: "Stop all tasks instead of selecting task_ids" }),
  reason: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.Literals(["any", "all"])),
  timeout: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 60000 }))),
})

export const Parameters = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list"), descendants: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ action: Schema.Literal("inspect"), task_id: Schema.String }),
  Schema.Struct({
    action: Schema.Literal("message"),
    task_id: Schema.String,
    text: Schema.String,
    delivery: Schema.optional(Schema.Literals(["steer", "queue"])),
  }),
  Schema.Struct({
    action: Schema.Literal("stop"),
    task_ids: Schema.optional(ids),
    all: Schema.optional(Schema.Boolean),
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("wait"),
    task_ids: ids,
    mode: Schema.optional(Schema.Literals(["any", "all"])),
    timeout: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 60000 }))),
  }),
])

export const TaskManageTool = Tool.define(
  "task_manage",
  Effect.gen(function* () {
    const tasks = yield* TaskManager.Service
    // A message to a research agent is checked as its brief was. Without the research run (a test that builds the
    // tool alone) there is no research agent to message.
    const research = yield* Effect.serviceOption(ResearchRun.Service)
    return {
      description:
        "Manage delegated tasks without starting a model. list gives compact status, spend and dependencies; inspect gives bounded recent progress and partial output; message sends your instructions or the user’s correction to an existing child at the next safe provider-turn boundary or queues until current work ends; stop settles selected tasks (or all) and retains partial work; wait is event-driven for any/all task IDs with a 0–60000 ms timeout. Use list/inspect to answer the user's status question, not in a polling loop. Prefer automatic completion notifications and useful independent work. When the user asks you to guide or correct a subagent, send that correction with message and confirm admission. Parent instructions stay within the existing assignment and cannot widen a child's permissions. A finished task is never restarted by message; use task with its task_id for an explicit continuation.",
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(PublicParameters),
      execute: (input: typeof Parameters.Type, context: Tool.Context) =>
        Effect.gen(function* () {
          if (input.action === "wait" && context.abort.aborted)
            return yield* Effect.fail(abortError(context.abort))
          const ops = context.extra?.promptOps as TaskPromptOps | undefined
          if ((input.action === "message" || input.action === "stop") && !ops)
            return yield* Effect.die(new Error("Task management requires prompt operations"))
          if (input.action === "message" && Option.isSome(research)) {
            const screened = yield* research.value.message({ ctx: context, taskID: input.task_id, text: input.text })
            if (screened.type === "refused") return yield* Effect.fail(new Error(screened.message))
          }
          const result = yield* input.action === "list"
            ? tasks.list({ sessionID: context.sessionID, descendants: input.descendants })
            : input.action === "inspect"
              ? tasks.inspect({ sessionID: context.sessionID, taskID: input.task_id })
              : input.action === "message"
                ? tasks.message(
                    { sessionID: context.sessionID, taskID: input.task_id, text: input.text, delivery: input.delivery },
                    ops!,
                  )
                : input.action === "stop"
                  ? tasks.stop(
                      { sessionID: context.sessionID, taskIDs: input.task_ids, all: input.all, reason: input.reason },
                      ops!,
                    )
                  : tasks
                      .wait({
                        sessionID: context.sessionID,
                        taskIDs: input.task_ids,
                        mode: input.mode,
                        timeout: input.timeout,
                      })
                      .pipe(Effect.raceFirst(waitForAbort(context.abort)))
          return { title: `Task ${input.action}`, metadata: { action: input.action }, output: JSON.stringify(result) }
        }).pipe(Effect.orDie),
    }
  }),
)
