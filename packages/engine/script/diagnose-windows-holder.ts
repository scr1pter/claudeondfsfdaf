import { spawn } from "node:child_process"
import { access, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Readable, Writable } from "node:stream"
import { WindowsHolder } from "../src/tool/shell/windows-holder"

const STARTUP_MS = 15_000
const CLOSE_MS = 20_000
const MAX_REPORTED_MS = 60_000

const coldPhases = [
  "host-entered",
  "utility-loaded",
  "compiler-returned",
  "reading-config",
  "config-decoded",
  "job-configured",
  "creating-payload",
  "payload-created",
  "ready",
] as const

type ColdPhase = (typeof coldPhases)[number]
type Milestone = { phase: ColdPhase; elapsedMs: number }
type DeliveryEvent =
  | "launchReturnedMs"
  | "spawnEventMs"
  | "configWrittenMs"
  | "configWriteFailedMs"
  | "firstStderrMs"
  | "firstMarkerMs"
  | "watchdogMs"
  | "exitMs"
  | "closeMs"
  | "closeDeadlineMs"
type Observation = {
  phase: string
  ready: boolean
  closed: boolean
  proven: boolean
  timedOut: boolean
  timedOutAtMs?: number
  delivery?: Partial<Record<DeliveryEvent, number>>
}

interface DiagnosticChild {
  stdin: Pick<Writable, "on" | "write" | "end" | "destroy">
  stdout: Pick<Readable, "resume" | "destroy">
  stderr: Pick<Readable, "on" | "destroy">
  once(event: "spawn" | "error" | "exit" | "close", run: () => void): void
  kill(): void
}

const realClock = {
  now: () => performance.now(),
  schedule(run: () => void, delay: number) {
    const timer = setTimeout(run, delay)
    return () => clearTimeout(timer)
  },
}

// Instrument only this disposable copy. Removing the writes must restore the production script byte for byte.
export function coldHolderScript() {
  let script = WindowsHolder.script
  const mark = (at: string, phase: ColdPhase, language: "powershell" | "csharp") => {
    if (script.split(at).length !== 2) throw new Error("Missing or ambiguous holder diagnostic boundary: " + phase)
    const write =
      language === "powershell"
        ? `[Console]::Error.WriteLine('VECTOR_HOLDER_PHASE ${phase}'); `
        : `Console.Error.WriteLine("VECTOR_HOLDER_PHASE ${phase}"); `
    script = script.replace(at, () => write + at)
  }
  mark(WindowsHolder.preparation, "host-entered", "powershell")
  mark("Add-Type -TypeDefinition", "utility-loaded", "powershell")
  mark("exit [VectorShellHolder]::Run()", "compiler-returned", "powershell")
  mark("var stream=Console.OpenStandardInput();", "reading-config", "csharp")
  mark("if(cfg==null", "config-decoded", "csharp")
  mark("var sa=new SA();", "job-configured", "csharp")
  mark("Check(CreateProcessW", "creating-payload", "csharp")
  mark("var control=new Thread", "payload-created", "csharp")
  return script
}

export function startupTimeline() {
  const phases: Milestone[] = []
  return {
    phases,
    add(phase: string, elapsedMs: number) {
      const next = coldPhases[phases.length]
      if (!next || phase !== next) return false
      phases.push({ phase: next, elapsedMs: Math.round(elapsedMs) })
      return true
    },
  }
}

if (import.meta.main) await diagnose()

async function diagnose() {
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
  const baseline = { ...minimal, PATH: systemPath, PSModulePath: modulePath }
  const powershellKeys = /^(__PS|PS|POWERSHELL)/i
  const source = WindowsHolder.script
    // Negative control retains the pre-fix module-discovery path; it never resumes its disposable payload.
    .replace(WindowsHolder.preparation, "")
    .replace(
      "try { Add-Type",
      "[Console]::Error.WriteLine('VECTOR_HOLDER_PHASE host'); $null=Get-Command Add-Type -CommandType Cmdlet; [Console]::Error.WriteLine('VECTOR_HOLDER_PHASE compiler'); try { Add-Type",
    )
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
  const imported = [...args]
  imported[imported.length - 1] = Buffer.from(
    source.replace("$null=Get-Command Add-Type", WindowsHolder.preparation + "$null=Get-Command Add-Type"),
    "utf16le",
  ).toString("base64")
  if (imported[imported.length - 1]!.length > 32_000) throw new Error("Diagnostic exceeds Windows command-line bound")
  const cold = WindowsHolder.argumentsForHolder()
  cold[cold.length - 1] = Buffer.from(coldHolderScript(), "utf16le").toString("base64")
  if (cold[cold.length - 1]!.length > 32_000) throw new Error("Cold diagnostic exceeds Windows command-line bound")
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector-holder-startup-"))
  try {
    // First launch on a dedicated runner. The rest of the probes below retain their original control conditions.
    const timeline = startupTimeline()
    const first = await observe(minimal, cold, timeline)
    console.log(JSON.stringify({ mode: "production-cold", ...first, phases: timeline.phases }))
    if (!first.ready || !first.closed || !first.proven || first.timedOut || first.phase !== "ready") {
      process.exitCode = 1
    }
    for (const mode of [
      { name: "host-control", env: process.env },
      { name: "minimal-old", env: minimal },
      ...Object.entries(process.env)
        .filter(([key]) => powershellKeys.test(key))
        .slice(0, 8)
        .map(([key, value]) => ({ name: `powershell-key:${key}`, env: { ...baseline, [key]: value } })),
      { name: "strong-utility", env: minimal, args: imported },
    ]) {
      const started = performance.now()
      const result = await observe(mode.env, "args" in mode && mode.args ? mode.args : args)
      console.log(JSON.stringify({ mode: mode.name, ...result, elapsedMs: Math.round(performance.now() - started) }))
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }

  function variable(key: string) {
    return Object.entries(process.env).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1]
  }

  function observe(env: NodeJS.ProcessEnv, argv: string[], timeline?: ReturnType<typeof startupTimeline>) {
    return observeHolder(
      () =>
        spawn(powershell, argv, {
          cwd: path.win32.join(root!, "System32"),
          env,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      () =>
        JSON.stringify({
          file: path.win32.join(root!, "System32", "cmd.exe"),
          commandLine: "cmd.exe /d /s /c exit 19",
          cwd: directory,
          env: minimal,
        }) + "\n",
      timeline,
    )
  }
}

/** Closed delivery milestones for the first disposable holder. The program never emits config or stream contents. */
export function observeHolder(
  launch: () => DiagnosticChild,
  config: () => string,
  timeline?: ReturnType<typeof startupTimeline>,
  clock = realClock,
) {
  return new Promise<Observation>((resolve) => {
    const state: Observation = { phase: "spawn", ready: false, closed: false, proven: false, timedOut: false }
    const started = clock.now()
    const elapsed = () => clock.now() - started
    const delivery: Observation["delivery"] = timeline ? {} : undefined
    function mark(event: DeliveryEvent) {
      if (!delivery || delivery[event] !== undefined) return
      delivery[event] = Math.min(MAX_REPORTED_MS, Math.max(0, Math.round(elapsed() / 10) * 10))
    }
    const child = launch()
    mark("launchReturnedMs")
    const timeout = () => {
      if (state.timedOut) return
      mark("watchdogMs")
      state.timedOut = true
      if (timeline) state.timedOutAtMs = Math.round(elapsed())
      child.kill()
    }
    const cancelWatchdog = clock.schedule(timeout, timeline ? Math.max(0, STARTUP_MS - elapsed()) : STARTUP_MS)
    const cancelClose = clock.schedule(() => {
      mark("closeDeadlineMs")
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      finish()
    }, CLOSE_MS)
    function finish() {
      cancelWatchdog()
      cancelClose()
      resolve({ ...state, ...(delivery ? { delivery: { ...delivery } } : {}) })
    }
    child.once("spawn", () => mark("spawnEventMs"))
    child.once("exit", () => mark("exitMs"))
    child.stdin.on("error", () => {})
    child.stdout.resume()
    let pending = ""
    let bytes = 0
    child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length) mark("firstStderrMs")
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
        if (timeline && line.startsWith("VECTOR_HOLDER_PHASE ")) {
          const phase = line.slice("VECTOR_HOLDER_PHASE ".length)
          if (!timeline.add(phase, elapsed())) {
            state.phase = "invalid-status"
            child.kill()
            return
          }
          if (phase === "host-entered") mark("firstMarkerMs")
          state.phase = phase
          continue
        }
        if (!timeline && /^VECTOR_HOLDER_PHASE (host|compiler|configuration|decoded|job|payload)$/.test(line)) {
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
          if (value.type === "startup" && "step" in value && value.step === 1 && Object.keys(value).length === 2)
            mark("firstMarkerMs")
          if (value.type === "ready") {
            if (timeline) {
              const time = elapsed()
              if (state.timedOut || time >= STARTUP_MS) {
                timeout()
                return
              }
              if (!timeline.add("ready", time)) {
                state.phase = "invalid-status"
                child.kill()
                return
              }
              cancelWatchdog()
            }
            state.ready = true
            state.phase = "ready"
            // EOF cleans up the suspended payload. The diagnostic never acknowledges it.
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
      mark("closeMs")
      state.closed = true
      finish()
    })
    child.stdin.write(config(), (error) => mark(error ? "configWriteFailedMs" : "configWrittenMs"))
  })
}
