import { CodiumUsage } from "@vectordevai/core/codium-usage"
import { createVectorClient } from "@vectordevai/sdk/v2"
import type { Task } from "@vectordevai/schema/task"
import { ServerAuth } from "@/server/auth"
import { Flag } from "@vectordevai/core/flag/flag"
import { errorMessage } from "@vectordevai/tui/util/error"
import { cmd } from "./cmd"
import { UI } from "../ui"

export const TasksCommand = cmd({
  command: "tasks <action> [taskID] [text]",
  describe: "list, inspect, message, stop, or wait for a running server's subagents",
  builder: (yargs) =>
    yargs
      .positional("action", {
        type: "string",
        choices: ["list", "inspect", "message", "stop", "wait"],
        demandOption: true,
      })
      .positional("taskID", { type: "string", describe: "child task ID; use --task for several" })
      .positional("text", { type: "string", describe: "correction to send to the child" })
      .option("attach", {
        type: "string",
        demandOption: true,
        describe: "URL of the server that owns the running tasks",
      })
      .option("session", { type: "string", alias: "s", demandOption: true, describe: "parent session ID" })
      .option("dir", { type: "string", describe: "workspace directory on that server" })
      .option("task", { type: "string", array: true, describe: "task IDs for stop or wait" })
      .option("all", { type: "boolean", default: false, describe: "stop all children of this session" })
      .option("descendants", { type: "boolean", default: false, describe: "include nested children in list" })
      .option("delivery", {
        type: "string",
        choices: ["steer", "queue"],
        default: "steer",
        describe: "message delivery boundary",
      })
      .option("mode", {
        type: "string",
        choices: ["any", "all"],
        default: "any",
        describe: "wait for any or all selected tasks",
      })
      .option("timeout", { type: "number", default: 30_000, describe: "wait timeout in milliseconds, from 0 to 60000" })
      .option("reason", { type: "string", describe: "why this work should stop" })
      .option("json", { type: "boolean", default: false, describe: "print the complete structured response" })
      .option("username", { type: "string", describe: "server username (or VECTOR_SERVER_USERNAME)" })
      .option("password", { type: "string", describe: "server password (prefer VECTOR_SERVER_PASSWORD)" }),
  handler: async (args) => {
    ServerAuth.assertSecurePasswordTransport(args.attach, args.password ?? Flag.VECTOR_SERVER_PASSWORD)
    const client = createVectorClient({
      baseUrl: args.attach,
      directory: args.dir,
      headers: ServerAuth.headers({ username: args.username, password: args.password }),
      throwOnError: true,
    })
    const result = await executeTaskCommand(client, args).catch((error: unknown) => {
      UI.error(errorMessage(error))
      process.exitCode = 1
      return undefined
    })
    if (!result) return
    if (args.json) return console.log(JSON.stringify(tasksForOutput(result), null, 2))
    if ("tasks" in result) {
      console.log(formatTasks(result.tasks))
      if ("truncated" in result && result.truncated) console.log("More tasks are available; narrow the selection.")
      if ("timedOut" in result && result.timedOut) console.log("Wait timed out; completion is not confirmed.")
      return
    }
    if ("task" in result) {
      console.log(formatTasks([result.task]))
      result.steps.forEach((step) => console.log(`${step.tool ?? "step"}: ${step.text}`))
      if (result.output) console.log(result.output)
      if (result.truncated)
        console.log(
          `Output is bounded. Result reference: ${result.task.resultRef ?? result.task.sessionID ?? result.task.id}`,
        )
      return
    }
    console.log(`Message ${result.messageID} accepted for ${result.taskID} (${result.delivery}).`)
  },
})

export async function executeTaskCommand(
  client: ReturnType<typeof createVectorClient>,
  args: {
    action: string
    session: string
    taskID?: string
    text?: string
    task?: string[]
    all?: boolean
    descendants?: boolean
    delivery?: string
    mode?: string
    timeout?: number
    reason?: string
  },
) {
  const tasks = client.experimental.task
  const sessionID = args.session
  if (args.action === "list")
    return (await tasks.list({ sessionID, descendants: args.descendants ? "true" : "false" })).data!
  if (args.action === "inspect") {
    if (!args.taskID) throw new Error("inspect requires a task ID")
    return (await tasks.inspect({ sessionID, taskID: args.taskID })).data!
  }
  if (args.action === "message") {
    if (!args.taskID || !args.text?.trim()) throw new Error("message requires a task ID and non-empty text")
    if (args.delivery && args.delivery !== "steer" && args.delivery !== "queue")
      throw new Error("delivery must be steer or queue")
    return (
      await tasks.message({
        sessionID,
        taskID: args.taskID,
        text: args.text,
        delivery: args.delivery === "queue" ? "queue" : "steer",
      })
    ).data!
  }
  const taskIDs = [...new Set([...(args.taskID ? [args.taskID] : []), ...(args.task ?? [])])]
  if (args.action === "stop") {
    if (args.all && taskIDs.length) throw new Error("Choose --all or specific task IDs")
    if (!args.all && !taskIDs.length) throw new Error("stop requires task IDs or --all")
    return (await tasks.stop({ sessionID, ...(args.all ? { all: true } : { taskIDs }), reason: args.reason })).data!
  }
  if (args.action !== "wait") throw new Error(`Unknown task action: ${args.action}`)
  if (!taskIDs.length) throw new Error("wait requires at least one task ID")
  if (args.mode && args.mode !== "any" && args.mode !== "all") throw new Error("mode must be any or all")
  if (args.timeout !== undefined && (!Number.isInteger(args.timeout) || args.timeout < 0 || args.timeout > 60_000))
    throw new Error("timeout must be an integer from 0 to 60000 milliseconds")
  return (await tasks.wait({ sessionID, taskIDs, mode: args.mode === "all" ? "all" : "any", timeout: args.timeout }))
    .data!
}

/** Old servers cannot partition task tokens; redact only the printed projection, preserving the API result. */
export function tasksForOutput<T extends { tasks: readonly Task.Info[] } | { task: Task.Info } | { messageID: string }>(
  result: T,
) {
  if ("tasks" in result) return { ...result, tasks: result.tasks.map(taskForOutput) }
  if ("task" in result) return { ...result, task: taskForOutput(result.task) }
  return result
}

function taskForOutput(task: Task.Info) {
  if (!task.usage || task.usage.codiumSteps !== undefined || !(task.billing === "codium" || task.costKind === "codium"))
    return task
  const usage: { -readonly [K in keyof Task.Usage]?: Task.Usage[K] } = { ...task.usage }
  delete usage.tokens
  delete usage.total
  return { ...task, usage }
}

export function formatTasks(tasks: readonly Task.Info[]) {
  if (!tasks.length) return "No subagent tasks."
  return tasks
    .map((task) =>
      [
        `${task.id}  ${task.connection === "disconnected" ? `disconnected (last known: ${task.status})` : task.status}  ${task.title}`,
        "  " +
          [
            `${Math.round(task.elapsedMs / 1000)}s`,
            ...(CodiumUsage.taskText(task) ??
              (task.usage
                ? [
                    `${task.usage.total} tokens`,
                    task.usage.unpricedSteps
                      ? "cost partly unknown"
                      : task.costKind === "plan"
                        ? "covered by plan"
                        : task.costKind === "free"
                          ? "free model"
                          : `$${task.usage.cost.toFixed(4)}`,
                  ]
                : task.measuredCost !== undefined
                  ? [`$${task.measuredCost.toFixed(4)} reported`, "tokens unavailable"]
                  : task.costKind === "plan"
                    ? ["covered by plan", "tokens unavailable"]
                    : task.costKind === "free"
                      ? ["free model", "tokens unavailable"]
                      : ["usage unavailable"])),
            ...(task.currentStep ? [task.currentStep] : []),
          ].join(" · "),
        ...(task.dependsOn.length ? [`  Depends on: ${task.dependsOn.join(", ")}`] : []),
        ...(task.reason ? [`  ${task.reason}`] : []),
      ].join("\n"),
    )
    .join("\n")
}
