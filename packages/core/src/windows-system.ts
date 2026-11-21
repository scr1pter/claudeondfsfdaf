import path from "path"

// Windows system tools Vector runs itself. Windows is taken to live in C:\Windows, as config/managed.ts does: SystemRoot
// is the user's to change, and a bare name would resolve through PATH and, on Windows, the working folder first.
const WINDOWS = "C:\\Windows"

export const TASKKILL = path.win32.join(WINDOWS, "System32", "taskkill.exe")

/** taskkill's argv for a forced kill of `pid` and its whole tree. */
export const taskkillArgs = (pid: number) => ["/pid", String(pid), "/T", "/F"]

export * as WindowsSystem from "./windows-system"
