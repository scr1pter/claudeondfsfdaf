export * as Shell from "./shell"

import path from "path"
import { spawn, type ChildProcess } from "child_process"
import { readFile } from "fs/promises"
import { realpathSync, statSync } from "fs"
import { setTimeout as sleep } from "node:timers/promises"
import { Option, Schema } from "effect"
import { untrustedChildEnvironment } from "./child-environment"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { which } from "./util/which"

const SIGKILL_TIMEOUT_MS = 200
const META: Record<string, { deny?: boolean; login?: boolean; posix?: boolean; ps?: boolean }> = {
  bash: { login: true, posix: true },
  dash: { login: true, posix: true },
  fish: { deny: true, login: true },
  ksh: { login: true, posix: true },
  nu: { deny: true },
  powershell: { ps: true },
  pwsh: { ps: true },
  sh: { login: true, posix: true },
  zsh: { login: true, posix: true },
}

export type Item = {
  path: string
  name: string
  acceptable: boolean
}

export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
  const pid = proc.pid
  if (!pid || opts?.exited?.()) return

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        env: untrustedChildEnvironment(),
        stdio: "ignore",
        windowsHide: true,
      })
      killer.once("exit", () => resolve())
      killer.once("error", () => resolve())
    })
    return
  }

  try {
    process.kill(-pid, "SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      process.kill(-pid, "SIGKILL")
    }
  } catch {
    proc.kill("SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      proc.kill("SIGKILL")
    }
  }
}

function stat(file: string) {
  return statSync(file, { throwIfNoEntry: false }) ?? undefined
}

function full(file: string) {
  if (process.platform !== "win32") return file
  const shell = FSUtil.windowsPath(file)
  if (path.win32.dirname(shell) !== ".") {
    if (shell.startsWith("/") && name(shell) === "bash") return gitbash() || shell
    return shell
  }
  if (name(shell) === "bash") return gitbash() || which(shell) || shell
  return which(shell) || shell
}

function meta(file: string) {
  return META[name(file)]
}

function ok(file: string) {
  return meta(file)?.deny !== true
}

function rooted(file: string) {
  return path.isAbsolute(FSUtil.windowsPath(file))
}

function resolve(file: string, opts?: { canonical?: boolean; directory?: string }) {
  const shell = full(
    opts?.directory && !rooted(file) && (file.includes("/") || file.includes("\\"))
      ? path.resolve(opts.directory, file)
      : file,
  )
  if (rooted(shell)) {
    const target = opts?.canonical ? canonical(shell) : shell
    if (target && stat(target)?.isFile()) return target
    return
  }
  const target = which(shell) ?? undefined
  return target && opts?.canonical ? canonical(target) : target
}

function canonical(file: string) {
  try {
    return realpathSync(file)
  } catch {
    return
  }
}

function win() {
  return Array.from(
    new Set(
      [which("pwsh"), which("powershell"), gitbash(), process.env.COMSPEC || "cmd.exe"]
        .filter((item): item is string => Boolean(item))
        .map(full),
    ),
  )
}

async function unix() {
  const text = await readFile("/etc/shells", "utf8").catch(() => "")
  if (text) return Array.from(new Set(text.split("\n").filter((line) => line.trim() && !line.startsWith("#"))))
  return ["/bin/bash", "/bin/zsh", "/bin/sh"]
}

function select(file: string | undefined, opts?: { acceptable?: boolean; canonical?: boolean; directory?: string }) {
  if (file && (!opts?.acceptable || ok(file))) {
    const shell = resolve(file, opts)
    if (shell) return shell
  }
  if (process.platform === "win32") return win()[0]
  return fallback()
}

export function gitbash() {
  if (process.platform !== "win32") return
  if (Flag.VECTOR_GIT_BASH_PATH) return Flag.VECTOR_GIT_BASH_PATH
  const git = which("git")
  if (!git) return
  const file = path.join(git, "..", "..", "bin", "bash.exe")
  if (stat(file)?.size) return file
}

function fallback() {
  if (process.platform === "darwin") return "/bin/zsh"
  const bash = which("bash")
  if (bash) return bash
  return "/bin/sh"
}

export function name(file: string) {
  if (process.platform === "win32") return path.win32.parse(FSUtil.windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

export function login(file: string) {
  return meta(file)?.login === true
}

export function posix(file: string) {
  return meta(file)?.posix === true
}

export function ps(file: string) {
  return meta(file)?.ps === true
}

function info(file: string): Item {
  const item = full(file)
  const n = name(item)
  return {
    path: item,
    name: resolve(n) ? n : item,
    acceptable: ok(item),
  }
}

export function args(file: string, command: string, cwd: string) {
  const n = name(file)
  if (n === "nu" || n === "fish") return ["-c", command]
  if (n === "zsh") {
    return [
      "-l",
      "-c",
      `
        [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
        [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${JSON.stringify(command)}
      `,
      "vector",
      cwd,
    ]
  }
  if (n === "bash") {
    return [
      "-l",
      "-c",
      `
        shopt -s expand_aliases
        [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${JSON.stringify(command)}
      `,
      "vector",
      cwd,
    ]
  }
  if (n === "cmd") return ["/c", command]
  if (ps(file)) return ["-NoProfile", "-Command", command]
  return ["-c", command]
}

/**
 * The command line a program started with `argv` runs, to show it: inside the bash and zsh wrapper `args` builds, the
 * line it evaluates, so the rc-file lines do not take its place; otherwise the program and its arguments as one line.
 */
export function commandLine(file: string, argv: readonly string[]) {
  const wrapped =
    argv.length === 5 && argv[0] === "-l" && argv[1] === "-c" && argv[3] === "vector"
      ? /\n\s*eval ("(?:[^"\\]|\\.)*")\s*$/.exec(argv[2])
      : null
  const line = wrapped ? Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))(wrapped[1]) : Option.none()
  return Option.getOrElse(line, () => [file, ...argv].join(" "))
}

/**
 * Quotes one value as a single literal word for the shell that will run it. cmd.exe expands %VAR% and ! even inside
 * quotes, so a value it cannot keep literal returns undefined and the caller refuses it.
 */
export function quote(file: string, value: string) {
  if (ps(file)) return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, (char) => char + char)}'`
  if (name(file) === "cmd") return /["%!\r\n]/.test(value) ? undefined : `"${value}"`
  return `'${value.replaceAll("'", `'\\''`)}'`
}

let defaultPreferred: string | undefined
let defaultAcceptable: string | undefined

export function preferred(configShell?: string, directory?: string) {
  if (configShell) return select(configShell, { canonical: true, directory })
  defaultPreferred ??= select(process.env.SHELL)
  return defaultPreferred
}
preferred.reset = () => {
  defaultPreferred = undefined
}

export function acceptable(configShell?: string) {
  if (configShell) return select(configShell, { acceptable: true })
  defaultAcceptable ??= select(process.env.SHELL, { acceptable: true })
  return defaultAcceptable
}
acceptable.reset = () => {
  defaultAcceptable = undefined
}

export async function list(): Promise<Item[]> {
  const shells = process.platform === "win32" ? win() : await unix()
  return shells.filter((s) => resolve(s)).map(info)
}
