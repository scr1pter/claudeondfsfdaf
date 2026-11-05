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
  | { ok: true; windows: ComputerSmokeWindowRegion[] }
  | { ok: false; reason: ComputerSmokeRegionFailure }
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
] as const
export type ComputerSmokeRegionFailure = (typeof COMPUTER_SMOKE_REGION_FAILURES)[number]
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
  reason?: "launch" | "output" | "deadline"
}>
const LIMIT = 65_536
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
  $probe = New-Object -TypeName VectorOwnedWindowRegions -ArgumentList $count
  foreach ($entry in $entries) {
    $probe.Observe([string]$entry.handle, [int]$entry.expected.x, [int]$entry.expected.y, [int]$entry.expected.width, [int]$entry.expected.height)
  }
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

const runRegionBridge: ComputerSmokeRegionRunner = (request) =>
  new Promise((resolve) => {
    const child = spawn(request.command, request.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    let settled = false,
      bytes = 0
    const stdout: Buffer[] = []
    const finish = (code: number | null, reason?: "launch" | "output" | "deadline") => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
      if (bytes > request.maxBytes) finish(null, "output")
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
  try {
    const result = await (dependencies.run ?? runRegionBridge)({
      command: path.win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(REGION_SCRIPT, "utf16le").toString("base64"),
      ],
      stdin,
      timeoutMs: 15_000,
      maxBytes: LIMIT,
    })
    if (result.failed)
      return {
        ok: false,
        reason: ["launch", "output", "deadline"].includes(String(result.reason)) ? result.reason! : "launch",
      }
    const parsed = parseComputerSmokeWindowRegions(
      result.stdout,
      windows.map((entry) => entry.expected),
    )
    if (result.code !== (parsed.ok ? 0 : 1)) return { ok: false, reason: "output" }
    return parsed
  } catch {
    return { ok: false, reason: "output" }
  }
}
