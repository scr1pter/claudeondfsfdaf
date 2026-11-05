import { describe, expect, test } from "bun:test"
import { computerSmokeMainThreadSample, COMPUTER_SMOKE_SAMPLE_FRAMES } from "./computer-overlay-smoke-sample"

describe("owned Electron main-thread sample sanitization", () => {
  test("retains ordered actual main-thread frame categories and excludes workers and metadata", () => {
    const sample = `Sampling process PRIVATE_PID
Process: PRIVATE_PROCESS
Path: /PRIVATE/path/electron::NativeWindowMac::Close
Call graph:
    100 Thread_1234: worker
    + 100 electron::api::WebContents::Destroy() (in PRIVATE)
    100 Thread_5678: Main Thread DispatchQueue_1: com.apple.main-thread (serial)
    + 100 electron::NativeWindowMac::CloseImmediately() (in PRIVATE_PATH) + 44
    + ! 90 -[NSWindow close] (in AppKit) + 3
    + ! 80 electron::api::WebContents::Destroy() (in Electron) + 12
    + | 70 __psynch_mutexwait (in libsystem_kernel.dylib) + 8
    + 20 PRIVATE_SYMBOL (in /PRIVATE/path/CFRunLoopRunSpecific) + 6
    100 Thread_9999: worker
    + 100 v8::Isolate::Dispose() (in PRIVATE)
Binary Images:
0xPRIVATE /PRIVATE/path
`
    const result = computerSmokeMainThreadSample(sample)
    expect(result).toEqual({
      mainThread: true,
      frames: ["electron-window-close", "nswindow-close", "webcontents-destroy", "mutex-wait"],
    })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|1234|5678|9999/)
  })

  test("a dispatch queue main-thread header is sufficient but arbitrary mentions are not", () => {
    expect(
      computerSmokeMainThreadSample(`Call graph:
  10 Thread_42: CrBrowserMain DispatchQueue_1: com.apple.main-thread (serial)
  + 10 CFRunLoopRunSpecific (in CoreFoundation) + 4
`),
    ).toEqual({ mainThread: true, frames: ["cf-run-loop"] })
    for (const sample of [
      "Process: Main Thread\n  10 Thread_42: Main Thread\n  + 10 uv_run (in PRIVATE)",
      "Call graph:\n  10 Thread_42: worker\n  + 10 Main Thread (in PRIVATE)",
      "Call graph:\nBinary Images:\n  10 Thread_42: Main Thread\n  + 10 uv_run (in PRIVATE)",
    ])
      expect(computerSmokeMainThreadSample(sample)).toEqual({ mainThread: false, frames: [] })
  })

  test("classifies only recognizable frame symbols with bounded closed output", () => {
    const symbols = [
      ["electron::api::BrowserWindow::Destroy()", "electron-window-destroy"],
      ["-[NSWindow orderOut:]", "nswindow-order"],
      ["-[NSWindow setFrame:display:animate:]", "nswindow-display"],
      ["-[NSApplication run]", "appkit-event-loop"],
      ["__CFRunLoopRun", "cf-run-loop"],
      ["uv_run", "uv"],
      ["v8::internal::Execution::Call", "v8"],
      ["_dispatch_semaphore_wait_slow", "dispatch-wait"],
      ["pthread_mutex_lock", "mutex-wait"],
      ["__psynch_cvwait", "condition-wait"],
      ["IPC::SyncChannel::WaitForReply()", "ipc-wait"],
      ["mach_msg2_trap", "mach-wait"],
      ["__read_nocancel", "posix-io"],
    ] as const
    const sample =
      "Call graph:\n  100 Thread_42: Main Thread\n" +
      symbols.map(([symbol]) => `  + 100 ${symbol} (in PRIVATE) + 1`).join("\n")
    const result = computerSmokeMainThreadSample(sample)
    expect(result).toEqual({ mainThread: true, frames: symbols.map(([, kind]) => kind) })
    expect(result.frames.every((kind) => COMPUTER_SMOKE_SAMPLE_FRAMES.includes(kind))).toBe(true)
    expect(
      computerSmokeMainThreadSample(
        "Call graph:\n  100 Thread_42: Main Thread\n  + 100 Builtins_JSEntryTrampoline (in PRIVATE)\n",
      ),
    ).toEqual({ mainThread: true, frames: ["v8"] })
    const unknown = "Call graph:\n  100 Thread_42: Main Thread\n" + "  + 100 PRIVATE (in PRIVATE)\n".repeat(1000)
    expect(computerSmokeMainThreadSample(unknown + "  + 100 mach_msg2_trap (in PRIVATE)\n")).toEqual({
      mainThread: true,
      frames: ["mach-wait"],
    })
    const many = "Call graph:\n  100 Thread_42: Main Thread\n" + "  + 100 PRIVATE (in PRIVATE)\n".repeat(1000)
    expect(computerSmokeMainThreadSample(many)).toEqual({ mainThread: true, frames: [] })
    const repeated = "Call graph:\n  100 Thread_42: Main Thread\n" + "  + 100 uv_run (in PRIVATE)\n".repeat(1000)
    expect(computerSmokeMainThreadSample(repeated)).toEqual({ mainThread: true, frames: ["uv"] })
    const bounded =
      "Call graph:\n  100 Thread_42: Main Thread\n" +
      "  + 100 uv_run (in PRIVATE)\n  + 100 mach_msg2_trap (in PRIVATE)\n".repeat(100)
    expect(computerSmokeMainThreadSample(bounded).frames).toEqual(
      Array.from({ length: 32 }, (_, index) => (index % 2 ? "mach-wait" : "uv")),
    )
  })

  test("partial diagnostics retain complete observed frames and discard an interrupted last frame", () => {
    const raw = "Call graph:\n  10 Thread_42: Main Thread\n  + 10 -[NSWindow close] (in AppKit)\n  + 10 v8::"
    expect(computerSmokeMainThreadSample(raw, true)).toEqual({ mainThread: true, frames: ["nswindow-close"] })
    expect(computerSmokeMainThreadSample(raw)).toEqual({ mainThread: true, frames: ["nswindow-close", "v8"] })
    expect(computerSmokeMainThreadSample("Call graph:\n  10 Thread_42: Main Thread\n  + 10 uv_run", true)).toEqual({
      mainThread: true,
      frames: [],
    })
  })

  test("ends at an aggregate header and never searches beyond the input bound", () => {
    expect(
      computerSmokeMainThreadSample(`Call graph:
  10 Thread_42: Main Thread
  + 10 uv_run (in PRIVATE)
Total number in stack (recursive counted multiple, when >=5):
  10 v8::Isolate::Dispose() (in PRIVATE)
`),
    ).toEqual({ mainThread: true, frames: ["uv"] })
    expect(
      computerSmokeMainThreadSample(" ".repeat(262_144) + "Call graph:\n  10 Thread_42: Main Thread\n  + 10 uv_run"),
    ).toEqual({ mainThread: false, frames: [] })
  })
})
