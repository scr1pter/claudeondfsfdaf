import { spawn } from "node:child_process"
import { access, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WindowsHolder } from "../src/tool/shell/windows-holder"

// Disposable native diagnostics only. Never print environment values, user commands or native error text.
if (process.platform !== "win32") throw new Error("This diagnostic requires native Windows")
const root = variable("SystemRoot")
if (!root || !path.win32.isAbsolute(root)) throw new Error("Missing Windows system directory")
const powershell = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
await access(powershell)
const minimal = Object.fromEntries(
  ["SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap((key) => {
    const value = variable(key)
    return value ? [[key, value]] : []
  }),
)
const systemPath = [path.win32.join(root, "System32"), root, path.win32.dirname(powershell)].join(";")
const modulePath = path.win32.join(path.win32.dirname(powershell), "Modules")
const profile = Object.fromEntries(
  ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "ProgramData", "ProgramFiles"].flatMap((key) => {
    const value = variable(key)
    return value ? [[key, value]] : []
  }),
)
const source = WindowsHolder.script
  .replace("try { Add-Type", "[Console]::Error.WriteLine('VECTOR_HOLDER_PHASE host'); try { Add-Type")
  .replace(
    "var stream=Console.OpenStandardInput();",
    'Console.Error.WriteLine("VECTOR_HOLDER_PHASE configuration"); var stream=Console.OpenStandardInput();',
  )
  .replace(
    "var json=new JavaScriptSerializer();",
    'Console.Error.WriteLine("VECTOR_HOLDER_PHASE decoded"); var json=new JavaScriptSerializer();',
  )
  .replace("job=CreateJobObjectW", 'Console.Error.WriteLine("VECTOR_HOLDER_PHASE job"); job=CreateJobObjectW')
  .replace("Check(CreateProcessW", 'Console.Error.WriteLine("VECTOR_HOLDER_PHASE payload"); Check(CreateProcessW')
const args = WindowsHolder.argumentsForHolder()
args[args.length - 1] = Buffer.from(source, "utf16le").toString("base64")
if (args[args.length - 1]!.length > 32_000) throw new Error("Diagnostic exceeds Windows command-line bound")
const directory = await mkdtemp(path.join(os.tmpdir(), "vector-holder-startup-"))
try {
  for (const mode of [
    { name: "host-control", env: process.env },
    { name: "minimal", env: minimal },
    { name: "system-path", env: { ...minimal, PATH: systemPath } },
    { name: "module-path", env: { ...minimal, PATH: systemPath, PSModulePath: modulePath } },
    { name: "profile", env: { ...minimal, ...profile, PATH: systemPath, PSModulePath: modulePath } },
  ]) {
    const started = performance.now()
    const result = await observe(mode.env)
    console.log(JSON.stringify({ mode: mode.name, ...result, elapsedMs: Math.round(performance.now() - started) }))
  }
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function variable(key: string) {
  return Object.entries(process.env).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1]
}

function observe(env: NodeJS.ProcessEnv) {
  return new Promise<{ phase: string; ready: boolean; closed: boolean; proven: boolean; timedOut: boolean }>(
    (resolve) => {
      const state = { phase: "spawn", ready: false, closed: false, proven: false, timedOut: false }
      const child = spawn(powershell, args, {
        cwd: path.win32.join(root!, "System32"),
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
      const timer = setTimeout(() => {
        state.timedOut = true
        child.kill()
      }, 15_000)
      const closeTimer = setTimeout(() => {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        resolve(state)
      }, 20_000)
      child.stdin.on("error", () => {})
      child.stdout.resume()
      let pending = ""
      let bytes = 0
      child.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 16_384) {
          state.phase = "status-bound"
          child.kill()
          return
        }
        pending += chunk.toString("utf8")
        for (;;) {
          const end = pending.indexOf("\n")
          if (end < 0) return
          const line = pending.slice(0, end).replace(/\r$/, "")
          pending = pending.slice(end + 1)
          if (/^VECTOR_HOLDER_PHASE (host|configuration|decoded|job|payload)$/.test(line)) {
            state.phase = line.slice(20)
            continue
          }
          if (!line.startsWith("VECTOR_SHELL/1 ")) {
            state.phase = "invalid-status"
            child.kill()
            return
          }
          try {
            const value: unknown = JSON.parse(line.slice(15))
            if (!value || typeof value !== "object" || !("type" in value)) throw new Error("Invalid status")
            if (value.type === "ready") {
              state.ready = true
              state.phase = "ready"
              // Never acknowledge/resume the payload: EOF must clean up the suspended process instead.
              child.stdin.end()
            }
            if (value.type === "error" && "terminationProven" in value) state.proven = value.terminationProven === true
          } catch {
            state.phase = "invalid-status"
            child.kill()
          }
        }
      })
      child.once("error", () => {
        state.phase = "spawn-error"
      })
      child.once("close", () => {
        state.closed = true
        clearTimeout(timer)
        clearTimeout(closeTimer)
        resolve(state)
      })
      child.stdin.write(
        JSON.stringify({
          file: path.win32.join(root!, "System32", "cmd.exe"),
          commandLine: "cmd.exe /d /s /c exit 19",
          cwd: directory,
          env: minimal,
        }) + "\n",
      )
    },
  )
}
