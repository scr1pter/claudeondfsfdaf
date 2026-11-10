import { Effect, Option, Schema } from "effect"
import { Tool } from "./tool"
import { TaskManager } from "@/task/manager"
import { ShellJobs } from "@/task/shells"
import type { TaskPromptOps } from "./task"
import { ToolJsonSchema } from "./json-schema"
import { ResearchRun } from "./research-run"
import { assertExternalDirectoryEffect } from "./external-directory"
import { TaskMailbox } from "@vectordevai/core/task-mailbox"
import { abortError, waitForAbort } from "@vectordevai/core/process"

const ids = Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(200))
// Provider adapters flatten root unions and can lose their action discriminators.
// Advertise one object, but validate each action against Parameters before execution.
export const PublicParameters = Schema.Struct({
  action: Schema.Literals(["list", "inspect", "message", "stop", "wait", "resume", "report", "merge", "discard"]),
  task_id: Schema.optional(Schema.String).annotate({
    description: "Required for inspect, message, merge and discard",
  }),
  task_ids: Schema.optional(ids).annotate({
    description:
      "Required for wait and resume; selects tasks for stop. stop and wait also take background command IDs (shl_…)",
  }),
  text: Schema.optional(Schema.String).annotate({
    description: "Required for message and report; optional for resume",
  }),
  descendants: Schema.optional(Schema.Boolean).annotate({ description: "Include descendants in list" }),
  siblings: Schema.optional(Schema.Boolean).annotate({
    description: "list: your parent's other children (subagents only)",
  }),
  wake: Schema.optional(Schema.Boolean).annotate({
    description: "report: start your parent's turn for a blocker (once per run)",
  }),
  delivery: Schema.optional(Schema.Literals(["steer", "queue"])),
  all: Schema.optional(Schema.Boolean).annotate({ description: "Stop all tasks instead of selecting task_ids" }),
  reason: Schema.optional(Schema.String).annotate({ description: "stop or discard: why, kept with the record" }),
  diff: Schema.optional(Schema.Boolean).annotate({
    description: "inspect: include an isolated child's changed files and patch",
  }),
  files: Schema.optional(Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(500))).annotate({
    description: "merge: only these repository-relative paths",
  }),
  mode: Schema.optional(Schema.Literals(["any", "all"])),
  timeout: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 60000 }))),
})

export const Parameters = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("list"),
    descendants: Schema.optional(Schema.Boolean),
    siblings: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ action: Schema.Literal("inspect"), task_id: Schema.String, diff: Schema.optional(Schema.Boolean) }),
  Schema.Struct({
    action: Schema.Literal("merge"),
    task_id: Schema.String,
    files: Schema.optional(Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(500))),
    force: Schema.optional(Schema.Never),
    includeStacked: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    action: Schema.Literal("discard"),
    task_id: Schema.String,
    reason: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  }),
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
  Schema.Struct({
    action: Schema.Literal("resume"),
    task_ids: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    text: Schema.optional(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literal("report"), text: Schema.String, wake: Schema.optional(Schema.Boolean) }),
])

const PROMPTED = new Set(["message", "stop", "resume", "report"])

export const TaskManageTool = Tool.define(
  "task_manage",
  Effect.gen(function* () {
    const tasks = yield* TaskManager.Service
    // A message to a research agent is checked as its brief was. Without the research run (a test that builds the
    // tool alone) there is no research agent to message.
    const research = yield* Effect.serviceOption(ResearchRun.Service)
    return {
      description:
        "Manage subagents without starting a model. list: status, spend and dependencies. inspect: recent progress, output and messages; diff:true reviews isolated changes. merge: bring a direct child's reviewed isolated changes into your files, optionally selecting files. discard: retain a recovery artifact and remove a direct child's isolated checkout. message: instructions or the user's correction for a running child, at its next step (steer) or after its current work (queue). stop: end tasks, keeping partial work. resume: continue stopped, failed or interrupted children in the background. wait: until any or all task_ids end, or timeout ms. report: as a background subagent, send your parent a short note while you work. A message cannot widen a child's task or permissions.",
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(PublicParameters),
      execute: (input: typeof Parameters.Type, context: Tool.Context) =>
        Effect.gen(function* () {
          if (input.action === "wait" && context.abort.aborted)
            return yield* Effect.fail(abortError(context.abort))
          const ops = context.extra?.promptOps as TaskPromptOps | undefined
          if (PROMPTED.has(input.action) && !ops)
            return yield* Effect.die(new Error("Task management requires prompt operations"))
          if (input.action === "message" && Option.isSome(research)) {
            const screened = yield* research.value.message({ ctx: context, taskID: input.task_id, text: input.text })
            if (screened.type === "refused") return yield* Effect.fail(new Error(screened.message))
          }
          const sessionID = context.sessionID
          const by = {
            kind: "agent" as const,
            sessionID,
            ask: context.ask,
            assertWritable: (input: { files: string[] }) =>
              context.assertWritable
                ? context.assertWritable(input)
                : Effect.fail(new globalThis.Error("Merging requires Vector's writable-path checks.")),
            assertExternalDirectory: (file: string) => assertExternalDirectoryEffect(context, file),
          }
          const result = yield* ((): Effect.Effect<unknown, TaskManager.Error | Error> => {
            switch (input.action) {
              case "list":
                // The agent sees its running background commands and the few that ended last (5.H); the route lists
                // them all.
                return input.siblings
                  ? tasks.list({ sessionID, siblings: true })
                  : tasks
                      .list({ sessionID, descendants: input.descendants, shells: true })
                      .pipe(
                        Effect.map((result) =>
                          result.shells ? { ...result, shells: ShellJobs.forAgent(result.shells) } : result,
                        ),
                      )
              case "inspect":
                if (input.diff)
                  return tasks.changes({ sessionID, taskID: input.task_id, diff: true, control: true }).pipe(
                    Effect.map((result) => ({
                      ...result,
                      ...(result.patch !== undefined
                        ? {
                            patch: TaskMailbox.envelope(result.patch, {
                              sender: input.task_id,
                              recipient: sessionID,
                            }),
                          }
                        : {}),
                    })),
                  )
                return tasks.inspect({ sessionID, taskID: input.task_id })
              case "merge":
                return tasks.merge({ sessionID, taskID: input.task_id, files: input.files, by })
              case "discard":
                return tasks.discard({ sessionID, taskID: input.task_id, by, reason: input.reason })
              case "message":
                return tasks.message(
                  { sessionID, taskID: input.task_id, text: input.text, delivery: input.delivery },
                  ops!,
                )
              case "stop":
                return tasks.stop({ sessionID, taskIDs: input.task_ids, all: input.all, reason: input.reason }, ops!)
              case "resume":
                return tasks.resume(
                  { sessionID, taskIDs: input.task_ids, text: input.text, origin: "agent", guest: false },
                  ops!,
                )
              case "report":
                return tasks.report({ sessionID, text: input.text, wake: input.wake }, ops!)
              case "wait":
                // A wait ends when its call is aborted; the tasks it waited on keep running.
                return tasks
                  .wait({ sessionID, taskIDs: input.task_ids, mode: input.mode, timeout: input.timeout })
                  .pipe(Effect.raceFirst(waitForAbort(context.abort)))
            }
          })()
          return { title: `Task ${input.action}`, metadata: { action: input.action }, output: JSON.stringify(result) }
        }).pipe(Effect.orDie),
    }
  }),
)
