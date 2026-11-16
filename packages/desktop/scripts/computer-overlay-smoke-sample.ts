import { spawn } from "node:child_process"

export const COMPUTER_SMOKE_SAMPLE_MARK = "computer-smoke-sample "
const SAMPLE_BYTES = 262_144
export const COMPUTER_SMOKE_SAMPLE_FRAMES = [
  "electron-window-close",
  "electron-window-destroy",
  "webcontents-destroy",
  "nswindow-close",
  "nswindow-order",
  "nswindow-display",
  "appkit-event-loop",
  "cf-run-loop",
  "uv",
  "v8",
  "dispatch-wait",
  "mutex-wait",
  "condition-wait",
  "ipc-wait",
  "mach-wait",
  "posix-io",
] as const
export type ComputerSmokeSampleFrame = (typeof COMPUTER_SMOKE_SAMPLE_FRAMES)[number]
export type ComputerSmokeSampleReport = {
  protocol: 1
  step: "heartbeat-check"
  status: "sampled" | "deadline" | "target-exited" | "unavailable" | "failed" | "output-cap"
  mainThread: boolean
  frames: ComputerSmokeSampleFrame[]
}

const frameKinds: readonly [ComputerSmokeSampleFrame, RegExp][] = [
  ["webcontents-destroy", /^electron::api::WebContents::(?:Destroy(?:WebContents)?|~WebContents)\b/],
  [
    "electron-window-close",
    /^electron::(?:api::)?(?:BaseWindow|BrowserWindow|NativeWindow(?:Mac)?)::Close(?:Immediately)?\b/,
  ],
  [
    "electron-window-destroy",
    /^electron::(?:api::)?(?:BaseWindow|BrowserWindow|NativeWindow(?:Mac)?)::(?:Destroy|~(?:BaseWindow|BrowserWindow|NativeWindow(?:Mac)?))\b/,
  ],
  ["nswindow-close", /^[-+]\[(?:NSWindow|NSPanel|ElectronNSWindow) (?:close|performClose:|_close)\]/],
  [
    "nswindow-order",
    /^[-+]\[(?:NSWindow|NSPanel|ElectronNSWindow) (?:order(?:Front|Back|Out|Window)[^ ]*|_doOrderWindow:|_reallyDoOrderWindow:)[ \]]/,
  ],
  [
    "nswindow-display",
    /^[-+]\[(?:NSWindow|NSPanel|ElectronNSWindow) (?:display(?:IfNeeded|IfNeededIgnoringOpacity)?|setFrame:display:|setFrame:display:animate:)[ \]]/,
  ],
  [
    "appkit-event-loop",
    /^(?:[-+]\[(?:NSApplication|ElectronApplication) (?:run|sendEvent:|nextEventMatchingMask:untilDate:inMode:dequeue:)\]|_DPSNextEvent\b|RunCurrentEventLoopInMode\b|ReceiveNextEventCommon\b)/,
  ],
  [
    "cf-run-loop",
    /^(?:CFRunLoopRun(?:Specific|InMode)?|__CFRunLoopRun|__CFRunLoopDo(?:Sources0|Source0|Blocks|Timers|Observers)|__CFRunLoopServiceMachPort)\b/,
  ],
  ["uv", /^uv_[A-Za-z0-9_]+\b/],
  ["v8", /^(?:v8::|Builtins_[A-Za-z0-9_]+\b)/],
  [
    "dispatch-wait",
    /^(?:_+dispatch_(?:semaphore_wait(?:_slow)?|group_wait(?:_slow)?|sync_f_slow|wait_for_queue)|__DISPATCH_WAIT_FOR_QUEUE__)\b/,
  ],
  [
    "mutex-wait",
    /^(?:(?:__psynch_mutexwait|_?pthread_mutex_lock|_?pthread_mutex_firstfit_lock_slow|_?os_unfair_lock_lock(?:_slow)?)\b|[-+]\[NSLock lock\])/,
  ],
  ["condition-wait", /^(?:__psynch_cvwait|_?pthread_cond_(?:wait|timedwait)(?:_relative_np)?)\b/],
  [
    "ipc-wait",
    /^(?:IPC::SyncChannel::WaitForReply|IPC::ChannelMojo::WaitForMessage|mojo::Wait|base::WaitableEvent::Wait(?:Many)?|CFMessagePortSendRequest)\b/,
  ],
  [
    "mach-wait",
    /^(?:mach_msg(?:2)?(?:_trap|_internal|_overwrite|_overwrite_trap)?|mach_msg2_internal|semaphore_wait_trap|semaphore_timedwait_trap)\b/,
  ],
  // A stack does not establish the descriptor's kind. Report the POSIX I/O family, never pipe ownership.
  ["posix-io", /^_{0,2}(?:read|write|poll|select|kevent)(?:64|_nocancel)?\b/],
]

/** Only counted frames within an explicitly named main-thread call graph contribute closed categories. */
export function computerSmokeMainThreadSample(
  raw: string,
  partial = false,
): Pick<ComputerSmokeSampleReport, "mainThread" | "frames"> {
  const result: Pick<ComputerSmokeSampleReport, "mainThread" | "frames"> = { mainThread: false, frames: [] }
  let graph = false
  const bounded = raw.slice(0, SAMPLE_BYTES)
  // A diagnostic deadline/cap may interrupt a frame; only newline-complete records are evidence.
  const complete = partial ? bounded.slice(0, bounded.lastIndexOf("\n") + 1) : bounded
  for (const line of complete.split(/\r?\n/)) {
    if (!graph) {
      if (/^\s*Call graph:\s*$/.test(line)) graph = true
      continue
    }
    if (/^\s*(?:\d+\s+)?Thread(?:_(?:0x)?[0-9a-f]+|\s+(?:0x)?[0-9a-f]+)(?:\s|:|$)/i.test(line)) {
      if (result.mainThread) break
      if (/\bMain Thread\b|\bcom\.apple\.main-thread\b/.test(line)) result.mainThread = true
      continue
    }
    if (/^\s*(?:Binary Images:|Total number in stack|Sort by top of stack|Call graph:|Analysis of sampling)/.test(line))
      break
    if (!result.mainThread) continue
    const frame = /^[ \t]*(?:[+!:|][ \t]*)*\d+[ \t]+(.+)$/.exec(line)
    if (!frame) continue
    // Library names, addresses and paths cannot cause a known function classification.
    const symbol = frame[1]!.split(/\s+\(in\b/, 1)[0]!.trim()
    const kind = frameKinds.find(([, pattern]) => pattern.test(symbol))?.[0]
    if (kind && result.frames.at(-1) !== kind) result.frames.push(kind)
    if (result.frames.length === 32) break
  }
  return result
}

/** Observe only the still-owned Electron process; raw sample bytes never leave this collector. */
export async function sampleOwnedComputerSmoke(target: {
  pid: number
  alive: () => boolean
  signal: AbortSignal
}): Promise<ComputerSmokeSampleReport> {
  const report = (status: ComputerSmokeSampleReport["status"]): ComputerSmokeSampleReport => ({
    protocol: 1,
    step: "heartbeat-check",
    status,
    mainThread: false,
    frames: [],
  })
  if (process.platform !== "darwin") return report("unavailable")
  if (!Number.isSafeInteger(target.pid) || target.pid <= 1) return report("target-exited")
  try {
    if (target.signal.aborted || !target.alive()) return report("target-exited")
  } catch {
    return report("failed")
  }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("/usr/bin/sample", [String(target.pid), "1", "10", "-file", "/dev/stdout"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch {
      resolve(report("unavailable"))
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    let ended = false
    const finish = (value: ComputerSmokeSampleReport) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      target.signal.removeEventListener("abort", abort)
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL")
        } catch {}
      }
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
      chunks.length = 0
      resolve(value)
    }
    const observed = (status: "sampled" | "deadline" | "output-cap" | "failed") => {
      try {
        if (target.signal.aborted || !target.alive()) return finish(report("target-exited"))
        if (status === "failed") return finish(report("failed"))
        finish({
          ...report(status),
          ...computerSmokeMainThreadSample(Buffer.concat(chunks).toString("utf8"), status !== "sampled"),
        })
      } catch {
        finish(report("failed"))
      }
    }
    const abort = () => finish(report("target-exited"))
    // Diagnostic tool startup/symbolication only; the functional watchdog remains unchanged.
    const timer = setTimeout(() => observed("deadline"), 8000)
    target.signal.addEventListener("abort", abort, { once: true })
    const capture = (chunk: Buffer, stdout: boolean) => {
      if (ended) return
      bytes += chunk.length
      if (bytes > SAMPLE_BYTES) return observed("output-cap")
      if (stdout) chunks.push(chunk)
    }
    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, true))
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, false))
    child.stdout?.once("error", () => finish(report("failed")))
    child.stderr?.once("error", () => finish(report("failed")))
    child.once("error", () => finish(report("unavailable")))
    child.once("close", (code) => {
      if (ended) return
      observed(code === 0 ? "sampled" : "failed")
    })
    try {
      if (target.signal.aborted || !target.alive()) abort()
    } catch {
      finish(report("failed"))
    }
  })
}
