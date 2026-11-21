import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import path from "node:path"

export type ComputerSmokeRegionRect = { x: number; y: number; width: number; height: number }
export type ComputerSmokeWindowRegion = {
  index: number
  windowRect: ComputerSmokeRegionRect
  regionRect: ComputerSmokeRegionRect
  owned: true
  simple: true
  matches: boolean
}
export type ComputerSmokeWindowRegions =
  | { ok: true; windows: ComputerSmokeWindowRegion[]; elapsed?: ComputerSmokeRegionElapsed }
  | { ok: false; reason: ComputerSmokeRegionFailure; elapsed?: ComputerSmokeRegionElapsed }
export const COMPUTER_SMOKE_REGION_FAILURES = [
  "unsupported_platform",
  "invalid_windows",
  "launch",
  "compile",
  "parent",
  "owner",
  "region",
  "liveness",
  "output",
  "deadline",
  "deadline_launch",
  "deadline_compile",
  "deadline_input",
  "deadline_parent",
  "deadline_region",
  "deadline_output",
] as const
export type ComputerSmokeRegionFailure = (typeof COMPUTER_SMOKE_REGION_FAILURES)[number]
const REGION_RUNNER_FAILURES = [
  "launch",
  "output",
  "deadline",
  "deadline_launch",
  "deadline_compile",
  "deadline_input",
  "deadline_parent",
  "deadline_region",
  "deadline_output",
] as const
type RegionRunnerFailure = (typeof REGION_RUNNER_FAILURES)[number]
type RegionRequest = {
  command: string
  args: string[]
  stdin: string
  timeoutMs: number
  maxBytes: number
}
export type ComputerSmokeRegionRunner = (request: RegionRequest) => Promise<{
  code: number | null
  stdout: string
  failed?: boolean
  reason?: RegionRunnerFailure
  elapsed?: ComputerSmokeRegionElapsed
}>
const LIMIT = 65_536
/** The whole observer limit: process start, the in-process Add-Type compile and every native read. */
export const COMPUTER_SMOKE_REGION_TIMEOUT_MS = 15_000
export const COMPUTER_SMOKE_REGION_PHASE_MARK = "computer-region-phase "
export const COMPUTER_SMOKE_REGION_PHASES = ["compile", "input", "parent", "region", "output"] as const
/** Whole milliseconds from spawn until each trusted marker first arrived, for the phases reached only. */
export type ComputerSmokeRegionElapsed = Partial<Record<(typeof COMPUTER_SMOKE_REGION_PHASES)[number], number>>
export type ComputerSmokeRegionProgress = {
  phase?: (typeof COMPUTER_SMOKE_REGION_PHASES)[number]
  count: number
  invalid: boolean
}

/** Only complete fixed markers survive; all other stderr and bounded partial lines are discarded. */
export function computerSmokeRegionProgress() {
  let pending = "",
    dropping = false,
    closed = false,
    invalid = false,
    bytes = 0,
    marked = 0,
    count = 0
  let phase: ComputerSmokeRegionProgress["phase"]
  const line = (value: string) => {
    if (!value.startsWith(COMPUTER_SMOKE_REGION_PHASE_MARK) || invalid) return
    const expected = COMPUTER_SMOKE_REGION_PHASES[count]
    if (
      expected === undefined ||
      value !== COMPUTER_SMOKE_REGION_PHASE_MARK + expected ||
      marked + Buffer.byteLength(value, "utf8") + 1 > 256
    ) {
      invalid = true
      return
    }
    phase = expected
    count++
    marked += Buffer.byteLength(value, "utf8") + 1
  }
  return {
    reached: () => count,
    feed(chunk: Buffer | string) {
      if (closed) return
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      bytes += Buffer.byteLength(text, "utf8")
      if (bytes > LIMIT) {
        invalid = true
        pending = ""
        dropping = true
        return
      }
      for (const character of text) {
        if (character === "\n") {
          if (!dropping) line(pending.endsWith("\r") ? pending.slice(0, -1) : pending)
          pending = ""
          dropping = false
        } else if (!dropping) {
          if (pending.length >= 256) {
            if (pending.startsWith(COMPUTER_SMOKE_REGION_PHASE_MARK)) invalid = true
            pending = ""
            dropping = true
          } else pending += character
        }
      }
    },
    finish(): ComputerSmokeRegionProgress {
      if (!closed && !dropping && pending.startsWith(COMPUTER_SMOKE_REGION_PHASE_MARK)) invalid = true
      closed = true
      pending = ""
      return { ...(phase === undefined ? {} : { phase }), count, invalid }
    },
  }
}

/** Accepts only an ordered prefix of phases with nondecreasing whole milliseconds inside the observer limit. */
export function computerSmokeRegionElapsed(value: unknown, limit: number): ComputerSmokeRegionElapsed | undefined {
  if (!record(value)) return
  const keys = Object.keys(value)
  const phases = COMPUTER_SMOKE_REGION_PHASES.slice(0, keys.length)
  if (
    keys.length > COMPUTER_SMOKE_REGION_PHASES.length ||
    !keys.every((key) => (phases as readonly string[]).includes(key))
  )
    return
  const values = phases.map((phase) => value[phase])
  if (
    !values.every(
      (item, index): item is number =>
        typeof item === "number" &&
        Number.isSafeInteger(item) &&
        item >= 0 &&
        item <= limit &&
        (index === 0 || item >= Number(values[index - 1])),
    )
  )
    return
  return Object.fromEntries(phases.map((phase, index) => [phase, values[index]]))
}

export function computerSmokeRegionDeadline(
  progress: ComputerSmokeRegionProgress,
  spawned: boolean,
): RegionRunnerFailure {
  const index = COMPUTER_SMOKE_REGION_PHASES.indexOf(progress.phase!)
  if (
    progress.invalid ||
    !Number.isSafeInteger(progress.count) ||
    progress.count < 0 ||
    progress.count > 5 ||
    (progress.phase === undefined ? progress.count !== 0 : index < 0 || progress.count !== index + 1)
  )
    return "deadline"
  if (progress.phase !== undefined) return `deadline_${progress.phase}`
  return spawned ? "deadline_launch" : "deadline"
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key))
const rectangle = (value: unknown): value is ComputerSmokeRegionRect =>
  record(value) &&
  exact(value, ["x", "y", "width", "height"]) &&
  [value.x, value.y, value.width, value.height].every(
    (item) => typeof item === "number" && Number.isSafeInteger(item) && Math.abs(item) <= 1_000_000,
  ) &&
  Number(value.width) > 0 &&
  Number(value.height) > 0
const same = (left: ComputerSmokeRegionRect, right: ComputerSmokeRegionRect) =>
  left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
const copy = (value: ComputerSmokeRegionRect) => ({ x: value.x, y: value.y, width: value.width, height: value.height })

/** Strictly read-only native bridge. All handles enter over bounded stdin and never appear in output. */
const REGION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$probe = $null
$phase = 'compile'
$compiled = $false
try {
  [Console]::Error.WriteLine('computer-region-phase compile')
  [Console]::Error.Flush()
  $source = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
public sealed class VectorOwnedWindowRegions : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr ExitStatus, Peb, Affinity, Priority; public UIntPtr Pid, Parent; }
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, out Basic information, int size, out int returned);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process, uint timeout);
  [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flag);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetWindowRect(IntPtr window, out Rect bounds);
  [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr window, IntPtr region);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
  [DllImport("gdi32.dll")] static extern int GetRgnBox(IntPtr region, out Rect bounds);
  [DllImport("gdi32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool DeleteObject(IntPtr value);
  IntPtr parent;
  readonly uint parentPid;
  readonly ulong parentStart;
  readonly int count;
  readonly uint thread;
  IntPtr previousDpi;
  public static string FailureStage { get; private set; }
  readonly List<ulong> handles = new List<ulong>();
  readonly List<string> rows = new List<string>();
  static void Require(bool value) { if (!value) throw new InvalidOperationException(); }
  static ulong Started(IntPtr process) {
    FileTime created, exited, kernel, user;
    Require(GetProcessTimes(process, out created, out exited, out kernel, out user));
    return ((ulong)created.High << 32) | created.Low;
  }
  static uint KernelParent() {
    Basic basic; int returned;
    Require(NtQueryInformationProcess(GetCurrentProcess(), 0, out basic, Marshal.SizeOf(typeof(Basic)), out returned) == 0);
    Require(returned == Marshal.SizeOf(typeof(Basic)) && basic.Pid.ToUInt64() == GetCurrentProcessId());
    ulong pid = basic.Parent.ToUInt64();
    Require(pid > 0 && pid <= UInt32.MaxValue && pid != GetCurrentProcessId());
    return (uint)pid;
  }
  public VectorOwnedWindowRegions(int count) {
    FailureStage = "parent";
    Require(count > 0 && count <= 256); this.count = count;
    thread = GetCurrentThreadId();
    try {
      previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
      Require(previousDpi != IntPtr.Zero && AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4)));
      parentPid = KernelParent();
      parent = OpenProcess(0x00101000, false, parentPid); // limited query + synchronization only
      Require(parent != IntPtr.Zero);
      parentStart = Started(parent);
      Require(parentStart > 0 && parentStart < Started(GetCurrentProcess()));
      ParentCurrent();
    } catch { string stage = FailureStage; try { Dispose(); } catch {} FailureStage = stage; throw; }
  }
  void ParentCurrent() {
    FailureStage = "liveness";
    Require(GetCurrentThreadId() == thread && AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4)));
    Require(parent != IntPtr.Zero && WaitForSingleObject(parent, 0) == 0x102);
    Require(KernelParent() == parentPid && GetProcessId(parent) == parentPid && Started(parent) == parentStart);
  }
  static bool Valid(Rect value) {
    long width = (long)value.Right - value.Left, height = (long)value.Bottom - value.Top;
    return Math.Abs((long)value.Left) <= 1000000 && Math.Abs((long)value.Top) <= 1000000 && width > 0 && width <= 1000000 && height > 0 && height <= 1000000;
  }
  Rect OwnedRect(IntPtr window) {
    FailureStage = "owner";
    uint pid; Rect bounds;
    Require(IsWindow(window) && GetAncestor(window, 2) == window);
    Require(GetWindowThreadProcessId(window, out pid) != 0 && pid == parentPid);
    Require(GetWindowRect(window, out bounds) && Valid(bounds));
    return bounds;
  }
  static string Number(int value) { return value.ToString(CultureInfo.InvariantCulture); }
  static string JsonRect(Rect value) {
    return "{\"x\":" + Number(value.Left) + ",\"y\":" + Number(value.Top) + ",\"width\":" + Number(value.Right - value.Left) + ",\"height\":" + Number(value.Bottom - value.Top) + "}";
  }
  public void Observe(string encoded, int x, int y, int width, int height) {
    ParentCurrent(); Require(rows.Count < count && encoded != null && encoded.Length > 0 && encoded.Length <= 16);
    foreach (char ch in encoded) Require((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'));
    ulong handle; Require(UInt64.TryParse(encoded, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out handle) && handle != 0);
    Require(IntPtr.Size == 8 || handle <= UInt32.MaxValue); Require(!handles.Contains(handle)); handles.Add(handle);
    IntPtr window = IntPtr.Size == 8 ? new IntPtr(unchecked((long)handle)) : new IntPtr(unchecked((int)handle));
    Rect expected = new Rect { Left = x, Top = y, Right = checked(x + width), Bottom = checked(y + height) };
    Require(Valid(expected));
    Rect before = OwnedRect(window), box = new Rect();
    FailureStage = "region";
    IntPtr region = CreateRectRgn(0, 0, 0, 0); Require(region != IntPtr.Zero);
    try {
      Require(GetWindowRgn(window, region) == 2 && GetRgnBox(region, out box) == 2);
      Require(box.Left >= 0 && box.Top >= 0 && box.Right > box.Left && box.Bottom > box.Top);
      Require((long)box.Right <= (long)before.Right - before.Left && (long)box.Bottom <= (long)before.Bottom - before.Top);
      Rect global = new Rect { Left = checked(before.Left + box.Left), Top = checked(before.Top + box.Top), Right = checked(before.Left + box.Right), Bottom = checked(before.Top + box.Bottom) };
      Require(Valid(global));
      Rect after = OwnedRect(window);
      Require(before.Left == after.Left && before.Top == after.Top && before.Right == after.Right && before.Bottom == after.Bottom);
      ParentCurrent();
      FailureStage = "output";
      bool matches = global.Left == expected.Left && global.Top == expected.Top && global.Right == expected.Right && global.Bottom == expected.Bottom;
      rows.Add("{\"index\":" + Number(rows.Count) + ",\"windowRect\":" + JsonRect(before) + ",\"regionRect\":" + JsonRect(global) + ",\"owned\":true,\"simple\":true,\"matches\":" + (matches ? "true" : "false") + "}");
    } finally { Require(DeleteObject(region)); }
  }
  public string Finish() {
    ParentCurrent(); Require(rows.Count == count);
    FailureStage = "output";
    return "{\"protocol\":1,\"ok\":true,\"windows\":[" + String.Join(",", rows.ToArray()) + "]}";
  }
  public void Dispose() {
    FailureStage = "liveness";
    bool valid = true;
    if (parent != IntPtr.Zero) { valid = CloseHandle(parent); parent = IntPtr.Zero; }
    if (previousDpi != IntPtr.Zero) {
      IntPtr old = previousDpi; previousDpi = IntPtr.Zero;
      valid = GetCurrentThreadId() == thread && SetThreadDpiAwarenessContext(old) != IntPtr.Zero && AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), old) && valid;
    }
    Require(valid);
  }
}
'@
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  $compiled = $true
  [Console]::Error.WriteLine('computer-region-phase input')
  [Console]::Error.Flush()
  $phase = 'output'
  $buffer = New-Object char[] 1024
  $builder = New-Object System.Text.StringBuilder
  while (($read = [Console]::In.Read($buffer, 0, $buffer.Length)) -gt 0) {
    if (($builder.Length + $read) -gt 65536) { throw 'invalid' }
    [void]$builder.Append($buffer, 0, $read)
    if ([Text.Encoding]::UTF8.GetByteCount($builder.ToString()) -gt 65536) { throw 'invalid' }
  }
  $text = $builder.ToString()
  $request = ConvertFrom-Json -InputObject $text
  if ($request.protocol -ne 1 -or @($request.windows).Count -lt 1 -or @($request.windows).Count -gt 256) { throw 'invalid' }
  $entries = @($request.windows)
  $count = $entries.Count
  $phase = 'parent'
  [Console]::Error.WriteLine('computer-region-phase parent')
  [Console]::Error.Flush()
  $probe = New-Object -TypeName VectorOwnedWindowRegions -ArgumentList $count
  [Console]::Error.WriteLine('computer-region-phase region')
  [Console]::Error.Flush()
  foreach ($entry in $entries) {
    $probe.Observe([string]$entry.handle, [int]$entry.expected.x, [int]$entry.expected.y, [int]$entry.expected.width, [int]$entry.expected.height)
  }
  [Console]::Error.WriteLine('computer-region-phase output')
  [Console]::Error.Flush()
  $result = $probe.Finish()
  if ([Text.Encoding]::UTF8.GetByteCount($result) -gt 65536) { throw 'invalid' }
  $probe.Dispose()
  $probe = $null
  $phase = 'output'
  [Console]::Out.WriteLine($result)
} catch {
  if ($compiled) {
    try {
      $stage = [VectorOwnedWindowRegions]::FailureStage
      if (@('parent', 'owner', 'region', 'liveness', 'output') -contains $stage) { $phase = $stage }
    } catch {}
  }
  [Console]::Out.WriteLine('{"protocol":1,"ok":false,"reason":"' + $phase + '"}')
  exit 1
} finally {
  if ($null -ne $probe) { try { $probe.Dispose() } catch {} }
}
`

/** One spawned child under one timer armed at spawn; marker arrival times are measured here, outside the script. */
export const runComputerSmokeRegionBridge: ComputerSmokeRegionRunner = (request) =>
  new Promise((resolve) => {
    const started = performance.now()
    const child = spawn(request.command, request.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    let settled = false,
      spawned = false,
      bytes = 0
    const stdout: Buffer[] = []
    const progress = computerSmokeRegionProgress()
    const elapsed: ComputerSmokeRegionElapsed = {}
    const finish = (code: number | null, received?: RegionRunnerFailure) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const observed = progress.finish()
      const reason = received === "deadline" ? computerSmokeRegionDeadline(observed, spawned) : received
      if (reason) {
        child.kill()
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
      }
      resolve({
        code,
        stdout: reason ? "" : Buffer.concat(stdout).toString("utf8"),
        failed: Boolean(reason),
        ...(reason ? { reason } : {}),
        elapsed: { ...elapsed },
      })
    }
    const timer = setTimeout(() => finish(null, "deadline"), request.timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > request.maxBytes) return finish(null, "output")
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > request.maxBytes) return finish(null, "output")
      const before = progress.reached()
      progress.feed(chunk)
      // A chunk handled before a late timer callback is still inside the budget, so the value is capped at it.
      const now = Math.min(request.timeoutMs, Math.floor(performance.now() - started))
      for (const phase of COMPUTER_SMOKE_REGION_PHASES.slice(before, progress.reached())) elapsed[phase] = now
    })
    child.once("spawn", () => {
      spawned = true
    })
    child.once("error", () => finish(null, "launch"))
    child.once("close", (code) => finish(code))
    child.stdout.once("error", () => finish(null, "output"))
    child.stderr.once("error", () => finish(null, "output"))
    child.stdin.once("error", () => finish(null, "output"))
    child.stdin.end(request.stdin)
  })

export function parseComputerSmokeWindowRegions(
  stdout: string,
  expected: ComputerSmokeRegionRect[],
): ComputerSmokeWindowRegions {
  if (
    Buffer.byteLength(stdout, "utf8") > LIMIT ||
    expected.length < 1 ||
    expected.length > 256 ||
    !expected.every(rectangle)
  )
    throw new Error("The computer smoke region proof exceeded its bounds.")
  const value: unknown = JSON.parse(stdout)
  if (!record(value) || value.protocol !== 1 || typeof value.ok !== "boolean")
    throw new Error("The computer smoke region proof is invalid.")
  if (!value.ok) {
    if (
      !exact(value, ["protocol", "ok", "reason"]) ||
      typeof value.reason !== "string" ||
      !["compile", "parent", "owner", "region", "liveness", "output"].includes(value.reason)
    )
      throw new Error("The computer smoke region proof is invalid.")
    return { ok: false, reason: value.reason as ComputerSmokeRegionFailure }
  }
  if (
    !exact(value, ["protocol", "ok", "windows"]) ||
    !Array.isArray(value.windows) ||
    value.windows.length !== expected.length
  )
    throw new Error("The computer smoke region proof is incomplete.")
  const windows = value.windows.map((entry, index): ComputerSmokeWindowRegion => {
    if (
      !record(entry) ||
      !exact(entry, ["index", "windowRect", "regionRect", "owned", "simple", "matches"]) ||
      entry.index !== index ||
      entry.owned !== true ||
      entry.simple !== true ||
      typeof entry.matches !== "boolean" ||
      !rectangle(entry.windowRect) ||
      !rectangle(entry.regionRect)
    )
      throw new Error("The computer smoke region observation is invalid.")
    const outer = entry.windowRect,
      region = entry.regionRect
    if (
      region.x < outer.x ||
      region.y < outer.y ||
      region.x + region.width > outer.x + outer.width ||
      region.y + region.height > outer.y + outer.height ||
      entry.matches !== same(region, expected[index]!)
    )
      throw new Error("The computer smoke region observation does not match its claim.")
    return {
      index,
      windowRect: copy(outer),
      regionRect: copy(region),
      owned: true,
      simple: true,
      matches: entry.matches,
    }
  })
  return { ok: true, windows }
}

/** CI-only own-window reads. An unavailable bridge is a failed proof, never a successful geometry fallback. */
export async function observeComputerSmokeWindowRegions(
  windows: { handle: Buffer; expected: ComputerSmokeRegionRect }[],
  dependencies: { run?: ComputerSmokeRegionRunner } = {},
): Promise<ComputerSmokeWindowRegions> {
  if (
    !Array.isArray(windows) ||
    windows.length < 1 ||
    windows.length > 256 ||
    windows.some(
      (entry) =>
        !record(entry) ||
        !exact(entry, ["handle", "expected"]) ||
        !Buffer.isBuffer(entry.handle) ||
        ![4, 8].includes(entry.handle.length) ||
        !rectangle(entry.expected),
    )
  )
    return { ok: false, reason: "invalid_windows" }
  const handles = windows.map((entry) =>
    (entry.handle.length === 8 ? entry.handle.readBigUInt64LE() : BigInt(entry.handle.readUInt32LE())).toString(16),
  )
  if (handles.some((handle) => handle === "0") || new Set(handles).size !== handles.length)
    return { ok: false, reason: "invalid_windows" }
  const stdin = JSON.stringify({
    protocol: 1,
    windows: windows.map((entry, index) => ({ handle: handles[index], expected: copy(entry.expected) })),
  })
  if (Buffer.byteLength(stdin, "utf8") > LIMIT) return { ok: false, reason: "invalid_windows" }
  if (process.platform !== "win32" && !dependencies.run) return { ok: false, reason: "unsupported_platform" }
  const command = protectedPowerShell()
  if (!command) return { ok: false, reason: "launch" }
  try {
    const result = await (dependencies.run ?? runComputerSmokeRegionBridge)({
      // CI's protected PowerShell 7 installation compiles the same embedded C# in-process.
      command,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(REGION_SCRIPT, "utf16le").toString("base64"),
      ],
      stdin,
      timeoutMs: COMPUTER_SMOKE_REGION_TIMEOUT_MS,
      maxBytes: LIMIT,
    })
    // Timing is diagnostic only: a malformed value is dropped and never changes the verdict.
    const elapsed = computerSmokeRegionElapsed(result.elapsed, COMPUTER_SMOKE_REGION_TIMEOUT_MS)
    const timed = (value: ComputerSmokeWindowRegions): ComputerSmokeWindowRegions =>
      elapsed ? { ...value, elapsed } : value
    if (result.failed)
      return timed({
        ok: false,
        reason: REGION_RUNNER_FAILURES.includes(result.reason as RegionRunnerFailure) ? result.reason! : "launch",
      })
    const parsed = parseComputerSmokeWindowRegions(
      result.stdout,
      windows.map((entry) => entry.expected),
    )
    if (result.code !== (parsed.ok ? 0 : 1)) return timed({ ok: false, reason: "output" })
    return timed(parsed)
  } catch {
    return { ok: false, reason: "output" }
  }
}

export const COMPUTER_SMOKE_REGION_WARM_MARK = "computer-smoke-region-warm "
export const COMPUTER_SMOKE_REGION_WARM_TIMEOUT_MS = 60_000
export type ComputerSmokeRegionWarm =
  | { ok: true; ms: number }
  | { ok: false; reason: "unsupported_platform" | "launch" | "compile" | "output" | "deadline"; ms: number }

/** Fixed trivial source: no stdin, environment, repository or caller value reaches the warm-up. */
const WARM_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition 'public static class VectorRegionWarm {}' -Language CSharp
[Console]::Out.WriteLine('ok')
`

/**
 * Pays PowerShell 7's cold first Roslyn use in a separate process before the real observer runs. Add-Type emits in
 * memory, so nothing compiled here survives for the observer to load; the observer still compiles its own embedded
 * source inside its unchanged limit. The result grants nothing and is never a region observation.
 */
export async function warmComputerSmokeRegionCompiler(
  dependencies: { run?: ComputerSmokeRegionRunner } = {},
): Promise<ComputerSmokeRegionWarm> {
  const started = performance.now()
  const ms = () => Math.floor(performance.now() - started)
  if (process.platform !== "win32" && !dependencies.run) return { ok: false, reason: "unsupported_platform", ms: 0 }
  const command = protectedPowerShell()
  if (!command) return { ok: false, reason: "launch", ms: ms() }
  const result = await (dependencies.run ?? runComputerSmokeRegionBridge)({
    command,
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WARM_SCRIPT, "utf16le").toString("base64")],
    stdin: "",
    timeoutMs: COMPUTER_SMOKE_REGION_WARM_TIMEOUT_MS,
    maxBytes: LIMIT,
  }).catch(() => undefined)
  if (!result) return { ok: false, reason: "output", ms: ms() }
  if (result.failed && result.reason?.startsWith("deadline")) return { ok: false, reason: "deadline", ms: ms() }
  if (result.failed) return { ok: false, reason: result.reason === "launch" ? "launch" : "output", ms: ms() }
  if (result.code !== 0) return { ok: false, reason: "compile", ms: ms() }
  if (!["ok\n", "ok\r\n"].includes(result.stdout)) return { ok: false, reason: "output", ms: ms() }
  return { ok: true, ms: ms() }
}

function protectedPowerShell() {
  const drive = path.win32.parse(process.env.SystemRoot ?? "C:\\Windows").root
  if (!/^[a-z]:\\$/i.test(drive)) return
  return path.win32.join(drive, "Program Files", "PowerShell", "7", "pwsh.exe")
}
