import fs from "node:fs"
import { ChildProcess } from "effect/unstable/process"
import { GithubSecrets } from "./github.secrets"

export const BINARY = "/usr/bin/bwrap"
export const REFUSAL = "The GitHub run cannot isolate its tool processes. The command is refused."

export function required() {
  return GithubSecrets.credentials.isolatedTools()
}

export function assertBinary() {
  if (process.platform !== "linux") throw new Error(REFUSAL)
  const info = fs.lstatSync(BINARY, { throwIfNoEntry: false })
  if (!info?.isFile() || info.uid !== 0 || info.mode & 0o022 || fs.realpathSync(BINARY) !== BINARY)
    throw new Error(REFUSAL)
}

/** The filesystem keeps the same Unix permissions; tools receive a fresh PID namespace and its own proc mount. */
export function argumentsForTool(file: string, args: readonly string[], cwd: string) {
  return [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--chdir",
    cwd,
    "--",
    file,
    ...args,
  ]
}

export function command(input: ChildProcess.StandardCommand) {
  if (!required()) return input
  assertBinary()
  // Match the existing Linux shell option without passing a second command through an ambient shell.
  const file =
    typeof input.options.shell === "string" ? input.options.shell : input.options.shell ? "/bin/sh" : input.command
  const args = input.options.shell ? ["-c", [input.command, ...input.args].join(" ")] : input.args
  return ChildProcess.make(BINARY, argumentsForTool(file, args, input.options.cwd ?? process.cwd()), {
    ...input.options,
    shell: false,
  })
}

export * as GithubToolIsolation from "./github.tool-isolation"
