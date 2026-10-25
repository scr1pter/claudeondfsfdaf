import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative } from "node:path"
import { StringDecoder } from "node:string_decoder"
import type { AgentChat } from "./parallel-workspace-turns"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { ExternalAgent } from "@vectordevai/schema/external-agent"
import {
  activityFromAgentLine,
  agentTurnFinished,
  costReader,
  createAgentChat,
  object,
  redactAgentOutput,
  reportedAgentError,
  sessionFromAgentLine,
  summaryFromAgentLine,
  textAt,
  workspaceRoots,
  type AgentTurnFinish,
} from "./external-agent-events"
import { Egress } from "@vectordevai/core/local-mode/egress"

import {
  fallbackBinDirectories,
  getUserShell,
  loadShellEnv,
  toolBinDirectories,
  unionPath,
  versionManagerBinDirectories,
} from "./shell-env"

// Detection + handoff plumbing for external coding agents/editors Vector can
// host or hand a task off to. Read-only probing (no shell:true, fixed
// binaries) so this never executes anything the user didn't already install.
// Which agents exist, and every command they take, comes from the one catalog
// in @vectordevai/schema/external-agent that the app reads too. Nothing here
// reads an agent's credential files or the keychain: sign-in state only ever
// comes from the agent's own status command.

export type ExternalAgentId = ExternalAgent.Id | "vscode"
export type CodingAgentRuntime = ExternalAgent.ChatId

// signedIn undefined means "could not tell", never "signed out": a picker that
// claims a working CLI is signed out is worse than one that stays quiet.
export type ExternalAgentStatus = ExternalAgent.Detection & { id: ExternalAgentId }

const VSCODE = { id: "vscode", name: "VS Code", cli: "code" } as const

export type AgentEnvironment = Record<string, string | undefined>

// A macOS app launched from Finder or the Dock inherits a bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so a CLI installed through nvm, fnm, mise,
// asdf, volta, pnpm or an npm prefix is invisible to Vector even though it runs
// fine in the user's terminal. Probe the login shell once — the same mechanism
// the engine sidecar uses in server.ts — and use it for detection *and* for
// spawning, so a runtime Vector can see is a runtime Vector can actually run.
let environment: AgentEnvironment | undefined

export function agentEnvironment(): AgentEnvironment {
  if (environment) return environment
  // loadShellEnv spawns the login shell synchronously, so this must happen once
  // per process rather than once per detection or per run.
  const loaded = process.platform === "win32" ? null : loadShellEnv(getUserShell(), console)
  environment = untrustedChildEnvironment(process.env, loaded ?? undefined, {
    // Union rather than replacement: the login shell knows where the user's
    // tools live, the app environment knows what Electron's own helpers need,
    // and the install directories cover a probe that came back empty. A CLI
    // found under ~/.nvm is a `#!/usr/bin/env node` shim, so the directory it
    // lives in has to be on the PATH it is spawned with, not just searched.
    PATH: unionPath([loaded?.PATH, process.env.PATH, ...fallbackBinDirectories({ ...process.env, ...loaded })]),
  })
  return environment
}

// Probes the login shell again, for an explicit re-check after the user
// installed something: the cached environment still holds the PATH from launch.
export function refreshAgentEnvironment() {
  environment = undefined
  return agentEnvironment()
}

function pathSeparator(platform: NodeJS.Platform) {
  return platform === "win32" ? ";" : ":"
}

export function executableNames(cli: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return [cli]
  // npm, pnpm and yarn install Windows CLIs as shims. `.exe` comes first because
  // Node can spawn it directly; a shim needs cmd.exe (see shimmedCommand).
  return [`${cli}.exe`, `${cli}.cmd`, `${cli}.bat`, `${cli}.ps1`, cli]
}

// Every path Vector will look at for `cli`, in preference order: the user's own
// PATH first, then the places package and version managers actually install to.
// `machineFolders: false` keeps the search to the environment's own PATH and the
// folders under its own HOME, leaving out this machine's fixed system and app
// folders (/opt/homebrew/bin, /usr/local/bin, /Applications/…), which no
// environment names.
export async function agentCandidatePaths(
  cli: string,
  env: AgentEnvironment = agentEnvironment(),
  platform: NodeJS.Platform = process.platform,
  machineFolders = true,
) {
  const onPath = (env.PATH ?? "").split(pathSeparator(platform)).filter(Boolean)
  const home = env.HOME || env.USERPROFILE
  const directories = [
    ...new Set([
      ...onPath,
      ...toolBinDirectories(env, platform),
      ...editorBundleDirectories(cli, env, platform),
      ...versionManagerBinDirectories(env, platform),
    ]),
  ].filter((directory) => machineFolders || onPath.includes(directory) || (home ? within(home, directory) : false))
  return directories.flatMap((directory) => executableNames(cli, platform).map((name) => join(directory, name)))
}

function within(root: string, path: string) {
  const inside = relative(root, path)
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)
}

async function isExecutableFile(path: string) {
  const executable = await access(path, constants.X_OK)
    .then(() => true)
    .catch(() => false)
  if (!executable) return false
  // access(X_OK) also succeeds for a directory, so a folder that happens to be
  // named `code` (or `claude`) on PATH would otherwise be reported as an
  // installed CLI and then fail to spawn. stat follows symlinks, so the usual
  // homebrew/npm symlink-to-binary still counts as a file.
  return await stat(path)
    .then((stats) => stats.isFile())
    .catch(() => false)
}

export async function resolveAgentPath(
  cli: string,
  env: AgentEnvironment = agentEnvironment(),
  platform: NodeJS.Platform = process.platform,
  machineFolders = true,
) {
  const candidates = await agentCandidatePaths(cli, env, platform, machineFolders)
  // Checked in parallel — a serial walk over this many directories is slow
  // enough to show up in the picker — but order still decides the winner.
  const found = await Promise.all(candidates.map(async (path) => ((await isExecutableFile(path)) ? path : undefined)))
  return found.find((path): path is string => Boolean(path))
}

// Editors ship their shell command inside the bundle, and the ChatGPT app
// ships codex. The generic package-manager directories live in shell-env.ts so
// the engine sidecar's PATH and this detection agree on where tools install.
function editorBundleDirectories(cli: string, env: AgentEnvironment, platform: NodeJS.Platform) {
  const home = env.HOME || env.USERPROFILE || homedir()
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local")
    return [
      join(home, ".cursor", "bin"),
      ...cursorBundleDirectories(cli, [join(localAppData, "Programs", "cursor", "resources", "app", "bin")]),
      join(localAppData, "Programs", "Microsoft VS Code", "bin"),
    ]
  }
  return [
    join(home, ".cursor", "bin"),
    ...(platform === "darwin"
      ? [
          "/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
          ...cursorBundleDirectories(cli, ["/Applications/Cursor.app/Contents/Resources/app/bin"]),
          "/Applications/ChatGPT.app/Contents/Resources",
        ]
      : []),
  ]
}

// Cursor's bundle ships its own `code` command alongside `cursor`. Searching the
// bundle for `code` reports "VS Code installed" — at Cursor's version number —
// on a machine that has no VS Code, and then opens Cursor when the user picks
// VS Code. Ordering VS Code first only helps when both are installed, so the
// bundle answers for Cursor's own commands only. A `code` the user deliberately
// installed onto PATH still wins, because PATH is searched first.
function cursorBundleDirectories(cli: string, directories: string[]) {
  return cli === "code" ? [] : directories
}

export type CliResult = { stdout: string; stderr: string; failed: boolean }

// Runs a CLI resolveAgentPath found and collects its output. A Windows .cmd/.bat shim goes through cmd.exe
// (shimmedCommand), since Node refuses to spawn one directly. Node throws spawn errors other than the ENOENT-like ones
// synchronously instead of passing them to the callback (EINVAL for a shim, EFTYPE for a .ps1), and a CLI that cannot
// start is a failed run, not an exception that takes every other probe down with it.
export function runCli(path: string, args: string[], timeoutMs: number, env?: AgentEnvironment) {
  const launch = shimmedCommand(path, args)
  return new Promise<CliResult>((resolve) => {
    try {
      execFile(
        launch.command,
        launch.args,
        { timeout: timeoutMs, maxBuffer: 1024 * 1024, env, windowsVerbatimArguments: launch.windowsVerbatimArguments },
        (error, stdout, stderr) => {
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: Boolean(error) })
        },
      )
    } catch (error) {
      resolve({ stdout: "", stderr: error instanceof Error ? error.message : String(error), failed: true })
    }
  })
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

// `claude auth status` prints JSON; `codex login status` prints a sentence. The
// negative test runs first because "not logged in" contains "logged in".
const LOGGED_IN_FLAG = /"loggedIn"\s*:\s*(true|false)/i

export function signedInFromProbe(output: string) {
  const flag = LOGGED_IN_FLAG.exec(output)
  if (flag) return flag[1]?.toLowerCase() === "true"
  if (/\bnot logged in\b|\blogged out\b|\bno credentials\b|\bplease run\b.*\blogin\b/i.test(output)) return false
  if (/\blogged in\b|\bauthenticated\b/i.test(output)) return true
  return undefined
}

// `kilo auth list` names providers and ends on a total such as "2 credentials".
// Only the total is read. A zero next to keys taken from the environment is
// still a working setup, so that case stays unknown rather than signed out.
export function signedInFromCredentialCount(output: string) {
  const total = /\b(\d+)\s+credentials?\b/i.exec(output)
  if (!total) return undefined
  if (Number(total[1]) > 0) return true
  return /\benvironment\b/i.test(output) ? undefined : false
}

// `env` is the test seam. An injected environment is searched on its own: its
// PATH and the folders under its HOME, never this machine's fixed system and app
// folders, so a test can only ever find, and then probe, the CLIs it put there
// itself, and never a real agent signed in to a real account.
export type AgentLookup = { env?: AgentEnvironment; platform?: NodeJS.Platform }

// The first of the agent's binaries that is on this machine and is really this
// agent: a generic name such as Cursor's `agent` must also print Cursor's own
// version, and a same-named unrelated tool is skipped. The version comes from
// the same environment the real run gets, since Node-based CLIs are shims that
// need their own runtime on PATH.
export async function findAgentBinary(agent: ExternalAgent.Agent, lookup: AgentLookup = {}, readVersion = false) {
  const env = lookup.env ?? agentEnvironment()
  for (const binary of agent.binaries) {
    const path = await resolveAgentPath(binary.name, env, lookup.platform, !lookup.env)
    if (!path) continue
    // A run only needs the path; the version is spawned for detection and for a name that needs confirming.
    if (!readVersion && !binary.version && !binary.notVersion) return { binary, path, version: undefined }
    const result = await runCli(path, ["--version"], 5_000, env)
    const output = `${result.stdout}\n${result.stderr}`
    if (binary.version && (result.failed || !new RegExp(binary.version).test(output))) continue
    if (binary.notVersion && new RegExp(binary.notVersion, "i").test(output)) continue
    const version = result.failed ? undefined : (firstLine(result.stdout) ?? firstLine(result.stderr))
    return { binary, path, version }
  }
  return undefined
}

// A CLI can be installed, report a version, and still refuse every run because
// nobody signed in. Only an agent that documents a local status command is
// probed; that probe never reaches a model, and it is parsed even when it exits
// non-zero, since a signed-out CLI may report that with a failing exit code.
async function detectAgent(agent: ExternalAgent.Agent, lookup: AgentLookup): Promise<ExternalAgentStatus> {
  const base = { id: agent.id as ExternalAgent.Id, name: agent.name, cli: agent.binaries[0]!.name, tier: agent.tier }
  const found = await findAgentBinary(agent, lookup, true)
  if (!found) return { ...base, state: "not-installed", installed: false }
  const probe = agent.statusProbe
  const auth = probe ? await runCli(found.path, [...probe.args], 5_000, lookup.env ?? agentEnvironment()) : undefined
  const output = auth ? `${auth.stdout}\n${auth.stderr}` : ""
  const signedIn = !probe
    ? undefined
    : probe.read === "logged-in"
      ? signedInFromProbe(output)
      : signedInFromCredentialCount(output)
  return {
    ...base,
    cli: found.binary.name,
    state: signedIn === undefined ? "unknown" : signedIn ? "ready" : "signed-out",
    installed: true,
    version: found.version,
    path: found.path,
    signedIn,
  }
}

async function detectEditor(lookup: AgentLookup): Promise<ExternalAgentStatus> {
  const env = lookup.env ?? agentEnvironment()
  const path = await resolveAgentPath(VSCODE.cli, env, lookup.platform, !lookup.env)
  if (!path) return { ...VSCODE, tier: "editor", state: "not-installed", installed: false }
  const result = await runCli(path, ["--version"], 5_000, env)
  const version = result.failed ? undefined : (firstLine(result.stdout) ?? firstLine(result.stderr))
  return { ...VSCODE, tier: "editor", state: "ready", installed: true, version, path }
}

// Detection touches the filesystem and spawns a `--version` probe per candidate;
// cache the result briefly so a re-render (or several) doesn't repeat the work.
// `refresh` is the re-check after an install or sign-in: it probes the login
// shell again (an installer may have changed PATH) and skips the cache. An
// injected environment (the test seam) is never cached.
const CACHE_TTL_MS = 60_000
let cache: { at: number; result: ExternalAgentStatus[] } | undefined

export async function detectExternalAgents(
  options: { refresh?: boolean } & AgentLookup = {},
): Promise<ExternalAgentStatus[]> {
  if (!options.env && !options.refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result
  // A refresh replaces the shared environment rather than injecting one, so it still searches the machine's folders.
  if (options.refresh && !options.env) refreshAgentEnvironment()
  const lookup = { env: options.env, platform: options.platform }
  // One candidate that cannot be probed must not hide the others.
  const result = await Promise.all([
    ...ExternalAgent.catalog.map((agent) =>
      detectAgent(agent, lookup).catch(
        (): ExternalAgentStatus => ({
          id: agent.id,
          name: agent.name,
          cli: agent.binaries[0].name,
          tier: agent.tier,
          state: "not-installed",
          installed: false,
        }),
      ),
    ),
    detectEditor(lookup).catch(
      (): ExternalAgentStatus => ({ ...VSCODE, tier: "editor", state: "not-installed", installed: false }),
    ),
  ])
  if (!options.env) cache = { at: Date.now(), result }
  return result
}

export function catalogPlatform(platform: NodeJS.Platform): ExternalAgent.Platform {
  return platform === "win32" || platform === "darwin" ? platform : "linux"
}

function requireAgent(id: unknown) {
  const agent = typeof id === "string" ? ExternalAgent.find(id) : undefined
  if (!agent) throw new Error("Choose an agent from the list.")
  return agent
}

// Live model lists ask the installed CLI (Cursor's needs its sign-in and the
// network), so each answer is kept for ten minutes and a failure for one, and
// two pickers opening at once share one spawn. A failure falls back to the
// catalog's list with the reason, so the picker always has its rows.
const MODELS_TTL_MS = 10 * 60_000
const MODELS_FAILURE_TTL_MS = 60_000
const modelCache = new Map<string, { expires: number; list: Promise<ExternalAgent.ModelList> }>()

export async function listAgentModels(
  id: unknown,
  options: { refresh?: boolean; timeoutMs?: number } & AgentLookup = {},
): Promise<ExternalAgent.ModelList> {
  const agent = requireAgent(id)
  const models = agent.models
  if (models.kind === "none") return { id: agent.id, source: "none", models: [] }
  if (models.kind === "fixed") return { id: agent.id, source: "catalog", models: models.models }
  const cached = modelCache.get(agent.id)
  if (!options.env && !options.refresh && cached && cached.expires > Date.now()) return cached.list
  const list = (async (): Promise<ExternalAgent.ModelList> => {
    const fallback = { id: agent.id, source: "catalog" as const, models: models.fallback }
    const env = options.env ?? agentEnvironment()
    const found = await findAgentBinary(agent, { env: options.env, platform: options.platform })
    if (!found) return { ...fallback, error: `${agent.name} is not installed.` }
    const result = await runCli(
      found.path,
      [...models.args],
      options.timeoutMs ?? 15_000,
      untrustedChildEnvironment(env, { NO_COLOR: "1", FORCE_COLOR: "0" }),
    )
    const listed = result.failed ? [] : modelsFromOutput(result.stdout, models.read)
    if (listed.length) return { id: agent.id, source: "live", models: listed }
    return { ...fallback, error: `${agent.name} did not list its models, so Vector shows its own list.` }
  })()
  if (options.env) return list
  modelCache.set(agent.id, { expires: Date.now() + MODELS_TTL_MS, list })
  void list.then(
    (value) => {
      if (value.source !== "live") modelCache.set(agent.id, { expires: Date.now() + MODELS_FAILURE_TTL_MS, list })
    },
    () => modelCache.delete(agent.id),
  )
  return list
}

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
// "<id>" or "<id> - <name>", optionally followed by Cursor's "(current, default)".
const MODEL_LINE_PATTERN =
  /^\s*(?:[-*•]\s+)?(\S+?)(?:\s+-\s+(.+?))?(?:\s+\((?:current|default)(?:,\s*(?:current|default))*\))?\s*$/

// A model list a CLI printed, as plain rows: JSON (an array, or an object with
// `models` or `data`) when asked for, otherwise one model per line. Only values
// externalModelValue would pass on survive, and a bare word needs a digit, dash,
// dot or slash so a heading such as "Models" is never read as a model.
export function modelsFromOutput(output: string, read: "lines" | "json-or-lines") {
  const text = output.replace(ANSI_PATTERN, "")
  const parsed = read === "json-or-lines" ? modelsFromJson(text) : undefined
  const rows =
    parsed ??
    text.split(/\r?\n/).flatMap((line) => {
      const match = MODEL_LINE_PATTERN.exec(line)
      if (!match?.[1]) return []
      if (!match[2] && !/[\d./-]/.test(match[1])) return []
      return [{ id: match[1], name: match[2]?.trim() || match[1] }]
    })
  const valid = rows.filter((row) => MODEL_VALUE_PATTERN.test(row.id) && !/[.:]$/.test(row.id))
  return [...new Map(valid.map((row) => [row.id, row])).values()].slice(0, 500)
}

function modelsFromJson(text: string) {
  const trimmed = text.trim()
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return undefined
  const value = jsonValue(trimmed)
  const items = Array.isArray(value) ? value : [object(value).models, object(value).data].find(Array.isArray)
  if (!Array.isArray(items)) return undefined
  return items.flatMap((item) => {
    if (typeof item === "string") return [{ id: item, name: item }]
    const id = textAt(item, ["id", "slug", "model"])
    return id ? [{ id, name: textAt(item, ["display_name", "displayName", "name"]) ?? id }] : []
  })
}

function jsonValue(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// Everything the built-in terminal runs goes through one visible shell: sh on
// macOS and Linux, PowerShell on Windows. When the command ends, the terminal
// stays open on its exit status until the user presses Enter, so an installer's
// or a sign-in's last words are never lost. Only PATH is passed: the engine's
// terminal already starts from a filtered environment, and Vector's login-shell
// PATH is what makes a just-installed CLI and its Node runtime findable. Windows
// has no login-shell PATH to add, and a second PATH beside its own Path would
// make the variable ambiguous, so nothing is passed there. The PowerShell
// script goes as -EncodedCommand (base64 of its UTF-16LE text, as open-path.ts
// does): a vendor command that nests its own double quotes, such as Codex's
// `powershell -ExecutionPolicy ByPass -c "irm … | iex"`, then reaches
// PowerShell as written, whatever quoting the Windows command line applies.
// An agent's own screen also takes `pidFile`: the shell writes its process id there before the agent starts and
// removes it once the agent ends, which is how runningTerminalAgents counts the agents open in a terminal.
export function terminalLaunch(input: {
  title: string
  display: string
  line: string
  cwd: string
  env: AgentEnvironment
  platform: ExternalAgent.Platform
  pidFile?: string
}): ExternalAgent.TerminalLaunch {
  const env: Record<string, string> = input.platform !== "win32" && input.env.PATH ? { PATH: input.env.PATH } : {}
  if (input.platform === "win32") {
    const marker = input.pidFile && `'${input.pidFile.replace(/'/g, "''")}'`
    const script = [
      marker ? `Set-Content -LiteralPath ${marker} -Value $PID -NoNewline` : "",
      input.line,
      "$code = $LASTEXITCODE",
      marker ? `Remove-Item -LiteralPath ${marker} -ErrorAction SilentlyContinue` : "",
      "Write-Host ''",
      "Read-Host 'Finished. Press Enter to close this terminal' | Out-Null",
      "exit $code",
    ]
      .filter(Boolean)
      .join("\n")
    return {
      title: input.title,
      display: input.display,
      command: "powershell.exe",
      args: ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      cwd: input.cwd,
      env,
    }
  }
  const marker = input.pidFile && `'${input.pidFile.replace(/'/g, `'\\''`)}'`
  const script = [
    marker ? `printf '%s' "$$" > ${marker}` : "",
    input.line,
    "status=$?",
    marker ? `rm -f ${marker}` : "",
    "printf '\\n'",
    `if [ "$status" -eq 0 ]; then printf '%s' 'Finished. Press Enter to close this terminal.'; else printf 'Exited with code %s. Press Enter to close this terminal.' "$status"; fi`,
    "read -r _",
    'exit "$status"',
  ]
    .filter(Boolean)
    .join("\n")
  // The engine's terminal starts sh with exactly these arguments: it adds -l only to a shell started with none.
  return { title: input.title, display: input.display, command: "/bin/sh", args: ["-c", script], cwd: input.cwd, env }
}

// A resolved binary and its arguments as one shell line, every word quoted, so
// a path with spaces or a model id reaches the CLI as itself.
export function commandLine(path: string, args: readonly string[], platform: ExternalAgent.Platform) {
  if (platform === "win32") return `& ${[path, ...args].map((word) => `'${word.replace(/'/g, "''")}'`).join(" ")}`
  return [path, ...args].map((word) => `'${word.replace(/'/g, `'\\''`)}'`).join(" ")
}

// Installs and sign-ins run in an empty folder of Vector's own, never in a
// repository: an installer may download a script into its working directory,
// and an agent opened only to sign in has no business reading the user's files.
async function setupDirectory() {
  const { app } = await import("electron")
  const directory = join(app.getPath("userData"), "external-agent-setup")
  await mkdir(directory, { recursive: true })
  return directory
}

// The official install commands for this platform and the agent's own sign-in,
// each ready for the built-in terminal. Nothing here runs anything: the app
// shows the command, and only the user's "Run in terminal" starts it.
export async function agentCommands(
  id: unknown,
  options: { directory?: string } & AgentLookup = {},
): Promise<ExternalAgent.Commands> {
  const agent = requireAgent(id)
  const platform = catalogPlatform(options.platform ?? process.platform)
  const env = options.env ?? agentEnvironment()
  const cwd = options.directory ?? (await setupDirectory())
  const found = await findAgentBinary(agent, { env: options.env, platform: options.platform })
  const display = found ? ExternalAgent.signInCommand(agent, found.binary.name) : undefined
  return {
    id: agent.id,
    platform,
    docsUrl: agent.docsUrl,
    install: ExternalAgent.installFor(agent, platform).map((option) => ({
      ...option,
      launch: terminalLaunch({
        title: `Install ${agent.name}`,
        display: option.command,
        line: option.command,
        cwd,
        env,
        platform,
      }),
    })),
    signIn:
      found && display
        ? {
            display,
            interactive: agent.signIn.interactive,
            hint: agent.signIn.hint,
            launch: terminalLaunch({
              title: `Sign in to ${agent.name}`,
              display,
              line: commandLine(found.path, agent.signIn.args, platform),
              cwd,
              env,
              platform,
            }),
          }
        : undefined,
  }
}

export type TerminalAgentInput = { id: string; projectPath: string; model?: string }

// A terminal-tier run: the same isolated checkout a chat run gets, with the
// agent's own screen opened in it, on the chosen model where it has a flag.
// `chatRunning` is how many of the user's agents are running in Vector's chat;
// with the ones open in a terminal they may not pass ExternalAgent.MAX_RUNNING.
// `runs` is the folder of isolated runs, the test seam for that count.
export function launchAgentTerminal(...args: Parameters<typeof prepareAgentTerminal>) {
  return serializeExternalAgentStart(() => prepareAgentTerminal(...args))
}

async function prepareAgentTerminal(
  input: TerminalAgentInput,
  options: {
    prepare?: (projectPath: string) => Promise<PrepareWorkspaceResult>
    chatRunning?: number | (() => number)
    runs?: string
  } & AgentLookup = {},
): Promise<ExternalAgent.TerminalAgentLaunch> {
  const agent = requireAgent(input?.id)
  const args = ExternalAgent.interactiveArguments(agent, externalModelValue(input.model))
  const platform = catalogPlatform(options.platform ?? process.platform)
  const env = options.env ?? agentEnvironment()
  const found = await findAgentBinary(agent, { env: options.env, platform: options.platform })
  if (!found) throw new Error(`${agent.name} is not installed, or Vector can't find it.`)
  const running = typeof options.chatRunning === "function" ? options.chatRunning() : (options.chatRunning ?? 0)
  if (running + (await runningTerminalAgents(options.runs)) >= ExternalAgent.MAX_RUNNING)
    throw new Error(ExternalAgent.RUN_LIMIT_MESSAGE)
  const workspace = await (options.prepare ?? prepareWorkspace)(input.projectPath)
  // Hold the slot while the renderer opens the terminal. Its shell replaces this short-lived reservation with its PID.
  await writeFile(
    join(dirname(workspace.path), TERMINAL_AGENT_MARKER),
    JSON.stringify({ pendingUntil: Date.now() + 60_000 }),
  )
  return {
    workspace,
    launch: terminalLaunch({
      title: agent.name,
      display: [found.binary.name, ...args].join(" "),
      line: commandLine(found.path, args, platform),
      cwd: workspace.path,
      env,
      platform,
      pidFile: join(dirname(workspace.path), TERMINAL_AGENT_MARKER),
    }),
  }
}

// Admission is serialized across chat and terminal launches, so simultaneous sends cannot claim the same last slot.
let agentStarts: Promise<unknown> = Promise.resolve()

export function serializeExternalAgentStart<T>(start: () => Promise<T>): Promise<T> {
  const next = agentStarts.then(start)
  agentStarts = next.catch(() => undefined)
  return next
}

// Written by the terminal's shell beside an agent's isolated checkout while the agent runs (terminalLaunch).
const TERMINAL_AGENT_MARKER = "terminal-agent.pid"

// The user's agents open in a terminal right now: every run whose marker names a shell that is still alive. A shell
// that was closed with the agent still in it never removed its marker, so a dead one is cleared here instead.
export async function runningTerminalAgents(runs?: string) {
  const directory = runs ?? (await runsDirectory())
  const entries = await readdir(directory).catch(() => [] as string[])
  const live = await Promise.all(
    entries.map(async (entry) => {
      const marker = join(directory, entry, TERMINAL_AGENT_MARKER)
      const value = (await readFile(marker, "utf8").catch(() => "")).trim()
      const pending = /^\{"pendingUntil":(\d+)\}$/.exec(value)
      if (pending && Number(pending[1]) > Date.now()) return true
      const pid = Number(value)
      if (!Number.isInteger(pid) || pid <= 0) {
        if (pending) await rm(marker, { force: true }).catch(() => undefined)
        return false
      }
      if (processAlive(pid)) return true
      await rm(marker, { force: true }).catch(() => undefined)
      return false
    }),
  )
  return live.filter(Boolean).length
}

// Signal 0 only asks whether the process exists. EPERM means it does, under another user.
function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export type OpenInEditorApp = "cursor" | "vscode"

export type OpenInEditorInput = { app: OpenInEditorApp; path: string }

export type OpenInEditorResult = { ok: boolean; error?: string }

const EDITOR_CLIS: Record<OpenInEditorApp, string> = { cursor: "cursor", vscode: "code" }

// Node refuses to run a .cmd/.bat shim directly (the CVE-2024-27980 fix) and
// every Windows install ships one — npm's global CLIs, and VS Code's and
// Cursor's own `bin\code.cmd` — so those go through cmd.exe with an
// already-quoted command line. shell:true would re-split the prompt.
export function shimmedCommand(path: string, args: string[], platform: NodeJS.Platform = process.platform) {
  if (!runsThroughCmd(path, platform)) {
    return { command: path, args, windowsVerbatimArguments: false }
  }
  const quoted = [path, ...args].map((value) => `"${value.replace(/"/g, '""')}"`).join(" ")
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${quoted}"`],
    windowsVerbatimArguments: true,
  }
}

export function runsThroughCmd(path: string, platform: NodeJS.Platform = process.platform) {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(path)
}

export async function openInEditor(input: OpenInEditorInput): Promise<OpenInEditorResult> {
  const path = input?.path?.trim()
  if (!path) return { ok: false, error: "Choose a file or folder to open." }
  const stats = await stat(path).catch(() => undefined)
  if (!stats) return { ok: false, error: `"${path}" does not exist.` }

  const cli = EDITOR_CLIS[input.app]
  const executable = await resolveAgentPath(cli)
  if (!executable) return { ok: false, error: `Couldn't find the \`${cli}\` command. Install its shell command first.` }
  const launch = shimmedCommand(executable, [path])
  return new Promise((resolve) => {
    // The cursor/code CLIs hand off to the editor app and exit almost
    // immediately, so the launched editor never becomes Vector's child.
    const child = execFile(
      launch.command,
      launch.args,
      {
        timeout: 10_000,
        env: agentEnvironment(),
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      },
      (error: Error | null) => {
        resolve(error ? { ok: false, error: `Couldn't launch ${cli}. ${error.message}` } : { ok: true })
      },
    )
    child.unref()
  })
}

// Directories that never belong in an isolated agent checkout — heavyweight or
// machine-specific state that a headless agent should regenerate itself.
const WORKSPACE_EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".vercel",
])

const RUNS_DIRECTORY_NAME = "external-agent-runs"

// Imported here so detection and run classification stay testable outside Electron; the runs directory is what in
// this file needs app.
async function runsDirectory() {
  const { app } = await import("electron")
  return join(app.getPath("userData"), RUNS_DIRECTORY_NAME)
}

export type PrepareWorkspaceResult = { path: string; isolation: "git-worktree" | "copy" }

function runIn(command: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<CliResult>((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: agentEnvironment() },
      (error, stdout, stderr) => {
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: Boolean(error) })
      },
    )
  })
}

async function gitTopLevel(cwd: string): Promise<string | undefined> {
  const result = await runIn("git", ["rev-parse", "--show-toplevel"], cwd, 5_000)
  if (result.failed) return undefined
  return firstLine(result.stdout)
}

async function gitTreeClean(cwd: string): Promise<boolean> {
  const result = await runIn("git", ["status", "--porcelain"], cwd, 5_000)
  return !result.failed && result.stdout.trim().length === 0
}

async function copyProjectTree(source: string, target: string) {
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, {
    recursive: true,
    dereference: false,
    filter: (entry) => !entry.split(/[\\/]/).some((part) => WORKSPACE_EXCLUDED_DIRS.has(part)),
  })
}

// Create an isolated working directory for a single external-agent run so the
// headless agent edits a checkout, never the user's live project. Prefers a git
// worktree (cheap, shares history) when the tree is a clean repo, and falls back
// to an excluded-dir copy for non-git or dirty trees — mirrors the isolation
// strategy in parallel-workspaces.ts, kept minimal for a one-shot run.
export async function prepareWorkspace(projectPath: string): Promise<PrepareWorkspaceResult> {
  const path = projectPath?.trim()
  if (!path) throw new Error("Open a repository before running an external agent.")
  const stats = await stat(path).catch(() => undefined)
  if (!stats?.isDirectory()) throw new Error(`"${path}" is not a folder Vector can run an agent in.`)

  const runId = randomUUID()
  const runRoot = join(await runsDirectory(), runId)
  const isolatedPath = join(runRoot, "workspace")
  await mkdir(runRoot, { recursive: true })

  const gitRoot = await gitTopLevel(path)
  if (gitRoot && (await gitTreeClean(gitRoot))) {
    const branch = `vector-agent/${runId.slice(0, 8)}`
    const worktree = await runIn("git", ["worktree", "add", "-b", branch, isolatedPath, "HEAD"], gitRoot, 30_000)
    if (!worktree.failed) return { path: isolatedPath, isolation: "git-worktree" }
    // A failed worktree can leave a partial checkout behind; clear it before
    // falling back to a plain copy so the copy starts from a clean directory.
    await rm(isolatedPath, { recursive: true, force: true }).catch(() => undefined)
  }

  await copyProjectTree(gitRoot ?? path, isolatedPath)
  return { path: isolatedPath, isolation: "copy" }
}

export type ExternalAgentEvent = {
  stream: "activity" | "stdout" | "stderr"
  text: string
}

export type ExternalAgentRunResult = {
  exitCode: number
  summary: string
  error?: string
  actualCost?: string
  sessionId?: string
  resumeRejected?: boolean
  // The CLI refused the model it was given, as opposed to failing the task.
  modelRejected?: boolean
  // What the CLI printed about its sign-in, plan or usage beside a run that worked, as it wrote it.
  notices?: string[]
  output: string[]
}

export type RunExternalAgentInput = {
  runtime: CodingAgentRuntime
  cwd: string
  prompt: string
  resumeSessionId?: string
  // The value for the CLI's own model flag. Unset runs the model the CLI is
  // configured to use, with no flag at all.
  model?: string
  signal?: AbortSignal
  onEvent?: (event: ExternalAgentEvent) => void
  onChat?: (chat: AgentChat) => void
  // Fires at most once per run, the moment the id first appears on the stream.
  // A field on ExternalAgentEvent would arrive duplicated, because emitLine
  // fires onEvent twice per line — once raw, once as derived activity.
  onSessionId?: (sessionId: string) => void
  // Overrides the memoized login-shell environment. agentEnvironment() reads
  // the real machine once per process, so without this seam no test can point
  // a run at a fake CLI.
  env?: AgentEnvironment
  // Defaults to thirty minutes so a wedged CLI cannot hold a parallel slot and
  // continue consuming resources forever. The grace override exists for the
  // process-lifecycle regression test; production keeps the five-second grace.
  timeoutMs?: number
  killGraceMs?: number
  // How long a CLI that already printed its turn's final event may keep
  // running before Vector stops it: codex-cli 0.154 lingers about 11 s after
  // turn.completed. The grace lets a CLI that exits by itself finish saving its
  // session. Tests shorten it.
  finishGraceMs?: number
}

// The chat agents that can read their task from stdin, which is how a prompt
// survives a Windows command script: "Claude Code, Codex, … or Qwen Code".
const STDIN_AGENTS = ExternalAgent.chatIds
  .map((id) => ExternalAgent.find(id)!)
  .filter((agent) => agent.headless?.stdinPrompt)
  .map((agent) => agent.name)
  .join(", ")
  .replace(/, ([^,]*)$/, " or $1")

// The catalog entry for a runtime Vector runs in its own chat. A terminal-only
// agent never reaches a headless spawn, whatever the renderer sent.
// The variables an agent's headless run must start without, such as pi's ANTHROPIC_OAUTH_TOKEN. Matched by name only,
// case-insensitively as Windows names are, so no value is ever read.
function withoutVariables(env: AgentEnvironment, names: readonly string[] | undefined) {
  if (!names?.length) return env
  const unset = new Set(names.map((name) => name.toUpperCase()))
  return Object.fromEntries(Object.entries(env).filter(([key]) => !unset.has(key.toUpperCase())))
}

export function chatAgent(runtime: string) {
  const agent = ExternalAgent.find(runtime)
  if (!agent) throw new Error(`"${runtime.slice(0, 40)}" is not an agent Vector can run.`)
  if (agent.tier !== "chat" || !agent.headless) throw new Error(`${agent.name} runs in Vector's terminal only.`)
  return agent
}

// The headless argv comes from the catalog, where each runtime's resume form is
// its own template: `codex exec resume` rejects --sandbox and -C outright. With
// promptOnStdin the prompt is left out of argv for the caller to write to stdin:
// `claude -p` with no prompt argument, and codex's `-` prompt, read it from
// there. `model` goes to each CLI's own flag, always before the prompt or
// session id that ends the argv; without it the CLI runs the model it is set to
// use. externalModelValue keeps quotes out of the TOML codex resume is given.
export function runtimeArguments(
  runtime: CodingAgentRuntime,
  cwd: string,
  prompt: string,
  resumeSessionId?: string,
  promptOnStdin = false,
  model?: string,
) {
  return ExternalAgent.headlessArguments(chatAgent(runtime), {
    prompt,
    cwd,
    model,
    session: resumeSessionId,
    promptOnStdin,
  })
}

// What a model value may look like before it reaches a CLI: a name, alias or
// full id, optionally with Cursor's bracketed parameters
// (`claude-opus-4-8[context=1m,effort=high]`) or Claude Code's `sonnet[1m]`. A
// leading dash would read as a flag, a quote would break the TOML Codex is
// given on resume, and cmd.exe treats `%`, `^` and `&` as syntax.
const MODEL_VALUE_PATTERN = /^[A-Za-z0-9][\w.:/@-]{0,127}(?:\[[\w.,=-]{1,128}\])?$/

// The model a run passes to its CLI: undefined runs the CLI's own default.
export function externalModelValue(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new Error("Choose a model from the list.")
  const model = value.trim()
  if (!model) return undefined
  if (!MODEL_VALUE_PATTERN.test(model))
    throw new Error(`"${model.slice(0, 80)}" is not a model name Vector can pass on.`)
  return model
}

// A resume the CLI itself refused, as opposed to a task that failed. Only
// consulted when a resume id was actually passed, so an unrelated "unknown
// option" inside agent output cannot silently downgrade a working conversation.
// Gemini CLI says "Invalid session identifier" or "No previous sessions found",
// Qwen Code "No saved session found with ID".
const RESUME_REJECTED_PATTERN =
  /unexpected argument|unknown (?:option|command)|unrecognized (?:option|argument)|invalid (?:option|argument)|no conversation found|session id .*(?:not found|already in use)|invalid session identifier|no previous sessions found|no saved session found/i

// What a signed-out CLI says instead of doing the work. Only ever matched
// against a line the runtime already flagged as an error, so a file the agent
// happens to edit that mentions "unauthorized" can't trip it. Gemini CLI with
// no sign-in at all asks to "set an Auth method".
const SIGNED_OUT_PATTERN =
  /not logged ?in|not (?:signed|authenticated)|log ?in required|login required|please run \/?login|run `?[\w-]+ login|unauthorized|\b401\b|invalid api key|no credentials|credentials (?:are )?(?:missing|expired)|(?:token|session) (?:has )?expired|set an auth method/i

// The CLI's own words for a model it will not run: Claude Code's "issue with
// the selected model ... may not exist", Codex's "model is not supported", or
// Cursor's "Cannot use this model". Only consulted when Vector passed a model,
// and only against the error the run already reported, so a task about model
// validation cannot reset the user's choice.
const MODEL_REJECTED_PATTERN =
  /\bmodel\b[^\n]{0,160}?(?:not found|not available|unavailable|unknown|invalid|not supported|unsupported|not exist|no access|not have access|not allowed|not enabled)|(?:unknown|invalid|unsupported|unavailable|cannot use|can't use|no access to)[^\n]{0,60}?\bmodel\b|not_found_error[^\n]{0,80}?\bmodel\b/i

export function modelRejected(model: string | undefined, outcome: AgentOutcome) {
  return Boolean(model) && outcome.exitCode !== 0 && MODEL_REJECTED_PATTERN.test(outcome.error ?? "")
}

// What an agent says about the account it runs on: its sign-in, its plan's usage limits, extra usage, quotas, credits
// and billing. Those words are the user's to read and act on, so Vector passes them on as the agent wrote them and
// never rewords, shortens or retries around them.
const ACCOUNT_MESSAGE_PATTERN =
  /usage limit|limit (?:reached|exceeded|resets?)|rate.?limit|too many requests|quota|extra usage|overage|out of (?:credits|usage|tokens)|\bcredits?\b|billing|payment|upgrade|subscription|\bplan\b|not logged ?in|log ?in|sign(?:ed)? ?(?:in|out)|logged out|unauthori[sz]ed|\b40[12]\b|\b429\b|api key|(?:token|session) (?:has )?expired|set an auth method/i

// The account lines a run printed beside its event stream, as written: the CLI's own notices, such as a usage limit
// coming up, that its event stream does not carry. At most the last few, so a CLI that repeats one fills nothing.
export function accountNotices(output: readonly string[]) {
  return [
    ...new Set(
      output
        .filter((line) => line.startsWith("[stderr] "))
        .map((line) => line.slice("[stderr] ".length))
        .filter((line) => ACCOUNT_MESSAGE_PATTERN.test(line)),
    ),
  ].slice(-3)
}

export type AgentOutcome = {
  exitCode: number
  error?: string
  /** Set when the failure is the agent's own word about its sign-in, plan or usage: nothing may run again on it. */
  account?: true
}

// The exit code alone does not decide whether a run worked: Claude Code exits 0
// while reporting {"type":"result","subtype":"success","is_error":true,
// "result":"Not logged in · Please run /login"}, which used to be recorded as a
// successful pass that changed nothing. The agent's own message leads the error
// as it wrote it, and Vector's sign-in hint follows it as a sentence of its own.
// With a chosen `model`, a CLI that only complains on stderr is quoted: a
// refused model is reported there, and "exited with code 1" would hide the one
// sentence that says which model to change.
export function agentOutcome(
  runtime: CodingAgentRuntime,
  exitCode: number,
  output: string[],
  model?: string,
): AgentOutcome {
  const agent = chatAgent(runtime)
  const setup = { label: agent.name, signIn: ExternalAgent.signInCommand(agent) }
  const reported = reportedAgentError(runtime, output, `${setup.label} reported an error.`)
  const failed = exitCode !== 0 || Boolean(reported)
  if (!failed) return { exitCode }

  const code = exitCode === 0 ? 1 : exitCode
  const stderr = output.filter((line) => line.startsWith("[stderr] ")).join("\n")
  const own = reported ?? (accountNotices(output).join("\n") || undefined)
  const account = own && ACCOUNT_MESSAGE_PATTERN.test(own) ? ({ account: true } as const) : {}
  if (SIGNED_OUT_PATTERN.test(reported ?? stderr)) {
    // An agent that signs in inside its own screen says where, such as Qwen Code's "Type /auth inside Qwen Code."
    const hint = agent.signIn.hint?.replace(/\.$/, "")
    const advice = `${setup.label} is installed but not signed in. Run \`${setup.signIn}\` in a terminal to sign in${hint ? `. ${hint}` : ""}, then run this again.`
    return { exitCode: code, error: own ? `${own}\n\n${advice}` : advice, account: true }
  }
  const said = model
    ? output
        .filter((line) => line.startsWith("[stderr] "))
        .map((line) => line.slice("[stderr] ".length).trim())
        .filter(Boolean)
        .slice(-3)
        .join("\n")
        .slice(-600)
    : ""
  return {
    exitCode: code,
    error: own ?? (said ? `${setup.label}: ${said}` : `${setup.label} exited with code ${exitCode}.`),
    ...account,
  }
}

export function signalAgentProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (process.platform === "win32") {
    // taskkill is a console program; without windowsHide each stop flashes a console window.
    if (child.pid) {
      execFile(
        "taskkill",
        windowsTaskkillArguments(child.pid, signal === "SIGKILL"),
        { windowsHide: true },
        () => undefined,
      )
    }
    return
  }
  if (child.exitCode !== null || child.signalCode !== null) return
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

export function windowsTaskkillArguments(pid: number, force: boolean) {
  return ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])]
}

export function stopAgentProcess(child: ChildProcessWithoutNullStreams, graceMs: number) {
  // Windows has no POSIX process group. Force the full tree immediately so a
  // short-lived npm/cmd shim cannot exit and strand its model process before a
  // delayed `/T` reaches it.
  if (process.platform === "win32") {
    signalAgentProcess(child, "SIGKILL")
    return
  }
  signalAgentProcess(child, "SIGTERM")
  const force = setTimeout(() => signalAgentProcess(child, "SIGKILL"), graceMs)
  force.unref?.()
  return force
}

// Every CLI that is still running. They are spawned detached (their own process
// group) so a stop can reach their children, which also means they would outlive
// Vector; the first run installs one exit hook that stops whatever is left.
const liveAgents = new Set<ChildProcessWithoutNullStreams>()
let exitHookInstalled = false

function trackAgent(child: ChildProcessWithoutNullStreams) {
  liveAgents.add(child)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once("exit", () => {
    for (const agent of liveAgents) signalAgentProcess(agent, "SIGTERM")
  })
}

/**
 * Why an external agent does not start while Vector Local is on (its `external-agents` source): the program makes its
 * own connections, usually to its maker's cloud models, which Vector Local neither sees nor can allow one by one.
 */
export function externalAgentOffInLocal(label: string) {
  return `${label} does not start while Vector Local is on. It makes its own connections, usually to its maker's cloud models, and Vector Local does not see them. Turn Vector Local off in Settings to use it.`
}

export async function runExternalCodingAgent(input: RunExternalAgentInput): Promise<ExternalAgentRunResult> {
  const agent = chatAgent(input.runtime)
  const setup = { label: agent.name }
  // Vector Local also holds starts requested outside the launcher.
  if (Egress.policy().enabled) throw new Error(externalAgentOffInLocal(setup.label))
  const env = input.env ?? agentEnvironment()
  const found = await findAgentBinary(agent, { env: input.env })
  if (!found) {
    const install = ExternalAgent.installFor(agent, catalogPlatform(process.platform))[0]?.command
    throw new Error(
      `${agent.name} is not installed, or Vector can't find it. ${install ? `Install it with \`${install}\`, then sign` : "Install it, then sign"} in with \`${ExternalAgent.signInCommand(agent)}\`.`,
    )
  }
  const path = found.path

  // cmd.exe ends a command line at the first line feed, even inside quotes, and npm's shim re-reads %* the same way.
  // Through claude.cmd or codex.cmd the prompt, which always spans lines, would arrive cut to its first line and every
  // flag after it would be lost, so a runtime with a stdin form reads it from there.
  const promptOnStdin = runsThroughCmd(path) && Boolean(agent.headless?.stdinPrompt)
  const model = externalModelValue(input.model)
  return new Promise((resolve, reject) => {
    const launch = shimmedCommand(
      path,
      runtimeArguments(input.runtime, input.cwd, input.prompt, input.resumeSessionId, promptOnStdin, model),
    )
    // Only an agent with no stdin prompt form gets here, such as Cursor, whose Windows install may provide no other
    // entry point than this script, so the error names a way forward that exists rather than a reinstall that might not.
    if (launch.windowsVerbatimArguments && launch.args.some((arg) => /[\r\n]/.test(arg))) {
      reject(
        new Error(
          `${setup.label} on Windows runs through a command script (${path}), and Windows cuts a prompt passed that way at its first line, so Vector cannot send it this task. Choose ${STDIN_AGENTS} for this task instead.`,
        ),
      )
      return
    }
    const child = spawn(launch.command, launch.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: untrustedChildEnvironment(withoutVariables(env, agent.headless?.unsetEnv), {
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    })
    trackAgent(child)
    const output: string[] = []
    const summaries: string[] = []
    const chat = createAgentChat(input.runtime, workspaceRoots(input.cwd))
    const cost = costReader(input.runtime)
    // The chat as of the last line: an agent whose final event carries no answer (Gemini CLI, pi) is summarised by
    // its last message instead.
    let latestChat: AgentChat | undefined
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }
    let actualCost: string | undefined
    let sessionId: string | undefined
    let stdoutBuffer = ""
    let stderrBuffer = ""
    let settled = false
    let stopReason: "aborted" | "timeout" | "finished" | undefined
    let forceTimer: NodeJS.Timeout | undefined
    // Set by the protocol's final event. The turn is over then, even while the
    // process lingers, so the run stops waiting for the CLI to exit by itself.
    let finishedWith: AgentTurnFinish | undefined
    let finishTimer: NodeJS.Timeout | undefined

    const emitLine = (stream: "stdout" | "stderr", raw: string) => {
      const text = redactAgentOutput(raw.trim())
      if (!text) return
      output.push(`[${stream}] ${text}`)
      if (output.length > 240) output.shift()
      const summary = summaryFromAgentLine(text)
      if (summary) summaries.push(summary)
      actualCost = cost(text) ?? actualCost
      // FIRST wins, inverted from actualCost above: claude repeats session_id on
      // nearly every event, and codex emits thread_id exactly once, on line 1.
      // This must happen here rather than as a post-hoc scan of `output`, which
      // is capped at 240 lines FIFO — every real-length run has already evicted
      // codex's thread.started by the time close fires.
      if (!sessionId) {
        sessionId = sessionFromAgentLine(text, input.runtime)
        if (sessionId) input.onSessionId?.(sessionId)
      }
      input.onEvent?.({ stream, text })
      input.onEvent?.({ stream: "activity", text: activityFromAgentLine(text) })
      if (stream !== "stdout") return
      latestChat = chat(text)
      input.onChat?.(latestChat)
      // The CLI gets a short grace to exit by itself (and finish saving its
      // session) before it is stopped. Both pipes keep draining until close
      // either way, so nothing printed after the final event is lost.
      if (finishedWith || settled || stopReason) return
      finishedWith = agentTurnFinished(input.runtime, text)
      if (!finishedWith) return
      finishTimer = setTimeout(() => stop("finished"), Math.max(0, input.finishGraceMs ?? 3_000))
      finishTimer.unref?.()
    }

    const consume = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const combined = (stream === "stdout" ? stdoutBuffer : stderrBuffer) + decoders[stream].write(chunk)
      const lines = combined.split(/\r?\n/)
      const remainder = lines.pop() ?? ""
      if (stream === "stdout") stdoutBuffer = remainder
      if (stream === "stderr") stderrBuffer = remainder
      lines.forEach((line) => emitLine(stream, line))
    }

    // One path for every stop: SIGTERM to the CLI's process group, SIGKILL after
    // the kill grace. The run still settles only on close, after Node has reaped
    // the CLI and both pipes have ended.
    const stop = (reason: "aborted" | "timeout" | "finished") => {
      if (stopReason) return
      stopReason = reason
      forceTimer = stopAgentProcess(child, Math.max(0, input.killGraceMs ?? 5_000))
    }
    // Once the protocol has reported the turn, Stop only ends the grace early: the
    // answer the CLI already gave is kept instead of being thrown away as stopped.
    const abort = () => stop(finishedWith ? "finished" : "aborted")
    const timeout = setTimeout(() => stop("timeout"), Math.max(1, input.timeoutMs ?? 30 * 60_000))
    timeout.unref?.()
    input.signal?.addEventListener("abort", abort, { once: true })
    // A CLI that exits before reading its prompt makes the write fail with EPIPE; its exit already reports the run.
    child.stdin.on("error", () => undefined)
    child.stdin.end(promptOnStdin ? input.prompt : undefined)
    if (input.signal?.aborted) abort()
    child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk))
    child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk))
    const clearTimers = () => {
      clearTimeout(timeout)
      if (forceTimer) clearTimeout(forceTimer)
      if (finishTimer) clearTimeout(finishTimer)
      input.signal?.removeEventListener("abort", abort)
    }
    child.once("error", (error) => {
      liveAgents.delete(child)
      if (settled) return
      settled = true
      clearTimers()
      reject(error)
    })
    child.once("close", (code) => {
      liveAgents.delete(child)
      if (settled) return
      settled = true
      clearTimers()
      emitLine("stdout", stdoutBuffer + decoders.stdout.end())
      emitLine("stderr", stderrBuffer + decoders.stderr.end())
      if (stopReason === "aborted" || stopReason === "timeout") {
        const timedOut = stopReason === "timeout"
        const error = timedOut
          ? `${setup.label} exceeded the ${Math.ceil((input.timeoutMs ?? 30 * 60_000) / 60_000)} minute run limit and was stopped.`
          : `${setup.label} was stopped.`
        resolve({
          exitCode: timedOut ? 124 : 130,
          summary: error,
          error,
          actualCost,
          sessionId: sessionId ?? input.resumeSessionId,
          output,
        })
        return
      }
      // Stopped after its own final event, the CLI's exit status (143 from
      // SIGTERM) says nothing about the turn; the protocol already reported it.
      const exitCode =
        stopReason === "finished" ? (finishedWith === "failure" ? 1 : 0) : (code ?? (input.signal?.aborted ? 130 : 1))
      const outcome = agentOutcome(input.runtime, exitCode, output, model)
      resolve({
        exitCode: outcome.exitCode,
        summary:
          outcome.error ??
          summaries.at(-1) ??
          latestChat?.messages.at(-1)?.text ??
          `${setup.label} completed the isolated task.`,
        error: outcome.error,
        actualCost,
        // Not seeded from resumeSessionId before the stream: if a runtime mints
        // a NEW id on resume after a future protocol change, seeding would hide it and
        // every later turn would resume a thread that no longer grows.
        sessionId: sessionId ?? input.resumeSessionId,
        // A limit or a sign-in the agent reported is never a refused resume: running it again would only spend the
        // account again on the same answer.
        resumeRejected:
          Boolean(input.resumeSessionId) &&
          outcome.exitCode !== 0 &&
          !outcome.account &&
          RESUME_REJECTED_PATTERN.test(output.join("\n")),
        modelRejected: modelRejected(model, outcome),
        ...(outcome.exitCode === 0 && accountNotices(output).length ? { notices: accountNotices(output) } : {}),
        output,
      })
    })
  })
}
