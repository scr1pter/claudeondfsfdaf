import "@vectordevai/core/local-mode/backstop"
import { commandGate } from "./cli/command-gate"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand, runLocal } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { CodiumCommand } from "./cli/cmd/codium"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubSecrets } from "./cli/cmd/github.secrets"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { InviteCommand } from "./cli/cmd/invite"
import { PrCommand } from "./cli/cmd/pr"
import { ReviewCommand } from "./cli/cmd/review"
import { SessionCommand } from "./cli/cmd/session"
import { TasksCommand } from "./cli/cmd/tasks"
import { ConnectedCommand } from "./cli/cmd/connected"
import { WorkflowCommand } from "./cli/cmd/workflow"
import { PlaybooksCommand } from "./cli/cmd/playbooks"
import { DbCommand } from "./cli/cmd/db"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { VectorLoginCommand, VectorLogoutCommand, VectorWhoamiCommand } from "./cli/cmd/vector-login"
import { OrgCommand } from "./cli/cmd/org"
import { TrustCommand } from "./cli/cmd/trust"
import { MemoryCommand } from "./cli/cmd/memory"
import { VaultCommand } from "./cli/cmd/vault"
import { ShipCommand } from "./cli/cmd/ship"
import { LocalCommand } from "./cli/cmd/local"
import { Heap } from "./cli/heap"
import { disposeRuntimes } from "./effect/runtime-cleanup"
import { assertSecurityEnvironment } from "@vectordevai/core/flag/security"

const args = hideBin(process.argv)

declare const VECTOR_CLI_STANDALONE: boolean
// Every published native CLI preserves the free-account gate without depending on its launcher.
// The desktop embeds the server directly and does not use this CLI entrypoint.
const isVectorCli =
  (typeof VECTOR_CLI_STANDALONE === "boolean" && VECTOR_CLI_STANDALONE) || process.env.VECTOR_CLI === "1"

// Bun reports a write to a reader that has gone as an `error` event and then quietly reopens the
// stream, after which ending it never finishes. Remember the failure so flush() skips that stream,
// and rethrow when nothing else listens, which is what the event does when it has no listener.
const failedOutput = new Set<NodeJS.WriteStream>()
function rememberFailure(this: NodeJS.WriteStream, error: Error) {
  failedOutput.add(this)
  if (this.listenerCount("error") === 1) throw error
}
process.stdout.on("error", rememberFailure)
process.stderr.on("error", rememberFailure)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("vector ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

// Commands that must stay reachable without an account. `vector local` sets Vector Local up on a computer that may
// reach no vectordev.ai at all, so every `vector local` command is open; `vector run --local` is not.
// `vector ship` runs in a GitHub Actions job that holds only a Ship Desk capture ticket, never an account.
const openCommands = new Set([
  "login",
  "logout",
  "whoami",
  "org",
  "completion",
  "uninstall",
  "upgrade",
  "local",
  "ship",
])

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("vector")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    assertSecurityEnvironment()
    if (
      process.env.GITHUB_ACTIONS === "true" &&
      opts._?.[0] === "github" &&
      ["run", "review"].includes(String(opts._?.[1] ?? ""))
    ) {
      await GithubSecrets.assertNoDebugger()
    }
    if (opts.printLogs) process.env.VECTOR_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.VECTOR_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.VECTOR_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.VECTOR = "1"
    process.env.VECTOR_PID = String(process.pid)

    const command = String(opts._?.[0] ?? "")
    const subcommand = String(opts._?.[1] ?? "")
    const github = process.env.GITHUB_ACTIONS === "true" && command === "github"
    const control = github && ["mint", "bind", "sandbox", "publish"].includes(subcommand)
    if (control) {
      process.env.VECTOR_PURE = "1"
      process.env.VECTOR_DISABLE_PROJECT_CONFIG = "1"
    }
    if (
      !opts.help &&
      !opts.version &&
      github &&
      ["run", "review"].includes(subcommand) &&
      (process.env.VECTOR_SECRET_CHANNEL !== undefined || process.env.VECTOR_MODE === "codium")
    ) {
      process.env.VECTOR_PURE = "1"
      if (process.env.VECTOR_MODE === "codium") process.env.VECTOR_DISABLE_PROJECT_CONFIG = "1"
      await GithubSecrets.credentials.load()
    }
    await commandGate({
      options: opts,
      vector: isVectorCli || GithubSecrets.credentials.loaded(),
      accountRequired: !openCommands.has(command) && !control,
      githubActions: process.env.GITHUB_ACTIONS === "true",
      local: runLocal,
      account: async () => {
        const { ensureVectorAccount } = await import("./cli/vector-account")
        await ensureVectorAccount()
      },
    })
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ProvidersCommand)
  .command(OrgCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(InviteCommand)
  .command(ModelsCommand)
  .command(CodiumCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(ReviewCommand)
  .command(SessionCommand)
  .command(TasksCommand)
  .command(ConnectedCommand)
  .command(WorkflowCommand)
  .command(PlaybooksCommand)
  .command(PluginCommand)
  .command(DbCommand)
  .command(TrustCommand)
  .command(MemoryCommand)
  .command(VaultCommand)
  .command(ShipCommand)
  .command(LocalCommand)
  .fail((msg, err) => {
    if (msg) UI.error(msg)
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

if (isVectorCli) {
  cli.command(VectorLoginCommand).command(VectorLogoutCommand).command(VectorWhoamiCommand)
}

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  await disposeRuntimes().catch(() => {
    UI.error("Vector could not finish runtime cleanup.")
    process.exitCode = 1
  })
  // A pipe takes output only as fast as its reader reads, and process.exit() drops whatever is
  // still queued, so a late reader of `vector export <id> | jq` would get only the first 64 KB.
  await Promise.all([flush(process.stdout), flush(process.stderr)])
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}

// Bun queues piped stdio writes outside the Writable buffer: writableLength stays 0 and an empty
// write calls back at once, so neither shows pending output. Ending the stream runs Bun's flush of
// that queue. The bound stops a reader that stopped reading from holding the CLI open, and a
// terminal is left alone so the TUI can still restore it.
function flush(stream: NodeJS.WriteStream) {
  // From here a failed write only means the reader left early, which must not change the exit code.
  stream.off("error", rememberFailure)
  if (stream.isTTY || failedOutput.has(stream)) return
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    // Every write still queued can fail once the reader has gone, so keep listening.
    stream.on("error", done)
    stream.end(done)
  })
}
