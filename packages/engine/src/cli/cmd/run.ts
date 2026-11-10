import { Billing } from "@vectordevai/schema/billing"
import { stepForOutput, toolForOutput } from "./run/usage-output"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import { FSUtil } from "@vectordevai/core/fs-util"
import { backgroundTracker, nextBackgroundEvent, trackShell, waitingFor } from "./run/background-wait"
import { runSessionAncestry } from "./run/ancestry"
import { runWorkflow } from "./run/workflow"
import { INTERRUPT_EXIT_CODE, handlesInterrupt, watchInterrupts } from "./run/interrupt"
import { assertWorkflowOwner, parseWorkflowInputs, readWorkflowSource, requireWorkflowCapability } from "./workflow"
// CLI entry point for `vector run` and `vector --mini`.
//
// Handles three modes:
//   1. Non-interactive (default): sends a single prompt, streams events to
//      stdout, and exits when the session goes idle.
//   2. Interactive local (`vector --mini`): boots the split-footer direct mode
//      with an in-process server (no external HTTP).
//   3. Interactive attach (`vector --mini --attach`): connects to a running
//      vector server and runs interactive mode against it.
//
// Also supports `--command` for slash-command execution, `--format json` for
// raw event streaming, `--continue` / `--session` for session resumption,
// and `--fork` for forking before continuing.
import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { open } from "node:fs/promises"
import { Effect, Option, Schema } from "effect"
import { PublicSession } from "@vectordevai/schema/public-session"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import { isRecord } from "@/util/record"
import type { TaskSize } from "@vectordevai/schema/task-size"
import {
  createVectorClient,
  type Event,
  type Message,
  type RunBudget,
  type VectorClient,
  type ToolPart,
} from "@vectordevai/sdk/v2"
import { FormatError, FormatUnknownError } from "../error"
import { INTERACTIVE_INPUT_ERROR, resolveInteractiveStdin } from "./run/runtime.stdin"
import { MODEL_SETUP_GUIDANCE } from "@/provider/setup"
import { FREE_MODELS_SIGN_IN_TERMINAL } from "@vectordevai/core/free-model-choice"
import { freeModelRunNotice } from "./run/free-model-notice"

type ModelInput = Parameters<VectorClient["session"]["prompt"]>[0]["model"]

export function validateWorkflowRunOptions(args: Record<string, unknown>, message = "") {
  if (!args.workflow) {
    if (args.input !== undefined || args.summarize !== undefined)
      throw new Error("--input and --summarize require --workflow")
    return
  }
  const incompatible = [
    "command",
    "mini",
    "interactive",
    "research",
    "file",
    "model",
    "agent",
    "variant",
    "size",
    "judge",
    "max-cost",
    "max-steps",
    "stop-helpers",
    "thinking",
    "demo",
  ].filter(
    (key) => args[key] !== undefined && args[key] !== false && (!Array.isArray(args[key]) || args[key].length > 0),
  )
  if (message.trim() || incompatible.length || args.format === "json")
    throw new Error(
      "--workflow runs a workflow without a prompt, attached files or prompt-only options. Set agent/model and limits in the workflow or conversation; use vector workflow show --json for structured results.",
    )
}

/** @internal Exported for focused permission-policy tests. */
export function runPermissionReply(
  auto: boolean,
  permission: string,
  always?: readonly string[],
  patterns?: readonly string[],
  research = false,
): "once" | "reject" {
  // `--research` is the user's consent to read public pages for its run, so the run's one read approval is answered
  // unless it asks every time. Every other ask, a page on the user's own network included, still needs --auto.
  if (research && permission === "research_read" && !PermissionPolicy.requiresApproval(permission, always, patterns))
    return "once"
  return auto && PermissionPolicy.canAutoApprove(permission, always, patterns) ? "once" : "reject"
}

function pick(value: string | undefined): ModelInput | undefined {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  } as ModelInput
}

/**
 * What a prompt sends: the message the user typed, then what was piped in as a part of its own. Piped text (an issue
 * from `gh issue view`, a log, a web page) is not the user's words, so it is marked as outside content: it never vouches
 * for memory, and memory written in its session waits for the user's review.
 */
export function promptParts(message: string, piped?: string) {
  return [
    ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
    ...(piped?.trim() ? [{ type: "text" as const, text: piped, metadata: { [BrainSchema.OUTSIDE]: "stdin" } }] : []),
  ]
}

/**
 * What a command sends: piped text goes first, as a message of its own marked as outside content (see `promptParts`),
 * and the command's arguments are only what the user typed. Memory takes a command's arguments as the user's own words,
 * so text piped into `vector run --command` must never become part of them.
 */
export function commandInput(message: string, piped?: string) {
  return { arguments: message, before: promptParts("", piped) }
}

function resolveRunInput(value?: string, piped?: string): string | undefined {
  if (!value) {
    return piped
  }

  if (!piped) {
    return value
  }

  return value + "\n" + piped
}

type FilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

const ATTACH_FILE_MAX_BYTES = 10 * 1024 * 1024

// The search services an earlier version's --search named. Research searches the web in each research agent's own
// browser now, so they read as browser (yargs coerces before it checks choices), and the run says they were ignored.
const RETIRED_SEARCH = ["searxng", "exa", "parallel"]
export const RETIRED_SEARCH_NOTICE =
  "research searches the web in each research agent's own browser in the desktop app, with no search service or key."
// The retired name this process's --search gave, for the notice: yargs parses one command line per process.
const retired: { search?: string } = {}

type Inline = {
  icon: string
  title: string
  description?: string
}

type SessionInfo = {
  id: string
  title?: string
  directory?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function formatRunError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

/** The run budget carried on the prompt request, or undefined when neither --max-cost nor --max-steps is set. */
export function budgetFrom(input: { "max-cost"?: number; "max-steps"?: number }): RunBudget | undefined {
  if (input["max-cost"] === undefined && input["max-steps"] === undefined) return undefined
  return {
    ...(input["max-cost"] !== undefined && { usd: input["max-cost"] }),
    ...(input["max-steps"] !== undefined && { steps: input["max-steps"] }),
  }
}

/** Exit status for a finished run: 3 when the spend guard stopped it, 1 for any other error, 0 otherwise. */
export function exitCodeFor(info: Message | undefined) {
  if (info?.role !== "assistant" || !info.error) return 0
  if (info.error.name === "BudgetStopError") return 3
  return 1
}

async function tool(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    if (next.mode === "block") {
      block(next, next.body)
      return
    }

    inline(next)
  } catch {
    inline({
      icon: "\u2699",
      title: part.tool,
    })
  }
}

async function toolError(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    inline({
      icon: "✗",
      title: `${next.title} failed`,
      ...(next.description && { description: next.description }),
    })
    return
  } catch {
    inline({
      icon: "✗",
      title: `${part.tool} failed`,
    })
  }
}

export const RunCommand = effectCmd({
  command: "run [message..]",
  describe: "run vector with a message",
  // --attach connects to a remote server (no local instance needed); the
  // default path runs an in-process server and needs the project instance.
  instance: (args) => !args.attach,
  // For --dir without --attach, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("workflow", {
        type: "string",
        describe:
          "run a saved workflow name or local JSON file; prints its plan and progress to stderr and report to stdout",
      })
      .option("input", {
        type: "string",
        array: true,
        describe: "with --workflow: input key=value (JSON values or literal strings)",
      })
      .option("summarize", {
        type: "boolean",
        describe: "with --workflow: ask the conversation's agent to summarize the final report",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("share", {
        type: "boolean",
        describe:
          "publish this session’s conversation, code, and tool output publicly on vectordev.ai, including future updates (30 days)",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (defaults to the truncated prompt)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running vector server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to VECTOR_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (default: VECTOR_SERVER_USERNAME or vector)",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      })
      .option("mini", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("replay", {
        type: "boolean",
        default: true,
        hidden: true,
        describe: "replay interactive session history on resume and after resize (use --no-replay to disable)",
      })
      .option("replay-limit", {
        type: "number",
        hidden: true,
        describe: "cap visible interactive replay to the newest N messages",
      })
      .option("interactive", {
        alias: ["i"],
        type: "boolean",
        describe: "run in direct interactive split-footer mode",
        default: false,
      })
      .option("max-cost", {
        type: "number",
        describe: "Dollar cap for this run. Vector Codium steps are not counted; step limits still apply.",
      })
      .option("max-steps", {
        type: "number",
        describe: "stop this run after this many model steps",
      })
      .option("stop-helpers", {
        type: "boolean",
        describe:
          "Ctrl+C at a terminal also stops the subagents and background commands this session started, not only the main turn. Without --attach, exiting ends them anyway",
      })
      .option("size", {
        type: "string",
        choices: ["auto", "chat", "light", "standard", "thorough"],
        describe:
          "how much harness each prompt gets: auto (default) sizes it from what it says; standard and thorough offer subagents; light only manages ones already running",
      })
      .option("judge", {
        type: "string",
        choices: ["off", "thorough", "changes"],
        describe:
          "run LLM-as-a-judge after large tasks that changed files (thorough) or after every task that changed files (changes)",
      })
      .option("research", {
        type: "boolean",
        describe:
          "Deep research (preview): plan the question, search and read the web and this repository's brain, and write a report in which each claim cites a quote from its source. Makes no code changes. Reads public pages for the run without asking; any other approval, a page on your own network included, needs --auto",
      })
      .option("depth", {
        type: "string",
        choices: ["focused", "deep", "auto"],
        describe:
          "with --research: focused (one agent, plus up to 2 researchers), deep (up to 4 researchers and a judge that checks the citations) or auto (the default)",
      })
      .option("search", {
        type: "string",
        choices: ["browser", "none"],
        // A search service an earlier version took reads as browser, and the run says it was ignored.
        coerce: (value: string) => {
          if (!RETIRED_SEARCH.includes(value)) return value
          retired.search = value
          return "browser"
        },
        describe:
          "with --research: browser (the default: each research agent searches the web in its own browser in the desktop app) or none (this repository's brain, its files and the addresses in the message)",
      })
      .option("scope", {
        type: "string",
        choices: ["web", "brain", "all"],
        describe: "with --research: the web, this repository's brain and files, or both (all)",
      })
      .option("report", {
        type: "string",
        describe: "with --research: write the report and sources to a .md, .json, .docx or .pdf file",
      })
      .option("auto", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("yolo", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("local", {
        type: "boolean",
        describe:
          "keep this run on Vector Local: model calls go only to the model servers on your list, and Vector's own requests to vectordev.ai are blocked. It only tightens, and changes no setting",
      })
      .option("demo", {
        type: "boolean",
        default: false,
        hidden: true,
        describe: "enable direct interactive demo slash commands; pass one as the message to run it immediately",
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    if (args.workflow) yield* Effect.promise(() => assertWorkflowOwner("start workflows"))
    const { Agent } = yield* Effect.promise(() => import("@/agent/agent"))
    const { RuntimeFlags } = yield* Effect.promise(() => import("@/effect/runtime-flags"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const agentSvc = yield* Agent.Service
    const providerSvc = yield* Provider.Service
    const flags = yield* RuntimeFlags.Service
    const localInstance = yield* InstanceRef
    const { InstanceStore } = yield* Effect.promise(() => import("@/project/instance-store"))
    const instances = yield* InstanceStore.Service
    yield* Effect.promise(async () => {
      const rawMessage = [...args.message, ...(args["--"] || [])].join(" ")
      validateWorkflowRunOptions(args, rawMessage)
      const interactive = args.mini
      const auto = args.auto || args.yolo || args["dangerously-skip-permissions"]
      const thinking = interactive ? (args.thinking ?? true) : (args.thinking ?? false)
      const die = (message: string): never => {
        UI.error(message)
        process.exit(1)
      }
      const dieInteractive = (error: unknown): never => {
        if (error instanceof Error && error.message === INTERACTIVE_INPUT_ERROR) {
          die(error.message)
        }

        throw error
      }

      // A command's arguments are quoted so its $1, $2 placeholders keep their boundaries. A prompt reaches the model
      // as typed, not wrapped in quotation marks with its own quotes escaped.
      const message = args.command
        ? [...args.message, ...(args["--"] || [])]
            .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
            .join(" ")
        : rawMessage

      if (interactive && args.command) {
        die("--mini cannot be used with --command")
      }

      if (interactive && args._?.[0] !== "mini") {
        die("--mini must be used without the run subcommand")
      }

      if (args.demo && !interactive) {
        die("--demo requires --mini")
      }

      if (interactive && args.format === "json") {
        die("--mini cannot be used with --format json")
      }

      if (args["replay-limit"] !== undefined && !interactive) {
        die("--replay-limit requires --mini")
      }

      if (
        args["replay-limit"] !== undefined &&
        (!Number.isInteger(args["replay-limit"]) || args["replay-limit"] <= 0)
      ) {
        die("--replay-limit must be a positive integer")
      }

      if (args["max-cost"] !== undefined && !(Number.isFinite(args["max-cost"]) && args["max-cost"] > 0)) {
        die("--max-cost must be a positive number of US dollars")
      }

      if (args["max-steps"] !== undefined && !(Number.isInteger(args["max-steps"]) && args["max-steps"] > 0)) {
        die("--max-steps must be a positive integer")
      }

      if (!args.research && (args.depth || args.search || args.scope || args.report))
        die("--depth, --search, --scope and --report need --research")
      if (retired.search) UI.println(`--search ${retired.search} is ignored: ${RETIRED_SEARCH_NOTICE}`)
      if (args.research && (interactive || args.command)) die("--research cannot be used with --mini or --command")
      if (args.research && args.agent && args.agent !== "research")
        die("--research runs the research agent, so it cannot be used with --agent")
      if (args.research && args.depth && args.size) die("--depth and --size cannot be used together")

      const budget = budgetFrom(args)
      // --depth is the research request's size: Deep is Thorough, Focused is Work, and auto lets Vector size it.
      const size = args.depth === "deep" ? "thorough" : args.depth === "focused" ? "standard" : args.size
      const sizing = {
        ...(size ? { size: size as TaskSize.Choice } : {}),
        ...(args.judge ? { judge: args.judge as TaskSize.JudgeMode } : {}),
      }
      const agentName = args.research ? "research" : args.agent

      if (interactive && !process.stdout.isTTY) {
        die("--mini requires a TTY stdout")
      }

      if (interactive) {
        try {
          resolveInteractiveStdin().cleanup?.()
        } catch (error) {
          dieInteractive(error)
        }
      }

      const replay = args.replay === false ? false : args.replay || args["replay-limit"] !== undefined

      // Subprocess launchers may inherit a PWD that differs from the selected working directory.
      const root = Filesystem.resolve(process.cwd())
      const directory = (() => {
        if (!args.dir) return args.attach ? undefined : root
        if (args.attach) return args.dir

        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch {
          UI.error("Failed to change directory to " + args.dir)
          process.exit(1)
        }
      })()
      const workflow = args.workflow
        ? {
            ...(await readWorkflowSource(args.workflow)),
            inputs: parseWorkflowInputs(args.input),
            ...(args.title ? { title: args.title } : {}),
          }
        : undefined
      if (args.attach)
        ServerAuth.assertSecurePasswordTransport(args.attach, args.password ?? process.env.VECTOR_SERVER_PASSWORD)
      const attachHeaders = args.attach
        ? ServerAuth.headers({ password: args.password, username: args.username })
        : undefined
      const attachSDK = (dir?: string) => {
        return createVectorClient({
          baseUrl: args.attach!,
          directory: dir,
          headers: attachHeaders,
        })
      }

      // --local keeps this process on Vector Local, and an attached server runs the session in a process of its own,
      // so the run goes ahead only where that server has Vector Local on already. This process reaches that server
      // because runLocal listed it, unless Vector Local here refused to (a company lock, or the agent marker).
      if (args.local && args.attach) {
        const remote = await attachSDK(directory)
          .local.get()
          .catch((error: unknown) => ({ data: undefined, error }))
        // The client hands back a request the network guard refused as its error, rather than throwing it.
        const failure: unknown = remote.error
        if (failure instanceof Error && failure.name === "EgressBlocked") {
          const { Config } = await import("@/config/config")
          die(
            [
              `--local keeps this computer's requests on Vector Local, which kept this run from reaching ${args.attach}.`,
              failure.message,
              ...Config.local().warnings,
            ].join(" "),
          )
        }
        if (!remote.data?.policy.enabled)
          die(
            `--local keeps the runs this computer starts on Vector Local, and the server at ${args.attach} ${remote.data ? "has it off" : "did not say whether it has it on"}. Turn it on there with vector local on, or run without --attach.`,
          )
      }

      const files: FilePart[] = []
      if (args.file) {
        const list = Array.isArray(args.file) ? args.file : [args.file]

        for (const filePath of list) {
          const resolvedPath = path.resolve(args.attach ? root : (directory ?? root), filePath)
          if (!(await Filesystem.exists(resolvedPath))) {
            UI.error(`File not found: ${filePath}`)
            process.exit(1)
          }

          const stat = Filesystem.stat(resolvedPath)
          const isDirectory = stat?.isDirectory() ?? false
          if (args.attach && isDirectory) {
            UI.error(`Cannot attach local directory without a shared filesystem: ${filePath}`)
            process.exit(1)
          }

          const content = await (async () => {
            if (!args.attach) return
            const handle = await open(resolvedPath, "r")
            try {
              const opened = await handle.stat()
              if (!opened.isFile() || Number(opened.size) > ATTACH_FILE_MAX_BYTES) {
                UI.error(`Cannot attach local file larger than 10 MiB or a special file: ${filePath}`)
                process.exit(1)
              }
              if (opened.size === 0) return Buffer.alloc(0)
              const buffer = Buffer.alloc(Number(opened.size))
              let offset = 0
              while (offset < buffer.length) {
                const read = await handle.read(buffer, offset, buffer.length - offset, offset)
                if (read.bytesRead === 0) break
                offset += read.bytesRead
              }
              return buffer.subarray(0, offset)
            } finally {
              await handle.close()
            }
          })()
          const detected = FSUtil.mimeType(resolvedPath)
          const text = content?.toString("utf8")
          const mime = !args.attach
            ? isDirectory
              ? "application/x-directory"
              : "text/plain"
            : content && text !== undefined && Buffer.from(text, "utf8").equals(content)
              ? "text/plain"
              : detected

          files.push({
            type: "file",
            url: content ? `data:${mime};base64,${content.toString("base64")}` : pathToFileURL(resolvedPath).href,
            filename: path.basename(resolvedPath),
            mime,
          })
        }
      }

      const piped = workflow || process.stdin.isTTY ? undefined : await Bun.stdin.text()
      // A prompt sends what was piped in as a part of its own (see `promptParts`), and a command as a message before it
      // (see `commandInput`).
      const input = resolveRunInput(message, piped) ?? ""
      const initialInput = resolveRunInput(rawMessage, piped)

      if (input.trim().length === 0 && !args.command && !interactive && !workflow) {
        UI.error("You must provide a message or a command")
        process.exit(1)
      }

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exit(1)
      }

      const rules: PermissionV1.Ruleset = interactive
        ? []
        : [
            {
              permission: "question",
              action: "deny",
              pattern: "*",
            },
            {
              permission: "plan_enter",
              action: "deny",
              pattern: "*",
            },
            {
              permission: "plan_exit",
              action: "deny",
              pattern: "*",
            },
          ]

      function title() {
        if (args.title) return args.title
        if (args.workflow) return `Workflow: ${args.workflow}`
        // A headless run has no one to show a title to, so it names its session after the prompt instead of sending a
        // model request for a title.
        if (args.title === undefined && interactive) return undefined
        const text = (args.command ? `/${args.command} ${message}` : input).trim()
        if (!text) return undefined
        return text.length > 50 ? `${text.slice(0, 50)}...` : text
      }

      const publications = new Map<string, VectorClient>()

      async function session(sdk: VectorClient): Promise<SessionInfo | undefined> {
        const selected = await resolveSession(sdk)
        if (!selected || !args.share) return selected
        const result = await sdk.session.share({
          sessionID: selected.id,
          publicSessionPublish: {
            consent: { version: PublicSession.CONSENT_VERSION, public: true, updates: true },
            expiresAt: Date.now() + PublicSession.MAX_AGE_MS,
          },
        })
        if (result.error) throw new Error(formatRunError(result.error))
        const share = Schema.decodeUnknownSync(PublicSession.Info)(result.data)
        publications.set(selected.id, sdk)
        if (args.format === "json") {
          process.stdout.write(
            JSON.stringify({ type: "share", timestamp: Date.now(), sessionID: selected.id, share }) + EOL,
          )
          return selected
        }
        process.stderr.write(
          `Public session: ${share.url}${EOL}Conversation text, code, and tool output, including future updates, are public until ${new Date(share.expiresAt).toISOString()}.${EOL}`,
        )
        return selected
      }

      async function withSharing<A>(work: () => Promise<A>): Promise<A> {
        try {
          return await work()
        } finally {
          for (const [sessionID, sdk] of publications) {
            const result = await sdk.session.shareFlush({ sessionID }).catch((error: unknown) => ({ error }))
            if (!result.error) continue
            const message = `Could not finish updating the public session: ${formatRunError(result.error)}`
            if (args.format === "json")
              process.stdout.write(
                JSON.stringify({
                  type: "error",
                  timestamp: Date.now(),
                  sessionID,
                  error: { name: "PublicSessionError", data: { message } },
                }) + EOL,
              )
            if (args.format !== "json") UI.error(message)
            process.exitCode = 1
          }
        }
      }

      async function resolveSession(sdk: VectorClient): Promise<SessionInfo | undefined> {
        if (args.session) {
          const current = await sdk.session
            .get({
              sessionID: args.session,
            })
            .catch(() => undefined)

          if (!current?.data) {
            UI.error("Session not found")
            process.exit(1)
          }

          if (args.fork) {
            const forked = await sdk.session.fork({
              sessionID: args.session,
            })
            const id = forked.data?.id
            if (!id) {
              return
            }

            return {
              id,
              title: forked.data?.title ?? current.data.title,
              directory: forked.data?.directory ?? current.data.directory,
            }
          }

          return {
            id: current.data.id,
            title: current.data.title,
            directory: current.data.directory,
          }
        }

        const base = args.continue ? (await sdk.session.list()).data?.find((item) => !item.parentID) : undefined

        if (base && args.fork) {
          const forked = await sdk.session.fork({
            sessionID: base.id,
          })
          const id = forked.data?.id
          if (!id) {
            return
          }

          return {
            id,
            title: forked.data?.title ?? base.title,
            directory: forked.data?.directory ?? base.directory,
          }
        }

        if (base) {
          return {
            id: base.id,
            title: base.title,
            directory: base.directory,
          }
        }

        const name = title()
        const result = await sdk.session.create({
          title: name,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          return
        }

        return {
          id,
          title: result.data?.title ?? name,
          directory: result.data?.directory,
        }
      }

      async function createFreshSession(
        sdk: VectorClient,
        input: { agent: string | undefined; model: ModelInput | undefined; variant: string | undefined },
      ): Promise<SessionInfo> {
        const result = await sdk.session.create({
          title: args.title !== undefined && args.title !== "" ? args.title : undefined,
          agent: input.agent,
          model: input.model
            ? {
                providerID: input.model.providerID,
                id: input.model.modelID,
                variant: input.variant,
              }
            : undefined,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          throw new Error("Failed to create session")
        }

        return {
          id,
          title: result.data?.title,
        }
      }

      async function current(sdk: VectorClient): Promise<string> {
        if (!args.attach) {
          return directory ?? root
        }

        const next = await sdk.path
          .get()
          .then((x) => x.data?.directory)
          .catch(() => undefined)
        if (next) {
          return next
        }

        UI.error("Failed to resolve remote directory")
        process.exit(1)
      }

      async function localAgent() {
        if (!agentName) return undefined
        const name = agentName

        const entry = await Effect.runPromise(
          agentSvc.get(name).pipe(Effect.provideService(InstanceRef, localInstance)),
        )
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (entry.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return name
      }

      async function attachAgent(sdk: VectorClient) {
        if (!agentName) return undefined
        const name = agentName

        const modes = await sdk.app
          .agents(undefined, { throwOnError: true })
          .then((x) => x.data ?? [])
          .catch(() => undefined)

        if (!modes) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `failed to list agents from ${args.attach}. Falling back to default agent`,
          )
          return undefined
        }

        const agent = modes.find((a) => a.name === name)
        if (!agent) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }

        if (agent.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }

        return name
      }

      async function pickAgent(sdk: VectorClient) {
        if (!agentName) return undefined
        if (args.attach) {
          return attachAgent(sdk)
        }

        return localAgent()
      }

      async function execute(sdk: VectorClient) {
        if (workflow) await requireWorkflowCapability(sdk, "start")
        const available = await sdk.config.providers({}, { throwOnError: true })
        if (!available.data.providers.some((provider) => Object.keys(provider.models).length > 0)) {
          // With Vector Local on, models whose servers are not on the list are off; say which, not how to sign in.
          const off = (available.data.unavailable ?? []).filter((item) => item.reason === "off-in-local")
          if (off.length > 0) {
            UI.error(
              `Vector Local is on, and it keeps every model you have off. ${off.map((item) => item.message).join(" ")} Add a model server with vector local setup.`,
            )
            process.exit(1)
          }
          // Only a local engine can say whether signing in would list free models; an attached server runs elsewhere.
          const signIn =
            !args.attach &&
            (await Effect.runPromise(providerSvc.freeSignIn().pipe(Effect.provideService(InstanceRef, localInstance))))
          UI.error(signIn ? `${MODEL_SETUP_GUIDANCE} ${FREE_MODELS_SIGN_IN_TERMINAL}` : MODEL_SETUP_GUIDANCE)
          process.exit(1)
        }
        const sess = await session(sdk)
        if (!sess?.id) {
          UI.error("Session not found")
          process.exit(1)
        }
        const sessionID = sess.id
        // Background subagents this run launches record a later start than this.
        const runStartedAt = Date.now()
        const backgroundWait = flags.runBackgroundWaitMs ?? BACKGROUND_WAIT_MS

        function emit(type: string, data: Record<string, unknown>) {
          if (args.format === "json") {
            process.stdout.write(
              JSON.stringify({
                type,
                timestamp: Date.now(),
                sessionID,
                ...data,
              }) + EOL,
            )
            return true
          }
          return false
        }

        const failure = { streamed: false, request: false }
        function rejectRequest(error: unknown) {
          failure.request = true
          if (!failure.streamed && !emit("error", { error })) UI.error(formatRunError(error))
          process.exitCode = 1
        }

        // A config budget (budget.run) can stop a run even without --max-cost, so every finished prompt is checked.
        function conclude(info: Message | undefined) {
          if (
            info?.role === "assistant" &&
            info.error?.name === "BudgetStopError" &&
            !emit("error", { error: info.error })
          ) {
            UI.println(UI.Style.TEXT_WARNING_BOLD + "Stopped:", UI.Style.TEXT_NORMAL + info.error.data.message)
          }
          const code = exitCodeFor(info)
          if (code) process.exitCode = code
        }

        // Consume one subscribed event stream for the active session and mirror it
        // to stdout/UI. `client` is passed explicitly because attach mode may
        // rebind the SDK to the session's directory after the subscription is
        // created, and replies issued from inside the loop must use that client.
        async function loop(client: VectorClient, events: Awaited<ReturnType<typeof sdk.event.subscribe>>) {
          const toggles = new Map<string, boolean>()
          // A step-finish part is written again once its snapshot lands; its usage was already in the first write.
          const finishedSteps = new Set<string>()
          const billingByMessage = new Map<string, "codium" | "own" | undefined>()
          // Subagents run in child sessions, and a request left unanswered there blocks the whole run, so the run
          // answers requests from any session that descends from its own.
          const tree = new Set([sessionID])
          const inRun = runSessionAncestry(tree, async (id) =>
            (await client.session.get({ sessionID: id }, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined))?.data,
          )
          let error: string | undefined
          // A background subagent reports back in a follow-up turn after this session goes idle, and exiting would stop
          // it, so the run waits for each one it launched and for the turn that answers it. A stopped one starts no
          // turn. A note is answered once an assistant message created after it finishes: one that lands while a turn
          // is ending is read by the next turn, which starts after the session has briefly gone idle. A background
          // command (5.H) is waited for the same way, from the shell call that started it to its exit note.
          const background = backgroundTracker()
          let idle = false
          let activeAt = Date.now()
          const waited = background.settled

          const iterator = events.stream[Symbol.asyncIterator]()
          while (true) {
            const next: Awaited<ReturnType<typeof nextBackgroundEvent<Event>>> = await nextBackgroundEvent(
              iterator,
              idle && !waited() ? backgroundWait - (Date.now() - activeAt) : undefined,
              !idle || !waited(),
            )
            // A rejected request is already terminal; its teardown can close an iterator that was awaiting an event.
            if (failure.request) break
            if (next.timedOut || next.disconnected) {
              const message = next.timedOut
                ? `Stopped waiting for ${waitingFor(background)} after ${Math.round(backgroundWait / 1000)}s without activity`
                : "The event stream ended before the parent and its background subagents finished. Completion could not be confirmed."
              error = error ? error + EOL + message : message
              if (
                !emit("error", {
                  error: {
                    name: next.timedOut ? "BackgroundSubagentTimeout" : "EventStreamDisconnected",
                    data: { message },
                  },
                })
              )
                UI.error(message)
              if (!next.timedOut && !idle)
                await client.session
                  .abort({ sessionID }, { signal: AbortSignal.timeout(5_000), throwOnError: true })
                  .catch(() => undefined)
              if (background.running.size)
                await client.experimental.task
                  .stop(
                    {
                      sessionID,
                      taskIDs: [...background.running],
                      reason: message,
                    },
                    { signal: AbortSignal.timeout(5_000), throwOnError: true },
                  )
                  .catch(() => undefined)
              break
            }
            if (next.event.done) break
            const event: Event = next.event.value
            if (event.type === "message.updated" && event.properties.info.role === "assistant")
              billingByMessage.set(
                event.properties.info.id,
                Billing.of(event.properties.info) ??
                  (Billing.hasOwnIdentity(event.properties.info) ? "own" : undefined),
              )
            const properties: unknown = "properties" in event ? event.properties : undefined
            const owner = isRecord(properties)
              ? isRecord(properties.info) && typeof properties.info.sessionID === "string"
                ? properties.info.sessionID
                : typeof properties.sessionID === "string"
                  ? properties.sessionID
                  : isRecord(properties.part) && typeof properties.part.sessionID === "string"
                    ? properties.part.sessionID
                    : undefined
              : undefined
            // Discover nested activity on its first event, before a step finishes
            // or a permission prompt appears, in every output format.
            if (owner && (await inRun(owner))) activeAt = Date.now()

            if (
              (event.type === "session.created" || event.type === "session.updated") &&
              event.properties.info.parentID === sessionID
            ) {
              const status = backgroundStatus(event.properties.info, runStartedAt)
              const id = event.properties.info.id
              tree.add(id)
              activeAt = Date.now()
              const record = event.properties.info.metadata?.subagent
              if (status)
                background.status(
                  id,
                  status,
                  isRecord(record) && typeof record.attempt === "number" ? record.attempt : undefined,
                )
              if (status && idle && waited()) break
            }

            if (
              event.type === "message.updated" &&
              event.properties.sessionID === sessionID &&
              event.properties.info.role === "assistant" &&
              event.properties.info.time.completed !== undefined
            ) {
              background.answer(event.properties.info.id)
              if (idle && waited()) break
            }

            // The first answer names the model that runs. One labelled "May train on your prompts" says so once, on
            // stderr whatever the output format, so a script's stdout stays as it was.
            if (
              event.type === "message.updated" &&
              event.properties.sessionID === sessionID &&
              event.properties.info.role === "assistant" &&
              toggles.get("training") !== true
            ) {
              toggles.set("training", true)
              const notice = freeModelRunNotice(available.data.providers, event.properties.info)
              if (notice) process.stderr.write(notice + EOL)
            }

            if (
              event.type === "message.updated" &&
              event.properties.sessionID === sessionID &&
              event.properties.info.role === "assistant" &&
              args.format !== "json" &&
              toggles.get("start") !== true
            ) {
              UI.empty()
              UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
              UI.empty()
              toggles.set("start", true)
            }

            if (event.type === "message.part.updated") {
              const part = event.properties.part
              const note =
                part.sessionID === sessionID && part.type === "text" ? part.metadata?.taskNotification : undefined
              if (isRecord(note) && typeof note.taskID === "string") {
                background.note(
                  note.taskID,
                  part.messageID,
                  note.quiet === true,
                  typeof note.attempt === "number" ? note.attempt : undefined,
                )
                if (idle && waited()) break
              }
              if (part.sessionID === sessionID && trackShell(background, part) && idle && waited()) break
              if (part.sessionID !== sessionID) {
                // A subagent's steps bill this run too. JSON output reports them, marked as a subagent's, so a
                // consumer that totals step_finish records gets what the run spent.
                if (
                  part.type === "step-finish" &&
                  args.format === "json" &&
                  !finishedSteps.has(part.id) &&
                  (await inRun(part.sessionID))
                ) {
                  finishedSteps.add(part.id)
                  emit("step_finish", {
                    part: stepForOutput(part, billingByMessage.get(part.messageID)),
                    subagent: true,
                  })
                }
                // A researcher's steps show as they happen, under the lead's.
                const progress = args.research && args.format !== "json" ? researchProgress(part) : undefined
                if (progress && toggles.get(part.id) !== true && (await inRun(part.sessionID))) {
                  toggles.set(part.id, true)
                  inline({ ...progress, title: `researcher · ${progress.title}` })
                }
                continue
              }

              if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
                if (emit("tool_use", { part: toolForOutput(part) })) continue
                const progress = researchProgress(part)
                if (progress) {
                  if (toggles.get(part.id) === true) continue
                  toggles.set(part.id, true)
                  if (progress.body) block(progress, progress.body)
                  else inline(progress)
                  continue
                }
                if (part.state.status === "completed") {
                  await tool(part)
                  continue
                }
                await toolError(part)
                UI.error(part.state.error)
              }

              if (
                part.type === "tool" &&
                part.tool === "task" &&
                part.state.status === "running" &&
                args.format !== "json"
              ) {
                if (toggles.get(part.id) === true) continue
                await tool(part)
                toggles.set(part.id, true)
              }

              if (part.type === "step-start") {
                if (emit("step_start", { part })) continue
              }

              if (part.type === "step-finish") {
                if (finishedSteps.has(part.id)) continue
                finishedSteps.add(part.id)
                if (emit("step_finish", { part: stepForOutput(part, billingByMessage.get(part.messageID)) })) continue
              }

              if (part.type === "text" && part.time?.end) {
                if (emit("text", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                if (!process.stdout.isTTY) {
                  process.stdout.write(text + EOL)
                  continue
                }
                UI.empty()
                UI.println(text)
                UI.empty()
              }

              if (part.type === "reasoning" && part.time?.end && thinking) {
                if (emit("reasoning", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                const line = `Thinking: ${text}`
                if (process.stdout.isTTY) {
                  UI.empty()
                  UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                  UI.empty()
                  continue
                }
                process.stdout.write(line + EOL)
              }
            }

            if (event.type === "session.error") {
              const props = event.properties
              // A rejected request can also publish session.error; report that failure once in either arrival order.
              if (props.sessionID !== sessionID || !props.error || failure.request) continue
              // A spend guard stop is reported once as "Stopped: ..." when the prompt returns, not as an error.
              if (props.error.name === "BudgetStopError") continue
              failure.streamed = true
              let err = String(props.error.name)
              if ("data" in props.error && props.error.data && "message" in props.error.data) {
                err = String(props.error.data.message)
              }
              error = error ? error + EOL + err : err
              if (emit("error", { error: props.error })) continue
              UI.error(err)
            }

            if (event.type === "session.status" && event.properties.sessionID === sessionID) {
              idle = event.properties.status.type === "idle"
              if (idle) {
                if (waited()) break
              }
            }

            if (event.type === "permission.asked") {
              const permission = event.properties
              if (!(await inRun(permission.sessionID))) continue

              // Non-interactive auto mode cannot supply the fresh approval required for sensitive actions.
              if (
                runPermissionReply(
                  auto,
                  permission.permission,
                  permission.always,
                  permission.patterns,
                  args.research === true,
                ) === "once"
              ) {
                await client.permission.reply({
                  requestID: permission.id,
                  reply: "once",
                })
              } else {
                UI.println(
                  UI.Style.TEXT_WARNING_BOLD + "!",
                  UI.Style.TEXT_NORMAL +
                    `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
                )
                await client.permission.reply({
                  requestID: permission.id,
                  reply: "reject",
                })
              }
            }
          }
          return error
        }
        const cwd = args.attach ? (directory ?? sess.directory ?? (await current(sdk))) : (directory ?? root)
        const client = args.attach ? attachSDK(cwd) : sdk

        if (workflow) {
          const result = await runWorkflow(
            client,
            { sessionID, source: workflow, summarize: args.summarize, auto, timeout: backgroundWait },
            {
              stdout: (text) => process.stdout.write(text),
              stderr: (text) => process.stderr.write(text),
            },
          )
          if (result.exitCode) process.exitCode = result.exitCode
          return
        }

        // Validate agent if specified
        const agent = await pickAgent(client)

        const requested = pick(args.model)
        if (requested) {
          // An attached session may resolve to a different directory than the initial SDK.
          const configured = args.attach ? await client.config.providers({}, { throwOnError: true }) : available
          const unavailable = configured.data.unavailable ?? (await client.provider.list()).data?.unavailable
          const notice = unavailable?.find((item) => item.id === requested.providerID)
          if (notice) {
            const error = {
              name: "ProviderUnavailable",
              data: { message: `Model unavailable: ${requested.providerID}/${requested.modelID}. ${notice.message}` },
            }
            if (!emit("error", { error })) UI.error(error.data.message)
            process.exitCode = 1
            return
          }
        }

        if (!interactive) {
          const streamAbort = new AbortController()
          const events = await client.event.subscribe(undefined, { signal: streamAbort.signal })
          // Ctrl+C at a terminal (5.I.6): with --attach the first press stops the main turn, or everything with
          // --stop-helpers, and says which helpers keep running; a second press within 5 s stops them too and exits
          // 130. SIGTERM and runs without a terminal keep the default.
          // Without --attach the engine runs here, and the terminal's interrupt reached the processes it started, so
          // every press stops everything and exits (interrupt.ts). process.exit skips the command's own disposal: the
          // in-process engine is disposed first, so the background commands and helpers it started end with it (5.H),
          // bounded like the stop before it. A press while that runs exits at once.
          let leaving = false
          const leave = (code: number) => {
            const local = args.attach ? undefined : localInstance
            if (leaving || !local) return process.exit(code)
            leaving = true
            void Promise.race([
              Effect.runPromise(instances.dispose(local)),
              new Promise((resolve) => setTimeout(resolve, 5_000)),
            ])
              .catch(() => undefined)
              .finally(() => process.exit(code))
          }
          const interrupts = handlesInterrupt({
            interactive,
            workflow: false,
            tty: process.stdin.isTTY === true || process.stderr.isTTY === true,
          })
            ? watchInterrupts({
                client,
                sessionID,
                stopHelpers: args["stop-helpers"] === true,
                inProcess: !args.attach,
                write: (text) => process.stderr.write(text + EOL),
                exit: leave,
              })
            : undefined
          const completed = loop(client, events)
            .catch((e) => {
              console.error(e)
              process.exitCode = 1
            })
            .finally(() => {
              streamAbort.abort()
              interrupts?.dispose()
            })
          async function finish() {
            const error = await completed
            if (error) process.exitCode = 1
          }
          // A run the user stopped with Ctrl+C ends as an interrupted command does.
          const interrupted = () => {
            if (interrupts?.interrupted) process.exitCode = INTERRUPT_EXIT_CODE
          }

          if (args.command) {
            const sent = commandInput(message, piped)
            if (sent.before.length > 0) {
              const saved = await client.session.prompt({ sessionID, agent, noReply: true, parts: sent.before })
              if (saved.error) {
                rejectRequest(saved.error)
                return
              }
            }
            const result = await client.session.command({
              sessionID,
              agent,
              model: args.model,
              command: args.command,
              arguments: sent.arguments,
              variant: args.variant,
              budget,
              ...sizing,
            })
            if (result.error) {
              rejectRequest(result.error)
              return
            }
            await finish()
            conclude(result.data?.info)
            interrupted()
            return
          }

          const model = pick(args.model)
          if (args.research && agent !== "research") {
            UI.error("The research agent is not available in this engine.")
            process.exitCode = 1
            return
          }
          const result = await client.session.prompt({
            sessionID,
            agent,
            model,
            variant: args.variant,
            budget,
            ...sizing,
            parts: [
              ...files,
              ...promptParts(message, piped),
              ...(args.research ? await researchParts({ search: args.search, scope: args.scope }) : []),
            ],
          })
          if (result.error) {
            rejectRequest(result.error)
            return
          }
          await finish()
          conclude(result.data?.info)
          interrupted()
          if (args.report) await writeReport(client, sessionID, args.report)
          return
        }

        const model = pick(args.model)
        const { runInteractiveMode } = await import("./run/runtime")
        try {
          await runInteractiveMode({
            sdk: client,
            directory: cwd,
            sessionID,
            sessionTitle: sess.title,
            resume: Boolean(args.session || args.continue) && !args.fork,
            replay,
            replayLimit: args["replay-limit"],
            agent,
            model,
            variant: args.variant,
            budget,
            sizing,
            files,
            initialInput,
            createSession: createFreshSession,
            thinking,
            backgroundSubagents: flags.backgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
        return
      }

      if (interactive && !args.attach && !args.session && !args.continue) {
        const model = pick(args.model)
        const { runInteractiveLocalMode } = await import("./run/runtime")
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const { Server } = await import("@/server/server")
          const request = new Request(input, init)
          const headers = new Headers(request.headers)
          const auth = ServerAuth.header()
          if (auth) headers.set("Authorization", auth)
          return Server.Default().app.fetch(new Request(request, { headers }))
        }) as typeof globalThis.fetch

        try {
          return await withSharing(() =>
            runInteractiveLocalMode({
              directory: directory ?? root,
              fetch: fetchFn,
              resolveAgent: localAgent,
              session,
              createSession: createFreshSession,
              agent: args.agent,
              model,
              variant: args.variant,
              budget,
              sizing,
              replay,
              replayLimit: args["replay-limit"],
              files,
              initialInput,
              thinking,
              backgroundSubagents: flags.backgroundSubagents,
              demo: args.demo,
            }),
          )
        } catch (error) {
          dieInteractive(error)
        }
      }

      if (args.attach) {
        const sdk = attachSDK(directory)
        return await withSharing(() => execute(sdk))
      }

      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const { Server } = await import("@/server/server")
        const request = new Request(input, init)
        const headers = new Headers(request.headers)
        const auth = ServerAuth.header()
        if (auth) headers.set("Authorization", auth)
        return Server.Default().app.fetch(new Request(request, { headers }))
      }) as typeof globalThis.fetch
      const sdk = createVectorClient({
        baseUrl: "http://vector.internal",
        fetch: fetchFn,
        directory,
      })
      await withSharing(() => execute(sdk))
    })
  }),
})

/**
 * The settings `vector run --research --search/--scope` sends with its prompt: a note for the research lead, and the
 * choices themselves in its metadata, which the research tools hold the run to.
 */
async function researchParts(input: { search?: string; scope?: string }) {
  const scope = input.scope === "all" ? "web+brain" : input.scope
  if (!input.search && !scope) return []
  const { OPTIONS } = await import("@/tool/research-search")
  const said = [
    ...(scope
      ? [
          `scope ${scope === "brain" ? "this repository's brain and files only" : scope === "web" ? "the web only" : "the web and this repository's brain"}`,
        ]
      : []),
    ...(input.search ? [input.search === "none" ? "no web search" : "search the web in the research browser"] : []),
  ]
  return [
    {
      type: "text" as const,
      text: `Research settings for this run, from the command line: ${said.join("; ")}.`,
      synthetic: true,
      metadata: { [OPTIONS]: { ...(input.search ? { search: input.search } : {}), ...(scope ? { scope } : {}) } },
    },
  ]
}

/**
 * How `vector run --research` shows a research tool's call: the plan in full, then a line for each search, page, note
 * and report. Undefined for any other tool.
 */
export function researchProgress(part: {
  type: string
  tool?: string
  state?: unknown
}): (Inline & { body?: string }) | undefined {
  if (part.type !== "tool" || !part.tool?.startsWith("research_") || !isRecord(part.state)) return undefined
  const state = part.state
  if (state.status === "error")
    return {
      icon: "✗",
      title: `${part.tool} failed`,
      description: typeof state.error === "string" ? state.error : undefined,
    }
  if (state.status !== "completed") return undefined
  const title = typeof state.title === "string" ? state.title : part.tool
  const metadata = isRecord(state.metadata) ? state.metadata : {}
  if (part.tool === "research_plan") {
    const plan = isRecord(metadata.plan) ? metadata.plan : undefined
    if (metadata.answer === "status") return { icon: "◇", title: "Plan updated" }
    if (metadata.approved !== true || !plan) return { icon: "◇", title, description: "nothing was searched or read" }
    const subquestions = Array.isArray(plan.subquestions)
      ? plan.subquestions.filter((item) => typeof item === "string")
      : []
    return {
      icon: "◇",
      title: "Research plan",
      description: `${String(plan.depth)} · ${String(plan.scope)}`,
      body: [
        String(plan.question),
        ...subquestions.map((item, index) => `  ${index + 1}. ${item}`),
        ...(typeof metadata.estimate === "string" ? [metadata.estimate] : []),
      ].join(EOL),
    }
  }
  if (part.tool === "research_search") {
    const results = Array.isArray(metadata.results) ? metadata.results.length : undefined
    return {
      icon: "✱",
      title,
      ...(results === undefined ? {} : { description: `${results} result${results === 1 ? "" : "s"}` }),
    }
  }
  if (part.tool === "research_read") return { icon: "→", title }
  if (part.tool === "research_note") return { icon: "+", title }
  if (part.tool === "research_report")
    return {
      icon: "■",
      title: metadata.refused === true ? "Report refused" : `Report: ${title}`,
      ...(typeof metadata.version === "number" ? { description: `version ${metadata.version}` } : {}),
    }
  return { icon: "⚙", title }
}

// The extension selects the attachment format; unknown extensions keep the existing Markdown behavior.
async function writeReport(client: VectorClient, sessionID: string, file: string) {
  const messages = (await client.session.messages({ sessionID }).catch(() => undefined))?.data ?? []
  const runID = messages
    .flatMap((message) => message.parts)
    .flatMap((part) =>
      part.type === "tool" &&
      part.tool === "research_report" &&
      part.state.status === "completed" &&
      part.state.metadata?.refused !== true &&
      typeof part.state.metadata?.runID === "string"
        ? [part.state.metadata.runID]
        : [],
    )
    .at(-1)
  if (!runID) {
    UI.error("This research wrote no report, so --report wrote no file.")
    process.exitCode = 1
    return
  }
  const extension = path.extname(file).toLowerCase()
  const format =
    extension === ".pdf" ? "pdf" : extension === ".docx" ? "docx" : extension === ".json" ? "json" : "markdown"
  const binary = format === "pdf" || format === "docx"
  const exported = await client.memory.research
    .export({ runID, format }, { parseAs: binary ? "blob" : "text" })
    .catch((error: unknown) => ({ error, data: undefined }))
  const body: unknown = exported.data
  if (exported.error || (binary ? !(body instanceof Blob) : typeof body !== "string")) {
    UI.error(`Could not read the report: ${formatRunError(exported.error)}`)
    process.exitCode = 1
    return
  }
  await Bun.write(
    path.resolve(file),
    body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : (body as string),
  )
  process.stderr.write(`Report written to ${path.resolve(file)}${EOL}`)
}

// How long a run that is waiting on background subagents goes without any activity before it stops waiting.
const BACKGROUND_WAIT_MS = 10 * 60 * 1000

// The lifecycle status of a background subagent this run launched, from the record the task tool keeps on its session.
function backgroundStatus(info: { metadata?: Record<string, unknown> }, since: number) {
  const record = info.metadata?.subagent
  if (!isRecord(record) || record.background !== true) return undefined
  if (typeof record.startedAt !== "number" || record.startedAt < since) return undefined
  return typeof record.status === "string" ? record.status : undefined
}

type MiniCommandInput = {
  directory?: string
  attach?: string
  password?: string
  username?: string
  continue?: boolean
  session?: string
  fork?: boolean
  model?: string
  agent?: string
  prompt?: string
  replay?: boolean
  replayLimit?: number
  demo?: boolean
}

/**
 * `vector run --local`: Vector Local for this run only, as the VECTOR_LOCAL floor in the environment, which can only
 * tighten the policy the user's config and their company's set. It takes effect before anything connects (the CLI
 * calls this before its account check), and the programs the run starts inherit it.
 *
 * With `--attach`, the Vector server the user typed is on the model server list for this run too, through
 * VECTOR_LOCAL_POLICY, the user-level policy the environment may add to. This process then reaches that server, on
 * the user's network as well as on this computer, and nothing else beyond this computer and the list. Vector Local
 * decides it as it does a server the user lists: a company lock may refuse it, and a Vector the agent started adds
 * none.
 *
 * It writes no file, so the next run is as the user's config says: neither the user's config nor Vector's copy of the
 * block the owner let apply (Config.localConfirmedFile), which any start of Vector keeps up to date as it reads the
 * config, and which the floor does not change.
 */
export async function runLocal(attach?: string) {
  process.env.VECTOR_LOCAL = "1"
  const { LocalPolicy } = await import("@vectordevai/core/local-mode/policy")
  const target = attach === undefined ? undefined : LocalPolicy.origin(attach)
  if (target) process.env.VECTOR_LOCAL_POLICY = withEndpoint(process.env.VECTOR_LOCAL_POLICY, target)
  const { Config } = await import("@/config/config")
  return Config.refreshLocal()
}

// VECTOR_LOCAL_POLICY with `origin` among its endpoints. A value that is not a JSON object is left as it is, which the
// policy ignores with a warning, so the server is not listed either.
function withEndpoint(text: string | undefined, origin: string) {
  if (!text?.trim()) return JSON.stringify({ endpoints: [origin] })
  const value = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text))
  if (!isRecord(value)) return text
  const endpoints = Array.isArray(value.endpoints) ? value.endpoints : []
  return JSON.stringify({ ...value, endpoints: [...endpoints, origin] })
}

export async function runMini(input: MiniCommandInput) {
  if (!RunCommand.handler) throw new Error("Mini command handler is unavailable")
  await RunCommand.handler({
    $0: "vector",
    _: ["mini"],
    message: input.prompt ? [input.prompt] : [],
    share: undefined,
    command: undefined,
    workflow: undefined,
    input: undefined,
    summarize: undefined,
    continue: input.continue,
    session: input.session,
    fork: input.fork,
    model: input.model,
    agent: input.agent,
    format: "default",
    file: undefined,
    title: undefined,
    attach: input.attach,
    password: input.password,
    username: input.username,
    dir: input.directory,
    port: undefined,
    variant: undefined,
    thinking: undefined,
    mini: true,
    interactive: false,
    replay: input.replay ?? true,
    "replay-limit": input.replayLimit,
    replayLimit: input.replayLimit,
    auto: false,
    yolo: false,
    "dangerously-skip-permissions": false,
    dangerouslySkipPermissions: false,
    local: undefined,
    "max-cost": undefined,
    maxCost: undefined,
    "max-steps": undefined,
    "stop-helpers": undefined,
    stopHelpers: undefined,
    size: undefined,
    judge: undefined,
    research: undefined,
    depth: undefined,
    search: undefined,
    scope: undefined,
    report: undefined,
    maxSteps: undefined,
    demo: input.demo ?? false,
  })
}
