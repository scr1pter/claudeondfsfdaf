export * as Sandbox from "./sandbox"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { AGENT_MARKER } from "@vectordevai/core/child-environment"
import { legacyName } from "@vectordevai/core/flag/legacy"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { Global } from "@vectordevai/core/global"
import { Shell } from "@vectordevai/core/shell"
import { which } from "@vectordevai/core/util/which"
import * as UnattendedSeccomp from "./unattended-seccomp"

export type Mechanism = "seatbelt" | "bubblewrap" | "none"

export type Availability = {
  supported: boolean
  mechanism: Mechanism
  reason?: string
}

export type Wrapped = {
  command: string
  args: string[]
  shell: string | false
  env: NodeJS.ProcessEnv
  sandboxed: boolean
  mechanism: Mechanism
  reason?: string
  /** Compiled policy supplied on the unattended bubblewrap's standard input. */
  seccomp?: Uint8Array
}

const SEATBELT = "/usr/bin/sandbox-exec"

export function sandboxEnabled(value = process.env.VECTOR_SHELL_SANDBOX) {
  if (value === undefined) return false
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
}

// Home-relative paths worth more than the convenience of reading them. An agent
// that cannot read a key cannot leak one, and nothing in a normal build needs
// these. Anything listed here still resolves for the user's own tools, which run
// outside the sandbox.
const SECRETS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  ".config/gcloud",
  ".config/google-chrome",
  ".config/chromium",
  ".kube",
  ".docker/config.json",
  ".netrc",
  ".npmrc",
  ".password-store",
  ".pypirc",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".gem/credentials",
  ".gradle/gradle.properties",
  ".m2/settings.xml",
  ".mozilla",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Safari",
  "Library/Messages",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/Firefox",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Arc",
  // The Vercel and Supabase command-line logins. With them an agent could
  // deploy, promote or change a database outside vector_cloud, whose prompts
  // auto-accept never answers. Vector's own publish runs in the desktop with
  // its own token, outside this sandbox.
  "Library/Application Support/com.vercel.cli",
  ".local/share/com.vercel.cli",
  ".vercel",
  ".supabase",
]

// Vector's own credential stores inside a data directory. A CLI user without the
// desktop vault key keeps these as plaintext, so they are worth as much as ~/.ssh.
const CREDENTIAL_FILES = [
  "auth.json",
  "mcp-auth.json",
  "cli-auth.json",
  "plugin-oauth-approvals.json",
  path.join("vault", "vault.json"),
]

// The desktop app keeps its vault key beside its user data. Electron puts
// that under Application Support on macOS and $XDG_CONFIG_HOME (default ~/.config) on
// Linux, named by app ID.
const DESKTOP_ROOTS = ["Library/Application Support", ".config"]
const DESKTOP_APP_IDS = ["ai.vector.app", "ai.vector.app.beta", "ai.vector.app.dev"]
const DESKTOP_SECRETS = ["secure-runtime"]

// Package managers write into a shared per-user cache rather than the workspace,
// so a sandbox that forbids these turns every first build into a failure. This is
// the deliberate soft spot of the policy: a cache directory on PATH (~/.bun/bin,
// ~/.cargo/bin) stays writable, so the sandbox bounds blast radius rather than
// promising containment against an agent that is actively trying to escape.
const CACHES = [
  ".cache",
  ".npm",
  ".bun",
  ".yarn",
  ".pnpm-store",
  ".deno",
  ".cargo",
  ".rustup",
  ".gradle",
  ".m2",
  ".gem",
  ".nuget",
  ".dotnet",
  ".pub-cache",
  ".cocoapods",
  ".node-gyp",
  ".electron",
  ".local/share/pnpm",
  ".local/state",
  "go/pkg/mod",
  "Library/Caches",
  "Library/pnpm",
  "Library/Developer/Xcode/DerivedData",
]

export function sandboxAvailability(platform: NodeJS.Platform = process.platform): Availability {
  if (platform === "darwin") {
    if (fs.existsSync(SEATBELT)) return { supported: true, mechanism: "seatbelt" }
    return { supported: false, mechanism: "none", reason: `${SEATBELT} is missing, so seatbelt cannot be applied` }
  }

  if (platform === "linux") {
    if (which("bwrap")) return { supported: true, mechanism: "bubblewrap" }
    return {
      supported: false,
      mechanism: "none",
      reason: "bubblewrap (bwrap) is not on PATH, so no sandbox can be applied",
    }
  }

  if (platform === "win32") {
    return {
      supported: false,
      mechanism: "none",
      reason: "Windows ships no equivalent to seatbelt or bubblewrap, so commands run unsandboxed",
    }
  }

  return { supported: false, mechanism: "none", reason: `no sandbox mechanism is implemented for ${platform}` }
}

/**
 * Renders a seatbelt (SBPL) profile. Pure: every path it needs is passed in, so
 * tests can assert the exact policy text without spawning anything.
 *
 * Rule order is load-bearing. SBPL is last-match-wins, so the broad
 * `(allow file-read*)` has to come before the secret denials or the denials are
 * silently overridden.
 */
export function seatbeltProfile(input: {
  writable: readonly string[]
  denyRead: readonly string[]
  denyWrite?: readonly string[]
  allowNetwork: boolean
}) {
  const writable = Array.from(new Set(input.writable)).filter(Boolean)
  const denyRead = Array.from(new Set(input.denyRead)).filter(Boolean)
  const denyWrite = Array.from(new Set([...denyRead, ...(input.denyWrite ?? [])])).filter(Boolean)

  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    // Only processes inside this same sandbox: a build may manage its own
    // children, but it has no business signalling the editor that spawned it.
    "(allow signal (target same-sandbox))",
    "(allow file-read*)",
    // An empty filter list is a profile the kernel rejects, so a caller with no
    // writable roots gets a read-only sandbox rather than a broken one.
    ...(writable.length > 0
      ? ["(allow file-write*", ...writable.map((file) => `  (subpath ${literal(file)})`), ")"]
      : []),
    // Terminals, /dev/null and process substitution via /dev/fd. Without these a
    // plain `cmd > /dev/null` fails under (deny default).
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/full")',
    '  (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/tty")',
    '  (literal "/dev/stdin") (literal "/dev/stdout") (literal "/dev/stderr")',
    '  (literal "/dev/ptmx") (subpath "/dev/fd") (regex #"^/dev/tty[a-z0-9]*$"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/dtracehelper") (literal "/dev/ptmx")',
    '  (regex #"^/dev/tty[a-z0-9]*$"))',
    "(allow pseudo-tty)",
    // A secret can sit inside a writable cache root (~/.gem/credentials lives in
    // the writable ~/.gem), and the earlier (allow file-write*) would otherwise
    // let an agent clobber a credential it is not allowed to read. Denying the
    // write here overrides that grant without revoking the parent cache.
    ...(denyWrite.length > 0
      ? ["(deny file-write*", ...denyWrite.map((file) => `  (subpath ${literal(file)})`), ")"]
      : []),
    ...(denyRead.length > 0
      ? ["(deny file-read*", ...denyRead.map((file) => `  (subpath ${literal(file)})`), ")"]
      : []),
    // Registries and package downloads are the common case, so network stays on
    // unless the caller turns it off. Unix sockets survive either way because
    // local toolchains (compiler daemons) talk over them.
    ...(input.allowNetwork ? ["(allow network*)"] : OFFLINE_NETWORK),
    "",
  ].join("\n")
}

// The network rules with no network: this computer's own servers stay reachable (a database, a dev server) and a
// command may serve on loopback itself, while nothing reaches another host. Outbound is allowed by the remote address
// alone: `(local ip "localhost:*")` under network* also let connections to other hosts out (macOS 27), so binding and
// accepting are the only rules the local address decides. Name lookups go through mDNSResponder, which would send the
// name to the network's resolver, so its socket is refused; names in /etc/hosts, localhost among them, still resolve.
const OFFLINE_NETWORK = [
  "(deny network*)",
  "(allow network* (local unix) (remote unix))",
  '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
  '(allow network-outbound (remote ip "localhost:*"))',
  '(allow network-bind network-inbound (local ip "localhost:*"))',
]

// Where systemd-resolved listens on Linux. A sandbox without network hides it, so a name lookup cannot go through the
// host's resolver, whose own connections are outside the sandbox.
const RESOLVER = "/run/systemd/resolve"

// The variables that point programs at a proxy. A command with no network gets none, so a proxy that runs on this
// computer does not carry its requests out.
const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY"]

export const WINDOWS_UNFILTERED =
  "Commands the agent runs are not network-filtered on Windows. Vector Local's Web access is None, but a command can still reach the network."
const WRITES = "they can write only in this repository, the working folder, temporary folders and package caches"
export const OFFLINE_NOTICE: Record<"seatbelt" | "bubblewrap", string> = {
  seatbelt: `Vector Local's Web access is None, so the commands the agent runs go through Vector's sandbox: they can reach servers on this computer only, and ${WRITES}.`,
  bubblewrap: `Vector Local's Web access is None, so the commands the agent runs go through Vector's sandbox: they reach no network, not even servers on this computer, and ${WRITES}.`,
}

/** How a command runs with Web access None: in the sandbox, as it is where no sandbox exists (Windows), or not at all. */
export type Offline =
  | { readonly type: "sandboxed"; readonly wrapped: Wrapped; readonly notice: string }
  | { readonly type: "unfiltered"; readonly notice: string }
  // `reason` is the sandbox's own why, without the shell tool's wording around it.
  | { readonly type: "refused"; readonly message: string; readonly reason?: string }

/**
 * A command under Vector Local's Web access None (section 4.3.5): on macOS and Linux it runs in the sandbox with no
 * network but this computer's, whatever VECTOR_SHELL_SANDBOX says, and a command the sandbox cannot wrap (bwrap is
 * missing, the profile could not be built) is refused rather than run unwrapped. Windows has no sandbox, so there a
 * command runs as it is, and the notice says it is not network-filtered.
 */
export function offline(input: Omit<CommandInput, "allowNetwork">): Offline {
  return offlineCommand(input)
}

function offlineCommand(input: Omit<CommandInput, "allowNetwork">, hostHome?: string): Offline {
  const platform = input.platform ?? process.platform
  if (platform === "win32") return { type: "unfiltered", notice: WINDOWS_UNFILTERED }
  const missing = offlineRefusal(platform)
  if (missing) return { type: "refused", message: missing, reason: sandboxAvailability(platform).reason }
  const env = Object.fromEntries(
    Object.entries(input.env).filter(([key]) => !PROXY_VARIABLES.includes(key.toUpperCase())),
  )
  const wrapped = wrap({ ...input, env, allowNetwork: false }, hostHome)
  if (!wrapped.sandboxed || wrapped.mechanism === "none")
    return { type: "refused", message: refusal(platform, wrapped.reason), reason: wrapped.reason }
  return { type: "sandboxed", wrapped, notice: OFFLINE_NOTICE[wrapped.mechanism] }
}

/**
 * Why a command cannot run with Web access None on this platform, before anything about it is asked: no sandbox is
 * there to run it in. Undefined where one is, and on Windows, which has none to require.
 */
export function offlineRefusal(platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") return undefined
  const availability = sandboxAvailability(platform)
  return availability.supported ? undefined : refusal(platform, availability.reason)
}

function refusal(platform: NodeJS.Platform, reason = "the sandbox could not be applied") {
  return [
    `Vector did not run this command. With Web access None in Vector Local, commands run only inside Vector's sandbox, and ${reason.replace(/\.$/, "")}.`,
    platform === "linux"
      ? "Install bubblewrap (the bwrap command) to run commands, or change Web access in Vector Local."
      : "Change Web access in Vector Local to run commands without the sandbox.",
  ].join(" ")
}

// An unattended session's commands (R-M2) go through `unattended` below: `offline` with `writes: "workspace"`, so the
// shell tool does pass that for those sessions, and only for them.
export const UNATTENDED_NOTICE =
  "This unattended run's commands go through Vector's offline sandbox. They cannot reach TCP or UDP services outside it, use filesystem Unix sockets, or write to this repository's Git metadata."
export const UNATTENDED_REFUSAL =
  "Vector did not run this command. The unattended offline sandbox requires Linux with bubblewrap and socket filtering, and it cannot be applied here."

// What an unattended run's commands keep of the engine's environment: what a build needs to find its tools and speak
// the user's language, the folders a toolchain is configured with (JAVA_HOME, GOROOT) and Vector's own markers for its
// children, never a name that reads as a secret, in any case. Everything else stays out: credentials, agent and bus
// sockets, proxies and loader variables among them. The sandbox's private /tmp holds the empty HOME and check caches.
const UNATTENDED_KEPT = new Set([
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "COLORTERM",
  "NO_COLOR",
  AGENT_MARKER,
  "VECTOR_LOCAL",
  "VECTOR_LOCAL_WEB",
])
const UNATTENDED_HOME = "/tmp/vector-unattended-home"
const UNATTENDED_CACHES = {
  TMPDIR: "/tmp",
  XDG_CACHE_HOME: "/tmp/.cache",
  GOCACHE: "/tmp/.cache/go-build",
  npm_config_cache: "/tmp/.npm",
  BUN_INSTALL_CACHE_DIR: "/tmp/.bun-cache",
}
// Known stores may be symlinks to paths the sandbox still exposes, so it masks those targets too.
const UNATTENDED_SECRETS = [
  ".git-credentials",
  ".config/git/credentials",
  ".azure",
  ".terraform.d",
  ".local/share/keyrings",
  ".docker",
  ".pgpass",
  ".vault-token",
  ".config/op",
  ".config/hub",
  ".s3cfg",
]

/**
 * The trusted canonical bubblewrap and bootstrap shell paths require a supported Linux syscall ABI.
 */
export function unattendedBinary(platform: NodeJS.Platform = process.platform) {
  if (platform !== "linux" || !UnattendedSeccomp.supported() || !unattendedBootstrap()) return undefined
  const binary = which("bwrap")
  return binary === null ? undefined : rootOnly(binary)
}

export function unattendedBootstrap() {
  return rootOnly("/bin/sh")
}

/**
 * An unattended command uses the namespace, the seccomp program, and the descriptor check together. A platform or
 * command the sandbox cannot wrap gets the same fixed refusal.
 */
export function unattended(
  input: Omit<Parameters<typeof wrapCommand>[0], "allowNetwork" | "writes">,
): Exclude<Offline, { type: "unfiltered" }> {
  const binary = unattendedBinary(input.platform)
  const bootstrap = unattendedBootstrap()
  const seccomp = UnattendedSeccomp.filter()
  if (binary === undefined || bootstrap === undefined || seccomp === undefined)
    return { type: "refused", message: UNATTENDED_REFUSAL }
  const home = unattendedHome(input.home ?? os.homedir(), input.workspaceRoot, input.env.PATH)
  const cwd = absoluteDirectory(input.cwd)
  if (!home || !cwd || !containsOrSame(cwd, home.workspace) || containsOrSame(bootstrap, home.host))
    return { type: "refused", message: UNATTENDED_REFUSAL }
  const metadata = gitMetadata(home.workspace)
  const decided = offlineCommand(
    {
      ...input,
      cwd,
      workspaceRoot: home.workspace,
      home: home.host,
      env: unattendedEnvironment(input.env, home.path),
      writes: "workspace",
    },
    home.host,
  )
  if (
    metadata === undefined ||
    decided.type !== "sandboxed" ||
    decided.wrapped.mechanism !== "bubblewrap" ||
    rootOnly(decided.wrapped.command) !== binary
  )
    return { type: "refused", message: UNATTENDED_REFUSAL }
  // These mounts go after every mount wrapCommand makes, before the data folder turns read-only and the command starts.
  const args = decided.wrapped.args
  const at = args.findIndex((arg) => arg === "--remount-ro" || arg === "--chdir")
  const chdir = args.indexOf("--chdir", at)
  if (at < 0 || chdir < at || chdir + 2 >= args.length) return { type: "refused", message: UNATTENDED_REFUSAL }
  return {
    ...decided,
    wrapped: {
      ...decided.wrapped,
      command: binary,
      seccomp,
      args: [
        ...args.slice(0, at),
        ...metadata,
        ...hiddenStores(home.host, home.workspace),
        ...UnattendedSeccomp.args,
        ...args.slice(at, chdir + 2),
        ...UnattendedSeccomp.command(bootstrap, args.slice(chdir + 2)),
      ],
    },
    notice: UNATTENDED_NOTICE,
  }
}

// The checkout's own `.git` sits inside the one folder a command may write, where a command could plant a hook, a
// config (core.fsmonitor, a filter driver) or another gitdir that the next git outside the sandbox would run. It is
// bound read-only, a mount point no command can replace (a linked worktree's marker already is, and its gitdir is not
// writable in workspace mode). A `.git` that is a link cannot be pinned that way, so it is refused (undefined).
function gitMetadata(workspaceRoot: string) {
  const marker = path.join(canonical(workspaceRoot), ".git")
  const info = fs.lstatSync(marker, { throwIfNoEntry: false })
  if (info === undefined) return []
  return info.isSymbolicLink() ? undefined : ["--ro-bind", marker, marker]
}

function hiddenStores(home: string, workspace: string) {
  return UNATTENDED_SECRETS.map((entry) => canonical(path.join(home, entry)))
    .filter((file) => visibleWithPrivateHome(file, home, workspace) && fs.existsSync(file))
    .flatMap((file) => (fs.statSync(file).isDirectory() ? ["--tmpfs", file] : ["--ro-bind", "/dev/null", file]))
}

function visibleWithPrivateHome(file: string, home: string, workspace: string) {
  return !containsOrSame(file, home) || containsOrSame(file, workspace)
}

/** Resolve the mask and keep canonical tool paths outside it or inside the authorized checkout. */
export function unattendedHome(homePath: string, workspacePath: string, searchPath?: string) {
  const host = absoluteDirectory(homePath)
  const workspace = absoluteDirectory(workspacePath)
  const overlaps = (first: string, second: string) => containsOrSame(first, second) || containsOrSame(second, first)
  if (!host || !workspace || overlaps(host, UNATTENDED_HOME) || containsOrSame(host, workspace)) return undefined
  const tools = (directories: readonly string[]) =>
    directories.flatMap((directory) => {
      const real = absoluteDirectory(directory)
      return real && (!overlaps(real, host) || containsOrSame(real, workspace)) ? [real] : []
    })
  const selected = tools(searchPath?.split(path.delimiter) ?? [])
  const pathEntries = selected.length ? selected : tools(["/usr/bin", "/bin"])
  return { host, workspace, path: [...new Set(pathEntries)].join(path.delimiter) }
}

function absoluteDirectory(directory: string) {
  if (!path.isAbsolute(directory)) return undefined
  try {
    const real = fs.realpathSync(directory)
    return fs.statSync(real).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

function unattendedEnvironment(env: NodeJS.ProcessEnv, searchPath: string): NodeJS.ProcessEnv {
  const kept = (name: string) =>
    !GithubAgents.SECRET_NAME_PATTERN.test(name) &&
    (UNATTENDED_KEPT.has(name) || name.startsWith("LC_") || /_(?:HOME|ROOT)$/.test(name))
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && kept(key.toUpperCase()))),
    HOME: UNATTENDED_HOME,
    PATH: searchPath,
    ...UNATTENDED_CACHES,
  }
}

// Start the canonical file. Every ancestor must also be root-controlled, since a writable ancestor can replace it.
function rootOnly(file: string) {
  try {
    const real = fs.realpathSync(file)
    const info = fs.statSync(real)
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) return undefined
    for (let directory = path.dirname(real); ; directory = path.dirname(directory)) {
      const parent = fs.statSync(directory)
      if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) return undefined
      if (directory === path.dirname(directory)) return real
    }
  } catch {
    return undefined
  }
}

type CommandInput = {
  shell: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  allowNetwork?: boolean
  workspaceRoot: string
  platform?: NodeJS.Platform
  home?: string
  data?: string
  /**
   * Review checks and unattended commands use "workspace". The working folder must be inside the checkout. Host write
   * access is limited to the checkout, without grants to host temporary folders, package caches or Git metadata.
   * Bubblewrap supplies private /tmp and runtime directories, masks Vector's data with a read-only mount and drops
   * capabilities. Unattended commands also get a fresh HOME under private /tmp. Seatbelt uses the host's /tmp without
   * granting writes there. When writes is omitted, the normal shell sandbox policy applies.
   */
  writes?: "workspace"
}

export function wrapCommand(input: CommandInput): Wrapped {
  return wrap(input)
}

function wrap(input: CommandInput, hostHome?: string): Wrapped {
  const platform = input.platform ?? process.platform

  // Preserved verbatim from the pre-sandbox shell tool: PowerShell needs an
  // explicit argv rather than a `shell:` option, and Windows has nothing to wrap
  // it in.
  if (platform === "win32") {
    const availability = sandboxAvailability(platform)
    if (Shell.ps(input.shell)) {
      return {
        command: input.shell,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command],
        shell: false,
        env: input.env,
        sandboxed: false,
        mechanism: "none",
        reason: availability.reason,
      }
    }
    return {
      command: input.command,
      args: [],
      shell: input.shell,
      env: input.env,
      sandboxed: false,
      mechanism: "none",
      reason: availability.reason,
    }
  }

  const unwrapped = (reason?: string): Wrapped => ({
    command: input.command,
    args: [],
    shell: input.shell,
    env: input.env,
    sandboxed: false,
    mechanism: "none",
    reason,
  })

  const availability = sandboxAvailability(platform)
  if (!availability.supported) return unwrapped(availability.reason)

  // The degradation contract: a path that cannot be resolved costs the user a
  // sandbox, never their shell tool. Note the limit — this only covers building
  // the profile. If the kernel rejects the profile it does so inside the spawned
  // sandbox-exec, where nothing here can catch it, and the command fails.
  try {
    const allowNetwork = input.allowNetwork ?? true
    const home = canonical(input.home ?? os.homedir())
    const git = linkedWorktreeMetadata(input.workspaceRoot)
    const workspace = input.writes === "workspace"
    if (workspace && !containsOrSame(canonical(input.cwd), canonical(input.workspaceRoot)))
      return unwrapped("the working folder is outside the folder the command may write")
    // cwd is writable on purpose. A workdir outside the project has already been
    // approved through the external_directory permission, and silently failing
    // writes there would contradict a prompt the user just answered.
    // A non-git project reports "/" as its worktree. Granting write to that root
    // would make the profile decorative, so it is dropped and the working
    // directory below carries the project's own writes instead.
    const writable = (
      workspace
        ? [canonical(input.workspaceRoot)]
        : [
            canonical(input.workspaceRoot),
            canonical(input.cwd),
            canonical(os.tmpdir()),
            ...CACHES.map((entry) => canonical(path.join(home, entry))),
            ...git.writable,
          ]
    ).filter((file) => file !== "/")
    if (workspace && !writable.length) return unwrapped("the folder the command may write is the root folder")
    const denyRead = [
      ...SECRETS.map((entry) => canonical(path.join(home, entry))),
      ...cargoCredentialPaths(home),
      ...credentialStorePaths(home, input.data ?? Global.Path.data),
    ]

    if (availability.mechanism === "seatbelt") {
      return {
        command: SEATBELT,
        args: [
          "-p",
          seatbeltProfile({
            writable: workspace
              ? writable
              : [...writable, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"],
            denyRead: [...denyRead, "/Library/Keychains"],
            denyWrite: git.readonly,
            allowNetwork,
          }),
          input.shell,
          "-c",
          input.command,
        ],
        shell: false,
        env: input.env,
        sandboxed: true,
        mechanism: "seatbelt",
      }
    }

    const bwrap = which("bwrap")
    if (!bwrap) return unwrapped("bubblewrap (bwrap) disappeared from PATH before the command could be wrapped")
    const visible = (file: string) =>
      hostHome === undefined || visibleWithPrivateHome(file, hostHome, input.workspaceRoot)
    const mayBind = (file: string) => visible(file) && (hostHome === undefined || !containsOrSame(hostHome, file))
    const data = workspace
      ? privateData(canonical(input.data ?? Global.Path.data), canonical(input.workspaceRoot), home)
      : undefined
    const hidden = data && visible(data) ? data : undefined

    return {
      command: bwrap,
      args: [
        "--die-with-parent",
        // Run as root (a container), bwrap would keep its capabilities, and a command could remount the root writable.
        // Keep bwrap's namespace init in the caller's process group so group termination reaches it during startup.
        // Review checks and unattended shell commands already start detached from the caller's terminal.
        ...(workspace ? ["--cap-drop", "ALL"] : []),
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-pid",
        ...(allowNetwork ? [] : ["--unshare-net"]),
        // Order matters: each later mount lands on top of the read-only root.
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        ...(workspace ? runtimeMounts(input.env.PATH) : []),
        // Mask HOME first, then add the approved workspace, even when it lives inside HOME.
        ...(hostHome ? ["--tmpfs", hostHome, "--dir", UNATTENDED_HOME] : []),
        ...(hidden ? ["--tmpfs", hidden, ...readOnly(searchFolders(input.env.PATH, [hidden]))] : []),
        ...(allowNetwork || workspace || !fs.existsSync(RESOLVER) ? [] : ["--tmpfs", RESOLVER]),
        ...writable.filter(fs.existsSync).flatMap((file) => ["--bind", file, file]),
        ...git.readonly
          .filter((file) => mayBind(file) && fs.existsSync(file))
          .flatMap((file) => ["--ro-bind", file, file]),
        // bwrap has no read filter, so covering the path is how a secret gets
        // hidden. A tmpfs only mounts over a directory, so a secret that is a
        // plain file (.netrc, .docker/config.json) gets /dev/null bound over it
        // instead: mounting a tmpfs there fails and takes the whole run with it.
        ...denyRead
          .filter((file) => visible(file) && fs.existsSync(file))
          .flatMap((file) => (fs.statSync(file).isDirectory() ? ["--tmpfs", file] : ["--ro-bind", "/dev/null", file])),
        // Last, once every mount point inside it exists: the data folder's own tmpfs becomes read-only (not the
        // workspace or the PATH folders bound into it).
        ...(hidden ? ["--remount-ro", hidden] : []),
        ...(hostHome ? ["--remount-ro", hostHome] : []),
        "--chdir",
        input.cwd,
        input.shell,
        "-c",
        input.command,
      ],
      shell: false,
      env: input.env,
      sandboxed: true,
      mechanism: "bubblewrap",
    }
  } catch (error) {
    return unwrapped(`sandbox profile could not be built (${error instanceof Error ? error.message : String(error)})`)
  }
}

function linkedWorktreeMetadata(workspaceRoot: string) {
  const marker = path.join(canonical(workspaceRoot), ".git")
  if (!fs.existsSync(marker) || !fs.statSync(marker).isFile()) return { writable: [], readonly: [] }

  const match = fs.readFileSync(marker, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)
  if (!match) return { writable: [], readonly: [] }
  const gitdir = canonical(path.resolve(path.dirname(marker), match[1]))
  const commonMarker = path.join(gitdir, "commondir")
  const backReference = path.join(gitdir, "gitdir")
  if (!fs.existsSync(commonMarker) || !fs.existsSync(backReference)) return { writable: [], readonly: [] }
  if (canonical(fs.readFileSync(backReference, "utf8").trim()) !== canonical(marker)) {
    return { writable: [], readonly: [] }
  }

  const common = canonical(path.resolve(gitdir, fs.readFileSync(commonMarker, "utf8").trim()))
  if (common === gitdir || !containsPath(gitdir, path.join(common, "worktrees"))) {
    return { writable: [], readonly: [] }
  }

  return {
    // The per-worktree directory owns HEAD, the index, and their lock files. Git
    // mutations that also need a shared object, ref, or reflog intentionally fail
    // in this preview instead of widening a workspace grant into the parent repo.
    writable: [gitdir],
    // The marker is inside the writable checkout. Keeping it read-only prevents
    // a command from redirecting the next sandbox grant at arbitrary metadata.
    // Keep shared stores explicit too, so a later broader grant cannot silently
    // make linked-worktree commits writable.
    readonly: [
      canonical(marker),
      canonical(path.join(common, "objects")),
      canonical(path.join(common, "refs")),
      canonical(path.join(common, "logs", "refs")),
    ],
  }
}

function containsPath(file: string, directory: string) {
  const relative = path.relative(directory, file)
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

function containsOrSame(file: string, directory: string) {
  return file === directory || containsPath(file, directory)
}

// The runtime folders hold the host's sockets (D-Bus, Docker, Podman, containerd, snapd, the user's session bus), and a
// network namespace does not stop a socket file: workspace mode mounts an empty /run (and a /var/run that is a folder
// of its own) over them. A PATH folder inside one (NixOS keeps /run/current-system/sw/bin there) is put back read-only.
function runtimeMounts(searchPath: string | undefined) {
  const folders = ["/run", "/var/run"].filter((folder) => {
    const info = fs.lstatSync(folder, { throwIfNoEntry: false })
    return info?.isDirectory() === true
  })
  return [...folders.flatMap((folder) => ["--tmpfs", folder]), ...readOnly(searchFolders(searchPath, folders))]
}

// Vector's data folder holds other projects' checkouts, cloned repositories, logs and session stores, none of which a
// command in the workspace needs. Workspace mode hides it unless the workspace holds it or it holds the home folder
// (where the user's tools live).
function privateData(data: string, workspaceRoot: string, home: string) {
  if (data === "/" || containsOrSame(data, workspaceRoot) || containsOrSame(home, data)) return undefined
  return fs.lstatSync(data, { throwIfNoEntry: false })?.isDirectory() ? data : undefined
}

/** The PATH folders inside one of `folders`, which a mount over them would otherwise hide. */
function searchFolders(searchPath: string | undefined, folders: readonly string[]) {
  const tools = (searchPath ?? "")
    .split(path.delimiter)
    .filter(
      (entry) =>
        path.isAbsolute(entry) && fs.existsSync(entry) && folders.some((folder) => containsPath(entry, folder)),
    )
  return Array.from(new Set(tools))
}

const readOnly = (folders: readonly string[]) => folders.flatMap((entry) => ["--ro-bind", entry, entry])

function cargoCredentialPaths(home: string) {
  const directory = path.join(home, ".cargo")
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return []
  return fs
    .readdirSync(directory)
    .filter((entry) => entry.startsWith("credentials"))
    .map((entry) => canonical(path.join(directory, entry)))
}

/**
 * Vector's credential stores, the earlier product's equivalents (a user who upgraded
 * still has them on disk), and the desktop vault key. The desktop runs its engine
 * with XDG_DATA_HOME=<userData>/xdg-data, so that engine's stores are listed beside
 * the vault key, and the CLI's default data root is listed as well: the two apps
 * often share one machine.
 *
 * The SQLite database is listed too. Its `credential` table holds integration keys as
 * plain JSON, so it is worth as much as auth.json. Hiding it also hides session
 * history from sandboxed commands, which is the intended trade.
 */
export function credentialStorePaths(home: string, data: string, configHome = process.env.XDG_CONFIG_HOME) {
  const names = [path.basename(data), ...(legacyName ? [legacyName] : [])]
  const desktops = Array.from(
    new Set([...DESKTOP_ROOTS, ...(configHome ? [configHome] : [])].map((root) => path.resolve(home, root))),
  ).flatMap((root) => DESKTOP_APP_IDS.map((id) => path.join(root, id)))
  const directories = [
    ...Array.from(new Set([path.dirname(data), path.join(home, ".local", "share")])).flatMap((root) =>
      names.map((name) => path.join(root, name)),
    ),
    ...desktops.map((app) => path.join(app, "xdg-data", "vector")),
  ]
  return [
    ...directories.flatMap((directory) => [
      ...CREDENTIAL_FILES.map((file) => path.join(directory, file)),
      ...databaseFiles(directory),
    ]),
    ...desktops.flatMap((app) => DESKTOP_SECRETS.map((entry) => path.join(app, entry))),
  ].map(canonical)
}

/**
 * The database is `<name>.db`, or `<name>-<channel>.db` on other release channels,
 * with -wal and -shm beside it. Seatbelt and bubblewrap both deny by exact path, so
 * channel databases are found by listing the directory. The engine opens its
 * database before any shell command runs, so a channel file that does not exist yet
 * is not one this engine is using.
 */
function databaseFiles(directory: string) {
  const name = path.basename(directory)
  const existing =
    fs.existsSync(directory) && fs.statSync(directory).isDirectory()
      ? fs
          .readdirSync(directory)
          .filter(
            (entry) => entry.startsWith(name) && /^(-[^/]+)?\.db(-wal|-shm|-journal)?$/.test(entry.slice(name.length)),
          )
      : []
  return Array.from(new Set([...["", "-wal", "-shm"].map((suffix) => `${name}.db${suffix}`), ...existing])).map(
    (entry) => path.join(directory, entry),
  )
}

/**
 * Seatbelt matches on the path the kernel resolves to, so an unresolved symlink
 * matches nothing at all: `(subpath "/tmp/x")` grants no write to /tmp/x on macOS
 * because /tmp is a link to /private/tmp. Paths that do not exist yet are kept
 * as-is so a package manager can still create its own cache directory.
 */
function canonical(file: string) {
  const resolved = path.resolve(file)
  if (!fs.existsSync(resolved)) return resolved
  // Several of the paths we deny are exactly the ones macOS protects with TCC,
  // and realpath's lstat on them raises EPERM. Falling back to the literal path
  // keeps the rule (these are real directories, not symlinks) instead of losing
  // the whole profile over a directory we were never allowed to inspect.
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

function literal(file: string) {
  return `"${file.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
