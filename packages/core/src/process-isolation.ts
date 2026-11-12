import fs from "node:fs"
import path from "node:path"

export const BINARY = "/usr/bin/bwrap"
export const REFUSAL = "The GitHub run cannot isolate its tool processes. The command is refused."
let enabled = false

/** Called once by the actual private-channel loader. There is deliberately no lowering/reset API. */
export function requireIsolation() {
  enabled = true
}

export function required() {
  return enabled
}

export function assertBinary() {
  if (process.platform !== "linux") throw new Error(REFUSAL)
  const info = fs.lstatSync(BINARY, { throwIfNoEntry: false })
  if (!info?.isFile() || info.uid !== 0 || info.mode & 0o022 || fs.realpathSync(BINARY) !== BINARY)
    throw new Error(REFUSAL)
}

/** Files retain their existing Unix permissions. Only the trusted engine keeps a host PID; its proc mount is empty. */
export function engineArguments(file: string, args: readonly string[], cwd: string) {
  return [
    "--die-with-parent",
    "--bind",
    "/",
    "/",
    // Ordinary binds are nodev; mount only bwrap's standard private devices, never the host /dev tree.
    "--dev",
    "/dev",
    "--tmpfs",
    "/proc",
    "--remount-ro",
    "/proc",
    // These capabilities exist only in the trusted root bridge before setpriv drops the UID and sets no-new-privs.
    "--cap-add",
    "CAP_SETUID",
    "--cap-add",
    "CAP_SETGID",
    "--cap-add",
    "CAP_DAC_OVERRIDE",
    "--chdir",
    cwd,
    "--",
    file,
    ...args,
  ]
}

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
    // Ordinary binds are nodev; mount only bwrap's standard private devices, never the host /dev tree.
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--chdir",
    cwd,
    "--",
    file,
    ...args,
  ]
}

export function launch(
  file: string,
  args: readonly string[],
  options: { cwd?: string; shell?: boolean | string; env?: NodeJS.ProcessEnv } = {},
) {
  if (!required()) return { file, args: [...args], shell: options.shell }
  assertLoaderEnvironment(options.env ?? process.env)
  assertBinary()
  const executable = typeof options.shell === "string" ? options.shell : options.shell ? "/bin/sh" : file
  const argv = options.shell ? ["-c", [file, ...args].join(" ")] : args
  return { file: BINARY, args: argumentsForTool(executable, argv, options.cwd ?? process.cwd()), shell: false }
}

const KERNEL = ["/proc", "/sys", "/dev/fd", "/dev/stdin", "/dev/stdout", "/dev/stderr"]

/** Native loader hooks run before bwrap can enter its namespaces; configuration validation is not the final boundary. */
export function assertLoaderEnvironment(env: NodeJS.ProcessEnv) {
  if (
    Object.entries(env).some(
      ([name, value]) =>
        value !== undefined &&
        (/^(?:LD_|DYLD_)/.test(name) ||
          ["GCONV_PATH", "GLIBC_TUNABLES", "LOCPATH", "NLSPATH", "LIBPATH", "SHLIB_PATH"].includes(name)),
    )
  )
    throw new Error("GitHub agent tools cannot set a native loader environment.")
}

/** Refuse kernel paths before a filesystem tool asks permission, including links that traverse a kernel alias. */
export function assertToolPath(target: string) {
  if (!required()) return
  assertKernelPath(target)
}

export function assertKernelPath(target: string) {
  let pending = (path.isAbsolute(target) ? target : process.cwd() + "/" + target).split("/").filter(Boolean)
  let current = "/"
  let links = 0
  while (pending.length) {
    const part = pending.shift()!
    if (part === ".") continue
    if (part === "..") {
      current = path.dirname(current)
      continue
    }
    const candidate = path.join(current, part)
    if (KERNEL.some((prefix) => candidate === prefix || candidate.startsWith(prefix + "/")))
      throw new Error("GitHub agent tools cannot access kernel process files.")
    const info = fs.lstatSync(candidate, { throwIfNoEntry: false })
    if (!info?.isSymbolicLink()) {
      current = candidate
      continue
    }
    if (++links > 40) throw new Error("GitHub agent tools cannot resolve this file safely.")
    const link = fs.readlinkSync(candidate)
    pending = [
      ...(path.isAbsolute(link) ? link : path.dirname(candidate) + "/" + link).split("/").filter(Boolean),
      ...pending,
    ]
    current = "/"
  }
}

export * as ProcessIsolation from "./process-isolation"
