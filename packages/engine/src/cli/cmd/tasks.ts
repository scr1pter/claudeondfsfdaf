import { EOL } from "os"
import { Effect } from "effect"
import { CodiumUsage } from "@vectordevai/core/codium-usage"
import {
  createVectorClient,
  type TaskChangesResult,
  type TaskDiscardResult,
  type TaskInspectResult,
  type TaskListResult,
  type TaskMergeResult,
  type TaskMessageResult,
  type TaskSessionStopResult,
  type TaskWaitResult,
} from "@vectordevai/sdk/v2"
import type { Task } from "@vectordevai/schema/task"
import { ServerAuth } from "@/server/auth"
import { Flag } from "@vectordevai/core/flag/flag"
import { errorMessage } from "@vectordevai/tui/util/error"
import { sanitizeTerminalText } from "@vectordevai/tui/util/presentation"
import { CliOwnerGate } from "../owner-gate"
import { cmd } from "./cmd"
import { UI } from "../ui"

type Client = ReturnType<typeof createVectorClient>

export const TASK_ACTIONS = [
  "list",
  "inspect",
  "message",
  "stop",
  "wait",
  "interrupt",
  "resume",
  "promote",
  "changes",
  "merge",
  "discard",
  "workflow",
] as const

export const TasksCommand = cmd({
  command: "tasks <action> [taskID] [text]",
  describe:
    "list, inspect, message, stop, wait for, resume or move to the background a running server's subagents; review, merge or discard an isolated subagent's changes",
  builder: (yargs) =>
    yargs
      .positional("action", {
        type: "string",
        choices: TASK_ACTIONS,
        demandOption: true,
      })
      .positional("taskID", {
        type: "string",
        describe: "child task ID (a workflow run ID for workflow); use --task for several",
      })
      .positional("text", {
        type: "string",
        describe: "correction to send to the child; with resume, a message for the resumed children (or --text)",
      })
      .option("attach", {
        type: "string",
        demandOption: true,
        describe: "URL of the server that owns the running tasks",
      })
      .option("session", { type: "string", alias: "s", demandOption: true, describe: "parent session ID" })
      .option("dir", { type: "string", describe: "workspace directory on that server" })
      .option("task", { type: "string", array: true, describe: "task IDs for stop, wait, resume or promote" })
      .option("all", { type: "boolean", default: false, describe: "stop all children of this session" })
      .option("background", {
        type: "boolean",
        default: false,
        describe: "with stop: stop only the background subagents, never foreground work or desktop workspaces",
      })
      .option("descendants", { type: "boolean", default: false, describe: "include nested children in list" })
      .option("active", { type: "boolean", default: false, describe: "with list: only queued and running work" })
      .option("shells", { type: "boolean", default: false, describe: "with list: include background commands" })
      .option("helpers", {
        type: "boolean",
        default: false,
        describe:
          "with interrupt: also stop every subagent, workflow run and background command this conversation started",
      })
      .option("interrupted", {
        type: "boolean",
        default: false,
        describe: "with resume: resume every subagent a restart interrupted",
      })
      .option("diff", { type: "boolean", default: false, describe: "with changes: include the patch" })
      .option("file", {
        type: "string",
        array: true,
        describe: "with merge: merge only these repository-relative paths",
      })
      .option("yes", {
        type: "boolean",
        default: false,
        describe: "with merge or discard: do not ask for confirmation",
      })
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
      .option("reason", { type: "string", describe: "why this work should stop or be discarded" })
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
      UI.error(sanitizeTerminalText(errorMessage(error)))
      process.exitCode = 1
      return undefined
    })
    if (!result) return
    if (args.json) return console.log(JSON.stringify(tasksForOutput(result), null, 2))
    console.log(await formatTaskResult(args, result))
  },
})

type Arguments = {
  action: string
  session: string
  taskID?: string
  text?: string
  task?: string[]
  all?: boolean
  background?: boolean
  descendants?: boolean
  active?: boolean
  shells?: boolean
  helpers?: boolean
  interrupted?: boolean
  diff?: boolean
  file?: string[]
  yes?: boolean
  delivery?: string
  mode?: string
  timeout?: number
  reason?: string
}

type Options = {
  /** Asks the person at this terminal; false when nobody can answer. */
  confirm?: (question: string) => Promise<boolean>
}

// Options that only one action reads. Using them elsewhere is refused before any request, so a typo never runs a
// different operation than the one asked for.
const ONLY: ReadonlyArray<[keyof Arguments, string, readonly string[]]> = [
  ["background", "--background", ["stop"]],
  ["active", "--active", ["list"]],
  ["shells", "--shells", ["list"]],
  ["helpers", "--helpers", ["interrupt"]],
  ["interrupted", "--interrupted", ["resume"]],
  ["diff", "--diff", ["changes"]],
  ["file", "--file", ["merge"]],
  ["yes", "--yes", ["merge", "discard"]],
]

const ACTIVE: ReadonlySet<string> = new Set(["queued", "running", "waiting_on_user"])
const RESUME_CHUNK = 32
const STOP_CHUNK = 200

export async function executeTaskCommand(client: Client, args: Arguments, options: Options = {}) {
  const action = args.action
  if (!(TASK_ACTIONS as readonly string[]).includes(action)) throw new Error(`Unknown task action: ${action}`)
  // Owner-only actions refuse an agent before anything else, so its shell never reaches the server (I12).
  if (action === "merge") await assertTaskOwner("merge a subagent's changes")
  if (action === "discard") await assertTaskOwner("discard a subagent's changes")
  for (const [key, flag, actions] of ONLY) {
    const value = args[key]
    if ((value === true || (Array.isArray(value) && value.length > 0)) && !actions.includes(action))
      throw new Error(`${flag} is only used with ${actions.join(" or ")}`)
  }
  const tasks = client.experimental.task
  const sessionID = args.session
  const taskIDs = [...new Set([...(args.taskID ? [args.taskID] : []), ...(args.task ?? [])])]
  if (action === "list") {
    if (args.shells) await requireTaskCapability(client, "backgroundShells", "list background commands")
    const result = (
      await tasks.list({
        sessionID,
        descendants: args.descendants ? "true" : "false",
        ...(args.active ? { active: "true" as const } : {}),
        ...(args.shells ? { shells: "true" as const } : {}),
      })
    ).data!
    // An older engine ignores `active`, so the filter is applied here too.
    if (!args.active) return result
    return {
      ...result,
      tasks: result.tasks.filter((task) => ACTIVE.has(task.status)),
      ...(result.shells ? { shells: result.shells.filter((shell) => shell.status === "running") } : {}),
    }
  }
  if (action === "inspect") {
    if (!args.taskID) throw new Error("inspect requires a task ID")
    return (await tasks.inspect({ sessionID, taskID: args.taskID })).data!
  }
  if (action === "message") {
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
  if (action === "stop") {
    if (args.background) {
      if (args.all || taskIDs.length) throw new Error("Choose --background, --all or specific task IDs")
      return stopBackground(client, sessionID, args.reason)
    }
    if (args.all && taskIDs.length) throw new Error("Choose --all or specific task IDs")
    if (!args.all && !taskIDs.length) throw new Error("stop requires task IDs, --all or --background")
    return (await tasks.stop({ sessionID, ...(args.all ? { all: true } : { taskIDs }), reason: args.reason })).data!
  }
  if (action === "wait") {
    if (!taskIDs.length) throw new Error("wait requires at least one task ID")
    if (args.mode && args.mode !== "any" && args.mode !== "all") throw new Error("mode must be any or all")
    if (args.timeout !== undefined && (!Number.isInteger(args.timeout) || args.timeout < 0 || args.timeout > 60_000))
      throw new Error("timeout must be an integer from 0 to 60000 milliseconds")
    return (await tasks.wait({ sessionID, taskIDs, mode: args.mode === "all" ? "all" : "any", timeout: args.timeout }))
      .data!
  }
  if (action === "interrupt") {
    if (taskIDs.length || args.text !== undefined)
      throw new Error("interrupt takes no task IDs; it stops the session's main turn, and its helpers with --helpers")
    if (args.reason !== undefined && args.reason.length > 1000)
      throw new Error("Stop reasons are limited to 1000 characters")
    await requireTaskCapability(client, "sessionStop", args.helpers ? "stop including helpers" : "stop the main turn")
    return (await client.experimental.session.stop({ sessionID, helpers: args.helpers === true, reason: args.reason }))
      .data!
  }
  if (action === "resume") {
    if (args.interrupted && taskIDs.length) throw new Error("Choose --interrupted or specific task IDs")
    if (!args.interrupted && !taskIDs.length)
      throw new Error("resume requires task IDs (--task for several) or --interrupted")
    if (args.text !== undefined && (!args.text.trim() || args.text.length > 4096))
      throw new Error("A resume message must be 1 to 4096 characters")
    await requireTaskCapability(client, "taskResume", "resume subagents")
    const ids = args.interrupted ? interruptedTaskIDs((await tasks.list({ sessionID })).data!.tasks) : taskIDs
    return resumeTasks(client, sessionID, ids, args.text)
  }
  if (action === "promote") {
    if (args.text !== undefined) throw new Error("promote takes task IDs only (--task for several)")
    if (taskIDs.length > STOP_CHUNK) throw new Error(`Choose at most ${STOP_CHUNK} task IDs`)
    await requireTaskCapability(client, "taskPromote", "move subagents to the background")
    return (await tasks.background({ sessionID, ...(taskIDs.length ? { taskIDs } : {}) })).data!
  }
  if (action === "workflow") {
    const capability = await readCapabilities(client, "list workflow runs")
    // A false flag means workflows are turned off for new runs; listing and showing existing runs stays open.
    if (typeof capability.workflows !== "boolean") throw new Error(outdated("list workflow runs"))
    const workflows = client.experimental.workflow
    if (args.taskID) return (await workflows.get({ sessionID, runID: args.taskID })).data!
    return (await workflows.list({ sessionID })).data!
  }
  const taskID = args.taskID
  if (!taskID || taskIDs.length > 1) throw new Error(`${action} requires exactly one task ID`)
  if (action === "changes") {
    await requireTaskCapability(client, "taskIsolation", "review a subagent's changes")
    return (await tasks.changes({ sessionID, taskID, ...(args.diff ? { diff: "true" as const } : {}) })).data!
  }
  const confirm = options.confirm ?? confirmAtTerminal
  if (action === "merge") {
    const files = args.file?.length ? [...new Set(args.file)] : undefined
    if (files && (files.length > 500 || files.some((file) => !file.trim())))
      throw new Error("--file takes 1 to 500 non-empty repository-relative paths")
    await requireTaskCapability(client, "taskIsolation", "merge a subagent's changes")
    const what = files ? `${count(files.length, "selected file")} from` : "the changes of"
    if (!args.yes && !(await confirm(`Merge ${what} ${sanitizeTerminalText(taskID)} into this checkout?`)))
      throw new Error("Nothing was merged. Confirm at a terminal, or pass --yes.")
    return (await tasks.merge({ sessionID, taskID, ...(files ? { files } : {}) })).data!
  }
  if (args.reason !== undefined && args.reason.length > 1000)
    throw new Error("Discard reasons are limited to 1000 characters")
  await requireTaskCapability(client, "taskIsolation", "discard a subagent's changes")
  if (!args.yes && !(await confirm(`Discard the changes of ${sanitizeTerminalText(taskID)}? A recovery copy is kept.`)))
    throw new Error("Nothing was discarded. Confirm at a terminal, or pass --yes.")
  return (await tasks.discard({ sessionID, taskID, reason: args.reason })).data!
}

// `stop --background` (5.I.6): only the session's background subagents. A native task without `background` comes
// from an engine that cannot tell its foreground work apart, so nothing is stopped there.
async function stopBackground(client: Client, sessionID: string, reason?: string) {
  const listed = (await client.experimental.task.list({ sessionID, active: "true" })).data!
  const native = listed.tasks.filter((task) => task.source === "subagent" && ACTIVE.has(task.status))
  if (native.some((task) => task.background === undefined))
    throw new Error(outdated("stop only its background subagents"))
  const ids = native.filter((task) => task.background === true && task.controls.stop).map((task) => task.id)
  const stopped: (typeof listed.tasks)[number][] = []
  for (const chunk of chunks(ids, STOP_CHUNK))
    stopped.push(...(await client.experimental.task.stop({ sessionID, taskIDs: chunk, reason })).data!.tasks)
  return { tasks: stopped }
}

/** Resumes the IDs in calls the route accepts (at most 32 each). Each call is all or nothing on the engine. */
export async function resumeTasks(client: Client, sessionID: string, ids: readonly string[], text?: string) {
  const resumed: Task.Info[] = []
  for (const chunk of chunks(ids, RESUME_CHUNK)) {
    const result = await client.experimental.task
      .resume({ sessionID, taskIDs: [...chunk], ...(text !== undefined ? { text } : {}) }, { throwOnError: true })
      .catch((error: unknown) => {
        if (!resumed.length) throw error
        throw new Error(`Resumed ${count(resumed.length, "subagent")}, then: ${errorMessage(error)}`)
      })
    resumed.push(...result.data!.tasks)
  }
  return { tasks: resumed }
}

/** The subagents a restart interrupted that can be resumed now: not resumed, not dismissed, resumable. */
export function interruptedTaskIDs(
  tasks: readonly Pick<Task.Info, "id" | "source" | "interrupted" | "controls">[],
): string[] {
  return tasks
    .filter(
      (task) =>
        task.source === "subagent" &&
        task.interrupted !== undefined &&
        task.interrupted.resumedAt === undefined &&
        task.interrupted.dismissedAt === undefined &&
        task.controls.resume === true,
    )
    .map((task) => task.id)
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

export async function assertTaskOwner(action: string) {
  await Effect.runPromise(CliOwnerGate.refuse(action))
}

type TerminalIO = {
  input: NodeJS.ReadableStream & { isTTY?: boolean }
  output: NodeJS.WritableStream & { isTTY?: boolean }
}

/**
 * Asks "(y/N)" at a terminal. Ctrl+C or a closed input is a no, so the action is refused with its message and exit 1
 * instead of the process ending with code 0 on a question nobody answered.
 */
export async function confirmAtTerminal(
  question: string,
  io: TerminalIO = { input: process.stdin, output: process.stderr },
) {
  if (!io.input.isTTY || !io.output.isTTY) return false
  const readline = await import("node:readline")
  const rl = readline.createInterface({ input: io.input, output: io.output, terminal: true })
  const answer = await new Promise<string | undefined>((resolve) => {
    rl.once("close", () => resolve(undefined))
    rl.once("SIGINT", () => {
      io.output.write(EOL)
      resolve(undefined)
    })
    rl.question(`${question} (y/N) `, resolve)
  })
  rl.close()
  return answer !== undefined && /^y(es)?$/i.test(answer.trim())
}

/** What an action prints when the attached engine is older than the feature it needs (5.I.6). */
export function outdated(action: string) {
  return `This server's engine predates 1.99.113 and cannot ${action}; update it.`
}

const HTML_ANSWER = "Request is not supported by this version of Vector Server (Server responded with text/html)"

/**
 * The attached engine's capability flags. A missing route, an HTML page or an answer that is not a JSON object means
 * an engine older than the flags (I30), and fails with the update message for `action`. Authorization and
 * connection failures keep their own message.
 */
export async function readCapabilities(client: Client, action: string, signal?: AbortSignal) {
  const capability = await client.experimental.capabilities
    .get(undefined, { throwOnError: false, signal: signal ?? AbortSignal.timeout(30_000) })
    .catch((error: unknown) => {
      if (error instanceof Error && error.message === HTML_ANSWER) throw new Error(outdated(action))
      throw error
    })
  if (!capability.response)
    throw capability.error instanceof Error ? capability.error : new Error("Cannot connect to the server")
  if (capability.response.status === 404) throw new Error(outdated(action))
  if (!capability.response.ok)
    throw new Error(`Cannot read the server's capabilities (HTTP ${capability.response.status})`)
  const data: unknown = capability.data
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(outdated(action))
  return data as Record<string, unknown>
}

export type TaskCapability = "sessionStop" | "taskPromote" | "taskResume" | "taskIsolation" | "backgroundShells"

/** Checked before every new action, so an older engine never reads a new request as something else. */
export async function requireTaskCapability(client: Client, flag: TaskCapability, action: string) {
  const capability = await readCapabilities(client, action)
  if (capability[flag] === true) return
  if (capability[flag] === false) throw new Error(`This server's engine has turned off what it needs to ${action}.`)
  throw new Error(outdated(action))
}

/** Old servers cannot partition task tokens; redact only the printed projection, preserving the API result. */
export function tasksForOutput<
  T extends
    | { tasks: readonly Task.Info[] }
    | { runs: readonly Task.Info[] }
    | { task: Task.Info }
    | { messageID: string },
>(result: T) {
  if ("tasks" in result) return { ...result, tasks: result.tasks.map(taskForOutput) }
  if ("runs" in result) return { ...result, runs: result.runs.map(taskForOutput) }
  if ("task" in result) return { ...result, task: taskForOutput(result.task) }
  return result
}

function taskForOutput(task: Task.Info) {
  const usage: { -readonly [K in keyof Task.Usage]?: Task.Usage[K] } | undefined = task.usage
    ? { ...task.usage }
    : undefined
  if (usage && usage.tokensOwnOnly !== true) {
    delete usage.tokens
    delete usage.total
  }
  return {
    ...task,
    ...(usage ? { usage } : {}),
    ...(task.workflow?.role === "run"
      ? {
          workflow: {
            ...task.workflow,
            tokens:
              task.usage?.tokensOwnOnly === true && !((task.usage.codiumSteps ?? 0) > 0 && task.usage.total === 0)
                ? { used: task.usage.total, max: task.workflow.tokens?.max }
                : undefined,
          },
        }
      : {}),
  }
}

const safe = sanitizeTerminalText

/** Text a model or child wrote, line by line, with tabs kept as spaces (I13). */
function safeBlock(text: string) {
  return text
    .split("\n")
    .map((line) => safe(line.replaceAll("\t", "  ")))
    .join("\n")
}

function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function usd(value: number) {
  return `$${value.toFixed(2)}`
}

/** "5 of 8 running · 2 waiting · 12 of 32 started this request · $3.10 of $25.00 subagent spend" (5.B.10, I9). */
export function formatLimits(limits: Task.Limits) {
  const spend = limits.spend
  const amount = !spend
    ? undefined
    : spend.unknownSteps > 0
      ? spend.spentUsd > 0
        ? `${usd(spend.spentUsd)} + unknown`
        : "unknown"
      : usd(spend.spentUsd)
  return [
    `${limits.running} of ${limits.maxRunning} running`,
    ...(limits.queued > 0 ? [`${limits.queued} waiting`] : []),
    `${limits.launched} of ${limits.maxPerRequest} started this request`,
    ...(spend
      ? [
          `${amount}${spend.limitUsd !== undefined ? ` of ${usd(spend.limitUsd)}` : ""} subagent spend${spend.stopped ? " (ceiling reached)" : ""}`,
        ]
      : []),
  ].join(" · ")
}

export function formatTasks(tasks: readonly Task.Info[], options: { limits?: Task.Limits; now?: number } = {}) {
  const now = options.now ?? Date.now()
  const head = options.limits ? [formatLimits(options.limits)] : []
  if (!tasks.length) return [...head, "No subagent tasks."].join("\n")
  return [...head, ...tasks.map((task) => taskLines(task, now).join("\n"))].join("\n")
}

function taskLines(task: Task.Info, now: number) {
  return [
    `${safe(task.id)}  ${task.connection === "disconnected" ? `disconnected (last known: ${safe(task.status)})` : safe(task.status)}  ${safe(task.title)}`,
    "  " +
      [
        `${Math.round(task.elapsedMs / 1000)}s`,
        ...usageText(task),
        ...(task.currentStep ? [safe(task.currentStep)] : []),
      ].join(" · "),
    ...modelLine(task),
    ...(task.status === "queued" && task.queuedReason ? [`  ${safe(task.queuedReason)}`] : []),
    ...isolationLines(task),
    ...interruptedLine(task),
    ...waitingLine(task, now),
    ...resultLine(task),
    ...(task.dependsOn.length ? [`  Depends on: ${task.dependsOn.map(safe).join(", ")}`] : []),
    ...(task.reason ? [`  ${safe(task.reason)}`] : []),
  ]
}

function usageText(task: Task.Info) {
  return (
    CodiumUsage.taskText(task) ??
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
            : ["usage unavailable"])
  )
}

// "openai/gpt-5 · high effort · fork"
function modelLine(task: Task.Info) {
  const parts = [
    ...(task.model
      ? [`${task.model.providerID}/${task.model.modelID}${task.model.variant ? ` (${task.model.variant})` : ""}`]
      : []),
    ...(task.effort ? [`${task.effort} effort`] : []),
    ...(task.fork ? ["fork"] : []),
  ]
  return parts.length ? [`  ${parts.map(safe).join(" · ")}`] : []
}

// "Worktree: vector/task-ses_1 · changed · 3 files changed (+12 -4)", then any conflicts.
function isolationLines(task: Task.Info) {
  const isolation = task.isolation
  if (!isolation) return []
  const kind = isolation.mode === "copy" ? "Copy" : "Worktree"
  const changed =
    isolation.files === undefined
      ? []
      : [
          `${count(isolation.files, "file")} changed${isolation.additions !== undefined || isolation.deletions !== undefined ? ` (+${isolation.additions ?? 0} -${isolation.deletions ?? 0})` : ""}`,
        ]
  return [
    `  ${kind}: ${[...(isolation.branch ? [safe(isolation.branch)] : []), safe(isolation.state), ...changed].join(" · ")}`,
    ...(isolation.conflicts?.length ? [`  Conflicts: ${isolation.conflicts.map(safe).join(", ")}`] : []),
    ...(isolation.error ? [`  ${kind} error: ${safe(isolation.error)}`] : []),
  ]
}

function interruptedLine(task: Task.Info) {
  const interrupted = task.interrupted
  if (!interrupted || interrupted.resumedAt !== undefined || interrupted.dismissedAt !== undefined) return []
  return [`  Interrupted when Vector stopped (${safe(interrupted.cause)}); nothing resumes on its own`]
}

// "Needs your permission · 3m"
function waitingLine(task: Task.Info, now: number) {
  const waiting = task.waiting
  if (!waiting) return []
  const minutes = Math.floor(Math.max(0, now - waiting.since) / 60_000)
  return [
    `  ${waiting.kind === "question" ? "Needs your answer" : "Needs your permission"} · ${minutes < 1 ? "<1m" : `${minutes}m`}${waiting.summary ? `: ${safe(waiting.summary)}` : ""}`,
  ]
}

function resultLine(task: Task.Info) {
  const result = task.result
  if (!result || result.format !== "json") return []
  const state =
    result.valid === true ? "valid" : result.valid === false ? "did not match its schema" : "not checked yet"
  return [
    `  Result: JSON, ${state}${result.attempts && result.attempts > 1 ? ` after ${result.attempts} attempts` : ""}`,
  ]
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function formatShells(shells: readonly Task.Shell[], now = Date.now()) {
  if (!shells.length) return "No background commands."
  return shells
    .map((shell) =>
      [
        `${safe(shell.id)}  ${safe(shell.status)}  ${safe(shell.command)}`,
        "  " +
          [
            `${Math.round(Math.max(0, (shell.completedAt ?? now) - shell.startedAt) / 1000)}s`,
            `${bytes(shell.outputBytes)} of output`,
            ...(shell.exitCode !== undefined ? [`exit ${shell.exitCode}`] : []),
          ].join(" · "),
        ...(shell.outputPath ? [`  Output: ${safe(shell.outputPath)}`] : []),
      ].join("\n"),
    )
    .join("\n")
}

/** The printed form of an action's result. Every string a model or child wrote passes `sanitizeTerminalText`. */
export async function formatTaskResult(
  args: Pick<Arguments, "action" | "helpers" | "interrupted" | "background" | "shells">,
  // The action's own result shape, which the switch below picks; the printed form never mutates it.
  result: object,
  now = Date.now(),
): Promise<string> {
  switch (args.action) {
    case "workflow": {
      const { formatWorkflowResult } = await import("./workflow")
      return formatWorkflowResult(result as Parameters<typeof formatWorkflowResult>[0])
    }
    case "interrupt":
      return formatInterrupt(result as TaskSessionStopResult, args.helpers === true, now)
    case "changes":
      return formatChanges(result as TaskChangesResult, now)
    case "merge":
      return formatMerge(result as TaskMergeResult)
    case "discard": {
      const discarded = result as TaskDiscardResult
      return [
        `Discarded the changes of ${safe(discarded.task.id)}.`,
        ...(discarded.saved ? [`A recovery copy is at ${safe(discarded.saved)}.`] : []),
      ].join("\n")
    }
    case "message": {
      const message = result as TaskMessageResult
      return `Message ${safe(message.messageID)} accepted for ${safe(message.taskID)} (${message.delivery}).`
    }
    case "inspect":
      return formatInspect(result as TaskInspectResult, now)
  }
  const listed = result as Partial<TaskListResult & TaskWaitResult> & { tasks: TaskListResult["tasks"] }
  const empty =
    args.action === "resume"
      ? args.interrupted
        ? "No interrupted subagents to resume."
        : "Nothing was resumed."
      : args.action === "promote"
        ? "No foreground subagents to move."
        : args.action === "stop" && args.background
          ? "No background subagents are running."
          : undefined
  if (!listed.tasks.length && empty) return empty
  const head =
    args.action === "resume"
      ? [`Resumed ${count(listed.tasks.length, "subagent")}.`]
      : args.action === "promote"
        ? [`Moved ${count(listed.tasks.length, "subagent")} to the background.`]
        : args.action === "stop" && args.background
          ? [`Stopped ${count(listed.tasks.length, "background subagent")}.`]
          : []
  return [
    ...head,
    formatTasks(listed.tasks, { limits: listed.limits, now }),
    ...(listed.shells && (listed.shells.length || args.shells) ? [formatShells(listed.shells, now)] : []),
    ...(listed.attention?.length ? [`Needs your attention: ${listed.attention.map(safe).join(", ")}`] : []),
    ...(listed.truncated ? ["More tasks are available; narrow the selection."] : []),
    ...(listed.timedOut ? ["Wait timed out; completion is not confirmed."] : []),
  ].join("\n")
}

function formatInterrupt(result: TaskSessionStopResult, helpers: boolean, now: number) {
  const lines = [result.aborted ? "Stopped the main turn." : "The main turn was not running."]
  if (!helpers) return [...lines, "Helpers keep running; vector tasks interrupt --helpers stops them too."].join("\n")
  return [
    ...lines,
    result.tasks.length ? `Stopped ${count(result.tasks.length, "helper")}.` : "No helpers were running.",
    ...(result.shells ? [`Stopped ${count(result.shells, "background command")}.`] : []),
    ...(result.excluded
      ? [`${count(result.excluded, "agent workspace")} keep running; stop them from the Agent Dashboard.`]
      : []),
    ...(result.skipped ? [`${count(result.skipped, "desktop task")} could not be reached.`] : []),
    ...(result.tasks.length ? [formatTasks(result.tasks, { now })] : []),
  ].join("\n")
}

function formatChanges(result: TaskChangesResult, now: number) {
  const status: Record<string, string> = { added: "A", modified: "M", deleted: "D" }
  return [
    formatTasks([result.task], { now }),
    `Mergeable: ${safe(result.mergeable)}${result.detail ? ` · ${safe(result.detail)}` : ""}`,
    ...(result.files.length
      ? result.files.map(
          (file) =>
            `  ${status[file.status] ?? "?"} ${safe(file.path)}${file.binary ? " (binary)" : ` +${file.additions} -${file.deletions}`}`,
        )
      : ["  No files changed."]),
    ...(result.patch !== undefined ? [safeBlock(result.patch)] : []),
    ...(result.truncated ? ["The file list or patch is bounded; review the rest in the worktree."] : []),
  ].join("\n")
}

function formatMerge(result: TaskMergeResult) {
  return [
    `Merged ${count(result.merged.length, "file")} from ${safe(result.task.id)}.`,
    ...result.merged.map((file) => `  ${safe(file)}`),
    ...(result.conflicts.length
      ? [
          `Conflicts in ${count(result.conflicts.length, "file")}:`,
          ...result.conflicts.map((file) => `  ${safe(file)}`),
        ]
      : []),
    ...(result.remaining.length ? ["Not merged yet:", ...result.remaining.map((file) => `  ${safe(file)}`)] : []),
    ...(result.checkpoint ? [`Checkpoint before the merge: ${safe(result.checkpoint)}`] : []),
  ].join("\n")
}

function formatInspect(result: TaskInspectResult, now: number) {
  return [
    formatTasks([result.task], { now }),
    ...result.steps.map((step) => `${safe(step.tool ?? "step")}: ${safe(step.text)}`),
    ...(result.messages?.length
      ? ["Messages:", ...result.messages.map((message) => `  ${safe(message.sender)}: ${safe(message.text)}`)]
      : []),
    ...(result.structured
      ? [
          `Structured result (${result.structured.valid ? "valid" : "did not match its schema"}${result.structured.truncated ? ", bounded" : ""}):`,
          safeBlock(result.structured.json),
        ]
      : []),
    ...(result.output ? [safeBlock(result.output)] : []),
    ...(result.truncated
      ? [
          `Output is bounded. Result reference: ${safe(result.task.resultRef ?? result.task.sessionID ?? result.task.id)}`,
        ]
      : []),
  ].join("\n")
}
