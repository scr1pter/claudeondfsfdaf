import { constants } from "node:fs"
import fs from "node:fs/promises"
import { Effect, Option, Schema } from "effect"
import { createVectorClient } from "@vectordevai/sdk/v2"
import { WorkflowSpec } from "@vectordevai/core/orchestration/spec"
import { WorkflowPlan } from "@vectordevai/core/orchestration/plan"
import { Flag } from "@vectordevai/core/flag/flag"
import type { Workflow } from "@vectordevai/schema/workflow"
import { sanitizeTerminalText } from "@vectordevai/tui/util/presentation"
import { errorMessage } from "@vectordevai/tui/util/error"
import { ServerAuth } from "@/server/auth"
import { CliOwnerGate } from "../owner-gate"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { formatTasks, tasksForOutput } from "./tasks"

export const WorkflowCommand = cmd({
  command: "workflow <action> [target]",
  describe: "validate workflows or manage runs (separate from memory workflow insights)",
  builder: (yargs) =>
    yargs
      .positional("action", {
        type: "string",
        choices: ["saved", "validate", "list", "show", "resume", "stop"],
        demandOption: true,
      })
      .positional("target", {
        type: "string",
        describe: "workflow name/file for validate; run ID for show, resume or stop",
      })
      .option("attach", { type: "string", describe: "owning server URL; omit for offline file validation" })
      .option("session", { type: "string", alias: "s", describe: "parent session ID for list, show, resume or stop" })
      .option("dir", { type: "string", describe: "workspace directory on the attached server" })
      .option("file", { type: "string", describe: "replacement workflow JSON file for resume" })
      .option("input", {
        type: "string",
        array: true,
        describe: "input key=value; JSON values are parsed, other values stay strings",
      })
      .option("retry-failed", { type: "boolean", default: true, describe: "retry failed nodes when resuming" })
      .option("reason", { type: "string", describe: "why this run should stop" })
      .option("json", { type: "boolean", default: false, describe: "print the structured response" })
      .option("username", { type: "string", describe: "server username (or VECTOR_SERVER_USERNAME)" })
      .option("password", { type: "string", describe: "server password (prefer VECTOR_SERVER_PASSWORD)" }),
  handler: async (args) => {
    const result = await (async () => {
      if (args.action === "resume") await assertWorkflowOwner("resume workflows")
      if (!args.attach) return executeWorkflowCommand(undefined, args)
      ServerAuth.assertSecurePasswordTransport(args.attach, args.password ?? Flag.VECTOR_SERVER_PASSWORD)
      return executeWorkflowCommand(
        createVectorClient({
          baseUrl: args.attach,
          directory: args.dir,
          headers: ServerAuth.headers({ username: args.username, password: args.password }),
          throwOnError: true,
        }),
        args,
      )
    })().catch((error: unknown) => {
      UI.error(sanitizeTerminalText(errorMessage(error)))
      process.exitCode = 1
      return undefined
    })
    if (!result) return
    if ("ok" in result && !result.ok) process.exitCode = 1
    console.log(args.json ? JSON.stringify(workflowForOutput(result), null, 2) : formatWorkflowResult(result))
  },
})

/** Workflow task views use the same public usage projection as ordinary task commands. */
export function workflowForOutput(result: Awaited<ReturnType<typeof executeWorkflowCommand>>) {
  return "runs" in result || "tasks" in result || "task" in result ? tasksForOutput(result) : result
}

type Arguments = {
  action: string
  target?: string
  session?: string
  input?: readonly string[]
  file?: string
  retryFailed?: boolean
  reason?: string
}

export async function executeWorkflowCommand(
  client: ReturnType<typeof createVectorClient> | undefined,
  args: Arguments,
) {
  if (args.action === "resume") await assertWorkflowOwner("resume workflows")
  if (!["saved", "validate", "list", "show", "resume", "stop"].includes(args.action))
    throw new Error(`Unknown workflow action: ${args.action}`)
  if (args.file && args.action !== "resume") throw new Error("--file is only used when resuming a workflow")
  if (args.input?.length && args.action !== "validate" && args.action !== "resume")
    throw new Error("--input is only used with validate or resume")
  const inputs = parseWorkflowInputs(args.input)
  const source =
    args.action === "validate"
      ? await readWorkflowSource(required(args.target, "validate requires a workflow name or JSON file"))
      : args.action === "resume" && args.file
        ? await readWorkflowSource(args.file, true)
        : undefined
  if (args.action === "validate" && !client) {
    if (!source || !("spec" in source))
      throw new Error("Saved workflow validation requires --attach; use a JSON file for offline validation")
    return validateWorkflowOffline(source.spec, inputs)
  }
  if (!client) throw new Error(`${args.action} requires --attach with the owning server URL`)
  const sessionID = ["list", "show", "resume", "stop"].includes(args.action)
    ? required(args.session, `${args.action} requires --session`)
    : undefined
  const runID = ["show", "resume", "stop"].includes(args.action)
    ? required(args.target, `${args.action} requires a workflow run ID`)
    : undefined
  await requireWorkflowCapability(client, args.action)
  const workflows = client.experimental.workflow
  if (args.action === "saved") return (await workflows.saved()).data!
  if (args.action === "validate")
    return (await workflows.validate({ workflowValidateInput: { ...source, inputs } })).data!
  if (args.action === "list") return (await workflows.list({ sessionID: sessionID! })).data!
  if (args.action === "show") return (await workflows.get({ sessionID: sessionID!, runID: runID! })).data!
  if (args.action === "resume")
    return (
      await workflows.resume({
        sessionID: sessionID!,
        runID: runID!,
        workflowResumeInput: {
          ...source,
          inputs: args.input ? inputs : undefined,
          retryFailed: args.retryFailed ?? true,
        },
      })
    ).data!
  return (await client.experimental.task.stop({ sessionID: sessionID!, taskIDs: [runID!], reason: args.reason })).data!
}

export async function requireWorkflowCapability(
  client: ReturnType<typeof createVectorClient>,
  action: string,
  signal?: AbortSignal,
) {
  // Check before mutation: an older engine must never interpret a new operation differently.
  const outdated = `This server's engine predates 1.99.113 and cannot ${action} workflows; update it.`
  const capability = await client.experimental.capabilities
    .get(undefined, { throwOnError: false, signal: signal ?? AbortSignal.timeout(30_000) })
    .catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.message === "Request is not supported by this version of Vector Server (Server responded with text/html)"
      )
        throw new Error(outdated)
      throw error
    })
  if (!capability.response)
    throw capability.error instanceof Error ? capability.error : new Error("Cannot connect to the workflow server")
  if (!capability.response.ok && capability.response.status !== 404)
    throw new Error(`Cannot read workflow capabilities (HTTP ${capability.response.status})`)
  if (
    !capability.data ||
    typeof capability.data !== "object" ||
    !("workflows" in capability.data) ||
    typeof capability.data.workflows !== "boolean"
  )
    throw new Error(outdated)
  if (!capability.data.workflows && ["saved", "validate", "start", "resume"].includes(action))
    throw new Error("Workflows are disabled by the attached engine's configuration or permissions")
}

export async function assertWorkflowOwner(action: string) {
  await Effect.runPromise(CliOwnerGate.refuse(action))
}

export function parseWorkflowInputs(values: readonly string[] = []): Record<string, Schema.Json> {
  if (values.length > 16) throw new Error("Workflows accept at most 16 inputs")
  const inputs: Record<string, Schema.Json> = Object.create(null)
  for (const value of values) {
    const separator = value.indexOf("=")
    if (separator < 1) throw new Error("Workflow inputs must use key=value")
    const name = value.slice(0, separator)
    if (!/^(?!(?:constructor|prototype)$)[a-z][a-z0-9_]{0,31}$/.test(name))
      throw new Error(`Invalid workflow input name: ${name}`)
    if (Object.hasOwn(inputs, name)) throw new Error(`Duplicate workflow input: ${name}`)
    const raw = value.slice(separator + 1)
    if (Buffer.byteLength(raw) > 8192) throw new Error(`Workflow input ${name} exceeds 8 KiB`)
    const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(raw)
    const input = Option.isSome(parsed) ? parsed.value : raw
    if (!Schema.is(Schema.Json)(input) || Buffer.byteLength(JSON.stringify(input)) > 8192)
      throw new Error(`Workflow input ${name} must be a JSON value of at most 8 KiB`)
    inputs[name] = input
  }
  return inputs
}

/** A bare saved name is resolved only by the attached engine's trusted library. */
export async function readWorkflowSource(target: string, file = false): Promise<{ spec: string } | { name: string }> {
  if (!file && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(target)) return { name: target }
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) throw new Error("A workflow must be a regular JSON file")
    const buffer = Buffer.alloc(WorkflowSpec.BYTES.owner + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (!read.bytesRead) break
      bytes += read.bytesRead
    }
    if (bytes > WorkflowSpec.BYTES.owner) throw new Error("A workflow file must be at most 256 KiB")
    return { spec: buffer.subarray(0, bytes).toString("utf8") }
  } finally {
    await handle.close()
  }
}

export function validateWorkflowOffline(
  spec: string,
  inputs: Readonly<Record<string, Schema.Json>> = {},
): Workflow.Validation {
  const parsed = WorkflowSpec.parse(spec)
  if (!parsed.ok) return { ok: false, issues: parsed.issues, warnings: [] }
  // Reuse the real graph/template/input validator. These descriptors only defer
  // engine policy checks; no execution plan or permission claim leaves this path.
  const agents = [
    ...new Set(
      parsed.spec.stages.flatMap((stage) =>
        "prompt" in stage
          ? [
              stage.agent ?? parsed.spec.defaults?.agent ?? "general",
              stage.verify?.agent ?? stage.agent ?? parsed.spec.defaults?.agent ?? "general",
            ]
          : [],
      ),
    ),
  ]
  const built = WorkflowPlan.build(parsed.spec, {
    inputs,
    source: "owner",
    agents: agents.map((name) => ({ name, allowed: true, writes: false })),
    modelAllowed: () => true,
    limits: { max_agents: 1000 },
  })
  return {
    ok: built.ok,
    issues: built.issues.map((issue) =>
      issue.message.startsWith("Saved workflow is unavailable:")
        ? { ...issue, message: `${issue.message} Use --attach to resolve trusted saved workflows.` }
        : issue,
    ),
    warnings: [
      ...built.warnings,
      {
        path: "",
        message:
          "Offline checks cover syntax, inputs and dependencies. Agent, model, permission and configured limit checks require the attached engine's preview/start.",
      },
    ],
  }
}

export function formatWorkflowPlan(plan: Workflow.Plan) {
  return [
    sanitizeTerminalText(plan.title),
    `Limits: ${plan.maxAgents} agents · ${plan.concurrency} concurrent · ${plan.steps} steps · ${plan.perAgentSteps} steps/agent · ${plan.minutes} minutes${plan.usd === undefined ? "" : ` · $${plan.usd}`}${plan.tokens === undefined ? "" : ` · ${plan.tokens} tokens`}`,
    ...plan.stages.map(
      (stage) =>
        `  ${sanitizeTerminalText(stage.id)}: ${sanitizeTerminalText(stage.title)} · ${sanitizeTerminalText(stage.agent)}${stage.model ? ` · ${sanitizeTerminalText(stage.model)}` : ""}${stage.effort ? ` · ${sanitizeTerminalText(stage.effort)}` : ""} · ${stage.items} items · ${sanitizeTerminalText(stage.writes)}${stage.asks.length ? ` · asks: ${stage.asks.map(sanitizeTerminalText).join(", ")}` : ""}`,
    ),
  ].join("\n")
}

export function formatWorkflowResult(result: Awaited<ReturnType<typeof executeWorkflowCommand>>) {
  if ("ok" in result)
    return [
      result.ok ? "Workflow validation passed." : "Workflow validation failed.",
      ...result.issues.map(
        (issue) => `Error ${sanitizeTerminalText(issue.path)}: ${sanitizeTerminalText(issue.message)}`,
      ),
      ...result.warnings.map(
        (issue) => `Warning ${sanitizeTerminalText(issue.path)}: ${sanitizeTerminalText(issue.message)}`,
      ),
      ...(result.plan ? [formatWorkflowPlan(result.plan)] : []),
    ].join("\n")
  if ("workflows" in result)
    return result.workflows.length
      ? result.workflows
          .map((item) =>
            [
              `${sanitizeTerminalText(item.name)} · ${sanitizeTerminalText(item.title)} · ${sanitizeTerminalText(item.source)}`,
              ...(item.issues ?? []).map(
                (issue) => `  ${sanitizeTerminalText(issue.path)}: ${sanitizeTerminalText(issue.message)}`,
              ),
            ].join("\n"),
          )
          .join("\n")
      : "No saved workflows."
  if ("runID" in result) return `Resumed ${sanitizeTerminalText(result.runID)}\n${formatWorkflowPlan(result.plan)}`
  if ("runs" in result) return result.runs.length ? safeLines(formatTasks(result.runs)) : "No workflow runs."
  if ("tasks" in result) return safeLines(formatTasks(result.tasks))
  return [
    safeLines(formatTasks([result.task])),
    ...result.nodes.map(
      (node) =>
        `  ${sanitizeTerminalText(node.stage)} · ${sanitizeTerminalText(node.status)} · ${sanitizeTerminalText(node.item)}${node.error ? ` · ${sanitizeTerminalText(node.error)}` : ""}`,
    ),
    ...(result.report ? [safeLines(result.report)] : []),
    ...(result.truncated ? ["Run details are bounded; inspect the child sessions for further output."] : []),
  ].join("\n")
}

function safeLines(text: string) {
  return text.split("\n").map(sanitizeTerminalText).join("\n")
}

function required(value: string | undefined, message: string) {
  if (!value?.trim()) throw new Error(message)
  return value
}
